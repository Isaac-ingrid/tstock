import React, { useState, useEffect } from 'react';
import { f2, pct, money, money$, fmtIn, GRID, TIER_LABEL, AUTO_FIELDS, AUTO_FIELD_LABELS, toastOk, toastErr, calcTBreakeven, getTodayTStatus, todayStr } from '../services/utils.js';
import { calc, posCalc, computeTA, rsCalc, drawRS, computeExperimentalATRGrid, computeExperimentalStockDNA } from '../services/api.js';
import { getAuctionTier, computeAuctionPattern, computeLimitUpRigidity, computeNextDayExitDecision } from '../services/auction.js';
import ChartCanvas from './ChartCanvas.jsx';
import TechAndResearchSection from './TechAndResearchSection.jsx';

export const MODE_BADGE = {
  BUY: ['buy', '正T'],
  REV: ['rev', '倒T'],
  CUT: ['cut', '只减'],
  WAIT: ['wait', '观望']
};

export default function StockCard({
  stock,
  index,
  isCur = true,
  tradeLogs,
  isTailAlertTime = false,
  simTailAlert = false,
  onUpdateStock,
  onBuyStock,
  onRemoveStock,
  onOpenQuickT,
  onOpenReason,
  onRefreshSingle,
  onCopySinglePlan
}) {
  const [quoteFoldOpen, setQuoteFoldOpen] = useState(false);
  const [chartFoldOpen, setChartFoldOpen] = useState(!!stock._fo);
  const [manualValues, setManualValues] = useState(stock.manual || {});

  // 买入/加仓输入状态
  const [buyQtyStr, setBuyQtyStr] = useState('');
  const [buyPxStr, setBuyPxStr] = useState(() => (stock.price ? String(f2(stock.price)) : ''));
  // 底仓校准开关与状态（供纠错或对齐券商底仓，不记录买入流水）
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibSharesStr, setCalibSharesStr] = useState(() => (stock.shares ? String(stock.shares) : ''));
  const [calibCostStr, setCalibCostStr] = useState(() => (stock.cost ? String(stock.cost) : ''));

  useEffect(() => {
    setCalibSharesStr(stock.shares ? String(stock.shares) : '');
    setCalibCostStr(stock.cost ? String(stock.cost) : '');
  }, [stock.shares, stock.cost, stock.code]);

  const c = calc(stock);
  const cls = c.chg >= 0 ? 'up' : 'down';
  const pos = posCalc(stock);
  const ta = stock._ta || computeTA(stock);
  const mbd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;
  const isShortTier = (stock.tier === 'short' || stock.poolTag === '短线');
  const aucPattern = computeAuctionPattern(stock);
  const limitRig = computeLimitUpRigidity(stock);
  const exitDecision = computeNextDayExitDecision(stock);
  const atrExp = computeExperimentalATRGrid(stock);
  const dnaExp = computeExperimentalStockDNA(stock);

  const handleConvertToLongT = () => {
    const nextTier = 'long';
    const nextPoolTag = '稳健';
    onUpdateStock({
      ...stock,
      tier: nextTier,
      poolTag: nextPoolTag
    });
    toastOk(`已成功将 ${stock.name || stock.code} 转入稳健底仓做T池！打板浮盈已锁定，后续建议按分时均价波段高抛低吸。`);
  };

  // 获取今日做T台账与未平仓持仓状态
  const effectiveTradeLogs = tradeLogs || (() => {
    try {
      const raw = localStorage.getItem('t-system-log');
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  })();
  const todayT = getTodayTStatus(stock, effectiveTradeLogs);

  // 14:40 尾盘清T预警触发判定 (14:40~15:00 或开启演练模拟)
  const isTailRiskTime = (() => {
    if (simTailAlert) return true;
    if (isTailAlertTime) return true;
    const now = new Date();
    const wd = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();
    return (wd >= 1 && wd <= 5 && mins >= 880 && mins < 900);
  })();

  // 做T保本价计算器状态
  const [beCalcOpen, setBeCalcOpen] = useState(false);
  const [beMode, setBeMode] = useState(() => (c.mode === 'REV' || c.mode === 'CUT' ? 'REV' : 'BUY'));
  const [beEntryPxStr, setBeEntryPxStr] = useState(() => {
    if (c.mode === 'REV' || c.mode === 'CUT') {
      return c.outA ? String(f2(c.outA)) : (stock.price ? String(f2(stock.price)) : '');
    }
    return c.inA ? String(f2(c.inA)) : (stock.price ? String(f2(stock.price)) : '');
  });
  const [beQtyStr, setBeQtyStr] = useState(() => (
    stock.shares && stock.shares > 0 ? String(Math.min(stock.shares, 1000)) : (stock.tier === 'short' ? '1000' : '500')
  ));
  const [beCommRate, setBeCommRate] = useState(0.00025); // 万2.5
  const [beHasMin5, setBeHasMin5] = useState(true); // 默认五元起收
  const [beSlippage, setBeSlippage] = useState(0); // 滑点 0 / 1 / 2 分

  // 响应行情或建议点位更新计算器开仓默认值（若未手动微调）
  useEffect(() => {
    if (!beEntryPxStr) {
      if (beMode === 'REV') {
        setBeEntryPxStr(c.outA ? String(f2(c.outA)) : (stock.price ? String(f2(stock.price)) : ''));
      } else {
        setBeEntryPxStr(c.inA ? String(f2(c.inA)) : (stock.price ? String(f2(stock.price)) : ''));
      }
    }
  }, [c.inA, c.outA, stock.price, beMode]);

  const pxNow = +stock.price || 0;
  const beResult = calcTBreakeven({
    mode: beMode,
    entryPx: parseFloat(beEntryPxStr) || pxNow || 10,
    qty: parseInt(beQtyStr, 10) || 1000,
    commRate: beCommRate,
    hasMin5: beHasMin5,
    stampTax: 0.0005,
    transferRate: 0.00001,
    slippageTicks: beSlippage
  });
  stock.bePrice = beResult.targetPx;
  stock.beSpread = beResult.spread;
  stock.bePctDiff = beResult.pctDiff;

  // 评估保本所需点差与全天振幅匹配可行性
  const ampCur = c.amp || 0;
  const beAmpRatio = ampCur > 0 ? (beResult.pctDiff / ampCur) * 100 : 0;
  let beFeasibility = {
    status: 'safe',
    icon: '🟢',
    title: '空间充裕 · 做T良机',
    color: 'var(--down)',
    bg: 'var(--down-bg)',
    border: 'var(--down-b)',
    desc: `保本仅需点差 ¥${f2(beResult.spread)} (+${beResult.pctDiff.toFixed(2)}%)，仅占今日振幅的 ${beAmpRatio.toFixed(0)}%，规费摩擦可被充分覆盖。`
  };
  if (ampCur > 0 && beResult.pctDiff >= ampCur) {
    beFeasibility = {
      status: 'danger',
      icon: '🚨',
      title: '空间死锁 · 严禁开T',
      color: 'var(--up-d)',
      bg: 'var(--up-bg)',
      border: 'var(--up-b)',
      desc: `保本所需涨幅 (${beResult.pctDiff.toFixed(2)}%) ≥ 今日全天振幅 (${ampCur.toFixed(2)}%)！规费摩擦严重吃光空间，开T必被手续费反噬！`
    };
  } else if (ampCur > 0 && beResult.pctDiff >= ampCur * 0.45) {
    beFeasibility = {
      status: 'warn',
      icon: '⚠️',
      title: '空间偏紧 · 容错率低',
      color: 'var(--warn-d)',
      bg: 'var(--warn-bg)',
      border: 'var(--warn-b)',
      desc: `保本需消耗今日振幅的 ${beAmpRatio.toFixed(0)}%，利润空间狭窄，严禁追高，需严格在日内极值支撑位轻仓试T。`
    };
  }

  const openGap = (stock.open > 0 && stock.prevClose > 0)
    ? ((stock.open - stock.prevClose) / stock.prevClose) * 100
    : null;
  const aucTier = openGap != null ? getAuctionTier(openGap) : null;

  const handleToggleTier = () => {
    const nextTier = (stock.tier === 'short' || stock.poolTag === '短线') ? 'long' : 'short';
    onUpdateStock({ ...stock, tier: nextTier, poolTag: nextTier === 'short' ? '短线' : '稳健' });
  };

  const handleManualChange = (k, val) => {
    const nextMan = { ...manualValues, [k]: val === '' ? undefined : +val };
    if (val === '') delete nextMan[k];
    setManualValues(nextMan);
    onUpdateStock({
      ...stock,
      [k]: val === '' ? stock[k] : +val,
      manual: nextMan
    });
  };

  const handleClearManual = () => {
    setManualValues({});
    const clean = { ...stock, manual: {} };
    onUpdateStock(clean);
  };

  const oldShares = stock.shares || 0;
  const oldCost = stock.cost || 0;
  const inputBuyQty = parseInt(buyQtyStr, 10);
  const inputBuyPx = parseFloat(buyPxStr);
  const isBuyInputValid = !isNaN(inputBuyQty) && inputBuyQty > 0 && !isNaN(inputBuyPx) && inputBuyPx > 0;

  let trialNewShares = 0;
  let trialNewCost = 0;
  let trialCostDiff = 0;
  let trialTotalCapital = 0;

  if (isBuyInputValid) {
    trialNewShares = oldShares + inputBuyQty;
    const oldCap = oldShares * oldCost;
    const addedCap = inputBuyQty * inputBuyPx;
    trialTotalCapital = addedCap;
    trialNewCost = Math.round(((oldCap + addedCap) / trialNewShares) * 100) / 100;
    trialCostDiff = trialNewCost - oldCost;
  }

  // 执行买入建仓或加仓（支持加权平均均价重算与流水写入）
  const handleExecuteBuy = () => {
    if (!isBuyInputValid) {
      toastErr('请输入有效的买入股数与买入价格');
      return;
    }
    if (onBuyStock) {
      onBuyStock({ stock, qty: inputBuyQty, buy: inputBuyPx });
    } else {
      const newShares = oldShares + inputBuyQty;
      const newCost = Math.round(((oldShares * oldCost + inputBuyQty * inputBuyPx) / newShares) * 100) / 100;
      onUpdateStock({ ...stock, shares: newShares, cost: newCost });
      toastOk(`🎯 【${stock.name}】买入成功：${inputBuyQty} 股，最新均价 ¥${f2(newCost)}`);
    }
    setBuyQtyStr('');
  };

  // 保存直接校准底仓（不生成买入交易流水，仅校准持仓）
  const handleSaveCalibration = () => {
    const sVal = parseInt(calibSharesStr, 10);
    const cVal = parseFloat(calibCostStr);
    const newShares = isNaN(sVal) || sVal < 0 ? 0 : sVal;
    const newCost = isNaN(cVal) || cVal < 0 ? 0 : Math.round(cVal * 100) / 100;

    if (onBuyStock) {
      onBuyStock({
        stock,
        isCalibration: true,
        newSharesOverride: newShares,
        newCostOverride: newCost
      });
    } else {
      onUpdateStock({ ...stock, shares: newShares, cost: newCost });
      toastOk(`✅ 已成功校准【${stock.name}】底仓：${newShares} 股，成本均价 ¥${f2(newCost)}`);
    }
    setIsCalibrating(false);
  };

  // 12-tier Table rows
  const hasHoldings = (stock.shares || 0) > 0 && (stock.cost || 0) > 0;
  const floatProfit = hasHoldings ? (pxNow - stock.cost) * stock.shares : 0;
  const floatRate = hasHoldings ? ((pxNow - stock.cost) / stock.cost) * 100 : 0;
  const curMarketVal = (stock.shares || 0) * pxNow;

  const rows = [
    [6, '禁止新开正T区', 'none'],
    [5, '强势区·只减', 'sell'],
    [4, '倒T第二减仓位', 'sell'],
    [3, '倒T第一减仓位', 'sell'],
    [2, '倒T观察位', 'none'],
    [1, '正T止盈上限', 'sell'],
    [0, '基准·正T止盈位', 'buy'],
    [-1, '浅回踩观察', 'none'],
    [-2, '正T第一买点', 'buy'],
    [-3, '正T第二买点', 'buy'],
    [-4, '深水区·需缩量企稳', 'none'],
    [-6, '破位·停止做T', 'none']
  ].map(([k, label, act]) => {
    const p = c.pc * (1 + k * GRID / 100);
    const isNow = pxNow ? Math.abs(pxNow - p) <= c.pc * GRID / 800 : false;
    const dNow = pxNow ? ((p - pxNow) / pxNow) * 100 : null;
    const pill = act === 'buy' ? <span className="pill p-buy">买点</span>
      : act === 'sell' ? <span className="pill p-sell">卖点</span>
        : <span className="pill p-none">观察</span>;

    return (
      <tr key={k} className={act === 'buy' ? 'act-buy' : act === 'sell' ? 'act-sell' : ''}>
        <td style={{ color: 'var(--sub)' }}>{k > 0 ? '+' : ''}{(k * GRID).toFixed(2)}%</td>
        <td style={{ fontFamily: 'ui-monospace,Consolas,monospace', color: act === 'buy' ? 'var(--down)' : act === 'sell' ? 'var(--up)' : 'var(--text)' }}>
          {f2(p)}
        </td>
        <td style={{ textAlign: 'right', fontFamily: 'ui-monospace,Consolas,monospace', color: dNow == null ? 'var(--sub)' : dNow > 0 ? 'var(--up)' : dNow < 0 ? 'var(--down)' : 'var(--text)' }}>
          {dNow == null ? '—' : (dNow >= 0 ? '+' : '') + dNow.toFixed(2) + '%'}
        </td>
        <td>
          {label}{isNow && <b style={{ color: 'var(--info)', marginLeft: '4px' }}>◀现价</b>}
        </td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          {pill}
          {(act === 'buy' || act === 'sell') && (
            <button
              className="pill-act"
              title={`以此价格 ${f2(p)} 快速记一笔做T`}
              onClick={() => onOpenQuickT(stock, act === 'buy' ? '正T' : '倒T', f2(p))}
            >
              ⚡ 记T
            </button>
          )}
        </td>
      </tr>
    );
  });

  const gNow = c.chg / GRID;
  const kLo = Math.floor(gNow), kHi = kLo + 1;
  const pLo = c.pc * (1 + kLo * GRID / 100), pHi = c.pc * (1 + kHi * GRID / 100);
  const dLo = pxNow ? ((pLo - pxNow) / pxNow) * 100 : null;
  const dHi = pxNow ? ((pHi - pxNow) / pxNow) * 100 : null;

  return (
    <div
      className={`card m-${mbd[0]} ${isCur ? 'is-cur' : ''}`}
      id={`stockCard_${stock.code}`}
      data-card-code={stock.code}
      data-card-index={index}
      data-tier={stock.tier || 'short'}
    >
      {/* 头部信息 */}
      <div className="card-hd">
        <span className="nm">{stock.name}</span>
        <span className="cd">{stock.code}</span>
        <span
          className={`tier-tag t-${stock.tier || 'short'}`}
          onClick={handleToggleTier}
          title={`当前：${TIER_LABEL[stock.tier || 'short']}，点击切换`}
          style={{ cursor: 'pointer' }}
        >
          {TIER_LABEL[stock.tier || 'short']}
        </span>
        <span className={`mg ${mbd[0]}`}>{mbd[1]}</span>
        {c.brokenLock && (
          <span
            className="snap-tag"
            style={{ background: 'var(--up-bg)', borderColor: 'var(--up-b)', color: 'var(--up-d)', fontWeight: 700 }}
            title="技术形态破位防套锁已触发，严禁正T低吸接飞刀"
          >
            ⛔ 破位防套锁
          </span>
        )}
        {c.ignitionActive && (
          <span
            className="snap-tag"
            style={{ background: 'var(--down-bg)', borderColor: 'var(--down-b)', color: 'var(--down-d)', fontWeight: 700 }}
            title="放量突破爆发点已确立，转入主升进攻"
          >
            🚀 爆发点启动
          </span>
        )}
        {c.reversalActive && !c.brokenLock && !c.ignitionActive && (
          <span
            className="snap-tag"
            style={{ background: 'var(--teal-bg)', borderColor: 'var(--teal-b)', color: 'var(--teal)', fontWeight: 700 }}
            title="阴跌后缩量止跌十字星，空头竭尽准备试T"
          >
            👀 {c.reversalTag || '止跌十字星'}
          </span>
        )}
        {isShortTier && aucPattern && aucPattern.isWeakToStrong && (
          <span
            className="snap-tag"
            style={{ background: '#fff1f0', borderColor: '#ffa39e', color: '#cf1322', fontWeight: 700 }}
            title={aucPattern.desc}
          >
            🚀 弱转强逆转
          </span>
        )}
        {limitRig && limitRig.isLimitUp && (
          <span
            className="snap-tag"
            style={{ background: limitRig.badgeBg, borderColor: limitRig.badgeColor, color: limitRig.badgeColor, fontWeight: 700 }}
            title={`涨停封死 · 硬度得分 ${limitRig.hardnessScore}/100 ｜ 封成比 ${limitRig.sealRatio.toFixed(2)}倍 ｜ 封单额 ¥${money$(limitRig.sealAmtYuan)}`}
          >
            {limitRig.label}
          </span>
        )}
        {limitRig && limitRig.isBroken && (
          <span
            className="snap-tag tail-alert-pulse"
            style={{ background: '#fff1f0', borderColor: '#ff4d4f', color: '#cf1322', fontWeight: 800 }}
            title={`曾涨停已被砸开，当前自涨停回落 ${Math.abs(limitRig.brokenDrop).toFixed(1)}%！严禁盲目打板！`}
          >
            🚨 曾炸板回落
          </span>
        )}
        {limitRig && limitRig.isNearLimit && !limitRig.isLimitUp && !limitRig.isBroken && (
          <span
            className="snap-tag"
            style={{ background: '#e6f4ff', borderColor: '#91caff', color: '#0958d9', fontWeight: 700 }}
            title={`今日涨幅接近涨停（现价距涨停仅差 ${limitRig.distCeiling.toFixed(1)}%），处于打板排单观察期`}
          >
            ⚡ 逼近涨停 ({limitRig.chg >= 0 ? '+' : ''}${limitRig.chg.toFixed(1)}%)
          </span>
        )}
        {limitRig && limitRig.hadPrevLimitUp && !limitRig.isLimitUp && !limitRig.isBroken && (
          <span
            className="snap-tag"
            style={{ background: '#f6ffed', borderColor: '#b7eb8f', color: '#389e0d', fontWeight: 700 }}
            title="前一天收盘涨停，今日具备连板接力观察背景"
          >
            🎯 昨涨停连板标的
          </span>
        )}
        {todayT.isFirstDayLocked && (
          <span
            className="snap-tag"
            style={{ background: '#f1f5f9', borderColor: '#cbd5e1', color: '#475569', fontWeight: 700 }}
            title={`A股 T+1 冻结：今日新买 ${todayT.t1LockedShares} 股当日无法卖出（明日开盘后才可卖或做T，今日绝不误报尾盘清T）`}
          >
            🔒 T+1锁仓 (可卖0股)
          </span>
        )}
        {isTailRiskTime && todayT.hasUnclosed && todayT.sellableShares > 0 && (
          <span
            className="snap-tag tail-alert-pulse"
            style={{ background: '#fff1f0', borderColor: '#ff4d4f', color: '#cf1322', fontWeight: 800 }}
            title="14:40尾盘强制风控：今日尚有做T未平仓！请在14:55前平仓！"
          >
            🚨 尾盘清T ({todayT.unclosedShares}股)
          </span>
        )}
        <span
          className="snap-tag"
          style={{
            background: hasHoldings ? 'rgba(9,105,218,.08)' : 'var(--surface2)',
            borderColor: hasHoldings ? 'rgba(9,105,218,.25)' : 'var(--line)',
            color: hasHoldings ? 'var(--accent)' : 'var(--mute)',
            fontWeight: 700,
            fontSize: '11px',
            lineHeight: '18px'
          }}
          title={hasHoldings ? `总持仓 ${stock.shares}股（今日可卖 ${todayT.sellableShares}股 / 今日新买T+1冻结 ${todayT.t1LockedShares}股）` : '底仓配置状态'}
        >
          {hasHoldings ? `持仓 ${Number(stock.shares).toLocaleString()}股 · 成本 ¥${f2(stock.cost)}` : '未设底仓'}
        </span>

        <button className="mini primary" onClick={() => onOpenQuickT(stock)}>⚡ 快捷记T</button>
        <button
          className="mini"
          style={{ color: '#d97706', borderColor: '#fcd34d', background: '#fffbeb', fontWeight: 700 }}
          onClick={() => setBeCalcOpen(prev => !prev)}
          title="展开/收起做T保本价计算器与规费滑点测算"
        >
          💰 保本计算器
        </button>
        <button
          className="mini"
          style={{ color: '#1677ff', borderColor: '#91caff', background: '#e6f4ff', fontWeight: 700 }}
          onClick={() => onOpenQuickT(stock, '直接买入', f2(stock.price), hasHoldings ? 500 : 1000)}
          title="直接买入建仓或加仓（自动计算加权平均持仓成本）"
        >
          📥 买入{hasHoldings ? '/加仓' : ''}
        </button>
        {hasHoldings && (
          todayT.sellableShares > 0 ? (
            <button
              className="mini"
              style={{ color: '#cf1322', borderColor: '#ffa39e', background: '#fff1f0', fontWeight: 700 }}
              onClick={() => onOpenQuickT(stock, '直接卖出', f2(stock.price), todayT.sellableShares)}
              title={`今日可用可卖 ${todayT.sellableShares} 股（已自动扣除今日新买 T+1 冻结股份）`}
            >
              📤 卖出
            </button>
          ) : (
            <button
              className="mini"
              style={{ color: '#64748b', borderColor: '#cbd5e1', background: '#f8fafc', fontWeight: 600, cursor: 'not-allowed' }}
              onClick={() => toastErr(`受 A 股 T+1 交易制度限制：【${stock.name}】当前股份全部为今日新买入，当日不可卖出（明日开盘解锁可用）`)}
              title="今日新买入股份处于 T+1 锁仓期，今日可卖 0 股"
            >
              🔒 T+1不可卖
            </button>
          )
        )}
        <button className="mini" onClick={() => onOpenReason(stock, true)}>🔍 逻辑与利空</button>
        <button
          className="mini"
          style={{ color: '#0e7490', borderColor: '#a5dbe7', background: '#eff9fb', fontWeight: 600 }}
          onClick={() => {
            window.location.hash = `#/diagnosis?code=${stock.code}`;
          }}
          title="跳转至全景体检报告（排雷、题材风口、套牢筹码与做T自救）"
        >
          🩺 全景体检
        </button>
        <button className="mini" onClick={() => onRefreshSingle(stock)}>⟳ 取数</button>
        <button className="mini" onClick={() => onCopySinglePlan(stock)}>📋 计划</button>
        {stock.manual && Object.keys(stock.manual).length > 0 && (
          <button className="mini" onClick={handleClearManual} title="恢复由行情自动刷新">⟲ 恢复行情值</button>
        )}
        <button className="mini" onClick={() => onRemoveStock(index)}>移除</button>

        <div className="card-hd-snap">
          <span className="snap-px">
            <b className={cls}>{f2(+stock.price)}</b> <b className={cls}>{pct(c.chg)}</b>
          </span>
          <span className="snap-tag" title="日内振幅与折合格数">振幅 {c.amp.toFixed(2)}% ({c.grid.toFixed(1)}格)</span>
          <span className="snap-tag" title="开盘至当前量比">量比 {f2(c.vr)}</span>
          {ta && ta.turnover != null && <span className="snap-tag">换手 {ta.turnover.toFixed(2)}%</span>}
          {ta && ta.volProgress != null && (
            <span className={`snap-tag vq vq-${ta.volState}`}>时段量能 {(ta.volProgress * 100).toFixed(0)}%</span>
          )}
          {stock._dd && stock._dd.dd && (
            <span className="snap-tag">
              主力 <b className={stock._dd.dd.main.net >= 0 ? 'up' : 'down'}>{stock._dd.dd.main.net >= 0 ? '+' : ''}{money$(stock._dd.dd.main.net)}</b>
            </span>
          )}
          <span className="snap-tag tag-trend">日线{c.trend}</span>
          {aucTier && (
            <span
              className="snap-tag"
              style={{
                borderColor: aucTier.color,
                color: aucTier.color,
                background: aucTier.bg,
                fontWeight: 700
              }}
              title={`09:25 集合竞价定盘：开盘跳空 ${openGap >= 0 ? '+' : ''}${openGap.toFixed(2)}% · ${aucTier.tag}\n今开: ¥${f2(stock.open)} / 昨收: ¥${f2(stock.prevClose)}\n历史大样本：平均冲高空间 ${aucTier.space}%，+2% 触及率 ${aucTier.hit2}%\n操作指引：${aucTier.advice}`}
            >
              竞价 {openGap >= 0 ? '+' : ''}{openGap.toFixed(2)}% · {aucTier.tag}
            </span>
          )}
          {stock._t && <span className="snap-time">更新于 {stock._t}</span>}
        </div>
      </div>

      {/* 主体区 */}
      <div className="card-bd">
        {/* 🚨 14:40 尾盘清T紧急风控预警（仅当昨日有可用可卖底仓 sellableShares > 0 且今日有未平做T仓时触发；首日新买 T+1 冻结绝不触发） */}
        {isTailRiskTime && todayT.hasUnclosed && todayT.sellableShares > 0 && (
          <div
            className="tail-alert-pulse"
            style={{
              padding: '11px 16px',
              borderRadius: '8px',
              background: 'linear-gradient(90deg, #fff1f0, #ffebe8)',
              border: '1.5px solid #ff4d4f',
              color: '#cf1322',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '10px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>🚨</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>【14:40 尾盘清T紧急风控】今日尚有 {todayT.unclosedShares} 股T仓未平仓！</span>
                  <span style={{ background: '#cf1322', color: '#fff', fontSize: '11px', padding: '1px 6px', borderRadius: '4px' }}>
                    绝不过夜变加仓
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '2px' }}>
                  做T第一铁律：日内买入必须用昨日可卖底仓（当前可用 {todayT.sellableShares} 股）日内平仓！请在 14:55 前果断挂卖平仓。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="mini"
                style={{
                  background: '#fff',
                  color: '#64748b',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
                onClick={() => {
                  onUpdateStock({ ...stock, unclosedTQty: 0, ignoreTailTDate: todayStr() });
                  toastOk(`已将【${stock.name}】今日买入设为长期加仓持仓，已关闭今日尾盘平T提醒`);
                }}
                title="如果今日买入是为了主动中长线加仓（并非做日内T），点击取消今日尾盘平T警示"
              >
                📌 转为长期加仓(不平T)
              </button>
              <button
                type="button"
                style={{
                  background: '#cf1322',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '7px 14px',
                  fontSize: '12.5px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(207, 19, 34, 0.3)'
                }}
                onClick={() => onOpenQuickT(stock, '直接卖出', f2(pxNow), todayT.unclosedShares)}
                title={`一键挂单卖出昨日可用底仓 ${todayT.unclosedShares} 股以平T`}
              >
                📤 立即平仓卖出 ({todayT.unclosedShares}股)
              </button>
            </div>
          </div>
        )}

        {/* 🎯 打板/连板次日卖出决策雷达与止盈/转做T指引 */}
        {exitDecision && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              background: exitDecision.auctionVerdict.bg,
              border: `1.5px solid ${exitDecision.auctionVerdict.border}`,
              color: exitDecision.auctionVerdict.color,
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '10px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', maxWidth: '74%' }}>
              <span style={{ fontSize: '20px' }}>🎯</span>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 800 }}>
                    【打板次日卖出决策雷达】{exitDecision.auctionVerdict.title}
                  </span>
                  <span style={{
                    fontSize: '11px',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    background: exitDecision.auctionVerdict.color,
                    color: '#fff'
                  }}>
                    {exitDecision.auctionVerdict.badge}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text)', marginTop: '4px', lineHeight: '1.4' }}>
                  <b>实战操作：</b>{exitDecision.auctionVerdict.action}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '3px' }}>
                  💡 {exitDecision.intradayAdvice}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {exitDecision.canConvertToT && (
                <button
                  type="button"
                  className="mini"
                  style={{
                    background: '#0958d9',
                    color: '#fff',
                    border: 'none',
                    fontWeight: 700,
                    padding: '5px 10px',
                    borderRadius: '5px',
                    cursor: 'pointer'
                  }}
                  onClick={handleConvertToLongT}
                  title="将超短打板机动仓位转入稳健底仓池，锁定利润并开启做T保本计算"
                >
                  🔄 一键转为底仓做T
                </button>
              )}
              {todayT.isFirstDayLocked ? (
                <span
                  style={{
                    fontSize: '11.5px',
                    background: '#f1f5f9',
                    color: '#475569',
                    border: '1px solid #cbd5e1',
                    fontWeight: 700,
                    padding: '4px 10px',
                    borderRadius: '5px'
                  }}
                  title="今日首次买入受 A 股 T+1 冻结，今日无法卖出，以上攻略供明日开盘使用"
                >
                  🔒 T+1 锁定中 (明日生效)
                </span>
              ) : (
                <button
                  type="button"
                  className="mini"
                  style={{
                    background: '#cf1322',
                    color: '#fff',
                    border: 'none',
                    fontWeight: 700,
                    padding: '5px 10px',
                    borderRadius: '5px',
                    cursor: 'pointer'
                  }}
                  onClick={() => onOpenQuickT(stock, '直接卖出', f2(pxNow), todayT.sellableShares || stock.shares || 100)}
                  title="执行快速市价挂单止盈/抢跑"
                >
                  📤 快速卖出止盈
                </button>
              )}
            </div>
          </div>
        )}

        {/* 破位防套锁 / 止跌十字星 / 爆发点实时警报横幅 */}
        {c.brokenLock && (
          <div style={{
            padding: '9px 14px',
            borderRadius: '8px',
            background: 'var(--up-bg)',
            border: '1px solid var(--up-b)',
            color: 'var(--up-d)',
            fontSize: '12.5px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px'
          }}>
            <span style={{ fontSize: '15px' }}>🚨</span>
            <div>
              <span>【技术破位防套锁】已{c.breakDesc || '跌破关键技术支撑'}！下方支撑彻底失效转化为强阻力。</span>
              <span style={{ fontWeight: 400, color: 'var(--text)', marginLeft: '6px' }}>已拦截正T买入建议，防止阴跌深套；仅允许反弹抽到均线阻力时做倒T减仓避险。</span>
            </div>
          </div>
        )}
        {c.ignitionActive && (
          <div style={{
            padding: '9px 14px',
            borderRadius: '8px',
            background: 'var(--down-bg)',
            border: '1px solid var(--down-b)',
            color: 'var(--down-d)',
            fontSize: '12.5px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px'
          }}>
            <span style={{ fontSize: '15px' }}>🚀</span>
            <div>
              <span>【放量主升爆发点确立】缩量洗盘后首根放量长阳突破关键均线！</span>
              <span style={{ fontWeight: 400, color: 'var(--text)', marginLeft: '6px' }}>主力做多确立，解除一切空头防守锁，顺势执行正T进攻！</span>
            </div>
          </div>
        )}
        {c.reversalActive && !c.brokenLock && (
          <div style={{
            padding: '9px 14px',
            borderRadius: '8px',
            background: 'var(--teal-bg)',
            border: '1px solid var(--teal-b)',
            color: 'var(--teal)',
            fontSize: '12.5px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px'
          }}>
            <span style={{ fontSize: '15px' }}>👀</span>
            <div>
              <span>【阴跌探底止跌信号】{c.reversalTag || '止跌十字星·地量蓄势'}！</span>
              <span style={{ fontWeight: 400, color: 'var(--text)', marginLeft: '6px' }}>空头抛压耗尽，多空达动态平衡，允许在止跌低点附近以极轻仓试探性正T。</span>
            </div>
          </div>
        )}

        {/* 分区与战法面板：短线机动区(区分普通短线与涨停打板标的) vs 底仓做T区 */}
        {isShortTier ? (
          limitRig && limitRig.isBoardTarget ? (
            /* 标的符合【前一天有涨停 (连板接力)】或【今日逼近/封死/曾炸板涨停】，激活涨停与打板监控 */
            <div style={{
              background: 'linear-gradient(180deg, #fff9f6, #fff)',
              border: '1.5px solid #ffbb96',
              borderRadius: '10px',
              padding: '12px 14px',
              marginBottom: '12px',
              boxShadow: '0 2px 6px rgba(255, 122, 69, 0.08)'
            }}>
              {/* 顶部标题与硬度总览 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 800, color: '#d4380d', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>🔥 涨停与打板监控（{limitRig.label}）</span>
                  </span>
                  {aucPattern && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: aucPattern.bg,
                        color: aucPattern.color,
                        border: '1px solid',
                        borderColor: aucPattern.border
                      }}
                      title={aucPattern.desc}
                    >
                      {aucPattern.tag} (量比 {f2(aucPattern.vr)})
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: limitRig.badgeBg,
                      color: limitRig.badgeColor,
                      border: '1px solid',
                      borderColor: limitRig.badgeColor
                    }}
                  >
                    {limitRig.label} {limitRig.isLimitUp ? `· 硬度 ${limitRig.hardnessScore}分` : ''}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: '#d4380d', fontWeight: 600 }}>
                  🛡️ 短线机动仓位 · 严禁挪用底仓资金
                </div>
              </div>

              {/* 炸板特大风险横幅 */}
              {limitRig.isBroken && (
                <div style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  background: '#fff1f0',
                  border: '1px solid #ffa39e',
                  color: '#cf1322',
                  fontSize: '12px',
                  fontWeight: 700,
                  marginBottom: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span>🚨</span>
                  <span>【炸板大面风险警报】今日曾涨停（¥{f2(limitRig.ceiling)}），已被大单砸开！现价回落 {Math.abs(limitRig.brokenDrop).toFixed(1)}%！严禁盲目打板，谨防次日核按钮暴跌！</span>
                </div>
              )}

              {/* 双核量化数据看板: 09:25 弱转强 + 9:40 涨停硬度 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px', marginBottom: '10px' }}>
                {/* 模块1: 09:25 竞价定盘弱转强 */}
                <div style={{ padding: '8px 10px', background: '#fff', borderRadius: '6px', border: '1px solid #ffd8bf' }}>
                  <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#d4380d', marginBottom: '4px' }}>
                    🌅 09:25 集合竞价定盘与形态
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text)', lineHeight: 1.5 }}>
                    <div>
                      竞价跳空: <b style={{ color: (aucPattern?.gap || 0) >= 0 ? 'var(--up)' : 'var(--down)', fontFamily: 'monospace' }}>
                        {(aucPattern?.gap || 0) >= 0 ? '+' : ''}{(aucPattern?.gap || 0).toFixed(2)}%
                      </b> ｜ 竞价量比: <b style={{ fontFamily: 'monospace' }}>{f2(aucPattern?.vr || 1)} 倍</b>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                      {aucPattern ? aucPattern.desc : '等待 09:25 集合竞价定盘数据'}
                    </div>
                  </div>
                </div>

                {/* 模块2: 9:40 涨停与冲板硬度追踪 */}
                <div style={{ padding: '8px 10px', background: '#fff', borderRadius: '6px', border: '1px solid #ffd8bf' }}>
                  <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#cf1322', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>🎯 涨停硬度与冲板追踪</span>
                    {limitRig.isLimitUp && (
                      <span style={{ fontSize: '10.5px', color: '#cf1322', fontWeight: 800 }}>
                        硬度 {limitRig.hardnessScore} / 100
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text)', lineHeight: 1.5 }}>
                    <div>
                      涨停价: <b style={{ fontFamily: 'monospace', color: 'var(--up)' }}>¥{f2(limitRig.ceiling)}</b>
                      {limitRig.isLimitUp ? (
                        <>
                          {' ｜ '}买一封单: <b style={{ color: '#cf1322', fontFamily: 'monospace' }}>{money$(limitRig.sealAmtYuan)}</b>
                          {' '}(<b style={{ fontFamily: 'monospace' }}>{Number(limitRig.b1_v).toLocaleString()}</b> 手)
                        </>
                      ) : limitRig.isNearLimit ? (
                        <span style={{ color: '#1677ff', marginLeft: '6px', fontWeight: 700 }}>
                          （距涨停仅差 {limitRig.distCeiling.toFixed(1)}%，现价 ¥{f2(pxNow)}）
                        </span>
                      ) : limitRig.hadPrevLimitUp ? (
                        <span style={{ color: '#389e0d', marginLeft: '6px', fontWeight: 700 }}>
                          （昨日涨停收盘，今日连板接力博弈中）
                        </span>
                      ) : (
                        <span style={{ color: 'var(--mute)', marginLeft: '6px' }}>（距涨停差 {f2(Math.max(0, limitRig.ceiling - pxNow))} 元）</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '2px' }}>
                      {limitRig.isLimitUp ? (
                        <span>封成比: <b style={{ color: limitRig.sealRatio >= 1.5 ? '#cf1322' : 'var(--text)' }}>{limitRig.sealRatio.toFixed(2)}倍</b> ({limitRig.sealRatio >= 1.5 ? '坚如磐石' : limitRig.sealRatio >= 0.8 ? '封单正常' : '封单偏弱需防炸'})</span>
                      ) : (
                        <span>{limitRig.desc}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 资金防混淆与操盘纪律约束条 */}
              <div style={{
                padding: '6px 10px',
                background: '#fff2e8',
                borderRadius: '6px',
                border: '1px dashed #ffbb96',
                fontSize: '11.5px',
                color: '#d4380d',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '6px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🛡️ <b>打板纪律：</b></span>
                  <span>打板仅动用 30% 机动资金，严禁在打板或冲板受挫被套时挪用底仓资金补仓加码！</span>
                </div>
                <span style={{ fontWeight: 700, fontSize: '11px', color: '#cf1322' }}>
                  次日不板果断撤退 · 绝不留恋做股东
                </span>
              </div>
            </div>
          ) : (
            /* 普通短线标的：昨日未涨停，今日也未逼近涨停，不滥扣“打板”帽子，纯粹短线机动做T */
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '7px 12px',
              borderRadius: '8px',
              background: 'linear-gradient(180deg, #fffbf0, #fff)',
              border: '1px solid #ffd591',
              fontSize: '12px',
              color: 'var(--text)',
              marginBottom: '12px',
              flexWrap: 'wrap',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>⚡</span>
                <b style={{ color: '#d46b08' }}>【短线机动区标的】</b>
                <span style={{ color: 'var(--sub)' }}>
                  常规短线震荡标的（非涨停连板股），按分时均线与七格箱体执行日内灵活正倒T。
                </span>
              </div>
              {aucPattern && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--mute)' }}>09:25 竞价:</span>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: '4px',
                      background: aucPattern.bg,
                      color: aucPattern.color,
                      border: `1px solid ${aucPattern.border}`
                    }}
                    title={aucPattern.desc}
                  >
                    {aucPattern.gap >= 0 ? '+' : ''}{aucPattern.gap.toFixed(2)}% ({aucPattern.tag} · 量比 {f2(aucPattern.vr)})
                  </span>
                </div>
              )}
            </div>
          )
        ) : (
          <div style={{
            background: 'linear-gradient(180deg, #f0f7ff, #fff)',
            border: '1px solid #bae0ff',
            borderRadius: '8px',
            padding: '7px 12px',
            marginBottom: '12px',
            fontSize: '12px',
            color: '#0958d9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '6px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🛡️</span>
              <b>【底仓做T区标的】</b>
              <span>70% 底仓专用仓位，基于 MA5/MA20 趋势与七格箱体执行高抛低吸，严禁冲动追高！</span>
            </div>
            <span style={{ fontSize: '11px', color: '#1677ff', fontWeight: 600 }}>
              七底三仓 · 稳健降本
            </span>
          </div>
        )}

        {/* 我的持仓与交易操作面板（支持买入建仓、买入加仓加权均价核算、减仓清仓与底仓校准） */}
        <div
          className="card-holdings-setup"
          style={{
            padding: '12px 14px',
            background: hasHoldings ? 'var(--surface)' : '#fffbf0',
            border: hasHoldings ? '1px solid var(--line2)' : '1px dashed var(--warn)',
            borderRadius: '10px',
            marginBottom: '12px'
          }}
        >
          {/* 上半部分：当前持仓概况与校准入口 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>
                💼 当前持仓:
              </span>
              {hasHoldings ? (
                <>
                  <span style={{ fontSize: '12.5px', color: 'var(--sub)' }}>
                    持仓 <b>{Number(stock.shares).toLocaleString()}</b> 股
                  </span>
                  <span style={{ color: 'var(--line2)' }}>|</span>
                  <span style={{ fontSize: '12.5px', color: 'var(--sub)' }}>
                    成本均价 <b>¥{f2(stock.cost)}</b>
                  </span>
                  <span style={{ color: 'var(--line2)' }}>|</span>
                  <span style={{ fontSize: '12.5px', color: 'var(--sub)' }}>
                    持仓市值 <b>¥{money(curMarketVal)}</b>
                  </span>
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: floatProfit >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
                      color: floatProfit >= 0 ? 'var(--up)' : 'var(--down)',
                      border: '1px solid',
                      borderColor: floatProfit >= 0 ? 'var(--up-b)' : 'var(--down-b)',
                      fontFamily: 'ui-monospace,Consolas,monospace'
                    }}
                    title={`浮动盈亏 = (现价 ¥${f2(pxNow)} - 成本均价 ¥${f2(stock.cost)}) × ${stock.shares} 股`}
                  >
                    浮动盈亏: {floatProfit >= 0 ? '+' : ''}¥{money(floatProfit)} ({floatRate >= 0 ? '+' : ''}{floatRate.toFixed(2)}%)
                  </span>
                </>
              ) : (
                <span style={{ fontSize: '12.5px', color: 'var(--warn-d)', fontWeight: 600 }}>
                  0 股（空仓待建仓 · 录入买入股数与价格即可建仓，多次买入将自动计算加权加仓成本）
                </span>
              )}
            </div>

            {/* 校准底仓开关 */}
            <button
              type="button"
              className="mini"
              onClick={() => setIsCalibrating(!isCalibrating)}
              style={{
                fontSize: '11px',
                color: isCalibrating ? '#1677ff' : 'var(--sub)',
                borderColor: isCalibrating ? '#91caff' : 'var(--line)',
                background: isCalibrating ? '#e6f4ff' : 'transparent',
                padding: '2px 7px',
                cursor: 'pointer'
              }}
              title="若需直接修改/对齐券商软件中的初始持仓股数与成本，可切换至校准模式"
            >
              {isCalibrating ? '返回买入模式' : '✏️ 校准底仓'}
            </button>
          </div>

          {/* 下半部分：操作区域 */}
          {isCalibrating ? (
            /* ===== 校准底仓模式 ===== */
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
              padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px dashed var(--line)'
            }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text)' }}>⚙️ 直接校准底仓数据:</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <label style={{ fontSize: '11.5px', color: 'var(--sub)' }}>总持仓股数</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="如 1000"
                  value={calibSharesStr}
                  onChange={e => setCalibSharesStr(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveCalibration(); }}
                  style={{ width: '85px', padding: '4px 8px', fontSize: '12.5px', fontFamily: 'monospace', borderRadius: '5px', border: '1px solid var(--line2)', background: '#fff' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <label style={{ fontSize: '11.5px', color: 'var(--sub)' }}>成本单价</label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="如 30.50"
                  value={calibCostStr}
                  onChange={e => setCalibCostStr(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveCalibration(); }}
                  style={{ width: '85px', padding: '4px 8px', fontSize: '12.5px', fontFamily: 'monospace', borderRadius: '5px', border: '1px solid var(--line2)', background: '#fff' }}
                />
              </div>
              <button
                type="button"
                className="mini primary"
                onClick={handleSaveCalibration}
                style={{ padding: '4px 10px', fontSize: '11.5px', fontWeight: 700, cursor: 'pointer' }}
              >
                💾 保存校准
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => setIsCalibrating(false)}
                style={{ padding: '4px 8px', fontSize: '11.5px', cursor: 'pointer' }}
              >
                取消
              </button>
              <span style={{ fontSize: '11px', color: 'var(--mute)', marginLeft: '4px' }}>
                （仅用于纠正或对齐初始持仓，不记入买入流水）
              </span>
            </div>
          ) : (
            /* ===== 标准交易模式：买入 / 加仓 / 减仓 / 清仓 ===== */
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {/* 股数输入 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', fontWeight: 600 }}>
                    {hasHoldings ? '加仓股数' : '买入股数'}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder={hasHoldings ? '例如 500' : '例如 1000'}
                    value={buyQtyStr}
                    onChange={e => setBuyQtyStr(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleExecuteBuy(); }}
                    style={{
                      width: '90px',
                      padding: '4px 8px',
                      fontSize: '12.5px',
                      fontFamily: 'ui-monospace,Consolas,monospace',
                      borderRadius: '5px',
                      border: '1px solid var(--line2)',
                      background: '#fff'
                    }}
                  />
                </div>

                {/* 快捷股数点选 */}
                <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                  {(hasHoldings ? [100, 500, 1000] : [500, 1000, 2000]).map(q => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setBuyQtyStr(String(q))}
                      style={{
                        padding: '2px 5px', fontSize: '10.5px', borderRadius: '3px',
                        border: '1px solid var(--line)', background: '#fff', cursor: 'pointer', color: 'var(--sub)'
                      }}
                    >
                      +{q}
                    </button>
                  ))}
                  {hasHoldings && oldShares > 0 && (
                    <button
                      type="button"
                      onClick={() => setBuyQtyStr(String(oldShares))}
                      style={{
                        padding: '2px 5px', fontSize: '10.5px', borderRadius: '3px',
                        border: '1px solid var(--line)', background: '#fff', cursor: 'pointer', color: 'var(--sub)'
                      }}
                      title="加仓等同于当前持仓的股数（翻倍仓）"
                    >
                      +1倍仓
                    </button>
                  )}
                </div>

                {/* 买入价格输入 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', fontWeight: 600 }}>买入价格</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="例如 30.50"
                    value={buyPxStr}
                    onChange={e => setBuyPxStr(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleExecuteBuy(); }}
                    style={{
                      width: '85px',
                      padding: '4px 8px',
                      fontSize: '12.5px',
                      fontFamily: 'ui-monospace,Consolas,monospace',
                      borderRadius: '5px',
                      border: '1px solid var(--line2)',
                      background: '#fff'
                    }}
                  />
                </div>

                {/* 快捷填入价格 */}
                <button
                  type="button"
                  className="mini"
                  onClick={() => setBuyPxStr(f2(pxNow))}
                  title={`将当前实时现价 ¥${f2(pxNow)} 填入`}
                  style={{ padding: '3px 7px', fontSize: '11px', cursor: 'pointer' }}
                >
                  ⚡ 现价 {f2(pxNow)}
                </button>

                {c && c.buy1 && (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => setBuyPxStr(f2(c.buy1))}
                    title={`将正T买入低吸价 ¥${f2(c.buy1)} 填入`}
                    style={{ padding: '3px 7px', fontSize: '11px', cursor: 'pointer', color: 'var(--down)' }}
                  >
                    低吸位 {f2(c.buy1)}
                  </button>
                )}

                {/* 核心买入/加仓按钮 */}
                <button
                  type="button"
                  className="mini primary"
                  onClick={handleExecuteBuy}
                  title={hasHoldings ? "确认买入加仓：将自动合并股数并按加权平均重新计算持仓均价" : "确认买入建仓"}
                  style={{
                    padding: '4px 12px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: '#1677ff',
                    borderColor: '#1677ff'
                  }}
                >
                  {hasHoldings ? '📥 买入加仓' : '📥 买入建仓'}
                </button>

                {/* 卖出/减仓/清仓按钮 */}
                {hasHoldings && (
                  <>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => onOpenQuickT(stock, '直接卖出', f2(pxNow), stock.shares)}
                      title={`直接卖出当前持仓：可按股数减仓，或全部清仓（总持仓 ${stock.shares} 股）`}
                      style={{
                        padding: '4px 10px',
                        fontSize: '11.5px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        background: '#fff1f0',
                        color: '#cf1322',
                        borderColor: '#ffa39e'
                      }}
                    >
                      📤 卖出 / 减仓
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => onOpenQuickT(stock, '直接卖出', f2(pxNow), stock.shares)}
                      title={`一键清仓卖出全部 ${stock.shares} 股`}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11.5px',
                        cursor: 'pointer',
                        background: 'var(--surface2)',
                        color: 'var(--sub)',
                        borderColor: 'var(--line)'
                      }}
                    >
                      🗑️ 清仓
                    </button>
                  </>
                )}
              </div>

              {/* 实时预演说明条 */}
              {isBuyInputValid && (
                <div style={{
                  marginTop: '8px',
                  padding: '5px 10px',
                  background: '#f6ffed',
                  border: '1px solid #b7eb8f',
                  borderRadius: '6px',
                  fontSize: '11.5px',
                  color: '#389e0d',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap'
                }}>
                  {hasHoldings ? (
                    <>
                      <span>💡 <b>加仓试算预演:</b> 加仓 {inputBuyQty} 股 @ ¥{f2(inputBuyPx)} ➔</span>
                      <span>总持仓由 <b>{oldShares}</b> 增至 <b>{trialNewShares}</b> 股</span>
                      <span>均价由 ¥{f2(oldCost)} 变为 <b>¥{f2(trialNewCost)}</b>
                        <b style={{ marginLeft: '4px', color: trialCostDiff <= 0 ? 'var(--down)' : 'var(--up)' }}>
                          ({trialCostDiff <= 0 ? `摊薄 -¥${Math.abs(trialCostDiff).toFixed(2)}` : `抬高 +¥${trialCostDiff.toFixed(2)}`} / 股)
                        </b>
                      </span>
                      <span>｜ 预计动用资金: ¥{money(trialTotalCapital)}</span>
                    </>
                  ) : (
                    <>
                      <span>💡 <b>首次建仓预演:</b> 买入 {inputBuyQty} 股 @ ¥{f2(inputBuyPx)} ➔</span>
                      <span>初始底仓: <b>{trialNewShares}</b> 股 ｜ 成本价: <b>¥{f2(trialNewCost)}</b> ｜ 动用资金: <b>¥{money(trialTotalCapital)}</b></span>
                    </>
                  )}
                </div>
              )}

              {/* 今日做T盯盘与 T+1 可用底仓监控条 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                padding: '6px 10px',
                background: todayT.hasUnclosed ? '#fffbe6' : todayT.isFirstDayLocked ? '#f8fafc' : 'var(--surface2)',
                border: todayT.hasUnclosed ? '1px solid #ffe58f' : todayT.isFirstDayLocked ? '1px solid #cbd5e1' : '1px solid var(--line)',
                borderRadius: '6px',
                fontSize: '11.5px',
                marginTop: '8px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, color: todayT.hasUnclosed ? '#d46b08' : todayT.isFirstDayLocked ? '#475569' : 'var(--text)' }}>
                    ⏱️ 今日做T与T+1状态:
                  </span>
                  {todayT.isFirstDayLocked ? (
                    <span style={{ color: '#475569', fontWeight: 600 }}>
                      🔒 今日新买建仓 <b>{todayT.t1LockedShares}</b> 股（T+1 锁仓冻结，今日可卖 0 股，绝不误报尾盘清T · 明日解锁可卖/做T）
                    </span>
                  ) : todayT.hasUnclosed ? (
                    <>
                      <span style={{ color: '#d46b08', fontWeight: 600 }}>
                        ⚠️ 今日加仓/开T {todayT.addBoughtQty} 股（昨日可卖底仓 {todayT.sellableShares} 股），尚有 <b>{todayT.unclosedShares}</b> 股待平T！
                      </span>
                      <button
                        type="button"
                        className="mini"
                        onClick={() => onOpenQuickT(stock, '直接卖出', f2(pxNow), todayT.unclosedShares)}
                        style={{ color: '#cf1322', borderColor: '#ffa39e', background: '#fff1f0', fontWeight: 700, padding: '1px 7px', fontSize: '11px', cursor: 'pointer' }}
                        title={`立即卖出昨日可用底仓 ${todayT.unclosedShares} 股以平T`}
                      >
                        ⚡ 立即平仓
                      </button>
                      <button
                        type="button"
                        className="mini"
                        onClick={() => {
                          onUpdateStock({ ...stock, unclosedTQty: 0, ignoreTailTDate: todayStr() });
                          toastOk(`已将【${stock.name}】设为长期加仓（不触发尾盘清T）`);
                        }}
                        style={{ color: '#64748b', borderColor: '#cbd5e1', background: '#fff', fontWeight: 600, padding: '1px 6px', fontSize: '11px', cursor: 'pointer' }}
                        title="如果今日买入是为了主动长期加仓，点击取消今日平T提醒"
                      >
                        📌 长期加仓
                      </button>
                    </>
                  ) : todayT.closedTCount > 0 ? (
                    <span style={{ color: '#389e0d', fontWeight: 600 }}>
                      ✅ 今日做T已全部平仓了结（累计 {todayT.closedTCount} 笔已记账 ｜ 剩余可卖底仓 {todayT.sellableShares} 股）
                    </span>
                  ) : (
                    <span style={{ color: 'var(--mute)' }}>
                      {todayT.sellableShares > 0
                        ? `昨日可用可卖底仓 ${todayT.sellableShares} 股 · 今日暂无待平T仓`
                        : '当前暂无底仓（请先买入建仓，次日即可开展日内做T）'}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {todayT.sellableShares > 0 && (
                    <button
                      type="button"
                      className="mini"
                      onClick={() => {
                        const nextQty = (stock.unclosedTQty || 0) > 0 ? 0 : Math.min(todayT.sellableShares, stock.shares && stock.shares >= 500 ? 500 : todayT.sellableShares);
                        onUpdateStock({ ...stock, unclosedTQty: nextQty });
                        toastOk(nextQty > 0 ? `已标记【${stock.name}】今日开T ${nextQty} 股待平仓` : `已清除【${stock.name}】未平仓标记`);
                      }}
                      style={{ fontSize: '10.5px', padding: '1px 6px', color: 'var(--sub)', cursor: 'pointer' }}
                      title="快速手工标记或取消日内做T待平仓股数，用于测试或手工跟单"
                    >
                      {(stock.unclosedTQty || 0) > 0 ? '清除待平仓标记' : '标记开T待平仓'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 判定条与买卖点指令 */}
        <div className={`verdict v-${mbd[0]}`}>
          <div className="dot"></div>
          <div className="txt" style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '3px' }}>{c.title}</div>
            {c.detail ? (
              <div
                style={{ fontSize: '12px', lineHeight: 1.6, opacity: 0.95 }}
                dangerouslySetInnerHTML={{ __html: c.detail }}
              />
            ) : (
              c.desc && <div style={{ fontSize: '12px' }}>{c.desc}</div>
            )}
          </div>
        </div>

        {/* 六格价位卡 */}
        <div className="levels">
          <div className={`lv buy ${c.mode === 'BUY' ? '' : 'off'}`}>
            <div className="k">
              <span>正T 买入区（先买后卖）</span>
              <button className="pill-act" onClick={() => onOpenQuickT(stock, '正T', f2(c.inA))}>⚡ 记买</button>
            </div>
            <div className="v">{f2(c.inA)} — {f2(c.inB)}</div>
            <div className="d">第一份 / 第二份挂单价</div>
          </div>
          <div className={`lv sell ${c.mode === 'BUY' ? '' : 'off'}`}>
            <div className="k">
              <span>正T 止盈目标</span>
              <button className="pill-act" onClick={() => onOpenQuickT(stock, '正T', f2(c.tp1))}>⚡ 记止盈</button>
            </div>
            <div className="v">{f2(c.tp1)} / {f2(c.tp2)}</div>
            <div className="d">约 +{c.gain1.toFixed(1)}% ~ +{c.gain2.toFixed(1)}%</div>
          </div>
          <div className={`lv stop ${c.mode === 'BUY' ? '' : 'off'}`}>
            <div className="k">
              <span>正T 止损（-1.5%）</span>
              <button className="pill-act" onClick={() => onOpenQuickT(stock, '正T', f2(c.slA))}>⚡ 记止损</button>
            </div>
            <div className="v">{f2(c.slA)} / {f2(c.slB)}</div>
            <div className="d">对应上面两个买点</div>
          </div>
          <div className={`lv sell ${(c.mode === 'REV' || c.mode === 'CUT') ? '' : 'off'}`}>
            <div className="k">
              <span>倒T 卖出区（先卖后买）</span>
              <button className="pill-act" onClick={() => onOpenQuickT(stock, '倒T', f2(c.outA))}>⚡ 记卖</button>
            </div>
            <div className="v">{f2(c.outA)} — {f2(c.outB)}</div>
            <div className="d">无量冲高时减T仓</div>
          </div>
          <div className={`lv buy ${(c.mode === 'REV' || c.mode === 'CUT') ? '' : 'off'}`}>
            <div className="k">
              <span>倒T 接回位</span>
              <button className="pill-act" onClick={() => onOpenQuickT(stock, '倒T', f2(c.bkA))}>⚡ 记接回</button>
            </div>
            <div className="v">{f2(c.bkA)} / {f2(c.bkB)}</div>
            <div className="d">回落缩量后再接</div>
          </div>
          <div className={`lv stop ${(c.mode === 'REV' || c.mode === 'CUT') ? '' : 'off'}`}>
            <div className="k">
              <span>卖飞线（不得追高）</span>
            </div>
            <div className="v">{f2(c.fly)}</div>
            <div className="d">放量突破此价即认卖飞，不接</div>
          </div>
        </div>

        {/* 现价处于第几格条 */}
        <div className="nowline">
          现价 <b>{f2(pxNow)}</b>（<b className={cls}>{pct(c.chg)}</b>）
          　│　位于 <b>{kLo > 0 ? '+' : ''}{(kLo * GRID).toFixed(2)}% → {f2(pLo)}</b> 与 <b>{kHi > 0 ? '+' : ''}{(kHi * GRID).toFixed(2)}% → {f2(pHi)}</b> 两格之间
          {dLo != null && `　│　距下格 ${dLo >= 0 ? '+' : ''}${dLo.toFixed(2)}%、距上格 ${dHi >= 0 ? '+' : ''}${dHi.toFixed(2)}%`}
        </div>

        {/* 🧪 实验性辅助：ATR 自适应动态网格对照（弱参考，不改变主决策与挂单区） */}
        {atrExp && (
          <details
            style={{
              margin: '8px 0 10px',
              padding: '7px 12px',
              borderRadius: '8px',
              background: '#f8fafc',
              border: '1px dashed #cbd5e1',
              fontSize: '11.5px',
              color: 'var(--sub)'
            }}
          >
            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', userSelect: 'none' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ background: '#ede9fe', color: '#6d28d9', padding: '1px 6px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 700 }}>
                  🧪 实验 · 弱参考
                </span>
                <span>
                  <b>ATR(14) 动态自适应网格：</b>
                  近{atrExp.sampleDays}日均幅 <b style={{ fontFamily: 'monospace' }}>{atrExp.avgIntraAmp14.toFixed(2)}%</b>
                </span>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: atrExp.volBg, color: atrExp.volColor, fontWeight: 700 }}>
                  {atrExp.volType}
                </span>
                <span>
                  ｜ 自适应格距 <b style={{ fontFamily: 'monospace', color: '#6d28d9' }}>{atrExp.adaptiveGrid.toFixed(2)}%</b>
                  <span style={{ color: 'var(--mute)', marginLeft: '4px' }}>(标准 {atrExp.standardGrid.toFixed(2)}%)</span>
                </span>
              </span>
              <span style={{ fontSize: '11px', color: '#6d28d9', fontWeight: 600 }}>
                ▾ 展开实验对照点位
              </span>
            </summary>

            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #e2e8f0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginBottom: '6px' }}>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>ATR(14) 真实波幅</div>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, fontFamily: 'monospace' }}>
                    ¥{f2(atrExp.atr14)} ({atrExp.atrPct.toFixed(2)}%)
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>实验动态步长 vs 标准</div>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, fontFamily: 'monospace', color: '#6d28d9' }}>
                    {atrExp.adaptiveGrid.toFixed(2)}% <span style={{ color: 'var(--mute)', fontWeight: 400 }}>/ {atrExp.standardGrid.toFixed(2)}%</span>
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#f0fdf4', borderRadius: '6px', border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: '10.5px', color: '#15803d' }}>ATR 实验低吸格位</div>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, fontFamily: 'monospace', color: '#15803d' }}>
                    ¥{f2(atrExp.expIn1)} — ¥{f2(atrExp.expIn2)}
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fecaca' }}>
                  <div style={{ fontSize: '10.5px', color: '#dc2626' }}>ATR 实验高抛格位</div>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, fontFamily: 'monospace', color: '#dc2626' }}>
                    ¥{f2(atrExp.expOut1)} — ¥{f2(atrExp.expOut2)}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '11.5px', color: '#475569', lineHeight: 1.5 }}>
                💡 <b>股性观察：</b>{atrExp.volDesc}
                <span style={{ color: '#94a3b8', marginLeft: '6px' }}>（⚠️ 仅供实验性对照弱参考，主挂单仍严格以系统 1.33% 七格与分时均线为准）</span>
              </div>
            </div>
          </details>
        )}

        {/* 🧬 实验性辅助：个股历史基因概率统计（近120日回溯，弱参考，不作为强下单依据） */}
        {dnaExp && (
          <details
            style={{
              margin: '0 0 12px',
              padding: '7px 12px',
              borderRadius: '8px',
              background: '#f8fafc',
              border: '1px dashed #cbd5e1',
              fontSize: '11.5px',
              color: 'var(--sub)'
            }}
          >
            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', userSelect: 'none' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '1px 6px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 700 }}>
                  🧬 实验 · 弱参考
                </span>
                <span>
                  <b>历史基因({dnaExp.sampleDays}日回溯)：</b>
                </span>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: dnaExp.dnaBg, color: dnaExp.dnaColor, fontWeight: 700 }}>
                  {dnaExp.dnaTag}
                </span>
                <span>
                  ｜ 振幅≥3%占比 <b style={{ fontFamily: 'monospace' }}>{dnaExp.tFriendly3Pct}%</b>
                  ｜ 深水低吸反抽胜率 <b style={{ fontFamily: 'monospace', color: dnaExp.dipWinRate >= 55 ? '#16a34a' : '#dc2626' }}>{dnaExp.dipWinRate}%</b>
                </span>
              </span>
              <span style={{ fontSize: '11px', color: '#0369a1', fontWeight: 600 }}>
                ▾ 展开历史胜率详单
              </span>
            </summary>

            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #e2e8f0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '8px', marginBottom: '6px' }}>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>做T日内弹性达标率</div>
                  <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>
                    ≥3%: <b style={{ color: '#0284c7' }}>{dnaExp.tFriendly3Pct}%</b> · ≥4%: <b>{dnaExp.tFriendly4Pct}%</b>
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>深跌(≤-1.8%)反抽≥1.2%胜率</div>
                  <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: dnaExp.dipWinRate >= 55 ? '#16a34a' : '#dc2626' }}>
                    {dnaExp.dipTotal > 0 ? `${dnaExp.dipWinRate}% (${dnaExp.dipWin}/${dnaExp.dipTotal}次 · 均抽+${dnaExp.dipAvgRebound}%)` : '样本不足'}
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>高开砸盘率 (收阴占比)</div>
                  <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: dnaExp.gapUpSmashRate >= 60 ? '#dc2626' : '#334155' }}>
                    {dnaExp.gapUpTotal > 0 ? `${dnaExp.gapUpSmashRate}% (${dnaExp.gapUpSmash}/${dnaExp.gapUpTotal}次高开收阴)` : '近期极少高开'}
                  </div>
                </div>
                <div style={{ padding: '6px 8px', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>同今日开盘[{dnaExp.curBucketLabel}]</div>
                  <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>
                    {dnaExp.matchTotal > 0 ? `收涨${dnaExp.matchUpRate}% · 均冲+${dnaExp.matchAvgSurge}% / 探${dnaExp.matchAvgDip}%` : '同档样本较少'}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '11.5px', color: '#475569', lineHeight: 1.5 }}>
                🧬 <b>基因特征总结：</b>{dnaExp.dnaDesc}
                <span style={{ color: '#94a3b8', marginLeft: '6px' }}>（⚠️ 基于历史 {dnaExp.sampleDays} 日纯统计学回顾，不代表未来必然重复，仅作弱参考）</span>
              </div>
            </div>
          </details>
        )}

        {/* 💰 做T保本价计算器与规费滑点空间测算 */}
        <div
          className="card-be-calc"
          style={{
            margin: '12px 0',
            background: 'var(--surface)',
            border: '1px solid var(--line2)',
            borderRadius: '10px',
            padding: '12px 14px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>💰 做T保本价计算器</span>
              </span>
              <span
                style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  background: beMode === 'BUY' ? 'var(--down-bg)' : 'var(--up-bg)',
                  color: beMode === 'BUY' ? 'var(--down)' : 'var(--up)',
                  fontWeight: 700
                }}
              >
                {beMode === 'BUY' ? '正T (先买后卖)' : '倒T (先卖后买)'}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--sub)' }}>
                开仓: <b style={{ fontFamily: 'monospace' }}>¥{f2(beResult.entryPx)}</b> ➔ 保本{beMode === 'BUY' ? '卖出' : '接回'}: <b style={{ color: beMode === 'BUY' ? 'var(--up)' : 'var(--down)', fontFamily: 'monospace' }}>¥{f2(beResult.targetPx)}</b>
                （需点差 <b style={{ fontFamily: 'monospace' }}>{beMode === 'BUY' ? '+' : '-'}{f2(beResult.spread)}元 / {beMode === 'BUY' ? '+' : '-'}{beResult.pctDiff.toFixed(2)}%</b>）
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                type="button"
                className="mini"
                onClick={() => setBeCalcOpen(prev => !prev)}
                style={{ fontSize: '11px', color: 'var(--sub)', padding: '2px 8px', cursor: 'pointer' }}
              >
                {beCalcOpen ? '▾ 收起计算器' : '▸ 展开微调'}
              </button>
            </div>
          </div>

          {beCalcOpen && (
            <div style={{ marginTop: '12px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
              {/* 1. 模式与基本参数输入 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                {/* 正T / 倒T 切换 */}
                <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--line2)' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setBeMode('BUY');
                      if (c.inA) setBeEntryPxStr(String(f2(c.inA)));
                      else if (stock.price) setBeEntryPxStr(String(f2(stock.price)));
                    }}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: 'none',
                      background: beMode === 'BUY' ? 'var(--down)' : 'var(--surface2)',
                      color: beMode === 'BUY' ? '#fff' : 'var(--sub)'
                    }}
                  >
                    正T (先买后卖)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBeMode('REV');
                      if (c.outA) setBeEntryPxStr(String(f2(c.outA)));
                      else if (stock.price) setBeEntryPxStr(String(f2(stock.price)));
                    }}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: 'none',
                      background: beMode === 'REV' ? 'var(--up)' : 'var(--surface2)',
                      color: beMode === 'REV' ? '#fff' : 'var(--sub)'
                    }}
                  >
                    倒T (先卖后买)
                  </button>
                </div>

                {/* 开仓价格 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', fontWeight: 600 }}>
                    {beMode === 'BUY' ? '买入价格' : '卖出价格'}:
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={beEntryPxStr}
                    onChange={e => setBeEntryPxStr(e.target.value)}
                    style={{
                      width: '85px',
                      padding: '3px 7px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      borderRadius: '5px',
                      border: '1px solid var(--line2)',
                      background: '#fff'
                    }}
                  />
                  <button
                    type="button"
                    className="mini"
                    onClick={() => setBeEntryPxStr(f2(pxNow))}
                    title={`填入现价 ¥${f2(pxNow)}`}
                    style={{ fontSize: '10.5px', padding: '2px 5px' }}
                  >
                    现价
                  </button>
                  {beMode === 'BUY' ? (
                    <>
                      {c.inA && (
                        <button
                          type="button"
                          className="mini"
                          onClick={() => setBeEntryPxStr(f2(c.inA))}
                          title={`填入正T买点A ¥${f2(c.inA)}`}
                          style={{ fontSize: '10.5px', padding: '2px 5px', color: 'var(--down)' }}
                        >
                          买点A
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {c.outA && (
                        <button
                          type="button"
                          className="mini"
                          onClick={() => setBeEntryPxStr(f2(c.outA))}
                          title={`填入倒T卖点A ¥${f2(c.outA)}`}
                          style={{ fontSize: '10.5px', padding: '2px 5px', color: 'var(--up)' }}
                        >
                          卖点A
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* 做T股数 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', fontWeight: 600 }}>做T股数:</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={beQtyStr}
                    onChange={e => setBeQtyStr(e.target.value)}
                    style={{
                      width: '80px',
                      padding: '3px 7px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      borderRadius: '5px',
                      border: '1px solid var(--line2)',
                      background: '#fff'
                    }}
                  />
                  {[500, 1000].map(q => (
                    <button
                      key={q}
                      type="button"
                      className="mini"
                      onClick={() => setBeQtyStr(String(q))}
                      style={{ fontSize: '10.5px', padding: '2px 5px' }}
                    >
                      {q}
                    </button>
                  ))}
                  {stock.shares > 0 && (
                    <button
                      type="button"
                      className="mini"
                      onClick={() => setBeQtyStr(String(stock.shares))}
                      style={{ fontSize: '10.5px', padding: '2px 5px' }}
                      title={`全部底仓 ${stock.shares} 股`}
                    >
                      底仓
                    </button>
                  )}
                </div>

                {/* 费率与滑点快捷设置 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={beHasMin5}
                      onChange={e => setBeHasMin5(e.target.checked)}
                    />
                    <span>最低5元佣金</span>
                  </label>
                  <label style={{ fontSize: '11.5px', color: 'var(--sub)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <span>滑点:</span>
                    <select
                      value={beSlippage}
                      onChange={e => setBeSlippage(+e.target.value)}
                      style={{ fontSize: '11px', padding: '1px 4px', borderRadius: '4px', border: '1px solid var(--line)' }}
                    >
                      <option value={0}>0分 (限价)</option>
                      <option value={1}>1分钱 (冲单)</option>
                      <option value={2}>2分钱 (急单)</option>
                    </select>
                  </label>
                </div>
              </div>

              {/* 2. 四格指标核心结果看板 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '8px',
                marginBottom: '10px'
              }}>
                <div style={{ padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>保本目标价</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: beMode === 'BUY' ? 'var(--up)' : 'var(--down)', marginTop: '2px' }}>
                    ¥{f2(beResult.targetPx)}
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>{beMode === 'BUY' ? '必须高于此价卖出' : '必须低于此价接回'}</div>
                </div>

                <div style={{ padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>保本所需点差</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--text)', marginTop: '2px' }}>
                    {beMode === 'BUY' ? '+' : '-'}{f2(beResult.spread)} 元
                    <span style={{ fontSize: '11.5px', fontWeight: 600, marginLeft: '4px', color: beMode === 'BUY' ? 'var(--up)' : 'var(--down)' }}>
                      ({beMode === 'BUY' ? '+' : '-'}{beResult.pctDiff.toFixed(2)}%)
                    </span>
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>需跨越 {Math.round(beResult.spread / 0.01)} 个价位 Tick</div>
                </div>

                <div style={{ padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>双边规费损耗</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--warn-d)', marginTop: '2px' }}>
                    ¥{f2(beResult.totalFee)} 元
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>
                    买 ¥{f2(beResult.feeBuy)} + 卖 ¥{f2(beResult.feeSell)} (含税)
                  </div>
                </div>

                <div style={{ padding: '8px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--sub)' }}>1分钱波动敏度</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: '#1677ff', marginTop: '2px' }}>
                    ¥{f2(beResult.tickValue)} / 分
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--mute)' }}>做T规模: {beResult.qty} 股</div>
                </div>
              </div>

              {/* 3. 振幅与可行性智能评估条 */}
              <div style={{
                padding: '7px 12px',
                borderRadius: '6px',
                background: beFeasibility.bg,
                border: '1px solid',
                borderColor: beFeasibility.border,
                color: beFeasibility.color,
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '6px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>{beFeasibility.icon}</span>
                  <span style={{ fontWeight: 700 }}>【{beFeasibility.title}】</span>
                  <span>{beFeasibility.desc}</span>
                </div>
                <button
                  type="button"
                  className="mini"
                  style={{
                    background: '#fff',
                    color: 'var(--text)',
                    fontWeight: 700,
                    borderColor: beFeasibility.border,
                    padding: '2px 8px',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    onOpenQuickT(
                      stock,
                      beMode === 'BUY' ? '正T' : '倒T',
                      f2(beResult.targetPx),
                      beResult.qty
                    );
                  }}
                  title="将测算结果带入快捷记T弹窗"
                >
                  ⚡ 以此保本价快速记T
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 12档阶梯表格（限高 185px 纵向滚动，表头吸顶） */}
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>相对昨收</th>
                <th>价格</th>
                <th style={{ textAlign: 'right' }}>距现价</th>
                <th>含义</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>

        {/* 底部持仓数据概览 */}
        <div className="pos-row" style={{ marginTop: '10px' }}>
          <div>持仓股数: <b>{stock.shares ? Number(stock.shares).toLocaleString() : 0}</b> 股</div>
          <div>成本价: <b>¥{stock.cost ? f2(stock.cost) : '0.00'}</b> 元</div>
          <div>占用资金: <b>¥{money(curMarketVal)}</b> 元</div>
          {hasHoldings ? (
            <div style={{ color: floatProfit >= 0 ? 'var(--up)' : 'var(--down)', fontWeight: 700, fontSize: '12px' }}>
              浮动盈亏: {floatProfit >= 0 ? '+' : ''}¥{money(floatProfit)} ({floatRate >= 0 ? '+' : ''}{floatRate.toFixed(2)}%)
            </div>
          ) : (
            <div style={{ color: 'var(--mute)', fontSize: '12px' }}>当前空仓</div>
          )}
        </div>

        {/* 行情参数微调折叠 */}
        <details className="quote-fold" open={quoteFoldOpen} onToggle={e => setQuoteFoldOpen(e.target.open)}>
          <summary>⚙️ 行情参数与手工微调（10项指标已由行情接口自动同步 · 点击展开微调/压力推演）</summary>
          <div className="quote-bd">
            <div className="ig">
              {AUTO_FIELDS.map(k => (
                <div key={k} className="fld">
                  <label>{AUTO_FIELD_LABELS[k] || k}</label>
                  <input
                    value={manualValues[k] !== undefined ? manualValues[k] : fmtIn(stock[k])}
                    onChange={e => handleManualChange(k, e.target.value)}
                    className={manualValues[k] !== undefined ? 'man' : ''}
                  />
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>

      {/* 图表折叠 */}
      <details
        className="chart-fold"
        open={chartFoldOpen}
        onToggle={e => {
          setChartFoldOpen(e.target.open);
          stock._fo = e.target.open ? 1 : 0;
        }}
      >
        <summary>▾ 展开图表与技术细节（K线 / 副图 / 指标卡 / 估值·板块·强弱）</summary>
        {chartFoldOpen && (
          <div style={{ padding: '0 14px 14px' }}>
            <ChartCanvas
              stock={stock}
              poolIndex={index}
              onUpdateStock={onUpdateStock}
            />
            <TechAndResearchSection
              stock={stock}
              poolIndex={index}
            />
          </div>
        )}
      </details>
    </div>
  );
}
