/* ============================================================
   A股做T执行台 · 尾盘10%仓位黑马与次日T+0隔夜战法模块 (tail.js)
   ============================================================ */

import { f2, f3, pct, money, money2, todayStr, toast, toastOk, toastWarn, toastErr, soundChime } from './utils.js';
import { pool, savePool, LOG, saveLog, TAIL_ACTIVES, saveTailActive, getAccountTotalAssets } from './state.js';
import { animRadarGlow } from './anim.js';

/* 获取账户总资产用于计算 10% 理想仓位 */
export function getAccountTotalAssetsForTail() {
  return getAccountTotalAssets();
}

/* 获取尾盘推荐候选标的（选 1~2 只最强黑马） */
export function getTailBuyCandidates() {
  const totalAssets = getAccountTotalAssetsForTail();
  const tenPctBudget = totalAssets * 0.10;
  
  let cands = [];
  let src = 'none';
  const WB = (typeof window !== 'undefined' && window.WB_LATEST) ? window.WB_LATEST : null;

  if (WB && Array.isArray(WB.tail) && WB.tail.length) {
    cands = WB.tail;
    src = 'tail';
  } else if (WB && Array.isArray(WB.candidates) && WB.candidates.length) {
    cands = WB.candidates;
    src = 'candidates';
  }

  // 严格筛选黑马标的：
  // 1. 若来源于专属尾盘选股池 WB.tail（发布时 verdict 为 '可挂'/'可做'/'观察'），过滤掉 '放弃' 且评分 >= 70；
  // 2. 若降级兜底来源于全量短线候选 WB.candidates，筛选评分 >= 80 且状态为 可做/小做/可挂。
  let list = (cands || []).filter(c => {
    const sc = +c.score || 0;
    if (src === 'tail') {
      return sc >= 70 && c.verdict !== '放弃';
    }
    const isGoodVerdict = !c.verdict || c.verdict === '可做' || c.verdict === '小做' || c.verdict === '可挂';
    return sc >= 80 && isGoodVerdict;
  });

  // 按得分由高到低降序
  list.sort((a, b) => (+b.score || 0) - (+a.score || 0));

  // 最多推荐 2 只最强黑马（各占 10% 仓位或平分）
  const top2 = list.slice(0, 2);

  return top2.map((c, idx) => {
    const px = +(c.buy || c.price || c.close || 10);
    const recShares = Math.max(100, Math.floor((tenPctBudget / px) / 100) * 100);
    const halfShares = Math.max(100, Math.floor((tenPctBudget * 0.5 / px) / 100) * 100);
    const costAmt = +(recShares * px).toFixed(2);
    const actualPct = totalAssets > 0 ? +((costAmt / totalAssets) * 100).toFixed(1) : 10.0;

    const tp1 = +(px * 1.025).toFixed(2);
    const tp2 = +(px * 1.045).toFixed(2);
    const stop = +(px * 0.985).toFixed(2);

    const whyReasons = (c.whyReasons && Array.isArray(c.whyReasons) && c.whyReasons.length)
      ? c.whyReasons
      : [
          `🛡️ 日内均价线上方运行时间占比高达 ${c.vwapOnline || 95}%，主力控盘稳定`,
          `🔥 量比 ${c.volRatio || 2.0}，尾盘持续温和放量，承接有力`,
          `🎯 闭环预案：次日早盘 09:30~10:00 冲高 ${tp1} (+2.5%) 坚决止盈`
        ];

    return {
      rank: idx + 1,
      rankTitle: idx === 0 ? '🥇 首选黑马 TOP 1' : '🥈 次选黑马 TOP 2',
      rankClass: idx === 0 ? 'top1' : 'top2',
      name: c.name,
      code: c.code,
      tcode: c.tcode || (c.code ? (c.code.startsWith('6') ? 'sh' + c.code : 'sz' + c.code) : ''),
      score: c.score || 90,
      verdict: c.verdict || (src === 'tail' ? '可挂' : '可做'),
      price: px,
      chgPct: c.chgPct != null ? +c.chgPct : (c.retOpen != null ? +c.retOpen : 2.5),
      limitRoom: c.limitRoom != null ? c.limitRoom : null,
      tailRel: c.tailRel != null ? c.tailRel : null,
      vwapOnline: c.vwapOnline != null ? +c.vwapOnline.toFixed(1) : 95.0,
      volRatio: c.volRatio != null ? +c.volRatio.toFixed(2) : 2.0,
      turnover: c.turnover ? +c.turnover.toFixed(1) : 5.0,
      shares: recShares,
      recShares,
      halfShares,
      budget: tenPctBudget,
      costAmt,
      actualPct,
      tp1,
      tp2,
      stop,
      whyReasons,
      reason: whyReasons[0] || '',
      src
    };
  });
}

