import assert from 'node:assert/strict';
import test from 'node:test';

import {PageStateGuard} from '../src/content/scroll-surface.js';
import {createCaptureFeedback} from '../src/content/selection-ui.js';

class FakeStyle {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.priorities = new Map();
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

function makeGuardFixture() {
  const listeners = [];
  const fixed = {style: new FakeStyle({visibility: 'collapse'}), getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 40})};
  const sticky = {style: new FakeStyle({visibility: 'visible'}), getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 40})};
  const surfaceElement = {
    style: new FakeStyle({'scroll-behavior': 'smooth', overflow: 'clip'}),
    scrollLeft: 13, scrollTop: 27, clientWidth: 300, clientHeight: 200, scrollHeight: 900,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 300, height: 200})
  };
  surfaceElement.style.setProperty('scroll-behavior', 'smooth', 'important');
  fixed.style.setProperty('visibility', 'collapse', 'important');
  sticky.style.setProperty('visibility', 'visible', 'important');
  const surface = {
    element: surfaceElement,
    getMetrics: () => ({scrollLeft: surfaceElement.scrollLeft, scrollTop: surfaceElement.scrollTop, clientWidth: surfaceElement.clientWidth, clientHeight: surfaceElement.clientHeight, scrollHeight: surfaceElement.scrollHeight, viewport: {left: 0, top: 0, width: 300, height: 200}}),
    setScrollTop: top => { surfaceElement.scrollTop = top; }
  };
  sticky.parentElement = surfaceElement;
  const ownerDocument = {
    documentElement: {clientWidth: 300, clientHeight: 200},
    querySelectorAll: () => [fixed, sticky],
    addEventListener: (...args) => listeners.push(args),
    removeEventListener: (...args) => listeners.push(['remove', ...args])
  };
  const getStyle = element => element === fixed ? {position: 'fixed'} : {position: 'sticky', top: '0px'};
  return {fixed, sticky, surface, surfaceElement, ownerDocument, getStyle, listeners};
}

test('PageStateGuard 异常后精确恢复滚动、内联值和优先级', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollLeft = 100;
  fixture.surfaceElement.scrollTop = 200;
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.fixed.style.getPropertyPriority('visibility'), 'important');
  assert.equal(fixture.fixed.style.getPropertyValue('opacity'), '0');
  assert.equal(fixture.fixed.style.getPropertyPriority('opacity'), 'important');

  guard.restore();
  assert.equal(fixture.surfaceElement.scrollLeft, 13);
  assert.equal(fixture.surfaceElement.scrollTop, 27);
  assert.equal(fixture.surfaceElement.style.getPropertyValue('scroll-behavior'), 'smooth');
  assert.equal(fixture.surfaceElement.style.getPropertyPriority('scroll-behavior'), 'important');
  assert.equal(fixture.fixed.style.getPropertyValue('visibility'), 'collapse');
  assert.equal(fixture.fixed.style.getPropertyPriority('visibility'), 'important');
  assert.equal(fixture.fixed.style.getPropertyValue('opacity'), '');
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'visible');
  assert.equal(fixture.sticky.style.getPropertyPriority('visibility'), 'important');
  assert.equal(fixture.listeners.filter(item => item[0] === 'remove').length, 8);
});

test('PageStateGuard restore 可重复调用且不改变已恢复状态', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  guard.setRepeatedElementsVisible(false);
  guard.restore();
  const removals = fixture.listeners.filter(item => item[0] === 'remove').length;
  guard.restore();
  assert.equal(fixture.fixed.style.getPropertyValue('visibility'), 'collapse');
  assert.equal(fixture.listeners.filter(item => item[0] === 'remove').length, removals);
});

test('PageStateGuard 隐藏浮层时保留并恢复原有的 opacity', () => {
  const fixture = makeGuardFixture();
  fixture.fixed.style.setProperty('opacity', '0.6', 'important');
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle});
  guard.prepare();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.fixed.style.getPropertyValue('opacity'), '0');
  guard.restore();
  assert.equal(fixture.fixed.style.getPropertyValue('opacity'), '0.6');
  assert.equal(fixture.fixed.style.getPropertyPriority('opacity'), 'important');
});

