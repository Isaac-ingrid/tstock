/**
 * tail.js —— 尾盘黑马盘中实时精选（14:30 定时任务专用）
 *
 * 与 engine.js 的根本区别：
 *   engine.js  收盘后跑，产的是「明天做T」的候选，同时写 ledger/picks + ledger/close；
 *   tail.js    14:30 盘中跑，产的是「今天尾盘潜伏、明天早盘冲高卖出」的隔夜 T+0 名单。
 *
 * 所以本脚本有三条铁律（踩过坑，别改）：
 *   1. 绝不写 ledger/ —— ledger/close-<日期>.json 是收益回算的唯一数据源，
 *      14:30 的半日价写进去，returns.js 当天收益全部失真且无法回滚。
 *   2. 绝不吃 engine.js 的当日 snapshot 缓存 —— 那份可能是盘前/半日残值。
 *      本脚本用独立的 tail-snapshot-<日期>-<时分>.json，每跑一次重抓一次。
 *   3. 分时数据必须校验日期 —— 开盘前/非交易日腾讯 minute 会返回「上一交易日全天」，
 *      不校验就会拿昨天的尾盘强度给今天打分。
 *
 * 盘中筛选口径（与隔夜 T+0 战法对齐，不是六步法）：
 *   涨幅 3%~7%（有强度但还没封板，封板买不到）
 *   量比 ≥ 1.2（尾盘有量）
 *   换手 3%~20%（够活跃但没爆量）
 *   总市值 30~300 亿（中小盘才有次日冲高弹性）
 *   现价 ≥ 当日最高 × 96%（尾盘收在高位，不接跳水）
 *   分时均价线上方占比 ≥ 80%（重心没塌）
 *   14:00 后量能密度 ≥ 0.8（尾盘有资金进，不是缩量阴跌）
 *
 * 用法：node tail.js [--top 2] [--dry]
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
const nowBJ = () => new Date(Date.now() + 8 * 3600 * 1000);
const TODAY = nowBJ().toISOString().slice(0, 10);
const HHMM = nowBJ().toISOString().slice(11, 16).replace(':', '');

const ARG = process.argv.slice(2);
const TOPN = ARG.includes('--top') ? +ARG[ARG.indexOf('--top') + 1] : 2;
const DRY = ARG.includes('--dry');

/* ---------------- 口径 ---------------- */
const CFG = {
  chgMin: 3, chgMax: 7,
  volRatioMin: 1.2,
  turnoverMin: 3, turnoverMax: 20,
  capMin: 30, capMax: 300,
  closeStrengthMin: 96,      // 现价 / 当日最高
  vwapOnlineMin: 80,
  /* 尾盘量能密度只用于打分，不做硬闸门。
     原因：14:00–15:00 本身是全天次低量时段，密度 0.4~0.7 是常态；
     14:30 跑的时候 14:00 后才走了一半，密度天然更低。
     拿它当闸门会把整市场一天全部筛空（实测 28 只里淘汰 19 只）。 */
  scoreMin: 70,              // 低于此分不进推送名单，宁缺毋滥
  prefilterN: 70,            // 进分时复核的数量上限（控速，防限流）
  /* 排除板块（2026-11-09 用户口径）：不要创业板。
     创业板 300/301/302 开头，20% 涨跌幅，隔夜 T+0 回撤弹性过大，故整类剔除。
     可用 --exclude=创业板,科创板 追加，或 --exclude=none 关闭排除。 */
  excludeBoards: ['创业板'],
};

