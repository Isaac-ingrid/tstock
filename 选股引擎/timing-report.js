/**
 * timing-report.js —— 「次日冲高时段」结论页（含全样本基准对照）
 */
const fs = require('fs');
const path = require('path');
const d = require('./out/timing.json');

const { used, slotStat, rows, slots, baseSlot, baseDays, baseGiveBack, baseUpClose, baseHit1, baseFirst1 } = d;
const pct = (n) => +(n / used * 100).toFixed(0);

const cumOf = (t) => {
  let acc = 0;
  return slots.map(([s]) => { acc += slotStat[s][`hit${t}`]; return { s, add: slotStat[s][`hit${t}`], acc }; });
};
const c1 = cumOf(1), c2 = cumOf(2), c3 = cumOf(3);
const pickHit1 = +((Object.values(slotStat).reduce((a, b) => a + b.hit1, 0) / used) * 100).toFixed(1);
const pickFirst1 = +((slotStat['1000'].hit1 / used) * 100).toFixed(1);
const pickGiveBack = +(rows.reduce((a, r) => a + r.giveBack, 0) / rows.length).toFixed(2);
const pickUpClose = +((rows.filter((r) => r.closePct > 0).length / rows.length) * 100).toFixed(1);
const after1030 = slots.slice(2).reduce((a, [s]) => a + slotStat[s].hit1, 0);

const maxV = Math.max(...slots.map(([s]) => Math.max(slotStat[s].high / used, baseSlot[s].high / baseDays))) * 100;
const chart = slots.map(([s, label]) => {
  const a = slotStat[s].high / used * 100;
  const b = baseSlot[s].high / baseDays * 100;
  return `<div class="grp">
    <div class="pair">
      <div class="col"><span class="bv">${a.toFixed(0)}</span><div class="bb blue" style="height:${Math.max(3, Math.round(a / maxV * 96))}px"></div></div>
      <div class="col"><span class="bv gray">${b.toFixed(0)}</span><div class="bb grey" style="height:${Math.max(3, Math.round(b / maxV * 96))}px"></div></div>
    </div>
    <div class="gl">${label}</div>
  </div>`;
}).join('');

const cumRow = (name, arr, color) => {
  const cells = arr.map((x) => {
    const w = (x.acc / used) * 100;
    return `<td><div class="cumb"><i style="width:${w}%;background:${color}"></i></div><span class="cumv">${pct(x.acc)}%</span></td>`;
  }).join('');
  return `<tr><td class="rl">${name}</td>${cells}</tr>`;
};

const cmpRow = (label, a, b, better) => {
  const diff = a - b;
  const good = better === 'high' ? diff > 0 : diff < 0;
  return `<tr><td>${label}</td><td class="num">${a}%</td><td class="num" style="color:var(--mute)">${b}%</td>
    <td class="num ${good ? 'pos' : 'neg'}">${diff > 0 ? '+' : ''}${diff.toFixed(1)}pp</td></tr>`;
};

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>次日冲高时段分析</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
--text:#1f2328;--sub:#515c69;--mute:#66707c;--up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
--info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;--shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:26px 18px 60px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 18px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:var(--shadow)}
.kpi .k{font-size:12px;color:var(--mute);line-height:1.4}
.kpi .v{font-size:22px;font-weight:700;margin-top:3px;letter-spacing:-.5px}
.kpi .v small{font-size:11.5px;font-weight:400;color:var(--mute);margin-left:2px}
.kpi .d{font-size:11.5px;color:var(--mute);margin-top:2px}
.key{border-radius:10px;padding:13px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.85}
.k-good{background:#f0fdf4;border:1px solid #bbf7d0;color:#14532d}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 14px}
.chart{display:flex;align-items:flex-end;gap:4px;height:158px;padding-top:6px}
.grp{flex:1;display:flex;flex-direction:column;justify-content:flex-end}
.pair{display:flex;align-items:flex-end;gap:3px;justify-content:center}
.col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px}
.bv{font-size:9.5px;font-variant-numeric:tabular-nums;color:var(--info)}
.bv.gray{color:var(--mute)}
.bb{width:15px;border-radius:3px 3px 0 0}
.blue{background:#2563eb}.grey{background:#cbd5e1}
.gl{font-size:10px;color:var(--mute);text-align:center;margin-top:6px;white-space:nowrap}
.legend{display:flex;gap:16px;font-size:12px;color:var(--sub);margin-top:10px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11.5px;padding:6px 5px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:6px 5px;border-bottom:1px solid var(--hair);vertical-align:middle}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--up);font-weight:600}.neg{color:var(--down);font-weight:600}
.rl{font-weight:600;white-space:nowrap;width:56px}
.cumb{height:9px;background:var(--surface2);border-radius:3px;overflow:hidden;margin-bottom:2px}
.cumb i{display:block;height:100%}
.cumv{font-size:11px;color:var(--sub);font-variant-numeric:tabular-nums}
.steps{counter-reset:s;margin:0;padding:0;list-style:none}
.steps li{counter-increment:s;position:relative;padding:0 0 11px 30px;font-size:13px;line-height:1.75}
.steps li:before{content:counter(s);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:50%;
background:var(--info-bg);color:var(--info);border:1px solid var(--info-b);font-size:11.5px;font-weight:600;
display:flex;align-items:center;justify-content:center}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:11px 13px;font-size:12.5px;color:#6b4a00;line-height:1.8}
.small{font-size:12px;color:var(--mute);line-height:1.75}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.gl{font-size:8.5px}.bb{width:9px}}
</style></head><body><div class="wrap">

