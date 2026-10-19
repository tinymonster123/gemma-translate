// spike-verify.mjs — 驱动 Chrome 加载扩展，把两个上下文都跑一遍，打印关键数字。
// playwright 从 map-tile-lab 借（和 gemma-lab-diag/verify.mjs 同一套写法）。

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

// 探针在 probes/ 下，项目根目录往上一级
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, 'ext');
const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-ext-'));
const headless = process.env.HEADLESS === '1';

const line = (s) => console.log('\n' + s);

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless,
  // 两个都必须注意：
  // 1) Playwright 默认会加 --disable-extensions（在 chromium 的 defaultArgs 里），必须摘掉。
  // 2) Chrome 155 已经不再认 --load-extension 了（命令行走到了 Chrome 进程里，但扩展不注册）。
  //    改走 CDP 的 Extensions.loadUnpacked，它需要 --enable-unsafe-extension-debugging。
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--enable-unsafe-webgpu'],
});

// 用 CDP 把扩展装进去（--load-extension 在 Chrome 155 上已失效）
const cdp = await ctx.browser().newBrowserCDPSession();
const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT });
line(`=== CDP Extensions.loadUnpacked => ${JSON.stringify(loaded)} ===`);

// ── 拿扩展 id ──
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = sw.url().split('/')[2];
line(`=== 扩展 id: ${extId} ===`);
console.log('service worker url:', sw.url());

// 外网请求哨兵
const external = [];
ctx.on('request', (r) => {
  const u = r.url();
  if (
    !u.startsWith('chrome-extension://') &&
    !u.startsWith('devtools://') &&
    !u.startsWith('blob:') &&
    !u.startsWith('data:')
  ) {
    external.push(u.slice(0, 140));
  }
});

// ── (b) 扩展自有页面 ──
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));

await page.goto(`chrome-extension://${extId}/spike.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__SPIKE, { timeout: 20000 });
console.log('\n页面环境事实:', JSON.stringify(await page.evaluate(() => window.__SPIKE.facts)));

async function runIn(_scope, device, budgetMs) {
  const kick = await page
    .evaluate(
      ({ device }) => {
        try {
          window.__SPIKE.run(device).catch(() => {});
          return true;
        } catch (e) {
          return String(e.message);
        }
      },
      { device },
    )
    .catch((e) => String(e.message));
  if (kick !== true) return { fatal: kick };
  const ok = await page
    .waitForFunction(
      () => window.__SPIKE.state.running === false && window.__SPIKE.state.last !== null,
      { timeout: budgetMs },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) return { fatal: 'timeout waiting for result' };
  return await page.evaluate(() => window.__SPIKE.state.last);
}

function summarize(r) {
  if (!r) return { fatal: 'no result' };
  return {
    label: r.label,
    scope: r.facts?.globalScope,
    hasNavigatorGpu: r.facts?.hasNavigatorGpu,
    adapter: r.adapter,
    countersBefore: r.countersBefore,
    countersAfterLoad: r.countersAfterLoad,
    countersAfterGenerate: r.countersAfterGenerate,
    filesLoaded: r.filesLoaded,
    loadMs: r.loadMs == null ? null : Math.round(r.loadMs),
    loadError: r.loadError,
    modelInfo: r.modelInfo,
    generateMs: r.generateMs == null ? null : Math.round(r.generateMs),
    ttftMs: r.ttftMs == null ? null : Math.round(r.ttftMs),
    tokens: r.tokens,
    tokensPerSec: r.tokensPerSec == null ? null : Number(r.tokensPerSec.toFixed(1)),
    output: typeof r.output === 'string' ? r.output.slice(0, 300) : r.output,
    generateError: r.generateError,
    logs: r.logs,
    externalRequests: r.externalRequests,
  };
}

line('=== (b) 扩展页面 / device=webgpu  ===');
const pageWebgpu = await runIn('page', 'webgpu', 300000);
console.log(JSON.stringify(summarize(pageWebgpu), null, 2));

line('=== (b) 扩展页面 / device=wasm（对照）===');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__SPIKE, { timeout: 20000 });
const pageWasm = await runIn('page', 'wasm', 300000);
console.log(JSON.stringify(summarize(pageWasm), null, 2));

// ── (a) MV3 service worker ──
async function swRun(device) {
  let st = null;
  try {
    await sw.evaluate((d) => {
      self.__SW_RUN(d);
    }, device);
    const deadline = Date.now() + 300000;
    let polls = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      polls++;
      try {
        st = await sw.evaluate(() => self.__SW_STATE);
      } catch (e) {
        return { swDied: true, pollError: String(e.message).slice(0, 300), polls };
      }
      if (st?.done) return st;
      if (polls % 10 === 0) console.log(`  … SW phase=${st?.phase} (${polls} polls)`);
    }
    return st ? { ...st, timeout: true, polls } : { timeout: true, polls };
  } catch (e) {
    return { evaluateError: String(e.message).slice(0, 500) };
  }
}

line('=== (a) MV3 service worker / device=webgpu ===');
console.log(
  'SW 环境事实:',
  JSON.stringify(
    await sw.evaluate(() => ({
      scope: self.constructor?.name,
      hasNavigatorGpu: typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu,
      hasNavigator: typeof navigator !== 'undefined',
      hasDocument: typeof document !== 'undefined',
      hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      hasCaches: typeof caches !== 'undefined',
      origin: self.location.origin,
    })),
  ),
);
const swState = await swRun('webgpu');
console.log(JSON.stringify(swState?.result ? summarize(swState.result) : swState, null, 2));

// SW 里换成 wasm 再跑一次：判断失败是「webgpu EP 不行」还是「ORT 在 SW 里根本起不来」
line('=== (a) MV3 service worker / device=wasm（对照）===');
const swWasm = await sw
  .evaluate(async () => {
    try {
      const r = await self.__SW_RUN_RAW({ device: 'wasm', dtype: 'q4f16', maxNewTokens: 8 });
      return {
        loadMs: r.loadMs == null ? null : Math.round(r.loadMs),
        loadError: r.loadError,
        generateError: r.generateError,
        output: r.output,
      };
    } catch (e) {
      return { fatal: String(e.message).slice(0, 500) };
    }
  })
  .catch((e) => ({ evaluateError: String(e.message).slice(0, 400) }));
console.log(JSON.stringify(swWasm, null, 2));

// ── (c) MV3 offscreen document（Window 上下文，无界面）──
line('=== (c) MV3 offscreen document / device=webgpu ===');
const offscreen = await (async () => {
  const created = await page.evaluate(() => window.__SPIKE.offscreenCreate());
  console.log('offscreen create:', JSON.stringify(created));
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__SPIKE.offscreen = null;
    window.__SPIKE.offscreenRun('webgpu');
  });
  const ok = await page
    .waitForFunction(() => window.__SPIKE.offscreen != null, { timeout: 300000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) return { timeout: true };
  return await page.evaluate(() => ({
    facts: window.__SPIKE.offscreenFacts,
    device: window.__SPIKE.offscreenDevice,
    result: window.__SPIKE.offscreen,
  }));
})();
console.log(
  JSON.stringify(
    offscreen?.result
      ? { offscreenFacts: offscreen.facts, ...summarize(offscreen.result) }
      : offscreen,
    null,
    2,
  ),
);

line('=== 全上下文外网请求（应当为空）===');
console.log(external.length, external.slice(0, 10));

await ctx.close();
rmSync(userDataDir, { recursive: true, force: true });
