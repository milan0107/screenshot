# 截图前后各一个菜单 Design

## Goal

把交互收敛成「选画质 → 框选 → 自动截图 → 选去向」，全流程只有两个菜单，且各管一件事：

- **截图之前**弹一次：`画质 [普通][高清]`（进入选区模式即出现）；
- 框选完成时**不弹菜单**，直接开始截图；
- **截图完成后**弹一次：`格式 [PNG][JPG]` + `[保存] [复制到剪贴板] [关闭]`。

两个菜单互斥显示，用户全程只需「点图标 →（可选）选画质 → 拖框 → 选去向」。

## User Flow

1. 点扩展图标 → 遮罩出现，同时在鼠标附近弹出画质菜单（默认「普通」）。**菜单只定位这一次，之后停驻原地，不随鼠标移动**。
   - 选「高清」→ 标签页临时缩放到 150%，画质按钮进入选中态；布局变化会清掉已有选区。
   - 若已开高清后未截图就退出（`Esc` / 关闭），恢复原缩放。
2. 拖框（靠近上下边缘自动滚动）；开始框选时画质菜单自动收起。
3. **松开鼠标 → 进入待确认态**：选框显示 8 个调整手柄，并弹出 `确认截图 / 取消`（若面板已在画质阶段显示过，则停驻原地只切换内容）。
   - 拖动手柄调整选区大小（只动被抓住的边；手柄坐标映射：left/right → x，top/bottom → y；越过对侧边时自动归一化）；调整期间手柄隐藏、结束后恢复；不重新弹确认菜单。
   - 点选区内部：保持选区不变；点选区外部：重新框选。
   - `确认截图` → 隐藏扩展 UI，开始逐屏捕获 + 拼接（高清时 `runCapture` 的 `finally` 恢复原缩放）。
   - `取消` → 清掉选区，回到画质菜单。
4. 拼接完成后：
   - 扩展 UI 重新显示输出菜单（同样停驻，不再重新定位）；
   - 切换 `PNG/JPG` 只影响随后编码，不重新截图；
   - `保存` → 按当前格式编码并打开系统「另存为」；
   - `复制到剪贴板` → 写入剪贴板（固定 PNG），成功后顶部提示「已复制到剪贴板」；
   - `关闭` / `Esc` → 丢弃拼接结果并退出。
5. 截图失败时不弹菜单，只显示错误提示并恢复页面。
4. 拼接完成后：
   - 扩展 UI 重新显示，菜单出现在**鼠标释放点附近**；
   - 切换 `PNG/JPG` 只影响随后编码，不重新截图；
   - `保存` → 按当前格式编码并打开系统「另存为」；
   - `复制到剪贴板` → 写入剪贴板（固定 PNG），成功后顶部提示「已复制到剪贴板」；
   - `关闭` / `Esc` → 丢弃拼接结果并退出。
5. 截图失败时不弹菜单，只显示错误提示并恢复页面。

## Architecture

### 任务拆成两段

| 阶段 | 消息 | 负责 |
|---|---|---|
| 拼接 | `CAPTURE_REQUEST` | 逐屏捕获、裁剪、拼接到离屏画布；**不下载、不释放画布** |
| 后处理 | `CAPTURE_SAVE` / `CAPTURE_COPY` / `CAPTURE_DISCARD` | 用户选格式后编码下载 / 写剪贴板 / 丢弃 |

- `runCapture` 成功后返回 `{composed: true}`，离屏 `ComposerSession` 停在 `begun` 状态，画布保留。
- Service Worker 用 `compositions: Map<taskId, {tabId, windowId}>` 登记待处理任务；每条任务只能消费一次（消费前 `delete`）。
- 标签页关闭（`tabs.onRemoved`）、新任务开始、后处理失败时都会 `COMPOSER_ABORT` 释放画布，避免泄漏。
- 后处理入口校验 `sender.tab.id === entry.tabId`，跨标签页请求返回 `STALE_TASK`。

### 编码格式延后到 finish

- `COMPOSER_BEGIN` 不再接收 `format`；拼接画布在 `begin` 时统一铺白底（JPEG 无透明通道，网页截图本身也基本不透明）。
- `COMPOSER_FINISH` 携带 `format`，由 `ComposerSession.finish(format)` 决定 `toBlob` 的 MIME 与质量；未知值回退 PNG。
- 因此用户可以在菜单里反复切换格式而不需要重新截图。

### 内容脚本状态机

`createSelectionController` 的 state 增加 `taskId / composed / busy`：

- `enterSelection()` → `ui.showModeOptions()`：显示画质行；
- `pointerdown` → `ui.hidePanel()`：收起画质菜单；
- `pointerup` → 待确认：`setAdjustable(true)` + `showConfirm(释放点)`；选区无效则回到画质菜单；
- `onConfirm` → `requestCapture()`：隐藏 UI、发 `CAPTURE_REQUEST`（含 `highQuality`）；
- `onCancelConfirm` → `resetSelection()` + 回到画质菜单；
- 手柄调整：`pointerdown` 带 `corner` → `adjusting` 态，`pointermove` 只动被抓住的边（`adjustSelection`），`pointerup` 结束并恢复手柄；
- 响应 `ok` → `composed = true`、显示 UI、`showActions(pointer)`；
- 响应失败或拒绝 → 丢弃本地状态并退出（不弹菜单）；
- 菜单动作 → `runAction(CAPTURE_SAVE/COPY/DISCARD)`，完成后 `disposeActive()`；
- `Esc` / 关闭：未完成时发 `CANCEL`，已拼接时发 `CAPTURE_DISCARD`。

