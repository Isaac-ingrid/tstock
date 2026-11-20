import React, { useState, useMemo } from 'react';
import { posCalc } from '../services/api.js';
import { money } from '../services/utils.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';
import {
  POS_RULES_KEY,
  DEFAULT_POS_RULES,
  loadPosRules,
  savePosRules,
  getAllowedPosCap,
} from '../services/risk.js';

export { POS_RULES_KEY, DEFAULT_POS_RULES, loadPosRules, savePosRules, getAllowedPosCap };

export default function PositionRiskBar({
  pool = [],
  tailActives = [],
  totalAssets = 100000,
  cash = 0,
  initialCapital = 100000,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
  sentiment = null,
  posRules = DEFAULT_POS_RULES,
  tiltState = null,
  onUpdateRules,
  onUnlockTilt,
  onRelockTilt,
  onSelectStock,
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingUnlock, setConfirmingUnlock] = useState(false);

  const assets = Math.max(1, +totalAssets || 100000);
  const { capPct, valve, label: capLabel } = getAllowedPosCap(sentiment, posRules);

  const { holdings, totalMkt, totalPosPct, overweightList } = useMemo(() => {
    const list = [];
    let mkt = 0;
    const byCode = new Map();

    (pool || []).forEach((s) => {
      const p = posCalc(s);
      if (p.hasPos) {
        const code6 = String(s.code || '').padStart(6, '0');
        mkt += p.curMkt;
        const entry = {
          key: code6,
          code6,
          name: s.name || s.code,
          mkt: p.curMkt,
          pct: (p.curMkt / assets) * 100,
          floatPL: p.floatPL,
          floatPct: p.floatPct,
          isTail: false,
          isOver: false,
        };
        byCode.set(code6, entry);
        list.push(entry);
      }
    });

    (tailActives || []).forEach((t, idx) => {
      const sh = Math.round(+t.shares || 0);
      if (sh <= 0 || t.status === 'closed') return;
      const px = +t.price || +t.cost || 0;
      const cost = +t.cost || px;
      const curMkt = sh * px;
      const code6 = String(t.code || '').padStart(6, '0');
      mkt += curMkt;
      if (byCode.has(code6)) {
        const existing = byCode.get(code6);
        existing.mkt += curMkt;
        existing.pct = (existing.mkt / assets) * 100;
        existing.floatPL += (px - cost) * sh;
        existing.name = existing.name.includes('⚡尾盘') ? existing.name : `${existing.name} (+⚡尾盘)`;
      } else {
        list.push({
          key: `tail_${code6}_${t.id || idx}`,
          code6,
          name: `${t.name || t.code} (⚡尾盘)`,
          mkt: curMkt,
          pct: (curMkt / assets) * 100,
          floatPL: (px - cost) * sh,
          floatPct: cost > 0 ? ((px - cost) / cost) * 100 : 0,
          isTail: true,
          isOver: false,
        });
      }
    });

    list.forEach((item) => {
      item.isOver = item.pct > posRules.singleMaxPct;
    });
    list.sort((a, b) => b.pct - a.pct);
    return {
      holdings: list,
      totalMkt: mkt,
      totalPosPct: (mkt / assets) * 100,
      overweightList: list.filter((x) => x.isOver),
    };
  }, [pool, tailActives, assets, posRules.singleMaxPct]);

  const isOverTotal = totalPosPct > capPct + 0.1;
  const excessAmt = Math.max(0, totalMkt - (assets * capPct) / 100);
  const remainAmt = Math.max(0, (assets * capPct) / 100 - totalMkt);
  const cashPct = Math.max(0, 100 - totalPosPct);
  const isTiltLocked = Boolean(tiltState?.isLocked);
  const hasAnyWarn = isOverTotal || overweightList.length > 0 || isTiltLocked;

  const updateField = (key, val) => {
    const next = {
      ...posRules,
      [key]: typeof val === 'boolean' ? val : Number(val),
    };
    if (onUpdateRules) onUpdateRules(next);
  };

  return (
    <div
      className={`pos-risk-wrap ${
        isOverTotal || isTiltLocked
          ? 'is-danger'
          : overweightList.length > 0 || tiltState?.isWarning
          ? 'is-warn'
          : ''
      }`}
    >
      {/* 一行紧凑仓位与单日防上头风控摘要条 */}
      <div className="pr-top">
        <div className="pr-left">
          <span className="pr-title">⚖️ 动态仓位 &amp; 盘中风控</span>

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

          {/* 单日连续止损 / 日回撤防上头监控胶囊 */}
          {tiltState && tiltState.enabled && (
            isTiltLocked ? (
              <span className="pr-pill tilt-locked">
                🔒 防上头熔断已锁死（连亏 {tiltState.consecLosses} 笔 · 日回撤 -{tiltState.effectiveLossPct.toFixed(2)}%）
              </span>
            ) : tiltState.isOverridden ? (
              <span className="pr-pill warn">
                ⚠️ 冷静解锁观察期（再亏 1 笔或回撤扩 +0.5% 将二次硬锁死）
              </span>
            ) : tiltState.isWarning ? (
              <span className="pr-pill warn">
                ⚡ 逼近熔断红线（连亏 {tiltState.consecLosses}/{tiltState.maxConsecLosses} 笔 · 日回撤 -{tiltState.effectiveLossPct.toFixed(2)}%）
              </span>
            ) : (
              <span className="pr-pill neutral" title="统计当日闭环交易连续亏损笔数与综合日内回撤，超阈值自动锁定新买单防情绪化上头">
                🛡️ 今日闭环 {tiltState.todayClosedCount} 笔 · 连亏 {tiltState.consecLosses}/{tiltState.maxConsecLosses} · 日内 {tiltState.todayCombinedPL >= 0 ? '+' : ''}¥{money(tiltState.todayCombinedPL)}
              </span>
            )
          )}
        </div>

        <button
          type="button"
          className={`mini ${expanded ? 'primary' : ''}`}
          style={{ marginLeft: 0 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起风控面板 ▴' : '仓位 & 熔断规则 ▾'}
        </button>
      </div>

      {/* 防上头熔断锁激活横幅（默认常驻，无需展开即可见） */}
      {isTiltLocked && (
        <div className="tilt-lock-banner">
          <div className="tilt-lock-main">
            <div className="tilt-lock-txt">
              <div>
                <b>🛑 已触发「单日防上头熔断锁」：</b>
                {(tiltState.reasons || []).join('；')}
              </div>
              <div style={{ marginTop: 2, fontSize: 11.5 }}>
                系统已自动锁定<b>「新开仓 / 直接买入 / 正T低吸 / 尾盘建仓」</b>，严防亏损后急于翻本越做越错；
                <b>「直接卖出 / 止损清仓 / 倒T高抛 / 尾盘平仓」不受影响，100% 保持畅通</b>。
              </div>
            </div>
            {tiltState.relockedAfterOverride ? (
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 800,
                  color: '#991b1b',
                  background: '#fee2e2',
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #fca5a5',
                }}
              >
                ⛔ 二次硬锁死（今日禁再解锁，明日再战）
              </span>
            ) : !confirmingUnlock ? (
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0, borderColor: '#f87171', color: '#b91c1c', background: '#fff' }}
                onClick={() => setConfirmingUnlock(true)}
              >
                🧘 冷静复盘申请解锁
              </button>
            ) : null}
          </div>

          {confirmingUnlock && !tiltState.relockedAfterOverride && (
            <div className="tilt-pledge-box">
              <span>
                📋 <b>纪律确认：</b>本人已深呼吸冷静复盘，绝不报复性重仓赌反弹；解锁后若再新增 1 笔亏损或回撤扩大 ≥0.5%，接受今日二次硬锁死。
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="mini"
                  style={{ marginLeft: 0 }}
                  onClick={() => setConfirmingUnlock(false)}
                >
                  继续锁仓休息
                </button>
                <button
                  type="button"
                  className="mini primary"
                  style={{ marginLeft: 0, background: '#dc2626', borderColor: '#dc2626' }}
                  onClick={() => {
                    setConfirmingUnlock(false);
                    if (onUnlockTilt) onUnlockTilt();
                  }}
                >
                  确认冷静并临时解锁
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 冷静解锁观察期提示条 */}
      {!isTiltLocked && tiltState?.isOverridden && (
        <div className="tilt-override-bar">
          <span>
            🧘 当前处于<b>「熔断冷静解锁观察期」</b>：仅允许确定性买点轻仓试单；若今日再亏 1 笔或回撤继续恶化 ≥0.5% 将触发全天二次硬锁死。
          </span>
          <button
            type="button"
            className="mini"
            style={{ marginLeft: 0 }}
            onClick={() => onRelockTilt && onRelockTilt()}
          >
            🔒 重新上锁休息
          </button>
        </div>
      )}

      {/* 展开区：单票仓位占比条 + 可编辑仓位与熔断参数 */}
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
                    key={h.key || h.code6}
                    className={`pr-bar-row ${h.isOver ? 'over' : ''}`}
                    onClick={() => {
                      if (h.isTail && typeof window !== 'undefined') {
                        window.location.hash = '#/tail';
                      } else if (onSelectStock) {
                        onSelectStock(h.code6);
                      }
                    }}
                    title={h.isTail ? '点击前往尾盘黑马看板平仓管理' : '点击定位到该股作战卡片'}
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

          {/* 账户资金基准直输 + 仓位与单日熔断纪律参数自定义 */}
          <div className="pr-rules">
            {(onUpdateTotalAssets || onUpdateCash || onUpdateInitialCapital) && (
              <div style={{ marginBottom: '12px', paddingBottom: '10px', borderBottom: '1px dashed var(--line)' }}>
                <div className="pr-sec-title" style={{ marginBottom: '8px' }}>
                  <span>💰 账户资金基准（直接点击输入框敲数字，回车或失焦自动保存，支持 20w 快捷输入）</span>
                </div>
                <div className="pr-rule-grid">
                  {onUpdateTotalAssets && (
                    <label>
                      <span>💼 实时账户总资产(元)</span>
                      <DirectMoneyInput
                        value={assets}
                        onCommit={onUpdateTotalAssets}
                        min={0}
                        allowZero={true}
                        size="rule"
                        prefix="¥"
                        ariaLabel="风控面板总资产输入"
                      />
                    </label>
                  )}
                  {onUpdateCash && (
                    <label>
                      <span>💵 真实可用现金(元)</span>
                      <DirectMoneyInput
                        value={cash}
                        onCommit={onUpdateCash}
                        min={0}
                        allowZero={true}
                        size="rule"
                        tone="cash"
                        prefix="¥"
                        ariaLabel="风控面板可用现金输入"
                      />
                    </label>
                  )}
                  {onUpdateInitialCapital && (
                    <label>
                      <span>🏦 初始投入本金(元)</span>
                      <DirectMoneyInput
                        value={initialCapital || assets}
                        onCommit={onUpdateInitialCapital}
                        min={100}
                        allowZero={false}
                        size="rule"
                        prefix="¥"
                        ariaLabel="风控面板初始本金输入"
                      />
                    </label>
                  )}
                </div>
              </div>
            )}

            <div className="pr-sec-title">
              <span>⚙️ 仓位与防上头熔断参数（支持退格清空重输，回车或失焦实时保存）</span>
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
                <DirectMoneyInput
                  value={posRules.greenMaxPct}
                  onCommit={(v) => updateField('greenMaxPct', v)}
                  min={10}
                  max={100}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="绿灯总仓上限"
                />
              </label>
              <label>
                <span>🟡 黄灯总仓上限(%)</span>
                <DirectMoneyInput
                  value={posRules.yellowMaxPct}
                  onCommit={(v) => updateField('yellowMaxPct', v)}
                  min={10}
                  max={100}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="黄灯总仓上限"
                />
              </label>
              <label>
                <span>🔴 红灯总仓上限(%)</span>
                <DirectMoneyInput
                  value={posRules.redMaxPct}
                  onCommit={(v) => updateField('redMaxPct', v)}
                  min={0}
                  max={100}
                  allowZero={true}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="红灯总仓上限"
                />
              </label>
              <label>
                <span>🎯 单票上限(%)</span>
                <DirectMoneyInput
                  value={posRules.singleMaxPct}
                  onCommit={(v) => updateField('singleMaxPct', v)}
                  min={5}
                  max={100}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="单票仓位上限"
                />
              </label>
              <label>
                <span>🛡️ 单笔以损定仓(%)</span>
                <DirectMoneyInput
                  value={posRules.riskPerTradePct}
                  onCommit={(v) => updateField('riskPerTradePct', v)}
                  min={0.5}
                  max={5}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="单笔以损定仓比例"
                />
              </label>
              <label>
                <span>🛑 单日连亏熔断(笔)</span>
                <DirectMoneyInput
                  value={posRules.maxConsecLosses ?? DEFAULT_POS_RULES.maxConsecLosses}
                  onCommit={(v) => updateField('maxConsecLosses', Math.round(v))}
                  min={1}
                  max={10}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="笔"
                  size="rule"
                  ariaLabel="单日连亏熔断笔数"
                />
              </label>
              <label>
                <span>📉 日回撤熔断(%)</span>
                <DirectMoneyInput
                  value={posRules.dailyLossLimitPct ?? DEFAULT_POS_RULES.dailyLossLimitPct}
                  onCommit={(v) => updateField('dailyLossLimitPct', v)}
                  min={0.5}
                  max={15}
                  allowZero={false}
                  formatThousand={false}
                  prefix=""
                  suffix="%"
                  size="rule"
                  ariaLabel="日回撤熔断比例"
                />
              </label>
              <label style={{ justifyContent: 'space-between' }}>
                <span>🔒 防上头熔断开关</span>
                <button
                  type="button"
                  className={`bc-act-btn ${posRules.tiltLockEnabled !== false ? 'active' : ''}`}
                  style={{ height: 29 }}
                  onClick={() => updateField('tiltLockEnabled', !(posRules.tiltLockEnabled !== false))}
                >
                  {posRules.tiltLockEnabled !== false ? '已开启保护' : '已关闭'}
                </button>
              </label>
            </div>
            {valve && (
              <div className="pr-rule-tip">
                当前情绪总阀为 <b>{sentiment?.valveLabel || '🟢 绿灯'}</b>，动态总仓红线锁定 <b>{capPct}%</b>；
                单日连亏 ≥<b>{posRules.maxConsecLosses ?? 2}笔</b> 或日回撤 ≥<b>{posRules.dailyLossLimitPct ?? 2}%</b> 时自动锁定新开仓与正T低吸
                {hasAnyWarn ? '（当前存在风控预警，请严格按纪律执行）。' : '。'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
