# 高清模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加可选高清模式，开启后本次截图临时提高当前标签页缩放并在结束后恢复。

**Architecture:** 内容脚本持有高清开关状态，并把 `highQuality` 写入 `CAPTURE_REQUEST` payload。后台 `runCapture` 在收到高清请求时调用依赖注入的 zoom 读写函数，将 tab zoom 临时设为 `1.5`，在 finally 中有界恢复原 zoom。

**Tech Stack:** Chrome Manifest V3、原生 JavaScript、Node.js 内置测试运行器。

## Global Constraints

- 普通模式默认不变。
- 高清模式只影响当前确认的截图任务。
- 高清模式 zoom factor 固定为 `1.5`。
- 截图成功、失败、取消和超时都必须尝试恢复原 zoom。
- 不依赖未合并的 `codex/speed-up-capture` 分支。

---

### Task 1: UI 请求携带高清状态

**Files:**
- Modify: `src/content/selection-ui.js`
- Test: `tests/selection-controller.test.js`

**Interfaces:**
- Produces: `CAPTURE_REQUEST` payload adds `highQuality: boolean`.
- Consumes: existing `createSelectionUI(callbacks)` callback object.

- [x] **Step 1: Write failing tests**

Add one test that confirms default `highQuality` is `false`, and another that toggles the UI callback before confirm and expects `highQuality: true`.

- [x] **Step 2: Run UI test and confirm failure**

Run: `node --test tests/selection-controller.test.js`

Expected: FAIL because payload does not include `highQuality`, and fake UI has no high-quality callback yet.

- [x] **Step 3: Implement UI state**

Add a “高清” toggle button to the selection controls, expose `setHighQuality(enabled)` on UI, and store `state.highQuality` in the selection controller. Include `highQuality: state.highQuality === true` in `CAPTURE_REQUEST`.

- [x] **Step 4: Run UI test and confirm pass**

Run: `node --test tests/selection-controller.test.js`

Expected: PASS.

### Task 2: 后台高清 zoom 生命周期

**Files:**
- Modify: `src/background/capture-controller.js`
- Modify: `src/background/service-worker.js`
- Test: `tests/capture-controller.test.js`

**Interfaces:**
- Consumes: `request.highQuality: boolean`.
- Produces: deps methods `getZoom(tabId): Promise<number>` and `setZoom(tabId, zoomFactor): Promise<void>`.

- [x] **Step 1: Write failing tests**

Add tests that verify high-quality requests set zoom to `1.5`, restore the original zoom on success, and restore it on capture failure.

- [x] **Step 2: Run background test and confirm failure**

Run: `node --test tests/capture-controller.test.js`

Expected: FAIL because zoom dependencies are not called yet.

- [x] **Step 3: Implement zoom handling**

In `runCapture`, if `request.highQuality` is true, read original zoom, set zoom to `1.5`, and save a restore function. Call restore in `finally` after page restore attempts. In `createChromeCaptureDeps`, expose `getZoom` and `setZoom` using `chrome.tabs.getZoom` and `chrome.tabs.setZoom`.

- [x] **Step 4: Run background test and confirm pass**

Run: `node --test tests/capture-controller.test.js`

Expected: PASS.

### Task 3: 全量验证和提交

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-18-high-quality-mode.md`

**Interfaces:**
- Produces: documented user-facing behavior and a clean commit.

- [x] **Step 1: Update README**

Document that “高清” temporarily increases tab zoom for the current capture and restores it after the task.

- [x] **Step 2: Run full regression**

Run: `npm test`

Expected: PASS, 0 failures.

- [x] **Step 3: Commit**

Run: `git add . && git commit -m "feat: add high quality capture mode"`
