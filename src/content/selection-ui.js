const MODE_BUTTONS = [
  ['普通', 'normal'],
  ['高清', 'highQuality']
];

const FORMAT_BUTTONS = [
  ['PNG', 'png'],
  ['JPG', 'jpeg']
];

const ACTION_BUTTONS = [
  ['保存', 'onSave'],
  ['复制到剪贴板', 'onCopy'],
  ['关闭', 'onClose']
];

const CONFIRM_BUTTONS = [
  ['确认截图', 'onConfirm'],
  ['取消', 'onCancelConfirm']
];

const CONTROL_GAP = 8;
const VIEWPORT_MARGIN = 8;
/** 无指针锚点时的停靠边距（右上角）。 */
const PANEL_DOCK_MARGIN = 16;

/**
 * 菜单以指针为锚点：出现在指针**右下方**（左边缘对齐光标，顶边在光标下方 8px），
 * 右/下放不下时向左/上翻转，最终夹紧到视口内。与指针保留 CONTROL_GAP。
 */
export function positionPanelAt(point, panelSize, viewportSize) {
  const minimumLeft = VIEWPORT_MARGIN;
  const maximumLeft = Math.max(minimumLeft, viewportSize.width - panelSize.width - VIEWPORT_MARGIN);
  const minimumTop = VIEWPORT_MARGIN;
  const maximumTop = Math.max(minimumTop, viewportSize.height - panelSize.height - VIEWPORT_MARGIN);
  const right = point.x + CONTROL_GAP;
  const left = point.x - CONTROL_GAP - panelSize.width;
  const below = point.y + CONTROL_GAP;
  const above = point.y - CONTROL_GAP - panelSize.height;
  const preferredLeft = right + panelSize.width <= viewportSize.width - VIEWPORT_MARGIN
    ? right
    : left >= VIEWPORT_MARGIN
      ? left
      : right;
  const preferredTop = below + panelSize.height <= viewportSize.height - VIEWPORT_MARGIN
    ? below
    : above;

  return {
    left: Math.min(maximumLeft, Math.max(minimumLeft, preferredLeft)),
    top: Math.min(maximumTop, Math.max(minimumTop, preferredTop))
  };
}

