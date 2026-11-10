/* ============================================================
   A股做T执行台 · 集合竞价弱参考与开盘跳空量化模型 (auction.js)
   基于 213 条大样本历史回溯，用于 09:25–09:30 定盘校准与日内预期管理
   ============================================================ */

import { f2 } from './utils.js';

export const AUCTION_TIERS = [
  {
    key: 'high_gold',
    label: '高开 +1% ~ +3%',
    min: 1.0,
    max: 3.0,
    space: 4.09,
    hit1: 80,
    hit2: 76,
    upClose: 40,
    give: 4.23,
    score: 5,
    tag: '黄金做T档',
    color: 'var(--down)', // A股做T红涨绿买惯例
    bg: 'var(--down-bg)',
    advice: '空间最大（平均 4.09%），触及 +2% 概率高达 76%，冲高分批落袋，绝不隔夜'
  },
  {
    key: 'flat_std',
    label: '平开 0% ~ +1%',
    min: 0.0,
    max: 1.0,
    space: 3.37,
    hit1: 80,
    hit2: 53,
    upClose: 53,
    give: 2.45,
    score: 2,
    tag: '标准平衡档',
    color: 'var(--info)',
    bg: 'var(--surface2)',
    advice: '量价最平衡，按常规七格箱体回踩正T低吸，耐心等待分时企稳'
  },
  {
    key: 'low_narrow',
    label: '小幅低开 −1.5% ~ 0%',
    min: -1.5,
    max: 0.0,
    space: 2.87,
    hit1: 78,
    hit2: 54,
    upClose: 49,
    give: 2.65,
    score: 0,
    tag: '窄幅观察档',
    color: 'var(--sub)',
    bg: 'var(--surface2)',
    advice: '冲高空间较小（平均 2.87%），建议轻仓试探，+1% 即走不贪'
  },
  {
    key: 'deep_low',
    label: '大幅低开 < −1.5%',
    min: -999.0,
    max: -1.5,
    space: 3.21,
    hit1: 80,
    hit2: 58,
    upClose: 40,
    give: 3.74,
    score: -3,
    tag: '防守避险档',
    color: 'var(--warn-d)',
    bg: 'var(--warn-bg)',
    advice: '回撤风险最大（平均 −3.74%），必须等待缩量企稳，只做反弹 +1% 决不深扛'
  },
  {
    key: 'high_spike',
    label: '大幅高开 ≥ +3%',
    min: 3.0,
    max: 999.0,
    space: 3.75,
    hit1: 80,
    hit2: 60,
    upClose: 40,
    give: 5.62,
    score: 0,
    tag: '警惕诱多档',
    color: 'var(--up)',
    bg: 'var(--up-bg)',
    advice: '易冲高回落被套（回撤高达 5.62%），严禁开盘冲动追高，优先倒T高抛'
  }
];

/**
 * 依据开盘跳空幅度判定竞价档位
 * @param {number} gapPct 开盘跳空百分比 (open - prevClose) / prevClose * 100
 */
export function getAuctionTier(gapPct) {
  if (gapPct == null || Number.isNaN(+gapPct)) return null;
  const g = +gapPct;
  for (const tier of AUCTION_TIERS) {
    if (g >= tier.min && g < tier.max) {
      return tier;
    }
  }
  return AUCTION_TIERS[AUCTION_TIERS.length - 1];
}

/**
 * 获取当前时段的集合竞价状态与指引
 */
export function getAuctionStatusInfo() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const wd = now.getDay();
  const isWeekend = (wd === 0 || wd === 6);

  if (isWeekend) {
    return {
      phase: 'weekend',
      label: '周末休市',
      desc: '非交易日，展示历史集合竞价大样本弱参考基准。',
      isAuctionTime: false
    };
  }

  if (mins >= 555 && mins < 565) {
    return {
      phase: 'pre_auction',
      label: '⏰ 09:15-09:25 集合竞价撮合中',
      desc: '主力资金试盘申报中，09:20 前可撤单、09:20 后不可撤单，盯盘为主不盲目抢跑。',
      isAuctionTime: true
    };
  }

  if (mins >= 565 && mins < 570) {
    return {
      phase: 'auction_done',
      label: '🎯 09:25-09:30 竞价定盘已完成',
      desc: '全天开盘价与竞价量已确立！对照竞价五档校准今日挂单买卖预期。',
      isAuctionTime: true
    };
  }

  if (mins >= 570 && mins < 900) {
    return {
      phase: 'trading',
      label: '盘中连续交易中',
      desc: '开盘跳空已定，对照竞价弱参考与七格箱体执行日内做T。',
      isAuctionTime: false
    };
  }

  return {
    phase: 'closed',
    label: '已收盘',
    desc: '今日竞价已归档，供盘后复盘与明日对比。',
    isAuctionTime: false
  };
}

