(() => {
  const INSTANCE_KEY = '__longshotContentScriptController__';
  if (globalThis[INSTANCE_KEY]) return;

  let controller = null;
  let captureHandler = null;
  const ERROR_MESSAGES = {
    RESTRICTED_PAGE: '此页面不允许截图', SURFACE_CHANGED: '页面内容发生变化，请重新截取',
    OUTPUT_TOO_LARGE: '截图尺寸过大，请缩小选区', CANCELLED: '截图已取消', TIMEOUT: '截图已取消'
  };
  const ready = Promise.all([
    import(chrome.runtime.getURL('src/shared/geometry.js')),
    import(chrome.runtime.getURL('src/shared/protocol.js')),
    import(chrome.runtime.getURL('src/shared/segments.js')),
    import(chrome.runtime.getURL('src/content/scroll-surface.js')),
    import(chrome.runtime.getURL('src/content/selection-ui.js')),
    import(chrome.runtime.getURL('src/content/capture-message-handler.js'))
  ]).then(([geometry, protocol, segments, scrollSurface, selection, handler]) => {
    controller = selection.createSelectionController({
      createSelectionUI: selection.createSelectionUI, createSurface: scrollSurface.createSurface,
      findScrollSurface: scrollSurface.findScrollSurface, normalizeRect: geometry.normalizeRect,
      makeMessage: protocol.makeMessage, MESSAGE: protocol.MESSAGE, document,
      randomUUID: () => crypto.randomUUID(), sendMessage: message => chrome.runtime.sendMessage(message),
      requestAnimationFrame, cancelAnimationFrame,
      onCaptureRequested: state => captureHandler?.onCaptureRequested({...state, surfaceToken: crypto.randomUUID()})
    });
    captureHandler = handler.createCaptureMessageHandler({MESSAGE: protocol.MESSAGE, PageStateGuard: scrollSurface.PageStateGuard,
      buildScrollTargets: segments.buildScrollTargets, createCaptureFeedback: selection.createCaptureFeedback,
      controller, document, errorMessages: ERROR_MESSAGES,
      sendMessage: message => { void chrome.runtime.sendMessage(message); }});
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== 'longshot') return false;
    ready.then(() => captureHandler.handle(message)).then(sendResponse,
      error => sendResponse({ok: false, code: error?.code ?? 'CAPTURE_FAILED', message: error?.message ?? '截图失败，请重试'}));
    return true;
  });
  addEventListener('keydown', event => controller?.handleKeyDown(event), true);
  globalThis[INSTANCE_KEY] = {dispose: () => { captureHandler?.dispose(); controller?.dispose(); }};
})();