function applyRect(element, rect) {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${Math.max(0, rect.right - rect.left)}px`;
  element.style.height = `${Math.max(0, rect.bottom - rect.top)}px`;
}

export function createCaptureFeedback(ownerDocument = document) {
  const host = ownerDocument.createElement('div');
  host.dataset && (host.dataset.longshotCapture = '');
  Object.assign(host.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '2147483647', pointerEvents: 'none', visibility: 'hidden',
    padding: '8px 12px', borderRadius: '8px', color: '#f8fafc',
    background: 'rgba(15, 23, 42, .92)', font: '13px/1.2 system-ui, sans-serif'
  });
  ownerDocument.documentElement.append(host);

  return {
    host,

    hideForCapture() { host.style.visibility = 'hidden'; },

    showError(message) {
      host.textContent = message;
      host.style.visibility = 'visible';
    },

    showNotice(message) {
      host.textContent = message;
      host.style.visibility = 'visible';
    },

    remove() { host.remove(); }
  };
}

export function createSelectionUI(callbacks, ownerDocument = document) {
  const host = ownerDocument.createElement('div');
  host.dataset && (host.dataset.longshotSelection = '');
  const shadow = host.attachShadow({mode: 'closed'});

  const style = ownerDocument.createElement('style');
  style.textContent = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .mask { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: rgba(3, 7, 18, .32); touch-action: none; user-select: none; }
    .selection { position: fixed; display: none; box-sizing: border-box; border: 2px solid #38bdf8; background: rgba(56, 189, 248, .12); box-shadow: 0 0 0 1px rgba(255,255,255,.8) inset; pointer-events: none; }
    .selection .handle { position: absolute; width: 10px; height: 10px; background: #38bdf8; border: 1px solid #0c4a6e; border-radius: 2px; }
    .selection .handle[data-corner="nw"] { left: -6px; top: -6px; cursor: nwse-resize; }
    .selection .handle[data-corner="n"]  { left: calc(50% - 5px); top: -6px; cursor: ns-resize; }
    .selection .handle[data-corner="ne"] { right: -6px; top: -6px; cursor: nesw-resize; }
    .selection .handle[data-corner="e"]  { right: -6px; top: calc(50% - 5px); cursor: ew-resize; }
    .selection .handle[data-corner="se"] { right: -6px; bottom: -6px; cursor: nwse-resize; }
    .selection .handle[data-corner="s"]  { left: calc(50% - 5px); bottom: -6px; cursor: ns-resize; }
    .selection .handle[data-corner="sw"] { left: -6px; bottom: -6px; cursor: nesw-resize; }
    .selection .handle[data-corner="w"]  { left: -6px; top: calc(50% - 5px); cursor: ew-resize; }
    .selection[data-adjustable] .handle { display: block; }
    .selection .handle { display: none; }
    .panel { position: fixed; display: none; flex-direction: row; align-items: center; gap: 6px; box-sizing: border-box; left: 50%; top: 16px; transform: translateX(-50%); max-width: calc(100vw - 16px); padding: 8px; border-radius: 10px; background: rgba(15, 23, 42, .96); box-shadow: 0 8px 30px rgba(0,0,0,.28); font: 13px/1.2 system-ui, sans-serif; pointer-events: auto; }
    .panel-separator { width: 1px; align-self: stretch; background: #334155; flex: none; }
    .panel-row { display: flex; align-items: center; gap: 6px; flex: none; }
    .mode-row { display: flex; }
    .format-row, .actions { display: none; }
    .panel-label { color: #94a3b8; white-space: nowrap; }
    .actions { gap: 8px; }
    .actions button:first-child { color: #082f49; background: #38bdf8; font-weight: 600; }
    button { appearance: none; border: 0; border-radius: 7px; padding: 7px 11px; color: #e2e8f0; background: #334155; cursor: pointer; white-space: nowrap; }
    button[aria-pressed="true"] { color: #082f49; background: #bae6fd; font-weight: 600; }
    button:hover { filter: brightness(1.08); }
    button:disabled { opacity: .55; cursor: default; filter: none; }
  `;
  const mask = ownerDocument.createElement('div');
  mask.className = 'mask';
  const selection = ownerDocument.createElement('div');
  selection.className = 'selection';
  for (const corner of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const handle = ownerDocument.createElement('div');
    handle.className = 'handle';
    handle.dataset.corner = corner;
    selection.append(handle);
  }
  const panel = ownerDocument.createElement('div');
  panel.className = 'panel';
  const modeRow = ownerDocument.createElement('div');
  modeRow.className = 'panel-row mode-row';
  const formatRow = ownerDocument.createElement('div');
  formatRow.className = 'panel-row format-row';
  const actions = ownerDocument.createElement('div');
  actions.className = 'panel-row actions';
  const confirmRow = ownerDocument.createElement('div');
  confirmRow.className = 'panel-row confirm-row';
  const separator1 = ownerDocument.createElement('span');
  separator1.className = 'panel-separator';
  const separator2 = ownerDocument.createElement('span');
  separator2.className = 'panel-separator';
  const modeButtons = new Map();
  const formatButtons = new Map();
  let activePointerId = null;
  /** 菜单锚点（首次出现时的指针位置）；阶段切换时锚点不变，仅按新尺寸重新夹紧。 */
  let anchorPoint = null;

  /**
   * 显示面板并按锚点定位。锚点只在第一次出现时确定（之后停驻、不跟随鼠标）；
   * 但每次切换阶段都要**按当前实际尺寸重新夹紧** —— 各阶段宽度差别很大
   * （画质 ~200px、输出 ~420px），只按首次的窄宽度定位会让宽的那一版被挤出视口。
   * 锚点不变时放得下就保持原位，只有将要溢出时才向左/上收。
   */
  function revealPanel(point) {
    const wasShown = panel.style.display === 'flex';
    panel.style.display = 'flex';   // 先显示才能量到当前行组合的真实尺寸
    // 只有「从隐藏到显示」才更新锚点：显示期间不跟随鼠标（停驻）。
    if (!wasShown && point && Number.isFinite(point.x) && Number.isFinite(point.y)) anchorPoint = point;
    const size = panel.getBoundingClientRect?.() ?? {width: 0, height: 0};
    panel.style.transform = 'none';
    if (!anchorPoint) {
      // 没有页面内指针坐标（刚点图标，鼠标还在工具栏上）：停靠浏览器右上角。
      panel.style.left = `${Math.max(VIEWPORT_MARGIN, innerWidth - size.width - PANEL_DOCK_MARGIN)}px`;
      panel.style.top = `${PANEL_DOCK_MARGIN}px`;
      return;
    }
    const position = positionPanelAt(anchorPoint, size, {width: innerWidth, height: innerHeight});
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
  }

  /** 单排菜单：一次只显示一组（画质 | 格式+操作 | 确认），隐藏的分隔线一并收起。 */
  function showRows({mode, format, action, confirm}) {
    modeRow.style.display = mode ? 'flex' : 'none';
    formatRow.style.display = format ? 'flex' : 'none';
    actions.style.display = action ? 'flex' : 'none';
    confirmRow.style.display = confirm ? 'flex' : 'none';
    const middle = format || action;
    separator1.style.display = mode && middle ? 'flex' : 'none';
    separator2.style.display = middle && confirm ? 'flex' : 'none';
  }

  const modeLabel = ownerDocument.createElement('span');
  modeLabel.className = 'panel-label';
  modeLabel.textContent = '画质';
  modeRow.append(modeLabel);
  for (const [label, mode] of MODE_BUTTONS) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute?.('aria-pressed', mode === 'normal' ? 'true' : 'false');
    if (mode === 'highQuality') button.title = '高清模式会临时放大页面缩放，截图后自动恢复';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onSelectMode?.(mode);
    });
    modeButtons.set(mode, button);
    modeRow.append(button);
  }

  const formatLabel = ownerDocument.createElement('span');
  formatLabel.className = 'panel-label';
  formatLabel.textContent = '格式';
  formatRow.append(formatLabel);
  for (const [label, format] of FORMAT_BUTTONS) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute?.('aria-pressed', format === 'png' ? 'true' : 'false');
    if (format === 'jpeg') button.title = 'JPG 体积更小，不支持透明背景';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onSelectFormat?.(format);
    });
    formatButtons.set(format, button);
    formatRow.append(button);
  }

  for (const [label, callbackName] of ACTION_BUTTONS) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks[callbackName]?.();
    });
    actions.append(button);
  }
  for (const [label, callbackName] of CONFIRM_BUTTONS) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks[callbackName]?.();
    });
    confirmRow.append(button);
  }
  panel.append(modeRow, separator1, formatRow, separator2, actions, confirmRow);

  /** 手柄命中检测：命中时改抓选框本身（手柄在选框边缘上，遮罩收不到它的 pointerdown）。 */
  function hitHandle(event) {
    if (selection.dataset.adjustable === undefined) return null;
    const size = selection.getBoundingClientRect?.();
    if (!size || selection.style.display === 'none') return null;
    const tolerance = 12;
    const near = (value, target) => Math.abs(value - target) <= tolerance;
    // 先拼角（nw/ne/se/sw），再退回单边（n/e/s/w），与手柄 data-corner 命名一致。
    const west = near(event.clientX, size.left);
    const east = near(event.clientX, size.right);
    const north = near(event.clientY, size.top);
    const south = near(event.clientY, size.bottom);
    if (west && north) return 'nw';
    if (east && north) return 'ne';
    if (east && south) return 'se';
    if (west && south) return 'sw';
    if (north) return 'n';
    if (south) return 's';
    if (west) return 'w';
    if (east) return 'e';
    const inside = event.clientX >= size.left && event.clientX <= size.right
      && event.clientY >= size.top && event.clientY <= size.bottom;
    return inside ? 'inside' : null;
  }

  mask.addEventListener('pointerdown', (event) => {
    if (activePointerId !== null || event.button !== 0 || event.isPrimary === false) return;
    const hit = hitHandle(event);
    if (hit) {
      // 命中已有选区：不换 surface、不重置选框，只把命中信息带给控制器。
      event.preventDefault();
      activePointerId = event.pointerId;
      mask.setPointerCapture?.(event.pointerId);
      callbacks.onPointerDown?.({...event, corner: hit === 'inside' ? null : hit, insideSelection: true});
      return;
    }
    event.preventDefault();
    activePointerId = event.pointerId;
    mask.setPointerCapture?.(event.pointerId);
    callbacks.onPointerDown?.(event);
  });
  mask.addEventListener('pointermove', (event) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    callbacks.onPointerMove?.(event);
  });
  mask.addEventListener('pointerup', (event) => {
    if (event.pointerId !== activePointerId) return;
    callbacks.onPointerUp?.(event);
    mask.releasePointerCapture?.(event.pointerId);
    activePointerId = null;
  });
  mask.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== activePointerId) return;
    callbacks.onPointerCancel?.(event);
    mask.releasePointerCapture?.(event.pointerId);
    activePointerId = null;
  });

  shadow.append(style, mask, selection, panel);
  ownerDocument.documentElement.append(host);

  return {
    host,

    showSelection(rect, viewport) {
      const visible = {
        left: Math.max(rect.left, viewport.left),
        top: Math.max(rect.top, viewport.top),
        right: Math.min(rect.right, viewport.left + viewport.width),
        bottom: Math.min(rect.bottom, viewport.top + viewport.height)
      };
      selection.style.display = 'block';
      applyRect(selection, visible);
    },

    /** 框选结束后显示 8 个调整手柄；再次拖拽或取消时收起。 */
    setAdjustable(adjustable) {
      if (adjustable) selection.dataset.adjustable = '';
      else delete selection.dataset.adjustable;
    },

    /** 框选完成后在指针附近弹出「确认截图 / 取消」。 */
    showConfirm(point) {
      showRows({mode: false, format: false, action: false, confirm: true});
      revealPanel(point);
    },

    /** 截图期间整体隐藏（含遮罩），避免扩展 UI 被截进图里。 */
    setVisible(visible) {
      host.style.visibility = visible ? 'visible' : 'hidden';
    },

    /** 截图之前显示画质选择；有指针坐标时出现在指针附近，否则用默认位置。 */
    showModeOptions(point) {
      showRows({mode: true, format: false, action: false});
      revealPanel(point);
    },

    /** 框选或截图期间收起菜单；再次出现时按新的指针位置重新定位。 */
    hidePanel() {
      panel.style.display = 'none';
      anchorPoint = null;
    },

    /** 截图完成后在指针附近展开「格式 / 保存 / 复制 / 关闭」菜单。 */
    showActions(point) {
      // 页面滚动位置已恢复，旧选框不再对应实际内容，收起以免误导。
      selection.style.display = 'none';
      this.setAdjustable(false);
      showRows({mode: false, format: true, action: true, confirm: false});
      revealPanel(point);
    },

    setMode(highQuality, pending = false) {
      for (const [mode, button] of modeButtons) {
        const active = mode === (highQuality ? 'highQuality' : 'normal');
        button.setAttribute?.('aria-pressed', active ? 'true' : 'false');
        button.disabled = pending;
      }
    },

    setFormat(format) {
      for (const [value, button] of formatButtons) {
        button.setAttribute?.('aria-pressed', value === format ? 'true' : 'false');
      }
    },

    reset() {
      selection.style.display = 'none';
      this.setAdjustable(false);
      showRows({mode: true, format: false, action: false, confirm: false});
    },

    remove() {
      host.remove();
    }
  };
}

