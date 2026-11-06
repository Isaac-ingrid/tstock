import React, { useState } from 'react';
import SelectionSection from '../components/SelectionSection.jsx';
import ConsoleSection from '../components/ConsoleSection.jsx';

/**
 * 做T决策台页面 (Trade Page)
 * 聚合「一、选股池与自选股」及「二、决策引擎（自动算买卖点·单股聚焦/全部切换）」
 */
export default function TradePage({
  pool,
  activeStockCode: externalActiveCode,
  onSelectStock: externalSelectStock,
  wbLatest,
  dbStatus,
  onAddStock,
  onBatchAdd,
  onOpenReason,
  onRefresh,
  onSelfTest,
  onJumpPerf,
  onUpdateStock,
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

  return (
    <div className="page-trade">
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

      {/* 决策引擎（做T执行卡片池：顶部切换条 + 卡片切换） */}
      <ConsoleSection
        pool={pool}
        activeStockCode={activeStockCode}
        onSelectStock={handleSelectStock}
        onUpdateStock={onUpdateStock}
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
