import { env, LogLevel } from '@huggingface/transformers';
import { browser } from 'wxt/browser';

export const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
export const DEFAULT_MODEL_HOST = 'https://hf-mirror.com/';
export const DEVICE = 'webgpu';
export const DTYPE = 'q4f16';
export const CACHE_KEY = 'gemma-translate';

let modelHostOverride: string | null = null;

export function setModelHost(host: string | null): void {
  if (host) modelHostOverride = host;
}

export interface SourceConfig {
  modelHost: string;
  cacheKey: string;
  useBrowserCache: boolean;
}

/**
 * 配置 transformers.js 的模型来源与 wasm 路径。
 * 关键约束都写在这里，改之前先看 README 的三条结论。
 */
export function configure(): SourceConfig {
  env.allowLocalModels = false; // 绝不再从扩展包里读模型（≥1 GiB 会崩）
  env.allowRemoteModels = true;
  env.remoteHost = modelHostOverride || DEFAULT_MODEL_HOST;
  env.remotePathTemplate = '{model}/resolve/{revision}/';
  env.useBrowserCache = true; // 先查 Cache API，没有再下载并写回
  env.cacheKey = CACHE_KEY;
  env.useWasmCache = true;
  env.logLevel = LogLevel.ERROR;

  // wasm 是构建产物（scripts/copy-ort.mjs 从 onnxruntime-web 复制到 public/ort/）。
  // 26MB，远低于 1 GiB 那条线，可以留在扩展包里。
  const ort = (browser.runtime.getURL as (path: string) => string)('/ort/');
  env.backends.onnx.wasm!.wasmPaths = {
    mjs: `${ort}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${ort}ort-wasm-simd-threaded.asyncify.wasm`,
  };

  return {
    modelHost: env.remoteHost,
    cacheKey: CACHE_KEY,
    useBrowserCache: env.useBrowserCache,
  };
}
