import React, { useState, useEffect } from 'react';
import { f2, pct, money, money$, fmtIn, GRID, TIER_LABEL, AUTO_FIELDS, AUTO_FIELD_LABELS, toastOk } from '../services/utils.js';
import { calc, posCalc, computeTA, rsCalc, drawRS } from '../services/api.js';
import { getAuctionTier } from '../services/auction.js';
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
  const pxNow = +stock.price || 0;
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
          title="底仓配置状态"
        >
          {hasHoldings ? `持仓 ${Number(stock.shares).toLocaleString()}股 · 成本 ¥${f2(stock.cost)}` : '未设底仓'}
        </span>

        <button className="mini primary" onClick={() => onOpenQuickT(stock)}>⚡ 快捷记T</button>
        <button
          className="mini"
          style={{ color: '#1677ff', borderColor: '#91caff', background: '#e6f4ff', fontWeight: 700 }}
          onClick={() => onOpenQuickT(stock, '直接买入', f2(stock.price), hasHoldings ? 500 : 1000)}
          title="直接买入建仓或加仓（自动计算加权平均持仓成本）"
        >
          📥 买入{hasHoldings ? '/加仓' : ''}
        </button>
        {hasHoldings && (
          <button
            className="mini"
            style={{ color: '#cf1322', borderColor: '#ffa39e', background: '#fff1f0', fontWeight: 700 }}
            onClick={() => onOpenQuickT(stock, '直接卖出', f2(stock.price), stock.shares || 100)}
            title="直接卖出当前持仓（减仓回笼资金或全部清仓出局）"
          >
            📤 卖出
          </button>
        )}
        <button className="mini" onClick={() => onOpenReason(stock, true)}>🔍 逻辑与利空</button>
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
