import { todayStr, getTodayTStatus } from './utils.js';

export const POS_RULES_KEY = 't-pos-rules-v1';
export const TILT_OVERRIDE_KEY = 't-tilt-override-v1';

export const DEFAULT_POS_RULES = {
  greenMaxPct: 80,
  yellowMaxPct: 50,
  redMaxPct: 20,
  singleMaxPct: 30,
  riskPerTradePct: 1.5,
  maxConsecLosses: 2,
  dailyLossLimitPct: 2.0,
  tiltLockEnabled: true,
};

export function loadPosRules() {
  try {
    const raw = localStorage.getItem(POS_RULES_KEY);
    if (!raw) return { ...DEFAULT_POS_RULES };
    const parsed = JSON.parse(raw);
    return {
      greenMaxPct: Math.min(100, Math.max(10, Number(parsed.greenMaxPct) || DEFAULT_POS_RULES.greenMaxPct)),
      yellowMaxPct: Math.min(100, Math.max(10, Number(parsed.yellowMaxPct) || DEFAULT_POS_RULES.yellowMaxPct)),
      redMaxPct: Math.min(100, Math.max(0, Number(parsed.redMaxPct ?? DEFAULT_POS_RULES.redMaxPct))),
      singleMaxPct: Math.min(100, Math.max(5, Number(parsed.singleMaxPct) || DEFAULT_POS_RULES.singleMaxPct)),
      riskPerTradePct: Math.min(5, Math.max(0.3, Number(parsed.riskPerTradePct) || DEFAULT_POS_RULES.riskPerTradePct)),
      maxConsecLosses: Math.min(10, Math.max(1, parseInt(parsed.maxConsecLosses ?? DEFAULT_POS_RULES.maxConsecLosses, 10) || DEFAULT_POS_RULES.maxConsecLosses)),
      dailyLossLimitPct: Math.min(15, Math.max(0.5, Number(parsed.dailyLossLimitPct ?? DEFAULT_POS_RULES.dailyLossLimitPct) || DEFAULT_POS_RULES.dailyLossLimitPct)),
      tiltLockEnabled: parsed.tiltLockEnabled !== undefined ? Boolean(parsed.tiltLockEnabled) : true,
    };
  } catch {
    return { ...DEFAULT_POS_RULES };
  }
}

export function savePosRules(next) {
  try {
    localStorage.setItem(POS_RULES_KEY, JSON.stringify(next));
  } catch (_) {}
}

export function getAllowedPosCap(sentiment, rules) {
  const r = rules || DEFAULT_POS_RULES;
  const valve = sentiment?.riskValve || 'GREEN';
  if (valve === 'RED') return { capPct: r.redMaxPct, valve: 'RED', label: '红灯退潮上限' };
  if (valve === 'YELLOW') return { capPct: r.yellowMaxPct, valve: 'YELLOW', label: '黄灯分歧上限' };
  return { capPct: r.greenMaxPct, valve: 'GREEN', label: '绿灯进攻上限' };
}

