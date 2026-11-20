import {computeFramePlacement} from '../shared/geometry.js';
import {extensionFor, normalizeOutputFormat} from '../shared/formats.js';
import {ERROR_CODE, makeMessage, MESSAGE} from '../shared/protocol.js';
import {buildScrollTargets} from '../shared/segments.js';


// Chrome 对 captureVisibleTab 有硬性频率配额：每秒最多 2 次
// （Chromium 内 kMaxCaptureVisibleTabCallsPerSecond = 2，超出直接报错）。
// 因此两次调用【开始】至少间隔 500ms；这里按「距上次捕获结束」计 500ms，
// 因为捕获自身要 100-250ms，实际开始间隔 = 500 + 捕获耗时，必然满足配额，
// 同时把滚动/解码时间与等待重叠掉。
const CAPTURE_INTERVAL_MS = 500;
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
  const normalized = codedError(ERROR_CODE.CAPTURE_FAILED, error?.message ?? String(error), error);
  // 保留上游附加的阶段信息，便于把「截图失败」定位到具体步骤。
  if (error?.stage) normalized.stage = error.stage;
  if (error?.details) normalized.details = error.details;
  return normalized;
}

function isUserCanceledDownload(error) {
  // Chrome 不同版本/本地化的报错文案不一致（USER_CANCELED、User canceled、
  // User cancelled、Download canceled by the user 等），不能只做精确匹配，
  // 否则用户点了「取消」会被误报为保存失败并丢掉截图。
  if (error === 'USER_CANCELED' || error?.code === 'USER_CANCELED') return true;
  const text = `${error?.message ?? (typeof error === 'string' ? error : '')}`.toLowerCase();
  return text.includes('user_canceled')
    || text.includes('user cancel')
    || text.includes('canceled by the user')
    || text.includes('cancelled by the user');
}

function responseValue(response) {
  if (response?.ok === true) return response;
  if (response?.ok === false) {
    const error = codedError(response.code ?? ERROR_CODE.CAPTURE_FAILED, response.message ?? '操作失败');
    if (response.details) error.details = response.details;
    throw error;
  }
  throw codedError(ERROR_CODE.CAPTURE_FAILED, '未收到有效响应');
}

function assertSurfaceInvariant(prepared, current) {
  const original = prepared.metrics;
  const next = current.metrics;
  const changes = [];
  const compare = (label, before, after, tolerance = 2) => {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    const delta = after - before;
    if (Math.abs(delta) <= tolerance) return;
    const rounded = Math.round(delta * 10) / 10;
    changes.push(`${label}${rounded > 0 ? '+' : ''}${rounded}px`);
  };
  // 内容只会向下追加（懒加载/虚拟列表实测高度）时不影响已捕获帧坐标，只有变矮才报错。
  const compareShrink = (label, before, after, tolerance) => {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    const delta = after - before;
    if (delta >= -tolerance) return;
    const rounded = Math.round(delta * 10) / 10;
    changes.push(`${label}${rounded}px`);
  };
  if (current.surfaceToken !== prepared.surfaceToken) changes.push('滚动区域已切换');
  compareShrink('可滚动高度', original?.maxScrollTop, next?.maxScrollTop, SURFACE_METRIC_TOLERANCE);
  compareShrink('内容高度', original?.scrollHeight, next?.scrollHeight, SURFACE_METRIC_TOLERANCE);
  compare('水平滚动', original?.scrollLeft, next?.scrollLeft, 0);
  for (const [key, label] of [['left', '视口左'], ['top', '视口上'], ['width', '视口宽'], ['height', '视口高']]) {
    compare(label, original?.viewport?.[key], next?.viewport?.[key]);
  }
  // visible 是「容器 ∩ 窗口」，内部容器场景下窗口/容器一变它就变，必须一并比对。
  for (const [key, label] of [['left', '可见区左'], ['top', '可见区上'], ['width', '可见区宽'], ['height', '可见区高']]) {
    compare(label, original?.visible?.[key], next?.visible?.[key]);
  }
  if (changes.length) {
    const error = codedError(ERROR_CODE.SURFACE_CHANGED, '截图区域在捕获过程中发生变化');
    error.details = changes.join('，');
    throw error;
  }
}

