import React, { useState } from 'react';
import SelectionSection from '../components/SelectionSection.jsx';
import ConsoleSection from '../components/ConsoleSection.jsx';
import MarketSentimentBar from '../components/MarketSentimentBar.jsx';
import PreMarketPanel from '../components/PreMarketPanel.jsx';

/**
 * 做T决策台页面 (Trade Page · Phase 3 紧凑量化工作台布局)
 * 顶排双栏等高遥测条（市场情绪总阀 + 盘前竞价与公告排雷），首屏直接顶起个股买卖点作战卡
 */
export default function TradePage({
  pool,
  tailActives = [],
  posRules = null,
  tiltState = null,
  onUpdatePosRules,
  onUnlockTilt,
  onRelockTilt,
  activeStockCode: externalActiveCode,
  onSelectStock: externalSelectStock,
  totalAssets = 100000,
  cash = 0,
  initialCapital = 100000,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
  wbLatest,
  dbStatus,
  tradeLogs = [],
  isTailAlertTime = false,
  simTailAlert = false,
  onAddStock,
  onBatchAdd,
  onOpenReason,
  onRefresh,
  onSelfTest,
  onJumpPerf,
  onUpdateStock,
  onBuyStock,
  onRemoveStock,
  onAddBlank,
  onSaveLocal,
  onResetDefault,
  onOpenQuickT,
  onRefreshSingle,
  onCopySinglePlan,
  onJumpDiagnosis,
  onJumpIgnition,
  onSentimentChange = null,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const [internalActiveCode, setInternalActiveCode] = useState(() => pool[0]?.code || '');
  const [sentiment, setSentiment] = useState(null);
  const [noticeRisks, setNoticeRisks] = useState({});
  const activeStockCode = externalActiveCode !== undefined ? externalActiveCode : internalActiveCode;
  const handleSelectStock = externalSelectStock || setInternalActiveCode;

  const handleReasonClick = (st, have) => {
    if (have && st.code) {
      handleSelectStock(String(st.code).padStart(6, '0'));
    }
    if (onOpenReason) {
      onOpenReason(st, have);
    }
  };

  return (
    <div className="page-trade">
      {/* 顶排双栏等高全局遥测带：左「超短情绪与炸板总阀」+ 右「集合竞价速览、节前窗口与公告排雷」 */}
      <div className="trade-telemetry-row">
        <MarketSentimentBar
          compact
          onSentimentChange={(s) => {
            setSentiment(s);
            if (onSentimentChange) onSentimentChange(s);
          }}
        />

        <PreMarketPanel
          pool={pool}
          onSelectStock={handleSelectStock}
          onJumpDiagnosis={onJumpDiagnosis}
          onNoticeRisksChange={setNoticeRisks}
        />
      </div>

      {/* 决策引擎（双轨资金/仓位水位条 + 实盘持仓与自选观察紧凑买卖点卡片） */}
      <ConsoleSection
        pool={pool}
        tailActives={tailActives}
        sentiment={sentiment}
        noticeRisks={noticeRisks}
        posRules={posRules}
        tiltState={tiltState}
        onUpdatePosRules={onUpdatePosRules}
        onUnlockTilt={onUnlockTilt}
        onRelockTilt={onRelockTilt}
        activeStockCode={activeStockCode}
        totalAssets={totalAssets}
        cash={cash}
        initialCapital={initialCapital}
        onUpdateTotalAssets={onUpdateTotalAssets}
        onUpdateCash={onUpdateCash}
        onUpdateInitialCapital={onUpdateInitialCapital}
        tradeLogs={tradeLogs}
        isTailAlertTime={isTailAlertTime}
        simTailAlert={simTailAlert}
        onSelectStock={handleSelectStock}
        onAddStock={onAddStock}
        onUpdateStock={onUpdateStock}
        onBuyStock={onBuyStock}
        onRemoveStock={onRemoveStock}
        onAddBlank={onAddBlank}
        onSaveLocal={onSaveLocal}
        onResetDefault={onResetDefault}
        onRefresh={onRefresh}
        onOpenQuickT={onOpenQuickT}
        onOpenReason={onOpenReason}
        onRefreshSingle={onRefreshSingle}
        onCopySinglePlan={onCopySinglePlan}
        onJumpDiagnosis={onJumpDiagnosis}
        onJumpIgnition={onJumpIgnition}
        fastRefresh={fastRefresh}
        onToggleFastRefresh={onToggleFastRefresh}
      />

      {/* 选股池与自选股录入区 */}
      <SelectionSection
        wbLatest={wbLatest}
        pool={pool}
        onAddStock={onAddStock}
        onSelectStock={handleSelectStock}
        onJumpDiagnosis={onJumpDiagnosis}
        onBatchAdd={onBatchAdd}
        onOpenReason={handleReasonClick}
        onRefresh={onRefresh}
        onSelfTest={onSelfTest}
        onJumpPerf={onJumpPerf}
        dbStatus={dbStatus}
      />
    </div>
  );
}
