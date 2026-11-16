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
        remove: () => log.push(`remove:${uis.length}`),
        reset: () => log.push('reset'),
        showModeOptions: (point) => log.push(`mode-options:${point?.x},${point?.y}`),
        hidePanel: () => log.push('hide-panel'),
        showConfirm: (point) => log.push(`confirm:${point?.x},${point?.y}`),
        setAdjustable: (adjustable) => log.push(`adjustable:${adjustable}`),
        placePanel: (point) => log.push(`panel:${point?.x},${point?.y}`),
        showActions: (point) => log.push(`actions:${point?.x},${point?.y}`),
        setVisible: (visible) => log.push(`visible:${visible}`),
        setMode: (highQuality, pending) => log.push(`mode:${highQuality}${pending ? ':pending' : ''}`),
        setFormat: (format) => log.push(`format:${format}`),
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
      log.push(`send:${message.type}`);
      return suppliedSendMessage?.(message) ?? Promise.resolve({ok: true});
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
    onCaptureRequested: state => log.push(`capture-requested:${state.taskId}`),
    onCopied: () => log.push('copied')
  });

  return {controller, frames, log, messages, uis};
}

function pointer(clientX, clientY, pointerId = 1) {
  return {clientX, clientY, pointerId};
}

function select(ui, from = [10, 20], to = [40, 70]) {
  ui.callbacks.onPointerDown(pointer(from[0], from[1]));
  ui.callbacks.onPointerMove(pointer(to[0], to[1]));
  ui.callbacks.onPointerUp(pointer(to[0], to[1]));
}

/** select + onConfirm：多数用例直接进入截图阶段。 */
function selectAndConfirm(ui, from, to) {
  select(ui, from, to);
  ui.callbacks.onConfirm();
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('框选完成后进入待确认：显示手柄与「确认截图 / 取消」，不直接截图', () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  assert.ok(log.includes('mode-options:undefined,undefined'));

  select(uis[0]);

  assert.deepEqual(messages, []);
  assert.ok(log.includes('hide-panel'));
  assert.ok(log.includes('adjustable:true'));
  assert.ok(log.includes('confirm:40,70'));
  assert.equal(log.some(entry => entry.startsWith('actions:')), false);
});

test('点「确认截图」才开始截图并隐藏扩展 UI', async () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  select(uis[0]);
  log.length = 0;

  uis[0].callbacks.onConfirm();

  assert.deepEqual(messages[0], makeMessage(MESSAGE.CAPTURE_REQUEST, 'task-1', {
    selection: {left: 10, top: 20, right: 40, bottom: 70, width: 30, height: 50},
    surfaceKind: 'element',
    highQuality: false
  }));
  assert.ok(log.includes('visible:false'));
  assert.equal(log.some(entry => entry.startsWith('actions:')), false);
});

test('点「取消」清掉选区并回到画质菜单', () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  select(uis[0]);
  log.length = 0;

  uis[0].callbacks.onCancelConfirm();

  assert.deepEqual(messages, []);
  assert.ok(log.includes('reset'));
  assert.ok(log.includes('mode-options:40,70'));
});

test('截图完成后才在指针附近弹出「格式 / 保存 / 复制 / 关闭」菜单', async () => {
  const {controller, log, uis} = createHarness();
  controller.enterSelection();
  selectAndConfirm(uis[0]);
  await flush();

  assert.ok(log.includes('visible:true'));
  assert.ok(log.includes('actions:40,70'));
});

test('截图失败时不弹菜单并释放本地状态', async () => {
  const {controller, log, uis} = createHarness({
    sendMessage: () => Promise.resolve({ok: false, code: 'CAPTURE_FAILED'})
  });
  controller.enterSelection();
  selectAndConfirm(uis[0]);
  await flush();

  assert.equal(log.some(entry => entry.startsWith('actions:')), false);
  assert.ok(log.includes('visible:false'));
  assert.equal(log.some(entry => entry.startsWith('visible:true')), false);
});

