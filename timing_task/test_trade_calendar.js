/**
 * timing_task/test_trade_calendar.js
 *
 * A股交易日历与开休市双重守卫自动化回归测试：
 *   1. 2025-2027 沪深北法定节假日休市拦截（元旦/春节/清明/五一/端午/中秋/国庆）
 *   2. 国务院周末调休补班日恒休市校验（周六、周日不交易）
 *   3. 节后首个交易日、节前上一交易日、节前收官日（isLastTradeDayOfWeek）推导
 *   4. 跨时区北京时间 (UTC+8) 连续竞价时段判定与前后端日历一致性核验
 *   5. 前端盘前准备面板（PreMarketPanel）节假日倒计时与连续≥3天长假前1-2日控仓高亮预警
 *   6. 动态仓位风控条（PositionRiskBar / evaluateHolidayPositionGuard）节前超上限黄牌提示降仓校验
 *   7. 动态自学习休市日持久化与回滚校验
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const backendCal = require('./tasks/trade_calendar');
const common = require('./tasks/common');

async function loadFrontendModules() {
  const svcDir = path.resolve(__dirname, '..', 'src', 'services');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tstock_fe_test_${process.pid}_`));
  try {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    for (const fname of ['calendar.js', 'utils.js', 'risk.js', 'ledger.js', 'eod.js']) {
      fs.copyFileSync(path.join(svcDir, fname), path.join(tmpDir, 'services', fname));
    }
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'site.js'),
      'export const STORAGE_KEYS = { EOD_ARCHIVE: "t-eod-archive-v1" };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'state.js'),
      'export const pool = []; export function savePool(){} export const LOG = []; export function saveLog(){}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'api.js'),
      'export const MKT = { gate: { level: "OK" } }; export function calc(s){ const p = +s.price || +s.prevClose || 10; return { inA: p * 0.99, inB: p * 0.975, outA: p * 1.02, outB: p * 1.035, tp1: p * 1.025, tp2: p * 1.045, slA: p * 0.98, fly: p * 1.04, amp: 4.5, grid: 3.6, mode: "BUY", title: "低吸正T" }; }\n',
      'utf8'
    );
    const feCal = await import(pathToFileURL(path.join(tmpDir, 'services', 'calendar.js')).href);
    const feRisk = await import(pathToFileURL(path.join(tmpDir, 'services', 'risk.js')).href);
    const feLedger = await import(pathToFileURL(path.join(tmpDir, 'services', 'ledger.js')).href);
    const feEod = await import(pathToFileURL(path.join(tmpDir, 'services', 'eod.js')).href);
    return { feCal, feRisk, feLedger, feEod };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  const { feCal, feRisk, feLedger, feEod } = await loadFrontendModules();

  // 1. 2025-2027 法定节假日休市拦截（工作日落入节假日）
  const statutoryHolidays = [
    ['2025-01-01', '元旦休市'],
    ['2025-01-28', '春节休市'],
    ['2025-02-04', '春节休市'],
    ['2025-05-01', '劳动节休市'],
    ['2025-10-08', '国庆中秋休市'],
    ['2026-01-01', '元旦休市'],
    ['2026-01-02', '元旦休市'],
    ['2026-02-16', '春节休市'],
    ['2026-02-23', '春节休市'],
    ['2026-04-06', '清明节休市'],
    ['2026-05-01', '劳动节休市'],
    ['2026-05-05', '劳动节休市'],
    ['2026-06-19', '端午节休市'],
    ['2026-09-25', '中秋节休市'],
    ['2026-10-01', '国庆节休市'],
    ['2026-10-07', '国庆节休市'],
    ['2027-01-01', '元旦休市'],
    ['2027-02-05', '春节休市'],
    ['2027-06-09', '端午节休市'],
    ['2027-10-01', '国庆节休市'],
  ];

  for (const [ds, expectedLabel] of statutoryHolidays) {
    const st = backendCal.getTradeDayStatus(ds);
    assert.strictEqual(st.isTradeDay, false, `${ds} 后端应判定为休市`);
    assert.strictEqual(st.isHoliday, true, `${ds} 后端应标记为法定节假日`);
    assert.strictEqual(st.label, expectedLabel, `${ds} 后端休市标签不匹配`);

    assert.strictEqual(feCal.isAShareTradeDay(ds), false, `${ds} 前端应判定为休市`);
    const feSt = feCal.getAShareMarketStatus(ds);
    assert.strictEqual(feSt.isHoliday, true, `${ds} 前端应标记为法定节假日`);
    assert.strictEqual(feSt.label, expectedLabel, `${ds} 前端休市标签不匹配`);
  }

  // 2. 国务院调休补班周末恒休市（A股周六/周日永不开市）
  const makeupWorkdayWeekends = [
    '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
    '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
    '2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09',
  ];
  for (const ds of makeupWorkdayWeekends) {
    const st = backendCal.getTradeDayStatus(ds);
    assert.strictEqual(st.isTradeDay, false, `调休周末 ${ds} 后端必须休市`);
    assert.strictEqual(st.isWeekend, true, `调休周末 ${ds} 应识别为周末`);
    assert.strictEqual(feCal.isAShareTradeDay(ds), false, `调休周末 ${ds} 前端必须休市`);
  }

  // 3. 节后开市日与跨长假前后交易日推导
  assert.strictEqual(backendCal.isTradeDay('2026-01-05'), true);
  assert.strictEqual(backendCal.isTradeDay('2026-02-24'), true);
  assert.strictEqual(backendCal.isTradeDay('2026-05-06'), true);
  assert.strictEqual(backendCal.isTradeDay('2026-10-08'), true);
  assert.strictEqual(backendCal.isTradeDay('2027-02-15'), true);

  assert.strictEqual(backendCal.nextTradeDay('2026-09-30'), '2026-10-08');
  assert.strictEqual(feCal.nextAShareTradeDate('2026-09-30'), '2026-10-08');
  assert.strictEqual(backendCal.prevTradeDay('2026-10-08'), '2026-09-30');
  assert.strictEqual(feCal.prevAShareTradeDate('2026-10-08'), '2026-09-30');
  assert.strictEqual(backendCal.nextTradeDay('2027-02-04'), '2027-02-15');
  assert.strictEqual(feCal.nextAShareTradeDate('2027-02-04'), '2027-02-15');

  // 4. 节前收官日（周五休市时，周四/周三自动触发周度调仓）
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-04-30'), true);
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-06-18'), true);
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-09-24'), true);
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-09-30'), true);
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-10-08'), false);
  assert.strictEqual(backendCal.isLastTradeDayOfWeek('2026-10-09'), true);

  // 5. 跨时区北京时间 (UTC+8) 连续竞价时段判定
  assert.strictEqual(feCal.isAShareTradingNow(new Date('2026-10-01T02:00:00Z')), false);
  assert.strictEqual(feCal.isAShareTradingNow(new Date('2026-10-08T02:00:00Z')), true);
  assert.strictEqual(feCal.isAShareTradingNow(new Date('2026-10-08T04:15:00Z')), false);
  assert.strictEqual(feCal.isAShareTradingNow(new Date('2026-10-08T06:45:00Z')), true);

  // 6. 盘前准备面板 PreMarketPanel 节假日倒计时与连续≥3天长假控仓预警
  // (a) 国庆7天长假前剩3个交易日 (2026-09-28) -> 普通倒计时胶囊，不高亮告警
  const r3d = feCal.getUpcomingHolidayReminder('2026-09-28');
  assert.ok(r3d, '09-28 应返回国庆倒计时');
  assert.strictEqual(r3d.holidayName, '国庆节');
  assert.strictEqual(r3d.remainingTradeDays, 3);
  assert.strictEqual(r3d.closedDays, 7);
  assert.strictEqual(r3d.isHighAlert, false);
  assert.strictEqual(r3d.level, 'countdown');

  // (b) 国庆7天长假前剩2个交易日 (2026-09-29，节前最后取现日) -> 高亮告警 isHighAlert=true
  const r2d = feCal.getUpcomingHolidayReminder('2026-09-29');
  assert.strictEqual(r2d.remainingTradeDays, 2);
  assert.strictEqual(r2d.closedDays, 7);
  assert.strictEqual(r2d.isHighAlert, true);
  assert.strictEqual(r2d.level, 'imminent_2d');
  assert.strictEqual(r2d.suggestedMaxPosPct, 30);

  // (c) 国庆7天长假前最后1个交易日 (2026-09-30，跨假T+1锁仓日) -> 最高级高亮告警
  const r1d = feCal.getUpcomingHolidayReminder('2026-09-30');
  assert.strictEqual(r1d.remainingTradeDays, 1);
  assert.strictEqual(r1d.isHighAlert, true);
  assert.strictEqual(r1d.level, 'imminent_1d');
  assert.strictEqual(r1d.reopenDate, '2026-10-08');

  // (d) 2027元旦连休3天 (2027-01-01 ~ 01-03) 前2日/1日 -> closedDays=3，触发3~5成仓位高亮预警
  const ny2 = feCal.getUpcomingHolidayReminder('2026-12-30');
  assert.strictEqual(ny2.holidayName, '元旦');
  assert.strictEqual(ny2.closedDays, 3);
  assert.strictEqual(ny2.remainingTradeDays, 2);
  assert.strictEqual(ny2.isHighAlert, true);
  assert.strictEqual(ny2.posRangeLabel, '3~5成');

  // (e) 2027春节 (02-05~02-13 法定 + 02-14 周日连休 = 连续10天休市) 前最后1个交易日 2027-02-04
  const sf1 = feCal.getUpcomingHolidayReminder('2027-02-04');
  assert.strictEqual(sf1.holidayName, '春节');
  assert.strictEqual(sf1.closedDays, 10);
  assert.strictEqual(sf1.remainingTradeDays, 1);
  assert.strictEqual(sf1.reopenDate, '2027-02-15');
  assert.strictEqual(sf1.isHighAlert, true);

  // (f) 单日节假日（2027-06-09 周三端午仅休1天 < 3天）：前1日仅提示倒计时，绝不误触发长假控仓高亮！
  const db1 = feCal.getUpcomingHolidayReminder('2027-06-08');
  assert.strictEqual(db1.holidayName, '端午节');
  assert.strictEqual(db1.closedDays, 1);
  assert.strictEqual(db1.remainingTradeDays, 1);
  assert.strictEqual(db1.isLongHoliday, false);
  assert.strictEqual(db1.isHighAlert, false);

  // (g) 节假日休市中 (2026-10-02) -> phase='in_holiday'
  const inHol = feCal.getUpcomingHolidayReminder('2026-10-02');
  assert.strictEqual(inHol.phase, 'in_holiday');
  assert.strictEqual(inHol.isHighAlert, false);
  assert.strictEqual(inHol.reopenDate, '2026-10-08');

  // (h) 距下个法定节假日超过5个交易日的普通周 (2026-11-22) -> 返回 null，零视觉噪音
  assert.strictEqual(feCal.getUpcomingHolidayReminder('2026-11-22'), null);

  // 7. 动态仓位风控条 PositionRiskBar 节前控仓黄牌（evaluateHolidayPositionGuard）全场景测试
  // (a) 国庆7天长假前2日 (2026-09-29)，绿灯上限80%，总资产20万，持仓65%(13万) > 节前上限30%(6万) -> 亮黄牌提示降仓 ¥70,000
  const hgOver7d = feRisk.evaluateHolidayPositionGuard({
    totalPosPct: 65,
    totalMkt: 130000,
    totalAssets: 200000,
    emotionCapPct: 80,
    holidayReminder: r2d,
  });
  assert.strictEqual(hgOver7d.active, true);
  assert.strictEqual(hgOver7d.isYellowCard, true);
  assert.strictEqual(hgOver7d.holidayCapPct, 30);
  assert.strictEqual(hgOver7d.effectiveCapPct, 30);
  assert.strictEqual(hgOver7d.excessPct, 35);
  assert.strictEqual(hgOver7d.excessAmt, 70000);
  assert.ok(hgOver7d.pillText.includes('节前控仓黄牌'));
  assert.ok(hgOver7d.bannerText.includes('70,000'));

  // (b) 国庆7天长假前1日 (2026-09-30)，已降仓至 25%(5万) <= 30% -> active=true 但不亮黄牌 (isYellowCard=false)
  const hgSafe7d = feRisk.evaluateHolidayPositionGuard({
    totalPosPct: 25,
    totalMkt: 50000,
    totalAssets: 200000,
    emotionCapPct: 80,
    holidayReminder: r1d,
  });
  assert.strictEqual(hgSafe7d.active, true);
  assert.strictEqual(hgSafe7d.isYellowCard, false);
  assert.strictEqual(hgSafe7d.excessAmt, 0);
  assert.strictEqual(hgSafe7d.headroomAmt, 10000);
  assert.ok(hgSafe7d.pillText.includes('节前仓位达标'));

  // (c) 2027元旦3天小长假前2日 (2026-12-30)，建议上限50%：持仓62%(6.2万/10万) -> 亮黄牌提示降仓 ¥12,000
  const hgOver3d = feRisk.evaluateHolidayPositionGuard({
    totalPosPct: 62,
    totalMkt: 62000,
    totalAssets: 100000,
    emotionCapPct: 80,
    holidayReminder: ny2,
  });
  assert.strictEqual(hgOver3d.active, true);
  assert.strictEqual(hgOver3d.isYellowCard, true);
  assert.strictEqual(hgOver3d.holidayCapPct, 50);
  assert.strictEqual(hgOver3d.effectiveCapPct, 50);
  assert.strictEqual(hgOver3d.excessPct, 12);
  assert.strictEqual(hgOver3d.excessAmt, 12000);

  // (d) 情绪红灯(20%)比3天小长假上限(50%)更严时：effectiveCapPct 从严取 20%
  const hgRedStrict = feRisk.evaluateHolidayPositionGuard({
    totalPosPct: 35,
    totalMkt: 35000,
    totalAssets: 100000,
    emotionCapPct: 20,
    holidayReminder: ny2,
  });
  assert.strictEqual(hgRedStrict.effectiveCapPct, 20);
  assert.strictEqual(hgRedStrict.isYellowCard, true);
  assert.strictEqual(hgRedStrict.excessAmt, 15000);

  // (e) 直接传 now 日期字符串（不手动传 holidayReminder）：2027-02-04 春节10天连休前1日自动生效
  const hgAutoNow = feRisk.evaluateHolidayPositionGuard({
    totalPosPct: 45,
    totalMkt: 90000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: '2027-02-04',
  });
  assert.strictEqual(hgAutoNow.active, true);
  assert.strictEqual(hgAutoNow.isYellowCard, true);
  assert.strictEqual(hgAutoNow.holidayName, '春节');
  assert.strictEqual(hgAutoNow.closedDays, 10);
  assert.strictEqual(hgAutoNow.effectiveCapPct, 30);
  assert.strictEqual(hgAutoNow.excessAmt, 30000);

  // (f) 距国庆剩3个交易日 (r3d) / 端午单日假前1日 (db1) / 休市中 (inHol) / 普通周 (null) -> 均不激活节前黄牌
  assert.strictEqual(
    feRisk.evaluateHolidayPositionGuard({ totalPosPct: 75, emotionCapPct: 80, holidayReminder: r3d }).isYellowCard,
    false
  );
  assert.strictEqual(
    feRisk.evaluateHolidayPositionGuard({ totalPosPct: 75, emotionCapPct: 80, holidayReminder: db1 }).isYellowCard,
    false
  );
  assert.strictEqual(
    feRisk.evaluateHolidayPositionGuard({ totalPosPct: 75, emotionCapPct: 80, holidayReminder: inHol }).isYellowCard,
    false
  );
  assert.strictEqual(
    feRisk.evaluateHolidayPositionGuard({ totalPosPct: 75, emotionCapPct: 80, holidayReminder: null }).active,
    false
  );

  // 8. 个股卡片与尾盘潜伏新开仓节前黄牌二次提醒（evaluatePreTradeHolidayGuard）测试
  // (a) 国庆7天长假前2日 (r2d，上限30%)：总资产20万，已有持仓4万(20%)，拟买3万 -> 买后35% > 30% -> 触发二次确认，最多安全可买 ¥20,000（@¥25 最多 800 股）
  const ptOver7d = feRisk.evaluatePreTradeHolidayGuard({
    currentMkt: 40000,
    buyAmt: 30000,
    unitPrice: 25,
    totalAssets: 200000,
    emotionCapPct: 80,
    holidayReminder: r2d,
    stockName: '上海沿浦',
  });
  assert.strictEqual(ptOver7d.active, true);
  assert.strictEqual(ptOver7d.willExceedCap, true);
  assert.strictEqual(ptOver7d.beforePosPct, 20);
  assert.strictEqual(ptOver7d.afterPosPct, 35);
  assert.strictEqual(ptOver7d.effectiveCapPct, 30);
  assert.strictEqual(ptOver7d.overPct, 5);
  assert.strictEqual(ptOver7d.overAmt, 10000);
  assert.strictEqual(ptOver7d.maxSafeBuyAmt, 20000);
  assert.strictEqual(ptOver7d.maxSafeShares, 800);
  assert.ok(ptOver7d.confirmPromptText.includes('节前控仓黄牌二次提醒'));
  assert.ok(ptOver7d.confirmPromptText.includes('【上海沿浦】'));

  // (b) 国庆7天长假前1日 (r1d) 尾盘潜伏买入：买后超30%上限，二次确认文案包含跨假 T+1 无法次日早盘平仓提示
  const ptTail1d = feRisk.evaluatePreTradeHolidayGuard({
    currentMkt: 50000,
    buyAmt: 20000,
    unitPrice: 20,
    totalAssets: 200000,
    emotionCapPct: 80,
    holidayReminder: r1d,
    isTailBuy: true,
    stockName: '尾盘先锋',
  });
  assert.strictEqual(ptTail1d.willExceedCap, true);
  assert.strictEqual(ptTail1d.afterPosPct, 35);
  assert.strictEqual(ptTail1d.maxSafeShares, 500);
  assert.ok(ptTail1d.confirmPromptText.includes('无法「次日早盘平仓」'));
  assert.ok(ptTail1d.confirmPromptText.includes('10-08 开市'));

  // (c) 2027元旦3天假前2日 (ny2，上限50%)：总资产10万，已有2万(20%)，拟买2万 -> 买后40% <= 50% -> 不弹二次确认
  const ptSafe3d = feRisk.evaluatePreTradeHolidayGuard({
    currentMkt: 20000,
    buyAmt: 20000,
    unitPrice: 10,
    totalAssets: 100000,
    emotionCapPct: 80,
    holidayReminder: ny2,
  });
  assert.strictEqual(ptSafe3d.active, true);
  assert.strictEqual(ptSafe3d.willExceedCap, false);
  assert.strictEqual(ptSafe3d.confirmPromptText, '');

  // (d) 单日短假（端午休1天 db1）或距长假剩3个交易日（r3d）：即使买后仓位70%，也不触发节前长假二次提醒
  assert.strictEqual(
    feRisk.evaluatePreTradeHolidayGuard({
      currentMkt: 50000,
      buyAmt: 20000,
      unitPrice: 10,
      totalAssets: 100000,
      emotionCapPct: 80,
      holidayReminder: db1,
    }).willExceedCap,
    false
  );
  assert.strictEqual(
    feRisk.evaluatePreTradeHolidayGuard({
      currentMkt: 50000,
      buyAmt: 20000,
      unitPrice: 10,
      totalAssets: 100000,
      emotionCapPct: 80,
      holidayReminder: r3d,
    }).willExceedCap,
    false
  );

  // 9. common.js 兼容导出与动态自学习回滚测试
  assert.strictEqual(typeof common.isTradeDay, 'function');
  const calFile = backendCal.CALENDAR_FILE;
  const pubCalFile = path.resolve(__dirname, '..', 'public', 'data', 'trade_calendar.json');
  const origRaw = fs.existsSync(calFile) ? fs.readFileSync(calFile, 'utf8') : null;
  const origPub = fs.existsSync(pubCalFile) ? fs.readFileSync(pubCalFile, 'utf8') : null;
  try {
    backendCal.recordLearnedClosedDate('2028-01-03', '元旦休市');
    const learnedSt = backendCal.getTradeDayStatus('2028-01-03');
    assert.strictEqual(learnedSt.isTradeDay, false);
    assert.strictEqual(learnedSt.label, '元旦休市');
  } finally {
    if (origRaw !== null) fs.writeFileSync(calFile, origRaw, 'utf8');
    if (origPub !== null) fs.writeFileSync(pubCalFile, origPub, 'utf8');
  }

  // 10. ledger.js 执行纪律审计（auditTradeExecution + computeDisciplineScorecard）节前超上限建仓闭环测试
  // (a) 国庆7天长假前2日 (2026-09-29，上限30%)：总资产20万，买前市值4万(20%)，新开仓买入 1200股 * ¥25 = 3万 -> 买后35% > 30%
  const auditOver2d = feLedger.auditTradeExecution({
    stock: { code: '605128', name: '上海沿浦', price: 25.2, prevClose: 25.0, tier: 'long' },
    code: '605128',
    dir: '买入建仓',
    buy: 25.0,
    sell: 0,
    qty: 1200,
    net: 0,
    plan: '自动判定',
    currentMktVal: 40000,
    allowedCapPct: 80,
    totalAssets: 200000,
    date: '2026-09-29',
  });
  assert.ok(auditOver2d.mistakeTags.includes('pre_holiday_overcap'), '买后35%>30%应自动打标 pre_holiday_overcap');
  assert.strictEqual(auditOver2d.plan, '计划外', '自动判定应转为计划外');
  assert.strictEqual(auditOver2d.basis, '节前重仓博弈');
  assert.strictEqual(auditOver2d.postBuyPosPct, 35);
  assert.strictEqual(auditOver2d.holidayCapPct, 30);
  assert.strictEqual(auditOver2d.disciplineScore, 72, '100 - 12(计划外) - 16(节前2日超限) = 72');

  // (b) 国庆7天长假前最后1个交易日 (2026-09-30，上限30%)：尾盘潜伏买入 1000股 * ¥20 = 2万（买前5万->买后35%），扣分更严(-22)
  const auditTail1d = feLedger.auditTradeExecution({
    stock: { code: '002384', name: '东山精密', price: 20.0, prevClose: 19.8, tier: 'short' },
    code: '002384',
    dir: '尾盘买入',
    track: 'short_swing',
    buy: 20.0,
    sell: 0,
    qty: 1000,
    net: -6,
    plan: '自动判定',
    currentMktVal: 50000,
    allowedCapPct: 80,
    totalAssets: 200000,
    date: '2026-09-30',
  });
  assert.ok(auditTail1d.mistakeTags.includes('pre_holiday_overcap'));
  assert.strictEqual(auditTail1d.plan, '计划外');
  assert.strictEqual(auditTail1d.disciplineScore, 66, '100 - 12(计划外) - 22(节前收官尾盘超限) = 66');

  // (c) 合规控仓买入：国庆前1日买后总仓 25% <= 30% -> 保持计划内与满分100分
  const auditSafe1d = feLedger.auditTradeExecution({
    stock: { code: '605128', name: '上海沿浦', price: 25.2, prevClose: 25.0 },
    code: '605128',
    dir: '买入建仓',
    buy: 25.0,
    sell: 0,
    qty: 400,
    net: 0,
    plan: '自动判定',
    currentMktVal: 40000,
    allowedCapPct: 80,
    totalAssets: 200000,
    date: '2026-09-30',
  });
  assert.strictEqual(auditSafe1d.mistakeTags.includes('pre_holiday_overcap'), false);
  assert.strictEqual(auditSafe1d.plan, '计划内');
  assert.strictEqual(auditSafe1d.disciplineScore, 100);

  // (d) 日内闭环正T（buy>0 && sell>0）不增加隔夜仓位，即使原底仓已有 45% 亦绝不误扣 pre_holiday_overcap
  const auditIntradayT = feLedger.auditTradeExecution({
    stock: { code: '605128', name: '上海沿浦', price: 25.2, prevClose: 25.0, high: 25.9 },
    code: '605128',
    dir: '正T',
    buy: 24.8,
    sell: 25.65,
    qty: 500,
    net: 412,
    plan: '自动判定',
    currentMktVal: 90000,
    allowedCapPct: 80,
    totalAssets: 200000,
    date: '2026-09-30',
  });
  assert.strictEqual(auditIntradayT.mistakeTags.includes('pre_holiday_overcap'), false);
  assert.strictEqual(auditIntradayT.disciplineScore, 100);

  // (e) 四维评分卡 computeDisciplineScorecard 对 pre_holiday_overcap 准确扣减环境仓位分与止损纪律分
  const sc = feLedger.computeDisciplineScorecard(
    [
      {
        id: 1,
        date: '2026-09-30',
        code: '002384',
        stock: '东山精密 (002384)',
        dir: '尾盘买入',
        track: 'short_swing',
        buy: 20,
        sell: 0,
        qty: 1000,
        net: -6,
        plan: auditTail1d.plan,
        mistakeTags: auditTail1d.mistakeTags,
        postBuyPosPct: auditTail1d.postBuyPosPct,
        holidayCapPct: auditTail1d.holidayCapPct,
        systemBenchmark: auditTail1d.systemBenchmark,
        disciplineScore: auditTail1d.disciplineScore,
      },
    ],
    [],
    null
  );
  assert.strictEqual(sc.envScore, 14, '25 - 4(计划外) - 7(节前超限) = 14');
  assert.strictEqual(sc.stopScore, 22, '25 - 3(尾盘跨假T+1锁仓) = 22');
  assert.strictEqual(sc.totalScore, 86);

  // 11. eod.js 15:05 盘后收盘归档（inspectPostMarketPositions + buildEodBriefMarkdown）节前超限核查与节后首日竞价减仓预案测试
  const eodPool = [
    { code: '605128', name: '上海沿浦', shares: 4400, cost: 24.5, price: 25.0, prevClose: 24.8, tier: 'long' },
  ];
  const eodTails = [
    { id: 9, code: '002384', name: '东山精密', shares: 1000, cost: 20.0, price: 20.0, tp1: 20.6, stop: 19.6, status: 'active' },
  ];
  // 总资产 20万（持仓 11万 + 尾盘 2万 = 13万，占比 65%；可用现金 7万）
  // (a) 国庆7天长假前最后1个交易日 (2026-09-30，上限30%=6万，超额7万)
  const posCheck1d = feEod.inspectPostMarketPositions({
    pool: eodPool,
    tailActives: eodTails,
    tradeLogs: [],
    availableCash: 70000,
    allowedCapPct: 80,
    date: '2026-09-30',
  });
  assert.strictEqual(posCheck1d.hasHolidayOvercapWarning, true);
  assert.strictEqual(posCheck1d.nextTradeDate, '2026-10-08');
  assert.strictEqual(posCheck1d.holidayGuard.excessPct, 35);
  assert.strictEqual(posCheck1d.holidayGuard.excessAmt, 70000);
  assert.strictEqual(posCheck1d.holidayGuard.reductionTargets.length, 2);
  assert.strictEqual(posCheck1d.holidayGuard.reductionTargets[0].code, '002384', '优先减出尾盘隔夜仓');
  assert.strictEqual(posCheck1d.holidayGuard.reductionTargets[0].trimShares, 1000);
  assert.strictEqual(posCheck1d.holidayGuard.reductionTargets[1].code, '605128');
  assert.strictEqual(posCheck1d.holidayGuard.reductionTargets[1].trimShares, 2000, '再减底仓2000股(5万)，合计回笼7万回到30%');

  const snap1d = feEod.buildPostMarketSnapshot({
    date: '2026-09-30',
    pool: eodPool,
    tailActives: eodTails,
    availableCash: 70000,
    initialCapital: 200000,
    prevSnapshots: [],
  });
  const brief1d = feEod.buildEodBriefMarkdown({
    date: '2026-09-30',
    snapshot: snap1d.snapshot,
    deltaInfo: snap1d.deltaInfo,
    todayLogs: [],
    pool: eodPool,
    positionCheck: posCheck1d,
    marketEnv: { level: 'OK', text: '节前收官缩量' },
    allowedCapPct: 80,
    alertRecords: [],
  });
  assert.strictEqual(brief1d.holidayAudit.isYellowCard, true);
  assert.ok(brief1d.briefMarkdown.includes('节前长假超上限持仓黄牌预警'));
  assert.ok(brief1d.briefMarkdown.includes('节后首日 (2026-10-08) 09:25 竞价/早盘分标的减仓配额建议'));
  assert.ok(brief1d.briefMarkdown.includes('### 五、节后首日（2026-10-08）竞价减仓与盘前挂单锚点预案'));
  assert.ok(brief1d.briefMarkdown.includes('节后首日竞价/早盘减仓 2000股'));

  // (b) 国庆7天长假前剩2个交易日 (2026-09-29)：生成明日 (2026-09-30) 节前收官日早盘降仓预案
  const posCheck2d = feEod.inspectPostMarketPositions({
    pool: eodPool,
    tailActives: eodTails,
    tradeLogs: [],
    availableCash: 70000,
    allowedCapPct: 80,
    date: '2026-09-29',
  });
  const brief2d = feEod.buildEodBriefMarkdown({
    date: '2026-09-29',
    snapshot: { ...snap1d.snapshot, date: '2026-09-29' },
    deltaInfo: snap1d.deltaInfo,
    todayLogs: [],
    pool: eodPool,
    positionCheck: posCheck2d,
    marketEnv: { level: 'OK', text: '节前取现日' },
    allowedCapPct: 80,
    alertRecords: [],
  });
  assert.strictEqual(brief2d.holidayAudit.isYellowCard, true);
  assert.ok(brief2d.briefMarkdown.includes('### 五、明日（2026-09-30 · 国庆节收官日）早盘降仓与挂单锚点预案'));
  assert.ok(brief2d.briefMarkdown.includes('节前收官优先减仓 2000股'));

  // (c) 节前控仓达标 (25% <= 30%)：不触发黄牌，输出达标确认
  const safePool = [{ code: '605128', name: '上海沿浦', shares: 2000, cost: 24.5, price: 25.0, prevClose: 24.8, tier: 'long' }];
  const posCheckSafe = feEod.inspectPostMarketPositions({
    pool: safePool,
    tailActives: [],
    tradeLogs: [],
    availableCash: 150000,
    allowedCapPct: 80,
    date: '2026-09-30',
  });
  const snapSafe = feEod.buildPostMarketSnapshot({
    date: '2026-09-30',
    pool: safePool,
    tailActives: [],
    availableCash: 150000,
    initialCapital: 200000,
    prevSnapshots: [],
  });
  const briefSafe = feEod.buildEodBriefMarkdown({
    date: '2026-09-30',
    snapshot: snapSafe.snapshot,
    deltaInfo: snapSafe.deltaInfo,
    todayLogs: [],
    pool: safePool,
    positionCheck: posCheckSafe,
    marketEnv: { level: 'OK', text: '节前收官缩量' },
    allowedCapPct: 80,
    alertRecords: [],
  });
  assert.strictEqual(briefSafe.holidayAudit.active, true);
  assert.strictEqual(briefSafe.holidayAudit.isYellowCard, false);
  assert.ok(briefSafe.briefMarkdown.includes('节前长假控仓核查达标'));

  // 12. AccountPage 节前控仓水位线与跨假安全可开仓余量拆解（evaluateAccountHolidayWatermark）测试
  // (a) 国庆7天长假前1日 (2026-09-30，上限30%=6万)：总资产20万，持仓5万(25%)，现金15万 -> 跨假可动用现金仅 1万，其余 14万锁为护城河储备
  const accSafe1d = feRisk.evaluateAccountHolidayWatermark({
    totalAssets: 200000,
    marketValue: 50000,
    cash: 150000,
    posRate: 25,
    emotionCapPct: 80,
    now: '2026-09-30',
  });
  assert.strictEqual(accSafe1d.mode, 'safe_urgent');
  assert.strictEqual(accSafe1d.showBanner, true);
  assert.strictEqual(accSafe1d.showChartLine, true);
  assert.strictEqual(accSafe1d.isYellowCard, false);
  assert.strictEqual(accSafe1d.watermarkPct, 30);
  assert.strictEqual(accSafe1d.watermarkMkt, 60000);
  assert.strictEqual(accSafe1d.headroomPct, 5);
  assert.strictEqual(accSafe1d.headroomAmt, 10000);
  assert.strictEqual(accSafe1d.deployableCash, 10000);
  assert.strictEqual(accSafe1d.reserveCash, 140000);

  // (b) 国庆7天长假前2日 (2026-09-29，上限30%=6万)：总资产20万，持仓13万(65%)，现金7万 -> 超限黄牌，可动用现金 ¥0，需降仓 7万
  const accOver2d = feRisk.evaluateAccountHolidayWatermark({
    totalAssets: 200000,
    marketValue: 130000,
    cash: 70000,
    posRate: 65,
    emotionCapPct: 80,
    now: '2026-09-29',
  });
  assert.strictEqual(accOver2d.mode, 'over_cap');
  assert.strictEqual(accOver2d.isYellowCard, true);
  assert.strictEqual(accOver2d.excessPct, 35);
  assert.strictEqual(accOver2d.excessAmt, 70000);
  assert.strictEqual(accOver2d.deployableCash, 0);
  assert.strictEqual(accOver2d.reserveCash, 70000);

  // (c) 普通交易周 (2026-11-22) 或单日短假 (2027-06-08)：不展示长假水位横幅与图表节前线
  const accNormal = feRisk.evaluateAccountHolidayWatermark({
    totalAssets: 200000,
    marketValue: 50000,
    cash: 150000,
    posRate: 25,
    emotionCapPct: 80,
    now: '2026-11-22',
  });
  assert.strictEqual(accNormal.mode, 'normal');
  assert.strictEqual(accNormal.showBanner, false);
  assert.strictEqual(accNormal.showChartLine, false);
  assert.strictEqual(accNormal.deployableCash, 110000);

  const accShortHol = feRisk.evaluateAccountHolidayWatermark({
    totalAssets: 100000,
    marketValue: 60000,
    cash: 40000,
    posRate: 60,
    emotionCapPct: 80,
    now: '2027-06-08',
  });
  assert.strictEqual(accShortHol.mode, 'normal');
  assert.strictEqual(accShortHol.showBanner, false);

  // 13. TradingClockModal 实时交易日历与激活分时槽位快照（getTradingClockSnapshot）测试
  // (a) 国庆法定节假日休市中 (北京时间 2026-10-02 10:00 == 2026-10-02T02:00:00Z)
  const ckHol = feCal.getTradingClockSnapshot(new Date('2026-10-02T02:00:00Z'));
  assert.strictEqual(ckHol.isTradeDay, false);
  assert.strictEqual(ckHol.isHoliday, true);
  assert.strictEqual(ckHol.isInHoliday, true);
  assert.strictEqual(ckHol.activeSlotId, null);
  assert.strictEqual(ckHol.prevTradeDate, '2026-09-30');
  assert.strictEqual(ckHol.nextTradeDate, '2026-10-08');
  assert.ok(ckHol.sessionBadge.includes('国庆节休市'));

  // (b) 国庆前最后1个交易日尾盘清T窗口 (北京时间 2026-09-30 14:40 == 2026-09-30T06:40:00Z)
  const ckPre1d = feCal.getTradingClockSnapshot(new Date('2026-09-30T06:40:00Z'));
  assert.strictEqual(ckPre1d.isTradeDay, true);
  assert.strictEqual(ckPre1d.isPreHolidayUrgent, true);
  assert.strictEqual(ckPre1d.activeSlotId, 'force_close_t');
  assert.strictEqual(ckPre1d.nextTradeDate, '2026-10-08');
  assert.strictEqual(ckPre1d.holidayReminder.remainingTradeDays, 1);
  assert.strictEqual(ckPre1d.holidayReminder.suggestedMaxPosPct, 30);

  // (c) 节后首日做T黄金主窗口 (北京时间 2026-10-08 10:05 == 2026-10-08T02:05:00Z)
  const ckGolden = feCal.getTradingClockSnapshot(new Date('2026-10-08T02:05:00Z'));
  assert.strictEqual(ckGolden.isTradeDay, true);
  assert.strictEqual(ckGolden.isPreHolidayUrgent, false);
  assert.strictEqual(ckGolden.activeSlotId, 'golden_t');
  assert.strictEqual(ckGolden.weekdayLabel, '周四');

  // 14. 顶栏交易时钟按钮角标（evaluateTopNavClockBadge）法定节假日休市与节前控仓黄牌测试
  // (a) 国庆法定节假日休市期（仓位25%达标 <= 30%） -> 展示红底休市角标，不亮黄牌
  const tbHolSafe = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 25,
    totalMkt: 50000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: new Date('2026-10-02T02:00:00Z'),
  });
  assert.strictEqual(tbHolSafe.kind, 'holiday_closed');
  assert.strictEqual(tbHolSafe.showBadge, true);
  assert.strictEqual(tbHolSafe.isHolidayClosed, true);
  assert.strictEqual(tbHolSafe.isYellowCard, false);
  assert.strictEqual(tbHolSafe.dotTone, 'closed');
  assert.ok(tbHolSafe.badgeText.includes('国庆节休市'));
  assert.ok(tbHolSafe.badgeText.includes('连休7天'));

  // (b) 2026春节连休首日（2026-02-15 周日，连休9天）且跨假持仓60% > 30% -> 展示连休+跨假超限提醒
  const tbHolOver = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 60,
    totalMkt: 120000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: new Date('2026-02-15T03:00:00Z'),
  });
  assert.strictEqual(tbHolOver.kind, 'holiday_closed');
  assert.strictEqual(tbHolOver.showBadge, true);
  assert.strictEqual(tbHolOver.isYellowCard, true);
  assert.strictEqual(tbHolOver.badgeTone, 'holiday-overcap');
  assert.ok(tbHolOver.badgeText.includes('春节'));

  // (c) 国庆7天长假前2日盘中（2026-09-29 10:15），仓位65% > 30% -> 亮节前黄牌角标
  const tbPreYellow = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 65,
    totalMkt: 130000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: new Date('2026-09-29T02:15:00Z'),
  });
  assert.strictEqual(tbPreYellow.kind, 'pre_holiday_yellow');
  assert.strictEqual(tbPreYellow.showBadge, true);
  assert.strictEqual(tbPreYellow.isYellowCard, true);
  assert.strictEqual(tbPreYellow.dotTone, 'warn');
  assert.strictEqual(tbPreYellow.badgeTone, 'yellow-card');
  assert.strictEqual(tbPreYellow.excessPct, 35);
  assert.ok(tbPreYellow.badgeText.includes('节前黄牌'));
  assert.ok(tbPreYellow.badgeText.includes('国庆节前2日'));

  // (d) 国庆7天长假前1日尾盘清T窗（2026-09-30 14:40），仓位25% <= 30% -> 展示节前控仓达标角标，且 dotTone='danger'
  const tbPreSafe = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 25,
    totalMkt: 50000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: new Date('2026-09-30T06:40:00Z'),
  });
  assert.strictEqual(tbPreSafe.kind, 'pre_holiday_window');
  assert.strictEqual(tbPreSafe.showBadge, true);
  assert.strictEqual(tbPreSafe.isYellowCard, false);
  assert.strictEqual(tbPreSafe.dotTone, 'danger');
  assert.strictEqual(tbPreSafe.badgeTone, 'window-safe');
  assert.ok(tbPreSafe.badgeText.includes('控仓≤30%达标'));

  // (e) 距国庆尚余3个交易日（2026-09-28 10:00） -> 轻量倒计时角标，dotTone='live'
  const tbCountdown = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 70,
    totalMkt: 140000,
    totalAssets: 200000,
    emotionCapPct: 80,
    now: new Date('2026-09-28T02:00:00Z'),
  });
  assert.strictEqual(tbCountdown.kind, 'pre_holiday_countdown');
  assert.strictEqual(tbCountdown.showBadge, true);
  assert.strictEqual(tbCountdown.isYellowCard, false);
  assert.strictEqual(tbCountdown.dotTone, 'live');
  assert.strictEqual(tbCountdown.badgeText, '📅 国庆节前3日');

  // (f) 单日短假前1日（2027-06-08）及普通交易日（2026-11-23 10:00） -> 不展示额外角标（零视觉噪音）
  const tbShort = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 75,
    now: new Date('2027-06-08T02:00:00Z'),
  });
  assert.strictEqual(tbShort.kind, 'normal');
  assert.strictEqual(tbShort.showBadge, false);

  const tbNormal = feRisk.evaluateTopNavClockBadge({
    totalPosPct: 75,
    now: new Date('2026-11-23T02:00:00Z'),
  });
  assert.strictEqual(tbNormal.kind, 'normal');
  assert.strictEqual(tbNormal.showBadge, false);
  assert.strictEqual(tbNormal.dotTone, 'live');

  // 15. 「复制今日作战计划」（buildDailyBattlePlanText）法定节假日倒计时与节前控仓黄牌降仓提示测试
  const copyPool = [
    { code: '605128', name: '上海沿浦', shares: 4400, cost: 24.5, price: 25.0, prevClose: 24.8, tier: 'long', memo: '守住均线做正T' },
    { code: '300750', name: '宁德时代', shares: 0, cost: 0, price: 210.0, prevClose: 208.0, tier: 'short' },
  ];
  const copyTails = [
    { id: 1, code: '002384', name: '东山精密', shares: 1000, cost: 20.0, price: 20.0, tp1: 20.6, stop: 19.6, status: 'active' },
  ];

  // (a) 国庆7天长假前2日（2026-09-29，上限30%）：持仓13万/总资产20万(65%) -> 附带黄牌降仓¥70,000 + 分标的优先减仓配额
  const planYellow2d = feEod.buildDailyBattlePlanText({
    now: '2026-09-29',
    pool: copyPool,
    tailActives: copyTails,
    totalAssets: 200000,
    cash: 70000,
    marketValue: 130000,
    posRate: 65,
    allowedCapPct: 80,
  });
  assert.strictEqual(planYellow2d.holidayGuard.isYellowCard, true);
  assert.ok(planYellow2d.text.includes('🟨 【节前控仓黄牌提醒】'));
  assert.ok(planYellow2d.text.includes('国庆节'));
  assert.ok(planYellow2d.text.includes('70,000'));
  assert.ok(planYellow2d.text.includes('东山精密(建议减1000股'));
  assert.ok(planYellow2d.text.includes('上海沿浦(建议减2000股'));
  assert.ok(planYellow2d.text.includes('🟨[节前优先减仓 2000股'));

  // (b) 国庆7天长假前最后1日（2026-09-30，上限30%）：持仓5万/总资产20万(25% <= 30%) -> 附带节前控仓窗口达标 + 跨假T+1提示
  const planSafe1d = feEod.buildDailyBattlePlanText({
    now: '2026-09-30',
    pool: [{ code: '605128', name: '上海沿浦', shares: 2000, cost: 24.5, price: 25.0, prevClose: 24.8, tier: 'long' }],
    tailActives: [],
    totalAssets: 200000,
    cash: 150000,
    marketValue: 50000,
    posRate: 25,
    allowedCapPct: 80,
  });
  assert.strictEqual(planSafe1d.holidayGuard.active, true);
  assert.strictEqual(planSafe1d.holidayGuard.isYellowCard, false);
  assert.ok(planSafe1d.text.includes('🏮 【节前控仓窗口达标】'));
  assert.ok(planSafe1d.text.includes('T+1'));
  assert.ok(planSafe1d.text.includes('2026-10-08'));

  // (c) 距国庆尚余3个交易日（2026-09-28） -> 附带近期节假日倒计时与预备控仓提示
  const planCountdown3d = feEod.buildDailyBattlePlanText({
    now: '2026-09-28',
    pool: copyPool,
    tailActives: [],
    totalAssets: 200000,
    cash: 90000,
    marketValue: 110000,
    posRate: 55,
    allowedCapPct: 80,
  });
  assert.ok(planCountdown3d.text.includes('📅 【近期节假日倒计时】'));
  assert.ok(planCountdown3d.text.includes('还有 3 个交易日'));
  assert.ok(planCountdown3d.text.includes('≤30%'));

  // (d) 国庆法定节假日休市期（2026-10-02） -> 附带休市备战与节后首日竞价减仓/挂单提示
  const planInHoliday = feEod.buildDailyBattlePlanText({
    now: '2026-10-02',
    pool: copyPool,
    tailActives: [],
    totalAssets: 200000,
    cash: 90000,
    marketValue: 110000,
    posRate: 55,
    allowedCapPct: 80,
  });
  assert.ok(planInHoliday.text.includes('🏮 【法定节假日休市备战】'));
  assert.ok(planInHoliday.text.includes('2026-10-08'));
  assert.ok(planInHoliday.text.includes('高于建议水位 30%'));

  // (e) 普通交易日（2026-11-23） -> 无任何多余节假日提示噪音
  const planNormal = feEod.buildDailyBattlePlanText({
    now: '2026-11-23',
    pool: copyPool,
    tailActives: [],
    totalAssets: 200000,
    cash: 90000,
    marketValue: 110000,
    posRate: 55,
    allowedCapPct: 80,
  });
  assert.strictEqual(planNormal.text.includes('节前控仓'), false);
  assert.strictEqual(planNormal.text.includes('近期节假日倒计时'), false);
  assert.strictEqual(planNormal.text.includes('法定节假日休市备战'), false);

  // 16. 全链路审计新增回归：跨时区 UTC+8 日期对齐、tier 显式优先级互斥、手工「底仓建仓」单边审计
  const feUtils = await import('../src/services/utils.js');
  // 美东 2026-11-22 20:35（UTC 2026-11-23T01:35:00Z）对应北京时间 2026-11-23 09:35 开盘初段
  const usEveningUtc = new Date('2026-11-23T01:35:00Z');
  assert.strictEqual(feUtils.todayStr(usEveningUtc), '2026-11-23');
  assert.strictEqual(feUtils.nowTimeHHMM(usEveningUtc), '09:35');

  // 底仓建仓在当日 T+1 锁定判定中应与买入建仓一致锁定可卖股数
  const todayCn = feUtils.todayStr();
  const tLockBaseBuild = feUtils.getTodayTStatus(
    { code: '605128', name: '上海沿浦', shares: 1000 },
    [{ date: todayCn, stock: '上海沿浦 (605128)', dir: '底仓建仓', buy: 35.2, sell: 0, qty: 1000 }]
  );
  assert.strictEqual(tLockBaseBuild.initBoughtQty, 1000);
  assert.strictEqual(tLockBaseBuild.t1LockedShares, 1000);
  assert.strictEqual(tLockBaseBuild.sellableShares, 0);
  assert.strictEqual(tLockBaseBuild.isFirstDayLocked, true);

  // tier 显式切换后（如从稳健池导入 poolTag='稳健' 但手工切换 tier='short'），减仓优先级与归属严格按 tier 走短线先减
  const tierSwitchPlan = feEod.buildDailyBattlePlanText({
    now: '2026-09-29',
    pool: [
      { code: '605128', name: '上海沿浦', shares: 2000, price: 35, cost: 34, tier: 'short', poolTag: '稳健' },
      { code: '600036', name: '招商银行', shares: 2000, price: 35, cost: 34, tier: 'long', poolTag: '稳健' },
    ],
    tailActives: [],
    totalAssets: 200000,
    cash: 60000,
    marketValue: 140000,
    posRate: 70,
    allowedCapPct: 80,
  });
  const idxShortFirst = tierSwitchPlan.text.indexOf('上海沿浦(建议减2000股');
  const idxLongSecond = tierSwitchPlan.text.indexOf('招商银行(建议减300股');
  assert.ok(idxShortFirst > 0 && idxLongSecond > idxShortFirst);

  // 手工录入单边「底仓建仓」(sell=0) 在节前窗口超限时，不被误判为已平仓闭环，且正常触发 pre_holiday_overcap 黄牌标签
  const baseBuildAudit = feLedger.auditTradeExecution({
    stockText: '上海沿浦 (605128)',
    dir: '底仓建仓',
    track: 'long_t',
    buy: 35.0,
    sell: 0,
    qty: 2000,
    net: 0,
    plan: '计划内',
    basis: '客观信号',
    mistakeTags: [],
    prevLogs: [],
    poolList: [{ code: '605128', name: '上海沿浦', shares: 2000, price: 35.0, cost: 35.0 }],
    tailActives: [],
    allowedCapPct: 80,
    totalAssets: 100000,
    date: '2026-09-29',
  });
  assert.strictEqual(baseBuildAudit.alphaNet, null);
  assert.ok(baseBuildAudit.mistakeTags.includes('pre_holiday_overcap'));
  assert.strictEqual(baseBuildAudit.postBuyPosPct, 70);
  assert.strictEqual(baseBuildAudit.holidayCapPct, 30);

  console.log('✅ All A-share trade calendar, PreMarket, PositionRiskBar, PreTrade buy-guard, Ledger audit, EOD brief, AccountPage, TradingClockModal, TopNav badge, CopyPlan & Full-Audit regression tests passed! (266 assertions)');
})();
