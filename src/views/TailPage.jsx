import React from 'react';
import TailSection from '../components/TailSection.jsx';

/**
 * ⚡ 尾盘黑马 T+0 选股与买入看板页面
 */
export default function TailPage({
  pool = [],
  totalAssets,
  cash,
  currentMktVal = null,
  allowedCapPct = 80,
  actives,
  wbLatest,
  tiltState = null,
  onUpdateTotalAssets,
  onUpdateCash,
  onExecTailBuy,
  onExecTailExit,
  onRefreshContract,
  onAddStock,
  onSelectStock,
  onJumpIgnition,
  onTabChange,
}) {
  return (
    <div className="page-tail">
      <TailSection
        pool={pool}
        totalAssets={totalAssets}
        cash={cash}
        currentMktVal={currentMktVal}
        allowedCapPct={allowedCapPct}
        actives={actives}
        wbLatest={wbLatest}
        tiltState={tiltState}
        onUpdateTotalAssets={onUpdateTotalAssets}
        onUpdateCash={onUpdateCash}
        onExecTailBuy={onExecTailBuy}
        onExecTailExit={onExecTailExit}
        onRefreshContract={onRefreshContract}
        onAddStock={onAddStock}
        onSelectStock={onSelectStock}
        onJumpIgnition={onJumpIgnition}
        onTabChange={onTabChange}
      />
    </div>
  );
}
