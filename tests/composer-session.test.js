import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComposerSession, createComposerMessageHandler, registerComposerMessageListener
} from '../src/offscreen/offscreen.js';
import { MESSAGE } from '../src/shared/protocol.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({ bitmap = { width: 1200, height: 800 }, blob = new Blob(['png'], { type: 'image/png' }) } = {}) {
  const calls = [];
  const bitmaps = [];
  const context = {
    fillStyle: '',
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args])
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback, type, quality) => {
      calls.push(['toBlob', type, quality]);
      callback(blob);
    }
  };
  const dependencies = {
    createCanvas: () => canvas,
    decodeImage: async dataUrl => {
      calls.push(['decode', dataUrl]);
      const decoded = { ...bitmap, close: () => calls.push(['close', dataUrl]) };
      bitmaps.push(decoded);
      return decoded;
    },
    createObjectURL: value => {
      calls.push(['createObjectURL', value]);
      return 'blob:longshot-result';
    },
    revokeObjectURL: url => calls.push(['revoke', url])
  };
  return { calls, bitmaps, canvas, dependencies };
}

test('begin measures the first image and creates the exact rounded output canvas', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);

  const result = await session.begin({
    cssWidth: 400.2, cssHeight: 800.2,
    firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400
  });

  assert.deepEqual(result, { scaleX: 2, scaleY: 2, width: 800, height: 1600 });
  assert.equal(harness.canvas.width, 800);
  assert.equal(harness.canvas.height, 1600);
  assert.deepEqual(harness.calls.at(-1), ['close', 'data:first']);
});

test('begin rejects oversized output with a serializable error code and closes its bitmap', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);

  await assert.rejects(
    session.begin({ cssWidth: 20000, cssHeight: 20000, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }),
    error => error.code === 'OUTPUT_TOO_LARGE' && /edge/.test(error.message)
  );
  assert.deepEqual(harness.calls.at(-1), ['close', 'data:first']);
  assert.equal(session.canvas, null);
  assert.equal(session.state, 'failed');
  await assert.rejects(session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:duplicate', innerWidth: 600, innerHeight: 400
  }), /Cannot begin while failed/);
});

test('abort clears a canvas allocated before context creation fails', async () => {
  const harness = createHarness();
  harness.canvas.getContext = () => null;
  const session = new ComposerSession(harness.dependencies);

  await assert.rejects(session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400
  }), /2D canvas context/);
  session.abort();

  assert.equal(harness.canvas.width, 0);
  assert.equal(harness.canvas.height, 0);
  assert.deepEqual(harness.calls.at(-1), ['close', 'data:first']);
});

test('add draws using the bitmap and all eight placement arguments then closes it', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  await session.add({
    dataUrl: 'data:frame',
    placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 }
  });

  const drawCall = harness.calls.find(call => call[0] === 'drawImage');
  assert.equal(drawCall[1], harness.bitmaps[1]);
  assert.deepEqual(drawCall.slice(2), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(harness.calls.at(-1), ['close', 'data:frame']);
});

test('add closes a decoded bitmap when drawing fails', async () => {
  const harness = createHarness();
  harness.canvas.getContext = () => ({
    fillRect: () => {},
    drawImage: () => { throw new Error('draw failed'); }
  });
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  await assert.rejects(session.add({
    dataUrl: 'data:frame', placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 }
  }), /draw failed/);
  assert.deepEqual(harness.calls.at(-1), ['close', 'data:frame']);
  assert.equal(session.state, 'failed');
  await assert.rejects(session.finish(), /Cannot finish while failed/);
});

test('finish encodes a PNG Blob URL and release clears resources idempotently', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  assert.equal(await session.finish(), 'blob:longshot-result');
  assert.deepEqual(harness.calls.find(call => call[0] === 'toBlob'), ['toBlob', 'image/png', undefined]);
  session.release();
  session.release();

  assert.deepEqual(harness.calls.filter(call => call[0] === 'revoke'), [['revoke', 'blob:longshot-result']]);
  assert.equal(harness.canvas.width, 0);
  assert.equal(harness.canvas.height, 0);
  assert.equal(session.canvas, null);
});

test('拼接画布统一铺白底，格式在 finish 时才决定编码类型', async () => {
  const harness = createHarness();
  const fills = [];
  harness.canvas.getContext = () => ({
    fillStyle: '',
    drawImage: () => {},
    fillRect: (...args) => fills.push(['fillRect', ...args])
  });
  const session = new ComposerSession(harness.dependencies);
  await session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400
  });

  // begin 阶段不再关心输出格式，统一铺白底（JPEG 不支持透明通道）。
  assert.deepEqual(fills, [['fillRect', 0, 0, 800, 1600]]);
  assert.equal(await session.finish('jpeg'), 'blob:longshot-result');
  assert.deepEqual(harness.calls.find(call => call[0] === 'toBlob'), ['toBlob', 'image/jpeg', 0.92]);
});

