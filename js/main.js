/* ============================================================
   A股做T执行台 · 现代化ESM主入口引擎 (main.js)
   负责驱动多导航工作区、全局状态同步与生命周期调度
   ============================================================ */

import { f2, f3, pct, money, money2, todayStr, toast, toastOk, toastWarn, toastErr, copyPlain, soundChime, warmAudio } from './utils.js';
import { pool, savePool, LOG, saveLog, SNAP, saveSnap, TAIL_ACTIVES, saveTailActive, CUR, setCur, TIER, setTier, stampData } from './state.js';
import { fetchQuotes, loadStock, loadChart, loadResearch, loadDD, loadMarket, setupTimer, addByQuery, selfTest, calc, checkPriceAlerts, checkMarketAlerts } from './api.js';
import { drawChart, kbarHTML, chartLegendHTML, chartStat, registerChartLoader } from './chart.js';
import { render, posCalc, execLiveSell, execLiveBuy, updateLtbPreview, openQuickTModal, closeQuickTModal, execQuickT, setQtDir, updateQtPreview } from './card.js';
import { renderTailBuySection, execTailBuy, execTailExit, getTailBuyCandidates } from './tail.js';
import { renderAccount, renderMarket, renderPerfTable, renderEquity, takeSnapshot, clearSnap, setRedTab } from './account.js';
import { renderLog, logAdd, renderCheckup, exportAll, importAll, copyPlan } from './ledger.js';
import { initTabs, switchTab, updateTabBadges, updateTradingClock, paintStamp, renderTopbar, renderPoolTabs, focusStock, setView, openClockModal, closeClockModal, openStockReasonModal, closeStockReasonModal } from './nav.js';
import { animCardsStagger, animPricePulse } from './anim.js';
import { renderSelectionPool, syncSelectionChips, mergeSelectionToPool } from './selection.js';

/* ===================== 全局全量刷新调度 ===================== */
export async function refreshAll(silent = false) {
  const st = document.getElementById('dbStatus');
  if (!pool || !pool.length) {
    if (st) {
      st.className = 'db-status';
      st.textContent = '自选池是空的 —— 在上方输入 6 位代码或股票名称加入池。';
    }
    return;
  }

  if (st && !silent) {
    st.className = 'db-status';
    st.textContent = '正在获取全市场实时行情与前复权K线…';
  }

  const errs = [];

  // 1. 刷新大盘环境数据 (指数 + 成交量 + 估值分位)
  const mktTask = (async () => {
    try {
      await loadMarket(false);
      renderMarket();
    } catch (e) {
      console.warn('[市场环境] 取数告警：' + e.message);
    }
  })();

  // 2. 并发刷新自选股列表
  const stockTasks = pool.map(async s => {
    try {
      await loadStock(s);
      await loadChart(s, true);
      await loadResearch(s, false);
      if (s.ddOn) {
        try { await loadDD(s); } catch (_) {}
      }
      return null;
    } catch (e) {
      return (s.name || s.code) + ' (' + e.message + ')';
    }
  });

  const results = await Promise.all([mktTask, ...stockTasks]);
  results.slice(1).forEach(x => { if (x) errs.push(x); });

  // 渲染所有视图
  render(pool);
  savePool();
  renderAccount();
  renderTailBuySection();
  renderTopbar();
  renderPoolTabs();
  updateTabBadges();

  if (errs.length < pool.length) stampData();

  if (st) {
    if (errs.length) {
      st.className = 'db-status err';
      st.textContent = '部分标的行情未更新 → ' + errs.join('；');
    } else {
      const d = new Date();
      const timeStr = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
      st.className = 'db-status';
      st.innerHTML = '行情已更新 <b>' + timeStr + '</b> · 来源：腾讯实时行情 + 腾讯前复权K线 + 逐笔大单';
    }
  }

  syncSelectionChips();
  checkPriceAlerts();
  checkMarketAlerts();

  // 15:05 收盘自动落收益快照
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const wd = now.getDay();
  if (wd >= 1 && wd <= 5 && mins >= 15 * 60 + 5) {
    const today = todayStr();
    if (!SNAP.some(x => x.date === today) && pool.some(s => (s.shares || 0) > 0)) {
      takeSnapshot();
      renderAccount();
      console.log('[自动快照] 已成功记录收盘净值！');
    }
  }
}

