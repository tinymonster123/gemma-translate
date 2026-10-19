# gemma-translate

[![CI](https://github.com/tinymonster123/gemma-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/tinymonster123/gemma-translate/actions/workflows/ci.yml)

本地 Gemma 4 整页翻译扩展。点插件图标 → 页面右上角弹出悬浮面板 → 选目标语言 → 翻译，译文插在每段下方。

## 跑起来

```bash
npm install
npm run build            # → .output/chrome-mv3
npm run lint             # Biome 检查（CI 会跑）
npm run format           # Biome 格式化
npm test                 # 纯逻辑单测（切句 / 语言判断）
npm run probe            # 端到端：面板 → 本地 Gemma → 逐段译文 → 停止 / 还原（34 项）
```

Chrome → `chrome://extensions` → 打开开发者模式 → **加载已解压的扩展程序** → 选 `.output/chrome-mv3`。

首次翻译会下 ≈3.1GB 模型；之后走 Cache API，离线可用。测试环境可以把
`chrome.storage.local.modelHost` 指向本机伪 HF 服务（`testpage/hf-serve.mjs`）。

## 当前结构

```
entrypoints/
  background.ts        点图标 → 注入 page.js → 切换悬浮面板；拉起 offscreen；转发 modelHost
  page.tsx             页面会话 + Shadow DOM 里的 React 面板
  page-style.css       页面级样式（译文块、浮标），走 insertCSS，不受页面 CSP 限制
  offscreen/
    index.html         offscreen document 页面
    main.ts            引擎消息协议、进度聚合、status/chunk 广播
src/
  shared/
    protocol.ts        所有跨上下文消息形状（唯一来源）
    language.ts        纯语言判断 / 默认目标语言
    settings.ts        modelHost、目标语言
  page/
    session.ts         PageTranslationSession：探测、启动、停止、还原、订阅
    blocks.ts          段落选择、可翻性过滤、主题色
    float.ts           面板关闭时的进度浮标
  ui/
    Panel.tsx          React 悬浮面板（检测语言 / 目标语言 / 服务占位 / 翻译）
    panel.css          面板样式（shadow root 内，页面 CSS 进不来）
  engine/
    text.ts            切句 / 拼回 / prompt / token 预算（无 transformers.js 依赖）
    source.ts          env、模型源、wasm 路径
    runtime.ts         pipeline 加载、translate、TextStreamer
```

旧 popup 架构（`ext/`）及其诊断探针已移除；当前构建只读 `entrypoints/` 与 `src/`。

## 架构

| 层 | 文件 | 职责 |
|---|---|---|
| background | `entrypoints/background.ts` | 图标点击、按需注入、offscreen 生命周期、配置转发 |
| 页面面板 | `entrypoints/page.tsx` + `src/ui/Panel.tsx` | Shadow DOM 隔离的 React 面板；直接订阅页面会话 |
| 页面会话 | `src/page/session.ts` | 探测语言、抽块、插占位、串行翻译、流式写入、还原 |
| 推理宿主 | `entrypoints/offscreen/main.ts` | 消息协议、逐文件进度聚合、status/chunk 广播 |
| 引擎 | `src/engine/*` | 纯文本逻辑、模型源配置、pipeline / WebGPU |
| 协议 | `src/shared/protocol.ts` | 消息形状、会话状态、目标语言 |

扩展体积 **27.7MB**（ORT wasm 26.9MB + React 面板约 230KB）。模型不进包。

> 架构图 / 时序图已按悬浮面板链路重画：`docs/diagrams.html` → `shots/architecture.png`、`shots/sequence.png`。

## 三条硬结论（都实测过，别推翻）

### 1. 模型不能放在扩展包里 —— 读 ≥1 GiB 会让 Chrome 主进程崩

`chrome-extension://` 读大文件会触发浏览器进程 `EXC_BREAKPOINT`。实测边界：

| 读到 | 结果 |
|---|---|
| 512 MiB | ✅ |
| 1000 MiB | ✅ |
| 1024 MiB（= 2³⁰） | ⛔ 崩 |

跟模型、ORT、WebGPU 都无关 —— 一个裸 `fetch` + `reader.read()` 只计数不保留，同样崩。
Chrome 的扩展资源走 file URL loader + 共享内存管道，卡在整数边界说明是内部长度限制。

所以：**首次从远端下载 → 落 Cache API → 之后离线命中。**

### 2. 推理不能放 MV3 service worker

```
import() is disallowed on ServiceWorkerGlobalScope by the HTML specification.
```

ORT 的 WebGPU EP 要靠动态 import 拉自己的 `.mjs`。`chrome-extension://` 那条路
（库在 `cacheWasm.js:76` 返回 libURL 而不是 blob）也救不了 —— SW 里连普通动态 import 都被禁。
**官方示例 `transformers.js-examples/browser-extension` 恰恰把推理放在 SW 里，那条路是坏的。**

唯一可用的后台上下文是 offscreen document（Window + 无界面）。

**注意：offscreen 里没有 `chrome.storage`**，只有很有限的扩展 API。配置必须由 SW 读出来再传进去。

### 3. Content-Length 缺失会触发 O(n²) 缓冲

`utils/hub/utils.js:148` 的 `readResponse()`：拿不到 Content-Length 且没有 Hub 元数据时，
它从 `new Uint8Array(0)` 开始，每读一个 chunk 就重新分配并**把已累积内容整体复制一遍**。
总拷贝量 ≈ N²/(2c) —— 200MB 约 20GB，1450MB 约 1TB。

副作用：`progress` 恒为 100%（`total` 被设成 `= loaded`），看到进度条卡在 100% 就是这个。

走 HTTP / Cache API 时长度天然存在（实测缓存往返后 `Content-Length` 仍保留），这条路自动消失。
**不再需要任何 fetch 补丁。**

## 已知限制 / 下一步

- **端到端已跑通**：`npm run probe` 34/34，覆盖面板注入、Shadow DOM、本地 Gemma 加载（本机伪 HF）、
  20 段译文、流式 chunk、浮标召回、翻译中停止、目标语言持久化、还原、Cache API 冷启动命中、零外网请求。
- **首次要下 3.1GB**。目前只有面板进度和浮标百分比，没有下载前确认。
- **只在打开面板/注入时扫描一次 DOM**。无限滚动、SPA 路由切换不会重扫。
- **语言检测只区分中文 / 英文**：其它拉丁语系页面会显示成「英语」。以后可换
  `chrome.i18n.detectLanguage` 做更细的语种识别。
- **逐段串行翻译**。长文章耗时随段落数线性增长（20 段约 14 秒，不含下载）。
- 双语对照 / 仅译文、AI 精翻、多翻译服务都还没接；面板里只预留了服务行。

## 诊断工具

`.claude/skills/` 下有两个项目级 skill（`diagnose-model-loading`、`verify-translate-flow`），
`probes/` 是探针源码（在项目根目录），`.agents/probes` 是指向它的软链接视图；skill 仍在 `.claude/skills/`。

`node probes/render-diagrams.mjs` 重新渲染 `docs/diagrams.html` 到 `shots/*.png`。
