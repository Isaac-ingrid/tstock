import React, { useState, useEffect, useMemo, useRef } from 'react';
import { f2, pct, money, todayStr } from '../services/utils.js';
import { tRealOf } from '../services/api.js';
import { syncRemoteTradeCalendar } from '../services/calendar.js';
import { evaluateAccountHolidayWatermark } from '../services/risk.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';

export default function AccountSection({
  totalAssets = 100000,
  initialCapital = 100000,
  marketValue = 0,
  poolMarketValue = 0,
  tailMarketValue = 0,
  posRate = 0,
  allowedCapPct = 80,
  cash = 0,
  referenceDate = null,
  pool = [],
  tailActives = [],
  tradeLogs = [],
  snapshots = [],
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
  onSelectStock,
  onJumpDiagnosis,
  onTabChange,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [calTick, setCalTick] = useState(0);
  const svgRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    syncRemoteTradeCalendar().then(() => {
      if (mounted) setCalTick((t) => t + 1);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const effEmotionCap = Number.isFinite(+allowedCapPct) && +allowedCapPct > 0 ? +allowedCapPct : 80;
  const holidayWm = useMemo(
    () =>
      evaluateAccountHolidayWatermark({
        totalAssets,
        marketValue,
        cash,
        posRate,
        emotionCapPct: effEmotionCap,
        now: referenceDate || new Date(),
      }),
    [totalAssets, marketValue, cash, posRate, effEmotionCap, referenceDate, calTick]
  );

  const activeTails = useMemo(
    () => (tailActives || []).filter(t => t && t.status !== 'closed' && (+t.shares || 0) > 0),
    [tailActives]
  );

  // 实时盈亏归因汇总：持仓浮盈 + 尾盘浮盈 + 累计做T套利 + 相对本金净增减
  const summary = useMemo(() => {
    let floatPL = 0;
    (pool || []).forEach((s) => {
      const sh = +s.shares || 0;
      const px = +s.price || +s.cost || 0;
      const cost = +s.cost || 0;
      if (sh > 0 && cost > 0) {
        floatPL += (px - cost) * sh;
      }
    });
    activeTails.forEach((t) => {
      const sh = +t.shares || 0;
      const px = +t.price || +t.cost || 0;
      const cost = +t.cost || 0;
      if (sh > 0 && cost > 0) {
        floatPL += (px - cost) * sh;
      }
    });

    const nonTDirs = new Set(['买入建仓', '买入加仓', '直接买入', '直接卖出', '清仓卖出', '尾盘买入', '尾盘平仓']);
    let realizedT = 0;
    let tCount = 0;
    let tailRealized = 0;
    (tradeLogs || []).forEach((r) => {
      if (!r) return;
      const dir = String(r.dir || '');
      const net = Number(r.net) || 0;
      if (dir === '正T' || dir === '倒T' || dir === '做T' || (+r.buy > 0 && +r.sell > 0 && !nonTDirs.has(dir))) {
        realizedT += net;
        tCount += 1;
      } else if (dir === '尾盘平仓') {
        tailRealized += net;
      }
    });

    const baseCap = +initialCapital > 0 ? +initialCapital : +totalAssets || 100000;
    const totalReturn = totalAssets - baseCap;
    const totalReturnPct = baseCap > 0 ? (totalReturn / baseCap) * 100 : 0;

    return {
      floatPL,
      realizedT,
      tCount,
      tailRealized,
      baseCap,
      totalReturn,
      totalReturnPct,
    };
  }, [pool, activeTails, tradeLogs, totalAssets, initialCapital]);

  // 构造净值与仓位时间序列（历史快照按日期升序 + 今日实时点位）
  const curveSeries = useMemo(() => {
    const map = new Map();
    (snapshots || []).forEach((s) => {
      if (s && s.date && +s.total > 0) {
        map.set(String(s.date), {
          date: String(s.date),
          total: +s.total,
          mkt: +s.mkt || 0,
          cash: +s.cash || Math.max(0, +s.total - (+s.mkt || 0)),
          rate: +s.rate || ((+s.mkt || 0) / +s.total) * 100,
          live: false,
        });
      }
    });
    const today = todayStr();
    map.set(today, {
      date: today,
      total: Math.round(totalAssets * 100) / 100,
      mkt: Math.round(marketValue * 100) / 100,
      cash: Math.round(cash * 100) / 100,
      rate: +posRate.toFixed(1),
      live: true,
    });

    const pts = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    let peak = 0;
    let maxDD = 0;
    pts.forEach((p) => {
      if (p.total > peak) peak = p.total;
      if (peak > 0) {
        const dd = ((peak - p.total) / peak) * 100;
        if (dd > maxDD) maxDD = dd;
      }
    });
    return { pts, maxDD };
  }, [snapshots, totalAssets, marketValue, cash, posRate]);

  // SVG 曲线几何计算
  const chartGeom = useMemo(() => {
    const pts = curveSeries.pts;
    if (!pts.length) return null;
    const W = 760;
    const H = 210;
    const PL = 62;
    const PR = 42;
    const PT = 18;
    const PB = 30;
    const iw = W - PL - PR;
    const ih = H - PT - PB;

    const vals = pts.map((p) => p.total).concat([summary.baseCap]);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < Math.max(500, hi * 0.02)) {
      const pad = Math.max(500, hi * 0.02);
      hi += pad;
      lo = Math.max(0, lo - pad);
    } else {
      const pad = (hi - lo) * 0.14;
      hi += pad;
      lo = Math.max(0, lo - pad);
    }

    const X = (i) => (pts.length === 1 ? PL + iw / 2 : PL + (i / (pts.length - 1)) * iw);
    const Y = (v) => PT + ((hi - v) / (hi - lo || 1)) * ih;
    const YRate = (r) => PT + ih - (Math.min(100, Math.max(0, r)) / 100) * (ih * 0.45);

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(p.total).toFixed(1)}`).join(' ');
    const areaPath =
      pts.length > 1
        ? `${linePath} L${X(pts.length - 1).toFixed(1)},${(PT + ih).toFixed(1)} L${X(0).toFixed(1)},${(PT + ih).toFixed(1)} Z`
        : '';

    return { W, H, PL, PR, PT, PB, iw, ih, lo, hi, X, Y, YRate, linePath, areaPath };
  }, [curveSeries.pts, summary.baseCap]);

  // 支持手机触屏在净值曲线上横向滑动查点
  const handleEquityTouch = (e) => {
    const pts = curveSeries.pts || [];
    if (pts.length < 2 || !svgRef.current || !chartGeom) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((touch.clientX - rect.left) / rect.width) * chartGeom.W;
    const ratio = Math.max(0, Math.min(1, (svgX - chartGeom.PL) / (chartGeom.iw || 1)));
    const nearestIdx = Math.round(ratio * (pts.length - 1));
    setHoverIdx(nearestIdx);
  };

  const activePoint = hoverIdx != null && curveSeries.pts[hoverIdx] ? curveSeries.pts[hoverIdx] : curveSeries.pts[curveSeries.pts.length - 1];
  const holdingCostRows = useMemo(
    () => (pool || []).filter((s) => (+s.shares || 0) > 0 || tRealOf(s.code, tradeLogs).n > 0),
    [pool, tradeLogs]
  );

  return (
    <div id="accSec">
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <h2 style={{ margin: 0 }}>三、账户真实总账、可用现金与净值曲线</h2>
          <span style={{ fontSize: '12px', color: 'var(--mute)' }}>
            口径：<b>实时总资产 = 真实可用现金 + 自选持仓市值 + 尾盘隔夜市值</b>（买卖与做T自动增减现金）
          </span>
        </div>

        {/* 核心 5 维资金卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {/* 1. 实时总资产（直接点击输入框输入，回车或失焦自动保存） */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)', marginBottom: 0 }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>实时账户总资产（直接输入）</span>
              <span className={summary.totalReturn >= 0 ? 'up' : 'down'} style={{ fontWeight: 700 }}>
                {summary.totalReturn >= 0 ? '+' : ''}{summary.totalReturnPct.toFixed(2)}%
              </span>
            </div>
            <div style={{ marginTop: '6px' }}>
              <DirectMoneyInput
                value={totalAssets}
                onCommit={onUpdateTotalAssets}
                min={0}
                allowZero={true}
                size="hero"
                ariaLabel="实时账户总资产输入"
                title="直接点击输入券商账户总资产（支持如 200000 或 20w，回车或失焦自动保存）"
              />
            </div>
            <div className="dm-preset-row">
              {[50000, 100000, 200000, 500000, 1000000].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`dm-preset-chip ${Math.abs(totalAssets - preset) < 1 ? 'active' : ''}`}
                  onClick={() => onUpdateTotalAssets && onUpdateTotalAssets(preset)}
                >
                  {preset >= 10000 ? `${preset / 10000}万` : preset}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)', marginTop: '6px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
              <span>初始本金</span>
              <DirectMoneyInput
                value={summary.baseCap}
                onCommit={onUpdateInitialCapital || onUpdateTotalAssets}
                min={100}
                allowZero={false}
                size="sm"
                ariaLabel="初始投入本金输入"
                title="点击直接修改初始投入本金（用于核算累计净盈亏与总收益率）"
              />
              <span>· 净盈亏</span>
              <b className={summary.totalReturn >= 0 ? 'up' : 'down'}>
                {summary.totalReturn >= 0 ? '+' : ''}¥{money(summary.totalReturn)}
              </b>
            </div>
          </div>

          {/* 2. 真实可用现金（直接点击输入框输入） */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)', marginBottom: 0 }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>真实可用现金（直接输入）</span>
              <span style={{ fontSize: '11px', color: 'var(--mute)' }}>可挂买单</span>
            </div>
            <div style={{ marginTop: '6px' }}>
              <DirectMoneyInput
                value={cash}
                onCommit={onUpdateCash}
                min={0}
                allowZero={true}
                size="hero"
                tone="cash"
                ariaLabel="真实可用现金输入"
                title="直接点击输入券商可用现金（支持如 85000 或 8.5w，回车或失焦自动保存）"
              />
            </div>
            <div className="dm-preset-row">
              {[
                { label: '清零', val: 0 },
                { label: '5万', val: 50000 },
                { label: '10万', val: 100000 },
                { label: '20万', val: 200000 },
                { label: '50万', val: 500000 },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={`dm-preset-chip ${Math.abs(cash - item.val) < 1 ? 'active' : ''}`}
                  onClick={() => onUpdateCash && onUpdateCash(item.val)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '6px' }}>
              独立持久记账，股价涨跌不再虚增或吞噬现金
            </div>
          </div>

          {/* 3. 持仓总市值（含尾盘隔夜） */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)', marginBottom: 0 }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
              <span>持仓总市值（含尾盘）</span>
              {activeTails.length > 0 && onTabChange && (
                <button
                  type="button"
                  className="board-mini-pill-btn track"
                  onClick={() => onTabChange('/tail')}
                  title="跳转尾盘潜伏台平仓管理"
                >
                  ⚡尾盘{activeTails.length}只 →
                </button>
              )}
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}>
              ¥{money(marketValue)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
              主池 ¥{money(poolMarketValue)}
              {tailMarketValue > 0 ? ` · ⚡尾盘 ¥${money(tailMarketValue)}` : ' · 无尾盘隔夜仓'}
            </div>
          </div>

          {/* 4. 实际总仓位 & 节前控仓水位刻度 */}
          <div
            className="card"
            style={{
              padding: '14px',
              background: holidayWm.isYellowCard ? '#fffbeb' : 'var(--surface2)',
              border: holidayWm.isYellowCard ? '1px solid #f59e0b' : undefined,
              marginBottom: 0,
            }}
          >
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
              <span>实际股票总仓位</span>
              <span
                style={{
                  fontSize: '10.5px',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  fontWeight: 700,
                  background: holidayWm.isYellowCard ? '#fef3c7' : holidayWm.showChartLine ? '#ecfdf5' : 'var(--surface)',
                  color: holidayWm.isYellowCard ? '#b45309' : holidayWm.showChartLine ? '#047857' : 'var(--mute)',
                  border: `1px solid ${holidayWm.isYellowCard ? '#fcd34d' : holidayWm.showChartLine ? '#a7f3d0' : 'var(--line)'}`,
                }}
              >
                {holidayWm.showChartLine
                  ? `🏮 节前线 ≤${holidayWm.watermarkPct}%`
                  : `风控线 ≤${effEmotionCap}%`}
              </span>
            </div>
            <div
              style={{
                fontSize: '22px',
                fontWeight: 700,
                fontFamily: 'ui-monospace,Consolas,monospace',
                marginTop: '4px',
                color: holidayWm.isYellowCard
                  ? '#b45309'
                  : posRate > effEmotionCap + 0.1
                  ? 'var(--up)'
                  : 'var(--text)',
              }}
            >
              {posRate.toFixed(1)}%
            </div>
            {/* 迷你仓位水位刻度条（叠加日常风控线与节前长假上限线） */}
            <div
              style={{
                position: 'relative',
                height: '6px',
                borderRadius: '999px',
                background: '#e2e8f0',
                marginTop: '6px',
                overflow: 'visible',
              }}
              title={`当前仓位 ${posRate.toFixed(1)}% ｜ 水位上限 ${holidayWm.watermarkPct}% (¥${money(holidayWm.watermarkMkt)})`}
            >
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, posRate))}%`,
                  height: '100%',
                  borderRadius: '999px',
                  background: holidayWm.isYellowCard
                    ? '#f59e0b'
                    : posRate > effEmotionCap + 0.1
                    ? '#dc2626'
                    : '#0f766e',
                }}
              />
              {holidayWm.showChartLine && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.min(100, holidayWm.watermarkPct)}%`,
                    top: '-3px',
                    bottom: '-3px',
                    width: '2px',
                    background: '#d97706',
                    borderRadius: '1px',
                  }}
                  title={`${holidayWm.holidayName}控仓水位线 ≤${holidayWm.watermarkPct}%`}
                />
              )}
              {effEmotionCap < 100 && (!holidayWm.showChartLine || effEmotionCap !== holidayWm.watermarkPct) && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.min(100, effEmotionCap)}%`,
                    top: '-2px',
                    bottom: '-2px',
                    width: '2px',
                    background: '#475569',
                    borderRadius: '1px',
                  }}
                  title={`情绪允许上限 ≤${effEmotionCap}%`}
                />
              )}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: holidayWm.isYellowCard ? '#b45309' : posRate > effEmotionCap + 0.1 ? 'var(--up)' : 'var(--mute)',
                fontWeight: holidayWm.isYellowCard ? 700 : 400,
                marginTop: '5px',
              }}
            >
              {holidayWm.isYellowCard
                ? `🟨 超节前线 ${holidayWm.excessPct}% · 待降 ¥${money(holidayWm.excessAmt)}`
                : holidayWm.mode === 'safe_urgent' || holidayWm.mode === 'in_holiday'
                ? `✅ 跨假安全余量 ¥${money(holidayWm.headroomAmt)}`
                : holidayWm.mode === 'advance_countdown'
                ? `📅 剩${holidayWm.remainingTradeDays}日迎${holidayWm.holidayName} · 预备线 ≤${holidayWm.watermarkPct}%`
                : posRate > effEmotionCap + 0.1
                ? `🚨 超风控上限 ${(posRate - effEmotionCap).toFixed(1)}%`
                : `机动可开仓余量 ¥${money(holidayWm.deployableCash)}`}
            </div>
          </div>

          {/* 5. 做T累计套利与浮动盈亏 */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)', marginBottom: 0 }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
              <span>做T套利 &amp; 持仓浮盈</span>
              {onTabChange && (
                <button
                  type="button"
                  className="board-mini-pill-btn diag"
                  onClick={() => onTabChange('/ledger')}
                  title="查看做T成交流水与纪律体检"
                >
                  📒台账 →
                </button>
              )}
            </div>
            <div
              className={summary.realizedT >= 0 ? 'up' : 'down'}
              style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}
            >
              {summary.realizedT >= 0 ? '+' : ''}¥{money(summary.realizedT)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
              累计做T {summary.tCount} 笔 · 当前浮盈{' '}
              <b className={summary.floatPL >= 0 ? 'up' : 'down'}>
                {summary.floatPL >= 0 ? '+' : ''}¥{money(summary.floatPL)}
              </b>
            </div>
          </div>
        </div>

        {/* 🏮 节前连续长假控仓水位线 & 跨假安全可开仓余量全景条（仅在长假前5个交易日内或休市中展示） */}
        {holidayWm.showBanner && (
          <div
            className="card"
            style={{
              padding: '12px 15px',
              marginBottom: '16px',
              borderRadius: '10px',
              background: holidayWm.isYellowCard
                ? 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)'
                : holidayWm.mode === 'safe_urgent'
                ? 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)'
                : 'linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)',
              border: `1.5px solid ${
                holidayWm.isYellowCard ? '#f59e0b' : holidayWm.mode === 'safe_urgent' ? '#86efac' : '#bfdbfe'
              }`,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '13px', fontWeight: 800, color: holidayWm.isYellowCard ? '#92400e' : holidayWm.mode === 'safe_urgent' ? '#166534' : '#1e3a8a' }}>
                <span>{holidayWm.isYellowCard ? '🟨' : '🏮'}</span>
                <span>
                  {holidayWm.mode === 'in_holiday'
                    ? `${holidayWm.holidayName}休市跨假仓位体检（连休 ${holidayWm.closedDays} 天 · ${holidayWm.reopenDate.slice(5)} 开市）`
                    : `距${holidayWm.holidayName}连休 ${holidayWm.closedDays} 天剩 ${holidayWm.remainingTradeDays} 个交易日 · 节前控仓水位线 ≤${holidayWm.watermarkPct}%`}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '1px 8px',
                    borderRadius: '999px',
                    background: '#fff',
                    border: '1px solid rgba(0,0,0,0.08)',
                    fontFamily: 'ui-monospace,Consolas,monospace',
                  }}
                >
                  上限市值 ¥{money(holidayWm.watermarkMkt)} ({holidayWm.posRangeLabel})
                </span>
              </div>
              {onTabChange && (
                <button
                  type="button"
                  className="mini"
                  style={{
                    marginLeft: 0,
                    background: '#fff',
                    color: holidayWm.isYellowCard ? '#b45309' : '#0f766e',
                    borderColor: holidayWm.isYellowCard ? '#f59e0b' : '#86efac',
                    fontWeight: 700,
                  }}
                  onClick={() => onTabChange('/trade')}
                >
                  {holidayWm.isYellowCard ? '🎯 去作战台执行节前降仓 →' : '🎯 去作战台查看挂单锚点 →'}
                </button>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
                gap: '8px',
                fontSize: '12px',
              }}
            >
              <div style={{ padding: '7px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mute)' }}>节前安全市值水位线</div>
                <div style={{ fontWeight: 800, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '2px' }}>
                  ≤{holidayWm.watermarkPct}%（¥{money(holidayWm.watermarkMkt)}）
                </div>
              </div>

              <div style={{ padding: '7px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mute)' }}>
                  {holidayWm.excessAmt > 0 ? '超额跨假风险敞口（建议减仓）' : '跨假安全可开仓余量'}
                </div>
                <div
                  style={{
                    fontWeight: 800,
                    fontFamily: 'ui-monospace,Consolas,monospace',
                    marginTop: '2px',
                    color: holidayWm.excessAmt > 0 ? '#cf1322' : '#15803d',
                  }}
                >
                  {holidayWm.excessAmt > 0
                    ? `超 +${holidayWm.excessPct}% · 需降 ¥${money(holidayWm.excessAmt)}`
                    : `尚余 ${holidayWm.headroomPct}% · 可开 ¥${money(holidayWm.headroomAmt)}`}
                </div>
              </div>

              <div style={{ padding: '7px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mute)' }}>可用现金拆解（动用额度 / 避险储备）</div>
                <div style={{ fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '2px' }}>
                  可动用 <b style={{ color: '#0958d9' }}>¥{money(holidayWm.deployableCash)}</b> · 护城河储备 <b>¥{money(holidayWm.reserveCash)}</b>
                </div>
              </div>
            </div>

            {holidayWm.windowNote && (
              <div style={{ fontSize: '11.5px', color: holidayWm.isYellowCard ? '#78350f' : 'var(--sub)', lineHeight: 1.5 }}>
                💡 {holidayWm.windowNote}
              </div>
            )}
          </div>
        )}

        {/* 净值与仓位联动曲线（支持鼠标悬停 + 手机触屏滑动查点） */}
        {chartGeom && (
          <div className="card" style={{ padding: '14px 16px', marginBottom: '18px', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0, fontSize: '13.5px' }}>📈 账户净值曲线与仓位轨迹</h4>
                <span style={{ fontSize: '11.5px', color: 'var(--mute)' }}>
                  样本 {curveSeries.pts.length} 日 · 区间最大回撤{' '}
                  <b className={curveSeries.maxDD > 5 ? 'down' : ''}>{curveSeries.maxDD.toFixed(2)}%</b>
                </span>
              </div>
              {activePoint && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', fontSize: '12px', fontFamily: 'ui-monospace,Consolas,monospace', color: 'var(--sub)' }}>
                  <span>{activePoint.date}{activePoint.live ? '(实时)' : ''}</span>
                  <span>总资产 <b>¥{money(activePoint.total)}</b></span>
                  <span>市值 ¥{money(activePoint.mkt)}</span>
                  <span>现金 ¥{money(activePoint.cash)}</span>
                  <span>仓位 <b>{Number(activePoint.rate).toFixed(1)}%</b></span>
                </div>
              )}
            </div>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${chartGeom.W} ${chartGeom.H}`}
              style={{ width: '100%', height: 'auto', maxHeight: '220px', display: 'block', overflow: 'visible', touchAction: 'pan-y', userSelect: 'none' }}
              onMouseLeave={() => setHoverIdx(null)}
              onTouchStart={handleEquityTouch}
              onTouchMove={handleEquityTouch}
            >
              <defs>
                <linearGradient id="eqAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#dc2626" stopOpacity="0.20" />
                  <stop offset="100%" stopColor="#dc2626" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {[0, 0.5, 1].map((ratio, idx) => {
                const val = chartGeom.hi - (chartGeom.hi - chartGeom.lo) * ratio;
                const y = chartGeom.PT + chartGeom.ih * ratio;
                return (
                  <g key={idx}>
                    <line
                      x1={chartGeom.PL}
                      y1={y}
                      x2={chartGeom.PL + chartGeom.iw}
                      y2={y}
                      stroke="var(--line)"
                      strokeDasharray="3 3"
                      strokeWidth="1"
                    />
                    <text
                      x={chartGeom.PL - 6}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="10.5"
                      fill="var(--mute)"
                      fontFamily="ui-monospace,Consolas,monospace"
                    >
                      ¥{Math.round(val).toLocaleString('zh-CN')}
                    </text>
                  </g>
                );
              })}

              {summary.baseCap >= chartGeom.lo && summary.baseCap <= chartGeom.hi && (
                <g>
                  <line
                    x1={chartGeom.PL}
                    y1={chartGeom.Y(summary.baseCap)}
                    x2={chartGeom.PL + chartGeom.iw}
                    y2={chartGeom.Y(summary.baseCap)}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    strokeWidth="1"
                  />
                  <text
                    x={chartGeom.PL + chartGeom.iw + 4}
                    y={chartGeom.Y(summary.baseCap) + 3}
                    fontSize="10"
                    fill="#64748b"
                  >
                    本金线
                  </text>
                </g>
              )}

              {curveSeries.pts.map((p, i) => {
                const x = chartGeom.X(i);
                const barW = Math.min(22, Math.max(6, (chartGeom.iw / Math.max(4, curveSeries.pts.length)) * 0.45));
                const topY = chartGeom.YRate(p.rate);
                const barH = Math.max(2, chartGeom.PT + chartGeom.ih - topY);
                const overHolLine = p.live && holidayWm.showChartLine && p.rate > holidayWm.watermarkPct + 0.1;
                return (
                  <rect
                    key={`pos_${p.date}`}
                    x={x - barW / 2}
                    y={topY}
                    width={barW}
                    height={barH}
                    rx="2"
                    fill={
                      overHolLine
                        ? 'rgba(217,119,6,0.32)'
                        : p.rate > 80
                        ? 'rgba(220,38,38,0.18)'
                        : 'rgba(59,130,246,0.16)'
                    }
                  />
                );
              })}

              {holidayWm.showChartLine && (
                <g>
                  <line
                    x1={chartGeom.PL}
                    y1={chartGeom.YRate(holidayWm.watermarkPct)}
                    x2={chartGeom.PL + chartGeom.iw}
                    y2={chartGeom.YRate(holidayWm.watermarkPct)}
                    stroke="#d97706"
                    strokeDasharray="5 3"
                    strokeWidth="1.3"
                  />
                  <text
                    x={chartGeom.PL + chartGeom.iw + 4}
                    y={chartGeom.YRate(holidayWm.watermarkPct) + 3}
                    fontSize="9.5"
                    fontWeight="700"
                    fill="#b45309"
                  >
                    节前≤{holidayWm.watermarkPct}%
                  </text>
                </g>
              )}

              {chartGeom.areaPath && <path d={chartGeom.areaPath} fill="url(#eqAreaGrad)" />}
              <path
                d={chartGeom.linePath}
                fill="none"
                stroke="#dc2626"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {curveSeries.pts.map((p, i) => {
                const cx = chartGeom.X(i);
                const cy = chartGeom.Y(p.total);
                const isActive = hoverIdx === i || (hoverIdx == null && i === curveSeries.pts.length - 1);
                const showDateLabel =
                  curveSeries.pts.length <= 7 ||
                  i === 0 ||
                  i === curveSeries.pts.length - 1 ||
                  i === Math.floor(curveSeries.pts.length / 2);
                return (
                  <g
                    key={p.date}
                    onMouseEnter={() => setHoverIdx(i)}
                    onClick={() => setHoverIdx(i)}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle cx={cx} cy={cy} r={isActive ? 4.5 : 3} fill={p.live ? '#dc2626' : '#fff'} stroke="#dc2626" strokeWidth="2" />
                    {showDateLabel && (
                      <text
                        x={cx}
                        y={chartGeom.H - 8}
                        textAnchor="middle"
                        fontSize="10.5"
                        fill="var(--mute)"
                        fontFamily="ui-monospace,Consolas,monospace"
                      >
                        {p.date.slice(5)}
                      </text>
                    )}
                    <rect
                      x={cx - Math.max(14, chartGeom.iw / Math.max(2, curveSeries.pts.length) / 2)}
                      y={chartGeom.PT}
                      width={Math.max(28, chartGeom.iw / Math.max(2, curveSeries.pts.length))}
                      height={chartGeom.ih}
                      fill="transparent"
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {/* 单票做T降本明细（支持一键跳转今日作战台或全景诊股） */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <h4 style={{ fontSize: '13.5px', margin: 0 }}>🎯 个股做T降本与真实成本核算</h4>
            {onTabChange && (
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0, fontSize: '11.5px' }}
                onClick={() => onTabChange('/trade')}
              >
                去今日作战台管理持仓 →
              </button>
            )}
          </div>

          {holdingCostRows.length > 0 ? (
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>标的</th>
                    <th>持仓股数</th>
                    <th>当前摊薄成本</th>
                    <th>不做T原始成本</th>
                    <th>累计做T次数</th>
                    <th>累计做T净落袋</th>
                    <th>每股已降成本</th>
                    <th style={{ textAlign: 'right' }}>联动直达</th>
                  </tr>
                </thead>
                <tbody>
                  {holdingCostRows.map((s) => {
                    const code6 = String(s.code || '').padStart(6, '0');
                    const sh = Math.round(+s.shares || 0);
                    const cost = +s.cost || 0;
                    const tr = tRealOf(s.code, tradeLogs);
                    const perShare = sh > 0 && tr.n > 0 ? tr.sum / sh : null;
                    const rawCost = perShare !== null ? cost + perShare : cost;
                    return (
                      <tr key={code6}>
                        <td>
                          <span
                            onClick={() => onSelectStock && onSelectStock(code6)}
                            style={{ cursor: onSelectStock ? 'pointer' : 'default' }}
                            title="点击跳转至今日作战台该股卡片"
                          >
                            <b>{s.name}</b> <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>({code6})</span>
                          </span>
                        </td>
                        <td>{sh} 股</td>
                        <td>¥{f2(cost)}</td>
                        <td>{sh > 0 ? `¥${f2(rawCost)}` : '—'}</td>
                        <td>{tr.n} 笔</td>
                        <td className={tr.sum >= 0 ? 'up' : 'down'}>
                          <b>{tr.sum >= 0 ? '+' : ''}¥{money(tr.sum)}</b>
                        </td>
                        <td className={perShare && perShare > 0 ? 'up' : ''}>
                          {perShare !== null ? `${perShare >= 0 ? '-' : '+'}¥${f2(Math.abs(perShare))}/股` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div className="board-act-group is-compact">
                            {onSelectStock && (
                              <button
                                type="button"
                                className="board-act-btn in-pool"
                                onClick={() => onSelectStock(code6)}
                                title="定位至今日作战台该股卡片"
                              >
                                🎯作战
                              </button>
                            )}
                            {onJumpDiagnosis && (
                              <button
                                type="button"
                                className="board-act-btn diag"
                                onClick={() => onJumpDiagnosis(code6)}
                                title="查看个股全景诊股与排雷"
                              >
                                🩺诊股
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: '14px', background: 'var(--surface)', borderRadius: '8px', border: '1px dashed var(--line)', fontSize: '12px', color: 'var(--sub)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <span>当前暂无持仓或做T降本记录。在今日作战台录入底仓或完成一笔闪电记T后，这里将实时核算每股成本摊薄幅度。</span>
              {onTabChange && (
                <button type="button" className="mini primary" style={{ marginLeft: 0 }} onClick={() => onTabChange('/trade')}>
                  前往今日作战台 →
                </button>
              )}
            </div>
          )}
        </div>

        {/* 历史收盘净值与收益快照 */}
        <div style={{ marginTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <h4 style={{ fontSize: '13.5px', margin: 0 }}>📸 每日收盘净值收益快照（15:05 后自动归档）</h4>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button type="button" className="mini primary" style={{ marginLeft: 0 }} onClick={onTakeSnapshot}>📸 立即记录/更新今日快照</button>
              {snapshots.length > 0 && <button type="button" className="mini" style={{ marginLeft: 0 }} onClick={onClearSnap}>清空历史快照</button>}
            </div>
          </div>

          {snapshots && snapshots.length > 0 ? (
            <div className="tbl-scroll" style={{ maxHeight: '220px' }}>
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>收盘总资产</th>
                    <th>较前日涨跌</th>
                    <th>持仓总市值</th>
                    <th>可用现金</th>
                    <th>收盘仓位</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s, idx) => {
                    const prev = snapshots[idx + 1];
                    const diff = prev && +prev.total > 0 ? +s.total - +prev.total : null;
                    const diffPct = prev && +prev.total > 0 ? (diff / +prev.total) * 100 : null;
                    return (
                      <tr key={s.date || idx}>
                        <td>{s.date}</td>
                        <td><b>¥{money(s.total)}</b></td>
                        <td className={diff == null ? '' : diff >= 0 ? 'up' : 'down'}>
                          {diff == null ? '—' : `${diff >= 0 ? '+' : ''}¥${money(diff)} (${pct(diffPct)})`}
                        </td>
                        <td>¥{money(s.mkt)}</td>
                        <td>¥{money(s.cash)}</td>
                        <td>{s.rate}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: '14px', background: 'var(--surface)', borderRadius: '6px', fontSize: '12px', color: 'var(--mute)', textAlign: 'center' }}>
              暂无历史收盘快照。交易日 15:05 收盘后系统会自动记录当日净值，也可点击右上角随时手动记录。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
