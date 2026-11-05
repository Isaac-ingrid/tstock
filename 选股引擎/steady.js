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

async function getJson(url, retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
      return JSON.parse(new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer())));
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw err;
}

async function kline(code) {
  const c = norm(code);
  // ① 东财前复权（字段最全，本次被限流则跳过）
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(c)}` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=130`;
    const j = await getJson(url, 1);
    const arr = j?.data?.klines || [];
    if (arr.length >= 70) {
      return arr.map((x) => {
        const f = x.split(',');
        return { date: f[0], open: +f[1], close: +f[2], high: +f[3], low: +f[4], vol: +f[5], amount: +f[6], chg: +f[8], turnover: +f[10] };
      });
    }
  } catch { /* 落下一源 */ }

  // ② 腾讯前复权
  try {
    const j = await getJson(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${c},day,,,130,qfq`, 2);
    const d = j?.data?.[c];
    const arr = d?.qfqday || d?.day;
    if (arr && arr.length >= 70) {
      return arr.map((r) => ({ date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], vol: +r[5] }));
    }
  } catch { /* 落下一源 */ }

  // ③ 新浪（不复权，除权日会跳空，仅作兜底）
  try {
    const arr = await getJson(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${c}&scale=240&ma=no&datalen=130`, 2);
    if (Array.isArray(arr) && arr.length >= 70) {
      return arr.map((r) => ({ date: r.day, open: +r.open, close: +r.close, high: +r.high, low: +r.low, vol: +r.volume }));
    }
  } catch { /* 全失败 */ }
  return null;
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
  const pool = JSON.parse(fs.readFileSync(path.join(OUT, 'steady-pool.json'), 'utf8'));
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
  fs.writeFileSync(path.join(OUT, 'steady.json'), JSON.stringify({ date, pool: pool.length, rows, fit: fit.length, top }, null, 1));
  console.log(`\n→ ${path.join(OUT, 'steady.json')}`);
})();
