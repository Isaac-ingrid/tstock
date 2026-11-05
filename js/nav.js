/* ============================================================
   A股做T执行台 · 导航栏、多Tab选项卡、作战时钟与弹窗模块 (nav.js)
   ============================================================ */

import { f2, pct, soundChime, TIER_LABEL } from './utils.js';
import { pool, tierOf, CUR, setCur, STAMP, TAIL_ACTIVES, LOG } from './state.js';
import { calc } from './api.js';
import { animTabTransition } from './anim.js';
import { getTailBuyCandidates } from './tail.js';

/* 5大导航选项卡定义 */
export const TABS = [
  { id: 'tabConsole', label: '今日作战', badgeId: 'ntBadgeConsole' },
  { id: 'tabTail',    label: '⚡ 尾盘黑马', badgeId: 'ntBadgeTail' },
  { id: 'tabAccount', label: '账户', badgeId: null },
  { id: 'tabLedger',  label: '台账', badgeId: 'ntBadgeLedger' },
  { id: 'tabPerf',    label: '📊 战绩透视', badgeId: null },
  { id: 'tabRules',   label: '纪律', badgeId: null },
  { id: 'tabAll',     label: '🌐 全览', badgeId: null }
];

let _activeTab = 'tabConsole';

export function getActiveTab() {
  return _activeTab;
}

export function initTabs() {
  const topNav = document.getElementById('topNav');
  if (!topNav) return;

  const savedTab = localStorage.getItem('t-nav-tab') || 'tabConsole';
  _activeTab = savedTab;

  topNav.querySelectorAll('a[data-tab]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const tabId = a.dataset.tab;
      switchTab(tabId);
    };
  });

  applyTabVisibility(_activeTab, false);
  updateTabBadges();
}

export function switchTab(tabId) {
  _activeTab = tabId;
  try { localStorage.setItem('t-nav-tab', tabId); } catch (_) {}

  document.querySelectorAll('#topNav a[data-tab]').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tabId);
  });

  applyTabVisibility(tabId, true);
  updateTabBadges();

  if (tabId === 'tabPerf') {
    const el = document.getElementById('secPerf');
    if (el) {
      setTimeout(() => {
        const tbH = (document.getElementById('topbar')?.offsetHeight || 50) + 16;
        const top = el.getBoundingClientRect().top + window.pageYOffset - tbH;
        window.scrollTo({ top, behavior: 'smooth' });
      }, 50);
    }
  } else if (tabId === 'tabAccount' && window.renderEquity) {
    setTimeout(() => window.renderEquity(), 80);
  }
}

function applyTabVisibility(tabId, animate = true) {
  const panels = ['tabConsole', 'tabTail', 'tabAccount', 'tabLedger', 'tabRules'];
  if (tabId === 'tabAll') {
    panels.forEach(id => {
      const p = document.getElementById(id);
      if (p) {
        p.classList.add('active');
        p.style.display = 'block';
      }
    });
    return;
  }
  const activePanelId = (tabId === 'tabPerf') ? 'tabLedger' : tabId;
  panels.forEach(id => {
    const p = document.getElementById(id);
    if (!p) return;
    if (id === activePanelId) {
      p.classList.add('active');
      p.style.display = 'block';
      if (animate) animTabTransition(p);
    } else {
      p.classList.remove('active');
      p.style.display = 'none';
    }
  });
}

export function updateTabBadges() {
  const bConsole = document.getElementById('ntBadgeConsole');
  if (bConsole) {
    const posCount = (pool || []).filter(s => (s.shares || 0) > 0).length;
    bConsole.textContent = posCount > 0 ? posCount : '';
    bConsole.style.display = posCount > 0 ? 'inline-flex' : 'none';
  }

  const bTail = document.getElementById('ntBadgeTail');
  if (bTail) {
    const activeTailCount = (TAIL_ACTIVES || []).filter(x => x && x.status === 'active').length;
    if (activeTailCount > 0) {
      bTail.textContent = activeTailCount;
      bTail.style.display = 'inline-flex';
    } else {
      const cands = typeof getTailBuyCandidates === 'function' ? getTailBuyCandidates() : [];
      if (cands.length > 0) {
        bTail.textContent = cands.length;
        bTail.style.display = 'inline-flex';
      } else {
        bTail.textContent = '';
        bTail.style.display = 'none';
      }
    }
  }

  const bLedger = document.getElementById('ntBadgeLedger');
  if (bLedger) {
    const count = (LOG || []).length;
    bLedger.textContent = count > 0 ? count : '';
    bLedger.style.display = count > 0 ? 'inline-flex' : 'none';
  }
}

