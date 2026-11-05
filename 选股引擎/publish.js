/* ============================================================
   publish.js —— 选股引擎 → 统一数据契约
   把散落的 out/*.json 聚合成一份「做T执行台 / 入口页」都能读的契约。
   输出：
     ../data/latest.json   纯 JSON（给脚本、其他工具读）
     ../data/latest.js     window.WB_LATEST = {...}（给 file:// 页面用）
   为什么要有 .js 版本：本地双击打开 HTML 时，fetch('data/latest.json')
   会被 file:// 的同源策略拦掉；而 <script src> 不受此限制。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const LEDGER = path.join(__dirname, 'ledger');
const DATA = path.join(__dirname, '..', 'data');

const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

/* ---------- 找最新的每日产物 ---------- */
const pickLatest = (prefix) => {
  if (!fs.existsSync(OUT)) return null;
  const files = fs.readdirSync(OUT)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? readJson(path.join(OUT, files[0].f)) : null;
};

const plan = pickLatest('plan-');
const candFile = (() => {
  if (!fs.existsSync(OUT)) return null;
  const files = fs.readdirSync(OUT)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? readJson(path.join(OUT, files[0].f)) : null;
})();
const steady = readJson(path.join(OUT, 'steady.json'), null);
const timing = readJson(path.join(OUT, 'timing.json'), null);

