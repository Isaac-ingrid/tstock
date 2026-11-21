/* ============================================================
   A股做T执行台 · 15:05 盘后一键收盘归档与明日预案引擎 (eod.js)
   串联五步闭环：收盘行情同步 -> 未平T/隔夜仓核查 -> 净值快照落盘
                -> 今日量化复盘与明日挂单简报 -> 本地磁盘金库双写
   ============================================================ */

import { STORAGE_KEYS } from '../data/site.js';
import { f2, money, todayStr, nowTimeHHMM, getTodayTStatus } from './utils.js';
import { calc, MKT } from './api.js';
import { computeDisciplineScorecard } from './ledger.js';

const MAX_EOD_ARCHIVES = 30;

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
 * 判断当前是否处于工作日 15:00 收盘后归档窗口
 */
export function isPostMarketWindowNow(now = new Date()) {
  const wd = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return wd >= 1 && wd <= 5 && mins >= 15 * 60;
}

/**
 * 步骤 2：盘后持仓、未平T仓、首日T+1锁仓与尾盘隔夜仓全量体检
 */
export function inspectPostMarketPositions({
  pool = [],
  tailActives = [],
  tradeLogs = [],
}) {
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
        // 以今日收盘价作为明日锚定昨收的近似推演（同时兼容当日实时 calc）
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
      tier: s.tier === 'long' || s.poolTag === '稳健' ? 'long' : 'short',
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
        stop: +(t.stop || cost * 0.98).toFixed(2),
      };
    });

  return {
    unclosedTList,
    t1LockedList,
    overnightTailList,
    holdingSummary,
    watchSummary,
    hasUnclosedWarning: unclosedTList.length > 0,
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

  const BUY_DIRS = new Set(['正T', '做T', '买入建仓', '买入加仓', '直接买入', '尾盘买入']);
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
        // 扣双向规费后具备日内净套利空间（脉冲 ≥+0.80% 或收盘稳涨 ≥+0.45%）判为命中
        hit = peakGainPct >= 0.8 || closeMovePct >= 0.45;
        outcomeNote = hasPostMinuteTrack
          ? `信号后最高 ¥${f2(maxAfterPx)}(${peakGainPct >= 0 ? '+' : ''}${peakGainPct.toFixed(2)}%) · 收 ¥${f2(closePx)}(${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`
          : `收盘 ¥${f2(closePx)}(较触发 ${closeMovePct >= 0 ? '+' : ''}${closeMovePct.toFixed(2)}%)`;
      } else {
        troughDropPct = +(((minAfterPx - trigPx) / trigPx) * 100).toFixed(2);
        favorablePct = +Math.max(-troughDropPct, -closeMovePct).toFixed(2);
        // 空头诱多预警后回落 ≥0.80% 或收盘跌 ≥0.45% 判为预警命中
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
 * 步骤 4：生成结构化「今日收盘量化复盘与明日挂单简报」(兼容有交易日与零交易守纪日，离线亦 100% 可用)
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
  coachReview = null,
  alertRecords = null,
}) {
  const envLv = marketEnv?.level || MKT?.gate?.level || 'OK';
  const envTitle = String(marketEnv?.text || MKT?.gate?.title || '大盘常态震荡').replace(/<[^>]+>/g, '');

  const sc = computeDisciplineScorecard(todayLogs, pool, wbLatest);
  const closedToday = (todayLogs || []).filter(
    (l) => +l.buy > 0 && +l.sell > 0 && l.dir !== '买入建仓' && l.dir !== '买入加仓' && l.dir !== '尾盘买入'
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
  lines.push(`# 🏁 【15:05 收盘归档与明日作战简报】· ${date}`);
  lines.push('');
  lines.push(`### 一、账户收盘净值与环境水位`);
  lines.push(
    `- **收盘总资产**: ¥${money(snapshot.total)}（可用现金 ¥${money(snapshot.cash)} ｜ 持仓总市值 ¥${money(snapshot.mkt)} ｜ 总仓位 **${snapshot.rate}%**）`
  );
  lines.push(
    `- **单日净值变动**: 较${deltaInfo.refDate} **${deltaInfo.dayDelta >= 0 ? '+' : ''}¥${money(deltaInfo.dayDelta)} (${deltaInfo.dayDeltaPct >= 0 ? '+' : ''}${deltaInfo.dayDeltaPct.toFixed(2)}%)** ｜ 累计总收益 **${deltaInfo.cumReturn >= 0 ? '+' : ''}¥${money(deltaInfo.cumReturn)} (${deltaInfo.cumReturnPct >= 0 ? '+' : ''}${deltaInfo.cumReturnPct.toFixed(2)}%)**`
  );
  lines.push(`- **大盘环境闸门**: \`${envLv}\` · ${envTitle}`);
  lines.push('');

  lines.push(`### 二、未平 T 仓与隔夜持仓风控核查`);
  if (positionCheck.unclosedTList.length > 0) {
    lines.push(
      `- 🚨 **未平做T仓滞留警报 (${positionCheck.unclosedTList.length} 只)**：以下标的今日买入T仓未在 15:00 前平出，已构成「做T变被动加仓」，明日早盘冲高务必优先减出恢复原仓位：`
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
    lines.push(
      `- ⚡ **尾盘黑马隔夜持仓 (${positionCheck.overnightTailList.length} 只 · 明日 09:30~10:00 必平)**：`
    );
    positionCheck.overnightTailList.forEach((t) => {
      lines.push(
        `  - **${t.name} (${t.code})**：${t.shares} 股 ｜ 成本 ¥${f2(t.cost)} → 收盘 ¥${f2(t.price)}（浮盈 ${t.floatPnl >= 0 ? '+' : ''}¥${money(t.floatPnl)}）｜ 明日止盈1 **¥${f2(t.tp1)}** / 止损 **¥${f2(t.stop)}**`
      );
    });
  }

  if (positionCheck.t1LockedList.length > 0) {
    lines.push(
      `- 🔒 **今日首开底仓 T+1 冻结 (${positionCheck.t1LockedList.length} 只)**：${positionCheck.t1LockedList
        .map((x) => `${x.name}(${x.lockedShares}股)`)
        .join('、')} 明日开盘自动解锁可用可卖额度。`
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
        lines.push(
          `- 第${idx + 1}笔 **${lg.stock}** (${lg.dir} ${lg.qty}股)：买 ¥${f2(lg.buy)} / 卖 ${lg.sell > 0 ? `¥${f2(lg.sell)}` : '持仓中'}，净额 **${lg.net >= 0 ? '+' : ''}¥${money(lg.net)}**（纪律 ${lg.disciplineScore || 100}分${devTxt}）`
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

  lines.push(`### 五、明日盘前挂单锚点预案（按今日收盘价动态测算）`);
  const planTargets = [
    ...positionCheck.holdingSummary,
    ...positionCheck.watchSummary.slice(0, 4),
  ];
  if (!planTargets.length) {
    lines.push(`- 当前持仓与自选池为空，明日盘前可从「起爆挖掘」或「选股池」挑选标的加入观察。`);
  } else {
    planTargets.forEach((p) => {
      const role = p.shares > 0 ? `持仓 ${p.shares}股 · 浮盈 ${p.floatPct >= 0 ? '+' : ''}${p.floatPct}%` : '自选观察';
      const lockWarn = p.brokenLock ? ' ⚠️[技术破位锁·禁正T仅高抛]' : '';
      lines.push(
        `- **${p.name} (${p.code})** [${role}] 收盘 ¥${f2(p.price)} (${p.dayChgPct >= 0 ? '+' : ''}${p.dayChgPct}%)${lockWarn} → 明日正T低吸 **¥${f2(p.inA)}~${f2(p.inB)}** ｜ 倒T高抛 **¥${f2(p.outA)}** ｜ 止盈1 **¥${f2(p.tp1)}** ｜ 止损线 **¥${f2(p.slA)}**`
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
  };
}
