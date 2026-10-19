// decode-bench.mjs — 同一会话内交替 A/B 测 decode 吞吐。
//
//   npm run bench
//   REPEATS=6 npm run bench
//
// 为什么不用 npm run perf 做 A/B：跨 run 的 GPU 热漂移 + 系统负载能到 ±10%，
// 小于大部分单点优化的收益。这里模型只加载一次，变体在同一会话里逐轮
// 交替（A B / B A），只看同轮内的相对差异。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, '.output', 'chrome-mv3');
const PORT = 8099;
const HF_PORT = 8090;
const FIXTURE = `http://127.0.0.1:${PORT}`;
const HF_BASE = `http://127.0.0.1:${HF_PORT}/`;
const headless = process.env.HEADLESS === '1';
const REPEATS = Math.max(1, Number(process.env.REPEATS ?? 4));
const MAX_NEW = Math.max(1, Number(process.env.MAX_NEW ?? 64));

const TEXT =
  process.env.BENCH_TEXT ??
  'The end of Dennard scaling meant that shrinking a transistor no longer reduced its ' +
    'power density. Chipmakers kept the clock flat and spent the transistor budget on ' +
    'parallelism instead. Four cores became sixteen, then sixty-four, and the software ' +
    'world slowly discovered that it did not know how to use them.';

const WORDS =
  'Reply with only the translation — no explanation, no notes, no original text, no quotes.';

// PROMPT=1 切换成 system prompt 对照（看输出 token 数，不看 decode 速度）。
const VARIANTS =
  process.env.PROMPT === '1'
    ? [
        {
          name: 'base',
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
        },
        {
          name: 'terse',
          system:
            'You are a professional translator. Translate the text the user sends into ' +
            `Chinese (Simplified). ${WORDS}`,
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
        },
        {
          name: 'minimal',
          system: 'Translate into Chinese (Simplified). Output only the translation.',
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
        },
        {
          name: 'concise',
          system:
            'You are a professional translator. Translate the text the user sends into ' +
            `Chinese (Simplified). ${WORDS} Keep the translation concise.`,
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
        },
      ]
    : [
        {
          name: 'base',
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
        },
        {
          name: 'no-ngram',
          options: { repetition_penalty: 1.15 },
        },
        {
          name: 'no-penalty',
          options: {},
        },
        {
          name: 'no-text-cb',
          options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
          withTextCallback: false,
        },
      ];

// 只测 decode；prefill 单列。
const LAYER_DROP = process.env.ONLY
  ? VARIANTS.filter((v) => process.env.ONLY.split(',').includes(v.name))
  : VARIANTS;

mkdirSync(join(ROOT, 'perf'), { recursive: true });

// ── 测试构建（与 perf/flow 相同：只放宽 host_permissions）──
const prodManifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-bench-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prodManifest, host_permissions: ['<all_urls>'] }, null, 2),
);

