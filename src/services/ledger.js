/* ============================================================
   A股做T执行台 · 执行台账与认知体检模块 (ledger.js)
   ============================================================ */

import { f2, f3, pct, money, money2, todayStr, toast, toastOk, toastWarn, toastErr, copyPlain, soundChime, FEE, LCOLS, LS_KEYS } from './utils.js';
import { pool, savePool, LOG, saveLog } from './state.js';

export function logNet(r){
  const b=+r.buy||0, s=+r.sell||0, q=+r.qty||0;
  if(!b||!s||!q) return null;
  return (s-b)*q - (s+b)*q*FEE;
}

export function logRatio(r){
  const b=+r.buy||0, s=+r.sell||0;
  if(!b||!s) return null;
  return (s-b)/b*100 - FEE*100;
}

/* ===================== 执行台账渲染 ===================== */
export function renderLog(){
  const t = document.getElementById('logTable');
  if (!t) return;

  const body = (LOG || []).map((r,i)=>{
    const net = logNet(r);
    const ret = logRatio(r);
    const cells = LCOLS.map(([k,lb,ty,opts])=> `<td>${ ty==='select'
        ? `<select data-li="${i}" data-lk="${k}">
             ${(r[k] ? '' : '<option value="" selected>待标注</option>')
               + opts.map(o=>`<option value="${o}"${r[k]===o?' selected':''}>${o}</option>`).join('')}
           </select>`
        : `<input data-li="${i}" data-lk="${k}" value="${r[k] ?? ''}"${ty==='num'?' inputmode="decimal"':''}>` }</td>` ).join('');
    const netCell = net===null ? '<span style="color:var(--mute)">待填</span>'
      : `<b style="color:${net>=0?'var(--up)':'var(--down)'}">${money(net)}</b>`;
    const retCell = ret===null ? '<span style="color:var(--mute)">—</span>'
      : `<b style="color:${ret>=0?'var(--up)':'var(--down)'}">${(ret>=0?'+':'')+ret.toFixed(2)}%</b>`;
    return `<tr>${cells}<td class="num">${netCell}</td><td class="num">${retCell}</td>`
         + `<td style="text-align:center"><button class="del" data-ldel="${i}">删</button></td></tr>`;
  }).join('');

  t.innerHTML = `<thead><tr>${LCOLS.map(f=>`<th>${f[1]}</th>`).join('')}
      <th style="text-align:right">净盈亏(元)</th><th style="text-align:right">收益率</th><th></th></tr></thead>
    <tbody>${body || `<tr><td colspan="${LCOLS.length+3}" style="text-align:center;color:var(--mute);padding:20px">还没有记录。做了一笔就点上面「记一笔」。</td></tr>`}</tbody>`;

  bindLogEvents();
  renderCogReport();
}

function bindLogEvents(){
  const t = document.getElementById('logTable');
  if (!t) return;

  t.querySelectorAll('input[data-li], select[data-li]').forEach(el => {
    el.onchange = () => {
      const idx = +el.dataset.li;
      const key = el.dataset.lk;
      if (LOG[idx]) {
        LOG[idx][key] = el.value;
        saveLog();
        renderLog();
        if (window.render) window.render(pool);
      }
    };
  });

  t.querySelectorAll('button[data-ldel]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.ldel;
      if (confirm('确定删除这条交易记录吗？')) {
        LOG.splice(idx, 1);
        saveLog();
        renderLog();
        if (window.render) window.render(pool);
        toastOk('已删除该笔台账');
      }
    };
  });
}

export function logAdd(){
  const today = todayStr();
  LOG.unshift({
    date: today,
    stock: pool.length ? pool[0].name : '',
    dir: '正T',
    buy: '',
    sell: '',
    qty: 100,
    plan: '计划内',
    basis: '客观信号',
    note: ''
  });
  saveLog();
  renderLog();
  toastOk('已新增一条空白台账，请填写买卖价格');
}

