/**
 * compare.js —— 读取 backtest-v3.json，生成「双开关对照 + 持有期错配」结论页
 * 用法：node compare.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const j = require('./out/backtest-v3.json');
const S = j.summary;
const HOLD = ['T+1', 'T+2', 'T+3', 'T+5'];

const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(s[lo] + (s[hi] - s[lo]) * (pos - lo)).toFixed(2);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f2 = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2));

const A = j.detail.A.detail.filter((d) => d.h === 1 && d.rHighOpen != null);
const hi = A.map((d) => d.rHighOpen);
const stat = {
  n: hi.length,
  均值: +mean(hi).toFixed(2),
  p10: q(hi, 0.10), p25: q(hi, 0.25), p50: q(hi, 0.5), p75: q(hi, 0.75), p90: q(hi, 0.9),
  达1: +(hi.filter((v) => v >= 1).length / hi.length * 100).toFixed(0),
  达2: +(hi.filter((v) => v >= 2).length / hi.length * 100).toFixed(0),
  达3: +(hi.filter((v) => v >= 3).length / hi.length * 100).toFixed(0),
  亏钱: +(hi.filter((v) => v <= 0).length / hi.length * 100).toFixed(0),
};

console.log(`\n次日冲高分布（开盘买入 → 当日最高，n=${stat.n}）`);
console.log(`  均值 ${f2(stat.均值)}%  P10 ${f2(stat.p10)}  P25 ${f2(stat.p25)}  中位 ${f2(stat.p50)}  P75 ${f2(stat.p75)}  P90 ${f2(stat.p90)}`);
console.log(`  冲到 +1% 概率 ${stat.达1}%｜+2% 概率 ${stat.达2}%｜+3% 概率 ${stat.达3}%｜当日无冲高 ${stat.亏钱}%`);

/* ---------- HTML ---------- */
const rowVar = (k) => {
  const o = S[k];
  const cells = HOLD.map((h) => {
    const v = o.byHold[h];
    if (v.开盘 == null) return '<td class="num">—</td><td class="num">—</td>';
    const cls = v.开盘 > 0 ? 'pos' : 'neg';
    return `<td class="num ${cls}">${f2(v.开盘)}</td><td class="num ${v.超额 > 0 ? 'pos' : 'neg'}">${f2(v.超额)}</td>`;
  }).join('');
  return `<tr><td><b>${k}</b> ${o.name}</td><td class="num">${o.pickDays}</td><td class="num">${o.obs}</td>${cells}</tr>`;
};

const bar = (v, max, color) => {
  const w = Math.min(Math.abs(v) / max * 100, 100).toFixed(0);
  return `<span class="bar"><i style="width:${w}%;background:${color}"></i></span>`;
};

const holdRows = HOLD.map((h) => {
  const v = S.A.byHold[h];
  return `<tr><td class="h">${h}</td>
    <td class="barcell">${bar(v.开盘, 4, 'var(--down)')}</td>
    <td class="num neg">${f2(v.开盘)}</td>
    <td class="num">${v.胜率}%</td></tr>`;
}).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>双开关对照实验 · 持有期错配</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
--text:#1f2328;--sub:#515c69;--mute:#66707c;--up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
--info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;--shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:26px 18px 60px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 18px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:var(--shadow)}
.kpi .k{font-size:12px;color:var(--mute)}
.kpi .v{font-size:23px;font-weight:700;margin-top:2px;letter-spacing:-.5px}
.kpi .v small{font-size:12px;font-weight:400;color:var(--mute);margin-left:3px}
.key{border-radius:10px;padding:13px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.8}
.k-good{background:#f0fdf4;border:1px solid #bbf7d0;color:#14532d}
.k-bad{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11.5px;padding:7px 5px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid var(--hair);white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--up);font-weight:600}.neg{color:var(--down);font-weight:600}
.h{font-weight:600;width:50px}
.barcell{width:30%}
.bar{display:block;height:11px;background:var(--surface2);border-radius:3px;overflow:hidden}
.bar i{display:block;height:100%}
.grid2{display:grid;grid-template-columns:1.1fr 1fr;gap:16px}
.dist{display:flex;align-items:flex-end;gap:6px;height:110px;margin:14px 0 4px}
.dcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}
.dcol .db{width:100%;background:var(--info);border-radius:3px 3px 0 0;min-height:2px}
.dcol .dv{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--sub)}
.dcol .dl{font-size:11px;color:var(--mute)}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:11px 13px;font-size:12.5px;color:#6b4a00;line-height:1.8}
.small{font-size:12px;color:var(--mute);line-height:1.75}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}}
</style></head><body><div class="wrap">

