import React, { useState } from 'react';
import { f2, pct, money } from '../services/utils.js';
import { getTailBuyCandidates } from '../services/tail.js';

export default function TailSection({
  totalAssets,
  actives,
  onExecTailBuy,
  onExecTailExit
}) {
  const tenPctBudget = totalAssets * 0.10;
  const candidates = getTailBuyCandidates();

  const [inputPrices, setInputPrices] = useState({});
  const [inputQtys, setInputQtys] = useState({});

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isTailTime = (mins >= 870 && mins < 895); // 14:30 - 14:55
  const isExitTime = (mins >= 570 && mins < 600); // 09:30 - 10:00

  const handlePriceChange = (code, val) => {
    setInputPrices(prev => ({ ...prev, [code]: val }));
  };

  const handleQtyChange = (code, val) => {
    setInputQtys(prev => ({ ...prev, [code]: val }));
  };

  const handleBuy = (cand) => {
    const px = parseFloat(inputPrices[cand.code]) || cand.price;
    const qty = parseInt(inputQtys[cand.code], 10) || cand.recShares;
    onExecTailBuy(cand, px, qty);
  };

  return (
    <section id="secTailBuy" className="tail-section" style={{ marginTop: '20px' }}>
      <div className="tail-head-bar">
        <div className="thb-title">
          <span className="thb-icon">⚡</span>
          <h3>尾盘黑马 T+0 推荐（14:30~14:55 专属隔夜潜伏战法）</h3>
        </div>
        <div className="thb-sub">
          {isTailTime ? (
            <span className="tb-status-pill live">🟢 14:30-14:55 尾盘潜伏窗口生效中</span>
          ) : isExitTime ? (
            <span className="tb-status-pill live-sell">🚨 09:30-10:00 早盘强行冲高止盈窗口生效中</span>
          ) : (
            <span className="tb-status-pill idle">💡 盘中雷达监控中（每日 14:30 自动生成隔夜黑马）</span>
          )}
        </div>
      </div>

      <div className="tail-budget-strip">
        <span>当前总资产: <b>¥{Math.round(totalAssets).toLocaleString('zh-CN')}</b></span>
        <span>·</span>
        <span>10% 顶格潜伏预算: <b style={{ color: 'var(--accent)' }}>¥{Math.round(tenPctBudget).toLocaleString('zh-CN')}</b></span>
        <span>·</span>
        <span>策略纪律: <b>单票上限 10% ｜ 绝不过夜加仓，次日 10:00 前必平</b></span>
      </div>

      {/* 正在持仓中的隔夜标的 */}
      {actives && actives.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ fontSize: '13.5px', marginBottom: '8px', color: 'var(--up)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>🚨</span> 当前已有已建仓的隔夜标的（次日 09:30~10:00 必须平仓）：
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
            {actives.map(act => {
              const livePx = act.price || act.cost;
              const chg = act.cost > 0 ? ((livePx - act.cost) / act.cost) * 100 : 0;
              const pnl = (livePx - act.cost) * act.shares;

              return (
                <div key={act.id} className="card" style={{ padding: '12px 14px', borderLeft: '4px solid var(--accent)', background: 'var(--surface2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '15px' }}>{act.name} ({act.code})</span>
                    <span className="tag" style={{ background: '#fff' }}>隔夜持仓中</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px', marginBottom: '8px' }}>
                    <div>买入成本: <b>{f2(act.cost)}</b></div>
                    <div>持仓股数: <b>{act.shares}</b> 股</div>
                    <div>浮动盈亏: <b className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{money(pnl)} ({pct(chg)})</b></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px dashed var(--line)', paddingTop: '8px' }}>
                    <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>目标冲高位: {act.tp1 ? `${f2(act.tp1)} (+2.5%)` : '冲高 +2.5%'}</span>
                    <button
                      className="primary"
                      onClick={() => onExecTailExit(act, livePx)}
                      style={{ padding: '4px 12px', fontSize: '12px', borderRadius: '5px' }}
                    >
                      ⚡ 一键平仓出局
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 推荐候选卡片网格 */}
      <div className="tail-cards-grid">
        {candidates.map((cand, idx) => {
          const defaultPrice = inputPrices[cand.code] !== undefined ? inputPrices[cand.code] : cand.price;
          const defaultQty = inputQtys[cand.code] !== undefined ? inputQtys[cand.code] : cand.recShares;

          return (
            <div key={cand.code} className={`tail-cand-card ${cand.rankClass}`}>
              <div className="tcc-head">
                <span className="tcc-rank-badge">{cand.rankTitle}</span>
                <span className="tcc-name">{cand.name}</span>
                <span className="tcc-code">{cand.code}</span>
                <span className="tcc-score">量化 <b>{cand.score}</b> 分</span>
                <span className="tcc-verdict-pill">{cand.verdict}</span>
              </div>

              <div className="tcc-kpis">
                <div className="tcc-kpi-item">
                  <span className="k">潜伏参考价</span>
                  <span className="v num">{f2(cand.price)}</span>
                </div>
                <div className="tcc-kpi-item">
                  <span className="k">日内涨幅</span>
                  <span className="v num up">+{cand.chgPct.toFixed(2)}%</span>
                </div>
                {cand.limitRoom != null && (
                  <div className="tcc-kpi-item">
                    <span className="k">距涨停空间</span>
                    <span className="v num">{cand.limitRoom.toFixed(2)}%</span>
                  </div>
                )}
                <div className="tcc-kpi-item">
                  <span className="k">均线上运行</span>
                  <span className="v num">{cand.vwapOnline.toFixed(0)}%</span>
                </div>
                <div className="tcc-kpi-item">
                  <span className="k">14点后量比</span>
                  <span className="v num">{cand.volRatio.toFixed(2)}x</span>
                </div>
                <div className="tcc-kpi-item">
                  <span className="k">日内换手</span>
                  <span className="v num">{cand.turnover.toFixed(1)}%</span>
                </div>
              </div>

              <div className="tcc-sizing-box">
                <div className="tsb-title">🎯 仓位试算建议（按总资产 ¥{Math.round(totalAssets).toLocaleString('zh-CN')}）</div>
                <div className="tsb-content">
                  <div>· 顶格10%建议：<b>{cand.recShares}</b> 股（约 ¥{Math.round(cand.recShares * cand.price).toLocaleString('zh-CN')}，占 {cand.actualPct}%）</div>
                  <div>· 稳健半仓建议：<b>{cand.halfShares}</b> 股（约 ¥{Math.round(cand.halfShares * cand.price).toLocaleString('zh-CN')}）</div>
                  <div className="tsb-sub">
                    止盈目标：冲高 <b>{f2(cand.tp1)}</b> (+2.5%) 抛首份，<b>{f2(cand.tp2)}</b> (+4.5%) 全清 ｜ 止损线：<b>{f2(cand.stop)}</b> (-1.5%)
                  </div>
                </div>
              </div>

              <div className="tcc-reasons">
                <div className="tr-title">📌 核心量化入选逻辑与次日闭环预案</div>
                <ul>
                  {cand.whyReasons.map((reason, rIdx) => (
                    <li key={rIdx}>{reason}</li>
                  ))}
                </ul>
              </div>

              <div className="tcc-act-bar">
                <div className="tcc-inp-grp">
                  <label>买入价</label>
                  <input
                    type="number"
                    step="0.01"
                    value={defaultPrice}
                    onChange={e => handlePriceChange(cand.code, e.target.value)}
                    style={{ width: '80px', padding: '3px 6px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                  <span>元</span>
                </div>
                <div className="tcc-inp-grp">
                  <label>股数</label>
                  <input
                    type="number"
                    step="100"
                    value={defaultQty}
                    onChange={e => handleQtyChange(cand.code, e.target.value)}
                    style={{ width: '80px', padding: '3px 6px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                  <span>股</span>
                </div>
                <button
                  type="button"
                  className="btn-tb-buy"
                  onClick={() => handleBuy(cand)}
                >
                  🚀 一键执行尾盘潜伏建仓
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
