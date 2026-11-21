/* ============================================================
   A股做T执行台 · 执行台账、人机对决审计与四维纪律评分引擎 (ledger.js)
   ============================================================ */

import { f2, f3, pct, money, money2, todayStr, toast, toastOk, toastWarn, toastErr, copyPlain, soundChime, FEE, LCOLS, LS_KEYS } from './utils.js';
import { pool, savePool, LOG, saveLog } from './state.js';
import { calc, MKT } from './api.js';
import { evaluateChannelHoldingDiscipline } from './risk.js';

export function logNet(r){
  const b=+r.buy||0, s=+r.sell||0, q=+r.qty||0;
  if(!b||!s||!q) return null;
  return (s-b)*q - (s+b)*q*FEE;
}

export function logRatio(r){
  const b=+r.buy||0, s=+r.sell||0;
  if(!b||!s) return null;
  return (s-b)/b*100 - FEE*100;
}

/* ===================== 全链路人机对决基准匹配与计划偏离度审计 ===================== */

/**
 * 为任意成交标的匹配最权威的「系统 SOP 推荐点位基准」
 * 优先级：尾盘策略契约 (tail) > 短线/稳健契约 (short/steady) > 自选池实时 calc(stock) 量化网格点位
 */
export function resolveSystemBenchmark({
  stock = null,
  stockText = '',
  code = '',
  dir = '正T',
  qty = 0,
  wbLatest = null,
  poolList = [],
}) {
  const cleanCode = String(code || stock?.code || stockText.match(/\d{6}/)?.[0] || '')
    .replace(/\D/g, '')
    .padStart(6, '0');
  const cleanName = String(stock?.name || stockText || '').trim();
  const qNum = Math.max(0, +qty || 0);

  let sysBuy = 0;
  let sysSell1 = 0;
  let sysSell2 = 0;
  let sysStop = 0;
  let source = '';
  let verdict = '';
  let calcSnap = null;

  const hitPool =
    stock ||
    (Array.isArray(poolList) ? poolList : pool || []).find(
      (p) =>
        p &&
        ((cleanCode && cleanCode !== '000000' && String(p.code).padStart(6, '0') === cleanCode) ||
          (cleanName && p.name && cleanName.includes(p.name)))
    );

  if (hitPool && (+hitPool.prevClose > 0 || +hitPool.price > 0)) {
    try {
      calcSnap = calc(hitPool);
    } catch (_) {
      calcSnap = null;
    }
  }

  // 1. 尾盘隔夜操作优先对齐尾盘契约或持仓预设止盈/止损
  if (dir === '尾盘买入' || dir === '尾盘平仓') {
    const tails = wbLatest?.tail || [];
    const hitTail = tails.find(
      (x) =>
        (cleanCode && String(x.code).padStart(6, '0') === cleanCode) ||
        (cleanName && x.name && cleanName.includes(x.name))
    );
    const refBase = +(stock?.cost || stock?.price || hitTail?.price || hitTail?.buyPx || 0);
    sysBuy = +(hitTail?.buyPx || hitTail?.price || refBase || 0).toFixed(2);
    sysSell1 = +(stock?.tp1 || hitTail?.tp1 || (sysBuy > 0 ? sysBuy * 1.028 : 0)).toFixed(2);
    sysSell2 = +(stock?.tp2 || hitTail?.tp2 || (sysBuy > 0 ? sysBuy * 1.05 : 0)).toFixed(2);
    sysStop = +(stock?.stop || hitTail?.stop || (sysBuy > 0 ? sysBuy * 0.98 : 0)).toFixed(2);
    source = hitTail ? '尾盘策略契约' : '尾盘隔夜预案';
    verdict = hitTail?.verdict || '次日早盘冲高兑现';
  }

  // 2. 尝试选股引擎契约（仅在尚未命中尾盘且非纯倒T时优先参考，倒T优先采用实时 calc 网格）
  if (!sysBuy && wbLatest && dir !== '倒T') {
    const shorts = [
      ...(wbLatest.short?.left || []),
      ...(wbLatest.short?.right || []),
      ...(Array.isArray(wbLatest.short) ? wbLatest.short : []),
    ];
    const hitShort = shorts.find(
      (x) =>
        (cleanCode && String(x.code).padStart(6, '0') === cleanCode) ||
        (cleanName && x.name && cleanName.includes(x.name))
    );
    if (hitShort && (+hitShort.inA > 0 || +hitShort.price > 0)) {
      sysBuy = +(hitShort.inA || hitShort.price || 0).toFixed(2);
      sysSell1 = +(hitShort.tp1 || sysBuy * 1.035).toFixed(2);
      sysSell2 = +(hitShort.tp2 || sysBuy * 1.06).toFixed(2);
      sysStop = +(hitShort.slA || sysBuy * 0.98).toFixed(2);
      source = '短线双列引擎';
      verdict = hitShort.mode || '短线博弈';
    } else {
      const steadies = wbLatest.steady || [];
      const hitSteady = steadies.find(
        (x) =>
          (cleanCode && String(x.code).padStart(6, '0') === cleanCode) ||
          (cleanName && x.name && cleanName.includes(x.name))
      );
      if (hitSteady && (+hitSteady.inA > 0 || +hitSteady.price > 0)) {
        sysBuy = +(hitSteady.inA || hitSteady.price || 0).toFixed(2);
        sysSell1 = +(hitSteady.tp1 || sysBuy * 1.025).toFixed(2);
        sysSell2 = +(hitSteady.tp2 || sysBuy * 1.045).toFixed(2);
        sysStop = +(hitSteady.slA || sysBuy * 0.985).toFixed(2);
        source = '稳健底仓引擎';
        verdict = '回踩分批低吸';
      }
    }
  }

  // 3. 自选池实时 calc(hitPool) 七格与 ATR 动态步长点位（修复历史 bePrice/targetPrice 未定义断层）
  if (!sysBuy && calcSnap) {
    if (dir === '倒T') {
      sysBuy = +calcSnap.bkA.toFixed(2);
      sysSell1 = +calcSnap.outA.toFixed(2);
      sysSell2 = +calcSnap.outB.toFixed(2);
      sysStop = +calcSnap.fly.toFixed(2); // 倒T防卖飞红线
      source = '实时倒T网格';
      verdict = calcSnap.mode === 'REV' || calcSnap.mode === 'CUT' ? '顺势倒T高抛' : '逆信号倒T';
    } else if (dir === '直接卖出' || dir === '清仓卖出') {
      const baseCost = +hitPool.cost > 0 ? +hitPool.cost : +calcSnap.inA;
      sysBuy = +baseCost.toFixed(2);
      sysSell1 = +calcSnap.outA.toFixed(2);
      sysSell2 = +calcSnap.outB.toFixed(2);
      sysStop = +calcSnap.slA.toFixed(2);
      source = '持仓风控网格';
      verdict = String(calcSnap.title || '持仓兑现').replace(/<[^>]+>/g, '');
    } else {
      sysBuy = +calcSnap.inA.toFixed(2);
      sysSell1 = +calcSnap.tp1.toFixed(2);
      sysSell2 = +calcSnap.tp2.toFixed(2);
      sysStop = +calcSnap.slA.toFixed(2);
      source = '实时做T网格';
      verdict = String(calcSnap.title || '低吸正T').replace(/<[^>]+>/g, '');
    }
  } else if (!sysBuy && hitPool && (+hitPool.cost > 0 || +hitPool.price > 0)) {
    const base = +hitPool.cost > 0 ? +hitPool.cost : +hitPool.price;
    sysBuy = +(base * 0.987).toFixed(2);
    sysSell1 = +(base * 1.025).toFixed(2);
    sysSell2 = +(base * 1.045).toFixed(2);
    sysStop = +(base * 0.985).toFixed(2);
    source = '底仓成本锚点';
    verdict = '底仓波段';
  }

  if (!(sysBuy > 0) || !(sysSell1 > 0)) return { benchmark: null, calcSnap, hitPool };

  const sysFee = qNum > 0 ? (sysBuy * qNum + sysSell1 * qNum) * 0.00055 : 0;
  const sysNet = qNum > 0 ? Math.round(((sysSell1 - sysBuy) * qNum - sysFee) * 100) / 100 : null;

  return {
    benchmark: {
      source,
      verdict,
      sysBuy,
      sysSell1,
      sysSell2,
      sysStop,
      sysNet,
    },
    calcSnap,
    hitPool,
  };
}

