import React, { useState, useMemo, useEffect } from 'react';
import StockCard from './StockCard.jsx';
import BattleCardGrid from './BattleCardGrid.jsx';
import PositionRiskBar, {
  loadPosRules,
  savePosRules,
  getAllowedPosCap,
} from './PositionRiskBar.jsx';
import { posCalc, fetchQuotes, tcodeFromCode } from '../services/api.js';
import { f2, money, todayStr, toastOk } from '../services/utils.js';
import { getUpcomingHolidayReminder, syncRemoteTradeCalendar } from '../services/calendar.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';

const RECLAIM_POOL_KEY = 't-reclaim-watch-v1';

export default function ConsoleSection({
  pool = [],
  tailActives = [],
  sentiment = null,
  noticeRisks = {},
  posRules: externalPosRules = null,
  tiltState = null,
  onUpdatePosRules,
  onUnlockTilt,
  onRelockTilt,
  activeStockCode,
  totalAssets = 100000,
  cash = 0,
  initialCapital = 100000,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
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
  const [internalPosRules, setInternalPosRules] = useState(() => loadPosRules());
  const [calTick, setCalTick] = useState(0);
  const [reclaimList, setReclaimList] = useState(() => {
    try {
      const raw = localStorage.getItem(RECLAIM_POOL_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [reclaimQuotes, setReclaimQuotes] = useState({});

  const persistReclaim = (nextList) => {
    setReclaimList(nextList);
    try {
      localStorage.setItem(RECLAIM_POOL_KEY, JSON.stringify(nextList));
    } catch (_) {}
  };

  const handleMoveToReclaim = (stock, calcObj) => {
    const code6 = String(stock.code || '').padStart(6, '0');
    const reclaimPx = Number(
      Math.max(
        calcObj?.slA || 0,
        calcObj?.bollInfo?.mid || 0,
        (+stock.price || 0) * 1.015
      ).toFixed(2)
    );
    const entry = {
      code: code6,
      name: stock.name || code6,
      stopPx: Number((calcObj?.slA || stock.price || 0).toFixed(2)),
      reclaimPx,
      exitDate: todayStr(),
    };
    const next = [entry, ...reclaimList.filter((x) => x.code !== code6)].slice(0, 20);
    persistReclaim(next);
    if (onRemoveStock) {
      onRemoveStock(stock.code);
    }
    toastOk(`👁️ 已将 ${entry.name} 移入「破位收复观察池」，待重新站稳 ¥${f2(reclaimPx)} 自动亮灯提醒`);
  };

  const handleRestoreFromReclaim = (item) => {
    if (onUpdateStock && pool.some((s) => String(s.code).padStart(6, '0') === item.code)) {
      persistReclaim(reclaimList.filter((x) => x.code !== item.code));
      if (onSelectStock) onSelectStock(item.code);
      return;
    }
    persistReclaim(reclaimList.filter((x) => x.code !== item.code));
    toastOk(`✅ ${item.name} (${item.code}) 已重新站稳关键位 ¥${f2(item.reclaimPx)}，请在上方输入代码纳回自选池观察`);
  };

  useEffect(() => {
    if (!reclaimList.length) return;
    let alive = true;
    const syncQuotes = async () => {
      try {
        const tcs = reclaimList.map((x) => tcodeFromCode(x.code)).filter(Boolean);
        const qMap = await fetchQuotes(tcs);
        if (alive && qMap) setReclaimQuotes(qMap);
      } catch (_) {}
    };
    syncQuotes();
    const timer = setInterval(syncQuotes, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reclaimList]);

  useEffect(() => {
    let mounted = true;
    syncRemoteTradeCalendar().then(() => {
      if (mounted) setCalTick((t) => t + 1);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const posRules = externalPosRules || internalPosRules;
  const holidayReminder = useMemo(() => getUpcomingHolidayReminder(new Date()), [calTick]);

  const handleUpdatePosRules = (next) => {
    if (onUpdatePosRules) {
      onUpdatePosRules(next);
    } else {
      setInternalPosRules(next);
      savePosRules(next);
    }
  };

  // 当外部（如 TopNav 胶囊、起爆/连板/战绩/账户/台账跳转）明确选中某只标的时，确保其不被当前分组过滤隐藏并同步展开面板
  useEffect(() => {
    if (!activeStockCode) return;
    const code6 = String(activeStockCode).padStart(6, '0');
    const matched = pool.find((s) => String(s.code).padStart(6, '0') === code6);
    if (!matched) return;
    const hasPos = posCalc(matched).hasPos;
    if ((groupTab === 'holding' && !hasPos) || (groupTab === 'watch' && hasPos)) {
      setGroupTab('all');
    }
    const t = matched.tier === 'short' || matched.tier === 'long' ? matched.tier : matched.poolTag === '稳健' ? 'long' : 'short';
    if (tierFilter !== 'all' && tierFilter !== t) {
      setTierFilter('all');
    }
    if (expandedCode) {
      setExpandedCode(code6);
    }
  }, [activeStockCode, pool]);

  // 资金隔离测算 (70% 底仓做T池 vs 30% 超短打板/尾盘机动池)
  const totalAssetsNum = +totalAssets || 100000;
  const baseCapital = totalAssetsNum * 0.7;
  const tacticalCapital = totalAssetsNum * 0.3;

  const resolveStockTier = (s) => (s?.tier === 'short' || s?.tier === 'long' ? s.tier : s?.poolTag === '稳健' ? 'long' : 'short');
  const baseStocks = useMemo(() => pool.filter((s) => resolveStockTier(s) === 'long'), [pool]);
  const tacticalStocks = useMemo(() => pool.filter((s) => resolveStockTier(s) === 'short'), [pool]);
  const baseMktVal = useMemo(() => baseStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0), [baseStocks]);
  const shortPoolMktVal = useMemo(() => tacticalStocks.reduce((acc, s) => acc + (s.shares || 0) * (s.price || s.cost || 0), 0), [tacticalStocks]);
  const tailMktVal = useMemo(
    () => (tailActives || []).reduce((acc, t) => acc + (t.status === 'closed' ? 0 : (t.shares || 0) * (t.price || t.cost || 0)), 0),
    [tailActives]
  );
  const tacticalMktVal = shortPoolMktVal + tailMktVal;
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
    const next = expandedCode === code6 ? '' : code6;
    setExpandAll(false);
    setExpandedCode(next);
    if (next && onSelectStock) {
      onSelectStock(next);
    }
    if (next) {
      setTimeout(() => {
        const el = document.getElementById(`detailDrawer_${next}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 80);
    }
  };

  const expandedStock = useMemo(() => {
    if (!expandedCode) return null;
    return pool.find((s) => String(s.code).padStart(6, '0') === expandedCode) || null;
  }, [pool, expandedCode]);

  return (
    <section id="secPlan" className="console-v2">
      {/* 顶排 4 格等高资金隔离 Bento 指标卡（总资产/现金直输 + 70%底仓/30%机动一键筛选 + 实时总浮盈） */}
      <div className="funding-strip">
        <div className="fund-pill asset-edit" title="点击数字即可直接输入账户总资产或可用现金">
          <span className="fp-title"><i className="fp-dot is-neutral" />账户总账</span>
          <span className="fp-meta num-mono" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
            <span>
              总资产{' '}
              {onUpdateTotalAssets ? (
                <DirectMoneyInput
                  value={totalAssetsNum}
                  onCommit={onUpdateTotalAssets}
                  min={0}
                  allowZero={true}
                  size="sm"
                  ariaLabel="作战台总资产输入"
                  title="点击直接输入账户总资产（支持如 200000 或 20w，回车保存）"
                />
              ) : (
                <b>¥{money(totalAssetsNum)}</b>
              )}
            </span>
            <span>
              现金{' '}
              {onUpdateCash ? (
                <DirectMoneyInput
                  value={cash}
                  onCommit={onUpdateCash}
                  min={0}
                  allowZero={true}
                  size="sm"
                  tone="cash"
                  ariaLabel="作战台可用现金输入"
                  title="点击直接输入可用现金（回车或失焦自动保存）"
                />
              ) : (
                <b>¥{money(cash)}</b>
              )}
            </span>
          </span>
        </div>

        <div
          className={`fund-pill long ${tierFilter === 'long' ? 'active' : ''}`}
          onClick={() => setTierFilter((f) => (f === 'long' ? 'all' : 'long'))}
          title="点击仅看底仓做T区标的（再次点击恢复全部）"
        >
          <span className="fp-title"><i className="fp-dot is-info" />底仓做T池 (70%)</span>
          <span className="fp-meta num-mono">
            {baseStocks.length}只 · 已用 <b>¥{money(baseMktVal)}</b> · 备用 <b>¥{money(baseCash)}</b>
          </span>
        </div>

        <div
          className={`fund-pill short ${tierFilter === 'short' ? 'active' : ''}`}
          onClick={() => setTierFilter((f) => (f === 'short' ? 'all' : 'short'))}
          title="点击仅看短线机动区标的（再次点击恢复全部）"
        >
          <span className="fp-title"><i className="fp-dot is-warn" />短线机动池 (30%)</span>
          <span className="fp-meta num-mono">
            {tacticalStocks.length}只{tailMktVal > 0 ? '+尾盘' : ''} · 持仓 <b>¥{money(tacticalMktVal)}</b> · 可用 <b>¥{money(tacticalCash)}</b>
          </span>
        </div>

        <div className="fund-pill pnl">
          <span className="fp-title"><i className="fp-dot is-accent" />持仓总盈亏</span>
          <span className={`fp-meta num-mono ${holdingPL >= 0 ? 'up' : 'down'}`}>
            市值 <b>¥{money(holdingMkt)}</b> · 浮盈 <b>{holdingPL >= 0 ? '+' : ''}¥{money(holdingPL)}</b>
          </span>
        </div>
      </div>

      {/* ⚖️ 动态仓位风控条 & 单日防上头熔断锁 */}
      <PositionRiskBar
        pool={pool}
        tailActives={tailActives}
        totalAssets={totalAssetsNum}
        cash={cash}
        initialCapital={initialCapital}
        onUpdateTotalAssets={onUpdateTotalAssets}
        onUpdateCash={onUpdateCash}
        onUpdateInitialCapital={onUpdateInitialCapital}
        sentiment={sentiment}
        posRules={posRules}
        tiltState={tiltState}
        onUpdateRules={handleUpdatePosRules}
        onUnlockTilt={onUnlockTilt}
        onRelockTilt={onRelockTilt}
        onSelectStock={handleToggleExpand}
      />

      {/* 单行紧凑作战控制栏：分组 Tab + 分层筛选 + 股池维护动作 */}
      <div className="battle-toolbar">
        <div className="bt-left-cluster">
          <div className="bt-tabs">
            <button
              type="button"
              className={`bt-tab ${groupTab === 'all' ? 'active' : ''}`}
              onClick={() => setGroupTab('all')}
            >
              全部 <span className="num-mono">{allFiltered.length}</span>
            </button>
            <button
              type="button"
              className={`bt-tab ${groupTab === 'holding' ? 'active' : ''}`}
              onClick={() => setGroupTab('holding')}
            >
              实盘持仓 <span className="num-mono">{holdingList.length}</span>
            </button>
            <button
              type="button"
              className={`bt-tab ${groupTab === 'watch' ? 'active' : ''}`}
              onClick={() => setGroupTab('watch')}
            >
              自选观察 <span className="num-mono">{watchList.length}</span>
            </button>
          </div>

          <span className="tier-bar" style={{ marginLeft: 0 }}>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'all' ? 'cur' : ''}`}
              onClick={() => setTierFilter('all')}
            >
              全池
            </button>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'long' ? 'cur' : ''}`}
              onClick={() => setTierFilter('long')}
            >
              底仓 <b className="num-mono">{baseStocks.length}</b>
            </button>
            <button
              type="button"
              className={`tier-btn ${tierFilter === 'short' ? 'cur' : ''}`}
              onClick={() => setTierFilter('short')}
            >
              短线 <b className="num-mono">{tacticalStocks.length}</b>
            </button>
          </span>
        </div>

        <div className="bt-right">
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
              {expandAll ? '收起详情' : '全部展开'}
            </button>
          )}
          <button type="button" className="mini" style={{ marginLeft: 0 }} onClick={onAddBlank}>＋ 新增标的</button>
          <button type="button" className="mini" style={{ marginLeft: 0 }} onClick={onSaveLocal}>保存参数</button>
          <button type="button" className="mini" style={{ marginLeft: 0 }} onClick={onResetDefault}>恢复默认</button>
          <button type="button" className="mini primary" style={{ marginLeft: 0 }} onClick={() => onRefresh(false)}>↻ 重算</button>
        </div>
      </div>

      {/* ===== 分组视图 1：实盘持仓卡片区 ===== */}
      {(groupTab === 'all' || groupTab === 'holding') && (
        <div className="battle-group">
          {groupTab === 'all' && (
            <div className="bg-header">
              <div className="bg-title">
                <span>实盘持仓（{holdingList.length} 只）</span>
                <span className="bg-desc">优先盯卖点、倒T高抛与止损风控</span>
              </div>
            </div>
          )}
          <BattleCardGrid
            stocks={holdingList}
            tradeLogs={tradeLogs}
            totalAssets={totalAssetsNum}
            sentiment={sentiment}
            noticeRisks={noticeRisks}
            posRules={posRules}
            tiltState={tiltState}
            totalMktVal={totalMktVal}
            allowedCapPct={allowedCapPct}
            holidayReminder={holidayReminder}
            activeStockCode={activeStockCode}
            expandedCode={expandAll ? '' : expandedCode}
            onToggleExpand={handleToggleExpand}
            onUpdateStock={onUpdateStock}
            onOpenQuickT={onOpenQuickT}
            onJumpDiagnosis={onJumpDiagnosis}
            onJumpIgnition={onJumpIgnition}
            onMoveToReclaim={handleMoveToReclaim}
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
                <span>自选观察（{watchList.length} 只）</span>
                <span className="bg-desc">一眼核对当前是否是买点，不到低吸位坚决观望</span>
              </div>
            </div>
          )}
          <BattleCardGrid
            stocks={watchList}
            tradeLogs={tradeLogs}
            totalAssets={totalAssetsNum}
            sentiment={sentiment}
            noticeRisks={noticeRisks}
            posRules={posRules}
            tiltState={tiltState}
            totalMktVal={totalMktVal}
            allowedCapPct={allowedCapPct}
            holidayReminder={holidayReminder}
            activeStockCode={activeStockCode}
            expandedCode={expandAll ? '' : expandedCode}
            onToggleExpand={handleToggleExpand}
            onUpdateStock={onUpdateStock}
            onOpenQuickT={onOpenQuickT}
            onJumpDiagnosis={onJumpDiagnosis}
            onJumpIgnition={onJumpIgnition}
            onMoveToReclaim={handleMoveToReclaim}
            emptyTitle="自选观察池为空"
            emptyHint="在上方输入 6 位代码或股票名称添加，或从起爆挖掘 / 连板天梯一键加入观察。"
          />
        </div>
      )}

      {/* ===== 第四步闭环：破位离场 · 关键位收复观察池（不死扛亏损，重站稳再纳回） ===== */}
      {reclaimList.length > 0 && (
        <div
          className="card"
          style={{
            marginTop: '10px',
            padding: '10px 14px',
            borderLeft: '3px solid var(--warn)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '12.5px' }}>
              <b>👁️ 破位离场 · 关键位收复观察池（{reclaimList.length} 只）</b>
              <span style={{ color: 'var(--sub)', marginLeft: '8px', fontSize: '11.5px' }}>
                跌破止损先隔离静默防情绪死扛；现价重新站稳关键位自动亮灯提醒
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {reclaimList.map((it) => {
              const poolMatch = pool.find((p) => String(p.code).padStart(6, '0') === it.code);
              const qObj = reclaimQuotes[tcodeFromCode(it.code)];
              const curPx = poolMatch?.price || qObj?.price || 0;
              const reclaimed = curPx > 0 && curPx >= it.reclaimPx;
              const diffPct = curPx > 0 && it.reclaimPx > 0 ? ((curPx - it.reclaimPx) / it.reclaimPx) * 100 : null;
              return (
                <div
                  key={it.code}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    borderRadius: '7px',
                    fontSize: '12px',
                    background: reclaimed ? 'var(--up-bg)' : 'var(--surface)',
                    border: `1px solid ${reclaimed ? 'var(--up-b)' : 'var(--line2)'}`,
                  }}
                >
                  <b>{it.name}</b>
                  <span className="num-mono" style={{ color: 'var(--mute)', fontSize: '11px' }}>{it.code}</span>
                  <span className="num-mono">
                    现价 <b>{curPx > 0 ? `¥${f2(curPx)}` : '—'}</b> / 关键收复位 <b>¥{f2(it.reclaimPx)}</b>
                    {diffPct != null && ` (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%)`}
                  </span>
                  {reclaimed ? (
                    <button
                      type="button"
                      className="mini primary"
                      style={{ marginLeft: 0, padding: '2px 8px', fontSize: '11px' }}
                      onClick={() => handleRestoreFromReclaim(it)}
                    >
                      🔔 已站稳·纳回观察
                    </button>
                  ) : (
                    <span style={{ fontSize: '11px', color: 'var(--mute)' }}>⏳ 未收复·按兵不动</span>
                  )}
                  <button
                    type="button"
                    className="mini"
                    style={{ marginLeft: 0, padding: '1px 6px', fontSize: '11px' }}
                    onClick={() => persistReclaim(reclaimList.filter((x) => x.code !== it.code))}
                    title="移出破位观察池"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
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
              totalAssets={totalAssetsNum}
              totalMktVal={totalMktVal}
              allowedCapPct={allowedCapPct}
              holidayReminder={holidayReminder}
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
              totalAssets={totalAssetsNum}
              totalMktVal={totalMktVal}
              allowedCapPct={allowedCapPct}
              holidayReminder={holidayReminder}
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
