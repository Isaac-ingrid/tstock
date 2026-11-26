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
const dateCliArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const TODAY = dateCliArg || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD

/* ---------------- 配置 ---------------- */
const CFG = {
  // 硬门槛
  chgMin: 3, chgMax: 5,
  capMin: 30, capMax: 200,
  coreCapMax: 800,           // 板块成交前3的容量中军放宽上限（亿，如亨通模式）
  coreMinAmount: 8e8,        // 容量中军当日最低成交额门槛（8亿）
  volRatioMin: 1,
  turnoverMin: 5, turnoverMax: 10,
  excludeBoard: ['创业板', '科创板', '北交所'],   // 统一 10cm 主板口径（剔除 20cm 创业/科创与 30cm 北交所）
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
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

/* ---------------- 全市场快照（分页 + 分域名轮换 + 本地缓存 + f100 行业板块） ---------------- */
const EM_HOSTS = [1, 2, 7, 8, 9, 21, 25, 32, 40, 60, 82, 90];
const emHost = () => `${EM_HOSTS[Math.floor(Math.random() * EM_HOSTS.length)]}.push2.eastmoney.com`;
const EM_QS =
  'po=1&np=1&fltt=2&invt=2&fid=f3&pz=100' +
  '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' +
  '&fields=f2,f3,f6,f8,f10,f12,f14,f15,f16,f18,f20,f100';

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
    sector: d.f100 && d.f100 !== '-' ? String(d.f100).trim() : '',
  };
}

