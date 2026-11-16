import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSurface,
  findScrollSurface,
  isScrollableElement,
  isScrollableMetrics
} from '../src/content/scroll-surface.js';
import { createSelectionUI, positionPanelAt } from '../src/content/selection-ui.js';

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

test('菜单默认出现在指针右上方，越界时翻转', () => {
  const viewport = {width: 320, height: 240};
  const panelSize = {width: 100, height: 40};

  // 上方放得下 → 面板底边在指针上方 8px
  assert.deepEqual(positionPanelAt({x: 40, y: 60}, panelSize, viewport), {left: 48, top: 12});
  // 右侧空间不足 → 翻到指针左侧
  assert.deepEqual(positionPanelAt({x: 315, y: 60}, panelSize, viewport), {left: 207, top: 12});
  // 上方空间不足 → 退到指针下方
  assert.deepEqual(positionPanelAt({x: 40, y: 30}, panelSize, viewport), {left: 48, top: 38});
  // 上、右都不足 → 左/下翻转
  assert.deepEqual(positionPanelAt({x: 315, y: 30}, panelSize, viewport), {left: 207, top: 38});
});

test('菜单与指针保持间隔，避免指针落在面板上影响开始框选', () => {
  const viewport = {width: 800, height: 600};
  const panelSize = {width: 240, height: 72};
  const point = {x: 300, y: 200};
  const {left, top} = positionPanelAt(point, panelSize, viewport);

  assert.ok(left > point.x && top + panelSize.height < point.y);
  assert.ok(left - point.x >= 8 && point.y - (top + panelSize.height) >= 8);
});

test('超尺寸菜单与贴近边缘的指针也会被夹紧到视口安全边距内', () => {
  const viewport = {width: 800, height: 240};

  // 面板比视口还宽 → 左边界夹紧到安全边距 8
  assert.equal(positionPanelAt({x: 780, y: 235}, {width: 900, height: 40}, viewport).left, 8);
  // 上方不足、右侧不足 → 退到左下方
  assert.deepEqual(positionPanelAt({x: 780, y: 30}, {width: 100, height: 40}, viewport), {left: 672, top: 38});
  // 指针贴左上角时不会移出安全边距
  assert.deepEqual(positionPanelAt({x: 2, y: 2}, {width: 100, height: 40}, viewport), {left: 10, top: 10});
});

test('短视口下高面板仍可从顶部看到', () => {
  const position = positionPanelAt({x: 40, y: 30}, {width: 100, height: 200}, {width: 180, height: 120});

  assert.equal(position.top, 8);
});

test('截图完成后才展开「格式 / 保存 / 复制 / 关闭」菜单', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.className = '';
      this.textContent = '';
      this.isConnected = false;
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
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
  const fakeDocument = {documentElement: root, createElement: (tagName) => new FakeElement(tagName)};
  const calls = [];
  const ui = createSelectionUI({
    onSave: () => calls.push('save'),
    onCopy: () => calls.push('copy'),
    onClose: () => calls.push('close'),
    onSelectMode: (mode) => calls.push(`mode:${mode}`),
    onSelectFormat: (format) => calls.push(`format:${format}`)
  }, fakeDocument);
  const shadowChildren = ui.host.attachedShadow.children;
  const panel = shadowChildren.find((child) => child.className === 'panel');
  const [modeRow, formatRow, actions] = panel.children;
  const modeButtons = modeRow.children.filter((child) => child.tagName === 'button');
  const formatButtons = formatRow.children.filter((child) => child.tagName === 'button');
  const actionButtons = actions.children.filter((child) => child.tagName === 'button');

  assert.equal(ui.host.shadowMode, 'closed');
  assert.deepEqual(modeRow.children.map((child) => child.textContent), ['画质', '普通', '高清']);
  assert.deepEqual(formatRow.children.map((child) => child.textContent), ['格式', 'PNG', 'JPG']);
  assert.deepEqual(actionButtons.map((button) => button.textContent),
    ['保存', '复制到剪贴板', '关闭']);
  assert.equal(modeButtons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(formatButtons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(formatButtons[1].getAttribute('aria-pressed'), 'false');

  // 截图前只显示画质行。
  ui.showModeOptions();
  assert.equal(modeRow.style.display, 'flex');
  assert.equal(formatRow.style.display, 'none');
  assert.equal(actions.style.display, 'none');

  // 截图完成后只显示格式行与操作行。
  ui.showActions({x: 100, y: 100});
  assert.equal(modeRow.style.display, 'none');
  assert.equal(formatRow.style.display, 'flex');
  assert.equal(actions.style.display, 'flex');

  for (const button of [...modeButtons, ...actionButtons, ...formatButtons]) {
    button.listeners.click({stopPropagation() {}});
  }
  assert.deepEqual(calls, [
    'mode:normal', 'mode:highQuality', 'save', 'copy', 'close', 'format:png', 'format:jpeg'
  ]);
  ui.remove();
  assert.equal(ui.host.isConnected, false);
});

test('格式选择同步选中态，且截图期间整体隐藏扩展 UI', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
    attachShadow() { this.attachedShadow = new FakeElement('#shadow-root'); return this.attachedShadow; }
    getBoundingClientRect() { return {width: 240, height: 70}; }
    remove() {}
  }
  const fakeDocument = {documentElement: new FakeElement('html'), createElement: (tag) => new FakeElement(tag)};
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  try {
    const ui = createSelectionUI({}, fakeDocument);
    const panel = ui.host.attachedShadow.children.find((child) => child.className === 'panel');
    const [modeRow, formatRow] = panel.children;
    const [normal, highQuality] = modeRow.children.filter((child) => child.tagName === 'button');
    const [png, jpg] = formatRow.children.filter((child) => child.tagName === 'button');

    ui.setMode(true, true);
    assert.equal(highQuality.getAttribute('aria-pressed'), 'true');
    assert.equal(normal.getAttribute('aria-pressed'), 'false');
    assert.equal(normal.disabled, true);
    assert.equal(highQuality.disabled, true);
    ui.setMode(false);
    assert.equal(normal.getAttribute('aria-pressed'), 'true');
    assert.equal(normal.disabled, false);
    assert.equal(highQuality.disabled, false);

    assert.equal(png.getAttribute('aria-pressed'), 'true');
    assert.equal(jpg.getAttribute('aria-pressed'), 'false');
    ui.setFormat('jpeg');
    assert.equal(png.getAttribute('aria-pressed'), 'false');
    assert.equal(jpg.getAttribute('aria-pressed'), 'true');
    ui.setFormat('png');
    assert.equal(png.getAttribute('aria-pressed'), 'true');

    ui.setVisible(false);
    assert.equal(ui.host.style.visibility, 'hidden');
    ui.setVisible(true);
    assert.equal(ui.host.style.visibility, 'visible');
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});

