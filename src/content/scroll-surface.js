export function isScrollableMetrics({overflowY, scrollHeight, clientHeight}) {
  return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
    && scrollHeight > clientHeight;
}

export function isScrollableElement(element, style = getComputedStyle(element)) {
  return isScrollableMetrics({
    overflowY: style.overflowY,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  });
}

export function findScrollSurface(start) {
  for (let element = start; element; element = element.parentElement) {
    if (isScrollableElement(element)) return element;
  }
  return document.scrollingElement;
}

function inlineProperty(style, name) {
  if (typeof style.getPropertyValue === 'function') {
    return {value: style.getPropertyValue(name), priority: style.getPropertyPriority(name)};
  }
  const camelName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return {value: style[camelName] ?? '', priority: ''};
}

function restoreInlineProperty(style, name, state) {
  if (typeof style.setProperty === 'function') {
    if (state.value === '' && state.priority === '') style.removeProperty(name);
    else style.setProperty(name, state.value, state.priority);
    return;
  }
  const camelName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  style[camelName] = state.value;
}

function setInlineProperty(style, name, value, priority = '') {
  if (typeof style.setProperty === 'function') style.setProperty(name, value, priority);
  else style[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
}

function hideElement(element) {
  // visibility 可能被子元素用 visibility: visible 覆盖；opacity 作用于整棵
  // 子树，能保证带这类子元素的导航栏/浮层也不会被截进图里。
  setInlineProperty(element.style, 'visibility', 'hidden', 'important');
  setInlineProperty(element.style, 'opacity', '0', 'important');
}

function restoreElement(element, saved) {
  restoreInlineProperty(element.style, 'visibility', saved.value);
  restoreInlineProperty(element.style, 'opacity', saved.opacity);
}

function intersects(rect, viewport) {
  return rect.right > viewport.left && rect.left < viewport.left + viewport.width
    && rect.bottom > viewport.top && rect.top < viewport.top + viewport.height;
}

function stickyOffset(value) {
  return /^-?(?:\d+|\d*\.\d+)px$/.test(value?.trim?.() ?? '')
    ? Number.parseFloat(value)
    : null;
}

/** 元素当前是否正好停在 sticky 的 top/bottom 约束线上（即已经吸顶/吸底）。 */
function stickyPinned(rect, style, viewport) {
  const top = stickyOffset(style.top);
  if (top !== null && Math.abs(rect.top - (viewport.top + top)) <= 2) return true;
  const bottom = stickyOffset(style.bottom);
  return bottom !== null
    && Math.abs(rect.bottom - (viewport.top + viewport.height - bottom)) <= 2;
}

/** 收集 fixed/sticky 元素（含 open shadow root），供可见区偏移计算复用。 */
function collectOverlayCandidates(ownerDocument, readStyle, surfaceElement = null) {
  if (!ownerDocument?.querySelectorAll || typeof readStyle !== 'function') return [];
  const candidates = [];
  const roots = [ownerDocument];
  const seenRoots = new Set();
  const seenElements = new Set();
  while (roots.length) {
    const root = roots.pop();
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    for (const element of root.querySelectorAll?.('*') ?? []) {
      if (seenElements.has(element)) continue;
      seenElements.add(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
      // 包含滚动表面的 fixed 应用壳不是「顶部导航」：把它扣掉会让整个
      // 内部滚动容器都不可选。只跳过祖先，不跳过表面内部的 fixed 浮层。
      if (surfaceElement && (element === surfaceElement || element.contains?.(surfaceElement))) continue;
      const style = readStyle(element);
      if (style?.position === 'fixed' || style?.position === 'sticky') {
        candidates.push({element, style});
      }
    }
  }
  return candidates;
}

/**
 * 顶部固定导航/横幅会盖住滚动内容。它不属于可选区，必须从选区可见区里扣掉，
 * 否则滚动后选框顶部会被夹到视口最顶部、盖住导航。
 * 只统计横跨可见区一半以上、贴顶且可见的浮层，避免把右下角悬浮按钮算进来。
 */
function topOverlayInset(candidates, viewport, visibleTop = Math.max(0, viewport.top),
  visibleRect = viewport) {
  if (visibleRect.width <= 0 || visibleRect.height <= 0) return 0;
  const visibleLeft = visibleRect.left;
  const visibleRight = visibleRect.left + visibleRect.width;
  const entries = [];
  for (const {element, style} of candidates) {
    const rect = element.getBoundingClientRect?.();
    if (!rect) continue;
    // 只统计真正覆盖「可见区」的浮层：离屏抽屉、另一栏的 fixed 条
    // 即使宽度很大，也不应该把选区顶部整体下移。
    const overlap = Math.min(rect.right, visibleRight) - Math.max(rect.left, visibleLeft);
    if (overlap < visibleRect.width * 0.5) continue;
    if (rect.width < visibleRect.width * 0.5) continue;
    if (rect.bottom <= visibleTop) continue;
    // 全屏 fixed 布局壳/遮罩不是顶部导航。若把它整屏都扣掉，选区可见区
    // 只剩 1px。只接受高度不超过 max(320px, 半屏) 的顶部浮层；短视口下
    // 仍允许 320px 以内的正常导航。
    if (rect.height > Math.max(320, viewport.height * 0.5)) continue;
    if (style.position === 'sticky' && !stickyPinned(rect, style, viewport)) continue;
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    entries.push(rect);
  }
  // 多层吸顶导航（如 59px 主栏 + 52px 工具栏）需要按堆叠顺序累计。
  entries.sort((a, b) => a.top - b.top);
  let inset = 0;
  for (const rect of entries) {
    if (rect.top > visibleTop + inset + 2) continue;
    if (rect.bottom <= visibleTop + inset) continue;
    inset = Math.max(inset, rect.bottom - visibleTop);
  }
  return Math.min(Math.max(0, inset), Math.max(0, viewport.height - 1));
}

/** Capture-only mutations that must be unwound even if the capture task fails. */
export class PageStateGuard {
  constructor({surface, document: ownerDocument = document, getComputedStyle: readStyle, selectionStart = null}) {
    this.surface = surface;
    this.document = ownerDocument;
    this.getComputedStyle = readStyle ?? globalThis.getComputedStyle?.bind(globalThis);
    /** 框选起点（客户端坐标）；固定/吸顶元素只有覆盖起点时才算真正在选区里。 */
    this.selectionStart = selectionStart;
    this.state = null;
    this.repeatedElements = [];
    /** 确认截图时选区起点真正覆盖到的浮层；首帧只保留这些元素。 */
    this.initialCover = new Set();
    /** 所有见过的浮层元素 → 原始内联 visibility；动态新增的元素也要能恢复。 */
    this.visibility = new Map();
    this.visibleState = true;
    this.listeners = [];
  }

  /**
   * 重新收集当前 DOM 中的 fixed / sticky 元素。页面可能在被滚动后才挂载
   * 「回到底部」、吸顶工具栏等浮层，不能只使用 prepare 时的一份快照。
   */
  collectCandidates(metrics) {
    const candidates = [];
    const roots = [this.document];
    const seenRoots = new Set();
    const seenElements = new Set();
    while (roots.length) {
      const root = roots.pop();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      for (const element of root.querySelectorAll?.('*') ?? []) {
        if (seenElements.has(element)) continue;
        seenElements.add(element);
        // shadow host 本身可能只是普通容器，真正的 fixed/sticky 浮层在它的
        // shadow root 里；必须在 position 判断之前继续下钻，否则会漏掉。
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element === this.surface.element || element.contains?.(this.surface.element)) continue;
        const style = this.getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        if (!this.visibility.has(element)) {
          const rect = element.getBoundingClientRect?.();
          this.visibility.set(element, {
            element,
            value: inlineProperty(element.style, 'visibility'),
            opacity: inlineProperty(element.style, 'opacity'),
            initiallyPinned: style.position === 'sticky'
              && metrics.scrollTop > 0
              && rect
              && intersects(rect, metrics.viewport)
              && stickyPinned(rect, style, metrics.viewport)
          });
        }
        candidates.push(element);
      }
    }
    return candidates;
  }

  /**
   * 记录确认截图时选区起点实际覆盖的浮层。
   *
   * 不能等滚动到首帧后再用 getBoundingClientRect 判断：吸顶栏在滚动后仍停在
   * 视口顶部，而选区起点可能已经滚出视口或位置改变，会把用户没有选中的顶部
   * 导航误判成选区内容。这里用确认时的位置一次性定下来，后续滚动不再改变。
   */
  rememberInitialCover(candidates) {
    this.initialCover.clear();
    const start = this.selectionStart;
    if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y)) return;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect?.();
      if (!rect) continue;
      if (start.x >= rect.left && start.x <= rect.right
        && start.y >= rect.top && start.y < rect.bottom) {
        this.initialCover.add(element);
      }
    }
  }

  prepare() {
    if (this.state) return this.state.metrics;
    const element = this.surface.element;
    const metrics = this.surface.getMetrics();
    const candidates = this.collectCandidates(metrics);
    this.rememberInitialCover(candidates);
    this.state = {
      metrics,
      scrollLeft: metrics.scrollLeft,
      scrollTop: metrics.scrollTop,
      surfaceProperties: element ? {
        scrollBehavior: inlineProperty(element.style, 'scroll-behavior')
      } : null,
      candidates
    };
    this.refreshRepeatedElements();
    if (element) setInlineProperty(element.style, 'scroll-behavior', 'auto', 'important');
    const preventInput = event => {
      if (event.type !== 'keydown' || (event.key !== 'Escape'
        && [' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key))) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
      }
    };
    // 不能拦截 scroll 事件：X/Twitter 等虚拟列表靠滚动事件计算可见区间并挂载
    // 节点。拦掉后页面会停留在空白占位，截出整段纯白。
    // scroll 本身不可取消，拦截它也不能阻止滚动，只有负面作用。
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'keydown']) {
      this.document.addEventListener(type, preventInput, true);
      this.listeners.push([type, preventInput]);
    }
    return metrics;
  }

  refreshRepeatedElements() {
    if (!this.state) throw new Error('PageStateGuard must be prepared before refreshing repeated elements');
    const metrics = this.surface.getMetrics();
    const {viewport} = metrics;
    const candidates = this.collectCandidates(metrics);
    const repeated = candidates.filter(element => {
      const style = this.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!intersects(rect, viewport)) return false;
      if (style.position === 'fixed') return true;
      if (style.position !== 'sticky' || !stickyPinned(rect, style, viewport)) return false;
      const entry = this.visibility.get(element);
      return entry?.initiallyPinned === true || metrics.scrollTop > this.state.metrics.scrollTop;
    });
    const repeatedSet = new Set(repeated);
    for (const element of this.repeatedElements) {
      if (!repeatedSet.has(element)) {
        const saved = this.visibility.get(element);
        restoreElement(element, saved);
      }
    }
    this.state.candidates = candidates;
    this.repeatedElements = repeated;
    // 刷新时新进入列表的元素立即套用当前可见性，不依赖调用方紧接着再发一次
    // SET_FIXED_VISIBILITY；否则新吸顶的元素会以可见状态被截进这一帧。
    if (this.visibleState === false) {
      for (const element of repeated) hideElement(element);
    }
  }

  setRepeatedElementsVisible(visible) {
    if (!this.state) throw new Error('PageStateGuard must be prepared before changing visibility');
    this.visibleState = visible;
    for (const element of this.repeatedElements) {
      // 首帧也只保留「确认时起点确实压住」的浮层；其余一律隐藏，避免顶部
      // 导航/工具栏被当作选区内容截进成品。
      if (visible && this.initialCover.has(element)) {
        const saved = this.visibility.get(element);
        restoreElement(element, saved);
      } else hideElement(element);
    }
  }

  assertStable() {
    if (!this.state) throw new Error('PageStateGuard must be prepared before asserting stability');
    const previous = this.state.metrics;
    const current = this.surface.getMetrics();
    const changes = [];
    const compare = (label, before, after, tolerance = 2) => {
      if (!Number.isFinite(before) || !Number.isFinite(after)) return;
      const delta = after - before;
      if (Math.abs(delta) <= tolerance) return;
      const rounded = Math.round(delta * 10) / 10;
      changes.push(`${label}${rounded > 0 ? '+' : ''}${rounded}px`);
    };
    for (const [key, label] of [['left', '视口左'], ['top', '视口上'], ['width', '视口宽'], ['height', '视口高']]) {
      compare(label, previous.viewport?.[key], current.viewport?.[key]);
    }
    compare('容器宽', previous.clientWidth, current.clientWidth);
    compare('容器高', previous.clientHeight, current.clientHeight);
    // 懒加载图片/链接预览/虚拟列表实测高度只会把内容追加到下方，
    // 不影响已捕获帧的坐标；内容变矮才说明有内容被移除，必须报错。
    if (Number.isFinite(previous.scrollHeight) && Number.isFinite(current.scrollHeight)
      && current.scrollHeight < previous.scrollHeight - 10) {
      const delta = Math.round((current.scrollHeight - previous.scrollHeight) * 10) / 10;
      changes.push(`内容高度${delta}px`);
    }
    // 内部容器场景下，截图比例按标签页视口（window.innerWidth/Height）换算；
    // 容器自身尺寸可能完全不变，因此窗口变化也必须视为表面变化。
    compare('窗口宽', previous.window?.width, current.window?.width);
    compare('窗口高', previous.window?.height, current.window?.height);
    for (const [key, label] of [['left', '可见区左'], ['top', '可见区上'], ['width', '可见区宽'], ['height', '可见区高']]) {
      compare(label, previous.visible?.[key], current.visible?.[key]);
    }
    if (changes.length) {
      const error = new Error('截图区域在捕获过程中发生变化');
      error.code = 'SURFACE_CHANGED';
      // 把具体变化的指标带出去，否则用户只能看到「页面内容发生变化」而无从定位。
      error.details = changes.join('，');
      throw error;
    }
    return current;
  }

  restore() {
    if (!this.state) return;
    const state = this.state;
    this.state = null;
    for (const [type, listener] of this.listeners.splice(0).reverse()) {
      this.document.removeEventListener(type, listener, true);
    }
    for (const saved of [...this.visibility.values()].reverse()) {
      restoreElement(saved.element, saved);
    }
    this.initialCover.clear();
    this.visibility.clear();
    const element = this.surface.element;
    if (element && state.surfaceProperties) {
      restoreInlineProperty(element.style, 'scroll-behavior', state.surfaceProperties.scrollBehavior);
    }
    if (this.surface.kind === 'page') globalThis.scrollTo(state.scrollLeft, state.scrollTop);
    else if (element) {
      element.scrollLeft = state.scrollLeft;
      element.scrollTop = state.scrollTop;
    }
    this.repeatedElements = [];
    this.visibleState = true;
  }
}

