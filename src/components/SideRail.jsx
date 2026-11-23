import React, { useEffect, useState, useCallback } from 'react';
import { NAV_ROUTES } from '../data/site.js';
import { fetchQuotes } from '../services/api.js';
import Icon from './Icons.jsx';

const CORE_INDICES = [
  { tc: 'sh000001', label: '上证指数' },
  { tc: 'sz399001', label: '深证成指' },
  { tc: 'sz399006', label: '创业板指' },
  { tc: 'sh000688', label: '科创50' },
];

export default function SideRail({
  activeTab,
  onTabChange,
  collapsed = false,
  onToggleCollapse,
  theme = 'dark',
  onToggleTheme,
  pool = [],
  tailCount = 0,
  ledgerCount = 0,
  clockPhase = '',
  quoteStamp = '',
  currentUser = null,
  onOpenAccountModal = null,
  onCopyPlan = null,
}) {
  const [idxQuotes, setIdxQuotes] = useState({});

  const loadIndexQuotes = useCallback(async () => {
    try {
      const q = await fetchQuotes(CORE_INDICES.map((x) => x.tc));
      if (q && Object.keys(q).length > 0) {
        setIdxQuotes(q);
      }
    } catch (_) {
      // 网络离线或非交易环境静默降级，不打断盯盘
    }
  }, []);

  useEffect(() => {
    loadIndexQuotes();
  }, [loadIndexQuotes, quoteStamp]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadIndexQuotes();
    }, 25000);
    return () => clearInterval(timer);
  }, [loadIndexQuotes]);

  const holdingCount = pool.filter((s) => (s.shares || 0) > 0).length;
  const watchCount = Math.max(0, pool.length - holdingCount);

  const getBadge = (key) => {
    if (key === 'poolCount') return pool.length > 0 ? String(pool.length) : null;
    if (key === 'tailCount') return tailCount > 0 ? String(tailCount) : null;
    if (key === 'ledgerCount') return ledgerCount > 0 ? String(ledgerCount) : null;
    if (key === 'boardCount') return 'LIVE';
    if (key === 'ignitionCount') return 'SCAN';
    return null;
  };

  const coreRoutes = NAV_ROUTES.filter((r) => r.group === 'core');
  const reviewRoutes = NAV_ROUTES.filter((r) => r.group === 'review');

  const renderNavItem = (item) => {
    const isActive = activeTab === item.tab;
    const badge = getBadge(item.badgeKey);
    const isTagBadge = badge === 'LIVE' || badge === 'SCAN';
    return (
      <a
        key={item.path}
        href={`#${item.path}`}
        className={`sr-item ${isActive ? 'active' : ''}`}
        onClick={(e) => {
          e.preventDefault();
          onTabChange(item.path);
        }}
        title={collapsed ? `${item.label} · ${item.desc}` : item.desc}
        aria-label={item.label}
        aria-current={isActive ? 'page' : undefined}
      >
        <Icon name={item.iconKey} size={16} active={isActive} />
        {!collapsed && <span className="sr-item-lbl">{item.label}</span>}
        {!collapsed && badge != null && (
          <span className={`sr-badge num-mono ${isTagBadge ? 'is-tag' : ''}`}>{badge}</span>
        )}
      </a>
    );
  };

  return (
    <aside
      className={`side-rail ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="桌面端侧边主导航"
    >
      {/* 1. 品牌与折叠开关 */}
      <div className="sr-head">
        <button
          type="button"
          className="sr-brand-btn"
          onClick={() => onTabChange('/trade')}
          title="智策战情室 · 返回今日作战台"
          aria-label="返回今日作战台"
        >
          <img src="/favicon.svg" alt="" className="sr-logo" aria-hidden="true" />
          {!collapsed && (
            <span className="sr-brand-copy">
              <b className="sr-brand-name">智策战情室</b>
              <small className="sr-brand-sub num-mono">T+0 CONSOLE</small>
            </span>
          )}
        </button>
        <button
          type="button"
          className="sr-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧边导航栏' : '收起侧边导航栏'}
          aria-label={collapsed ? '展开侧边导航栏' : '收起侧边导航栏'}
        >
          <Icon name="sidebarToggle" size={15} />
        </button>
      </div>

      {/* 2. 展开态快捷股池摘要与复制计划 */}
      {!collapsed && (
        <div className="sr-quick-strip">
          <button
            type="button"
            className="sr-quick-stat"
            onClick={() => onTabChange('/trade')}
            title="直达今日作战台"
          >
            <span>持仓 <b className="num-mono">{holdingCount}</b></span>
            <span className="sr-dot-sep" aria-hidden="true" />
            <span>自选 <b className="num-mono">{watchCount}</b></span>
          </button>
          {onCopyPlan && (
            <button
              type="button"
              className="sr-quick-act"
              onClick={onCopyPlan}
              title="一键复制今日做T作战计划"
              aria-label="复制今日作战计划"
            >
              <Icon name="copy" size={13} />
              <span>计划</span>
            </button>
          )}
        </div>
      )}

      {/* 3. 分组主导航 */}
      <nav className="sr-nav" aria-label="业务模块导航">
        {!collapsed && <div className="sr-grp-title">实战盯盘</div>}
        <div className="sr-grp-list">{coreRoutes.map(renderNavItem)}</div>

        <div className="sr-grp-divider" role="separator" />

        {!collapsed && <div className="sr-grp-title">资产与复盘</div>}
        <div className="sr-grp-list">{reviewRoutes.map(renderNavItem)}</div>
      </nav>

      {/* 4. 左下常驻四大指数实时盯盘面板（对标量化终端参考图） */}
      {!collapsed && (
        <div
          className="sr-idx-panel"
          role="region"
          aria-label="四大指数实时行情"
          onClick={() => onTabChange('/board')}
          title="点击打开市场看板查看全市场广度与连板梯队"
        >
          <div className="sr-idx-hd">
            <span className="sr-idx-title">
              <span className="sr-live-dot" aria-hidden="true" />
              实时行情
            </span>
            <span className="sr-idx-phase">{clockPhase || '盘口同步'}</span>
          </div>
          <div className="sr-idx-grid">
            {CORE_INDICES.map(({ tc, label }) => {
              const q = idxQuotes[tc];
              const px = q?.price > 0 ? q.price : null;
              const chg =
                px && q?.prevClose > 0 ? ((px - q.prevClose) / q.prevClose) * 100 : null;
              const dirCls = chg == null ? '' : chg > 0.001 ? 'is-up' : chg < -0.001 ? 'is-down' : '';
              return (
                <div key={tc} className="sr-idx-cell">
                  <div className="sr-idx-row1">
                    <span className="sr-idx-name">{label}</span>
                    <span className={`sr-idx-chg num-mono ${dirCls}`}>
                      {chg == null ? '--' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}
                    </span>
                  </div>
                  <div className={`sr-idx-px num-mono ${dirCls}`}>
                    {px ? px.toFixed(2) : '----.--'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 5. 底部主题切换与云金库账号栏 */}
      <div className="sr-foot">
        <button
          type="button"
          className="sr-foot-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换为清爽日间浅色模式' : '切换为黑曜石暗色量化终端'}
          aria-label={theme === 'dark' ? '切换为日间浅色模式' : '切换为暗黑终端模式'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          {!collapsed && <span>{theme === 'dark' ? '日间' : '暗色'}</span>}
        </button>

        {currentUser && onOpenAccountModal && (
          <button
            type="button"
            className="sr-foot-btn sr-user-btn"
            onClick={onOpenAccountModal}
            title={`当前金库账号：${currentUser.displayName || currentUser.username}`}
            aria-label={`账号管理：${currentUser.displayName || currentUser.username}`}
          >
            <Icon name="user" size={15} />
            {!collapsed && (
              <span className="sr-user-lbl">{currentUser.displayName || currentUser.username}</span>
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
