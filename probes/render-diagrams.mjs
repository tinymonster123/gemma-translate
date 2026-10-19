// render-diagrams.mjs — 把 docs/diagrams.html 的两张图各自截成 2x PNG。
// playwright 从 ../map-tile-lab 借（本项目无依赖）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire('/Users/fenghanli/Projects/map-tile-lab/package.json');
const { chromium } = require('playwright');

const root = path.resolve(import.meta.dirname, '..');
const page_url = pathToFileURL(path.join(root, 'docs/diagrams.html')).href;

const browser = await chromium.launch({ channel: 'chrome' }); // 本机 playwright 没装自带浏览器，借系统 Chrome
const page = await browser.newPage({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
});
await page.goto(page_url);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(200);

for (const [id, file] of [
  ['architecture', 'architecture.png'],
  ['sequence', 'sequence.png'],
]) {
  await page.locator(`#${id}`).screenshot({ path: path.join(root, 'shots', file) });
  console.log('wrote shots/' + file);
}

await browser.close();
