/** Task-scoped production handler, kept dependency-injected for DOM-free tests. */
const NOTICE_MS = 2_400;
const SETTLE_IMAGE_WAIT_MS = 300;

/** 离屏拼接消息类型；它们由 offscreen 文档处理，页面侧必须无视（不得应答）。 */
const COMPOSER_TYPES = new Set(['COMPOSER_BEGIN', 'COMPOSER_ADD', 'COMPOSER_FINISH',
  'COMPOSER_EXPORT', 'COMPOSER_RELEASE', 'COMPOSER_ABORT']);

export async function waitForScrollSettle({
  document: ownerDocument = document,
  requestAnimationFrame: requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  maxWaitMs = SETTLE_IMAGE_WAIT_MS,
  waitImages = true
} = {}) {
  const nextFrame = () => requestFrame
    ? new Promise(resolve => requestFrame(resolve))
    : Promise.resolve();
  await nextFrame();
  if (!waitImages) return;
  const images = [...(ownerDocument.querySelectorAll?.('img') ?? [])]
    .filter(image => !image.complete)
    .map(image => new Promise(resolve => {
      image.addEventListener('load', resolve, {once: true});
      image.addEventListener('error', resolve, {once: true});
    }));
  if (!images.length) return;
  await new Promise(resolve => {
    const timer = scheduleTimeout(resolve, maxWaitMs);
    Promise.all(images).then(() => {
      cancelTimeout(timer);
      resolve();
    });
  });
}

export function createCaptureMessageHandler({MESSAGE, PageStateGuard, buildScrollTargets, createCaptureFeedback,
  controller, document: ownerDocument, errorMessages = {}, sendMessage = () => {},
  writeClipboard = async () => { throw new Error('clipboard unavailable'); },
  setTimeout: scheduleTimeout = globalThis.setTimeout, clearTimeout: cancelTimeout = globalThis.clearTimeout,
  noticeMs = NOTICE_MS,
  settleAfterScroll = () => waitForScrollSettle({document: ownerDocument})}) {
  let capture = null;
  let passiveFeedback = null;
  let pendingErrorTaskId = null;
  let pendingEnterSelection = false;
  let noticeTimer = null;
  /** 最近一次成功恢复页面的任务；截图完成后用户仍可能请求复制，此时任务已不在进行中。 */
  let completedTaskId = null;
  const stale = () => ({ok: false, code: 'STALE_TASK', message: '截图任务已过期'});
  const activeFor = taskId => capture && capture.taskId === taskId;
  const clearNotice = () => {
    if (noticeTimer === null) return;
    cancelTimeout(noticeTimer);
    noticeTimer = null;
  };
  const showPassive = (message, {transient = false} = {}) => {
    clearNotice();
    passiveFeedback ??= createCaptureFeedback(ownerDocument);
    if (typeof passiveFeedback.showNotice === 'function') passiveFeedback.showNotice(message);
    else passiveFeedback.showError(message);
    if (!transient) return;
    noticeTimer = scheduleTimeout(() => {
      noticeTimer = null;
      passiveFeedback?.remove();
      passiveFeedback = null;
    }, noticeMs);
  };
  const release = ({expectError = false} = {}) => {
    const taskId = capture?.taskId;
    capture?.guard?.restore();
    capture?.surface?.restore();
    capture?.feedback?.remove();
    capture = null;
    pendingErrorTaskId = expectError ? taskId : null;
    if (!expectError && taskId) completedTaskId = taskId;
  };
  return {
    dispose() {
      release();
      clearNotice();
      passiveFeedback?.remove();
      passiveFeedback = null;
    },
    onCaptureRequested(state) {
      release();
      completedTaskId = null;
      capture = {...state, guard: null, feedback: createCaptureFeedback(ownerDocument), frame: 0, total: 0,
        surfaceToken: state.surfaceToken};
    },

    /** 复制成功等一次性提示，自动消失。 */
    showNotice(message) {
      showPassive(message, {transient: true});
    },
    async handle(message) {
      // 防御：广播到达页面时不应答离屏拼接消息（否则会抢答导致后台误判截图失败）。
      if (COMPOSER_TYPES.has(message.type)) return undefined;
      if (message.type === MESSAGE.ENTER_SELECTION) {
        if (capture) {
          if (!pendingEnterSelection) {
            pendingEnterSelection = true;
            sendMessage({source: 'longshot', type: MESSAGE.CANCEL, taskId: capture.taskId, payload: {}});
          }
          return {ok: true};
        }
        passiveFeedback?.remove(); passiveFeedback = null; clearNotice(); controller.enterSelection(); return {ok: true};
      }
      if (message.type === MESSAGE.ERROR) {
        if (!message.taskId || activeFor(message.taskId) || message.taskId === pendingErrorTaskId) {
          const feedback = capture?.feedback ?? (passiveFeedback ??= createCaptureFeedback(ownerDocument));
          clearNotice();
          feedback.showError(errorMessages[message.payload?.code] ?? message.payload?.message ?? '截图失败，请重试');
          if (message.taskId === pendingErrorTaskId) pendingErrorTaskId = null;
        }
        return {ok: true};
      }
      if (message.type === MESSAGE.RESTORE_PAGE) {
        if (activeFor(message.taskId)) {
          release({expectError: message.payload?.expectError === true});
          if (pendingEnterSelection) {
            pendingEnterSelection = false;
            controller.enterSelection();
          }
        }
        return {ok: true};
      }
      if (message.type === MESSAGE.CLIPBOARD_WRITE) {
        if (!activeFor(message.taskId) && message.taskId !== completedTaskId) return stale();
        try {
          await writeClipboard({dataUrl: message.payload?.dataUrl});
        } catch (error) {
          const failure = new Error('复制到剪贴板失败，请重试');
          failure.code = 'CAPTURE_FAILED';
          failure.cause = error;
          throw failure;
        }
        return {ok: true};
      }
      if (!activeFor(message.taskId)) return stale();
      if (message.type === MESSAGE.PREPARE_CAPTURE) {
        if (!capture.guard) {
          capture.guard = new PageStateGuard({surface: capture.surface, document: ownerDocument});
          const metrics = capture.guard.prepare();
          capture.total = buildScrollTargets({selectionTop: capture.selection.top, selectionBottom: capture.selection.bottom,
            viewportHeight: metrics.viewport.height, maxScrollTop: metrics.maxScrollTop}).length;
        }
        return {ok: true, selection: capture.selection, metrics: capture.guard.assertStable(), surfaceToken: capture.surfaceToken};
      }
      if (message.type === MESSAGE.SET_FIXED_VISIBILITY) {
        capture.guard.setRepeatedElementsVisible(message.payload?.visible === true);
        capture.feedback.hideForCapture();
        return {ok: true};
      }
      if (message.type === MESSAGE.SCROLL_TO) {
        capture.guard.assertStable();
        capture.frame += 1;
        capture.surface.setScrollTop(message.payload?.top);
        // 首屏等图片，后续屏只等两帧（懒加载图片在长图里本就随滚动才触发，逐屏等待收益低）。
        await settleAfterScroll({waitImages: capture.frame === 1});
        capture.guard.refreshRepeatedElements?.();
        const metrics = capture.guard.assertStable();
        return {ok: true, metrics, surfaceToken: capture.surfaceToken};
      }
      return {ok: false, code: 'CAPTURE_FAILED', message: '未知截图请求'};
    }
  };
}
