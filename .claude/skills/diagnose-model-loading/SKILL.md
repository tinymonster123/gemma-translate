---
name: diagnose-model-loading
description: 浏览器或扩展里加载大模型出问题时用 —— 浏览器进程崩溃、加载卡住或异常慢、device 没走 WebGPU、模型源不可达、大文件存不进浏览器存储。先做单变量最小复现，再按症状判读。
---

# 诊断浏览器里的模型加载

一条铁律：**先做只保留一个变量的最小复现，再谈原因。** 这个项目的三次误判（怪内存、怪 offscreen、怪 WebGPU）全是因为症状像"资源不够"就直接下结论。最小复现的意义就是把变量一个个摘掉。

## 按症状路由

| 症状 | 最小复现 | 判读 |
|---|---|---|
| 浏览器进程直接消失（页面还在，但整个 context 没了） | 用只含一个页面的最小扩展，从 `chrome-extension://` 读大文件，只计数不保留，按 512 / 1000 / 1024 / 1100 MB 二分 | 卡在 1000 MiB 正常 / 1024 MiB 崩 → 扩展协议内部长度限制 |
| 加载卡几十秒甚至更久 | `curl -sI` 看模型文件的响应头 | 没有 `content-length` 或 `transfer-encoding: chunked` → O(n²) 缓冲 |
| 加载成功但怀疑没走 GPU | 在 offscreen 里打印 `navigator.gpu`、`requestAdapter()` 和实际 device | adapter 为 null 或 device 落到 wasm |
| 想知道是模型的问题还是扩展上下文的问题 | `node probes/probe-bare-page.mjs` | 纯网页能跑 → 问题在扩展上下文；纯网页也崩 → 问题在模型或运行时 |
| 模型源可能不通 | `curl -I` 目标 URL | 可达性、重定向、Content-Length |
| 怀疑浏览器存不下大文件 | 在页面里写入 1.45GB，再读回核对字节数和长度 | 长度是否保留、耗时是否线性 |

仓库里只剩纯网页最小复现 `probes/probe-bare-page.mjs`。它和之前的诊断探针一样，从 `~/Projects/map-tile-lab` 借 playwright，并需要 `~/Projects/gemma-browser-lab/models/` 存在。旧 popup 测试载体 `ext/` 和其余探针已在 2026-10-19 清理中移除；下面各症状给的是可重建的最小步骤。

## 症状一：浏览器进程崩溃

扩展目录只需要 `manifest.json` + `bigfetch.html` + `bigfetch.js`。页面里 `fetch(chrome.runtime.getURL(file))`，用 `reader.read()` 逐块累加 `bytes`，**不保留 buffer、不解析**。把大文件硬链接进扩展目录，然后按 512 / 1000 / 1024 / 1100 MB 分档，每档新开一次浏览器：

```bash
mkdir -p bigfetch-ext/models/onnx-community/gemma-4-E2B-it-ONNX/onnx
ln ~/Projects/gemma-browser-lab/models/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx_data \
   bigfetch-ext/models/onnx-community/gemma-4-E2B-it-ONNX/onnx/
# 打开 chrome-extension://<id>/bigfetch.html?f=<相对路径>&limit=<字节数>
```

判读：崩溃边界卡在 **1000 MiB 正常 / 1024 MiB 崩**（1024 MiB = 2³⁰）就说明是 `chrome-extension://` 的内部长度限制，不是内存不够。主进程 `EXC_BREAKPOINT` + 整数边界 = 断言失败，不是 OOM —— OOM 会杀渲染进程，不会卡在这么整齐的数上。

撞上这条边界只有一个解法：**别从扩展包里读**。模型改走远端下载 + Cache API（见 `README.md`）。

## 症状二：加载极慢（O(n²) 缓冲）

先看响应头有没有 `content-length`：

```bash
curl -sI --max-time 10 'https://hf-mirror.com/<model>/resolve/main/<小配置文件>'
curl -sI --max-time 10 'https://hf-mirror.com/<model>/resolve/main/<大权重文件>'
```

判读：大文件 `content-length` 为 `null` 或 `transfer-encoding: chunked` → 库会走 `utils/hub/utils.js:148` 的扩容路径，每读一块就把已累积内容整体复制一遍，总量 ≈ N²/(2c)。

**能在现象上认出来**：`progress` 恒为 100% 而持续不动（因为 `total` 被设成 `= loaded`）。

库只认两个长度来源：响应头和 Hub API 的元数据（`hub.js:409-421`）。没有第三个口子。

## 症状三：device / 引擎状态

先用伪 HF 避免真下 3.1GB，并让扩展指向它：

```bash
node testpage/hf-serve.mjs                       # :8090
```

然后在 `chrome://extensions` 打开扩展的 service worker 控制台：

```js
chrome.storage.local.set({ modelHost: 'http://127.0.0.1:8090/' })
```

在 offscreen document 的 DevTools 里检查：

```js
await navigator.gpu?.requestAdapter()            // null → WebGPU 不可用
```

再对照引擎日志里的 `device`。**浏览器随时可能整体消失，日志要实时捞，别等跑完。** 看三样：`patch`/`state` 字段、`progress` 变化、有没有 `state: "error"`。`chrome://gpu` 可以确认 WebGPU 是否被 blocklist 关掉。

## 症状四：是模型的问题还是上下文的问题

```bash
node ~/Projects/gemma-browser-lab/serve.mjs &     # :8080
node probes/probe-bare-page.mjs
```

同一个模型、同一份库、同一个 device，只是宿主从扩展换成普通网页。纯网页能跑 → 问题在扩展上下文；纯网页也崩 → 问题在模型或运行时。

## 症状五：存储能力

在页面里把 1.45GB 分别写进 Cache API / OPFS / IndexedDB，再读回来：

- 写之前记录源文件的 `content-length`
- 读回后**必须核对字节数和 `content-length`**：缓存往返后长度丢了的话，库会掉回 O(n²)
- 实测三者都能扛 1.45GB，且 Cache API 存原始 `Response` 时 `Content-Length` 会保留

`idb` 那条用 `response.blob()`，会把整个文件先驻留内存 —— 它过了不代表内存宽裕。

## 两条不要推翻的结论

1. **MV3 service worker 跑不了推理。** HTML 规范禁止 SW 里动态 `import()`，ORT 的 WebGPU EP 起不来。唯一可用的是 offscreen document。
2. **offscreen document 里没有 `chrome.storage`。** 它只拿到很有限的扩展 API；配置必须由 service worker 读出来再传进去。

架构与完整结论见仓库 `README.md`。
