import React, { useState, useEffect } from 'react';
import StockCard, { MODE_BADGE } from './StockCard.jsx';
import { calc } from '../services/api.js';
import { f2 } from '../services/utils.js';
import { getAuctionTier } from '../services/auction.js';

export default function ConsoleSection({
  pool,
  activeStockCode,
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
  onCopySinglePlan
}) {
  const [tierFilter, setTierFilter] = useState('all');
  const [internalActiveCode, setInternalActiveCode] = useState(() => (pool[0]?.code || ''));
  const [viewMode, setViewMode] = useState('single'); // 'single' (聚焦切换) | 'all' (全部平铺)

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

  const shortCnt = pool.filter(s => (s.tier === 'short' || s.poolTag === '短线')).length;
  const longCnt = pool.filter(s => (s.tier === 'long' || s.poolTag === '稳健')).length;

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
          当前股池：<b>{pool.length}</b> 只股票 · 点击上方股票标签即可单卡聚焦切换
        </div>
      </div>

      {/* 顶部操作工具栏 */}
      <div className="actions" style={{ marginBottom: '10px' }}>
        <button className="primary" onClick={() => onRefresh(false)}>重新计算</button>
        <button onClick={onAddBlank}>＋ 手动新增空白行</button>
        <button onClick={onSaveLocal}>保存参数到本机</button>
        <button onClick={onResetDefault}>恢复默认数据</button>

        <span className="tier-bar" title="按持仓属性分组：短线做T / 长线底仓。分组只影响显示，不影响算法。">
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'all' ? 'cur' : ''}`}
            onClick={() => setTierFilter('all')}
          >
            全部 <b>{pool.length}</b>
          </button>
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'short' ? 'cur' : ''}`}
            onClick={() => setTierFilter('short')}
          >
            短线 <b>{shortCnt}</b>
          </button>
          <button
            type="button"
            className={`tier-btn ${tierFilter === 'long' ? 'cur' : ''}`}
            onClick={() => setTierFilter('long')}
          >
            长线 <b>{longCnt}</b>
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
                  title={`点击查看 ${s.name} (${s.code}) 决策卡片\n现价: ${f2(px)}  涨跌: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%\n${openGap != null ? `09:25 开盘跳空: ${openGap >= 0 ? '+' : ''}${openGap.toFixed(2)}% (${aucTier?.tag})\n` : ''}信号: ${mbd[1]}`}
                >
                  <span className={`tt ${isShort ? 't-short' : 't-long'}`}>{isShort ? '短' : '稳'}</span>
                  <span className="tn">{s.name}</span>
                  <span className={`pz ${chgCls}`}>{f2(px)}</span>
                  <span className={`pc ${chgCls}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
                  {aucTier && (
                    <span
                      className="tag"
                      style={{
                        fontSize: '10px',
                        padding: '1px 4px',
                        background: aucTier.bg,
                        color: aucTier.color,
                        borderColor: aucTier.color,
                        fontWeight: 700,
                        borderRadius: '3px'
                      }}
                    >
                      竞价{openGap >= 0 ? '+' : ''}{openGap.toFixed(1)}%
                    </span>
                  )}
                  <span className={`mg ${mbd[0]}`}>{mbd[1]}</span>
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
                onUpdateStock={onUpdateStock}
                onBuyStock={onBuyStock}
                onRemoveStock={onRemoveStock}
                onOpenQuickT={onOpenQuickT}
                onOpenReason={onOpenReason}
                onRefreshSingle={onRefreshSingle}
                onCopySinglePlan={onCopySinglePlan}
              />
            ))
          ) : (
            currentStock && (
              <StockCard
                key={currentStock.code}
                stock={currentStock}
                index={pool.indexOf(currentStock)}
                isCur={true}
                onUpdateStock={onUpdateStock}
                onBuyStock={onBuyStock}
                onRemoveStock={onRemoveStock}
                onOpenQuickT={onOpenQuickT}
                onOpenReason={onOpenReason}
                onRefreshSingle={onRefreshSingle}
                onCopySinglePlan={onCopySinglePlan}
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
