/* ============================================================
   A股做T执行台 · 15:05 盘后一键收盘归档与明日预案引擎 (eod.js)
   串联五步闭环：收盘行情同步 -> 未平T/隔夜仓与节前长假超限核查 -> 净值快照落盘
                -> 今日量化复盘与节前降仓/节后首日竞价减仓简报 -> 本地磁盘金库双写
   ============================================================ */

import { STORAGE_KEYS } from '../data/site.js';
import { f2, money, todayStr, nowTimeHHMM, getTodayTStatus } from './utils.js';
import { calc, MKT } from './api.js';
import { computeDisciplineScorecard } from './ledger.js';
import { getAShareMarketStatus, isAShareTradeDay, getCNClock, nextAShareTradeDate, getUpcomingHolidayReminder } from './calendar.js';
import { evaluateHolidayPositionGuard } from './risk.js';

const MAX_EOD_ARCHIVES = 30;

const EOD_MISTAKE_LABELS = {
  pre_holiday_overcap: '🏮节前长假超限建仓',
  fomo_chase: '🚀追高天花板',
  no_stoploss: '🛡️破位死扛',
  t_to_add: '🔄做T变加仓',
  early_exit: '🕊️过早卖飞',
  against_trend: '🚨逆市顶风',
  heavy_gamble: '💣短线重仓单赌',
  impulse_t: '⚡无量乱T',
  revenge_trade: '💢报复交易',
  lone_wolf: '🐺孤狼单打',
  late_chase: '⏰滞后接盘',
  averaging_down: '🩸浮亏死补',
  hold_past_3red: '🥀连红三日不减',
  t1_illusion_hold: '🪞T+1收绿幻想',
  backrow_laggard: '🗑️买后排补涨',
};

export function loadEodArchives() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EOD_ARCHIVE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {}
  return [];
}

export function saveEodArchives(list) {
  const trimmed = (Array.isArray(list) ? list : []).slice(0, MAX_EOD_ARCHIVES);
  try {
    localStorage.setItem(STORAGE_KEYS.EOD_ARCHIVE, JSON.stringify(trimmed));
  } catch (_) {}
  return trimmed;
}

/**
 * 判断当前是否处于交易日 15:00 收盘后归档窗口（自动排除周末与法定节假日）
 */
export function isPostMarketWindowNow(now = new Date()) {
  const ck = getCNClock(now);
  return isAShareTradeDay(now) && ck.mins >= 15 * 60;
}

/**
 * 构建节前连续长假超上限持仓的分标的减仓配额建议（按 100 股整手向上取整覆盖超额敞口）
 * 优先级：尾盘隔夜短线仓 -> 技术破位锁标的 -> 短线进攻池 -> 稳健底仓池（同级按持仓市值从大到小）
 */
export function buildPreHolidayReductionTargets({
  holdingSummary = [],
  overnightTailList = [],
  excessAmt = 0,
} = {}) {
  const needTrim = Math.max(0, Math.round(Number(excessAmt) || 0));
  if (needTrim <= 0) return [];

  const candidates = [
    ...(Array.isArray(overnightTailList) ? overnightTailList : []).map((t) => ({
      code: t.code,
      name: t.name,
      isTail: true,
      brokenLock: false,
      tier: 'short',
      shares: Math.max(0, Math.round(+t.shares || 0)),
      price: +t.price || +t.cost || 0,
      mktVal: +t.mktVal || (+t.shares || 0) * (+t.price || +t.cost || 0),
      refAnchor: +t.tp1 || +t.price || +t.cost || 0,
      stopAnchor: +t.stop || +t.cost || 0,
      priority: 1,
    })),
    ...(Array.isArray(holdingSummary) ? holdingSummary : []).map((h) => ({
      code: h.code,
      name: h.name,
      isTail: false,
      brokenLock: Boolean(h.brokenLock),
      tier: h.tier || 'short',
      shares: Math.max(0, Math.round(+h.shares || 0)),
      price: +h.price || +h.cost || 0,
      mktVal: +h.mktVal || (+h.shares || 0) * (+h.price || +h.cost || 0),
      refAnchor: +h.outA || +h.tp1 || +h.price || 0,
      stopAnchor: +h.slA || +h.price || 0,
      priority: h.brokenLock ? 2 : h.tier === 'short' ? 3 : 4,
    })),
  ]
    .filter((c) => c.shares > 0 && c.price > 0)
    .sort((a, b) => a.priority - b.priority || b.mktVal - a.mktVal);

  let remainingAmt = needTrim;
  const targets = [];

  for (const c of candidates) {
    if (remainingAmt <= 0) break;
    let trimShares = 0;
    if (c.isTail && c.mktVal <= remainingAmt * 1.25) {
      trimShares = c.shares;
    } else if (c.shares <= 100) {
      trimShares = c.shares;
    } else {
      const lotsNeeded = Math.ceil(remainingAmt / (c.price * 100)) * 100;
      trimShares = Math.min(c.shares, Math.max(100, lotsNeeded));
    }
    const trimAmt = Math.round(trimShares * c.price);
    const remainShares = Math.max(0, c.shares - trimShares);
    remainingAmt = Math.max(0, remainingAmt - trimAmt);
    targets.push({
      code: c.code,
      name: c.name,
      isTail: c.isTail,
      brokenLock: c.brokenLock,
      shares: c.shares,
      trimShares,
      remainShares,
      price: c.price,
      trimAmt,
      refAnchor: +Number(c.refAnchor || c.price).toFixed(2),
      stopAnchor: +Number(c.stopAnchor || c.price).toFixed(2),
    });
  }

  return targets;
}

/**
 * 步骤 2：盘后持仓、未平T仓、首日T+1锁仓、尾盘隔夜仓与节前长假控仓上限全量体检
 */
