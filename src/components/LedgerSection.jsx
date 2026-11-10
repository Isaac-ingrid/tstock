import React, { useState, useMemo } from 'react';
import { f2, money, pct, todayStr } from '../services/utils.js';

export default function LedgerSection({
  logs = [],
  onAddLog,
  onDeleteLog,
  pool = [],
  onExport,
  onImportClick
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedChartStock, setSelectedChartStock] = useState('ALL');
  const [hoverIdx, setHoverIdx] = useState(null);
  const [form, setForm] = useState({
    date: todayStr(),
    stock: pool.length ? `${pool[0].name} (${pool[0].code})` : '',
    dir: '正T',
    buy: '',
    sell: '',
    qty: '500',
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
    const buyFee = Math.max(5, b * q * 0.00025) + b * q * 0.00001;
    const sellFee = Math.max(5, s * q * 0.00025) + s * q * 0.00051;
    const fee = Math.round((buyFee + sellFee) * 100) / 100;
    const net = Math.round((gross - fee) * 100) / 100;

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

  // 提取已平仓做T闭环交易记录（排除单纯买入加仓）
  const closedTLogs = useMemo(() => {
    return (logs || []).filter(lg => {
      const isPureBuy = lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入';
      return !isPureBuy && (lg.buy > 0 && lg.sell > 0);
    });
  }, [logs]);

  // 统计核心战报指标
  const stats = useMemo(() => {
    const today = todayStr();
    const todayLogs = closedTLogs.filter(lg => lg.date === today);
    const todayNet = todayLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);
    const totalNet = closedTLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);
    const winCount = closedTLogs.filter(lg => (+lg.net || 0) > 0).length;
    const lossCount = closedTLogs.length - winCount;
    const winRate = closedTLogs.length > 0 ? (winCount / closedTLogs.length) * 100 : 0;
    const plannedCount = (logs || []).filter(lg => lg.plan === '计划内').length;
    const disciplineRate = logs.length > 0 ? (plannedCount / logs.length) * 100 : 100;
    const bestTrade = closedTLogs.length > 0
      ? closedTLogs.reduce((best, cur) => ((+cur.net || 0) > (+best.net || -Infinity) ? cur : best), closedTLogs[0])
      : null;

    // 按日期倒序汇总
    const dailyMap = {};
    closedTLogs.forEach(lg => {
      const d = lg.date || today;
      if (!dailyMap[d]) dailyMap[d] = { date: d, net: 0, count: 0 };
      dailyMap[d].net += (+lg.net || 0);
      dailyMap[d].count += 1;
    });
    const dailyList = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

    // 提取有流水的标的清单
    const stockSet = new Set();
    closedTLogs.forEach(lg => {
      if (lg.stock) stockSet.add(lg.stock);
    });
    const stockOptions = Array.from(stockSet);

    return {
      todayNet,
      todayCount: todayLogs.length,
      totalNet,
      totalCount: closedTLogs.length,
      winCount,
      lossCount,
      winRate,
      disciplineRate,
      bestTrade,
      dailyList,
      stockOptions
    };
  }, [closedTLogs, logs]);

  // 构建图表数据序列：支持【全部做T累计收益曲线】及【个股成本摊薄曲线】
  const chartData = useMemo(() => {
    const sorted = [...closedTLogs].sort((a, b) => {
      const d = (a.date || '').localeCompare(b.date || '');
      return d !== 0 ? d : (a.id || 0) - (b.id || 0);
    });

    if (selectedChartStock === 'ALL') {
      if (sorted.length === 0) return { mode: 'ALL', points: [] };
      let cum = 0;
      const points = [{ idx: 0, label: '起点', date: sorted[0].date, val: 0, delta: 0, stock: '账户起步' }];
      sorted.forEach((lg, i) => {
        cum += (+lg.net || 0);
        points.push({
          idx: i + 1,
          label: `${lg.date.slice(5)} · ${lg.stock.split(' ')[0]}`,
          date: lg.date,
          val: Math.round(cum * 100) / 100,
          delta: +lg.net || 0,
          stock: lg.stock,
          dir: lg.dir
        });
      });
      return { mode: 'ALL', points, totalNet: cum };
    } else {
      const sLogs = sorted.filter(lg => lg.stock === selectedChartStock);
      if (sLogs.length === 0) return { mode: 'STOCK', points: [] };

      // 匹配当前自选股中的底仓与成本
      const matched = pool.find(p => selectedChartStock.includes(p.code) || selectedChartStock.includes(p.name));
      const baseShares = (matched && matched.shares > 0) ? matched.shares : Math.max(sLogs[0].qty || 500, 1000);
      const totalStockProfit = sLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);

      // 优先以当前参考成本推算未做T前的原始成本（或取首笔交易参考价）
      const curBrokerCost = (matched && matched.cost > 0) ? +matched.cost : sLogs[0].buy;
      const initialRefCost = Math.round((curBrokerCost + (totalStockProfit / baseShares)) * 100) / 100;

      let cum = 0;
      const points = [{
        idx: 0,
        label: '建仓原点',
        date: sLogs[0].date,
        val: initialRefCost,
        cumNet: 0,
        delta: 0
      }];

      sLogs.forEach((lg, i) => {
        cum += (+lg.net || 0);
        const dilutedCost = Math.round((initialRefCost - (cum / baseShares)) * 100) / 100;
        points.push({
          idx: i + 1,
          label: `${lg.date.slice(5)} (${lg.dir})`,
          date: lg.date,
          val: dilutedCost,
          cumNet: Math.round(cum * 100) / 100,
          delta: +lg.net || 0,
          dir: lg.dir,
          buy: lg.buy,
          sell: lg.sell,
          qty: lg.qty
        });
      });

      const finalCost = points[points.length - 1].val;
      const costReduced = Math.round((initialRefCost - finalCost) * 100) / 100;
      const reducePct = initialRefCost > 0 ? (costReduced / initialRefCost) * 100 : 0;

      return {
        mode: 'STOCK',
        points,
        initialRefCost,
        finalCost,
        costReduced,
        reducePct,
        baseShares,
        totalStockProfit
      };
    }
  }, [closedTLogs, selectedChartStock, pool]);

  // 渲染 SVG 折线图
  const renderCurveSvg = () => {
    const pts = chartData.points || [];
    if (pts.length < 2) {
      return (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--mute)', fontSize: '12.5px', background: 'var(--surface2)', borderRadius: '8px', border: '1px dashed var(--line)' }}>
          暂无足够的闭环做T流水数据用于绘制曲线。点击下方「⚡ 快捷记T」或「＋ 新增做T记录」累计 1 笔及以上做T记录后，系统将自动生成成本摊薄曲线！
        </div>
      );
    }

    const W = 760, H = 190, PL = 58, PR = 26, PT = 22, PB = 28;
    const innerW = W - PL - PR;
    const innerH = H - PT - PB;

    const vals = pts.map(p => p.val);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    } else {
      const pad = (maxV - minV) * 0.15;
      minV -= pad;
      maxV += pad;
    }

    const X = i => PL + (innerW * i) / (pts.length - 1);
    const Y = v => PT + innerH - ((v - minV) / (maxV - minV)) * innerH;

    const polyPoints = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.val).toFixed(1)}`).join(' ');
    const areaPoints = `${X(0).toFixed(1)},${(PT + innerH).toFixed(1)} ${polyPoints} ${X(pts.length - 1).toFixed(1)},${(PT + innerH).toFixed(1)}`;

    const isStockMode = chartData.mode === 'STOCK';
    const isPositive = isStockMode ? chartData.costReduced >= 0 : chartData.totalNet >= 0;
    const strokeCol = isStockMode ? '#7c3aed' : (isPositive ? '#cf1322' : '#0a7f42');
    const fillCol = isStockMode ? 'rgba(124, 58, 237, 0.12)' : (isPositive ? 'rgba(207, 19, 34, 0.12)' : 'rgba(10, 127, 66, 0.12)');

    const activePt = (hoverIdx != null && pts[hoverIdx]) ? pts[hoverIdx] : pts[pts.length - 1];

    return (
      <div>
        {/* 曲线顶部即时数据读取条 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px', fontSize: '12px', padding: '6px 10px', background: 'var(--surface2)', borderRadius: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: 'var(--text)' }}>
              {activePt.label} ({activePt.date})
            </span>
            {isStockMode ? (
              <>
                <span>当时摊薄成本: <b style={{ color: '#7c3aed', fontFamily: 'monospace' }}>¥{f2(activePt.val)}</b></span>
                {activePt.idx > 0 && (
                  <span>
                    该笔套利: <b className={activePt.delta >= 0 ? 'up' : 'down'} style={{ fontFamily: 'monospace' }}>
                      {activePt.delta >= 0 ? '+' : ''}{money(activePt.delta)}
                    </b>
                  </span>
                )}
              </>
            ) : (
              <>
                <span>累计做T净赚: <b className={activePt.val >= 0 ? 'up' : 'down'} style={{ fontFamily: 'monospace' }}>
                  {activePt.val >= 0 ? '+' : ''}{money(activePt.val)}
                </b></span>
                {activePt.idx > 0 && (
                  <span>
                    单笔收益: <b className={activePt.delta >= 0 ? 'up' : 'down'} style={{ fontFamily: 'monospace' }}>
                      {activePt.delta >= 0 ? '+' : ''}{money(activePt.delta)}
                    </b>
                  </span>
                )}
              </>
            )}
          </div>

          {isStockMode && (
            <div style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
              原参考成本 <b style={{ fontFamily: 'monospace' }}>¥{f2(chartData.initialRefCost)}</b> →
              摊薄至 <b style={{ color: '#7c3aed', fontFamily: 'monospace' }}>¥{f2(chartData.finalCost)}</b>
              <span style={{ marginLeft: '6px', color: chartData.costReduced >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                ({chartData.costReduced >= 0 ? '降本 ' : '抬升 '}¥{f2(Math.abs(chartData.costReduced))}/股, {chartData.reducePct >= 0 ? '-' : '+'}{Math.abs(chartData.reducePct).toFixed(2)}%)
              </span>
            </div>
          )}
        </div>

        {/* SVG 画布 */}
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', background: '#fff', borderRadius: '8px', border: '1px solid var(--line)' }}>
          {/* 水平参考网格线 */}
          {[0, 0.25, 0.5, 0.75, 1].map((t, idx) => {
            const y = PT + innerH * (1 - t);
            const valLabel = minV + (maxV - minV) * t;
            return (
              <g key={idx}>
                <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                <text x={PL - 6} y={y + 3.5} fontSize="10" fill="#64748b" textAnchor="end" fontFamily="monospace">
                  {isStockMode ? `¥${valLabel.toFixed(2)}` : `${Math.round(valLabel)}`}
                </text>
              </g>
            );
          })}

          {/* 零轴线（全部模式）或原始成本基准虚线（个股模式） */}
          {!isStockMode && minV <= 0 && maxV >= 0 && (
            <line x1={PL} y1={Y(0)} x2={W - PR} y2={Y(0)} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 3" />
          )}
          {isStockMode && (
            <line x1={PL} y1={Y(chartData.initialRefCost)} x2={W - PR} y2={Y(chartData.initialRefCost)} stroke="#a78bfa" strokeWidth="1" strokeDasharray="4 3" />
          )}

          {/* 填充区域与折线 */}
          <polygon points={areaPoints} fill={fillCol} />
          <polyline fill="none" stroke={strokeCol} strokeWidth="2.5" strokeLinejoin="round" points={polyPoints} />

          {/* 数据点与交互热点 */}
          {pts.map((p, i) => {
            const cx = X(i);
            const cy = Y(p.val);
            const isActive = hoverIdx === i || (hoverIdx == null && i === pts.length - 1);
            return (
              <g key={i} style={{ cursor: 'pointer' }} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}>
                <circle cx={cx} cy={cy} r={isActive ? 5.5 : 3.5} fill={isActive ? '#fff' : strokeCol} stroke={strokeCol} strokeWidth="2" />
                {/* 底部标签（首尾和偶数点显示防重叠） */}
                {(i === 0 || i === pts.length - 1 || pts.length <= 8 || i % Math.ceil(pts.length / 6) === 0) && (
                  <text x={cx} y={H - 8} fontSize="9.5" fill="#64748b" textAnchor="middle" fontFamily="monospace">
                    {i === 0 ? '起点' : p.date.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  return (
    <div id="secLog" style={{ marginTop: '12px' }}>
      <section>
        {/* 顶部标题与操作栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <h2 style={{ margin: 0 }}>📒 每日做T收益记账簿 & 成本摊薄曲线</h2>
            <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '2px' }}>
              精确核销印花税与规费 · 直观量化每一次做T如何把持仓成本逐步拉低
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => setShowAddModal(true)}>＋ 新增做T记录</button>
            <button onClick={onExport}>⬇ 导出备份</button>
            <button onClick={onImportClick}>⬆ 导入恢复</button>
          </div>
        </div>

        {/* 🏆 4 维核心绩效战报 KPI 卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '16px' }}>
          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: `4px solid ${stats.todayNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>☀️ 今日做T净落袋 ({stats.todayCount}笔)</div>
            <div className={stats.todayNet >= 0 ? 'up' : 'down'} style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px' }}>
              {stats.todayNet >= 0 ? '+' : ''}{money(stats.todayNet)}
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: `4px solid ${stats.totalNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>💰 历史累计做T净利 ({stats.totalCount}笔)</div>
            <div className={stats.totalNet >= 0 ? 'up' : 'down'} style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px' }}>
              {stats.totalNet >= 0 ? '+' : ''}{money(stats.totalNet)}
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: '4px solid #0958d9' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🎯 做T综合胜率</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: '#0958d9' }}>
              {stats.winRate.toFixed(1)}%
              <span style={{ fontSize: '11.5px', fontWeight: 500, color: 'var(--sub)', marginLeft: '6px' }}>
                ({stats.winCount}胜 / {stats.lossCount}负)
              </span>
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: '4px solid #7c3aed' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🛡️ 计划内纪律执行率</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: '#7c3aed' }}>
              {stats.disciplineRate.toFixed(0)}%
              {stats.bestTrade && (
                <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--sub)', marginLeft: '6px' }}>
                  最佳 +{money(stats.bestTrade.net)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 📈 成本摊薄曲线与累计收益可视化看板 */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text)' }}>
              {selectedChartStock === 'ALL'
                ? '📈 账户做T累计净套利资金曲线'
                : `📉 【${selectedChartStock}】做T成本摊薄走势（底仓每股成本动态下降轨迹）`}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: 'var(--mute)' }}>切换维度：</span>
              <select
                value={selectedChartStock}
                onChange={e => { setSelectedChartStock(e.target.value); setHoverIdx(null); }}
                style={{ padding: '4px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text)', fontWeight: 600 }}
              >
                <option value="ALL">📊 全部标的 · 累计收益资金曲线</option>
                {stats.stockOptions.map(st => (
                  <option key={st} value={st}>🎯 {st} · 成本摊薄曲线</option>
                ))}
              </select>
            </div>
          </div>

          {renderCurveSvg()}

          {/* 按日战报速览条 */}
          {stats.dailyList.length > 0 && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--line)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--mute)', fontWeight: 600 }}>📅 近期单日做T战报：</span>
              {stats.dailyList.map(d => (
                <span
                  key={d.date}
                  style={{
                    fontSize: '11.5px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: d.net >= 0 ? '#fff1f0' : '#f6ffed',
                    border: '1px solid',
                    borderColor: d.net >= 0 ? '#ffa39e' : '#b7eb8f',
                    color: d.net >= 0 ? '#cf1322' : '#389e0d',
                    fontFamily: 'monospace'
                  }}
                >
                  {d.date.slice(5)}: <b>{d.net >= 0 ? '+' : ''}{money(d.net)}</b> ({d.count}笔)
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 流水明细表格 */}
        <div className="tbl-scroll" style={{ maxHeight: '300px' }}>
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
