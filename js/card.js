/* ============================================================
   A股做T执行台 · 自选个股做T决策卡片与实时买卖模块 (card.js)
   ============================================================ */

import { f2, f3, pct, money, money2, fmtIn, todayStr, toast, toastOk, toastWarn, toastErr, soundChime, GRID, STOP, FLY, FEE, VAL_WIN, TIER_LABEL, AUTO_FIELDS } from './utils.js';
import { pool, savePool, LOG, saveLog, tierOf, CUR, setCur } from './state.js';
import { calc, computeTA, rsCalc, drawRS, loadStock, loadChart, loadDD, loadResearch } from './api.js';
import { drawChart, kbarHTML, chartLegendHTML, chartStat } from './chart.js';
import { animCardsStagger, animPricePulse } from './anim.js';

/* ===================== 持仓与成本核算 ===================== */
export function tRealOf(code){
  let sum = 0, n = 0;
  (LOG || []).forEach(r=>{
    if (String(r.stock||'').indexOf(String(code)) < 0) return;
    const v = logNet(r);
    if (v !== null){ sum += v; n++; }
  });
  return { sum, n };
}

function logNet(r){
  const b=+r.buy||0, s=+r.sell||0, q=+r.qty||0;
  if(!b||!s||!q) return null;
  return (s-b)*q - (s+b)*q*FEE;
}

export function posCalc(s){
  const px   = +s.price || 0;
  const cost = +s.cost  || 0;
  const sh   = Math.round(+s.shares || 0);
  const pc   = +s.prevClose || 0;
  const cap  = Math.round(+s.cap || 0);

  const mkt     = px * sh;
  const costAmt = cost * sh;
  const floatPL = sh ? (px - cost) * sh : 0;
  const floatPct= (sh && cost) ? (px - cost)/cost*100 : null;
  const dayPL   = (sh && pc) ? (px - pc) * sh : null;
  const dayPct  = pc ? (px - pc)/pc*100 : null;

  const t = tRealOf(s.code);
  const tPerShare = (sh && t.n) ? t.sum/sh : null;
  const tBudget = cap > 0 ? Math.round(cap*0.3) : (sh ? Math.round(sh*0.3*px) : 0);

  return { px, cost, sh, cap, mkt, costAmt, floatPL, floatPct, dayPL, dayPct,
           tReal:t.sum, tCount:t.n, tPerShare,
           costNoT: tPerShare!==null ? cost + tPerShare : null,
           tBudget, hasPos: sh > 0,
           aboveCost: (sh && cost) ? px > cost : null };
}

export function posBar(s, p, i){
  const fCls = p.floatPL >= 0 ? 'up' : 'dn';
  const dCls = (p.dayPL||0) >= 0 ? 'up' : 'dn';
  const today = todayStr();
  const todayTBuys = (typeof LOG !== 'undefined' ? LOG : [])
    .filter(r => r.date === today && (r.stock === s.name || r.stock === s.code) && r.dir === '正T')
    .reduce((a, b) => a + (+b.qty || 0), 0);
  const shTotal = Math.round(+s.shares || 0);
  const availSell = Math.max(0, shTotal - todayTBuys);

  let tCell = `<div class="pb"><span class="k">做T累计已实现</span><span class="v" style="color:var(--mute)">—</span><span class="d">台账里还没有该股的记录</span></div>`;
  if (p.tCount){
    tCell = `<div class="pb hl"><span class="k">做T累计贡献（${p.tCount}笔）</span>
      <span class="v">${money2(p.tReal)}</span>
      <span class="d">折合每股降本 ${f3(p.tPerShare)} 元${p.costNoT!==null?' ｜ 未做T成本约 '+f2(p.costNoT):''}</span></div>`;
  }
  return `<div class="pos-bar">
    <div class="pb pb-hold" title="可直接在框内修改持仓参数，失焦或回车即时更新">
      <div class="pb-row">
        <span class="k">持仓股数</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="shares" value="${fmtIn(s.shares)}" placeholder="0" inputmode="numeric" step="100">
          <span class="pb-unit">股</span>
        </div>
      </div>
      <div class="pb-row">
        <span class="k">持仓成本</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="cost" value="${fmtIn(s.cost)}" placeholder="0.00" inputmode="decimal" step="0.01">
          <span class="pb-unit">元</span>
        </div>
      </div>
      <div class="pb-row">
        <span class="k">可用现金</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="cap" value="${fmtIn(s.cap)}" placeholder="0" inputmode="numeric" step="1000">
          <span class="pb-unit">元</span>
        </div>
      </div>
      ${shTotal > 0 ? `<div class="pb-t1-bar"><span>可卖底仓: <b>${availSell}</b> 股</span>${todayTBuys > 0 ? `<span style="color:var(--warn-d)" title="今日正T买入的筹码受 A 股 T+1 限制，今日不可卖，卖出必动底仓！">今日锁仓: <b>${todayTBuys}</b> 股 (T+1冻结)</span>` : '<span style="color:var(--down)">无今日冻结</span>'}</div>` : ''}
    </div>
    <div class="pb"><span class="k">持仓市值</span><span class="v">${p.hasPos ? Math.round(p.mkt).toLocaleString('zh-CN') : '—'}</span><span class="d">${p.hasPos ? `${p.sh.toLocaleString('zh-CN')} 股 × ${f2(p.px)}` : '录入股数后自动核算'}</span></div>
    <div class="pb ${p.hasPos ? fCls : ''}"><span class="k">浮动盈亏</span><span class="v">${p.hasPos ? money2(p.floatPL) : '—'}</span><span class="d">${p.hasPos ? `成本 ${f2(p.cost)} ｜ ${p.floatPct!==null?pct(p.floatPct):'—'}` : '成本价对比'}</span></div>
    <div class="pb ${p.hasPos ? dCls : ''}"><span class="k">当日盈亏</span><span class="v">${p.hasPos && p.dayPL!==null ? money2(p.dayPL) : '—'}</span><span class="d">${p.hasPos ? `按昨收 ${f2(+s.prevClose)} 计${p.dayPct!==null?' ｜ '+pct(p.dayPct):''}` : '日内持仓变动'}</span></div>
    ${tCell}
  </div>`;
}

