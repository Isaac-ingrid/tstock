/* ============================================================
   A股做T执行台 · Canvas 多周期手绘图表引擎 (chart.js)
   ============================================================ */

import { f2, f3, pct, money, fvol } from './utils.js';
import { maArr, bollArr, rsiArr, macdArr } from './api.js';
import { pool } from './state.js';

/* ===================== 图表引擎（Canvas 手绘，零依赖 · 多周期） =====================
   周期：分时 / 1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K
   叠加：MA5/10/20/60、BOLL(20,2)、20日箱体、持仓成本、支撑压力位
   副图：成交量常显 + MACD / RSI 可切换
   配色遵循 A 股惯例：涨红跌绿。悬停显示该根的时间、OHLC 与各指标取值。 */
/* 图表配色：与 CSS 变量同源。涨红跌绿、线色对比度 ≥3:1（非文本标准），
   文字类（txt/mute）按 ≥4.5 取。注意 Canvas 读不到 CSS 变量，必须在这里同步改。 */
export const CH = { up:'#d32f2f', dn:'#0a7f42', grid:'#eef1f4', txt:'#515c69', mute:'#66707c',
             /* 均线 4 色：蓝 221° / 玫红 336° / 青 192° / 金 35° —— 两两色相 ≥35°，
                原来 MA10/均价/BOLL中轨/箱体/MA60 五条线全挤在 21°–46° 的橙黄区，图上一片橙。 */
             ma5:'#2563eb', ma10:'#c2185b', ma20:'#0891b2', ma60:'#a16207',
             /* BOLL 是一族：上/下轨与中轨同色相同族、只差一档明度，靠线型再分 */
             bollU:'#4f46e5', bollM:'#6366f1',
             /* 参考线各归其位：压力=深红 0°、成本=紫 262°、均价=青 193°，
                箱体与 VMA 都是中性参考，用同色相的一深一浅两档灰，避免完全同色 */
             sr:'#991b1b', cost:'#7c3aed', box:'#6b7280', avg:'#0e7490', vma:'#4b5563' };
export const _hover = {};                       // 每张图的悬停索引
export function setHover(id, idx) { _hover[id] = idx; }
export const OV_DEF = { ma:'均线', boll:'BOLL', box:'箱体', cost:'成本', sr:'支撑压力' };
export const SUB_DEF = { macd:'MACD', rsi:'RSI' };

export const PERIODS = [
  ['rt','分时'], ['m1','1分'], ['m5','5分'], ['m15','15分'], ['m30','30分'], ['m60','60分'],
  ['day','日K'], ['week','周K'], ['month','月K']
];
export const PERIOD_LABEL = {}; PERIODS.forEach(([k,v])=> PERIOD_LABEL[k]=v);
export const P_MAIN = ['rt','day','week','month'];
export const P_MORE = PERIODS.filter(([k])=> P_MAIN.indexOf(k) < 0);
export const VIEWS = { rt:999, m1:240, m5:64, m15:64, m30:64, m60:64, day:60, week:60, month:40 };

/* 图表用指标：同一套函数在任意周期上复用 —— 周期一换，指标就跟着换成该周期的口径 */
export function chartInd(ks){
  const closes = ks.map(k=>k.close), vols = ks.map(k=>k.vol||0);
  return { closes,
    ma5:maArr(closes,5), ma10:maArr(closes,10), ma20:maArr(closes,20), ma60:maArr(closes,60),
    boll:bollArr(closes,20,2),
    rsi6:rsiArr(closes,6), rsi12:rsiArr(closes,12), rsi24:rsiArr(closes,24),
    macd:macdArr(closes), vma5:maArr(vols,5) };
}
/* 数字格式化：null / 空 / NaN 一律显示为「—」，避免图表和卡片上出现 "null" 或 "NaN" */
const nf = (v, d)=> (v == null || v === '' || Number.isNaN(+v)) ? '—' : (+v).toFixed(d === undefined ? 2 : d);
/* 金额缩写：元 → 万 / 亿（大单金额动辄上亿，原样写出来读不动） */
function money$(v){
  v = +v || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v/1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v/1e4).toFixed(1) + '万';
  return Math.round(v) + '';
}
/* 把一段文字画成带底色的信息条（悬停提示 / 轴上标注共用） */
function chipText(ctx, txt, x, y, col, bg){
  const tw = ctx.measureText(txt).width;
  ctx.globalAlpha = .94; ctx.fillStyle = bg || '#fff';
  ctx.fillRect(x, y-8, tw+7, 15);
  ctx.globalAlpha = 1; ctx.fillStyle = col;
  ctx.fillText(txt, x+3.5, y);
  return tw + 7;
}

