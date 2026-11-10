'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchStrategyPerf, triggerStrategySnapshot } from '../services/api.js';
import { f2, toastOk, toastErr, copyPlain } from '../services/utils.js';

const STRAT_META = {
  steady: { label: '稳健长线', color: '#0369a1', bg: '#f0f9ff', border: '#bae6fd', icon: '🛡️' },
  short: { label: '短线做T', color: '#0f766e', bg: '#f0fdfa', border: '#5eead4', icon: '🎯' },
  tail: { label: '尾盘黑马', color: '#7c3aed', bg: '#faf5ff', border: '#d8b4fe', icon: '⚡' },
  board: { label: '连板打板', color: '#cf1322', bg: '#fff1f0', border: '#ffa39e', icon: '🔥' },
};

function fmtRet(v, emptyText = '待结算') {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return emptyText;
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function retColor(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'var(--mute)';
  return Number(v) >= 0 ? 'var(--up)' : 'var(--down)';
}

function MetricPill({ label, stats }) {
  const c = stats?.count || 0;
  return (
    <div style={{ padding: '7px 9px', borderRadius: '6px', background: 'rgba(255,255,255,0.8)', border: '1px solid var(--line)' }}>
      <div style={{ fontSize: '10.5px', color: 'var(--mute)', marginBottom: '2px' }}>{label}</div>
      {c === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--mute)', fontWeight: 600 }}>待 T+1 结算</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <b style={{ fontSize: '14px', fontFamily: 'monospace', color: retColor(stats.mean) }}>{fmtRet(stats.mean)}</b>
            <span style={{ fontSize: '11px', color: 'var(--sub)' }}>胜率 <b>{stats.winRate}%</b></span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mute)', marginTop: '2px', fontFamily: 'monospace' }}>
            中位 {fmtRet(stats.median)} · 样本{c}{stats.bigLossRate != null ? ` · 大面${stats.bigLossRate}%` : ''}
          </div>
        </>
      )}
    </div>
  );
}

