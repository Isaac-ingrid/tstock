import React from 'react';
import { f2, money } from '../services/utils.js';
import { buildActionSignal } from './BattleCardGrid.jsx';
import { NAV_ROUTES } from '../data/site.js';

export default function TopNav({
  activeTab,
  onTabChange,
  pool = [],
  activeStockCode,
  onSelectStock,
  tailCount,
  ledgerCount,
  totalAssets,
  marketValue,
  posRate,
  clockPhase,
  quoteStamp,
  isStale,
  onOpenClock,
  onOpenAlertModal,
  onCopyPlan,
  onExport,
  onImportClick,
  onRefresh,
  onToggleNotify,
  notifyActive,
  alertEnabled = true,
}) {
  const getBadge = (key) => {
    if (key === 'poolCount') return pool.length > 0 ? pool.length : null;
    if (key === 'tailCount') return tailCount > 0 ? tailCount : null;
    if (key === 'ledgerCount') return ledgerCount > 0 ? ledgerCount : null;
    if (key === 'boardCount') return '热';
    if (key === 'ignitionCount') return '新';
    return null;
  };

  const holdingStocks = pool.filter((s) => (s.shares || 0) > 0);
  const watchStocks = pool.filter((s) => (s.shares || 0) <= 0);

  return (
    <div className={`topbar topbar-v2 ${isStale ? 'stale' : ''}`} id="topbar">
      {/* 第一行：品牌 + 主导航 + 核心操作按钮（互不挤压） */}
      <div className="tb-row-main">
        <div
          className="tb-brand"
          onClick={() => onTabChange('/trade')}
          title="智策战情室 · 首页"
        >
          <img src="/favicon.svg" alt="T-Stock" className="tb-logo" />
          <span className="tb-brand-txt">T-Stock</span>
        </div>

        <nav className="tb-nav" id="topNav">
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
          <button
            type="button"
            className={`tb-btn ${!alertEnabled ? 'tb-btn-muted' : notifyActive ? 'tb-btn-active' : ''}`}
            id="btnToggleNotify"
            onClick={onOpenAlertModal || onToggleNotify}
            title={alertEnabled ? '盘中到价与买卖提醒设置' : '免打扰模式已开启，点击设置'}
          >
            {alertEnabled ? '🔔 提醒' : '🔕 静音'}
          </button>
          <button
            type="button"
            className="tb-btn tb-btn-refresh"
            id="btnRefreshAll"
            onClick={onRefresh}
            title="立即拉取最新行情与深度分时"
          >
            ↻ 刷新
          </button>
          <details className="tb-more">
            <summary className="tb-btn" title="更多工具（计划复制 / 导入导出）">⋯</summary>
            <div className="tb-more-menu">
              <button type="button" onClick={onCopyPlan}>📋 复制今日作战计划</button>
              <button type="button" onClick={onExport}>⬇ 导出 JSON 备份</button>
              <button type="button" onClick={onImportClick}>⬆ 导入 JSON 恢复</button>
            </div>
          </details>
        </div>
      </div>

      {/* 第二行：资产胶囊 + 盘中时钟 + 持仓/自选单行横滑快捷联动条 */}
      <div className="tb-row-sub">
        <div
          className="tb-acc-pill"
          id="tbAccPill"
          title="点击跳转至账户总览与资金详情"
          onClick={() => onTabChange('/account')}
        >
          <span className="tb-acc-k">资产</span>
          <b>¥{money(totalAssets)}</b>
          <span className="tb-acc-sep" />
          <span className="tb-acc-k">市值</span>
          <b>¥{money(marketValue)}</b>
          <span className="tb-acc-sep" />
          <span className="tb-acc-k">仓位</span>
          <b>{posRate.toFixed(1)}%</b>
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

        {pool.length > 0 && (
          <div className="tb-pool-scroll" title="点击任意标的直达今日作战台并展开其面板">
            {holdingStocks.length > 0 && <span className="tb-grp-lbl pos">持仓</span>}
            {holdingStocks.map((s) => {
              const code6 = String(s.code).padStart(6, '0');
              const isCur = String(activeStockCode) === code6;
              const sig = buildActionSignal(s);
              const chgCls = sig.chg > 0 ? 'up' : sig.chg < 0 ? 'down' : '';
              return (
                <button
                  key={code6}
                  type="button"
                  className={`tb-stock-chip kind-${sig.kind} ${isCur ? 'active' : ''}`}
                  onClick={() => onSelectStock && onSelectStock(code6)}
                  title={`${s.name} (${code6}) · ${sig.badge}\n${sig.headline}`}
                >
                  <span className="tb-chip-name">{s.name}</span>
                  <span className={`tb-chip-px ${chgCls}`}>{f2(sig.px)}</span>
                  <span className={`tb-chip-chg ${chgCls}`}>
                    {sig.chg >= 0 ? '+' : ''}{sig.chg.toFixed(1)}%
                  </span>
                  <span className={`tb-sig-dot kind-${sig.kind}`} />
                </button>
              );
            })}

            {watchStocks.length > 0 && <span className="tb-grp-lbl watch">自选</span>}
            {watchStocks.map((s) => {
              const code6 = String(s.code).padStart(6, '0');
              const isCur = String(activeStockCode) === code6;
              const sig = buildActionSignal(s);
              const chgCls = sig.chg > 0 ? 'up' : sig.chg < 0 ? 'down' : '';
              return (
                <button
                  key={code6}
                  type="button"
                  className={`tb-stock-chip kind-${sig.kind} ${isCur ? 'active' : ''}`}
                  onClick={() => onSelectStock && onSelectStock(code6)}
                  title={`${s.name} (${code6}) · ${sig.badge}\n${sig.headline}`}
                >
                  <span className="tb-chip-name">{s.name}</span>
                  <span className={`tb-chip-px ${chgCls}`}>{f2(sig.px)}</span>
                  <span className={`tb-chip-chg ${chgCls}`}>
                    {sig.chg >= 0 ? '+' : ''}{sig.chg.toFixed(1)}%
                  </span>
                  <span className={`tb-sig-dot kind-${sig.kind}`} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
