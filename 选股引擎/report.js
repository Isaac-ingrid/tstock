/**
 * report.js —— 用已落盘的明细重算打分并生成看板（不联网）
 * 用法：node report.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const { scoreStock } = require('./score');

const OUT = path.join(__dirname, 'out');
const date = process.argv[2] || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const src = path.join(OUT, `${date}.json`);
if (!fs.existsSync(src)) { console.error('找不到明细：' + src); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));

/* ---- 重算打分 ---- */
const rows = raw.results.map((r) => {
  const sc = scoreStock(r);
  return { ...r, parts: sc.parts, score: sc.total, verdict: sc.verdict };
}).sort((a, b) => b.score - a.score);

const strictPass = rows.filter((r) => r.vw && r.vw.strictPass);
const stat = {
  universe: raw.total,
  funnel: raw.funnel,
  hard: raw.hardPass.length,
  deep: rows.length,
  strict: strictPass.length,
  doable: rows.filter((r) => r.score >= 80).length,
  small: rows.filter((r) => r.score >= 70 && r.score < 80).length,
  watch: rows.filter((r) => r.score >= 60 && r.score < 70).length,
};

fs.writeFileSync(path.join(OUT, `${date}.rescored.json`), JSON.stringify({ date, stat, rows }, null, 1));

/* ---- 控制台 ---- */
const W = [10, 9, 7, 6, 6, 8, 7, 8, 6, 6, 5, 6];
const H = ['名称', '代码', '涨幅%', '量比', '换手%', '总市值', '在线%', '破线分', '涨停日', '回落%', '得分', '结论'];
console.log(`\n${date} 打分版（重算）  ${rows.length} 只\n`);
console.log(H.map((h, i) => h.padEnd(W[i])).join(''));
console.log('─'.repeat(80));
for (const r of rows.slice(0, 20)) {
  const c = [r.name.slice(0, 5), r.code, r.chgPct.toFixed(2), r.volRatio.toFixed(2), r.turnover.toFixed(1),
    r.totalCap.toFixed(0), (r.vw?.onlineRatio ?? '-').toString(), (r.vw?.belowAfter10 ?? '-').toString(),
    r.kl.hit.date.slice(5), r.kl.pullback.toFixed(1), r.score, r.verdict];
  console.log(c.map((x, i) => String(x).padEnd(W[i])).join(''));
}
console.log(`\n可做 ${stat.doable}｜小做 ${stat.small}｜观察 ${stat.watch}｜严格版(VWAP始终不破) ${stat.strict}`);

/* ---- 生成 HTML ---- */
const upColor = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--mute)');
const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');

const sectorsUp = [
  ['航天装备Ⅱ', 6.84], ['煤炭开采', 2.42], ['城商行Ⅱ', 2.39], ['国有大型银行Ⅱ', 2.39],
  ['风电设备', 2.33], ['保险Ⅱ', 1.76], ['白酒Ⅱ', 1.51],
];
const sectorsDown = [
  ['通信设备', -8.94], ['元件', -8.07], ['玻璃玻纤', -5.33], ['其他电子Ⅱ', -5.30],
  ['半导体', -5.13], ['自动化设备', -5.01], ['消费电子', -4.74],
];

const funRows = Object.entries(raw.funnel).map(([k, v]) => {
  const w = (v / raw.total) * 100;
  return `<div class="frow"><span class="fk">${k}</span>
    <span class="fbar"><i style="width:${Math.max(w, 0.6)}%"></i></span>
    <span class="fv">${v}</span></div>`;
}).join('');

const trs = rows.slice(0, 15).map((r, i) => {
  const v = r.vw || {};
  return `<tr>
    <td class="num">${i + 1}</td>
    <td class="nm">${r.name}<span class="cd">${r.code}</span></td>
    <td class="num" style="color:${upColor(r.chgPct)}">+${fmt(r.chgPct)}%</td>
    <td class="num">${fmt(r.volRatio)}</td>
    <td class="num">${fmt(r.turnover, 1)}%</td>
    <td class="num">${fmt(r.totalCap, 0)}</td>
    <td class="num ${v.onlineRatio >= 85 ? 'good' : v.onlineRatio < 60 ? 'bad' : ''}">${fmt(v.onlineRatio, 1)}%</td>
    <td class="num">${v.belowAfter10 ?? '—'}</td>
    <td class="num">${r.kl.hit.date.slice(5)}<span class="cd">${r.kl.pullback > 0 ? '回落' + fmt(r.kl.pullback, 0) + '%' : '新高'}</span></td>
    <td class="num sc">${r.score}</td>
    <td><span class="pill ${r.verdict === '可做' ? 'p-do' : r.verdict === '小做' ? 'p-small' : r.verdict === '观察' ? 'p-watch' : 'p-no'}">${r.verdict}</span></td>
  </tr>`;
}).join('');

