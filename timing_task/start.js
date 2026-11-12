/**
 * timing_task/start.js
 * 启动常驻定时调度器
 * 
 * 用法：
 *   node timing_task/start.js           # 前台启动（适合测试、Docker 或由 pm2 / systemd 托管）
 *   node timing_task/start.js --daemon  # 后台静默启动（自动脱离终端）
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TIMING_ROOT = __dirname;
const PID_FILE = path.join(TIMING_ROOT, 'scheduler.pid');
const LOGS_DIR = path.join(TIMING_ROOT, 'logs');
const SCHEDULER_FILE = path.join(TIMING_ROOT, 'scheduler.js');

fs.mkdirSync(LOGS_DIR, { recursive: true });

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// 检查是否已在运行
if (fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!isNaN(oldPid) && isProcessRunning(oldPid)) {
    console.log(`⚠️ 调度器已经在运行中 (PID: ${oldPid})，请勿重复启动。`);
    console.log(`如需停止，请执行: node timing_task/stop.js 或 bash timing_task/stop.sh`);
    process.exit(0);
  } else {
    // 残留无用 PID 文件，自动清理
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  }
}

const isDaemon = process.argv.includes('--daemon') || process.argv.includes('-d');

if (isDaemon) {
  const today = new Date().toISOString().slice(0, 10);
  const outLog = path.join(LOGS_DIR, `daemon_${today}.log`);
  const out = fs.openSync(outLog, 'a');
  const err = fs.openSync(outLog, 'a');

  console.log('🚀 正在后台启动 A股做T执行台定时调度服务...');

  const child = spawn(process.execPath, [SCHEDULER_FILE], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
    cwd: TIMING_ROOT
  });

  child.unref();

  console.log(`✅ 调度服务已成功在后台运行 (PID: ${child.pid})！`);
  console.log(`日志文件: ${outLog}`);
  console.log(`查看状态: node timing_task/status.js`);
  process.exit(0);
} else {
  // 前台执行
  require('./scheduler.js');
}
