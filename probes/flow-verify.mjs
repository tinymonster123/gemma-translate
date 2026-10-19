// flow-verify.mjs — 端到端验证 WXT + React 页面内悬浮面板。
//
//   npm run build && node probes/flow-verify.mjs
//   HEADLESS=1 node probes/flow-verify.mjs
//
// 链路：service worker 里的 __GT_TOGGLE_PANEL(tabId)（与工具栏点击同一条路径）
//   → background 注入 page.js + page-style.css
//   → React 面板挂到 open shadow root
//   → 点 CTA → offscreen 加载本地 Gemma → 逐段插入译文 → 还原。
//
// playwright 从 map-tile-lab 借（与 gemma-lab-diag/verify.mjs 同一套写法）。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT = join(ROOT, '.output', 'chrome-mv3');
const PORT = 8099;
const HF_PORT = 8090;
const FIXTURE = `http://127.0.0.1:${PORT}`;
const HF_BASE = `http://127.0.0.1:${HF_PORT}/`;
const SHOTS = join(ROOT, 'shots');
const headless = process.env.HEADLESS === '1';

const line = (s) => console.log('\n' + s);
const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

mkdirSync(SHOTS, { recursive: true });

// ── 测试构建 ──
//
// 产品 manifest 用 activeTab：只有真实用户点击图标才授权当前标签页。
// Playwright 点不到浏览器工具栏，所以硬链接一份，只把 host_permissions
// 换成 <all_urls>；其余文件逐字节相同。跑完删除。
const prodManifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const testExt = join(tmpdir(), 'gemma-ext-test-' + Date.now());
execFileSync('cp', ['-alR', EXT + '/.', testExt]);
rmSync(join(testExt, 'manifest.json'));
writeFileSync(
  join(testExt, 'manifest.json'),
  JSON.stringify({ ...prodManifest, host_permissions: ['<all_urls>'] }, null, 2),
);
console.log(
  `测试构建: ${testExt}  (manifest += host_permissions:<all_urls>，其余硬链接到 .output/)`,
);
check(
  'manifest 没有 default_popup',
  !prodManifest.action?.default_popup,
  String(prodManifest.action?.default_popup),
);

