import React from 'react';
import { f2, pct, money } from '../services/utils.js';

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
  return (
    <div className="topbar" id="topbar">
      <div className="tb-nav" id="topNav">
        <a
          href="#secPlan"
          className={activeTab === 'tabConsole' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabConsole'); }}
        >
          今日作战{pool.length > 0 ? <span className="tb-badge">{pool.length}</span> : null}
        </a>
        <a
          href="#secTailBuy"
          className={activeTab === 'tabTail' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabTail'); }}
        >
          ⚡ 尾盘黑马{tailCount > 0 ? <span className="tb-badge">{tailCount}</span> : null}
        </a>
        <a
          href="#accSec"
          className={activeTab === 'tabAccount' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabAccount'); }}
        >
          账户
        </a>
        <a
          href="#secLog"
          className={activeTab === 'tabLedger' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabLedger'); }}
        >
          台账{ledgerCount > 0 ? <span className="tb-badge">{ledgerCount}</span> : null}
        </a>
        <a
          href="#secPerf"
          className={activeTab === 'tabPerf' ? 'active' : ''}
          style={{ color: 'var(--accent)', fontWeight: 700 }}
          onClick={(e) => { e.preventDefault(); onTabChange('tabPerf'); }}
        >
          📊 战绩透视
        </a>
        <a
          href="#secRule"
          className={activeTab === 'tabRules' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabRules'); }}
        >
          纪律
        </a>
        <a
          href="#secAll"
          className={activeTab === 'tabAll' ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); onTabChange('tabAll'); }}
        >
          🌐 全览
        </a>
      </div>

      <span className="tb-sep"></span>

      {/* 常驻账户资产胶囊 */}
      <div
        className="tb-acc-pill"
        id="tbAccPill"
        title="点击跳转至账户总览与资金详情"
        onClick={() => onTabChange('tabAccount')}
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

      <span className="tb-stamp" title="数据时间：最近一次成功取到行情的时间">
        {quoteStamp || '—'}
      </span>
      {isStale && <span className="tb-stale-tag" style={{ display: 'inline-block' }}>数据已过期</span>}

      {/* 分时时钟胶囊 */}
      <div
        className="tb-clock-pill"
        title="点击查看 A股日内分时作战法则与当前时段操作禁忌"
        onClick={onOpenClock}
        style={{ cursor: 'pointer' }}
      >
        <span className="dot-live pulse-green"></span>
        <span>{clockPhase}</span>
      </div>

      {/* 快捷现价展示 */}
      <div className="tb-px">
        {pool.length > 0 ? (
          <div style={{ display: 'inline-flex', gap: '6px' }}>
            {pool.slice(0, 3).map(s => {
              const chg = s.prevClose > 0 ? ((s.price - s.prevClose) / s.prevClose) * 100 : 0;
              return (
                <span
                  key={s.code}
                  className="tb-px-item"
                  title={`${s.name} 点击跳转`}
                  onClick={() => onTabChange('tabConsole')}
                >
                  <span className="tb-name">{s.name}</span>
                  <b className={chg >= 0 ? 'up' : 'down'}>{f2(s.price)} ({pct(chg)})</b>
                </span>
              );
            })}
          </div>
        ) : (
          <span style={{ color: 'var(--mute)' }}>载入中…</span>
        )}
      </div>

      {/* 操作按钮区 */}
      <div className="tb-act">
        <button onClick={onCopyPlan} title="复制今日作战计划（纯文本，可直接粘贴到微信）">📋 作战计划</button>
        <button onClick={onExport} title="把自选池 / 台账 / 快照 / 红线 / 体检全部导出为 JSON 备份">⬇ 导出</button>
        <button onClick={onImportClick} title="从之前导出的 JSON 恢复数据">⬆ 导入</button>
        <button onClick={onToggleNotify} title="开启桌面通知：价格触及买点 / 卖点时由系统通知你">
          {notifyActive ? '🔔 已开启' : '🔔 提醒'}
        </button>
        <button onClick={onRefresh} title="强制全量刷新实时行情与K线">⟳ 刷新</button>
      </div>
    </div>
  );
}
