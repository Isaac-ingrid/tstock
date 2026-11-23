import React, { useState, useMemo, useEffect } from 'react';
import { f2, money, todayStr, copyPlain, toastOk } from '../services/utils.js';

const STEP_DEFS = [
  { key: 'quotes', num: '01', title: '同步收盘行情', desc: '拉取持仓/尾盘最新收盘价与指数' },
  { key: 'audit', num: '02', title: '核查未平T与节前仓位', desc: '排查滞留T仓、隔夜仓与节前超限敞口' },
  { key: 'snapshot', num: '03', title: '归档今日净值快照', desc: '落盘总资产、仓位与单日涨跌' },
  { key: 'brief', num: '04', title: '生成量化复盘简报', desc: '纪律分、先导命中对照与明日锚点' },
  { key: 'vault', num: '05', title: '双写本地磁盘金库', desc: '同步 user_vault.json 与按日备份' },
];

function statusStyle(st) {
  if (st === 'done') return { bg: 'var(--down-bg)', border: 'var(--down-b)', color: 'var(--down-d)', icon: '✅' };
  if (st === 'warn') return { bg: 'var(--warn-bg)', border: 'var(--warn-b)', color: 'var(--warn-d)', icon: '⚠️' };
  if (st === 'running') return { bg: 'var(--info-bg)', border: 'var(--info-b)', color: 'var(--info-d)', icon: '⏳' };
  return { bg: 'var(--surface2)', border: 'var(--line)', color: 'var(--mute)', icon: '○' };
}

