import { describe, expect, it } from 'vitest';
import { appendChunk, buildMessages, maxNewTokens, splitText } from './text';

describe('splitText', () => {
  it('短文本不切', () => {
    expect(splitText('hello world')).toEqual(['hello world']);
  });

  it('长文本按句子切到 600 字以内', () => {
    const sentence = 'This is a sentence. ';
    const text = sentence.repeat(100);
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('This is a sentence.');
  });

  it('中文标点也能切', () => {
    const text = '这是第一句。'.repeat(120);
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
  });
});

describe('appendChunk', () => {
  it('英文块之间加空格', () => {
    expect(appendChunk('Hello', 'world')).toBe('Hello world');
  });

  it('中文块之间不加空格', () => {
    expect(appendChunk('你好', '世界')).toBe('你好世界');
  });

  it('中英混合按边界判断', () => {
    expect(appendChunk('你好', 'world')).toBe('你好world');
    expect(appendChunk('hello', '世界')).toBe('hello世界');
  });
});

describe('buildMessages', () => {
  it('包含 system 和 user，且目标语言进 prompt', () => {
    const messages = buildMessages('hello', 'Chinese (Simplified)');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('Chinese (Simplified)');
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
  });
});

describe('maxNewTokens', () => {
  it('有下限和上限', () => {
    expect(maxNewTokens(1)).toBe(48);
    expect(maxNewTokens(1000)).toBe(400);
    expect(maxNewTokens(100)).toBe(220);
  });
});
