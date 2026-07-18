# 选区操作条右侧定位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将完成选区后的操作条优先放在截图框右侧，并在空间不足时安全回退到左侧或视口内。

**Architecture:** 保持 `createSelectionUI` 的公开接口不变。在 `selection-ui.js` 内抽取纯定位函数，根据可见选框、视口宽度、操作条实际尺寸计算坐标；`showSelection` 仅应用该结果。测试通过轻量文档夹具验证右侧、左侧及钳制定位。

**Tech Stack:** Chrome Manifest V3 内容脚本、原生 JavaScript、Node.js 内置测试运行器。

## Global Constraints

- 操作条默认在选框右侧，间距为 8px，垂直中心对齐。
- 右侧不够时回退至左侧；两侧都不足时保持在视口 8px 安全边距内。
- 不改变按钮顺序、回调、拖拽选择或 Escape 取消行为。

---

### Task 1: 操作条定位函数与回归测试

**Files:**
- Modify: `src/content/selection-ui.js:1-20, 111-124`
- Test: `tests/scroll-surface.test.js:180-220`

**Interfaces:**
- Produces: `positionControls(rect, viewport, controlSize, viewportSize)`，返回 `{left, top}`。
- Consumes: `showSelection(rect, viewport)` 中计算出的可见选框和当前视口尺寸。

- [ ] **Step 1: 写入失败测试**

在 `tests/scroll-surface.test.js` 添加对 `positionControls` 的断言：右侧有空间时返回 `left: rect.right + 8`；右侧不足、左侧有空间时返回 `left: rect.left - 8 - controlSize.width`；两侧不足时 `left` 落在 `[8, viewportSize.width - controlSize.width - 8]`；`top` 为垂直居中后钳制到同一安全边距区间。

```js
assert.deepEqual(positionControls(
  {left: 20, top: 100, right: 120, bottom: 200},
  {width: 500, height: 400}, {width: 260, height: 56}
), {left: 128, top: 122});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/scroll-surface.test.js`

Expected: FAIL，提示 `positionControls` 尚未导出。

- [ ] **Step 3: 编写最小实现**

在 `src/content/selection-ui.js` 导出 `positionControls`。使用 8px 间距和安全边距，优先计算右侧位置；若右侧越界，计算左侧位置；最终将 `left`、垂直居中的 `top` 钳制在可视区域。`showSelection` 从 `controls.getBoundingClientRect()` 获取操作条尺寸并调用该函数，再将返回值写入 `controls.style.left/top`。

```js
const controlSize = controls.getBoundingClientRect();
const position = positionControls(visible, viewport, controlSize, {
  width: innerWidth,
  height: innerHeight
});
controls.style.left = `${position.left}px`;
controls.style.top = `${position.top}px`;
```

- [ ] **Step 4: 运行定位测试并确认通过**

Run: `node --test tests/scroll-surface.test.js`

Expected: PASS，所有选区 UI 及定位测试通过。

- [ ] **Step 5: 运行完整回归测试**

Run: `npm test`

Expected: PASS，0 failures。

- [ ] **Step 6: 提交实现**

```bash
git add tests/scroll-surface.test.js src/content/selection-ui.js
git commit -m "feat: place selection controls beside capture frame"
```
