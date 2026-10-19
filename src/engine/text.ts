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
