/**
 * 站点全局配置与静态元数据 (Data & Config Separation)
 */

export const APP_PAGE_TITLE = '智策战情室 · A股多维选股与实战终端';

export const SITE_META = {
  title: '智策战情室',
  subtitle: 'A股多维选股与实战终端：起爆潜伏、龙头抄底、连板情绪、尾盘黑马、盘中做T与战绩回算一体化。',
  footer: '系统提供概率优势，纪律保障复利增长。多周期共振定拐点，仓位风控守底线。',
  methodologyTags: [
    '多周期试盘起爆',
    '深跌抗跌抄底',
    '连板情绪接力',
    '七格箱体做T',
    '策略战绩回算'
  ]
};

// 路由与导航项定义 (用于 TopNav 与 URL 路由关联)
export const NAV_ROUTES = [
  {
    path: '/trade',
    tab: 'tabConsole',
    label: '今日作战',
    icon: '🎯',
    badgeKey: 'poolCount',
    desc: '选股池与个股做T决策台'
  },
  {
    path: '/ignition',
    tab: 'tabIgnition',
    label: '🚀 起爆挖掘',
    icon: '🚀',
    badgeKey: 'ignitionCount',
    highlight: true,
    desc: '横盘多周期试盘起爆潜伏 + 板块深跌龙头抗跌抄底'
  },
  {
    path: '/board',
    tab: 'tabBoard',
    label: '🔥 连板打板',
    icon: '🔥',
    badgeKey: 'boardCount',
    highlight: true,
    desc: '连板天梯、游资热度、题材风口、打板量化评级与风险防炸'
  },
  {
    path: '/tail',
    tab: 'tabTail',
    label: '⚡ 尾盘黑马',
    icon: '⚡',
    badgeKey: 'tailCount',
    desc: '尾盘 14:30~15:00 突击 T+0 机会'
  },
  {
    path: '/diagnosis',
    tab: 'tabDiagnosis',
    label: '🩺 全景诊断',
    icon: '🩺',
    badgeKey: null,
    desc: '任意股票排雷、实时公告、板块风口与做T解套处方'
  },
  {
    path: '/account',
    tab: 'tabAccount',
    label: '账户',
    icon: '💰',
    badgeKey: null,
    desc: '总资产、持仓市值与每日收盘快照'
  },
  {
    path: '/ledger',
    tab: 'tabLedger',
    label: '台账',
    icon: '📒',
    badgeKey: 'ledgerCount',
    desc: '做T流水明细与健康体检'
  },
  {
    path: '/perf',
    tab: 'tabPerf',
    label: '📊 战绩透视',
    icon: '📊',
    badgeKey: null,
    highlight: true,
    desc: '收益归因与战绩分析'
  },
  {
    path: '/rules',
    tab: 'tabRules',
    label: '纪律',
    icon: '📖',
    badgeKey: null,
    desc: '生存八条铁律、量价口诀与时间窗口'
  },
  {
    path: '/all',
    tab: 'tabAll',
    label: '🌐 全览',
    icon: '🌐',
    badgeKey: null,
    desc: '垂直流式查看所有看板'
  }
];

// 本地存储持久化 Key 常量
export const STORAGE_KEYS = {
  POOL: 't-system-pool',
  ACTIVE_TAB: 't-active-tab',
  ACCOUNT_TOTAL: 't-account-total',
  TRADE_LOG: 't-system-log',
  TAIL_ACTIVE: 't-tail-buy-active',
  SNAPSHOTS: 't-system-snap'
};

// 预设默认持仓股池配置
export const DEFAULT_POOL = [
  {
    code: '605128',
    name: '上海沿浦',
    tier: 'short',
    poolTag: '短线',
    shares: 1000,
    cost: 32.50,
    price: 33.20,
    prevClose: 32.80,
    high: 33.60,
    low: 32.40,
    avg: 33.05,
    vr: 1.35,
    ma5: 32.60,
    ma10: 32.10,
    ma20: 31.80,
    cap: 50000
  },
  {
    code: '002050',
    name: '三花智控',
    tier: 'long',
    poolTag: '稳健',
    shares: 2000,
    cost: 23.80,
    price: 24.15,
    prevClose: 24.00,
    high: 24.50,
    low: 23.90,
    avg: 24.20,
    vr: 0.95,
    ma5: 24.00,
    ma10: 23.70,
    ma20: 23.30,
    cap: 80000
  }
];
