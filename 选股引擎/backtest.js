/**
 * backtest.js v4 —— 六步法完整体回溯 + 真实摩擦成本 + 可成交性校验 + K线形态风控对照实验
 *
 * 相对 v3 的核心修复与升级：
 *  1. 消除历史市值未来函数：用「当日成交额 ÷ 当日换手率」还原历史流通市值（缺失时按前复权价比例反推），
 *     不再拿今日静态 s.mv 过滤 60 天前的历史交易日。
 *  2. 区分板块涨跌幅（主板10% / 创业板科创板20% / 北交所30% / ST 5%），修复 hasLimitUp 写死 9.65% 的问题。
 *  3. A 股可成交性校验：
 *     - T+1 开盘一字涨停或直接顶涨停价 → 判定买不进（blockedBuy），不计入幻想成交；
 *     - 卖出日 T+h 收盘封死跌停 → 判定当日卖不出，自动顺延至首个开板/非跌停交易日平仓（delayedExit）。
 *  4. 真实双边税费与盘口滑点模型（可传参覆盖）：
 *     - 卖出印花税 0.05% + 双向佣金 0.025%×2 + 双向过户费 0.001%×2 + 双向滑点 0.15%×2 ≈ 0.402%。
 *  5. 新增 A 股 K 线风控对照实验（与 backend/patterns.py 同口径）：
 *     - 顶部岛形反转（1~15日悬空孤岛 + 60日高位 + 右侧向下跳空未回补）
 *     - 高位天量避雷针 / 高位放量阴包阳
 *
 * 六个对照变体：
 *   A 基线          ①②③④⑤
 *   B +VWAP         ①②③④⑤⑥
 *   C +环境         ①②③④⑤ ＋ 中证1000 收盘在 MA20 上方
 *   D +VWAP+环境    ①②③④⑤⑥ ＋ MA20 上方
 *   E +K线风控      ①②③④⑤ ＋ 剔除顶部岛形反转/高位避雷针/阴包阳
 *   F 全开          ①②③④⑤⑥ ＋ MA20 上方 ＋ K线风控
 *
 * 用法：
 *   node backtest.js [--days 60] [--slip 0.0015] [--comm 0.00025] [--stamp 0.0005]
 *   node backtest.js --self-test   # 离线单元测试（不请求外网）
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const OUT = path.join(__dirname, 'out');
const HOLD = [1, 2, 3, 5];

const arg = (k, d) => (process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d);
const DAYS = arg('--days', 60);

/* ---------------- 真实双边税费与滑点参数 ---------------- */
const COST_CFG = {
  stampTax: arg('--stamp', 0.0005),      // 卖出印花税 0.05%
  commission: arg('--comm', 0.00025),    // 单边佣金 0.025%
  transferFee: arg('--transfer', 0.00001), // 单边过户费 0.001%
  slippage: arg('--slip', 0.0015),       // 单边盘口滑点 0.15%
};
const BUY_FEE = COST_CFG.commission + COST_CFG.transferFee;
const SELL_FEE = COST_CFG.stampTax + COST_CFG.commission + COST_CFG.transferFee;
const TOTAL_ROUNDTRIP_COST = BUY_FEE + SELL_FEE + COST_CFG.slippage * 2;

const secid = (code) => (code.startsWith('sh') ? '1.' : '0.') + code.replace(/^(sh|sz|bj)/, '');

function boardOf(code) {
  const c = String(code || '').replace(/^(sh|sz|bj)/, '');
  if (c.startsWith('688') || c.startsWith('689')) return '科创板';
  if (/^(300|301|302)/.test(c)) return '创业板';
  if (/^(4|8|920)/.test(c)) return '北交所';
  return '主板';
}

const LIMIT_OF = { 主板: 10, 创业板: 20, 科创板: 20, 北交所: 30 };

function limitPctOf(code, name = '') {
  if (/ST/i.test(String(name || ''))) return 5;
  return LIMIT_OF[boardOf(code)] ?? 10;
}

function isOneWordLimitBar(bar, prevClose, effLimit) {
  if (!(prevClose > 0)) return false;
  if (Math.abs(bar.high - bar.low) > Math.max(0.005, prevClose * 0.001)) return false;
  const pct = Math.abs((bar.close / prevClose - 1) * 100);
  return pct >= effLimit - 0.6;
}

