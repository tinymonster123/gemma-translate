import { browser } from 'wxt/browser';

export interface Settings {
  /** 开发 / 测试时指向伪 HF 服务；生产为 null → 默认 hf-mirror */
  modelHost: string | null;
  /** 上次选择的目标语言 */
  targetLanguage: string;
  /** 实验开关：复用 system prompt 的 KV 前缀 */
  prefixCache: boolean;
}

const DEFAULTS: Settings = {
  modelHost: null,
  targetLanguage: 'zh-CN',
  prefixCache: true,
};

export async function getSettings(): Promise<Settings> {
  const raw = (await (browser.storage.local.get as (keys: string[]) => Promise<any>)([
    'modelHost',
    'targetLanguage',
    'prefixCache',
  ])) as Record<string, unknown>;
  return {
    modelHost: typeof raw.modelHost === 'string' && raw.modelHost ? raw.modelHost : null,
    targetLanguage:
      typeof raw.targetLanguage === 'string' ? raw.targetLanguage : DEFAULTS.targetLanguage,
    prefixCache: raw.prefixCache !== false,
  };
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

/**
 * 是否成功加载过模型。只有置为 true 时，面板打开才会后台预加载；
 * 第一次使用不能因为「打开面板」就无提示下 3GB。
 */
export async function isModelCached(): Promise<boolean> {
  const raw = (await browser.storage.local.get('modelCached')) as Record<string, unknown>;
  return raw.modelCached === true;
}

export async function markModelCached(): Promise<void> {
  await browser.storage.local.set({ modelCached: true });
}
