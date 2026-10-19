// perf-trace.mjs — 点击翻译 → 全部译文完成的分阶段性能基线。
//
//   npm run perf
//   HEADLESS=1 npm run perf
//   MODEL_HOST=https://hf-mirror.com/ npm run perf    # 真网络，会重新下 3.1GB
//
// 同一页面连跑三个场景，把「网络 / Cache API / 模型加载 / 推理」拆开：
//   1. cold  — 全新 profile，无 Cache：下载 + 加载 + 推理
//   2. cache — 关掉 offscreen、保留 Cache：Cache 读取 + 加载 + 推理
//   3. warm  — offscreen 存活：只付推理
//
// 页面侧用 MutationObserver 记录每段的挂载、首字、完成时间；
// 每段的推理耗时同时存在于 `.gt-block[title]`（offscreen 自己报的 ms）。
// 伪 HF 服务端的 requests 记录每个文件的传输窗口，用来减去/确认网络部分。

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
const MODEL_HOST = process.env.MODEL_HOST ?? HF_BASE;
const headless = process.env.HEADLESS === '1';
const OUT = join(ROOT, 'perf');
const LOAD = loadavg().map((x) => Number(x.toFixed(2)));
const CORES = cpus().length;

const line = (s) => console.log('\n' + s);
const fmt = (ms) => (ms == null ? '—' : `${Math.round(ms)}ms`);

mkdirSync(OUT, { recursive: true });

// ── 测试构建（与 flow-verify 相同：只放宽 host_permissions）──
const prodManifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-perf-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prodManifest, host_permissions: ['<all_urls>'] }, null, 2),
);

// ── fixture / 伪 HF ──
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

async function hfStats() {
  try {
    return await (await fetch(`${HF_BASE}__stats`)).json();
  } catch {
    return { count: 0, hits: [], requests: [] };
  }
}

function hfDelta(before, after) {
  const requests = (after.requests ?? []).slice((before.requests ?? []).length);
  const bytes = requests.reduce((sum, r) => sum + (r.sentBytes ?? r.bytes ?? 0), 0);
  const declared = requests.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const starts = requests.map((r) => r.start).filter(Boolean);
  const ends = requests.map((r) => r.end).filter(Boolean);
  const windowMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null;
  const completed = requests.filter((r) => r.completed).length;
  return {
    count: requests.length,
    bytes,
    declared,
    completed,
    aborted: requests.length - completed,
    windowMs,
    requests,
  };
}

// ── 统计 ──
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    sum: sorted.reduce((a, b) => a + b, 0),
  };
}

function parseBlockMeta(title) {
  const m = /(\d+)\s*块\s*·\s*(\d+)ms/.exec(title ?? '');
  return m ? { chunks: Number(m[1]), offscreenMs: Number(m[2]) } : null;
}

// ── 浏览器 ──
const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-perf-profile-'));
let ctx;
const scenarios = [];