let _chartDataLoader = null;
export function registerChartLoader(fn){
  _chartDataLoader = fn;
}

export function chartEntry(kind, obj){
  const e = Object.assign({ kind, at: Date.now() }, obj);
  if (kind === 'bar' && e.ks && e.ks.length) e.ind = chartInd(e.ks);
  return e;
}

export function drawChart(cv, s){
  const p = s.p || 'day';
  s._k = s._k || {};
  let entry = s._k[p];
  if ((!entry || (entry.kind === 'bar' && (!entry.ks || !entry.ks.length))) && p === 'day' && s._ks && s._ks.length) {
    s._k['day'] = chartEntry('bar', { ks: s._ks });
    entry = s._k['day'];
  }
  const ov = s.ov || (s.ov = {});
  const subKind = s.sub || 'macd';

  const W = Math.max(320, cv.clientWidth || cv.parentElement?.clientWidth || 640);
  const PL = 8, PR = 54, PT = 34, PB = 20;      // PT 留出两行信息条的高度（图例已移到画布外的 HTML 里）
  const hMain = 216, hVol = 56, subH = 86, gap = 9;
  const H = PT + hMain + gap + hVol + gap + subH + PB;

  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  }
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.font = '11px ui-monospace,Consolas,monospace';
  ctx.textBaseline = 'middle';

  const y0 = PT, y1 = y0 + hMain;
  const v0 = y1 + gap, v1 = v0 + hVol;
  const s0 = v1 + gap, s1 = s0 + subH;
  const innerW = W - PL - PR;

  if (!entry){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('正在取数…（切换周期首次约 0.3~1 秒）', W/2, H/2);
    if (_chartDataLoader && !s._chartLoading) {
      s._chartLoading = true;
      _chartDataLoader(s, true).then(() => {
        s._chartLoading = false;
        drawChart(cv, s);
        const ci = cv.dataset.ki;
        const metaEl = ci != null ? document.getElementById(`kmeta-${ci}`) : null;
        if (metaEl) metaEl.innerHTML = chartMeta(s);
      }).catch(() => {
        s._chartLoading = false;
      });
    }
    return;
  }
  if (entry.kind === 'line'){ drawRt(cv, s, entry.min, ctx, {W,H,PL,PR,y0,y1,v0,v1,s0,s1,innerW}); return; }

  const ks = entry.ks || [];
  if (ks.length < 12){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('该周期K线不足（仅 ' + ks.length + ' 根），换回日K / 周K 看', W/2, H/2);
    return;
  }
  const ind = entry.ind || chartInd(ks);
  const N = Math.min(VIEWS[p] || 60, ks.length);
  const i0 = ks.length - N;
  const view = ks.slice(i0);
  const bw = innerW / N;
  const X = i => PL + bw*(i+0.5);
  const sv = a => a ? a.slice(i0) : null;
  cv._geo = { kind:'bar', n:N, i0, bw, PL, innerW, view, ind };

  const ta = s._ta;                                  // 日线口径技术面（箱体/支撑压力与所选周期无关）
  const hasBoll = !!(ov.boll && ind.boll && ind.boll.up);
  const vBollU = hasBoll ? sv(ind.boll.up) : null;
  const vBollM = hasBoll ? sv(ind.boll.mid) : null;
  const vBollD = hasBoll ? sv(ind.boll.dn) : null;
  const vMa5 = ov.ma ? sv(ind.ma5) : null, vMa10 = ov.ma ? sv(ind.ma10) : null;
  const vMa20 = ov.ma ? sv(ind.ma20) : null, vMa60 = ov.ma ? sv(ind.ma60) : null;

  /* ---- 价格轴：以蜡烛高低点为主体，叠加线只有"离得不远"的才纳入，防止一条 MA60 把图压扁 ---- */
  let pLo = Infinity, pHi = -Infinity;
  view.forEach(k=>{ if (k.low < pLo) pLo = k.low; if (k.high > pHi) pHi = k.high; });
  const tol = ((pHi - pLo) || 1) * 0.08;
  const take = v => { if (v == null || !isFinite(v)) return;
    if (v > pLo - tol && v < pHi + tol){ if (v < pLo) pLo = v; if (v > pHi) pHi = v; } };
  [vMa5,vMa10,vMa20,vMa60,vBollU,vBollM,vBollD].forEach(a=> a && a.forEach(take));
  const cost = +s.cost || 0;
  if (ov.cost && cost > 0) take(cost);
  if (ov.box && ta && ta.box20){ take(ta.box20.top); take(ta.box20.bot); }
  let srRes = [], srSup = [];
  if (ov.sr && ta && ta.levels){
    srRes = ta.levels.res; srSup = ta.levels.sup;
    srRes.forEach(l=> take(l.p)); srSup.forEach(l=> take(l.p));
  }
  const rng = (pHi - pLo) || 1;
  pLo -= rng*0.045; pHi += rng*0.045;
  const Y = v => y1 - (v - pLo)/(pHi - pLo) * (y1 - y0);

  // ---- 主图网格 + 右侧价格刻度 ----
  ctx.textAlign = 'left';
  for (let k=0; k<=4; k++){
    const pv = pLo + (pHi-pLo)*k/4, yy = Y(pv);
    ctx.strokeStyle = CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = CH.mute; ctx.fillText(f2(pv), W-PR+5, yy);
  }
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath(); ctx.moveTo(PL, v1+.5); ctx.lineTo(W-PR, v1+.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();

  // ---- 布林通道（先铺底，蜡烛压在上面）----
  if (hasBoll){
    ctx.beginPath();
    let started = false;
    vBollU.forEach((v,i)=>{ if (v==null) return; if (!started){ ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v)); });
    for (let i=vBollD.length-1; i>=0; i--){ const v = vBollD[i]; if (v==null) continue; ctx.lineTo(X(i), Y(v)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,132,199,.07)'; ctx.fill();
  }

  // ---- 蜡烛 ----
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const col = rise ? CH.up : CH.dn;
    const x = X(i), bodyW = Math.max(1.5, bw*0.62);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke();
    const yo = Y(k.open), yc = Y(k.close);
    const top = Math.min(yo,yc), hgt = Math.max(1, Math.abs(yc-yo));
    if (rise){ ctx.fillStyle = '#fff'; ctx.fillRect(x-bodyW/2, top, bodyW, hgt);
               ctx.strokeRect(x-bodyW/2+.5, top+.5, bodyW-1, hgt-1); }
    else     { ctx.fillRect(x-bodyW/2, top, bodyW, hgt); }
  });

  // ---- 成交量柱 ----
  const vols = view.map(k=>k.vol || 0);
  const vMax = Math.max(...vols, 1);
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const vh = (k.vol||0)/vMax*(hVol-6);
    ctx.fillStyle = rise ? CH.up : CH.dn; ctx.globalAlpha = .6;
    ctx.fillRect(X(i)-Math.max(1,bw*0.32), v1-vh, Math.max(1.2,bw*0.64), vh);
    ctx.globalAlpha = 1;
  });
  const vma5 = sv(ind.vma5);
  if (vma5){
    ctx.strokeStyle = CH.vma; ctx.lineWidth = 1.1; ctx.beginPath();
    let st = false;
    vma5.forEach((v,i)=>{ if (v==null) return; const yy = v1 - v/vMax*(hVol-6);
      if (!st){ ctx.moveTo(X(i), yy); st = true; } else ctx.lineTo(X(i), yy); });
    ctx.stroke();
  }
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('量', PL+1, v0+8);
  ctx.fillStyle = CH.vma; ctx.fillText('VMA5', PL+18, v0+8);

  // ---- 横线（箱体 / 成本 / 支撑压力 / 现价）----
  const hline = (val, col, dash, label, above, alpha)=>{
    if (val == null || !isFinite(val)) return;
    const yy = Y(val);
    if (yy < y0-2 || yy > y1+2) return;
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha || .85;
    ctx.setLineDash(dash || [4,3]);
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.restore();
    if (label){
      ctx.textAlign = 'left';
      chipText(ctx, label, PL+2, above ? yy-9 : yy+10, col, 'rgba(255,255,255,.92)');
    }
  };
  if (ov.sr){
    /* 支撑压力线画细虚线、不加文字标签，只把「压1/撑1…」小标签贴在右侧内缘 —— 
       左侧已经被箱顶/箱底/成本/现价四个标签占满了，再挤过去会糊成一片。 */
    const srTag = (l, i, isRes)=>{
      const yy = Y(l.p);
      if (yy < y0-2 || yy > y1+2) return;
      const col = isRes ? CH.sr : CH.dn;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = .5;
      ctx.setLineDash([2,3]);
      ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
      ctx.restore();
      if (i > 1) return;                        // 只标注最近的两档，第三档留给卡片里的明细
      ctx.font = '9.5px ui-monospace,Consolas,monospace';
      const lab = (isRes ? '压' : '撑') + (i+1) + ' ' + f2(l.p);
      const tw = ctx.measureText(lab).width;
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(W-PR-4-tw, yy-16, tw+7, 14);
      ctx.fillStyle = col; ctx.textAlign = 'left';
      ctx.fillText(lab, W-PR-1-tw, yy-9);
      ctx.font = '11px ui-monospace,Consolas,monospace';
    };
    srSup.forEach((l,i)=> srTag(l, i, false));      // 撑1 = 离现价最近的支撑
    srRes.forEach((l,i)=> srTag(l, i, true));       // 压1 = 离现价最近的压力
  }
  if (ov.box && ta && ta.box20){
    hline(ta.box20.top, CH.box, [5,3], '箱顶 ' + f2(ta.box20.top), true);
    hline(ta.box20.bot, CH.box, [5,3], '箱底 ' + f2(ta.box20.bot), false);
  }
  if (ov.cost && cost > 0) hline(cost, CH.cost, [6,3], '成本 ' + f2(cost), true);

  // ---- 均线 / 布林轨（画在蜡烛之上，交叉关系才看得清）----
  /* yf：可选的自定义纵坐标映射。副图（MACD / RSI）必须传自己的映射函数，
     否则会被当成主图价格去算 Y()，画成贯穿全屏的竖线（这个坑踩过一次）。 */
  const poly = (arr, col, w, dash, yf)=>{
    if (!arr) return;
    const F = yf || Y;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w || 1.2;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let st = false;
    arr.forEach((v,i)=>{ if (v==null) return;
      if (!st){ ctx.moveTo(X(i), F(v)); st = true; } else ctx.lineTo(X(i), F(v)); });
    ctx.stroke(); ctx.restore();
  };
  if (hasBoll){
    poly(vBollU, CH.bollU, 1, [4,3]); poly(vBollD, CH.bollU, 1, [4,3]);
    poly(vBollM, CH.bollM, 1.1, [4,3]);
  }
  poly(vMa5, CH.ma5, 1.2); poly(vMa10, CH.ma10, 1.2);
  poly(vMa20, CH.ma20, 1.2); poly(vMa60, CH.ma60, 1.2);

  const lastClose = view[view.length-1].close;
  hline(lastClose, lastClose >= +s.prevClose ? CH.up : CH.dn, [2,2], '现价 ' + f2(lastClose), true);

  // ---- 副图：MACD 或 RSI ----
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < N) ? hs : -1;

  if (subKind === 'rsi'){
    const r6 = sv(ind.rsi6), r12 = sv(ind.rsi12), r24 = sv(ind.rsi24);
    const RY = v => s1 - (Math.max(0, Math.min(100, v)))/100*(s1-s0);
    [30,50,70].forEach(v=>{
      ctx.strokeStyle = v===50 ? '#e2e8f0' : '#f1f5f9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PL, RY(v)+.5); ctx.lineTo(W-PR, RY(v)+.5); ctx.stroke();
      ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText(String(v), W-PR+5, RY(v));
    });
    // 超买 / 超卖带
    ctx.globalAlpha = .07; ctx.fillStyle = CH.up; ctx.fillRect(PL, RY(100), innerW, RY(70)-RY(100));
    ctx.fillStyle = CH.dn; ctx.fillRect(PL, RY(30), innerW, RY(0)-RY(30));
    ctx.globalAlpha = 1;
    poly(r6, CH.ma5, 1.2, null, RY); poly(r12, CH.ma10, 1.2, null, RY); poly(r24, CH.ma20, 1.2, null, RY);
    ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('RSI(6/12/24)', PL+1, s0+8);
  } else {
    const md = ind.macd;
    const difS = md ? sv(md.dif) : null, deaS = md ? sv(md.dea) : null, barS = md ? sv(md.bar) : null;
    if (difS){
      const span = Math.max(...[...difS, ...deaS, ...barS].map(v=> Math.abs(v||0)), 0.01)*1.15;
      const yMid = (s0+s1)/2;
      const MY = v => yMid - v/span*((s1-s0)/2 - 2);
      ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, yMid+.5); ctx.lineTo(W-PR, yMid+.5); ctx.stroke();
      view.forEach((k,i)=>{
        const v = barS[i]; if (v == null) return;
        const yy = MY(v);
        ctx.fillStyle = v >= 0 ? CH.up : CH.dn; ctx.globalAlpha = .55;
        ctx.fillRect(X(i)-Math.max(1,bw*0.3), Math.min(yy,yMid), Math.max(1,bw*0.6), Math.abs(yy-yMid));
        ctx.globalAlpha = 1;
      });
      poly(difS, CH.ma5, 1.3, null, MY); poly(deaS, CH.ma10, 1.3, null, MY);
      ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('MACD(12,26,9)', PL+1, s0+8);
    }
  }

  // ---- 底部时间刻度 ----
  ctx.textAlign = 'center'; ctx.fillStyle = CH.mute;
  const dlab = k => p === 'day' || p === 'week' || p === 'month' ? String(k.date).slice(2, 10)
                : String(k.date).slice(8,10) + ':' + String(k.date).slice(10,12);
  [0, Math.floor(N/2), N-1].forEach(i=>{ if (view[i]) ctx.fillText(dlab(view[i]), X(i), H-7); });

  // ---- 悬停十字光标 ----
  if (hi >= 0){
    const k = view[hi];
    ctx.save();
    ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(X(hi)+.5, y0); ctx.lineTo(X(hi)+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, Y(k.close)+.5); ctx.lineTo(W-PR, Y(k.close)+.5); ctx.stroke();
    ctx.restore();
  }

  // ---- 顶部信息条：第 1 行 OHLC + 量额，第 2 行各指标在该根上的取值 ----
  const hv = hi >= 0 ? view[hi] : view[view.length-1];
  const hj = hi >= 0 ? hi : view.length-1;
  const chg = (hv.close - hv.open)/hv.open*100;
  const row1 = dlab(hv) + '  开' + f2(hv.open) + ' 高' + f2(hv.high) + ' 低' + f2(hv.low) + ' 收' + f2(hv.close)
             + '  ' + pct(chg) + '  量' + (hv.vol >= 10000 ? (hv.vol/10000).toFixed(2) + '万手' : (hv.vol||0) + '手');
  const g = (arr)=> arr ? arr[hj] : null;
  const p2 = [];
  if (ov.ma) p2.push('MA5 ' + nf(g(ind.ma5)), 'MA10 ' + nf(g(ind.ma10)), 'MA20 ' + nf(g(ind.ma20)), 'MA60 ' + nf(g(ind.ma60)));
  if (hasBoll) p2.push('BOLL ' + nf(g(ind.boll.dn)) + '/' + nf(g(ind.boll.mid)) + '/' + nf(g(ind.boll.up)));
  if (ind.rsi6) p2.push('RSI6 ' + nf(g(ind.rsi6),1), 'RSI12 ' + nf(g(ind.rsi12),1));
  if (ind.macd) p2.push('DIF ' + nf(g(ind.macd.dif),3), 'DEA ' + nf(g(ind.macd.dea),3));
  const row2 = p2.join('  ');
  ctx.textAlign = 'left';
  chipText(ctx, row1, PL, 12, hv.close >= hv.open ? CH.up : CH.dn, 'rgba(255,255,255,.95)');
  // 第二行：按可用宽度自适应取舍 —— 宁可少显示两项，也不要让文字溢出画布被裁掉
  if (row2){
    const parts = p2.slice();
    let line = '';
    for (let i=0;i<parts.length;i++){
      const t = line ? line + '  ' + parts[i] : parts[i];
      if (ctx.measureText(t).width > innerW - 4) break;
      line = t;
    }
    if (line) chipText(ctx, line, PL, 27, CH.mute, 'rgba(255,255,255,.95)');
  }
}