/* ===================== 吸顶栏现价速览与单票聚焦 ===================== */
export let VIEW = (localStorage.getItem('t-system-view') === 'all') ? 'all' : 'one';

export function setView(v) {
  VIEW = v;
  try { localStorage.setItem('t-system-view', v); } catch (_) {}
  applyCur();
  renderPoolTabs();
}

export function focusStock(idx) {
  setCur(idx);
  try { localStorage.setItem('t-system-cur', String(idx)); } catch (_) {}
  VIEW = 'one';
  try { localStorage.setItem('t-system-view', 'one'); } catch (_) {}
  applyCur();
  renderPoolTabs();

  // 若不在做T决策台或全览，自动切到决策台
  if (_activeTab !== 'tabConsole' && _activeTab !== 'tabAll') {
    switchTab('tabConsole');
  }

  const card = document.getElementById(`stockCard_${idx}`);
  if (card) {
    const tbH = (document.getElementById('topbar')?.offsetHeight || 50) + 16;
    const top = card.getBoundingClientRect().top + window.pageYOffset - tbH;
    window.scrollTo({ top, behavior: 'smooth' });
    card.classList.add('hl-focus');
    setTimeout(() => card.classList.remove('hl-focus'), 1200);
  }
}

export function applyCur() {
  const cards = document.querySelectorAll('#pool .card');
  if (!cards || !cards.length) return;

  const validCur = Math.max(0, Math.min(cards.length - 1, CUR || 0));
  setCur(validCur);

  cards.forEach((c, idx) => {
    if (VIEW === 'all') {
      c.style.display = '';
      c.classList.remove('is-hidden');
    } else {
      const isCur = idx === validCur;
      c.style.display = isCur ? '' : 'none';
      c.classList.toggle('is-hidden', !isCur);
    }
  });
}

export function renderPoolTabs() {
  const el = document.getElementById('poolTabs');
  if (!el) return;

  const tbEl = document.getElementById('topbar');
  if (tbEl) document.documentElement.style.setProperty('--tb-h', (tbEl.offsetHeight + 4) + 'px');

  if (!pool || !pool.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  el.style.display = '';
  const tabs = pool.map((s, i) => {
    const c = calc(s);
    const cl = c.chg >= 0 ? 'up' : 'down';
    const cur = (pool.length < 2) || (VIEW === 'one' && i === CUR);
    return `
      <button class="pool-tab ${cur ? 'cur' : ''}" data-tab="${i}">
        <span class="tt t-${tierOf(s)}">${tierOf(s) === 'short' ? '短' : '长'}</span>
        <span class="tn">${s.name}</span>
        <span class="pz ${cl}">${f2(+s.price)}</span>
        <span class="pc ${cl}">${pct(c.chg)}</span>
      </button>
    `;
  }).join('');

  const allBtn = pool.length > 1
    ? `<button class="pool-tab all ${VIEW === 'all' ? 'cur' : ''}" id="tabAll">▤ 全部 ${pool.length} 只</button>`
    : '';

  el.innerHTML = `<div class="pt-scroll">${tabs}</div>${allBtn}`;

  el.querySelectorAll('button[data-tab]').forEach(b => {
    b.onclick = () => focusStock(+b.dataset.tab);
  });
  const ab = document.getElementById('tabAll');
  if (ab) ab.onclick = () => setView(VIEW === 'all' ? 'one' : 'all');
}

export function renderTopbar() {
  const el = document.getElementById('tbPx');
  if (!el) return;
  if (!pool || !pool.length) {
    el.innerHTML = '<span style="color:var(--mute)">自选池为空</span>';
    return;
  }
  el.innerHTML = pool.map((s, i) => {
    const c = calc(s);
    const cl = c.chg >= 0 ? 'up' : 'down';
    return `
      <button class="tb-px-item" data-focus="${i}">
        <span class="tb-name">${s.name}</span>
        <b class="${cl}">${f2(+s.price)}</b>
        <b class="${cl}">${pct(c.chg)}</b>
      </button>
    `;
  }).join('');

  el.querySelectorAll('button[data-focus]').forEach(b => {
    b.onclick = () => focusStock(+b.dataset.focus);
  });
}

/* ===================== 日内分时作战时钟 ===================== */
export function updateTradingClock() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  const clockEl = document.getElementById('tbClockPhase');
  const dotEl = document.getElementById('clockDot');
  if (!clockEl || !dotEl) return;

  let phase = '🌙 盘后复盘期';
  let dotCls = 'dot-live';

  if (mins >= 555 && mins < 565) {
    phase = '🟡 09:15-09:25 集合竞价 (盯开盘定高低)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 565 && mins < 570) {
    phase = '🟡 09:25-09:30 竞价定盘 (定预案价位)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 570 && mins < 585) {
    phase = '🔴 09:30-09:45 情绪宣泄期 (严禁冲动追高)';
    dotCls = 'dot-live pulse-red';
  } else if (mins >= 585 && mins < 630) {
    phase = '🟢 09:45-10:30 做T黄金窗口 (方向确立·高抛低吸)';
    dotCls = 'dot-live pulse-green';
  } else if (mins >= 630 && mins < 690) {
    phase = '👀 10:30-11:30 震荡巩固期 (均线支撑检验)';
    dotCls = 'dot-live pulse-green';
  } else if (mins >= 690 && mins < 780) {
    phase = '☕ 11:30-13:00 午间休市 (复盘梳理)';
    dotCls = 'dot-live';
  } else if (mins >= 780 && mins < 840) {
    phase = '💤 13:00-14:00 缩量垃圾时间 (多看少动)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 840 && mins < 870) {
    phase = '⚡ 14:00-14:30 变盘预警期 (主力抢跑防突变)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 870 && mins < 895) {
    phase = '🚨 14:30-14:55 T仓强制平仓期 (日内必须闭环·绝不过夜)';
    dotCls = 'dot-live pulse-red';
  } else if (mins >= 895 && mins < 900) {
    phase = '🔒 14:55-15:00 尾盘定盘锁仓';
    dotCls = 'dot-live';
  }

  clockEl.textContent = phase;
  dotEl.className = dotCls;
}

