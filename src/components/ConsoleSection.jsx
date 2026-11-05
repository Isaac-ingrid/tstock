import React, { useState } from 'react';
import StockCard from './StockCard.jsx';

export default function ConsoleSection({
  pool,
  onUpdateStock,
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

  const filteredPool = pool.filter(s => {
    if (tierFilter === 'all') return true;
    const t = (s.tier === 'short' || s.tier === 'long') ? s.tier : (s.poolTag === '稳健' ? 'long' : 'short');
    return t === tierFilter;
  });

  const shortCnt = pool.filter(s => (s.tier === 'short' || s.poolTag === '短线')).length;
  const longCnt = pool.filter(s => (s.tier === 'long' || s.poolTag === '稳健')).length;

  return (
    <section id="secPlan">
      <h2>三、决策引擎（自动算买卖点）</h2>
      <div className="actions">
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

      <p className="hint">
        说明：输入框全部可改。昨收 / 开 / 高 / 低 / 现价 / 分时均线 / 量比 每日盘前或盘中更新；MA5 / MA10 / MA20 用于判定日线趋势方向（决定今天允许不允许做T）。
      </p>

      <div id="pool">
        {filteredPool.length > 0 ? (
          filteredPool.map((s, idx) => (
            <StockCard
              key={s.code || idx}
              stock={s}
              index={pool.indexOf(s)}
              onUpdateStock={onUpdateStock}
              onRemoveStock={onRemoveStock}
              onOpenQuickT={onOpenQuickT}
              onOpenReason={onOpenReason}
              onRefreshSingle={onRefreshSingle}
              onCopySinglePlan={onCopySinglePlan}
            />
          ))
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