/* ============================================================
   第三阶段：轻量化短线与连板辅助（避开 L2 逐笔撤单陷阱）
   1. 09:25 集合竞价高开量比与弱转强模型
   2. 9:40 前涨停硬度追踪模型 (封单额/封成比/炸板预警)
   ============================================================ */

/**
 * 09:25 集合竞价高开量比与「弱转强」量化模型 (避开 L2 逐笔撤单陷阱，用公开定盘数据)
 * @param {Object} stock - 股票数据对象
 * @returns {Object} 竞价形态与弱转强判定结果
 */
export function computeAuctionPattern(stock) {
  if (!stock) return null;
  const open = +stock.open || 0;
  const prevClose = +stock.prevClose || 0;
  if (!open || !prevClose) return null;

  const gap = ((open - prevClose) / prevClose) * 100;
  const vr = +stock.vr || 1.0;
  const ceiling = +stock.ceiling || 0;

  // 昨收盘表现（用于判定昨弱今强）
  const prevChg = stock.prevChg !== undefined ? +stock.prevChg : (stock.ma5 ? ((prevClose - stock.ma5) / stock.ma5 * 100) : 0);
  const hadPrevBroken = !!stock.hadPrevBroken;
  const hadPrevLimitUp = !!stock.hadPrevLimitUp;

  // 真正的「昨弱」：昨日炸板烂板、或昨日大跌调整 (<= -1.8%)、或昨日破位
  const wasWeakYesterday = hadPrevBroken || (prevChg <= -1.8) || (stock.box20 && stock.box20.down);

  // 涨停判定价位
  const is20cm = String(stock.code || '').startsWith('30') || String(stock.code || '').startsWith('68');
  const limitUpPrice = ceiling > 0 ? ceiling : Math.round(prevClose * (is20cm ? 1.20 : 1.10) * 100) / 100;
  const isOneWordLimit = open >= limitUpPrice - 0.01;

  if (isOneWordLimit) {
    return {
      type: 'ONE_WORD',
      tag: '💎 一字封板',
      title: '09:25 一字涨停定盘',
      desc: '主力资金顶格顶板，流动性被锁死，买不进也不建议撤挂单；持股者享受溢价，场外切勿排单接飞刀。',
      color: 'var(--down)',
      bg: 'var(--down-bg)',
      border: 'var(--down-b)',
      gap,
      vr,
      score: 95,
      isWeakToStrong: false,
      isHot: true
    };
  }

  // 弱转强判定逻辑：必须具备【昨日弱势/炸板烂板/大阴杀跌】+【今日 09:25 逆势爆量高开 (+1.5% ~ +5.8% 且量比 >= 1.8)】
  if (wasWeakYesterday && gap >= 1.5 && gap <= 5.8 && vr >= 1.8) {
    const reason = hadPrevBroken ? '昨日冲板炸板烂板分歧' : `昨日杀跌调整 ${prevChg.toFixed(1)}%`;
    return {
      type: 'WEAK_TO_STRONG',
      tag: '🚀 弱转强爆量开',
      title: '09:25 弱转强超预期逆转',
      desc: `${reason}，今日竞价逆势高开 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%（量比 ${vr.toFixed(2)}倍）！主力真金白银扭转空头预期，早盘极速上板概率极高！`,
      color: '#cf1322',
      bg: '#fff1f0',
      border: '#ffa39e',
      gap,
      vr,
      score: 92,
      isWeakToStrong: true,
      isHot: true
    };
  }

  // 高开抢筹
  if (gap >= 3.0 && vr >= 2.0) {
    return {
      type: 'RUSH_LONG',
      tag: '⚡ 竞价抢筹冲板',
      title: '高开爆量主力抢筹',
      desc: `高开 ${gap.toFixed(2)}% 且竞价量比高达 ${vr.toFixed(2)}，场内资金开盘抢筹，具备冲击涨停潜质，需盯紧开盘分时均线不破可轻仓跟进。`,
      color: '#d4380d',
      bg: '#fff2e8',
      border: '#ffbb96',
      gap,
      vr,
      score: 85,
      isWeakToStrong: false,
      isHot: true
    };
  }

  // 强转弱警报
  if (prevChg > 3.0 && gap <= -1.5) {
    return {
      type: 'STRONG_TO_WEAK',
      tag: '⚠️ 强转弱低开',
      title: '昨日强势今日低开走弱',
      desc: `昨日表现强劲今日却低开 ${gap.toFixed(2)}%，竞价严重不及预期，主力资金开盘逃跑，严禁开盘盲目抄底！`,
      color: 'var(--up-d)',
      bg: 'var(--up-bg)',
      border: 'var(--up-b)',
      gap,
      vr,
      score: 30,
      isWeakToStrong: false,
      isHot: false
    };
  }

  // 深度低开
  if (gap <= -2.5) {
    return {
      type: 'DEEP_LOW',
      tag: '⛔ 深低开防核',
      title: '竞价深幅低开恐慌',
      desc: `低开 ${gap.toFixed(2)}%，空头抛压沉重，需防范恐慌核按钮，必须等待日内缩量横盘企稳后方可试T。`,
      color: 'var(--warn-d)',
      bg: 'var(--warn-bg)',
      border: 'var(--warn-b)',
      gap,
      vr,
      score: 25,
      isWeakToStrong: false,
      isHot: false
    };
  }

  // 温和平开
  const stdTier = getAuctionTier(gap);
  return {
    type: 'NORMAL',
    tag: stdTier ? stdTier.tag : '温和平开',
    title: '常规温和竞价',
    desc: stdTier ? stdTier.advice : '开盘跳空在正常波动范围，量价相对均衡，按常规七格箱体回踩正T。',
    color: stdTier ? stdTier.color : 'var(--text)',
    bg: stdTier ? stdTier.bg : 'var(--surface2)',
    border: 'var(--line)',
    gap,
    vr,
    score: 60,
    isWeakToStrong: false,
    isHot: false
  };
}

