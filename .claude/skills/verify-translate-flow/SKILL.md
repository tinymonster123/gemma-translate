---
name: verify-translate-flow
description: 改完 gemma-translate 的 WXT/React 扩展代码后跑端到端验证用 —— 确认点图标、注入、页面内悬浮面板、Shadow DOM、本地 Gemma 逐段翻译、停止、浮标召回、Cache 冷启动、还原整条链路仍然通，并给出每项检查的判读方式。34 项检查，约 60 秒（含本机 3.2GB 模型加载）。
---

# 验证整页翻译链路（页面内悬浮面板）

```bash
npm run build && node probes/flow-verify.mjs   # 有头，WebGPU 最稳
HEADLESS=1 node probes/flow-verify.mjs
```

退出码 0 = 34 项全过。截图落在 `shots/panel-open.png`、`shots/flow-top.png`、`shots/flow-bottom.png`。

## 它自己会起的三样东西

| 东西 | 端口 | 作用 |
|---|---|---|
| fixture 测试页 | 8099 | 一篇英文文章，含导航、表格、代码块、深色区块、一段中文 |
| 伪 Hugging Face | 8090 | 把 `<model>/resolve/main/<file>` 映射到 `~/Projects/gemma-browser-lab/models/`，**避免真下 3.2GB** |
| 测试用扩展副本 | — | 硬链接自 `.output/chrome-mv3`，只多一条 `host_permissions: <all_urls>` |

**为什么必须有那个副本**：产品 manifest 用 `activeTab`，而 `activeTab` 只由真实用户点击授予；Playwright 点不到浏览器工具栏上的图标。副本只换「谁有权限碰这个页面」，注入之后的链路与原版一致。跑完自动删除。

## 测试缝

- `self.__GT_TOGGLE_PANEL(tabId)`：service worker 里的全局函数，走**和工具栏点击完全相同**的 toggle 路径（`ensurePageScript` → `tabs.sendMessage`）。脚本用它打开面板。
- 面板挂在 `#gemma-translate-panel-host` 的 **open shadow root** 里。Playwright 的 CSS 选择器默认穿透 open shadow root；页面内 `document.querySelector` **不穿透**，需要显式 `.shadowRoot.querySelector`。
- 页面 isolated world 的 `window.__gemmaTranslateV2 = { session, toggle, show, hide }` 可以用来直接开合面板。

## 检查怎么读

| 检查 | 失败意味着 |
|---|---|
| `manifest 没有 default_popup` | 又变回 popup 架构了 |
| `background 暴露 __GT_TOGGLE_PANEL` | 测试缝被删，或 background 没加载 |
| `面板挂在 open shadow root 里` | `page.tsx` 的 host/shadow 创建失败 |
| `面板样式走 adoptedStyleSheets` | 改回了 `<style>`，页面 CSP 可能拦掉 |
| `源语言显示英语` | `pageLanguage()` 判反了，或探测把译文算进去了 |
| `段落数已探测` | `collectBlocks()` 没找到可翻段落 |
| `目标语言默认简体中文` | 默认目标语言逻辑坏了 |
| `翻译服务固定为本地 Gemma` | 面板 UI 结构变了 |
| `CTA 初始为「翻译」` | 会话初始状态不是 idle |
| `翻译流程跑完` | 引擎没到终态。**先看浮标 `title`**，真实错误在那里 |
| `首轮确实从模型源加载` | 伪 HF 计数为 0：模型没走远程路径，或 `modelHost` 没转发进 offscreen |
| `完成后 CTA 变成「还原原文」` | 会话没进入 done |
| `有译文落地` / `没有失败段` | 引擎加载失败或逐段翻译报错 |
| `中文段落被跳过` | 目标语言过滤失效 |
| `代码块被跳过` | `SKIP_SEL` 没挡住 `pre`/`code` |
| `offscreen document 存在` / `推理不在 service worker 里` | `ensureOffscreen()` 没跑成 |
| `引擎状态为 ready` | offscreen 创建了但模型没加载完 |
| `关面板后浮标出现` / `点浮标召回面板` | `setFloatHidden()` 或浮标点击回调坏了 |
| `重开面板后源语言仍是英语` | **回归哨兵**：`pageLanguage()` 又把 `[data-gt]` 译文算进去了 |
| `重开面板后段数不归零` | `collectBlocks()` 没跳过已翻段落，或面板没沿用会话总数 |
| `重开面板后目标语言不变` | 目标语言被重新探测的源语言带偏了 |
| `还原清掉译文` | `restore()` 没删干净 `[data-gt]` |
| `offscreen 已关闭（准备冷启动）` | `chrome.offscreen.closeDocument()` 失败，后面的 Cache 验证无效 |
| `重建 offscreen 后 Cache API 命中` | 冷启动后又去模型源下载：`cacheKey` 变了、`useBrowserCache` 关了，或缓存没写进去 |
| `翻译中 CTA 变成「停止翻译」` | `busy` 判断坏了 |
| `停止后状态为「已停止」` / `停止后 CTA 变「继续翻译」` | `stop()` 没更新状态 |
| `停止后可以直接还原` | stopped 状态的「还原原文」入口或 `restore()` 坏了 |
| `选择后写入 storage` / `重载后恢复上次目标语言` | 目标语言持久化坏了 |
| `全程零外网请求` | 有代码在偷偷联网 —— 除了 fixture 和伪 HF 之外的请求都算失败 |

