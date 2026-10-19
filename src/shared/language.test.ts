import { describe, expect, it } from 'vitest';
import { baseLangCode, defaultTarget, detectLanguage } from './language';

describe('detectLanguage', () => {
  it('识别中文页面', () => {
    const r = detectLanguage('这是一个用于测试的中文句子，包含足够多的汉字。');
    expect(r.code).toBe('zh');
    expect(r.label).toContain('简体中文');
  });

  it('识别英文页面', () => {
    const r = detectLanguage('This is an English sentence used to test language detection.');
    expect(r.code).toBe('en');
    expect(r.label).toContain('English');
  });

  it('纯符号返回 unknown', () => {
    expect(detectLanguage('1234 !!! ---').code).toBe('unknown');
  });

  it('中文页默认翻成英文', () => {
    expect(defaultTarget({ code: 'zh', label: '', confidence: 1 }).code).toBe('en');
  });

  it('英文页默认翻成简体中文', () => {
    expect(defaultTarget({ code: 'en', label: '', confidence: 1 }).code).toBe('zh-CN');
  });

  it('目标语言映射到基础语种', () => {
    expect(baseLangCode('zh-CN')).toBe('zh');
    expect(baseLangCode('en')).toBe('en');
    expect(baseLangCode('ja')).toBe('unknown');
  });
});
