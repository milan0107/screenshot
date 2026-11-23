import {
  copyComposition, createCaptureGate, discardComposition, HIGH_QUALITY_ZOOM, isMessageTooLarge, runCapture,
  saveComposition
} from './capture-controller.js';
import {ERROR_CODE, makeMessage, MESSAGE} from '../shared/protocol.js';

export const ERROR_MESSAGES = Object.freeze({
  [ERROR_CODE.RESTRICTED_PAGE]: '当前页面不允许扩展执行截图。',
  [ERROR_CODE.STALE_TASK]: '原始标签页已切换，请重新选择截图区域。',
  [ERROR_CODE.SURFACE_CHANGED]: '页面或滚动区域已发生变化，请重新截图。',
  [ERROR_CODE.CAPTURE_FAILED]: '截图失败，请重试。',
  [ERROR_CODE.OUTPUT_TOO_LARGE]: '截图尺寸过大，请缩小选择区域。',
  [ERROR_CODE.COPY_TOO_LARGE]: '截图过大，无法复制到剪贴板，请改用「保存」。',
  [ERROR_CODE.CANCELLED]: '截图已取消。',
  [ERROR_CODE.TIMEOUT]: '截图超时，请缩小选择区域后重试。'
});

/**
 * 拼接结果过期（TTL 回收）、SW 重启丢失登记、或结果属于其他标签页时的文案。
 * 不能复用 STALE_TASK 的「原始标签页已切换」——用户会去检查根本没切换过的标签页。
 */
export const COMPOSITION_GONE_MESSAGE = '截图结果已失效，请重新选择截图区域。';

export function createChromeCaptureDeps(chromeApi, {
  captureGate,
  prepareEnvironment = async () => {}
} = {}) {
  return {
    captureGate,
    prepareEnvironment,
    sendTab: (tabId, message) => chromeApi.tabs.sendMessage(tabId, message),
    captureVisible: windowId => chromeApi.tabs.captureVisibleTab(windowId, {format: 'png'}),
    getZoom: tabId => chromeApi.tabs.getZoom(tabId),
    setZoom: (tabId, factor) => chromeApi.tabs.setZoom(tabId, factor),
    async sendOffscreen(message) {
      try {
        return await chromeApi.runtime.sendMessage(message);
      } catch (error) {
        // 消息体本身过大时重建离屏文档毫无意义，反而会销毁画布，
        // 让本可改用「保存」的截图彻底丢失。
        if (isMessageTooLarge(error)) throw error;
        // 离屏文档已被回收/上下文失效时重建文档并重试一次。
        if (typeof prepareEnvironment.reset !== 'function') throw error;
        await prepareEnvironment.reset();
        await prepareEnvironment();
        return chromeApi.runtime.sendMessage(message);
      }
    },
    download: options => chromeApi.downloads.download(options),
    async isActiveTab(tabId, windowId) {
      const tabs = await chromeApi.tabs.query({active: true, windowId});
      return tabs.length === 1 && tabs[0].id === tabId;
    }
  };
}

export function createHighQualitySessionManager({getZoom, setZoom}) {
  const tails = new Map();
  const enqueue = (tabId, operation) => {
    const previous = tails.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    tails.set(tabId, next);
    next.finally(() => {
      if (tails.get(tabId) === next) tails.delete(tabId);
    }).catch(() => {});
    return next;
  };
  return {
    enable(tabId) {
      return enqueue(tabId, async () => {
        const originalZoom = await getZoom(tabId);
        // 读不到原始缩放就不要放大：否则页面会停在 150%，而本地没有可恢复的值。
        if (!Number.isFinite(originalZoom)) throw new Error('无法读取当前页面缩放比例');
        await setZoom(tabId, HIGH_QUALITY_ZOOM);
        return {originalZoom};
      });
    },
    restore(tabId, originalZoom) {
      if (!Number.isFinite(originalZoom)) return Promise.resolve();
      return enqueue(tabId, () => setZoom(tabId, originalZoom));
    }
  };
}

