/**
 * src/services/calendar.js
 *
 * A股交易日历与盘中开休市判定服务（参考 InStock trade_time 过滤机制）：
 * 1. 内置沪深北交易所 2024-2027 法定节假日休市区间（周六、周日恒休市，不受调休补班影响）
 * 2. 支持异步加载 /data/trade_calendar.json 动态同步后端/定时任务自学习的休市日
 * 3. 统一以北京时间 (Asia/Shanghai, UTC+8) 判定交易日与连续竞价窗口，跨时区访问零偏差
 * 4. 提供节前法定节假日倒计时与连续长假（≥3天休市且仅剩1-2个交易日）隔夜仓位风控预警计算
 */

const CN_OFFSET_MS = 8 * 3600 * 1000;

export const BUILTIN_HOLIDAY_RANGES = [
  { start: '2024-01-01', end: '2024-01-01', name: '元旦' },
  { start: '2024-02-09', end: '2024-02-17', name: '春节' },
  { start: '2024-04-04', end: '2024-04-06', name: '清明节' },
  { start: '2024-05-01', end: '2024-05-05', name: '劳动节' },
  { start: '2024-06-08', end: '2024-06-10', name: '端午节' },
  { start: '2024-09-15', end: '2024-09-17', name: '中秋节' },
  { start: '2024-10-01', end: '2024-10-07', name: '国庆节' },

  { start: '2025-01-01', end: '2025-01-01', name: '元旦' },
  { start: '2025-01-28', end: '2025-02-04', name: '春节' },
  { start: '2025-04-04', end: '2025-04-06', name: '清明节' },
  { start: '2025-05-01', end: '2025-05-05', name: '劳动节' },
  { start: '2025-05-31', end: '2025-06-02', name: '端午节' },
  { start: '2025-10-01', end: '2025-10-08', name: '国庆中秋' },

  { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
  { start: '2026-02-15', end: '2026-02-23', name: '春节' },
  { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
  { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
  { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
  { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
  { start: '2026-10-01', end: '2026-10-07', name: '国庆节' },

  { start: '2027-01-01', end: '2027-01-03', name: '元旦' },
  { start: '2027-02-05', end: '2027-02-13', name: '春节' },
  { start: '2027-04-03', end: '2027-04-05', name: '清明节' },
  { start: '2027-05-01', end: '2027-05-05', name: '劳动节' },
  { start: '2027-06-09', end: '2027-06-09', name: '端午节' },
  { start: '2027-09-15', end: '2027-09-15', name: '中秋节' },
  { start: '2027-10-01', end: '2027-10-07', name: '国庆节' },
];

const HOLIDAY_MAP = new Map();

function applyHolidayRanges(ranges, learned = {}) {
  for (const r of ranges || []) {
    if (!r || !r.start || !r.end) continue;
    const cur = new Date(`${r.start}T00:00:00Z`);
    const end = new Date(`${r.end}T00:00:00Z`);
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) continue;
    while (cur <= end) {
      HOLIDAY_MAP.set(cur.toISOString().slice(0, 10), r.name || '节假日');
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  if (learned && typeof learned === 'object') {
    for (const [ds, label] of Object.entries(learned)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(ds) && label) {
        HOLIDAY_MAP.set(ds, String(label));
      }
    }
  }
}

applyHolidayRanges(BUILTIN_HOLIDAY_RANGES);

let _remoteSynced = false;

/**
 * 异步拉取 /data/trade_calendar.json，合并新增年度节假日或盘中探测到的临时休市日
 */
export async function syncRemoteTradeCalendar() {
  if (_remoteSynced || typeof fetch === 'undefined') return;
  _remoteSynced = true;
  try {
    const res = await fetch('/data/trade_calendar.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data === 'object') {
      applyHolidayRanges(data.holidayRanges || [], data.learnedClosedDates || {});
    }
  } catch (_) {
    // 静态内置日历已完备兜底，忽略离线环境拉取异常
  }
}

/**
 * 提取北京时间 (UTC+8) 的日期与时分秒字段
 */
export function getCNClock(input = new Date()) {
  if (typeof input === 'string') {
    const clean = input.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      const dt = new Date(`${clean}T12:00:00+08:00`);
      const shifted = new Date(dt.getTime() + CN_OFFSET_MS);
      return {
        dateStr: clean,
        weekday: shifted.getUTCDay(),
        hour: 12,
        minute: 0,
        second: 0,
        mins: 720,
        timeStr: '12:00:00',
      };
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  const shifted = new Date(d.getTime() + CN_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();
  const ss = shifted.getUTCSeconds();
  return {
    dateStr: `${y}-${m}-${day}`,
    weekday: shifted.getUTCDay(),
    hour: hh,
    minute: mm,
    second: ss,
    mins: hh * 60 + mm,
    timeStr: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
  };
}

function stepDateStr(dateStr, deltaDays) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function diffCalendarDays(startStr, endStr) {
  const a = new Date(`${startStr}T00:00:00Z`);
  const b = new Date(`${endStr}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * 判断指定时间或日期字符串是否为 A 股交易日（自动剔除周末与法定节假日）
 */
export function isAShareTradeDay(input = new Date()) {
  const ck = getCNClock(input);
  if (ck.weekday === 0 || ck.weekday === 6) return false;
  return !HOLIDAY_MAP.has(ck.dateStr);
}

/** 获取指定日期之后的下一个 A 股交易日 (YYYY-MM-DD) */
export function nextAShareTradeDate(input = new Date()) {
  let cur = getCNClock(input).dateStr;
  for (let i = 0; i < 45; i += 1) {
    cur = stepDateStr(cur, 1);
    if (isAShareTradeDay(cur)) return cur;
  }
  return cur;
}

/** 获取指定日期之前的上一个 A 股交易日 (YYYY-MM-DD) */
export function prevAShareTradeDate(input = new Date()) {
  let cur = getCNClock(input).dateStr;
  for (let i = 0; i < 45; i += 1) {
    cur = stepDateStr(cur, -1);
    if (isAShareTradeDay(cur)) return cur;
  }
  return cur;
}

/**
 * 获取完整的 A 股交易日与休市描述状态（含节假日名称与下一交易日）
 */
export function getAShareMarketStatus(input = new Date()) {
  const ck = getCNClock(input);
  const holidayName = HOLIDAY_MAP.get(ck.dateStr) || null;
  const isWeekend = ck.weekday === 0 || ck.weekday === 6;

  if (holidayName) {
    const label = holidayName.endsWith('休市') ? holidayName : `${holidayName}休市`;
    return {
      ...ck,
      isTradeDay: false,
      isWeekend,
      isHoliday: true,
      holidayName,
      label,
      nextTradeDate: nextAShareTradeDate(ck.dateStr),
      prevTradeDate: prevAShareTradeDate(ck.dateStr),
    };
  }

  if (isWeekend) {
    return {
      ...ck,
      isTradeDay: false,
      isWeekend: true,
      isHoliday: false,
      holidayName: null,
      label: '周末休市',
      nextTradeDate: nextAShareTradeDate(ck.dateStr),
      prevTradeDate: prevAShareTradeDate(ck.dateStr),
    };
  }

  return {
    ...ck,
    isTradeDay: true,
    isWeekend: false,
    isHoliday: false,
    holidayName: null,
    label: '交易日',
    nextTradeDate: nextAShareTradeDate(ck.dateStr),
    prevTradeDate: prevAShareTradeDate(ck.dateStr),
  };
}

/**
 * 判断当前是否处于 A 股盘中连续竞价交易时段（交易日北京时间 09:30-11:30, 13:00-15:00）
 */
export function isAShareTradingNow(now = new Date()) {
  const ck = getCNClock(now);
  if (!isAShareTradeDay(ck.dateStr)) return false;
  return (ck.mins >= 570 && ck.mins <= 690) || (ck.mins >= 780 && ck.mins <= 900);
}

/**
 * 提取包含 dateStr 的整段连续休市区间 [closureStart, closureEnd]，
 * 并判断其中是否包含法定节假日（合并紧邻的周六/周日连休，剔除普通双休周末）。
 */
function inspectClosureBlockAt(seedClosedDate) {
  let start = seedClosedDate;
  let end = seedClosedDate;
  for (let i = 0; i < 20; i += 1) {
    const prev = stepDateStr(start, -1);
    if (!isAShareTradeDay(prev)) start = prev;
    else break;
  }
  for (let i = 0; i < 20; i += 1) {
    const nxt = stepDateStr(end, 1);
    if (!isAShareTradeDay(nxt)) end = nxt;
    else break;
  }

  let holidayName = null;
  let cur = start;
  while (cur <= end) {
    if (HOLIDAY_MAP.has(cur) && !holidayName) {
      holidayName = String(HOLIDAY_MAP.get(cur)).replace(/休市$/, '');
    }
    cur = stepDateStr(cur, 1);
  }
  if (!holidayName) return null;

  const closedDays = diffCalendarDays(start, end) + 1;
  const reopenDate = stepDateStr(end, 1);
  const lastPreHolidayTradeDate = stepDateStr(start, -1);
  return {
    holidayName,
    closureStart: start,
    closureEnd: end,
    closedDays,
    reopenDate,
    lastPreHolidayTradeDate,
    isLongHoliday: closedDays >= 3,
  };
}

/**
 * 盘前准备面板专用：近期法定节假日休市倒计时与长假前仓位提醒计算
 *
 * 规则：
 * 1. 若当前正处于含法定节假日的连休区间内 -> 返回 phase: 'in_holiday'（提示休市区间与开市日）；
 * 2. 否则向前扫描最近的法定节假日连休块（排除普通周末）：
 *    - 统计 [today, closureStart) 之间剩余的真实交易日数 remainingTradeDays（含今日交易日）；
 *    - 仅当 remainingTradeDays <= lookaheadTradeDays（默认 5 个交易日）时返回倒计时提醒；
 *    - 当连续休市天数 closedDays >= 3 且 remainingTradeDays 为 1 或 2 时，标记 isHighAlert: true，
 *      高亮提示节前取现抛压、T+1 跨假锁仓及建议隔夜仓位上限。
 */
export function getUpcomingHolidayReminder(input = new Date(), options = {}) {
  const lookaheadTradeDays = Number(options.lookaheadTradeDays) > 0 ? Number(options.lookaheadTradeDays) : 5;
  const maxScanDays = Number(options.maxScanDays) > 0 ? Number(options.maxScanDays) : 40;
  const ck = getCNClock(input);
  const today = ck.dateStr;

  // 1. 当前日期本身非交易日时，先检查是否正处于法定节假日连休期内
  let scanCursor = today;
  if (!isAShareTradeDay(today)) {
    const curBlock = inspectClosureBlockAt(today);
    if (curBlock) {
      const remainingClosedDays = diffCalendarDays(today, curBlock.closureEnd) + 1;
      return {
        ...curBlock,
        today,
        phase: 'in_holiday',
        level: 'in_holiday',
        remainingTradeDays: 0,
        remainingClosedDays,
        isHighAlert: false,
        suggestedMaxPosPct: curBlock.closedDays >= 7 ? 30 : 50,
        chipText: `🏮 ${curBlock.holidayName}休市中（连休${curBlock.closedDays}天 · ${curBlock.reopenDate.slice(5)} 开市）`,
        headline: `${curBlock.holidayName}休市期（${curBlock.closureStart.slice(5)} ~ ${curBlock.closureEnd.slice(5)} 共 ${curBlock.closedDays} 天）`,
        advice: `A股将于 ${curBlock.reopenDate} 恢复交易，可趁休市复盘持仓筹码峰与节后竞价预案。`,
      };
    }
    // 普通周末：跳过当前周末后再向后扫描
    while (!isAShareTradeDay(scanCursor)) {
      scanCursor = stepDateStr(scanCursor, 1);
    }
  }

  // 2. 向后扫描最近的法定节假日连休区间
  let tradeDaysCount = 0;
  let cursor = scanCursor;
  for (let step = 0; step < maxScanDays; step += 1) {
    if (isAShareTradeDay(cursor)) {
      tradeDaysCount += 1;
      if (tradeDaysCount > lookaheadTradeDays) {
        return null;
      }
      cursor = stepDateStr(cursor, 1);
      continue;
    }

    const block = inspectClosureBlockAt(cursor);
    if (block) {
      const remainingTradeDays = tradeDaysCount;
      if (remainingTradeDays < 1 || remainingTradeDays > lookaheadTradeDays) {
        return null;
      }

      const isHighAlert = block.isLongHoliday && remainingTradeDays <= 2;
      const suggestedMaxPosPct = block.closedDays >= 7 ? 30 : 50;
      const posRangeLabel = block.closedDays >= 7 ? '≤3成' : '3~5成';

      let level = 'countdown';
      let chipText = `📅 距${block.holidayName}休市(${block.closedDays}天)剩 ${remainingTradeDays} 个交易日`;
      let headline = '';
      let advice = '';

      if (isHighAlert && remainingTradeDays === 1) {
        level = 'imminent_1d';
        chipText = `🏮 ${block.holidayName}前最后 1 个交易日（连休${block.closedDays}天 · 严控隔夜仓位）`;
        headline = `${block.holidayName}长假收官日预警 · 明起连休 ${block.closedDays} 天（${block.closureStart.slice(5)} ~ ${block.closureEnd.slice(5)}，${block.reopenDate.slice(5)} 开市）`;
        advice = `今日新买入筹码受 T+1 限制将锁定跨越整个 ${block.closedDays} 天假期至 ${block.reopenDate.slice(5)} 才能卖出；建议将隔夜总仓位控制在 ${posRangeLabel}，日内优先逢冲高倒T锁利降仓，切忌尾盘重仓赌节后消息。`;
      } else if (isHighAlert && remainingTradeDays === 2) {
        level = 'imminent_2d';
        chipText = `🏮 距${block.holidayName}长假(${block.closedDays}天)仅剩 2 个交易日 · 节前取现控仓窗`;
        headline = `距${block.holidayName}连续 ${block.closedDays} 天长假仅剩 2 个交易日（${block.closureStart.slice(5)} ~ ${block.closureEnd.slice(5)} 休市，${block.reopenDate.slice(5)} 开市）`;
        advice = `今日为节前资金取现最后卖出窗口，午后易出现避险兑现抛压；建议提前去弱留强、将隔夜仓位收敛至 ${posRangeLabel}，严控追高新开仓以规避跨假外围不确定性。`;
      } else {
        headline = `距${block.holidayName}休市还有 ${remainingTradeDays} 个交易日（${block.closureStart.slice(5)} ~ ${block.closureEnd.slice(5)} 休市 ${block.closedDays} 天）`;
        advice = block.isLongHoliday
          ? `长假临近（${block.reopenDate.slice(5)} 开市），可提前规划持仓做T降本与节前减仓节奏。`
          : `单日休市（${block.reopenDate.slice(5)} 恢复开市），留意节前一日下午流动性微幅收敛。`;
      }

      return {
        ...block,
        today,
        phase: isHighAlert ? 'pre_holiday_urgent' : 'pre_holiday_countdown',
        level,
        remainingTradeDays,
        remainingClosedDays: block.closedDays,
        isHighAlert,
        suggestedMaxPosPct,
        posRangeLabel,
        chipText,
        headline,
        advice,
      };
    }

    // 普通双休周末：一次性跨过该周末继续扫描
    while (!isAShareTradeDay(cursor)) {
      cursor = stepDateStr(cursor, 1);
    }
  }

  return null;
}

const CN_WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 交易时钟弹窗（TradingClockModal）专用：生成北京时间实时交易日/法定节假日状态、前后交易日与当前激活分时窗口快照
 */
export function getTradingClockSnapshot(input = new Date()) {
  const st = getAShareMarketStatus(input);
  const holidayReminder = getUpcomingHolidayReminder(input);
  const weekdayLabel = CN_WEEKDAY_NAMES[st.weekday] || '';

  let activeSlotId = null;
  let sessionBadge = '';
  if (!st.isTradeDay) {
    sessionBadge = st.isHoliday ? `🏮 ${st.label}` : '🛋️ 周末休市';
  } else {
    const m = st.mins;
    if (m < 555) {
      activeSlotId = 'pre_open';
      sessionBadge = '🌅 盘前准备期 (09:15 前)';
    } else if (m < 565) {
      activeSlotId = 'auction_call';
      sessionBadge = '📡 集合竞价期 (09:15-09:25)';
    } else if (m < 570) {
      activeSlotId = 'auction_fix';
      sessionBadge = '⚖️ 竞价定盘期 (09:25-09:30)';
    } else if (m < 585) {
      activeSlotId = 'open_frenzy';
      sessionBadge = '⚠️ 情绪宣泄诱多期 (09:30-09:45)';
    } else if (m < 630) {
      activeSlotId = 'golden_t';
      sessionBadge = '🎯 做T黄金主窗口 (09:45-10:30)';
    } else if (m < 690) {
      activeSlotId = 'mid_consolidate';
      sessionBadge = '🛡️ 震荡巩固期 (10:30-11:30)';
    } else if (m < 780) {
      activeSlotId = 'lunch_break';
      sessionBadge = '☕ 午间休市 (11:30-13:00)';
    } else if (m < 840) {
      activeSlotId = 'dull_hour';
      sessionBadge = '💤 缩量垃圾时间 (13:00-14:00)';
    } else if (m < 870) {
      activeSlotId = 'inflection_warn';
      sessionBadge = '⚡ 变盘预警期 (14:00-14:30)';
    } else if (m < 895) {
      activeSlotId = 'force_close_t';
      sessionBadge = '🚨 T仓强制平仓期 (14:30-14:55)';
    } else if (m <= 900) {
      activeSlotId = 'close_auction';
      sessionBadge = '🔔 尾盘集合竞价 (14:55-15:00)';
    } else {
      activeSlotId = 'post_eod';
      sessionBadge = '🏁 已收盘 · 15:05 复盘归档窗';
    }
  }

  return {
    ...st,
    weekdayLabel,
    activeSlotId,
    sessionBadge,
    holidayReminder,
    isPreHolidayUrgent: Boolean(holidayReminder?.isHighAlert),
    isInHoliday: holidayReminder?.phase === 'in_holiday',
  };
}

