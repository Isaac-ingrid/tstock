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

  /* ② 30 日内涨停史 20：涨停后未破涨停日低点且回落≤50% 给满 */
  if (s.kl?.ok) {
    p.limitUp = s.kl.brokeLow ? 6 : s.kl.pullback <= 50 ? 20 : 12;
  } else p.limitUp = 0;

  /* ③ 量能 20（含量价联动修正） */
  const vr = s.volRatio;
  p.vol = vr >= 2 ? 20 : vr >= 1.5 ? 16 : vr >= 1 ? 12 : 0;
  if (s.vw && s.vw.onlineRatio < 50 && vr >= 3) p.vol = Math.round(p.vol / 2); // 高量比+价在均价下方=出货
  if (!s.vw && p.vol >= 16) p.vol = 12;                                        // 无分时无法验证量价配合

  /* ④ 换手 15 */
  const tr = s.turnover;
  p.turn = tr >= 5 && tr <= 10 ? 15 : tr >= 3 && tr <= 12 ? 10 : tr > 20 ? 0 : 4;

  /* ⑤ 总市值 10（亿） */
  const cap = s.totalCap;
  p.cap = cap >= 50 && cap <= 150 ? 10 : cap >= 30 && cap <= 200 ? 7 : 0;

  /* ⑥ VWAP 15 */
  if (s.vw) {
    const r = s.vw.onlineRatio;
    const okAfter10 = s.vw.belowAfter10 <= CFG.vwapBreachAfter10Max;
    p.vwap = r >= 95 && okAfter10 ? 15 : r >= 85 && okAfter10 ? 11 : r >= 85 ? 7 : r >= 60 ? 4 : 0;
  } else p.vwap = 0;

  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const verdict = total >= 80 ? '可做' : total >= 70 ? '小做' : total >= 60 ? '观察' : '放弃';
  return { parts: p, total, verdict };
}

module.exports = { scoreStock, CFG };