/**
 * 在每一笔交易产生时（快捷记T / 建仓加仓 / 尾盘建仓平仓 / 台账手填）执行自动纪律审计：
 * 自动补齐双轨归属 (track)、系统理论基准 (systemBenchmark)、买卖偏离度% (buyDevPct/sellDevPct)、
 * 人机超额 Alpha (alphaNet)、客观违规标签 (mistakeTags) 与单笔纪律评分 (disciplineScore 0~100)
 */
export function auditTradeExecution({
  stock = null,
  stockText = '',
  code = '',
  dir = '正T',
  track = '',
  buy = 0,
  sell = 0,
  qty = 0,
  net = 0,
  plan = '',
  basis = '',
  mistakeTags = [],
  prevLogs = [],
  wbLatest = null,
  poolList = [],
  totalAssets = 100000,
  date = todayStr(),
}) {
  const buyPx = Math.max(0, +buy || 0);
  const sellPx = Math.max(0, +sell || 0);
  const qNum = Math.max(0, parseInt(qty, 10) || 0);
  const netVal = Number.isFinite(+net) ? Math.round(+net * 100) / 100 : 0;

  const resolvedTrack =
    track ||
    (dir === '尾盘买入' || dir === '尾盘平仓' || stock?.tier === 'short' || stock?.poolTag === '短线'
      ? 'short_swing'
      : 'long_t');

  const { benchmark, calcSnap, hitPool } = resolveSystemBenchmark({
    stock,
    stockText,
    code,
    dir,
    qty: qNum,
    wbLatest,
    poolList,
  });

  const isClosed = buyPx > 0 && sellPx > 0 && dir !== '买入建仓' && dir !== '买入加仓' && dir !== '尾盘买入';
  const buyDevPct =
    buyPx > 0 && benchmark?.sysBuy > 0
      ? Math.round(((buyPx - benchmark.sysBuy) / benchmark.sysBuy) * 10000) / 100
      : null;
  const sellDevPct =
    sellPx > 0 && benchmark?.sysSell1 > 0
      ? Math.round(((sellPx - benchmark.sysSell1) / benchmark.sysSell1) * 10000) / 100
      : null;

  const alphaNet =
    isClosed && benchmark?.sysNet != null
      ? Math.round((netVal - benchmark.sysNet) * 100) / 100
      : null;

  // 合并人工勾选标签与客观盘口自动识别违规标签
  const tagSet = new Set(Array.isArray(mistakeTags) ? mistakeTags.filter(Boolean) : []);
  const isOpeningBuy =
    dir === '正T' || dir === '买入建仓' || dir === '买入加仓' || dir === '直接买入' || dir === '尾盘买入';
  const mktLevel = MKT?.gate?.level || calcSnap?.mktLevel || 'NA';

  // 1) 🔥 追高天花板：买入价越过倒T高抛位 outA，或高于系统买点 +1.5% 以上
  if (buyPx > 0 && dir !== '倒T' && dir !== '直接卖出' && dir !== '清仓卖出' && dir !== '尾盘平仓') {
    if (
      (calcSnap?.outA > 0 && buyPx >= calcSnap.outA * 1.002) ||
      (buyDevPct !== null && buyDevPct >= 1.5)
    ) {
      tagSet.add('fomo_chase');
    }
  }

  // 2) 💣 破位死扛不认输：亏损出局且卖出价显著击穿系统止损线 slA (-0.8% 以下) 或单笔实亏超过 -2.2%
  if (isClosed && netVal < 0 && buyPx > 0) {
    const retPct = ((sellPx - buyPx) / buyPx) * 100;
    if (
      (benchmark?.sysStop > 0 && dir !== '倒T' && sellPx < benchmark.sysStop * 0.992) ||
      retPct <= -2.2
    ) {
      tagSet.add('no_stoploss');
    }
  }

  // 3) 🌪️ 逆市顶风作案：大盘 BAD 破位或个股触发破位防套锁时强行开多/正T
  if (isOpeningBuy && (mktLevel === 'BAD' || calcSnap?.brokenLock)) {
    tagSet.add('against_trend');
  }

  // 4) ⚡ 无量冲动乱T：日内做T但当日振幅折合不足 2.6 格（空间不够规费磨损）
  if ((dir === '正T' || dir === '倒T') && calcSnap && calcSnap.amp > 0 && calcSnap.grid < 2.6) {
    tagSet.add('impulse_t');
  }

  // 5) 😡 报复性交易：当日此前已连亏 >= 2 笔时仍继续逆向新开买单
  if (isOpeningBuy && Array.isArray(prevLogs) && prevLogs.length >= 2) {
    const sameDayClosed = prevLogs.filter(
      (r) => r && r.date === date && +r.buy > 0 && +r.sell > 0 && Number.isFinite(+r.net) && +r.net !== 0
    );
    if (sameDayClosed.length >= 2 && +sameDayClosed[0].net < 0 && +sameDayClosed[1].net < 0) {
      tagSet.add('revenge_trade');
    }
  }

  // 6) 🎲 短线重仓单赌：短线轨单笔成交额超过总资产 35%
  const notional = (buyPx || sellPx) * qNum;
  if (resolvedTrack === 'short_swing' && totalAssets > 0 && notional > totalAssets * 0.35) {
    tagSet.add('heavy_gamble');
  }

  // 7) 🏃 过早卖飞大肉：盈利平仓但卖价低于第一止盈位 -1.3% 以上，且当日最高价已触及第一止盈位
  if (
    isClosed &&
    netVal > 0 &&
    sellDevPct !== null &&
    sellDevPct <= -1.3 &&
    stock &&
    +stock.high >= (benchmark?.sysSell1 || Infinity)
  ) {
    tagSet.add('early_exit');
  }

  // 8) 🩸 下跌通道浮亏死补 & 🥀 弱势连红3天贪婪追买（三步实战铁律审计）
  const discSnap = hitPool ? evaluateChannelHoldingDiscipline(hitPool, { mktLevel }) : null;
  const holdingFloatPct =
    hitPool && +hitPool.shares > 0 && +hitPool.cost > 0 && buyPx > 0
      ? +(((buyPx - +hitPool.cost) / +hitPool.cost) * 100).toFixed(2)
      : (discSnap?.floatPct ?? 0);
  const redStreak = discSnap?.redStreak ?? 0;

  if (mktLevel !== 'OK' && mktLevel !== 'NA') {
    if (
      (dir === '买入加仓' || (dir === '直接买入' && hitPool && +hitPool.shares > 0)) &&
      +hitPool?.cost > 0 &&
      buyPx < +hitPool.cost * 0.99
    ) {
      tagSet.add('averaging_down');
    }
    if (isOpeningBuy && redStreak >= 3) {
      tagSet.add('hold_past_3red');
    }
  }

  const finalTags = Array.from(tagSet);

  // 自动校准计划内/外：若出现追高、逆市、浮亏死补、三连阳追买、报复性交易或窄幅乱T且用户未强行指定，归为计划外
  const severeAutoTags = [
    'fomo_chase',
    'against_trend',
    'revenge_trade',
    'impulse_t',
    'averaging_down',
    'hold_past_3red',
    'backrow_laggard',
  ];
  const resolvedPlan =
    plan === '计划外' || (!plan && finalTags.some((t) => severeAutoTags.includes(t)))
      ? '计划外'
      : finalTags.some((t) => severeAutoTags.includes(t)) && plan === '自动判定'
      ? '计划外'
      : plan || '计划内';

  // 计算单笔纪律得分 (0~100)
  let score = 100;
  if (resolvedPlan === '计划外') score -= 12;
  if (tagSet.has('fomo_chase') || tagSet.has('late_chase')) score -= 18;
  if (tagSet.has('averaging_down')) score -= 24;
  if (tagSet.has('hold_past_3red')) score -= 18;
  if (tagSet.has('t1_illusion_hold')) score -= 18;
  if (tagSet.has('backrow_laggard')) score -= 16;
  if (tagSet.has('no_stoploss') || tagSet.has('t_to_add')) score -= 22;
  if (tagSet.has('against_trend')) score -= 18;
  if (tagSet.has('revenge_trade')) score -= 22;
  if (tagSet.has('impulse_t')) score -= 14;
  if (tagSet.has('heavy_gamble')) score -= 15;
  if (tagSet.has('early_exit')) score -= (mktLevel === 'OK' ? 12 : 5);
  if (buyDevPct !== null && dir !== '倒T' && buyDevPct > 0.8 && !tagSet.has('fomo_chase')) {
    score -= Math.min(12, Math.round((buyDevPct - 0.5) * 6));
  }
  score = Math.max(20, Math.min(100, Math.round(score)));

  return {
    track: resolvedTrack,
    systemBenchmark: benchmark,
    alphaNet,
    buyDevPct,
    sellDevPct,
    holdingFloatPct,
    redStreak,
    mistakeTags: finalTags,
    plan: resolvedPlan,
    basis: basis || (resolvedPlan === '计划外' ? '盘中主观脉冲' : '量化网格信号'),
    disciplineScore: score,
  };
}

