import assert from 'node:assert/strict';
import test from 'node:test';

import {createCaptureGate, runCapture} from '../src/background/capture-controller.js';
import {
  createCaptureCoordinator, createOffscreenInitializer
} from '../src/background/service-worker.js';
import {ERROR_CODE} from '../src/shared/protocol.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('新 task 立即取消旧 task，等待旧 task 有界结束后才启动且绝不并发', async () => {
  const events = [];
  const oldCleanup = deferred();
  const secondStarted = deferred();
  let running = 0;
  const capture = async request => {
    running += 1;
    assert.equal(running, 1);
    events.push(`start:${request.taskId}`);
    try {
      if (request.taskId === 'task-1') {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, {once: true}));
        events.push('abort:task-1');
        await oldCleanup.promise;
        throw request.signal.reason;
      }
      secondStarted.resolve();
      return {filename: 'second.png'};
    } finally {
      running -= 1;
      events.push(`end:${request.taskId}`);
    }
  };
  const coordinator = createCaptureCoordinator({
    capture,
    createDeps: () => ({})
  });

  const first = coordinator.start({taskId: 'task-1'});
  while (!events.includes('start:task-1')) await Promise.resolve();
  const second = coordinator.start({taskId: 'task-2'});
  await Promise.resolve();
  assert.deepEqual(events, ['start:task-1', 'abort:task-1']);
  oldCleanup.resolve();
  await assert.rejects(first, error => error.code === ERROR_CODE.CANCELLED);
  await secondStarted.promise;
  assert.deepEqual(await second, {filename: 'second.png'});
  assert.deepEqual(events, [
    'start:task-1', 'abort:task-1', 'end:task-1',
    'start:task-2', 'end:task-2'
  ]);
});

test('CANCEL 只中止 taskId 匹配的 current capture', async () => {
  const started = deferred();
  const capture = request => new Promise((resolve, reject) => {
    started.resolve(request.signal);
    request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true});
  });
  const coordinator = createCaptureCoordinator({
    capture, createDeps: () => ({})
  });
  const pending = coordinator.start({taskId: 'task-current'});
  const signal = await started.promise;

  assert.equal(coordinator.cancel('task-other'), false);
  assert.equal(signal.aborted, false);
  assert.equal(coordinator.cancel('task-current'), true);
  await assert.rejects(pending, error => error.code === ERROR_CODE.CANCELLED);
});

test('offscreen 初始化优先通过 runtime.getContexts 识别已有文档', async () => {
  let created = 0;
  const initialize = createOffscreenInitializer({
    runtime: {getContexts: async query => {
      assert.deepEqual(query, {contextTypes: ['OFFSCREEN_DOCUMENT']});
      return [{contextType: 'OFFSCREEN_DOCUMENT'}];
    }},
    offscreen: {createDocument: async () => { created += 1; }}
  });
  await initialize();
  assert.equal(created, 0);
});

test('offscreen 初始化在缺少 getContexts 时通过 clients.matchAll 识别已有文档', async () => {
  let created = 0;
  const initialize = createOffscreenInitializer({offscreen: {createDocument: async () => { created += 1; }}}, {
    matchAllClients: async () => [{url: 'chrome-extension://id/src/offscreen/offscreen.html'}]
  });
  await initialize();
  assert.equal(created, 0);
});

test('offscreen 初始化仅在所有兼容性探测均未发现文档时创建', async () => {
  let created = 0;
  const initialize = createOffscreenInitializer({runtime: {getContexts: async () => []},
    offscreen: {createDocument: async () => { created += 1; }}});
  await initialize();
  assert.equal(created, 1);
});