/* ===================== 挂载全局方法 (兼容原有 inline HTML 交互) ===================== */
window.switchTab = switchTab;
window.execLiveSell = execLiveSell;
window.execLiveBuy = execLiveBuy;
window.updateLtbPreview = updateLtbPreview;
window.openQuickTModal = openQuickTModal;
window.closeQuickTModal = closeQuickTModal;
window.setQtDir = setQtDir;
window.updateQtPreview = updateQtPreview;
window.execQuickT = execQuickT;
window.execTailExit = execTailExit;
window.execTailBuyProxy = (idx) => {
  const cands = getTailBuyCandidates();
  const cand = cands[idx];
  if (cand) execTailBuy(cand, cand.price, cand.shares);
};
window.refreshAll = refreshAll;
window.selfTest = selfTest;
window.logAdd = logAdd;
window.exportAll = exportAll;
window.importAll = importAll;
window.copyPlan = copyPlan;
window.clearSnap = clearSnap;
window.takeSnapshot = takeSnapshot;
window.focusStock = focusStock;
window.setView = setView;
window.openClockModal = openClockModal;
window.closeClockModal = closeClockModal;
window.openStockReasonModal = openStockReasonModal;
window.closeStockReasonModal = closeStockReasonModal;
window.setRedTab = setRedTab;
window.renderLog = renderLog;
window.renderAccount = renderAccount;
window.render = render;
window.renderEquity = renderEquity;
window.renderTailBuySection = renderTailBuySection;
window.renderSelectionPool = renderSelectionPool;
window.syncSelectionChips = syncSelectionChips;
window.mergeSelectionToPool = mergeSelectionToPool;
window.__applyPool = () => {
  render(pool);
  renderPoolTabs();
  renderTopbar();
  updateTabBadges();
  syncSelectionChips();
};

window.syncSingleStock = async (idx) => {
  const s = pool[idx];
  if (!s) return;
  toast('正在同步 ' + s.name + ' 行情…', 'info');
  try {
    await loadStock(s);
    await loadChart(s, true);
    render(pool);
    soundChime(784, 0.15);
    toastOk('✓ ' + s.name + ' 行情与指标已同步最新！');
  } catch (e) {
    toastErr(s.name + ' 同步失败：' + e.message);
  }
};

window.delSingleStock = (idx) => {
  const s = pool[idx];
  if (!s) return;
  if (confirm('确定从做T自选池中移除 ' + s.name + ' (' + s.code + ') 吗？')) {
    pool.splice(idx, 1);
    savePool();
    render(pool);
    renderPoolTabs();
    renderTopbar();
    updateTabBadges();
    toastOk('已移除 ' + s.name);
  }
};

window.switchTradeTab = (idx, tab) => {
  const s = pool[idx];
  if (s) {
    s._tradeTab = tab;
    render(pool);
  }
};

window.setLtbSellPx = (idx, px) => {
  const el = document.getElementById('ltbSell_' + idx);
  if (el) {
    el.value = f2(px);
    updateLtbPreview(idx);
  }
};

window.setLtbQty = (idx, qty) => {
  const el = document.getElementById('ltbQty_' + idx);
  if (el) {
    el.value = qty;
    updateLtbPreview(idx);
  }
};

window.changePeriod = (idx, p) => {
  const s = pool[idx];
  if (s) {
    s.p = p;
    loadChart(s, true).then(() => render(pool));
  }
};

window.toggleOverlay = (idx, key) => {
  const s = pool[idx];
  if (s) {
    s.ov[key] = !s.ov[key];
    render(pool);
  }
};

window.changeSub = (idx, sub) => {
  const s = pool[idx];
  if (s) {
    s.sub = sub;
    render(pool);
  }
};

window.refreshMarketEnv = async () => {
  toast('正在刷新大盘与市场环境…', 'info');
  try {
    await loadMarket(true);
    renderMarket();
    toastOk('✓ 大盘环境数据已同步！');
  } catch (e) {
    toastErr('大盘环境刷新失败：' + e.message);
  }
};

