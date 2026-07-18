/** Task-scoped production handler, kept dependency-injected for DOM-free tests. */
export async function waitForScrollSettle({
  document: ownerDocument = document,
  requestAnimationFrame: requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  maxWaitMs = 1_000
} = {}) {
  const nextFrame = () => requestFrame
    ? new Promise(resolve => requestFrame(resolve))
    : Promise.resolve();
  await nextFrame();
  await nextFrame();
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
  settleAfterScroll = () => waitForScrollSettle({document: ownerDocument})}) {
  let capture = null;
  let passiveFeedback = null;
  let pendingErrorTaskId = null;
  let pendingEnterSelection = false;
  const stale = () => ({ok: false, code: 'STALE_TASK', message: '截图任务已过期'});
  const activeFor = taskId => capture && capture.taskId === taskId;
  const release = ({expectError = false} = {}) => {
    const taskId = capture?.taskId;
    capture?.guard?.restore();
    capture?.surface?.restore();
    capture?.feedback?.remove();
    capture = null;
    pendingErrorTaskId = expectError ? taskId : null;
  };
  return {
    dispose() { release(); passiveFeedback?.remove(); passiveFeedback = null; },
    onCaptureRequested(state) {
      release();
      capture = {...state, guard: null, feedback: createCaptureFeedback(ownerDocument), frame: 0, total: 0,
        surfaceToken: state.surfaceToken};
    },
    async handle(message) {
      if (message.type === MESSAGE.ENTER_SELECTION) {
        if (capture) {
          if (!pendingEnterSelection) {
            pendingEnterSelection = true;
            sendMessage({source: 'longshot', type: MESSAGE.CANCEL, taskId: capture.taskId, payload: {}});
          }
          return {ok: true};
        }
        passiveFeedback?.remove(); passiveFeedback = null; controller.enterSelection(); return {ok: true};
      }
      if (message.type === MESSAGE.ERROR) {
        if (!message.taskId || activeFor(message.taskId) || message.taskId === pendingErrorTaskId) {
          const feedback = capture?.feedback ?? (passiveFeedback ??= createCaptureFeedback(ownerDocument));
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
        capture.feedback.showProgress(Math.min(++capture.frame, capture.total), capture.total);
        capture.feedback.hideForCapture();
        return {ok: true};
      }
      if (message.type === MESSAGE.SCROLL_TO) {
        capture.guard.assertStable();
        capture.feedback.hideForCapture();
        capture.surface.setScrollTop(message.payload?.top);
        await settleAfterScroll();
        capture.guard.refreshRepeatedElements?.();
        const metrics = capture.guard.assertStable();
        return {ok: true, metrics, surfaceToken: capture.surfaceToken};
      }
      return {ok: false, code: 'CAPTURE_FAILED', message: '未知截图请求'};
    }
  };
}
