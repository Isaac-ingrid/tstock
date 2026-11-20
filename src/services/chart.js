/* ============================================================
   A股做T执行台 · Canvas 多周期手绘图表引擎 (chart.js)
   ============================================================ */

import { f2, f3, pct, money, fvol, calcTBreakeven, todayStr } from './utils.js';
import { maArr, bollArr, rsiArr, macdArr, m5Slot, calc, computeExperimentalATRGrid, computeExperimentalStockDNA } from './api.js';
import { pool } from './state.js';

/* ===================== 图表引擎（Canvas 手绘，零依赖 · 多周期） =====================
   周期：分时 / 1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K
   叠加：MA5/10/20/60、BOLL(20,2)、20日箱体、持仓成本、支撑压力位
   副图：成交量常显 + MACD / RSI 可切换
   配色遵循 A 股惯例：涨红跌绿。悬停显示该根的时间、OHLC 与各指标取值。 */
/* 图表配色：与 CSS 变量同源。涨红跌绿、线色对比度 ≥3:1（非文本标准），
   文字类（txt/mute）按 ≥4.5 取。注意 Canvas 读不到 CSS 变量，必须在这里同步改。 */
export const CH = { up:'#d32f2f', dn:'#0a7f42', grid:'#eef1f4', txt:'#515c69', mute:'#66707c',
             /* 均线 4 色：蓝 221° / 玫红 336° / 青 192° / 金 35° —— 两两色相 ≥35°，
                原来 MA10/均价/BOLL中轨/箱体/MA60 五条线全挤在 21°–46° 的橙黄区，图上一片橙。 */
             ma5:'#2563eb', ma10:'#c2185b', ma20:'#0891b2', ma60:'#a16207',
             /* BOLL 是一族：上/下轨与中轨同色相同族、只差一档明度，靠线型再分 */
             bollU:'#4f46e5', bollM:'#6366f1',
             /* 参考线各归其位：压力=深红 0°、成本=紫 262°、均价=青 193°，
                箱体与 VMA 都是中性参考，用同色相的一深一浅两档灰，避免完全同色 */
             sr:'#991b1b', cost:'#7c3aed', box:'#6b7280', avg:'#0e7490', vma:'#4b5563' };
export const _hover = {};                       // 每张图的悬停索引
export function setHover(id, idx) { _hover[id] = idx; }
export const OV_DEF = { ma:'均线', boll:'BOLL', box:'箱体', cost:'成本', sr:'支撑压力' };
export const SUB_DEF = { macd:'MACD', rsi:'RSI' };
export const OV_RT_DEF = {
  book: '五档盘口',
  bench: '大盘对比',
  cost: '持仓成本',
  be: '做T保本',
  zones: '推荐买卖带',
  signal: '推荐买卖点',
  actual: '实盘买卖',
  radar: '防出货雷达'
};

/**
 * 将 HHMM（如 "0930"、"1130"、"1300"、"1500"）映射为 A 股全天标准 241 分钟槽位 [0..240]
 * 09:30 -> 0, 10:30 -> 60, 11:30/13:00 -> 120, 14:00 -> 180, 15:00 -> 240
 */
export function hhmmToSlot241(hhmm) {
  const clean = String(hhmm || '').replace(':', '').trim().slice(0, 4);
  if (!/^\d{4}$/.test(clean)) return NaN;
  const mins = (+clean.slice(0, 2)) * 60 + (+clean.slice(2, 4));
  if (mins <= 570) return 0; // <= 09:30
  if (mins <= 690) return mins - 570; // 09:30 ~ 11:30 -> 0..120
  if (mins < 780) return 120; // 11:31 ~ 12:59 -> 120
  if (mins <= 900) return 120 + (mins - 780); // 13:00 ~ 15:00 -> 120..240
  return 240;
}

function _hhmmToPtIdx(pts, hhmm) {
  if (!hhmm || !pts || !pts.length) return -1;
  const targetSlot = hhmmToSlot241(hhmm);
  if (!Number.isFinite(targetSlot)) return -1;
  let bestIdx = -1;
  let bestDiff = 9999;
  for (let i = 0; i < pts.length; i++) {
    const pSlot = hhmmToSlot241(pts[i].t);
    if (!Number.isFinite(pSlot)) continue;
    const d = Math.abs(pSlot - targetSlot);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    }
  }
  return bestDiff <= 15 ? bestIdx : -1;
}

/**
 * 综合计算分时图上的三层买卖信号：
 * 1. zones: 规则+ATR 算出的计划买区/卖区/止损红线
 * 2. points: 盘中动态推荐买卖点（结合 ATR 步长、DNA 基因与量价止跌/滞涨，无需黑盒预测模型）
 * 3. actualMarkers: 台账 tradeLogs 中当日真实已成交买卖点
 */
export function computeRtTradeOverlays(s, pts, prev, tradeLogs = []) {
  const safePrev = prev > 0 ? prev : (pts[0]?.price || +s.prevClose || 0);
  let plan = null;
  let atrGrid = null;
  let dna = null;
  try { plan = calc(s); } catch (_) {}
  try { atrGrid = computeExperimentalATRGrid(s); } catch (_) {}
  try { dna = computeExperimentalStockDNA(s); } catch (_) {}

  const zones = {
    buyHi: plan && +plan.inA > 0 ? +plan.inA : 0,
    buyLo: plan && +plan.inB > 0 ? +plan.inB : 0,
    sellLo: plan && +plan.outA > 0 ? +plan.outA : 0,
    sellHi: plan && +plan.outB > 0 ? +plan.outB : 0,
    stopPx: plan && +plan.slA > 0 ? +plan.slA : 0,
    flyPx: plan && +plan.fly > 0 ? +plan.fly : 0,
    mode: plan?.mode || 'WAIT',
    atrStep: atrGrid ? atrGrid.adaptiveGrid : 1.33,
  };

  // 个股波动率 + 历史DNA 校准分时偏离触发门槛
  const baseBias = atrGrid ? Math.max(1.05, Math.min(2.6, atrGrid.adaptiveGrid * 1.25)) : 1.75;
  const highOpenSmash = !!(dna && dna.gapUpTotal >= 6 && dna.gapUpSmashRate >= 65);
  const weakVRebound = !!(dna && dna.dipTotal >= 6 && dna.dipWinRate <= 35);
  const buyBiasThresh = weakVRebound ? -(baseBias * 1.35) : -baseBias;
  const sellBiasThresh = highOpenSmash ? Math.max(1.25, baseBias * 0.90) : Math.max(1.55, baseBias * 1.12);

  const points = [];
  if (pts && pts.length >= 8) {
    let lastSignalIdx = -999;
    for (let i = 5; i < pts.length; i++) {
      if (i - lastSignalIdx < 12) continue;
      const p = pts[i];
      const pPrev = pts[i - 1];
      const pNext = pts[i + 1];
      const b = p.avg > 0 ? ((p.price - p.avg) / p.avg) * 100 : 0;

      // 连续单边破均线急跌防飞刀过滤
      const recentWindow = pts.slice(Math.max(0, i - 6), i + 1);
      const allBelowAvg = recentWindow.every(x => x.price < x.avg);
      const droppingFast = p.price < pts[i - 3].price * 0.996;
      const fallingKnifeGuard = allBelowAvg && droppingFast;

      const hitBuyZone = zones.buyHi > 0 && p.price <= zones.buyHi * 1.002 && p.price >= (zones.stopPx || 0) * 0.995;
      const hitBuyBias = b <= buyBiasThresh;
      const stabilizeUp = p.price >= pPrev.price * 0.999 && (!pNext || pNext.price >= p.price);

      if ((hitBuyZone || hitBuyBias) && stabilizeUp && (!fallingKnifeGuard || b <= buyBiasThresh * 1.25)) {
        const isLastLive = i === pts.length - 1;
        const parts = [];
        if (hitBuyZone) parts.push(`踩入买区≤¥${f2(zones.buyHi)}`);
        if (hitBuyBias) parts.push(`偏离均价${b.toFixed(2)}%`);
        parts.push(isLastLive ? '试探企稳(待下分钟确认)' : '缩量企稳');
        points.push({
          type: 'BUY',
          confirmed: !isLastLive,
          idx: i,
          t: p.t,
          px: p.price,
          bias: b,
          reason: parts.join('·'),
        });
        lastSignalIdx = i;
        continue;
      }

      const hitSellZone = zones.sellLo > 0 && p.price >= zones.sellLo * 0.998;
      const hitSellBias = b >= sellBiasThresh;
      const stallDown = p.price <= pPrev.price * 1.001 && (!pNext || pNext.price <= p.price);

      if ((hitSellZone || hitSellBias) && stallDown) {
        const isLastLive = i === pts.length - 1;
        const parts = [];
        if (hitSellZone) parts.push(`触及卖区≥¥${f2(zones.sellLo)}`);
        if (hitSellBias) parts.push(`偏离均价+${b.toFixed(2)}%`);
        if (highOpenSmash) parts.push('高开易回落基因');
        else parts.push(isLastLive ? '试探滞涨(待下分钟确认)' : '冲高滞涨');
        points.push({
          type: 'SELL',
          confirmed: !isLastLive,
          idx: i,
          t: p.t,
          px: p.price,
          bias: b,
          reason: parts.join('·'),
        });
        lastSignalIdx = i;
      }
    }
  }

  // 读取当日台账中该股实际买卖记录
  const code6 = String(s.code || '').padStart(6, '0');
  const tDay = todayStr();
  const actualMarkers = [];
  (tradeLogs || []).forEach((lg) => {
    if (!lg || lg.date !== tDay) return;
    const matchCode = lg.code ? String(lg.code).padStart(6, '0') === code6 : String(lg.stock || '').includes(code6);
    if (!matchCode) return;
    const timeIdx = _hhmmToPtIdx(pts, lg.time);
    const matchPtIdx = (px) => (
      timeIdx >= 0 && pts[timeIdx] && px > 0 && Math.abs(pts[timeIdx].price - px) / px <= 0.018
        ? timeIdx
        : -1
    );
    if (+lg.buy > 0) {
      const bpx = +lg.buy;
      const matchedIdx = matchPtIdx(bpx);
      actualMarkers.push({
        side: 'B',
        px: bpx,
        time: matchedIdx >= 0 ? (lg.time || '') : '',
        idx: matchedIdx,
        dir: lg.dir || '买入',
        qty: +lg.qty || 0,
      });
    }
    if (+lg.sell > 0) {
      const spx = +lg.sell;
      const matchedIdx = matchPtIdx(spx);
      actualMarkers.push({
        side: 'S',
        px: spx,
        time: matchedIdx >= 0 ? (lg.time || '') : '',
        idx: matchedIdx,
        dir: lg.dir || '卖出',
        qty: +lg.qty || 0,
      });
    }
  });

  const lastPt = pts && pts.length ? pts[pts.length - 1] : null;
  const curPx = lastPt ? lastPt.price : (+s.price || safePrev);
  const distToBuyPct = zones.buyHi > 0 && curPx > 0 ? ((zones.buyHi - curPx) / curPx) * 100 : null;
  const distToSellPct = zones.sellLo > 0 && curPx > 0 ? ((zones.sellLo - curPx) / curPx) * 100 : null;

  return {
    zones,
    points,
    actualMarkers,
    dna,
    atrGrid,
    buyBiasThresh: Math.round(buyBiasThresh * 100) / 100,
    sellBiasThresh: Math.round(sellBiasThresh * 100) / 100,
    distToBuyPct,
    distToSellPct,
    outOfView: [],
  };
}

