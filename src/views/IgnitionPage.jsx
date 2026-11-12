'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchIgnitionPool } from '../services/api.js';
import { f2, toastOk, toastErr, copyPlain } from '../services/utils.js';

const CUSTOM_US_KEY = 't-ignition-custom-us';

const STAGE_STYLE = {
  SHAKEOUT_READY: { bg: '#fff1f0', color: '#cf1322', border: '#ffa39e' },
  CONVERGED_WAIT: { bg: '#fffbeb', color: '#b45309', border: '#fcd34d' },
  DIGESTING: { bg: '#f0f9ff', color: '#0369a1', border: '#bae6fd' },
  PULLBACK_RISK: { bg: '#f8fafc', color: '#64748b', border: '#cbd5e1' },
};

const DIP_STYLE = {
  ANTI_DROP_BOTTOM: { bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
  SHRINK_WATCH: { bg: '#fffbeb', color: '#b45309', border: '#fcd34d' },
  DIGESTING_DROP: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
  FALLING_KNIFE: { bg: '#fef2f2', color: '#b91c1c', border: '#fca5a5' },
};

function fmtSignedPct(v, digits = 2, fallback = '—') {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return fallback;
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function chgColor(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'var(--mute)';
  return Number(v) >= 0 ? 'var(--up)' : 'var(--down)';
}

function boardBadge(code) {
  const c = String(code || '').padStart(6, '0');
  if (c.startsWith('30')) return { text: '创', bg: '#faf5ff', color: '#7c3aed', border: '#ddd6fe' };
  if (c.startsWith('688')) return { text: '科', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' };
  return { text: '主', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
}

function riskBadge(riskLevel) {
  if (riskLevel === '高风险') return { text: '高风险雷', bg: '#fef2f2', color: '#dc2626', border: '#fecaca' };
  if (riskLevel === '留意') return { text: '留意', bg: '#fffbeb', color: '#d97706', border: '#fde68a' };
  return { text: '排雷安全', bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0' };
}

export default function IgnitionPage({
  pool = [],
  onAddStock,
}) {
  const [subTab, setSubTab] = useState('breakout'); // 'breakout' | 'dip'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  // 方向一过滤（默认仅扫主板 00/60）
  const [includeCyb, setIncludeCyb] = useState(false);
  const [lookbackDays, setLookbackDays] = useState(20);
  const [stageFilter, setStageFilter] = useState('all');

  // 方向二过滤
  const [sectorDdMin, setSectorDdMin] = useState(30);
  const [stockDdMin, setStockDdMin] = useState(40);
  const [dipSignalFilter, setDipSignalFilter] = useState('all');
  const [hideKnife, setHideKnife] = useState(true);
  const [selectedBoard, setSelectedBoard] = useState('all');
  const [searchKw, setSearchKw] = useState('');

  // 自定义外盘映射
  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [customMappings, setCustomMappings] = useState(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_US_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [draftTheme, setDraftTheme] = useState('');
  const [draftUsSym, setDraftUsSym] = useState('');
  const [draftKeywords, setDraftKeywords] = useState('');

  const inPoolCodes = useMemo(() => new Set((pool || []).map(s => String(s.code).padStart(6, '0'))), [pool]);

  const loadScan = useCallback(async (forceRefresh = false) => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchIgnitionPool({
        includeCyb,
        lookbackDays,
        sectorDdMin,
        stockDdMin,
        customMappings,
        refresh: forceRefresh,
      });
      if (res && res.ok) {
        setData(res);
      } else {
        throw new Error(res?.detail || '起爆挖掘扫盘返回异常');
      }
    } catch (err) {
      setError(err?.message || '扫描请求失败，请确认后端 18765 已启动');
    } finally {
      setLoading(false);
    }
  }, [includeCyb, lookbackDays, sectorDdMin, stockDdMin, customMappings]);

  useEffect(() => {
    loadScan(false);
  }, [loadScan]);

  const breakoutData = data?.breakout || {};
  const dipData = data?.dipLeaders || {};
  const breakoutItems = useMemo(() => breakoutData.items || [], [breakoutData]);
  const dipItems = useMemo(() => dipData.items || [], [dipData]);
  const usRadar = useMemo(() => dipData.usRadar || [], [dipData]);
  const deepBoards = useMemo(() => dipData.deepBoards || [], [dipData]);

  const filteredBreakout = useMemo(() => {
    return breakoutItems.filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return item.code.includes(q) || String(item.name || '').toLowerCase().includes(q) || String(item.hybk || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [breakoutItems, stageFilter, searchKw]);

  const filteredDip = useMemo(() => {
    return dipItems.filter((item) => {
      if (hideKnife && item.dipSignal === 'FALLING_KNIFE') return false;
      if (dipSignalFilter !== 'all' && item.dipSignal !== dipSignalFilter) return false;
      if (selectedBoard !== 'all') {
        const hit = (item.matchedBoards || []).some(b => b.bkName === selectedBoard) || item.primaryBoardName === selectedBoard;
        if (!hit) return false;
      }
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return item.code.includes(q) || String(item.name || '').toLowerCase().includes(q) || String(item.primaryBoardName || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [dipItems, hideKnife, dipSignalFilter, selectedBoard, searchKw]);

  const handleAddCustomMapping = () => {
    const syms = draftUsSym.split(/[\s,，;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const kws = draftKeywords.split(/[\s,，;]+/).map(s => s.trim()).filter(Boolean);
    if (!syms.length || !kws.length) {
      toastErr('请填写至少一个美股代码（如 NVDA）与 A股板块关键词（如 CPO）');
      return;
    }
    const nextItem = {
      themeId: `custom_${Date.now()}`,
      themeName: draftTheme.trim() || `${syms[0]}↔${kws[0]}`,
      usSymbols: syms.map(s => ({ symbol: s, label: s })),
      boardKeywords: kws,
    };
    const nextList = [...customMappings, nextItem];
    setCustomMappings(nextList);
    try { localStorage.setItem(CUSTOM_US_KEY, JSON.stringify(nextList)); } catch {}
    setDraftTheme('');
    setDraftUsSym('');
    setDraftKeywords('');
    toastOk(`已添加外盘映射：${nextItem.themeName}，正在重扫…`);
  };

  const handleRemoveCustomMapping = (themeId) => {
    const nextList = customMappings.filter(x => x.themeId !== themeId);
    setCustomMappings(nextList);
    try { localStorage.setItem(CUSTOM_US_KEY, JSON.stringify(nextList)); } catch {}
  };

  const handleCopyBrief = () => {
    if (!data) return;
    const bTop = breakoutItems.slice(0, 8);
    const dTop = dipItems.filter(x => x.dipSignal !== 'FALLING_KNIFE').slice(0, 8);
    const lines = [
      `🚀【智策战情室 · 起爆挖掘双池简报】${data.date} (扫盘于 ${data.scannedAt})`,
      `一、横盘试盘起爆（月放量+周向上+日缩量，共 ${breakoutItems.length} 只 / 震仓 ${breakoutData.stats?.counts?.shakeoutReady || 0}）：`,
      ...bTop.map(x => `  · ${x.name}(${x.code}) ${x.stageLabel} | 现价¥${f2(x.price)}(${fmtSignedPct(x.chg)}) | ${x.ztDate}板后${x.daysSinceZt}天 | 月量${x.monthVolRatio}x · 日缩至${x.volShrinkPct}% · ${x.ignitionScore}分`),
      '',
      `二、深跌龙头抗跌抄底（板块回撤≥${sectorDdMin}% & 个股≥${stockDdMin}%，共 ${dipItems.length} 只 / 抗跌 ${dipData.stats?.counts?.antiDrop || 0}）：`,
      ...dTop.map(x => `  · ${x.name}(${x.code}) ${x.dipLabel} | ${x.primaryBoardName}(回撤${x.worstBoardDd}%) · 股回撤${x.stockDrawdownPct}% | 量枯${x.volExhaustPct}% · ${x.dipScore}分`),
    ];
    copyPlain(lines.join('\n'), '✓ 已复制起爆与抄底双池复盘简报');
  };

  const bCounts = breakoutData.stats?.counts || {};
  const dCounts = dipData.stats?.counts || {};

  return (
    <div style={{ maxWidth: '1440px', margin: '0 auto', padding: '12px 16px 40px' }}>
      {/* 顶部主题横幅 */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 55%, #312e81 100%)',
        color: '#fff',
        borderRadius: '12px',
        padding: '16px 20px',
        marginBottom: '14px',
        boxShadow: '0 4px 16px rgba(15, 23, 42, 0.2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>🚀 起爆点挖掘 · 多周期试盘潜伏 & 板块深跌抗跌抄底</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(56,189,248,0.2)', border: '1px solid #38bdf8', color: '#bae6fd' }}>
                交易日 {data?.date || '—'} · 更新 {data?.scannedAt || '扫描中'}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '5px', lineHeight: 1.5 }}>
              方向一抓<b>“近期涨停试水 → 月放量 + 周向上 + 日缩量 + 震仓收回”</b>主升前夜；
              方向二抓<b>“板块腰斩级出清 + 美股/板块利空砸不动”</b>的抛压枯竭龙头拐点。
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="mini"
              onClick={handleCopyBrief}
              style={{ background: 'rgba(56,189,248,0.18)', color: '#bae6fd', borderColor: '#38bdf8', padding: '5px 10px' }}
            >
              📋 复制双池简报
            </button>
            <button
              type="button"
              className="mini"
              disabled={loading}
              onClick={() => loadScan(true)}
              style={{ background: '#10b981', color: '#fff', borderColor: '#059669', padding: '5px 12px', fontWeight: 700 }}
            >
              {loading ? '⟳ 全市场漏斗扫盘中…' : '🔄 立即实时扫盘'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 14px', marginBottom: '12px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: '8px', color: '#cf1322', fontSize: '13px' }}>
          <b>扫盘失败：</b>{error}
        </div>
      )}

      {/* 方向切换主卡 + 搜索栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        padding: '10px 14px',
        marginBottom: '12px',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`mini ${subTab === 'breakout' ? 'primary' : ''}`}
            onClick={() => setSubTab('breakout')}
            style={{ padding: '6px 12px', fontSize: '13px', fontWeight: 800 }}
          >
            🔥 方向一：横盘试盘起爆 ({breakoutItems.length})
            {bCounts.shakeoutReady > 0 && (
              <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '99px', background: '#fff1f0', color: '#cf1322', fontSize: '11px' }}>
                震仓 {bCounts.shakeoutReady}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`mini ${subTab === 'dip' ? 'primary' : ''}`}
            onClick={() => setSubTab('dip')}
            style={{ padding: '6px 12px', fontSize: '13px', fontWeight: 800 }}
          >
            🛟 方向二：深跌龙头抗跌抄底 ({dipItems.length})
            {dCounts.antiDrop > 0 && (
              <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '99px', background: '#dcfce7', color: '#15803d', fontSize: '11px' }}>
                抗跌 {dCounts.antiDrop}
              </span>
            )}
          </button>
        </div>

        <input
          type="text"
          placeholder="搜代码 / 名称 / 板块…"
          value={searchKw}
          onChange={e => setSearchKw(e.target.value)}
          style={{ padding: '5px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', width: '190px', background: 'var(--surface2)' }}
        />
      </div>

      {/* ========================= 方向一：横盘试盘起爆 ========================= */}
      {subTab === 'breakout' && (
        <div>
          <div style={{
            padding: '10px 14px',
            marginBottom: '12px',
            background: '#fff7ed',
            border: '1px solid #fed7aa',
            borderRadius: '10px',
            fontSize: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}>
            <div style={{ color: '#9a3412', lineHeight: 1.5 }}>
              <b>漏斗机制：</b>近 {lookbackDays} 日涨停种子 <b>{breakoutData.stats?.seedCount ?? '—'}</b> 只 → 日线缩量防守筛出 <b>{breakoutData.stats?.dailyPassedCount ?? '—'}</b> 只 → 月放量(≥1.25x)+周向上共振 <b>{breakoutItems.length}</b> 只。
              <span style={{ marginLeft: '6px', color: '#7c2d12' }}>重点盯 <b>🔥 震仓完成·待起爆</b>（下影探底收回 / 砸破反包）与 <b>⏳ 均线粘合·缩量蓄势</b>，避开 ⚠️ 急拉防回调。</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontWeight: 700, color: '#7c2d12' }}>
                <input type="checkbox" checked={includeCyb} onChange={e => setIncludeCyb(e.target.checked)} />
                <span>包含创业板 / 科创板 (300/688)</span>
              </label>

              <select
                value={lookbackDays}
                onChange={e => setLookbackDays(Number(e.target.value))}
                style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid #fdba74', background: '#fff' }}
              >
                <option value={10}>近10日涨停</option>
                <option value={20}>近20日涨停(默认)</option>
                <option value={30}>近30日涨停</option>
              </select>
            </div>
          </div>

          {/* 阶段分档过滤 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {[
              { k: 'all', label: `全部 (${breakoutItems.length})` },
              { k: 'SHAKEOUT_READY', label: `🔥 震仓完成·待起爆 (${bCounts.shakeoutReady || 0})` },
              { k: 'CONVERGED_WAIT', label: `⏳ 均线粘合·缩量蓄势 (${bCounts.convergedWait || 0})` },
              { k: 'DIGESTING', label: `👀 试盘缩量消化 (${bCounts.digesting || 0})` },
              { k: 'PULLBACK_RISK', label: `⚠️ 急拉防回调 (${bCounts.pullbackRisk || 0})` },
            ].map(tab => (
              <button
                key={tab.k}
                type="button"
                className={`mini ${stageFilter === tab.k ? 'primary' : ''}`}
                onClick={() => setStageFilter(tab.k)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflowX: 'auto' }}>
            <div style={{ minWidth: '1040px' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '165px 230px 145px 150px 185px 70px 85px',
                gap: '8px',
                padding: '9px 12px',
                background: '#f8fafc',
                borderBottom: '1px solid var(--line)',
                fontSize: '11px',
                fontWeight: 700,
                color: 'var(--mute)',
              }}>
                <div>标的 / 现价 / 排雷</div>
                <div>状态分档与操盘提示</div>
                <div>试盘涨停 / 前置横盘</div>
                <div>月线放量 / 周线趋势</div>
                <div>日线缩量 / 均线粘合与震仓</div>
                <div>起爆分</div>
                <div style={{ textAlign: 'right' }}>操作</div>
              </div>

              {loading && !data && (
                <div style={{ padding: '28px', textAlign: 'center', color: 'var(--mute)', fontSize: '13px' }}>
                  正在扫描近 {lookbackDays} 日涨停池并核验月/周/日三周期共振，请稍候（约 6~10 秒）…
                </div>
              )}

              {!loading && filteredBreakout.length === 0 && (
                <div style={{ padding: '28px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px' }}>
                  当前筛选条件下暂无符合「近期涨停 + 月放量 + 周向上 + 日缩量」标的，可尝试切换分档或放宽板块范围。
                </div>
              )}

              {filteredBreakout.map((item, idx) => {
                const stStyle = STAGE_STYLE[item.stage] || STAGE_STYLE.DIGESTING;
                const rk = riskBadge(item.riskLevel);
                const bd = boardBadge(item.code);
                const inT = inPoolCodes.has(item.code);
                return (
                  <div
                    key={item.code}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '165px 230px 145px 150px 185px 70px 85px',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderBottom: idx === filteredBreakout.length - 1 ? 'none' : '1px solid var(--line)',
                      background: idx % 2 === 1 ? '#fcfcfd' : '#fff',
                      fontSize: '12px',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '10px', padding: '0 4px', borderRadius: '3px', background: bd.bg, color: bd.color, border: `1px solid ${bd.border}`, fontWeight: 700 }}>{bd.text}</span>
                        <b>{item.name}</b>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>{item.code}</span>
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: '11.5px', marginTop: '3px' }}>
                        <b>¥{f2(item.price)}</b>{' '}
                        <span style={{ color: chgColor(item.chg), fontWeight: 700 }}>{fmtSignedPct(item.chg)}</span>
                        <span style={{ color: 'var(--mute)', marginLeft: '5px', fontSize: '10.5px' }}>{item.hybk}</span>
                      </div>
                      <div style={{ marginTop: '3px' }}>
                        <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: rk.bg, color: rk.color, border: `1px solid ${rk.border}`, fontWeight: 700 }}>
                          {rk.text}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', background: stStyle.bg, color: stStyle.color, border: `1px solid ${stStyle.border}` }}>
                        {item.stageLabel}
                      </span>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '4px', lineHeight: 1.4 }}>
                        {item.stageTip}
                      </div>
                    </div>

                    <div style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.5 }}>
                      <div>板日: <b>{item.ztDate}</b> ({item.daysSinceZt}天前)</div>
                      <div>距起点: <b style={{ color: chgColor(item.distToStartPct) }}>{fmtSignedPct(item.distToStartPct)}</b></div>
                      <div style={{ color: 'var(--mute)' }}>板前振幅 {item.preBoxAmp}%</div>
                    </div>

                    <div style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>月放量: <b style={{ fontFamily: 'monospace', color: '#b45309' }}>{item.monthVolRatio}x</b>{item.monthHighWarn ? <span style={{ color: '#dc2626', marginLeft: '4px' }}>(月高位)</span> : ''}</div>
                      <div style={{ color: '#15803d', fontWeight: 700 }}>{item.weeklyTrendDesc}</div>
                      <div style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>月位 {item.monthPricePosPct}%</div>
                    </div>

                    <div style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>缩至板: <b style={{ fontFamily: 'monospace', color: '#0369a1' }}>{item.volShrinkPct}%</b> (连缩{item.shrinkStreak}日)</div>
                      <div style={{ fontFamily: 'monospace' }}>均线极差 {item.maSpreadPct}% · 乖离 {fmtSignedPct(item.biasMa5, 1)}</div>
                      {item.shakeoutSignals && item.shakeoutSignals.length > 0 && (
                        <div style={{ color: '#cf1322', fontWeight: 700 }}>⚡ {item.shakeoutSignals.join(' + ')}</div>
                      )}
                    </div>

                    <div style={{ fontFamily: 'monospace', fontSize: '16px', fontWeight: 800, color: item.ignitionScore >= 80 ? '#cf1322' : '#0369a1' }}>
                      {item.ignitionScore}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                      <a href={`#/diagnosis?code=${item.code}`} className="mini" style={{ textDecoration: 'none', padding: '3px 6px', fontSize: '11px' }} title="全景排雷与筹码体检">
                        🩺
                      </a>
                      {!inT && onAddStock ? (
                        <button type="button" className="mini primary" onClick={() => { onAddStock(item.code); toastOk(`已将 ${item.name} 加入自选作战池`); }} style={{ fontSize: '11px', padding: '3px 7px' }}>
                          ＋T
                        </button>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--info)', fontWeight: 700 }}>✓已选</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================= 方向二：深跌龙头抗跌抄底 ========================= */}
      {subTab === 'dip' && (
        <div>
          {/* 1. 外盘隔夜风向标雷达条 */}
          <div style={{
            padding: '10px 14px',
            marginBottom: '12px',
            background: '#f8fafc',
            border: '1px solid var(--line)',
            borderRadius: '10px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--ink)' }}>
                🌎 外盘映射风向标雷达（识别“美股关联板块大跌 → A股龙头抗跌”利空钝化日）
              </div>
              <button type="button" className="mini" onClick={() => setShowCustomEditor(v => !v)} style={{ fontSize: '11px' }}>
                {showCustomEditor ? '收起自定义映射 ▲' : '＋ 自定义美股↔A股映射 ▼'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px' }}>
              {usRadar.map((u) => {
                const isBig = u.alertLevel === 'BIG_DROP';
                const isMod = u.alertLevel === 'MOD_DROP';
                return (
                  <div
                    key={u.themeId}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: isBig ? '#fef2f2' : isMod ? '#fffbeb' : '#fff',
                      border: `1px solid ${isBig ? '#fca5a5' : isMod ? '#fcd34d' : 'var(--line)'}`,
                      fontSize: '11.5px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <b>{u.themeName}</b>
                      <span style={{ fontFamily: 'monospace', fontWeight: 800, color: chgColor(u.usMinChg) }}>
                        {isBig ? '🔥 大跌测试 ' : ''}{fmtSignedPct(u.usMinChg)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '10.5px', color: 'var(--sub)' }}>
                      {(u.quotes || []).slice(0, 4).map(q => (
                        <span key={q.secid} style={{ fontFamily: 'monospace' }}>
                          {q.label} <b style={{ color: chgColor(q.chg) }}>{fmtSignedPct(q.chg)}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {showCustomEditor && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--line)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                <input type="text" placeholder="主题名(如: 航运)" value={draftTheme} onChange={e => setDraftTheme(e.target.value)} style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)', width: '125px' }} />
                <input type="text" placeholder="美股代码(如: ZIM,MATX)" value={draftUsSym} onChange={e => setDraftUsSym(e.target.value)} style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)', width: '160px' }} />
                <input type="text" placeholder="A股板块词(如: 航运,港口)" value={draftKeywords} onChange={e => setDraftKeywords(e.target.value)} style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)', width: '165px' }} />
                <button type="button" className="mini primary" onClick={handleAddCustomMapping}>添加并扫描</button>
                {customMappings.map(cm => (
                  <span key={cm.themeId} style={{ padding: '2px 7px', borderRadius: '99px', background: '#e0f2fe', color: '#0369a1', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {cm.themeName} ({cm.usSymbols.map(s => s.symbol).join('/')})
                    <button type="button" onClick={() => handleRemoveCustomMapping(cm.themeId)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#0369a1', fontWeight: 800 }}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 2. 参数滑块与信号过滤 */}
          <div style={{
            padding: '10px 14px',
            marginBottom: '10px',
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: '10px',
            fontSize: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <b>板块回撤 ≥ {sectorDdMin}%</b>
                <input type="range" min={20} max={55} step={5} value={sectorDdMin} onChange={e => setSectorDdMin(Number(e.target.value))} />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <b>个股回撤 ≥ {stockDdMin}%</b>
                <input type="range" min={25} max={65} step={5} value={stockDdMin} onChange={e => setStockDdMin(Number(e.target.value))} />
              </label>
              <button type="button" className="mini" onClick={() => { setSectorDdMin(50); setStockDdMin(50); }} title="严格卡板块与个股腰斩级回撤">
                腰斩档(50%)
              </button>
              <button type="button" className="mini" onClick={() => { setSectorDdMin(30); setStockDdMin(40); }}>
                均衡默认(30/40%)
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={hideKnife} onChange={e => setHideKnife(e.target.checked)} />
                <span>屏蔽放量下杀/公告雷</span>
              </label>
            </div>
          </div>

          {/* 深跌板块胶囊 & 信号切换 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {[
              { k: 'all', label: `全部信号 (${dipItems.length})` },
              { k: 'ANTI_DROP_BOTTOM', label: `🟢 利空抗跌·底部试探 (${dCounts.antiDrop || 0})` },
              { k: 'SHRINK_WATCH', label: `🟡 深跌缩量·磨底观察 (${dCounts.shrinkWatch || 0})` },
              { k: 'DIGESTING_DROP', label: `⚪ 等待缩量 (${dipItems.filter(x => x.dipSignal === 'DIGESTING_DROP').length})` },
            ].map(t => (
              <button key={t.k} type="button" className={`mini ${dipSignalFilter === t.k ? 'primary' : ''}`} onClick={() => setDipSignalFilter(t.k)}>
                {t.label}
              </button>
            ))}

            {deepBoards.length > 0 && (
              <select
                value={selectedBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface2)' }}
              >
                <option value="all">全部深跌板块 ({deepBoards.length})</option>
                {deepBoards.map(b => (
                  <option key={b.bkCode} value={b.bkName}>
                    {b.bkName} (回撤 {b.boardDrawdownPct}% / 今日 {fmtSignedPct(b.chg)})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflowX: 'auto' }}>
            <div style={{ minWidth: '1040px' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '170px 235px 155px 120px 190px 70px 85px',
                gap: '8px',
                padding: '9px 12px',
                background: '#f8fafc',
                borderBottom: '1px solid var(--line)',
                fontSize: '11px',
                fontWeight: 700,
                color: 'var(--mute)',
              }}>
                <div>核心龙头 / 市值 / 排雷</div>
                <div>抄底信号与触发逻辑</div>
                <div>板块与个股回撤深度</div>
                <div>量能枯竭度</div>
                <div>今日对比(外盘/板块 vs 个股)</div>
                <div>抄底分</div>
                <div style={{ textAlign: 'right' }}>操作</div>
              </div>

              {loading && !data && (
                <div style={{ padding: '28px', textAlign: 'center', color: 'var(--mute)', fontSize: '13px' }}>
                  正在扫描深跌板块、核对美股隔夜跌幅与龙头量能枯竭度…
                </div>
              )}

              {!loading && filteredDip.length === 0 && (
                <div style={{ padding: '28px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px' }}>
                  当前回撤门槛下暂无达标龙头，可适当调低“板块回撤/个股回撤”滑块或取消屏蔽开关查看。
                </div>
              )}

              {filteredDip.map((item, idx) => {
                const ds = DIP_STYLE[item.dipSignal] || DIP_STYLE.DIGESTING_DROP;
                const rk = riskBadge(item.riskLevel);
                const bd = boardBadge(item.code);
                const inT = inPoolCodes.has(item.code);
                return (
                  <div
                    key={item.code}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '170px 235px 155px 120px 190px 70px 85px',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderBottom: idx === filteredDip.length - 1 ? 'none' : '1px solid var(--line)',
                      background: idx % 2 === 1 ? '#fcfcfd' : '#fff',
                      fontSize: '12px',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '10px', padding: '0 4px', borderRadius: '3px', background: bd.bg, color: bd.color, border: `1px solid ${bd.border}`, fontWeight: 700 }}>{bd.text}</span>
                        <b>{item.name}</b>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>{item.code}</span>
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: '11.5px', marginTop: '3px' }}>
                        <b>¥{f2(item.price)}</b>{' '}
                        <span style={{ color: chgColor(item.chg), fontWeight: 700 }}>{fmtSignedPct(item.chg)}</span>
                        <span style={{ color: 'var(--mute)', marginLeft: '5px', fontSize: '10.5px' }}>{item.mcapYi}亿</span>
                      </div>
                      <div style={{ marginTop: '3px' }}>
                        <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: rk.bg, color: rk.color, border: `1px solid ${rk.border}`, fontWeight: 700 }}>
                          {rk.text}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', background: ds.bg, color: ds.color, border: `1px solid ${ds.border}` }}>
                        {item.dipLabel}
                      </span>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '4px', lineHeight: 1.4 }}>
                        {item.dipTip}
                      </div>
                    </div>

                    <div style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div><b>{item.primaryBoardName}</b>: <b style={{ fontFamily: 'monospace', color: '#15803d' }}>{item.worstBoardDd}%</b></div>
                      <div>个股回撤: <b style={{ fontFamily: 'monospace', color: '#15803d' }}>{item.stockDrawdownPct}%</b></div>
                      <div style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>180日高 ¥{f2(item.high180)}</div>
                    </div>

                    <div style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>5日/峰值: <b style={{ fontFamily: 'monospace', color: '#0369a1' }}>{item.volExhaustPct}%</b></div>
                      <div style={{ color: item.notNewLow ? '#15803d' : '#dc2626', fontWeight: 700 }}>
                        {item.notNewLow ? '✓ 未破近5日低' : '✗ 仍在破位新低'}
                      </div>
                    </div>

                    <div style={{ fontSize: '11px', fontFamily: 'monospace', lineHeight: 1.5 }}>
                      <div>
                        板块 {fmtSignedPct(item.worstBoardChg)} → 剪刀差 <b style={{ color: chgColor(item.sectorAlpha) }}>{fmtSignedPct(item.sectorAlpha)}</b>
                      </div>
                      {item.usShock ? (
                        <div>
                          外盘({item.usShock.worstLabel}) {fmtSignedPct(item.usShock.usMinChg)} → α <b style={{ color: chgColor(item.usAlpha) }}>{fmtSignedPct(item.usAlpha)}</b>
                        </div>
                      ) : (
                        <div style={{ color: 'var(--mute)' }}>无外盘映射对比</div>
                      )}
                    </div>

                    <div style={{ fontFamily: 'monospace', fontSize: '16px', fontWeight: 800, color: item.dipSignal === 'ANTI_DROP_BOTTOM' ? '#15803d' : '#475569' }}>
                      {item.dipScore}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                      <a href={`#/diagnosis?code=${item.code}`} className="mini" style={{ textDecoration: 'none', padding: '3px 6px', fontSize: '11px' }} title="全景排雷与筹码体检">
                        🩺
                      </a>
                      {!inT && onAddStock ? (
                        <button type="button" className="mini primary" onClick={() => { onAddStock(item.code); toastOk(`已将 ${item.name} 加入自选作战池`); }} style={{ fontSize: '11px', padding: '3px 7px' }}>
                          ＋T
                        </button>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--info)', fontWeight: 700 }}>✓已选</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