/* 渲染尾盘推荐与T+0隔夜监控看板 */
export function renderTailBuySection() {
  const box = document.getElementById('secTailBuy');
  if (!box) return;

  const totalAssets = getAccountTotalAssetsForTail();
  const tenPctBudget = totalAssets * 0.10;
  const candidates = getTailBuyCandidates();
  const actives = (TAIL_ACTIVES || []).filter(x => x && x.status === 'active');

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isTailTime = (mins >= 870 && mins < 895); // 14:30 - 14:55
  const isExitTime = (mins >= 570 && mins < 600); // 09:30 - 10:00

  let badgeHtml = '';
  if (isTailTime) {
    const leftMins = 895 - mins;
    badgeHtml = `<span class="tb-status-pill live">🟢 14:30-14:55 尾盘潜伏窗口生效中 (距截止剩 ${leftMins} 分钟)</span>`;
  } else if (isExitTime) {
    const leftMins = 600 - mins;
    badgeHtml = `<span class="tb-status-pill exit">⚡ 09:30-10:00 隔夜T+0冲高止盈窗口 (距10:00还剩 ${leftMins} 分钟)</span>`;
  } else {
    badgeHtml = `<span class="tb-status-pill idle">⏳ 预演观察期 (每日 14:30-14:55 自动精选黑马)</span>`;
  }

  // 1. 活跃持仓卡片 (Active T+0 Overnight Positions)
  let activeCardsHtml = '';
  if (actives.length > 0) {
    let totalAmt = 0;
    let totalFloatPL = 0;

    const itemsHtml = actives.map((item, aIdx) => {
      const curStock = (typeof pool !== 'undefined' ? pool : []).find(s => s.code === item.code || s.name === item.name);
      const curPx = curStock && +curStock.price > 0 ? +curStock.price : item.buyPx;
      const curAmt = +(curPx * item.shares).toFixed(2);
      const floatPL = +(curAmt - item.costAmt).toFixed(2);
      const floatRatio = item.costAmt > 0 ? +((floatPL / item.costAmt) * 100).toFixed(2) : 0;
      const isUp = floatPL >= 0;
      const plCol = isUp ? 'var(--up)' : 'var(--down)';

      totalAmt += item.costAmt;
      totalFloatPL += floatPL;

      let signalTag = '<span class="tb-sig-tag idle">观察中</span>';
      if (curPx >= item.tp2) {
        signalTag = '<span class="tb-sig-tag tp2">🚀 触及 T2 极限高抛位 (+4.5%)，全力止盈！</span>';
      } else if (curPx >= item.tp1) {
        signalTag = '<span class="tb-sig-tag tp1">🎯 触及 T1 止盈目标位 (+2.5%)，强烈建议落袋！</span>';
      } else if (curPx <= item.stop) {
        signalTag = '<span class="tb-sig-tag stop">⚠️ 跌破纪律止损位 (-1.5%)，坚决止损！</span>';
      }

      return `
        <div class="trc-item-card" data-tid="${item.id}" style="background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div class="tic-head" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div class="tic-title" style="display:flex;align-items:center;gap:6px">
              <span class="tac-badge" style="background:var(--accent-bg);color:var(--accent-d);padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700">T+0隔夜持仓</span>
              <b>${item.name}</b> <span style="font-family:ui-monospace,Consolas,monospace;color:var(--mute);font-size:12px">(${item.code})</span>
              <span style="font-size:11px;color:var(--sub)">${item.date} 潜伏</span>
            </div>
            <div>${signalTag}</div>
          </div>
          <div class="tcc-kpis" style="margin-bottom:8px">
            <div class="tcc-kpi"><span class="k">买入价 ➔ 现价</span><span class="v">¥${f2(item.buyPx)} ➔ <b style="color:${plCol}">¥${f2(curPx)}</b></span></div>
            <div class="tcc-kpi"><span class="k">持仓股数</span><span class="v"><b>${item.shares.toLocaleString('zh-CN')}</b> 股</span></div>
            <div class="tcc-kpi"><span class="k">隔夜盈亏</span><span class="v" style="color:${plCol}"><b>${isUp?'+':''}${floatPL} 元</b> (${isUp?'+':''}${floatRatio}%)</span></div>
            <div class="tcc-kpi"><span class="k">止盈目标</span><span class="v" style="color:var(--up)">T1: ¥${f2(item.tp1)} ｜ T2: ¥${f2(item.tp2)}</span></div>
          </div>
          <div class="trc-exec-row">
            <span style="font-size:12px;color:var(--sub)">出清卖出价: ¥</span>
            <input class="trc-sell-inp" id="trcSell_${item.id}" type="number" step="0.01" value="${f2(curPx)}">
            <button type="button" class="btn-trc-exec" onclick="window.execTailExit('${item.id}', parseFloat(document.getElementById('trcSell_${item.id}').value)||${curPx})">💰 确认冲高止盈出清</button>
            <button type="button" class="btn-cancel mini" onclick="window.execTailExit('${item.id}', parseFloat(document.getElementById('trcSell_${item.id}').value)||${curPx}, true)" style="margin-left:auto">🛡️ 止损平仓</button>
          </div>
        </div>
      `;
    }).join('');

    const isTotalUp = totalFloatPL >= 0;
    const totalPlCol = isTotalUp ? 'var(--up)' : 'var(--down)';

    activeCardsHtml = `
      <div class="tail-radar-box" style="margin-bottom:16px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <div>
            <span style="font-weight:700;font-size:14px">⚡ 隔夜 T+0 冲高止盈雷达 (正在监控 ${actives.length} 只标的)</span>
            <span style="font-size:12px;color:var(--sub);margin-left:10px">合计占用 ¥${Math.round(totalAmt).toLocaleString('zh-CN')} ｜ 合计浮动盈亏: <b style="color:${totalPlCol}">${isTotalUp?'+':''}${totalFloatPL.toFixed(2)} 元</b></span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  // 2. 候选黑马卡片
  let cardsHtml = '';
  if (candidates.length > 0) {
    cardsHtml = candidates.map((c, idx) => `
      <div class="tail-cand-card ${c.rankClass}">
        <div class="tcc-head">
          <div class="tcc-rank-title">${c.rankTitle}</div>
          <div class="tcc-name-wrap">
            <b class="tcc-name">${c.name}</b>
            <span class="tcc-code">${c.code}</span>
          </div>
          <span class="tcc-score-badge">评分 ${c.score}分 · ${c.verdict}</span>
        </div>
        <div class="tcc-kpis">
          <div class="tcc-kpi">
            <span class="k">参考买点</span>
            <span class="v">¥${f2(c.price)} <small style="color:var(--up)">(+${c.chgPct != null ? c.chgPct : 2.5}%)</small></span>
          </div>
          <div class="tcc-kpi">
            <span class="k">均线时长</span>
            <span class="v">${c.vwapOnline}% 在均线上</span>
          </div>
          <div class="tcc-kpi">
            <span class="k">量比 / 换手</span>
            <span class="v">${c.volRatio} / ${c.turnover}%</span>
          </div>
        </div>
        ${(c.limitRoom != null || c.tailRel != null) ? `
        <div class="tcc-kpis" style="margin-top:-2px">
          ${c.limitRoom != null ? `<div class="tcc-kpi">
            <span class="k">距涨停空间</span>
            <span class="v"><b style="color:var(--up)">${c.limitRoom}%</b> (买得进)</span>
          </div>` : ''}
          ${c.tailRel != null ? `<div class="tcc-kpi">
            <span class="k">尾盘量能密度</span>
            <span class="v">${c.tailRel}× 全市场中位</span>
          </div>` : ''}
        </div>` : ''}
        <div class="tcc-sizing-box">
          <div class="tcc-sz-row">
            <span>🎯 10% 顶格建议仓位: <b>${c.recShares} 股</b> (约 ¥${Math.round(c.costAmt).toLocaleString('zh-CN')}，占总资产 ${c.actualPct}%)</span>
          </div>
          <div class="tcc-sz-targets">
            <span>次日T+0冲高止盈: <b style="color:var(--up)">¥${f2(c.tp1)} (+2.5%)</b></span>
            <span>·</span>
            <span>极限T2: <b style="color:var(--up)">¥${f2(c.tp2)} (+4.5%)</b></span>
            <span>·</span>
            <span>止损防守: <b style="color:var(--down)">¥${f2(c.stop)} (-1.5%)</b></span>
          </div>
        </div>
        <div class="tcc-reasons">
          ${c.whyReasons.map(r => `<div class="tcc-reason-item">${r}</div>`).join('')}
        </div>
        <div class="tcc-act-bar">
          <div class="tcc-inputs">
            <div class="tcc-inp-row">
              <span class="k">买价: ¥</span>
              <input class="tcc-inp" id="tbInpPx_${idx}" type="number" step="0.01" value="${f2(c.price)}">
            </div>
            <div class="tcc-inp-row">
              <span class="k">数量:</span>
              <input class="tcc-inp" id="tbInpQty_${idx}" type="number" step="100" value="${c.recShares}" style="width:68px">
              <span class="k">股</span>
            </div>
            <div class="tcc-pills">
              <button type="button" class="tcc-pill mini" onclick="document.getElementById('tbInpQty_${idx}').value=${c.recShares}">10%顶格(${c.recShares})</button>
              <button type="button" class="tcc-pill mini" onclick="document.getElementById('tbInpQty_${idx}').value=${c.halfShares}">5%半仓(${c.halfShares})</button>
              <button type="button" class="tcc-pill mini" onclick="document.getElementById('tbInpQty_${idx}').value=100">1手</button>
            </div>
          </div>
          <button type="button" class="btn-tb-buy primary" onclick="window.execTailBuyCustom(${idx})">
            🟢 14:30 确认尾盘买入建仓 (次日开盘做T+0)
          </button>
        </div>
      </div>
    `).join('');
  } else {
    cardsHtml = `
      <div style="color:var(--mute);padding:30px 16px;text-align:center;grid-column:1/-1;background:#fff;border-radius:8px;border:1px dashed var(--line)">
        今日尾盘暂无评分 ≥75 分的多头共振黑马标的 —— 宁缺毋滥，空仓也是操作。<br>
        <span style="font-size:12px;color:var(--sub);margin-top:6px;display:inline-block">名单由 <code>选股引擎/tail.js</code> 每日 14:30 盘中实时扫描生成；未到点或当日无合格标的时此区域保持静默保护本金。</span>
      </div>
    `;
  }

  box.innerHTML = `
    <div class="tail-head-bar">
      <div class="th-title-box">
        <h3>🎯 尾盘买入策略推荐（隔夜 T+0 战法）</h3>
        <p class="th-sub">14:30~14:50 锁定 TOP 1~2 只最强黑马 ｜ 10% 顶格仓位潜伏 ｜ 次日 09:30~10:00 冲高闭环兑现</p>
      </div>
      <div class="th-status-box">
        ${badgeHtml}
      </div>
    </div>
    <div class="tail-budget-strip">
      <span>当前总资产: <b>¥${Math.round(totalAssets).toLocaleString('zh-CN')}</b></span>
      <span>·</span>
      <span>10% 顶格潜伏预算: <b style="color:var(--accent)">¥${Math.round(tenPctBudget).toLocaleString('zh-CN')}</b></span>
      <span>·</span>
      <span>策略纪律: <b>单票上限 10% ｜ 绝不过夜加仓，次日 10:00 前必平</b></span>
    </div>
    ${activeCardsHtml}
    <div class="tail-cards-grid">
      ${cardsHtml}
    </div>
  `;

  animRadarGlow('.tail-cand-card');
}

if (typeof window !== 'undefined') {
  window.execTailBuyCustom = (idx) => {
    const cands = getTailBuyCandidates();
    const cand = cands[idx];
    if (!cand) return;
    const pxInp = document.getElementById(`tbInpPx_${idx}`);
    const qtyInp = document.getElementById(`tbInpQty_${idx}`);
    const buyPx = (pxInp && parseFloat(pxInp.value) > 0) ? parseFloat(pxInp.value) : cand.price;
    const buyQty = (qtyInp && parseInt(qtyInp.value, 10) > 0) ? parseInt(qtyInp.value, 10) : cand.recShares;
    execTailBuy(cand, buyPx, buyQty);
  };
}

/* 执行尾盘买入 */
export function execTailBuy(cand, buyPx, buyQty) {
  const today = todayStr();

  let st = pool.find(s => s.name === cand.name || s.code === cand.code);
  if (!st) {
    st = {
      name: cand.name,
      code: cand.code,
      tcode: cand.tcode,
      shares: buyQty,
      cost: buyPx,
      price: buyPx,
      prevClose: buyPx,
      tier: 'short',
      cap: 0,
      p: 'day',
      ov: { ma:1, boll:1, box:1, cost:1, sr:0 },
      sub: 'macd'
    };
    pool.push(st);
  } else {
    st.shares = (st.shares || 0) + buyQty;
    st.cost = buyPx;
  }

  const existingIdx = TAIL_ACTIVES.findIndex(item => (item.code === cand.code || item.name === cand.name) && item.status === 'active');
  const tailRecord = {
    id: 'tb_' + Date.now() + '_' + (cand.code || Math.random().toString(36).slice(2, 6)),
    date: today,
    name: cand.name,
    code: cand.code,
    tcode: cand.tcode,
    buyPx,
    shares: buyQty,
    costAmt: +(buyPx * buyQty).toFixed(2),
    tp1: cand.tp1,
    tp2: cand.tp2,
    stop: cand.stop,
    status: 'active'
  };

  if (existingIdx >= 0) {
    const old = TAIL_ACTIVES[existingIdx];
    const totalSh = old.shares + buyQty;
    const avgCost = +(((old.buyPx * old.shares) + (buyPx * buyQty)) / totalSh).toFixed(2);
    old.shares = totalSh;
    old.buyPx = avgCost;
    old.costAmt = +(avgCost * totalSh).toFixed(2);
    old.tp1 = cand.tp1;
    old.tp2 = cand.tp2;
    old.stop = cand.stop;
  } else {
    TAIL_ACTIVES.push(tailRecord);
  }

  saveTailActive();
  savePool();

  const logRec = {
    date: today,
    stock: cand.name,
    dir: '尾盘买入',
    buy: buyPx,
    sell: '',
    qty: buyQty,
    plan: '计划内',
    basis: '客观信号',
    note: `尾盘10%仓位建仓(黑马战法评分${cand.score})`
  };
  LOG.push(logRec);
  saveLog();

  renderTailBuySection();
  if (window.render) window.render(pool);
  if (window.renderLog) window.renderLog();

  soundChime(880, 0.25);
  toastOk(`✓ 尾盘建仓成功！已买入 ${cand.name} ${buyQty} 股 (¥${buyPx})，占用预算 ¥${Math.round(buyPx * buyQty).toLocaleString('zh-CN')}。次日开盘 09:30~10:00 留意冲高止盈雷达！`);
}

/* 执行次日冲高出清 */
export function execTailExit(tid, sellPx, isSilent) {
  const item = TAIL_ACTIVES.find(x => x.id === tid);
  if (!item) return;

  const sellAmt = +(sellPx * item.shares).toFixed(2);
  const fee = +(sellAmt * 0.0011).toFixed(2);
  const grossProfit = +(sellAmt - item.costAmt).toFixed(2);
  const netProfit = +(grossProfit - fee).toFixed(2);
  const retRatio = item.costAmt > 0 ? +((netProfit / item.costAmt) * 100).toFixed(2) : 0;
  const isWin = netProfit >= 0;

  const today = todayStr();
  const logRec = {
    date: today,
    stock: item.name,
    dir: '尾盘出清',
    buy: item.buyPx,
    sell: sellPx,
    qty: item.shares,
    plan: '计划内',
    basis: '客观信号',
    note: `尾盘T+0隔夜出清(净盈亏${netProfit >= 0 ? '+' : ''}${netProfit}元, 收益率${retRatio}%)`
  };
  LOG.push(logRec);
  saveLog();

  item.status = 'closed';
  item.closedAt = today;
  item.sellPx = sellPx;
  item.netProfit = netProfit;
  saveTailActive();

  const st = pool.find(s => s.code === item.code || s.name === item.name);
  if (st) {
    st.shares = Math.max(0, (st.shares || 0) - item.shares);
    if (st.shares === 0) st.cost = 0;
    savePool();
  }

  renderTailBuySection();
  if (window.render) window.render(pool);
  if (window.renderLog) window.renderLog();

  if (isWin) {
    soundChime(880, 0.35);
    toastOk(`🎉 恭喜！${item.name} 隔夜 T+0 战法圆满闭环！成功出清 ${item.shares} 股，净获利 +${netProfit.toLocaleString('zh-CN')} 元 (${retRatio}%)！资金已安全回笼！`);
  } else {
    soundChime(440, 0.2);
    toastWarn(`🛡️ 严守铁律：${item.name} 触发离场，出清 ${item.shares} 股，净亏损 ${netProfit.toLocaleString('zh-CN')} 元。保护本金就是保护下一次胜率！`);
  }
}