// ── fixture 服务器 ──
const server = spawn(process.execPath, [join(ROOT, 'testpage', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[fixture] ' + d));

// ── 伪 Hugging Face 服务器 ──
const hfServer = spawn(process.execPath, [join(ROOT, 'testpage', 'hf-serve.mjs')], {
  env: { ...process.env, PORT: String(HF_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
hfServer.stderr.on('data', (d) => process.stderr.write('[hf] ' + d));

await new Promise((r) => setTimeout(r, 600));

// offscreen 的请求不经过 Playwright 的 context，只能从伪 HF 服务端计数。
async function hfStats() {
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      return await (await fetch(`${HF_BASE}__stats`)).json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

const userDataDir = mkdtempSync(join(tmpdir(), 'gemma-flow-'));
let ctx;

// 面板在 open shadow root 里：Playwright 的 CSS 选择器能穿透，页面内
// document.querySelector 不能。需要页面内断言时显式走 shadowRoot。
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

  // 只能看到 page/context 的请求；offscreen 的模型请求走伪 HF 服务端计数。
  const external = [];
  ctx.on('request', (r) => {
    const u = r.url();
    if (/^(chrome-extension|devtools|blob|data):/.test(u)) return;
    if (u.startsWith(FIXTURE) || u.startsWith(HF_BASE)) return;
    external.push(u.slice(0, 140));
  });

  const sw =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const extId = sw.url().split('/')[2];
  console.log('extension id:', extId);

  // ── 1. 打开 fixture 页 ──
  line('=== 1. 打开测试页 ===');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`  [page:${m.type()}]`, m.text().slice(0, 240));
  });
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  console.log('title:', await page.title());

  await sw.evaluate((host) => chrome.storage.local.set({ modelHost: host }), HF_BASE);
  console.log(
    '  引擎模型源:',
    JSON.stringify(await sw.evaluate(() => chrome.storage.local.get('modelHost'))),
  );

  const tab = await sw.evaluate(async (fixture) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => (x.url || '').startsWith(fixture));
    return t ? { id: t.id, url: t.url } : null;
  }, FIXTURE);
  console.log('fixture tab:', JSON.stringify(tab));
  if (!tab?.id) throw new Error('找不到 fixture 标签页');

  const hasToggleSeam = await sw.evaluate(() => typeof self.__GT_TOGGLE_PANEL === 'function');
  check('background 暴露 __GT_TOGGLE_PANEL', hasToggleSeam);

  // ── 2. 走工具栏同一条路径打开面板 ──
  line('=== 2. 打开页面内悬浮面板 ===');
  await sw.evaluate((tabId) => self.__GT_TOGGLE_PANEL(tabId), tab.id);

  const panel = page.locator('.gt-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });

  const hostInfo = await page.evaluate(() => {
    const host = document.getElementById('gemma-translate-panel-host');
    const root = host?.shadowRoot;
    return {
      host: !!host,
      openShadow: !!root,
      panelInShadow: !!root?.querySelector('.gt-panel'),
      adoptedSheets: root?.adoptedStyleSheets?.length ?? 0,
    };
  });
  console.log('  shadow host:', JSON.stringify(hostInfo));
  check(
    '面板挂在 open shadow root 里',
    hostInfo.host && hostInfo.openShadow && hostInfo.panelInShadow,
  );
  check(
    '面板样式走 adoptedStyleSheets',
    hostInfo.adoptedSheets > 0,
    `${hostInfo.adoptedSheets} 张`,
  );

  const ui = {
    source: (await page.locator('.gt-source .gt-pill-main').innerText()).trim(),
    sourceSub: (await page.locator('.gt-source .gt-pill-sub').innerText()).trim(),
    target: await page.locator('.gt-target select').inputValue(),
    targetLabel: (await page.locator('.gt-target select option:checked').innerText()).trim(),
    service: (await page.locator('.gt-service .gt-value').innerText()).trim(),
    cta: (await page.locator('.gt-cta > span').first().innerText()).trim(),
  };
  console.log('  面板:', JSON.stringify(ui));
  check('源语言显示英语', ui.source.includes('英语'), ui.source);
  check('段落数已探测', /\d+ 段/.test(ui.sourceSub), ui.sourceSub);
  check('目标语言默认简体中文', ui.target === 'zh-CN', `${ui.target} / ${ui.targetLabel}`);
  check('翻译服务固定为本地 Gemma', /本地 Gemma/.test(ui.service), ui.service);
  check('CTA 初始为「翻译」', ui.cta === '翻译', ui.cta);

  await page.waitForTimeout(400); // 等 panel-in 动画结束，避免截到半透明中间帧
  await page.screenshot({
    path: join(SHOTS, 'panel-open.png'),
    clip: { x: 0, y: 0, width: 1100, height: 620 },
  });

  // ── 3. 点翻译，等浮标终态 ──
  line('=== 3. 点翻译 ===');
  await panel.locator('.gt-cta').click();
  // 面板打开时浮标被 session.setFloatHidden(true) 隐藏（display:none），
  // 但文字仍在更新；这里只等节点挂上，不等可见。
  await page.waitForSelector('.gt-float-text', { state: 'attached', timeout: 20000 });

  const t0 = Date.now();
  let outcome = 'timeout';
  const ticker = setInterval(async () => {
    const t = await page.textContent('.gt-float-text').catch(() => '?');
    const n = await page
      .evaluate(() => document.querySelectorAll('.gt-block[data-gt]').length)
      .catch(() => '?');
    const status = await page
      .locator('.gt-status span')
      .innerText()
      .catch(() => '?');
    console.log(
      `  [${((Date.now() - t0) / 1000).toFixed(0)}s] 浮标="${t}"  译文块=${n}  面板="${status}"`,
    );
  }, 5000);

  try {
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.gt-float-text')?.textContent ?? '';
        return t.includes('已翻译') || t.includes('没有可翻') || t.includes('异常');
      },
      undefined,
      { timeout: 600000 },
    );
    outcome = (await page.textContent('.gt-float-text')) ?? '';
  } catch {
    /* timeout */
  }
  clearInterval(ticker);

  console.log(
    '  浮标 title:',
    await page.getAttribute('.gt-float', 'title').catch(() => '<读不到>'),
  );
  console.log(`浮标终态: ${outcome}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  check('翻译流程跑完', outcome.includes('已翻译') || outcome.includes('没有可翻'), outcome);

  const firstStats = await hfStats();
  console.log(`  伪 HF 请求数: ${firstStats.count}  ${firstStats.hits.slice(0, 4).join('  ')}`);
  check('首轮确实从模型源加载', firstStats.count > 0, `${firstStats.count} 个文件`);

  const panelAfter = {
    cta: (await page.locator('.gt-cta > span').first().innerText()).trim(),
    status: (await page.locator('.gt-status span').innerText()).trim(),
  };
  console.log('  完成后面板:', JSON.stringify(panelAfter));
  check('完成后 CTA 变成「还原原文」', panelAfter.cta === '还原原文', panelAfter.cta);

  // ── 4. 页面上的译文 ──
  line('=== 4. 页面上的译文 ===');
  const blocks = await page.evaluate(() => {
    return [...document.querySelectorAll('.gt-block[data-gt]')].map((el) => ({
      state: el.dataset.gtState,
      theme: el.classList.contains('gt-dark') ? 'dark' : 'light',
      text: el.textContent.slice(0, 90),
      meta: el.title,
      tag: el.parentElement?.tagName,
      src: (() => {
        const prev = el.previousElementSibling;
        if (prev) return (prev.innerText || '').trim().slice(0, 70);
        const parent = el.parentElement;
        return (parent?.innerText || '').trim().slice(0, 70);
      })(),
    }));
  });
  for (const b of blocks) {
    console.log(`  [${b.state}/${b.theme}/${b.tag}] 原文: ${b.src}`);
    console.log(`                译文: ${b.text}${b.meta ? '   (' + b.meta + ')' : ''}`);
  }
  const done = blocks.filter((b) => b.state === 'done').length;
  const errored = blocks.filter((b) => b.state === 'error').length;
  check('有译文落地', done > 0, `${done} 段成功 / ${errored} 段失败 / 共 ${blocks.length}`);
  check('没有失败段', errored === 0, errored ? `${errored} 段报错` : '');

  const srcTexts = await page.evaluate(() => ({
    chineseFollowedByBlock: (() => {
      const p = [...document.querySelectorAll('p')].find((x) =>
        (x.innerText || '').includes('这一段是中文'),
      );
      if (!p) return false;
      return (
        p.nextElementSibling?.classList?.contains('gt-block') === true ||
        !!p.querySelector(':scope > .gt-block')
      );
    })(),
    insideCode: document.querySelectorAll('pre .gt-block, code .gt-block').length,
    rightAfterCode: document.querySelectorAll('pre + .gt-block, pre > .gt-block').length,
  }));
  console.log('  ' + JSON.stringify(srcTexts));
  check('中文段落被跳过', srcTexts.chineseFollowedByBlock === false);
  check('代码块被跳过', srcTexts.insideCode === 0 && srcTexts.rightAfterCode === 0);

  // ── 5. 推理上下文 ──
  line('=== 5. 推理跑在哪一层 ===');
  const contexts = await sw.evaluate(() =>
    chrome.runtime
      .getContexts({})
      .then((cs) => cs.map((c) => ({ type: c.contextType, url: c.documentUrl }))),
  );
  console.log(JSON.stringify(contexts, null, 2));
  check(
    'offscreen document 存在',
    contexts.some((c) => c.type === 'OFFSCREEN_DOCUMENT'),
  );
  check(
    '推理不在 service worker 里',
    !contexts.some((c) => c.type === 'SERVICE_WORKER' && /offscreen/i.test(c.url ?? '')),
  );

  const enginePing = await sw.evaluate(() =>
    chrome.runtime.sendMessage({ to: 'engine', type: 'ping' }),
  );
  console.log('  engine ping:', JSON.stringify(enginePing));
  check('引擎状态为 ready', enginePing?.ready === true, enginePing?.state ?? '');

  // ── 6. 面板关闭 / 浮标召回 ──
  line('=== 6. 关闭面板 → 点浮标召回 ===');
  await panel.locator('.gt-panel-close').click();
  await panel.waitFor({ state: 'hidden', timeout: 5000 });
  const floatHidden = await page.getAttribute('.gt-float', 'data-gt-hidden').catch(() => null);
  console.log('  关闭后浮标 data-gt-hidden =', JSON.stringify(floatHidden));
  check('关面板后浮标出现', floatHidden === '0', String(floatHidden));

  await page.locator('.gt-float').click();
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  const reopened = (await page.locator('.gt-cta > span').first().innerText()).trim();
  const reopenedUi = {
    source: (await page.locator('.gt-source .gt-pill-main').innerText()).trim(),
    sub: (await page.locator('.gt-source .gt-pill-sub').innerText()).trim(),
    target: await page.locator('.gt-target select').inputValue(),
  };
  console.log('  召回后面板:', JSON.stringify({ cta: reopened, ...reopenedUi }));
  check('点浮标召回面板', reopened === '还原原文', reopened);
  // 回归：重开面板时 probe 不能把已插入的译文当成页面原文。
  check('重开面板后源语言仍是英语', reopenedUi.source.includes('英语'), reopenedUi.source);
  check('重开面板后段数不归零', /20 段/.test(reopenedUi.sub), reopenedUi.sub);
  check('重开面板后目标语言不变', reopenedUi.target === 'zh-CN', reopenedUi.target);

  // ── 7. 截图（还原前，带译文） ──
  line('=== 7. 截图 ===');
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(SHOTS, 'flow-top.png'),
    clip: { x: 0, y: 0, width: 1100, height: 900 },
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, 'flow-bottom.png') });
  console.log('shots/panel-open.png  shots/flow-top.png  shots/flow-bottom.png');

  // ── 8. 还原 ──
  line('=== 8. 点「还原原文」 ===');
  await page.locator('.gt-panel .gt-cta').click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    blocks: document.querySelectorAll('.gt-block[data-gt]').length,
    float: document.querySelector('.gt-float-text')?.textContent,
  }));
  console.log(JSON.stringify(after));
  check('还原清掉译文', after.blocks === 0, `剩 ${after.blocks} 块`);

  // ── 8b. 冷启动引擎：Cache 命中 + 翻译中停止 ──
  line('=== 8b. 关闭 offscreen 冷启动：Cache 命中 / 停止 / 还原 ===');
  await sw.evaluate(() => chrome.offscreen.closeDocument()).catch(() => {});
  const closedContexts = await sw.evaluate(() =>
    chrome.runtime.getContexts({}).then((cs) => cs.map((c) => c.contextType)),
  );
  console.log('  关闭后上下文:', closedContexts.join(', '));
  check('offscreen 已关闭（准备冷启动）', !closedContexts.includes('OFFSCREEN_DOCUMENT'));

  const hfBefore = (await hfStats()).count;
  await page.locator('.gt-panel .gt-cta').click();
  await page.waitForFunction(
    () => /\d+\/20/.test(document.querySelector('.gt-float-text')?.textContent ?? ''),
    undefined,
    { timeout: 120000 },
  );
  const hfAfter = (await hfStats()).count;
  console.log(`  冷启动新增模型源请求: ${hfAfter - hfBefore}（首轮累计 ${hfBefore}）`);
  check('重建 offscreen 后 Cache API 命中', hfAfter === hfBefore, `${hfAfter - hfBefore} 个请求`);

  const stopLabel = (await page.locator('.gt-cta > span').first().innerText()).trim();
  check('翻译中 CTA 变成「停止翻译」', stopLabel.startsWith('停止翻译'), stopLabel);
  await page.locator('.gt-panel .gt-cta').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gemma-translate-panel-host')
        ?.shadowRoot?.querySelector('.gt-status span')
        ?.textContent?.includes('已停止'),
    undefined,
    { timeout: 15000 },
  );
  const stopped = {
    status: (await page.locator('.gt-status span').innerText()).trim(),
    cta: (await page.locator('.gt-cta > span').first().innerText()).trim(),
  };
  console.log('  停止后:', JSON.stringify(stopped));
  check('停止后状态为「已停止」', stopped.status === '已停止', stopped.status);
  check('停止后 CTA 变「继续翻译」', stopped.cta === '继续翻译', stopped.cta);

  await page.locator('.gt-link').click();
  await page.waitForTimeout(400);
  const afterStopRestore = await page.evaluate(
    () => document.querySelectorAll('.gt-block[data-gt]').length,
  );
  console.log('  停止后还原剩余译文块:', afterStopRestore);
  check('停止后可以直接还原', afterStopRestore === 0, `剩 ${afterStopRestore} 块`);

  // ── 9. 目标语言持久化（reload 会清掉页面译文，放最后） ──
  line('=== 9. 目标语言持久化 ===');
  await page.locator('.gt-target select').selectOption('ja');
  await page.waitForTimeout(300);
  const saved = await sw.evaluate(() => chrome.storage.local.get('targetLanguage'));
  console.log('  storage:', JSON.stringify(saved));
  check('选择后写入 storage', saved.targetLanguage === 'ja', String(saved.targetLanguage));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sw.evaluate((tabId) => self.__GT_TOGGLE_PANEL(tabId), tab.id);
  await page.locator('.gt-panel').waitFor({ state: 'visible', timeout: 20000 });
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('#gemma-translate-panel-host')
          ?.shadowRoot?.querySelector('.gt-target select')?.value === 'ja',
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
  const restoredTarget = await page.locator('.gt-target select').inputValue();
  console.log('  重载后目标语言:', restoredTarget);
  check('重载后恢复上次目标语言', restoredTarget === 'ja', restoredTarget);

  // ── 10. 联网哨兵 ──
  line('=== 10. 外部请求（应当为空）===');
  console.log(external.length, external.slice(0, 8));
  check('全程零外网请求', external.length === 0, external.length ? external[0] : '');
} catch (e) {
  console.error('\n运行出错:', e);
  checks.push({ name: '脚本未抛错', pass: false, detail: String(e?.message ?? e) });
} finally {
  if (ctx) await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(testExt, { recursive: true, force: true });
  server.kill();
  hfServer.kill();
}

line('=== 汇总 ===');
const failed = checks.filter((c) => !c.pass);
for (const c of checks)
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
