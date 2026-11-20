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
  const previous = {document: globalThis.document, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight};
  Object.assign(globalThis, {document: {scrollingElement: page}, innerWidth: 1000, innerHeight: 700});

  try {
    const surface = createSurface(element);
    assert.equal(surface.kind, 'element');
    assert.deepEqual(surface.getMetrics(), {
      scrollLeft: 30, scrollTop: 40,
      clientWidth: 300, clientHeight: 200, scrollHeight: 900,
      maxScrollTop: 700,
      viewport: {left: 102, top: 53, width: 300, height: 200},
      visible: {left: 102, top: 53, width: 300, height: 200},
      window: {width: 1000, height: 700}
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
    Object.assign(globalThis, previous);
  }
});

test('clips the visible area of a container that extends past the window', () => {
  const page = {};
  const element = {
    scrollLeft: 0, scrollTop: 0,
    clientWidth: 1000, clientHeight: 900, scrollHeight: 4000,
    clientLeft: 0, clientTop: 0,
    style: {scrollBehavior: ''},
    getBoundingClientRect: () => ({left: 0, top: 56})
  };
  const previous = {document: globalThis.document, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight};
  Object.assign(globalThis, {document: {scrollingElement: page}, innerWidth: 1184, innerHeight: 705});
  try {
    const surface = createSurface(element);
    const metrics = surface.getMetrics();
    assert.deepEqual(metrics.viewport, {left: 0, top: 56, width: 1000, height: 900});
    // 只能截到窗口内的 56..705，分帧步长必须用 649 而不是 900
    assert.deepEqual(metrics.visible, {left: 0, top: 56, width: 1000, height: 649});
    // 拖拽点同样只能落在「容器 ∩ 窗口」内，否则会框出永远截不到的区域
    assert.deepEqual(surface.clampClientPoint(-10, -10), {x: 0, y: 56});
    assert.deepEqual(surface.clampClientPoint(2000, 2000), {x: 1000, y: 705});
  } finally {
    Object.assign(globalThis, previous);
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
    assert.deepEqual(surface.getMetrics().visible, {left: 0, top: 0, width: 1000, height: 700});
    assert.deepEqual(surface.getMetrics().window, {width: 1000, height: 700});
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

test('菜单默认出现在指针右下方，越界时翻转', () => {
  const viewport = {width: 320, height: 240};
  const panelSize = {width: 100, height: 40};

  // 下方放得下 → 面板顶边在指针下方 8px
  assert.deepEqual(positionPanelAt({x: 40, y: 60}, panelSize, viewport), {left: 48, top: 68});
  // 右侧空间不足 → 翻到指针左侧
  assert.deepEqual(positionPanelAt({x: 315, y: 60}, panelSize, viewport), {left: 207, top: 68});
  // 下方空间不足 → 翻到指针上方
  assert.deepEqual(positionPanelAt({x: 40, y: 230}, panelSize, viewport), {left: 48, top: 182});
  // 右、下都不足 → 左/上翻转
  assert.deepEqual(positionPanelAt({x: 315, y: 235}, panelSize, viewport), {left: 207, top: 187});
});

test('菜单与指针保持间隔，避免指针落在面板上影响开始框选', () => {
  const viewport = {width: 800, height: 600};
  const panelSize = {width: 240, height: 72};
  const point = {x: 300, y: 200};
  const {left, top} = positionPanelAt(point, panelSize, viewport);

  assert.ok(left > point.x && top > point.y);
  assert.ok(left - point.x >= 8 && top - point.y >= 8);
});

test('超尺寸菜单与贴近边缘的指针也会被夹紧到视口安全边距内', () => {
  const viewport = {width: 800, height: 240};

  // 面板比视口还宽 → 左边界夹紧到安全边距 8
  assert.equal(positionPanelAt({x: 780, y: 235}, {width: 900, height: 40}, viewport).left, 8);
  // 下方不足、右侧不足 → 翻到左上方
  assert.deepEqual(positionPanelAt({x: 780, y: 235}, {width: 100, height: 40}, viewport), {left: 672, top: 187});
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
  const [modeRow, separator1, formatRow, separator2, actions] = panel.children;
  const modeButtons = modeRow.children.filter((child) => child.tagName === 'button');
  const formatButtons = formatRow.children.filter((child) => child.tagName === 'button');
  const actionButtons = actions.children.filter((child) => child.tagName === 'button');

  assert.equal(ui.host.shadowMode, 'closed');
  assert.deepEqual(modeRow.children.map((child) => child.textContent), ['画质', '普通', '高清']);
  assert.equal(separator1.className, 'panel-separator');
  assert.equal(separator2.className, 'panel-separator');
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

  // 截图完成后单排显示「格式 + 操作」，画质行与分隔线隐藏。
  ui.showActions({x: 100, y: 100});
  assert.equal(modeRow.style.display, 'none');
  assert.equal(separator1.style.display, 'none');
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
    const [modeRow, separator1, formatRow] = panel.children;
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
    const actions = panel.children[4];

    // 未定位前保持隐藏
    assert.equal(panel.style.display, undefined);

    ui.showActions({x: 120, y: 90});
    assert.equal(panel.style.display, 'flex');
    assert.equal(actions.style.display, 'flex');
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '98px');

    // 显示期间停驻：重复调用、切换到确认菜单都不重新定位
    ui.showActions({x: 500, y: 400});
    assert.equal(panel.style.left, '128px');
    ui.showConfirm({x: 790, y: 590});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '98px');
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

    // 无指针坐标（刚点图标，鼠标还在工具栏）→ 停靠浏览器右上角
    ui.showModeOptions();
    assert.equal(panel.style.display, 'flex');
    assert.equal(panel.style.transform, 'none');
    const dockedLeft = Number.parseFloat(panel.style.left);
    assert.equal(dockedLeft, 800 - 200 - 16, '应贴右边框（右侧留 16px）');
    assert.equal(panel.style.top, '16px');

    // 已显示后，任何阶段的再次调用都停驻原地（不因传入坐标而移动）
    ui.showModeOptions({x: 500, y: 400});
    assert.equal(panel.style.left, `${dockedLeft}px`);
    ui.showConfirm({x: 300, y: 200});
    assert.equal(panel.style.left, `${dockedLeft}px`);
    ui.showActions({x: 700, y: 550});
    assert.equal(panel.style.left, `${dockedLeft}px`);

    // 隐藏后再次显示：视为新一次出现，重新定位
    ui.hidePanel();
    assert.equal(panel.style.display, 'none');
    ui.showModeOptions({x: 120, y: 90});
    assert.equal(panel.style.transform, 'none');
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '98px');
    ui.showConfirm({x: 600, y: 500});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '98px');
    ui.showActions({x: 50, y: 50});
    assert.equal(panel.style.left, '128px');
    assert.equal(panel.style.top, '98px');
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});

