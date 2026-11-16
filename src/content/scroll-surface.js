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

function intersects(rect, viewport) {
  return rect.right > viewport.left && rect.left < viewport.left + viewport.width
    && rect.bottom > viewport.top && rect.top < viewport.top + viewport.height;
}

function stickyOffset(value) {
  return /^-?(?:\d+|\d*\.\d+)px$/.test(value?.trim?.() ?? '')
    ? Number.parseFloat(value)
    : null;
}

function belongsToSurface(element, surface, ownerDocument) {
  if (surface.kind === 'page') return true;
  return surface.element === element || surface.element?.contains?.(element)
    || (() => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent === surface.element) return true;
      }
      return false;
    })();
}

/** Capture-only mutations that must be unwound even if the capture task fails. */
export class PageStateGuard {
  constructor({surface, document: ownerDocument = document, getComputedStyle: readStyle}) {
    this.surface = surface;
    this.document = ownerDocument;
    this.getComputedStyle = readStyle ?? globalThis.getComputedStyle?.bind(globalThis);
    this.state = null;
    this.repeatedElements = [];
    this.listeners = [];
  }

  prepare() {
    if (this.state) return this.state.metrics;
    const element = this.surface.element;
    const metrics = this.surface.getMetrics();
    const viewport = metrics.viewport;
    const candidates = [...this.document.querySelectorAll('*')].filter(element => {
      const style = this.getComputedStyle(element);
      return style.position === 'fixed'
        || (style.position === 'sticky' && belongsToSurface(element, this.surface, this.document));
    });
    this.state = {
      metrics,
      scrollLeft: metrics.scrollLeft,
      scrollTop: metrics.scrollTop,
      surfaceProperties: element ? {
        scrollBehavior: inlineProperty(element.style, 'scroll-behavior')
      } : null,
      visibility: candidates.map(element => ({element, value: inlineProperty(element.style, 'visibility')})),
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
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'keydown', 'scroll']) {
      this.document.addEventListener(type, preventInput, true);
      this.listeners.push([type, preventInput]);
    }
    return metrics;
  }

  refreshRepeatedElements() {
    if (!this.state) throw new Error('PageStateGuard must be prepared before refreshing repeated elements');
    const metrics = this.surface.getMetrics();
    const {viewport} = metrics;
    const repeated = this.state.candidates.filter(element => {
      const style = this.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!intersects(rect, viewport)) return false;
      if (style.position === 'fixed') return true;
      if (style.position !== 'sticky' || metrics.scrollTop <= this.state.metrics.scrollTop) return false;
      const top = stickyOffset(style.top);
      const bottom = stickyOffset(style.bottom);
      return (top !== null && rect.top <= viewport.top + top + 2)
        || (bottom !== null && rect.bottom >= viewport.top + viewport.height - bottom - 2);
    });
    for (const element of this.repeatedElements) {
      if (!repeated.includes(element)) {
        const saved = this.state.visibility.find(entry => entry.element === element);
        restoreInlineProperty(element.style, 'visibility', saved.value);
      }
    }
    this.repeatedElements = repeated;
  }

  setRepeatedElementsVisible(visible) {
    if (!this.state) throw new Error('PageStateGuard must be prepared before changing visibility');
    for (const element of this.repeatedElements) {
      if (visible) {
        const saved = this.state.visibility.find(entry => entry.element === element);
        restoreInlineProperty(element.style, 'visibility', saved.value);
      } else setInlineProperty(element.style, 'visibility', 'hidden', 'important');
    }
  }

  assertStable() {
    if (!this.state) throw new Error('PageStateGuard must be prepared before asserting stability');
    const previous = this.state.metrics;
    const current = this.surface.getMetrics();
    const viewportKeys = ['left', 'top', 'width', 'height'];
    const viewportChanged = viewportKeys.some(key => Math.abs(current.viewport[key] - previous.viewport[key]) > 2);
    if (viewportChanged || Math.abs(current.clientWidth - previous.clientWidth) > 2
      || Math.abs(current.clientHeight - previous.clientHeight) > 2
      || Math.abs(current.scrollHeight - previous.scrollHeight) > 10) {
      const error = new Error('截图区域在捕获过程中发生变化');
      error.code = 'SURFACE_CHANGED';
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
    for (const {element, value} of [...state.visibility].reverse()) restoreInlineProperty(element.style, 'visibility', value);
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
  }
}

export function createSurface(element) {
  const isPage = element === document.scrollingElement;
  let lockedState = null;

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
      const clientWidth = isPage ? innerWidth : element.clientWidth;
      const clientHeight = isPage ? innerHeight : element.clientHeight;
      return {
        scrollLeft,
        scrollTop,
        clientWidth,
        clientHeight,
        scrollHeight: element.scrollHeight,
        maxScrollTop: Math.max(0, element.scrollHeight - clientHeight),
        viewport
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
      return {
        x: Math.min(Math.max(clientX, viewport.left), viewport.left + viewport.width),
        y: Math.min(Math.max(clientY, viewport.top), viewport.top + viewport.height)
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