/**
 * 主力出货风险雷达（分时量化诊断）
 * 捕捉：1. 均线破位反压；2. 脉冲诱多（钓鱼波）；3. 高位放量滞涨；4. 均线上方健康承接
 */
export function analyzeIntradayDistribution(pts, prev, stock) {
  if (!pts || pts.length < 5) {
    return {
      status: 'normal',
      level: 'normal',
      title: '🟡 分时数据累计中',
      badge: '🟡 数据积累中',
      color: '#64748b',
      bg: '#f8fafc',
      border: '#cbd5e1',
      desc: '分时分钟数据较少，正在持续累计盘口形态…',
      bias: 0
    };
  }

  const last = pts[pts.length - 1];
  const pxNow = last.price;
  const avgNow = last.avg;
  const bias = avgNow > 0 ? ((pxNow - avgNow) / avgNow) * 100 : 0;

  // 1. 均线破位反压 (VWAP Breakdown & Resistance)
  const recentLen = Math.min(pts.length, 20);
  const recentPts = pts.slice(-recentLen);
  const belowCount = recentPts.filter(p => p.price < p.avg).length;
  const belowRatio = belowCount / recentLen;

  let hasFailedRebound = false;
  for (let i = 1; i < recentPts.length; i++) {
    const prevPt = recentPts[i - 1];
    const curPt = recentPts[i];
    if (Math.abs(prevPt.price - prevPt.avg) / prevPt.avg < 0.0035 && curPt.price < prevPt.price && curPt.price < curPt.avg) {
      hasFailedRebound = true;
      break;
    }
  }

  // 2. 脉冲诱多检测 (Spike Trap)
  let hasSpikeTrap = false;
  let spikeDesc = '';
  for (let i = 6; i < pts.length; i++) {
    const pStart = pts[i - 6];
    const pPeak = pts[i - 3];
    const pNow = pts[i];
    const spikePct = ((pPeak.price - pStart.price) / pStart.price) * 100;
    if (spikePct >= 2.2 && pNow.price < pPeak.price * 0.985 && pNow.price <= pNow.avg * 1.002) {
      hasSpikeTrap = true;
      spikeDesc = `在 ${pPeak.t.slice(0, 2)}:${pPeak.t.slice(2)} 脉冲急拉 +${spikePct.toFixed(1)}% 后迅速砸穿均线`;
      break;
    }
  }

  // 3. 高位放量滞涨 (High Volume Stagnation / Divergence)
  const maxPrice = Math.max(...pts.map(p => p.price));
  const minPrice = Math.min(...pts.map(p => p.price));
  const priceRng = maxPrice - minPrice;
  const isNearHigh = priceRng > 0 ? (pxNow - minPrice) / priceRng >= 0.78 : false;
  const avgVol = pts.reduce((a, b) => a + b.vol, 0) / pts.length || 1;
  const recentVol = recentPts.reduce((a, b) => a + b.vol, 0) / recentLen || 0;
  const isHeavyVol = recentVol >= avgVol * 1.8;
  const priceStagnant = recentPts[recentPts.length - 1].price <= recentPts[0].price * 1.002;
  const hasStagnation = isNearHigh && isHeavyVol && priceStagnant && bias > 0;

  if (belowRatio >= 0.8 && bias < -0.5) {
    return {
      status: 'resistance',
      level: 'danger',
      title: '🚨 均线破位反压 (主力派发，严禁抄底)',
      badge: '🚨 均线反压',
      color: '#dc2626',
      bg: '#fef2f2',
      border: '#fca5a5',
      desc: hasFailedRebound
        ? `现价受制于分时黄线反压 (偏离度 ${bias.toFixed(2)}%)，反抽黄线均被大单砸回，主力借反抽出货，严禁逆势低吸！`
        : `现价持续运行在分时黄线下方 (偏离度 ${bias.toFixed(2)}%)，全天均价形成强阻力，弱势格局，切勿盲目接飞刀！`,
      bias
    };
  }

  if (hasSpikeTrap && pxNow <= avgNow * 1.005) {
    return {
      status: 'spike_trap',
      level: 'danger',
      title: '⚠️ 疑似脉冲出货 (钓鱼波诱多，防追高)',
      badge: '⚠️ 脉冲诱多',
      color: '#ea580c',
      bg: '#fff7ed',
      border: '#fdba74',
      desc: `${spikeDesc}。主力借脉冲拉高吸引跟风挂单后倾倒筹码，切忌冲动追高！`,
      bias
    };
  }

  if (hasStagnation) {
    return {
      status: 'stagnation',
      level: 'warn',
      title: '⚠️ 高位放量滞涨 (量大价滞，防主力开闸)',
      badge: '⚠️ 放量滞涨',
      color: '#b45309',
      bg: '#fffbeb',
      border: '#fde68a',
      desc: `高位成交量放大至均量的 ${(recentVol / avgVol).toFixed(1)} 倍，但股价滞涨停顿，警惕主力高位对倒出货！`,
      bias
    };
  }

  if (pxNow > avgNow && bias >= 0.4) {
    return {
      status: 'support',
      level: 'safe',
      title: '🟢 均线上方健康承接 (主力护盘意愿良好)',
      badge: '🟢 均线支撑',
      color: '#16a34a',
      bg: '#f0fdf4',
      border: '#86efac',
      desc: `股价稳健运行在分时均线上方 (偏离度 +${bias.toFixed(2)}%)，均线提供动态托底，日内可依托均线支撑轻仓低吸。`,
      bias
    };
  }

  return {
    status: 'neutral',
    level: 'normal',
    title: '🟡 围绕分时均线窄幅震荡 (方向待抉择)',
    badge: '🟡 窄幅震荡',
    color: '#0284c7',
    bg: '#f0f9ff',
    border: '#bae6fd',
    desc: `股价紧贴分时黄线波动 (偏离度 ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}%)，多空处于平衡期，建议等待方向明确或在保本空间内操作。`,
    bias
  };
}

export const PERIODS = [
  ['rt','分时'], ['m1','1分'], ['m5','5分'], ['m15','15分'], ['m30','30分'], ['m60','60分'],
  ['day','日K'], ['week','周K'], ['month','月K']
];
export const PERIOD_LABEL = {}; PERIODS.forEach(([k,v])=> PERIOD_LABEL[k]=v);
export const P_MAIN = [
  ['rt', '分时'],
  ['day', '日K'],
  ['week', '周K'],
  ['month', '月K']
];
export const P_MAIN_KEYS = ['rt', 'day', 'week', 'month'];
export const P_MORE = PERIODS.filter(([k])=> P_MAIN_KEYS.indexOf(k) < 0);
export const VIEWS = { rt:999, m1:240, m5:64, m15:64, m30:64, m60:64, day:60, week:60, month:40 };