test('阶段切换后面板变宽时按新尺寸重新夹紧，不会被视口右侧裁掉', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName; this.children = []; this.style = {}; this.listeners = {};
      this.dataset = {}; this.className = ''; this.textContent = '';
    }
    append(...c) { this.children.push(...c); }
    addEventListener(t, l) { this.listeners[t] = l; }
    setAttribute(n, v) { (this.attributes ??= {})[n] = v; }
    attachShadow() { this.attachedShadow = new FakeElement('#shadow'); return this.attachedShadow; }
    // 宽度随当前可见行变化：画质行窄，输出行宽
    getBoundingClientRect() { return {width: this.measuredWidth ?? 200, height: 42}; }
    remove() {}
  }
  const doc = {documentElement: new FakeElement('html'), createElement: t => new FakeElement(t)};
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 480;
  globalThis.innerHeight = 400;
  try {
    const ui = createSelectionUI({}, doc);
    const panel = ui.host.attachedShadow.children.find((c) => c.className === 'panel');
    const MARGIN = 8;

    panel.measuredWidth = 200;
    ui.showModeOptions({x: 400, y: 100});
    let left = Number.parseFloat(panel.style.left);
    assert.ok(left + 200 <= 480 - MARGIN, `画质行应完整可见，实际右边缘 ${left + 200}`);

    // 切到输出行（宽度 420）：锚点不变，但必须按新宽度收回视口内
    panel.measuredWidth = 420;
    ui.showActions({x: 400, y: 100});
    left = Number.parseFloat(panel.style.left);
    assert.ok(left >= MARGIN && left + 420 <= 480 - MARGIN,
      `输出行应完整可见，实际 ${left}..${left + 420}（视口 480）`);
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});

test('无锚点时菜单停靠浏览器右上角，切换阶段变宽后仍贴右边框', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName; this.children = []; this.style = {}; this.listeners = {};
      this.dataset = {}; this.className = ''; this.textContent = '';
    }
    append(...c) { this.children.push(...c); }
    addEventListener(t, l) { this.listeners[t] = l; }
    setAttribute(n, v) { (this.attributes ??= {})[n] = v; }
    attachShadow() { this.attachedShadow = new FakeElement('#shadow'); return this.attachedShadow; }
    getBoundingClientRect() { return {width: this.w ?? 200, height: 42}; }
    remove() {}
  }
  const doc = {documentElement: new FakeElement('html'), createElement: t => new FakeElement(t)};
  const previousWidth = globalThis.innerWidth;
  const previousHeight = globalThis.innerHeight;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  try {
    const ui = createSelectionUI({}, doc);
    const panel = ui.host.attachedShadow.children.find((c) => c.className === 'panel');

    ui.showModeOptions();   // 点图标时鼠标在工具栏，页面内无指针坐标
    assert.equal(panel.style.top, '16px');
    assert.equal(1280 - (Number.parseFloat(panel.style.left) + 200), 16, '右侧应留 16px');

    // 输出阶段更宽：仍贴右边框且完整可见
    panel.w = 420;
    ui.showActions();
    const left = Number.parseFloat(panel.style.left);
    assert.equal(1280 - (left + 420), 16, `变宽后仍应贴右边框，实际 right=${left + 420}`);
    assert.ok(left >= 8);
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
    assert.match(style.textContent, /\.panel\s*\{[^}]*flex-direction:\s*row/);
  } finally {
    globalThis.innerWidth = previousWidth;
    globalThis.innerHeight = previousHeight;
  }
});
