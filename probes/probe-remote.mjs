// 只验一件事：真实远端（hf-mirror）在浏览器里通不通。
// 不下载模型 —— 只拉一个 5.5KB 的 config.json，看 status / Content-Length / CORS。

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
const HOST = process.env.MODEL_HOST ?? 'https://hf-mirror.com/';
// 只读响应头，不下载正文 —— 用来判断大文件是否带 Content-Length
const PATH =
  process.env.MODEL_PATH ?? 'onnx-community/gemma-4-E2B-it-ONNX/resolve/main/config.json';
const HEAD_ONLY = process.env.HEAD_ONLY === '1';

const prod = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-ext-remote-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prod, host_permissions: ['<all_urls>'] }, null, 2),
);

const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-remote-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--no-proxy-server'],
});

try {
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: testExt });
  const sw =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));

  const url = HOST + PATH;
  console.log('GET', url);

  const r = await sw.evaluate(
    async ({ u, headOnly }) => {
      const t0 = performance.now();
      try {
        const res = await fetch(u);
        const base = {
          ok: res.ok,
          status: res.status,
          contentLength: res.headers.get('content-length'),
          transferEncoding: res.headers.get('transfer-encoding'),
          contentType: res.headers.get('content-type'),
          type: res.type, // basic / cors / opaque
          redirects: res.redirected ? res.url.slice(0, 120) : null,
        };
        if (headOnly) {
          // 只读第一块就放手，不下载整个文件
          const reader = res.body.getReader();
          const { value } = await reader.read();
          await reader.cancel();
          return {
            ...base,
            firstChunk: value?.length ?? 0,
            ms: Math.round(performance.now() - t0),
          };
        }
        const buf = await res.arrayBuffer();
        return { ...base, bytes: buf.byteLength, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        return { error: String(e?.name ?? '') + ': ' + String(e?.message ?? e) };
      }
    },
    { u: url, headOnly: HEAD_ONLY },
  );

  console.log(JSON.stringify(r, null, 2));

  const reachable = r.ok && (r.bytes > 0 || r.firstChunk > 0);
  if (!reachable) {
    console.log('\n❌ 远端不可用 —— 产品需要换镜像或走别的下载方式');
  } else if (r.contentLength) {
    console.log('\n✅ 远端可达 + 带 Content-Length —— 库会一次分配缓冲区，线性读取');
  } else {
    console.log(
      '\n⚠️ 远端可达，但响应无 Content-Length（chunked）。小文件无所谓；大文件要小心 O(n²)',
    );
  }
} finally {
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(testExt, { recursive: true, force: true });
}
