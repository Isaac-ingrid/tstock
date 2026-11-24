import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { fetchQuotes } from '../../services/api.js';
import { f2 } from '../../services/utils.js';
import Icon from '../Icons.jsx';

const BENCH_INDICES = [
  { tc: 'sh000001', name: '上证指数', symbol: '000001.SH' },
  { tc: 'sz399001', name: '深证成指', symbol: '399001.SZ' },
  { tc: 'sz399006', name: '创业板指', symbol: '399006.SZ' },
  { tc: 'sh000688', name: '科创50', symbol: '000688.SH' },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fmtTurnoverYi(yiVal) {
  if (!Number.isFinite(yiVal) || yiVal <= 0) return '—';
  if (yiVal >= 10000) return `${(yiVal / 10000).toFixed(2)}万亿`;
  return `${Math.round(yiVal)}亿`;
}

/**
 * 六维情绪雷达纯 SVG 组件（零外部依赖，自适应明暗主题）
 */
function EmotionHexRadar({ axes, score, toneColor }) {
  const size = 204;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 68;
  const rings = [0.33, 0.66, 1];

  const pointAt = (idx, ratio) => {
    const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / 6;
    return [cx + Math.cos(angle) * maxR * ratio, cy + Math.sin(angle) * maxR * ratio];
  };

  const ringPolygons = rings.map((r) =>
    axes
      .map((_, i) => pointAt(i, r).map((n) => n.toFixed(1)).join(','))
      .join(' ')
  );

  const dataPts = axes.map((ax, i) => pointAt(i, clamp((ax.val || 0) / 100, 0.08, 1)));
  const dataPolygon = dataPts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="bb-radar-svg"
      role="img"
      aria-label={`市场六维情绪雷达，综合评分 ${Math.round(score || 0)}`}
    >
      {/* 同心六边形网格 */}
      {ringPolygons.map((pts, idx) => (
        <polygon
          key={idx}
          points={pts}
          fill={idx === rings.length - 1 ? 'var(--surface)' : 'none'}
          fillOpacity={idx === rings.length - 1 ? '0.45' : '0'}
          stroke="var(--line2)"
          strokeWidth="0.9"
          strokeOpacity={idx === rings.length - 1 ? '0.75' : '0.42'}
        />
      ))}

      {/* 六条轴射线 */}
      {axes.map((_, i) => {
        const [x2, y2] = pointAt(i, 1);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x2.toFixed(1)}
            y2={y2.toFixed(1)}
            stroke="var(--line)"
            strokeWidth="0.8"
          />
        );
      })}

      {/* 情绪多边形覆盖面 */}
      <polygon
        points={dataPolygon}
        fill={toneColor}
        fillOpacity="0.20"
        stroke={toneColor}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* 顶点圆点 */}
      {dataPts.map(([px, py], i) => (
        <circle key={i} cx={px.toFixed(1)} cy={py.toFixed(1)} r="2.7" fill={toneColor} />
      ))}

      {/* 六维轴标签 */}
      {axes.map((ax, i) => {
        const [lx, ly] = pointAt(i, 1.24);
        return (
          <text
            key={ax.label}
            x={lx.toFixed(1)}
            y={(ly + 3.5).toFixed(1)}
            textAnchor="middle"
            fill="var(--sub)"
            fontSize="10.5"
            fontWeight="500"
          >
            {ax.label}
          </text>
        );
      })}

      {/* 中心综合情绪分读数 */}
      <text
        x={cx}
        y={cy + 7}
        textAnchor="middle"
        fill="var(--text)"
        fontSize="22"
        fontWeight="800"
        className="num-mono"
      >
        {score != null ? Math.round(score) : '--'}
      </text>
    </svg>
  );
}

/**
 * 首次加载等比例 Bento 结构骨架屏（杜绝 CLS 布局跳动）
 */
export function BoardBentoSkeleton() {
  return (
    <div className="bb-wrap" aria-busy="true" aria-label="正在加载市场看板数据">
      <div className="bb-idx-row">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="bb-card bb-skeleton-card" style={{ minHeight: '68px' }} />
        ))}
      </div>
      <div className="bb-kpi-row">
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <div key={k} className="bb-card bb-skeleton-card" style={{ minHeight: '72px' }} />
        ))}
      </div>
      <div className="bb-viz-row">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="bb-card bb-skeleton-card" style={{ minHeight: '258px' }} />
        ))}
      </div>
    </div>
  );
}