/* --exclude=创业板,科创板 覆盖默认排除项；--exclude=none 关闭排除 */
const EXCLUDE = (() => {
  const a = ARG.find((s) => s.startsWith('--exclude='));
  if (!a) return CFG.excludeBoards;
  const v = a.slice('--exclude='.length).trim();
  if (!v || v.toLowerCase() === 'none') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
})();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url, encoding = 'utf-8', retry = 3) {
  let lastErr;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: url.includes('eastmoney') ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/',
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

/* ---------------- 板块与涨跌幅上限 ---------------- */
function boardOf(code) {
  const c = code.replace(/^(sh|sz|bj)/, '');
  if (c.startsWith('688')) return '科创板';
  if (/^(300|301|302)/.test(c)) return '创业板';
  if (/^(4|8|920)/.test(c)) return '北交所';
  return '主板';
}
const LIMIT_OF = { 主板: 10, 创业板: 20, 科创板: 20, 北交所: 30 };

/* ---------------- 全市场实时快照（复用 engine.js 的分页+轮换方案，独立缓存） ---------------- */
const EM_HOSTS = [1, 2, 7, 8, 9, 21, 25, 32, 40, 60, 82, 90];
const emHost = () => `${EM_HOSTS[Math.floor(Math.random() * EM_HOSTS.length)]}.push2.eastmoney.com`;
const EM_QS =
  'po=1&np=1&fltt=2&invt=2&fid=f3&pz=100' +
  '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' +
  '&fields=f2,f3,f6,f8,f10,f12,f14,f15,f16,f18,f20';

const CACHE = path.join(OUT_DIR, `tail-snapshot-${TODAY}-${HHMM}.json`);

function mapRow(d) {
  const p = d.f12.startsWith('6') ? 'sh' : d.f12.startsWith('9') || d.f12.startsWith('4') ? 'bj' : 'sz';
  return {
    code: p + d.f12, raw: d.f12, name: d.f14,
    price: d.f2, chgPct: d.f3, amount: d.f6, turnover: d.f8,
    volRatio: d.f10, totalCap: d.f20 / 1e8,
    high: d.f15, low: d.f16, prevClose: d.f18,
  };
}

async function fetchSnapshot({ force = true } = {}) {
  if (!force && fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c?.rows?.length > 3000) { console.log(`（复用 ${path.basename(CACHE)}，${c.rows.length} 只）`); return c.rows; }
  }
  const total = (await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=1`))?.data?.total || 0;
  const pages = Math.ceil(total / 100);
  console.log(`  全市场 ${total} 只，${pages} 页`);
  const out = [];
  let next = 1;
  const worker = async () => {
    while (next <= pages) {
      const pn = next++;
      try {
        const j = await getJson(`https://${emHost()}/api/qt/clist/get?${EM_QS}&pn=${pn}`, 'utf-8', 4);
        for (const d of j?.data?.diff || []) out.push(mapRow(d));
      } catch { /* 单页失败跳过 */ }
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const rows = out.filter((x) => Number.isFinite(x.chgPct) && x.price > 0);
  if (rows.length > 2000) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ date: TODAY, at: HHMM, total, rows }, null, 0));
  }
  return rows;
}

