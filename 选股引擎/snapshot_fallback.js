/**
 * snapshot_fallback.js —— 全市场快照备源（东财 clist 不可用时降级）
 *
 * 背景：engine.js 的 fetchAll 只有东财 clist 一条路，东财被限流（HTTP 000）时直接 exit(2)。
 * 本脚本用「新浪列表 + 腾讯批量」构造等价快照，写成 out/snapshot-YYYY-MM-DD.json，
 * 之后 engine.js 不带 --force 运行即会命中该缓存，后续流程完全不变。
 *
 * 字段来源：
 *   代码/名称/现价/涨跌幅/成交额/换手率/总市值  ← 新浪 Market_Center.getHQNodeData（hs_a）
 *   量比(f49)                                  ← 腾讯 qt.gtimg.cn 批量，60 只/次
 *
 * 用法：node snapshot_fallback.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
const TODAY = process.argv[2] || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const CACHE = path.join(OUT_DIR, `snapshot-${TODAY}.json`);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getText(url, encoding = 'utf-8', retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      return new TextDecoder(encoding).decode(buf);
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw err;
}

/* ---------- 1. 新浪：全 A 股列表 ---------- */
async function fetchSinaList() {
  const rows = [];
  let page = 1, emptyStreak = 0;
  const NUM = 100;
  while (page <= 80) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${NUM}&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
    let arr = [];
    try {
      const txt = await getText(url);
      arr = JSON.parse(txt || '[]');
    } catch (e) {
      console.log(`  新浪第 ${page} 页失败：${e.message}`);
    }
    if (!Array.isArray(arr) || !arr.length) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
      for (const d of arr) {
        const price = parseFloat(d.trade);
        const chgPct = parseFloat(d.changepercent);
        if (!Number.isFinite(price) || price <= 0) continue;   // 停牌
        if (!Number.isFinite(chgPct)) continue;
        rows.push({
          code: d.symbol,                       // 已带 sh/sz/bj 前缀
          raw: d.code,
          name: d.name,
          price,
          chgPct,
          amount: parseFloat(d.amount) || 0,     // 元
          turnover: parseFloat(d.turnoverratio) || 0,
          volRatio: null,                        // 待腾讯补
          totalCap: (parseFloat(d.mktcap) || 0) / 1e4, // 万元 → 亿
          high: parseFloat(d.high),
          low: parseFloat(d.low),
          prevClose: parseFloat(d.settlement),
        });
      }
    }
    page++;
    await new Promise((r) => setTimeout(r, 120));
    if (page % 10 === 0) console.log(`  新浪已抓 ${rows.length} 只（第 ${page - 1} 页）`);
  }
  return rows;
}

/* ---------- 2. 腾讯：批量补量比 ---------- */
async function fillVolRatio(rows) {
  const BATCH = 60;
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const q = chunk.map((r) => r.code).join(',');
    try {
      const txt = await getText(`https://qt.gtimg.cn/q=${q}`, 'gbk', 3);
      for (const line of txt.split(';')) {
        const m = line.match(/v_([a-z]{2}\d+)="([^"]*)"/);
        if (!m) continue;
        const f = m[2].split('~');
        const rec = chunk.find((r) => r.code === m[1]);
        if (!rec) continue;
        const vr = parseFloat(f[49]);
        if (Number.isFinite(vr)) { rec.volRatio = vr; ok++; }
        else fail++;
      }
    } catch {
      fail += chunk.length;
    }
    await new Promise((r) => setTimeout(r, 110));
    if ((i / BATCH + 1) % 20 === 0) console.log(`  腾讯量比已补 ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  return { ok, fail };
}

(async function main() {
  console.log(`\n【${TODAY}】全市场快照备源（新浪列表 + 腾讯量比）`);

  console.log('① 拉取新浪全 A 股列表…');
  let rows = await fetchSinaList();
  console.log(`   得到 ${rows.length} 只`);

  if (rows.length < 3000) {
    console.error(`✗ 新浪返回仅 ${rows.length} 只，不足 3000，放弃写缓存`);
    process.exit(2);
  }

  console.log('② 腾讯批量补量比…');
  const st = await fillVolRatio(rows);
  console.log(`   量比成功 ${st.ok} 只，失败 ${st.fail} 只`);

  const missing = rows.filter((r) => r.volRatio === null).length;
  if (missing > rows.length * 0.3) {
    console.error(`✗ 量比缺失 ${missing} 只（>30%），数据不可信，放弃写缓存`);
    process.exit(3);
  }
  // 少量缺失按 0 处理（会被「量比>1」门槛自然剔除，不影响严格口径）
  for (const r of rows) if (r.volRatio === null) r.volRatio = 0;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ date: TODAY, total: rows.length, rows, source: 'sina+tencent(fallback)' }, null, 0));
  const withVR = rows.filter((r) => r.volRatio > 0).length;
  console.log(`✓ 已写 ${CACHE}`);
  console.log(`  ${rows.length} 只｜有量比 ${withVR} 只｜成交额非空 ${rows.filter((r) => r.amount > 0).length} 只`);
})();
