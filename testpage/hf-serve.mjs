#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
// 本地「伪 Hugging Face」服务器，只为了让开发/测试不用真下 3.1GB。
//
// transformers.js 拼出的远程 URL 形如：
//   https://hf-mirror.com/<model>/resolve/<revision>/<file>
// 这里把同样的路径映射到本机已有的模型目录：
//   <MODEL_ROOT>/<model>/<file>
//
// 关键：必须带 Content-Length 并流式发送 —— 这正是远程路径相对
// chrome-extension:// 的优势，也是这次要验证的东西。
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const MODEL_ROOT =
  process.env.MODEL_ROOT ?? resolve(process.env.HOME, 'Projects/gemma-browser-lab/models');
const PORT = Number(process.env.PORT ?? 8090);

// 请求计数：探针用它区分「真去模型源下载」和「Cache API 命中」。
// offscreen document 的请求不经过 Playwright 的 page/context，只有服务端看得到。
const hits = [];

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.jinja': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/__stats') {
    res
      .writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      })
      .end(JSON.stringify({ count: hits.length, hits }));
    return;
  }

  // /<model>/resolve/<revision>/<file>  →  <MODEL_ROOT>/<model>/<file>
  const m = pathname.match(/^\/(.+?)\/resolve\/[^/]+\/(.+)$/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('bad path');
    return;
  }

  hits.push(pathname);
  const target = normalize(join(MODEL_ROOT, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
  if (!target.startsWith(MODEL_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('dir');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + pathname);
  }
}).listen(PORT, () => {
  console.log(`伪 HF 服务器  http://127.0.0.1:${PORT}/  →  ${MODEL_ROOT}`);
});
