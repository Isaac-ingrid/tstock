/**
 * macro_gate.js —— Node 选股引擎统一的「第一步：顺天时 + 相对大盘抗跌 RS + 主线识别」模块
 *
 * 与后端 Python (backend/patterns.py + backend/limitup.py + backend/ignition.py) 保持 100% 同口径：
 *   1. 实时拉取上证指数 (sh000001) 与中证1000 (sh000852) 日 K 线（腾讯免 WAF 接口）；
 *   2. 计算 MA5/10/20/60 均线结构（UPTREND / RANGE / DOWNTREND）、BOLL(20,2) 上中下轨、MACD(12,26,9) 顶底背离；
 *   3. 输出统一环境等级（OK / WARN / BAD）与起爆/尾盘三档门禁（BULL_NORMAL / RANGE_SELECTIVE / BEAR_STRICT）；
 *   4. 计算个股相对上证 1 日 / 5 日超额收益 (rs1d / rs5d) 与站稳 MA20 逆势活口标记。
 */
const fs = require('fs');
const path = require('path');
const { fetchDailyKline } = require('./vwap');

function calcMean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calcEmaSeries(vals, period) {
  if (!vals.length) return [];
  const k = 2 / (period + 1);
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) {
    out.push(vals[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function analyzeIndexBars(bars) {
  if (!Array.isArray(bars) || bars.length < 25) {
    return { ok: false };
  }
  const closes = bars.map((b) => +b.close || 0);
  const highs = bars.map((b) => +b.high || 0);
  const lows = bars.map((b) => +b.low || 0);
  const n = closes.length;
  const cur = closes[n - 1];
  const prev = n >= 2 ? closes[n - 2] : cur;
  const c5 = n >= 6 ? closes[n - 6] : closes[0];

  const ma5 = calcMean(closes.slice(-5));
  const ma10 = calcMean(closes.slice(-10));
  const ma20 = calcMean(closes.slice(-20));
  const ma20Prev = n >= 21 ? calcMean(closes.slice(-21, -1)) : ma20;
  const ma60 = n >= 60 ? calcMean(closes.slice(-60)) : ma20;

  // BOLL(20, 2)
  const win20 = closes.slice(-20);
  const variance = calcMean(win20.map((v) => (v - ma20) ** 2));
  const std20 = Math.sqrt(variance);
  const bollUpper = +(ma20 + 2 * std20).toFixed(2);
  const bollLower = +(ma20 - 2 * std20).toFixed(2);
  const pctB = bollUpper > bollLower ? +(((cur - bollLower) / (bollUpper - bollLower)) * 100).toFixed(1) : 50;

  // MACD(12, 26, 9) 与顶底背离
  let topDivergence = false;
  let bottomDivergence = false;
  if (n >= 34) {
    const ema12 = calcEmaSeries(closes, 12);
    const ema26 = calcEmaSeries(closes, 26);
    const dif = closes.map((_, i) => ema12[i] - ema26[i]);
    const dea = calcEmaSeries(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);

    const startSw = Math.max(10, n - 48);
    const endPrev = n - 5;
    let hiIdx = -1;
    let loIdx = -1;
    for (let i = startSw; i < endPrev; i++) {
      if (highs[i] >= highs[i - 1] && highs[i] >= highs[i + 1]) {
        if (hiIdx < 0 || highs[i] > highs[hiIdx]) hiIdx = i;
      }
      if (lows[i] <= lows[i - 1] && lows[i] <= lows[i + 1]) {
        if (loIdx < 0 || lows[i] < lows[loIdx]) loIdx = i;
      }
    }
    const curHi = Math.max(...highs.slice(-3));
    const curDifHi = Math.max(...dif.slice(-3));
    if (hiIdx >= 0 && curHi >= highs[hiIdx] * 0.996 && dif[hiIdx] > 0 && curDifHi < dif[hiIdx] * 0.90 && hist[n - 1] <= hist[n - 2]) {
      topDivergence = true;
    }
    const curLo = Math.min(...lows.slice(-3));
    const curDifLo = Math.min(...dif.slice(-3));
    if (loIdx >= 0 && curLo <= lows[loIdx] * 1.006 && dif[loIdx] < 0 && curDifLo > dif[loIdx] * 0.88 && hist[n - 1] >= hist[n - 2]) {
      bottomDivergence = true;
    }
  }

  let structure = 'RANGE';
  let structureLabel = '震荡结构';
  if (cur >= ma20 && ma5 >= ma10 * 0.997 && ma20 >= ma20Prev * 0.999) {
    structure = 'UPTREND';
    structureLabel = '上升结构';
  } else if (cur < ma20 * 0.997 && (ma5 < ma20 || cur < ma60)) {
    structure = 'DOWNTREND';
    structureLabel = '下跌结构';
  }

  return {
    ok: true,
    close: +cur.toFixed(2),
    chg1d: prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(2) : 0,
    chg5d: c5 > 0 ? +(((cur - c5) / c5) * 100).toFixed(2) : 0,
    ma5: +ma5.toFixed(2),
    ma10: +ma10.toFixed(2),
    ma20: +ma20.toFixed(2),
    ma60: +ma60.toFixed(2),
    vsMa20: +(((cur / ma20) - 1) * 100).toFixed(2),
    below20: cur < ma20,
    below60: cur < ma60,
    bollUpper,
    bollMid: +ma20.toFixed(2),
    bollLower,
    pctB,
    topDivergence,
    bottomDivergence,
    structure,
    structureLabel,
  };
}

/**
 * 实时评估上证指数 + 中证1000 双锚天时闸门（绝不再因缺少当日 plan-*.json 而降级为 UNKNOWN 盲放行）
 */
async function evaluateLiveMacroGate(arg = {}) {
  const { date = null } = typeof arg === 'string' ? { date: arg } : (arg || {});
  const targets = [
    { key: '上证指数', code: 'sh000001', role: '大盘核心锚' },
    { key: '中证1000', code: 'sh000852', role: '中小盘弹性锚' },
  ];

  const dual = await Promise.all(
    targets.map(async (t) => {
      try {
        const raw = await fetchDailyKline(t.code, 85);
        const bars = Array.isArray(raw) ? (date ? raw.filter((b) => b.date <= date) : raw) : [];
        return { ...t, ...analyzeIndexBars(bars) };
      } catch {
        return { ...t, ok: false };
      }
    })
  );

  const sh = dual.find((x) => x.code === 'sh000001') || { ok: false };
  const zz = dual.find((x) => x.code === 'sh000852') || { ok: false };

  const isBad = (x) => Boolean(x?.ok && ((x.below20 && x.below60) || (x.structure === 'DOWNTREND' && x.chg5d <= -1.8)));
  const isWarn = (x) => Boolean(x?.ok && (x.below20 || x.structure === 'DOWNTREND' || x.topDivergence));

  let level = 'OK';
  let regimeMode = 'BULL_NORMAL';
  let regimeLabel = '🔥 大盘顺势·常态出击';
  let text = '上证与中证1000 均站稳 MA20 上升/强势结构，可顺势围绕主线执行';

  if (sh.ok || zz.ok) {
    if ((sh.ok && sh.structure === 'DOWNTREND' && sh.below60) || (isBad(sh) && isBad(zz)) || isBad(zz)) {
      level = 'BAD';
      regimeMode = 'BEAR_STRICT';
      regimeLabel = sh.bottomDivergence ? '🎯 指数底背离·逆势严选' : '🛡️ 大盘下行·逆势严选';
      text = sh.bottomDivergence
        ? `上证处于下跌结构但现日线底背离（5日 ${sh.chg5d >= 0 ? '+' : ''}${sh.chg5d}%）→ 逆势严选活口，仅限轻仓试错`
        : `指数处于下跌结构/破位下行（上证5日 ${sh.chg5d ?? 0}%）→ 开启天时严选硬过滤，禁盲目潜伏`;
    } else if (sh.structure === 'DOWNTREND' || isWarn(sh) || isWarn(zz)) {
      level = 'WARN';
      regimeMode = sh.structure === 'DOWNTREND' ? 'BEAR_STRICT' : 'RANGE_SELECTIVE';
      regimeLabel = regimeMode === 'BEAR_STRICT' ? '🛡️ 大盘下行·逆势严选' : '⚖️ 大盘震荡·去弱留强';
      text = sh.topDivergence
        ? '指数出现日线顶背离信号 → 仓位减半、禁追高，严防冲高回落'
        : `上证处于${sh.structureLabel || '震荡/回调'}（MA20 ${sh.ma20 || '—'}）→ 仓位减半、去弱留强`;
    }
  } else {
    level = 'WARN';
    regimeMode = 'RANGE_SELECTIVE';
    regimeLabel = '⚖️ 指数离线·防守严选';
    text = '指数日K暂不可达，默认按分歧防守标准提高入选门槛';
  }

  const posFactor = level === 'OK' ? 1 : level === 'WARN' ? 0.5 : 0;
  const channelMode = level === 'OK' ? 'UP' : 'DOWN';
  const channelGuide =
    channelMode === 'UP'
      ? '上升通道：逢缩量回调顺势介入前排主线，沿 MA5/MA10 守住趋势'
      : '下跌/弱势通道：大势不对操作白费！严卡相对大盘超额抗跌 RS，次日不强果断离场';

  return {
    level,
    regimeMode,
    regimeLabel,
    text,
    posFactor,
    channelMode,
    channelGuide,
    idx: sh.close || null,
    ma20: sh.ma20 || null,
    ma60: sh.ma60 || null,
    shChg1d: sh.chg1d || 0,
    shChg5d: sh.chg5d || 0,
    zzChg1d: zz.chg1d || 0,
    zzChg5d: zz.chg5d || 0,
    structure: sh.structure || 'RANGE',
    structureLabel: sh.structureLabel || '震荡结构',
    shStructure: sh.structure || 'RANGE',
    shStructureLabel: sh.structureLabel || '震荡结构',
    bollUpper: sh.bollUpper || null,
    bollLower: sh.bollLower || null,
    topDivergence: Boolean(sh.topDivergence),
    bottomDivergence: Boolean(sh.bottomDivergence),
    dual,
  };
}

/**
 * 提取今日主线板块名称集合（结合抱团池快照 + 全市场实时板块领涨强度）
 */
function resolveMainThemeSectors(allRows = []) {
  const mainSet = new Set();
  const herdPath = path.join(__dirname, '..', 'data', 'herd_pool.json');
  if (fs.existsSync(herdPath)) {
    try {
      const hp = JSON.parse(fs.readFileSync(herdPath, 'utf8'));
      const clusters = hp.clusters || hp.themes || hp.boards || [];
      for (const c of clusters) {
        const nm = String(c.name || c.theme || c.board || '').trim();
        if (nm && (c.days >= 2 || (c.count || c.ztCount || 0) >= 2 || (c.score || 0) >= 70)) {
          mainSet.add(nm);
        }
      }
    } catch {}
  }

  // 从实时快照按板块聚合强涨股数量，前 5 大强势容量板块纳入今日主线
  const secMap = new Map();
  for (const r of allRows || []) {
    const sec = String(r.sector || r.hybk || '').trim();
    if (!sec || sec === '-' || sec === '其他') continue;
    let st = secMap.get(sec);
    if (!st) {
      st = { name: sec, count: 0, strongCnt: 0, ztCnt: 0, amtYi: 0 };
      secMap.set(sec, st);
    }
    st.count += 1;
    if ((r.chgPct || 0) >= 5) st.strongCnt += 1;
    if ((r.chgPct || 0) >= 9.5) st.ztCnt += 1;
    st.amtYi += (r.amount || 0) / 1e8;
  }
  const ranked = Array.from(secMap.values())
    .filter((s) => s.strongCnt >= 2 && s.amtYi >= 30)
    .sort((a, b) => (b.ztCnt * 3 + b.strongCnt) - (a.ztCnt * 3 + a.strongCnt))
    .slice(0, 5);
  ranked.forEach((s) => mainSet.add(s.name));
  return mainSet;
}

/**
 * 计算单只标的相对上证指数的超额抗跌强度 (RS) 与均线防守状态
 */
function computeStockMacroMetrics(bars, curPrice, curChgPct, macroEnv) {
  if (!Array.isArray(bars) || bars.length < 6) {
    return {
      chg5d: +(curChgPct || 0).toFixed(2),
      rs5d: +((curChgPct || 0) - (macroEnv?.shChg5d || 0)).toFixed(2),
      rs1d: +((curChgPct || 0) - (macroEnv?.shChg1d || 0)).toFixed(2),
      ma5: 0,
      ma20: 0,
      aboveMa20: true,
      isResilient: false,
      rightSideConfirm: false,
    };
  }
  const lastBar = bars.at(-1) || {};
  const px = +(curPrice || lastBar.close || 0);
  const openPx = +(lastBar.open || px);
  const closes = bars.map((b) => +b.close || 0);
  const ref5 = closes.length >= 6 ? closes[closes.length - 6] : closes[0];
  const chg5d = ref5 > 0 ? +(((px - ref5) / ref5) * 100).toFixed(2) : +(curChgPct || 0).toFixed(2);
  const ma5 = +calcMean(closes.slice(-5)).toFixed(2);
  const ma20 = closes.length >= 20 ? +calcMean(closes.slice(-20)).toFixed(2) : +calcMean(closes).toFixed(2);
  const aboveMa20 = ma20 > 0 ? px >= ma20 * 0.995 : true;
  const rs5d = +(chg5d - (macroEnv?.shChg5d || 0)).toFixed(2);
  const rs1d = +((curChgPct || 0) - (macroEnv?.shChg1d || 0)).toFixed(2);
  const isResilient = Boolean(aboveMa20 && rs5d >= 2.5 && rs1d >= 1.0);
  const rightSideConfirm = Boolean(ma5 > 0 && px >= ma5 * 0.998 && px >= openPx && (curChgPct || 0) >= 0.8);
  return { chg5d, rs5d, rs1d, ma5, ma20, aboveMa20, isResilient, rightSideConfirm };
}

module.exports = {
  analyzeIndexBars,
  evaluateLiveMacroGate,
  resolveMainThemeSectors,
  computeStockMacroMetrics,
};
