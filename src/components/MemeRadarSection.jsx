'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { f2, toast, toastErr } from '../services/utils.js';
import { fetchMemeRadar, diagnoseStockMeme } from '../services/api.js';
import { BoardStockActions } from './board/boardShared.jsx';

export default function MemeRadarSection({
  inPoolCodes,
  trackedCodeSet,
  trackBusyCode = '',
  onTrackAction,
  onJumpTracked,
  onAddInPlace,
  onSelectStock,
}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // 个股体检搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null);

  // 选中的宗族展开详情
  const [activeClanKey, setActiveClanKey] = useState(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemeRadar();
      if (res && res.ok) {
        setData(res);
        if (res.clans && res.clans.length > 0 && !activeClanKey) {
          setActiveClanKey(res.clans[0].key);
        }
      } else {
        throw new Error(res?.message || '获取数据失败');
      }
    } catch (err) {
      setError(err.message || '加载玄学字辈雷达失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleDiagnose = async (e) => {
    if (e) e.preventDefault();
    const q = searchQuery.trim();
    if (!q) {
      toast('请输入股票代码或名称进行体检');
      return;
    }
    setDiagLoading(true);
    try {
      const res = await diagnoseStockMeme(q);
      if (res && res.ok) {
        setDiagResult(res);
      } else {
        toastErr(res?.message || '未找到该股票数据');
      }
    } catch (err) {
      toastErr(err.message || '诊断失败');
    } finally {
      setDiagLoading(false);
    }
  };

  const handleQuickDiagnose = (stockNameOrCode) => {
    setSearchQuery(stockNameOrCode);
    setDiagLoading(true);
    diagnoseStockMeme(stockNameOrCode)
      .then((res) => {
        if (res && res.ok) setDiagResult(res);
        else toastErr(res?.message || '诊断失败');
      })
      .catch((err) => toastErr(err.message))
      .finally(() => setDiagLoading(false));
  };

  const activeClan = useMemo(() => {
    if (!data?.clans || !activeClanKey) return null;
    return data.clans.find((c) => c.key === activeClanKey) || data.clans[0];
  }, [data, activeClanKey]);

  // 过滤出除空间盘眼外的其他领涨前排先锋，彻底消除前排个股在 UI 中漏展示的问题
  const vanguardStocks = useMemo(() => {
    if (!activeClan?.topStocks) return [];
    const leaderRaw = String(activeClan.leader?.raw || activeClan.leader?.code || '').padStart(6, '0');
    return activeClan.topStocks.filter(
      (s) => String(s.raw || s.code || '').replace(/\D/g, '').padStart(6, '0') !== leaderRaw
    );
  }, [activeClan]);

  const toCode6 = (st) => {
    const raw = String(st?.raw || st?.code || '').replace(/\D/g, '');
    return raw.padStart(6, '0');
  };

  const handleAddMemeStock = (st, clanLabel = '字辈共振') => {
    if (!onAddInPlace || !st) return;
    const c6 = toCode6(st);
    const px = +(st.price || 0);
    onAddInPlace(c6, {
      tier: 'short',
      strategyTag: '字辈',
      strategy: 'ignition',
      refPrice: px,
      stopPrice: px > 0 ? Number((px * 0.955).toFixed(2)) : 0,
      targetPrice: px > 0 ? Number((px * 1.05).toFixed(2)) : 0,
      targetPrice2: px > 0 ? Number((px * 1.1).toFixed(2)) : 0,
      advice: `【${clanLabel}】跟随空间盘眼强度做分时均线低吸与冲高倒T，警惕孤狼诱多`,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0' }}>
      {/* 顶部横幅 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)',
          borderRadius: '12px',
          padding: '16px 20px',
          color: '#ffffff',
          boxShadow: '0 8px 24px rgba(49, 46, 129, 0.22)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '5px' }}>
            <span style={{ fontSize: '22px' }}>🔮</span>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '0.3px' }}>
              A股情绪模因与玄学字辈共振雷达
            </h2>
            <span
              style={{
                fontSize: '11px',
                background: 'rgba(255,255,255,0.2)',
                padding: '2px 8px',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.3)',
              }}
            >
              实战真共振 · 杜绝孤狼自嗨
            </span>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--info-b)', lineHeight: 1.5, maxWidth: '780px' }}>
            穿透全市场 5,000+ 标的，量化 14 大字辈门派红盘率、涨停合力、空间盘眼、领涨前排与低位蓄势标的，所有个股均支持原位加入自选与在轨跟踪。
          </div>
        </div>

        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          style={{
            padding: '7px 15px',
            background: 'rgba(255,255,255,0.16)',
            border: '1px solid rgba(255,255,255,0.32)',
            borderRadius: '8px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '12.5px',
            fontWeight: 700,
          }}
        >
          {loading ? '🔄 扫描中...' : '⚡ 刷新全市场雷达'}
        </button>
      </div>

      {/* 个股玄学与共振体检仪搜索框 */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: '10px',
          padding: '14px 16px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '9px' }}>
          <span style={{ fontSize: '15px' }}>🔍</span>
          <b style={{ fontSize: '13.5px', color: 'var(--text)' }}>
            个股玄学血统与共振体检仪（输入任意自选/持仓标的）
          </b>
        </div>
        <form onSubmit={handleDiagnose} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="meme-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入代码或名称，如：阳光照明、东方海洋、华锡有色、001201..."
          />
          <button
            type="submit"
            disabled={diagLoading}
            style={{
              padding: '8px 18px',
              background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
              color: '#fff',
              border: '1px solid #3730a3',
              borderRadius: '7px',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '13px',
              whiteSpace: 'nowrap',
            }}
          >
            {diagLoading ? '诊断中...' : '🧬 一键验血统与共振'}
          </button>
          {diagResult && (
            <button
              type="button"
              className="mini"
              onClick={() => setDiagResult(null)}
              style={{ marginLeft: 0 }}
            >
              ✕ 收起
            </button>
          )}
        </form>

        {/* 诊断结果展开卡片 */}
        {diagResult && diagResult.ok && (
          <div
            style={{
              marginTop: '12px',
              padding: '12px 14px',
              borderRadius: '8px',
              background:
                diagResult.verdict.type === 'LONE_WOLF'
                  ? 'var(--up-bg)'
                  : diagResult.verdict.type === 'FLAGSHIP_LEADER'
                  ? '#fefce8'
                  : diagResult.verdict.type === 'AMBUSH_OPPORTUNITY'
                  ? 'var(--down-bg)'
                  : 'var(--bg)',
              border: `1px solid ${
                diagResult.verdict.type === 'LONE_WOLF'
                  ? 'var(--up-b)'
                  : diagResult.verdict.type === 'FLAGSHIP_LEADER'
                  ? '#fde047'
                  : diagResult.verdict.type === 'AMBUSH_OPPORTUNITY'
                  ? 'var(--down-b)'
                  : 'var(--line)'
              }`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text)' }}>
                  {diagResult.stock.name} ({diagResult.stock.raw})
                </span>
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    color: diagResult.stock.chgPct >= 0 ? 'var(--up)' : 'var(--down)',
                  }}
                >
                  ¥{f2(diagResult.stock.price)} ({diagResult.stock.chgPct >= 0 ? '+' : ''}
                  {f2(diagResult.stock.chgPct)}%)
                </span>
                <span
                  style={{
                    fontSize: '11.5px',
                    fontWeight: 700,
                    padding: '2px 9px',
                    borderRadius: '999px',
                    background:
                      diagResult.verdict.type === 'LONE_WOLF'
                        ? 'var(--up)'
                        : diagResult.verdict.type === 'FLAGSHIP_LEADER'
                        ? '#d97706'
                        : diagResult.verdict.type === 'AMBUSH_OPPORTUNITY'
                        ? '#16a34a'
                        : 'var(--sub)',
                    color: '#fff',
                  }}
                >
                  {diagResult.verdict.title}
                </span>
              </div>

              <BoardStockActions
                stock={{
                  code: toCode6(diagResult.stock),
                  name: diagResult.stock.name,
                  price: diagResult.stock.price,
                }}
                inPoolCodes={inPoolCodes}
                herdCodeSet={trackedCodeSet}
                herdBusyCode={trackBusyCode}
                onHerdAction={
                  onTrackAction
                    ? (act, st) =>
                        onTrackAction(act, st, {
                          hybk: diagResult.matchedClans?.[0]?.clanName || '字辈共振',
                          verdict: diagResult.verdict?.title || '字辈体检跟踪',
                          price: diagResult.stock.price,
                        })
                    : undefined
                }
                onJumpHerd={onJumpTracked}
                onAddSingle={() =>
                  handleAddMemeStock(
                    diagResult.stock,
                    diagResult.matchedClans?.[0]?.clanName || '字辈共振'
                  )
                }
                onSelectStock={onSelectStock}
                allowAllBoardsTrack
                trackTitle="加入在轨跟踪池"
                trackedTitle="已在在轨跟踪池，点击查看SOP"
                compact
              />
            </div>

            {diagResult.matchedClans && diagResult.matchedClans.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' }}>
                {diagResult.matchedClans.map((c) => (
                  <div
                    key={c.clanKey}
                    style={{
                      fontSize: '11.5px',
                      padding: '4px 10px',
                      borderRadius: '5px',
                      background: 'var(--card)',
                      border: '1px solid var(--line)',
                    }}
                  >
                    <b>
                      {c.icon} {c.clanName}
                    </b>
                    : 全族 {c.totalBrothers} 只 ｜ 红盘 {c.risingBrothers} 只 ｜ 涨停{' '}
                    {c.limitUpBrothers} 只 ｜ 龙头 <b>{c.leader?.name}</b> (+
                    {f2(c.leader?.chgPct)}%)
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: '12px', color: 'var(--text)', lineHeight: 1.5, marginTop: '6px' }}>
              <b>💡 实战交易SOP处方：</b>
              {diagResult.verdict.sop}
            </div>
          </div>
        )}
      </div>

      {/* 手机窄屏快捷门派横滑选择器 */}
      {data?.clans && data.clans.length > 0 && (
        <div className="meme-mobile-clan-pills">
          {data.clans.map((clan, idx) => {
            const isActive = clan.key === activeClan?.key;
            return (
              <button
                key={clan.key}
                type="button"
                className={`meme-clan-pill ${isActive ? 'active' : ''}`}
                onClick={() => setActiveClanKey(clan.key)}
              >
                <span>
                  #{idx + 1} {clan.icon} {clan.name}
                </span>
                <span className="cnt">{clan.limitUps}板</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 核心双栏区域：左侧 14 宗族天梯榜，右侧选定宗族深度作战室 */}
      <div className="meme-main-grid">
        {/* 左栏：宗族共振天梯榜 */}
        <div className="meme-clan-list-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>
              🏆 全市场玄学宗族热度排行榜
            </div>
            <span style={{ fontSize: '11px', color: 'var(--sub)' }}>
              共 {data?.clans?.length || 0} 大字辈门派
            </span>
          </div>

          {loading && !data ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--sub)' }}>
              🔄 正在全市场 5,000+ 标的中扫描字辈共振...
            </div>
          ) : error ? (
            <div style={{ padding: '20px', color: 'var(--warn)', fontSize: '12px' }}>⚠️ {error}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '680px', overflowY: 'auto' }}>
              {(data?.clans || []).map((clan, idx) => {
                const isActive = clan.key === activeClan?.key;
                return (
                  <div
                    key={clan.key}
                    onClick={() => setActiveClanKey(clan.key)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: isActive ? '2px solid #4f46e5' : '1px solid var(--line)',
                      background: isActive ? 'rgba(79, 70, 229, 0.06)' : 'var(--bg)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            fontSize: '12px',
                            fontWeight: 800,
                            color: idx < 3 ? 'var(--up)' : 'var(--sub)',
                          }}
                        >
                          #{idx + 1}
                        </span>
                        <span style={{ fontSize: '15px' }}>{clan.icon}</span>
                        <b style={{ fontSize: '13.5px', color: 'var(--text)' }}>{clan.name}</b>
                        <span style={{ fontSize: '11px', color: 'var(--sub)' }}>({clan.total}只)</span>
                      </div>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background:
                            clan.statusTag === 'BOOM'
                              ? 'var(--up-bg)'
                              : clan.statusTag === 'WARM'
                              ? 'var(--down-bg)'
                              : clan.statusTag === 'LONE_LEADER'
                              ? 'var(--warn-bg)'
                              : 'var(--surface)',
                          color:
                            clan.statusTag === 'BOOM'
                              ? 'var(--up-d)'
                              : clan.statusTag === 'WARM'
                              ? 'var(--down-d)'
                              : clan.statusTag === 'LONE_LEADER'
                              ? 'var(--warn-d)'
                              : 'var(--sub)',
                          border: '1px solid rgba(0,0,0,0.06)',
                        }}
                      >
                        {clan.status}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '4px',
                        fontSize: '11.5px',
                        color: 'var(--sub)',
                      }}
                    >
                      <span>
                        涨停 <b>{clan.limitUps}</b> 只 ｜ 红盘率{' '}
                        <b style={{ color: clan.upRatio >= 30 ? 'var(--up)' : 'inherit' }}>
                          {clan.upRatio}%
                        </b>
                      </span>
                      <span>
                        龙头:{' '}
                        {clan.leader ? (
                          <b style={{ color: 'var(--up)' }}>
                            {clan.leader.name} (+{f2(clan.leader.chgPct)}%)
                          </b>
                        ) : (
                          '暂无'
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右栏：选定宗族深度作战室（空间盘眼 + 领涨前排 + 低位蓄势潜伏） */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            minWidth: 0,
          }}
        >
          {activeClan ? (
            <>
              {/* 宗族头部信息 */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
                    <span style={{ fontSize: '21px' }}>{activeClan.icon}</span>
                    <h3 style={{ margin: 0, fontSize: '16.5px', fontWeight: 800, color: 'var(--text)' }}>
                      【{activeClan.name}】战情中枢
                    </h3>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        background: '#4f46e5',
                        color: '#fff',
                        fontWeight: 700,
                      }}
                    >
                      热度分 {activeClan.heatScore}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--sub)', lineHeight: 1.4 }}>
                    {activeClan.desc}
                  </div>
                </div>

                <div style={{ fontSize: '12px' }}>
                  <div style={{ color: 'var(--sub)' }}>全族总成交额</div>
                  <b style={{ fontSize: '15px', color: 'var(--text)', fontFamily: 'monospace' }}>
                    {activeClan.totalAmountYi} 亿元
                  </b>
                </div>
              </div>

              {/* 核心指标卡片条 */}
              <div className="meme-kpi-grid">
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>总成员</div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>{activeClan.total} 只</div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>红盘比例</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--up)' }}>
                    {activeClan.upRatio}%
                  </div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>涨停家数</div>
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 700,
                      color: activeClan.limitUps > 0 ? 'var(--up)' : 'inherit',
                    }}
                  >
                    {activeClan.limitUps} 家
                  </div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>平均涨幅</div>
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 700,
                      color: activeClan.avgChg >= 0 ? 'var(--up)' : 'var(--down)',
                    }}
                  >
                    {activeClan.avgChg >= 0 ? '+' : ''}
                    {activeClan.avgChg}%
                  </div>
                </div>
              </div>

              {/* 宗族共振状态诊断提示 */}
              <div
                style={{
                  padding: '9px 12px',
                  borderRadius: '6px',
                  background:
                    activeClan.statusTag === 'BOOM'
                      ? 'var(--up-bg)'
                      : activeClan.statusTag === 'WARM'
                      ? 'var(--down-bg)'
                      : activeClan.statusTag === 'LONE_LEADER'
                      ? 'var(--warn-bg)'
                      : 'var(--bg)',
                  border: '1px solid var(--line)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  color: 'var(--text)',
                }}
              >
                <b>📌 宗族合力诊断：</b>
                {activeClan.statusDesc}
              </div>

              {/* 1. 空间盘眼 / 领涨大哥展示 */}
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                  👑 空间盘眼 · 领涨带头大哥
                </div>
                {activeClan.leader ? (
                  <div
                    style={{
                      padding: '11px 13px',
                      borderRadius: '8px',
                      background: 'var(--warn-bg)',
                      border: '1px solid #fde047',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '10px',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                        <b style={{ fontSize: '15px', color: 'var(--warn-d)' }}>{activeClan.leader.name}</b>
                        <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--sub)' }}>
                          {toCode6(activeClan.leader)}
                        </span>
                        <span
                          style={{
                            fontSize: '10.5px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: '#d97706',
                            color: '#fff',
                            fontWeight: 700,
                          }}
                        >
                          空间标杆
                        </span>
                        <span
                          style={{
                            fontSize: '14px',
                            fontWeight: 800,
                            fontFamily: 'monospace',
                            color: 'var(--up)',
                          }}
                        >
                          ¥{f2(activeClan.leader.price)} (+{f2(activeClan.leader.chgPct)}%)
                        </span>
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '3px' }}>
                        换手率: {activeClan.leader.turnover}% ｜ 量比: {activeClan.leader.volRatio ?? '—'}
                      </div>
                    </div>

                    <BoardStockActions
                      stock={{
                        code: toCode6(activeClan.leader),
                        name: activeClan.leader.name,
                        price: activeClan.leader.price,
                      }}
                      inPoolCodes={inPoolCodes}
                      herdCodeSet={trackedCodeSet}
                      herdBusyCode={trackBusyCode}
                      onHerdAction={
                        onTrackAction
                          ? (act, st) =>
                              onTrackAction(act, st, {
                                hybk: activeClan.name,
                                verdict: `${activeClan.name}·空间盘眼`,
                                price: activeClan.leader.price,
                              })
                          : undefined
                      }
                      onJumpHerd={onJumpTracked}
                      onAddSingle={() =>
                        handleAddMemeStock(activeClan.leader, `${activeClan.name}·空间盘眼`)
                      }
                      onSelectStock={onSelectStock}
                      allowAllBoardsTrack
                      trackTitle="加入在轨跟踪池"
                      trackedTitle="已在在轨跟踪池，点击查看SOP"
                      compact
                      extraActions={
                        <button
                          type="button"
                          className="board-act-btn score"
                          onClick={() => handleQuickDiagnose(activeClan.leader.name)}
                          title="检验此大哥的跨门派共振血统"
                        >
                          🧬验共振
                        </button>
                      }
                    />
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--sub)', padding: '10px' }}>暂无领涨个股</div>
                )}
              </div>

              {/* 2. 族内领涨前排先锋（展示 topStocks，补全此前缺失的涨停/大涨梯队成员） */}
              {vanguardStocks.length > 0 && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '6px',
                      marginBottom: '6px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>
                      🔥 族内领涨前排先锋（共 {vanguardStocks.length} 只）
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      强势助攻梯队 · 观察梯队封板与助攻力度
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {vanguardStocks.map((v) => {
                      const c6 = toCode6(v);
                      return (
                        <div key={c6} className="meme-stock-row is-vanguard">
                          <div className="msr-left">
                            <b style={{ color: 'var(--text)' }}>{v.name}</b>
                            <span style={{ fontFamily: 'monospace', color: 'var(--mute)', fontSize: '11.5px' }}>
                              {c6}
                            </span>
                            <span style={{ color: 'var(--sub)', fontSize: '11px' }}>
                              换手 {v.turnover}%{v.volRatio ? ` · 量比 ${v.volRatio}` : ''}
                            </span>
                          </div>
                          <div className="msr-right">
                            <span
                              style={{
                                fontWeight: 800,
                                fontFamily: 'monospace',
                                color: v.chgPct >= 0 ? 'var(--up)' : 'var(--down)',
                              }}
                            >
                              ¥{f2(v.price)} ({v.chgPct >= 0 ? '+' : ''}
                              {f2(v.chgPct)}%)
                            </span>
                            <BoardStockActions
                              stock={{ code: c6, name: v.name, price: v.price }}
                              inPoolCodes={inPoolCodes}
                              herdCodeSet={trackedCodeSet}
                              herdBusyCode={trackBusyCode}
                              onHerdAction={
                                onTrackAction
                                  ? (act, st) =>
                                      onTrackAction(act, st, {
                                        hybk: activeClan.name,
                                        verdict: `${activeClan.name}·领涨前排`,
                                        price: v.price,
                                      })
                                  : undefined
                              }
                              onJumpHerd={onJumpTracked}
                              onAddSingle={() => handleAddMemeStock(v, `${activeClan.name}·领涨先锋`)}
                              onSelectStock={onSelectStock}
                              allowAllBoardsTrack
                              trackTitle="加入在轨跟踪池"
                              trackedTitle="已在在轨跟踪池，点击查看SOP"
                              compact
                              extraActions={
                                <button
                                  type="button"
                                  className="board-act-btn score"
                                  onClick={() => handleQuickDiagnose(v.name)}
                                  title="体检共振血统"
                                >
                                  🧬
                                </button>
                              }
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 3. 低位蓄势潜伏小弟（精选做T与低吸标的） */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '6px',
                    marginBottom: '6px',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>
                    🎯 同宗低位蓄势小弟（未大幅透支 · 盈亏比优选）
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--sub)' }}>
                    涨幅 -3% ~ +5.5% ｜ 适合做T与低吸潜伏
                  </span>
                </div>

                {activeClan.ambushCandidates && activeClan.ambushCandidates.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeClan.ambushCandidates.map((c) => {
                      const c6 = toCode6(c);
                      return (
                        <div key={c6} className="meme-stock-row">
                          <div className="msr-left">
                            <b style={{ color: 'var(--text)' }}>{c.name}</b>
                            <span style={{ fontFamily: 'monospace', color: 'var(--mute)', fontSize: '11.5px' }}>
                              {c6}
                            </span>
                            <span style={{ color: 'var(--sub)', fontSize: '11px' }}>
                              换手 {c.turnover}% · 量比 {c.volRatio}
                            </span>
                          </div>

                          <div className="msr-right">
                            <span
                              style={{
                                fontWeight: 700,
                                fontFamily: 'monospace',
                                color: c.chgPct >= 0 ? 'var(--up)' : 'var(--down)',
                              }}
                            >
                              ¥{f2(c.price)} ({c.chgPct >= 0 ? '+' : ''}
                              {f2(c.chgPct)}%)
                            </span>
                            <BoardStockActions
                              stock={{ code: c6, name: c.name, price: c.price }}
                              inPoolCodes={inPoolCodes}
                              herdCodeSet={trackedCodeSet}
                              herdBusyCode={trackBusyCode}
                              onHerdAction={
                                onTrackAction
                                  ? (act, st) =>
                                      onTrackAction(act, st, {
                                        hybk: activeClan.name,
                                        verdict: `${activeClan.name}·低位潜伏`,
                                        price: c.price,
                                      })
                                  : undefined
                              }
                              onJumpHerd={onJumpTracked}
                              onAddSingle={() => handleAddMemeStock(c, `${activeClan.name}·低位蓄势`)}
                              onSelectStock={onSelectStock}
                              allowAllBoardsTrack
                              trackTitle="加入在轨跟踪池"
                              trackedTitle="已在在轨跟踪池，点击查看SOP"
                              compact
                              extraActions={
                                <button
                                  type="button"
                                  className="board-act-btn score"
                                  onClick={() => handleQuickDiagnose(c.name)}
                                  title="体检共振血统"
                                >
                                  🧬
                                </button>
                              }
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: '12px',
                      color: 'var(--sub)',
                      padding: '10px',
                      textAlign: 'center',
                      background: 'var(--bg)',
                      borderRadius: '6px',
                    }}
                  >
                    该宗族目前无涨幅适中的蓄势标的（可能已全员普涨或全员下杀）
                  </div>
                )}
              </div>

              {/* 七哥共振心法指南 */}
              <div
                style={{
                  marginTop: 'auto',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  background: 'rgba(79, 70, 229, 0.04)',
                  border: '1px dashed rgba(79, 70, 229, 0.3)',
                  fontSize: '11.5px',
                  lineHeight: 1.6,
                  color: 'var(--sub)',
                }}
              >
                <b>📜 七哥玄学共振心法铁律：</b>
                <br />
                1. <b>不买一字缩量顶</b>：空间龙头必须经过健康放量换手，分歧换手才是真实认可；
                <br />
                2. <b>警惕孤狼一日游</b>：同字辈无兄弟跟风，个股独自拉升多为主力诱多自嗨，切忌追高；
                <br />
                3. <b>初动是暴利，高潮是风险</b>：共振在起点与中段是最佳上车点，全网狂欢高潮末期往往是最后一棒。
              </div>
            </>
          ) : (
            <div style={{ padding: '60px', textAlign: 'center', color: 'var(--sub)' }}>
              请在左侧选择一个玄学宗族查看详细作战情报
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
