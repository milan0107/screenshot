# 复制到剪贴板 Design

> 部分已被 `2026-07-19-post-capture-menu-design.md` 修订：菜单只在截图完成后出现，格式选择改在完成后决定，复制/保存走独立消息。本文保留其仍适用的设计细节。

## Goal

在选区完成后的菜单里增加「复制到剪贴板」：对选区执行与「确认截图」相同的逐屏捕获与拼接，但不打开保存窗口，而是把成品图片写入系统剪贴板，用户可直接在聊天窗口、文档、图片编辑器里粘贴。

## User Flow

1. 框选完成 → 菜单展开：`确认截图` / `复制到剪贴板` / `重新选择` / `取消`。
2. 点「复制到剪贴板」→ 逐屏捕获、拼接（流程与下载完全一致）→ 写入剪贴板。
3. 成功：页面顶部提示「已复制到剪贴板」，约 2.4 秒后自动消失；页面状态照常恢复。
4. 失败（剪贴板被拒绝、写入异常）：显示「复制到剪贴板失败，请重试」，页面状态照常恢复。

## Architecture

- `CAPTURE_REQUEST.payload.output`：`'download'`（默认）或 `'clipboard'`，由选择控制器按点击的按钮填写；后台 `runCapture` 归一化为 `CAPTURE_OUTPUT`。
- 拼接端新增 `COMPOSER_EXPORT`：调用 `canvas.toDataURL('image/png')` 返回 data URL。**固定 PNG**，因为 Chrome 的 `ClipboardItem` 写图片只稳定支持 `image/png`；因此剪贴板路径不做 `COMPOSER_FINISH`（不生成 Blob/objectURL），一次编码即可。
- 后台新增 `CLIPBOARD_WRITE`：把 data URL 发给内容脚本执行实际写入。图片字节必须跨进程传给页面，因为离屏文档没有焦点，`navigator.clipboard.write` 会抛 `Document is not focused`；页面（活动标签页）才是可靠的写入方。
- 内容脚本 `writeClipboardImage()`：优先 `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`；在 http 等非安全上下文（无异步剪贴板 API）回退到 `copy` 事件 + `document.execCommand('copy')` 写入 `clipboardData.items`。
- `manifest.json` 增加 `clipboardWrite` 权限（不产生用户可见警告）。
- 失败映射：内容脚本把写入异常包装为 `CAPTURE_FAILED` + 中文提示，后台按既有错误链路处理（abort composer、恢复页面、显示提示），不吞掉原始 cause。
- 成功提示：内容脚本记录本次任务的 `output`，在 `RESTORE_PAGE`（非错误路径）时用被动反馈条显示「已复制到剪贴板」，并用可注入的定时器在 2.4 秒后移除。

## Constraints

- 不改变下载路径的行为与文件命名。
- 不新增 permissions 之外的 API；不引入 `clipboardRead`。
- 剪贴板路径不产生任何文件下载，也不弹出「另存为」。
- 捕获、拼接、页面恢复、超时与取消语义与下载路径完全一致。

## Testing

- `capture-controller.test.js`：`output: 'clipboard'` 时不下载、不走 `COMPOSER_FINISH`，按 `COMPOSER_EXPORT → CLIPBOARD_WRITE → COMPOSER_RELEASE` 顺序执行并返回 `{copied: true}`；写入失败时报 `CAPTURE_FAILED`、abort 拼接并恢复页面。
- `content-message-handler.test.js`：`CLIPBOARD_WRITE` 调用 `writeClipboard`、失败映射为中文错误、过期任务返回 `STALE_TASK`；复制成功后 `RESTORE_PAGE` 显示「已复制到剪贴板」并注册 2.4s 自动消失定时器；下载任务不提示。
- `composer-session.test.js`：`exportDataUrl()` 在 `begun/finished` 状态导出 PNG data URL，`idle` 状态拒绝；`COMPOSER_EXPORT` 消息在无活动任务时返回 `STALE_TASK`。
- `selection-controller.test.js`：点「复制到剪贴板」发出的 `CAPTURE_REQUEST` 携带 `output: 'clipboard'`。
- `scroll-surface.test.js`：操作行按钮为 `确认截图 / 复制到剪贴板 / 重新选择 / 取消`。
- 人工验收：见 README 人工验收清单中的剪贴板条目。
