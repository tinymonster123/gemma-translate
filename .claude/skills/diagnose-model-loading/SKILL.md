---
name: diagnose-model-loading
description: 浏览器或扩展里加载大模型出问题时用 —— 浏览器进程崩溃、加载卡住或异常慢、device 没走 WebGPU、模型源不可达、大文件存不进浏览器存储。按症状跑仓库里的对应探针。
---

# 诊断浏览器里的模型加载

一条铁律：**先做只保留一个变量的最小复现，再谈原因。** 这个项目的三次误判（怪内存、怪 offscreen、怪 WebGPU）全是因为症状像"资源不够"就直接下结论。探针存在的意义就是把变量一个个摘掉。

## 按症状路由

| 症状 | 跑什么 | 它回答什么 |
|---|---|---|
| 浏览器进程直接消失（页面还在，但整个 context 没了） | `probes/probe-bigfetch-limit.mjs` | 崩在哪一个字节数上 |
| 加载卡几十秒甚至更久 | `probes/probe-remote.mjs`，看 `content-length` | 库是不是在走 O(n²) 缓冲 |
| 加载成功但怀疑没走 GPU | `probes/probe-gemma4.mjs` | 真实 device、加载耗时、引擎报错 |
| 想知道是模型的问题还是扩展上下文的问题 | `probes/probe-bare-page.mjs` | 同一模型在纯网页里能不能跑 |
| 模型源可能不通 / 想确认响应头 | `probes/probe-remote.mjs` | 可达性、Content-Length、重定向 |
| 怀疑浏览器存不下大文件 | `probes/probe-storage.mjs <cache\|opfs\|idb>` | 写入耗时、读回耗时、字节是否对得上 |

所有探针都用从 `~/Projects/map-tile-lab` 借来的 playwright。它们都需要 `~/Projects/gemma-browser-lab/models/` 存在。

## 症状一：浏览器进程崩溃

`probes/probe-bigfetch-limit.mjs` 从扩展包里读一个文件、只计数不保留，二分出崩溃边界。**它需要扩展包里先有一个大文件** —— 现在的 `ext/` 是干净的（27MB），所以先临时硬链接一个进去：

```bash
mkdir -p ext/models/onnx-community/gemma-4-E2B-it-ONNX/onnx
ln ~/Projects/gemma-browser-lab/models/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx_data \
   ext/models/onnx-community/gemma-4-E2B-it-ONNX/onnx/
node probes/probe-bigfetch-limit.mjs
rm -rf ext/models          # 测完必须删掉
```

判读：崩溃边界卡在 **1000 MiB 正常 / 1024 MiB 崩**（1024 MiB = 2³⁰）就说明是 `chrome-extension://` 的内部长度限制，不是内存不够。主进程 `EXC_BREAKPOINT` + 整数边界 = 断言失败，不是 OOM —— OOM 会杀渲染进程，不会卡在这么整齐的数上。

撞上这条边界只有一个解法：**别从扩展包里读**。模型改走远端下载 + Cache API（见 `README.md`）。

## 症状二：加载极慢（O(n²) 缓冲）

先看响应头有没有 `content-length`：

```bash
node probes/probe-remote.mjs                                                    # 小配置文件
HEAD_ONLY=1 MODEL_PATH='<model>/resolve/main/<大文件>' node probes/probe-remote.mjs   # 大权重文件，只读头
```

判读：大文件 `content-length` 为 `null` 或 `transfer-encoding: chunked` → 库会走 `utils/hub/utils.js:148` 的扩容路径，每读一块就把已累积内容整体复制一遍，总量 ≈ N²/(2c)。

**能在现象上认出来**：`progress` 恒为 100% 而持续不动（因为 `total` 被设成 `= loaded`）。

库只认两个长度来源：响应头和 Hub API 的元数据（`hub.js:409-421`）。没有第三个口子。

## 症状三：device / 引擎状态

```bash
node testpage/hf-serve.mjs &                                        # 伪 HF，避免真下 3.1GB
MODEL_HOST=http://127.0.0.1:8090/ WATCH_MS=120000 node probes/probe-gemma4.mjs
```

它每 300ms ping 一次引擎并把广播日志实时打出来 —— **浏览器随时可能整体消失，捞晚了什么都不剩**。看三样：`patch`/`state` 字段、`progress` 变化、有没有 `state: "error"`。

## 症状四：是模型的问题还是上下文的问题

```bash
node ~/Projects/gemma-browser-lab/serve.mjs &     # :8080
node probes/probe-bare-page.mjs
```

同一个模型、同一份库、同一个 device，只是宿主从扩展换成普通网页。纯网页能跑 → 问题在扩展上下文；纯网页也崩 → 问题在模型或运行时。

## 症状五：存储能力

```bash
node ~/Projects/gemma-browser-lab/serve.mjs &
node probes/probe-storage.mjs cache      # 或 opfs / idb
```

读回时**必须核对字节数和 `content-length`**：缓存往返后长度丢了的话，库会掉回 O(n²)。实测三者都能扛 1.45GB，且 Cache API 存原始 Response 时 `Content-Length` 会保留。

`idb` 那条用 `response.blob()`，会把整个文件先驻留内存 —— 它过了不代表内存宽裕。

## 两条不要推翻的结论

1. **MV3 service worker 跑不了推理。** HTML 规范禁止 SW 里动态 `import()`，ORT 的 WebGPU EP 起不来。唯一可用的是 offscreen document。
2. **offscreen document 里没有 `chrome.storage`。** 它只拿到很有限的扩展 API；配置必须由 service worker 读出来再传进去。

架构与完整结论见仓库 `README.md`。
