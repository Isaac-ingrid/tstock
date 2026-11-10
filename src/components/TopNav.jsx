import React from 'react';
import { f2, pct, money } from '../services/utils.js';
import { calc } from '../services/api.js';
import { MODE_BADGE } from './StockCard.jsx';
import { NAV_ROUTES } from '../data/site.js';

export default function TopNav({
  activeTab,
  onTabChange,
  pool,
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
  alertEnabled = true
}) {
  const getBadge = (key) => {
    if (key === 'poolCount') return pool.length > 0 ? pool.length : null;
    if (key === 'tailCount') return tailCount > 0 ? tailCount : null;
    if (key === 'ledgerCount') return ledgerCount > 0 ? ledgerCount : null;
    if (key === 'boardCount') return '热';
    return null;
  };

  return (
    <div className="topbar" id="topbar">
      {/* 品牌 Logo 与标题 */}
      <div
        className="tb-brand"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          marginRight: '8px',
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: '6px',
          userSelect: 'none'
        }}
        onClick={() => onTabChange('/trade')}
        title="做T执行台 · 首页"
      >
        <img
          src="/favicon.svg"
          alt="T-Stock"
          style={{ width: '22px', height: '22px', borderRadius: '6px', filter: 'drop-shadow(0 2px 6px rgba(56, 189, 248, 0.4))' }}
        />
        <span style={{
          fontWeight: 800,
          fontSize: '14px',
          letterSpacing: '-0.2px',
          background: 'linear-gradient(135deg, #0284c7 0%, #059669 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          T-Stock
        </span>
      </div>

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

      {/* 已选做T股票快捷胶囊列表（可点击直接切换并平滑跳转至对应决策卡片） */}
      {pool && pool.length > 0 && (
        <div className="tb-pool-chips" title="我的已选做T股票 · 点击直接切换并跳转到对应决策卡片">
          <span className="tb-pool-title">已选:</span>
          {pool.map(s => {
            const code6 = String(s.code).padStart(6, '0');
            const isCur = String(activeStockCode) === code6;
            const pc = +s.prevClose || 0;
            const px = +s.price || pc;
            const chg = pc ? ((px - pc) / pc) * 100 : 0;
            const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
            const isShort = (s.tier === 'short' || s.poolTag === '短线');
            let mbd = MODE_BADGE.WAIT;
            try {
              const c = calc(s);
              if (c && c.mode && MODE_BADGE[c.mode]) {
                mbd = MODE_BADGE[c.mode];
              }
            } catch (e) {
              mbd = MODE_BADGE.WAIT;
            }

            return (
              <button
                key={code6}
                type="button"
                className={`tb-stock-chip ${isCur ? 'active' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  if (onSelectStock) onSelectStock(code6);
                }}
                title={`点击直接跳转查看【${s.name}】(${code6}) 做T决策卡片\n现价: ¥${f2(px)}  涨跌: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%\n信号状态: ${mbd[1]}`}
              >
                <span className={`tb-chip-tag ${isShort ? 'short' : 'long'}`}>
                  {isShort ? '短' : '稳'}
                </span>
                <span className="tb-chip-name">{s.name}</span>
                <span className={`tb-chip-px ${chgCls}`}>{f2(px)}</span>
                <span className={`tb-chip-chg ${chgCls}`}>
                  {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                </span>
                <span className={`mg ${mbd[0]}`} style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '4px', lineHeight: '14px', whiteSpace: 'nowrap' }}>
                  {mbd[1]}
                </span>
              </button>
            );
          })}
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
          className={`tb-btn ${!alertEnabled ? 'tb-btn-muted' : notifyActive ? 'tb-btn-active' : ''}`}
          id="btnToggleNotify"
          onClick={onOpenAlertModal || onToggleNotify}
          title={alertEnabled ? "点击查看盘中到价与买卖提醒中心（可切换上班免打扰模式）" : "【上班免打扰模式已开启】提示音、弹窗与标题已静音。点击打开设置"}
          style={!alertEnabled ? { background: '#f5f5f5', color: '#8c8c8c', borderColor: '#d9d9d9' } : undefined}
        >
          {alertEnabled ? '🔔 提醒' : '🔕 提醒已关'}
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
