import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'data');
const target = path.join(root, 'public', 'data');

await mkdir(target, { recursive: true });
const copies = [
  cp(path.join(source, 'latest.js'), path.join(target, 'latest.js')),
  cp(path.join(source, 'latest.json'), path.join(target, 'latest.json')),
];
if (existsSync(path.join(source, 'trade_calendar.json'))) {
  copies.push(cp(path.join(source, 'trade_calendar.json'), path.join(target, 'trade_calendar.json')));
}
await Promise.all(copies);

console.log('[static] data/latest.js、latest.json 与 trade_calendar.json 已同步到 public/data');
