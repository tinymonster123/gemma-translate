// 一次只测一个后端，每次都新开浏览器 —— 一档崩了不影响下一档。
//   node probe-storage.mjs cache|opfs|idb

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

const backend = process.argv[2] ?? 'cache';
// 探针在 probes/ 下，项目根目录往上一级
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, 'ext');
const SRC =
  'http://127.0.0.1:8080/models/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx_data';

// 测试构建：只多一条 host_permissions，其余硬链接（不复制 3.4GB）
const prod = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), `gemma-ext-st-${backend}-` + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prod, host_permissions: ['<all_urls>'] }, null, 2),
);

const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const userDataDir = mkdtempSync(join(tmpdir(), `gemma-st-${backend}-`));

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 900, height: 600 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--no-proxy-server'],
});

let crashed = false;
try {
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: testExt });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'debug') console.log(`${T()}   ${m.text().slice(0, 220)}`);
  });
  page.on('crash', () => console.log(`${T()}   !! PAGE CRASHED`));

  const url = `chrome-extension://${extId}/storage-test.html?b=${backend}&src=${encodeURIComponent(SRC)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`${T()} 后端=${backend} 开始`);

  const deadline = Date.now() + 480_000;
  let result = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await page.evaluate(() => ({
        ok: window.__S?.ok,
        error: window.__S?.error,
        writeMs: window.__S?.writeMs,
        readMs: window.__S?.readMs,
        wrote: window.__S?.wrote,
        read: window.__S?.read,
        contentLength: window.__S?.contentLength,
        quota: window.__S?.quota,
        last: window.__S?.steps?.slice(-1)[0],
      }));
      if (s.ok || s.error) {
        result = s;
        break;
      }
    } catch (e) {
      console.log(`${T()}   !! 读取失败（浏览器没了）: ${String(e.message).slice(0, 110)}`);
      crashed = true;
      break;
    }
  }

  console.log(`\n${T()} ═══ ${backend} 结果 ═══`);
  if (result) {
    const GiB = 1024 ** 3;
    console.log(
      JSON.stringify(
        {
          ...result,
          quotaGiB: result.quota ? +(result.quota.quota / GiB).toFixed(2) : null,
          usedGiB: result.quota ? +(result.quota.usage / GiB).toFixed(2) : null,
          quota: undefined,
        },
        null,
        2,
      ),
    );
  } else if (crashed) {
    console.log('⛔ 浏览器在完成前消失');
  } else {
    console.log('⏱ 超时');
  }
} finally {
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(testExt, { recursive: true, force: true });
}
