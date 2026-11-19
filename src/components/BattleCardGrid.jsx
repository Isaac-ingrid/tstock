import React, { useState } from 'react';
import { calc, posCalc } from '../services/api.js';
import { f2, money, getTodayTStatus, copyPlain, toastWarn } from '../services/utils.js';

/**
 * 根据「自选观察」vs「实盘持仓」分别生成清晰、直白的买卖点判定结论：
 * - 自选（shares === 0）：明确回答「现在是不是买点？」+ 目标低吸价/止损价
 * - 持仓（shares > 0）：明确回答「现在是卖点、买点、止损还是持股观望？」+ 浮盈与触发价
 * - 统一联动全市场情绪红灯总阀、盘前公告高危排雷、盘中分时异动（急拉/跳水/冲板回落）及单日防上头熔断锁
 */
export function buildActionSignal(stock, { sentiment = null, noticeRisk = null, tiltState = null } = {}) {
  const pc = +stock.prevClose || 0;
  const px = +stock.price || pc;
  const chg = pc > 0 ? ((px - pc) / pc) * 100 : 0;
  const pos = posCalc(stock);
  const c = calc(stock);
  const hasPos = pos.sh > 0;

  const hasRedNotice = noticeRisk?.riskLevel === '高风险' && (noticeRisk.redFlags || []).length > 0;
  const redNoticeTag = hasRedNotice ? (noticeRisk.redFlags[0]?.tag || '高危公告') : '';
  const isRedSentiment = sentiment?.riskValve === 'RED';
  const isTiltLocked = Boolean(tiltState?.isLocked);

  const now = Date.now();
  const activeAnomaly =
    stock._anomaly && (!stock._anomaly.at || now - stock._anomaly.at <= 12 * 60 * 1000)
      ? stock._anomaly
      : null;

  const distBuyPct = px > 0 && c.inA > 0 ? ((px - c.inA) / px) * 100 : null;
  const distSellPct = px > 0 && c.outA > 0 ? ((c.outA - px) / px) * 100 : null;

  let kind = 'wait'; // 'buy' | 'sell' | 'stop' | 'warn' | 'wait'
  let badge = '⏳ 暂观望';
  let headline = '信号未明，先看戏不动';
  let triggerText = c.inA > 0 ? `参考低吸 ¥${f2(c.inA)} · 压力 ¥${f2(c.outA)}` : '等待行情同步';

  if (!hasPos) {
    if (hasRedNotice) {
      kind = 'stop';
      badge = `🚨 非买点 · 公告雷(${redNoticeTag})`;
      headline = `近35天检出高危利空【${redNoticeTag}】，一票否决买入`;
      triggerText = '点击下方「🩺 诊股」核查公告明细，排除前严禁建仓';
    } else if (activeAnomaly?.type === 'limit_broken' || activeAnomaly?.type === 'waterfall_down') {
      kind = 'stop';
      badge = activeAnomaly.type === 'limit_broken' ? '💥 非买点 · 冲板炸板' : '🌊 非买点 · 分时跳水';
      headline = activeAnomaly.summary;
      triggerText = `等分时缩量走平后再评估低吸位 ¥${f2(c.inA)}`;
    } else if (isTiltLocked) {
      kind = 'stop';
      badge = '🔒 熔断期 · 暂停新开仓';
      headline = '已触发单日防上头熔断锁，禁止情绪化追单换股，管住手保本金';
      triggerText = `参考观察位 ¥${f2(c.inA)} · 今日仅复盘不新买`;
    } else if (c.brokenLock || c.bear) {
      kind = 'stop';
      badge = '🚫 非买点 · 禁接飞刀';
      headline = c.brokenLock ? `形态破位（${c.breakDesc || '失守支撑'}），严禁抄底` : '日线空头反压，暂不建仓';
      triggerText = `观望等重新站稳均线，上方压力 ¥${f2(c.outA)}`;
    } else if (isRedSentiment || c.mktLevel === 'BAD') {
      kind = 'warn';
      badge = isRedSentiment ? '🔴 非买点 · 情绪红灯熔断' : '⛔ 非买点 · 大盘否决';
      headline = isRedSentiment
        ? `全市场红灯退潮（炸板率 ${sentiment.brokenRate ?? '—'}%），暂停新开仓`
        : '指数破位日暂停新开仓，管住手';
      triggerText = `等情绪转黄/绿灯或指数收回 MA20 后再看 ¥${f2(c.inA)}`;
    } else if (activeAnomaly?.type === 'rocket_up' && chg >= 4.0) {
      kind = 'warn';
      badge = '🚀 放量急拉 · 切忌半路追高';
      headline = `分时5分钟爆量急拉 +${activeAnomaly.deltaPct}%，追高易吃日内回落面`;
      triggerText = `等回踩分时均线 ¥${f2(+stock.avg || c.inA)} 不破再接`;
    } else if (c.ignitionActive) {
      kind = 'buy';
      badge = '🚀 爆发买点 · 可跟随';
      headline = '放量站稳 MA20 突破均线，主升拐点确立';
      triggerText = `回踩 ¥${f2(c.inA)} 附近低吸 · 止损 ¥${f2(c.slA)}`;
    } else if (c.mode === 'BUY') {
      const isNearBuy = distBuyPct != null && distBuyPct <= 1.2;
      kind = 'buy';
      badge = isNearBuy ? '✅ 当前买点 · 可低吸' : '🎯 接近买点 · 挂单等';
      headline = isNearBuy
        ? `缩量回踩到位，现价已进入低吸区（目标 ¥${f2(c.inA)}）`
        : `缩量回踩趋势良好，距第一买点 ¥${f2(c.inA)} 仅差 ${Math.abs(distBuyPct || 0).toFixed(1)}%`;
      triggerText = `一买 ¥${f2(c.inA)} / 二买 ¥${f2(c.inB)} · 止损 ¥${f2(c.slA)}`;
    } else if (c.mode === 'CUT' || chg >= 5.0 || (c.vsAvg != null && c.vsAvg >= 2.5)) {
      kind = 'warn';
      badge = '⚠️ 非买点 · 偏高勿追';
      headline = `日内涨幅/乖离偏大（${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%），切忌追高接盘`;
      triggerText = `耐心等回踩分时均线 ¥${f2(+stock.avg || c.inA)} 再考虑`;
    } else if (c.mode === 'REV') {
      kind = 'warn';
      badge = '⚠️ 非买点 · 无量拉升';
      headline = '上方无量拉升易回落，自选股切勿追买';
      triggerText = `等回落至 ¥${f2(c.inA)} 缩量企稳再看`;
    } else {
      kind = 'wait';
      badge = '⏳ 非买点 · 空间不足';
      headline = c.grid < 3
        ? `日内振幅仅 ${c.amp.toFixed(1)}%（不足3格），缺乏博弈空间`
        : '量价方向未明，继续观察等待明确低吸点';
      triggerText = `关注低吸位 ¥${f2(c.inA)} · 止损 ¥${f2(c.slA)}`;
    }
  } else {
    const hitStop = c.slA > 0 && px <= c.slA && pos.floatPct != null && pos.floatPct <= -3.5;
    if (hitStop || (c.brokenLock && pos.floatPct != null && pos.floatPct < 0)) {
      kind = 'stop';
      badge = '🚨 卖点 · 破位减仓/止损';
      headline = c.brokenLock
        ? `形态已破位（${c.breakDesc || '失守生命线'}），反抽即减仓`
        : `触及止损参考线 ¥${f2(c.slA)}，严防深套`;
      triggerText = `反抽 ¥${f2(c.outA)} 优先减仓 · 严禁向下补仓`;
    } else if (activeAnomaly?.type === 'limit_broken') {
      kind = 'sell';
      badge = '💥 卖点 · 炸板回落锁盈';
      headline = activeAnomaly.summary;
      triggerText = `优先减仓锁住利润，严禁在炸板回落途中补仓`;
    } else if (c.mode === 'CUT' || c.sellFlyTriggered || (activeAnomaly?.type === 'rocket_up' && px >= c.outA * 0.995)) {
      kind = 'sell';
      badge = activeAnomaly?.type === 'rocket_up' ? '🚀 急拉卖点 · 分批高抛' : '🔴 当前卖点 · 高抛兑现';
      headline = activeAnomaly?.type === 'rocket_up'
        ? `分时爆量急拉 +${activeAnomaly.deltaPct}% 逼近压力区，顺势分批倒T高抛`
        : c.sellFlyTriggered
        ? '已逼近/越过卖飞线，冲高分批锁盈（不追回）'
        : `进入 6 格以上亢奋区（${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%），逢高只减不接`;
      triggerText = `第一卖点 ¥${f2(c.outA)} / 第二卖点 ¥${f2(c.outB)}`;
    } else if (c.mode === 'REV') {
      const isNearSell = distSellPct != null && distSellPct <= 1.2;
      kind = 'sell';
      badge = isNearSell ? '🔴 当前卖点 · 倒T高抛' : '🟠 偏卖点 · 反弹先卖';
      headline = c.bear
        ? '日线空头压制，反弹到压力区先倒T降仓'
        : '无量拉升/分时顶背离，先高抛再等回落接回';
      triggerText = `高抛 ¥${f2(c.outA)} / ¥${f2(c.outB)} → 接回 ¥${f2(c.bkA)}`;
    } else if (activeAnomaly?.type === 'waterfall_down') {
      kind = 'warn';
      badge = '🌊 分时跳水 · 暂禁接飞刀';
      headline = activeAnomaly.summary;
      triggerText = `严禁急跌中补仓，等5分钟缩量止跌后再看 ¥${f2(c.inA)}`;
    } else if (c.mode === 'BUY' || c.ignitionActive) {
      if (hasRedNotice) {
        kind = 'stop';
        badge = `🚨 公告雷(${redNoticeTag}) · 禁正T补仓`;
        headline = `近35天有【${redNoticeTag}】利空，锁定正T买入，逢反抽优先减仓`;
        triggerText = `反抽 ¥${f2(c.outA)} 减仓避险 · 勿向下补仓`;
      } else if (isTiltLocked) {
        kind = 'warn';
        badge = '🛑 熔断期 · 禁正T仅可减仓';
        headline = '已触发单日防上头熔断锁，锁定正T低吸加仓，仅允许减仓或倒T高抛';
        triggerText = `反抽压力 ¥${f2(c.outA)} · 止损防守 ¥${f2(c.slA)}`;
      } else if (isRedSentiment) {
        kind = 'warn';
        badge = '🔴 情绪红灯 · 禁正T仅倒T';
        headline = `全市场红灯退潮（炸板率 ${sentiment.brokenRate ?? '—'}%），暂停正T低吸`;
        triggerText = `逢反抽 ¥${f2(c.outA)} 先倒T降仓`;
      } else {
        const isNearBuy = distBuyPct != null && distBuyPct <= 1.2;
        kind = 'buy';
        badge = c.ignitionActive
          ? '🚀 强攻买点 · 顺势正T'
          : (isNearBuy ? '🟢 当前买点 · 低吸正T' : '🟢 偏买点 · 挂单正T');
        headline = c.ignitionActive
          ? '放量站稳 MA20 突破，底仓拿稳并顺势做正T'
          : '缩量回踩支撑，可低吸做正T摊薄成本';
        triggerText = `低吸 ¥${f2(c.inA)} → T出目标 ¥${f2(c.tp1)} · 止损 ¥${f2(c.slA)}`;
      }
    } else {
      kind = hasRedNotice || isTiltLocked ? 'warn' : 'wait';
      badge = hasRedNotice
        ? `⚠️ 持仓预警 · 公告(${redNoticeTag})`
        : isTiltLocked
        ? '🔒 熔断观察 · 禁买可卖'
        : '⏳ 持股观望 · 区间震荡';
      headline = hasRedNotice
        ? `近35天检出【${redNoticeTag}】，切勿加仓，反抽择机减仓`
        : isTiltLocked
        ? '单日防上头熔断保护中，底仓只设止损/止盈不加仓'
        : (c.grid < 3
          ? `振幅仅 ${c.amp.toFixed(1)}%，差价难覆盖税费，底仓不动`
          : '未触发买卖阈值，持仓等待触及上下格位');
      triggerText = `低吸 ¥${f2(c.inA)} ｜ 高抛 ¥${f2(c.outA)}`;
    }
  }

  return {
    kind,
    badge,
    headline,
    triggerText,
    c,
    pos,
    chg,
    px,
    hasPos,
    hasRedNotice,
    redNoticeTag,
    activeAnomaly,
    isTiltLocked,
  };
}

