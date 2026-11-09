/**
 * timing_task/tasks/task_tail.js
 * 
 * 每日交易日 14:30 尾盘黑马盘中实时精选任务
 * 运行时间：14:30
 * 
 * 执行流程：
 *   1. 运行 node tail.js —— 全市场快照扫描 → 量能异动筛选 → VWAP均线复核 → 输出 out/tail-<日期>.json
 *   2. 运行 node publish.js —— 将尾盘候选并入统一契约 data/latest.json 与 public/data/latest.json
 * 
 * 重要约束：
 *   - 严禁运行 engine.js（收盘前运行会写入半日残值快照，污染当日历史记录）
 *   - 严禁写入 ledger/（未收盘的价格会导致收益率失真）
 */

const fs = require('fs');
const path = require('path');
const { ENGINE_DIR, DATA_DIR, todayStr, isWeekend, log, runScript } = require('./common');

async function main() {
  const force = process.argv.includes('--force');
  const today = todayStr();

  log(`════════════════════════════════════════════════════════════`);
  log(`⚡ [14:30 定时任务] 启动 A股尾盘黑马盘中实时精选 (${today})`);
  log(`════════════════════════════════════════════════════════════`);

  if (isWeekend() && !force) {
    log(`⚠️ 今日是周末非交易日，跳过尾盘选股任务（使用 --force 可强制运行）`);
    return;
  }

  try {
    // 1. 执行尾盘黑马扫描
    log(`步骤 1/2: 扫描全市场下午放量脉冲与均线承接标的 (tail.js)...`);
    runScript('tail.js');

    // 2. 将尾盘黑马名单同步到数据契约
    log(`步骤 2/2: 将尾盘结果写入数据契约与前端目录 (publish.js)...`);
    runScript('publish.js');

    // 3. 读取今日产物并生成汇报简报
    const tailFile = path.join(ENGINE_DIR, 'out', `tail-${today}.json`);
    let tailData = null;
    if (fs.existsSync(tailFile)) {
      try {
        tailData = JSON.parse(fs.readFileSync(tailFile, 'utf8'));
      } catch (_) {}
    }

    log(`────────────────────────────────────────────────────────────`);
    log(`🐎 尾盘黑马战报 · ${today}`);
    if (tailData && tailData.picks && tailData.picks.length > 0) {
      log(`今日精选出 ${tailData.picks.length} 只尾盘黑马：`);
      tailData.picks.forEach((p, idx) => {
        log(`  [#${idx + 1}] ${p.name} (${p.code}) | 现价: ¥${p.price} (${p.chgPct >= 0 ? '+' : ''}${p.chgPct}%) | 距涨停: ${p.limitRoom}% | 量比: ${p.volRatio} | 换手: ${p.turnover}% | VWAP均线上方: ${p.vwapOnline}% | 得分: ${p.score} [${p.verdict}]`);
      });
      if (tailData.env) {
        log(`大盘风控: ${tailData.env.level} ｜ 建议仓位系数: ${tailData.env.posFactor}`);
      }
    } else {
      log(`今日尾盘无符合严苛量化标准的黑马，宁缺毋滥，保持空仓观望。`);
    }

    // 校验契约文件
    const latestJsonFile = path.join(DATA_DIR, 'latest.json');
    if (fs.existsSync(latestJsonFile)) {
      const latest = JSON.parse(fs.readFileSync(latestJsonFile, 'utf8'));
      log(`契约同步确认: latest.tail 包含 ${(latest.tail || []).length} 只标的，做T台已就绪！`);
    }
    log(`────────────────────────────────────────────────────────────`);

    log(`✅ [14:30 尾盘黑马任务] 执行完毕！`);
  } catch (err) {
    log(`❌ [14:30 尾盘黑马任务] 运行失败: ${err.message}`, 'ERROR');
    process.exit(1);
  }
}

main();
