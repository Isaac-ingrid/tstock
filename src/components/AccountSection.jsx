import React, { useState, useMemo } from 'react';
import { f2, pct, money, todayStr } from '../services/utils.js';
import { tRealOf } from '../services/api.js';

export default function AccountSection({
  totalAssets = 100000,
  initialCapital = 100000,
  marketValue = 0,
  poolMarketValue = 0,
  tailMarketValue = 0,
  posRate = 0,
  cash = 0,
  pool = [],
  tailActives = [],
  tradeLogs = [],
  snapshots = [],
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets,
  onUpdateCash,
}) {
  const [editingTotal, setEditingTotal] = useState(false);
  const [newTotal, setNewTotal] = useState(totalAssets);

  const [editingCash, setEditingCash] = useState(false);
  const [newCash, setNewCash] = useState(cash);
  const [hoverIdx, setHoverIdx] = useState(null);

  const handleSaveTotal = () => {
    const val = parseFloat(newTotal);
    if (Number.isFinite(val) && val > 0 && onUpdateTotalAssets) {
      onUpdateTotalAssets(val);
      setEditingTotal(false);
    }
  };

  const handleSaveCash = () => {
    const val = parseFloat(newCash);
    if (Number.isFinite(val) && val >= 0 && onUpdateCash) {
      onUpdateCash(val);
      setEditingCash(false);
    }
  };

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
    (tailActives || []).forEach((t) => {
      if (t.status === 'closed') return;
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
  }, [pool, tailActives, tradeLogs, totalAssets, initialCapital]);

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
    // 最大回撤计算
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

  const activePoint = hoverIdx != null && curveSeries.pts[hoverIdx] ? curveSeries.pts[hoverIdx] : curveSeries.pts[curveSeries.pts.length - 1];

  return (
    <div id="accSec" style={{ marginTop: '20px' }}>
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <h2 style={{ margin: 0 }}>三、账户真实总账、可用现金与净值曲线</h2>
          <span style={{ fontSize: '12px', color: 'var(--mute)' }}>
            口径：<b>实时总资产 = 真实可用现金 + 自选持仓市值 + 尾盘隔夜市值</b>（买卖与做T自动增减现金）
          </span>
        </div>

        {/* 核心 5 维资金卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {/* 1. 实时总资产 */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between' }}>
              <span>实时账户总资产</span>
              <span className={summary.totalReturn >= 0 ? 'up' : 'down'} style={{ fontWeight: 700 }}>
                {summary.totalReturn >= 0 ? '+' : ''}{summary.totalReturnPct.toFixed(2)}%
              </span>
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}>
              {editingTotal ? (
                <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    value={newTotal}
                    onChange={(e) => setNewTotal(e.target.value)}
                    style={{ width: '115px', padding: '3px 6px', fontSize: '14px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                  <button className="primary" onClick={handleSaveTotal} style={{ padding: '2px 8px', fontSize: '11px' }}>校准</button>
                  <button onClick={() => setEditingTotal(false)} style={{ padding: '2px 8px', fontSize: '11px' }}>取消</button>
                </div>
              ) : (
                <span
                  onClick={() => {
                    setNewTotal(Math.round(totalAssets * 100) / 100);
                    setEditingTotal(true);
                  }}
                  title="点击按券商总资产反推校准现金与初始本金"
                  style={{ cursor: 'pointer' }}
                >
                  ¥{money(totalAssets)} <span style={{ fontSize: '11px', color: 'var(--accent)' }}>✎</span>
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
              初始本金 ¥{money(summary.baseCap)} · 净盈亏{' '}
              <b className={summary.totalReturn >= 0 ? 'up' : 'down'}>
                {summary.totalReturn >= 0 ? '+' : ''}¥{money(summary.totalReturn)}
              </b>
            </div>
          </div>

          {/* 2. 真实可用现金 */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>真实可用现金（可挂买单）</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px', color: 'var(--down)' }}>
              {editingCash ? (
                <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    value={newCash}
                    onChange={(e) => setNewCash(e.target.value)}
                    style={{ width: '115px', padding: '3px 6px', fontSize: '14px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                  <button className="primary" onClick={handleSaveCash} style={{ padding: '2px 8px', fontSize: '11px' }}>保存</button>
                  <button onClick={() => setEditingCash(false)} style={{ padding: '2px 8px', fontSize: '11px' }}>取消</button>
                </div>
              ) : (
                <span
                  onClick={() => {
                    setNewCash(Math.round(cash * 100) / 100);
                    setEditingCash(true);
                  }}
                  title="点击与券商可用余额对齐（银证转账或手工修正）"
                  style={{ cursor: 'pointer' }}
                >
                  ¥{money(cash)} <span style={{ fontSize: '11px', color: 'var(--accent)' }}>✎</span>
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
              独立持久记账，股价涨跌不再虚增/吞噬现金
            </div>
          </div>

          {/* 3. 持仓总市值（含尾盘隔夜） */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>持仓总市值（含尾盘）</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}>
              ¥{money(marketValue)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>
              主池 ¥{money(poolMarketValue)}
              {tailMarketValue > 0 ? ` · ⚡尾盘 ¥${money(tailMarketValue)}` : ' · 无尾盘隔夜仓'}
            </div>
          </div>

          {/* 4. 实际总仓位 */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>实际股票总仓位</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px', color: posRate > 80 ? 'var(--up)' : 'var(--text)' }}>
              {posRate.toFixed(1)}%
            </div>
            <div style={{ fontSize: '11px', color: posRate > 75 ? 'var(--up)' : 'var(--mute)', marginTop: '4px' }}>
              {posRate > 75 ? '⚠️ 仓位偏重，谨防回撤风险' : '仓位处于机动可控区间'}
            </div>
          </div>

          {/* 5. 做T累计套利与浮动盈亏 */}
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>做T套利 & 持仓浮盈</div>
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

        {/* 净值与仓位联动曲线 */}
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
                <div style={{ fontSize: '12px', fontFamily: 'ui-monospace,Consolas,monospace', color: 'var(--sub)' }}>
                  <span>{activePoint.date}{activePoint.live ? '(实时)' : ''}</span>
                  <span style={{ marginLeft: '10px' }}>总资产 <b>¥{money(activePoint.total)}</b></span>
                  <span style={{ marginLeft: '10px' }}>市值 ¥{money(activePoint.mkt)}</span>
                  <span style={{ marginLeft: '10px' }}>现金 ¥{money(activePoint.cash)}</span>
                  <span style={{ marginLeft: '10px' }}>仓位 <b>{Number(activePoint.rate).toFixed(1)}%</b></span>
                </div>
              )}
            </div>

            <svg
              viewBox={`0 0 ${chartGeom.W} ${chartGeom.H}`}
              style={{ width: '100%', height: 'auto', maxHeight: '220px', display: 'block', overflow: 'visible' }}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id="eqAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#dc2626" stopOpacity="0.20" />
                  <stop offset="100%" stopColor="#dc2626" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* 横向参考网格线 */}
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

              {/* 初始本金水位虚线 */}
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

              {/* 底部仓位柱状带 */}
              {curveSeries.pts.map((p, i) => {
                const x = chartGeom.X(i);
                const barW = Math.min(22, Math.max(6, (chartGeom.iw / Math.max(4, curveSeries.pts.length)) * 0.45));
                const topY = chartGeom.YRate(p.rate);
                const barH = Math.max(2, chartGeom.PT + chartGeom.ih - topY);
                return (
                  <rect
                    key={`pos_${p.date}`}
                    x={x - barW / 2}
                    y={topY}
                    width={barW}
                    height={barH}
                    rx="2"
                    fill={p.rate > 80 ? 'rgba(220,38,38,0.18)' : 'rgba(59,130,246,0.16)'}
                  />
                );
              })}

              {/* 净值面积与折线 */}
              {chartGeom.areaPath && <path d={chartGeom.areaPath} fill="url(#eqAreaGrad)" />}
              <path
                d={chartGeom.linePath}
                fill="none"
                stroke="#dc2626"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* 数据节点与悬停热区 */}
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

        {/* 单票做T降本明细（当存在持仓或历史做T记录时展示） */}
        {pool && pool.some((s) => (+s.shares || 0) > 0 || tRealOf(s.code, tradeLogs).n > 0) && (
          <div style={{ marginBottom: '18px' }}>
            <h4 style={{ fontSize: '13.5px', marginBottom: '8px' }}>🎯 个股做T降本与真实成本核算</h4>
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
                  </tr>
                </thead>
                <tbody>
                  {pool
                    .filter((s) => (+s.shares || 0) > 0 || tRealOf(s.code, tradeLogs).n > 0)
                    .map((s) => {
                      const sh = Math.round(+s.shares || 0);
                      const cost = +s.cost || 0;
                      const tr = tRealOf(s.code, tradeLogs);
                      const perShare = sh > 0 && tr.n > 0 ? tr.sum / sh : null;
                      const rawCost = perShare !== null ? cost + perShare : cost;
                      return (
                        <tr key={s.code}>
                          <td><b>{s.name}</b> ({String(s.code).padStart(6, '0')})</td>
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
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 历史收盘净值与收益快照 */}
        <div style={{ marginTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h4 style={{ fontSize: '13.5px', margin: 0 }}>📸 每日收盘净值收益快照（15:05 后自动归档）</h4>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="mini primary" onClick={onTakeSnapshot}>📸 立即记录/更新今日快照</button>
              {snapshots.length > 0 && <button className="mini" onClick={onClearSnap}>清空历史快照</button>}
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
