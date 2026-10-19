// 在纯网页（无扩展）里加载 gemma-4-E2B，用来把「模型体积」和「扩展上下文」两个变量分开。
// 需要 gemma-browser-lab 的 serve.mjs 跑在 8080。

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

const URL_ = 'http://127.0.0.1:8080/gemma4-load.html';
const WATCH_MS = Number(process.env.WATCH_MS ?? 300000);
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-bare-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1000, height: 800 },
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});

try {
  ctx.on('close', () => console.log(`${T()} !! context closed`));
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'debug') console.log(`${T()} [${m.type()}]`, m.text().slice(0, 240));
  });
  page.on('pageerror', (e) => console.log(`${T()} [pageerror]`, String(e).slice(0, 300)));
  page.on('crash', () => console.log(`${T()} !! PAGE CRASHED`));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) console.log(`${T()} -> ${f.url()}`);
  });

  await page.goto(URL_, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + WATCH_MS;
  let lastPhase = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    let s;
    try {
      s = await page.evaluate(() => ({
        phase: window.__STATE?.phase,
        error: window.__STATE?.error,
        files: (window.__STATE?.files ?? []).length,
        lastLog: (window.__STATE?.log ?? []).slice(-1)[0],
      }));
    } catch (e) {
      console.log(`${T()} 读取失败（页面/浏览器可能没了）: ${String(e.message).slice(0, 120)}`);
      break;
    }
    if (s.phase !== lastPhase) {
      console.log(`${T()} phase: ${lastPhase} -> ${s.phase}`);
      lastPhase = s.phase;
    } else console.log(`${T()} phase=${s.phase} files=${s.files}  ${s.lastLog ?? ''}`);
    if (s.phase === 'ok' || s.phase === 'error') break;
  }
} catch (e) {
  console.error(`${T()} 探针抛错:`, e);
} finally {
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
