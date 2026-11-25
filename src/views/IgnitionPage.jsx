'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  fetchIgnitionPool,
  fetchIgnitionTracking,
  fetchIgnitionDiagnose,
  postIgnitionTrackingAction,
  loadLocalTrackedCodes,
} from '../services/api.js';
import { f2, toastOk, toastErr, copyPlain } from '../services/utils.js';
import { getAShareMarketStatus } from '../services/calendar.js';
import MemeRadarSection from '../components/MemeRadarSection.jsx';
import KlinePatternBadges from '../components/KlinePatternBadges.jsx';
import { BoardStockActions } from '../components/board/boardShared.jsx';

const CUSTOM_US_KEY = 't-ignition-custom-us';
const FRESH_SCAN_MAX_AGE_SEC = 240;

function getScanAgeSeconds(scannedAtStr) {
  const s = String(scannedAtStr || '').trim();
  if (!s) return Infinity;
  const iso = `${s.replace(' ', 'T')}+08:00`;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, (Date.now() - ts) / 1000);
}

const STAGE_STYLE = {
  SHAKEOUT_READY: { bg: 'var(--up-bg)', color: 'var(--up)', border: 'var(--up-b)' },
  CONVERGED_WAIT: { bg: 'var(--warn-bg)', color: 'var(--warn-d)', border: 'var(--warn-b)' },
  DIGESTING: { bg: 'var(--info-bg)', color: 'var(--accent-d)', border: 'var(--info-b)' },
  PULLBACK_RISK: { bg: 'var(--surface)', color: 'var(--mute)', border: 'var(--line2)' },
};

const DIP_STYLE = {
  ANTI_DROP_BOTTOM: { bg: 'var(--down-bg)', color: 'var(--down-d)', border: 'var(--down-b)' },
  SHRINK_WATCH: { bg: 'var(--warn-bg)', color: 'var(--warn-d)', border: 'var(--warn-b)' },
  DIGESTING_DROP: { bg: 'var(--surface)', color: 'var(--sub)', border: 'var(--line2)' },
  FALLING_KNIFE: { bg: 'var(--up-bg)', color: 'var(--up-d)', border: 'var(--up-b)' },
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
  if (c.startsWith('30')) return { text: '创', bg: 'var(--accent-bg)', color: 'var(--accent-d)', border: 'var(--accent-b)' };
  if (c.startsWith('688')) return { text: '科', bg: 'var(--info-bg)', color: 'var(--info-d)', border: 'var(--info-b)' };
  return { text: '主', bg: 'var(--surface2)', color: 'var(--sub)', border: 'var(--line2)' };
}

