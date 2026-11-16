import {computeFramePlacement} from '../shared/geometry.js';
import {extensionFor, normalizeOutputFormat} from '../shared/formats.js';
import {ERROR_CODE, makeMessage, MESSAGE} from '../shared/protocol.js';
import {buildScrollTargets} from '../shared/segments.js';


// Chrome 对连续 captureVisibleTab 有内部节流；限制「距上次捕获结束」的间隔即可，
// 相比「距上次开始」能把滚动/解码时间与等待重叠掉，每屏省 ~330ms。
const CAPTURE_INTERVAL_MS = 200;
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
  let lastCaptureEndAt = null;

  function run(operation, signal) {
    const slot = tail.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      if (lastCaptureEndAt !== null) {
        const remaining = minInterval - (now() - lastCaptureEndAt);
        if (remaining > 0) {
          await raceWithSignal(Promise.resolve().then(() => sleep(remaining, signal)), signal);
        }
      }
      if (signal?.aborted) throw abortReason(signal);
      const operationPromise = Promise.resolve().then(() => {
        if (signal?.aborted) throw abortReason(signal);
        return operation();
      });
      const result = await raceWithSignal(operationPromise, signal);
      lastCaptureEndAt = now();
      return result;
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
    getZoom, isActiveTab,
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
  const ensureActive = async () => {
    const active = await awaitOperation(() => isActiveTab(tabId, windowId));
    if (!active) throw codedError(ERROR_CODE.STALE_TASK, '原始标签页已不再处于活动状态');
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
    const addTasks = [];
    const addErrors = [];

    for (let index = 0; index < targets.length; index += 1) {
      const top = targets[index];
      const scrolled = await tabMessage(makeMessage(MESSAGE.SCROLL_TO, taskId, {top}));
      assertSurfaceInvariant(prepared, scrolled);
      await tabMessage(makeMessage(MESSAGE.SET_FIXED_VISIBILITY, taskId, {visible: index === 0}));

      checkCancellation();
      await ensureActive();
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
      // add 的解码/绘制与下一屏的滚动并行；composer 端按消息到达顺序处理，
      // 主循环只在本屏数据发出后立即推进下一屏。
      addTasks.push(
        composerMessage(makeMessage(MESSAGE.COMPOSER_ADD, taskId, {dataUrl, placement}))
          .then(() => {}, error => { addErrors.push(error); })
      );
    }

    await Promise.all(addTasks);
    if (addErrors.length) throw normalizeError(addErrors[0]);

    // 拼接完成即返回：保存/复制由用户在菜单里选择后再触发，拼接画布继续保留在离屏文档中。
    return {composed: true};
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

function compositionDeps(deps) {
  const {
    download,
    formatTimestamp = defaultTimestamp,
    sendOffscreen, sendTab
  } = deps;
  return {download, formatTimestamp, sendOffscreen, sendTab};
}

/** 用户选好格式后编码并下载。 */
export async function saveComposition(request, deps) {
  const {download, formatTimestamp, sendOffscreen} = compositionDeps(deps);
  const {taskId} = request;
  const format = normalizeOutputFormat(request.format);
  const filename = `longshot-${formatTimestamp()}.${extensionFor(format)}`;
  const finished = responseValue(await sendOffscreen(makeMessage(MESSAGE.COMPOSER_FINISH, taskId, {format})));
  try {
    await download({url: finished.objectUrl, filename, saveAs: true});
  } catch (error) {
    if (!isUserCanceledDownload(error)) throw normalizeError(error);
  }
  responseValue(await sendOffscreen(makeMessage(MESSAGE.COMPOSER_RELEASE, taskId)));
  return {filename};
}

/** 用户选好复制后导出 PNG 并交给页面写入剪贴板。 */
export async function copyComposition(request, deps) {
  const {sendOffscreen, sendTab} = compositionDeps(deps);
  const {taskId, tabId} = request;
  const exported = responseValue(await sendOffscreen(makeMessage(MESSAGE.COMPOSER_EXPORT, taskId)));
  responseValue(await sendTab(tabId, makeMessage(MESSAGE.CLIPBOARD_WRITE, taskId, {dataUrl: exported.dataUrl})));
  responseValue(await sendOffscreen(makeMessage(MESSAGE.COMPOSER_RELEASE, taskId)));
  return {copied: true};
}

/** 用户关闭菜单或新任务开始时释放拼接画布。 */
export async function discardComposition(request, deps) {
  const {sendOffscreen} = compositionDeps(deps);
  await Promise.resolve()
    .then(() => sendOffscreen(makeMessage(MESSAGE.COMPOSER_ABORT, request.taskId)))
    .catch(() => {});
  return {ok: true};
}
