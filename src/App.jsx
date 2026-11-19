'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from './components/Header.jsx';
import TopNav from './components/TopNav.jsx';
import TradePage from './views/TradePage.jsx';
import TailPage from './views/TailPage.jsx';
import AccountPage from './views/AccountPage.jsx';
import LedgerPage from './views/LedgerPage.jsx';
import RulesPage from './views/RulesPage.jsx';
import DiagnosisPage from './views/DiagnosisPage.jsx';
import BoardPage from './views/BoardPage.jsx';
import IgnitionPage from './views/IgnitionPage.jsx';
import PerfPage from './views/PerfPage.jsx';
import { QuickTModal, StockReasonModal, TradingClockModal, ToastHost, OvernightBanner, AlertCenterModal } from './components/Modals.jsx';
import PostMarketModal from './components/PostMarketModal.jsx';

import { SITE_META, APP_PAGE_TITLE, STORAGE_KEYS, DEFAULT_POOL } from './data/site.js';
import useRoute from './router/useRoute.js';
import { todayStr, nowTimeHHMM, f2, money, toast, toastOk, toastWarn, toastErr, setToastListener, copyPlain, getTodayTStatus } from './services/utils.js';
import {
  loadStock,
  loadChart,
  loadResearch,
  loadMarket,
  fetchQuotes,
  tcodeFromCode,
  calc,
  addByQuery,
  selfTest,
  checkPriceAlerts,
  checkIntradayAnomalies,
  checkMarketAlerts,
  simulateIntradayAnomaly,
  refreshSingleFastRt,
  isAShareTradingNow,
  fetchUserVault,
  saveUserVault,
  fetchCoachReview,
  triggerStrategySnapshot,
  MKT,
} from './services/api.js';
import { syncRuntimeState } from './services/state.js';
import { registerChartLoader } from './services/chart.js';
import { getTailBuyCandidates } from './services/tail.js';
import { auditTradeExecution } from './services/ledger.js';
import {
  loadEodArchives,
  saveEodArchives,
  isPostMarketWindowNow,
  inspectPostMarketPositions,
  buildPostMarketSnapshot,
  buildEodBriefMarkdown,
} from './services/eod.js';
import {
  loadPosRules,
  savePosRules,
  loadTiltOverride,
  saveTiltOverride,
  computeDailyTiltState,
} from './services/risk.js';

