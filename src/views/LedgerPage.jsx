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
  tailActives,
  allowedCapPct,
  totalAssets,
  vaultStatus,
  onForceSyncVault,
  onRestoreVault,
  onOpenEodModal,
  todayArchived,
  onExport,
  onImportClick,
  onSelectStock,
  onJumpDiagnosis,
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
        tailActives={tailActives}
        allowedCapPct={allowedCapPct}
        totalAssets={totalAssets}
        vaultStatus={vaultStatus}
        onForceSyncVault={onForceSyncVault}
        onRestoreVault={onRestoreVault}
        onOpenEodModal={onOpenEodModal}
        todayArchived={todayArchived}
        onExport={onExport}
        onImportClick={onImportClick}
        onSelectStock={onSelectStock}
        onJumpDiagnosis={onJumpDiagnosis}
      />
    </div>
  );
}
