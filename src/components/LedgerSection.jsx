import React, { useState } from 'react';
import { f2, money, pct, todayStr } from '../services/utils.js';

export default function LedgerSection({
  logs,
  onAddLog,
  onDeleteLog,
  pool,
  onExport,
  onImportClick
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState({
    date: todayStr(),
    stock: pool.length ? `${pool[0].name} (${pool[0].code})` : '',
    dir: '正T',
    buy: '',
    sell: '',
    qty: '100',
    plan: '计划内',
    basis: '客观信号',
    note: ''
  });

  const handleFormChange = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const b = parseFloat(form.buy) || 0;
    const s = parseFloat(form.sell) || 0;
    const q = parseInt(form.qty, 10) || 0;
    if (b <= 0 || s <= 0 || q <= 0) {
      alert('请输入正确的买卖价格与股数');
      return;
    }
    const gross = (s - b) * q;
    const fee = (b * q + s * q) * 0.0011;
    const net = gross - fee;

    onAddLog({
      id: Date.now(),
      date: form.date,
      stock: form.stock,
      dir: form.dir,
      buy: b,
      sell: s,
      qty: q,
      gross,
      fee,
      net,
      plan: form.plan,
      basis: form.basis,
      note: form.note
    });

    setShowAddModal(false);
    setForm(prev => ({ ...prev, buy: '', sell: '', note: '' }));
  };

  // Position Health check
  const zombieStocks = pool.filter(s => {
    const amp = s.prevClose > 0 && s.high && s.low ? ((s.high - s.low) / s.prevClose) * 100 : 0;
    return amp > 0 && amp < 3.5;
  });

  return (
    <div id="secLog" style={{ marginTop: '20px' }}>
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <h2>做T流水台账</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="primary" onClick={() => setShowAddModal(true)}>＋ 新增做T记录</button>
            <button onClick={onExport}>⬇ 导出备份</button>
            <button onClick={onImportClick}>⬆ 导入恢复</button>
          </div>
        </div>

        {/* 流水明细表格 */}
        <div className="tbl-scroll" style={{ maxHeight: '280px' }}>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>标的名称</th>
                <th>方向</th>
                <th>买入价</th>
                <th>卖出价</th>
                <th>股数</th>
                <th>净套利额</th>
                <th>决策</th>
                <th>依据</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {logs.length > 0 ? (
                logs.map(lg => (
                  <tr key={lg.id}>
                    <td>{lg.date}</td>
                    <td style={{ fontWeight: 600 }}>{lg.stock}</td>
                    <td>
                      <span className={`pill ${
                        lg.dir === '正T' || lg.dir === '尾盘买入' || lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入'
                          ? 'p-buy'
                          : 'p-sell'
                      }`}>
                        {lg.dir}
                      </span>
                    </td>
                    <td className="num">{lg.buy > 0 ? f2(lg.buy) : '—'}</td>
                    <td className="num">{lg.sell > 0 ? f2(lg.sell) : '—'}</td>
                    <td className="num">{lg.qty}</td>
                    <td className="num">
                      {lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入' ? (
                        <span style={{ color: '#1677ff', fontSize: '11.5px', fontWeight: 600 }}>持仓增厚</span>
                      ) : (
                        <b className={lg.net >= 0 ? 'up' : 'down'}>{lg.net >= 0 ? '+' : ''}{money(lg.net)}</b>
                      )}
                    </td>
                    <td>{lg.plan}</td>
                    <td>{lg.basis}</td>
                    <td style={{ color: 'var(--sub)', fontSize: '11.5px' }}>{lg.note || '—'}</td>
                    <td>
                      <button className="mini" onClick={() => onDeleteLog(lg.id)} style={{ color: 'var(--up)' }}>删除</button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="11" style={{ textAlign: 'center', padding: '24px', color: 'var(--mute)' }}>
                    暂无做T交易流水记录。每次日内做T后，点击股票卡片上的「⚡ 快捷记T」可一秒入账。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 账户持仓健康体检 */}
        <div style={{ marginTop: '22px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '10px' }}>🩺 每日持仓健康体检（防死扛、防僵尸股）</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
            <div className="card" style={{ padding: '12px', background: 'var(--surface2)' }}>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>🛡️ 1.5% 止损铁律执行度</div>
              <p style={{ fontSize: '12px', color: 'var(--sub)', margin: 0 }}>
                做T底线：日内正T开仓后浮亏触及 1.5% 坚决砍仓，绝不就地躺平。
              </p>
            </div>
            <div className="card" style={{ padding: '12px', background: 'var(--surface2)' }}>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>⚠️ 活跃度排查（僵尸股预警）</div>
              <p style={{ fontSize: '12px', color: zombieStocks.length ? 'var(--up)' : 'var(--down)', margin: 0 }}>
                {zombieStocks.length ? `当前自选中有 ${zombieStocks.length} 只振幅不足 3.5%（${zombieStocks.map(s=>s.name).join('、')}），做T无利润空间建议剔除。` : '自选股振幅均在良性区间，无僵尸股风险。'}
              </p>
            </div>
            <div className="card" style={{ padding: '12px', background: 'var(--surface2)' }}>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>⏰ 尾盘绝不过夜变加仓</div>
              <p style={{ fontSize: '12px', color: 'var(--sub)', margin: 0 }}>
                14:55 前若正T未达止盈，坚决平掉归位，底仓与T仓必须物理隔离。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 新增台账 Modal */}
      {showAddModal && (
        <div className="modal-mask" onClick={() => setShowAddModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="modal-hd">
              <h3>＋ 手工新增做T台账记录</h3>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-bd" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12.5px' }}>
                <div className="fld">
                  <label>交易日期</label>
                  <input type="date" value={form.date} onChange={e => handleFormChange('date', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>交易标的</label>
                  <input value={form.stock} onChange={e => handleFormChange('stock', e.target.value)} placeholder="如：上海沿浦 (605128)" required />
                </div>
                <div className="fld">
                  <label>做T方向</label>
                  <select value={form.dir} onChange={e => handleFormChange('dir', e.target.value)}>
                    <option value="正T">正T（先买后卖）</option>
                    <option value="倒T">倒T（先卖后买）</option>
                    <option value="尾盘买入">尾盘买入（潜伏）</option>
                    <option value="尾盘平仓">尾盘平仓（清仓）</option>
                  </select>
                </div>
                <div className="fld">
                  <label>股数</label>
                  <input type="number" step="100" value={form.qty} onChange={e => handleFormChange('qty', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>买入价 (元)</label>
                  <input type="number" step="0.01" value={form.buy} onChange={e => handleFormChange('buy', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>卖出价 (元)</label>
                  <input type="number" step="0.01" value={form.sell} onChange={e => handleFormChange('sell', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>决策类型</label>
                  <select value={form.plan} onChange={e => handleFormChange('plan', e.target.value)}>
                    <option value="计划内">计划内执行</option>
                    <option value="临时起意">临时起意</option>
                  </select>
                </div>
                <div className="fld">
                  <label>买入依据</label>
                  <select value={form.basis} onChange={e => handleFormChange('basis', e.target.value)}>
                    <option value="客观信号">客观量价信号</option>
                    <option value="我觉得">我觉得会涨</option>
                    <option value="消息面">消息面刺激</option>
                  </select>
                </div>
                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label>操作复盘备注</label>
                  <input value={form.note} onChange={e => handleFormChange('note', e.target.value)} placeholder="如：回踩分时均价线买入，冲高 2% 坚决兑现" />
                </div>
              </div>
              <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="btn-cancel" onClick={() => setShowAddModal(false)}>取消</button>
                <button type="submit" className="primary">确认提交记录</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
