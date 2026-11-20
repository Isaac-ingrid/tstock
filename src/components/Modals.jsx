import React, { useState, useEffect } from 'react';
import { f2, money, getTodayTStatus, toastWarn } from '../services/utils.js';
import { calc } from '../services/api.js';
import { evaluateChannelHoldingDiscipline } from '../services/risk.js';

/* 1. 快捷记T弹窗（含单日防上头熔断锁保护：锁买不锁卖） */
export function QuickTModal({ modalData, tradeLogs = [], tiltState = null, onClose, onConfirm }) {
  if (!modalData || !modalData.open) return null;
  return (
    <QuickTModalInner
      modalData={modalData}
      tradeLogs={tradeLogs}
      tiltState={tiltState}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

function QuickTModalInner({ modalData, tradeLogs = [], tiltState = null, onClose, onConfirm }) {
  const stock = modalData.stock || {};
  const todayT = getTodayTStatus(stock, tradeLogs);
  const { defaultDir, defaultPx, defaultQty } = modalData;
  const totalHeld = stock.shares || 0;
  const isTiltLocked = Boolean(tiltState?.isLocked);

  const rawInitSell = defaultDir === '直接卖出' || defaultDir === '卖出';
  const rawInitBuy = defaultDir === '直接买入' || defaultDir === '买入' || defaultDir === '买入建仓' || defaultDir === '买入加仓';

  const resolvedInitDir = (() => {
    if (rawInitSell) return '直接卖出';
    if (isTiltLocked) {
      return totalHeld > 0 ? '直接卖出' : '倒T';
    }
    if (rawInitBuy) return '直接买入';
    return defaultDir || '正T';
  })();

  const [dir, setDir] = useState(resolvedInitDir);

  const isInitSell = resolvedInitDir === '直接卖出';
  const isInitBuy = resolvedInitDir === '直接买入';

  const initCostPx = stock.cost ? String(stock.cost) : (stock.price ? String(stock.price) : '');
  const initSellPx = defaultPx || stock.price || '';

  const [buyPx, setBuyPx] = useState(
    isInitSell
      ? initCostPx
      : resolvedInitDir === '正T' || isInitBuy
        ? (defaultPx || stock.price)
        : ((+stock.price || 0) * 0.98).toFixed(2)
  );
  const [sellPx, setSellPx] = useState(
    isInitSell
      ? initSellPx
      : resolvedInitDir === '正T'
        ? ((+stock.price || 0) * 1.02).toFixed(2)
        : (defaultPx || stock.price)
  );
  const [qty, setQty] = useState(
    defaultQty !== undefined
      ? defaultQty
      : isInitSell
        ? (todayT.sellableShares > 0 ? todayT.sellableShares : 100)
        : (isInitBuy && totalHeld > 0 ? 500 : 100)
  );

  let c = null;
  try { c = calc(stock); } catch (_) {}
  const channelDisc = evaluateChannelHoldingDiscipline(stock, {
    tradeLogs,
    mktLevel: c?.mktLevel || '',
  });

  const b = parseFloat(buyPx) || 0;
  const s = parseFloat(sellPx) || 0;
  const q = parseInt(qty, 10) || 0;

  const isDirectSell = dir === '直接卖出' || dir === '卖出';
  const isDirectBuy = dir === '直接买入' || dir === '买入' || dir === '买入建仓' || dir === '买入加仓';
  const isLockedAction = isTiltLocked && (isDirectBuy || dir === '正T');

  // 正T/倒T 套利计算
  const grossDiff = (s - b) * q;
  const feeT = (b * q + s * q) * 0.0011;
  const netDiffT = grossDiff - feeT;
  const spreadPct = b > 0 ? ((s - b) / b) * 100 : 0;
  const newCostT = totalHeld > 0 ? ((stock.cost * totalHeld - netDiffT) / totalHeld) : 0;
  const costDropT = stock.cost > 0 && newCostT > 0 ? (stock.cost - newCostT) : 0;

  // 直接买入 / 建仓 / 加仓计算
  const buyAmt = b * q;
  const feeBuy = buyAmt * 0.0003;
  const newHeldBuy = totalHeld + q;
  const newWeightedCostBuy = newHeldBuy > 0
    ? Math.round(((totalHeld * (+stock.cost || 0) + buyAmt) / newHeldBuy) * 100) / 100
    : b;
  const costDiffBuy = totalHeld > 0 ? (newWeightedCostBuy - (+stock.cost || 0)) : 0;

  // 直接卖出 / 减仓 / 清仓计算
  const sellAmt = s * q;
  const feeSell = sellAmt * 0.0011;
  const netCash = sellAmt - feeSell;
  const costBasis = (b > 0 ? b : (+stock.cost || s)) * q;
  const netProfitSell = netCash - costBasis;
  const profitRateSell = costBasis > 0 ? (netProfitSell / costBasis) * 100 : 0;
  const remainingShares = Math.max(0, totalHeld - q);

  const handleConfirm = () => {
    if (isLockedAction) {
      toastWarn('🔒 单日防上头熔断保护中：已锁定买入与正T低吸，仅允许记录卖出减仓或倒T高抛');
      return;
    }

    if (isDirectBuy) {
      if (b <= 0 || q <= 0) {
        alert('请输入正确的买入价格与股数');
        return;
      }
      if (totalHeld > 0 && channelDisc?.forbidAddPosition) {
        if (!window.confirm(`${channelDisc.forbidReason}\n\n确定仍要强行逆势补仓（将自动记入复盘违规审计）吗？`)) {
          return;
        }
      } else if (totalHeld > 0 && channelDisc?.warn3Red) {
        if (!window.confirm(`${channelDisc.warn3RedReason}\n\n确定仍要在连红高潮区继续加仓吗？`)) {
          return;
        }
      }
      onConfirm({
        stock,
        action: 'buy',
        dir: totalHeld > 0 ? '买入加仓' : '买入建仓',
        buy: b,
        qty: q,
        newShares: newHeldBuy,
        newCost: newWeightedCostBuy
      });
      return;
    }

    if (isDirectSell) {
      if (s <= 0 || q <= 0) {
        alert('请输入正确的卖出价格与股数');
        return;
      }
      if (totalHeld > 0 && todayT.sellableShares <= 0) {
        alert(`受 A 股 T+1 交易制度限制，【${stock.name || stock.code}】当前持仓均系今日新买入，今日可用可卖股数为 0！明日开盘后才可卖出。`);
        return;
      }
      if (totalHeld > 0 && q > todayT.sellableShares) {
        if (!window.confirm(`当前可用可卖底仓为 ${todayT.sellableShares} 股（其余 ${todayT.t1LockedShares} 股系今日新买受 T+1 锁仓），卖出股数 (${q} 股) 超出今日可卖额度，确定继续吗？`)) {
          return;
        }
      }
      const isFullExit = totalHeld > 0 && q >= totalHeld;
      onConfirm({
        stock,
        dir: isFullExit ? '清仓卖出' : '直接卖出',
        action: 'sell',
        buy: b || stock.cost || 0,
        sell: s,
        qty: q,
        netDiff: netProfitSell,
        remainingShares
      });
    } else {
      if (b <= 0 || s <= 0 || q <= 0) {
        alert('请输入正确的买卖价格与股数');
        return;
      }
      onConfirm({
        stock,
        dir,
        action: 't',
        buy: b,
        sell: s,
        qty: q,
        netDiff: netDiffT,
        newCost: newCostT
      });
    }
  };

  const suggestTQty = Math.max(
    100,
    Math.floor(((todayT.sellableShares || totalHeld || 300) * 0.3) / 100) * 100
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box quickt-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '470px' }}>
        <div className="modal-hd">
          <h3>
            {isDirectBuy ? '📥 记录买入 / 加仓' : isDirectSell ? '📤 记录直接卖出 / 减仓' : '⚡ 闪电记T'} · {stock.name} ({stock.code})
          </h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd">
          {isTiltLocked && (
            <div style={{
              padding: '8px 11px',
              marginBottom: '12px',
              borderRadius: '7px',
              background: '#fef2f2',
              border: '1px solid #f87171',
              color: '#991b1b',
              fontSize: '11.5px',
              lineHeight: 1.5
            }}>
              <b>🛑 单日防上头熔断保护中：</b>{(tiltState?.reasons || []).join('；')}。
              <br />
              系统已自动锁定「🟢 正T」与「📥 买入」，<b>「📤 卖出(减/清)」与「🔴 倒T高抛」保持畅通</b>。
            </div>
          )}

          {!isTiltLocked && (isDirectBuy || dir === '正T') && (channelDisc?.forbidAddPosition || channelDisc?.warn3Red) && (
            <div style={{
              padding: '8px 11px',
              marginBottom: '12px',
              borderRadius: '7px',
              background: channelDisc.forbidAddPosition ? '#fef2f2' : '#fff7ed',
              border: `1px solid ${channelDisc.forbidAddPosition ? '#f87171' : '#fb923c'}`,
              color: channelDisc.forbidAddPosition ? '#991b1b' : '#9a3412',
              fontSize: '11.5px',
              lineHeight: 1.55
            }}>
              <b>{channelDisc.forbidAddPosition ? '🩸 浮亏逆势补仓高危拦截：' : '🔥 弱势连红 3 天止盈提醒：'}</b>
              {channelDisc.forbidAddPosition ? channelDisc.forbidReason : channelDisc.warn3RedReason}
            </div>
          )}

          {/* 四向操作选项卡（窄屏下自动切换为 2×2 大拇指网格） */}
          <div className="modal-dir-tabs qt-dir-tabs" style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
            <button
              type="button"
              className={`m-dir-btn ${dir === '正T' ? 'active' : ''}`}
              style={{
                flex: 1, padding: '7px 0', borderRadius: '7px', fontWeight: 700, fontSize: '12px',
                border: '1px solid', borderColor: dir === '正T' ? 'var(--down)' : 'var(--line)',
                background: dir === '正T' ? 'var(--down-bg)' : '#fff',
                color: dir === '正T' ? 'var(--down)' : 'var(--sub)',
                opacity: isTiltLocked ? 0.55 : 1
              }}
              onClick={() => {
                setDir('正T');
                setBuyPx(stock.price ? String(stock.price) : '');
                setSellPx(((+stock.price || 0) * 1.02).toFixed(2));
              }}
            >
              {isTiltLocked ? '🔒 正T' : '🟢 正T'}
            </button>
            <button
              type="button"
              className={`m-dir-btn ${dir === '倒T' ? 'active' : ''}`}
              style={{
                flex: 1, padding: '7px 0', borderRadius: '7px', fontWeight: 700, fontSize: '12px',
                border: '1px solid', borderColor: dir === '倒T' ? 'var(--up)' : 'var(--line)',
                background: dir === '倒T' ? 'var(--up-bg)' : '#fff',
                color: dir === '倒T' ? 'var(--up)' : 'var(--sub)'
              }}
              onClick={() => {
                setDir('倒T');
                setSellPx(stock.price ? String(stock.price) : '');
                setBuyPx(((+stock.price || 0) * 0.98).toFixed(2));
              }}
            >
              🔴 倒T
            </button>
            <button
              type="button"
              className={`m-dir-btn ${isDirectBuy ? 'active' : ''}`}
              style={{
                flex: 1.15, padding: '7px 0', borderRadius: '7px', fontWeight: 700, fontSize: '12px',
                border: '1px solid', borderColor: isDirectBuy ? '#1677ff' : 'var(--line)',
                background: isDirectBuy ? '#e6f4ff' : '#fff',
                color: isDirectBuy ? '#1677ff' : 'var(--sub)',
                opacity: isTiltLocked ? 0.55 : 1
              }}
              onClick={() => {
                setDir('直接买入');
                if (stock.price) setBuyPx(String(stock.price));
                if (!qty || qty <= 0) setQty(totalHeld > 0 ? 500 : 1000);
              }}
            >
              {isTiltLocked ? '🔒 禁买' : '📥 买入 (建/加)'}
            </button>
            <button
              type="button"
              className={`m-dir-btn ${isDirectSell ? 'active' : ''}`}
              style={{
                flex: 1.15, padding: '7px 0', borderRadius: '7px', fontWeight: 700, fontSize: '12px',
                border: '1px solid', borderColor: isDirectSell ? '#cf1322' : 'var(--line)',
                background: isDirectSell ? '#fff1f0' : '#fff',
                color: isDirectSell ? '#cf1322' : 'var(--sub)'
              }}
              onClick={() => {
                setDir('直接卖出');
                setQty(todayT.sellableShares > 0 ? todayT.sellableShares : 0);
                if (stock.price) setSellPx(String(stock.price));
                if (stock.cost) setBuyPx(String(stock.cost));
              }}
            >
              📤 卖出 (减/清)
            </button>
          </div>

          {isDirectBuy ? (
            /* ===== 直接买入 (建仓 / 加仓) 界面 ===== */
            <div>
              <div style={{
                padding: '8px 12px', background: 'var(--surface2)', borderRadius: '7px',
                fontSize: '12px', marginBottom: '12px', color: 'var(--sub)', lineHeight: 1.6
              }}>
                {totalHeld > 0 ? (
                  <>
                    💼 当前持仓: <b>{totalHeld} 股</b> ｜ 成本均价: <b>¥{f2(stock.cost || 0)}</b> ｜ 市值: <b>¥{money(totalHeld * (+stock.price || 0))}</b>
                    <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '2px' }}>
                      💡 买入后系统将自动进行加权平均计算，扣减可用现金并实时更新持仓均价。
                    </div>
                  </>
                ) : (
                  <>
                    💼 当前持仓: <b>0 股（空仓待建仓）</b>
                    <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '2px' }}>
                      🎯 录入首次买入成交价与买入股数，确认后直接生成该标的初始底仓并扣减现金。
                    </div>
                  </>
                )}
              </div>

              <div className="qt-price-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div className="fld">
                  <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>买入成交价 (元)</span>
                  </label>
                  <input
                    type="number" inputMode="decimal" step="0.01" value={buyPx}
                    onChange={e => setBuyPx(e.target.value)}
                    placeholder="买入价"
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div className="qt-quick-chips">
                    {stock.price ? (
                      <button
                        type="button"
                        className="qt-chip"
                        onClick={() => setBuyPx(String(stock.price))}
                      >
                        现价 {f2(stock.price)}
                      </button>
                    ) : null}
                    {c && c.inA > 0 ? (
                      <button
                        type="button"
                        className="qt-chip buy"
                        onClick={() => setBuyPx(f2(c.inA))}
                      >
                        低吸 {f2(c.inA)}
                      </button>
                    ) : null}
                    {stock.prevClose ? (
                      <button
                        type="button"
                        className="qt-chip"
                        onClick={() => setBuyPx(f2(stock.prevClose))}
                      >
                        昨收 {f2(stock.prevClose)}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="fld">
                  <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>买入股数 (股)</span>
                    <span style={{ color: 'var(--sub)' }}>{totalHeld > 0 ? `已有:${totalHeld}` : '建仓'}</span>
                  </label>
                  <input
                    type="number" inputMode="numeric" step="100" value={qty}
                    onChange={e => setQty(e.target.value)}
                    placeholder="买入股数"
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div className="qt-quick-chips">
                    {(totalHeld > 0 ? [100, 500, 1000] : [500, 1000, 2000]).map(n => (
                      <button
                        key={n}
                        type="button"
                        className="qt-chip"
                        onClick={() => setQty(n)}
                      >
                        +{n}
                      </button>
                    ))}
                    {totalHeld > 0 && (
                      <button
                        type="button"
                        className="qt-chip"
                        onClick={() => setQty(totalHeld)}
                      >
                        +1倍仓
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 实时买入/加仓试算面板 */}
              <div style={{
                padding: '10px 14px', background: '#f0f5ff', border: '1px solid #adc6ff',
                borderRadius: '8px', fontSize: '12.5px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--sub)' }}>动用成交金额:</span>
                  <b style={{ fontFamily: 'monospace' }}>¥{money(buyAmt)}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--sub)' }}>预估买入佣金 (万3):</span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--mute)' }}>¥{f2(feeBuy)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--sub)' }}>买入后总持仓:</span>
                  <b style={{ fontFamily: 'monospace', color: '#1677ff' }}>{newHeldBuy} 股 {totalHeld > 0 ? `(+${q}股)` : ''}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                  <span style={{ color: 'var(--sub)' }}>买入后成本均价:</span>
                  <div>
                    <b style={{ fontSize: '14px', fontFamily: 'monospace', color: 'var(--accent)' }}>¥{f2(newWeightedCostBuy)}</b>
                    {totalHeld > 0 && (
                      <span style={{
                        fontSize: '11px', marginLeft: '6px', fontWeight: 600,
                        color: costDiffBuy <= 0 ? 'var(--down)' : 'var(--up)'
                      }}>
                        ({costDiffBuy <= 0 ? `摊薄 -¥${Math.abs(costDiffBuy).toFixed(2)}` : `抬高 +¥${costDiffBuy.toFixed(2)}`} / 股)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : isDirectSell ? (
            /* ===== 直接卖出界面 ===== */
            <div>
              <div style={{
                padding: '8px 12px', background: todayT.sellableShares <= 0 && totalHeld > 0 ? '#fff1f0' : 'var(--surface2)',
                border: todayT.sellableShares <= 0 && totalHeld > 0 ? '1px solid #ffa39e' : 'none',
                borderRadius: '7px', fontSize: '12px', marginBottom: '12px', color: 'var(--sub)', lineHeight: 1.6
              }}>
                💼 当前总持仓: <b>{totalHeld} 股</b> ｜ <b>今日可卖: <span style={{ color: todayT.sellableShares > 0 ? '#1677ff' : '#cf1322' }}>{todayT.sellableShares} 股</span></b>
                {todayT.t1LockedShares > 0 && (
                  <span style={{ color: '#64748b', marginLeft: '6px' }}>(含 T+1 今日新买锁仓 {todayT.t1LockedShares} 股)</span>
                )}
                <div style={{ fontSize: '11px', color: todayT.sellableShares <= 0 && totalHeld > 0 ? '#cf1322' : 'var(--mute)', marginTop: '2px', fontWeight: todayT.sellableShares <= 0 && totalHeld > 0 ? 700 : 400 }}>
                  {todayT.sellableShares <= 0 && totalHeld > 0
                    ? '🔒 受 A 股 T+1 制度限制：今日新买入股份当日无法卖出，需待明日开盘解锁！'
                    : '确认卖出后将直接扣减可用底仓并回笼现金。若全卖则自动完成清仓。'}
                </div>
              </div>

              <div className="qt-price-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div className="fld">
                  <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>卖出成交价 (元)</span>
                  </label>
                  <input
                    type="number" inputMode="decimal" step="0.01" value={sellPx}
                    onChange={e => setSellPx(e.target.value)}
                    placeholder="卖出价"
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div className="qt-quick-chips">
                    {stock.price ? (
                      <button
                        type="button"
                        className="qt-chip"
                        onClick={() => setSellPx(String(stock.price))}
                      >
                        现价 {f2(stock.price)}
                      </button>
                    ) : null}
                    {+stock.cost > 0 ? (
                      <button
                        type="button"
                        className="qt-chip"
                        onClick={() => setSellPx(String(stock.cost))}
                      >
                        保本 {f2(stock.cost)}
                      </button>
                    ) : null}
                    {c && c.tp1 ? (
                      <button
                        type="button"
                        className="qt-chip sell"
                        onClick={() => setSellPx(f2(c.tp1))}
                      >
                        T1 {f2(c.tp1)}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="fld">
                  <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>买入成本价 (元)</span>
                  </label>
                  <input
                    type="number" inputMode="decimal" step="0.01" value={buyPx}
                    onChange={e => setBuyPx(e.target.value)}
                    placeholder="底仓成本"
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
                    作为盈亏核算基准
                  </div>
                </div>
              </div>

              <div className="fld" style={{ marginBottom: '14px' }}>
                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>卖出股数 (股)</span>
                  <span style={{ color: todayT.sellableShares > 0 ? 'var(--sub)' : '#cf1322', fontWeight: todayT.sellableShares > 0 ? 400 : 700 }}>
                    今日可用可卖: {todayT.sellableShares} 股
                  </span>
                </label>
                <input
                  type="number" inputMode="numeric" step="100" value={qty}
                  onChange={e => setQty(e.target.value)}
                  style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                />
                <div className="qt-quick-chips" style={{ marginTop: '6px' }}>
                  {todayT.sellableShares > 0 && (
                    <button
                      type="button"
                      className="qt-chip sell"
                      onClick={() => setQty(todayT.sellableShares)}
                    >
                      全卖可用 ({todayT.sellableShares}股)
                    </button>
                  )}
                  {todayT.sellableShares >= 200 && (
                    <button
                      type="button"
                      className="qt-chip"
                      onClick={() => setQty(Math.floor(todayT.sellableShares / 200) * 100)}
                    >
                      卖半仓 ({Math.floor(todayT.sellableShares / 200) * 100}股)
                    </button>
                  )}
                  <button
                    type="button"
                    className="qt-chip"
                    onClick={() => setQty(100)}
                  >
                    1手 (100股)
                  </button>
                  {c && c.t1Lots && c.t1Lots !== 100 && (
                    <button
                      type="button"
                      className="qt-chip"
                      onClick={() => setQty(c.t1Lots)}
                    >
                      建议T仓 ({c.t1Lots}股)
                    </button>
                  )}
                </div>
              </div>

              {/* 实时盈亏结算试算 */}
              <div className="quickt-preview" style={{ background: 'var(--surface2)', padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px', lineHeight: 1.7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>卖出成交总额:</span>
                  <b>¥{money(sellAmt)} 元</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>扣除规费与摩擦 (0.11%):</span>
                  <span style={{ color: 'var(--sub)' }}>−{feeSell.toFixed(2)} 元</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>回笼可用现金:</span>
                  <b style={{ color: 'var(--accent)' }}>¥{money(netCash)} 元</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed var(--line)', paddingTop: '4px', marginTop: '4px', flexWrap: 'wrap', gap: '4px' }}>
                  <b>本次实际落袋净盈亏:</b>
                  <b className={netProfitSell >= 0 ? 'up' : 'down'} style={{ fontSize: '14.5px' }}>
                    {netProfitSell >= 0 ? '+' : ''}{money(netProfitSell)} 元 ({profitRateSell >= 0 ? '+' : ''}{profitRateSell.toFixed(2)}%)
                  </b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '3px' }}>
                  <span>卖出后剩余持仓:</span>
                  <b style={{ color: remainingShares === 0 ? '#cf1322' : 'var(--text)' }}>
                    {remainingShares === 0 ? '全部清仓（持仓归零）' : `${remainingShares} 股`}
                  </b>
                </div>
              </div>
            </div>
          ) : (
            /* ===== 正T / 倒T 界面（补齐移动端一键点位与仓位筹码，免手敲数字） ===== */
            <div>
              <div className="qt-price-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div className="fld">
                  <label>买入成交价 (元)</label>
                  <input
                    type="number" inputMode="decimal" step="0.01" value={buyPx}
                    onChange={e => setBuyPx(e.target.value)}
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div className="qt-quick-chips">
                    {stock.price ? (
                      <button type="button" className="qt-chip" onClick={() => setBuyPx(f2(stock.price))}>
                        现价 {f2(stock.price)}
                      </button>
                    ) : null}
                    {c && c.inA > 0 ? (
                      <button type="button" className="qt-chip buy" onClick={() => setBuyPx(f2(c.inA))}>
                        低吸1 {f2(c.inA)}
                      </button>
                    ) : null}
                    {c && c.inB > 0 ? (
                      <button type="button" className="qt-chip buy" onClick={() => setBuyPx(f2(c.inB))}>
                        低吸2 {f2(c.inB)}
                      </button>
                    ) : null}
                    {+stock.avg > 0 ? (
                      <button type="button" className="qt-chip" onClick={() => setBuyPx(f2(stock.avg))}>
                        均价 {f2(stock.avg)}
                      </button>
                    ) : null}
                    {dir === '倒T' && s > 0 ? (
                      <button type="button" className="qt-chip buy" onClick={() => setBuyPx(f2(s * 0.985))}>
                        -1.5% {f2(s * 0.985)}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="fld">
                  <label>卖出成交价 (元)</label>
                  <input
                    type="number" inputMode="decimal" step="0.01" value={sellPx}
                    onChange={e => setSellPx(e.target.value)}
                    style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                  <div className="qt-quick-chips">
                    {stock.price ? (
                      <button type="button" className="qt-chip" onClick={() => setSellPx(f2(stock.price))}>
                        现价 {f2(stock.price)}
                      </button>
                    ) : null}
                    {c && c.outA > 0 ? (
                      <button type="button" className="qt-chip sell" onClick={() => setSellPx(f2(c.outA))}>
                        高抛1 {f2(c.outA)}
                      </button>
                    ) : null}
                    {c && c.tp1 > 0 ? (
                      <button type="button" className="qt-chip sell" onClick={() => setSellPx(f2(c.tp1))}>
                        止盈1 {f2(c.tp1)}
                      </button>
                    ) : null}
                    {dir === '正T' && b > 0 ? (
                      <button type="button" className="qt-chip sell" onClick={() => setSellPx(f2(b * 1.015))}>
                        +1.5% {f2(b * 1.015)}
                      </button>
                    ) : null}
                    {+stock.bePrice > 0 ? (
                      <button type="button" className="qt-chip" onClick={() => setSellPx(f2(stock.bePrice))}>
                        保本 {f2(stock.bePrice)}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {todayT.isFirstDayLocked && (
                <div style={{ padding: '7px 10px', marginBottom: '10px', borderRadius: '6px', background: '#fffbe6', border: '1px solid #ffe58f', color: '#d46b08', fontSize: '11.5px', fontWeight: 600 }}>
                  🔒 T+1 提示：该股当前持仓全为今日新买入（今日可卖底仓 0 股），当日无法完成成对做T（正T/倒T），仅适合补录历史对倒流水或明日再做T！
                </div>
              )}
              <div className="fld" style={{ marginBottom: '14px' }}>
                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>成交股数</span>
                  <span style={{ color: 'var(--sub)' }}>建议T仓: {suggestTQty} 股</span>
                </label>
                <input
                  type="number" inputMode="numeric" step="100" value={qty}
                  onChange={e => setQty(e.target.value)}
                  style={{ width: '100%', minHeight: '34px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                />
                <div className="qt-quick-chips" style={{ marginTop: '6px' }}>
                  <button
                    type="button"
                    className="qt-chip accent"
                    onClick={() => setQty(suggestTQty)}
                  >
                    建议T仓 ({suggestTQty})
                  </button>
                  <button type="button" className="qt-chip" onClick={() => setQty(100)}>
                    100股
                  </button>
                  <button type="button" className="qt-chip" onClick={() => setQty(500)}>
                    500股
                  </button>
                  {todayT.sellableShares >= 200 && (
                    <button
                      type="button"
                      className="qt-chip"
                      onClick={() => setQty(Math.floor(todayT.sellableShares / 200) * 100)}
                    >
                      半仓 ({Math.floor(todayT.sellableShares / 200) * 100})
                    </button>
                  )}
                  {todayT.sellableShares > 0 && (
                    <button
                      type="button"
                      className="qt-chip"
                      onClick={() => setQty(todayT.sellableShares)}
                    >
                      全可用 ({todayT.sellableShares})
                    </button>
                  )}
                </div>
              </div>

              <div className="quickt-preview" style={{ background: 'var(--surface2)', padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px', lineHeight: 1.7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>单笔差价毛利:</span>
                  <b className={grossDiff >= 0 ? 'up' : 'down'}>{grossDiff >= 0 ? '+' : ''}{money(grossDiff)} 元 ({spreadPct >= 0 ? '+' : ''}{spreadPct.toFixed(2)}%)</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>扣除规费与摩擦 (0.11%):</span>
                  <span style={{ color: 'var(--sub)' }}>−{feeT.toFixed(2)} 元</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed var(--line)', paddingTop: '4px', marginTop: '4px' }}>
                  <b>本次净套利差额:</b>
                  <b className={netDiffT >= 0 ? 'up' : 'down'} style={{ fontSize: '14px' }}>{netDiffT >= 0 ? '+' : ''}{money(netDiffT)} 元</b>
                </div>
                {totalHeld > 0 ? (
                  <div style={{ color: 'var(--accent)', marginTop: '4px' }}>
                    💡 摊薄后底仓成本：{stock.cost} → <b>{f2(newCostT)}</b> 元 ({costDropT >= 0 ? `成本下降 ${costDropT.toFixed(2)} 元` : `成本上升 ${Math.abs(costDropT).toFixed(2)} 元`})
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>
            取消
          </button>
          <button
            className="primary"
            onClick={handleConfirm}
            disabled={isLockedAction}
            style={{
              padding: '6px 18px',
              borderRadius: '6px',
              background: isLockedAction
                ? '#fee2e2'
                : isDirectBuy
                ? '#1677ff'
                : isDirectSell
                ? '#cf1322'
                : 'var(--accent)',
              color: isLockedAction ? '#991b1b' : '#fff',
              border: isLockedAction ? '1px solid #fca5a5' : 'none',
              fontWeight: 700,
              cursor: isLockedAction ? 'not-allowed' : 'pointer'
            }}
          >
            {isLockedAction
              ? '🔒 熔断期已锁定买单'
              : isDirectBuy
              ? (totalHeld > 0 ? '📥 确认买入加仓' : '📥 确认买入建仓')
              : isDirectSell
              ? (totalHeld > 0 && q >= totalHeld ? '🔴 确认全部清仓卖出' : '🔴 确认直接卖出')
              : '确认记入台账'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* 2. 入选理由与利空排查弹窗 */
export function StockReasonModal({ modalData, onClose, onAdd, onJumpCard, onJumpDiagnosis, onJumpIgnition }) {
  if (!modalData || !modalData.open) return null;
  const { stock, inPool } = modalData;
  if (!stock) return null;

  return (
    <StockReasonModalInner
      stock={stock}
      inPool={inPool}
      onClose={onClose}
      onAdd={onAdd}
      onJumpCard={onJumpCard}
      onJumpDiagnosis={onJumpDiagnosis}
      onJumpIgnition={onJumpIgnition}
    />
  );
}

function StockReasonModalInner({ stock, inPool, onClose, onAdd, onJumpCard, onJumpDiagnosis, onJumpIgnition }) {
  const [initShares, setInitShares] = useState(stock.shares ? String(stock.shares) : '');
  const [initCost, setInitCost] = useState(stock.cost ? String(stock.cost) : (stock.price ? String(stock.price) : ''));
  const code6 = String(stock.code || '').padStart(6, '0');

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <div className="modal-hd">
          <h3>🔍 入选逻辑与风险排查 · {stock.name} ({code6})</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '13px', lineHeight: 1.7 }}>
          <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'var(--surface2)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ fontWeight: 700, fontSize: '14px' }}>{stock.poolLabel || (stock.pool === 'steady' ? '稳健底仓' : '短线候选')}</span>
              <span className={`pill ${stock.verdict === '可做' ? 'p-buy' : stock.verdict === '小做' ? 'p-sell' : 'p-none'}`}>{stock.verdict || '观察'}</span>
            </div>
            <div style={{ color: 'var(--sub)', fontSize: '12px' }}>综合量化得分：<b>{stock.score || 80}</b> 分 ｜ 当前参考价：<b>{stock.price || stock.close || '—'}</b> 元</div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <h4 style={{ fontSize: '13px', marginBottom: '6px', color: 'var(--text)' }}>📌 核心入选逻辑与量价支撑</h4>
            <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--sub)' }}>
              {(stock.whyReasons || [
                `日内分时均价线支撑扎实，重心未破`,
                `量比大于 1.2，盘口换手活跃，具备充裕日内振幅`,
                `非ST且无恶性退市风险，属于活跃做T标的`
              ]).map((r, idx) => (
                <li key={idx} style={{ marginBottom: '4px' }}>{r}</li>
              ))}
            </ul>
          </div>

          {stock.riskCheck ? (
            <div style={{ padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--line)' }}>
              <h4 style={{ fontSize: '12.5px', marginBottom: '4px', color: stock.riskCheck.status === 'safe' ? 'var(--down)' : 'var(--warn)' }}>
                {stock.riskCheck.statusText || '🟢 未见重大恶性利空'}
              </h4>
              <div style={{ fontSize: '12px', color: 'var(--sub)' }}>
                {(stock.riskCheck.highlights || []).join(' ｜ ')}
              </div>
            </div>
          ) : null}

          {!inPool && (
            <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--surface2)', borderRadius: '8px', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                💼 预设做T底仓信息（选填，并入后可在卡片随时修改）：
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>持仓股数:</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="如 1000"
                    value={initShares}
                    onChange={e => setInitShares(e.target.value)}
                    style={{ width: '85px', padding: '4px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)', background: '#fff' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>成本单价:</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="如 30.50"
                    value={initCost}
                    onChange={e => setInitCost(e.target.value)}
                    style={{ width: '85px', padding: '4px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)', background: '#fff' }}
                  />
                </div>
                <button
                  type="button"
                  className="mini"
                  onClick={() => setInitCost(stock.price ? String(stock.price) : '')}
                  style={{ marginLeft: 0, padding: '3px 8px', fontSize: '11px', cursor: 'pointer' }}
                >
                  ⚡ 填入现价
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {onJumpDiagnosis && (
              <button
                type="button"
                className="mini"
                onClick={() => {
                  onClose();
                  onJumpDiagnosis(code6);
                }}
                style={{ marginLeft: 0 }}
              >
                🩺 全景诊股
              </button>
            )}
            {onJumpIgnition && (
              <button
                type="button"
                className="mini"
                onClick={() => {
                  onClose();
                  onJumpIgnition(code6);
                }}
                style={{ marginLeft: 0 }}
              >
                🚀 起爆体检
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <button type="button" className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>关闭</button>
            {inPool && onJumpCard ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onJumpCard(stock);
                  onClose();
                }}
                style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}
              >
                👉 直达决策卡片
              </button>
            ) : null}
            {!inPool && onAdd ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const sNum = parseInt(initShares, 10) || 0;
                  const cNum = parseFloat(initCost) || 0;
                  onAdd({
                    ...stock,
                    shares: sNum,
                    cost: cNum
                  });
                  onClose();
                }}
                style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}
              >
                ＋ 一键并入自选池
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* 3. A股日内分时作战法则时段禁忌表弹窗 */
export function TradingClockModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '580px' }}>
        <div className="modal-hd">
          <h3>⏰ A 股日内分时作战法则（时段禁忌表）</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '12.5px', lineHeight: 1.7 }}>
          <div style={{ marginBottom: '10px', padding: '8px 12px', background: 'var(--surface2)', borderRadius: '7px', border: '1px solid var(--line)' }}>
            <b>核心铁律：</b>A 股做T有极其残酷的时段效应，在错误的时间挂单（如 09:30 追高或中午垃圾时间乱买），胜率会断崖式暴跌。请严格对照当前时段作战。
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--surface)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>时段</th>
                <th style={{ padding: '6px 8px' }}>作战时区属性</th>
                <th style={{ padding: '6px 8px' }}>操作纪律与禁忌</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>09:15-09:25</td><td>集合竞价期</td><td>盯开盘定高低，看竞价异动，不盲目抢跑</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>09:25-09:30</td><td>竞价定盘期</td><td>跑竞价校准，定全天挂单预期买卖点</td></tr>
              <tr style={{ background: 'var(--up-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--up)' }}>09:30-09:45</td><td style={{ color: 'var(--up)', fontWeight: 700 }}>⚠️ 情绪宣泄诱多期</td><td>假摔诱多极多，<b>严禁冲动追高开仓</b>，等待分时均线平稳</td></tr>
              <tr style={{ background: 'var(--down-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--down)' }}>09:45-10:30</td><td style={{ color: 'var(--down)', fontWeight: 700 }}>🎯 做T黄金主窗口</td><td>方向确立，缩量回踩分时均线低吸正T，放量冲高乏力倒T</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>10:30-11:30</td><td>震荡巩固期</td><td>检验均线支撑，未达成做T条件的停止追单</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>11:30-13:00</td><td>午间休市</td><td>复盘上午量能承接，梳理午后挂单</td></tr>
              <tr style={{ background: 'var(--warn-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--warn-d)' }}>13:00-14:00</td><td>💤 缩量垃圾时间</td><td>全天成交低谷，无量假突破居多，<b>管住手，多看少动</b></td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>14:00-14:30</td><td>变盘预警期</td><td>主力抢跑与方向突变窗口，警惕破位跳水</td></tr>
              <tr style={{ background: 'var(--up-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--up)' }}>14:30-14:55</td><td style={{ color: 'var(--up)', fontWeight: 700 }}>🚨 T仓强制平仓期</td><td><b>做T绝不过夜变加仓！</b>必须在此窗口将今日T仓平掉归位或止损</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>14:55-15:00</td><td>尾盘集合竞价</td><td>全天定盘收官，持仓锁定</td></tr>
            </tbody>
          </table>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  );
}

/* 4. 全局 Toast 提示容器 */
export function ToastHost({ toasts, onDismiss }) {
  return (
    <div id="toastHost" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>
          <span className="ti">{t.kind === 'ok' ? '✓' : t.kind === 'err' ? '!' : t.kind === 'warn' ? '⚠' : 'i'}</span>
          <span className="tx">{t.msg}</span>
          <button className="tc" title="关闭" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/* 5. 尾盘过夜风控横幅 (14:40 之后触发日内做T未平仓醒目预警) */
export function OvernightBanner({
  visible,
  onClose,
  unclosedList = [],
  onOpenQuickT,
  simTailAlert = false,
  onToggleSimTailAlert
}) {
  if (!visible) return null;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const minsLeft = Math.max(0, 895 - mins); // 14:55 连续竞价结束

  return (
    <div
      id="overnightAlertBanner"
      className="overnight-alert-banner tail-alert-pulse"
      style={{
        background: 'linear-gradient(90deg, #fff1f0, #fff7e6, #fff)',
        borderLeft: '6px solid #cf1322',
        borderTop: '1px solid #ffa39e',
        borderBottom: '1.5px solid #ff4d4f',
        padding: '12px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '24px' }}>🚨</span>
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 800, color: '#cf1322', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>【14:40 尾盘清T强制风控警报】做T绝不过夜！严禁被动变加仓套牢！</span>
              <span style={{
                fontSize: '11px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '4px',
                background: '#cf1322',
                color: '#fff'
              }}>
                {minsLeft > 0 ? `距 14:55 闭市平仓仅剩 ${minsLeft} 分钟` : '连续竞价已临近尾声'}
              </span>
              {simTailAlert && (
                <span style={{ fontSize: '10.5px', background: '#e6f4ff', color: '#1677ff', border: '1px solid #91caff', padding: '1px 6px', borderRadius: '4px' }}>
                  🧪 模拟演练中
                </span>
              )}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '2px' }}>
              {unclosedList && unclosedList.length > 0 ? (
                <span>检测到今日自选池中尚有 <b>{unclosedList.length}</b> 只标的未完成做T平仓！请在 14:55 前果断按市价挂卖平仓，守住做T纪律底线！</span>
              ) : (
                <span>做T第一铁律：绝不过夜！请检查今日是否仍有未平仓的做T底仓，切勿转为被动过夜加仓！</span>
              )}
            </div>
          </div>
        </div>

        {/* 标的快捷平仓胶囊列表 */}
        {unclosedList && unclosedList.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginLeft: '4px' }}>
            {unclosedList.map(({ stock, unclosedShares }) => (
              <div
                key={stock.code}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: '#fff',
                  border: '1px solid #ffa39e',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  fontSize: '12px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                }}
              >
                <span style={{ fontWeight: 700, color: 'var(--text)' }}>{stock.name} ({stock.code})</span>
                <span style={{ color: '#cf1322', fontWeight: 600 }}>未平 <b>{unclosedShares}</b> 股</span>
                <span style={{ color: 'var(--sub)' }}>现价 ¥{f2(stock.price)}</span>
                {onOpenQuickT && (
                  <button
                    type="button"
                    style={{
                      padding: '2px 8px',
                      fontSize: '11px',
                      fontWeight: 700,
                      borderRadius: '4px',
                      border: 'none',
                      background: '#cf1322',
                      color: '#fff',
                      cursor: 'pointer'
                    }}
                    onClick={() => onOpenQuickT(stock, '直接卖出', f2(stock.price), unclosedShares)}
                    title={`立即挂单卖出 ${unclosedShares} 股以平仓`}
                  >
                    ⚡ 一键平仓
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {onToggleSimTailAlert && (
          <button
            type="button"
            className="mini"
            onClick={onToggleSimTailAlert}
            style={{ fontSize: '11px', color: 'var(--sub)', padding: '2px 8px', cursor: 'pointer' }}
            title="切换 14:40 尾盘未平仓预警模拟开关"
          >
            {simTailAlert ? '退出模拟' : '模拟14:40预警'}
          </button>
        )}
        <button
          className="oab-close"
          onClick={onClose}
          title="关闭警报条"
          style={{ fontSize: '20px', fontWeight: 700, color: '#cf1322', cursor: 'pointer', background: 'none', border: 'none' }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/* 6. 盘中到价与分时异动提醒中心弹窗 */
export function AlertCenterModal({
  open,
  onClose,
  pool,
  onJumpCard,
  notifyActive,
  onToggleNotify,
  alertEnabled = true,
  onToggleAlertEnabled,
  simTailAlert = false,
  onToggleSimTailAlert,
  onSimulateAnomaly,
  unclosedCount = 0
}) {
  if (!open) return null;
  return (
    <AlertCenterModalInner
      onClose={onClose}
      pool={pool}
      onJumpCard={onJumpCard}
      notifyActive={notifyActive}
      onToggleNotify={onToggleNotify}
      alertEnabled={alertEnabled}
      onToggleAlertEnabled={onToggleAlertEnabled}
      simTailAlert={simTailAlert}
      onToggleSimTailAlert={onToggleSimTailAlert}
      onSimulateAnomaly={onSimulateAnomaly}
      unclosedCount={unclosedCount}
    />
  );
}

function AlertCenterModalInner({
  onClose,
  pool,
  onJumpCard,
  notifyActive,
  onToggleNotify,
  alertEnabled,
  onToggleAlertEnabled,
  simTailAlert,
  onToggleSimTailAlert,
  onSimulateAnomaly,
  unclosedCount = 0
}) {
  const [alertList, setAlertList] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('t-system-alerts') || '[]');
    } catch (_) {
      return [];
    }
  });
  const [filterCat, setFilterCat] = useState('all'); // 'all' | 'anomaly' | 'price'

  useEffect(() => {
    const handleAlerts = (e) => {
      if (e.detail) setAlertList(e.detail);
    };
    window.addEventListener('t-alert-triggered', handleAlerts);
    return () => window.removeEventListener('t-alert-triggered', handleAlerts);
  }, []);

  const handleClearAlerts = () => {
    localStorage.setItem('t-system-alerts', '[]');
    setAlertList([]);
  };

  const anomalyCount = alertList.filter((a) => a.category === 'anomaly').length;
  const priceCount = alertList.filter((a) => a.category !== 'anomaly').length;
  const filteredAlerts = alertList.filter((a) => {
    if (filterCat === 'anomaly') return a.category === 'anomaly';
    if (filterCat === 'price') return a.category !== 'anomaly';
    return true;
  });

  // 实时扫描自选池股票到买卖点的距离
  const poolNearList = (pool || []).map(s => {
    const p = +s.price || +s.prevClose || 0;
    let c = null;
    try { c = calc(s); } catch (_) {}
    if (!c || !p) return null;

    const targets = [
      { label: '正T买点', lv: +c.inA, dir: 'buy' },
      { label: '第二买点', lv: +c.inB, dir: 'buy' },
      { label: '倒T卖点', lv: +c.outA, dir: 'sell' },
      { label: '卖飞线', lv: +c.fly, dir: 'fly' },
      ...(+s.shares > 0 && c.slA > 0 ? [{ label: '止损线', lv: +c.slA, dir: 'stop' }] : []),
    ].filter(t => t.lv > 0);

    const nearest = targets.map(t => {
      const dev = (p - t.lv) / t.lv * 100;
      return { ...t, dev, absDev: Math.abs(dev) };
    }).sort((a, b) => a.absDev - b.absDev)[0];

    return {
      name: s.name,
      code: s.code,
      price: p,
      nearest,
      anomaly: s._anomaly,
    };
  }).filter(Boolean);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="modal-hd">
          <h3>🔔 盘中分时异动与到价提醒中心</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '13px', lineHeight: 1.6 }}>
          {/* 1. 上班免打扰模式与提醒主开关 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            padding: '11px 14px',
            background: alertEnabled ? '#f0f5ff' : '#fff1f0',
            border: alertEnabled ? '1px solid #adc6ff' : '1px solid #ffa39e',
            borderRadius: '8px',
            marginBottom: '12px',
            gap: '10px'
          }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{
                fontWeight: 700,
                color: alertEnabled ? '#1d39c4' : '#cf1322',
                fontSize: '13.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <span>{alertEnabled ? '🔔 实时到价与分时异动雷达：运行中' : '🔕 上班免打扰模式：已开启（全部静音）'}</span>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px', lineHeight: 1.5 }}>
                {alertEnabled
                  ? '同时监控「买卖/止损到价」与「分时5分钟放量急拉/放量跳水/冲板回落/大盘急杀」。'
                  : '已静音所有提示音、标题闪烁与桌面弹窗，适合在办公室安心工作。'}
              </div>
            </div>
            {onToggleAlertEnabled && (
              <button
                type="button"
                onClick={onToggleAlertEnabled}
                style={{
                  padding: '7px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  border: 'none',
                  background: alertEnabled ? '#ff4d4f' : '#52c41a',
                  color: '#fff'
                }}
              >
                {alertEnabled ? '🔕 开启免打扰' : '🔔 恢复提醒'}
              </button>
            )}
          </div>

          {/* 2. 分时放量急拉 / 跳水异动雷达与一键演练 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            padding: '10px 14px',
            background: 'linear-gradient(90deg, #faf5ff, #f8fafc)',
            border: '1px solid #d8b4fe',
            borderRadius: '8px',
            marginBottom: '12px',
            gap: '10px'
          }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: '#6b21a8', fontSize: '13px' }}>
                ⚡ 分时放量急拉 / 跳水 / 冲板炸板雷达（10分钟冷却防刷屏）
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                自动捕获 5 分钟急涨/急跌 ≥1.8%（20cm ≥2.5%）且分钟量能脉冲 ≥1.8×、涨停炸板回落及大盘 5 分钟急杀，并在作战卡片顶部亮起警示条。
              </div>
            </div>
            {onSimulateAnomaly && (
              <button
                type="button"
                onClick={() => onSimulateAnomaly()}
                style={{
                  padding: '6px 12px',
                  fontSize: '11.5px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  border: '1px solid #a855f7',
                  background: '#fff',
                  color: '#7e22ce'
                }}
                title="交替模拟放量急拉与放量跳水，立即测试蜂鸣声、气泡、卡片警示条与下方流水"
              >
                🧪 演练分时异动
              </button>
            )}
          </div>

          {/* 3. 桌面通知与 14:40 尾盘风控演练双栏 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px', marginBottom: '14px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '9px 12px',
              background: notifyActive ? '#f6ffed' : '#fffbe6',
              border: notifyActive ? '1px solid #b7eb8f' : '1px solid #ffe58f',
              borderRadius: '8px',
              gap: '8px'
            }}>
              <div>
                <div style={{ fontWeight: 700, color: notifyActive ? '#389e0d' : '#d48806', fontSize: '12.5px' }}>
                  {notifyActive ? '🟢 桌面弹窗已授权' : '🟡 桌面通知未授权'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--sub)' }}>切到后台也能收到异动弹窗</div>
              </div>
              {!notifyActive && onToggleNotify && (
                <button
                  type="button"
                  className="primary"
                  onClick={onToggleNotify}
                  style={{ padding: '4px 10px', fontSize: '11.5px', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'pointer' }}
                >
                  授权开启
                </button>
              )}
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '9px 12px',
              background: simTailAlert ? '#fff1f0' : 'var(--surface2)',
              border: simTailAlert ? '1px solid #ffa39e' : '1px solid var(--line)',
              borderRadius: '8px',
              gap: '8px'
            }}>
              <div>
                <div style={{ fontWeight: 700, color: simTailAlert ? '#cf1322' : 'var(--text)', fontSize: '12.5px' }}>
                  🚨 14:40 清T警报 {unclosedCount > 0 ? `(${unclosedCount}只待平)` : ''}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--sub)' }}>防日内T仓被动过夜变套牢</div>
              </div>
              {onToggleSimTailAlert && (
                <button
                  type="button"
                  onClick={onToggleSimTailAlert}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11.5px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    borderRadius: '6px',
                    border: '1px solid',
                    background: simTailAlert ? '#cf1322' : '#fff',
                    color: simTailAlert ? '#fff' : 'var(--text)',
                    borderColor: simTailAlert ? '#cf1322' : 'var(--line)'
                  }}
                >
                  {simTailAlert ? '退出模拟' : '模拟14:40'}
                </button>
              )}
            </div>
          </div>

          {/* 4. 自选池实时临界买卖点监测 */}
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🎯 自选股近邻关键价位距离一览</span>
              <span style={{ fontSize: '11px', color: 'var(--mute)', fontWeight: 400 }}>（偏差 ≤ 0.4% 自动报警，点击直达卡片）</span>
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
              {poolNearList.map(item => {
                const n = item.nearest;
                if (!n) return null;
                const isNear = n.absDev <= 0.4;
                return (
                  <div
                    key={item.code}
                    onClick={() => {
                      if (onJumpCard) onJumpCard(item.code);
                      onClose();
                    }}
                    style={{
                      padding: '8px 12px',
                      background: isNear ? '#fff1f0' : 'var(--surface)',
                      border: isNear ? '1px solid #ffa39e' : '1px solid var(--line)',
                      borderRadius: '7px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                    title="点击立即跳转查看该股做T决策卡片"
                  >
                    <div>
                      <b style={{ color: 'var(--text)' }}>{item.name}</b> <span style={{ fontSize: '11.5px', color: 'var(--mute)' }}>{item.code}</span>
                      {item.anomaly && (
                        <span style={{ marginLeft: 6, fontSize: '10.5px', fontWeight: 700, color: item.anomaly.level === 'surge' ? '#cf1322' : '#15803d' }}>
                          {item.anomaly.label}
                        </span>
                      )}
                      <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                        现价 ¥{f2(item.price)} ➔ 【{n.label}】¥{f2(n.lv)}
                      </div>
                    </div>
                    <span style={{
                      fontWeight: 700,
                      fontSize: '12px',
                      color: isNear ? 'var(--up)' : 'var(--sub)',
                      fontFamily: 'ui-monospace,Consolas,monospace'
                    }}>
                      {n.dev >= 0 ? '+' : ''}{n.dev.toFixed(2)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 5. 今日已触发异动与到价流水记录（支持分类筛选） */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <h4 style={{ fontSize: '13px', margin: 0, color: 'var(--text)' }}>
                  📋 今日预警流水
                </h4>
                {[
                  { key: 'all', label: `全部 (${alertList.length})` },
                  { key: 'anomaly', label: `⚡ 盘中异动 (${anomalyCount})` },
                  { key: 'price', label: `🎯 到价提醒 (${priceCount})` },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`mini ${filterCat === tab.key ? 'primary' : ''}`}
                    style={{ marginLeft: 0, fontSize: '11px', padding: '2px 8px' }}
                    onClick={() => setFilterCat(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {alertList.length > 0 && (
                <button
                  type="button"
                  className="mini"
                  onClick={handleClearAlerts}
                  style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer' }}
                >
                  清空流水
                </button>
              )}
            </div>

            {filteredAlerts.length > 0 ? (
              <div className="alert-list" style={{ maxHeight: '190px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}>
                {filteredAlerts.map(a => {
                  const isAnom = a.category === 'anomaly';
                  const tagStyle = isAnom
                    ? a.anomalyType === 'rocket_up'
                      ? { background: '#fef2f2', color: '#cf1322', border: '1px solid #fca5a5' }
                      : a.anomalyType === 'waterfall_down'
                      ? { background: '#ecfdf5', color: '#15803d', border: '1px solid #86efac' }
                      : { background: '#fff7ed', color: '#c2410c', border: '1px solid #fdba74' }
                    : undefined;

                  return (
                    <div key={a.id} className="alert-row">
                      <span className="ah">{a.time}</span>
                      <span className="ak k-price" style={tagStyle}>{a.label}</span>
                      <span className="ad">
                        {isAnom ? (
                          <>
                            <b>{a.name}</b> 现价 ¥{f2(a.price)} · {a.summary || `${a.deltaPct > 0 ? '+' : ''}${a.deltaPct}%`}
                          </>
                        ) : (
                          <>
                            <b>{a.name}</b> 现价 ¥{f2(a.price)} 触及【{a.label} ¥{f2(a.target)}】（差 {((a.dev || 0) * 100).toFixed(2)}%）
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--mute)', background: 'var(--surface2)', borderRadius: '8px', fontSize: '12.5px' }}>
                当前分类暂无预警记录。<br />
                可点击上方「🧪 演练分时异动」立即体验放量急拉与跳水预警全链路闭环。
              </div>
            )}
          </div>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="primary" onClick={onClose} style={{ padding: '6px 18px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
