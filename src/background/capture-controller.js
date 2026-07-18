import {computeFramePlacement} from '../shared/geometry.js';
import {ERROR_CODE, makeMessage, MESSAGE} from '../shared/protocol.js';
import {buildScrollTargets} from '../shared/segments.js';

const CAPTURE_INTERVAL_MS = 550;
const HIGH_QUALITY_ZOOM = 1.5;
const TASK_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const SURFACE_METRIC_TOLERANCE = 10;

function codedError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  error.code = code;
  return error;
}

function normalizeError(error) {
  if (Object.values(ERROR_CODE).includes(error?.code)) return error;
  return codedError(ERROR_CODE.CAPTURE_FAILED, error?.message ?? String(error), error);
}

function isUserCanceledDownload(error) {
  return error === 'USER_CANCELED'
    || error?.code === 'USER_CANCELED'
    || error?.message === 'USER_CANCELED';
}

function responseValue(response) {
  if (response?.ok === true) return response;
  if (response?.ok === false) {
    throw codedError(response.code ?? ERROR_CODE.CAPTURE_FAILED, response.message ?? '操作失败');
  }
  throw codedError(ERROR_CODE.CAPTURE_FAILED, '未收到有效响应');
}

function assertSurfaceInvariant(prepared, current) {
  const original = prepared.metrics;
  const next = current.metrics;
  const sameViewport = ['left', 'top', 'width', 'height']
    .every(key => next?.viewport?.[key] === original?.viewport?.[key]);
  const withinTolerance = (before, after) => before === undefined || after === undefined
    || Math.abs(after - before) <= SURFACE_METRIC_TOLERANCE;
  if (current.surfaceToken !== prepared.surfaceToken
    || !withinTolerance(original?.maxScrollTop, next?.maxScrollTop)
    || !withinTolerance(original?.scrollHeight, next?.scrollHeight)
    || next?.scrollLeft !== original?.scrollLeft
    || !sameViewport) {
    throw codedError(ERROR_CODE.SURFACE_CHANGED, '截图区域在捕获过程中发生变化');
  }
}

function defaultTimestamp(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function defaultCleanupTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(codedError(ERROR_CODE.CAPTURE_FAILED, '页面清理超时')),
      CLEANUP_TIMEOUT_MS
    );
    Promise.resolve(promise).then(value => {
      globalThis.clearTimeout(timer);
      resolve(value);
    }, error => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
  });
}

function abortReason(signal) {
  return signal?.reason ?? codedError(ERROR_CODE.CANCELLED, '截图任务已取消');
}

function raceWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

export function createCaptureGate({
  now = Date.now,
  sleep = milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)),
  minInterval = CAPTURE_INTERVAL_MS
} = {}) {
  let tail = Promise.resolve();
  let lastCaptureAt = null;

  function run(operation, signal) {
    const slot = tail.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      if (lastCaptureAt !== null) {
        const remaining = minInterval - (now() - lastCaptureAt);
        if (remaining > 0) {
          await raceWithSignal(Promise.resolve().then(() => sleep(remaining, signal)), signal);
        }
      }
      if (signal?.aborted) throw abortReason(signal);
      const operationPromise = Promise.resolve().then(() => {
        if (signal?.aborted) throw abortReason(signal);
        lastCaptureAt = now();
        return operation();
      });
      return raceWithSignal(operationPromise, signal);
    });
    tail = slot.catch(() => {});
    return raceWithSignal(slot, signal);
  }

  return {run};
}

