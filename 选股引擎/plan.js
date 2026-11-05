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

async function getJson(url, retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
      return JSON.parse(new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer())));
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw err;
}

async function kline(code, n = 70) {
  try {
    const j = await getJson(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${n},qfq`);
    const d = j?.data?.[code];
    const arr = d?.qfqday || d?.day;
    if (!Array.isArray(arr) || arr.length < 25) return null;
    return arr.map((r) => ({ date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], vol: +r[5] }));
  } catch { return null; }
}

const ma = (b, n) => { const w = b.slice(-n); return w.reduce((a, c) => a + c.close, 0) / w.length; };

(async function main() {
  const cands = picks.picks.filter((p) => p.score >= 60 && p.verdict !== '放弃');
  console.log(`候选 ${picks.picks.length} 只 → 进入计划 ${cands.length} 只\n`);

  // 市场环境（第四条闸门）—— 双指数：上证代表大盘，中证1000代表候选的真实风格
  const PROXY = [
    { key: '上证指数', code: 'sh000001', role: '大盘' },
    { key: '中证1000', code: 'sh000852', role: '小盘（候选所属风格）' },
  ];
  const envIdx = [];
  for (const p2 of PROXY) {
    const bars = await kline(p2.code, 70);
    if (!bars) { envIdx.push({ ...p2, ok: false }); continue; }
    const c = bars.at(-1).close, m20 = ma(bars, 20), m60 = bars.length >= 60 ? ma(bars, 60) : null;
    envIdx.push({
      ...p2, ok: true, close: +c.toFixed(2), ma20: +m20.toFixed(2), ma60: m60 ? +m60.toFixed(2) : null,
      vsMa20: +((c / m20 - 1) * 100).toFixed(2),
      below20: c < m20, below60: m60 ? c < m60 : false,
    });
  }
  /* 判定：以「中证1000」为主（候选绝大多数是中小盘），上证为辅。
     两个都破 → BAD；只破一个 → WARN；都在上方 → OK。
     为什么小盘优先：大盘股护盘时上证可能还在 MA20 上方，而中小盘已经在杀，
     这时按上证放行会放过一批注定下跌的票。 */
  const s1 = envIdx.find((x) => x.key === '上证指数');
  const s2 = envIdx.find((x) => x.key === '中证1000');
  const bad = (x) => x?.ok && x.below20 && x.below60;
  const warn = (x) => x?.ok && x.below20 && !x.below60;
  let envLevel, envText;
  if (bad(s1) && bad(s2)) { envLevel = 'BAD'; envText = '上证与中证1000 同时跌破 MA20/MA60 → 系统性下行，禁止新开正T'; }
  else if (bad(s2)) { envLevel = 'BAD'; envText = '中证1000 跌破 MA20/MA60（候选所属风格走坏）→ 禁止新开正T'; }
  else if (bad(s1)) { envLevel = 'WARN'; envText = '上证跌破 MA20/MA60 但小盘尚可 → 仓位减半'; }
  else if (warn(s1) && warn(s2)) { envLevel = 'WARN'; envText = '两市均在 MA20 下方 → 仓位减半、止损收紧到 −1.0%'; }
  else if (warn(s2) || warn(s1)) { envLevel = 'WARN'; envText = '其中一个指数在 MA20 下方 → 仓位减半'; }
  else { envLevel = 'OK'; envText = '上证与中证1000 均在 MA20 上方，做T可正常执行'; }
  const iClose = s1?.close, iMa20 = s1?.ma20, iMa60 = s1?.ma60;

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

    // 综合放行判定
    let action = '按计划挂单';
    if (envLevel === 'BAD') action = '暂停（环境否决正T）';
    else if (g2.c === 'bad') action = '只做倒T';
    else if (g1.c === 'wait') action = '放弃（振幅不足）';
    else if (pos === 0) action = '观察，不挂单';

    rows.push({
      code: p.code, name: p.name, score: p.score, verdict: p.verdict,
      pc, amp: +amp.toFixed(2), grid: +grid.toFixed(1), bull, bear,
      volRatio: p.volRatio, vwapOnline: p.vwapOnline, turnover: p.turnover,
      expOpen: +expOpen.toFixed(2), sell1: +sell1.toFixed(2), sell2: +sell2.toFixed(2), stop: +stop.toFixed(2),
      pos, action, g1, g2, g3,
    });
  }

  rows.sort((a, b) => b.score - a.score || b.pos - a.pos);
  const active = rows.filter((r) => r.pos > 0 && r.action === '按计划挂单');

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

  fs.writeFileSync(path.join(__dirname, 'out', `plan-${date}.json`),
    JSON.stringify({ date, baseDate: picks.date, env: { level: envLevel, text: envText, idx: iClose, ma20: iMa20, ma60: iMa60, dual: envIdx }, rows }, null, 1));
  console.log(`\n→ out/plan-${date}.json`);
})();