test('offscreen 初始化永挂时，新 task 可使旧 entry 有界结束', async () => {
  const environmentStarts = [];
  const createDeps = request => ({
    prepareEnvironment: () => {
      environmentStarts.push(request.taskId);
      return new Promise(() => {});
    },
    isActiveTab: async () => true,
    sendOffscreen: async () => ({ok: true}),
    sendTab: async (_tabId, message) => message.type === 'RESTORE_PAGE'
      ? {ok: true}
      : (() => { throw new Error(`unexpected ${message.type}`); })(),
    captureVisible: async () => 'unused',
    download: async () => {},
    cleanupTimeout: promise => promise,
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  const coordinator = createCaptureCoordinator({capture: runCapture, createDeps});
  const first = coordinator.start({taskId: 'task-env-1', tabId: 7, windowId: 3});
  while (!environmentStarts.includes('task-env-1')) await Promise.resolve();
  const second = coordinator.start({taskId: 'task-env-2', tabId: 7, windowId: 3});

  await assert.rejects(first, error => error.code === ERROR_CODE.CANCELLED);
  while (!environmentStarts.includes('task-env-2')) await Promise.resolve();
  assert.equal(coordinator.cancel('task-env-2'), true);
  await assert.rejects(second, error => error.code === ERROR_CODE.CANCELLED);
});

test('旧 task 取消后丢弃永挂的 offscreen 初始化代次，新 task 可重新尝试', async () => {
  let hasDocumentCalls = 0;
  let createDocumentCalls = 0;
  const staleCheck = deferred();
  const chromeApi = {
    offscreen: {
      hasDocument: () => {
        hasDocumentCalls += 1;
        return hasDocumentCalls === 1 ? staleCheck.promise : Promise.resolve(true);
      },
      createDocument: async () => { createDocumentCalls += 1; }
    }
  };
  const initialize = createOffscreenInitializer(chromeApi);
  const firstController = new AbortController();
  void initialize(firstController.signal).catch(() => {});
  while (hasDocumentCalls === 0) await Promise.resolve();
  firstController.abort();
  await Promise.resolve();

  await initialize(new AbortController().signal);
  assert.equal(hasDocumentCalls, 2);
  staleCheck.resolve(false);
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
  assert.equal(createDocumentCalls, 0);
});

test('createDocument 已在途时取消旧调用，新调用等待同一创建锁且不重复创建', async () => {
  let documentExists = false;
  let hasDocumentCalls = 0;
  let createDocumentCalls = 0;
  const creation = deferred();
  const chromeApi = {
    offscreen: {
      hasDocument: async () => {
        hasDocumentCalls += 1;
        return documentExists;
      },
      createDocument: async () => {
        createDocumentCalls += 1;
        await creation.promise;
        documentExists = true;
      }
    }
  };
  const initialize = createOffscreenInitializer(chromeApi);
  const oldController = new AbortController();
  const old = initialize(oldController.signal);
  while (createDocumentCalls === 0) await Promise.resolve();
  let oldRejected = false;
  void old.catch(() => { oldRejected = true; });
  oldController.abort();
  for (let attempt = 0; attempt < 5 && !oldRejected; attempt += 1) await Promise.resolve();
  assert.equal(oldRejected, true);

  const replacement = initialize(new AbortController().signal);
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
  assert.equal(createDocumentCalls, 1);
  assert.equal(hasDocumentCalls, 1);

  creation.resolve();
  await replacement;
  assert.equal(createDocumentCalls, 1);
  assert.equal(hasDocumentCalls, 2);
});

test('共享 capture gate 跨 task 保持距上次捕获结束至少 200ms', async () => {
  let clock = 100;
  const captureStarts = [];
  const captureEnds = [];
  const gate = createCaptureGate({
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
    minInterval: 200
  });

  await gate.run(async () => { captureStarts.push(clock); clock += 150; captureEnds.push(clock); return 'task-1'; });
  await gate.run(async () => { captureStarts.push(clock); clock += 150; captureEnds.push(clock); return 'task-2'; });
  assert.equal(captureStarts.length, 2);
  assert.ok(captureStarts[1] - captureEnds[0] >= 200,
    `距上次结束应 ≥200ms，实际 ${captureStarts[1] - captureEnds[0]}ms`);
});

test('coordinator 中旧 task 最后一帧与新 task 第一帧的 API 调用相隔至少 200ms（按结束计）', async () => {
  let clock = 0;
  const captureStarts = [];
  const captureEnds = [];
  const gate = createCaptureGate({
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
    minInterval: 200
  });
  const selection = {left: 0, top: 100, right: 100, bottom: 200, width: 100, height: 100};
  const baseMetrics = {
    scrollLeft: 0, scrollTop: 0, maxScrollTop: 500,
    viewport: {left: 0, top: 0, width: 800, height: 600}
  };
  const createDeps = request => ({
    captureGate: gate,
    prepareEnvironment: async () => {},
    isActiveTab: async () => true,
    sendTab: async (_tabId, message) => {
      if (message.type === 'PREPARE_CAPTURE') {
        return {ok: true, selection, metrics: baseMetrics, surfaceToken: 'surface'};
      }
      if (message.type === 'SCROLL_TO') {
        return {ok: true, metrics: {...baseMetrics, scrollTop: message.payload.top}, surfaceToken: 'surface'};
      }
      return {ok: true};
    },
    captureVisible: async () => {
      captureStarts.push({taskId: request.taskId, time: clock});
      clock += 120;
      captureEnds.push({taskId: request.taskId, time: clock});
      return `data:${request.taskId}`;
    },
    sendOffscreen: async message => {
      if (message.type === 'COMPOSER_BEGIN') return {ok: true, scaleX: 1, scaleY: 1};
      if (message.type === 'COMPOSER_FINISH') return {ok: true, objectUrl: `blob:${request.taskId}`};
      return {ok: true};
    },
    download: async () => {},
    cleanupTimeout: promise => promise,
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  const coordinator = createCaptureCoordinator({capture: runCapture, createDeps});

  await coordinator.start({taskId: 'task-frame-1', tabId: 7, windowId: 3});
  await coordinator.start({taskId: 'task-frame-2', tabId: 7, windowId: 3});
  assert.deepEqual(captureStarts.map(item => item.taskId), ['task-frame-1', 'task-frame-2']);
  assert.ok(
    captureStarts[1].time - captureEnds[0].time >= 200,
    `距旧 task 最后一帧结束应 ≥200ms，实际 ${captureStarts[1].time - captureEnds[0].time}ms`
  );
});

test('capture gate 的运行中操作取消后释放锁且迟到结果不阻塞下一 task', async () => {
  const firstController = new AbortController();
  let resolveFirst;
  const firstOperation = new Promise(resolve => { resolveFirst = resolve; });
  const calls = [];
  const gate = createCaptureGate({now: () => 0, sleep: async () => {}, minInterval: 0});
  const first = gate.run(() => { calls.push('first'); return firstOperation; }, firstController.signal);
  while (!calls.includes('first')) await Promise.resolve();
  firstController.abort();
  await assert.rejects(first);

  assert.equal(await gate.run(() => { calls.push('second'); return 'second'; }), 'second');
  resolveFirst('late');
  await Promise.resolve();
  assert.deepEqual(calls, ['first', 'second']);
});

test('capture gate 中等待锁的 task 可取消且永不调用其 capture API', async () => {
  let resolveFirst;
  const firstOperation = new Promise(resolve => { resolveFirst = resolve; });
  const waitingController = new AbortController();
  const calls = [];
  const gate = createCaptureGate({now: () => 0, sleep: async () => {}, minInterval: 0});
  const first = gate.run(() => { calls.push('first'); return firstOperation; });
  const waiting = gate.run(() => { calls.push('cancelled'); }, waitingController.signal);
  waitingController.abort();
  await assert.rejects(waiting);
  resolveFirst('done');
  await first;

  assert.equal(await gate.run(() => { calls.push('third'); return 'third'; }), 'third');
  assert.deepEqual(calls, ['first', 'third']);
});