export async function runCapture(request, deps) {
  const {
    captureGate: suppliedCaptureGate,
    captureVisible, cleanupTimeout = defaultCleanupTimeout,
    clearTimeout = globalThis.clearTimeout,
    download, formatTimestamp = defaultTimestamp, getZoom, isActiveTab,
    now = Date.now, sendOffscreen, sendTab,
    prepareEnvironment = async () => {},
    setZoom,
    setTimeout = globalThis.setTimeout,
    sleep = milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds))
  } = deps;
  const captureGate = suppliedCaptureGate ?? createCaptureGate({now, sleep});
  const {taskId, tabId, windowId, signal: externalSignal} = request;
  const controller = new AbortController();
  const timeoutError = codedError(ERROR_CODE.TIMEOUT, '截图任务已超时');
  const cancelError = codedError(ERROR_CODE.CANCELLED, '截图任务已取消');
  const onExternalAbort = () => controller.abort(cancelError);
  externalSignal?.addEventListener('abort', onExternalAbort, {once: true});
  if (externalSignal?.aborted) onExternalAbort();
  const timer = setTimeout(() => controller.abort(timeoutError), TASK_TIMEOUT_MS);
  const signal = controller.signal;
  let captureError = null;
  let inFlightCapture = null;
  let restoreZoom = Number.isFinite(request.restoreZoomTo)
    ? () => setZoom(tabId, request.restoreZoomTo)
    : null;

  const checkCancellation = () => {
    if (signal.aborted) throw signal.reason ?? cancelError;
  };
  const awaitOperation = async operation => {
    checkCancellation();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? cancelError);
      signal.addEventListener('abort', onAbort, {once: true});
      Promise.resolve()
        .then(operation)
        .then(value => {
          signal.removeEventListener('abort', onAbort);
          try {
            checkCancellation();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        }, error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        });
    });
  };
  const tabMessage = message => awaitOperation(async () => responseValue(await sendTab(tabId, message)));
  const composerMessage = message => awaitOperation(async () => responseValue(await sendOffscreen(message)));
  const ensureActive = async () => {
    const active = await awaitOperation(() => isActiveTab(tabId, windowId));
    if (!active) throw codedError(ERROR_CODE.STALE_TASK, '原始标签页已不再处于活动状态');
  };
  const applyHighQualityZoom = async () => {
    if (restoreZoom) return;
    if (request.highQuality !== true) return;
    if (typeof getZoom !== 'function' || typeof setZoom !== 'function') {
      throw codedError(ERROR_CODE.CAPTURE_FAILED, '当前浏览器不支持高清模式');
    }
    const originalZoom = await getZoom(tabId);
    await setZoom(tabId, HIGH_QUALITY_ZOOM);
    restoreZoom = () => setZoom(tabId, originalZoom);
  };

  try {
    await ensureActive();
    await awaitOperation(() => prepareEnvironment(signal));
    await awaitOperation(applyHighQualityZoom);
    await ensureActive();
    const prepared = await tabMessage(makeMessage(MESSAGE.PREPARE_CAPTURE, taskId, {
      selection: request.selection,
      surfaceKind: request.surfaceKind
    }));
    const {selection, metrics} = prepared;
    const targets = buildScrollTargets({
      selectionTop: selection.top,
      selectionBottom: selection.bottom,
      viewportHeight: metrics.viewport.height,
      maxScrollTop: metrics.maxScrollTop
    });
    let scaleX;
    let scaleY;

    for (let index = 0; index < targets.length; index += 1) {
      const top = targets[index];
      const scrolled = await tabMessage(makeMessage(MESSAGE.SCROLL_TO, taskId, {top}));
      assertSurfaceInvariant(prepared, scrolled);
      await tabMessage(makeMessage(MESSAGE.SET_FIXED_VISIBILITY, taskId, {visible: index === 0}));
      await ensureActive();

      checkCancellation();
      const dataUrl = await awaitOperation(() =>
        captureGate.run(() => {
          inFlightCapture = Promise.resolve().then(() => captureVisible(windowId));
          return inFlightCapture;
        }, signal));
      await ensureActive();

      if (index === 0) {
        const begun = await composerMessage(makeMessage(MESSAGE.COMPOSER_BEGIN, taskId, {
          cssWidth: selection.width,
          cssHeight: selection.height,
          firstDataUrl: dataUrl,
          innerWidth: metrics.viewport.width,
          innerHeight: metrics.viewport.height
        }));
        ({scaleX, scaleY} = begun);
      }

      const placement = computeFramePlacement({
        selection,
        scrollLeft: scrolled.metrics.scrollLeft,
        scrollTop: scrolled.metrics.scrollTop,
        viewport: scrolled.metrics.viewport,
        scaleX,
        scaleY
      });
      if (!placement) throw codedError(ERROR_CODE.SURFACE_CHANGED, '截图区域已移出可见范围');
      await composerMessage(makeMessage(MESSAGE.COMPOSER_ADD, taskId, {dataUrl, placement}));
    }

    const finished = await composerMessage(makeMessage(MESSAGE.COMPOSER_FINISH, taskId));
    const filename = `longshot-${formatTimestamp()}.png`;
    clearTimeout(timer);
    try {
      await download({url: finished.objectUrl, filename, saveAs: true});
    } catch (error) {
      if (!isUserCanceledDownload(error)) throw error;
    }
    await composerMessage(makeMessage(MESSAGE.COMPOSER_RELEASE, taskId));
    return {filename};
  } catch (error) {
    captureError = normalizeError(error);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (captureError) {
      if (inFlightCapture) {
        try {
          await cleanupTimeout(inFlightCapture, 'captureSettle');
        } catch {
          // A browser capture may outlive its documented settle bound; clean up anyway.
        }
      }
      const abort = Promise.resolve()
        .then(() => sendOffscreen(makeMessage(MESSAGE.COMPOSER_ABORT, taskId)));
      try {
        await cleanupTimeout(abort, 'composerAbort');
      } catch {
        // Preserve the original capture error while still attempting page restoration.
      }
    }
    const restore = Promise.resolve()
      .then(() => sendTab(tabId, makeMessage(MESSAGE.RESTORE_PAGE, taskId, {
        expectError: Boolean(captureError)
      })));
    try {
      await cleanupTimeout(restore, 'restore');
    } catch (error) {
      if (!captureError) {
        throw normalizeError(error);
      }
    }
    if (restoreZoom) {
      try {
        await cleanupTimeout(restoreZoom(), 'zoomRestore');
      } catch (error) {
        if (!captureError) {
          throw normalizeError(error);
        }
      }
    }
  }
  throw captureError;
}

export {CAPTURE_INTERVAL_MS, CLEANUP_TIMEOUT_MS, HIGH_QUALITY_ZOOM, TASK_TIMEOUT_MS};
