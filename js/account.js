/* ============================================================
   A股做T执行台 · 账户总览、收益曲线与战绩透视模块 (account.js)
   ============================================================ */

import { f2, f3, pct, money, money2, todayStr, toast, toastOk, toastWarn, toastErr, soundChime } from './utils.js';
import { pool, SNAP, saveSnap, getAccountTotalAssets, setAccountTotalAssets } from './state.js';
import { posCalc } from './card.js';
import { MKT, loadMarket } from './api.js';

/* 全局账户汇总计算 */
export function accountSummary(){
  let mkt=0, costAmt=0, floatPL=0, dayPL=0, tReal=0, poolCap=0, posN=0;
  (pool || []).forEach(s=>{
    const p = posCalc(s);
    if (p.sh > 0){
      mkt += p.mkt;
      costAmt += p.costAmt;
      floatPL += p.floatPL;
      if (p.dayPL !== null) dayPL += p.dayPL;
      posN++;
    }
    tReal += p.tReal;
    poolCap += p.cap;
  });

  const customTotal = getAccountTotalAssets();
  let total = 0;
  let cap = 0;

  if (customTotal > 0) {
    total = customTotal;
    cap = Math.max(0, total - mkt);
  } else {
    cap = poolCap;
    total = mkt + cap;
  }

  return {
    mkt, costAmt, floatPL, dayPL, tReal, cap, posN, total, customTotal,
    floatPct: costAmt ? floatPL/costAmt*100 : null,
    dayPct: (mkt-dayPL) ? dayPL/(mkt-dayPL)*100 : null,
    posRate: total > 0 ? (mkt/total*100) : 0
  };
}

/* ===================== 每日快照（收益曲线） ===================== */
export function takeSnapshot(){
  const a = accountSummary();
  if (!a.posN && a.total <= 0) return null;
  const today = todayStr();
  const rec = {
    date: today,
    mkt: Math.round(a.mkt),
    costAmt: Math.round(a.costAmt),
    floatPL: Math.round(a.floatPL),
    dayPL: Math.round(a.dayPL),
    tReal: Math.round(a.tReal),
    total: Math.round(a.total),
    posRate: +(a.posRate||0).toFixed(1)
  };
  const i = SNAP.findIndex(x=>x.date===today);
  if (i >= 0) SNAP[i] = rec; else SNAP.push(rec);
  SNAP.sort((x,y)=> x.date < y.date ? -1 : 1);
  saveSnap();
  return rec;
}

export function clearSnap(){
  if (!confirm('确定要清空全部历史收益快照数据吗？此操作无法撤销。')) return;
  SNAP.length = 0;
  saveSnap();
  renderAccount();
  toastOk('已清空收益快照记录');
}

/* ===================== 账户总览渲染 ===================== */
export function renderAccount(){
  const a = accountSummary();

  const tbTotal = document.getElementById('tbTotalVal');
  if (tbTotal) tbTotal.textContent = '¥' + Math.round(a.total).toLocaleString('zh-CN');
  const tbMkt = document.getElementById('tbMktVal');
  if (tbMkt) tbMkt.textContent = '¥' + Math.round(a.mkt).toLocaleString('zh-CN');
  const tbPos = document.getElementById('tbPosRate');
  if (tbPos) tbPos.textContent = (a.posRate ? a.posRate.toFixed(1) : '0.0') + '%';

  const el = document.getElementById('accBox');
  if (!el) return;

  const totalCardHtml = `
    <div class="ac ac-total-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="k">账户总本金资产 (可编辑)</span>
        <button type="button" class="btn-edit-total" id="btnFocusTotal" title="点击修改总资产" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--sub)">✏️ 修改</button>
      </div>
      <div style="display:flex;align-items:baseline;gap:4px;margin-top:4px">
        <span style="font-size:20px;font-weight:700;color:var(--accent)">¥</span>
        <input type="number" step="1000" class="inp-total-assets" id="inputTotalAssets" value="${Math.round(a.total)}" placeholder="输入账户总资金" style="width:100%;font-size:24px;font-weight:800;background:transparent;border:none;border-bottom:1px dashed var(--line);color:inherit;outline:none">
      </div>
      <span class="d">仓位占比: <b style="color:${a.posRate>70?'var(--up)':a.posRate<30?'var(--down)':'var(--text)'}">${a.posRate.toFixed(1)}%</b> · 可用现金 ¥${Math.round(a.cap).toLocaleString('zh-CN')}</span>
    </div>
  `;

  el.innerHTML = totalCardHtml + `
    <div class="ac"><span class="k">持仓总市值</span>
      <span class="v">${Math.round(a.mkt).toLocaleString('zh-CN')}</span>
      <span class="d">${a.posN} 只持仓 · 成本 ¥${Math.round(a.costAmt).toLocaleString('zh-CN')}</span></div>
    <div class="ac ${a.floatPL>=0?'up':'dn'}"><span class="k">持仓浮动盈亏</span>
      <span class="v">${money2(a.floatPL)}</span>
      <span class="d">${a.floatPct!==null?pct(a.floatPct):'—'}</span></div>
    <div class="ac ${a.dayPL>=0?'up':'dn'}"><span class="k">持仓当日盈亏</span>
      <span class="v">${money2(a.dayPL)}</span>
      <span class="d">${a.dayPct!==null?pct(a.dayPct):'—'} · 较昨收</span></div>
    <div class="ac hl"><span class="k">做T累计净收益</span>
      <span class="v">${money2(a.tReal)}</span>
      <span class="d">台账实盘记录汇总</span></div>
  `;

  bindTotalInput();
  renderEquity();
}