export function inspectPostMarketPositions({
  pool = [],
  tailActives = [],
  tradeLogs = [],
  totalAssets = null,
  availableCash = 0,
  allowedCapPct = 80,
  date = todayStr(),
  holidayReminder = undefined,
} = {}) {
  const unclosedTList = [];
  const t1LockedList = [];
  const holdingSummary = [];
  const watchSummary = [];

  (Array.isArray(pool) ? pool : []).forEach((s) => {
    if (!s) return;
    const code6 = String(s.code || '').padStart(6, '0');
    const shares = Math.max(0, Math.round(+s.shares || 0));
    const px = +s.price || +s.cost || +s.prevClose || 0;
    const pc = +s.prevClose || px;
    const cost = +s.cost || 0;
    const dayChgPct = pc > 0 ? ((px - pc) / pc) * 100 : 0;

    let plan = null;
    try {
      if (pc > 0 || px > 0) {
        // 以今日收盘价作为下一交易日锚定昨收的近似推演
        const tomorrowSeed = {
          ...s,
          prevClose: px > 0 ? px : pc,
          open: px > 0 ? px : pc,
          high: px > 0 ? px * 1.02 : pc,
          low: px > 0 ? px * 0.98 : pc,
          price: px > 0 ? px : pc,
          avg: px > 0 ? px : pc,
        };
        plan = calc(tomorrowSeed);
      }
    } catch (_) {
      plan = null;
    }

    const tStat = getTodayTStatus(s, tradeLogs);
    if (tStat.hasUnclosed && tStat.sellableShares > 0) {
      unclosedTList.push({
        code: code6,
        name: s.name || code6,
        unclosedShares: tStat.unclosedShares,
        sellableShares: tStat.sellableShares,
        price: px,
        cost,
        stock: s,
      });
    }
    if (tStat.isFirstDayLocked && tStat.t1LockedShares > 0) {
      t1LockedList.push({
        code: code6,
        name: s.name || code6,
        lockedShares: tStat.t1LockedShares,
        price: px,
        cost,
      });
    }

    const item = {
      code: code6,
      name: s.name || code6,
      tier: s.tier === 'short' || s.tier === 'long' ? s.tier : s.poolTag === '稳健' ? 'long' : 'short',
      shares,
      cost,
      price: px,
      dayChgPct: Math.round(dayChgPct * 100) / 100,
      mktVal: Math.round(shares * px * 100) / 100,
      floatPnl: shares > 0 && cost > 0 ? Math.round((px - cost) * shares * 100) / 100 : 0,
      floatPct: shares > 0 && cost > 0 ? Math.round(((px - cost) / cost) * 10000) / 100 : 0,
      inA: plan ? +plan.inA.toFixed(2) : +(px * 0.985).toFixed(2),
      inB: plan ? +plan.inB.toFixed(2) : +(px * 0.972).toFixed(2),
      outA: plan ? +plan.outA.toFixed(2) : +(px * 1.018).toFixed(2),
      tp1: plan ? +plan.tp1.toFixed(2) : +(px * 1.028).toFixed(2),
      slA: plan ? +plan.slA.toFixed(2) : +(px * 0.985).toFixed(2),
      brokenLock: Boolean(plan?.brokenLock),
    };

    if (shares > 0) holdingSummary.push(item);
    else watchSummary.push(item);
  });

  const overnightTailList = (Array.isArray(tailActives) ? tailActives : [])
    .filter((t) => t && t.status !== 'closed' && +t.shares > 0)
    .map((t) => {
      const px = +t.price || +t.cost || 0;
      const cost = +t.cost || px;
      const sh = Math.round(+t.shares || 0);
      return {
        id: t.id,
        code: String(t.code || '').padStart(6, '0'),
        name: t.name || t.code,
        shares: sh,
        cost,
        price: px,
        mktVal: Math.round(px * sh * 100) / 100,
        floatPnl: Math.round((px - cost) * sh * 100) / 100,
        tp1: +(t.tp1 || cost * 1.028).toFixed(2),
        tp2: +(t.tp2 || cost * 1.05).toFixed(2),
        stop: +(t.stop || cost * 1.0 ? (t.stop || cost * 0.98) : 0).toFixed(2),
      };
    });

  const totalMkt = Math.round(
    (holdingSummary.reduce((acc, x) => acc + (x.mktVal || 0), 0) +
      overnightTailList.reduce((acc, x) => acc + (x.mktVal || 0), 0)) *
      100
  ) / 100;
  const inferredAssets =
    totalAssets !== null && totalAssets !== undefined && Number.isFinite(+totalAssets) && +totalAssets > 0
      ? +totalAssets
      : totalMkt + Math.max(0, Number(availableCash) || 0) > 0
      ? totalMkt + Math.max(0, Number(availableCash) || 0)
      : 100000;
  const totalPosPct = inferredAssets > 0 ? +((totalMkt / inferredAssets) * 100).toFixed(1) : 0;

  const resolvedReminder =
    holidayReminder !== undefined ? holidayReminder : getUpcomingHolidayReminder(date);
  const rawHolidayGuard = evaluateHolidayPositionGuard({
    totalPosPct,
    totalMkt,
    totalAssets: inferredAssets,
    emotionCapPct: allowedCapPct ?? 80,
    holidayReminder: resolvedReminder,
    now: date,
  });

  const nextTradeDate = nextAShareTradeDate(date);
  const reductionTargets = rawHolidayGuard.isYellowCard
    ? buildPreHolidayReductionTargets({
        holdingSummary,
        overnightTailList,
        excessAmt: rawHolidayGuard.excessAmt,
      })
    : [];

  const holidayGuard = {
    ...rawHolidayGuard,
    totalPosPct,
    totalMkt,
    totalAssets: inferredAssets,
    nextTradeDate,
    reductionTargets,
  };

  return {
    unclosedTList,
    t1LockedList,
    overnightTailList,
    holdingSummary,
    watchSummary,
    holidayGuard,
    nextTradeDate,
    hasUnclosedWarning: unclosedTList.length > 0,
    hasHolidayOvercapWarning: Boolean(holidayGuard.isYellowCard),
  };
}

/**
 * 步骤 3：计算并归档当日收盘资产净值快照
 */
export function buildPostMarketSnapshot({
  date = todayStr(),
  pool = [],
  tailActives = [],
  availableCash = 0,
  initialCapital = 100000,
  prevSnapshots = [],
}) {
  const poolMkt = (Array.isArray(pool) ? pool : []).reduce(
    (acc, s) => acc + (+s.shares || 0) * (+s.price || +s.cost || 0),
    0
  );
  const tailMkt = (Array.isArray(tailActives) ? tailActives : []).reduce(
    (acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)),
    0
  );
  const mkt = Math.round((poolMkt + tailMkt) * 100) / 100;
  const cash = Math.max(0, Math.round((+availableCash || 0) * 100) / 100);
  const total = Math.round((cash + mkt) * 100) / 100;
  const posRateNum = total > 0 ? Math.round((mkt / total) * 1000) / 10 : 0;

  // 查找上一个非今日的历史快照核算单日净值涨跌
  const sortedPrev = [...(Array.isArray(prevSnapshots) ? prevSnapshots : [])]
    .filter((x) => x && x.date && x.date < date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lastSnap = sortedPrev[0] || null;
  const refBase = lastSnap && +lastSnap.total > 0 ? +lastSnap.total : (+initialCapital || 100000);
  const dayDelta = Math.round((total - refBase) * 100) / 100;
  const dayDeltaPct = refBase > 0 ? Math.round(((total - refBase) / refBase) * 10000) / 100 : 0;

  const initBase = +initialCapital > 0 ? +initialCapital : 100000;
  const cumReturn = Math.round((total - initBase) * 100) / 100;
  const cumReturnPct = Math.round(((total - initBase) / initBase) * 10000) / 100;

  const snapshot = {
    date,
    total,
    mkt,
    poolMkt: Math.round(poolMkt * 100) / 100,
    tailMkt: Math.round(tailMkt * 100) / 100,
    cash,
    rate: posRateNum.toFixed(1),
    dayDelta,
    dayDeltaPct,
    archivedAt: nowTimeHHMM(),
  };

  const nextSnapshots = [
    snapshot,
    ...(Array.isArray(prevSnapshots) ? prevSnapshots : []).filter((x) => x && x.date !== date),
  ];

  return {
    snapshot,
    nextSnapshots,
    deltaInfo: {
      refDate: lastSnap ? lastSnap.date : '初始本金',
      refTotal: refBase,
      dayDelta,
      dayDeltaPct,
      cumReturn,
      cumReturnPct,
    },
  };
}

/**
 * 盘后复盘核心评估：当日主力先导强共振 (3维/4维 P1) 信号命中回顾 × 实盘做T执行对照
 * - 零前视偏差（Zero-Look-Behind）：仅统计信号触发时刻及之后的分时极值与收盘价，绝不把早盘前高算作午后信号命中
 * - 自动剥离演练：自动剔除 isDrill / [演练] 模拟信号，确保实盘命中率干净真实
 * - 四象限知行对照：顺向果断执行 / 守纪避坑观望 / 踏空好球 / 逆向违背先导
 */
