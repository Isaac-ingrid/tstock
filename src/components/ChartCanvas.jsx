import React, { useEffect, useRef, useState, useCallback } from 'react';
import { drawChart, chartMeta, chartLegendHTML, chartStat, PERIODS, PERIOD_LABEL, P_MAIN, P_MORE, OV_DEF, OV_RT_DEF, SUB_DEF, SUB_RT_DEF, setHover } from '../services/chart.js';
import { loadChart, loadDD, computeLeadingMomentum } from '../services/api.js';
import { f2, copyPlain } from '../services/utils.js';

const VALID_PERIODS = ['rt', 'day', 'week', 'month', 'm1', 'm5', 'm15', 'm30', 'm60'];

function fmtBookLots(v) {
  const n = Math.abs(Number(v) || 0);
  const sign = Number(v) < 0 ? '-' : '';
  if (n >= 10000) return `${sign}${(n / 10000).toFixed(n >= 100000 ? 1 : 2)}万`;
  return `${sign}${Math.round(n)}`;
}

function fmtSealAmt(amt) {
  const n = Math.abs(Number(amt) || 0);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString('zh-CN')}万`;
  return `${Math.round(n)}元`;
}

function OrderBook5Panel({ stock, book5, onPickLevel }) {
  const pc = +(book5?.prevClose || stock.prevClose || 0);
  const curPx = +(book5?.price || stock.price || pc || 0);
  const chgPct = pc > 0 && curPx > 0 ? ((curPx - pc) / pc) * 100 : 0;
  const pxColor = (p) => {
    if (!(p > 0) || !(pc > 0)) return 'var(--mute)';
    if (p > pc + 0.0001) return 'var(--up, #d32f2f)';
    if (p < pc - 0.0001) return 'var(--down, #0a7f42)';
    return 'var(--text)';
  };

  if (!book5) {
    return (
      <aside className="ob5-panel" aria-label="实时五档盘口">
        <div className="ob5-head">
          <span className="ob5-title">📋 五档盘口</span>
          <span className="ob5-subhint">同步中…</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mute)', fontSize: '11px', textAlign: 'center', padding: '12px 4px' }}>
          正在拉取实时买一至买五 / 卖一至卖五挂单…
        </div>
      </aside>
    );
  }

  const asksTopDown = [...(book5.asks || [])].reverse();
  const bidsTopDown = book5.bids || [];
  const maxV = Math.max(1, book5.maxLvVol || 1);
  const wallThr = book5.wallThreshold || 999999;

  const renderRow = (lv) => {
    const active = lv.price > 0 && lv.vol > 0;
    const widthPct = active ? Math.min(100, Math.max(4, (lv.vol / maxV) * 100)) : 0;
    const isWall = active && lv.vol >= wallThr;
    return (
      <div
        key={`${lv.side}-${lv.level}`}
        className={`ob5-row ${active ? '' : 'is-empty'}`}
        onClick={() => active && onPickLevel && onPickLevel(lv)}
        title={active ? `点击带入${lv.label}价格 ¥${f2(lv.price)}（挂单量 ${lv.vol} 手）` : `${lv.label}暂无挂单`}
      >
        {widthPct > 0 && (
          <div
            className={`ob5-bar ${lv.side}${isWall ? ' wall' : ''}`}
            style={{ width: `${widthPct}%` }}
          />
        )}
        <span className="ob5-lbl">{lv.label}</span>
        <span className="ob5-px" style={{ color: active ? pxColor(lv.price) : 'var(--mute)' }}>
          {lv.price > 0 ? f2(lv.price) : '—'}
        </span>
        <span className="ob5-vol">
          {isWall && (
            <span className={`ob5-wall-tag ${lv.side}`}>
              {lv.side === 'ask' ? '压' : '托'}
            </span>
          )}
          <span>{active ? fmtBookLots(lv.vol) : '—'}</span>
        </span>
      </div>
    );
  };

  const leadMom = computeLeadingMomentum(stock);

  return (
    <aside className="ob5-panel" aria-label="实时五档盘口">
      <div>
        <div className="ob5-head">
          <span className="ob5-title">📋 实时五档</span>
          <span className="ob5-subhint">点价快捷带单</span>
        </div>

        {book5.sealType === 'UP' && (
          <div className="ob5-seal-banner is-up" title={`涨停买一封单 ${book5.sealVol} 手`}>
            🔥 涨停封单 {fmtSealAmt(book5.sealAmt)} ({fmtBookLots(book5.sealVol)}手)
          </div>
        )}
        {book5.sealType === 'DOWN' && (
          <div className="ob5-seal-banner is-down" title={`跌停卖一封单 ${book5.sealVol} 手`}>
            ❄️ 跌停封单 {fmtSealAmt(book5.sealAmt)} ({fmtBookLots(book5.sealVol)}手)
          </div>
        )}

        {leadMom?.ready && (
          <div className={`ob5-mom-box lv-${leadMom.level}`} title={leadMom.summary}>
            <div className="ob5-mom-top">
              <span className="ob5-mom-tag">{leadMom.shortTag}</span>
              <span className={`ob5-mom-score lv-${leadMom.level}`}>{leadMom.scoreTxt}</span>
            </div>
            <div className="lm-track" aria-label={`主力先导动能 ${leadMom.scoreTxt}`}>
              {leadMom.score < 0 && (
                <div
                  className="lm-fill-neg"
                  style={{ width: `${Math.min(50, Math.abs(leadMom.score) / 2)}%` }}
                />
              )}
              {leadMom.score > 0 && (
                <div
                  className="lm-fill-pos"
                  style={{ width: `${Math.min(50, leadMom.score / 2)}%` }}
                />
              )}
              <i className="lm-zero" />
            </div>
            {Array.isArray(leadMom.tags) && leadMom.tags.length > 0 && (
              <div className="ob5-mom-sub">{leadMom.tags.join(' · ')}</div>
            )}
          </div>
        )}

        <div className="ob5-weibi-box" title={`总委买 ${book5.bidVolSum} 手 / 总委卖 ${book5.askVolSum} 手`}>
          <div className="ob5-weibi-top">
            <span style={{ color: book5.weiBi >= 0 ? 'var(--up, #d32f2f)' : 'var(--down, #0a7f42)', fontWeight: 700 }}>
              委比 {book5.weiBi >= 0 ? '+' : ''}{book5.weiBi.toFixed(1)}%
            </span>
            <span>
              差 {book5.weiCha >= 0 ? '+' : ''}{fmtBookLots(book5.weiCha)}手
            </span>
          </div>
          <div className="ob5-weibi-bar">
            <div className="ob5-weibi-bid" style={{ width: `${book5.bidRatio}%` }} />
          </div>
        </div>
      </div>

      <div className="ob5-book-grid">
        <div className="ob5-rows">{asksTopDown.map(renderRow)}</div>

        <div className="ob5-mid-divider" title="现价与内外盘主动成交对比（外盘=主动吃卖盘，内盘=主动砸买盘）">
          <b style={{ color: pxColor(curPx) }}>
            ¥{curPx > 0 ? f2(curPx) : '—'} ({chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%)
          </b>
          <span style={{ color: 'var(--mute)', fontSize: '10px' }}>
            {book5.outer > 0 || book5.inner > 0
              ? `外${fmtBookLots(book5.outer)}/内${fmtBookLots(book5.inner)}`
              : '单位:手'}
          </span>
        </div>

        <div className="ob5-rows">{bidsTopDown.map(renderRow)}</div>
      </div>
    </aside>
  );
}

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
  const canvasWrapRef = useRef(null);
  const lastSigKeyRef = useRef('');
  const touchTrackRef = useRef({ x: 0, y: 0, mode: null });
  const [loading, setLoading] = useState(false);
  const [ddLoading, setDdLoading] = useState(false);
  const [showMorePeriods, setShowMorePeriods] = useState(false);
  const [rtSig, setRtSig] = useState(null);
  const [touchPinned, setTouchPinned] = useState(false);

  // 周期合法性校验（防旧缓存或错误传参污染）
  const curPeriod = VALID_PERIODS.includes(stock.p) ? stock.p : 'day';
  const ov = stock.ov || { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 };
  const ovRt = Object.assign({ book: 1, bench: 1, cost: 1, be: 1, zones: 1, signal: 1, actual: 1, radar: 1 }, stock.ovRt || {});
  const subKind = stock.sub || 'macd';
  const rtSubKind = stock.rtSub || 'obv';
  const activeBook5 = stock._book5 || stock._k?.rt?.min?.book5 || null;

  const handlePickBookLevel = useCallback(
    (lv) => {
      if (!lv || !(lv.price > 0)) return;
      const pxStr = f2(lv.price);
      if (onOpenQuickT) {
        const held = (+stock.shares || 0) > 0;
        const defaultDir = held ? (lv.side === 'ask' ? '倒T' : '正T') : '直接买入';
        onOpenQuickT(stock, defaultDir, pxStr);
      } else {
        copyPlain(pxStr, `✓ 已复制${lv.label}价格 ¥${pxStr}`);
      }
    },
    [stock, onOpenQuickT]
  );

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
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && canvasWrapRef.current) {
      ro = new ResizeObserver(() => renderCanvas());
      ro.observe(canvasWrapRef.current);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      if (ro) ro.disconnect();
    };
  }, [renderCanvas, stock, tradeLogs, stock.p, stock.ov, stock.ovRt, stock.sub, stock.rtSub, stock._k, stock._book5, stock.bePrice, stock.cost]);

  const clearCrosshair = useCallback(() => {
    const cv = canvasRef.current;
    setTouchPinned(false);
    if (!cv) return;
    setHover(cv.id, null);
    drawChart(cv, stock);
  }, [stock]);

  // 切换周期：分时、日K、周K、月K或分钟级K线
  const handlePeriodChange = async (p) => {
    if (p === curPeriod) return;
    setTouchPinned(false);
    if (canvasRef.current) setHover(canvasRef.current.id, null);
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

  // 切换分时副图指标（分时OBV能量潮 / 放量倍数）
  const handleChangeRtSub = (k) => {
    if (k === rtSubKind) return;
    stock.rtSub = k;
    renderCanvas();
    if (onUpdateStock) {
      onUpdateStock({ ...stock, rtSub: k });
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

  const clientXToIndex = (clientX, clampToBounds = false) => {
    const cv = canvasRef.current;
    if (!cv || !cv._geo) return null;
    const g = cv._geo;
    const r = cv.getBoundingClientRect();
    const x = clientX - r.left;
    if (g.kind === 'line' && Array.isArray(g.ptSlots) && g.ptSlots.length > 0) {
      const targetSlot = ((x - g.PL) / (g.innerW || 1)) * 240;
      const maxSlot = g.ptSlots[g.ptSlots.length - 1] ?? 0;
      if (!clampToBounds && (targetSlot < -4 || targetSlot > maxSlot + 6)) {
        return -1;
      }
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < g.ptSlots.length; i++) {
        const diff = Math.abs(g.ptSlots[i] - targetSlot);
        if (diff <= bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      return bestIdx;
    }
    let idx = g.kind === 'bar'
      ? Math.floor((x - g.PL) / g.bw)
      : Math.round(((x - g.PL) / (g.innerW || 1)) * (g.n - 1));
    if (clampToBounds) {
      idx = Math.max(0, Math.min(g.n - 1, idx));
    } else if (!(idx >= 0 && idx < g.n)) {
      idx = -1;
    }
    return idx;
  };

  // 点击分时图上的推荐买点/卖点圆点，一键拉起做T快捷面板并带入该圆点价格
  const handleCanvasClick = (e) => {
    if (curPeriod !== 'rt' || !onOpenQuickT) return;
    const cv = canvasRef.current;
    if (!cv || !cv._geo || cv._geo.kind !== 'line') return;
    const g = cv._geo;
    const recs = g.recPoints || [];
    if (!recs.length || !Array.isArray(g.ptSlots)) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestDist = 16; // 16px 命中半径
    recs.forEach((sig) => {
      const sx = g.PL + (Math.max(0, Math.min(240, g.ptSlots[sig.idx] ?? 0)) / 240) * (g.innerW || 1);
      const sy = g.y1 - ((sig.px - g.yLo) / ((g.yHi - g.yLo) || 1)) * (g.y1 - g.y0);
      const dist = Math.hypot(mx - sx, my - sy);
      if (dist < bestDist) {
        bestDist = dist;
        best = sig;
      }
    });
    if (best) {
      onOpenQuickT(stock, best.type === 'BUY' ? '正T' : '倒T', f2(best.px));
    }
  };

  const handleMouseMove = (e) => {
    const cv = canvasRef.current;
    if (!cv || !cv._geo) return;
    const idx = clientXToIndex(e.clientX, false);
    if (idx == null) return;
    setHover(cv.id, idx);
    drawChart(cv, stock);
  };

  const handleMouseLeave = () => {
    if (touchPinned) return;
    const cv = canvasRef.current;
    if (!cv) return;
    setHover(cv.id, null);
    drawChart(cv, stock);
  };

  // 手机/触屏查图支持：单指横向拖动实时移动十字准星，纵向正常滚动页面（配合 touch-action: pan-y）
  const handleTouchStart = (e) => {
    const cv = canvasRef.current;
    if (!cv || !cv._geo || !e.touches || !e.touches.length) return;
    const t = e.touches[0];
    touchTrackRef.current = { x: t.clientX, y: t.clientY, mode: null };
    const idx = clientXToIndex(t.clientX, true);
    if (idx != null) {
      setTouchPinned(true);
      setHover(cv.id, idx);
      drawChart(cv, stock);
    }
  };

  const handleTouchMove = (e) => {
    const cv = canvasRef.current;
    if (!cv || !cv._geo || !e.touches || !e.touches.length) return;
    const t = e.touches[0];
    const st = touchTrackRef.current;
    const dx = Math.abs(t.clientX - st.x);
    const dy = Math.abs(t.clientY - st.y);
    if (!st.mode && (dx > 5 || dy > 5)) {
      st.mode = dx >= dy * 0.85 ? 'scrub' : 'scroll';
    }
    if (st.mode === 'scroll') return;
    const idx = clientXToIndex(t.clientX, true);
    if (idx != null) {
      setTouchPinned(true);
      setHover(cv.id, idx);
      drawChart(cv, stock);
    }
  };

  const isMoreActive = P_MORE.some(([k]) => k === curPeriod);
  const moreLabel = isMoreActive ? (P_MORE.find(([k]) => k === curPeriod)?.[1] || '更多') : '更多';

  return (
    <div className="kline-box" style={{ background: 'var(--card)', borderRadius: '8px', border: '1px solid var(--line)', marginBottom: '12px' }}>
      {/* 1. 顶部操作栏（周期/叠加/副图/资金；窄屏下自动转为单行顺滑横滑，不遮挡分时图） */}
      <div className="kbar k-main kbar-responsive" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
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

        <button
          type="button"
          className={`chip pd ${isMoreActive || showMorePeriods ? 'on' : ''}`}
          onClick={() => setShowMorePeriods((prev) => !prev)}
          title="展开/收起分钟级K线（1分/5分/15分/30分/60分）"
        >
          {moreLabel} {showMorePeriods ? '▴' : '▾'}
        </button>

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
            <span className="sp" style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }}></span>
            <span className="lbl" style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>副图</span>
            {Object.entries(SUB_RT_DEF).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`chip sb ${rtSubKind === k ? 'on' : ''}`}
                onClick={() => handleChangeRtSub(k)}
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
                  marginLeft: '2px',
                  borderColor: fastRefresh ? '#f59e0b' : undefined,
                  color: fastRefresh ? 'var(--warn-d)' : undefined,
                  background: fastRefresh ? 'var(--warn-bg)' : undefined,
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

        <span className="rd" style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--mute)', whiteSpace: 'nowrap' }}>
          {loading ? '正在载入…' : chartMeta(stock)}
        </span>
      </div>

      {/* 1b. 分钟级K线展开条（独立于横滑工具栏，窄屏绝不被 overflow 裁剪） */}
      {showMorePeriods && (
        <div className="kbar-more-strip">
          <span className="lbl" style={{ fontSize: '11px', color: 'var(--mute)', fontWeight: 600 }}>分钟周期</span>
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

      {/* 2. 分时主力出货风险雷达与做T保本诊断横幅 */}
      {curPeriod === 'rt' && stock._distRadar && (
        <div className="kline-radar-banner" style={{
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
            <span className="kline-radar-desc" style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
              {stock._distRadar.desc}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11.5px', color: 'var(--mute)', flexWrap: 'wrap' }}>
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

      {/* 3. 手绘 Canvas 画布 + 分时右侧实时五档买卖盘口墙 */}
      <div className={curPeriod === 'rt' && ovRt.book ? 'kline-rt-split' : undefined}>
        <div className="kline-canvas-wrap" ref={canvasWrapRef}>
          {touchPinned && (
            <button
              type="button"
              className="kline-clear-crosshair"
              onClick={clearCrosshair}
              title="收起触屏十字准星，恢复最新一分钟实时值"
            >
              ✕ 收起十字线
            </button>
          )}
          <canvas
            id={`kln-${poolIndex}`}
            ref={canvasRef}
            data-ki={poolIndex}
            onClick={handleCanvasClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            style={{ width: '100%', display: 'block', cursor: 'crosshair', touchAction: 'pan-y', WebkitTapHighlightColor: 'transparent' }}
          />
        </div>

        {curPeriod === 'rt' && ovRt.book ? (
          <OrderBook5Panel
            stock={stock}
            book5={activeBook5}
            onPickLevel={handlePickBookLevel}
          />
        ) : null}
      </div>

      {/* 3b. 分时图买卖点与推荐区速览条 */}
      {curPeriod === 'rt' && (rtSig || stock._rtSignals) && (() => {
        const sig = rtSig || stock._rtSignals;
        const z = sig.zones || {};
        const ptsList = sig.points || [];
        const actsList = sig.actualMarkers || [];
        const oov = sig.outOfView || [];
        const fmtDist = (d) => d == null ? '' : `(${d >= 0 ? '+' : ''}${d.toFixed(2)}%)`;
        return (
          <div className="kline-rt-zone-bar" style={{
            padding: '7px 14px',
            borderTop: '1px solid var(--line)',
            background: 'var(--surface)',
            fontSize: '11.5px',
            display: 'flex',
            flexDirection: 'column',
            gap: '5px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {z.buyHi > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--up)', flexWrap: 'wrap' }}>
                    <span>🔴 <b>推荐买区</b></span>
                    <b style={{ fontFamily: 'monospace' }}>¥{f2(z.buyLo > 0 ? z.buyLo : z.buyHi)}~{f2(z.buyHi)}</b>
                    <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>{fmtDist(sig.distToBuyPct)}</span>
                    {onOpenQuickT && (
                      <button type="button" className="mini kline-zone-act" onClick={() => onOpenQuickT(stock, '正T', f2(z.buyHi))} style={{ fontSize: '10.5px', padding: '2px 7px', borderColor: 'var(--up-b)', color: 'var(--up)', background: 'var(--up-bg)', marginLeft: '2px' }}>
                        ⚡ 按此正T
                      </button>
                    )}
                  </span>
                )}
                {z.sellLo > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--down-d)', flexWrap: 'wrap' }}>
                    <span>🟢 <b>推荐卖区</b></span>
                    <b style={{ fontFamily: 'monospace' }}>¥{f2(z.sellLo)}~{f2(z.sellHi > 0 ? z.sellHi : z.sellLo)}</b>
                    <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>{fmtDist(sig.distToSellPct)}</span>
                    {onOpenQuickT && (
                      <button type="button" className="mini kline-zone-act" onClick={() => onOpenQuickT(stock, '倒T', f2(z.sellLo))} style={{ fontSize: '10.5px', padding: '2px 7px', borderColor: 'var(--down-b)', color: 'var(--down-d)', background: 'var(--down-bg)', marginLeft: '2px' }}>
                        ⚡ 按此倒T
                      </button>
                    )}
                  </span>
                )}
                {z.stopPx > 0 && (
                  <span style={{ color: 'var(--up-d)', fontFamily: 'monospace' }}>
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
                      background: pt.type === 'BUY' ? 'var(--up-bg)' : 'var(--down-bg)',
                      color: pt.type === 'BUY' ? 'var(--up)' : 'var(--down-d)',
                      border: `1px solid ${pt.type === 'BUY' ? 'var(--up-b)' : 'var(--down-b)'}`,
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
                      background: mk.side === 'B' ? 'var(--up-bg)' : 'var(--down-bg)',
                      color: mk.side === 'B' ? 'var(--up-d)' : 'var(--down-d)',
                      border: `1px solid ${mk.side === 'B' ? 'var(--up-b)' : 'var(--down-b)'}`,
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

      {/* 5. 画布下方实时指标与数据统计条 */}
      <div
        className="k-stat-wrap"
        dangerouslySetInnerHTML={{ __html: chartStat(stock) }}
        style={{ padding: '0 14px 8px' }}
      />
    </div>
  );
}
