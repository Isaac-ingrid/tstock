import React from 'react';
import { f2, pct, money } from '../services/utils.js';
import { NAV_ROUTES } from '../data/site.js';

export default function TopNav({
  activeTab,
  onTabChange,
  pool,
  tailCount,
  ledgerCount,
  totalAssets,
  marketValue,
  posRate,
  clockPhase,
  quoteStamp,
  isStale,
  onOpenClock,
  onCopyPlan,
  onExport,
  onImportClick,
  onRefresh,
  onToggleNotify,
  notifyActive
}) {
  const getBadge = (key) => {
    if (key === 'poolCount') return pool.length > 0 ? pool.length : null;
    if (key === 'tailCount') return tailCount > 0 ? tailCount : null;
    if (key === 'ledgerCount') return ledgerCount > 0 ? ledgerCount : null;
    return null;
  };

  return (
    <div className="topbar" id="topbar">
      <div className="tb-nav" id="topNav">
        {NAV_ROUTES.map(item => {
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
      </div>

      <span className="tb-sep"></span>

      {/* 常驻账户资产胶囊 */}
      <div
        className="tb-acc-pill"
        id="tbAccPill"
        title="点击跳转至账户总览与资金详情"
        onClick={() => onTabChange('/account')}
        style={{ cursor: 'pointer' }}
      >
        <span className="tb-acc-k">总资产</span>
        <b>¥{money(totalAssets)}</b>
        <span className="tb-acc-sep"></span>
        <span className="tb-acc-k">市值</span>
        <b>¥{money(marketValue)}</b>
        <span className="tb-acc-sep"></span>
        <span className="tb-acc-k">仓位</span>
        <b>{posRate.toFixed(1)}%</b>
      </div>

      <span className="tb-sep"></span>

      {/* 盘中时钟状态胶囊 */}
      <div
        className="tb-clock-pill"
        id="tbClockPill"
        title="点击展开全天交易纪律时钟与窗口说明"
        onClick={onOpenClock}
        style={{ cursor: 'pointer' }}
      >
        <span className="clock-dot"></span>
        <span id="tbClockPhase">{clockPhase}</span>
        <span className={`tb-quote-time ${isStale ? 'tb-quote-stale' : ''}`} id="tbQuoteTime">
          {quoteStamp}
        </span>
      </div>

      {/* 滚动轮播价格卡（选股池行情简报） */}
      {pool && pool.length > 0 && (
        <div className="tb-ticker-wrap" title="当前做T股池实时报价速览">
          <div className="tb-ticker-track">
            {pool.map(s => {
              const chg = s.prevClose ? (((s.price || s.prevClose) - s.prevClose) / s.prevClose) * 100 : 0;
              const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
              return (
                <div key={s.code} className="tb-ticker-item">
                  <span className="nm">{s.name}</span>
                  <span className="px">{f2(s.price || s.prevClose)}</span>
                  <span className={`chg ${cls}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 操作快捷按钮组 */}
      <div className="tb-actions">
        <button
          className="tb-btn"
          id="btnCopyTodayPlan"
          onClick={onCopyPlan}
          title="将当前全池股票的做T预案一键复制到剪贴板，方便发送到复盘笔记或微信"
        >
          📋 作战计划
        </button>
        <button
          className="tb-btn"
          id="btnExportPlan"
          onClick={onExport}
          title="导出全部数据为 JSON 文件备份"
        >
          ⬇ 导出
        </button>
        <button
          className="tb-btn"
          id="btnImportPlan"
          onClick={onImportClick}
          title="从 JSON 备份文件恢复数据"
        >
          ⬆ 导入
        </button>
        <button
          className={`tb-btn ${notifyActive ? 'tb-btn-active' : ''}`}
          id="btnToggleNotify"
          onClick={onToggleNotify}
          title="开启/关闭盘中冲高回落预警桌面通知"
        >
          🔔 提醒
        </button>
        <button
          className="tb-btn tb-btn-refresh"
          id="btnRefreshAll"
          onClick={onRefresh}
          title="立即拉取最新行情与深度分时"
        >
          ↻ 刷新
        </button>
      </div>
    </div>
  );
}