/* ===================== 认知台账与三法体检 ===================== */
export function cogStats(){
  const rets = (LOG || []).map(logRatio).filter(v => v !== null);
  const n = rets.length;
  const wins = rets.filter(v => v > 0), losses = rets.filter(v => v < 0);
  const W = n ? wins.length / n : null;
  const avgWin  = wins.length   ? wins.reduce((a,b)=>a+b,0) / wins.length : null;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0) / losses.length) : null;
  const R = (avgWin !== null && avgLoss) ? avgWin / avgLoss : null;
  const E = (W !== null && avgWin !== null && avgLoss !== null) ? W*avgWin - (1-W)*avgLoss : null;
  const breakevenW = R ? 1/(1+R) : null;

  const markedP = (LOG || []).filter(r => r.plan).length;
  const markedB = (LOG || []).filter(r => r.basis).length;
  const planRate = markedP ? (LOG || []).filter(r => r.plan === '计划内').length / markedP : null;
  const objRate  = markedB ? (LOG || []).filter(r => r.basis === '客观信号').length / markedB : null;

  return { n, wins: wins.length, losses: losses.length, W, avgWin, avgLoss, R, E, breakevenW, planRate, objRate, markedP, markedB };
}

export function renderCogReport(){
  const el = document.getElementById('cogReport');
  if (!el) return;
  const st = cogStats();

  if (!st.n){
    el.innerHTML = `<div class="mute" style="padding:16px;text-align:center;background:var(--surface);border-radius:8px;border:1px dashed var(--line)">
      台账中暂无完整平仓记录，完成第一笔做T交易后将在此自动生成《认知术》诊断报告。
    </div>`;
    return;
  }

  const wPct = st.W !== null ? (st.W * 100).toFixed(1) + '%' : '—';
  const rVal = st.R !== null ? st.R.toFixed(2) : '—';
  const eVal = st.E !== null ? (st.E >= 0 ? '+' : '') + st.E.toFixed(2) + '%' : '—';
  const planPct = st.planRate !== null ? (st.planRate * 100).toFixed(0) + '%' : '—';
  const objPct = st.objRate !== null ? (st.objRate * 100).toFixed(0) + '%' : '—';

  el.innerHTML = `
    <div class="cog-kpi-grid">
      <div class="ck-card">
        <span class="ck-k">实战胜率</span>
        <span class="ck-v" style="color:${st.W >= 0.6 ? 'var(--up)' : 'var(--warn)'}">${wPct}</span>
        <span class="ck-d">${st.wins} 胜 / ${st.losses} 负 (共 ${st.n} 笔)</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">实战盈亏比 (R)</span>
        <span class="ck-v" style="color:${st.R >= 1.5 ? 'var(--up)' : 'var(--warn)'}">${rVal}</span>
        <span class="ck-d">平均胜 +${st.avgWin ? st.avgWin.toFixed(2) : '0'}% ｜ 均亏 -${st.avgLoss ? st.avgLoss.toFixed(2) : '0'}%</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">每笔数学期望 (E)</span>
        <span class="ck-v" style="color:${st.E > 0 ? 'var(--up)' : 'var(--down)'}">${eVal}</span>
        <span class="ck-d">盈亏平衡要求胜率: ${st.breakevenW ? (st.breakevenW * 100).toFixed(1) + '%' : '—'}</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">计划执行率</span>
        <span class="ck-v" style="color:${st.planRate >= 0.8 ? 'var(--up)' : 'var(--warn)'}">${planPct}</span>
        <span class="ck-d">依据客观信号率: ${objPct}</span>
      </div>
    </div>
  `;
}

export function renderCheckup(){
  renderCogReport();
}

/* ===================== 全局备份、导出与导入 ===================== */
export function exportAll(){
  const dump = {};
  LS_KEYS.forEach(k => {
    try {
      const v = localStorage.getItem(k);
      if (v) dump[k] = JSON.parse(v);
    } catch (_) {}
  });

  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `t-stock-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toastOk('✓ 已成功导出所有本地持仓、台账与系统配置数据！');
}

export function importAll(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== 'object') throw new Error('无效的数据格式');

      Object.keys(data).forEach(k => {
        if (LS_KEYS.includes(k)) {
          localStorage.setItem(k, JSON.stringify(data[k]));
        }
      });

      toastOk('✓ 数据导入成功！正在重新载入工作区…');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      toastErr('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
}

export function copyPlan(){
  let str = `【A股做T实盘作战计划 · ${todayStr()}】\n`;
  (pool || []).forEach(s => {
    str += `\n标的：${s.name} (${s.code}) 现价: ${f2(s.price)}\n`;
    str += `· 正T买点：${f2(s.inA || s.price * 0.985)} ~ ${f2(s.inB || s.price * 0.97)}\n`;
    str += `· 冲高止盈：${f2(s.tp1 || s.price * 1.025)} ~ ${f2(s.tp2 || s.price * 1.045)}\n`;
    str += `· 保命止损：${f2(s.slA || s.price * 0.985)} (-1.5%)\n`;
  });
  copyPlain(str, '今日作战计划已复制到剪贴板！');
}
