import React, { useState, useEffect } from 'react';
import StockCard, { MODE_BADGE } from './StockCard.jsx';
import { calc } from '../services/api.js';
import { f2, money } from '../services/utils.js';
import { getAuctionTier } from '../services/auction.js';

export default function ConsoleSection({
  pool,
  activeStockCode,
  totalAssets = 100000,
  tradeLogs = [],
  isTailAlertTime = false,
  simTailAlert = false,
  onSelectStock,
  onUpdateStock,
  onBuyStock,
  onRemoveStock,
  onAddBlank,
  onSaveLocal,
  onResetDefault,
  onRefresh,
  onOpenQuickT,
  onOpenReason,
  onRefreshSingle,
  onCopySinglePlan,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const [tierFilter, setTierFilter] = useState('all');
  const [internalActiveCode, setInternalActiveCode] = useState(() => (pool[0]?.code || ''));
  const [viewMode, setViewMode] = useState('single'); // 'single' (聚焦切换) | 'all' (全部平铺)

  // 资金防混淆隔离测算 (70% 底仓做T池 vs 30% 超短打板机动池)
  const totalAssetsNum = +totalAssets || 100000;
  const baseRatio = 0.70;
  const tacticalRatio = 0.30;
  const baseCapital = totalAssetsNum * baseRatio;
  const tacticalCapital = totalAssetsNum * tacticalRatio;

  const baseStocks = pool.filter(s => (s.tier === 'long' || s.poolTag === '稳健'));
  const tacticalStocks = pool.filter(s => (s.tier === 'short' || s.poolTag === '短线'));

  const baseMktVal = baseStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0);
  const tacticalMktVal = tacticalStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0);

  const baseCash = Math.max(0, baseCapital - baseMktVal);
  const tacticalCash = Math.max(0, tacticalCapital - tacticalMktVal);

  // 优先受控使用外部传入的 activeStockCode，否则使用内部 state
  const currentCode = (activeStockCode !== undefined) ? activeStockCode : internalActiveCode;

  const handleSelectCode = (code) => {
    if (onSelectStock) onSelectStock(code);
    setInternalActiveCode(code);
  };

  const filteredPool = pool.filter(s => {
    if (tierFilter === 'all') return true;
    const t = (s.tier === 'short' || s.tier === 'long') ? s.tier : (s.poolTag === '稳健' ? 'long' : 'short');
    return t === tierFilter;
  });

  const shortCnt = tacticalStocks.length;
  const longCnt = baseStocks.length;

  // 保证当前选中的股票在过滤后的列表中有效；若无效则自动降级到第一只
  const currentStock = filteredPool.find(s => s.code === currentCode) || filteredPool[0] || null;
  const currentActiveCode = currentStock ? currentStock.code : '';
  const currentIndex = currentStock ? filteredPool.findIndex(s => s.code === currentStock.code) : -1;

  // 当 pool 变化且当前选中不在池中时自动校准
  useEffect(() => {
    if (filteredPool.length > 0 && !filteredPool.some(s => s.code === currentCode)) {
      handleSelectCode(filteredPool[0].code);
    }
  }, [filteredPool, currentCode]);

  return (
    <section id="secPlan">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0 }}>二、决策引擎（自动算买卖点）</h2>
        <div style={{ fontSize: '12px', color: 'var(--sub)' }}>
          当前股池：<b>{pool.length}</b> 只股票（底仓做T <b>{longCnt}</b> 只 · 超短打板 <b>{shortCnt}</b> 只）
        </div>
      </div>

      {/* 🛡️ 资金风控隔离看板（底仓做T区 vs 超短打板机动区 · 严格防范资金混淆） */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '10px',
        marginBottom: '12px'
      }}>
        {/* 左卡：底仓做T专用资金池 */}
        <div
          style={{
            background: 'linear-gradient(180deg, #f0f7ff, #fff)',
            border: tierFilter === 'long' ? '2px solid #1677ff' : '1px solid #bae0ff',
            borderRadius: '10px',
            padding: '10px 14px',
            boxShadow: '0 1px 4px rgba(22, 119, 255, 0.08)',
            cursor: 'pointer',
            transition: 'all .2s'
          }}
          onClick={() => setTierFilter(tierFilter === 'long' ? 'all' : 'long')}
          title="点击仅查看底仓做T区股票（再次点击恢复查看全部）"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '15px' }}>🛡️</span>
              <b style={{ color: '#0958d9', fontSize: '13px' }}>底仓做T专用资金池 (70%)</b>
              <span style={{ fontSize: '10.5px', background: '#e6f4ff', color: '#1677ff', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                {longCnt} 只标的
              </span>
            </div>
            <span style={{ fontSize: '12px', fontWeight: 800, fontFamily: 'monospace', color: '#0958d9' }}>
              配额 ¥{money(baseCapital)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: 'var(--sub)', flexWrap: 'wrap' }}>
            <span>已用底仓: <b style={{ color: 'var(--text)', fontFamily: 'monospace' }}>¥{money(baseMktVal)}</b></span>
            <span>｜</span>
            <span>做T备用金: <b style={{ color: '#0958d9', fontFamily: 'monospace' }}>¥{money(baseCash)}</b></span>
          </div>
          <div style={{ fontSize: '11px', color: '#597ef7', marginTop: '4px', lineHeight: 1.4 }}>
            🎯 <b>纪律红线：</b>七底三仓专用，每天高抛低吸摊薄持仓成本，严禁挪作盘中追高！
          </div>
        </div>

        {/* 右卡：短线机动资金池 */}
        <div
          style={{
            background: 'linear-gradient(180deg, #fff7e6, #fff)',
            border: tierFilter === 'short' ? '2px solid #fa8c16' : '1px solid #ffd591',
            borderRadius: '10px',
            padding: '10px 14px',
            boxShadow: '0 1px 4px rgba(250, 140, 22, 0.08)',
            cursor: 'pointer',
            transition: 'all .2s'
          }}
          onClick={() => setTierFilter(tierFilter === 'short' ? 'all' : 'short')}
          title="点击仅查看短线机动区股票（再次点击恢复查看全部）"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '15px' }}>⚡</span>
              <b style={{ color: '#d46b08', fontSize: '13px' }}>短线机动资金池 (30%)</b>
              <span style={{ fontSize: '10.5px', background: '#fff2e8', color: '#d4380d', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                {shortCnt} 只标的
              </span>
            </div>
            <span style={{ fontSize: '12px', fontWeight: 800, fontFamily: 'monospace', color: '#d46b08' }}>
              配额 ¥{money(tacticalCapital)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: 'var(--sub)', flexWrap: 'wrap' }}>
            <span>机动持仓: <b style={{ color: 'var(--text)', fontFamily: 'monospace' }}>¥{money(tacticalMktVal)}</b></span>
            <span>｜</span>
            <span>可用机动金: <b style={{ color: '#d46b08', fontFamily: 'monospace' }}>¥{money(tacticalCash)}</b></span>
          </div>
          <div style={{ fontSize: '11px', color: '#cf1322', marginTop: '4px', lineHeight: 1.4 }}>
            ⚡ <b>纪律红线：</b>短线做T及冲板试错上限 ¥{money(tacticalCapital * 0.5)}，<b>严禁挪用底仓资金补仓加死码</b>！
          </div>
        </div>
      </div>

      {/* 顶部操作工具栏与分区切换按钮 */}
      <div className="actions" style={{ marginBottom: '10px' }}>
        <button className="primary" onClick={() => onRefresh(false)}>重新计算</button>
        <button onClick={onAddBlank}>＋ 手动新增空白行</button>
        <button onClick={onSaveLocal}>保存参数到本机</button>
        <button onClick={onResetDefault}>恢复默认数据</button>

        <span className="tier-bar" title="在界面上划分“底仓做T区”与“短线机动区”，严格防范资金混淆">
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'all' ? 'cur' : ''}`}
            onClick={() => setTierFilter('all')}
          >
            全部标的 <b>{pool.length}</b>
          </button>
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'long' ? 'cur' : ''}`}
            onClick={() => setTierFilter('long')}
            style={{ color: tierFilter === 'long' ? '#0958d9' : 'inherit' }}
          >
            🛡️ 底仓做T区 <b>{longCnt}</b>
          </button>
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'short' ? 'cur' : ''}`}
            onClick={() => setTierFilter('short')}
            style={{ color: tierFilter === 'short' ? '#d4380d' : 'inherit' }}
          >
            ⚡ 短线机动区 <b>{shortCnt}</b>
          </button>
        </span>
      </div>

      {/* 顶部股票切换条（列出所有股票，点击卡片切换） */}
      {filteredPool.length > 0 && (
        <div className="pool-tabs" id="poolTabs" style={{ margin: '0 0 10px', position: 'relative', top: 'auto' }}>
          <span className="pt-lab">切换股票：</span>
          <div className="pt-scroll">
            {filteredPool.map(s => {
              const isCur = s.code === currentActiveCode;
              const isShort = (s.tier === 'short' || s.poolTag === '短线');
              const pc = +s.prevClose || 0;
              const px = +s.price || pc;
              const open = +s.open || 0;
              const chg = pc ? ((px - pc) / pc) * 100 : 0;
              const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
              const c = calc(s);
              const mbd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;

              const openGap = (open > 0 && pc > 0) ? ((open - pc) / pc) * 100 : null;
              const aucTier = openGap != null ? getAuctionTier(openGap) : null;

              return (
                <div
                  key={s.code}
                  className={`pool-tab ${isCur && viewMode === 'single' ? 'cur' : ''}`}
                  data-tier={isShort ? 'short' : 'long'}
                  onClick={() => {
                    handleSelectCode(s.code);
                    setViewMode('single');
                  }}
                  title={`点击聚焦切换：${s.name} (${s.code})\n${isShort ? '【⚡ 短线机动标的】' : '【🛡️ 底仓做T区标的】'}\n现价: ¥${f2(px)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)\n当前建议: ${mbd[1]}`}
                >
                  <span className="pt-name">
                    <span style={{ fontSize: '10px', marginRight: '2px' }}>{isShort ? '⚡' : '🛡️'}</span>
                    {s.name}
                  </span>
                  <span className={`pt-px ${chgCls}`}>
                    {f2(px)} <span className="pt-chg">({chg >= 0 ? '+' : ''}{chg.toFixed(1)}%)</span>
                  </span>
                  <span className={`pt-badge ${mbd[0]}`}>{mbd[1]}</span>
                  {aucTier && (
                    <span
                      className="pt-auc-dot"
                      style={{ background: aucTier.color }}
                      title={`集合竞价开盘：${openGap >= 0 ? '+' : ''}${openGap.toFixed(2)}% (${aucTier.tag})`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* 全部平铺 / 单股聚焦切换 */}
          <div
            className={`pool-tab all ${viewMode === 'all' ? 'cur' : ''}`}
            onClick={() => setViewMode(v => v === 'all' ? 'single' : 'all')}
            title="切换单股聚焦与全部平铺模式"
          >
            {viewMode === 'all' ? '🔍 单股聚焦' : `🌐 全部平铺 (${filteredPool.length})`}
          </div>
        </div>
      )}

      {/* 说明提示条（完整展示，不被任何浮动层遮挡） */}
      <p className="hint" style={{ margin: '4px 0 12px', lineHeight: 1.6, fontSize: '12px', color: 'var(--mute)' }}>
        说明：输入框全部可改。<b>昨收 / 开 / 高 / 低 / 现价 / 分时均线 / 量比</b> 每日盘前或盘中更新；<b>MA5 / MA10 / MA20</b> 用于判定日线趋势方向（决定今天允许不允许做T）。
      </p>

      {/* 单股聚焦模式下的快速切换辅助栏 */}
      {viewMode === 'single' && currentStock && filteredPool.length > 1 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '7px 14px',
          marginBottom: '12px',
          background: 'var(--surface)',
          borderRadius: '9px',
          border: '1px solid var(--line)',
          fontSize: '12.5px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--sub)' }}>当前聚焦：</span>
            <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: '13.5px' }}>{currentStock.name}</span>
            <span style={{ fontFamily: 'ui-monospace,Consolas,monospace', color: 'var(--mute)' }}>{currentStock.code}</span>
            <span style={{
              fontSize: '11px',
              padding: '1px 6px',
              borderRadius: '4px',
              background: 'var(--surface2)',
              color: 'var(--sub)',
              fontWeight: 600
            }}>
              第 {currentIndex + 1} / {filteredPool.length} 只
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className="mini"
              disabled={currentIndex <= 0}
              onClick={() => {
                if (currentIndex > 0) handleSelectCode(filteredPool[currentIndex - 1].code);
              }}
              style={{ cursor: currentIndex <= 0 ? 'not-allowed' : 'pointer', opacity: currentIndex <= 0 ? 0.45 : 1 }}
              title="切换到上一只股票"
            >
              ◀ 上一只
            </button>
            <button
              className="mini"
              disabled={currentIndex >= filteredPool.length - 1}
              onClick={() => {
                if (currentIndex < filteredPool.length - 1) handleSelectCode(filteredPool[currentIndex + 1].code);
              }}
              style={{ cursor: currentIndex >= filteredPool.length - 1 ? 'not-allowed' : 'pointer', opacity: currentIndex >= filteredPool.length - 1 ? 0.45 : 1 }}
              title="切换到下一只股票"
            >
              下一只 ▶
            </button>
          </div>
        </div>
      )}

      {/* 股票决策卡片展示区 */}
      <div id="pool" data-view={viewMode === 'all' ? 'all' : 'one'}>
        {filteredPool.length > 0 ? (
          viewMode === 'all' ? (
            filteredPool.map((s) => (
              <StockCard
                key={s.code}
                stock={s}
                index={pool.indexOf(s)}
                isCur={true}
                tradeLogs={tradeLogs}
                isTailAlertTime={isTailAlertTime}
                simTailAlert={simTailAlert}
                onUpdateStock={onUpdateStock}
                onBuyStock={onBuyStock}
                onRemoveStock={onRemoveStock}
                onOpenQuickT={onOpenQuickT}
                onOpenReason={onOpenReason}
                onRefreshSingle={onRefreshSingle}
                onCopySinglePlan={onCopySinglePlan}
                fastRefresh={fastRefresh}
                onToggleFastRefresh={onToggleFastRefresh}
              />
            ))
          ) : (
            currentStock && (
              <StockCard
                key={currentStock.code}
                stock={currentStock}
                index={pool.indexOf(currentStock)}
                isCur={true}
                tradeLogs={tradeLogs}
                isTailAlertTime={isTailAlertTime}
                simTailAlert={simTailAlert}
                onUpdateStock={onUpdateStock}
                onBuyStock={onBuyStock}
                onRemoveStock={onRemoveStock}
                onOpenQuickT={onOpenQuickT}
                onOpenReason={onOpenReason}
                onRefreshSingle={onRefreshSingle}
                onCopySinglePlan={onCopySinglePlan}
                fastRefresh={fastRefresh}
                onToggleFastRefresh={onToggleFastRefresh}
              />
            )
          )
        ) : (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--mute)', background: 'var(--card)', borderRadius: '12px', border: '1px dashed var(--line)' }}>
            <h3>自选池是空的</h3>
            <p style={{ marginTop: '8px' }}>在上方输入股票代码（如 605128）或名称，点击「+ 添加」开始监控。</p>
          </div>
        )}
      </div>
    </section>
  );
}
