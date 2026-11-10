/* ============================================================
   A股做T执行台 · 核心常量与通用工具 (src/services/utils.js)
   ============================================================ */

export const GRID = 4 / 3;              // 每格 1.333%，3格=4%，6格=8%
export const STOP = 0.015;            // T仓硬止损 1.5%
export const FLY  = 0.015;            // 倒T卖飞线 1.5%
export const FEE  = 0.0011;           // 往返摩擦成本：佣金万2.5双边 + 印花税千0.5(卖出) + 过户费
export const STALE_MIN = 3;           // 超过 3 分钟未刷新转黄警报

export const VAL_WIN = [['pb','市净率 PB'], ['peTTM','滚动市盈 PE(TTM)'], ['peLyr','静态市盈 PE(静)'], ['psTTM','市销率 PS']];
export const TIER_LABEL = { short:'⚡ 短线机动', long:'🛡️ 底仓做T' };

export const AUTO_FIELDS = ['prevClose','open','high','low','price','avg','vr','ma5','ma10','ma20'];
export const AUTO_FIELD_LABELS = {
  prevClose: '昨收',
  open: '今开',
  high: '最高',
  low: '最低',
  price: '现价',
  avg: '分时均价',
  vr: '量比',
  ma5: 'MA5',
  ma10: 'MA10',
  ma20: 'MA20'
};

export const LCOLS = [
  ['date','日期','text'],['stock','股票','text'],['dir','方向','select',['正T','倒T','尾盘买入','尾盘平仓']],
  ['buy','买入价','num'],['sell','卖出价','num'],['qty','股数','num'],
  ['plan','决策','select',['计划内','临时起意']],
  ['basis','依据','select',['客观信号','我觉得','消息面']],
  ['note','备注','text']
];

export const LS_KEYS = [
  't-system-pool', 't-system-log', 't-system-snap', 't-system-red',
  't-system-checkup', 't-account-total', 't-system-alerts',
  't-system-alertopt', 't-system-tier', 't-tail-buy-active', 't-active-tab'
];

/* 默认演示自选池 */
export const DEFAULT = [
  { name:'上海沿浦', code:'605128', tcode:'sh605128', prevClose:23.17, open:23.10, high:23.49, low:22.40,
    price:22.63, avg:22.90, vr:1.41, ma5:23.00, ma10:23.86, ma20:23.96, shares:0, cost:0, cap:0 },
  { name:'上海九百', code:'600838', tcode:'sh600838', prevClose:7.70, open:7.70, high:7.84, low:7.56,
    price:7.81, avg:7.73, vr:0.49, ma5:7.90, ma10:8.32, ma20:8.26, shares:0, cost:0, cap:0 }
];

/* 格式化工具 */
export const f2 = n => (n == null || Number.isNaN(+n)) ? '0.00' : (Math.round(+n * 100) / 100).toFixed(2);
export const f3 = n => (n == null || Number.isNaN(+n)) ? '0.000' : (Math.round(+n * 1000) / 1000).toFixed(3);
export const pct = n => (n == null || Number.isNaN(+n)) ? '0.00%' : ((+n >= 0 ? '+' : '') + (+n).toFixed(2) + '%');
export const money = n => (n == null || Number.isNaN(+n)) ? '0' : ((+n >= 0 ? '+' : '') + Math.round(+n).toLocaleString('zh-CN'));
export const money2 = n => (n == null || Number.isNaN(+n)) ? '0' : ((+n >= 0 ? '+' : '−') + Math.abs(Math.round(+n)).toLocaleString('zh-CN'));
export const money$ = n => {
  const v = Math.abs(n || 0);
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return Math.round(v).toLocaleString('zh-CN');
};
export const fmtIn = v => (v === '' || v == null || Number.isNaN(+v)) ? '' : String(+(+v).toFixed(3));
export const fvol = v => {
  if (v == null || Number.isNaN(+v)) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿股';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万股';
  return Math.round(v) + '股';
};

export const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/* Toast 提示事件分发 */
let _toastListener = null;
export function setToastListener(fn) {
  _toastListener = fn;
}