/**
 * 涨停与连板打板追踪模型 (仅在昨日有涨停 或 今日逼近/封死/曾炸板涨停时激活)
 * @param {Object} stock - 股票实时数据
 * @returns {Object} 涨停与打板监控数据
 */
export function computeLimitUpRigidity(stock) {
  if (!stock) return null;
  const codeStr = String(stock.code || '');
  // 打板体系严格去除创业板 (30开头)
  if (codeStr.startsWith('30')) return null;
  const px = +stock.price || 0;
  const hi = +stock.high || px;
  const prevClose = +stock.prevClose || 0;
  if (!px || !prevClose) return null;

  const is20cm = String(stock.code || '').startsWith('30') || String(stock.code || '').startsWith('68');
  const ceiling = +stock.ceiling > 0 ? +stock.ceiling : Math.round(prevClose * (is20cm ? 1.20 : 1.10) * 100) / 100;

  // 1. 昨日是否有涨停基因 / 连板接力背景
  const hadPrevLimitUp = !!stock.hadPrevLimitUp;
  const hadPrevBroken = !!stock.hadPrevBroken;

  // 2. 今日涨跌幅与涨停价差
  const chg = ((px - prevClose) / prevClose) * 100;
  const distCeiling = ceiling > 0 ? ((ceiling - px) / ceiling) * 100 : 999;
  const isLimitUp = px >= ceiling - 0.01;
  const touchedLimit = hi >= ceiling - 0.01;
  const isBroken = touchedLimit && !isLimitUp;
  const brokenDrop = isBroken ? ((px - ceiling) / ceiling) * 100 : 0;

  // 3. 今日是否处于逼近涨停的冲板窗口（首板打板观察：主板 >= 7.5%，创业板/科创板 >= 15%，或现价距涨停 <= 1.8%）
  const nearThreshold = is20cm ? 15.0 : 7.5;
  const isNearLimit = (chg >= nearThreshold) || (distCeiling <= 1.8 && chg > 5.0);

  // 4. 严格判定是否具备「打板 / 连板追踪标的」资格：
  // 必须满足：【昨日涨停 (接力打板候选)】OR【今日逼近涨停 (首板冲板打板)】OR【今日已封板】OR【今日曾炸板】
  const isBoardTarget = hadPrevLimitUp || hadPrevBroken || isLimitUp || isBroken || isNearLimit;

  // 买一封单手与金额
  const b1_v = +stock.b1_v || 0;
  const b1_p = +stock.b1_p || 0;
  const sealShares = (isLimitUp && b1_p >= ceiling - 0.01) ? (b1_v * 100) : (isLimitUp ? b1_v * 100 : 0);
  const sealAmtYuan = sealShares * ceiling;
  const turnoverYuan = (+stock.amt || 0) * 10000;
  const sealRatio = turnoverYuan > 0 ? (sealAmtYuan / turnoverYuan) : (sealAmtYuan > 0 ? 10 : 0);

  // 封板时间窗口分析
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isBefore940 = (mins >= 570 && mins <= 580); // 09:30 - 09:40

  let hardnessScore = 0;
  let status = 'normal'; // 'limit_up' | 'broken' | 'rush' | 'prev_relay' | 'prev_broken' | 'normal'
  let label = '常规短线波动';
  let desc = '普通短线波动，未达冲板临界点且昨日无涨停';
  let badgeColor = 'var(--sub)';
  let badgeBg = 'var(--surface2)';

  if (!isBoardTarget) {
    return {
      isBoardTarget: false,
      isLimitUp: false,
      touchedLimit: false,
      isBroken: false,
      isNearLimit: false,
      hadPrevLimitUp: false,
      hadPrevBroken: false,
      brokenDrop: 0,
      ceiling,
      chg,
      distCeiling,
      b1_v,
      b1_p,
      sealShares: 0,
      sealAmtYuan: 0,
      turnoverYuan,
      sealRatio: 0,
      hardnessScore: 0,
      status: 'normal',
      label: '常规标的',
      desc: '未达冲板临界点且昨日未涨停',
      badgeColor: 'var(--sub)',
      badgeBg: 'var(--surface2)',
      isBefore940
    };
  }

  // 达到打板标的资格，判定具体状态
  if (isBroken) {
    status = 'broken';
    hardnessScore = Math.max(10, Math.round(35 + brokenDrop * 3));
    label = `🚨 曾炸板 (现跌落${Math.abs(brokenDrop).toFixed(1)}%)`;
    desc = `今日盘中曾触碰涨停 ¥${f2(ceiling)}，但随后被抛盘砸开，当前自涨停回落 ${Math.abs(brokenDrop).toFixed(1)}%！严禁盲目打板接飞刀！`;
    badgeColor = '#cf1322';
    badgeBg = '#fff1f0';
  } else if (isLimitUp) {
    status = 'limit_up';
    // 1. 封成比与封单额得分 (0 - 45分)
    let sealScore = 15;
    if (sealRatio >= 3.0 || sealAmtYuan >= 2e8) sealScore = 45;
    else if (sealRatio >= 1.5 || sealAmtYuan >= 8e7) sealScore = 40;
    else if (sealRatio >= 0.8 || sealAmtYuan >= 3e7) sealScore = 32;
    else if (sealRatio >= 0.4) sealScore = 24;

    // 2. 封板时点权重 (0 - 45分)
    let timeScore = 20;
    if (mins < 571) timeScore = 45; // 09:25-09:30 一字板
    else if (mins <= 575) timeScore = 42; // 09:30-09:35 秒板
    else if (mins <= 580) timeScore = 38; // 09:35-09:40 9:40前极强
    else if (mins <= 600) timeScore = 30; // 09:40-10:00
    else if (mins <= 690) timeScore = 22; // 上午板
    else timeScore = 15; // 午后板

    // 3. 换手率匹配加成 (0 - 10分)
    const to = +stock.to || 0;
    const toScore = (to >= 3 && to <= 15) ? 10 : 5;

    hardnessScore = Math.min(100, sealScore + timeScore + toScore);

    if (hardnessScore >= 85) {
      label = isBefore940 ? '💎 9:40前顶级硬板' : '💎 超级硬板 (封死)';
      desc = `买一封单 ¥${(sealAmtYuan / 1e8).toFixed(2)}亿，封成比 ${sealRatio.toFixed(2)}倍，封单坚决，次日溢价预期极高。`;
      badgeColor = '#cf1322';
      badgeBg = '#fff1f0';
    } else if (hardnessScore >= 70) {
      label = '🔥 强势封死 (硬度良好)';
      desc = `买一封单 ¥${(sealAmtYuan / 1e4).toFixed(0)}万，封成比 ${sealRatio.toFixed(2)}倍，硬度良好，注意盘中单量变动。`;
      badgeColor = '#d4380d';
      badgeBg = '#fff2e8';
    } else {
      label = '🟡 常规板 (防尾盘漏单)';
      desc = `买一封单金额偏弱或换手不足，需警惕尾盘炸板漏单风险。`;
      badgeColor = '#d46b08';
      badgeBg = '#fffbe6';
    }
  } else if (isNearLimit) {
    status = 'rush';
    hardnessScore = Math.round(chg * 4);
    label = `⚡ 逼近涨停冲板中 (+${chg.toFixed(1)}%)`;
    desc = `现价 ¥${f2(px)} 距涨停仅差 ${distCeiling.toFixed(1)}%，场内多头正猛烈冲击封板，进入打板扫板/排单临界决策窗口！`;
    badgeColor = '#1677ff';
    badgeBg = '#e6f4ff';
  } else if (hadPrevLimitUp) {
    status = 'prev_relay';
    hardnessScore = Math.round(50 + chg * 2);
    label = `🎯 昨日涨停 · 连板接力观察`;
    desc = `昨日强势涨停，今日当前涨跌幅 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%，重点观察能否快速突破分时均线走出 1进2 / 连板！`;
    badgeColor = '#389e0d';
    badgeBg = '#f6ffed';
  } else if (hadPrevBroken) {
    status = 'prev_broken';
    hardnessScore = 40;
    label = `⚠️ 昨炸板烂板 · 分歧修复观察`;
    desc = `昨日曾触及涨停但被砸开收烂板，今日重点观察是否有资金逆势承接走出弱转强修复。`;
    badgeColor = '#d46b08';
    badgeBg = '#fffbe6';
  }

  return {
    isBoardTarget: true,
    isLimitUp,
    touchedLimit,
    isBroken,
    isNearLimit,
    hadPrevLimitUp,
    hadPrevBroken,
    brokenDrop,
    ceiling,
    chg,
    distCeiling,
    b1_v,
    b1_p,
    sealShares,
    sealAmtYuan,
    turnoverYuan,
    sealRatio,
    hardnessScore,
    status,
    label,
    desc,
    badgeColor,
    badgeBg,
    isBefore940
  };
}