function cancelledError() {
  const error = new Error(ERROR_MESSAGES[ERROR_CODE.CANCELLED]);
  error.code = ERROR_CODE.CANCELLED;
  return error;
}

export function createCaptureCoordinator({capture, createDeps}) {
  let current = null;

  function start(request) {
    const previous = current;
    previous?.controller.abort(cancelledError());

    const controller = new AbortController();
    const entry = {controller, promise: null, taskId: request.taskId};
    current = entry;
    const predecessor = previous?.promise?.catch(() => {}) ?? Promise.resolve();
    entry.promise = predecessor
      .then(() => capture({...request, signal: controller.signal}, createDeps(request)))
      .finally(() => {
        if (current === entry) current = null;
      });
    return entry.promise;
  }

  function cancel(taskId) {
    if (current?.taskId !== taskId) return false;
    current.controller.abort(cancelledError());
    return true;
  }

  return {start, cancel};
}

export function createOffscreenInitializer(chromeApi, {
  getContexts = chromeApi.runtime?.getContexts?.bind(chromeApi.runtime),
  matchAllClients = globalThis.clients?.matchAll?.bind(globalThis.clients)
} = {}) {
  let ready = null;
  let creationInFlight = null;

  async function documentExists() {
    if (getContexts) {
      const contexts = await getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
      return contexts.length > 0;
    }
    if (matchAllClients) {
      const clients = await matchAllClients({type: 'window', includeUncontrolled: true});
      return clients.some(client => client.url?.endsWith('/src/offscreen/offscreen.html'));
    }
    return chromeApi.offscreen?.hasDocument ? chromeApi.offscreen.hasDocument() : false;
  }

  const prepareEnvironment = function prepareEnvironment(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelledError());
    if (!ready) {
      let generation;
      generation = Promise.resolve()
        .then(async () => {
          if (creationInFlight) await creationInFlight;
          const exists = await documentExists();
          if (ready !== generation) return;
          if (!exists) {
            if (!creationInFlight) {
              const creation = Promise.resolve().then(() => chromeApi.offscreen.createDocument({
                url: 'src/offscreen/offscreen.html',
                reasons: ['BLOBS'],
                justification: '拼接并导出长截图'
              }));
              creationInFlight = creation;
              creation.then(() => {
                if (creationInFlight === creation) creationInFlight = null;
              }, () => {
                if (creationInFlight === creation) creationInFlight = null;
              });
            }
            await creationInFlight;
          }
        });
      ready = generation;
    }

    const generation = ready;
    const resetGeneration = () => {
      if (ready === generation) ready = null;
    };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        resetGeneration();
        reject(signal.reason ?? cancelledError());
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      generation.then(value => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, error => {
        signal?.removeEventListener('abort', onAbort);
        resetGeneration();
        reject(error);
      });
    });
  };

  /**
   * 强制下次重建离屏文档。离屏文档可能被浏览器回收（或被重载扩展留下失效上下文），
   * 此时 runtime.sendMessage 会抛 "Receiving end does not exist"。清空缓存后重建即可自愈。
   */
  prepareEnvironment.reset = async () => {
    ready = null;
    creationInFlight = null;
    try {
      await chromeApi.offscreen?.closeDocument?.();
    } catch {
      // 文档本就不存在时忽略
    }
  };

  return prepareEnvironment;
}