<h1>次日冲高 · 时段分析</h1>
<p class="sub">${used} 条选股记录（126 只标的 × 60 个交易日）vs ${baseDays} 条同池基准 · 30 分钟 K 线 · 相对次日开盘价</p>

<div class="kpis">
  <div class="kpi"><div class="k">开盘半小时现最高价</div><div class="v" style="color:var(--info)">${pct(slotStat['1000'].high)}<small>%</small></div><div class="d">基准 ${(baseSlot['1000'].high / baseDays * 100).toFixed(0)}%　几乎相同</div></div>
  <div class="kpi"><div class="k">开盘半小时触及 +1%</div><div class="v" style="color:var(--up)">${pickFirst1}<small>%</small></div><div class="d">基准 ${baseFirst1}%　高 ${(pickFirst1 - baseFirst1).toFixed(1)}pp</div></div>
  <div class="kpi"><div class="k">全天曾触及 +1%</div><div class="v" style="color:var(--up)">${pickHit1}<small>%</small></div><div class="d">基准 ${baseHit1}%　高 ${(pickHit1 - baseHit1).toFixed(1)}pp</div></div>
  <div class="kpi"><div class="k">高点后回撤</div><div class="v" style="color:var(--down)">−${pickGiveBack}<small>%</small></div><div class="d">基准 −${baseGiveBack}%　反而更大</div></div>
</div>

<div class="key k-good">
  <b>结论：选股提高的是「波动出现的概率」，既不是「波动出现的时间」，也不是「方向」。</b><br>
  把选股后的分布和同池基准叠在一起看，形状几乎完全重合（${pct(slotStat['1000'].high)}% vs ${(baseSlot['1000'].high / baseDays * 100).toFixed(0)}%）——
  说明「最高价多在开盘半小时」是 A 股的市场结构，不是选股选出来的。<br>
  但选股确实把两件事变好了：<b>全天出现 +1% 波动的概率从 ${baseHit1}% 提到 ${pickHit1}%（+${(pickHit1 - baseHit1).toFixed(1)}pp）</b>，
  <b>开盘半小时内出现的概率从 ${baseFirst1}% 提到 ${pickFirst1}%（+${(pickFirst1 - baseFirst1).toFixed(1)}pp）</b>。
  同时它没有改善方向——高点后回撤 ${pickGiveBack}%（基准 ${baseGiveBack}%），收盘为正 ${pickUpClose}%（基准 ${baseUpClose}%），都略差。
</div>

<section>
  <h2>一、最高价出现在哪个时段 <span class="small">蓝＝选股后，灰＝同池基准</span></h2>
  <div class="chart">${chart}</div>
  <div class="legend"><span><i style="background:#2563eb"></i>选股后（${used} 条）</span><span><i style="background:#cbd5e1"></i>同池基准（${baseDays} 条）</span></div>
  <p class="small" style="margin-top:10px">
    两根柱几乎一样高，这是本次分析最重要的反向检验：<b>如果只报「${pct(slotStat['1000'].high)}% 的最高点在开盘半小时」，
    很容易误以为这是选股的优势；实际上同一批股票在未被选中的日子，这个比例同样是 ${(baseSlot['1000'].high / baseDays * 100).toFixed(0)}%。</b>
    唯一有差异的是尾盘——选股后 14:30–15:00 只占 ${(slotStat['1500'].high / used * 100).toFixed(1)}%，基准 ${(baseSlot['1500'].high / baseDays * 100).toFixed(1)}%，
    选出来的票更少在尾盘创新高。
  </p>
</section>

