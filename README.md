# 长截图选区工具（chrome-longshot）

Chrome Manifest V3 扩展：在网页上拖出一个矩形选区（可跨屏），松手即自动逐屏滚动、截图、裁剪拼接，完成后在鼠标旁弹出菜单，让你选格式后保存为 PNG/JPG 或直接复制到剪贴板。

无构建步骤、无第三方依赖：`src/` 下的 ES Module 直接被 `manifest.json` 加载。

## 安装（开发版）

1. 打开 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库根目录（包含 `manifest.json` 的目录）
4. 把「长截图选区工具」固定到工具栏

修改源码后，在扩展卡片上点「重新加载」，并刷新目标页面（旧的 content script 仍在页面里）。

## 使用

1. 在目标页面点击扩展图标 → 页面出现半透明遮罩，并在鼠标附近弹出**画质菜单**（**菜单只定位这一次，之后停驻原地，不随鼠标移动**）：

   ```
   画质 [普通] [高清]
   ```

   - **普通**（默认）：按当前页面缩放截图
   - **高清**：把标签页临时缩放到 150% 再截，像素密度更高；截图结束（或退出选区）后自动恢复原缩放。切换后页面布局会变，因此会清掉已有选区，请在新的布局里重新框选

2. 按住左键拖出矩形；指针靠近滚动区域上/下边缘时自动滚动，速度随接近程度递增（画质菜单在开始框选时自动收起）
3. **松开鼠标后先不截图**：选框四边与四角出现 8 个调整手柄，可拖动微调选区大小，同时弹出（仍在菜单停驻的位置）：

   ```
   [确认截图] [取消]
   ```

   - 拖动手柄调整选区；点选区内部保持不变；点选区外部重新框选
   - **确认截图** → 隐藏扩展 UI，开始逐屏捕获、裁剪拼接
   - **取消** → 清掉选区，回到画质菜单
4. 确认后截图完成，弹出**输出菜单**（同样停在原位）：

   ```
   格式 [PNG][JPG]
   [保存] [复制到剪贴板] [关闭]
   ```

   - **格式**：切换 PNG / JPG（默认 PNG）。只影响随后编码，不重新截图
   - **保存**：按当前格式编码，打开系统「另存为」窗口，默认文件名形如 `longshot-20260718-153012.png` / `.jpg`
   - **复制到剪贴板**：把成品写入系统剪贴板（固定 PNG），不弹文件窗口，可直接在聊天/文档里 `Ctrl+V`
   - **关闭** / `Esc`：丢弃本次拼接结果并退出

截图前只出现「画质」，截图后只出现「格式/保存/复制/关闭」，两者不会同时显示。

输出格式：

- **PNG**（默认）：无损、支持透明背景，体积大。
- **JPG**：有损压缩（质量 0.92），体积明显更小。JPEG 无透明通道，因此拼接画布统一铺白色底（网页截图本身也基本不透明）。

复制到剪贴板始终使用 PNG：Chrome 的 `ClipboardItem` 写图片只稳定支持 `image/png`。未知格式值会回退为 PNG，不会出现扩展名与内容不符的文件。

支持范围：浏览器主页面纵向滚动、单个内部纵向滚动容器、高分屏与非 100% 页面缩放、固定栏与吸顶元素去重、懒加载图片等待。

不支持：横向自动滚动、嵌套多层滚动容器联合截图、跨域 iframe 内部内容、虚拟列表未挂载内容、`chrome://` 与 Chrome 应用商店等禁止注入的页面、截图后二次编辑。

## 项目结构

```
manifest.json                  扩展清单（MV3，最小权限：activeTab/scripting/offscreen/downloads/clipboardWrite）
src/
  background/
    service-worker.js          图标点击注入脚本、消息路由、offscreen 生命周期、任务协调、已完成拼接的登记
    capture-controller.js      捕获主流程（分段滚动 → captureVisibleTab → 拼接 → finally 恢复）+ 保存/复制/丢弃后处理
  content/
    content-script.js          引导：按需动态 import 模块、注册消息监听
    selection-ui.js            选区 UI（closed shadow DOM）、边缘自动滚动、选区控制器、完成后菜单、捕获反馈
    scroll-surface.js          滚动表面抽象（页面 / 内部容器）、PageStateGuard（布局稳定 + 固定元素去重）
    capture-message-handler.js 按任务处理 PREPARE/SCROLL_TO/SET_FIXED_VISIBILITY/RESTORE 消息
  offscreen/
    offscreen.js               ComposerSession 状态机：解码、裁剪绘制、按需 PNG/JPG 编码、dataURL 导出
  shared/
    protocol.js                消息类型、错误码、输出格式、makeMessage
    formats.js                 MIME / 扩展名映射、JPEG 质量与白底常量、格式回退
    geometry.js                矩形归一化/求交、单帧裁剪位置计算
    segments.js                分段滚动目标生成
    limits.js                  输出尺寸与像素上限
tests/                         node --test 单元测试（无 DOM，依赖注入式）
fixtures/manual-test.html      人工验收页面（固定头、标尺、内部滚动容器、懒加载等）
docs/superpowers/              设计与实施计划文档
```

