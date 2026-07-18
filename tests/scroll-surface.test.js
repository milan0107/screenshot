import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSurface,
  findScrollSurface,
  isScrollableElement,
  isScrollableMetrics
} from '../src/content/scroll-surface.js';
import { createSelectionUI, positionControls } from '../src/content/selection-ui.js';

test('accepts an overflowing vertical auto container', () => {
  assert.equal(isScrollableMetrics({overflowY: 'auto', scrollHeight: 900, clientHeight: 300}), true);
});

test('accepts an overflowing vertical overlay container', () => {
  assert.equal(isScrollableMetrics({overflowY: 'overlay', scrollHeight: 900, clientHeight: 300}), true);
});

test('rejects visible overflow and non-overflowing elements', () => {
  assert.equal(isScrollableMetrics({overflowY: 'visible', scrollHeight: 900, clientHeight: 300}), false);
  assert.equal(isScrollableMetrics({overflowY: 'scroll', scrollHeight: 300, clientHeight: 300}), false);
});

test('finds the nearest vertically scrollable ancestor and falls back to the page', () => {
  const page = {id: 'page'};
  const outer = {parentElement: null, scrollHeight: 1200, clientHeight: 400};
  const inner = {parentElement: outer, scrollHeight: 600, clientHeight: 200};
  const child = {parentElement: inner};
  const styles = new Map([
    [inner, {overflowY: 'auto'}],
    [outer, {overflowY: 'scroll'}]
  ]);
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = {scrollingElement: page};
  globalThis.getComputedStyle = (element) => styles.get(element) ?? {overflowY: 'visible'};

  try {
    assert.equal(isScrollableElement(inner, styles.get(inner)), true);
    assert.equal(findScrollSurface(child), inner);
    assert.equal(findScrollSurface({parentElement: null}), page);
  } finally {
    globalThis.document = previousDocument;
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('adapts an internal scroll container and restores its locked state exactly', () => {
  const page = {};
  const element = {
    scrollLeft: 30, scrollTop: 40,
    clientWidth: 300, clientHeight: 200, scrollHeight: 900,
    clientLeft: 2, clientTop: 3,
    style: {scrollBehavior: 'smooth'},
    getBoundingClientRect: () => ({left: 100, top: 50})
  };
  const previousDocument = globalThis.document;
  globalThis.document = {scrollingElement: page};

  try {
    const surface = createSurface(element);
    assert.equal(surface.kind, 'element');
    assert.deepEqual(surface.getMetrics(), {
      scrollLeft: 30, scrollTop: 40,
      clientWidth: 300, clientHeight: 200, scrollHeight: 900,
      maxScrollTop: 700,
      viewport: {left: 102, top: 53, width: 300, height: 200}
    });
    assert.deepEqual(surface.toContentPoint(122, 73), {x: 50, y: 60});
    assert.deepEqual(surface.clampClientPoint(50, 500), {x: 102, y: 253});

    surface.lock();
    assert.equal(element.style.scrollBehavior, 'auto');
    surface.setScrollTop(500);
    surface.restore();
    assert.equal(element.style.scrollBehavior, 'smooth');
    assert.equal(element.scrollLeft, 30);
    assert.equal(element.scrollTop, 40);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('lock overrides and exactly restores important inline scroll behavior', () => {
  class FakeStyle {
    constructor() {
      this.values = new Map([['scroll-behavior', 'smooth']]);
      this.priorities = new Map([['scroll-behavior', 'important']]);
    }
    getPropertyValue(name) { return this.values.get(name) ?? ''; }
    getPropertyPriority(name) { return this.priorities.get(name) ?? ''; }
    setProperty(name, value, priority = '') {
      this.values.set(name, value);
      this.priorities.set(name, priority);
    }
    removeProperty(name) {
      this.values.delete(name);
      this.priorities.delete(name);
    }
  }
  const page = {};
  const element = {
    scrollLeft: 0, scrollTop: 10,
    clientWidth: 100, clientHeight: 100, scrollHeight: 300,
    clientLeft: 0, clientTop: 0,
    style: new FakeStyle(),
    getBoundingClientRect: () => ({left: 0, top: 0})
  };
  const previousDocument = globalThis.document;
  globalThis.document = {scrollingElement: page};
  try {
    const surface = createSurface(element);
    surface.lock();
    assert.equal(element.style.getPropertyValue('scroll-behavior'), 'auto');
    assert.equal(element.style.getPropertyPriority('scroll-behavior'), 'important');
    surface.restore();
    assert.equal(element.style.getPropertyValue('scroll-behavior'), 'smooth');
    assert.equal(element.style.getPropertyPriority('scroll-behavior'), 'important');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('adapts the page scrolling element', () => {
  const page = {
    scrollWidth: 1400, scrollHeight: 1800,
    clientWidth: 1000, clientHeight: 700,
    style: {scrollBehavior: ''}
  };
  const calls = [];
  const previous = {
    document: globalThis.document,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    scrollX: globalThis.scrollX,
    scrollY: globalThis.scrollY,
    scrollTo: globalThis.scrollTo
  };
  Object.assign(globalThis, {
    document: {scrollingElement: page},
    innerWidth: 1000, innerHeight: 700,
    scrollX: 20, scrollY: 80,
    scrollTo: (x, y) => calls.push([x, y])
  });

  try {
    const surface = createSurface(page);
    assert.equal(surface.kind, 'page');
    assert.deepEqual(surface.getMetrics().viewport, {left: 0, top: 0, width: 1000, height: 700});
    assert.deepEqual(surface.toContentPoint(10, 20), {x: 30, y: 100});
    surface.lock();
    surface.setScrollTop(250);
    surface.restore();
    assert.deepEqual(calls, [[20, 250], [20, 80]]);
    assert.equal(page.style.scrollBehavior, '');
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('positions selection controls beside the capture frame within viewport safety margins', () => {
  const viewport = {left: 0, top: 0, width: 320, height: 240};
  const controlSize = {width: 100, height: 40};

  assert.deepEqual(
    positionControls({left: 40, top: 60, right: 180, bottom: 160}, viewport, controlSize, viewport),
    {left: 188, top: 90}
  );
  assert.deepEqual(
    positionControls({left: 140, top: 60, right: 315, bottom: 160}, viewport, controlSize, viewport),
    {left: 32, top: 90}
  );

  const constrained = positionControls(
    {left: 5, top: 2, right: 315, bottom: 22},
    viewport,
    controlSize,
    viewport
  );
  assert.ok(constrained.left >= 8 && constrained.left <= 212);
  assert.equal(constrained.left, 212);
  assert.equal(constrained.top, 8);
});

test('positions controls against the browser viewport instead of an internal scroll surface', () => {
  const controlSize = {width: 100, height: 40};
  const internalViewport = {left: 100, top: 0, width: 200, height: 240};
  const browserViewport = {width: 800, height: 240};

  assert.deepEqual(
    positionControls({left: 190, top: 60, right: 290, bottom: 160}, internalViewport, controlSize, browserViewport),
    {left: 298, top: 90}
  );
  assert.deepEqual(
    positionControls({left: 220, top: 60, right: 290, bottom: 160}, internalViewport, controlSize, browserViewport),
    {left: 298, top: 90}
  );
});

test('clamps oversized controls and bottom placement to browser viewport safety margins', () => {
  const viewport = {left: 100, top: 0, width: 200, height: 240};
  const oversized = positionControls(
    {left: 190, top: 220, right: 290, bottom: 260},
    viewport,
    {width: 900, height: 40},
    {width: 800, height: 240}
  );
  const bottom = positionControls(
    {left: 190, top: 220, right: 290, bottom: 260},
    viewport,
    {width: 100, height: 40},
    {width: 800, height: 240}
  );

  assert.equal(oversized.left, 8);
  assert.equal(bottom.top, 192);
});

test('keeps oversized control groups vertically accessible in a short viewport', () => {
  const position = positionControls(
    {left: 40, top: 30, right: 140, bottom: 70},
    {left: 0, top: 0, width: 180, height: 120},
    {width: 100, height: 200},
    {width: 180, height: 120}
  );

  assert.equal(position.top, 8);
});

test('creates a closed-shadow selection overlay with working controls', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.className = '';
      this.textContent = '';
      this.isConnected = false;
      this.shadowRoot = null;
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
    releasePointerCapture(pointerId) { this.releasedPointerId = pointerId; }
    attachShadow(options) {
      this.shadowMode = options.mode;
      this.attachedShadow = new FakeElement('#shadow-root');
      return this.attachedShadow;
    }
    remove() { this.isConnected = false; }
  }

  const root = new FakeElement('html');
  root.append = (...children) => {
    root.children.push(...children);
    for (const child of children) child.isConnected = true;
  };
  const fakeDocument = {
    documentElement: root,
    createElement: (tagName) => new FakeElement(tagName)
  };
  const calls = [];
  const ui = createSelectionUI({
    onConfirm: () => calls.push('confirm'),
    onReselect: () => calls.push('reselect'),
    onCancel: () => calls.push('cancel')
  }, fakeDocument);
  const buttons = ui.host.attachedShadow.children
    .flatMap((child) => child.children)
    .filter((child) => child.tagName === 'button');

  assert.equal(ui.host.shadowMode, 'closed');
  assert.deepEqual(buttons.map((button) => button.textContent), ['确认截图', '高清', '重新选择', '取消']);
  for (const button of buttons) button.listeners.click({stopPropagation() {}});
  assert.deepEqual(calls, ['confirm', 'reselect', 'cancel']);
  ui.remove();
  assert.equal(ui.host.isConnected, false);
});

test('selection UI forwards only the pointer that initiated the drag', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    attachShadow() {
      this.attachedShadow = new FakeElement('#shadow-root');
      return this.attachedShadow;
    }
    setPointerCapture(pointerId) { (this.captured ??= []).push(pointerId); }
    releasePointerCapture(pointerId) { (this.released ??= []).push(pointerId); }
    remove() {}
  }
  const root = new FakeElement('html');
  const fakeDocument = {documentElement: root, createElement: (tag) => new FakeElement(tag)};
  const calls = [];
  const ui = createSelectionUI({
    onPointerDown: (event) => calls.push(`down:${event.pointerId}`),
    onPointerMove: (event) => calls.push(`move:${event.pointerId}`),
    onPointerUp: (event) => calls.push(`up:${event.pointerId}`),
    onPointerCancel: (event) => calls.push(`cancel:${event.pointerId}`)
  }, fakeDocument);
  const mask = ui.host.attachedShadow.children.find((child) => child.className === 'mask');
  const pointer = (pointerId) => ({
    pointerId, button: 0, isPrimary: true,
    preventDefault() {}
  });

  mask.listeners.pointerdown(pointer(7));
  mask.listeners.pointermove(pointer(8));
  mask.listeners.pointermove(pointer(7));
  mask.listeners.pointerup(pointer(8));
  mask.listeners.pointercancel(pointer(7));
  mask.listeners.pointermove(pointer(7));
  mask.listeners.pointerdown(pointer(9));
  mask.listeners.pointerup(pointer(9));
  mask.listeners.pointermove(pointer(9));
  mask.listeners.pointerdown(pointer(10));
  mask.listeners.pointerup(pointer(10));

  assert.deepEqual(calls, [
    'down:7', 'move:7', 'cancel:7',
    'down:9', 'up:9', 'down:10', 'up:10'
  ]);
  assert.deepEqual(mask.captured, [7, 9, 10]);
  assert.deepEqual(mask.released, [7, 9, 10]);
});

test('selection UI keeps controls within a narrow viewport', () => {
  class FakeElement {
    constructor() {
      this.children = [];
      this.style = {};
      this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    attachShadow() {
      this.attachedShadow = new FakeElement();
      return this.attachedShadow;
    }
    remove() {}
  }
  const fakeDocument = {
    documentElement: new FakeElement(),
    createElement: () => new FakeElement()
  };
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 180;
  globalThis.innerHeight = 120;
  try {
    const ui = createSelectionUI({}, fakeDocument);
    const controls = ui.host.attachedShadow.children.find((child) => child.className === 'controls');
    const style = ui.host.attachedShadow.children.find((child) => child.tagName === undefined && child.textContent);
    ui.showSelection({left: 160, top: 20, right: 175, bottom: 100}, {
      left: 0, top: 0, width: 180, height: 120
    });
    assert.ok(Number.parseFloat(controls.style.left) >= 0);
    assert.ok(Number.parseFloat(controls.style.top) >= 0);
    assert.match(style.textContent, /\.controls\s*\{[^}]*box-sizing:\s*border-box/);
    assert.match(style.textContent, /\.controls\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/);
    assert.match(style.textContent, /\.controls\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(style.textContent, /\.controls\s*\{[^}]*max-height:\s*calc\(100vh - 16px\)/);
    assert.match(style.textContent, /\.controls\s*\{[^}]*overflow-y:\s*auto/);
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});
