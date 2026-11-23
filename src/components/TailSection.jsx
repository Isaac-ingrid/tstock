'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { f2, pct, money, toastOk, toastWarn, toastErr } from '../services/utils.js';
import { getUpcomingHolidayReminder, syncRemoteTradeCalendar, getCNClock, isAShareTradeDay } from '../services/calendar.js';
import { evaluatePreTradeHolidayGuard } from '../services/risk.js';
import { getTailBuyCandidates } from '../services/tail.js';
import {
  runTailScan,
  fetchIgnitionTracking,
  postIgnitionTrackingAction,
  loadLocalTrackedCodes,
} from '../services/api.js';
import { BoardStockActions } from './board/boardShared.jsx';
import DirectMoneyInput from './DirectMoneyInput.jsx';

export default function TailSection({
  pool = [],
  totalAssets,
  cash = null,
  currentMktVal = null,
  allowedCapPct = 80,
  actives = [],
  wbLatest,
  tiltState = null,
  onUpdateTotalAssets = null,
  onUpdateCash = null,
  onExecTailBuy,
  onExecTailExit,
  onRefreshContract,
  onAddStock,
  onSelectStock,
  onJumpIgnition,
  onTabChange,
  referenceDate = null,
}) {
  const assetsNum = Math.max(1, Number(totalAssets) || 100000);
  const tenPctBudget = assetsNum * 0.10;
  const allCandidates = useMemo(
    () => getTailBuyCandidates(wbLatest, { limit: 24, totalAssetsOverride: totalAssets }),
    [wbLatest, totalAssets]
  );
  const candidates = useMemo(() => allCandidates.slice(0, 2), [allCandidates]);
  const extraCandidates = useMemo(() => allCandidates.slice(2), [allCandidates]);
  const isTiltLocked = Boolean(tiltState?.isLocked);

  const [inputPrices, setInputPrices] = useState({});
  const [inputQtys, setInputQtys] = useState({});
  const [exitPrices, setExitPrices] = useState({});
  const [expandedExtraCode, setExpandedExtraCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [calTick, setCalTick] = useState(0);

  const [trackedCodes, setTrackedCodes] = useState(() => new Set(loadLocalTrackedCodes()));
  const [trackBusyCode, setTrackBusyCode] = useState('');

  useEffect(() => {
    let mounted = true;
    syncRemoteTradeCalendar().then(() => {
      if (mounted) setCalTick((t) => t + 1);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const holidayReminder = useMemo(
    () => getUpcomingHolidayReminder(referenceDate || new Date()),
    [referenceDate, calTick]
  );

  const effectiveCurrentMkt = useMemo(() => {
    if (currentMktVal != null && Number.isFinite(Number(currentMktVal))) {
      return Math.max(0, Number(currentMktVal));
    }
    const pMkt = (pool || []).reduce((acc, s) => acc + (+s.shares || 0) * (+s.price || +s.cost || 0), 0);
    const tMkt = (actives || []).reduce(
      (acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)),
      0
    );
    return Math.max(0, pMkt + tMkt);
  }, [currentMktVal, pool, actives]);

  const currentPosPct = +((effectiveCurrentMkt / assetsNum) * 100).toFixed(1);

  const inPoolCodes = useMemo(
    () => new Set((pool || []).map((s) => String(s.code).padStart(6, '0'))),
    [pool]
  );

  // 初始化同步后端在轨跟踪池名单，实现全站「📌跟踪 / ✓跟踪」状态一致
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchIgnitionTracking();
        if (!cancelled && res && res.ok && Array.isArray(res.items)) {
          setTrackedCodes((prev) => {
            const next = new Set([...prev, ...loadLocalTrackedCodes()]);
            res.items.forEach((it) => {
              if (it?.code) next.add(String(it.code).padStart(6, '0'));
            });
            return next;
          });
        }
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTrackAction = useCallback(async (action, stock) => {
    if (!stock || !stock.code) return;
    const c6 = String(stock.code).trim().padStart(6, '0');
    setTrackBusyCode(c6);
    try {
      const res = await postIgnitionTrackingAction({
        action,
        code: c6,
        name: stock.name || c6,
        hybk: stock.hybk || '尾盘黑马',
        price: +(stock.price || stock.cost || 0),
        strategy: 'tail_watch',
        subType: 'TAIL_WATCH',
        verdict: stock.verdict ? `尾盘黑马·${stock.verdict}` : '尾盘潜伏跟踪',
      });
      if (res && res.ok) {
        setTrackedCodes((prev) => {
          const next = new Set(prev);
          if (action === 'add') next.add(c6);
          else next.delete(c6);
          return next;
        });
        toastOk(
          action === 'add'
            ? `📌 已将 ${stock.name || c6} 加入在轨跟踪池（可在起爆挖掘·在轨跟踪持续监控）`
            : `已将 ${stock.name || c6} 移出跟踪池`
        );
      }
    } catch (err) {
      toastErr(`跟踪操作失败：${err.message}`);
    } finally {
      setTrackBusyCode('');
    }
  }, []);

  const handleJumpTracked = useCallback(() => {
    if (onTabChange) {
      onTabChange('/ignition');
    }
  }, [onTabChange]);

  const handleAddWatchInPlace = useCallback(
    (code, name, stockObj) => {
      if (!onAddStock) return;
      const c6 = String(code || '').trim().padStart(6, '0');
      const px = +(stockObj?.price || stockObj?.cost || 0);
      const tp1 = +(stockObj?.tp1 || (px > 0 ? (px * 1.025).toFixed(2) : 0));
      const tp2 = +(stockObj?.tp2 || (px > 0 ? (px * 1.045).toFixed(2) : 0));
      const stop = +(stockObj?.stop || (px > 0 ? (px * 0.985).toFixed(2) : 0));
      onAddStock(
        c6,
        {
          tier: 'short',
          strategyTag: '尾盘',
          strategy: 'tail',
          refPrice: px,
          stopPrice: stop,
          targetPrice: tp1,
          targetPrice2: tp2,
          advice: `尾盘潜伏观察：次日 09:30~10:00 冲高 ¥${f2(tp1)} (+2.5%) 兑现，跌破 ¥${f2(stop)} (-1.5%) 止损`,
        },
        { jumpToTrade: false }
      );
    },
    [onAddStock]
  );

  const now = referenceDate ? new Date(referenceDate) : new Date();
  const cnNow = getCNClock(now);
  const isTradeToday = isAShareTradeDay(now);
  const isTailTime = isTradeToday && cnNow.mins >= 870 && cnNow.mins < 895; // 14:30 - 14:55
  const isExitTime = isTradeToday && cnNow.mins >= 570 && cnNow.mins < 600; // 09:30 - 10:00

  const handlePriceChange = (code, val) => {
    setInputPrices((prev) => ({ ...prev, [code]: val }));
  };

  const handleQtyChange = (code, val) => {
    setInputQtys((prev) => ({ ...prev, [code]: val }));
  };

  const handleBuy = (cand, fallbackQty = null) => {
    if (isTiltLocked) {
      toastWarn('🔒 单日防上头熔断保护中：今日已锁定尾盘新开仓，防止亏损日尾盘博弈加码');
      return;
    }
    const px = parseFloat(inputPrices[cand.code]) || cand.price;
    const qty = parseInt(inputQtys[cand.code], 10) || fallbackQty || cand.recShares;
    const preGuard = evaluatePreTradeHolidayGuard({
      currentMkt: effectiveCurrentMkt,
      buyAmt: Math.max(0, (px || 0) * (qty || 0)),
      unitPrice: px,
      totalAssets: assetsNum,
      emotionCapPct: allowedCapPct,
      holidayReminder,
      isTailBuy: true,
      stockName: cand.name || cand.code,
    });
    if (preGuard.willExceedCap) {
      if (!window.confirm(preGuard.confirmPromptText)) {
        return;
      }
    }
    onExecTailBuy(cand, px, qty);
  };

  const handleManualScan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanStatus({
      type: 'info',
      text: '正在全市场实时抓取 5400+ 标的快照并计算 VWAP 均线承接…（约需 10~18 秒）',
    });
    try {
      const res = await runTailScan(true);
      if (res && res.ok) {
        setScanStatus({
          type: 'ok',
          text: `✅ 尾盘扫描完成！共精选出 ${res.count || 0} 只标的，契约已全量更新。`,
        });
        if (onRefreshContract) {
          await onRefreshContract();
        }
      } else {
        setScanStatus({
          type: 'warn',
          text: res?.message || '尾盘扫描返回繁忙，请稍后刷新重试',
        });
      }
    } catch (err) {
      setScanStatus({
        type: 'err',
        text: `尾盘扫描失败：${err.message}`,
      });
    } finally {
      setScanning(false);
    }
  };

  const holidayEffectiveCap = holidayReminder?.isHighAlert
    ? Math.min(allowedCapPct, holidayReminder.suggestedMaxPosPct || (holidayReminder.closedDays >= 7 ? 30 : 50))
    : allowedCapPct;

  return (
    <section id="secTailBuy" className="tail-section" style={{ marginTop: '8px' }}>
      <div className="tail-head-bar">
        <div className="th-title-box">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span>⚡</span>
            <span>尾盘黑马 T+0 潜伏台（14:30~14:55 隔夜战法）</span>
            {allCandidates.length > 0 && (
              <span
                style={{
                  fontSize: '11.5px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  background: 'var(--down-bg)',
                  color: 'var(--down-d)',
                  border: '1px solid var(--down-b)',
                  fontWeight: 700,
                }}
              >
                今日达标 {allCandidates.length} 只
              </span>
            )}
          </h3>
          <p className="th-sub">
            精选 TOP 1~2 主力潜伏卡 + 全量达标备选池 ｜ 支持原位加入自选、加入在轨跟踪与一键试算建仓
          </p>
        </div>

        <div className="thb-sub" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {isTailTime ? (
            <span className="tb-status-pill live">🟢 14:30-14:55 尾盘潜伏窗口生效中</span>
          ) : isExitTime ? (
            <span className="tb-status-pill exit">🚨 09:30-10:00 早盘冲高止盈窗口生效中</span>
          ) : (
            <span className="tb-status-pill idle">💡 盘中雷达监控中（每日 14:30 自动筛选黑马）</span>
          )}

          {wbLatest?.tailMeta && (
            <span
              style={{
                fontSize: '11.5px',
                color: 'var(--mute)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <span>🕒</span>
              <span>
                已更新: {wbLatest.tailMeta.date} {wbLatest.tailMeta.scanTime}
              </span>
            </span>
          )}

          <button
            type="button"
            onClick={handleManualScan}
            disabled={scanning}
            className="tail-rescan-btn"
            title="手动触发全市场5000+标的实时选股扫描并更新契约"
          >
            <span style={{ display: 'inline-block', animation: scanning ? 'spin 1s linear infinite' : 'none' }}>
              ⟳
            </span>
            <span>{scanning ? '正在全量重扫 5400+ 标的…' : '立即重扫今日尾盘黑马'}</span>
          </button>
        </div>
      </div>

      {isTiltLocked && (
        <div className="tilt-lock-banner" style={{ marginBottom: '12px' }}>
          <div className="tilt-lock-txt">
            <b>🛑 单日防上头熔断锁已激活：</b>
            {(tiltState?.reasons || []).join('；')}。已自动锁定「尾盘新开潜伏仓」，严防日内连亏后尾盘重仓博傻；上方已有隔夜持仓的
            <b>「⚡ 平仓回笼现金」不受影响</b>。
          </div>
        </div>
      )}

      {/* 连续≥3天长假前1-2个交易日：尾盘潜伏跨假锁仓与控仓黄牌提醒横幅 */}
      {!isTiltLocked && holidayReminder?.isHighAlert && (
        <div
          className={`pr-holiday-warn-bar ${holidayReminder.remainingTradeDays === 1 ? 'is-final' : ''}`}
          style={{ marginBottom: '12px' }}
        >
          <div className="pr-hw-main">
            <span className="pr-hw-badge">
              🟨 {holidayReminder.remainingTradeDays === 1 ? '尾盘跨假锁仓黄牌' : '节前尾盘控仓提醒'}
            </span>
            <span className="pr-hw-txt">
              距<b>{holidayReminder.holidayName}</b>连休 <b>{holidayReminder.closedDays}天</b>（
              {holidayReminder.closureStart.slice(5)}~{holidayReminder.closureEnd.slice(5)}，
              {holidayReminder.reopenDate.slice(5)} 开市）仅剩 <b>{holidayReminder.remainingTradeDays}</b> 个交易日；
              当前账户总仓位 <b>{currentPosPct.toFixed(1)}%</b>，节前建议上限 <b>≤{holidayEffectiveCap}%</b>。
              {holidayReminder.remainingTradeDays === 1
                ? ` 今日尾盘买入受 T+1 限制将无法「次日早盘冲高兑现」，筹码需锁定跨越整个 ${holidayReminder.closedDays} 天长假至 ${holidayReminder.reopenDate.slice(5)} 开市；若买后总仓超上限将触发二次确认。`
                : ` 明日即为节前收官日，尾盘隔夜仓易受节前兑现抛压影响，买后总仓若超 ≤${holidayEffectiveCap}% 上限将触发二次确认。`}
            </span>
          </div>
        </div>
      )}

      {scanStatus && (
        <div
          style={{
            marginBottom: '12px',
            padding: '7px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: 1.5,
            background:
              scanStatus.type === 'ok'
                ? 'var(--down-bg)'
                : scanStatus.type === 'err'
                ? 'var(--up-bg)'
                : 'var(--info-bg)',
            color:
              scanStatus.type === 'ok'
                ? 'var(--down)'
                : scanStatus.type === 'err'
                ? 'var(--up)'
                : 'var(--accent)',
            border: `1px solid ${
              scanStatus.type === 'ok'
                ? 'var(--down-b)'
                : scanStatus.type === 'err'
                ? 'var(--up-b)'
                : 'var(--info-b)'
            }`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>{scanStatus.text}</span>
          <button
            type="button"
            onClick={() => setScanStatus(null)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: '15px',
              minHeight: '24px',
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="tail-budget-strip">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          当前总资产:{' '}
          {onUpdateTotalAssets ? (
            <DirectMoneyInput
              value={totalAssets || 0}
              onCommit={onUpdateTotalAssets}
              min={100}
              allowZero={false}
              size="sm"
              ariaLabel="尾盘页当前总资产输入"
              title="点击直接修改当前总资产，10%潜伏预算实时重算"
            />
          ) : (
            <b>¥{Math.round(totalAssets || 0).toLocaleString('zh-CN')}</b>
          )}
        </span>
        <span className="tbs-dot">·</span>
        {cash != null && (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              可用现金:{' '}
              {onUpdateCash ? (
                <DirectMoneyInput
                  value={cash}
                  onCommit={onUpdateCash}
                  min={0}
                  allowZero={true}
                  size="sm"
                  tone={cash >= tenPctBudget ? 'cash' : 'accent'}
                  ariaLabel="尾盘页可用现金输入"
                  title="点击直接修改可用现金"
                />
              ) : (
                <b style={{ color: cash >= tenPctBudget ? 'var(--down)' : 'var(--up)' }}>
                  ¥{Math.round(cash).toLocaleString('zh-CN')}
                </b>
              )}
            </span>
            <span className="tbs-dot">·</span>
          </>
        )}
        <span>
          10% 顶格潜伏预算:{' '}
          <b style={{ color: 'var(--accent)' }}>¥{Math.round(tenPctBudget).toLocaleString('zh-CN')}</b>
        </span>
        <span className="tbs-dot">·</span>
        <span>
          策略纪律: <b>单票上限 10% ｜ 绝不过夜加仓，次日 10:00 前必平</b>
        </span>
      </div>

      {/* 1. 正在持仓中的隔夜标的 */}
      {actives && actives.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <h4
            style={{
              fontSize: '13.5px',
              marginBottom: '8px',
              color: 'var(--up)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
            }}
          >
            <span>🚨</span>
            <span>当前隔夜尾盘持仓（已纳入总资产与仓位风控，次日 09:30~10:00 冲高必平）：</span>
          </h4>
          <div className="tail-active-grid">
            {actives.map((act) => {
              const code6 = String(act.code || '').padStart(6, '0');
              const livePx = +act.price > 0 ? +act.price : +act.cost;
              const exitVal = exitPrices[act.id] !== undefined ? exitPrices[act.id] : livePx;
              const chg = act.cost > 0 ? ((livePx - act.cost) / act.cost) * 100 : 0;
              const pnl = (livePx - act.cost) * act.shares;

              return (
                <div
                  key={act.id}
                  className="card tail-active-card"
                  style={{
                    padding: '12px 14px',
                    marginBottom: 0,
                    borderLeft: '4px solid var(--accent)',
                    background: 'var(--surface2)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                      marginBottom: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text)' }}>{act.name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--mute)' }}>
                        {code6}
                      </span>
                      <span className="tag" style={{ background: 'var(--card)', fontSize: '11px', padding: '1px 8px' }}>
                        现价 ¥{f2(livePx)}
                      </span>
                    </div>

                    <BoardStockActions
                      stock={{ ...act, code: code6, price: livePx }}
                      inPoolCodes={inPoolCodes}
                      herdCodeSet={trackedCodes}
                      herdBusyCode={trackBusyCode}
                      onHerdAction={handleTrackAction}
                      onJumpHerd={handleJumpTracked}
                      onAddSingle={handleAddWatchInPlace}
                      onSelectStock={onSelectStock}
                      onJumpIgnition={onJumpIgnition}
                      allowAllBoardsTrack
                      trackTitle="加入在轨跟踪池"
                      trackedTitle="已在在轨跟踪池，点击前往查看"
                      compact
                    />
                  </div>

                  <div className="tail-active-kpis">
                    <div>
                      买入成本: <b>¥{f2(act.cost)}</b>
                    </div>
                    <div>
                      持仓股数: <b>{act.shares}</b> 股
                    </div>
                    <div>
                      浮动盈亏:{' '}
                      <b className={pnl >= 0 ? 'up' : 'down'}>
                        {pnl >= 0 ? '+' : ''}¥{money(pnl)} ({pct(chg)})
                      </b>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                      borderTop: '1px dashed var(--line)',
                      paddingTop: '8px',
                    }}
                  >
                    <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                      止盈目标: <b>{act.tp1 ? `¥{f2(act.tp1)} (+2.5%)`.replace('{f2(act.tp1)}', f2(act.tp1)) : '冲高 +2.5%'}</b>
                      {act.stop ? ` ｜ 止损 ¥${f2(act.stop)}` : ''}
                    </span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <input
                        type="number"
                        step="0.01"
                        className="trc-sell-inp"
                        value={exitVal}
                        onChange={(e) => setExitPrices((prev) => ({ ...prev, [act.id]: e.target.value }))}
                        title="卖出成交价"
                      />
                      <button
                        type="button"
                        className="primary"
                        onClick={() => onExecTailExit(act, parseFloat(exitVal) || livePx)}
                        style={{ padding: '5px 12px', fontSize: '12px', minHeight: '32px', borderRadius: '6px' }}
                      >
                        ⚡ 平仓回笼现金
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. TOP 1~2 主推候选黑马卡片网格 */}
      <div className="tail-cards-grid">
        {candidates.length === 0 ? (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '32px 18px',
              textAlign: 'center',
              background: 'var(--surface2)',
              borderRadius: '9px',
              border: '1px dashed var(--line)',
              color: 'var(--sub)',
            }}
          >
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>🛡️</div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text)', marginBottom: '8px' }}>
              今日尾盘无符合硬闸门的黑马标的（宁缺毋滥）
            </div>
            <div style={{ fontSize: '12.5px', maxWidth: '560px', margin: '0 auto', lineHeight: 1.6, color: 'var(--mute)' }}>
              尾盘黑马战法遵循严格量化门槛（涨幅 3%~7%、量比 ≥ 1.2、分时均线上方占比 ≥ 80%、尾盘无高位跳水回落、排除 ST）。
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
                background: scanning ? 'var(--surface2)' : 'var(--card)',
                color: 'var(--accent)',
                cursor: scanning ? 'not-allowed' : 'pointer',
              }}
            >
              {scanning ? '⏳ 正在全市场全量扫描…' : '⟳ 立即重新扫描全市场'}
            </button>
          </div>
        ) : (
          candidates.map((cand) => {
            const defaultPrice = inputPrices[cand.code] !== undefined ? inputPrices[cand.code] : cand.price;
            const defaultQty = inputQtys[cand.code] !== undefined ? inputQtys[cand.code] : cand.recShares;
            const curBuyPx = parseFloat(defaultPrice) || cand.price || 0;
            const curBuyQty = parseInt(defaultQty, 10) || 0;
            const candHolidayGuard = evaluatePreTradeHolidayGuard({
              currentMkt: effectiveCurrentMkt,
              buyAmt: Math.max(0, curBuyPx * curBuyQty),
              unitPrice: curBuyPx,
              totalAssets: assetsNum,
              emotionCapPct: allowedCapPct,
              holidayReminder,
              isTailBuy: true,
              stockName: cand.name,
            });

            return (
              <div key={cand.code} className={`tail-cand-card ${cand.rankClass}`}>
                <div className="tcc-head">
                  <div className="tcc-head-left">
                    <span className="tcc-rank-title">{cand.rankTitle}</span>
                    <b className="tcc-name">{cand.name}</b>
                    <span className="tcc-code">{cand.code}</span>
                    <span className="tcc-score-badge">
                      量化 {cand.score}分 · {cand.verdict}
                    </span>
                  </div>
                  <BoardStockActions
                    stock={cand}
                    inPoolCodes={inPoolCodes}
                    herdCodeSet={trackedCodes}
                    herdBusyCode={trackBusyCode}
                    onHerdAction={handleTrackAction}
                    onJumpHerd={handleJumpTracked}
                    onAddSingle={handleAddWatchInPlace}
                    onSelectStock={onSelectStock}
                    onJumpIgnition={onJumpIgnition}
                    allowAllBoardsTrack
                    trackTitle="加入在轨跟踪池"
                    trackedTitle="已在在轨跟踪池，点击前往查看"
                    compact
                  />
                </div>

                <div className="tcc-kpis">
                  <div className="tcc-kpi">
                    <span className="k">潜伏参考价</span>
                    <span className="v">¥{f2(cand.price)}</span>
                  </div>
                  <div className="tcc-kpi">
                    <span className="k">日内涨幅</span>
                    <span className="v" style={{ color: cand.chgPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                      {cand.chgPct >= 0 ? '+' : ''}
                      {cand.chgPct.toFixed(2)}%
                    </span>
                  </div>
                  <div className="tcc-kpi">
                    <span className="k">均线上运行</span>
                    <span className="v">{cand.vwapOnline.toFixed(0)}%</span>
                  </div>
                  <div className="tcc-kpi">
                    <span className="k">14点后量比</span>
                    <span className="v">{cand.volRatio.toFixed(2)}x</span>
                  </div>
                  <div className="tcc-kpi">
                    <span className="k">日内换手</span>
                    <span className="v">{cand.turnover.toFixed(1)}%</span>
                  </div>
                  <div className="tcc-kpi">
                    <span className="k">距涨停空间</span>
                    <span className="v">
                      {cand.limitRoom != null ? `${cand.limitRoom.toFixed(2)}%` : '充裕'}
                    </span>
                  </div>
                </div>

                <div className="tcc-sizing-box">
                  <div className="tcc-sz-row">
                    🎯 顶格 10% 建议：<b>{cand.recShares} 股</b>（约 ¥
                    {Math.round(cand.recShares * cand.price).toLocaleString('zh-CN')}，占 {cand.actualPct}%）｜ 稳健半仓：
                    <b>{cand.halfShares} 股</b>
                  </div>
                  <div className="tcc-sz-targets">
                    <span>
                      止盈目标: <b style={{ color: 'var(--up)' }}>¥{f2(cand.tp1)} (+2.5%)</b> /{' '}
                      <b style={{ color: 'var(--up)' }}>¥{f2(cand.tp2)} (+4.5%)</b>
                    </span>
                    <span>·</span>
                    <span>
                      纪律止损: <b style={{ color: 'var(--down)' }}>¥{f2(cand.stop)} (-1.5%)</b>
                    </span>
                  </div>
                </div>

                <div className="tcc-reasons">
                  {cand.whyReasons.map((reason, rIdx) => (
                    <div key={rIdx} className="tcc-reason-item">
                      · {reason}
                    </div>
                  ))}
                </div>

                {!isTiltLocked && candHolidayGuard.willExceedCap && (
                  <div className="bcc-holiday-warn" style={{ marginBottom: '8px' }}>
                    <div>
                      🟨 <b>节前控仓黄牌：</b>买后总仓将由 <b>{candHolidayGuard.beforePosPct.toFixed(1)}%</b> 升至{' '}
                      <b>{candHolidayGuard.afterPosPct.toFixed(1)}%</b>，超出{candHolidayGuard.capSourceLabel}{' '}
                      <b>{candHolidayGuard.overPct}%</b>
                      {candHolidayGuard.remainingTradeDays === 1
                        ? `（今日买单将跨假锁仓 ${candHolidayGuard.closedDays} 天至 ${candHolidayGuard.reopenDate.slice(5)} 开市）`
                        : ''}
                    </div>
                    <div className="bcc-hw-row">
                      <span>{candHolidayGuard.safeCapHint}</span>
                      {candHolidayGuard.maxSafeShares >= 100 && (
                        <button
                          type="button"
                          className="bcc-chip holiday-cap"
                          onClick={() => handleQtyChange(cand.code, candHolidayGuard.maxSafeShares)}
                        >
                          按节前上限({candHolidayGuard.maxSafeShares}股)
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="tcc-act-bar">
                  <div className="tcc-inputs">
                    <div className="tcc-inp-row">
                      <span className="k">买入价 ¥</span>
                      <input
                        type="number"
                        step="0.01"
                        className="tcc-inp"
                        value={defaultPrice}
                        onChange={(e) => handlePriceChange(cand.code, e.target.value)}
                      />
                    </div>
                    <div className="tcc-inp-row">
                      <span className="k">股数</span>
                      <input
                        type="number"
                        step="100"
                        className="tcc-inp qty"
                        value={defaultQty}
                        onChange={(e) => handleQtyChange(cand.code, e.target.value)}
                      />
                    </div>
                    <div className="tcc-pills">
                      <button
                        type="button"
                        className="tcc-pill"
                        onClick={() => handleQtyChange(cand.code, cand.recShares)}
                      >
                        10%({cand.recShares})
                      </button>
                      <button
                        type="button"
                        className="tcc-pill"
                        onClick={() => handleQtyChange(cand.code, cand.halfShares)}
                      >
                        5%({cand.halfShares})
                      </button>
                      <button
                        type="button"
                        className="tcc-pill"
                        onClick={() => handleQtyChange(cand.code, 100)}
                      >
                        1手
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-tb-buy"
                    onClick={() => handleBuy(cand, cand.recShares)}
                    style={
                      isTiltLocked
                        ? {
                            background: 'var(--up-bg)',
                            color: 'var(--up-d)',
                            border: '1px solid var(--up-b)',
                            cursor: 'not-allowed',
                          }
                        : candHolidayGuard.willExceedCap
                        ? {
                            background: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)',
                            color: '#fff',
                            border: '1px solid #b45309',
                          }
                        : undefined
                    }
                  >
                    {isTiltLocked
                      ? '🔒 熔断期禁开尾盘仓'
                      : candHolidayGuard.willExceedCap
                      ? '🟨 节前超上限 · 二次确认建仓'
                      : '🚀 一键执行尾盘潜伏建仓'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 3. 其余全部达标尾盘备选池（彻底解决扫描出 >2 只黑马却只显示前 2 只的隐藏问题） */}
      {extraCandidates.length > 0 && (
        <div className="tail-extra-pool-box">
          <div className="tepb-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <b style={{ fontSize: '13.5px', color: 'var(--text)' }}>
                📋 其余达标尾盘备选池（共 {extraCandidates.length} 只）
              </b>
              <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                均已通过尾盘硬闸门筛选，支持一键原位加入自选、加入跟踪或展开建仓
              </span>
            </div>
          </div>

          <div className="tail-extra-list">
            {extraCandidates.map((cand) => {
              const isOpen = expandedExtraCode === cand.code;
              const defaultPrice = inputPrices[cand.code] !== undefined ? inputPrices[cand.code] : cand.price;
              const defaultQty = inputQtys[cand.code] !== undefined ? inputQtys[cand.code] : cand.halfShares;
              const curBuyPx = parseFloat(defaultPrice) || cand.price || 0;
              const curBuyQty = parseInt(defaultQty, 10) || 0;
              const extraHolidayGuard = isOpen
                ? evaluatePreTradeHolidayGuard({
                    currentMkt: effectiveCurrentMkt,
                    buyAmt: Math.max(0, curBuyPx * curBuyQty),
                    unitPrice: curBuyPx,
                    totalAssets: assetsNum,
                    emotionCapPct: allowedCapPct,
                    holidayReminder,
                    isTailBuy: true,
                    stockName: cand.name,
                  })
                : null;

              return (
                <div key={cand.code} className="tail-extra-row">
                  <div className="ter-main">
                    <div className="ter-ident">
                      <span className="ter-rank">#{cand.rank}</span>
                      <b className="ter-name">{cand.name}</b>
                      <span className="ter-code">{cand.code}</span>
                      <span className="ter-score">
                        {cand.score}分 · {cand.verdict}
                      </span>
                    </div>

                    <div className="ter-metrics">
                      <span>
                        参考价 <b style={{ fontFamily: 'monospace' }}>¥{f2(cand.price)}</b>{' '}
                        <b style={{ color: cand.chgPct >= 0 ? 'var(--up)' : 'var(--down)', fontFamily: 'monospace' }}>
                          ({cand.chgPct >= 0 ? '+' : ''}
                          {cand.chgPct.toFixed(2)}%)
                        </b>
                      </span>
                      <span>均线上 {cand.vwapOnline.toFixed(0)}%</span>
                      <span>量比 {cand.volRatio.toFixed(2)}x</span>
                      <span>换手 {cand.turnover.toFixed(1)}%</span>
                      <span style={{ color: 'var(--up)' }}>目标 ¥{f2(cand.tp1)}</span>
                    </div>

                    <div className="ter-actions">
                      <BoardStockActions
                        stock={cand}
                        inPoolCodes={inPoolCodes}
                        herdCodeSet={trackedCodes}
                        herdBusyCode={trackBusyCode}
                        onHerdAction={handleTrackAction}
                        onJumpHerd={handleJumpTracked}
                        onAddSingle={handleAddWatchInPlace}
                        onSelectStock={onSelectStock}
                        onJumpIgnition={onJumpIgnition}
                        allowAllBoardsTrack
                        trackTitle="加入在轨跟踪池"
                        trackedTitle="已在在轨跟踪池，点击前往查看"
                        compact
                        extraActions={
                          <button
                            type="button"
                            className="board-act-btn score"
                            onClick={() => setExpandedExtraCode(isOpen ? '' : cand.code)}
                            title="展开快捷尾盘建仓栏"
                          >
                            {isOpen ? '▲收起' : '⚡建仓'}
                          </button>
                        }
                      />
                    </div>
                  </div>

                  {isOpen && (
                    <div className="ter-buy-drawer">
                      {!isTiltLocked && extraHolidayGuard?.willExceedCap && (
                        <div className="bcc-holiday-warn" style={{ marginBottom: '8px' }}>
                          <div>
                            🟨 <b>节前控仓黄牌：</b>买后总仓将由 <b>{extraHolidayGuard.beforePosPct.toFixed(1)}%</b> 升至{' '}
                            <b>{extraHolidayGuard.afterPosPct.toFixed(1)}%</b>，超出{extraHolidayGuard.capSourceLabel}{' '}
                            <b>{extraHolidayGuard.overPct}%</b>
                          </div>
                          <div className="bcc-hw-row">
                            <span>{extraHolidayGuard.safeCapHint}</span>
                            {extraHolidayGuard.maxSafeShares >= 100 && (
                              <button
                                type="button"
                                className="bcc-chip holiday-cap"
                                onClick={() => handleQtyChange(cand.code, extraHolidayGuard.maxSafeShares)}
                              >
                                按节前上限({extraHolidayGuard.maxSafeShares}股)
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="tcc-inputs">
                        <div className="tcc-inp-row">
                          <span className="k">买入价 ¥</span>
                          <input
                            type="number"
                            step="0.01"
                            className="tcc-inp"
                            value={defaultPrice}
                            onChange={(e) => handlePriceChange(cand.code, e.target.value)}
                          />
                        </div>
                        <div className="tcc-inp-row">
                          <span className="k">股数</span>
                          <input
                            type="number"
                            step="100"
                            className="tcc-inp qty"
                            value={defaultQty}
                            onChange={(e) => handleQtyChange(cand.code, e.target.value)}
                          />
                        </div>
                        <div className="tcc-pills">
                          <button
                            type="button"
                            className="tcc-pill"
                            onClick={() => handleQtyChange(cand.code, cand.recShares)}
                          >
                            10%({cand.recShares})
                          </button>
                          <button
                            type="button"
                            className="tcc-pill"
                            onClick={() => handleQtyChange(cand.code, cand.halfShares)}
                          >
                            5%({cand.halfShares})
                          </button>
                          <button
                            type="button"
                            className="tcc-pill"
                            onClick={() => handleQtyChange(cand.code, 100)}
                          >
                            1手
                          </button>
                        </div>
                        <button
                          type="button"
                          className="btn-tb-buy"
                          onClick={() => handleBuy(cand, cand.halfShares)}
                          style={{
                            padding: '5px 14px',
                            minHeight: '30px',
                            marginLeft: 'auto',
                            ...(isTiltLocked
                              ? {
                                  background: 'var(--up-bg)',
                                  color: 'var(--up-d)',
                                  border: '1px solid var(--up-b)',
                                  cursor: 'not-allowed',
                                }
                              : extraHolidayGuard?.willExceedCap
                              ? {
                                  background: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)',
                                  color: '#fff',
                                  border: '1px solid #b45309',
                                }
                              : {}),
                          }}
                        >
                          {isTiltLocked
                            ? '🔒 熔断禁买'
                            : extraHolidayGuard?.willExceedCap
                            ? `🟨 二次确认买 ${cand.name}`
                            : `🚀 确认买入 ${cand.name}`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
