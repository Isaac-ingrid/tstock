/**
 * 打分卡（engine.js 与 rescore.js 共用，避免两套标准漂移）
 * 六项加权，满分 100。
 */
const CFG = {
  vwapBreachAfter10Max: 5,
};

function scoreStock(s) {
  const p = {};

  /* ① 涨幅 20：3–5% 满分，边缘递减 */
  const c = s.chgPct;
  p.chg = c >= 3 && c <= 5 ? 20 : c >= 2.5 && c < 3 ? 12 : c > 5 && c <= 6 ? 10 : 0;

  /* ② 30 日内涨停史 20：跌破涨停日低点直接 0 分并一票否决；未破且回落≤50% 给满 */
  if (s.kl?.ok && !s.kl.brokeLow) {
    p.limitUp = s.kl.pullback <= 50 ? 20 : 12;
  } else p.limitUp = 0;

  /* ③ 量能 20（含量价联动修正） */
  const vr = s.volRatio;
  p.vol = vr >= 2 ? 20 : vr >= 1.5 ? 16 : vr >= 1 ? 12 : 0;
  if (s.vw && s.vw.onlineRatio < 50 && vr >= 3) p.vol = Math.round(p.vol / 2); // 高量比+价在均价下方=出货
  if (!s.vw && p.vol >= 16) p.vol = 12;                                        // 无分时无法验证量价配合

  /* ④ 换手 15 */
  const tr = s.turnover;
  p.turn = tr >= 5 && tr <= 10 ? 15 : tr >= 3 && tr <= 12 ? 10 : tr > 20 ? 0 : 4;

  /* ⑤ 总市值 10（亿）：兼顾弹性中小盘与高成交容量中军（如亨通模式） */
  const cap = s.totalCap;
  const isCoreLeader = s.leaderRole === 'core' || (cap > 200 && cap <= 800 && (s.amount || 0) >= 8e8);
  p.cap = (cap >= 50 && cap <= 150) || isCoreLeader ? 10 : cap >= 30 && cap <= 200 ? 7 : cap > 200 && cap <= 800 ? 6 : 0;

  /* ⑥ VWAP 15 */
  if (s.vw) {
    const r = s.vw.onlineRatio;
    const okAfter10 = s.vw.belowAfter10 <= CFG.vwapBreachAfter10Max;
    p.vwap = r >= 95 && okAfter10 ? 15 : r >= 85 && okAfter10 ? 11 : r >= 85 ? 7 : r >= 60 ? 4 : 0;
  } else p.vwap = 0;

  /* ⑦ 板块持续性修正（第二步：选有持续性的板块，防孤狼一日游） */
  const st = s.sectorTier || '';
  if (st === 'HOT') p.sector = 6;
  else if (st === 'ACTIVE') p.sector = 3;
  else if (st === 'COLD' && (s.kl?.limitUpCount30d || 0) < 2) p.sector = -8;
  else p.sector = 0;

  /* ⑧ 龙头身位修正（第三步：只买前排龙头与容量中军，严禁看A做B买后排补涨） */
  const role = s.leaderRole || '';
  if (s.isBackRowLaggard || role === 'backrow') p.role = -30;
  else if (role === 'dragon') p.role = 6;
  else if (role === 'core') p.role = 5;
  else if (role === 'front') p.role = 2;
  else p.role = 0;

  const rawTotal = Object.values(p).reduce((a, b) => a + b, 0);
  const total = Math.max(0, Math.min(100, rawTotal));
  const hardVeto = Boolean(
    s.kl?.brokeLow ||
    s.kl?.isBear ||
    s.kl?.klineRisk?.risky ||
    s.isBackRowLaggard ||
    role === 'backrow'
  );
  const verdict = hardVeto
    ? '放弃'
    : (total >= 80 ? '可做' : total >= 70 ? '小做' : total >= 60 ? '观察' : '放弃');
  return { parts: p, total, verdict };
}

module.exports = { scoreStock, CFG };