test('PageStateGuard 在滚动区域内容变矮时拒绝继续截取', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollHeight -= 11;
  assert.throws(() => guard.assertStable(),
    error => error.code === 'SURFACE_CHANGED' && error.details?.includes('内容高度-11px'));
});

test('PageStateGuard 允许内容高度向下增长（懒加载/虚拟列表）', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollHeight += 800;
  assert.equal(guard.assertStable().scrollHeight, 1700);
});

test('PageStateGuard 调用原生 getComputedStyle 时保留 Window 上下文', () => {
  const fixture = makeGuardFixture();
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = function getComputedStyleWithWindowContext(element) {
    assert.equal(this, globalThis);
    return fixture.getStyle(element);
  };
  try {
    const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument});
    assert.doesNotThrow(() => guard.prepare());
    guard.restore();
  } finally {
    if (previous === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previous;
  }
});

test('普通首屏 sticky top:0 未因滚动吸顶时不会被去重隐藏', () => {
  const fixture = makeGuardFixture();
  fixture.surfaceElement.scrollTop = 0;
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'visible');
});

test('实际滚动后被 sticky 约束钉住的元素会被去重隐藏', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollTop = 30;
  guard.refreshRepeatedElements();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'hidden');
});

test('准备后才变为吸顶的 sticky 候选会在稳定分段中被去重', () => {
  const fixture = makeGuardFixture();
  fixture.surfaceElement.scrollTop = 0;
  let pinned = false;
  fixture.sticky.getBoundingClientRect = () => ({left: 0, top: pinned ? 0 : 80, right: 40, bottom: pinned ? 40 : 120});
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollTop = 80;
  pinned = true;
  guard.refreshRepeatedElements();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'hidden');
});

test('prepare 时已吸顶的 sticky 在回滚到选区起点后仍会被去重隐藏', () => {
  const fixture = makeGuardFixture();
  fixture.surfaceElement.scrollTop = 3000;
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  // 选区起点在 prepare 位置之上：截图会先回滚，不能因此把导航条当成正文。
  fixture.surfaceElement.scrollTop = 500;
  guard.refreshRepeatedElements();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'hidden');
  guard.restore();
});

test('prepare 时被顶出视口的 sticky 不会被误记为已吸顶', () => {
  const fixture = makeGuardFixture();
  fixture.surfaceElement.scrollTop = 3000;
  // 元素在 prepare 时已经随所在区块滚出视口上方，不是在吸顶位置。
  fixture.sticky.getBoundingClientRect = () => ({left: 0, top: -1040, right: 40, bottom: -1000});
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  // 截图回滚到它所在的位置：此时它是正常正文，不能隐藏。
  fixture.sticky.getBoundingClientRect = () => ({left: 0, top: 0, right: 40, bottom: 40});
  fixture.surfaceElement.scrollTop = 1400;
  guard.refreshRepeatedElements();
  guard.setRepeatedElementsVisible(false);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'visible');
  guard.restore();
});

test('滚动后新吸顶的元素在刷新时立即隐藏，不依赖后续可见性消息', () => {
  const fixture = makeGuardFixture();
  fixture.surfaceElement.scrollTop = 0;
  let pinned = false;
  fixture.sticky.getBoundingClientRect = () => ({left: 0, top: pinned ? 0 : 120, right: 40, bottom: pinned ? 40 : 160});
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  guard.setRepeatedElementsVisible(false);
  fixture.surfaceElement.scrollTop = 200;
  pinned = true;
  guard.refreshRepeatedElements();
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'hidden');
  guard.restore();
});

test('滚动后才挂载的 fixed 浮层会在刷新时被发现并隐藏', () => {
  const fixture = makeGuardFixture();
  const dynamic = {
    style: new FakeStyle(),
    getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 40})
  };
  const originalStyle = fixture.getStyle;
  fixture.getStyle = element => element === dynamic
    ? {position: 'fixed'}
    : originalStyle(element);
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle,
    selectionStart: {x: 10, y: 120}
  });
  guard.prepare();
  guard.setRepeatedElementsVisible(false);

  // 页面可能在滚动后才挂载「回到底部」按钮或吸顶工具栏。
  fixture.ownerDocument.querySelectorAll = () => [fixture.fixed, fixture.sticky, dynamic];
  fixture.surfaceElement.scrollTop = 80;
  guard.refreshRepeatedElements();

  assert.equal(dynamic.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(dynamic.style.getPropertyPriority('visibility'), 'important');
  guard.restore();
  assert.equal(dynamic.style.getPropertyValue('visibility'), '');
});

