/** Task-scoped production handler, kept dependency-injected for DOM-free tests. */
const NOTICE_MS = 2_400;
const SETTLE_IMAGE_WAIT_MS = 300;

/** 离屏拼接消息类型；它们由 offscreen 文档处理，页面侧必须无视（不得应答）。 */
const COMPOSER_TYPES = new Set(['COMPOSER_BEGIN', 'COMPOSER_ADD', 'COMPOSER_FINISH',
  'COMPOSER_EXPORT', 'COMPOSER_RELEASE', 'COMPOSER_ABORT']);

function visibleTopInset(metrics) {
  const viewportTop = Number.isFinite(metrics?.viewport?.top) ? metrics.viewport.top : 0;
  const visibleTop = Number.isFinite(metrics?.visible?.top) ? metrics.visible.top : viewportTop;
  return visibleTop - viewportTop;
}

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
  // 两帧：第一帧让页面处理 scroll 事件并挂载虚拟列表/懒加载节点，
  // 第二帧确保这些节点已经进入合成帧，captureVisibleTab 才不会截到空白。
  await nextFrame();
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
          // 优先用后台下发的完整文案：SURFACE_CHANGED 会在括号里带上具体变化的指标。
          feedback.showError(message.payload?.message ?? errorMessages[message.payload?.code] ?? '截图失败，请重试');
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
          capture.guard = new PageStateGuard({
            surface: capture.surface,
            document: ownerDocument,
            selectionStart: capture.startClientPoint
          });
          const metrics = capture.guard.prepare();
          capture.total = buildScrollTargets({selectionTop: capture.selection.top, selectionBottom: capture.selection.bottom,
            viewportHeight: metrics.visible?.height ?? metrics.clientHeight, maxScrollTop: metrics.maxScrollTop,
            topInset: visibleTopInset(metrics)}).length;
        }
        return {ok: true, selection: capture.selection, metrics: capture.guard.assertStable(), surfaceToken: capture.surfaceToken};
      }
      if (message.type === MESSAGE.SET_FIXED_VISIBILITY) {
        capture.guard.setRepeatedElementsVisible(message.payload?.visible === true);
        capture.feedback.hideForCapture();
        await settleAfterScroll({waitImages: false});
        // 等页面渲染完再扫描一次：浮层可能在滚动后才挂载，或者被 React
        // 重新渲染后恢复可见。必须在真正截图前重新应用隐藏状态。
        if (typeof capture.guard.refreshRepeatedElements === 'function') {
          capture.guard.refreshRepeatedElements();
          capture.guard.setRepeatedElementsVisible(message.payload?.visible === true);
        }
        // 返回快门前的实际指标：页面可能在 SCROLL_TO 之后又自行滚动了
        // 几像素，拼接必须按真正截图时的 scrollTop 裁剪，不能沿用旧值。
        return {ok: true, metrics: capture.guard.assertStable(), surfaceToken: capture.surfaceToken};
      }
      if (message.type === MESSAGE.SCROLL_TO) {
        capture.guard.assertStable();
        capture.frame += 1;
        const requested = message.payload?.top;
        capture.surface.setScrollTop(requested);
        // 首屏等图片，后续屏只等两帧（懒加载图片在长图里本就随滚动才触发，逐屏等待收益低）。
        await settleAfterScroll({waitImages: capture.frame === 1});
        capture.guard.refreshRepeatedElements?.();
        const metrics = capture.guard.assertStable();
        // 滚动没到位（内容未加载/被锚定/夹紧）会直接截出空白带，这里留下可排查的痕迹。
        if (Number.isFinite(requested) && Math.abs(metrics.scrollTop - requested) > 1) {
          console.warn('[longshot] 滚动位置与目标不一致', {requested, actual: metrics.scrollTop, frame: capture.frame});
        }
        return {ok: true, metrics, surfaceToken: capture.surfaceToken};
      }
      return {ok: false, code: 'CAPTURE_FAILED', message: '未知截图请求'};
    }
  };
}