export function registerServiceWorker(chromeApi, capture = runCapture, logger = console) {
  const ensureOffscreen = createOffscreenInitializer(chromeApi);
  const captureGate = createCaptureGate();
  const highQualitySessions = createHighQualitySessionManager({
    getZoom: tabId => chromeApi.tabs.getZoom(tabId),
    setZoom: (tabId, factor) => chromeApi.tabs.setZoom(tabId, factor)
  });
  const coordinator = createCaptureCoordinator({
    capture,
    createDeps: () => createChromeCaptureDeps(chromeApi, {
      captureGate,
      prepareEnvironment: ensureOffscreen
    })
  });

  /** 已完成拼接、等待用户选择保存/复制的任务；持有离屏画布，需及时释放。 */
  const compositions = new Map();
  /** 待处理拼接结果的存活上限：超时自动丢弃，避免画布长期占用内存。 */
  const COMPOSITION_TTL_MS = 120_000;

  function clearComposition(taskId) {
    const entry = compositions.get(taskId);
    if (!entry) return null;
    if (entry.expiry !== null) globalThis.clearTimeout(entry.expiry);
    compositions.delete(taskId);
    return entry;
  }

  function abortComposition(taskId) {
    if (!clearComposition(taskId)) return Promise.resolve();
    return Promise.resolve()
      .then(() => chromeApi.runtime.sendMessage(makeMessage(MESSAGE.COMPOSER_ABORT, taskId)))
      .catch(() => {});
  }

  function trackComposition(taskId, entry) {
    const expiry = globalThis.setTimeout(() => {
      // 用户迟迟未选择：直接释放离屏画布。
      void abortComposition(taskId);
    }, COMPOSITION_TTL_MS);
    expiry?.unref?.();
    compositions.set(taskId, {...entry, expiry});
  }

  function discardAllCompositions() {
    return Promise.all([...compositions.keys()].map(abortComposition));
  }

  chromeApi.tabs?.onRemoved?.addListener(tabId => {
    for (const [taskId, entry] of compositions) {
      if (entry.tabId === tabId) void abortComposition(taskId);
    }
  });

  chromeApi.action.onClicked.addListener(async tab => {
    if (!Number.isInteger(tab?.id)) return;
    try {
      await chromeApi.scripting.executeScript({
        target: {tabId: tab.id},
        files: ['src/content/content-script.js']
      });
      await chromeApi.tabs.sendMessage(tab.id, makeMessage(MESSAGE.ENTER_SELECTION, null));
    } catch {
      await chromeApi.tabs.sendMessage(tab.id, makeMessage(MESSAGE.ERROR, null, {
        code: ERROR_CODE.RESTRICTED_PAGE,
        message: ERROR_MESSAGES[ERROR_CODE.RESTRICTED_PAGE]
      })).catch(() => {});
    }
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.source !== 'longshot') return false;

    if (message.type === MESSAGE.CANCEL) {
      // cancelled=false 表示后台已经没有这个任务（SW 重启/任务已结束）。
      // 页面据此可以立即解锁，不必等看门狗超时。
      sendResponse?.({ok: true, cancelled: coordinator.cancel(message.taskId)});
      return false;
    }
    if (message.type === MESSAGE.ENABLE_HIGH_QUALITY || message.type === MESSAGE.DISABLE_HIGH_QUALITY) {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ok: false, code: ERROR_CODE.CAPTURE_FAILED,
          message: ERROR_MESSAGES[ERROR_CODE.CAPTURE_FAILED]});
        return false;
      }
      const operation = message.type === MESSAGE.ENABLE_HIGH_QUALITY
        ? highQualitySessions.enable(tabId)
        : highQualitySessions.restore(tabId, message.payload?.restoreZoomTo);
      operation.then(session => sendResponse({ok: true, originalZoom: session?.originalZoom}), error => sendResponse({
        ok: false, code: ERROR_CODE.CAPTURE_FAILED,
        message: error?.message ?? ERROR_MESSAGES[ERROR_CODE.CAPTURE_FAILED]
      }));
      return true;
    }
    if (message.type === MESSAGE.CAPTURE_SAVE || message.type === MESSAGE.CAPTURE_COPY
      || message.type === MESSAGE.CAPTURE_DISCARD) {
      const entry = compositions.get(message.taskId);
      if (!entry) {
        // compositions 是内存表：MV3 Service Worker 可能已被回收，导致离屏文档里
        // 仍有没人认领的旧会话。此时顺手发一次 ABORT，避免后续 COMPOSER_BEGIN
        // 一直被判 stale 而永久无法再截图。不是本任务时不这么做（可能属于其他标签页）。
        void Promise.resolve()
          .then(() => chromeApi.runtime.sendMessage(makeMessage(MESSAGE.COMPOSER_ABORT, message.taskId)))
          .catch(() => {});
        sendResponse({ok: false, code: ERROR_CODE.STALE_TASK, message: COMPOSITION_GONE_MESSAGE});
        return false;
      }
      if (entry.tabId !== sender.tab?.id) {
        sendResponse({ok: false, code: ERROR_CODE.STALE_TASK, message: COMPOSITION_GONE_MESSAGE});
        return false;
      }
      clearComposition(message.taskId);
      const deps = createChromeCaptureDeps(chromeApi, {captureGate, prepareEnvironment: ensureOffscreen});
      const task = message.type === MESSAGE.CAPTURE_SAVE
        ? saveComposition({taskId: message.taskId, format: message.payload?.format}, deps)
        : message.type === MESSAGE.CAPTURE_COPY
          ? copyComposition({taskId: message.taskId, tabId: entry.tabId}, deps)
          : discardComposition({taskId: message.taskId}, deps);
      task.then(result => sendResponse({ok: true, ...result}), error => {
        logger.error('长截图后处理失败', error);
        const code = ERROR_MESSAGES[error?.code] ? error.code : ERROR_CODE.CAPTURE_FAILED;
        if (code === ERROR_CODE.COPY_TOO_LARGE && message.type === MESSAGE.CAPTURE_COPY) {
          // 复制超限不是画布错误：保留离屏结果并重新登记 TTL，
          // 用户可以直接改用「保存」，不必重新截图。
          trackComposition(message.taskId, {tabId: entry.tabId, windowId: entry.windowId});
        } else {
          // 保存/复制失败时离屏画布仍被占用，这里补一次丢弃，避免泄漏。
          void Promise.resolve()
            .then(() => chromeApi.runtime.sendMessage(makeMessage(MESSAGE.COMPOSER_ABORT, message.taskId)))
            .catch(() => {});
        }
        sendResponse({ok: false, code, message: ERROR_MESSAGES[code]});
      });
      return true;
    }
    if (message.type !== MESSAGE.CAPTURE_REQUEST) return false;

    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      sendResponse({ok: false, code: ERROR_CODE.CAPTURE_FAILED,
        message: ERROR_MESSAGES[ERROR_CODE.CAPTURE_FAILED]});
      return false;
    }

    Promise.resolve()
      .then(() => discardAllCompositions())
      .then(() => coordinator.start({
        taskId: message.taskId,
        tabId,
        windowId,
        selection: message.payload?.selection,
        surfaceKind: message.payload?.surfaceKind,
        highQuality: message.payload?.highQuality === true,
        restoreZoomTo: message.payload?.restoreZoomTo
      }))
      .then(result => {
        trackComposition(message.taskId, {tabId, windowId});
        sendResponse({ok: true, ...result});
      })
      .catch(async error => {
        logger.error('长截图任务失败', error);
        const code = ERROR_MESSAGES[error?.code] ? error.code : ERROR_CODE.CAPTURE_FAILED;
        // CAPTURE_FAILED 时把阶段与原因带出来，否则只能看到「截图失败，请重试」无从定位。
        // 其他错误（尤其 SURFACE_CHANGED）带上具体变化的指标和差值。
        const detail = code === ERROR_CODE.CAPTURE_FAILED
          ? `（${error?.stage ?? '未知阶段'}：${error?.message ?? '未知原因'}）`
          : error?.details ? `（${error.details}）` : '';
        const userMessage = `${ERROR_MESSAGES[code]}${detail}`;
        await chromeApi.tabs.sendMessage(tabId, makeMessage(MESSAGE.ERROR, message.taskId, {
          code, message: userMessage
        })).catch(() => {});
        sendResponse({ok: false, code, message: userMessage});
      });
    return true;
  });
}

if (typeof chrome !== 'undefined') registerServiceWorker(chrome);
