import React, { useState } from 'react';
import { f2, pct, money } from '../services/utils.js';
import { getTailBuyCandidates } from '../services/tail.js';
import { runTailScan } from '../services/api.js';

export default function TailSection({
  totalAssets,
  actives,
  wbLatest,
  onExecTailBuy,
  onExecTailExit,
  onRefreshContract
}) {
  const tenPctBudget = totalAssets * 0.10;
  const candidates = getTailBuyCandidates(wbLatest);

  const [inputPrices, setInputPrices] = useState({});
  const [inputQtys, setInputQtys] = useState({});
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);

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

  const handleManualScan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanStatus({ type: 'info', text: '正在全市场实时抓取 5400+ 标的快照并计算 VWAP 均线承接…（约需 10~18 秒）' });
    try {
      const res = await runTailScan(true);
      if (res && res.ok) {
        setScanStatus({
          type: 'ok',
          text: `✅ 尾盘扫描完成！共精选出 ${res.count || 0} 只标的，契约已全量更新。`
        });
        if (onRefreshContract) {
          await onRefreshContract();
        }
      } else {
        setScanStatus({
          type: 'warn',
          text: res?.message || '尾盘扫描返回繁忙，请稍后刷新重试'
        });
      }
    } catch (err) {
      setScanStatus({
        type: 'err',
        text: `尾盘扫描失败：${err.message}`
      });
    } finally {
      setScanning(false);
    }
  };

  return (
    <section id="secTailBuy" className="tail-section" style={{ marginTop: '20px' }}>
      <div className="tail-head-bar">
        <div className="thb-title">
          <span className="thb-icon">⚡</span>
          <h3>尾盘黑马 T+0 推荐（14:30~14:55 专属隔夜潜伏战法）</h3>
        </div>
        <div className="thb-sub" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {isTailTime ? (
            <span className="tb-status-pill live">🟢 14:30-14:55 尾盘潜伏窗口生效中</span>
          ) : isExitTime ? (
            <span className="tb-status-pill live-sell">🚨 09:30-10:00 早盘强行冲高止盈窗口生效中</span>
          ) : (
            <span className="tb-status-pill idle">💡 盘中雷达监控中（每日 14:30 自动生成隔夜黑马）</span>
          )}

          {wbLatest?.tailMeta && (
            <span style={{ fontSize: '11.5px', color: 'var(--mute)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <span>🕒</span>
              <span>已更新: {wbLatest.tailMeta.date} {wbLatest.tailMeta.scanTime}</span>
            </span>
          )}

          <button
            type="button"
            onClick={handleManualScan}
            disabled={scanning}
            style={{
              padding: '3px 11px',
              fontSize: '11.5px',
              borderRadius: '5px',
              border: '1px solid var(--accent)',
              background: scanning ? 'var(--surface2)' : '#fff',
              color: 'var(--accent)',
              cursor: scanning ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontWeight: 600,
              transition: 'all .15s ease'
            }}
            title="手动触发全市场5000+标的实时选股扫描并更新契约"
          >
            <span style={{ display: 'inline-block', animation: scanning ? 'spin 1s linear infinite' : 'none' }}>⟳</span>
            <span>{scanning ? '正在全量重扫 5400+ 标的…' : '立即重扫今日尾盘黑马'}</span>
          </button>
        </div>
      </div>

      {scanStatus && (
        <div style={{
          marginTop: '8px',
          padding: '7px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          lineHeight: 1.5,
          background: scanStatus.type === 'ok' ? 'var(--down-bg)' : scanStatus.type === 'err' ? 'var(--up-bg)' : 'var(--info-bg)',
          color: scanStatus.type === 'ok' ? 'var(--down)' : scanStatus.type === 'err' ? 'var(--up)' : 'var(--accent)',
          border: `1px solid ${scanStatus.type === 'ok' ? 'var(--down-b)' : scanStatus.type === 'err' ? 'var(--up-b)' : 'var(--info-b)'}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>{scanStatus.text}</span>
          <button
            type="button"
            onClick={() => setScanStatus(null)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '14px', padding: '0 4px' }}
          >
            ×
          </button>
        </div>
      )}

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
        {candidates.length === 0 ? (
          <div style={{
            gridColumn: '1 / -1',
            padding: '36px 20px',
            textAlign: 'center',
            background: 'var(--surface2)',
            borderRadius: '9px',
            border: '1px dashed var(--line)',
            color: 'var(--sub)'
          }}>
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>🛡️</div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text)', marginBottom: '8px' }}>
              今日尾盘无符合硬闸门的黑马标的（宁缺毋滥）
            </div>
            <div style={{ fontSize: '12.5px', maxWidth: '560px', margin: '0 auto', lineHeight: 1.6, color: 'var(--mute)' }}>
              尾盘黑马战法遵循严格量化门槛（涨幅 3%~7%、量比 ≥ 1.2、分时均线上方占比 ≥ 80%、尾盘无高位跳水回落、排除创业板/ST）。
              市场缩量或弱势震荡时，不符合标准则坚决不推送，空仓防守胜过盲目追高。
            </div>
            <button
              type="button"
              onClick={handleManualScan}
              disabled={scanning}
              style={{
                marginTop: '16px',
                padding: '7px 18px',
                fontSize: '12.5px',
                fontWeight: 600,
                borderRadius: '6px',
                border: '1px solid var(--accent)',
                background: scanning ? 'var(--surface2)' : '#fff',
                color: 'var(--accent)',
                cursor: scanning ? 'not-allowed' : 'pointer'
              }}
            >
              {scanning ? '⏳ 正在全市场全量扫描…' : '⟳ 立即重新扫描全市场'}
            </button>
          </div>
        ) : (
          candidates.map((cand, idx) => {
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
          })
        )}
      </div>
    </section>
  );
}