export function evaluateLeadingResonanceReview({
  date = todayStr(),
  alertRecords = null,
  pool = [],
  todayLogs = [],
} = {}) {
  const rawAlerts = Array.isArray(alertRecords)
    ? alertRecords
    : (() => {
        try {
          if (typeof localStorage !== 'undefined') {
            const parsed = JSON.parse(localStorage.getItem('t-system-alerts') || '[]');
            return Array.isArray(parsed) ? parsed : [];
          }
        } catch (_) {}
        return [];
      })();

  const fmtLocalDate = (ts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return getCNClock(d).dateStr;
  };

  const resolveAlertDate = (a) => {
    if (a?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.date))) return String(a.date);
    if (typeof a?.id === 'number' && a.id > 1700000000000) return fmtLocalDate(Math.floor(a.id));
    return '';
  };

  const isDrillAlert = (a) =>
    Boolean(
      a?.isDrill ||
        String(a?.summary || '').trim().startsWith('[演练]') ||
        String(a?.label || '').includes('演练')
    );

  const toHHMM = (timeStr) => {
    const digits = String(timeStr || '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(0, 4) : '';
  };

  const hhmmToMins = (hhmm) => {
    if (!/^\d{4}$/.test(hhmm)) return null;
    return +hhmm.slice(0, 2) * 60 + +hhmm.slice(2, 4);
  };

  const sameDayLeading = rawAlerts.filter(
    (a) => a && a.category === 'leading' && resolveAlertDate(a) === date
  );
  const drillFilteredCount = sameDayLeading.filter(isDrillAlert).length;
  const realSignals = sameDayLeading
    .filter((a) => !isDrillAlert(a))
    .slice()
    .sort((a, b) => {
      const ta = toHHMM(a.time);
      const tb = toHHMM(b.time);
      if (ta !== tb) return ta.localeCompare(tb);
      return (+a.id || 0) - (+b.id || 0);
    });

  const poolMap = new Map();
  (Array.isArray(pool) ? pool : []).forEach((s) => {
    if (!s) return;
    const c6 = String(s.code || '').replace(/\D/g, '').padStart(6, '0');
    if (/^\d{6}$/.test(c6)) poolMap.set(c6, s);
  });

  const logsByCode = new Map();
  (Array.isArray(todayLogs) ? todayLogs : []).forEach((lg) => {
    if (!lg || (lg.date && lg.date !== date)) return;
    let c6 = String(lg.code || '').replace(/\D/g, '').padStart(6, '0');
    if (!/^\d{6}$/.test(c6) || c6 === '000000') {
      const m = String(lg.stock || '').match(/(\d{6})/);
      c6 = m ? m[1] : '';
    }
    if (!c6) return;
    if (!logsByCode.has(c6)) logsByCode.set(c6, []);
    logsByCode.get(c6).push(lg);
  });

  const BUY_DIRS = new Set(['正T', '做T', '买入建仓', '底仓建仓', '买入加仓', '直接买入', '尾盘买入']);
  const SELL_DIRS = new Set(['倒T', '直接卖出', '清仓卖出', '尾盘平仓']);
  const PURE_SELL_DIRS = new Set(['直接卖出', '清仓卖出']);

  const compactDate = String(date || '').replace(/\D/g, '').slice(0, 8);
  const countedNetLogIds = new Set();

  let bullCount = 0;
  let bearCount = 0;
  let hitCount = 0;
  let favorableSum = 0;
  let alignedCount = 0;
  let alignedNetSum = 0;
  let missedCount = 0;
  let contraryCount = 0;
  let disciplinedPassCount = 0;

  const items = realSignals.map((sig) => {
    const code6 = String(sig.code || '').replace(/\D/g, '').padStart(6, '0');
    const st = poolMap.get(code6) || null;
    const dir = sig.leadDir === 'bear' || sig.anomalyType === 'lead_bear_resonance' ? 'bear' : 'bull';
    if (dir === 'bull') bullCount += 1;
    else bearCount += 1;

    const trigPx = +sig.price > 0 ? +sig.price : +(st?.price || 0);
    const closePx = +(st?.price || trigPx || 0);
    const trigHHMM = toHHMM(sig.time);
    const sigMins = hhmmToMins(trigHHMM);

    let sessionPts = [];
    if (Array.isArray(st?._rtPts) && st._rtPts.length > 0) {
      sessionPts = st._rtPts;
    } else if (
      Array.isArray(st?._k?.rt?.min?.pts) &&
      st._k.rt.min.pts.length > 0 &&
      (!st._k.rt.min.date ||
        String(st._k.rt.min.date).replace(/\D/g, '').slice(0, 8) === compactDate)
    ) {
      sessionPts = st._k.rt.min.pts;
    }

    const postPts = sessionPts.filter(
      (pt) => pt && +pt.price > 0 && (!trigHHMM || String(pt.t || '').slice(0, 4) >= trigHHMM)
    );
    const hasPostMinuteTrack = postPts.length > 0;
    const maxAfterPx = hasPostMinuteTrack
      ? Math.max(closePx, ...postPts.map((p) => +p.price))
      : closePx;
    const minAfterPx = hasPostMinuteTrack
      ? Math.min(closePx, ...postPts.map((p) => +p.price))
      : closePx;

    let hit = false;
    let peakGainPct = 0;
    let troughDropPct = 0;
    let closeMovePct = 0;
    let favorablePct = 0;
    let outcomeNote = '暂无收盘对照价';

    if (trigPx > 0 && closePx > 0) {
      closeMovePct = +(((closePx - trigPx) / trigPx) * 100).toFixed(2);
      if (dir === 'bull') {
        peakGainPct = +(((maxAfterPx - trigPx) / trigPx) * 100).toFixed(2);
        favorablePct = Math.max(peakGainPct, closeMovePct);
        hit = peakGainPct >= 0.8 || closeMovePct >= 0.45;
        outcomeNote = hasPostMinuteTrack
          ? `信号后最高 ¥${f2(maxAfterPx)}(${peakGainPct >= 0 ? '+' : ''}${peakGainPct.toFixed(2)}%) · 收 ¥${f2(closePx)}(${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`
          : `收盘 ¥${f2(closePx)}(较触发 ${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`;
      } else {
        troughDropPct = +(((minAfterPx - trigPx) / trigPx) * 100).toFixed(2);
        favorablePct = +Math.max(-troughDropPct, -closeMovePct).toFixed(2);
        hit = troughDropPct <= -0.8 || closeMovePct <= -0.45;
        outcomeNote = hasPostMinuteTrack
          ? `信号后最低 ¥${f2(minAfterPx)}(${troughDropPct >= 0 ? '+' : ''}${troughDropPct.toFixed(2)}%) · 收 ¥${f2(closePx)}(${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`
          : `收盘 ¥${f2(closePx)}(较触发 ${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`;
      }
    }

    if (hit) hitCount += 1;
    favorableSum += favorablePct;

    const stockLogs = logsByCode.get(code6) || [];
    const relevantLogs = stockLogs.filter((lg) => {
      const lm = hhmmToMins(toHHMM(lg.time));
      if (sigMins == null || lm == null) return true;
      return lm >= sigMins - 3;
    });

    const bullExecLogs = relevantLogs.filter((lg) => BUY_DIRS.has(String(lg.dir || '')));
    const bearExecLogs = relevantLogs.filter((lg) => SELL_DIRS.has(String(lg.dir || '')));
    const pureSellLogs = relevantLogs.filter((lg) => PURE_SELL_DIRS.has(String(lg.dir || '')));

    let execStatus = 'DISCIPLINED_PASS';
    let execBadge = '🧘 观望未动';
    let execDetail = '信号后未产生交易流水';
    let tradeNet = 0;

    if (dir === 'bull') {
      if (bullExecLogs.length > 0) {
        execStatus = 'ALIGNED_EXEC';
        execBadge = '✅ 顺向低吸执行';
        alignedCount += 1;
        const first = bullExecLogs[0];
        const totalQty = bullExecLogs.reduce((acc, x) => acc + (+x.qty || 0), 0);
        const closedTrades = bullExecLogs.filter((x) => +x.sell > 0);
        tradeNet = Math.round(
          closedTrades.reduce((acc, x) => acc + (+x.net || 0), 0) * 100
        ) / 100;
        closedTrades.forEach((x) => {
          const lid = x.id || `${x.time}-${x.qty}-${x.buy}`;
          if (!countedNetLogIds.has(lid)) {
            countedNetLogIds.add(lid);
            alignedNetSum += +x.net || 0;
          }
        });
        execDetail = `${first.dir} ${totalQty}股 · 买¥${f2(first.buy)}${
          closedTrades.length > 0
            ? ` · 净落袋 ${tradeNet >= 0 ? '+' : ''}¥${money(tradeNet)}`
            : ' · 持仓待兑现'
        }`;
      } else if (
        pureSellLogs.length > 0 &&
        hit &&
        +pureSellLogs[0].sell > 0 &&
        +pureSellLogs[0].sell <= trigPx * 1.003
      ) {
        execStatus = 'CONTRARY_EXEC';
        execBadge = '🚨 逆向地板卖飞';
        contraryCount += 1;
        execDetail = `${pureSellLogs[0].dir} ${pureSellLogs[0].qty}股 @¥${f2(
          pureSellLogs[0].sell
        )}（先导暗吸共振区过早抛售卖飞）`;
      } else if (hit) {
        execStatus = 'MISSED_OPPORTUNITY';
        execBadge = '👀 踏空好球';
        missedCount += 1;
        execDetail = `先导看多共振已兑现(+${favorablePct.toFixed(2)}%)，盘中未出手低吸`;
      } else {
        execStatus = 'DISCIPLINED_PASS';
        execBadge = '🧘 观望避险';
        disciplinedPassCount += 1;
        execDetail = `信号后未走出有效空间(${peakGainPct >= 0 ? '+' : ''}${peakGainPct.toFixed(
          2
        )}%)，未盲动省下规费`;
      }
    } else {
      if (bearExecLogs.length > 0) {
        execStatus = 'ALIGNED_EXEC';
        execBadge = '✅ 顺向高抛锁盈';
        alignedCount += 1;
        const first = bearExecLogs[0];
        const totalQty = bearExecLogs.reduce((acc, x) => acc + (+x.qty || 0), 0);
        tradeNet = Math.round(
          bearExecLogs.reduce((acc, x) => acc + (+x.net || 0), 0) * 100
        ) / 100;
        bearExecLogs.forEach((x) => {
          const lid = x.id || `${x.time}-${x.qty}-${x.sell}`;
          if (!countedNetLogIds.has(lid)) {
            countedNetLogIds.add(lid);
            alignedNetSum += +x.net || 0;
          }
        });
        execDetail = `${first.dir} ${totalQty}股 · 卖¥${f2(first.sell)}${
          tradeNet !== 0 ? ` · 净额 ${tradeNet >= 0 ? '+' : ''}¥${money(tradeNet)}` : ''
        }`;
      } else if (bullExecLogs.length > 0) {
        execStatus = 'CONTRARY_EXEC';
        execBadge = '🚨 逆向误接诱多';
        contraryCount += 1;
        const first = bullExecLogs[0];
        execDetail = `${first.dir} ${first.qty}股 @¥${f2(
          first.buy
        )}（违背托单诱多/暗出预警逆势接盘）`;
      } else {
        execStatus = 'DISCIPLINED_PASS';
        execBadge = hit ? '🛡️ 守纪避坑' : '🧘 观望未动';
        disciplinedPassCount += 1;
        execDetail = hit
          ? `成功规避诱多回落(${troughDropPct.toFixed(2)}%)，严守纪律未接飞刀`
          : '诱多预警后保持克制，未盲目开新买单';
      }
    }

    const hitsDim = +sig.hits || 3;
    const scoreNum = +sig.leadScore || 0;
    const scoreTxt = sig.leadScoreTxt || (scoreNum > 0 ? `+${scoreNum}` : `${scoreNum}`);

    return {
      id: sig.id,
      time: String(sig.time || '—').slice(0, 8),
      code: code6,
      name: sig.name || st?.name || code6,
      dir,
      hits: hitsDim,
      label: sig.label || (dir === 'bull' ? `${hitsDim}维先导强共振` : `${hitsDim}维诱多暗出`),
      score: scoreNum,
      scoreTxt,
      tags: Array.isArray(sig.tags) ? sig.tags : [],
      triggerPrice: trigPx,
      targetPrice: +sig.target || trigPx,
      closePrice: closePx,
      maxAfterPx,
      minAfterPx,
      hasPostMinuteTrack,
      peakGainPct,
      troughDropPct,
      closeMovePct,
      favorablePct,
      hit,
      outcomeNote,
      execStatus,
      execBadge,
      execDetail,
      tradeNet,
    };
  });

  const totalCount = items.length;
  const hitRate = totalCount > 0 ? Math.round((hitCount / totalCount) * 100) : null;
  const avgFavorablePct =
    totalCount > 0 ? Math.round((favorableSum / totalCount) * 100) / 100 : 0;

  return {
    date,
    totalCount,
    bullCount,
    bearCount,
    hitCount,
    hitRate,
    avgFavorablePct,
    alignedCount,
    alignedNetSum: Math.round(alignedNetSum * 100) / 100,
    missedCount,
    contraryCount,
    disciplinedPassCount,
    drillFilteredCount,
    items,
  };
}

