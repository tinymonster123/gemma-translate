import { browser } from 'wxt/browser';
import {
  bench,
  benchParallel,
  deviceInfo,
  isReady,
  load,
  MODEL_ID,
  setModelHost,
  translate,
  warmup,
} from '../../src/engine/runtime';
import { type EngineEvent, isEngineRequest } from '../../src/shared/protocol';

let state: 'cold' | 'loading' | 'ready' | 'error' = 'cold';
let lastError: string | null = null;
/** 由 SW 转发的目标标签页；offscreen 只拿得到 runtime API，触达不到 content script。 */
let relayTabId: number | null = null;

function broadcast(msg: EngineEvent, tabId: number | null = relayTabId): void {
  try {
    if (tabId != null) {
      void browser.runtime
        .sendMessage({ to: 'bg', type: 'engine:relay', tabId, event: msg })
        .catch(() => {});
    } else {
      void browser.runtime.sendMessage(msg).catch(() => {});
    }
  } catch {
    /* 扩展正在卸载 */
  }
}

// 进度聚合：库按文件回调，这里给用户一个「整体下了多少」。
const fileProgress = new Map<string, { loaded: number; total: number }>();

function snapshotProgress(): { loaded: number; total: number | null } {
  let loaded = 0;
  let total = 0;
  let complete = true;
  for (const v of fileProgress.values()) {
    loaded += v.loaded ?? 0;
    if (v.total) total += v.total;
    else complete = false;
  }
  return { loaded, total: complete ? total : null };
}

let ensurePromise: Promise<{ cached: boolean; ms: number }> | null = null;

function ensureLoaded(): Promise<{ cached: boolean; ms: number }> {
  if (isReady()) return Promise.resolve({ cached: true, ms: 0 });
  if (ensurePromise) return ensurePromise;

  state = 'loading';
  broadcast({ from: 'engine', type: 'status', state: 'loading', model: MODEL_ID, file: null });

  ensurePromise = load((p) => {
    if (p.status !== 'progress' || !p.file) return;
    fileProgress.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    const agg = snapshotProgress();
    broadcast({
      from: 'engine',
      type: 'status',
      state: 'loading',
      model: MODEL_ID,
      file: p.file,
      loaded: agg.loaded,
      total: agg.total,
      percent: agg.total ? Math.min(100, (agg.loaded / agg.total) * 100) : null,
    });
  })
    .then((r) => {
      state = 'ready';
      lastError = null;
      broadcast({
        from: 'engine',
        type: 'status',
        state: 'ready',
        model: MODEL_ID,
        ms: r.ms,
        cached: r.cached,
        loaded: snapshotProgress().loaded,
      });
      return r;
    })
    .catch((e) => {
      state = 'error';
      lastError = String((e as Error)?.message ?? e).slice(0, 400);
      ensurePromise = null; // 允许下次重试
      broadcast({
        from: 'engine',
        type: 'status',
        state: 'error',
        model: MODEL_ID,
        message: lastError,
      });
      throw e;
    });

  return ensurePromise;
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isEngineRequest(msg)) return;
  const senderTabId = sender.tab?.id ?? null;

  // Chrome 的 onMessage 不支持 return Promise；异步回复必须 sendResponse + return true。
  (async () => {
    try {
      switch (msg.type) {
        case 'ping':
          sendResponse({
            ok: state !== 'error',
            state,
            ready: isReady(),
            model: MODEL_ID,
            error: lastError,
            device: isReady() ? deviceInfo() : null,
          });
          return;

        case 'config':
          setModelHost(msg.modelHost);
          if (msg.relayTabId != null) relayTabId = msg.relayTabId;
          sendResponse({ ok: true, modelHost: msg.modelHost ?? null, relayTabId });
          return;

        case 'ensure': {
          const r = await ensureLoaded();
          sendResponse({ ok: true, model: MODEL_ID, ...r });
          return;
        }

        case 'warmup': {
          const { target, usePrefix } = msg;
          await ensureLoaded();
          const r = await warmup({ target, usePrefix });
          sendResponse({ ok: true, ...r });
          return;
        }

        case 'translate': {
          const { reqId, seq, text, target, usePrefix } = msg;
          await ensureLoaded();
          const r = await translate({
            text,
            target,
            usePrefix,
            onDelta: (delta) =>
              broadcast({ from: 'engine', type: 'chunk', reqId, seq, delta }, senderTabId),
          });
          sendResponse({
            ok: true,
            text: r.text,
            chunks: r.chunks,
            ms: r.ms,
            stats: r.stats,
            prefix: r.prefix,
            deltaCount: r.deltaCount,
            firstDeltaMs: r.firstDeltaMs,
          });
          return;
        }

        case 'bench': {
          const { text, target, maxNewTokens, repeats, variants } = msg;
          await ensureLoaded();
          const runs = await bench({ text, target, maxNewTokens, repeats, variants });
          sendResponse({ ok: true, runs });
          return;
        }

        case 'bench-parallel': {
          const { text, target, maxNewTokens, repeats, parallel, options } = msg;
          await ensureLoaded();
          const runs = await benchParallel({
            text,
            target,
            maxNewTokens,
            repeats,
            parallel,
            options,
          });
          sendResponse({ ok: true, runs });
          return;
        }
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 400) });
    }
  })();

  return true;
});

// 握手信号：SW 靠它（或靠 ping）判断脚本已经挂上监听，不靠 sleep。
broadcast({ from: 'engine', type: 'boot', model: MODEL_ID, state });