test('菜单各阶段首次出现时定位到指针旁，越界时翻转夹紧', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
    attachShadow() { this.attachedShadow = new FakeElement('#shadow-root'); return this.attachedShadow; }
    getBoundingClientRect() { return {width: 200, height: 70}; }
    remove() {}
  }
  const fakeDocument = {documentElement: new FakeElement('html'), createElement: (tag) => new FakeElement(tag)};
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  try {
    const ui = createSelectionUI({}, fakeDocument);
    const panel = ui.host.attachedShadow.children.find((child) => child.className === 'panel');
    const [, actions] = panel.children;

    // 未定位前保持隐藏
    assert.equal(panel.style.display, undefined);

    ui.showActions({x: 120, y: 90});
    assert.equal(panel.style.display, 'flex');
    assert.equal(actions.style.display, 'flex');
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '12px');

    // 显示期间停驻：重复调用、切换到确认菜单都不重新定位
    ui.showActions({x: 500, y: 400});
    assert.equal(panel.style.left, '128px');
    ui.showConfirm({x: 790, y: 590});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '12px');
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});

test('菜单只在出现时定位一次，之后停驻不跟随鼠标', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
    attachShadow() { this.attachedShadow = new FakeElement('#shadow-root'); return this.attachedShadow; }
    getBoundingClientRect() { return {width: 200, height: 40}; }
    remove() {}
  }
  const fakeDocument = {documentElement: new FakeElement('html'), createElement: (tag) => new FakeElement(tag)};
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  try {
    const ui = createSelectionUI({}, fakeDocument);
    const panel = ui.host.attachedShadow.children.find((child) => child.className === 'panel');

    // 无指针坐标时用默认居中位置
    ui.showModeOptions();
    assert.equal(panel.style.display, 'flex');
    assert.equal(panel.style.transform, undefined);

    // 已显示后，任何阶段的再次调用都停驻原地（无指针坐标也不移动）
    ui.showModeOptions({x: 500, y: 400});
    assert.equal(panel.style.transform, undefined);
    ui.showConfirm({x: 300, y: 200});
    assert.equal(panel.style.transform, undefined);
    ui.showActions({x: 700, y: 550});
    assert.equal(panel.style.transform, undefined);

    // 隐藏后再次显示：视为新一次出现，重新定位
    ui.hidePanel();
    assert.equal(panel.style.display, 'none');
    ui.showModeOptions({x: 120, y: 90});
    assert.equal(panel.style.transform, 'none');
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '42px');
    ui.showConfirm({x: 600, y: 500});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '42px');
    ui.showActions({x: 50, y: 50});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '42px');
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});

test('selection UI 拖拽时只转发起始指针，无拖拽时转发悬停移动', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.dataset = {};
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
    'down:7', 'move:7', 'cancel:7', 'move:7',
    'down:9', 'up:9', 'move:9', 'down:10', 'up:10'
  ]);
  assert.deepEqual(mask.captured, [7, 9, 10]);
  assert.deepEqual(mask.released, [7, 9, 10]);
});

test('selection UI 的面板在窄视口下仍可完整使用', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
    attachShadow() {
      this.attachedShadow = new FakeElement('#shadow-root');
      return this.attachedShadow;
    }
    getBoundingClientRect() { return {width: 260, height: 70}; }
    remove() {}
  }
  const fakeDocument = {
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag)
  };
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 180;
  globalThis.innerHeight = 120;
  try {
    const ui = createSelectionUI({}, fakeDocument);
    const panel = ui.host.attachedShadow.children.find((child) => child.className === 'panel');
    const style = ui.host.attachedShadow.children.find((child) => child.tagName === 'style');
    ui.showActions({x: 170, y: 110});
    assert.ok(Number.parseFloat(panel.style.left) >= 8);
    assert.ok(Number.parseFloat(panel.style.top) >= 8);
    assert.match(style.textContent, /\.panel\s*\{[^}]*box-sizing:\s*border-box/);
    assert.match(style.textContent, /\.panel\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/);
    assert.match(style.textContent, /\.panel\s*\{[^}]*max-height:\s*calc\(100vh - 16px\)/);
    assert.match(style.textContent, /\.panel\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(style.textContent, /\.panel-row\s*\{[^}]*flex-wrap:\s*wrap/);
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});
