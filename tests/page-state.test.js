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

  guard.restore();
  assert.equal(fixture.surfaceElement.scrollLeft, 13);
  assert.equal(fixture.surfaceElement.scrollTop, 27);
  assert.equal(fixture.surfaceElement.style.getPropertyValue('scroll-behavior'), 'smooth');
  assert.equal(fixture.surfaceElement.style.getPropertyPriority('scroll-behavior'), 'important');
  assert.equal(fixture.fixed.style.getPropertyValue('visibility'), 'collapse');
  assert.equal(fixture.fixed.style.getPropertyPriority('visibility'), 'important');
  assert.equal(fixture.sticky.style.getPropertyValue('visibility'), 'visible');
  assert.equal(fixture.sticky.style.getPropertyPriority('visibility'), 'important');
  assert.equal(fixture.listeners.filter(item => item[0] === 'remove').length, 9);
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

test('PageStateGuard 在滚动区域尺寸明显变化时拒绝继续截取', () => {
  const fixture = makeGuardFixture();
  const guard = new PageStateGuard({surface: fixture.surface, document: fixture.ownerDocument, getComputedStyle: fixture.getStyle});
  guard.prepare();
  fixture.surfaceElement.scrollHeight += 11;
  assert.throws(() => guard.assertStable(), error => error.code === 'SURFACE_CHANGED');
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

test('capture feedback 在滚动等待期显示进度并在捕获前隐藏', () => {
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
  feedback.showProgress(2, 5);
  assert.equal(feedback.host.style.visibility, 'visible');
  assert.equal(feedback.host.textContent, '正在截取 2/5 屏');
  feedback.showProgress(9, 5);
  assert.equal(feedback.host.textContent, '正在截取 5/5 屏');
  feedback.hideForCapture();
  assert.equal(feedback.host.style.visibility, 'hidden');
  feedback.showError('页面内容发生变化，请重新截取');
  assert.equal(feedback.host.textContent, '页面内容发生变化，请重新截取');
  assert.equal(feedback.host.style.visibility, 'visible');
});
