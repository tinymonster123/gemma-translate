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
import { Transform } from 'node:stream';

const MODEL_ROOT =
  process.env.MODEL_ROOT ?? resolve(process.env.HOME, 'Projects/gemma-browser-lab/models');
const PORT = Number(process.env.PORT ?? 8090);

// 请求计数：探针用它区分「真去模型源下载」和「Cache API 命中」。
// offscreen document 的请求不经过 Playwright 的 page/context，只有服务端看得到。
// requests 额外记录每个文件的传输窗口和字节数，供性能探针拆分下载耗时。
const hits = [];
const requests = [];

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
      .end(JSON.stringify({ count: hits.length, hits, requests }));
    return;
  }

  // /<model>/resolve/<revision>/<file>  →  <MODEL_ROOT>/<model>/<file>
  const m = pathname.match(/^\/(.+?)\/resolve\/[^/]+\/(.+)$/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('bad path');
    return;
  }

  hits.push(pathname);
  const rec = {
    path: pathname,
    method: req.method,
    range: req.headers.range ?? null,
    start: Date.now(),
    end: null,
    bytes: 0,
    sentBytes: 0,
    ok: false,
    completed: false,
  };
  requests.push(rec);
  const target = normalize(join(MODEL_ROOT, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
  if (!target.startsWith(MODEL_ROOT)) {
    rec.end = Date.now();
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('dir');
    rec.bytes = info.size;
    rec.ok = true;

    // transformers.js 会先发 `Range: bytes=0-0` 探元数据。必须回 206 + 1 字节，
    // 否则客户端会读到整个文件再中断，测出来的传输量就失真了。
    let status = 200;
    let start = 0;
    let end = info.size - 1;
    const headers = {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    const range = req.headers.range;
    const rm = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (rm) {
      start = Number(rm[1]);
      end = rm[2] === '' ? info.size - 1 : Math.min(Number(rm[2]), info.size - 1);
      status = 206;
      headers['Content-Length'] = Math.max(0, end - start + 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      rec.rangeStart = start;
      rec.rangeEnd = end;
    }

    res.writeHead(status, headers);
    res.on('finish', () => {
      rec.end = Date.now();
      rec.completed = true;
    });
    res.on('close', () => {
      if (rec.end == null) rec.end = Date.now();
    });
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        rec.sentBytes += chunk.length;
        cb(null, chunk);
      },
    });
    createReadStream(target, { start, end }).pipe(counter).pipe(res);
  } catch {
    rec.end = Date.now();
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${pathname}`);
  }
}).listen(PORT, () => {
  console.log(`伪 HF 服务器  http://127.0.0.1:${PORT}/  →  ${MODEL_ROOT}`);
});
