# 画质在框选前选择 Design

## 背景

高清模式原先的入口是「框选完成后」的操作条按钮：用户先框选 → 点「高清」→ 页面缩放变为 150% → 旧选区被清空 → 用户必须重新框选一次。等于每次用高清都要框两遍，且第一次框选完全是浪费。

## Goal

把画质选择提前到进入选区模式的瞬间：用户先决定「普通 / 高清」，再框选。高清状态下缩放已在框选前生效，因此框选坐标与最终布局天然一致，不存在"先框选后放大"的错位问题。

## User Flow

1. 点击扩展图标 → 选区遮罩出现，同时顶部居中显示「画质」条：`画质 [普通] [高清]`，默认选中「普通」。
2. 点「高清」→ 后台把当前标签页缩放到 150%，画质条切到「高清」选中态，并提示「高清已开启，请框选截图区域」。
3. 用户直接拖出选区 → 松开鼠标 → 选区旁出现操作条：`确认截图` / `重新选择` / `取消`。
4. 确认后按当前画质截图；成功、失败、取消、超时后恢复原缩放。
5. 若用户已有选区时才切换画质，旧选区会被清空并提示「…请重新框选截图区域」（布局已变化，旧坐标失效）。

## Architecture

- `createSelectionUI` 新增独立 `.mode` 画质条（与 `.controls` 操作条分离）：进入选区模式即可见，不依赖 `setComplete()`。
- 操作条按钮收敛为 `确认截图 / 重新选择 / 取消`；画质只有一个入口，避免两处状态。
- UI 暴露 `setMode(highQuality, pending)`：同步 `aria-pressed` 选中态，并在请求在飞时禁用两个按钮。
- 选择控制器用 `onSelectMode('normal' | 'highQuality')` 替换原 `onToggleHighQuality`：
  - 切高清：发 `ENABLE_HIGH_QUALITY`，成功则记录 `originalZoom`、置 `highQuality = true`、清空选区并提示。
  - 切普通：发 `DISABLE_HIGH_QUALITY`（带 `restoreZoomTo`），清空选区并提示。
  - 目标状态与当前一致或请求在飞时直接忽略。
- `CAPTURE_REQUEST` 的 payload 结构不变（`highQuality` + `restoreZoomTo`），后台捕获流程无需改动。
- 退出选区（`Esc` / 取消 / 重新点击图标）时若已开启高清且尚未确认截图，仍走 `DISABLE_HIGH_QUALITY` 恢复缩放。

## Constraints

- 不改变默认普通模式的截图结果。
- 画质条不遮挡拖拽：它位于遮罩之上、仅自身接收指针事件，遮罩其余区域照常起框。
- 不引入新的权限或后台消息类型。

## Testing

- UI 测试：画质条在框选前即存在且可见；`setMode` 正确切换 `aria-pressed` 与禁用态；操作条按钮为 `确认截图 / 重新选择 / 取消`。
- 控制器测试：先选高清再框选，`CAPTURE_REQUEST` 带 `highQuality: true` 与 `restoreZoomTo`；已有选区时切换画质会触发重置与提示；切回普通会发 `DISABLE_HIGH_QUALITY`，后续截图 payload 不含高清参数。
- 人工验收：见 README 人工验收清单中的高清相关条目。
