import React, { useState, useEffect, useCallback } from 'react';
import { fetchLimitUpPool } from '../services/api.js';

/**
 * 全市场超短情绪温度计 & 炸板率风控总阀（Phase 3 紧凑 Bento 指标卡版）
 * 默认浓缩为单行高密度遥测卡，与 PreMarketPanel 等高并排；点击「指令 ▾」展开完整做T/打板可做与禁止细则
 */
export default function MarketSentimentBar({
  externalSentiment = null,
  compact = false,
  onSentimentChange = null,
}) {
  const [sentiment, setSentiment] = useState(externalSentiment);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadSentiment = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetchLimitUpPool();
        if (res && res.ok && res.sentiment) {
          setSentiment(res.sentiment);
          if (onSentimentChange) onSentimentChange(res.sentiment);
        }
      } catch (_) {}
      if (!silent) setLoading(false);
    },
    [onSentimentChange]
  );

  useEffect(() => {
    if (externalSentiment) {
      setSentiment(externalSentiment);
      if (onSentimentChange) onSentimentChange(externalSentiment);
      return;
    }
    loadSentiment(true);
    const timer = setInterval(() => loadSentiment(true), 60000);
    return () => clearInterval(timer);
  }, [externalSentiment, loadSentiment, onSentimentChange]);

  if (!sentiment) {
    return (
      <div className="msb-card is-loading" aria-busy="true">
        <span className="msb-loading-txt">市场情绪风控总阀同步中…</span>
      </div>
    );
  }

  const {
    temperature = 50,
    cyclePhase = '震荡',
    riskValve = 'GREEN',
    valveLabel = '正常',
    valveAction = '',
    doAction = '',
    dontAction = '',
    limitUpCount = 0,
    brokenBoardCount = 0,
    brokenRate = 0,
    limitDownCount = 0,
    upCount = 0,
    downCount = 0,
    upRatio = 0,
    maxLadder = 0,
    yesterdayPremiumMean,
    yesterdayPremiumMedian,
    promotionRate,
    promotionSample,
  } = sentiment;

  const isDanger = riskValve === 'RED';
  const isWarn = riskValve === 'YELLOW';
  const toneCls = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : 'tone-safe';

  return (
    <div className={`msb-card ${toneCls} ${compact ? 'is-compact' : ''}`}>
      <div className="msb-main-row">
        <div className="msb-left">
          <span className={`msb-valve-pill ${toneCls}`}>{valveLabel}</span>

          <span className="msb-temp num-mono" title="全市场超短综合情绪温度 (0~100)">
            <b>{Math.round(temperature)}°</b>
            <em>{cyclePhase}</em>
          </span>

          <div className="msb-metrics num-mono">
            <span title="上涨家数 : 下跌家数">
              涨跌 <b className="c-up">{upCount}</b>:<b className="c-down">{downCount}</b>
              <small>({Number(upRatio || 0).toFixed(0)}%)</small>
            </span>
            <span className="msb-dot" aria-hidden="true" />
            <span title={`涨停 ${limitUpCount} 家 / 炸板 ${brokenBoardCount} 家`}>
              炸板{' '}
              <b className={brokenRate >= 40 ? 'c-up' : brokenRate >= 30 ? 'c-warn' : 'c-down'}>
                {Number(brokenRate || 0).toFixed(0)}%
              </b>
            </span>
            <span className="msb-dot" aria-hidden="true" />
            <span title={`跌停 ${limitDownCount} 家 · 最高连板 ${maxLadder} 板`}>
              高标 <b className="c-info">{maxLadder}板</b>
              {limitDownCount >= 10 && <em className="msb-dt-warn"> · 跌停{limitDownCount}</em>}
            </span>
          </div>
        </div>

        <div className="msb-right">
          {!externalSentiment && (
            <button
              type="button"
              className="msb-btn"
              onClick={() => loadSentiment(false)}
              disabled={loading}
              title="刷新全市场情绪与炸板率"
            >
              {loading ? '…' : '↻'}
            </button>
          )}
          <button
            type="button"
            className={`msb-btn ${detailOpen || isDanger ? 'active' : ''}`}
            onClick={() => setDetailOpen((v) => !v)}
            aria-expanded={detailOpen}
          >
            {detailOpen ? '收起 ▴' : '指令 ▾'}
          </button>
        </div>
      </div>

      {/* 红灯退潮总阀默认直出简短警示，平时按需点击「指令 ▾」展开 */}
      {(detailOpen || isDanger) && (
        <div className="msb-drawer">
          <div className="msb-cmd-line">
            <b>总阀指令：</b>
            <span>{valveAction}</span>
            {yesterdayPremiumMean != null && (
              <span className="num-mono msb-extra-stat">
                · 昨涨停溢价{' '}
                <b className={yesterdayPremiumMean >= 0 ? 'c-up' : 'c-down'}>
                  {yesterdayPremiumMean >= 0 ? '+' : ''}
                  {Number(yesterdayPremiumMean).toFixed(2)}%
                </b>
                {yesterdayPremiumMedian != null && ` (中位 ${Number(yesterdayPremiumMedian).toFixed(2)}%)`}
              </span>
            )}
            {promotionRate != null && (
              <span className="num-mono msb-extra-stat">
                · 晋级率 <b>{Number(promotionRate).toFixed(1)}%</b> ({promotionSample || '0/0'})
              </span>
            )}
          </div>
          {(doAction || dontAction) && (
            <div className="msb-do-dont">
              {doAction && <span className="msb-pill-do">宜：{doAction}</span>}
              {dontAction && <span className="msb-pill-dont">忌：{dontAction}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
