/**
 * timing_task/tasks/task_auction.js
 * 
 * 每日交易日 09:26 集合竞价存档与弱参考校准任务
 * 运行窗口：09:25 ~ 09:30
 * 
 * 执行流程：
 *   1. 运行 node auction.js（腾讯 09:25 集合竞价成交数据提取、分档校准）
 *   2. 运行 node publish.js（将竞价分档并入 data/ 与 public/data/latest.json，做T台即时获取）
 */

const fs = require('fs');
const path = require('path');
const { ENGINE_DIR, todayStr, isWeekend, log, runScript } = require('./common');

async function main() {
  const force = process.argv.includes('--force');
  const today = todayStr();

  log(`════════════════════════════════════════════════════════════`);
  log(`⚡ [09:26 定时任务] 启动集合竞价存档与校准流水线 (${today})`);
  log(`════════════════════════════════════════════════════════════`);

  if (isWeekend() && !force) {
    log(`⚠️ 今日是周末非交易日，跳过集合竞价任务（使用 --force 可强制运行）`);
    return;
  }

  const now = new Date();
  const hhmm = now.getHours() * 100 + now.getMinutes();
  const auctionArgs = force ? ['--force'] : [];

  if (!force && (hhmm < 920 || hhmm > 935)) {
    log(`⚠️ 当前时间不在 09:20~09:35 竞价窗口期内。若需测试请添加 --force 参数。`, 'WARN');
    // 如果是定时器触发，不在窗口期则警告退出
    return;
  }

  try {
    // 1. 执行集合竞价抓取
    log(`步骤 1/2: 提取集合竞价数据与弱参考五档评级...`);
    runScript('auction.js', auctionArgs);

    // 2. 重新发布契约，将竞价数据推送到前端
    log(`步骤 2/2: 发布最新数据契约 (带入集合竞价实况)...`);
    runScript('publish.js');

    // 3. 读取结果并打印简报
    const timingFile = path.join(ENGINE_DIR, 'out', 'timing.json');
    if (fs.existsSync(timingFile)) {
      try {
        const timing = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
        log(`────────────────────────────────────────────────────────────`);
        log(`📊 集合竞价简报 · ${timing.date || today}`);
        if (timing.gapStat && Array.isArray(timing.gapStat)) {
          timing.gapStat.forEach(t => {
            log(`  · ${(t.label || t.tier || '').padEnd(16)}: 样本数 ${(t.n || 0).toString().padStart(2)} 只 | 平均空间 +${t.space || 0}% | +1%达成率 ${t.hit1 || 0}%`);
          });
        }
        log(`────────────────────────────────────────────────────────────`);
      } catch (_) {}
    }

    log(`✅ [09:26 集合竞价任务] 执行完毕！`);
  } catch (err) {
    log(`❌ [09:26 集合竞价任务] 运行失败: ${err.message}`, 'ERROR');
    process.exit(1);
  }
}

main();