try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--enable-unsafe-webgpu'],
  });

  const cdp = await ctx.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: testExt });
  line(`=== 扩展已装: ${JSON.stringify(loaded)} ===`);

  const sw =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  await sw.evaluate(
    (host) => chrome.storage.local.set({ modelHost: host, targetLanguage: 'zh-CN' }),
    MODEL_HOST,
  );
  console.log(`模型源: ${MODEL_HOST}`);
  console.log(
    `系统负载: ${LOAD.join(' / ')}（1/5/15 分钟，${CORES} 核）` +
      (LOAD[0] > CORES * 0.7 ? '  ⚠ 高负载，本轮计时会偏大' : ''),
  );

  const tab = await sw.evaluate(async (fixture) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => (x.url || '').startsWith(fixture));
    return t ? { id: t.id } : null;
  }, FIXTURE);
  if (!tab?.id) throw new Error('找不到 fixture 标签页');

  await sw.evaluate((tabId) => self.__GT_TOGGLE_PANEL(tabId), tab.id);
  const panel = page.locator('.gt-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(400); // 等入场动画

  // 页面侧探针：记录每段挂载 / 首字 / 完成，以及点击时刻。
  await page.evaluate(() => {
    const install = () => {
      window.__gtStopTrace?.();
      const perf = { t0: performance.now(), click: null, blocks: [] };
      window.__gtPerf = perf;

      const watch = (el) => {
        const prev = el.previousElementSibling;
        const source =
          prev && !prev.matches('.gt-block') ? prev.textContent : el.parentElement?.textContent;
        const rec = {
          add: performance.now(),
          firstText: null,
          done: null,
          state: el.dataset.gtState ?? null,
          title: null,
          chars: 0,
          srcChars: (source ?? '').trim().length,
          updates: 0,
        };
        perf.blocks.push(rec);
        const mo = new MutationObserver(() => {
          const text = (el.textContent ?? '').trim();
          if (rec.firstText == null && text) rec.firstText = performance.now();
          if (text) {
            rec.chars = text.length;
            rec.updates += 1;
          }
          const state = el.dataset.gtState ?? null;
          if (state !== rec.state) rec.state = state;
          if ((state === 'done' || state === 'error') && rec.done == null) {
            rec.done = performance.now();
            rec.title = el.title || null;
            mo.disconnect();
          }
        });
        mo.observe(el, {
          childList: true,
          characterData: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-gt-state'],
        });
      };

      const root = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.matches?.('.gt-block[data-gt]')) watch(n);
          }
        }
      });
      root.observe(document.documentElement, { childList: true, subtree: true });
      window.__gtStopTrace = () => root.disconnect();
    };

    window.__gtStartTrace = install;
    install();
  });

  async function sessionState() {
    return sw
      .evaluate(
        (tabId) =>
          chrome.scripting
            .executeScript({
              target: { tabId },
              world: 'ISOLATED',
              func: () => window.__gemmaTranslateV2?.session?.getState?.() ?? null,
            })
            .then((r) => r?.[0]?.result ?? null),
        tab.id,
      )
      .catch(() => null);
  }

  async function restore() {
    const cta = (await panel.locator('.gt-cta > span').first().innerText()).trim();
    if (cta === '还原原文' || cta === '继续翻译') {
      await panel.locator('.gt-cta').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.gt-block[data-gt]').length === 0,
        undefined,
        { timeout: 10000, polling: 20 },
      );
      await page.waitForTimeout(150);
    }
  }

  async function runScenario(
    label,
    {
      closeOffscreen = false,
      expectLoad = true,
      reopenPanel = false,
      preloadExpected = false,
    } = {},
  ) {
    if (closeOffscreen) {
      const closed = await sw
        .evaluate(async () => {
          await chrome.offscreen.closeDocument().catch(() => {});
          const contexts = await chrome.runtime.getContexts({});
          return !contexts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT');
        })
        .catch(() => false);
      await page.waitForTimeout(300);
      console.log('  offscreen 已关闭:', closed);
      if (!closed) throw new Error('关闭 offscreen 失败，cache 场景无效');
    }

    // 模拟真实入口：关掉面板再打开，触发页面里的 preload()。
    let preloadMs = null;
    if (reopenPanel) {
      // 记录面板状态文字的变化，确认「模型预热中…」是否真的渲染过。
      await page.evaluate(() => {
        window.__gtStatusLog = [];
        const record = () => {
          // 面板在 open shadow root 里，document.querySelector 看不到。
          const host = document.getElementById('gemma-translate-panel-host');
          const text =
            host?.shadowRoot?.querySelector('.gt-status span')?.textContent?.trim() ?? null;
          const last = window.__gtStatusLog[window.__gtStatusLog.length - 1];
          if (text && (!last || last.t !== text)) {
            window.__gtStatusLog.push({ at: Math.round(performance.now()), t: text });
          }
        };
        const mo = new MutationObserver(record);
        mo.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        const iv = setInterval(record, 50);
        window.__gtStopStatusLog = () => {
          mo.disconnect();
          clearInterval(iv);
        };
        record();
      });

      if (await panel.isVisible().catch(() => false)) {
        await sw.evaluate((tabId) => self.__GT_TOGGLE_PANEL(tabId), tab.id);
        await panel.waitFor({ state: 'hidden', timeout: 5000 });
      }
      const tOpen = Date.now();
      await sw.evaluate((tabId) => self.__GT_TOGGLE_PANEL(tabId), tab.id);
      await panel.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(200);
      console.log('  打开 200ms 后 session:', JSON.stringify(await sessionState()));

      if (preloadExpected) {
        try {
          // Playwright locator 能穿透 open shadow root。
          const warming = panel
            .locator('.gt-status span')
            .first()
            .filter({ hasText: '模型预热中' });
          await warming.waitFor({ state: 'attached', timeout: 15000 });
          await warming.waitFor({ state: 'detached', timeout: 180000 });
          preloadMs = Date.now() - tOpen;
          console.log(`  观察到「模型预热中…」→ 完成 ${fmt(preloadMs)}`);
        } catch {
          const status = await page
            .locator('.gt-status span')
            .first()
            .innerText()
            .catch(() => '?');
          console.log(`  ⚠ 没有观察到「模型预热中…」（当前状态: ${status}）`);
        }
      } else {
        await page.waitForTimeout(300);
      }

      const statusLog = await page.evaluate(() => {
        window.__gtStopStatusLog?.();
        return window.__gtStatusLog ?? [];
      });
      console.log('  状态变化:', JSON.stringify(statusLog.slice(-12)));
    }

    await page.evaluate(() => window.__gtStartTrace());
    const hfBefore = await hfStats();
    const tClick = Date.now();
    await page.evaluate(() => {
      window.__gtPerf.click = performance.now();
    });
    await panel.locator('.gt-cta').click();

    let tReady = null;
    if (expectLoad) {
      try {
        await page.waitForFunction(
          () => (document.querySelector('.gt-float-text')?.textContent ?? '').includes('加载模型'),
          undefined,
          { timeout: 10000, polling: 20 },
        );
        tReady = Date.now();
      } catch {
        /* 模型加载太快，没抓到中间态 */
      }
    }

    await page.waitForFunction(
      () => /^\d+\/\d+$/.test((document.querySelector('.gt-float-text')?.textContent ?? '').trim()),
      undefined,
      { timeout: 600000, polling: 20 },
    );
    const tLoaded = Date.now();

    await page.waitForFunction(
      () => (document.querySelector('.gt-float-text')?.textContent ?? '').includes('已翻译'),
      undefined,
      { timeout: 600000, polling: 20 },
    );
    const tDone = Date.now();

    const trace = await page.evaluate(() => JSON.parse(JSON.stringify(window.__gtPerf)));
    const engineStats = await page.evaluate(() =>
      [...document.querySelectorAll('.gt-block[data-gt]')]
        .map((el) => {
          try {
            return JSON.parse(el.dataset.gtStats ?? 'null');
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    );
    const engine = (() => {
      const tokens = engineStats.reduce((sum, x) => sum + (x.tokens ?? 0), 0);
      const prefillMs = engineStats.reduce((sum, x) => sum + (x.prefillMs ?? 0), 0);
      const decodeMs = engineStats.reduce((sum, x) => sum + (x.decodeMs ?? 0), 0);
      return {
        blocks: engineStats.length,
        tokens,
        prefillMs,
        decodeMs,
        decodeTps: decodeMs > 0 ? Math.round((tokens / (decodeMs / 1000)) * 10) / 10 : null,
        tokensPerBlock: stats(engineStats.map((x) => x.tokens ?? 0)),
        prefillPerBlock: stats(engineStats.map((x) => x.prefillMs ?? 0)),
        decodePerBlock: stats(engineStats.map((x) => x.decodeMs ?? 0)),
        firstTokenMs: stats(engineStats.map((x) => x.firstTokenMs).filter((x) => x != null)),
      };
    })();
    const enginePing = await sw
      .evaluate(() => chrome.runtime.sendMessage({ to: 'engine', type: 'ping' }))
      .catch(() => null);
    const hf = hfDelta(hfBefore, await hfStats());

    const done = trace.blocks.filter((b) => b.done != null);
    const pageMs = done.map((b) => b.done - b.add);
    const ttftMs = done.filter((b) => b.firstText != null).map((b) => b.firstText - b.add);
    const streamMs = done.filter((b) => b.firstText != null).map((b) => b.done - b.firstText);
    const offscreenMs = done
      .map((b) => parseBlockMeta(b.title)?.offscreenMs)
      .filter((x) => x != null);
    const overheadMs = done
      .map((b, i) => {
        const off = parseBlockMeta(b.title)?.offscreenMs;
        return off == null ? null : pageMs[i] - off;
      })
      .filter((x) => x != null);

    const firstBlockMs = done.length ? done[0].done - done[0].add : null;
    const restPageMs = done.slice(1).map((b) => b.done - b.add);
    const visibleStreaming = done.filter(
      (b) => b.firstText != null && b.done - b.firstText >= 50,
    ).length;
    const buckets = [
      ['≤20 字符', done.filter((b) => b.srcChars <= 20)],
      ['21–50 字符', done.filter((b) => b.srcChars > 20 && b.srcChars <= 50)],
      ['>50 字符', done.filter((b) => b.srcChars > 50)],
    ].map(([name, list]) => ({
      name,
      n: list.length,
      median: stats(list.map((b) => b.done - b.add))?.median ?? null,
    }));

    const result = {
      label,
      clickAt: tClick,
      engineReadyMs: tReady == null ? null : tReady - tClick,
      modelLoadMs: tReady == null ? null : tLoaded - tReady,
      preloadMs,
      inferenceWallMs: tDone - tLoaded,
      totalMs: tDone - tClick,
      blocks: {
        total: trace.blocks.length,
        done: done.length,
        failed: trace.blocks.filter((b) => b.state === 'error').length,
        pageMs: stats(pageMs),
        ttftMs: stats(ttftMs),
        streamMs: stats(streamMs),
        offscreenMs: stats(offscreenMs),
        overheadMs: stats(overheadMs),
        firstBlockMs,
        restPageMs: stats(restPageMs),
        visibleStreaming,
        buckets,
      },
      engine,
      enginePing,
      modelSource: hf,
      trace,
    };
    scenarios.push(result);

    line(`=== ${label} ===`);
    if (reopenPanel) console.log(`  面板预热（打开 → warmup 完成）         ${fmt(preloadMs)}`);
    console.log(`  引擎就绪（创建 offscreen / 转发配置）  ${fmt(result.engineReadyMs)}`);
    console.log(`  模型加载（含下载 / Cache 读取）        ${fmt(result.modelLoadMs)}`);
    console.log(`  推理阶段 wall（第一段前 → 最后一段后） ${fmt(result.inferenceWallMs)}`);
    console.log(`  点击 → 全部完成                       ${fmt(result.totalMs)}`);
    console.log(
      `  模型源请求  ${hf.count} 个 / 实际 ${(hf.bytes / 1048576).toFixed(1)} MiB` +
        ` / 声明 ${(hf.declared / 1048576).toFixed(1)} MiB` +
        ` / 完成 ${hf.completed} · 中断 ${hf.aborted} / ${fmt(hf.windowMs)}`,
    );
    console.log(
      `  每段页面耗时  ${done.length} 段 · ` +
        `median ${fmt(result.blocks.pageMs?.median)} · p95 ${fmt(result.blocks.pageMs?.p95)} · ` +
        `sum ${fmt(result.blocks.pageMs?.sum)}`,
    );
    console.log(
      `  每段 TTFT     median ${fmt(result.blocks.ttftMs?.median)} · ` +
        `p95 ${fmt(result.blocks.ttftMs?.p95)}`,
    );
    console.log(
      `  每段推理 ms   median ${fmt(result.blocks.offscreenMs?.median)} · ` +
        `p95 ${fmt(result.blocks.offscreenMs?.p95)} · sum ${fmt(result.blocks.offscreenMs?.sum)}`,
    );
    console.log(
      `  引擎拆分      tokens ${engine.tokens} 个 · prefill ${fmt(engine.prefillMs)} · ` +
        `decode ${fmt(engine.decodeMs)} · ${engine.decodeTps ?? '—'} tok/s`,
    );
    console.log(
      `  每段 tokens   median ${engine.tokensPerBlock?.median ?? '—'} · ` +
        `prefill median ${fmt(engine.prefillPerBlock?.median)} · ` +
        `decode median ${fmt(engine.decodePerBlock?.median)}`,
    );
    console.log(`  引擎设备      ${JSON.stringify(enginePing?.device ?? null)}`);
    if (!engine.blocks) console.log('  ⚠ 没有读到 data-gt-stats，引擎计时未生效');
    console.log(
      `  页面开销      median ${fmt(result.blocks.overheadMs?.median)} · ` +
        `p95 ${fmt(result.blocks.overheadMs?.p95)}`,
    );
    console.log(
      `  首段 vs 其余  首段 ${fmt(result.blocks.firstBlockMs)} · ` +
        `其余 median ${fmt(result.blocks.restPageMs?.median)}`,
    );
    console.log(
      `  可见流式      ${result.blocks.visibleStreaming}/${done.length} 段（首字到完成 ≥50ms）`,
    );
    console.log(
      `  原文长度分桶  ${result.blocks.buckets
        .map((b) => `${b.name}: ${fmt(b.median)} (n=${b.n})`)
        .join(' · ')}`,
    );
    if (result.blocks.failed) console.log(`  ⚠ 失败段: ${result.blocks.failed}`);

    return result;
  }

  // 1) 冷：新 profile，无 Cache。modelCached 为 false，不触发预加载。
  await runScenario('cold（无 Cache）', { expectLoad: true });
  console.log(
    '  modelCached:',
    JSON.stringify(await sw.evaluate(() => chrome.storage.local.get('modelCached'))),
  );
  await restore();

  // 2) 关 offscreen、保留 Cache；重开面板触发预加载。
  const cacheRun = await runScenario('cache + 预加载', {
    closeOffscreen: true,
    expectLoad: false,
    reopenPanel: true,
    preloadExpected: true,
  });
  await restore();

  // 3) offscreen 存活；重开面板时 preload 只 ping 一下，随后只付推理。
  await runScenario('warm（引擎存活）', {
    expectLoad: false,
    reopenPanel: true,
    preloadExpected: false,
  });

  line('=== 对比 ===');
  console.log('场景                 预热       引擎就绪   模型加载   推理 wall   总计');
  for (const s of scenarios) {
    console.log(
      `${s.label.padEnd(20)} ${fmt(s.preloadMs).padStart(9)} ` +
        `${fmt(s.engineReadyMs).padStart(8)} ${fmt(s.modelLoadMs).padStart(10)} ` +
        `${fmt(s.inferenceWallMs).padStart(10)} ${fmt(s.totalMs).padStart(9)}`,
    );
  }
  console.log(
    `\nCache 命中校验: cache 场景新增模型请求 ${cacheRun.modelSource.count} 个` +
      (cacheRun.modelSource.count === 0 ? ' ✅' : ' ❌ 仍走了模型源'),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(OUT, `perf-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        modelHost: MODEL_HOST,
        env: { headless, node: process.version, load: LOAD, cores: CORES },
        scenarios,
      },
      null,
      2,
    ),
  );
  console.log(`\n原始时间线: ${outFile}`);

  if (cacheRun.modelSource.count !== 0) process.exitCode = 1;
  if (scenarios.some((s) => s.blocks.failed > 0)) process.exitCode = 1;
} catch (e) {
  console.error('\n运行出错:', e);
  process.exitCode = 1;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(testExt, { recursive: true, force: true });
  server.kill();
  hfServer.kill();
}