/* ===================== 分时图 =====================
   分时图自成一套坐标系：以昨收为中轴上下对称，右侧刻度同时看得到价格与涨跌幅，
   分时均价线（权威算法：累计成交额 ÷ 累计成交量）是判断"强于/弱于大盘"的关键线。 */
function drawRt(cv, s, min, ctx, L){
  const { W, H, PL, PR, y0, y1, v0, v1, s0, s1, innerW } = L;
  const pts = (min && min.pts) || [];
  if (pts.length < 5){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText(min ? '今日暂无分时数据（非交易日或停牌）' : '正在取数…', W/2, H/2);
    return;
  }
  const prev = (min.prev || +s.prevClose || pts[0].price);
  let mx = 0.002;
  pts.forEach(p=>{
    const d1 = Math.abs(p.price - prev)/prev, d2 = Math.abs(p.avg - prev)/prev;
    if (d1 > mx) mx = d1; if (d2 > mx) mx = d2;
  });
  mx = Math.min(0.2, Math.ceil(mx*100*1.12)/100);      // 上下各留 12% 余量，上限 20%（防止极端值压扁）
  const yHi = prev*(1+mx), yLo = prev*(1-mx);
  const Y = v => y1 - (v-yLo)/(yHi-yLo)*(y1-y0);
  const X = i => PL + (pts.length <= 1 ? innerW/2 : innerW*i/(pts.length-1));
  cv._geo = { kind:'line', n:pts.length, PL, innerW, pts, prev };

  // 网格 + 右侧价格/涨跌幅刻度
  ctx.textAlign = 'left';
  for (let k=-2; k<=2; k++){
    const pv = prev*(1 + mx*k/2), yy = Y(pv);
    ctx.strokeStyle = k === 0 ? '#dfe3e8' : CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = k === 0 ? CH.txt : CH.mute;
    ctx.fillText(f2(pv), W-PR+5, yy);
    ctx.fillStyle = pv >= prev ? CH.up : CH.dn;
    ctx.fillText((k>0?'+':'') + (k*mx/2*100).toFixed(2) + '%', W-PR+5, yy+11);
  }

  // 价格线（相对昨收的红绿）+ 昨收中轴
  const lastPt = pts[pts.length-1];
  const lineCol = lastPt.price >= prev ? CH.up : CH.dn;
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.price); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = lineCol; ctx.lineWidth = 1.4; ctx.stroke();
  // 价格线到昨收之间的淡填充
  ctx.lineTo(X(pts.length-1), Y(prev)); ctx.lineTo(X(0), Y(prev)); ctx.closePath();
  ctx.fillStyle = lineCol; ctx.globalAlpha = .07; ctx.fill(); ctx.globalAlpha = 1;
  // 均价线
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.avg); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = CH.avg; ctx.lineWidth = 1.2; ctx.stroke();

  // 成交量（每分钟差分）
  const vMax = Math.max(...pts.map(p=>p.vol), 1);
  pts.forEach((p,i)=>{
    const pp = i > 0 ? pts[i-1].price : prev;
    const vh = p.vol/vMax*(v1-v0-4);
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .6;
    const bwid = Math.max(1, innerW/pts.length*0.66);
    ctx.fillRect(X(i)-bwid/2, v1-vh, bwid, vh);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('分时量', PL+1, v0+8);

  /* 第 2 副图位：分时放量倍数。
     分母优先用「前 5 日同一时段基准」（跨时点可比，1× 就是该时点的常态）；
     基准没取到时退回「当日均量」，但那样早盘天然偏高、午盘天然偏低，只能在标签里明说。 */
  ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();
  const _vslots = (s._vm && s._vm.ok && s._vm.slots) ? s._vm.slots : null;
  const avgV = pts.reduce((a,p)=>a+p.vol,0)/pts.length || 1;
  const expCache = {};
  const expOf = t => {
    if (!_vslots) return avgV;
    if (expCache[t] != null) return expCache[t];
    const mm = (+t.slice(0,2))*60 + (+t.slice(2,4));
    const bv = _vslots[m5Slot(mm)];
    return (expCache[t] = (bv > 0 ? bv/5 : avgV));      // 5 分钟均量摊到每分钟
  };
  const ratioOf = p => { const e = expOf(p.t); return e > 0 ? p.vol/e : 0; };
  const rMax = Math.max(3, Math.ceil(Math.max(...pts.map(ratioOf))));
  const RY2 = r => s1 - Math.min(r, rMax)/rMax*(s1-s0);
  [1, 2, 3].forEach(r=>{
    if (r > rMax) return;
    ctx.strokeStyle = r === 1 ? '#c9d2dd' : '#f1f5f9';
    ctx.beginPath(); ctx.moveTo(PL, RY2(r)+.5); ctx.lineTo(W-PR, RY2(r)+.5); ctx.stroke();
    ctx.fillStyle = r === 1 ? CH.txt : CH.mute; ctx.textAlign='left';
    ctx.fillText(r + '×', W-PR+5, RY2(r));
  });
  pts.forEach((p,i)=>{
    const r = ratioOf(p), yy = RY2(r), pp = i > 0 ? pts[i-1].price : prev;
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .5;
    const bwid = Math.max(1, innerW/pts.length*0.66);
    ctx.fillRect(X(i)-bwid/2, yy, bwid, s1-yy);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left';
  ctx.fillText(_vslots ? '放量倍数（该分钟量 ÷ 前5日同一时段均量，1× = 常态）'
                       : '放量倍数（该分钟量 ÷ 当日均量 —— 早盘天然偏高，基准未取到）', PL+1, s0+8);

  // 时间轴
  const marks = ['0930','1030','1130','1400','1500'];
  ctx.textAlign = 'center'; ctx.fillStyle = CH.mute;
  marks.forEach(t=>{
    let idx = -1;
    for (let i=0;i<pts.length;i++) if (pts[i].t === t){ idx = i; break; }
    if (idx < 0) return;
    ctx.fillText(t.slice(0,2) + ':' + t.slice(2), X(idx), H-7);
  });

  // 悬停
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < pts.length) ? hs : -1;
  if (hi >= 0){
    const p = pts[hi];
    ctx.save(); ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(X(hi)+.5, y0); ctx.lineTo(X(hi)+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, Y(p.price)+.5); ctx.lineTo(W-PR, Y(p.price)+.5); ctx.stroke();
    ctx.restore();
  }
  const p = hi >= 0 ? pts[hi] : lastPt;
  const pctv = (p.price - prev)/prev*100;
  const row = p.t.slice(0,2) + ':' + p.t.slice(2) + '  价 ' + f2(p.price) + '  ' + pct(pctv)
            + '  均价 ' + f2(p.avg) + '  该分钟 ' + p.vol + ' 手';
  ctx.textAlign = 'left';
  chipText(ctx, row, PL, 12, pctv >= 0 ? CH.up : CH.dn, 'rgba(255,255,255,.95)');
  chipText(ctx, '昨收 ' + f2(prev) + '　量比 ' + nf(+s.vr, 2) + '　换手 ' + (s._ta && s._ta.turnover ? s._ta.turnover.toFixed(2) + '%' : '—')
    + '　现价' + (p.price >= p.avg ? '在均价上方（强）' : '在均价下方（弱）'), PL, 27, CH.txt, 'rgba(255,255,255,.95)');
}

/* ===================== 图表工具条（周期 / 叠加 / 副图） ===================== */
export function kbarHTML(i, s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const sub = s.sub || 'macd';
  const rt = p === 'rt';                    // 分时图没有蜡烛/均线概念，叠加与副图开关此时无意义，直接不显示
  return `<div class="kbar k-main">`
    + `<span class="lbl">周期</span>` + PERIODS.filter(([k])=>P_MAIN.indexOf(k)>=0).map(([k,v])=>
        `<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `<details class="pd-more"><summary>更多 ▾</summary><div class="pd-pop">`
    + P_MORE.map(([k,v])=>`<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `</div></details>`
    + (rt ? `<span class="sp"></span><span class="lbl">分时图自带：价格线 / 均价线 / 分时量 / 放量倍数</span>`
          : `<span class="sp"></span>`
          + `<span class="lbl">叠加</span>` + Object.keys(OV_DEF).map(k=>
              `<span class="chip ov${ov[k]?' on':''}" data-ovl="${i}" data-v="${k}">${OV_DEF[k]}</span>`).join('')
          + `<span class="sp"></span>`
          + `<span class="lbl">副图</span>` + Object.keys(SUB_DEF).map(k=>
              `<span class="chip sb${sub===k?' on':''}" data-sub="${i}" data-v="${k}">${SUB_DEF[k]}</span>`).join(''))
    + `<span class="sp"></span>`
    + `<span class="chip${(s._dd&&s._dd.dd)?' on':''}" data-ddload="${i}" title="拉取当日逐笔成交，按单笔金额分档统计主力/大单净额与净量（约 1 秒）">💰 大单资金</span>`
    + `<span class="rd" id="kmeta-${i}">${chartMeta(s)}</span>`
    + `</div>`;
}
export function chartMeta(s){
  const p = s.p || 'day';
  s._k = s._k || {};
  let e = s._k[p];
  if ((!e || (e.kind === 'bar' && (!e.ks || !e.ks.length))) && p === 'day' && s._ks && s._ks.length) {
    s._k['day'] = chartEntry('bar', { ks: s._ks });
    e = s._k['day'];
  }
  if (!e) return '待取数';
  const n = e.kind === 'line' ? ((e.min && e.min.pts.length) || 0) : ((e.ks && e.ks.length) || 0);
  return (PERIOD_LABEL[p] || p) + ' · ' + n + (e.kind === 'line' ? ' 分钟' : ' 根') + ' · ' + new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false});
}
/* 画布下方的颜色图例。放在 HTML 而不是画在 canvas 上：文字可选中、不会被裁切、
   也腾出了画布顶部的空间给"悬停信息条"（两行：OHLC+量 / 各指标取值）。 */
export function chartLegendHTML(s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const it = (t, c)=> `<span><i style="background:${c}"></i>${t}</span>`;
  /* 图例画错色是会误导下单的：价格线、成交量在图上都随涨跌变色，
     原来图例却给它们画了单色（价格线画成红、成交量画成灰），
     和图上看到的不一致。红绿双色项一律用左右分色块。 */
  const it2 = (t, c1, c2)=> `<span><i style="background:linear-gradient(90deg,${c1} 0 50%,${c2} 50% 100%)"></i>${t}</span>`;
  const out = [];
  if (p === 'rt'){
    out.push(it2('价格线', CH.up, CH.dn), it('均价线', CH.avg), it2('分时量', CH.up, CH.dn));
  } else {
    if (ov.ma) out.push(it('MA5',CH.ma5), it('MA10',CH.ma10), it('MA20',CH.ma20), it('MA60',CH.ma60));
    if (ov.boll) out.push(it('BOLL 上/下轨', CH.bollU), it('BOLL 中轨', CH.bollM));
    out.push(it2('成交量', CH.up, CH.dn), it('VMA5', CH.vma));
  }
  if (ov.box) out.push(it('20日箱体', CH.box));
  if (ov.cost && +s.cost > 0) out.push(it('持仓成本', CH.cost));
  if (ov.sr) out.push(it('压力位', CH.sr), it('支撑位', CH.dn));
  return `<div class="k-legend">${out.join('')}</div>`;
}
/* 图表下方的实时数据条：把"图上看得见"的指标都写成可读数字，方便直接抄进挂单表 */
export function chartStat(s){
  const ta = s._ta;
  const p = s.p || 'day';
  const e = (s._k || {})[p];
  const cell = (k, v, cls)=> `<span class="st${cls?' '+cls:''}"><em>${k}</em><b>${v}</b></span>`;
  const out = [];
  if (p === 'rt'){
    const mn = e && e.min;
    if (mn && mn.pts.length){
      const lastP = mn.pts[mn.pts.length-1];
      const prev = mn.prev || +s.prevClose;
      out.push(cell('现价', f2(lastP.price), lastP.price >= prev ? 'up' : 'dn'));
      out.push(cell('均价', f2(lastP.avg), lastP.price >= lastP.avg ? 'up' : 'dn'));
      out.push(cell('价/均', ((lastP.price/lastP.avg - 1)*100).toFixed(2) + '%', lastP.price >= lastP.avg ? 'up' : 'dn'));
      const totV = (mn.pts[mn.pts.length-1] && (mn.pts.reduce((a,x)=>a+x.vol,0))) || 0;
      out.push(cell('分时量', totV >= 10000 ? (totV/10000).toFixed(2) + '万手' : totV + '手'));
    }
  }
  if (ta){
    if (ta.turnover) out.push(cell('换手率', ta.turnover.toFixed(2) + '%'));
    out.push(cell('量比', nf(+s.vr, 2)));
    if (ta.bl && ta.bl.up != null) out.push(cell('BOLL', nf(ta.bl.dn) + ' / ' + nf(ta.bl.mid) + ' / ' + nf(ta.bl.up)));
    if (ta.r && ta.r.r6 != null) out.push(cell('RSI6', ta.r.r6.toFixed(1), ta.r.r6 >= 70 ? 'up' : ta.r.r6 <= 30 ? 'dn' : ''));
    if (ta.bwDelta != null) out.push(cell('带宽', ta.bl.bw != null ? ta.bl.bw.toFixed(2) + '%' : '—', ta.bwDelta > 8 ? 'up' : ta.bwDelta < -8 ? 'dn' : ''));
  }
  if (s._dd && s._dd.dd){
    const d = s._dd.dd;
    out.push(cell('主力净额', (d.main.net >= 0 ? '+' : '') + money$(d.main.net), d.main.net >= 0 ? 'up' : 'dn'));
    out.push(cell('大单净量', (d.main.netv >= 0 ? '+' : '') + d.main.netv.toFixed(0) + '手', d.main.netv >= 0 ? 'up' : 'dn'));
  }
  if (ta && ta.levels && (ta.levels.res.length || ta.levels.sup.length)){
    const r1 = ta.levels.res[0], s1 = ta.levels.sup[0];
    if (s1) out.push(cell('支撑', f2(s1.p) + ' ' + s1.label + '(' + s1.strength + ')', 'dn'));
    if (r1) out.push(cell('压力', f2(r1.p) + ' ' + r1.label + '(' + r1.strength + ')', 'up'));
  }
  if (!out.length) return '';
  return `<div class="k-stat">${out.join('')}</div>`;
}
