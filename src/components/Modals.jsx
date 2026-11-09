import React, { useState, useEffect } from 'react';
import { f2, money, money2 } from '../services/utils.js';
import { calc } from '../services/api.js';

/* 1. 快捷记T弹窗 */
export function QuickTModal({ modalData, onClose, onConfirm }) {
  if (!modalData || !modalData.open) return null;
  return <QuickTModalInner modalData={modalData} onClose={onClose} onConfirm={onConfirm} />;
}

function QuickTModalInner({ modalData, onClose, onConfirm }) {
  const stock = modalData.stock || {};
  const { defaultDir, defaultPx, defaultQty } = modalData;
  const [dir, setDir] = useState(defaultDir || '正T');
  const [buyPx, setBuyPx] = useState(defaultDir === '正T' ? (defaultPx || stock.price) : (stock.price * 0.98).toFixed(2));
  const [sellPx, setSellPx] = useState(defaultDir === '正T' ? (stock.price * 1.02).toFixed(2) : (defaultPx || stock.price));
  const [qty, setQty] = useState(defaultQty || 100);

  const b = parseFloat(buyPx) || 0;
  const s = parseFloat(sellPx) || 0;
  const q = parseInt(qty, 10) || 0;
  const grossDiff = (s - b) * q;
  const fee = (b * q + s * q) * 0.0011;
  const netDiff = grossDiff - fee;
  const spreadPct = b > 0 ? ((s - b) / b) * 100 : 0;
  const totalHeld = stock.shares || 0;
  const newCost = totalHeld > 0 ? ((stock.cost * totalHeld - netDiff) / totalHeld) : 0;
  const costDrop = stock.cost > 0 && newCost > 0 ? (stock.cost - newCost) : 0;

  const handleConfirm = () => {
    if (b <= 0 || s <= 0 || q <= 0) {
      alert('请输入正确的买卖价格与股数');
      return;
    }
    onConfirm({
      stock,
      dir,
      buy: b,
      sell: s,
      qty: q,
      netDiff,
      newCost
    });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
        <div className="modal-hd">
          <h3>⚡ 闪电记T · {stock.name} ({stock.code})</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd">
          <div className="modal-dir-tabs" style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <button
              type="button"
              className={`m-dir-btn ${dir === '正T' ? 'active' : ''}`}
              style={{
                flex: 1, padding: '7px 0', borderRadius: '7px', fontWeight: 700,
                border: '1px solid', borderColor: dir === '正T' ? 'var(--down)' : 'var(--line)',
                background: dir === '正T' ? 'var(--down-bg)' : '#fff',
                color: dir === '正T' ? 'var(--down)' : 'var(--sub)'
              }}
              onClick={() => setDir('正T')}
            >
              🟢 正T（先买后卖 / 低吸高抛）
            </button>
            <button
              type="button"
              className={`m-dir-btn ${dir === '倒T' ? 'active' : ''}`}
              style={{
                flex: 1, padding: '7px 0', borderRadius: '7px', fontWeight: 700,
                border: '1px solid', borderColor: dir === '倒T' ? 'var(--up)' : 'var(--line)',
                background: dir === '倒T' ? 'var(--up-bg)' : '#fff',
                color: dir === '倒T' ? 'var(--up)' : 'var(--sub)'
              }}
              onClick={() => setDir('倒T')}
            >
              🔴 倒T（先卖后买 / 高抛低吸）
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div className="fld">
              <label>买入成交价 (元)</label>
              <input
                type="number" step="0.01" value={buyPx}
                onChange={e => setBuyPx(e.target.value)}
                style={{ width: '100%', minHeight: '32px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
              />
            </div>
            <div className="fld">
              <label>卖出成交价 (元)</label>
              <input
                type="number" step="0.01" value={sellPx}
                onChange={e => setSellPx(e.target.value)}
                style={{ width: '100%', minHeight: '32px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
              />
            </div>
          </div>

          <div className="fld" style={{ marginBottom: '14px' }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>成交股数</span>
              <span style={{ color: 'var(--sub)' }}>建议T仓: {Math.max(100, Math.floor((totalHeld * 0.3) / 100) * 100)} 股</span>
            </label>
            <input
              type="number" step="100" value={qty}
              onChange={e => setQty(e.target.value)}
              style={{ width: '100%', minHeight: '32px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
            />
          </div>

          <div className="quickt-preview" style={{ background: 'var(--surface2)', padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px', lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>单笔差价毛利:</span>
              <b className={grossDiff >= 0 ? 'up' : 'down'}>{grossDiff >= 0 ? '+' : ''}{money(grossDiff)} 元 ({spreadPct >= 0 ? '+' : ''}{spreadPct.toFixed(2)}%)</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>扣除规费与摩擦 (0.11%):</span>
              <span style={{ color: 'var(--sub)' }}>−{fee.toFixed(2)} 元</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed var(--line)', paddingTop: '4px', marginTop: '4px' }}>
              <b>本次净套利差额:</b>
              <b className={netDiff >= 0 ? 'up' : 'down'} style={{ fontSize: '14px' }}>{netDiff >= 0 ? '+' : ''}{money(netDiff)} 元</b>
            </div>
            {totalHeld > 0 ? (
              <div style={{ color: 'var(--accent)', marginTop: '4px' }}>
                💡 摊薄后底仓成本：{stock.cost} → <b>{f2(newCost)}</b> 元 ({costDrop >= 0 ? `成本下降 ${costDrop.toFixed(2)} 元` : `成本上升 ${Math.abs(costDrop).toFixed(2)} 元`})
              </div>
            ) : null}
          </div>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>取消</button>
          <button className="primary" onClick={handleConfirm} style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}>确认记入台账</button>
        </div>
      </div>
    </div>
  );
}

/* 2. 入选理由与利空排查弹窗 */
export function StockReasonModal({ modalData, onClose, onAdd, onJumpCard }) {
  if (!modalData || !modalData.open) return null;
  const { stock, inPool } = modalData;
  if (!stock) return null;

  return (
    <StockReasonModalInner
      stock={stock}
      inPool={inPool}
      onClose={onClose}
      onAdd={onAdd}
      onJumpCard={onJumpCard}
    />
  );
}

function StockReasonModalInner({ stock, inPool, onClose, onAdd, onJumpCard }) {
  const [initShares, setInitShares] = useState(stock.shares ? String(stock.shares) : '');
  const [initCost, setInitCost] = useState(stock.cost ? String(stock.cost) : (stock.price ? String(stock.price) : ''));

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <div className="modal-hd">
          <h3>🔍 入选逻辑与风险排查 · {stock.name} ({stock.code})</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '13px', lineHeight: 1.7 }}>
          <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'var(--surface2)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ fontWeight: 700, fontSize: '14px' }}>{stock.poolLabel || (stock.pool === 'steady' ? '稳健底仓' : '短线候选')}</span>
              <span className={`pill ${stock.verdict === '可做' ? 'p-buy' : stock.verdict === '小做' ? 'p-sell' : 'p-none'}`}>{stock.verdict || '观察'}</span>
            </div>
            <div style={{ color: 'var(--sub)', fontSize: '12px' }}>综合量化得分：<b>{stock.score || 80}</b> 分 ｜ 当前参考价：<b>{stock.price || stock.close || '—'}</b> 元</div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <h4 style={{ fontSize: '13px', marginBottom: '6px', color: 'var(--text)' }}>📌 核心入选逻辑与量价支撑</h4>
            <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--sub)' }}>
              {(stock.whyReasons || [
                `日内分时均价线支撑扎实，重心未破`,
                `量比大于 1.2，盘口换手活跃，具备充裕日内振幅`,
                `非ST且无恶性退市风险，属于活跃做T标的`
              ]).map((r, idx) => (
                <li key={idx} style={{ marginBottom: '4px' }}>{r}</li>
              ))}
            </ul>
          </div>

          {stock.riskCheck ? (
            <div style={{ padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--line)' }}>
              <h4 style={{ fontSize: '12.5px', marginBottom: '4px', color: stock.riskCheck.status === 'safe' ? 'var(--down)' : 'var(--warn)' }}>
                {stock.riskCheck.statusText || '🟢 未见重大恶性利空'}
              </h4>
              <div style={{ fontSize: '12px', color: 'var(--sub)' }}>
                {(stock.riskCheck.highlights || []).join(' ｜ ')}
              </div>
            </div>
          ) : null}

          {!inPool && (
            <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--surface2)', borderRadius: '8px', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                💼 预设做T底仓信息（选填，并入后可在卡片随时修改）：
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>持仓股数:</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="如 1000"
                    value={initShares}
                    onChange={e => setInitShares(e.target.value)}
                    style={{ width: '85px', padding: '4px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)', background: '#fff' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>成本单价:</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="如 30.50"
                    value={initCost}
                    onChange={e => setInitCost(e.target.value)}
                    style={{ width: '85px', padding: '4px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--line)', background: '#fff' }}
                  />
                </div>
                <button
                  type="button"
                  className="mini"
                  onClick={() => setInitCost(stock.price ? String(stock.price) : '')}
                  style={{ padding: '3px 8px', fontSize: '11px', cursor: 'pointer' }}
                >
                  ⚡ 填入现价
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>关闭</button>
          {inPool && onJumpCard ? (
            <button
              className="primary"
              onClick={() => {
                onJumpCard(stock);
                onClose();
              }}
              style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}
            >
              👉 直达该股做T决策卡片
            </button>
          ) : null}
          {!inPool && onAdd ? (
            <button
              className="primary"
              onClick={() => {
                const sNum = parseInt(initShares, 10) || 0;
                const cNum = parseFloat(initCost) || 0;
                onAdd({
                  ...stock,
                  shares: sNum,
                  cost: cNum
                });
                onClose();
              }}
              style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}
            >
              ＋ 一键并入自选池
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* 3. A股日内分时作战法则时段禁忌表弹窗 */
export function TradingClockModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '580px' }}>
        <div className="modal-hd">
          <h3>⏰ A 股日内分时作战法则（时段禁忌表）</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '12.5px', lineHeight: 1.7 }}>
          <div style={{ marginBottom: '10px', padding: '8px 12px', background: 'var(--surface2)', borderRadius: '7px', border: '1px solid var(--line)' }}>
            <b>核心铁律：</b>A 股做T有极其残酷的时段效应，在错误的时间挂单（如 09:30 追高或中午垃圾时间乱买），胜率会断崖式暴跌。请严格对照当前时段作战。
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--surface)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>时段</th>
                <th style={{ padding: '6px 8px' }}>作战时区属性</th>
                <th style={{ padding: '6px 8px' }}>操作纪律与禁忌</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>09:15-09:25</td><td>集合竞价期</td><td>盯开盘定高低，看竞价异动，不盲目抢跑</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>09:25-09:30</td><td>竞价定盘期</td><td>跑竞价校准，定全天挂单预期买卖点</td></tr>
              <tr style={{ background: 'var(--up-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--up)' }}>09:30-09:45</td><td style={{ color: 'var(--up)', fontWeight: 700 }}>⚠️ 情绪宣泄诱多期</td><td>假摔诱多极多，<b>严禁冲动追高开仓</b>，等待分时均线平稳</td></tr>
              <tr style={{ background: 'var(--down-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--down)' }}>09:45-10:30</td><td style={{ color: 'var(--down)', fontWeight: 700 }}>🎯 做T黄金主窗口</td><td>方向确立，缩量回踩分时均线低吸正T，放量冲高乏力倒T</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>10:30-11:30</td><td>震荡巩固期</td><td>检验均线支撑，未达成做T条件的停止追单</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>11:30-13:00</td><td>午间休市</td><td>复盘上午量能承接，梳理午后挂单</td></tr>
              <tr style={{ background: 'var(--warn-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--warn-d)' }}>13:00-14:00</td><td>💤 缩量垃圾时间</td><td>全天成交低谷，无量假突破居多，<b>管住手，多看少动</b></td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>14:00-14:30</td><td>变盘预警期</td><td>主力抢跑与方向突变窗口，警惕破位跳水</td></tr>
              <tr style={{ background: 'var(--up-bg)' }}><td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--up)' }}>14:30-14:55</td><td style={{ color: 'var(--up)', fontWeight: 700 }}>🚨 T仓强制平仓期</td><td><b>做T绝不过夜变加仓！</b>必须在此窗口将今日T仓平掉归位或止损</td></tr>
              <tr><td style={{ padding: '6px 8px', fontWeight: 700 }}>14:55-15:00</td><td>尾盘集合竞价</td><td>全天定盘收官，持仓锁定</td></tr>
            </tbody>
          </table>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="btn-cancel" onClick={onClose} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff', cursor: 'pointer' }}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  );
}

/* 4. 全局 Toast 提示容器 */
export function ToastHost({ toasts, onDismiss }) {
  return (
    <div id="toastHost" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>
          <span className="ti">{t.kind === 'ok' ? '✓' : t.kind === 'err' ? '!' : t.kind === 'warn' ? '⚠' : 'i'}</span>
          <span className="tx">{t.msg}</span>
          <button className="tc" title="关闭" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/* 5. 尾盘过夜风控横幅 */
export function OvernightBanner({ visible, onClose }) {
  if (!visible) return null;
  return (
    <div id="overnightAlertBanner" className="overnight-alert-banner">
      <div className="oab-txt">🚨 尾盘强制风控：检测到今日存在尚未平仓的正T买入！做T铁律：绝不过夜变加仓！请在 14:55 前果断挂卖平仓或止损！</div>
      <button className="oab-close" onClick={onClose}>×</button>
    </div>
  );
}

/* 6. 盘中到价与买卖提醒中心弹窗 */
export function AlertCenterModal({ open, onClose, pool, onJumpCard, notifyActive, onToggleNotify, alertEnabled = true, onToggleAlertEnabled }) {
  if (!open) return null;
  return (
    <AlertCenterModalInner
      onClose={onClose}
      pool={pool}
      onJumpCard={onJumpCard}
      notifyActive={notifyActive}
      onToggleNotify={onToggleNotify}
      alertEnabled={alertEnabled}
      onToggleAlertEnabled={onToggleAlertEnabled}
    />
  );
}

function AlertCenterModalInner({ onClose, pool, onJumpCard, notifyActive, onToggleNotify, alertEnabled, onToggleAlertEnabled }) {
  const [alertList, setAlertList] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('t-system-alerts') || '[]');
    } catch (_) {
      return [];
    }
  });

  useEffect(() => {
    const handleAlerts = (e) => {
      if (e.detail) setAlertList(e.detail);
    };
    window.addEventListener('t-alert-triggered', handleAlerts);
    return () => window.removeEventListener('t-alert-triggered', handleAlerts);
  }, []);

  const handleClearAlerts = () => {
    localStorage.setItem('t-system-alerts', '[]');
    setAlertList([]);
  };

  // 实时扫描自选池股票到买卖点的距离
  const poolNearList = (pool || []).map(s => {
    const p = +s.price || +s.prevClose || 0;
    let c = null;
    try { c = calc(s); } catch (_) {}
    if (!c || !p) return null;

    const targets = [
      { label: '正T买点', lv: +c.inA, dir: 'buy' },
      { label: '第二买点', lv: +c.inB, dir: 'buy' },
      { label: '倒T卖点', lv: +c.outA, dir: 'sell' },
      { label: '卖飞线', lv: +c.fly, dir: 'fly' }
    ].filter(t => t.lv > 0);

    const nearest = targets.map(t => {
      const dev = (p - t.lv) / t.lv * 100;
      return { ...t, dev, absDev: Math.abs(dev) };
    }).sort((a, b) => a.absDev - b.absDev)[0];

    return {
      name: s.name,
      code: s.code,
      price: p,
      nearest
    };
  }).filter(Boolean);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '620px' }}>
        <div className="modal-hd">
          <h3>🔔 盘中买卖与到价提醒中心</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-bd" style={{ fontSize: '13px', lineHeight: 1.6 }}>
          {/* 1. 上班免打扰模式与提醒主开关（一键静音、止震、关闭桌面弹窗与标题闪烁） */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            background: alertEnabled ? '#f0f5ff' : '#fff1f0',
            border: alertEnabled ? '1px solid #adc6ff' : '1px solid #ffa39e',
            borderRadius: '8px',
            marginBottom: '14px',
            gap: '12px'
          }}>
            <div style={{ flex: 1 }}>
              <div style={{
                fontWeight: 700,
                color: alertEnabled ? '#1d39c4' : '#cf1322',
                fontSize: '13.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <span>{alertEnabled ? '🔔 实时买卖提醒：运行中' : '🔕 上班免打扰模式：已开启（全部提醒已关闭）'}</span>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '3px', lineHeight: 1.5 }}>
                {alertEnabled
                  ? '触及买卖点时将触发声音蜂鸣、网页标签标题变动、桌面弹窗及预警气泡。'
                  : '已全面静音所有蜂鸣、禁止网页标签页标题闪烁、屏蔽所有桌面弹窗与预警，适合在办公室安心工作。'}
              </div>
            </div>
            {onToggleAlertEnabled && (
              <button
                type="button"
                onClick={onToggleAlertEnabled}
                style={{
                  padding: '7px 15px',
                  fontSize: '12px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  border: 'none',
                  background: alertEnabled ? '#ff4d4f' : '#52c41a',
                  color: '#fff',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
              >
                {alertEnabled ? '🔕 立即关闭提醒（上班免打扰）' : '🔔 恢复开启提醒'}
              </button>
            )}
          </div>
          {/* 桌面通知授权与开关横幅 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: notifyActive ? '#f6ffed' : '#fffbe6',
            border: notifyActive ? '1px solid #b7eb8f' : '1px solid #ffe58f',
            borderRadius: '8px',
            marginBottom: '14px'
          }}>
            <div>
              <div style={{ fontWeight: 700, color: notifyActive ? '#389e0d' : '#d48806', fontSize: '13px' }}>
                {notifyActive ? '🟢 桌面弹窗通知已开启' : '🟡 桌面弹窗通知未授权'}
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                {notifyActive
                  ? '触及买卖点时系统将自动弹出桌面窗口（即使切到微信或行情软件也能收到）。'
                  : '建议开启桌面通知，当股票触及做T买点或卖点时系统第一时间弹窗提醒。'}
              </div>
            </div>
            {!notifyActive && onToggleNotify && (
              <button
                type="button"
                className="primary"
                onClick={onToggleNotify}
                style={{ padding: '5px 12px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'pointer' }}
              >
                开启桌面通知
              </button>
            )}
          </div>

          {/* 自选池实时临界买卖点监测 */}
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🎯 自选股近邻做T买卖点距现价一览</span>
              <span style={{ fontSize: '11px', color: 'var(--mute)', fontWeight: 400 }}>（现价距买卖位偏差 ≤ 0.4% 时自动报警）</span>
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
              {poolNearList.map(item => {
                const n = item.nearest;
                if (!n) return null;
                const isNear = n.absDev <= 0.4;
                return (
                  <div
                    key={item.code}
                    onClick={() => {
                      if (onJumpCard) onJumpCard(item.code);
                      onClose();
                    }}
                    style={{
                      padding: '8px 12px',
                      background: isNear ? '#fff1f0' : 'var(--surface)',
                      border: isNear ? '1px solid #ffa39e' : '1px solid var(--line)',
                      borderRadius: '7px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                    title="点击立即跳转查看该股做T决策卡片"
                  >
                    <div>
                      <b style={{ color: 'var(--text)' }}>{item.name}</b> <span style={{ fontSize: '11.5px', color: 'var(--mute)' }}>{item.code}</span>
                      <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                        现价 ¥{f2(item.price)} ➔ 目标【{n.label}】¥{f2(n.lv)}
                      </div>
                    </div>
                    <span style={{
                      fontWeight: 700,
                      fontSize: '12px',
                      color: isNear ? 'var(--up)' : 'var(--sub)',
                      fontFamily: 'ui-monospace,Consolas,monospace'
                    }}>
                      {n.dev >= 0 ? '+' : ''}{n.dev.toFixed(2)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 今日已触发提醒流水记录 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <h4 style={{ fontSize: '13px', margin: 0, color: 'var(--text)' }}>
                📋 今日买卖到价提醒历史流水 ({alertList.length}条)
              </h4>
              {alertList.length > 0 && (
                <button
                  type="button"
                  className="mini"
                  onClick={handleClearAlerts}
                  style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer' }}
                >
                  清空流水
                </button>
              )}
            </div>

            {alertList.length > 0 ? (
              <div className="alert-list" style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}>
                {alertList.map(a => (
                  <div key={a.id} className="alert-row">
                    <span className="ah">{a.time}</span>
                    <span className="ak k-price">{a.label}</span>
                    <span className="ad">
                      <b>{a.name}</b> 现价 ¥{f2(a.price)} 已触及【{a.label} ¥{f2(a.target)}】（偏差 {(a.dev * 100).toFixed(2)}%）
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--mute)', background: 'var(--surface2)', borderRadius: '8px', fontSize: '12.5px' }}>
                今天尚未触发到价提醒。<br />
                系统会在盘中自动拉取腾讯实时行情（每分钟/30秒自动轮询）；<br />
                当自选股现价触及正T买点、倒T卖点或止损位时，将第一时间在此处与桌面弹窗报警！
              </div>
            )}
          </div>
        </div>
        <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
          <button className="primary" onClick={onClose} style={{ padding: '6px 18px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