/* 为缺少 f100 板块字段的历史缓存快照轻量补齐行业归属 */
async function hydrateMissingSectors(rows) {
  const hasCount = rows.filter((r) => r.sector).length;
  if (hasCount >= Math.min(4500, rows.length * 0.88)) return rows;
  try {
    const secQs = 'po=1&np=1&fltt=2&invt=2&fid=f12&pz=100&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f100';
    const first = await getJson(`https://${emHost()}/api/qt/clist/get?${secQs}&pn=1`, 'utf-8', 2);
    const total = first?.data?.total || 0;
    if (!total) return rows;
    const secMap = new Map();
    for (const d of (first?.data?.diff || [])) {
      if (d.f12 && d.f100 && d.f100 !== '-') secMap.set(String(d.f12), String(d.f100).trim());
    }
    const pages = Math.ceil(total / 100);
    let pn = 2;
    const worker = async () => {
      while (pn <= pages) {
        const curPn = pn++;
        try {
          const j = await getJson(`https://${emHost()}/api/qt/clist/get?${secQs}&pn=${curPn}`, 'utf-8', 2);
          for (const d of (j?.data?.diff || [])) {
            if (d.f12 && d.f100 && d.f100 !== '-') secMap.set(String(d.f12), String(d.f100).trim());
          }
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    if (secMap.size >= 500) {
      rows.forEach((r) => {
        if (!r.sector && secMap.has(r.raw)) r.sector = secMap.get(r.raw);
      });
      if (fs.existsSync(CACHE)) {
        try {
          const prev = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
          fs.writeFileSync(CACHE, JSON.stringify({ ...prev, rows }));
        } catch {}
      }
      console.log(`  ✓ 已补齐行业板块归属：${secMap.size} 只`);
    }
  } catch {}
  return rows;
}

/* 第二步 & 第三步：统计板块持续性梯队 + 识别前排龙头/容量中军 vs 看A做B后排补涨 */
function buildSectorStats(all) {
  const hotThemeSet = new Set();
  const herdPath = path.join(__dirname, '..', 'data', 'herd_pool.json');
  if (fs.existsSync(herdPath)) {
    try {
      const hp = JSON.parse(fs.readFileSync(herdPath, 'utf8'));
      const clusters = hp.clusters || hp.themes || hp.boards || [];
      for (const c of clusters) {
        const nm = String(c.name || c.theme || c.board || '').trim();
        if (nm && (c.days >= 2 || (c.count || c.ztCount || 0) >= 2 || (c.score || 0) >= 70)) {
          hotThemeSet.add(nm);
        }
      }
    } catch {}
  }

  const bySec = new Map();
  for (const s of all) {
    if (!s.sector || !s.name || /ST/i.test(s.name) || /^N|^C/.test(s.name)) continue;
    if (!bySec.has(s.sector)) bySec.set(s.sector, []);
    bySec.get(s.sector).push(s);
  }

  const stockMap = new Map();
  const hotSectors = [];
  for (const [sec, list] of bySec.entries()) {
    const n = list.length;
    if (!n) continue;
    let ztCount = 0;
    let strongCount = 0;
    let upCount = 0;
    let sumChg = 0;
    for (const s of list) {
      const lim = LIMIT_OF[boardOf(s.code)] || 10;
      if (s.chgPct >= lim - 0.4) ztCount += 1;
      if (s.chgPct >= 3.0 && s.volRatio > 1.0) strongCount += 1;
      if (s.chgPct > 0) upCount += 1;
      sumChg += s.chgPct || 0;
    }
    const upRatio = upCount / n;
    const avgChg = sumChg / n;
    const isHerdHot = [...hotThemeSet].some((t) => sec.includes(t) || t.includes(sec));

    let tier = 'NEUTRAL';
    let tierLabel = '普通轮动';
    if ((ztCount >= 2 && upRatio >= 0.50) || (strongCount >= 7 && avgChg >= 1.1) || isHerdHot) {
      tier = 'HOT';
      tierLabel = '🔥主线持续';
      hotSectors.push({ sector: sec, ztCount, strongCount, avgChg: +avgChg.toFixed(2) });
    } else if (ztCount >= 1 || (strongCount >= 3 && avgChg >= 0.25)) {
      tier = 'ACTIVE';
      tierLabel = '📈板块活跃';
    } else if (ztCount === 0 && strongCount <= 1 && avgChg < -0.2) {
      tier = 'COLD';
      tierLabel = '❄️孤狼散乱';
    }

    const byChg = [...list].sort((a, b) => (b.chgPct || 0) - (a.chgPct || 0));
    const byAmt = [...list].sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const topChg = byChg[0]?.chgPct || 0;
    const topName = byChg[0]?.name || '';
    const chgRankMap = new Map(byChg.map((x, idx) => [x.code, idx + 1]));
    const amtRankMap = new Map(byAmt.map((x, idx) => [x.code, idx + 1]));

    for (const s of list) {
      const chgRank = chgRankMap.get(s.code) || n;
      const amtRank = amtRankMap.get(s.code) || n;
      stockMap.set(s.code, {
        sector: sec,
        sectorSize: n,
        ztCount,
        strongCount,
        upRatio: +upRatio.toFixed(2),
        avgChg: +avgChg.toFixed(2),
        tier,
        tierLabel,
        topChg,
        topName,
        chgRank,
        amtRank,
        amtPctile: +(amtRank / n).toFixed(3),
      });
    }
  }

  hotSectors.sort((a, b) => b.ztCount - a.ztCount || b.avgChg - a.avgChg);
  return { stockMap, hotCount: hotSectors.length, hotSectors: hotSectors.slice(0, 8) };
}

function classifyLeaderRole(s, kl, sm) {
  const zt30 = kl?.limitUpCount30d || 0;
  const streak30 = kl?.maxStreak30d || 0;
  const ret20 = kl?.ret20d || 0;

  // 1) 👑 身位龙：30日内 >=2 次涨停（连板或双响炮老龙回马枪），或在活跃/主线板块涨幅排前 2 且具备涨停基因
  if (zt30 >= 2 || streak30 >= 2 || (sm && (sm.tier === 'HOT' || sm.tier === 'ACTIVE') && sm.chgRank <= 2 && zt30 >= 1)) {
    return { role: 'dragon', label: '👑身位龙', isBackRowLaggard: false };
  }

  // 2) 🏛️ 容量中军：板块内成交额排前 2 且成交额 >= 5 亿，兼具趋势或中大市值承接力（亨通模式）
  if ((s.amount || 0) >= 5e8 && sm && sm.amtRank <= 2 && (s.totalCap >= 100 || kl?.isBull)) {
    return { role: 'core', label: '🏛️容量中军', isBackRowLaggard: false };
  }

  // 3) 🚫 严禁看A做B买后排补涨：同板块已有前排涨停或大涨领头羊 (>=7%)，但该股涨幅与成交额双双居后排且无多板历史身位
  if (
    sm &&
    (sm.ztCount >= 1 || sm.topChg >= 7.0) &&
    sm.chgRank > 5 &&
    (sm.topChg - s.chgPct) >= 3.8 &&
    sm.amtRank > 5 &&
    sm.amtPctile > 0.20 &&
    zt30 <= 1 &&
    ret20 < 8
  ) {
    return {
      role: 'backrow',
      label: '🚫后排补涨',
      isBackRowLaggard: true,
      reason: `同板块领涨 ${sm.topName}(+${sm.topChg.toFixed(1)}%)，该股涨幅排第${sm.chgRank}/成交排第${sm.amtRank}，属看A做B后排跟风`,
    };
  }

  // 4) ⚡ 主线前排：涨幅或成交额居板块前 5（或前 15%）
  if (sm && (sm.chgRank <= 5 || sm.amtRank <= 4 || sm.amtPctile <= 0.15)) {
    return { role: 'front', label: '⚡前排核心', isBackRowLaggard: false };
  }

  // 5) 🐺 散乱独苗
  if (!sm || sm.tier === 'COLD') {
    return { role: 'lone', label: '🐺板块独苗', isBackRowLaggard: false };
  }

  return { role: 'relay', label: '🎯分歧回踩', isBackRowLaggard: false };
}

const isTodaySnapshot = (filename) =>
  filename === `snapshot-${TODAY}.json` || filename.startsWith(`tail-snapshot-${TODAY}-`);

async function fetchAll({ force = false } = {}) {
  if (!force && fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cached?.rows?.length > 3000) {
      console.log(`（使用本地快照缓存 ${CACHE}，共 ${cached.rows.length} 只；加 --force 重新拉取）`);
      await hydrateMissingSectors(cached.rows);
      return { rows: cached.rows, isFallback: false, fallbackFile: null };
    }
  }

  let total = 0;
  try {
    const j = await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=1`, 'utf-8', 1);
    total = j?.data?.total || 0;
  } catch {
    total = 0;
  }

  if (!total) {
    console.log('  ⚡ 东财 clist 响应受阻，秒切腾讯全市场极速实时快照引擎…');
    try {
      const { fetchTencentUniverseSnapshot } = require('../scripts/tencent_market_snapshot.cjs');
      const qqSnap = await fetchTencentUniverseSnapshot({ mainboardOnly: false, batchSize: 80, concurrency: 14 });
      if (qqSnap?.rows?.length >= 3000) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(CACHE, JSON.stringify({ date: TODAY, total: qqSnap.rows.length, source: 'tencent', rows: qqSnap.rows }));
        console.log(`  ✓ 腾讯全市场实时快照已落盘 (${qqSnap.rows.length} 只，含行业板块)`);
        return { rows: qqSnap.rows, isFallback: false, fallbackFile: null };
      }
    } catch (qqErr) {
      console.warn(`  ⚠ 腾讯实时快照异常: ${qqErr.message}`);
    }

    if (fs.existsSync(OUT_DIR)) {
      const snaps = fs.readdirSync(OUT_DIR)
        .filter((f) => f.startsWith('snapshot-') || f.startsWith(`tail-snapshot-${TODAY}-`))
        .map((f) => {
          try {
            const p = path.join(OUT_DIR, f);
            const c = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { f, rows: c?.rows || [] };
          } catch {
            return { f, rows: [] };
          }
        })
        .filter((x) => x.rows.length >= 3000)
        .sort((a, b) => b.rows.length - a.rows.length);

      if (snaps.length > 0) {
        const picked = snaps[0];
        const crossDay = !isTodaySnapshot(picked.f);
        console.log(`⚠️ 东财 clist 首包重试超时，启动最全历史快照兜底: ${picked.f} (${picked.rows.length} 只)`);
        return { rows: picked.rows, isFallback: crossDay, fallbackFile: picked.f };
      }
    }
    throw new Error('东财 clist 接口重试失败且无可用快照');
  }

  const pages = Math.ceil(total / 100);
  console.log(`  全市场 ${total} 只，${pages} 页`);
  const pageMap = new Map();
  let pendingPages = Array.from({ length: pages }, (_, i) => i + 1);

  for (let round = 1; round <= 3 && pendingPages.length > 0; round++) {
    const queue = [...pendingPages];
    pendingPages = [];
    let cur = 0;
    const worker = async () => {
      while (cur < queue.length) {
        const pn = queue[cur++];
        try {
          const j = await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=${pn}`, 'utf-8', 3);
          const diff = j?.data?.diff || [];
          if (diff.length > 0) {
            pageMap.set(pn, diff.map(mapRow));
          } else {
            pendingPages.push(pn);
          }
        } catch {
          pendingPages.push(pn);
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  const out = [];
  for (const list of pageMap.values()) {
    out.push(...list);
  }
  let rows = out.filter((x) => Number.isFinite(x.chgPct) && x.price > 0);
  let isFallback = false;
  let fallbackFile = null;
  if (rows.length < 4500 && fs.existsSync(OUT_DIR)) {
    const snaps = fs.readdirSync(OUT_DIR)
      .filter((f) => f.startsWith('snapshot-') || f.startsWith(`tail-snapshot-${TODAY}-`))
      .sort()
      .reverse();
    for (const snap of snaps) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(OUT_DIR, snap), 'utf8'));
        if (c?.rows?.length > rows.length && c?.rows?.length > 4500) {
          console.log(`⚠️ 本次抓包样本偏少(${rows.length})，补充全量快照(${snap}, ${c.rows.length}只)`);
          rows = c.rows;
          isFallback = !isTodaySnapshot(snap);
          fallbackFile = snap;
          break;
        }
      } catch {}
    }
  }

  if (rows.length > 3000 && !isFallback) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ date: TODAY, total, rows }, null, 0));
  }
  return { rows, isFallback, fallbackFile };
}

