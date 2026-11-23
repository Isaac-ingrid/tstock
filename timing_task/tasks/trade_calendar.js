/**
 * timing_task/tasks/trade_calendar.js
 *
 * A股交易日历与开休市双重守卫（参考 InStock trade_time 机制）：
 *   1. 静态权威日历：内置沪深北交易所 2024-2026 法定节假日休市表 + 读取 data/trade_calendar.json
 *      （A股周六、周日恒休市，即使遇国务院调休补班日亦休市）
 *   2. 跨年/临时休市动态自学习：盘中调度触发前可通过上证指数 (sh000001) 实时行情日期核验，
 *      若遇未配置的新年份法定节假日（如 2027+ 元旦/春节），自动识别休市并持久化写入 learnedClosedDates
 *   3. 固定北京时间 (Asia/Shanghai, UTC+8) 归一计算，不受服务器/容器本地时区影响
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const TASKS_DIR = __dirname;
const PROJECT_ROOT = path.resolve(TASKS_DIR, '..', '..');
const CALENDAR_FILE = path.join(PROJECT_ROOT, 'data', 'trade_calendar.json');
const PUBLIC_CALENDAR_FILE = path.join(PROJECT_ROOT, 'public', 'data', 'trade_calendar.json');

const CN_OFFSET_MS = 8 * 3600 * 1000;

// 内置兜底法定节假日区间（与 data/trade_calendar.json 同源，防止文件缺失时退化）
const BUILTIN_HOLIDAY_RANGES = [
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

let _cachedMap = null;
let _cachedMtime = -1;

function expandRangesToMap(ranges, learned = {}) {
  const map = new Map();
  for (const r of ranges || []) {
    if (!r || !r.start || !r.end) continue;
    const cur = new Date(`${r.start}T00:00:00Z`);
    const end = new Date(`${r.end}T00:00:00Z`);
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) continue;
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      map.set(ds, r.name || '节假日');
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  if (learned && typeof learned === 'object') {
    for (const [ds, label] of Object.entries(learned)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(ds) && label) {
        map.set(ds, String(label));
      }
    }
  }
  return map;
}

function getHolidayMap() {
  try {
    if (fs.existsSync(CALENDAR_FILE)) {
      const st = fs.statSync(CALENDAR_FILE);
      if (_cachedMap && st.mtimeMs === _cachedMtime) {
        return _cachedMap;
      }
      const raw = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
      const mergedRanges = [...BUILTIN_HOLIDAY_RANGES, ...(raw.holidayRanges || [])];
      _cachedMap = expandRangesToMap(mergedRanges, raw.learnedClosedDates || {});
      _cachedMtime = st.mtimeMs;
      return _cachedMap;
    }
  } catch (_) {}
  if (!_cachedMap) {
    _cachedMap = expandRangesToMap(BUILTIN_HOLIDAY_RANGES, {});
  }
  return _cachedMap;
}

/**
 * 将 Date 对象或 YYYY-MM-DD 字符串统一解析为北京时间 (UTC+8) 日历与分钟分量
 */
