/**
 * steady-report.js —— 稳健型（底仓候选）清单页
 */
const fs = require('fs');
const path = require('path');
const S = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'steady.json'), 'utf8'));
const SUB_DATE = S.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const { pool, rows, fit, top } = S;

const trendPill = (t) => t === '多头' ? 'p-ok' : t === '整理' ? 'p-wait' : 'p-bad';
const sc = (v) => v >= 90 ? 'var(--down)' : v >= 80 ? 'var(--info)' : 'var(--text)';

const trs = top.map((r, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td class="nm">${r.name}<span class="cd">${r.code}</span></td>
  <td class="num up">${r.div.toFixed(1)}%</td>
  <td class="num">${r.roe.toFixed(1)}%</td>
  <td class="num">${r.mv}</td>
  <td class="num">${r.amp20.toFixed(1)}%</td>
  <td class="num">${r.atrPct.toFixed(1)}%</td>
  <td class="num" style="color:${r.chg20 > 0 ? 'var(--up)' : 'var(--down)'}">${r.chg20 > 0 ? '+' : ''}${r.chg20}%</td>
  <td><span class="pill ${trendPill(r.trend)}">${r.trend}</span></td>
  <td class="num sc" style="color:${sc(r.score)}">${r.score}</td>
</tr>`).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>稳健型清单 · 底仓候选</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
--text:#1f2328;--sub:#515c69;--mute:#66707c;--up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
--info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;--shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:26px 18px 60px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 18px}
.funnel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.fs{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:9px 13px;box-shadow:var(--shadow)}
.fs .n{font-size:19px;font-weight:700;letter-spacing:-.3px}
.fs .l{font-size:11.5px;color:var(--mute);margin-top:1px}
.arw{color:var(--line2);font-size:16px}
.key{border-radius:10px;padding:13px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.85;
background:var(--info-bg);border:1px solid var(--info-b);color:#1e3a8a}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11.5px;padding:7px 5px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid var(--hair);white-space:nowrap}
tr:hover td{background:var(--surface2)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nm{font-weight:600}
.cd{color:var(--mute);font-weight:400;font-size:11px;margin-left:5px}
.up{color:var(--up);font-weight:600}
.sc{font-weight:700}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid;white-space:nowrap}
.p-ok{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-wait{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-b)}
.p-bad{color:#991b1b;background:#fef2f2;border-color:#fecaca}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:11px 13px;font-size:12.5px;color:#6b4a00;line-height:1.8}
.small{font-size:12px;color:var(--mute);line-height:1.75}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.rule li{font-size:12.5px;line-height:1.9;color:var(--sub)}
.rule b{color:var(--text)}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
</style></head><body><div class="wrap">

<h1>稳健型清单 · 底仓候选</h1>
<p class="sub">${SUB_DATE} · 非ST · 总市值 &gt; 300 亿 · 股息率 &gt; 2% · ROE &gt; 10% · 振幅可做T</p>

<div class="funnel">
  <div class="fs"><div class="n">${pool}</div><div class="l">股息+市值+ROE 交集</div></div>
  <span class="arw">→</span>
  <div class="fs"><div class="n">${fit}</div><div class="l">振幅 1.5–5.5% 适配</div></div>
  <span class="arw">→</span>
  <div class="fs"><div class="n">${top.length}</div><div class="l">四维打分入榜</div></div>
</div>

<div class="key">
  <b>这份清单和短线清单是两套完全独立的规则，不要混用。</b><br>
  它筛的是「拿得住、且有波动可做T」的底仓标的——<b>不看当日涨幅，不看量比，不看涨停</b>。
  上一轮已经证明：用动量条件筛出来的票只能做T不能持有；反过来，能持有的票也绝不会出现在短线清单里。
  两套池子必须物理隔离。
</div>

<section>
  <h2>一、入榜名单 <span class="small">按四维得分排序</span></h2>
  <table>
    <thead><tr>
      <th>#</th><th>名称</th><th>股息率</th><th>ROE</th><th>市值(亿)</th>
      <th>20日均振幅</th><th>ATR</th><th>20日涨幅</th><th>趋势</th><th>得分</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    打分权重：股息率 30 + ROE 30 + 振幅适配 20 + 趋势 20。
    振幅一栏是<b>刻意保留的门槛</b>——稳健不等于死水，20 日均振幅低于 1.5% 的票做T连手续费都赚不回，
    高于 5.5% 的又不是底仓该有的性格。2–4% 是这类标的的舒适区。
  </p>
</section>

<section>
  <h2>二、筛选口径</h2>
  <div class="grid2">
    <div>
      <div class="small" style="margin-bottom:6px"><b>已经自动计算的</b></div>
      <ul class="rule">
        <li><b>总市值 ≥ 300 亿</b>：流动性 + 抗操纵，10 万级资金进出无冲击</li>
        <li><b>股息率 ≥ 2%</b>：愿不愿意分钱是态度问题，也是底仓的现金流来源</li>
        <li><b>ROE ≥ 10%</b>：用 2026Q3 加权 ROE，单期值不是五年均值</li>
        <li><b>20 日均振幅 1.5%–5.5%</b>：决定了这票"能不能做T"</li>
        <li><b>趋势与 MA20 方向</b>：价在 MA60 上方且 MA20 上行记为多头</li>
      </ul>
    </div>
    <div>
      <div class="small" style="margin-bottom:6px"><b>还需要你人工核的（本页未自动算）</b></div>
      <ul class="rule">
        <li><b>经营现金流 / 净利润 ≥ 0.8</b>：排除纸面利润，这条最关键</li>
        <li><b>近 3 年营收 CAGR 在 0–30%</b>：太低无成长，太高不可持续</li>
        <li><b>资产负债率 &lt; 行业均值 + 10pct</b></li>
        <li><b>PB 近 5 年分位 &lt; 70%</b>：避开周期顶部</li>
        <li><b>管理层五查</b>：减持、质押、商誉、承诺、分红连续性</li>
      </ul>
    </div>
  </div>
  <div class="note" style="margin-top:12px">
    后五项缺数据源（免费接口不提供财务明细），<b>不是它们不重要，而是本页算不了</b>。
    按《长线做T选股》的原始口径，"经营现金流/净利润"是排除纸面利润的核心一条，
    在补上之前，这份名单只能当<b>候选池</b>，不能当<b>买入清单</b>。
  </div>
</section>

<section>
  <h2>三、与短线清单的分工</h2>
  <table>
    <thead><tr><th></th><th>稳健型（本页）</th><th>短线热点</th></tr></thead>
    <tbody>
      <tr><td>赚什么钱</td><td>分红 + 估值修复 + 少量T</td><td>情绪波动的价差</td></tr>
      <tr><td>持仓周期</td><td>1 个季度以上</td><td>1–5 个交易日，且只做T不持有</td></tr>
      <tr><td>筛选起点</td><td>财务质量（股息/ROE/现金流）</td><td>当日涨幅 + 量能 + 涨停史</td></tr>
      <tr><td>做T频率</td><td>每周 1–2 次</td><td>每日，开盘半小时内完成</td></tr>
      <tr><td>止损依据</td><td>逻辑破坏（季度三查）</td><td>固定 −1.5%</td></tr>
      <tr><td>失败模式</td><td>买在周期顶部，长期阴跌</td><td>追高接盘，一日游</td></tr>
    </tbody>
  </table>
</section>

<section>
  <h2>四、局限</h2>
  <div class="note">
    <b>① ROE 用的是单季/单期加权值，不是五年连续。</b>《长线做T选股》要求"连续 5 年 ROE ≥ 10%"，本页只能给当期，
    意味着<b>可能把周期顶部的公司选进来</b>——这正是"PB 分位 &lt; 70%"那条要补的原因。<br>
    <b>② 股息率取的是 2025 年报口径</b>，不是最新 12 个月，若今年分红政策变化会失真。<br>
    <b>③ 振幅取近 20 日</b>，短期窗口受行情影响大；判"股性"更该用 60 日或半年。<br>
    <b>④ 名单里银行占比偏高</b>（成都、杭州、南京、江苏金租），因为银行同时满足高股息 + 高 ROE。
    如果已有银行持仓，需要按行业做重复度剔除——本页未做行业去重。<br>
    <b>⑤ 本页不是买入清单</b>，只是把 44 只压缩到 12 只，剩下的五项财务核查与行业分散要人工完成。
  </div>
</section>

<p class="small" style="margin-top:14px">数据：iFinD 智能选股（股息率 / ROE / 市值）+ 东财/腾讯/新浪三级容错日K（振幅 / ATR / 均线）。本页仅供研究参考，不构成个人投资建议。</p>

</div></body></html>`;

fs.writeFileSync(path.join(__dirname, '稳健清单_底仓候选.html'), html);
console.log('→ 稳健清单_底仓候选.html');
