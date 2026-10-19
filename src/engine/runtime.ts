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
  /** 实验开关：复用 system prompt 的 KV 前缀 */
  usePrefix?: boolean;
}

export interface TranslateResult {
  text: string;
  chunks: number;
  ms: number;
  /** 每段的 token 数 / 首 token 时间 / decode 拆分 */
  stats: TimingSummary;
  /** 这一段是否真的走了前缀复用 */
  prefix: boolean;
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

/**
 * 可复用的 KV cache。和 DynamicCache 的区别：update 不 dispose 旧张量。
 *
 * generate() 会把新生成的 token 写回 cache；如果沿用 DynamicCache，
 * 它会释放上一轮的 prefix 张量，下一段就无 cache 可复用。这里保留
 * prefix 张量，每段开始前把生成产生的条目清掉并恢复 prefix 快照。
 */
class ReusableCache {
  get_seq_length(): number {
    for (const name of Object.keys(this)) {
      if (name.startsWith('past_key_values.')) return (this as any)[name].dims.at(-2);
    }
    return 0;
  }

  update(entries: Record<string, any>): void {
    Object.assign(this, entries);
  }
}

interface PrefixState {
  cache: ReusableCache;
  prefix: Record<string, any>;
  prefixIds: number[];
}

const prefixCaches = new Map<string, Promise<PrefixState | null>>();

export function load(onProgress?: (p: Progress) => void): Promise<LoadResult> {
  if (generator) return Promise.resolve({ cached: true, ms: 0 });
  if (loadingPromise) return loadingPromise;

  const t0 = performance.now();

  loadingPromise = (async () => {
    prefixCaches.clear();
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
export async function warmup({
  target = 'Chinese (Simplified)',
  usePrefix = false,
}: {
  target?: string;
  usePrefix?: boolean;
} = {}): Promise<{ ms: number; prefixMs: number | null }> {
  if (!generator) await load();

  const t0 = performance.now();
  await generator(buildMessages('Hello', target), {
    max_new_tokens: 1,
    do_sample: false,
  });
  const ms = Math.round(performance.now() - t0);

  let prefixMs: number | null = null;
  if (usePrefix) {
    const p0 = performance.now();
    await getPrefixState(target);
    prefixMs = Math.round(performance.now() - p0);
  }

  return { ms, prefixMs };
}

function absorbPresent(cache: ReusableCache, outputs: Record<string, any>): void {
  const entries: Record<string, any> = {};
  for (const name of Object.keys(outputs)) {
    if (name.startsWith('present')) {
      entries[name.replace('present', 'past_key_values')] = outputs[name];
    }
  }
  cache.update(entries);
}

/** 预填 system prompt，得到可复用的 KV 前缀；按目标语言缓存。 */
async function getPrefixState(target: string): Promise<PrefixState | null> {
  const existing = prefixCaches.get(target);
  if (existing) return existing;

  const p = (async (): Promise<PrefixState | null> => {
    try {
      const tokenizer = generator.tokenizer;
      const system = buildMessages('', target)[0]!;
      const prefixText = tokenizer.apply_chat_template([system], {
        tokenize: false,
        add_generation_prompt: false,
      });
      const encoded = tokenizer(prefixText, { add_special_tokens: false });
      const cache = new ReusableCache();
      const outputs = await generator.model.forward({
        input_ids: encoded.input_ids,
        attention_mask: encoded.attention_mask,
        past_key_values: cache,
      });

      const before = { ...cache };
      absorbPresent(cache, outputs);

      // prefill 的 logits 和旧 zero-size cache 都不再需要。
      for (const [name, value] of Object.entries(outputs)) {
        if (!name.startsWith('present') && (value as any)?.location === 'gpu-buffer') {
          (value as any).dispose?.();
        }
      }
      for (const [name, old] of Object.entries(before)) {
        const current = (cache as any)[name];
        if (current !== old && (old as any)?.location === 'gpu-buffer') {
          (old as any).dispose?.();
        }
      }

      const prefix: Record<string, any> = {};
      for (const name of Object.keys(cache)) prefix[name] = (cache as any)[name];
      const prefixIds = encoded.input_ids.tolist()[0].map((x: bigint) => Number(x));

      if (!prefixIds.length || !Object.keys(prefix).length) return null;
      return { cache, prefix, prefixIds };
    } catch (e) {
      console.warn('[gemma-translate] prefix cache 初始化失败:', e);
      return null;
    }
  })();

  prefixCaches.set(target, p);
  return p;
}

/** 丢掉上一段生成写进 cache 的条目，恢复到 system prompt 前缀。 */
function resetPrefixCache(state: PrefixState): void {
  for (const key of Object.keys(state.cache)) {
    if (!(key in state.prefix)) {
      const value = (state.cache as any)[key];
      if (value?.location === 'gpu-buffer') value.dispose?.();
      delete (state.cache as any)[key];
    }
  }
  Object.assign(state.cache, state.prefix);
}

export async function translate({
  text,
  target,
  onDelta,
  usePrefix,
}: TranslateArgs): Promise<TranslateResult> {
  if (!generator) await load();

  const chunks = splitText(text);
  const t0 = performance.now();
  const timings: ChunkTiming[] = [];
  const prefixState = usePrefix ? await getPrefixState(target) : null;
  let usedPrefixAny = false;
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

    const messages = buildMessages(chunk, target);
    const generation = {
      max_new_tokens: maxNewTokens(chunk.length),
      do_sample: false, // 贪婪 → 同一输入同一输出

      // 治小模型的复读机；贪婪解码下同样生效。
      repetition_penalty: 1.15,
      no_repeat_ngram_size: 6,
      streamer,
    };

    let usedPrefix = false;
    if (prefixState) {
      try {
        const tokenizer = generator.tokenizer;
        const prompt = tokenizer.apply_chat_template(messages, {
          tokenize: false,
          add_generation_prompt: true,
        });
        const encoded = tokenizer(prompt, { add_special_tokens: false });
        const ids: number[] = encoded.input_ids.tolist()[0].map((x: bigint) => Number(x));
        const prefixMatches = prefixState.prefixIds.every((value, index) => ids[index] === value);

        if (prefixMatches) {
          resetPrefixCache(prefixState);
          await generator.model.generate({
            input_ids: encoded.input_ids,
            attention_mask: encoded.attention_mask,
            past_key_values: prefixState.cache,
            ...generation,
          });
          usedPrefix = true;
          usedPrefixAny = true;
        }
      } catch (e) {
        console.warn('[gemma-translate] prefix 推理失败，回退逐段:', e);
        resetPrefixCache(prefixState);
      }
    }

    if (!usedPrefix) {
      await generator(messages, generation);
    }

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
    prefix: usedPrefixAny,
  };
}
