import React, { useState } from 'react';
import { f2, pct, money } from '../services/utils.js';

export default function AccountSection({
  totalAssets,
  marketValue,
  posRate,
  cash,
  pool,
  snapshots,
  onTakeSnapshot,
  onClearSnap,
  onUpdateTotalAssets
}) {
  const [editingTotal, setEditingTotal] = useState(false);
  const [newTotal, setNewTotal] = useState(totalAssets);

  const handleSaveTotal = () => {
    const val = parseFloat(newTotal) || 0;
    if (val > 0) {
      onUpdateTotalAssets(val);
      setEditingTotal(false);
    }
  };

  return (
    <div id="accSec" style={{ marginTop: '20px' }}>
      <section>
        <h2>三、账户总览与资金管理</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>账户总资产</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}>
              {editingTotal ? (
                <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                  <input
                    type="number"
                    value={newTotal}
                    onChange={e => setNewTotal(e.target.value)}
                    style={{ width: '120px', padding: '3px 6px', fontSize: '14px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                  <button className="primary" onClick={handleSaveTotal} style={{ padding: '2px 8px', fontSize: '11px' }}>保存</button>
                  <button onClick={() => setEditingTotal(false)} style={{ padding: '2px 8px', fontSize: '11px' }}>取消</button>
                </div>
              ) : (
                <span onClick={() => { setNewTotal(totalAssets); setEditingTotal(true); }} title="点击修改总资产" style={{ cursor: 'pointer' }}>
                  ¥{money(totalAssets)} <span style={{ fontSize: '11px', color: 'var(--accent)' }}>✎</span>
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>点击金额可手动校准总本金</div>
          </div>

          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>持仓总市值</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px' }}>
              ¥{money(marketValue)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>全自选池实时标的市值总计</div>
          </div>

          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>可用可用现金</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px', color: 'var(--down)' }}>
              ¥{money(cash)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '4px' }}>总资产 − 市值</div>
          </div>

          <div className="card" style={{ padding: '14px', background: 'var(--surface2)' }}>
            <div style={{ fontSize: '12px', color: 'var(--sub)' }}>实际股票总仓位</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'ui-monospace,Consolas,monospace', marginTop: '4px', color: posRate > 80 ? 'var(--up)' : 'var(--text)' }}>
              {posRate.toFixed(1)}%
            </div>
            <div style={{ fontSize: '11px', color: posRate > 75 ? 'var(--up)' : 'var(--mute)', marginTop: '4px' }}>
              {posRate > 75 ? '⚠️ 仓位偏重，谨防回撤风险' : '仓位处于安全稳健区间'}
            </div>
          </div>
        </div>

        {/* 历史收盘净值与收益快照 */}
        <div style={{ marginTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h4 style={{ fontSize: '13.5px' }}>📈 每日收盘净值收益快照</h4>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="mini" onClick={onTakeSnapshot}>📸 记录今日收盘快照</button>
              {snapshots.length > 0 && <button className="mini" onClick={onClearSnap}>清空历史快照</button>}
            </div>
          </div>

          {snapshots && snapshots.length > 0 ? (
            <div className="tbl-scroll" style={{ maxHeight: '200px' }}>
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>总资产</th>
                    <th>总市值</th>
                    <th>现金</th>
                    <th>仓位</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s, idx) => (
                    <tr key={idx}>
                      <td>{s.date}</td>
                      <td><b>¥{money(s.total)}</b></td>
                      <td>¥{money(s.mkt)}</td>
                      <td>¥{money(s.cash)}</td>
                      <td>{s.rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: '14px', background: 'var(--surface)', borderRadius: '6px', fontSize: '12px', color: 'var(--mute)', textAlign: 'center' }}>
              暂无历史收盘快照。每日 15:05 收盘系统会自动为您记录，亦可点击上方手动记录。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
