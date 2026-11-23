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
  const feedback = {hideForCapture: () => events.push('hide'), remove: () => events.push('remove')};
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
  assert.deepEqual(events.slice(-6),
    ['fixed:false', 'hide', 'stable', 'stable', 'scroll:50', 'stable']);
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

test('RESTORE 成功后的同 task ERROR 仍会提示（清理失败时结果已被后台丢弃）', async () => {
  let feedbacks = 0;
  const handler = createCaptureMessageHandler({MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => { feedbacks += 1; return {remove() {}, showError() {}}; }, controller: {enterSelection() {}}, document: {}});
  handler.onCaptureRequested({taskId: 'task', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'task'});
  await handler.handle({type: MESSAGE.ERROR, taskId: 'task', payload: {code: 'CANCELLED'}});
  assert.equal(feedbacks, 2);
  // 同一任务只会被下一次截图重新激活；重复/迟到 ERROR 不再重复弹提示。
  await handler.handle({type: MESSAGE.ERROR, taskId: 'task', payload: {code: 'CANCELLED'}});
  assert.equal(feedbacks, 2);
});

test('CLIPBOARD_WRITE 写入剪贴板，失败映射为中文错误并拒绝过期任务', async () => {
  const calls = [];
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({remove() {}, showError() {}, showNotice() {}}),
    controller: {enterSelection() {}}, document: {},
    writeClipboard: async payload => {
      calls.push(payload);
      if (payload.dataUrl === 'bad') throw new Error('Document is not focused');
    }
  });
  handler.onCaptureRequested({taskId: 'task', selection: {}, surface: {restore() {}}, surfaceToken: 't'});

  assert.deepEqual(
    await handler.handle({type: MESSAGE.CLIPBOARD_WRITE, taskId: 'task', payload: {dataUrl: 'data:png'}}),
    {ok: true}
  );
  assert.deepEqual(calls, [{dataUrl: 'data:png'}]);

  await assert.rejects(
    handler.handle({type: MESSAGE.CLIPBOARD_WRITE, taskId: 'task', payload: {dataUrl: 'bad'}}),
    error => error.code === 'CAPTURE_FAILED' && error.message === '复制到剪贴板失败，请重试'
  );
  assert.equal(
    (await handler.handle({type: MESSAGE.CLIPBOARD_WRITE, taskId: 'other', payload: {}})).code,
    'STALE_TASK'
  );
  handler.dispose(); // 清掉看门狗定时器，避免测试结束后仍触发
});

test('截图完成并恢复页面后仍可写入剪贴板（复制发生在任务结束之后）', async () => {
  const calls = [];
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({remove() {}, showError() {}, showNotice() {}}),
    controller: {enterSelection() {}}, document: {},
    writeClipboard: async payload => calls.push(payload)
  });
  handler.onCaptureRequested({taskId: 'copy', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'copy'});

  assert.deepEqual(
    await handler.handle({type: MESSAGE.CLIPBOARD_WRITE, taskId: 'copy', payload: {dataUrl: 'data:png'}}),
    {ok: true}
  );
  assert.deepEqual(calls, [{dataUrl: 'data:png'}]);

  // 新任务开始后旧任务的剪贴板写入请求失效。
  handler.onCaptureRequested({taskId: 'next', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  assert.equal(
    (await handler.handle({type: MESSAGE.CLIPBOARD_WRITE, taskId: 'copy', payload: {}})).code,
    'STALE_TASK'
  );
  handler.dispose();
});

test('showNotice 显示一次性提示并在超时后自动移除', async () => {
  const events = [];
  let noticeTimer = null;
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({
      remove: () => events.push('remove'),
      showError: () => events.push('error'),
      showNotice: message => events.push(`notice:${message}`)
    }),
    controller: {enterSelection() {}}, document: {},
    setTimeout: (callback, ms) => { events.push(`timer:${ms}`); noticeTimer = callback; return 1; },
    clearTimeout: () => events.push('clear')
  });

  handler.showNotice('已复制到剪贴板');
  assert.deepEqual(events, ['notice:已复制到剪贴板', 'timer:2400']);
  noticeTimer();
  assert.equal(events.at(-1), 'remove');
});

