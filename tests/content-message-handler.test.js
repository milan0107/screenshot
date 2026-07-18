import assert from 'node:assert/strict';
import test from 'node:test';
import {createCaptureMessageHandler, waitForScrollSettle} from '../src/content/capture-message-handler.js';
import {runCapture} from '../src/background/capture-controller.js';
import {MESSAGE} from '../src/shared/protocol.js';

test('生产消息处理器确认 active/stale restore，拒绝 stale 改动并在滚动前隐藏反馈', async () => {
  const events = [];
  class Guard {
    constructor() { this.metrics = {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    prepare() { events.push('prepare'); return this.metrics; }
    assertStable() { events.push('stable'); return this.metrics; }
    setRepeatedElementsVisible(value) { events.push(`fixed:${value}`); }
    restore() { events.push('restore'); }
  }
  const feedback = {showProgress: () => events.push('progress'), hideForCapture: () => events.push('hide'), remove: () => events.push('remove')};
  const surface = {setScrollTop: top => { events.push(`scroll:${top}`); }, restore: () => events.push('surfaceRestore')};
  const handler = createCaptureMessageHandler({MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0, 50],
    createCaptureFeedback: () => feedback, controller: {enterSelection() {}}, document: {}});
  handler.onCaptureRequested({taskId: 'active', selection: {top: 0, bottom: 100}, surface, surfaceToken: 'token'});
  assert.equal((await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'stale'})).ok, true);
  assert.deepEqual(events, []);
  assert.equal((await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'stale'})).code, 'STALE_TASK');
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'active'});
  await handler.handle({type: MESSAGE.SET_FIXED_VISIBILITY, taskId: 'active', payload: {visible: false}});
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'active', payload: {top: 50}});
  assert.deepEqual(events.slice(-7), ['fixed:false', 'progress', 'hide', 'stable', 'hide', 'scroll:50', 'stable']);
  assert.equal((await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'active'})).ok, true);
  assert.ok(events.includes('restore'));
});

test('仅 RESTORE(expectError) 为同 task 的一次迟到 ERROR 创建 passive feedback', async () => {
  let feedbacks = 0;
  const handler = createCaptureMessageHandler({MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => { feedbacks += 1; return {remove() {}, showError() {}}; }, controller: {enterSelection() {}}, document: {}});
  handler.onCaptureRequested({taskId: 'task', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'task', payload: {expectError: true}});
  assert.equal(feedbacks, 1);
  await handler.handle({type: MESSAGE.ERROR, taskId: 'task', payload: {code: 'CANCELLED'}});
  assert.equal(feedbacks, 2);
  await handler.handle({type: MESSAGE.ERROR, taskId: 'task', payload: {code: 'CANCELLED'}});
  await handler.handle({type: MESSAGE.ERROR, taskId: 'other', payload: {code: 'CANCELLED'}});
  assert.equal(feedbacks, 2);
});

test('RESTORE 未声明错误时会抑制同 task 的迟到 ERROR', async () => {
  let feedbacks = 0;
  const handler = createCaptureMessageHandler({MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => { feedbacks += 1; return {remove() {}, showError() {}}; }, controller: {enterSelection() {}}, document: {}});
  handler.onCaptureRequested({taskId: 'task', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'task'});
  await handler.handle({type: MESSAGE.ERROR, taskId: 'task', payload: {code: 'CANCELLED'}});
  assert.equal(feedbacks, 1);
});

test('SCROLL_TO 在返回指标前依次等待两帧和有界布局稳定', async () => {
  const events = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { events.push('metrics'); return {scrollTop: 25, maxScrollTop: 100, viewport: {height: 50}}; }
    refreshRepeatedElements() { events.push('sticky'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({hideForCapture() {}, remove() {}}), controller: {enterSelection() {}}, document: {},
    settleAfterScroll: async () => events.push('settled')
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {setScrollTop: top => events.push(`scroll:${top}`)}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  events.length = 0;
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'task', payload: {top: 25}});
  assert.deepEqual(events, ['metrics', 'scroll:25', 'settled', 'sticky', 'metrics']);
});