/**
 * 聚合全量或筛选流水的「四维操盘纪律与计划偏离度评分卡」(满分 100 分)
 * 对历史未携带 systemBenchmark 的旧流水自动做无损实时回溯补齐
 */
export function computeDisciplineScorecard(logs = [], poolList = [], wbLatest = null) {
  const enrichedLogs = (Array.isArray(logs) ? logs : []).map((r) => {
    if (!r) return r;
    if (r.systemBenchmark && r.disciplineScore !== undefined) return r;
    const patch = auditTradeExecution({
      stockText: r.stock || '',
      code: r.code || '',
      dir: r.dir || '正T',
      track: r.track || '',
      buy: +r.buy || 0,
      sell: +r.sell || 0,
      qty: +r.qty || 0,
      net: +r.net || 0,
      plan: r.plan || '计划内',
      basis: r.basis || '',
      mistakeTags: r.mistakeTags || [],
      wbLatest,
      poolList,
      date: r.date || todayStr(),
    });
    return {
      ...r,
      track: r.track || patch.track,
      systemBenchmark: r.systemBenchmark || patch.systemBenchmark,
      alphaNet: r.alphaNet !== undefined ? r.alphaNet : patch.alphaNet,
      buyDevPct: r.buyDevPct !== undefined ? r.buyDevPct : patch.buyDevPct,
      sellDevPct: r.sellDevPct !== undefined ? r.sellDevPct : patch.sellDevPct,
      mistakeTags: (r.mistakeTags && r.mistakeTags.length > 0) ? r.mistakeTags : patch.mistakeTags,
      disciplineScore: r.disciplineScore !== undefined ? r.disciplineScore : patch.disciplineScore,
    };
  });

  if (!enrichedLogs.length) {
    return {
      enrichedLogs: [],
      totalScore: 100,
      grade: 'S · 满血待战',
      buyScore: 25,
      sellScore: 25,
      stopScore: 25,
      envScore: 25,
      avgBuyDevPct: null,
      avgSellDevPct: null,
      planExecRate: 100,
      duelCount: 0,
      actualDuelNet: 0,
      sysDuelNet: 0,
      totalAlpha: 0,
      frictionLoss: 0,
    };
  }

  const n = enrichedLogs.length;
  let buyPenalty = 0;
  let sellPenalty = 0;
  let stopPenalty = 0;
  let envPenalty = 0;

  const buyDevs = [];
  const sellDevs = [];
  let plannedCount = 0;
  let duelCount = 0;
  let actualDuelNet = 0;
  let sysDuelNet = 0;
  let frictionLoss = 0;

  enrichedLogs.forEach((r) => {
    const tags = new Set(r.mistakeTags || []);
    if (r.plan !== '计划外') plannedCount += 1;
    else envPenalty += 4;

    if (tags.has('fomo_chase') || tags.has('late_chase')) buyPenalty += 7;
    if (tags.has('impulse_t')) buyPenalty += 5;
    if (tags.has('early_exit')) sellPenalty += 5;
    if (tags.has('no_stoploss')) stopPenalty += 9;
    if (tags.has('t_to_add')) stopPenalty += 7;
    if (tags.has('against_trend')) envPenalty += 7;
    if (tags.has('revenge_trade')) envPenalty += 8;
    if (tags.has('heavy_gamble') || tags.has('lone_wolf')) envPenalty += 5;

    if (r.buyDevPct !== null && r.buyDevPct !== undefined && r.dir !== '倒T') {
      buyDevs.push(+r.buyDevPct);
      if (+r.buyDevPct > 1.0 && !tags.has('fomo_chase')) {
        buyPenalty += Math.min(4, (+r.buyDevPct - 0.8) * 2);
      }
    }
    if (r.sellDevPct !== null && r.sellDevPct !== undefined) {
      sellDevs.push(+r.sellDevPct);
    }

    const isClosed = +r.buy > 0 && +r.sell > 0 && r.dir !== '买入建仓' && r.dir !== '买入加仓' && r.dir !== '尾盘买入';
    if (isClosed && r.systemBenchmark && r.systemBenchmark.sysNet !== null && r.systemBenchmark.sysNet !== undefined) {
      duelCount += 1;
      const actN = +r.net || 0;
      const sysN = +r.systemBenchmark.sysNet || 0;
      actualDuelNet += actN;
      sysDuelNet += sysN;
      if (actN < sysN) {
        frictionLoss += sysN - actN;
      }
    }
  });

  // 归一化单笔平均扣分（避免交易笔数多时自然累加扣光，反映长期稳定纪律水平）
  const scale = Math.max(1, n / 3);
  const buyScore = Math.max(0, Math.min(25, Math.round(25 - buyPenalty / scale)));
  const sellScore = Math.max(0, Math.min(25, Math.round(25 - sellPenalty / scale)));
  const stopScore = Math.max(0, Math.min(25, Math.round(25 - stopPenalty / scale)));
  const envScore = Math.max(0, Math.min(25, Math.round(25 - envPenalty / scale)));
  const totalScore = buyScore + sellScore + stopScore + envScore;

  let grade = 'A · 稳健合规';
  if (totalScore >= 90) grade = 'S · 铁血量化纪律';
  else if (totalScore >= 78) grade = 'A · 稳健知行合一';
  else if (totalScore >= 65) grade = 'B · 局部情绪磨损';
  else grade = 'C · 偏离预警需纠偏';

  const avgBuyDevPct = buyDevs.length
    ? Math.round((buyDevs.reduce((a, b) => a + b, 0) / buyDevs.length) * 100) / 100
    : null;
  const avgSellDevPct = sellDevs.length
    ? Math.round((sellDevs.reduce((a, b) => a + b, 0) / sellDevs.length) * 100) / 100
    : null;

  return {
    enrichedLogs,
    totalScore,
    grade,
    buyScore,
    sellScore,
    stopScore,
    envScore,
    avgBuyDevPct,
    avgSellDevPct,
    planExecRate: Math.round((plannedCount / n) * 100),
    duelCount,
    actualDuelNet: Math.round(actualDuelNet * 100) / 100,
    sysDuelNet: Math.round(sysDuelNet * 100) / 100,
    totalAlpha: Math.round((actualDuelNet - sysDuelNet) * 100) / 100,
    frictionLoss: Math.round(frictionLoss * 100) / 100,
  };
}

