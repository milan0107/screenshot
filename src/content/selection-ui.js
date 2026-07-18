const BUTTONS = [
  ['确认截图', 'onConfirm'],
  ['高清', 'onToggleHighQuality'],
  ['重新选择', 'onReselect'],
  ['取消', 'onCancel']
];

const CONTROL_GAP = 8;
const VIEWPORT_MARGIN = 8;

export function positionControls(rect, viewport, controlSize, viewportSize) {
  const minimumLeft = VIEWPORT_MARGIN;
  const maximumLeft = Math.max(
    minimumLeft,
    viewportSize.width - controlSize.width - VIEWPORT_MARGIN
  );
  const minimumTop = VIEWPORT_MARGIN;
  const maximumTop = Math.max(
    minimumTop,
    viewportSize.height - controlSize.height - VIEWPORT_MARGIN
  );
  const right = rect.right + CONTROL_GAP;
  const left = rect.left - CONTROL_GAP - controlSize.width;
  const preferredLeft = right + controlSize.width <= viewportSize.width - VIEWPORT_MARGIN
    ? right
    : left >= VIEWPORT_MARGIN
      ? left
      : right;

  return {
    left: Math.min(maximumLeft, Math.max(minimumLeft, preferredLeft)),
    top: Math.min(
      maximumTop,
      Math.max(minimumTop, rect.top + (rect.bottom - rect.top - controlSize.height) / 2)
    )
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
    showProgress() {},
    hideForCapture() { host.style.visibility = 'hidden'; },
    showError(message) {
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
    .controls { position: fixed; display: none; box-sizing: border-box; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); flex-wrap: wrap; gap: 8px; overflow-y: auto; pointer-events: auto; padding: 8px; border-radius: 10px; background: rgba(15, 23, 42, .96); box-shadow: 0 8px 30px rgba(0,0,0,.28); font: 13px/1.2 system-ui, sans-serif; }
    .hint { position: fixed; display: none; left: 50%; top: 16px; transform: translateX(-50%); box-sizing: border-box; max-width: calc(100vw - 32px); padding: 8px 12px; border-radius: 8px; color: #f8fafc; background: rgba(15, 23, 42, .94); box-shadow: 0 8px 24px rgba(0,0,0,.24); font: 13px/1.2 system-ui, sans-serif; pointer-events: none; }
    button { appearance: none; border: 0; border-radius: 7px; padding: 7px 11px; color: #e2e8f0; background: #334155; cursor: pointer; white-space: nowrap; }
    button:first-child { color: #082f49; background: #38bdf8; font-weight: 600; }
    button[aria-pressed="true"] { color: #082f49; background: #bae6fd; font-weight: 600; }
    button:hover { filter: brightness(1.08); }
  `;
  const mask = ownerDocument.createElement('div');
  mask.className = 'mask';
  const selection = ownerDocument.createElement('div');
  selection.className = 'selection';
  const controls = ownerDocument.createElement('div');
  controls.className = 'controls';
  const hint = ownerDocument.createElement('div');
  hint.className = 'hint';
  let highQualityButton = null;
  let activePointerId = null;
  let visibleRect = null;
  let visibleViewport = null;

  function placeControls() {
    if (!visibleRect || !visibleViewport) return;
    const controlRect = controls.getBoundingClientRect?.() ?? {width: 0, height: 0};
    const position = positionControls(visibleRect, visibleViewport, controlRect, {
      width: innerWidth,
      height: innerHeight
    });
    controls.style.left = `${position.left}px`;
    controls.style.top = `${position.top}px`;
  }

  for (const [label, callbackName] of BUTTONS) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks[callbackName]?.();
    });
    if (callbackName === 'onToggleHighQuality') {
      highQualityButton = button;
      button.setAttribute?.('aria-pressed', 'false');
      button.title = '高清模式会临时放大页面缩放，截图后自动恢复';
    }
    controls.append(button);
  }

  mask.addEventListener('pointerdown', (event) => {
    if (activePointerId !== null || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    mask.setPointerCapture?.(event.pointerId);
    callbacks.onPointerDown?.(event);
  });
  mask.addEventListener('pointermove', (event) => {
    if (event.pointerId === activePointerId) callbacks.onPointerMove?.(event);
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

  shadow.append(style, mask, selection, controls, hint);
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
      visibleRect = visible;
      visibleViewport = viewport;
      placeControls();
    },

    setComplete(complete) {
      controls.style.display = complete ? 'flex' : 'none';
      if (complete) placeControls();
    },

    setHighQuality(enabled) {
      if (!highQualityButton) return;
      highQualityButton.setAttribute?.('aria-pressed', enabled ? 'true' : 'false');
    },

    showHint(message) {
      hint.textContent = message ?? '';
      hint.style.display = message ? 'block' : 'none';
    },

    reset() {
      selection.style.display = 'none';
      controls.style.display = 'none';
      hint.style.display = 'none';
      this.setHighQuality(false);
      visibleRect = null;
      visibleViewport = null;
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
  document: ownerDocument,
  randomUUID,
  sendMessage,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: cancelFrame,
  onCaptureRequested
}) {
  let active = null;

  function stopAutoScroll(state) {
    if (state.animationFrame === null) return;
    cancelFrame(state.animationFrame);
    state.animationFrame = null;
  }

  function disposeActive({notify = true, restoreSurface} = {}) {
    if (!active) return;
    const state = active;
    active = null;
    stopAutoScroll(state);
    if (notify && state.taskId) {
      try {
        Promise.resolve(sendMessage(makeMessage(MESSAGE.CANCEL, state.taskId))).catch(() => {});
      } catch {
        // The selection UI can still be removed when the background is unavailable.
      }
    }
    if (!state.taskId && state.highQuality) {
      try {
        Promise.resolve(sendMessage(makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
          restoreZoomTo: state.restoreZoomTo
        }))).catch(() => {});
      } catch {
        // The selection UI can still be removed when the background is unavailable.
      }
    }
    state.ui?.remove();
    if (restoreSurface ?? !state.taskId) state.surface?.restore();
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
      dragging: false,
      end: null,
      lastClientPoint: null,
      selection: null,
      start: null,
      surface: null,
      highQuality: false,
      highQualityPending: false,
      restoreZoomTo: null,
      taskId: null,
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

    function resetSelection({keepHighQuality = false} = {}) {
      stopAutoScroll(state);
      state.dragging = false;
      state.surface?.restore();
      state.surface = null;
      state.start = null;
      state.end = null;
      state.selection = null;
      if (!keepHighQuality) state.highQuality = false;
      state.lastClientPoint = null;
      state.ui?.reset();
      state.ui?.setHighQuality(state.highQuality);
    }

    state.ui = createUI({
      onPointerDown(event) {
        resetSelection({keepHighQuality: state.highQuality});
        const target = ownerDocument.elementsFromPoint(event.clientX, event.clientY)
          .find((element) => element !== state.ui.host);
        state.surface = createSurface(findScrollSurface(target));
        state.surface.lock();
        state.dragging = true;
        state.lastClientPoint = {x: event.clientX, y: event.clientY};
        const point = clientPoint(event);
        state.start = state.surface.toContentPoint(point.x, point.y);
        state.end = {...state.start};
        state.ui.setComplete(false);
        render();
        state.animationFrame = requestFrame(autoScroll);
      },

      onPointerMove(event) {
        if (state.dragging) updateEndpoint(event);
      },

      onPointerUp(event) {
        if (!state.dragging) return;
        updateEndpoint(event);
        state.dragging = false;
        stopAutoScroll(state);
        state.ui.setComplete(state.selection.width > 0 && state.selection.height > 0);
      },

      onPointerCancel() {
        resetSelection({keepHighQuality: state.highQuality});
      },

      onConfirm() {
        if (!state.selection || state.selection.width <= 0 || state.selection.height <= 0) return;
        stopAutoScroll(state);
        state.taskId = randomUUID();
        state.ui.remove();
        state.ui = null;
        onCaptureRequested?.({taskId: state.taskId, selection: state.selection, surface: state.surface});
        let request;
        try {
          request = sendMessage(makeMessage(MESSAGE.CAPTURE_REQUEST, state.taskId, {
            selection: state.selection,
            surfaceKind: state.surface.kind,
            highQuality: state.highQuality === true,
            ...(state.highQuality ? {restoreZoomTo: state.restoreZoomTo} : {})
          }));
        } catch {
          disposeActive({notify: false, restoreSurface: true});
          return;
        }
        Promise.resolve(request).catch(() => {
          if (active === state) disposeActive({notify: false, restoreSurface: true});
        });
      },

      async onToggleHighQuality() {
        if (state.highQuality || state.highQualityPending) return;
        state.highQualityPending = true;
        try {
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
          resetSelection({keepHighQuality: true});
          state.ui?.showHint('高清已开启，请重新框选截图区域');
        } catch {
          // Keep the existing selection available when the zoom request fails.
        } finally {
          state.highQualityPending = false;
        }
      },

      onReselect: () => resetSelection({keepHighQuality: state.highQuality}),
      onCancel: () => disposeActive()
    });
    active = state;
  }

  function handleKeyDown(event) {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    disposeActive();
  }

  return {enterSelection, handleKeyDown, dispose: disposeActive};
}