test('默认滚动稳定器先等待两帧，再以一秒上限等待未完成图片', async () => {
  const events = [];
  const image = {complete: false, addEventListener() {}};
  await waitForScrollSettle({
    document: {querySelectorAll: () => [image]},
    requestAnimationFrame: callback => { events.push('frame'); callback(); },
    setTimeout: (callback, delay) => { events.push(`timer:${delay}`); callback(); return 1; },
    clearTimeout: () => events.push('clear')
  });
  assert.deepEqual(events, ['frame', 'frame', 'timer:1000']);
});

test('已确认捕获时再次进入选择态会等 RESTORE_PAGE 后再恢复并开始新选择', async () => {
  const events = [];
  const metrics = {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}};
  class Guard {
    prepare() { events.push('prepare'); return metrics; }
    assertStable() { return metrics; }
    restore() { events.push('guardRestore'); }
  }
  const feedback = {
    remove: () => events.push('feedbackRemove'),
    showProgress: () => events.push('feedbackShow'),
    hideForCapture: () => events.push('feedbackHide')
  };
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => feedback,
    controller: {enterSelection: () => events.push('enter')}, document: {},
    sendMessage: message => events.push(`cancel:${message.taskId}`)
  });
  handler.onCaptureRequested({taskId: 'capturing', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'capturing'});
  events.length = 0;

  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  assert.deepEqual(events, ['cancel:capturing']);
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'capturing'});
  assert.deepEqual(events, ['cancel:capturing', 'guardRestore', 'surfaceRestore', 'feedbackRemove', 'enter']);
});

test('真实截图调用前 SCROLL_TO 与 SET_FIXED_VISIBILITY 会保持反馈隐藏', async () => {
  const events = [];
  const metrics = {scrollLeft: 0, scrollTop: 0, maxScrollTop: 0,
    viewport: {left: 0, top: 0, width: 50, height: 50}};
  let feedbackVisible = false;
  class Guard {
    prepare() { return metrics; }
    assertStable() { return metrics; }
    setRepeatedElementsVisible() {}
    restore() {}
  }
  const handler = createCaptureMessageHandler({MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({
      showProgress: () => { feedbackVisible = true; events.push('feedbackShow'); },
      hideForCapture: () => { feedbackVisible = false; events.push('feedbackHide'); },
      remove() {}
    }),
    controller: {enterSelection() {}}, document: {}, settleAfterScroll: async () => {}});
  handler.onCaptureRequested({taskId: 'task', selection: {left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50},
    surface: {setScrollTop() {}, restore() {}}, surfaceToken: 't'});

  await runCapture({taskId: 'task', tabId: 7, windowId: 3}, {
    isActiveTab: async () => true,
    sendTab: async (_tabId, message) => { events.push(message.type); return handler.handle(message); },
    captureVisible: async () => {
      events.push('capture');
      assert.equal(feedbackVisible, false);
      return 'data:image/png';
    },
    sendOffscreen: async message => {
      if (message.type === MESSAGE.COMPOSER_BEGIN) return {ok: true, scaleX: 1, scaleY: 1};
      if (message.type === MESSAGE.COMPOSER_FINISH) return {ok: true, objectUrl: 'blob:shot'};
      return {ok: true};
    },
    download: async () => {},
    sleep: async () => {}, setTimeout: () => 1, clearTimeout: () => {}, formatTimestamp: () => 'test'
  });

  assert.deepEqual(events.filter(event => [
    MESSAGE.SCROLL_TO, MESSAGE.SET_FIXED_VISIBILITY, 'capture'
  ].includes(event)), [
    MESSAGE.SCROLL_TO, MESSAGE.SET_FIXED_VISIBILITY, 'capture'
  ]);
  assert.deepEqual(events.slice(0, 7), [
    MESSAGE.PREPARE_CAPTURE, MESSAGE.SCROLL_TO, 'feedbackHide', MESSAGE.SET_FIXED_VISIBILITY,
    'feedbackShow', 'feedbackHide', 'capture'
  ]);
});
