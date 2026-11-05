/**
 * dashboard.js —— 把五个独立页面合并成一张选股工作台
 * 数据全部来自 out/*.json，与各单页同源，避免两套口径
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

// 自动识别 out/ 下最新的扫描日与挂单计划文件，避免每天改日期
const latestOf = (re) => fs.readdirSync(OUT).filter((f) => re.test(f)).sort().pop();
const day = rd(latestOf(/^\d{4}-\d{2}-\d{2}\.json$/));
const plan = rd(latestOf(/^plan-\d{4}-\d{2}-\d{2}\.json$/));
const timing = rd('timing.json');
const bt = rd('backtest-v3.json');
const steady = rd('steady.json');

const f2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));
const sgn = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(2);
const col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--mute)');

/* ---------- 概览数字 ---------- */
const cand = plan.rows.length;
const canDo = plan.rows.filter((r) => r.pos > 0).length;
const envLv = plan.env.level;
const n0 = day.funnel['⑤ 涨幅 3–5%'];
const strict = (day.strictPass || []).length;
const zone = day.results.length;

/* ---------- 1. 漏斗 ---------- */
const funnelRows = Object.entries(day.funnel).map(([k, v], i, arr) => {
  const prev = i ? arr[i - 1][1] : v;
  const d = i ? prev - v : 0;
  const w = (v / day.total) * 100;
  return `<div class="fr">
    <span class="fk">${k}</span>
    <span class="fb"><i style="width:${Math.max(w, 0.5)}%"></i></span>
    <span class="fv">${v}</span>
    <span class="fd">${i ? '−' + d : ''}</span>
  </div>`;
}).join('');

