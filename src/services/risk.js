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

/**
 * 上升 / 下跌双通道持仓加减仓与保命纪律评估器
 * 核心规则：
 * - 上升通道 (OK 且非情绪红灯)：逢回调顺势加仓，沿 MA5/MA10 拉长格局扩大战果，不轻易下车
 * - 下跌/弱势通道 (WARN / BAD / 情绪红灯)：
 *   1) 浮亏严禁向下补仓摊平（防招商轮船式一路跌一路补深套）
 *   2) 建仓次日 (T+1) 盘中跌了不急补不乱割，14:40 后/收盘仍收绿直接止损换票（拒绝幻想第3天反包）
 *   3) 连红 >= 3 天触发高潮止盈预警（主动减仓 50%+ 防第4天闷杀跌停）
 *   4) 连红 >= 2 天后出现首阴触发收盘无条件清仓令
 */
export function evaluateChannelHoldingDiscipline(
  stock,
  { tradeLogs = [], sentiment = null, wbEnv = null, mktLevel = '' } = {}
) {
  if (!stock) return null;
  const today = todayStr();
  const sh = Math.round(+stock.shares || 0);
  const hasPos = sh > 0;
  const px = +stock.price || +stock.prevClose || 0;
  const pc = +stock.prevClose || px;
  const cost = +stock.cost || 0;
  const liveChg = pc > 0 ? ((px - pc) / pc) * 100 : 0;
  const floatPct = hasPos && cost > 0 && px > 0 ? ((px - cost) / cost) * 100 : 0;

  const winWbEnv = typeof window !== 'undefined' ? window.WB_LATEST?.env : null;
  const effEnvLevel = String(mktLevel || wbEnv?.level || winWbEnv?.level || 'OK').toUpperCase();
  const isRedValve = sentiment?.riskValve === 'RED';
  const channelMode = effEnvLevel === 'OK' && !isRedValve ? 'UP' : 'DOWN';
  const channelLabel = channelMode === 'UP' ? '📈 上升通道 · 波段格局' : '🛡️ 下跌通道 · 保命去弱';

  // 1. 从日K (_ks) 统计截至昨日连红天数 (prevRedStreak) 与含今日实时连红天数 (redStreak)
  const rawKs = Array.isArray(stock._ks) ? stock._ks : [];
  const completedBars = rawKs.filter((b) => b && b.date && String(b.date).slice(0, 10) < today);
  let prevRedStreak = 0;
  for (let i = completedBars.length - 1; i >= 1; i--) {
    const cur = completedBars[i];
    const prev = completedBars[i - 1];
    const isRedDay = +cur.close > +prev.close || (+cur.close >= +prev.close && +cur.close > +cur.open);
    if (isRedDay) prevRedStreak += 1;
    else break;
  }

  let redStreak = prevRedStreak;
  let isTodayGreen = false;
  let isFirstYinAfterStreak = false;
  if (px > 0 && pc > 0) {
    const todayIsRed = px > pc || (px === pc && +stock.open > 0 && px > +stock.open);
    const todayIsYin = px < pc * 0.998 || (+stock.open > 0 && px < +stock.open * 0.994 && px <= pc);
    if (todayIsRed) {
      redStreak = prevRedStreak + 1;
    } else if (todayIsYin) {
      redStreak = 0;
      isTodayGreen = true;
      if (prevRedStreak >= 2) {
        isFirstYinAfterStreak = true;
      }
    }
  }

  // 2. 识别是否为「建仓次日 (T+1 审判日)」
  const code6 = String(stock.code || '').replace(/\D/g, '').padStart(6, '0');
  let latestEntryDate = '';
  if (hasPos && Array.isArray(tradeLogs)) {
    const openDirs = new Set(['买入建仓', '直接买入', '尾盘买入']);
    for (const lg of tradeLogs) {
      if (!lg || !lg.date) continue;
      const lgCode = String(lg.code || lg.stock?.match(/\d{6}/)?.[0] || '').padStart(6, '0');
      const nameHit = stock.name && lg.stock && String(lg.stock).includes(stock.name);
      if ((code6 !== '000000' && lgCode === code6) || nameHit) {
        if (openDirs.has(String(lg.dir || ''))) {
          latestEntryDate = String(lg.date).slice(0, 10);
          break;
        }
      }
    }
  }

  let isT1Day = false;
  if (latestEntryDate && latestEntryDate < today) {
    if (completedBars.length > 0) {
      const lastCompletedDate = String(completedBars[completedBars.length - 1].date).slice(0, 10);
      isT1Day = latestEntryDate === lastCompletedDate;
    } else {
      const diffDays = Math.round((new Date(today) - new Date(latestEntryDate)) / 86400000);
      const wd = new Date().getDay();
      isT1Day = diffDays === 1 || (wd === 1 && diffDays === 3);
    }
  }

  // 当前是否进入尾盘收盘判定窗口 (14:40 之后或已收盘/非交易时段)
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isNearOrAfterClose = mins >= 14 * 60 + 40 || mins < 9 * 60 + 25;

  const forbidAddPosition = channelMode === 'DOWN' && hasPos && floatPct <= -0.8;
  const forbidReason = forbidAddPosition
    ? `🩸 下跌通道铁律：当前持仓浮亏 ${floatPct.toFixed(1)}%，严禁向下补仓摊平（防一路跌一路补深套）！`
    : '';

  const warn3Red = channelMode === 'DOWN' && redStreak >= 3;
  const warn3RedReason = warn3Red
    ? `🔥 弱势连红 ${redStreak} 天高潮预警：下跌通道最多格局 3 天，严禁加仓追高，请立即主动减仓 50%+ 防次日核按钮闷杀！`
    : '';

  let alert = null;
  if (hasPos) {
    if (channelMode === 'DOWN') {
      if (isFirstYinAfterStreak) {
        alert = {
          kind: 'danger',
          badge: `⚡ 连红${prevRedStreak}天首阴 · 清仓令`,
          text: `下跌通道连红 ${prevRedStreak} 天后今日转阴（首阴），严防盈利大幅回撤，尾盘/收盘果断清仓离场！`,
        };
      } else if (warn3Red) {
        alert = {
          kind: 'warn',
          badge: `🔥 连红${redStreak}天 · 必减仓`,
          text: `弱势通道已连红 ${redStreak} 天逼近情绪极限，切忌贪婪坐过山车，逢高至少减半仓锁利！`,
        };
      } else if (isT1Day) {
        if (liveChg <= -0.25) {
          alert = isNearOrAfterClose
            ? {
                kind: 'danger',
                badge: '✂️ T+1收绿 · 果断止损',
                text: '下跌通道建仓次日收盘仍下跌，拒绝幻想第 3 天反包，直接割肉换票（下跌通道不存在踏空）！',
              }
            : {
                kind: 'watch',
                badge: '⏳ T+1盘中 · 禁补等收盘',
                text: '建仓次日盘中走弱：不要立刻补仓也别急割，等 14:40 后看收盘若仍收绿再果断砍仓！',
              };
        } else if (liveChg >= 0.2) {
          alert = {
            kind: 'ok',
            badge: '✅ T+1收红确认',
            text: '建仓次日收红抗跌，可留仓或微加，将成本价设为硬保本底线（连红满3天减仓）',
          };
        }
      } else if (forbidAddPosition) {
        alert = {
          kind: 'danger',
          badge: '🩸 浮亏禁补仓',
          text: `弱势通道当前浮亏 ${floatPct.toFixed(1)}%，严禁向下补仓摊平！逢反抽压力位优先减仓换强`,
        };
      }
    } else {
      // 上升通道 (UP)
      const ma10 = +stock.ma10 || 0;
      const aboveTrend = ma10 <= 0 || px >= ma10 * 0.99;
      if (aboveTrend && liveChg <= 0.6 && liveChg >= -2.8) {
        alert = {
          kind: 'ok',
          badge: '📈 上升通道 · 逢回调加仓',
          text: '大盘处于上升通道且个股守稳均线，缩量回调可顺势加仓，拉长格局时间扩大战果',
        };
      } else if (aboveTrend && floatPct > -2.5) {
        alert = {
          kind: 'ok',
          badge: '🦁 上升通道 · 锁仓格局',
          text: '大盘上升通道趋势完好，底仓沿 MA5/MA10 拿住放大战果，切忌赚小钱过早下车卖飞',
        };
      }
    }
  }

  return {
    channelMode,
    channelLabel,
    effEnvLevel,
    hasPos,
    floatPct: +floatPct.toFixed(2),
    liveChg: +liveChg.toFixed(2),
    prevRedStreak,
    redStreak,
    isTodayGreen,
    isFirstYinAfterStreak,
    isT1Day,
    isNearOrAfterClose,
    forbidAddPosition,
    forbidReason,
    warn3Red,
    warn3RedReason,
    alert,
  };
}
