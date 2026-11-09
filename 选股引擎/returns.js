/**
 * returns.js —— 台账收益回算（每个交易日收盘后跑，或随时补跑）
 *
 * 读 ledger/picks-*.json → 拉日K → 算 T+1..T+N 双口径收益 → 写 ledger/returns.csv
 *
 * 双口径：
 *   sig_close = 选股日收盘买入（理想，衡量信号质量）
 *   sig_open  = 次日开盘买入（可实现，衡量真金白银）
 * 两者之差 = 隔夜跳空成本
 *
 * 用法：node returns.js [--hold 1,2,3,5,10,20] [--since 2026-10-01]
 */
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'ledger');
const FEE = 0.0011;
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const HOLD = String(arg('--hold', '1,2,3,5,10,20')).split(',').map(Number);
const SINCE = arg('--since', '');

async function getJson(url, retry = 3) {
  let err;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
      return JSON.parse(new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer())));
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw err;
}

// 主源：腾讯日K（qfq，字段最规范；但会被 WAF 间歇拦截，返回 501 非 JSON）
async function klineTx(code) {
  try {
    const j = await getJson(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,160,qfq`, 1);
    const d = j?.data?.[code];
    const arr = d?.qfqday || d?.day;
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((r) => ({ date: r[0], open: +r[1], close: +r[2] }));
  } catch { return null; }
}

// 备源：东财 push2his（qfq）。腾讯 501 时兜底，否则整份 CSV 会被写成只剩当日
function emSecid(code) {
  const m = /^(sh|sz)(\d{6})$/.exec(code);
  if (!m) return null;
  return (m[1] === 'sh' ? '1.' : '0.') + m[2];
}
async function klineEm(code) {
  const sid = emSecid(code);
  if (!sid) return null;
  try {
    const j = await getJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${sid}` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=1&end=20500101&lmt=160`, 2);
    const arr = j?.data?.klines;
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((s) => {
      const p = s.split(',');
      return { date: p[0], open: +p[1], close: +p[2] };
    });
  } catch { return null; }
}

let txDown = 0;          // 连续腾讯失败计数，超过阈值直接跳过主源，省掉整轮 501 空转
async function kline(code) {
  if (txDown < 5) {
    const a = await klineTx(code);
    if (a) { txDown = 0; return a; }
    txDown++;
  }
  return klineEm(code);
}

(async function main() {
  if (!fs.existsSync(LEDGER)) { console.error('还没有台账，请先跑 engine.js'); process.exit(1); }
  const files = fs.readdirSync(LEDGER)
    .filter((f) => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const use = SINCE ? files.filter((f) => f.slice(6, 16) >= SINCE) : files;
  if (!use.length) { console.error('没有可回算的清单'); process.exit(1); }

  console.log(`台账 ${use.length} 个交易日，持有期 ${HOLD.join('/')}\n`);

  const rows = [];
  for (const f of use) {
    const p = JSON.parse(fs.readFileSync(path.join(LEDGER, f), 'utf8'));
    const date = p.date;
    let doneH = 0;

    for (const s of p.picks) {
      const bars = await kline(s.code);
      if (!bars) { console.log(`  ! ${s.code} ${s.name} 日K获取失败`); continue; }
      const i = bars.findIndex((b) => b.date === date);
      if (i < 0) { console.log(`  ! ${s.code} ${s.name} 在日K中找不到 ${date}`); continue; }
      for (const h of HOLD) {
        const j = i + h;
        if (j >= bars.length) continue;             // 未来还没到
        const rA = (bars[j].close / bars[i].close - 1 - FEE) * 100;
        const rB = (bars[j].close / bars[i + 1].open - 1 - FEE) * 100;
        rows.push({
          date, code: s.code, name: s.name, score: s.score, verdict: s.verdict,
          hold: h, rA: +rA.toFixed(2), rB: +rB.toFixed(2), gap: +(rA - rB).toFixed(2),
        });
        doneH++;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log(`  ${date}  ${p.picks.length} 只 → ${doneH} 条持有期记录`);
  }

  if (!rows.length) {
    console.log('\n尚无可计算的持有期：今天选出的票，T+1 收盘后才有第一条记录。');
    console.log('（这正是要建立每日落盘的原因——不落盘，以后无法回补。）');
    return;
  }

  const header = 'date,code,name,score,verdict,hold,rA_close,rB_open,gap';
  const csv = [header, ...rows.map((r) => [r.date, r.code, r.name, r.score, r.verdict, r.hold, r.rA, r.rB, r.gap].join(','))].join('\n');
  fs.writeFileSync(path.join(LEDGER, 'returns.csv'), csv);

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log('\n持有期\t样本\t收盘口径%\t次日开盘%\t隔夜跳空%\t胜率%');
  for (const h of HOLD) {
    const g = rows.filter((r) => r.hold === h);
    if (!g.length) continue;
    console.log(`T+${h}\t${g.length}\t${mean(g.map((r) => r.rA)).toFixed(2)}\t${mean(g.map((r) => r.rB)).toFixed(2)}\t${mean(g.map((r) => r.gap)).toFixed(2)}\t${(g.filter((r) => r.rB > 0).length / g.length * 100).toFixed(0)}`);
  }
  console.log(`\n→ ${path.join(LEDGER, 'returns.csv')}（${rows.length} 行）`);
})();