function riskBadge(riskLevel) {
  if (riskLevel === '高风险') return { text: '高风险雷', bg: 'var(--up-bg)', color: '#dc2626', border: 'var(--up-b)' };
  if (riskLevel === '留意') return { text: '留意', bg: 'var(--warn-bg)', color: '#d97706', border: 'var(--warn-b)' };
  return { text: '排雷安全', bg: 'var(--down-bg)', color: 'var(--down-d)', border: 'var(--down-b)' };
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
  const [syncingLive, setSyncingLive] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const reqSeqRef = useRef(0);
  const dataRef = useRef(null);
  dataRef.current = data;

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
    async (forceRefresh = false, { silent = false } = {}) => {
      const seq = ++reqSeqRef.current;
      const hasVisibleItems =
        ((dataRef.current?.breakout?.items || []).length > 0) ||
        ((dataRef.current?.dipLeaders?.items || []).length > 0);

      if (forceRefresh) {
        if (!hasVisibleItems) setLoading(true);
        setSyncingLive(true);
        if (!silent) setError('');
        try {
          const t0 = Date.now();
          const res = await fetchIgnitionPool({
            includeCyb,
            lookbackDays,
            sectorDdMin,
            stockDdMin,
            customMappings,
            refresh: true,
            timeoutMs: 35000,
          });
          if (seq !== reqSeqRef.current) return;
          if (res && res.ok) {
            setData(res);
            if (!silent) {
              const sec = ((res.elapsedMs || Date.now() - t0) / 1000).toFixed(1);
              toastOk(`✓ 最新起爆挖掘扫盘完成（耗时 ${sec}s）`);
            }
          } else {
            throw new Error(res?.detail || '起爆挖掘扫盘返回异常');
          }
        } catch (err) {
          if (seq !== reqSeqRef.current) return;
          if (!silent || !hasVisibleItems) {
            setError(err?.message || '扫描请求失败，请确认后端 18765 已启动');
          }
        } finally {
          if (seq === reqSeqRef.current) {
            setLoading(false);
            setSyncingLive(false);
          }
        }
        return;
      }

      // 入页/切换参数双阶段加载：先毫秒级垫底快照防白屏，若非45秒内最新实盘扫描则立即自动后台拉新
      if (!hasVisibleItems) setLoading(true);
      setError('');
      let paintedSnapshot = hasVisibleItems;
      let alreadyFresh = false;

      try {
        const snapRes = await fetchIgnitionPool({
          includeCyb,
          lookbackDays,
          sectorDdMin,
          stockDdMin,
          customMappings,
          refresh: false,
          fastSnapshot: true,
          timeoutMs: 6500,
        });
        if (seq !== reqSeqRef.current) return;
        if (snapRes && snapRes.ok && !snapRes.emptySnapshot) {
          setData(snapRes);
          setLoading(false);
          paintedSnapshot = true;
          const ageSec = getScanAgeSeconds(snapRes.scannedAt);
          alreadyFresh = !snapRes.isSnapshot && !snapRes.needsLiveRefresh && ageSec <= FRESH_SCAN_MAX_AGE_SEC;
        }
      } catch {
        // 快照失败不阻断后续自动实时扫盘
      }

      if (seq !== reqSeqRef.current) return;
      if (alreadyFresh) {
        setLoading(false);
        setSyncingLive(false);
        return;
      }

      setSyncingLive(true);
      try {
        const liveRes = await fetchIgnitionPool({
          includeCyb,
          lookbackDays,
          sectorDdMin,
          stockDdMin,
          customMappings,
          refresh: true,
          timeoutMs: 35000,
        });
        if (seq !== reqSeqRef.current) return;
        if (liveRes && liveRes.ok) {
          setData(liveRes);
          setError('');
        } else if (!paintedSnapshot) {
          throw new Error(liveRes?.detail || '起爆挖掘扫盘返回异常');
        }
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        if (!paintedSnapshot) {
          setError(err?.message || '扫描请求失败，请确认后端 18765 已启动');
        }
      } finally {
        if (seq === reqSeqRef.current) {
          setLoading(false);
          setSyncingLive(false);
        }
      }
    },
    [includeCyb, lookbackDays, sectorDdMin, stockDdMin, customMappings]
  );

  useEffect(() => {
    loadScan(false);
  }, [loadScan]);

  // 切回浏览器标签页或盘中交易时段定时自动刷新最新起爆盘口
  useEffect(() => {
    const maybeAutoRefresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const ageSec = getScanAgeSeconds(dataRef.current?.scannedAt);
      if (ageSec > FRESH_SCAN_MAX_AGE_SEC) {
        loadScan(true, { silent: true });
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        maybeAutoRefresh();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    const timer = setInterval(() => {
      const st = getAShareMarketStatus();
      if (st?.isOpen) {
        maybeAutoRefresh();
      }
    }, 90000);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      clearInterval(timer);
    };
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
      if (stageFilter === 'DRAGON_4P') {
        if ((item.dragonStars || 0) < 4.0) return false;
      } else if (stageFilter === 'MAIN_THEME') {
        if (!item.isMainTheme) return false;
      } else if (stageFilter === 'RESILIENT') {
        if (!item.isResilient) return false;
      } else if (stageFilter === 'RIGHT_CONFIRMED') {
        if (!item.rightSideConfirm) return false;
      } else if (stageFilter !== 'all' && item.stage !== stageFilter) {
        return false;
      }
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        return (
          item.code.includes(q) ||
          String(item.name || '').toLowerCase().includes(q) ||
          String(item.hybk || '').toLowerCase().includes(q) ||
          String(item.mainThemeName || '').toLowerCase().includes(q)
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
  const bRegime = breakoutData.stats?.marketRegime || null;
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
                  background: 'var(--info-bg)',
                  border: '1px solid var(--info-b)',
                  color: 'var(--accent)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                交易日 {data?.date || '—'} · {data?.isSnapshot ? '快照现价已刷 · ' : ''}扫盘 {data?.scannedAt || '同步中'}
                {data?.elapsedMs ? ` (${(data.elapsedMs / 1000).toFixed(1)}s)` : ''}
              </span>
              {syncingLive && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: 'var(--warn-bg)',
                    border: '1px solid var(--warn-b)',
                    color: 'var(--warn)',
                    fontWeight: 700,
                  }}
                >
                  ⟳ 正在自动拉取最新盘口…
                </span>
              )}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '5px', lineHeight: 1.5 }}>
              方向一抓<b>“近期涨停试水 → 月放量 + 周向上 + 日缩量 + 震仓收回”</b>主升前夜；
              方向二抓<b>“板块腰斩级出清 + 美股/板块利空砸不动”</b>龙头拐点；入页自动同步最新盘口，支持原位加自选与跟踪。
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="mini"
              onClick={handleCopyBrief}
              style={{
                marginLeft: 0,
                background: 'var(--info-bg)',
                color: 'var(--accent)',
                borderColor: 'var(--info-b)',
                padding: '5px 10px',
              }}
            >
              📋 复制双池简报
            </button>
            <button
              type="button"
              className="mini"
              disabled={loading || syncingLive}
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
              {loading || syncingLive ? '⟳ 实时扫盘同步中…' : '🔄 立即实时扫盘'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '12px 14px',
            marginBottom: '12px',
            background: 'var(--up-bg)',
            border: '1px solid var(--up-b)',
            borderRadius: '8px',
            color: 'var(--up)',
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
                  background: 'var(--up-bg)',
                  color: 'var(--up)',
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
                  background: 'var(--down-bg)',
                  color: 'var(--down-d)',
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
                  background: 'var(--down-bg)',
                  color: 'var(--down-d)',
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
              background: 'var(--surface)',
              border: '1px solid var(--line2)',
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
                    color: 'var(--text)',
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
                      background: 'var(--info-bg)',
                      color: 'var(--info-d)',
                      fontWeight: 700,
                    }}
                  >
                    输入任意个股六维体检
                  </span>
                </span>
                <div style={{ fontSize: '11.5px', color: 'var(--mute)', marginTop: '3px' }}>
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
                        background: 'var(--card)',
                        border: '1px solid var(--line2)',
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
                  background: 'var(--card)',
                  border: '1px solid var(--line2)',
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
                      <span style={{ fontSize: '18px', fontWeight: 900, color: 'var(--text)' }}>
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
                      {diagResult.dragonStars != null && (
                        <span
                          style={{
                            padding: '3px 9px',
                            borderRadius: '6px',
                            background: diagResult.dragonStars >= 4.0 ? 'var(--warn-bg)' : 'var(--surface)',
                            color: diagResult.dragonStars >= 4.0 ? 'var(--warn-d)' : 'var(--sub)',
                            border: `1px solid ${diagResult.dragonStars >= 4.0 ? 'var(--warn-b)' : 'var(--line2)'}`,
                            fontWeight: 800,
                            fontSize: '12px',
                          }}
                          title={(diagResult.dragonDims || []).map((d) => `${d.label}:${d.star}★ (${d.desc})`).join(' ｜ ')}
                        >
                          {diagResult.dragonLabel || `${diagResult.dragonStars}★`} ({diagResult.dragonStars}★)
                        </span>
                      )}
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
                              ? 'var(--up)'
                              : diagResult.ignitionScore >= 60
                              ? 'var(--warn-d)'
                              : 'var(--mute)',
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
                        <>
                          {onJumpDiagnosis && (
                            <button
                              type="button"
                              className="board-act-btn diag"
                              onClick={() => onJumpDiagnosis(diagResult.code)}
                              title="跳转到全景诊股查看210日筹码峰并划定硬止损入池"
                            >
                              🩺 全景终审
                            </button>
                          )}
                          <button
                            type="button"
                            className="board-act-btn score"
                            onClick={() => handleCopyDiagReport(diagResult)}
                            title="复制六维体检报告"
                          >
                            📋 复制报告
                          </button>
                        </>
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
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: 'var(--sub)',
                  }}
                >
                  <b style={{ color: 'var(--text)' }}>💡 智能诊断总评：</b>
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
                    const cardBorder = isPass ? 'var(--down-b)' : isWarn ? 'var(--warn-b)' : 'var(--up-b)';
                    const cardBg = isPass ? 'var(--down-bg)' : isWarn ? 'var(--warn-bg)' : 'var(--up-bg)';
                    const badgeCls = isPass ? 'var(--down-d)' : isWarn ? 'var(--warn-d)' : '#dc2626';
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
                            <b style={{ color: 'var(--text)', fontSize: '12px' }}>{item.title}</b>
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
                            color: 'var(--text)',
                            marginBottom: '3px',
                          }}
                        >
                          {item.val}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--sub)', lineHeight: 1.4 }}>
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
                    background: 'var(--warn-bg)',
                    border: '1px solid var(--warn-b)',
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
                      <span style={{ color: 'var(--down-d)' }}>
                        🏹 倒T1 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.targetT1)}</b> (+5%)
                      </span>
                      <span style={{ color: 'var(--warn-d)' }}>
                        🏁 目标2 <b style={{ fontFamily: 'monospace' }}>¥{f2(diagResult.sop?.targetT2)}</b> (+10%)
                      </span>
                    </div>
                  </div>
                  <div style={{ color: '#7c2d12', lineHeight: 1.45 }}>{diagResult.sop?.advice}</div>
                </div>
              </div>
            )}
          </div>

          {bRegime && (
            <div
              style={{
                padding: '10px 14px',
                marginBottom: '10px',
                background:
                  bRegime.mode === 'BEAR_STRICT'
                    ? 'var(--down-bg)'
                    : bRegime.mode === 'RANGE_SELECTIVE'
                    ? 'var(--info-bg)'
                    : 'var(--up-bg)',
                border: `1px solid ${
                  bRegime.mode === 'BEAR_STRICT'
                    ? 'var(--down-b)'
                    : bRegime.mode === 'RANGE_SELECTIVE'
                    ? 'var(--info-b)'
                    : 'var(--up-b)'
                }`,
                borderRadius: '10px',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
              }}
            >
              <div style={{ flex: '1 1 520px', lineHeight: 1.55 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <b
                    style={{
                      color:
                        bRegime.mode === 'BEAR_STRICT'
                          ? 'var(--down-d)'
                          : bRegime.mode === 'RANGE_SELECTIVE'
                          ? 'var(--info-d)'
                          : 'var(--up)',
                      fontSize: '12.5px',
                    }}
                  >
                    {bRegime.label}
                  </b>
                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      background: 'var(--card)',
                      border: '1px solid var(--line2)',
                      color: 'var(--sub)',
                    }}
                  >
                    上证 {bRegime.indexStructureLabel || '—'} · 今日 {fmtSignedPct(bRegime.shChg1d)} · 5日 {fmtSignedPct(bRegime.shChg5d)}
                  </span>
                  {(bRegime.filteredOutCount || 0) > 0 && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '1px 7px',
                        borderRadius: '99px',
                        background: 'var(--card)',
                        border: '1px solid var(--line2)',
                        color: 'var(--text)',
                      }}
                    >
                      🧹 已剔除跟跌杂毛 {bRegime.filteredOutCount} 只
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--sub)', marginTop: '3px' }}>{bRegime.advice}</div>
              </div>

              {bRegime.mode === 'BEAR_STRICT' && (
                <button
                  type="button"
                  className="mini"
                  onClick={() => setSubTab('dip')}
                  style={{
                    marginLeft: 0,
                    fontWeight: 800,
                    background: 'var(--card)',
                    color: 'var(--down-d)',
                    border: '1px solid var(--down-b)',
                    padding: '5px 10px',
                  }}
                >
                  🛟 切看方向二：深跌龙头抗跌 →
                </button>
              )}
            </div>
          )}

          <div
            style={{
              padding: '10px 14px',
              marginBottom: '12px',
              background: 'var(--warn-bg)',
              border: '1px solid var(--warn-b)',
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
              <b>{breakoutData.stats?.dailyPassedCount ?? '—'}</b> 只 → 月放量(≥1.25x)+周向上初筛{' '}
              <b>{breakoutData.stats?.rawQualifiedCount ?? breakoutItems.length}</b> 只
              {(breakoutData.stats?.filteredOutCount || 0) > 0 && (
                <>
                  {' '}→ 天时抗跌硬筛保留 <b>{breakoutItems.length}</b> 只（剔除 {breakoutData.stats.filteredOutCount} 只跟跌杂毛）
                </>
              )}
              。
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
                  border: '1px solid var(--warn-b)',
                  background: 'var(--card)',
                }}
              >
                <option value={10}>近10日涨停</option>
                <option value={20}>近20日涨停(默认)</option>
                <option value={30}>近30日涨停</option>
              </select>
            </div>
          </div>

          {/* 五星游龙、逆势抗跌与右侧确认分档过滤 */}
          <div className="ignition-filter-pills">
            {[
              { k: 'all', label: `全部 (${breakoutItems.length})` },
              {
                k: 'RESILIENT',
                label: `🛡️ 逆势抗跌活口 (${bCounts.resilientCount ?? breakoutItems.filter((x) => x.isResilient).length})`,
              },
              {
                k: 'RIGHT_CONFIRMED',
                label: `✅ 右侧阳线确认 (${bCounts.rightConfirmedCount ?? breakoutItems.filter((x) => x.rightSideConfirm).length})`,
              },
              {
                k: 'DRAGON_4P',
                label: `🐉 五星/准游龙 ≥4★ (${bCounts.fourPlusDragon || breakoutItems.filter((x) => (x.dragonStars || 0) >= 4).length})`,
              },
              {
                k: 'MAIN_THEME',
                label: `🎯 热点主线共振 (${bCounts.mainThemeResonance || breakoutItems.filter((x) => x.isMainTheme).length})`,
              },
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
                <div style={{ padding: '28px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px', lineHeight: 1.6 }}>
                  {bRegime?.mode === 'BEAR_STRICT' ? (
                    <>
                      🛡️ 当前上证处于下跌结构/退潮期，已开启<b>逆势严选宁缺毋滥过滤</b>
                      {bRegime.filteredOutCount > 0 ? `（已自动剔除 ${bRegime.filteredOutCount} 只跟跌杂毛）` : ''}。
                      当下暂无同时满足「站稳20日线 + 5日显著跑赢大盘 + 极致缩量防守」的活口，建议空仓观望或切换至「方向二：深跌龙头抄底」。
                    </>
                  ) : (
                    '当前筛选条件下暂无符合「近期涨停 + 月放量 + 周向上 + 日缩量」标的，可尝试切换分档或放宽板块范围。'
                  )}
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
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
                        {item.dragonStars != null && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 800,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: item.dragonStars >= 4.0 ? 'var(--warn-bg)' : 'var(--surface)',
                              color: item.dragonStars >= 4.0 ? 'var(--warn-d)' : 'var(--sub)',
                              border: `1px solid ${item.dragonStars >= 4.0 ? 'var(--warn-b)' : 'var(--line2)'}`,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                            title={(item.dragonDims || []).map((d) => `${d.label}:${d.star}★ (${d.desc})`).join(' ｜ ')}
                          >
                            {item.dragonStars >= 4.5 ? '🐉 五星游龙' : item.dragonStars >= 4.0 ? '⭐ 四星游龙' : `${item.dragonStars}★`} {item.dragonStars}★
                          </span>
                        )}
                        {item.isMainTheme && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 800,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'var(--up-bg)',
                              color: 'var(--up)',
                              border: '1px solid var(--up-b)',
                            }}
                            title={`命中热点主线：${item.mainThemeName} (${item.mainThemeStageLabel || ''})`}
                          >
                            🎯 主线·{item.mainThemeName}
                          </span>
                        )}
                        {item.rs5d != null && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 800,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              fontFamily: 'monospace',
                              background: item.isResilient ? 'var(--down-bg)' : 'var(--surface)',
                              color: item.isResilient ? 'var(--down-d)' : chgColor(item.rs5d),
                              border: `1px solid ${item.isResilient ? 'var(--down-b)' : 'var(--line2)'}`,
                            }}
                            title={`近5日相对上证超额收益 ${fmtSignedPct(item.rs5d, 1)} ｜ 今日超额 ${fmtSignedPct(item.rs1d, 1)}`}
                          >
                            {item.isResilient ? '🛡️ 抗跌RS ' : 'RS '}
                            {fmtSignedPct(item.rs5d, 1)}
                          </span>
                        )}
                        {item.entryModeLabel && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 800,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: item.rightSideConfirm ? 'var(--up-bg)' : 'var(--surface2)',
                              color: item.rightSideConfirm ? 'var(--up)' : 'var(--sub)',
                              border: `1px solid ${item.rightSideConfirm ? 'var(--up-b)' : 'var(--line2)'}`,
                            }}
                          >
                            {item.entryModeLabel}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '4px', lineHeight: 1.4 }}>
                        {item.stageTip}
                        {item.conc90 ? ` · 90%筹码集中度 ${item.conc90}%` : ''}
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
                        <b style={{ fontFamily: 'monospace', color: 'var(--warn-d)' }}>{item.monthVolRatio}x</b>
                        {item.monthHighWarn ? (
                          <span style={{ color: '#dc2626', marginLeft: '4px' }}>(月高位)</span>
                        ) : (
                          ''
                        )}
                      </div>
                      <div style={{ color: 'var(--down-d)', fontWeight: 700 }}>{item.weeklyTrendDesc}</div>
                      <div style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>
                        月位 {item.monthPricePosPct}%
                      </div>
                    </div>

                    <div className="igr-col-daily" style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <div>
                        缩至板:{' '}
                        <b style={{ fontFamily: 'monospace', color: 'var(--accent-d)' }}>{item.volShrinkPct}%</b>{' '}
                        (连缩{item.shrinkStreak}日)
                      </div>
                      <div style={{ fontFamily: 'monospace' }}>
                        均线极差 {item.maSpreadPct}% · 乖离 {fmtSignedPct(item.biasMa5, 1)}
                      </div>
                      {item.shakeoutSignals && item.shakeoutSignals.length > 0 && (
                        <div style={{ color: 'var(--up)', fontWeight: 700 }}>
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
                        color: item.ignitionScore >= 80 ? 'var(--up)' : 'var(--accent-d)',
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
                            strategyTag: item.dragonStars >= 4.0 ? `游龙${item.dragonStars}★` : '起爆',
                            strategy: 'ignition',
                            dragonStars: item.dragonStars,
                            isMainTheme: item.isMainTheme,
                            mainThemeName: item.mainThemeName,
                            refPrice: item.price,
                            stopPrice: Number((item.supportFloor > 0 ? Math.max(item.supportFloor * 0.985, item.price * 0.945) : item.price * 0.955).toFixed(2)),
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
                        <span style={{ fontWeight: 700, color: 'var(--text)' }}>🎯 操盘SOP：</span>
                        <span>
                          参考 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price)}</b>
                        </span>
                        <span style={{ color: '#dc2626' }}>
                          🛡️ 止损 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 0.955)}</b> (-4.5%)
                        </span>
                        <span style={{ color: 'var(--down-d)' }}>
                          🏹 倒T1 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 1.05)}</b> (+5%)
                        </span>
                        <span style={{ color: 'var(--warn-d)' }}>
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
              background: 'var(--surface)',
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
                      background: isBig ? 'var(--up-bg)' : isMod ? 'var(--warn-bg)' : 'var(--card)',
                      border: `1px solid ${isBig ? 'var(--up-b)' : isMod ? 'var(--warn-b)' : 'var(--line)'}`,
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
                      background: 'var(--info-bg)',
                      color: 'var(--accent-d)',
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
                        color: 'var(--accent-d)',
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
              background: 'var(--down-bg)',
              border: '1px solid var(--down-b)',
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
                        <b style={{ fontFamily: 'monospace', color: 'var(--down-d)' }}>{item.worstBoardDd}%</b>
                      </div>
                      <div>
                        个股回撤:{' '}
                        <b style={{ fontFamily: 'monospace', color: 'var(--down-d)' }}>
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
                        <b style={{ fontFamily: 'monospace', color: 'var(--accent-d)' }}>{item.volExhaustPct}%</b>
                      </div>
                      <div style={{ color: item.notNewLow ? 'var(--down-d)' : '#dc2626', fontWeight: 700 }}>
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
                        color: item.dipSignal === 'ANTI_DROP_BOTTOM' ? 'var(--down-d)' : 'var(--sub)',
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
                      style={{ background: 'var(--down-bg)', borderColor: 'var(--down-b)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, color: 'var(--down-d)' }}>🛟 抄底SOP：</span>
                        <span>
                          建仓参考 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price)}</b>
                        </span>
                        <span style={{ color: '#dc2626' }}>
                          🛡️ 防守线 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 0.94)}</b> (-6%)
                        </span>
                        <span style={{ color: 'var(--down-d)' }}>
                          🏹 反弹目标 <b style={{ fontFamily: 'monospace' }}>¥{f2(item.price * 1.08)}</b> (+8%)
                        </span>
                      </div>
                      <div style={{ color: 'var(--down-d)' }}>
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
                    color: 'var(--line2)',
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
                <div style={{ fontSize: '11px', color: 'var(--up-b)' }}>🚀 放量起爆 / 大胜</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: 'var(--up-b)',
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
                <div style={{ fontSize: '11px', color: 'var(--info-b)' }}>⏳ 缩量蓄势中</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: 'var(--info-b)',
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
                <div style={{ fontSize: '11px', color: 'var(--line2)' }}>🛑 触及防守线</div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: 'var(--line)',
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
                    color: (trackingSummary.winRate || 0) >= 50 ? 'var(--down-b)' : '#fde047',
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
                    color: (trackingSummary.avgGainPct || 0) >= 0 ? 'var(--up-b)' : 'var(--down-b)',
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
                            background: 'var(--surface2)',
                            color: 'var(--sub)',
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
                      <div style={{ fontWeight: 700, color: 'var(--sub)' }}>
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
                          background: item.stageBg || 'var(--surface2)',
                          color: item.stageColor || 'var(--sub)',
                          border: `1px solid ${item.stageBorder || 'var(--line2)'}`,
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
                            ? 'var(--warn-bg)'
                            : item.trackStage === 'IGNITED'
                            ? 'var(--up-bg)'
                            : item.trackStage === 'STOPPED'
                            ? 'var(--surface)'
                            : 'var(--info-bg)',
                        border: `1px solid ${
                          item.trackStage === 'TARGET_REACHED'
                            ? 'var(--warn-b)'
                            : item.trackStage === 'IGNITED'
                            ? 'var(--up-b)'
                            : item.trackStage === 'STOPPED'
                            ? 'var(--line)'
                            : 'var(--info-b)'
                        }`,
                        borderRadius: '7px',
                        padding: '7px 9px',
                        fontSize: '11px',
                        lineHeight: 1.45,
                      }}
                    >
                      <div style={{ color: 'var(--text)', fontWeight: 600 }}>
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
                          <b style={{ fontFamily: 'monospace', color: 'var(--down-d)' }}>
                            ¥{f2(sop.targetT1)}
                          </b>
                        </span>
                        <span>
                          🏁 目标2:{' '}
                          <b style={{ fontFamily: 'monospace', color: 'var(--warn-d)' }}>
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
