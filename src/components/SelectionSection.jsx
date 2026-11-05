import React, { useState } from 'react';

export default function SelectionSection({
  wbLatest,
  pool,
  onAddStock,
  onBatchAdd,
  onOpenReason,
  onRefresh,
  onSelfTest,
  onJumpPerf,
  dbStatus
}) {
  const [onlyRed, setOnlyRed] = useState(true);
  const [manualInput, setManualInput] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const D = wbLatest || (typeof window !== 'undefined' ? window.WB_LATEST : null);
  const inPoolCodes = new Set((pool || []).map(s => String(s.code).padStart(6, '0')));

  if (!D) {
    return (
      <section id="secSelection">
        <details className="fold" open id="secSelectionFold">
          <summary style={{ fontSize: '15px', fontWeight: 700, cursor: 'pointer', padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>二、选股池与自选股</span>
          </summary>
          <div className="fold-bd" style={{ paddingTop: '12px' }}>
            <div className="sel-empty">正在读取选股契约数据 data/latest.js...</div>
          </div>
        </details>
      </section>
    );
  }

  const env = D.env || {};
  const lvl = { OK: 'ok', WARN: 'warn', BAD: 'bad' }[env.level] || 'warn';
  const lvlText = { OK: '环境放行', WARN: '环境减半', BAD: '环境否决', UNKNOWN: '环境未知' }[env.level] || '环境放行';
  const short = D.candidates || [];
  const steady = D.steady || [];
  const redShort = short.filter(r => r.verdict === '可做');
  const displayShort = (onlyRed && redShort.length > 0) ? redShort : short;

  const dateStr = D.tradeDate || (D.generatedAt ? D.generatedAt.slice(0, 10) : '今日');
  const genTimeStr = D.generatedAt ? new Date(D.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const inCnt = short.concat(steady).filter(r => inPoolCodes.has(String(r.code).padStart(6, '0'))).length;

  const handleManualAdd = () => {
    const q = manualInput.trim();
    if (!q) return;
    onAddStock(q);
    setManualInput('');
  };

  const renderChip = (r, poolType) => {
    const code6 = String(r.code).padStart(6, '0');
    const have = inPoolCodes.has(code6);
    const vCls = r.verdict === '可做' ? 'c-can' : r.verdict === '小做' ? 'c-small' : 'c-watch';

    return (
      <div
        key={code6}
        className={`sel-chip ${vCls} ${have ? 'in-pool' : ''}`}
        onClick={() => onOpenReason(r, have)}
        title="点击查看入选理由与量化支撑"
      >
        <span className="sc-name">{r.name}</span>
        <span className="sc-code">{code6}</span>
        <span className="sc-score">{r.score || 80}分</span>
        <span className="sc-vd">{r.verdict || '观察'}</span>
        {have && <span className="sc-in">已在池</span>}
      </div>
    );
  };

  return (
    <section id="secSelection">
      <details className="fold" open id="secSelectionFold">
        <summary style={{ fontSize: '15px', fontWeight: 700, cursor: 'pointer', padding: '8px 12px', background: 'var(--surface)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>二、选股池与自选股</span>
          <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>（点击可折叠/展开，便于全屏专注单只做T）</span>
        </summary>
        <div className="fold-bd" style={{ paddingTop: '12px' }}>
          <div className="sel-box" id="selBox">
            <div className="sel-top">
              <span className={`sel-env ${lvl}`}>{lvlText}</span>
              <span>短线候选 <b>{displayShort.length}</b> 只{onlyRed && redShort.length ? `（已锁定精选 ${displayShort.length} 只红标可做）` : `（可做 ${redShort.length} / 小做 ${short.filter(x => x.verdict === '小做').length} / 观察 ${short.filter(x => x.verdict === '观察').length}）`}</span>
              <span>·</span>
              <span>稳健底仓 <b>{steady.length}</b> 只</span>
              <span>·</span>
              <span>环境允许执行 <b>{D.counts?.executable || short.length}</b> 只</span>
              <span className="sel-stamp">数据日 {dateStr}{genTimeStr ? ' ' + genTimeStr : ''}</span>
              {inCnt > 0 && <span className="sel-in">已在自选池 {inCnt} 只</span>}
            </div>

            <div className="sel-grp">
              <div className="sel-gt" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <b>短线做T候选</b>
                <span>{displayShort.length === redShort.length && redShort.length ? `已精选 ${displayShort.length} 只红标强势做T候选` : (env.text ? env.text : '评分 ≥70 · 严格过滤ST与陷阱')}</span>
                <span className="sel-filter-bar" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <button
                    type="button"
                    className={`sel-ft-btn ${onlyRed && redShort.length ? 'active' : ''}`}
                    onClick={() => setOnlyRed(true)}
                    title="仅显示红标（可做）候选"
                  >
                    🔴 仅红标 ({redShort.length})
                  </button>
                  <button
                    type="button"
                    className={`sel-ft-btn ${!onlyRed || !redShort.length ? 'active' : ''}`}
                    onClick={() => setOnlyRed(false)}
                    title="查看包含小做/观察在内的全部候选"
                  >
                    全部 ({short.length})
                  </button>
                </span>
              </div>
              <div className="sel-chips">
                {displayShort.length ? displayShort.map(r => renderChip(r, 'short')) : <span className="sel-empty">今日无短线候选</span>}
              </div>
            </div>

            <div className="sel-grp">
              <div className="sel-gt">
                <b>稳健底仓候选</b>
                <span>高股息 / 低估值蓝筹，仅适合回踩倒T增厚，不追正T追高</span>
              </div>
              <div className="sel-chips">
                {steady.length ? steady.map(r => renderChip(r, 'steady')) : <span className="sel-empty">本周稳健底仓暂无变动</span>}
              </div>
            </div>

            <div className="sel-acts">
              <button
                className="btn-sel-act"
                onClick={() => onBatchAdd(displayShort, '短线')}
              >
                ＋ 全部加入短线（{displayShort.length}）
              </button>
              <button
                className="btn-sel-act"
                onClick={() => onBatchAdd(steady, '稳健')}
              >
                ＋ 全部加入稳健（{steady.length}）
              </button>
              <button
                className="btn-sel-act"
                onClick={() => onRefresh(false)}
              >
                ⟳ 重新同步状态
              </button>
              <a
                href="javascript:void(0)"
                onClick={onJumpPerf}
                style={{
                  fontSize: '12px', fontWeight: 600, color: 'var(--accent)', textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '5px 12px',
                  borderRadius: '6px', background: 'var(--accent-bg)', border: '1px solid var(--accent-b)',
                  marginLeft: 'auto'
                }}
              >
                📊 查看 60日实证大样本与历史战绩 ({(D.recommendations || []).length}只) →
              </a>
            </div>

            <div className="sel-tip">
              💡 <b>点击任意候选卡片</b> 可查看详尽入选理由、量价逻辑与重大利空排查并一键并入自选。<br />
              加入自选后系统将统一启动毫秒级分时监控、七格箱体计算与日内高抛低吸提醒。
            </div>
          </div>

          <div className="sel-sep">手动添加 / 刷新行情</div>

          <div className="db-row">
            <input
              id="dbInput"
              placeholder="输入 A股 代码或名称 —— 605128 / 上海沿浦 / shyp（拼音首字母也行）"
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleManualAdd(); }}
              autoComplete="off"
            />
            <button className="primary" onClick={handleManualAdd}>＋ 添加</button>
            <button onClick={() => onRefresh(false)}>⟳ 刷新全部行情</button>
            <button onClick={onSelfTest}>🩺 网络自检</button>
            <label className="db-sw">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
              /> 交易时段每分钟自动刷新
            </label>
          </div>

          <div className="db-status">{dbStatus || '行情已更新 · 来源：腾讯实时行情 + 腾讯前复权K线 + 逐笔大单'}</div>

          <details className="fold" style={{ marginTop: '12px' }}>
            <summary>📊 图表能力 —— 每只股票卡片内置的图表能力（点击展开）</summary>
            <div className="fold-bd">
              <div className="k-note" style={{ lineHeight: 1.8 }}>
                <b>每只股票卡片内置的图表能力</b>（全部实时取数、Canvas 手绘，鼠标悬停即可读出该根的 OHLC 与全部指标值）：<br />
                · <b>周期</b>：分时 / 1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K —— 点工具条上的周期按钮即切，<b>指标会跟着换成该周期口径</b>（周K上的 MA5 就是 5 周线）。<br />
                · <b>主图叠加</b>：MA5 / MA10 / MA20 / MA60（五日线、二十日线都在内）、BOLL(20,2) 布林通道、20日箱体上下沿、持仓成本线、支撑压力位。<br />
                · <b>副图</b>：成交量柱 + VMA5 量均线（常显）；MACD(12,26,9) 与 RSI(6/12/24) 可切换。分时模式下副图自动换成「每分钟放量倍数」。<br />
                · <b>实时数据条</b>：换手率、量比、BOLL 三轨、RSI6、布林带宽、支撑位 / 压力位、主力净额与大单净量。<br />
                · <b>支撑位 / 压力位</b>：由八类来源自动归并 —— 20/60日箱体上下沿、布林上中下轨、MA5/10/20/60、20/60日极值、持仓成本；相邻 0.6% 合并成一档，并按来源权重标注「强 / 中 / 弱」。<br />
                · <b>大单资金</b>：点「💰 大单资金」拉取当日<b>全部逐笔成交</b>，在本地按单笔金额分档（特大单 ≥100万 / 大单 20–100万 / 中单 4–20万 / 小单 &lt;4万）统计「主动买 − 主动卖」的净额与净量，口径透明、可逐笔核对。
              </div>
            </div>
          </details>
        </div>
      </details>
    </section>
  );
}
