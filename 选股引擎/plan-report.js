/**
 * plan-report.js —— 生成「明日挂单计划」页
 */
const fs = require('fs');
const path = require('path');
// 自动取 out/ 下最新一份 plan-YYYY-MM-DD.json，避免每天改日期
const latestPlan = fs.readdirSync(path.join(__dirname, 'out'))
  .filter((f) => /^plan-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .pop();
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', latestPlan), 'utf8'));
const { env, rows, baseDate } = P;
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'timing.json'), 'utf8'));
const gapStat = T.gapStat || [];

const f2 = (v) => Number(v).toFixed(2);
const cls = (c) => ({ ok: 'pill p-ok', wait: 'pill p-wait', warn: 'pill p-warn', bad: 'pill p-bad' }[c] || 'pill p-wait');
const good = rows.filter((r) => r.pos > 0);
const blocked = env.level !== 'OK';

const trs = rows.map((r) => `<tr class="${r.pos > 0 ? '' : 'dim'}">
  <td class="nm">${r.name}<span class="cd">${r.code}</span></td>
  <td class="num sc">${r.score}</td>
  <td><span class="pill ${r.verdict === '可做' ? 'p-do' : 'p-small'}">${r.verdict}</span></td>
  <td class="num">${f2(r.pc)}</td>
  <td class="num">${f2(r.expOpen)}</td>
  <td class="num up">${f2(r.sell1)}</td>
  <td class="num">${f2(r.sell2)}</td>
  <td class="num down">${f2(r.stop)}</td>
  <td class="num">${r.amp}%</td>
  <td><span class="${cls(r.g2.c)}">${r.g2.t}</span></td>
  <td class="num">${r.pos}%</td>
  <td class="act">${r.action}</td>
</tr>`).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>明日挂单计划 · ${baseDate}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e5e7eb;--line2:#cbd5e1;--surface:#fafbfc;--surface2:#f1f5f9;--hair:#eef1f4;
--text:#1f2328;--sub:#515c69;--mute:#66707c;--up:#d32f2f;--down:#0a7f42;--warn:#9a6700;--warn-bg:#fffaf0;--warn-b:#f5d99a;
--info:#2563eb;--info-bg:#eff6ff;--info-b:#bfdbfe;--shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:26px 18px 60px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin:0 0 18px}
.banner{border-radius:12px;padding:16px 18px;margin-bottom:16px}
.b-bad{background:#fef2f2;border:1px solid #fecaca}
.b-ok{background:#f0fdf4;border:1px solid #bbf7d0}
.banner h3{margin:0 0 6px;font-size:15.5px}
.banner p{margin:0;font-size:13px;line-height:1.8;color:#515c69}
.banner .big{font-size:28px;font-weight:700;letter-spacing:-.5px;display:block;margin-bottom:4px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 14px;box-shadow:var(--shadow)}
.kpi .k{font-size:12px;color:var(--mute)}
.kpi .v{font-size:20px;font-weight:700;margin-top:2px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11.5px;padding:7px 5px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid var(--hair);white-space:nowrap}
tr:hover td{background:var(--surface2)}
tr.dim{opacity:.55}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nm{font-weight:600}
.cd{color:var(--mute);font-weight:400;font-size:11px;margin-left:5px}
.up{color:var(--up);font-weight:600}.down{color:var(--down);font-weight:600}
.sc{font-weight:700}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid;white-space:nowrap}
.p-do{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-small{color:var(--info);background:var(--info-bg);border-color:var(--info-b)}
.p-ok{color:#065f46;background:#ecfdf5;border-color:#a7f3d0}
.p-wait{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-b)}
.p-warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-b)}
.p-bad{color:#991b1b;background:#fef2f2;border-color:#fecaca}
.act{color:var(--sub);font-size:12px}
.thin{display:inline-block;font-size:10px;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:3px;padding:0 4px;margin-left:4px}
.timeline{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:4px}
.tl{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
.tl .t{font-size:14px;font-weight:600;color:var(--info);font-variant-numeric:tabular-nums}
.tl .d{font-size:11.5px;color:var(--sub);margin-top:3px;line-height:1.5}
.calc{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.calc input{width:120px;padding:7px 10px;border:1px solid var(--line2);border-radius:7px;font-size:14px;font-variant-numeric:tabular-nums}
.calc .out{display:flex;gap:16px;font-size:13px;color:var(--sub);flex-wrap:wrap}
.calc .out b{color:var(--text);font-variant-numeric:tabular-nums}
.note{background:var(--warn-bg);border:1px solid var(--warn-b);border-radius:8px;padding:11px 13px;font-size:12.5px;color:#6b4a00;line-height:1.8}
.small{font-size:12px;color:var(--mute);line-height:1.75}
@media(max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.timeline{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">

<h1>明日挂单计划</h1>
<p class="sub">基于 ${baseDate} 收盘候选 · 执行日为下一交易日 · 口径：做T系统七格阶梯 + 冲高时段统计</p>

<div class="banner ${blocked ? 'b-bad' : 'b-ok'}">
  <span class="big" style="color:${blocked ? '#991b1b' : 'var(--down)'}">${blocked ? '暂停正T —— 环境一票否决' : '可执行 —— 按计划挂单'}</span>
  <h3>${blocked ? `${env.text}` : '四条闸门全部放行'}</h3>
  <p>
    ${(env.dual || []).filter((x) => x.ok).map((x) => `${x.key} ${x.close}（MA20 ${x.ma20}，偏离 <b>${x.vsMa20}%</b>；MA60 ${x.ma60}）`).join('；<br>')}。
    <br><b>两个指数同时跌破 MA20 与 MA60，属系统性下行环境</b>，此时做正T（先买后卖）是在下跌途中接飞刀。
    注意<b>中证1000 的偏离幅度远大于上证</b>——候选几乎全是中小盘，按上证判断会严重低估风险，这也是这次把闸门改成双指数的直接原因。
    <br>按《认知术》红线与系统第四条闸门，<b>明日不新开正T</b>。下方价位表保留，用途是：
    ① 已有持仓的倒T减仓参考；② 环境转好后直接复用；③ 记录"系统真的会喊停"这一行为本身。
  </p>
</div>

<div class="kpis">
  <div class="kpi"><div class="k">候选（得分≥60）</div><div class="v">${rows.length}<small> 只</small></div></div>
  <div class="kpi"><div class="k">可挂单</div><div class="v" style="color:${good.length ? 'var(--down)' : 'var(--up)'}">${good.length}<small> 只</small></div></div>
  <div class="kpi"><div class="k">上证 vs MA20</div><div class="v" style="color:var(--down)">${((env.idx / env.ma20 - 1) * 100).toFixed(1)}<small>%</small></div></div>
  <div class="kpi"><div class="k">中证1000 vs MA20</div><div class="v" style="color:var(--down)">${env.dual?.find((x) => x.key === '中证1000')?.vsMa20 ?? '—'}<small>%</small></div></div>
</div>

<section>
  <h2>一、执行时间表 <span class="small">这套时点是回溯出来的，不是拍脑袋</span></h2>
  <div class="timeline">
    <div class="tl"><div class="t">9:25</div><div class="d">看集合竞价。次日平均低开 0.63%，低开是常态，不构成放弃理由</div></div>
    <div class="tl"><div class="t">9:30</div><div class="d"><b>开盘即挂单</b>，按开盘价 +1% 挂。70% 的机会在半小时内成交</div></div>
    <div class="tl"><div class="t">10:30</div><div class="d"><b>没成交就撤</b>。之后只剩 7.5 个百分点的机会</div></div>
    <div class="tl"><div class="t">盘中</div><div class="d">跌破止损价无条件走，不加仓摊薄</div></div>
    <div class="tl"><div class="t">15:00</div><div class="d"><b>不守收盘</b>。高点后平均回撤 3.19%，收盘为正仅 46%</div></div>
  </div>
  <p class="small" style="margin-top:10px">
    注：以上时段结论来自 213 条选股记录 × 30 分钟 K 线，与同池基准对照后确认——
    「最高价多在开盘半小时」是市场结构（基准 55.9% vs 选股后 55.4%），
    但「开盘半小时内出现 +1%」确实是选股带来的（70.0% vs 基准 59.1%，+10.9pp）。
  </p>
</section>

<section>
  <h2>二、开盘价换算器 <span class="small">实际执行请以真实开盘价重算</span></h2>
  <div class="calc">
    <label class="small">开盘价</label>
    <input id="op" type="number" step="0.01" value="${good.length ? f2(good[0].expOpen) : (rows.length ? f2(rows[0].expOpen) : '10.00')}">
    <div class="out">
      <span>挂 +1%：<b id="s1">—</b></span>
      <span>挂 +2%：<b id="s2">—</b></span>
      <span>止损 −1.5%：<b id="sl">—</b></span>
      <span>满格卖出（+1.33%）：<b id="g1">—</b></span>
    </div>
  </div>
  <script>
  (function(){
    var el = document.getElementById('op');
    function calc(){
      var v = parseFloat(el.value);
      if(!isFinite(v) || v<=0) return;
      document.getElementById('s1').textContent = (v*1.01).toFixed(2);
      document.getElementById('s2').textContent = (v*1.02).toFixed(2);
      document.getElementById('sl').textContent = (v*0.985).toFixed(2);
      document.getElementById('g1').textContent = (v*(1+4/3/100)).toFixed(2);
    }
    el.addEventListener('input', calc); calc();
  })();
  </script>
  <p class="small" style="margin-top:10px">
    参照系统口径：七格阶梯每格 <b>1.333%</b>（3 格 = 4%），正T止损 <b>−1.5%</b>。
    挂单价以「开盘价」为基准，<b>不是「前一日收盘价」</b>——这是本次回溯最重要的一条修正，
    因为按收盘价挂单会在低开时全部落空。
  </p>
</section>

<section>
  <h2>三、候选价位表 <span class="small">当前状态下仓位一律为 0，仅供记录与环境转好后复用</span></h2>
  <table>
    <thead><tr>
      <th>名称</th><th>得分</th><th>结论</th><th>今收</th><th>预计开</th><th>挂+1%</th><th>挂+2%</th><th>止损</th>
      <th>振幅%</th><th>趋势</th><th>仓位</th><th>动作</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    「预计开」= 今收 ×（1 − 0.63%），用统计的次日平均低开幅度估算，仅作参考；
    实际以 9:25 竞价后的真实开盘价为准，用上方换算器重算。
    振幅一栏的分档口径见系统第一闸门：<b>不足 3 格不做，3–6 格为黄金区间，超 6 格只减不新开</b>。
  </p>
</section>

<section>
  <h2>四、竞价强弱怎么用 <span class="small">直接回答：竞价不是用来决定「做不做」的</span></h2>
  <p class="small" style="margin:0 0 10px">
    把 213 条记录按<b>次日开盘跳空幅度</b>分组，看每一档的日内空间与达成率。结论比预想的干净：
  </p>
  <table>
    <thead><tr><th>竞价情形</th><th style="text-align:right">样本</th><th style="text-align:right">日内空间</th><th style="text-align:right">触及+1%</th><th style="text-align:right">触及+2%</th><th style="text-align:right">收盘为正</th><th style="text-align:right">高点回撤</th><th>怎么用</th></tr></thead>
    <tbody>${gapStat.map((g) => `<tr>
      <td>${g.label}${g.n < 8 ? '<span class="thin">样本不足</span>' : ''}</td>
      <td class="num">${g.n}</td>
      <td class="num">${g.space}%</td>
      <td class="num">${g.hit1}%</td>
      <td class="num ${g.hit2 >= 70 ? 'up' : ''}">${g.hit2}%</td>
      <td class="num ${g.upClose >= 50 ? 'down' : ''}">${g.upClose}%</td>
      <td class="num">${g.give}%</td>
      <td class="act">${g.label.startsWith('高开 +1') ? '空间最大，可挂 +2%，绝不持有' : g.label.startsWith('平开') ? '最平衡，可正常执行' : g.label.startsWith('小幅低开') ? '空间最小，小仓 +1% 即走' : g.label.startsWith('大幅低开') ? '回撤最大，只做 +1% 不贪' : '样本不足，暂不单列规则'}</td>
    </tr>`).join('')}</tbody>
  </table>
  <div class="key" style="background:var(--info-bg);border:1px solid var(--info-b);color:#1e3a8a;margin-top:12px">
    <b>三条可落地的结论：</b><br>
    ① <b>竞价强弱几乎不影响「能不能摸到 +1%」</b>——五档全部落在 78%–80%，差异在噪声范围内。
    所以低开不必放弃，高开也不必追，<b>竞价不是开关</b>。<br>
    ② <b>但竞价明显影响「空间有多大」</b>：高开 +1~3% 的日内空间 4.09%，小幅低开只有 2.87%；
    触及 +2% 的比例更是 76% vs 54%。<b>高开的票值得挂 +2%，低开的票 +1% 就该走。</b><br>
    ③ <b>高开的代价是回撤更大、收盘更差</b>：高开档收盘为正仅 40%、高点后回撤 4.23%（平开档 2.45%）。
    这再一次印证——<b>它是做T的标的，不是持有的标的。</b>
  </div>
  <div class="note" style="margin-top:10px">
    <b>所以竞价只改两件事，不改第三件：</b>改<b>目标价</b>（高开挂 +2%，平/低开挂 +1%）、改<b>仓位</b>（低开幅度越大、回撤越大，仓位越小）；
    但<b>不改「做不做」</b>——做不做由第四条环境闸门决定。
    <br>唯一的例外是极端竞价：涨停开盘买不到、跌停/大幅低开超 3% 需先查有无实质利空，这两类直接跳过。
    <br><b>局限：</b>本表只能用「开盘价」近似竞价结果，看不到竞价量、竞价撤单——那些数据无历史留存，无法回测校准。
  </div>
  <div class="key" style="background:var(--surface);border:1px solid var(--line);color:var(--text);margin-top:10px">
    <b>弱参考怎么落地（每交易日 9:26 自动跑 auction.js）</b><br>
    竞价分档 → 弱参考分：高开 +1~3% <b>+5</b>；平开 0~+1% <b>+2</b>；小幅低开 <b>0</b>；大幅低开 <b>−3</b>；大幅高开 ≥+3% <b>0</b>（样本仅 5 条，不参与）。<br>
    这个分只作用于两处：<b>目标价</b>（+5 分挂 +2%，其余挂 +1%）、<b>仓位</b>（−3 分砍半，+5 分<b>不放大</b>——空间大的同时回撤也大，放大仓位是拿回撤换空间）。<br>
    <b>不作用于「做不做」</b>，做不做仍由第四条环境闸门决定。<br>
    同时把竞价快照存到 <b>ledger/auction-日期.json</b>（价、量、额、占昨日成交额比），
    攒够 20 个交易日才能校准「竞价量能」这类阈值——免费源没有历史竞价数据，不存就永远算不出来。
  </div>
</section>

<section>
  <h2>五、为什么这次全线否决，反而是好事</h2>
  <p class="small" style="margin:0">
    选股引擎给了 3 只「可做」、7 只「小做」——那是<b>相对打分</b>，回答"这些票里谁更好"。
    第四条闸门给的是<b>绝对风控</b>，回答"今天该不该动手"。两者冲突时，<b>绝对风控优先</b>。
    <br><br>
    更关键的是：上一轮回溯已经证明，这套选股规则<b>不改善方向</b>（收盘为正 46% vs 基准 47.4%），
    只提高波动概率。在指数跌破 MA20/MA60 的环境里，波动大概率是向下的——<b>波动的方向错了，做T就是亏得更快</b>。
    所以闸门4 在这里不是形式主义，它正好卡在规则最薄弱的环节上。
  </p>
</section>

<section>
  <h2>六、局限</h2>
  <div class="note">
    <b>① 价位是基于「预计开盘价」的静态估算</b>，实际开盘价偏离时须重算，页面上给了换算器。<br>
    <b>② 三闸门里的「格位」用的是今日振幅</b>，明日振幅未知，这里只作可行性预判，不改判定逻辑。<br>
    <b>③ 未纳入个股消息面与停牌风险</b>，明日若有公告，本表全部失效。<br>
    <b>④ 指数取上证综指</b>，而候选多为中小盘，风格上应同时参考中证1000——两者背离时以中证1000为准更合理（本次未做，属已知缺口）。<br>
    <b>⑤ 竞价只有结果、没有过程。</b>页面用的「开盘价」是竞价的最终成交价，看不到竞价量能、撤单与虚拟撮合过程，
    因此无法判断"这个开盘价是抢上去的还是砸下来的"，只能按幅度分档处理。<br>
    <b>⑥ 本页不构成投资建议。</b>仓位数字是纪律上限，不是推荐仓位。
  </div>
</section>

<p class="small" style="margin-top:14px">数据：候选来自选股引擎（东财全市场快照），价位来自腾讯日K。本页仅供研究参考，不构成个人投资建议。</p>

</div></body></html>`;

fs.writeFileSync(path.join(__dirname, '挂单计划_明日.html'), html);
console.log('→ 挂单计划_明日.html');
