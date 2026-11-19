import React from 'react';
import AccountSection from '../components/AccountSection.jsx';

/**
 * 📊 账户资产、真实可用现金、净值曲线与收盘快照页面
 */
export default function AccountPage({
  totalAssets,
  initialCapital,
  marketValue,
  poolMarketValue,
  tailMarketValue,
  posRate,
  cash,
  pool,
  tailActives,
  tradeLogs,
  snapshots,
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets,
  onUpdateCash,
  onSelectStock,
  onJumpDiagnosis,
  onTabChange,
}) {
  return (
    <div className="page-account">
      <AccountSection
        totalAssets={totalAssets}
        initialCapital={initialCapital}
        marketValue={marketValue}
        poolMarketValue={poolMarketValue}
        tailMarketValue={tailMarketValue}
        posRate={posRate}
        cash={cash}
        pool={pool}
        tailActives={tailActives}
        tradeLogs={tradeLogs}
        snapshots={snapshots}
        onTakeSnapshot={onTakeSnapshot}
        onClearSnap={onClearSnap}
        onUpdateTotalAssets={onUpdateTotalAssets}
        onUpdateCash={onUpdateCash}
        onSelectStock={onSelectStock}
        onJumpDiagnosis={onJumpDiagnosis}
        onTabChange={onTabChange}
      />
    </div>
  );
}
