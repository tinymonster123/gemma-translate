// 把 onnxruntime-web 的 WebGPU wasm 资产复制到 public/ort/。
// 源仍然是 npm 依赖；这里只是构建输入，不是 vendor。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从包的入口文件往上走到 package 根目录（package.json 不一定在 exports 里）。 */
function packageRoot(id, req) {
  let dir = dirname(req.resolve(id));
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${id} 的 package 根目录`);
    dir = parent;
  }
  return dir;
}

// 从 transformers.js 的依赖上下文解析 onnxruntime-web，保证复制的是它实际使用的版本。
const projectRequire = createRequire(import.meta.url);
const transformersRoot = packageRoot('@huggingface/transformers', projectRequire);
const requireFromTransformers = createRequire(resolve(transformersRoot, 'package.json'));
const ortRoot = packageRoot('onnxruntime-web', requireFromTransformers);
const from = resolve(ortRoot, 'dist');
const to = resolve(root, 'public/ort');
const files = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

mkdirSync(to, { recursive: true });
for (const file of files) copyFileSync(resolve(from, file), resolve(to, file));
console.log(`[copy-ort] ${files.length} files -> public/ort/`);
