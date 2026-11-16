# 高清模式 Design

## Goal

为长截图选区工具增加一个可选的“高清模式”，默认仍使用普通截图；用户开启高清后，本次截图会临时提高当前标签页缩放来获得更高像素密度，完成、取消或失败后恢复原缩放。

## Behavior

- 选区完成后，操作条显示“高清”切换按钮。
- 默认关闭高清；用户点击“高清”后，仅影响当前这一次确认截图。
- 确认截图时，内容脚本在 `CAPTURE_REQUEST` payload 中传递 `highQuality: true` 或 `false`。
- 后台收到 `highQuality: true` 后，在准备页面截图前读取当前 tab zoom，设置为 `1.5`，截图任务结束后恢复原 zoom。
- 如果截图失败、取消、超时、保存取消或页面清理异常，仍尝试恢复原 zoom。
- 保存格式仍为 PNG，保存路径选择逻辑不变。

## Constraints

- 不改变默认普通模式行为。
- 不把最终图片做后期插值放大。
- 不合并或依赖尚未合并的提速分支。
- 如果高清 zoom 导致页面布局变化，现有 `SURFACE_CHANGED` 保护继续负责报错。

## Testing

- 选区控制器测试：开启高清后 `CAPTURE_REQUEST` 包含 `highQuality: true`，默认包含 `false`。
- 后台测试：高清请求会按 `getZoom -> setZoom(1.5) -> capture -> restore original zoom` 顺序执行。
- 后台失败测试：截图失败时也会恢复原 zoom，并保留原始截图错误。
- Chrome 依赖适配测试：`createChromeCaptureDeps` 暴露 zoom 读写能力。
