import React, { useState } from 'react';
import SelectionSection from '../components/SelectionSection.jsx';
import ConsoleSection from '../components/ConsoleSection.jsx';
import MarketSentimentBar from '../components/MarketSentimentBar.jsx';
import PreMarketPanel from '../components/PreMarketPanel.jsx';

/**
 * 做T决策台页面 (Trade Page)
 * 首屏优先展示分「实盘持仓 / 自选观察」的紧凑买卖点作战卡片，点击卡片再展开完整详情
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
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const [internalActiveCode, setInternalActiveCode] = useState(() => (pool[0]?.code || ''));
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

  const shortStocks = (pool || []).filter(s => s.tier === 'short' || s.hadPrevLimitUp);

  return (
    <div className="page-trade">
      {/* 🌡️ 全市场超短情绪温度计 & 炸板率风控总阀 */}
      <MarketSentimentBar onSentimentChange={setSentiment} />

      {/* 🌅 09:15-09:30 集合竞价速览条 & 持仓/自选盘前公告自动排雷 */}
      <PreMarketPanel
        pool={pool}
        onSelectStock={handleSelectStock}
        onJumpDiagnosis={onJumpDiagnosis}
        onNoticeRisksChange={setNoticeRisks}
      />

      {/* 决策引擎（分「实盘持仓」与「自选观察」紧凑买卖点卡片，点击再展开完整做T详情） */}
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
        tradeLogs={tradeLogs}
        isTailAlertTime={isTailAlertTime}
        simTailAlert={simTailAlert}
        onSelectStock={handleSelectStock}
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

      {/* 🔗 跨板块联动快捷入口条（起爆挖掘 / 连板天梯） */}
      <div style={{
        margin: '16px 0',
        padding: '11px 16px',
        borderRadius: '11px',
        background: 'linear-gradient(90deg, #18181b, #271b30)',
        border: '1px solid #3f3f46',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.08)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '16px' }}>🔗</span>
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#f87171' }}>
            跨板块战情联动：
          </span>
          <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
            从涨停天梯 / 起爆雷达一键纳入自选，或在上方任意卡片直达全景诊股与起爆体检
            {shortStocks.length > 0 && (
              <b style={{ color: '#fbbf24', marginLeft: '6px' }}>
                · 当前 {shortStocks.length} 只短线标的已联动次日卖出雷达
              </b>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <a
            href="#/ignition"
            style={{
              fontSize: '12px',
              color: '#fff',
              background: '#4f46e5',
              padding: '5px 12px',
              borderRadius: '7px',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            🚀 起爆挖掘 →
          </a>
          <a
            href="#/board"
            style={{
              fontSize: '12px',
              color: '#fff',
              background: '#cf1322',
              padding: '5px 12px',
              borderRadius: '7px',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            🔥 连板天梯 →
          </a>
        </div>
      </div>

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
