import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  type BgRequest,
  type EngineEnsureResult,
  isBgRequest,
  type Result,
} from '../src/shared/protocol';

const OFFSCREEN_PATH = '/offscreen.html';
const READY_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const err = (error: string): Result<never> => ({ ok: false, error });

export default defineBackground(() => {
  // 没有 default_popup：点图标 → 注入页面脚本 → 切换页面内的悬浮面板。
  browser.action.onClicked.addListener((tab) => {
    if (tab.id == null) return;
    void togglePanel(tab.id).catch((e) => {
      console.warn('[gemma-translate] 打开面板失败:', e);
      browser.action.setBadgeText({ tabId: tab.id, text: '×' }).catch(() => {});
      browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b4232a' }).catch(() => {});
    });
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isBgRequest(msg)) return;
    handle(msg, sender).then(sendResponse, (e) =>
      sendResponse(err(String((e as Error)?.message ?? e))),
    );
    return true;
  });

  // 测试缝：Playwright 点不到工具栏图标，但可以走同一条 toggle 路径。
  (self as any).__GT_TOGGLE_PANEL = togglePanel;
});

async function handle(msg: BgRequest, sender: { tab?: { id?: number } }): Promise<Result<unknown>> {
  try {
    switch (msg.type) {
      case 'engine:ensure':
        return await ensureOffscreen(sender.tab?.id ?? null);
      case 'engine:relay':
        // offscreen 只拿得到 runtime API；content script 必须由 SW 用 tabs.sendMessage 触达。
        await browser.tabs.sendMessage(msg.tabId, msg.event);
        return ok(null);
      default:
        return err('未知消息');
    }
  } catch (e) {
    return err(String((e as Error)?.message ?? e));
  }
}

async function togglePanel(tabId: number): Promise<unknown> {
  await ensurePageScript(tabId);

  let last: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      return await browser.tabs.sendMessage(tabId, { to: 'page', type: 'panel:toggle' });
    } catch (e) {
      last = e;
      await sleep(80);
    }
  }
  throw last;
}

async function ensurePageScript(tabId: number): Promise<void> {
  // CSS 走 insertCSS，页面自己的 CSP 管不到。
  try {
    await browser.scripting.insertCSS({ target: { tabId }, files: ['assets/page-style.css'] });
  } catch {
    /* 重复插入无害 */
  }

  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/page.js'] });
  } catch (e) {
    throw new Error(
      `注入失败（chrome://、商店页或未授权页面）：${String((e as Error)?.message ?? e)}`,
    );
  }
}

let ensurePromise: Promise<Result<EngineEnsureResult>> | null = null;

function ensureOffscreen(tabId: number | null): Promise<Result<EngineEnsureResult>> {
  if (!ensurePromise) {
    ensurePromise = doEnsureOffscreen(tabId).finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

async function doEnsureOffscreen(tabId: number | null): Promise<Result<EngineEnsureResult>> {
  if (!(await browser.offscreen.hasDocument())) {
    await browser.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification:
        '在 Window 上下文里常驻本地 Gemma 模型并做整页翻译；MV3 service worker 不允许动态 import，承载不了推理。',
    });
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const r: any = await browser.runtime.sendMessage({ to: 'engine', type: 'ping' });
      if (r?.ok !== false) {
        // offscreen 读不到 chrome.storage，配置只能由这里转发。
        const { modelHost } = await browser.storage.local.get('modelHost');
        await browser.runtime
          .sendMessage({
            to: 'engine',
            type: 'config',
            modelHost: modelHost ?? null,
            relayTabId: tabId,
          })
          .catch(() => {});
        return ok<EngineEnsureResult>({
          ok: true,
          model: r?.model,
          cached: !!r?.ready,
        });
      }
      lastError = r?.error ?? '引擎处于错误状态';
      break;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
      await sleep(150);
    }
  }

  return err(`offscreen 未就绪: ${lastError}`);
}
