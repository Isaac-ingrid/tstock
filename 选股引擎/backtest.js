/**
 * backtest.js v3 —— 六步法完整体回溯 + 双开关对照实验
 *
 * 换数据源：东财 push2his 历史K线（腾讯日K 已被 WAF 拦截，且东财直接给换手率与成交额）
 *   字段：date,open,close,high,low,volume(手),amount(元),振幅,涨跌幅,涨跌额,换手率
 *
 * 六步法映射（本次全部可回补）：
 *   ① 涨幅 3–5%            f59
 *   ② 30 日内涨停           close==high 且 涨幅 ≥ 上限−0.35
 *   ③ 总市值 < 200 亿       今日市值近似
 *   ④ 量比 > 1             当日量 ÷ 前 5 日均量（日线口径）
 *   ⑤ 换手 5–10%           f61（原始字段，非估算）
 *   ⑥ 不破均价线           日级 VWAP = amount ÷ volume ÷ 100，条件 close ≥ VWAP × 1.005
 *                          （分钟级数据不可得，此处为日级退化口径）
 *
 * 四个变体：
 *   A 基线     ①②③④⑤
 *   B +VWAP    ①②③④⑤⑥
 *   C +环境    ①②③④⑤ ＋ 中证1000 收盘在 MA20 上方
 *   D 全开     ①②③④⑤⑥ ＋ MA20 上方
 *
 * 用法：node backtest.js [--days 60]
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const FEE = 0.0011;
const HOLD = [1, 2, 3, 5];
const arg = (k, d) => (process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d);
const DAYS = arg('--days', 60);

const secid = (code) => (code.startsWith('sh') ? '1.' : '0.') + code.replace(/^(sh|sz|bj)/, '');

async function getJson(url, retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
      return JSON.parse(new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer())));
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
  }
  throw err;
}

async function kline(code, lmt = 170) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(code)}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
  try {
    const j = await getJson(url);
    const arr = j?.data?.klines || [];
    if (arr.length < 40) return null;
    return arr.map((s) => {
      const f = s.split(',');
      return {
        date: f[0], open: +f[1], close: +f[2], high: +f[3], low: +f[4],
        vol: +f[5], amount: +f[6], chg: +f[8], turnover: +f[10],
        vwap: +f[6] / (+f[5] * 100),
      };
    });
  } catch { return null; }
}

async function runPool(items, worker, concurrency = 4, delay = 20) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
      if (++done % 100 === 0) process.stdout.write(`  ${done}/${items.length}\r`);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
  }));
  return out;
}

function hasLimitUp(bars, i, lookback = 30) {
  for (let k = Math.max(1, i - lookback); k < i; k++) {
    if (bars[k].chg >= 9.65 && Math.abs(bars[k].close - bars[k].high) < 0.005) return true;
  }
  return false;
}

(async function main() {
  const pool = JSON.parse(fs.readFileSync(path.join(OUT, 'pool.json'), 'utf8'));
  console.log(`样本池 ${pool.length} 只｜回溯 ${DAYS} 个交易日\n拉取个股日K（东财）…`);
  const raw = await runPool(pool, async (s) => {
    const bars = await kline(s.code);
    return bars ? { ...s, bars, pos: Object.fromEntries(bars.map((b, i) => [b.date, i])) } : null;
  }, 4, 18);
  const valid = raw.filter(Boolean);
  console.log(`\n日K 成功 ${valid.length}/${pool.length}`);

  console.log('拉取基准 中证1000…');
  const idxBars = await kline('sh000852', 200);
  if (!idxBars) { console.error('基准获取失败'); process.exit(1); }

  const idx = idxBars.map((b, i) => {
    const w = idxBars.slice(Math.max(0, i - 19), i + 1);
    const ma20 = w.reduce((a, c) => a + c.close, 0) / w.length;
    return { ...b, ma20, aboveMa20: i >= 20 && b.close > ma20 };
  });
  const idxPos = Object.fromEntries(idx.map((b, i) => [b.date, i]));

  const cal = idx.map((b) => b.date);
  const startIdx = Math.max(32, cal.length - DAYS - Math.max(...HOLD) - 1);
  const endIdx = cal.length - Math.max(...HOLD) - 1;

  const VARIANTS = {
    A: { name: '基线（无过滤）', vwap: false, env: false },
    B: { name: '＋VWAP 过滤', vwap: true, env: false },
    C: { name: '＋环境过滤', vwap: false, env: true },
    D: { name: '＋VWAP＋环境', vwap: true, env: true },
  };
  const agg = {};
  for (const k of Object.keys(VARIANTS)) agg[k] = { days: [], detail: [] };
  const byCode = Object.fromEntries(valid.map((s) => [s.code, s]));

  for (let di = startIdx; di <= endIdx; di++) {
    const date = cal[di];
    const ib = idx[idxPos[date]];
    const envOk = !!ib?.aboveMa20;
    const bench = {};
    for (const h of HOLD) {
      const b2 = idx[idxPos[cal[di + h]]];
      bench[`T+${h}`] = b2 ? (b2.close / ib.close - 1) * 100 : null;
    }

    const rec = {};
    for (const k of Object.keys(VARIANTS)) rec[k] = [];

    for (const s of valid) {
      const i = s.pos[date];
      if (i === undefined || i < 31) continue;
      const b = s.bars[i];

      if (!(b.chg >= 3 && b.chg <= 5)) continue;
      if (!(s.mv >= 30 && s.mv <= 200)) continue;
      const vAvg = s.bars.slice(i - 5, i).reduce((a, c) => a + c.vol, 0) / 5;
      if (!(b.vol / vAvg > 1)) continue;
      if (!(b.turnover >= 5 && b.turnover <= 10)) continue;
      if (!hasLimitUp(s.bars, i)) continue;

      const vwapOk = b.close >= b.vwap * 1.005;
      const base = {
        code: s.code, name: s.name, chg: +b.chg.toFixed(2), turnover: b.turnover,
        vwapGap: +((b.close / b.vwap - 1) * 100).toFixed(2), mv: s.mv,
      };
      for (const [k, cfg] of Object.entries(VARIANTS)) {
        if (cfg.vwap && !vwapOk) continue;
        if (cfg.env && !envOk) continue;
        rec[k].push(base);
      }
    }

    for (const k of Object.keys(VARIANTS)) {
      const picks = rec[k];
      const row = { date, n: picks.length, bench };
      if (picks.length) {
        row.ret = {};
        for (const h of HOLD) {
          let sA = 0, cA = 0, sB = 0, cB = 0;
          for (const p of picks) {
            const s = byCode[p.code];
            const i0 = s.pos[date], i1 = s.pos[cal[di + h]];
            if (i1 === undefined) continue;
            sA += s.bars[i1].close / s.bars[i0].close - 1 - FEE; cA++;
            const ip = s.pos[cal[di + 1]];
            if (ip !== undefined) {
              const rB = s.bars[i1].close / s.bars[ip].open - 1 - FEE;
              sB += rB; cB++;
              const d = {
                date, h, code: p.code, mv: p.mv, chg: p.chg, turnover: p.turnover,
                vwapGap: p.vwapGap, rB: +(rB * 100).toFixed(2),
              };
              // 次日冲高口径（仅记一次，与持有期无关）
              if (h === 1) {
                d.rHigh = +((s.bars[ip].high / s.bars[i0].close - 1 - FEE) * 100).toFixed(2);
                d.rHighOpen = +((s.bars[ip].high / s.bars[ip].open - 1 - FEE) * 100).toFixed(2);
                d.rNextOpen = +((s.bars[ip].open / s.bars[i0].close - 1) * 100).toFixed(2);
              }
              agg[k].detail.push(d);
            }
          }
          row.ret[`T+${h}`] = { close: cA ? sA / cA * 100 : null, open: cB ? sB / cB * 100 : null, n: cA };
        }
      }
      agg[k].days.push(row);
    }
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  const summary = {};
  for (const [k, cfg] of Object.entries(VARIANTS)) {
    const days = agg[k].days.filter((d) => d.n > 0);
    const o = { name: cfg.name, pickDays: days.length, obs: agg[k].detail.filter((d) => d.h === 1).length, byHold: {} };
    const h1 = agg[k].detail.filter((d) => d.h === 1 && d.rHigh != null);
    o.intraday = {
      n: h1.length,
      次日冲高_收盘买入: h1.length ? +mean(h1.map((d) => d.rHigh)).toFixed(2) : null,
      次日冲高_开盘买入: h1.length ? +mean(h1.map((d) => d.rHighOpen)).toFixed(2) : null,
      次日开盘跳空: h1.length ? +mean(h1.map((d) => d.rNextOpen)).toFixed(2) : null,
      冲高胜率: h1.length ? +(h1.filter((d) => d.rHigh > 0).length / h1.length * 100).toFixed(0) : null,
      冲高中位数: h1.length ? +med(h1.map((d) => d.rHigh)).toFixed(2) : null,
    };
    for (const h of HOLD) {
      const ro = days.map((d) => d.ret?.[`T+${h}`]?.open).filter((v) => v != null);
      const rc = days.map((d) => d.ret?.[`T+${h}`]?.close).filter((v) => v != null);
      const rb = days.map((d) => d.bench[`T+${h}`]).filter((v) => v != null);
      o.byHold[`T+${h}`] = {
        n: ro.length,
        收盘: rc.length ? +mean(rc).toFixed(2) : null,
        开盘: ro.length ? +mean(ro).toFixed(2) : null,
        中位: ro.length ? +med(ro).toFixed(2) : null,
        胜率: ro.length ? +(ro.filter((v) => v > 0).length / ro.length * 100).toFixed(0) : null,
        基准: rb.length ? +mean(rb).toFixed(2) : null,
        超额: ro.length ? +(mean(ro) - mean(rb)).toFixed(2) : null,
      };
    }
    summary[k] = o;
  }

  console.log('\n' + '═'.repeat(108));
  console.log(`对照实验  ${valid.length} 只池 / ${DAYS} 个交易日 / 次日开盘口径（已扣 ${FEE * 100}%）`);
  console.log('═'.repeat(108));
  console.log('变体'.padEnd(20) + '选股日'.padEnd(7) + '观测'.padEnd(6) + HOLD.map((h) => `T+${h}（超额）`.padEnd(19)).join(''));
  for (const [k, o] of Object.entries(summary)) {
    const cells = HOLD.map((h) => {
      const v = o.byHold[`T+${h}`];
      if (v.开盘 === null) return '—'.padEnd(19);
      return `${String(v.开盘).padStart(6)}% (${v.超额 > 0 ? '+' : ''}${v.超额})`.padEnd(19);
    });
    console.log(`${k} ${o.name}`.padEnd(20) + String(o.pickDays).padEnd(7) + String(o.obs).padEnd(6) + cells.join(''));
  }
  const b = summary.A.byHold;
  console.log('\n基准（中证1000，同期）：  ' + HOLD.map((h) => `T+${h} ${b[`T+${h}`].基准}%`).join('   '));

  console.log('\n' + '─'.repeat(108));
  console.log('次日冲高检验（T 日收盘买入 → T+1 盘中最高价卖出，理论上限）');
  console.log('─'.repeat(108));
  console.log('变体'.padEnd(20) + '样本'.padEnd(7) + '次日开盘跳空'.padEnd(14) + '冲高收益'.padEnd(12) + '冲高中位'.padEnd(11) + '冲高胜率');
  for (const [k, o] of Object.entries(summary)) {
    const it = o.intraday;
    if (!it.n) continue;
    console.log(`${k} ${o.name}`.padEnd(20) + String(it.n).padEnd(7) +
      `${it.次日开盘跳空 > 0 ? '+' : ''}${it.次日开盘跳空}%`.padEnd(14) +
      `${it.次日冲高_收盘买入 > 0 ? '+' : ''}${it.次日冲高_收盘买入}%`.padEnd(12) +
      `${it.冲高中位数 > 0 ? '+' : ''}${it.冲高中位数}%`.padEnd(11) +
      `${it.冲高胜率}%`);
  }

  fs.writeFileSync(path.join(OUT, 'backtest-v3.json'), JSON.stringify({ days: DAYS, pool: valid.length, summary, variants: VARIANTS, detail: agg }, null, 1));
  console.log(`\n→ ${path.join(OUT, 'backtest-v3.json')}`);
})();
