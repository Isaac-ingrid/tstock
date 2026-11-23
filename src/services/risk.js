import { todayStr, getTodayTStatus } from './utils.js';
import { getAShareMarketStatus, prevAShareTradeDate, getCNClock, getUpcomingHolidayReminder } from './calendar.js';

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

/**
 * 节前连续长假动态仓位黄牌评估器：
 * - 触发范围：仅当处于连续休市 >= 3 天（含法定节假日）前最后 1~2 个交易日（isHighAlert === true）
 * - 建议上限：连休 >= 7 天（春节/国庆等超级长假）建议 <= 30%；连休 3~6 天建议 <= 50%
 * - 情绪叠加：effectiveCapPct = Math.min(emotionCapPct, holidayCapPct)，若情绪红灯(如20%)更严则从严执行
 * - 黄牌判定：当实际总仓位 totalPosPct > effectiveCapPct + 0.1 时亮黄牌（isYellowCard = true），计算精确降仓比例与金额
 */
export function evaluateHolidayPositionGuard({
  totalPosPct = 0,
  totalMkt = 0,
  totalAssets = 100000,
  emotionCapPct = 80,
  holidayReminder = undefined,
  now = null,
} = {}) {
  const reminder =
    holidayReminder !== undefined
      ? holidayReminder
      : getUpcomingHolidayReminder(now || new Date());

  if (
    !reminder ||
    !reminder.isHighAlert ||
    !(reminder.closedDays >= 3) ||
    !(reminder.remainingTradeDays >= 1 && reminder.remainingTradeDays <= 2)
  ) {
    return {
      active: false,
      isYellowCard: false,
      reminder: reminder || null,
      holidayName: reminder?.holidayName || null,
      closedDays: reminder?.closedDays || 0,
      remainingTradeDays: reminder?.remainingTradeDays || 0,
      closureStart: reminder?.closureStart || '',
      closureEnd: reminder?.closureEnd || '',
      reopenDate: reminder?.reopenDate || '',
      holidayCapPct: null,
      effectiveCapPct: Number(emotionCapPct) || 80,
      excessPct: 0,
      excessAmt: 0,
      headroomAmt: 0,
      posRangeLabel: reminder?.posRangeLabel || '',
      windowNote: '',
      capSourceLabel: '',
      pillText: '',
      bannerText: '',
    };
  }

  const assets = Math.max(1, Number(totalAssets) || 100000);
  const posPct = Math.max(0, Number(totalPosPct) || 0);
  const mkt = Math.max(0, Number(totalMkt) > 0 ? Number(totalMkt) : (assets * posPct) / 100);
  const emoCap = Math.min(100, Math.max(0, Number(emotionCapPct ?? 80)));
  const holidayCapPct =
    Number(reminder.suggestedMaxPosPct) > 0
      ? Number(reminder.suggestedMaxPosPct)
      : reminder.closedDays >= 7
      ? 30
      : 50;
  const effectiveCapPct = Math.min(emoCap, holidayCapPct);
  const targetMkt = (assets * effectiveCapPct) / 100;
  const isYellowCard = posPct > effectiveCapPct + 0.1;
  const excessPct = isYellowCard ? +(posPct - effectiveCapPct).toFixed(1) : 0;
  const excessAmt = isYellowCard ? Math.max(0, Math.round(mkt - targetMkt)) : 0;
  const headroomAmt = !isYellowCard ? Math.max(0, Math.round(targetMkt - mkt)) : 0;
  const fmtExcess = excessAmt.toLocaleString('zh-CN');

  const windowNote =
    reminder.remainingTradeDays === 1
      ? `今日新开仓受 T+1 限制将跨假锁仓 ${reminder.closedDays} 天至 ${reminder.reopenDate.slice(5)} 开市，宜逢日内冲高倒T或直接减仓锁利，切忌尾盘重仓博弈假期消息`
      : `今日为节前取现最后卖出窗口，午后易现避险兑现抛压，宜提前去弱留强分批降仓，规避连休 ${reminder.closedDays} 天外围波动`;

  const capSourceLabel =
    effectiveCapPct < holidayCapPct
      ? `情绪+节前从严上限 ${effectiveCapPct}%`
      : `节前建议上限 ${effectiveCapPct}%（${reminder.posRangeLabel || `≤${holidayCapPct}%`}）`;

  const pillText = isYellowCard
    ? `🟨 节前控仓黄牌：距${reminder.holidayName}(休${reminder.closedDays}天)剩${reminder.remainingTradeDays}交易日 · 超上限(${effectiveCapPct}%) ${excessPct}%，建议降仓 ¥${fmtExcess}`
    : `✅ 节前仓位达标：距${reminder.holidayName}(休${reminder.closedDays}天)剩${reminder.remainingTradeDays}交易日 · 符合 ≤${effectiveCapPct}% 控仓线`;

  const bannerText = isYellowCard
    ? `距${reminder.holidayName}连休 ${reminder.closedDays} 天（${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)}，${reminder.reopenDate.slice(5)} 开市）仅剩 ${reminder.remainingTradeDays} 个交易日：当前总仓 ${posPct.toFixed(1)}% 超出${capSourceLabel} ${excessPct}%，建议逢高降仓约 ¥${fmtExcess}。${windowNote}。`
    : '';

  return {
    active: true,
    isYellowCard,
    reminder,
    holidayName: reminder.holidayName,
    closedDays: reminder.closedDays,
    remainingTradeDays: reminder.remainingTradeDays,
    closureStart: reminder.closureStart,
    closureEnd: reminder.closureEnd,
    reopenDate: reminder.reopenDate,
    holidayCapPct,
    effectiveCapPct,
    excessPct,
    excessAmt,
    headroomAmt,
    posRangeLabel: reminder.posRangeLabel || (holidayCapPct <= 30 ? '≤3成' : '3~5成'),
    windowNote,
    capSourceLabel,
    pillText,
    bannerText,
  };
}