function getCNClock(input = new Date()) {
  if (typeof input === 'string') {
    const clean = input.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      const dt = new Date(`${clean}T12:00:00+08:00`);
      const shifted = new Date(dt.getTime() + CN_OFFSET_MS);
      return {
        dateStr: clean,
        ymd: clean.replace(/-/g, ''),
        year: shifted.getUTCFullYear(),
        weekday: shifted.getUTCDay(),
        hour: 12,
        minute: 0,
        second: 0,
        mins: 720,
        hhmm: 1200,
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
  const dateStr = `${y}-${m}-${day}`;
  return {
    dateStr,
    ymd: `${y}${m}${day}`,
    year: y,
    weekday: shifted.getUTCDay(),
    hour: hh,
    minute: mm,
    second: ss,
    mins: hh * 60 + mm,
    hhmm: hh * 100 + mm,
    timeStr: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
  };
}

function stepDateStr(dateStr, deltaDays) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * 查询某天是否为 A 股交易日及休市原因
 */
function getTradeDayStatus(input = new Date()) {
  const ck = getCNClock(input);
  const holidayMap = getHolidayMap();
  const holidayName = holidayMap.get(ck.dateStr) || null;
  const isWeekendDay = ck.weekday === 0 || ck.weekday === 6;

  if (holidayName) {
    const cleanLabel = holidayName.endsWith('休市') ? holidayName : `${holidayName}休市`;
    return {
      dateStr: ck.dateStr,
      weekday: ck.weekday,
      isTradeDay: false,
      isWeekend: isWeekendDay,
      isHoliday: true,
      holidayName,
      label: cleanLabel,
    };
  }
  if (isWeekendDay) {
    return {
      dateStr: ck.dateStr,
      weekday: ck.weekday,
      isTradeDay: false,
      isWeekend: true,
      isHoliday: false,
      holidayName: null,
      label: '周末休市',
    };
  }
  return {
    dateStr: ck.dateStr,
    weekday: ck.weekday,
    isTradeDay: true,
    isWeekend: false,
    isHoliday: false,
    holidayName: null,
    label: '交易日',
  };
}

function isTradeDay(input = new Date()) {
  return getTradeDayStatus(input).isTradeDay;
}

/** 获取指定日期之后的下一个 A 股交易日 (YYYY-MM-DD) */
function nextTradeDay(input = new Date()) {
  let cur = getCNClock(input).dateStr;
  for (let i = 0; i < 40; i += 1) {
    cur = stepDateStr(cur, 1);
    if (isTradeDay(cur)) return cur;
  }
  return cur;
}

/** 获取指定日期之前的上一个 A 股交易日 (YYYY-MM-DD) */
function prevTradeDay(input = new Date()) {
  let cur = getCNClock(input).dateStr;
  for (let i = 0; i < 40; i += 1) {
    cur = stepDateStr(cur, -1);
    if (isTradeDay(cur)) return cur;
  }
  return cur;
}

/**
 * 判断某天是否为本周最后一个 A 股交易日（自动兼容周五休市时提前到周四/周三收官的场景）
 */
function isLastTradeDayOfWeek(input = new Date()) {
  const cur = getCNClock(input).dateStr;
  if (!isTradeDay(cur)) return false;
  const nxt = nextTradeDay(cur);
  const diffDays = Math.round((new Date(`${nxt}T00:00:00Z`) - new Date(`${cur}T00:00:00Z`)) / 86400000);
  return diffDays >= 3;
}

/**
 * 将动态探测到的休市日持久化到 data/trade_calendar.json 与 public/data/trade_calendar.json
 */
function recordLearnedClosedDate(dateStr, reason = '节假日休市') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
  try {
    let data = {
      timezone: 'Asia/Shanghai',
      verifiedYears: [2024, 2025, 2026],
      holidayRanges: BUILTIN_HOLIDAY_RANGES,
      learnedClosedDates: {},
    };
    if (fs.existsSync(CALENDAR_FILE)) {
      data = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    }
    data.learnedClosedDates = data.learnedClosedDates || {};
    if (data.learnedClosedDates[dateStr] === reason) return;
    data.learnedClosedDates[dateStr] = reason;
    const jsonText = JSON.stringify(data, null, 2) + '\n';
    fs.mkdirSync(path.dirname(CALENDAR_FILE), { recursive: true });
    fs.writeFileSync(CALENDAR_FILE, jsonText, 'utf8');
    if (fs.existsSync(path.dirname(PUBLIC_CALENDAR_FILE))) {
      fs.writeFileSync(PUBLIC_CALENDAR_FILE, jsonText, 'utf8');
    }
    _cachedMtime = -1;
  } catch (_) {}
}

function fetchHttpsText(url, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://gu.qq.com/',
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * 盘中实时交易所开盘日期核验（09:25 集合竞价定盘后调用）：
 * 读取上证指数 sh000001 行情时间戳，若接口正常返回但行情日期仍停留在历史交易日，
 * 说明当日为未预置的法定节假日或临时休市日，自动拦截空跑并写入本地日历缓存。
 */
async function probeLiveExchangeTradeDay(expectedDateStr) {
  const target = expectedDateStr || getCNClock().dateStr;
  try {
    const txt = await fetchHttpsText('https://qt.gtimg.cn/q=sh000001', 3500);
    const parts = String(txt || '').split('~');
    const rawTs = (parts[30] || '').trim();
    if (/^\d{8}/.test(rawTs)) {
      const qDate = `${rawTs.slice(0, 4)}-${rawTs.slice(4, 6)}-${rawTs.slice(6, 8)}`;
      if (qDate === target) {
        return { open: true, verified: true, quoteDate: qDate };
      }
      if (qDate < target) {
        recordLearnedClosedDate(target, '法定节假日休市');
        return {
          open: false,
          verified: true,
          quoteDate: qDate,
          reason: `上证指数最新交易日仍为 ${qDate}（今日 ${target} 休市）`,
        };
      }
    }
  } catch (_) {}
  return { open: true, verified: false, quoteDate: null };
}

module.exports = {
  CALENDAR_FILE,
  BUILTIN_HOLIDAY_RANGES,
  getCNClock,
  getTradeDayStatus,
  isTradeDay,
  nextTradeDay,
  prevTradeDay,
  isLastTradeDayOfWeek,
  recordLearnedClosedDate,
  probeLiveExchangeTradeDay,
};
