/* ============================================================
   A股做T执行台 · 集合竞价弱参考与开盘跳空量化模型 (auction.js)
   基于 213 条大样本历史回溯，用于 09:25–09:30 定盘校准与日内预期管理
   ============================================================ */

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
