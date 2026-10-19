// 探边界：同一个 1.45GB 文件，从 chrome-extension:// 读到第 N 字节就停。
// 每个用例都新开浏览器 —— 崩一档不影响下一档。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

// 探针在 probes/ 下，项目根目录往上一级
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, 'ext');
const FILE = 'models/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx_data';
const MB = 1048576;

// 512 / 1000 / 1024 / 1100 MB —— 如果只在 >= 1024 崩，那就是 1 GiB 这个整数边界
const LIMITS = [512, 1000, 1024, 1100, 1400].map((x) => x * MB);

const prod = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-ext-limit-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prod, host_permissions: ['<all_urls>'] }, null, 2),
);

const results = [];

for (const limit of LIMITS) {
  const label = `${(limit / MB).toFixed(0)} MB`;
  process.stdout.write(`\n═══ 读到 ${label} 就停 ═══\n`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-lim-'));
  let ctx;
  let outcome = null;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 800, height: 500 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--no-proxy-server'],
    });
    const cdp = await ctx.browser().newBrowserCDPSession();
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: testExt });

    const page = await ctx.newPage();
    const url = `chrome-extension://${extId}/bigfetch.html?f=${encodeURIComponent(FILE)}&limit=${limit}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await page.evaluate(() => ({
          ok: window.__R?.ok,
          error: window.__R?.error,
          bytes: window.__R?.bytes,
          last: window.__R?.steps?.slice(-1)[0],
        }));
        if (s.ok || s.error) {
          outcome = s;
          break;
        }
      } catch {
        outcome = { crashed: true, note: '浏览器消失' };
        break;
      }
    }
    if (!outcome) outcome = { timeout: true };
  } catch (e) {
    outcome = { crashed: true, note: String(e.message).slice(0, 120) };
  } finally {
    await ctx?.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`  → ${JSON.stringify(outcome)}`);
  results.push({ limit: label, ...outcome });
}

rmSync(testExt, { recursive: true, force: true });

console.log('\n════════ 汇总 ════════');
for (const r of results) {
  const verdict = r.crashed
    ? '⛔ 崩'
    : r.ok
      ? `✅ 正常（读了 ${(r.bytes / MB).toFixed(0)} MB）`
      : r.error
        ? '❌ 报错'
        : '⏱ 超时';
  console.log(`  ${r.limit.padStart(8)}  ${verdict}`);
}
