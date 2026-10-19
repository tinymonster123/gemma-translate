// 纯文本逻辑：切分、拼回、prompt、token 预算。
// 这个模块不 import transformers.js，可以在 Node / Vitest 里直接跑。

const MAX_CHUNK = 600;

export function splitText(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_CHUNK) return [t];

  const parts = t.match(/[^.!?。！？；;]+[.!?。！？；;]*\s*/g) ?? [t];
  const chunks: string[] = [];
  let cur = '';

  for (const p of parts) {
    if (cur && (cur + p).length > MAX_CHUNK) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [t];
}

/** 中文块之间不塞空格，英文块之间要。 */
export function appendChunk(a: string, b: string): string {
  if (!a) return b;
  const endsCJK = /[一-鿿]$/.test(a);
  const startsCJK = /^[一-鿿]/.test(b);
  return endsCJK || startsCJK ? a + b : `${a} ${b}`;
}

export function buildMessages(
  text: string,
  target: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        `You are a professional translator. Translate the text the user sends into ${target}. ` +
        `Reply with only the translation — no explanation, no notes, no original text, no quotes.`,
    },
    { role: 'user', content: text },
  ];
}

/** 上限跟着输入长度走，但不让它无限生成。 */
export function maxNewTokens(chunkLength: number): number {
  return Math.min(400, Math.max(48, Math.round(chunkLength * 2.2)));
}

export interface ChunkTiming {
  /** 这个 chunk 从调用 generator 到结束的总耗时 */
  ms: number;
  /** 生成的 token 数（不含 prompt） */
  tokens: number;
  /** 第一个生成 token 到达的时间；没有输出时为 null */
  firstTokenMs: number | null;
}

export interface TimingSummary {
  chunks: number;
  tokens: number;
  /** 第一块的首 token 时间；没有输出时为 null */
  firstTokenMs: number | null;
  /** 所有 chunk 的首 token 时间之和（prefill + 首 token） */
  prefillMs: number;
  /** 所有 chunk 首 token 之后的解码时间之和 */
  decodeMs: number;
}

/** 把逐 chunk 计时汇总成一段的推理拆分；纯函数，便于单测。 */
export function summarizeTimings(chunks: ChunkTiming[]): TimingSummary {
  let tokens = 0;
  let prefillMs = 0;
  let decodeMs = 0;
  let firstTokenMs: number | null = null;

  for (const chunk of chunks) {
    tokens += chunk.tokens;
    if (chunk.firstTokenMs == null) {
      // 没有回调到 token：把耗时算进 prefill，避免凭空消失。
      prefillMs += chunk.ms;
      continue;
    }
    prefillMs += chunk.firstTokenMs;
    decodeMs += Math.max(0, chunk.ms - chunk.firstTokenMs);
    if (firstTokenMs == null) firstTokenMs = chunk.firstTokenMs;
  }

  return { chunks: chunks.length, tokens, firstTokenMs, prefillMs, decodeMs };
}
