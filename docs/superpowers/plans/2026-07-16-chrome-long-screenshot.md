# Chrome Long Screenshot Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chrome Manifest V3 扩展，让用户通过鼠标跨屏框选主页面或单个内部纵向滚动容器，并将分段截图拼接后直接下载为 PNG。

**Architecture:** Service Worker 负责标签页权限、截图编排和下载；Content Script 负责选区 UI、滚动表面识别、自动滚动和页面状态恢复；Offscreen Document 负责位图裁剪、拼接和 PNG 编码。坐标、分段与裁剪计算放在无 DOM 的共享 ES 模块中，以 Node 内置测试运行器进行测试。

**Tech Stack:** Chrome Extensions Manifest V3、原生 JavaScript ES Modules、Shadow DOM、Canvas/Offscreen Document、Node.js `node:test`，不引入第三方运行时依赖。

## Global Constraints

- 支持浏览器主页面和单个内部纵向滚动容器。
- 仅支持纵向自动滚动，不支持嵌套多层联合滚动、跨域 iframe、虚拟列表历史内容和浏览器受保护页面。
- 截图完成后直接下载 PNG，不增加预览或二次裁剪页面。
- 业务坐标统一使用 CSS 像素；截图裁剪使用实际位图宽度与 `window.innerWidth` 算出的缩放比。
- 捕获严格串行，并在成功、失败、取消和超时时恢复页面状态。
- 相邻两次 `captureVisibleTab()` 调用至少间隔 550 ms，低于 Chrome 每秒两次的调用上限。
- 输出位图任一边不超过 30,000 像素，总像素不超过 200 MP。
- 权限限定为 `activeTab`、`scripting`、`offscreen`、`downloads`。
- 不修改或提交工作区中无关的 `address-standardization-design.md`。

---

## File Map

- `manifest.json`：Manifest V3 声明、权限、后台与可访问共享模块。
- `package.json`：Node 内置测试命令。
- `src/shared/protocol.js`：跨组件消息名称和错误码。
- `src/shared/geometry.js`：矩形、缩放、裁剪与输出放置计算。
- `src/shared/segments.js`：基于实际滚动范围生成捕获分段。
- `src/shared/limits.js`：输出尺寸与内存预检。
- `src/background/capture-controller.js`：可注入依赖的截图任务状态机。
- `src/background/service-worker.js`：Chrome API 适配、注入、离屏页面和下载。
- `src/content/scroll-surface.js`：主页面/内部容器适配器、识别和状态恢复。
- `src/content/selection-ui.js`：Shadow DOM 遮罩、选框和工具条。
- `src/content/content-script.js`：选择交互、边缘自动滚动和捕获消息处理。
- `src/offscreen/offscreen.html`：离屏页面入口。
- `src/offscreen/offscreen.js`：Canvas 会话、分段绘制和 PNG 编码。
- `tests/*.test.js`：纯逻辑和任务状态机测试。
- `fixtures/manual-test.html`：覆盖长页面、内部容器、吸顶栏和懒加载的人工验收页。
- `README.md`：加载扩展、使用方法、限制和验收步骤。

---

### Task 1: Extension Skeleton and Message Contract

**Files:**
- Create: `manifest.json`
- Create: `package.json`
- Create: `src/shared/protocol.js`
- Create: `src/offscreen/offscreen.html`
- Test: `tests/protocol.test.js`

**Interfaces:**
- Produces: `MESSAGE`, `ERROR_CODE`, `makeMessage(type, taskId, payload)` for every later component.
- Consumes: none.

- [ ] **Step 1: Write the failing protocol test**

