import React from 'react';
import AccountSection from '../components/AccountSection.jsx';

/**
 * 📊 账户资产、市值、仓位与收盘快照页面
 */
export default function AccountPage({
  totalAssets,
  marketValue,
  posRate,
  cash,
  pool,
  snapshots,
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets
}) {
  return (
    <div className="page-account">
      <AccountSection
        totalAssets={totalAssets}
        marketValue={marketValue}
        posRate={posRate}
        cash={cash}
        pool={pool}
        snapshots={snapshots}
        onTakeSnapshot={onTakeSnapshot}
        onClearSnap={onClearSnap}
        onUpdateTotalAssets={onUpdateTotalAssets}
      />
    </div>
  );
}