/**
 * 步骤 4：生成结构化「今日收盘量化复盘与下一交易日挂单/节前降仓/节后首日减仓简报」
 */
export function buildEodBriefMarkdown({
  date = todayStr(),
  snapshot,
  deltaInfo,
  todayLogs = [],
  pool = [],
  wbLatest = null,
  positionCheck,
  marketEnv = null,
  allowedCapPct = null,
  holidayReminder = undefined,
  coachReview = null,
  alertRecords = null,
}) {
  const envLv = marketEnv?.level || MKT?.gate?.level || 'OK';
  const envTitle = String(marketEnv?.text || MKT?.gate?.title || '大盘常态震荡').replace(/<[^>]+>/g, '');
  const resolvedEmoCap =
    allowedCapPct !== null && allowedCapPct !== undefined && Number.isFinite(+allowedCapPct) && +allowedCapPct > 0
      ? +allowedCapPct
      : envLv === 'BAD'
      ? 20
      : envLv === 'WARN'
      ? 50
      : 80;

  const snapTotal = +snapshot?.total > 0 ? +snapshot.total : 100000;
  const snapMkt = +snapshot?.mkt >= 0 ? +snapshot.mkt : 0;
  const snapRate = snapshot?.rate != null ? +snapshot.rate : snapTotal > 0 ? +((snapMkt / snapTotal) * 100).toFixed(1) : 0;

  const resolvedReminder =
    holidayReminder !== undefined ? holidayReminder : getUpcomingHolidayReminder(date);
  const nextTd = positionCheck?.nextTradeDate || nextAShareTradeDate(date);
  const holCheck = evaluateHolidayPositionGuard({
    totalPosPct: snapRate,
    totalMkt: snapMkt,
    totalAssets: snapTotal,
    emotionCapPct: resolvedEmoCap,
    holidayReminder: resolvedReminder,
    now: date,
  });

  const reductionTargets = holCheck.isYellowCard
    ? buildPreHolidayReductionTargets({
        holdingSummary: positionCheck?.holdingSummary || [],
        overnightTailList: positionCheck?.overnightTailList || [],
        excessAmt: holCheck.excessAmt,
      })
    : [];
  const reductionMap = new Map(reductionTargets.map((t) => [t.code, t]));

  const isHolidayEveLastDay = Boolean(holCheck.active && holCheck.remainingTradeDays === 1);
  const isHolidayEve2d = Boolean(holCheck.active && holCheck.remainingTradeDays === 2);
  const nextDayLabel = isHolidayEveLastDay
    ? `节后首日 (${holCheck.reopenDate || nextTd})`
    : `下一交易日 (${nextTd})`;

  let actionTitle = '';
  let actionSummary = '';
  if (holCheck.isYellowCard) {
    if (isHolidayEveLastDay) {
      actionTitle = `🏮 节后首日 (${holCheck.reopenDate}) 竞价减仓纠偏预案`;
      actionSummary = `明起进入${holCheck.holidayName}连休 ${holCheck.closedDays} 天（${holCheck.closureStart.slice(5)}~${holCheck.closureEnd.slice(5)}），当前收盘总仓位 ${snapRate.toFixed(1)}% 超出${holCheck.capSourceLabel} ${holCheck.excessPct}%（超额跨假敞口约 ¥${money(holCheck.excessAmt)}）。节后首日 (${holCheck.reopenDate}) 09:15~09:25 集合竞价核查量比与强弱：若高开脉冲量能不济，在竞价至 09:45 分批高抛回笼约 ¥${money(holCheck.excessAmt)} 压回 ≤${holCheck.effectiveCapPct}%；若受外围利空低开破止损线，反抽均价线无力果断减出超限敞口，严禁节后首日盲目补仓摊平。`;
    } else {
      actionTitle = `🏮 明日 (${nextTd}) 节前收官日早盘降仓预案`;
      actionSummary = `距${holCheck.holidayName}连休 ${holCheck.closedDays} 天仅剩最后 1 个交易日 (${nextTd})，当前收盘总仓位 ${snapRate.toFixed(1)}% 超出${holCheck.capSourceLabel} ${holCheck.excessPct}%（超额约 ¥${money(holCheck.excessAmt)}）。今日底仓与新开 T+1 仓位明日开盘全部解锁可卖，请趁明日 09:25 竞价至 10:30 早盘冲高优先兑现尾盘隔夜仓与弱势标的，至少回笼约 ¥${money(holCheck.excessAmt)} 将隔夜仓位压降至 ≤${holCheck.effectiveCapPct}%（${holCheck.posRangeLabel}），严禁明日尾盘超限偷袭赌假期消息。`;
    }
  }

  const holidayAudit = {
    active: holCheck.active,
    isYellowCard: holCheck.isYellowCard,
    holidayName: holCheck.holidayName,
    closedDays: holCheck.closedDays,
    remainingTradeDays: holCheck.remainingTradeDays,
    closureStart: holCheck.closureStart,
    closureEnd: holCheck.closureEnd,
    reopenDate: holCheck.reopenDate,
    nextTradeDate: nextTd,
    totalPosPct: snapRate,
    effectiveCapPct: holCheck.effectiveCapPct,
    holidayCapPct: holCheck.holidayCapPct,
    capSourceLabel: holCheck.capSourceLabel,
    posRangeLabel: holCheck.posRangeLabel,
    excessPct: holCheck.excessPct,
    excessAmt: holCheck.excessAmt,
    headroomAmt: holCheck.headroomAmt,
    actionTitle,
    actionSummary,
    reductionTargets,
  };

  const sc = computeDisciplineScorecard(todayLogs, pool, wbLatest);
  const closedToday = (todayLogs || []).filter(
    (l) => +l.buy > 0 && +l.sell > 0 && l.dir !== '买入建仓' && l.dir !== '底仓建仓' && l.dir !== '买入加仓' && l.dir !== '尾盘买入'
  );
  const todayRealizedNet = Math.round(
    closedToday.reduce((acc, l) => acc + (+l.net || 0), 0) * 100
  ) / 100;

  const leadingReview = evaluateLeadingResonanceReview({
    date,
    alertRecords,
    pool,
    todayLogs,
  });

  const lines = [];
  lines.push(`# 🏁 【15:05 收盘归档与作战简报】· ${date}`);
  lines.push('');
  lines.push(`### 一、账户收盘净值与环境水位`);
  lines.push(
    `- **收盘总资产**: ¥${money(snapshot.total)}（可用现金 ¥${money(snapshot.cash)} ｜ 持仓总市值 ¥${money(snapshot.mkt)} ｜ 总仓位 **${snapshot.rate}%**）`
  );
  lines.push(
    `- **单日净值变动**: 较${deltaInfo.refDate} **${deltaInfo.dayDelta >= 0 ? '+' : ''}¥${money(deltaInfo.dayDelta)} (${deltaInfo.dayDeltaPct >= 0 ? '+' : ''}${deltaInfo.dayDeltaPct.toFixed(2)}%)** ｜ 累计总收益 **${deltaInfo.cumReturn >= 0 ? '+' : ''}¥${money(deltaInfo.cumReturn)} (${deltaInfo.cumReturnPct >= 0 ? '+' : ''}${deltaInfo.cumReturnPct.toFixed(2)}%)**`
  );
  lines.push(
    `- **大盘环境闸门**: \`${envLv}\` · ${envTitle}${
      holCheck.active
        ? ` ｜ 🏮 **节前日历窗口**: 距${holCheck.holidayName}连休 ${holCheck.closedDays} 天剩 ${holCheck.remainingTradeDays} 个交易日（下一交易日 \`${nextTd}\`，控仓线 \`≤${holCheck.effectiveCapPct}%\`）`
        : ` ｜ 下一交易日 \`${nextTd}\``
    }`
  );
  lines.push('');

  lines.push(`### 二、未平 T 仓、隔夜持仓与节前控仓风控核查`);
  if (holCheck.isYellowCard) {
    lines.push(
      `- 🟨 **节前长假超上限持仓黄牌预警（超上限 ${holCheck.excessPct}% · 需减仓约 ¥${money(holCheck.excessAmt)}）**：`
    );
    lines.push(`  - **风险诊断**：${actionSummary}`);
    if (reductionTargets.length > 0) {
      lines.push(
        `  - **${isHolidayEveLastDay ? `节后首日 (${holCheck.reopenDate}) 09:25 竞价/早盘` : `明日 (${nextTd}) 早盘冲高`}分标的减仓配额建议**：`
      );
      reductionTargets.forEach((rt) => {
        const tag = rt.isTail ? '尾盘隔夜仓·优先清仓' : rt.brokenLock ? '破位防守·优先减出' : '超限敞口收敛';
        lines.push(
          `    - **${rt.name} (${rt.code})** [${tag}]：现持 ${rt.shares} 股 → 建议减持 **${rt.trimShares} 股**（回笼约 **¥${money(rt.trimAmt)}**，余 ${rt.remainShares} 股）｜ 冲高/竞价兑现锚 **¥${f2(rt.refAnchor)}** · 防守止损线 **¥${f2(rt.stopAnchor)}**`
        );
      });
    }
  } else if (holCheck.active) {
    lines.push(
      `- ✅ **节前长假控仓核查达标**：距${holCheck.holidayName}连休 ${holCheck.closedDays} 天剩 ${holCheck.remainingTradeDays} 个交易日，当前收盘总仓位 **${snapRate.toFixed(1)}%** 严守在 **≤${holCheck.effectiveCapPct}%（${holCheck.posRangeLabel}）** 红线内（安全余量约 ¥${money(holCheck.headroomAmt)}）。`
    );
  }

  if (positionCheck.unclosedTList.length > 0) {
    lines.push(
      `- 🚨 **未平做T仓滞留警报 (${positionCheck.unclosedTList.length} 只)**：以下标的今日买入T仓未在 15:00 前平出，已构成「做T变被动加仓」，${nextDayLabel}早盘冲高务必优先减出恢复原仓位：`
    );
    positionCheck.unclosedTList.forEach((u) => {
      lines.push(
        `  - **${u.name} (${u.code})**：滞留 **${u.unclosedShares} 股**（收盘 ¥${f2(u.price)}，持仓成本 ¥${f2(u.cost)}）`
      );
    });
  } else {
    lines.push(`- ✅ **日内做T清零核查通过**：今日无滞留未平T仓，严守「日内T绝不过夜变加仓」铁律。`);
  }

  if (positionCheck.overnightTailList.length > 0) {
    const tailWindowHint = isHolidayEveLastDay
      ? `${holCheck.reopenDate} 节后首日 09:25 竞价~10:00 必平 · 跨假锁仓 ${holCheck.closedDays} 天`
      : `${nextTd} 09:30~10:00 必平`;
    lines.push(
      `- ⚡ **尾盘黑马隔夜持仓 (${positionCheck.overnightTailList.length} 只 · ${tailWindowHint})**：`
    );
    positionCheck.overnightTailList.forEach((t) => {
      lines.push(
        `  - **${t.name} (${t.code})**：${t.shares} 股 ｜ 成本 ¥${f2(t.cost)} → 收盘 ¥${f2(t.price)}（浮盈 ${t.floatPnl >= 0 ? '+' : ''}¥${money(t.floatPnl)}）｜ 止盈1 **¥${f2(t.tp1)}** / 止损 **¥${f2(t.stop)}**`
      );
    });
  }

  if (positionCheck.t1LockedList.length > 0) {
    const unlockHint = isHolidayEveLastDay
      ? `受跨${holCheck.holidayName}长假 T+1 限制，将于节后首日 (${holCheck.reopenDate}) 开盘解锁可卖额度`
      : `将于 ${nextDayLabel} 开盘自动解锁可用可卖额度`;
    lines.push(
      `- 🔒 **今日首开底仓 T+1 冻结 (${positionCheck.t1LockedList.length} 只)**：${positionCheck.t1LockedList
        .map((x) => `${x.name}(${x.lockedShares}股)`)
        .join('、')} ${unlockHint}。`
    );
  }
  lines.push('');

  lines.push(`### 三、今日交割纪律体检 (${todayLogs.length} 笔流水)`);
  if (todayLogs.length === 0) {
    lines.push(
      `- 🧘 **零交易守纪日**：今日未产生盘中买卖流水。不到高胜率买点宁缺毋滥，节省了规费摩擦损耗，纪律分 **100/100**。`
    );
  } else {
    lines.push(
      `- **操盘纪律评分**: **${sc.totalScore}/100 分 (${sc.grade})** ｜ 已平仓净落袋 **${todayRealizedNet >= 0 ? '+' : ''}¥${money(todayRealizedNet)}** ｜ 主观情绪摩擦损耗 **¥${money(sc.frictionLoss)}**`
    );
    lines.push(
      `- **四维得分**: 买点精准 ${sc.buyScore}/25 · 止盈兑现 ${sc.sellScore}/25 · 止损铁律 ${sc.stopScore}/25 · 环境与仓位 ${sc.envScore}/25`
    );
    if (coachReview && coachReview.review) {
      lines.push('');
      lines.push(coachReview.review);
    } else {
      sc.enrichedLogs.forEach((lg, idx) => {
        const devTxt = lg.buyDevPct != null ? `，买点偏离 ${lg.buyDevPct >= 0 ? '+' : ''}${lg.buyDevPct}%` : '';
        const tagTxt =
          Array.isArray(lg.mistakeTags) && lg.mistakeTags.length > 0
            ? `，归因 [${lg.mistakeTags.map((t) => EOD_MISTAKE_LABELS[t] || t).join(' / ')}]`
            : '';
        lines.push(
          `- 第${idx + 1}笔 **${lg.stock}** (${lg.dir} ${lg.qty}股)：买 ¥${f2(lg.buy)} / 卖 ${lg.sell > 0 ? `¥${f2(lg.sell)}` : '持仓中'}，净额 **${lg.net >= 0 ? '+' : ''}¥${money(lg.net)}**（${lg.plan || '计划内'} · 纪律 ${lg.disciplineScore || 100}分${devTxt}${tagTxt}）`
        );
      });
    }
  }
  lines.push('');

  lines.push(`### 四、盘中主力先导强共振命中回顾与做T执行对照`);
  if (leadingReview.totalCount === 0) {
    lines.push(
      `- 📡 **今日无盘中 3维/4维主力先导强共振实盘触发**${
        leadingReview.drillFilteredCount > 0
          ? `（已自动过滤 ${leadingReview.drillFilteredCount} 条盘后演练记录，不计入实盘胜率）`
          : ''
      }：盘口未出现高确定性多维暗吸或诱多共振，按标准格位与均价线纪律执行即可。`
    );
  } else {
    lines.push(
      `- **信号命中总览**: 共触发 **${leadingReview.totalCount} 次** P1 先导强共振（多头暗吸 ${leadingReview.bullCount} 次 / 空头诱多 ${leadingReview.bearCount} 次）｜ 命中 **${leadingReview.hitCount}/${leadingReview.totalCount} (${leadingReview.hitRate}%)** ｜ 平均顺向空间 **+${leadingReview.avgFavorablePct.toFixed(2)}%**${
        leadingReview.drillFilteredCount > 0
          ? `（已过滤 ${leadingReview.drillFilteredCount} 条演练）`
          : ''
      }`
    );
    lines.push(
      `- **知行合一对照**: ✅ 顺向执行 **${leadingReview.alignedCount} 次**${
        leadingReview.alignedNetSum !== 0
          ? `（关联平仓净额 **${leadingReview.alignedNetSum >= 0 ? '+' : ''}¥${money(leadingReview.alignedNetSum)}**）`
          : ''
      } ｜ 🛡️ 守纪避坑/观望 **${leadingReview.disciplinedPassCount} 次** ｜ 👀 踏空好球 **${leadingReview.missedCount} 次** ｜ 🚨 逆向违背 **${leadingReview.contraryCount} 次**`
    );
    leadingReview.items.forEach((it) => {
      const tagTxt = it.tags.length ? ` [${it.tags.join(' + ')}]` : '';
      lines.push(
        `  - \`${it.time}\` **${it.name} (${it.code})** · ${it.dir === 'bull' ? '🔥' : '🚨'} **${it.label}(${it.scoreTxt})** 触发 ¥${f2(it.triggerPrice)}${tagTxt} → **${it.hit ? '🎯 命中' : '⚪ 未达标'}**（${it.outcomeNote}）｜ 实盘：**${it.execBadge}**（${it.execDetail}）`
      );
    });
  }
  lines.push('');

  const sec5Heading =
    holCheck.isYellowCard && isHolidayEveLastDay
      ? `### 五、节后首日（${holCheck.reopenDate}）竞价减仓与盘前挂单锚点预案`
      : holCheck.isYellowCard && isHolidayEve2d
      ? `### 五、明日（${nextTd} · ${holCheck.holidayName}收官日）早盘降仓与挂单锚点预案`
      : `### 五、${nextDayLabel}盘前挂单锚点预案（按今日收盘价动态测算）`;
  lines.push(sec5Heading);

  const planTargets = [
    ...positionCheck.holdingSummary,
    ...positionCheck.watchSummary.slice(0, 4),
  ];
  if (!planTargets.length) {
    lines.push(`- 当前持仓与自选池为空，${nextDayLabel}盘前可从「起爆挖掘」或「选股池」挑选标的加入观察。`);
  } else {
    planTargets.forEach((p) => {
      const role = p.shares > 0 ? `持仓 ${p.shares}股 · 浮盈 ${p.floatPct >= 0 ? '+' : ''}${p.floatPct}%` : '自选观察';
      const lockWarn = p.brokenLock ? ' ⚠️[技术破位锁·禁正T仅高抛]' : '';
      const trimHit = p.shares > 0 ? reductionMap.get(p.code) : null;
      const holActionHint = trimHit
        ? ` 🏮[${isHolidayEveLastDay ? '节后首日竞价/早盘减仓' : '节前收官优先减仓'} ${trimHit.trimShares}股(≈¥${money(trimHit.trimAmt)})·严禁新开正T扩仓]`
        : holCheck.active && p.shares === 0
        ? ` 🏮[节前严控新开仓·总仓不超${holCheck.effectiveCapPct}%]`
        : '';
      lines.push(
        `- **${p.name} (${p.code})** [${role}] 收盘 ¥${f2(p.price)} (${p.dayChgPct >= 0 ? '+' : ''}${p.dayChgPct}%)${lockWarn}${holActionHint} → 正T低吸 **¥${f2(p.inA)}~${f2(p.inB)}** ｜ 倒T高抛 **¥${f2(p.outA)}** ｜ 止盈1 **¥${f2(p.tp1)}** ｜ 止损线 **¥${f2(p.slA)}**`
      );
    });
  }

  return {
    briefMarkdown: lines.join('\n'),
    disciplineScore: todayLogs.length === 0 ? 100 : sc.totalScore,
    grade: todayLogs.length === 0 ? 'S · 宁缺毋滥' : sc.grade,
    todayRealizedNet,
    frictionLoss: sc.frictionLoss,
    leadingReview,
    holidayAudit,
  };
}