export default function PostMarketModal({
  open,
  onClose,
  eodArchives = [],
  isRunning = false,
  stepStates = {},
  livePositionCheck = null,
  onRunWorkflow,
  onOpenQuickT,
  onMarkOvernightT,
  onTabChange,
}) {
  const today = todayStr();
  const [selectedDate, setSelectedDate] = useState(today);

  useEffect(() => {
    if (open) {
      setSelectedDate(todayStr());
    }
  }, [open]);

  const todayArchive = useMemo(
    () => (eodArchives || []).find((a) => a && a.date === today) || null,
    [eodArchives, today]
  );

  const activeArchive = useMemo(() => {
    if (selectedDate === today && todayArchive) return todayArchive;
    return (eodArchives || []).find((a) => a && a.date === selectedDate) || todayArchive;
  }, [eodArchives, selectedDate, today, todayArchive]);

  if (!open) return null;

  const unclosedList = livePositionCheck?.unclosedTList || [];
  const overnightTails = livePositionCheck?.overnightTailList || [];
  const activeHolidayAudit =
    activeArchive?.holidayAudit || (selectedDate === today ? livePositionCheck?.holidayGuard : null);

  const handleDownloadMd = () => {
    if (!activeArchive?.briefMarkdown) return;
    const blob = new Blob([activeArchive.briefMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tstock-eod-${activeArchive.date}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toastOk(`✓ 已下载 ${activeArchive.date} 盘后归档简报 Markdown！`);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '860px', width: '94%' }}
      >
        {/* 顶部标题栏 */}
        <div
          className="modal-hd"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '20px' }}>🏁</span>
            <h3 style={{ margin: 0 }}>15:05 盘后一键收盘归档工作流</h3>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontWeight: 700,
                background: todayArchive ? 'var(--down-bg)' : 'var(--warn-bg)',
                color: todayArchive ? 'var(--down-d)' : 'var(--warn-d)',
                border: `1px solid ${todayArchive ? 'var(--down-b)' : 'var(--warn-b)'}`,
              }}
            >
              {todayArchive
                ? `✅ 今日已归档 (${todayArchive.archivedAt || '已完成'})`
                : '⏳ 今日待执行收盘归档'}
            </span>
          </div>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* 主体内容 */}
        <div
          className="modal-bd"
          style={{
            maxHeight: '76vh',
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {/* 操作与历史切换条 */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'var(--info-bg)',
              border: '1px solid var(--info-b)',
            }}
          >
            <div style={{ fontSize: '12.5px', color: 'var(--info-d)', lineHeight: 1.5 }}>
              <b>每日 15:05 标准收盘动作：</b>
              一键完成收盘价同步、未平T仓排查、账户净值曲线打点、今日纪律复盘与明日挂单预案生成，并自动双写至本地磁盘金库。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {eodArchives.length > 0 && (
                <select
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    fontSize: '12px',
                    borderRadius: '6px',
                    border: '1px solid var(--line2)',
                    background: 'var(--card)',
                    fontWeight: 600,
                  }}
                  title="切换查看历史收盘归档报告"
                >
                  {!todayArchive && <option value={today}>📅 {today} (今日待归档)</option>}
                  {eodArchives.map((item) => (
                    <option key={item.date} value={item.date}>
                      📚 {item.date} ({item.disciplineScore}分 · ¥{money(item.snapshot?.total || 0)})
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="primary"
                disabled={isRunning}
                onClick={onRunWorkflow}
                style={{
                  padding: '8px 18px',
                  fontSize: '13px',
                  fontWeight: 800,
                  borderRadius: '7px',
                  background: 'linear-gradient(135deg, #0f766e 0%, #1d4ed8 100%)',
                  border: 'none',
                  color: '#fff',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  boxShadow: '0 2px 8px rgba(29, 78, 216, 0.22)',
                }}
              >
                {isRunning
                  ? '⏳ 正在执行五步收盘归档…'
                  : todayArchive
                  ? '🔄 重新同步并刷新今日归档'
                  : '🚀 一键执行五步收盘归档'}
              </button>
            </div>
          </div>

          {/* 五步流水线进度卡 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
              gap: '8px',
            }}
          >
            {STEP_DEFS.map((s) => {
              const stObj = stepStates[s.key] || (todayArchive ? { status: 'done', note: '已归档' } : { status: 'idle', note: '待启动' });
              const sty = statusStyle(stObj.status);
              return (
                <div
                  key={s.key}
                  style={{
                    padding: '9px 10px',
                    borderRadius: '8px',
                    background: sty.bg,
                    border: `1px solid ${sty.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '3px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '10.5px', fontWeight: 800, color: sty.color, fontFamily: 'monospace' }}>
                      STEP {s.num}
                    </span>
                    <span style={{ fontSize: '13px' }}>{sty.icon}</span>
                  </div>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text)' }}>{s.title}</div>
                  <div style={{ fontSize: '11px', color: stObj.note ? sty.color : 'var(--mute)', lineHeight: 1.35 }}>
                    {stObj.note || s.desc}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 🚨 未平 T 仓滞留处置卡（若检测到当日买入做T未在收盘前卖出，提供一键补录或打标） */}
          {unclosedList.length > 0 && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: '9px',
                background: 'var(--up-bg)',
                border: '1.5px solid var(--up-b)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--up)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>🚨</span>
                <span>发现 {unclosedList.length} 只标的今日尚有未平做T仓！请确认实盘交割状态：</span>
              </div>
              {unclosedList.map((u) => (
                <div
                  key={u.code}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '8px',
                    padding: '7px 10px',
                    borderRadius: '6px',
                    background: 'var(--card)',
                    border: '1px solid var(--up-b)',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <b>{u.name} ({u.code})</b> · 滞留未平 <b>{u.unclosedShares} 股</b>（收盘价 ¥{f2(u.price)} / 成本 ¥{f2(u.cost)}）
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {onOpenQuickT && u.stock && (
                      <button
                        type="button"
                        className="mini"
                        onClick={() => {
                          onClose();
                          onOpenQuickT(u.stock, '直接卖出', f2(u.price), u.unclosedShares);
                        }}
                        style={{ background: 'var(--info-bg)', color: 'var(--info-d)', borderColor: 'var(--info-b)', fontWeight: 700 }}
                        title="若券商实盘其实已卖出只是漏记账，点击补录今日平仓卖单"
                      >
                        📝 补录今日已卖平仓
                      </button>
                    )}
                    {onMarkOvernightT && (
                      <button
                        type="button"
                        className="mini"
                        onClick={() => onMarkOvernightT(u)}
                        style={{ background: 'var(--warn-bg)', color: 'var(--warn-d)', borderColor: 'var(--warn-b)', fontWeight: 700 }}
                        title="确认实盘未卖出，自动标记『做T做反变加仓』失误标签并结转隔夜底仓"
                      >
                        🏷️ 确认未卖 · 记入「做T变加仓」
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 🟨 节前连续长假超上限持仓黄牌与节后首日/次日减仓纠偏卡 */}
          {activeHolidayAudit?.isYellowCard && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: '9px',
                background: 'var(--warn-bg)',
                border: '1.5px solid #f59e0b',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--warn-d)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span>🟨</span>
                  <span>{activeHolidayAudit.actionTitle || `节前长假超上限持仓黄牌预警（超上限 ${activeHolidayAudit.excessPct}%）`}</span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '1px 7px',
                      borderRadius: '999px',
                      background: 'var(--warn-bg)',
                      color: 'var(--warn-d)',
                      border: '1px solid var(--warn-b)',
                    }}
                  >
                    收盘总仓 {Number(activeHolidayAudit.totalPosPct || 0).toFixed(1)}% / 上限 ≤{activeHolidayAudit.effectiveCapPct}% · 待降约 ¥{money(activeHolidayAudit.excessAmt || 0)}
                  </span>
                </div>
                {onTabChange && (
                  <button
                    type="button"
                    className="mini"
                    style={{ marginLeft: 0, background: 'var(--card)', color: 'var(--warn-d)', borderColor: '#f59e0b', fontWeight: 700 }}
                    onClick={() => {
                      onClose();
                      onTabChange('/trade');
                    }}
                  >
                    🎯 去作战台查看减仓锚点 →
                  </button>
                )}
              </div>
              {activeHolidayAudit.actionSummary && (
                <div style={{ fontSize: '12px', color: 'var(--warn-d)', lineHeight: 1.55 }}>
                  {activeHolidayAudit.actionSummary}
                </div>
              )}
              {Array.isArray(activeHolidayAudit.reductionTargets) && activeHolidayAudit.reductionTargets.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {activeHolidayAudit.reductionTargets.map((rt) => (
                    <span
                      key={`${rt.isTail ? 'tail' : 'pool'}_${rt.code}`}
                      style={{
                        fontSize: '11.5px',
                        padding: '4px 9px',
                        borderRadius: '6px',
                        background: 'var(--card)',
                        border: '1px solid var(--warn-b)',
                        color: 'var(--warn-d)',
                      }}
                    >
                      <b>{rt.name}({rt.code})</b>：建议减 <b>{rt.trimShares}股</b>(≈¥{money(rt.trimAmt)}) · 锚点 <b>¥{f2(rt.refAnchor)}</b> / 防守 <b>¥{f2(rt.stopAnchor)}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ⚡ 尾盘黑马隔夜持仓次日必平提示 */}
          {overnightTails.length > 0 && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent-b)',
                fontSize: '12px',
                color: 'var(--accent-d)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <div>
                <b>⚡ 明日 09:30~10:00 尾盘隔夜仓必平提醒：</b>
                {overnightTails.map((t) => (
                  <span key={t.id} style={{ marginLeft: '8px' }}>
                    <b>{t.name}</b>({t.shares}股 · 成本¥{f2(t.cost)} → 止盈1 <b>¥{f2(t.tp1)}</b> / 止损 <b>¥{f2(t.stop)}</b>)
                  </span>
                ))}
              </div>
              {onTabChange && (
                <button
                  type="button"
                  className="mini"
                  style={{ marginLeft: 0, background: 'var(--card)', color: 'var(--accent-d)', borderColor: 'var(--accent-b)', fontWeight: 700 }}
                  onClick={() => {
                    onClose();
                    onTabChange('/tail');
                  }}
                >
                  ⚡ 去尾盘潜伏台 →
                </button>
              )}
            </div>
          )}

          {/* 已生成的收盘归档 KPI 与完整简报 */}
          {activeArchive ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                  gap: '10px',
                }}
              >
                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: '4px solid #0958d9' }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>💰 收盘总资产 ({activeArchive.date})</div>
                  <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '3px' }}>
                    ¥{money(activeArchive.snapshot?.total || 0)}
                  </div>
                  <div
                    className={(activeArchive.deltaInfo?.dayDelta || 0) >= 0 ? 'up' : 'down'}
                    style={{ fontSize: '11px', fontWeight: 700, marginTop: '2px' }}
                  >
                    单日 {(activeArchive.deltaInfo?.dayDelta || 0) >= 0 ? '+' : ''}¥{money(activeArchive.deltaInfo?.dayDelta || 0)} (
                    {(activeArchive.deltaInfo?.dayDeltaPct || 0) >= 0 ? '+' : ''}
                    {(activeArchive.deltaInfo?.dayDeltaPct || 0).toFixed(2)}%)
                  </div>
                </div>

                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: '4px solid #0f766e' }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>📦 收盘仓位与现金水位</div>
                  <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '3px', color: 'var(--teal)' }}>
                    {activeArchive.snapshot?.rate || '0.0'}%
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    现金 ¥{money(activeArchive.snapshot?.cash || 0)}
                  </div>
                </div>

                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: '4px solid #7c3aed' }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>🛡️ 当日操盘纪律评分</div>
                  <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '3px', color: 'var(--accent-d)' }}>
                    {activeArchive.disciplineScore}/100
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    {activeArchive.grade} · {activeArchive.tradeCount || 0}笔交割
                  </div>
                </div>

                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: `4px solid ${activeArchive.vaultSynced ? '#16a34a' : '#d97706'}` }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>💾 金库持久化状态</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, marginTop: '5px', color: activeArchive.vaultSynced ? 'var(--down-d)' : 'var(--warn-d)' }}>
                    {activeArchive.vaultSynced ? '已双写本地磁盘' : '已存浏览器缓存'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    归档时刻 {activeArchive.archivedAt || '—'}
                  </div>
                </div>
              </div>

              {/* 🔥 当日主力先导强共振 × 做T知行对照可视化复盘卡 */}
              {activeArchive.leadingReview && (
                <div
                  style={{
                    background: activeArchive.leadingReview.totalCount > 0 ? '#fffaf5' : 'var(--surface2)',
                    border: `1px solid ${activeArchive.leadingReview.totalCount > 0 ? 'var(--warn-b)' : 'var(--line)'}`,
                    borderRadius: '9px',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: '13.5px', color: '#9a3412' }}>
                        🔥 当日主力先导强共振 × 做T知行对照
                      </span>
                      {activeArchive.leadingReview.totalCount > 0 ? (
                        <>
                          <span
                            style={{
                              fontSize: '11.5px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                              fontWeight: 800,
                              background: 'var(--warn-bg)',
                              color: 'var(--warn-d)',
                              border: '1px solid var(--warn-b)',
                            }}
                          >
                            命中 {activeArchive.leadingReview.hitCount}/{activeArchive.leadingReview.totalCount} (
                            {activeArchive.leadingReview.hitRate}%)
                          </span>
                          <span style={{ fontSize: '11.5px', color: '#7c2d12', fontWeight: 600 }}>
                            平均顺向空间 +{Number(activeArchive.leadingReview.avgFavorablePct || 0).toFixed(2)}%
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: '12px', color: 'var(--sub)' }}>
                          今日盘中未触发 3维/4维主力先导强共振实盘信号
                        </span>
                      )}
                      {activeArchive.leadingReview.drillFilteredCount > 0 && (
                        <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                          （已自动剔除 {activeArchive.leadingReview.drillFilteredCount} 条演练记录）
                        </span>
                      )}
                    </div>

                    {activeArchive.leadingReview.totalCount > 0 && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '11.5px', fontWeight: 700 }}>
                        <span
                          style={{
                            padding: '2px 7px',
                            borderRadius: '6px',
                            background: 'var(--down-bg)',
                            color: 'var(--down-d)',
                          }}
                        >
                          ✅ 顺向执行 {activeArchive.leadingReview.alignedCount}
                          {activeArchive.leadingReview.alignedNetSum !== 0
                            ? ` (${activeArchive.leadingReview.alignedNetSum >= 0 ? '+' : ''}¥${money(activeArchive.leadingReview.alignedNetSum)})`
                            : ''}
                        </span>
                        <span
                          style={{
                            padding: '2px 7px',
                            borderRadius: '6px',
                            background: 'var(--info-bg)',
                            color: 'var(--info-d)',
                          }}
                        >
                          🛡️ 守纪/观望 {activeArchive.leadingReview.disciplinedPassCount}
                        </span>
                        <span
                          style={{
                            padding: '2px 7px',
                            borderRadius: '6px',
                            background: 'var(--warn-bg)',
                            color: 'var(--warn-d)',
                          }}
                        >
                          👀 踏空好球 {activeArchive.leadingReview.missedCount}
                        </span>
                        {activeArchive.leadingReview.contraryCount > 0 && (
                          <span
                            style={{
                              padding: '2px 7px',
                              borderRadius: '6px',
                              background: 'var(--up-bg)',
                              color: 'var(--up-d)',
                            }}
                          >
                            🚨 逆向违背 {activeArchive.leadingReview.contraryCount}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {activeArchive.leadingReview.totalCount > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: '12px',
                          background: 'var(--card)',
                          borderRadius: '7px',
                          overflow: 'hidden',
                        }}
                      >
                        <thead>
                          <tr style={{ background: 'var(--warn-bg)', color: '#7c2d12', textAlign: 'left' }}>
                            <th style={{ padding: '7px 9px', borderBottom: '1px solid var(--warn-b)', whiteSpace: 'nowrap' }}>触发时刻</th>
                            <th style={{ padding: '7px 9px', borderBottom: '1px solid var(--warn-b)' }}>标的 / 共振维度</th>
                            <th style={{ padding: '7px 9px', borderBottom: '1px solid var(--warn-b)' }}>触发价 → 信号后验证</th>
                            <th style={{ padding: '7px 9px', borderBottom: '1px solid var(--warn-b)', whiteSpace: 'nowrap' }}>命中判定</th>
                            <th style={{ padding: '7px 9px', borderBottom: '1px solid var(--warn-b)' }}>实盘做T执行对照</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(activeArchive.leadingReview.items || []).map((it, idx) => {
                            const isBull = it.dir !== 'bear';
                            const execBg =
                              it.execStatus === 'ALIGNED_EXEC'
                                ? 'var(--down-bg)'
                                : it.execStatus === 'CONTRARY_EXEC'
                                ? 'var(--up-bg)'
                                : it.execStatus === 'MISSED_OPPORTUNITY'
                                ? 'var(--warn-bg)'
                                : 'var(--surface)';
                            const execColor =
                              it.execStatus === 'ALIGNED_EXEC'
                                ? 'var(--down-d)'
                                : it.execStatus === 'CONTRARY_EXEC'
                                ? 'var(--up-d)'
                                : it.execStatus === 'MISSED_OPPORTUNITY'
                                ? 'var(--warn-d)'
                                : 'var(--sub)';
                            return (
                              <tr key={it.id || idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '7px 9px', fontFamily: 'monospace', whiteSpace: 'nowrap', color: 'var(--sub)' }}>
                                  {it.time}
                                </td>
                                <td style={{ padding: '7px 9px' }}>
                                  <div style={{ fontWeight: 700 }}>
                                    {it.name} <span style={{ color: 'var(--mute)', fontFamily: 'monospace' }}>({it.code})</span>
                                  </div>
                                  <div style={{ fontSize: '11px', color: isBull ? 'var(--warn-d)' : 'var(--teal)', fontWeight: 700, marginTop: '2px' }}>
                                    {isBull ? '🔥' : '🚨'} {it.label} ({it.scoreTxt})
                                    {Array.isArray(it.tags) && it.tags.length > 0 ? ` · ${it.tags.join(' + ')}` : ''}
                                  </div>
                                </td>
                                <td style={{ padding: '7px 9px', fontSize: '11.5px', lineHeight: 1.45 }}>
                                  <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>触发 ¥{f2(it.triggerPrice)}</div>
                                  <div style={{ color: 'var(--sub)' }}>{it.outcomeNote}</div>
                                </td>
                                <td style={{ padding: '7px 9px', whiteSpace: 'nowrap', fontWeight: 800, color: it.hit ? 'var(--down-d)' : 'var(--mute)' }}>
                                  {it.hit ? '🎯 命中' : '⚪ 未达标'}
                                </td>
                                <td style={{ padding: '7px 9px', background: execBg }}>
                                  <div style={{ fontWeight: 800, color: execColor }}>{it.execBadge}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>{it.execDetail}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* 完整复盘简报正文 */}
              <div
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--line2)',
                  borderRadius: '9px',
                  padding: '14px 16px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '8px',
                    borderBottom: '1px dashed var(--line2)',
                    paddingBottom: '8px',
                    marginBottom: '10px',
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: '13.5px', color: 'var(--text)' }}>
                    📋 收盘复盘与明日挂单简报 · {activeArchive.date}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => copyPlain(activeArchive.briefMarkdown, '✓ 收盘归档与明日预案简报已复制到剪贴板！')}
                    >
                      📋 复制简报
                    </button>
                    <button type="button" className="mini" onClick={handleDownloadMd}>
                      ⬇ 下载 .md
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    fontSize: '12.5px',
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--text)',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                  }}
                >
                  {activeArchive.briefMarkdown}
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: '28px 16px',
                textAlign: 'center',
                borderRadius: '8px',
                background: 'var(--surface2)',
                border: '1px dashed var(--line)',
                color: 'var(--sub)',
                fontSize: '12.5px',
              }}
            >
              点击上方「🚀 一键执行五步收盘归档」，系统将在数秒内自动拉取最新收盘价、排查未平T仓、写入今日资产净值快照、生成今日复盘与明日挂单简报并落盘本地金库。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