/* ===================== 实时买卖记账与实时卖出选项 ===================== */
export function calcLiveTrade(buyPx, sellPx, qty, totalShares) {
  const feeRate = (typeof FEE !== 'undefined' ? FEE : 0.0011);
  const buyAmt = buyPx * qty;
  const sellAmt = sellPx * qty;
  const friction = (buyAmt + sellAmt) * feeRate;
  const grossProfit = sellAmt - buyAmt;
  const netProfit = grossProfit - friction;
  const profitRatio = buyPx > 0 ? ((sellPx - buyPx) / buyPx - feeRate) * 100 : 0;
  const costReduction = totalShares > 0 ? (netProfit / totalShares) : 0;
  const newCost = Math.max(0, buyPx - costReduction);

  return {
    buyAmt: +buyAmt.toFixed(2),
    sellAmt: +sellAmt.toFixed(2),
    friction: +friction.toFixed(2),
    netProfit: +netProfit.toFixed(2),
    profitRatio: +profitRatio.toFixed(2),
    costReduction: +costReduction.toFixed(3),
    newCost: +newCost.toFixed(3)
  };
}

export function liveTradeBar(s, p, c, i){
  const hasPos = p.hasPos && (s.shares > 0) && (s.cost > 0);
  const curPx = +s.price || +s.prevClose || 0;
  const defaultSellPx = s._sellPx != null ? s._sellPx : (c.tp1 || curPx || +s.cost);
  const recQty = c.t1Lots || (s.shares >= 300 ? 300 : Math.min(100, s.shares || 100));

  const today = todayStr();
  const todayTBuys = (typeof LOG !== 'undefined' ? LOG : [])
    .filter(r => r.date === today && (r.stock === s.name || r.stock === s.code) && r.dir === '正T')
    .reduce((a, b) => a + (+b.qty || 0), 0);
  const shTotal = Math.round(+s.shares || 0);
  const availSell = Math.max(0, shTotal - todayTBuys);

  const activeTab = s._tradeTab || (hasPos ? 'sell' : 'buy');

  return `
    <div class="live-trade-section">
      <div class="lts-tabs">
        <button type="button" class="lts-tab-btn ${activeTab === 'sell' ? 'active' : ''}" onclick="window.switchTradeTab(${i}, 'sell')">
          ⚡ 实时卖出记账 ${hasPos ? `<span class="lts-badge-pos">持仓 ${s.shares}股</span>` : ''}
        </button>
        <button type="button" class="lts-tab-btn ${activeTab === 'buy' ? 'active' : ''}" onclick="window.switchTradeTab(${i}, 'buy')">
          ➕ 实时买入/建仓
        </button>
      </div>

      <!-- TAB 1: 实时卖出 (减仓 / 做T闭环) -->
      <div class="lts-pane" id="ltbPaneSell_${i}" style="${activeTab === 'sell' ? 'display:block' : 'display:none'}">
        <div class="ltb-flex">
          <div class="ltb-field">
            <label class="ltb-label">卖出模式</label>
            <select class="ltb-select" id="ltbMode_${i}" onchange="window.updateLtbPreview(${i})">
              <option value="t">🎯 正T闭环 (底仓不变，差价降本)</option>
              <option value="reduce">📉 减仓卖出 (减少持仓股数)</option>
            </select>
          </div>
          <div class="ltb-field">
            <label class="ltb-label">买入价 (成本)</label>
            <div class="ltb-input-wrap">
              <input type="number" step="0.01" class="ltb-input" id="ltbBuy_${i}" value="${f2(s.cost || curPx)}" oninput="window.updateLtbPreview(${i})">
              <span class="ltb-unit">元</span>
            </div>
          </div>
          <div class="ltb-field">
            <label class="ltb-label">卖出成交价</label>
            <div class="ltb-input-wrap">
              <input type="number" step="0.01" class="ltb-input" id="ltbSell_${i}" value="${f2(defaultSellPx)}" oninput="window.updateLtbPreview(${i})">
              <span class="ltb-unit">元</span>
            </div>
          </div>
          <div class="ltb-field">
            <label class="ltb-label">卖出股数 ${availSell < shTotal ? `<span style="color:var(--warn-d)">(可卖 ${availSell}股)</span>` : ''}</label>
            <div class="ltb-input-wrap">
              <input type="number" step="100" class="ltb-input" id="ltbQty_${i}" value="${recQty}" max="${availSell}" oninput="window.updateLtbPreview(${i})">
              <span class="ltb-unit">股</span>
            </div>
          </div>
          <div class="ltb-field ltb-action-field">
            <label class="ltb-label">&nbsp;</label>
            <button type="button" class="btn-live-sell" onclick="window.execLiveSell(${i})">
              🚀 立即执行卖出
            </button>
          </div>
        </div>

        <div class="lts-chips">
          <span class="lts-chip-title">卖出价快捷：</span>
          <button type="button" class="lts-chip" onclick="window.setLtbSellPx(${i}, ${curPx})">现价 ${f2(curPx)}</button>
          ${c.tp1 ? `<button type="button" class="lts-chip" onclick="window.setLtbSellPx(${i}, ${c.tp1})">止盈目标一 ${f2(c.tp1)}</button>` : ''}
          ${c.tp2 ? `<button type="button" class="lts-chip" onclick="window.setLtbSellPx(${i}, ${c.tp2})">止盈目标二 ${f2(c.tp2)}</button>` : ''}
          ${c.outA ? `<button type="button" class="lts-chip" onclick="window.setLtbSellPx(${i}, ${c.outA})">倒T减仓位 ${f2(c.outA)}</button>` : ''}
          <span class="lts-chip-title" style="margin-left:10px">股数快捷：</span>
          ${recQty ? `<button type="button" class="lts-chip" onclick="window.setLtbQty(${i}, ${recQty})">建议T仓 ${recQty}股</button>` : ''}
          ${availSell >= 200 ? `<button type="button" class="lts-chip" onclick="window.setLtbQty(${i}, 200)">200股</button>` : ''}
          ${availSell > 0 ? `<button type="button" class="lts-chip" onclick="window.setLtbQty(${i}, ${availSell})">全部可卖 ${availSell}股</button>` : ''}
        </div>

        <div class="ltb-preview" id="ltbPreview_${i}">
          <span class="lts-prev-tag">实时测算</span>
          <span>净做T差价: <b style="color:var(--up)">+0.00 元</b></span>
          <span class="lts-dot">·</span>
          <span>做T收益率: <b>0.00%</b></span>
          <span class="lts-dot">·</span>
          <span>底仓降本: <b>-0.000 元/股</b></span>
        </div>
      </div>

      <!-- TAB 2: 实时买入 (建仓 / 加仓) -->
      <div class="lts-pane" id="ltbPaneBuy_${i}" style="${activeTab === 'buy' ? 'display:block' : 'display:none'}">
        <div class="ltb-flex">
          <div class="ltb-field">
            <label class="ltb-label">买入类型</label>
            <input class="ltb-select" style="background:var(--card);cursor:default" readonly value="${hasPos ? '➕ 加仓买入 (加权计算新成本)' : '🎯 建仓买入 (确立底仓成本)'}">
          </div>
          <div class="ltb-field">
            <label class="ltb-label">买入成交价</label>
            <div class="ltb-input-wrap">
              <input type="number" step="0.01" class="ltb-input" id="ltbBuyPx_${i}" value="${f2(curPx)}">
              <span class="ltb-unit">元</span>
            </div>
          </div>
          <div class="ltb-field">
            <label class="ltb-label">买入股数</label>
            <div class="ltb-input-wrap">
              <input type="number" step="100" class="ltb-input" id="ltbBuyQty_${i}" value="${recQty || 100}">
              <span class="ltb-unit">股</span>
            </div>
          </div>
          <div class="ltb-field ltb-action-field">
            <label class="ltb-label">&nbsp;</label>
            <button type="button" class="btn-live-buy" onclick="window.execLiveBuy(${i})">
              📥 确认记入买入
            </button>
          </div>
        </div>

        <div class="lts-chips">
          <span class="lts-chip-title">买入价快捷：</span>
          <button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyPx_${i}').value='${f2(curPx)}'">现价 ${f2(curPx)}</button>
          ${c.inA ? `<button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyPx_${i}').value='${f2(c.inA)}'">正T建议买点 ${f2(c.inA)}</button>` : ''}
          ${c.inB ? `<button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyPx_${i}').value='${f2(c.inB)}'">第二低吸点 ${f2(c.inB)}</button>` : ''}
          <span class="lts-chip-title" style="margin-left:10px">股数快捷：</span>
          <button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyQty_${i}').value='100'">100股</button>
          <button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyQty_${i}').value='200'">200股</button>
          ${recQty ? `<button type="button" class="lts-chip" onclick="document.getElementById('ltbBuyQty_${i}').value='${recQty}'">建议T仓 ${recQty}股</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

export function updateLtbPreview(idx){
  const s = pool[idx];
  if (!s) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const sellInp = document.getElementById(`ltbSell_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);
  const modeSel = document.getElementById(`ltbMode_${idx}`);
  const prevBox = document.getElementById(`ltbPreview_${idx}`);

  if (!buyInp || !sellInp || !qtyInp || !prevBox) return;

  const buyPx = parseFloat(buyInp.value) || 0;
  const sellPx = parseFloat(sellInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;
  const mode = modeSel ? modeSel.value : 't';
  const totalShares = s.shares || 0;

  if (buyPx <= 0 || sellPx <= 0 || qty <= 0) {
    prevBox.innerHTML = '<span style="color:var(--mute)">输入有效买价、卖价和股数后自动计算做T降本与盈亏</span>';
    return;
  }

  const res = calcLiveTrade(buyPx, sellPx, qty, totalShares);
  const isUp = res.netProfit >= 0;
  const col = isUp ? 'var(--up)' : 'var(--down)';

  if (mode === 't') {
    prevBox.innerHTML = `
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px">
        <span class="lts-prev-tag">做T测算</span>
        <span>净做T差价: <b style="color:${col}">${isUp ? '+' : ''}${money2(res.netProfit)} 元</b> (${res.profitRatio >= 0 ? '+' : ''}${res.profitRatio}%)</span>
        <span class="lts-dot">·</span>
        <span>底仓降本: <b style="color:${col}">-${f3(res.costReduction)} 元/股</b></span>
        <span class="lts-dot">·</span>
        <span>更新后成本: <b>${f3(res.newCost)} 元</b></span>
        <span class="lts-friction">(已扣佣金+印花税约 ¥${res.friction})</span>
      </div>
    `;
  } else {
    prevBox.innerHTML = `
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px">
        <span class="lts-prev-tag">减仓测算</span>
        <span>减仓盈亏: <b style="color:${col}">${isUp ? '+' : ''}${money2(res.netProfit)} 元</b> (${res.profitRatio >= 0 ? '+' : ''}${res.profitRatio}%)</span>
        <span class="lts-dot">·</span>
        <span>回笼资金: <b>¥${Math.round(res.sellAmt - res.friction).toLocaleString('zh-CN')}</b></span>
        <span class="lts-dot">·</span>
        <span>剩余持仓: <b>${Math.max(0, totalShares - qty)} 股</b></span>
        <span class="lts-friction">(已扣佣金+印花税约 ¥${res.friction})</span>
      </div>
    `;
  }
}

export function execLiveSell(idx){
  const s = pool[idx];
  if (!s) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const sellInp = document.getElementById(`ltbSell_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);
  const modeSel = document.getElementById(`ltbMode_${idx}`);

  const buyPx = parseFloat(buyInp.value) || 0;
  const sellPx = parseFloat(sellInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;
  const mode = modeSel ? modeSel.value : 't';
  const totalShares = s.shares || 0;

  if (buyPx <= 0) { toastWarn('请输入有效的买入价格'); return; }
  if (sellPx <= 0) { toastWarn('请输入有效的卖出价格'); return; }
  if (qty <= 0) { toastWarn('请输入卖出股数'); return; }
  if (qty > totalShares) { toastWarn(`卖出股数 (${qty}) 不能大于当前总持仓 (${totalShares} 股)`); return; }

  const res = calcLiveTrade(buyPx, sellPx, qty, totalShares);
  const today = todayStr();

  const rec = {
    date: today,
    stock: s.name,
    dir: mode === 't' ? '正T' : (totalShares === qty ? '清仓卖出' : '减仓卖出'),
    buy: buyPx,
    sell: sellPx,
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: mode === 't' ? `卡片实时做T(降本${res.costReduction}元/股)` : `卡片实时减仓`
  };
  LOG.push(rec);
  saveLog();

  const oldCost = s.cost;
  if (mode === 't') {
    s.cost = res.newCost;
  } else {
    s.shares = Math.max(0, totalShares - qty);
    if (s.shares === 0) s.cost = 0;
  }

  savePool();
  if (window.renderLog) window.renderLog();
  render(pool);

  const profitStr = (res.netProfit >= 0 ? '+' : '') + res.netProfit.toLocaleString('zh-CN');
  if (mode === 't') {
    soundChime(880, 0.25);
    toastOk(`✓ 已成功记录卖出：${s.name} 买入 ¥${f2(buyPx)} ➔ 卖出 ¥${f2(sellPx)}，净差价 ${profitStr} 元！底仓成本由 ¥${f2(oldCost)} 降至 ¥${f2(s.cost)}！`);
  } else {
    soundChime(660, 0.2);
    toastOk(`✓ 已成功记录减仓：${s.name} 卖出 ${qty} 股，净盈亏 ${profitStr} 元，剩余持仓 ${s.shares} 股！`);
  }
}

export function execLiveBuy(idx){
  const s = pool[idx];
  if (!s) return;

  const buyInp = document.getElementById(`ltbBuyPx_${idx}`);
  const qtyInp = document.getElementById(`ltbBuyQty_${idx}`);

  const buyPx = parseFloat(buyInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;

  if (buyPx <= 0) { toastWarn('请输入有效的买入价格'); return; }
  if (qty <= 0) { toastWarn('请输入买入股数'); return; }

  const today = todayStr();
  const oldShares = s.shares || 0;
  const oldCost = s.cost || 0;

  if (oldShares > 0) {
    const newShares = oldShares + qty;
    const newCost = +(((oldCost * oldShares) + (buyPx * qty)) / newShares).toFixed(3);
    s.shares = newShares;
    s.cost = newCost;
  } else {
    s.shares = qty;
    s.cost = buyPx;
  }
  s._tradeTab = 'sell';

  const rec = {
    date: today,
    stock: s.name,
    dir: oldShares > 0 ? '加仓买入' : '买入建仓',
    buy: buyPx,
    sell: '',
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: oldShares > 0 ? `卡片实时加仓(持仓增至${s.shares}股)` : '卡片实时建仓买入'
  };
  LOG.push(rec);
  saveLog();

  savePool();
  if (window.renderLog) window.renderLog();
  render(pool);

  soundChime(580, 0.2);
  toastOk(`✓ 成功记录买入：${s.name} 买入 ${qty} 股（买入价 ¥${f2(buyPx)}）！当前持仓 ${s.shares} 股（成本 ¥${f2(s.cost)}），已激活卖出记账选项！`);
}

/* ===================== 研究卡渲染：估值分位 · 板块归属 · 相对强弱 ===================== */
export function pctTag(p){
  if (p==null) return '<span class="sig s-nt">—</span>';
  const cls = p<=25 ? 's-ok' : p>=75 ? 's-no' : 's-nt';
  return `<span class="sig ${cls}">${p.toFixed(0)}%</span>`;
}
export function winTxt(all){
  return VAL_WIN.map(([k,label])=>{
    const s = (all || {})[k] || {};
    return `${label} <b style="font-family:ui-monospace,Consolas,monospace">${s.pct==null?'—':s.pct.toFixed(0)+'%'}</b>`;
  }).join(' · ');
}
export function vBarHTML(st, cur){
  if (!st || cur==null || st.min==null || st.max==null || st.max<=st.min) return '';
  const pos = v => Math.max(0, Math.min(100, (v-st.min)/(st.max-st.min)*100));
  const pm = pos(st.med), hot = st.pct!=null && st.pct>=50;
  return `<div class="vbar">
      <div class="band" style="left:${pm}%;width:${Math.max(0,100-pm)}%"></div>
      <div class="med" style="left:${pm}%"></div>
      <div class="now${hot?'':' lo'}" style="left:${pos(cur)}%"></div>
    </div>
    <div class="vaxis"><span>${f2(st.min)}</span><span>中位 ${f2(st.med)}</span><span>${f2(st.max)}</span></div>`;
}
export function valRow(label, cur, win, all){
  return `<div style="display:grid;grid-template-columns:104px minmax(0,1fr) 168px;gap:10px;align-items:center;font-size:12px;margin-top:9px">
      <div><b>${label}</b><br><span style="font-family:ui-monospace,Consolas,monospace;font-size:14px;font-weight:700">${f2(cur)}</span></div>
      <div>${vBarHTML(win, cur)}</div>
      <div style="font-size:11.5px;color:var(--sub);line-height:1.7">${winTxt(all)}</div>
    </div>`;
}
export function researchBlock(s, i, pool){
  const v = s._val, bd = s._bd, rs = rsCalc(s);

  let valHTML;
  if (s._valErr){
    valHTML = `<div style="font-size:12px;color:var(--warn);margin-top:8px">估值序列取数失败：${s._valErr}</div>`;
  } else if (!v){
    valHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">正在拉取上市以来的逐日 PE / PB 序列…（约 0.5 秒，每个交易日只拉一次）</div>`;
  } else {
    valHTML = valRow('PE-TTM', v.cur.pe, v.pe['3y'], v.pe)
            + valRow('PB-MRQ', v.cur.pb, v.pb['3y'], v.pb)
            + valRow('PS-TTM', v.cur.ps, v.ps['3y'], v.ps)
            + `<div style="font-size:11.5px;color:var(--mute);margin-top:8px">
                 分位口径：该标的 <b>${v.bars}</b> 个交易日（${v.start} ~ ${v.end}）中，有多少比例的交易日估值低于当前值。分位条横轴是估值数值本身，游标为当前值。
                 ${v.pe['3y'].pct!=null && v.pe['3y'].pct<=25 ? ' <b style="color:var(--down)">当前估值处于近3年偏低区，对长线底仓构成支撑。</b>' : ''}
                 ${v.pe['3y'].pct!=null && v.pe['3y'].pct>=75 ? ' <b style="color:var(--up)">当前估值处于近3年偏高区，底仓加码需谨慎。</b>' : ''}
               </div>`;
  }

  let bdHTML;
  if (s._bdErr){
    bdHTML = `<div style="font-size:12px;color:var(--warn);margin-top:8px">板块归属取数失败：${s._bdErr}</div>`;
  } else if (!bd){
    bdHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">板块归属加载中…</div>`;
  } else {
    const tags = bd.list.slice(0,14).map(x=>{
      const cls = x.type==='行业' ? 'ind' : (x.type==='板块' ? 'sec' : (x.precise ? 'hot' : 'con'));
      return `<span class="bdg ${cls}">${x.name}</span>`;
    }).join('');
    const meaningful = x => x.type === '行业' || (x.precise && !x.type);
    const mine = {};
    (bd.list||[]).filter(meaningful).forEach(x=>{ mine[x.name] = 1; });
    const others = {};
    (pool||[]).forEach((o,j)=>{ if (j===i || !o._bd) return;
      (o._bd.list||[]).filter(meaningful).forEach(x=>{
        if (mine[x.name]) (others[x.name] = others[x.name]||[]).push(o.name); }); });
    const hits = Object.keys(others).filter(n=> others[n].length);
    bdHTML = `<div class="bdgs">${tags}</div>`
      + (hits.length
        ? `<div class="conc">⚠️ 池内集中度：${hits.slice(0,3).map(n=>`<b>${n}</b>（与 ${others[n].join('、')} 同板块）`).join('；')} —— 同一条产业链上的标的一旦遇到板块级杀跌会同时回撤，注意总仓位。</div>`
        : '');
  }

  let rsHTML;
  if (!rs){
    rsHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">相对强弱需要个股与指数日K就绪后计算（点一次「⟳ 取数」即可）。</div>`;
  } else {
    const beat = rs.r20!=null ? rs.r20>=0 : null;
    rsHTML = `<div class="rs-wrap"><canvas data-rs="${i}"></canvas></div>
      <div style="font-size:11.5px;color:var(--sub);margin-top:6px">
        20日相对强弱 <b style="font-family:ui-monospace,Consolas,monospace;color:${beat===null?'var(--sub)':beat?'var(--up)':'var(--down)'}">${rs.r20==null?'—':pct(rs.r20)}</b>
        · 60日 <b style="font-family:ui-monospace,Consolas,monospace;color:${rs.r60==null?'var(--sub)':rs.r60>=0?'var(--up)':'var(--down)'}">${rs.r60==null?'—':pct(rs.r60)}</b>
        · 当前 RS 分位 ${pctTag(rs.pct)}
        ${beat===null?'':` —— 近20个交易日<b>${beat?'跑赢':'跑输'}</b>参照指数`}
      </div>`;
  }

  return `<div class="ta t-nt" style="grid-column:1/-1;padding:12px 13px">
    <div class="h"><span>估值分位 · 板块归属 · 相对强弱</span>
      <span class="sig s-nt">${v? v.bars+'个交易日' : '研究数据'}</span></div>
    ${valHTML}
    <div style="font-size:12px;margin-top:13px;padding-top:11px;border-top:1px dashed var(--line)">
      <b>板块归属</b> <span style="color:var(--mute);font-size:11.5px">东财行业分类 + 核心题材，按核心度排序（红色=该股被精确归入）</span></div>
    ${bdHTML}
    <div style="font-size:12px;margin-top:13px;padding-top:11px;border-top:1px dashed var(--line)">
      <b>相对强弱 RS</b> <span style="color:var(--mute);font-size:11.5px">个股 ÷ ${rs?rs.ref:'参照指数'}，紫线=RS，橙线=RS 的 MA5，灰虚线=区间中位</span></div>
    ${rsHTML}
    <div style="font-size:11.5px;color:var(--mute);margin-top:9px;line-height:1.6">
      RS 上行 = 个股跑赢指数（资金在往这只票上集中），下行 = 跑输。做T时 RS 向上说明回踩有承接、正T更安全；RS 持续向下则只宜倒T。
    </div>
  </div>`;
}

export function vmCardHtml(s){
  const vm = s._vm;
  const box = (cls, title, sig, sc, big, desc) =>
    `<div class="ta ${cls}"><div class="h"><span>${title}</span><span class="sig ${sc}">${sig}</span></div>
     ${big?`<div class="big">${big}</div>`:''}<div class="d">${desc}</div></div>`;
  const note = `<br><span style="color:var(--mute)">分母是前 ${(vm && vm.baseDays) || 5} 个交易日<b>同一时段</b>的平均量，不是当日均量。</span>`;
  if (vm && vm.ok && vm.state !== 'na'){
    return box(vm.cls, '分时量能（同时段基准）', vm.label, vm.sc,
      (vm.r3 != null ? vm.r3.toFixed(2) + '×' : '—'), vm.text + note);
  }
  if (vm && vm.err){
    return box('t-nt', '分时量能（同时段基准）', '未取到', 's-nt', '—',
      `${vm.err}。日级量能卡片仍然有效。一旦恢复即自动判读。`);
  }
  if (vm && vm.ok){
    return box('t-nt', '分时量能（同时段基准）', '样本不足', 's-nt', (vm.nBars || 0) + ' 根',
      `今日 5 分钟K 只有 <b>${vm.nBars || 0} 根</b>，样本不足，不做量价判定。`);
  }
  return box('t-nt', '分时量能（同时段基准）', '未取数', 's-nt', '—',
    '点右上「⟳ 取数」后计算：拉 m5 → 建前 5 日同时段基准 → 判量价关系。');
}

export function taCards(s, ta, c){
  if (!ta){
    return `<div class="ta-grid"><div class="ta t-nt"><div class="h"><span>技术面</span></div>
      <div class="d">K线未同步 —— 点卡片右上「⟳ 取数」后解锁箱体 / MACD / 破位监测。</div></div>${vmCardHtml(s)}</div>`;
  }
  const out = [];
  const card = (cls, title, sig, sigCls, big, desc, extra)=>
    `<div class="ta ${cls}"><div class="h"><span>${title}</span><span class="sig ${sigCls}">${sig}</span></div>
     ${big?`<div class="big">${big}</div>`:''}<div class="d">${desc}</div>${extra||''}</div>`;

  // 0. 技术面综合评分
  {
    const sc = ta.score;
    const lvl = sc>=75?['强势','t-ok','s-ok','结构健康，做T以正T为主，回踩均线即买点。']
              : sc>=55?['偏强','t-ok','s-ok','多头占优，可正常执行正T，跌破 MA20 再收手。']
              : sc>=45?['中性','t-nt','s-nt','多空拉锯，只小仓试，等方向明朗。']
              : sc>=25?['偏弱','t-wn','s-wn','结构走坏，只允许倒T减仓，不做低吸。']
              :        ['弱势','t-no','s-no','多项指标共振向下，<b>今日宜空仓观望</b>。'];
    out.push(card(lvl[1], '技术面综合评分', lvl[0], lvl[2], sc+' 分',
      lvl[3] + `<br><span style="color:var(--mute)">由均线排列、MACD、箱体位置、MA20 方向、量能五项加权，供多空参考。</span>`));
  }
  // 1. 箱体
  const b = ta.box20;
  if (b){
    let sig, sc, desc;
    if (b.up){ sig='上破箱顶'; sc='s-no'; desc=`已站上 20 日箱顶 ${f2(b.top)}，箱体上移。回踩不破前箱顶即为新支撑。极强势阶段。极端放量时注意短线冲高回落。` ; }
    else if (b.down){ sig='跌破箱底'; sc='s-wn'; desc=`已跌破 20 日箱底 ${f2(b.bot)}，箱体下移。此时<b>停止做T</b>，等重新站回箱内再谈。` ; }
    else if (b.pos >= 78){ sig='贴近箱顶'; sc='s-wn'; desc=`位于箱内 ${b.pos.toFixed(0)}%，贴近箱顶 ${f2(b.top)} 阻力。正T不宜在此追买，反而是倒T减仓的位置。` ; }
    else if (b.pos <= 22){ sig='贴近箱底'; sc='s-ok'; desc=`位于箱内 ${b.pos.toFixed(0)}%，靠近箱底 ${f2(b.bot)} 支撑。缩量止跌可分批低吸，跌破则认输。` ; }
    else { sig='箱体中枢'; sc='s-nt'; desc=`位于箱内 ${b.pos.toFixed(0)}%，既不便宜也不贵。箱体高度 ${b.height.toFixed(1)}%，波段空间充裕。` ; }
    out.push(card(sc==='s-ok'?'t-ok':sc==='s-no'?'t-no':'t-wn', '20日箱体', sig, sc,
      `${f2(b.bot)} ~ ${f2(b.top)}`, desc,
      `<div class="box-bar"><div class="fill" style="width:${Math.max(0,Math.min(100,b.pos))}%"></div></div>`));
  }
  // 2. MACD
  const m = ta.macd;
  if (m){
    let sig, sc, desc;
    if (m.cross === 'gold' && m.aboveZero){ sig='零上金叉'; sc='s-ok'; desc='零轴上方金叉，最强买点。正T胜率最高阶段。'; }
    else if (m.cross === 'gold'){           sig='零下金叉'; sc='s-ok'; desc='零轴下方金叉，超跌反弹性质。先当弱反弹做，控制仓位。'; }
    else if (m.cross === 'dead' && !m.aboveZero){ sig='零下死叉'; sc='s-no'; desc='零轴下方死叉，主跌段信号。<b>严禁新开正T</b>，手里有仓倒T减。'; }
    else if (m.cross === 'dead'){           sig='零上死叉'; sc='s-wn'; desc='强势区死叉，大概率顶背离或强势回踩。正T止盈、转倒T减仓。'; }
    else if (m.bar > 0 && m.barUp){         sig='红柱放大'; sc='s-ok'; desc='多头动能增强，顺势持股做T。'; }
    else if (m.bar > 0){                    sig='红柱缩短'; sc='s-wn'; desc='冲高动能衰竭，警惕见顶。贴近止盈位时先兑现。'; }
    else if (m.bar < 0 && m.barUp){         sig='绿柱缩短'; sc='s-ok'; desc='空头动能减弱，可能酝酿底背离。低吸关注点。'; }
    else {                                  sig='绿柱放大'; sc='s-no'; desc='杀跌动能强化中，别伸手接飞刀。'; }
    out.push(card(sc==='s-ok'?'t-ok':sc==='s-no'?'t-no':'t-wn', 'MACD', sig, sc,
      `DIF ${f3(m.dif)} · DEA ${f3(m.dea)}`, desc));
  }
  // 3. 量能
  {
    const vr = +s.vr || 0;
    let sig, sc, desc;
    if (vr >= 2.5){ sig='放量明显'; sc='s-wn'; desc=`量比 ${f2(vr)}，多空剧烈换手。冲高无力时大概率假突破，按倒T对待。` ; }
    else if (vr >= 1.5){ sig='温和放量'; sc='s-ok'; desc=`量比 ${f2(vr)}，资金开始关注。放量突破关键位是最佳正T加分项。` ; }
    else if (vr >= 0.8){ sig='量能正常'; sc='s-nt'; desc=`量比 ${f2(vr)}，常态波动。按既定格位执行即可。` ; }
    else { sig='明显缩量'; sc='s-ok'; desc=`量比 ${f2(vr)}，抛压衰竭。回踩重要均线+缩量 = 经典低吸环境。` ; }
    out.push(card(sc==='s-ok'?'t-ok':'t-nt', '量比状态', sig, sc, f2(vr) + ' 倍', desc));
  }
  // 4. 分时量能
  out.push(vmCardHtml(s));
  return `<div class="ta-grid">${out.join('')}</div>`;
}

export function quoteFoldHTML(s){
  return `
    <div class="qfold-grid">
      <div class="qf-item"><span class="k">今开</span><span class="v">${f2(+s.open)}</span></div>
      <div class="qf-item"><span class="k">昨收</span><span class="v">${f2(+s.prevClose)}</span></div>
      <div class="qf-item"><span class="k">最高</span><span class="v">${f2(+s.high)}</span></div>
      <div class="qf-item"><span class="k">最低</span><span class="v">${f2(+s.low)}</span></div>
      <div class="qf-item"><span class="k">分时均价</span><span class="v">${f2(+s.avg)}</span></div>
      <div class="qf-item"><span class="k">量比</span><span class="v">${f2(+s.vr)}</span></div>
      <div class="qf-item"><span class="k">MA5</span><span class="v">${f2(+s.ma5)}</span></div>
      <div class="qf-item"><span class="k">MA10</span><span class="v">${f2(+s.ma10)}</span></div>
      <div class="qf-item"><span class="k">MA20</span><span class="v">${f2(+s.ma20)}</span></div>
    </div>
  `;
}

/* ===================== 主渲染函数 ===================== */
export function render(poolData){
  const targetPool = poolData || pool;
  const box = document.getElementById('pool');
  if (!box) return;

  if (!targetPool || !targetPool.length){
    box.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--mute);background:var(--card);border-radius:12px;border:1px dashed var(--line)">
      <h3>自选池是空的</h3>
      <p style="margin-top:8px">在顶部输入股票代码（如 605128）或名称，点击「+ 加入做T池」开始监控。</p>
    </div>`;
    return;
  }

  box.innerHTML = targetPool.map((s, i)=>{
    const c = calc(s);
    const cls = c.chg>=0 ? 'up' : 'down';
    const p = posCalc(s);
    s._ta = computeTA(s);
    const ta = s._ta;

    if (!s.p)   s.p = 'day';
    if (!s.ov)  s.ov = { ma:1, boll:1, box:1, cost:1, sr:0 };
    if (!s.sub) s.sub = 'macd';

    const rows = [
      [ 6, '禁止新开正T区', 'none'],
      [ 5, '强势区·只减',   'sell'],
      [ 4, '倒T第二减仓位', 'sell'],
      [ 3, '倒T第一减仓位', 'sell'],
      [ 2, '倒T观察位',     'none'],
      [ 1, '正T止盈上限',   'sell'],
      [ 0, '基准价(昨收/均)', 'base'],
      [-1, '第一支撑·可买',  'buy'],
      [-2, '第二支撑·加仓',  'buy'],
      [-3, '强支撑·最后防线','buy'],
      [-4, '跌破观望',      'none'],
      [-5, '破位·禁止抄底', 'none'],
      [-6, '空头陷阱',      'none']
    ];

    const stepRows = rows.map(([g, tag, act])=>{
      const basePx = +s.prevClose || +s.price;
      const px = basePx * (1 + g * GRID / 100);
      const isCur = Math.abs(c.grid - g) < 0.5;
      const actCls = act === 'buy' ? 'act-buy' : act === 'sell' ? 'act-sell' : '';
      return `<tr class="${isCur ? 'cur-step' : ''}">
        <td class="st-g">${g > 0 ? '+' + g : g}</td>
        <td class="st-p ${actCls}">${f2(px)}</td>
        <td class="st-pct">${pct(g * GRID)}</td>
        <td class="st-t ${actCls}">${tag}</td>
      </tr>`;
    }).join('');

    const cardModeBadges = {
      BUY : ['mode-buy',  '正T信号已出'],
      REV : ['mode-rev',  '倒T减仓窗口'],
      CUT : ['mode-cut',  '强势只减不加'],
      WAIT: ['mode-wait', '观望不伸手']
    };
    const curBadge = cardModeBadges[c.mode] || cardModeBadges.WAIT;

    return `
      <div class="card ${s.tier === 'long' ? 'c-tier-long' : ''}" id="stockCard_${i}" data-code="${s.code}">
        <div class="card-hd">
          <div class="ch-left">
            <span class="card-tier-tag ${s.tier==='long'?'ct-long':'ct-short'}">${TIER_LABEL[tierOf(s)]}</span>
            <h2 class="stock-title">${s.name}</h2>
            <span class="stock-code">${s.code}</span>
            <button class="btn-reason" onclick="window.openStockReasonModal('${s.code}')" title="查看入选逻辑与利空排查">
              📋 入选逻辑
            </button>
            <span class="mode-badge ${curBadge[0]}">${curBadge[1]}</span>
          </div>
          <div class="ch-right">
            <div class="ch-px ${cls}">${f2(+s.price)}</div>
            <div class="ch-chg ${cls}">${pct(c.chg)}</div>
            <button class="btn-sync-single" onclick="window.syncSingleStock(${i})" title="单独刷新这只票的行情与K线">⟳</button>
            <button class="btn-del-single" onclick="window.delSingleStock(${i})" title="从自选池移除">×</button>
          </div>
        </div>

        ${posBar(s, p, i)}

        <div class="sec-gate ${c.vcls}">
          <div class="sg-hd"><b>三闸门决策：${c.title}</b></div>
          <div class="sg-body">${c.detail}</div>
        </div>

        <div class="price-targets-grid">
          <div class="ptg-cell target-buy">
            <span class="ptg-k">建议正T买点 (跌至低吸)</span>
            <span class="ptg-v">${f2(c.inA)} ~ ${f2(c.inB)}</span>
            <span class="ptg-d">首仓 ${f2(c.inA)} ｜ 补仓 ${f2(c.inB)}</span>
          </div>
          <div class="ptg-cell target-sell">
            <span class="ptg-k">建议止盈目标 (冲高兑现)</span>
            <span class="ptg-v">${f2(c.tp1)} ~ ${f2(c.tp2)}</span>
            <span class="ptg-d">T1目标 ${f2(c.tp1)} ｜ 极限 ${f2(c.tp2)}</span>
          </div>
          <div class="ptg-cell target-stop">
            <span class="ptg-k">硬止损底线 (-1.5%)</span>
            <span class="ptg-v" style="color:var(--down)">${f2(c.slA)}</span>
            <span class="ptg-d">破此价无条件离场，保住本金</span>
          </div>
          <div class="ptg-cell target-rev">
            <span class="ptg-k">倒T卖出区 (无量滞涨减)</span>
            <span class="ptg-v">${f2(c.outA)} ~ ${f2(c.outB)}</span>
            <span class="ptg-d">卖出后在 ${f2(c.bkA)} 缩量接回</span>
          </div>
        </div>

        ${liveTradeBar(s, p, c, i)}

        <div class="chart-box">
          <div class="cb-toolbar">
            <div class="cbt-group">
              <button class="cbt-btn ${s.p==='day'?'cur':''}" onclick="window.changePeriod(${i}, 'day')">日K</button>
              <button class="cbt-btn ${s.p==='week'?'cur':''}" onclick="window.changePeriod(${i}, 'week')">周K</button>
              <button class="cbt-btn ${s.p==='m15'?'cur':''}" onclick="window.changePeriod(${i}, 'm15')">15分</button>
              <button class="cbt-btn ${s.p==='m5'?'cur':''}" onclick="window.changePeriod(${i}, 'm5')">5分</button>
              <button class="cbt-btn ${s.p==='rt'?'cur':''}" onclick="window.changePeriod(${i}, 'rt')">分时</button>
            </div>
            <div class="cbt-group">
              <button class="cbt-btn ${s.ov.ma?'cur':''}" onclick="window.toggleOverlay(${i}, 'ma')">均线</button>
              <button class="cbt-btn ${s.ov.boll?'cur':''}" onclick="window.toggleOverlay(${i}, 'boll')">布林</button>
              <button class="cbt-btn ${s.ov.box?'cur':''}" onclick="window.toggleOverlay(${i}, 'box')">箱体</button>
              <button class="cbt-btn ${s.ov.cost?'cur':''}" onclick="window.toggleOverlay(${i}, 'cost')">成本线</button>
            </div>
            <div class="cbt-group">
              <button class="cbt-btn ${s.sub==='macd'?'cur':''}" onclick="window.changeSub(${i}, 'macd')">MACD</button>
              <button class="cbt-btn ${s.sub==='rsi'?'cur':''}" onclick="window.changeSub(${i}, 'rsi')">RSI</button>
              <button class="cbt-btn ${s.sub==='kdj'?'cur':''}" onclick="window.changeSub(${i}, 'kdj')">KDJ</button>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas data-ki="${i}" style="width:100%;height:320px"></canvas>
          </div>
          <div class="chart-meta-bar" id="chartMeta_${i}">
            ${chartLegendHTML(s)}
          </div>
        </div>

        <details class="sec-fold">
          <summary>📊 技术面体检与日内成交量特征</summary>
          ${taCards(s, ta, c)}
        </details>

        <details class="sec-fold">
          <summary>🔬 估值分位 · 板块归属 · 相对强弱 (RS)</summary>
          ${researchBlock(s, i, targetPool)}
        </details>

        <details class="sec-fold">
          <summary>📋 七格箱体做T点位明细表</summary>
          <div class="tbl-scroll">
            <table class="grid-table">
              <thead><tr><th>格数</th><th>价格</th><th>距昨收</th><th>战术动作</th></tr></thead>
              <tbody>${stepRows}</tbody>
            </table>
          </div>
        </details>
      </div>
    `;
  }).join('');

  bindCardEvents();
  renderAllCharts();
  animCardsStagger('#pool');
}

/* ===================== 事件绑定与图表渲染 ===================== */
function bindCardEvents(){
  document.querySelectorAll('.pb-inp').forEach(inp => {
    inp.onchange = () => {
      const idx = +inp.dataset.i;
      const key = inp.dataset.k;
      const s = pool[idx];
      if (!s) return;
      const val = parseFloat(inp.value) || 0;
      s[key] = val;
      savePool();
      render(pool);
      if (window.renderAccount) window.renderAccount();
      toastOk(`已更新 ${s.name} 的 ${key === 'shares' ? '持仓股数' : key === 'cost' ? '持仓成本' : '可用现金'} 为 ${val}`);
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') inp.blur();
    };
  });
}

function renderAllCharts(){
  document.querySelectorAll('canvas[data-ki]').forEach(cv => {
    const idx = +cv.dataset.ki;
    const s = pool[idx];
    if (s) drawChart(cv, s);
  });
  document.querySelectorAll('canvas[data-rs]').forEach(cv => {
    const idx = +cv.dataset.rs;
    const s = pool[idx];
    if (s) {
      const rs = rsCalc(s);
      if (rs) drawRS(cv, rs);
    }
  });
}

/* ===================== 闪电记T Modal ===================== */
let _qtTarget = null;
export function openQuickTModal(opts){
  _qtTarget = opts;
  const s = pool[opts.idx];
  if (!s) return;
  const c = calc(s);
  const m = document.getElementById('quickTModal');
  if (!m) return;

  document.getElementById('qtStockName').innerHTML = `${s.name} <span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--sub)">(${s.code})</span>`;
  const dir = opts.dir || (c.mode === 'REV' || c.mode === 'CUT' ? '倒T' : '正T');
  setQtDir(dir);

  const buyInp = document.getElementById('qtBuy');
  const sellInp = document.getElementById('qtSell');
  if (dir === '正T'){
    buyInp.value = opts.price ? f2(opts.price) : f2(c.inA || +s.price);
    sellInp.value = f2(c.tp1 || (+buyInp.value * 1.03));
  } else {
    sellInp.value = opts.price ? f2(opts.price) : f2(c.outA || +s.price);
    buyInp.value = f2(c.bkA || (+sellInp.value * 0.97));
  }

  const qtyInp = document.getElementById('qtQty');
  const recQty = c.t1Lots || (c.tLots >= 100 ? 100 : 100);
  qtyInp.value = opts.qty || recQty;

  updateQtPreview();
  m.style.display = 'flex';
}