`createSelectionUI` 提供三行面板（画质 / 确认 / 格式+操作）与 `setVisible()`（整体隐藏遮罩与面板）、`showModeOptions()`、`showConfirm(point)`、`showActions(point)`、`setAdjustable()`。

**停驻定位**：面板本次会话只在第一次出现时按指针定位（无指针坐标则用视口顶部居中的 CSS 默认位）；之后画质→确认→输出的阶段切换只换行内容，位置不动；只有 `hidePanel()` 后再次显示（如取消后回画质菜单）才重新定位。不再有跟随指针与静止区逻辑。

选框手柄命中采用**几何检测**：`.selection` 自身 `pointer-events: none`（保证遮罩能收到所有指针事件），`hitHandle()` 在遮罩的 `pointerdown` 里按指针到选框四边 12px 容差判定角/边（或选区内部），把 `corner` / `insideSelection` 附加到事件对象传给控制器。

### 剪贴板

复制发生在页面已恢复之后，此时内容脚本的任务状态已释放。`createCaptureMessageHandler` 因此记录 `completedTaskId`：`RESTORE_PAGE` 成功时登记，`CLIPBOARD_WRITE` 接受「进行中或刚完成」的任务，新任务开始时清空。

## 高清缩放

高清保留，入口放在**截图之前**的画质菜单里：

- `ENABLE_HIGH_QUALITY` / `DISABLE_HIGH_QUALITY` 由 Service Worker 处理，`createHighQualitySessionManager` 按标签页串行读写 zoom，原缩放值回传内容脚本保存（`restoreZoomTo`，避免 MV3 Worker 休眠丢状态）。
- 截图路径：`CAPTURE_REQUEST` 携带 `highQuality` 与 `restoreZoomTo`，`runCapture` 在 `prepareEnvironment` 之后 `applyHighQualityZoom`，并在 `finally` 中恢复原缩放。
- 未截图就退出：内容脚本 `disposeActive` 发 `DISABLE_HIGH_QUALITY` 恢复；一旦截图请求发出，`state.zoomManaged` 置真，后续不再重复恢复（避免与后台 `finally` 重复）。
- 因为高清切换会改变布局，切换时清空已有选区，要求在新的布局里重新框选。

## Constraints

- 保存、复制的捕获/拼接/恢复语义与之前完全一致。
- 不新增权限（`clipboardWrite` 已有）。
- 截图期间扩展 UI 必须完全不可见，避免被截进结果图。

## Testing

- `selection-controller.test.js`：进入选区即 `showModeOptions`；松手后进入待确认（`adjustable:true` + `confirm`）且不发请求；`onConfirm` 才发 `CAPTURE_REQUEST`；`onCancelConfirm` 回到画质菜单；拖西边手柄调整后确认使用新坐标；点选区内部保持选区；点选区外部重新框选；选高清发 `ENABLE_HIGH_QUALITY` 且截图请求带 `highQuality/restoreZoomTo`；切回普通发 `DISABLE_HIGH_QUALITY`；未截图退出恢复缩放；高清截图失败不重复恢复；截图期间 `setVisible(false)`；完成后才 `showActions(释放点)`；失败不弹菜单；保存/复制/关闭分别发出 `CAPTURE_SAVE/COPY/DISCARD`；`Esc` 按是否已拼接选择 `CANCEL` 或 `CAPTURE_DISCARD`；过小选区不触发。
- `scroll-surface.test.js`：`showModeOptions` 只展开画质行、`showConfirm` 只展开确认行、`showActions` 只展开格式行与操作行；按钮为 `画质/普通/高清`、`格式/PNG/JPG`、`确认截图/取消`、`保存/复制到剪贴板/关闭`；`setAdjustable` 切换手柄显隐；`setVisible` 控制整体显隐；**菜单首次出现时定位一次，显示期间（含阶段切换）停驻，隐藏后再现才重新定位**。
- `capture-controller.test.js`：高清在截图前 `getZoom → setZoom(1.5)`、结束后恢复原缩放（失败也恢复、已传 `restoreZoomTo` 时不再读 zoom）；`runCapture` 完成后不下载不释放；`saveComposition` 按格式编码并下载 `.png/.jpg`（未知格式回退）；`copyComposition` 走 `COMPOSER_EXPORT → CLIPBOARD_WRITE → COMPOSER_RELEASE`；`discardComposition` 只 abort；Service Worker 层 `CAPTURE_SAVE`/`CAPTURE_DISCARD` 只允许消费一次且校验标签页。
- `composer-session.test.js`：`begin` 统一铺白底且不接收格式；`finish(format)` 决定 MIME 与质量，未知格式回退 PNG。
- `content-message-handler.test.js`：`CLIPBOARD_WRITE` 在页面恢复后仍可写入、新任务后失效；`showNotice` 一次性提示与自动消失。
- 人工验收：见 README 人工验收清单。
