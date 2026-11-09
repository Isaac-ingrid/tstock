import React, { useEffect, useRef, useState, useCallback } from 'react';
import { drawChart, chartMeta, chartLegendHTML, chartStat, PERIODS, PERIOD_LABEL, P_MAIN, P_MORE, OV_DEF, SUB_DEF, setHover } from '../services/chart.js';
import { loadChart, loadDD } from '../services/api.js';

const VALID_PERIODS = ['rt', 'day', 'week', 'month', 'm1', 'm5', 'm15', 'm30', 'm60'];

export default function ChartCanvas({ stock, poolIndex, onUpdateStock }) {
  const canvasRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [ddLoading, setDdLoading] = useState(false);
  const [showMorePeriods, setShowMorePeriods] = useState(false);

  // 周期合法性校验（防旧缓存或错误传参污染）
  const curPeriod = VALID_PERIODS.includes(stock.p) ? stock.p : 'day';
  const ov = stock.ov || { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 };
  const subKind = stock.sub || 'macd';

  const renderCanvas = useCallback(() => {
    if (canvasRef.current) {
      try {
        drawChart(canvasRef.current, stock);
      } catch (err) {
        console.warn('Canvas render error suppressed:', err);
      }
    }
  }, [stock]);

  useEffect(() => {
    renderCanvas();
    const handleResize = () => renderCanvas();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderCanvas, stock, stock.p, stock.ov, stock.sub, stock._k]);

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
            <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)' }}>
              分时图自带：价格线 / 均价线 / 分时量 / 放量倍数
            </span>
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

      {/* 2. 手绘 Canvas 画布 */}
      <canvas
        id={`kln-${poolIndex}`}
        ref={canvasRef}
        data-ki={poolIndex}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
      />

      {/* 3. 画布下方颜色图例 */}
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
