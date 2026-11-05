import React, { useEffect, useRef, useState } from 'react';
import { drawChart, chartMeta, PERIODS, PERIOD_LABEL, P_MAIN, P_MORE, OV_DEF, SUB_DEF, setHover } from '../services/chart.js';
import { loadChart, loadDD } from '../services/api.js';

export default function ChartCanvas({ stock, poolIndex, onUpdateStock }) {
  const canvasRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [ddLoading, setDdLoading] = useState(false);
  const [showMorePeriods, setShowMorePeriods] = useState(false);

  const curPeriod = stock.p || 'day';
  const ov = stock.ov || { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 };
  const subKind = stock.sub || 'macd';

  const renderCanvas = () => {
    if (canvasRef.current) {
      drawChart(canvasRef.current, stock);
    }
  };

  useEffect(() => {
    renderCanvas();
    const handleResize = () => renderCanvas();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [stock, stock.p, stock.ov, stock.sub, stock._k]);

  const handlePeriodChange = async (p) => {
    setLoading(true);
    stock.p = p;
    try {
      await loadChart(stock, true);
    } catch (_) {}
    setLoading(false);
    onUpdateStock({ ...stock, p });
  };

  const handleToggleOverlay = (k) => {
    const nextOv = { ...ov, [k]: !ov[k] };
    onUpdateStock({ ...stock, ov: nextOv });
  };

  const handleChangeSub = (s) => {
    onUpdateStock({ ...stock, sub: s });
  };

  const handleFetchDD = async () => {
    setDdLoading(true);
    try {
      await loadDD(stock, true);
      stock.ddOn = true;
    } catch (_) {}
    setDdLoading(false);
    onUpdateStock({ ...stock });
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

  return (
    <div className="kline-box">
      <div className="k-bar">
        <span className="kb-lbl">周期</span>
        {P_MAIN.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`kb-btn ${curPeriod === k ? 'on' : ''}`}
            onClick={() => handlePeriodChange(k)}
          >
            {label}
          </button>
        ))}

        <button
          type="button"
          className={`kb-btn ${P_MORE.some(([k]) => k === curPeriod) ? 'on' : ''}`}
          onClick={() => setShowMorePeriods(!showMorePeriods)}
        >
          更多 ▾
        </button>

        {showMorePeriods && (
          <div className="kb-more-pop" style={{ display: 'inline-flex', gap: '4px', background: 'var(--surface2)', padding: '2px 6px', borderRadius: '4px' }}>
            {P_MORE.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`kb-btn ${curPeriod === k ? 'on' : ''}`}
                onClick={() => { handlePeriodChange(k); setShowMorePeriods(false); }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <span className="kb-sep"></span>
        <span className="kb-lbl">叠加</span>
        {Object.entries(OV_DEF).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`kb-btn ${ov[k] ? 'on' : ''}`}
            onClick={() => handleToggleOverlay(k)}
          >
            {label}
          </button>
        ))}

        <span className="kb-sep"></span>
        <span className="kb-lbl">副图</span>
        {Object.entries(SUB_DEF).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`kb-btn ${subKind === k ? 'on' : ''}`}
            onClick={() => handleChangeSub(k)}
          >
            {label}
          </button>
        ))}

        <button
          type="button"
          className={`kb-btn ${stock.ddOn ? 'on' : ''}`}
          onClick={handleFetchDD}
          style={{ marginLeft: '4px' }}
        >
          {ddLoading ? '💰 取数中…' : '💰 大单资金'}
        </button>

        <span className="rd" style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--mute)' }}>
          {loading ? '正在载入…' : chartMeta(stock)}
        </span>
      </div>

      <canvas
        id={`kln-${poolIndex}`}
        ref={canvasRef}
        data-ki={poolIndex}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: '100%', display: 'block' }}
      />
    </div>
  );
}