export function createSelectionController({
  createSelectionUI: createUI,
  createSurface,
  findScrollSurface,
  normalizeRect,
  makeMessage,
  MESSAGE,
  OUTPUT_FORMAT = {PNG: 'png', JPEG: 'jpeg'},
  document: ownerDocument,
  randomUUID,
  sendMessage,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: cancelFrame,
  onCaptureRequested,
  onCopied,
  onActionFailed
}) {
  let active = null;

  function stopAutoScroll(state) {
    if (state.animationFrame === null) return;
    cancelFrame(state.animationFrame);
    state.animationFrame = null;
  }

  function disposeActive({notify = true} = {}) {
    if (!active) return;
    const state = active;
    active = null;
    stopAutoScroll(state);
    // 截图一旦开始，zoom 由后台在 finally 中恢复；这里只处理“开了高清但没截图就退出”。
    if (!state.taskId && !state.zoomManaged && state.highQuality) {
      try {
        Promise.resolve(sendMessage(makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
          restoreZoomTo: state.restoreZoomTo
        }))).catch(() => {});
      } catch {
        // The selection UI can still be removed when the background is unavailable.
      }
    }
    if (state.taskId) {
      const type = state.composed ? MESSAGE.CAPTURE_DISCARD : MESSAGE.CANCEL;
      if (state.composed || notify) {
        try {
          Promise.resolve(sendMessage(makeMessage(type, state.taskId))).catch(() => {});
        } catch {
          // The selection UI can still be removed when the background is unavailable.
        }
      }
    }
    state.ui?.remove();
    // 任务进行中时页面由后台 RESTORE_PAGE 恢复；其余情况在这里解开本地锁（幂等）。
    if (!state.taskId || state.composed) state.surface?.restore();
  }

  function edgeScrollSpeed(clientY, viewport) {
    const edgeSize = 64;
    const minimum = 4;
    const maximum = 28;
    if (clientY < viewport.top + edgeSize) {
      const proximity = Math.min(1, (viewport.top + edgeSize - clientY) / edgeSize);
      return -(minimum + (maximum - minimum) * proximity);
    }
    const bottom = viewport.top + viewport.height;
    if (clientY > bottom - edgeSize) {
      const proximity = Math.min(1, (clientY - (bottom - edgeSize)) / edgeSize);
      return minimum + (maximum - minimum) * proximity;
    }
    return 0;
  }

  function enterSelection() {
    disposeActive();
    const state = {
      animationFrame: null,
      composed: false,
      dragging: false,
      adjusting: false,
      adjustCorner: null,
      highQuality: false,
      highQualityPending: false,
      restoreZoomTo: null,
      zoomManaged: false,
      end: null,
      lastClientPoint: null,
      pointer: null,
      selection: null,
      start: null,
      surface: null,
      format: OUTPUT_FORMAT.PNG,
      taskId: null,
      busy: false,
      ui: null
    };

    function clientPoint(event) {
      const raw = {x: event.clientX, y: event.clientY};
      return state.surface?.kind === 'element'
        ? state.surface.clampClientPoint(raw.x, raw.y)
        : raw;
    }

    function render() {
      if (!state.surface || !state.start || !state.end || !state.ui) return;
      state.selection = normalizeRect(state.start, state.end);
      const metrics = state.surface.getMetrics();
      const {viewport} = metrics;
      state.ui.showSelection({
        left: state.selection.left - metrics.scrollLeft + viewport.left,
        top: state.selection.top - metrics.scrollTop + viewport.top,
        right: state.selection.right - metrics.scrollLeft + viewport.left,
        bottom: state.selection.bottom - metrics.scrollTop + viewport.top
      }, viewport);
    }

    function updateEndpoint(event) {
      if (!state.surface) return;
      state.lastClientPoint = {x: event.clientX, y: event.clientY};
      const point = clientPoint(event);
      state.end = state.surface.toContentPoint(point.x, point.y);
      render();
    }

    const CORNER_EDGES = {
      nw: ['left', 'top'], n: ['top'], ne: ['right', 'top'],
      e: ['right'], se: ['right', 'bottom'], s: ['bottom'],
      sw: ['left', 'bottom'], w: ['left']
    };

    /** 拖动手柄调整选区：只移动被抓住的边，保持对侧边固定。 */
    function adjustSelection(event) {
      if (!state.surface || !state.selection) return;
      const point = clientPoint(event);
      const content = state.surface.toContentPoint(point.x, point.y);
      const next = {...state.selection};
      for (const edge of CORNER_EDGES[state.adjustCorner] ?? []) {
        next[edge] = edge === 'left' || edge === 'right' ? content.x : content.y;
      }
      // 允许越过对侧边（自动归一化），但不能缩成 0 尺寸。
      if (next.right - next.left < 2 || next.bottom - next.top < 2) return;
      state.selection = next;
      const start = {x: next.left, y: next.top};
      const end = {x: next.right, y: next.bottom};
      state.start = start;
      state.end = end;
      render();
    }

    function autoScroll() {
      if (!state.dragging || !state.surface || !state.lastClientPoint) {
        state.animationFrame = null;
        return;
      }
      const metrics = state.surface.getMetrics();
      const point = state.surface.kind === 'element'
        ? state.surface.clampClientPoint(state.lastClientPoint.x, state.lastClientPoint.y)
        : state.lastClientPoint;
      const speed = edgeScrollSpeed(point.y, metrics.viewport);
      if (speed !== 0) {
        const nextTop = Math.min(metrics.maxScrollTop, Math.max(0, metrics.scrollTop + speed));
        state.surface.setScrollTop(nextTop);
        state.end = state.surface.toContentPoint(point.x, point.y);
        render();
      }
      state.animationFrame = requestFrame(autoScroll);
    }

    /** 菜单锚点：优先真实指针位置；从未收到 pointermove 时退回选区右下角。 */
    function menuAnchor() {
      if (state.pointer) return state.pointer;
      if (!state.selection || !state.surface) return null;
      const metrics = state.surface.getMetrics();
      return {
        x: state.selection.right - metrics.scrollLeft + metrics.viewport.left,
        y: state.selection.bottom - metrics.scrollTop + metrics.viewport.top
      };
    }

    function resetSelection() {
      stopAutoScroll(state);
      state.dragging = false;
      state.adjusting = false;
      state.adjustCorner = null;
      state.surface?.restore();
      state.surface = null;
      state.start = null;
      state.end = null;
      state.selection = null;
      state.lastClientPoint = null;
      state.ui?.reset();
      state.ui?.setMode(state.highQuality);
    }

    /** 用户点「确认截图」后才真正开始捕获（框选完成时只显示手柄与确认菜单）。 */
    function requestCapture() {
      if (state.taskId || state.busy) return;
      const {selection, surface} = state;
      if (!selection || selection.width <= 0 || selection.height <= 0 || !surface) return;
      stopAutoScroll(state);
      state.dragging = false;
      state.taskId = randomUUID();
      state.busy = true;
      state.zoomManaged = state.highQuality === true;
      state.ui?.setVisible(false);
      onCaptureRequested?.({taskId: state.taskId, selection, surface});
      let request;
      try {
        request = sendMessage(makeMessage(MESSAGE.CAPTURE_REQUEST, state.taskId, {
          selection,
          surfaceKind: surface.kind,
          highQuality: state.highQuality === true,
          ...(state.highQuality ? {restoreZoomTo: state.restoreZoomTo} : {})
        }));
      } catch {
        // 请求没发出去，后台不会接管缩放，交回前端恢复。
        state.taskId = null;
        state.busy = false;
        state.zoomManaged = false;
        disposeActive({notify: false});
        return;
      }
      Promise.resolve(request).then(response => {
        if (active !== state) return;
        state.busy = false;
        if (response?.ok !== true) {
          state.taskId = null;
          disposeActive({notify: false});
          return;
        }
        state.composed = true;
        state.ui?.setVisible(true);
        state.ui?.showActions(menuAnchor());
      }, () => {
        if (active !== state) return;
        // 消息通道失败，后台未收到请求，缩放仍由前端恢复。
        state.busy = false;
        state.taskId = null;
        state.zoomManaged = false;
        disposeActive({notify: false});
      });
    }

    /** 菜单里的保存 / 复制 / 关闭：动作完成后释放离屏画布并收起 UI。 */
    function runAction(type, payload) {
      if (!state.composed || state.busy) return;
      state.busy = true;
      state.ui?.setVisible(false);
      const done = () => {
        state.busy = false;
        state.composed = false;
        state.taskId = null;
        if (active === state) disposeActive({notify: false});
      };
      let request;
      try {
        request = sendMessage(makeMessage(type, state.taskId, payload));
      } catch {
        onActionFailed?.('操作失败，请重新截图');
        done();
        return;
      }
      Promise.resolve(request).then(response => {
        const succeeded = response?.ok === true;
        done();
        if (!succeeded) {
          // 保存/复制失败（如离屏会话失效、磁盘写入被拒）必须告知用户，不能静默关闭。
          onActionFailed?.(response?.message ?? '操作失败，请重新截图');
        } else if (type === MESSAGE.CAPTURE_COPY) {
          onCopied?.();
        }
      }, () => {
        onActionFailed?.('操作失败，请重新截图');
        done();
      });
    }

    state.ui = createUI({
      onPointerDown(event) {
        if (state.taskId || state.busy) return;
        // 已有待确认选区：点在手柄上则进入调整，点在选区内保持选区，点在选区外重新框选。
        if (state.selection && !state.adjusting) {
          const corner = event.corner;
          if (corner) {
            state.adjusting = true;
            state.adjustCorner = corner;
            state.ui?.setAdjustable(false);
            return;
          }
          if (event.insideSelection) return;
          resetSelection();
        }
        state.ui?.hidePanel();
        const target = ownerDocument.elementsFromPoint(event.clientX, event.clientY)
          .find((element) => element !== state.ui.host);
        state.surface = createSurface(findScrollSurface(target));
        state.surface.lock();
        state.dragging = true;
        state.lastClientPoint = {x: event.clientX, y: event.clientY};
        const point = clientPoint(event);
        state.start = state.surface.toContentPoint(point.x, point.y);
        state.end = {...state.start};
        render();
        state.animationFrame = requestFrame(autoScroll);
      },

      onPointerMove(event) {
        state.pointer = {x: event.clientX, y: event.clientY};
        if (state.dragging) {
          updateEndpoint(event);
          return;
        }
        if (state.adjusting) adjustSelection(event);
      },

      onPointerUp(event) {
        state.pointer = {x: event.clientX, y: event.clientY};
        // 调整结束：继续等待确认，不重新弹菜单。
        if (state.adjusting) {
          state.adjusting = false;
          state.adjustCorner = null;
          state.ui?.setAdjustable(true);
          return;
        }
        if (!state.dragging) return;
        updateEndpoint(event);
        state.dragging = false;
        stopAutoScroll(state);
        if (!state.selection || state.selection.width <= 0 || state.selection.height <= 0) {
          resetSelection();
          state.ui?.showModeOptions(menuAnchor());
          return;
        }
        // 框选完成：显示手柄与「确认截图 / 取消」，等用户确认后才截图。
        state.ui?.setAdjustable(true);
        state.ui?.showConfirm(menuAnchor());
      },

      onPointerCancel() {
        if (state.adjusting) {
          state.adjusting = false;
          state.adjustCorner = null;
          state.ui?.setAdjustable(true);
          return;
        }
        resetSelection();
      },

      onConfirm: () => requestCapture(),

      onCancelConfirm() {
        resetSelection();
        state.ui?.showModeOptions(menuAnchor());
      },

      async onSelectMode(mode) {
        const wantHighQuality = mode === 'highQuality';
        if (wantHighQuality === state.highQuality || state.highQualityPending) return;
        state.highQualityPending = true;
        state.ui?.setMode(state.highQuality, true);
        try {
          if (wantHighQuality) {
            const response = await sendMessage(makeMessage(MESSAGE.ENABLE_HIGH_QUALITY, null));
            if (response?.ok !== true || !Number.isFinite(response.originalZoom)) return;
            if (active !== state) {
              await sendMessage(makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
                restoreZoomTo: response.originalZoom
              }));
              return;
            }
            state.highQuality = true;
            state.restoreZoomTo = response.originalZoom;
            // 布局已随缩放变化，旧选区（若有）坐标失效。
            resetSelection();
          } else {
            await sendMessage(makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
              restoreZoomTo: state.restoreZoomTo
            }));
            state.highQuality = false;
            state.restoreZoomTo = null;
            resetSelection();
          }
        } catch {
          // 缩放请求失败时保持当前画质与选区不变。
        } finally {
          state.highQualityPending = false;
          state.ui?.setMode(state.highQuality);
        }
      },

      onSelectFormat(format) {
        const next = format === OUTPUT_FORMAT.JPEG ? OUTPUT_FORMAT.JPEG : OUTPUT_FORMAT.PNG;
        if (next === state.format) return;
        state.format = next;
        state.ui?.setFormat(state.format);
      },

      onSave: () => runAction(MESSAGE.CAPTURE_SAVE, {format: state.format}),
      onCopy: () => runAction(MESSAGE.CAPTURE_COPY),
      onClose: () => disposeActive()
    });
    active = state;
    state.ui.showModeOptions();
  }

  function handleKeyDown(event) {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    disposeActive();
  }

  return {enterSelection, handleKeyDown, dispose: disposeActive};
}
