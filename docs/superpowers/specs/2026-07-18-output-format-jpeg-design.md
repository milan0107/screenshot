# PNG / JPG 输出格式 Design

> 部分已被 `2026-07-19-post-capture-menu-design.md` 修订：菜单只在截图完成后出现，格式选择改在完成后决定，复制/保存走独立消息。本文保留其仍适用的设计细节。

## Goal

让用户在截图前选择输出格式：PNG（默认，无损）或 JPG（有损，体积更小）。格式选择只影响编码阶段，分段捕获、坐标换算与拼接流程完全不变。

## User Flow

1. 进入选区模式后，顶部控制条显示 `画质 [普通][高清] │ 格式 [PNG][JPG]`，默认 PNG 选中。
2. 用户点「JPG」→ 选中态切换，当前选区保持不变（格式不影响页面布局）。
3. 确认截图 → 逐屏捕获与拼接流程不变 → 按所选格式编码 → 下载文件扩展名随之变化（`.png` / `.jpg`）。
4. 若在选区完成后切换格式，不需要重新框选。

## Architecture

- `src/shared/protocol.js` 新增 `OUTPUT_FORMAT = {PNG: 'png', JPEG: 'jpeg'}`，作为唯一取值来源；content script 通过已有的 `protocol` 模块注入传给选择控制器。
- 新增 `src/shared/formats.js`：`mimeTypeFor` / `extensionFor` / `normalizeOutputFormat` / `isOutputFormat`，以及 `JPEG_QUALITY = 0.92`、`JPEG_BACKGROUND = '#ffffff'`。未知或缺失的格式一律回退 PNG。
- 内容脚本：`CAPTURE_REQUEST` payload 增加 `format`；选择控制器维护 `state.format`，`onSelectFormat()` 只更新 UI 选中态与状态，不重置选区。
- Service Worker：把 `payload.format` 透传给捕获协调器。
- 捕获控制器：`normalizeOutputFormat(request.format)` 决定文件名扩展名，并在 `COMPOSER_BEGIN` payload 中带上 `format`。
- 拼接端 `ComposerSession`：`begin()` 记录格式；JPG 在拿到 2D context 后立即用白色 `fillRect` 铺满整张画布（JPEG 无透明通道，否则未覆盖区域会变黑）；`finish()` 按格式调用 `toBlob(cb, mime, quality)`，PNG 不传质量参数；`#clearResources()` 把格式复位为 PNG。

## Constraints

- 不改变 PNG 默认行为与既有拼接算法。
- 不引入新的权限或消息类型（复用 `CAPTURE_REQUEST` / `COMPOSER_BEGIN` 的 payload）。
- JPG 不做二次重采样或缩放，仅改变编码方式。

## Testing

- `formats.test.js`：MIME / 扩展名映射、未知格式回退、JPEG 质量区间。
- `composer-session.test.js`：JPG 先铺白底再以 `image/jpeg` + 0.92 编码；未知格式回退 PNG 且不铺底；PNG 不传质量参数。
- `capture-controller.test.js`：`format: 'jpeg'` 时 `COMPOSER_BEGIN` 携带 `format`，下载文件名为 `.jpg`；未知格式回退 `.png`。
- `selection-controller.test.js`：默认 payload `format: 'png'`；选择 JPG 后 payload 为 `'jpeg'` 且切换格式不触发选区重置。
- `scroll-surface.test.js`：控制条含 `画质` 与 `格式` 两组按钮，`setFormat()` 正确切换 `aria-pressed`。
- 人工验收：见 README 人工验收清单中的 JPG / PNG 条目。