const server = spawn(process.execPath, [join(ROOT, 'testpage', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[fixture] ' + d));

const hfServer = spawn(process.execPath, [join(ROOT, 'testpage', 'hf-serve.mjs')], {
  env: { ...process.env, PORT: String(HF_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
hfServer.stderr.on('data', (d) => process.stderr.write('[hf] ' + d));

await new Promise((r) => setTimeout(r, 600));

const load = loadavg().map((x) => Number(x.toFixed(2)));
console.log(`系统负载: ${load.join(' / ')}（1/5/15 分钟，${cpus().length} 核）`);
console.log(`输入: ${TEXT.length} 字符 · max_new_tokens=${MAX_NEW} · repeats=${REPEATS}`);

const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-bench-profile-'));
let ctx;

try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--enable-unsafe-webgpu'],
  });

  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: testExt });

  const sw =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

  await sw.evaluate((host) => chrome.storage.local.set({ modelHost: host }), HF_BASE);

  console.log('加载模型…');
  const t0 = Date.now();
  // SW 不能给自己发消息，所以这里直接建 offscreen 再等引擎握手。
  const ensured = await sw.evaluate(async (host) => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: '/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'decode bench',
      });
    }
    for (let i = 0; i < 150; i++) {
      try {
        const r = await chrome.runtime.sendMessage({ to: 'engine', type: 'ping' });
        if (r) {
          await chrome.runtime.sendMessage({ to: 'engine', type: 'config', modelHost: host });
          return r;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('offscreen 未就绪');
  }, HF_BASE);
  console.log(`引擎握手: ${JSON.stringify(ensured)} (${Date.now() - t0}ms)`);

  // 真正加载模型（首次会从伪 HF 读 3.2GB）。
  const ensuredReady = await sw.evaluate(() =>
    chrome.runtime.sendMessage({ to: 'engine', type: 'ensure' }),
  );
  console.log(`引擎就绪: ${JSON.stringify(ensuredReady)} (${Date.now() - t0}ms)`);

  const ping = await sw.evaluate(() => chrome.runtime.sendMessage({ to: 'engine', type: 'ping' }));
  console.log('设备:', JSON.stringify(ping?.device?.sessionConfig));

  if (process.env.STREAM === '1') {
    // 从 content script 发请求，验证 delta 真的能到页面（而不是只到引擎）。
    const [tab] = await sw.evaluate(async (fixture) => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => (t.url || '').startsWith(fixture)).map((t) => ({ id: t.id }));
    }, FIXTURE);
    const req = {
      to: 'engine',
      type: 'translate',
      reqId: 'bench-' + Date.now(),
      seq: 1,
      text: TEXT,
      target: 'Chinese (Simplified)',
      usePrefix: false,
    };
    await sw.evaluate(
      (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          func: () => {
            window.__gtChunkCount = 0;
            window.__gtChunkChars = 0;
            chrome.runtime.onMessage.addListener((m) => {
              if (m?.type === 'chunk') {
                window.__gtChunkCount++;
                window.__gtChunkChars += (m.delta ?? '').length;
              }
            });
          },
        }),
      tab.id,
    );
    const sent = await sw.evaluate(
      ({ tabId, request }) =>
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: (r) => chrome.runtime.sendMessage(r),
            args: [request],
          })
          .then((r) => r?.[0]?.result ?? null),
      { tabId: tab.id, request: req },
    );
    const got = await sw.evaluate(
      (tabId) =>
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: () => ({ count: window.__gtChunkCount, chars: window.__gtChunkChars }),
          })
          .then((r) => r?.[0]?.result ?? null),
      tab.id,
    );
    console.log('translate:', JSON.stringify({ ok: sent?.ok, ms: sent?.ms, stats: sent?.stats }));
    console.log(`  引擎侧 deltaCount=${sent?.deltaCount} firstDeltaMs=${sent?.firstDeltaMs}`);
    console.log(`  页面侧收到 count=${got?.count} chars=${got?.chars}`);
    console.log(`  text=${(sent?.text ?? '').slice(0, 80)}`);
  } else if (process.env.PARALLEL) {
    const parallel = Math.max(2, Number(process.env.PARALLEL));
    console.log(`并发实验: ${parallel} 路 · repeats=${REPEATS}`);
    const res = await sw.evaluate(
      (req) => chrome.runtime.sendMessage({ to: 'engine', type: 'bench-parallel', ...req }),
      {
        text: TEXT,
        target: 'Chinese (Simplified)',
        maxNewTokens: MAX_NEW,
        repeats: REPEATS,
        parallel,
        options: { repetition_penalty: 1.15, no_repeat_ngram_size: 6 },
      },
    );
    if (!res?.ok) throw new Error(`bench-parallel 失败: ${res?.error ?? JSON.stringify(res)}`);
    const seq = res.runs.filter((r) => r.mode === 'seq');
    const par = res.runs.filter((r) => r.mode === 'par');
    const med = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const seqMs = med(seq.map((r) => r.ms));
    const parMs = med(par.map((r) => r.ms));
    const seqTps = med(seq.map((r) => (r.tokens / r.ms) * 1000));
    const parTps = med(par.map((r) => (r.tokens / r.ms) * 1000));
    console.log(`  串行 ${Math.round(seqMs)}ms（${seqTps.toFixed(1)} tok/s）`);
    console.log(`  并发 ${Math.round(parMs)}ms（${parTps.toFixed(1)} tok/s）`);
    console.log(`  并发收益 ${((parTps / seqTps - 1) * 100).toFixed(1)}%`);
    console.log(`  每轮: ${res.runs.map((r) => `${r.mode}=${r.ms}ms/${r.tokens}t`).join('  ')}`);
  } else {
    console.log('跑变体…');
    const res = await sw.evaluate(
      (req) => chrome.runtime.sendMessage({ to: 'engine', type: 'bench', ...req }),
      {
        text: TEXT,
        target: 'Chinese (Simplified)',
        maxNewTokens: MAX_NEW,
        repeats: REPEATS,
        variants: LAYER_DROP,
      },
    );

    if (!res?.ok) throw new Error(`bench 失败: ${res?.error ?? JSON.stringify(res)}`);

    const byVariant = new Map();
    for (const run of res.runs) {
      if (!byVariant.has(run.variant)) byVariant.set(run.variant, []);
      byVariant.get(run.variant).push(run);
    }

    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    console.log(
      '\n变体             tokens   prefill(ms)   decode(ms)   ms/token   tok/s   输出字符',
    );
    const summary = [];
    for (const [name, runs] of byVariant) {
      const tokens = median(runs.map((r) => r.tokens));
      const prefill = median(runs.map((r) => r.firstTokenMs ?? r.ms));
      const decode = median(runs.map((r) => r.ms - (r.firstTokenMs ?? r.ms)));
      const perToken = decode / Math.max(1, tokens - 1);
      const tps = tokens > 1 ? 1000 / perToken : 0;
      const chars = median(runs.map((r) => r.chars));
      summary.push({ name, tokens, prefill, decode, perToken, tps, chars, runs });
      console.log(
        `${name.padEnd(15)} ${String(tokens).padStart(5)} ${String(Math.round(prefill)).padStart(11)} ` +
          `${String(Math.round(decode)).padStart(12)} ${perToken.toFixed(1).padStart(10)} ` +
          `${tps.toFixed(1).padStart(7)} ${String(Math.round(chars)).padStart(10)}`,
      );
    }

    if (process.env.PROMPT === '1') {
      console.log('\n输出预览:');
      for (const s of summary) {
        const sample = s.runs.find((r) => r.text)?.text ?? '';
        console.log(`  ${s.name.padEnd(10)} ${sample.slice(0, 100)}`);
      }
    }

    const base = summary.find((s) => s.name === 'base');
    if (base) {
      console.log('\n相对 base:');
      for (const s of summary) {
        if (s.name === 'base') continue;
        const d = ((s.perToken - base.perToken) / base.perToken) * 100;
        console.log(`  ${s.name.padEnd(15)} ${d >= 0 ? '+' : ''}${d.toFixed(1)}% ms/token`);
      }
    }

    console.log('\n每轮明细（ms/token）:');
    for (const s of summary) {
      console.log(
        `  ${s.name.padEnd(15)} ${s.runs
          .map((r) => (r.ms - (r.firstTokenMs ?? r.ms)) / Math.max(1, r.tokens - 1))
          .map((x) => x.toFixed(1))
          .join('  ')}`,
      );
    }

    const out = join(
      ROOT,
      'perf',
      `decode-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(
      out,
      JSON.stringify(
        { load, text: TEXT, maxNewTokens: MAX_NEW, repeats: REPEATS, summary, runs: res.runs },
        null,
        2,
      ),
    );
    console.log(`\n原始数据: ${out}`);
  }
} finally {
  await ctx?.close().catch(() => {});
  server.kill();
  hfServer.kill();
}
