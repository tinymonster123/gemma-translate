// 所有跨上下文的形状都从这里出去。
// 注意：协议模块不是运行时中转站 —— 每个上下文 import 它，消息仍然走 chrome.runtime。

export type LanguageCode = 'zh' | 'en' | 'unknown';

export interface LanguageInfo {
  code: LanguageCode;
  label: string;
  confidence: number;
}

export interface TargetLanguage {
  /** 用于过滤「已经是目标语言」的文本 */
  code: string;
  /** UI 显示名 */
  label: string;
  /** 发给模型的英文语言名 */
  prompt: string;
}

export const TARGET_LANGUAGES: TargetLanguage[] = [
  { code: 'zh-CN', label: '简体中文', prompt: 'Chinese (Simplified)' },
  { code: 'en', label: 'English', prompt: 'English' },
  { code: 'ja', label: '日本語', prompt: 'Japanese' },
  { code: 'ko', label: '한국어', prompt: 'Korean' },
  { code: 'fr', label: 'Français', prompt: 'French' },
  { code: 'de', label: 'Deutsch', prompt: 'German' },
  { code: 'es', label: 'Español', prompt: 'Spanish' },
];

export function targetByCode(code: string): TargetLanguage {
  return TARGET_LANGUAGES.find((t) => t.code === code) ?? TARGET_LANGUAGES[0]!;
}

export type SessionPhase =
  | 'idle'
  | 'probing'
  | 'loading'
  | 'translating'
  | 'done'
  | 'stopped'
  | 'error';

export interface SessionState {
  phase: SessionPhase;
  done: number;
  total: number;
  target?: TargetLanguage | null;
  enginePercent?: number | null;
  /** 面板打开后的后台预热（加载模型 + 1-token 推理），不阻塞用户操作 */
  preloading?: boolean;
  message?: string;
}

export interface PageProbeResult {
  url: string;
  title: string;
  language: LanguageInfo;
  blockCount: number;
  session: SessionState;
}

export interface Result<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── page → background ───────────────────────────────────────────
// 面板和页面会话在同一个上下文，只有「拉起 offscreen」需要找 background。
export type BgRequest =
  | { to: 'bg'; type: 'engine:ensure' }
  /** offscreen 不能直接给 content script 发消息，必须由 SW 用 tabs.sendMessage 转发 */
  | { to: 'bg'; type: 'engine:relay'; tabId: number; event: EngineEvent };

// ── background → page ───────────────────────────────────────────
// 点插件图标只做一件事：让页面里的悬浮面板显示/隐藏。
export type PageRequest = { to: 'page'; type: 'panel:toggle' };

// ── page / background → offscreen ───────────────────────────────
export type EngineRequest =
  | { to: 'engine'; type: 'ping' }
  | { to: 'engine'; type: 'config'; modelHost: string | null; relayTabId?: number | null }
  | { to: 'engine'; type: 'ensure' }
  | { to: 'engine'; type: 'warmup'; target?: string; usePrefix?: boolean }
  | {
      to: 'engine';
      type: 'translate';
      reqId: string;
      seq: number;
      text: string;
      target: string;
      /** 实验开关：复用 system prompt 的 KV 前缀 */
      usePrefix?: boolean;
    }
  | {
      to: 'engine';
      type: 'bench';
      text: string;
      target: string;
      maxNewTokens: number;
      repeats: number;
      variants: BenchVariant[];
    }
  | {
      to: 'engine';
      type: 'bench-parallel';
      text: string;
      target: string;
      maxNewTokens: number;
      repeats: number;
      parallel: number;
      options?: Record<string, unknown>;
    };

/** 实验用：一组同输入不同 generate 参数的对照。 */
export interface BenchVariant {
  name: string;
  /** 覆盖 pipeline 的生成参数 */
  options?: Record<string, unknown>;
  /** 覆盖 system prompt（默认用 buildMessages 的那条） */
  system?: string;
  /** 是否挂 detokenize 回调（默认 true） */
  withTextCallback?: boolean;
}

export interface BenchRun {
  variant: string;
  ms: number;
  tokens: number;
  firstTokenMs: number | null;
  chars: number;
  text: string;
}

export interface EngineStatusEvent {
  from: 'engine';
  type: 'status';
  state: 'loading' | 'ready' | 'error';
  model: string;
  file?: string | null;
  loaded?: number;
  total?: number | null;
  percent?: number | null;
  ms?: number;
  cached?: boolean;
  message?: string;
}

export interface EngineChunkEvent {
  from: 'engine';
  type: 'chunk';
  reqId: string;
  seq: number;
  delta: string;
}

export interface EngineBootEvent {
  from: 'engine';
  type: 'boot';
  model: string;
  state: string;
}

export type EngineEvent = EngineStatusEvent | EngineChunkEvent | EngineBootEvent;

export interface EngineEnsureResult {
  ok: boolean;
  cached?: boolean;
  ms?: number;
  model?: string;
  error?: string;
}

export const isBgRequest = (m: unknown): m is BgRequest =>
  !!m && typeof m === 'object' && (m as { to?: string }).to === 'bg';

export const isPageRequest = (m: unknown): m is PageRequest =>
  !!m && typeof m === 'object' && (m as { to?: string }).to === 'page';

export const isEngineRequest = (m: unknown): m is EngineRequest =>
  !!m && typeof m === 'object' && (m as { to?: string }).to === 'engine';

export const isEngineEvent = (m: unknown): m is EngineEvent =>
  !!m && typeof m === 'object' && (m as { from?: string }).from === 'engine';
