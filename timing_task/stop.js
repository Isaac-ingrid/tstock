/**
 * timing_task/stop.js
 * 停止正在运行的定时任务调度器
 */

const fs = require('fs');
const path = require('path');

const TIMING_ROOT = __dirname;
const PID_FILE = path.join(TIMING_ROOT, 'scheduler.pid');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

if (!fs.existsSync(PID_FILE)) {
  console.log('⚪ 未检测到运行中的调度器 PID 文件，调度器当前未运行。');
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
if (isNaN(pid)) {
  console.log('⚠️ 无效的 PID 文件内容，已自动清理。');
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}

if (!isProcessRunning(pid)) {
  console.log(`⚪ PID ${pid} 对应的进程已不存在，已清理残留 PID 文件。`);
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}

try {
  console.log(`🛑 正在终止调度器进程 (PID: ${pid})...`);
  process.kill(pid, 'SIGTERM');
  
  // 稍等确认进程退出
  setTimeout(() => {
    if (isProcessRunning(pid)) {
      console.log(`进程仍在运行，强制杀进程 (SIGKILL)...`);
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
    console.log('✅ 调度器服务已成功停止！');
    process.exit(0);
  }, 1000);
} catch (err) {
  console.error(`❌ 停止进程失败: ${err.message}`);
  process.exit(1);
}
