import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchBatchNoticeRisk, computeAuctionSignalLead } from '../services/api.js';
import { getAuctionTier } from '../services/auction.js';
import { f2 } from '../services/utils.js';
import {
  isAShareTradeDay,
  getCNClock,
  getUpcomingHolidayReminder,
  syncRemoteTradeCalendar,
} from '../services/calendar.js';

function isAuctionClockNow(ref = new Date()) {
  if (!isAShareTradeDay(ref)) return false;
  const { mins } = getCNClock(ref);
  return mins >= 555 && mins <= 575; // 交易日 09:15 - 09:35 自动展开竞价速览
}

export default function PreMarketPanel({
  pool = [],
  onSelectStock,
  onJumpDiagnosis,
  onNoticeRisksChange,
  referenceDate = null,
}) {
  const [clockNow, setClockNow] = useState(() => referenceDate || new Date());
  const [auctionWindow, setAuctionWindow] = useState(() => isAuctionClockNow(referenceDate || new Date()));
  const [expanded, setExpanded] = useState(() => isAuctionClockNow(referenceDate || new Date()));
  const [noticeLoading, setNoticeLoading] = useState(false);
  const [noticeData, setNoticeData] = useState(null);
  const [noticeErr, setNoticeErr] = useState('');
  const [calVer, setCalVer] = useState(0);

  useEffect(() => {
    syncRemoteTradeCalendar().then(() => setCalVer((v) => v + 1));
  }, []);

  // 每 30 秒刷新时钟（跨零点自动更新节假日倒计时，并在 09:15-09:35 自动展开竞价速览）
  useEffect(() => {
    if (referenceDate) {
      setClockNow(referenceDate);
      setAuctionWindow(isAuctionClockNow(referenceDate));
      return undefined;
    }
    const timer = setInterval(() => {
      const now = new Date();
      setClockNow(now);
      const inWin = isAuctionClockNow(now);
      setAuctionWindow((prev) => {
        if (!prev && inWin) setExpanded(true);
        return inWin;
      });
    }, 30000);
    return () => clearInterval(timer);
  }, [referenceDate]);

  // 近期法定节假日休市倒计时 & 连续≥3天长假前1-2交易日控仓预警
  const holidayReminder = useMemo(
    () => getUpcomingHolidayReminder(referenceDate || clockNow, { lookaheadTradeDays: 5 }),
    [referenceDate, clockNow, calVer]
  );

  const codesKey = useMemo(
    () =>
      (pool || [])
        .map((s) => String(s.code || '').padStart(6, '0'))
        .filter((c) => /^\d{6}$/.test(c))
        .sort()
        .join(','),
    [pool]
  );

  const loadNotices = useCallback(async () => {
    if (!codesKey) return;
    setNoticeLoading(true);
    setNoticeErr('');
    try {
      const res = await fetchBatchNoticeRisk(codesKey.split(','));
      if (res && res.ok) {
        setNoticeData(res);
        if (onNoticeRisksChange) onNoticeRisksChange(res.items || {});
      }
    } catch (err) {
      setNoticeErr(err?.message || '盘前公告排雷暂不可用');
    } finally {
      setNoticeLoading(false);
    }
  }, [codesKey, onNoticeRisksChange]);

  useEffect(() => {
    loadNotices();
  }, [loadNotices]);

  // 集合竞价速览行（持仓排前，融合 09:20 锁单未匹配抢筹与弱转强先导信号）
  const auctionRows = useMemo(() => {
    return (pool || [])
      .map((s) => {
        const code6 = String(s.code || '').padStart(6, '0');
        const pc = +s.prevClose || 0;
        const open = +s.open || +s.price || pc;
        const px = +s.price || pc;
        const gapPct = pc > 0 && open > 0 ? ((open - pc) / pc) * 100 : 0;
        const chgPct = pc > 0 && px > 0 ? ((px - pc) / pc) * 100 : 0;
        const tier = getAuctionTier(gapPct);
        const aucLead = computeAuctionSignalLead(s);
        const isHolding = (s.shares || 0) > 0;
        const nInfo = noticeData?.items?.[code6] || null;
        return {
          code6,
          name: s.name || code6,
          isHolding,
          shares: s.shares || 0,
          open,
          px,
          vr: +s.vr || 0,
          gapPct,
          chgPct,
          tier,
          aucLead,
          nInfo,
        };
      })
      .sort((a, b) => {
        if (a.isHolding !== b.isHolding) return a.isHolding ? -1 : 1;
        return Math.abs(b.gapPct) - Math.abs(a.gapPct);
      });
  }, [pool, noticeData]);

  // 高危 / 留意公告汇总
  const { redAlerts, yellowAlerts } = useMemo(() => {
    const reds = [];
    const yellows = [];
    const items = noticeData?.items || {};
    (pool || []).forEach((s) => {
      const code6 = String(s.code || '').padStart(6, '0');
      const info = items[code6];
      if (!info) return;
      if ((info.redFlags || []).length > 0) {
        reds.push({
          code6,
          name: s.name || code6,
          isHolding: (s.shares || 0) > 0,
          hasRecent3d: info.hasRecent3dAlert,
          flag: info.redFlags[0],
          count: info.redFlags.length,
        });
      } else if ((info.yellowAlerts || []).length > 0) {
        yellows.push({
          code6,
          name: s.name || code6,
          isHolding: (s.shares || 0) > 0,
          hasRecent3d: info.hasRecent3dAlert,
          flag: info.yellowAlerts[0],
          count: info.yellowAlerts.length,
        });
      }
    });
    return { redAlerts: reds, yellowAlerts: yellows };
  }, [pool, noticeData]);

  if (!pool || pool.length === 0) return null;

  const highOpenCnt = auctionRows.filter((r) => r.gapPct >= 1.5).length;
  const lowOpenCnt = auctionRows.filter((r) => r.gapPct <= -1.5).length;
  const nukeCnt = auctionRows.filter((r) => r.gapPct <= -4.0).length;
  const rushLeadCnt = auctionRows.filter((r) => (r.aucLead?.score || 0) >= 15).length;
  const holdingCnt = auctionRows.filter((r) => r.isHolding).length;

  const wrapCls = [
    'premarket-wrap',
    redAlerts.length > 0 ? 'has-red' : holidayReminder?.isHighAlert ? 'has-holiday-warn' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapCls}>
      {/* 顶栏精简摘要条：非竞价时段默认只占 1 行，点击可随时展开 */}
      <div className="pm-bar">
        <div className="pm-left">
          <span className={`pm-badge ${auctionWindow ? 'live' : ''}`}>
            {auctionWindow ? '🌅 09:15-09:30 竞价实时速览' : '🌅 竞价速览 & 盘前排雷'}
          </span>

          <span className="pm-stat">
            高开 <b className="up">{highOpenCnt}</b> · 低开 <b className="down">{lowOpenCnt}</b>
            {rushLeadCnt > 0 && (
              <span style={{ color: 'var(--up-d)', fontWeight: 700 }}>
                {' '}· 🔥 抢筹/弱转强 {rushLeadCnt}
              </span>
            )}
            {nukeCnt > 0 && <span className="pm-nuke"> · 🚨 深水核按钮 {nukeCnt}</span>}
          </span>

          <span className="pm-sep" />

          {noticeLoading ? (
            <span className="pm-notice-chip loading">⏳ 公告排雷扫描中…</span>
          ) : noticeErr ? (
            <span className="pm-notice-chip warn" title={noticeErr}>⚠️ 排雷接口未连接</span>
          ) : redAlerts.length > 0 ? (
            <span className="pm-notice-chip danger">
              🚨 检出 {redAlerts.length} 只高危利空公告
            </span>
          ) : yellowAlerts.length > 0 ? (
            <span className="pm-notice-chip warn">
              ⚠️ {yellowAlerts.length} 只留意类公告（无红牌雷）
            </span>
          ) : (
            <span className="pm-notice-chip safe">
              🛡️ 盘前排雷安全（{pool.length}只近35天无红牌利空）
            </span>
          )}

          {holidayReminder && (
            <span
              className={`pm-holiday-chip ${
                holidayReminder.isHighAlert
                  ? holidayReminder.remainingTradeDays === 1
                    ? 'urgent-1d'
                    : 'urgent-2d'
                  : holidayReminder.phase === 'in_holiday'
                  ? 'closed'
                  : 'countdown'
              }`}
              title={`${holidayReminder.headline} — ${holidayReminder.advice}`}
            >
              {holidayReminder.chipText}
            </span>
          )}
        </div>

        <div className="pm-right">
          {noticeData?.checkedAt && (
            <span className="pm-time">排雷 {noticeData.checkedAt}</span>
          )}
          <button
            type="button"
            className="mini"
            style={{ marginLeft: 0 }}
            onClick={loadNotices}
            disabled={noticeLoading}
            title="立即重新拉取全部持仓与自选股最新公告排雷"
          >
            ↻ 重扫公告
          </button>
          <button
            type="button"
            className={`mini ${expanded ? 'primary' : ''}`}
            style={{ marginLeft: 0 }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起竞价表 ▴' : '展开竞价速览 ▾'}
          </button>
        </div>
      </div>

      {/* 连续≥3天长假仅剩 1~2 个交易日时：常驻高亮展示节前隔夜仓位风控横幅（折叠态亦可见） */}
      {holidayReminder?.isHighAlert && (
        <div
          className={`pm-holiday-alert ${
            holidayReminder.remainingTradeDays === 1 ? 'is-final-day' : 'is-cash-day'
          }`}
        >
          <div className="pm-ha-main">
            <div className="pm-ha-head">
              <span className="pm-ha-tag">
                {holidayReminder.remainingTradeDays === 1
                  ? '🏮 节前收官日 · 跨假T+1锁仓'
                  : '🏮 距长假剩2交易日 · 节前取现窗'}
              </span>
              <b>{holidayReminder.headline}</b>
              <span className="pm-ha-pos-pill">
                建议隔夜总仓 {holidayReminder.posRangeLabel}
                {holdingCnt > 0 ? ` · 当前持仓 ${holdingCnt} 只` : ' · 当前空仓'}
              </span>
            </div>
            <div className="pm-ha-desc">{holidayReminder.advice}</div>
          </div>
        </div>
      )}

      {/* 高危公告雷区直出警报条（只要有红牌公告，无论折叠与否都立刻亮出，防止踩雷！） */}
      {redAlerts.length > 0 && (
        <div className="pm-risk-box">
          {redAlerts.map((item) => (
            <div key={item.code6} className="pm-risk-row">
              <div className="pm-risk-txt">
                <span className="pm-risk-tag">
                  {item.isHolding ? '📦 持仓高危' : '👀 自选高危'}
                </span>
                <b>{item.name} ({item.code6})</b>
                <span className="pm-risk-cat">[{item.flag.tag}]</span>
                <span className="pm-risk-title">
                  {item.flag.date} · {item.flag.title}
                </span>
                {item.hasRecent3d && <span className="pm-recent-tag">近3日新发</span>}
              </div>
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0 }}
                onClick={() => onJumpDiagnosis && onJumpDiagnosis(item.code6)}
              >
                🩺 查公告明细
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 展开后的集合竞价一屏速览表 */}
      {expanded && (
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>标的</th>
                <th>类型</th>
                <th className="num">开盘价</th>
                <th className="num">竞价幅度</th>
                <th className="num">量比</th>
                <th>竞价定性与应对</th>
                <th>公告排雷</th>
                <th style={{ textAlign: 'right' }}>直达</th>
              </tr>
            </thead>
            <tbody>
              {auctionRows.map((r) => {
                const gapCls = r.gapPct > 0 ? 'up' : r.gapPct < 0 ? 'down' : '';
                const rk = r.nInfo?.riskLevel || '安全';
                return (
                  <tr key={r.code6}>
                    <td>
                      <b>{r.name}</b> <span className="pm-code">{r.code6}</span>
                    </td>
                    <td>
                      <span className={`bc-role ${r.isHolding ? 'is-pos' : 'is-watch'}`}>
                        {r.isHolding ? `持仓 ${r.shares}股` : '自选'}
                      </span>
                    </td>
                    <td className="num">¥{f2(r.open)}</td>
                    <td className={`num ${gapCls}`} style={{ fontWeight: 800 }}>
                      {r.gapPct >= 0 ? '+' : ''}{r.gapPct.toFixed(2)}%
                    </td>
                    <td className="num">{r.vr > 0 ? `${r.vr.toFixed(2)}x` : '—'}</td>
                    <td>
                      {r.aucLead?.tag && (
                        <span
                          className="pm-tier-pill"
                          style={{
                            marginRight: '5px',
                            fontWeight: 800,
                            color: r.aucLead.score > 0 ? 'var(--up-d)' : 'var(--down-d)',
                            borderColor: r.aucLead.score > 0 ? 'var(--up-b)' : 'var(--down-b)',
                            background: r.aucLead.score > 0 ? 'var(--up-bg)' : 'var(--down-bg)',
                          }}
                          title={r.aucLead.desc}
                        >
                          {r.aucLead.tag}
                        </span>
                      )}
                      <span
                        className="pm-tier-pill"
                        style={{ color: r.tier.color, borderColor: r.tier.color }}
                      >
                        {r.tier.tag}
                      </span>
                      <span className="pm-tier-tip">
                        {r.aucLead?.desc
                          ? r.aucLead.desc
                          : r.gapPct >= 5
                          ? '高开防兑现，冲高不板先倒T'
                          : r.gapPct >= 1.5
                          ? '强势高开，回踩分时黄线看承接'
                          : r.gapPct <= -4
                          ? '深水核按钮，严禁开盘盲目抄底'
                          : r.gapPct <= -1.5
                          ? '低开观察5分钟承接，缩量企稳再看'
                          : '平开常规震荡，按卡片买卖点执行'}
                      </span>
                    </td>
                    <td>
                      {rk === '高风险' ? (
                        <span className="pm-rk danger">🚨 {r.nInfo.redFlags?.[0]?.tag || '利空'}</span>
                      ) : rk === '留意' ? (
                        <span className="pm-rk warn">⚠️ {r.nInfo.yellowAlerts?.[0]?.tag || '留意'}</span>
                      ) : (
                        <span className="pm-rk safe">🟢 安全</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="bc-act-btn"
                        onClick={() => onSelectStock && onSelectStock(r.code6)}
                      >
                        定位卡片
                      </button>
                      <button
                        type="button"
                        className="bc-act-btn"
                        style={{ marginLeft: '4px' }}
                        onClick={() => onJumpDiagnosis && onJumpDiagnosis(r.code6)}
                      >
                        🩺
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
