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

  lines.push(`### 四、明日盘前挂单锚点预案（按今日收盘价动态测算）`);
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
  };
}