test('shadow DOM 里的 fixed 浮层也会被发现并隐藏', () => {
  const fixture = makeGuardFixture();
  const shadowFixed = {
    style: new FakeStyle(),
    getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 40})
  };
  const shadowRoot = {querySelectorAll: () => [shadowFixed]};
  const host = {
    style: new FakeStyle(),
    shadowRoot,
    getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 40})
  };
  fixture.ownerDocument.querySelectorAll = () => [host];
  fixture.getStyle = element => element === shadowFixed
    ? {position: 'fixed'}
    : {position: 'static'};
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle
  });

  guard.prepare();
  guard.setRepeatedElementsVisible(false);

  assert.equal(shadowFixed.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(shadowFixed.style.getPropertyPriority('visibility'), 'important');
  assert.equal(shadowFixed.style.getPropertyValue('opacity'), '0');
  assert.equal(shadowFixed.style.getPropertyPriority('opacity'), 'important');
  guard.restore();
  assert.equal(shadowFixed.style.getPropertyValue('visibility'), '');
  assert.equal(shadowFixed.style.getPropertyValue('opacity'), '');
});

test('首帧是否保留浮层按确认时的覆盖关系判定，不受后续滚动位置影响', () => {
  const fixture = makeGuardFixture();
  // 确认时固定栏只覆盖屏幕顶部 0–40，选区起点在 120，明确不在栏内。
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle,
    selectionStart: {x: 10, y: 120}
  });
  guard.prepare();
  // 滚动后固定栏仍然停在顶部，但起点坐标已经滚出视口；不能因此把它算进选区。
  fixture.surfaceElement.scrollTop = 200;
  guard.setRepeatedElementsVisible(true);
  assert.equal(fixture.fixed.style.getPropertyValue('visibility'), 'hidden');
  guard.restore();
});

test('准备后才挂载、且覆盖起点的浮层不会在首帧被保留', () => {
  const fixture = makeGuardFixture();
  const dynamic = {
    style: new FakeStyle(),
    getBoundingClientRect: () => ({left: 0, top: 0, right: 40, bottom: 140})
  };
  const originalStyle = fixture.getStyle;
  fixture.getStyle = element => element === dynamic
    ? {position: 'fixed'}
    : originalStyle(element);
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle,
    selectionStart: {x: 10, y: 120}
  });
  guard.prepare();

  fixture.ownerDocument.querySelectorAll = () => [fixture.fixed, fixture.sticky, dynamic];
  fixture.surfaceElement.scrollTop = 200;
  guard.refreshRepeatedElements();
  guard.setRepeatedElementsVisible(true);

  assert.equal(dynamic.style.getPropertyValue('visibility'), 'hidden');
  guard.restore();
  assert.equal(dynamic.style.getPropertyValue('visibility'), '');
});

test('百分比和 calc sticky 偏移无法安全判定时保守不隐藏', () => {
  for (const top of ['10%', 'calc(10px + 1%)']) {
    const fixture = makeGuardFixture();
    fixture.surfaceElement.scrollTop = 30;
    fixture.getStyle = element => element === fixture.fixed ? {position: 'fixed'} : {position: 'sticky', top};
    const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
    guard.prepare();
    guard.setRepeatedElementsVisible(false);
    assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'visible');
  }
});

test('PageStateGuard capture 阶段在捕获期阻止完整指针交互但保留 Escape', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  const installed = fixture.listeners.map(([type]) => type);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click']) assert.ok(installed.includes(type));
  // 虚拟列表依赖 scroll 事件渲染，捕获期绝不能拦截它。
  assert.equal(installed.includes('scroll'), false);
  const pointer = fixture.listeners.find(([type]) => type === 'pointerdown')[1];
  let prevented = false;
  let stopped = false;
  pointer({type: 'pointerdown', preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; }});
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  const keydown = fixture.listeners.find(([type]) => type === 'keydown')[1];
  prevented = false;
  keydown({type: 'keydown', key: 'Escape', preventDefault: () => { prevented = true; }, stopImmediatePropagation() {}});
  assert.equal(prevented, false);
});

