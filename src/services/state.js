/* ============================================================
   A股做T执行台 · 响应式状态管理中枢 (state.js)
   ============================================================ */

import { DEFAULT, TIER_LABEL, toastWarn } from './utils.js';

/* 1. 自选股池与持仓 */
export let pool = JSON.parse(JSON.stringify(DEFAULT));
try {
  const raw = localStorage.getItem('t-system-pool');
  if (raw) pool = JSON.parse(raw);
} catch (_) {}

/* 字段补齐规范化 */
pool.forEach(s => {
  if (s.cost === undefined) s.cost = 0;
  if (s.cap  === undefined) s.cap  = 0;
  if (s.shares === undefined) s.shares = 0;
  if (!s.p)   s.p   = 'day';
  if (!s.ov)  s.ov  = { ma:1, boll:1, box:1, cost:1, sr:0 };
  if (!s.sub) s.sub = 'macd';
  if (!s.tier) s.tier = tierOf(s);
});

export function savePool() {
  try {
    const slim = pool.map(s => {
      const o = {};
      Object.keys(s).forEach(k => { if (k.charAt(0) !== '_') o[k] = s[k]; });
      return o;
    });
    localStorage.setItem('t-system-pool', JSON.stringify(slim));
  } catch (_) {}
}

/* 2. 当前选中单票与池别过滤 */
export let CUR = null;
export function setCur(idx) { CUR = idx; }

export function tierOf(s) {
  if (s && (s.tier === 'short' || s.tier === 'long')) return s.tier;
  if (s && s.poolTag === '短线') return 'short';
  if (s && s.poolTag === '稳健') return 'long';
  return 'short';
}

export let TIER = 'all';
try {
  const t0 = localStorage.getItem('t-system-tier');
  if (t0 === 'short' || t0 === 'long') TIER = t0;
} catch (_) {}

export function paintTierBar() {
  const n = { all: pool.length, short: 0, long: 0 };
  pool.forEach(s => { n[tierOf(s)]++; });
  ['all','short','long'].forEach(k => {
    const el = document.getElementById('tierN-' + k);
    if (el) el.textContent = n[k];
  });
  const bar = document.getElementById('tierBar');
  if (bar) bar.querySelectorAll('.tier-btn').forEach(b => b.classList.toggle('cur', b.dataset.tier === TIER));
  document.body.dataset.tier = TIER;
}

export function setTier(t, onTierChange) {
  TIER = (t === 'short' || t === 'long') ? t : 'all';
  try { localStorage.setItem('t-system-tier', TIER); } catch (_) {}
  document.body.dataset.tier = TIER;
  paintTierBar();
  if (typeof onTierChange === 'function') onTierChange(TIER);
}

/* 3. 执行台账 */
export let LOG = [];
try {
  const raw = localStorage.getItem('t-system-log');
  if (raw) LOG = JSON.parse(raw);
} catch (_) {}

export function saveLog() {
  try { localStorage.setItem('t-system-log', JSON.stringify(LOG)); } catch (_) {}
}

/* 4. 每日收盘快照 */
export let SNAP = [];
try {
  const raw = localStorage.getItem('t-system-snap');
  if (raw) SNAP = JSON.parse(raw);
} catch (_) {}

export function saveSnap() {
  try { localStorage.setItem('t-system-snap', JSON.stringify(SNAP)); } catch (_) {}
}

/* 5. 尾盘潜伏多标的活跃状态 */
export let TAIL_ACTIVES = [];
try {
  const raw = localStorage.getItem('t-tail-buy-active');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) TAIL_ACTIVES = parsed;
    else if (parsed && typeof parsed === 'object') TAIL_ACTIVES = [parsed];
  }
} catch (_) {}

export function saveTailActive() {
  try {
    const activeOnly = TAIL_ACTIVES.filter(x => x && x.status === 'active');
    if (activeOnly.length > 0) {
      localStorage.setItem('t-tail-buy-active', JSON.stringify(activeOnly));
    } else {
      localStorage.removeItem('t-tail-buy-active');
    }
  } catch (_) {}
}

/* 6. 价格提醒中心 */
export let ALERT_CENTER = {};
try {
  const raw = localStorage.getItem('t-system-alerts');
  if (raw) ALERT_CENTER = JSON.parse(raw);
} catch (_) {}

export function saveAlerts() {
  try { localStorage.setItem('t-system-alerts', JSON.stringify(ALERT_CENTER)); } catch (_) {}
}

/* 7. 账户总资产与现金模型 */
export function getAccountTotalAssets() {
  try {
    const raw = localStorage.getItem('t-account-total');
    if (raw) {
      const v = parseFloat(raw);
      if (v > 0) return v;
    }
  } catch (_) {}
  // 兜底：从 pool 计算持仓市值 + 可用现金
  let mkt = 0, cap = 0;
  pool.forEach(s => {
    const px = +s.price || +s.prevClose || 0;
    mkt += (s.shares || 0) * px;
    cap += (s.cap || 0);
  });
  return (mkt + cap) > 0 ? (mkt + cap) : 100000;
}

export function setAccountTotalAssets(val) {
  try {
    if (val > 0) localStorage.setItem('t-account-total', String(val));
    else localStorage.removeItem('t-account-total');
  } catch (_) {}
}

/* 8. 行情刷新时间戳 */
export let STAMP = 0;
export function stampData() { STAMP = Date.now(); }
