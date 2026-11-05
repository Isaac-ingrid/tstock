/**
 * auction.js —— 集合竞价存档 + 弱参考校准
 *
 * 运行窗口：交易日 9:25–9:30（竞价撮合完成、连续竞价未开始）
 *   此时腾讯快照里的「成交量/成交额」恰好只包含竞价那一笔，
 *   跑在 9:30 之后拿到的是全天量，数据含义完全不同（脚本会拒绝并提示）。
 *
 * 为什么要有它：竞价量能、竞价额占比这些数据，免费源没有历史留存，
 * 只能每天存一份，攒够样本才能校准阈值。不存档就永远只能用「开盘价幅度」近似。
 *
 * 弱参考的定位（基于 213 条回溯）：
 *   竞价强弱**不改变**「能否摸到 +1%」（五档全在 78%–80%），
 *   只改变「空间多大」与「回落后多惨」。
 *   所以它只微调仓位与目标价，绝不做买卖开关。
 *
 * 用法：node auction.js [--force]
 */
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'ledger');
const force = process.argv.includes('--force');

/* 弱参考分档（来自 213 条回溯的竞价分组，样本见 时段分析_次日冲高.html） */
const TIERS = [
  { k: '高开 +1~+3%', f: (g) => g >= 1 && g < 3, space: 4.09, hit2: 76, upClose: 40, give: 4.23, score: 5, note: '空间最大，可挂 +2%，绝不持有' },
  { k: '平开 0~+1%', f: (g) => g >= 0 && g < 1, space: 3.37, hit2: 53, upClose: 53, give: 2.45, score: 2, note: '最平衡，正常执行' },
  { k: '小幅低开 −1.5~0%', f: (g) => g >= -1.5 && g < 0, space: 2.87, hit2: 54, upClose: 49, give: 2.65, score: 0, note: '空间最小，小仓 +1% 即走' },
  { k: '大幅低开 < −1.5%', f: (g) => g < -1.5, space: 3.21, hit2: 58, upClose: 40, give: 3.74, score: -3, note: '回撤最大，只做 +1% 不贪' },
  { k: '大幅高开 ≥ +3%', f: (g) => g >= 3, space: 3.75, hit2: 60, upClose: 40, give: 5.62, score: 0, note: '样本不足，不单列规则，谨慎' },
];

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
  return new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
}

async function quotes(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 50) {
    const part = codes.slice(i, i + 50);
    const txt = await getText(`https://qt.gtimg.cn/q=${part.join(',')}`);
    for (const line of txt.split(';')) {
      const m = line.match(/v_([a-z]{2}\d+)="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 50) continue;
      out[m[1]] = {
        code: m[1], name: f[1], price: +f[3], prevClose: +f[4], open: +f[5],
        vol: +f[6], amountWan: +f[37], mtime: f[30],
      };
    }
  }
  return out;
}