export function closeQuickTModal(){
  const m = document.getElementById('quickTModal');
  if (m) m.style.display = 'none';
  _qtTarget = null;
}

export function setQtDir(dir){
  document.querySelectorAll('.m-dir-btn').forEach(b => {
    b.classList.toggle('cur', b.dataset.dir === dir);
  });
}

export function updateQtPreview(){
  const rawBuy = parseFloat(document.getElementById('qtBuy').value) || 0;
  const rawSell = parseFloat(document.getElementById('qtSell').value) || 0;
  const qty = parseInt(document.getElementById('qtQty').value, 10) || 0;
  const grossEl = document.getElementById('qtGrossPL');
  const netEl = document.getElementById('qtNetPL');
  const retEl = document.getElementById('qtRatio');

  if (!rawBuy || !rawSell || !qty){
    if (grossEl) grossEl.textContent = '—';
    if (netEl) netEl.textContent = '—';
    if (retEl) retEl.textContent = '—';
    return;
  }

  const res = calcLiveTrade(rawBuy, rawSell, qty, (_qtTarget && pool[_qtTarget.idx]) ? pool[_qtTarget.idx].shares : 0);
  if (grossEl) grossEl.textContent = (res.sellAmt - res.buyAmt >= 0 ? '+' : '') + (res.sellAmt - res.buyAmt).toFixed(1);
  if (netEl) {
    netEl.textContent = (res.netProfit >= 0 ? '+' : '') + res.netProfit.toFixed(1);
    netEl.style.color = res.netProfit >= 0 ? 'var(--up)' : 'var(--down)';
  }
  if (retEl) retEl.textContent = (res.profitRatio >= 0 ? '+' : '') + res.profitRatio.toFixed(2) + '%';
}

