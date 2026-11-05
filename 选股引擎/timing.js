/**
 * timing.js —— 次日冲高「时段分布」分析
 *
 * 问题：已知次日日内平均有 +3.26% 的空间，但不知道这波空间出现在几点。
 * 方法：用 30 分钟 K 线（腾讯 mkline，lmt=800 可回溯约 100 个交易日），
 *       对每个「选股日」取其次日的 8 根 30 分钟 K，统计：
 *         ① 当日最高价落在哪个时段
 *         ② 首次触及 +1% / +2% / +3%（相对开盘价）的时段
 *         ③ 到收盘时从最高点回撤多少（判断要不要守到收盘）
 *
 * 用法：node timing.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const SLOTS = [
  ['1000', '09:30–10:00'], ['1030', '10:00–10:30'], ['1100', '10:30–11:00'], ['1130', '11:00–11:30'],
  ['1330', '13:00–13:30'], ['1400', '13:30–14:00'], ['1430', '14:00–14:30'], ['1500', '14:30–15:00'],
];
const SLOT_NAME = Object.fromEntries(SLOTS);

async function getJson(url, retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
      return JSON.parse(new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer())));
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw err;
}

async function m30(code) {
  try {
    const j = await getJson(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m30,,800`);
    const arr = j?.data?.[code]?.m30;
    if (!Array.isArray(arr) || arr.length < 40) return null;
    // 按日聚合：{ '2026-10-30': [ {slot, open, high, low, close}, ... ] }
    const byDay = {};
    for (const r of arr) {
      const t = String(r[0]);                     // YYYYMMDDHHmm
      const d = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
      const slot = t.slice(8, 12);
      (byDay[d] = byDay[d] || []).push({ slot, open: +r[1], close: +r[2], high: +r[3], low: +r[4] });
    }
    for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => +a.slot - +b.slot);
    return byDay;
  } catch { return null; }
}

async function runPool(items, worker, concurrency = 2, delay = 40) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
      if (++done % 30 === 0) process.stdout.write(`  ${done}/${items.length}\r`);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
  }));
  return out;
}

(async function main() {
  const codes = JSON.parse(fs.readFileSync(path.join(OUT, 'picked-codes.json'), 'utf8'));
  const bt = JSON.parse(fs.readFileSync(path.join(OUT, 'backtest-v3.json'), 'utf8'));
  const picks = bt.detail.A.detail.filter((d) => d.h === 1).map((d) => ({ date: d.date, code: d.code, name: d.name }));
  const uniq = [...new Map(picks.map((p) => [`${p.date}|${p.code}`, p])).values()];

  console.log(`标的 ${codes.length} 只，选股日记录 ${uniq.length} 条\n拉取 30 分钟 K 线…`);
  const series = await runPool(codes, async (c) => ({ code: c, days: await m30(c) }), 2, 35);
  const ok = series.filter((s) => s.days);
  console.log(`\nK线成功 ${ok.length}/${codes.length}`);
  const byCode = Object.fromEntries(ok.map((s) => [s.code, s.days]));

  const TARGETS = [1, 2, 3];
  const slotStat = {};   // slot -> { high, hit1, hit2, hit3 }
  for (const [s] of SLOTS) slotStat[s] = { high: 0, hit1: 0, hit2: 0, hit3: 0 };
  const rows = [];
  let noNext = 0, used = 0;

  for (const p of uniq) {
    const days = byCode[p.code];
    if (!days) continue;
    const dates = Object.keys(days).sort();
    const i = dates.indexOf(p.date);
    if (i < 0 || i + 1 >= dates.length) { noNext++; continue; }
    const nextD = dates[i + 1];
    const bars = days[nextD];
    if (!bars || bars.length < 4) { noNext++; continue; }

    const prevBars = days[p.date];
    const prevClose = prevBars ? prevBars[prevBars.length - 1].close : null;
    const open = bars[0].open;
    const gap = prevClose ? +((open / prevClose - 1) * 100).toFixed(2) : null;
    const highBar = bars.reduce((a, b) => (b.high > a.high ? b : a), bars[0]);
    const lowAfterHigh = (() => {
      const idx = bars.indexOf(highBar);
      const after = bars.slice(idx);
      return after.reduce((a, b) => Math.min(a, b.low), highBar.low);
    })();
    const close = bars[bars.length - 1].close;

    const hits = {};
    for (const t of TARGETS) {
      const target = open * (1 + t / 100);
      const b = bars.find((x) => x.high >= target);
      hits[t] = b ? b.slot : null;
    }

    slotStat[highBar.slot].high++;
    for (const t of TARGETS) if (hits[t]) slotStat[hits[t]][`hit${t}`]++;

    rows.push({
      date: p.date, nextDate: nextD, code: p.code, name: p.name,
      open, prevClose, gap, high: highBar.high, close,
      highSlot: highBar.slot,
      highPct: +((highBar.high / open - 1) * 100).toFixed(2),
      closePct: +((close / open - 1) * 100).toFixed(2),
      giveBack: +((1 - close / highBar.high) * 100).toFixed(2),
      fromHighLow: +((lowAfterHigh / highBar.high - 1) * 100).toFixed(2),
      hit1: hits[1], hit2: hits[2], hit3: hits[3],
    });
    used++;
  }

  console.log(`有效样本 ${used} 条（次日无数据/停牌跳过 ${noNext} 条）\n`);

  /* ---------- 基准分布：同样本池、全部交易日（不施加选股条件） ---------- */
  const baseSlot = {};
  for (const [s] of SLOTS) baseSlot[s] = { high: 0, hit1: 0 };
  let baseDays = 0, baseGiveBack = 0, baseUpClose = 0;
  const pickKeys = new Set(uniq.map((p) => `${p.code}|${p.date}`));
  for (const [code, days] of Object.entries(byCode)) {
    const ds = Object.keys(days).sort();
    for (let i = 0; i < ds.length - 1; i++) {
      const nextBars = days[ds[i + 1]];
      if (!nextBars || nextBars.length < 6) continue;
      if (pickKeys.has(`${code}|${ds[i]}`)) continue;     // 排除选股日，避免自我污染
      const open = nextBars[0].open;
      const hb = nextBars.reduce((a, b) => (b.high > a.high ? b : a), nextBars[0]);
      baseSlot[hb.slot].high++;
      const t1 = nextBars.find((x) => x.high >= open * 1.01);
      if (t1) baseSlot[t1.slot].hit1++;
      baseGiveBack += 1 - nextBars[nextBars.length - 1].close / hb.high;
      if (nextBars[nextBars.length - 1].close > open) baseUpClose++;
      baseDays++;
    }
  }
  console.log(`\n基准样本（全股票日，剔除选股日）${baseDays} 条`);
  console.log('  最高价时段分布（基准 vs 选股后）：');
  for (const [s, label] of SLOTS) {
    const b = (baseSlot[s].high / baseDays * 100);
    const p = (slotStat[s].high / used * 100);
    console.log(`   ${label.padEnd(13)} 基准 ${b.toFixed(1).padStart(4)}%   选股后 ${p.toFixed(1).padStart(4)}%   差 ${(p - b >= 0 ? '+' : '') + (p - b).toFixed(1)}`);
  }
  const baseHit1 = Object.values(baseSlot).reduce((a, b) => a + b.hit1, 0) / baseDays * 100;
  const pickHit1 = Object.values(slotStat).reduce((a, b) => a + b.hit1, 0) / used * 100;
  console.log(`\n  全天曾触及 +1%：基准 ${baseHit1.toFixed(1)}%  vs 选股后 ${pickHit1.toFixed(1)}%`);
  console.log(`  开盘半小时触及 +1%：基准 ${(baseSlot['1000'].hit1 / baseDays * 100).toFixed(1)}%  vs 选股后 ${(slotStat['1000'].hit1 / used * 100).toFixed(1)}%`);
  console.log(`  高点后回撤：基准 ${(baseGiveBack / baseDays * 100).toFixed(2)}%  vs 选股后 ${(rows.reduce((a, r) => a + r.giveBack, 0) / rows.length).toFixed(2)}%`);
  console.log(`  收盘为正：基准 ${(baseUpClose / baseDays * 100).toFixed(1)}%  vs 选股后 ${(rows.filter((r) => r.closePct > 0).length / rows.length * 100).toFixed(1)}%`);


  /* ---------- 汇总 ---------- */
  const cum = (t) => {
    const arr = [];
    let acc = 0;
    for (const [s] of SLOTS) { acc += slotStat[s][`hit${t}`]; arr.push({ slot: s, add: slotStat[s][`hit${t}`], acc }); }
    return arr;
  };
  const line = (t) => cum(t).map((x) => `${SLOT_NAME[x.slot].slice(0, 5)} ${x.add}`).join(' | ');

  console.log('① 当日最高价出现在哪个时段：');
  for (const [s] of SLOTS) {
    const v = slotStat[s].high;
    console.log(`  ${SLOT_NAME[s].padEnd(13)} ${String(v).padStart(3)}  ${'█'.repeat(Math.round(v / used * 60))} ${(v / used * 100).toFixed(0)}%`);
  }

  console.log('\n② 首次触及目标价的时段（相对开盘价）：');
  for (const t of TARGETS) {
    const total = used;
    console.log(`  +${t}%  ` + cum(t).map((x) => `${SLOT_NAME[x.slot].slice(0, 5)}:${x.add}`).join('  ') + `   未触及 ${total - cum(t).at(-1).acc}`);
  }

  console.log('\n③ 冲到最高点后到收盘的回撤：');
  const gb = rows.map((r) => r.giveBack);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`  平均回撤 ${mean(gb).toFixed(2)}%｜中位 ${[...gb].sort((a, b) => a - b)[gb.length >> 1].toFixed(2)}%`);
  console.log(`  收盘仍为正的比例 ${(rows.filter((r) => r.closePct > 0).length / rows.length * 100).toFixed(0)}%`);

  /* ---------- 竞价强弱分组（次日开盘相对选股日收盘的跳空幅度） ---------- */
  const groups = [
    { k: '大幅低开 < −1.5%', f: (g) => g < -1.5 },
    { k: '小幅低开 −1.5~0%', f: (g) => g >= -1.5 && g < 0 },
    { k: '平开 0~+1%', f: (g) => g >= 0 && g < 1 },
    { k: '高开 +1~+3%', f: (g) => g >= 1 && g < 3 },
    { k: '大幅高开 ≥ +3%', f: (g) => g >= 3 },
  ];
  const gapStat = groups.map((G) => {
    const sub = rows.filter((r) => r.gap !== null && G.f(r.gap));
    const n = sub.length;
    const space = n ? sub.reduce((a, r) => a + r.highPct, 0) / n : null;
    const hit1 = n ? sub.filter((r) => r.highPct >= 1).length / n * 100 : null;
    const hit2 = n ? sub.filter((r) => r.highPct >= 2).length / n * 100 : null;
    const upClose = n ? sub.filter((r) => r.closePct > 0).length / n * 100 : null;
    const give = n ? sub.reduce((a, r) => a + r.giveBack, 0) / n : null;
    return { label: G.k, n, space: space && +space.toFixed(2), hit1: hit1 && +hit1.toFixed(0), hit2: hit2 && +hit2.toFixed(0), upClose: upClose && +upClose.toFixed(0), give: give && +give.toFixed(2) };
  });
  const valid = gapStat.filter((g) => g.n >= 8);
  console.log('\n④ 竞价强弱分组（按次日开盘跳空幅度）：');
  console.log('   分组'.padEnd(18) + '样本'.padEnd(6) + '日内空间'.padEnd(10) + '触及+1%'.padEnd(10) + '触及+2%'.padEnd(10) + '收盘为正'.padEnd(10) + '高点回撤');
  for (const g of gapStat) {
    if (!g.n) continue;
    console.log(`   ${g.label.padEnd(16)}${String(g.n).padStart(3)}   ${String(g.space).padStart(6)}%   ${String(g.hit1).padStart(5)}%   ${String(g.hit2).padStart(5)}%   ${String(g.upClose).padStart(5)}%   ${String(g.give).padStart(5)}%` + (g.n < 8 ? '  (样本不足)' : ''));
  }

  fs.writeFileSync(path.join(OUT, 'timing.json'), JSON.stringify({ used, slotStat, rows, slots: SLOTS, gapStat, baseSlot, baseDays, baseGiveBack: +(baseGiveBack / baseDays * 100).toFixed(2), baseUpClose: +(baseUpClose / baseDays * 100).toFixed(1), baseHit1: +(Object.values(baseSlot).reduce((a,b)=>a+b.hit1,0)/baseDays*100).toFixed(1), baseFirst1: +(baseSlot['1000'].hit1/baseDays*100).toFixed(1) }, null, 1));
  console.log(`\n→ ${path.join(OUT, 'timing.json')}`);
})();
