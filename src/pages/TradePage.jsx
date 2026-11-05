import React from 'react';
import SelectionSection from '../components/SelectionSection.jsx';
import ConsoleSection from '../components/ConsoleSection.jsx';

/**
 * 做T决策台页面 (Trade Page)
 * 聚合「二、选股池与自选股」及「三、决策引擎（做T执行卡片池）」
 */
export default function TradePage({
  pool,
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
  return (
    <div className="page-trade">
      {/* 选股池与自选股 */}
      <SelectionSection
        wbLatest={wbLatest}
        pool={pool}
        onAddStock={onAddStock}
        onBatchAdd={onBatchAdd}
        onOpenReason={onOpenReason}
        onRefresh={onRefresh}
        onSelfTest={onSelfTest}
        onJumpPerf={onJumpPerf}
        dbStatus={dbStatus}
      />

      {/* 决策引擎（做T执行卡片池） */}
      <ConsoleSection
        pool={pool}
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