export default function App() {
  /* ================= 1. 响应式 URL 路由与核心状态 ================= */
  const { path, activeTab, navigate, query } = useRoute();

  const [pool, setPool] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.POOL);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_POOL));
  });

  const [initialCapital, setInitialCapital] = useState(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEYS.ACCOUNT_TOTAL);
      if (v && +v > 0) return +v;
    } catch (_) {}
    return 100000;
  });

  const [tradeLogs, setTradeLogs] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TRADE_LOG);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  });

  const [tailActives, setTailActives] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TAIL_ACTIVE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {}
    return [];
  });

  const [availableCash, setAvailableCash] = useState(() => {
    try {
      const savedCash = localStorage.getItem(STORAGE_KEYS.ACCOUNT_CASH);
      if (savedCash !== null && savedCash !== '' && Number.isFinite(+savedCash) && +savedCash >= 0) {
        return Math.round(+savedCash * 100) / 100;
      }
      const savedTotal = (() => {
        const v = localStorage.getItem(STORAGE_KEYS.ACCOUNT_TOTAL);
        return v && +v > 0 ? +v : 100000;
      })();
      let initPool = DEFAULT_POOL;
      try {
        const rawP = localStorage.getItem(STORAGE_KEYS.POOL);
        if (rawP) initPool = JSON.parse(rawP);
      } catch (_) {}
      let initTail = [];
      try {
        const rawT = localStorage.getItem(STORAGE_KEYS.TAIL_ACTIVE);
        if (rawT) {
          const pT = JSON.parse(rawT);
          if (Array.isArray(pT)) initTail = pT;
        }
      } catch (_) {}
      const costBasis =
        (initPool || []).reduce((acc, s) => acc + (+s.shares || 0) * (+s.cost || +s.price || 0), 0) +
        (initTail || []).reduce((acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.cost || 0)), 0);
      return Math.max(0, Math.round((savedTotal - costBasis) * 100) / 100);
    } catch (_) {
      return 19900;
    }
  });

  const [snapshots, setSnapshots] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SNAPSHOTS);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  });

  // 15:05 盘后归档简报记录（留存近30个交易日）
  const [eodArchives, setEodArchives] = useState(() => loadEodArchives());
  const [eodModalOpen, setEodModalOpen] = useState(false);
  const [eodRunning, setEodRunning] = useState(false);
  const [eodSteps, setEodSteps] = useState({});

  const [posRules, setPosRules] = useState(() => loadPosRules());
  const [tiltOverride, setTiltOverride] = useState(() => loadTiltOverride());

  const [vaultStatus, setVaultStatus] = useState({
    connected: false,
    syncing: false,
    updatedAt: '',
    backupCount: 0,
    guarded: false,
    remoteSummary: null,
    remoteVault: null,
  });
  const vaultReadyRef = useRef(false);

  const handleUpdatePosRules = useCallback((next) => {
    setPosRules(next);
    savePosRules(next);
  }, []);

  syncRuntimeState({ pool, logs: tradeLogs, snapshots, tailActives });

  const [clockPhase, setClockPhase] = useState('盘中时钟');
  const [quoteStamp, setQuoteStamp] = useState('—');
  const [isStale, setIsStale] = useState(false);
  const [dbStatus, setDbStatus] = useState('');
  const [notifyActive, setNotifyActive] = useState(() => {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted';
  });
  const [alertEnabled, setAlertEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem('t-alert-enabled');
      return raw !== null ? JSON.parse(raw) : true;
    } catch (_) {
      return true;
    }
  });

  const [fastRefresh, setFastRefresh] = useState(() => {
    try {
      const raw = localStorage.getItem('t-fast-refresh');
      return raw !== null ? JSON.parse(raw) : true;
    } catch (_) {
      return true;
    }
  });

  const handleToggleFastRefresh = useCallback(() => {
    setFastRefresh(prev => {
      const next = !prev;
      try {
        localStorage.setItem('t-fast-refresh', JSON.stringify(next));
      } catch (_) {}
      toastOk(next ? '⚡ 已开启当前股 8 秒极速分时盯盘' : '已暂停 8 秒极速轮询（保留 60 秒常规刷新）');
      return next;
    });
  }, []);
  const [wbLatest, setWbLatest] = useState(() => {
    return typeof window !== 'undefined' ? (window.WB_LATEST || null) : null;
  });

  /* Modals 状态 */
  const [quickTModal, setQuickTModal] = useState({ open: false, stock: null });
  const [reasonModal, setReasonModal] = useState({ open: false, stock: null, inPool: false });
  const [clockModalOpen, setClockModalOpen] = useState(false);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [overnightBannerOpen, setOvernightBannerOpen] = useState(false);
  const [simTailAlert, setSimTailAlert] = useState(false);
  const [toasts, setToasts] = useState([]);

  const [activeStockCode, setActiveStockCode] = useState(() => (pool[0]?.code || ''));

  useEffect(() => {
    if (pool && pool.length > 0) {
      const code6 = String(activeStockCode).padStart(6, '0');
      if (!pool.some(s => String(s.code).padStart(6, '0') === code6)) {
        setActiveStockCode(String(pool[0].code).padStart(6, '0'));
      }
    }
  }, [pool, activeStockCode]);

  const handleSelectStock = useCallback((code) => {
    const code6 = String(code).padStart(6, '0');
    setActiveStockCode(code6);
    if (activeTab !== 'tabConsole') {
      navigate('/trade');
    }
    setTimeout(() => {
      const cardEl = document.getElementById(`detailDrawer_${code6}`) || document.getElementById(`stockCard_${code6}`) || document.getElementById('secPlan');
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        cardEl.classList.remove('card-highlight-pulse');
        void cardEl.offsetWidth;
        cardEl.classList.add('card-highlight-pulse');
      }
    }, 120);
  }, [activeTab, navigate]);

  const handleJumpDiagnosis = useCallback((code) => {
    const code6 = String(code || '').trim().padStart(6, '0');
    if (!code6 || code6 === '000000') return;
    setActiveStockCode(code6);
    navigate(`/diagnosis?code=${code6}`);
  }, [navigate]);

  const handleJumpIgnition = useCallback((code) => {
    const code6 = String(code || '').trim().padStart(6, '0');
    if (!code6 || code6 === '000000') return;
    setActiveStockCode(code6);
    navigate(`/ignition?code=${code6}`);
  }, [navigate]);

  const lastSuccessStamp = useRef(Date.now());
  const importInputRef = useRef(null);

  /* 状态落盘浏览器持久化 */
  useEffect(() => {
    try {
      const slim = pool.map(s => {
        const o = {};
        Object.keys(s).forEach(k => { if (k.charAt(0) !== '_') o[k] = s[k]; });
        return o;
      });
      localStorage.setItem(STORAGE_KEYS.POOL, JSON.stringify(slim));
    } catch (_) {}
  }, [pool]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, activeTab); } catch (_) {}
  }, [activeTab]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.ACCOUNT_TOTAL, String(initialCapital)); } catch (_) {}
  }, [initialCapital]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.ACCOUNT_CASH, String(availableCash)); } catch (_) {}
  }, [availableCash]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.TRADE_LOG, JSON.stringify(tradeLogs)); } catch (_) {}
  }, [tradeLogs]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.TAIL_ACTIVE, JSON.stringify(tailActives)); } catch (_) {}
  }, [tailActives]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.SNAPSHOTS, JSON.stringify(snapshots)); } catch (_) {}
  }, [snapshots]);

  useEffect(() => {
    saveEodArchives(eodArchives);
  }, [eodArchives]);

  /* 将磁盘金库对象应用到 React 全站状态 */
  const applyVaultData = useCallback((v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.pool) && v.pool.length > 0) setPool(v.pool);
    if (Array.isArray(v.logs)) setTradeLogs(v.logs);
    if (Array.isArray(v.tailActives)) setTailActives(v.tailActives);
    if (Array.isArray(v.snapshots)) setSnapshots(v.snapshots);
    if (Array.isArray(v.eodArchives) && v.eodArchives.length > 0) {
      setEodArchives(v.eodArchives);
    }
    if (v.posRules && typeof v.posRules === 'object') {
      const mergedRules = { ...loadPosRules(), ...v.posRules };
      setPosRules(mergedRules);
      savePosRules(mergedRules);
    }
    if (Number.isFinite(+v.initialCapital) && +v.initialCapital > 0) {
      setInitialCapital(+v.initialCapital);
    }
    if (v.availableCash !== undefined && Number.isFinite(+v.availableCash)) {
      setAvailableCash(Math.max(0, +v.availableCash));
    }
  }, []);

  /* 启动时握手本机磁盘金库 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchUserVault();
        if (cancelled) return;
        const localEmpty =
          (tradeLogsRef.current || []).length === 0 &&
          (tailActivesRef.current || []).length === 0 &&
          (snapshotsRef.current || []).length === 0 &&
          (eodArchivesRef.current || []).length === 0;
        const remoteHasRecords =
          res?.exists &&
          res?.vault &&
          ((res.summary?.logCount || 0) > 0 || (res.summary?.snapshotCount || 0) > 0 || (res.summary?.tailCount || 0) > 0);

        if (localEmpty && remoteHasRecords) {
          applyVaultData(res.vault);
          setVaultStatus({
            connected: true,
            syncing: false,
            updatedAt: res.summary?.updatedAt || '',
            backupCount: (res.backups || []).length,
            guarded: false,
            remoteSummary: res.summary,
            remoteVault: res.vault,
          });
          toastOk(`💾 已从本地磁盘金库自动找回 ${res.summary?.logCount || 0} 笔实盘台账与持仓配置！`);
          setTimeout(() => handleRefreshRef.current?.(true), 250);
        } else {
          setVaultStatus({
            connected: true,
            syncing: false,
            updatedAt: res?.summary?.updatedAt || '',
            backupCount: (res?.backups || []).length,
            guarded: false,
            remoteSummary: res?.summary || null,
            remoteVault: res?.vault || null,
          });
        }
        vaultReadyRef.current = true;
      } catch (_) {
        if (!cancelled) {
          setVaultStatus(prev => ({ ...prev, connected: false, syncing: false }));
          vaultReadyRef.current = false;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [applyVaultData]);

  /* 执行一次本地磁盘金库双写 */
  const performVaultSync = useCallback(async (force = false, showSuccessToast = false, overrides = {}) => {
    const srcPool = overrides.pool || poolRef.current || [];
    const slimPool = srcPool.map(s => {
      const o = {};
      Object.keys(s).forEach(k => { if (k.charAt(0) !== '_') o[k] = s[k]; });
      return o;
    });
    setVaultStatus(prev => ({ ...prev, syncing: true }));
    try {
      const res = await saveUserVault({
        pool: slimPool,
        logs: overrides.logs || tradeLogsRef.current || [],
        tailActives: overrides.tailActives || tailActivesRef.current || [],
        snapshots: overrides.snapshots || snapshotsRef.current || [],
        eodArchives: overrides.eodArchives || eodArchivesRef.current || [],
        posRules: posRulesRef.current || {},
        initialCapital: initCapRef.current || 100000,
        availableCash: cashRef.current || 0,
        force,
      });
      if (res.guarded) {
        setVaultStatus(prev => ({
          ...prev,
          connected: true,
          syncing: false,
          guarded: true,
          remoteSummary: res.existingSummary || prev.remoteSummary,
          remoteVault: res.vault || prev.remoteVault,
        }));
        if (showSuccessToast) {
          toastWarn(res.reason || '已触发磁盘金库防误覆盖保护');
        }
        return res;
      }
      setVaultStatus({
        connected: true,
        syncing: false,
        updatedAt: res.updatedAt || '',
        backupCount: (res.backups || []).length,
        guarded: false,
        remoteSummary: res.summary || null,
        remoteVault: null,
      });
      vaultReadyRef.current = true;
      if (showSuccessToast) {
        toastOk(`💾 已双写保存至本地磁盘 data/user_vault.json（含按日快照备份）`);
      }
      return res;
    } catch (_) {
      setVaultStatus(prev => ({ ...prev, connected: false, syncing: false }));
      if (showSuccessToast) {
        toastWarn('当前未检测到本地 FastAPI 后端，数据已保存在浏览器本地存储（也可点导出 JSON）');
      }
      return null;
    }
  }, []);

  const handleRestoreFromVault = useCallback(async () => {
    try {
      const res = await fetchUserVault();
      if (res?.exists && res?.vault) {
        applyVaultData(res.vault);
        setVaultStatus(prev => ({
          ...prev,
          connected: true,
          guarded: false,
          updatedAt: res.summary?.updatedAt || prev.updatedAt,
          backupCount: (res.backups || []).length,
        }));
        toastOk(`✓ 已从本地磁盘金库恢复全部持仓与 ${res.summary?.logCount || 0} 笔成交流水！`);
        setTimeout(() => handleRefreshRef.current?.(true), 200);
      } else {
        toastWarn('本地磁盘尚未生成金库备份文件');
      }
    } catch (err) {
      toastErr('读取本地磁盘金库失败：' + err.message);
    }
  }, [applyVaultData]);

  const vaultPersistSig = useMemo(() => {
    const slimP = (pool || []).map(s => ({
      code: s.code,
      name: s.name,
      shares: s.shares || 0,
      cost: s.cost || 0,
      tier: s.tier || 'short',
      memo: s.memo || '',
      strategyTag: s.strategyTag || '',
      unclosedTQty: s.unclosedTQty || 0,
    }));
    return JSON.stringify({
      p: slimP,
      lLen: tradeLogs.length,
      lTop: tradeLogs[0]?.id || 0,
      lRef: (tradeLogs || []).map(x => `${x.id}:${(x.mistakeTags || []).join(',')}:${x.reflection || ''}`).join('|'),
      t: (tailActives || []).map(x => `${x.id}:${x.shares}:${x.cost}`),
      s: (snapshots || []).map(x => `${x.date}:${x.total}`),
      eod: (eodArchives || []).map(x => `${x.date}:${x.archivedAt}`),
      r: posRules,
      ic: initialCapital,
      ac: Math.round(availableCash * 100) / 100,
    });
  }, [pool, tradeLogs, tailActives, snapshots, eodArchives, posRules, initialCapital, availableCash]);

  useEffect(() => {
    if (!vaultReadyRef.current) return undefined;
    const timer = setTimeout(() => {
      performVaultSync(false, false);
    }, 1200);
    return () => clearTimeout(timer);
  }, [vaultPersistSig, performVaultSync]);

  /* 读取选股引擎统一数据契约 */
  const fetchContract = useCallback(async () => {
    try {
      const r = await fetch('/data/latest.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      window.WB_LATEST = data;
      setWbLatest(data);
      return data;
    } catch (error) {
      console.error('[T-Stock] 选股契约读取失败', error);
      setDbStatus('选股契约读取失败：' + error.message);
      return null;
    }
  }, []);

  useEffect(() => {
    fetchContract();
    const timer = setInterval(fetchContract, 30000);
    return () => clearInterval(timer);
  }, [fetchContract]);

  /* 注册全局图表自愈装载器与 Toast 分发器 */
  useEffect(() => {
    registerChartLoader(loadChart);
    window.render = (p) => {
      if (p) setPool([...p]);
    };
    setToastListener(t => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id));
      }, t.ms || 3600);
    });
    return () => {
      delete window.render;
    };
  }, []);

  /* 计算真实资产、主池市值、尾盘隔夜市值与实时总仓位 */
  const poolMarketValue = pool.reduce((acc, s) => acc + (+s.shares || 0) * (+s.price || +s.cost || 0), 0);
  const tailMarketValue = tailActives.reduce(
    (acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)),
    0
  );
  const marketValue = Math.round((poolMarketValue + tailMarketValue) * 100) / 100;
  const cash = Math.max(0, Math.round(availableCash * 100) / 100);
  const totalAssets = Math.round((cash + marketValue) * 100) / 100;
  const posRate = totalAssets > 0 ? (marketValue / totalAssets) * 100 : 0;

  /* 实时计算单日防上头熔断状态 */
  const tiltState = useMemo(
    () =>
      computeDailyTiltState({
        tradeLogs,
        pool,
        tailActives,
        totalAssets,
        posRules,
        tiltOverride,
      }),
    [tradeLogs, pool, tailActives, totalAssets, posRules, tiltOverride]
  );

  const handleUnlockTilt = useCallback(() => {
    const ov = {
      date: todayStr(),
      unlockedAt: Date.now(),
      lossCountAtUnlock: tiltState.todayLossCount,
      lossPctAtUnlock: tiltState.effectiveLossPct,
    };
    setTiltOverride(ov);
    saveTiltOverride(ov);
    toastWarn('🧘 已进入熔断冷静观察期：若今日再新增 1 笔亏损或回撤扩大 ≥0.5%，将触发全天二次硬锁死');
  }, [tiltState]);

  const handleRelockTilt = useCallback(() => {
    setTiltOverride(null);
    saveTiltOverride(null);
    toastOk('🔒 已重新开启单日防上头熔断锁，管住手保住本金');
  }, []);

  const handleSimulateAnomaly = useCallback(() => {
    const res = simulateIntradayAnomaly(poolRef.current);
    setPool([...(poolRef.current || [])]);
    return res;
  }, []);

  const unclosedStocks = pool.map(s => {
    const t = getTodayTStatus(s, tradeLogs);
    return t.hasUnclosed ? { stock: s, ...t } : null;
  }).filter(Boolean);

  const liveEodPositionCheck = useMemo(
    () => inspectPostMarketPositions({ pool, tailActives, tradeLogs }),
    [pool, tailActives, tradeLogs]
  );

  const todayArchived = useMemo(
    () => (eodArchives || []).some(a => a && a.date === todayStr()),
    [eodArchives]
  );

  const nowTime = new Date();
  const currentMins = nowTime.getHours() * 60 + nowTime.getMinutes();
  const currentWd = nowTime.getDay();
  const isWeekendNow = (currentWd === 0 || currentWd === 6);
  const isTailAlertTime = (!isWeekendNow && currentMins >= 880 && currentMins < 900);
  const isPostMarketWindow = isPostMarketWindowNow(nowTime);

  const poolRef = useRef(pool);
  poolRef.current = pool;
  const tailActivesRef = useRef(tailActives);
  tailActivesRef.current = tailActives;
  const cashRef = useRef(cash);
  cashRef.current = cash;
  const tradeLogsRef = useRef(tradeLogs);
  tradeLogsRef.current = tradeLogs;
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const eodArchivesRef = useRef(eodArchives);
  eodArchivesRef.current = eodArchives;
  const posRulesRef = useRef(posRules);
  posRulesRef.current = posRules;
  const initCapRef = useRef(initialCapital);
  initCapRef.current = initialCapital;
  const wbLatestRef = useRef(wbLatest);
  wbLatestRef.current = wbLatest;

  /* 收盘后（工作日 15:05+）自动归档今日收盘净值快照 */
  const maybeAutoSnapshot = useCallback((nextPool, nextTail) => {
    const now = new Date();
    const wd = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (wd < 1 || wd > 5 || mins < 15 * 60 + 5) return;

    const pList = nextPool || poolRef.current || [];
    const tList = nextTail || tailActivesRef.current || [];
    const pMkt = pList.reduce((acc, s) => acc + (+s.shares || 0) * (+s.price || +s.cost || 0), 0);
    const tMkt = tList.reduce((acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)), 0);
    const mkt = Math.round((pMkt + tMkt) * 100) / 100;
    const curCash = Math.max(0, Math.round((cashRef.current || 0) * 100) / 100);
    const tot = Math.round((curCash + mkt) * 100) / 100;
    if (mkt <= 0 && (tradeLogsRef.current || []).length === 0) return;

    const today = todayStr();
    const rateStr = tot > 0 ? ((mkt / tot) * 100).toFixed(1) : '0.0';
    setSnapshots(prev => {
      const existing = prev.find(x => x.date === today);
      if (existing && Math.abs((+existing.total || 0) - tot) < 1) return prev;
      const snap = { date: today, total: tot, mkt, cash: curCash, rate: rateStr };
      return [snap, ...prev.filter(x => x.date !== today)];
    });
  }, []);

  /* 时钟与盘中时段更新 */
  const updateClock = useCallback(() => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const mins = h * 60 + m;
    const wd = now.getDay();
    const isWeekend = (wd === 0 || wd === 6);

    let phase = '已休市';
    if (!isWeekend) {
      if (mins >= 555 && mins < 565) phase = '集合竞价 (09:15-09:25)';
      else if (mins >= 565 && mins < 570) phase = '竞价定盘 (09:25-09:30)';
      else if (mins >= 570 && mins < 585) phase = '情绪博弈期 (09:30-09:45 严禁追高)';
      else if (mins >= 585 && mins < 630) phase = '做T黄金窗口 (09:45-10:30 低吸正T)';
      else if (mins >= 630 && mins < 690) phase = '震荡巩固 (10:30-11:30)';
      else if (mins >= 690 && mins < 780) phase = '午间休市 (11:30-13:00)';
      else if (mins >= 780 && mins < 840) phase = '缩量垃圾时间 (13:00-14:00 管住手)';
      else if (mins >= 840 && mins < 880) phase = '变盘预警 (14:00-14:40 警惕跳水)';
      else if (mins >= 880 && mins < 895) phase = '🚨 14:40 尾盘清T平仓 (14:40-14:55 绝不过夜)';
      else if (mins >= 895 && mins < 900) phase = '尾盘定盘 (14:55-15:00)';
      else if (mins >= 900 && mins < 960) phase = '🏁 15:05 收盘复盘归档窗口';
    }
    setClockPhase(`${timeStr} ${phase}`);

    if (!isWeekend && mins >= 880 && mins < 895) {
      const hasUnclosed = (poolRef.current || []).some(st => getTodayTStatus(st, tradeLogs).hasUnclosed);
      if (hasUnclosed) setOvernightBannerOpen(true);
    }
  }, [tradeLogs]);

  /* 行情全量刷新 */
  const handleRefresh = useCallback(async (silent = false) => {
    fetchContract();
    const currentPool = poolRef.current || [];
    const currentTail = tailActivesRef.current || [];

    if (!currentPool.length && !currentTail.length) {
      setDbStatus('自选池是空的 —— 在上方输入 6 位代码或股票名称加入池。');
      return;
    }

    if (!silent) setDbStatus('正在获取全市场实时行情与前复权K线…');

    const errs = [];
    const mktTask = loadMarket(false).catch(() => null);

    const stockTasks = currentPool.map(async s => {
      try {
        await loadStock(s);
        await loadChart(s, true);
        await loadResearch(s, false);
        return null;
      } catch (e) {
        return (s.name || s.code) + ' (' + e.message + ')';
      }
    });

    const tailTask = (async () => {
      if (!currentTail.length) return null;
      const tcodes = Array.from(
        new Set(
          currentTail
            .map(t => t.tcode || tcodeFromCode(String(t.code || '').padStart(6, '0')))
            .filter(Boolean)
        )
      );
      if (!tcodes.length) return null;
      try {
        const qMap = await fetchQuotes(tcodes);
        const nextTail = currentTail.map(t => {
          const tc = t.tcode || tcodeFromCode(String(t.code || '').padStart(6, '0'));
          const q = tc ? qMap[tc] : null;
          if (q && (+q.price > 0 || +q.prevClose > 0)) {
            return { ...t, tcode: tc, price: +q.price > 0 ? +q.price : +q.prevClose, prevClose: +q.prevClose || t.prevClose };
          }
          return t;
        });
        setTailActives(nextTail);
        tailActivesRef.current = nextTail;
        return nextTail;
      } catch (_) {
        return null;
      }
    })();

    const [, updatedTail, ...results] = await Promise.all([mktTask, tailTask, ...stockTasks]);
    results.forEach(x => { if (x) errs.push(x); });

    checkPriceAlerts(currentPool);
    checkIntradayAnomalies(currentPool);
    checkMarketAlerts();

    const nextPool = [...currentPool];
    setPool(nextPool);
    poolRef.current = nextPool;
    lastSuccessStamp.current = Date.now();
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    setQuoteStamp(timeStr);
    setIsStale(false);

    if (errs.length) {
      setDbStatus('部分标的行情未更新 → ' + errs.join('；'));
    } else {
      setDbStatus(`行情已更新 ${timeStr} · 来源：腾讯实时行情 + 腾讯前复权K线 + 指数环境闸门`);
    }

    if (!silent) toastOk('✓ 全市场实时行情与前复权K线已同步！');
    maybeAutoSnapshot(nextPool, updatedTail || currentTail);
  }, [fetchContract, maybeAutoSnapshot]);

  const activeStockCodeRef = useRef(activeStockCode);
  activeStockCodeRef.current = activeStockCode;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;
  const updateClockRef = useRef(updateClock);
  updateClockRef.current = updateClock;

  /* 🏁 15:05 盘后五步一键收盘归档工作流 */
  const handleRunEodWorkflow = useCallback(async () => {
    if (eodRunning) return;
    setEodRunning(true);
    const today = todayStr();

    setEodSteps({
      quotes: { status: 'running', note: '正在拉取最新收盘价…' },
      audit: { status: 'idle', note: '待执行' },
      snapshot: { status: 'idle', note: '待执行' },
      brief: { status: 'idle', note: '待执行' },
      vault: { status: 'idle', note: '待执行' },
    });

    // Step 1: 同步收盘行情与策略建档快照
    try {
      await Promise.allSettled([
        handleRefreshRef.current(true),
        triggerStrategySnapshot(),
      ]);
      setEodSteps(prev => ({
        ...prev,
        quotes: { status: 'done', note: '收盘价与前复权K线已同步' },
        audit: { status: 'running', note: '正在核查未平T与隔夜仓…' },
      }));
    } catch (_) {
      setEodSteps(prev => ({
        ...prev,
        quotes: { status: 'warn', note: '使用本地最新缓存价格继续' },
        audit: { status: 'running', note: '正在核查未平T与隔夜仓…' },
      }));
    }

    // Step 2: 排查未平做T仓与尾盘隔夜仓
    const posCheck = inspectPostMarketPositions({
      pool: poolRef.current || [],
      tailActives: tailActivesRef.current || [],
      tradeLogs: tradeLogsRef.current || [],
    });
    const unclosedCnt = posCheck.unclosedTList.length;
    const tailCnt = posCheck.overnightTailList.length;
    setEodSteps(prev => ({
      ...prev,
      audit: unclosedCnt > 0
        ? { status: 'warn', note: `发现 ${unclosedCnt} 只未平T仓需确认` }
        : { status: 'done', note: tailCnt > 0 ? `T仓清零 · 尾盘隔夜${tailCnt}只` : '全部T仓已清零无滞留' },
      snapshot: { status: 'running', note: '正在写入收盘净值快照…' },
    }));

    // Step 3: 归档今日收盘资产净值快照
    const snapRes = buildPostMarketSnapshot({
      date: today,
      pool: poolRef.current || [],
      tailActives: tailActivesRef.current || [],
      availableCash: cashRef.current || 0,
      initialCapital: initCapRef.current || 100000,
      prevSnapshots: snapshotsRef.current || [],
    });
    setSnapshots(snapRes.nextSnapshots);
    snapshotsRef.current = snapRes.nextSnapshots;
    setEodSteps(prev => ({
      ...prev,
      snapshot: { status: 'done', note: `总资产 ¥${money(snapRes.snapshot.total)} (${snapRes.snapshot.rate}%)` },
      brief: { status: 'running', note: '正在生成复盘与明日预案…' },
    }));

    // Step 4: 生成今日量化复盘与明日挂单简报
    const todayLogs = (tradeLogsRef.current || []).filter(l => l && l.date === today);
    const liveGate = MKT?.gate
      ? { level: MKT.gate.level, text: String(MKT.gate.title || '').replace(/<[^>]+>/g, '') }
      : null;
    const marketEnv = wbLatestRef.current?.env || liveGate || { level: 'OK', text: '大盘常态震荡' };

    let coachRes = null;
    if (todayLogs.length > 0) {
      try {
        coachRes = await fetchCoachReview({
          trades: todayLogs,
          date: today,
          marketEnv,
          mode: 'rule',
        });
      } catch (_) {
        coachRes = null;
      }
    }

    const briefRes = buildEodBriefMarkdown({
      date: today,
      snapshot: snapRes.snapshot,
      deltaInfo: snapRes.deltaInfo,
      todayLogs,
      pool: poolRef.current || [],
      wbLatest: wbLatestRef.current,
      positionCheck: posCheck,
      marketEnv,
      coachReview: coachRes,
    });

    const draftArchive = {
      date: today,
      archivedAt: nowTimeHHMM(),
      snapshot: snapRes.snapshot,
      deltaInfo: snapRes.deltaInfo,
      tradeCount: todayLogs.length,
      unclosedCount: unclosedCnt,
      overnightTailCount: tailCnt,
      disciplineScore: briefRes.disciplineScore,
      grade: briefRes.grade,
      todayRealizedNet: briefRes.todayRealizedNet,
      frictionLoss: briefRes.frictionLoss,
      briefMarkdown: briefRes.briefMarkdown,
      vaultSynced: false,
    };

    const prelimArchives = [
      draftArchive,
      ...(eodArchivesRef.current || []).filter(a => a && a.date !== today),
    ].slice(0, 30);
    setEodArchives(prelimArchives);
    eodArchivesRef.current = prelimArchives;

    setEodSteps(prev => ({
      ...prev,
      brief: { status: 'done', note: `纪律 ${briefRes.disciplineScore}分 · 简报已出炉` },
      vault: { status: 'running', note: '正在落盘本地磁盘金库…' },
    }));

    // Step 5: 双写落盘本地磁盘金库
    const vaultRes = await performVaultSync(false, false, {
      snapshots: snapRes.nextSnapshots,
      eodArchives: prelimArchives,
    });
    const syncedOk = Boolean(vaultRes && vaultRes.ok);
    const finalArchive = { ...draftArchive, vaultSynced: syncedOk };
    const finalArchives = [
      finalArchive,
      ...(eodArchivesRef.current || []).filter(a => a && a.date !== today),
    ].slice(0, 30);
    setEodArchives(finalArchives);
    eodArchivesRef.current = finalArchives;
    saveEodArchives(finalArchives);

    setEodSteps(prev => ({
      ...prev,
      vault: syncedOk
        ? { status: 'done', note: '已双写 user_vault.json' }
        : { status: 'warn', note: '已存浏览器(后端未启动)' },
    }));

    setEodRunning(false);
    toastOk(`🏁 今日 15:05 收盘归档完成！净值 ¥${money(snapRes.snapshot.total)}，纪律评分 ${briefRes.disciplineScore}/100`);
  }, [eodRunning, performVaultSync]);

  /* 一键将收盘未平T仓确认为「做T做反变加仓」并结转隔夜持仓 */
  const handleMarkOvernightT = useCallback((unclosedItem) => {
    if (!unclosedItem) return;
    const today = todayStr();
    const code6 = String(unclosedItem.code || '').padStart(6, '0');

    const nextPool = (poolRef.current || []).map(s => {
      if (String(s.code).padStart(6, '0') === code6) {
        return { ...s, unclosedTQty: 0, ignoreTailTDate: today };
      }
      return s;
    });
    setPool(nextPool);
    poolRef.current = nextPool;

    // 在今日对应开仓买单上自动打上 t_to_add（做T做反变加仓）归因标签
    let tagged = false;
    const nextLogs = (tradeLogsRef.current || []).map(lg => {
      if (
        !tagged &&
        lg &&
        lg.date === today &&
        (String(lg.code || '').padStart(6, '0') === code6 || String(lg.stock || '').includes(code6)) &&
        (+lg.buy > 0 && !(+lg.sell > 0))
      ) {
        tagged = true;
        const tags = Array.from(new Set([...(lg.mistakeTags || []), 't_to_add']));
        return {
          ...lg,
          plan: '计划外',
          mistakeTags: tags,
          disciplineScore: Math.max(20, (lg.disciplineScore || 90) - 20),
          reflection: lg.reflection
            ? `${lg.reflection}；[收盘核查] 日内T仓未平被动过夜变加仓`
            : '[15:05收盘核查] 正T买入后未在收盘前卖出，构成做T变加仓，明日早盘冲高优先减出',
        };
      }
      return lg;
    });
    setTradeLogs(nextLogs);
    tradeLogsRef.current = nextLogs;

    toastWarn(`🏷️ 已将【${unclosedItem.name}】记入「做T做反变加仓」并结转隔夜持仓，正在刷新收盘简报…`);
    setTimeout(() => handleRunEodWorkflow(), 80);
  }, [handleRunEodWorkflow]);

  /* 聚焦个股 8 秒极速增量轮询 */
  useEffect(() => {
    if (!fastRefresh) return undefined;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight || !isAShareTradingNow()) return;
      const tab = activeTabRef.current;
      if (tab !== 'tabConsole' && tab !== 'tabAll') return;
      const currentPool = poolRef.current;
      if (!currentPool || !currentPool.length) return;
      const focusCode = activeStockCodeRef.current;
      const target = (focusCode && currentPool.find(s => String(s.code).padStart(6, '0') === String(focusCode).padStart(6, '0'))) || currentPool[0];
      if (!target || (target.p || 'rt') !== 'rt') return;

      inFlight = true;
      try {
        await refreshSingleFastRt(target);
        checkPriceAlerts(currentPool);
        checkIntradayAnomalies([target]);
        const nextPool = currentPool.map(item => (item.code === target.code ? { ...target } : item));
        setPool(nextPool);
        lastSuccessStamp.current = Date.now();
        const d = new Date();
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        setQuoteStamp(timeStr);
        setIsStale(false);
      } catch (_) {
      } finally {
        inFlight = false;
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [fastRefresh]);

  /* 定时任务与生命周期 */
  useEffect(() => {
    updateClockRef.current();
    const clockTimer = setInterval(() => updateClockRef.current(), 1000);
    const staleTimer = setInterval(() => {
      const diffMin = (Date.now() - lastSuccessStamp.current) / 60000;
      setIsStale(diffMin > 3);
    }, 5000);

    const initialTimer = setTimeout(() => handleRefreshRef.current(true), 300);

    const autoRefreshTimer = setInterval(() => {
      const now = new Date();
      const wd = now.getDay();
      const mins = now.getHours() * 60 + now.getMinutes();
      if (isAShareTradingNow(now) || (wd >= 1 && wd <= 5 && mins >= 905 && mins <= 920)) {
        handleRefreshRef.current(true);
      }
    }, 60000);

    return () => {
      clearInterval(clockTimer);
      clearInterval(staleTimer);
      clearTimeout(initialTimer);
      clearInterval(autoRefreshTimer);
    };
  }, []);

  /* ================= 2. 用户操作交互 ================= */
  const handleUpdateStock = (updated) => {
    setPool(prev => prev.map(s => s.code === updated.code ? updated : s));
  };

  const handleRemoveStock = (index) => {
    const s = pool[index];
    if (window.confirm(`确定要将 ${s.name} (${s.code}) 从自选池移除吗？`)) {
      setPool(prev => prev.filter((_, i) => i !== index));
      toast('标的已从自选池移除', 'info');
    }
  };

  const handleAddBlank = () => {
    const blank = {
      name: '自定义标的',
      code: '000001',
      tcode: 'sz000001',
      prevClose: 10, open: 10, high: 10.2, low: 9.8, price: 10, avg: 10,
      vr: 1.0, ma5: 10, ma10: 10, ma20: 10, shares: 0, cost: 0, cap: 0,
      tier: 'short', p: 'day'
    };
    setPool(prev => [...prev, blank]);
    toastOk('已新增空白自定义标的，可展开参数调整');
  };

  const handleResetDefault = () => {
    if (window.confirm('确定要恢复默认股票数据吗？这将覆盖当前自选池。')) {
      const resetPool = JSON.parse(JSON.stringify(DEFAULT_POOL));
      const defaultCost = resetPool.reduce((acc, s) => acc + (+s.shares || 0) * (+s.cost || 0), 0);
      setPool(resetPool);
      setAvailableCash(Math.max(0, Math.round((initialCapital - defaultCost) * 100) / 100));
      toastOk('已恢复默认自选持仓数据并同步可用现金');
      setTimeout(() => handleRefreshRef.current(true), 120);
    }
  };

  const handleSaveLocal = () => {
    performVaultSync(false, true);
  };

  const handleAddStockByQuery = async (qStr, meta = null) => {
    toast('正在全市场检索标的…', 'info');
    try {
      const res = await addByQuery(qStr, poolRef.current);
      if (res && res.status === 'exists') {
        if (res.code) handleSelectStock(res.code);
        return;
      }
      const raw = localStorage.getItem(STORAGE_KEYS.POOL);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (meta && parsed.length > 0) {
          const c6 = String(res?.stock?.code || qStr).trim().padStart(6, '0');
          parsed = parsed.map(st => {
            if (String(st.code).padStart(6, '0') === c6 || st.name === qStr) {
              return {
                ...st,
                strategyTag: meta.strategyTag || '起爆',
                planStrategy: meta.strategy || 'ignition',
                ignitionMeta: meta,
              };
            }
            return st;
          });
          try {
            localStorage.setItem(STORAGE_KEYS.POOL, JSON.stringify(parsed));
          } catch (_) {}
        }
        setPool(parsed);
        const targetCode = res?.stock?.code || parsed[parsed.length - 1]?.code;
        if (targetCode) {
          handleSelectStock(targetCode);
        }
      }
      toastOk(`✓ 标的 ${res?.stock?.name || qStr} 已成功加入自选做T台！`);
    } catch (e) {
      toastErr('添加标的失败：' + e.message);
    }
  };

  const handleBatchAdd = (list, poolTag) => {
    const currentCodes = new Set(pool.map(s => String(s.code).padStart(6, '0')));
    const toAdd = list.filter(r => !currentCodes.has(String(r.code).padStart(6, '0')));
    if (!toAdd.length) {
      toastWarn('所选标的均已在自选池中');
      return;
    }

    const newItems = toAdd.map(r => {
      const code6 = String(r.code).padStart(6, '0');
      const tcode = r.tcode || ((code6.startsWith('6') || code6.startsWith('9')) ? 'sh' + code6 : 'sz' + code6);
      return {
        name: r.name,
        code: code6,
        tcode,
        prevClose: r.price || 10,
        open: r.price || 10,
        high: r.price || 10,
        low: r.price || 10,
        price: r.price || 10,
        avg: r.price || 10,
        vr: r.volRatio || 1.2,
        ma5: r.price || 10,
        ma10: r.price || 10,
        ma20: r.price || 10,
        shares: 0,
        cost: 0,
        cap: r.totalCap || 0,
        tier: poolTag === '短线' ? 'short' : 'long',
        poolTag
      };
    });

    setPool(prev => [...prev, ...newItems]);
    toastOk(`✓ 成功将 ${newItems.length} 只${poolTag}标的并入自选池！`);
    if (newItems.length === 1) {
      handleSelectStock(newItems[0].code);
    }
  };

  /* 买入建仓 / 买入加仓 / 底仓校准 */
  const handleBuyStock = ({ stock, qty, buy, isCalibration = false, newCostOverride, newSharesOverride }) => {
    if (!stock) return;

    if (isCalibration) {
      const sVal = parseInt(newSharesOverride, 10);
      const cVal = parseFloat(newCostOverride);
      const newShares = isNaN(sVal) || sVal < 0 ? 0 : sVal;
      const newCost = isNaN(cVal) || cVal < 0 ? 0 : Math.round(cVal * 100) / 100;
      handleUpdateStock({ ...stock, shares: newShares, cost: newCost });
      toastOk(`✅ 已成功校准【${stock.name}】底仓：${newShares} 股，成本均价 ¥${f2(newCost)}（底仓校准不扣减可用现金）`);
      return;
    }

    if (tiltState?.isLocked) {
      toastErr('🔒 单日防上头熔断保护中：已拦截新开仓/加仓买单（卖出止损与倒T不受影响）');
      return;
    }

    const oldShares = stock.shares || 0;
    const oldCost = stock.cost || 0;
    const buyQty = Math.max(0, parseInt(qty, 10) || 0);
    const buyPx = Math.max(0, parseFloat(buy) || 0);

    if (buyQty <= 0 || buyPx <= 0) {
      toastErr('请输入有效的买入股数与买入价格');
      return;
    }

    const fee = Math.round(buyQty * buyPx * 0.0003 * 100) / 100;
    const totalOutflow = Math.round((buyQty * buyPx + fee) * 100) / 100;
    if (totalOutflow > cash + 0.01) {
      toastWarn(`⚠️ 买入金额 ¥${money(totalOutflow)} 超出当前可用现金 ¥${money(cash)}，已将可用现金扣至 ¥0（可在账户页校准本金）`);
    }
    setAvailableCash(prev => Math.max(0, Math.round((prev - totalOutflow) * 100) / 100));

    const newShares = oldShares + buyQty;
    const totalCapital = oldShares * oldCost + buyQty * buyPx + fee;
    const newCost = Math.round((totalCapital / newShares) * 100) / 100;
    const isInitial = oldShares === 0;
    const dirName = isInitial ? '买入建仓' : '买入加仓';

    const audit = auditTradeExecution({
      stock,
      code: stock.code,
      dir: dirName,
      buy: buyPx,
      sell: 0,
      qty: buyQty,
      net: 0,
      plan: '自动判定',
      prevLogs: tradeLogs,
      wbLatest,
      poolList: pool,
      totalAssets,
    });

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      time: nowTimeHHMM(),
      code: String(stock.code || '').padStart(6, '0'),
      stock: `${stock.name} (${stock.code})`,
      track: audit.track,
      dir: dirName,
      buy: buyPx,
      sell: 0,
      qty: buyQty,
      gross: 0,
      fee,
      net: 0,
      plan: audit.plan,
      basis: audit.basis,
      mistakeTags: audit.mistakeTags,
      systemBenchmark: audit.systemBenchmark,
      alphaNet: audit.alphaNet,
      buyDevPct: audit.buyDevPct,
      sellDevPct: audit.sellDevPct,
      disciplineScore: audit.disciplineScore,
      note: isInitial
        ? `首次建仓 ${buyQty} 股，成交价 ¥${buyPx.toFixed(2)}，扣减现金 ¥${money(totalOutflow)}`
        : `买入加仓 ${buyQty} 股（成交价 ¥${buyPx.toFixed(2)}），持仓增至 ${newShares} 股，均价 ¥${newCost.toFixed(2)}`
    };

    setTradeLogs(prev => [newLog, ...prev]);
    handleUpdateStock({ ...stock, shares: newShares, cost: newCost });

    if (isInitial) {
      toastOk(`🎯 【${stock.name}】建仓成功！买入 ${buyQty} 股，扣减现金 ¥${money(totalOutflow)}`);
    } else {
      toastOk(`🚀 【${stock.name}】加仓成功！总持仓 ${newShares} 股，最新均价 ¥${f2(newCost)}`);
    }
  };

  /* 快捷记T提交 */
  const handleConfirmQuickT = ({ stock, dir, action, buy, sell, qty, netDiff, newCost, remainingShares }) => {
    const isDirectSell = action === 'sell' || dir === '直接卖出' || dir === '清仓卖出';
    const isDirectBuy = action === 'buy' || dir === '直接买入' || dir === '买入建仓' || dir === '买入加仓';

    if (isDirectBuy) {
      handleBuyStock({ stock, qty, buy });
      setQuickTModal({ open: false, stock: null });
      return;
    }

    if (!isDirectSell && dir === '正T' && tiltState?.isLocked) {
      toastErr('🔒 单日防上头熔断保护中：已拦截正T低吸，熔断期仅允许直接卖出减仓或倒T高抛');
      return;
    }

    const sellFee = Math.round((sell * qty) * 0.0008 * 100) / 100;
    const roundFee = Math.round(((buy || 0) * qty + sell * qty) * 0.00055 * 100) / 100;

    const audit = auditTradeExecution({
      stock,
      code: stock.code,
      dir,
      buy: buy || 0,
      sell: sell || 0,
      qty,
      net: netDiff,
      plan: '自动判定',
      prevLogs: tradeLogs,
      wbLatest,
      poolList: pool,
      totalAssets,
    });

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      time: nowTimeHHMM(),
      code: String(stock.code || '').padStart(6, '0'),
      stock: `${stock.name} (${stock.code})`,
      track: audit.track,
      dir,
      buy: buy || 0,
      sell: sell || 0,
      qty,
      gross: (sell - (buy || 0)) * qty,
      fee: isDirectSell ? sellFee : roundFee,
      net: netDiff,
      plan: audit.plan,
      basis: audit.basis,
      mistakeTags: audit.mistakeTags,
      systemBenchmark: audit.systemBenchmark,
      alphaNet: audit.alphaNet,
      buyDevPct: audit.buyDevPct,
      sellDevPct: audit.sellDevPct,
      disciplineScore: audit.disciplineScore,
      note: isDirectSell
        ? `${dir} ${qty} 股（卖出价 ¥${sell.toFixed(2)}，成本 ¥${(buy || 0).toFixed(2)}），净落袋 ¥${netDiff >= 0 ? '+' : ''}${netDiff.toFixed(2)}`
        : `快捷做T记入（纪律 ${audit.disciplineScore}分），净套利 ¥${netDiff >= 0 ? '+' : ''}${netDiff.toFixed(2)}`
    };

    setTradeLogs(prev => [newLog, ...prev]);

    if (isDirectSell) {
      const proceeds = Math.round((sell * qty - sellFee) * 100) / 100;
      setAvailableCash(prev => Math.round((prev + proceeds) * 100) / 100);

      const rem = remainingShares !== undefined ? remainingShares : Math.max(0, (stock.shares || 0) - qty);
      const updatedCost = rem === 0 ? 0 : stock.cost;
      handleUpdateStock({ ...stock, shares: rem, cost: updatedCost });
      toastOk(`✓ 卖出成功：回笼现金 ¥${money(proceeds)}，净盈亏 ${netDiff >= 0 ? '+' : ''}¥${netDiff.toFixed(2)}，剩余 ${rem} 股`);
    } else {
      setAvailableCash(prev => Math.max(0, Math.round((prev + (Number(netDiff) || 0)) * 100) / 100));
      if (stock.shares > 0 && newCost > 0) {
        handleUpdateStock({ ...stock, cost: newCost });
      }
      toastOk(`✓ 做T记录已入账（纪律 ${audit.disciplineScore}分）！净套利 ${netDiff >= 0 ? '+' : ''}¥${netDiff.toFixed(2)} 已计入可用现金`);
    }

    setQuickTModal({ open: false, stock: null });
  };

  /* 尾盘潜伏建仓 */
  const handleExecTailBuy = (cand, buyPx, buyQty) => {
    if (tiltState?.isLocked) {
      toastErr('🔒 单日防上头熔断保护中：已拦截尾盘新开仓买入，防止亏损日尾盘博弈加码');
      return;
    }

    const px = Math.max(0, +buyPx || +cand.price || 0);
    const qty = Math.max(0, parseInt(buyQty, 10) || 0);
    if (px <= 0 || qty <= 0) {
      toastErr('请输入有效的尾盘买入价与股数');
      return;
    }

    const buyFee = Math.round(px * qty * 0.0003 * 100) / 100;
    const totalOutflow = Math.round((px * qty + buyFee) * 100) / 100;
    if (totalOutflow > cash + 0.01) {
      toastWarn(`⚠️ 尾盘建仓需 ¥${money(totalOutflow)}，超出可用现金 ¥${money(cash)}，已将现金扣至 ¥0`);
    }
    setAvailableCash(prev => Math.max(0, Math.round((prev - totalOutflow) * 100) / 100));

    const code6 = String(cand.code || '').padStart(6, '0');
    const activeItem = {
      id: Date.now(),
      code: code6,
      name: cand.name,
      tcode: cand.tcode || tcodeFromCode(code6),
      cost: px,
      price: +cand.price || px,
      shares: qty,
      buyFee,
      status: 'active',
      date: todayStr(),
      tp1: cand.tp1,
      tp2: cand.tp2,
      stop: cand.stop
    };

    setTailActives(prev => [...prev, activeItem]);

    const audit = auditTradeExecution({
      stock: { ...cand, code: code6, tier: 'short' },
      code: code6,
      dir: '尾盘买入',
      track: 'short_swing',
      buy: px,
      sell: 0,
      qty,
      net: -buyFee,
      plan: '计划内',
      prevLogs: tradeLogs,
      wbLatest,
      poolList: pool,
      totalAssets,
    });

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      time: nowTimeHHMM(),
      code: code6,
      stock: `${cand.name} (${code6})`,
      track: 'short_swing',
      dir: '尾盘买入',
      buy: px,
      sell: 0,
      qty,
      gross: 0,
      fee: buyFee,
      net: -buyFee,
      plan: audit.plan,
      basis: '尾盘SOP信号',
      mistakeTags: audit.mistakeTags,
      systemBenchmark: audit.systemBenchmark,
      alphaNet: null,
      buyDevPct: audit.buyDevPct,
      sellDevPct: null,
      disciplineScore: audit.disciplineScore,
      note: `尾盘黑马潜伏建仓 ${qty} 股，扣减现金 ¥${money(totalOutflow)}，次日冲高 ¥${f2(cand.tp1)} 止盈`
    };

    setTradeLogs(prev => [newLog, ...prev]);
    toastOk(`🚀 【${cand.name}】尾盘建仓 ${qty} 股（扣减现金 ¥${money(totalOutflow)}），次日 09:30~10:00 冲高兑现`);
  };

  /* 尾盘平仓出局 */
  const handleExecTailExit = (act, sellPx) => {
    const px = Math.max(0, +sellPx || +act.price || +act.cost || 0);
    const sh = Math.max(0, +act.shares || 0);
    const sellFee = Math.round(px * sh * 0.0008 * 100) / 100;
    const buyFee = act.buyFee != null ? +act.buyFee : Math.round((+act.cost || 0) * sh * 0.0003 * 100) / 100;
    const proceeds = Math.round((px * sh - sellFee) * 100) / 100;
    const pnl = (px - act.cost) * sh;
    const totalFee = Math.round((buyFee + sellFee) * 100) / 100;
    const net = Math.round((pnl - totalFee) * 100) / 100;

    setAvailableCash(prev => Math.round((prev + proceeds) * 100) / 100);
    setTailActives(prev => prev.filter(x => x.id !== act.id));

    const code6 = String(act.code || '').padStart(6, '0');
    const audit = auditTradeExecution({
      stock: { ...act, code: code6, tier: 'short' },
      code: code6,
      dir: '尾盘平仓',
      track: 'short_swing',
      buy: act.cost,
      sell: px,
      qty: sh,
      net,
      plan: '自动判定',
      prevLogs: tradeLogs,
      wbLatest,
      poolList: pool,
      totalAssets,
    });

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      time: nowTimeHHMM(),
      code: code6,
      stock: `${act.name} (${code6})`,
      track: 'short_swing',
      dir: '尾盘平仓',
      buy: act.cost,
      sell: px,
      qty: sh,
      gross: pnl,
      fee: totalFee,
      net,
      plan: audit.plan,
      basis: '尾盘次日交割',
      mistakeTags: audit.mistakeTags,
      systemBenchmark: audit.systemBenchmark,
      alphaNet: audit.alphaNet,
      buyDevPct: audit.buyDevPct,
      sellDevPct: audit.sellDevPct,
      disciplineScore: audit.disciplineScore,
      note: `隔夜黑马平仓回笼 ¥${money(proceeds)}，闭环净收益 ${net >= 0 ? '+' : ''}¥${net.toFixed(2)}`
    };

    setTradeLogs(prev => [newLog, ...prev]);
    toastOk(`✓ 【${act.name}】平仓回笼现金 ¥${money(proceeds)}，隔夜净收益 ${net >= 0 ? '+' : ''}¥${net.toFixed(2)}`);
  };

  /* 导出与备份 */
  const handleExport = () => {
    const data = {
      version: 2,
      exportedAt: new Date().toISOString(),
      pool,
      logs: tradeLogs,
      tailActives,
      snapshots,
      eodArchives,
      posRules,
      totalAssets,
      initialCapital,
      availableCash: cash,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tstock-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastOk('✓ 全部自选、风控参数、现金总账、台账与盘后归档已成功导出为 JSON！');
  };

  /* 导入数据 */
  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const d = JSON.parse(evt.target.result);
        if (Array.isArray(d.pool)) setPool(d.pool);
        if (Array.isArray(d.logs)) setTradeLogs(d.logs);
        if (Array.isArray(d.tailActives)) setTailActives(d.tailActives);
        if (Array.isArray(d.snapshots)) setSnapshots(d.snapshots);
        if (Array.isArray(d.eodArchives)) setEodArchives(d.eodArchives);
        if (d.posRules && typeof d.posRules === 'object') {
          handleUpdatePosRules({ ...loadPosRules(), ...d.posRules });
        }
        if (d.initialCapital > 0) {
          setInitialCapital(+d.initialCapital);
        } else if (d.totalAssets > 0) {
          setInitialCapital(+d.totalAssets);
        }
        if (d.availableCash !== undefined && Number.isFinite(+d.availableCash)) {
          setAvailableCash(Math.max(0, +d.availableCash));
        } else if (d.totalAssets > 0) {
          const importedMkt =
            (d.pool || []).reduce((acc, s) => acc + (+s.shares || 0) * (+s.price || +s.cost || 0), 0) +
            (d.tailActives || []).reduce((acc, t) => acc + (t.status === 'closed' ? 0 : (+t.shares || 0) * (+t.price || +t.cost || 0)), 0);
          setAvailableCash(Math.max(0, Math.round((+d.totalAssets - importedMkt) * 100) / 100));
        }
        toastOk('✓ 数据已成功从备份中恢复！');
      } catch (_) {
        toastErr('导入失败：无效的 JSON 备份格式');
      }
    };
    reader.readAsText(file);
  };

  /* 复制今日作战计划 */
  const handleCopyPlan = () => {
    const lines = [
      `【今日做T作战计划】${todayStr()}`,
      `账户总资产: ¥${money(totalAssets)} ｜ 可用现金: ¥${money(cash)} ｜ 总仓位: ${posRate.toFixed(1)}%${tiltState?.isLocked ? ' ｜ 🔒 防上头熔断保护中' : ''}`,
    ];
    pool.forEach(s => {
      let c = null;
      try { c = calc(s); } catch (_) {}
      const posTag = (+s.shares || 0) > 0 ? `持仓 ${s.shares}股(成本 ¥${f2(s.cost)})` : '自选观察';
      lines.push('');
      lines.push(`■ ${s.name} (${String(s.code).padStart(6, '0')}) [${posTag}] 现价: ¥${f2(s.price)}`);
      if (c) {
        const cleanTitle = String(c.title || '').replace(/<[^>]+>/g, '');
        lines.push(`  结论: ${cleanTitle}`);
        lines.push(`  正T低吸: ¥${f2(c.inA)} / ¥${f2(c.inB)} ｜ 倒T高抛: ¥${f2(c.outA)} / ¥${f2(c.outB)}`);
        lines.push(`  止盈目标: ¥${f2(c.tp1)} / ¥${f2(c.tp2)} ｜ 止损红线: ¥${f2(c.slA)} (-${(c.effStop * 100).toFixed(2)}%)`);
      }
      if (s.memo && String(s.memo).trim()) {
        lines.push(`  作战备注: ${String(s.memo).trim()}`);
      }
    });
    if (tailActives.length > 0) {
      lines.push('');
      lines.push(`⚡ 隔夜尾盘持仓（09:30~10:00 必平）: ${tailActives.map(t => `${t.name}(${t.shares}股 成本¥${f2(t.cost)})`).join('、')}`);
    }
    lines.push('');
    lines.push('—— 铁律：破止损线无条件砍；做T仓 14:55 前必须平掉，绝不硬扛过夜。');
    copyPlain(lines.join('\n'), '今日真实量化作战计划已复制到剪贴板！');
  };

  /* 复制单只股票计划 */
  const handleCopySinglePlan = (stock) => {
    let c = null;
    try { c = calc(stock); } catch (_) {}
    const posTag = (+stock.shares || 0) > 0 ? `持仓 ${stock.shares}股（成本 ¥${f2(stock.cost)}）` : '自选观察';
    const lines = [
      `【做T执行预案】${stock.name} (${String(stock.code).padStart(6, '0')}) · ${posTag}`,
      `现价: ¥${f2(stock.price)} ｜ 昨收: ¥${f2(stock.prevClose)} ｜ 分时均价: ¥${f2(stock.avg || stock.price)}`,
    ];
    if (c) {
      lines.push(`策略结论: ${String(c.title || '').replace(/<[^>]+>/g, '')}`);
      lines.push(`正T低吸区: ¥${f2(c.inA)}（首份）~ ¥${f2(c.inB)}（二份）`);
      lines.push(`倒T高抛区: ¥${f2(c.outA)}（首份）~ ¥${f2(c.outB)}（二份）｜ 卖飞线: ¥${f2(c.fly)}`);
      lines.push(`止盈目标位: ¥${f2(c.tp1)} (+${c.gain1.toFixed(1)}%) / ¥${f2(c.tp2)} (+${c.gain2.toFixed(1)}%)`);
      lines.push(`止损硬红线: ¥${f2(c.slA)} (-${(c.effStop * 100).toFixed(2)}%)`);
    }
    if (stock.memo && String(stock.memo).trim()) {
      lines.push(`盘前备注: ${String(stock.memo).trim()}`);
    }
    copyPlain(lines.join('\n'), `${stock.name} 真实做T预案已复制到剪贴板！`);
  };

  /* 切换桌面通知 */
  const handleToggleNotify = () => {
    if (typeof Notification === 'undefined') {
      toastWarn('当前浏览器环境不支持桌面通知');
      return;
    }
    if (Notification.permission === 'granted') {
      toastOk('桌面通知已处于开启状态');
      setNotifyActive(true);
      return;
    }
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        toastOk('✓ 桌面通知已授权开启！');
        setNotifyActive(true);
      } else {
        toastWarn('未授权桌面通知权限');
      }
    });
  };

  /* 切换上班免打扰 / 提醒总开关 */
  const handleToggleAlertEnabled = () => {
    setAlertEnabled(prev => {
      const next = !prev;
      try {
        localStorage.setItem('t-alert-enabled', JSON.stringify(next));
        if (!next && typeof document !== 'undefined') {
          document.title = APP_PAGE_TITLE;
        }
      } catch (_) {}
      if (next) {
        toastOk('🔔 已开启盘中分时异动与到价提醒');
      } else {
        toastWarn('🔕 已开启上班免打扰：提示音、桌面弹窗及网页标题变动已全部关闭');
      }
      return next;
    });
  };

  const handleTabChange = (target) => {
    navigate(target);
  };

  const tailCount = tailActives.length > 0 ? tailActives.length : getTailBuyCandidates(wbLatest).length;

  return (
    <div className="wrap">
      <Header />

      <TopNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        pool={pool}
        activeStockCode={activeStockCode}
        onSelectStock={handleSelectStock}
        tailCount={tailCount}
        ledgerCount={tradeLogs.length}
        totalAssets={totalAssets}
        marketValue={marketValue}
        posRate={posRate}
        clockPhase={clockPhase}
        quoteStamp={quoteStamp}
        isStale={isStale}
        onOpenClock={() => setClockModalOpen(true)}
        onOpenAlertModal={() => setAlertModalOpen(true)}
        onOpenEodModal={() => setEodModalOpen(true)}
        todayArchived={todayArchived}
        isPostMarketWindow={isPostMarketWindow}
        onCopyPlan={handleCopyPlan}
        onExport={handleExport}
        onImportClick={() => importInputRef.current && importInputRef.current.click()}
        onRefresh={() => handleRefresh(false)}
        onToggleNotify={handleToggleNotify}
        notifyActive={notifyActive}
        alertEnabled={alertEnabled}
      />

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={handleImportFile}
      />

      <OvernightBanner
        visible={overnightBannerOpen || ((isTailAlertTime || simTailAlert) && unclosedStocks.length > 0)}
        unclosedList={unclosedStocks}
        onClose={() => setOvernightBannerOpen(false)}
        onOpenQuickT={(stock, dir, px, qty) => setQuickTModal({ open: true, stock, defaultDir: dir, defaultPx: px, defaultQty: qty })}
        simTailAlert={simTailAlert}
        onToggleSimTailAlert={() => {
          setSimTailAlert(prev => {
            const next = !prev;
            if (next) setOvernightBannerOpen(true);
            return next;
          });
        }}
      />

      <main className="main-content">
        {(activeTab === 'tabConsole' || activeTab === 'tabAll') && (
          <TradePage
            pool={pool}
            tailActives={tailActives}
            posRules={posRules}
            tiltState={tiltState}
            onUpdatePosRules={handleUpdatePosRules}
            onUnlockTilt={handleUnlockTilt}
            onRelockTilt={handleRelockTilt}
            activeStockCode={activeStockCode}
            totalAssets={totalAssets}
            tradeLogs={tradeLogs}
            isTailAlertTime={isTailAlertTime}
            simTailAlert={simTailAlert}
            onSelectStock={handleSelectStock}
            wbLatest={wbLatest}
            dbStatus={dbStatus}
            onAddStock={handleAddStockByQuery}
            onBatchAdd={handleBatchAdd}
            onOpenReason={(st, have) => setReasonModal({ open: true, stock: st, inPool: have })}
            onRefresh={() => handleRefresh(false)}
            onSelfTest={selfTest}
            onJumpPerf={() => navigate('/perf')}
            onUpdateStock={handleUpdateStock}
            onBuyStock={handleBuyStock}
            onRemoveStock={handleRemoveStock}
            onAddBlank={handleAddBlank}
            onSaveLocal={handleSaveLocal}
            onResetDefault={handleResetDefault}
            onOpenQuickT={(stock, dir, px, qty) => setQuickTModal({ open: true, stock, defaultDir: dir, defaultPx: px, defaultQty: qty })}
            fastRefresh={fastRefresh}
            onToggleFastRefresh={handleToggleFastRefresh}
            onRefreshSingle={async (stock) => {
              await loadStock(stock);
              await loadChart(stock, true);
              checkPriceAlerts(pool);
              checkIntradayAnomalies([stock]);
              const nextPool = [...pool];
              setPool(nextPool);
              toastOk(`✓ ${stock.name} 行情与K线已更新！`);
            }}
            onCopySinglePlan={handleCopySinglePlan}
            onJumpDiagnosis={handleJumpDiagnosis}
            onJumpIgnition={handleJumpIgnition}
          />
        )}

        {(activeTab === 'tabIgnition' || activeTab === 'tabAll') && (
          <IgnitionPage
            pool={pool}
            initialCode={query?.code || ''}
            onAddStock={handleAddStockByQuery}
            onSelectStock={handleSelectStock}
            onJumpDiagnosis={handleJumpDiagnosis}
          />
        )}

        {(activeTab === 'tabBoard' || activeTab === 'tabAll') && (
          <BoardPage
            pool={pool}
            onAddStock={handleAddStockByQuery}
            onSelectStock={handleSelectStock}
            onJumpIgnition={handleJumpIgnition}
            onTabChange={navigate}
          />
        )}

        {(activeTab === 'tabTail' || activeTab === 'tabAll') && (
          <TailPage
            totalAssets={totalAssets}
            cash={cash}
            actives={tailActives}
            wbLatest={wbLatest}
            tiltState={tiltState}
            onExecTailBuy={handleExecTailBuy}
            onExecTailExit={handleExecTailExit}
            onRefreshContract={fetchContract}
          />
        )}

        {(activeTab === 'tabDiagnosis' || activeTab === 'tabAll') && (
          <DiagnosisPage
            pool={pool}
            tradeLogs={tradeLogs}
            initialCode={query?.code || activeStockCode}
            onAddStockToPool={handleAddStockByQuery}
            onSelectStockInPool={handleSelectStock}
            onJumpIgnition={handleJumpIgnition}
            fastRefresh={fastRefresh}
            onToggleFastRefresh={handleToggleFastRefresh}
          />
        )}

        {(activeTab === 'tabPerf' || activeTab === 'tabAll') && (
          <PerfPage
            tradeLogs={tradeLogs}
            pool={pool}
            onAddStock={handleAddStockByQuery}
            onTabChange={navigate}
          />
        )}

        {(activeTab === 'tabAccount' || activeTab === 'tabAll') && (
          <AccountPage
            totalAssets={totalAssets}
            initialCapital={initialCapital}
            marketValue={marketValue}
            poolMarketValue={poolMarketValue}
            tailMarketValue={tailMarketValue}
            posRate={posRate}
            cash={cash}
            pool={pool}
            tailActives={tailActives}
            tradeLogs={tradeLogs}
            snapshots={snapshots}
            onTakeSnapshot={() => {
              const today = todayStr();
              const snap = { date: today, total: totalAssets, mkt: marketValue, cash, rate: posRate.toFixed(1) };
              setSnapshots(prev => [snap, ...prev.filter(x => x.date !== today)]);
              toastOk('✓ 今日收盘资产快照已成功落盘！');
            }}
            onClearSnap={() => {
              if (window.confirm('确定清空所有历史收益快照吗？')) {
                setSnapshots([]);
                toast('快照已清空', 'info');
              }
            }}
            onUpdateTotalAssets={(val) => {
              const targetTotal = Math.max(0, Math.round(+val * 100) / 100);
              const nextCash = Math.max(0, Math.round((targetTotal - marketValue) * 100) / 100);
              setInitialCapital(targetTotal);
              setAvailableCash(nextCash);
              toastOk(`✓ 已校准账户总本金 ¥${money(targetTotal)}，当前可用现金已对齐为 ¥${money(nextCash)}`);
            }}
            onUpdateCash={(val) => {
              const nextCash = Math.max(0, Math.round(+val * 100) / 100);
              setAvailableCash(nextCash);
              toastOk(`✓ 可用现金已更新为 ¥${money(nextCash)}，实时总资产同步为 ¥${money(nextCash + marketValue)}`);
            }}
          />
        )}

        {(activeTab === 'tabLedger' || activeTab === 'tabAll') && (
          <LedgerPage
            logs={tradeLogs}
            wbLatest={wbLatest}
            totalAssets={totalAssets}
            vaultStatus={vaultStatus}
            onForceSyncVault={(force = false) => performVaultSync(force, true)}
            onRestoreVault={handleRestoreFromVault}
            onOpenEodModal={() => setEodModalOpen(true)}
            todayArchived={todayArchived}
            onAddLog={(log) => {
              setTradeLogs(prev => [log, ...prev]);
              toastOk('✓ 交易记录已成功录入台账！');
            }}
            onUpdateLog={(updatedLog) => {
              setTradeLogs(prev => prev.map(x => (x.id === updatedLog.id ? updatedLog : x)));
              toastOk('✓ 已保存该笔成交的复盘归因与纪律评分！');
            }}
            onDeleteLog={(id) => {
              setTradeLogs(prev => prev.filter(x => x.id !== id));
              toast('流水记录已删除', 'info');
            }}
            pool={pool}
            onExport={handleExport}
            onImportClick={() => importInputRef.current && importInputRef.current.click()}
          />
        )}

        {(activeTab === 'tabRules' || activeTab === 'tabAll') && (
          <RulesPage />
        )}
      </main>

      <footer>
        {SITE_META.footer}
      </footer>

      {quickTModal.open && (
        <QuickTModal
          modalData={quickTModal}
          tradeLogs={tradeLogs}
          tiltState={tiltState}
          onClose={() => setQuickTModal({ open: false, stock: null })}
          onConfirm={handleConfirmQuickT}
        />
      )}

      {reasonModal.open && (
        <StockReasonModal
          modalData={reasonModal}
          onClose={() => setReasonModal({ open: false, stock: null, inPool: false })}
          onAdd={(st) => handleBatchAdd([st], st.pool === 'steady' ? '稳健' : '短线')}
          onJumpCard={(st) => handleSelectStock(st.code)}
        />
      )}

      {clockModalOpen && (
        <TradingClockModal
          open={clockModalOpen}
          onClose={() => setClockModalOpen(false)}
        />
      )}

      {alertModalOpen && (
        <AlertCenterModal
          open={alertModalOpen}
          onClose={() => setAlertModalOpen(false)}
          pool={pool}
          onJumpCard={handleSelectStock}
          notifyActive={notifyActive}
          onToggleNotify={handleToggleNotify}
          alertEnabled={alertEnabled}
          onToggleAlertEnabled={handleToggleAlertEnabled}
          simTailAlert={simTailAlert}
          onToggleSimTailAlert={() => {
            setSimTailAlert(prev => {
              const next = !prev;
              if (next) setOvernightBannerOpen(true);
              return next;
            });
          }}
          onSimulateAnomaly={handleSimulateAnomaly}
          unclosedCount={unclosedStocks.length}
        />
      )}

      <PostMarketModal
        open={eodModalOpen}
        onClose={() => setEodModalOpen(false)}
        eodArchives={eodArchives}
        isRunning={eodRunning}
        stepStates={eodSteps}
        livePositionCheck={liveEodPositionCheck}
        onRunWorkflow={handleRunEodWorkflow}
        onOpenQuickT={(stock, dir, px, qty) => setQuickTModal({ open: true, stock, defaultDir: dir, defaultPx: px, defaultQty: qty })}
        onMarkOvernightT={handleMarkOvernightT}
      />

      <ToastHost
        toasts={toasts}
        onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />
    </div>
  );
}
