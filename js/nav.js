/* ============================================================
   A股做T执行台 · 导航栏、多Tab选项卡、作战时钟与弹窗模块 (nav.js)
   ============================================================ */

import { f2, pct, soundChime, TIER_LABEL } from './utils.js';
import { pool, tierOf, CUR, setCur, STAMP, TAIL_ACTIVES, LOG } from './state.js';
import { calc } from './api.js';
import { animTabTransition } from './anim.js';

/* 5大导航选项卡定义 */
export const TABS = [
  { id: 'tabConsole', label: '🎯 做T决策台', badgeId: 'ntBadgeConsole' },
  { id: 'tabTail',    label: '⚡ 尾盘黑马 T+0', badgeId: 'ntBadgeTail', isHot: true },
  { id: 'tabAccount', label: '📊 账户与战绩', badgeId: 'ntBadgeAccount' },
  { id: 'tabLedger',  label: '📒 执行台账与体检', badgeId: 'ntBadgeLedger' },
  { id: 'tabRules',   label: '📖 作战纪律与时钟', badgeId: null }
];

let _activeTab = 'tabConsole';

export function getActiveTab() {
  return _activeTab;
}

export function initTabs() {
  const bar = document.getElementById('mainNavBar');
  if (!bar) return;

  const savedTab = localStorage.getItem('t-nav-tab') || 'tabConsole';
  _activeTab = savedTab;

  const btnsHtml = TABS.map(t => `
    <button class="nav-tab-btn ${t.id === _activeTab ? 'active' : ''} ${t.isHot ? 'btn-hot' : ''}" data-tab="${t.id}" id="navBtn_${t.id}">
      <span>${t.label}</span>
      ${t.badgeId ? `<span class="nt-badge" id="${t.badgeId}"></span>` : ''}
    </button>
  `).join('');

  bar.innerHTML = btnsHtml;

  bar.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.onclick = () => {
      const targetTab = btn.dataset.tab;
      switchTab(targetTab);
    };
  });

  applyTabVisibility(_activeTab, false);
  updateTabBadges();
}

export function switchTab(tabId) {
  if (!TABS.some(t => t.id === tabId)) return;
  _activeTab = tabId;
  try { localStorage.setItem('t-nav-tab', tabId); } catch (_) {}

  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  applyTabVisibility(tabId, true);
  updateTabBadges();

  if (tabId === 'tabAccount' && window.renderEquity) {
    setTimeout(() => window.renderEquity(), 80);
  }
}

function applyTabVisibility(tabId, animate = true) {
  TABS.forEach(t => {
    const panel = document.getElementById(t.id);
    if (!panel) return;
    if (t.id === tabId) {
      panel.classList.add('active');
      panel.style.display = 'block';
      if (animate) animTabTransition(panel);
    } else {
      panel.classList.remove('active');
      panel.style.display = 'none';
    }
  });
}

export function updateTabBadges() {
  const bConsole = document.getElementById('ntBadgeConsole');
  if (bConsole) {
    const posCount = (pool || []).filter(s => (s.shares || 0) > 0).length;
    bConsole.textContent = posCount > 0 ? posCount : (pool ? pool.length : 0);
  }

  const bTail = document.getElementById('ntBadgeTail');
  if (bTail) {
    const activeTailCount = (TAIL_ACTIVES || []).filter(x => x && x.status === 'active').length;
    bTail.textContent = activeTailCount > 0 ? `${activeTailCount}持仓` : '推荐';
    bTail.classList.toggle('nt-badge-pulse', activeTailCount > 0);
  }

  const bLedger = document.getElementById('ntBadgeLedger');
  if (bLedger) {
    bLedger.textContent = LOG ? LOG.length : 0;
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

  // 若不在做T决策台，自动切到决策台
  if (_activeTab !== 'tabConsole') {
    switchTab('tabConsole');
  }

  const card = document.getElementById(`stockCard_${idx}`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

export function openStockReasonModal(code) {
  const s = (pool || []).find(item => item.code === code);
  const m = document.getElementById('stockReasonModal');
  if (!s || !m) return;

  const nameEl = document.getElementById('srmStockName');
  if (nameEl) nameEl.textContent = `${s.name} (${s.code})`;
  const bodyEl = document.getElementById('srmBody');
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="font-size:13.5px;line-height:1.8">
        <p><b>入选板块：</b>${s._bd && s._bd.list ? s._bd.list.slice(0, 5).map(x => x.name).join(' · ') : '待取数后自动解析'}</p>
        <p><b>估值支撑：</b>${s._val && s._val.cur ? `PE-TTM ${f2(s._val.cur.pe)} ｜ PB ${f2(s._val.cur.pb)}` : '历史估值加载中'}</p>
        <p><b>技术面综合评分：</b>${s._ta ? s._ta.score + ' 分' : '技术指标核算中'}</p>
        <p><b>做T纪律：</b>单笔止损线固定 1.5%，日内正T必须于 14:45 前闭环或保本出清。</p>
      </div>
    `;
  }
  m.style.display = 'flex';
}

export function closeStockReasonModal() {
  const m = document.getElementById('stockReasonModal');
  if (m) m.style.display = 'none';
}