test('恢复页面本身不产生任何提示（保存/复制提示由上层触发）', async () => {
  const events = [];
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({
      remove: () => events.push('remove'),
      showError: () => events.push('error'),
      showNotice: message => events.push(`notice:${message}`)
    }),
    controller: {enterSelection() {}}, document: {}
  });
  handler.onCaptureRequested({taskId: 'save', selection: {}, surface: {restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'save'});

  assert.deepEqual(events, ['remove']);
});

test('新提示会先清掉上一条提示的定时器', async () => {
  const events = [];
  const timers = [];
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({
      remove: () => events.push('remove'),
      showError: () => events.push('error'),
      showNotice: message => events.push(`notice:${message}`)
    }),
    controller: {enterSelection() {}}, document: {},
    setTimeout: (callback, ms) => { timers.push(callback); events.push(`timer:${ms}`); return timers.length; },
    clearTimeout: id => events.push(`clear:${id}`)
  });

  handler.showNotice('第一条');
  handler.showNotice('第二条');
  assert.deepEqual(events, [
    'notice:第一条', 'timer:2400', 'clear:1', 'notice:第二条', 'timer:2400'
  ]);
});

test('离屏拼接消息（COMPOSER_*）不被页面应答，避免抢答导致误判截图失败', async () => {
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: class {}, buildScrollTargets: () => [],
    createCaptureFeedback: () => ({remove() {}}),
    controller: {enterSelection() {}}, document: {}
  });
  handler.onCaptureRequested({taskId: 'task', selection: {}, surface: {restore() {}}, surfaceToken: 't'});

  for (const type of [MESSAGE.COMPOSER_BEGIN, MESSAGE.COMPOSER_ADD, MESSAGE.COMPOSER_FINISH,
    MESSAGE.COMPOSER_EXPORT, MESSAGE.COMPOSER_RELEASE, MESSAGE.COMPOSER_ABORT]) {
    assert.equal(
      await handler.handle({type, taskId: 'task', payload: {}}),
      undefined,
      `${type} 必须返回 undefined（不应答），否则会抢在离屏文档之前回 ok:false`
    );
  }
  // 页面自身消息仍正常应答
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    refreshRepeatedElements() {}
    setRepeatedElementsVisible() {}
    restore() {}
  }
  const prepared = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({hideForCapture() {}, remove() {}}),
    controller: {enterSelection() {}}, document: {},
    settleAfterScroll: async () => {}
  });
  prepared.onCaptureRequested({taskId: 'task2', selection: {top: 0, bottom: 50}, surface: {setScrollTop() {}, restore() {}}, surfaceToken: 't'});
  await prepared.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task2'});
  assert.equal((await prepared.handle({type: MESSAGE.SCROLL_TO, taskId: 'task2', payload: {top: 0}})).ok, true);
  handler.dispose();
  prepared.dispose();
});

test('SET_FIXED_VISIBILITY waits for the visibility change to be painted', async () => {
  const events = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    setRepeatedElementsVisible(visible) { events.push(`fixed:${visible}`); }
    restore() {}
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({hideForCapture: () => events.push('hide'), remove() {}}),
    controller: {enterSelection() {}}, document: {},
    settleAfterScroll: ({waitImages}) => {
      events.push(`settle:${waitImages}`);
      return Promise.resolve();
    }
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {setScrollTop() {}, restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  events.length = 0;

  const response = await handler.handle({type: MESSAGE.SET_FIXED_VISIBILITY, taskId: 'task', payload: {visible: false}});

  assert.deepEqual(events, ['fixed:false', 'hide', 'settle:false']);
  // 快门前的实际指标要带回后台，拼接按它裁剪。
  assert.deepEqual(response.metrics, {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}});
  assert.equal(response.surfaceToken, 't');
  handler.dispose();
});