/* 图表用指标：同一套函数在任意周期上复用 —— 周期一换，指标就跟着换成该周期的口径 */
export function chartInd(ks){
  const closes = ks.map(k=>k.close), vols = ks.map(k=>k.vol||0);
  return { closes,
    ma5:maArr(closes,5), ma10:maArr(closes,10), ma20:maArr(closes,20), ma60:maArr(closes,60),
    boll:bollArr(closes,20,2),
    rsi6:rsiArr(closes,6), rsi12:rsiArr(closes,12), rsi24:rsiArr(closes,24),
    macd:macdArr(closes), vma5:maArr(vols,5) };
}
/* 数字格式化：null / 空 / NaN 一律显示为「—」，避免图表和卡片上出现 "null" 或 "NaN" */
const nf = (v, d)=> (v == null || v === '' || Number.isNaN(+v)) ? '—' : (+v).toFixed(d === undefined ? 2 : d);
/* 金额缩写：元 → 万 / 亿（大单金额动辄上亿，原样写出来读不动） */
function money$(v){
  v = +v || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v/1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v/1e4).toFixed(1) + '万';
  return Math.round(v) + '';
}
/* 把一段文字画成带底色的信息条（悬停提示 / 轴上标注共用；支持按 maxW 自动省略防窄屏溢出） */
function chipText(ctx, txt, x, y, col, bg, maxW){
  let out = String(txt || '');
  if (maxW && maxW > 24 && ctx.measureText(out).width + 7 > maxW) {
    while (out.length > 4 && ctx.measureText(out + '…').width + 7 > maxW) {
      out = out.slice(0, -1);
    }
    out += '…';
  }
  const tw = ctx.measureText(out).width;
  ctx.globalAlpha = .94; ctx.fillStyle = bg || '#fff';
  ctx.fillRect(x, y-8, tw+7, 15);
  ctx.globalAlpha = 1; ctx.fillStyle = col;
  ctx.fillText(out, x+3.5, y);
  return tw + 7;
}

let _chartDataLoader = null;
export function registerChartLoader(fn){
  _chartDataLoader = fn;
}

export function chartEntry(kind, obj){
  const e = Object.assign({ kind, at: Date.now() }, obj);
  if (kind === 'bar' && e.ks && e.ks.length) e.ind = chartInd(e.ks);
  return e;
}