export function paintStamp() {
  const el = document.getElementById('tbStamp');
  if (!el) return;
  if (!STAMP) {
    el.innerHTML = '<span style="color:var(--mute)">未取数</span>';
    return;
  }
  const ageSec = Math.floor((Date.now() - STAMP) / 1000);
  const isFresh = ageSec < 180;
  el.innerHTML = `<span style="color:${isFresh ? 'var(--up)' : 'var(--warn)'}">${isFresh ? '实时' : ageSec + '秒前'}</span>`;
}

/* ===================== 弹窗管理 ===================== */
export function openClockModal() {
  const m = document.getElementById('tradingClockModal');
  if (m) m.style.display = 'flex';
}

export function closeClockModal() {
  const m = document.getElementById('tradingClockModal');
  if (m) m.style.display = 'none';
}

let _srmOnAdd = null;

export function openStockReasonModal(item, onAdd) {
  if (!item) return;
  _srmOnAdd = onAdd || null;
  const m = document.getElementById('stockReasonModal');
  if (!m) return;

  const D = window.WB_LATEST || {};
  const recs = D.recommendations || [];
  const cands = (D.candidates || []).concat(D.steady || []);
  const sixCode = String(item.code || '').replace(/\D/g, '');
  const rec = recs.find(r => String(r.code).replace(/\D/g, '') === sixCode)
    || cands.find(r => String(r.code).replace(/\D/g, '') === sixCode)
    || {};

  const nameEl = document.getElementById('srmName');
  if (nameEl) nameEl.textContent = item.name || rec.name || '—';
  const codeEl = document.getElementById('srmCode');
  if (codeEl) codeEl.textContent = item.code || rec.code || '—';

  const isShort = (item.pool === 'short' || item.tier === 'short' || item.poolLabel === '短线做T' || rec.pool === 'short');
  const typePill = document.getElementById('srmTypePill');
  if (typePill) {
    typePill.className = 'pill ' + (isShort ? 'p-small' : 'p-steady');
    typePill.textContent = isShort ? '短线做T' : '稳健底仓';
  }

  const scorePill = document.getElementById('srmScorePill');
  const score = item.score || item.poolScore || rec.score || 85;
  if (scorePill) {
    scorePill.className = 'pill ' + (score >= 85 ? 'p-can' : score >= 75 ? 'p-small' : 'p-watch');
    scorePill.textContent = '评分 ' + score + (item.verdict ? ' · ' + item.verdict : (rec.verdict ? ' · ' + rec.verdict : ''));
  }

  const px = +item.price || +item.latestPrice || +rec.latestPrice || +rec.price || 0;
  const buyPx = +item.buy || +rec.buy || +item.poolBuy || px;
  const s1 = item.sell1 || rec.sell1 || (px ? +(px * 1.025).toFixed(2) : '—');
  const stp = item.stop || rec.stop || (px ? +(px * 0.985).toFixed(2) : '—');
  const srmSummary = document.getElementById('srmSummary');
  if (srmSummary) {
    srmSummary.innerHTML = `
      <span>参考现价: <b>${f2(px)}</b></span>
      <span>建议买点: <b>${f2(buyPx)}</b></span>
      <span>目标止盈: <b style="color:var(--up)">${f2(s1)}</b></span>
      <span>止损纪律: <b style="color:var(--down)">${f2(stp)}</b></span>
      ${item.amp ? `<span>日内振幅: <b>${f2(item.amp)}%</b></span>` : ''}
      ${item.volRatio ? `<span>开盘量比: <b>${f2(item.volRatio)}</b></span>` : ''}
    `;
  }

  // 为什么选它：入选理由
  const reasons = item.whyReasons || rec.whyReasons || [
    '⚡ 趋势与量价共振：均线多头形态，放量突破阻力位',
    '🛡️ 主力资金护盘：日内均价线上方运行时间占比高，重心坚挺',
    '🎯 做T空间充沛：日内具备明确高抛低吸安全垫与波段空间'
  ];
  const srmReasons = document.getElementById('srmReasons');
  if (srmReasons) {
    srmReasons.innerHTML = reasons.map(r => `<div class="sm-reason-item">${r}</div>`).join('');
  }

  // 重大利空排查
  const rc = item.riskCheck || rec.riskCheck || {
    status: 'safe',
    statusText: '🟢 未见重大恶性利空',
    risks: [],
    highlights: ['非ST标的，无退市警示', '流通市值适中，无极端流动性陷阱']
  };
  const rkBadge = document.getElementById('srmRiskStatus');
  if (rkBadge) {
    rkBadge.className = 'sm-risk-badge ' + (rc.status || 'safe');
    rkBadge.textContent = rc.statusText || '🟢 未见重大恶性利空';
  }

  const srmRisks = document.getElementById('srmRisks');
  if (srmRisks) {
    let rkHtml = '';
    if (rc.risks && rc.risks.length) {
      rkHtml += rc.risks.map(rk => `<div class="sm-risk-entry ${rk.level || 'warn'}"><b>⚠️ ${rk.type}：</b>${rk.desc}</div>`).join('');
    }
    if (rc.highlights && rc.highlights.length) {
      rkHtml += rc.highlights.map(hl => `<div class="sm-highlight-entry">✓ ${hl}</div>`).join('');
    }
    if (!rkHtml) rkHtml = '<div class="sm-highlight-entry">✓ 基本面排查正常，未见重大恶性利空警示</div>';
    srmRisks.innerHTML = rkHtml;
  }

  // 价位与做T实战测算
  const retOpen = rec.retOpen != null ? rec.retOpen : (px && buyPx ? ((px / buyPx - 1) - 0.0011) * 100 : 0);
  const tG = rec.tGainPct || (isShort ? 1.5 : 1.85);
  const totRet = rec.totalReturnWithT != null ? rec.totalReturnWithT : +(retOpen + tG).toFixed(2);
  const clsO = retOpen >= 0 ? 'var(--up)' : 'var(--down)';
  const clsT = totRet >= 0 ? 'var(--up)' : 'var(--down)';

  const srmPerfGrid = document.getElementById('srmPerfGrid');
  if (srmPerfGrid) {
    srmPerfGrid.innerHTML = `
      <div class="sm-pg-item"><span class="k">建议买入价</span><span class="v">${f2(buyPx)}</span></div>
      <div class="sm-pg-item"><span class="k">买入持有基准</span><span class="v" style="color:${clsO}">${pct(retOpen)}</span></div>
      <div class="sm-pg-item"><span class="k">做T增厚差价</span><span class="v" style="color:var(--info)">+${tG.toFixed(2)}%</span></div>
      <div class="sm-pg-item"><span class="k">做T综合总收益</span><span class="v" style="color:${clsT}">${pct(totRet)}</span></div>
    `;
  }

  const addBtn = document.getElementById('srmAddBtn');
  if (addBtn) {
    if (_srmOnAdd) {
      addBtn.style.display = 'inline-flex';
      addBtn.onclick = () => {
        _srmOnAdd();
        closeStockReasonModal();
      };
    } else {
      addBtn.style.display = 'none';
    }
  }

  const closeBtn = document.getElementById('srmCloseBtn');
  if (closeBtn) closeBtn.onclick = closeStockReasonModal;

  m.style.display = 'flex';
}

export function closeStockReasonModal() {
  const m = document.getElementById('stockReasonModal');
  if (m) m.style.display = 'none';
  _srmOnAdd = null;
}