## 关键机制

- **单一滚动表面**：一次任务只锁定页面根滚动或一个内部滚动容器，两者共用同一接口。
- **实测坐标**：裁剪缩放比取自 `bitmap.width / innerWidth`，拼接偏移用每帧**实际** `scrollTop` 反算，不假设设置值生效。
- **稳定性双保险**：content 侧 `PageStateGuard.assertStable()`（视口/尺寸抖动 >2px、`scrollHeight` >10px 即报错）+ 后台 `assertSurfaceInvariant()` + `surfaceToken`。
- **固定元素去重**：首帧保留 `position: fixed` / 吸顶 `sticky`，后续帧设为 `visibility: hidden !important`，每帧重算。
- **串行捕获**：`createCaptureGate` 保证相邻两次 `captureVisibleTab` 之间至少间隔 200ms（按**上次捕获结束**计时，滚动与解码时间与等待重叠）；帧的解码绘制与下一屏滚动并行执行；同一时刻只允许一个任务，新任务会 abort 旧任务。
- **滚动稳定分级**：`waitForScrollSettle` 每屏先等一帧；**只有首屏**额外等待懒加载图片（上限 300ms），后续屏不再等图片 —— 长图里本就随滚动触发懒加载，逐屏等待收益极低却线性放大总耗时。
- **恢复兜底**：`finally` 中依次结算在飞截图 → `COMPOSER_ABORT` → `RESTORE_PAGE`，每步都有超时；原始错误优先于恢复错误。
- **两段式任务**：`CAPTURE_REQUEST` 只负责拼接，完成后不下载、不释放画布，并把 `taskId` 登记到 Service Worker 的 `compositions`；用户随后发 `CAPTURE_SAVE`（按格式下载）/ `CAPTURE_COPY`（写剪贴板）/ `CAPTURE_DISCARD`（丢弃）时才真正消费，每条任务只能消费一次，标签页关闭或新任务开始时自动丢弃。
- **高清缩放**：`ENABLE_HIGH_QUALITY` 由 Service Worker 按标签页串行读写 zoom（`createHighQualitySessionManager`），原缩放值回传内容脚本保存；截图时 `runCapture` 的 `finally` 负责恢复，未截图就退出则由内容脚本发 `DISABLE_HIGH_QUALITY` 恢复。
- **复制到剪贴板**：`COMPOSER_EXPORT` 取 `canvas.toDataURL('image/png')`（Chrome 的 `ClipboardItem` 写图片只稳定支持 PNG）→ `CLIPBOARD_WRITE` 到内容脚本，由页面侧 `navigator.clipboard.write` 写入（http 等非安全上下文回退 `copy` 事件）；写入失败以中文错误提示。

## 打包（CRX / ZIP）

```bash
./pack.sh     # 生成 longshot.crx（内部分发）+ longshot.zip（商店上架）+ longshot.pem（扩展 ID 私钥）
```

- **longshot.zip**：上传 Chrome Web Store 用（商店不收 crx）。
- **longshot.crx**：内部分发。两种安装方式：
  - 拖到 `chrome://extensions/`（开发者模式下）。非商店 crx 在普通版 Chrome 重启后会被禁用，仅适合临时验证。
  - 企业/受管环境通过 `ExtensionInstallForcelist` 策略静默安装（需要 crx 的 URL 或更新清单 URL）。
- **longshot.pem**：决定扩展 ID 的私钥，**必须妥善保管**；换钥即换 ID，已装用户无法收到更新。首次打包自动生成，之后每次打包带上同一把钥保持 ID 稳定。

## 测试


```bash
npm test          # node --test tests/*.test.js
```

共 161 个用例，覆盖几何换算、分段生成、输出上限、格式映射、滚动表面适配、PageStateGuard、选区控制器、消息处理器、Composer 状态机、后台捕获编排、后处理（保存/复制/丢弃）、高清缩放会话、选区确认与手柄调整、清单校验。全部为无 DOM 的依赖注入单测，不启动真实浏览器。

## 人工验收清单

单元测试无法覆盖真实渲染与浏览器行为，发版前用 `fixtures/manual-test.html`（以及至少一个真实长页面）逐项过一遍：

