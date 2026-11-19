import React, { useState, useMemo, useEffect } from 'react';
import { f2, money, todayStr, copyPlain, toastOk } from '../services/utils.js';

const STEP_DEFS = [
  { key: 'quotes', num: '01', title: '同步收盘行情', desc: '拉取持仓/尾盘最新收盘价与指数' },
  { key: 'audit', num: '02', title: '核查未平T与隔夜仓', desc: '排查滞留T仓与次日早盘必平黑马' },
  { key: 'snapshot', num: '03', title: '归档今日净值快照', desc: '落盘总资产、仓位与单日涨跌' },
  { key: 'brief', num: '04', title: '生成量化复盘简报', desc: '核算四维纪律分与明日挂单锚点' },
  { key: 'vault', num: '05', title: '双写本地磁盘金库', desc: '同步 user_vault.json 与按日备份' },
];

function statusStyle(st) {
  if (st === 'done') return { bg: '#f0fdf4', border: '#86efac', color: '#15803d', icon: '✅' };
  if (st === 'warn') return { bg: '#fffbeb', border: '#fcd34d', color: '#b45309', icon: '⚠️' };
  if (st === 'running') return { bg: '#eff6ff', border: '#93c5fd', color: '#1d4ed8', icon: '⏳' };
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
                background: todayArchive ? '#f0fdf4' : '#fffbeb',
                color: todayArchive ? '#15803d' : '#b45309',
                border: `1px solid ${todayArchive ? '#86efac' : '#fcd34d'}`,
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
              background: 'linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)',
              border: '1px solid #c7d2fe',
            }}
          >
            <div style={{ fontSize: '12.5px', color: '#1e3a8a', lineHeight: 1.5 }}>
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
                    border: '1px solid #cbd5e1',
                    background: '#fff',
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
                background: '#fff1f0',
                border: '1.5px solid #ffa39e',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 800, color: '#cf1322', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                    background: '#fff',
                    border: '1px solid #fecaca',
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
                        style={{ background: '#eff6ff', color: '#1d4ed8', borderColor: '#93c5fd', fontWeight: 700 }}
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
                        style={{ background: '#fffbeb', color: '#b45309', borderColor: '#fcd34d', fontWeight: 700 }}
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

          {/* ⚡ 尾盘黑马隔夜持仓次日必平提示 */}
          {overnightTails.length > 0 && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                background: '#f5f3ff',
                border: '1px solid #ddd6fe',
                fontSize: '12px',
                color: '#5b21b6',
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
                  <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '3px', color: '#0f766e' }}>
                    {activeArchive.snapshot?.rate || '0.0'}%
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    现金 ¥{money(activeArchive.snapshot?.cash || 0)}
                  </div>
                </div>

                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: '4px solid #7c3aed' }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>🛡️ 当日操盘纪律评分</div>
                  <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '3px', color: '#7c3aed' }}>
                    {activeArchive.disciplineScore}/100
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    {activeArchive.grade} · {activeArchive.tradeCount || 0}笔交割
                  </div>
                </div>

                <div className="card" style={{ padding: '10px 12px', background: 'var(--surface2)', borderLeft: `4px solid ${activeArchive.vaultSynced ? '#16a34a' : '#d97706'}` }}>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>💾 金库持久化状态</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, marginTop: '5px', color: activeArchive.vaultSynced ? '#15803d' : '#b45309' }}>
                    {activeArchive.vaultSynced ? '已双写本地磁盘' : '已存浏览器缓存'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                    归档时刻 {activeArchive.archivedAt || '—'}
                  </div>
                </div>
              </div>

              {/* 完整复盘简报正文 */}
              <div
                style={{
                  background: '#fcfdff',
                  border: '1px solid #cbd5e1',
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
                    borderBottom: '1px dashed #cbd5e1',
                    paddingBottom: '8px',
                    marginBottom: '10px',
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: '13.5px', color: '#0f172a' }}>
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