/**
 * 顶栏交易时钟按钮（TopNav #tbClockPill）专用：法定节假日休市状态与节前控仓黄牌角标评估器
 * - 法定节假日连休期（含紧邻调休/周末连休块）：展示「🏮 XX休市 · 连休N天」休市角标（若跨假持仓超上限则附加提醒）
 * - 连续 >=3 天长假前最后 1~2 个交易日：
 *   - 实际总仓位 > effectiveCapPct + 0.1 时：亮「🟨 节前黄牌 · XX前N日(超X%线)」醒目黄牌角标
 *   - 实际总仓位达标时：展示「🏮 XX前N日 · 控仓≤X%达标」节前窗口角标
 * - 距连续 >=3 天长假尚余 3~5 个交易日：展示轻量「📅 XX前N日」预告角标
 * - 普通交易日/普通周末/单日短假：不展示额外角标，保持顶栏清爽零噪音
 */
export function evaluateTopNavClockBadge({
  totalPosPct = 0,
  totalMkt = 0,
  totalAssets = 100000,
  emotionCapPct = 80,
  holidayReminder = undefined,
  now = null,
} = {}) {
  const targetNow = now || new Date();
  const st = getAShareMarketStatus(targetNow);
  const reminder =
    holidayReminder !== undefined
      ? holidayReminder
      : getUpcomingHolidayReminder(targetNow);

  const posPct = Math.max(0, Number(totalPosPct) || 0);
  const emoCap = Math.min(100, Math.max(0, Number(emotionCapPct ?? 80)));

  const guard = evaluateHolidayPositionGuard({
    totalPosPct: posPct,
    totalMkt,
    totalAssets,
    emotionCapPct: emoCap,
    holidayReminder: reminder,
    now: targetNow,
  });

  // 计算顶栏时钟圆点状态色
  let dotTone = 'idle';
  if (!st.isTradeDay || reminder?.phase === 'in_holiday') {
    dotTone = st.isHoliday || reminder?.phase === 'in_holiday' ? 'closed' : 'idle';
  } else if (guard.isYellowCard) {
    dotTone = 'warn';
  } else if (st.mins >= 870 && st.mins < 895) {
    dotTone = 'danger';
  } else if ((st.mins >= 570 && st.mins <= 690) || (st.mins >= 780 && st.mins <= 900)) {
    dotTone = 'live';
  }

  // 1) 法定节假日休市期（含连休区间内的紧邻周末）
  if (st.isHoliday || reminder?.phase === 'in_holiday') {
    const holName = String(reminder?.holidayName || st.holidayName || '节假日').replace(/休市$/, '');
    const closedDays = Math.max(1, Number(reminder?.closedDays || 1));
    const reopenDate = reminder?.reopenDate || st.nextTradeDate || '';
    const reopenShort = reopenDate ? reopenDate.slice(5) : '';
    const isLongHol = Boolean(reminder?.isLongHoliday || closedDays >= 3);
    const holCap = isLongHol
      ? Math.min(emoCap, Number(reminder?.suggestedMaxPosPct) || (closedDays >= 7 ? 30 : 50))
      : null;
    const isOverCap = holCap !== null && posPct > holCap + 0.1;
    const statusWord = st.isHoliday ? `${holName}休市` : `${holName}连休`;

    return {
      kind: 'holiday_closed',
      showBadge: true,
      isYellowCard: isOverCap,
      isHolidayClosed: true,
      dotTone: isOverCap ? 'warn' : 'closed',
      pillTone: isOverCap ? 'is-holiday-yellow' : 'is-holiday-closed',
      badgeTone: isOverCap ? 'holiday-overcap' : 'holiday-closed',
      holidayName: holName,
      closedDays,
      remainingTradeDays: 0,
      reopenDate,
      effectiveCapPct: holCap,
      excessPct: isOverCap ? +(posPct - holCap).toFixed(1) : 0,
      badgeText: isOverCap
        ? `🏮 ${statusWord}(${closedDays}天) · 🟨跨假超${holCap}%线`
        : `🏮 ${statusWord} · 连休${closedDays}天`,
      tooltip: isOverCap
        ? `🏮 ${holName}休市期（连休 ${closedDays} 天，${reopenShort || reopenDate} 开市）：当前跨假仓位 ${posPct.toFixed(1)}% 高于建议水位 ${holCap}%，点击查看交易时钟与节后首日竞价减仓纪律`
        : `🏮 ${holName}法定休市期（${reminder?.closureStart ? `${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)} ` : ''}连休 ${closedDays} 天，${reopenShort || reopenDate} 恢复开市），点击查看交易时钟详情`,
    };
  }

  // 2) 连续 >=3 天长假前最后 1~2 个交易日（含紧邻节前控仓窗的周末预检）
  if (guard.active) {
    const dayPrefix = st.isTradeDay
      ? `${guard.holidayName}前${guard.remainingTradeDays}日`
      : `下周距${guard.holidayName}剩${guard.remainingTradeDays}日`;

    if (guard.isYellowCard) {
      return {
        kind: 'pre_holiday_yellow',
        showBadge: true,
        isYellowCard: true,
        isHolidayClosed: false,
        dotTone: 'warn',
        pillTone: 'is-holiday-yellow',
        badgeTone: 'yellow-card',
        holidayName: guard.holidayName,
        closedDays: guard.closedDays,
        remainingTradeDays: guard.remainingTradeDays,
        reopenDate: guard.reopenDate,
        effectiveCapPct: guard.effectiveCapPct,
        excessPct: guard.excessPct,
        excessAmt: guard.excessAmt,
        badgeText: `🟨 节前黄牌 · ${dayPrefix}(超${guard.effectiveCapPct}%线)`,
        tooltip: `🟨 节前控仓黄牌：距${guard.holidayName}连休 ${guard.closedDays} 天（${guard.closureStart.slice(5)}~${guard.closureEnd.slice(5)}，${guard.reopenDate.slice(5)} 开市）仅剩 ${guard.remainingTradeDays} 个交易日！当前总仓位 ${posPct.toFixed(1)}% 超出上限 ${guard.effectiveCapPct}%（超额 ${guard.excessPct}% / 约 ¥${guard.excessAmt.toLocaleString('zh-CN')}），点击查看分时减仓纪律`,
      };
    }

    return {
      kind: 'pre_holiday_window',
      showBadge: true,
      isYellowCard: false,
      isHolidayClosed: false,
      dotTone,
      pillTone: 'is-holiday-window',
      badgeTone: 'window-safe',
      holidayName: guard.holidayName,
      closedDays: guard.closedDays,
      remainingTradeDays: guard.remainingTradeDays,
      reopenDate: guard.reopenDate,
      effectiveCapPct: guard.effectiveCapPct,
      excessPct: 0,
      excessAmt: 0,
      badgeText: `🏮 ${dayPrefix} · 控仓≤${guard.effectiveCapPct}%达标`,
      tooltip: `🏮 节前控仓窗口：距${guard.holidayName}连休 ${guard.closedDays} 天仅剩 ${guard.remainingTradeDays} 个交易日，当前总仓位 ${posPct.toFixed(1)}% 符合 ≤${guard.effectiveCapPct}% 控仓线，点击查看交易时钟与跨假 T+1 铁律`,
    };
  }

  // 3) 距连续 >=3 天长假尚余 3~5 个交易日（轻量倒计时预告）
  if (reminder && reminder.phase === 'pre_holiday_countdown' && reminder.isLongHoliday) {
    const preCap = Math.min(emoCap, Number(reminder.suggestedMaxPosPct) || (reminder.closedDays >= 7 ? 30 : 50));
    return {
      kind: 'pre_holiday_countdown',
      showBadge: true,
      isYellowCard: false,
      isHolidayClosed: false,
      dotTone,
      pillTone: '',
      badgeTone: 'countdown',
      holidayName: reminder.holidayName,
      closedDays: reminder.closedDays,
      remainingTradeDays: reminder.remainingTradeDays,
      reopenDate: reminder.reopenDate,
      effectiveCapPct: preCap,
      excessPct: 0,
      excessAmt: 0,
      badgeText: `📅 ${reminder.holidayName}前${reminder.remainingTradeDays}日`,
      tooltip: `📅 近期长假预告：距${reminder.holidayName}连休 ${reminder.closedDays} 天（${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)}）还有 ${reminder.remainingTradeDays} 个交易日，节前 2 日将启动 ≤${preCap}% 分档控仓提示`,
    };
  }

  // 4) 常态交易日 / 普通双休周末 / 单日短假
  return {
    kind: 'normal',
    showBadge: false,
    isYellowCard: false,
    isHolidayClosed: false,
    dotTone,
    pillTone: '',
    badgeTone: '',
    holidayName: null,
    closedDays: 0,
    remainingTradeDays: 0,
    reopenDate: st.nextTradeDate || '',
    effectiveCapPct: emoCap,
    excessPct: 0,
    excessAmt: 0,
    badgeText: '',
    tooltip: '点击展开全天交易纪律时钟、法定节假日休市状态与节前控仓窗口说明',
  };
}

