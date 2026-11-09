import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'data');
const target = path.join(root, 'public', 'data');

await mkdir(target, { recursive: true });
await Promise.all([
  cp(path.join(source, 'latest.js'), path.join(target, 'latest.js')),
  cp(path.join(source, 'latest.json'), path.join(target, 'latest.json')),
]);

console.log('[static] data/latest.js 与 data/latest.json 已复制到 public/data');