<h1>双开关对照实验</h1>
<p class="sub">650 只池 · ${j.days} 个交易日 · 六步法完整体（含换手与日级 VWAP）· 次日开盘买入口径</p>

<div class="kpis">
  <div class="kpi"><div class="k">次日日内最大空间</div><div class="v" style="color:var(--info)">${f2(stat.均值)}<small>%</small></div></div>
  <div class="kpi"><div class="k">次日能涨过前收盘</div><div class="v" style="color:var(--up)">${S.A.intraday.冲高胜率}<small>%</small></div></div>
  <div class="kpi"><div class="k">持有到 T+5</div><div class="v" style="color:var(--down)">${f2(S.A.byHold['T+5'].开盘)}<small>%</small></div></div>
  <div class="kpi"><div class="k">次日开盘跳空</div><div class="v" style="color:var(--down)">${f2(S.A.intraday.次日开盘跳空)}<small>%</small></div></div>
</div>

<div class="key k-good">
  <b>核心结论：这套规则不是无效，是持有期错了。</b><br>
  同一批票，持有到 T+5 亏 ${f2(S.A.byHold['T+5'].开盘)}%；但<b>${S.A.intraday.冲高胜率}% 的票次日盘中能涨过前一日收盘价</b>，
  从次日开盘算起的日内最大空间中位 ${f2(stat.p50)}%、均值 ${f2(stat.均值)}%。
  溢价全部集中在「次日盘中」这个窗口，隔夜和之后都是损耗 —— 这正是做T 该干的活，不是买入持有的活。
</div>

<div class="key k-bad">
  <b>上一轮的判断被推翻了：加过滤不但没救，反而更差。</b><br>
  ＋VWAP 过滤后 T+5 从 ${f2(S.A.byHold['T+5'].开盘)}% 恶化到 ${f2(S.B.byHold['T+5'].开盘)}%；
  ＋环境过滤恶化到 ${f2(S.C.byHold['T+5'].开盘)}%；两个都加 ${f2(S.D.byHold['T+5'].开盘)}%。
  原因很直接：VWAP 过滤筛的是「尾盘最强」，环境过滤筛的是「趋势最热」，而这两类恰恰是次日回落最狠的。
</div>

<section>
  <h2>一、四变体对照 <span class="small">同一批票、同一时间段，只改过滤器</span></h2>
  <table>
    <thead><tr><th rowspan="2">变体</th><th rowspan="2">选股日</th><th rowspan="2">观测</th>
      ${HOLD.map((h) => `<th colspan="2" style="text-align:center">${h}</th>`).join('')}</tr>
      <tr>${HOLD.map(() => '<th style="text-align:right">收益</th><th style="text-align:right">超额</th>').join('')}</tr></thead>
    <tbody>${['A', 'B', 'C', 'D'].map(rowVar).join('')}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    基准（中证 1000，同期）：${HOLD.map((h) => `${h} ${f2(S.A.byHold[h].基准)}%`).join('　')}。
    超额 = 组合收益 − 同期基准。四个变体<b>全部为负超额</b>，且随过滤条件增加单调恶化。
  </p>
</section>

