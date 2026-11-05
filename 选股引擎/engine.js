/**
 * 选股引擎 v2 —— 全市场扫描 + 六步法「打分版」
 *
 * 相对 v1 的改动：
 *  - 候选池从「3 个板块的 103 只」升级为「全市场 5500+ 只」；
 *  - 批量快照改用单次可返全市场的接口（腾讯批量 60 只/次，全市场需 92 次，不可行）；
 *  - 分时（VWAP）与日K（涨停史）仍走腾讯，只对幸存者发起，避免大量请求；
 *  - 严格版（原需求）与打分版（建议方案）并行输出，便于对照。
 *
 * 六步法映射：
 *  ① 涨幅 3%~5%           → 快照 f3
 *  ② 30 日内涨停           → 腾讯日K（收盘=最高 且 涨幅≥上限-0.35）
 *  ③ 总市值 < 200 亿       → 快照 f20（并加 30 亿下限）
 *  ④ 量比 > 1              → 快照 f10
 *  ⑤ 换手 5%~10%           → 快照 f8
 *  ⑥ 分时不破均价线        → 腾讯分时逐分钟复算 VWAP
 *
 * 运行：node engine.js [--loose] [--limit 30]
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD

/* ---------------- 配置 ---------------- */
const CFG = {
  // 硬门槛
  chgMin: 3, chgMax: 5,
  capMin: 30, capMax: 200,
  volRatioMin: 1,
  turnoverMin: 5, turnoverMax: 10,
  excludeBoard: ['创业板', '北交所'],   // 原始需求：排除创业板
  // 打分版放宽
  looseChgMin: 2.5, looseChgMax: 6,
  looseTurnoverMin: 3,
  looseVolRatioMin: 0.9,
  // VWAP
  vwapBreachAfter10Max: 5,   // 10:00 后累计破线分钟数上限
  vwapOnlineMin: 85,         // 全天在线占比下限 %
};

/* ---------------- 板块与涨跌幅上限 ---------------- */
function boardOf(code) {
  const c = code.replace(/^(sh|sz|bj)/, '');
  if (c.startsWith('688')) return '科创板';
  if (/^(300|301|302)/.test(c)) return '创业板';
  if (/^(4|8|920)/.test(c)) return '北交所';
  return '主板';
}
const LIMIT_OF = { 主板: 10, 创业板: 20, 科创板: 20, 北交所: 30 };

async function getJson(url, encoding = 'utf-8', retry = 3) {
  let lastErr;
  for (let i = 0; i < retry; i++) {
    try {
      const sameHost = url.includes('eastmoney.com');
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: sameHost ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/',
          Accept: '*/*',
        },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      let text;
      try { text = new TextDecoder(encoding).decode(buf); } catch { text = buf.toString('latin1'); }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ---------------- 全市场快照（分页 + 分域名轮换 + 本地缓存） ---------------- */
const EM_HOSTS = [1, 2, 7, 8, 9, 21, 25, 32, 40, 60, 82, 90];
const emHost = () => `${EM_HOSTS[Math.floor(Math.random() * EM_HOSTS.length)]}.push2.eastmoney.com`;
const EM_QS =
  'po=1&np=1&fltt=2&invt=2&fid=f3&pz=100' +
  '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' +
  '&fields=f2,f3,f6,f8,f10,f12,f14,f15,f16,f18,f20';

const CACHE = path.join(OUT_DIR, `snapshot-${TODAY}.json`);

function mapRow(d) {
  const p = d.f12.startsWith('6') ? 'sh' : d.f12.startsWith('9') || d.f12.startsWith('4') ? 'bj' : 'sz';
  return {
    code: p + d.f12,
    raw: d.f12,
    name: d.f14,
    price: d.f2,
    chgPct: d.f3,
    amount: d.f6,          // 元
    turnover: d.f8,
    volRatio: d.f10,
    totalCap: d.f20 / 1e8, // 亿
    high: d.f15,
    low: d.f16,
    prevClose: d.f18,
  };
}

async function fetchAll({ force = false } = {}) {
  if (!force && fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cached?.rows?.length > 3000) {
      console.log(`（使用本地快照缓存 ${CACHE}，共 ${cached.rows.length} 只；加 --force 重新拉取）`);
      return cached.rows;
    }
  }

  const total = (await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=1`))?.data?.total || 0;
  const pages = Math.ceil(total / 100);
  const out = [];

  let next = 1;
  const worker = async () => {
    while (next <= pages) {
      const pn = next++;
      try {
        const j = await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=${pn}`, 'utf-8', 4);
        for (const d of j?.data?.diff || []) out.push(mapRow(d));
      } catch { /* 单页失败跳过 */ }
      await new Promise((r) => setTimeout(r, 120)); // 限速
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  const rows = out.filter((x) => Number.isFinite(x.chgPct) && x.price > 0);
  if (rows.length > 3000) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ date: TODAY, total, rows }, null, 0));
  }
  return rows;
}

