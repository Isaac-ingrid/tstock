import React, { useState } from 'react';
import { f2, pct, money, money$, fmtIn, GRID, TIER_LABEL, AUTO_FIELDS, AUTO_FIELD_LABELS } from '../services/utils.js';
import { calc, posCalc, computeTA, rsCalc, drawRS } from '../services/api.js';
import { getAuctionTier } from '../services/auction.js';
import ChartCanvas from './ChartCanvas.jsx';

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
  onRemoveStock,
  onOpenQuickT,
  onOpenReason,
  onRefreshSingle,
  onCopySinglePlan
}) {
  const [quoteFoldOpen, setQuoteFoldOpen] = useState(false);
  const [chartFoldOpen, setChartFoldOpen] = useState(!!stock._fo);
  const [manualValues, setManualValues] = useState(stock.manual || {});

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

  const handleHoldingsChange = (field, val) => {
    const num = parseFloat(val) || 0;
    onUpdateStock({ ...stock, [field]: num });
  };

  // 12-tier Table rows
  const pxNow = +stock.price || 0;
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

        <button className="mini primary" onClick={() => onOpenQuickT(stock)}>⚡ 快捷记T</button>
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

        {/* 持仓就地录入条 */}
        <div className="pos-row" style={{ marginTop: '10px' }}>
          <div>持仓股数: <b>{stock.shares || 0}</b> 股</div>
          <div>成本价: <b>{f2(stock.cost)}</b> 元</div>
          <div>占用资金: <b>{money(pos.curMkt)}</b> 元</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>就地录入:</span>
            <input
              type="number"
              placeholder="股数"
              value={stock.shares || ''}
              onChange={e => handleHoldingsChange('shares', e.target.value)}
              style={{ width: '75px', padding: '2px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)' }}
            />
            <input
              type="number"
              step="0.01"
              placeholder="成本"
              value={stock.cost || ''}
              onChange={e => handleHoldingsChange('cost', e.target.value)}
              style={{ width: '75px', padding: '2px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)' }}
            />
          </div>
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
          </div>
        )}
      </details>
    </div>
  );
}
