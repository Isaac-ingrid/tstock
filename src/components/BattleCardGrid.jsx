import React from 'react';
import { calc, posCalc } from '../services/api.js';
import { f2, money } from '../services/utils.js';

/**
 * 根据「自选观察」vs「实盘持仓」分别生成清晰、直白的买卖点判定结论：
 * - 自选（shares === 0）：明确回答「现在是不是买点？」+ 目标低吸价/止损价
 * - 持仓（shares > 0）：明确回答「现在是卖点、买点、止损还是持股观望？」+ 浮盈与触发价
 */
export function buildActionSignal(stock) {
  const pc = +stock.prevClose || 0;
  const px = +stock.price || pc;
  const chg = pc > 0 ? ((px - pc) / pc) * 100 : 0;
  const pos = posCalc(stock);
  const c = calc(stock);
  const hasPos = pos.sh > 0;

  const distBuyPct = px > 0 && c.inA > 0 ? ((px - c.inA) / px) * 100 : null;
  const distSellPct = px > 0 && c.outA > 0 ? ((c.outA - px) / px) * 100 : null;

  // 默认结构
  let kind = 'wait'; // 'buy' | 'sell' | 'stop' | 'warn' | 'wait'
  let badge = '⏳ 暂观望';
  let headline = '信号未明，先看戏不动';
  let triggerText = c.inA > 0 ? `参考低吸 ¥${f2(c.inA)} · 压力 ¥${f2(c.outA)}` : '等待行情同步';

  if (!hasPos) {
    // ===== 自选观察股：只关心「现在是不是买点」 =====
    if (c.brokenLock || c.bear) {
      kind = 'stop';
      badge = '🚫 非买点 · 禁接飞刀';
      headline = c.brokenLock ? `形态破位（${c.breakDesc || '失守支撑'}），严禁抄底` : '日线空头反压，暂不建仓';
      triggerText = `观望等重新站稳均线，上方压力 ¥${f2(c.outA)}`;
    } else if (c.mktLevel === 'BAD') {
      kind = 'warn';
      badge = '⛔ 非买点 · 大盘否决';
      headline = '指数破位日暂停新开仓，管住手';
      triggerText = `等指数收回 MA20 后再看 ¥${f2(c.inA)} 附近`;
    } else if (c.ignitionActive) {
      kind = 'buy';
      badge = '🚀 爆发买点 · 可跟随';
      headline = '放量突破关键均线，主升拐点确立';
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
    // ===== 实盘持仓股：关心「卖点 / 正T买点 / 止损 / 持股」 =====
    const hitStop = c.slA > 0 && px <= c.slA && pos.floatPct != null && pos.floatPct <= -3.5;
    if (hitStop || (c.brokenLock && pos.floatPct != null && pos.floatPct < 0)) {
      kind = 'stop';
      badge = '🚨 卖点 · 破位减仓/止损';
      headline = c.brokenLock
        ? `形态已破位（${c.breakDesc || '失守生命线'}），反抽即减仓`
        : `触及止损参考线 ¥${f2(c.slA)}，严防深套`;
      triggerText = `反抽 ¥${f2(c.outA)} 优先减仓 · 严禁向下补仓`;
    } else if (c.mode === 'CUT' || c.sellFlyTriggered) {
      kind = 'sell';
      badge = '🔴 当前卖点 · 高抛兑现';
      headline = c.sellFlyTriggered
        ? '已逼近/越过卖飞线，冲高分批锁盈（不追回）'
        : `进入 6 格以上亢奋区（${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%），逢高只减不接`;
      triggerText = `第一卖点 ¥${f2(c.outA)} / 第二卖点 ¥${f2(c.outB)}`;
    } else if (c.mode === 'REV') {
      const isNearSell = distSellPct != null && distSellPct <= 1.2;
      kind = 'sell';
      badge = isNearSell ? '🔴 当前卖点 · 倒T高抛' : '🟠 偏卖点 · 反弹先卖';
      headline = c.bear
        ? '日线空头压制，反弹到压力区先倒T降仓'
        : '无量拉升滞涨，先高抛再等回落接回';
      triggerText = `高抛 ¥${f2(c.outA)} / ¥${f2(c.outB)} → 接回 ¥${f2(c.bkA)}`;
    } else if (c.mode === 'BUY' || c.ignitionActive) {
      const isNearBuy = distBuyPct != null && distBuyPct <= 1.2;
      kind = 'buy';
      badge = c.ignitionActive
        ? '🚀 强攻买点 · 顺势正T'
        : (isNearBuy ? '🟢 当前买点 · 低吸正T' : '🟢 偏买点 · 挂单正T');
      headline = c.ignitionActive
        ? '放量爆发确立，底仓拿稳并顺势做正T'
        : `缩量回踩支撑，可低吸做正T摊薄成本`;
      triggerText = `低吸 ¥${f2(c.inA)} → T出目标 ¥${f2(c.tp1)} · 止损 ¥${f2(c.slA)}`;
    } else {
      kind = 'wait';
      badge = '⏳ 持股观望 · 区间震荡';
      headline = c.grid < 3
        ? `振幅仅 ${c.amp.toFixed(1)}%，差价难覆盖税费，底仓不动`
        : '未触发买卖阈值，持仓等待触及上下格位';
      triggerText = `低吸 ¥${f2(c.inA)} ｜ 高抛 ¥${f2(c.outA)}`;
    }
  }

  return { kind, badge, headline, triggerText, c, pos, chg, px, hasPos };
}

export default function BattleCardGrid({
  stocks = [],
  expandedCode = '',
  onToggleExpand,
  onOpenQuickT,
  onJumpDiagnosis,
  onJumpIgnition,
  emptyTitle = '当前分组暂无标的',
  emptyHint = '可在上方输入框添加 6 位代码或股票名称，或从起爆挖掘 / 连板天梯一键加入。',
}) {
  if (!stocks.length) {
    return (
      <div className="battle-empty">
        <div className="battle-empty-title">{emptyTitle}</div>
        <div className="battle-empty-hint">{emptyHint}</div>
      </div>
    );
  }

  return (
    <div className="battle-grid">
      {stocks.map((s) => {
        const code6 = String(s.code || '').padStart(6, '0');
        const isExpanded = expandedCode === code6;
        const isShort = s.tier === 'short' || s.poolTag === '短线';
        const sig = buildActionSignal(s);
        const { c, pos, chg, px, hasPos } = sig;
        const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';

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
                  {s.strategyTag && (
                    <span className="bc-strat">{s.strategyTag}</span>
                  )}
                </div>
              </div>

              <div className="bc-price-box">
                <div className={`bc-price ${chgCls}`}>¥{f2(px)}</div>
                <div className={`bc-chg ${chgCls}`}>
                  {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* 核心买卖点判定条 */}
            <div className={`bc-verdict kind-${sig.kind}`}>
              <div className="bc-v-head">
                <span className="bc-v-badge">{sig.badge}</span>
                <span className="bc-v-trend">日线{c.trend} · {c.grid.toFixed(1)}格</span>
              </div>
              <div className="bc-v-line">{sig.headline}</div>
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
                  className="bc-act-btn"
                  onClick={() => onOpenQuickT && onOpenQuickT(s, hasPos ? '正T' : '买入建仓', px)}
                  title={hasPos ? '快捷记录做T或买卖流水' : '记录首次买入建仓（自动转入实盘持仓）'}
                >
                  {hasPos ? '⚡ 记T' : '＋ 建仓'}
                </button>
              </div>
              <button
                type="button"
                className={`bc-expand-btn ${isExpanded ? 'open' : ''}`}
                onClick={() => onToggleExpand && onToggleExpand(code6)}
              >
                {isExpanded ? '收起面板 ▴' : '展开详情 ▾'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
