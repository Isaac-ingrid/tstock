/**
 * timing_task/scheduler.js
 * 
 * A股做T执行台 · 自动化常驻调度服务
 * 
 * 每日交易日定时触发：
 *   · 09:26 —— 集合竞价存档与弱参考校准 (task_auction.js)
 *   · 14:30 —— 尾盘黑马实时精选与做T潜伏 (task_tail.js)
 *   · 15:10 —— 收盘全自动选股、收益回算与契约发布 (task_daily.js)
 * 
 * 特性：
 *   1. 跨平台纯 Node.js 实现，零外部依赖，Windows / Linux 服务器即开即用
 *   2. 自动跳过周末非交易日
 *   3. 状态持久化（防重复触发）与日志每日按期滚动记录
 *   4. 支持 CLI 随时立即调试指定任务（--run auction / tail / daily）
 *   5. 状态一键查询（--status）
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TIMING_ROOT, LOGS_DIR, todayStr, timeStr, isWeekend, log, runScript } = require('./tasks/common');

const PID_FILE = path.join(TIMING_ROOT, 'scheduler.pid');
const STATE_FILE = path.join(LOGS_DIR, 'scheduler_state.json');

// 定时任务配置表 (HH:mm)
const SCHEDULE = [
  { id: 'auction', time: '09:26', name: '集合竞价存档与校准', script: 'tasks/task_auction.js' },
  { id: 'tail',    time: '14:30', name: '尾盘黑马实时精选', script: 'tasks/task_tail.js' },
  { id: 'daily',   time: '15:10', name: '收盘选股回算流水线', script: 'tasks/task_daily.js' }
];

// 读取持久化状态
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastRun: {}, lastStatus: {} };
}

// 写入持久化状态
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log(`保存调度器状态异常: ${err.message}`, 'WARN');
  }
}

// 检查 PID 是否正在运行
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// 打印状态简报
function showStatus() {
  const today = todayStr();
  const state = loadState();
  let isRunning = false;
  let runningPid = null;

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      isRunning = true;
      runningPid = pid;
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('⏰ A股做T执行台 · 定时任务调度器状态');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  · 当前系统时间: ${today} ${timeStr()} (${isWeekend() ? '周末休市' : '交易日'})`);
  console.log(`  · 调度器常驻状态: ${isRunning ? `🟢 正在运行中 (PID: ${runningPid})` : '⚪ 未启动'}`);
  console.log('\n  任务执行计划与今日执行情况：');
  
  SCHEDULE.forEach(item => {
    const executedDate = state.lastRun ? state.lastRun[item.id] : null;
    const hasRunToday = executedDate === today;
    const status = state.lastStatus ? state.lastStatus[item.id] : '—';
    const runTime = state.lastRunTime && state.lastRunTime[item.id] ? ` (${state.lastRunTime[item.id]})` : '';
    const statusIcon = hasRunToday ? (status === 'success' ? '✅' : '❌') : '⏳';
    const statusText = hasRunToday
      ? (status === 'success' ? `今日已成功执行${runTime}` : `今日执行失败${runTime}`)
      : '等待触发';
    console.log(`    [${item.time}] ${item.name.padEnd(16)} -> ${statusIcon} ${statusText}`);
  });
  console.log('════════════════════════════════════════════════════════════\n');
}

// 执行具体单个任务
function executeTask(task, force = false) {
  const today = todayStr();
  const state = loadState();

  log(`⏰ 触发调度任务: [${task.time}] ${task.name}`);
  const scriptPath = path.join(TIMING_ROOT, task.script);

  const args = force ? ['--force'] : [];
  try {
    runScript(scriptPath, args, { cwd: path.join(TIMING_ROOT, '..', '选股引擎') });
    state.lastRun = state.lastRun || {};
    state.lastStatus = state.lastStatus || {};
    state.lastRunTime = state.lastRunTime || {};
    state.lastRun[task.id] = today;
    state.lastStatus[task.id] = 'success';
    state.lastRunTime[task.id] = timeStr();
    saveState(state);
    log(`✅ [${task.id}] 任务执行完成并已记录状态。`);
    return true;
  } catch (err) {
    state.lastRun = state.lastRun || {};
    state.lastStatus = state.lastStatus || {};
    state.lastRunTime = state.lastRunTime || {};
    state.lastRun[task.id] = today;
    state.lastStatus[task.id] = 'failed';
    state.lastRunTime[task.id] = timeStr();
    saveState(state);
    log(`❌ [${task.id}] 任务运行失败: ${err.message}`, 'ERROR');
    return false;
  }
}

// 调度主循环
function startSchedulerLoop() {
  log(`🚀 定时任务调度服务已启动 (PID: ${process.pid})`);
  log(`已注册 3 个定时任务：`);
  SCHEDULE.forEach(s => log(`  · [${s.time}] ${s.name}`));

  // 写入 PID 文件
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  const cleanup = () => {
    log('🛑 收到退出信号，正在停止定时调度器...');
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
  });

  // 检查循环（每 15 秒检查一次）
  const checkTick = () => {
    const now = new Date();
    const today = todayStr(now);
    const curTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const state = loadState();

    if (isWeekend(now)) {
      // 周末不触发任何任务
      return;
    }

    SCHEDULE.forEach(task => {
      // 若当前时间与计划时间匹配，且今天尚未成功执行
      if (curTime === task.time && state.lastRun[task.id] !== today) {
        log(`命中调度时刻 ${curTime}，开始执行 ${task.name}...`);
        executeTask(task, false);
      }
    });
  };

  // 立即检查一次并开启定时器
  checkTick();
  setInterval(checkTick, 15000);
}

// 命令行参数处理
const args = process.argv.slice(2);

if (args.includes('--status') || args.includes('-s')) {
  showStatus();
  process.exit(0);
}

const runIndex = args.indexOf('--run');
if (runIndex !== -1 && args[runIndex + 1]) {
  const targetId = args[runIndex + 1].toLowerCase();
  const task = SCHEDULE.find(s => s.id === targetId || s.script.includes(targetId));
  if (!task) {
    console.error(`未知任务: ${targetId}，可选任务: ${SCHEDULE.map(s => s.id).join(', ')}`);
    process.exit(1);
  }
  log(`手动单次运行任务: ${task.name} (${task.id})...`);
  const ok = executeTask(task, true);
  process.exit(ok ? 0 : 1);
}

// 启动常驻主程序
startSchedulerLoop();
