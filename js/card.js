/* ============================================================
   A股做T执行台 · 自选个股做T决策卡片与实时买卖模块 (card.js)
   ============================================================ */

import { f2, f3, pct, money, money$, money2, fmtIn, todayStr, toast, toastOk, toastWarn, toastErr, copyPlain, soundChime, GRID, STOP, FLY, FEE, VAL_WIN, TIER_LABEL, AUTO_FIELDS } from './utils.js';
import { pool, savePool, LOG, saveLog, tierOf, CUR, setCur, TIER, setTier, paintTierBar, stampData } from './state.js';
import { calc, computeTA, rsCalc, drawRS, loadStock, loadChart, loadDD, loadResearch, checkPriceAlerts } from './api.js';
import { drawChart, kbarHTML, chartLegendHTML, chartStat, PERIOD_LABEL, _hover, setHover, chartMeta } from './chart.js';
import { renderTopbar, applyCur, renderPoolTabs, openStockReasonModal } from './nav.js';
import { animCardsStagger, animPricePulse } from './anim.js';

export const MODE_BADGE = {
  BUY : ['buy',  '正T'],
  REV : ['rev',  '倒T'],
  CUT : ['cut',  '只减'],
  WAIT: ['wait', '观望']
};

export const AUTO_FIELD_LABELS = {
  prevClose: '昨收', open: '今开', high: '最高', low: '最低',
  price: '最新价', avg: '分时均价', vr: '量比',
  ma5: 'MA5', ma10: 'MA10', ma20: 'MA20'
};

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
    .filter(r => r.date === today && (r.stock === s.name || r.stock === s.code) && (r.dir === '正T' || r.dir === '买入建仓'))
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

  // 今日正T冻结与可卖底仓计算
  const today = todayStr();
  const todayTBuys = (typeof LOG !== 'undefined' ? LOG : [])
    .filter(r => r.date === today && (r.stock === s.name || r.stock === s.code) && (r.dir === '正T' || r.dir === '买入建仓'))
    .reduce((a, b) => a + (+b.qty || 0), 0);
  const availSell = Math.max(0, (s.shares || 0) - todayTBuys);

  const activeTab = s._tradeTab || 'sell';

  if (hasPos) {
    if (activeTab === 'buy') {
      // 持仓状态下的追加买入 / 加仓
      const defAddBuy = c.inA || curPx || +s.cost;
      return `
        <div class="live-trade-strip buy-strip" data-lts="${i}">
          <div class="lts-header">
            <div class="lts-tabs">
              <button type="button" class="lts-tab-btn" data-switch-tab="sell" data-i="${i}">⚡ 做T / 卖出记账</button>
              <button type="button" class="lts-tab-btn active" data-switch-tab="buy" data-i="${i}">➕ 追加买入 / 加仓</button>
            </div>
            <div class="lts-sub">当前持仓: <b>${s.shares}股</b> (成本 ¥${f2(s.cost)}) ｜ 追加买入将按加权平均法重新核算底仓成本</div>
          </div>
          <div class="lts-body">
            <div class="lts-item">
              <span class="lts-k">加仓买入价</span>
              <div class="lts-val-box">
                <span class="lts-unit">¥</span>
                <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defAddBuy)}" placeholder="买入价">
                <div class="lts-quick-pills">
                  <button type="button" class="lts-pill-btn" data-fill-buy="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                  ${c.inA ? `<button type="button" class="lts-pill-btn" data-fill-buy="${f2(c.inA)}" data-i="${i}" title="填入建议低吸买点">低吸 ${f2(c.inA)}</button>` : ''}
                </div>
              </div>
            </div>
            <div class="lts-item">
              <span class="lts-k">加仓股数</span>
              <div class="lts-val-box">
                <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${recQty}" style="width:78px">
                <span class="lts-unit-text">股</span>
                <div class="lts-quick-pills">
                  <button type="button" class="lts-pill-btn" data-fill-bqty="100" data-i="${i}">1手</button>
                  <button type="button" class="lts-pill-btn" data-fill-bqty="300" data-i="${i}">3手</button>
                  <button type="button" class="lts-pill-btn" data-fill-bqty="${recQty}" data-i="${i}">T仓(${recQty})</button>
                </div>
              </div>
            </div>
            <div class="lts-act">
              <button type="button" class="btn-lts-exec buy" data-exec-buy="${i}">🟢 确认追加买入</button>
            </div>
          </div>
        </div>
      `;
    }

    // 默认：持仓状态下的实时卖出及卖出价选项
    return `
      <div class="live-trade-strip sell-strip" data-lts="${i}">
        <div class="lts-header">
          <div class="lts-tabs">
            <button type="button" class="lts-tab-btn active" data-switch-tab="sell" data-i="${i}">⚡ 实时卖出记账</button>
            <button type="button" class="lts-tab-btn" data-switch-tab="buy" data-i="${i}">➕ 追加买入</button>
          </div>
          <div class="lts-sub">
            持仓买入成本: <b>¥${f2(s.cost)}</b> ｜ 持仓: <b>${s.shares}</b> 股 ｜ 可卖底仓: <b>${availSell}</b> 股
          </div>
        </div>
        <div class="lts-body">
          <div class="lts-item">
            <span class="lts-k">买入价(持仓)</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(s.cost)}" title="持仓成本买入价，可微调核算">
            </div>
          </div>
          <span class="lts-arrow">➔</span>
          <div class="lts-item">
            <span class="lts-k">卖出目标价</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-sell" id="ltbSell_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defaultSellPx)}" placeholder="卖出价">
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-sell="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                ${c.tp1 ? `<button type="button" class="lts-pill-btn" data-fill-sell="${f2(c.tp1)}" data-i="${i}" title="填入T1止盈目标价">T1 ${f2(c.tp1)}</button>` : ''}
                ${c.tp2 ? `<button type="button" class="lts-pill-btn" data-fill-sell="${f2(c.tp2)}" data-i="${i}" title="填入T2高抛目标价">T2 ${f2(c.tp2)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">卖出股数</span>
            <div class="lts-val-box">
              <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${recQty}" style="width:72px">
              <span class="lts-unit-text">股</span>
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-qty="100" data-i="${i}">1手</button>
                ${c.t1Lots && c.t1Lots !== 100 ? `<button type="button" class="lts-pill-btn" data-fill-qty="${c.t1Lots}" data-i="${i}">T仓${c.t1Lots}</button>` : ''}
                <button type="button" class="lts-pill-btn" data-fill-qty="${availSell}" data-i="${i}">全卖(${availSell})</button>
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">记账模式</span>
            <select class="lts-sel" id="ltbMode_${i}" data-lt-i="${i}">
              <option value="t">做T平仓（冲减成本，股数不变）</option>
              <option value="reduce">减仓出局（扣减股数，回笼资金）</option>
            </select>
          </div>
          <div class="lts-act">
            <button type="button" class="btn-lts-exec sell" data-exec-sell="${i}">🔴 确认卖出记账</button>
          </div>
        </div>
        <div class="lts-preview" id="ltbPrev_${i}"></div>
      </div>
    `;
  } else {
    // 尚未持仓：引导买入建仓，录入买入价后立即激活卖出选项
    const defBuy = c.inA || curPx || 10.0;
    return `
      <div class="live-trade-strip buy-strip empty-pos" data-lts="${i}">
        <div class="lts-header">
          <div class="lts-tabs">
            <span class="lts-badge buy">🟢 实时买入建仓</span>
          </div>
          <div class="lts-sub">设置买入建仓价与股数，确认买入后将实时记账并立即激活卖出及卖出价选项</div>
        </div>
        <div class="lts-body">
          <div class="lts-item">
            <span class="lts-k">买入建仓价</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defBuy)}" placeholder="买入价">
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-buy="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                ${c.inA ? `<button type="button" class="lts-pill-btn" data-fill-buy="${f2(c.inA)}" data-i="${i}" title="填入建议低吸买点">低吸 ${f2(c.inA)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">买入股数</span>
            <div class="lts-val-box">
              <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${c.t1Lots || 300}" style="width:78px">
              <span class="lts-unit-text">股</span>
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-bqty="100" data-i="${i}">1手</button>
                <button type="button" class="lts-pill-btn" data-fill-bqty="300" data-i="${i}">3手</button>
                <button type="button" class="lts-pill-btn" data-fill-bqty="500" data-i="${i}">5手</button>
              </div>
            </div>
          </div>
          <div class="lts-act">
            <button type="button" class="btn-lts-exec buy" data-exec-buy="${i}">🟢 确认买入记账</button>
          </div>
        </div>
      </div>
    `;
  }
}

export function updateLtbPreview(idx){
  const s = pool[idx];
  if (!s) return;
  const prevBox = document.getElementById(`ltbPrev_${idx}`);
  if (!prevBox) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const sellInp = document.getElementById(`ltbSell_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);
  const modeSel = document.getElementById(`ltbMode_${idx}`);

  if (!buyInp || !sellInp || !qtyInp) return;

  const buyPx = parseFloat(buyInp.value) || 0;
  const sellPx = parseFloat(sellInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;
  const mode = modeSel ? modeSel.value : 't';
  const totalShares = s.shares || 0;

  if (buyPx <= 0 || sellPx <= 0 || qty <= 0) {
    prevBox.innerHTML = '<span style="color:var(--mute)">请输入有效买卖价与股数以测算预估差价</span>';
    return;
  }

  const res = calcLiveTrade(buyPx, sellPx, qty, totalShares);
  const isUp = res.netProfit >= 0;
  const col = isUp ? 'var(--up)' : 'var(--down)';

  if (mode === 't') {
    prevBox.innerHTML = `
      <div class="lts-prev-content">
        <span class="lts-prev-tag">做T测算</span>
        <span>预估净差价: <b style="color:${col}">${isUp ? '+' : ''}${money2(res.netProfit)} 元</b> (${res.profitRatio >= 0 ? '+' : ''}${res.profitRatio}%)</span>
        <span class="lts-dot">·</span>
        <span>底仓降本: <b style="color:${col}">${res.costReduction >= 0 ? '−' : '+'}${Math.abs(res.costReduction)} 元/股</b></span>
        <span class="lts-dot">·</span>
        <span>做T后新成本: <b style="color:var(--text);font-family:ui-monospace,Consolas,monospace">¥${res.newCost}</b></span>
        <span class="lts-friction">(已扣佣金+印花税约 ¥${res.friction})</span>
      </div>
    `;
  } else {
    prevBox.innerHTML = `
      <div class="lts-prev-content">
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

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);

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
export function researchBlock(s, i, poolRef){
  const v = s._val, bd = s._bd, rs = rsCalc(s);
  const targetPool = poolRef || pool;

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
    (targetPool||[]).forEach((o,j)=>{ if (j===i || !o._bd) return;
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

/* ===================== 作战计划纯文本生成 ===================== */
export function planText(s){
  const c = calc(s);
  const L = [];
  L.push(`${s.name} ${s.code}　现价 ${f2(+s.price)}（${pct(c.chg)}）· 振幅 ${c.amp.toFixed(2)}% · ${c.grid.toFixed(1)}格`);
  L.push('  判定：' + c.title.replace(/<[^>]+>/g,''));
  if (c.mode === 'BUY'){
    L.push(`  正T买入区：${f2(c.inA)} / ${f2(c.inB)}`);
    L.push(`  止盈目标：${f2(c.tp1)} / ${f2(c.tp2)}`);
    L.push(`  止损：${f2(c.slA)} / ${f2(c.slB)}`);
  } else if (c.mode === 'REV' || c.mode === 'CUT'){
    L.push(`  倒T卖出区：${f2(c.outA)} ~ ${f2(c.outB)}`);
    L.push(`  倒T接回位：${f2(c.bkA)} / ${f2(c.bkB)}`);
    L.push(`  卖飞线：${f2(c.fly)}（放量突破即认卖飞，不接）`);
  } else {
    L.push('  今日观望，不挂单。');
  }
  L.push(`  T仓：${c.sh ? `${c.t} 股（30%）→ 实盘建议挂单 ${c.t1Lots} 股/份 (${c.t1Lots/100}手)` : '— 股（30%），每份 — 股'}`);
  return L.join('\n');
}

export function planTextAll(){
  const L = ['【今日做T作战计划】' + todayStr()];
  pool.forEach(s=>{ L.push(''); L.push(planText(s)); });
  L.push('');
  L.push('——');
  L.push('纪律：T仓浮亏 1.5% 无条件砍；14:57 前必须平掉，绝不隔夜。');
  L.push('本计划由本机做T执行台生成，仅供研究参考，不构成投资建议。');
  return L.join('\n');
}

/* ===================== 主渲染函数 ===================== */
export function render(poolData){
  const targetPool = poolData || pool;
  const box = document.getElementById('pool');
  if (!box) return;

  if (!targetPool || !targetPool.length){
    box.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--mute);background:var(--card);border-radius:12px;border:1px dashed var(--line)">
      <h3>自选池是空的</h3>
      <p style="margin-top:8px">在顶部输入股票代码（如 605128）或名称，点击「+ 添加」开始监控。</p>
    </div>`;
    return;
  }

  box.innerHTML = targetPool.map((s,i)=>{
    const c = calc(s);
    const cls = c.chg>=0 ? 'up' : 'down';
    const p = posCalc(s);
    s._ta = computeTA(s);
    const ta = s._ta;

    const VOL_STATE_TXT = { heavy:'显著超预期', above:'略超预期', normal:'符合预期', below:'不及预期', light:'明显缩量' };
    if (ta && ta.volProgress != null){
      c.gate3 = `量比 ${f2(c.vr)}　时段达成 <b>${(ta.volProgress*100).toFixed(0)}%</b>`
        + `（该时点应完成 ${(ta.volShare*100).toFixed(0)}%）→ ${VOL_STATE_TXT[ta.volState]}`;
    } else if (ta && ta.volProgress == null && ta.volRatio != null){
      const _m = (new Date()).getHours()*60 + (new Date()).getMinutes();
      c.gate3 = _m < 570
        ? `量比 ${f2(c.vr)}　时段达成 —（未开盘，量能口径尚未建立）`
        : `量比 ${f2(c.vr)}　时段达成 —（开盘不足 5 分钟，样本不够，不做量能判定）`;
    }

    const _vm = s._vm;
    const vmTag = (_vm && _vm.ok && _vm.state !== 'na' && _vm.r3 != null)
      ? `　│　分时量能 <b>${_vm.r3.toFixed(2)}×</b>（同时段常态）→ ${_vm.label}`
      : (_vm && _vm.err) ? `　│　分时量能 —（${_vm.err}）`
      : (_vm && _vm.ok)  ? `　│　分时量能 —（今日仅 ${_vm.nBars || 0} 根 5 分钟K，样本不足）`
      : '　│　分时量能 —（未取到）';
    if (c.gate3) c.gate3 += vmTag;

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
      [ 0, '基准·正T止盈位','buy' ],
      [-1, '浅回踩观察',    'none'],
      [-2, '正T第一买点',   'buy' ],
      [-3, '正T第二买点',   'buy' ],
      [-4, '深水区·需缩量企稳','none'],
      [-6, '破位·停止做T',  'none']
    ].map(([k,label,act])=>{
      const p = c.pc*(1+k*GRID/100);
      const pv = +s.price || 0;
      const isNow = pv ? Math.abs(pv-p) <= c.pc*GRID/800 : false;
      const dNow  = pv ? (p-pv)/pv*100 : null;
      const pill = act==='buy' ? '<span class="pill p-buy">买点</span>'
                 : act==='sell'? '<span class="pill p-sell">卖点</span>'
                 : '<span class="pill p-none">观察</span>';
      return `<tr class="${act==='buy'?'act-buy':act==='sell'?'act-sell':''}">
        <td style="color:var(--sub)">${k>0?'+':''}${(k*GRID).toFixed(2)}%</td>
        <td style="font-family:ui-monospace,Consolas,monospace;color:${act==='buy'?'var(--down)':act==='sell'?'var(--up)':'var(--text)'}">${f2(p)}</td>
        <td style="text-align:right;font-family:ui-monospace,Consolas,monospace;color:${dNow==null?'var(--sub)':(dNow>0?'var(--up)':(dNow<0?'var(--down)':'var(--text)'))}">${dNow==null?'—':(dNow>=0?'+':'')+dNow.toFixed(2)+'%'}</td>
        <td>${label}${isNow?' <b style="color:var(--info)">◀现价</b>':''}</td>
        <td style="text-align:right;white-space:nowrap">${pill}${(act==='buy'||act==='sell')?`<button class="pill-act" data-qt-row="${i}" data-dir="${act==='buy'?'正T':'倒T'}" data-p="${f2(p)}" title="以此档位价格 ${f2(p)} 快速记一笔做T">⚡ 记T</button>`:''}</td>
      </tr>`;
    }).join('');

    const pxNow = +s.price || 0;
    const gNow  = c.chg / GRID;
    const kLo   = Math.floor(gNow), kHi = kLo + 1;
    const pLo   = c.pc*(1+kLo*GRID/100), pHi = c.pc*(1+kHi*GRID/100);
    const dLo   = pxNow ? (pLo-pxNow)/pxNow*100 : null;
    const dHi   = pxNow ? (pHi-pxNow)/pxNow*100 : null;
    const nowLine = `<div class="nowline">现价 <b>${f2(pxNow)}</b>（<b class="${cls}">${pct(c.chg)}</b>）`
      + `　│　位于 <b>${kLo>0?'+':''}${(kLo*GRID).toFixed(2)}% → ${f2(pLo)}</b> 与 <b>${kHi>0?'+':''}${(kHi*GRID).toFixed(2)}% → ${f2(pHi)}</b> 两格之间`
      + (dLo!=null ? `　│　距下格 ${dLo>=0?'+':''}${dLo.toFixed(2)}%、距上格 ${dHi>=0?'+':''}${dHi.toFixed(2)}%` : '')
      + `</div>`;

    const levelsHTML = `<div class="levels">
            <div class="lv buy ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 买入区（先买后卖）</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.inA)}">⚡ 记买</button></div><div class="v">${f2(c.inA)} — ${f2(c.inB)}</div><div class="d">第一份 / 第二份挂单价</div></div>
            <div class="lv sell ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 止盈目标</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.tp1)}">⚡ 记止盈</button></div><div class="v">${f2(c.tp1)} / ${f2(c.tp2)}</div><div class="d">约 +${c.gain1.toFixed(1)}% ~ +${c.gain2.toFixed(1)}%</div></div>
            <div class="lv stop ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 止损（-1.5%）</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.slA)}">⚡ 记止损</button></div><div class="v">${f2(c.slA)} / ${f2(c.slB)}</div><div class="d">对应上面两个买点</div></div>
            <div class="lv sell ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>倒T 卖出区（先卖后买）</span><button class="pill-act" data-qt-row="${i}" data-dir="倒T" data-p="${f2(c.outA)}">⚡ 记卖</button></div><div class="v">${f2(c.outA)} — ${f2(c.outB)}</div><div class="d">无量冲高时减T仓</div></div>
            <div class="lv buy ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>倒T 接回位</span><button class="pill-act" data-qt-row="${i}" data-dir="倒T" data-p="${f2(c.bkA)}">⚡ 记接回</button></div><div class="v">${f2(c.bkA)} / ${f2(c.bkB)}</div><div class="d">回落缩量后再接</div></div>
            <div class="lv stop ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>卖飞线（不得追高）</span></div><div class="v">${f2(c.fly)}</div><div class="d">放量突破此价即认卖飞，不接</div></div>
          </div>`;

    const gatesHTML = `<div class="gates" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;font-size:12.5px;color:var(--sub);margin-bottom:12px">
            <div>闸门1 · 格位：${c.gate1}</div>
            <div>闸门3 · 量能：${c.gate3}</div>
            <div style="grid-column:1/-1">闸门2 · 趋势：${c.gate2}</div>
            <div style="grid-column:1/-1">闸门4 · 市场环境：${c.gate4}</div>
          </div>`;

    const tableHTML = `<div class="tbl-scroll"><table>
            <thead><tr><th>相对昨收</th><th>价格</th><th style="text-align:right">距现价</th><th>含义</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;

    let midHTML;
    if (c.mode === 'WAIT'){
      midHTML = gatesHTML
        + `<details class="plan-fold">
             <summary>⚠️ 今日不可执行 · 点击查看预案价格（仅供观察，不要挂单）</summary>
             <div class="pf-warn">系统判定为「观望」，下列价格是<b>预案</b>而非今日指令 —— 请勿照此挂单。</div>
             <div class="pf-bd">${levelsHTML}${nowLine}${tableHTML}</div>
           </details>`;
    } else {
      midHTML = levelsHTML + gatesHTML + nowLine + tableHTML;
    }

    const mbd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;
    const quoteFoldHTML = `
      <details class="quote-fold"${(s._qfo || (s.manual && Object.keys(s.manual).length))?' open':''}>
        <summary>⚙️ 行情参数与手工微调（10项指标已由行情接口自动同步${(s.manual && Object.keys(s.manual).length)?' · <b style="color:var(--warn-d)">● 含有手动修改项</b>':''} · 点击展开微调/压力推演）</summary>
        <div class="quote-bd">
          <div class="ig">
            ${AUTO_FIELDS.map(k=>{
              const lb = AUTO_FIELD_LABELS[k] || k;
              const man = !!(s.manual && s.manual[k]);
              return `<div class="fld"><label>${lb}${man?'<b class="man-dot" title="已手动修改：自动刷新不会覆盖这个值">●</b>':''}</label>`
                + `<input data-i="${i}" data-k="${k}" value="${fmtIn(s[k])}" class="${man?'man':''}"`
                + ` title="${man?'已手动修改，自动刷新不会覆盖；点表头「⟲ 恢复行情值」解除':''}"`
                + ` inputmode="decimal" step="0.01" enterkeyhint="next"></div>`;
            }).join('')}
          </div>
          <div class="quote-hint">
            <span>说明：行情接口每分钟会自动同步上述 10 项数据。若手动修改任意数字，该项将加黄锁定并即时重算决策，不受自动刷新影响。</span>
            ${(s.manual && Object.keys(s.manual).length)?`<button class="mini" data-clr="${i}" style="margin-left:auto">⟲ 恢复全部行情值</button>`:''}
          </div>
        </div>
      </details>
    `;

    return `
    <div class="card m-${mbd[0]}" id="stockCard_${i}" data-tier="${tierOf(s)}">
      <div class="card-hd">
        <span class="nm">${s.name}</span>
        <span class="cd">${s.code}</span>
        <span class="tier-tag t-${tierOf(s)}" data-tier-toggle="${i}" title="当前：${TIER_LABEL[tierOf(s)]}　点击切换成另一类">${TIER_LABEL[tierOf(s)]}</span>
        <span class="mg ${mbd[0]}">${mbd[1]}</span>
        <button class="mini primary" data-quickt="${i}" title="盘中做T快捷记一笔，自动计算差价并摊薄成本">⚡ 快捷记T</button>
        <button class="mini" data-reason="${i}" title="查看入选理由、量化支撑与重大利空排查">🔍 逻辑与利空</button>
        <button class="mini" data-ref="${i}">⟳ 取数</button>
        <button class="mini" data-plan="${i}">📋 计划</button>
        ${(s.manual && Object.keys(s.manual).length)?`<button class="mini" data-clr="${i}" title="解除手动标记，恢复由行情自动刷新">⟲ 恢复行情值</button>`:''}
        <button class="mini" data-del="${i}">移除</button>
        <div class="card-hd-snap">
          <span class="snap-px"><b class="${cls}">${f2(+s.price)}</b> <b class="${cls}">${pct(c.chg)}</b></span>
          <span class="snap-tag" title="日内振幅与折合格数">振幅 ${c.amp.toFixed(2)}% (${c.grid.toFixed(1)}格)</span>
          <span class="snap-tag" title="开盘至当前量比">量比 ${f2(c.vr)}</span>
          ${(ta&&ta.turnover)?`<span class="snap-tag">换手 ${ta.turnover.toFixed(2)}%</span>`:''}
          ${(ta&&ta.volProgress!=null)?`<span class="snap-tag vq vq-${ta.volState}" title="今日累计量 ÷（5日均量 × 该时点应完成 ${(ta.volShare*100).toFixed(0)}%），>120% 才算超预期">时段量能 ${(ta.volProgress*100).toFixed(0)}%</span>`:''}
          ${(s._dd&&s._dd.dd)?`<span class="snap-tag">主力 <b class="${s._dd.dd.main.net>=0?'up':'down'}">${s._dd.dd.main.net>=0?'+':''}${money$(s._dd.dd.main.net)}</b></span>`:''}
          <span class="snap-tag tag-trend">日线${c.trend}</span>
          ${s._t?`<span class="snap-time">更新于 ${s._t}${s._maOk===false?'(均线未同步)':''}</span>`:''}
        </div>
      </div>
      <div class="card-bd">
        ${posBar(s, p, i)}
        ${liveTradeBar(s, p, c, i)}
        <div class="verdict ${c.vcls}">
          <span class="dot"></span>
          <div class="txt">
            <b>${c.title}</b><br>
            <span style="color:var(--sub)">${c.detail}</span>
          </div>
        </div>
        ${midHTML}

        ${c.sellFlyTriggered ? `<div class="fly-melt-box">🚨 倒T卖飞熔断警报：现价 ${f2(+s.price)} 已突破倒T卖出位 ${f2(c.outA)} 达 +2.0%！出现卖飞现象！严禁盲目追高接回（极易买在天花板），严格等待缩量回踩或次日再寻接回点！</div>` : ''}
        <div class="pos-row">
          <span>持仓 <b>${c.sh||'—'}</b> 股 → 底仓 70% ≈ <b>${c.sh?c.base:'—'}</b> 股（不动）</span>
          <span>T仓 30% ≈ <b>${c.sh?c.t:'—'}</b> 股 → 实盘挂单 <b>${c.sh?(c.t1Lots ? c.t1Lots+' 股/份 ('+(c.t1Lots/100)+'手)' : '不足1手'):'—'}</b>${c.sh && c.tLots && c.t1!==c.t1Lots && c.t1Lots ? ` <span style="font-size:11px;color:var(--mute)">（理论 ${c.t1} 股，已按100股整手取整）</span>` : ''}</span>
          ${c.cap?`<span>可用现金 <b>${c.cap}</b> 元 → T仓预算约 <b>${Math.round(c.cap*0.3)}</b> 元</span>`:''}
        </div>
        ${c.sh > 0 && c.sh < 200 ? `<div class="pos-warn">⚠️ 当前持仓仅 ${c.sh} 股（不足 200 股）：按 A 股买入整百股规则，无法将底仓与 T 仓（至少需 1 手 100 股）隔离，做T极易误动底仓，建议持仓 ≥300 股再做T。</div>` : ''}
        ${c.bear?`<div class="pos-warn">⚠️ 满仓者注意：日线空头时不要用现金补仓，改用「底仓倒T法」—— 只卖出底仓的 30% 筹码做倒T，当日必须原数接回，底仓股数一股不变，只把成本往下推。</div>`:''}

        ${quoteFoldHTML}
      </div>

      <details class="chart-fold"${s._fo?' open':''}>
        <summary>⌄ 展开图表与技术细节（K线 / 副图 / 指标卡 / 估值·板块·强弱）</summary>
        <div class="kline-box">
          ${kbarHTML(i, s)}
          <canvas id="kln-${i}" data-ki="${i}"></canvas>
          ${chartLegendHTML(s)}
          ${chartStat(s)}
        </div>
        <div style="padding:0 14px 2px">
          ${taCards(s, ta, c)}
          ${researchBlock(s, i, targetPool)}
        </div>
      </details>
    </div>`;
  }).join('');

  // 相对强弱迷你图
  box.querySelectorAll('canvas[data-rs]').forEach(cv=>{
    const st = targetPool[+cv.dataset.rs];
    if (!st) return;
    const rs = rsCalc(st);
    if (rs) drawRS(cv, rs);
  });

  // 输入监听与防抖重算
  let _raf = 0;
  const applyInput = ()=>{
    _raf = 0;
    const active = document.activeElement;
    const sel = [active?.dataset?.i, active?.dataset?.k, active?.selectionStart];
    render(pool);
    if (sel[0] !== undefined){
      const el = document.querySelector(`input[data-i="${sel[0]}"][data-k="${sel[1]}"]`);
      if (el){ el.focus(); try{ el.setSelectionRange(sel[2],sel[2]); }catch(_){} }
    }
  };
  box.querySelectorAll('input[data-i][data-k]').forEach(inp=>{
    let composing = false;
    inp.addEventListener('compositionstart', ()=>{ composing = true; });
    const markManual = (i, k)=>{
      if (AUTO_FIELDS.indexOf(k) < 0) return;
      const st = pool[i];
      if (!st.manual) st.manual = {};
      st.manual[k] = 1;
    };
    inp.addEventListener('compositionend', e=>{
      composing = false;
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      pool[i][k] = e.target.value === '' ? '' : parseFloat(e.target.value);
      markManual(i, k);
      if (!_raf) _raf = requestAnimationFrame(applyInput);
    });
    inp.addEventListener('input', e=>{
      if (composing) return;
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      pool[i][k] = e.target.value === '' ? '' : parseFloat(e.target.value);
      markManual(i, k);
      if (!_raf) _raf = requestAnimationFrame(applyInput);
    });
    inp.addEventListener('change', ()=>{ savePool(); });
  });

  // 实时买卖记账输入与快捷按钮绑定
  box.querySelectorAll('.lts-inp, .lts-sel').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const idx = +e.target.dataset.ltI;
      updateLtbPreview(idx);
    });
    inp.addEventListener('change', e=>{
      const idx = +e.target.dataset.ltI;
      updateLtbPreview(idx);
    });
  });

  box.querySelectorAll('[data-fill-sell]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbSell_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillSell;
        updateLtbPreview(idx);
      }
    };
  });

  box.querySelectorAll('[data-fill-qty]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbQty_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillQty;
        updateLtbPreview(idx);
      }
    };
  });

  box.querySelectorAll('[data-fill-buy]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbBuy_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillBuy;
      }
    };
  });

  box.querySelectorAll('[data-fill-bqty]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbQty_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillBqty;
      }
    };
  });

  box.querySelectorAll('[data-switch-tab]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const tab = btn.dataset.switchTab;
      if (pool[idx]){
        pool[idx]._tradeTab = tab;
        render(pool);
      }
    };
  });

  box.querySelectorAll('[data-exec-sell]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.execSell;
      execLiveSell(idx);
    };
  });

  box.querySelectorAll('[data-exec-buy]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.execBuy;
      execLiveBuy(idx);
    };
  });

  // 刷新持仓条预估差价
  targetPool.forEach((_, idx) => {
    updateLtbPreview(idx);
  });

  // 复制计划
  box.querySelectorAll('button[data-plan]').forEach(b=>{
    b.onclick = ()=>{
      const s = pool[+b.dataset.plan];
      if (s) copyPlain(planText(s), s.name + ' 的作战计划已复制，可直接粘贴。');
    };
  });
  // 恢复行情值
  box.querySelectorAll('button[data-clr]').forEach(b=>{
    b.onclick = ()=>{
      const st = pool[+b.dataset.clr];
      if (!st) return;
      st.manual = {};
      savePool(); render(pool);
    };
  });
  // 池别切换
  box.querySelectorAll('[data-tier-toggle]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.tierToggle];
      if (!s) return;
      s.tier = tierOf(s) === 'short' ? 'long' : 'short';
      savePool();
      let backToAll = false;
      if (TIER !== 'all' && s.tier !== TIER){
        setTier('all');
        backToAll = true;
      }
      paintTierBar();
      render(pool);
      renderPoolTabs();
      toastOk(s.name + ' 已归入「' + TIER_LABEL[s.tier] + '」' + (backToAll ? '，已切回「全部」视图方便你看到它' : ''));
    };
  });
  paintTierBar();

  // 移除 / 取数
  box.querySelectorAll('button[data-del]').forEach(b=>{
    b.onclick = ()=>{ pool.splice(+b.dataset.del,1); render(pool); savePool(); };
  });
  box.querySelectorAll('button[data-ref]').forEach(b=>{
    b.onclick = async ()=>{
      const s = pool[+b.dataset.ref];
      b.textContent = '⟳ 取数中';
      try{
        await loadStock(s);
        s._k = {};
        s._vm = null;
        await loadChart(s, true);
        await loadResearch(s, true);
        if (s.ddOn){ try{ await loadDD(s, true); }catch(_){} }
        render(pool); savePool();
        stampData();
        checkPriceAlerts();
      }catch(e){ toastErr('取数失败：' + e.message); b.textContent = '⟳ 取数'; }
    };
  });

  // 周期切换
  box.querySelectorAll('[data-pd]').forEach(el=>{
    el.onclick = async ()=>{
      const s = pool[+el.dataset.pd], p = el.dataset.v;
      if (s.p === p) return;
      s.p = p;
      savePool();
      if (!(s._k && s._k[p])){ el.classList.add('ld'); el.textContent = PERIOD_LABEL[p] + '…'; }
      render(pool);
      try{ await loadChart(s, true); }
      catch(e){ if (s._k) delete s._k[p]; toastErr(PERIOD_LABEL[p] + ' 取数失败：' + e.message); }
      render(pool); savePool();
    };
  });
  // 叠加开关
  box.querySelectorAll('[data-ovl]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.ovl], k = el.dataset.v;
      s.ov = s.ov || {};
      s.ov[k] = s.ov[k] ? 0 : 1;
      render(pool); savePool();
    };
  });
  // 副图切换
  box.querySelectorAll('[data-sub]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.sub];
      s.sub = el.dataset.v;
      render(pool); savePool();
    };
  });
  // 大单资金
  box.querySelectorAll('[data-ddload]').forEach(el=>{
    el.onclick = async ()=>{
      const s = pool[+el.dataset.ddload];
      s.ddOn = 1;
      el.classList.add('ld'); el.textContent = '💰 取数中…';
      try{ await loadDD(s, true); }
      catch(e){ toastErr('大单数据获取失败：' + e.message); }
      render(pool); savePool();
    };
  });

  // 绘图与悬停十字光标
  box.querySelectorAll('canvas[data-ki]').forEach(cv=>{
    const i = +cv.dataset.ki;
    if (pool[i]) drawChart(cv, pool[i]);
    cv.addEventListener('mousemove', ev=>{
      const g = cv._geo; if (!g) return;
      const r = cv.getBoundingClientRect();
      const x = ev.clientX - r.left;
      let idx = g.kind === 'bar' ? Math.floor((x - g.PL)/g.bw)
                                 : Math.round((x - g.PL)/(g.innerW || 1)*(g.n - 1));
      if (!(idx >= 0 && idx < g.n)) idx = -1;
      if (_hover[cv.id] !== idx){ setHover(cv.id, idx); drawChart(cv, pool[i]); }
    });
    cv.addEventListener('mouseleave', ()=>{
      if (_hover[cv.id] != null){ setHover(cv.id, null); drawChart(cv, pool[i]); }
    });
  });

  // 折叠状态记忆
  box.querySelectorAll('details.quote-fold').forEach(d=>{
    const inp = d.querySelector('input[data-i]');
    const ci = inp ? +inp.dataset.i : -1;
    d.addEventListener('toggle', ()=>{
      if (ci >= 0 && pool[ci]) pool[ci]._qfo = d.open ? 1 : 0;
    });
  });
  box.querySelectorAll('button[data-quickt]').forEach(b => {
    b.onclick = () => openQuickTModal({ idx: +b.dataset.quickt });
  });
  box.querySelectorAll('button[data-reason]').forEach(b => {
    b.onclick = () => {
      const idx = +b.dataset.reason;
      const s = pool[idx];
      if (s) openStockReasonModal(s);
    };
  });
  box.querySelectorAll('button[data-qt-row]').forEach(b => {
    b.onclick = () => {
      openQuickTModal({
        idx: +b.dataset.qtRow,
        dir: b.dataset.dir,
        price: parseFloat(b.dataset.p)
      });
    };
  });

  box.querySelectorAll('details.chart-fold').forEach(d=>{
    const kc = d.querySelector('canvas[data-ki]');
    const ci = kc ? +kc.dataset.ki : -1;
    d.addEventListener('toggle', async ()=>{
      if (ci >= 0 && pool[ci]) pool[ci]._fo = d.open ? 1 : 0;
      if (!d.open) return;
      const st = (ci >= 0 && pool[ci]) ? pool[ci] : null;
      if (st){
        const p = st.p || 'day';
        if (!st._k || !st._k[p] || (st._k[p].kind === 'bar' && (!st._k[p].ks || !st._k[p].ks.length))){
          try { await loadChart(st, true); } catch(_) {}
        }
      }
      const updateCanvas = ()=>{
        d.querySelectorAll('canvas[data-ki]').forEach(cv=>{
          const s = pool[+cv.dataset.ki];
          if (s) drawChart(cv, s);
        });
        d.querySelectorAll('canvas[data-rs]').forEach(cv=>{
          const s = pool[+cv.dataset.rs];
          if (s){
            const rs = rsCalc(s);
            if (rs) drawRS(cv, rs);
          }
        });
        const metaEl = document.getElementById(`kmeta-${ci}`);
        if (metaEl && st) metaEl.innerHTML = chartMeta(st);
      };
      updateCanvas();
      requestAnimationFrame(updateCanvas);
    });
  });

  renderTopbar();
  applyCur();
  renderPoolTabs();
  if (window.renderCogStressIfChanged) window.renderCogStressIfChanged();
  if (window.renderAccount) window.renderAccount();
  animCardsStagger('#pool');
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
  const rawBuy = parseFloat(document.getElementById('qtBuy')?.value) || 0;
  const rawSell = parseFloat(document.getElementById('qtSell')?.value) || 0;
  const qty = parseInt(document.getElementById('qtQty')?.value, 10) || 0;
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