/**
 * 新开仓 / 加仓 / 尾盘潜伏买入前的节前长假控仓黄牌预检器：
 * - 触发条件：处于连续休市 >= 3 天（含法定节假日）前最后 1~2 个交易日（isHighAlert === true），
 *   且本笔拟买入金额 buyAmt > 0 后，预计总仓位 afterPosPct > effectiveCapPct + 0.1
 * - 输出：买前/买后总仓占比、超出比例与超额金额、控仓上限内最大安全可买整手股数（maxSafeShares）、
 *   行内黄牌提示文案（inlineWarnText）以及二次确认弹窗文案（confirmPromptText）
 */
export function evaluatePreTradeHolidayGuard({
  currentMkt = 0,
  buyAmt = 0,
  unitPrice = 0,
  totalAssets = 100000,
  emotionCapPct = 80,
  holidayReminder = undefined,
  now = null,
  isTailBuy = false,
  stockName = '',
} = {}) {
  const reminder =
    holidayReminder !== undefined
      ? holidayReminder
      : getUpcomingHolidayReminder(now || new Date());

  const assets = Math.max(1, Number(totalAssets) || 100000);
  const curMkt = Math.max(0, Number(currentMkt) || 0);
  const addedAmt = Math.max(0, Number(buyAmt) || 0);
  const px = Math.max(0, Number(unitPrice) || 0);
  const emoCap = Math.min(100, Math.max(0, Number(emotionCapPct ?? 80)));
  const beforePosPct = +((curMkt / assets) * 100).toFixed(1);
  const afterMkt = curMkt + addedAmt;
  const afterPosPct = +((afterMkt / assets) * 100).toFixed(1);

  if (
    !reminder ||
    !reminder.isHighAlert ||
    !(reminder.closedDays >= 3) ||
    !(reminder.remainingTradeDays >= 1 && reminder.remainingTradeDays <= 2)
  ) {
    return {
      active: false,
      alreadyOverCap: false,
      willExceedCap: false,
      reminder: reminder || null,
      holidayName: reminder?.holidayName || null,
      closedDays: reminder?.closedDays || 0,
      remainingTradeDays: reminder?.remainingTradeDays || 0,
      closureStart: reminder?.closureStart || '',
      closureEnd: reminder?.closureEnd || '',
      reopenDate: reminder?.reopenDate || '',
      holidayCapPct: null,
      effectiveCapPct: emoCap,
      beforePosPct,
      afterPosPct,
      overPct: 0,
      overAmt: 0,
      maxSafeBuyAmt: Math.max(0, Math.floor((assets * emoCap) / 100 - curMkt)),
      maxSafeShares: 0,
      capSourceLabel: '',
      inlineWarnText: '',
      confirmPromptText: '',
    };
  }

  const holidayCapPct =
    Number(reminder.suggestedMaxPosPct) > 0
      ? Number(reminder.suggestedMaxPosPct)
      : reminder.closedDays >= 7
      ? 30
      : 50;
  const effectiveCapPct = Math.min(emoCap, holidayCapPct);
  const targetMaxMkt = (assets * effectiveCapPct) / 100;
  const alreadyOverCap = beforePosPct > effectiveCapPct + 0.1;
  const willExceedCap = addedAmt > 0 && afterPosPct > effectiveCapPct + 0.1;
  const overPct = willExceedCap ? +(afterPosPct - effectiveCapPct).toFixed(1) : 0;
  const overAmt = willExceedCap ? Math.max(0, Math.round(afterMkt - targetMaxMkt)) : 0;
  const maxSafeBuyAmt = Math.max(0, Math.floor(targetMaxMkt - curMkt));
  const maxSafeShares = px > 0 ? Math.max(0, Math.floor(maxSafeBuyAmt / (px * 100)) * 100) : 0;

  const capSourceLabel =
    effectiveCapPct < holidayCapPct
      ? `情绪+节前从严上限 ${effectiveCapPct}%`
      : `${reminder.holidayName}节前建议上限 ${effectiveCapPct}%（${reminder.posRangeLabel || `≤${holidayCapPct}%`}）`;

  const t1LockNote =
    reminder.remainingTradeDays === 1
      ? isTailBuy
        ? `今日为${reminder.holidayName}前最后 1 个交易日，尾盘潜伏仓受 T+1 限制无法「次日早盘平仓」，将跨越整个 ${reminder.closedDays} 天长假锁仓至 ${reminder.reopenDate.slice(5)} 开市！`
        : `今日为${reminder.holidayName}前最后 1 个交易日，新买入筹码受 T+1 限制将跨假锁定 ${reminder.closedDays} 天至 ${reminder.reopenDate.slice(5)} 开市才能卖出！`
      : isTailBuy
      ? `距${reminder.holidayName}连休 ${reminder.closedDays} 天仅剩 2 个交易日（明日即为节前收官日），隔夜尾盘仓面临节前避险兑现抛压。`
      : `距${reminder.holidayName}连休 ${reminder.closedDays} 天仅剩 2 个交易日（节前取现卖出窗口），重仓过节易承受外围波动与兑现抛压。`;

  const safeCapHint =
    maxSafeShares >= 100
      ? `控仓线内最多可买 ${maxSafeShares} 股（约 ¥${Math.round(maxSafeShares * px).toLocaleString('zh-CN')}）`
      : '当前持仓已触及或超过节前控仓上限，建议先减旧仓再开新仓';

  const inlineWarnText = willExceedCap
    ? `🟨 节前控仓黄牌：距${reminder.holidayName}(休${reminder.closedDays}天)剩${reminder.remainingTradeDays}交易日，买后总仓将由 ${beforePosPct.toFixed(1)}% 升至 ${afterPosPct.toFixed(1)}%，超${capSourceLabel} ${overPct}%（超额约 ¥${overAmt.toLocaleString('zh-CN')} · ${safeCapHint}）`
    : '';

  const targetTitle = stockName ? `【${stockName}】` : '本笔';
  const confirmPromptText = willExceedCap
    ? [
        `🟨 节前控仓黄牌二次提醒`,
        ``,
        `• 假期窗口：距${reminder.holidayName}连休 ${reminder.closedDays} 天（${reminder.closureStart.slice(5)}~${reminder.closureEnd.slice(5)}，${reminder.reopenDate.slice(5)} 开市）仅剩 ${reminder.remainingTradeDays} 个交易日`,
        `• 仓位测算：${targetTitle}拟买入约 ¥${Math.round(addedAmt).toLocaleString('zh-CN')}，买后总仓位将由 ${beforePosPct.toFixed(1)}% 升至 ${afterPosPct.toFixed(1)}%，超出${capSourceLabel} ${overPct}%（超额约 ¥${overAmt.toLocaleString('zh-CN')}）`,
        `• 控仓建议：${safeCapHint}`,
        `• 风险提示：${t1LockNote}`,
        ``,
        `确定仍要突破节前控仓上限继续买入吗？`,
      ].join('\n')
    : '';

  return {
    active: true,
    alreadyOverCap,
    willExceedCap,
    reminder,
    holidayName: reminder.holidayName,
    closedDays: reminder.closedDays,
    remainingTradeDays: reminder.remainingTradeDays,
    closureStart: reminder.closureStart,
    closureEnd: reminder.closureEnd,
    reopenDate: reminder.reopenDate,
    holidayCapPct,
    effectiveCapPct,
    beforePosPct,
    afterPosPct,
    overPct,
    overAmt,
    maxSafeBuyAmt,
    maxSafeShares,
    capSourceLabel,
    t1LockNote,
    safeCapHint,
    inlineWarnText,
    confirmPromptText,
  };
}