(async function main() {
  const now = new Date();
  const hhmm = now.getHours() * 100 + now.getMinutes();
  if (!force && (hhmm < 920 || hhmm > 935)) {
    console.error(`\n✗ 当前 ${now.toTimeString().slice(0, 5)}，不在竞价窗口（9:20–9:35）。`);
    console.error('  竞价量只在 9:25–9:30 之间有意义，其余时段的「成交量」是全天量。');
    console.error('  确实要跑请加 --force（结果会标注为「非竞价口径」）。');
    process.exit(1);
  }

  // 最近一份候选清单
  const files = fs.readdirSync(LEDGER).filter((f) => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) { console.error('没有候选清单，请先跑 engine.js'); process.exit(1); }
  const picksFile = files.at(-1);
  const picks = JSON.parse(fs.readFileSync(path.join(LEDGER, picksFile), 'utf8'));
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  // 昨日收盘价与成交额（用于算跳空与竞价比）
  let closeMap = {};
  const closeFile = path.join(LEDGER, `close-${picks.date}.json`);
  if (fs.existsSync(closeFile)) {
    const c = JSON.parse(fs.readFileSync(closeFile, 'utf8'));
    for (const r of c.rows) closeMap[r[0]] = { price: r[2], amount: r[4] };
  }

  const codes = picks.picks.map((p) => p.code);
  console.log(`\n竞价存档 · ${today}  ${now.toTimeString().slice(0, 5)}${force ? '（--force，非竞价口径）' : ''}`);
  console.log(`标的 ${codes.length} 只（来源 ${picksFile}）\n`);

  const q = await quotes(codes);
  const rows = [];
  for (const p of picks.picks) {
    const s = q[p.code];
    if (!s) continue;
    const prevClose = s.prevClose || closeMap[p.code]?.price;
    const aucPrice = s.open || s.price;
    if (!prevClose || !aucPrice) continue;
    const gap = +((aucPrice / prevClose - 1) * 100).toFixed(2);
    const tier = TIERS.find((t) => t.f(gap)) || null;
    const prevAmt = closeMap[p.code]?.amount || null;
    const aucAmt = s.amountWan * 1e4;
    const amtRatio = prevAmt ? +((aucAmt / prevAmt) * 100).toFixed(2) : null;
    rows.push({
      code: p.code, name: p.name, score: p.score, verdict: p.verdict,
      prevClose, aucPrice, gap, aucVol: s.vol, aucAmt, amtRatio,
      tier: tier?.k || null, tierScore: tier?.score ?? 0, note: tier?.note || '',
      space: tier?.space ?? null, hit2: tier?.hit2 ?? null, give: tier?.give ?? null,
      time: s.mtime,
    });
  }

  rows.sort((a, b) => (b.tierScore - a.tierScore) || (b.score - a.score));

  console.log('名称'.padEnd(10) + '得分'.padEnd(6) + '竞价%'.padEnd(9) + '竞价额/昨额'.padEnd(13) + '分档'.padEnd(18) + '弱参考'.padEnd(8) + '空间'.padEnd(8) + '建议');
  for (const r of rows) {
    console.log(
      r.name.slice(0, 5).padEnd(10) + String(r.score).padEnd(6) +
      (r.gap > 0 ? '+' : '') + String(r.gap).padEnd(8) +
      (r.amtRatio === null ? '  —' : String(r.amtRatio) + '%').padEnd(13) +
      String(r.tier || '—').padEnd(18) +
      ((r.tierScore > 0 ? '+' : '') + r.tierScore).padEnd(8) +
      (r.space === null ? '  —' : r.space + '%').padEnd(8) +
      r.note
    );
  }

  // 弱参考校准：只调仓位与目标价
  const adj = rows.map((r) => {
    let pos = r.verdict === '可做' ? 30 : r.verdict === '小做' ? 15 : 0;
    if (r.tierScore >= 5) pos = Math.round(pos * 1.0);        // 高开：空间大，但回撤也大，仓位不放大
    else if (r.tierScore <= -3) pos = Math.round(pos * 0.5);  // 大幅低开：回撤最大，仓位砍半
    const target = r.tierScore >= 5 ? 2 : 1;                  // 高开挂 +2%，其余 +1%
    return { ...r, pos, target };
  });

  const ok = adj.filter((r) => r.pos > 0);
  console.log(`\n可执行 ${ok.length} 只（弱参考只调仓位与目标价，不改变是否执行）`);
  for (const r of ok) {
    console.log(`  ${r.name}  仓位 ${r.pos}%  挂 +${r.target}%  止损 −1.5%（按竞价价 ${r.aucPrice} 计：${(r.aucPrice * (1 + r.target / 100)).toFixed(2)} / ${(r.aucPrice * 0.985).toFixed(2)}）`);
  }

  // 存档
  const out = {
    date: today, baseDate: picks.date, capturedAt: now.toISOString(),
    mode: force ? 'force（非竞价口径）' : 'auction（9:25–9:30）',
    note: '竞价量/额仅在 9:25–9:30 有意义；弱参考只用于调仓位与目标价，不做买卖开关。',
    rows: adj,
  };
  fs.writeFileSync(path.join(LEDGER, `auction-${today}.json`), JSON.stringify(out, null, 1));
  console.log(`\n→ ledger/auction-${today}.json`);
  console.log('（这份存档是未来校准阈值唯一的依据，攒够 20 个交易日再看竞价量能指标）');
})();
