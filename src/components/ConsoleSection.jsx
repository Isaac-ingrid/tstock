import React, { useState, useMemo, useEffect } from 'react';
import StockCard from './StockCard.jsx';
import BattleCardGrid from './BattleCardGrid.jsx';
import PositionRiskBar, {
  POS_RULES_KEY,
  loadPosRules,
  getAllowedPosCap,
} from './PositionRiskBar.jsx';
import { posCalc } from '../services/api.js';
import { money } from '../services/utils.js';

export default function ConsoleSection({
  pool = [],
  sentiment = null,
  activeStockCode,
  totalAssets = 100000,
  tradeLogs = [],
  isTailAlertTime = false,
  simTailAlert = false,
  onSelectStock,
  onUpdateStock,
  onBuyStock,
  onRemoveStock,
  onAddBlank,
  onSaveLocal,
  onResetDefault,
  onRefresh,
  onOpenQuickT,
  onOpenReason,
  onRefreshSingle,
  onCopySinglePlan,
  onJumpDiagnosis,
  onJumpIgnition,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const [groupTab, setGroupTab] = useState('all'); // 'all' | 'holding' | 'watch'
  const [tierFilter, setTierFilter] = useState('all'); // 'all' | 'long' | 'short'
  const [expandedCode, setExpandedCode] = useState(''); // 点击卡片才展开对应完整做T详情面板
  const [expandAll, setExpandAll] = useState(false);
  const [posRules, setPosRules] = useState(() => loadPosRules());

  const handleUpdatePosRules = (next) => {
    setPosRules(next);
    try {
      localStorage.setItem(POS_RULES_KEY, JSON.stringify(next));
    } catch (_) {}
  };

  // 当外部（如 TopNav 胶囊、起爆/连板跳转）明确选中某只标的时，同步展开其详情面板
  useEffect(() => {
    if (activeStockCode && pool.some((s) => String(s.code).padStart(6, '0') === String(activeStockCode).padStart(6, '0'))) {
      // 仅在已展开状态或外部显式切换时更新，保持首屏默认收起更清爽
      if (expandedCode) {
        setExpandedCode(String(activeStockCode).padStart(6, '0'));
      }
    }
  }, [activeStockCode, pool]);

  // 资金隔离测算 (70% 底仓做T池 vs 30% 超短打板机动池)
  const totalAssetsNum = +totalAssets || 100000;
  const baseCapital = totalAssetsNum * 0.7;
  const tacticalCapital = totalAssetsNum * 0.3;

  const baseStocks = useMemo(() => pool.filter((s) => s.tier === 'long' || s.poolTag === '稳健'), [pool]);
  const tacticalStocks = useMemo(() => pool.filter((s) => s.tier === 'short' || s.poolTag === '短线'), [pool]);
  const baseMktVal = useMemo(() => baseStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0), [baseStocks]);
  const tacticalMktVal = useMemo(() => tacticalStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0), [tacticalStocks]);
  const totalMktVal = baseMktVal + tacticalMktVal;
  const { capPct: allowedCapPct } = getAllowedPosCap(sentiment, posRules);
  const baseCash = Math.max(0, baseCapital - baseMktVal);
  const tacticalCash = Math.max(0, tacticalCapital - tacticalMktVal);

  // 按「实盘持仓」vs「自选观察」分组
  const { holdingList, watchList, holdingMkt, holdingPL } = useMemo(() => {
    const h = [];
    const w = [];
    let mkt = 0;
    let pl = 0;
    pool.forEach((s) => {
      const t = s.tier === 'short' || s.tier === 'long' ? s.tier : s.poolTag === '稳健' ? 'long' : 'short';
      if (tierFilter !== 'all' && t !== tierFilter) return;
      const p = posCalc(s);
      if (p.hasPos) {
        h.push(s);
        mkt += p.curMkt;
        pl += p.floatPL;
      } else {
        w.push(s);
      }
    });
    return { holdingList: h, watchList: w, holdingMkt: mkt, holdingPL: pl };
  }, [pool, tierFilter]);

  const allFiltered = useMemo(() => [...holdingList, ...watchList], [holdingList, watchList]);

  const handleToggleExpand = (code6) => {
    setExpandAll(false);
    setExpandedCode((prev) => {
      const next = prev === code6 ? '' : code6;
      if (next && onSelectStock) {
        onSelectStock(next);
      }
      if (next) {
        setTimeout(() => {
          const el = document.getElementById(`detailDrawer_${next}`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 80);
      }
      return next;
    });
  };

  const expandedStock = useMemo(() => {
    if (!expandedCode) return null;
    return pool.find((s) => String(s.code).padStart(6, '0') === expandedCode) || null;
  }, [pool, expandedCode]);

  return (
    <section id="secPlan" className="console-v2">
      {/* 标题与分组统计 */}
      <div className="console-head">
        <div>
          <h2 style={{ margin: 0 }}>二、今日作战台（实盘持仓 · 自选买卖点）</h2>
          <p className="console-sub">
            卡片一眼看清当前是否是<b>买点 / 卖点</b>，点击任意卡片再展开完整 K 线、分时与挂单面板
          </p>
        </div>

        <div className="console-head-actions">
          <button type="button" className="primary" onClick={() => onRefresh(false)}>↻ 重新计算</button>
          <button type="button" onClick={onAddBlank}>＋ 新增标的</button>
          <button type="button" onClick={onSaveLocal}>保存参数</button>
          <button type="button" onClick={onResetDefault}>恢复默认</button>
        </div>
      </div>

      {/* 精简版资金隔离条（1 行紧凑展示，点击即可过滤稳健/短线，不再占据半屏） */}
      <div className="funding-strip">
        <div
          className={`fund-pill long ${tierFilter === 'long' ? 'active' : ''}`}
          onClick={() => setTierFilter((f) => (f === 'long' ? 'all' : 'long'))}
          title="点击仅看底仓做T区标的（再次点击恢复全部）"
        >
          <span className="fp-title">🛡️ 底仓做T池 (70%)</span>
          <span className="fp-meta">
            {baseStocks.length}只 · 已用 <b>¥{money(baseMktVal)}</b> · 备用金 <b>¥{money(baseCash)}</b>
          </span>
        </div>

        <div
          className={`fund-pill short ${tierFilter === 'short' ? 'active' : ''}`}
          onClick={() => setTierFilter((f) => (f === 'short' ? 'all' : 'short'))}
          title="点击仅看短线机动区标的（再次点击恢复全部）"
        >
          <span className="fp-title">⚡ 短线机动池 (30%)</span>
          <span className="fp-meta">
            {tacticalStocks.length}只 · 持仓 <b>¥{money(tacticalMktVal)}</b> · 可用 <b>¥{money(tacticalCash)}</b>
          </span>
        </div>

        {holdingList.length > 0 && (
          <div className="fund-pill pnl">
            <span className="fp-title">📦 持仓总盈亏</span>
            <span className={`fp-meta ${holdingPL >= 0 ? 'up' : 'down'}`}>
              市值 <b>¥{money(holdingMkt)}</b> · 浮盈 <b>{holdingPL >= 0 ? '+' : ''}¥{money(holdingPL)}</b>
            </span>
          </div>
        )}
      </div>

      {/* ⚖️ 动态仓位风控条（情绪总阀联动总仓上限 + 单票集中度红线） */}
      <PositionRiskBar
        pool={pool}
        totalAssets={totalAssetsNum}
        sentiment={sentiment}
        posRules={posRules}
        onUpdateRules={handleUpdatePosRules}
        onSelectStock={handleToggleExpand}
      />

      {/* 分组切换栏：全部 / 实盘持仓 / 自选观察 + 周期过滤 + 展开全部 */}
      <div className="battle-toolbar">
        <div className="bt-tabs">
          <button
            type="button"
            className={`bt-tab ${groupTab === 'all' ? 'active' : ''}`}
            onClick={() => setGroupTab('all')}
          >
            全部作战 <span>{allFiltered.length}</span>
          </button>
          <button
            type="button"
            className={`bt-tab ${groupTab === 'holding' ? 'active' : ''}`}
            onClick={() => setGroupTab('holding')}
          >
            📦 实盘持仓 <span>{holdingList.length}</span>
          </button>
          <button
            type="button"
            className={`bt-tab ${groupTab === 'watch' ? 'active' : ''}`}
            onClick={() => setGroupTab('watch')}
          >
            👀 自选观察 <span>{watchList.length}</span>
          </button>
        </div>

        <div className="bt-right">
          <span className="tier-bar" style={{ marginLeft: 0 }}>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'all' ? 'cur' : ''}`}
              onClick={() => setTierFilter('all')}
            >
              全部周期
            </button>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'long' ? 'cur' : ''}`}
              onClick={() => setTierFilter('long')}
            >
              🛡️ 稳健 <b>{baseStocks.length}</b>
            </button>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'short' ? 'cur' : ''}`}
              onClick={() => setTierFilter('short')}
            >
              ⚡ 短线 <b>{tacticalStocks.length}</b>
            </button>
          </span>

          {allFiltered.length > 0 && (
            <button
              type="button"
              className="mini"
              style={{ marginLeft: 0 }}
              onClick={() => {
                setExpandAll((v) => !v);
                if (!expandAll) setExpandedCode('');
              }}
            >
              {expandAll ? '收起全部详情' : '全部展开'}
            </button>
          )}
        </div>
      </div>

      {/* ===== 分组视图 1：实盘持仓卡片区 ===== */}
      {(groupTab === 'all' || groupTab === 'holding') && (
        <div className="battle-group">
          {groupTab === 'all' && (
            <div className="bg-header">
              <div className="bg-title">
                <span>📦 实盘持仓（{holdingList.length} 只）</span>
                <span className="bg-desc">优先盯卖点、倒T高抛与止损风控</span>
              </div>
            </div>
          )}
          <BattleCardGrid
            stocks={holdingList}
            tradeLogs={tradeLogs}
            totalAssets={totalAssetsNum}
            posRules={posRules}
            totalMktVal={totalMktVal}
            allowedCapPct={allowedCapPct}
            expandedCode={expandAll ? '' : expandedCode}
            onToggleExpand={handleToggleExpand}
            onUpdateStock={onUpdateStock}
            onOpenQuickT={onOpenQuickT}
            onJumpDiagnosis={onJumpDiagnosis}
            onJumpIgnition={onJumpIgnition}
            emptyTitle="暂无实盘持仓"
            emptyHint="在自选观察卡片中点击「＋ 建仓」录入持仓股数与成本，标的会自动归入实盘持仓区。"
          />
        </div>
      )}

      {/* ===== 分组视图 2：自选观察卡片区 ===== */}
      {(groupTab === 'all' || groupTab === 'watch') && (
        <div className="battle-group">
          {groupTab === 'all' && (
            <div className="bg-header">
              <div className="bg-title">
                <span>👀 自选观察（{watchList.length} 只）</span>
                <span className="bg-desc">一眼核对当前是否是买点，不到低吸位坚决观望</span>
              </div>
            </div>
          )}
          <BattleCardGrid
            stocks={watchList}
            tradeLogs={tradeLogs}
            totalAssets={totalAssetsNum}
            posRules={posRules}
            totalMktVal={totalMktVal}
            allowedCapPct={allowedCapPct}
            expandedCode={expandAll ? '' : expandedCode}
            onToggleExpand={handleToggleExpand}
            onUpdateStock={onUpdateStock}
            onOpenQuickT={onOpenQuickT}
            onJumpDiagnosis={onJumpDiagnosis}
            onJumpIgnition={onJumpIgnition}
            emptyTitle="自选观察池为空"
            emptyHint="在上方输入 6 位代码或股票名称添加，或从起爆挖掘 / 连板天梯一键加入观察。"
          />
        </div>
      )}

      {/* ===== 点击卡片后展开的完整做T执行面板 ===== */}
      {!expandAll && expandedStock && (
        <div id={`detailDrawer_${String(expandedStock.code).padStart(6, '0')}`} className="battle-detail-drawer">
          <div className="bdd-bar">
            <div className="bdd-title">
              <span>📋 完整作战面板：</span>
              <b>{expandedStock.name}</b>
              <span className="bdd-code">{String(expandedStock.code).padStart(6, '0')}</span>
            </div>
            <div className="bdd-acts">
              <button
                type="button"
                className="mini"
                onClick={() => onJumpDiagnosis && onJumpDiagnosis(expandedStock.code)}
              >
                🩺 全景诊股
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => onJumpIgnition && onJumpIgnition(expandedStock.code)}
              >
                🚀 起爆体检
              </button>
              <button
                type="button"
                className="mini primary"
                onClick={() => setExpandedCode('')}
              >
                ✕ 收起详情
              </button>
            </div>
          </div>

          <div id="pool" data-view="all">
            <StockCard
              key={expandedStock.code}
              stock={expandedStock}
              index={pool.indexOf(expandedStock)}
              isCur={true}
              tradeLogs={tradeLogs}
              isTailAlertTime={isTailAlertTime}
              simTailAlert={simTailAlert}
              onUpdateStock={onUpdateStock}
              onBuyStock={onBuyStock}
              onRemoveStock={onRemoveStock}
              onOpenQuickT={onOpenQuickT}
              onOpenReason={onOpenReason}
              onRefreshSingle={onRefreshSingle}
              onCopySinglePlan={onCopySinglePlan}
              fastRefresh={fastRefresh}
              onToggleFastRefresh={onToggleFastRefresh}
            />
          </div>
        </div>
      )}

      {/* 全部展开模式 */}
      {expandAll && allFiltered.length > 0 && (
        <div id="pool" data-view="all" style={{ marginTop: '16px' }}>
          {allFiltered.map((s) => (
            <StockCard
              key={s.code}
              stock={s}
              index={pool.indexOf(s)}
              isCur={true}
              tradeLogs={tradeLogs}
              isTailAlertTime={isTailAlertTime}
              simTailAlert={simTailAlert}
              onUpdateStock={onUpdateStock}
              onBuyStock={onBuyStock}
              onRemoveStock={onRemoveStock}
              onOpenQuickT={onOpenQuickT}
              onOpenReason={onOpenReason}
              onRefreshSingle={onRefreshSingle}
              onCopySinglePlan={onCopySinglePlan}
              fastRefresh={fastRefresh}
              onToggleFastRefresh={onToggleFastRefresh}
            />
          ))}
        </div>
      )}
    </section>
  );
}
