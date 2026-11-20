/**
 * steady.js —— 稳健型（底仓候选）清单
 *
 * 筛选链路：
 *   ① iFinD 智能选股：非ST + 总市值>300亿 + 股息率>2%  → 188 只
 *   ② iFinD 智能选股：非ST + 总市值>300亿 + ROE>10%   → 159 只
 *   ③ 取交集                                          → 44 只
 *   ④ 东财日K补：20 日均振幅 / ATR14 / MA20 方向 / MA60
 *   ⑤ 振幅适配过滤（1.5%–5.5%）：太死做不了T，太跳不是底仓
 *   ⑥ 四维打分排序
 *
 * 无法自动计算的维度（页面标注待人工核）：
 *   经营现金流/净利润、近 3 年营收 CAGR、资产负债率、PB 分位
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const norm = (c) => {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(c);
  if (m) return (m[2].toUpperCase() === 'SH' ? 'sh' : m[2].toUpperCase() === 'SZ' ? 'sz' : 'bj') + m[1];
  return c;
};
const secid = (code) => (norm(code).startsWith('sh') ? '1.' : '0.') + norm(code).replace(/^(sh|sz|bj)/, '');

const { fetchDailyKline } = require('./vwap');

async function kline(code) {
  const bars = await fetchDailyKline(norm(code), 130);
  return Array.isArray(bars) && bars.length >= 70 ? bars : null;
}

const ma = (bars, n, i = bars.length - 1) => {
  const w = bars.slice(Math.max(0, i - n + 1), i + 1);
  return w.reduce((a, b) => a + b.close, 0) / w.length;
};

function atr(bars, n = 14) {
  const t = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    t.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const w = t.slice(-n);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const poolPath = fs.existsSync(path.join(OUT, 'steady-pool.json'))
    ? path.join(OUT, 'steady-pool.json')
    : path.join(__dirname, 'steady-pool.json');
  const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  console.log(`稳健池 ${pool.length} 只，拉取日K…`);

  const rows = [];
  for (const s of pool) {
    let bars;
    try { bars = await kline(s.code); } catch { bars = null; }
    await new Promise((r) => setTimeout(r, 25));
    if (!bars) { console.log('  !', s.code, s.name, '日K失败'); continue; }

    const last = bars.at(-1);
    const amp20 = (() => {
      const w = bars.slice(-20);
      const v = w.map((b, i) => {
        const prev = i === 0 ? b.open : w[i - 1].close;
        return (b.high - b.low) / prev * 100;
      });
      return v.reduce((a, b) => a + b, 0) / v.length;
    })();
    const ma20 = ma(bars, 20), ma60 = ma(bars, 60);
    const ma20prev = ma(bars, 20, bars.length - 6);
    const a14 = atr(bars);
    const atrPct = a14 / last.close * 100;
    const trend = last.close > ma60 ? (ma20 > ma20prev ? '多头' : '整理') : '偏弱';

    const sc = {};
    sc.div = s.div >= 5 ? 30 : s.div >= 4 ? 24 : s.div >= 3 ? 18 : 12;
    sc.roe = s.roe >= 20 ? 30 : s.roe >= 15 ? 24 : s.roe >= 12 ? 18 : 12;
    sc.amp = amp20 >= 2 && amp20 <= 4 ? 20 : (amp20 >= 1.5 && amp20 < 2) || (amp20 > 4 && amp20 <= 5.5) ? 14 : 6;
    sc.trend = trend === '多头' ? 20 : trend === '整理' ? 12 : 0;
    const score = Object.values(sc).reduce((a, b) => a + b, 0);

    rows.push({
      ...s, close: last.close, ma20: +ma20.toFixed(2), ma60: +ma60.toFixed(2),
      amp20: +amp20.toFixed(2), atrPct: +atrPct.toFixed(2), trend,
      chg20: +((last.close / bars[bars.length - 21].close - 1) * 100).toFixed(1),
      score, sc,
    });
  }

  const fit = rows.filter((r) => r.amp20 >= 1.5 && r.amp20 <= 5.5);
  fit.sort((a, b) => b.score - a.score);
  const top = fit.slice(0, 12);

  console.log(`\n日K 成功 ${rows.length}｜振幅适配 ${fit.length}｜入榜 ${top.length}\n`);
  console.log('名称'.padEnd(10) + '股息%'.padEnd(8) + 'ROE%'.padEnd(7) + '市值亿'.padEnd(9) + '振幅%'.padEnd(8) + 'ATR%'.padEnd(7) + '趋势'.padEnd(7) + '得分');
  for (const r of top) {
    console.log(r.name.slice(0, 5).padEnd(10) + String(r.div.toFixed(1)).padEnd(8) + String(r.roe.toFixed(1)).padEnd(7) +
      String(r.mv).padEnd(9) + String(r.amp20.toFixed(1)).padEnd(8) + String(r.atrPct.toFixed(1)).padEnd(7) + r.trend.padEnd(7) + r.score);
  }

  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const payloadStr = JSON.stringify({ date, pool: pool.length, rows, fit: fit.length, top }, null, 1);
  fs.writeFileSync(path.join(OUT, 'steady.json'), payloadStr);
  fs.writeFileSync(path.join(OUT, `steady-${date}.json`), payloadStr);
  console.log(`\n→ ${path.join(OUT, 'steady.json')} (已归档 steady-${date}.json)`);
})();
