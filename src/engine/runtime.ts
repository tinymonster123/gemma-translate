import { pipeline, TextStreamer } from '@huggingface/transformers';
import { configure, DEVICE, DTYPE, MODEL_ID } from './source';
import {
  appendChunk,
  buildMessages,
  type ChunkTiming,
  maxNewTokens,
  splitText,
  summarizeTimings,
  type TimingSummary,
} from './text';

export { MODEL_ID, setModelHost } from './source';

export interface Progress {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface LoadResult {
  cached: boolean;
  ms: number;
}

export interface TranslateArgs {
  text: string;
  target: string;
  onDelta?: (delta: string) => void;
}

export interface TranslateResult {
  text: string;
  chunks: number;
  ms: number;
  /** 每段的 token 数 / 首 token 时间 / decode 拆分 */
  stats: TimingSummary;
}

// 不同版本的 transformers.js 对 pipeline 的泛型不一致，这里只关心调用形状。
type Generator = any;

let generator: Generator | null = null;
let loadingPromise: Promise<LoadResult> | null = null;

export function isReady(): boolean {
  return generator !== null;
}

/** 诊断用：确认实际落到的 device / dtype 和 ORT session 的可见字段。 */
export function deviceInfo(): Record<string, unknown> {
  const sessions = (generator as any)?.model?.sessions ?? {};
  const first: any = Object.values(sessions)[0];
  return {
    configuredDevice: DEVICE,
    dtype: DTYPE,
    hasWebGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    sessionKeys: first ? Object.keys(first) : [],
    sessionConfig: first?.config ?? null,
    sessionOptions: first?.sessionOptions ?? null,
    handlerKeys: first?.handler ? Object.keys(first.handler) : [],
  };
}

export function load(onProgress?: (p: Progress) => void): Promise<LoadResult> {
  if (generator) return Promise.resolve({ cached: true, ms: 0 });
  if (loadingPromise) return loadingPromise;

  const t0 = performance.now();

  loadingPromise = (async () => {
    configure();
    const g = await pipeline('text-generation', MODEL_ID, {
      device: DEVICE,
      dtype: DTYPE,
      progress_callback: (p: any) =>
        onProgress?.({
          status: p.status,
          file: p.file,
          loaded: p.loaded,
          total: p.total,
        }),
    } as any);

    generator = g;
    return { cached: false, ms: Math.round(performance.now() - t0) };
  })();

  // 失败时不要把 rejected promise 永久留在缓存里
  loadingPromise.catch(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

/**
 * 预热：模型加载完成后先跑一次 1-token 生成。
 *
 * `pipeline()` resolve 时 session 还没完全就绪；第一段真实翻译会额外付
 * 2–6 秒的 session / 着色器初始化。放在面板打开时做，点击翻译就不用再付。
 */
export async function warmup(): Promise<{ ms: number }> {
  if (!generator) await load();

  const t0 = performance.now();
  await generator(buildMessages('Hello', 'Chinese (Simplified)'), {
    max_new_tokens: 1,
    do_sample: false,
  });
  return { ms: Math.round(performance.now() - t0) };
}

export async function translate({
  text,
  target,
  onDelta,
}: TranslateArgs): Promise<TranslateResult> {
  if (!generator) await load();

  const chunks = splitText(text);
  const t0 = performance.now();
  const timings: ChunkTiming[] = [];
  let out = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const chunkStart = performance.now();
    let piece = '';
    let tokens = 0;
    let firstTokenMs: number | null = null;
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      token_callback_function: (generated: bigint[]) => {
        tokens += generated.length;
        if (firstTokenMs == null) {
          firstTokenMs = Math.round(performance.now() - chunkStart);
        }
      },
      callback_function: (s: string) => {
        piece += s;
        onDelta?.(s);
      },
    });

    await generator(buildMessages(chunk, target), {
      max_new_tokens: maxNewTokens(chunk.length),
      do_sample: false, // 贪婪 → 同一输入同一输出

      // 治小模型的复读机；贪婪解码下同样生效。
      repetition_penalty: 1.15,
      no_repeat_ngram_size: 6,
      streamer,
    });

    timings.push({
      ms: Math.round(performance.now() - chunkStart),
      tokens,
      firstTokenMs,
    });

    const cleaned = piece.trim();
    if (cleaned) {
      if (i > 0) onDelta?.(' ');
      out = appendChunk(out, cleaned);
    }
  }

  return {
    text: out,
    chunks: chunks.length,
    ms: Math.round(performance.now() - t0),
    stats: summarizeTimings(timings),
  };
}
