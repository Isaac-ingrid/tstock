'use client';

import React from 'react';
import { f2, money$ } from '../../services/utils.js';

export const DEFAULT_MYSTIC_ROOTS = '东方,阳,洋,祥,羊,龙,凤,福,瑞,泰,昌,盛,金,马,猴';

export function isMainboard0060(code) {
  const c = String(code || '').trim().padStart(6, '0');
  return c.startsWith('00') || c.startsWith('60');
}

export function TagBadges({ tags = [] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
      {tags.map((tg, idx) => (
        <span
          key={`${tg.key}_${idx}`}
          style={{
            fontSize: '11px',
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: '4px',
            background: tg.bg || '#f1f5f9',
            color: tg.color || '#334155',
            border: `1px solid ${tg.border || '#cbd5e1'}`,
            whiteSpace: 'nowrap',
          }}
        >
          {tg.label}
        </span>
      ))}
    </div>
  );
}

/**
 * 统一且绝不折行裁切的全站个股快捷操作按钮组：
 * 支持 📊评分拆解(可选) · 🩺诊股 · 🚀起爆(可选) · 自定义扩展项 · 📌跟踪/✓跟踪 · ＋自选/✓已自选(原位留页可连选)
 */
export function BoardStockActions({
  stock,
  inPoolCodes,
  herdCodeSet,
  herdBusyCode = '',
  onHerdAction,
  onAddSingle,
  onSelectStock,
  onOpenScore,
  onJumpHerd,
  onJumpIgnition,
  compact = false,
  showHerd = true,
  allowAllBoardsTrack = false,
  trackTitle = '加入自动抱团跟踪池',
  trackedTitle = '已在跟踪池，点击查看跟踪详情',
  showDiag = true,
  readOnlyHistory = false,
  extraActions = null,
}) {
  if (!stock || !stock.code) return null;
  const code6 = String(stock.code).trim().padStart(6, '0');
  const inT = Boolean(inPoolCodes?.has(code6));
  const inH = Boolean(herdCodeSet?.has(code6));
  const canTrackHerd =
    showHerd &&
    Boolean(onHerdAction) &&
    (allowAllBoardsTrack || isMainboard0060(code6));

  return (
    <div className={`board-act-group ${compact ? 'is-compact' : 'is-full'}`}>
      {onOpenScore && (
        <button
          type="button"
          className="board-act-btn score"
          onClick={(e) => {
            e.stopPropagation();
            onOpenScore(stock);
          }}
          title="查看双轨评分拆解与周期操作建议"
        >
          {compact ? '📊' : '📊 评分拆解'}
        </button>
      )}

      {showDiag && (
        <a
          href={`#/diagnosis?code=${code6}`}
          className="board-act-btn diag"
          onClick={(e) => e.stopPropagation()}
          title={`全景诊股：${stock.name || ''} (${code6})`}
        >
          {compact ? '🩺' : '🩺 诊股'}
        </a>
      )}

      {onJumpIgnition && (
        <button
          type="button"
          className="board-act-btn ignition"
          onClick={(e) => {
            e.stopPropagation();
            onJumpIgnition(code6);
          }}
          title="跳转到起爆挖掘做六维成色体检"
        >
          {compact ? '🚀' : '🚀 起爆'}
        </button>
      )}

      {extraActions}

      {canTrackHerd && (
        inH ? (
          <button
            type="button"
            className="board-act-btn tracked"
            onClick={(e) => {
              e.stopPropagation();
              if (onJumpHerd) onJumpHerd(stock);
            }}
            title={onJumpHerd ? trackedTitle : '已在跟踪池'}
          >
            {compact ? '✓跟踪' : '✓ 已跟踪'}
          </button>
        ) : (
          <button
            type="button"
            className="board-act-btn track"
            disabled={readOnlyHistory || herdBusyCode === code6}
            onClick={(e) => {
              e.stopPropagation();
              onHerdAction('add', stock);
            }}
            title={readOnlyHistory ? '历史复盘模式暂禁修改实时跟踪池' : trackTitle}
          >
            {herdBusyCode === code6 ? '…' : compact ? '📌跟踪' : '📌 加跟踪'}
          </button>
        )
      )}

      {inT ? (
        <button
          type="button"
          className="board-act-btn in-pool"
          onClick={(e) => {
            e.stopPropagation();
            if (onSelectStock) onSelectStock(code6);
          }}
          title="已在自选池，点击前往今日作战台查看买卖点"
        >
          {compact ? '✓已自选' : '✓ 已自选 →'}
        </button>
      ) : (
        <button
          type="button"
          className="board-act-btn add-pool"
          onClick={(e) => {
            e.stopPropagation();
            if (onAddSingle) onAddSingle(code6, stock.name, stock);
          }}
          title="原位加入自选池（留在当前页可连续添加多只标的）"
        >
          {compact ? '＋自选' : '＋ 加入自选'}
        </button>
      )}
    </div>
  );
}

