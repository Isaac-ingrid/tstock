import React, { useState, useEffect, useCallback } from 'react';
import { fetchLimitUpPool } from '../services/api.js';

/**
 * 🌡️ 全市场超短情绪温度计 & 炸板率风控总阀组件
 * 用于在做T决策台与打板专栏顶部全局预警：防系统性退潮与高炸板率大面风险
 */
export default function MarketSentimentBar({ externalSentiment = null, compact = false }) {
  const [sentiment, setSentiment] = useState(externalSentiment);
  const [loading, setLoading] = useState(false);

  const loadSentiment = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetchLimitUpPool();
      if (res && res.ok && res.sentiment) {
        setSentiment(res.sentiment);
      }
    } catch (_) {}
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    if (externalSentiment) {
      setSentiment(externalSentiment);
      return;
    }
    loadSentiment(true);
    const timer = setInterval(() => loadSentiment(true), 60000);
    return () => clearInterval(timer);
  }, [externalSentiment, loadSentiment]);

  if (!sentiment) {
    return null;
  }

  const {
    temperature,
    cyclePhase,
    riskValve,
    valveLabel,
    valveAction,
    doAction,
    dontAction,
    valveColor,
    valveBg,
    valveBorder,
    limitUpCount,
    brokenBoardCount,
    brokenRate,
    limitDownCount,
    upCount,
    downCount,
    upRatio,
    maxLadder,
    yesterdayPremiumMean,
    yesterdayPremiumMedian,
    yesterdayPremiumSample,
    promotionRate,
    promotionSample,
    consecPromotionRate,
    consecPromotionSample,
  } = sentiment;

  const isDanger = riskValve === 'RED';
  const isWarn = riskValve === 'YELLOW';

  return (
    <div
      style={{
        margin: compact ? '0 0 12px' : '0 0 14px',
        padding: '10px 14px',
        borderRadius: '10px',
        background: valveBg,
        border: `1.5px solid ${valveBorder}`,
        boxShadow: isDanger ? '0 2px 12px rgba(220, 38, 38, 0.15)' : '0 1px 6px rgba(0,0,0,0.05)'
      }}
    >
      {/* 上半部分：温度计 + 风控总阀 + 四项市场广度数据 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* 风控总阀灯 */}
          <span
            style={{
              background: valveColor,
              color: '#fff',
              fontSize: '12px',
              fontWeight: 800,
              padding: '3px 10px',
              borderRadius: '6px',
              letterSpacing: '0.5px',
              boxShadow: '0 2px 6px rgba(0,0,0,0.12)'
            }}
          >
            {valveLabel}
          </span>

          {/* 情绪温度计与周期 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 800, color: valveColor }}>
              🌡️ {temperature}°C
            </span>
            <div style={{ width: '56px', height: '7px', background: 'rgba(0,0,0,0.08)', borderRadius: '4px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${temperature}%`,
                  height: '100%',
                  background: temperature >= 75 ? '#ef4444' : temperature >= 50 ? '#f59e0b' : '#3b82f6',
                  transition: 'width 0.4s ease'
                }}
              />
            </div>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#1e293b' }}>
              {cyclePhase}
            </span>
          </div>
        </div>

        {/* 右侧：量化指标仪表盘 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '12px', color: '#334155' }}>
          <span title="沪深两市上涨家数 vs 下跌家数">
            📈 涨跌比：
            <b style={{ color: '#cf1322', fontFamily: 'monospace' }}>{upCount}</b>
            {' : '}
            <b style={{ color: '#0a7f42', fontFamily: 'monospace' }}>{downCount}</b>
            <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '3px' }}>
              ({upRatio.toFixed(0)}%红)
            </span>
          </span>

          <span title="全市场炸板率 = 炸板数 / (涨停数 + 炸板数)，超过 30% 进入分歧警戒，超过 42% 触发红色退潮总阀">
            💥 炸板率：
            <b style={{
              fontFamily: 'monospace',
              color: brokenRate >= 40 ? '#dc2626' : brokenRate >= 30 ? '#d97706' : '#16a34a'
            }}>
              {brokenRate.toFixed(1)}%
            </b>
            <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '3px' }}>
              ({limitUpCount}涨停 / {brokenBoardCount}炸板)
            </span>
          </span>

          <span title="两市跌停总数及连板高度空间标杆">
            🚨 跌停：<b style={{ fontFamily: 'monospace', color: limitDownCount >= 10 ? '#dc2626' : '#334155' }}>{limitDownCount}家</b>
            <span style={{ margin: '0 6px', color: '#cbd5e1' }}>|</span>
            👑 高度：<b style={{ fontFamily: 'monospace', color: '#b45309' }}>{maxLadder}板</b>
          </span>

          {yesterdayPremiumMean != null && (
            <span
              title={`昨日涨停主板股今日表现（有效样本 ${yesterdayPremiumSample || 0} 家）：均值 ${(Number(yesterdayPremiumMean)).toFixed(2)}%，中位数 ${yesterdayPremiumMedian != null ? Number(yesterdayPremiumMedian).toFixed(2) + '%' : '—'}；均值显著高于中位数说明仅少数前排吃肉`}
            >
              📊 昨涨停溢价：
              <b style={{
                fontFamily: 'monospace',
                color: yesterdayPremiumMean >= 1.5 ? '#dc2626' : yesterdayPremiumMean >= 0 ? '#d97706' : '#0a7f42',
              }}>
                {yesterdayPremiumMean >= 0 ? '+' : ''}{Number(yesterdayPremiumMean).toFixed(2)}%
              </b>
              {yesterdayPremiumMedian != null && (
                <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '3px' }}>
                  (中位 {yesterdayPremiumMedian >= 0 ? '+' : ''}{Number(yesterdayPremiumMedian).toFixed(2)}%)
                </span>
              )}
              {yesterdayPremiumMedian != null && (Number(yesterdayPremiumMean) - Number(yesterdayPremiumMedian) >= 1.5) && (
                <span style={{
                  marginLeft: '4px',
                  fontSize: '10px',
                  padding: '0px 5px',
                  borderRadius: '4px',
                  background: '#fef3c7',
                  color: '#b45309',
                  border: '1px solid #fde68a',
                  fontWeight: 600,
                }}>
                  极化
                </span>
              )}
            </span>
          )}

          {promotionRate != null && (
            <span
              title={`昨日全部涨停今日连板晋级率：${promotionSample || '—'}；其中昨日连板股(≥2板)今日继续晋级率：${consecPromotionRate != null ? `${Number(consecPromotionRate).toFixed(1)}% (${consecPromotionSample})` : '—'}`}
            >
              🎯 晋级率：
              <b style={{
                fontFamily: 'monospace',
                color: promotionRate >= 30 ? '#dc2626' : promotionRate >= 18 ? '#d97706' : '#475569',
              }}>
                {Number(promotionRate).toFixed(1)}%
              </b>
              <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '3px' }}>
                ({promotionSample})
                {consecPromotionRate != null && ` · 连板${Number(consecPromotionRate).toFixed(0)}%`}
              </span>
            </span>
          )}

          {!externalSentiment && (
            <button
              type="button"
              className="mini"
              onClick={() => loadSentiment(false)}
              disabled={loading}
              style={{ fontSize: '11px', padding: '2px 8px', background: 'rgba(255,255,255,0.7)' }}
            >
              {loading ? '同步中' : '⟳ 刷新情绪'}
            </button>
          )}
        </div>
      </div>

      {/* 下半部分：风控总阀实战指令条 + 可做 / 禁止标签 */}
      <div style={{
        marginTop: '6px',
        paddingTop: '6px',
        borderTop: `1px dashed ${valveBorder}`,
        fontSize: '11.5px',
        color: isDanger ? '#991b1b' : isWarn ? '#92400e' : '#166534',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 10px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
          <span>🚦 <b>总阀交易指令：</b></span>
          <span>{valveAction}</span>
        </div>
        {(doAction || dontAction) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11px' }}>
            {doAction && (
              <span style={{
                padding: '1px 7px',
                borderRadius: '4px',
                background: 'rgba(22, 163, 74, 0.1)',
                color: '#15803d',
                border: '1px solid rgba(22, 163, 74, 0.25)',
                fontWeight: 600,
              }}>
                ✅ 可做：{doAction}
              </span>
            )}
            {dontAction && (
              <span style={{
                padding: '1px 7px',
                borderRadius: '4px',
                background: 'rgba(220, 38, 38, 0.08)',
                color: '#b91c1c',
                border: '1px solid rgba(220, 38, 38, 0.25)',
                fontWeight: 600,
              }}>
                ⛔ 禁止：{dontAction}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
