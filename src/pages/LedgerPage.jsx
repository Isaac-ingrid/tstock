import React from 'react';
import LedgerSection from '../components/LedgerSection.jsx';

/**
 * 📒 做T成交流水与纪律体检页面
 */
export default function LedgerPage({
  logs,
  onAddLog,
  onDeleteLog,
  pool,
  onExport,
  onImportClick
}) {
  return (
    <div className="page-ledger">
      <LedgerSection
        logs={logs}
        onAddLog={onAddLog}
        onDeleteLog={onDeleteLog}
        pool={pool}
        onExport={onExport}
        onImportClick={onImportClick}
      />
    </div>
  );
}
