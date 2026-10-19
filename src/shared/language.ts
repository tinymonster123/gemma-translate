import type { LanguageCode, LanguageInfo, TargetLanguage } from './protocol';
import { targetByCode } from './protocol';

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

/**
 * 粗糙但稳定的页面语言判断：汉字的信息密度按 3 个拉丁字母算。
 * 只用来决定「源语言显示什么」和「默认翻成什么」，不追求语种识别精度。
 */
export function detectLanguage(text: string): LanguageInfo {
  const sample = String(text || '').slice(0, 3000);
  const cjk = (sample.match(CJK) || []).length;
  const latin = (sample.match(LATIN) || []).length;

  if (!cjk && !latin) {
    return { code: 'unknown', label: '未知语言', confidence: 0 };
  }

  const zhWeight = cjk * 3;
  const total = zhWeight + latin;
  const isZh = zhWeight > latin;
  return {
    code: isZh ? 'zh' : 'en',
    label: isZh ? '简体中文' : '英语 (English)',
    confidence: total ? Math.round(((isZh ? zhWeight : latin) / total) * 100) / 100 : 0,
  };
}

/**
 * 页面语言必须忽略我们自己插入的译文（[data-gt]）和浮标，否则翻完一轮后
 * 重开面板会把「英语页面」认成中文。用 TreeWalker 而不是 innerText，
 * 避免为了去掉几个节点去 clone 整棵 body。
 */
export function pageLanguage(doc: Document): LanguageInfo {
  if (!doc.body) return detectLanguage('');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  let text = '';
  while (walker.nextNode() && text.length < 3000) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || skip.has(parent.tagName) || parent.closest('[data-gt], .gt-float')) continue;
    text += node.nodeValue ?? '';
  }
  return detectLanguage(text.slice(0, 3000));
}

export function baseLangCode(code: string): LanguageCode {
  if (code.startsWith('zh')) return 'zh';
  if (code.startsWith('en')) return 'en';
  return 'unknown';
}

export function defaultTarget(language: LanguageInfo): TargetLanguage {
  return targetByCode(language.code === 'zh' ? 'en' : 'zh-CN');
}

export function defaultTargetCode(language: LanguageInfo): string {
  return defaultTarget(language).code;
}
