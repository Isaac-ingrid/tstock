import React, { useEffect, useRef, useState, useCallback } from 'react';
import { drawChart, chartMeta, chartLegendHTML, chartStat, PERIODS, PERIOD_LABEL, P_MAIN, P_MORE, OV_DEF, OV_RT_DEF, SUB_DEF, setHover } from '../services/chart.js';
import { loadChart, loadDD } from '../services/api.js';
import { f2 } from '../services/utils.js';

const VALID_PERIODS = ['rt', 'day', 'week', 'month', 'm1', 'm5', 'm15', 'm30', 'm60'];

export default function ChartCanvas({
  stock,
  poolIndex = 0,
  tradeLogs = [],
  onOpenQuickT,
  onUpdateStock,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const canvasRef = useRef(null);
  const lastSigKeyRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [ddLoading, setDdLoading] = useState(false);
  const [showMorePeriods, setShowMorePeriods] = useState(false);
  const [rtSig, setRtSig] = useState(null);

  // 周期合法性校验（防旧缓存或错误传参污染）
  const curPeriod = VALID_PERIODS.includes(stock.p) ? stock.p : 'day';
  const ov = stock.ov || { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 };
  const ovRt = Object.assign({ cost: 1, be: 1, zones: 1, signal: 1, actual: 1, radar: 1 }, stock.ovRt || {});
  const subKind = stock.sub || 'macd';

  const syncRtSummary = useCallback(() => {
    const sig = stock._rtSignals || null;
    const ptsLen = stock._k?.rt?.min?.pts?.length || 0;
    const z = sig?.zones || {};
    const key = `${stock.code}:${curPeriod}:${ptsLen}:${sig?.points?.length || 0}:${sig?.actualMarkers?.length || 0}:${z.buyHi || 0}:${z.sellLo || 0}:${stock._distRadar?.badge || ''}`;
    if (key !== lastSigKeyRef.current) {
      lastSigKeyRef.current = key;
      setRtSig(sig ? { ...sig } : null);
    }
  }, [stock, curPeriod]);

  const renderCanvas = useCallback(() => {
    if (canvasRef.current) {
      try {
        stock._rtTradeLogs = tradeLogs;
        canvasRef.current._onDraw = syncRtSummary;
        drawChart(canvasRef.current, stock);
        syncRtSummary();
      } catch (err) {
        console.warn('Canvas render error suppressed:', err);
      }
    }
  }, [stock, tradeLogs, syncRtSummary]);

  useEffect(() => {
    renderCanvas();
    const handleResize = () => renderCanvas();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderCanvas, stock, tradeLogs, stock.p, stock.ov, stock.ovRt, stock.sub, stock._k, stock.bePrice, stock.cost]);

  // 切换周期：分时、日K、周K、月K或分钟级K线
  const handlePeriodChange = async (p) => {
    if (p === curPeriod) return;
    setLoading(true);
    stock.p = p;
    try {
      await loadChart(stock, true);
    } catch (_) {}
    setLoading(false);
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock, p });
    }
  };

  // 切换分时做T叠加（持仓成本、做T保本、做T买卖点、主力出货雷达）
  const handleToggleOverlayRt = (k) => {
    const nextOvRt = { ...ovRt, [k]: ovRt[k] ? 0 : 1 };
    stock.ovRt = nextOvRt;
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock, ovRt: nextOvRt });
    }
  };

  // 切换技术指标叠加（均线、BOLL、20日箱体、持仓成本、支撑压力位）
  const handleToggleOverlay = (k) => {
    const nextOv = { ...ov, [k]: ov[k] ? 0 : 1 };
    stock.ov = nextOv;
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock, ov: nextOv });
    }
  };

  // 切换副图指标（MACD / RSI）
  const handleChangeSub = (s) => {
    if (s === subKind) return;
    stock.sub = s;
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock, sub: s });
    }
  };

  // 拉取与切换大单资金逐笔明细
  const handleFetchDD = async () => {
    setDdLoading(true);
    try {
      await loadDD(stock, true);
      stock.ddOn = !stock.ddOn;
    } catch (_) {}
    setDdLoading(false);
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock });
    }
  };

  const handleMouseMove = (e) => {
    const cv = canvasRef.current;
    if (!cv || !cv._geo) return;
    const g = cv._geo;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    let idx = g.kind === 'bar'
      ? Math.floor((x - g.PL) / g.bw)
      : Math.round(((x - g.PL) / (g.innerW || 1)) * (g.n - 1));
    if (!(idx >= 0 && idx < g.n)) idx = -1;
    setHover(cv.id, idx);
    drawChart(cv, stock);
  };

  const handleMouseLeave = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    setHover(cv.id, null);
    drawChart(cv, stock);
  };

  const isMoreActive = P_MORE.some(([k]) => k === curPeriod);
  const moreLabel = isMoreActive ? (P_MORE.find(([k]) => k === curPeriod)?.[1] || '更多') : '更多';

  return (
    <div className="kline-box" style={{ background: '#fff', borderRadius: '8px', border: '1px solid var(--line)', marginBottom: '12px' }}>
      {/* 1. 顶部操作栏（周期/叠加/副图/资金） */}
      <div className="kbar k-main" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>周期</span>
        {P_MAIN.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`chip pd ${curPeriod === k ? 'on' : ''}`}
            onClick={() => handlePeriodChange(k)}
          >
            {label}
          </button>
        ))}

        {/* 更多分钟周期下拉菜单 */}
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button
            type="button"
            className={`chip pd ${isMoreActive ? 'on' : ''}`}
            onClick={() => setShowMorePeriods(!showMorePeriods)}
            title="更多分钟级K线（1分/5分/15分/30分/60分）"
          >
            {moreLabel} ▾
          </button>

          {showMorePeriods && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 40,
                background: '#fff',
                border: '1px solid var(--line)',
                borderRadius: '7px',
                padding: '4px 6px',
                display: 'flex',
                gap: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                whiteSpace: 'nowrap'
              }}
            >
              {P_MORE.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip pd ${curPeriod === k ? 'on' : ''}`}
                  onClick={() => {
                    handlePeriodChange(k);
                    setShowMorePeriods(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {curPeriod === 'rt' ? (
          <>
            <span className="sp" style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }}></span>
            <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>分时做T</span>
            {Object.entries(OV_RT_DEF).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`chip ov ${ovRt[k] ? 'on' : ''}`}
                onClick={() => handleToggleOverlayRt(k)}
                style={{ fontSize: '11px', padding: '2px 8px' }}
              >
                {label}
              </button>
            ))}
            {onToggleFastRefresh && (
              <button
                type="button"
                className={`chip ${fastRefresh ? 'on' : ''}`}
                onClick={onToggleFastRefresh}
                title="开启后：当前聚焦个股在交易时段每8秒极速增量拉取最新分时与现价，降低信号滞后"
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  marginLeft: '4px',
                  borderColor: fastRefresh ? '#f59e0b' : undefined,
                  color: fastRefresh ? '#b45309' : undefined,
                  background: fastRefresh ? '#fffbeb' : undefined,
                  fontWeight: fastRefresh ? 600 : 400,
                }}
              >
                ⚡ 8秒极速:{fastRefresh ? '开' : '关'}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="sp" style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }}></span>
            <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>叠加</span>
            {Object.entries(OV_DEF).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`chip ov ${ov[k] ? 'on' : ''}`}
                onClick={() => handleToggleOverlay(k)}
              >
                {label}
              </button>
            ))}

            <span className="sp" style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }}></span>
            <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>副图</span>
            {Object.entries(SUB_DEF).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`chip sb ${subKind === k ? 'on' : ''}`}
                onClick={() => handleChangeSub(k)}
              >
                {label}
              </button>
            ))}
          </>
        )}

        <span className="sp" style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }}></span>
        <button
          type="button"
          className={`chip ${stock.ddOn ? 'on' : ''}`}
          onClick={handleFetchDD}
          title="拉取当日逐笔成交，按单笔金额分档统计主力/大单净额与净量"
        >
          {ddLoading ? '💰 取数中…' : '💰 大单资金'}
        </button>

        <span className="rd" style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--mute)' }}>
          {loading ? '正在载入…' : chartMeta(stock)}
        </span>
      </div>

      {/* 2. 分时主力出货风险雷达与做T保本诊断横幅 */}
      {curPeriod === 'rt' && stock._distRadar && (
        <div style={{
          margin: '6px 12px 4px',
          padding: '7px 12px',
          borderRadius: '6px',
          background: stock._distRadar.bg,
          border: `1px solid ${stock._distRadar.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: stock._distRadar.color }}>
              {stock._distRadar.title}
            </span>
            <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
              {stock._distRadar.desc}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11.5px', color: 'var(--mute)' }}>
            <span>
              偏离均线: <b style={{ fontFamily: 'monospace', color: stock._distRadar.bias >= 0 ? 'var(--up)' : 'var(--down)' }}>
                {stock._distRadar.bias >= 0 ? '+' : ''}{stock._distRadar.bias.toFixed(2)}%
              </b>
            </span>
            {stock.cost > 0 && (
              <span>持仓: <b style={{ fontFamily: 'monospace' }}>¥{f2(stock.cost)}</b></span>
            )}
            {stock.bePrice > 0 && (
              <span>做T保本: <b style={{ fontFamily: 'monospace', color: '#d97706' }}>¥{f2(stock.bePrice)}</b></span>
            )}
          </div>
        </div>
      )}

      {/* 3. 手绘 Canvas 画布 */}
      <canvas
        id={`kln-${poolIndex}`}
        ref={canvasRef}
        data-ki={poolIndex}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
      />

      {/* 3b. 分时图买卖点与推荐区速览条 */}
      {curPeriod === 'rt' && (rtSig || stock._rtSignals) && (() => {
        const sig = rtSig || stock._rtSignals;
        const z = sig.zones || {};
        const ptsList = sig.points || [];
        const actsList = sig.actualMarkers || [];
        const oov = sig.outOfView || [];
        const fmtDist = (d) => d == null ? '' : `(${d >= 0 ? '+' : ''}${d.toFixed(2)}%)`;
        return (
          <div style={{
            padding: '7px 14px',
            borderTop: '1px solid var(--line)',
            background: '#fafbfc',
            fontSize: '11.5px',
            display: 'flex',
            flexDirection: 'column',
            gap: '5px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {z.buyHi > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#cf1322' }}>
                    <span>🔴 <b>推荐买区</b></span>
                    <b style={{ fontFamily: 'monospace' }}>¥{f2(z.buyLo > 0 ? z.buyLo : z.buyHi)}~{f2(z.buyHi)}</b>
                    <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>{fmtDist(sig.distToBuyPct)}</span>
                    {onOpenQuickT && (
                      <button type="button" className="mini" onClick={() => onOpenQuickT(stock, '正T', f2(z.buyHi))} style={{ fontSize: '10px', padding: '1px 5px', borderColor: '#fca5a5', color: '#cf1322', background: '#fff1f0' }}>
                        按此正T
                      </button>
                    )}
                  </span>
                )}
                {z.sellLo > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#15803d' }}>
                    <span>🟢 <b>推荐卖区</b></span>
                    <b style={{ fontFamily: 'monospace' }}>¥{f2(z.sellLo)}~{f2(z.sellHi > 0 ? z.sellHi : z.sellLo)}</b>
                    <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>{fmtDist(sig.distToSellPct)}</span>
                    {onOpenQuickT && (
                      <button type="button" className="mini" onClick={() => onOpenQuickT(stock, '倒T', f2(z.sellLo))} style={{ fontSize: '10px', padding: '1px 5px', borderColor: '#86efac', color: '#15803d', background: '#f0fdf4' }}>
                        按此倒T
                      </button>
                    )}
                  </span>
                )}
                {z.stopPx > 0 && (
                  <span style={{ color: '#991b1b', fontFamily: 'monospace' }}>
                    🛡️ 止损 ¥{f2(z.stopPx)}
                  </span>
                )}
              </div>

              <span style={{ color: 'var(--mute)', fontSize: '11px' }}>
                偏离阈值校准：{sig.buyBiasThresh}% / +{sig.sellBiasThresh}% (ATR步长 {z.atrStep}%)
              </span>
            </div>

            {(ptsList.length > 0 || actsList.length > 0 || oov.length > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {ptsList.slice(-4).map((pt, idx) => (
                  <span
                    key={`${pt.t}-${idx}`}
                    style={{
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      background: pt.type === 'BUY' ? '#fff1f0' : '#f0fdf4',
                      color: pt.type === 'BUY' ? '#cf1322' : '#15803d',
                      border: `1px solid ${pt.type === 'BUY' ? '#ffa39e' : '#bbf7d0'}`,
                    }}
                    title={pt.reason}
                  >
                    {pt.confirmed === false ? '◐' : '●'}{pt.type === 'BUY' ? (pt.confirmed === false ? '试探买' : '确认买') : (pt.confirmed === false ? '试探卖' : '确认卖')} {pt.t.slice(0, 2)}:{pt.t.slice(2)} ¥{f2(pt.px)} ({pt.reason})
                  </span>
                ))}
                {actsList.map((mk, idx) => (
                  <span
                    key={`act-${idx}`}
                    style={{
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: mk.side === 'B' ? '#fff1f0' : '#dcfce7',
                      color: mk.side === 'B' ? '#b91c1c' : '#15803d',
                      border: `1px solid ${mk.side === 'B' ? '#fca5a5' : '#86efac'}`,
                    }}
                  >
                    ◆ {mk.side}实 {mk.time || '今日'} ¥{f2(mk.px)} ({mk.dir}{mk.qty ? ` ${mk.qty}股` : ''})
                  </span>
                ))}
                {oov.length > 0 && (
                  <span style={{ fontSize: '10.5px', color: 'var(--mute)' }}>
                    视口外未框入：{oov.join(' · ')}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* 4. 画布下方颜色图例 */}
      <div
        className="k-legend"
        dangerouslySetInnerHTML={{ __html: chartLegendHTML(stock) }}
        style={{ padding: '6px 14px 2px', borderTop: '1px solid var(--line)' }}
      />

      {/* 4. 画布下方实时指标与数据统计条 */}
      <div
        className="k-stat-wrap"
        dangerouslySetInnerHTML={{ __html: chartStat(stock) }}
        style={{ padding: '0 14px 8px' }}
      />
    </div>
  );
}
