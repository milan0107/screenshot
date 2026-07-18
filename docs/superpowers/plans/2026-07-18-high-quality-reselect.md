# 高清模式重新框选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在页面缩放前重新选择截图区域，消除响应式页面的高清截图错位。

**Architecture:** 选择控制器通过 Service Worker 开启高清缩放并保存响应中的原缩放；开启会先放大页面并清除旧选区。确认或取消时由内容脚本回传原缩放，避免 MV3 Worker 休眠丢失状态；截图控制器在现有 `finally` 清理链中恢复。

**Tech Stack:** Chrome Manifest V3、原生 ES modules、Node.js `node:test`。

## Global Constraints

- 普通截图流程不改变。
- 高清模式固定使用 150% 标签页缩放和 PNG，不进行插值放大。
- 不依赖或合并 `codex/speed-up-capture`。
- 不换算响应式布局改变前的旧框选坐标。

---

### Task 1: 高清缩放会话与协议

**Files:**
- Modify: `src/shared/protocol.js`
- Modify: `src/background/service-worker.js`
- Test: `tests/capture-controller.test.js`

**Interfaces:**
- Produces: `MESSAGE.ENABLE_HIGH_QUALITY`、`MESSAGE.DISABLE_HIGH_QUALITY`。
- Produces: `createHighQualitySessionManager({getZoom, setZoom})`，提供 `enable(tabId)`、`restore(tabId, originalZoom)`。

- [ ] **Step 1: 写入失败测试**

```js
test('高清会话开启时缩放且取消时恢复原缩放', async () => {
  const calls = [];
  const sessions = createHighQualitySessionManager({
    getZoom: async tabId => { calls.push(['getZoom', tabId]); return 1.25; },
    setZoom: async (tabId, zoom) => { calls.push(['setZoom', tabId, zoom]); }
  });
  const session = await sessions.enable(7);
  await sessions.restore(7, session.originalZoom);
  assert.deepEqual(calls, [
    ['getZoom', 7], ['setZoom', 7, 1.5], ['setZoom', 7, 1.25]
  ]);
});
```

- [ ] **Step 2: 确认测试为红色**

运行：`node --test tests/capture-controller.test.js`

预期：失败，因 `createHighQualitySessionManager` 尚未导出。

- [ ] **Step 3: 最小实现**

在协议对象中增加：

```js
ENABLE_HIGH_QUALITY: 'ENABLE_HIGH_QUALITY',
DISABLE_HIGH_QUALITY: 'DISABLE_HIGH_QUALITY',
```

在 Service Worker 中实现：

```js
export function createHighQualitySessionManager({getZoom, setZoom}) {
  const sessions = new Map();
  return {
    async enable(tabId) {
      if (sessions.has(tabId)) return sessions.get(tabId);
      const originalZoom = await getZoom(tabId);
      await setZoom(tabId, 1.5);
      return {originalZoom};
    },
    async restore(tabId, originalZoom) { if (Number.isFinite(originalZoom)) await setZoom(tabId, originalZoom); }
  };
}
```

`registerServiceWorker` 对开启/关闭消息用 `sender.tab.id` 调用该管理器；开启响应包含 `originalZoom`，`CAPTURE_REQUEST` 直接接收内容脚本回传的 `restoreZoomTo`。

- [ ] **Step 4: 确认测试为绿色**

运行：`node --test tests/capture-controller.test.js`

预期：该文件全部通过。

- [ ] **Step 5: 提交**

```powershell
git add src/shared/protocol.js src/background/service-worker.js tests/capture-controller.test.js
git commit -m "fix: manage high quality zoom before selection"
```

### Task 2: 在高清布局中重新框选

**Files:**
- Modify: `src/content/selection-ui.js`
- Test: `tests/selection-controller.test.js`

**Interfaces:**
- Consumes: 新增协议消息和异步 `sendMessage(message)`。
- Produces: 高清成功后清除旧选区但后续 `CAPTURE_REQUEST` 仍传递 `highQuality: true`；取消未确认选区时发送关闭消息。

- [ ] **Step 1: 写入失败测试**

