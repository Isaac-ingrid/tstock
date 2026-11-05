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
  const WB = window.WB_LATEST;

  if (typeof WB !== 'undefined' && WB && Array.isArray(WB.tail) && WB.tail.length) {
    cands = WB.tail;
    src = 'tail';
  } else if (typeof WB !== 'undefined' && WB && Array.isArray(WB.candidates)) {
    cands = WB.candidates;
    src = 'candidates';
  }

  // 严格筛选评分 >= 85 且状态可做/小做的黑马标的
  let list = (cands || []).filter(c => {
    const sc = +c.score || 0;
    const isGoodVerdict = !c.verdict || c.verdict === '可做' || c.verdict === '小做';
    return sc >= 85 && isGoodVerdict;
  });

  // 按得分由高到低降序
  list.sort((a, b) => (+b.score || 0) - (+a.score || 0));

  // 最多推荐 2 只最强黑马（各占 10% 仓位或平分）
  const top2 = list.slice(0, 2);

  return top2.map((c, idx) => {
    const px = +c.buy || +c.price || +c.close || 10;
    const rawShares = Math.floor(tenPctBudget / px);
    const shares = Math.max(100, Math.floor(rawShares / 100) * 100);
    const costAmt = +(px * shares).toFixed(2);

    const tp1 = +(px * 1.025).toFixed(2);
    const tp2 = +(px * 1.045).toFixed(2);
    const stop = +(px * 0.985).toFixed(2);

    return {
      rank: idx + 1,
      name: c.name,
      code: c.code,
      tcode: c.tcode || (c.code ? (c.code.startsWith('6') ? 'sh' + c.code : 'sz' + c.code) : ''),
      score: c.score || 90,
      verdict: c.verdict || '可做',
      price: px,
      shares,
      budget: tenPctBudget,
      costAmt,
      tp1,
      tp2,
      stop,
      reason: c.reason || c.detail || '均线多头排列 + 尾盘主力资金抢筹，次日开盘极具做T脉冲冲高动能',
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

  // 1. 活跃持仓卡片 (Active T+0 Overnight Positions)
  let activeCardsHtml = '';
  if (actives.length > 0) {
    activeCardsHtml = actives.map((item, idx) => {
      const curStock = (typeof pool !== 'undefined' ? pool : []).find(s => s.code === item.code || s.name === item.name);
      const curPx = curStock && +curStock.price > 0 ? +curStock.price : item.buyPx;
      const curAmt = +(curPx * item.shares).toFixed(2);
      const floatPL = +(curAmt - item.costAmt).toFixed(2);
      const floatPct = item.buyPx > 0 ? +((curPx - item.buyPx) / item.buyPx * 100).toFixed(2) : 0;
      const isUp = floatPL >= 0;
      const plCol = isUp ? 'var(--up)' : 'var(--down)';

      const isReachTp1 = curPx >= item.tp1;
      const isReachTp2 = curPx >= item.tp2;
      const isReachStop = curPx <= item.stop;

      let radarStatus = '⏳ 次日开盘持筹待涨';
      let radarCls = 'radar-wait';
      if (isReachTp2) {
        radarStatus = '🔥 冲刺极限目标 (+4.5%)！半小时内果断出清';
        radarCls = 'radar-surge';
      } else if (isReachTp1) {
        radarStatus = '🎯 到达黄金止盈点 (+2.5%)！建议止盈T+0';
        radarCls = 'radar-tp';
      } else if (isReachStop) {
        radarStatus = '🚨 触及保命止损线 (-1.5%)！毫不留恋止损';
        radarCls = 'radar-stop';
      }

      return `
        <div class="tb-active-card ${radarCls}" id="tbActiveCard_${item.id}">
          <div class="tac-hd">
            <div class="tac-title">
              <span class="tac-badge">T+0隔夜持仓</span>
              <b>${item.name}</b> <span class="tac-code">(${item.code})</span>
              <span class="tac-date">入选日期: ${item.date}</span>
            </div>
            <div class="tac-pl">
              <span>持仓盈亏: </span>
              <b style="color:${plCol};font-size:16px">${isUp ? '+' : ''}${floatPL} 元 (${isUp ? '+' : ''}${floatPct}%)</b>
            </div>
          </div>

          <div class="tac-body">
            <div class="tac-col">
              <span class="tac-k">买入建仓价</span>
              <span class="tac-v">¥${f2(item.buyPx)}</span>
            </div>
            <div class="tac-col">
              <span class="tac-k">最新现价</span>
              <span class="tac-v" style="color:${plCol}">¥${f2(curPx)}</span>
            </div>
            <div class="tac-col">
              <span class="tac-k">持仓股数</span>
              <span class="tac-v">${item.shares.toLocaleString('zh-CN')} 股</span>
            </div>
            <div class="tac-col">
              <span class="tac-k">占用仓位 (总资产 ${(item.costAmt / totalAssets * 100).toFixed(1)}%)</span>
              <span class="tac-v">¥${Math.round(item.costAmt).toLocaleString('zh-CN')}</span>
            </div>
          </div>

          <div class="tac-radar">
            <div class="radar-status-bar ${radarCls}">
              <span class="radar-dot"></span>
              <span>${radarStatus}</span>
            </div>
            <div class="radar-targets">
              <span>🎯 目标一 (T+0): <b>¥${f2(item.tp1)} (+2.5%)</b></span>
              <span>🔥 极限目标: <b>¥${f2(item.tp2)} (+4.5%)</b></span>
              <span>🛡️ 硬止损: <b style="color:var(--down)">¥${f2(item.stop)} (-1.5%)</b></span>
            </div>
          </div>

          <div class="tac-actions">
            <button type="button" class="btn-tb-exit ${isReachTp1 ? 'btn-tb-tp' : ''}" onclick="window.execTailExit('${item.id}', ${curPx})">
              💰 次日开盘冲高止盈 (一键出清完成T+0)
            </button>
            <button type="button" class="btn-tb-stop" onclick="window.execTailExit('${item.id}', ${curPx}, true)">
              🛡️ 保本/止损平仓
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 2. 今日尾盘推荐卡片 (Today's Top 1~2 Tail Candidates)
  let candsHtml = '';
  if (candidates.length > 0) {
    candsHtml = candidates.map(c => `
      <div class="tb-cand-card">
        <div class="tcc-hd">
          <div class="tcc-title">
            <span class="tcc-rank">TOP ${c.rank} 黑马</span>
            <b>${c.name}</b> <span class="tcc-code">(${c.code})</span>
            <span class="tcc-score">${c.score} 分 · ${c.verdict}</span>
          </div>
          <div class="tcc-px">
            <span>尾盘参考买点: </span>
            <b class="tcc-px-val">¥${f2(c.price)}</b>
          </div>
        </div>

        <div class="tcc-meta">
          <div class="tcc-m-item">
            <span class="k">理想 10% 仓位预算</span>
            <span class="v">¥${Math.round(tenPctBudget).toLocaleString('zh-CN')}</span>
          </div>
          <div class="tcc-m-item">
            <span class="k">建议尾盘建仓手数</span>
            <span class="v"><b>${c.shares}</b> 股 (${c.shares/100}手 · 约 ¥${Math.round(c.costAmt).toLocaleString('zh-CN')})</span>
          </div>
          <div class="tcc-m-item">
            <span class="k">次日T+0冲高止盈位</span>
            <span class="v" style="color:var(--up)">¥${f2(c.tp1)} (+2.5%) ~ ¥${f2(c.tp2)} (+4.5%)</span>
          </div>
          <div class="tcc-m-item">
            <span class="k">防守硬止损位</span>
            <span class="v" style="color:var(--down)">¥${f2(c.stop)} (-1.5%)</span>
          </div>
        </div>

        <div class="tcc-reason">
          <span class="tcc-r-tag">战法要点</span>
          <span>${c.reason}</span>
        </div>

        <div class="tcc-action">
          <button type="button" class="btn-tb-buy" onclick="window.execTailBuyProxy(${c.rank - 1})">
            ⚡ 14:45 确认尾盘买入 10% 仓位 (次日开盘做T+0)
          </button>
        </div>
      </div>
    `).join('');
  } else {
    candsHtml = `
      <div class="tb-empty">
        <p>今日暂无符合严格尾盘黑马战法条件（≥85分多头共振）的标的，不盲目建仓，耐心等待确定性信号。</p>
      </div>
    `;
  }

  box.innerHTML = `
    <div class="tb-header">
      <div class="tb-h-title">
        <span class="tb-icon">⚡</span>
        <h2>尾盘 10% 仓位黑马推荐与隔夜 T+0 战法</h2>
        <span class="tb-badge">精准狙击 · 次日冲高出清</span>
      </div>
      <div class="tb-rule-summary">
        <span>战法铁律：14:45尾盘选 1~2 只最强黑马买入 <b>10% 理想仓位</b>，次日开盘半小时内冲高 <b>+2.5%~+4.5%</b> 一键出清，做成跨日 T+0 差价复利！</span>
      </div>
    </div>

    ${actives.length > 0 ? `
      <div class="tb-section-block">
        <h3 class="tb-sub-title">🔴 正在进行的隔夜 T+0 监控雷达 (已有 ${actives.length} 只标的持仓待出)</h3>
        <div class="tb-active-list">${activeCardsHtml}</div>
      </div>
    ` : ''}

    <div class="tb-section-block">
      <h3 class="tb-sub-title">🎯 今日尾盘推荐精选 (理想预算 ¥${Math.round(tenPctBudget).toLocaleString('zh-CN')} / 标的)</h3>
      <div class="tb-cand-list">${candsHtml}</div>
    </div>
  `;

  animRadarGlow('.tb-active-card');
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