export function drawChart(cv, s){
  const p = s.p || 'day';
  s._k = s._k || {};
  let entry = s._k[p];
  if ((!entry || (entry.kind === 'bar' && (!entry.ks || !entry.ks.length))) && p === 'day' && s._ks && s._ks.length) {
    s._k['day'] = chartEntry('bar', { ks: s._ks });
    entry = s._k['day'];
  }
  const ov = s.ov || (s.ov = {});
  const subKind = s.sub || 'macd';

  const rawW = cv.clientWidth || cv.parentElement?.clientWidth || 640;
  const W = Math.max(260, rawW);
  const isNarrow = W < 460;
  const PL = isNarrow ? 6 : 8;
  const PR = isNarrow ? 48 : 54;
  const PT = 34;
  const PB = isNarrow ? 18 : 20;                // PT 留出两行信息条的高度（图例已移到画布外的 HTML 里）
  const hMain = isNarrow ? 186 : 216;
  const hVol = isNarrow ? 46 : 56;
  const subH = isNarrow ? 68 : 86;
  const gap = isNarrow ? 7 : 9;
  const H = PT + hMain + gap + hVol + gap + subH + PB;

  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  }
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.font = isNarrow ? '10.5px ui-monospace,Consolas,monospace' : '11px ui-monospace,Consolas,monospace';
  ctx.textBaseline = 'middle';

  const y0 = PT, y1 = y0 + hMain;
  const v0 = y1 + gap, v1 = v0 + hVol;
  const s0 = v1 + gap, s1 = s0 + subH;
  const innerW = W - PL - PR;

  if (!entry){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('正在取数…（切换周期首次约 0.3~1 秒）', W/2, H/2);
    if (_chartDataLoader && !s._chartLoading) {
      s._chartLoading = true;
      _chartDataLoader(s, true).then(() => {
        s._chartLoading = false;
        drawChart(cv, s);
        const ci = cv.dataset.ki;
        const metaEl = ci != null ? document.getElementById(`kmeta-${ci}`) : null;
        if (metaEl) metaEl.innerHTML = chartMeta(s);
        if (typeof cv._onDraw === 'function') cv._onDraw();
      }).catch(() => {
        s._chartLoading = false;
      });
    }
    return;
  }
  if (entry.kind === 'line'){
    drawRt(cv, s, entry.min, ctx, {W,H,PL,PR,y0,y1,v0,v1,s0,s1,innerW});
    if (typeof cv._onDraw === 'function') cv._onDraw();
    return;
  }

  const ks = entry.ks || [];
  if (ks.length < 12){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('该周期K线不足（仅 ' + ks.length + ' 根），换回日K / 周K 看', W/2, H/2);
    return;
  }
  const ind = entry.ind || chartInd(ks);
  const N = Math.min(VIEWS[p] || 60, ks.length);
  const i0 = ks.length - N;
  const view = ks.slice(i0);
  const bw = innerW / N;
  const X = i => PL + bw*(i+0.5);
  const sv = a => a ? a.slice(i0) : null;
  cv._geo = { kind:'bar', n:N, i0, bw, PL, innerW, view, ind };

  const ta = s._ta;                                  // 日线口径技术面（箱体/支撑压力与所选周期无关）
  const hasBoll = !!(ov.boll && ind.boll && ind.boll.up);
  const vBollU = hasBoll ? sv(ind.boll.up) : null;
  const vBollM = hasBoll ? sv(ind.boll.mid) : null;
  const vBollD = hasBoll ? sv(ind.boll.dn) : null;
  const vMa5 = ov.ma ? sv(ind.ma5) : null, vMa10 = ov.ma ? sv(ind.ma10) : null;
  const vMa20 = ov.ma ? sv(ind.ma20) : null, vMa60 = ov.ma ? sv(ind.ma60) : null;

  /* ---- 价格轴：以蜡烛高低点为主体，叠加线只有"离得不远"的才纳入，防止一条 MA60 把图压扁 ---- */
  let pLo = Infinity, pHi = -Infinity;
  view.forEach(k=>{ if (k.low < pLo) pLo = k.low; if (k.high > pHi) pHi = k.high; });
  const tol = ((pHi - pLo) || 1) * 0.08;
  const take = v => { if (v == null || !isFinite(v)) return;
    if (v > pLo - tol && v < pHi + tol){ if (v < pLo) pLo = v; if (v > pHi) pHi = v; } };
  [vMa5,vMa10,vMa20,vMa60,vBollU,vBollM,vBollD].forEach(a=> a && a.forEach(take));
  const cost = +s.cost || 0;
  if (ov.cost && cost > 0) take(cost);
  if (ov.box && ta && ta.box20){ take(ta.box20.top); take(ta.box20.bot); }
  let srRes = [], srSup = [];
  if (ov.sr && ta && ta.levels){
    srRes = ta.levels.res; srSup = ta.levels.sup;
    srRes.forEach(l=> take(l.p)); srSup.forEach(l=> take(l.p));
  }
  const rng = (pHi - pLo) || 1;
  pLo -= rng*0.045; pHi += rng*0.045;
  const Y = v => y1 - (v - pLo)/(pHi - pLo) * (y1 - y0);

  // ---- 主图网格 + 右侧价格刻度 ----
  ctx.textAlign = 'left';
  for (let k=0; k<=4; k++){
    const pv = pLo + (pHi-pLo)*k/4, yy = Y(pv);
    ctx.strokeStyle = CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = CH.mute; ctx.fillText(f2(pv), W-PR+5, yy);
  }
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath(); ctx.moveTo(PL, v1+.5); ctx.lineTo(W-PR, v1+.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();

  // ---- 布林通道（先铺底，蜡烛压在上面）----
  if (hasBoll){
    ctx.beginPath();
    let started = false;
    vBollU.forEach((v,i)=>{ if (v==null) return; if (!started){ ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v)); });
    for (let i=vBollD.length-1; i>=0; i--){ const v = vBollD[i]; if (v==null) continue; ctx.lineTo(X(i), Y(v)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,132,199,.07)'; ctx.fill();
  }

  // ---- 蜡烛 ----
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const col = rise ? CH.up : CH.dn;
    const x = X(i), bodyW = Math.max(1.5, bw*0.62);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke();
    const yo = Y(k.open), yc = Y(k.close);
    const top = Math.min(yo,yc), hgt = Math.max(1, Math.abs(yc-yo));
    if (rise){ ctx.fillStyle = '#fff'; ctx.fillRect(x-bodyW/2, top, bodyW, hgt);
               ctx.strokeRect(x-bodyW/2+.5, top+.5, bodyW-1, hgt-1); }
    else     { ctx.fillRect(x-bodyW/2, top, bodyW, hgt); }
  });

  // ---- 成交量柱 ----
  const vols = view.map(k=>k.vol || 0);
  const vMax = Math.max(...vols, 1);
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const vh = (k.vol||0)/vMax*(hVol-6);
    ctx.fillStyle = rise ? CH.up : CH.dn; ctx.globalAlpha = .6;
    ctx.fillRect(X(i)-Math.max(1,bw*0.32), v1-vh, Math.max(1.2,bw*0.64), vh);
    ctx.globalAlpha = 1;
  });
  const vma5 = sv(ind.vma5);
  if (vma5){
    ctx.strokeStyle = CH.vma; ctx.lineWidth = 1.1; ctx.beginPath();
    let st = false;
    vma5.forEach((v,i)=>{ if (v==null) return; const yy = v1 - v/vMax*(hVol-6);
      if (!st){ ctx.moveTo(X(i), yy); st = true; } else ctx.lineTo(X(i), yy); });
    ctx.stroke();
  }
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('量', PL+1, v0+8);
  ctx.fillStyle = CH.vma; ctx.fillText('VMA5', PL+18, v0+8);

  // ---- 横线（箱体 / 成本 / 支撑压力 / 现价）----
  const hline = (val, col, dash, label, above, alpha)=>{
    if (val == null || !isFinite(val)) return;
    const yy = Y(val);
    if (yy < y0-2 || yy > y1+2) return;
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha || .85;
    ctx.setLineDash(dash || [4,3]);
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.restore();
    if (label){
      ctx.textAlign = 'left';
      chipText(ctx, label, PL+2, above ? yy-9 : yy+10, col, 'rgba(255,255,255,.92)');
    }
  };
  if (ov.sr){
    /* 支撑压力线画细虚线、不加文字标签，只把「压1/撑1…」小标签贴在右侧内缘 —— 
       左侧已经被箱顶/箱底/成本/现价四个标签占满了，再挤过去会糊成一片。 */
    const srTag = (l, i, isRes)=>{
      const yy = Y(l.p);
      if (yy < y0-2 || yy > y1+2) return;
      const col = isRes ? CH.sr : CH.dn;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = .5;
      ctx.setLineDash([2,3]);
      ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
      ctx.restore();
      if (i > 1) return;                        // 只标注最近的两档，第三档留给卡片里的明细
      ctx.font = '9.5px ui-monospace,Consolas,monospace';
      const lab = (isRes ? '压' : '撑') + (i+1) + ' ' + f2(l.p);
      const tw = ctx.measureText(lab).width;
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(W-PR-4-tw, yy-16, tw+7, 14);
      ctx.fillStyle = col; ctx.textAlign = 'left';
      ctx.fillText(lab, W-PR-1-tw, yy-9);
      ctx.font = '11px ui-monospace,Consolas,monospace';
    };
    srSup.forEach((l,i)=> srTag(l, i, false));      // 撑1 = 离现价最近的支撑
    srRes.forEach((l,i)=> srTag(l, i, true));       // 压1 = 离现价最近的压力
  }
  if (ov.box && ta && ta.box20){
    hline(ta.box20.top, CH.box, [5,3], '箱顶 ' + f2(ta.box20.top), true);
    hline(ta.box20.bot, CH.box, [5,3], '箱底 ' + f2(ta.box20.bot), false);
  }
  if (ov.cost && cost > 0) hline(cost, CH.cost, [6,3], '成本 ' + f2(cost), true);

  // ---- 均线 / 布林轨（画在蜡烛之上，交叉关系才看得清）----
  /* yf：可选的自定义纵坐标映射。副图（MACD / RSI）必须传自己的映射函数，
     否则会被当成主图价格去算 Y()，画成贯穿全屏的竖线（这个坑踩过一次）。 */
  const poly = (arr, col, w, dash, yf)=>{
    if (!arr) return;
    const F = yf || Y;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w || 1.2;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let st = false;
    arr.forEach((v,i)=>{ if (v==null) return;
      if (!st){ ctx.moveTo(X(i), F(v)); st = true; } else ctx.lineTo(X(i), F(v)); });
    ctx.stroke(); ctx.restore();
  };
  if (hasBoll){
    poly(vBollU, CH.bollU, 1, [4,3]); poly(vBollD, CH.bollU, 1, [4,3]);
    poly(vBollM, CH.bollM, 1.1, [4,3]);
  }
  poly(vMa5, CH.ma5, 1.2); poly(vMa10, CH.ma10, 1.2);
  poly(vMa20, CH.ma20, 1.2); poly(vMa60, CH.ma60, 1.2);

  const lastClose = view[view.length-1].close;
  hline(lastClose, lastClose >= +s.prevClose ? CH.up : CH.dn, [2,2], '现价 ' + f2(lastClose), true);

  // ---- 副图：MACD 或 RSI ----
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < N) ? hs : -1;

  if (subKind === 'rsi'){
    const r6 = sv(ind.rsi6), r12 = sv(ind.rsi12), r24 = sv(ind.rsi24);
    const RY = v => s1 - (Math.max(0, Math.min(100, v)))/100*(s1-s0);
    [30,50,70].forEach(v=>{
      ctx.strokeStyle = v===50 ? '#e2e8f0' : '#f1f5f9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PL, RY(v)+.5); ctx.lineTo(W-PR, RY(v)+.5); ctx.stroke();
      ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText(String(v), W-PR+5, RY(v));
    });
    // 超买 / 超卖带
    ctx.globalAlpha = .07; ctx.fillStyle = CH.up; ctx.fillRect(PL, RY(100), innerW, RY(70)-RY(100));
    ctx.fillStyle = CH.dn; ctx.fillRect(PL, RY(30), innerW, RY(0)-RY(30));
    ctx.globalAlpha = 1;
    poly(r6, CH.ma5, 1.2, null, RY); poly(r12, CH.ma10, 1.2, null, RY); poly(r24, CH.ma20, 1.2, null, RY);
    ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('RSI(6/12/24)', PL+1, s0+8);
  } else {
    const md = ind.macd;
    const difS = md ? sv(md.dif) : null, deaS = md ? sv(md.dea) : null, barS = md ? sv(md.bar) : null;
    if (difS){
      const span = Math.max(...[...difS, ...deaS, ...barS].map(v=> Math.abs(v||0)), 0.01)*1.15;
      const yMid = (s0+s1)/2;
      const MY = v => yMid - v/span*((s1-s0)/2 - 2);
      ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, yMid+.5); ctx.lineTo(W-PR, yMid+.5); ctx.stroke();
      view.forEach((k,i)=>{
        const v = barS[i]; if (v == null) return;
        const yy = MY(v);
        ctx.fillStyle = v >= 0 ? CH.up : CH.dn; ctx.globalAlpha = .55;
        ctx.fillRect(X(i)-Math.max(1,bw*0.3), Math.min(yy,yMid), Math.max(1,bw*0.6), Math.abs(yy-yMid));
        ctx.globalAlpha = 1;
      });
      poly(difS, CH.ma5, 1.3, null, MY); poly(deaS, CH.ma10, 1.3, null, MY);
      ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('MACD(12,26,9)', PL+1, s0+8);
    }
  }

  // ---- 底部时间刻度 ----
  ctx.textAlign = 'center'; ctx.fillStyle = CH.mute;
  const dlab = k => p === 'day' || p === 'week' || p === 'month' ? String(k.date).slice(2, 10)
                : String(k.date).slice(8,10) + ':' + String(k.date).slice(10,12);
  [0, Math.floor(N/2), N-1].forEach(i=>{ if (view[i]) ctx.fillText(dlab(view[i]), X(i), H-7); });

  // ---- 悬停十字光标 ----
  if (hi >= 0){
    const k = view[hi];
    ctx.save();
    ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(X(hi)+.5, y0); ctx.lineTo(X(hi)+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, Y(k.close)+.5); ctx.lineTo(W-PR, Y(k.close)+.5); ctx.stroke();
    ctx.restore();
  }

  // ---- 顶部信息条：第 1 行 OHLC + 量额，第 2 行各指标在该根上的取值 ----
  const hv = hi >= 0 ? view[hi] : view[view.length-1];
  const hj = hi >= 0 ? hi : view.length-1;
  const chg = (hv.close - hv.open)/hv.open*100;
  const volTxt = hv.vol >= 10000
    ? (hv.vol/10000).toFixed(isNarrow ? 1 : 2) + (isNarrow ? '万' : '万手')
    : (hv.vol||0) + (isNarrow ? '' : '手');
  const row1 = isNarrow
    ? `${dlab(hv)} 开${f2(hv.open)} 高${f2(hv.high)} 低${f2(hv.low)} 收${f2(hv.close)} ${pct(chg)} 量${volTxt}`
    : dlab(hv) + '  开' + f2(hv.open) + ' 高' + f2(hv.high) + ' 低' + f2(hv.low) + ' 收' + f2(hv.close)
      + '  ' + pct(chg) + '  量' + volTxt;
  const g = (arr)=> arr ? arr[hj] : null;
  const p2 = [];
  if (ov.ma) p2.push('MA5 ' + nf(g(ind.ma5)), 'MA10 ' + nf(g(ind.ma10)), 'MA20 ' + nf(g(ind.ma20)), 'MA60 ' + nf(g(ind.ma60)));
  if (hasBoll) p2.push('BOLL ' + nf(g(ind.boll.dn)) + '/' + nf(g(ind.boll.mid)) + '/' + nf(g(ind.boll.up)));
  if (ind.rsi6) p2.push('RSI6 ' + nf(g(ind.rsi6),1), 'RSI12 ' + nf(g(ind.rsi12),1));
  if (ind.macd) p2.push('DIF ' + nf(g(ind.macd.dif),3), 'DEA ' + nf(g(ind.macd.dea),3));
  const row2 = p2.join('  ');
  ctx.textAlign = 'left';
  chipText(ctx, row1, PL, 12, hv.close >= hv.open ? CH.up : CH.dn, 'rgba(255,255,255,.95)', W - PL - 4);
  // 第二行：按可用宽度自适应取舍 —— 宁可少显示两项，也不要让文字溢出画布被裁掉
  if (row2){
    const parts = p2.slice();
    let line = '';
    for (let i=0;i<parts.length;i++){
      const t = line ? line + '  ' + parts[i] : parts[i];
      if (ctx.measureText(t).width > W - PL - 12) break;
      line = t;
    }
    if (line) chipText(ctx, line, PL, 27, CH.mute, 'rgba(255,255,255,.95)', W - PL - 4);
  }
}

