import React, { useEffect, useRef, useState } from 'react';
import { money } from '../services/utils.js';
import { NAV_ROUTES } from '../data/site.js';
import { syncRemoteTradeCalendar } from '../services/calendar.js';
import { evaluateTopNavClockBadge } from '../services/risk.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';
import Icon from './Icons.jsx';

const MOBILE_PRIMARY_TABS = ['/trade', '/board', '/ignition', '/diagnosis', '/ledger'];

export default function TopNav({
  activeTab,
  onTabChange,
  pool = [],
  tailCount,
  ledgerCount,
  totalAssets,
  cash = 0,
  marketValue,
  posRate,
  allowedCapPct = 80,
  onUpdateTotalAssets = null,
  onUpdateCash = null,
  clockPhase,
  quoteStamp,
  isStale,
  onOpenClock,
  onOpenAlertModal,
  onOpenEodModal,
  onOpenPwaModal,
  isStandalone = false,
  todayArchived = false,
  isPostMarketWindow = false,
  onCopyPlan,
  onExport,
  onImportClick,
  onRefresh,
  onToggleNotify,
  notifyActive,
  alertEnabled = true,
  currentUser = null,
  onOpenAccountModal = null,
  theme = 'dark',
  onToggleTheme = null,
}) {
  const moreRef = useRef(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [, setCalendarReadyTick] = useState(0);

  useEffect(() => {
    syncRemoteTradeCalendar().finally(() => {
      setCalendarReadyTick((n) => n + 1);
    });
  }, []);

  const closeMore = () => {
    if (moreRef.current) {
      moreRef.current.open = false;
    }
  };

  // 支持 Escape 关闭更多菜单与移动端抽屉，以及点击外部自动收起菜单
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeMore();
        setMobileSheetOpen(false);
      }
    };
    const onPointerDown = (e) => {
      if (moreRef.current && moreRef.current.open && !moreRef.current.contains(e.target)) {
        moreRef.current.open = false;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, []);

  const activeRoute = NAV_ROUTES.find((r) => r.tab === activeTab) || NAV_ROUTES[0];
  const holdingCount = pool.filter((s) => (s.shares || 0) > 0).length;
  const watchCount = Math.max(0, pool.length - holdingCount);

  const clockBadge = evaluateTopNavClockBadge({
    totalPosPct: posRate,
    totalMkt: marketValue,
    totalAssets,
    emotionCapPct: allowedCapPct,
  });

  const archiveToneCls = todayArchived
    ? 'is-archived'
    : isPostMarketWindow
    ? 'is-eod-due'
    : '';

  const mobileTabs = MOBILE_PRIMARY_TABS.map((p) => NAV_ROUTES.find((r) => r.path === p)).filter(Boolean);

  return (
    <>
      <header className={`topbar topbar-v3 ${isStale ? 'stale' : ''}`} id="topbar">
        {/* 左侧：移动端品牌 + 当前活跃视图标题 */}
        <div className="tb-left">
          <button
            type="button"
            className="tb-mobile-brand"
            onClick={() => onTabChange('/trade')}
            aria-label="返回今日作战台"
            title="智策战情室 · 今日作战台"
          >
            <img src="/favicon.svg" alt="" className="tb-logo" aria-hidden="true" />
          </button>

          <div className="tb-view-heading" id="topNav">
            <Icon name={activeRoute.iconKey} size={16} active />
            <h1 className="tb-view-title">{activeRoute.label}</h1>
            {isStandalone && (
              <span className="tb-pwa-tag" title="独立全屏盯盘模式">
                APP
              </span>
            )}
          </div>

          <button
            type="button"
            className="tb-pool-summary"
            onClick={() => onTabChange('/trade')}
            title="直达今日作战台查看持仓与自选卡片"
          >
            <span className="tb-grp-lbl pos num-mono">持 {holdingCount}</span>
            <span className="tb-grp-lbl watch num-mono">选 {watchCount}</span>
          </button>
        </div>

        {/* 中右部：账户资金直输胶囊 + 交易时钟与节前黄牌角标 + 快捷工具栏 */}
        <div className="tb-right">
          <div
            className="tb-acc-pill num-mono"
            id="tbAccPill"
            title="点击金额直接编辑总资产或可用现金；点击「账户」查看净值曲线与节前水位"
            onClick={() => onTabChange('/account')}
          >
            <span className="tb-acc-k">资产</span>
            {onUpdateTotalAssets ? (
              <DirectMoneyInput
                value={totalAssets}
                onCommit={onUpdateTotalAssets}
                min={0}
                allowZero={true}
                size="pill"
                ariaLabel="顶栏实时总资产输入"
                title="点击直接输入账户总资产（如 200000 或 20w，回车保存）"
              />
            ) : (
              <b>¥{money(totalAssets)}</b>
            )}
            <span className="tb-acc-sep" />
            <span className="tb-acc-k">现金</span>
            {onUpdateCash ? (
              <DirectMoneyInput
                value={cash}
                onCommit={onUpdateCash}
                min={0}
                allowZero={true}
                size="pill"
                tone="cash"
                ariaLabel="顶栏可用现金输入"
                title="点击直接输入可用现金（如 85000 或 8.5w，回车保存）"
              />
            ) : (
              <b>¥{money(cash)}</b>
            )}
            <span className="tb-acc-sep tb-acc-mkt" />
            <span className="tb-acc-k tb-acc-mkt">市值</span>
            <b className="tb-acc-mkt">¥{money(marketValue)}</b>
            <span className="tb-acc-sep" />
            <span className="tb-acc-k">仓位</span>
            <b className={posRate > allowedCapPct + 0.1 ? 'is-overcap' : ''}>
              {posRate.toFixed(1)}%
            </b>
          </div>

          <button
            type="button"
            className={`tb-clock-pill ${clockBadge.pillTone || ''}`.trim()}
            id="tbClockPill"
            title={clockBadge.tooltip}
            onClick={onOpenClock}
            aria-label={`交易时钟：${clockPhase}`}
          >
            <span className={`clock-dot dot-${clockBadge.dotTone}`} aria-hidden="true" />
            <span id="tbClockPhase">{clockPhase}</span>
            {clockBadge.showBadge && (
              <span
                className={`tb-clock-badge tone-${clockBadge.badgeTone}`}
                id="tbClockHolidayBadge"
              >
                {clockBadge.badgeText}
              </span>
            )}
            <span
              className={`tb-quote-time num-mono ${isStale ? 'tb-quote-stale' : ''}`}
              id="tbQuoteTime"
            >
              {quoteStamp}
            </span>
          </button>

          <div className="tb-actions">
            {onToggleTheme && (
              <button
                type="button"
                className="tb-btn tb-btn-icon tb-mobile-theme"
                onClick={onToggleTheme}
                title={theme === 'dark' ? '切换为日间浅色模式' : '切换为暗黑终端模式'}
                aria-label={theme === 'dark' ? '切换为日间浅色模式' : '切换为暗黑终端模式'}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
              </button>
            )}

            <button
              type="button"
              className={`tb-btn ${!alertEnabled ? 'tb-btn-muted' : notifyActive ? 'tb-btn-active' : ''}`}
              id="btnToggleNotify"
              onClick={onOpenAlertModal || onToggleNotify}
              title={alertEnabled ? '盘中到价与买卖提醒设置' : '免打扰模式已开启，点击设置'}
              aria-label={alertEnabled ? '盘中提醒设置' : '当前静音，点击设置提醒'}
            >
              <Icon name={alertEnabled ? 'bell' : 'bellOff'} size={14} />
              <span className="tb-btn-txt">{alertEnabled ? '提醒' : '静音'}</span>
            </button>

            {onOpenEodModal && (
              <button
                type="button"
                className={`tb-btn ${archiveToneCls}`.trim()}
                id="btnEodArchive"
                onClick={onOpenEodModal}
                title="15:05 盘后一键五步收盘归档（同步收盘价 · 排查未平T · 净值快照 · 复盘简报 · 本地金库落盘）"
                aria-label="15:05 收盘归档"
              >
                <Icon name="archive" size={14} />
                <span className="tb-btn-txt">
                  {todayArchived ? '已归档' : isPostMarketWindow ? '待归档' : '归档'}
                </span>
              </button>
            )}

            <button
              type="button"
              className="tb-btn tb-btn-refresh"
              id="btnRefreshAll"
              onClick={onRefresh}
              title="立即拉取最新行情与深度分时"
              aria-label="立即刷新行情"
            >
              <Icon name="refresh" size={14} />
              <span className="tb-btn-txt">刷新</span>
            </button>

            <details className="tb-more" ref={moreRef}>
              <summary
                className="tb-btn tb-btn-icon"
                title="更多工具（账号金库 / 手机主屏 / 计划复制 / 备份恢复）"
                aria-label="打开更多操作菜单"
              >
                <Icon name="more" size={15} />
              </summary>
              <div className="tb-more-menu" role="menu">
                {onToggleTheme && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMore();
                      onToggleTheme();
                    }}
                  >
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
                    <span>{theme === 'dark' ? '切换为日间浅色模式' : '切换为暗色终端模式'}</span>
                  </button>
                )}
                {currentUser && onOpenAccountModal && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMore();
                      onOpenAccountModal();
                    }}
                  >
                    <Icon name="user" size={14} />
                    <span>
                      {currentUser.role === 'owner' ? '账号与邀请码管理' : '个人账号与云金库'}
                    </span>
                  </button>
                )}
                {onOpenPwaModal && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMore();
                      onOpenPwaModal();
                    }}
                  >
                    <Icon name="smartphone" size={14} />
                    <span>{isStandalone ? '全屏盯盘模式说明' : '添加到手机主屏幕'}</span>
                  </button>
                )}
                {onOpenEodModal && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMore();
                      onOpenEodModal();
                    }}
                  >
                    <Icon name="archive" size={14} />
                    <span>15:05 盘后一键收盘归档</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    if (onCopyPlan) onCopyPlan();
                  }}
                >
                  <Icon name="copy" size={14} />
                  <span>复制今日作战计划</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    if (onExport) onExport();
                  }}
                >
                  <Icon name="download" size={14} />
                  <span>导出 JSON 备份</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    if (onImportClick) onImportClick();
                  }}
                >
                  <Icon name="upload" size={14} />
                  <span>导入 JSON 恢复</span>
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>

      {/* 移动端（<960px）底部安全区常驻导航栏（44px+ 触控热区） */}
      <nav className="mobile-bottom-dock" aria-label="移动端底部主导航">
        {mobileTabs.map((item) => {
          const isActive = activeTab === item.tab;
          return (
            <a
              key={item.path}
              href={`#${item.path}`}
              className={`mbd-item ${isActive ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                setMobileSheetOpen(false);
                onTabChange(item.path);
              }}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon name={item.iconKey} size={18} active={isActive} />
              <span>{item.shortLabel || item.label}</span>
            </a>
          );
        })}
        <button
          type="button"
          className={`mbd-item mbd-more-btn ${mobileSheetOpen ? 'active' : ''}`}
          onClick={() => setMobileSheetOpen((v) => !v)}
          aria-expanded={mobileSheetOpen}
          aria-label="展开全部导航模块"
        >
          <Icon name="all" size={18} active={mobileSheetOpen} />
          <span>更多</span>
        </button>
      </nav>

      {/* 移动端「更多模块」上拉面板（使用纯色遮罩） */}
      {mobileSheetOpen && (
        <div
          className="modal-mask"
          onClick={() => setMobileSheetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="全部功能模块导航"
        >
          <div className="modal-box mbd-sheet-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>全部战情模块</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setMobileSheetOpen(false)}
                aria-label="关闭模块导航"
              >
                ×
              </button>
            </div>
            <div className="modal-bd mbd-sheet-grid">
              {NAV_ROUTES.map((item) => {
                const isActive = activeTab === item.tab;
                const badgeCount =
                  item.badgeKey === 'poolCount'
                    ? pool.length
                    : item.badgeKey === 'tailCount'
                    ? tailCount
                    : item.badgeKey === 'ledgerCount'
                    ? ledgerCount
                    : null;
                return (
                  <button
                    key={item.path}
                    type="button"
                    className={`mbd-sheet-card ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      setMobileSheetOpen(false);
                      onTabChange(item.path);
                    }}
                  >
                    <div className="mbd-sc-top">
                      <Icon name={item.iconKey} size={17} active={isActive} />
                      <b>{item.label}</b>
                      {badgeCount > 0 && <span className="sr-badge num-mono">{badgeCount}</span>}
                    </div>
                    <span className="mbd-sc-desc">{item.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