```js
test('开启高清后清除旧选区并在放大布局中重新框选', async () => {
  const {controller, messages, log, uis} = createHarness({sendMessage: async () => ({ok: true})});
  controller.enterSelection();
  uis[0].callbacks.onPointerDown(pointer(10, 20));
  uis[0].callbacks.onPointerUp(pointer(40, 70));
  await uis[0].callbacks.onToggleHighQuality();
  assert.equal(messages[0].type, MESSAGE.ENABLE_HIGH_QUALITY);
  assert.ok(log.includes('reset'));
  uis[0].callbacks.onPointerDown(pointer(20, 30));
  uis[0].callbacks.onPointerUp(pointer(60, 90));
  uis[0].callbacks.onConfirm();
  assert.equal(messages.at(-1).payload.highQuality, true);
});
```

- [ ] **Step 2: 确认测试为红色**

运行：`node --test tests/selection-controller.test.js`

预期：失败，旧控制器仅切换布尔值。

- [ ] **Step 3: 最小实现**

让 `resetSelection({keepHighQuality = false} = {})` 只在参数为 false 时清除 `state.highQuality`。`onToggleHighQuality` 发送 `ENABLE_HIGH_QUALITY`，收到 `{ok: true}` 后设为 true 并调用 `resetSelection({keepHighQuality: true})`。`onPointerDown` 与重新选择保留该状态；`disposeActive` 在尚未生成 `taskId` 的高清状态发送 `DISABLE_HIGH_QUALITY`。

- [ ] **Step 4: 确认测试为绿色**

运行：`node --test tests/selection-controller.test.js`

预期：该文件全部通过。

- [ ] **Step 5: 提交**

```powershell
git add src/content/selection-ui.js tests/selection-controller.test.js
git commit -m "fix: reselect after enabling high quality"
```

### Task 3: 截图结束时恢复选择阶段保存的缩放

**Files:**
- Modify: `src/background/capture-controller.js`
- Modify: `README.md`
- Test: `tests/capture-controller.test.js`

**Interfaces:**
- Consumes: `request.restoreZoomTo` 是有限数字时，表示缩放已在选择阶段应用。
- Produces: 成功、失败或截图启动前标签页失活时恢复该值，且不重复调用 `setZoom(tabId, 1.5)`。

- [ ] **Step 1: 写入失败测试**

```js
test('选择阶段已开启高清时只在清理阶段恢复原缩放', async () => {
  const harness = makeHarness();
  await runCapture({taskId: 'task-hq-reselected', tabId: 7, windowId: 3,
    highQuality: true, restoreZoomTo: 1.25}, harness.deps);
  assert.equal(harness.events.includes('setZoom:7:1.5'), false);
  assert.ok(harness.events.indexOf('restore') < harness.events.lastIndexOf('setZoom:7:1.25'));
});

test('高清会话在截图启动前标签页失活时仍恢复原缩放', async () => {
  const harness = makeHarness({isActiveTab: async () => false});
  await assert.rejects(runCapture({taskId: 'task-hq-stale', tabId: 7, windowId: 3,
    highQuality: true, restoreZoomTo: 1.25}, harness.deps));
  assert.ok(harness.events.includes('setZoom:7:1.25'));
});
```

- [ ] **Step 2: 确认测试为红色**

运行：`node --test tests/capture-controller.test.js`

预期：失败，现有逻辑再次设为 1.5 并恢复至当前缩放。

- [ ] **Step 3: 最小实现与文档更新**

在 `try` 前初始化恢复回调，确保 `ensureActive()` 前的错误也会走 finally 恢复：

```js
let restoreZoom = Number.isFinite(request.restoreZoomTo)
  ? () => setZoom(tabId, request.restoreZoomTo)
  : null;
```

`applyHighQualityZoom` 遇到已存在的 `restoreZoom` 时直接返回；保留后续兼容分支。将 README 的高清说明改为：点击高清后页面先临时放大、旧框选清除，需要重新框选；完成或取消都会恢复。

- [ ] **Step 4: 确认全量测试为绿色**

运行：`npm test`

预期：全部通过且失败数为 0。

- [ ] **Step 5: 提交**

```powershell
git add src/background/capture-controller.js tests/capture-controller.test.js README.md
git commit -m "fix: restore high quality zoom after capture"
```