/* ===================== 执行台账渲染（旧版 DOM 兼容保留） ===================== */
export function renderLog(){
  const t = document.getElementById('logTable');
  if (!t) return;

  const body = (LOG || []).map((r,i)=>{
    const net = logNet(r);
    const ret = logRatio(r);
    const cells = LCOLS.map(([k,lb,ty,opts])=> `<td>${ ty==='select'
        ? `<select data-li="${i}" data-lk="${k}">
             ${(r[k] ? '' : '<option value="" selected>待标注</option>')
               + opts.map(o=>`<option value="${o}"${r[k]===o?' selected':''}>${o}</option>`).join('')}
           </select>`
        : `<input data-li="${i}" data-lk="${k}" value="${r[k] ?? ''}"${ty==='num'?' inputmode="decimal"':''}>` }</td>` ).join('');
    const netCell = net===null ? '<span style="color:var(--mute)">待填</span>'
      : `<b style="color:${net>=0?'var(--up)':'var(--down)'}">${money(net)}</b>`;
    const retCell = ret===null ? '<span style="color:var(--mute)">—</span>'
      : `<b style="color:${ret>=0?'var(--up)':'var(--down)'}">${(ret>=0?'+':'')+ret.toFixed(2)}%</b>`;
    return `<tr>${cells}<td class="num">${netCell}</td><td class="num">${retCell}</td>`
         + `<td style="text-align:center"><button class="del" data-ldel="${i}">删</button></td></tr>`;
  }).join('');

  t.innerHTML = `<thead><tr>${LCOLS.map(f=>`<th>${f[1]}</th>`).join('')}
      <th style="text-align:right">净盈亏(元)</th><th style="text-align:right">收益率</th><th></th></tr></thead>
    <tbody>${body || `<tr><td colspan="${LCOLS.length+3}" style="text-align:center;color:var(--mute);padding:20px">还没有记录。做了一笔就点上面「记一笔」。</td></tr>`}</tbody>`;

  bindLogEvents();
  renderCogReport();
}

