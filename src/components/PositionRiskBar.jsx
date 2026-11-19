import React, { useState, useMemo } from 'react';
import { posCalc } from '../services/api.js';
import { money } from '../services/utils.js';

export const POS_RULES_KEY = 't-pos-rules-v1';

export const DEFAULT_POS_RULES = {
  greenMaxPct: 80,
  yellowMaxPct: 50,
  redMaxPct: 20,
  singleMaxPct: 30,
  riskPerTradePct: 1.5,
};

export function loadPosRules() {
  try {
    const raw = localStorage.getItem(POS_RULES_KEY);
    if (!raw) return { ...DEFAULT_POS_RULES };
    const parsed = JSON.parse(raw);
    return {
      greenMaxPct: Math.min(100, Math.max(10, Number(parsed.greenMaxPct) || DEFAULT_POS_RULES.greenMaxPct)),
      yellowMaxPct: Math.min(100, Math.max(10, Number(parsed.yellowMaxPct) || DEFAULT_POS_RULES.yellowMaxPct)),
      redMaxPct: Math.min(100, Math.max(0, Number(parsed.redMaxPct ?? DEFAULT_POS_RULES.redMaxPct))),
      singleMaxPct: Math.min(100, Math.max(5, Number(parsed.singleMaxPct) || DEFAULT_POS_RULES.singleMaxPct)),
      riskPerTradePct: Math.min(5, Math.max(0.3, Number(parsed.riskPerTradePct) || DEFAULT_POS_RULES.riskPerTradePct)),
    };
  } catch {
    return { ...DEFAULT_POS_RULES };
  }
}

export function getAllowedPosCap(sentiment, rules) {
  const r = rules || DEFAULT_POS_RULES;
  const valve = sentiment?.riskValve || 'GREEN';
  if (valve === 'RED') return { capPct: r.redMaxPct, valve: 'RED', label: '红灯退潮上限' };
  if (valve === 'YELLOW') return { capPct: r.yellowMaxPct, valve: 'YELLOW', label: '黄灯分歧上限' };
  return { capPct: r.greenMaxPct, valve: 'GREEN', label: '绿灯进攻上限' };
}