export default function PerfPage({
  tradeLogs = [],
  pool = [],
  onAddStock,
  onTabChange,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [stratTab, setStratTab] = useState('all'); // 'all' | 'steady' | 'short' | 'tail' | 'board'
  const [dateFilter, setDateFilter] = useState('all');
  const [searchKw, setSearchKw] = useState('');
  const [onlyFillable, setOnlyFillable] = useState(false);

  const loadPerf = useCallback(async (forceRefresh = false) => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchStrategyPerf(forceRefresh);
      if (res && res.ok) {
        setData(res);
      } else {
        throw new Error(res?.detail || '获取战绩统计失败');
      }
    } catch (err) {
      setError(err?.message || '战绩接口不可用，请确认后端已启动');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPerf(false);
  }, [loadPerf]);

  const handleSyncSnapshot = async () => {
    try {
      setSyncing(true);
      const snap = await triggerStrategySnapshot();
      await loadPerf(true);
      toastOk(`已同步今日建档快照（共 ${snap.totalSignals} 条；打板剔除一字${snap.excludedLocked || 0}、尾盘偷袭${snap.excludedLate || 0}）`);
    } catch (err) {
      toastErr(err?.message || '同步建档失败');
    } finally {
      setSyncing(false);
    }
  };

  const inPoolCodes = useMemo(() => new Set((pool || []).map(s => String(s.code).padStart(6, '0'))), [pool]);
  const records = useMemo(() => data?.records || [], [data]);
  const summaries = useMemo(() => data?.summaries || {}, [data]);

  // 个人实盘做T统计（来自 LedgerPage tradeLogs）
  const manualStats = useMemo(() => {
    const closed = (tradeLogs || []).filter(lg => {
      const isPureBuy = lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入';
      return !isPureBuy && (+lg.buy > 0 && +lg.sell > 0);
    });
    const wins = closed.filter(lg => (+lg.net || 0) > 0).length;
    const netSum = closed.reduce((acc, lg) => acc + (+lg.net || 0), 0);
    return {
      totalTrades: closed.length,
      winRate: closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : null,
      netSum: Math.round(netSum * 100) / 100,
    };
  }, [tradeLogs]);

  const availDates = useMemo(() => {
    return Array.from(new Set(records.map(r => r.signalDate))).sort().reverse();
  }, [records]);

  const filteredRecords = useMemo(() => {
    return records.filter(r => {
      if (stratTab !== 'all' && r.strategy !== stratTab) return false;
      if (dateFilter !== 'all' && r.signalDate !== dateFilter) return false;
      if (onlyFillable && r.strategy === 'short' && r.status === 'active' && r.pullbackFilled === false) return false;
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return r.code.includes(q) || String(r.name || '').toLowerCase().includes(q) || String(r.hybk || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [records, stratTab, dateFilter, onlyFillable, searchKw]);

  const handleCopyReport = () => {
    if (!data) return;
    const { steady = {}, short = {}, tail = {}, board = {} } = summaries;
    const lines = [
      `📊【T-Stock 四维策略推荐战绩透视 · 基线 ${data.baselineDate}】`,
      `累计追踪信号：${data.totalSignals} 条 ｜ 费率口径：往返 ${data.feeRatePct}%`,
      `1️⃣ 稳健长线(${steady.totalSignals || 0}只): 纯持有均值 ${fmtRet(steady.holdStats?.mean)} (胜率 ${steady.holdStats?.winRate ?? '—'}%) ｜ 含倒T ${fmtRet(steady.withTStats?.mean)} (增厚 ${fmtRet(steady.avgTAlpha)})`,
      `2️⃣ 短线做T(${short.execSignals || 0}只):`,
      `   · 列A次日开盘: 均值 ${fmtRet(short.openCol?.stats?.mean)} ｜ 胜率 ${short.openCol?.stats?.winRate ?? '—'}%`,
      `   · 列B回踩区间: 达成率 ${short.pullbackCol?.fillRate ?? '—'}% ｜ 均值 ${fmtRet(short.pullbackCol?.stats?.mean)} ｜ 胜率 ${short.pullbackCol?.stats?.winRate ?? '—'}%`,
      `   · 做T增厚α: ${fmtRet(short.tAlpha?.avgTAlpha)} ｜ BAD拦截对照: ${fmtRet(short.badControlStats?.mean)}`,
      `3️⃣ 尾盘黑马(${tail.totalSignals || 0}只): 次日冲高+2.5%命中率 ${tail.tpHitRate ?? '—'}% ｜ 规则出场均值 ${fmtRet(tail.t1RuleStats?.mean)} (中位 ${fmtRet(tail.t1RuleStats?.median)})`,
      `4️⃣ 连板打板(${board.totalSignals || 0}只, 已剔除一字/14:30+尾盘): T+1均值 ${fmtRet(board.t1CloseStats?.mean)} (中位 ${fmtRet(board.t1CloseStats?.median)}) ｜ 次日晋级率 ${board.promoRateT1 ?? '—'}%`,
      `👤 实盘手工做T账本: ${manualStats.totalTrades} 笔 ｜ 胜率 ${manualStats.winRate ?? '—'}% ｜ 净盈亏 ¥${f2(manualStats.netSum)}`,
    ];
    copyPlain(lines.join('\n'), '✓ 已复制策略战绩透视摘要');
  };

  const renderHorizonChips = (r) => {
    const h = r.horizons || {};
    const hAlt = r.horizonsAlt || {};
    const chips = [];
    if (r.strategy === 'tail' && h.t0Close != null) chips.push(['当日尾盘', h.t0Close]);
    if (h.t1Open != null) chips.push(['T+1开盘', h.t1Open]);
    if (h.t1High != null) chips.push(['T+1冲高', h.t1High]);
    if (h.t1RuleExit != null) chips.push(['T+1规则出', h.t1RuleExit]);
    if (h.t1 != null) chips.push(['T+1收', h.t1]);
    if (r.strategy === 'short' && r.pullbackFilled && hAlt.t1 != null) chips.push(['T+1回踩收', hAlt.t1]);
    if (h.t2 != null) chips.push(['T+2', h.t2]);
    if (h.t3 != null) chips.push(['T+3', h.t3]);
    if (h.t5 != null) chips.push(['T+5', h.t5]);
    if (h.t10 != null) chips.push(['T+10', h.t10]);
    if (h.t20 != null) chips.push(['T+20', h.t20]);
    if (chips.length === 0) {
      return <span style={{ fontSize: '11px', color: 'var(--mute)' }}>今日建档 · 待下一个交易日产生时间节点曲线</span>;
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
        {chips.map(([k, v]) => (
          <span
            key={k}
            style={{
              fontSize: '10.5px',
              padding: '1px 6px',
              borderRadius: '4px',
              background: v >= 0 ? '#fff1f0' : '#f0fdf4',
              color: v >= 0 ? '#cf1322' : '#15803d',
              border: `1px solid ${v >= 0 ? '#ffa39e' : '#bbf7d0'}`,
              fontFamily: 'monospace',
              fontWeight: 700,
            }}
          >
            {k} {fmtRet(v)}
          </span>
        ))}
      </div>
    );
  };

  const st = summaries.steady || {};
  const sh = summaries.short || {};
  const tl = summaries.tail || {};
  const bd = summaries.board || {};

  return (
    <div style={{ maxWidth: '1440px', margin: '0 auto', padding: '12px 16px 40px' }}>
      {/* 顶部总览横幅 */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #312e81 100%)',
        color: '#fff',
        borderRadius: '12px',
        padding: '16px 20px',
        marginBottom: '14px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.16)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>📊 四维策略胜率与收益率归因透视</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(16,185,129,0.25)', border: '1px solid #34d399', color: '#6ee7b7' }}>
                建档基线：{data?.baselineDate || '2026-11-10'} 起
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '4px', lineHeight: 1.5 }}>
              已纳入 <b>稳健长线 / 短线做T(双列) / 尾盘黑马 / 连板打板</b> 四条赛道，统一扣除双边交易费率 <b>{data?.feeRatePct ?? 0.102}%</b>；
              连板打板已自动剔除「09:25 一字封死 ({bd.lastExclude?.excludedLocked ?? 0}只)」与「14:30+ 尾盘偷袭 ({bd.lastExclude?.excludedLate ?? 0}只)」。
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="mini" onClick={handleCopyReport} style={{ background: 'rgba(56,189,248,0.2)', color: '#bae6fd', borderColor: '#38bdf8', padding: '4px 10px' }}>
              📋 复制战绩摘要
            </button>
            <button
              type="button"
              className="mini"
              disabled={syncing || loading}
              onClick={handleSyncSnapshot}
              style={{ background: '#10b981', color: '#fff', borderColor: '#059669', padding: '4px 12px', fontWeight: 700 }}
            >
              {syncing ? '⟳ 同步建档中…' : '⟳ 同步今日各池建档'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '14px', marginBottom: '12px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: '8px', color: '#cf1322', fontSize: '13px' }}>
          <b>战绩数据加载失败：</b>{error}
        </div>
      )}

      {/* T+0 首日说明 & 实盘对比条 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        padding: '10px 14px',
        marginBottom: '14px',
        background: '#f8fafc',
        border: '1px solid var(--line)',
        borderRadius: '10px',
        fontSize: '12px',
      }}>
        <div style={{ color: 'var(--sub)' }}>
          📌 <b>实时战绩核验：</b>累计建档 <b>{data?.totalSignals ?? 0}</b> 条信号（更新时间 {data?.evaluatedAt || '—'}）。
          <span style={{ color: '#64748b', marginLeft: '6px' }}>
            建档当日 (T+0) 标为「待结算」，自首个次日 (T+1) 起每日自动核算开盘/回踩/做T增厚与多周期节点收益。
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span>
            👤 <b>我的手工做T实盘：</b>{manualStats.totalTrades} 笔 ｜ 胜率 <b>{manualStats.winRate ?? '—'}%</b> ｜ 净盈亏{' '}
            <b style={{ fontFamily: 'monospace', color: retColor(manualStats.netSum) }}>
              {manualStats.netSum >= 0 ? `+¥${f2(manualStats.netSum)}` : `-¥${f2(Math.abs(manualStats.netSum))}`}
            </b>
          </span>
          {onTabChange && (
            <button type="button" className="mini" onClick={() => onTabChange('/ledger')} style={{ fontSize: '11px' }}>
              去台账明细 →
            </button>
          )}
        </div>
      </div>

      {/* 四维策略卡片横向对比 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        {/* 1. 稳健长线 */}
        <div style={{ padding: '14px', borderRadius: '10px', background: STRAT_META.steady.bg, border: `1.5px solid ${STRAT_META.steady.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <b style={{ fontSize: '14px', color: STRAT_META.steady.color }}>🛡️ ① 稳健底仓（长线）</b>
            <span style={{ fontSize: '11px', fontWeight: 700, color: STRAT_META.steady.color }}>建档 {st.totalSignals || 0} 只</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <MetricPill label="纯持有至今 (T+1开盘起)" stats={st.holdStats} />
            <MetricPill label="含逐日倒T增厚总收益" stats={st.withTStats} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <span>倒T日均累计增厚: <b style={{ color: retColor(st.avgTAlpha) }}>{fmtRet(st.avgTAlpha, '—')}</b></span>
            <span>T+5: <b>{fmtRet(st.byHorizon?.t5?.mean, '—')}</b> · T+20: <b>{fmtRet(st.byHorizon?.t20?.mean, '—')}</b></span>
          </div>
        </div>

        {/* 2. 短线做T（两列并列展示） */}
        <div style={{ padding: '14px', borderRadius: '10px', background: STRAT_META.short.bg, border: `1.5px solid ${STRAT_META.short.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <b style={{ fontSize: '14px', color: STRAT_META.short.color }}>🎯 ② 短线做T候选（双口径并列）</b>
            <span style={{ fontSize: '11px', fontWeight: 700, color: STRAT_META.short.color }}>
              可执行 {sh.execSignals || 0} / 闸门拦截 {sh.badBlockedSignals || 0}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <MetricPill label="列A · 次日开盘直接买" stats={sh.openCol?.stats} />
            <MetricPill label={`列B · 回踩区间成交 (达成${sh.pullbackCol?.fillRate ?? '—'}%)`} stats={sh.pullbackCol?.stats} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <span>正T日K增厚α: <b style={{ color: retColor(sh.tAlpha?.avgTAlpha) }}>{fmtRet(sh.tAlpha?.avgTAlpha, '—')}</b> (触发日胜率 {sh.tAlpha?.tDayWinRate ?? '—'}%)</span>
            <span>BAD闸门对照组: <b>{fmtRet(sh.badControlStats?.mean, '无')}</b></span>
          </div>
        </div>

        {/* 3. 尾盘黑马 */}
        <div style={{ padding: '14px', borderRadius: '10px', background: STRAT_META.tail.bg, border: `1.5px solid ${STRAT_META.tail.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <b style={{ fontSize: '14px', color: STRAT_META.tail.color }}>⚡ ③ 尾盘黑马（14:30 隔夜）</b>
            <span style={{ fontSize: '11px', fontWeight: 700, color: STRAT_META.tail.color }}>建档 {tl.totalSignals || 0} 只</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <MetricPill label="T+1 规则出场(+2.5%止盈/-1.5%止损)" stats={tl.t1RuleStats} />
            <MetricPill label="T+1 盘中最高冲高空间" stats={tl.t1HighStats} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <span>当日尾盘浮盈: <b style={{ color: retColor(tl.t0DriftStats?.mean) }}>{fmtRet(tl.t0DriftStats?.mean, '—')}</b></span>
            <span>次日冲高≥+2.5%命中率: <b>{tl.tpHitRate != null ? `${tl.tpHitRate}%` : '待T+1'}</b></span>
          </div>
        </div>

        {/* 4. 连板打板 */}
        <div style={{ padding: '14px', borderRadius: '10px', background: STRAT_META.board.bg, border: `1.5px solid ${STRAT_META.board.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <b style={{ fontSize: '14px', color: STRAT_META.board.color }}>🔥 ④ 连板打板（剔除一字/尾盘）</b>
            <span style={{ fontSize: '11px', fontWeight: 700, color: STRAT_META.board.color }}>可买样本 {bd.totalSignals || 0} 只</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <MetricPill label="T+1 次日开盘溢价" stats={bd.t1OpenStats} />
            <MetricPill label="T+1 收盘净收益" stats={bd.t1CloseStats} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--sub)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <span>次日连板晋级率: <b>{bd.promoRateT1 != null ? `${bd.promoRateT1}%` : '待T+1'}</b></span>
            <span>红灯熔断组T+1: <b>{fmtRet(bd.redControlStats?.mean, '无红灯')}</b> · 绿黄灯: <b>{fmtRet(bd.greenYellowStats?.mean, '—')}</b></span>
          </div>
        </div>
      </div>

      {/* 明细筛选工具栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        padding: '10px 14px',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: '10px',
        marginBottom: '12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {[
            { k: 'all', label: `全部策略 (${records.length})` },
            { k: 'steady', label: `🛡️ 稳健长线 (${st.totalSignals || 0})` },
            { k: 'short', label: `🎯 短线做T (${sh.totalSignals || 0})` },
            { k: 'tail', label: `⚡ 尾盘黑马 (${tl.totalSignals || 0})` },
            { k: 'board', label: `🔥 连板打板 (${bd.totalSignals || 0})` },
          ].map(t => (
            <button
              key={t.k}
              type="button"
              className={`mini ${stratTab === t.k ? 'primary' : ''}`}
              onClick={() => setStratTab(t.k)}
              style={{ fontWeight: stratTab === t.k ? 800 : 600 }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {stratTab === 'short' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyFillable} onChange={e => setOnlyFillable(e.target.checked)} />
              <span>仅看回踩买进</span>
            </label>
          )}
          <select
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface2)' }}
          >
            <option value="all">全部建档日</option>
            {availDates.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="搜代码 / 名称 / 板块…"
            value={searchKw}
            onChange={e => setSearchKw(e.target.value)}
            style={{ padding: '4px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', width: '165px', background: 'var(--surface2)' }}
          />
        </div>
      </div>

      {/* 明细表 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflowX: 'auto' }}>
        <div style={{ minWidth: '1020px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '92px 86px 150px 106px 96px 110px 92px minmax(200px, 1fr) 88px',
            gap: '8px',
            padding: '8px 12px',
            background: '#f8fafc',
            borderBottom: '1px solid var(--line)',
            fontSize: '11px',
            fontWeight: 700,
            color: 'var(--mute)',
          }}>
            <div>策略赛道</div>
            <div>建档 / 闸门</div>
            <div>标的 / 评级</div>
            <div>买入基准价</div>
            <div>列A / 现收益</div>
            <div>列B回踩 / 做Tα</div>
            <div>极值(盈/撤)</div>
            <div>各时间节点收益率</div>
            <div style={{ textAlign: 'right' }}>操作</div>
          </div>

          {loading && !data && (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--mute)', fontSize: '13px' }}>
              正在聚合四维策略信号并拉取日K线实时回算…
            </div>
          )}

          {!loading && filteredRecords.length === 0 && (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px' }}>
              当前筛选条件下暂无建档记录，可点击右上角「⟳ 同步今日各池建档」。
            </div>
          )}

          {filteredRecords.map((r, idx) => {
            const sm = STRAT_META[r.strategy] || STRAT_META.short;
            const inT = inPoolCodes.has(r.code);
            return (
              <div
                key={r.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '92px 86px 150px 106px 96px 110px 92px minmax(200px, 1fr) 88px',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderBottom: idx === filteredRecords.length - 1 ? 'none' : '1px solid var(--line)',
                  background: idx % 2 === 1 ? '#fcfcfd' : '#fff',
                  fontSize: '12px',
                }}
              >
                <div>
                  <span style={{ fontSize: '11px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: sm.bg, color: sm.color, border: `1px solid ${sm.border}` }}>
                    {sm.icon} {sm.label}
                  </span>
                  {r.subType && (
                    <div style={{ fontSize: '10.5px', color: 'var(--mute)', marginTop: '2px' }}>{r.subType}</div>
                  )}
                </div>

                <div style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  <div>{r.signalDate}</div>
                  <div style={{ color: r.env === 'BAD' || r.env === 'RED' ? '#cf1322' : r.env === 'WARN' || r.env === 'YELLOW' ? '#d97706' : '#15803d', fontWeight: 700 }}>
                    闸门:{r.env}
                  </div>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <b>{r.name}</b> <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>{r.code}</span>
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--sub)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.score ? `${Math.round(r.score)}分` : ''}{r.verdict ? ` · ${r.verdict}` : ''}{r.hybk ? ` · ${r.hybk}` : ''}
                    {r.isMysticResonant && r.mysticCluster ? ` · 🔮${r.mysticCluster}` : ''}
                  </div>
                </div>

                <div style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  <div>现 ¥{f2(r.latestPrice)}</div>
                  <div style={{ color: 'var(--mute)' }}>
                    {r.entryPrice ? `入 ¥${f2(r.entryPrice)}` : `锚 ¥${f2(r.buy || r.refPrice)}`}
                  </div>
                </div>

                <div style={{ fontFamily: 'monospace', fontWeight: 800, color: retColor(r.retLatest) }}>
                  <div>{fmtRet(r.retLatest, '待T+1')}</div>
                  {r.totalReturnWithT != null && (
                    <div style={{ fontSize: '10.5px', color: retColor(r.totalReturnWithT) }}>
                      含T {fmtRet(r.totalReturnWithT)}
                    </div>
                  )}
                </div>

                <div style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  {r.strategy === 'short' ? (
                    <>
                      <div style={{ fontWeight: 700, color: r.pullbackFilled === false ? 'var(--mute)' : retColor(r.retAltLatest) }}>
                        {r.pullbackFilled === true ? `踩 ¥${f2(r.pullbackEntryPrice)} ${fmtRet(r.retAltLatest)}` : r.pullbackFilled === false ? '未踩到踏空' : '待T+1回踩'}
                      </div>
                      <div style={{ color: retColor(r.tAlphaPct) }}>
                        做Tα {fmtRet(r.tAlphaPct)}
                      </div>
                    </>
                  ) : r.strategy === 'steady' ? (
                    <div style={{ color: retColor(r.tAlphaPct), fontWeight: 700 }}>
                      倒Tα {fmtRet(r.tAlphaPct)} ({r.tTriggeredDays}次)
                    </div>
                  ) : r.strategy === 'tail' ? (
                    <div style={{ color: retColor(r.horizons?.t1RuleExit), fontWeight: 700 }}>
                      规则出 {fmtRet(r.horizons?.t1RuleExit, '待T+1')}
                    </div>
                  ) : (
                    <div style={{ color: r.horizons?.promotedT1 ? '#cf1322' : 'var(--mute)', fontWeight: 700 }}>
                      {r.horizons?.promotedT1 === true ? '🔥 次日晋级' : r.horizons?.promotedT1 === false ? '次日未晋级' : '待T+1开盘'}
                    </div>
                  )}
                </div>

                <div style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  <div style={{ color: 'var(--up)' }}>{fmtRet(r.maxGainPct, '—')}</div>
                  <div style={{ color: 'var(--down)' }}>{fmtRet(r.maxDrawdownPct, '—')}</div>
                </div>

                <div>{renderHorizonChips(r)}</div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                  <a href={`#/diagnosis?code=${r.code}`} className="mini" style={{ textDecoration: 'none', padding: '2px 5px', fontSize: '10.5px' }} title="全景体检">
                    🩺
                  </a>
                  {!inT && onAddStock ? (
                    <button type="button" className="mini primary" onClick={() => { onAddStock(r.code); toastOk(`已将 ${r.name} 选入做T决策台`); }} style={{ fontSize: '10.5px', padding: '2px 6px' }}>
                      ＋T
                    </button>
                  ) : (
                    <span style={{ fontSize: '10.5px', color: 'var(--info)', fontWeight: 700 }}>✓T</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
