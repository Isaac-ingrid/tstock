'use client';

import React from 'react';
import { f2, money$ } from '../../services/utils.js';
import { DEFAULT_MYSTIC_ROOTS, TagBadges } from './boardShared.jsx';

export default function StrongPoolPanel({
  displayItems,
  displayStrongGroups,
  strongPool,
  strongEliteCount,
  strongMulti2Count,
  strongMinTags,
  setStrongMinTags,
  strongOnlyNonZt,
  setStrongOnlyNonZt,
  strongViewMode,
  setStrongViewMode,
  strongSelectedTags,
  setStrongSelectedTags,
  toggleStrongTag,
  strongSectors,
  selectedTheme,
  setSelectedTheme,
  mysticClusters,
  mysticDraft,
  setMysticDraft,
  showMysticConfig,
  setShowMysticConfig,
  onSaveMysticRoots,
  strongSort,
  strongSortAsc,
  toggleStrongSort,
  inPoolCodes,
  herdCodeSet,
  herdBusyCode,
  onHerdAction,
  onAddSingle,
  setFilterTier,
  strongDetailItem,
  setStrongDetailItem,
  readOnlyHistory = false,
}) {
  const renderCompactStrongRow = (item, idx, totalLen) => {
    const inT = inPoolCodes.has(item.code);
    const inH = herdCodeSet.has(item.code);
    const tCnt = item.tagCount || item.tags?.length || 0;
    const starBg = tCnt >= 5 ? '#cf1322' : tCnt === 4 ? '#d97706' : tCnt === 3 ? '#0f766e' : '#64748b';
    const rScore = item.relayScore ?? 0;
    const iScore = item.identityScore ?? 0;
    const rColor = rScore >= 78 ? '#cf1322' : rScore >= 65 ? '#d97706' : '#0f766e';
    const isOneWord = item.isLimitUp && item.fbtSec && item.fbtSec <= 92500 && Number(item.turnover || 0) <= 2.5 && (item.zbc || 0) === 0;
    return (
      <div
        key={item.code}
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 168px 98px 142px minmax(195px, 1fr) 108px 148px',
          gap: '8px',
          alignItems: 'center',
          padding: '7px 12px',
          borderBottom: idx === totalLen - 1 ? 'none' : '1px solid var(--line)',
          background: item.isLimitUp ? '#fffafa' : idx % 2 === 1 ? '#fcfcfd' : '#fff',
          fontSize: '12px',
        }}
      >
        <div
          onClick={() => setStrongDetailItem(item)}
          style={{ cursor: 'pointer' }}
          title="点击查看身份分 / 接力分与周期应对明细"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ display: 'inline-block', padding: '1px 5px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 800, background: starBg, color: '#fff', fontFamily: 'monospace' }}>
              {tCnt}★
            </span>
            <span style={{ fontSize: '11.5px', fontWeight: 800, color: rColor, fontFamily: 'monospace' }}>
              接{rScore}
            </span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mute)', fontFamily: 'monospace', marginTop: '2px' }}>
            身{iScore} · {item.statTag}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            onClick={() => setStrongDetailItem(item)}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}
            title="点击查看双轨评分明细"
          >
            <b style={{ fontSize: '13.5px', color: 'var(--text)' }}>{item.name}</b>
            <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--mute)' }}>{item.code}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span
              onClick={() => setSelectedTheme(selectedTheme === item.hybk ? 'all' : item.hybk)}
              style={{ fontSize: '10.5px', color: '#1d39c4', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={`按板块筛选：${item.hybk}`}
            >
              {item.hybk}
            </span>
            {item.isMysticResonant && item.mysticCluster && (
              <span
                onClick={() => setSelectedTheme(selectedTheme === `字辈·${item.mysticCluster}` ? 'all' : `字辈·${item.mysticCluster}`)}
                style={{ fontSize: '10px', padding: '0 4px', borderRadius: '3px', background: '#f5f3ff', color: '#7c3aed', border: '1px solid #d8b4fe', cursor: 'pointer', fontWeight: 700, flexShrink: 0 }}
                title={`点击筛选同字辈共振：${item.mysticCluster}`}
              >
                🔮{item.mysticCluster}
              </span>
            )}
          </div>
        </div>
        <div style={{ fontFamily: 'monospace', fontWeight: 800, color: item.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>
          <div>¥{f2(item.price)}</div>
          <div style={{ fontSize: '11.5px' }}>{item.chg >= 0 ? `+${item.chg.toFixed(2)}%` : `${item.chg.toFixed(2)}%`}</div>
        </div>
        <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--sub)' }}>
          {item.isLimitUp ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <b style={{ color: isOneWord ? '#64748b' : '#cf1322' }}>
                  {isOneWord ? '一字锁死' : `首封 ${item.fbt || '—'}`}
                </b>
                {(item.zbc || 0) > 0 && (
                  <span style={{ fontSize: '10px', color: '#cf1322', fontWeight: 700 }}>{item.zbc}炸</span>
                )}
              </div>
              <div style={{ color: 'var(--mute)', fontSize: '10.5px' }}>
                封单 {item.fund >= 1e7 ? money$(item.fund) : '弱封'} · 比{Number(item.sealRatio || 0).toFixed(2)}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700, color: item.vsMa5 != null && item.vsMa5 >= 0 ? '#15803d' : '#c2410c' }}>
                {item.vsMa5 != null ? `MA5 ${item.vsMa5 >= 0 ? '+' : ''}${Number(item.vsMa5).toFixed(1)}%` : '趋势活跃(未板)'}
              </div>
              <div style={{ color: 'var(--mute)', fontSize: '10.5px' }}>
                {item.ddFromPeak != null ? `距峰 ${Number(item.ddFromPeak).toFixed(1)}%` : `换手 ${Number(item.turnover || 0).toFixed(1)}%`}
              </div>
            </>
          )}
        </div>
        <div>
          <TagBadges tags={item.tags} />
        </div>
        <div style={{ fontSize: '11px', color: 'var(--sub)', fontFamily: 'monospace' }}>
          <div>{money$(item.amount)}</div>
          <div style={{ color: item.popRank ? '#c2410c' : 'var(--mute)', fontWeight: item.popRank ? 700 : 400 }}>
            {item.popRank ? `🔥 人气#${item.popRank}` : `换手 ${Number(item.turnover || 0).toFixed(1)}%`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
          <button
            type="button"
            className="mini"
            onClick={() => setStrongDetailItem(item)}
            style={{ fontSize: '10.5px', padding: '2px 5px', background: '#f8fafc', borderColor: '#cbd5e1' }}
            title="查看双轨评分拆解与周期操作建议"
          >
            📊
          </button>
          <a href={`#/diagnosis?code=${item.code}`} className="mini" style={{ textDecoration: 'none', padding: '2px 5px', fontSize: '10.5px' }} title="全景诊股">
            🩺
          </a>
          {inH ? (
            <button
              type="button"
              className="mini"
              onClick={() => setFilterTier('herd')}
              style={{ fontSize: '10.5px', padding: '2px 6px', color: '#6d28d9', borderColor: '#c4b5fd', background: '#f5f3ff', fontWeight: 700 }}
              title="已在抱团跟踪池，点击跳转"
            >
              ✓跟踪
            </button>
          ) : (
            <button
              type="button"
              className="mini"
              disabled={readOnlyHistory || herdBusyCode === item.code}
              onClick={() => onHerdAction('add', item)}
              style={{ fontSize: '10.5px', padding: '2px 6px', color: '#6d28d9', borderColor: '#c4b5fd', background: '#fff' }}
              title={readOnlyHistory ? '历史复盘模式暂禁修改实时抱团池' : '加入自动抱团跟踪池'}
            >
              📌跟踪
            </button>
          )}
          {inT ? (
            <span style={{ fontSize: '10.5px', color: 'var(--info)', fontWeight: 700 }}>✓</span>
          ) : (
            <button type="button" className="mini primary" onClick={() => onAddSingle(item.code, item.name)} style={{ fontSize: '10.5px', padding: '2px 6px' }} title="选入做T决策台">
              ＋T
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* 顶部控制栏 */}
      <div style={{ padding: '10px 12px', background: '#f0fdfa', border: '1px solid #5eead4', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#0f766e' }}>💪 共振强度：</span>
            {[
              { min: 3, label: `🔥 强共振(≥3标签) (${strongEliteCount})` },
              { min: 2, label: `⚡ 多标签(≥2标签) (${strongMulti2Count})` },
              { min: 1, label: `📋 全部精选 (${strongPool.length})` },
            ].map(opt => (
              <button
                key={opt.min}
                type="button"
                className={`mini ${strongMinTags === opt.min ? 'primary' : ''}`}
                onClick={() => setStrongMinTags(opt.min)}
                style={{
                  fontSize: '11.5px',
                  fontWeight: strongMinTags === opt.min ? 800 : 600,
                  background: strongMinTags === opt.min ? '#0f766e' : '#fff',
                  borderColor: strongMinTags === opt.min ? '#0f766e' : '#99f6e4',
                  color: strongMinTags === opt.min ? '#fff' : '#0f766e',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11.5px',
                cursor: 'pointer',
                padding: '3px 8px',
                borderRadius: '5px',
                background: strongOnlyNonZt ? '#fff7ed' : '#fff',
                border: `1px solid ${strongOnlyNonZt ? '#fb923c' : '#cbd5e1'}`,
                color: strongOnlyNonZt ? '#c2410c' : 'var(--text)',
                fontWeight: strongOnlyNonZt ? 800 : 600,
              }}
              title="屏蔽已封涨停的标的，只把未涨停的断板高横、人气核心与新高趋势股拎出来"
            >
              <input
                type="checkbox"
                checked={strongOnlyNonZt}
                onChange={e => setStrongOnlyNonZt(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>🎯 仅看未涨停</span>
            </label>

            <div style={{ display: 'inline-flex', borderRadius: '5px', overflow: 'hidden', border: '1px solid #cbd5e1', background: '#fff' }}>
              {[
                { mode: 'compact', label: '📋 紧凑列表' },
                { mode: 'bySector', label: '🗂️ 按板块聚合' },
                { mode: 'card', label: '📄 详细卡片' },
              ].map(v => (
                <button
                  key={v.mode}
                  type="button"
                  onClick={() => setStrongViewMode(v.mode)}
                  style={{
                    padding: '3px 8px',
                    fontSize: '11px',
                    border: 'none',
                    cursor: 'pointer',
                    background: strongViewMode === v.mode ? '#0f766e' : 'transparent',
                    color: strongViewMode === v.mode ? '#fff' : 'var(--sub)',
                    fontWeight: strongViewMode === v.mode ? 700 : 500,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 多选交集标签条 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', color: '#0f766e', fontWeight: 700 }}>标签交集叠加(可多选)：</span>
          <button
            type="button"
            className={`mini ${strongSelectedTags.length === 0 ? 'primary' : ''}`}
            onClick={() => setStrongSelectedTags([])}
            style={{ fontSize: '11px', padding: '2px 7px' }}
          >
            全部 ({displayItems.length})
          </button>
          {[
            { k: 'herd', label: '🤝 资金抱团' },
            { k: 'popular', label: '🔥 人气核心' },
            { k: 'newhigh', label: '📈 60日新高' },
            { k: 'highflat', label: '💎 断板高横' },
            { k: 'capacity', label: '🐳 容量核心' },
            { k: 'ladder', label: '👑 连板梯队' },
            { k: 'mystic', label: '🔮 玄学字辈' },
          ].map(tab => {
            const active = strongSelectedTags.includes(tab.k);
            return (
              <button
                key={tab.k}
                type="button"
                className="mini"
                onClick={() => toggleStrongTag(tab.k)}
                style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  fontWeight: active ? 800 : 600,
                  background: active ? '#0f766e' : '#fff',
                  color: active ? '#fff' : '#334155',
                  borderColor: active ? '#0f766e' : '#cbd5e1',
                }}
              >
                {active ? '✓ ' : ''}{tab.label}
              </button>
            );
          })}
        </div>

        {/* 玄学字根 & 今日字辈共振条 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px', borderTop: '1px dashed #99f6e4' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: '#7c3aed', fontWeight: 800 }}>🔮 今日字辈暗线共振：</span>
              {mysticClusters.length === 0 ? (
                <span style={{ fontSize: '11px', color: 'var(--mute)' }}>暂无≥2家同字辈/同音字根涨停共振</span>
              ) : (
                mysticClusters.map(cl => {
                  const tKey = `字辈·${cl.name}`;
                  const active = selectedTheme === tKey;
                  return (
                    <button
                      key={cl.name}
                      type="button"
                      className="mini"
                      onClick={() => setSelectedTheme(active ? 'all' : tKey)}
                      title={`点击筛选同字辈股票：${(cl.leaders || []).map(l => `${l.name}(${l.lbc}板)`).join('、')}`}
                      style={{
                        fontSize: '11px',
                        padding: '1px 7px',
                        fontWeight: active ? 800 : 700,
                        background: active ? '#7c3aed' : '#faf5ff',
                        color: active ? '#fff' : '#6d28d9',
                        borderColor: active ? '#7c3aed' : '#d8b4fe',
                      }}
                    >
                      {cl.name} ({cl.ztCount}板{cl.isAuto ? '·自动字头' : ''})
                    </button>
                  );
                })
              )}
            </div>
            <button
              type="button"
              className="mini"
              onClick={() => setShowMysticConfig(v => !v)}
              style={{ fontSize: '11px', padding: '1px 7px', color: '#6d28d9', borderColor: '#d8b4fe', background: '#fff' }}
            >
              {showMysticConfig ? '▲ 收起字根配置' : '⚙️ 自定义玄学字根'}
            </button>
          </div>

          {showMysticConfig && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '6px 8px', borderRadius: '6px', background: '#faf5ff', border: '1px solid #e9d5ff' }}>
              <span style={{ fontSize: '11px', color: '#6d28d9', fontWeight: 700 }}>玄学字根词表(逗号分隔)：</span>
              <input
                type="text"
                value={mysticDraft}
                onChange={e => setMysticDraft(e.target.value)}
                placeholder="如: 东方,阳,洋,祥,羊,龙,凤,福,瑞,泰,昌,盛,金,马,猴"
                style={{ flex: '1 1 280px', padding: '3px 8px', fontSize: '11.5px', borderRadius: '5px', border: '1px solid #d8b4fe', background: '#fff' }}
              />
              <button
                type="button"
                className="mini primary"
                onClick={() => onSaveMysticRoots(mysticDraft)}
                style={{ fontSize: '11px', padding: '3px 9px', background: '#7c3aed', borderColor: '#7c3aed' }}
              >
                应用并重算
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => onSaveMysticRoots(DEFAULT_MYSTIC_ROOTS)}
                style={{ fontSize: '11px', padding: '3px 8px' }}
              >
                恢复默认
              </button>
            </div>
          )}
        </div>

        {/* 板块分布快筛胶囊条 */}
        {strongSectors.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', paddingTop: '4px', borderTop: '1px dashed #99f6e4' }}>
            <span style={{ fontSize: '11px', color: '#0f766e', fontWeight: 700 }}>📂 按板块筛选：</span>
            <button
              type="button"
              className="mini"
              onClick={() => setSelectedTheme('all')}
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                fontWeight: selectedTheme === 'all' ? 800 : 600,
                background: selectedTheme === 'all' ? '#0958d9' : '#fff',
                color: selectedTheme === 'all' ? '#fff' : '#334155',
                borderColor: selectedTheme === 'all' ? '#0958d9' : '#cbd5e1',
              }}
            >
              全部板块
            </button>
            {strongSectors.slice(0, 12).map(sec => {
              const active = selectedTheme === sec.name;
              return (
                <button
                  key={sec.name}
                  type="button"
                  className="mini"
                  onClick={() => setSelectedTheme(active ? 'all' : sec.name)}
                  style={{
                    fontSize: '11px',
                    padding: '1px 7px',
                    fontWeight: active ? 800 : 600,
                    background: active ? '#0958d9' : (sec.isConcept ? '#faf5ff' : '#fff'),
                    color: active ? '#fff' : (sec.isConcept ? '#7c3aed' : '#1e293b'),
                    borderColor: active ? '#0958d9' : (sec.isConcept ? '#d8b4fe' : '#cbd5e1'),
                  }}
                >
                  {sec.isConcept ? `✨${sec.name}` : sec.name} ({sec.count})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 布局 A：紧凑列表 */}
      {strongViewMode === 'compact' && displayItems.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflowX: 'auto', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ minWidth: '940px' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '90px 168px 98px 142px minmax(195px, 1fr) 108px 148px',
              gap: '8px',
              padding: '8px 12px',
              background: '#f8fafc',
              borderBottom: '1px solid var(--line)',
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--mute)',
              userSelect: 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span onClick={() => toggleStrongSort('resonance')} style={{ cursor: 'pointer', color: strongSort === 'resonance' ? '#0f766e' : 'inherit' }}>
                  共振{strongSort === 'resonance' ? (strongSortAsc ? '▲' : '▼') : ''}
                </span>
                <span>/</span>
                <span onClick={() => toggleStrongSort('relay')} style={{ cursor: 'pointer', color: strongSort === 'relay' ? '#cf1322' : 'inherit' }}>
                  接力{strongSort === 'relay' ? (strongSortAsc ? '▲' : '▼') : ''}
                </span>
              </div>
              <div onClick={() => toggleStrongSort('identity')} style={{ cursor: 'pointer', color: strongSort === 'identity' ? '#0958d9' : 'inherit' }}>
                标的 / 板块 (身{strongSort === 'identity' ? (strongSortAsc ? '▲' : '▼') : '↕'})
              </div>
              <div onClick={() => toggleStrongSort('chg')} style={{ cursor: 'pointer', color: strongSort === 'chg' ? '#cf1322' : 'inherit' }}>
                现价 / 涨跌{strongSort === 'chg' ? (strongSortAsc ? '▲' : '▼') : ''}
              </div>
              <div onClick={() => toggleStrongSort('fbt')} style={{ cursor: 'pointer', color: strongSort === 'fbt' ? '#cf1322' : 'inherit' }}>
                首封 / 封单承接{strongSort === 'fbt' ? (strongSortAsc ? '▲' : '▼') : ''}
              </div>
              <div>多维标签徽章</div>
              <div onClick={() => toggleStrongSort('amount')} style={{ cursor: 'pointer', color: strongSort === 'amount' ? '#0958d9' : 'inherit' }}>
                成交 / 人气{strongSort === 'amount' ? (strongSortAsc ? '▲' : '▼') : ''}
              </div>
              <div style={{ textAlign: 'right' }}>操作</div>
            </div>
            {displayItems.map((item, idx) => renderCompactStrongRow(item, idx, displayItems.length))}
          </div>
        </div>
      )}

      {/* 布局 C：按板块聚合 */}
      {strongViewMode === 'bySector' && displayStrongGroups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {displayStrongGroups.map(grp => (
            <div
              key={grp.sector}
              style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                padding: '8px 12px',
                background: 'linear-gradient(90deg, #f0f9ff, #f8fafc)',
                borderBottom: '1px solid var(--line)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 800, color: '#0369a1' }}>📂 {grp.sector}</span>
                  <span style={{ fontSize: '11px', padding: '1px 7px', borderRadius: '4px', background: '#e0f2fe', color: '#0369a1', fontWeight: 700 }}>
                    {grp.stocks.length} 只强共振
                  </span>
                  {grp.ztCount > 0 && (
                    <span style={{ fontSize: '11px', padding: '1px 7px', borderRadius: '4px', background: '#fff1f0', color: '#cf1322', fontWeight: 700 }}>
                      涨停 {grp.ztCount} 只
                    </span>
                  )}
                  <span style={{ fontSize: '11.5px', fontFamily: 'monospace', color: grp.avgChg >= 0 ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>
                    均涨 {grp.avgChg >= 0 ? `+${grp.avgChg.toFixed(2)}%` : `${grp.avgChg.toFixed(2)}%`}
                  </span>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                    合计成交 <b>{money$(grp.totalAmount)}</b>
                  </span>
                </div>
                <button
                  type="button"
                  className="mini"
                  onClick={() => setSelectedTheme(selectedTheme === grp.sector ? 'all' : grp.sector)}
                  style={{ fontSize: '11px', color: '#0958d9', borderColor: '#91caff', background: '#fff' }}
                >
                  {selectedTheme === grp.sector ? '✕ 恢复全板块' : '🎯 只看该板块'}
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: '940px' }}>
                  {grp.stocks.map((item, idx) => renderCompactStrongRow(item, idx, grp.stocks.length))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 布局 B：详细卡片流 */}
      {strongViewMode === 'card' && displayItems.map(item => {
        const inT = inPoolCodes.has(item.code);
        const inH = herdCodeSet.has(item.code);
        return (
          <div
            key={item.code}
            style={{
              background: 'var(--surface)',
              border: item.isLimitUp ? '1.5px solid #fca5a5' : '1px solid var(--line)',
              borderRadius: '10px',
              padding: '12px 16px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: '#0f766e', color: '#fff', fontFamily: 'monospace' }}>
                  {item.tagCount || item.tags?.length || 0}★共振
                </span>
                <span style={{ fontSize: '11px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: '#eff6ff', color: '#1d4ed8', fontFamily: 'monospace', border: '1px solid #bfdbfe' }}>
                  身份 {item.identityScore ?? 0}
                </span>
                <span style={{ fontSize: '11px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: '#fff1f2', color: '#be123c', fontFamily: 'monospace', border: '1px solid #fecdd3' }}>
                  接力 {item.relayScore ?? 0}
                </span>
                <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)' }}>{item.name}</span>
                <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{item.code}</span>
                <span
                  onClick={() => setSelectedTheme(item.hybk)}
                  style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4', cursor: 'pointer' }}
                >
                  🔥 {item.hybk}
                </span>
                {item.isMysticResonant && item.mysticCluster && (
                  <span
                    onClick={() => setSelectedTheme(`字辈·${item.mysticCluster}`)}
                    style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f5f3ff', color: '#7c3aed', border: '1px solid #d8b4fe', cursor: 'pointer', fontWeight: 700 }}
                  >
                    🔮 {item.mysticCluster} ({item.mysticZtCount}板)
                  </span>
                )}
                {item.statTag && (
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569' }}>[{item.statTag}]</span>
                )}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '15px', fontWeight: 800, color: item.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>
                ¥{f2(item.price)} ({item.chg >= 0 ? `+${item.chg.toFixed(2)}%` : `${item.chg.toFixed(2)}%`})
              </div>
            </div>

            <div style={{ marginBottom: '8px' }}>
              <TagBadges tags={item.tags} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', padding: '6px 10px', background: 'var(--surface2)', borderRadius: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <div>成交额: <b style={{ fontFamily: 'monospace' }}>{money$(item.amount)}</b></div>
              <div>流通市值: <b style={{ fontFamily: 'monospace' }}>{money$(item.mcap)}</b></div>
              <div>换手率: <b style={{ fontFamily: 'monospace' }}>{Number(item.turnover || 0).toFixed(1)}%</b></div>
              {item.isLimitUp ? (
                <div>首封/封单: <b style={{ fontFamily: 'monospace', color: '#cf1322' }}>{item.fbt || '—'} · {item.fund >= 1e7 ? money$(item.fund) : '弱封'}</b></div>
              ) : (
                <div>均线承接: <b style={{ fontFamily: 'monospace', color: item.vsMa5 != null && item.vsMa5 >= 0 ? '#15803d' : '#c2410c' }}>{item.vsMa5 != null ? `MA5 ${item.vsMa5 >= 0 ? '+' : ''}${Number(item.vsMa5).toFixed(1)}%` : '未封趋势'}</b></div>
              )}
              <div>东财人气: <b style={{ color: item.popRank ? '#c2410c' : 'var(--mute)' }}>{item.popRank ? `第 ${item.popRank} 名` : 'Top100外'}</b></div>
              <div>跟踪状态: <b style={{ color: inH ? '#6d28d9' : 'var(--mute)' }}>{inH ? (item.healthLabel || '跟踪中') : '未入跟踪池'}</b></div>
            </div>

            {item.cycleAdvice && (
              <div style={{ fontSize: '11.5px', padding: '5px 9px', borderRadius: '5px', background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155', marginBottom: '8px' }}>
                🧭 <b>周期适配提示：</b>{item.cycleAdvice}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                标签共振：{item.tags?.length || 0} 维 · {item.isLimitUp ? `封成比 ${Number(item.sealRatio || 0).toFixed(2)}倍 / 炸板${item.zbc || 0}次` : '今日未涨停(强势/人气/横盘)'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className="mini"
                  onClick={() => setStrongDetailItem(item)}
                  style={{ fontSize: '11.5px', padding: '3px 8px', background: '#f8fafc', borderColor: '#cbd5e1', fontWeight: 600 }}
                >
                  📊 双轨评分拆解
                </button>
                <a href={`#/diagnosis?code=${item.code}`} className="mini" style={{ textDecoration: 'none', padding: '3px 8px' }}>
                  🩺 全景体检
                </a>
                {inH ? (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => setFilterTier('herd')}
                    style={{ fontSize: '11.5px', color: '#6d28d9', borderColor: '#c4b5fd', background: '#f5f3ff', fontWeight: 700 }}
                  >
                    ✓ 查看自动跟踪
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mini"
                    disabled={readOnlyHistory || herdBusyCode === item.code}
                    onClick={() => onHerdAction('add', item)}
                    style={{ fontSize: '11.5px', color: '#6d28d9', borderColor: '#c4b5fd', background: '#faf5ff', fontWeight: 700 }}
                  >
                    📌 加入抱团跟踪
                  </button>
                )}
                {inT ? (
                  <span style={{ fontSize: '11px', color: 'var(--info)', fontWeight: 600 }}>✓ 已在决策台</span>
                ) : (
                  <button type="button" className="mini primary" onClick={() => onAddSingle(item.code, item.name)} style={{ fontSize: '11.5px' }}>
                    ＋ 选入做T决策台
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* 强势标的双轨评分拆解弹窗 */}
      {strongDetailItem && (() => {
        const it = strongDetailItem;
        const idDims = it.scoreDims?.identity || {};
        const rlDims = it.scoreDims?.relay || {};
        const inT = inPoolCodes.has(it.code);
        const inH = herdCodeSet.has(it.code);
        const renderBar = (label, val, maxVal, color) => {
          const wPct = Math.max(0, Math.min(100, (Number(val || 0) / maxVal) * 100));
          return (
            <div key={label} style={{ marginBottom: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '2px' }}>
                <span style={{ color: 'var(--sub)' }}>{label}</span>
                <b style={{ fontFamily: 'monospace', color }}>{val ?? 0} / {maxVal}</b>
              </div>
              <div style={{ height: '6px', background: '#e2e8f0', borderRadius: '99px', overflow: 'hidden' }}>
                <div style={{ width: `${wPct}%`, height: '100%', background: color, borderRadius: '99px' }} />
              </div>
            </div>
          );
        };
        return (
          <div
            onClick={() => setStrongDetailItem(null)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              background: 'rgba(15, 23, 42, 0.55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '16px',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--surface)',
                borderRadius: '12px',
                border: '1px solid var(--line)',
                maxWidth: '640px',
                width: '100%',
                maxHeight: '88vh',
                overflowY: 'auto',
                padding: '16px 20px',
                boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', borderBottom: '1px solid var(--line)', paddingBottom: '10px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '18px', fontWeight: 800 }}>{it.name}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{it.code}</span>
                  <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4', fontWeight: 700 }}>{it.hybk}</span>
                  {it.statTag && <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569' }}>[{it.statTag}]</span>}
                </div>
                <button type="button" className="mini" onClick={() => setStrongDetailItem(null)} style={{ fontSize: '12px' }}>✕ 关闭</button>
              </div>

              <div style={{ marginBottom: '10px' }}><TagBadges tags={it.tags} /></div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                <div style={{ padding: '10px 12px', borderRadius: '8px', background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <b style={{ color: '#1d4ed8', fontSize: '13px' }}>👑 身份分（它是谁）</b>
                    <span style={{ fontSize: '18px', fontWeight: 900, color: '#1d4ed8', fontFamily: 'monospace' }}>{it.identityScore ?? 0}</span>
                  </div>
                  {renderBar('连板高度', idDims.height, 35, '#1d4ed8')}
                  {renderBar('多板记忆/抱团', idDims.memory, 20, '#2563eb')}
                  {renderBar('板块涨停效应', idDims.sector, 20, '#3b82f6')}
                  {renderBar(`人气/量能 (含玄学+${idDims.mysticBonus || 0})`, idDims.popularity, 25, '#6366f1')}
                </div>

                <div style={{ padding: '10px 12px', borderRadius: '8px', background: '#fff1f2', border: '1px solid #fecdd3' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <b style={{ color: '#be123c', fontSize: '13px' }}>⚡ 接力分（能否接力）</b>
                    <span style={{ fontSize: '18px', fontWeight: 900, color: '#be123c', fontFamily: 'monospace' }}>{it.relayScore ?? 0}</span>
                  </div>
                  {renderBar('首封抢筹速度', rlDims.firstSeal, 24, '#be123c')}
                  {renderBar('封板/均线承接质量', rlDims.sealQuality, 24, '#e11d48')}
                  {renderBar('筹码换手可交易性', rlDims.tradability, 20, '#f43f5e')}
                  {renderBar('总阀周期交互适配', rlDims.cycle, 18, '#fb7185')}
                  {renderBar('日内主动强度', rlDims.strength, 14, '#fda4af')}
                </div>
              </div>

              {(it.mysticRoots?.length > 0 || it.isMysticResonant) && (
                <div style={{ fontSize: '12px', padding: '7px 10px', borderRadius: '6px', background: '#faf5ff', border: '1px solid #d8b4fe', color: '#6d28d9', marginBottom: '10px' }}>
                  🔮 <b>玄学字根共振：</b>命中字根「{it.mysticRoots?.join('、') || it.mysticCluster}」
                  {it.isMysticResonant ? ` · 今日主板「${it.mysticCluster}」已有 ${it.mysticZtCount} 家封板形成字辈暗线共振` : ' · 单标待扩散'}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '6px', fontSize: '11.5px', padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', marginBottom: '10px' }}>
                <div>现价：<b style={{ color: it.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>¥{f2(it.price)} ({it.chg >= 0 ? '+' : ''}{it.chg.toFixed(2)}%)</b></div>
                <div>成交额：<b>{money$(it.amount)}</b></div>
                <div>换手率：<b>{Number(it.turnover || 0).toFixed(1)}%</b></div>
                <div>首封/炸板：<b>{it.isLimitUp ? `${it.fbt || '—'} / ${it.zbc || 0}炸` : '未封板'}</b></div>
                <div>封单额：<b>{it.isLimitUp ? (it.fund >= 1e7 ? money$(it.fund) : '弱封') : '—'}</b></div>
                <div>MA5/峰回撤：<b>{it.vsMa5 != null ? `${it.vsMa5 >= 0 ? '+' : ''}${it.vsMa5.toFixed(1)}% / ${it.ddFromPeak?.toFixed(1)}%` : '—'}</b></div>
              </div>

              {it.cycleAdvice && (
                <div style={{ fontSize: '12px', padding: '8px 10px', borderRadius: '6px', background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', marginBottom: '12px' }}>
                  🧭 <b>当前周期操作策略：</b>{it.cycleAdvice}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                <a href={`#/diagnosis?code=${it.code}`} className="mini" style={{ textDecoration: 'none', padding: '4px 10px' }}>
                  🩺 打开全景诊股
                </a>
                {!inH && (
                  <button type="button" className="mini" disabled={readOnlyHistory || herdBusyCode === it.code} onClick={() => onHerdAction('add', it)} style={{ color: '#6d28d9', borderColor: '#c4b5fd', background: '#faf5ff' }}>
                    📌 加入抱团跟踪
                  </button>
                )}
                {!inT && (
                  <button type="button" className="mini primary" onClick={() => onAddSingle(it.code, it.name)}>
                    ＋ 选入做T决策台
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