test('finish 默认编码 PNG，未知格式回退为 PNG', async () => {
  for (const format of [undefined, 'webp', 'png']) {
    const harness = createHarness();
    const session = new ComposerSession(harness.dependencies);
    await session.begin({
      cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400
    });

    await session.finish(format);
    assert.deepEqual(harness.calls.find(call => call[0] === 'toBlob'), ['toBlob', 'image/png', undefined]);
  }
});

test('exportDataUrl 在拼接完成后导出 PNG，空闲时拒绝', async () => {
  const harness = createHarness();
  harness.canvas.toDataURL = type => {
    harness.calls.push(['toDataURL', type]);
    return 'data:image/png;base64,AAAA';
  };
  const session = new ComposerSession(harness.dependencies);

  assert.throws(() => session.exportDataUrl(), /Cannot export while idle/);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });
  assert.equal(session.exportDataUrl(), 'data:image/png;base64,AAAA');
  assert.deepEqual(harness.calls.at(-1), ['toDataURL', 'image/png']);
});

test('message handler 支持 COMPOSER_EXPORT 导出 data URL', async () => {
  const harness = createHarness();
  harness.canvas.toDataURL = () => 'data:image/png;base64,AAAA';
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);

  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_EXPORT, taskId: 'task-1', payload: {}
  }), { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });

  await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1',
    payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }
  });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_EXPORT, taskId: 'task-1', payload: {}
  }), { ok: true, dataUrl: 'data:image/png;base64,AAAA' });
});

test('abort revokes output and clears canvas resources idempotently', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });
  await session.finish();

  session.abort();
  session.abort();

  assert.deepEqual(harness.calls.filter(call => call[0] === 'revoke'), [['revoke', 'blob:longshot-result']]);
  assert.equal(harness.canvas.width, 0);
  assert.equal(harness.canvas.height, 0);
  assert.equal(session.canvas, null);
});

test('message handler ignores other sources and rejects stale task IDs', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);

  assert.equal(await handleMessage({ source: 'other', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1' }), undefined);
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1',
    payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }
  }), { ok: true, scaleX: 2, scaleY: 2, width: 800, height: 1600 });

  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ADD, taskId: 'task-stale', payload: {}
  }), { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
});

test('message handler maps finish and release and permits a later task', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);
  const beginPayload = { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 };

  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1', payload: beginPayload });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_FINISH, taskId: 'task-1', payload: {}
  }), { ok: true, objectUrl: 'blob:longshot-result' });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_RELEASE, taskId: 'task-1', payload: {}
  }), { ok: true });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-2', payload: beginPayload
  }), { ok: true, scaleX: 2, scaleY: 2, width: 800, height: 1600 });
});

test('message handler serializes composer errors and abort is idempotent', async () => {
  const harness = createHarness();
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);

  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1',
    payload: { cssWidth: 20000, cssHeight: 20000, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }
  }), { ok: false, code: 'OUTPUT_TOO_LARGE', message: 'Output is too large: edge' });

  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'task-1', payload: {}
  }), { ok: true });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'task-1', payload: {}
  }), { ok: true });
});

test('state machine rejects duplicate begin, duplicate finish, and add after finish starts', async () => {
  const firstDecode = deferred();
  const finishCallbacks = [];
  const harness = createHarness();
  harness.dependencies.decodeImage = () => firstDecode.promise;
  harness.canvas.toBlob = callback => finishCallbacks.push(callback);
  const session = new ComposerSession(harness.dependencies);

  const beginning = session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });
  const duplicateBegin = session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:duplicate', innerWidth: 600, innerHeight: 400
  });
  firstDecode.resolve({ width: 1200, height: 800, close() {} });
  await assert.rejects(duplicateBegin, /Cannot begin while beginning/);
  await beginning;
  await assert.rejects(session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:duplicate', innerWidth: 600, innerHeight: 400
  }), /Cannot begin while begun/);

  const finishing = session.finish();
  const duplicateFinish = session.finish();
  await assert.rejects(session.add({ dataUrl: 'data:late', placement: {} }), /Cannot add while finishing/);
  for (const callback of finishCallbacks) callback(new Blob(['png'], { type: 'image/png' }));
  await assert.rejects(duplicateFinish, /Cannot finish while finishing/);
  await finishing;
  await assert.rejects(session.add({ dataUrl: 'data:late', placement: {} }), /Cannot add while finished/);
  await assert.rejects(session.finish(), /Cannot finish while finished/);
});

