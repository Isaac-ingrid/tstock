import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { f2, pct, money, money$, toastOk, toastErr, toastWarn, copyPlain, calcTBreakeven } from '../services/utils.js';
import {
  fetchStockDiagnosis,
  fetchIgnitionPool,
  postIgnitionTrackingAction,
  loadLocalTrackedCodes,
  searchTencent,
  loadChart,
  loadStock,
  refreshSingleFastRt,
  isAShareTradingNow,
} from '../services/api.js';
import ChartCanvas from '../components/ChartCanvas.jsx';
import KlinePatternBadges from '../components/KlinePatternBadges.jsx';

const QUICK_PRESETS = [
  { code: '002085', name: '万丰奥威' },
  { code: '300059', name: '东方财富' },
  { code: '600519', name: '贵州茅台' },
  { code: '002594', name: '比亚迪' },
  { code: '601127', name: '赛力斯' },
];

function extractCodeFromInput(raw) {
  const s = String(raw || '').trim();
  const mExact = s.match(/^(?:sh|sz|bj)?(\d{6})$/i);
  if (mExact) return mExact[1];
  const mSuffix = s.match(/\((\d{6})\)$/);
  if (mSuffix) return mSuffix[1];
  return null;
}

function fmtPct(v, signed = false, digits = null) {
  if (v === null || v === undefined || v === '') return '—';
  const num = Number(v);
  if (!Number.isFinite(num)) return '—';
  const s = digits !== null ? num.toFixed(digits) : String(num);
  return signed && num >= 0 ? `+${s}%` : `${s}%`;
}

function CyqFlameChart({ chips, curPrice, holdCost = 0, holdBePrice = 0 }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const profile = Array.isArray(chips?.cyqProfile) ? chips.cyqProfile : [];
  if (profile.length < 2) return null;

  const px = Number(curPrice || chips?.curPrice || 0);
  const avgCost = Number(chips?.avgCost || 0);
  const peakPrice = Number(chips?.peakPrice || 0);
  const c90Lo = Number(chips?.cost90Low || 0);
  const c90Hi = Number(chips?.cost90High || 0);
  const profitRatio = Number(chips?.profitRatio ?? 50);
  const hCost = Number(holdCost || 0);
  const hBe = Number(holdBePrice || 0);
  const hasHoldLines = hCost > 0 || hBe > 0;

  const minBarP = Number(profile[0].p || 0);
  const maxBarP = Number(profile[profile.length - 1].p || 0);
  const stepP = Math.max(0.005, (maxBarP - minBarP) / Math.max(1, profile.length - 1));

  const baseMarks = [px, avgCost, peakPrice, c90Lo, c90Hi].filter((v) => Number.isFinite(v) && v > 0);
  const baseLo = Math.min(minBarP - 0.5 * stepP, ...baseMarks);
  const baseHi = Math.max(maxBarP + 0.5 * stepP, ...baseMarks);
  const baseSpan = Math.max(0.02, baseHi - baseLo);

  // 若持仓成本或做T保本价在 210 日筹码区间近邻（±30%跨度内），直接纳入线性纵轴；若远高于/低于（如早期高位深套底仓），吸附在顶/底边缘不压扁筹码峰
  const nearHoldMarks = [hCost, hBe].filter(
    (v) => Number.isFinite(v) && v > 0 && v >= baseLo - 0.3 * baseSpan && v <= baseHi + 0.3 * baseSpan
  );
  const rawLo = Math.min(baseLo, ...nearHoldMarks);
  const rawHi = Math.max(baseHi, ...nearHoldMarks);
  const rawSpan = Math.max(0.02, rawHi - rawLo);
  const domLo = Math.max(0.01, rawLo - rawSpan * 0.045);
  const domHi = rawHi + rawSpan * 0.045;
  const domSpan = Math.max(0.02, domHi - domLo);

  const hasPinnedTop = [hCost, hBe].some((v) => v > domHi);
  const hasPinnedBot = [hCost, hBe].some((v) => v > 0 && v < domLo);

  const svgW = 480;
  const svgH = hasHoldLines ? 228 : 208;
  const padTop = hasPinnedTop ? 20 : 12;
  const padBot = hasPinnedBot ? 20 : 12;
  const plotH = svgH - padTop - padBot;
  const axisX = 56;
  const barMaxW = 274;
  const pToY = (v) => padTop + ((domHi - v) / domSpan) * plotH;

  const maxPct = Math.max(...profile.map((r) => Number(r.pct) || 0), 0.1);

  let peakIdx = 0;
  if (peakPrice > 0) {
    let bestSc = -Infinity;
    profile.forEach((r, idx) => {
      const dist = Math.abs(Number(r.p) - peakPrice);
      const nearBonus = dist <= stepP * 1.15 ? 1000 : -dist * 50;
      const sc = nearBonus + (Number(r.pct) || 0);
      if (sc > bestSc) {
        bestSc = sc;
        peakIdx = idx;
      }
    });
  } else {
    profile.forEach((r, idx) => {
      if ((Number(r.pct) || 0) > (Number(profile[peakIdx].pct) || 0)) peakIdx = idx;
    });
  }

  const yTicks = [0, 0.333, 0.667, 1].map((t) => domHi - t * domSpan);

  const has90Band = c90Hi > c90Lo && c90Lo > 0;
  const y90Top = has90Band ? pToY(c90Hi) : 0;
  const y90Bot = has90Band ? pToY(c90Lo) : 0;
  const h90 = has90Band ? Math.max(3, y90Bot - y90Top) : 0;

  const pushMarker = (arr, item) => {
    if (!(item.price > 0)) return;
    let trueY = pToY(item.price);
    let label = item.label;
    let dash = item.dash;
    if (item.price > domHi) {
      trueY = 7;
      label = `↑ ${item.label}`;
      dash = '2 2.5';
    } else if (item.price < domLo) {
      trueY = svgH - 7;
      label = `↓ ${item.label}`;
      dash = '2 2.5';
    }
    arr.push({ ...item, label, dash, trueY, labelY: trueY });
  };

  const rawMarkers = [];
  pushMarker(rawMarkers, {
    key: 'cur',
    label: `现价 ¥${f2(px)}`,
    price: px,
    stroke: 'var(--text)',
    bg: '#0f172a',
    fg: '#ffffff',
    border: 'var(--text)',
    dash: undefined,
    sw: 1.35,
  });
  pushMarker(rawMarkers, {
    key: 'peak',
    label: `主峰 ¥${f2(peakPrice)}`,
    price: peakPrice,
    stroke: '#0e7490',
    bg: 'var(--teal-bg)',
    fg: '#0e7490',
    border: '#67e8f9',
    dash: '4 2.5',
    sw: 1.25,
  });
  pushMarker(rawMarkers, {
    key: 'avg',
    label: `均价 ¥${f2(avgCost)}`,
    price: avgCost,
    stroke: 'var(--sub)',
    bg: 'var(--surface2)',
    fg: 'var(--sub)',
    border: 'var(--line2)',
    dash: '2.5 2.5',
    sw: 1.15,
  });
  if (hCost > 0) {
    pushMarker(rawMarkers, {
      key: 'cost',
      label: `持仓 ¥${f2(hCost)}`,
      price: hCost,
      stroke: 'var(--accent-d)',
      bg: '#7c3aed',
      fg: '#ffffff',
      border: 'var(--accent-d)',
      dash: '5 3',
      sw: 1.3,
    });
  }
  if (hBe > 0 && Math.abs(hBe - hCost) >= 0.005) {
    pushMarker(rawMarkers, {
      key: 'be',
      label: `保本 ¥${f2(hBe)}`,
      price: hBe,
      stroke: '#d97706',
      bg: '#d97706',
      fg: '#ffffff',
      border: 'var(--warn-d)',
      dash: '3.5 2',
      sw: 1.3,
    });
  }

  const markers = rawMarkers.sort((a, b) => a.trueY - b.trueY);
  const minGap = markers.length >= 5 ? 19.5 : 21;
  for (let i = 0; i < markers.length; i += 1) {
    const floorY = i === 0 ? 11 : markers[i - 1].labelY + minGap;
    if (markers[i].labelY < floorY) markers[i].labelY = floorY;
  }
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const ceilY = i === markers.length - 1 ? svgH - 11 : markers[i + 1].labelY - minGap;
    if (markers[i].labelY > ceilY) markers[i].labelY = ceilY;
    if (markers[i].labelY < 11) markers[i].labelY = 11;
  }

  const handlePointer = (clientY, rect) => {
    if (!rect || rect.height <= 0) return;
    const relY = ((clientY - rect.top) / rect.height) * svgH;
    const targetP = domHi - ((relY - padTop) / plotH) * domSpan;
    let bestI = 0;
    let bestDiff = Infinity;
    profile.forEach((r, idx) => {
      const d = Math.abs(Number(r.p) - targetP);
      if (d < bestDiff) {
        bestDiff = d;
        bestI = idx;
      }
    });
    setHoverIdx(bestI);
  };

  const hRow = hoverIdx !== null && profile[hoverIdx] ? profile[hoverIdx] : null;
  const hDiffPct = hRow && px > 0 ? (((Number(hRow.p) - px) / px) * 100).toFixed(2) : null;
  const trappedRatio = Math.max(0, 100 - profitRatio);

  // 保本位 vs 筹码主峰关系诊断（仅在有实盘持仓保本线与主峰时生成）
  let bePeakInsight = null;
  if (hBe > 0 && peakPrice > 0) {
    const diffPct = ((hBe - peakPrice) / peakPrice) * 100;
    const trappedPeakAbove = peakPrice > px * 1.004;
    if (trappedPeakAbove && hBe <= peakPrice) {
      bePeakInsight = {
        tone: 'good',
        bg: 'var(--down-bg)',
        border: 'var(--down-b)',
        color: 'var(--down-d)',
        text: `✅ 保本位低于上方套牢主峰：做T保本 ¥${f2(hBe)} 位于主峰 ¥${f2(peakPrice)} 下方 (${diffPct.toFixed(1)}%)，日内反抽无需穿过主峰解套抛压墙即可保本出局`,
      };
    } else if (trappedPeakAbove && hBe > peakPrice) {
      bePeakInsight = {
        tone: 'warn',
        bg: 'var(--warn-bg)',
        border: 'var(--warn-b)',
        color: 'var(--warn-d)',
        text: `⚠️ 保本位需跨过上方套牢主峰：做T保本 ¥${f2(hBe)} 高于主峰 ¥${f2(peakPrice)} (+${diffPct.toFixed(1)}%)，触及保本前易遇主峰抛压阻击，反抽主峰附近宜先倒T磨低成本`,
      };
    } else {
      bePeakInsight = {
        tone: 'info',
        bg: 'var(--info-bg)',
        border: 'var(--info-b)',
        color: 'var(--info-d)',
        text: `🛡️ 现价已站上筹码主峰（¥${f2(peakPrice)}）：做T保本 ¥${f2(hBe)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}% vs 主峰)${hCost > px ? `，可依托主峰支撑波段做T逐步摊薄底仓 ¥${f2(hCost)}` : '，筹码支撑与持仓均处于顺势区'}`,
      };
    }
  }

  return (
    <div
      style={{
        marginBottom: '10px',
        padding: '9px 10px 7px',
        borderRadius: '8px',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
      }}
    >
      {/* 顶部图例与交互读数栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '6px',
          marginBottom: '5px',
          fontSize: '11px',
          minHeight: '18px',
        }}
      >
        {hRow ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontFamily: 'ui-monospace, Consolas, monospace' }}>
            <span style={{ fontWeight: 700, color: 'var(--text)' }}>档位 ¥{f2(hRow.p)}</span>
            <span style={{ color: 'var(--sub)' }}>单档占比 <b>{Number(hRow.pct).toFixed(2)}%</b></span>
            {hDiffPct !== null && (
              <span style={{ fontWeight: 700, color: Number(hRow.p) <= px ? 'var(--up)' : 'var(--info-d)' }}>
                {Number(hRow.p) <= px ? `获利支撑 (${hDiffPct}%)` : `套牢抛压 (+${hDiffPct}%)`}
              </span>
            )}
          </div>
        ) : (
          <span style={{ fontWeight: 700, color: 'var(--sub)' }}>
            🔥 {chips.cyqDays || 210}日换手衰减筹码峰火焰图
          </span>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: 'var(--mute)', marginLeft: 'auto' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
            <i style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#ef4444', display: 'inline-block' }} />
            获利 {fmtPct(profitRatio, false, 1)}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
            <i style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#3b82f6', display: 'inline-block' }} />
            套牢 {fmtPct(trappedRatio, false, 1)}
          </span>
          {has90Band && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <i style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'rgba(245, 158, 11, 0.38)', border: '1px solid #d97706', display: 'inline-block' }} />
              90%密集区
            </span>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y', userSelect: 'none' }}
        role="img"
        aria-label="210日CYQ横向筹码分布火焰柱状图"
        onMouseMove={(e) => handlePointer(e.clientY, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchMove={(e) => {
          if (e.touches && e.touches[0]) {
            handlePointer(e.touches[0].clientY, e.currentTarget.getBoundingClientRect());
          }
        }}
      >
        <defs>
          <linearGradient id="cyqProfitGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#fca5a5" />
            <stop offset="55%" stopColor="#ef4444" />
            <stop offset="100%" stopColor="#ea580c" />
          </linearGradient>
          <linearGradient id="cyqTrapGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="60%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
        </defs>

        {/* 水平参考网格与左轴价格刻度 */}
        {yTicks.map((tv, idx) => {
          const ty = pToY(tv);
          return (
            <g key={idx}>
              <line x1={axisX} y1={ty} x2={axisX + barMaxW + 8} y2={ty} stroke="var(--line)" strokeWidth="0.8" strokeDasharray="2 3" />
              <text
                x="45"
                y={ty}
                textAnchor="end"
                dominantBaseline="central"
                fontSize="10"
                fontFamily="ui-monospace, Consolas, monospace"
                fill="var(--mute)"
              >
                ¥{f2(tv)}
              </text>
            </g>
          );
        })}

        {/* 90% 筹码密集区高亮背景带与左轴括号 */}
        {has90Band && (
          <g>
            <rect
              x={axisX}
              y={y90Top}
              width={barMaxW + 8}
              height={h90}
              rx="3"
              fill="#f59e0b"
              fillOpacity="0.10"
            />
            <line x1={axisX} y1={y90Top} x2={axisX + barMaxW + 8} y2={y90Top} stroke="#d97706" strokeOpacity="0.45" strokeWidth="0.9" strokeDasharray="2 3" />
            <line x1={axisX} y1={y90Bot} x2={axisX + barMaxW + 8} y2={y90Bot} stroke="#d97706" strokeOpacity="0.45" strokeWidth="0.9" strokeDasharray="2 3" />
            <path
              d={`M 53 ${y90Top} L 49 ${y90Top} L 49 ${y90Bot} L 53 ${y90Bot}`}
              fill="none"
              stroke="#d97706"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        )}

        {/* 纵向价格基轴 */}
        <line x1={axisX} y1={padTop - 2} x2={axisX} y2={svgH - padBot + 2} stroke="var(--line2)" strokeWidth="1.1" />

        {/* 横向筹码峰火焰柱 */}
        {profile.map((row, idx) => {
          const pVal = Number(row.p || 0);
          const pctVal = Number(row.pct || 0);
          const yTopB = pToY(pVal + 0.5 * stepP);
          const yBotB = pToY(pVal - 0.5 * stepP);
          const bH = Math.max(1.9, Math.abs(yBotB - yTopB) - 0.85);
          const bY = Math.min(yTopB, yBotB) + 0.42;
          const bW = Math.max(1.5, (pctVal / maxPct) * barMaxW);
          const isProfit = px > 0 ? pVal <= px + 1e-6 : true;
          const isPeak = idx === peakIdx;
          const isHovered = idx === hoverIdx;
          return (
            <rect
              key={idx}
              x={axisX + 0.6}
              y={bY}
              width={bW}
              height={bH}
              rx={Math.min(1.6, bH * 0.45)}
              fill={isProfit ? 'url(#cyqProfitGrad)' : 'url(#cyqTrapGrad)'}
              fillOpacity={isHovered || isPeak ? '1' : '0.84'}
              stroke={isPeak ? '#0e7490' : isHovered ? 'var(--text)' : 'none'}
              strokeWidth={isPeak || isHovered ? '1' : '0'}
            />
          );
        })}

        {/* 悬停水平准星线 */}
        {hRow && (
          <line
            x1={axisX}
            y1={pToY(Number(hRow.p))}
            x2={axisX + barMaxW + 8}
            y2={pToY(Number(hRow.p))}
            stroke="var(--sub)"
            strokeWidth="0.9"
            strokeDasharray="1.5 2"
          />
        )}

        {/* 主峰、筹码均价、现价三条基准线与右侧防重叠标签 */}
        {markers.map((m) => (
          <g key={m.key}>
            <line
              x1={axisX}
              y1={m.trueY}
              x2={axisX + barMaxW + 8}
              y2={m.trueY}
              stroke={m.stroke}
              strokeWidth={m.sw}
              strokeDasharray={m.dash}
            />
            <polyline
              points={`${axisX + barMaxW + 8},${m.trueY} ${axisX + barMaxW + 16},${m.labelY} ${axisX + barMaxW + 22},${m.labelY}`}
              fill="none"
              stroke={m.stroke}
              strokeWidth="1"
              strokeOpacity="0.75"
            />
            <rect
              x={axisX + barMaxW + 22}
              y={m.labelY - 9}
              width="122"
              height="18"
              rx="4.5"
              fill={m.bg}
              stroke={m.border}
              strokeWidth="1"
            />
            <text
              x={axisX + barMaxW + 83}
              y={m.labelY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="10.2"
              fontWeight="700"
              fontFamily="ui-monospace, Consolas, monospace"
              fill={m.fg}
            >
              {m.label}
            </text>
          </g>
        ))}
      </svg>

      {bePeakInsight && (
        <div
          style={{
            marginTop: '6px',
            padding: '5px 8px',
            borderRadius: '6px',
            background: bePeakInsight.bg,
            border: `1px solid ${bePeakInsight.border}`,
            color: bePeakInsight.color,
            fontSize: '11.2px',
            lineHeight: 1.45,
          }}
        >
          {bePeakInsight.text}
        </div>
      )}
    </div>
  );
}