/* ---------------- 日K：30 日涨停 + 空头趋势 + 顶部风控 + 相对大盘 RS ---------------- */
const { detectBearishKlineRisk } = require('./backtest');
const { evaluateLiveMacroGate, computeStockMacroMetrics } = require('./macro_gate');

async function klineCheck(code, board, name, curPrice, curChgPct, macroEnv) {
  const rawBars = await fetchDailyKline(code, 100);
  if (!rawBars) return { ok: false, reason: 'K线请求失败' };
  const bars = rawBars.filter((b) => b.date <= TODAY).slice(-90);
  if (bars.length < 20) return { ok: false, reason: 'K线不足' };
  const macroMetrics = computeStockMacroMetrics(bars, curPrice, curChgPct, macroEnv);
  const effLimit = /ST/i.test(name) ? 5 : LIMIT_OF[board];
  let hit = null;
  let limitUpCount30d = 0;
  let curStreak = 0;
  let maxStreak30d = 0;
  const scan = bars.slice(-31, -1); // 近 30 个交易日，不含今日
  for (let i = 1; i < scan.length; i++) {
    const prev = scan[i - 1].close;
    const cur = scan[i];
    const chg = (cur.close / prev - 1) * 100;
    const isZt = chg >= effLimit - 0.35 && Math.abs(cur.close - cur.high) < Math.max(0.005, prev * 0.001);
    if (isZt) {
      hit = { date: cur.date, low: cur.low, close: cur.close, chg: +chg.toFixed(2) };
      limitUpCount30d += 1;
      curStreak += 1;
      if (curStreak > maxStreak30d) maxStreak30d = curStreak;
    } else {
      curStreak = 0;
    }
  }
  if (!hit) return { ok: false, reason: '30日内无涨停' };

  const last = bars[bars.length - 1].close;
  const base20 = bars[Math.max(0, bars.length - 21)].close;
  const ret20d = base20 > 0 ? +(((last / base20) - 1) * 100).toFixed(2) : 0;
  const brokeLow = last < hit.low;
  const ma = (n) => bars.slice(-n).reduce((acc, b) => acc + b.close, 0) / n;
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);
  const isBear = ma5 < ma10 && ma10 < ma20 && last < ma5;
  const isBull = ma5 > ma10 && ma10 > ma20 && last > ma5;
  const klineRisk = detectBearishKlineRisk(bars, bars.length - 1, effLimit);

  if (brokeLow) return { ok: false, reason: '已跌破涨停日低点', hit, limitUpCount30d, maxStreak30d, ret20d, brokeLow: true, isBear, isBull, klineRisk, ...macroMetrics };
  if (isBear) return { ok: false, reason: '日线空头排列反压', hit, limitUpCount30d, maxStreak30d, ret20d, brokeLow: false, isBear: true, isBull, klineRisk, ...macroMetrics };
  if (klineRisk.risky) return { ok: false, reason: `顶部见顶K线(${klineRisk.reasons.join('/')})`, hit, limitUpCount30d, maxStreak30d, ret20d, brokeLow: false, isBear: false, isBull, klineRisk, ...macroMetrics };

  return {
    ok: true,
    hit,
    limitUpCount30d,
    maxStreak30d,
    ret20d,
    pullback: +(((hit.close - last) / hit.close) * 100).toFixed(2), // 正=涨停后回落
    brokeLow: false,
    isBear: false,
    isBull,
    klineRisk,
    ...macroMetrics,
  };
}