export function bindTotalInput(){
  const inp = document.getElementById('inputTotalAssets');
  const btn = document.getElementById('btnFocusTotal');
  if (btn && inp) {
    btn.onclick = () => { inp.focus(); inp.select && inp.select(); };
  }
  if (inp) {
    const applyVal = () => {
      const val = Math.max(0, +inp.value || 0);
      if (val > 0) {
        setAccountTotalAssets(val);
        toastOk('总资产已更新为 ¥' + val.toLocaleString('zh-CN'));
      } else {
        setAccountTotalAssets(0);
        toast('已恢复为根据持仓市值自动核算', 'info');
      }
      renderAccount();
    };
    inp.onchange = applyVal;
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') inp.blur();
    };
  }
}

/* ===================== 收益曲线 Canvas 渲染 ===================== */
export function renderEquity(){
  const cv = document.getElementById('equityCv');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 220;

  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);

  if (!SNAP || SNAP.length < 2) {
    ctx.fillStyle = '#888888';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('快照数据积累中（至少需要 2 天数据绘制净值曲线）', W / 2, H / 2);
    return;
  }

  const vals = SNAP.map(x => x.total || 0);
  const min = Math.min(...vals) * 0.98;
  const max = Math.max(...vals) * 1.02;
  const range = max - min || 1;

  const padL = 60, padR = 20, padT = 20, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // 坐标网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    const v = max - (range / 4) * i;
    ctx.fillStyle = '#888888';
    ctx.font = '10px ui-monospace,Consolas,monospace';
    ctx.textAlign = 'right';
    ctx.fillText('¥' + Math.round(v).toLocaleString('zh-CN'), padL - 8, y + 3);
  }
  ctx.stroke();

  // 折线
  ctx.beginPath();
  SNAP.forEach((pt, idx) => {
    const x = padL + (plotW / (SNAP.length - 1)) * idx;
    const y = padT + plotH - ((pt.total - min) / range) * plotH;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = '#e53935';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 面积渐变
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.lineTo(padL, padT + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(229,57,53,0.25)');
  grad.addColorStop(1, 'rgba(229,57,53,0.0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // 日期刻度
  ctx.fillStyle = '#888888';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(SNAP[0].date, padL, H - 10);
  ctx.fillText(SNAP[SNAP.length - 1].date, W - padR, H - 10);
}

/* ===================== 市场环境面板 ===================== */
export function renderMarket(){
  const box = document.getElementById('mktBox');
  if (!box) return;
  if (!MKT){
    box.innerHTML = `<div class="gap-note">正在获取大盘指数与市场环境数据…</div>`;
    return;
  }
  const g = MKT.gate;
  const cards = (MKT.idx || []).map(o=>{
    const cls = o.chg>=0 ? 'up' : 'dn';
    return `<div class="mk ${cls}">
      <div class="k"><span>${o.label}</span><span>${o.amp?o.amp.toFixed(2)+'% 振幅':''}</span></div>
      <div class="v">${f2(o.price)}</div>
      <div class="d">${pct(o.chg)} · 成交 ${o.amt?(o.amt/10000).toFixed(0)+'亿':'—'}</div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="mkt">${cards}
      <div class="mk"><div class="k"><span>两市成交额</span></div>
        <div class="v">${MKT.amtTotal?(MKT.amtTotal/10000).toFixed(2)+'万亿':'—'}</div>
        <div class="d">沪 + 深 · 实时</div></div>
      <div class="mk"><div class="k"><span>指数位置</span></div>
        <div class="v" style="font-size:15px">${g.pos20!=null?g.pos20.toFixed(0)+'%':'—'}</div>
        <div class="d">上证在近20日区间的位置</div></div>
      <div class="mk"><div class="k"><span>量能倍数</span></div>
        <div class="v" style="font-size:15px">${g.volRatio!=null?g.volRatio.toFixed(2)+'×':'—'}</div>
        <div class="d">较20日均量（按U型分布折算）</div></div>
    </div>
    <div class="gate4 ${g.cls}"><span class="dt"></span><div>
      <div class="tt">第四条闸门 · 市场环境：${g.title}</div>
      <div class="dd">${g.detail}</div>
    </div></div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
      <button class="mini" id="mktRefresh" onclick="window.refreshMarketEnv()">⟳ 刷新市场环境</button>
      <span style="font-size:11.5px;color:var(--mute)">更新于 ${new Date(MKT.at).toLocaleTimeString('zh-CN',{hour12:false})}</span>
    </div>`;
}

/* ===================== 战绩透视与红色生命周期跟踪看板 ===================== */
export function renderPerfTable(){
  const D = window.WB_LATEST;
  if (!D || !D.perf) return;
  const perf = D.perf;

  const redTracker = perf.redTracker || {};
  const rSummary = redTracker.summary || {};
  const rAll = redTracker.all || [];
  const rActive = redTracker.active || [];
  const rArchived = redTracker.archived || [];

  const redKpisEl = document.getElementById('redKpis');
  if (redKpisEl) {
    redKpisEl.innerHTML = `
      <div class="rk-card">
        <div class="rk-k">高分精锐建档</div>
        <div class="rk-v">${rSummary.totalCount || rAll.length || 0}<small style="font-size:11px;font-weight:400;color:var(--mute)"> 只</small></div>
        <div class="rk-s">活跃跟踪 ${rSummary.activeCount || rActive.length} ｜ 结案归档 ${rSummary.archivedCount || rArchived.length}</div>
      </div>
      <div class="rk-card">
        <div class="rk-k">做T脉冲达成率 (≥+2%)</div>
        <div class="rk-v" style="color:${(rSummary.surgeAchievedRate || 0) >= 80 ? 'var(--up)' : 'var(--warn)'}">${rSummary.surgeAchievedRate || 0}%</div>
        <div class="rk-s">窗口内出现 ≥+2% 做T安全垫比例</div>
      </div>
      <div class="rk-card">
        <div class="rk-k">次日黄金冲高胜率 (T+1)</div>
        <div class="rk-v" style="color:${(rSummary.t1WinRate || 0) >= 70 ? 'var(--up)' : 'var(--warn)'}">${rSummary.t1WinRate || 0}%</div>
        <div class="rk-s">次日平均冲高幅度 +${rSummary.avgT1SurgeGain || '0.00'}%</div>
      </div>
      <div class="rk-card">
        <div class="rk-k">生命周期平均最大空间</div>
        <div class="rk-v" style="color:var(--up)">+${rSummary.avgMaxSurgeGain || '0.00'}%</div>
        <div class="rk-s">短线波段期间理论最高获利点</div>
      </div>
    `;
  }

  const cntRAct = document.getElementById('cntRedActive');
  if (cntRAct) cntRAct.textContent = rActive.length;
  const cntRArch = document.getElementById('cntRedArchived');
  if (cntRArch) cntRArch.textContent = rArchived.length;
  const cntRAll = document.getElementById('cntRedAll');
  if (cntRAll) cntRAll.textContent = rAll.length;

  renderRedTrajectory();
}

let _curRTab = 'active';
export function setRedTab(tab){
  _curRTab = tab;
  document.querySelectorAll('.red-tab-btn').forEach(b => {
    b.classList.toggle('cur', b.dataset.tab === tab);
  });
  renderRedTrajectory();
}

export function renderRedTrajectory() {
  const D = window.WB_LATEST;
  if (!D || !D.perf || !D.perf.redTracker) return;
  const redTracker = D.perf.redTracker;
  const list = _curRTab === 'active' ? redTracker.active : _curRTab === 'archived' ? redTracker.archived : redTracker.all;
  const box = document.getElementById('redTrajectoryBox');
  if (!box) return;

  if (!list || !list.length) {
    box.innerHTML = `<div class="mute" style="padding:16px;text-align:center;background:var(--surface);border-radius:8px;border:1px dashed var(--line)">
      暂无此分类下的高分红色标的追踪记录
    </div>`;
    return;
  }

  box.innerHTML = list.map((item, i) => {
    const isArch = item.status === 'archived';
    const traj = item.trajectory || [];

    const stepsHtml = traj.map((t, idx) => {
      const isMax = (t.maxHighGain === item.maxSurgeGain && item.maxSurgeGain > 0);
      const isT1 = (idx === 1);
      const badgeText = isMax ? '🔥最高点' : (isT1 && t.maxHighGain >= 1.5 ? '🎯黄金T' : '');
      return `
        <div class="r-step ${t.closeReturn >= 0 ? 'up' : 'dn'}">
          <div class="rs-tag">${t.label} (${t.date ? t.date.slice(5) : ''})</div>
          <div class="rs-ret">收盘 ${pct(t.closeReturn)}</div>
          <div class="rs-high ${isMax ? 'highlight' : ''}">高 ${pct(t.maxHighGain)}${badgeText ? ' ' + badgeText : ''}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="red-item-card ${isArch ? 'archived' : ''}">
        <div class="ri-hd">
          <div class="ri-title">
            <b>${item.name}</b> <span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mute)">(${item.code})</span>
            <span class="ri-badge ${item.score >= 90 ? 'super' : ''}">${item.score}分</span>
            ${isArch ? '<span class="ri-badge-arch">已结案归档</span>' : '<span class="ri-badge-live">活跃跟踪中</span>'}
          </div>
          <div class="ri-right">
            <span>入选基准价: ¥${f2(item.entryPrice)}</span>
            <span class="ri-max-surge">最大做T空间: <b style="color:var(--up)">+${f2(item.maxSurgeGain)}%</b></span>
          </div>
        </div>
        <div class="r-timeline">${stepsHtml}</div>
      </div>
    `;
  }).join('');
}