test('PageStateGuard 在内部容器的窗口视口变化时判为表面变化', () => {
  const fixture = makeGuardFixture();
  const windowSize = {width: 1000, height: 700};
  fixture.surface.getMetrics = () => ({
    scrollLeft: fixture.surfaceElement.scrollLeft,
    scrollTop: fixture.surfaceElement.scrollTop,
    clientWidth: fixture.surfaceElement.clientWidth,
    clientHeight: fixture.surfaceElement.clientHeight,
    scrollHeight: fixture.surfaceElement.scrollHeight,
    viewport: {left: 0, top: 0, width: 300, height: 200},
    visible: {left: 0, top: 0, width: 300, height: 200},
    window: {...windowSize}
  });
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  windowSize.width = 900;

  assert.throws(() => guard.assertStable(), error => error.code === 'SURFACE_CHANGED');
  guard.restore();
});

test('固定元素只有覆盖框选起点时才在首帧保留', () => {
  const atHeader = makeGuardFixture();
  const atHeaderGuard = new PageStateGuard({
    surface: atHeader.surface,
    document: atHeader.ownerDocument,
    getComputedStyle: atHeader.getStyle,
    selectionStart: {x: 10, y: 20}
  });
  atHeaderGuard.prepare();
  atHeaderGuard.setRepeatedElementsVisible(true);
  // 起点在固定栏内：恢复原始可见性
  assert.equal(atHeader.fixed.style.getPropertyValue('visibility'), 'collapse');
  atHeaderGuard.restore();

  const belowHeader = makeGuardFixture();
  const belowHeaderGuard = new PageStateGuard({
    surface: belowHeader.surface,
    document: belowHeader.ownerDocument,
    getComputedStyle: belowHeader.getStyle,
    selectionStart: {x: 10, y: 120}
  });
  belowHeaderGuard.prepare();
  belowHeaderGuard.setRepeatedElementsVisible(true);
  // 起点在固定栏下方：首帧也不能把固定栏截进去
  assert.equal(belowHeader.fixed.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(belowHeader.fixed.style.getPropertyPriority('visibility'), 'important');
  belowHeaderGuard.restore();
  assert.equal(belowHeader.fixed.style.getPropertyValue('visibility'), 'collapse');
});

test('sticky overlay outside an internal scroll surface is hidden when selection starts below it', () => {
  const fixture = makeGuardFixture();
  fixture.sticky.parentElement = null;
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle,
    selectionStart: {x: 10, y: 120}
  });
  guard.prepare();
  guard.setRepeatedElementsVisible(true);
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(fixture.sticky.style.getPropertyPriority('visibility'), 'important');
  guard.restore();
});

test('selection starting exactly at a fixed overlay bottom edge does not preserve it', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({
    surface: fixture.surface,
    document: fixture.ownerDocument,
    getComputedStyle: fixture.getStyle,
    selectionStart: {x: 10, y: 40}
  });
  guard.prepare();
  guard.setRepeatedElementsVisible(true);
  assert.equal(fixture.fixed.style.getPropertyValue('visibility'), 'hidden');
  guard.restore();
});

test('capture feedback 只在错误/提示时显示，捕获前隐藏（不再显示截屏进度）', () => {
  class Element {
    constructor(tagName = 'div') { this.tagName = tagName; this.style = {}; this.children = []; this.textContent = ''; }
    append(...items) {
      this.children.push(...items);
      this.textContent += items.map(item => item.textContent ?? '').join('');
    }
    remove() { this.removed = true; }
  }
  const root = new Element();
  const feedback = createCaptureFeedback({
    documentElement: root,
    createElement: tagName => new Element(tagName)
  });
  // 进度显示已移除：feedback 没有 showProgress
  assert.equal(typeof feedback.showProgress, 'undefined');
  assert.equal(feedback.host.style.visibility, 'hidden');
  feedback.hideForCapture();
  assert.equal(feedback.host.style.visibility, 'hidden');
  feedback.showError('页面内容发生变化，请重新截取');
  assert.equal(feedback.host.textContent, '页面内容发生变化，请重新截取');
  assert.equal(feedback.host.style.visibility, 'visible');
});