/* ---------------- 分时：VWAP + 日K统一源（见 vwap.js） ---------------- */
const { vwapCheck, fetchDailyKline } = require('./vwap');

/* ---------------- 打分 ---------------- */
const { scoreStock } = require('./score');

/* ---------------- 主流程 ---------------- */
(async function main() {
  const limitN = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : 30;

  console.log(`\n【${TODAY}】全市场扫描`);
  const macroEnv = await evaluateLiveMacroGate({ date: TODAY });
  console.log(`🧭 天时结构 [${macroEnv.level}/${macroEnv.regimeMode}]：${macroEnv.text}`);
  let all, isFallback = false, fallbackFile = null;
  try {
    const snapRes = await fetchAll({ force: process.argv.includes('--force') });
    all = snapRes.rows;
    isFallback = snapRes.isFallback;
    fallbackFile = snapRes.fallbackFile;
  } catch (e) {
    console.error('\n✗ 全市场快照拉取失败（接口限流或网络中断）：' + e.message);
    console.error('  已抓过的日期会缓存到 out/snapshot-YYYY-MM-DD.json，重跑会直接读缓存；');
    console.error('  需要重抓时加 --force。');
    process.exit(2);
  }
  console.log(`获取 ${all.length} 只（含涨跌幅有效值）${isFallback ? ` [跨日兜底: ${fallbackFile}]` : ''}\n`);

  const known = (s) => !!s.name && !/^N|^C/.test(s.name); // 排除上市初期无涨跌幅限制的新股（N/C 开头）

  /* 漏斗（严格六步法，逐级累计） */
  const funnel = {};
  let cur = all.slice();
  funnel['① 全市场'] = cur.length;
  cur = cur.filter((s) => known(s) && !/ST/i.test(s.name));
  funnel['② 非 ST/新股'] = cur.length;
  cur = cur.filter((s) => !CFG.excludeBoard.includes(boardOf(s.code)));
  funnel['③ 剔除创业板/科创板/北交所'] = cur.length;
  cur = cur.filter((s) => s.totalCap >= CFG.capMin && s.totalCap <= CFG.capMax);
  funnel[`④ 市值 ${CFG.capMin}–${CFG.capMax} 亿`] = cur.length;
  cur = cur.filter((s) => s.chgPct >= CFG.chgMin && s.chgPct <= CFG.chgMax);
  funnel[`⑤ 涨幅 ${CFG.chgMin}–${CFG.chgMax}%`] = cur.length;
  cur = cur.filter((s) => s.volRatio > CFG.volRatioMin);
  funnel[`⑥ 量比 > ${CFG.volRatioMin}`] = cur.length;
  cur = cur.filter((s) => s.turnover >= CFG.turnoverMin && s.turnover <= CFG.turnoverMax);
  funnel[`⑦ 换手 ${CFG.turnoverMin}–${CFG.turnoverMax}%`] = cur.length;
  const hardPass = cur.slice();

  /* 第二步：板块持续性与板块内成交/涨幅排位聚合（关联 herd_pool 主线共振） */
  const sectorMeta = buildSectorStats(all);

  /* 打分版放宽集（兼顾 30~200 亿弹性龙头回踩 与 200~800 亿高成交额容量中军，如亨通模式） */
  const loose = all
    .filter((s) => {
      if (!known(s) || /ST/i.test(s.name)) return false;
      if (CFG.excludeBoard.includes(boardOf(s.code))) return false;
      const sm = sectorMeta.stockMap.get(s.code);
      const isCapacityCore = s.totalCap > CFG.capMax && s.totalCap <= (CFG.coreCapMax || 800) &&
        (s.amount || 0) >= (CFG.coreMinAmount || 8e8) && (sm?.amtRank ?? 99) <= 3;
      if (s.totalCap < CFG.capMin || (s.totalCap > CFG.capMax && !isCapacityCore)) return false;
      if (s.chgPct < CFG.looseChgMin || s.chgPct > CFG.looseChgMax) return false;
      if (s.volRatio <= CFG.looseVolRatioMin) return false;
      const minTurn = isCapacityCore ? 2.0 : CFG.looseTurnoverMin;
      if (s.turnover < minTurn) return false;
      return true;
    })
    .sort((a, b) => {
      const distA = Math.abs(a.chgPct - 4.0) * 1.5 + Math.abs(a.turnover - 7.5) * 0.4;
      const distB = Math.abs(b.chgPct - 4.0) * 1.5 + Math.abs(b.turnover - 7.5) * 0.4;
      return distA - distB;
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
  console.log(`打分版放宽集（含主线容量中军）：${loose.length} 只｜识别主线持续板块 ${sectorMeta.hotCount} 个`);

  /* 精筛：涨停史 → 板块持续性 & 龙头去后排 → VWAP */
  const pool = [...new Set([...hardPass, ...loose].map((s) => s.code))].slice(0, 400);
  const map = Object.fromEntries(all.map((s) => [s.code, s]));
  const results = [];
  let backrowFilteredCount = 0;
  const cachedVwMap = (() => {
    const m = new Map();
    for (const fn of [`${TODAY}.rescored.json`, `${TODAY}.json`]) {
      const p = path.join(OUT_DIR, fn);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const r of (j.rows || j.results || [])) {
          if (r?.code && r?.vw && (!r.vw.date || r.vw.date === TODAY)) {
            if (!m.has(r.code)) m.set(r.code, r.vw);
          }
        }
      } catch {}
    }
    return m;
  })();

  const isStrictBear = macroEnv.regimeMode === 'BEAR_STRICT' || macroEnv.level === 'BAD';
  for (const code of pool) {
    const s = map[code];
    const board = boardOf(code);
    const kl = await klineCheck(code, board, s.name, s.price, s.chgPct, macroEnv);
    const sm = sectorMeta.stockMap.get(code) || null;
    const roleInfo = classifyLeaderRole(s, kl, sm);
    const rec = {
      ...s,
      board,
      sector: sm?.sector || s.sector || '',
      sectorTier: sm?.tier || 'NEUTRAL',
      sectorLabel: sm?.tierLabel || '普通轮动',
      chgRankInSector: sm?.chgRank ?? null,
      amtRankInSector: sm?.amtRank ?? null,
      leaderRole: roleInfo.role,
      roleLabel: roleInfo.label,
      isBackRowLaggard: roleInfo.isBackRowLaggard,
      backRowReason: roleInfo.reason || '',
      rs5d: kl?.rs5d ?? null,
      isResilient: Boolean(kl?.isResilient),
      regimeMode: macroEnv.regimeMode,
      kl,
      vw: null,
      score: 0,
      verdict: '放弃',
      parts: null,
    };
    if (kl.ok) {
      if (roleInfo.isBackRowLaggard) {
        backrowFilteredCount += 1;
        rec.kl = { ...kl, backrowVeto: roleInfo.reason };
      } else {
        const liveVw = await vwapCheck(code);
        rec.vw = (liveVw && (!liveVw.date || liveVw.date === TODAY))
          ? liveVw
          : (cachedVwMap.get(code) || null);
      }
      const sc = scoreStock(rec);
      Object.assign(rec, { parts: sc.parts, score: sc.total, verdict: sc.verdict });
    }
    results.push(rec);
  }

  const passed = results
    .filter((r) => {
      if (!r.kl.ok || r.isBackRowLaggard || r.verdict === '放弃') return false;
      if (isStrictBear && (r.kl.aboveMa20 === false || (r.kl.rs5d ?? 0) < 1.5)) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);
  const strictPass = passed.filter((r) => r.vw && r.vw.strictPass);

  console.log(`\n通过涨停史 + 龙头身位 + VWAP 复核：${passed.length} 只（已主动剔除「看A做B」后排补涨跟风 ${backrowFilteredCount} 只）｜严格VWAP达标：${strictPass.length} 只`);
  if (!strictPass.length) {
    console.log('  ⚠ 严格六步法（Step6 = 全天不破均价线）今日零候选 —— 与评估预判一致。');
  }

  const show = passed.slice(0, limitN);
  const W = [10, 9, 10, 10, 7, 6, 7, 8, 8, 9, 7, 5, 6];
  const H = ['名称', '代码', '所属板块', '身位', '涨幅%', '量比', '换手%', '总市值', '在线%', '涨停日', '回落%', '得分', '结论'];
  console.log('\n' + '─'.repeat(110));
  console.log(H.map((h, i) => h.padEnd(W[i])).join(''));
  console.log('─'.repeat(110));
  for (const r of show) {
    const cells = [
      r.name.slice(0, 5), r.code, (r.sector || r.board).slice(0, 5), (r.roleLabel || '').replace(/^[^\u4e00-\u9fa5]+/, '').slice(0, 4),
      r.chgPct.toFixed(2), r.volRatio.toFixed(2),
      r.turnover.toFixed(2), r.totalCap.toFixed(0), (r.vw?.onlineRatio ?? '-').toString(),
      r.kl.hit.date.slice(5), r.kl.pullback.toFixed(1),
      r.score.toString(), r.verdict,
    ];
    console.log(cells.map((x, i) => String(x).padEnd(W[i])).join(''));
  }

  if (pool.length > 0 && passed.length === 0 && results.every((r) => r.kl?.reason === 'K线请求失败')) {
    console.error(`\n✗ 候选池 ${pool.length} 只标的日K请求 100% 失败（接口拦截或网络中断），拒绝用空结果覆盖 ${TODAY} 台账！`);
    process.exit(3);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${TODAY}.json`);
  fs.writeFileSync(file, JSON.stringify({
    date: TODAY, generatedAt: new Date().toISOString(),
    total: all.length, funnel,
    backrowFilteredCount,
    hotSectors: sectorMeta.hotSectors,
    hardPass: hardPass.map((s) => s.code),
    strictPass: strictPass.map((r) => r.code),
    results: passed,
  }, null, 2));
  console.log(`\n明细 → ${file}`);

  /* ---- 台账：清单 + 全市场收盘快照（收益回算的唯一数据源） ---- */
  if (isFallback) {
    console.warn(`⚠️ 本次使用的是跨日历史兜底快照（${fallbackFile}），已跳过写入 ledger/picks-${TODAY}.json 与 ledger/close-${TODAY}.json，防止污染收益台账！`);
  } else {
    const LEDGER = path.join(__dirname, 'ledger');
    fs.mkdirSync(LEDGER, { recursive: true });

    const picks = {
      date: TODAY,
      generatedAt: new Date().toISOString(),
      note: '引擎当日输出；含板块持续性与前排龙头身位过滤（已剔除后排补涨跟风）。',
      funnel,
      backrowFilteredCount,
      picks: passed.map((r) => ({
        code: r.code, name: r.name, board: r.board,
        sector: r.sector || '',
        sectorTier: r.sectorTier || '',
        sectorLabel: r.sectorLabel || '',
        leaderRole: r.leaderRole || '',
        roleLabel: r.roleLabel || '',
        chgRankInSector: r.chgRankInSector ?? null,
        amtRankInSector: r.amtRankInSector ?? null,
        chgPct: r.chgPct, volRatio: r.volRatio, turnover: r.turnover,
        totalCap: +r.totalCap.toFixed(1), amount: r.amount,
        score: r.score, verdict: r.verdict, parts: r.parts,
        limitUpDate: r.kl?.hit?.date || null,
        limitUpCount30d: r.kl?.limitUpCount30d ?? 1,
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
  }
})();