/**
 * 账户资产总览页（AccountPage）专用：节前长假控仓上限水位线、跨假安全可开仓余量与避险储备现金核算
 */
export function evaluateAccountHolidayWatermark({
  totalAssets = 100000,
  marketValue = 0,
  cash = 0,
  posRate = null,
  emotionCapPct = 80,
  holidayReminder = undefined,
  now = null,
} = {}) {
  const assets = Math.max(1, Number(totalAssets) || 100000);
  const mkt = Math.max(0, Number(marketValue) || 0);
  const availCash = Math.max(0, Number(cash) || 0);
  const resolvedPosPct =
    posRate !== null && posRate !== undefined && Number.isFinite(+posRate)
      ? +(+posRate).toFixed(1)
      : +((mkt / assets) * 100).toFixed(1);
  const emoCap = Math.min(100, Math.max(0, Number(emotionCapPct ?? 80)));

  const reminder =
    holidayReminder !== undefined
      ? holidayReminder
      : getUpcomingHolidayReminder(now || new Date());

  const guard = evaluateHolidayPositionGuard({
    totalPosPct: resolvedPosPct,
    totalMkt: mkt,
    totalAssets: assets,
    emotionCapPct: emoCap,
    holidayReminder: reminder,
    now,
  });

  // 1) 连续>=3天长假前最后1~2个交易日（核心控仓窗口）
  if (guard.active) {
    const watermarkPct = guard.effectiveCapPct;
    const watermarkMkt = Math.round((assets * watermarkPct) / 100);
    const headroomAmt = guard.isYellowCard ? 0 : Math.max(0, Math.round(watermarkMkt - mkt));
    const headroomPct = guard.isYellowCard ? 0 : +Math.max(0, watermarkPct - resolvedPosPct).toFixed(1);
    const deployableCash = guard.isYellowCard ? 0 : Math.round(Math.min(availCash, headroomAmt));
    const reserveCash = Math.max(0, Math.round(availCash - deployableCash));

    return {
      mode: guard.isYellowCard ? 'over_cap' : 'safe_urgent',
      showBanner: true,
      showChartLine: true,
      isYellowCard: guard.isYellowCard,
      holidayName: guard.holidayName,
      closedDays: guard.closedDays,
      remainingTradeDays: guard.remainingTradeDays,
      closureStart: guard.closureStart,
      closureEnd: guard.closureEnd,
      reopenDate: guard.reopenDate,
      posPct: resolvedPosPct,
      emotionCapPct: emoCap,
      holidayCapPct: guard.holidayCapPct,
      watermarkPct,
      watermarkMkt,
      posRangeLabel: guard.posRangeLabel,
      capSourceLabel: guard.capSourceLabel,
      excessPct: guard.excessPct,
      excessAmt: guard.excessAmt,
      headroomPct,
      headroomAmt,
      deployableCash,
      reserveCash,
      windowNote: guard.windowNote,
    };
  }

  // 2) 正处于连续>=3天法定长假休市期
  if (reminder && reminder.phase === 'in_holiday' && reminder.isLongHoliday) {
    const holCap = Number(reminder.suggestedMaxPosPct) || (reminder.closedDays >= 7 ? 30 : 50);
    const watermarkPct = Math.min(emoCap, holCap);
    const watermarkMkt = Math.round((assets * watermarkPct) / 100);
    const isOver = resolvedPosPct > watermarkPct + 0.1;
    const excessPct = isOver ? +(resolvedPosPct - watermarkPct).toFixed(1) : 0;
    const excessAmt = isOver ? Math.max(0, Math.round(mkt - watermarkMkt)) : 0;
    const headroomAmt = isOver ? 0 : Math.max(0, Math.round(watermarkMkt - mkt));
    const headroomPct = isOver ? 0 : +Math.max(0, watermarkPct - resolvedPosPct).toFixed(1);
    const deployableCash = isOver ? 0 : Math.round(Math.min(availCash, headroomAmt));
    const reserveCash = Math.max(0, Math.round(availCash - deployableCash));

    return {
      mode: 'in_holiday',
      showBanner: true,
      showChartLine: true,
      isYellowCard: isOver,
      holidayName: reminder.holidayName,
      closedDays: reminder.closedDays,
      remainingTradeDays: 0,
      closureStart: reminder.closureStart,
      closureEnd: reminder.closureEnd,
      reopenDate: reminder.reopenDate,
      posPct: resolvedPosPct,
      emotionCapPct: emoCap,
      holidayCapPct: holCap,
      watermarkPct,
      watermarkMkt,
      posRangeLabel: holCap <= 30 ? '≤3成' : '3~5成',
      capSourceLabel: `${reminder.holidayName}跨假水位线 ≤${watermarkPct}%`,
      excessPct,
      excessAmt,
      headroomPct,
      headroomAmt,
      deployableCash,
      reserveCash,
      windowNote: isOver
        ? `当前跨假持仓超出建议水位 ${excessPct}%，节后首日（${reminder.reopenDate.slice(5)}）09:25 竞价请重点核查强弱，优先逢高收回超额敞口`
        : `当前跨假仓位严守在 ≤${watermarkPct}% 安全水位内，节后首日（${reminder.reopenDate.slice(5)}）拥有充足现金主动出击`,
    };
  }

  // 3) 距连续>=3天长假尚余 3~5 个交易日（提前规划期）
  if (reminder && reminder.phase === 'pre_holiday_countdown' && reminder.isLongHoliday) {
    const holCap = Number(reminder.suggestedMaxPosPct) || (reminder.closedDays >= 7 ? 30 : 50);
    const watermarkPct = Math.min(emoCap, holCap);
    const watermarkMkt = Math.round((assets * watermarkPct) / 100);
    const overFutureCap = resolvedPosPct > watermarkPct + 0.1;
    const excessAmt = overFutureCap ? Math.max(0, Math.round(mkt - watermarkMkt)) : 0;
    const headroomAmt = overFutureCap ? 0 : Math.max(0, Math.round(watermarkMkt - mkt));
    const headroomPct = overFutureCap ? 0 : +Math.max(0, watermarkPct - resolvedPosPct).toFixed(1);
    const deployableCash = overFutureCap ? 0 : Math.round(Math.min(availCash, headroomAmt));
    const reserveCash = Math.max(0, Math.round(availCash - deployableCash));

    return {
      mode: 'advance_countdown',
      showBanner: true,
      showChartLine: true,
      isYellowCard: false,
      holidayName: reminder.holidayName,
      closedDays: reminder.closedDays,
      remainingTradeDays: reminder.remainingTradeDays,
      closureStart: reminder.closureStart,
      closureEnd: reminder.closureEnd,
      reopenDate: reminder.reopenDate,
      posPct: resolvedPosPct,
      emotionCapPct: emoCap,
      holidayCapPct: holCap,
      watermarkPct,
      watermarkMkt,
      posRangeLabel: reminder.posRangeLabel || (holCap <= 30 ? '≤3成' : '3~5成'),
      capSourceLabel: `${reminder.holidayName}预备控仓线 ≤${watermarkPct}%`,
      excessPct: overFutureCap ? +(resolvedPosPct - watermarkPct).toFixed(1) : 0,
      excessAmt,
      headroomPct,
      headroomAmt,
      deployableCash,
      reserveCash,
      windowNote: overFutureCap
        ? `距${reminder.holidayName}连休 ${reminder.closedDays} 天还有 ${reminder.remainingTradeDays} 个交易日，进入节前 2 日前需逢高回笼约 ¥${excessAmt.toLocaleString('zh-CN')} 至 ≤${watermarkPct}%`
        : `距${reminder.holidayName}连休 ${reminder.closedDays} 天还有 ${reminder.remainingTradeDays} 个交易日，当前仓位已提前符合 ≤${watermarkPct}% 跨假水位`,
    };
  }

  // 4) 常态交易周或单日短假（零额外横幅噪音，按日常情绪上限核算机动余量）
  const watermarkMkt = Math.round((assets * emoCap) / 100);
  const isOverEmo = resolvedPosPct > emoCap + 0.1;
  const headroomAmt = isOverEmo ? 0 : Math.max(0, Math.round(watermarkMkt - mkt));
  const deployableCash = isOverEmo ? 0 : Math.round(Math.min(availCash, headroomAmt));

  return {
    mode: 'normal',
    showBanner: false,
    showChartLine: false,
    isYellowCard: false,
    holidayName: reminder?.holidayName || null,
    closedDays: reminder?.closedDays || 0,
    remainingTradeDays: reminder?.remainingTradeDays || 0,
    closureStart: reminder?.closureStart || '',
    closureEnd: reminder?.closureEnd || '',
    reopenDate: reminder?.reopenDate || '',
    posPct: resolvedPosPct,
    emotionCapPct: emoCap,
    holidayCapPct: null,
    watermarkPct: emoCap,
    watermarkMkt,
    posRangeLabel: '',
    capSourceLabel: `情绪风控上限 ≤${emoCap}%`,
    excessPct: isOverEmo ? +(resolvedPosPct - emoCap).toFixed(1) : 0,
    excessAmt: isOverEmo ? Math.max(0, Math.round(mkt - watermarkMkt)) : 0,
    headroomPct: isOverEmo ? 0 : +Math.max(0, emoCap - resolvedPosPct).toFixed(1),
    headroomAmt,
    deployableCash,
    reserveCash: Math.max(0, Math.round(availCash - deployableCash)),
    windowNote: '',
  };
}