- [ ] 点击图标后出现遮罩 + 画质菜单（普通/高清），且菜单在鼠标附近
- [ ] 菜单出现后停驻原地，不随鼠标浮动；开始框选自动收起，取消后回到画质菜单时才重新定位
- [ ] 开始框选时画质菜单自动收起；松开鼠标后出现手柄与「确认截图/取消」，不直接截图
- [ ] 拖动 8 个手柄能调整选区大小：四角（nw/ne/se/sw）斜向、四边（n/e/s/w）单向，方向正确
- [ ] 调整后确认截图，输出内容与调整后的选区一致（无错位、无空图）
- [ ] 点选区内部不重置选框；点选区外部重新框选
- [ ] 点「确认截图」后扩展 UI 完全不可见（不会出现在结果图里）
- [ ] 点「取消」清掉选区并回到画质菜单
- [ ] 截图完成后输出菜单（格式/保存/复制/关闭）停在画质菜单原位，只切换内容
- [ ] 选「高清」后页面缩放到 150%，框选坐标正确；截图结束或退出选区后缩放恢复原值
- [ ] 高清开启后未截图就按 `Esc` → 缩放恢复，页面状态正常
- [ ] 菜单出现在指针上方（面板底边在光标上方 8px），整体不遮挡刚框选的内容
- [ ] 菜单贴着视口上/右边缘时自动翻到下方/左侧，不会超出窗口
- [ ] 边缘自动滚动速度自然，拖动跨多屏时选区连续、不跳变
- [ ] 普通长页面：输出图片尺寸与选区一致，无重复、断层、错位
- [ ] 格式切到 JPG：下载文件为 `.jpg`，无黑色/透明空洞（白底），体积明显小于同尺寸 PNG
- [ ] 格式切回 PNG：下载文件为 `.png`，透明背景保留
- [ ] 「复制到剪贴板」：不弹保存窗口，在聊天/文档里 `Ctrl+V` 能粘出完整长图
- [ ] 「复制到剪贴板」成功后页面顶部提示「已复制到剪贴板」，约 2.4 秒后自动消失
- [ ] 在 http 页面（非安全上下文）上复制仍能成功（回退 copy 事件）
- [ ] 内部滚动容器：选区被限制在容器可见边界内，截图内容正确
- [ ] 从页面/容器中部开始选取，首尾分段裁剪正确
- [ ] 高分屏（devicePixelRatio > 1）与 125%/150% 页面缩放下坐标正确
- [ ] 固定导航栏只出现在首帧；吸顶表头不重复
- [ ] 懒加载图片：滚动后加载完成的图片出现在正确位置
- [ ] 滚动到底部不足一屏时，末段高度正确
- [ ] 滚动等待期显示「正在截取 n/N 屏」，捕获瞬间反馈条不可见（不被截进图里）
- [ ] 菜单里切换格式后再点保存 → 只编码一次，不重新截图
- [ ] 点「关闭」或按 `Esc` → 丢弃拼接结果并干净退出，无残留遮罩
- [ ] 截图过程中切换标签页 → 提示重新选择，页面状态恢复
- [ ] 选区过大 → 提示缩小选区，不生成损坏文件
- [ ] 「另存为」窗口取消保存 → 不显示为失败，页面状态仍恢复
- [ ] 成功/失败/取消/超时后：滚动位置、`scroll-behavior`、固定元素可见性、页面交互全部恢复

## 设计文档

- `docs/superpowers/specs/2026-07-16-chrome-long-screenshot-design.md` — 总体设计
- `docs/superpowers/specs/2026-07-16-save-as-path-design.md` — 另存为
- `docs/superpowers/specs/2026-07-16-selection-controls-right-design.md` — 工具条右侧定位（已作废，保留作历史记录）
- `docs/superpowers/specs/2026-07-19-post-capture-menu-design.md` — **当前流程**：截图前弹画质、松手后确认+可调大小、完成后弹输出菜单
- `docs/superpowers/specs/2026-07-18-output-format-jpeg-design.md` — PNG / JPG 输出格式
- `docs/superpowers/specs/2026-07-18-copy-to-clipboard-design.md` — 复制到剪贴板
- `docs/superpowers/specs/2026-07-18-menu-near-pointer-design.md` — 菜单出现在鼠标附近
- `docs/superpowers/specs/2026-07-18-high-quality-mode-design.md` — 高清模式
- `docs/superpowers/specs/2026-07-18-quality-mode-before-selection-design.md` — 画质在框选前选择
- `docs/superpowers/specs/2026-07-18-high-quality-reselect-design.md` — 高清模式重新框选（已作废，高清不再需要二次框选）
- `docs/superpowers/plans/` — 对应实施计划
