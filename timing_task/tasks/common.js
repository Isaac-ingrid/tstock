/**
 * timing_task/tasks/common.js
 * 定时任务公共运行环境、路径管理、环境变量清理与日志分发
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 统一路径定义（动态适配服务器与本地）
const TASKS_DIR = __dirname;
const TIMING_ROOT = path.resolve(TASKS_DIR, '..');
const PROJECT_ROOT = path.resolve(TIMING_ROOT, '..');
const ENGINE_DIR = path.join(PROJECT_ROOT, '选股引擎');
const LOGS_DIR = path.join(TIMING_ROOT, 'logs');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PUBLIC_DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data');

// 保证日志目录存在
fs.mkdirSync(LOGS_DIR, { recursive: true });

/** 获取当前日期字符串 YYYY-MM-DD */
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 获取当前时间戳 HH:mm:ss */
function timeStr(d = new Date()) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** 判断今天是否为周末（周六=6，周日=0） */
function isWeekend(d = new Date()) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/**
 * 清理系统代理环境变量
 * 避免本地或服务器上的 HTTP_PROXY / HTTPS_PROXY 拦截腾讯及东财行情数据源
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const proxyKeys = [
    'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
    'NO_PROXY', 'no_proxy'
  ];
  for (const k of proxyKeys) {
    delete env[k];
  }
  return env;
}

/**
 * 记录运行日志（同时输出到控制台并追加写入 logs/YYYY-MM-DD.log）
 */
function log(msg, level = 'INFO') {
  const now = new Date();
  const line = `[${todayStr(now)} ${timeStr(now)}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);

  try {
    const logFile = path.join(LOGS_DIR, `${todayStr(now)}.log`);
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (err) {
    console.error('写入日志文件失败:', err.message);
  }
}

/**
 * 在选股引擎目录下执行 Node.js 脚本
 * @param {string} scriptName - 脚本文件名，例如 'auction.js' 或 'publish.js'
 * @param {string[]} args - 命令行参数数组，例如 ['--force']
 * @param {object} options - 额外参数
 */
function runScript(scriptName, args = [], options = {}) {
  const scriptPath = path.isAbsolute(scriptName) ? scriptName : path.join(ENGINE_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`脚本文件不存在: ${scriptPath}`);
  }

  const startMs = Date.now();
  log(`▶ 开始执行: node ${path.basename(scriptPath)} ${args.join(' ')}`);

  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || ENGINE_DIR,
    env: cleanEnv(options.env || {}),
    stdio: options.silent ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout || 300000 // 默认最长 5 分钟
  });

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  if (proc.error) {
    log(`❌ 执行异常: ${scriptName} (耗时 ${durationSec}s): ${proc.error.message}`, 'ERROR');
    throw proc.error;
  }

  if (proc.status !== 0) {
    log(`❌ 退出码异常: ${scriptName} 退出码为 ${proc.status} (耗时 ${durationSec}s)`, 'ERROR');
    if (proc.stderr) {
      log(`错误详情: ${proc.stderr.trim()}`, 'ERROR');
    }
    const err = new Error(`Script ${scriptName} failed with exit code ${proc.status}`);
    err.status = proc.status;
    err.stdout = proc.stdout;
    err.stderr = proc.stderr;
    throw err;
  }

  log(`✓ 执行成功: ${scriptName} (耗时 ${durationSec}s)`);
  return {
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    durationSec
  };
}

module.exports = {
  PROJECT_ROOT,
  TIMING_ROOT,
  ENGINE_DIR,
  LOGS_DIR,
  DATA_DIR,
  PUBLIC_DATA_DIR,
  todayStr,
  timeStr,
  isWeekend,
  cleanEnv,
  log,
  runScript
};