test('SET_FIXED_VISIBILITY 在绘制后重新扫描并再次隐藏动态浮层', async () => {
  const events = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    setRepeatedElementsVisible(visible) { events.push(`fixed:${visible}`); }
    refreshRepeatedElements() { events.push('refresh'); }
    restore() {}
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({hideForCapture: () => events.push('hide'), remove() {}}),
    controller: {enterSelection() {}}, document: {},
    settleAfterScroll: ({waitImages}) => {
      events.push(`settle:${waitImages}`);
      return Promise.resolve();
    }
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {setScrollTop() {}, restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  events.length = 0;

  await handler.handle({type: MESSAGE.SET_FIXED_VISIBILITY, taskId: 'task', payload: {visible: false}});

  assert.deepEqual(events, ['fixed:false', 'hide', 'settle:false', 'refresh', 'fixed:false']);
  handler.dispose();
});

test('SCROLL_TO 在返回指标前依次等待两帧和有界布局稳定', async () => {
  const events = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { events.push('metrics'); return {scrollTop: 25, maxScrollTop: 100, viewport: {height: 50}}; }
    refreshRepeatedElements() { events.push('sticky'); }
    restore() {}
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0],
    createCaptureFeedback: () => ({hideForCapture() {}, remove() {}}),
    controller: {enterSelection() {}}, document: {},
    settleAfterScroll: async () => events.push('settled')
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {setScrollTop: top => events.push(`scroll:${top}`), restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  events.length = 0;
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'task', payload: {top: 25}});
  assert.deepEqual(events, ['metrics', 'scroll:25', 'settled', 'sticky', 'metrics']);
  handler.dispose();
});

test('默认滚动稳定器先等两帧，再以 300ms 上限等待未完成图片', async () => {
  const events = [];
  const image = {complete: false, addEventListener() {}};
  await waitForScrollSettle({
    document: {querySelectorAll: () => [image]},
    requestAnimationFrame: callback => { events.push('frame'); callback(); },
    setTimeout: (callback, delay) => { events.push(`timer:${delay}`); callback(); return 1; },
    clearTimeout: () => events.push('clear')
  });
  assert.deepEqual(events, ['frame', 'frame', 'timer:300']);
});

test('waitImages=false 时跳过图片等待，只等两帧（后续屏提速）', async () => {
  const events = [];
  let queried = 0;
  await waitForScrollSettle({
    document: {querySelectorAll: () => { queried += 1; return [{complete: false, addEventListener() {}}]; }},
    requestAnimationFrame: callback => { events.push('frame'); callback(); },
    waitImages: false
  });
  assert.deepEqual(events, ['frame', 'frame']);
  assert.equal(queried, 0, '跳过图片等待时不应扫描 DOM');
});

test('SCROLL_TO 只在首屏等待图片，后续屏跳过', async () => {
  const settleOptions = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    refreshRepeatedElements() {}
    setRepeatedElementsVisible() {}
    restore() {}
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard, buildScrollTargets: () => [0, 50, 100],
    createCaptureFeedback: () => ({hideForCapture() {}, remove() {}}),
    controller: {enterSelection() {}}, document: {},
    settleAfterScroll: options => { settleOptions.push(options); return Promise.resolve(); }
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 150}, surface: {setScrollTop() {}, restore() {}}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'task', payload: {top: 0}});
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'task', payload: {top: 50}});
  await handler.handle({type: MESSAGE.SCROLL_TO, taskId: 'task', payload: {top: 100}});

  assert.deepEqual(settleOptions, [{waitImages: true}, {waitImages: false}, {waitImages: false}]);
  handler.dispose();
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

test('主动重新进入选择态时，不把后台补发的 CANCELLED 错误盖在新选框上', async () => {
  const events = [];
  let feedbacks = 0;
  const metrics = {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}};
  class Guard {
    prepare() { return metrics; }
    assertStable() { return metrics; }
    restore() { events.push('guardRestore'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard,
    createCaptureFeedback: () => {
      feedbacks += 1;
      return {remove() {}, showError: message => events.push(`error:${message}`)};
    },
    controller: {enterSelection: () => events.push('enter')}, document: {},
    sendMessage: () => Promise.resolve({ok: true, cancelled: true})
  });
  handler.onCaptureRequested({taskId: 'capturing', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'capturing'});

  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  await handler.handle({type: MESSAGE.RESTORE_PAGE, taskId: 'capturing', payload: {expectError: true}});
  await handler.handle({type: MESSAGE.ERROR, taskId: 'capturing', payload: {code: 'CANCELLED'}});

  assert.equal(feedbacks, 1, '只应创建截图期间的 feedback，不应再创建错误提示');
  assert.equal(events.includes('enter'), true);
  assert.equal(events.some(event => event.startsWith('error:')), false);
  handler.dispose();
});