/**
 * 动态估算历史交易日市值（亿），避免使用今日静态市值造成未来函数：
 * 优先使用「当日成交额 ÷ 当日换手率」还原历史流通市值；缺失时按前复权价格比例反推总市值。
 */
function estimateHistoricalMvYi(bar, latestClose, staticMvYi) {
  if (bar.turnover > 0.05 && bar.amount > 0) {
    return bar.amount / (bar.turnover / 100) / 1e8;
  }
  if (staticMvYi > 0 && latestClose > 0 && bar.close > 0) {
    return staticMvYi * (bar.close / latestClose);
  }
  return staticMvYi || 0;
}

/**
 * 含真实税费与双边滑点的净收益率计算
 */
function calcNetReturn(rawBuyPx, rawSellPx, cfg = COST_CFG) {
  if (!(rawBuyPx > 0) || !(rawSellPx > 0)) return null;
  const execBuy = rawBuyPx * (1 + cfg.slippage);
  const execSell = rawSellPx * (1 - cfg.slippage);
  const buyFee = cfg.commission + cfg.transferFee;
  const sellFee = cfg.stampTax + cfg.commission + cfg.transferFee;
  return (execSell * (1 - sellFee)) / (execBuy * (1 + buyFee)) - 1;
}

/**
 * T+1 开盘买入可成交性校验：开盘直接封死涨停 / 一字涨停判为买不进
 */
function canBuyAtNextOpen(prevBar, nextBar, effLimit) {
  if (!prevBar || !nextBar || !(prevBar.close > 0) || !(nextBar.open > 0)) return false;
  const openChg = (nextBar.open / prevBar.close - 1) * 100;
  if (openChg >= effLimit - 0.35) return false;
  if (isOneWordLimitBar(nextBar, prevBar.close, effLimit) && nextBar.close > prevBar.close) return false;
  return true;
}

/**
 * 卖出日跌停不可成交校验：若原定卖出日收盘封死跌停，向后顺延至首个非跌停交易日平仓
 */
function findExecutableExitIdx(bars, targetIdx, effLimit, maxDelay = 5) {
  if (targetIdx === undefined || targetIdx < 1 || targetIdx >= bars.length) {
    return { exitIdx: null, delayed: false };
  }
  const end = Math.min(bars.length - 1, targetIdx + maxDelay);
  for (let idx = targetIdx; idx <= end; idx++) {
    const b = bars[idx];
    const pc = bars[idx - 1]?.close || 0;
    const chg = pc > 0 ? (b.close / pc - 1) * 100 : b.chg;
    const isLimitDownSealed = chg <= -(effLimit - 0.35) && Math.abs(b.close - b.low) < Math.max(0.005, pc * 0.001);
    if (!isLimitDownSealed) {
      return { exitIdx: idx, delayed: idx > targetIdx };
    }
  }
  return { exitIdx: end, delayed: end > targetIdx };
}

/* ---------------- A股 K 线风控过滤器（与 backend/patterns.py 同口径） ---------------- */
function calcAtrAt(bars, endIdx, period = 14) {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let cnt = 0;
  for (let k = start; k <= endIdx; k++) {
    const pc = bars[k - 1].close;
    const tr = Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - pc), Math.abs(bars[k].low - pc));
    sum += tr;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

function pricePercentile60(bars, endIdx, price) {
  const start = Math.max(0, endIdx - 59);
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = start; k <= endIdx; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  if (!(hi > lo)) return 50;
  return Math.max(0, Math.min(100, ((price - lo) / (hi - lo)) * 100));
}