function bindLogEvents(){
  const t = document.getElementById('logTable');
  if (!t) return;

  t.querySelectorAll('input[data-li], select[data-li]').forEach(el => {
    el.onchange = () => {
      const idx = +el.dataset.li;
      const key = el.dataset.lk;
      if (LOG[idx]) {
        LOG[idx][key] = el.value;
        saveLog();
        renderLog();
        if (window.render) window.render(pool);
      }
    };
  });

  t.querySelectorAll('button[data-ldel]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.ldel;
      if (confirm('确定删除这条交易记录吗？')) {
        LOG.splice(idx, 1);
        saveLog();
        renderLog();
        if (window.render) window.render(pool);
        toastOk('已删除该笔台账');
      }
    };
  });
}

export function logAdd(){
  const today = todayStr();
  LOG.unshift({
    date: today,
    stock: pool.length ? pool[0].name : '',
    dir: '正T',
    buy: '',
    sell: '',
    qty: 100,
    plan: '计划内',
    basis: '客观信号',
    note: ''
  });
  saveLog();
  renderLog();
  toastOk('已新增一条空白台账，请填写买卖价格');
}

/* ===================== 认知台账与三法体检 ===================== */
export function cogStats(){
  const rets = (LOG || []).map(logRatio).filter(v => v !== null);
  const n = rets.length;
  const wins = rets.filter(v => v > 0), losses = rets.filter(v => v < 0);
  const W = n ? wins.length / n : null;
  const avgWin  = wins.length   ? wins.reduce((a,b)=>a+b,0) / wins.length : null;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0) / losses.length) : null;
  const R = (avgWin !== null && avgLoss) ? avgWin / avgLoss : null;
  const E = (W !== null && avgWin !== null && avgLoss !== null) ? W*avgWin - (1-W)*avgLoss : null;
  const breakevenW = R ? 1/(1+R) : null;

  const markedP = (LOG || []).filter(r => r.plan).length;
  const markedB = (LOG || []).filter(r => r.basis).length;
  const planRate = markedP ? (LOG || []).filter(r => r.plan === '计划内').length / markedP : null;
  const objRate  = markedB ? (LOG || []).filter(r => r.basis === '客观信号').length / markedB : null;

  return { n, wins: wins.length, losses: losses.length, W, avgWin, avgLoss, R, E, breakevenW, planRate, objRate, markedP, markedB };
}

