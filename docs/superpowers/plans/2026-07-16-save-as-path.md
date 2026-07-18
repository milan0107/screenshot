# Screenshot Save-As Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次长截图生成完成后打开 Chrome 系统“另存为”窗口，让用户选择保存路径和文件名。

**Architecture:** 保持现有截图、拼接和下载适配器不变，只在截图控制器构造下载参数时把 `saveAs` 设为 `true`。测试直接观察控制器传给下载依赖的参数，确保需求由业务流程而不是测试替身实现。

**Tech Stack:** Chrome Extension Manifest V3、JavaScript ES modules、Node.js `node:test`

## Global Constraints

- 每次截图保存都显示系统“另存为”窗口。
- 保留当前自动生成的 PNG 默认文件名。
- 不增加设置页面、路径记忆或网页文件系统 API。
- 截图选择、滚动、拼接、内部滚动容器及现有错误处理保持不变。

---

### Task 1: 启用截图另存为窗口

**Files:**
- Modify: `tests/capture-controller.test.js:67`
- Modify: `src/background/capture-controller.js:232`

**Interfaces:**
- Consumes: `runCapture(task, deps)` 使用的 `deps.download(options)` 依赖，`options` 兼容 `chrome.downloads.download`。
- Produces: 下载参数 `{url: string, filename: string, saveAs: true}`。

- [x] **Step 1: 写一个失败测试**

在 `makeHarness` 的下载依赖中断言完整截图流程启用另存为：

```js
download: async args => {
  events.push('download');
  assert.deepEqual(args, {
    url: 'blob:shot',
    filename: 'longshot-20260716-120102.png',
    saveAs: true
  });
},
```

保留文件末尾的 Chrome 依赖适配器透传测试；该测试传入 `saveAs: false` 是为了证明适配器不修改调用方参数，与截图流程选择 `true` 不冲突。

- [x] **Step 2: 运行测试并确认因旧行为而失败**

Run: `node --test tests/capture-controller.test.js`

Expected: FAIL，差异明确显示实际值为 `saveAs: false`、期望值为 `saveAs: true`。

- [x] **Step 3: 写最小实现**

在 `src/background/capture-controller.js` 的下载调用中修改一个参数：

```js
await awaitOperation(() => download({url: finished.objectUrl, filename, saveAs: true}));
```

不修改 `createChromeCaptureDeps`，它继续原样转发下载参数。

- [x] **Step 4: 运行聚焦测试并确认通过**

Run: `node --test tests/capture-controller.test.js`

Expected: PASS，文件内全部测试通过且无警告。

- [x] **Step 5: 运行完整回归测试**

Run: `npm test`

Expected: PASS，全部测试通过且无错误或警告。

- [x] **Step 6: 检查补丁并提交**

Run: `git diff --check`

Expected: 无输出，退出码为 0。

```bash
git add tests/capture-controller.test.js src/background/capture-controller.js docs/superpowers/plans/2026-07-16-save-as-path.md
git commit -m "feat: prompt for screenshot save location"
```

### Task 2: 处理保存对话框生命周期

**Files:**
- Modify: `tests/capture-controller.test.js:110`
- Modify: `src/background/capture-controller.js:16`
- Modify: `src/background/capture-controller.js:238`

**Interfaces:**
- Consumes: Chrome 下载 API 取消保存时返回的精确错误字符串 `USER_CANCELED`。
- Produces: 用户取消保存时正常完成截图任务；系统保存对话框不受 60 秒截图生成超时限制。

- [x] **Step 1: 添加并运行取消保存与计时器顺序的失败测试**

Run: `node --test tests/capture-controller.test.js`

Expected: 两项新增测试分别因 `USER_CANCELED` 被上报、下载前未清除超时而 FAIL。

- [x] **Step 2: 精确识别用户取消并在下载前结束截图超时**

```js
function isUserCanceledDownload(error) {
  return error === 'USER_CANCELED'
    || error?.code === 'USER_CANCELED'
    || error?.message === 'USER_CANCELED';
}
```

调用 `download` 前通过 `clearTimeout(timer)` 停止截图生成计时器；仅吞掉 `USER_CANCELED`，其他下载异常继续进入原错误处理流程。

- [x] **Step 3: 运行聚焦测试与完整回归测试**

Run: `node --test tests/capture-controller.test.js`

Expected: 24 项测试全部通过。

Run: `npm test`

Expected: 全部测试通过且无失败。