test('保存按所选格式发送 CAPTURE_SAVE 并收起 UI', async () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  selectAndConfirm(uis[0]);
  await flush();

  uis[0].callbacks.onSelectFormat('jpeg');
  assert.ok(log.includes('format:jpeg'));
  uis[0].callbacks.onSave();
  await flush();

  const save = messages.at(-1);
  assert.equal(save.type, MESSAGE.CAPTURE_SAVE);
  assert.equal(save.taskId, 'task-1');
  assert.deepEqual(save.payload, {format: 'jpeg'});
  assert.ok(log.some(entry => entry.startsWith('remove:')));
});

test('复制成功后通知已复制，关闭菜单时丢弃离屏画布', async () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  selectAndConfirm(uis[0]);
  await flush();

  uis[0].callbacks.onCopy();
  await flush();
  assert.equal(messages.at(-1).type, MESSAGE.CAPTURE_COPY);
  assert.ok(log.includes('copied'));

  // 第二次框选：确认后再点关闭 → 丢弃拼接结果
  controller.enterSelection();
  selectAndConfirm(uis[1]);
  await flush();
  uis[1].callbacks.onClose();
  await flush();
  assert.equal(messages.at(-1).type, MESSAGE.CAPTURE_DISCARD);
});

test('Esc 取消进行中的截图任务，并在已拼接时改为丢弃', async () => {
  const {controller, log, messages, uis} = createHarness();
  controller.enterSelection();
  selectAndConfirm(uis[0]);

  let prevented = false;
  controller.handleKeyDown({key: 'Escape', preventDefault: () => { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(messages.at(-1).type, MESSAGE.CANCEL);
  assert.equal(log.includes('restore:1'), false);

  // 已拼接完成后再按 Esc → CAPTURE_DISCARD 释放画布
  const second = createHarness();
  second.controller.enterSelection();
  selectAndConfirm(second.uis[0]);
  await flush();
  second.controller.handleKeyDown({key: 'Escape', preventDefault: () => {}});
  assert.equal(second.messages.at(-1).type, MESSAGE.CAPTURE_DISCARD);
});

test('截图完成后关闭菜单会解锁本地滚动表面', async () => {
  const {controller, log, uis} = createHarness();
  controller.enterSelection();
  select(uis[0]);
  await flush();

  log.length = 0;
  uis[0].callbacks.onClose();
  await flush();

  assert.ok(log.includes('restore:1'));
});

test('截图前选高清：开启缩放并让截图请求携带 highQuality 与原缩放', async () => {
  const {controller, messages, log, uis} = createHarness({
    sendMessage: message => Promise.resolve(
      message.type === MESSAGE.ENABLE_HIGH_QUALITY
        ? {ok: true, originalZoom: 1.25}
        : {ok: true}
    )
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');

  assert.equal(messages[0].type, MESSAGE.ENABLE_HIGH_QUALITY);
  assert.ok(log.includes('mode:true'));
  assert.ok(log.includes('mode:false:pending'));

  selectAndConfirm(uis[0]);
  const request = messages.find(message => message.type === MESSAGE.CAPTURE_REQUEST);
  assert.equal(request.payload.highQuality, true);
  assert.equal(request.payload.restoreZoomTo, 1.25);
});

test('切回普通画质会请求恢复缩放，后续截图不带高清参数', async () => {
  const {controller, messages, uis} = createHarness({
    sendMessage: message => Promise.resolve(
      message.type === MESSAGE.ENABLE_HIGH_QUALITY
        ? {ok: true, originalZoom: 1.25}
        : {ok: true}
    )
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');
  await uis[0].callbacks.onSelectMode('normal');

  const restore = messages.find(message => message.type === MESSAGE.DISABLE_HIGH_QUALITY);
  assert.deepEqual(restore.payload, {restoreZoomTo: 1.25});

  selectAndConfirm(uis[0]);
  const request = messages.find(message => message.type === MESSAGE.CAPTURE_REQUEST);
  assert.equal(request.payload.highQuality, false);
  assert.equal('restoreZoomTo' in request.payload, false);
});

test('已开启高清但未截图就取消时恢复原缩放', async () => {
  const {controller, messages, uis} = createHarness({
    sendMessage: message => Promise.resolve(
      message.type === MESSAGE.ENABLE_HIGH_QUALITY ? {ok: true, originalZoom: 1.25} : {ok: true}
    )
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');
  uis[0].callbacks.onClose();

  assert.deepEqual(messages.at(-1), makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
    restoreZoomTo: 1.25
  }));
});

test('高清截图失败后不再重复恢复缩放（后台已负责）', async () => {
  const {controller, messages, uis} = createHarness({
    sendMessage: message => Promise.resolve(
      message.type === MESSAGE.ENABLE_HIGH_QUALITY
        ? {ok: true, originalZoom: 1.25}
        : message.type === MESSAGE.CAPTURE_REQUEST
          ? {ok: false, code: 'CAPTURE_FAILED'}
          : {ok: true}
    )
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');
  selectAndConfirm(uis[0]);
  await flush();

  assert.equal(messages.some(message => message.type === MESSAGE.DISABLE_HIGH_QUALITY), false);
});

test('高清请求因消息通道失败时由前端恢复缩放', async () => {
  let captureAttempt = 0;
  const {controller, messages, uis} = createHarness({
    sendMessage: message => {
      if (message.type === MESSAGE.ENABLE_HIGH_QUALITY) return Promise.resolve({ok: true, originalZoom: 1.25});
      if (message.type === MESSAGE.CAPTURE_REQUEST) {
        captureAttempt += 1;
        return Promise.reject(new Error('message port closed'));
      }
      return Promise.resolve({ok: true});
    }
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');
  selectAndConfirm(uis[0]);
  await flush();

  assert.equal(captureAttempt, 1);
  assert.deepEqual(messages.at(-1), makeMessage(MESSAGE.DISABLE_HIGH_QUALITY, null, {
    restoreZoomTo: 1.25
  }));
});

test('开启高清失败时保持普通画质', async () => {
  const {controller, messages, uis} = createHarness({
    sendMessage: () => Promise.resolve({ok: false})
  });
  controller.enterSelection();
  await uis[0].callbacks.onSelectMode('highQuality');

  selectAndConfirm(uis[0]);
  const request = messages.find(message => message.type === MESSAGE.CAPTURE_REQUEST);
  assert.equal(request.payload.highQuality, false);
});

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

test('进入选区模式只弹画质菜单，不弹完成后的操作菜单', () => {
  const {controller, log, uis} = createHarness();
  controller.enterSelection();

  assert.ok(log.includes('mode-options:undefined,undefined'));
  assert.equal(log.some(entry => entry.startsWith('actions:')), false);
  assert.equal(uis.length, 1);
});

test('截图进行中再次进入选择模式会取消任务', async () => {
  const {controller, messages, uis} = createHarness();
  controller.enterSelection();
  selectAndConfirm(uis[0]);
  controller.enterSelection();

  assert.deepEqual(messages.map(({type}) => type), [MESSAGE.CAPTURE_REQUEST, MESSAGE.CANCEL]);
});

test('截图请求同步抛错时恢复本地滚动表面', () => {
  const {controller, log, uis} = createHarness({
    sendMessage: message => {
      if (message.type !== MESSAGE.ENABLE_HIGH_QUALITY) throw new Error('runtime unavailable');
      return {ok: true, originalZoom: 1};
    }
  });
  controller.enterSelection();
  select(uis[0]);
  log.length = 0;

  uis[0].callbacks.onConfirm();

  assert.ok(log.includes('restore:1'));
});

test('过小选区不会触发截图', () => {
  const {controller, messages, uis} = createHarness();
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerUp(pointer(10, 20));

  assert.deepEqual(messages, []);
});
