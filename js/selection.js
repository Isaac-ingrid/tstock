/* ============================================================
   A股做T执行台 · 选股池与自选股同步模块 (selection.js)
   负责读取 data/latest.js 选股契约、渲染候选池 Chip 与一键并入自选
   ============================================================ */

import { f2, pct, toast, toastOk, toastWarn, toastErr } from './utils.js';
import { pool, savePool } from './state.js';
import { render } from './card.js';
import { renderTopbar, renderPoolTabs, updateTabBadges, openStockReasonModal, switchTab } from './nav.js';

const sixOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/* 获取当前自选池中已存在股票代码的 Set */
export function getInPoolSet() {
  return new Set((pool || []).map(s => sixOf(s.code)).filter(Boolean));
}

/* 仅同步所有 candidate chip 的在池状态，避免整块重绘产生闪烁 */
export function syncSelectionChips() {
  const box = document.getElementById('selBox');
  if (!box) return;

  const have = getInPoolSet();
  box.querySelectorAll('.sel-chip[data-code]').forEach(el => {
    const on = have.has(el.dataset.code);
    el.classList.toggle('in-pool', on);
    el.title = (el.dataset.tip || '') + '\n\n' + (on ? '✓ 已在自选池中' : '点击查看入选理由，一键并入自选');
  });

  const D = window.WB_LATEST;
  if (!D) return;
  const short = D.candidates || [];
  const steady = D.steady || [];
  const inCnt = short.concat(steady).filter(r => have.has(sixOf(r.code))).length;

  let badge = box.querySelector('.sel-in');
  if (inCnt && !badge) {
    badge = document.createElement('span');
    badge.className = 'sel-in';
    const topEl = box.querySelector('.sel-top');
    if (topEl) topEl.appendChild(badge);
  }
  if (badge) {
    if (inCnt) {
      badge.textContent = `已在自选池 ${inCnt} 只`;
    } else {
      badge.remove();
    }
  }
}

/* 批量或单只将候选股票并入自选池 */
export function mergeSelectionToPool(list, tag = '短线') {
  if (!list || !list.length) {
    toastWarn('清单为空，没有可加入的标的。');
    return;
  }

  const have = getInPoolSet();
  let addCount = 0;
  const D = window.WB_LATEST || {};

  list.forEach(r => {
    const six = sixOf(r.code);
    if (!six || have.has(six)) return;
    have.add(six);

    pool.push({
      name: r.name,
      code: six,
      tcode: r.tcode || ((six.startsWith('6') ? 'sh' : 'sz') + six),
      prevClose: '',
      open: '',
      high: '',
      low: '',
      price: r.price ? String(r.price) : '',
      avg: '',
      vr: '',
      ma5: '',
      ma10: '',
      ma20: '',
      shares: 0,
      cost: 0,
      cap: 0,
      p: 'day',
      ov: { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 },
      sub: 'macd',
      poolTag: tag,
      poolScore: r.score,
      poolBuy: r.buy != null ? r.buy : '',
      poolSell1: r.sell1,
      poolSell2: r.sell2,
      poolStop: r.stop,
      poolDate: D.tradeDate || ''
    });
    addCount++;
  });

  if (!addCount) {
    toastWarn('所选标的已全部在自选池中，未重复添加。');
    return;
  }

  savePool();
  render(pool);
  renderPoolTabs();
  renderTopbar();
  updateTabBadges();
  syncSelectionChips();

  const name = list.length === 1 ? list[0].name : `${addCount} 只股票`;
  toastOk(`✓ 成功将 ${name} 加入自选做T决策台！`);

  // 触发后台异步补齐最新行情
  if (typeof window !== 'undefined' && typeof window.refreshAll === 'function') {
    window.refreshAll(true);
  }
}

