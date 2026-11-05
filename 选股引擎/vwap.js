/**
 * vwap.js —— 分时均价线（VWAP）破线统计
 *
 * 主源：腾讯 minute（累计量 + 累计额，VWAP = 累计额 ÷ 累计量 ÷ 100）
 * 备源：东财 trends2（直接给每分钟均价，字段 f58）
 * 两源都不可用时返回 null，调用方须按「无法验证」处理，不能当作通过。
 *
 * 返回：total / below / onlineRatio / belowAfter10 / since10 / firstBreach / lastVwap / strictPass / source
 * 尾盘专用（供 tail.js 用，收盘选股不读）：high / closeStrength / tailVolShare / tailTimeShare / tailIntensity
 *   tailIntensity = 14:00 后成交占比 ÷ 14:00 后分钟数占比，>1 表示尾盘放量，无 14:00 后数据时为 null
 */
const TENCENT = (code) => `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
const EM = (secid, ndays = 1) =>
  `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
  `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=${ndays}`;

const secid = (code) => (code.startsWith('sh') ? '1.' : '0.') + code.replace(/^(sh|sz|bj)/, '');

async function getJson(url, retry = 2) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: url.includes('eastmoney') ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/' },
      });
      const txt = new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer()));
      return JSON.parse(txt);
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw err;
}

function summarize(pts) {
  if (pts.length < 30) return null;
  let below = 0, belowAfter10 = 0, since10 = 0, firstBreach = null;
  let high = pts[0].price;
  for (const q of pts) {
    if (q.price > high) high = q.price;
    const isBelow = q.price < q.vwap - 1e-9;
    if (isBelow) { below++; if (!firstBreach) firstBreach = q.t; }
    if (q.t > 1000) { since10++; if (isBelow) belowAfter10++; }
  }

  /* ---- 尾盘强度（14:00 之后）---- */
  const last = pts.at(-1);
  const tail = pts.filter((q) => q.t >= 1400);
  let tailIntensity = null, tailVolShare = null, tailTimeShare = null;
  /* 防御：累计量必须单调递增。腾讯给的是累计量、东财是分钟量需自行累加，
     任何一个源口径搞错（比如把分钟量当累计量），这里会直接看出来。
     加了这道检查之后，宁可返回 null 也不用脏数据算尾盘强度。 */
  const monotonic = pts.every((q, i) => i === 0 || q.vol >= pts[i - 1].vol);
  if (monotonic && tail.length >= 5 && Number.isFinite(last.vol) && last.vol > 0) {
    const firstTail = tail[0];
    /* 累计量是「截至该分钟」的，14:00 那一根本身只含 14:00 这一分钟，
       所以 14:00 后的成交量 = 末根累计 − 14:00 前一根累计。
       找不到前一根就直接拿 14:00 那根的累计当基线（略偏保守）。 */
    const idxFirst = pts.indexOf(firstTail);
    const baseVol = idxFirst > 0 && Number.isFinite(pts[idxFirst - 1].vol) ? pts[idxFirst - 1].vol : 0;
    const tailVol = last.vol - baseVol;
    const tailMin = tail.length;
    const totalMin = pts.length;
    tailVolShare = +(tailVol / last.vol).toFixed(4);
    tailTimeShare = +(tailMin / totalMin).toFixed(4);
    tailIntensity = +(tailVolShare / tailTimeShare).toFixed(2);
  }

  return {
    total: pts.length,
    below,
    onlineRatio: +(((pts.length - below) / pts.length) * 100).toFixed(1),
    belowAfter10,
    since10,
    firstBreach,
    lastVwap: +last.vwap.toFixed(3),
    strictPass: below === 0,
    high: +high.toFixed(2),
    lastPrice: +last.price.toFixed(2),
    /* 收盘（或当前）价在当日区间中的位置：1 = 收在最高，0 = 收在最低 */
    closeStrength: high > 0 ? +((last.price / high) * 100).toFixed(1) : null,
    tailVolShare,
    tailTimeShare,
    tailIntensity,
  };
}

/* 腾讯返回 20261105，东财返回 2026-11-05，统一成后者，否则日期比对永远不等 */
const normDate = (d) => {
  const s = String(d || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
};

async function fromTencent(code) {
  const j = await getJson(TENCENT(code));
  const node = j?.data?.[code]?.data;
  const arr = node?.data;
  if (!Array.isArray(arr) || !arr.length) return null;
  const pts = [], seen = new Set();
  for (const s of arr) {
    const [hhmm, p, v, a] = s.trim().split(/\s+/);
    const t = +hhmm;
    if (t > 1500 || seen.has(t)) continue;      // 截断 15:00 后静态点；去掉 13:00 重复
    seen.add(t);
    const cumVol = +v;
    if (!cumVol) continue;
    pts.push({ t, price: +p, vol: cumVol, vwap: +a / (cumVol * 100) });
  }
  const r = summarize(pts);
  /* 记下数据日期：盘中取数时必须校验是「今天」，否则拿到的是上一交易日全天，
     拿它算尾盘强度会得出一个完全假的结论。 */
  return r ? { ...r, date: normDate(node?.date) || null } : null;
}

async function fromEastmoney(code) {
  const j = await getJson(EM(secid(code)));
  const arr = j?.data?.trends;
  if (!Array.isArray(arr) || !arr.length) return null;
  const pts = [], seen = new Set();
  let cum = 0;
  for (const s of arr) {
    const f = s.split(',');
    const hhmm = f[0].slice(11, 16).replace(':', '');
    const t = +hhmm;
    if (!Number.isFinite(t) || t > 1500 || seen.has(t)) continue;
    seen.add(t);
    /* 东财 f56 是「该分钟成交量」（手），不是累计量；
       腾讯那边是累计量。这里现累加，保持两个源同构，否则尾盘量能会算成负数。 */
    cum += +f[2] || 0;
    pts.push({ t, price: +f[1], vol: cum, vwap: +f[3] });
  }
  const r = summarize(pts);
  return r ? { ...r, date: normDate(arr[0] ? arr[0].slice(0, 10) : null) } : null;
}

async function vwapCheck(code) {
  try {
    const a = await fromTencent(code);
    if (a) return { ...a, source: '腾讯' };
  } catch { /* 落到备源 */ }
  try {
    const b = await fromEastmoney(code);
    if (b) return { ...b, source: '东财' };
  } catch { /* 两源都失败 */ }
  return null;
}

module.exports = { vwapCheck };