test('abort invalidates an asynchronous finish and prevents an object URL leak', async () => {
  const callbackReady = deferred();
  const harness = createHarness();
  harness.canvas.toBlob = callback => callbackReady.resolve(callback);
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  const finishing = session.finish();
  const callback = await callbackReady.promise;
  session.abort();
  callback(new Blob(['png'], { type: 'image/png' }));

  await assert.rejects(finishing, /invalidated/);
  await assert.rejects(session.finish(), /Cannot finish while idle/);
  assert.equal(harness.calls.some(call => call[0] === 'createObjectURL'), false);
});

test('release revokes an object URL created reentrantly after finish is invalidated', async () => {
  const harness = createHarness();
  let session;
  harness.dependencies.createObjectURL = () => {
    session.release();
    return 'blob:invalidated';
  };
  session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  await assert.rejects(session.finish(), /invalidated/);
  assert.deepEqual(harness.calls.filter(call => call[0] === 'revoke'), [['revoke', 'blob:invalidated']]);
  assert.equal(session.canvas, null);
});

test('finish rejects a null blob and an asynchronous createObjectURL exception', async () => {
  const callbacks = [];
  const harness = createHarness();
  harness.canvas.toBlob = callback => callbacks.push(callback);
  harness.dependencies.createObjectURL = () => { throw new Error('URL failed'); };
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  const nullFinish = session.finish();
  callbacks.shift()(null);
  await assert.rejects(nullFinish, /Failed to encode screenshot/);
  assert.equal(session.state, 'failed');

  session.abort();
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });
  const thrownFinish = session.finish();
  const callback = callbacks.shift();
  assert.doesNotThrow(() => callback(new Blob(['png'], { type: 'image/png' })));
  await assert.rejects(thrownFinish, /URL failed/);
  assert.equal(session.state, 'failed');
});

test('an add resumed after abort closes its bitmap without drawing into a replacement session', async () => {
  const lateDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:late' ? lateDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  const beginPayload = { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 };
  await session.begin(beginPayload);

  const adding = session.add({
    dataUrl: 'data:late', placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 }
  });
  session.abort();
  await session.begin(beginPayload);
  let closed = false;
  lateDecode.resolve({ width: 1200, height: 800, close: () => { closed = true; } });

  await assert.rejects(adding, /invalidated/);
  assert.equal(closed, true);
  assert.equal(harness.calls.some(call => call[0] === 'drawImage'), false);
});

test('a begin resumed after abort cannot replace the canvas of a newer begin', async () => {
  const oldDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:old' ? oldDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  const oldBegin = session.begin({
    cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:old', innerWidth: 600, innerHeight: 400
  });
  session.abort();
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:new', innerWidth: 600, innerHeight: 400 });
  const replacementCanvas = session.canvas;
  let closed = false;
  oldDecode.resolve({ width: 1200, height: 800, close: () => { closed = true; } });

  await assert.rejects(oldBegin, /invalidated/);
  assert.equal(session.canvas, replacementCanvas);
  assert.equal(closed, true);
});

test('handler returns stale when an old begin resumes after a replacement task starts', async () => {
  const oldDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:old' ? oldDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);
  const oldBegin = handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-old',
    payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:old', innerWidth: 600, innerHeight: 400 }
  });
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'task-old' });
  await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-new',
    payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:new', innerWidth: 600, innerHeight: 400 }
  });
  oldDecode.resolve({ width: 1200, height: 800, close() {} });

  assert.deepEqual(await oldBegin, { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
  assert.equal(session.state, 'begun');
});

test('handler returns stale when an old add resumes after a replacement task starts', async () => {
  const lateDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:late' ? lateDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);
  const beginPayload = { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 };
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-old', payload: beginPayload });
  const oldAdd = handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ADD, taskId: 'task-old',
    payload: { dataUrl: 'data:late', placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 } }
  });
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_RELEASE, taskId: 'task-old' });
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-new', payload: beginPayload });
  lateDecode.resolve({ width: 1200, height: 800, close() {} });

  assert.deepEqual(await oldAdd, { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
  assert.equal(harness.calls.some(call => call[0] === 'drawImage'), false);
});

test('handler returns stale when an old finish callback resumes after a replacement task starts', async () => {
  const callbackReady = deferred();
  const harness = createHarness();
  harness.canvas.toBlob = callback => callbackReady.resolve(callback);
  const session = new ComposerSession(harness.dependencies);
  const handleMessage = createComposerMessageHandler(session);
  const beginPayload = { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 };
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-old', payload: beginPayload });
  const oldFinish = handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_FINISH, taskId: 'task-old' });
  const callback = await callbackReady.promise;
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'task-old' });
  harness.canvas.toBlob = callbackNow => callbackNow(new Blob(['png'], { type: 'image/png' }));
  await handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-new', payload: beginPayload });
  callback(new Blob(['png'], { type: 'image/png' }));

  assert.deepEqual(await oldFinish, { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
  assert.equal(session.state, 'begun');
});

