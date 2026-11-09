import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { AUCTION_TIERS, getAuctionStatusInfo, getAuctionTier } from '../services/auction.js';
import { fetchQuotes } from '../services/api.js';
import { f2 } from '../services/utils.js';

export default function SelectionSection({
  wbLatest,
  pool,
  onAddStock,
  onBatchAdd,
  onOpenReason,
  onRefresh,
  onSelfTest,
  onJumpPerf,
  dbStatus
}) {
  const [onlyRed, setOnlyRed] = useState(true);
  const [manualInput, setManualInput] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [auctionViewTab, setAuctionViewTab] = useState('live'); // 'live' (今日实况) | 'tiers' (五档胜率表)
  const [candQuotes, setCandQuotes] = useState({});
  const [candLoading, setCandLoading] = useState(false);
  const [quotesUpdatedTime, setQuotesUpdatedTime] = useState('');

  const D = wbLatest || (typeof window !== 'undefined' ? window.WB_LATEST : null);
  const inPoolCodes = new Set((pool || []).map(s => String(s.code).padStart(6, '0')));

  const short = D ? (D.candidates || []) : [];
  const steady = D ? (D.steady || []) : [];
  const redShort = short.filter(r => r.verdict === '可做');
  // 当今日无「可做」(如大盘弱势门禁拦截)时，自动展示精选候选（小做/观察），避免整块区域空置
  const displayShort = (onlyRed && redShort.length > 0) ? redShort : short;

  const dateStr = D ? (D.tradeDate || (D.generatedAt ? D.generatedAt.slice(0, 10) : '今日')) : '今日';
  const genTimeStr = D && D.generatedAt ? new Date(D.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const inCnt = short.concat(steady).filter(r => inPoolCodes.has(String(r.code).padStart(6, '0'))).length;
  const aucStatus = getAuctionStatusInfo();

  // 提取选股池所有候选股代码用于拉取实时行情与竞价开盘价
  const candCodes = useMemo(() => {
    if (!D) return [];
    const set = new Set();
    (D.candidates || []).forEach(c => {
      const code6 = String(c.code).padStart(6, '0');
      const tc = c.tcode || (code6.startsWith('6') ? 'sh' : 'sz') + code6;
      set.add(tc);
    });
    (D.steady || []).forEach(c => {
      const code6 = String(c.code).padStart(6, '0');
      const tc = c.tcode || (code6.startsWith('6') ? 'sh' : 'sz') + code6;
      set.add(tc);
    });
    return Array.from(set);
  }, [D]);

  // 从腾讯接口实时拉取所有候选股的最新开盘价、昨收价与现价
  const refreshCandQuotes = useCallback(async () => {
    if (!candCodes.length) return;
    try {
      setCandLoading(true);
      const q = await fetchQuotes(candCodes);
      if (q && Object.keys(q).length) {
        setCandQuotes(prev => ({ ...prev, ...q }));
        const now = new Date();
        setQuotesUpdatedTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`);
      }
    } catch (e) {
      console.warn('[CandQuotes error]', e);
    } finally {
      setCandLoading(false);
    }
  }, [candCodes]);

  useEffect(() => {
    refreshCandQuotes();
    const timer = setInterval(refreshCandQuotes, 30000); // 30秒盘中轮询同步竞价与行情
    return () => clearInterval(timer);
  }, [refreshCandQuotes]);

  // 计算单只候选股票的真实竞价与行情数据
  const getCandData = useCallback((r) => {
    const code6 = String(r.code).padStart(6, '0');
    const tc = r.tcode || (code6.startsWith('6') ? 'sh' : 'sz') + code6;
    const q = candQuotes[tc] || candQuotes[code6];

    const liveOpen = (q && q.open > 0) ? q.open : (r.open > 0 ? r.open : null);
    const livePrev = (q && q.prevClose > 0) ? q.prevClose : (r.prevClose > 0 ? r.prevClose : (r.price || null));
    const livePx = (q && q.price > 0) ? q.price : (r.price || null);

    let gap = null;
    if (liveOpen && livePrev) {
      gap = ((liveOpen - livePrev) / livePrev) * 100;
    } else if (r.retOpen != null) {
      gap = +r.retOpen;
    }

    const tier = gap != null ? getAuctionTier(gap) : null;
    const chg = (livePx && livePrev) ? ((livePx - livePrev) / livePrev) * 100 : null;

    return {
      code6,
      tc,
      liveOpen,
      livePrev,
      livePx,
      gap,
      tier,
      chg,
      isLive: !!(q && q.open > 0)
    };
  }, [candQuotes]);

  // 构建全部短线候选股的今日竞价实况排序清单
  const liveAuctionList = useMemo(() => {
    return short.map(r => {
      const data = getCandData(r);
      return {
        ...r,
        ...data
      };
    }).sort((a, b) => {
      const gapA = a.gap != null ? a.gap : -999;
      const gapB = b.gap != null ? b.gap : -999;
      return gapB - gapA;
    });
  }, [short, getCandData]);

  const handleManualAdd = () => {
    const q = manualInput.trim();
    if (!q) return;
    onAddStock(q);
    setManualInput('');
  };

  const handleManualRefreshAll = () => {
    refreshCandQuotes();
    if (onRefresh) onRefresh(false);
  };

  if (!D) {
    return (
      <section id="secSelection">
        <details className="fold" open id="secSelectionFold">
          <summary style={{ fontSize: '15px', fontWeight: 700, cursor: 'pointer', padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>一、选股池与自选股</span>
          </summary>
          <div className="fold-bd" style={{ paddingTop: '12px' }}>
            <div className="sel-empty">正在读取选股契约数据 data/latest.json...</div>
          </div>
        </details>
      </section>
    );
  }

  const env = D.env || {};
  const lvl = { OK: 'ok', WARN: 'warn', BAD: 'bad' }[env.level] || 'warn';
  const lvlText = { OK: '环境放行', WARN: '环境减半', BAD: '环境否决', UNKNOWN: '环境未知' }[env.level] || '环境放行';

  const renderChip = (r) => {
    const data = getCandData(r);
    const have = inPoolCodes.has(data.code6);
    const vCls = r.verdict === '可做' ? 'c-can' : r.verdict === '小做' ? 'c-small' : 'c-watch';
    const rTier = data.tier;
    const rGap = data.gap;

    return (
      <div
        key={data.code6}
        className={`sel-chip ${vCls} ${have ? 'in-pool' : ''}`}
        onClick={() => onOpenReason(r, have)}
        title={`点击查看入选理由与量化支撑\n${data.isLive ? `【今日09:25实时竞价定盘】\n开盘价: ¥${f2(data.liveOpen)}  昨收: ¥${f2(data.livePrev)}\n跳空幅度: ${rGap >= 0 ? '+' : ''}${rGap.toFixed(2)}% (${rTier?.tag})\n冲高预期: +${rTier?.space}%  +2%触及率: ${rTier?.hit2}%` : '点击查看详情'}`}
      >
        <span className="sc-name">{r.name}</span>
        <span className="sc-code">{data.code6}</span>
        <span className="sc-score">{r.score || 80}分</span>
        <span className="sc-vd">{r.verdict || '观察'}</span>
        {rTier && (
          <span
            className="sc-auc"
            style={{
              fontSize: '10.5px',
              padding: '1px 5px',
              borderRadius: '4px',
              background: rTier.bg,
              color: rTier.color,
              border: '1px solid',
              borderColor: rTier.color,
              fontWeight: 700
            }}
          >
            竞价{rGap >= 0 ? '+' : ''}{rGap.toFixed(1)}%
          </span>
        )}
        {have && <span className="sc-in">已在池</span>}
      </div>
    );
  };

  return (
    <section id="secSelection">
      <details className="fold" open id="secSelectionFold">
        <summary style={{ fontSize: '15px', fontWeight: 700, cursor: 'pointer', padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>一、选股池与自选股</span>
          <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>（点击可折叠/展开，便于全屏专注单只做T）</span>
        </summary>
        <div className="fold-bd" style={{ paddingTop: '12px' }}>
          <div className="sel-box" id="selBox">
            <div className="sel-top">
              <span className={`sel-env ${lvl}`}>{lvlText}</span>
              <span>短线候选 <b>{displayShort.length}</b> 只{onlyRed && redShort.length ? `（已锁定精选 ${displayShort.length} 只红标可做）` : `（可做 ${redShort.length} / 小做 ${short.filter(x => x.verdict === '小做').length} / 观察 ${short.filter(x => x.verdict === '观察').length}）`}</span>
              <span>·</span>
              <span>稳健底仓 <b>{steady.length}</b> 只</span>
              <span className="sel-date">契约基准：{dateStr} {genTimeStr}</span>
              {quotesUpdatedTime && (
                <span style={{ fontSize: '11px', color: 'var(--info)', background: 'var(--info-bg)', padding: '1px 6px', borderRadius: '4px' }}>
                  ⚡ 竞价实时同步中 ({quotesUpdatedTime})
                </span>
              )}
              <span className="sel-inpool">
                已进决策台 <b>{inCnt}</b> 只
              </span>

              {/* 仅看红标切换开关 */}
              <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={onlyRed}
                  onChange={e => setOnlyRed(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontWeight: onlyRed ? 700 : 400, color: onlyRed ? 'var(--up)' : 'var(--sub)' }}>
                  仅显示可做(红标) {redShort.length > 0 ? `(${redShort.length})` : '(今日0只)'}
                </span>
              </label>
            </div>

            {/* 短线候选芯片群 */}
            <div className="sel-group-title">
              <span>🎯 短线做T候选（精选突破与量价配合）</span>
              <span style={{ fontSize: '11.5px', color: 'var(--mute)' }}>展示今日 09:25 实时集合竞价定盘跳空幅度与档位</span>
            </div>
            <div className="sel-chips" id="selChipsShort">
              {displayShort.length > 0 ? (
                displayShort.map(r => renderChip(r))
              ) : onlyRed && short.length > 0 ? (
                <div style={{
                  padding: '12px 14px',
                  background: 'var(--surface2)',
                  border: '1px dashed var(--line)',
                  borderRadius: '8px',
                  fontSize: '12.5px',
                  color: 'var(--sub)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%'
                }}>
                  <span style={{ fontSize: '15px' }}>💡</span>
                  <div>
                    今日大盘弱势门禁生效，暂无 ≥80 分「红标可做」股票。
                    系统已精选 <b>{short.length}</b> 只候选标的（含 {short.filter(x => x.verdict === '小做').length} 只「小做」与 {short.filter(x => x.verdict === '观察').length} 只「观察」）。
                  </div>
                  <button
                    type="button"
                    className="mini"
                    style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
                    onClick={() => setOnlyRed(false)}
                  >
                    取消筛选，查看全部 ({short.length}只)
                  </button>
                </div>
              ) : (
                <div style={{
                  padding: '12px 14px',
                  background: env.level === 'BAD' ? '#fff1f0' : 'var(--surface2)',
                  border: env.level === 'BAD' ? '1px solid #ffa39e' : '1px dashed var(--line)',
                  borderRadius: '8px',
                  fontSize: '12.5px',
                  color: env.level === 'BAD' ? '#cf1322' : 'var(--mute)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%'
                }}>
                  <span style={{ fontSize: '15px' }}>{env.level === 'BAD' ? '🛡️' : 'ℹ️'}</span>
                  <div>
                    {env.level === 'BAD' ? (
                      <>
                        <b>系统风控否决（BAD）：</b>{env.text || '上证与中证1000同时跌破均线，系统性下行，禁止新开正T。'}
                        <span style={{ display: 'block', fontSize: '11.5px', color: '#820014', marginTop: '2px' }}>
                          量化风控门禁已拦截所有激进做T开仓标的以保护本金。可切换关注稳健底仓或台账复盘。
                        </span>
                      </>
                    ) : (
                      '暂无符合条件的短线候选股票'
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 稳健底仓芯片群 */}
            <div className="sel-group-title" style={{ marginTop: '10px' }}>
              <span>🛡️ 稳健底仓候选（高股息·大市值·低波动）</span>
            </div>
            <div className="sel-chips" id="selChipsSteady">
              {steady.length > 0 ? (
                steady.map(r => renderChip(r))
              ) : (
                <div style={{ color: 'var(--mute)', padding: '10px 0', fontSize: '12.5px' }}>
                  暂无稳健底仓候选
                </div>
              )}
            </div>

            <div className="sel-actions">
              <button
                className="mini primary"
                onClick={() => onBatchAdd(displayShort, '短线')}
                title="将当前显示的短线候选股一键全部加入今日做T决策台"
              >
                + 一键全选短线候选 ({displayShort.length}只)
              </button>
              <button
                className="mini"
                onClick={() => onBatchAdd(steady, '稳健')}
                title="将所有稳健底仓候选一键全部加入今日做T决策台"
              >
                + 一键全选稳健底仓 ({steady.length}只)
              </button>
              <a
                href="#/perf"
                onClick={(e) => { e.preventDefault(); onJumpPerf(); }}
                className="sel-jump-perf"
                style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
              >
                📊 查看历史选股做T收益战绩与回测 →
              </a>
            </div>

            <div className="sel-tip">
              💡 <b>点击任意候选卡片</b> 可查看详尽入选理由、量价逻辑与重大利空排查并一键并入自选。<br />
              加入自选后系统将统一启动毫秒级分时监控、七格箱体计算与日内高抛低吸提醒。
            </div>
          </div>

          {/* 开盘前集合竞价弱参考看板（含今日候选定盘实况一览与五档大数据） */}
          <details className="fold" style={{ marginTop: '12px', background: 'var(--surface2)', borderRadius: '8px', border: '1px solid var(--line)' }}>
            <summary style={{ padding: '8px 12px', cursor: 'pointer', fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>⏰ 开盘前集合竞价弱参考（09:25~09:30 定盘五档与胜率大数据）</span>
                {candLoading && <span style={{ fontSize: '11px', color: 'var(--mute)' }}>（正在拉取实时竞价…）</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {quotesUpdatedTime && (
                  <span className="tag" style={{ background: '#eef2ff', color: 'var(--info)', fontSize: '11px', fontWeight: 600 }}>
                    定盘同步: {quotesUpdatedTime}
                  </span>
                )}
                <span className="tag" style={{ background: '#fff', fontSize: '11px', color: 'var(--text)' }}>{aucStatus.label}</span>
              </div>
            </summary>
            <div className="fold-bd" style={{ padding: '10px 14px 14px', fontSize: '12px' }}>
              <div style={{ marginBottom: '10px', color: 'var(--sub)', lineHeight: 1.6 }}>
                <b>战法定位（基于213条大样本实测）：</b>竞价强弱不改变“能否摸到 +1%”（五档触及率均稳定在 78%~80%），但直接决定了<b>“冲高空间多大”</b>与<b>“冲高后回撤多惨”</b>。09:25 集合竞价定盘后，对照下表校准挂单预期与止盈止损策略：
              </div>

              {/* 看板内子 Tab 切换：今日实况 vs 五档大数据 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <button
                  type="button"
                  className={`mini ${auctionViewTab === 'live' ? 'primary' : ''}`}
                  onClick={() => setAuctionViewTab('live')}
                  style={{ fontSize: '12px', padding: '3px 10px' }}
                >
                  📊 今日候选股定盘实况榜 ({liveAuctionList.length}只)
                </button>
                <button
                  type="button"
                  className={`mini ${auctionViewTab === 'tiers' ? 'primary' : ''}`}
                  onClick={() => setAuctionViewTab('tiers')}
                  style={{ fontSize: '12px', padding: '3px 10px' }}
                >
                  📈 五档胜率历史大数据参照表
                </button>
                <button
                  type="button"
                  className="mini"
                  onClick={refreshCandQuotes}
                  style={{ marginLeft: 'auto', fontSize: '11.5px', padding: '2px 8px' }}
                  title="重新拉取腾讯接口最新的开盘与竞价数据"
                >
                  ↻ 立即刷新竞价
                </button>
              </div>

              {/* 视图1：今日候选股竞价定盘实况一览表 */}
              {auctionViewTab === 'live' && (
                <div className="tbl-scroll" style={{ maxHeight: '220px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface)', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>股票标的</th>
                        <th style={{ padding: '6px 8px' }}>09:25开盘价</th>
                        <th style={{ padding: '6px 8px' }}>昨日收盘</th>
                        <th style={{ padding: '6px 8px' }}>竞价跳空幅度</th>
                        <th style={{ padding: '6px 8px' }}>所属竞价档位</th>
                        <th style={{ padding: '6px 8px' }}>平均冲高预期</th>
                        <th style={{ padding: '6px 8px' }}>+2% 触及率</th>
                        <th style={{ padding: '6px 8px' }}>做T操作指引</th>
                        <th style={{ padding: '6px 8px', textAlign: 'center' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveAuctionList.map(st => {
                        const inPool = inPoolCodes.has(st.code6);
                        const t = st.tier;
                        const gapVal = st.gap;
                        const gapColor = gapVal > 0 ? 'var(--up)' : gapVal < 0 ? 'var(--down)' : 'inherit';

                        return (
                          <tr key={st.code6} style={{ borderBottom: '1px solid var(--line)' }}>
                            <td style={{ padding: '5px 8px', fontWeight: 700 }}>
                              {st.name} <span style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontWeight: 400, color: 'var(--mute)' }}>{st.code6}</span>
                            </td>
                            <td style={{ padding: '5px 8px', fontFamily: 'ui-monospace,Consolas,monospace' }}>
                              {st.liveOpen ? `¥${f2(st.liveOpen)}` : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', fontFamily: 'ui-monospace,Consolas,monospace', color: 'var(--sub)' }}>
                              {st.livePrev ? `¥${f2(st.livePrev)}` : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', fontWeight: 700, color: gapColor, fontFamily: 'ui-monospace,Consolas,monospace' }}>
                              {gapVal != null ? `${gapVal >= 0 ? '+' : ''}${gapVal.toFixed(2)}%` : '—'}
                            </td>
                            <td style={{ padding: '5px 8px' }}>
                              {t ? (
                                <span className="tag" style={{ color: t.color, borderColor: t.color, background: t.bg, fontWeight: 700, padding: '1px 6px', fontSize: '11px' }}>
                                  {t.tag}
                                </span>
                              ) : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', color: 'var(--accent)', fontWeight: 700 }}>
                              {t ? `+${t.space}%` : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', fontWeight: 700, color: (t && t.hit2 >= 70) ? 'var(--down)' : 'inherit' }}>
                              {t ? `${t.hit2}%` : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', color: 'var(--sub)', fontSize: '11.5px' }}>
                              {t ? t.advice : '等待竞价撮合数据'}
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                              {inPool ? (
                                <span style={{ color: 'var(--info)', fontSize: '11px', fontWeight: 600 }}>已在池</span>
                              ) : (
                                <button
                                  className="mini"
                                  onClick={() => onAddStock(st.code6)}
                                  style={{ padding: '2px 6px', fontSize: '11px' }}
                                  title="选入今日做T决策台"
                                >
                                  + 选入
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 视图2：五档胜率历史大数据表 */}
              {auctionViewTab === 'tiers' && (
                <div className="tbl-scroll" style={{ maxHeight: '190px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface)', textAlign: 'left' }}>
                        <th style={{ padding: '5px 8px' }}>竞价跳空档位</th>
                        <th style={{ padding: '5px 8px' }}>属性标签</th>
                        <th style={{ padding: '5px 8px' }}>平均冲高空间</th>
                        <th style={{ padding: '5px 8px' }}>+1% 触及率</th>
                        <th style={{ padding: '5px 8px' }}>+2% 触及率</th>
                        <th style={{ padding: '5px 8px' }}>冲高后回撤</th>
                        <th style={{ padding: '5px 8px' }}>开盘做T纪律指引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {AUCTION_TIERS.map(t => (
                        <tr key={t.key}>
                          <td style={{ fontWeight: 700 }}>{t.label}</td>
                          <td>
                            <span className="tag" style={{ color: t.color, borderColor: t.color, background: t.bg, fontWeight: 700, padding: '1px 6px', fontSize: '11px' }}>
                              {t.tag}
                            </span>
                          </td>
                          <td style={{ color: 'var(--accent)', fontWeight: 700 }}>+{t.space}%</td>
                          <td>{t.hit1}%</td>
                          <td style={{ fontWeight: 700, color: t.hit2 >= 70 ? 'var(--down)' : 'inherit' }}>{t.hit2}%</td>
                          <td style={{ color: 'var(--warn-d)' }}>−{t.give}%</td>
                          <td style={{ color: 'var(--sub)' }}>{t.advice}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>

          <div className="sel-sep">手动添加 / 刷新行情</div>

          <div className="db-row">
            <input
              id="dbInput"
              placeholder="输入 A股 代码或名称 —— 605128 / 上海沿浦 / shyp（拼音首字母也行）"
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleManualAdd(); }}
              autoComplete="off"
            />
            <button className="primary" onClick={handleManualAdd}>＋ 添加</button>
            <button onClick={handleManualRefreshAll}>⟳ 刷新全部行情</button>
            <button onClick={onSelfTest}>🩺 网络自检</button>
            <label className="db-sw">
              <input
                type="checkbox"
                id="dbAuto"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
              />
              交易时段每分钟自动刷新
            </label>
          </div>

          {dbStatus && (
            <div id="dbStatus" className="db-status" style={{ display: 'block', marginTop: '6px' }}>
              {dbStatus}
            </div>
          )}

          <div id="dbCands"></div>

          {/* 图表能力折叠 */}
          <details className="fold" style={{ marginTop: '12px' }}>
            <summary style={{ padding: '8px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '12.5px', color: 'var(--sub)' }}>
              ▶ 图表能力 —— 每只股票卡片内置的图表能力 (点击展开)
            </summary>
            <div className="fold-bd" style={{ padding: '10px 14px', fontSize: '12px', color: 'var(--sub)' }}>
              <ul>
                <li>多周期K线支持：分时 / 日K / 周K / 月K / 15分钟 / 5分钟。</li>
                <li>均线系统：MA5、MA10、MA20、MA60。</li>
                <li>辅助指标：BOLL (布林带)、七格箱体、成本线、MACD、RSI、KDJ。</li>
                <li>筹码与量能：分时量能状态判定、成交量背离检测、大单逐笔统计。</li>
              </ul>
            </div>
          </details>
        </div>
      </details>
    </section>
  );
}
