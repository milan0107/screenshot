import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRect} from '../src/shared/geometry.js';
import {makeMessage, MESSAGE} from '../src/shared/protocol.js';
import {createSelectionController} from '../src/content/selection-ui.js';

function createHarness({sendMessage: suppliedSendMessage} = {}) {
  const log = [];
  const messages = [];
  const uis = [];
  const frames = new Map();
  let nextFrame = 1;
  let taskNumber = 0;
  let surfaceNumber = 0;

  function createFakeSurface() {
    const number = ++surfaceNumber;
    let scrollTop = 0;
    return {
      kind: 'element',
      lock: () => log.push(`lock:${number}`),
      restore: () => log.push(`restore:${number}`),
      clampClientPoint: (x, y) => ({x, y: Math.min(200, Math.max(0, y))}),
      toContentPoint: (x, y) => ({x, y: y + scrollTop}),
      getMetrics: () => ({
        scrollLeft: 0, scrollTop, maxScrollTop: 800,
        viewport: {left: 0, top: 0, width: 300, height: 200}
      }),
      setScrollTop(top) {
        scrollTop = top;
        log.push(`scroll:${top}`);
      }
    };
  }

  const controller = createSelectionController({
    createSelectionUI(callbacks) {
      const ui = {
        callbacks,
        host: {},
        remove: () => log.push(`remove:${uis.length + 1}`),
        reset: () => log.push('reset'),
        setComplete: (complete) => log.push(`complete:${complete}`),
        showHint: (message) => log.push(`hint:${message}`),
        setHighQuality: (enabled) => log.push(`high-quality:${enabled}`),
        showSelection: (rect) => log.push(`rect:${rect.left},${rect.top},${rect.right},${rect.bottom}`)
      };
      uis.push(ui);
      return ui;
    },
    createSurface: createFakeSurface,
    findScrollSurface: (target) => target,
    normalizeRect,
    makeMessage,
    MESSAGE,
    document: {elementsFromPoint: () => [{id: 'target'}]},
    randomUUID: () => `task-${++taskNumber}`,
    sendMessage(message) {
      messages.push(message);
      log.push(`send:${message.type}:${message.taskId}`);
      return suppliedSendMessage?.(message);
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
      log.push(`cancel-frame:${id}`);
    },
    onCaptureRequested: state => log.push(`capture-requested:${state.taskId}`)
  });

  return {controller, frames, log, messages, uis};
}

function pointer(clientX, clientY, pointerId = 1) {
  return {clientX, clientY, pointerId};
}

async function runNextFrame(frames) {
  const frame = frames.entries().next().value;
  assert.ok(frame);
  frames.delete(frame[0]);
  frame[1]();
  await Promise.resolve();
}

test('controller auto-scrolls at 28 pixels per frame at the surface edge', () => {
  const {controller, frames, log, uis} = createHarness();
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(20, 200));
  const firstFrame = frames.entries().next().value;
  frames.delete(firstFrame[0]);
  firstFrame[1]();

  assert.ok(log.includes('scroll:28'));
  assert.equal(frames.size, 1);
  uis[0].callbacks.onPointerUp(pointer(20, 200));
  assert.equal(frames.size, 0);
});

test('controller emits the capture payload and Esc cancels an active capture without locally restoring the page', async () => {
  const {controller, messages, log, uis} = createHarness();
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerMove(pointer(40, 70));
  uis[0].callbacks.onPointerUp(pointer(40, 70));
  uis[0].callbacks.onConfirm();

  assert.deepEqual(messages[0], makeMessage(MESSAGE.CAPTURE_REQUEST, 'task-1', {
    selection: {left: 10, top: 20, right: 40, bottom: 70, width: 30, height: 50},
    surfaceKind: 'element',
    highQuality: false
  }));
  let prevented = false;
  controller.handleKeyDown({key: 'Escape', preventDefault: () => { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(messages[1].type, MESSAGE.CANCEL);
  assert.equal(messages[1].taskId, 'task-1');
  assert.equal(log.includes('restore:1'), false);
});

test('开启高清后清除旧选区并在放大布局中重新框选', async () => {
  const {controller, messages, log, uis} = createHarness({
    sendMessage: async () => ({ok: true, originalZoom: 1.25})
  });
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerMove(pointer(40, 70));
  uis[0].callbacks.onPointerUp(pointer(40, 70));
  await uis[0].callbacks.onToggleHighQuality();

  assert.equal(messages[0].type, MESSAGE.ENABLE_HIGH_QUALITY);
  assert.ok(log.includes('reset'));
  assert.ok(log.includes('hint:高清已开启，请重新框选截图区域'));
  uis[0].callbacks.onPointerDown(pointer(20, 30));
  uis[0].callbacks.onPointerMove(pointer(60, 90));
  uis[0].callbacks.onPointerUp(pointer(60, 90));
  uis[0].callbacks.onConfirm();

  assert.deepEqual(messages[1], makeMessage(MESSAGE.CAPTURE_REQUEST, 'task-1', {
    selection: {left: 20, top: 30, right: 60, bottom: 90, width: 40, height: 60},
    surfaceKind: 'element',
    highQuality: true,
    restoreZoomTo: 1.25
  }));
  assert.ok(log.includes('high-quality:true'));
});

test('取消未确认的高清框选会请求恢复缩放', async () => {
  const {controller, messages, uis} = createHarness({
    sendMessage: async () => ({ok: true, originalZoom: 1.25})
  });
  controller.enterSelection();
  await uis[0].callbacks.onToggleHighQuality();
  uis[0].callbacks.onCancel();

  assert.deepEqual(messages.at(-1), makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
    restoreZoomTo: 1.25
  }));
});

test('entering selection again cancels a confirmed task without restoring it locally', async () => {
  const {controller, messages, log, uis} = createHarness();
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerUp(pointer(40, 70));
  uis[0].callbacks.onConfirm();
  controller.enterSelection();

  assert.deepEqual(messages.map(({type, taskId}) => ({type, taskId})), [
    {type: MESSAGE.CAPTURE_REQUEST, taskId: 'task-1'},
    {type: MESSAGE.CANCEL, taskId: 'task-1'}
  ]);
  assert.equal(log.includes('restore:1'), false);
  assert.equal(uis.length, 2);
});

test('capture request synchronously failing before background start restores the local surface', async () => {
  const {controller, log, uis} = createHarness({
    sendMessage: () => { throw new Error('runtime unavailable'); }
  });
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerUp(pointer(40, 70));

  assert.doesNotThrow(() => uis[0].callbacks.onConfirm());
  assert.equal(log.includes('restore:1'), true);
});
