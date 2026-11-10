import React, { useState } from 'react';
import SelectionSection from '../components/SelectionSection.jsx';
import ConsoleSection from '../components/ConsoleSection.jsx';
import MarketSentimentBar from '../components/MarketSentimentBar.jsx';

/**
 * 做T决策台页面 (Trade Page)
 * 聚合「一、选股池与自选股」及「二、决策引擎（自动算买卖点·单股聚焦/全部切换）」
 */
export default function TradePage({
  pool,
  activeStockCode: externalActiveCode,
  onSelectStock: externalSelectStock,
  totalAssets = 100000,
  wbLatest,
  dbStatus,
  tradeLogs = [],
  isTailAlertTime = false,
  simTailAlert = false,
  onAddStock,
  onBatchAdd,
  onOpenReason,
  onRefresh,
  onSelfTest,
  onJumpPerf,
  onUpdateStock,
  onBuyStock,
  onRemoveStock,
  onAddBlank,
  onSaveLocal,
  onResetDefault,
  onOpenQuickT,
  onRefreshSingle,
  onCopySinglePlan
}) {
  const [internalActiveCode, setInternalActiveCode] = useState(() => (pool[0]?.code || ''));
  const activeStockCode = externalActiveCode !== undefined ? externalActiveCode : internalActiveCode;
  const handleSelectStock = externalSelectStock || setInternalActiveCode;

  const handleReasonClick = (st, have) => {
    if (have && st.code) {
      handleSelectStock(String(st.code).padStart(6, '0'));
    }
    if (onOpenReason) {
      onOpenReason(st, have);
    }
  };

  const shortStocks = (pool || []).filter(s => s.tier === 'short' || s.hadPrevLimitUp);

  return (
    <div className="page-trade">
      {/* 🌡️ 全市场超短情绪温度计 & 炸板率风控总阀 */}
      <MarketSentimentBar />

      {/* 选股池与自选股 */}
      <SelectionSection
        wbLatest={wbLatest}
        pool={pool}
        onAddStock={async (q) => {
          await onAddStock(q);
        }}
        onBatchAdd={onBatchAdd}
        onOpenReason={handleReasonClick}
        onRefresh={onRefresh}
        onSelfTest={onSelfTest}
        onJumpPerf={onJumpPerf}
        dbStatus={dbStatus}
      />

      {/* 🔥 连板打板独立专栏与次日卖点联动横幅 */}
      <div style={{
        margin: '10px 0 14px',
        padding: '9px 14px',
        borderRadius: '8px',
        background: 'linear-gradient(90deg, #18181b, #271b30)',
        border: '1px solid #3f3f46',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '17px' }}>🔥</span>
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#f87171' }}>
            连板打板专栏与次日卖出决策：
          </span>
          <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
            全市场涨停天梯 · 09:25高开量比 · 冲板扫板
            {shortStocks.length > 0 && (
              <b style={{ color: '#fbbf24', marginLeft: '6px' }}>
                · 决策台中 {shortStocks.length} 只标的已开启【次日卖出决策雷达】
              </b>
            )}
          </span>
        </div>
        <a
          href="#/board"
          style={{
            fontSize: '11.5px',
            color: '#fff',
            background: '#cf1322',
            padding: '4px 12px',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: 700,
            boxShadow: '0 2px 6px rgba(207, 19, 34, 0.4)'
          }}
        >
          查看连板打板天梯 →
        </a>
      </div>

      {/* 决策引擎（做T执行卡片池：顶部切换条 + 卡片切换） */}
      <ConsoleSection
        pool={pool}
        activeStockCode={activeStockCode}
        totalAssets={totalAssets}
        tradeLogs={tradeLogs}
        isTailAlertTime={isTailAlertTime}
        simTailAlert={simTailAlert}
        onSelectStock={handleSelectStock}
        onUpdateStock={onUpdateStock}
        onBuyStock={onBuyStock}
        onRemoveStock={onRemoveStock}
        onAddBlank={onAddBlank}
        onSaveLocal={onSaveLocal}
        onResetDefault={onResetDefault}
        onRefresh={onRefresh}
        onOpenQuickT={onOpenQuickT}
        onOpenReason={onOpenReason}
        onRefreshSingle={onRefreshSingle}
        onCopySinglePlan={onCopySinglePlan}
      />
    </div>
  );
}