/** 卡片内置：一键下单手数 / 以损定仓 / 盈亏比计算器 */
function OrderSizingCalc({ stock, sig, totalAssets, posRules, totalMktVal = 0, allowedCapPct = 80, onClose }) {
  const { c, px, pos } = sig;
  const assets = Math.max(1, +totalAssets || 100000);
  const singleMaxPct = posRules?.singleMaxPct ?? 30;
  const riskDefaultPct = posRules?.riskPerTradePct ?? 1.5;

  const defaultBudget = Math.max(5000, Math.round(assets * 0.1));
  const [budget, setBudget] = useState(String(defaultBudget));
  const [entryPx, setEntryPx] = useState(() => f2(c.inA > 0 ? c.inA : px));
  const [stopPx, setStopPx] = useState(() => f2(c.slA > 0 ? c.slA : px * 0.97));
  const [targetPx, setTargetPx] = useState(() => f2(c.tp1 > 0 ? c.tp1 : px * 1.04));

  const bNum = Math.max(0, parseFloat(budget) || 0);
  const eNum = Math.max(0.01, parseFloat(entryPx) || px || 1);
  const sNum = Math.max(0.01, parseFloat(stopPx) || eNum * 0.97);
  const tNum = Math.max(0.01, parseFloat(targetPx) || eNum * 1.04);

  const shares = Math.floor(bNum / (eNum * 100)) * 100;
  const actualAmt = shares * eNum;
  const comm = actualAmt > 0 ? Math.max(5, actualAmt * 0.00025) : 0;
  const riskPerShare = Math.max(0, eNum - sNum);
  const rewardPerShare = Math.max(0, tNum - eNum);
  const maxLoss = shares * riskPerShare + comm * 2 + actualAmt * 0.0005;
  const expGain = shares * rewardPerShare - (comm * 2 + actualAmt * 0.0005);
  const rrRatio = riskPerShare > 0 ? rewardPerShare / riskPerShare : 0;
  const lossPct = eNum > 0 ? ((sNum - eNum) / eNum) * 100 : 0;
  const gainPct = eNum > 0 ? ((tNum - eNum) / eNum) * 100 : 0;

  // 买入后单票占比 & 总仓位占比风控校验
  const curSingleMkt = pos?.curMkt || 0;
  const afterSinglePct = ((curSingleMkt + actualAmt) / assets) * 100;
  const afterTotalPct = ((totalMktVal + actualAmt) / assets) * 100;
  const overSingle = actualAmt > 0 && afterSinglePct > singleMaxPct + 0.1;
  const overTotal = actualAmt > 0 && afterTotalPct > allowedCapPct + 0.1;

  // 以损定仓：按「最大可承受亏损 = 总资产 × riskPct%」反推整手预算
  const applyRiskSizing = (riskPct) => {
    const rps = eNum - sNum;
    if (rps <= 0.005) return;
    const maxRiskAmt = (assets * riskPct) / 100;
    const rawShares = Math.floor(maxRiskAmt / rps / 100) * 100;
    const nextBudget = Math.max(0, Math.round(rawShares * eNum));
    setBudget(String(nextBudget));
  };

  const riskPresets = Array.from(new Set([1, riskDefaultPct, 2])).sort((a, b) => a - b);

  const handleCopyOrder = () => {
    const txt = [
      `【条件单预案】${stock.name} (${String(stock.code).padStart(6, '0')})`,
      `计划挂单买入：¥${f2(eNum)} × ${shares} 股（约 ¥${Math.round(actualAmt).toLocaleString('zh-CN')}，买后单票 ${afterSinglePct.toFixed(1)}% / 总仓 ${afterTotalPct.toFixed(1)}%）`,
      `止损防守价：¥${f2(sNum)}（${lossPct.toFixed(1)}%，最大回撤约 ¥${Math.round(maxLoss)}，占总资产 ${((maxLoss / assets) * 100).toFixed(2)}%）`,
      `止盈目标价：¥${f2(tNum)}（+${gainPct.toFixed(1)}%，预期收益约 ¥${Math.round(expGain)}）`,
      `盈亏比：1 : ${rrRatio.toFixed(2)}${stock.memo ? `\n买入逻辑：${stock.memo}` : ''}`,
    ].join('\n');
    copyPlain(txt, `已复制 ${stock.name} 下单与条件单参数`);
  };

  return (
    <div className="bc-calc-box" onClick={(e) => e.stopPropagation()}>
      <div className="bcc-head">
        <span>🧮 下单手数 &amp; 以损定仓试算（100股整手）</span>
        <button type="button" className="bcc-close" onClick={onClose}>✕</button>
      </div>

      <div className="bcc-presets">
        {riskPresets.map((rp) => (
          <button
            key={`risk-${rp}`}
            type="button"
            className="bcc-chip risk"
            onClick={() => applyRiskSizing(rp)}
            title={`以损定仓：若打到止损价 ¥${f2(sNum)}，最多只亏总资产的 ${rp}%（约 ¥${Math.round((assets * rp) / 100)}）`}
          >
            🛡️ 亏{rp}%定仓
          </button>
        ))}
        {[
          { label: '1成仓', val: Math.round(assets * 0.1) },
          { label: '2成仓', val: Math.round(assets * 0.2) },
          { label: '3成仓', val: Math.round(assets * 0.3) },
        ].map((p) => (
          <button
            key={p.label}
            type="button"
            className="bcc-chip"
            onClick={() => setBudget(String(p.val))}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="bcc-inputs">
        <label>
          <span>预算(元)</span>
          <input type="number" step="1000" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label>
          <span>挂单价</span>
          <input type="number" step="0.01" value={entryPx} onChange={(e) => setEntryPx(e.target.value)} />
        </label>
        <label>
          <span>止损价</span>
          <input type="number" step="0.01" value={stopPx} onChange={(e) => setStopPx(e.target.value)} />
        </label>
        <label>
          <span>止盈价</span>
          <input type="number" step="0.01" value={targetPx} onChange={(e) => setTargetPx(e.target.value)} />
        </label>
      </div>

      <div className="bcc-res">
        <div>
          可买 <b>{shares} 股</b>（¥{Math.round(actualAmt).toLocaleString('zh-CN')}）
        </div>
        <div>
          盈亏比 <b className={rrRatio >= 1.8 ? 'up' : rrRatio < 1.2 ? 'warn' : ''}>1 : {rrRatio.toFixed(2)}</b>
        </div>
        <div>
          止损约 <b className="down">-¥{Math.round(Math.max(0, maxLoss))}</b> ({lossPct.toFixed(1)}%)
        </div>
        <div>
          止盈约 <b className="up">+¥{Math.round(Math.max(0, expGain))}</b> (+{gainPct.toFixed(1)}%)
        </div>
      </div>

      {(overSingle || overTotal || sig.isTiltLocked) && (
        <div className="bcc-risk-warn">
          {sig.isTiltLocked && (
            <div>🔒 当前处于「单日防上头熔断期」，仅可试算参考，系统已锁定新开仓买入</div>
          )}
          {overSingle && (
            <div>⚠️ 买入后该股仓位将达 <b>{afterSinglePct.toFixed(1)}%</b>，超过单票红线 {singleMaxPct}%</div>
          )}
          {overTotal && (
            <div>🚨 买入后总仓位将达 <b>{afterTotalPct.toFixed(1)}%</b>，超过当前情绪上限 {allowedCapPct}%</div>
          )}
        </div>
      )}

      <div className="bcc-foot">
        <span className="bcc-fee">含单边佣金约 ¥{comm.toFixed(1)} + 印花税</span>
        <button type="button" className="bc-act-btn" onClick={handleCopyOrder}>
          📋 复制条件单参数
        </button>
      </div>
    </div>
  );
}

export default function BattleCardGrid({
  stocks = [],
  tradeLogs = [],
  totalAssets = 100000,
  sentiment = null,
  noticeRisks = {},
  posRules = null,
  tiltState = null,
  totalMktVal = 0,
  allowedCapPct = 80,
  expandedCode = '',
  onToggleExpand,
  onUpdateStock,
  onOpenQuickT,
  onJumpDiagnosis,
  onJumpIgnition,
  emptyTitle = '当前分组暂无标的',
  emptyHint = '可在上方输入框添加 6 位代码或股票名称，或从起爆挖掘 / 连板天梯一键加入。',
}) {
  const [editingMemoCode, setEditingMemoCode] = useState('');
  const [memoDraft, setMemoDraft] = useState('');
  const [calcOpenCode, setCalcOpenCode] = useState('');

  if (!stocks.length) {
    return (
      <div className="battle-empty">
        <div className="battle-empty-title">{emptyTitle}</div>
        <div className="battle-empty-hint">{emptyHint}</div>
      </div>
    );
  }

  const saveMemo = (stock) => {
    if (onUpdateStock) {
      onUpdateStock({ ...stock, memo: memoDraft.trim() });
    }
    setEditingMemoCode('');
  };

  return (
    <div className="battle-grid">
      {stocks.map((s) => {
        const code6 = String(s.code || '').padStart(6, '0');
        const isExpanded = expandedCode === code6;
        const isShort = s.tier === 'short' || s.poolTag === '短线';
        const noticeRisk = noticeRisks?.[code6] || null;
        const sig = buildActionSignal(s, { sentiment, noticeRisk, tiltState });
        const { c, pos, chg, px, hasPos, activeAnomaly, isTiltLocked } = sig;
        const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
        const tStatus = hasPos ? getTodayTStatus(s, tradeLogs) : null;
        const isEditingMemo = editingMemoCode === code6;
        const isCalcOpen = calcOpenCode === code6;

        return (
          <div
            key={code6}
            className={`battle-card kind-${sig.kind} ${isExpanded ? 'is-expanded' : ''}`}
            onClick={() => onToggleExpand && onToggleExpand(code6)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (onToggleExpand) onToggleExpand(code6);
              }
            }}
            title={isExpanded ? '点击收起完整做T面板' : '点击展开完整K线、分时与挂单面板'}
          >
            {/* 头部：标的名称 + 持仓/自选标签 + 实时价 */}
            <div className="bc-top">
              <div className="bc-ident">
                <div className="bc-name-row">
                  <span className="bc-name">{s.name || code6}</span>
                  <span className="bc-code">{code6}</span>
                </div>
                <div className="bc-tags">
                  <span className={`bc-role ${hasPos ? 'is-pos' : 'is-watch'}`}>
                    {hasPos ? `📦 持仓 ${pos.sh}股` : '👀 自选观察'}
                  </span>
                  <span className={`bc-tier ${isShort ? 'is-short' : 'is-long'}`}>
                    {isShort ? '⚡ 短线' : '🛡️ 稳健'}
                  </span>
                  {s.strategyTag && <span className="bc-strat">{s.strategyTag}</span>}
                </div>
              </div>

              <div className="bc-price-box">
                <div className={`bc-price ${chgCls}`}>¥{f2(px)}</div>
                <div className={`bc-chg ${chgCls}`}>
                  {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* 持仓专属：T+1 今日可卖 / 锁定股数条 */}
            {hasPos && tStatus && (
              <div className="bc-t1-row">
                <span className={`bc-t1-pill ${tStatus.sellableShares > 0 ? 'ok' : 'lock'}`}>
                  {tStatus.isFirstDayLocked
                    ? `🔒 T+1 首日锁仓（今日可卖 0 股）`
                    : `🔓 今日可卖 ${tStatus.sellableShares} 股`}
                </span>
                {tStatus.t1LockedShares > 0 && !tStatus.isFirstDayLocked && (
                  <span className="bc-t1-lock">今日新买锁定 {tStatus.t1LockedShares} 股</span>
                )}
              </div>
            )}

            {/* 盘中分时放量急拉 / 跳水 / 冲板回落实时异动雷达条 */}
            {activeAnomaly && (
              <div className={`bc-anomaly-bar ${activeAnomaly.level === 'surge' ? 'surge' : 'danger'}`}>
                <span className="bc-anomaly-badge">{activeAnomaly.badge}</span>
                <span className="bc-anomaly-txt">
                  {activeAnomaly.deltaPct > 0 ? '+' : ''}{activeAnomaly.deltaPct}%
                  {activeAnomaly.volBurst ? ` · 量能${activeAnomaly.volBurst}×` : ''}
                  {activeAnomaly.time ? ` (${activeAnomaly.time.slice(0, 5)})` : ''}
                </span>
              </div>
            )}

            {/* 核心买卖点判定条 */}
            <div className={`bc-verdict kind-${sig.kind}`}>
              <div className="bc-v-head">
                <span className="bc-v-badge">{sig.badge}</span>
                <span className="bc-v-trend">日线{c.trend} · {c.grid.toFixed(1)}格</span>
              </div>
              <div className="bc-v-line">{sig.headline}</div>
            </div>

            {/* 买入 / 观察逻辑备忘锚点（就地编辑，防盘中情绪化乱操作） */}
            <div className="bc-memo-wrap" onClick={(e) => e.stopPropagation()}>
              {isEditingMemo ? (
                <div className="bc-memo-edit">
                  <input
                    type="text"
                    autoFocus
                    placeholder="记一句逻辑锚：如「回踩20日线博二波，破18.2认错」"
                    value={memoDraft}
                    onChange={(e) => setMemoDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveMemo(s);
                      if (e.key === 'Escape') setEditingMemoCode('');
                    }}
                  />
                  <button type="button" className="bc-memo-save" onClick={() => saveMemo(s)}>
                    保存
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={`bc-memo-btn ${s.memo ? 'has-memo' : ''}`}
                  onClick={() => {
                    setMemoDraft(s.memo || '');
                    setEditingMemoCode(code6);
                  }}
                  title="点击编辑一句话买入/观察逻辑锚"
                >
                  <span className="bc-memo-ico">📝</span>
                  <span className="bc-memo-txt">
                    {s.memo || '记一句买入/观察逻辑（如：缩量回踩20日线低吸，破位认错）'}
                  </span>
                </button>
              )}
            </div>

            {/* 关键价位三宫格 */}
            {hasPos ? (
              <div className="bc-metrics">
                <div className="bc-m">
                  <span className="k">成本 / 浮盈</span>
                  <span className={`v ${pos.floatPL > 0 ? 'up' : pos.floatPL < 0 ? 'down' : ''}`}>
                    {pos.floatPct != null ? `${pos.floatPct >= 0 ? '+' : ''}${pos.floatPct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="d">成本 ¥{f2(pos.cost)} · {pos.floatPL >= 0 ? '+' : ''}¥{money(pos.floatPL)}</span>
                </div>
                <div className="bc-m">
                  <span className="k">高抛/卖点</span>
                  <span className="v up">¥{f2(c.outA)}</span>
                  <span className="d">二卖 ¥{f2(c.outB)}</span>
                </div>
                <div className="bc-m">
                  <span className="k">低吸/接回</span>
                  <span className="v down">¥{f2(c.inA)}</span>
                  <span className="d">止损 ¥{f2(c.slA)}</span>
                </div>
              </div>
            ) : (
              <div className="bc-metrics">
                <div className="bc-m">
                  <span className="k">低吸买点</span>
                  <span className="v down">¥{f2(c.inA)}</span>
                  <span className="d">二买 ¥{f2(c.inB)}</span>
                </div>
                <div className="bc-m">
                  <span className="k">压力/止盈</span>
                  <span className="v up">¥{f2(c.tp1)}</span>
                  <span className="d">上沿 ¥{f2(c.outA)}</span>
                </div>
                <div className="bc-m">
                  <span className="k">止损底线</span>
                  <span className="v warn">¥{f2(c.slA)}</span>
                  <span className="d">量比 {f2(c.vr)}</span>
                </div>
              </div>
            )}

            {/* 内置一键下单手数 & 盈亏比计算器（点击底部 🧮 算手数 展开） */}
            {isCalcOpen && (
              <OrderSizingCalc
                stock={s}
                sig={sig}
                totalAssets={totalAssets}
                posRules={posRules}
                totalMktVal={totalMktVal}
                allowedCapPct={allowedCapPct}
                onClose={() => setCalcOpenCode('')}
              />
            )}

            {/* 底部联动操作条 */}
            <div className="bc-foot" onClick={(e) => e.stopPropagation()}>
              <div className="bc-links">
                <button
                  type="button"
                  className="bc-act-btn"
                  onClick={() => onJumpDiagnosis && onJumpDiagnosis(code6)}
                  title="跳转个股全景诊股（公告排雷 + 筹码 + 形态）"
                >
                  🩺 诊股
                </button>
                <button
                  type="button"
                  className="bc-act-btn"
                  onClick={() => onJumpIgnition && onJumpIgnition(code6)}
                  title="跳转起爆成色六维体检"
                >
                  🚀 起爆
                </button>
                <button
                  type="button"
                  className={`bc-act-btn ${isCalcOpen ? 'active' : ''}`}
                  onClick={() => setCalcOpenCode((prev) => (prev === code6 ? '' : code6))}
                  title="按资金与止损位一键测算可买整手股数与盈亏比"
                >
                  🧮 算手数
                </button>
                <button
                  type="button"
                  className={`bc-act-btn ${!hasPos && isTiltLocked ? 'is-locked' : ''}`}
                  onClick={() => {
                    if (!hasPos && isTiltLocked) {
                      toastWarn('🔒 单日防上头熔断保护中：已暂停新开仓买入，请先在上方风控条冷静复盘');
                      return;
                    }
                    if (onOpenQuickT) {
                      onOpenQuickT(s, hasPos ? (isTiltLocked ? '倒T' : '正T') : '买入建仓', px);
                    }
                  }}
                  title={
                    !hasPos && isTiltLocked
                      ? '防上头熔断保护中，暂禁新开仓'
                      : hasPos
                      ? isTiltLocked
                        ? '熔断期仅允许记录减仓卖出或倒T高抛'
                        : '快捷记录做T或买卖流水'
                      : '记录首次买入建仓（自动转入实盘持仓）'
                  }
                >
                  {hasPos ? (isTiltLocked ? '⚡ 减仓/倒T' : '⚡ 记T') : (isTiltLocked ? '🔒 熔断禁买' : '＋ 建仓')}
                </button>
              </div>
              <button
                type="button"
                className={`bc-expand-btn ${isExpanded ? 'open' : ''}`}
                onClick={() => onToggleExpand && onToggleExpand(code6)}
              >
                {isExpanded ? '收起 ▴' : '详情 ▾'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
