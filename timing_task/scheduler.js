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
 *   1. 跨平台纯 Node.js 实现，零外部依赖，Windows / Linux / macOS 即开即用
 *   2. 双重交易日历守卫：内置沪深北法定节假日休市日历 + 盘中上证指数行情日期动态自学习校验，自动跳过周末与法定节假日
 *   3. 状态持久化（防重复触发）与日志每日按期滚动记录
 *   4. 支持 CLI 随时立即调试指定任务（--run auction / tail / daily）与日历核验（--check-calendar）
 *   5. 状态一键查询（--status）
 */

const fs = require('fs');
const path = require('path');
const {
  TIMING_ROOT,
  LOGS_DIR,
  todayStr,
  timeStr,
  getCNClock,
  getTradeDayStatus,
  nextTradeDay,
  probeLiveExchangeTradeDay,
  log,
  runScript,
} = require('./tasks/common');

const PID_FILE = path.join(TIMING_ROOT, 'scheduler.pid');
const STATE_FILE = path.join(LOGS_DIR, 'scheduler_state.json');

// 定时任务配置表 (北京时间 HH:mm)
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
  const now = new Date();
  const today = todayStr(now);
  const tdStatus = getTradeDayStatus(now);
  const nxtTrade = nextTradeDay(today);
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

  const dayDesc = tdStatus.isTradeDay
    ? '交易日'
    : `${tdStatus.label} · 下一交易日 ${nxtTrade}`;

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('⏰ A股做T执行台 · 定时任务调度器状态');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  · 当前北京时间: ${today} ${timeStr(now)} (${dayDesc})`);
  console.log(`  · 调度器常驻状态: ${isRunning ? `🟢 正在运行中 (PID: ${runningPid})` : '⚪ 未启动'}`);
  console.log('\n  任务执行计划与今日执行情况：');
  
  SCHEDULE.forEach(item => {
    const executedDate = state.lastRun ? state.lastRun[item.id] : null;
    const hasRunToday = executedDate === today;
    const status = state.lastStatus ? state.lastStatus[item.id] : '—';
    const runTime = state.lastRunTime && state.lastRunTime[item.id] ? ` (${state.lastRunTime[item.id]})` : '';
    const statusIcon = hasRunToday ? (status === 'success' ? '✅' : '❌') : (!tdStatus.isTradeDay ? '🛌' : '⏳');
    const statusText = hasRunToday
      ? (status === 'success' ? `今日已成功执行${runTime}` : `今日执行失败${runTime}`)
      : (!tdStatus.isTradeDay ? `休市自动跳过 (${tdStatus.label})` : '等待触发');
    console.log(`    [${item.time}] ${item.name.padEnd(16)} -> ${statusIcon} ${statusText}`);
  });
  console.log('════════════════════════════════════════════════════════════\n');
}

const MAX_AUTO_RETRIES = 3;
const BACKOFF_MINUTES = [5, 15, 30];

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
    state.retryDate = state.retryDate || {};
    state.retryCount = state.retryCount || {};
    state.nextRetryAt = state.nextRetryAt || {};
    state.lastRun[task.id] = today;
    state.lastStatus[task.id] = 'success';
    state.lastRunTime[task.id] = timeStr();
    state.retryDate[task.id] = today;
    state.retryCount[task.id] = 0;
    delete state.nextRetryAt[task.id];
    saveState(state);
    log(`✅ [${task.id}] 任务执行完成并已记录状态。`);
    return true;
  } catch (err) {
    state.lastRun = state.lastRun || {};
    state.lastStatus = state.lastStatus || {};
    state.lastRunTime = state.lastRunTime || {};
    state.retryDate = state.retryDate || {};
    state.retryCount = state.retryCount || {};
    state.nextRetryAt = state.nextRetryAt || {};
    const prevCount = state.retryDate[task.id] === today ? (state.retryCount[task.id] || 0) : 0;
    const nextCount = force ? prevCount : prevCount + 1;
    state.lastRun[task.id] = today;
    state.lastStatus[task.id] = 'failed';
    state.lastRunTime[task.id] = timeStr();
    state.retryDate[task.id] = today;
    state.retryCount[task.id] = nextCount;
    if (!force && nextCount < MAX_AUTO_RETRIES) {
      const waitMin = BACKOFF_MINUTES[Math.min(nextCount - 1, BACKOFF_MINUTES.length - 1)];
      state.nextRetryAt[task.id] = Date.now() + waitMin * 60 * 1000;
      log(`❌ [${task.id}] 任务运行失败 (第 ${nextCount}/${MAX_AUTO_RETRIES} 次): ${err.message}，将在 ${waitMin} 分钟后退避重试`, 'ERROR');
    } else if (!force) {
      state.nextRetryAt[task.id] = Number.MAX_SAFE_INTEGER;
      log(`⛔ [${task.id}] 今日自动重试已达上限 (${nextCount}/${MAX_AUTO_RETRIES})，停止循环拉起以防接口封禁；排查后可运行 node scheduler.js --run ${task.id} 手动补跑`, 'ERROR');
    } else {
      log(`❌ [${task.id}] 手动运行任务失败: ${err.message}`, 'ERROR');
    }
    saveState(state);
    return false;
  }
}

// 调度主循环
function startSchedulerLoop() {
  log(`🚀 定时任务调度服务已启动 (PID: ${process.pid})`);
  log(`已注册 3 个定时任务（支持周末与法定节假日双重休市守卫）：`);
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

  let tickBusy = false;
  let lastClosedNoticeDate = '';
  let liveOpenVerifiedDate = '';

  // 检查循环（每 15 秒检查一次）
  const checkTick = async () => {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const now = new Date();
      const ck = getCNClock(now);
      const today = ck.dateStr;
      const curTime = ck.timeStr.slice(0, 5);
      const tdStatus = getTradeDayStatus(now);

      // 第一重守卫：静态法定节假日与周末日历拦截
      if (!tdStatus.isTradeDay) {
        if (lastClosedNoticeDate !== today) {
          lastClosedNoticeDate = today;
          log(`📅 今日 (${today}) 为【${tdStatus.label}】，自动跳过全部定时任务（下一交易日: ${nextTradeDay(today)}）`);
        }
        return;
      }

      const state = loadState();
      const dueTasks = [];

      SCHEDULE.forEach(task => {
        // 允许当前时刻命中，或若已过调度时刻但今天尚未成功执行（支持开机追赶补跑，失败带指数退避与上限）
        let shouldRun = false;
        const hasRunToday = state.lastRun?.[task.id] === today && state.lastStatus?.[task.id] === 'success';
        const todayAttempts = state.retryDate?.[task.id] === today ? (state.retryCount?.[task.id] || 0) : 0;
        const nextRetryAt = state.retryDate?.[task.id] === today ? (state.nextRetryAt?.[task.id] || 0) : 0;

        if (!hasRunToday && todayAttempts < MAX_AUTO_RETRIES && Date.now() >= nextRetryAt) {
          if (task.id === 'auction') {
            // 09:26 任务：09:26 ~ 14:30 之间均可补跑
            shouldRun = curTime >= task.time && curTime <= '14:30';
          } else if (task.id === 'tail') {
            // 14:30 任务：14:30 ~ 15:00 之间均可补跑
            shouldRun = curTime >= task.time && curTime <= '15:00';
          } else if (task.id === 'daily') {
            // 15:10 任务：15:10 之后任何时刻均可补跑
            shouldRun = curTime >= task.time;
          } else {
            shouldRun = curTime === task.time;
          }
        }

        if (shouldRun) {
          dueTasks.push({ task, todayAttempts });
        }
      });

      if (dueTasks.length === 0) return;

      // 第二重守卫：09:25 后首次准备拉起任务前，探测上证指数行情日期，自动拦截跨年未录入节假日或临时休市
      if (liveOpenVerifiedDate !== today && curTime >= '09:25') {
        const probe = await probeLiveExchangeTradeDay(today);
        if (probe.verified && !probe.open) {
          lastClosedNoticeDate = today;
          log(`📅 实时行情日历拦截：${probe.reason}，已自动写入本地休市日历并跳过今日定时任务！`);
          return;
        }
        if (probe.verified && probe.open) {
          liveOpenVerifiedDate = today;
        }
      }

      for (const { task, todayAttempts } of dueTasks) {
        log(`命中调度触发窗口 (计划: ${task.time}, 当前: ${curTime}, 今日尝试: ${todayAttempts + 1}/${MAX_AUTO_RETRIES})，开始执行 ${task.name}...`);
        executeTask(task, false);
      }
    } finally {
      tickBusy = false;
    }
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

const calIdx = args.indexOf('--check-calendar');
if (calIdx !== -1) {
  const target = args[calIdx + 1] && !args[calIdx + 1].startsWith('-') ? args[calIdx + 1] : todayStr();
  const st = getTradeDayStatus(target);
  console.log(JSON.stringify({
    ...st,
    nextTradeDate: nextTradeDay(target),
  }, null, 2));
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