## 排查顺序

先看两处，再往下走：

1. **浮标 `title`** —— `fail()` 把真实错误存在这里，脚本会打印出来。
2. **`page:error` / `page:warning` 行** —— 页面上下文里的异常，包括内容脚本的 `console.warn`。

如果卡在「翻译流程跑完」，用 `diagnose-model-loading` 那个 skill 往下分。

## 几个已知的判读陷阱

- **面板打开时浮标是 `display:none`**（`setFloatHidden(true)` 的设计）。`page.waitForSelector('.gt-float-text')` 默认等 visible 会超时；必须传 `{ state: 'attached' }`，或者直接 `waitForFunction` 读 `textContent`。
- **截图要等 400ms**。`.gt-panel` 有 `.16s` 的入场动画（opacity 0 → 1），立刻截图会得到半透明中间帧，看起来像「面板背景漏了」。
- **`page.waitForFunction(fn, arg, options)` 的第二个位置参数是 `arg` 不是 `options`**。把 `{ timeout }` 放第二位会被当成传给页面函数的参数，超时静默退回默认 30 秒 —— 这个坑已经踩过一次。
- **offscreen 的请求 Playwright 看不到**。它不是一个 page，`context.on('request')` 只覆盖页面上下文。所以模型请求必须由伪 HF 服务端的 `/__stats` 计数：首轮 >0、关掉 offscreen 冷启动后新增 =0，才证明 Cache API 真的命中。用 `hfRequests.length` 判断「零模型请求」是假通过。
- **伪 HF 的缓存是空的**。每轮测试用的是全新的临时 profile，所以每轮都会重新从本机读一遍 3.2GB（约 10 秒）。这是预期行为。
- **`li`/`td` 的译文插在元素内部**，所以读祖先的 `innerText` 会同时拿到原文和译文。判断某段是否被跳过要精确到那个元素本身。
- **翻译完成后重开面板**，`probe()` 必须仍然报告英语、20 段。如果变成「简体中文 / 0 段」，说明 `pageLanguage()` 或 `collectBlocks()` 没有排除 `[data-gt]`。

## 不要改的东西

1. **模型不能进扩展包。** `chrome-extension://` 读 ≥1 GiB → 主进程 `EXC_BREAKPOINT`。
2. **推理只能放 offscreen。** MV3 service worker 禁止动态 `import()`。
3. **wasm 不要从 CDN 拉，也不要改回 Vite emit。** 走 `public/ort/` + `insertCSS`/`getURL` 的稳定路径。
4. **面板样式走 constructable stylesheet。** 页面 CSP 可能拦 `<style>`。