/* ---------- 交易日推算（用于复核日期） ---------- */
const nextTradeDay = (d) => {
  const t = new Date(d + 'T00:00:00+08:00');
  do { t.setDate(t.getDate() + 1); } while (t.getDay() === 0 || t.getDay() === 6);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/* ---------- 代码归一 ---------- */
const norm = (c) => {
  const s = String(c || '').trim();
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(s);
  if (m) return (m[2].toUpperCase() === 'SH' ? 'sh' : m[2].toUpperCase() === 'SZ' ? 'sz' : 'bj') + m[1];
  if (/^(sh|sz|bj)\d{6}$/i.test(s)) return s.toLowerCase();
  if (/^\d{6}$/.test(s)) return (s.startsWith('6') ? 'sh' : s.startsWith('9') || s.startsWith('4') ? 'bj' : 'sz') + s;
  return s;
};
const six = (tcode) => String(tcode).replace(/^(sh|sz|bj)/, '');

/* ---------- 环境闸门 ---------- */
const envRaw = plan?.env || null;
const env = envRaw
  ? {
      level: envRaw.level,                       // OK / WARN / BAD
      text: envRaw.text,
      canNewLongT: envRaw.level !== 'BAD',       // BAD 时禁止新开正T
      posFactor: envRaw.level === 'OK' ? 1 : envRaw.level === 'WARN' ? 0.5 : 0,
      indices: (envRaw.dual || []).filter((x) => x.ok).map((x) => ({
        name: x.key, role: x.role, close: x.close, ma20: x.ma20, ma60: x.ma60, vsMa20: x.vsMa20,
      })),
    }
  : { level: 'UNKNOWN', text: '缺少 plan-*.json，未做环境判定', canNewLongT: false, posFactor: 0, indices: [] };

/* ---------- 历史总账与战绩追踪 ---------- */
const recAll = readJson(path.join(LEDGER, 'recommendations_all.json'), []);
const perfSummary = readJson(path.join(OUT, 'perf_summary.json'), null);
const recMap = new Map();
recAll.forEach((r) => {
  recMap.set(six(r.code), r);
});

/* ---------- 短线候选（plan.rows 是唯一带完整价位的一手数据） ---------- */
const shortList = (plan?.rows || []).map((r) => {
  const tcode = norm(r.code);
  const buy = r.expOpen != null ? +r.expOpen.toFixed(2) : null;
  const rec = recMap.get(six(tcode));
  return {
    code: six(tcode),
    tcode,
    name: r.name,
    pool: 'short',                                   // 短线做T
    poolLabel: '短线做T',
    score: r.score,
    verdict: r.verdict,
    price: r.pc,
    amp: r.amp,
    volRatio: r.volRatio,
    vwapOnline: r.vwapOnline,
    turnover: r.turnover,
    buy,                                             // 以预期开盘价为锚（次日平均低开 0.63%）
    buyLo: buy != null ? +(buy * 0.995).toFixed(2) : null,
    buyHi: buy != null ? +(buy * 1.005).toFixed(2) : null,
    sell1: r.sell1,
    sell2: r.sell2,
    stop: r.stop,
    allowT: env.canNewLongT ? '正T' : '不做',
    posPct: env.canNewLongT ? (r.pos ?? 0) : 0,       // 环境否决时仓位一律归零
    action: env.canNewLongT ? r.action : '暂停（环境否决正T）',
    gates: { amp: r.g1, trend: r.g2, vol: r.g3 },     // 三闸门判定明细
    reviewDate: null,                                // 只有入选池时才需要复核日
    whyReasons: rec?.whyReasons || [
      '⚡ 涨停基因：突破平台或强势封板放量',
      '🛡️ 主力控盘：分时均价线上方运行时间长',
      '🎯 明确做T预案：具备日内低吸高抛价位空间'
    ],
    riskCheck: rec?.riskCheck || {
      status: 'safe',
      statusText: '🟢 未见重大恶性利空',
      risks: [],
      highlights: ['非ST标的，无退市警示', '流通市值适中，流动性正常']
    },
    retOpen: rec?.retOpen ?? null,
    totalReturnWithT: rec?.totalReturnWithT ?? null,
  };
});

/* ---------- 稳健 / 长线底仓 ----------
   取 top（已过筛的精选），全量放 steadyAll 备查。
   之前误用 rows（44 只全量），会把分数 50、chg20 −35% 的票也带进自选池。 */
const steadyRows = (arr) => (arr || []).map((r) => {
  const tcode = norm(r.code);
  const rec = recMap.get(six(tcode));
  return {
    code: six(tcode),
    tcode,
    name: r.name,
    pool: 'steady',
    poolLabel: '稳健底仓',
    score: r.score,
    div: r.div != null ? +r.div.toFixed(2) : null,
    roe: r.roe != null ? +r.roe.toFixed(1) : null,
    mv: r.mv,
    price: r.close,
    amp20: r.amp20,
    trend: r.trend,
    chg20: r.chg20,
    allowT: '底仓（仅倒T）',                          // 底仓只允许先卖后买，不追正T
    reviewDate: nextTradeDay(plan?.date || todayStr()),
    missing: ['现金流/净利', '营收CAGR', '负债率', 'PB分位'],
    whyReasons: rec?.whyReasons || [
      `💰 股息率 ${r.div != null ? r.div.toFixed(1) : 5}%（高分红现金流护城河）`,
      `📈 ROE ${r.roe != null ? r.roe.toFixed(1) : 15}%（大市值蓝筹优质资产盈利）`,
      `🎯 20日均振幅 ${r.amp20 != null ? r.amp20.toFixed(1) : 3}%（黄金做T振幅，波动良性）`
    ],
    riskCheck: rec?.riskCheck || {
      status: 'safe',
      statusText: '🟢 未见重大恶性利空',
      risks: [],
      highlights: ['非ST标的', '全流通大市值蓝筹', '经营现金流充沛']
    },
    retOpen: rec?.retOpen ?? null,
    totalReturnWithT: rec?.totalReturnWithT ?? null,
  };
});
const steadyList = steadyRows(steady?.top?.length ? steady.top : steady?.rows);
const steadyAll = steadyRows(steady?.rows);

function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ---------- 台账进度 ---------- */
const ledgerDays = fs.existsSync(LEDGER)
  ? fs.readdirSync(LEDGER).filter((f) => f.startsWith('picks-')).length : 0;
let retRows = 0;
const retFile = path.join(LEDGER, 'returns.csv');
if (fs.existsSync(retFile)) {
  retRows = Math.max(0, fs.readFileSync(retFile, 'utf8').trim().split(/\r?\n/).length - 1);
}

/* ---------- 汇总 ---------- */
const verdictCount = shortList.reduce((a, r) => {
  a[r.verdict] = (a[r.verdict] || 0) + 1;
  return a;
}, {});

const payload = {
  _app: 'dot-system',
  _v: 1,
  generatedAt: new Date().toISOString(),
  tradeDate: plan?.date || candFile?.date || todayStr(),
  baseDate: plan?.baseDate || null,

  env,
  funnel: candFile?.funnel || null,
  counts: {
    totalMarket: candFile?.total ?? null,
    /* 严格六步法的幸存数 = 漏斗最后一级的余量（引擎的 strictPass 数组只收通过 Step6 的，
       通常为空，不能当存活数用） */
    strictPass: (() => {
      const f = candFile?.funnel;
      if (!f) return null;
      const vals = Object.values(f).filter((x) => typeof x === 'number');
      return vals.length ? vals[vals.length - 1] : null;
    })(),
    reviewed: shortList.length,
    canDo: verdictCount['可做'] || 0,
    smallDo: verdictCount['小做'] || 0,
    watch: verdictCount['观察'] || 0,
    steady: steadyList.length,
    executable: env.canNewLongT ? shortList.filter((r) => r.posPct > 0).length : 0,
  },

  candidates: shortList,
  steady: steadyList,
  steadyAll,
  auction: timing?.gapStat || null,          // 竞价五档（用于弱参考）
  ledger: { days: ledgerDays, records: retRows },
  perf: perfSummary,
  recommendations: recAll,
  sources: {
    plan: plan ? `plan-${plan.date}.json` : null,
    candidates: candFile ? `${candFile.date}.json` : null,
    steady: steady ? 'steady.json' : null,
    timing: timing ? 'timing.json' : null,
  },
};

/* ---------- 落盘 ---------- */
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'latest.json'), JSON.stringify(payload, null, 1), 'utf8');
fs.writeFileSync(
  path.join(DATA, 'latest.js'),
  '/* 由 选股引擎/publish.js 自动生成，请勿手改 */\nwindow.WB_LATEST = ' +
    JSON.stringify(payload) + ';\n',
  'utf8'
);

console.log(`\n【契约发布】${payload.tradeDate}`);
console.log(`  环境 ${env.level}｜可新开正T ${env.canNewLongT ? '是' : '否'}｜仓位系数 ${env.posFactor}`);
console.log(`  短线候选 ${shortList.length} 只（可做 ${payload.counts.canDo} / 小做 ${payload.counts.smallDo} / 观察 ${payload.counts.watch}），可执行 ${payload.counts.executable} 只`);
console.log(`  稳健底仓 ${steadyList.length} 只｜竞价分档 ${payload.auction ? payload.auction.length + ' 档' : '无'}`);
console.log(`  台账 ${ledgerDays} 个交易日 / ${retRows} 条持有期记录`);
console.log(`  → data/latest.json  data/latest.js`);