const partLabels = { chg: '涨幅', limitUp: '涨停史', vol: '量能', turn: '换手', cap: '市值', vwap: 'VWAP' };
const maxes = { chg: 20, limitUp: 20, vol: 20, turn: 15, cap: 10, vwap: 15 };
const top3 = rows.slice(0, 3).map((r) => `
  <div class="card">
    <div class="ctop"><b>${r.name}</b><span class="cd">${r.code}</span>
      <span class="pill ${r.verdict === '可做' ? 'p-do' : 'p-small'}">${r.verdict} ${r.score}</span></div>
    <table class="mini">${Object.entries(r.parts).map(([k, v]) => `
      <tr><td class="mk">${partLabels[k]}</td>
        <td class="mb"><i style="width:${(v / maxes[k]) * 100}%;background:${v / maxes[k] >= 0.8 ? 'var(--info)' : v / maxes[k] >= 0.4 ? 'var(--teal)' : 'var(--warn)'}"></i></td>
        <td class="mv">${v}<span class="cd">/${maxes[k]}</span></td></tr>`).join('')}
    </table>
    <div class="cnote">涨停 ${r.kl.hit.date.slice(5)} 收 ${r.kl.hit.close}${r.kl.brokeLow ? '（已破涨停日低点）' : ''}｜均价 ${fmt(r.vw?.lastVwap)}｜首次破线 ${r.vw?.firstBreach ?? '—'}</div>
  </div>`).join('');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>选股引擎 · ${date} 候选清单</title>
<style>
:root{
  --bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
  --text:#1f2328;--sub:#515c69;--mute:#66707c;
  --up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
  --info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;
  --teal:#0e7490;--teal-bg:#eff9fb;--accent:#7c3aed;
  --shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:26px 18px 60px}
