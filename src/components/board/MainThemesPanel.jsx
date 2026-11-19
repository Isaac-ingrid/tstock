'use client';

import React from 'react';
import { CoreRoleBox } from './boardShared.jsx';

export default function MainThemesPanel({
  mainThemes,
  mysticClusters = [],
  inPoolCodes,
  herdCodeSet,
  herdBusyCode,
  onHerdAction,
  onAddSingle,
  onSelectStock,
  onJumpHerd,
  onFilterThemeToStrong,
  readOnlyHistory = false,
}) {
  const mo = mainThemes?.marketOverview || {};
  const themes = mainThemes?.themes || [];
  const roleProps = {
    inPoolCodes,
    herdCodeSet,
    herdBusyCode,
    onHerdAction,
    onAddSingle,
    onSelectStock,
    onJumpHerd,
    readOnlyHistory,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ padding: '10px 14px', background: 'linear-gradient(135deg, #faf5ff, #f0f9ff)', border: '1.5px solid #d8b4fe', borderRadius: '10px' }}>
        <div style={{ fontSize: '13.5px', fontWeight: 800, color: '#6b21a8', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
          <span>🧭 全市场动态主线与四大核心中枢（已严格剔除创业板30与科创板68）</span>
          <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#0369a1' }}>
            第一主线：{mo.topThemeName || '—'}
          </span>
        </div>
        <div style={{ fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
          💡 {mo.topThemeReason || '实时统计概念风口与涨停集群资金合力'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(248px, 1fr))', gap: '10px' }}>
          <CoreRoleBox roleLabel="👑 全场题材/连板总龙头" accent="#cf1322" bdColor="#ffa39e" bgColor="#fff" stock={mo.heightLeader} {...roleProps} />
          <CoreRoleBox roleLabel="🔥 全场阶段抱团核心" accent="#7c3aed" bdColor="#c4b5fd" bgColor="#fff" stock={mo.phaseCore} {...roleProps} />
          <CoreRoleBox roleLabel="🐳 全场流动性容量核心" accent="#1d4ed8" bdColor="#93c5fd" bgColor="#fff" stock={mo.capacityCore} {...roleProps} />
        </div>
      </div>

      {mysticClusters.length > 0 && (
        <div style={{ padding: '10px 14px', background: '#faf5ff', border: '1px solid #d8b4fe', borderRadius: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#6d28d9' }}>
              🔮 今日跨行业玄学 / 同音字辈共振暗线（独立于东财行业分类）
            </span>
            <span style={{ fontSize: '11px', color: '#7c3aed' }}>点击标题切入强势池 · 具体股支持一键跟踪与加自选</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
            {mysticClusters.map(cl => (
              <div
                key={cl.name}
                style={{
                  padding: '9px 11px',
                  borderRadius: '8px',
                  background: '#fff',
                  border: '1px solid #e9d5ff',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div
                  onClick={() => onFilterThemeToStrong(`字辈·${cl.name}`)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: '6px' }}
                >
                  <b style={{ fontSize: '13px', color: '#6d28d9' }}>
                    {cl.name} {cl.isAuto && <span style={{ fontSize: '10px', color: '#9333ea', fontWeight: 500 }}>(自动字头)</span>}
                  </b>
                  <span style={{ fontSize: '11px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: '#f3e8ff', color: '#7c3aed', whiteSpace: 'nowrap' }}>
                    {cl.ztCount} 板 · 最高{cl.maxLbc}板 →
                  </span>
                </div>

                {(cl.leaders && cl.leaders.length > 0) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {cl.leaders.map(st => {
                      const c6 = String(st.code || '').padStart(6, '0');
                      const inT = inPoolCodes?.has(c6);
                      const inH = herdCodeSet?.has(c6);
                      return (
                        <div
                          key={c6}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '6px',
                            padding: '4px 6px',
                            borderRadius: '6px',
                            background: '#faf5ff',
                            border: '1px solid #f3e8ff',
                            fontSize: '11.5px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', minWidth: 0 }}>
                            <b style={{ color: 'var(--text)' }}>{st.name}</b>
                            <span style={{ fontFamily: 'monospace', fontSize: '10.5px', color: 'var(--mute)' }}>{c6}</span>
                            <span style={{ fontSize: '10px', padding: '0 4px', borderRadius: '3px', background: '#fff1f0', color: '#cf1322', fontWeight: 700 }}>
                              {st.lbc}板
                            </span>
                            {st.hybk && (
                              <span style={{ fontSize: '10.5px', color: '#64748b' }}>{st.hybk}</span>
                            )}
                          </div>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                            <a href={`#/diagnosis?code=${c6}`} className="board-mini-pill-btn diag" title="全景诊股">🩺</a>
                            <button
                              type="button"
                              className={`board-mini-pill-btn ${inH ? 'tracked' : 'track'}`}
                              disabled={!inH && (readOnlyHistory || herdBusyCode === c6)}
                              onClick={() => (inH ? onJumpHerd && onJumpHerd() : onHerdAction('add', st))}
                            >
                              {inH ? '✓跟踪' : '📌跟踪'}
                            </button>
                            <button
                              type="button"
                              className={`board-mini-pill-btn ${inT ? 'in-pool' : 'add-pool'}`}
                              onClick={() => (inT ? onSelectStock && onSelectStock(c6) : onAddSingle(c6, st.name, st))}
                            >
                              {inT ? '✓自选' : '＋自选'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                    领涨：{cl.leader || '—'}（点击查看全部同字辈成分股）
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {themes.map((th, idx) => {
        const themeStocks = th.stocks || [];
        return (
          <div
            key={th.name}
            style={{
              background: 'var(--surface)',
              border: idx === 0 ? '1.5px solid #c084fc' : '1px solid var(--line)',
              borderRadius: '10px',
              padding: '12px 16px',
              boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', background: idx === 0 ? '#9333ea' : '#475569', color: '#fff' }}>
                  主线 #{idx + 1} · {th.sourceType}
                </span>
                <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)' }}>{th.name}</span>
                <span style={{ fontSize: '12px', fontFamily: 'monospace', fontWeight: 700, color: th.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {th.chg >= 0 ? `+${th.chg.toFixed(2)}%` : `${th.chg.toFixed(2)}%`}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--sub)' }}>
                <span>主板涨停 <b>{th.ztCount}</b> 家 · 未板强势 <b>{th.qsCount}</b> 家</span>
                <button
                  type="button"
                  className="mini"
                  onClick={() => onFilterThemeToStrong(th.name)}
                  style={{ marginLeft: 0, fontSize: '11px', color: '#0958d9', borderColor: '#91caff', background: '#e6f4ff' }}
                >
                  🔍 切入强共振筛选
                </button>
              </div>
            </div>

            <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginBottom: '10px' }}>
              📊 {th.themeReason}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
              <CoreRoleBox roleLabel="👑 题材龙头" accent="#cf1322" bdColor="#fecaca" bgColor="#fffafa" stock={th.roles?.themeLeader} {...roleProps} />
              <CoreRoleBox roleLabel="🔥 阶段核心" accent="#7c3aed" bdColor="#ddd6fe" bgColor="#faf5ff" stock={th.roles?.phaseCore} {...roleProps} />
              <CoreRoleBox roleLabel="🐳 容量核心" accent="#1d4ed8" bdColor="#bfdbfe" bgColor="#eff6ff" stock={th.roles?.capacityCore} {...roleProps} />
            </div>

            {themeStocks.length > 0 && (
              <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px dashed var(--line)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sub)' }}>
                  📋 该方向具体前排标的 ({themeStocks.length})：
                </span>
                {themeStocks.map(st => {
                  const c6 = String(st.code || '').padStart(6, '0');
                  const inT = inPoolCodes?.has(c6);
                  const inH = herdCodeSet?.has(c6);
                  const chgNum = Number(st.chg || 0);
                  return (
                    <span key={c6} className="board-inline-stock-pill">
                      <b>{st.name}</b>
                      <span className="code">{c6}</span>
                      <span className={`chg ${chgNum >= 0 ? 'up' : 'down'}`}>
                        {st.isLimitUp ? st.statTag || '涨停' : `${chgNum >= 0 ? '+' : ''}${chgNum.toFixed(1)}%`}
                      </span>
                      <button
                        type="button"
                        className={`board-mini-pill-btn ${inH ? 'tracked' : 'track'}`}
                        disabled={!inH && (readOnlyHistory || herdBusyCode === c6)}
                        onClick={() => (inH ? onJumpHerd && onJumpHerd() : onHerdAction('add', st))}
                        title={inH ? '已在抱团跟踪池' : '加入抱团跟踪池'}
                      >
                        {inH ? '✓跟踪' : '📌'}
                      </button>
                      <button
                        type="button"
                        className={`board-mini-pill-btn ${inT ? 'in-pool' : 'add-pool'}`}
                        onClick={() => (inT ? onSelectStock && onSelectStock(c6) : onAddSingle(c6, st.name, st))}
                        title={inT ? '点击去今日作战台查看' : '一键加入自选'}
                      >
                        {inT ? '✓已自选' : '＋自选'}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