/* 生成单个候选股票 Chip 的 HTML */
function chipHtml(r, have) {
  const code = sixOf(r.code);
  const inPool = have.has(code);
  const isShort = r.pool === 'short' || !r.pool;
  const chipCls = isShort
    ? ({ '可做': 'c-can', '小做': 'c-small', '观察': 'c-watch', '放弃': 'c-off' }[r.verdict] || 'c-off')
    : 'c-steady';

  const tip = isShort
    ? `${r.name} ${r.code}｜评分 ${r.score}（${r.verdict || '可做'}）\n建议买点 ${f2(r.buy)}（区间 ${f2(r.buyLo)}–${f2(r.buyHi)}）\nT1 ${f2(r.sell1)}　T2 ${f2(r.sell2)}　止损 ${f2(r.stop)}\n量比 ${f2(r.volRatio)}　均价线上方 ${r.vwapOnline == null ? '—' : r.vwapOnline + '%'}\n允许动作：${r.allowT || '正T'}`
    : `${r.name} ${r.code}｜评分 ${r.score}\n股息 ${f2(r.div)}%　ROE ${f2(r.roe)}%　市值 ${r.mv || '—'} 亿\n20日振幅 ${f2(r.amp20 || r.amp)}%　趋势 ${r.trend || '多头'}\n允许动作：${r.allowT || '倒T'}`;

  const cleanTip = tip.replace(/"/g, '&quot;');

  return `
    <span class="sel-chip ${chipCls}${inPool ? ' in-pool' : ''}"
      data-code="${code}"
      data-pool="${r.pool || 'short'}"
      data-tip="${cleanTip}"
      title="${cleanTip}\n\n${inPool ? '✓ 已在自选池中' : '点击查看入选理由，一键并入自选'}">
      <i class="dot-in"></i>
      <span class="sn">${r.name}</span>
      <span class="ss">${r.score}</span>
    </span>
  `;
}

/* 核心渲染方法：渲染选股池（收盘生成）+ 自选股入口 */
export function renderSelectionPool() {
  const box = document.getElementById('selBox');
  if (!box) return;

  const D = window.WB_LATEST;
  if (!D) {
    box.innerHTML = `
      <div class="sel-empty">
        未读到 <code>data/latest.js</code> 选股契约数据。<br>
        可先在终端运行 <code>node 选股引擎/publish.js</code>，或稍候数据生成后刷新本页。
      </div>
    `;
    return;
  }

  const env = D.env || {};
  const lvl = { OK: 'ok', WARN: 'warn', BAD: 'bad' }[env.level] || 'warn';
  const lvlText = { OK: '环境放行', WARN: '环境减半', BAD: '环境否决', UNKNOWN: '环境未知' }[env.level] || '环境放行';
  const c = D.counts || {};
  const short = D.candidates || [];
  const steady = D.steady || [];
  const have = getInPoolSet();
  const inCnt = short.concat(steady).filter(r => have.has(sixOf(r.code))).length;

  const dateStr = D.tradeDate || (D.generatedAt ? D.generatedAt.slice(0, 10) : '今日');
  const genTimeStr = D.generatedAt ? new Date(D.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';

  box.innerHTML = `
    <div class="sel-top">
      <span class="sel-env ${lvl}">${lvlText}</span>
      <span>短线候选 <b>${short.length}</b> 只（可做 ${c.canDo || short.filter(x=>x.verdict==='可做').length} / 小做 ${c.smallDo || short.filter(x=>x.verdict==='小做').length} / 观察 ${c.watch || short.filter(x=>x.verdict==='观察').length}）</span>
      <span>·</span>
      <span>稳健底仓 <b>${steady.length}</b> 只</span>
      <span>·</span>
      <span>环境允许执行 <b>${c.executable || short.length}</b> 只</span>
      <span class="sel-stamp">数据日 ${dateStr}${genTimeStr ? ' ' + genTimeStr : ''}</span>
      ${inCnt ? `<span class="sel-in">已在自选池 ${inCnt} 只</span>` : ''}
    </div>
    <div class="sel-grp">
      <div class="sel-gt"><b>短线做T候选</b>${env.text ? `<span>${env.text}</span>` : '<span>评分 ≥70 · 严格过滤ST、小市值与流动性陷阱</span>'}</div>
      <div class="sel-chips">${short.length ? short.map(r => chipHtml(r, have)).join('') : '<span class="sel-empty">今日无短线候选</span>'}</div>
    </div>
    <div class="sel-grp">
      <div class="sel-gt"><b>稳健底仓候选</b><span>高股息 / 低估值蓝筹，仅适合回踩倒T增厚，不追正T追高</span></div>
      <div class="sel-chips">${steady.length ? steady.map(r => chipHtml(r, have)).join('') : '<span class="sel-empty">本周稳健底仓暂无变动</span>'}</div>
    </div>
    <div class="sel-acts">
      <button id="selAddShort" class="btn-sel-act">＋ 全部加入短线（${short.length}）</button>
      <button id="selAddSteady" class="btn-sel-act">＋ 全部加入稳健（${steady.length}）</button>
      ${inCnt ? '<button id="selSync" class="btn-sel-act">⟳ 重新同步状态</button>' : ''}
      <a href="javascript:void(0)" id="btnJumpPerf" style="font-size:12px;font-weight:600;color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:6px;background:var(--accent-bg);border:1px solid var(--accent-b);margin-left:auto">
        📊 查看 60日实证大样本与历史战绩 (${(D.recommendations || []).length}只) →
      </a>
    </div>
    <div class="sel-tip">
      💡 <b>点击任意候选卡片</b> 可查看详尽入选理由、量价逻辑与重大利空排查并一键并入自选。<br>
      加入自选后系统将统一启动毫秒级分时监控、七格箱体计算与日内高抛低吸提醒。
    </div>
  `;

  // 绑定事件：Chip 点击打开入选理由弹窗并提供一键加入
  box.onclick = (e) => {
    const chip = e.target.closest('.sel-chip[data-code]');
    if (!chip) return;
    const code = chip.dataset.code;
    const poolType = chip.dataset.pool;
    const list = poolType === 'short' ? short : steady;
    const target = list.find(x => sixOf(x.code) === code);
    if (!target) return;

    const inPool = chip.classList.contains('in-pool');
    openStockReasonModal(target, inPool ? null : () => {
      mergeSelectionToPool([target], poolType === 'short' ? '短线' : '稳健');
    });
  };

  // 批量加入按钮绑定
  const btnAddShort = document.getElementById('selAddShort');
  if (btnAddShort) {
    btnAddShort.onclick = () => mergeSelectionToPool(short, '短线');
  }

  const btnAddSteady = document.getElementById('selAddSteady');
  if (btnAddSteady) {
    btnAddSteady.onclick = () => mergeSelectionToPool(steady, '稳健');
  }

  const btnSync = document.getElementById('selSync');
  if (btnSync) {
    btnSync.onclick = () => {
      syncSelectionChips();
      toastOk('✓ 候选状态已与本机自选池同步！');
    };
  }

  const btnJumpPerf = document.getElementById('btnJumpPerf');
  if (btnJumpPerf) {
    btnJumpPerf.onclick = () => {
      switchTab('tabAccount');
      const el = document.getElementById('perfKpis');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
}