/* ===================== 分时图 =====================
   分时图自成一套坐标系：以昨收为中轴上下对称，右侧刻度同时看得到价格与涨跌幅，
   分时均价线（权威算法：累计成交额 ÷ 累计成交量）是判断"强于/弱于大盘"的关键线。
   支持叠加：持仓成本线、做T保本线、做T低吸/高抛点、主力出货风险雷达。 */
function drawRt(cv, s, min, ctx, L){
  const { W, H, PL, PR, y0, y1, v0, v1, s0, s1, innerW } = L;
  const pts = (min && min.pts) || [];
  if (pts.length < 5){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText(min ? '今日暂无分时数据（非交易日或停牌）' : '正在取数…', W/2, H/2);
    return;
  }
  const prev = (min.prev || +s.prevClose || pts[0].price);

  // 分时做T叠加开关与保本价准备（新增默认开启的五档盘口 book 与大盘对比线 bench）
  const ovRt = Object.assign({ book: 1, bench: 1, cost: 1, be: 1, zones: 1, signal: 1, actual: 1, radar: 1 }, s.ovRt || {});
  s.ovRt = ovRt;
  const cost = +s.cost || 0;
  let bePrice = +s.bePrice || 0;
  if (!bePrice && cost > 0) {
    try {
      const res = calcTBreakeven({ mode: 'BUY', entryPx: cost, qty: 1000, commRate: 0.00025, hasMin5: true });
      bePrice = res.targetPx;
      s.bePrice = bePrice;
    } catch (_) {}
  }

  // 标准 241 分钟固定槽位映射（09:30=0, 11:30/13:00=120, 15:00=240）
  const ptSlots = pts.map((p, idx) => {
    const sl = hhmmToSlot241(p.t);
    return Number.isFinite(sl) ? sl : Math.min(240, idx);
  });
  const lastSlot = ptSlots[ptSlots.length - 1] ?? 0;

  // 解析同期基准指数分时涨跌幅序列（按 241 槽位对齐）
  const benchRaw = min && min.bench && Array.isArray(min.bench.pts) && min.bench.prev > 0 ? min.bench : null;
  const benchName = benchRaw ? (benchRaw.name || '大盘') : '';
  const benchSlotPct = {};
  const benchDrawPts = [];
  let benchMaxAbsPct = 0;
  if (benchRaw) {
    const bPrev = +benchRaw.prev;
    benchRaw.pts.forEach((bp) => {
      const bSl = hhmmToSlot241(bp.t);
      if (!Number.isFinite(bSl) || bSl > lastSlot + 2 || !(bp.price > 0)) return;
      const bPct = (bp.price - bPrev) / bPrev;
      benchSlotPct[bSl] = bPct;
      benchDrawPts.push({ slot: bSl, pct: bPct });
      if (Math.abs(bPct) > benchMaxAbsPct) benchMaxAbsPct = Math.abs(bPct);
    });
  }

  const rtBundle = computeRtTradeOverlays(s, pts, prev, s._rtTradeLogs || []);
  const { zones, points: recPoints, actualMarkers } = rtBundle;

  let mx = 0.002;
  pts.forEach(p=>{
    const d1 = Math.abs(p.price - prev)/prev, d2 = Math.abs(p.avg - prev)/prev;
    if (d1 > mx) mx = d1; if (d2 > mx) mx = d2;
  });
  if (ovRt.bench && benchMaxAbsPct > mx && benchMaxAbsPct < 0.10) {
    mx = Math.max(mx, benchMaxAbsPct);
  }

  // 仅当成本/保本价或推荐买卖区距昨收未显著超出分时波动时，才轻微外扩纵轴（避免远距线压扁分时曲线）
  const maybeStretchMx = (pxVal, maxRatioLimit = 1.35) => {
    if (!(pxVal > 0 && prev > 0)) return;
    const d = Math.abs(pxVal - prev) / prev;
    if (d < 0.18 && d > mx && d <= mx * maxRatioLimit) mx = d;
  };
  if (ovRt.cost && cost > 0) {
    const dCost = Math.abs(cost - prev) / prev;
    if (dCost < 0.18 && dCost > mx && dCost <= mx * 1.45) mx = dCost;
  }
  if (ovRt.be && bePrice > 0) {
    const dBe = Math.abs(bePrice - prev) / prev;
    if (dBe < 0.18 && dBe > mx && dBe <= mx * 1.45) mx = dBe;
  }
  if (ovRt.zones) {
    maybeStretchMx(zones.buyHi, 1.35);
    maybeStretchMx(zones.sellLo, 1.35);
  }

  mx = Math.min(0.2, Math.ceil(mx*100*1.12)/100);      // 上下各留 12% 余量，上限 20%（防止极端值压扁）
  const yHi = prev*(1+mx), yLo = prev*(1-mx);
  const Y = v => y1 - (v-yLo)/(yHi-yLo)*(y1-y0);
  const XSlot = sl => PL + (Math.max(0, Math.min(240, sl)) / 240) * innerW;
  const X = i => XSlot(ptSlots[i]);
  cv._geo = { kind:'line', n:pts.length, PL, PR, innerW, pts, ptSlots, prev, y0, y1, yLo, yHi, recPoints };

  // 记录超出分时主图可视范围的推荐区间提示
  const outOfView = [];
  if (zones.buyHi > 0 && zones.buyHi < yLo) outOfView.push(`买区¥${f2(zones.buyLo || zones.buyHi)}~${f2(zones.buyHi)}(低于视口)`);
  if (zones.sellLo > 0 && zones.sellLo > yHi) outOfView.push(`卖区¥${f2(zones.sellLo)}~${f2(zones.sellHi || zones.sellLo)}(高于视口)`);
  if (zones.stopPx > 0 && zones.stopPx < yLo) outOfView.push(`止损¥${f2(zones.stopPx)}(低于视口)`);
  rtBundle.outOfView = outOfView;

  // 计算最新超额 Alpha（个股涨跌幅 - 同期指数涨跌幅）
  const lastPt = pts[pts.length - 1];
  const latestStockPct = prev > 0 ? ((lastPt.price - prev) / prev) * 100 : 0;
  let latestBenchPct = null;
  if (benchDrawPts.length > 0) {
    latestBenchPct = benchDrawPts[benchDrawPts.length - 1].pct * 100;
  }
  const latestAlpha = latestBenchPct !== null ? +(latestStockPct - latestBenchPct).toFixed(2) : null;
  rtBundle.benchName = benchName;
  rtBundle.benchPct = latestBenchPct !== null ? +latestBenchPct.toFixed(2) : null;
  rtBundle.alphaPct = latestAlpha;
  s._rtSignals = rtBundle;

  // 1) 固定时段纵向网格线 + 11:30/13:00 午盘休市分界中轴
  [60, 120, 180].forEach((sl) => {
    const sx = Math.round(XSlot(sl)) + 0.5;
    ctx.save();
    if (sl === 120) {
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
    } else {
      ctx.strokeStyle = '#f1f5f9';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(sx, y0);
    ctx.lineTo(sx, s1);
    ctx.stroke();
    ctx.restore();
  });

  // 2) 横向价格网格 + 右侧防重叠价格/涨跌幅刻度
  const curY = Y(lastPt.price);
  ctx.textAlign = 'left';
  for (let k=-2; k<=2; k++){
    const pv = prev*(1 + mx*k/2), yy = Y(pv);
    ctx.strokeStyle = k === 0 ? '#cbd5e1' : CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    // 若该刻度与最新现价右轴胶囊距离过近（<15px），让位给现价实时标签，杜绝右轴叠字
    if (Math.abs(yy - curY) < 15 && lastSlot < 239) continue;
    ctx.fillStyle = k === 0 ? CH.txt : CH.mute;
    ctx.fillText(f2(pv), W-PR+5, yy - 4);
    ctx.fillStyle = k === 0 ? CH.mute : (pv >= prev ? CH.up : CH.dn);
    ctx.fillText((k>0?'+':'') + (k*mx/2*100).toFixed(2) + '%', W-PR+5, yy + 7);
  }

  // 绘制推荐买卖区间带 & 止损线（仅画清爽半透明区带+虚线，不在曲线上堆大块文字）
  if (ovRt.zones) {
    if (zones.buyHi > 0 && zones.buyHi >= yLo && (zones.buyLo || zones.buyHi) <= yHi) {
      const topVal = Math.min(yHi, zones.buyHi);
      const botVal = Math.max(yLo, zones.buyLo > 0 ? zones.buyLo : zones.buyHi * 0.992);
      const yTop = Y(topVal);
      const yBot = Y(botVal);
      ctx.save();
      ctx.fillStyle = 'rgba(220, 38, 38, 0.055)';
      ctx.fillRect(PL, yTop, innerW, Math.max(4, yBot - yTop));
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(PL, yTop + 0.5);
      ctx.lineTo(W - PR, yTop + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    if (zones.sellLo > 0 && zones.sellLo <= yHi && (zones.sellHi || zones.sellLo) >= yLo) {
      const botVal = Math.max(yLo, zones.sellLo);
      const topVal = Math.min(yHi, zones.sellHi > 0 ? zones.sellHi : zones.sellLo * 1.008);
      const yTop = Y(topVal);
      const yBot = Y(botVal);
      ctx.save();
      ctx.fillStyle = 'rgba(22, 163, 74, 0.055)';
      ctx.fillRect(PL, yTop, innerW, Math.max(4, yBot - yTop));
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(PL, yBot + 0.5);
      ctx.lineTo(W - PR, yBot + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    if (zones.stopPx > 0 && zones.stopPx >= yLo && zones.stopPx <= yHi) {
      const ys = Y(zones.stopPx);
      ctx.save();
      ctx.strokeStyle = 'rgba(180, 83, 9, 0.72)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(PL, ys + 0.5);
      ctx.lineTo(W - PR, ys + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 3) 同期大盘/板块基准对比虚线（将指数涨跌幅等比投射到昨收中轴坐标系，直观看出个股抗跌/领涨剪刀差）
  if (ovRt.bench && benchDrawPts.length >= 2) {
    ctx.save();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    benchDrawPts.forEach((bp, idx) => {
      const eqPx = Math.max(yLo, Math.min(yHi, prev * (1 + bp.pct)));
      const bx = XSlot(bp.slot);
      const by = Y(eqPx);
      if (idx === 0) ctx.moveTo(bx, by);
      else ctx.lineTo(bx, by);
    });
    ctx.stroke();
    ctx.restore();
  }

  // 4) 价格线（相对昨收的红绿）+ 昨收中轴淡填充
  const lineCol = lastPt.price >= prev ? CH.up : CH.dn;
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.price); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = lineCol; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(X(pts.length-1), Y(prev)); ctx.lineTo(X(0), Y(prev)); ctx.closePath();
  ctx.fillStyle = lineCol; ctx.globalAlpha = .07; ctx.fill(); ctx.globalAlpha = 1;

  // 5) 分时均价线（VWAP）
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.avg); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = CH.avg; ctx.lineWidth = 1.3; ctx.stroke();

  // 6) 盘中最新现价水平延伸虚线 + 末端呼吸光晕圆点 + 右轴独立现价胶囊
  if (lastPt.price >= yLo && lastPt.price <= yHi) {
    const lx = X(pts.length - 1);
    ctx.save();
    ctx.strokeStyle = lineCol;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(lx, curY + 0.5);
    ctx.lineTo(W - PR, curY + 0.5);
    ctx.stroke();
    ctx.restore();

    if (lastSlot < 239) {
      ctx.save();
      ctx.fillStyle = lastPt.price >= prev ? 'rgba(211, 47, 47, 0.22)' : 'rgba(10, 127, 66, 0.22)';
      ctx.beginPath();
      ctx.arc(lx, curY, 6.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = lineCol;
      ctx.beginPath();
      ctx.arc(lx, curY, 3.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const safeCurTagY = Math.max(y0 + 9, Math.min(y1 - 9, curY));
      chipText(ctx, f2(lastPt.price), W - PR + 2, safeCurTagY, '#ffffff', lineCol);
    }
  }

  // 7) 持仓成本线与做T保本线（采用内侧右缘防碰撞排布，彻底告别与右轴刻度叠字）
  const innerRefTags = [];
  if (ovRt.cost && cost > 0 && cost >= yLo && cost <= yHi) {
    const yy = Y(cost);
    ctx.save();
    ctx.strokeStyle = CH.cost;
    ctx.lineWidth = 1.15;
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(PL, yy + 0.5); ctx.lineTo(W - PR, yy + 0.5); ctx.stroke();
    ctx.restore();
    innerRefTags.push({ yy, text: `持仓 ¥${f2(cost)}`, bg: CH.cost });
  }

  if (ovRt.be && bePrice > 0 && bePrice >= yLo && bePrice <= yHi) {
    const yy = Y(bePrice);
    ctx.save();
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.15;
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(PL, yy + 0.5); ctx.lineTo(W - PR, yy + 0.5); ctx.stroke();
    ctx.restore();
    innerRefTags.push({ yy, text: `保本 ¥${f2(bePrice)}`, bg: '#d97706' });
  }

  if (innerRefTags.length > 0) {
    innerRefTags.sort((a, b) => a.yy - b.yy);
    const minGap = 17;
    for (let i = 0; i < innerRefTags.length; i++) {
      innerRefTags[i].drawY = Math.max(y0 + 9, Math.min(y1 - 9, innerRefTags[i].yy));
      if (i > 0 && innerRefTags[i].drawY - innerRefTags[i - 1].drawY < minGap) {
        innerRefTags[i].drawY = Math.min(y1 - 9, innerRefTags[i - 1].drawY + minGap);
      }
    }
    if (innerRefTags.length === 2 && innerRefTags[1].drawY - innerRefTags[0].drawY < minGap) {
      innerRefTags[0].drawY = Math.max(y0 + 9, innerRefTags[1].drawY - minGap);
    }
    innerRefTags.forEach((tg) => {
      const tw = ctx.measureText(tg.text).width + 7;
      const tx = Math.max(PL + 4, W - PR - tw - 4);
      if (Math.abs(tg.drawY - tg.yy) >= 2) {
        ctx.save();
        ctx.strokeStyle = tg.bg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx + tw, tg.drawY);
        ctx.lineTo(W - PR - 1, tg.yy);
        ctx.stroke();
        ctx.restore();
      }
      chipText(ctx, tg.text, tx, tg.drawY, '#fff', tg.bg);
    });
  }

  // 8) 绘制动态推荐买卖点（纯净红点=买点 / 绿点=卖点；实心=右侧确认锁定，空心带光晕=预备试探）
  if (ovRt.signal && recPoints.length > 0) {
    recPoints.forEach((sig) => {
      const px = X(sig.idx);
      const py = Y(sig.px);
      const isBuy = sig.type === 'BUY';
      const col = isBuy ? '#dc2626' : '#16a34a';
      ctx.save();
      if (sig.confirmed) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        ctx.fillStyle = isBuy ? 'rgba(220, 38, 38, 0.22)' : 'rgba(22, 163, 74, 0.22)';
        ctx.beginPath();
        ctx.arc(px, py, 7.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(px, py, 4.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // 9) 绘制今日实盘已成交买卖点（红菱形=实盘买 / 绿菱形=实盘卖，金边区分）
  if (ovRt.actual && actualMarkers.length > 0) {
    let fallbackIdx = 0;
    actualMarkers.forEach((mk) => {
      const isBuy = mk.side === 'B';
      const fill = isBuy ? '#b91c1c' : '#15803d';
      if (mk.idx >= 0) {
        const px = X(mk.idx);
        const rawY = Y(mk.px);
        const py = Math.max(y0 + 8, Math.min(y1 - 8, rawY));
        ctx.save();
        ctx.fillStyle = fill;
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py - 5.5);
        ctx.lineTo(px + 5.5, py);
        ctx.lineTo(px, py + 5.5);
        ctx.lineTo(px - 5.5, py);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (mk.px >= yLo && mk.px <= yHi) {
        const py = Y(mk.px);
        ctx.save();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 1.1;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(PL, py + 0.5);
        ctx.lineTo(W - PR, py + 0.5);
        ctx.stroke();
        ctx.restore();
        const tagY = Math.max(y0 + 10, Math.min(y1 - 10, py + (fallbackIdx % 2 === 0 ? -7 : 7)));
        chipText(ctx, `${mk.side}¥${f2(mk.px)}`, PL + 2, tagY, '#fff', fill);
        fallbackIdx += 1;
      }
    });
  }

  const isNarrow = W < 460;
  const radar = analyzeIntradayDistribution(pts, prev, s);
  s._distRadar = radar;
  let radarBadgeW = 0;
  if (ovRt.radar && !isNarrow) {
    radarBadgeW = ctx.measureText(radar.badge).width + 12;
    chipText(ctx, radar.badge, W - PR - radarBadgeW, 12, radar.color, radar.bg);
  }

  // 10) 成交量柱（按 241 分钟标准栅格宽度绘制，避免早盘柱体失真变胖）
  const vMax = Math.max(...pts.map(p=>p.vol), 1);
  const unitBarW = Math.max(1.1, (innerW / 241) * 0.72);
  pts.forEach((p,i)=>{
    const pp = i > 0 ? pts[i-1].price : prev;
    const vh = p.vol/vMax*(v1-v0-4);
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .62;
    ctx.fillRect(X(i)-unitBarW/2, v1-vh, unitBarW, vh);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('分时量', PL+1, v0+8);

  // 11) 第 2 副图位：分时放量倍数（÷前 5 日同刻均量）
  ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();
  const _vslots = (s._vm && s._vm.ok && s._vm.slots) ? s._vm.slots : null;
  const avgV = pts.reduce((a,p)=>a+p.vol,0)/pts.length || 1;
  const expCache = {};
  const expOf = t => {
    if (!_vslots) return avgV;
    if (expCache[t] != null) return expCache[t];
    const mm = (+t.slice(0,2))*60 + (+t.slice(2,4));
    const slotKey = typeof m5Slot === 'function' ? m5Slot(mm) : null;
    const bv = (slotKey && _vslots) ? _vslots[slotKey] : 0;
    return (expCache[t] = (bv > 0 ? bv/5 : avgV));
  };
  const ratioOf = p => { const e = expOf(p.t); return e > 0 ? p.vol/e : 0; };
  const rMax = Math.max(3, Math.ceil(Math.max(...pts.map(ratioOf))));
  const RY2 = r => s1 - Math.min(r, rMax)/rMax*(s1-s0);
  [1, 2, 3].forEach(r=>{
    if (r > rMax) return;
    ctx.strokeStyle = r === 1 ? '#c9d2dd' : '#f1f5f9';
    ctx.beginPath(); ctx.moveTo(PL, RY2(r)+.5); ctx.lineTo(W-PR, RY2(r)+.5); ctx.stroke();
    ctx.fillStyle = r === 1 ? CH.txt : CH.mute; ctx.textAlign='left';
    ctx.fillText(r + '×', W-PR+5, RY2(r));
  });
  pts.forEach((p,i)=>{
    const r = ratioOf(p), yy = RY2(r), pp = i > 0 ? pts[i-1].price : prev;
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .52;
    ctx.fillRect(X(i)-unitBarW/2, yy, unitBarW, s1-yy);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left';
  const subTitle = isNarrow
    ? (_vslots ? '放量倍数(÷5日同刻均量, 1×常态)' : '放量倍数(÷当日均量)')
    : (_vslots ? '放量倍数（该分钟量 ÷ 前5日同一时段均量，1× = 常态）'
               : '放量倍数（该分钟量 ÷ 当日均量 —— 早盘天然偏高，基准未取到）');
  ctx.fillText(subTitle, PL+1, s0+8);

  // 12) 固定全天时间轴刻度（无论早盘几点，始终展示 09:30 ~ 11:30/13:00 ~ 15:00 全天比例）
  const sessionTicks = isNarrow
    ? [
        { slot: 0, label: '09:30', align: 'left' },
        { slot: 120, label: '11:30/13:00', align: 'center' },
        { slot: 240, label: '15:00', align: 'right' },
      ]
    : [
        { slot: 0, label: '09:30', align: 'left' },
        { slot: 60, label: '10:30', align: 'center' },
        { slot: 120, label: '11:30/13:00', align: 'center' },
        { slot: 180, label: '14:00', align: 'center' },
        { slot: 240, label: '15:00', align: 'right' },
      ];
  ctx.fillStyle = CH.mute;
  sessionTicks.forEach((tk) => {
    ctx.textAlign = tk.align;
    const tx = tk.align === 'left' ? PL + 2 : tk.align === 'right' ? W - PR - 2 : XSlot(tk.slot);
    ctx.fillText(tk.label, tx, H - 7);
  });

  // 13) 悬停 / 触屏十字准星 + 信号圆点原因浮窗气泡
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < pts.length) ? hs : -1;
  const nearSig = hi >= 0 ? recPoints.find(sp => Math.abs(sp.idx - hi) <= 4) : null;
  const nearAct = hi >= 0 ? actualMarkers.find(am => am.idx >= 0 && Math.abs(am.idx - hi) <= 4) : null;

  if (hi >= 0){
    const p = pts[hi];
    const hx = X(hi);
    const hy = Y(p.price);
    ctx.save(); ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(hx+.5, y0); ctx.lineTo(hx+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, hy+.5); ctx.lineTo(W-PR, hy+.5); ctx.stroke();
    ctx.restore();

    // 当光标靠近推荐买卖圆点或实盘成交点时，在圆点旁弹出高对比度信号原因浮窗
    if (nearSig || nearAct) {
      const targetSig = nearSig;
      const sx = targetSig ? X(targetSig.idx) : X(nearAct.idx);
      const sy = targetSig ? Y(targetSig.px) : Y(nearAct.px);
      const isBuy = targetSig ? targetSig.type === 'BUY' : nearAct.side === 'B';
      const accentCol = isBuy ? '#dc2626' : '#15803d';
      const line1 = targetSig
        ? `${targetSig.confirmed ? '● 右侧确认' : '◐ 预备试探'}${isBuy ? '买点' : '卖点'} ¥${f2(targetSig.px)}`
        : `◆ 实盘已成交${isBuy ? '买入' : '卖出'} ¥${f2(nearAct.px)} (${nearAct.qty || 0}股)`;
      const line2 = targetSig
        ? `${targetSig.reason}${isNarrow ? '' : ' · 点击圆点快捷带单'}`
        : `${nearAct.dir || '成交'} ${nearAct.time || ''}`;

      ctx.save();
      const padX = 8;
      const boxH = 36;
      const boxW = Math.min(innerW - 12, Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + padX * 2);
      let bx = sx + 10;
      if (bx + boxW > W - PR - 4) bx = Math.max(PL + 4, sx - boxW - 10);
      let by = sy - boxH - 8;
      if (by < y0 + 4) by = Math.min(y1 - boxH - 4, sy + 10);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.strokeStyle = accentCol;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(bx, by, boxW, boxH, 6);
      } else {
        ctx.rect(bx, by, boxW, boxH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = accentCol;
      ctx.fillText(line1, bx + padX, by + 11);
      ctx.fillStyle = CH.txt;
      let l2 = line2;
      while (l2.length > 6 && ctx.measureText(l2).width > boxW - padX * 2) {
        l2 = l2.slice(0, -2) + '…';
      }
      ctx.fillText(l2, bx + padX, by + 26);
      ctx.restore();
    }
  }

  const p = hi >= 0 ? pts[hi] : lastPt;
  const pSlot = hi >= 0 ? ptSlots[hi] : lastSlot;
  const pctv = (p.price - prev)/prev*100;
  const bias = p.avg > 0 ? ((p.price - p.avg) / p.avg * 100) : 0;
  const hoverBenchPct = benchSlotPct[pSlot] != null ? benchSlotPct[pSlot] * 100 : latestBenchPct;
  const hoverAlpha = hoverBenchPct != null ? (pctv - hoverBenchPct) : null;
  const alphaTxt = hoverAlpha != null ? ` 超额${hoverAlpha >= 0 ? '+' : ''}${hoverAlpha.toFixed(2)}%` : '';

  const sigTag = nearSig
    ? `${nearSig.confirmed ? '●确认' : '◐试探'}${nearSig.type === 'BUY' ? '买' : '卖'}`
    : '';
  const row = isNarrow
    ? `${p.t.slice(0,2)}:${p.t.slice(2)} 价${f2(p.price)} ${pct(pctv)} 均${f2(p.avg)} 偏${bias >= 0 ? '+' : ''}${bias.toFixed(2)}%${alphaTxt}`
      + (nearSig ? ` | ${sigTag}` : '')
    : p.t.slice(0,2) + ':' + p.t.slice(2) + '  价 ' + f2(p.price) + '  ' + pct(pctv)
      + '  均价 ' + f2(p.avg) + '  偏离 ' + (bias >= 0 ? '+' : '') + bias.toFixed(2) + '%'
      + (hoverBenchPct != null ? `  ${benchName} ${hoverBenchPct >= 0 ? '+' : ''}${hoverBenchPct.toFixed(2)}%(Alpha ${hoverAlpha >= 0 ? '+' : ''}${hoverAlpha.toFixed(2)}%)` : '')
      + '  量 ' + p.vol + '手'
      + (nearSig ? `  | ${sigTag}` : '');
  ctx.textAlign = 'left';
  const row1MaxW = radarBadgeW > 0 ? (W - PR - radarBadgeW - PL - 6) : (W - PL - 4);
  chipText(ctx, row, PL, 12, pctv >= 0 ? CH.up : CH.dn, 'rgba(255,255,255,.95)', row1MaxW);

  const row2Parts = [
    '昨收 ' + f2(prev),
    '量比 ' + nf(+s.vr, 2),
    '换手 ' + (s._ta && s._ta.turnover ? s._ta.turnover.toFixed(2) + '%' : '—'),
    radar.badge,
  ];
  if (latestAlpha != null) {
    row2Parts.push(`${ latestAlpha >= 0 ? '🔥强于' : '❄️弱于' }${benchName} ${latestAlpha >= 0 ? '+' : ''}${latestAlpha.toFixed(2)}%`);
  }
  if (cost > 0) row2Parts.push((isNarrow ? '成本 ¥' : '持仓成本 ¥') + f2(cost));
  if (bePrice > 0) row2Parts.push((isNarrow ? '保本 ¥' : '做T保本 ¥') + f2(bePrice));
  let row2Line = '';
  for (let i = 0; i < row2Parts.length; i++) {
    const cand = row2Line ? (row2Line + (isNarrow ? '  ' : '　') + row2Parts[i]) : row2Parts[i];
    if (ctx.measureText(cand).width > W - PL - 12 && row2Line) break;
    row2Line = cand;
  }
  chipText(ctx, row2Line, PL, 27, CH.txt, 'rgba(255,255,255,.95)', W - PL - 4);
}

/* ===================== 图表工具条（周期 / 叠加 / 副图） ===================== */
export function kbarHTML(i, s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const sub = s.sub || 'macd';
  const rt = p === 'rt';
  return `<div class="kbar k-main">`
    + `<span class="lbl">周期</span>` + PERIODS.filter(([k])=>P_MAIN_KEYS.indexOf(k)>=0).map(([k,v])=>
        `<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `<details class="pd-more"><summary>更多 ▾</summary><div class="pd-pop">`
    + P_MORE.map(([k,v])=>`<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `</div></details>`
    + (rt ? `<span class="sp"></span><span class="lbl">分时图：241格全天轴 / 价格线 / 均价线 / 大盘对比</span>`
          : `<span class="sp"></span>`
          + `<span class="lbl">叠加</span>` + Object.keys(OV_DEF).map(k=>
              `<span class="chip ov${ov[k]?' on':''}" data-ovl="${i}" data-v="${k}">${OV_DEF[k]}</span>`).join('')
          + `<span class="sp"></span>`
          + `<span class="lbl">副图</span>` + Object.keys(SUB_DEF).map(k=>
              `<span class="chip sb${sub===k?' on':''}" data-sub="${i}" data-v="${k}">${SUB_DEF[k]}</span>`).join(''))
    + `<span class="sp"></span>`
    + `<span class="chip${(s._dd&&s._dd.dd)?' on':''}" data-ddload="${i}" title="拉取当日逐笔成交，按单笔金额分档统计主力/大单净额与净量（约 1 秒）">💰 大单资金</span>`
    + `<span class="rd" id="kmeta-${i}">${chartMeta(s)}</span>`
    + `</div>`;
}
export function chartMeta(s){
  const p = s.p || 'day';
  s._k = s._k || {};
  let e = s._k[p];
  if ((!e || (e.kind === 'bar' && (!e.ks || !e.ks.length))) && p === 'day' && s._ks && s._ks.length) {
    s._k['day'] = chartEntry('bar', { ks: s._ks });
    e = s._k['day'];
  }
  if (!e) return '待取数';
  const n = e.kind === 'line' ? ((e.min && e.min.pts.length) || 0) : ((e.ks && e.ks.length) || 0);
  return (PERIOD_LABEL[p] || p) + ' · ' + n + (e.kind === 'line' ? '/241 分钟' : ' 根') + ' · ' + new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false});
}
export function chartLegendHTML(s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const it = (t, c)=> `<span><i style="background:${c}"></i>${t}</span>`;
  const it2 = (t, c1, c2)=> `<span><i style="background:linear-gradient(90deg,${c1} 0 50%,${c2} 50% 100%)"></i>${t}</span>`;
  const out = [];
  if (p === 'rt'){
    const bName = s._rtSignals?.benchName || '大盘';
    out.push(it2('价格线', CH.up, CH.dn), it('均价线', CH.avg), it(`${bName}对比(虚线)`, '#64748b'), it2('分时量', CH.up, CH.dn));
    if (+s.cost > 0) out.push(it('持仓成本', CH.cost));
    if (+s.bePrice > 0) out.push(it('做T保本', '#d97706'));
    out.push(it('推荐买区(红带)', 'rgba(220,38,38,0.40)'), it('推荐卖区(绿带)', 'rgba(22,163,74,0.40)'));
    out.push(it('●确认/◐预备买点(点按带单)', '#dc2626'), it('●确认/◐预备卖点(点按带单)', '#16a34a'));
    out.push(it('◆ 实盘B买', '#b91c1c'), it('◆ 实盘S卖', '#15803d'));
    if (s._distRadar) {
      out.push(it(s._distRadar.badge, s._distRadar.color));
    }
  } else {
    if (ov.ma) out.push(it('MA5',CH.ma5), it('MA10',CH.ma10), it('MA20',CH.ma20), it('MA60',CH.ma60));
    if (ov.boll) out.push(it('BOLL 上/下轨', CH.bollU), it('BOLL 中轨', CH.bollM));
    out.push(it2('成交量', CH.up, CH.dn), it('VMA5', CH.vma));
  }
  if (ov.box) out.push(it('20日箱体', CH.box));
  if (ov.cost && +s.cost > 0) out.push(it('持仓成本', CH.cost));
  if (ov.sr) out.push(it('压力位', CH.sr), it('支撑位', CH.dn));
  return `<div class="k-legend">${out.join('')}</div>`;
}
export function chartStat(s){
  const ta = s._ta;
  const p = s.p || 'day';
  const e = (s._k || {})[p];
  const cell = (k, v, cls)=> `<span class="st${cls?' '+cls:''}"><em>${k}</em><b>${v}</b></span>`;
  const out = [];
  if (p === 'rt'){
    const mn = e && e.min;
    if (mn && mn.pts.length){
      const lastP = mn.pts[mn.pts.length-1];
      const prev = mn.prev || +s.prevClose;
      const bias = lastP.avg > 0 ? ((lastP.price/lastP.avg - 1)*100) : 0;
      out.push(cell('现价', f2(lastP.price), lastP.price >= prev ? 'up' : 'dn'));
      out.push(cell('均价', f2(lastP.avg), lastP.price >= lastP.avg ? 'up' : 'dn'));
      out.push(cell('偏离度', (bias >= 0 ? '+' : '') + bias.toFixed(2) + '%', bias >= 0 ? 'up' : 'dn'));
      if (s._rtSignals && s._rtSignals.alphaPct != null) {
        const al = s._rtSignals.alphaPct;
        const bName = s._rtSignals.benchName || '大盘';
        out.push(cell(`超额vs${bName}`, (al >= 0 ? '+' : '') + al.toFixed(2) + '%', al >= 0 ? 'up' : 'dn'));
      }
      if (+s.cost > 0) out.push(cell('持仓成本', '¥' + f2(s.cost)));
      if (+s.bePrice > 0) out.push(cell('做T保本', '¥' + f2(s.bePrice), lastP.price >= s.bePrice ? 'up' : 'dn'));
      if (s._distRadar) {
        out.push(cell('主力雷达', s._distRadar.badge, s._distRadar.level === 'danger' ? 'up' : s._distRadar.level === 'warn' ? 'warn' : 'dn'));
      }
      const totV = (mn.pts[mn.pts.length-1] && (mn.pts.reduce((a,x)=>a+x.vol,0))) || 0;
      out.push(cell('分时量', totV >= 10000 ? (totV/10000).toFixed(2) + '万手' : totV + '手'));
    }
  }
  if (ta){
    if (ta.turnover) out.push(cell('换手率', ta.turnover.toFixed(2) + '%'));
    out.push(cell('量比', nf(+s.vr, 2)));
    if (ta.bl && ta.bl.up != null) out.push(cell('BOLL', nf(ta.bl.dn) + ' / ' + nf(ta.bl.mid) + ' / ' + nf(ta.bl.up)));
    if (ta.r && ta.r.r6 != null) out.push(cell('RSI6', ta.r.r6.toFixed(1), ta.r.r6 >= 70 ? 'up' : ta.r.r6 <= 30 ? 'dn' : ''));
    if (ta.bwDelta != null) out.push(cell('带宽', ta.bl.bw != null ? ta.bl.bw.toFixed(2) + '%' : '—', ta.bwDelta > 8 ? 'up' : ta.bwDelta < -8 ? 'dn' : ''));
  }
  if (s._dd && s._dd.dd){
    const d = s._dd.dd;
    out.push(cell('主力净额', (d.main.net >= 0 ? '+' : '') + money$(d.main.net), d.main.net >= 0 ? 'up' : 'dn'));
    out.push(cell('大单净量', (d.main.netv >= 0 ? '+' : '') + d.main.netv.toFixed(0) + '手', d.main.netv >= 0 ? 'up' : 'dn'));
  }
  if (ta && ta.levels && (ta.levels.res.length || ta.levels.sup.length)){
    const r1 = ta.levels.res[0], s1 = ta.levels.sup[0];
    if (s1) out.push(cell('支撑', f2(s1.p) + ' ' + s1.label + '(' + s1.strength + ')', 'dn'));
    if (r1) out.push(cell('压力', f2(r1.p) + ' ' + r1.label + '(' + r1.strength + ')', 'up'));
  }
  if (!out.length) return '';
  return `<div class="k-stat">${out.join('')}</div>`;
}
