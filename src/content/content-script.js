(() => {
  const INSTANCE_KEY = '__longshotContentScriptController__';
  if (globalThis[INSTANCE_KEY]) return;

  /** http 页面没有 crypto.randomUUID（仅安全上下文），降级用 getRandomValues 拼 UUID。 */
  function randomUUID() {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  let controller = null;
  let captureHandler = null;
  const ERROR_MESSAGES = {
    RESTRICTED_PAGE: '此页面不允许截图', SURFACE_CHANGED: '页面内容发生变化，请重新截取',
    OUTPUT_TOO_LARGE: '截图尺寸过大，请缩小选区',
    COPY_TOO_LARGE: '截图过大，无法复制到剪贴板，请改用「保存」', CANCELLED: '截图已取消',
    TIMEOUT: '截图超时，请缩小选区后重试'
  };

  /**
   * 只有这些类型是发给页面（content script）的，其余（COMPOSER_* 等）交给离屏文档。
   * 模块加载完成后由 MESSAGE 常量填充，避免硬编码字符串在协议改名后静默失效。
   */
  let tabMessageTypes = null;

  /** 把拼接好的 PNG 写入系统剪贴板，供用户直接粘贴。 */
  async function writeClipboardImage({dataUrl}) {
    const blob = await (await fetch(dataUrl)).blob();
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
      return;
    }
    // 非安全上下文（如 http 页面）没有异步剪贴板 API，退回 copy 事件写入。
    const file = new File([blob], 'longshot.png', {type: 'image/png'});
    const onCopy = event => {
      event.clipboardData?.items.add(file);
      event.preventDefault();
    };
    document.addEventListener('copy', onCopy, {once: true});
    try {
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
    } finally {
      document.removeEventListener('copy', onCopy);
    }
  }
  const ready = Promise.all([
    import(chrome.runtime.getURL('src/shared/geometry.js')),
    import(chrome.runtime.getURL('src/shared/protocol.js')),
    import(chrome.runtime.getURL('src/content/scroll-surface.js')),
    import(chrome.runtime.getURL('src/content/selection-ui.js')),
    import(chrome.runtime.getURL('src/content/capture-message-handler.js'))
  ]).then(([geometry, protocol, scrollSurface, selection, handler]) => {
    const {MESSAGE} = protocol;
    tabMessageTypes = new Set([
      MESSAGE.ENTER_SELECTION, MESSAGE.ERROR, MESSAGE.RESTORE_PAGE, MESSAGE.PREPARE_CAPTURE,
      MESSAGE.SET_FIXED_VISIBILITY, MESSAGE.SCROLL_TO, MESSAGE.CLIPBOARD_WRITE
    ]);
    controller = selection.createSelectionController({
      createSelectionUI: selection.createSelectionUI, createSurface: scrollSurface.createSurface,
      findScrollSurface: scrollSurface.findScrollSurface, normalizeRect: geometry.normalizeRect,
      makeMessage: protocol.makeMessage, MESSAGE: protocol.MESSAGE, OUTPUT_FORMAT: protocol.OUTPUT_FORMAT,
      document,
      randomUUID: () => randomUUID(), sendMessage: message => chrome.runtime.sendMessage(message),
      cancelCapture: taskId => captureHandler?.cancelTask(taskId),
      requestAnimationFrame, cancelAnimationFrame,
      onCaptureRequested: state => captureHandler?.onCaptureRequested({...state, surfaceToken: randomUUID()}),
      onCopied: () => captureHandler?.showNotice('已复制到剪贴板'),
      onActionFailed: message => captureHandler?.showNotice(message)
    });
    captureHandler = handler.createCaptureMessageHandler({MESSAGE: protocol.MESSAGE, PageStateGuard: scrollSurface.PageStateGuard,
      createCaptureFeedback: selection.createCaptureFeedback,
      controller, document, errorMessages: ERROR_MESSAGES,
      writeClipboard: writeClipboardImage,
      sendMessage: message => chrome.runtime.sendMessage(message)});
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== 'longshot') return false;
    // Service Worker 用 runtime.sendMessage 发消息时是广播：离屏拼接消息（COMPOSER_*）
    // 也会到达页面。必须只应答发给页面的类型，否则本脚本会抢在离屏之前回
    // ok:false（“未知截图请求”），后台据此报“截图失败”。
    // 模块尚未加载完成时放行（此时不可能有离屏拼接消息），加载后按白名单过滤。
    if (tabMessageTypes && !tabMessageTypes.has(message.type)) return false;
    ready.then(() => captureHandler.handle(message)).then(sendResponse,
      error => sendResponse({ok: false, code: error?.code ?? 'CAPTURE_FAILED',
        message: error?.message ?? '截图失败，请重试', ...(error?.details ? {details: error.details} : {})}));
    return true;
  });
  addEventListener('keydown', event => controller?.handleKeyDown(event), true);
  globalThis[INSTANCE_KEY] = {dispose: () => { captureHandler?.dispose(); controller?.dispose(); }};
})();
