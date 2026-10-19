import { browser } from 'wxt/browser';

export interface Settings {
  /** 开发 / 测试时指向伪 HF 服务；生产为 null → 默认 hf-mirror */
  modelHost: string | null;
  /** 上次选择的目标语言 */
  targetLanguage: string;
}

const DEFAULTS: Settings = {
  modelHost: null,
  targetLanguage: 'zh-CN',
};

export async function getSettings(): Promise<Settings> {
  const raw = (await (browser.storage.local.get as (keys: string[]) => Promise<any>)([
    'modelHost',
    'targetLanguage',
  ])) as Record<string, unknown>;
  return {
    modelHost: typeof raw.modelHost === 'string' && raw.modelHost ? raw.modelHost : null,
    targetLanguage:
      typeof raw.targetLanguage === 'string' ? raw.targetLanguage : DEFAULTS.targetLanguage,
  };
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}
