/**
 * scripts/tencent_market_snapshot.cjs
 *
 * 全市场沪深 A 股腾讯极速实时快照引擎（免 WAF、云服务器机房 IP 零封禁兜底主备源）
 *
 * 数据源：
 *   1. 本地底表 data/ashare_universe.json（含 4978+ 沪深 A 股代码、名称与东财同口径行业板块）
 *      并自动合并 选股引擎/out/ 下任意历史快照的新增代码；
 *   2. 腾讯实时批量行情 https://qt.gtimg.cn/q=...（80只/批，14并发，全主板约 0.3~0.6s，全市场约 0.5~0.9s）
 *      一次性补齐实时现价、涨跌幅、成交额、换手率、量比(f49)、总市值(f45)、最高、最低、昨收。
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const UNIVERSE_FILE = path.join(ROOT_DIR, 'data', 'ashare_universe.json');
const ENGINE_OUT_DIR = path.join(ROOT_DIR, '选股引擎', 'out');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function loadUniverseEntries({ mainboardOnly = false } = {}) {
  const byTcode = new Map();

  if (fs.existsSync(UNIVERSE_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (!Array.isArray(item) || item.length < 2) continue;
          const tc = String(item[0] || '').trim().toLowerCase();
          if (!/^(sh|sz)\d{6}$/.test(tc)) continue;
          byTcode.set(tc, {
            tcode: tc,
            raw: tc.slice(2),
            name: String(item[1] || '').trim(),
            sector: String(item[2] || '其他板块').trim() || '其他板块',
          });
        }
      }
    } catch {}
  }

  // 自动合并选股引擎 out 目录下最新历史快照可能新增的新股代码
  if (fs.existsSync(ENGINE_OUT_DIR)) {
    try {
      const snaps = fs
        .readdirSync(ENGINE_OUT_DIR)
        .filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .slice(-2);
      for (const sf of snaps) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(ENGINE_OUT_DIR, sf), 'utf8'));
          for (const r of data?.rows || []) {
            const tc = String(r.code || '').trim().toLowerCase();
            if (!/^(sh|sz)\d{6}$/.test(tc)) continue;
            const prev = byTcode.get(tc);
            if (!prev) {
              byTcode.set(tc, {
                tcode: tc,
                raw: tc.slice(2),
                name: String(r.name || '').trim(),
                sector: String(r.sector || '其他板块').trim() || '其他板块',
              });
            } else if ((!prev.sector || prev.sector === '其他板块') && r.sector) {
              prev.sector = String(r.sector).trim();
            }
          }
        } catch {}
      }
    } catch {}
  }

  let list = Array.from(byTcode.values());
  if (mainboardOnly) {
    list = list.filter((x) => {
      const c = x.raw;
      if (!(c.startsWith('00') || c.startsWith('60'))) return false;
      if (/ST|退/i.test(x.name)) return false;
      return true;
    });
  }
  return list;
}

async function fetchBatchText(tcodes, timeoutMs = 3500) {
  const url = `https://qt.gtimg.cn/q=${tcodes.join(',')}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: 'https://gu.qq.com/',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return new TextDecoder('gbk').decode(buf);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastErr;
}

async function fetchTencentUniverseSnapshot({
  mainboardOnly = false,
  batchSize = 80,
  concurrency = 14,
} = {}) {
  const entries = loadUniverseEntries({ mainboardOnly });
  if (!entries.length) {
    throw new Error('本地 A 股代码底表 data/ashare_universe.json 为空');
  }

  const sectorMap = new Map(entries.map((e) => [e.tcode, e.sector]));
  const chunks = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    chunks.push(entries.slice(i, i + batchSize).map((e) => e.tcode));
  }

  const rows = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, chunks.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < chunks.length) {
        const idx = cursor++;
        const batch = chunks[idx];
        try {
          const txt = await fetchBatchText(batch, 3500);
          const lines = txt.split(';');
          for (const line of lines) {
            const m = line.match(/v_([a-z]{2}\d{6})="([^"]*)"/);
            if (!m) continue;
            const tcode = m[1];
            const f = m[2].split('~');
            if (f.length < 50) continue;
            const price = parseFloat(f[3]);
            const prevClose = parseFloat(f[4]);
            const chgPct = parseFloat(f[32]);
            if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(chgPct)) continue;

            const raw = String(f[2] || tcode.slice(2)).padStart(6, '0');
            const name = String(f[1] || '').trim();
            const high = parseFloat(f[33]) || price;
            const low = parseFloat(f[34]) || price;
            const amount = (parseFloat(f[37]) || 0) * 10000; // 万元 -> 元
            const turnover = parseFloat(f[38]) || 0;
            const floatCap = parseFloat(f[44]) || 0;
            const totalCap = parseFloat(f[45]) || floatCap || 0; // 亿元
            const volRatio = parseFloat(f[49]) || 0;

            rows.push({
              code: tcode,
              raw,
              name,
              price,
              chgPct,
              amount,
              turnover,
              volRatio,
              totalCap,
              high,
              low,
              prevClose: Number.isFinite(prevClose) ? prevClose : price,
              sector: sectorMap.get(tcode) || '其他板块',
            });
          }
        } catch {
          // 单批偶发超时忽略，不影响全局
        }
      }
    })
  );

  rows.sort((a, b) => b.chgPct - a.chgPct);
  return {
    rows,
    totalMarket: entries.length,
    source: 'tencent_gtimg_realtime',
  };
}

module.exports = {
  loadUniverseEntries,
  fetchTencentUniverseSnapshot,
};
