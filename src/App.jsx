'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Header from './components/Header.jsx';
import TopNav from './components/TopNav.jsx';
import TradePage from './views/TradePage.jsx';
import TailPage from './views/TailPage.jsx';
import AccountPage from './views/AccountPage.jsx';
import LedgerPage from './views/LedgerPage.jsx';
import RulesPage from './views/RulesPage.jsx';
import { QuickTModal, StockReasonModal, TradingClockModal, ToastHost, OvernightBanner, AlertCenterModal } from './components/Modals.jsx';

import { SITE_META, STORAGE_KEYS, DEFAULT_POOL } from './data/site.js';
import useRoute from './router/useRoute.js';
import { todayStr, f2, toast, toastOk, toastWarn, toastErr, setToastListener, copyPlain } from './services/utils.js';
import { loadStock, loadChart, loadResearch, loadMarket, addByQuery, selfTest, checkPriceAlerts } from './services/api.js';
import { registerChartLoader } from './services/chart.js';
import { getTailBuyCandidates } from './services/tail.js';

export default function App() {
  /* ================= 1. 响应式 URL 路由与核心状态 ================= */
  const { path, activeTab, navigate } = useRoute();

  const [pool, setPool] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.POOL);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_POOL));
  });

  const [totalAssets, setTotalAssets] = useState(() => {
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
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  });

  const [snapshots, setSnapshots] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SNAPSHOTS);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  });

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
  const [wbLatest, setWbLatest] = useState(() => {
    return typeof window !== 'undefined' ? (window.WB_LATEST || null) : null;
  });

  /* Modals 状态 */
  const [quickTModal, setQuickTModal] = useState({ open: false, stock: null });
  const [reasonModal, setReasonModal] = useState({ open: false, stock: null, inPool: false });
  const [clockModalOpen, setClockModalOpen] = useState(false);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [overnightBannerOpen, setOvernightBannerOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  /* 当前选中的聚焦做T股票代码 */
  const [activeStockCode, setActiveStockCode] = useState(() => (pool[0]?.code || ''));

  // 保证 activeStockCode 在 pool 变更时始终有效
  useEffect(() => {
    if (pool && pool.length > 0) {
      const code6 = String(activeStockCode).padStart(6, '0');
      if (!pool.some(s => String(s.code).padStart(6, '0') === code6)) {
        setActiveStockCode(String(pool[0].code).padStart(6, '0'));
      }
    }
  }, [pool, activeStockCode]);

  /* 点击已选股票胶囊或卡片直达跳转：自动切路由 + 平滑滚动 + 脉冲聚焦动效 */
  const handleSelectStock = useCallback((code) => {
    const code6 = String(code).padStart(6, '0');
    setActiveStockCode(code6);
    if (activeTab !== 'tabConsole') {
      navigate('/trade');
    }
    setTimeout(() => {
      const cardEl = document.getElementById(`stockCard_${code6}`) || document.getElementById('secPlan');
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        cardEl.classList.remove('card-highlight-pulse');
        void cardEl.offsetWidth; // 触发 reflow 重置动画
        cardEl.classList.add('card-highlight-pulse');
      }
    }, 120);
  }, [activeTab, navigate]);

  const lastSuccessStamp = useRef(Date.now());
  const importInputRef = useRef(null);

  /* 状态落盘持久化 */
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.ACCOUNT_TOTAL, String(totalAssets));
  }, [totalAssets]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.TRADE_LOG, JSON.stringify(tradeLogs));
  }, [tradeLogs]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.TAIL_ACTIVE, JSON.stringify(tailActives));
  }, [tailActives]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SNAPSHOTS, JSON.stringify(snapshots));
  }, [snapshots]);

  /* 读取选股引擎统一数据契约。使用 JSON fetch，避免外部 script 与 React 水合时序竞争。 */
  useEffect(() => {
    let active = true;
    fetch('/data/latest.json?ts=' + Date.now(), { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(data => {
        if (!active) return;
        window.WB_LATEST = data;
        setWbLatest(data);
      })
      .catch(error => {
        console.error('[T-Stock] 选股契约读取失败', error);
        if (active) setDbStatus('选股契约读取失败：' + error.message);
      });
    return () => { active = false; };
  }, []);

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

  /* 计算资产与市值 */
  const marketValue = pool.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0);
  const posRate = totalAssets > 0 ? (marketValue / totalAssets) * 100 : 0;
  const cash = Math.max(0, totalAssets - marketValue);

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
      else if (mins >= 840 && mins < 870) phase = '变盘预警 (14:00-14:30 警惕跳水)';
      else if (mins >= 870 && mins < 895) phase = '🚨 T仓强制平仓 (14:30-14:55 绝不过夜)';
      else if (mins >= 895 && mins < 900) phase = '尾盘定盘 (14:55-15:00)';
    }
    setClockPhase(`${timeStr} ${phase}`);

    // 14:30-14:55 尾盘未平仓报警
    if (!isWeekend && mins >= 870 && mins < 895) {
      const hasUnclosed = tradeLogs.some(l => l.date === todayStr() && l.dir === '正T');
      if (hasUnclosed) setOvernightBannerOpen(true);
    }
  }, [tradeLogs]);

  /* 行情全量刷新 */
  const handleRefresh = useCallback(async (silent = false) => {
    if (!pool || !pool.length) {
      setDbStatus('自选池是空的 —— 在上方输入 6 位代码或股票名称加入池。');
      return;
    }

    if (!silent) setDbStatus('正在获取全市场实时行情与前复权K线…');

    const errs = [];
    const stockTasks = pool.map(async s => {
      try {
        await loadStock(s);
        await loadChart(s, true);
        await loadResearch(s, false);
        return null;
      } catch (e) {
        return (s.name || s.code) + ' (' + e.message + ')';
      }
    });

    const results = await Promise.all(stockTasks);
    results.forEach(x => { if (x) errs.push(x); });

    setPool([...pool]);
    lastSuccessStamp.current = Date.now();
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    setQuoteStamp(timeStr);
    setIsStale(false);

    if (errs.length) {
      setDbStatus('部分标的行情未更新 → ' + errs.join('；'));
    } else {
      setDbStatus(`行情已更新 ${timeStr} · 来源：腾讯实时行情 + 腾讯前复权K线 + 逐笔大单`);
    }

    if (!silent) toastOk('✓ 全市场实时行情与前复权K线已同步！');
    checkPriceAlerts();
  }, [pool]);

  /* 定时任务与生命周期 */
  useEffect(() => {
    updateClock();
    const clockTimer = setInterval(updateClock, 1000);
    const staleTimer = setInterval(() => {
      const diffMin = (Date.now() - lastSuccessStamp.current) / 60000;
      setIsStale(diffMin > 3);
    }, 5000);

    // 首屏静默刷新
    const initialTimer = setTimeout(() => handleRefresh(true), 300);

    // 交易时间每分钟自动刷新
    const autoRefreshTimer = setInterval(() => {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const wd = now.getDay();
      if (wd >= 1 && wd <= 5 && ((mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900))) {
        handleRefresh(true);
      }
    }, 60000);

    return () => {
      clearInterval(clockTimer);
      clearInterval(staleTimer);
      clearTimeout(initialTimer);
      clearInterval(autoRefreshTimer);
    };
  }, [updateClock, handleRefresh]);

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
    if (window.confirm('确定要恢复默认股票数据吗？这将覆盖当前自选。')) {
      setPool(JSON.parse(JSON.stringify(DEFAULT)));
      toastOk('已恢复默认自选数据');
    }
  };

  const handleSaveLocal = () => {
    toastOk('✓ 所有做T参数与自选持仓已成功保存至本地！');
  };

  const handleAddStockByQuery = async (query) => {
    toast('正在全市场检索标的…', 'info');
    try {
      await addByQuery(query);
      // addByQuery 内部直接更新了 state.pool，重新同步到组件
      const raw = localStorage.getItem('t-system-pool');
      if (raw) {
        const parsed = JSON.parse(raw);
        setPool(parsed);
        const lastCode = parsed[parsed.length - 1]?.code;
        if (lastCode) {
          handleSelectStock(lastCode);
        }
      }
      toastOk(`✓ 标的 ${query} 已成功加入自选做T台！`);
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

  /* 快捷记T提交 */
  const handleConfirmQuickT = ({ stock, dir, buy, sell, qty, netDiff, newCost }) => {
    const newLog = {
      id: Date.now(),
      date: todayStr(),
      stock: `${stock.name} (${stock.code})`,
      dir,
      buy,
      sell,
      qty,
      gross: (sell - buy) * qty,
      fee: (buy * qty + sell * qty) * 0.0011,
      net: netDiff,
      plan: '计划内',
      basis: '客观信号',
      note: `快捷做T记入，净套利 ¥${netDiff.toFixed(2)}`
    };

    setTradeLogs(prev => [newLog, ...prev]);

    // 更新持仓成本
    if (stock.shares > 0 && newCost > 0) {
      handleUpdateStock({ ...stock, cost: newCost });
    }

    setQuickTModal({ open: false, stock: null });
    toastOk(`✓ 做T记录已入账！净套利 ¥${netDiff.toFixed(2)}`);
  };

  /* 尾盘潜伏建仓 */
  const handleExecTailBuy = (cand, buyPx, buyQty) => {
    const activeItem = {
      id: Date.now(),
      code: cand.code,
      name: cand.name,
      tcode: cand.tcode,
      cost: buyPx,
      shares: buyQty,
      status: 'active',
      date: todayStr(),
      tp1: cand.tp1,
      tp2: cand.tp2,
      stop: cand.stop
    };

    setTailActives(prev => [...prev, activeItem]);

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      stock: `${cand.name} (${cand.code})`,
      dir: '尾盘买入',
      buy: buyPx,
      sell: 0,
      qty: buyQty,
      gross: 0,
      fee: buyPx * buyQty * 0.0003,
      net: -(buyPx * buyQty * 0.0003),
      plan: '计划内',
      basis: '客观信号',
      note: `尾盘黑马潜伏建仓，次日早盘冲高 ${cand.tp1} 止盈`
    };

    setTradeLogs(prev => [newLog, ...prev]);
    toastOk(`🚀 【${cand.name}】已成功执行尾盘潜伏挂单！次日早盘 09:30~10:00 冲高兑现`);
  };

  /* 尾盘平仓出局 */
  const handleExecTailExit = (act, sellPx) => {
    const pnl = (sellPx - act.cost) * act.shares;
    const fee = (act.cost * act.shares + sellPx * act.shares) * 0.0011;
    const net = pnl - fee;

    setTailActives(prev => prev.filter(x => x.id !== act.id));

    const newLog = {
      id: Date.now(),
      date: todayStr(),
      stock: `${act.name} (${act.code})`,
      dir: '尾盘平仓',
      buy: act.cost,
      sell: sellPx,
      qty: act.shares,
      gross: pnl,
      fee,
      net,
      plan: '计划内',
      basis: '客观信号',
      note: `隔夜黑马次日兑现，收益 ¥${net.toFixed(2)}`
    };

    setTradeLogs(prev => [newLog, ...prev]);
    toastOk(`✓ 【${act.name}】已平仓出局，本次隔夜净收益 ¥${net.toFixed(2)}`);
  };

  /* 导出与备份 */
  const handleExport = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      pool,
      logs: tradeLogs,
      tailActives,
      snapshots,
      totalAssets
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tstock-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastOk('✓ 全部自选与台账数据已成功导出为 JSON 文件！');
  };

  /* 导入数据 */
  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const d = JSON.parse(evt.target.result);
        if (d.pool) setPool(d.pool);
        if (d.logs) setTradeLogs(d.logs);
        if (d.tailActives) setTailActives(d.tailActives);
        if (d.snapshots) setSnapshots(d.snapshots);
        if (d.totalAssets) setTotalAssets(d.totalAssets);
        toastOk('✓ 数据已成功从备份中恢复！');
      } catch (err) {
        toastErr('导入失败：无效的 JSON 备份格式');
      }
    };
    reader.readAsText(file);
  };

  /* 复制今日作战计划 */
  const handleCopyPlan = () => {
    const lines = [`【今日做T作战计划】${todayStr()}`];
    pool.forEach(s => {
      lines.push('');
      lines.push(`${s.name} (${s.code}) 现价: ${f2(s.price)}`);
      lines.push(`  建议买入点: ${f2(s.price * 0.98)} ｜ 止盈目标: ${f2(s.price * 1.02)}`);
    });
    lines.push('');
    lines.push('—— 纪律：T仓浮亏 1.5% 无条件砍；14:55 前必须平掉，绝不隔夜。');
    copyPlain(lines.join('\n'), '今日作战计划文本已复制到剪贴板，可直接粘贴！');
  };

  /* 复制单只股票计划 */
  const handleCopySinglePlan = (stock) => {
    const text = `【做T执行预案】${stock.name} (${stock.code})\n现价: ${f2(stock.price)} 昨收: ${f2(stock.prevClose)}\n买入区间: ${f2(stock.price * 0.985)} ~ ${f2(stock.price * 0.975)}\n止盈目标: ${f2(stock.price * 1.025)}\n止损红线: ${f2(stock.price * 0.985 * 0.985)} (-1.5%)`;
    copyPlain(text, `${stock.name} 做T计划已复制到剪贴板！`);
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
          document.title = '做T执行台 · 七格箱体 + 七底三仓';
        }
      } catch (_) {}
      if (next) {
        toastOk('🔔 已开启盘中买卖到价提醒');
      } else {
        toastWarn('🔕 已开启上班免打扰：提示音、桌面弹窗及网页标题变动已全部关闭');
      }
      return next;
    });
  };

  /* 切换页面路由 */
  const handleTabChange = (target) => {
    navigate(target);
  };

  const tailCount = tailActives.length > 0 ? tailActives.length : getTailBuyCandidates().length;

  return (
    <div className="wrap">
      {/* 顶部标题区 */}
      <Header />

      {/* 吸顶导航栏（绑定 URL 路由） */}
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
        onCopyPlan={handleCopyPlan}
        onExport={handleExport}
        onImportClick={() => importInputRef.current && importInputRef.current.click()}
        onRefresh={() => handleRefresh(false)}
        onToggleNotify={handleToggleNotify}
        notifyActive={notifyActive}
        alertEnabled={alertEnabled}
      />

      {/* 隐藏的导入文件 input */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={handleImportFile}
      />

      {/* 尾盘过夜风控横幅 */}
      <OvernightBanner
        visible={overnightBannerOpen}
        onClose={() => setOvernightBannerOpen(false)}
      />

      {/* 页面主体区：基于 URL 路由解耦展示 */}
      <main className="main-content">
        {/* 今日作战（选股池 + 做T决策台） */}
        {(activeTab === 'tabConsole' || activeTab === 'tabAll') && (
          <TradePage
            pool={pool}
            activeStockCode={activeStockCode}
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
            onRemoveStock={handleRemoveStock}
            onAddBlank={handleAddBlank}
            onSaveLocal={handleSaveLocal}
            onResetDefault={handleResetDefault}
            onOpenQuickT={(stock, dir, px) => setQuickTModal({ open: true, stock, defaultDir: dir, defaultPx: px })}
            onRefreshSingle={async (stock) => {
              await loadStock(stock);
              await loadChart(stock, true);
              setPool([...pool]);
              toastOk(`✓ ${stock.name} 行情与K线已更新！`);
            }}
            onCopySinglePlan={handleCopySinglePlan}
          />
        )}

        {/* ⚡ 尾盘黑马 T+0 看板 */}
        {(activeTab === 'tabTail' || activeTab === 'tabAll') && (
          <TailPage
            totalAssets={totalAssets}
            actives={tailActives}
            onExecTailBuy={handleExecTailBuy}
            onExecTailExit={handleExecTailExit}
          />
        )}

        {/* 账户资产与战绩透视 */}
        {(activeTab === 'tabAccount' || activeTab === 'tabPerf' || activeTab === 'tabAll') && (
          <AccountPage
            totalAssets={totalAssets}
            marketValue={marketValue}
            posRate={posRate}
            cash={cash}
            pool={pool}
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
              setTotalAssets(val);
              toastOk(`✓ 账户总资产已更新为 ¥${f2(val)}`);
            }}
          />
        )}

        {/* 台账与体检 */}
        {(activeTab === 'tabLedger' || activeTab === 'tabAll') && (
          <LedgerPage
            logs={tradeLogs}
            onAddLog={(log) => {
              setTradeLogs(prev => [log, ...prev]);
              toastOk('✓ 新做T台账流水记录已成功写入！');
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

        {/* 作战纪律与时钟 */}
        {(activeTab === 'tabRules' || activeTab === 'tabAll') && (
          <RulesPage />
        )}
      </main>

      {/* 底部语录 */}
      <footer>
        {SITE_META.footer}
      </footer>

      {/* ================= 3. 模态弹窗系统 ================= */}
      {quickTModal.open && (
        <QuickTModal
          modalData={quickTModal}
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
        />
      )}

      <ToastHost
        toasts={toasts}
        onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />
    </div>
  );
}
