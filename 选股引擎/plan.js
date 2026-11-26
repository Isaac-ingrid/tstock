/**
 * plan.js —— 明日挂单计划（选股 × 冲高时段统计 × 做T三闸门）
 *
 * 输入：ledger/picks-YYYY-MM-DD.json（当日候选）+ 腾讯日K（个股与指数）
 * 口径全部对齐《做T执行台》：
 *   七格阶梯 GRID = 4/3 ≈ 1.3333%；振幅 ≥3 格才做；正T止损 −1.5%；量比 1.5 放量 / 1.0 缩量
 * 叠加本次回溯结论：
 *   次日平均低开 0.63%；+1% 有 70% 在开盘半小时触及；10:30 后仅剩 7.5pp；不守收盘
 *
 * 用法：node plan.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'ledger');
const GRID = 4 / 3;
const STOP = 1.5;
const GAP = 0.63;          // 统计的次日平均低开幅度 %
const T1 = 1.0, T2 = 2.0;  // 主副目标

const date = process.argv[2] || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const picks = JSON.parse(fs.readFileSync(path.join(LEDGER, `picks-${date}.json`), 'utf8'));

const { fetchDailyKline } = require('./vwap');
const { evaluateLiveMacroGate, computeStockMacroMetrics } = require('./macro_gate');

async function kline(code, n = 70) {
  const raw = await fetchDailyKline(code, n + 10);
  if (!Array.isArray(raw)) return null;
  const bars = raw.filter((b) => b.date <= date).slice(-n);
  return bars.length >= 25 ? bars : null;
}

const ma = (b, n) => { const w = b.slice(-n); return w.reduce((a, c) => a + c.close, 0) / w.length; };

(async function main() {
  const cands = picks.picks.filter((p) => p.score >= 60 && p.verdict !== '放弃');
  console.log(`候选 ${picks.picks.length} 只 → 进入计划 ${cands.length} 只\n`);

  // 统一接入五步交易系统同源实时天时闸门（上证指数 + 中证1000 结构三态 / BOLL / MACD顶底背离）
  const liveGate = await evaluateLiveMacroGate(date);
  const envIdx = liveGate.dual || [];
  const envLevel = liveGate.level || 'OK';
  const envText = `${liveGate.regimeLabel || ''} · ${liveGate.text || ''}`;
  const iClose = liveGate.idx, iMa20 = liveGate.ma20, iMa60 = liveGate.ma60;

  const rows = [];
  for (const p of cands) {
    const bars = await kline(p.code);
    await new Promise((r) => setTimeout(r, 60));
    if (!bars) { console.log('  !', p.code, p.name, '日K失败'); continue; }
    const last = bars.at(-1), prev = bars.at(-2);
    const pc = last.close;                      // 今日收盘 = 明日基准
    const amp = (last.high - last.low) / prev.close * 100;
    const grid = amp / GRID;
    const m5 = ma(bars, 5), m10 = ma(bars, 10), m20 = ma(bars, 20);
    const bull = m5 > m10 && m10 > m20 && pc > m5;
    const bear = m5 < m10 && m10 < m20 && pc < m5;

    // 三闸门
    const g1 = grid < 3 ? { c: 'wait', t: `振幅 ${amp.toFixed(1)}%（${grid.toFixed(1)}格）不足 3 格` }
      : grid <= 6 ? { c: 'ok', t: `振幅 ${amp.toFixed(1)}%（${grid.toFixed(1)}格）在 3–6 格区间` }
        : { c: 'warn', t: `振幅 ${amp.toFixed(1)}%（${grid.toFixed(1)}格）超 6 格` };
    const g2 = bear ? { c: 'bad', t: '空头排列，只允许倒T' } : bull ? { c: 'ok', t: '多头排列' } : { c: 'wait', t: '震荡' };
    const g3 = p.volRatio >= 1.5 ? { c: 'ok', t: `量比 ${p.volRatio.toFixed(2)} 放量` }
      : p.volRatio < 1 ? { c: 'wait', t: `量比 ${p.volRatio.toFixed(2)} 缩量` }
        : { c: 'ok', t: `量比 ${p.volRatio.toFixed(2)} 中性` };

    // 价位：以「预期开盘价」为锚
    const expOpen = pc * (1 - GAP / 100);
    const sell1 = expOpen * (1 + T1 / 100);
    const sell2 = expOpen * (1 + T2 / 100);
    const stop = expOpen * (1 - STOP / 100);
    const posPct = p.verdict === '可做' ? 30 : p.verdict === '小做' ? 15 : 0;
    const pos = envLevel === 'WARN' ? Math.round(posPct / 2) : envLevel === 'BAD' ? 0 : posPct;

    // 综合放行判定（结合大盘上升/下跌通道切换执行口令）
    let action = envLevel === 'OK' ? '按计划挂单（顺均线格局）' : '按计划挂单（次日收绿必砍）';
    if (envLevel === 'BAD') action = '暂停（环境否决正T）';
    else if (g2.c === 'bad') action = '只做倒T';
    else if (g1.c === 'wait') action = '放弃（振幅不足）';
    else if (pos === 0) action = '观察，不挂单';

    const stockChg1d = prev.close > 0 ? ((pc - prev.close) / prev.close) * 100 : 0;
    const macroMetrics = computeStockMacroMetrics(bars, pc, stockChg1d, liveGate);
    const isMainTheme = p.isMainTheme ?? (p.sectorTier === 'A' || p.sectorTier === 'B');

    rows.push({
      code: p.code, name: p.name, score: p.score, verdict: p.verdict,
      pc, amp: +amp.toFixed(2), grid: +grid.toFixed(1), bull, bear,
      volRatio: p.volRatio, vwapOnline: p.vwapOnline, turnover: p.turnover,
      sector: p.sector || '',
      sectorTier: p.sectorTier || '',
      sectorLabel: p.sectorLabel || '',
      isMainTheme,
      rs5d: macroMetrics.rs5d,
      rs1d: macroMetrics.rs1d,
      isResilient: macroMetrics.isResilient,
      rightSideConfirm: macroMetrics.rightSideConfirm,
      regimeMode: liveGate.regimeMode,
      leaderRole: p.leaderRole || '',
      roleLabel: p.roleLabel || '',
      chgRankInSector: p.chgRankInSector ?? null,
      amtRankInSector: p.amtRankInSector ?? null,
      limitUpDate: p.limitUpDate || null,
      limitUpCount30d: p.limitUpCount30d ?? null,
      pullback: p.pullback ?? null,
      expOpen: +expOpen.toFixed(2), sell1: +sell1.toFixed(2), sell2: +sell2.toFixed(2), stop: +stop.toFixed(2),
      pos, action, g1, g2, g3,
    });
  }

  rows.sort((a, b) => b.score - a.score || b.pos - a.pos);

  // 总仓位归一：严格遵循环境总仓上限（OK 80% / WARN 50% / BAD 0%），单票上限 30%，杜绝多只标的合计超 100%
  const maxTotalPos = envLevel === 'OK' ? 80 : envLevel === 'WARN' ? 50 : 0;
  const activeRows = rows.filter((r) => r.pos > 0 && r.action.startsWith('按计划挂单'));
  const rawTotalPos = activeRows.reduce((acc, r) => acc + r.pos, 0);
  if (rawTotalPos > maxTotalPos && maxTotalPos > 0) {
    const scale = maxTotalPos / rawTotalPos;
    activeRows.forEach((r) => {
      r.pos = Math.min(30, Math.max(5, Math.floor((r.pos * scale) / 5) * 5));
    });
  }
  const active = rows.filter((r) => r.pos > 0 && r.action.startsWith('按计划挂单'));

  for (const x of envIdx) {
    console.log(x.ok ? `  ${x.key} ${x.close}｜MA20 ${x.ma20}（${x.vsMa20}%）｜MA60 ${x.ma60}` : `  ${x.key} 取数失败`);
  }
  console.log(`闸门4：${envLevel} ${envText}`);
  console.log(`可挂单 ${active.length} 只\n`);
  console.log('名称'.padEnd(10) + '得分'.padEnd(6) + '今收'.padEnd(8) + '预计开'.padEnd(8) + '挂+1%'.padEnd(8) + '止损'.padEnd(8) + '仓位'.padEnd(6) + '动作');
  for (const r of rows) {
    console.log(r.name.slice(0, 5).padEnd(10) + String(r.score).padEnd(6) + String(r.pc).padEnd(8) +
      String(r.expOpen).padEnd(8) + String(r.sell1).padEnd(8) + String(r.stop).padEnd(8) +
      (r.pos + '%').padEnd(6) + r.action);
  }

  const channelMode = liveGate.channelMode || (envLevel === 'OK' ? 'UP' : 'DOWN');
  const channelGuide = channelMode === 'UP'
    ? '上升通道：逢缩量回调顺势加仓，沿 MA5/MA10 拉长格局扩大战果，不轻易下车'
    : '下跌/弱势通道：严禁浮亏补仓摊平！建仓次日收绿果断割肉换票；连红 3 天主动减仓，出现首阴收盘清仓';

  fs.writeFileSync(path.join(__dirname, 'out', `plan-${date}.json`),
    JSON.stringify({
      date,
      baseDate: picks.date,
      env: {
        level: envLevel,
        regimeMode: liveGate.regimeMode,
        regimeLabel: liveGate.regimeLabel,
        shStructure: liveGate.shStructure,
        shStructureLabel: liveGate.shStructureLabel,
        shChg1d: liveGate.shChg1d,
        shChg5d: liveGate.shChg5d,
        bottomDivergence: liveGate.bottomDivergence,
        topDivergence: liveGate.topDivergence,
        text: envText,
        channelMode,
        channelGuide,
        idx: iClose,
        ma20: iMa20,
        ma60: iMa60,
        dual: envIdx,
      },
      rows,
    }, null, 1));
  console.log(`\n→ out/plan-${date}.json`);
})();