test('后台已丢失任务时取消回执为 cancelled:false，页面立即本地解锁', async () => {
  const events = [];
  const metrics = {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}};
  class Guard {
    prepare() { return metrics; }
    assertStable() { return metrics; }
    restore() { events.push('guardRestore'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard,
    createCaptureFeedback: () => ({remove: () => events.push('feedbackRemove'), hideForCapture() {}}),
    controller: {enterSelection: () => events.push('enter')}, document: {},
    sendMessage: () => Promise.resolve({ok: true, cancelled: false})
  });
  handler.onCaptureRequested({taskId: 'capturing', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'capturing'});
  events.length = 0;

  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['guardRestore', 'surfaceRestore', 'feedbackRemove', 'enter']);
  handler.dispose();
});

test('取消消息通道断开时页面立即本地解锁，不等看门狗', async () => {
  const events = [];
  const metrics = {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}};
  class Guard {
    prepare() { return metrics; }
    assertStable() { return metrics; }
    restore() { events.push('guardRestore'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard,
    createCaptureFeedback: () => ({remove: () => events.push('feedbackRemove'), hideForCapture() {}}),
    controller: {enterSelection: () => events.push('enter')}, document: {},
    sendMessage: () => Promise.reject(new Error('Extension context invalidated'))
  });
  handler.onCaptureRequested({taskId: 'capturing', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'capturing'});
  events.length = 0;

  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['guardRestore', 'surfaceRestore', 'feedbackRemove', 'enter']);
  handler.dispose();
});

test('cancelTask 在后台回答 cancelled:false 时立即释放本地页面状态', async () => {
  const events = [];
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    restore() { events.push('guardRestore'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard,
    createCaptureFeedback: () => ({remove: () => events.push('feedbackRemove'), hideForCapture() {}}),
    controller: {enterSelection: () => events.push('enter')}, document: {},
    sendMessage: () => Promise.resolve({ok: true, cancelled: false})
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  events.length = 0;

  handler.cancelTask('task');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['guardRestore', 'surfaceRestore', 'feedbackRemove']);
  handler.dispose();
});

test('看门狗超时后若有待进入选择态则恢复页面并重新进入选择', async () => {
  const events = [];
  let watchdog = null;
  class Guard {
    prepare() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    assertStable() { return {scrollTop: 0, maxScrollTop: 100, viewport: {height: 50}}; }
    restore() { events.push('guardRestore'); }
  }
  const handler = createCaptureMessageHandler({
    MESSAGE, PageStateGuard: Guard,
    createCaptureFeedback: () => ({
      remove: () => events.push('feedbackRemove'),
      hideForCapture() {},
      showError: message => events.push(`error:${message}`)
    }),
    controller: {enterSelection: () => events.push('enter')}, document: {},
    setTimeout: (callback, ms) => {
      if (ms >= 120_000) watchdog = callback;
      return 1;
    },
    clearTimeout: () => {}
  });
  handler.onCaptureRequested({taskId: 'task', selection: {top: 0, bottom: 50},
    surface: {restore: () => events.push('surfaceRestore')}, surfaceToken: 't'});
  await handler.handle({type: MESSAGE.PREPARE_CAPTURE, taskId: 'task'});
  await handler.handle({type: MESSAGE.ENTER_SELECTION});
  assert.ok(watchdog, '应注册截图看门狗');
  events.length = 0;

  watchdog();

  assert.deepEqual(events, ['guardRestore', 'surfaceRestore', 'feedbackRemove', 'enter']);
  handler.dispose();
});

test('真实截图调用前 SCROLL_TO 与 SET_FIXED_VISIBILITY 会保持反馈隐藏', async () => {
  const events = [];
  const metrics = {scrollLeft: 0, scrollTop: 0, maxScrollTop: 0, clientHeight: 50,
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
  assert.deepEqual(events.slice(0, 5), [
    MESSAGE.PREPARE_CAPTURE, MESSAGE.SCROLL_TO, MESSAGE.SET_FIXED_VISIBILITY,
    'feedbackHide', 'capture'
  ]);
});
