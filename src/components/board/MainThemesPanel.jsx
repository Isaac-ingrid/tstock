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
  onFilterThemeToStrong,
}) {
  const mo = mainThemes?.marketOverview || {};
  const themes = mainThemes?.themes || [];
  const roleProps = { inPoolCodes, herdCodeSet, herdBusyCode, onHerdAction, onAddSingle };

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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
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
            <span style={{ fontSize: '11px', color: '#7c3aed' }}>点击任意字辈切入强势池筛选</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
            {mysticClusters.map(cl => (
              <div
                key={cl.name}
                onClick={() => onFilterThemeToStrong(`字辈·${cl.name}`)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '8px',
                  background: '#fff',
                  border: '1px solid #e9d5ff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <b style={{ fontSize: '13px', color: '#6d28d9' }}>
                    {cl.name} {cl.isAuto && <span style={{ fontSize: '10px', color: '#9333ea', fontWeight: 500 }}>(自动字头)</span>}
                  </b>
                  <span style={{ fontSize: '11px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: '#f3e8ff', color: '#7c3aed' }}>
                    {cl.ztCount} 板 · 最高{cl.maxLbc}板
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--sub)', lineHeight: 1.45 }}>
                  {(cl.leaders || []).map(l => `${l.name}(${l.lbc}板·${l.hybk})`).join('、')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {themes.map((th, idx) => (
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: 'var(--sub)' }}>
              <span>主板涨停 <b>{th.ztCount}</b> 家 · 未板强势 <b>{th.qsCount}</b> 家</span>
              <button
                type="button"
                className="mini"
                onClick={() => onFilterThemeToStrong(th.name)}
                style={{ fontSize: '11px', color: '#0958d9', borderColor: '#91caff', background: '#e6f4ff' }}
              >
                🔍 看该方向强势股
              </button>
            </div>
          </div>

          <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginBottom: '10px' }}>
            📊 {th.themeReason}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px' }}>
            <CoreRoleBox roleLabel="👑 题材龙头" accent="#cf1322" bdColor="#fecaca" bgColor="#fffafa" stock={th.roles?.themeLeader} {...roleProps} />
            <CoreRoleBox roleLabel="🔥 阶段核心" accent="#7c3aed" bdColor="#ddd6fe" bgColor="#faf5ff" stock={th.roles?.phaseCore} {...roleProps} />
            <CoreRoleBox roleLabel="🐳 容量核心" accent="#1d4ed8" bdColor="#bfdbfe" bgColor="#eff6ff" stock={th.roles?.capacityCore} {...roleProps} />
          </div>
        </div>
      ))}
    </div>
  );
}
