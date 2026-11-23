'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchLimitUpPool, postHerdAction } from '../services/api.js';
import { f2, money$, todayStr, toastOk, toastWarn, toastErr, copyPlain } from '../services/utils.js';
import MarketSentimentBar from '../components/MarketSentimentBar.jsx';
import { DEFAULT_MYSTIC_ROOTS, buildDailyReviewBrief, BoardStockActions } from '../components/board/boardShared.jsx';
import StrongPoolPanel from '../components/board/StrongPoolPanel.jsx';
import HerdPoolPanel from '../components/board/HerdPoolPanel.jsx';
import MainThemesPanel from '../components/board/MainThemesPanel.jsx';

function formatLocalIsoDate() {
  return todayStr();
}

export default function BoardPage({
  pool,
  onAddStock,
  onSelectStock,
  onJumpIgnition,
  onTabChange,
}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [boardDate, setBoardDate] = useState(''); // '' = 今日实时, 'YYYY-MM-DD' = 历史复盘
  const [filterTier, setFilterTier] = useState('all');
  // 'all' | 'themes' | 'strong' | 'herd' | 'rushing' | 'auction' | 'rush' | 'reseal' | 'high' | 'board3' | 'board2' | 'board1' | 'late' | 'locked' | 'zb'
  const [strongSelectedTags, setStrongSelectedTags] = useState([]);
  const [strongMinTags, setStrongMinTags] = useState(2);
  const [strongOnlyNonZt, setStrongOnlyNonZt] = useState(false);
  const [strongViewMode, setStrongViewMode] = useState('compact'); // 'compact' | 'bySector' | 'card'
  const [strongSort, setStrongSort] = useState('resonance');
  const [strongSortAsc, setStrongSortAsc] = useState(false);
  const [herdSort, setHerdSort] = useState('health');
  const [ladderViewMode, setLadderViewMode] = useState('card'); // 'card' | 'table'
  const [herdHealthFilter, setHerdHealthFilter] = useState('all');
  const [herdBusyCode, setHerdBusyCode] = useState('');
  const [selectedTheme, setSelectedTheme] = useState('all');
  const [searchKw, setSearchKw] = useState('');
  const [sortBy, setSortBy] = useState('ladder');
  const [onlyMainboard, setOnlyMainboard] = useState(true);
  const [mysticRoots, setMysticRoots] = useState(() => {
    try {
      return localStorage.getItem('t-mystic-roots') || DEFAULT_MYSTIC_ROOTS;
    } catch {
      return DEFAULT_MYSTIC_ROOTS;
    }
  });
  const [mysticDraft, setMysticDraft] = useState(() => {
    try {
      return localStorage.getItem('t-mystic-roots') || DEFAULT_MYSTIC_ROOTS;
    } catch {
      return DEFAULT_MYSTIC_ROOTS;
    }
  });
  const [showMysticConfig, setShowMysticConfig] = useState(false);
  const [strongDetailItem, setStrongDetailItem] = useState(null);

  const localTodayIso = useMemo(() => formatLocalIsoDate(), []);
  const apiDateParam = useMemo(() => (boardDate ? boardDate.replace(/-/g, '') : null), [boardDate]);
  const isHistoryReplay = Boolean(apiDateParam) || Boolean(data?.isHistory);

  const inPoolCodes = useMemo(() => {
    return new Set((pool || []).map(s => String(s.code).padStart(6, '0')));
  }, [pool]);

  const loadData = useCallback(async (isSilent = false, overrideRoots = null, overrideDate = undefined) => {
    try {
      if (!isSilent) setLoading(true);
      setError(null);
      const rootsToUse = overrideRoots !== null ? overrideRoots : mysticRoots;
      const dateToUse = overrideDate !== undefined ? overrideDate : apiDateParam;
      const res = await fetchLimitUpPool(dateToUse, rootsToUse);
      if (res && res.ok) {
        setData(res);
      } else {
        throw new Error(res?.detail || '获取连板池数据失败');
      }
    } catch (err) {
      console.warn('[BoardPage Error]', err);
      setError(err.message || '获取连板天梯数据异常，请确保后端服务正常运行');
    } finally {
      setLoading(false);
    }
  }, [mysticRoots, apiDateParam]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 仅非历史复盘模式下每 30 秒自动轮询刷新
  useEffect(() => {
    if (!autoRefresh || isHistoryReplay) return undefined;
    const timer = setInterval(() => {
      loadData(true);
    }, 30000);
    return () => clearInterval(timer);
  }, [autoRefresh, isHistoryReplay, loadData]);

  const allowBoardStock = useCallback((x) => {
    const c = String(x.code || '');
    if (c.startsWith('30')) return false;
    if (onlyMainboard && (c.startsWith('68') || c.startsWith('8') || c.startsWith('4') || c.startsWith('92'))) {
      return false;
    }
    return true;
  }, [onlyMainboard]);

  const isMainboardOnly = useCallback((x) => {
    const c = String(x.code || '');
    return c.startsWith('00') || c.startsWith('60');
  }, []);

  const allItems = useMemo(() => (data?.items || []).filter(allowBoardStock), [data, allowBoardStock]);
  const rushingPool = useMemo(() => (data?.rushingPool || []).filter(allowBoardStock), [data, allowBoardStock]);
  const zbPool = useMemo(() => (data?.zbPool || []).filter(allowBoardStock), [data, allowBoardStock]);
  const strongPool = useMemo(() => (data?.strongPool || []).filter(isMainboardOnly), [data, isMainboardOnly]);
  const herdPool = useMemo(() => (data?.herdPool || []).filter(isMainboardOnly), [data, isMainboardOnly]);
  const evictedPool = useMemo(() => (data?.evictedPool || []).filter(isMainboardOnly), [data, isMainboardOnly]);
  const mainThemes = useMemo(() => data?.mainThemes || { marketOverview: {}, themes: [] }, [data]);
  const mysticClusters = useMemo(() => data?.mysticClusters || [], [data]);
  const herdCodeSet = useMemo(() => new Set(herdPool.map(x => x.code)), [herdPool]);
  const strongEliteCount = useMemo(() => strongPool.filter(x => (x.tagCount || x.tags?.length || 0) >= 3).length, [strongPool]);
  const strongMulti2Count = useMemo(() => strongPool.filter(x => (x.tagCount || x.tags?.length || 0) >= 2).length, [strongPool]);

  // 做T自选池持仓风险 / 涨停 / 抱团异动联动扫描
  const poolAlerts = useMemo(() => {
    if (isHistoryReplay || !pool || pool.length === 0) return [];
    const alerts = [];
    const zbMap = new Map(zbPool.map(x => [x.code, x]));
    const herdMap = new Map(herdPool.map(x => [x.code, x]));
    const ztMap = new Map(allItems.map(x => [x.code, x]));

    pool.forEach(s => {
      const c6 = String(s.code || '').padStart(6, '0');
      const zb = zbMap.get(c6);
      if (zb) {
        alerts.push({
          code: c6,
          name: zb.name || s.name,
          kind: 'zb',
          label: `💥 曾涨停炸板 (回落 ${Number(zb.dropFromTop || 0).toFixed(1)}%)`,
          bg: '#fff1f0',
          color: '#cf1322',
          border: '#ffa39e',
          targetTab: 'zb',
        });
        return;
      }
      const hd = herdMap.get(c6);
      if (hd && hd.healthStatus === 'warning') {
        alerts.push({
          code: c6,
          name: hd.name || s.name,
          kind: 'warn',
          label: `🟡 ${hd.healthLabel || '抱团黄牌观察'} (${Number(hd.chg || 0).toFixed(1)}%)`,
          bg: '#fffbeb',
          color: '#b45309',
          border: '#fcd34d',
          targetTab: 'herd',
        });
        return;
      }
      const zt = ztMap.get(c6);
      if (zt) {
        alerts.push({
          code: c6,
          name: zt.name || s.name,
          kind: 'zt',
          label: `🔥 今日封死${zt.statTag} (${zt.fbt})`,
          bg: '#f0fdf4',
          color: '#15803d',
          border: '#86efac',
          targetTab: 'all',
        });
      }
    });
    return alerts;
  }, [isHistoryReplay, pool, zbPool, herdPool, allItems]);

  const toggleStrongTag = useCallback((tagKey) => {
    setStrongSelectedTags(prev => (prev.includes(tagKey) ? prev.filter(k => k !== tagKey) : [...prev, tagKey]));
  }, []);

  const toggleStrongSort = useCallback((key) => {
    setStrongSort(prev => {
      if (prev === key) {
        setStrongSortAsc(a => !a);
        return prev;
      }
      setStrongSortAsc(key === 'fbt');
      return key;
    });
  }, []);

  const handleSaveMysticRoots = useCallback(async (valToSave) => {
    const cleaned = String(valToSave ?? mysticDraft).trim() || DEFAULT_MYSTIC_ROOTS;
    setMysticDraft(cleaned);
    setMysticRoots(cleaned);
    try {
      localStorage.setItem('t-mystic-roots', cleaned);
    } catch {
      // ignore storage errors
    }
    toastOk('玄学字根已保存，正在重新扫描字辈共振…');
    await loadData(false, cleaned);
  }, [mysticDraft, loadData]);

  const matchesThemeFilter = useCallback((x, themeName) => {
    if (!themeName || themeName === 'all') return true;
    return x.hybk === themeName || (Array.isArray(x.concepts) && x.concepts.includes(themeName));
  }, []);

  const strongSectors = useMemo(() => {
    const base = strongPool.filter(x => {
      if ((x.tagCount || x.tags?.length || 0) < strongMinTags) return false;
      if (strongOnlyNonZt && x.isLimitUp) return false;
      if (strongSelectedTags.length > 0 && !strongSelectedTags.every(k => (x.tagKeys || []).includes(k))) return false;
      return true;
    });
    const map = {};
    base.forEach(x => {
      const k = x.hybk || '其他板块';
      if (!map[k]) map[k] = { name: k, count: 0, amount: 0 };
      map[k].count += 1;
      map[k].amount += Number(x.amount || 0);
      (x.concepts || []).forEach(cname => {
        if (!map[cname]) map[cname] = { name: cname, count: 0, amount: 0, isConcept: true };
        map[cname].count += 1;
        map[cname].amount += Number(x.amount || 0);
      });
    });
    return Object.values(map).sort((a, b) => (b.count - a.count) || (b.amount - a.amount));
  }, [strongPool, strongMinTags, strongOnlyNonZt, strongSelectedTags]);

  const herdSectors = useMemo(() => {
    const map = {};
    herdPool.forEach(x => {
      const k = x.hybk || '其他板块';
      if (!map[k]) map[k] = { name: k, count: 0, amount: 0 };
      map[k].count += 1;
      map[k].amount += Number(x.amount || 0);
    });
    return Object.values(map).sort((a, b) => (b.count - a.count) || (b.amount - a.amount));
  }, [herdPool]);

  const handleHerdAction = useCallback(async (action, payload) => {
    if (isHistoryReplay) {
      toastWarn('当前处于历史复盘只读模式，请先切回今日实时看板后再变更抱团池');
      return;
    }
    const c6 = String(payload?.code || '').trim().padStart(6, '0');
    if (!/^\d{6}$/.test(c6)) {
      toastErr('请输入正确的6位股票代码');
      return;
    }
    if ((action === 'add' || action === 'restore') && !(c6.startsWith('00') || c6.startsWith('60'))) {
      toastErr('抱团跟踪池已严格剔除创业板(30)、科创板(68)，仅支持00/60主板');
      return;
    }
    try {
      setHerdBusyCode(c6);
      await postHerdAction({
        action,
        code: c6,
        name: payload?.name || '',
        hybk: payload?.hybk || '',
        price: payload?.price || 0,
        reason: payload?.reason || '',
      });
      const msgMap = {
        add: `已将 ${payload?.name || c6} 加入抱团跟踪池并锁定`,
        remove: `已将 ${payload?.name || c6} 移出抱团跟踪池`,
        restore: `已恢复 ${payload?.name || c6} 至抱团跟踪池`,
        pin: `已切换 ${payload?.name || c6} 锁定保护状态`,
      };
      toastOk(msgMap[action] || '操作成功');
      await loadData(true);
    } catch (err) {
      toastErr(err?.message || '抱团池操作失败');
    } finally {
      setHerdBusyCode('');
    }
  }, [isHistoryReplay, loadData]);

  const ladder = useMemo(() => ({
    high: allItems.filter(x => x.lbc >= 4),
    board3: allItems.filter(x => x.lbc === 3),
    board2: allItems.filter(x => x.lbc === 2),
    board1: allItems.filter(x => x.lbc === 1),
  }), [allItems]);

  const buyWindows = useMemo(() => ({
    auctionBuy: allItems.filter(x => x.buyWindow === 'AUCTION'),
    rushBuy: allItems.filter(x => x.buyWindow === 'RUSH'),
    reSealBuy: allItems.filter(x => x.buyWindow === 'RESEAL'),
    lateBuy: allItems.filter(x => x.buyWindow === 'LATE'),
    locked: allItems.filter(x => x.buyWindow === 'LOCKED'),
    rushing: rushingPool,
  }), [allItems, rushingPool]);

  const hotThemes = useMemo(() => {
    const map = {};
    allItems.forEach(s => {
      if (!map[s.hybk]) map[s.hybk] = [];
      map[s.hybk].push(s);
    });
    return Object.entries(map).map(([name, stocks]) => {
      const sorted = [...stocks].sort((a, b) => (b.lbc - a.lbc) || String(a.fbt).localeCompare(String(b.fbt)));
      return {
        name,
        count: stocks.length,
        maxLbc: Math.max(...stocks.map(x => x.lbc || 1)),
        leader: sorted[0]?.name || '',
        leaderCode: sorted[0]?.code || '',
        stocks: sorted,
      };
    }).sort((a, b) => (b.count - a.count) || (b.maxLbc - a.maxLbc));
  }, [allItems]);

  const displayItems = useMemo(() => {
    if (filterTier === 'themes') {
      return mainThemes.themes || [];
    }

    if (filterTier === 'strong') {
      const isMysticFilter = String(selectedTheme || '').startsWith('字辈·');
      const effMinTags = isMysticFilter ? 1 : strongMinTags;
      let sList = strongPool.filter(x => (x.tagCount || x.tags?.length || 0) >= effMinTags);
      if (strongOnlyNonZt && !isMysticFilter) {
        sList = sList.filter(x => !x.isLimitUp);
      }
      if (strongSelectedTags.length > 0) {
        sList = sList.filter(x => strongSelectedTags.every(k => (x.tagKeys || []).includes(k)));
      }
      if (selectedTheme !== 'all') {
        sList = sList.filter(x => matchesThemeFilter(x, selectedTheme));
      }
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        sList = sList.filter(x =>
          x.code.includes(q) ||
          x.name.toLowerCase().includes(q) ||
          (x.hybk || '').toLowerCase().includes(q) ||
          (x.mysticCluster || '').toLowerCase().includes(q)
        );
      }
      const dir = strongSortAsc ? 1 : -1;
      sList.sort((a, b) => {
        if (strongSort === 'relay') {
          return ((a.relayScore || 0) - (b.relayScore || 0)) * dir || ((b.identityScore || 0) - (a.identityScore || 0));
        }
        if (strongSort === 'identity') {
          return ((a.identityScore || 0) - (b.identityScore || 0)) * dir || ((b.relayScore || 0) - (a.relayScore || 0));
        }
        if (strongSort === 'lbc') {
          return ((a.lbc || 0) - (b.lbc || 0)) * dir || ((b.identityScore || 0) - (a.identityScore || 0));
        }
        if (strongSort === 'fbt') {
          const af = a.fbtSec && a.fbtSec < 900000 ? a.fbtSec : 999999;
          const bf = b.fbtSec && b.fbtSec < 900000 ? b.fbtSec : 999999;
          return (af - bf) * dir || ((b.relayScore || 0) - (a.relayScore || 0));
        }
        if (strongSort === 'chg') {
          return ((a.chg || 0) - (b.chg || 0)) * dir;
        }
        if (strongSort === 'amount') {
          return ((a.amount || 0) - (b.amount || 0)) * dir;
        }
        if (strongSort === 'fund') {
          const af = (a.fund || 0) > 0 ? a.fund : (a.amount || 0) * 0.01;
          const bf = (b.fund || 0) > 0 ? b.fund : (b.amount || 0) * 0.01;
          return (af - bf) * dir;
        }
        const tDiff = (a.tagCount || a.tags?.length || 0) - (b.tagCount || b.tags?.length || 0);
        if (tDiff !== 0) return tDiff * dir;
        const rDiff = (a.relayScore || 0) - (b.relayScore || 0);
        if (rDiff !== 0) return rDiff * dir;
        const iDiff = (a.identityScore || 0) - (b.identityScore || 0);
        if (iDiff !== 0) return iDiff * dir;
        return ((a.amount || 0) - (b.amount || 0)) * dir;
      });
      return sList;
    }

    if (filterTier === 'herd') {
      let hList = [...herdPool];
      if (herdHealthFilter !== 'all') {
        hList = hList.filter(x => x.healthStatus === herdHealthFilter);
      }
      if (selectedTheme !== 'all') {
        hList = hList.filter(x => matchesThemeFilter(x, selectedTheme));
      }
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        hList = hList.filter(x =>
          x.code.includes(q) ||
          x.name.toLowerCase().includes(q) ||
          (x.hybk || '').toLowerCase().includes(q)
        );
      }
      if (herdSort === 'cumReturn') {
        hList.sort((a, b) => (b.cumReturnPct || 0) - (a.cumReturnPct || 0));
      } else if (herdSort === 'chg') {
        hList.sort((a, b) => (b.chg || 0) - (a.chg || 0));
      } else if (herdSort === 'amount') {
        hList.sort((a, b) => (b.amount || 0) - (a.amount || 0));
      } else if (herdSort === 'ddFromPeak') {
        hList.sort((a, b) => (b.ddFromPeak ?? -99) - (a.ddFromPeak ?? -99));
      }
      return hList;
    }

    if (filterTier === 'rushing') {
      let rList = [...rushingPool];
      if (selectedTheme !== 'all') rList = rList.filter(x => matchesThemeFilter(x, selectedTheme));
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        rList = rList.filter(x => x.code.includes(q) || x.name.toLowerCase().includes(q) || x.hybk.toLowerCase().includes(q));
      }
      return rList;
    }

    if (filterTier === 'zb') {
      let zList = [...zbPool];
      if (selectedTheme !== 'all') zList = zList.filter(x => matchesThemeFilter(x, selectedTheme));
      if (searchKw.trim()) {
        const q = searchKw.trim().toLowerCase();
        zList = zList.filter(x => x.code.includes(q) || x.name.toLowerCase().includes(q) || x.hybk.toLowerCase().includes(q));
      }
      return zList;
    }

    let list = [...allItems];
    if (filterTier === 'auction') list = list.filter(x => x.buyWindow === 'AUCTION');
    else if (filterTier === 'rush') list = list.filter(x => x.buyWindow === 'RUSH');
    else if (filterTier === 'reseal') list = list.filter(x => x.buyWindow === 'RESEAL');
    else if (filterTier === 'late') list = list.filter(x => x.buyWindow === 'LATE');
    else if (filterTier === 'locked') list = list.filter(x => x.buyWindow === 'LOCKED');
    else if (filterTier === 'high') list = list.filter(x => x.lbc >= 4);
    else if (filterTier === 'board3') list = list.filter(x => x.lbc === 3);
    else if (filterTier === 'board2') list = list.filter(x => x.lbc === 2);
    else if (filterTier === 'board1') list = list.filter(x => x.lbc === 1);

    if (selectedTheme !== 'all') {
      list = list.filter(x => matchesThemeFilter(x, selectedTheme));
    }
    if (searchKw.trim()) {
      const q = searchKw.trim().toLowerCase();
      list = list.filter(x => x.code.includes(q) || x.name.toLowerCase().includes(q) || x.hybk.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      if (sortBy === 'ladder') {
        if (b.lbc !== a.lbc) return b.lbc - a.lbc;
        if (a.fbt !== b.fbt) return String(a.fbt).localeCompare(String(b.fbt));
        return b.score - a.score;
      }
      if (sortBy === 'time') return String(a.fbt).localeCompare(String(b.fbt));
      if (sortBy === 'fund') return b.fund - a.fund;
      if (sortBy === 'score') return b.score - a.score;
      return 0;
    });
    return list;
  }, [allItems, rushingPool, zbPool, strongPool, herdPool, mainThemes, filterTier, strongSelectedTags, strongMinTags, strongOnlyNonZt, herdHealthFilter, selectedTheme, searchKw, sortBy, strongSort, strongSortAsc, herdSort, matchesThemeFilter]);

  const displayStrongGroups = useMemo(() => {
    if (filterTier !== 'strong') return [];
    const map = {};
    displayItems.forEach(item => {
      const sec = item.hybk || '其他板块';
      if (!map[sec]) map[sec] = { sector: sec, stocks: [], ztCount: 0, totalAmount: 0, chgSum: 0 };
      map[sec].stocks.push(item);
      if (item.isLimitUp) map[sec].ztCount += 1;
      map[sec].totalAmount += Number(item.amount || 0);
      map[sec].chgSum += Number(item.chg || 0);
    });
    return Object.values(map)
      .map(g => ({ ...g, avgChg: g.stocks.length > 0 ? g.chgSum / g.stocks.length : 0 }))
      .sort((a, b) => (b.stocks.length - a.stocks.length) || (b.ztCount - a.ztCount) || (b.totalAmount - a.totalAmount));
  }, [displayItems, filterTier]);

  /**
   * 原位加入自选池（jumpToTrade: false）：
   * 在连板打热页点「＋自选」直接写入自选池并变更为「✓已自选」，不会把用户强行跳走；
   * 若已在自选池中点「✓已自选」则直达今日作战台定位该股。
   */
  const handleAddSingle = useCallback((code, name, stockMeta = null) => {
    const code6 = String(code || '').trim().padStart(6, '0');
    if (!code6 || code6 === '000000') return;
    if (inPoolCodes.has(code6)) {
      if (onSelectStock) onSelectStock(code6);
      return;
    }
    if (onAddStock) {
      const tag = stockMeta?.statTag || (stockMeta?.lbc >= 2 ? `${stockMeta.lbc}连板` : '超短热门');
      onAddStock(code6, { tier: 'short', strategyTag: tag }, { jumpToTrade: false });
    }
  }, [inPoolCodes, onAddStock, onSelectStock]);

  const handleCopyBrief = () => {
    const txt = buildDailyReviewBrief({ data, mainThemes, mysticClusters, herdPool, allItems });
    if (!txt) {
      toastWarn('暂无可导出的复盘数据，请稍后再试');
      return;
    }
    copyPlain(txt, '✓ 已复制今日复盘简报，可直接粘贴发微信或保存笔记');
  };

  return (
    <div className="board-page-wrap">
      {/* 顶部聚合战况看板 */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #2e1065 100%)',
        color: '#fff',
        borderRadius: '12px',
        padding: '16px 20px',
        marginBottom: '14px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '26px' }}>🔥</span>
            <div>
              <div style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span>连板打板 · 强势抱团 · 主线中枢决策台</span>
                <span style={{ fontSize: '11px', background: '#cf1322', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>
                  超短打板 & 抱团
                </span>
                <span style={{ fontSize: '11px', background: 'rgba(16, 185, 129, 0.25)', border: '1px solid #34d399', color: '#6ee7b7', padding: '1px 7px', borderRadius: '4px', fontWeight: 700 }}>
                  🛡️ 强势/抱团/主题材已剔除创业板(30)与科创板(68)
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
                连板接力 · 一票多标签强势池 · 全自动抱团跟踪(断板高横监测/破位自动淘汰) · 全模块一键跟踪与加入自选
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
              基准日：<b style={{ color: '#fbbf24', fontFamily: 'monospace' }}>{data?.date || '—'}</b>
            </span>
            <input
              type="date"
              max={localTodayIso}
              value={boardDate}
              onChange={e => setBoardDate(e.target.value === localTodayIso ? '' : e.target.value)}
              title="选择历史日期回看当日连板天梯与玄学字辈共振（只读）"
              style={{ padding: '2px 6px', fontSize: '11.5px', borderRadius: '5px', border: '1px solid rgba(255,255,255,0.28)', background: 'rgba(15,23,42,0.7)', color: '#fff' }}
            />
            {boardDate && (
              <button
                type="button"
                className="mini"
                onClick={() => setBoardDate('')}
                style={{ marginLeft: 0, background: 'rgba(251,191,36,0.2)', color: '#fde68a', borderColor: '#f59e0b', padding: '3px 8px', fontSize: '11.5px', fontWeight: 700 }}
              >
                回今日实时
              </button>
            )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: '#cbd5e1', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                disabled={isHistoryReplay}
                onChange={e => setAutoRefresh(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>30秒自动</span>
            </label>
            <button
              type="button"
              className="mini"
              onClick={handleCopyBrief}
              style={{ marginLeft: 0, background: 'rgba(56,189,248,0.18)', color: '#bae6fd', border: '1px solid rgba(56,189,248,0.45)', padding: '4px 9px' }}
              title="一键复制今日情绪、四大核心、字辈暗线与抱团核心复盘简报"
            >
              📋 复制简报
            </button>
            <button
              type="button"
              className="mini"
              style={{ marginLeft: 0, background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', padding: '4px 10px' }}
              onClick={() => loadData(false)}
              disabled={loading}
            >
              {loading ? '⟳ 同步中…' : '⟳ 立即刷新'}
            </button>
          </div>
        </div>

        {/* 6 维核心数据卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '10px' }}>
          <div
            onClick={() => setFilterTier('all')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer' }}
          >
            <div style={{ fontSize: '11.5px', color: '#cbd5e1' }}>📈 涨停封死总数</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#f87171', fontFamily: 'monospace', marginTop: '2px' }}>
              {data ? allItems.length : '—'} <span style={{ fontSize: '12px', fontWeight: 400, color: '#e2e8f0' }}>家 ({onlyMainboard ? '纯主板' : '不含创业板'})</span>
            </div>
          </div>

          <div
            onClick={() => setFilterTier('herd')}
            style={{ background: 'rgba(139, 92, 246, 0.18)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(196, 181, 253, 0.45)', cursor: 'pointer' }}
            title="点击切入全自动抱团跟踪池"
          >
            <div style={{ fontSize: '11.5px', color: '#ddd6fe' }}>🤝 自动抱团跟踪</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#c4b5fd', fontFamily: 'monospace', marginTop: '2px' }}>
              {data ? herdPool.length : '—'} <span style={{ fontSize: '12px', fontWeight: 400, color: '#ede9fe' }}>只(淘汰{evictedPool.length})</span>
            </div>
          </div>

          <div
            onClick={() => !isHistoryReplay && setFilterTier('rushing')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(255,255,255,0.1)', cursor: isHistoryReplay ? 'default' : 'pointer' }}
          >
            <div style={{ fontSize: '11.5px', color: '#cbd5e1' }}>⚡ 开盘冲板临界可买</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#38bdf8', fontFamily: 'monospace', marginTop: '2px' }}>
              {data ? rushingPool.length : '—'} <span style={{ fontSize: '12px', fontWeight: 400, color: '#e2e8f0' }}>家逼近涨停</span>
            </div>
          </div>

          <div
            onClick={() => setFilterTier('auction')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer' }}
          >
            <div style={{ fontSize: '11.5px', color: '#cbd5e1' }}>🌅 09:25 竞价可买</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#4ade80', fontFamily: 'monospace', marginTop: '2px' }}>
              {buyWindows.auctionBuy.length} <span style={{ fontSize: '12px', fontWeight: 400, color: '#e2e8f0' }}>家竞价放量</span>
            </div>
          </div>

          <div
            onClick={() => setFilterTier('high')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer' }}
          >
            <div style={{ fontSize: '11.5px', color: '#cbd5e1' }}>👑 最高连板高度</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#fbbf24', fontFamily: 'monospace', marginTop: '2px' }}>
              {data ? data.maxLadder : '—'} <span style={{ fontSize: '12px', fontWeight: 400, color: '#e2e8f0' }}>连板空间标杆</span>
            </div>
          </div>

          <div
            onClick={() => setFilterTier('themes')}
            style={{ background: 'rgba(232, 121, 249, 0.14)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(232, 121, 249, 0.4)', cursor: 'pointer' }}
            title="点击查看主题材及题材龙头/阶段核心/容量核心动态研判"
          >
            <div style={{ fontSize: '11.5px', color: '#f5d0fe' }}>🧭 动态第一主题材</div>
            <div style={{ fontSize: '14.5px', fontWeight: 800, color: '#f0abfc', marginTop: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {mainThemes?.marketOverview?.topThemeName || (hotThemes.length > 0 ? `${hotThemes[0].name} (${hotThemes[0].count}家)` : '计算中…')}
            </div>
          </div>
        </div>

        {/* 纪律底栏 */}
        <div style={{
          marginTop: '10px',
          paddingTop: '8px',
          borderTop: '1px dashed rgba(255,255,255,0.15)',
          fontSize: '12px',
          color: '#fcd34d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '6px'
        }}>
          <div>
            🛡️ <b>实战纪律：</b>一字板散户买不进不可盲目排队；开盘秒板与冲板点是扫板黄金期；<b>严禁挪用底仓资金向下补仓加死码</b>！
          </div>
          <a
            href="#/trade"
            onClick={(e) => { e.preventDefault(); if (onTabChange) onTabChange('/trade'); }}
            style={{ color: '#38bdf8', textDecoration: 'none', fontWeight: 700 }}
          >
            前往今日作战台 ({pool?.length || 0}只自选) →
          </a>
        </div>
      </div>

      {/* 🌡️ 全市场超短情绪温度计 & 炸板率风控总阀 */}
      {data?.sentiment && (
        <MarketSentimentBar externalSentiment={data.sentiment} compact />
      )}

      {/* 历史复盘只读提示条 */}
      {isHistoryReplay && (
        <div style={{
          marginBottom: '12px',
          padding: '8px 14px',
          borderRadius: '8px',
          background: '#fffbeb',
          border: '1px solid #fcd34d',
          color: '#92400e',
          fontSize: '12.5px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '8px',
        }}>
          <span>
            🕰️ <b>历史复盘只读模式（{data?.date}）：</b>已自动停止改写今日抱团跟踪池并屏蔽实时冲板盘口，仍可将心仪标的加入自选池。
          </span>
          <button type="button" className="mini" onClick={() => setBoardDate('')} style={{ marginLeft: 0, fontSize: '11.5px', background: '#fff', borderColor: '#f59e0b', color: '#b45309', fontWeight: 700 }}>
            回到今日实时
          </button>
        </div>
      )}

      {/* 做T池持仓异动联动警告栏 */}
      {poolAlerts.length > 0 && (
        <div style={{
          marginBottom: '12px',
          padding: '8px 12px',
          borderRadius: '8px',
          background: '#f8fafc',
          border: '1px solid #cbd5e1',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          fontSize: '12px',
        }}>
          <b style={{ color: '#0f172a' }}>🔔 自选池持仓联动：</b>
          {poolAlerts.map(al => (
            <span
              key={`${al.kind}_${al.code}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '2px 8px',
                borderRadius: '6px',
                background: al.bg,
                color: al.color,
                border: `1px solid ${al.border}`,
                fontWeight: 700,
              }}
            >
              <span onClick={() => { setFilterTier(al.targetTab); setSearchKw(al.code); }} style={{ cursor: 'pointer' }}>
                {al.name}({al.code}) · {al.label}
              </span>
              <a href={`#/diagnosis?code=${al.code}`} style={{ color: 'inherit', textDecoration: 'none', fontSize: '11px' }} title="全景体检">
                🩺
              </a>
            </span>
          ))}
        </div>
      )}

      {/* 控制与筛选工具栏 */}
      <div className="board-filter-toolbar">
        <div className="board-tier-tabs">
          <button type="button" className={`mini ${filterTier === 'all' ? 'primary' : ''}`} onClick={() => setFilterTier('all')} style={{ marginLeft: 0, fontWeight: 700 }}>
            🔥 全部天梯 ({allItems.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'themes' ? 'primary' : ''}`}
            onClick={() => setFilterTier('themes')}
            style={{ marginLeft: 0, color: filterTier === 'themes' ? '#fff' : '#9333ea', background: filterTier === 'themes' ? '#9333ea' : '#faf5ff', borderColor: '#d8b4fe', fontWeight: 800 }}
          >
            🧭 主题材与四大核心 ({(mainThemes.themes || []).length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'strong' ? 'primary' : ''}`}
            onClick={() => setFilterTier('strong')}
            style={{ marginLeft: 0, color: filterTier === 'strong' ? '#fff' : '#0f766e', background: filterTier === 'strong' ? '#0f766e' : '#f0fdfa', borderColor: '#5eead4', fontWeight: 800 }}
          >
            💪 强共振多标签 ({strongMulti2Count}/{strongPool.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'herd' ? 'primary' : ''}`}
            onClick={() => setFilterTier('herd')}
            style={{ marginLeft: 0, color: filterTier === 'herd' ? '#fff' : '#6d28d9', background: filterTier === 'herd' ? '#6d28d9' : '#f5f3ff', borderColor: '#c4b5fd', fontWeight: 800 }}
          >
            🤝 自动抱团跟踪 ({herdPool.length})
          </button>
          {!isHistoryReplay && (
            <button
              type="button"
              className={`mini ${filterTier === 'rushing' ? 'primary' : ''}`}
              onClick={() => setFilterTier('rushing')}
              style={{ marginLeft: 0, color: filterTier === 'rushing' ? '#fff' : '#0284c7', background: filterTier === 'rushing' ? '#0284c7' : '#e0f2fe', borderColor: '#38bdf8', fontWeight: 800 }}
            >
              ⚡ 正在冲板临界可买 ({rushingPool.length})
            </button>
          )}
          <button
            type="button"
            className={`mini ${filterTier === 'auction' ? 'primary' : ''}`}
            onClick={() => setFilterTier('auction')}
            style={{ marginLeft: 0, color: filterTier === 'auction' ? '#fff' : '#15803d', background: filterTier === 'auction' ? '#15803d' : '#dcfce7', borderColor: '#4ade80', fontWeight: 800 }}
          >
            🌅 09:25 竞价可买 ({buyWindows.auctionBuy.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'rush' ? 'primary' : ''}`}
            onClick={() => setFilterTier('rush')}
            style={{ marginLeft: 0, color: filterTier === 'rush' ? '#fff' : '#c2410c', background: filterTier === 'rush' ? '#c2410c' : '#ffedd5', borderColor: '#fb923c', fontWeight: 800 }}
          >
            🚀 09:30 秒板扫板 ({buyWindows.rushBuy.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'reseal' ? 'primary' : ''}`}
            onClick={() => setFilterTier('reseal')}
            style={{ marginLeft: 0, color: filterTier === 'reseal' ? '#fff' : '#b45309', fontWeight: 700 }}
          >
            🔄 炸板回封 ({buyWindows.reSealBuy.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'high' ? 'primary' : ''}`}
            onClick={() => setFilterTier('high')}
            style={{ marginLeft: 0, color: filterTier === 'high' ? '#fff' : '#cf1322', fontWeight: 700 }}
          >
            👑 高标龙头(≥4板) ({ladder.high.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'board3' ? 'primary' : ''}`}
            onClick={() => setFilterTier('board3')}
            style={{ marginLeft: 0, color: filterTier === 'board3' ? '#fff' : '#d4380d', fontWeight: 700 }}
          >
            🔥 3连板(梯队) ({ladder.board3.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'board2' ? 'primary' : ''}`}
            onClick={() => setFilterTier('board2')}
            style={{ marginLeft: 0, color: filterTier === 'board2' ? '#fff' : '#1677ff', fontWeight: 700 }}
          >
            🎯 2连板(1进2) ({ladder.board2.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'late' ? 'primary' : ''}`}
            onClick={() => setFilterTier('late')}
            style={{ marginLeft: 0, color: filterTier === 'late' ? '#fff' : '#b45309', background: filterTier === 'late' ? '#b45309' : '#fffbeb', borderColor: '#fde68a', fontWeight: 700 }}
            title="14:30 及以后（最后30分钟）才首次封板的尾盘偷袭股"
          >
            ⚠️ 尾盘偷袭(14:30+) ({buyWindows.lateBuy.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'locked' ? 'primary' : ''}`}
            onClick={() => setFilterTier('locked')}
            style={{ marginLeft: 0, color: filterTier === 'locked' ? '#fff' : 'var(--mute)', fontWeight: 600 }}
          >
            🔒 一字买不进 ({buyWindows.locked.length})
          </button>
          <button
            type="button"
            className={`mini ${filterTier === 'zb' ? 'primary' : ''}`}
            onClick={() => setFilterTier('zb')}
            style={{ marginLeft: 0, color: filterTier === 'zb' ? '#fff' : '#cf1322', background: filterTier === 'zb' ? '#cf1322' : '#fff1f0', borderColor: '#ffa39e', fontWeight: 700 }}
          >
            💥 曾涨停炸板 ({zbPool.length})
          </button>
        </div>

        {/* 搜索与排序 */}
        <div className="board-search-controls">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text)', cursor: 'pointer', padding: '4px 8px', borderRadius: '6px', background: onlyMainboard ? '#e6f4ff' : 'var(--surface2)', border: '1px solid', borderColor: onlyMainboard ? '#91caff' : 'var(--line)', fontWeight: onlyMainboard ? 700 : 500, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyMainboard} onChange={e => setOnlyMainboard(e.target.checked)} style={{ cursor: 'pointer' }} />
            <span>仅10cm主板</span>
          </label>

          {filterTier === 'strong' ? (
            <select
              value={strongSort}
              onChange={e => {
                const k = e.target.value;
                setStrongSort(k);
                setStrongSortAsc(k === 'fbt');
              }}
              style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid #5eead4', background: '#f0fdfa', color: '#0f766e', fontWeight: 700 }}
            >
              <option value="resonance">排序：多维共振 + 接力分优先</option>
              <option value="relay">排序：接力分(可接力性)优先</option>
              <option value="identity">排序：身份分(龙骨地位)优先</option>
              <option value="lbc">排序：连板高度优先</option>
              <option value="fbt">排序：首封时间由早到晚</option>
              <option value="fund">排序：封单资金优先</option>
              <option value="amount">排序：成交金额优先</option>
              <option value="chg">排序：今日涨幅优先</option>
            </select>
          ) : filterTier === 'herd' ? (
            <select
              value={herdSort}
              onChange={e => setHerdSort(e.target.value)}
              style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid #c4b5fd', background: '#f5f3ff', color: '#6d28d9', fontWeight: 700 }}
            >
              <option value="health">排序：健康状态优先</option>
              <option value="cumReturn">排序：跟踪累计收益优先</option>
              <option value="chg">排序：今日涨幅优先</option>
              <option value="amount">排序：成交额优先</option>
              <option value="ddFromPeak">排序：抗跌回撤最小优先</option>
            </select>
          ) : (
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text)' }}
            >
              <option value="ladder">排序：连板高度优先</option>
              <option value="time">排序：首次封板时间优先</option>
              <option value="fund">排序：封单资金优先</option>
              <option value="score">排序：打板评分优先</option>
            </select>
          )}

          {!['rushing', 'zb', 'themes', 'strong', 'herd'].includes(filterTier) && (
            <div style={{ display: 'inline-flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--line)', background: '#fff' }}>
              {[
                { mode: 'card', label: '📄 卡片' },
                { mode: 'table', label: '📋 表格' },
              ].map(v => (
                <button
                  key={v.mode}
                  type="button"
                  onClick={() => setLadderViewMode(v.mode)}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11.5px',
                    border: 'none',
                    cursor: 'pointer',
                    background: ladderViewMode === v.mode ? '#0958d9' : 'transparent',
                    color: ladderViewMode === v.mode ? '#fff' : 'var(--sub)',
                    fontWeight: ladderViewMode === v.mode ? 700 : 500,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}

          <input
            type="text"
            placeholder="搜索代码 / 名称 / 炒作题材…"
            value={searchKw}
            onChange={e => setSearchKw(e.target.value)}
            className="board-search-input"
          />
        </div>
      </div>

      {/* 主体响应式两栏布局（<=1200px 自动全宽单栏防裁切） */}
      <div className="board-main-layout">
        <div className="board-main-left">
          {selectedTheme !== 'all' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              padding: '8px 12px',
              borderRadius: '8px',
              background: '#e6f4ff',
              border: '1px solid #91caff',
              color: '#0958d9',
              marginBottom: '10px',
              fontSize: '12.5px'
            }}>
              <span>🎯 当前筛选炒作风口板块：<b>{selectedTheme}</b>（共 {displayItems.length} 只标的）</span>
              <button type="button" className="mini" onClick={() => setSelectedTheme('all')} style={{ marginLeft: 0, fontSize: '11px', padding: '2px 8px' }}>
                ✕ 清除板块筛选
              </button>
            </div>
          )}

          {error && (
            <div style={{ padding: '16px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: '8px', color: '#cf1322', fontSize: '13px', marginBottom: '14px' }}>
              <b>连板池接口异常：</b>{error}
              <div style={{ marginTop: '6px' }}>
                <button className="mini primary" onClick={() => loadData(false)} style={{ marginLeft: 0 }}>重新尝试连接</button>
              </div>
            </div>
          )}

          {loading && !data && (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--mute)', fontSize: '13px', background: 'var(--surface)', borderRadius: '10px', border: '1px solid var(--line)' }}>
              正在拉取今日东方财富全市场涨停板池、连板天梯与冲板标的…
            </div>
          )}

          {!loading && displayItems.length === 0 && !(filterTier === 'herd' && evictedPool.length > 0) && (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--sub)', fontSize: '13px', background: 'var(--surface)', borderRadius: '10px', border: '1px solid var(--line)' }}>
              {filterTier === 'herd'
                ? '当前暂无符合筛选条件的抱团跟踪标的（可在上方输入代码或股票名手动添加）'
                : filterTier === 'themes'
                  ? '暂无动态主题材聚合结果，请点击右上角“立即刷新”'
                  : '未检索到符合条件的股票标的'}
            </div>
          )}

          {filterTier === 'themes' && (
            <MainThemesPanel
              mainThemes={mainThemes}
              mysticClusters={mysticClusters}
              inPoolCodes={inPoolCodes}
              herdCodeSet={herdCodeSet}
              herdBusyCode={herdBusyCode}
              onHerdAction={handleHerdAction}
              onAddSingle={handleAddSingle}
              onSelectStock={onSelectStock}
              onJumpHerd={() => setFilterTier('herd')}
              onFilterThemeToStrong={(tName) => {
                if (String(tName || '').startsWith('字辈·')) {
                  setStrongMinTags(1);
                  setStrongOnlyNonZt(false);
                }
                setSelectedTheme(tName);
                setFilterTier('strong');
              }}
              readOnlyHistory={isHistoryReplay}
            />
          )}

          {filterTier === 'strong' && (
            <StrongPoolPanel
              displayItems={displayItems}
              displayStrongGroups={displayStrongGroups}
              strongPool={strongPool}
              strongEliteCount={strongEliteCount}
              strongMulti2Count={strongMulti2Count}
              strongMinTags={strongMinTags}
              setStrongMinTags={setStrongMinTags}
              strongOnlyNonZt={strongOnlyNonZt}
              setStrongOnlyNonZt={setStrongOnlyNonZt}
              strongViewMode={strongViewMode}
              setStrongViewMode={setStrongViewMode}
              strongSelectedTags={strongSelectedTags}
              setStrongSelectedTags={setStrongSelectedTags}
              toggleStrongTag={toggleStrongTag}
              strongSectors={strongSectors}
              selectedTheme={selectedTheme}
              setSelectedTheme={setSelectedTheme}
              mysticClusters={mysticClusters}
              mysticDraft={mysticDraft}
              setMysticDraft={setMysticDraft}
              showMysticConfig={showMysticConfig}
              setShowMysticConfig={setShowMysticConfig}
              onSaveMysticRoots={handleSaveMysticRoots}
              strongSort={strongSort}
              strongSortAsc={strongSortAsc}
              toggleStrongSort={toggleStrongSort}
              inPoolCodes={inPoolCodes}
              herdCodeSet={herdCodeSet}
              herdBusyCode={herdBusyCode}
              onHerdAction={handleHerdAction}
              onAddSingle={handleAddSingle}
              onSelectStock={onSelectStock}
              setFilterTier={setFilterTier}
              strongDetailItem={strongDetailItem}
              setStrongDetailItem={setStrongDetailItem}
              readOnlyHistory={isHistoryReplay}
            />
          )}

          {filterTier === 'herd' && (
            <HerdPoolPanel
              displayItems={displayItems}
              herdPool={herdPool}
              evictedPool={evictedPool}
              herdHealthFilter={herdHealthFilter}
              setHerdHealthFilter={setHerdHealthFilter}
              herdSectors={herdSectors}
              selectedTheme={selectedTheme}
              setSelectedTheme={setSelectedTheme}
              herdBusyCode={herdBusyCode}
              onHerdAction={handleHerdAction}
              inPoolCodes={inPoolCodes}
              onAddSingle={handleAddSingle}
              onSelectStock={onSelectStock}
              readOnlyHistory={isHistoryReplay}
            />
          )}

          {/* 正在冲板临界池 */}
          {filterTier === 'rushing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ padding: '8px 12px', background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: '8px', color: '#0369a1', fontSize: '12px' }}>
                💡 <b>开盘冲板可买说明：</b>以下标的开盘后快速放量拉升至 +7%~+9.5%，现价逼近涨停价（仅差 0.2%~2.0%），处于游资挂涨停价扫板打入的黄金决策临界点！
              </div>
              {displayItems.map(item => (
                <div
                  key={item.code}
                  style={{
                    background: 'linear-gradient(180deg, #fff, #f8fafc)',
                    border: '1.5px solid #38bdf8',
                    borderRadius: '10px',
                    padding: '12px 16px',
                    boxShadow: '0 2px 8px rgba(56, 189, 248, 0.15)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#0284c7', color: '#fff' }}>
                        ⚡ 冲击涨停中
                      </span>
                      <span style={{ fontSize: '16px', fontWeight: 800 }}>{item.name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{item.code}</span>
                      <span
                        onClick={() => setSelectedTheme(item.hybk)}
                        style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4', cursor: 'pointer' }}
                      >
                        🔥 {item.hybk}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, color: '#0284c7' }}>距涨停仅差 {item.distCeiling.toFixed(1)}%</span>
                      <span style={{ fontSize: '12px', fontFamily: 'monospace', fontWeight: 700, color: 'var(--up)' }}>涨停价 ¥{f2(item.ceiling)}</span>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px', padding: '8px 10px', background: '#f0f9ff', borderRadius: '6px', fontSize: '12px', marginBottom: '8px' }}>
                    <div>现价: <b style={{ color: 'var(--up)', fontFamily: 'monospace' }}>¥{f2(item.price)}</b> (+{item.chg.toFixed(1)}%)</div>
                    <div>距涨停差额: <b style={{ color: '#0284c7', fontFamily: 'monospace' }}>¥{f2(item.ceiling - item.price)}</b></div>
                    <div>换手率: <b style={{ fontFamily: 'monospace' }}>{item.turnover.toFixed(1)}%</b></div>
                    <div>成交额: <b style={{ fontFamily: 'monospace' }}>{money$(item.amount)}</b></div>
                    <div>量比: <b style={{ fontFamily: 'monospace' }}>{item.vr ? item.vr.toFixed(1) : '—'}倍</b></div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ fontSize: '11.5px', color: '#0369a1' }}>
                      🎯 <b>打板动作：</b>{item.buyAction}
                    </div>
                    <BoardStockActions
                      stock={item}
                      inPoolCodes={inPoolCodes}
                      herdCodeSet={herdCodeSet}
                      herdBusyCode={herdBusyCode}
                      onHerdAction={handleHerdAction}
                      onAddSingle={handleAddSingle}
                      onSelectStock={onSelectStock}
                      onJumpHerd={() => setFilterTier('herd')}
                      onJumpIgnition={onJumpIgnition}
                      readOnlyHistory={isHistoryReplay}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 曾涨停炸板大面警报池（补齐跟踪与加入自选能力） */}
          {filterTier === 'zb' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ padding: '8px 12px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: '8px', color: '#cf1322', fontSize: '12px' }}>
                🚨 <b>炸板大面避险提示：</b>以下标的今日曾封涨停但遭大单砸开且至今未能回封！严禁盲目抄底打回封，可先加入自选或跟踪观察次日竞价能否弱转强反包。
              </div>
              {displayItems.map(item => (
                <div key={item.code} style={{ background: '#fffafa', border: '1.5px solid #ffa39e', borderRadius: '10px', padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#cf1322', color: '#fff' }}>
                        💥 炸板回落 {item.dropFromTop.toFixed(1)}%
                      </span>
                      <span style={{ fontSize: '16px', fontWeight: 800 }}>{item.name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{item.code}</span>
                      <span onClick={() => setSelectedTheme(item.hybk)} style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4', cursor: 'pointer' }}>
                        {item.hybk}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#cf1322' }}>
                      曾炸板 {item.zbc} 次 · 现价 ¥{f2(item.price)} ({item.chg >= 0 ? '+' : ''}{item.chg.toFixed(1)}%)
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: 'var(--sub)' }}>
                    <span>涨停价 ¥{f2(item.ztPrice)} · 换手率 {item.hs.toFixed(1)}% · 首封 {item.fbt}</span>
                    <BoardStockActions
                      stock={item}
                      inPoolCodes={inPoolCodes}
                      herdCodeSet={herdCodeSet}
                      herdBusyCode={herdBusyCode}
                      onHerdAction={handleHerdAction}
                      onAddSingle={handleAddSingle}
                      onSelectStock={onSelectStock}
                      onJumpHerd={() => setFilterTier('herd')}
                      compact
                      readOnlyHistory={isHistoryReplay}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 标准涨停天梯与可买时点（表格视图：无裁切网格 + 窄屏自动转卡片） */}
          {!['rushing', 'zb', 'themes', 'strong', 'herd'].includes(filterTier) && ladderViewMode === 'table' && displayItems.length > 0 && (
            <div className="board-ladder-scroll">
              <div className="board-ladder-scroll-inner">
                <div className="board-ladder-header">
                  <div>梯队 / 评级</div>
                  <div>标的 / 题材</div>
                  <div>现价 / 买点</div>
                  <div>首封 / 炸板</div>
                  <div>封单额 / 封成比</div>
                  <div>成交额 / 换手</div>
                  <div>量化分</div>
                  <div style={{ textAlign: 'right' }}>跟踪 / 加入自选</div>
                </div>
                {displayItems.map((item, idx) => {
                  const isHigh = item.lbc >= 4;
                  const isLadder3 = item.lbc === 3;
                  const isLadder2 = item.lbc === 2;
                  return (
                    <div
                      key={item.code}
                      className={`board-ladder-row ${isHigh ? 'is-high' : idx % 2 === 1 ? 'is-alt' : ''}`}
                      style={{
                        borderBottom: idx === displayItems.length - 1 ? 'none' : '1px solid var(--line)',
                      }}
                    >
                      <div className="blr-col-tier">
                        <span style={{
                          display: 'inline-block',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 800,
                          color: '#fff',
                          background: isHigh ? '#cf1322' : isLadder3 ? '#d4380d' : isLadder2 ? '#1677ff' : '#52c41a',
                          whiteSpace: 'nowrap',
                        }}>
                          {item.statTag}
                        </span>
                        <div style={{ fontSize: '10.5px', fontWeight: 700, color: '#0958d9', marginTop: '2px', whiteSpace: 'nowrap' }}>{item.verdict}</div>
                      </div>
                      <div className="blr-col-ident">
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', flexWrap: 'wrap' }}>
                          <b style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>{item.name}</b>
                          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)', whiteSpace: 'nowrap' }}>{item.code}</span>
                        </div>
                        <div
                          onClick={() => setSelectedTheme(selectedTheme === item.hybk ? 'all' : item.hybk)}
                          style={{ fontSize: '10.5px', color: '#1d39c4', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          {item.hybk}
                        </div>
                      </div>
                      <div className="blr-col-px" style={{ fontFamily: 'monospace' }}>
                        <div style={{ fontWeight: 800, color: 'var(--up)' }}>¥{f2(item.price)}</div>
                        <div style={{ fontSize: '10.5px', color: 'var(--sub)', whiteSpace: 'nowrap' }}>{item.buyTag}</div>
                      </div>
                      <div className="blr-col-time" style={{ fontFamily: 'monospace' }}>
                        <div style={{ fontWeight: 700, color: item.fbt <= '09:35:00' ? '#cf1322' : 'var(--text)' }}>{item.fbt}</div>
                        <div style={{ fontSize: '10.5px', color: item.zbc > 0 ? '#cf1322' : 'var(--mute)', whiteSpace: 'nowrap' }}>
                          {item.zbc > 0 ? `炸板${item.zbc}次` : `末封 ${item.lbt}`}
                        </div>
                      </div>
                      <div className="blr-col-seal" style={{ fontFamily: 'monospace' }}>
                        <div style={{ fontWeight: 700, color: '#cf1322', whiteSpace: 'nowrap' }}>{money$(item.fund)}</div>
                        <div style={{ fontSize: '10.5px', color: 'var(--mute)', whiteSpace: 'nowrap' }}>封成比 {item.sealRatio.toFixed(2)}x</div>
                      </div>
                      <div className="blr-col-amt" style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--sub)' }}>
                        <div style={{ whiteSpace: 'nowrap' }}>{money$(item.amount)}</div>
                        <div style={{ whiteSpace: 'nowrap' }}>{item.turnover.toFixed(1)}%</div>
                      </div>
                      <div className="blr-col-score" style={{ fontFamily: 'monospace', fontWeight: 800, color: '#cf1322', whiteSpace: 'nowrap' }}>{item.score}分</div>
                      <div className="blr-col-acts">
                        <BoardStockActions
                          stock={item}
                          inPoolCodes={inPoolCodes}
                          herdCodeSet={herdCodeSet}
                          herdBusyCode={herdBusyCode}
                          onHerdAction={handleHerdAction}
                          onAddSingle={handleAddSingle}
                          onSelectStock={onSelectStock}
                          onJumpHerd={() => setFilterTier('herd')}
                          compact
                          readOnlyHistory={isHistoryReplay}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 标准涨停天梯与可买时点（卡片视图） */}
          {!['rushing', 'zb', 'themes', 'strong', 'herd'].includes(filterTier) && ladderViewMode === 'card' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {displayItems.map(item => {
                const isHigh = item.lbc >= 4;
                const isLadder3 = item.lbc === 3;
                const isLadder2 = item.lbc === 2;
                const isAuctionBuy = item.buyWindow === 'AUCTION';
                const isRushBuy = item.buyWindow === 'RUSH';
                const isLocked = item.buyWindow === 'LOCKED';

                let nextDayPlan = '';
                if (item.lbc >= 4) {
                  nextDayPlan = '【高位妖股断板预案】次日若不能大单一字或大幅高开 +6% 秒板，只要早盘分时跌破黄线，立即全部清仓锁定暴利，绝不深扛！';
                } else if (item.lbc === 3) {
                  nextDayPlan = '【3进4加速或分歧】次日预期高开 +4% 以上为强势；冲高未能封死且放巨量滞涨时先分批止盈 1/2，破分时均线清仓。';
                } else if (item.lbc === 2) {
                  nextDayPlan = '【2进3连板考验】次日高开 +2%~+5% 关注快速封板；若平开或低开翻绿，开盘5分钟内不翻红果断保本或微亏止损抢跑。';
                } else if (item.zbc > 0) {
                  nextDayPlan = '【烂板弱转强测试】今日曾炸板，次日必须竞价高开抢筹反包；若平开或低开，为典型大面出货陷阱，开盘第一秒市价抢跑！';
                } else {
                  nextDayPlan = '【首板次日接力】次日冲高至 +3%~+5% 先止盈一半锁定首板利润；剩余半仓以昨日涨停价或分时均线为防守线，破线全走。';
                }

                return (
                  <div
                    key={item.code}
                    style={{
                      background: 'var(--surface)',
                      border: isHigh ? '2px solid #ff4d4f' : isLadder3 ? '1.5px solid #ff7a45' : '1px solid var(--line)',
                      borderRadius: '10px',
                      padding: '12px 16px',
                      boxShadow: isHigh ? '0 2px 10px rgba(255, 77, 79, 0.15)' : '0 1px 4px rgba(0,0,0,0.04)',
                      transition: 'all .2s'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '12px',
                          fontWeight: 800,
                          padding: '2px 8px',
                          borderRadius: '4px',
                          background: isHigh ? '#cf1322' : isLadder3 ? '#d4380d' : isLadder2 ? '#1677ff' : '#52c41a',
                          color: '#fff',
                          letterSpacing: '0.5px'
                        }}>
                          {item.statTag}
                        </span>
                        <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)' }}>{item.name}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{item.code}</span>
                        <span
                          onClick={() => setSelectedTheme(item.hybk)}
                          style={{ fontSize: '11.5px', padding: '2px 8px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4', border: '1px solid #adc6ff', cursor: 'pointer', fontWeight: 600 }}
                        >
                          🔥 {item.hybk}
                        </span>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: isAuctionBuy ? '#dcfce7' : isRushBuy ? '#ffedd5' : isLocked ? '#f1f5f9' : '#e0f2fe',
                          color: isAuctionBuy ? '#15803d' : isRushBuy ? '#c2410c' : isLocked ? '#64748b' : '#0369a1',
                          border: '1px solid',
                          borderColor: isAuctionBuy ? '#86efac' : isRushBuy ? '#fdba74' : isLocked ? '#cbd5e1' : '#7dd3fc'
                        }}>
                          {item.buyTag}
                        </span>
                        {item.zbc > 0 && (
                          <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', fontWeight: 700 }}>
                            🚨 曾炸板 {item.zbc} 次
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{
                          fontSize: '12px',
                          fontWeight: 800,
                          padding: '3px 8px',
                          borderRadius: '6px',
                          background: item.score >= 80 ? '#fff1f0' : item.score >= 65 ? '#fff7e6' : 'var(--surface2)',
                          color: item.score >= 80 ? '#cf1322' : item.score >= 65 ? '#d46b08' : 'var(--sub)',
                          border: '1px solid',
                          borderColor: item.score >= 80 ? '#ffa39e' : item.score >= 65 ? '#ffd591' : 'var(--line)'
                        }}>
                          {item.verdict}
                        </span>
                        <span style={{ fontSize: '12px', fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent)' }}>评分 {item.score}分</span>
                      </div>
                    </div>

                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                      gap: '8px',
                      padding: '8px 10px',
                      background: 'var(--surface2)',
                      borderRadius: '6px',
                      fontSize: '12px',
                      color: 'var(--text)',
                      marginBottom: '8px'
                    }}>
                      <div><span style={{ color: 'var(--mute)' }}>现价: </span><b style={{ color: 'var(--up)', fontFamily: 'monospace' }}>¥{f2(item.price)}</b> <span style={{ fontSize: '11px', color: 'var(--up)' }}>(+{item.chg.toFixed(1)}%)</span></div>
                      <div><span style={{ color: 'var(--mute)' }}>首封时点: </span><b style={{ fontFamily: 'monospace', color: item.fbt <= '09:35:00' ? '#cf1322' : 'inherit' }}>{item.fbt}</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>最后封板: </span><b style={{ fontFamily: 'monospace' }}>{item.lbt}</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>买一封单: </span><b style={{ color: '#cf1322', fontFamily: 'monospace' }}>{money$(item.fund)}</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>封成比: </span><b style={{ color: item.sealRatio >= 1.0 ? '#cf1322' : 'inherit', fontFamily: 'monospace' }}>{item.sealRatio.toFixed(2)}倍</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>换手率: </span><b style={{ fontFamily: 'monospace' }}>{item.turnover.toFixed(1)}%</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>成交额: </span><b style={{ fontFamily: 'monospace' }}>{money$(item.amount)}</b></div>
                      <div><span style={{ color: 'var(--mute)' }}>流通市值: </span><b style={{ fontFamily: 'monospace' }}>{money$(item.mcap)}</b></div>
                    </div>

                    <div style={{
                      padding: '6px 10px',
                      background: isAuctionBuy ? '#f0fdf4' : isRushBuy ? '#fff7ed' : isLocked ? '#f8fafc' : '#f0f9ff',
                      border: '1px dashed',
                      borderColor: isAuctionBuy ? '#86efac' : isRushBuy ? '#fdba74' : isLocked ? '#cbd5e1' : '#bae6fd',
                      borderRadius: '6px',
                      fontSize: '11.5px',
                      marginBottom: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <span>🎯 <b>买点指引：</b></span>
                      <span style={{ color: isLocked ? 'var(--mute)' : 'var(--text)' }}>{item.buyAction}</span>
                    </div>

                    <details style={{ marginBottom: '8px', fontSize: '11.5px' }}>
                      <summary style={{ cursor: 'pointer', color: '#0958d9', fontWeight: 600, userSelect: 'none', padding: '2px 0' }}>
                        ▾ 查看次日卖点预演与出场指引（高开怎么卖 / 平低开怎么抢跑）
                      </summary>
                      <div style={{ marginTop: '4px', padding: '6px 10px', borderRadius: '6px', background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155', lineHeight: '1.5' }}>
                        <div style={{ color: '#0958d9', fontWeight: 700, marginBottom: '2px' }}>🎯 {nextDayPlan}</div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          <b>超短四档出场铁律：</b>① 大高开(&gt;+4%)锁仓，冲高不板且放量滞涨止盈一半；② 小高开冲高至+4%先落袋半仓；③ 平开5分钟内不翻红逢抽保本走；④ 恶劣低开第一时间挂跌停止损，绝不幻想日内反包！
                        </div>
                      </div>
                    </details>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ fontSize: '11.5px', color: 'var(--sub)', display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 260px' }}>
                        <span style={{ fontWeight: 700, color: item.riskLevel === '高' ? '#cf1322' : item.riskLevel === '中偏高' ? '#d46b08' : '#389e0d', flexShrink: 0 }}>
                          [{item.riskLevel}风险]
                        </span>
                        <span>{item.riskDesc}</span>
                      </div>

                      <BoardStockActions
                        stock={item}
                        inPoolCodes={inPoolCodes}
                        herdCodeSet={herdCodeSet}
                        herdBusyCode={herdBusyCode}
                        onHerdAction={handleHerdAction}
                        onAddSingle={handleAddSingle}
                        onSelectStock={onSelectStock}
                        onJumpHerd={() => setFilterTier('herd')}
                        onJumpIgnition={onJumpIgnition}
                        readOnlyHistory={isHistoryReplay}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右侧：炒作风口榜（支持展开具体涨停股一键加自选） + 跨行业字辈暗线 + 打板军规 */}
        <div className="board-main-sidebar">
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text)' }}>🔥 今日炒作风口排行</div>
              <span style={{ fontSize: '11px', color: 'var(--mute)' }}>点击筛选 · 领涨可加自选</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {hotThemes.slice(0, 10).map((th, idx) => {
                const isSelected = selectedTheme === th.name;
                const ldrCode = String(th.leaderCode || '').padStart(6, '0');
                const ldrInPool = ldrCode && inPoolCodes.has(ldrCode);
                return (
                  <div
                    key={th.name}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '5px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      background: isSelected ? '#e6f4ff' : 'var(--surface2)',
                      border: isSelected ? '1px solid #91caff' : '1px solid transparent',
                      fontSize: '12px'
                    }}
                  >
                    <div
                      onClick={() => setSelectedTheme(isSelected ? 'all' : th.name)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                        <span style={{ width: '18px', height: '18px', borderRadius: '4px', background: idx < 3 ? '#cf1322' : 'var(--mute)', color: '#fff', fontSize: '10.5px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {idx + 1}
                        </span>
                        <span style={{ fontWeight: isSelected ? 800 : 600, color: isSelected ? '#0958d9' : 'var(--text)', whiteSpace: 'nowrap' }}>{th.name}</span>
                      </div>
                      <span style={{ background: '#fff1f0', color: '#cf1322', padding: '1px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>
                        {th.count}家
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', fontSize: '11px', color: 'var(--sub)' }}>
                      <span>领涨: <b>{th.leader}</b> ({th.maxLbc}板)</span>
                      {ldrCode && ldrCode !== '000000' && (
                        <button
                          type="button"
                          className={`board-mini-pill-btn ${ldrInPool ? 'in-pool' : 'add-pool'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (ldrInPool) {
                              if (onSelectStock) onSelectStock(ldrCode);
                            } else {
                              handleAddSingle(ldrCode, th.leader, th.stocks?.[0]);
                            }
                          }}
                        >
                          {ldrInPool ? '✓自选' : '＋自选'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {mysticClusters.length > 0 && (
            <div style={{ background: '#faf5ff', border: '1px solid #d8b4fe', borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 800, color: '#6d28d9' }}>🔮 跨行业字辈暗线</span>
                <span style={{ fontSize: '10.5px', color: '#7c3aed' }}>同字根≥2板</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {mysticClusters.slice(0, 6).map(cl => {
                  const tKey = `字辈·${cl.name}`;
                  const active = selectedTheme === tKey && filterTier === 'strong';
                  return (
                    <div
                      key={cl.name}
                      style={{
                        padding: '7px 9px',
                        borderRadius: '6px',
                        background: active ? '#f3e8ff' : '#fff',
                        border: active ? '1px solid #9333ea' : '1px solid #e9d5ff',
                        fontSize: '11.5px',
                      }}
                    >
                      <div
                        onClick={() => {
                          setFilterTier('strong');
                          if (!active) {
                            setStrongMinTags(1);
                            setStrongOnlyNonZt(false);
                          }
                          setSelectedTheme(active ? 'all' : tKey);
                        }}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: '4px' }}
                      >
                        <b style={{ color: '#6d28d9' }}>{cl.name}</b>
                        <span style={{ fontWeight: 800, color: '#7c3aed', fontSize: '11px' }}>{cl.ztCount}板 →</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {(cl.leaders || []).map(l => {
                          const lc = String(l.code || '').padStart(6, '0');
                          const inT = inPoolCodes.has(lc);
                          return (
                            <span
                              key={lc}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                padding: '1px 5px',
                                borderRadius: '4px',
                                background: '#faf5ff',
                                border: '1px solid #e9d5ff',
                                fontSize: '10.5px',
                              }}
                            >
                              <span>{l.name}({l.lbc}板)</span>
                              <button
                                type="button"
                                className={`board-mini-pill-btn ${inT ? 'in-pool' : 'add-pool'}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (inT) {
                                    if (onSelectStock) onSelectStock(lc);
                                  } else {
                                    handleAddSingle(lc, l.name, l);
                                  }
                                }}
                                title={inT ? '已在自选池，点击去作战台' : '一键加入自选池'}
                              >
                                {inT ? '✓' : '＋'}
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{
            background: 'linear-gradient(180deg, #fff7e6, #fff)',
            border: '1.5px solid #ffd591',
            borderRadius: '10px',
            padding: '14px',
            boxShadow: '0 2px 8px rgba(250, 140, 22, 0.08)'
          }}>
            <div style={{ fontSize: '13.5px', fontWeight: 800, color: '#d46b08', marginBottom: '8px' }}>⚡ 游资打板「四不打」铁律</div>
            <div style={{ fontSize: '12px', color: 'var(--text)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div>
                <b style={{ color: '#cf1322' }}>① 尾盘偷袭板不打：</b>
                <span style={{ color: 'var(--sub)' }}>14:30 以后偷袭封板的标的，主力大多缺乏真金白银，次日开盘低开被砸率高达 72%。</span>
              </div>
              <div>
                <b style={{ color: '#cf1322' }}>② 弱质虚封板不打：</b>
                <span style={{ color: 'var(--sub)' }}>封成比低于 0.3 且买一封单不足 2000 万的弱板不排，极易遭遇空头反扑砸成天地板。</span>
              </div>
              <div>
                <b style={{ color: '#cf1322' }}>③ 巨量炸板板不打：</b>
                <span style={{ color: 'var(--sub)' }}>日内反复炸板 2 次以上且换手率超过 30% 的高位分歧板，筹码剧烈松动，严禁打板接飞刀。</span>
              </div>
              <div>
                <b style={{ color: '#cf1322' }}>④ 严防资金混淆：</b>
                <span style={{ color: 'var(--sub)' }}>打板失利时必须在次日开盘坚决按纪律平仓，严禁动用 70% 底仓资金向下补仓变成股东！</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