export function createSurface(element) {
  const isPage = element === document.scrollingElement;
  let lockedState = null;
  const ownerDocument = isPage ? document : element.ownerDocument ?? document;
  const overlayCandidates = collectOverlayCandidates(
    ownerDocument,
    globalThis.getComputedStyle?.bind(globalThis),
    element
  );

  function readScrollBehavior() {
    if (typeof element.style.getPropertyValue === 'function') {
      return {
        value: element.style.getPropertyValue('scroll-behavior'),
        priority: element.style.getPropertyPriority('scroll-behavior')
      };
    }
    return {value: element.style.scrollBehavior, priority: ''};
  }

  function writeScrollBehavior(value, priority = '') {
    if (typeof element.style.setProperty === 'function') {
      if (value === '' && priority === '') element.style.removeProperty('scroll-behavior');
      else element.style.setProperty('scroll-behavior', value, priority);
      return;
    }
    element.style.scrollBehavior = value;
  }

  function getViewport() {
    if (isPage) {
      return {left: 0, top: 0, width: innerWidth, height: innerHeight};
    }
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + element.clientLeft,
      top: rect.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight
    };
  }

  function getScrollPosition() {
    return isPage
      ? {scrollLeft: scrollX, scrollTop: scrollY}
      : {scrollLeft: element.scrollLeft, scrollTop: element.scrollTop};
  }

  /** 视口与浏览器窗口的交集（客户端坐标）。页面/完全可见的容器等于自身视口。 */
  function clipToWindow(viewport) {
    const left = Math.max(viewport.left, 0);
    const top = Math.max(viewport.top, 0);
    const right = Math.max(left, Math.min(viewport.left + viewport.width, innerWidth));
    const bottom = Math.max(top, Math.min(viewport.top + viewport.height, innerHeight));
    return {left, top, width: right - left, height: bottom - top};
  }

  function readTopOverlayInset(viewport = getViewport()) {
    return topOverlayInset(overlayCandidates, viewport, Math.max(0, viewport.top), clipToWindow(viewport));
  }

  function setPosition(left, top) {
    if (isPage) scrollTo(left, top);
    else {
      element.scrollLeft = left;
      element.scrollTop = top;
    }
  }

  return {
    element,
    kind: isPage ? 'page' : 'element',

    getMetrics() {
      const {scrollLeft, scrollTop} = getScrollPosition();
      const viewport = getViewport();
      const windowVisible = clipToWindow(viewport);
      // 顶部导航只影响选框绘制与拖拽范围，不属于 captureVisibleTab 的
      // 可截取范围。截图时导航会被 PageStateGuard 隐藏，其下方的页面内容
      // 正是选区起点，因此 visible 必须保持「视口 ∩ 窗口」的原始含义。
      // 若把导航高度算进 visible，隐藏导航后 visible 会突变，截图会被
      // 误判为页面变化而失败。
      const overlayInset = Math.min(readTopOverlayInset(viewport), Math.max(0, windowVisible.height - 1));
      const clientWidth = isPage ? innerWidth : element.clientWidth;
      const clientHeight = isPage ? innerHeight : element.clientHeight;
      return {
        scrollLeft,
        scrollTop,
        clientWidth,
        clientHeight,
        scrollHeight: element.scrollHeight,
        maxScrollTop: Math.max(0, element.scrollHeight - clientHeight),
        viewport,
        // 窗口内**实际可见**的那部分（客户端坐标）：captureVisibleTab 只能
        // 截到这一块。内部容器可能被窗口裁掉一部分（如 height:100vh 且上方
        // 有 56px 头部），分帧步长与裁剪源矩形都必须按它算，否则每帧会多出
        // 空白或把内容压扁。
        visible: windowVisible,
        // 顶部固定导航/横幅在 visible 内额外遮挡的高度；仅用于选框绘制和
        // 指针夹紧，不参与截图裁剪。
        overlayInset,
        // captureVisibleTab 截的是整个标签页视口，裁剪比例必须用它换算，
        // 不能用内部滚动容器的尺寸（见 computeFramePlacement 的 scaleX/scaleY）。
        window: {width: innerWidth, height: innerHeight}
      };
    },

    setScrollTop(top) {
      const {scrollLeft} = getScrollPosition();
      setPosition(scrollLeft, top);
    },

    toContentPoint(clientX, clientY) {
      const {scrollLeft, scrollTop} = getScrollPosition();
      const viewport = getViewport();
      return {
        x: clientX - viewport.left + scrollLeft,
        y: clientY - viewport.top + scrollTop
      };
    },

    clampClientPoint(clientX, clientY) {
      const viewport = getViewport();
      // 只能截到「滚动表面可视区 ∩ 浏览器窗口」：拖拽时指针可以越出窗口，
      // 若不夹紧，选区会包含永远截不到的内容，成品边缘出现白边。
      const visible = clipToWindow(viewport);
      // 顶部固定导航盖住的内容不属于可选区，指针不能落在导航上。
      const inset = Math.min(readTopOverlayInset(viewport), Math.max(0, visible.height - 1));
      const top = visible.top + inset;
      const right = visible.left + visible.width;
      const bottom = visible.top + visible.height;
      return {
        x: Math.min(Math.max(clientX, visible.left), right),
        y: Math.min(Math.max(clientY, top), bottom)
      };
    },

    lock() {
      if (lockedState) return;
      const {scrollLeft, scrollTop} = getScrollPosition();
      lockedState = {
        scrollLeft,
        scrollTop,
        scrollBehavior: readScrollBehavior()
      };
      writeScrollBehavior('auto', 'important');
    },

    restore() {
      if (!lockedState) return;
      const state = lockedState;
      lockedState = null;
      writeScrollBehavior(state.scrollBehavior.value, state.scrollBehavior.priority);
      setPosition(state.scrollLeft, state.scrollTop);
    }
  };
}
