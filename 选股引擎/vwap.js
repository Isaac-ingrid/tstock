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
const API_BASE = process.env.STOCK_API_BASE || 'http://127.0.0.1:18765';
const TENCENT = (code) => `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
const EM = (secid, ndays = 1) =>
  `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
  `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=${ndays}`;

const normTcode = (code) => {
  const s = String(code || '').trim();
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(s);
  if (m) {
    const p = m[2].toUpperCase();
    return (p === 'SH' ? 'sh' : p === 'SZ' ? 'sz' : 'bj') + m[1];
  }
  if (/^(sh|sz|bj)\d{6}$/i.test(s)) return s.toLowerCase();
  if (/^\d{6}$/.test(s)) {
    return (s.startsWith('6') ? 'sh' : s.startsWith('9') || s.startsWith('4') || s.startsWith('8') ? 'bj' : 'sz') + s;
  }
  return s.toLowerCase();
};

const isIndexCode = (tcode) => /^sh000\d{3}$/.test(tcode) || /^sz399\d{3}$/.test(tcode);
const secid = (code) => {
  const t = normTcode(code);
  return (t.startsWith('sh') ? '1.' : '0.') + t.replace(/^(sh|sz|bj)/, '');
};

let localGatewayDownUntil = 0;

async function getJson(url, retry = 2, timeoutMs = 6000) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const referer = url.includes('eastmoney')
        ? 'https://quote.eastmoney.com/'
        : url.includes('sina.')
          ? 'https://finance.sina.com.cn/'
          : 'https://gu.qq.com/';
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: referer,
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const statusErr = new Error(`HTTP ${res.status}`);
        if (res.status === 501 || res.status === 403) statusErr.noRetry = true;
        throw statusErr;
      }
      const txt = new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer()));
      return JSON.parse(txt);
    } catch (e) {
      err = e;
      if (e && e.noRetry) break;
      if (i + 1 < retry) await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw err;
}

let activeLocalBase = null;

async function callLocalBackend(relPath, timeoutMs = 6000) {
  if (Date.now() < localGatewayDownUntil) return null;
  const altBase = API_BASE.includes(':18765') ? API_BASE.replace(':18765', ':8000') : null;
  const bases = activeLocalBase
    ? [activeLocalBase]
    : [API_BASE, altBase].filter(Boolean);
  let allRefused = true;
  for (const base of bases) {
    try {
      const data = await getJson(`${base}${relPath}`, 1, timeoutMs);
      activeLocalBase = base;
      return data;
    } catch (e) {
      const refused = e && (e.code === 'ECONNREFUSED' || String(e.cause?.code || '').includes('ECONNREFUSED'));
      if (!refused) allRefused = false;
    }
  }
  if (allRefused) {
    activeLocalBase = null;
    localGatewayDownUntil = Date.now() + 60 * 1000;
  }
  return null;
}

async function getViaLocalGateway(upstreamUrl, timeoutMs = 6000) {
  return callLocalBackend(`/api/proxy?url=${encodeURIComponent(upstreamUrl)}`, timeoutMs);
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
  const j = (await getViaLocalGateway(TENCENT(code), 5000)) || (await getJson(TENCENT(code), 2, 5000));
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

let emTrendFailStreak = 0;
let emTrendPausedUntil = 0;

async function fromEastmoney(code) {
  if (Date.now() < emTrendPausedUntil) return null;
  let j;
  try {
    j = await getJson(EM(secid(code)), 1, 3500);
    emTrendFailStreak = 0;
  } catch (e) {
    emTrendFailStreak += 1;
    if (emTrendFailStreak >= 3) emTrendPausedUntil = Date.now() + 5 * 60 * 1000;
    throw e;
  }
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

/* ---------------- 统一日K与分钟K客户端（复用本地后端多源防501网关 + 内存缓存 + 东财熔断） ---------------- */
const dailyCache = new Map();
let emKlineFailStreak = 0;
let emKlinePausedUntil = 0;

async function fetchDailyKline(code, count = 90) {
  const tcode = normTcode(code);
  const reqN = Math.max(30, Number(count) || 90);

  const hit = dailyCache.get(tcode);
  if (hit && hit.reqCount >= reqN && hit.bars.length) {
    return hit.bars.slice(-reqN);
  }

  // ① 主源：调用本地后端 /api/stock/klines（自动兼容本机 :18765 与线上 :8000）
  const j = await callLocalBackend(`/api/stock/klines?code=${encodeURIComponent(tcode)}&period=day&count=${reqN}`, 7000);
  if (Array.isArray(j?.bars) && j.bars.length) {
    const bars = j.bars
      .map((b) => ({
        date: String(b.date).slice(0, 10),
        open: +b.open,
        close: +b.close,
        high: +b.high,
        low: +b.low,
        vol: +(b.vol || 0),
        amount: +(b.amount || 0),
      }))
      .filter((b) => b.date && Number.isFinite(b.close) && b.close > 0);
    if (bars.length) {
      dailyCache.set(tcode, { reqCount: reqN, bars });
      return bars.slice(-reqN);
    }
  }

  // ② 离线独立运行备源：东财短超时 + 连续 3 次失败熔断（杜绝 300s 挂死）
  const isIdx = isIndexCode(tcode);
  if (Date.now() >= emKlinePausedUntil) {
    try {
      const emUrl =
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(tcode)}` +
        `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=${isIdx ? 0 : 1}&end=20500101&lmt=${reqN}`;
      const j = await getJson(emUrl, 1, 3500);
      const kl = j?.data?.klines;
      if (Array.isArray(kl) && kl.length) {
        emKlineFailStreak = 0;
        const bars = kl
          .map((line) => {
            const p = String(line).split(',');
            return {
              date: p[0].slice(0, 10),
              open: +p[1],
              close: +p[2],
              high: +p[3],
              low: +p[4],
              vol: +(p[5] || 0),
              amount: +(p[6] || 0),
            };
          })
          .filter((b) => b.date && Number.isFinite(b.close) && b.close > 0);
        if (bars.length) {
          dailyCache.set(tcode, { reqCount: reqN, bars });
          return bars.slice(-reqN);
        }
      }
    } catch {
      emKlineFailStreak += 1;
      if (emKlineFailStreak >= 3) emKlinePausedUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  return null;
}

async function fetchDailyKlineRows(code, count = 30) {
  const bars = await fetchDailyKline(code, count);
  if (!bars || !bars.length) return [];
  return bars.map((b) => [
    b.date,
    String(b.open),
    String(b.close),
    String(b.high),
    String(b.low),
    String(b.vol),
  ]);
}

async function fetchMinuteKline(code, period = 'm30', count = 800) {
  const tcode = normTcode(code);
  const mkBase = TENCENT(tcode).split('/minute/')[0];
  const upstream = `${mkBase}/kline/mkline?param=${tcode},${period},,${count}`;
  const gw = await getViaLocalGateway(upstream, 6500);
  if (gw?.data?.[tcode]?.[period]?.length) {
    return gw.data[tcode][period];
  }
  try {
    const j = await getJson(upstream, 1, 5000);
    if (j?.data?.[tcode]?.[period]?.length) return j.data[tcode][period];
  } catch { /* 下一源 */ }
  return null;
}

module.exports = {
  vwapCheck,
  fetchDailyKline,
  fetchDailyKlineRows,
  fetchMinuteKline,
};
