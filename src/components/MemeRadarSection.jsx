import React, { useState, useEffect, useMemo } from 'react';
import { f2, pct, copyPlain, toast, toastOk, toastErr } from '../services/utils.js';
import { fetchMemeRadar, diagnoseStockMeme } from '../services/api.js';

export default function MemeRadarSection() {
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

  const handleQuickDiagnose = (stockName) => {
    setSearchQuery(stockName);
    setDiagLoading(true);
    diagnoseStockMeme(stockName)
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>
      {/* 顶部横幅 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)',
          borderRadius: '12px',
          padding: '20px 24px',
          color: '#ffffff',
          boxShadow: '0 8px 24px rgba(49, 46, 129, 0.25)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <span style={{ fontSize: '24px' }}>🔮</span>
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800, letterSpacing: '0.5px' }}>
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
          <div style={{ fontSize: '13px', color: '#c7d2fe', lineHeight: 1.5, maxWidth: '750px' }}>
            在 A 股没有绝对产业逻辑时，资金必退守到“阻力最小的极简共识”。从东方系、日出东方、阳字辈到生肖龙蛇，
            本雷达全天候穿透全市场 5,000+ 标的，量化宗族红盘率、涨停合力与空间盘眼，用共振捕捉超额收益，用纪律斩断假共振诱多！
          </div>
        </div>

        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          style={{
            padding: '8px 16px',
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: '8px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'all 0.2s',
          }}
        >
          <span>{loading ? '🔄 扫描中...' : '⚡ 刷新全市场雷达'}</span>
        </button>
      </div>

      {/* 个股玄学与共振体检仪搜索框 */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: '10px',
          padding: '16px 20px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <span style={{ fontSize: '16px' }}>🔍</span>
          <b style={{ fontSize: '14px', color: 'var(--text)' }}>
            个股玄学血统与共振体检仪（输入任意自选/持仓标的）
          </b>
        </div>
        <form onSubmit={handleDiagnose} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入股票代码或名称，如：阳光照明、东方海洋、华锡有色、001201..."
            style={{
              flex: '1 1 280px',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--line)',
              fontSize: '13px',
              background: 'var(--bg)',
              color: 'var(--text)',
            }}
          />
          <button
            type="submit"
            disabled={diagLoading}
            style={{
              padding: '8px 20px',
              background: 'var(--brand)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
            }}
          >
            {diagLoading ? '诊断中...' : '🧬 一键验血统与共振'}
          </button>
        </form>

        {/* 诊断结果展开卡片 */}
        {diagResult && diagResult.ok && (
          <div
            style={{
              marginTop: '14px',
              padding: '14px 16px',
              borderRadius: '8px',
              background:
                diagResult.verdict.type === 'LONE_WOLF'
                  ? '#fff1f0'
                  : diagResult.verdict.type === 'FLAGSHIP_LEADER'
                  ? '#fefce8'
                  : diagResult.verdict.type === 'AMBUSH_OPPORTUNITY'
                  ? '#f0fdf4'
                  : 'var(--bg)',
              border: `1px solid ${
                diagResult.verdict.type === 'LONE_WOLF'
                  ? '#fca5a5'
                  : diagResult.verdict.type === 'FLAGSHIP_LEADER'
                  ? '#fde047'
                  : diagResult.verdict.type === 'AMBUSH_OPPORTUNITY'
                  ? '#86efac'
                  : 'var(--line)'
              }`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text)' }}>
                {diagResult.stock.name} ({diagResult.stock.raw})
                <span
                  style={{
                    marginLeft: '10px',
                    fontSize: '13px',
                    fontWeight: 700,
                    color: diagResult.stock.chgPct >= 0 ? 'var(--up)' : 'var(--down)',
                  }}
                >
                  现价 ¥{f2(diagResult.stock.price)} ({diagResult.stock.chgPct >= 0 ? '+' : ''}
                  {f2(diagResult.stock.chgPct)}%)
                </span>
              </div>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background:
                    diagResult.verdict.type === 'LONE_WOLF'
                      ? '#cf1322'
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

            {/* 匹配到的宗族血统 */}
            {diagResult.matchedClans && diagResult.matchedClans.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' }}>
                {diagResult.matchedClans.map((c) => (
                  <div
                    key={c.clanKey}
                    style={{
                      fontSize: '11.5px',
                      padding: '4px 10px',
                      borderRadius: '5px',
                      background: 'rgba(255,255,255,0.7)',
                      border: '1px solid var(--line)',
                    }}
                  >
                    <b>{c.icon} {c.clanName}</b>: 全族 {c.totalBrothers} 只 ｜ 红盘 {c.risingBrothers} 只 ｜ 涨停 {c.limitUpBrothers} 只 ｜ 龙头 <b>{c.leader?.name}</b> (+{f2(c.leader?.chgPct)}%)
                  </div>
                ))}
              </div>
            )}

            {/* SOP 战术建议 */}
            <div style={{ fontSize: '12.5px', color: 'var(--text)', lineHeight: 1.5, marginTop: '8px' }}>
              <b>💡 实战交易SOP处方：</b>
              {diagResult.verdict.sop}
            </div>
          </div>
        )}
      </div>

      {/* 核心双栏区域：左侧 14 宗族天梯榜，右侧选定宗族深度作战室 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1.4fr)', gap: '16px' }}>
        {/* 左栏：宗族共振天梯榜 */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
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
            <div style={{ padding: '20px', color: 'var(--warn)', fontSize: '12px' }}>
              ⚠️ {error}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '680px', overflowY: 'auto' }}>
              {(data?.clans || []).map((clan, idx) => {
                const isActive = clan.key === activeClanKey;
                return (
                  <div
                    key={clan.key}
                    onClick={() => setActiveClanKey(clan.key)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: isActive ? '2px solid var(--brand)' : '1px solid var(--line)',
                      background: isActive ? 'rgba(79, 70, 229, 0.05)' : 'var(--bg)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 800, color: idx < 3 ? '#cf1322' : 'var(--sub)' }}>
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
                              ? '#fee2e2'
                              : clan.statusTag === 'WARM'
                              ? '#dcfce7'
                              : clan.statusTag === 'LONE_LEADER'
                              ? '#fef3c7'
                              : 'var(--surface)',
                          color:
                            clan.statusTag === 'BOOM'
                              ? '#b91c1c'
                              : clan.statusTag === 'WARM'
                              ? '#15803d'
                              : clan.statusTag === 'LONE_LEADER'
                              ? '#b45309'
                              : 'var(--sub)',
                          border: '1px solid rgba(0,0,0,0.06)',
                        }}
                      >
                        {clan.status}
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--sub)' }}>
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

        {/* 右栏：选定宗族深度作战室（空间盘眼 + 低位蓄势潜伏） */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {activeClan ? (
            <>
              {/* 宗族头部信息 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '22px' }}>{activeClan.icon}</span>
                    <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: 'var(--text)' }}>
                      【{activeClan.name}】战情中枢
                    </h3>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        background: 'var(--brand)',
                        color: '#fff',
                        fontWeight: 600,
                      }}
                    >
                      热度分: {activeClan.heatScore}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--sub)', lineHeight: 1.4 }}>
                    {activeClan.desc}
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: '12px' }}>
                  <div style={{ color: 'var(--sub)' }}>全族总成交额</div>
                  <b style={{ fontSize: '15px', color: 'var(--text)' }}>{activeClan.totalAmountYi} 亿元</b>
                </div>
              </div>

              {/* 核心指标卡片条 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>总成员</div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>{activeClan.total} 只</div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>红盘比例</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--up)' }}>{activeClan.upRatio}%</div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>涨停家数</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: activeClan.limitUps > 0 ? '#cf1322' : 'inherit' }}>
                    {activeClan.limitUps} 家
                  </div>
                </div>
                <div style={{ padding: '8px', borderRadius: '6px', background: 'var(--bg)', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>平均涨幅</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: activeClan.avgChg >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {activeClan.avgChg >= 0 ? '+' : ''}{activeClan.avgChg}%
                  </div>
                </div>
              </div>

              {/* 宗族共振状态诊断提示 */}
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background:
                    activeClan.statusTag === 'BOOM'
                      ? '#fff1f0'
                      : activeClan.statusTag === 'WARM'
                      ? '#f0fdf4'
                      : activeClan.statusTag === 'LONE_LEADER'
                      ? '#fffbe6'
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

              {/* 空间盘眼 / 领涨大哥展示 */}
              <div style={{ marginTop: '2px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                  👑 空间盘眼 · 领涨带头大哥
                </div>
                {activeClan.leader ? (
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      background: 'linear-gradient(90deg, #fef3c7 0%, var(--surface) 100%)',
                      border: '1px solid #fde047',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <b style={{ fontSize: '15px', color: '#854d0e' }}>{activeClan.leader.name}</b>
                        <span style={{ fontSize: '12px', color: 'var(--sub)' }}>({activeClan.leader.raw})</span>
                        <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: '#d97706', color: '#fff' }}>
                          空间标杆
                        </span>
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '4px' }}>
                        换手率: {activeClan.leader.turnover}% ｜ 现价: ¥{f2(activeClan.leader.price)}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--up)' }}>
                        +{f2(activeClan.leader.chgPct)}%
                      </div>
                      <button
                        type="button"
                        onClick={() => handleQuickDiagnose(activeClan.leader.name)}
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          border: '1px solid #d97706',
                          background: '#fff',
                          color: '#d97706',
                          cursor: 'pointer',
                          marginTop: '4px',
                        }}
                      >
                        体检此大哥
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--sub)', padding: '10px' }}>暂无领涨个股</div>
                )}
              </div>

              {/* 🎯 低位蓄势潜伏小弟（精选做T与低吸标的） */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>
                    🎯 同宗低位蓄势小弟（未大幅透支 · 盈亏比优选）
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--sub)' }}>
                    涨幅 -3% ~ +5.5% ｜ 适合做T与低吸潜伏
                  </span>
                </div>

                {activeClan.ambushCandidates && activeClan.ambushCandidates.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeClan.ambushCandidates.map((c) => (
                      <div
                        key={c.code}
                        style={{
                          padding: '8px 12px',
                          borderRadius: '6px',
                          background: 'var(--bg)',
                          border: '1px solid var(--line)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: '12px',
                        }}
                      >
                        <div>
                          <b style={{ color: 'var(--text)', marginRight: '6px' }}>{c.name}</b>
                          <span style={{ color: 'var(--sub)', marginRight: '10px' }}>({c.raw})</span>
                          <span style={{ color: 'var(--sub)' }}>
                            换手: {c.turnover}% ｜ 量比: {c.volRatio}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span
                            style={{
                              fontWeight: 700,
                              color: c.chgPct >= 0 ? 'var(--up)' : 'var(--down)',
                            }}
                          >
                            ¥{f2(c.price)} ({c.chgPct >= 0 ? '+' : ''}{f2(c.chgPct)}%)
                          </span>
                          <button
                            type="button"
                            onClick={() => handleQuickDiagnose(c.name)}
                            style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--line)',
                              background: 'var(--surface)',
                              color: 'var(--text)',
                              fontSize: '11px',
                              cursor: 'pointer',
                            }}
                          >
                            体检共振
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--sub)', padding: '10px', textAlign: 'center' }}>
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
