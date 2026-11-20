import React, { useEffect, useRef } from 'react';
import { money } from '../services/utils.js';
import { NAV_ROUTES } from '../data/site.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';

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
}) {
  const navRef = useRef(null);
  const moreRef = useRef(null);

  // 窄屏横向滑动导航栏：切换Tab时仅在导航容器内平滑居中当前项，绝不干扰页面纵向滚动
  useEffect(() => {
    const navEl = navRef.current;
    if (!navEl || navEl.scrollWidth <= navEl.clientWidth + 4) return;
    const activeEl = navEl.querySelector('a.active');
    if (!activeEl) return;
    const targetLeft = Math.max(
      0,
      activeEl.offsetLeft - navEl.clientWidth / 2 + activeEl.clientWidth / 2
    );
    try {
      navEl.scrollTo({ left: targetLeft, behavior: 'smooth' });
    } catch (_) {
      navEl.scrollLeft = targetLeft;
    }
  }, [activeTab]);

  const closeMore = () => {
    if (moreRef.current) {
      moreRef.current.open = false;
    }
  };

  const getBadge = (key) => {
    if (key === 'poolCount') return pool.length > 0 ? pool.length : null;
    if (key === 'tailCount') return tailCount > 0 ? tailCount : null;
    if (key === 'ledgerCount') return ledgerCount > 0 ? ledgerCount : null;
    if (key === 'boardCount') return '热';
    if (key === 'ignitionCount') return '新';
    return null;
  };

  const holdingCount = pool.filter((s) => (s.shares || 0) > 0).length;
  const watchCount = pool.length - holdingCount;

  return (
    <div className={`topbar topbar-v2 ${isStale ? 'stale' : ''}`} id="topbar">
      {/* 第一行：品牌 + 主导航（窄屏自动沉降为单行横滑条） + 核心操作按钮 */}
      <div className="tb-row-main">
        <div
          className="tb-brand"
          onClick={() => onTabChange('/trade')}
          title="智策战情室 · 直达今日作战台"
        >
          <img src="/favicon.svg" alt="T-Stock" className="tb-logo" />
          <span className="tb-brand-txt">T-Stock</span>
          {isStandalone && <span className="tb-pwa-tag" title="当前处于主屏幕独立全屏盯盘模式">APP</span>}
        </div>

        <nav className="tb-nav" id="topNav" ref={navRef}>
          {NAV_ROUTES.map((item) => {
            const badge = getBadge(item.badgeKey);
            const isActive = activeTab === item.tab;
            return (
              <a
                key={item.path}
                href={`#${item.path}`}
                className={isActive ? 'active' : ''}
                style={item.highlight ? { color: 'var(--accent)', fontWeight: 700 } : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange(item.path);
                }}
                title={item.desc}
              >
                {item.label}
                {badge != null && <span className="tb-badge">{badge}</span>}
              </a>
            );
          })}
        </nav>

        <div className="tb-actions">
          {currentUser && onOpenAccountModal && (
            <button
              type="button"
              className="tb-btn tb-user-btn"
              onClick={onOpenAccountModal}
              title={`当前账号：${currentUser.displayName || currentUser.username}（点击管理独立云金库、密码${currentUser.role === 'owner' ? '与好友邀请码' : ''}）`}
            >
              <span>{currentUser.role === 'owner' ? '👑' : '👤'}</span>
              <span className="tb-btn-txt">{currentUser.displayName || currentUser.username}</span>
            </button>
          )}
          <button
            type="button"
            className={`tb-btn ${!alertEnabled ? 'tb-btn-muted' : notifyActive ? 'tb-btn-active' : ''}`}
            id="btnToggleNotify"
            onClick={onOpenAlertModal || onToggleNotify}
            title={alertEnabled ? '盘中到价与买卖提醒设置' : '免打扰模式已开启，点击设置'}
          >
            <span>{alertEnabled ? '🔔' : '🔕'}</span>
            <span className="tb-btn-txt">{alertEnabled ? '提醒' : '静音'}</span>
          </button>
          {onOpenEodModal && (
            <button
              type="button"
              className="tb-btn"
              id="btnEodArchive"
              onClick={onOpenEodModal}
              title="15:05 盘后一键五步收盘归档（同步收盘价 · 排查未平T · 净值快照 · 复盘简报 · 本地金库落盘）"
              style={
                todayArchived
                  ? { background: '#f0fdf4', borderColor: '#86efac', color: '#15803d', fontWeight: 700 }
                  : isPostMarketWindow
                  ? { background: '#fffbeb', borderColor: '#f59e0b', color: '#b45309', fontWeight: 800 }
                  : undefined
              }
            >
              <span>{todayArchived ? '✅' : '🏁'}</span>
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
          >
            <span>↻</span>
            <span className="tb-btn-txt">刷新</span>
          </button>
          <details className="tb-more" ref={moreRef}>
            <summary className="tb-btn" title="更多工具（账号金库 / 添加到手机主屏 / 计划复制 / 收盘归档 / 导入导出）">⋯</summary>
            <div className="tb-more-menu">
              {currentUser && onOpenAccountModal && (
                <button
                  type="button"
                  onClick={() => {
                    closeMore();
                    onOpenAccountModal();
                  }}
                >
                  {currentUser.role === 'owner' ? '👑 账号与邀请码管理' : '👤 个人账号与云金库'}
                </button>
              )}
              {onOpenPwaModal && (
                <button
                  type="button"
                  onClick={() => {
                    closeMore();
                    onOpenPwaModal();
                  }}
                >
                  {isStandalone ? '📱 全屏盯盘模式说明' : '📲 添加到手机主屏幕'}
                </button>
              )}
              {onOpenEodModal && (
                <button
                  type="button"
                  onClick={() => {
                    closeMore();
                    onOpenEodModal();
                  }}
                >
                  🏁 15:05 盘后一键收盘归档
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  closeMore();
                  if (onCopyPlan) onCopyPlan();
                }}
              >
                📋 复制今日作战计划
              </button>
              <button
                type="button"
                onClick={() => {
                  closeMore();
                  if (onExport) onExport();
                }}
              >
                ⬇ 导出 JSON 备份
              </button>
              <button
                type="button"
                onClick={() => {
                  closeMore();
                  if (onImportClick) onImportClick();
                }}
              >
                ⬆ 导入 JSON 恢复
              </button>
            </div>
          </details>
        </div>
      </div>

      {/* 第二行：精简状态条（资产/现金直输 + 盘中时钟 + 持仓/自选汇总入口，窄屏单行横滑不撑高） */}
      <div className="tb-row-sub">
        <div
          className="tb-acc-pill"
          id="tbAccPill"
          title="点击数字直接修改总资产/可用现金；点击「总览」查看净值曲线"
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
          <b>{posRate.toFixed(1)}%</b>
          <span className="tb-acc-jump" title="进入账户总览与净值详情">总览 ›</span>
        </div>

        <div
          className="tb-clock-pill"
          id="tbClockPill"
          title="点击展开全天交易纪律时钟与窗口说明"
          onClick={onOpenClock}
        >
          <span className="clock-dot" />
          <span id="tbClockPhase">{clockPhase}</span>
          <span className={`tb-quote-time ${isStale ? 'tb-quote-stale' : ''}`} id="tbQuoteTime">
            {quoteStamp}
          </span>
        </div>

        <button
          type="button"
          className="tb-pool-summary"
          onClick={() => onTabChange('/trade')}
          title="直达今日作战台查看全部持仓与自选买卖点卡片"
        >
          <span className="tb-grp-lbl pos">持仓 {holdingCount}</span>
          <span className="tb-grp-lbl watch">自选 {watchCount}</span>
          <span className="tb-sum-link">作战台 →</span>
        </button>
      </div>
    </div>
  );
}
