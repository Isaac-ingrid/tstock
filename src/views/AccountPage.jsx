import React from 'react';
import AccountSection from '../components/AccountSection.jsx';

/**
 * 📊 账户资产、真实可用现金、节前安全仓位水位线与净值曲线页面
 */
export default function AccountPage({
  totalAssets,
  initialCapital,
  marketValue,
  poolMarketValue,
  tailMarketValue,
  posRate,
  allowedCapPct,
  cash,
  pool,
  tailActives,
  tradeLogs,
  snapshots,
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
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
        allowedCapPct={allowedCapPct}
        cash={cash}
        pool={pool}
        tailActives={tailActives}
        tradeLogs={tradeLogs}
        snapshots={snapshots}
        onTakeSnapshot={onTakeSnapshot}
        onClearSnap={onClearSnap}
        onUpdateTotalAssets={onUpdateTotalAssets}
        onUpdateCash={onUpdateCash}
        onUpdateInitialCapital={onUpdateInitialCapital}
        onSelectStock={onSelectStock}
        onJumpDiagnosis={onJumpDiagnosis}
        onTabChange={onTabChange}
      />
    </div>
  );
}