export default function DiagnosisPage({
  pool = [],
  tailActives = [],
  wbLatest = null,
  tradeLogs = [],
  initialCode = '',
  onAddStockToPool,
  onSelectStockInPool,
  onJumpIgnition,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const initCleanCode = extractCodeFromInput(initialCode) || '';
  const [activeCode, setActiveCode] = useState(initCleanCode);
  const [inputText, setInputText] = useState(initCleanCode);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [annFilter, setAnnFilter] = useState('all'); // all | red | green
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [searching, setSearching] = useState(false);
  const [funnelSnap, setFunnelSnap] = useState(null);
  const [candSourceFilter, setCandSourceFilter] = useState('all'); // all | ignition | tail | tracking | pool
  const [trackedCodes, setTrackedCodes] = useState(() => new Set(loadLocalTrackedCodes()));
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [customStopInput, setCustomStopInput] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [diagChartStock, setDiagChartStock] = useState(null);
  const searchBoxRef = useRef(null);
  const suppressSuggestRef = useRef(false);

  // 入页毫秒级同步起爆挖掘、深跌龙头与在轨跟踪池快照，供顶部「待审候选条」连点过筛
  useEffect(() => {
    let cancelled = false;
    fetchIgnitionPool({ fastSnapshot: true, timeoutMs: 4500 })
      .then((res) => {
        if (cancelled || !res || !res.ok) return;
        setFunnelSnap(res);
        const tItems = res?.trackingPool?.items || [];
        if (tItems.length > 0) {
          setTrackedCodes((prev) => {
            const next = new Set(prev);
            tItems.forEach((it) => {
              if (it?.code) next.add(String(it.code).padStart(6, '0'));
            });
            return next;
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 汇总全站选股漏斗候选：起爆活口 · 尾盘黑马 · 在轨跟踪 · 自选作战 · 深跌抗跌
  const funnelCandidates = useMemo(() => {
    const list = [];
    const pushCand = (raw, source, tagPrefix, badgeText = '') => {
      const c = String(raw?.code || '').trim().padStart(6, '0');
      if (!/^\d{6}$/.test(c)) return;
      list.push({
        code: c,
        name: String(raw?.name || c).replace(/\s+/g, ''),
        source,
        tagPrefix,
        badgeText,
      });
    };
    (funnelSnap?.breakout?.items || []).slice(0, 12).forEach((it) => {
      const starTxt = it.dragonStars >= 4.0 ? ` ${it.dragonStars}★` : '';
      pushCand(it, 'ignition', '🔥起爆', starTxt);
    });
    const tailList = Array.isArray(wbLatest?.tail) ? wbLatest.tail : [];
    tailList.slice(0, 8).forEach((it) => pushCand(it, 'tail', '🌙尾盘', it.score ? ` ${it.score}分` : ''));
    (tailActives || []).forEach((it) => {
      if (it?.status !== 'closed') pushCand(it, 'tail', '🌙隔夜', '');
    });
    (funnelSnap?.trackingPool?.items || []).slice(0, 12).forEach((it) => {
      pushCand(it, 'tracking', '🎯跟踪', '');
    });
    (pool || []).slice(0, 10).forEach((it) => {
      pushCand(it, 'pool', '💼自选', it.stopPrice > 0 ? ` 止¥${f2(it.stopPrice)}` : '');
    });
    (funnelSnap?.dipLeaders?.items || []).slice(0, 6).forEach((it) => {
      pushCand(it, 'ignition', '🛟深跌', '');
    });

    // 按当前过滤分类去重
    const seen = new Set();
    const filtered = [];
    list.forEach((item) => {
      if (candSourceFilter !== 'all' && item.source !== candSourceFilter) return;
      if (seen.has(item.code)) return;
      seen.add(item.code);
      filtered.push(item);
    });
    return filtered;
  }, [funnelSnap, wbLatest, tailActives, pool, candSourceFilter]);

  const sourceCounts = useMemo(() => {
    const ignCnt = (funnelSnap?.breakout?.items?.length || 0) + (funnelSnap?.dipLeaders?.items?.length || 0);
    const tailCnt = (Array.isArray(wbLatest?.tail) ? wbLatest.tail.length : 0) + (tailActives || []).filter((t) => t?.status !== 'closed').length;
    const trkCnt = funnelSnap?.trackingPool?.items?.length || 0;
    const poolCnt = (pool || []).length;
    return { ignCnt, tailCnt, trkCnt, poolCnt, total: ignCnt + tailCnt + trkCnt + poolCnt };
  }, [funnelSnap, wbLatest, tailActives, pool]);

  const localLookup = useMemo(() => {
    const map = new Map();
    [...funnelCandidates, ...(pool || []), ...QUICK_PRESETS].forEach((s) => {
      const c = String(s.code || '').padStart(6, '0');
      if (/^\d{6}$/.test(c) && !map.has(c)) {
        map.set(c, { code: c, name: s.name || c, market: s.market || '' });
      }
    });
    return Array.from(map.values());
  }, [funnelCandidates, pool]);

  const matchLocal = useCallback((q) => {
    const k = String(q || '').trim().toLowerCase();
    if (!k) return [];
    return localLookup.filter(
      (s) => s.code.includes(k) || String(s.name || '').toLowerCase().includes(k)
    );
  }, [localLookup]);

  const runDiagnosis = useCallback(async (codeToRun, displayName = '') => {
    const c = extractCodeFromInput(codeToRun) || String(codeToRun || '').trim().replace(/^(sh|sz|bj)/i, '');
    if (!/^\d{6}$/.test(c)) {
      toastWarn('请输入有效的 6 位股票代码或股票名称（如 万丰奥威）');
      return;
    }
    setActiveCode(c);
    suppressSuggestRef.current = true;
    setInputText(displayName && displayName !== c ? `${displayName} (${c})` : c);
    setShowSuggest(false);
    setLoading(true);
    setErrorMsg('');
    try {
      const data = await fetchStockDiagnosis(c);
      if (data && data.ok) {
        setReport(data);
        const realName = data?.quote?.name || displayName;
        if (realName) {
          suppressSuggestRef.current = true;
          setInputText(`${realName} (${c})`);
        }
      } else {
        throw new Error(data?.message || '获取体检数据失败');
      }
    } catch (err) {
      setErrorMsg(err.message || '诊断服务暂时不可用，请确认后端已启动');
      toastErr('体检失败：' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const code6 = extractCodeFromInput(initialCode);
    if (code6) {
      const localHit = localLookup.find((x) => x.code === code6);
      runDiagnosis(code6, localHit?.name || '');
    } else {
      setActiveCode('');
      suppressSuggestRef.current = true;
      setInputText('');
      setReport(null);
      setDiagChartStock(null);
      setErrorMsg('');
      setShowSuggest(false);
    }
  }, [initialCode]);

  // 点击外部关闭联想下拉框
  useEffect(() => {
    const onDocDown = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setShowSuggest(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  // 输入股票代码/名称/拼音时防抖联想 A 股候选
  useEffect(() => {
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      return undefined;
    }
    const q = inputText.trim();
    if (!q || extractCodeFromInput(q)) {
      setSuggestions([]);
      setShowSuggest(false);
      setHighlightIdx(-1);
      return undefined;
    }
    const localHits = matchLocal(q).slice(0, 5);
    if (localHits.length > 0) {
      setSuggestions(localHits);
      setShowSuggest(true);
      setHighlightIdx(0);
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const remote = await searchTencent(q);
        if (cancelled) return;
        const merged = [];
        const seen = new Set();
        [...localHits, ...(remote || [])].forEach((item) => {
          const code = String(item.code || '').padStart(6, '0');
          if (/^\d{6}$/.test(code) && !seen.has(code)) {
            seen.add(code);
            merged.push({ code, name: item.name || code, market: item.market || '' });
          }
        });
        const topList = merged.slice(0, 8);
        setSuggestions(topList);
        setShowSuggest(topList.length > 0);
        setHighlightIdx(topList.length > 0 ? 0 : -1);
      } catch {
        if (!cancelled && localHits.length === 0) {
          setSuggestions([]);
          setShowSuggest(false);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inputText, matchLocal]);

  const handleSubmitSearch = useCallback(async () => {
    const q = inputText.trim();
    if (!q) {
      toastWarn('请输入 6 位股票代码、股票名称或拼音首字母');
      return;
    }
    const directCode = extractCodeFromInput(q);
    if (directCode) {
      const hit = localLookup.find((x) => x.code === directCode);
      await runDiagnosis(directCode, hit?.name || '');
      return;
    }
    const qLower = q.toLowerCase();
    const localHits = matchLocal(q);
    const localExact = localHits.find((x) => String(x.name || '').toLowerCase() === qLower);
    if (localExact) {
      await runDiagnosis(localExact.code, localExact.name);
      return;
    }
    setSearching(true);
    try {
      const remote = await searchTencent(q);
      const merged = [];
      const seen = new Set();
      [...localHits, ...(remote || [])].forEach((item) => {
        const code = String(item.code || '').padStart(6, '0');
        if (/^\d{6}$/.test(code) && !seen.has(code)) {
          seen.add(code);
          merged.push({ code, name: item.name || code, market: item.market || '' });
        }
      });
      if (merged.length === 0) {
        toastWarn(`未找到与「${q}」匹配的 A 股标的，请尝试输入完整股票名或 6 位代码`);
        return;
      }
      const exactMatch = merged.find((x) => String(x.name || '').toLowerCase() === qLower);
      if (exactMatch || merged.length === 1) {
        const picked = exactMatch || merged[0];
        await runDiagnosis(picked.code, picked.name);
        return;
      }
      setSuggestions(merged.slice(0, 8));
      setShowSuggest(true);
      setHighlightIdx(0);
      toastWarn(`匹配到 ${merged.length} 只相似标的，请在下拉框中点选确认`);
    } catch (err) {
      if (localHits.length === 1) {
        await runDiagnosis(localHits[0].code, localHits[0].name);
      } else {
        toastErr(`名称检索失败：${err?.message || '请直接输入6位股票代码'}`);
      }
    } finally {
      setSearching(false);
    }
  }, [inputText, localLookup, matchLocal, runDiagnosis]);

  const handlePresetClick = (code, name = '') => {
    const hit = name || localLookup.find((x) => x.code === code)?.name || '';
    runDiagnosis(code, hit);
  };

  const handleCopySummary = () => {
    if (!report || !report.wechatSummary) return;
    copyPlain(report.wechatSummary, '✓ 已复制完整体检报告！可直接粘贴至微信回复朋友');
  };

  const scrollToDiagSection = (elId) => {
    const el = document.getElementById(elId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const isInPool = report && pool.some(s => String(s.code).padStart(6, '0') === String(report.code).padStart(6, '0'));

  // 当诊断报告切换新标的时，构造交互式股票对象并加载分时+日K用于买卖点画图
  useEffect(() => {
    if (!report || !report.ok || !report.code) {
      setDiagChartStock(null);
      return undefined;
    }
    let cancelled = false;
    const code6 = String(report.code).padStart(6, '0');
    const poolMatch = (pool || []).find(s => String(s.code).padStart(6, '0') === code6);
    const rq = report.quote || {};
    const rChips = report.chips || {};
    const rIntra = report.intraday || {};
    const tcode = rq.tcode || ((code6.startsWith('6') || code6.startsWith('9')) ? `sh${code6}` : `sz${code6}`);
    const st = {
      code: code6,
      tcode,
      name: rq.name || poolMatch?.name || code6,
      prevClose: +rq.prevClose || poolMatch?.prevClose || 0,
      open: +rq.open || poolMatch?.open || 0,
      high: +rq.high || poolMatch?.high || 0,
      low: +rq.low || poolMatch?.low || 0,
      price: +rq.price || poolMatch?.price || 0,
      avg: +rIntra.vwap || poolMatch?.avg || +rq.price || 0,
      vr: +rq.vr || poolMatch?.vr || 1.0,
      ma5: +rChips.ma5 || poolMatch?.ma5 || 0,
      ma10: +rChips.ma10 || poolMatch?.ma10 || 0,
      ma20: +rChips.ma20 || poolMatch?.ma20 || 0,
      shares: poolMatch?.shares || 0,
      cost: poolMatch?.cost || 0,
      bePrice: poolMatch?.bePrice || 0,
      cap: poolMatch?.cap || 0,
      p: 'rt',
      ovRt: { cost: 1, be: 1, zones: 1, signal: 1, actual: 1, radar: 1 },
      _k: poolMatch?._k ? { ...poolMatch._k } : {},
      _ks: poolMatch?._ks || null,
    };
    setDiagChartStock(prev => (prev && prev.code === code6
      ? { ...st, p: prev.p || 'rt', ov: prev.ov || st.ov, ovRt: prev.ovRt || st.ovRt, _k: prev._k || st._k, _ks: prev._ks || st._ks }
      : st));

    Promise.allSettled([loadStock(st), loadChart(st, true)]).then(() => {
      if (!cancelled) {
        setDiagChartStock(prev => {
          const keepPeriod = (prev && prev.code === code6 && prev.p) ? prev.p : 'rt';
          return {
            ...st,
            p: keepPeriod,
            ov: prev?.ov,
            ovRt: (prev && prev.code === code6 && prev.ovRt) ? prev.ovRt : st.ovRt,
          };
        });
      }
    });
    return () => { cancelled = true; };
  }, [report?.code, report?.quote?.price]);

  // 持仓或成本变化时轻同步到诊断图（不清空用户已选周期）
  useEffect(() => {
    if (!report?.code) return;
    const code6 = String(report.code).padStart(6, '0');
    const poolMatch = (pool || []).find(s => String(s.code).padStart(6, '0') === code6);
    if (!poolMatch) return;
    setDiagChartStock(prev => {
      if (!prev || prev.code !== code6) return prev;
      if (prev.shares === (poolMatch.shares || 0) && prev.cost === (poolMatch.cost || 0)) return prev;
      return { ...prev, shares: poolMatch.shares || 0, cost: poolMatch.cost || 0, bePrice: poolMatch.bePrice || 0 };
    });
  }, [pool, report?.code]);

  const diagStockRef = useRef(diagChartStock);
  diagStockRef.current = diagChartStock;

  /* 诊断页分时图：开启 8 秒极速轮询时在交易时段增量刷新现价与分时 */
  useEffect(() => {
    if (!fastRefresh || !diagChartStock?.code || (diagChartStock.p || 'rt') !== 'rt') return undefined;
    let inFlight = false;
    const timer = setInterval(async () => {
      const target = diagStockRef.current;
      if (inFlight || !target || (target.p || 'rt') !== 'rt') return;
      if (!isAShareTradingNow()) return;
      inFlight = true;
      try {
        await refreshSingleFastRt(target);
        setDiagChartStock(prev => (prev && prev.code === target.code ? { ...target } : prev));
      } catch (_) {
        // 静默跳过单次极速超时
      } finally {
        inFlight = false;
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [fastRefresh, diagChartStock?.code, diagChartStock?.p]);

  const q = report?.quote || {};
  const comp = report?.company || {};
  const chips = report?.chips || {};
  const sec = report?.sectorEcology || {};
  const wave = report?.secondWave || {};
  const intra = report?.intraday || {};
  const dec = report?.decision || null;
  const tech = report?.technicals || {};
  const mkt = report?.marketContext || {};
  const sts = report?.shortTermStatus || null;
  const fiveStep = report?.fiveStepSystem || null;
  const s1Timing = fiveStep?.step1Timing || {};
  const s2Theme = fiveStep?.step2MainTheme || {};
  const s3Dragon = fiveStep?.step3Dragon || {};
  const s4Exec = fiveStep?.step4Execution || {};
  const provenance = fiveStep?.provenance || {};
  const isUp = q.chg >= 0;

  const matchedPoolStock = report?.code
    ? (pool || []).find((s) => String(s.code || '').padStart(6, '0') === String(report.code).padStart(6, '0'))
    : null;

  // 切换诊断股票时，自动填入该股已有止损价或系统测算的唯一硬止损线
  useEffect(() => {
    if (!report?.code) {
      setCustomStopInput('');
      return;
    }
    const existingStop = +(matchedPoolStock?.stopPrice || 0);
    const recStop = +(dec?.tradePlan?.stopLossPrice || s4Exec?.recommendedStopPrice || 0);
    const initStop = existingStop > 0 ? existingStop : recStop;
    setCustomStopInput(initStop > 0 ? initStop.toFixed(2) : '');
  }, [report?.code, dec?.tradePlan?.stopLossPrice, s4Exec?.recommendedStopPrice, matchedPoolStock?.stopPrice]);

  const isTracked = useMemo(() => {
    if (!report?.code) return false;
    const c6 = String(report.code).padStart(6, '0');
    return Boolean(trackedCodes.has(c6) || provenance.inTrackingPool);
  }, [report?.code, trackedCodes, provenance.inTrackingPool]);

  const holdShares = +(diagChartStock?.shares ?? matchedPoolStock?.shares ?? 0);
  const holdCost = holdShares > 0 ? +(diagChartStock?.cost || matchedPoolStock?.cost || 0) : 0;
  const holdBePrice = (() => {
    if (holdShares <= 0) return 0;
    const savedBe = +(diagChartStock?.bePrice || matchedPoolStock?.bePrice || 0);
    if (savedBe > 0) return savedBe;
    const basePx = +(q.price || chips.curPrice || holdCost || 0);
    if (basePx <= 0) return 0;
    try {
      return calcTBreakeven({
        mode: 'BUY',
        entryPx: basePx,
        qty: Math.min(holdShares, 1000) || 100,
        commRate: 0.00025,
        hasMin5: true,
      }).targetPx;
    } catch (_) {
      return 0;
    }
  })();

  const handleToggleTracking = async () => {
    if (!report?.code) return;
    const c6 = String(report.code).padStart(6, '0');
    const nextAct = isTracked ? 'remove' : 'add';
    try {
      setTrackingBusy(true);
      await postIgnitionTrackingAction({
        action: nextAct,
        code: c6,
        name: q.name || c6,
        hybk: s2Theme.themeName || comp.industry || '诊股跟踪',
        price: q.price || 0,
        strategy: provenance.inDipPool ? 'bottom' : provenance.inTailPool ? 'tail_watch' : 'ignition',
        subType: s3Dragon.stage || 'DIAG_REVIEW',
        verdict: s3Dragon.stageLabel && s3Dragon.stageLabel !== '—' ? s3Dragon.stageLabel : (dec?.canBuyVerdict || '全景终审加入跟踪'),
      });
      setTrackedCodes((prev) => {
        const next = new Set(prev);
        if (nextAct === 'add') next.add(c6);
        else next.delete(c6);
        return next;
      });
      toastOk(nextAct === 'add' ? `📌 已将 ${q.name || c6} 加入全站在轨跟踪池` : `已将 ${q.name || c6} 移出在轨跟踪池`);
    } catch (err) {
      toastErr(err?.message || '在轨跟踪池操作失败');
    } finally {
      setTrackingBusy(false);
    }
  };

  const handleCommitToBattlePool = (jumpToTrade = true) => {
    if (!report?.code || !onAddStockToPool) return;
    const parsedStop = parseFloat(customStopInput);
    const stopVal =
      Number.isFinite(parsedStop) && parsedStop > 0
        ? Number(parsedStop.toFixed(2))
        : Number((dec?.tradePlan?.stopLossPrice || q.price * 0.955 || 0).toFixed(2));
    if (stopVal <= 0) {
      toastWarn('请先确认有效的硬止损线价格（第四步纪律：无止损不开仓）');
      return;
    }
    const drgStars = +(s3Dragon.dragonStars || 0);
    const tag =
      drgStars >= 4.0
        ? `游龙${drgStars}★`
        : provenance.inTailPool
        ? '尾盘'
        : provenance.inBreakoutPool
        ? '起爆'
        : '五步严选';
    onAddStockToPool(
      report.code,
      {
        name: q.name || report.code,
        strategyTag: tag,
        strategy: 'ignition',
        dragonStars: drgStars || undefined,
        isMainTheme: Boolean(s2Theme.isMainTheme),
        mainThemeName: s2Theme.themeName || '',
        refPrice: q.price || 0,
        stopPrice: stopVal,
        targetPrice: dec?.tradePlan?.targetPrice1 || Number(((q.price || 0) * 1.05).toFixed(2)),
        targetPrice2: dec?.tradePlan?.targetPrice2 || Number(((q.price || 0) * 1.10).toFixed(2)),
        stageLabel: s3Dragon.stageLabel || dec?.canBuyVerdict || '',
        advice: dec?.timingAnalysis || s3Dragon.stageTip || '',
      },
      { jumpToTrade }
    );
  };

  // 保留旧函数别名兼容下方面板调用
  const handleQuickAddHerd = handleToggleTracking;

  // 公告筛选
  const filteredAnnouncements = (report?.announcements || []).filter(a => {
    if (annFilter === 'red') return a.level === 'red';
    if (annFilter === 'green') return a.level === 'green';
    return true;
  });

  return (
    <div className="page-diagnosis" style={{ marginTop: '12px' }}>
      {/* 1. 顶部检索与单手快速切换栏 */}
      <section className="diag-search-card">
        <div className="diag-top-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <span style={{ fontSize: '20px', flexShrink: 0 }}>🩺</span>
            <div style={{ minWidth: 0 }}>
              <h2 className="diag-top-title">
                任意股票全景体检报告
                <span className="diag-top-badge">
                  二波预期 · 板块生态 · 分时VWAP · 排雷自救
                </span>
              </h2>
              <p className="diag-top-desc">
                临时看股、朋友问股、深套自救诊断 —— 深度透视板块二轮预期、日内分时黄白线、套牢盘筹码与做T处方
              </p>
            </div>
          </div>

          {/* 搜索框：窄屏 100% 全宽 + 16px 防 iOS 放大 + 大热区联想候选 */}
          <div ref={searchBoxRef} className="diag-search-wrap">
            <div className="diag-input-box">
              <input
                type="text"
                enterKeyHint="search"
                placeholder="输入代码 / 股票名 / 拼音（如 万丰奥威）"
                value={inputText}
                onFocus={() => {
                  if (suggestions.length > 0 && !extractCodeFromInput(inputText)) {
                    setShowSuggest(true);
                  }
                }}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (showSuggest && suggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setHighlightIdx((i) => (i + 1) % suggestions.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setHighlightIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                      return;
                    }
                    if (e.key === 'Escape') {
                      setShowSuggest(false);
                      return;
                    }
                    if (e.key === 'Enter' && highlightIdx >= 0 && suggestions[highlightIdx]) {
                      e.preventDefault();
                      const picked = suggestions[highlightIdx];
                      runDiagnosis(picked.code, picked.name);
                      return;
                    }
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmitSearch();
                  }
                }}
                className="diag-search-input"
              />
              {inputText && (
                <button
                  type="button"
                  title="清空"
                  aria-label="清空输入"
                  className="diag-clear-btn"
                  onClick={() => {
                    suppressSuggestRef.current = true;
                    setInputText('');
                    setSuggestions([]);
                    setShowSuggest(false);
                  }}
                >
                  ✕
                </button>
              )}

              {showSuggest && suggestions.length > 0 && (
                <div className="diag-suggest-pop">
                  <div style={{ padding: '5px 12px', fontSize: '11px', color: 'var(--mute)', background: 'var(--surface2)', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>点选 A 股标的立即体检</span>
                    {searching && <span>检索中…</span>}
                  </div>
                  {suggestions.map((cand, idx) => (
                    <button
                      key={cand.code}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runDiagnosis(cand.code, cand.name);
                      }}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      className={`diag-suggest-item ${highlightIdx === idx ? 'active' : ''}`}
                    >
                      <span style={{ fontWeight: 700 }}>{cand.name}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {cand.market && (
                          <span style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '4px', background: 'var(--surface2)', color: 'var(--sub)' }}>
                            {cand.market}
                          </span>
                        )}
                        <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--mute)', fontSize: '12px' }}>
                          {cand.code}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleSubmitSearch}
              disabled={loading || searching}
              className="diag-submit-btn"
            >
              {loading ? '🔍 体检中…' : searching ? '🔎 匹配中…' : '🔍 立即体检'}
            </button>
          </div>
        </div>

        {/* 全站选股漏斗待审候选条：直接把起爆活口、尾盘黑马、在轨跟踪、自选池串联起来逐只连点过筛 */}
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11.5px' }}>
              <span style={{ fontWeight: 800, color: 'var(--text)' }}>⚡ 待审候选连点过筛:</span>
              {[
                { k: 'all', label: `全部候选 (${sourceCounts.total})` },
                { k: 'ignition', label: `🔥 起爆/深跌 (${sourceCounts.ignCnt})` },
                { k: 'tail', label: `🌙 尾盘黑马 (${sourceCounts.tailCnt})` },
                { k: 'tracking', label: `🎯 在轨跟踪 (${sourceCounts.trkCnt})` },
                { k: 'pool', label: `💼 自选作战 (${sourceCounts.poolCnt})` },
              ].map((tb) => (
                <button
                  key={tb.k}
                  type="button"
                  className={`mini ${candSourceFilter === tb.k ? 'primary' : ''}`}
                  onClick={() => setCandSourceFilter(tb.k)}
                  style={{ marginLeft: 0, padding: '2px 8px', fontSize: '11px' }}
                >
                  {tb.label}
                </button>
              ))}
            </div>

            {funnelCandidates.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className="mini"
                  style={{ marginLeft: 0, padding: '2px 8px', fontSize: '11px' }}
                  onClick={() => {
                    const curIdx = funnelCandidates.findIndex((x) => x.code === activeCode);
                    const prevIdx = curIdx > 0 ? curIdx - 1 : funnelCandidates.length - 1;
                    const pick = funnelCandidates[prevIdx];
                    if (pick) handlePresetClick(pick.code, pick.name);
                  }}
                >
                  ◀ 上一只
                </button>
                <button
                  type="button"
                  className="mini"
                  style={{ marginLeft: 0, padding: '2px 8px', fontSize: '11px' }}
                  onClick={() => {
                    const curIdx = funnelCandidates.findIndex((x) => x.code === activeCode);
                    const nextIdx = curIdx >= 0 && curIdx < funnelCandidates.length - 1 ? curIdx + 1 : 0;
                    const pick = funnelCandidates[nextIdx];
                    if (pick) handlePresetClick(pick.code, pick.name);
                  }}
                >
                  下一只 ▶
                </button>
              </div>
            )}
          </div>

          <div className="diag-preset-strip" style={{ marginTop: 0 }}>
            {funnelCandidates.length > 0
              ? funnelCandidates.map((c) => (
                  <button
                    key={`${c.source}_${c.code}`}
                    type="button"
                    onClick={() => handlePresetClick(c.code, c.name)}
                    className={`diag-preset-pill ${activeCode === c.code ? 'active' : ''}`}
                  >
                    {c.tagPrefix}·{c.name}
                    {c.badgeText ? <span style={{ opacity: 0.85, fontFamily: 'monospace' }}>{c.badgeText}</span> : null}
                  </button>
                ))
              : QUICK_PRESETS.map((p) => (
                  <button
                    key={p.code}
                    type="button"
                    onClick={() => handlePresetClick(p.code, p.name)}
                    className={`diag-preset-pill preset ${activeCode === p.code ? 'active' : ''}`}
                  >
                    {p.name}
                  </button>
                ))}
          </div>
        </div>
      </section>

      {/* 2. 诊断报告正文 */}
      {loading ? (
        <section style={{ textAlign: 'center', padding: '56px 16px', color: 'var(--sub)' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>正在并发扫描五步游龙六维、210日筹码峰、分时VWAP与公告排雷…</div>
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '6px' }}>自动对齐上证天时结构、热点主线身位与试盘起点硬止损线</div>
        </section>
      ) : errorMsg ? (
        <section style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--up)' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>⚠️</div>
          <div style={{ fontWeight: 600 }}>诊断数据获取失败</div>
          <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '4px' }}>{errorMsg}</div>
          <button
            type="button"
            onClick={() => runDiagnosis(activeCode)}
            style={{ marginTop: '14px', padding: '6px 14px', background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: '6px', cursor: 'pointer' }}
          >
            重试
          </button>
        </section>
      ) : report ? (
        <div>
          {/* 🧭 单手章节速达锚点导航条 */}
          <div className="diag-anchor-bar" role="navigation" aria-label="体检报告章节速达">
            {dec && (
              <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecDecision')}>
                🎯 买点结论
              </button>
            )}
            {fiveStep && (
              <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecFiveStep')}>
                🐉 五步终审与止损
              </button>
            )}
            {diagChartStock && (
              <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecChart')}>
                📈 分时看盘
              </button>
            )}
            <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecSector')}>
              🌊 板块二波
            </button>
            <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecChips')}>
              🎯 筹码处方
            </button>
            <button type="button" className="diag-anchor-chip" onClick={() => scrollToDiagSection('diagSecAnn')}>
              📰 公告排雷 ({report.announcements?.length || 0})
            </button>
            <button type="button" className="diag-anchor-chip copy" onClick={handleCopySummary}>
              📋 复制结论
            </button>
          </div>

          {/* A. 标的概览头部卡 */}
          <section className="diag-overview-card">
            <div className="diag-overview-hd">
              <div style={{ minWidth: 0, flex: '1 1 300px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <h1 style={{ fontSize: '21px', fontWeight: 800, margin: 0 }}>{q.name}</h1>
                  <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '14.5px', color: 'var(--sub)' }}>
                    {report.code}
                  </span>
                  <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', background: 'var(--surface2)', color: 'var(--mute)' }}>
                    {comp.industry && !['-', '--', '—'].includes(comp.industry) ? comp.industry : '行业未归类'}
                  </span>
                  {s3Dragon.dragonStars != null && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: s3Dragon.dragonStars >= 4.0 ? 'var(--warn-bg)' : 'var(--surface2)',
                        color: s3Dragon.dragonStars >= 4.0 ? 'var(--warn-d)' : 'var(--sub)',
                        border: `1px solid ${s3Dragon.dragonStars >= 4.0 ? 'var(--warn-b)' : 'var(--line2)'}`,
                      }}
                    >
                      {s3Dragon.dragonLabel} ({s3Dragon.dragonStars}★)
                    </span>
                  )}
                  {(provenance.badges || []).map((bg, bi) => (
                    <span
                      key={bi}
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 7px',
                        borderRadius: '4px',
                        background: 'var(--info-bg)',
                        color: 'var(--info-d)',
                        border: '1px solid var(--info-b)',
                      }}
                    >
                      {bg}
                    </span>
                  ))}
                  {isInPool ? (
                    <button
                      type="button"
                      onClick={() => handleCommitToBattlePool(true)}
                      className="diag-quick-act in-pool"
                      title="同步最新划定硬止损线并直达今日作战台"
                    >
                      ✓ 同步止损进作战台 →
                    </button>
                  ) : onAddStockToPool ? (
                    <button
                      type="button"
                      onClick={() => handleCommitToBattlePool(false)}
                      className="diag-quick-act"
                      title="带当前划定的硬止损线原位加入作战池，不跳走可继续审下一只"
                    >
                      🛡️ 带止损入作战池
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={trackingBusy}
                    onClick={handleToggleTracking}
                    className={`diag-quick-act ${isTracked ? 'in-pool' : ''}`}
                    title="同步至起爆/尾盘共享的全站在轨跟踪池（含主板与300/688）"
                  >
                    {trackingBusy ? '⏳…' : isTracked ? '✓ 已在轨跟踪' : '📌 加在轨跟踪'}
                  </button>
                  {onJumpIgnition && (
                    <button
                      type="button"
                      onClick={() => onJumpIgnition(report.code)}
                      className="diag-quick-act ignition"
                      title="返回起爆挖掘池查看全市场候选"
                    >
                      🚀 起爆池
                    </button>
                  )}
                </div>
                <div style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--sub)', lineHeight: 1.6, maxWidth: '750px' }}>
                  <b>公司主营定位：</b>{comp.summary || '暂无主营介绍'}
                </div>
              </div>

              {/* 现价与关键指标 */}
              <div className="diag-quote-box">
                <div className="diag-quote-px">
                  <span style={{ fontSize: '25px', fontWeight: 800, fontFamily: 'ui-monospace, Consolas, monospace', color: isUp ? 'var(--up)' : 'var(--down)' }}>
                    ¥{f2(q.price)}
                  </span>
                  <span style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'ui-monospace, Consolas, monospace', color: isUp ? 'var(--up)' : 'var(--down)' }}>
                    {q.chg >= 0 ? `+${f2(q.chg)}%` : `${f2(q.chg)}%`}
                  </span>
                </div>
                <div className="diag-quote-meta">
                  <span>换手 <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.turnover)}%</b></span>
                  {q.vr > 0 && <span>量比 <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.vr)}倍</b></span>}
                  {q.buyRatio > 0 && (
                    <span>外盘 <b style={{ fontFamily: 'ui-monospace, monospace', color: q.buyRatio >= 52 ? 'var(--up)' : 'var(--down)' }}>{q.buyRatio}%</b></span>
                  )}
                  <span>流通 <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.cap)}亿</b></span>
                  <span>PE <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.pe)}</b></span>
                  <span>PB <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.pb)}</b></span>
                </div>
              </div>
            </div>

            {/* 顶栏公告雷达横幅 */}
            <div
              className="diag-radar-strip"
              style={{
                background: report.riskColor === 'red' ? 'var(--up-bg)' : report.riskColor === 'yellow' ? 'var(--warn-bg)' : 'var(--down-bg)',
                border: `1px solid ${report.riskColor === 'red' ? 'var(--up-b)' : report.riskColor === 'yellow' ? 'var(--warn-b)' : 'var(--down-b)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '16px', flexShrink: 0, lineHeight: 1.4 }}>
                  {report.riskColor === 'red' ? '🚨' : report.riskColor === 'yellow' ? '⚠️' : '🟢'}
                </span>
                <div style={{ fontSize: '12.5px', lineHeight: 1.5 }}>
                  <b style={{ color: report.riskColor === 'red' ? 'var(--up-d)' : report.riskColor === 'yellow' ? 'var(--warn-d)' : 'var(--down-d)' }}>
                    【公告排雷雷达】{report.riskLevel}：
                  </b>
                  <span style={{ color: 'var(--text)' }}>
                    {report.redFlags?.length > 0
                      ? `近30天检测到 ${report.redFlags.length} 条高危公告，存在潜在雷区，切忌逆势盲目补仓！`
                      : report.yellowAlerts?.length > 0
                      ? `近期存在 ${report.yellowAlerts.length} 条关注类公告（如质押/异动），需留意主力动态。`
                      : '近30天未排查到重大减持、立案调查、违规警示或退市风险，公告面雷达处于安全区。'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCopySummary}
                className="diag-copy-btn"
              >
                📋 复制微信结论
              </button>
            </div>
          </section>

          {/* A2. 🎯 多维综合诊股决策与买点评估中心 */}
          {dec && (
            <section
              id="diagSecDecision"
              className="diag-sec-anchor"
              style={{
                padding: '16px 18px',
                marginBottom: '14px',
                border: '1.5px solid',
                borderColor: dec.canBuyLevel === 'STRONG_BUY' ? 'var(--down-b)' : dec.canBuyLevel === 'BUY_DIP' ? '#7dd3fc' : dec.canBuyLevel === 'WAIT' ? 'var(--warn-b)' : 'var(--up-b)',
                background: 'var(--surface)',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.05)'
              }}
            >
              {/* 第一层：总分仪 + 能不能买结论 + 右侧五维拆解（窄屏自动上下堆叠，彻底告别挤压） */}
              <div className="diag-dec-grid">
                {/* 左侧：核心结论与买入时机判定 */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    {/* 综合评分徽章 */}
                    <div
                      style={{
                        width: '70px',
                        height: '70px',
                        borderRadius: '14px',
                        background: dec.totalScore >= 75 ? 'linear-gradient(135deg, #16a34a, #15803d)' : dec.totalScore >= 60 ? 'linear-gradient(135deg, #0284c7, #0369a1)' : dec.totalScore >= 45 ? 'linear-gradient(135deg, #d97706, #b45309)' : 'linear-gradient(135deg, #dc2626, #991b1b)',
                        color: '#fff',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 4px 10px rgba(0,0,0,0.12)',
                        flexShrink: 0
                      }}
                    >
                      <span style={{ fontSize: '25px', fontWeight: 900, lineHeight: 1, fontFamily: 'monospace' }}>
                        {dec.totalScore}
                      </span>
                      <span style={{ fontSize: '10px', opacity: 0.9, marginTop: '3px' }}>综合分/100</span>
                    </div>

                    <div style={{ flex: 1, minWidth: '180px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '16px',
                            fontWeight: 800,
                            color: dec.canBuyLevel === 'STRONG_BUY' ? 'var(--down-d)' : dec.canBuyLevel === 'BUY_DIP' ? 'var(--accent-d)' : dec.canBuyLevel === 'WAIT' ? 'var(--warn-d)' : 'var(--up)'
                          }}
                        >
                          {dec.canBuyVerdict}
                        </span>
                        <span
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: dec.riskColor === 'red' ? 'var(--up-bg)' : dec.riskColor === 'yellow' ? 'var(--warn-bg)' : 'var(--down-bg)',
                            color: dec.riskColor === 'red' ? '#dc2626' : dec.riskColor === 'yellow' ? '#d97706' : '#16a34a',
                            border: `1px solid ${dec.riskColor === 'red' ? 'var(--up-b)' : dec.riskColor === 'yellow' ? 'var(--warn-b)' : 'var(--down-b)'}`
                          }}
                        >
                          风险：{dec.riskRating}
                        </span>
                      </div>

                      {/* 关键技术 & 市场辅助标签 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '6px', fontSize: '11.5px', color: 'var(--sub)' }}>
                        <span>📈 趋势: <b>{tech.trendStatus || '—'}{tech.bollStructure ? ` (${tech.bollStructure})` : ''}</b></span>
                        {tech.bollMid > 0 && (
                          <span className="num-mono">
                            · BOLL 支撑 <b style={{ color: 'var(--down-d)' }}>{f2(tech.bollLower)}</b> / 中轨 <b>{f2(tech.bollMid)}</b> / 压力 <b style={{ color: 'var(--up)' }}>{f2(tech.bollUpper)}</b>
                          </span>
                        )}
                        {tech.topDivergence && (
                          <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--warn-bg)', color: 'var(--warn-d)', border: '1px solid var(--warn-b)', fontWeight: 700 }} title={tech.topDivDesc}>
                            ⚠️ 日线顶背离·卖出锁盈
                          </span>
                        )}
                        {tech.bottomDivergence && (
                          <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--down-bg)', color: 'var(--down-d)', border: '1px solid var(--down-b)', fontWeight: 700 }} title={tech.bottomDivDesc}>
                            🎯 日线底背离·止跌观察
                          </span>
                        )}
                        <span>· RSI(6): <b style={{ color: (tech.rsi6 ?? 50) >= 78 ? 'var(--up)' : (tech.rsi6 ?? 50) <= 25 ? 'var(--down)' : 'var(--text)' }}>{tech.rsi6 != null ? Number(tech.rsi6).toFixed(1) : '—'}</b></span>
                        <span>· 5日: <b style={{ color: (tech.chg5d ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(tech.chg5d, true)}</b></span>
                        {mkt.valveLabel && (
                          <span style={{ padding: '1px 6px', borderRadius: '4px', background: mkt.valveBg, color: mkt.valveColor, border: `1px solid ${mkt.valveBorder}`, fontWeight: 600 }}>
                            大盘：{mkt.valveLabel}{mkt.brokenRate != null ? ` (炸板${fmtPct(mkt.brokenRate)})` : ''}
                          </span>
                        )}
                      </div>
                      {dec.styleFit && (
                        <div
                          style={{
                            marginTop: '6px',
                            display: 'inline-block',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: dec.styleFitLevel === 'narrow' ? 'var(--surface2)' : dec.styleFitLevel === 'high_vol' ? 'var(--warn-bg)' : 'var(--info-bg)',
                            color: dec.styleFitLevel === 'narrow' ? 'var(--sub)' : dec.styleFitLevel === 'high_vol' ? 'var(--warn-d)' : 'var(--accent-d)',
                            border: `1px solid ${dec.styleFitLevel === 'narrow' ? 'var(--line2)' : dec.styleFitLevel === 'high_vol' ? 'var(--warn-b)' : 'var(--info-b)'}`
                          }}
                        >
                          {dec.styleFit}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 现在是不是买点判定框 */}
                  <div
                    style={{
                      padding: '10px 13px',
                      borderRadius: '8px',
                      background: dec.isBuyPointNow ? 'var(--down-bg)' : 'var(--warn-bg)',
                      border: `1px solid ${dec.isBuyPointNow ? 'var(--down-b)' : 'var(--warn-b)'}`,
                      marginBottom: '12px'
                    }}
                  >
                    <div style={{ fontSize: '13.5px', fontWeight: 800, color: dec.isBuyPointNow ? 'var(--down-d)' : 'var(--warn-d)', marginBottom: '4px' }}>
                      ⏱️ 【时点判定】{dec.timingHeadline}
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--sub)', lineHeight: 1.55 }}>
                      {dec.timingAnalysis}
                    </div>
                  </div>

                  {/* A股K线形态与缺口状态机警示条 */}
                  <KlinePatternBadges klinePatterns={report.klinePatterns} variant="banner" style={{ marginBottom: '12px', marginTop: 0 }} />

                  {/* 参考交易价格带（手机窄屏自动转为 2×2 双列网格） */}
                  {dec.tradePlan && (
                    <div>
                      <div className="diag-grid-4">
                        <div style={{ padding: '8px 10px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)', minWidth: 0 }}>
                          <div style={{ fontSize: '11px', color: 'var(--mute)' }}>建议仓位配比</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--text)', marginTop: '2px' }}>
                            {dec.tradePlan.suggestedPosition}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--down-bg)', borderRadius: '6px', border: '1px solid var(--down-b)', minWidth: 0 }}>
                          <div style={{ fontSize: '11px', color: 'var(--down-d)' }}>理想低吸区间</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--down-d)', marginTop: '2px', overflowWrap: 'anywhere' }}>
                            ¥{f2(dec.tradePlan.idealBuyLow)}~¥{f2(dec.tradePlan.idealBuyHigh)}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--up-bg)', borderRadius: '6px', border: '1px solid var(--up-b)', minWidth: 0 }}>
                          <div style={{ fontSize: '11px', color: '#dc2626' }}>破位防套止损线</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: '#dc2626', marginTop: '2px' }}>
                            ¥{f2(dec.tradePlan.stopLossPrice)}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--info-bg)', borderRadius: '6px', border: '1px solid var(--info-b)', minWidth: 0 }}>
                          <div style={{ fontSize: '11px', color: 'var(--info-d)' }}>上方压力/目标位</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--info-d)', marginTop: '2px' }}>
                            ¥{f2(dec.tradePlan.targetPrice1)}
                          </div>
                        </div>
                      </div>
                      {dec.tradePlan.calibrationNote && (
                        <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--mute)' }}>
                          📏 {dec.tradePlan.calibrationNote}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 右侧：5 维量化评分拆解条 */}
                <div style={{ padding: '12px 14px', background: 'var(--card)', borderRadius: '8px', border: '1px solid var(--line)', minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px', color: 'var(--text)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📊 五维量化得分拆解</span>
                    <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>总分 {dec.totalScore}/100</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {(dec.scoreBreakdown || []).map((item, idx) => {
                      const ratio = item.max > 0 ? (item.score / item.max) * 100 : 0;
                      const barCol = ratio >= 75 ? '#16a34a' : ratio >= 55 ? 'var(--accent)' : ratio >= 40 ? '#d97706' : '#dc2626';
                      return (
                        <div key={idx}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', fontSize: '11.5px', marginBottom: '3px', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{item.name}</span>
                            <span>
                              <b style={{ fontFamily: 'monospace', color: barCol }}>{item.score}</b>
                              <span style={{ color: 'var(--mute)', fontSize: '11px' }}>/{item.max} · {item.desc}</span>
                            </span>
                          </div>
                          <div style={{ height: '6px', background: 'var(--surface2)', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ width: `${ratio}%`, height: '100%', background: barCol, borderRadius: '3px', transition: 'width 0.4s ease' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 第二层：支撑买入依据 vs 风险隐患提示 双栏明细（窄屏自动单列） */}
              <div className="diag-grid-2" style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)' }}>
                <div style={{ padding: '10px 12px', background: 'var(--down-bg)', borderRadius: '6px', border: '1px solid #dcfce7' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--down-d)', marginBottom: '6px' }}>
                    ✅ 积极加分与买入依据 ({dec.positivePoints?.length || 0})
                  </div>
                  {dec.positivePoints && dec.positivePoints.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: 'var(--down-d)', lineHeight: 1.6 }}>
                      {dec.positivePoints.map((pt, idx) => <li key={idx}>{pt}</li>)}
                    </ul>
                  ) : (
                    <div style={{ fontSize: '12px', color: 'var(--mute)' }}>暂无明显突出多头优势依据</div>
                  )}
                </div>

                <div style={{ padding: '10px 12px', background: 'var(--up-bg)', borderRadius: '6px', border: '1px solid #fee2e2' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--up)', marginBottom: '6px' }}>
                    ⚠️ 核心隐患与风险排查 ({dec.riskPoints?.length || 0})
                  </div>
                  {dec.riskPoints && dec.riskPoints.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: 'var(--up-d)', lineHeight: 1.6 }}>
                      {dec.riskPoints.map((pt, idx) => <li key={idx}>{pt}</li>)}
                    </ul>
                  ) : (
                    <div style={{ fontSize: '12px', color: 'var(--down-d)' }}>当前多维度排查暂无显著硬伤风险</div>
                  )}
                </div>
              </div>

              {/* 🐉 五步交易系统终审与涨停回调六维核验 + 第四步先划止损入池操作台 */}
              {fiveStep && (
                <div
                  id="diagSecFiveStep"
                  style={{
                    marginTop: '14px',
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'var(--card)',
                    border: '1.5px solid var(--line2)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '14.5px', fontWeight: 800, color: 'var(--text)' }}>
                        🐉 五步交易系统终审 · 涨停回调再突破六维与硬止损划定
                      </span>
                      {s3Dragon.stageLabel && s3Dragon.stageLabel !== '—' && (
                        <span
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 800,
                            padding: '2px 8px',
                            borderRadius: '5px',
                            background: s3Dragon.stage === 'SHAKEOUT_READY' ? 'var(--up-bg)' : 'var(--warn-bg)',
                            color: s3Dragon.stage === 'SHAKEOUT_READY' ? 'var(--up)' : 'var(--warn-d)',
                            border: `1px solid ${s3Dragon.stage === 'SHAKEOUT_READY' ? 'var(--up-b)' : 'var(--warn-b)'}`,
                          }}
                        >
                          {s3Dragon.stageLabel}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: '11.5px', color: 'var(--mute)', fontFamily: 'monospace' }}>
                      与「起爆挖掘」共用同一套六维引擎 · 零口径漂移
                    </span>
                  </div>

                  {/* 前四步全链路状态卡片 */}
                  <div className="diag-grid-4" style={{ marginBottom: '12px' }}>
                    <div style={{ padding: '9px 11px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--mute)' }}>① 顺天时 · 相对大盘抗跌</div>
                      <div style={{ fontSize: '12.5px', fontWeight: 800, color: s1Timing.isResilient ? 'var(--down-d)' : 'var(--text)', marginTop: '3px' }}>
                        {s1Timing.regimeLabel || '常态环境'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px', fontFamily: 'monospace' }}>
                        5日RS <b style={{ color: (s1Timing.rs5d || 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(s1Timing.rs5d, true, 1)}</b> · {s1Timing.entryModeLabel}
                      </div>
                    </div>

                    <div style={{ padding: '9px 11px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--mute)' }}>② 抓主线 · 板块共振</div>
                      <div style={{ fontSize: '12.5px', fontWeight: 800, color: s2Theme.isMainTheme ? 'var(--up)' : 'var(--sub)', marginTop: '3px' }}>
                        {s2Theme.isMainTheme ? `🎯 ${s2Theme.themeName}` : (s2Theme.themeName || '非今日Top主线')}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                        {s2Theme.cycleStageLabel || '普通题材轮动'}
                      </div>
                    </div>

                    <div style={{ padding: '9px 11px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--mute)' }}>③ 择良标 · 五星游龙</div>
                      <div style={{ fontSize: '12.5px', fontWeight: 800, color: (s3Dragon.dragonStars || 0) >= 4.0 ? 'var(--warn-d)' : 'var(--text)', marginTop: '3px' }}>
                        {s3Dragon.dragonLabel} ({s3Dragon.dragonStars ?? '—'}★ / 起爆 {s3Dragon.ignitionScore ?? '—'}分)
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                        {(s3Dragon.dragonDims || []).map((d) => `${d.label.slice(0, 2)}${d.star}★`).join(' · ') || '等待试盘信号'}
                      </div>
                    </div>

                    <div style={{ padding: '9px 11px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--mute)' }}>④ 严执行 · 止损与背离</div>
                      <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: '#dc2626', marginTop: '3px' }}>
                        硬止损 ¥{customStopInput || f2(dec.tradePlan?.stopLossPrice)}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                        {s4Exec.hasTopDivergence
                          ? '⚠️ 日线顶背离·冲高锁盈'
                          : s4Exec.hasBottomDivergence
                          ? '🎯 日线底背离·止跌试错'
                          : `依据：${dec.tradePlan?.stopAnchorLabel || '动态防守'}`}
                      </div>
                    </div>
                  </div>

                  {/* 涨停试盘回调六维核验清单（与起爆页同源） */}
                  {Array.isArray(s3Dragon.checklist) && s3Dragon.checklist.length > 0 && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                        gap: '8px',
                        marginBottom: '12px',
                      }}
                    >
                      {s3Dragon.checklist.map((item) => {
                        const isPass = item.passed === true;
                        const isWarn = item.passed === 'warn';
                        const icon = isPass ? '✅' : isWarn ? '⚠️' : '❌';
                        const bdCol = isPass ? 'var(--down-b)' : isWarn ? 'var(--warn-b)' : 'var(--up-b)';
                        const bgCol = isPass ? 'var(--down-bg)' : isWarn ? 'var(--warn-bg)' : 'var(--up-bg)';
                        return (
                          <div
                            key={item.id}
                            style={{
                              padding: '8px 10px',
                              borderRadius: '7px',
                              background: bgCol,
                              border: `1px solid ${bdCol}`,
                              fontSize: '11px',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                              <b style={{ color: 'var(--text)' }}>{icon} {item.title}</b>
                              <span style={{ fontWeight: 800, color: isPass ? 'var(--down-d)' : isWarn ? 'var(--warn-d)' : '#dc2626' }}>
                                {item.badge}
                              </span>
                            </div>
                            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)' }}>{item.val}</div>
                            <div style={{ color: 'var(--sub)', marginTop: '2px', lineHeight: 1.35 }}>{item.detail}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 第四步动作闭环：先选/微调硬止损线，一键写入实盘作战池或在轨跟踪池 */}
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'var(--surface2)',
                      border: '1px solid var(--line2)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <b style={{ color: 'var(--text)' }}>🛡️ 先划止损线：</b>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontFamily: 'monospace', color: '#dc2626', fontWeight: 800 }}>¥</span>
                        <input
                          type="number"
                          step="0.01"
                          value={customStopInput}
                          onChange={(e) => setCustomStopInput(e.target.value)}
                          style={{
                            width: '86px',
                            padding: '4px 7px',
                            borderRadius: '6px',
                            border: '1px solid var(--up-b)',
                            background: 'var(--card)',
                            color: 'var(--text)',
                            fontFamily: 'monospace',
                            fontWeight: 800,
                            fontSize: '13px',
                          }}
                        />
                        {q.price > 0 && parseFloat(customStopInput) > 0 && (
                          <span style={{ fontFamily: 'monospace', fontSize: '11.5px', color: 'var(--sub)' }}>
                            ({(((parseFloat(customStopInput) - q.price) / q.price) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                      {(dec.tradePlan?.stopAnchors || []).map((anc) => (
                        <button
                          key={anc.key}
                          type="button"
                          className="mini"
                          onClick={() => setCustomStopInput(Number(anc.price).toFixed(2))}
                          style={{
                            marginLeft: 0,
                            padding: '2px 7px',
                            fontSize: '11px',
                            borderColor: Number(customStopInput) === Number(anc.price) ? 'var(--accent)' : undefined,
                          }}
                        >
                          {anc.label} ¥{f2(anc.price)}
                        </button>
                      ))}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      {onAddStockToPool && (
                        <>
                          <button
                            type="button"
                            className="mini"
                            onClick={() => handleCommitToBattlePool(false)}
                            style={{ marginLeft: 0, fontWeight: 700, padding: '5px 10px' }}
                            title="写入止损线与游龙标签原位留在诊股页，方便直接点上方「下一只 ▶」继续审图"
                          >
                            {isInPool ? '💾 保存止损线(留本页)' : '➕ 带止损原位入池(留本页)'}
                          </button>
                          <button
                            type="button"
                            className="mini primary"
                            onClick={() => handleCommitToBattlePool(true)}
                            style={{ marginLeft: 0, fontWeight: 800, padding: '5px 12px' }}
                          >
                            {isInPool ? '🛡️ 同步止损并进作战台 →' : '🚀 带硬止损入池并进作战台 →'}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="mini"
                        disabled={trackingBusy}
                        onClick={handleToggleTracking}
                        style={{ marginLeft: 0, padding: '5px 10px', fontWeight: 700 }}
                      >
                        {isTracked ? '✓ 已在轨跟踪' : '📌 加入在轨跟踪'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ⚡ 今日短线身位与连板/抱团/字辈联动雷达 */}
          {sts && (
            <section style={{
              padding: '14px 16px',
              marginBottom: '14px',
              background: sts.isBrokenBoard ? 'var(--up-bg)' : 'var(--accent-bg)',
              border: sts.isBrokenBoard ? '1.5px solid var(--up-b)' : '1.5px solid var(--accent-b)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 800, color: '#4c1d95' }}>
                    ⚡ 今日短线身位与连板 / 抱团雷达
                  </span>
                  {sts.statTag && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: sts.isLimitUp ? 'var(--up)' : 'var(--sub)', color: '#fff' }}>
                      {sts.statTag}
                    </span>
                  )}
                  {sts.isBrokenBoard && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: 'var(--up-bg)', color: 'var(--up)', border: '1px solid var(--up-b)' }}>
                      💥 曾涨停炸板 (回落 {sts.dropFromTop != null ? `${Number(sts.dropFromTop).toFixed(1)}%` : '—'} · 炸{sts.zbc}次)
                    </span>
                  )}
                  {sts.isRushing && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: 'var(--info-bg)', color: 'var(--accent)', border: '1px solid #38bdf8' }}>
                      ⚡ 冲板临界中 (距涨停 {sts.distCeiling != null ? `${Number(sts.distCeiling).toFixed(1)}%` : '—'})
                    </span>
                  )}
                  {sts.inHerdPool && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: 'var(--accent-bg)', color: 'var(--accent-d)', border: '1px solid var(--accent-b)' }}>
                      {sts.herdLabel || '🤝 自动抱团跟踪中'}
                    </span>
                  )}
                  {sts.isMysticResonant && sts.mysticCluster && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: 'var(--accent-bg)', color: 'var(--accent-d)', border: '1px solid var(--accent-b)' }}>
                      🔮 {sts.mysticCluster} ({sts.mysticZtCount}板共振)
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {sts.inHerdPool || addedHerdCode === String(report.code).padStart(6, '0') ? (
                    <a href="#/board" style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--accent-d)', textDecoration: 'none', padding: '4px 9px', borderRadius: '5px', background: 'var(--accent-bg)', border: '1px solid var(--accent-b)' }}>
                      ✓ 已在抱团池 · 去看板 →
                    </a>
                  ) : (String(report.code).startsWith('00') || String(report.code).startsWith('60')) && (
                    <button
                      type="button"
                      className="mini"
                      disabled={addingHerd}
                      onClick={handleQuickAddHerd}
                      style={{ fontSize: '11.5px', color: 'var(--accent-d)', borderColor: 'var(--accent-b)', background: 'var(--card)', fontWeight: 700, marginLeft: 0 }}
                    >
                      {addingHerd ? '加入中…' : '📌 加入抱团跟踪池'}
                    </button>
                  )}
                </div>
              </div>

              {sts.tags && sts.tags.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  {sts.tags.map((tg, idx) => (
                    <span
                      key={`${tg.key}_${idx}`}
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '1px 7px',
                        borderRadius: '4px',
                        background: tg.bg || 'var(--surface2)',
                        color: tg.color || 'var(--sub)',
                        border: `1px solid ${tg.border || 'var(--line2)'}`,
                      }}
                    >
                      {tg.label}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '8px' }}>
                {sts.identityScore != null && (
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--info-bg)', border: '1px solid var(--info-b)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--info-d)' }}>👑 身份分（市场地位）</span>
                      <span style={{ fontSize: '17px', fontWeight: 900, fontFamily: 'monospace', color: 'var(--info-d)' }}>{sts.identityScore}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--info-d)' }}>
                      连板{sts.scoreDims?.identity?.height ?? 0} · 记忆{sts.scoreDims?.identity?.memory ?? 0} · 板块{sts.scoreDims?.identity?.sector ?? 0} · 人气{sts.scoreDims?.identity?.popularity ?? 0}
                    </div>
                  </div>
                )}
                {sts.relayScore != null && (
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--up-bg)', border: '1px solid #fecdd3' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--up-d)' }}>⚡ 接力分（次日赔率）</span>
                      <span style={{ fontSize: '17px', fontWeight: 900, fontFamily: 'monospace', color: 'var(--up-d)' }}>{sts.relayScore}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#9f1239' }}>
                      首封{sts.scoreDims?.relay?.firstSeal ?? 0} · 封质{sts.scoreDims?.relay?.sealQuality ?? 0} · 换手{sts.scoreDims?.relay?.tradability ?? 0} · 周期{sts.scoreDims?.relay?.cycle ?? 0} · 强度{sts.scoreDims?.relay?.strength ?? 0}
                    </div>
                  </div>
                )}
                <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--card)', border: '1px solid var(--line)', fontSize: '12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '3px' }}>
                  {sts.isLimitUp ? (
                    <>
                      <div>首封 <b>{sts.fbt || '—'}</b> · 买一封单 <b>{sts.fund >= 1e6 ? money$(sts.fund) : '弱封'}</b></div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)' }}>{sts.buyTag || `封成比 ${Number(sts.sealRatio || 0).toFixed(2)}x`}</div>
                    </>
                  ) : (
                    <>
                      <div>MA5偏离 <b>{fmtPct(sts.vsMa5, true)}</b> · 峰值回撤 <b>{fmtPct(sts.ddFromPeak)}</b></div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                        {sts.cumReturnPct != null ? `入池累计收益 ${fmtPct(sts.cumReturnPct, true)}` : (sts.buyTag || '活跃跟踪状态')}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {(sts.cycleAdvice || sts.buyAction || sts.herdDesc) && (
                <div style={{ fontSize: '12px', padding: '7px 10px', borderRadius: '6px', background: 'var(--card)', border: '1px dashed var(--accent-b)', color: 'var(--sub)', lineHeight: 1.55 }}>
                  🧭 <b>短线窗口应对：</b>{sts.cycleAdvice || sts.buyAction || sts.herdDesc}
                </div>
              )}
            </section>
          )}

          {/* A4. 📈 分时图买卖点 & 多周期K线交互看盘 */}
          {diagChartStock && (
            <section id="diagSecChart" className="diag-sec-anchor" style={{ padding: '14px 14px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📈</span> {diagChartStock.name} ({diagChartStock.code}) · 分时买卖点看盘
                </h3>
                <span className="diag-chart-note">
                  叠加推荐买/卖区带、动态推荐点位与当日实盘标注
                </span>
              </div>
              <ChartCanvas
                stock={diagChartStock}
                poolIndex={99}
                tradeLogs={tradeLogs}
                onUpdateStock={(updated) => setDiagChartStock({ ...updated })}
                fastRefresh={fastRefresh}
                onToggleFastRefresh={onToggleFastRefresh}
              />
            </section>
          )}

          {/* B. 两列主网格（窄屏自动切为 1fr 全宽单列流，消除 170px 挤压） */}
          <div className="diag-main-grid">
            {/* 左列：板块生态 + 二波预期 + 分时VWAP + 筹码处方 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
              {/* 1. 板块身位与今日生态 */}
              <section id="diagSecSector" className="diag-sec-anchor" style={{ padding: '15px 16px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🌊</span> 板块生态与身位层级
                  </h3>
                  {sec.sectorName && !['-', '--', '—'].includes(sec.sectorName) && (
                    <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                      主线归属: <b>{sec.sectorName}</b> ({fmtPct(sec.sectorChg, true, 2)})
                    </span>
                  )}
                </div>

                {/* 板块身位卡 */}
                <div className="diag-grid-3" style={{
                  padding: '10px 10px',
                  borderRadius: '6px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  marginBottom: '10px',
                  textAlign: 'center'
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>板块今日生态</div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: (sec.sectorChg ?? 0) >= 0 ? 'var(--up)' : 'var(--down)', marginTop: '2px' }}>
                      {fmtPct(sec.sectorChg, true, 2)}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      {sec.upCount ? `${sec.upCount}涨/${sec.downCount}跌 (${sec.breadth})` : '非主线板块'}
                    </div>
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>个股身位定位</div>
                    <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text)', marginTop: '2px' }}>
                      {sec.role || '普通标的'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      相对弹性: {fmtPct(sec.relativeElasticity, true)}
                    </div>
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>板块领涨龙头</div>
                    <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--info)', marginTop: '2px', overflowWrap: 'anywhere' }}>
                      {sec.leader || '—'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      {sec.sectorRank ? `行业前 ${sec.sectorRank} 位` : '无排名'}
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--sub)', marginBottom: '8px' }}>
                  <b>核心概念题材 ({report.concepts?.length || 0}):</b>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {(report.concepts || []).map((c, i) => {
                    const isHot = (report.matchedHotThemes || []).some(m => m.name === c);
                    return (
                      <span
                        key={i}
                        style={{
                          fontSize: '12px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          background: isHot ? 'var(--up-bg)' : 'var(--surface2)',
                          color: isHot ? 'var(--up-d)' : 'var(--text)',
                          border: `1px solid ${isHot ? 'var(--up-b)' : 'var(--line)'}`,
                          fontWeight: isHot ? 700 : 400
                        }}
                      >
                        {isHot ? '🔥 ' : ''}{c}
                      </span>
                    );
                  })}
                </div>
              </section>

              {/* 2. 板块二轮 / 二波潜力预期时钟 */}
              <section style={{ padding: '15px 16px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🔄</span> 板块二轮 / 二波预期时钟
                  </h3>
                  <span style={{
                    fontSize: '11.5px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: wave.stageTag === 'golden_second' ? 'var(--down-bg)' : wave.stageTag === 'dead' ? 'var(--up-bg)' : 'var(--surface2)',
                    color: wave.stageTag === 'golden_second' ? 'var(--down-d)' : wave.stageTag === 'dead' ? 'var(--up-d)' : 'var(--sub)',
                    border: `1px solid ${wave.stageTag === 'golden_second' ? 'var(--down-b)' : wave.stageTag === 'dead' ? 'var(--up-b)' : 'var(--line)'}`
                  }}>
                    二波潜力: {wave.secondWavePotential || '普通'}
                  </span>
                </div>

                {wave.stage ? (
                  <div>
                    {/* 二波四项指标 */}
                    <div className="diag-grid-4" style={{ textAlign: 'center', marginBottom: '10px' }}>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>首轮最大波幅</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--up)' }}>{fmtPct(wave.wave1Amplitude, true)}</div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>高位最高价</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(wave.maxHigh)}</div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>高位回撤深度</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (wave.drawdown ?? 0) < -28 ? 'var(--up)' : 'var(--sub)' }}>
                          {fmtPct(wave.drawdown)}
                        </div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>量能萎缩沉淀</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (wave.volShrink ?? 100) <= 50 ? 'var(--down)' : 'var(--sub)' }}>
                          {fmtPct(wave.volShrink)}
                        </div>
                      </div>
                    </div>

                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: wave.stageTag === 'golden_second' ? 'var(--down-bg)' : 'var(--surface)',
                      border: `1px solid ${wave.stageTag === 'golden_second' ? 'var(--down-b)' : 'var(--line)'}`,
                      fontSize: '12.5px',
                      lineHeight: 1.6
                    }}>
                      <b>当前生命周期：</b><span style={{ fontWeight: 700 }}>{wave.stage}</span>
                      <div style={{ color: 'var(--sub)', marginTop: '3px' }}>{wave.desc}</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>暂无二波统计数据</div>
                )}
              </section>

              {/* 3. 全天分时态势与 VWAP 均价线 */}
              <section style={{ padding: '15px 16px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>📈</span> 全天分时态势与 VWAP 均价线
                  </h3>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                    日内振幅: <b style={{ color: (intra.amp ?? 99) < 2.0 ? 'var(--warn)' : 'var(--text)' }}>{fmtPct(intra.amp, false, 2)}</b>
                    {intra.amp != null && intra.amp < 2.0 && <span style={{ color: 'var(--warn)', marginLeft: '4px' }}>(振幅过窄)</span>}
                  </span>
                </div>

                {intra.vwap ? (
                  <div>
                    <div className="diag-grid-3" style={{ textAlign: 'center', marginBottom: '10px' }}>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)', minWidth: 0 }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>分时VWAP均价</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(intra.vwap)}</div>
                        <div style={{ fontSize: '11px', color: (intra.vwapDiff ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          偏离: {fmtPct(intra.vwapDiff, true)}
                        </div>
                      </div>

                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)', minWidth: 0 }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>站上均价线时间</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (intra.aboveRatio ?? 50) >= 60 ? 'var(--up)' : (intra.aboveRatio ?? 50) <= 30 ? 'var(--down)' : 'var(--sub)' }}>
                          {fmtPct(intra.aboveRatio)}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                          {(intra.aboveRatio ?? 50) >= 60 ? '多头控盘' : (intra.aboveRatio ?? 50) <= 30 ? '空头压制' : '多空拉锯'}
                        </div>
                      </div>

                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)', minWidth: 0 }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>日内高低极值</div>
                        <div style={{ fontSize: '12.5px', fontWeight: 700, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                          ¥{f2(intra.lowPrice)}~¥{f2(intra.highPrice)}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--sub)' }}>日内波幅</div>
                      </div>
                    </div>

                    {/* 分时进度条 */}
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '3px', color: 'var(--sub)' }}>
                        <span>均价线上方: {fmtPct(intra.aboveRatio)}</span>
                        <span>均价线下方: {intra.aboveRatio != null ? `${(100 - intra.aboveRatio).toFixed(1)}%` : '—'}</span>
                      </div>
                      <div style={{ height: '6px', background: 'var(--down-bg)', borderRadius: '3px', overflow: 'hidden', display: 'flex' }}>
                        <div style={{ width: `${intra.aboveRatio ?? 50}%`, background: 'var(--up)', height: '100%' }} />
                        <div style={{ width: `${100 - (intra.aboveRatio ?? 50)}%`, background: 'var(--down)', height: '100%' }} />
                      </div>
                    </div>

                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: intra.patternType === 'dump' ? 'var(--warn-bg)' : intra.patternType === 'bull' ? 'var(--up-bg)' : 'var(--surface)',
                      border: `1px solid ${intra.patternType === 'dump' ? 'var(--warn-b)' : intra.patternType === 'bull' ? 'var(--up-b)' : 'var(--line)'}`,
                      fontSize: '12.5px'
                    }}>
                      <b>日内形态归属：</b><span style={{ fontWeight: 700 }}>{intra.pattern}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>分时数据暂不可用</div>
                )}
              </section>

              {/* 4. 技术结构与筹码套牢盘诊断 */}
              <section id="diagSecChips" className="diag-sec-anchor" style={{ padding: '15px 16px', margin: 0 }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🎯</span> 筹码结构与技术位透视
                </h3>

                {chips && chips.ma5 > 0 ? (
                  <div>
                    {/* 均线矩阵 */}
                    <div className="diag-grid-4" style={{ textAlign: 'center', marginBottom: '12px' }}>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA5 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma5)}</div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA10 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma10)}</div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA20 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma20)}</div>
                      </div>
                      <div style={{ padding: '7px 6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA60 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma60)}</div>
                      </div>
                    </div>

                    {/* 20日箱体条 */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px', fontSize: '12px', marginBottom: '4px' }}>
                        <span>20日箱体: <b>¥{f2(chips.boxBot)} ~ ¥{f2(chips.boxTop)}</b></span>
                        <span style={{ color: (chips.boxPos ?? 50) >= 75 ? 'var(--warn)' : (chips.boxPos ?? 50) <= 25 ? 'var(--down)' : 'var(--mute)' }}>
                          当前处于箱内 <b>{fmtPct(chips.boxPos)}</b>
                        </span>
                      </div>
                      <div style={{ height: '7px', background: 'var(--surface2)', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(0, Math.min(100, chips.boxPos ?? 50))}%`,
                            background: (chips.boxPos ?? 50) >= 75 ? 'var(--warn)' : (chips.boxPos ?? 50) <= 25 ? 'var(--down)' : 'var(--info)',
                            borderRadius: '4px'
                          }}
                        />
                      </div>
                    </div>

                    {/* 210日CYQ横向筹码峰火焰柱状图（持仓股自动叠加成本线与做T保本线） */}
                    <CyqFlameChart
                      chips={chips}
                      curPrice={q.price || chips.curPrice}
                      holdCost={holdCost}
                      holdBePrice={holdBePrice}
                    />

                    {/* 210日换手衰减筹码成本、获利盘与集中度 */}
                    <div className="diag-chips-pair">
                      <div>
                        <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>
                          CYQ筹码均价 ({chips.cyqDays || 210}日衰减):
                        </div>
                        <div style={{ fontWeight: 700, fontSize: '15px', fontFamily: 'monospace' }}>
                          ¥{f2(chips.avgCost)}
                          {chips.peakPrice > 0 && (
                            <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--sub)', marginLeft: '6px' }}>
                              (主峰 ¥{f2(chips.peakPrice)})
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: (chips.diffFromCost ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          现价距均价: {fmtPct(chips.diffFromCost, true)}
                        </div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>CYQ获利盘比例:</div>
                        <div style={{ fontWeight: 700, fontSize: '15px', fontFamily: 'monospace', color: (chips.profitRatio ?? 50) <= 20 ? 'var(--down)' : (chips.profitRatio ?? 50) >= 80 ? 'var(--up)' : 'var(--text)' }}>
                          {fmtPct(chips.profitRatio)}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>
                          {chips.profitRatio <= 20 ? '80%以上筹码被套 (超跌区)' : chips.profitRatio >= 80 ? '获利盘主导 (防兑现抛压)' : '多空换手均衡区'}
                        </div>
                      </div>
                    </div>

                    {chips.concentration90 != null && (
                      <div className="diag-chips-pair" style={{ marginTop: '8px' }}>
                        <div>
                          <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>90%筹码成本与集中度:</div>
                          <div style={{ fontWeight: 700, fontSize: '13.5px', fontFamily: 'monospace' }}>
                            ¥{f2(chips.cost90Low)} ~ ¥{f2(chips.cost90High)}
                          </div>
                          <div style={{ fontSize: '11px', color: chips.concentration90 <= 10 ? 'var(--down)' : chips.concentration90 >= 20 ? 'var(--warn)' : 'var(--sub)' }}>
                            集中度 {fmtPct(chips.concentration90)} · {chips.concentrationLabel || '适度集中'}
                          </div>
                        </div>
                        <div>
                          <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>70%核心筹码密集带:</div>
                          <div style={{ fontWeight: 700, fontSize: '13.5px', fontFamily: 'monospace' }}>
                            ¥{f2(chips.cost70Low)} ~ ¥{f2(chips.cost70High)}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                            70%集中度 {fmtPct(chips.concentration70)}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 🧬 实验性弱参考 */}
                    {(report.atrProfile || report.experimentalDNA) && (
                      <details style={{ marginTop: '10px', padding: '7px 10px', background: 'var(--surface)', border: '1px dashed var(--line2)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--sub)' }}>
                        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px', userSelect: 'none' }}>
                          <span>
                            <b style={{ color: 'var(--accent-d)' }}>🧬 [实验·弱参考] 波动与基因:</b>
                            {report.atrProfile && (
                              <> ATR(14) <b>¥{f2(report.atrProfile.atr14)}</b> ({report.atrProfile.atrPct}%) · 建议格距 <b>{report.atrProfile.adaptiveGrid}%</b></>
                            )}
                            {report.atrProfile && report.experimentalDNA && ' ｜ '}
                            {report.experimentalDNA && (
                              <>{report.experimentalDNA.dnaTag} · 低吸胜率 <b>{report.experimentalDNA.dipWinRate}%</b></>
                            )}
                          </span>
                          <span style={{ color: 'var(--accent-d)', fontSize: '11px', fontWeight: 600 }}>▾ 展开</span>
                        </summary>
                        <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed var(--line)', lineHeight: 1.55 }}>
                          {report.atrProfile && (
                            <div style={{ marginBottom: report.experimentalDNA ? '4px' : 0 }}>
                              <b>📏 ATR 波动剖面 ({report.atrProfile.sampleDays}日):</b> {report.atrProfile.volType} ·
                              14日ATR <b>¥{f2(report.atrProfile.atr14)}</b> ({report.atrProfile.atrPct}%) ·
                              14日日均振幅 <b>{report.atrProfile.avgIntraAmp14}%</b> ·
                              自适应做T格距 <b>{report.atrProfile.adaptiveGrid}%</b>
                            </div>
                          )}
                          {report.experimentalDNA && (
                            <>
                              <div>
                                <b>🧬 历史基因 ({report.experimentalDNA.sampleDays}日):</b> 振幅≥3% 占比 <b>{report.experimentalDNA.tFriendly3Pct}%</b> ｜
                                深跌反抽≥1.2% 胜率 <b>{report.experimentalDNA.dipWinRate}%</b> ({report.experimentalDNA.dipWin}/{report.experimentalDNA.dipTotal}次，均抽 +{report.experimentalDNA.dipAvgRebound}%) ｜
                                高开砸盘率 <b>{report.experimentalDNA.gapUpSmashRate}%</b>
                              </div>
                              <div style={{ color: 'var(--sub)', marginTop: '3px' }}>
                                💡 {report.experimentalDNA.dnaDesc} <span style={{ color: '#94a3b8' }}>（仅弱参考/校准辅助，不推翻一票否决结论）</span>
                              </div>
                            </>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>日K筹码数据暂不可用</div>
                )}
              </section>

              {/* 5. 做T自救与二波解套处方 */}
              <section style={{ padding: '15px 16px', margin: 0 }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>💡</span> 做T自救与二波解套处方
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(report.prescriptions || []).map((p, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        background: 'var(--surface)',
                        border: '1px solid var(--line)',
                        fontSize: '12.5px',
                        lineHeight: 1.6
                      }}
                    >
                      {p}
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* 右列：实时公告雷达（排雷与催化） */}
            <section id="diagSecAnn" className="diag-sec-anchor" style={{ padding: '15px 16px', margin: 0, height: 'fit-content', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📰</span> 近30天公告雷达
                  <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>
                    ({report.announcements?.length || 0}条)
                  </span>
                </h3>

                {/* 筛选按钮（大拇指易点尺寸） */}
                <div className="diag-ann-filters">
                  <button
                    type="button"
                    onClick={() => setAnnFilter('all')}
                    className={annFilter === 'all' ? 'active-all' : ''}
                  >
                    全部
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnnFilter('red')}
                    className={annFilter === 'red' ? 'active-red' : ''}
                  >
                    利空 ({report.redFlags?.length || 0})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnnFilter('green')}
                    className={annFilter === 'green' ? 'active-green' : ''}
                  >
                    催化 ({report.greenCatalysts?.length || 0})
                  </button>
                </div>
              </div>

              {/* 公告信息流 */}
              <div className="diag-ann-list">
                {filteredAnnouncements.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 0', fontSize: '12px', color: 'var(--mute)' }}>
                    此分类下暂无公告
                  </div>
                ) : (
                  filteredAnnouncements.map((ann, idx) => {
                    const isRed = ann.level === 'red';
                    const isYellow = ann.level === 'yellow';
                    const isGreen = ann.level === 'green';

                    return (
                      <div
                        key={idx}
                        style={{
                          padding: '9px 12px',
                          borderRadius: '6px',
                          background: isRed ? 'var(--up-bg)' : isYellow ? 'var(--warn-bg)' : isGreen ? 'var(--down-bg)' : 'var(--surface)',
                          border: `1px solid ${isRed ? 'var(--up-b)' : isYellow ? 'var(--warn-b)' : isGreen ? 'var(--down-b)' : 'var(--line)'}`,
                          fontSize: '12.5px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '3px',
                            background: isRed ? 'var(--up)' : isYellow ? 'var(--warn)' : isGreen ? 'var(--down)' : 'var(--surface2)',
                            color: (isRed || isYellow || isGreen) ? '#fff' : 'var(--mute)'
                          }}>
                            {ann.tag}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--mute)', fontFamily: 'monospace' }}>
                            {ann.date}
                          </span>
                        </div>
                        <div style={{ color: isRed ? 'var(--up-d)' : 'var(--text)', fontWeight: isRed ? 600 : 400, lineHeight: 1.5 }}>
                          {ann.title}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      ) : (
        <section
          style={{
            textAlign: 'center',
            padding: '38px 20px',
            background: 'var(--surface)',
            border: '1px dashed var(--line2)',
          }}
        >
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>🩺</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text)' }}>
            输入股票代码、名称或拼音首字母开始全景体检
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--sub)', marginTop: '6px', maxWidth: '560px', marginInline: 'auto', lineHeight: 1.6 }}>
            覆盖近 30 天公告排雷、210 日换手衰减 CYQ 筹码峰、全天分时 VWAP 承接、板块身位与二波潜力评估
          </div>
          {pool.length > 0 && (
            <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: 'var(--mute)' }}>点选自选快速体检：</span>
              {[...pool]
                .sort((a, b) => ((+b.shares || 0) > 0 ? 1 : 0) - ((+a.shares || 0) > 0 ? 1 : 0))
                .slice(0, 8)
                .map((s) => {
                  const c6 = String(s.code || '').padStart(6, '0');
                  const hasPos = (+s.shares || 0) > 0;
                  return (
                    <button
                      key={c6}
                      type="button"
                      onClick={() => handlePresetClick(c6, s.name)}
                      className="diag-preset-pill"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        background: hasPos ? 'var(--accent-bg)' : 'var(--card)',
                        borderColor: hasPos ? 'var(--accent-b)' : 'var(--line2)',
                      }}
                    >
                      <span style={{ fontSize: '11px' }}>{hasPos ? '📦' : '👀'}</span>
                      <span style={{ fontWeight: 600 }}>{s.name || c6}</span>
                      <span style={{ fontSize: '11px', color: 'var(--mute)', fontFamily: 'ui-monospace, Consolas, monospace' }}>{c6}</span>
                    </button>
                  );
                })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
