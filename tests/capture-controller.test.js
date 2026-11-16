import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_INTERVAL_MS, copyComposition, discardComposition, runCapture, saveComposition
} from '../src/background/capture-controller.js';
import {
  createCaptureCoordinator, createChromeCaptureDeps, createHighQualitySessionManager,
  createOffscreenInitializer, ERROR_MESSAGES, registerServiceWorker
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
    if (message.type === MESSAGE.CLIPBOARD_WRITE) {
      events.push('clipboard');
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
      [MESSAGE.COMPOSER_EXPORT]: 'composerExport',
      [MESSAGE.COMPOSER_RELEASE]: 'composerRelease',
      [MESSAGE.COMPOSER_ABORT]: 'composerAbort'
    };
    events.push(names[message.type]);
    if (message.type === MESSAGE.COMPOSER_BEGIN) {
      return {ok: true, scaleX: 2, scaleY: 2, width: 400, height: 3200};
    }
    if (message.type === MESSAGE.COMPOSER_FINISH) return {ok: true, objectUrl: 'blob:shot'};
    if (message.type === MESSAGE.COMPOSER_EXPORT) return {ok: true, dataUrl: 'data:image/png;base64,AAAA'};
    return {ok: true};
  };
  const deps = {
    isActiveTab: async () => true,
    sendTab,
    captureVisible: async () => { events.push('capture'); return `data:${now}`; },
    sendOffscreen,
    download: async args => {
      events.push('download');
      events.push(`download:${args.filename}`);
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

test('首帧按 begin 再 add 编排，拼接完成后不下载也不释放画布', async () => {
  const {deps, events, messages} = makeHarness();
  const result = await runCapture({taskId: 'task-1', tabId: 7, windowId: 3}, deps);

  assert.deepEqual(result, {composed: true});
  // add 与下一屏滚动并行，事件交错顺序不确定，这里断言语义不变量。
  assert.equal(events[0], 'prepare');
  assert.equal(events.at(-1), 'restore');
  assert.equal(events.filter(e => e === 'capture').length, 3);
  assert.equal(events.filter(e => e === 'scroll').length, 3);
  assert.equal(events.filter(e => e === 'composerAdd').length, 3);
  assert.equal(events.filter(e => e === 'composerBegin').length, 1);
  assert.deepEqual(events.filter(e => e.startsWith('fixed:')), ['fixed:true', 'fixed:false', 'fixed:false']);
  // begin 必须在所有 add 之前；首帧的 fixed 可见性切换在首帧捕获前。
  assert.ok(events.indexOf('composerBegin') < events.indexOf('composerAdd'));
  assert.ok(events.indexOf('fixed:true') < events.indexOf('capture'));
  assert.equal(events.includes('download'), false);
  assert.equal(events.includes('composerFinish'), false);
  assert.equal(events.includes('composerRelease'), false);
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

test('多帧 COMPOSER_ADD 严格串行发送，不会并发进入拼接状态机', async () => {
  const harness = makeHarness();
  const inFlight = [];
  let maxConcurrent = 0;
  const baseSendOffscreen = harness.deps.sendOffscreen;
  harness.deps.sendOffscreen = async message => {
    if (message.type !== MESSAGE.COMPOSER_ADD) return baseSendOffscreen(message);
    inFlight.push(message.payload.placement.dy);
    maxConcurrent = Math.max(maxConcurrent, inFlight.length);
    // 模拟解码/绘制耗时，若主循环并发发送，后续帧会在此重叠
    await new Promise(resolve => setTimeout(resolve, 10));
    inFlight.pop();
    return baseSendOffscreen(message);
  };

  await runCapture({taskId: 'task-serial-add', tabId: 7, windowId: 3}, harness.deps);

  assert.equal(maxConcurrent, 1, '同一时刻只允许一个 COMPOSER_ADD 在飞');
});

test('截图完成后由用户选择保存：按所选格式编码、下载并释放画布', async () => {
  const {deps, events, messages} = makeHarness();
  await runCapture({taskId: 'task-save', tabId: 7, windowId: 3}, deps);
  events.length = 0;
  messages.length = 0;

  const result = await saveComposition({taskId: 'task-save', format: 'jpeg'}, deps);

  assert.deepEqual(result, {filename: 'longshot-20260716-120102.jpg'});
  assert.deepEqual(events, ['composerFinish', 'download', 'download:longshot-20260716-120102.jpg', 'composerRelease']);
  assert.deepEqual(messages[0].payload, {format: 'jpeg'});
});

test('未知格式保存时回退为 PNG 扩展名与编码', async () => {
  const {deps, messages} = makeHarness();
  await runCapture({taskId: 'task-save', tabId: 7, windowId: 3}, deps);
  messages.length = 0;

  const result = await saveComposition({taskId: 'task-save', format: 'webp'}, deps);

  assert.equal(result.filename, 'longshot-20260716-120102.png');
  assert.deepEqual(messages[0].payload, {format: 'png'});
});

test('用户选择复制到剪贴板：导出 PNG 交给页面写入并释放画布', async () => {
  const {deps, events, messages} = makeHarness();
  await runCapture({taskId: 'task-copy', tabId: 7, windowId: 3}, deps);
  events.length = 0;
  messages.length = 0;

  const result = await copyComposition({taskId: 'task-copy', tabId: 7}, deps);

  assert.deepEqual(result, {copied: true});
  assert.deepEqual(events, ['composerExport', 'clipboard', 'composerRelease']);
  const exported = messages.find(message => message.type === MESSAGE.COMPOSER_EXPORT);
  assert.equal(exported.taskId, 'task-copy');
  const write = messages.find(message => message.type === MESSAGE.CLIPBOARD_WRITE);
  assert.deepEqual(write.payload, {dataUrl: 'data:image/png;base64,AAAA'});
  assert.equal(events.includes('download'), false);
});

test('剪贴板写入失败时保留中文错误且不释放画布（由上层决定丢弃）', async () => {
  const harness = makeHarness();
  const sendTab = harness.deps.sendTab;
  harness.deps.sendTab = async (tabId, message) => message.type === MESSAGE.CLIPBOARD_WRITE
    ? {ok: false, code: 'CAPTURE_FAILED', message: '复制到剪贴板失败，请重试'}
    : sendTab(tabId, message);

  await assert.rejects(
    copyComposition({taskId: 'task-copy', tabId: 7}, harness.deps),
    error => error.code === 'CAPTURE_FAILED' && error.message === '复制到剪贴板失败，请重试'
  );
  assert.equal(harness.events.includes('composerRelease'), false);
});

test('丢弃拼接结果会 abort 离屏画布', async () => {
  const {deps, events} = makeHarness();
  const result = await discardComposition({taskId: 'task-discard'}, deps);

  assert.deepEqual(result, {ok: true});
  assert.deepEqual(events, ['composerAbort']);
});

test('丢弃拼接结果时离屏文档不可用也不会抛错', async () => {
  const {deps} = makeHarness();
  deps.sendOffscreen = async () => { throw new Error('No offscreen document'); };

  await assert.doesNotReject(discardComposition({taskId: 'task-discard'}, deps));
});

test('高清模式在截图前提高 tab zoom，并在结束后恢复原 zoom', async () => {
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
      throw new Error('capture exploded');
    }
  });

  await assert.rejects(
    runCapture({taskId: 'task-high-quality', tabId: 7, windowId: 3, highQuality: true}, harness.deps),
    error => error.code === ERROR_CODE.CAPTURE_FAILED && /capture exploded/.test(error.message)
  );
  assert.equal(harness.events.lastIndexOf('setZoom:7:0.9') > harness.events.indexOf('restore'), true);
});

test('内容脚本已开启高清时只在清理阶段恢复原缩放', async () => {
  const harness = makeHarness({
    getZoom: async () => { throw new Error('should not read zoom again'); },
    setZoom: async (tabId, factor) => { harness.events.push(`setZoom:${tabId}:${factor}`); }
  });

  await runCapture({taskId: 'task-hq', tabId: 7, windowId: 3, highQuality: true, restoreZoomTo: 1.25},
    harness.deps);

  assert.equal(harness.events.some(entry => entry.startsWith('getZoom:')), false);
  assert.equal(harness.events.at(-1), 'setZoom:7:1.25');
});

test('高清会话串行读写每个标签页的缩放，可取消未截图的缩放', async () => {
  const calls = [];
  const sessions = createHighQualitySessionManager({
    getZoom: async tabId => { calls.push(['getZoom', tabId]); return 1.1; },
    setZoom: async (tabId, factor) => { calls.push(['setZoom', tabId, factor]); }
  });

  assert.deepEqual(await sessions.enable(7), {originalZoom: 1.1});
  await sessions.restore(7, 1.1);
  assert.deepEqual(calls, [['getZoom', 7], ['setZoom', 7, 1.5], ['setZoom', 7, 1.1]]);

  // 非法原缩放值直接忽略，不写 zoom。
  calls.length = 0;
  await sessions.restore(7, undefined);
  assert.deepEqual(calls, []);
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

test('用户取消另存为不算失败，仍释放画布', async () => {
  const harness = makeHarness({
    download: async () => {
      harness.events.push('download');
      throw new Error('USER_CANCELED');
    }
  });

  await assert.doesNotReject(
    saveComposition({taskId: 'task-save-cancel', format: 'png'}, harness.deps)
  );
  assert.deepEqual(harness.events, ['composerFinish', 'download', 'composerRelease']);
});

test('默认截图间隔满足 Chrome 的 captureVisibleTab 频率配额（每秒最多 2 次）', () => {
  // Chromium: kMaxCaptureVisibleTabCallsPerSecond = 2 → 两次调用开始至少间隔 500ms。
  // 间隔按「距上次捕获结束」计，捕获本身还需时间，所以开始间隔必然 ≥ CAPTURE_INTERVAL_MS。
  // 一旦有人把它调小（历史上曾误设为 200ms），真机上会稳定报「截图失败」。
  assert.ok(CAPTURE_INTERVAL_MS >= 500,
    `CAPTURE_INTERVAL_MS=${CAPTURE_INTERVAL_MS} 低于 Chrome 配额要求（≥500ms），会触发 captureVisibleTab 限流`);
});

test('每次可视区截图调用至少相距 CAPTURE_INTERVAL_MS（按上次结束计）', async () => {
  const captureTimes = [];
  const harness = makeHarness();
  harness.deps.captureVisible = async () => {
    // 模拟真实捕获耗时 150ms
    await new Promise(resolve => setTimeout(resolve, 150));
    captureTimes.push(harness.deps.now());
    harness.events.push('capture');
    return 'data:image/png';
  };

  await runCapture({taskId: 'task-throttle', tabId: 7, windowId: 3}, harness.deps);
  assert.equal(captureTimes.length, 3);
  for (let index = 1; index < captureTimes.length; index += 1) {
    assert.ok(captureTimes[index] - captureTimes[index - 1] >= CAPTURE_INTERVAL_MS,
      `相邻两次捕获开始间隔应 ≥${CAPTURE_INTERVAL_MS}ms，实际 ${captureTimes[index] - captureTimes[index - 1]}ms`);
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

  const result = await runCapture({taskId: 'task-actual-scroll', tabId: 7, windowId: 3}, harness.deps);
  assert.deepEqual(result, {composed: true});
  assert.equal(harness.events.includes('composerAbort'), false);
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

test('离屏文档被回收时 sendOffscreen 自动重建并重试一次', async () => {
  let alive = true;
  let attempts = 0;
  const chromeApi = {
    runtime: {
      sendMessage: async () => {
        attempts += 1;
        if (!alive) throw new Error('Could not establish connection. Receiving end does not exist.');
        return {ok: true};
      },
      getContexts: async () => (alive ? [{}] : [])
    },
    offscreen: {
      createDocument: async () => { alive = true; },
      closeDocument: async () => { alive = false; }
    }
  };
  const prepare = createOffscreenInitializer(chromeApi);
  const deps = createChromeCaptureDeps(chromeApi, {prepareEnvironment: prepare});

  assert.deepEqual(await deps.sendOffscreen({type: 'COMPOSER_BEGIN'}), {ok: true});

  alive = false;
  attempts = 0;
  assert.deepEqual(await deps.sendOffscreen({type: 'COMPOSER_ADD'}), {ok: true});
  assert.equal(attempts, 2, '首次失败后应重建文档并重试一次');
  assert.equal(alive, true);
});

test('错误提示带上失败阶段与原始原因，便于定位', async () => {
  let runtimeListener;
  const sent = [];
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener(l) { runtimeListener = l; }}},
    tabs: {
      query: async () => [{id: 7}],
      sendMessage: async (_tabId, message) => { sent.push(message); return {ok: true}; }
    },
    downloads: {download: async () => 1}
  };
  const capture = async () => {
    const error = new Error('Could not establish connection');
    error.stage = 'capture#2/3';
    throw error;
  };
  registerServiceWorker(chromeApi, capture, {error() {}});

  const responses = [];
  runtimeListener({source: 'longshot', type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-1', payload: {selection}},
    {tab: {id: 7, windowId: 3}}, response => responses.push(response));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(responses[0].code, ERROR_CODE.CAPTURE_FAILED);
  assert.match(responses[0].message, /capture#2\/3/);
  assert.match(responses[0].message, /Could not establish connection/);
  const errorMessage = sent.find(m => m.type === MESSAGE.ERROR);
  assert.match(errorMessage.payload.message, /capture#2\/3/);
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

test('CAPTURE_REQUEST 完成后由 CAPTURE_SAVE 保存，compositions 只消费一次', async () => {
  let runtimeListener;
  const calls = [];
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {
      onMessage: {addListener(listener) { runtimeListener = listener; }},
      sendMessage: async message => { calls.push(['offscreen', message.type]); return {ok: true, objectUrl: 'blob:shot', dataUrl: 'data:png'}; }
    },
    tabs: {
      query: async () => [{id: 7}],
      sendMessage: async () => ({ok: true}),
      captureVisibleTab: async () => 'data:image/png'
    },
    downloads: {download: async options => { calls.push(['download', options.filename]); return 1; }}
  };
  const run = async () => ({composed: true});
  registerServiceWorker(chromeApi, run, {error() {}});
  const send = payload => {
    const responses = [];
    runtimeListener({source: 'longshot', ...payload},
      {tab: {id: 7, windowId: 3}}, response => responses.push(response));
    return responses;
  };

  const captured = send({type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-1', payload: {selection}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(captured, [{ok: true, composed: true}]);

  const saved = send({type: MESSAGE.CAPTURE_SAVE, taskId: 'task-1', payload: {format: 'jpeg'}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved[0].ok, true);
  assert.ok(calls.some(([name, value]) => name === 'download' && /\.jpg$/.test(value)));

  // 同一任务不能重复消费
  const again = send({type: MESSAGE.CAPTURE_SAVE, taskId: 'task-1', payload: {format: 'png'}});
  assert.deepEqual(again, [{ok: false, code: ERROR_CODE.STALE_TASK,
    message: ERROR_MESSAGES[ERROR_CODE.STALE_TASK]}]);
});

test('CAPTURE_DISCARD 释放离屏画布且拒绝其他标签页', async () => {
  let runtimeListener;
  const calls = [];
  const chromeApi = {
    action: {onClicked: {addListener() {}}},
    runtime: {
      onMessage: {addListener(listener) { runtimeListener = listener; }},
      sendMessage: async message => { calls.push(message.type); return {ok: true}; }
    },
    tabs: {query: async () => [{id: 7}], sendMessage: async () => ({ok: true}), captureVisibleTab: async () => 'data:png'},
    downloads: {download: async () => 1}
  };
  registerServiceWorker(chromeApi, async () => ({composed: true}), {error() {}});
  const send = (payload, tab) => {
    const responses = [];
    runtimeListener({source: 'longshot', ...payload}, {tab}, response => responses.push(response));
    return responses;
  };

  send({type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-1', payload: {selection}}, {id: 7, windowId: 3});
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(send({type: MESSAGE.CAPTURE_DISCARD, taskId: 'task-1'}, {id: 99}),
    [{ok: false, code: ERROR_CODE.STALE_TASK, message: ERROR_MESSAGES[ERROR_CODE.STALE_TASK]}]);

  const discarded = send({type: MESSAGE.CAPTURE_DISCARD, taskId: 'task-1'}, {id: 7, windowId: 3});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(discarded, [{ok: true}]);
  assert.ok(calls.includes(MESSAGE.COMPOSER_ABORT));
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