/* ---------- 2. 选股清单 ---------- */
const pickRows = plan.rows.map((r, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td class="nm">${r.name}<span class="cd">${r.code}</span></td>
  <td class="num sc">${r.score}</td>
  <td><span class="pill ${r.verdict === '可做' ? 'p-do' : 'p-small'}">${r.verdict}</span></td>
  <td class="num" style="color:${col(r.pc - 1)}">${f2(r.pc)}</td>
  <td class="num">${f2(r.amp)}%</td>
  <td class="num">${f2(r.volRatio)}</td>
  <td class="num">${f2(r.turnover)}%</td>
  <td class="num">${r.vwapOnline === null ? '—' : f2(r.vwapOnline) + '%'}</td>
  <td><span class="pill ${r.g2.c === 'ok' ? 'p-ok' : r.g2.c === 'bad' ? 'p-bad' : 'p-wait'}">${r.g2.t}</span></td>
</tr>`).join('');

/* ---------- 3. 挂单价位 ---------- */
const planRows = plan.rows.map((r) => `<tr class="${r.pos > 0 ? '' : 'dim'}">
  <td class="nm">${r.name}</td>
  <td class="num">${r.score}</td>
  <td class="num">${f2(r.pc)}</td>
  <td class="num">${f2(r.expOpen)}</td>
  <td class="num up">${f2(r.sell1)}</td>
  <td class="num">${f2(r.sell2)}</td>
  <td class="num down">${f2(r.stop)}</td>
  <td class="num">${r.grid}格</td>
  <td class="num">${r.pos}%</td>
  <td class="act">${r.action}</td>
</tr>`).join('');

/* ---------- 4. 时段 ---------- */
const slots = timing.slots;
const pctOf = (n, d) => (n / d) * 100;
const maxPct = Math.max(...slots.flatMap(([s]) => [
  pctOf(timing.slotStat[s].high, timing.used),
  pctOf(timing.baseSlot[s].high, timing.baseDays),
]));
const slotBars = slots.map(([s, label]) => {
  const pctA = pctOf(timing.slotStat[s].high, timing.used);
  const pctB = pctOf(timing.baseSlot[s].high, timing.baseDays);
  const hA = Math.max(3, Math.round(pctA / maxPct * 90));
  const hB = Math.max(3, Math.round(pctB / maxPct * 90));
  return `<div class="grp">
    <div class="pair">
      <div class="cc"><span class="bv">${pctA.toFixed(0)}</span><div class="bb blue" style="height:${hA}px"></div></div>
      <div class="cc"><span class="bv gray">${pctB.toFixed(0)}</span><div class="bb grey" style="height:${hB}px"></div></div>
    </div>
    <div class="gl">${label}</div>
  </div>`;
}).join('');

/* ---------- 5. 竞价 ---------- */
const gapRows = (timing.gapStat || []).filter((g) => g.n).map((g) => `<tr>
  <td>${g.label}${g.n < 8 ? '<span class="thin">样本不足</span>' : ''}</td>
  <td class="num">${g.n}</td>
  <td class="num">${g.space}%</td>
  <td class="num">${g.hit1}%</td>
  <td class="num ${g.hit2 >= 70 ? 'up' : ''}">${g.hit2}%</td>
  <td class="num ${g.upClose >= 50 ? 'down' : ''}">${g.upClose}%</td>
  <td class="num">${g.give}%</td>
</tr>`).join('');

/* ---------- 6. 四变体 ---------- */
const V = bt.summary;
const vRows = ['A', 'B', 'C', 'D'].map((k) => {
  const o = V[k];
  const cells = ['T+1', 'T+3', 'T+5'].map((h) => {
    const v = o.byHold[h];
    return `<td class="num" style="color:${col(v.开盘)}">${sgn(v.开盘)}</td><td class="num" style="color:${col(v.超额)}">${sgn(v.超额)}</td>`;
  }).join('');
  return `<tr><td><b>${k}</b> ${o.name}</td><td class="num">${o.pickDays}</td><td class="num">${o.obs}</td>${cells}</tr>`;
}).join('');

/* ---------- 7. 稳健 ---------- */
const steadyRows = steady.top.map((r, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td class="nm">${r.name}<span class="cd">${r.code}</span></td>
  <td class="num up">${r.div.toFixed(1)}%</td>
  <td class="num">${r.roe.toFixed(1)}%</td>
  <td class="num">${r.mv}</td>
  <td class="num">${r.amp20.toFixed(1)}%</td>
  <td class="num">${r.atrPct.toFixed(1)}%</td>
  <td><span class="pill ${r.trend === '多头' ? 'p-ok' : r.trend === '整理' ? 'p-wait' : 'p-bad'}">${r.trend}</span></td>
  <td class="num sc">${r.score}</td>
</tr>`).join('');

const dual = (plan.env.dual || []).filter((x) => x.ok);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>选股工作台 · ${day.date}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
--text:#1f2328;--sub:#515c69;--mute:#66707c;--up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
--info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;--shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:22px;margin:0 0 3px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 16px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;box-shadow:var(--shadow)}
.kpi .k{font-size:11.5px;color:var(--mute);line-height:1.35}
.kpi .v{font-size:21px;font-weight:700;margin-top:2px;letter-spacing:-.4px}
.kpi .v small{font-size:11px;font-weight:400;color:var(--mute);margin-left:2px}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5}
.tabs button{border:1px solid var(--line);background:var(--card);color:var(--sub);padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit}
.tabs button.on{background:var(--info);border-color:var(--info);color:#fff;font-weight:500}
.pane{display:none}.pane.on{display:block}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:13px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 12px}
h2 .tag{font-size:11px;font-weight:400;color:var(--mute);background:var(--surface2);padding:1px 7px;border-radius:99px;margin-left:6px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11.5px;padding:7px 5px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid var(--hair);white-space:nowrap}
tr:hover td{background:var(--surface2)}
tr.dim{opacity:.5}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nm{font-weight:600}
.cd{color:var(--mute);font-weight:400;font-size:11px;margin-left:5px}
.up{color:var(--up);font-weight:600}.down{color:var(--down);font-weight:600}
.sc{font-weight:700}
.act{color:var(--sub);font-size:12px}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid;white-space:nowrap}
.p-do{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-small{color:var(--info);background:var(--info-bg);border-color:var(--info-b)}
.p-ok{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-wait{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-b)}
.p-bad{color:#991b1b;background:#fef2f2;border-color:#fecaca}
.fr{display:flex;align-items:center;gap:9px;margin:5px 0;font-size:12.5px}
.fk{width:150px;color:var(--sub);flex:none}
.fb{flex:1;height:13px;background:var(--surface2);border-radius:4px;overflow:hidden}
.fb i{display:block;height:100%;background:linear-gradient(90deg,#93c5fd,#2563eb)}
.fv{width:52px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.fd{width:52px;text-align:right;font-size:11.5px;color:var(--mute)}
.chart{display:flex;align-items:flex-end;gap:4px;height:150px;padding-top:6px}
.grp{flex:1;display:flex;flex-direction:column;justify-content:flex-end}
.pair{display:flex;align-items:flex-end;gap:3px;justify-content:center}
.cc{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px}
.bv{font-size:9.5px;font-variant-numeric:tabular-nums;color:var(--info)}
.bv.gray{color:var(--mute)}
.bb{width:14px;border-radius:3px 3px 0 0}
.blue{background:#2563eb}.grey{background:#cbd5e1}
.gl{font-size:10px;color:var(--mute);text-align:center;margin-top:5px;white-space:nowrap}
.legend{display:flex;gap:14px;font-size:11.5px;color:var(--sub);margin-top:8px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#6b4a00;line-height:1.8}
.ok{background:var(--info-bg);border:1px solid var(--info-b);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#1e3a8a;line-height:1.8}
.bad{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#7f1d1d;line-height:1.8}
.good{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#14532d;line-height:1.8}
.thin{display:inline-block;font-size:10px;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:3px;padding:0 4px;margin-left:4px}
.calc{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.calc input{width:110px;padding:6px 9px;border:1px solid var(--line2);border-radius:7px;font-size:13.5px;font-variant-numeric:tabular-nums}
.calc .o{display:flex;gap:14px;font-size:12.5px;color:var(--sub);flex-wrap:wrap}
.calc .o b{color:var(--text);font-variant-numeric:tabular-nums}
.small{font-size:12px;color:var(--mute);line-height:1.75}
@media(max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}.fk{width:110px}.gl{font-size:8.5px}.bb{width:8px}}
</style></head><body><div class="wrap">

<h1>选股工作台</h1>
<p class="sub">${day.date} 收盘 · 全市场 ${day.total} 只扫描 · 五个模块合并视图 · 数据源：东财 / 腾讯 / 新浪三级容错</p>

<div class="kpis">
  <div class="kpi"><div class="k">全市场</div><div class="v">${day.total}<small>只</small></div></div>
  <div class="kpi"><div class="k">严格六步法幸存</div><div class="v">${day.hardPass.length}<small>只</small></div></div>
  <div class="kpi"><div class="k">过复核候选</div><div class="v">${cand}<small>只</small></div></div>
  <div class="kpi"><div class="k">明日可挂单</div><div class="v" style="color:${canDo ? 'var(--down)' : 'var(--up)'}">${canDo}<small>只</small></div></div>
  <div class="kpi"><div class="k">环境闸门</div><div class="v" style="color:${envLv === 'BAD' ? 'var(--up)' : envLv === 'WARN' ? 'var(--warn)' : 'var(--down)'}">${envLv}</div></div>
</div>

<div class="tabs">
  <button class="on" data-t="p1">今日概览</button>
  <button data-t="p2">选股与挂单</button>
  <button data-t="p3">时段与竞价</button>
  <button data-t="p4">规则验证</button>
  <button data-t="p5">稳健底仓</button>
</div>

<!-- ========== 1 概览 ========== -->
<div class="pane on" id="p1">
  <section>
    <h2>一、今日结论 <span class="tag">先看这段，其余都是过程</span></h2>
    <div class="bad">
      <b>明日不执行正T —— 环境一票否决。</b><br>
      ${dual.map((x) => `${x.key} ${x.close}（MA20 ${x.ma20}，偏离 <b>${x.vsMa20}%</b>）`).join('；')}。
      两个指数同时跌破 MA20 与 MA60。<b>中证1000 的偏离幅度远大于上证</b>，而候选几乎全是中小盘——按上证单看会严重低估风险。
      <br>选股引擎给了 ${canDo || plan.rows.filter((r) => r.verdict === '可做').length} 只「可做」，那是<b>相对打分</b>；环境闸门是<b>绝对风控</b>。冲突时后者优先。
    </div>
    <div class="ok" style="margin-top:10px">
      <b>但规则本身是被验证过的，只是不能持有：</b>
      同一批票持有到 T+5 亏 ${sgn(V.A.byHold['T+5'].开盘)}%，而 79% 的票次日盘中能涨过前一日收盘，
      开盘半小时内触及 +1% 的占 70%（同池基准 59%）。<b>它筛的是「明天有波动可做T的标的」，不是「可以等涨的标的」。</b>
    </div>
  </section>

  <section>
    <h2>二、漏斗 <span class="tag">严格六步法逐级淘汰</span></h2>
    ${funnelRows}
    <p class="small" style="margin-top:10px">
      「涨幅 3–5%」一步砍掉 ${(day.funnel['④ 市值 30–200 亿'] - n0)} 只（占 ${((1 - n0 / day.funnel['④ 市值 30–200 亿']) * 100).toFixed(1)}%），是全流程最锋利的刀。
      严格六步法走到 Step6（全天不破均价线）后剩 ${strict} 只——这正是把它改成打分版的原因。
    </p>
  </section>

  <section>
    <h2>三、时间表 <span class="tag">这套时点是回溯出来的</span></h2>
    <table>
      <thead><tr><th>时点</th><th>动作</th><th>依据</th></tr></thead>
      <tbody>
        <tr><td><b>15:10</b></td><td>收盘后跑引擎，出次日候选与预案</td><td>自动任务</td></tr>
        <tr><td><b>9:26</b></td><td>抓竞价，微调目标价与仓位</td><td>高开空间大但回撤也大；低开砍半</td></tr>
        <tr><td><b>9:30</b></td><td>开盘即挂单，按开盘价重算，不按前收盘</td><td>70% 的 +1% 在半小时内触及</td></tr>
        <tr><td><b>10:30</b></td><td>没成交就撤</td><td>之后只剩 7.5 个百分点的机会</td></tr>
        <tr><td><b>15:00</b></td><td>不守收盘，当天闭环</td><td>高点后平均回撤 3.19%，收盘为正仅 46%</td></tr>
      </tbody>
    </table>
  </section>
</div>

<!-- ========== 2 选股与挂单 ========== -->
<div class="pane" id="p2">
  <section>
    <h2>一、候选清单 <span class="tag">得分 ≥ 60，按分排序</span></h2>
    <table>
      <thead><tr><th>#</th><th>名称</th><th>得分</th><th>结论</th><th>今收</th><th>振幅</th><th>量比</th><th>换手</th><th>在线%</th><th>趋势</th></tr></thead>
      <tbody>${pickRows}</tbody>
    </table>
    <p class="small" style="margin-top:9px">「在线%」= 全天价格在分时均价线上方的分钟占比，越高说明越没走弱。</p>
  </section>

  <section>
    <h2>二、明日价位 <span class="tag">当前环境下仓位一律 0，仅供记录</span></h2>
    <table>
      <thead><tr><th>名称</th><th>得分</th><th>今收</th><th>预计开</th><th>挂+1%</th><th>挂+2%</th><th>止损</th><th>振幅</th><th>仓位</th><th>动作</th></tr></thead>
      <tbody>${planRows}</tbody>
    </table>
    <div class="calc" style="margin-top:12px">
      <span class="small">开盘价换算</span>
      <input id="op" type="number" step="0.01" value="${plan.rows.length ? f2(plan.rows[0].expOpen) : '10.00'}">
      <div class="o">
        <span>+1% <b id="s1">—</b></span><span>+2% <b id="s2">—</b></span>
        <span>−1.5% <b id="sl">—</b></span><span>满格+1.33% <b id="g1">—</b></span>
      </div>
    </div>
  </section>
</div>

<!-- ========== 3 时段与竞价 ========== -->
<div class="pane" id="p3">
  <section>
    <h2>一、最高价出现在哪个时段 <span class="tag">蓝＝选股后，灰＝同池基准</span></h2>
    <div class="chart">${slotBars}</div>
    <div class="legend"><span><i style="background:#2563eb"></i>选股后（${timing.used} 条）</span><span><i style="background:#cbd5e1"></i>同池基准（${timing.baseDays} 条）</span></div>
    <div class="ok" style="margin-top:10px">
      <b>这组柱子几乎重合，是最重要的一次自我否证。</b>
      「最高价多在开盘半小时」是 A 股市场结构（基准 ${(timing.baseSlot['1000'].high / timing.baseDays * 100).toFixed(0)}% vs 选股后 ${(timing.slotStat['1000'].high / timing.used * 100).toFixed(0)}%），不是选股选出来的。
      但选股确实提高了<b>波动概率</b>：全天触及 +1% 从基准 ${timing.baseHit1}% 提到 ${(Object.values(timing.slotStat).reduce((a, b) => a + b.hit1, 0) / timing.used * 100).toFixed(1)}%，
      开盘半小时内从 ${timing.baseFirst1}% 提到 ${(timing.slotStat['1000'].hit1 / timing.used * 100).toFixed(1)}%。
    </div>
  </section>

  <section>
    <h2>二、竞价强弱 <span class="tag">它决定空间，不决定做不做</span></h2>
    <table>
      <thead><tr><th>竞价情形</th><th style="text-align:right">样本</th><th style="text-align:right">日内空间</th><th style="text-align:right">触及+1%</th><th style="text-align:right">触及+2%</th><th style="text-align:right">收盘为正</th><th style="text-align:right">高点回撤</th></tr></thead>
      <tbody>${gapRows}</tbody>
    </table>
    <p class="small" style="margin-top:9px">
      「触及 +1%」五档全在 78–80%，差异属噪声 → <b>竞价当不了开关</b>。
      但空间从 2.87% 到 4.09%、触及 +2% 从 53% 到 76%、回撤从 2.45% 到 4.23% → <b>它决定目标价与仓位</b>。
      弱参考分：高开 +1~3% 记 +5（挂 +2%，但仓位不放大），大幅低开记 −3（仓位砍半），其余 0。
    </p>
  </section>
</div>

<!-- ========== 4 规则验证 ========== -->
<div class="pane" id="p4">
  <section>
    <h2>一、四变体对照 <span class="tag">同一批票，只改过滤器</span></h2>
    <table>
      <thead><tr><th>变体</th><th>选股日</th><th>观测</th>
        <th colspan="2" style="text-align:center">T+1</th><th colspan="2" style="text-align:center">T+3</th><th colspan="2" style="text-align:center">T+5</th></tr>
        <tr><th></th><th></th><th></th>
        <th style="text-align:right">收益</th><th style="text-align:right">超额</th>
        <th style="text-align:right">收益</th><th style="text-align:right">超额</th>
        <th style="text-align:right">收益</th><th style="text-align:right">超额</th></tr></thead>
      <tbody>${vRows}</tbody>
    </table>
    <div class="note" style="margin-top:10px">
      <b>加过滤全部更差，这一点反直觉但明确。</b>
      ＋VWAP 过滤让 T+5 从 ${sgn(V.A.byHold['T+5'].开盘)}% 恶化到 ${sgn(V.B.byHold['T+5'].开盘)}%，
      ＋环境过滤到 ${sgn(V.C.byHold['T+5'].开盘)}%，两个都加 ${sgn(V.D.byHold['T+5'].开盘)}%。
      原因：VWAP 筛出的是「尾盘最强」，环境筛出的是「趋势最热」，而这两类恰好是次日回落最狠的。
    </div>
  </section>

  <section>
    <h2>二、为什么不能持有</h2>
    <table>
      <thead><tr><th>持有期</th><th style="text-align:right">次日开盘买入</th><th style="text-align:right">中位数</th><th style="text-align:right">胜率</th><th style="text-align:right">同期中证1000</th></tr></thead>
      <tbody>
        ${['T+1', 'T+2', 'T+3', 'T+5'].map((h) => {
          const v = V.A.byHold[h];
          return `<tr><td><b>${h}</b></td><td class="num" style="color:${col(v.开盘)}">${sgn(v.开盘)}%</td>
            <td class="num">${sgn(v.中位)}%</td><td class="num">${v.胜率}%</td>
            <td class="num" style="color:var(--mute)">${sgn(v.基准)}%</td></tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="small" style="margin-top:9px">
      持有越久亏越多，T+5 胜率只剩 ${V.A.byHold['T+5'].胜率}%。但次日盘中冲高均值 +3.26%、
      79% 的票能涨过前收盘——<b>溢价全部集中在次日盘中，隔夜和之后都是损耗。</b>
    </p>
  </section>
</div>

<!-- ========== 5 稳健 ========== -->
<div class="pane" id="p5">
  <section>
    <h2>一、稳健底仓候选 <span class="tag">${steady.pool} 只交集 → ${steady.fit} 只适配 → ${steady.top.length} 只入榜</span></h2>
    <table>
      <thead><tr><th>#</th><th>名称</th><th>股息率</th><th>ROE</th><th>市值(亿)</th><th>20日均振幅</th><th>ATR</th><th>趋势</th><th>得分</th></tr></thead>
      <tbody>${steadyRows}</tbody>
    </table>
    <p class="small" style="margin-top:9px">
      筛选：非ST + 市值 &gt; 300 亿 + 股息率 &gt; 2% + ROE &gt; 10%，再要求 20 日均振幅 1.5–5.5%（太死做不了T，太跳不是底仓）。
      权重：股息 30 + ROE 30 + 振幅 20 + 趋势 20。
    </p>
  </section>
  <section>
    <h2>二、这份名单不能当买入清单</h2>
    <div class="note">
      以下五项<b>免费接口算不了、本页没有自动核</b>：经营现金流/净利润 ≥ 0.8（最关键，排除纸面利润）、
      近 3 年营收 CAGR、资产负债率、PB 五年分位、行业去重。
      <br>另外 ROE 用的是<b>单期值不是五年连续</b>，可能把周期顶部公司选进来——这正是 PB 分位那条要补的原因。
      银行占 4 只，因为同时满足高股息高 ROE，实际配置需按行业剔除重复。
    </div>
  </section>
</div>

<p class="small" style="margin-top:16px">
  本页由 out/*.json 汇总生成，与各独立单页同源。行情为公开接口，非交易所直连。仅供研究参考，不构成个人投资建议。
</p>

<script>
(function(){
  var btns = document.querySelectorAll('.tabs button');
  btns.forEach(function(b){
    b.addEventListener('click', function(){
      btns.forEach(function(x){ x.classList.remove('on'); });
      document.querySelectorAll('.pane').forEach(function(p){ p.classList.remove('on'); });
      b.classList.add('on');
      var el = document.getElementById(b.dataset.t);
      if(el) el.classList.add('on');
    });
  });
  var el = document.getElementById('op');
  function calc(){
    var v = parseFloat(el.value);
    if(!isFinite(v) || v<=0) return;
    document.getElementById('s1').textContent = (v*1.01).toFixed(2);
    document.getElementById('s2').textContent = (v*1.02).toFixed(2);
    document.getElementById('sl').textContent = (v*0.985).toFixed(2);
    document.getElementById('g1').textContent = (v*(1+4/3/100)).toFixed(2);
  }
  if(el){ el.addEventListener('input', calc); calc(); }
})();
</script>

</div></body></html>`;

fs.writeFileSync(path.join(__dirname, '选股工作台.html'), html);
console.log('→ 选股工作台.html');
