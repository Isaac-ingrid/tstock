'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchIgnitionPool,
  fetchIgnitionTracking,
  fetchIgnitionDiagnose,
  postIgnitionTrackingAction,
  loadLocalTrackedCodes,
} from '../services/api.js';
import { f2, toastOk, toastErr, copyPlain } from '../services/utils.js';
import MemeRadarSection from '../components/MemeRadarSection.jsx';
import KlinePatternBadges from '../components/KlinePatternBadges.jsx';
import { BoardStockActions } from '../components/board/boardShared.jsx';

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
  initialCode = '',
  onAddStock,
  onSelectStock,
  onJumpDiagnosis,
}) {
  const [subTab, setSubTab] = useState('breakout'); // 'breakout' | 'dip' | 'tracking' | 'meme'
  const [diagQuery, setDiagQuery] = useState('');
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null);
  const [diagError, setDiagError] = useState('');
  const [trackFilter, setTrackFilter] = useState('all'); // 'all' | 'IGNITED' | 'WAITING' | 'STOPPED'
  const [trackingRefreshing, setTrackingRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const [localTrackedCodes, setLocalTrackedCodes] = useState(() => new Set(loadLocalTrackedCodes()));
  const [trackBusyCode, setTrackBusyCode] = useState('');

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

  const inPoolCodes = useMemo(
    () => new Set((pool || []).map((s) => String(s.code).padStart(6, '0'))),
    [pool]
  );

  const loadScan = useCallback(
    async (forceRefresh = false) => {
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
    },
    [includeCyb, lookbackDays, sectorDdMin, stockDdMin, customMappings]
  );

  useEffect(() => {
    loadScan(false);
  }, [loadScan]);

  const breakoutData = data?.breakout || {};
  const dipData = data?.dipLeaders || {};
  const trackingPoolData = data?.trackingPool || {};
  const breakoutItems = useMemo(() => breakoutData.items || [], [breakoutData]);
  const dipItems = useMemo(() => dipData.items || [], [dipData]);
  const trackingItems = useMemo(() => trackingPoolData.items || [], [trackingPoolData]);
  const trackingSummary = useMemo(() => trackingPoolData.summary || {}, [trackingPoolData]);
  const usRadar = useMemo(() => dipData.usRadar || [], [dipData]);
  const deepBoards = useMemo(() => dipData.deepBoards || [], [dipData]);

  // 合并服务端在轨池与本地缓存跟踪码，保证全页面实时同步
  const trackedCodeSet = useMemo(() => {
    const next = new Set(localTrackedCodes);
    trackingItems.forEach((it) => {
      if (it?.code) next.add(String(it.code).padStart(6, '0'));
    });
    return next;
  }, [localTrackedCodes, trackingItems]);

  const handleRefreshTracking = useCallback(async (silent = false) => {
    try {
      setTrackingRefreshing(true);
      const res = await fetchIgnitionTracking();
      if (res && res.ok) {
        setData((prev) => ({
          ...(prev || {}),
          trackingPool: res,
        }));
        if (!silent) {
          toastOk(`已毫秒刷新 ${res.items?.length || 0} 只在轨标的的现价行情与操盘SOP！`);
        }
      } else if (!silent) {
        throw new Error(res?.detail || '刷新跟踪池行情失败');
      }
    } catch (err) {
      if (!silent) toastErr(err?.message || '获取实时跟踪行情异常');
    } finally {
      setTrackingRefreshing(false);
    }
  }, []);

  const handleTrackAction = useCallback(
    async (action, stock, extra = {}) => {
      if (!stock || !stock.code) return;
      const c6 = String(stock.code).trim().padStart(6, '0');
      setTrackBusyCode(c6);
      try {
        const res = await postIgnitionTrackingAction({
          action,
          code: c6,
          name: stock.name || c6,
          hybk: extra.hybk || stock.hybk || stock.primaryBoardName || '起爆挖掘',
          price: +(extra.price || stock.price || stock.curPrice || stock.refPrice || 0),
          strategy: extra.strategy || 'ignition',
          subType: extra.subType || stock.stage || stock.dipSignal || 'MANUAL_TRACK',
          verdict: extra.verdict || stock.stageLabel || stock.dipLabel || '手动加入在轨跟踪',
        });
        if (res && res.ok) {
          setLocalTrackedCodes((prev) => {
            const next = new Set(prev);
            if (action === 'add') next.add(c6);
            else next.delete(c6);
            return next;
          });
          if (action === 'remove') {
            setData((prev) => {
              if (!prev?.trackingPool?.items) return prev;
              const nextItems = prev.trackingPool.items.filter(
                (it) => String(it.code).padStart(6, '0') !== c6
              );
              return {
                ...prev,
                trackingPool: {
                  ...prev.trackingPool,
                  items: nextItems,
                  summary: {
                    ...(prev.trackingPool.summary || {}),
                    totalCount: nextItems.length,
                  },
                },
              };
            });
          } else {
            handleRefreshTracking(true);
          }
          toastOk(
            action === 'add'
              ? `📌 已将 ${stock.name || c6} 加入在轨跟踪池（实时盯盘SOP生效）`
              : `已将 ${stock.name || c6} 移出在轨跟踪池`
          );
        }
      } catch (err) {
        toastErr(`在轨跟踪操作失败：${err.message}`);
      } finally {
        setTrackBusyCode('');
      }
    },
    [handleRefreshTracking]
  );

  // 原位加入自选池（不强制跳走，方便在长表格里连续挑选多只股票）
  const handleAddInPlace = useCallback(
    (code, meta) => {
      if (!onAddStock) return;
      onAddStock(code, meta, { jumpToTrade: false });
    },
    [onAddStock]
  );

  const filteredBreakout = useMemo(() => {
    return breakoutItems.filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return (
          item.code.includes(q) ||
          String(item.name || '').toLowerCase().includes(q) ||
          String(item.hybk || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [breakoutItems, stageFilter, searchKw]);

  const filteredDip = useMemo(() => {
    return dipItems.filter((item) => {
      if (hideKnife && item.dipSignal === 'FALLING_KNIFE') return false;
      if (dipSignalFilter !== 'all' && item.dipSignal !== dipSignalFilter) return false;
      if (selectedBoard !== 'all') {
        const hit =
          (item.matchedBoards || []).some((b) => b.bkName === selectedBoard) ||
          item.primaryBoardName === selectedBoard;
        if (!hit) return false;
      }
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return (
          item.code.includes(q) ||
          String(item.name || '').toLowerCase().includes(q) ||
          String(item.primaryBoardName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [dipItems, hideKnife, dipSignalFilter, selectedBoard, searchKw]);

  const filteredTracking = useMemo(() => {
    return trackingItems.filter((item) => {
      if (
        trackFilter === 'IGNITED' &&
        item.trackStage !== 'IGNITED' &&
        item.trackStage !== 'TARGET_REACHED'
      ) {
        return false;
      }
      if (trackFilter === 'WAITING' && item.trackStage !== 'WAITING') return false;
      if (trackFilter === 'STOPPED' && item.trackStage !== 'STOPPED') return false;
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return (
          item.code.includes(q) ||
          String(item.name || '').toLowerCase().includes(q) ||
          String(item.hybk || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [trackingItems, trackFilter, searchKw]);

  const handleCopySOP = (item) => {
    const sop = item.sop || {};
    const text = [
      `🎯【${item.name} (${item.code}) 专属操盘 SOP 指南】`,
      `入选时点：${item.signalDate} ｜ 当时形态：${item.verdict || item.subType}`,
      `入选基准价：¥${f2(item.refPrice)} ｜ 当前现价：¥${f2(item.curPrice)} (${fmtSignedPct(item.dayChg)})`,
      `累计收益率：${fmtSignedPct(item.gainPct)} ｜ 当前状态：${item.stageDesc}`,
      `───────────────────────────────`,
      `🛡️ 建议防守止损位：¥${f2(sop.defensePrice)} (-4.5%)`,
      `🏹 第一倒T目标位：¥${f2(sop.targetT1)} (+5.0%)`,
      `🏁 主升推进目标位：¥${f2(sop.targetT2)} (+10.0%)`,
      `⏱️ 预估观察周期：${sop.maxDays || 5} 个交易日`,
      `💡 实战操盘对策：${sop.advice || '分时缩量回踩分时均价线低吸做T，放量冲高分批倒T兑现'}`,
    ].join('\n');
    copyPlain(text, `✓ 已复制 ${item.name} 的操盘SOP方案`);
  };

  const handleRunDiag = useCallback(
    async (customQ = null) => {
      const target = String(customQ || diagQuery).trim();
      if (!target) {
        toastErr('请输入要体检的股票代码或名称（如 000417 或 合百集团）');
        return;
      }
      if (customQ) {
        setDiagQuery(customQ);
      }
      try {
        setDiagLoading(true);
        setDiagError('');
        const res = await fetchIgnitionDiagnose(target);
        if (res && res.ok) {
          setDiagResult(res);
          toastOk(`已完成 ${res.name} (${res.code}) 的横盘起爆成色体检！`);
        } else {
          throw new Error(res?.detail || '未查询到匹配的股票');
        }
      } catch (err) {
        setDiagError(err?.message || '起爆体检请求失败');
        toastErr(err?.message || '诊断失败');
      } finally {
        setDiagLoading(false);
      }
    },
    [diagQuery]
  );

  // 跨板块联动：当其他页面通过 /ignition?code=XXXXXX 跳转进来时，自动切换到起爆页并执行六维体检
  useEffect(() => {
    const c = String(initialCode || '').trim();
    if (c) {
      setSubTab('breakout');
      handleRunDiag(c);
    }
  }, [initialCode, handleRunDiag]);

  const handleCopyDiagReport = useCallback((result) => {
    if (!result) return;
    const lines = [
      `🎯【${result.name} (${result.code}) 横盘起爆六维全息体检报告】`,
      `当前状态：${result.stageLabel} ｜ 综合评分：${result.ignitionScore} 分`,
      `最新现价：¥${f2(result.price)} (${fmtSignedPct(result.dayChg)}) ｜ 换手率：${result.turnover}%`,
      `──────────────────────────────────────────────`,
      `一、六维形态逐项核对：`,
      ...(result.checklist || []).map(
        (it) =>
          `  · [${it.passed === true ? '已达标' : it.passed === 'warn' ? '留　意' : '未达标'}] ${it.title}：${it.badge} (${it.val}) → ${it.detail}`
      ),
      `──────────────────────────────────────────────`,
      `二、专属操盘 SOP 预案：`,
      `  · 买入参考价：¥${f2(result.sop?.refPrice)}`,
      `  · 建议防守线：¥${f2(result.sop?.defensePrice)} (-4.5%或底座支撑)`,
      `  · 第一倒T位：¥${f2(result.sop?.targetT1)} (+5.0%)`,
      `  · 主升目标位：¥${f2(result.sop?.targetT2)} (+10.0%)`,
      `  · 观察周期：${result.sop?.maxDays || 5} 个交易日`,
      `  · 操盘指引：${result.sop?.advice || '分时回踩均价线做T低吸，冲高分批减半倒T'}`,
    ];
    copyPlain(lines.join('\n'), `✓ 已复制 ${result.name} 的起爆体检报告`);
  }, []);

  const handleAddCustomMapping = () => {
    const syms = draftUsSym
      .split(/[\s,，;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const kws = draftKeywords
      .split(/[\s,，;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!syms.length || !kws.length) {
      toastErr('请填写至少一个美股代码（如 NVDA）与 A股板块关键词（如 CPO）');
      return;
    }
    const nextItem = {
      themeId: `custom_${Date.now()}`,
      themeName: draftTheme.trim() || `${syms[0]}↔${kws[0]}`,
      usSymbols: syms.map((s) => ({ symbol: s, label: s })),
      boardKeywords: kws,
    };
    const nextList = [...customMappings, nextItem];
    setCustomMappings(nextList);
    try {
      localStorage.setItem(CUSTOM_US_KEY, JSON.stringify(nextList));
    } catch {}
    setDraftTheme('');
    setDraftUsSym('');
    setDraftKeywords('');
    toastOk(`已添加外盘映射：${nextItem.themeName}，正在重扫…`);
  };

  const handleRemoveCustomMapping = (themeId) => {
    const nextList = customMappings.filter((x) => x.themeId !== themeId);
    setCustomMappings(nextList);
    try {
      localStorage.setItem(CUSTOM_US_KEY, JSON.stringify(nextList));
    } catch {}
  };

  const handleCopyBrief = () => {
    if (!data) return;
    const bTop = breakoutItems.slice(0, 8);
    const dTop = dipItems.filter((x) => x.dipSignal !== 'FALLING_KNIFE').slice(0, 8);
    const lines = [
      `🚀【智策战情室 · 起爆挖掘双池简报】${data.date} (扫盘于 ${data.scannedAt})`,
      `一、横盘试盘起爆（月放量+周向上+日缩量，共 ${breakoutItems.length} 只 / 震仓 ${breakoutData.stats?.counts?.shakeoutReady || 0}）：`,
      ...bTop.map(
        (x) =>
          `  · ${x.name}(${x.code}) ${x.stageLabel} | 现价¥${f2(x.price)}(${fmtSignedPct(x.chg)}) | ${x.ztDate}板后${x.daysSinceZt}天 | 月量${x.monthVolRatio}x · 日缩至${x.volShrinkPct}% · ${x.ignitionScore}分`
      ),
      '',
      `二、深跌龙头抗跌抄底（板块回撤≥${sectorDdMin}% & 个股≥${stockDdMin}%，共 ${dipItems.length} 只 / 抗跌 ${dipData.stats?.counts?.antiDrop || 0}）：`,
      ...dTop.map(
        (x) =>
          `  · ${x.name}(${x.code}) ${x.dipLabel} | ${x.primaryBoardName}(回撤${x.worstBoardDd}%) · 股回撤${x.stockDrawdownPct}% | 量枯${x.volExhaustPct}% · ${x.dipScore}分`
      ),
    ];
    copyPlain(lines.join('\n'), '✓ 已复制起爆与抄底双池复盘简报');
  };

  const bCounts = breakoutData.stats?.counts || {};
  const dCounts = dipData.stats?.counts || {};

  return (
    <div className="ignition-page-wrap">
      {/* 顶部主题横幅 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 55%, #312e81 100%)',
          color: '#fff',
          borderRadius: '12px',
          padding: '15px 18px',
          marginBottom: '12px',
          boxShadow: '0 4px 16px rgba(15, 23, 42, 0.18)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '17px',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span>🚀 起爆点挖掘 · 多周期试盘潜伏 &amp; 深跌抗跌抄底</span>
              <span
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: 'rgba(56,189,248,0.2)',
                  border: '1px solid #38bdf8',
                  color: '#bae6fd',
                }}
              >
                交易日 {data?.date || '—'} · 更新 {data?.scannedAt || '扫描中'}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '5px', lineHeight: 1.5 }}>
              方向一抓<b>“近期涨停试水 → 月放量 + 周向上 + 日缩量 + 震仓收回”</b>主升前夜；
              方向二抓<b>“板块腰斩级出清 + 美股/板块利空砸不动”</b>龙头拐点；支持全池原位加入自选与跟踪。
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="mini"
              onClick={handleCopyBrief}
              style={{
                marginLeft: 0,
                background: 'rgba(56,189,248,0.18)',
                color: '#bae6fd',
                borderColor: '#38bdf8',
                padding: '5px 10px',
              }}
            >
              📋 复制双池简报
            </button>
            <button
              type="button"
              className="mini"
              disabled={loading}
              onClick={() => loadScan(true)}
              style={{
                marginLeft: 0,
                background: '#10b981',
                color: '#fff',
                borderColor: '#059669',
                padding: '5px 12px',
                fontWeight: 700,
              }}
            >
              {loading ? '⟳ 全市场漏斗扫盘中…' : '🔄 立即实时扫盘'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '12px 14px',
            marginBottom: '12px',
            background: '#fff1f0',
            border: '1px solid #ffa39e',
            borderRadius: '8px',
            color: '#cf1322',
            fontSize: '13px',
          }}
        >
          <b>扫盘失败：</b>
          {error}
        </div>
      )}

      {/* 方向切换主卡 + 搜索栏 */}
      <div className="ignition-subtab-bar">
        <div className="ignition-subtabs">
          <button
            type="button"
            className={`mini ${subTab === 'breakout' ? 'primary' : ''}`}
            onClick={() => setSubTab('breakout')}
            style={{ marginLeft: 0, padding: '6px 12px', fontSize: '12.5px', fontWeight: 800 }}
          >
            🔥 方向一：横盘试盘起爆 ({breakoutItems.length})
            {bCounts.shakeoutReady > 0 && (
              <span
                style={{
                  marginLeft: '5px',
                  padding: '1px 6px',
                  borderRadius: '99px',
                  background: '#fff1f0',
                  color: '#cf1322',
                  fontSize: '11px',
                }}
              >
                震仓 {bCounts.shakeoutReady}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`mini ${subTab === 'dip' ? 'primary' : ''}`}
            onClick={() => setSubTab('dip')}
            style={{ marginLeft: 0, padding: '6px 12px', fontSize: '12.5px', fontWeight: 800 }}
          >
            🛟 方向二：深跌龙头抄底 ({dipItems.length})
            {dCounts.antiDrop > 0 && (
              <span
                style={{
                  marginLeft: '5px',
                  padding: '1px 6px',
                  borderRadius: '99px',
                  background: '#dcfce7',
                  color: '#15803d',
                  fontSize: '11px',
                }}
              >
                抗跌 {dCounts.antiDrop}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`mini ${subTab === 'tracking' ? 'primary' : ''}`}
            onClick={() => setSubTab('tracking')}
            style={{ marginLeft: 0, padding: '6px 12px', fontSize: '12.5px', fontWeight: 800 }}
          >
            🎯 在轨跟踪池 ({trackedCodeSet.size || trackingItems.length})
            {trackingSummary.ignitedCount > 0 && (
              <span
                style={{
                  marginLeft: '5px',
                  padding: '1px 6px',
                  borderRadius: '99px',
                  background: '#ecfdf5',
                  color: '#047857',
                  fontSize: '11px',
                  fontWeight: 700,
                }}
              >
                起爆 {trackingSummary.ignitedCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`mini ${subTab === 'meme' ? 'primary' : ''}`}
            onClick={() => setSubTab('meme')}
            style={{
              marginLeft: 0,
              padding: '6px 12px',
              fontSize: '12.5px',
              fontWeight: 800,
              background:
                subTab === 'meme'
                  ? 'linear-gradient(135deg, #3730a3 0%, #1e1b4b 100%)'
                  : undefined,
              color: subTab === 'meme' ? '#fff' : undefined,
            }}
          >
            🔮 方向三：玄学模因与字辈共振
          </button>
        </div>

        {subTab !== 'meme' && (
          <input
            type="text"
            className="ignition-search-input"
            placeholder="搜代码 / 名称 / 板块…"
            value={searchKw}
            onChange={(e) => setSearchKw(e.target.value)}
          />
        )}
      </div>

      {/* ========================= 方向一：横盘试盘起爆 ========================= */}
      {subTab === 'breakout' && (
        <div>
          {/* 自选横盘标的·专属起爆成色体检台 */}
          <div
            style={{
              background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
              border: '1px solid #cbd5e1',
              borderRadius: '12px',
              padding: '14px 16px',
              marginBottom: '12px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                marginBottom: '10px',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: '14px',
                    fontWeight: 800,
                    color: '#0f172a',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>🔍 自选横盘标的 · 专属起爆成色体检</span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '1px 7px',
                      borderRadius: '99px',
                      background: '#e0e7ff',
                      color: '#4338ca',
                      fontWeight: 700,
                    }}
                  >
                    输入任意个股六维体检
                  </span>
                </span>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '3px' }}>
                  按「首板试盘 + 月放量 + 周向上 + 日缩量 + 均线震仓 + 底座防守」六维全景体检，并一键加入自选或跟踪。
                </div>
              </div>

              {/* 快速诊断预设标的 */}
              <div className="ignition-preset-strip">
                <span style={{ fontSize: '11px', color: 'var(--mute)', flexShrink: 0 }}>快速体检:</span>
                {[
                  ...pool.slice(0, 3).map((s) => ({ q: s.code, label: s.name })),
                  { q: '000417', label: '合百集团' },
                  { q: '002187', label: '广百股份' },
                  { q: '600000', label: '浦发银行' },
                ]
                  .filter((v, i, a) => a.findIndex((t) => t.q === v.q) === i)
                  .slice(0, 5)
                  .map((item) => (
                    <button
                      key={item.q}
                      type="button"
                      className="mini"
                      onClick={() => handleRunDiag(item.q)}
                      style={{
                        marginLeft: 0,
                        fontSize: '11px',
                        padding: '2px 8px',
                        background: '#fff',
                        border: '1px solid #cbd5e1',
                        flexShrink: 0,
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
              </div>
            </div>

            {/* 输入与诊断按钮 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 200px', maxWidth: '420px' }}>
                <input
                  type="text"
                  className="ignition-diag-input"
                  placeholder="输入股票代码 / 名称（如 000417 / 合百集团）"
                  value={diagQuery}
                  onChange={(e) => setDiagQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRunDiag();
                  }}
                />
              </div>
              <button
                type="button"
                className="mini primary"
                onClick={() => handleRunDiag()}
                disabled={diagLoading}
                style={{ marginLeft: 0, padding: '7px 16px', fontSize: '12.5px', fontWeight: 800, borderRadius: '7px' }}
              >
                {diagLoading ? '⏳ 正在深度体检…' : '🔍 开始起爆体检'}
              </button>
              {diagResult && (
                <button
                  type="button"
                  className="mini"
                  onClick={() => setDiagResult(null)}
                  style={{ marginLeft: 0, padding: '7px 10px', fontSize: '11.5px', color: 'var(--sub)' }}
                >
                  ✕ 收起
                </button>
              )}
            </div>

            {diagError && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: '#dc2626' }}>⚠️ {diagError}</div>
            )}

            {/* 诊断结果全息卡 */}
            {diagResult && (
              <div
                style={{
                  marginTop: '12px',
                  background: '#fff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  padding: '14px 16px',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.05)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px',
                    paddingBottom: '12px',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '18px', fontWeight: 900, color: '#0f172a' }}>
                        {diagResult.name}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: '14px', color: 'var(--mute)', fontWeight: 700 }}>
                        {diagResult.code}
                      </span>
                      <span
                        style={{
                          padding: '3px 10px',
                          borderRadius: '6px',
                          background: diagResult.badgeBg,
                          color: diagResult.badgeColor,
                          border: `1px solid ${diagResult.badgeBorder}`,
                          fontWeight: 800,
                          fontSize: '12px',
                        }}
                      >
                        {diagResult.stageLabel}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                        marginTop: '6px',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                      }}
                    >
                      <span>
                        现价: <b style={{ fontSize: '15px' }}>¥{f2(diagResult.price)}</b>
                      </span>
                      <span style={{ color: chgColor(diagResult.dayChg), fontWeight: 800 }}>
                        {fmtSignedPct(diagResult.dayChg)}
                      </span>
                      <span style={{ color: 'var(--sub)' }}>换手: {diagResult.turnover}%</span>
                      <span style={{ color: 'var(--sub)' }}>成交: {diagResult.amountYi}亿</span>
                      <span style={{ color: 'var(--sub)' }}>市值: {diagResult.mcapYi}亿</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: 'var(--mute)' }}>起爆综合评分</div>
                      <div
                        style={{
                          fontSize: '26px',
                          fontWeight: 900,
                          fontFamily: 'monospace',
                          color:
                            diagResult.ignitionScore >= 75
                              ? '#cf1322'
                              : diagResult.ignitionScore >= 60
                              ? '#b45309'
                              : '#64748b',
                        }}
                      >
                        {diagResult.ignitionScore}{' '}
                        <span style={{ fontSize: '12px', fontWeight: 500 }}>分</span>
                      </div>
                    </div>

                    <BoardStockActions
                      stock={diagResult}
                      inPoolCodes={inPoolCodes}
                      herdCodeSet={trackedCodeSet}
                      herdBusyCode={trackBusyCode}
                      onHerdAction={(act, st) =>
                        handleTrackAction(act, st, {
                          strategy: 'ignition',
                          subType: diagResult.stage,
                          verdict: diagResult.stageLabel,
                          price: diagResult.price,
                        })
                      }
                      onJumpHerd={() => setSubTab('tracking')}
                      onAddSingle={() =>
                        handleAddInPlace(diagResult.code, {
                          strategyTag: '起爆',
                          strategy: 'ignition',
                          refPrice: diagResult.price,
                          stopPrice: diagResult.sop?.defensePrice,
                          targetPrice: diagResult.sop?.targetT1,
                          targetPrice2: diagResult.sop?.targetT2,
                          stageLabel: diagResult.stageLabel,
                          advice: diagResult.sop?.advice,
                        })
                      }
                      onSelectStock={onSelectStock}
                      allowAllBoardsTrack
                      trackTitle="加入在轨跟踪池"
                      trackedTitle="已在在轨跟踪池，点击查看SOP详情"
                      extraActions={
                        <button
                          type="button"
                          className="board-act-btn score"
                          onClick={() => handleCopyDiagReport(diagResult)}
                          title="复制六维体检报告"
                        >
                          📋 复制报告
                        </button>
                      }
                    />
                  </div>
                </div>

                {diagResult.klinePatterns && (
                  <div style={{ marginTop: '10px' }}>
                    <KlinePatternBadges klinePatterns={diagResult.klinePatterns} variant="full" />
                  </div>
                )}

                <div
                  style={{
                    marginTop: '10px',
                    padding: '8px 12px',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: '#334155',
                  }}
                >
                  <b style={{ color: '#0f172a' }}>💡 智能诊断总评：</b>
                  {diagResult.stageTip}
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(235px, 1fr))',
                    gap: '10px',
                    marginTop: '12px',
                  }}
                >
                  {(diagResult.checklist || []).map((item) => {
                    const isPass = item.passed === true;
                    const isWarn = item.passed === 'warn';
                    const icon = isPass ? '✅' : isWarn ? '⚠️' : '❌';
                    const cardBorder = isPass ? '#86efac' : isWarn ? '#fde68a' : '#fecaca';
                    const cardBg = isPass ? '#f0fdf4' : isWarn ? '#fffbeb' : '#fef2f2';
                    const badgeCls = isPass ? '#15803d' : isWarn ? '#b45309' : '#dc2626';
                    return (
                      <div
                        key={item.id}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '8px',
                          background: cardBg,
                          border: `1px solid ${cardBorder}`,
                          fontSize: '11.5px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: '5px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span>{icon}</span>
                            <b style={{ color: '#0f172a', fontSize: '12px' }}>{item.title}</b>
                          </div>
                          <span style={{ fontWeight: 800, fontSize: '11px', color: badgeCls }}>
                            {item.badge}
                          </span>
                        </div>
                        <div
                          style={{
                            fontFamily: 'monospace',
                            fontWeight: 700,
                            fontSize: '12px',
                            color: '#1e293b',
                            marginBottom: '3px',
                          }}
                        >
                          {item.val}
                        </div>
                        <div style={{ fontSize: '11px', color: '#475569', lineHeight: 1.4 }}>
                          {item.detail}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: '12px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: '#fff7ed',
                    border: '1px solid #fed7aa',
                    fontSize: '11.5px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                      marginBottom: '6px',
                    }}
                  >
                    <span style={{ fontWeight: 800, color: '#9a3412', fontSize: '12px' }}>
                      🎯 专属实战操盘 SOP 预案：
                    </span>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '11px' }}>
                      <span>
                        买入参考 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.refPrice)}</b>
                      </span>
                      <span style={{ color: '#dc2626' }}>
                        🛡️ 防守线 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.defensePrice)}</b> (-4.5%)
                      </span>
                      <span style={{ color: '#15803d' }}>
                        🏹 倒T1 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.targetT1)}</b> (+5%)
                      </span>
                      <span style={{ color: '#b45309' }}>
                        🏁 目标2 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.targetT2)}</b> (+10%)
                      </span>
                    </div>
                  </div>
                  <div style={{ color: '#7c2d12', lineHeight: 1.45 }}>{diagResult.sop?.advice}</div>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
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
            }}
          >
            <div style={{ color: '#9a3412', lineHeight: 1.5 }}>
              <b>漏斗机制：</b>近 {lookbackDays} 日涨停种子 <b>{breakoutData.stats?.seedCount ?? '—'}</b> 只 → 日线缩量防守筛出{' '}
              <b>{breakoutData.stats?.dailyPassedCount ?? '—'}</b> 只 → 月放量(≥1.25x)+周向上共振{' '}
              <b>{breakoutItems.length}</b> 只。
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: 'pointer',
                  fontWeight: 700,
                  color: '#7c2d12',
                }}
              >
                <input
                  type="checkbox"
                  checked={includeCyb}
                  onChange={(e) => setIncludeCyb(e.target.checked)}
                />
                <span>含双创 (300/688)</span>
              </label>

              <select
                value={lookbackDays}
                onChange={(e) => setLookbackDays(Number(e.target.value))}
                style={{
                  padding: '4px 8px',
                  fontSize: '12px',
                  borderRadius: '6px',
                  border: '1px solid #fdba74',
                  background: '#fff',
                }}
              >
                <option value={10}>近10日涨停</option>
                <option value={20}>近20日涨停(默认)</option>
                <option value={30}>近30日涨停</option>
              </select>
            </div>
          </div>

          {/* 阶段分档过滤 */}
          <div className="ignition-filter-pills">
            {[
              { k: 'all', label: `全部 (${breakoutItems.length})` },
              { k: 'SHAKEOUT_READY', label: `🔥 震仓完成·待起爆 (${bCounts.shakeoutReady || 0})` },
              { k: 'CONVERGED_WAIT', label: `⏳ 均线粘合·缩量蓄势 (${bCounts.convergedWait || 0})` },
              { k: 'DIGESTING', label: `👀 试盘缩量消化 (${bCounts.digesting || 0})` },
              { k: 'PULLBACK_RISK', label: `⚠️ 急拉防回调 (${bCounts.pullbackRisk || 0})` },
            ].map((tab) => (
              <button
                key={tab.k}
                type="button"
                className={`mini ${stageFilter === tab.k ? 'primary' : ''}`}
                onClick={() => setStageFilter(tab.k)}
                style={{ marginLeft: 0 }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="ign-table-scroll">
            <div className="ign-breakout-inner">
              <div className="ign-breakout-header">
                <div>标的 / 现价 / 排雷</div>
                <div>状态分档与操盘提示</div>
                <div>试盘涨停 / 前置横盘</div>
                <div>月线放量 / 周线趋势</div>
                <div>日线缩量 / 均线粘合与震仓</div>
                <div>起爆分</div>
                <div style={{ textAlign: 'right' }}>快捷操作</div>
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
                    className={`ign-breakout-row ${idx % 2 === 1 ? 'is-alt' : ''}`}
                    style={{
                      borderBottom:
                        idx === filteredBreakout.length - 1 ? 'none' : '1px solid var(--line)',
                    }}
                  >
                    <div className="igr-col-ident">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '0 4px',
                            borderRadius: '3px',
                            background: bd.bg,
                            color: bd.color,
                            border: `1px solid ${bd.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {bd.text}
                        </span>
                        <b style={{ fontSize: '13.5px' }}>{item.name}</b>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>
                          {item.code}
                        </span>
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: '12px', marginTop: '3px' }}>
                        <b>¥{f2(item.price)}</b>{' '}
                        <span style={{ color: chgColor(item.chg), fontWeight: 700 }}>
                          {fmtSignedPct(item.chg)}
                        </span>
                      </div>
                      <div style={{ marginTop: '3px', display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--info-d)', fontSize: '10.5px', fontWeight: 600 }}>
                          {item.hybk}
                        </span>
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            background: rk.bg,
                            color: rk.color,
                            border: `1px solid ${rk.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {rk.text}
                        </span>
                      </div>
                    </div>

                    <div className="igr-col-stage">
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: '11px',
                          fontWeight: 800,
                          padding: '2px 7px',
                          borderRadius: '4px',
                          background: stStyle.bg,
                          color: stStyle.color,
                          border: `1px solid ${stStyle.border}`,
                        }}
                      >
                        {item.stageLabel}
                      </span>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '4px', lineHeight: 1.4 }}>
                        {item.stageTip}
                      </div>
                    </div>

                    <div className="igr-col-zt" style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        板日: <b>{item.ztDate}</b> ({item.daysSinceZt}天前)
                      </div>
                      <div>
                        距起点:{' '}
                        <b style={{ color: chgColor(item.distToStartPct) }}>
                          {fmtSignedPct(item.distToStartPct)}
                        </b>
                      </div>
                      <div style={{ color: 'var(--mute)' }}>板前振幅 {item.preBoxAmp}%</div>
                    </div>

                    <div className="igr-col-wm" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        月放量:{' '}
                        <b style={{ fontFamily: 'monospace', color: '#b45309' }}>{item.monthVolRatio}x</b>
                        {item.monthHighWarn ? (
                          <span style={{ color: '#dc2626', marginLeft: '4px' }}>(月高位)</span>
                        ) : (
                          ''
                        )}
                      </div>
                      <div style={{ color: '#15803d', fontWeight: 700 }}>{item.weeklyTrendDesc}</div>
                      <div style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>
                        月位 {item.monthPricePosPct}%
                      </div>
                    </div>

                    <div className="igr-col-daily" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        缩至板:{' '}
                        <b style={{ fontFamily: 'monospace', color: '#0369a1' }}>{item.volShrinkPct}%</b>{' '}
                        (连缩{item.shrinkStreak}日)
                      </div>
                      <div style={{ fontFamily: 'monospace' }}>
                        均线极差 {item.maSpreadPct}% · 乖离 {fmtSignedPct(item.biasMa5, 1)}
                      </div>
                      {item.shakeoutSignals && item.shakeoutSignals.length > 0 && (
                        <div style={{ color: '#cf1322', fontWeight: 700 }}>
                          ⚡ {item.shakeoutSignals.join(' + ')}
                        </div>
                      )}
                      <KlinePatternBadges klinePatterns={item.klinePatterns} variant="compact" />
                    </div>

                    <div
                      className="igr-col-score"
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '16px',
                        fontWeight: 800,
                        color: item.ignitionScore >= 80 ? '#cf1322' : '#0369a1',
                      }}
                    >
                      {item.ignitionScore}
                    </div>

                    <div className="igr-col-acts">
                      <BoardStockActions
                        stock={item}
                        inPoolCodes={inPoolCodes}
                        herdCodeSet={trackedCodeSet}
                        herdBusyCode={trackBusyCode}
                        onHerdAction={(act, st) =>
                          handleTrackAction(act, st, {
                            strategy: 'ignition',
                            subType: item.stage,
                            verdict: item.stageLabel,
                            price: item.price,
                            hybk: item.hybk,
                          })
                        }
                        onJumpHerd={() => setSubTab('tracking')}
                        onAddSingle={() =>
                          handleAddInPlace(item.code, {
                            strategyTag: '起爆',
                            strategy: 'ignition',
                            refPrice: item.price,
                            stopPrice: Number((item.price * 0.955).toFixed(2)),
                            targetPrice: Number((item.price * 1.05).toFixed(2)),
                            targetPrice2: Number((item.price * 1.1).toFixed(2)),
                            stageLabel: item.stageLabel,
                            stage: item.stage,
                            advice: item.stageTip,
                          })
                        }
                        onSelectStock={onSelectStock}
                        allowAllBoardsTrack
                        trackTitle="加入在轨跟踪池"
                        trackedTitle="已在在轨跟踪池，点击查看SOP详情"
                        compact
                      />
                    </div>

                    {/* 操盘SOP结构化预案条 */}
                    <div className="igr-sop-bar">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, color: '#0f172a' }}>🎯 操盘SOP：</span>
                        <span>
                          参考 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price)}</b>
                        </span>
                        <span style={{ color: '#dc2626' }}>
                          🛡️ 止损 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 0.955)}</b> (-4.5%)
                        </span>
                        <span style={{ color: '#15803d' }}>
                          🏹 倒T1 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 1.05)}</b> (+5%)
                        </span>
                        <span style={{ color: '#b45309' }}>
                          🏁 目标2 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 1.1)}</b> (+10%)
                        </span>
                      </div>
                      <div style={{ color: 'var(--sub)' }}>
                        {inT ? '✓ 已在自选池实时盯盘（点「✓已自选」直达作战台）' : '点「＋自选」原位入池不跳走，可连续多选'}
                      </div>
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
          <div
            style={{
              padding: '10px 14px',
              marginBottom: '12px',
              background: '#f8fafc',
              border: '1px solid var(--line)',
              borderRadius: '10px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <div style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--text)' }}>
                🌎 外盘映射风向标雷达（识别“美股关联板块大跌 → A股龙头抗跌”利空钝化日）
              </div>
              <button
                type="button"
                className="mini"
                onClick={() => setShowCustomEditor((v) => !v)}
                style={{ marginLeft: 0, fontSize: '11px' }}
              >
                {showCustomEditor ? '收起自定义映射 ▲' : '＋ 自定义美股↔A股映射 ▼'}
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '8px',
              }}
            >
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
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '4px',
                      }}
                    >
                      <b>{u.themeName}</b>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontWeight: 800,
                          color: chgColor(u.usMinChg),
                        }}
                      >
                        {isBig ? '🔥 大跌测试 ' : ''}
                        {fmtSignedPct(u.usMinChg)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '6px',
                        flexWrap: 'wrap',
                        fontSize: '10.5px',
                        color: 'var(--sub)',
                      }}
                    >
                      {(u.quotes || []).slice(0, 4).map((q) => (
                        <span key={q.secid} style={{ fontFamily: 'monospace' }}>
                          {q.label}{' '}
                          <b style={{ color: chgColor(q.chg) }}>{fmtSignedPct(q.chg)}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {showCustomEditor && (
              <div
                style={{
                  marginTop: '10px',
                  paddingTop: '10px',
                  borderTop: '1px dashed var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  fontSize: '12px',
                }}
              >
                <input
                  type="text"
                  placeholder="主题名(如: 航运)"
                  value={draftTheme}
                  onChange={(e) => setDraftTheme(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    width: '125px',
                  }}
                />
                <input
                  type="text"
                  placeholder="美股代码(如: ZIM,MATX)"
                  value={draftUsSym}
                  onChange={(e) => setDraftUsSym(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    width: '160px',
                  }}
                />
                <input
                  type="text"
                  placeholder="A股板块词(如: 航运,港口)"
                  value={draftKeywords}
                  onChange={(e) => setDraftKeywords(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    width: '165px',
                  }}
                />
                <button
                  type="button"
                  className="mini primary"
                  onClick={handleAddCustomMapping}
                  style={{ marginLeft: 0 }}
                >
                  添加并扫描
                </button>
                {customMappings.map((cm) => (
                  <span
                    key={cm.themeId}
                    style={{
                      padding: '2px 7px',
                      borderRadius: '99px',
                      background: '#e0f2fe',
                      color: '#0369a1',
                      fontSize: '11px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    {cm.themeName} ({cm.usSymbols.map((s) => s.symbol).join('/')})
                    <button
                      type="button"
                      onClick={() => handleRemoveCustomMapping(cm.themeId)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: '#0369a1',
                        fontWeight: 800,
                        minHeight: '18px',
                        padding: '0 2px',
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 2. 参数滑块与信号过滤 */}
          <div
            style={{
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
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <b>板块回撤 ≥ {sectorDdMin}%</b>
                <input
                  type="range"
                  min={20}
                  max={55}
                  step={5}
                  value={sectorDdMin}
                  onChange={(e) => setSectorDdMin(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <b>个股回撤 ≥ {stockDdMin}%</b>
                <input
                  type="range"
                  min={25}
                  max={65}
                  step={5}
                  value={stockDdMin}
                  onChange={(e) => setStockDdMin(Number(e.target.value))}
                />
              </label>
              <button
                type="button"
                className="mini"
                onClick={() => {
                  setSectorDdMin(50);
                  setStockDdMin(50);
                }}
                style={{ marginLeft: 0 }}
                title="严格卡板块与个股腰斩级回撤"
              >
                腰斩档(50%)
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => {
                  setSectorDdMin(30);
                  setStockDdMin(40);
                }}
                style={{ marginLeft: 0 }}
              >
                均衡默认(30/40%)
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={hideKnife}
                  onChange={(e) => setHideKnife(e.target.checked)}
                />
                <span>屏蔽放量下杀/公告雷</span>
              </label>
            </div>
          </div>

          {/* 深跌板块胶囊 & 信号切换 */}
          <div className="ignition-filter-pills">
            {[
              { k: 'all', label: `全部信号 (${dipItems.length})` },
              { k: 'ANTI_DROP_BOTTOM', label: `🟢 利空抗跌·底部试探 (${dCounts.antiDrop || 0})` },
              { k: 'SHRINK_WATCH', label: `🟡 深跌缩量·磨底观察 (${dCounts.shrinkWatch || 0})` },
              {
                k: 'DIGESTING_DROP',
                label: `⚪ 等待缩量 (${dipItems.filter((x) => x.dipSignal === 'DIGESTING_DROP').length})`,
              },
            ].map((t) => (
              <button
                key={t.k}
                type="button"
                className={`mini ${dipSignalFilter === t.k ? 'primary' : ''}`}
                onClick={() => setDipSignalFilter(t.k)}
                style={{ marginLeft: 0 }}
              >
                {t.label}
              </button>
            ))}

            {deepBoards.length > 0 && (
              <select
                value={selectedBoard}
                onChange={(e) => setSelectedBoard(e.target.value)}
                style={{
                  padding: '4px 8px',
                  fontSize: '12px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--surface2)',
                  maxWidth: '100%',
                }}
              >
                <option value="all">全部深跌板块 ({deepBoards.length})</option>
                {deepBoards.map((b) => (
                  <option key={b.bkCode} value={b.bkName}>
                    {b.bkName} (回撤 {b.boardDrawdownPct}% / 今日 {fmtSignedPct(b.chg)})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="ign-table-scroll">
            <div className="ign-dip-inner">
              <div className="ign-dip-header">
                <div>核心龙头 / 市值 / 排雷</div>
                <div>抄底信号与触发逻辑</div>
                <div>板块与个股回撤深度</div>
                <div>量能枯竭度</div>
                <div>今日对比(外盘/板块 vs 个股)</div>
                <div>抄底分</div>
                <div style={{ textAlign: 'right' }}>快捷操作</div>
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
                    className={`ign-dip-row ${idx % 2 === 1 ? 'is-alt' : ''}`}
                    style={{
                      borderBottom: idx === filteredDip.length - 1 ? 'none' : '1px solid var(--line)',
                    }}
                  >
                    <div className="igr-col-ident">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '0 4px',
                            borderRadius: '3px',
                            background: bd.bg,
                            color: bd.color,
                            border: `1px solid ${bd.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {bd.text}
                        </span>
                        <b style={{ fontSize: '13.5px' }}>{item.name}</b>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>
                          {item.code}
                        </span>
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: '12px', marginTop: '3px' }}>
                        <b>¥{f2(item.price)}</b>{' '}
                        <span style={{ color: chgColor(item.chg), fontWeight: 700 }}>
                          {fmtSignedPct(item.chg)}
                        </span>
                      </div>
                      <div style={{ marginTop: '3px', display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--mute)', fontSize: '10.5px', fontFamily: 'monospace' }}>
                          {item.mcapYi}亿
                        </span>
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            background: rk.bg,
                            color: rk.color,
                            border: `1px solid ${rk.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {rk.text}
                        </span>
                      </div>
                    </div>

                    <div className="igr-col-stage">
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: '11px',
                          fontWeight: 800,
                          padding: '2px 7px',
                          borderRadius: '4px',
                          background: ds.bg,
                          color: ds.color,
                          border: `1px solid ${ds.border}`,
                        }}
                      >
                        {item.dipLabel}
                      </span>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '4px', lineHeight: 1.4 }}>
                        {item.dipTip}
                      </div>
                      <KlinePatternBadges klinePatterns={item.klinePatterns} variant="compact" />
                    </div>

                    <div className="igr-col-zt" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        <b>{item.primaryBoardName}</b>:{' '}
                        <b style={{ fontFamily: 'monospace', color: '#15803d' }}>{item.worstBoardDd}%</b>
                      </div>
                      <div>
                        个股回撤:{' '}
                        <b style={{ fontFamily: 'monospace', color: '#15803d' }}>
                          {item.stockDrawdownPct}%
                        </b>
                      </div>
                      <div style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>
                        180日高 ¥{f2(item.high180)}
                      </div>
                    </div>

                    <div className="igr-col-wm" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        5日/峰值:{' '}
                        <b style={{ fontFamily: 'monospace', color: '#0369a1' }}>{item.volExhaustPct}%</b>
                      </div>
                      <div style={{ color: item.notNewLow ? '#15803d' : '#dc2626', fontWeight: 700 }}>
                        {item.notNewLow ? '✓ 未破近5日低' : '✗ 仍在破位新低'}
                      </div>
                    </div>

                    <div className="igr-col-daily" style={{ fontSize: '11px', fontFamily: 'monospace', lineHeight: 1.5 }}>
                      <div>
                        板块 {fmtSignedPct(item.worstBoardChg)} → 剪刀差{' '}
                        <b style={{ color: chgColor(item.sectorAlpha) }}>
                          {fmtSignedPct(item.sectorAlpha)}
                        </b>
                      </div>
                      {item.usShock ? (
                        <div>
                          外盘({item.usShock.worstLabel}) {fmtSignedPct(item.usShock.usMinChg)} → α{' '}
                          <b style={{ color: chgColor(item.usAlpha) }}>{fmtSignedPct(item.usAlpha)}</b>
                        </div>
                      ) : (
                        <div style={{ color: 'var(--mute)' }}>无外盘映射对比</div>
                      )}
                    </div>

                    <div
                      className="igr-col-score"
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '16px',
                        fontWeight: 800,
                        color: item.dipSignal === 'ANTI_DROP_BOTTOM' ? '#15803d' : '#475569',
                      }}
                    >
                      {item.dipScore}
                    </div>

                    <div className="igr-col-acts">
                      <BoardStockActions
                        stock={item}
                        inPoolCodes={inPoolCodes}
                        herdCodeSet={trackedCodeSet}
                        herdBusyCode={trackBusyCode}
                        onHerdAction={(act, st) =>
                          handleTrackAction(act, st, {
                            strategy: 'bottom',
                            subType: item.dipSignal,
                            verdict: item.dipLabel,
                            price: item.price,
                            hybk: item.primaryBoardName,
                          })
                        }
                        onJumpHerd={() => setSubTab('tracking')}
                        onAddSingle={() =>
                          handleAddInPlace(item.code, {
                            strategyTag: '抄底',
                            strategy: 'bottom',
                            refPrice: item.price,
                            stopPrice: Number((item.price * 0.94).toFixed(2)),
                            targetPrice: Number((item.price * 1.08).toFixed(2)),
                            targetPrice2: Number((item.price * 1.15).toFixed(2)),
                            dipLabel: item.dipLabel,
                            dipSignal: item.dipSignal,
                            advice: item.dipTip,
                          })
                        }
                        onSelectStock={onSelectStock}
                        allowAllBoardsTrack
                        trackTitle="加入在轨跟踪池"
                        trackedTitle="已在在轨跟踪池，点击查看SOP详情"
                        compact
                      />
                    </div>

                    <div
                      className="igr-sop-bar"
                      style={{ background: '#f0fdf4', borderColor: '#86efac' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, color: '#166534' }}>🛟 抄底SOP：</span>
                        <span>
                          建仓参考 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price)}</b>
                        </span>
                        <span style={{ color: '#dc2626' }}>
                          🛡️ 防守线 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 0.94)}</b> (-6%)
                        </span>
                        <span style={{ color: '#15803d' }}>
                          🏹 反弹目标 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 1.08)}</b> (+8%)
                        </span>
                      </div>
                      <div style={{ color: '#166534' }}>
                        {inT ? '✓ 已在自选池持续盯盘（点「✓已自选」直达作战台）' : '点「＋自选」原位入池不跳走，可连续多选'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================= 方向三：在轨跟踪池 & 操盘指引 ========================= */}
      {subTab === 'tracking' && (
        <div>
          <div
            style={{
              background: 'linear-gradient(135deg, #091e3a 0%, #0f3460 100%)',
              color: '#fff',
              borderRadius: '12px',
              padding: '15px 18px',
              marginBottom: '12px',
              boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px',
                marginBottom: '12px',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: '15px',
                    fontWeight: 800,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>🎯 挖掘标的在轨全生命周期跟踪池</span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '99px',
                      background: 'rgba(255,255,255,0.2)',
                    }}
                  >
                    起爆 · 抄底 · 字辈 · 尾盘统一汇入
                  </span>
                </div>
                <div
                  style={{
                    fontSize: '12px',
                    color: '#cbd5e1',
                    marginTop: '4px',
                    lineHeight: 1.55,
                    maxWidth: '960px',
                  }}
                >
                  全天候跟踪系统自动保全与你手动点击「📌跟踪」加入的所有标的（含主板与 300/688），动态计算累计盈亏与生命周期阶段，实时生成倒T止盈与止损防守 SOP。
                </div>
              </div>
              <button
                type="button"
                className="mini"
                onClick={() => handleRefreshTracking(false)}
                disabled={trackingRefreshing}
                style={{
                  marginLeft: 0,
                  background: 'rgba(255,255,255,0.15)',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.3)',
                  padding: '7px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  borderRadius: '8px',
                }}
              >
                {trackingRefreshing ? '⏳ 正在毫秒拉取行情…' : '⟳ 毫秒刷新现价与SOP'}
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))',
                gap: '8px',
                paddingTop: '12px',
                borderTop: '1px solid rgba(255,255,255,0.15)',
              }}
            >
              <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px 11px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>跟踪标的总数</div>
                <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '2px' }}>
                  {trackingSummary.totalCount || trackingItems.length}{' '}
                  <span style={{ fontSize: '11px', fontWeight: 400 }}>只</span>
                </div>
              </div>
              <div
                style={{
                  background: 'rgba(220, 38, 38, 0.15)',
                  borderRadius: '8px',
                  padding: '9px 11px',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                }}
              >
                <div style={{ fontSize: '11px', color: '#fca5a5' }}>🚀 放量起爆 / 大胜</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: '#fca5a5',
                    marginTop: '2px',
                  }}
                >
                  {trackingSummary.ignitedCount || 0}{' '}
                  <span style={{ fontSize: '11px', fontWeight: 400 }}>只</span>
                </div>
              </div>
              <div
                style={{
                  background: 'rgba(56, 189, 248, 0.12)',
                  borderRadius: '8px',
                  padding: '9px 11px',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                }}
              >
                <div style={{ fontSize: '11px', color: '#bae6fd' }}>⏳ 缩量蓄势中</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: '#bae6fd',
                    marginTop: '2px',
                  }}
                >
                  {trackingSummary.waitingCount || 0}{' '}
                  <span style={{ fontSize: '11px', fontWeight: 400 }}>只</span>
                </div>
              </div>
              <div
                style={{
                  background: 'rgba(148, 163, 184, 0.12)',
                  borderRadius: '8px',
                  padding: '9px 11px',
                  border: '1px solid rgba(148, 163, 184, 0.2)',
                }}
              >
                <div style={{ fontSize: '11px', color: '#cbd5e1' }}>🛑 触及防守线</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: '#e2e8f0',
                    marginTop: '2px',
                  }}
                >
                  {trackingSummary.stoppedCount || 0}{' '}
                  <span style={{ fontSize: '11px', fontWeight: 400 }}>只</span>
                </div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px 11px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>历史推荐胜率</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: (trackingSummary.winRate || 0) >= 50 ? '#86efac' : '#fde047',
                    marginTop: '2px',
                  }}
                >
                  {trackingSummary.winRate != null ? `${trackingSummary.winRate.toFixed(1)}%` : '—'}
                </div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px 11px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>平均持仓盈亏</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: (trackingSummary.avgGainPct || 0) >= 0 ? '#fca5a5' : '#86efac',
                    marginTop: '2px',
                  }}
                >
                  {fmtSignedPct(trackingSummary.avgGainPct)}
                </div>
              </div>
            </div>
          </div>

          <div className="ignition-filter-pills">
            {[
              { k: 'all', label: `全部标的 (${trackingItems.length})` },
              { k: 'IGNITED', label: `🚀 放量起爆 / 大胜 (${trackingSummary.ignitedCount || 0})` },
              { k: 'WAITING', label: `⏳ 缩量蓄势 (${trackingSummary.waitingCount || 0})` },
              { k: 'STOPPED', label: `🛑 触及防守 (${trackingSummary.stoppedCount || 0})` },
            ].map((tab) => (
              <button
                key={tab.k}
                type="button"
                className={`mini ${trackFilter === tab.k ? 'primary' : ''}`}
                onClick={() => setTrackFilter(tab.k)}
                style={{ marginLeft: 0 }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="ign-table-scroll">
            <div className="ign-track-inner">
              <div className="ign-track-header">
                <div>标的 / 板块</div>
                <div>入选基准 / 形态</div>
                <div>今日现价/涨跌</div>
                <div>累计收益率</div>
                <div>生命周期状态</div>
                <div>🎯 专属操盘 SOP 对策与行动指南</div>
                <div style={{ textAlign: 'right' }}>快捷操作</div>
              </div>

              {filteredTracking.length === 0 && (
                <div style={{ padding: '36px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px' }}>
                  当前分类下暂无在轨标的。你可在方向一/方向二/玄学共振或尾盘潜伏页点击「📌跟踪」手动加入。
                </div>
              )}

              {filteredTracking.map((item, idx) => {
                const bd = boardBadge(item.code);
                const sop = item.sop || {};
                return (
                  <div
                    key={item.id || item.code}
                    className={`ign-track-row ${idx % 2 === 1 ? 'is-alt' : ''}`}
                    style={{
                      borderBottom:
                        idx === filteredTracking.length - 1 ? 'none' : '1px solid var(--line)',
                    }}
                  >
                    <div className="itr-col-ident">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '0 4px',
                            borderRadius: '3px',
                            background: bd.bg,
                            color: bd.color,
                            border: `1px solid ${bd.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {bd.text}
                        </span>
                        <b style={{ fontSize: '13.5px' }}>{item.name}</b>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>
                          {item.code}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: '11px',
                          color: 'var(--sub)',
                          marginTop: '3px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span>{item.hybk}</span>
                        <span
                          style={{
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: '#f1f5f9',
                            color: '#475569',
                            fontSize: '10px',
                            fontWeight: 600,
                          }}
                        >
                          {item.strategyLabel || '在轨跟踪'}
                        </span>
                      </div>
                    </div>

                    <div className="itr-col-base" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div style={{ fontFamily: 'monospace', color: 'var(--mute)' }}>
                        {item.signalDate} 入选
                      </div>
                      <div style={{ fontWeight: 700, color: '#334155' }}>
                        {item.verdict || item.subType}
                      </div>
                      <div>
                        基准价: <b style={{ fontFamily: 'monospace' }}>¥{f2(item.refPrice)}</b>
                      </div>
                    </div>

                    <div className="itr-col-px" style={{ fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 800, fontSize: '13px' }}>¥{f2(item.curPrice)}</div>
                      <div style={{ color: chgColor(item.dayChg), fontWeight: 700 }}>
                        {fmtSignedPct(item.dayChg)}
                      </div>
                    </div>

                    <div className="itr-col-gain" style={{ fontFamily: 'monospace', lineHeight: 1.4 }}>
                      <div style={{ fontSize: '15px', fontWeight: 800, color: chgColor(item.gainPct) }}>
                        {fmtSignedPct(item.gainPct)}
                      </div>
                      <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>
                        高点 ¥{f2(item.high)}
                      </div>
                    </div>

                    <div className="itr-col-stage">
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: '11.5px',
                          fontWeight: 800,
                          padding: '3px 8px',
                          borderRadius: '6px',
                          background: item.stageBg || '#f1f5f9',
                          color: item.stageColor || '#334155',
                          border: `1px solid ${item.stageBorder || '#cbd5e1'}`,
                        }}
                      >
                        {item.stageDesc}
                      </span>
                    </div>

                    <div
                      className="itr-col-sop"
                      style={{
                        background:
                          item.trackStage === 'TARGET_REACHED'
                            ? '#fffbeb'
                            : item.trackStage === 'IGNITED'
                            ? '#fef2f2'
                            : item.trackStage === 'STOPPED'
                            ? '#f8fafc'
                            : '#f0f9ff',
                        border: `1px solid ${
                          item.trackStage === 'TARGET_REACHED'
                            ? '#fde68a'
                            : item.trackStage === 'IGNITED'
                            ? '#fecaca'
                            : item.trackStage === 'STOPPED'
                            ? '#e2e8f0'
                            : '#bae6fd'
                        }`,
                        borderRadius: '7px',
                        padding: '7px 9px',
                        fontSize: '11px',
                        lineHeight: 1.45,
                      }}
                    >
                      <div style={{ color: '#0f172a', fontWeight: 600 }}>
                        💡 {sop.advice || '根据日内分时均价线择机做T'}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: '8px',
                          flexWrap: 'wrap',
                          marginTop: '4px',
                          fontSize: '10.5px',
                          color: 'var(--sub)',
                        }}
                      >
                        <span>
                          🛡️ 防守:{' '}
                          <b style={{ fontFamily: 'monospace', color: '#dc2626' }}>
                            ¥{f2(sop.defensePrice)}
                          </b>
                        </span>
                        <span>
                          🏹 做T1:{' '}
                          <b style={{ fontFamily: 'monospace', color: '#15803d' }}>
                            ¥{f2(sop.targetT1)}
                          </b>
                        </span>
                        <span>
                          🏁 目标2:{' '}
                          <b style={{ fontFamily: 'monospace', color: '#b45309' }}>
                            ¥{f2(sop.targetT2)}
                          </b>
                        </span>
                      </div>
                    </div>

                    <div className="itr-col-acts">
                      <BoardStockActions
                        stock={{ ...item, price: item.curPrice }}
                        inPoolCodes={inPoolCodes}
                        showHerd={false}
                        onAddSingle={() =>
                          handleAddInPlace(item.code, {
                            strategyTag: item.strategyLabel?.includes('抄底')
                              ? '抄底'
                              : item.strategyLabel?.includes('尾盘')
                              ? '尾盘'
                              : '起爆',
                            strategy: item.strategy || 'ignition',
                            refPrice: item.refPrice,
                            stopPrice: sop.defensePrice,
                            targetPrice: sop.targetT1,
                            targetPrice2: sop.targetT2,
                            stageDesc: item.stageDesc,
                            advice: sop.advice,
                          })
                        }
                        onSelectStock={onSelectStock}
                        compact
                        extraActions={
                          <>
                            <button
                              type="button"
                              className="board-act-btn score"
                              onClick={() => handleCopySOP(item)}
                              title="复制操盘SOP指南到剪贴板"
                            >
                              📋
                            </button>
                            <button
                              type="button"
                              className="board-act-btn diag"
                              disabled={trackBusyCode === item.code}
                              onClick={() => handleTrackAction('remove', item)}
                              title="移出在轨跟踪池"
                            >
                              ✕移出
                            </button>
                          </>
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================= 方向三：玄学模因与字辈共振 ========================= */}
      {subTab === 'meme' && (
        <MemeRadarSection
          inPoolCodes={inPoolCodes}
          trackedCodeSet={trackedCodeSet}
          trackBusyCode={trackBusyCode}
          onTrackAction={(act, st, extra) =>
            handleTrackAction(act, st, {
              strategy: 'meme',
              ...(extra || {}),
            })
          }
          onJumpTracked={() => setSubTab('tracking')}
          onAddInPlace={handleAddInPlace}
          onSelectStock={onSelectStock}
          onJumpDiagnosis={onJumpDiagnosis}
        />
      )}
    </div>
  );
}
