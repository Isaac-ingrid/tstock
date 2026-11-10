'use client';

import React, { useState, useEffect, useRef } from 'react';
import { f2, money$, toastWarn } from '../../services/utils.js';
import { searchTencent } from '../../services/api.js';
import { TagBadges } from './boardShared.jsx';

export default function HerdPoolPanel({
  displayItems,
  herdPool,
  evictedPool,
  herdHealthFilter,
  setHerdHealthFilter,
  herdSectors,
  selectedTheme,
  setSelectedTheme,
  herdBusyCode,
  onHerdAction,
  inPoolCodes,
  onAddSingle,
  readOnlyHistory = false,
}) {
  const [herdQuery, setHerdQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDocDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setShowSuggest(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  useEffect(() => {
    const q = herdQuery.trim();
    const m6 = q.match(/^(?:sh|sz|bj)?(\d{6})$/i);
    if (!q || m6) {
      setSuggestions([]);
      setShowSuggest(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchTencent(q);
        if (!cancelled) {
          setSuggestions((res || []).slice(0, 8));
          setShowSuggest((res || []).length > 0);
        }
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setShowSuggest(false);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [herdQuery]);

  const pickCandidate = async (cand) => {
    const c = String(cand?.code || '').padStart(6, '0');
    if (!(c.startsWith('00') || c.startsWith('60'))) {
      toastWarn(`${cand?.name || c} 非00/60主板标的，抱团跟踪池暂不支持加入创业板/科创板`);
      return;
    }
    setShowSuggest(false);
    setHerdQuery('');
    await onHerdAction('add', { code: c, name: cand.name || '', reason: '手动检索加入抱团跟踪' });
  };

  const handleManualAdd = async () => {
    if (readOnlyHistory) {
      toastWarn('当前处于历史复盘只读模式，请先切回今日实时看板后再增删抱团池');
      return;
    }
    const q = herdQuery.trim();
    if (!q) {
      toastWarn('请输入 00/60 主板股票代码、股票名称或拼音');
      return;
    }
    const m6 = q.match(/^(?:sh|sz|bj)?(\d{6})$/i);
    if (m6) {
      await pickCandidate({ code: m6[1], name: '' });
      return;
    }
    try {
      setSearching(true);
      const res = (await searchTencent(q)) || [];
      const mainOnly = res.filter(x => String(x.code).startsWith('00') || String(x.code).startsWith('60'));
      if (mainOnly.length === 0) {
        toastWarn(`未找到匹配「${q}」的00/60主板股票`);
        return;
      }
      const exact = mainOnly.find(x => String(x.name || '').toLowerCase() === q.toLowerCase());
      if (exact || mainOnly.length === 1) {
        await pickCandidate(exact || mainOnly[0]);
      } else {
        setSuggestions(res.slice(0, 8));
        setShowSuggest(true);
        toastWarn(`找到 ${mainOnly.length} 只相似主板股票，请在下拉框中点选`);
      }
    } catch {
      toastWarn('股票检索暂时不可用，请直接输入6位主板代码');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ padding: '10px 14px', background: '#f5f3ff', border: '1.5px solid #c4b5fd', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '12px', color: '#4c1d95', lineHeight: 1.55 }}>
          🤝 <b>全自动抱团跟踪引擎（严格剔除创业板30 & 科创板68）：</b>
          自动收录<b>近日连板高标</b>、<b>多板抱团妖股</b>及<b>人气Top30强势核</b>，跨日连续追踪。<b>今日未涨停只要稳在均线高横区间仍留在池内！</b>
          <br />
          <span style={{ color: '#6d28d9', fontSize: '11.5px' }}>
            🛡️ <b>宽松防误杀破位淘汰标准：</b>仅当触发「跌停(-9.5%) / 跌破20日生命线(-1.5%) / 入池后回撤≥20% / 连续2日失守10日线超-3% / 3日累跌≥15% / 5日破MA10且无人气」时自动移出；单日洗盘先挂黄牌观察，今日涨停或放量强修复(+5.5%站上MA5)自动豁免。
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {[
              { k: 'all', label: `全部跟踪 (${herdPool.length})` },
              { k: 'accelerating', label: '🔥 连板加速' },
              { k: 'healthy', label: '🟢 断板高横 / 趋势走强' },
              { k: 'warning', label: '🟡 洗盘黄牌观察' },
            ].map(st => (
              <button
                key={st.k}
                type="button"
                className={`mini ${herdHealthFilter === st.k ? 'primary' : ''}`}
                onClick={() => setHerdHealthFilter(st.k)}
                style={{ fontSize: '11.5px', fontWeight: herdHealthFilter === st.k ? 800 : 600 }}
              >
                {st.label}
              </button>
            ))}
          </div>

          <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="text"
              placeholder="输入00/60代码或股票名…"
              value={herdQuery}
              onFocus={() => { if (suggestions.length > 0) setShowSuggest(true); }}
              onChange={e => setHerdQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleManualAdd();
                } else if (e.key === 'Escape') {
                  setShowSuggest(false);
                }
              }}
              style={{ padding: '3px 8px', fontSize: '11.5px', borderRadius: '5px', border: '1px solid #c4b5fd', width: '175px', background: '#fff' }}
            />
            <button
              type="button"
              className="mini"
              disabled={readOnlyHistory || !herdQuery.trim() || searching || Boolean(herdBusyCode)}
              onClick={handleManualAdd}
              style={{ fontSize: '11.5px', background: '#6d28d9', color: '#fff', borderColor: '#6d28d9', fontWeight: 700 }}
            >
              {searching ? '匹配中…' : '＋ 加池锁定'}
            </button>

            {showSuggest && suggestions.length > 0 && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                width: '250px',
                zIndex: 90,
                background: 'var(--surface)',
                border: '1px solid #c4b5fd',
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
                overflow: 'hidden',
              }}>
                {suggestions.map((c, idx) => {
                  const okMain = String(c.code).startsWith('00') || String(c.code).startsWith('60');
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onMouseDown={e => {
                        e.preventDefault();
                        pickCandidate(c);
                      }}
                      style={{
                        width: '100%',
                        border: 'none',
                        borderBottom: idx === suggestions.length - 1 ? 'none' : '1px solid var(--line)',
                        padding: '6px 10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: '#fff',
                        cursor: okMain ? 'pointer' : 'not-allowed',
                        opacity: okMain ? 1 : 0.55,
                        fontSize: '12px',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>{c.name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', color: okMain ? '#6d28d9' : 'var(--mute)' }}>
                        {c.code} {!okMain && '(非主板)'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {herdSectors.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', paddingTop: '4px', borderTop: '1px dashed #ddd6fe' }}>
            <span style={{ fontSize: '11px', color: '#6d28d9', fontWeight: 700 }}>📂 按板块筛选：</span>
            <button
              type="button"
              className="mini"
              onClick={() => setSelectedTheme('all')}
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                fontWeight: selectedTheme === 'all' ? 800 : 600,
                background: selectedTheme === 'all' ? '#6d28d9' : '#fff',
                color: selectedTheme === 'all' ? '#fff' : '#334155',
                borderColor: selectedTheme === 'all' ? '#6d28d9' : '#cbd5e1',
              }}
            >
              全部板块
            </button>
            {herdSectors.slice(0, 12).map(sec => {
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
                    background: active ? '#6d28d9' : '#fff',
                    color: active ? '#fff' : '#334155',
                    borderColor: active ? '#6d28d9' : '#cbd5e1',
                  }}
                >
                  {sec.name} ({sec.count})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {displayItems.map(item => {
        const inT = inPoolCodes.has(item.code);
        return (
          <div
            key={item.code}
            style={{
              background: 'var(--surface)',
              border: `1.5px solid ${item.healthBorder || '#cbd5e1'}`,
              borderRadius: '10px',
              padding: '12px 16px',
              boxShadow: '0 2px 6px rgba(109, 40, 217, 0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '11.5px',
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: item.healthBg,
                    color: item.healthColor,
                    border: `1px solid ${item.healthBorder}`,
                  }}
                >
                  {item.healthLabel}
                </span>
                <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)' }}>{item.name}</span>
                <span style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--mute)' }}>{item.code}</span>
                <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f0f5ff', color: '#1d39c4' }}>
                  🔥 {item.hybk}
                </span>
                {item.isMysticResonant && item.mysticCluster && (
                  <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#f5f3ff', color: '#7c3aed', border: '1px solid #d8b4fe', fontWeight: 700 }}>
                    🔮 {item.mysticCluster}
                  </span>
                )}
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  已跟踪 <b>D{item.trackDays}</b>天 · 入池 {item.entryDate} (¥{f2(item.entryPrice)})
                </span>
                {item.pinned && (
                  <span style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '4px', background: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d', fontWeight: 700 }}>
                    🔒 已锁定防踢
                  </span>
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '15px', fontWeight: 800, color: item.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  ¥{f2(item.price)} ({item.chg >= 0 ? `+${item.chg.toFixed(2)}%` : `${item.chg.toFixed(2)}%`})
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'monospace', color: item.cumReturnPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  入池累计 {item.cumReturnPct >= 0 ? `+${item.cumReturnPct.toFixed(2)}%` : `${item.cumReturnPct.toFixed(2)}%`}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '8px' }}>
              <TagBadges tags={item.tags} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', padding: '6px 10px', background: 'var(--surface2)', borderRadius: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <div>偏离 MA5: <b style={{ fontFamily: 'monospace', color: item.vsMa5 >= 0 ? 'var(--up)' : '#d97706' }}>{item.vsMa5 >= 0 ? `+${item.vsMa5}%` : `${item.vsMa5}%`}</b></div>
              <div>偏离 MA10: <b style={{ fontFamily: 'monospace', color: item.vsMa10 >= 0 ? 'var(--up)' : '#d97706' }}>{item.vsMa10 >= 0 ? `+${item.vsMa10}%` : `${item.vsMa10}%`}</b></div>
              <div>偏离 MA20: <b style={{ fontFamily: 'monospace', color: item.vsMa20 >= 0 ? '#15803d' : '#cf1322' }}>{item.vsMa20 >= 0 ? `+${item.vsMa20}%` : `${item.vsMa20}%`}</b></div>
              <div>高点回撤: <b style={{ fontFamily: 'monospace', color: item.ddFromPeak <= -14 ? '#cf1322' : 'var(--text)' }}>{item.ddFromPeak}%</b> <span style={{ fontSize: '10.5px', color: 'var(--mute)' }}>(峰¥{f2(item.peakPrice)})</span></div>
              <div>成交额: <b style={{ fontFamily: 'monospace' }}>{money$(item.amount)}</b></div>
              <div>人气: <b style={{ color: item.popRank ? '#c2410c' : 'var(--mute)' }}>{item.popRank ? `#${item.popRank}` : '—'}</b></div>
            </div>

            <div style={{ padding: '6px 10px', borderRadius: '6px', background: item.healthBg, border: `1px dashed ${item.healthBorder}`, fontSize: '11.5px', color: '#334155', marginBottom: '8px' }}>
              <b>承接与破位边界评估：</b>{item.healthDesc} <span style={{ color: '#64748b' }}>（入池依据：{item.entryReason}）</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className="mini"
                  disabled={readOnlyHistory || herdBusyCode === item.code}
                  onClick={() => onHerdAction('pin', item)}
                  style={{ fontSize: '11px' }}
                >
                  {item.pinned ? '🔓 取消锁定' : '🔒 锁定免自动移出'}
                </button>
                <button
                  type="button"
                  className="mini"
                  disabled={readOnlyHistory || herdBusyCode === item.code}
                  onClick={() => onHerdAction('remove', { ...item, reason: '手动移出抱团池' })}
                  style={{ fontSize: '11px', color: '#cf1322', borderColor: '#ffa39e', background: '#fff1f0' }}
                >
                  🗑️ 移出池子
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <a href={`#/diagnosis?code=${item.code}`} className="mini" style={{ textDecoration: 'none', padding: '3px 8px' }}>
                  🩺 全景体检
                </a>
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

      {/* 破位自动 / 手动移出记录折叠区 */}
      <details style={{ marginTop: '6px', padding: '10px 14px', background: '#fafafa', border: '1px dashed #cbd5e1', borderRadius: '8px' }}>
        <summary style={{ cursor: 'pointer', fontSize: '12.5px', fontWeight: 700, color: '#475569', userSelect: 'none' }}>
          🗑️ 查看破位自动/手动移出记录 ({evictedPool.length} 只) —— 避免盲目抄底死猫跳
        </summary>
        {evictedPool.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '8px' }}>
            近期暂无触发破位红线被移出的抱团标的
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
            {evictedPool.map((ev, i) => (
              <div
                key={`${ev.code}_${i}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', padding: '6px 10px', background: '#fff', border: '1px solid #fee2e2', borderRadius: '6px', fontSize: '12px' }}
              >
                <div>
                  <b>{ev.name}</b> <span style={{ fontFamily: 'monospace', color: 'var(--mute)' }}>{ev.code}</span>
                  <span style={{ marginLeft: '8px', color: '#cf1322', fontWeight: 600 }}>踢出原因：{ev.reason}</span>
                  <div style={{ fontSize: '11px', color: 'var(--mute)' }}>
                    入池 {ev.entryDate} ¥{f2(ev.entryPrice)} → 移出 {ev.evictedDate} ¥{f2(ev.evictPrice)} ({ev.returnPct >= 0 ? `+${ev.returnPct}%` : `${ev.returnPct}%`})
                  </div>
                </div>
                <button
                  type="button"
                  className="mini"
                  disabled={readOnlyHistory || herdBusyCode === ev.code}
                  onClick={() => onHerdAction('restore', ev)}
                  style={{ fontSize: '11px', color: '#0958d9', borderColor: '#91caff', background: '#e6f4ff' }}
                >
                  ↩️ 恢复并锁定跟踪
                </button>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