/* ---------------- 日K：30 日涨停 ---------------- */
async function klineCheck(code, board, name) {
  const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,90,qfq`;
  let j;
  try { j = await getJson(url); } catch { return { ok: false, reason: 'K线请求失败' }; }
  const d = j?.data?.[code];
  const arr = d?.qfqday || d?.day;
  if (!Array.isArray(arr) || arr.length < 10) return { ok: false, reason: 'K线不足' };

  const bars = arr.map((r) => ({ date: r[0], close: +r[2], high: +r[3], low: +r[4] }));
  const effLimit = /ST/i.test(name) ? 5 : LIMIT_OF[board];
  let hit = null;
  const scan = bars.slice(-31, -1); // 近 30 个交易日，不含今日
  for (let i = 1; i < scan.length; i++) {
    const prev = scan[i - 1].close;
    const cur = scan[i];
    const chg = (cur.close / prev - 1) * 100;
    if (chg >= effLimit - 0.35 && Math.abs(cur.close - cur.high) < 0.005) {
      hit = { date: cur.date, low: cur.low, close: cur.close, chg: +chg.toFixed(2) };
    }
  }
  if (!hit) return { ok: false, reason: '30日内无涨停' };

  const last = bars[bars.length - 1].close;
  return {
    ok: true,
    hit,
    pullback: +(((hit.close - last) / hit.close) * 100).toFixed(2), // 正=涨停后回落
    brokeLow: last < hit.low,
  };
}

/* ---------------- 分时：VWAP（双源，见 vwap.js） ---------------- */
const { vwapCheck } = require('./vwap');

/* ---------------- 打分 ---------------- */
const { scoreStock } = require('./score');

/* ---------------- 主流程 ---------------- */
(async function main() {
  const limitN = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : 30;

  console.log(`\n【${TODAY}】全市场扫描`);
  let all;
  try {
    all = await fetchAll({ force: process.argv.includes('--force') });
  } catch (e) {
    console.error('\n✗ 全市场快照拉取失败（接口限流或网络中断）：' + e.message);
    console.error('  已抓过的日期会缓存到 out/snapshot-YYYY-MM-DD.json，重跑会直接读缓存；');
    console.error('  需要重抓时加 --force。');
    process.exit(2);
  }
  console.log(`获取 ${all.length} 只（含涨跌幅有效值）\n`);

  const known = (s) => !!s.name && !/^N|^C/.test(s.name); // 排除上市首日无涨跌幅限制标记不全的（保守）

  /* 漏斗（严格六步法，逐级累计） */
  const funnel = {};
  let cur = all.slice();
  funnel['① 全市场'] = cur.length;
  cur = cur.filter((s) => !/ST/i.test(s.name));
  funnel['② 非 ST'] = cur.length;
  cur = cur.filter((s) => !CFG.excludeBoard.includes(boardOf(s.code)));
  funnel['③ 剔除创业板/北交所'] = cur.length;
  cur = cur.filter((s) => s.totalCap >= CFG.capMin && s.totalCap <= CFG.capMax);
  funnel[`④ 市值 ${CFG.capMin}–${CFG.capMax} 亿`] = cur.length;
  cur = cur.filter((s) => s.chgPct >= CFG.chgMin && s.chgPct <= CFG.chgMax);
  funnel[`⑤ 涨幅 ${CFG.chgMin}–${CFG.chgMax}%`] = cur.length;
  cur = cur.filter((s) => s.volRatio > CFG.volRatioMin);
  funnel[`⑥ 量比 > ${CFG.volRatioMin}`] = cur.length;
  cur = cur.filter((s) => s.turnover >= CFG.turnoverMin && s.turnover <= CFG.turnoverMax);
  funnel[`⑦ 换手 ${CFG.turnoverMin}–${CFG.turnoverMax}%`] = cur.length;
  const hardPass = cur.slice();

  /* 打分版放宽集 */
  const loose = all.filter((s) => {
    if (/ST/i.test(s.name)) return false;
    if (CFG.excludeBoard.includes(boardOf(s.code))) return false;
    if (s.totalCap < CFG.capMin || s.totalCap > CFG.capMax) return false;
    if (s.chgPct < CFG.looseChgMin || s.chgPct > CFG.looseChgMax) return false;
    if (s.volRatio <= CFG.looseVolRatioMin) return false;
    if (s.turnover < CFG.looseTurnoverMin) return false;
    return true;
  });

  console.log('═'.repeat(70));
  console.log('漏斗（严格六步法，逐级累计）');
  let prev = null;
  for (const [k, v] of Object.entries(funnel)) {
    const delta = prev === null ? '' : `  (−${prev - v})`;
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}${delta}`);
    prev = v;
  }
  console.log('═'.repeat(70));
  console.log(`\n严格版（前五步）幸存：${hardPass.length} 只` + (hardPass.length ? '：' + hardPass.map((s) => `${s.name}(${s.chgPct}%)`).join('、') : ''));
  console.log(`打分版放宽集：${loose.length} 只`);

  /* 精筛：涨停史 → VWAP */
  const pool = [...new Set([...hardPass, ...loose].map((s) => s.code))].slice(0, 400);
  const map = Object.fromEntries(all.map((s) => [s.code, s]));
  const results = [];
  for (const code of pool) {
    const s = map[code];
    const board = boardOf(code);
    const kl = await klineCheck(code, board, s.name);
    const rec = { ...s, board, kl, vw: null, score: 0, verdict: '放弃', parts: null };
    if (kl.ok) {
      rec.vw = await vwapCheck(code);
      const sc = scoreStock({ ...s, kl, vw: rec.vw });
      Object.assign(rec, { parts: sc.parts, score: sc.total, verdict: sc.verdict });
    }
    results.push(rec);
  }

  const passed = results.filter((r) => r.kl.ok).sort((a, b) => b.score - a.score);
  const strictPass = passed.filter((r) => r.vw && r.vw.strictPass);

  console.log(`\n通过涨停史 + VWAP 复核：${passed.length} 只｜其中「VWAP 始终不破」严格达标：${strictPass.length} 只`);
  if (!strictPass.length) {
    console.log('  ⚠ 严格六步法（Step6 = 全天不破均价线）今日零候选 —— 与评估预判一致。');
  }

  const show = passed.slice(0, limitN);
  const W = [10, 9, 6, 7, 6, 7, 8, 9, 9, 11, 7, 5, 6];
  const H = ['名称', '代码', '板块', '涨幅%', '量比', '换手%', '总市值', '在线%', '破线分', '涨停日', '回落%', '得分', '结论'];
  console.log('\n' + '─'.repeat(103));
  console.log(H.map((h, i) => h.padEnd(W[i])).join(''));
  console.log('─'.repeat(103));
  for (const r of show) {
    const cells = [
      r.name.slice(0, 5), r.code, r.board, r.chgPct.toFixed(2), r.volRatio.toFixed(2),
      r.turnover.toFixed(2), r.totalCap.toFixed(0), (r.vw?.onlineRatio ?? '-').toString(),
      (r.vw?.belowAfter10 ?? '-').toString(), r.kl.hit.date.slice(5), r.kl.pullback.toFixed(1),
      r.score.toString(), r.verdict,
    ];
    console.log(cells.map((x, i) => String(x).padEnd(W[i])).join(''));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${TODAY}.json`);
  fs.writeFileSync(file, JSON.stringify({
    date: TODAY, generatedAt: new Date().toISOString(),
    total: all.length, funnel, hardPass: hardPass.map((s) => s.code),
    strictPass: strictPass.map((r) => r.code),
    results: passed,
  }, null, 2));
  console.log(`\n明细 → ${file}`);

  /* ---- 台账：清单 + 全市场收盘快照（收益回算的唯一数据源） ---- */
  const LEDGER = path.join(__dirname, 'ledger');
  fs.mkdirSync(LEDGER, { recursive: true });

  const picks = {
    date: TODAY,
    generatedAt: new Date().toISOString(),
    note: '引擎当日输出；score/verdict 为打分版结论。收益回算只认这份清单。',
    funnel,
    picks: passed.map((r) => ({
      code: r.code, name: r.name, board: r.board,
      chgPct: r.chgPct, volRatio: r.volRatio, turnover: r.turnover,
      totalCap: +r.totalCap.toFixed(1), amount: r.amount,
      score: r.score, verdict: r.verdict, parts: r.parts,
      limitUpDate: r.kl?.hit?.date || null,
      pullback: r.kl?.pullback ?? null,
      vwapOnline: r.vw?.onlineRatio ?? null,
      vwapBreachAfter10: r.vw?.belowAfter10 ?? null,
    })),
  };
  fs.writeFileSync(path.join(LEDGER, `picks-${TODAY}.json`), JSON.stringify(picks, null, 1));

  const closes = {
    date: TODAY,
    note: '全市场收盘快照，用于日后按任意持有期回算收益；不做复权处理，复权差异由回算时统一用日K修正。',
    count: all.length,
    rows: all.map((s) => [s.code, s.name, s.price, s.chgPct, s.amount, s.totalCap]),
  };
  fs.writeFileSync(path.join(LEDGER, `close-${TODAY}.json`), JSON.stringify(closes));

  console.log(`台账 → ledger/picks-${TODAY}.json（${picks.picks.length} 只）、ledger/close-${TODAY}.json（${all.length} 只）`);
})();