/**
 * 打板次日溢价与卖出/止盈/转做T决策模型
 * 专为「昨日涨停连板标的」或「超短打板机动仓位」打造
 * 涵盖：
 * 1. 09:15-09:25 竞价开盘溢价定性（超预期/符合预期/弱于预期/恶性核按钮）
 * 2. 09:30-10:00 早盘冲高滞涨卖点与止盈策略
 * 3. 动态防守线（跌破均线清仓）与「一键转为底仓做T」建议
 */
export function computeNextDayExitDecision(stock) {
  if (!stock) return null;
  const isShortTier = stock.tier === 'short' || stock.poolTag === '短线';
  const hadLimitUp = !!stock.hadPrevLimitUp || (stock.lbc && stock.lbc >= 1);
  const hadBroken = !!stock.hadPrevBroken;

  // 如果既不是短线仓位，也没有涨停/炸板基因，则不展示该决策
  if (!isShortTier && !hadLimitUp && !hadBroken) return null;

  const open = +stock.open || 0;
  const prevClose = +stock.prevClose || 0;
  const price = +stock.price || 0;
  const ceiling = +stock.ceiling || 0;
  const openGap = (open > 0 && prevClose > 0) ? ((open - prevClose) / prevClose) * 100 : 0;
  const curChg = (price > 0 && prevClose > 0) ? ((price - prevClose) / prevClose) * 100 : openGap;

  const is20cm = String(stock.code || '').startsWith('30') || String(stock.code || '').startsWith('68');
  const limitUpPrice = ceiling > 0 ? ceiling : Math.round(prevClose * (is20cm ? 1.20 : 1.10) * 100) / 100;
  const isCurrentlyLimitUp = price >= limitUpPrice - 0.01;

  // 1. 竞价开盘溢价档位诊断
  let auctionVerdict = {
    tier: 'NORMAL_HIGH',
    badge: '🎯 符合预期',
    title: `正常小高开 (${openGap >= 0 ? '+' : ''}${openGap.toFixed(1)}%) · 冲高分批止盈`,
    desc: '开盘溢价合理，主力未出现极端抢筹或弃庄。',
    action: '开盘冲高至 +3%~+5% 择机挂单先止盈锁利 1/2；剩余半仓以分时黄线为防守底线，破线全走。',
    color: '#0284c7',
    bg: '#f0f9ff',
    border: '#bae6fd',
    urgency: 'medium'
  };

  if (openGap >= 3.8 || (open >= limitUpPrice - 0.01 && open > 0)) {
    auctionVerdict = {
      tier: 'SUPER_HIGH',
      badge: '🔥 强力超预期',
      title: `大幅高开 (+${openGap.toFixed(1)}%) · 锁仓博弈连板`,
      desc: '主力资金竞价爆量顶板或大幅高开，弱转强或加速连板意图明显。',
      action: '锁仓拿住！严禁盲目开盘抢跑；若 9:35 前秒板继续格局；若冲高未能封死且放天量跌破分时黄线，分批止盈 1/2。',
      color: '#16a34a',
      bg: '#f0fdf4',
      border: '#86efac',
      urgency: 'low'
    };
  } else if (openGap >= -1.0 && openGap < 1.0) {
    auctionVerdict = {
      tier: 'FLAT_WEAK',
      badge: '⚠️ 弱于预期',
      title: `平开/微幅震荡 (${openGap >= 0 ? '+' : ''}${openGap.toFixed(1)}%) · 防分歧跳水`,
      desc: '昨日涨停次日未获主力溢价认可，交投出现严重分歧。',
      action: '盯紧开盘前 5 分钟！若无法迅速放量翻红站上分时均线，逢脉冲抽高保本或微亏保本离场，绝不恋战！',
      color: '#ea580c',
      bg: '#fff7ed',
      border: '#fdba74',
      urgency: 'high'
    };
  } else if (openGap < -1.0) {
    auctionVerdict = {
      tier: 'DUMP_DANGER',
      badge: '🚨 恶性核按钮',
      title: `大幅低开 (${openGap.toFixed(1)}%) · 果断抢跑止损`,
      desc: '主力大单竞价砸盘抢跑，昨日追高跟风盘全线深套踩踏。',
      action: '严禁幻想日内反包或抄底摊平！开盘第一时间市价直接挂单排队止损出局，防吃日内大长阴！',
      color: '#dc2626',
      bg: '#fef2f2',
      border: '#fca5a5',
      urgency: 'critical'
    };
  }

  // 2. 盘中实战卖点与做T转换指引
  let intradayAdvice = '以分时均价黄线（VWAP）为日内生命线。黄线上方持股，一旦跌破分时均线且反抽无力，全部止盈离场。';
  let canConvertToT = true;
  let convertReason = '若看好个股中线逻辑，可在早盘冲高高抛大部分仓位兑现打板浮盈后，点击【转为底仓做T】，保留小底仓长期波段降成本。';

  if (isCurrentlyLimitUp) {
    intradayAdvice = '当前已强势封死涨停板！封单稳健，继续锁仓享受连板溢价，板上不卖。';
    canConvertToT = false;
  } else if (curChg >= 5.0) {
    intradayAdvice = `日内已冲高至 +${curChg.toFixed(1)}%！若未能封涨停且出现分时顶背离，为打板次日绝佳高抛落袋点，建议挂单分批止盈！`;
  }

  return {
    isShortTier,
    hadLimitUp,
    openGap,
    curChg,
    isCurrentlyLimitUp,
    limitUpPrice,
    auctionVerdict,
    intradayAdvice,
    canConvertToT,
    convertReason
  };
}
