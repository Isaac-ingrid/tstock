#!/usr/bin/env node
/**
 * scripts/server-update.mjs
 * 服务器本机一键拉取代码、保护线上运行数据、按需装包、重启 FastAPI、静态构建发布并做双端健康自检。
 *
 * 用法：
 *   npm run update:server
 *   node scripts/server-update.mjs
 *   node scripts/server-update.mjs --data-only
 *   node scripts/server-update.mjs --force-deps
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const IS_LINUX = process.platform === 'linux';

const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  console.log([
    '用法:',
    '  npm run update:server               # 拉取最新 main + 保护线上跟踪池 + 重启 tstock-api + 构建发布前端 + 健康自检',
    '  npm run update:server -- --data-only  # 仅同步 data/ 选股契约（免重编前端）',
    '  npm run update:server -- --force-deps # 强制重新执行 npm install 与 pip install',
  ].join('\n'));
  process.exit(0);
}

const dataOnly = args.has('--data-only');
const forceDeps = args.has('--force-deps');

const step = (msg) => console.log(`\n\x1b[1;36m▶ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[1;32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[1;33m!\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\n\x1b[1;31m❌ ${msg}\x1b[0m`);
  process.exit(1);
};

function runText(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function runInherit(cmd, cmdArgs, extraEnv = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    die(`命令执行失败: ${cmd} ${cmdArgs.join(' ')}`);
  }
}

function readTradeDate(jsonFilePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    return String(raw?.tradeDate || '');
  } catch {
    return '';
  }
}

function probeHealth(port, reqPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: reqPath, timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          resolve(res.statusCode === 200 && body.includes('tstock-data'));
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  process.chdir(ROOT);

  // ---------- 1. 备份线上运行态数据并安全拉取 main ----------
  step('1/5 同步远端最新代码 (main) 并保护线上运行数据');
  const oldHead = runText('git', ['rev-parse', 'HEAD']);
  const bakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tstock-runtime-'));

  const runtimeRelFiles = [
    'data/herd_pool.json',
    'data/strategy_ledger.json',
    'data/ignition_latest.json',
    'data/latest.js',
    'data/latest.json',
  ];

  try {
    for (const rel of runtimeRelFiles) {
      const src = path.join(ROOT, rel);
      if (fs.existsSync(src)) {
        const dst = path.join(bakDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }

    // 还原受 Git 跟踪的运行期数据文件，防止盘中写入阻塞 git pull
    spawnSync('git', ['checkout', '--', 'data/', '选股引擎/ledger/'], {
      cwd: ROOT,
      stdio: 'ignore',
    });

    runInherit('git', ['fetch', 'origin', 'main']);
    runInherit('git', ['pull', '--ff-only', 'origin', 'main']);

    // 恢复线上实时跟踪池与策略账本
    for (const keepRel of ['data/herd_pool.json', 'data/strategy_ledger.json', 'data/ignition_latest.json']) {
      const bakFile = path.join(bakDir, keepRel);
      if (fs.existsSync(bakFile)) {
        fs.copyFileSync(bakFile, path.join(ROOT, keepRel));
      }
    }

    // 若服务器本地选股契约日期比仓库新，保留服务器版本
    const bakLatestJson = path.join(bakDir, 'data/latest.json');
    const curLatestJson = path.join(ROOT, 'data/latest.json');
    if (fs.existsSync(bakLatestJson) && fs.existsSync(curLatestJson)) {
      const srvDate = readTradeDate(bakLatestJson);
      const gitDate = readTradeDate(curLatestJson);
      if (srvDate && gitDate && srvDate > gitDate) {
        fs.copyFileSync(bakLatestJson, curLatestJson);
        const bakJs = path.join(bakDir, 'data/latest.js');
        if (fs.existsSync(bakJs)) {
          fs.copyFileSync(bakJs, path.join(ROOT, 'data/latest.js'));
        }
        ok(`保留了服务器较新的选股契约 (${srvDate})`);
      }
    }
  } finally {
    fs.rmSync(bakDir, { recursive: true, force: true });
  }

  const newHead = runText('git', ['rev-parse', 'HEAD']);
  if (oldHead === newHead) {
    ok(`代码已是最新提交 (${newHead.slice(0, 7)})`);
  } else {
    ok(`代码已更新: ${oldHead.slice(0, 7)} -> ${newHead.slice(0, 7)}`);
  }

  // ---------- 2. 按需更新 Node 与 Python 依赖 ----------
  step('2/5 检查前后端依赖变更');
  const changedFiles = oldHead === newHead
    ? []
    : runText('git', ['diff', '--name-only', oldHead, newHead]).split(/\r?\n/).filter(Boolean);

  const needNpm = forceDeps
    || !fs.existsSync(path.join(ROOT, 'node_modules', 'next'))
    || changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json');

  if (needNpm) {
    console.log('  → 正在同步前端依赖 npm install...');
    runInherit('npm', ['install']);
    ok('Node.js 依赖同步完成');
  } else {
    ok('package.json 未变更，跳过 npm install');
  }

  const venvPip = path.join(ROOT, 'backend', '.venv', 'bin', 'pip');
  const needPy = forceDeps || changedFiles.includes('backend/requirements.txt');
  if (IS_LINUX && !fs.existsSync(venvPip)) {
    console.log('  → 首次初始化 Python 虚拟环境 backend/.venv...');
    runInherit('python3', ['-m', 'venv', path.join(ROOT, 'backend', '.venv')]);
    runInherit(venvPip, ['install', '-r', 'backend/requirements.txt']);
    ok('Python 虚拟环境初始化完成');
  } else if (fs.existsSync(venvPip) && needPy) {
    console.log('  → 正在同步后端依赖 pip install...');
    runInherit(venvPip, ['install', '-r', 'backend/requirements.txt']);
    ok('Python 后端依赖同步完成');
  } else {
    ok('backend/requirements.txt 未变更，跳过 pip install');
  }

  // ---------- 3. 重启 FastAPI 系统服务 ----------
  step('3/5 重启 tstock-api 后端服务');
  if (IS_LINUX) {
    runInherit('systemctl', ['restart', 'tstock-api']);
    ok('已重启 tstock-api.service (127.0.0.1:8000)');
  } else {
    warn(`当前为本地开发环境 (${process.platform})，跳过 systemctl restart tstock-api`);
  }

  // ---------- 4. 强制以 /stock-api 前缀构建并同步静态站点 ----------
  step('4/5 构建静态前端并本机同步至 dist/');
  const deployArgs = ['deploy.sh', '--local'];
  if (dataOnly) deployArgs.push('--data-only');
  runInherit('bash', deployArgs, { NEXT_PUBLIC_STOCK_API_BASE: '/stock-api' });

  // ---------- 5. 双链路线上健康自检 ----------
  step('5/5 线上服务双链路健康自检');
  if (IS_LINUX) {
    let directOk = false;
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      directOk = await probeHealth(8000, '/health');
      if (directOk) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!directOk) {
      die('FastAPI 8000 端口健康检查未通过，请执行 journalctl -u tstock-api -n 40 查看日志');
    }
    ok('FastAPI 直连健康检查通过 (127.0.0.1:8000/health)');

    const proxyOk = await probeHealth(80, '/stock-api/health');
    if (proxyOk) {
      ok('Nginx /stock-api/ 反代链路检查通过 (127.0.0.1/stock-api/health)');
    } else {
      warn('127.0.0.1/stock-api/health 暂未连通，请确认已更新 Nginx default 配置并 reload');
    }
  } else {
    ok('本地预检完成（Linux 服务器上将自动校验 8000 与 Nginx 80 双链路）');
  }

  const latestCommit = runText('git', ['log', '-1', '--format=%h %s']);
  console.log(`\n\x1b[1;32m🎉 一键发版完成！当前版本: ${latestCommit}\x1b[0m`);
}

main().catch((err) => die(err?.message || String(err)));
