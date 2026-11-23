import React, { useState, useEffect, useMemo } from 'react';
import RulesSection from '../components/RulesSection.jsx';
import {
  getAShareMarketStatus,
  getUpcomingHolidayReminder,
  syncRemoteTradeCalendar,
} from '../services/calendar.js';

/**
 * 📖 作战纪律、生存法则、量价口诀、时间窗口与节前长假跨假T+1风控手册页面
 */
export const HOLIDAY_SOP_TIERS = [
  {
    id: 'super_long',
    tierLabel: '🏮 超级长假档（连休 ≥ 7 天）',
    examples: '春节、国庆节（含国庆中秋连休）',
    windowText: '节前最后 1~2 个交易日',
    holidayCapText: '≤ 30%（≤3成）',
    combinedCapText: '绿灯 30% · 黄灯 30% · 红灯 20%',
    actionText: '锁定 7 成以上现金护城河，严防长假期间外围宏观波动与行业利空跳空',
  },
  {
    id: 'mini_long',
    tierLabel: '🏮 小长假档（连休 3~6 天）',
    examples: '元旦、清明节、劳动节、端午节、中秋节连休',
    windowText: '节前最后 1~2 个交易日',
    holidayCapText: '≤ 50%（3~5成）',
    combinedCapText: '绿灯 50% · 黄灯 50% · 红灯 20%',
    actionText: '去弱留强仅留半仓以内主线前排，优先清出跟风补涨、尾盘短博与破位股',
  },
  {
    id: 'single_short',
    tierLabel: '📅 独立单日休市 / 普通双休（1~2 天）',
    examples: '周中不连周末的独立单日节假日、常规周末',
    windowText: '节前 1 个交易日',
    holidayCapText: '按日常情绪上限',
    combinedCapText: '绿灯 80% · 黄灯 50% · 红灯 20%',
    actionText: '不触发长假黄牌强减，仅留意节前午后流动性微幅收敛、T仓 14:55 前闭环',
  },
];

export default function RulesPage({ onTabChange, referenceDate = null }) {
  const [calTick, setCalTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    syncRemoteTradeCalendar().then(() => {
      if (mounted) setCalTick((t) => t + 1);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const mktStatus = useMemo(
    () => getAShareMarketStatus(referenceDate || new Date()),
    [referenceDate, calTick]
  );
  const holidayReminder = useMemo(
    () => getUpcomingHolidayReminder(referenceDate || new Date()),
    [referenceDate, calTick]
  );

  return (
    <div className="page-rules">
      <RulesSection
        mktStatus={mktStatus}
        holidayReminder={holidayReminder}
        holidayTiers={HOLIDAY_SOP_TIERS}
        onTabChange={onTabChange}
      />
    </div>
  );
}