export function toast(msg, kind = 'info', ms) {
  if (_toastListener) {
    _toastListener({ id: Date.now() + Math.random(), msg, kind, ms });
    return;
  }
  const host = document.getElementById('toastHost');
  if (!host) {
    if (kind === 'err') alert(msg);
    else console.log('[Toast]', kind, msg);
    return;
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = '<span class="ti"></span><span class="tx"></span><button class="tc" title="关闭">×</button>';
  const ti = el.querySelector('.ti');
  if (ti) ti.textContent = kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'warn' ? '⚠' : 'i';
  const tx = el.querySelector('.tx');
  if (tx) tx.textContent = String(msg);
  const kill = () => el.remove();
  const tc = el.querySelector('.tc');
  if (tc) tc.onclick = kill;
  host.appendChild(el);
  setTimeout(kill, ms === undefined ? (kind === 'err' ? 7000 : 3600) : ms);
  return el;
}
export const toastOk   = m => toast(m, 'ok');
export const toastErr  = m => toast(m, 'err', 7000);
export const toastWarn = m => toast(m, 'warn', 5200);

/* 音效提示 */
let audioCtx = null;
export function warmAudio() {
  if (!audioCtx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (_) {}
  }
}
export function soundChime(freq = 660, dur = 0.18) {
  try {
    const raw = localStorage.getItem('t-alert-enabled');
    if (raw !== null && JSON.parse(raw) === false) return; // 上班免打扰静音
  } catch (_) {}
  if (!audioCtx) warmAudio();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (_) {}
}

/* 复制文本到剪贴板 */
export function copyPlain(text, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      toastOk(okMsg || '内容已复制到剪贴板');
    }).catch(() => fallbackCopy(text, okMsg));
  } else {
    fallbackCopy(text, okMsg);
  }
}
function fallbackCopy(text, okMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toastOk(okMsg || '内容已复制到剪贴板');
  } catch (_) {
    toastErr('复制失败，请手动选取复制');
  }
  document.body.removeChild(ta);
}

/* ============================================================
   做T保本价计算器与日内未平仓计算核心算法
   ============================================================ */

/**
 * 精确测算做T保本价、规费损耗与所需价差空间
 */
export function calcTBreakeven({
  mode = 'BUY',
  entryPx = 10,
  qty = 1000,
  commRate = 0.00025,
  hasMin5 = true,
  stampTax = 0.0005,
  transferRate = 0.00001,
  slippageTicks = 0
}) {
  const p = Math.max(0.01, +entryPx || 0);
  const q = Math.max(1, parseInt(qty, 10) || 100);
  const slip = (slippageTicks || 0) * 0.01;

  if (mode === 'BUY') {
    // 正T: 先买后卖
    const actualBuyPx = p + slip;
    const buyAmt = actualBuyPx * q;
    const buyComm = hasMin5 ? Math.max(5, buyAmt * commRate) : buyAmt * commRate;
    const buyTrans = buyAmt * transferRate;
    const totalBuyCost = buyAmt + buyComm + buyTrans;

    let s = actualBuyPx;
    let sBe = actualBuyPx;
    let feeBuy = buyComm + buyTrans;
    let feeSell = 0;

    for (let step = 0; step < 5000; step++) {
      const sAmt = (s - slip) * q;
      const sComm = hasMin5 ? Math.max(5, sAmt * commRate) : sAmt * commRate;
      const sTax = sAmt * stampTax;
      const sTrans = sAmt * transferRate;
      const netSell = sAmt - sComm - sTax - sTrans;
      if (netSell >= totalBuyCost) {
        sBe = Math.round(s * 100) / 100;
        feeSell = sComm + sTax + sTrans;
        break;
      }
      s += 0.005;
    }

    const spread = Math.round((sBe - p) * 100) / 100;
    const pctDiff = p > 0 ? (spread / p) * 100 : 0;
    const tickValue = Math.round(q * 0.01 * 100) / 100;
    const totalFee = Math.round((feeBuy + feeSell) * 100) / 100;

    return {
      mode: 'BUY',
      entryPx: p,
      targetPx: sBe,
      spread,
      pctDiff,
      totalFee,
      feeBuy: Math.round(feeBuy * 100) / 100,
      feeSell: Math.round(feeSell * 100) / 100,
      tickValue,
      buyCost: Math.round(totalBuyCost * 100) / 100
    };
  } else {
    // 倒T: 先卖后买
    const actualSellPx = Math.max(0.01, p - slip);
    const sellAmt = actualSellPx * q;
    const sellComm = hasMin5 ? Math.max(5, sellAmt * commRate) : sellAmt * commRate;
    const sellTax = sellAmt * stampTax;
    const sellTrans = sellAmt * transferRate;
    const feeSell = sellComm + sellTax + sellTrans;
    const netCashIn = sellAmt - feeSell;

    let b = actualSellPx;
    let bBe = actualSellPx;
    let feeBuy = 0;

    for (let step = 0; step < 5000; step++) {
      const bAmt = (b + slip) * q;
      const bComm = hasMin5 ? Math.max(5, bAmt * commRate) : bAmt * commRate;
      const bTrans = bAmt * transferRate;
      const totalBuyOut = bAmt + bComm + bTrans;
      if (totalBuyOut <= netCashIn) {
        bBe = Math.round(b * 100) / 100;
        feeBuy = bComm + bTrans;
        break;
      }
      b -= 0.005;
      if (b <= 0.01) break;
    }

    const spread = Math.round((p - bBe) * 100) / 100;
    const pctDiff = p > 0 ? (spread / p) * 100 : 0;
    const tickValue = Math.round(q * 0.01 * 100) / 100;
    const totalFee = Math.round((feeSell + feeBuy) * 100) / 100;

    return {
      mode: 'REV',
      entryPx: p,
      targetPx: bBe,
      spread,
      pctDiff,
      totalFee,
      feeBuy: Math.round(feeBuy * 100) / 100,
      feeSell: Math.round(feeSell * 100) / 100,
      tickValue,
      sellNetCash: Math.round(netCashIn * 100) / 100
    };
  }
}