/** 滚动表面顶部相对 window 顶部的偏移；两者相同时为 0。 */
function visibleTopInset(metrics) {
  const viewportTop = Number.isFinite(metrics?.viewport?.top) ? metrics.viewport.top : 0;
  const visibleTop = Number.isFinite(metrics?.visible?.top) ? metrics.visible.top : viewportTop;
  return visibleTop - viewportTop;
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
      try {
        return await raceWithSignal(operationPromise, signal);
      } finally {
        // 失败/取消同样占用了一次调用配额，必须记录，否则紧接着重试会再超配额。
        lastCaptureEndAt = now();
      }
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
  /** 当前执行阶段；失败时随错误上报，便于定位（见 service-worker 的错误文案）。 */
  let stage = 'init';
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
    stage = 'offscreen';
    await awaitOperation(() => prepareEnvironment(signal));
    stage = 'zoom';
    await awaitOperation(applyHighQualityZoom);
    await ensureActive();
    stage = 'prepare';
    const prepared = await tabMessage(makeMessage(MESSAGE.PREPARE_CAPTURE, taskId, {
      selection: request.selection,
      surfaceKind: request.surfaceKind
    }));
    const {selection, metrics} = prepared;
    const targets = buildScrollTargets({
      selectionTop: selection.top,
      selectionBottom: selection.bottom,
      // 分帧步长是「窗口内可见的内容高度」，不是容器自身高度：
      // 容器比窗口大时按容器高度推进会每帧漏一段，拼出来就是一条条空白。
      viewportHeight: metrics.visible?.height ?? metrics.clientHeight,
      maxScrollTop: metrics.maxScrollTop,
      topInset: visibleTopInset(metrics)
    });
    let scaleX;
    let scaleY;
    // 帧解码/绘制必须串行（离屏 ComposerSession 是有状态机，并发 add 会冲突），
    // 但不阻塞主循环：主循环只管滚动与捕获，add 在后台按序排队，最后统一等待。
    let addChain = Promise.resolve();
    let addError = null;
    const queueAdd = message => {
      addChain = addChain.then(() => {
        if (addError) return undefined;
        return composerMessage(message).catch(error => { addError ??= error; });
      });
      return addChain;
    };

    for (let index = 0; index < targets.length; index += 1) {
      stage = `scroll#${index + 1}/${targets.length}`;
      const top = targets[index];
      const scrolled = await tabMessage(makeMessage(MESSAGE.SCROLL_TO, taskId, {top}));
      assertSurfaceInvariant(prepared, scrolled);

      checkCancellation();
      await ensureActive();
      stage = `capture#${index + 1}/${targets.length}`;
      let captureMetrics = scrolled.metrics;
      const dataUrl = await awaitOperation(() =>
        captureGate.run(async () => {
          // 先等配额，再隐藏浮层并立刻截图：页面可能在等待期间重新渲染，
          // 过早隐藏会让顶部导航又恢复可见并被截进成品。
          const frozen = await tabMessage(makeMessage(MESSAGE.SET_FIXED_VISIBILITY, taskId, {visible: index === 0}));
          if (frozen.metrics) {
            // 页面可能在 SCROLL_TO 返回后又自行滚动（虚拟列表吸底、懒加载校正等）。
            // 以快门前的真实 scrollTop 裁剪，否则顶部会多出选区以上的内容。
            captureMetrics = frozen.metrics;
            assertSurfaceInvariant(prepared, {
              metrics: frozen.metrics,
              surfaceToken: frozen.surfaceToken ?? scrolled.surfaceToken
            });
          }
          inFlightCapture = Promise.resolve().then(() => captureVisible(windowId));
          return inFlightCapture;
        }, signal));
      await ensureActive();

      if (index === 0) {
        const begun = await composerMessage(makeMessage(MESSAGE.COMPOSER_BEGIN, taskId, {
          cssWidth: selection.width,
          cssHeight: selection.height,
          firstDataUrl: dataUrl,
          // 比例必须是 bitmap / 标签页视口宽高，不能用内部滚动容器的尺寸
          innerWidth: metrics.window?.width ?? metrics.viewport.width,
          innerHeight: metrics.window?.height ?? metrics.viewport.height
        }));
        ({scaleX, scaleY} = begun);
      }

      const placement = computeFramePlacement({
        selection,
        scrollLeft: captureMetrics.scrollLeft,
        scrollTop: captureMetrics.scrollTop,
        viewport: captureMetrics.viewport,
        visible: captureMetrics.visible,
        scaleX,
        scaleY
      });
      if (!placement) throw codedError(ERROR_CODE.SURFACE_CHANGED, '截图区域已移出可见范围');
      queueAdd(makeMessage(MESSAGE.COMPOSER_ADD, taskId, {dataUrl, placement}));
    }

    stage = 'compose';
    await addChain;
    if (addError) throw normalizeError(addError);

    // 拼接完成即返回：保存/复制由用户在菜单里选择后再触发，拼接画布继续保留在离屏文档中。
    return {composed: true};
  } catch (error) {
    captureError = normalizeError(error);
    if (!captureError.stage) captureError.stage = stage;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    const abortComposition = async () => {
      const abort = Promise.resolve()
        .then(() => sendOffscreen(makeMessage(MESSAGE.COMPOSER_ABORT, taskId)));
      try {
        await cleanupTimeout(abort, 'composerAbort');
      } catch {
        // 清理失败不能覆盖原始错误。
      }
    };
    if (captureError) {
      if (inFlightCapture) {
        try {
          await cleanupTimeout(inFlightCapture, 'captureSettle');
        } catch {
          // A browser capture may outlive its documented settle bound; clean up anyway.
        }
      }
      await abortComposition();
    }
    const restore = Promise.resolve()
      .then(() => sendTab(tabId, makeMessage(MESSAGE.RESTORE_PAGE, taskId, {
        expectError: Boolean(captureError)
      })));
    let cleanupError = null;
    try {
      await cleanupTimeout(restore, 'restore');
    } catch (error) {
      if (!captureError) {
        cleanupError = normalizeError(error);
      }
    }
    if (restoreZoom) {
      try {
        await cleanupTimeout(restoreZoom(), 'zoomRestore');
      } catch (error) {
        if (!captureError && !cleanupError) cleanupError = normalizeError(error);
      }
    }
    // 拼接已经成功、但页面恢复/缩放恢复失败时，离屏画布还没有被登记到
    // compositions（服务端只会在 runCapture 正常返回后才登记）。这里不释放
    // 会留下无人认领的会话，导致下一次截图永远收到 STALE_TASK。
    if (!captureError && cleanupError) {
      captureError = cleanupError;
      await abortComposition();
      // 此时 try 里已经 return 了；只有从 finally 抛出才能覆盖成功结果。
      throw captureError;
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