export function renderCogReport(){
  const el = document.getElementById('cogReport');
  if (!el) return;
  const st = cogStats();

  if (!st.n){
    el.innerHTML = `<div class="mute" style="padding:16px;text-align:center;background:var(--surface);border-radius:8px;border:1px dashed var(--line)">
      台账中暂无完整平仓记录，完成第一笔做T交易后将在此自动生成《认知术》诊断报告。
    </div>`;
    return;
  }

  const wPct = st.W !== null ? (st.W * 100).toFixed(1) + '%' : '—';
  const rVal = st.R !== null ? st.R.toFixed(2) : '—';
  const eVal = st.E !== null ? (st.E >= 0 ? '+' : '') + st.E.toFixed(2) + '%' : '—';
  const planPct = st.planRate !== null ? (st.planRate * 100).toFixed(0) + '%' : '—';
  const objPct = st.objRate !== null ? (st.objRate * 100).toFixed(0) + '%' : '—';

  el.innerHTML = `
    <div class="cog-kpi-grid">
      <div class="ck-card">
        <span class="ck-k">实战胜率</span>
        <span class="ck-v" style="color:${st.W >= 0.6 ? 'var(--up)' : 'var(--warn)'}">${wPct}</span>
        <span class="ck-d">${st.wins} 胜 / ${st.losses} 负 (共 ${st.n} 笔)</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">实战盈亏比 (R)</span>
        <span class="ck-v" style="color:${st.R >= 1.5 ? 'var(--up)' : 'var(--warn)'}">${rVal}</span>
        <span class="ck-d">平均胜 +${st.avgWin ? st.avgWin.toFixed(2) : '0'}% ｜ 均亏 -${st.avgLoss ? st.avgLoss.toFixed(2) : '0'}%</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">每笔数学期望 (E)</span>
        <span class="ck-v" style="color:${st.E > 0 ? 'var(--up)' : 'var(--down)'}">${eVal}</span>
        <span class="ck-d">盈亏平衡要求胜率: ${st.breakevenW ? (st.breakevenW * 100).toFixed(1) + '%' : '—'}</span>
      </div>
      <div class="ck-card">
        <span class="ck-k">计划执行率</span>
        <span class="ck-v" style="color:${st.planRate >= 0.8 ? 'var(--up)' : 'var(--warn)'}">${planPct}</span>
        <span class="ck-d">依据客观信号率: ${objPct}</span>
      </div>
    </div>
  `;
}

