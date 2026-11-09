import React from 'react';
import TailSection from '../components/TailSection.jsx';

/**
 * ⚡ 尾盘黑马 T+0 选股与买入看板页面
 */
export default function TailPage({
  totalAssets,
  actives,
  wbLatest,
  onExecTailBuy,
  onExecTailExit
}) {
  return (
    <div className="page-tail">
      <TailSection
        totalAssets={totalAssets}
        actives={actives}
        wbLatest={wbLatest}
        onExecTailBuy={onExecTailBuy}
        onExecTailExit={onExecTailExit}
      />
    </div>
  );
}
