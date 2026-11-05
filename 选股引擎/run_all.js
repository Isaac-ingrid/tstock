/**
 * run_all.js —— 选股引擎收盘后全自动一键流水线
 *
 * 顺序执行：
 *   1. engine.js      —— 全市场扫描，严格六步法 + 涨停史/VWAP复核，产出候选与收盘快照
 *   2. returns.js     —— 回算历史选股 T+1..T+20 双轨收益并更新 returns.csv
 *   3. report.js      —— 生成候选网页报告
 *   4. plan.js        —— 挂单价位与止损止盈预案生成
 *   5. plan-report.js —— 挂单预案可视化报告
 *   6. dashboard.js   —— 生成选股工作台全景看板
 *   7. steady.js      —— 稳健底仓评选（周五全量跑，平时复用最新）
 *   8. tracker.js     —— 选股历史全量建档、理由与利空排查、跟踪收益与做T增厚回算
 *   9. publish.js     —— 契约发布，更新 data/latest.json 与 data/latest.js
 *
 * 用法：node run_all.js [--force-steady]
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const isFriday = new Date().getDay() === 5;
const forceSteady = process.argv.includes('--force-steady') || isFriday;

function run(file, args = '') {
  const full = path.join(ROOT, file);
  console.log(`\n============================================================`);
  console.log(`▶ 执行: node ${file} ${args}`);
  console.log(`============================================================`);
  try {
    execSync(`node "${full}" ${args}`, { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    console.error(`❌ 执行失败: ${file}`, e.message);
    process.exit(1);
  }
}

console.log('🚀 开始执行 A股选股、回算、建档与发布完整流水线...\n');
const start = Date.now();

// 1. 选股扫描
run('engine.js');

// 2. 台账收益回算
run('returns.js');

// 3. 报告
run('report.js');

// 4. 明日挂单预案
run('plan.js');
run('plan-report.js');

// 5. 看板
run('dashboard.js');

// 6. 稳健底仓（周五或显式指定时全量重新选拔）
if (forceSteady) {
  run('steady.js');
  run('steady-report.js');
}

// 7. 选股全量历史建档、理由与利空排查、收益跟踪与做T增厚
run('tracker.js');

// 8. 统一契约发布
run('publish.js');

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n🎉 全流程执行成功！总耗时: ${elapsed} 秒`);
console.log(`数据已同步至 data/latest.json 与 data/latest.js，今日作战台与做T执行台已就绪！\n`);
