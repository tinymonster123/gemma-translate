import { browser } from 'wxt/browser';
import { isReady, load, MODEL_ID, setModelHost, translate } from '../../src/engine/runtime';
import { type EngineEvent, isEngineRequest } from '../../src/shared/protocol';

let state: 'cold' | 'loading' | 'ready' | 'error' = 'cold';
let lastError: string | null = null;

function broadcast(msg: EngineEvent): void {
  try {
    void browser.runtime.sendMessage(msg).catch(() => {});
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

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isEngineRequest(msg)) return;

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
          });
          return;

        case 'config':
          setModelHost(msg.modelHost);
          sendResponse({ ok: true, modelHost: msg.modelHost ?? null });
          return;

        case 'ensure': {
          const r = await ensureLoaded();
          sendResponse({ ok: true, model: MODEL_ID, ...r });
          return;
        }

        case 'translate': {
          const { reqId, seq, text, target } = msg;
          await ensureLoaded();
          const r = await translate({
            text,
            target,
            onDelta: (delta) => broadcast({ from: 'engine', type: 'chunk', reqId, seq, delta }),
          });
          sendResponse({ ok: true, text: r.text, chunks: r.chunks, ms: r.ms });
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
