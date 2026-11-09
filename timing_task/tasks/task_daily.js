/**
 * timing_task/tasks/task_daily.js
 * 
 * 每日交易日 15:10 收盘全自动选股、收益回算、明日预案、历史跟踪与契约发布流水线
 * 运行时间：15:10
 * 
 * 执行流程：
 *   1. engine.js      —— 全市场扫描，严格六步法 + VWAP复核，产出候选与收盘快照
 *   2. returns.js     —— 回算历史选股 T+1..T+20 双轨收益并更新 ledger/returns.csv
 *   3. report.js      —— 生成候选网页报告
 *   4. plan.js        —— 计算挂单价位与止损止盈预案
 *   5. plan-report.js —— 挂单预案可视化报告
 *   6. dashboard.js   —— 生成选股工作台全景看板
 *   7. [周五额外]      —— steady.js + steady-report.js（稳健型底仓评选）
 *   8. tracker.js     —— 选股全量历史建档、排查利空、收益跟踪
 *   9. publish.js     —— 统一契约发布，更新 data/ 与 public/data/
 *  10. [可选] deploy  —— 若处于本地环境且配置了云服务器部署密钥，执行 bash deploy.sh --soft
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT, ENGINE_DIR, DATA_DIR, todayStr, isWeekend, log, runScript, cleanEnv } = require('./common');

async function main() {
  const force = process.argv.includes('--force');
  const today = todayStr();
  const isFriday = new Date().getDay() === 5 || process.argv.includes('--force-steady');

  log(`════════════════════════════════════════════════════════════`);
  log(`🚀 [15:10 定时任务] 启动收盘选股、回算、预案与发布完整流水线 (${today})`);
  log(`════════════════════════════════════════════════════════════`);

  if (isWeekend() && !force) {
    log(`⚠️ 今日是周末非交易日，跳过收盘选股流水线（使用 --force 可强制运行）`);
    return;
  }

  const startPipelineTime = Date.now();

  try {
    // 1. 全市场扫描
    log(`[1/9] 全市场扫描与收盘定盘 (engine.js)...`);
    runScript('engine.js');

    // 2. 台账双轨收益回算
    log(`[2/9] 回算历史选股 T+1~T+20 收益台账 (returns.js)...`);
    runScript('returns.js');

    // 3. 今日候选报告
    log(`[3/9] 生成当日候选报告页面 (report.js)...`);
    runScript('report.js');

    // 4. 明日做T挂单计划
    log(`[4/9] 计算明日做T网格价位与多重风控闸门 (plan.js)...`);
    runScript('plan.js');

    // 5. 挂单计划可视化
    log(`[5/9] 生成明日做T挂单计划报告 (plan-report.js)...`);
    runScript('plan-report.js');

    // 6. 选股工作台看板
    log(`[6/9] 更新全景看板 (dashboard.js)...`);
    runScript('dashboard.js');

    // 7. 稳健型底仓（每周五或指定强制运行）
    if (isFriday) {
      log(`[7/9] 今日为周五，全量更新稳健底仓候选 (steady.js & steady-report.js)...`);
      runScript('steady.js');
      runScript('steady-report.js');
    } else {
      log(`[7/9] 周一至周四复用最新稳健底仓，跳过稳健重选。`);
    }

    // 8. 选股历史建档与收益跟踪
    log(`[8/9] 历史建档、利空排查与收益增厚计算 (tracker.js)...`);
    runScript('tracker.js');

    // 9. 统一契约发布
    log(`[9/9] 发布统一数据契约至 data/ 与 public/data/ (publish.js)...`);
    runScript('publish.js');

    // 10. 可选的云端同步部署（若在本地运行并需向远程服务器部署）
    const deployScript = path.join(PROJECT_ROOT, 'deploy.sh');
    const shouldDeploy = process.env.DEPLOY_AFTER_DAILY === '1' || process.argv.includes('--deploy');
    if (shouldDeploy && fs.existsSync(deployScript)) {
      log(`[部署] 检测到部署开关，执行 deploy.sh 同步至线上服务器...`);
      try {
        const dep = spawnSync('bash', ['deploy.sh', '--soft'], {
          cwd: PROJECT_ROOT,
          env: cleanEnv(),
          stdio: 'inherit',
          encoding: 'utf8'
        });
        if (dep.status === 0) {
          log(`✓ 线上站点同步成功！`);
        } else {
          log(`⚠️ 线上同步返回非0状态，请检查服务器网络或凭据。`, 'WARN');
        }
      } catch (depErr) {
        log(`⚠️ 执行 deploy.sh 异常: ${depErr.message}`, 'WARN');
      }
    }

    // 读取契约文件以生成报告
    const latestFile = path.join(DATA_DIR, 'latest.json');
    let latest = null;
    if (fs.existsSync(latestFile)) {
      try {
        latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      } catch (_) {}
    }

    const totalSec = ((Date.now() - startPipelineTime) / 1000).toFixed(1);

    log(`────────────────────────────────────────────────────────────`);
    log(`🎉 收盘任务全部完成！总耗时: ${totalSec} 秒`);
    if (latest) {
      log(`  · 交易日: ${latest.tradeDate}`);
      log(`  · 大盘环境闸门: ${latest.market?.status || latest.sources?.plan || '已更新'} ｜ 短线候选: ${(latest.candidates || []).length} 只 ｜ 稳健底仓: ${(latest.steady || []).length} 只`);
      if (latest.counts) {
        log(`  · 评级统计: 可做 ${latest.counts.canDo || 0} 只 ｜ 小做 ${latest.counts.smallDo || 0} 只 ｜ 观察 ${latest.counts.watch || 0} 只`);
      }
      if (latest.ledger) {
        log(`  · 台账累计: ${latest.ledger.days || 0} 个交易日 / ${latest.ledger.records || 0} 条收益期记录`);
      }
    }
    log(`────────────────────────────────────────────────────────────`);

    log(`✅ [15:10 收盘选股流水线] 执行完毕！`);
  } catch (err) {
    log(`❌ [15:10 收盘选股流水线] 运行失败: ${err.message}`, 'ERROR');
    process.exit(1);
  }
}

main();
