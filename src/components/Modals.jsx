import React, { useState, useEffect } from 'react';
import { f2, money, getTodayTStatus, toastWarn, playAlertTone } from '../services/utils.js';
import { getCNClock, getUpcomingHolidayReminder, getTradingClockSnapshot, syncRemoteTradeCalendar } from '../services/calendar.js';
import { calc, computeLeadingMomentum } from '../services/api.js';
import { evaluateChannelHoldingDiscipline, evaluateHolidayPositionGuard, evaluatePreTradeHolidayGuard } from '../services/risk.js';

/* 1. 快捷记T弹窗（含单日防上头熔断锁保护与节前控仓黄牌二次确认） */
export function QuickTModal({
  modalData,
  tradeLogs = [],
  tiltState = null,
  totalAssets = 100000,
  currentMktVal = 0,
  allowedCapPct = 80,
  holidayReminder = undefined,
  onClose,
  onConfirm,
}) {
  if (!modalData || !modalData.open) return null;
  return (
    <QuickTModalInner
      modalData={modalData}
      tradeLogs={tradeLogs}
      tiltState={tiltState}
      totalAssets={totalAssets}
      currentMktVal={currentMktVal}
      allowedCapPct={allowedCapPct}
      holidayReminder={holidayReminder}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

function QuickTModalInner({
  modalData,
  tradeLogs = [],
  tiltState = null,
  totalAssets = 100000,
  currentMktVal = 0,
  allowedCapPct = 80,
  holidayReminder = undefined,
  onClose,
  onConfirm,
}) {
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
  const preBuyHolidayGuard = evaluatePreTradeHolidayGuard({
    currentMkt: currentMktVal,
    buyAmt: isDirectBuy && b > 0 && q > 0 ? buyAmt : 0,
    unitPrice: b,
    totalAssets,
    emotionCapPct: allowedCapPct,
    holidayReminder: holidayReminder !== undefined ? holidayReminder : getUpcomingHolidayReminder(new Date()),
    stockName: stock.name || stock.code,
  });

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
      if (preBuyHolidayGuard.willExceedCap) {
        if (!window.confirm(preBuyHolidayGuard.confirmPromptText)) {
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

              {preBuyHolidayGuard.willExceedCap && (
                <div
                  style={{
                    marginTop: '10px',
                    padding: '8px 11px',
                    borderRadius: '7px',
                    background: 'linear-gradient(90deg, #fffbeb 0%, #fff7ed 100%)',
                    border: '1px solid #f59e0b',
                    color: '#78350f',
                    fontSize: '11.5px',
                    lineHeight: 1.55,
                  }}
                >
                  <div>
                    🟨 <b>节前控仓黄牌：</b>距<b>{preBuyHolidayGuard.holidayName}</b>（连休
                    {preBuyHolidayGuard.closedDays}天）仅剩 <b>{preBuyHolidayGuard.remainingTradeDays}</b> 个交易日，
                    买后总仓将由 <b>{preBuyHolidayGuard.beforePosPct.toFixed(1)}%</b> 升至{' '}
                    <b>{preBuyHolidayGuard.afterPosPct.toFixed(1)}%</b>，超{preBuyHolidayGuard.capSourceLabel}{' '}
                    <b>{preBuyHolidayGuard.overPct}%</b>。
                  </div>
                  <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', color: '#92400e' }}>
                    <span>{preBuyHolidayGuard.safeCapHint}</span>
                    {preBuyHolidayGuard.maxSafeShares >= 100 && (
                      <button
                        type="button"
                        className="qt-chip"
                        style={{ background: '#fef3c7', borderColor: '#f59e0b', color: '#92400e', fontWeight: 700 }}
                        onClick={() => setQty(preBuyHolidayGuard.maxSafeShares)}
                      >
                        按节前上限 ({preBuyHolidayGuard.maxSafeShares}股)
                      </button>
                    )}
                  </div>
                </div>
              )}
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

/* 3. A股日内分时作战法则时段禁忌表弹窗（联动法定节假日休市与节前控仓窗口） */
export function TradingClockModal({
  open,
  onClose,
  onJumpRules,
  posRate = 0,
  marketValue = 0,
  totalAssets = 100000,
  allowedCapPct = 80,
}) {
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return undefined;
    setNowTs(Date.now());
    syncRemoteTradeCalendar().finally(() => setNowTs(Date.now()));
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const nowObj = new Date(nowTs);
  const snap = getTradingClockSnapshot(nowObj);
  const reminder = snap.holidayReminder;
  const remDays = Number(reminder?.remainingTradeDays || 0);
  const closedDays = Number(reminder?.closedDays || 0);
  const isLongHoliday = Boolean(reminder?.isLongHoliday || closedDays >= 3);
  const isUrgentPreHoliday = snap.isPreHolidayUrgent;
  const isFinalPreHolidayDay = Boolean(isUrgentPreHoliday && remDays === 1);
  const holidayGuard = evaluateHolidayPositionGuard({
    totalPosPct: posRate,
    totalMkt: marketValue,
    totalAssets,
    emotionCapPct: allowedCapPct,
    holidayReminder: reminder,
    now: nowObj,
  });
  const capPct = holidayGuard.active
    ? holidayGuard.effectiveCapPct
    : Math.min(Number(allowedCapPct || 80), Number(reminder?.suggestedMaxPosPct) || (closedDays >= 7 ? 30 : 50));

  const sessionTone = (snap.isInHoliday || snap.isHoliday)
    ? { bg: '#fef2f2', bd: '#fecaca', fg: '#b91c1c' }
    : !snap.isTradeDay
      ? { bg: '#f8fafc', bd: '#cbd5e1', fg: '#475569' }
      : isUrgentPreHoliday
        ? { bg: '#fffbeb', bd: '#fcd34d', fg: '#b45309' }
        : { bg: '#eff6ff', bd: '#bfdbfe', fg: '#1d4ed8' };

  const slots = [
    {
      id: 'auction_call',
      time: '09:15-09:25',
      zone: '集合竞价期',
      tone: null,
      rule: <>盯开盘定高低，看竞价异动（09:20 后不可撤单），不盲目抢跑</>
    },
    {
      id: 'auction_fix',
      time: '09:25-09:30',
      zone: '竞价定盘期',
      tone: null,
      rule: <>跑竞价校准，核对昨日计划挂单与今日开盘承接水位</>
    },
    {
      id: 'open_frenzy',
      time: '09:30-09:45',
      zone: '⚠️ 情绪宣泄诱多期',
      tone: 'up',
      rule: <>假摔诱多极多，<b>严禁冲动追高开仓</b>，等待分时均线平稳</>
    },
    {
      id: 'golden_t',
      time: '09:45-10:30',
      zone: '🎯 做T黄金主窗口',
      tone: 'down',
      rule: (
        <>
          方向确立，缩量回踩分时均线低吸正T，放量冲高乏力倒T
          {isUrgentPreHoliday && (
            <div style={{ marginTop: '3px', color: '#b45309', fontWeight: 600 }}>
              🏮 节前窗口纪律：逢分时冲高优先执行倒T减仓，将总仓位压降至 ≤{capPct}% 安全线内
            </div>
          )}
        </>
      )
    },
    {
      id: 'mid_consolidate',
      time: '10:30-11:30',
      zone: '震荡巩固期',
      tone: null,
      rule: <>检验均线支撑，未达成做T价差条件的停止追单</>
    },
    {
      id: 'lunch_break',
      time: '11:30-13:00',
      zone: '午间休市',
      tone: null,
      rule: <>复盘上午量能承接与港股/外盘风向，梳理午后止盈止损挂单</>
    },
    {
      id: 'dull_hour',
      time: '13:00-14:00',
      zone: '💤 缩量垃圾时间',
      tone: 'warn',
      rule: <>全天成交低谷，无量假突破居多，<b>管住手，多看少动</b></>
    },
    {
      id: 'inflection_warn',
      time: '14:00-14:30',
      zone: '变盘预警期',
      tone: null,
      rule: (
        <>
          主力抢跑与方向突变窗口，警惕破位跳水
          {isUrgentPreHoliday && remDays === 2 && (
            <div style={{ marginTop: '3px', color: '#b45309', fontWeight: 600 }}>
              💸 节前倒数第 2 日（提现出金兑现高峰）：警惕避险资金集中抛压引发午后回落
            </div>
          )}
        </>
      )
    },
    {
      id: 'force_close_t',
      time: '14:30-14:55',
      zone: '🚨 T仓强制平仓期',
      tone: 'up',
      rule: (
        <>
          <b>做T绝不过夜变加仓！</b>必须在此窗口将今日T仓平掉归位或止损
          {isUrgentPreHoliday && (
            <div style={{ marginTop: '3px', color: isFinalPreHolidayDay ? '#b91c1c' : '#b45309', fontWeight: 700 }}>
              {isFinalPreHolidayDay
                ? `🔒 节前收官日铁律：今日任何新买单受 T+1 限制将强制锁仓跨假 ${closedDays} 天！严禁尾盘博弈抄底，超限仓位务必在 14:55 前清退至 ≤${capPct}%`
                : `🟡 节前控仓核查：收盘前核对实际总仓位，超 ≤${capPct}% 上限部分主动择机减仓`}
            </div>
          )}
        </>
      )
    },
    {
      id: 'close_auction',
      time: '14:55-15:00',
      zone: '尾盘集合竞价',
      tone: null,
      rule: <>全天定盘收官，持仓锁定，15:05 进入收盘归档与跨假风控核查</>
    }
  ];

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="modal-hd">
          <h3>⏰ A 股交易时钟与日内分时作战法则</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '12.5px', lineHeight: 1.65 }}>
          {/* 实时北京时间与交易日历状态栏 */}
          <div style={{
            marginBottom: '10px',
            padding: '9px 12px',
            borderRadius: '8px',
            background: sessionTone.bg,
            border: `1px solid ${sessionTone.bd}`,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontWeight: 800,
                fontSize: '13.5px',
                color: '#0f172a'
              }}>
                🕒 北京时间 {snap.dateStr} {snap.weekdayLabel} {snap.timeStr}
              </span>
              <span style={{
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '11.5px',
                fontWeight: 700,
                background: '#fff',
                color: sessionTone.fg,
                border: `1px solid ${sessionTone.bd}`
              }}>
                {snap.sessionBadge}
              </span>
            </div>
            <div style={{ fontSize: '11.5px', color: '#475569', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <span>上个交易日：<b>{snap.prevTradeDate || '--'}</b></span>
              <span>下个开市日：<b style={{ color: '#1d4ed8' }}>{snap.nextTradeDate || '--'}</b></span>
            </div>
          </div>

          {/* 法定节假日休市 / 周末休市 / 节前长假控仓窗口横幅 */}
          {(snap.isInHoliday || snap.isHoliday) ? (
            <div style={{
              marginBottom: '10px',
              padding: '9px 12px',
              borderRadius: '8px',
              background: 'linear-gradient(90deg, #fef2f2 0%, #fff7ed 100%)',
              border: '1px solid #fca5a5',
              color: '#991b1b',
              fontSize: '12px'
            }}>
              <div style={{ fontWeight: 800, marginBottom: '2px' }}>
                🏮 法定节假日休市期：【{reminder?.holidayName || snap.holidayName || '节假日休市'}】
                {reminder?.closureStart && reminder?.closureEnd ? `（${reminder.closureStart} ~ ${reminder.closureEnd}，连休 ${closedDays || 1} 天）` : ''}
              </div>
              <div style={{ color: '#7f1d1d' }}>
                当前 A 股全天不开市、不接受日内撮合。节后首个开市日为 <b>{reminder?.reopenDate || snap.nextTradeDate || '--'}</b>，建议提前梳理外盘与假期消息面，制定节后首日 <b>09:15-09:25</b> 竞价应对与去弱留强预案。
              </div>
            </div>
          ) : !snap.isTradeDay ? (
            <div style={{
              marginBottom: '10px',
              padding: '8px 12px',
              borderRadius: '8px',
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              color: '#334155',
              fontSize: '12px'
            }}>
              <b>🛋️ 周末休市时段：</b>今日非 A 股交易日，下个交易日为 <b>{snap.nextTradeDate || '--'}</b>。
              {reminder && reminder.phase !== 'in_holiday' && (
                <span>
                  {' '}另请注意：距【<b>{reminder.holidayName}</b>】（连休 {closedDays} 天）仅剩{' '}
                  <b style={{ color: remDays <= 2 && isLongHoliday ? '#b45309' : '#1d4ed8' }}>
                    {remDays}
                  </b>{' '}个交易日
                  {remDays <= 2 && isLongHoliday
                    ? `，下周开盘即进入节前控仓窗口（建议上限 ≤${capPct}%）。`
                    : '。'}
                </span>
              )}
            </div>
          ) : isUrgentPreHoliday ? (
            <div style={{
              marginBottom: '10px',
              padding: '9px 12px',
              borderRadius: '8px',
              background: holidayGuard.isYellowCard
                ? 'linear-gradient(90deg, #fffbeb 0%, #fef3c7 100%)'
                : 'linear-gradient(90deg, #f0fdf4 0%, #fffbeb 100%)',
              border: `1px solid ${holidayGuard.isYellowCard ? '#f59e0b' : '#86efac'}`,
              color: holidayGuard.isYellowCard ? '#92400e' : '#166534',
              fontSize: '12px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '3px' }}>
                <span style={{ fontWeight: 800 }}>
                  {holidayGuard.isYellowCard ? '🟨 节前长假控仓黄牌预警' : '🏮 节前长假控仓窗口（当前达标）'}：距【{reminder.holidayName}】（{reminder.closureStart} ~ {reminder.closureEnd}，连休 {closedDays} 天）仅剩 {remDays} 个交易日
                </span>
                <span style={{
                  padding: '1px 7px',
                  borderRadius: '999px',
                  background: holidayGuard.isYellowCard ? '#fde68a' : '#dcfce7',
                  border: `1px solid ${holidayGuard.isYellowCard ? '#f59e0b' : '#86efac'}`,
                  fontWeight: 800,
                  fontSize: '11px',
                  color: holidayGuard.isYellowCard ? '#78350f' : '#166534'
                }}>
                  {holidayGuard.isYellowCard
                    ? `当前 ${Number(posRate).toFixed(1)}% · 超≤${capPct}%线 ${holidayGuard.excessPct}%`
                    : `当前 ${Number(posRate).toFixed(1)}% ≤ 上限 ${capPct}%`}
                </span>
              </div>
              <div>
                {holidayGuard.isYellowCard && (
                  <div style={{ fontWeight: 700, marginBottom: '2px', color: '#b45309' }}>
                    建议在收盘前逢高降仓约 ¥{holidayGuard.excessAmt.toLocaleString('zh-CN')}，压回 ≤{capPct}% 跨假安全水位。
                  </div>
                )}
                {isFinalPreHolidayDay
                  ? `今日为节前收官日！受 A 股 T+1 交收限制，今日任何新买单均将强制锁仓跨假 ${closedDays} 天（直至 ${reminder.reopenDate} 才能卖出）。请聚焦 09:45-10:30 逢高减仓与 14:30-14:55 T仓清退，严禁尾盘冲动抄底。`
                  : `今日为节前倒数第 2 个交易日（节前法定提现出金日），午后易现避险兑现抛压。请优先借早盘黄金窗口逢高减仓，避免临近收盘被动追砍。`}
              </div>
            </div>
          ) : reminder && reminder.phase !== 'in_holiday' ? (
            <div style={{
              marginBottom: '10px',
              padding: '7px 12px',
              borderRadius: '8px',
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              color: '#1e40af',
              fontSize: '12px'
            }}>
              📅 <b>近期节假日预告：</b>距【{reminder.holidayName}】（{reminder.closureStart} ~ {reminder.closureEnd}，连休 {closedDays} 天）还有 <b>{remDays}</b> 个交易日
              {isLongHoliday ? `（距假 ≤2 个交易日时将启动 ≤${capPct}% 节前分档控仓黄牌提示）` : '（短休维持常规日内做T纪律）'}。
            </div>
          ) : null}

          <div style={{ marginBottom: '10px', padding: '8px 12px', background: 'var(--surface2)', borderRadius: '7px', border: '1px solid var(--line)' }}>
            <b>核心铁律：</b>A 股做T有极其残酷的时段效应，在错误的时间挂单（如 09:30 追高或中午垃圾时间乱买），胜率会断崖式暴跌。
            {snap.isTradeDay && snap.activeSlotId === 'pre_open' && (
              <span style={{ color: '#1d4ed8', fontWeight: 700 }}> 当前处于 09:15 盘前准备期，请核查隔夜仓位与预埋挂单。</span>
            )}
            {snap.isTradeDay && snap.activeSlotId === 'post_eod' && (
              <span style={{ color: '#475569', fontWeight: 700 }}> 今日已收盘定盘，请完成 15:05 盘后归档与次日预案复盘。</span>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--surface)', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: '6px 8px', width: '112px' }}>时段</th>
                <th style={{ padding: '6px 8px', width: '148px' }}>作战时区属性</th>
                <th style={{ padding: '6px 8px' }}>操作纪律与禁忌</th>
              </tr>
            </thead>
            <tbody>
              {slots.map(slot => {
                const isActive = snap.isTradeDay && snap.activeSlotId === slot.id;
                const baseBg = slot.tone === 'up'
                  ? 'var(--up-bg)'
                  : slot.tone === 'down'
                    ? 'var(--down-bg)'
                    : slot.tone === 'warn'
                      ? 'var(--warn-bg)'
                      : 'transparent';
                const toneColor = slot.tone === 'up'
                  ? 'var(--up)'
                  : slot.tone === 'down'
                    ? 'var(--down)'
                    : slot.tone === 'warn'
                      ? 'var(--warn-d)'
                      : undefined;

                return (
                  <tr
                    key={slot.id}
                    style={{
                      background: isActive ? '#dbeafe' : baseBg,
                      boxShadow: isActive ? 'inset 3px 0 0 #2563eb' : undefined,
                      borderBottom: '1px solid var(--line)',
                      opacity: !snap.isTradeDay ? 0.86 : 1
                    }}
                  >
                    <td style={{ padding: '6px 8px', fontWeight: 700, color: isActive ? '#1d4ed8' : toneColor, whiteSpace: 'nowrap' }}>
                      {isActive ? '👉 ' : ''}{slot.time}
                      {isActive && (
                        <span style={{
                          marginLeft: '5px',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 800,
                          background: '#2563eb',
                          color: '#fff',
                          verticalAlign: 'middle'
                        }}>
                          当前
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', color: toneColor, fontWeight: (slot.tone || isActive) ? 700 : 500 }}>
                      {slot.zone}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{slot.rule}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <div>
            {onJumpRules && (
              <button
                type="button"
                onClick={onJumpRules}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid #bfdbfe',
                  background: '#eff6ff',
                  color: '#1d4ed8',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                📖 查看节前分档控仓完整手册 →
              </button>
            )}
          </div>
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

  const { mins } = getCNClock(new Date());
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
  onSimulateLeading,
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
      onSimulateLeading={onSimulateLeading}
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
  onSimulateLeading,
  unclosedCount = 0
}) {
  const [alertList, setAlertList] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('t-system-alerts') || '[]');
    } catch (_) {
      return [];
    }
  });
  const [filterCat, setFilterCat] = useState('all'); // 'all' | 'P0' | 'P1' | 'leading' | 'P2'

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

  const inferPriority = (a) => {
    if (a?.priority === 'P0' || a?.priority === 'P1' || a?.priority === 'P2') return a.priority;
    if (a?.category === 'anomaly' && a?.anomalyType !== 'rocket_up') return 'P0';
    return 'P1';
  };

  const p0Count = alertList.filter((a) => inferPriority(a) === 'P0').length;
  const p1Count = alertList.filter((a) => inferPriority(a) === 'P1').length;
  const leadCount = alertList.filter((a) => a?.category === 'leading').length;
  const p2Count = alertList.filter((a) => inferPriority(a) === 'P2').length;
  const filteredAlerts = alertList.filter((a) => {
    if (filterCat === 'all') return true;
    if (filterCat === 'leading') return a?.category === 'leading';
    return inferPriority(a) === filterCat;
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

    let leadMom = null;
    try { leadMom = computeLeadingMomentum(s); } catch (_) {}
    const liveLead =
      (leadMom?.ready && ((leadMom.bullHits || 0) >= 3 || (leadMom.bearHits || 0) >= 3)
        ? {
            dir: (leadMom.bullHits || 0) >= 3 ? 'bull' : 'bear',
            text: `${leadMom.shortTag} ${leadMom.scoreTxt}`,
          }
        : null) ||
      (s._leadResonance
        ? {
            dir: s._leadResonance.dir,
            text: `🔥 ${s._leadResonance.label} ${s._leadResonance.scoreTxt || ''}`.trim(),
          }
        : null);

    return {
      name: s.name,
      code: s.code,
      price: p,
      nearest,
      anomaly: s._anomaly,
      liveLead,
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
                  ? '同时监控「买卖/止损到价」、「3维/4维主力先导强共振(P1)」与「分时5分钟急拉/跳水/炸板/大盘急杀」。'
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

          {/* 2. 三级防刷屏提醒规则与一键演练 / 试听 */}
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
                🛡️ 15分钟防乒乓刷屏冷却 + P0 / P1 / P2 三级声音视觉分级
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px', lineHeight: 1.5 }}>
                <b>🚨 P0 持仓救命级</b>（跌破止损/炸板/跳水/首阴清仓）：三连急促警报 + 顶栏常驻红条；
                <b> 🎯 P1 确认执行级</b>（右侧拐头确认买卖点 + <b>🔥 3维/4维主力先导强共振</b>）：双音阶清脆提示；
                <b> 👀 P2 观察预备级</b>（刚进观察区未拐头）：仅静默记入流水，不发声打断看盘。
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => playAlertTone('P0', true)}
                style={{
                  padding: '5px 9px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  borderRadius: '6px',
                  border: '1px solid #fca5a5',
                  background: '#fef2f2',
                  color: '#dc2626'
                }}
                title="试听 P0 持仓救命级三连警报音"
              >
                🔊 试听P0
              </button>
              <button
                type="button"
                onClick={() => playAlertTone('P1', true)}
                style={{
                  padding: '5px 9px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  borderRadius: '6px',
                  border: '1px solid #93c5fd',
                  background: '#eff6ff',
                  color: '#1d4ed8'
                }}
                title="试听 P1 右侧确认级双音阶提示音"
              >
                🎵 试听P1
              </button>
              {onSimulateLeading && (
                <button
                  type="button"
                  onClick={() => onSimulateLeading()}
                  style={{
                    padding: '5px 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    borderRadius: '6px',
                    border: '1px solid #fda4af',
                    background: '#fff1f2',
                    color: '#be123c'
                  }}
                  title="交替演练 3 维多头先导强共振(+84) 与 3 维诱多暗出共振(-78) 自动写入 P1 提醒流水"
                >
                  🔥 演练先导P1
                </button>
              )}
              {onSimulateAnomaly && (
                <button
                  type="button"
                  onClick={() => onSimulateAnomaly()}
                  style={{
                    padding: '5px 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    borderRadius: '6px',
                    border: '1px solid #a855f7',
                    background: '#fff',
                    color: '#7e22ce'
                  }}
                  title="交替模拟放量急拉(P1)与放量跳水(P0)，立即验证声音、顶栏应急红条与下方流水"
                >
                  🧪 演练异动
                </button>
              )}
            </div>
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
                <div style={{ fontSize: '11px', color: 'var(--sub)' }}>仅 P0 / P1 触发桌面弹窗，P2 静默防骚扰</div>
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
              <span>🎯 自选股近邻关键价位与双门禁状态</span>
              <span style={{ fontSize: '11px', color: 'var(--mute)', fontWeight: 400 }}>（同档位 15 分钟冷却防抖，点击直达卡片）</span>
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
              {poolNearList.map(item => {
                const n = item.nearest;
                if (!n) return null;
                const isNear = n.absDev <= 0.45;
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
                      {item.liveLead && (
                        <span
                          style={{
                            marginLeft: 6,
                            padding: '1px 5px',
                            borderRadius: '4px',
                            fontSize: '10.5px',
                            fontWeight: 700,
                            background: item.liveLead.dir === 'bear' ? '#ecfdf5' : '#fff1f2',
                            color: item.liveLead.dir === 'bear' ? '#047857' : '#be123c',
                            border: `1px solid ${item.liveLead.dir === 'bear' ? '#6ee7b7' : '#fda4af'}`,
                          }}
                        >
                          {item.liveLead.text}
                        </span>
                      )}
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

          {/* 5. 今日已触发异动、先导强共振与到价流水记录（支持 P0 / P1 / 先导共振 / P2 分级筛选） */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                <h4 style={{ fontSize: '13px', margin: 0, color: 'var(--text)' }}>
                  📋 今日预警流水
                </h4>
                {[
                  { key: 'all', label: `全部 (${alertList.length})` },
                  { key: 'P0', label: `🚨 P0救命 (${p0Count})` },
                  { key: 'P1', label: `🎯 P1确认 (${p1Count})` },
                  { key: 'leading', label: `🔥 先导共振 (${leadCount})` },
                  { key: 'P2', label: `👀 P2预备 (${p2Count})` },
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
              <div className="alert-list" style={{ maxHeight: '195px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}>
                {filteredAlerts.map(a => {
                  const prio = inferPriority(a);
                  const isLead = a?.category === 'leading';
                  const prioStyle = isLead
                    ? a.leadDir === 'bear'
                      ? { background: '#ecfdf5', color: '#047857', border: '1px solid #6ee7b7' }
                      : { background: '#fff1f2', color: '#be123c', border: '1px solid #fda4af' }
                    : prio === 'P0'
                    ? { background: '#dc2626', color: '#ffffff', border: '1px solid #b91c1c' }
                    : prio === 'P1'
                    ? { background: '#eff6ff', color: '#1d4ed8', border: '1px solid #93c5fd' }
                    : { background: '#f1f5f9', color: '#64748b', border: '1px solid #cbd5e1' };

                  return (
                    <div
                      key={a.id}
                      className="alert-row"
                      style={{ cursor: a.code ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (a.code && onJumpCard) {
                          onJumpCard(a.code);
                          onClose();
                        }
                      }}
                    >
                      <span className="ah">{a.time}</span>
                      <span className="ak k-price" style={{ ...prioStyle, fontWeight: 700 }}>
                        {prio}·{a.label}
                      </span>
                      <span className="ad">
                        <b>{a.name}</b> 现价 ¥{f2(a.price)} ·{' '}
                        {a.summary
                          ? a.summary
                          : `触及【${a.label} ¥${f2(a.target)}】（偏差 ${((a.dev || 0) * 100).toFixed(2)}%）`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--mute)', background: 'var(--surface2)', borderRadius: '8px', fontSize: '12.5px' }}>
                当前分级暂无预警记录。<br />
                可点击上方「🔊 试听P0 / 🎵 试听P1 / 🧪 演练异动」立即体验三级声音与视觉分级闭环。
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

/* 6. 顶栏常驻 P0 持仓救命级应急横幅（止损破位 / 冲板炸板 / 持仓跳水 / 首阴清仓令） */
export function P0EmergencyBanner({ pool = [], onJumpCard, onOpenQuickT }) {
  const [activeP0, setActiveP0] = useState(null);
  const [dismissedIds, setDismissedIds] = useState(() => new Set());

  useEffect(() => {
    const onP0 = (e) => {
      const item = e?.detail;
      if (item && item.priority === 'P0') {
        setActiveP0(item);
      }
    };
    window.addEventListener('t-p0-emergency', onP0);
    return () => window.removeEventListener('t-p0-emergency', onP0);
  }, []);

  if (!activeP0 || dismissedIds.has(activeP0.id)) return null;

  const matchedStock = (pool || []).find(
    (s) => String(s.code || '').padStart(6, '0') === String(activeP0.code || '').padStart(6, '0')
  );

  const dismiss = () => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(activeP0.id);
      return next;
    });
  };

  return (
    <div
      role="alert"
      style={{
        margin: '8px auto 0',
        maxWidth: '1280px',
        padding: '9px 14px',
        borderRadius: '10px',
        background: 'linear-gradient(90deg, #991b1b, #dc2626)',
        color: '#ffffff',
        boxShadow: '0 4px 14px rgba(220, 38, 38, 0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        fontSize: '12.5px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: '1 1 280px' }}>
        <span style={{
          padding: '2px 7px',
          borderRadius: '99px',
          background: '#fef08a',
          color: '#991b1b',
          fontWeight: 800,
          fontSize: '11px',
        }}>
          🚨 P0 持仓风控令
        </span>
        <b>{activeP0.name} ({activeP0.code})</b>
        <span style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontWeight: 700 }}>
          现价 ¥{f2(activeP0.price)}
        </span>
        <span style={{ opacity: 0.96 }}>
          {activeP0.summary || `触及【${activeP0.label}】¥${f2(activeP0.target)}`}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {matchedStock && onOpenQuickT && (
          <button
            type="button"
            onClick={() => {
              onOpenQuickT(matchedStock, '直接卖出', f2(activeP0.price));
              dismiss();
            }}
            style={{
              padding: '4px 10px',
              borderRadius: '6px',
              border: 'none',
              background: '#ffffff',
              color: '#b91c1c',
              fontWeight: 800,
              fontSize: '11.5px',
              cursor: 'pointer',
            }}
          >
            ⚡ 立即减仓/止损
          </button>
        )}
        {activeP0.code && onJumpCard && (
          <button
            type="button"
            onClick={() => {
              onJumpCard(activeP0.code);
              dismiss();
            }}
            style={{
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.65)',
              background: 'rgba(255,255,255,0.14)',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: '11.5px',
              cursor: 'pointer',
            }}
          >
            查看分时
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          style={{
            padding: '4px 8px',
            borderRadius: '6px',
            border: 'none',
            background: 'transparent',
            color: '#fee2e2',
            fontWeight: 700,
            fontSize: '11.5px',
            cursor: 'pointer',
          }}
          title="确认已知晓本条 P0 警报"
        >
          已知晓 ✕
        </button>
      </div>
    </div>
  );
}