function avgVolBefore(bars, endIdx, period = 5) {
  const start = Math.max(0, endIdx - period);
  let sum = 0;
  let cnt = 0;
  for (let k = start; k < endIdx; k++) {
    sum += bars[k].vol;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

/**
 * 检查截至 idx 是否触发高危顶部 K 线结构：
 * 1. 顶部岛形反转（1~15 日悬空孤岛 + 60日高位>=60% + 右侧向下跳空未回补）
 * 2. 高位天量避雷针（60日高位>=70% + 长上影>=2x实体 + 放量>=1.6x）
 * 3. 高位放量阴包阳（60日高位>=65% + 实体吞没前阳 + 放量）
 */
function detectBearishKlineRisk(bars, idx, effLimit) {
  const reasons = [];
  if (idx < 10) return { risky: false, reasons };

  // 1) 顶部岛形反转（检测近 5 个交易日内出现的未回补向下跳空 + 左侧配对向上跳空）
  const lookStart = Math.max(1, idx - 25);
  const gaps = [];
  for (let k = lookStart; k <= idx; k++) {
    const prev = bars[k - 1];
    const cur = bars[k];
    const pc = prev.close;
    if (!(pc > 0) || isOneWordLimitBar(cur, pc, effLimit)) continue;
    const atr = calcAtrAt(bars, k - 1, 14);
    const minGap = Math.max(pc * 0.005, 0.3 * atr);
    if (cur.low > prev.high && cur.low - prev.high >= minGap) {
      gaps.push({ k, dir: 'up', low: prev.high, high: cur.low });
    } else if (cur.high < prev.low && prev.low - cur.high >= minGap) {
      let filled = false;
      for (let j = k + 1; j <= idx; j++) {
        if (bars[j].high >= prev.low) { filled = true; break; }
      }
      gaps.push({ k, dir: 'down', low: cur.high, high: prev.low, filled });
    }
  }

  for (let r = gaps.length - 1; r >= 0; r--) {
    const right = gaps[r];
    if (idx - right.k > 5) break;
    if (right.dir !== 'down' || right.filled) continue;
    for (let l = r - 1; l >= 0; l--) {
      const left = gaps[l];
      const span = right.k - left.k;
      if (left.dir !== 'up' || span < 1 || span > 15) continue;
      let islandMin = Infinity;
      let islandMax = -Infinity;
      for (let m = left.k; m < right.k; m++) {
        if (bars[m].low < islandMin) islandMin = bars[m].low;
        if (bars[m].high > islandMax) islandMax = bars[m].high;
      }
      const barrier = Math.max(bars[left.k - 1].high, bars[right.k].high);
      if (islandMin > barrier && pricePercentile60(bars, right.k, islandMax) >= 60) {
        reasons.push('TOP_ISLAND');
        break;
      }
    }
    if (reasons.includes('TOP_ISLAND')) break;
  }

  // 2) 高位天量避雷针（近 2 日）
  for (const k of [idx, idx - 1]) {
    if (k < 5) continue;
    const b = bars[k];
    const pc = bars[k - 1].close;
    const rng = b.high - b.low;
    if (!(pc > 0) || !(rng > 0) || isOneWordLimitBar(b, pc, effLimit)) continue;
    const body = Math.abs(b.close - b.open);
    const upper = b.high - Math.max(b.open, b.close);
    const mv5 = avgVolBefore(bars, k, 5);
    if (
      pricePercentile60(bars, k, b.high) >= 70 &&
      upper >= 2 * Math.max(body, pc * 0.005) &&
      upper / rng >= 0.5 &&
      (upper / pc) * 100 >= 2.5 &&
      mv5 > 0 && b.vol / mv5 >= 1.6
    ) {
      reasons.push('HIGH_GRAVESTONE');
      break;
    }
  }

  // 3) 高位放量阴包阳
  const cur = bars[idx];
  const prev = bars[idx - 1];
  const pc = prev.close;
  if (pc > 0 && !isOneWordLimitBar(cur, pc, effLimit)) {
    const mv5 = avgVolBefore(bars, idx, 5);
    const bodyDropPct = ((cur.open - cur.close) / pc) * 100;
    const volExpand = (prev.vol > 0 && cur.vol >= prev.vol * 1.3) || (mv5 > 0 && cur.vol >= mv5 * 1.4);
    if (
      prev.close > prev.open &&
      cur.close < cur.open &&
      cur.open >= prev.close * 0.998 &&
      cur.close <= prev.open * 1.002 &&
      bodyDropPct >= 2.0 &&
      pricePercentile60(bars, idx, Math.max(cur.high, prev.high)) >= 65 &&
      volExpand
    ) {
      reasons.push('BEARISH_ENGULFING');
    }
  }

  return { risky: reasons.length > 0, reasons };
}

function hasLimitUp(bars, i, effLimit, lookback = 30) {
  for (let k = Math.max(1, i - lookback); k < i; k++) {
    const pc = bars[k - 1].close;
    const chg = pc > 0 ? (bars[k].close / pc - 1) * 100 : bars[k].chg;
    if (chg >= effLimit - 0.35 && Math.abs(bars[k].close - bars[k].high) < Math.max(0.005, pc * 0.001)) {
      return true;
    }
  }
  return false;
}

/* ---------------- 网络与并发池 ---------------- */
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
        vwap: +f[5] > 0 ? +f[6] / (+f[5] * 100) : +f[2],
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

/* ---------------- 离线自检模式 (--self-test) ---------------- */
function runSelfTest() {
  // 1. 历史市值动态估算测试（成交额 5 亿，换手率 5% => 流通市值 100 亿）
  const mv1 = estimateHistoricalMvYi({ amount: 5e8, turnover: 5, close: 10 }, 20, 250);
  assert.strictEqual(Math.round(mv1), 100, '应优先使用当日成交额/换手率还原历史市值');
  const mv2 = estimateHistoricalMvYi({ amount: 0, turnover: 0, close: 10 }, 20, 200);
  assert.strictEqual(Math.round(mv2), 100, '换手缺失时应按前复权价比例反推历史市值');

  // 2. 涨停买不进与跌停卖出顺延测试
  assert.strictEqual(canBuyAtNextOpen({ close: 10 }, { open: 11.0, high: 11.0, low: 11.0, close: 11.0 }, 10), false);
  assert.strictEqual(canBuyAtNextOpen({ close: 10 }, { open: 10.2, high: 10.8, low: 10.1, close: 10.6 }, 10), true);

  const exitBars = [
    { close: 10.0, low: 9.8, chg: 0 },
    { close: 9.0, low: 9.0, chg: -10.0 },   // T+1 封死跌停卖不出
    { close: 8.5, low: 8.4, chg: -5.56 },   // T+2 打开跌停可卖出
  ];
  const ex = findExecutableExitIdx(exitBars, 1, 10);
  assert.strictEqual(ex.exitIdx, 2);
  assert.strictEqual(ex.delayed, true);

  // 3. 真实双边税费与滑点计算测试（平价进出应亏损约 0.402%）
  const flatRet = calcNetReturn(10, 10, { stampTax: 0.0005, commission: 0.00025, transferFee: 0.00001, slippage: 0.0015 });
  assert.ok(flatRet < -0.0039 && flatRet > -0.0042, `平价进出净收益应约 -0.40%，实际 ${flatRet}`);

  // 4. 顶部岛形反转风控识别测试
  const bars = [];
  let px = 10.0;
  for (let i = 0; i < 42; i++) {
    const o = px;
    const c = +(px + 0.12).toFixed(2);
    bars.push({ open: o, close: c, high: +(c + 0.08).toFixed(2), low: +(o - 0.08).toFixed(2), vol: 10000, chg: 1.0 });
    px = c;
  }
  const base = +(bars.at(-1).high + 0.8).toFixed(2);
  bars.push({ open: base + 0.1, close: base + 0.3, high: base + 0.4, low: base, vol: 20000, chg: 4.5 });
  bars.push({ open: base + 0.25, close: base + 0.15, high: base + 0.35, low: base + 0.05, vol: 16000, chg: -1.0 });
  const dropH = +(base - 0.55).toFixed(2);
  bars.push({ open: dropH - 0.05, close: dropH - 0.35, high: dropH, low: dropH - 0.45, vol: 22000, chg: -5.0 });
  const risk = detectBearishKlineRisk(bars, bars.length - 1, 10);
  assert.strictEqual(risk.risky, true);
  assert.ok(risk.reasons.includes('TOP_ISLAND'));

  console.log('✅ backtest.js v4 全部离线自检断言通过（历史市值/可成交性/真实滑点税费/顶部岛形反转）');
}

/* ---------------- 主回测流程 ---------------- */
async function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const pool = JSON.parse(fs.readFileSync(path.join(OUT, 'pool.json'), 'utf8'));
  console.log(
    `样本池 ${pool.length} 只｜回溯 ${DAYS} 个交易日｜双边摩擦成本 ${(TOTAL_ROUNDTRIP_COST * 100).toFixed(3)}%` +
    `（印花税${(COST_CFG.stampTax * 100).toFixed(2)}%+佣金${(COST_CFG.commission * 200).toFixed(3)}%+双边滑点${(COST_CFG.slippage * 200).toFixed(2)}%）\n拉取个股日K（东财）…`
  );
  const raw = await runPool(pool, async (s) => {
    const bars = await kline(s.code);
    return bars ? {
      ...s,
      effLimit: limitPctOf(s.code, s.name),
      latestClose: bars.at(-1).close,
      bars,
      pos: Object.fromEntries(bars.map((b, i) => [b.date, i])),
    } : null;
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
    A: { name: '基线（无过滤）', vwap: false, env: false, klineRisk: false },
    B: { name: '＋VWAP 过滤', vwap: true, env: false, klineRisk: false },
    C: { name: '＋环境过滤', vwap: false, env: true, klineRisk: false },
    D: { name: '＋VWAP＋环境', vwap: true, env: true, klineRisk: false },
    E: { name: '＋K线风控', vwap: false, env: false, klineRisk: true },
    F: { name: '全开（VWAP+环境+K线）', vwap: true, env: true, klineRisk: true },
  };
  const agg = {};
  for (const k of Object.keys(VARIANTS)) {
    agg[k] = { days: [], detail: [], stats: { blockedBuy: 0, delayedExit: 0, klineFiltered: 0 } };
  }
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
      const histMv = estimateHistoricalMvYi(b, s.latestClose, s.mv);
      if (!(histMv >= 30 && histMv <= 200)) continue;
      const vAvg = s.bars.slice(i - 5, i).reduce((a, c) => a + c.vol, 0) / 5;
      if (!(vAvg > 0 && b.vol / vAvg > 1)) continue;
      if (!(b.turnover >= 5 && b.turnover <= 10)) continue;
      if (!hasLimitUp(s.bars, i, s.effLimit)) continue;

      const vwapOk = b.close >= b.vwap * 1.005;
      const kRisk = detectBearishKlineRisk(s.bars, i, s.effLimit);
      const base = {
        code: s.code, name: s.name, chg: +b.chg.toFixed(2), turnover: b.turnover,
        vwapGap: +((b.close / b.vwap - 1) * 100).toFixed(2), mv: +histMv.toFixed(1),
        kRiskReasons: kRisk.reasons,
      };
      for (const [k, cfg] of Object.entries(VARIANTS)) {
        if (cfg.vwap && !vwapOk) continue;
        if (cfg.env && !envOk) continue;
        if (cfg.klineRisk && kRisk.risky) {
          agg[k].stats.klineFiltered++;
          continue;
        }
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
            const i0 = s.pos[date];
            const targetIdx = s.pos[cal[di + h]];
            if (targetIdx === undefined) continue;

            // 卖出日跌停顺延校验
            const { exitIdx, delayed } = findExecutableExitIdx(s.bars, targetIdx, s.effLimit);
            if (exitIdx === null) continue;
            if (delayed && h === 1) agg[k].stats.delayedExit++;

            // 理论收盘口径（含未来信息警示，仅作上界对照）
            const rA = calcNetReturn(s.bars[i0].close, s.bars[exitIdx].close);
            if (rA !== null) { sA += rA; cA++; }

            // 实盘可执行次日开盘口径（剔除 T+1 一字/顶板买不进）
            const ip = s.pos[cal[di + 1]];
            if (ip !== undefined) {
              if (!canBuyAtNextOpen(s.bars[i0], s.bars[ip], s.effLimit)) {
                if (h === 1) agg[k].stats.blockedBuy++;
                continue;
              }
              const rB = calcNetReturn(s.bars[ip].open, s.bars[exitIdx].close);
              if (rB === null) continue;
              sB += rB; cB++;
              const d = {
                date, h, code: p.code, mv: p.mv, chg: p.chg, turnover: p.turnover,
                vwapGap: p.vwapGap, rB: +(rB * 100).toFixed(2), delayedExit: delayed,
              };
              if (h === 1) {
                const rHigh = calcNetReturn(s.bars[i0].close, s.bars[ip].high);
                const rHighOpen = calcNetReturn(s.bars[ip].open, s.bars[ip].high);
                d.rHigh = rHigh !== null ? +(rHigh * 100).toFixed(2) : null;
                d.rHighOpen = rHighOpen !== null ? +(rHighOpen * 100).toFixed(2) : null;
                d.rNextOpen = +((s.bars[ip].open / s.bars[i0].close - 1) * 100).toFixed(2);
              }
              agg[k].detail.push(d);
            }
          }
          row.ret[`T+${h}`] = { close: cA ? (sA / cA) * 100 : null, open: cB ? (sB / cB) * 100 : null, n: cB };
        }
      }
      agg[k].days.push(row);
    }
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const med = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const summary = {};
  for (const [k, cfg] of Object.entries(VARIANTS)) {
    const days = agg[k].days.filter((d) => d.n > 0);
    const o = {
      name: cfg.name,
      pickDays: days.length,
      obs: agg[k].detail.filter((d) => d.h === 1).length,
      stats: agg[k].stats,
      byHold: {},
    };
    const h1 = agg[k].detail.filter((d) => d.h === 1 && d.rHigh != null);
    o.intraday = {
      n: h1.length,
      次日冲高_收盘买入: h1.length ? +mean(h1.map((d) => d.rHigh)).toFixed(2) : null,
      次日冲高_开盘买入: h1.length ? +mean(h1.map((d) => d.rHighOpen)).toFixed(2) : null,
      次日开盘跳空: h1.length ? +mean(h1.map((d) => d.rNextOpen)).toFixed(2) : null,
      冲高胜率: h1.length ? +((h1.filter((d) => d.rHigh > 0).length / h1.length) * 100).toFixed(0) : null,
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
        胜率: ro.length ? +((ro.filter((v) => v > 0).length / ro.length) * 100).toFixed(0) : null,
        基准: rb.length ? +mean(rb).toFixed(2) : null,
        超额: ro.length ? +(mean(ro) - mean(rb)).toFixed(2) : null,
      };
    }
    summary[k] = o;
  }

  console.log('\n' + '═'.repeat(118));
  console.log(`对照实验 v4  ${valid.length} 只池 / ${DAYS} 交易日 / 实盘次日开盘口径（双边税费+滑点 ${(TOTAL_ROUNDTRIP_COST * 100).toFixed(2)}%）`);
  console.log('═'.repeat(118));
  console.log('变体'.padEnd(24) + '选股日'.padEnd(7) + '成交'.padEnd(6) + '拦截(涨停/K线)'.padEnd(16) + HOLD.map((h) => `T+${h}（超额）`.padEnd(17)).join(''));
  for (const [k, o] of Object.entries(summary)) {
    const cells = HOLD.map((h) => {
      const v = o.byHold[`T+${h}`];
      if (v.开盘 === null) return '—'.padEnd(17);
      return `${String(v.开盘).padStart(6)}% (${v.超额 > 0 ? '+' : ''}${v.超额})`.padEnd(17);
    });
    const blk = `${o.stats.blockedBuy}/${o.stats.klineFiltered}`;
    console.log(`${k} ${o.name}`.padEnd(24) + String(o.pickDays).padEnd(7) + String(o.obs).padEnd(6) + blk.padEnd(16) + cells.join(''));
  }
  const b = summary.A.byHold;
  console.log('\n基准（中证1000，同期）：  ' + HOLD.map((h) => `T+${h} ${b[`T+${h}`].基准}%`).join('   '));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'backtest-v4.json'),
    JSON.stringify({ days: DAYS, pool: valid.length, costCfg: COST_CFG, summary, variants: VARIANTS, detail: agg }, null, 1)
  );
  console.log(`\n→ ${path.join(OUT, 'backtest-v4.json')}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  boardOf,
  limitPctOf,
  estimateHistoricalMvYi,
  calcNetReturn,
  canBuyAtNextOpen,
  findExecutableExitIdx,
  detectBearishKlineRisk,
  hasLimitUp,
};