/**
 * 构建「复制今日作战计划」（App.jsx handleCopyPlan）剪贴板纯文本：
 * - 自动联动法定节假日休市备战、近期节假日倒计时（5个交易日内）与节前长假控仓黄牌降仓提示
 * - 当处于连续 >=3 天长假前 1~2 个交易日且实际总仓位超上限时，自动输出降仓目标金额与按 100 股整手拆解的优先减仓配额
 */
export function buildDailyBattlePlanText({
  date = null,
  now = null,
  pool = [],
  tailActives = [],
  totalAssets = 100000,
  cash = 0,
  marketValue = null,
  posRate = null,
  allowedCapPct = 80,
  tiltState = null,
  holidayReminder = undefined,
} = {}) {
  const targetNow = now || date || new Date();
  const st = getAShareMarketStatus(targetNow);
  const planDate = date || st.dateStr || todayStr();
  const poolList = Array.isArray(pool) ? pool : [];
  const activeTails = (Array.isArray(tailActives) ? tailActives : []).filter(
    (t) => t && t.status !== 'closed' && (+t.shares || 0) > 0
  );

  const pMkt = poolList.reduce((acc, s) => acc + (+s?.shares || 0) * (+s?.price || +s?.cost || 0), 0);
  const tMkt = activeTails.reduce((acc, t) => acc + (+t.shares || 0) * (+t.price || +t.cost || 0), 0);
  const resolvedMkt =
    marketValue !== null && marketValue !== undefined && Number.isFinite(+marketValue)
      ? Math.max(0, +marketValue)
      : Math.round((pMkt + tMkt) * 100) / 100;
  const resolvedCash = Math.max(0, Math.round((+cash || 0) * 100) / 100);
  const resolvedAssets = Math.max(
    1,
    Number(totalAssets) > 0 ? Number(totalAssets) : resolvedMkt + resolvedCash || 100000
  );
  const resolvedRate =
    posRate !== null && posRate !== undefined && Number.isFinite(+posRate)
      ? Math.max(0, +posRate)
      : (resolvedMkt / resolvedAssets) * 100;
  const emoCap = Math.min(100, Math.max(0, Number(allowedCapPct ?? 80)));

  const reminder =
    holidayReminder !== undefined ? holidayReminder : getUpcomingHolidayReminder(targetNow);
  const holGuard = evaluateHolidayPositionGuard({
    totalPosPct: resolvedRate,
    totalMkt: resolvedMkt,
    totalAssets: resolvedAssets,
    emotionCapPct: emoCap,
    holidayReminder: reminder,
    now: targetNow,
  });

  // 为黄牌超限状态生成分标的整手优先减仓清单
  const holdingForTrim = [];
  const calcCache = new Map();
  poolList.forEach((s) => {
    if (!s) return;
    const code6 = String(s.code || '').padStart(6, '0');
    let c = null;
    try {
      c = calc(s);
    } catch (_) {
      c = null;
    }
    calcCache.set(s, c);
    const sh = Math.max(0, Math.round(+s.shares || 0));
    const px = +s.price || +s.cost || +s.prevClose || 0;
    if (sh > 0 && px > 0) {
      holdingForTrim.push({
        code: code6,
        name: s.name || code6,
        tier: s.tier === 'short' || s.tier === 'long' ? s.tier : s.poolTag === '稳健' ? 'long' : 'short',
        shares: sh,
        price: px,
        cost: +s.cost || px,
        mktVal: sh * px,
        outA: c?.outA || px * 1.02,
        tp1: c?.tp1 || px * 1.025,
        slA: c?.slA || px * 0.98,
        brokenLock: Boolean(c?.brokenLock),
      });
    }
  });

  const tailForTrim = activeTails.map((t) => {
    const px = +t.price || +t.cost || 0;
    const sh = Math.max(0, Math.round(+t.shares || 0));
    return {
      code: String(t.code || '').padStart(6, '0'),
      name: t.name || t.code,
      shares: sh,
      price: px,
      cost: +t.cost || px,
      mktVal: sh * px,
      tp1: +t.tp1 || px * 1.028,
      stop: +t.stop || px * 0.98,
    };
  });

  const reductionTargets = holGuard.isYellowCard
    ? buildPreHolidayReductionTargets({
        holdingSummary: holdingForTrim,
        overnightTailList: tailForTrim,
        excessAmt: holGuard.excessAmt,
      })
    : [];
  const poolTrimMap = new Map(
    reductionTargets.filter((rt) => !rt.isTail).map((rt) => [rt.code, rt])
  );

  const sessionNote =
    st.isHoliday || reminder?.phase === 'in_holiday'
      ? `（${reminder?.holidayName || st.holidayName || '节假日'}休市 · 下个开市日 ${reminder?.reopenDate || st.nextTradeDate}）`
      : !st.isTradeDay
      ? `（周末休市 · 下个交易日 ${st.nextTradeDate}）`
      : '';

  const capTag = holGuard.active
    ? `（节前上限 ≤${holGuard.effectiveCapPct}%）`
    : `（风控上限 ≤${emoCap}%）`;

  const lines = [
    `【今日做T作战计划】${planDate}${sessionNote}`,
    `账户总资产: ¥${money(resolvedAssets)} ｜ 可用现金: ¥${money(resolvedCash)} ｜ 总仓位: ${resolvedRate.toFixed(1)}%${capTag}${tiltState?.isLocked ? ' ｜ 🔒 防上头熔断保护中' : ''}`,
  ];

  // 节假日休市备战 / 节前控仓黄牌 / 节前控仓达标 / 近期节假日倒计时段落
  if (st.isHoliday || reminder?.phase === 'in_holiday') {
    const holName = String(reminder?.holidayName || st.holidayName || '节假日').replace(/休市$/, '');
    const closedDays = Math.max(1, Number(reminder?.closedDays || 1));
    const reopenDate = reminder?.reopenDate || st.nextTradeDate || '';
    const rangeTxt =
      reminder?.closureStart && reminder?.closureEnd
        ? `${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)}，`
        : '';
    const isLongHol = Boolean(reminder?.isLongHoliday || closedDays >= 3);
    const holCap = isLongHol
      ? Math.min(emoCap, Number(reminder?.suggestedMaxPosPct) || (closedDays >= 7 ? 30 : 50))
      : null;
    const isOverHolCap = holCap !== null && resolvedRate > holCap + 0.1;
    const overHolAmt = isOverHolCap
      ? Math.max(0, Math.round(resolvedMkt - (resolvedAssets * holCap) / 100))
      : 0;

    lines.push('');
    lines.push(
      isOverHolCap
        ? `🏮 【法定节假日休市备战】当前处于${holName}休市期（${rangeTxt}连休 ${closedDays} 天，节后首个开市日 ${reopenDate}）；⚠️ 当前跨假仓位 ${resolvedRate.toFixed(1)}% 高于建议水位 ${holCap}%，请提前制定 ${reopenDate} 09:15~09:25 竞价去弱留强预案（建议逢高回笼约 ¥${money(overHolAmt)}）。`
        : `🏮 【法定节假日休市备战】当前处于${holName}休市期（${rangeTxt}连休 ${closedDays} 天，节后首个开市日 ${reopenDate}）；跨假仓位处于安全水位，可复盘节后首日竞价挂单点位。`
    );
  } else if (holGuard.isYellowCard) {
    lines.push('');
    lines.push(
      `🟨 【节前控仓黄牌提醒】距${holGuard.holidayName}连休 ${holGuard.closedDays} 天（${holGuard.closureStart.slice(5)}~${holGuard.closureEnd.slice(5)}，${holGuard.reopenDate} 开市）仅剩 ${holGuard.remainingTradeDays} 个交易日！`
    );
    lines.push(
      `  · 降仓目标: 当前总仓位 ${resolvedRate.toFixed(1)}% 超出${holGuard.capSourceLabel} ${holGuard.excessPct}%，今日需逢高降仓约 ¥${money(holGuard.excessAmt)}（压回 ≤${holGuard.effectiveCapPct}%）`
    );
    if (reductionTargets.length > 0) {
      lines.push(
        `  · 优先减仓配额: ${reductionTargets
          .map(
            (rt) =>
              `${rt.name}(建议减${rt.trimShares}股≈¥${money(rt.trimAmt)}${rt.isTail ? '·尾盘仓' : ''})`
          )
          .join('、')}`
      );
    }
    lines.push(`  · 窗口纪律: ${holGuard.windowNote}`);
  } else if (holGuard.active) {
    lines.push('');
    lines.push(
      `🏮 【节前控仓窗口达标】距${holGuard.holidayName}连休 ${holGuard.closedDays} 天（${holGuard.closureStart.slice(5)}~${holGuard.closureEnd.slice(5)}，${holGuard.reopenDate} 开市）仅剩 ${holGuard.remainingTradeDays} 个交易日：当前总仓位 ${resolvedRate.toFixed(1)}% 符合 ≤${holGuard.effectiveCapPct}%（${holGuard.posRangeLabel}）控仓线（安全可开仓余量约 ¥${money(holGuard.headroomAmt)}）。${
        holGuard.remainingTradeDays === 1
          ? `今日新买筹码受 T+1 限制将锁仓跨假 ${holGuard.closedDays} 天至 ${holGuard.reopenDate} 才能卖出，严禁尾盘冲动重仓。`
          : '今日为节前资金取现最后卖出窗口，谨防午后避险兑现抛压。'
      }`
    );
  } else if (reminder && reminder.phase === 'pre_holiday_countdown') {
    const preCap = Math.min(emoCap, Number(reminder.suggestedMaxPosPct) || (reminder.closedDays >= 7 ? 30 : 50));
    lines.push('');
    lines.push(
      `📅 【近期节假日倒计时】距${reminder.holidayName}休市（${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)}，休 ${reminder.closedDays} 天，${reminder.reopenDate} 开市）还有 ${reminder.remainingTradeDays} 个交易日${
        reminder.isLongHoliday
          ? `，进入节前 2 个交易日将启动 ≤${preCap}% 分档控仓线，可提前借冲高做T收敛弱势仓位。`
          : '（短休维持常规日内做T纪律）。'
      }`
    );
  }

  poolList.forEach((s) => {
    if (!s) return;
    const c = calcCache.get(s) || null;
    const code6 = String(s.code || '').padStart(6, '0');
    const sh = +s.shares || 0;
    const posTag = sh > 0 ? `持仓 ${sh}股(成本 ¥${f2(s.cost)})` : '自选观察';
    const trimHit = sh > 0 ? poolTrimMap.get(code6) : null;
    const trimBadge = trimHit
      ? ` 🟨[节前优先减仓 ${trimHit.trimShares}股(≈¥${money(trimHit.trimAmt)})]`
      : holGuard.active && sh === 0
      ? ` 🏮[节前严控新开仓]`
      : '';

    lines.push('');
    lines.push(`■ ${s.name} (${code6}) [${posTag}] 现价: ¥${f2(s.price)}${trimBadge}`);
    if (c) {
      const cleanTitle = String(c.title || '').replace(/<[^>]+>/g, '');
      const stopPctTxt = Number.isFinite(+c.effStop)
        ? ` (-${(c.effStop * 100).toFixed(2)}%)`
        : c.slA > 0 && (+s.price || +s.prevClose) > 0
        ? ` (-${((((+s.price || +s.prevClose) - c.slA) / (+s.price || +s.prevClose)) * 100).toFixed(2)}%)`
        : '';
      lines.push(`  结论: ${cleanTitle}`);
      lines.push(`  正T低吸: ¥${f2(c.inA)} / ¥${f2(c.inB)} ｜ 倒T高抛: ¥${f2(c.outA)} / ¥${f2(c.outB)}`);
      lines.push(`  止盈目标: ¥${f2(c.tp1)} / ¥${f2(c.tp2)} ｜ 止损红线: ¥${f2(c.slA)}${stopPctTxt}`);
    }
    if (s.memo && String(s.memo).trim()) {
      lines.push(`  作战备注: ${String(s.memo).trim()}`);
    }
  });

  if (activeTails.length > 0) {
    const tailHeader =
      holGuard.active && holGuard.remainingTradeDays === 1
        ? `⚡ 隔夜尾盘持仓（09:30~10:00 必平 · 严防锁仓跨假 ${holGuard.closedDays} 天）`
        : '⚡ 隔夜尾盘持仓（09:30~10:00 必平）';
    lines.push('');
    lines.push(
      `${tailHeader}: ${activeTails.map((t) => `${t.name}(${t.shares}股 成本¥${f2(t.cost)})`).join('、')}`
    );
  }

  lines.push('');
  lines.push(
    holGuard.active
      ? `—— 铁律：破止损线无条件砍；做T仓 14:55 前必须平掉；节前严守 ≤${holGuard.effectiveCapPct}% 跨假仓位红线，收官日绝不尾盘重仓赌消息。`
      : '—— 铁律：破止损线无条件砍；做T仓 14:55 前必须平掉，绝不硬扛过夜。'
  );

  const toastMessage = holGuard.isYellowCard
    ? `🟨 今日作战计划已复制（含${holGuard.holidayName}节前控仓黄牌降仓 ¥${money(holGuard.excessAmt)} 指引）！`
    : holGuard.active
    ? `🏮 今日作战计划已复制（含${holGuard.holidayName}节前控仓 ≤${holGuard.effectiveCapPct}% 窗口提醒）！`
    : '今日真实量化作战计划已复制到剪贴板！';

  return {
    text: lines.join('\n'),
    toastMessage,
    holidayGuard: holGuard,
    reductionTargets,
  };
}
