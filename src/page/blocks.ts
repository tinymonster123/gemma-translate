import { detectLanguage } from '../shared/language';
import type { LanguageCode } from '../shared/protocol';

export interface Block {
  el: HTMLElement;
  text: string;
}

const BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption, summary';
// 裸文本 div：没有元素子节点，整块就是一句话。文档站和博客里很常见。
const BARE_SEL = 'div:not(:has(*))';
const SKIP_SEL =
  '[data-gt], .gt-float, pre, code, script, style, noscript, textarea, select, [contenteditable="true"]';
const INSERT_INSIDE = new Set(['LI', 'TD', 'TH', 'DD', 'DT', 'SUMMARY', 'FIGCAPTION']);

function hasBlockAncestor(el: Element): boolean {
  return !!el.parentElement?.closest(BLOCK_SEL);
}

function isVisible(el: HTMLElement): boolean {
  const rects = el.getClientRects();
  for (const r of rects) if (r.width > 4 && r.height > 4) return true;
  return false;
}

/** 纯文本层面的可翻性判断；DOM 相关的可见性在外面。 */
export function isTranslatableText(text: string, target: LanguageCode): boolean {
  if (!text || text.length < 2 || text.length > 6000) return false;
  if (!/\p{L}/u.test(text)) return false; // 至少得有一个字母
  if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(text)) return false; // 纯数字 / 符号
  if (detectLanguage(text).code === target) return false; // 已经是目标语言
  return true;
}

export function collectBlocks(doc: Document, target: LanguageCode): Block[] {
  const seen = new Set<Element>();
  const out: Block[] = [];

  const consider = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    // 已经翻过：内部（li/td 等）或紧邻后面（p/h* 等）已经有译文块。
    // 停止后「继续翻译」会重新 collect，不能给同一段插第二份译文。
    if (el.querySelector(':scope > [data-gt]') || el.nextElementSibling?.hasAttribute('data-gt'))
      return;
    const text = ((el as HTMLElement).innerText || '').trim();
    if (!isTranslatableText(text, target)) return;
    if (el.closest(SKIP_SEL)) return;
    if (!isVisible(el as HTMLElement)) return;
    out.push({ el: el as HTMLElement, text });
  };

  for (const el of doc.querySelectorAll(BLOCK_SEL)) {
    if (hasBlockAncestor(el)) continue;
    consider(el);
  }
  for (const el of doc.querySelectorAll(BARE_SEL)) {
    if (el.closest('.gt-float') || hasBlockAncestor(el)) continue;
    consider(el);
  }
  return out;
}

export function shouldInsertInside(el: HTMLElement): boolean {
  return INSERT_INSIDE.has(el.tagName);
}

/** 按所在块的背景亮度选译文配色，避免深色页/浅色页必糊一边。 */
export function themeOf(el: HTMLElement): 'gt-light' | 'gt-dark' {
  let n: Element | null = el;
  while (n && n.nodeType === 1) {
    const m = getComputedStyle(n).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1]!.split(',').map(Number);
      if ((p.length > 3 ? p[3]! : 1) > 0.5) {
        const lum = (0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!) / 255;
        return lum < 0.5 ? 'gt-dark' : 'gt-light';
      }
    }
    n = n.parentElement;
  }
  return 'gt-light';
}
