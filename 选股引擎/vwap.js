/**
 * vwap.js —— 分时均价线（VWAP）破线统计
 *
 * 主源：腾讯 minute（累计量 + 累计额，VWAP = 累计额 ÷ 累计量 ÷ 100）
 * 备源：东财 trends2（直接给每分钟均价，字段 f58）
 * 两源都不可用时返回 null，调用方须按「无法验证」处理，不能当作通过。
 *
 * 返回：total / below / onlineRatio / belowAfter10 / since10 / firstBreach / lastVwap / strictPass / source
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
  for (const q of pts) {
    const isBelow = q.price < q.vwap - 1e-9;
    if (isBelow) { below++; if (!firstBreach) firstBreach = q.t; }
    if (q.t > 1000) { since10++; if (isBelow) belowAfter10++; }
  }
  return {
    total: pts.length,
    below,
    onlineRatio: +(((pts.length - below) / pts.length) * 100).toFixed(1),
    belowAfter10,
    since10,
    firstBreach,
    lastVwap: +pts.at(-1).vwap.toFixed(3),
    strictPass: below === 0,
  };
}

async function fromTencent(code) {
  const j = await getJson(TENCENT(code));
  const arr = j?.data?.[code]?.data?.data;
  if (!Array.isArray(arr) || !arr.length) return null;
  const pts = [], seen = new Set();
  for (const s of arr) {
    const [hhmm, p, v, a] = s.trim().split(/\s+/);
    const t = +hhmm;
    if (t > 1500 || seen.has(t)) continue;      // 截断 15:00 后静态点；去掉 13:00 重复
    seen.add(t);
    const cumVol = +v;
    if (!cumVol) continue;
    pts.push({ t, price: +p, vwap: +a / (cumVol * 100) });
  }
  return summarize(pts);
}

async function fromEastmoney(code) {
  const j = await getJson(EM(secid(code)));
  const arr = j?.data?.trends;
  if (!Array.isArray(arr) || !arr.length) return null;
  const pts = [], seen = new Set();
  for (const s of arr) {
    const f = s.split(',');
    const hhmm = f[0].slice(11, 16).replace(':', '');
    const t = +hhmm;
    if (!Number.isFinite(t) || t > 1500 || seen.has(t)) continue;
    seen.add(t);
    pts.push({ t, price: +f[1], vwap: +f[3] });
  }
  return summarize(pts);
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