h1{font-size:23px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:var(--shadow)}
.kpi .k{font-size:12px;color:var(--mute)}
.kpi .v{font-size:24px;font-weight:700;letter-spacing:-.5px;margin-top:2px}
.kpi .v small{font-size:12px;font-weight:400;color:var(--mute);margin-left:3px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h2 .tag{font-size:11px;font-weight:400;color:var(--mute);background:var(--surface2);padding:1px 7px;border-radius:99px}
.frow{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:13px}
.fk{width:170px;color:var(--sub);flex:none}
.fbar{flex:1;height:14px;background:var(--surface2);border-radius:4px;overflow:hidden}
.fbar i{display:block;height:100%;background:linear-gradient(90deg,#93c5fd,#2563eb);border-radius:4px}
.fv{width:56px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:12px;padding:7px 6px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:7px 6px;border-bottom:1px solid var(--hair);white-space:nowrap}
tr:hover td{background:var(--surface2)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nm{font-weight:600}
.cd{color:var(--mute);font-weight:400;font-size:11px;margin-left:5px;display:inline}
.good{color:var(--info);font-weight:600}
.bad{color:var(--warn);font-weight:600}
.sc{font-weight:700;font-size:14px}
.pill{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;border:1px solid}
.p-do{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-small{color:var(--info);background:var(--info-bg);border-color:var(--info-b)}
.p-watch{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-b)}
.p-no{color:var(--mute);background:var(--surface2);border-color:var(--line2)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.card{border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:var(--surface)}
.ctop{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13.5px}
.ctop .pill{margin-left:auto}
.mini{font-size:12px}
.mini td{border:none;padding:2px 0}
.mk{color:var(--sub);width:46px}
.mb{width:auto;padding:0 8px!important}
.mb i{display:block;height:7px;border-radius:3px}
.mv{width:44px;text-align:right;font-variant-numeric:tabular-nums}
.cnote{font-size:11.5px;color:var(--mute);margin-top:7px;line-height:1.5}
.env{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.env li{list-style:none;display:flex;justify-content:space-between;font-size:13px;padding:2px 0}
.env ul{margin:0;padding:0}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#6b4a00;line-height:1.7}
.ok{background:var(--info-bg);border:1px solid var(--info-b);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#1e3a8a;line-height:1.7}
.small{font-size:12px;color:var(--mute);line-height:1.7}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}.env{grid-template-columns:1fr}}
</style></head><body><div class="wrap">

<h1>选股引擎 · 今日候选清单</h1>
<p class="sub">${date}（收盘后）｜全市场扫描 · 六步法打分版｜数据：东财全市场快照 + 腾讯日K/分时</p>

<div class="kpis">
  <div class="kpi"><div class="k">扫描标的</div><div class="v">${stat.universe}<small>只</small></div></div>
  <div class="kpi"><div class="k">严格六步法幸存</div><div class="v">${stat.hard}<small>只</small></div></div>
  <div class="kpi"><div class="k">通过涨停史+VWAP</div><div class="v">${stat.deep}<small>只</small></div></div>
  <div class="kpi"><div class="k">VWAP 始终不破</div><div class="v" style="color:${stat.strict ? 'var(--down)' : 'var(--up)'}">${stat.strict}<small>只</small></div></div>
</div>

<section>
  <h2>一、漏斗：严格六步法逐级淘汰</h2>
  ${funRows}
  <div class="note" style="margin-top:12px">
    <b>结论：严格照原规则跑，今日候选为 0。</b>
    卡点在两处：① <b>涨幅 3–5%</b> 一步就砍掉 98.6%（2347 → 33），它是全流程最锋利的刀；
    ② <b>Step6「分时价格始终不低于均价线」</b>把最后的 ${stat.hard} 只也全部否掉——
    当日跌幅榜之外的强势股，几乎没有一只能在 242 根分钟线上一次都不碰均价线。
    这不是今天特例，是规则本身的机制性冲突（详见评估文档 2.1）。
  </div>
</section>

<section>
  <h2>二、市场环境 <span class="tag">决定今天做不做、做多重</span></h2>
  <div class="env">
    <div>
      <div class="small" style="margin-bottom:4px"><b>强势板块（申万二级）</b></div>
      <ul>${sectorsUp.map(([n, v]) => `<li><span>${n}</span><b style="color:var(--up)">+${v}%</b></li>`).join('')}</ul>
    </div>
    <div>
      <div class="small" style="margin-bottom:4px"><b>弱势板块</b></div>
      <ul>${sectorsDown.map(([n, v]) => `<li><span>${n}</span><b style="color:var(--down)">${v}%</b></li>`).join('')}</ul>
    </div>
  </div>
  <div class="note" style="margin-top:12px">
    <b>环境判定：退潮 + 高低切换。</b>半导体 −5.13%、通信设备 −8.94%、元件 −8.07% 是杀跌主力，
    资金转向航天装备（+6.84%）、煤炭、银行、保险——典型的防御性切换。
    按《短线选股.md》情绪温度五档，今天属于<b>退潮期</b>，可用仓位 0–20%，本清单只能当观察用，不构成当日买入依据。
  </div>
</section>

<section>
  <h2>三、打分版候选 <span class="tag">放宽至 2.5–6%，按 100 分排序</span></h2>
  <table>
    <thead><tr><th>#</th><th>名称</th><th>涨幅</th><th>量比</th><th>换手</th><th>市值(亿)</th><th>在线%</th><th>10点后破线</th><th>涨停日</th><th>得分</th><th>结论</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    「在线%」= 全天价格在均价线上方的分钟占比；「10点后破线」= 10:00 之后跌破均价线的分钟数（判定用）。
    「涨停日」下方的「回落/新高」= 当前价相对 30 日内最近一次涨停收盘价的位置。
  </p>
</section>

<section>
  <h2>四、前三名分项拆解 <span class="tag">为什么是它</span></h2>
  <div class="cards">${top3}</div>
</section>

<section>
  <h2>五、口径与局限（必读）</h2>
  <div class="ok">
    <b>这一版做了什么：</b>把六步法从「硬过滤」改为「加权打分」，并对 Step6 做了容差化处理
    （10:00 后累计破线 ≤ 5 分钟），同时对「高量比 + 价格长期在均价下方」加了出货惩罚。
    打分权重：涨幅 20 / 涨停史 20 / 量能 20 / 换手 15 / 市值 10 / VWAP 15。
  </div>
  <div class="note" style="margin-top:10px">
    <b>这一版没做什么：</b>① 没有历史回测，权重是机制推演值，未经样本验证；
    ② 涨停史按前复权日K判定，除权日附近可能误判；
    ③ 未接入主线题材与梯队判定（短线选股 L2 层），所以「是不是真热点」还没验证；
    ④ 稳健型清单未生成（缺 ROE / 现金流 / 股息率字段，需另接财务接口）。
  </div>
  <p class="small" style="margin-top:10px">
    数据源：全市场快照（东财 clist，${stat.universe} 只）；日K 与分时（腾讯）。行情为公开接口，非交易所直连。
    本页仅供研究参考，不构成个人投资建议。
  </p>
</section>

</div></body></html>`;

const outHtml = path.join(__dirname, `今日候选_${date}.html`);
fs.writeFileSync(outHtml, html);
console.log(`\n看板 → ${outHtml}`);
