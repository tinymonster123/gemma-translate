// 诊断探针：装上扩展、注入、然后什么都不干预，只观察。
// 目标：搞清楚「正在停止…」是谁触发的、浏览器为什么关掉、offscreen 里到底报了没报错。

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

// 探针在 probes/ 下，项目根目录往上一级
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, 'ext');
const PORT = 8097;
const FIXTURE = `http://127.0.0.1:${PORT}`;
const WATCH_MS = Number(process.env.WATCH_MS ?? 240000);

// 测试构建（同 flow-verify）
const prod = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-ext-probe-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prod, host_permissions: ['<all_urls>'] }, null, 2),
);

const server = spawn(process.execPath, [join(ROOT, 'testpage', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 500));

const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-probe4-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1000, height: 800 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--enable-unsafe-webgpu'],
});

const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const t0 = Date.now();

try {
  ctx.on('close', () => console.log(`${T()} !! context closed`));

  const cdp = await ctx.browser().newBrowserCDPSession();

  // 关键：把 offscreen 文档的 console / 异常实时捞出来。
  // 浏览器进程随时可能整体消失，事后什么都读不到；CDP 事件是立刻推给 Node 的。
  const attached = new Set();
  cdp.on('Target.targetCreated', async ({ targetInfo }) => {
    if (!targetInfo.url.includes('offscreen.html') || attached.has(targetInfo.targetId)) return;
    attached.add(targetInfo.targetId);
    console.log(
      `${T()} ++ 发现 offscreen target: ${targetInfo.type} ${targetInfo.url.slice(0, 70)}`,
    );
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Log.enable', {}, sessionId).catch(() => {});
    } catch (e) {
      console.log(`${T()} 附加失败: ${String(e.message).slice(0, 140)}`);
    }
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const text = (args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`${T()} [offscreen:${type}] ${String(text).slice(0, 400)}`);
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const d = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? '';
    console.log(`${T()} [offscreen:EXCEPTION] ${String(d).slice(0, 500)}`);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    console.log(`${T()} [offscreen:log:${entry.level}] ${String(entry.text).slice(0, 400)}`);
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  await cdp.send('Extensions.loadUnpacked', { path: testExt });

  const sw =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  console.log('ext id:', sw.url().split('/')[2]);

  // 不指定就会走默认的 hf-mirror，真的下载 3.1GB。
  // 想快速跑，先起 testpage/hf-serve.mjs，再 MODEL_HOST=http://127.0.0.1:8090/ 运行。
  if (process.env.MODEL_HOST) {
    await sw.evaluate((h) => chrome.storage.local.set({ modelHost: h }), process.env.MODEL_HOST);
    console.log('模型源:', process.env.MODEL_HOST);
  }

  // SW 侧：抓住引擎广播出来的每一条
  await sw.evaluate(() => {
    self.__ENGINE_LOG = [];
    self.__HITS = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.from === 'engine') self.__ENGINE_LOG.push({ t: Date.now(), ...m });
      else if (m?.action) self.__HITS.push(m.action);
    });
  });
  sw.on('console', (m) => console.log(`${T()} [sw:${m.type()}]`, m.text().slice(0, 300)));
  sw.on('close', () => console.log(`${T()} !! sw closed`));

  // 新出现的上下文（offscreen 文档如果被 playwright 当页面暴露，这里能看到）
  ctx.on('page', (p) => {
    console.log(`${T()} ++ new page: ${p.url()}`);
    p.on('console', (m) =>
      console.log(`${T()} [${p.url().slice(0, 45)}:${m.type()}]`, m.text().slice(0, 300)),
    );
    p.on('pageerror', (e) => console.log(`${T()} [pageerror]`, String(e).slice(0, 300)));
    p.on('crash', () => console.log(`${T()} !! page crashed: ${p.url()}`));
  });

  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`${T()} [page:${m.type()}]`, m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log(`${T()} [pageerror]`, String(e).slice(0, 300)));
  page.on('crash', () => console.log(`${T()} !! PAGE CRASHED`));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) console.log(`${T()} -> navigated: ${f.url()}`);
  });

  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // 监听页面里的 DOM 变化：浮标文字是谁改的
  await page.evaluate(() => {
    window.__FLOAT_LOG = [];
    const mo = new MutationObserver(() => {
      const el = document.querySelector('.gt-float-text');
      if (el) window.__FLOAT_LOG.push({ t: Date.now(), text: el.textContent });
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  });

  console.log(`${T()} 注入…`);
  const injected = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return { tabId: tab.id, ...(await self.__GT_INJECT(tab)) };
  });
  console.log(`${T()} 注入结果:`, JSON.stringify(injected));

  // 高频 ping：补丁装没装上、拦到几次，只有引擎自己知道，而它随时可能随浏览器一起消失。
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const p = await sw.evaluate(() =>
        chrome.runtime
          .sendMessage({ to: 'engine', type: 'ping' })
          .catch((e) => ({ err: String(e?.message ?? e) })),
      );
      console.log(`${T()} [ping] ${JSON.stringify(p)}`);
    } catch (e) {
      console.log(`${T()} [ping] 失败: ${String(e.message).slice(0, 100)}`);
      break;
    }
  }

  const deadline = Date.now() + WATCH_MS;
  let lastFloat = null;
  let printedEngine = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    // 补丁状态：Content-Length 有没有真的补上，决定了后面走哪条路
    try {
      const ping = await sw.evaluate(() =>
        chrome.runtime
          .sendMessage({ to: 'engine', type: 'ping' })
          .catch((e) => ({ err: String(e?.message) })),
      );
      console.log(`${T()} [ping] ${JSON.stringify(ping)}`);
    } catch {
      /* SW 没了 */
    }

    // 先把引擎日志捞出来打掉 —— 浏览器随时可能整体消失，捞晚了就什么都不剩
    try {
      const eng = await sw.evaluate(() =>
        (self.__ENGINE_LOG ?? []).map((m) => ({
          type: m.type,
          state: m.state,
          file: m.file,
          progress: m.progress,
          message: m.message,
          ms: m.ms,
          manifestFiles: m.manifestFiles,
          reqId: m.reqId,
          seq: m.seq,
        })),
      );
      for (; printedEngine < eng.length; printedEngine++) {
        console.log(`${T()} [engine] ${JSON.stringify(eng[printedEngine])}`);
      }
    } catch {
      /* SW 没了 */
    }

    let snap = null;
    try {
      snap = await page.evaluate(() => ({
        float: document.querySelector('.gt-float-text')?.textContent ?? null,
        blocks: document.querySelectorAll('.gt-block[data-gt]').length,
        done: document.querySelectorAll('.gt-block[data-gt-state="done"]').length,
      }));
    } catch (e) {
      console.log(`${T()} 读取失败: ${String(e.message).slice(0, 120)}`);
      break;
    }
    if (snap.float !== lastFloat) {
      console.log(`${T()} 浮标: ${lastFloat} -> ${snap.float}`);
      lastFloat = snap.float;
    }
    if (
      snap.float &&
      (snap.float.includes('已翻译') ||
        snap.float.includes('异常') ||
        snap.float.includes('没有可翻'))
    )
      break;
  }

  console.log('\n=== 浮标文字变更序列（看是谁改的）===');
  const fl = await page
    .evaluate(() => (window.__FLOAT_LOG ?? []).map((x) => x.text))
    .catch(() => ['<读不到>']);
  console.log([...new Set(fl)]);

  console.log('\n=== SW 收到的引擎广播 ===');
  const el = await sw.evaluate(() =>
    self.__ENGINE_LOG.map((m) => ({ type: m.type, state: m.state, message: m.message })),
  );
  console.log(JSON.stringify(el.slice(0, 40), null, 2));
  console.log('SW 收到的 action:', await sw.evaluate(() => self.__HITS).catch(() => []));

  await page.screenshot({ path: join(ROOT, 'shots', 'probe-gemma4.png') }).catch(() => {});
} catch (e) {
  console.error(`${T()} 探针抛错:`, e);
} finally {
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(testExt, { recursive: true, force: true });
  server.kill();
}