export default function PositionRiskBar({
  pool = [],
  totalAssets = 100000,
  sentiment = null,
  posRules = DEFAULT_POS_RULES,
  onUpdateRules,
  onSelectStock,
}) {
  const [expanded, setExpanded] = useState(false);

  const assets = Math.max(1, +totalAssets || 100000);
  const { capPct, valve, label: capLabel } = getAllowedPosCap(sentiment, posRules);

  const { holdings, totalMkt, totalPosPct, overweightList } = useMemo(() => {
    const list = [];
    let mkt = 0;
    (pool || []).forEach((s) => {
      const p = posCalc(s);
      if (p.hasPos) {
        const pctOfAssets = (p.curMkt / assets) * 100;
        mkt += p.curMkt;
        list.push({
          code6: String(s.code || '').padStart(6, '0'),
          name: s.name || s.code,
          mkt: p.curMkt,
          pct: pctOfAssets,
          floatPL: p.floatPL,
          floatPct: p.floatPct,
          isOver: pctOfAssets > posRules.singleMaxPct,
        });
      }
    });
    list.sort((a, b) => b.pct - a.pct);
    return {
      holdings: list,
      totalMkt: mkt,
      totalPosPct: (mkt / assets) * 100,
      overweightList: list.filter((x) => x.isOver),
    };
  }, [pool, assets, posRules.singleMaxPct]);

  const isOverTotal = totalPosPct > capPct + 0.1;
  const excessAmt = Math.max(0, totalMkt - (assets * capPct) / 100);
  const remainAmt = Math.max(0, (assets * capPct) / 100 - totalMkt);
  const cashPct = Math.max(0, 100 - totalPosPct);
  const hasAnyWarn = isOverTotal || overweightList.length > 0;

  const updateField = (key, val) => {
    const next = { ...posRules, [key]: Number(val) };
    if (onUpdateRules) onUpdateRules(next);
  };

  return (
    <div className={`pos-risk-wrap ${isOverTotal ? 'is-danger' : overweightList.length > 0 ? 'is-warn' : ''}`}>
      {/* 一行紧凑仓位风控摘要条 */}
      <div className="pr-top">
        <div className="pr-left">
          <span className="pr-title">⚖️ 动态仓位风控</span>

          <div className="pr-gauge" title={`当前总仓位 ${totalPosPct.toFixed(1)}% / ${capLabel} ${capPct}%`}>
            <div className="pr-gauge-track">
              <div
                className={`pr-gauge-fill ${isOverTotal ? 'danger' : totalPosPct >= capPct * 0.85 ? 'warn' : 'ok'}`}
                style={{ width: `${Math.min(100, totalPosPct)}%` }}
              />
              <div
                className="pr-gauge-cap"
                style={{ left: `${Math.min(100, capPct)}%` }}
                title={`${capLabel} ${capPct}%`}
              />
            </div>
            <span className="pr-gauge-txt">
              总仓 <b className={isOverTotal ? 'up' : ''}>{totalPosPct.toFixed(1)}%</b> / {capLabel} <b>{capPct}%</b>
            </span>
          </div>

          {isOverTotal ? (
            <span className="pr-pill danger">
              🚨 超仓 {(totalPosPct - capPct).toFixed(1)}% · 建议减仓 ¥{money(excessAmt)}（暂禁新开仓）
            </span>
          ) : (
            <span className="pr-pill ok">
              ✅ 仓位安全 · 情绪额度余 ¥{money(remainAmt)}
            </span>
          )}

          {overweightList.length > 0 && (
            <span className="pr-pill warn">
              ⚠️ {overweightList.length}只超单票上限({posRules.singleMaxPct}%)：{overweightList.map((x) => `${x.name} ${x.pct.toFixed(0)}%`).join('、')}
            </span>
          )}
        </div>

        <button
          type="button"
          className={`mini ${expanded ? 'primary' : ''}`}
          style={{ marginLeft: 0 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起仓位分布 ▴' : '仓位分布 & 规则 ▾'}
        </button>
      </div>

      {/* 展开区：单票仓位占比条 + 可编辑风控参数 */}
      {expanded && (
        <div className="pr-body">
          {/* 单票分布条 */}
          <div className="pr-dist">
            <div className="pr-sec-title">
              <span>📦 实盘仓位分布（单票红线 {posRules.singleMaxPct}% · 现金 {cashPct.toFixed(1)}%）</span>
            </div>
            {holdings.length === 0 ? (
              <div className="pr-empty">当前为空仓状态（100% 现金），可根据下方情绪上限分批建仓。</div>
            ) : (
              <div className="pr-bars">
                {holdings.map((h) => (
                  <div
                    key={h.code6}
                    className={`pr-bar-row ${h.isOver ? 'over' : ''}`}
                    onClick={() => onSelectStock && onSelectStock(h.code6)}
                    title="点击定位到该股作战卡片"
                  >
                    <div className="pr-bar-lbl">
                      <b>{h.name}</b>
                      <span>{h.code6}</span>
                    </div>
                    <div className="pr-bar-track">
                      <div
                        className={`pr-bar-fill ${h.isOver ? 'over' : ''}`}
                        style={{ width: `${Math.min(100, h.pct)}%` }}
                      />
                      <div
                        className="pr-bar-limit"
                        style={{ left: `${Math.min(100, posRules.singleMaxPct)}%` }}
                      />
                    </div>
                    <div className="pr-bar-val">
                      <b className={h.isOver ? 'up' : ''}>{h.pct.toFixed(1)}%</b>
                      <span>¥{money(h.mkt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 仓位规则自定义 */}
          <div className="pr-rules">
            <div className="pr-sec-title">
              <span>⚙️ 仓位纪律参数（自动保存，联动「🧮 算手数」以损定仓）</span>
              <button
                type="button"
                className="bc-act-btn"
                onClick={() => onUpdateRules && onUpdateRules({ ...DEFAULT_POS_RULES })}
              >
                恢复默认
              </button>
            </div>
            <div className="pr-rule-grid">
              <label>
                <span>🟢 绿灯总仓上限(%)</span>
                <input
                  type="number"
                  min={10}
                  max={100}
                  step={5}
                  value={posRules.greenMaxPct}
                  onChange={(e) => updateField('greenMaxPct', e.target.value)}
                />
              </label>
              <label>
                <span>🟡 黄灯总仓上限(%)</span>
                <input
                  type="number"
                  min={10}
                  max={100}
                  step={5}
                  value={posRules.yellowMaxPct}
                  onChange={(e) => updateField('yellowMaxPct', e.target.value)}
                />
              </label>
              <label>
                <span>🔴 红灯总仓上限(%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={posRules.redMaxPct}
                  onChange={(e) => updateField('redMaxPct', e.target.value)}
                />
              </label>
              <label>
                <span>🎯 单票上限(%)</span>
                <input
                  type="number"
                  min={5}
                  max={100}
                  step={5}
                  value={posRules.singleMaxPct}
                  onChange={(e) => updateField('singleMaxPct', e.target.value)}
                />
              </label>
              <label>
                <span>🛡️ 单笔以损定仓(%)</span>
                <input
                  type="number"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={posRules.riskPerTradePct}
                  onChange={(e) => updateField('riskPerTradePct', e.target.value)}
                />
              </label>
            </div>
            {valve && (
              <div className="pr-rule-tip">
                当前情绪总阀为 <b>{sentiment?.valveLabel || '🟢 绿灯'}</b>，动态总仓红线已自动锁定为 <b>{capPct}%</b>
                {hasAnyWarn ? '；存在超仓/集中度预警，请优先遵循纪律降仓。' : '。'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