export default function BoardBentoOverview({
  data,
  loading,
  isHistoryReplay,
  boardDate,
  localTodayIso,
  onChangeDate,
  autoRefresh,
  onToggleAutoRefresh,
  onlyMainboard,
  onToggleMainboard,
  onReload,
  onCopyBrief,
  allItems = [],
  rushingPool = [],
  zbPool = [],
  strongPool = [],
  strongEliteCount = 0,
  herdPool = [],
  evictedPool = [],
  ladder = { high: [], board3: [], board2: [], board1: [] },
  buyWindows = { auctionBuy: [], rushBuy: [], reSealBuy: [], lateBuy: [], locked: [] },
  hotThemes = [],
  mainThemes = { marketOverview: {}, themes: [] },
  mysticClusters = [],
  poolAlerts = [],
  filterTier = 'all',
  onSelectTier,
  selectedTheme = 'all',
  onSelectTheme,
  inPoolCodes = new Set(),
  onAddSingle,
  onSelectStock,
}) {
  const [idxQuotes, setIdxQuotes] = useState({});

  const loadIndices = useCallback(async () => {
    try {
      const q = await fetchQuotes(BENCH_INDICES.map((x) => x.tc));
      if (q && Object.keys(q).length > 0) setIdxQuotes(q);
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadIndices();
    if (!autoRefresh || isHistoryReplay) return undefined;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadIndices();
    }, 20000);
    return () => clearInterval(t);
  }, [loadIndices, autoRefresh, isHistoryReplay, data?.updatedAt]);

  const s = data?.sentiment || {};
  const tempScore = Number.isFinite(+s.temperature) ? +s.temperature : 50;
  const cyclePhase = s.cyclePhase || (tempScore <= 28 ? '冰点' : tempScore >= 72 ? '高潮' : '震荡');
  const ztCount = Number(s.limitUpCount ?? allItems.length ?? 0);
  const dtCount = Number(s.limitDownCount ?? data?.dtCount ?? 0);
  const zbCount = Number(s.brokenBoardCount ?? data?.zbCount ?? zbPool.length ?? 0);
  const brokenRate = Number(s.brokenRate ?? 0);
  const sealRate = clamp(100 - brokenRate, 0, 100);
  const upCount = Number(s.upCount ?? 0);
  const downCount = Number(s.downCount ?? 0);
  const flatCount = Number(s.flatCount ?? 0);
  const totalBreadth = upCount + downCount + flatCount;
  const upRatio =
    s.upRatio != null
      ? Number(s.upRatio)
      : totalBreadth > 0
      ? (upCount / totalBreadth) * 100
      : null;

  // 两市总成交额（sh000001.amt + sz399001.amt 单位为万元 -> 亿元）
  const shAmtWan = Number(idxQuotes.sh000001?.amt || 0);
  const szAmtWan = Number(idxQuotes.sz399001?.amt || 0);
  const totalTurnoverYi = (shAmtWan + szAmtWan) / 10000;
  const poolTurnoverYi = useMemo(
    () => allItems.reduce((acc, it) => acc + Number(it.amount || 0), 0) / 1e8,
    [allItems]
  );

  // 情绪主色调（冰点/退潮绿，混沌/分歧琥珀，回暖/主升红）
  const radarColor =
    tempScore < 35 ? '#12b76a' : tempScore < 62 ? '#f59e0b' : '#f04438';
  const phasePillCls =
    tempScore < 35 ? 'tone-cold' : tempScore < 62 ? 'tone-warn' : 'tone-hot';

  // 六维情绪雷达确定性映射（严格基于真实盘口指标推导）
  const radarAxes = useMemo(() => {
    const idxChgs = BENCH_INDICES.map(({ tc }) => {
      const q = idxQuotes[tc];
      return q?.price > 0 && q?.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
    }).filter((v) => v != null);
    const avgIdxChg = idxChgs.length ? idxChgs.reduce((a, b) => a + b, 0) / idxChgs.length : 0;

    const Prem = Number(s.yesterdayPremiumMean ?? 0);
    const maxLb = Number(s.maxLadder ?? data?.maxLadder ?? 1);
    const promo = Number(s.consecPromotionRate ?? s.promotionRate ?? 20);
    const topThemeCnt = Number(hotThemes[0]?.count || 0);
    const turnoverBase = totalTurnoverYi > 0 ? (totalTurnoverYi / 18000) * 100 : clamp(poolTurnoverYi * 1.2, 15, 85);

    return [
      { label: '指数', val: clamp(50 + avgIdxChg * 16, 6, 96) },
      { label: '赚钱', val: clamp((upRatio ?? 42) * 0.72 + (Prem + 2.5) * 5.5, 6, 96) },
      { label: '量能', val: clamp(turnoverBase, 10, 96) },
      { label: '投机', val: clamp(maxLb * 11 + promo * 0.55, 6, 96) },
      { label: '抗跌', val: clamp(96 - dtCount * 1.8 - brokenRate * 0.65, 6, 96) },
      { label: '主线', val: clamp(topThemeCnt * 5.5 + strongEliteCount * 2.2, 8, 96) },
    ];
  }, [idxQuotes, s, data?.maxLadder, upRatio, hotThemes, totalTurnoverYi, poolTurnoverYi, dtCount, brokenRate, strongEliteCount]);

  // 广度 6 档真实分类柱（严格使用后端已核实的跌停/下跌/平盘/上涨/强势/涨停计数）
  const breadthBars = useMemo(() => {
    const pureDown = Math.max(0, downCount - dtCount);
    const pureUp = Math.max(0, upCount - ztCount);
    const list = [
      { key: 'dt', label: '跌停', count: dtCount, tone: 'down' },
      { key: 'dn', label: '下跌', count: pureDown, tone: 'down' },
      { key: 'fl', label: '平盘', count: flatCount, tone: 'flat' },
      { key: 'up', label: '上涨', count: pureUp, tone: 'up' },
      { key: 'st', label: '强势池', count: strongPool.length, tone: 'up' },
      { key: 'zt', label: '涨停', count: ztCount, tone: 'up' },
    ];
    const maxCnt = Math.max(1, ...list.map((x) => x.count));
    return list.map((x) => ({ ...x, pctH: Math.max(5, Math.round((x.count / maxCnt) * 100)) }));
  }, [downCount, dtCount, flatCount, upCount, strongPool.length, ztCount]);

  // 最高连板代表龙头名
  const topLeadersText = useMemo(() => {
    const hi = ladder.high?.length ? ladder.high : ladder.board3?.length ? ladder.board3 : ladder.board2;
    if (!hi || hi.length === 0) return '暂无连板标杆';
    return hi
      .slice(0, 2)
      .map((x) => x.name)
      .join(' · ');
  }, [ladder]);

  // 涨停梯队横向比例条
  const ladderRows = useMemo(() => {
    const rows = [
      { key: 'high', label: `${Math.max(4, Number(data?.maxLadder || 4))}板+`, items: ladder.high || [] },
      { key: 'board3', label: '3板', items: ladder.board3 || [] },
      { key: 'board2', label: '2板', items: ladder.board2 || [] },
      { key: 'board1', label: '首板', items: ladder.board1 || [] },
    ];
    const maxLen = Math.max(1, ...rows.map((r) => r.items.length));
    return rows.map((r) => ({
      ...r,
      count: r.items.length,
      widthPct: r.items.length > 0 ? Math.max(8, Math.round((r.items.length / maxLen) * 100)) : 0,
      names: r.items
        .slice(0, 3)
        .map((x) => x.name)
        .join('  '),
    }));
  }, [ladder, data?.maxLadder]);

  // 右下实时监控信号流（合并自选池异动 + 盘中冲板临界 + 炸板预警）
  const liveSignals = useMemo(() => {
    const list = [];
    poolAlerts.forEach((al) => {
      list.push({
        id: `pool_${al.code}`,
        code: al.code,
        name: al.name,
        badge: '持仓/自选联动',
        tone: al.kind === 'zt' ? 'up' : al.kind === 'zb' ? 'danger' : 'warn',
        desc: al.label,
        meta: '自选股池实时跟踪',
        chg: null,
        price: null,
        targetTier: al.targetTab,
      });
    });
    rushingPool.slice(0, 4).forEach((it) => {
      list.push({
        id: `rush_${it.code}`,
        code: it.code,
        name: it.name,
        badge: '冲板临界',
        tone: 'up',
        desc: `${it.hybk || '活跃题材'} · 距涨停极近，盘口资金抢筹冲击封板`,
        meta: it.fbt || '盘中实时',
        chg: it.chg,
        price: it.price,
        targetTier: 'rushing',
      });
    });
    zbPool.slice(0, 4).forEach((it) => {
      list.push({
        id: `zb_${it.code}`,
        code: it.code,
        name: it.name,
        badge: '炸板分歧',
        tone: 'warn',
        desc: `${it.hybk || '板块分歧'} · 曾触及涨停后开板回落 ${Number(it.dropFromTop || 0).toFixed(1)}%`,
        meta: `炸板 ${it.zbc || 1} 次`,
        chg: it.chg,
        price: it.price,
        targetTier: 'zb',
      });
    });
    if (list.length < 5) {
      allItems.slice(0, 6 - list.length).forEach((it) => {
        list.push({
          id: `zt_${it.code}`,
          code: it.code,
          name: it.name,
          badge: it.statTag || `${it.lbc || 1}连板`,
          tone: 'info',
          desc: `${it.hybk || '主线'} · 首封 ${it.fbt || '--'} · 量化评级 ${it.score || '--'}分`,
          meta: it.buyWindowLabel || '封板锁定',
          chg: it.chg ?? 10,
          price: it.price,
          targetTier: 'all',
        });
      });
    }
    return list.slice(0, 6);
  }, [poolAlerts, rushingPool, zbPool, allItems]);

  const conceptRank = useMemo(() => {
    const list = (mainThemes?.themes || []).slice(0, 5);
    return list;
  }, [mainThemes]);

  const industryRank = useMemo(() => hotThemes.slice(0, 5), [hotThemes]);

  return (
    <section className="bb-wrap" aria-label="全市场情绪与连板 Bento 看板">
      {/* 顶部单行控制台 */}
      <div className="bb-toolbar">
        <div className="bb-tb-left">
          <span className="bb-tb-icon">
            <Icon name="board" size={16} active />
          </span>
          <h2 className="bb-tb-title">市场看板</h2>
          <span className={`bb-phase-pill num-mono ${phasePillCls}`}>
            {cyclePhase} · {Math.round(tempScore)}
          </span>
          {isHistoryReplay && (
            <span className="bb-replay-pill num-mono">历史复盘 · {data?.date}</span>
          )}
        </div>

        <div className="bb-tb-right">
          <label className="bb-chk-pill" title="剔除科创板(68)与北交所，聚焦主板连板生态">
            <input
              type="checkbox"
              checked={onlyMainboard}
              onChange={(e) => onToggleMainboard(e.target.checked)}
            />
            <span>仅主板</span>
          </label>

          <div className="bb-date-box">
            <input
              type="date"
              max={localTodayIso}
              value={boardDate || localTodayIso}
              aria-label="选择看板交易日期"
              onChange={(e) => onChangeDate(e.target.value === localTodayIso ? '' : e.target.value)}
            />
            {boardDate && (
              <button type="button" className="bb-mini-btn is-warn" onClick={() => onChangeDate('')}>
                回实时
              </button>
            )}
          </div>

          <button
            type="button"
            className={`bb-mini-btn ${autoRefresh && !isHistoryReplay ? 'is-live' : ''}`}
            disabled={isHistoryReplay}
            onClick={() => onToggleAutoRefresh(!autoRefresh)}
            title="切换 30 秒自动轮询"
          >
            <span className="bb-live-dot" aria-hidden="true" />
            <span>{isHistoryReplay ? '只读' : autoRefresh ? '实时' : '暂停'}</span>
          </button>

          <button type="button" className="bb-mini-btn" onClick={onCopyBrief} title="复制今日复盘简报">
            <Icon name="copy" size={13} />
            <span>复盘简报</span>
          </button>

          <button type="button" className="bb-mini-btn" onClick={onReload} disabled={loading}>
            <Icon name="refresh" size={13} />
            <span>{loading ? '同步中' : '重载'}</span>
          </button>
        </div>
      </div>

      {/* 第 1 排：第一步「顺天时」核心指数结构 + 布林支撑压力 + 顶底背离卡片 */}
      {s.macroTiming && (
        <div
          className="bb-card"
          style={{
            padding: '8px 12px',
            marginBottom: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
            fontSize: '12px',
            borderLeft: `3px solid ${
              s.macroTiming.posture === 'FULL_ATTACK'
                ? 'var(--up)'
                : s.macroTiming.posture === 'HOLD_FIRE'
                ? 'var(--down)'
                : 'var(--warn)'
            }`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <b style={{ color: 'var(--text)' }}>🧭 第一步·择天时：{s.macroTiming.postureLabel}</b>
            <span className="num-mono" style={{ padding: '1px 7px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--line2)', fontWeight: 700 }}>
              建议总仓 {s.macroTiming.rangeText}
            </span>
            <span style={{ color: 'var(--sub)' }}>{s.macroTiming.reason}</span>
          </div>
          {s.macroTiming.bollMid > 0 && (
            <div className="num-mono" style={{ fontSize: '11.5px', color: 'var(--mute)' }}>
              上证 {s.macroTiming.structureLabel} ｜ BOLL 下轨支撑 <b style={{ color: 'var(--down-d)' }}>{s.macroTiming.bollLower}</b> · 中轨 <b>{s.macroTiming.bollMid}</b> · 上轨压力 <b style={{ color: 'var(--up)' }}>{s.macroTiming.bollUpper}</b>
            </div>
          )}
        </div>
      )}
      <div className="bb-idx-row">
        {BENCH_INDICES.map(({ tc, name, symbol }) => {
          const q = idxQuotes[tc];
          const mtIdx = (s.macroTiming?.indices || []).find((x) => x.tcode === tc);
          const px = q?.price > 0 ? q.price : mtIdx?.price > 0 ? mtIdx.price : null;
          const chg = px && q?.prevClose > 0 ? ((px - q.prevClose) / q.prevClose) * 100 : mtIdx?.chg ?? null;
          const dir = chg == null ? '' : chg > 0.001 ? 'is-up' : chg < -0.001 ? 'is-down' : '';
          const arrow = chg == null ? '' : chg >= 0 ? '↗ ' : '↘ ';
          return (
            <div
              key={tc}
              className="bb-card bb-idx-card"
              title={mtIdx ? `${name}：${mtIdx.structureLabel} ｜ BOLL 下轨 ${mtIdx.bollLower} / 中轨 ${mtIdx.bollMid} / 上轨 ${mtIdx.bollUpper}${mtIdx.topDivDesc ? ` ｜ ${mtIdx.topDivDesc}` : ''}${mtIdx.bottomDivDesc ? ` ｜ ${mtIdx.bottomDivDesc}` : ''}` : name}
            >
              <div className="bb-idx-top">
                <span className="bb-idx-name">
                  {name}
                  {mtIdx?.structureLabel && (
                    <small style={{ marginLeft: '5px', fontSize: '10px', color: mtIdx.structure === 'UPTREND' ? 'var(--up)' : mtIdx.structure === 'DOWNTREND' ? 'var(--down)' : 'var(--mute)', fontWeight: 700 }}>
                      {mtIdx.structureLabel.replace('结构', '')}
                    </small>
                  )}
                  {mtIdx?.topDivergence && (
                    <small style={{ marginLeft: '4px', fontSize: '10px', color: 'var(--up)', fontWeight: 800 }}>⚠️顶背离</small>
                  )}
                  {mtIdx?.bottomDivergence && (
                    <small style={{ marginLeft: '4px', fontSize: '10px', color: 'var(--down-d)', fontWeight: 800 }}>🎯底背离</small>
                  )}
                </span>
                <b className={`bb-idx-chg num-mono ${dir}`}>
                  {chg == null ? '--' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}
                </b>
              </div>
              <div className="bb-idx-bot num-mono">
                <span className="bb-idx-code">
                  {mtIdx?.bollMid > 0 ? `支撑${Math.round(mtIdx.bollLower)} / 压${Math.round(mtIdx.bollUpper)}` : symbol}
                </span>
                <span className={`bb-idx-px ${dir}`}>
                  {arrow}
                  {px ? px.toFixed(2) : '----.--'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 第 2 排：6 格全市场广度与核心脉冲指标卡 */}
      <div className="bb-kpi-row">
        <div className="bb-card bb-kpi-card">
          <div className="bb-kpi-hd">
            <span>个股涨 / 平 / 跌</span>
          </div>
          <div className="bb-kpi-val num-mono">
            {totalBreadth > 0 ? (
              <>
                <span className="c-up">{upCount}</span>
                <span className="c-mute">/</span>
                <span className="c-sub">{flatCount}</span>
                <span className="c-mute">/</span>
                <span className="c-down">{downCount}</span>
              </>
            ) : (
              <span className="c-sub">盘口汇总中</span>
            )}
          </div>
          <div className="bb-kpi-sub num-mono">
            上涨率 {upRatio != null ? `${upRatio.toFixed(1)}%` : '--'}
          </div>
        </div>

        <div
          className={`bb-card bb-kpi-card is-clickable ${filterTier === 'strong' ? 'is-selected' : ''}`}
          onClick={() => onSelectTier('strong')}
          title="点击切换下方列表至多维强共振股池"
        >
          <div className="bb-kpi-hd">
            <span>强势池 / 抱团池</span>
          </div>
          <div className="bb-kpi-val num-mono">
            <span className="c-up">{strongPool.length}</span>
            <span className="c-mute"> / </span>
            <span className="c-info">{herdPool.length}</span>
          </div>
          <div className="bb-kpi-sub num-mono">
            3标共振 {strongEliteCount} · 淘汰 {evictedPool.length}
          </div>
        </div>

        <div
          className={`bb-card bb-kpi-card is-clickable ${filterTier === 'all' ? 'is-selected' : ''}`}
          onClick={() => onSelectTier('all')}
          title="点击查看全部涨停天梯池"
        >
          <div className="bb-kpi-hd">
            <span>涨停 / 跌停</span>
            {s.valveLabel && <em className={`bb-valve-tag ${phasePillCls}`}>{s.valveLabel}</em>}
          </div>
          <div className="bb-kpi-val num-mono">
            <span className="c-up">{ztCount}</span>
            <span className="c-mute"> / </span>
            <span className="c-down">{dtCount}</span>
          </div>
          <div className="bb-kpi-sub num-mono">
            封板率 {sealRate.toFixed(0)}% · 炸板 {zbCount}
          </div>
        </div>

        <div
          className={`bb-card bb-kpi-card is-clickable ${filterTier === 'high' ? 'is-selected' : ''}`}
          onClick={() => onSelectTier('high')}
          title="点击筛选高标连板龙头（>=4板）"
        >
          <div className="bb-kpi-hd">
            <span>最高连板</span>
          </div>
          <div className="bb-kpi-val num-mono c-info">{data?.maxLadder || 0}板</div>
          <div className="bb-kpi-sub bb-truncate" title={topLeadersText}>
            {topLeadersText}
          </div>
        </div>

        <div className="bb-card bb-kpi-card">
          <div className="bb-kpi-hd">
            <span>两市成交额</span>
          </div>
          <div className="bb-kpi-val num-mono">
            {totalTurnoverYi > 0 ? fmtTurnoverYi(totalTurnoverYi) : fmtTurnoverYi(poolTurnoverYi)}
          </div>
          <div className="bb-kpi-sub num-mono">
            涨停池成交 {fmtTurnoverYi(poolTurnoverYi)}
          </div>
        </div>

        <div className="bb-card bb-kpi-card">
          <div className="bb-kpi-hd">
            <span>晋级率 / 连板接力</span>
          </div>
          <div className="bb-kpi-val num-mono c-info">
            {s.promotionRate != null ? `${Number(s.promotionRate).toFixed(0)}%` : '--'}
            <span className="c-mute"> / </span>
            {s.consecPromotionRate != null ? `${Number(s.consecPromotionRate).toFixed(0)}%` : '--'}
          </div>
          <div className="bb-kpi-sub num-mono">
            样本 {s.promotionSample || '0/0'} · 连板 {s.consecPromotionSample || '0/0'}
          </div>
        </div>
      </div>

      {/* 第 3 排：4 列等高可视化 Bento 核心卡（广度柱状图 / 六维情绪雷达 / 盘中监控矩阵 / 涨停梯队进度条） */}
      <div className="bb-viz-row">
        {/* 3.1 涨跌分布 / 广度 */}
        <div className="bb-card bb-viz-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">涨跌分布 / 广度</span>
            <span className="bb-viz-meta num-mono">
              {totalBreadth > 0 ? `${totalBreadth}只` : `${ztCount}涨停`}
            </span>
          </div>

          <div className="bb-hist-bars">
            {breadthBars.map((b) => (
              <div key={b.key} className="bb-hist-col">
                <span className="bb-hist-cnt num-mono">{b.count}</span>
                <div className="bb-hist-track">
                  <div
                    className={`bb-hist-fill is-${b.tone}`}
                    style={{ height: `${b.pctH}%` }}
                  />
                </div>
                <span className="bb-hist-lbl">{b.label}</span>
              </div>
            ))}
          </div>

          {/* 红平绿横向比例条 */}
          <div className="bb-ratio-bar">
            <span
              className="bb-rb-down"
              style={{
                flex: Math.max(1, totalBreadth > 0 ? downCount : dtCount + 1),
              }}
            />
            <span
              className="bb-rb-flat"
              style={{
                flex: Math.max(0.2, totalBreadth > 0 ? flatCount : 1),
              }}
            />
            <span
              className="bb-rb-up"
              style={{
                flex: Math.max(1, totalBreadth > 0 ? upCount : ztCount + 1),
              }}
            />
          </div>
          <div className="bb-ratio-legend num-mono">
            <span className="c-down">跌 {totalBreadth > 0 ? downCount : dtCount}</span>
            <span className="c-mute">平 {flatCount}</span>
            <span className="c-up">涨 {totalBreadth > 0 ? upCount : ztCount}</span>
          </div>

          <div className="bb-sub-pair">
            <div className="bb-sub-box">
              <span>昨涨停均溢价</span>
              <b
                className={`num-mono ${
                  (s.yesterdayPremiumMean ?? 0) >= 0 ? 'c-up' : 'c-down'
                }`}
              >
                {s.yesterdayPremiumMean != null
                  ? `${s.yesterdayPremiumMean > 0 ? '+' : ''}${Number(s.yesterdayPremiumMean).toFixed(2)}%`
                  : '--'}
              </b>
            </div>
            <div className="bb-sub-box">
              <span>昨涨停中位溢价</span>
              <b
                className={`num-mono ${
                  (s.yesterdayPremiumMedian ?? 0) >= 0 ? 'c-up' : 'c-down'
                }`}
              >
                {s.yesterdayPremiumMedian != null
                  ? `${s.yesterdayPremiumMedian > 0 ? '+' : ''}${Number(s.yesterdayPremiumMedian).toFixed(2)}%`
                  : '--'}
              </b>
            </div>
          </div>
        </div>

        {/* 3.2 六维情绪雷达 */}
        <div className="bb-card bb-viz-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">情绪雷达</span>
            <span className="bb-viz-meta num-mono">情绪评分 {Math.round(tempScore)}</span>
          </div>
          <div className="bb-radar-body">
            <EmotionHexRadar axes={radarAxes} score={tempScore} toneColor={radarColor} />
          </div>
          <div className="bb-radar-foot" title={s.doAction || s.valveAction || ''}>
            <span className="bb-truncate">{s.valveAction || s.doAction || '遵守仓位纪律，聚焦主线前排'}</span>
          </div>
        </div>

        {/* 3.3 打板窗口与实用监控矩阵 */}
        <div className="bb-card bb-viz-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">打板窗口</span>
            <span className="bb-viz-meta">买点分布</span>
          </div>
          <div className="bb-matrix-grid cols-3">
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'auction' ? 'active' : ''}`}
              onClick={() => onSelectTier('auction')}
            >
              <span>09:25 竞价</span>
              <b className="num-mono c-info">{buyWindows.auctionBuy.length}</b>
            </button>
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'rush' ? 'active' : ''}`}
              onClick={() => onSelectTier('rush')}
            >
              <span>09:30 秒板</span>
              <b className="num-mono c-up">{buyWindows.rushBuy.length}</b>
            </button>
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'rushing' ? 'active' : ''}`}
              onClick={() => !isHistoryReplay && onSelectTier('rushing')}
            >
              <span>盘中冲板</span>
              <b className="num-mono c-warn">{rushingPool.length}</b>
            </button>
          </div>

          <div className="bb-viz-hd" style={{ marginTop: '10px' }}>
            <span className="bb-viz-title">实用监控</span>
            <span className="bb-viz-meta">盘中观察</span>
          </div>
          <div className="bb-matrix-grid cols-3">
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'zb' ? 'active' : ''}`}
              onClick={() => onSelectTier('zb')}
            >
              <span>炸板分歧</span>
              <b className="num-mono c-warn">{zbCount}</b>
            </button>
            <div className="bb-mat-cell is-static">
              <span>跌停家数</span>
              <b className="num-mono c-down">{dtCount}</b>
            </div>
            <div className="bb-mat-cell is-static">
              <span>封板率</span>
              <b className="num-mono c-info">{sealRate.toFixed(0)}%</b>
            </div>
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'reseal' ? 'active' : ''}`}
              onClick={() => onSelectTier('reseal')}
            >
              <span>炸板回封</span>
              <b className="num-mono c-up">{buyWindows.reSealBuy.length}</b>
            </button>
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'late' ? 'active' : ''}`}
              onClick={() => onSelectTier('late')}
            >
              <span>尾盘封板</span>
              <b className="num-mono c-warn">{buyWindows.lateBuy.length}</b>
            </button>
            <button
              type="button"
              className={`bb-mat-cell ${filterTier === 'locked' ? 'active' : ''}`}
              onClick={() => onSelectTier('locked')}
            >
              <span>一字锁死</span>
              <b className="num-mono c-sub">{buyWindows.locked.length}</b>
            </button>
          </div>
        </div>

        {/* 3.4 涨停梯队横向进度条 */}
        <div className="bb-card bb-viz-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">涨停梯队</span>
            <span className="bb-viz-meta num-mono">
              涨停 {ztCount} · {cyclePhase}
            </span>
          </div>

          <div className="bb-seal-meter">
            <div className="bb-sm-row">
              <span>封板率</span>
              <b className="num-mono c-info">{sealRate.toFixed(0)}%</b>
            </div>
            <div className="bb-sm-track">
              <div className="bb-sm-fill" style={{ width: `${sealRate}%` }} />
            </div>
          </div>

          <div className="bb-ladder-bars">
            {ladderRows.map((row) => (
              <button
                key={row.key}
                type="button"
                className={`bb-lad-row ${filterTier === row.key ? 'active' : ''}`}
                onClick={() => onSelectTier(row.key)}
                title={`点击筛选 ${row.label} 明细标的`}
              >
                <div className="bb-lad-main">
                  <span className="bb-lad-lbl num-mono">{row.label}</span>
                  <div className="bb-lad-track">
                    <div className="bb-lad-fill" style={{ width: `${row.widthPct}%` }} />
                  </div>
                  <b className="bb-lad-cnt num-mono">{row.count}</b>
                </div>
                {row.names && <div className="bb-lad-names bb-truncate">{row.names}</div>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 第 4 排：主线概念热度 / 行业涨停热度 / 监控中心实时信号流 */}
      <div className="bb-bottom-row">
        {/* 4.1 概念与主线热度 */}
        <div className="bb-card bb-heat-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">主线概念热度</span>
            <button
              type="button"
              className="bb-link-btn"
              onClick={() => onSelectTier('themes')}
            >
              四大核心研判 →
            </button>
          </div>

          {conceptRank.length === 0 ? (
            <div className="bb-empty-mini">暂无主线概念聚合数据</div>
          ) : (
            <div className="bb-heat-list">
              {conceptRank.map((th, idx) => {
                const active = selectedTheme === th.name;
                const lead = th.heightLeader || th.capacityCore || th.stocks?.[0];
                return (
                  <div
                    key={th.name}
                    className={`bb-heat-item ${active ? 'active' : ''}`}
                    onClick={() => onSelectTheme(active ? 'all' : th.name)}
                    title={`点击按「${th.name}」过滤下方股票池`}
                  >
                    <span className="bb-heat-rk num-mono">{idx + 1}</span>
                    <div className="bb-heat-info">
                      <div className="bb-heat-top">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                          <b className="bb-truncate">{th.name}</b>
                          {th.cycleStageLabel && (
                            <small
                              style={{
                                fontSize: '10px',
                                padding: '0 5px',
                                borderRadius: '3px',
                                flexShrink: 0,
                                background: th.cycleStage === 'HIGH_CLIMAX' ? 'var(--warn-bg)' : th.cycleStage === 'EARLY_START' ? 'var(--down-bg)' : 'var(--up-bg)',
                                color: th.cycleStage === 'HIGH_CLIMAX' ? 'var(--warn-d)' : th.cycleStage === 'EARLY_START' ? 'var(--down-d)' : 'var(--up)',
                                fontWeight: 700,
                              }}
                            >
                              {th.cycleStageLabel.split('·')[0]}
                            </small>
                          )}
                        </span>
                        <span className="c-up num-mono">
                          {th.ztCount ?? th.count ?? 0}涨停
                        </span>
                      </div>
                      <div className="bb-heat-sub bb-truncate">
                        {th.rsVsIndex != null ? `超额RS ${th.rsVsIndex >= 0 ? '+' : ''}${th.rsVsIndex}% · ` : ''}
                        {th.capacityYi > 0 ? `容量${th.capacityYi}亿 · ` : ''}
                        {lead ? `标杆 ${lead.name}` : '点击查看成分股'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {mysticClusters.length > 0 && (
            <div className="bb-mystic-strip">
              <span className="bb-ms-lbl">字辈暗线</span>
              {mysticClusters.slice(0, 4).map((cl) => {
                const tKey = `字辈·${cl.name}`;
                const active = selectedTheme === tKey;
                return (
                  <button
                    key={cl.name}
                    type="button"
                    className={`bb-ms-chip ${active ? 'active' : ''}`}
                    onClick={() => {
                      onSelectTier('strong');
                      onSelectTheme(active ? 'all' : tKey);
                    }}
                  >
                    {cl.name} <b className="num-mono">{cl.ztCount}</b>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 4.2 行业板块涨停热度 */}
        <div className="bb-card bb-heat-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">行业热度</span>
            <span className="bb-viz-meta">点击板块筛选成分股</span>
          </div>

          {industryRank.length === 0 ? (
            <div className="bb-empty-mini">暂无行业涨停分布数据</div>
          ) : (
            <div className="bb-heat-list">
              {industryRank.map((sec, idx) => {
                const active = selectedTheme === sec.name;
                return (
                  <div
                    key={sec.name}
                    className={`bb-heat-item ${active ? 'active' : ''}`}
                    onClick={() => onSelectTheme(active ? 'all' : sec.name)}
                  >
                    <span className="bb-heat-rk num-mono">{idx + 1}</span>
                    <div className="bb-heat-info">
                      <div className="bb-heat-top">
                        <b className="bb-truncate">{sec.name}</b>
                        <span className="c-up num-mono">
                          {sec.count}家 · 最高{sec.maxLbc}板
                        </span>
                      </div>
                      <div className="bb-heat-sub bb-truncate">
                        先锋：{sec.leader || '—'}
                        {sec.leaderCode ? ` (${sec.leaderCode})` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 4.3 监控中心 · 实时信号流 */}
        <div className="bb-card bb-heat-card">
          <div className="bb-viz-hd">
            <span className="bb-viz-title">监控中心 · 实时信号</span>
            <span className="bb-viz-meta num-mono">{data?.updatedAt?.slice(11, 16) || '实时'}</span>
          </div>

          {liveSignals.length === 0 ? (
            <div className="bb-empty-mini">当前暂无盘中异动或炸板信号</div>
          ) : (
            <div className="bb-sig-list">
              {liveSignals.map((sig) => {
                const c6 = String(sig.code || '').padStart(6, '0');
                const inPool = inPoolCodes.has(c6);
                return (
                  <div key={sig.id} className="bb-sig-item">
                    <div className="bb-sig-top">
                      <span
                        className="bb-sig-stock num-mono"
                        onClick={() => onSelectTier(sig.targetTier)}
                      >
                        {c6} <b>{sig.name}</b>
                      </span>
                      <span className="bb-sig-px num-mono">
                        {sig.price > 0 ? f2(sig.price) : ''}
                        {sig.chg != null && (
                          <em className={sig.chg >= 0 ? 'c-up' : 'c-down'}>
                            {' '}
                            {sig.chg > 0 ? '+' : ''}
                            {Number(sig.chg).toFixed(2)}%
                          </em>
                        )}
                      </span>
                    </div>
                    <div className="bb-sig-mid">
                      <span className={`bb-sig-tag is-${sig.tone}`}>{sig.badge}</span>
                      <span className="bb-sig-desc bb-truncate" title={sig.desc}>
                        {sig.desc}
                      </span>
                    </div>
                    <div className="bb-sig-foot">
                      <span className="bb-sig-meta num-mono">{sig.meta}</span>
                      <div className="bb-sig-acts">
                        <a
                          href={`#/diagnosis?code=${c6}`}
                          className="bb-act-link"
                          title="查看210日筹码峰与全景诊断"
                        >
                          诊股
                        </a>
                        <button
                          type="button"
                          className={`bb-act-btn ${inPool ? 'is-in' : ''}`}
                          onClick={() =>
                            inPool && onSelectStock
                              ? onSelectStock(c6)
                              : onAddSingle && onAddSingle(c6, sig.name, sig)
                          }
                        >
                          {inPool ? '已自选' : '+自选'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