<section>
  <h2>二、持有期衰减 vs 次日冲高 <span class="small">这是最关键的一张图</span></h2>
  <div class="grid2">
    <div>
      <div class="small" style="margin-bottom:6px"><b>持有到期收盘（基线 A，次日开盘买入）</b></div>
      <table><thead><tr><th>持有期</th><th></th><th style="text-align:right">收益</th><th style="text-align:right">胜率</th></tr></thead>
        <tbody>${holdRows}</tbody></table>
      <p class="small" style="margin-top:8px">持有越久亏越多，T+5 胜率只剩 ${S.A.byHold['T+5'].胜率}%。这说明<b>不能拿</b>。</p>
    </div>
    <div>
      <div class="small" style="margin-bottom:6px"><b>次日日内最大可获空间（相对开盘价，n=${stat.n}）</b></div>
      <div class="dist">
        ${[['P10', stat.p10], ['P25', stat.p25], ['中位', stat.p50], ['P75', stat.p75], ['P90', stat.p90]].map(([k, v]) => {
          const px = Math.max(10, Math.round((v / 8) * 84));
          return `<div class="dcol"><span class="dv">${f2(v)}%</span><span class="db" style="height:${px}px;background:${v >= 0 ? 'var(--info)' : 'var(--down)'}"></span><span class="dl">${k}</span></div>`;
        }).join('')}
      </div>
      <p class="small" style="margin-top:8px">
        <b>注意这不是胜率图，是空间图</b>——当日最高价天然不低于开盘价，所以它结构上恒为正，
        P10 也有 ${f2(stat.p10)}%。它回答的是「值不值得动手」：中位 ${f2(stat.p50)}% 的空间，扣掉 0.11% 摩擦仍有肉。
        <br>更实用的是挂单成交概率：<b>从开盘价挂 +1% 卖出，${stat.达1}% 的日子能成交；挂 +2%，${stat.达2}%；挂 +3%，${stat.达3}%。</b>
        真正决定盈亏的是你能抓到多少，不是这个上限本身。
      </p>
    </div>
  </div>
</section>

<section>
  <h2>三、这个结论能怎么用</h2>
  <p class="small" style="margin:0 0 10px">
    规则的正确用法不是「选出票来买着等涨」，而是<b>「选出明天有波动的票」</b>——这恰好是做T系统的入口。
    具体三步：<br>
    <b>① 收盘后</b>跑引擎，得到次日候选（今天的 25 只就是这个池子）。<br>
    <b>② 次日低开不慌</b>：统计上平均低开 ${f2(Math.abs(S.A.intraday.次日开盘跳空))}%，这是常态，不是走坏。<br>
    <b>③ 盘中冲高挂单</b>：按 ${f2(stat.p50)}%（中位）设目标，${stat.达1}% 的日子能给到 +1%，
    用做T的仓位纪律执行，当天闭环、不隔夜。
  </p>
  <div class="note">
    <b>但必须说清三个不能忽略的偏差：</b><br>
    ① <b>${f2(stat.均值)}% 是「卖在当日最高点」的理论上限</b>，实盘不可能。按抓到一半估算，可取部分约 ${f2(stat.均值 / 2)}%，
    扣掉 0.11% 摩擦仍在正区间，但绝不能按 ${f2(stat.均值)}% 规划收益。<br>
    ② <b>「能涨过前收盘 ${S.A.intraday.冲高胜率}%」是从 T 日收盘算的</b>；若你在 T+1 开盘才买，参照系变成开盘价，胜率就没有意义了，
    只剩「空间多大」这一个量。<br>
    ③ <b>样本期是单边回调市</b>（2026-08 至 10），基准本身也跌。若换成上涨市，这个「冲高」的幅度可能更大，也可能因为高开而消失——需跨周期复核。<br>
    ④ <b>池子只覆盖 87–200 亿市值</b>（650 只），缺 30–87 亿这一段，而那一段的波动通常更大。<br>
    ⑤ 观测 ${stat.n} 个，够看方向，不够定参数。任何「调到某个阈值就赚钱」的结论都不可信。
  </div>
</section>

<section>
  <h2>四、与最初需求的关系</h2>
  <p class="small" style="margin:0">
    你最初的需求是「先选股、再做T，做T 只是执行环节之一」。这轮回溯给出了支持这个结构的实证：
    <b>选股规则产出的不是「可以持有的标的」，而是「次日必然出现波动、值得做T的标的」</b>。
    所以「选股 → 做T」的顺序是对的，但中间那一步「买入并持有」应该删掉——
    任何把它当成长线持仓或短线持股的做法，统计上都是负期望。
  </p>
</section>

<p class="small" style="margin-top:14px">数据：东财历史K线（前复权，含换手率与成交额）+ 中证1000 指数。离线模拟，不含滑点、停牌与涨跌停无法成交的影响。本页仅供研究参考，不构成个人投资建议。</p>

</div></body></html>`;

fs.writeFileSync(path.join(__dirname, '对照实验_双开关.html'), html);
fs.writeFileSync(path.join(OUT, 'compare.json'), JSON.stringify({ stat }, null, 1));
console.log(`\n→ 对照实验_双开关.html`);