test('handler only permits idempotent terminal retry for the last task', async () => {
  const harness = createHarness();
  const handleMessage = createComposerMessageHandler(new ComposerSession(harness.dependencies));

  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'unknown'
  }), { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
  await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: 'task-1',
    payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }
  });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_ABORT, taskId: 'task-1'
  }), { ok: true });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_RELEASE, taskId: 'task-1'
  }), { ok: true });
  assert.deepEqual(await handleMessage({
    source: 'longshot', type: MESSAGE.COMPOSER_RELEASE, taskId: 'unknown'
  }), { ok: false, code: 'STALE_TASK', message: 'Stale composer task' });
});

test('runtime listener sends a serialized response when its async handler rejects', async () => {
  let listener;
  const failure = deferred();
  const responseReady = deferred();
  registerComposerMessageListener({ addListener: value => { listener = value; } }, () => failure.promise);

  assert.equal(listener({
    source: 'longshot', type: MESSAGE.COMPOSER_FINISH, taskId: 'task-1'
  }, {}, responseReady.resolve), true);
  failure.reject(new Error('async handler failed'));

  assert.deepEqual(await responseReady.promise, {
    ok: false, code: 'CAPTURE_FAILED', message: 'async handler failed'
  });
});

test('handler serializes asynchronous null blob and createObjectURL failures', async () => {
  for (const scenario of ['null blob', 'URL exception']) {
    const callbackReady = deferred();
    const harness = createHarness();
    harness.canvas.toBlob = callback => callbackReady.resolve(callback);
    if (scenario === 'URL exception') {
      harness.dependencies.createObjectURL = () => { throw new Error('URL failed'); };
    }
    const handleMessage = createComposerMessageHandler(new ComposerSession(harness.dependencies));
    await handleMessage({
      source: 'longshot', type: MESSAGE.COMPOSER_BEGIN, taskId: scenario,
      payload: { cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 }
    });

    const response = handleMessage({ source: 'longshot', type: MESSAGE.COMPOSER_FINISH, taskId: scenario });
    const callback = await callbackReady.promise;
    assert.doesNotThrow(() => callback(scenario === 'null blob' ? null : new Blob(['png'], { type: 'image/png' })));

    assert.deepEqual(await response, {
      ok: false,
      code: 'CAPTURE_FAILED',
      message: scenario === 'null blob' ? 'Failed to encode screenshot' : 'URL failed'
    });
  }
});

test('pending add rejects finish and a second add, then permits finish after drawing', async () => {
  const frameDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:frame' ? frameDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  const firstAdd = session.add({
    dataUrl: 'data:frame', placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 }
  });
  const earlyFinish = session.finish();
  const secondAdd = session.add({
    dataUrl: 'data:second', placement: { sx: 9, sy: 10, sw: 11, sh: 12, dx: 13, dy: 14, dw: 15, dh: 16 }
  });
  frameDecode.resolve({ width: 1200, height: 800, close() {} });

  const [finishResult, secondResult, firstResult] = await Promise.allSettled([earlyFinish, secondAdd, firstAdd]);
  assert.match(finishResult.reason?.message ?? '', /Cannot finish while adding/);
  assert.match(secondResult.reason?.message ?? '', /Cannot add while adding/);
  assert.equal(firstResult.status, 'fulfilled');

  assert.equal(await session.finish(), 'blob:longshot-result');
  const drawIndexes = harness.calls.flatMap((call, index) => call[0] === 'drawImage' ? [index] : []);
  const blobIndex = harness.calls.findIndex(call => call[0] === 'toBlob');
  assert.equal(drawIndexes.length, 1);
  assert.ok(drawIndexes[0] < blobIndex);
});

test('abort during a pending add does not restore the invalidated adding state', async () => {
  const frameDecode = deferred();
  const harness = createHarness();
  const decode = harness.dependencies.decodeImage;
  harness.dependencies.decodeImage = dataUrl => dataUrl === 'data:frame' ? frameDecode.promise : decode(dataUrl);
  const session = new ComposerSession(harness.dependencies);
  await session.begin({ cssWidth: 400, cssHeight: 800, firstDataUrl: 'data:first', innerWidth: 600, innerHeight: 400 });

  const adding = session.add({
    dataUrl: 'data:frame', placement: { sx: 1, sy: 2, sw: 3, sh: 4, dx: 5, dy: 6, dw: 7, dh: 8 }
  });
  session.abort();
  frameDecode.resolve({ width: 1200, height: 800, close() {} });

  await assert.rejects(adding, /invalidated/);
  assert.equal(session.state, 'idle');
  assert.equal(harness.calls.some(call => call[0] === 'drawImage'), false);
});