/* ---------------- 日K：30 日内涨停史（只做加分项，失败不淘汰） ---------------- */
async function klineCheck(code, board, name) {
  const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,90,qfq`;
  let j;
  try { j = await getJson(url); } catch { return { ok: false, reason: 'K线请求失败' }; }
  const d = j?.data?.[code];
  const arr = d?.qfqday || d?.day;
  if (!Array.isArray(arr) || arr.length < 10) return { ok: false, reason: 'K线不足' };
  const bars = arr.map((r) => ({ date: r[0], close: +r[2], high: +r[3], low: +r[4] }));
  /* 末根若是今天（盘中未收盘），剔除，只用已收盘的历史算涨停史 */
  const hist = bars.at(-1).date === TODAY ? bars.slice(0, -1) : bars;
  const effLimit = /ST/i.test(name) ? 5 : LIMIT_OF[board];
  let hit = null;
  const scan = hist.slice(-31);
  for (let i = 1; i < scan.length; i++) {
    const chg = (scan[i].close / scan[i - 1].close - 1) * 100;
    if (chg >= effLimit - 0.35 && Math.abs(scan[i].close - scan[i].high) < 0.005) {
      hit = { date: scan[i].date, low: scan[i].low, close: scan[i].close, chg: +chg.toFixed(2) };
    }
  }
  if (!hit) return { ok: false, reason: '30日内无涨停' };
  const last = hist.at(-1).close;
  return { ok: true, hit, pullback: +(((hit.close - last) / hit.close) * 100).toFixed(2), brokeLow: last < hit.low };
}

const { vwapCheck } = require('./vwap');

/* ---------------- 打分：尾盘强度为主，涨停史只占 5 分 ----------------
 * 尾盘量能密度用「相对当日全市场中位数」打分，不用绝对值：
 * 14:00–15:00 是全天次低量时段，密度 0.4~0.7 是常态，缩量日整市场都低、
 * 放量日整市场都高。用固定阈值会在缩量日把候选筛空、在放量日放一堆垃圾进来。
 */
function scoreTail(c, vw, kl, medianTI) {
  const p = {};
  const chg = c.chgPct;
  p.chg = chg >= 4 && chg <= 6 ? 20 : chg >= 3 ? 14 : chg <= 7 ? 14 : 8;

  const cs = vw?.closeStrength;
  p.pos = cs == null ? 6 : cs >= 99 ? 20 : cs >= 98 ? 16 : cs >= 97 ? 12 : cs >= 96 ? 8 : 3;

  const on = vw?.onlineRatio;
  p.vwap = on == null ? 0 : on >= 95 ? 15 : on >= 90 ? 12 : on >= 85 ? 9 : on >= 80 ? 6 : 0;

  const ti = vw?.tailIntensity;
  let rel = null;
  if (ti != null && medianTI > 0) rel = ti / medianTI;      // 1 = 与全市场中位持平
  p.tail = rel == null ? 6
    : rel >= 2.0 ? 15 : rel >= 1.5 ? 13 : rel >= 1.2 ? 11 : rel >= 1.0 ? 9 : rel >= 0.8 ? 6 : 3;

  const vr = c.volRatio;
  p.vol = vr >= 2.5 ? 15 : vr >= 2 ? 13 : vr >= 1.5 ? 11 : vr >= 1.2 ? 8 : 3;

  const tr = c.turnover;
  p.turn = tr >= 5 && tr <= 10 ? 10 : tr >= 3 && tr <= 15 ? 7 : 4;

  p.limitUp = kl?.ok ? (kl.brokeLow ? 1 : 5) : 0;

  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const verdict = total >= 80 ? '可挂' : total >= 70 ? '观察' : '放弃';
  return { parts: p, total, verdict, tailRel: rel == null ? null : +rel.toFixed(2) };
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  console.log(`\n【${TODAY} ${HHMM.slice(0, 2)}:${HHMM.slice(2)}】尾盘黑马实时精选`);

  /* 0. 时间闸：14:30 前跑没有意义（尾盘强度还没成形），15:00 后跑就该走 engine.js */
  const mins = +HHMM.slice(0, 2) * 60 + +HHMM.slice(2);
  if (mins < 845 && !DRY) console.log('  ⚠ 当前早于 14:05，尾盘量能尚未成形，结果仅供参考');
  if (mins >= 1500 && !DRY) console.log('  ⚠ 已收盘，尾盘战法请改用 engine.js 的收盘候选');

  /* 1. 实时全市场快照 */
  console.log('① 拉取全市场实时快照…');
  let all;
  try {
    all = await fetchSnapshot({ force: true });
  } catch (e) {
    console.error('✗ 全市场快照失败：' + e.message);
    console.error('  东财 clist 限流时，可先跑 node snapshot_fallback.js 生成兜底快照（但那不是实时价，仅供试跑）。');
    process.exit(2);
  }
  console.log(`  ${all.length} 只有效`);

  /* 2. 快照级预筛 */
  const pre = all.filter((s) => {
    if (/ST/i.test(s.name)) return false;
    if (/^(bj)/.test(s.code)) return false;                        // 北交所 30% 涨跌幅，隔夜风险不成比例
    if (EXCLUDE.includes(boardOf(s.code))) return false;           // 用户口径：排除创业板等
    if (s.totalCap < CFG.capMin || s.totalCap > CFG.capMax) return false;
    if (s.chgPct < CFG.chgMin || s.chgPct > CFG.chgMax) return false;
    if (!(s.volRatio >= CFG.volRatioMin)) return false;
    if (s.turnover < CFG.turnoverMin || s.turnover > CFG.turnoverMax) return false;
    if (s.high > 0 && s.price < s.high * (CFG.closeStrengthMin / 100)) return false;
    const lim = LIMIT_OF[boardOf(s.code)] ?? 10;
    if (s.chgPct >= lim - 0.6) return false;                       // 已近封板，买不到
    if (s.high > 0 && s.high === s.low) return false;              // 一字板
    return true;
  });
  console.log(`② 快照预筛：${pre.length} 只` +
    (EXCLUDE.length ? `（已排除 ${EXCLUDE.join('、')}）` : '') +
    (pre.length ? `（${pre.slice(0, 6).map((s) => s.name).join('、')}${pre.length > 6 ? '…' : ''}）` : ''));

  if (!pre.length) {
    console.log('  今日无标的通过预筛 —— 尾盘不勉强，空仓是最优操作。');
  }

  /* 3. 排序后取前 N 做分时 + 日K 复核。
      预排序把「收在高位」当主权重：尾盘黑马的核心特征是收盘价贴着当日最高，
      而不是涨幅最大。涨幅只是入场门槛，已由预筛管住。 */
  const preRank = pre
    .map((s) => ({
      ...s,
      _pre: (s.high > 0 ? (s.price / s.high) * 100 : 0) * 1.2   // 收在高位：主权重
        + Math.min(s.volRatio, 4) * 3                            // 有量
        + Math.min(s.turnover, 12) * 0.6                         // 换手别太死
        + Math.min(s.chgPct, 7) * 1.5,                           // 涨幅（已过门槛）
    }))
    .sort((a, b) => b._pre - a._pre)
    .slice(0, CFG.prefilterN);

  const pool = [];
  for (const s of preRank) {
    const board = boardOf(s.code);
    const vw = await vwapCheck(s.code);
    /* 日期守卫：不是今天的分时一律判无效 */
    if (vw && vw.date && vw.date !== TODAY) {
      console.log(`  ! ${s.name} 分时日期为 ${vw.date}，非今日，丢弃`);
      pool.push({ ...s, board, vw: null, kl: null, dropped: '分时非今日' });
      continue;
    }
    pool.push({ ...s, board, vw, kl: null });
    await new Promise((r) => setTimeout(r, 80));
  }

  /* 尾盘量能密度的当日基准：取所有取到分时的样本的中位数 */
  const tis = pool.map((r) => r.vw?.tailIntensity).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const medianTI = tis.length ? tis[Math.floor(tis.length / 2)] : 0;
  if (tis.length) {
    console.log(`  尾盘量能密度中位 ${medianTI.toFixed(2)}（样本 ${tis.length} 只，区间 ${tis[0].toFixed(2)}–${tis.at(-1).toFixed(2)}）`);
  }

  /* 涨停史只对已过分时硬闸门的做，省请求 */
  const survivors = pool.filter((r) => {
    if (!r.vw || r.dropped) return false;
    if (r.vw.onlineRatio < CFG.vwapOnlineMin) return false;
    if ((r.vw.closeStrength ?? 0) < CFG.closeStrengthMin) return false;
    return true;
  });

  for (const r of survivors) {
    r.kl = await klineCheck(r.code, r.board, r.name);
    Object.assign(r, scoreTail(r, r.vw, r.kl, medianTI));
    await new Promise((res) => setTimeout(res, 80));
  }

  const passed = survivors
    .filter((r) => r.total >= CFG.scoreMin && r.verdict !== '放弃')
    .sort((a, b) => b.total - a.total);

  console.log(`③ 分时+涨停史复核后合格 ${passed.length} 只，取 TOP ${Math.min(TOPN, passed.length)}`);

  const picks = passed.slice(0, Math.max(TOPN, 2)).map((r, i) => {
    const px = +r.price;
    const lim = LIMIT_OF[r.board] ?? 10;
    const room = +(((r.prevClose * (1 + lim / 100)) / px - 1) * 100).toFixed(2);
    return {
      rank: i + 1,
      code: r.raw || r.code.replace(/^(sh|sz|bj)/, ''),
      tcode: r.code,
      name: r.name,
      pool: 'tail',
      poolLabel: '尾盘黑马',
      price: px,
      chgPct: +r.chgPct.toFixed(2),
      volRatio: +r.volRatio.toFixed(2),
      turnover: +r.turnover.toFixed(2),
      totalCap: +r.totalCap.toFixed(1),
      score: r.total,
      verdict: r.verdict,
      parts: r.parts,
      high: +(r.high || 0).toFixed(2),
      low: +(r.low || 0).toFixed(2),
      prevClose: +(+r.prevClose).toFixed(2),
      vwap: +r.vw.lastVwap.toFixed(2),
      vwapOnline: r.vw.onlineRatio,
      closeStrength: r.vw.closeStrength,
      tailIntensity: r.vw.tailIntensity,
      tailRel: r.tailRel,
      tailVolShare: r.vw.tailVolShare == null ? null : +(r.vw.tailVolShare * 100).toFixed(1),
      limitRoom: room,                                // 距涨停还有多少空间 %
      limitUpDate: r.kl?.ok ? r.kl.hit.date : null,
      retOpen: +r.chgPct.toFixed(2),                  // 供页面沿用「日内涨幅」字段
      whyReasons: [
        `📈 现价 ${px.toFixed(2)}，日内 +${r.chgPct.toFixed(2)}%，距涨停还有 ${room}% 空间（未封板，买得进）`,
        `🛡️ 分时均价线上方运行 ${r.vw.onlineRatio}%，现价站在当日最高价 ${r.vw.closeStrength}% 的位置`,
        r.vw.tailIntensity != null
          ? `🔥 14:00 后量能密度 ${r.vw.tailIntensity}×，为当日全市场中位的 ${r.tailRel} 倍（尾盘成交占全天 ${(r.vw.tailVolShare * 100).toFixed(1)}%）`
          : `🔥 量比 ${r.volRatio}、换手 ${r.turnover}%，尾盘成交活跃`,
        r.kl?.ok
          ? `⚡ 涨停基因：${r.kl.hit.date} 曾涨停，此后回落 ${r.kl.pullback}%，未破涨停日低点`
          : `⚡ 无 30 日涨停记录，纯尾盘强度入选，仓位按半仓执行`,
      ],
    };
  });

  /* 5. 环境闸门（读最近一次的 plan-*.json，没有就退回中性） */
  let env = { level: 'UNKNOWN', text: '缺少 plan-*.json，未做环境判定', posFactor: 0.5 };
  try {
    const files = fs.readdirSync(OUT_DIR).filter((f) => /^plan-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (files.length) {
      const pl = JSON.parse(fs.readFileSync(path.join(OUT_DIR, files.at(-1)), 'utf8'));
      if (pl?.env) env = { level: pl.env.level, text: pl.env.text, posFactor: pl.env.level === 'OK' ? 1 : pl.env.level === 'WARN' ? 0.5 : 0 };
    }
  } catch { /* 保留中性 */ }
  if (env.level === 'BAD') {
    console.log('  ⚠ 环境闸门 BAD（指数跌破 MA20/MA60），尾盘潜伏建议直接放弃，或只用 1/4 仓位试单');
  }

  /* 6. 落盘 */
  const payload = {
    date: TODAY,
    scanTime: `${HHMM.slice(0, 2)}:${HHMM.slice(2)}`,
    generatedAt: new Date().toISOString(),
    note: '尾盘黑马（隔夜 T+0）盘中实时精选。14:30 生成，次日 09:30–10:00 冲高闭环。不写 ledger，不参与收益回算。',
    cfg: CFG,
    excludeBoards: EXCLUDE,
    env,
    stats: {
      totalMarket: all.length,
      prefilter: pre.length,
      reviewed: pool.length,
      passed: passed.length,
    },
    picks,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `tail-${TODAY}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));

  console.log('\n' + '─'.repeat(78));
  if (!picks.length) {
    console.log('今日尾盘无合格黑马，宁缺毋滥。');
  } else {
    console.log('排名  名称        代码      涨幅%  量比  换手%  均价上%  高位%  尾盘密度  得分  结论  距涨停');
    for (const p of picks) {
      console.log(
        String(p.rank).padEnd(6) + p.name.slice(0, 6).padEnd(12) + p.code.padEnd(10) +
        String(p.chgPct).padEnd(7) + String(p.volRatio).padEnd(6) + String(p.turnover).padEnd(7) +
        String(p.vwapOnline).padEnd(9) + String(p.closeStrength).padEnd(7) +
        String(p.tailIntensity ?? '-').padEnd(10) + String(p.score).padEnd(5) + p.verdict.padEnd(6) + (p.limitRoom + '%')
      );
    }
  }
  console.log('─'.repeat(78));
  console.log(`→ ${file}`);
  console.log(`环境 ${env.level}（仓位系数 ${env.posFactor}）｜下一步：node publish.js 把名单发布到 data/latest.js\n`);
})();