export function CoreRoleBox({
  roleLabel,
  accent,
  bdColor,
  bgColor,
  stock,
  inPoolCodes,
  herdCodeSet,
  herdBusyCode,
  onHerdAction,
  onAddSingle,
  onSelectStock,
  onJumpHerd,
  readOnlyHistory = false,
}) {
  if (!stock) {
    return (
      <div style={{ padding: '10px', borderRadius: '8px', border: '1px dashed var(--line)', background: '#f8fafc', fontSize: '12px', color: 'var(--mute)' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }}>{roleLabel}</div>
        暂无明显主板对应标的
      </div>
    );
  }
  const chgVal = Number(stock.chg || 0);
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', border: `1px solid ${bdColor}`, background: bgColor, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 800, color: accent }}>{roleLabel}</span>
        {stock.popRank && (
          <span style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '4px', background: '#fff7ed', color: '#c2410c', border: '1px solid #fdba74', fontWeight: 700 }}>
            🔥人气#{stock.popRank}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text)' }}>{stock.name}</span>
          <span style={{ fontSize: '11.5px', fontFamily: 'monospace', color: 'var(--mute)', marginLeft: '5px' }}>{stock.code}</span>
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 800, color: chgVal >= 0 ? 'var(--up)' : 'var(--down)' }}>
          ¥{f2(stock.price)} ({chgVal >= 0 ? `+${chgVal.toFixed(2)}%` : `${chgVal.toFixed(2)}%`})
        </div>
      </div>
      <div style={{ fontSize: '11.5px', color: '#334155', lineHeight: 1.45 }}>
        {stock.roleReason || stock.statTag}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', fontSize: '11px', color: 'var(--sub)', paddingTop: '2px' }}>
        <span>成交: <b>{money$(stock.amount)}</b> · 流通: <b>{money$(stock.mcap)}</b></span>
        <BoardStockActions
          stock={stock}
          inPoolCodes={inPoolCodes}
          herdCodeSet={herdCodeSet}
          herdBusyCode={herdBusyCode}
          onHerdAction={onHerdAction}
          onAddSingle={onAddSingle}
          onSelectStock={onSelectStock}
          onJumpHerd={onJumpHerd}
          compact
          readOnlyHistory={readOnlyHistory}
        />
      </div>
    </div>
  );
}

export function buildDailyReviewBrief({ data, mainThemes, mysticClusters, herdPool, allItems }) {
  if (!data) return '';
  const s = data.sentiment || {};
  const mo = mainThemes?.marketOverview || {};
  const themes = mainThemes?.themes || [];
  const topMystic = (mysticClusters || []).filter(c => c.ztCount >= 2);
  const topHerd = (herdPool || []).filter(h => h.healthStatus !== 'warning').slice(0, 6);

  const lines = [
    `📊【T-Stock 超短情绪与短线复盘简报 · ${data.date || '—'}】`,
    `🌡️ 情绪温度: ${s.temperature ?? '—'}°C (${s.cyclePhase || '—'}) ｜ ${s.valveLabel || '—'}`,
    `📈 涨跌与炸板: 主板涨停 ${allItems?.length ?? 0} 家 (全市场 ${s.limitUpCount ?? 0}) ｜ 炸板率 ${s.brokenRate ?? '—'}% ｜ 跌停 ${s.limitDownCount ?? 0} 家 ｜ 最高连板 ${s.maxLadder ?? '—'} 杆`,
  ];
  if (s.yesterdayPremiumMean != null) {
    lines.push(
      `💹 昨涨停今日溢价: 均值 ${s.yesterdayPremiumMean >= 0 ? '+' : ''}${s.yesterdayPremiumMean}% / 中位 ${s.yesterdayPremiumMedian != null ? `${s.yesterdayPremiumMedian >= 0 ? '+' : ''}${s.yesterdayPremiumMedian}%` : '—'} ｜ 晋级率 ${s.promotionRate ?? '—'}% (${s.promotionSample || '—'})`
    );
  }
  lines.push(`🚦 总阀指引: ${s.valveAction || '—'}`);
  if (s.doAction || s.dontAction) {
    lines.push(`  ✅ 可做: ${s.doAction || '—'} ｜ ⛔ 禁止: ${s.dontAction || '—'}`);
  }
  lines.push('');
  lines.push('🧭【主线中枢与三大核心】');
  if (mo.topThemeName) lines.push(`  · 第一主线: ${mo.topThemeName} (${mo.topThemeReason || ''})`);
  if (mo.heightLeader) lines.push(`  · 👑 空间总龙: ${mo.heightLeader.name} (${mo.heightLeader.code}) · ${mo.heightLeader.roleReason || mo.heightLeader.statTag}`);
  if (mo.phaseCore) lines.push(`  · 🔥 阶段核心: ${mo.phaseCore.name} (${mo.phaseCore.code}) · ${mo.phaseCore.roleReason || mo.phaseCore.statTag}`);
  if (mo.capacityCore) lines.push(`  · 🐳 容量核心: ${mo.capacityCore.name} (${mo.capacityCore.code}) · ${mo.capacityCore.roleReason || mo.capacityCore.statTag}`);
  if (themes.length > 0) {
    lines.push('  · 前排轮动方向: ' + themes.slice(0, 4).map(t => `${t.name}(${t.ztCount}板)`).join(' / '));
  }
  if (topMystic.length > 0) {
    lines.push('');
    lines.push('🔮【跨行业字辈共振暗线】');
    topMystic.slice(0, 5).forEach(c => {
      const ldr = (c.leaders || []).slice(0, 4).map(l => `${l.name}(${l.lbc}板)`).join('、');
      lines.push(`  · ${c.name} [${c.ztCount}板]: ${ldr}`);
    });
  }
  if (topHerd.length > 0) {
    lines.push('');
    lines.push('🤝【活跃抱团健康核心】');
    lines.push('  · ' + topHerd.map(h => `${h.name}(${h.chg >= 0 ? '+' : ''}${Number(h.chg || 0).toFixed(1)}%/${h.statTag})`).join(' ｜ '));
  }
  lines.push('');
  lines.push('—— 生成自 T-Stock 连板打板决策台');
  return lines.join('\n');
}