export function loadTiltOverride() {
  try {
    const raw = localStorage.getItem(TILT_OVERRIDE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.date === todayStr()) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveTiltOverride(overrideObj) {
  try {
    if (overrideObj) {
      localStorage.setItem(TILT_OVERRIDE_KEY, JSON.stringify(overrideObj));
    } else {
      localStorage.removeItem(TILT_OVERRIDE_KEY);
    }
  } catch (_) {}
}

/**
 * 计算单日连续亏损笔数、日内已实现净盈亏与日内总回撤，判定是否触发「防上头熔断锁」
 * 规则：
 * 1. 当日闭环交易（正T/倒T/做T/直接卖出/清仓卖出/尾盘平仓）从最新往回统计连续净亏损笔数 >= maxConsecLosses；
 * 2. 或当日已实现净亏损占比 / 当日综合回撤占比（已实现 + 持仓日内浮亏） >= dailyLossLimitPct；
 * 3. 若用户已完成冷静期解锁，但在解锁后再次新增一笔亏损，或日内回撤继续扩大 >= 0.5%，自动二次强制锁死！
 */
export function computeDailyTiltState({
  tradeLogs = [],
  pool = [],
  tailActives = [],
  totalAssets = 100000,
  posRules = DEFAULT_POS_RULES,
  tiltOverride = null,
} = {}) {
  const rules = { ...DEFAULT_POS_RULES, ...(posRules || {}) };
  const assets = Math.max(1, +totalAssets || 100000);
  const today = todayStr();

  const closedDirs = new Set(['正T', '倒T', '做T', '直接卖出', '清仓卖出', '尾盘平仓']);
  const openOnlyDirs = new Set(['买入建仓', '买入加仓', '直接买入', '尾盘买入']);

  const todayLogs = (tradeLogs || []).filter((r) => r && String(r.date || '') === today);
  const todayClosed = todayLogs.filter((r) => {
    const dir = String(r.dir || '');
    if (openOnlyDirs.has(dir)) return false;
    return closedDirs.has(dir) || (+r.buy > 0 && +r.sell > 0);
  });

  // tradeLogs 最新在前：从 index 0 向后统计当前连续亏损链条（净额 < -1 元视为实质亏损）
  let consecLosses = 0;
  for (let i = 0; i < todayClosed.length; i++) {
    const net = Number(todayClosed[i].net) || 0;
    if (net < -1) {
      consecLosses += 1;
    } else if (net > 1) {
      break;
    }
  }

  let todayLossCount = 0;
  let todayWinCount = 0;
  todayClosed.forEach((r) => {
    const net = Number(r.net) || 0;
    if (net < -1) todayLossCount += 1;
    else if (net > 1) todayWinCount += 1;
  });

  // 当日已实现净额（含闭环盈亏与开仓手续费）
  const todayRealizedPL = todayLogs.reduce((acc, r) => acc + (Number(r.net) || 0), 0);

  // 当日持仓日内浮动盈亏（昨持底仓按 prevClose 算今日涨跌，今日新开仓按买入成本算今日浮盈亏）
  let todayFloatingPL = 0;
  (pool || []).forEach((s) => {
    const sh = Math.round(+s.shares || 0);
    if (sh <= 0) return;
    const px = +s.price || +s.prevClose || +s.cost || 0;
    const pc = +s.prevClose || px;
    const cost = +s.cost || px;
    const tSt = getTodayTStatus(s, tradeLogs);
    const oldSh = Math.max(0, tSt?.sellableShares ?? sh);
    const newSh = Math.max(0, sh - oldSh);
    if (oldSh > 0 && pc > 0) {
      todayFloatingPL += (px - pc) * oldSh;
    }
    if (newSh > 0 && cost > 0) {
      todayFloatingPL += (px - cost) * newSh;
    }
  });

  (tailActives || []).forEach((t) => {
    if (!t || t.status === 'closed') return;
    const sh = Math.round(+t.shares || 0);
    if (sh <= 0) return;
    const px = +t.price || +t.cost || 0;
    const refPx = String(t.date || '') === today ? (+t.cost || px) : (+t.prevClose || +t.cost || px);
    todayFloatingPL += (px - refPx) * sh;
  });

  const todayCombinedPL = Math.round((todayRealizedPL + todayFloatingPL) * 100) / 100;
  const realizedLossPct = todayRealizedPL < 0 ? (Math.abs(todayRealizedPL) / assets) * 100 : 0;
  const combinedDrawdownPct = todayCombinedPL < 0 ? (Math.abs(todayCombinedPL) / assets) * 100 : 0;
  const effectiveLossPct = Math.max(realizedLossPct, combinedDrawdownPct);

  const hitConsec = rules.tiltLockEnabled && rules.maxConsecLosses > 0 && consecLosses >= rules.maxConsecLosses;
  const hitDrawdown = rules.tiltLockEnabled && rules.dailyLossLimitPct > 0 && effectiveLossPct >= rules.dailyLossLimitPct;
  const rawTriggered = hitConsec || hitDrawdown;

  const reasons = [];
  if (hitConsec) {
    reasons.push(`单日连续止损/亏损 ${consecLosses} 笔（达 ${rules.maxConsecLosses} 笔红线）`);
  }
  if (hitDrawdown) {
    reasons.push(
      realizedLossPct >= rules.dailyLossLimitPct
        ? `当日已实现亏损 -${realizedLossPct.toFixed(2)}%（超 ${rules.dailyLossLimitPct}% 红线）`
        : `当日综合回撤 -${combinedDrawdownPct.toFixed(2)}%（超 ${rules.dailyLossLimitPct}% 红线）`
    );
  }

  // 校验冷静解锁是否仍然有效：若解锁后又亏了新的一笔，或回撤再恶化 >=0.5%，强制二次锁死
  let isOverridden = false;
  let relockedAfterOverride = false;
  if (rawTriggered && tiltOverride && tiltOverride.date === today) {
    const newLossOccurred = todayLossCount > (tiltOverride.lossCountAtUnlock ?? 0);
    const worsenedDrawdown = effectiveLossPct >= (tiltOverride.lossPctAtUnlock ?? 0) + 0.5;
    if (newLossOccurred || worsenedDrawdown) {
      relockedAfterOverride = true;
      reasons.push('解锁后亏损继续扩大，触发二次硬锁死');
    } else {
      isOverridden = true;
    }
  }

  const isLocked = rawTriggered && !isOverridden;
  const isWarning =
    !isLocked &&
    !isOverridden &&
    rules.tiltLockEnabled &&
    ((rules.maxConsecLosses >= 2 && consecLosses === rules.maxConsecLosses - 1) ||
      effectiveLossPct >= rules.dailyLossLimitPct * 0.72);

  return {
    enabled: rules.tiltLockEnabled,
    isLocked,
    isWarning,
    isOverridden,
    relockedAfterOverride,
    rawTriggered,
    reasons,
    consecLosses,
    todayLossCount,
    todayWinCount,
    todayClosedCount: todayClosed.length,
    todayRealizedPL: Math.round(todayRealizedPL * 100) / 100,
    todayFloatingPL: Math.round(todayFloatingPL * 100) / 100,
    todayCombinedPL,
    realizedLossPct: +realizedLossPct.toFixed(2),
    combinedDrawdownPct: +combinedDrawdownPct.toFixed(2),
    effectiveLossPct: +effectiveLossPct.toFixed(2),
    maxConsecLosses: rules.maxConsecLosses,
    dailyLossLimitPct: rules.dailyLossLimitPct,
  };
}