<section>
  <h2>二、首次触及目标价的累计概率 <span class="small">选股后，相对开盘价</span></h2>
  <table>
    <thead><tr><th></th>${slots.map(([s, l]) => `<th style="text-align:left">${l.slice(0, 5)}</th>`).join('')}</tr></thead>
    <tbody>
      ${cumRow('+1%', c1, 'var(--info)')}
      ${cumRow('+2%', c2, '#60a5fa')}
      ${cumRow('+3%', c3, '#93c5fd')}
    </tbody>
  </table>
  <p class="small" style="margin-top:10px">
    这是<b>累计成交概率</b>：开盘就挂 +1% 卖单，到 10:00 有 ${pct(c1[0].acc)}% 成交，到 10:30 累计 ${pct(c1[1].acc)}%。
    <b>10:30 之后再等，只多出 ${(after1030 / used * 100).toFixed(1)} 个百分点。</b>
    +2% 全天最高 ${pct(c2.at(-1).acc)}%，+3% 只有 ${pct(c3.at(-1).acc)}%——挂 +3% 等于大部分时候不成交。
  </p>
</section>

<section>
  <h2>三、选股到底改善了哪几项 <span class="small">有变好的，也有变差的</span></h2>
  <table>
    <thead><tr><th>指标</th><th style="text-align:right">选股后</th><th style="text-align:right">基准</th><th style="text-align:right">差异</th></tr></thead>
    <tbody>
      ${cmpRow('开盘半小时触及 +1%', pickFirst1, baseFirst1, 'high')}
      ${cmpRow('全天触及 +1%', pickHit1, baseHit1, 'high')}
      ${cmpRow('高点后到收盘回撤', pickGiveBack, baseGiveBack, 'low')}
      ${cmpRow('收盘为正', pickUpClose, baseUpClose, 'high')}
    </tbody>
  </table>
  <p class="small" style="margin-top:10px">
    四项里两项变好、两项变差，而且变好的两项都是「波动概率」，变差的两项都是「方向」。
    这恰好解释了一个矛盾：<b>为什么做着T能赚、拿着就亏。</b>选股筛出的是"更容易波动"的票，
    不是"更容易上涨"的票——波动可以做T变现，方向不能。
  </p>
</section>

<section>
  <h2>四、具体怎么挂单</h2>
  <ol class="steps">
    <li><b>9:25 看竞价</b>：统计上次日平均低开 0.63%，低开是常态，不构成放弃理由。</li>
    <li><b>9:30 开盘即挂单</b>，目标价按<b>开盘价 +1%</b>（不是前一日收盘 +1%，参照系要换）。${pickFirst1}% 在半小时内能成交。</li>
    <li><b>10:30 没成交就撤</b>：之后只剩 ${(after1030 / used * 100).toFixed(1)} 个百分点的机会，不值得占着仓位。</li>
    <li><b>不守收盘</b>：高点后平均回撤 ${pickGiveBack}%，收盘为正只有 ${pickUpClose}%，当天闭环才是正解。</li>
    <li><b>想博 +2% 要单独设仓</b>：全天只有 ${pct(c2.at(-1).acc)}% 能到，属于"中了更好"，不能当主目标。</li>
  </ol>
</section>

<section>
  <h2>五、局限</h2>
  <div class="note">
    <b>① 30 分钟粒度。</b>分钟级历史数据免费源只能回溯 5 天，故用 30 分钟 K 线替代，「09:30–10:00」是一个整体，
    无法再细分到分钟。要更细只能每天归档当日分时慢慢积累。<br>
    <b>② 基准用的是同一批 126 只股票的其他交易日</b>，不是全市场。它回答的是"选股日 vs 同一批股票的非选股日"，
    这个对照比"vs 全市场"更严格，但也意味着结论适用范围限于中小盘（87–200 亿）。<br>
    <b>③ 样本 ${used} 条选股 + ${baseDays} 条基准</b>，够看形状，不够定精确阈值。<br>
    <b>④ 样本期是单边回调市</b>（2026 年 7–10 月），强势市里冲高可能更集中、回撤可能更小。<br>
    <b>⑤ 不含滑点与盘口厚度。</b>假设"触及即成交"，小市值票实际会有折损。<br>
    <b>⑥ 最高价是事后量。</b>这张图描述"空间在什么时候被用掉"，不等于"你一定能卖在那里"。
  </div>
</section>

<p class="small" style="margin-top:14px">数据：东财日K（选股条件）+ 腾讯 30 分钟 K 线（时段定位）。本页仅供研究参考，不构成个人投资建议。</p>

</div></body></html>`;

fs.writeFileSync(path.join(__dirname, '时段分析_次日冲高.html'), html);
console.log('→ 时段分析_次日冲高.html');