export function renderCheckup(){
  renderCogReport();
}

/* ===================== 全局备份、导出与导入 ===================== */
export function exportAll(){
  const dump = {};
  LS_KEYS.forEach(k => {
    try {
      const v = localStorage.getItem(k);
      if (v) dump[k] = JSON.parse(v);
    } catch (_) {}
  });

  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `t-stock-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toastOk('✓ 已成功导出所有本地持仓、台账与系统配置数据！');
}

export function importAll(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== 'object') throw new Error('无效的数据格式');

      Object.keys(data).forEach(k => {
        if (LS_KEYS.includes(k)) {
          localStorage.setItem(k, JSON.stringify(data[k]));
        }
      });

      toastOk('✓ 数据导入成功！正在重新载入工作区…');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      toastErr('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
}

export function copyPlan(){
  let str = `【A股做T实盘作战计划 · ${todayStr()}】\n`;
  (pool || []).forEach(s => {
    let c = null;
    try { c = calc(s); } catch (_) {}
    str += `\n标的：${s.name} (${s.code}) 现价: ${f2(s.price)}\n`;
    str += `· 正T买点：${f2(c ? c.inA : s.price * 0.985)} ~ ${f2(c ? c.inB : s.price * 0.97)}\n`;
    str += `· 冲高止盈：${f2(c ? c.tp1 : s.price * 1.025)} ~ ${f2(c ? c.tp2 : s.price * 1.045)}\n`;
    str += `· 保命止损：${f2(c ? c.slA : s.price * 0.985)}\n`;
  });
  copyPlain(str, '今日作战计划已复制到剪贴板！');
}