/* ===================== 应用初始化 ===================== */
function initApp() {
  console.log('[T-Stock] A股做T执行台 ESM 模块化引擎启动...');

  // 注册全局图表自愈取数装载器
  registerChartLoader(loadChart);

  // 初始化导航与选项卡
  initTabs();

  // 基础渲染
  render(pool);
  renderSelectionPool();
  renderAccount();
  renderMarket();
  renderTailBuySection();
  renderLog();
  renderCheckup();
  renderPerfTable();
  renderTopbar();
  renderPoolTabs();

  // 顶栏资产胶囊点击切换到账户Tab
  const tbAccPill = document.getElementById('tbAccPill');
  if (tbAccPill) {
    tbAccPill.onclick = () => {
      switchTab('tabAccount');
      const el = document.getElementById('accSec');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  // 顶栏时钟胶囊点击打开时钟弹窗
  const tbClockPill = document.getElementById('tbClockPill');
  if (tbClockPill) {
    tbClockPill.onclick = openClockModal;
  }
  const clockClose = document.getElementById('clockModalClose');
  if (clockClose) {
    clockClose.onclick = closeClockModal;
  }

  // 入选逻辑弹窗关闭
  const srmClose = document.getElementById('srmClose');
  if (srmClose) {
    srmClose.onclick = closeStockReasonModal;
  }

  // 闪电记T Modal 关闭与确认
  const qtmClose = document.getElementById('qtClose');
  if (qtmClose) qtmClose.onclick = closeQuickTModal;
  const qtmCancel = document.getElementById('qtCancel');
  if (qtmCancel) qtmCancel.onclick = closeQuickTModal;
  const qtmConfirm = document.getElementById('qtConfirm');
  if (qtmConfirm) qtmConfirm.onclick = execQuickT;

  document.querySelectorAll('.m-dir-btn').forEach(btn => {
    btn.onclick = () => {
      setQtDir(btn.dataset.dir);
      updateQtPreview();
    };
  });

  const qtBuy = document.getElementById('qtBuy');
  const qtSell = document.getElementById('qtSell');
  const qtQty = document.getElementById('qtQty');
  if (qtBuy) qtBuy.oninput = updateQtPreview;
  if (qtSell) qtSell.oninput = updateQtPreview;
  if (qtQty) qtQty.oninput = updateQtPreview;

  // 添加自选输入框绑定
  const dbInput = document.getElementById('dbInput');
  const dbBtn = document.getElementById('dbAdd') || document.getElementById('dbBtn');
  if (dbBtn && dbInput) {
    const doAdd = () => {
      const q = dbInput.value.trim();
      if (!q) { toastWarn('请输入股票代码或名称'); return; }
      addByQuery(q).then(() => {
        dbInput.value = '';
        renderPoolTabs();
        renderTopbar();
        updateTabBadges();
        syncSelectionChips();
      });
    };
    dbBtn.onclick = doAdd;
    dbInput.onkeydown = (e) => {
      if (e.key === 'Enter') doAdd();
    };
  }

  // 全量刷新按钮绑定 (兼容页面中 dbRefresh 以及旧 ID dbSync)
  const dbSync = document.getElementById('dbRefresh') || document.getElementById('dbSync');
  if (dbSync) {
    dbSync.onclick = () => refreshAll(false);
  }

  // 顶栏刷新按钮绑定
  const tbRefresh = document.getElementById('tbRefresh');
  if (tbRefresh) {
    tbRefresh.onclick = () => refreshAll(false);
  }

  // 网络自检按钮绑定 (兼容页面中 dbTest 以及旧 ID dbSelfTest)
  const dbSelfTest = document.getElementById('dbTest') || document.getElementById('dbSelfTest');
  if (dbSelfTest) {
    dbSelfTest.onclick = selfTest;
  }

  // 新增台账按钮
  const btnLogAdd = document.getElementById('btnLogAdd');
  if (btnLogAdd) btnLogAdd.onclick = logAdd;

  // 备份与导出
  const btnExport = document.getElementById('btnExport');
  if (btnExport) btnExport.onclick = exportAll;
  const fileImport = document.getElementById('fileImport');
  if (fileImport) {
    fileImport.onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        importAll(e.target.files[0]);
      }
    };
  }

  // 顶栏功能按钮绑定
  const tbCopyPlan = document.getElementById('tbCopyPlan');
  if (tbCopyPlan) tbCopyPlan.onclick = copyPlan;

  const tbExport = document.getElementById('tbExport');
  if (tbExport) tbExport.onclick = exportAll;

  const tbImport = document.getElementById('tbImport');
  const importFile = document.getElementById('importFile');
  if (tbImport && importFile) {
    tbImport.onclick = () => importFile.click();
    importFile.onchange = (e) => {
      if (e.target.files && e.target.files[0]) importAll(e.target.files[0]);
    };
  }

  const tbNotify = document.getElementById('tbNotify');
  if (tbNotify) {
    tbNotify.onclick = () => {
      if (!('Notification' in window)) { toastWarn('当前浏览器不支持桌面通知'); return; }
      if (Notification.permission === 'granted') { toastOk('桌面通知已处于开启状态'); return; }
      if (Notification.permission === 'denied') { toastWarn('桌面通知权限已被禁止，请在地址栏设置中允许'); return; }
      Notification.requestPermission().then(p => {
        if (p === 'granted') { toastOk('✓ 桌面通知已成功开启！'); tbNotify.textContent = '🔔 已开启'; }
        else toastWarn('未授权桌面通知');
      });
    };
    if ('Notification' in window && Notification.permission === 'granted') {
      tbNotify.textContent = '🔔 已开启';
    }
  }

  const toTop = document.getElementById('toTop');
  if (toTop) {
    toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    window.addEventListener('scroll', () => {
      toTop.style.display = window.scrollY > 400 ? 'block' : 'none';
    });
  }

  // 启动后台定时任务
  setupTimer();
  updateTradingClock();
  paintStamp();
  setInterval(updateTradingClock, 1000);
  setInterval(paintStamp, 5000);

  // 首屏静默拉取行情
  setTimeout(() => refreshAll(true), 300);

  // 初次加载动画
  animCardsStagger('#pool');
}

// DOM 加载就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
