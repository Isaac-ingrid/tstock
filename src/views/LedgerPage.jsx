import React from 'react';
import LedgerSection from '../components/LedgerSection.jsx';

/**
 * 📒 做T成交流水与纪律体检页面
 */
export default function LedgerPage({
  logs,
  wbLatest,
  onAddLog,
  onUpdateLog,
  onDeleteLog,
  pool,
  totalAssets,
  vaultStatus,
  onForceSyncVault,
  onRestoreVault,
  onExport,
  onImportClick
}) {
  return (
    <div className="page-ledger">
      <LedgerSection
        logs={logs}
        wbLatest={wbLatest}
        onAddLog={onAddLog}
        onUpdateLog={onUpdateLog}
        onDeleteLog={onDeleteLog}
        pool={pool}
        totalAssets={totalAssets}
        vaultStatus={vaultStatus}
        onForceSyncVault={onForceSyncVault}
        onRestoreVault={onRestoreVault}
        onExport={onExport}
        onImportClick={onImportClick}
      />
    </div>
  );
}
