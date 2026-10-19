#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
// 给 fixture 页用的最小静态服务器。
// 不需要 COOP/COEP：页面本身不跑 wasm，模型在扩展的 offscreen document 里。
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = normalize(join(ROOT, urlPath === '/' ? '/index.html' : urlPath));
  if (!target.startsWith(ROOT)) {
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
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(PORT, () => console.log(`fixture  http://127.0.0.1:${PORT}/`));
