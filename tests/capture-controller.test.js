import assert from 'node:assert/strict';
import test from 'node:test';

import {runCapture} from '../src/background/capture-controller.js';
import {
  createCaptureCoordinator, createChromeCaptureDeps, createHighQualitySessionManager,
  ERROR_MESSAGES, registerServiceWorker
} from '../src/background/service-worker.js';
import {ERROR_CODE, MESSAGE} from '../src/shared/protocol.js';

const selection = {left: 10, top: 100, right: 210, bottom: 1700, width: 200, height: 1600};
const metrics = {
  scrollLeft: 0, scrollTop: 0, maxScrollTop: 1100,
  viewport: {left: 0, top: 0, width: 800, height: 600}
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function makeHarness(overrides = {}) {
  const events = [];
  const messages = [];
  let now = 0;
  const sendTab = async (_tabId, message) => {
    messages.push(message);
    if (message.type === MESSAGE.PREPARE_CAPTURE) {
      events.push('prepare');
      return {ok: true, selection, metrics, surfaceToken: 'surface-1', fixedElements: ['fixed-1']};
    }
    if (message.type === MESSAGE.SCROLL_TO) {
      events.push('scroll');
      return {ok: true, metrics: {...metrics, scrollTop: message.payload.top}, surfaceToken: 'surface-1'};
    }
    if (message.type === MESSAGE.SET_FIXED_VISIBILITY) {
      events.push(`fixed:${message.payload.visible}`);
      return {ok: true};
    }
    if (message.type === MESSAGE.RESTORE_PAGE) {
      events.push('restore');
      return {ok: true};
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  const sendOffscreen = async message => {
    messages.push(message);
    const names = {
      [MESSAGE.COMPOSER_BEGIN]: 'composerBegin',
      [MESSAGE.COMPOSER_ADD]: 'composerAdd',
      [MESSAGE.COMPOSER_FINISH]: 'composerFinish',
      [MESSAGE.COMPOSER_RELEASE]: 'composerRelease',
      [MESSAGE.COMPOSER_ABORT]: 'composerAbort'
    };
    events.push(names[message.type]);
    if (message.type === MESSAGE.COMPOSER_BEGIN) {
      return {ok: true, scaleX: 2, scaleY: 2, width: 400, height: 3200};
    }
    if (message.type === MESSAGE.COMPOSER_FINISH) return {ok: true, objectUrl: 'blob:shot'};
    return {ok: true};
  };
  const deps = {
    isActiveTab: async () => true,
    sendTab,
    captureVisible: async () => { events.push('capture'); return `data:${now}`; },
    sendOffscreen,
    download: async args => {
      events.push('download');
      assert.deepEqual(args, {
        url: 'blob:shot',
        filename: 'longshot-20260716-120102.png',
        saveAs: true
      });
    },
    now: () => now,
    sleep: async ms => { events.push(`sleep:${ms}`); now += ms; },
    getZoom: async tabId => { events.push(`getZoom:${tabId}`); return 1; },
    setZoom: async (tabId, factor) => { events.push(`setZoom:${tabId}:${factor}`); },
    setTimeout: () => ({fake: true}),
    clearTimeout: () => {},
    formatTimestamp: () => '20260716-120102',
    ...overrides
  };
  return {deps, events, messages, setNow: value => { now = value; }};
}

test('首帧按 begin 再 add 编排，成功后下载、release 并恢复页面', async () => {
  const {deps, events, messages} = makeHarness();
  const result = await runCapture({taskId: 'task-1', tabId: 7, windowId: 3}, deps);

  assert.deepEqual(events, [
    'prepare', 'scroll', 'fixed:true', 'capture', 'composerBegin', 'composerAdd',
    'scroll', 'fixed:false', 'sleep:550', 'capture', 'composerAdd',
    'scroll', 'fixed:false', 'sleep:550', 'capture', 'composerAdd',
    'composerFinish', 'download', 'composerRelease', 'restore'
  ]);
  assert.equal(result.filename, 'longshot-20260716-120102.png');
  const begin = messages.find(message => message.type === MESSAGE.COMPOSER_BEGIN);
  assert.equal(begin.payload.firstDataUrl, 'data:0');
  assert.deepEqual(begin.payload, {
    cssWidth: 200, cssHeight: 1600, firstDataUrl: 'data:0', innerWidth: 800, innerHeight: 600
  });
  const adds = messages.filter(message => message.type === MESSAGE.COMPOSER_ADD);
  assert.equal(adds.length, 3);
  assert.equal(adds[0].payload.dataUrl, 'data:0');
  assert.deepEqual(adds[0].payload.placement, {
    sx: 20, sy: 0, sw: 400, sh: 1200,
    dx: 0, dy: 0, dw: 400, dh: 1200
  });
});

test('高清模式会在截图前提高 tab zoom，并在成功后恢复原 zoom', async () => {
  const harness = makeHarness({
    getZoom: async tabId => {
      harness.events.push(`getZoom:${tabId}`);
      return 1.25;
    },
    setZoom: async (tabId, factor) => {
      harness.events.push(`setZoom:${tabId}:${factor}`);
    }
  });

  await runCapture({taskId: 'task-high-quality', tabId: 7, windowId: 3, highQuality: true}, harness.deps);

  assert.ok(harness.events.indexOf('getZoom:7') < harness.events.indexOf('setZoom:7:1.5'));
  assert.ok(harness.events.indexOf('setZoom:7:1.5') < harness.events.indexOf('prepare'));
  assert.ok(harness.events.indexOf('restore') < harness.events.lastIndexOf('setZoom:7:1.25'));
});

test('高清模式截图失败时仍恢复原 zoom 并保留原始错误', async () => {
  const harness = makeHarness({
    getZoom: async tabId => {
      harness.events.push(`getZoom:${tabId}`);
      return 0.9;
    },
    setZoom: async (tabId, factor) => {
      harness.events.push(`setZoom:${tabId}:${factor}`);
    },
    captureVisible: async () => {
      harness.events.push('capture');
      throw new Error('high quality capture failed');
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-high-quality-fail', tabId: 7, windowId: 3, highQuality: true}, harness.deps),
    error => error.code === ERROR_CODE.CAPTURE_FAILED && error.message === 'high quality capture failed'
  );
  assert.ok(harness.events.includes('setZoom:7:1.5'));
  assert.ok(harness.events.indexOf('restore') < harness.events.lastIndexOf('setZoom:7:0.9'));
});

test('高清缩放在后台重启后仍可用原缩放取消', async () => {
  const calls = [];
  const sessions = createHighQualitySessionManager({
    getZoom: async tabId => { calls.push(['getZoom', tabId]); return 1.25; },
    setZoom: async (tabId, zoom) => { calls.push(['setZoom', tabId, zoom]); }
  });

  const session = await sessions.enable(7);
  const restartedSessions = createHighQualitySessionManager({
    getZoom: async tabId => { calls.push(['restartedGetZoom', tabId]); return 1.5; },
    setZoom: async (tabId, zoom) => { calls.push(['setZoom', tabId, zoom]); }
  });
  await restartedSessions.restore(7, session.originalZoom);

  assert.deepEqual(calls, [
    ['getZoom', 7], ['setZoom', 7, 1.5], ['setZoom', 7, 1.25]
  ]);
});

test('选择阶段已开启高清时只在清理阶段恢复原缩放', async () => {
  const harness = makeHarness();
  await runCapture({
    taskId: 'task-hq-reselected', tabId: 7, windowId: 3,
    highQuality: true, restoreZoomTo: 1.25
  }, harness.deps);

  assert.equal(harness.events.includes('setZoom:7:1.5'), false);
  assert.ok(harness.events.indexOf('restore') < harness.events.lastIndexOf('setZoom:7:1.25'));
});

test('高清会话在截图启动前标签页失活时仍恢复原缩放', async () => {
  const harness = makeHarness({isActiveTab: async () => false});
  await assert.rejects(
    runCapture({
      taskId: 'task-hq-stale', tabId: 7, windowId: 3,
      highQuality: true, restoreZoomTo: 1.25
    }, harness.deps)
  );

  assert.ok(harness.events.includes('setZoom:7:1.25'));
});

test('协调器会启动已排队但被取消的任务以执行其清理链', async () => {
  const captured = [];
  const first = deferred();
  const firstStarted = deferred();
  const coordinator = createCaptureCoordinator({
    createDeps: () => ({}),
    capture: async request => {
      captured.push({taskId: request.taskId, aborted: request.signal.aborted});
      if (request.taskId === 'first') {
        firstStarted.resolve();
        await first.promise;
      }
      if (request.signal.aborted) throw request.signal.reason;
    }
  });

  const firstCapture = coordinator.start({taskId: 'first'});
  await firstStarted.promise;
  const secondCapture = coordinator.start({taskId: 'second', restoreZoomTo: 1.25});
  const thirdCapture = coordinator.start({taskId: 'third'});
  first.resolve();

  await Promise.allSettled([firstCapture, secondCapture, thirdCapture]);
  assert.deepEqual(captured.map(entry => entry.taskId), ['first', 'second', 'third']);
  assert.equal(captured[1].aborted, true);
});

test('用户取消另存为时正常 release 并恢复页面，不报告截图失败', async () => {
  const harness = makeHarness({
    download: async () => {
      harness.events.push('download');
      throw new Error('USER_CANCELED');
    }
  });

  await assert.doesNotReject(
    runCapture({taskId: 'task-save-cancel', tabId: 7, windowId: 3}, harness.deps)
  );
  assert.deepEqual(harness.events.slice(-4), [
    'composerFinish', 'download', 'composerRelease', 'restore'
  ]);
});

test('截图生成超时在打开另存为窗口前停止', async () => {
  const harness = makeHarness({
    clearTimeout: () => { harness.events.push('timeoutCleared'); },
    download: async () => {
      assert.equal(harness.events.at(-1), 'timeoutCleared');
      harness.events.push('download');
    }
  });

  await runCapture({taskId: 'task-save-timeout', tabId: 7, windowId: 3}, harness.deps);
  assert.ok(harness.events.indexOf('timeoutCleared') < harness.events.indexOf('download'));
});

test('每次可视区截图调用至少相隔 550ms', async () => {
  const captureTimes = [];
  const harness = makeHarness();
  harness.deps.captureVisible = async () => {
    captureTimes.push(harness.deps.now());
    harness.events.push('capture');
    return 'data:image/png';
  };

  await runCapture({taskId: 'task-throttle', tabId: 7, windowId: 3}, harness.deps);
  assert.equal(captureTimes.length, 3);
  for (let index = 1; index < captureTimes.length; index += 1) {
    assert.ok(captureTimes[index] - captureTimes[index - 1] >= 550);
  }
});

test('实际滚动位置可有亚像素或底部钳制偏差，且允许小幅内容高度漂移', async () => {
  const harness = makeHarness();
  const baseSendTab = harness.deps.sendTab;
  harness.deps.sendTab = async (tabId, message) => {
    if (message.type === MESSAGE.PREPARE_CAPTURE) {
      const response = await baseSendTab(tabId, message);
      return {...response, metrics: {...response.metrics, scrollHeight: 1700}};
    }
    if (message.type === MESSAGE.SCROLL_TO) {
      const response = await baseSendTab(tabId, message);
      return {...response, metrics: {...response.metrics,
        scrollTop: Math.min(message.payload.top - 0.25, 1099.5),
        maxScrollTop: 1102,
        scrollHeight: 1703
      }};
    }
    return baseSendTab(tabId, message);
  };

  await assert.doesNotReject(runCapture({taskId: 'task-actual-scroll', tabId: 7, windowId: 3}, harness.deps));
  assert.equal(harness.events.includes('download'), true);
});

test('截图失败会 abort composer，且 finally 最后恢复页面', async () => {
  let captures = 0;
  const {deps, events} = makeHarness({
    captureVisible: async () => {
      events.push('capture');
      if (++captures === 2) throw new Error('capture exploded');
      return 'data:first';
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-fail', tabId: 7, windowId: 3}, deps),
    error => error.code === ERROR_CODE.CAPTURE_FAILED && /capture exploded/.test(error.message)
  );
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('composer abort 的有界清理完成前不会开始恢复页面', async () => {
  let captures = 0;
  let releaseAbortCleanup;
  const abortCleanup = new Promise(resolve => { releaseAbortCleanup = resolve; });
  const {deps, events} = makeHarness({
    captureVisible: async () => {
      events.push('capture');
      if (++captures === 2) throw new Error('capture exploded');
      return 'data:first';
    },
    cleanupTimeout: async (promise, label) => {
      events.push(`cleanup:${label}`);
      if (label === 'composerAbort') await abortCleanup;
      return promise;
    }
  });

  const pending = runCapture({taskId: 'task-serial-cleanup', tabId: 7, windowId: 3}, deps);
  for (let attempt = 0; attempt < 20 && !events.includes('cleanup:composerAbort'); attempt += 1) {
    await Promise.resolve();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes('restore'), false);
  releaseAbortCleanup();
  await assert.rejects(pending, error => error.code === ERROR_CODE.CAPTURE_FAILED);
  assert.ok(events.indexOf('cleanup:composerAbort') < events.indexOf('restore'));
});

test('恢复页面自身失败时不覆盖原始 typed error', async () => {
  const harness = makeHarness();
  const baseSendTab = harness.deps.sendTab;
  harness.deps.captureVisible = async () => {
    harness.events.push('capture');
    throw new Error('capture exploded');
  };
  harness.deps.sendTab = async (tabId, message) => {
    const response = await baseSendTab(tabId, message);
    if (message.type === MESSAGE.RESTORE_PAGE) throw new Error('restore exploded');
    return response;
  };

  await assert.rejects(
    runCapture({taskId: 'task-double-fail', tabId: 7, windowId: 3}, harness.deps),
    error => error.code === ERROR_CODE.CAPTURE_FAILED && error.message === 'capture exploded'
  );
  assert.deepEqual(harness.events.slice(-2), ['composerAbort', 'restore']);
});

test('活动标签变化时取消任务、abort 并恢复', async () => {
  let checks = 0;
  const {deps, events} = makeHarness({isActiveTab: async () => ++checks < 4});

  await assert.rejects(
    runCapture({taskId: 'task-stale', tabId: 7, windowId: 3}, deps),
    error => error.code === ERROR_CODE.STALE_TASK
  );
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('captureVisible 执行期间标签切换时不添加错误帧或下载', async () => {
  let active = true;
  const {deps, events, messages} = makeHarness({
    isActiveTab: async () => active,
    captureVisible: async () => {
      events.push('capture');
      active = false;
      return 'data:wrong-tab';
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-tab-switch', tabId: 7, windowId: 3}, deps),
    error => error.code === ERROR_CODE.STALE_TASK
  );
  assert.equal(messages.some(message => message.type === MESSAGE.COMPOSER_ADD), false);
  assert.equal(events.includes('download'), false);
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('60 秒超时信号会在 awaited 操作之间终止任务', async () => {
  let timeoutCallback;
  const {deps, events} = makeHarness({
    setTimeout: callback => { timeoutCallback = callback; return 1; },
    sendTab: async (tabId, message) => {
      if (message.type === MESSAGE.PREPARE_CAPTURE) {
        events.push('prepare');
        timeoutCallback();
        return {ok: true, selection, metrics, surfaceToken: 'surface-1'};
      }
      if (message.type === MESSAGE.RESTORE_PAGE) { events.push('restore'); return {ok: true}; }
      throw new Error(`unexpected ${tabId}:${message.type}`);
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-timeout', tabId: 7, windowId: 3}, deps),
    error => error.code === ERROR_CODE.TIMEOUT
  );
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('offscreen 初始化永挂时仍受 60 秒超时约束并执行清理', async () => {
  let timeoutCallback;
  const {deps, events} = makeHarness({
    setTimeout: callback => { timeoutCallback = callback; return 1; },
    prepareEnvironment: () => {
      events.push('prepareEnvironment');
      return new Promise(() => {});
    }
  });

  const pending = runCapture({taskId: 'task-env-timeout', tabId: 7, windowId: 3}, deps);
  for (let attempt = 0; attempt < 20 && !events.includes('prepareEnvironment'); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(events.includes('prepareEnvironment'), true);
  timeoutCallback();
  await assert.rejects(pending, error => error.code === ERROR_CODE.TIMEOUT);
  assert.deepEqual(events, ['prepareEnvironment', 'composerAbort', 'restore']);
});

test('offscreen 初始化期间标签失活时不触碰页面或开始 composer', async () => {
  let active = true;
  const environment = deferred();
  const environmentStarted = deferred();
  const {deps, events, messages} = makeHarness({
    isActiveTab: async () => active,
    prepareEnvironment: () => {
      environmentStarted.resolve();
      return environment.promise;
    }
  });
  const pending = runCapture({taskId: 'task-env-tab-switch', tabId: 7, windowId: 3}, deps);
  await environmentStarted.promise;
  active = false;
  environment.resolve();

  await assert.rejects(pending, error => error.code === ERROR_CODE.STALE_TASK);
  assert.equal(events.includes('prepare'), false);
  assert.equal(messages.some(message => message.type === MESSAGE.PREPARE_CAPTURE), false);
  assert.equal(messages.some(message => message.type === MESSAGE.SCROLL_TO), false);
  assert.equal(messages.some(message => [
    MESSAGE.COMPOSER_BEGIN, MESSAGE.COMPOSER_ADD, MESSAGE.COMPOSER_FINISH
  ].includes(message.type)), false);
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('Chrome API 一直不返回时，60 秒超时仍会立即终止任务', async () => {
  let timeoutCallback;
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const {deps, events} = makeHarness({
    setTimeout: callback => { timeoutCallback = callback; return 1; },
    captureVisible: () => {
      events.push('capture');
      captureStarted();
      return new Promise(() => {});
    }
  });
  const pending = runCapture({taskId: 'task-hung', tabId: 7, windowId: 3}, deps);
  await started;
  timeoutCallback();

  await assert.rejects(pending, error => error.code === ERROR_CODE.TIMEOUT);
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('abort 与 restore 均永挂时仍各自被调用，且有限时间内保留原始错误返回', async () => {
  const cleanupCalls = [];
  let resolveLateCapture;
  const lateCapture = new Promise(resolve => { resolveLateCapture = resolve; });
  let timeoutCallback;
  const {deps, events, messages} = makeHarness({
    setTimeout: callback => { timeoutCallback = callback; return 1; },
    cleanupTimeout: promise => Promise.race([promise, Promise.resolve('cleanup-timeout')]),
    captureVisible: () => {
      events.push('capture');
      return lateCapture;
    }
  });
  const baseSendOffscreen = deps.sendOffscreen;
  deps.sendOffscreen = message => {
    if (message.type === MESSAGE.COMPOSER_ABORT) {
      cleanupCalls.push('composerAbort');
      return new Promise(() => {});
    }
    return baseSendOffscreen(message);
  };
  const baseSendTab = deps.sendTab;
  deps.sendTab = (tabId, message) => {
    if (message.type === MESSAGE.RESTORE_PAGE) {
      cleanupCalls.push('restore');
      messages.push(message);
      return new Promise(() => {});
    }
    return baseSendTab(tabId, message);
  };

  const pending = runCapture({taskId: 'task-cleanup-hung', tabId: 7, windowId: 3}, deps);
  while (!events.includes('capture')) await Promise.resolve();
  timeoutCallback();
  await assert.rejects(pending, error => error.code === ERROR_CODE.TIMEOUT);
  assert.deepEqual(cleanupCalls.sort(), ['composerAbort', 'restore']);

  resolveLateCapture('data:late');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.some(message => message.type === MESSAGE.COMPOSER_BEGIN), false);
  assert.equal(messages.some(message => message.type === MESSAGE.COMPOSER_ADD), false);
});

test('外部取消信号会以 CANCELLED 终止并清理', async () => {
  const controller = new AbortController();
  const {deps, events} = makeHarness({
    sendTab: async (_tabId, message) => {
      if (message.type === MESSAGE.PREPARE_CAPTURE) {
        events.push('prepare');
        controller.abort();
        return {ok: true, selection, metrics, surfaceToken: 'surface-1'};
      }
      if (message.type === MESSAGE.RESTORE_PAGE) { events.push('restore'); return {ok: true}; }
      throw new Error(`unexpected ${message.type}`);
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-cancel', tabId: 7, windowId: 3, signal: controller.signal}, deps),
    error => error.code === ERROR_CODE.CANCELLED
  );
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('截图实际开始后取消会等待截图 settle 再清理', async () => {
  const capture = deferred();
  const {deps, events} = makeHarness({captureVisible: () => { events.push('capture'); return capture.promise; }});
  const controller = new AbortController();
  const pending = runCapture({taskId: 'task-capture-cancel', tabId: 7, windowId: 3, signal: controller.signal}, deps);
  while (!events.includes('capture')) await Promise.resolve();
  controller.abort();
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
  assert.equal(events.includes('composerAbort'), false);
  assert.equal(events.includes('restore'), false);
  capture.resolve('data:late');
  await assert.rejects(pending, error => error.code === ERROR_CODE.CANCELLED);
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('截图 settle 超时后仍会继续清理', async () => {
  let timeoutCalls = 0;
  const {deps, events} = makeHarness({
    captureVisible: () => { events.push('capture'); return new Promise(() => {}); },
    cleanupTimeout: promise => {
      timeoutCalls += 1;
      return timeoutCalls === 1 ? Promise.resolve('capture-settle-timeout') : promise;
    }
  });
  const controller = new AbortController();
  const pending = runCapture({taskId: 'task-capture-settle-timeout', tabId: 7, windowId: 3, signal: controller.signal}, deps);
  while (!events.includes('capture')) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, error => error.code === ERROR_CODE.CANCELLED);
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('消息响应失败会传播 typed error 并清理', async () => {
  const {deps, events} = makeHarness({
    sendOffscreen: async message => {
      if (message.type === MESSAGE.COMPOSER_ABORT) { events.push('composerAbort'); return {ok: true}; }
      events.push('composerBegin');
      return {ok: false, code: ERROR_CODE.OUTPUT_TOO_LARGE, message: '尺寸过大'};
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-response', tabId: 7, windowId: 3}, deps),
    error => error.code === ERROR_CODE.OUTPUT_TOO_LARGE && error.message === '尺寸过大'
  );
  assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
});

test('Chrome 依赖适配调用原始窗口、消息、截图与下载 API', async () => {
  const calls = [];
  const chromeApi = {
    tabs: {
      query: async query => { calls.push(['query', query]); return [{id: 7}]; },
      sendMessage: async (tabId, message) => { calls.push(['sendTab', tabId, message]); return {ok: true}; },
      captureVisibleTab: async (windowId, options) => { calls.push(['capture', windowId, options]); return 'data:image/png'; },
      getZoom: async tabId => { calls.push(['getZoom', tabId]); return 1.1; },
      setZoom: async (tabId, factor) => { calls.push(['setZoom', tabId, factor]); }
    },
    runtime: {sendMessage: async message => { calls.push(['offscreen', message]); return {ok: true}; }},
    downloads: {download: async options => { calls.push(['download', options]); return 91; }}
  };
  const deps = createChromeCaptureDeps(chromeApi);

  assert.equal(await deps.isActiveTab(7, 3), true);
  await deps.sendTab(7, {type: 'TAB'});
  assert.equal(await deps.captureVisible(3), 'data:image/png');
  assert.equal(await deps.getZoom(7), 1.1);
  await deps.setZoom(7, 1.5);
  await deps.sendOffscreen({type: 'OFFSCREEN'});
  await deps.download({url: 'blob:shot', filename: 'shot.png', saveAs: false});
  assert.deepEqual(calls, [
    ['query', {active: true, windowId: 3}],
    ['sendTab', 7, {type: 'TAB'}],
    ['capture', 3, {format: 'png'}],
    ['getZoom', 7],
    ['setZoom', 7, 1.5],
    ['offscreen', {type: 'OFFSCREEN'}],
    ['download', {url: 'blob:shot', filename: 'shot.png', saveAs: false}]
  ]);
});

test('service worker 点击图标时注入脚本并进入选择态', async () => {
  let clicked;
  const calls = [];
  const chromeApi = {
    action: {onClicked: {addListener(listener) { clicked = listener; }}},
    runtime: {onMessage: {addListener() {}}},
    scripting: {executeScript: async options => { calls.push(['inject', options]); }},
    tabs: {sendMessage: async (tabId, message) => { calls.push(['message', tabId, message]); }}
  };
  registerServiceWorker(chromeApi, async () => {});
  await clicked({id: 7});
  assert.equal(calls[0][1].files[0], 'src/content/content-script.js');
  assert.equal(calls[1][2].type, MESSAGE.ENTER_SELECTION);
});

test('CAPTURE_REQUEST 只创建一次 offscreen 文档并回传中文错误', async () => {
  let runtimeListener;
  const calls = [];
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener(listener) { runtimeListener = listener; }}},
    offscreen: {
      hasDocument: async () => false,
      createDocument: async options => { calls.push(['createOffscreen', options]); }
    },
    tabs: {sendMessage: async (tabId, message) => { calls.push(['errorMessage', tabId, message]); }}
  };
  const run = async (_request, deps) => {
    await deps.prepareEnvironment();
    const error = new Error('internal details');
    error.code = ERROR_CODE.SURFACE_CHANGED;
    throw error;
  };
  registerServiceWorker(chromeApi, run, {error() {}});
  const request = {source: 'longshot', type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-1', payload: {selection}};
  const responses = [];
  assert.equal(runtimeListener(request, {tab: {id: 7, windowId: 3}}, response => responses.push(response)), true);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls.filter(([name]) => name === 'createOffscreen').length, 1);
  assert.equal(calls.at(-1)[2].payload.message, ERROR_MESSAGES[ERROR_CODE.SURFACE_CHANGED]);
  assert.deepEqual(responses, [{ok: false, code: ERROR_CODE.SURFACE_CHANGED,
    message: ERROR_MESSAGES[ERROR_CODE.SURFACE_CHANGED]}]);
  assert.equal(Object.keys(ERROR_MESSAGES).length, Object.keys(ERROR_CODE).length);
});

test('截图任务失败时会将原始异常记录到 Service Worker 控制台', async () => {
  let runtimeListener;
  const errors = [];
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener(listener) { runtimeListener = listener; }}},
    offscreen: {hasDocument: async () => true},
    tabs: {sendMessage: async () => {}}
  };
  const failure = new Error('capture diagnostic detail');
  const run = async () => { throw failure; };
  registerServiceWorker(chromeApi, run, {error: (...args) => errors.push(args)});

  runtimeListener(
    {source: 'longshot', type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-log', payload: {}},
    {tab: {id: 7, windowId: 3}},
    () => {}
  );
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(errors, [['长截图任务失败', failure]]);
});

test('service worker 将 CANCEL 转为对应任务的 AbortSignal', async () => {
  let runtimeListener;
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener(listener) { runtimeListener = listener; }}},
    offscreen: {hasDocument: async () => true},
    tabs: {sendMessage: async () => {}}
  };
  const run = request => new Promise((resolve, reject) => {
    captureStarted();
    request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true});
  });
  registerServiceWorker(chromeApi, run, {error() {}});
  const responses = [];
  runtimeListener(
    {source: 'longshot', type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-cancel-sw', payload: {}},
    {tab: {id: 7, windowId: 3}},
    response => responses.push(response)
  );
  await started;
  const cancelResponses = [];
  runtimeListener(
    {source: 'longshot', type: MESSAGE.CANCEL, taskId: 'task-cancel-sw'},
    {}, response => cancelResponses.push(response)
  );
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(cancelResponses, [{ok: true}]);
  assert.equal(responses[0].code, ERROR_CODE.CANCELLED);
});