/**
 * 统计某只股票今日做T、T+1锁仓、可用底仓及未平仓状态（严格遵守 A 股 T+1 制度）
 */
export function getTodayTStatus(stock, tradeLogs) {
  if (!stock) {
    return {
      logs: [],
      boughtQty: 0,
      initBoughtQty: 0,
      addBoughtQty: 0,
      soldQty: 0,
      closedTCount: 0,
      prevBaseShares: 0,
      sellableShares: 0,
      t1LockedShares: 0,
      unclosedShares: 0,
      hasUnclosed: false,
      isFirstDayLocked: false,
      isIgnoredToday: false
    };
  }
  const today = todayStr();
  const codeStr = String(stock.code || '');
  const nameStr = String(stock.name || '');

  const logs = (tradeLogs || []).filter(l => {
    if (l.date !== today) return false;
    const st = String(l.stock || '');
    return (codeStr && st.includes(codeStr)) || (nameStr && st.includes(nameStr));
  });

  let initBoughtQty = 0;   // 今日首日建仓（买入建仓，当日全部 T+1 锁定不可卖）
  let addBoughtQty = 0;    // 今日加仓或日内开T买入
  let tOpenBoughtQty = 0;  // 明确计入日内待平衡平T口径的新增买入（不含首日建仓、不含尾盘潜伏买入）
  let soldQty = 0;         // 今日已卖出的昨持底仓股数
  let closedTCount = 0;    // 今日已成对闭环的做T笔数

  logs.forEach(l => {
    const d = String(l.dir || '');
    const q = parseInt(l.qty, 10) || 0;
    if (d === '买入建仓') {
      initBoughtQty += q;
    } else if (d === '尾盘买入') {
      addBoughtQty += q;
    } else if (d === '买入加仓' || d === '直接买入' || d === '正T买入' || d === '正T开仓') {
      addBoughtQty += q;
      tOpenBoughtQty += q;
    } else if (d === '直接卖出' || d === '清仓卖出' || d === '正T卖出' || d === '正T平仓') {
      soldQty += q;
    } else if (d === '正T' || d === '倒T') {
      closedTCount += 1;
    }
  });

  const boughtQty = initBoughtQty + addBoughtQty;
  const curShares = parseInt(stock.shares, 10) || 0;

  // 推算昨持底仓 = 当前持仓 - 今日买入增量 + 今日已卖出
  const prevBaseShares = Math.max(0, curShares - boughtQty + soldQty);

  // A股 T+1 制度：今日真实可用可卖股数 = max(0, 昨持底仓 - 今日已卖)
  const sellableShares = Math.max(0, prevBaseShares - soldQty);
  const t1LockedShares = Math.min(curShares, boughtQty);

  // 首日买股（或全部筹码均为今日买入）：今日可卖为 0，T+1 锁仓冻结中，根本无法当日卖出或尾盘清T！
  const isFirstDayLocked = curShares > 0 && sellableShares === 0;
  const isIgnoredToday = stock.ignoreTailTDate === today;

  // 仅当昨日有可用底仓（sellableShares > 0）时，才存在 14:40 尾盘平T卖出老底仓的前提
  const manualUnclosed = parseInt(stock.unclosedTQty, 10) || 0;
  const rawUnclosedFromLogs = Math.max(0, tOpenBoughtQty - soldQty);
  const candidateUnclosed = isIgnoredToday ? manualUnclosed : Math.max(rawUnclosedFromLogs, manualUnclosed);

  // 强制受今日可卖余额 sellableShares 约束：卖不了的股绝不误报！
  const unclosedShares = sellableShares > 0 ? Math.min(candidateUnclosed, sellableShares) : 0;

  return {
    logs,
    boughtQty,
    initBoughtQty,
    addBoughtQty,
    soldQty,
    closedTCount,
    prevBaseShares,
    sellableShares,
    t1LockedShares,
    unclosedShares,
    hasUnclosed: unclosedShares > 0,
    isFirstDayLocked,
    isIgnoredToday
  };
}