export const POSITION_BUILD_BUY_DIRS = new Set([
  '买入建仓',
  '买入加仓',
  '直接买入',
  '尾盘买入',
  '底仓建仓',
  '连板追涨',
  '龙头抄底',
]);

/**
 * 盘中与盘后执行纪律审计：节前连续长假（>=3天连休前最后1~2个交易日）超上限建仓判定与扣分计算
 * - 仅针对增加隔夜持仓的新开仓/加仓/尾盘潜伏买单（日内已平仓正T/倒T不增加隔夜敞口，不误判）
 * - 支持实时成交前市值快照（currentMktVal）、历史已持久化买后仓位（savedPostBuyPosPct）及当日持仓回算
 */
export function auditPreHolidayBuyDiscipline({
  dir = '正T',
  buy = 0,
  sell = 0,
  qty = 0,
  date = todayStr(),
  totalAssets = 100000,
  currentMktVal = null,
  poolList = [],
  tailActives = [],
  emotionCapPct = 80,
  savedPostBuyPosPct = null,
  savedHolidayCapPct = null,
  holidayReminder = undefined,
} = {}) {
  const buyPx = Math.max(0, Number(buy) || 0);
  const sellPx = Math.max(0, Number(sell) || 0);
  const qNum = Math.max(0, parseInt(qty, 10) || 0);
  const tradeDate = String(date || todayStr()).slice(0, 10);

  // 仅针对新增或扩大隔夜仓位的买单；日内已闭环的正T/倒T或卖出单不触发节前超上限建仓
  const isOvernightBuildBuy =
    buyPx > 0 &&
    qNum > 0 &&
    POSITION_BUILD_BUY_DIRS.has(String(dir || '')) &&
    !((dir === '连板追涨' || dir === '龙头抄底') && sellPx > 0 && savedPostBuyPosPct === null && currentMktVal === null);

  const reminder =
    holidayReminder !== undefined
      ? holidayReminder
      : getUpcomingHolidayReminder(tradeDate);

  if (
    !isOvernightBuildBuy ||
    !reminder ||
    !reminder.isHighAlert ||
    !(reminder.closedDays >= 3) ||
    !(reminder.remainingTradeDays >= 1 && reminder.remainingTradeDays <= 2)
  ) {
    return {
      active: false,
      triggered: false,
      tag: null,
      scorePenalty: 0,
      postBuyPosPct: savedPostBuyPosPct != null && Number.isFinite(+savedPostBuyPosPct) ? +savedPostBuyPosPct : null,
      effectiveCapPct: savedHolidayCapPct != null && Number.isFinite(+savedHolidayCapPct) ? +savedHolidayCapPct : null,
      beforePosPct: null,
      overPct: 0,
      overAmt: 0,
      holidayName: reminder?.holidayName || null,
      closedDays: reminder?.closedDays || 0,
      remainingTradeDays: reminder?.remainingTradeDays || 0,
      reopenDate: reminder?.reopenDate || '',
    };
  }

  const assets = Math.max(1, Number(totalAssets) || 100000);
  const buyAmt = buyPx * qNum;
  const emoCap = Math.min(100, Math.max(0, Number(emotionCapPct ?? 80)));

  // 若已有持久化的买后仓位占比（复盘编辑或历史回溯），优先精确还原当时的买前市值
  let baseMkt = 0;
  if (savedPostBuyPosPct !== null && savedPostBuyPosPct !== undefined && Number.isFinite(+savedPostBuyPosPct)) {
    const targetAfterMkt = (assets * Math.max(0, +savedPostBuyPosPct)) / 100;
    baseMkt = Math.max(0, targetAfterMkt - buyAmt);
  } else if (currentMktVal !== null && currentMktVal !== undefined && Number.isFinite(+currentMktVal)) {
    baseMkt = Math.max(0, Number(currentMktVal));
  } else if (tradeDate === todayStr()) {
    const pMkt = (Array.isArray(poolList) ? poolList : []).reduce(
      (acc, s) => acc + (+s?.shares || 0) * (+s?.price || +s?.cost || 0),
      0
    );
    const tMkt = (Array.isArray(tailActives) ? tailActives : []).reduce(
      (acc, t) => acc + (!t || t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)),
      0
    );
    baseMkt = Math.max(0, pMkt + tMkt);
  }

  const check = evaluatePreTradeHolidayGuard({
    currentMkt: baseMkt,
    buyAmt,
    unitPrice: buyPx,
    totalAssets: assets,
    emotionCapPct: emoCap,
    holidayReminder: reminder,
    isTailBuy: dir === '尾盘买入',
  });

  const resolvedAfterPct =
    savedPostBuyPosPct !== null && savedPostBuyPosPct !== undefined && Number.isFinite(+savedPostBuyPosPct)
      ? +(+savedPostBuyPosPct).toFixed(1)
      : check.afterPosPct;
  const resolvedCapPct =
    savedHolidayCapPct !== null && savedHolidayCapPct !== undefined && Number.isFinite(+savedHolidayCapPct) && +savedHolidayCapPct > 0
      ? +savedHolidayCapPct
      : check.effectiveCapPct;
  const triggered = resolvedAfterPct > resolvedCapPct + 0.1;
  const scorePenalty = triggered
    ? check.remainingTradeDays === 1
      ? dir === '尾盘买入'
        ? 22
        : 20
      : 16
    : 0;

  return {
    active: true,
    triggered,
    tag: triggered ? 'pre_holiday_overcap' : null,
    scorePenalty,
    postBuyPosPct: resolvedAfterPct,
    effectiveCapPct: resolvedCapPct,
    beforePosPct: check.beforePosPct,
    overPct: triggered ? +(resolvedAfterPct - resolvedCapPct).toFixed(1) : 0,
    overAmt: triggered ? Math.max(0, Math.round(((resolvedAfterPct - resolvedCapPct) / 100) * assets)) : 0,
    holidayName: check.holidayName,
    closedDays: check.closedDays,
    remainingTradeDays: check.remainingTradeDays,
    reopenDate: check.reopenDate,
  };
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
  const openOnlyDirs = new Set(['买入建仓', '底仓建仓', '买入加仓', '直接买入', '尾盘买入']);

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
    const openDirs = new Set(['买入建仓', '底仓建仓', '直接买入', '尾盘买入']);
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
      isT1Day = prevAShareTradeDate(today) === latestEntryDate;
    }
  }

  // 当前是否进入尾盘收盘判定窗口 (北京时间 14:40 之后或已收盘/非交易时段)
  const mins = getCNClock(new Date()).mins;
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
