import React from 'react';
import TailSection from '../components/TailSection.jsx';

/**
 * ⚡ 尾盘黑马 T+0 选股与买入看板页面
 */
export default function TailPage({
  totalAssets,
  cash,
  actives,
  wbLatest,
  tiltState = null,
  onExecTailBuy,
  onExecTailExit,
  onRefreshContract
}) {
  return (
    <div className="page-tail">
      <TailSection
        totalAssets={totalAssets}
        cash={cash}
        actives={actives}
        wbLatest={wbLatest}
        tiltState={tiltState}
        onExecTailBuy={onExecTailBuy}
        onExecTailExit={onExecTailExit}
        onRefreshContract={onRefreshContract}
      />
    </div>
  );
}