```js
// tests/protocol.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE, makeMessage } from '../src/shared/protocol.js';

test('makeMessage creates a task-scoped envelope', () => {
  assert.deepEqual(makeMessage(MESSAGE.SCROLL_TO, 'task-1', { top: 120 }), {
    source: 'longshot', type: 'SCROLL_TO', taskId: 'task-1', payload: { top: 120 }
  });
});

test('makeMessage rejects an unknown type', () => {
  assert.throws(() => makeMessage('UNKNOWN', 'task-1'), /Unknown message type/);
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `node --test tests/protocol.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shared/protocol.js`.

- [ ] **Step 3: Add the manifest, package script, protocol, and offscreen shell**

```json
// package.json
{
  "name": "chrome-longshot",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/*.test.js" }
}
```

```js
// src/shared/protocol.js
export const MESSAGE = Object.freeze({
  ENTER_SELECTION: 'ENTER_SELECTION', CAPTURE_REQUEST: 'CAPTURE_REQUEST',
  PREPARE_CAPTURE: 'PREPARE_CAPTURE', SCROLL_TO: 'SCROLL_TO',
  SET_FIXED_VISIBILITY: 'SET_FIXED_VISIBILITY', RESTORE_PAGE: 'RESTORE_PAGE',
  COMPOSER_BEGIN: 'COMPOSER_BEGIN', COMPOSER_ADD: 'COMPOSER_ADD',
  COMPOSER_FINISH: 'COMPOSER_FINISH', COMPOSER_RELEASE: 'COMPOSER_RELEASE',
  COMPOSER_ABORT: 'COMPOSER_ABORT',
  CANCEL: 'CANCEL', ERROR: 'ERROR'
});
export const ERROR_CODE = Object.freeze({
  RESTRICTED_PAGE: 'RESTRICTED_PAGE', STALE_TASK: 'STALE_TASK',
  SURFACE_CHANGED: 'SURFACE_CHANGED', CAPTURE_FAILED: 'CAPTURE_FAILED',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE', CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT'
});
export function makeMessage(type, taskId, payload = {}) {
  if (!Object.values(MESSAGE).includes(type)) throw new Error(`Unknown message type: ${type}`);
  return { source: 'longshot', type, taskId, payload };
}
```

```json
// manifest.json
{
  "manifest_version": 3,
  "name": "长截图选区工具",
  "version": "0.1.0",
  "description": "跨屏框选页面或滚动容器并下载长截图",
  "permissions": ["activeTab", "scripting", "offscreen", "downloads"],
  "action": {"default_title": "选择长截图区域"},
  "background": {"service_worker": "src/background/service-worker.js", "type": "module"},
  "web_accessible_resources": [{
    "resources": ["src/shared/*.js", "src/content/scroll-surface.js", "src/content/selection-ui.js"],
    "matches": ["<all_urls>"]
  }]
}
```

```html
<!-- src/offscreen/offscreen.html -->
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>长截图拼接</title></head>
<body><script type="module" src="offscreen.js"></script></body></html>
```

- [ ] **Step 4: Run tests and validate the manifest parses**

Run: `npm test`

Expected: 2 tests PASS.

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"`

Expected: `manifest ok`.

- [ ] **Step 5: Commit the skeleton**

```bash
git add manifest.json package.json src/shared/protocol.js src/offscreen/offscreen.html tests/protocol.test.js
git commit -m "chore: scaffold long screenshot extension"
```

---

### Task 2: Geometry, Crop Placement, and Resource Limits

**Files:**
- Create: `src/shared/geometry.js`
- Create: `src/shared/limits.js`
- Test: `tests/geometry.test.js`
- Test: `tests/limits.test.js`

**Interfaces:**
- Produces: `normalizeRect(a, b)`, `intersectRect(a, b)`, `computeFramePlacement(input)`, `validateOutput(width, height)`.
- Consumes: plain objects `{left, top, right, bottom, width, height}` in CSS pixels.

- [ ] **Step 1: Write failing geometry and limit tests**

```js
// tests/geometry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRect, computeFramePlacement } from '../src/shared/geometry.js';

test('normalizes a drag in any direction', () => {
  assert.deepEqual(normalizeRect({x: 30, y: 50}, {x: 10, y: 20}),
    {left: 10, top: 20, right: 30, bottom: 50, width: 20, height: 30});
});

test('maps visible content into screenshot source and output destination', () => {
  assert.deepEqual(computeFramePlacement({
    selection: {left: 20, top: 100, right: 220, bottom: 900},
    scrollLeft: 0, scrollTop: 500,
    viewport: {left: 10, top: 50, width: 300, height: 300},
    scaleX: 2, scaleY: 2
  }), {sx: 60, sy: 100, sw: 400, sh: 600, dx: 0, dy: 800, dw: 400, dh: 600});
});
```

```js
// tests/limits.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../src/shared/limits.js';

test('rejects an oversized edge', () => assert.deepEqual(validateOutput(1000, 30001),
  {ok: false, reason: 'edge'}));
test('accepts a normal output', () => assert.deepEqual(validateOutput(2000, 10000),
  {ok: true, estimatedBytes: 80000000}));
```

- [ ] **Step 2: Run the tests and verify missing-module failures**

Run: `node --test tests/geometry.test.js tests/limits.test.js`

Expected: both test files FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure geometry and limits**

```js
// src/shared/geometry.js
export function normalizeRect(a, b) {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
export function intersectRect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right <= left || bottom <= top ? null :
    { left, top, right, bottom, width: right - left, height: bottom - top };
}
export function computeFramePlacement({selection, scrollLeft, scrollTop, viewport, scaleX, scaleY}) {
  const visible = intersectRect(selection, {
    left: scrollLeft, top: scrollTop,
    right: scrollLeft + viewport.width, bottom: scrollTop + viewport.height
  });
  if (!visible) return null;
  const round = Math.round;
  return {
    sx: round((viewport.left + visible.left - scrollLeft) * scaleX),
    sy: round((viewport.top + visible.top - scrollTop) * scaleY),
    sw: round(visible.width * scaleX), sh: round(visible.height * scaleY),
    dx: round((visible.left - selection.left) * scaleX),
    dy: round((visible.top - selection.top) * scaleY),
    dw: round(visible.width * scaleX), dh: round(visible.height * scaleY)
  };
}
```

```js
// src/shared/limits.js
export const MAX_EDGE = 30000;
export const MAX_PIXELS = 200_000_000;
export function validateOutput(width, height) {
  if (width <= 0 || height <= 0) return {ok: false, reason: 'empty'};
  if (width > MAX_EDGE || height > MAX_EDGE) return {ok: false, reason: 'edge'};
  if (width * height > MAX_PIXELS) return {ok: false, reason: 'pixels'};
  return {ok: true, estimatedBytes: width * height * 4};
}
```

- [ ] **Step 4: Run the focused and full tests**

Run: `node --test tests/geometry.test.js tests/limits.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit geometry and limits**

```bash
git add src/shared/geometry.js src/shared/limits.js tests/geometry.test.js tests/limits.test.js
git commit -m "feat: add screenshot geometry calculations"
```

---

### Task 3: Capture Segmentation

**Files:**
- Create: `src/shared/segments.js`
- Test: `tests/segments.test.js`

**Interfaces:**
- Produces: `buildScrollTargets({selectionTop, selectionBottom, viewportHeight, maxScrollTop}) -> number[]`.
- Consumes: content-space CSS pixel values from Content Script.

- [ ] **Step 1: Write failing segmentation tests**

```js
// tests/segments.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollTargets } from '../src/shared/segments.js';

test('covers selection with a partial final segment', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 100, selectionBottom: 850,
    viewportHeight: 300, maxScrollTop: 1200}), [100, 400, 550]);
});
test('clamps targets near the end and removes duplicates', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 900, selectionBottom: 1300,
    viewportHeight: 300, maxScrollTop: 1000}), [900, 1000]);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test tests/segments.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic target generation**

```js
// src/shared/segments.js
export function buildScrollTargets({selectionTop, selectionBottom, viewportHeight, maxScrollTop}) {
  if (selectionBottom <= selectionTop || viewportHeight <= 0) throw new RangeError('Invalid capture range');
  const first = Math.min(Math.max(0, selectionTop), maxScrollTop);
  const last = Math.min(Math.max(0, selectionBottom - viewportHeight), maxScrollTop);
  const targets = [first];
  for (let top = first + viewportHeight; top < last; top += viewportHeight) targets.push(top);
  targets.push(last);
  return [...new Set(targets)];
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/segments.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit segmentation**

```bash
git add src/shared/segments.js tests/segments.test.js
git commit -m "feat: calculate long screenshot segments"
```

---

### Task 4: Scroll Surface Detection and Selection UI

**Files:**
- Create: `src/content/scroll-surface.js`
- Create: `src/content/selection-ui.js`
- Create: `src/content/content-script.js`
- Test: `tests/scroll-surface.test.js`

**Interfaces:**
- Produces: `isScrollableElement(element, style)`, `findScrollSurface(start)`, `createSurface(element)`, `createSelectionUI(callbacks)`.
- Content Script receives `ENTER_SELECTION`, emits `CAPTURE_REQUEST`, and retains one active task.
- Consumes: `normalizeRect`, `makeMessage`, `MESSAGE`.

- [ ] **Step 1: Write failing tests for scrollability rules**

```js
// tests/scroll-surface.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isScrollableMetrics } from '../src/content/scroll-surface.js';

test('accepts an overflowing vertical auto container', () => {
  assert.equal(isScrollableMetrics({overflowY: 'auto', scrollHeight: 900, clientHeight: 300}), true);
});
test('rejects visible overflow and non-overflowing elements', () => {
  assert.equal(isScrollableMetrics({overflowY: 'visible', scrollHeight: 900, clientHeight: 300}), false);
  assert.equal(isScrollableMetrics({overflowY: 'scroll', scrollHeight: 300, clientHeight: 300}), false);
});
```

- [ ] **Step 2: Verify missing-module failure**

Run: `node --test tests/scroll-surface.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement surface adapters**

Implement `isScrollableMetrics` exactly as the tested predicate. `findScrollSurface(start)` walks through `parentElement`, uses `getComputedStyle`, and returns the nearest matching element or `document.scrollingElement`. `createSurface(element)` exposes:

```js
{
  kind: element === document.scrollingElement ? 'page' : 'element',
  getMetrics(), // {scrollLeft, scrollTop, clientWidth, clientHeight, scrollHeight, maxScrollTop, viewport}
  setScrollTop(top),
  toContentPoint(clientX, clientY),
  clampClientPoint(clientX, clientY),
  lock(), restore()
}
```

For an internal element, `viewport.left/top` equals `getBoundingClientRect().left/top + clientLeft/clientTop`; width/height equals `clientWidth/clientHeight`. For the page, viewport is `{left:0, top:0, width:innerWidth, height:innerHeight}`. `lock()` stores and disables smooth scrolling; `restore()` reinstates the exact prior inline values and original scroll position.

- [ ] **Step 4: Implement selection UI and interaction controller**

Create one fixed host with a closed Shadow Root. Add mask, selection rectangle, and three buttons labelled `确认截图`, `重新选择`, `取消`. `content-script.js` dynamically imports the shared modules, uses pointer capture, and records both endpoints in surface content coordinates. A `requestAnimationFrame` loop scrolls when the pointer is within 64 CSS pixels of the surface edge, with speed from 4 to 28 CSS pixels per frame. Clamp internal-container pointer coordinates to its visible viewport. `Esc` cancels and removes the host.

On confirm, send:

```js
makeMessage(MESSAGE.CAPTURE_REQUEST, crypto.randomUUID(), {
  selection, surfaceKind: surface.kind
})
```

Keep the actual element reference only inside the Content Script; later task messages address the current active task rather than serializing DOM nodes.

- [ ] **Step 5: Run automated tests and perform a syntax check**

Run: `npm test`

Expected: all tests PASS.

Run: `node --check src/content/content-script.js`

Expected: exit code 0.

- [ ] **Step 6: Commit selection behavior**

```bash
git add src/content tests/scroll-surface.test.js
git commit -m "feat: add cross-screen selection interface"
```

---

### Task 5: Offscreen Canvas Composer

**Files:**
- Create: `src/offscreen/offscreen.js`
- Test: `tests/composer-session.test.js`

**Interfaces:**
- Consumes: `COMPOSER_BEGIN {cssWidth,cssHeight,firstDataUrl,innerWidth,innerHeight}`, `COMPOSER_ADD {dataUrl,placement}`, `COMPOSER_FINISH`, `COMPOSER_RELEASE`, `COMPOSER_ABORT`.
- Produces: `{ok:true,scaleX,scaleY,width,height}` on begin and `{ok:true,objectUrl}` on finish; release/abort revokes object URLs and canvas resources.
- Uses: `validateOutput` and placements from `computeFramePlacement`.

- [ ] **Step 1: Write a failing session-state test**

Extract a DOM-free `ComposerSession` class from `offscreen.js` whose constructor receives `{createCanvas, decodeImage, createObjectURL, revokeObjectURL}`. Test that async begin measures the first image and rejects oversized output, add draws using all eight placement arguments, async finish returns a Blob URL, and release/abort revoke it and clear the canvas reference.

```js
const calls = [];
const canvas = { getContext: () => ({drawImage: (...args) => calls.push(args)}),
  toBlob: callback => callback(new Blob(['png'], {type:'image/png'})) };
const session = new ComposerSession({
  createCanvas: () => canvas,
  decodeImage: async () => ({width:1200, height:800, close(){}}),
  createObjectURL: () => 'blob:longshot-result', revokeObjectURL: url => calls.push(['revoke', url])
});
const begin = await session.begin({cssWidth: 400, cssHeight: 800,
  firstDataUrl:'data:image/png;base64,x', innerWidth:600, innerHeight:400});
assert.deepEqual(begin, {scaleX:2, scaleY:2, width:800, height:1600});
await session.add({dataUrl: 'data:image/png;base64,x', placement:
  {sx:1,sy:2,sw:3,sh:4,dx:5,dy:6,dw:7,dh:8}});
assert.deepEqual(calls[0].slice(1), [1,2,3,4,5,6,7,8]);
assert.equal(await session.finish(), 'blob:longshot-result');
session.release();
assert.deepEqual(calls.at(-1), ['revoke', 'blob:longshot-result']);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/composer-session.test.js`

Expected: FAIL because `ComposerSession` is not exported.

- [ ] **Step 3: Implement the composer and Chrome message listener**

`ComposerSession.begin()` decodes `firstDataUrl`, computes `scaleX = bitmap.width / innerWidth` and `scaleY = bitmap.height / innerHeight`, calls `validateOutput(cssWidth*scaleX, cssHeight*scaleY)`, creates a canvas with exact rounded output pixels, and throws an error carrying `OUTPUT_TOO_LARGE` when invalid. `add()` decodes with `createImageBitmap(await (await fetch(dataUrl)).blob())` and calls `drawImage` with the placement. `finish()` uses `canvas.toBlob(callback, 'image/png')` and returns `URL.createObjectURL(blob)`. `release()` revokes the URL, zeroes the canvas, and clears references; `abort()` performs the same cleanup without producing output.

The message listener accepts only `source === 'longshot'`, rejects stale task IDs, maps all errors into serializable `{ok:false, code, message}`, and always closes decoded bitmaps after drawing.

- [ ] **Step 4: Run tests**

Run: `node --test tests/composer-session.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the composer**

```bash
git add src/offscreen/offscreen.js tests/composer-session.test.js
git commit -m "feat: compose screenshot frames offscreen"
```

---

### Task 6: Capture Controller and Chrome API Wiring

**Files:**
- Create: `src/background/capture-controller.js`
- Create: `src/background/service-worker.js`
- Test: `tests/capture-controller.test.js`

**Interfaces:**
- `runCapture(request, deps)` consumes `selection`, surface metrics, and injected async operations `sendTab`, `captureVisible`, `sendOffscreen`, `download`, `isActiveTab`.
- Produces: one downloaded PNG or a typed error; always calls `RESTORE_PAGE` and aborts unused composer sessions.

- [ ] **Step 1: Write failing orchestration tests**

Use fakes that append operation names to an array. Assert the successful order includes `prepare -> scroll -> capture -> composerBegin -> composerAdd -> composerFinish -> download -> composerRelease -> restore`. Add a failure test where `captureVisible` throws and assert the final operation is `restore` and `composerAbort` occurred.

```js
assert.deepEqual(events.slice(-2), ['composerAbort', 'restore']);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/capture-controller.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the dependency-injected controller**

`runCapture` performs these exact operations inside `try/finally`:

1. Validate the tab is still active.
2. Send `PREPARE_CAPTURE`, receiving selection, original position, metrics and fixed-element metadata.
3. Generate scroll targets and iterate them serially; before each capture wait until at least 550 ms has elapsed since the previous `captureVisibleTab()` call.
4. On the first target send `SCROLL_TO`, verify surface invariants and capture; pass that screenshot to `COMPOSER_BEGIN` so the offscreen document returns the actual X/Y scale and validates the output.
5. For the first and later targets compute placement using that scale and send `COMPOSER_ADD`; later targets follow `SCROLL_TO -> invariant check -> throttle -> capture -> placement -> add`.
6. Keep fixed/sticky elements visible for index 0 and hidden for later indices.
7. Finish and download `longshot-YYYYMMDD-HHmmss.png`; after the download API accepts the Blob URL, send `COMPOSER_RELEASE`.
8. On error send `COMPOSER_ABORT`; in `finally` send `RESTORE_PAGE`.

Use a 60-second task timeout via `AbortController`; check cancellation between each awaited operation.

- [ ] **Step 4: Wire real Chrome APIs**

`service-worker.js` handles `chrome.action.onClicked`, injects `src/content/content-script.js`, and sends `ENTER_SELECTION`. On `CAPTURE_REQUEST`, create the offscreen document once with reason `BLOBS`, then call `runCapture` using:

- `chrome.tabs.sendMessage(tabId, message)`;
- `chrome.tabs.captureVisibleTab(windowId, {format:'png'})`;
- `chrome.runtime.sendMessage(message)` for offscreen operations;
- `chrome.downloads.download({url:objectUrl, filename, saveAs:false})`.

Reject a task if its original tab is no longer the active tab in the original window. Return user-facing Chinese messages for every `ERROR_CODE`.

- [ ] **Step 5: Run tests and syntax checks**

Run: `npm test`

Expected: all tests PASS.

Run: `node --check src/background/service-worker.js && node --check src/background/capture-controller.js`

Expected: exit code 0.

- [ ] **Step 6: Commit orchestration**

```bash
git add src/background tests/capture-controller.test.js
git commit -m "feat: orchestrate scrolling screenshot capture"
```

---

### Task 7: Capture-Time Recovery, Sticky Deduplication, and Error UI

**Files:**
- Modify: `src/content/scroll-surface.js`
- Modify: `src/content/content-script.js`
- Modify: `src/content/selection-ui.js`
- Test: `tests/page-state.test.js`

**Interfaces:**
- Produces: `PageStateGuard` with `prepare()`, `setRepeatedElementsVisible(visible)`, `assertStable()`, `restore()`.
- Consumes: current active surface and original selection task.

- [ ] **Step 1: Write failing state restoration tests**

Use fake style objects and fake elements. Verify `restore()` returns every exact prior inline property, original scroll position, and visibility even when `prepare()` is followed by an exception. Verify calling `restore()` twice is harmless.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/page-state.test.js`

Expected: FAIL because `PageStateGuard` is not exported.

- [ ] **Step 3: Implement capture-time state guarding**

`prepare()` records surface scroll position, `scrollBehavior`, `overflow`, and every modified element's inline `visibility`. It installs capture-phase listeners preventing wheel, touchmove, pointer and scroll-changing key events. It identifies visible intersecting `position: fixed` elements and sticky elements currently touching their sticky edge. `setRepeatedElementsVisible(false)` applies `visibility:hidden !important`; `restore()` reverses each mutation and listener in reverse order.

`assertStable()` compares the current scroll viewport rectangle, client size, and content height with prepared metrics. Allow at most 2 CSS pixels of viewport drift and 10 CSS pixels of content-height drift; otherwise throw `SURFACE_CHANGED`.

- [ ] **Step 4: Add progress and error feedback**

During capture the UI shows `正在截取… N/M` without intercepting the screenshot; hide the UI immediately before each capture and restore it afterward. Map errors to concise Chinese text, including `此页面不允许截图`, `页面内容发生变化，请重新截取`, `截图尺寸过大，请缩小选区`, and `截图已取消`. Ensure the background always receives an acknowledgement for `RESTORE_PAGE`.

- [ ] **Step 5: Run full tests**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit resilience work**

```bash
git add src/content tests/page-state.test.js
git commit -m "feat: restore page state after screenshot tasks"
```

---

### Task 8: Manual Fixture, Documentation, and End-to-End Verification

**Files:**
- Create: `fixtures/manual-test.html`
- Create: `README.md`
- Modify: `manifest.json` only if Chrome validation reveals a required correction.

**Interfaces:**
- Consumes: the complete unpacked extension.
- Produces: repeatable human verification instructions and a release-ready folder.

- [ ] **Step 1: Create a deterministic manual test page**

Build a dependency-free HTML page containing:

- a 4,000 CSS-pixel main page with numbered 100-pixel horizontal bands;
- a fixed top bar labelled `FIXED HEADER`;
- an 800×420 internal `overflow-y:auto` container with 30 numbered rows;
- a sticky row header inside that container;
- three images loaded after 300 ms, 600 ms, and 900 ms using inline SVG data URLs;
- visible rulers showing expected content-space Y coordinates.

Serve it with `npx --yes serve .` only if `npx` is already available; otherwise use `python -m http.server 8000`. Do not add either server as a project dependency.

- [ ] **Step 2: Document installation and limitations**

In `README.md`, document: open `chrome://extensions`, enable Developer mode, choose `Load unpacked`, select the repository directory, click the extension icon, drag near an edge to auto-scroll, confirm, and inspect the downloaded PNG. Include the unsupported cases and output limits from Global Constraints.

- [ ] **Step 3: Run automated verification**

Run: `npm test`

Expected: all tests PASS with zero failures.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 4: Load and verify the unpacked extension in Chrome**

Perform these cases on `fixtures/manual-test.html`:

1. Main page: select from band 3 through band 24; verify each band appears once.
2. Internal container: select rows 4 through 22; verify each row appears once and width is clipped to the container.
3. Start from the middle of each surface and drag upward; verify normalized selection and auto-scroll.
4. Run at 80%, 100%, and 125% page zoom; verify no visible seam or offset.
5. Cancel with `Esc`; verify original scroll position and page controls work.
6. Force an error by removing the selected container in DevTools during capture; verify the error text and full recovery.

- [ ] **Step 5: Inspect Chrome extension errors**

Open the extension's Service Worker inspector and the page console. Expected: no uncaught exception, rejected promise, missing resource, or Manifest warning during all six cases.

- [ ] **Step 6: Commit fixture and documentation**

```bash
git add fixtures/manual-test.html README.md manifest.json
git commit -m "docs: add long screenshot verification guide"
```

---

## Final Verification Gate

- [ ] Run `npm test` and record the passing test count.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run `git status --short` and confirm only the pre-existing untracked `address-standardization-design.md` remains.
- [ ] Confirm both main-page and internal-container PNGs have the expected pixel dimensions at 100% zoom.
- [ ] Confirm no page state remains modified after success, cancellation, forced failure, or timeout.