export function execQuickT(){
  if (!_qtTarget) return;
  const s = pool[_qtTarget.idx];
  if (!s) return;

  const buy = parseFloat(document.getElementById('qtBuy').value) || 0;
  const sell = parseFloat(document.getElementById('qtSell').value) || 0;
  const qty = parseInt(document.getElementById('qtQty').value, 10) || 0;
  const activeDirBtn = document.querySelector('.m-dir-btn.cur');
  const dir = activeDirBtn ? activeDirBtn.dataset.dir : '正T';

  if (!buy || !sell || !qty){
    toastWarn('请把买价、卖价和股数填写完整');
    return;
  }

  const today = todayStr();
  const rec = {
    date: today,
    stock: s.name,
    dir,
    buy,
    sell,
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: '闪电记T记录'
  };

  LOG.push(rec);
  saveLog();

  const res = calcLiveTrade(buy, sell, qty, s.shares);
  if (s.shares > 0) {
    s.cost = res.newCost;
    savePool();
  }

  closeQuickTModal();
  if (window.renderLog) window.renderLog();
  render(pool);

  soundChime(880, 0.25);
  toastOk(`已记录 ${s.name} ${dir}：买 ${f2(buy)} ➔ 卖 ${f2(sell)}，净盈亏 ${res.netProfit >= 0 ? '+' : ''}${res.netProfit} 元！`);
}
