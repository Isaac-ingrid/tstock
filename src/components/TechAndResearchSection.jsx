import React, { useEffect, useRef, useState } from 'react';
import { f2, f3, pct, VAL_WIN } from '../services/utils.js';
import { calc, computeTA, rsCalc, drawRS, loadResearch } from '../services/api.js';

export function pctTag(p) {
  if (p == null) return <span className="sig s-nt">—</span>;
  const cls = p <= 25 ? 's-ok' : p >= 75 ? 's-no' : 's-nt';
  return <span className={`sig ${cls}`}>{p.toFixed(0)}%</span>;
}

/* 将内置说明文本中的 <b>...</b> 安全解析为加粗节点，避免标签源码直接暴露在界面 */
function renderInlineBold(text) {
  if (!text || typeof text !== 'string') return text;
  return text.split(/(<b>.*?<\/b>)/g).map((part, idx) => {
    if (part.startsWith('<b>') && part.endsWith('</b>')) {
      return (
        <strong key={idx} style={{ color: 'var(--text)', fontWeight: 700 }}>
          {part.slice(3, -4)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export function winTxt(all) {
  return VAL_WIN.map(([k, label]) => {
    const s = (all || {})[k] || {};
    return (
      <span key={k}>
        {label} <b style={{ fontFamily: 'ui-monospace,Consolas,monospace' }}>{s.pct == null ? '—' : s.pct.toFixed(0) + '%'}</b>
      </span>
    );
  }).reduce((prev, curr) => [prev, ' · ', curr]);
}

export function VBarComponent({ st, cur }) {
  if (!st || cur == null || st.min == null || st.max == null || st.max <= st.min) return null;
  const pos = v => Math.max(0, Math.min(100, (v - st.min) / (st.max - st.min) * 100));
  const pm = pos(st.med);
  const hot = st.pct != null && st.pct >= 50;

  return (
    <div>
      <div className="vbar">
        <div className="band" style={{ left: `${pm}%`, width: `${Math.max(0, 100 - pm)}%` }}></div>
        <div className="med" style={{ left: `${pm}%` }}></div>
        <div className={`now ${hot ? '' : 'lo'}`} style={{ left: `${pos(cur)}%` }}></div>
      </div>
      <div className="vaxis">
        <span>{f2(st.min)}</span>
        <span>中位 {f2(st.med)}</span>
        <span>{f2(st.max)}</span>
      </div>
    </div>
  );
}

export default function TechAndResearchSection({ stock, poolIndex, pool = [] }) {
  const rsCanvasRef = useRef(null);
  const [, setResearchTick] = useState(0);

  // 1. 自动懒加载估值与板块研究数据
  useEffect(() => {
    if (!stock._val && !stock._bd && !stock._valErr && !stock._researchLoading) {
      stock._researchLoading = true;
      loadResearch(stock, false).then(() => {
        stock._researchLoading = false;
        setResearchTick(t => t + 1);
      }).catch(() => {
        stock._researchLoading = false;
      });
    }
  }, [stock]);

  // 2. 绘制相对强弱 RS 迷你走势折线图
  useEffect(() => {
    if (rsCanvasRef.current) {
      const rs = rsCalc(stock);
      if (rs) {
        drawRS(rsCanvasRef.current, rs);
      }
    }
  }, [stock, stock._ks]);

  const ta = stock._ta || computeTA(stock);
  const rs = rsCalc(stock);
  const v = stock._val;
  const bd = stock._bd;

  /* 技术面各分项指示卡 */
  // 综合评分
  let scoreLvl = ['中性', 't-nt', 's-nt', '多空拉锯，只小仓试，等方向明朗。'];
  if (ta) {
    const sc = ta.score;
    if (sc >= 75) scoreLvl = ['强势', 't-ok', 's-ok', '结构健康，做T以正T为主，回踩均线即买点。'];
    else if (sc >= 55) scoreLvl = ['偏强', 't-ok', 's-ok', '多头占优，可正常执行正T，跌破 MA20 再收手。'];
    else if (sc >= 45) scoreLvl = ['中性', 't-nt', 's-nt', '多空拉锯，只小仓试，等方向明朗。'];
    else if (sc >= 25) scoreLvl = ['偏弱', 't-wn', 's-wn', '结构走坏，只允许倒T减仓，不做低吸。'];
    else scoreLvl = ['弱势', 't-no', 's-no', '多项指标共振向下，今日宜空仓观望。'];
  }

  // 20日箱体
  const b = ta ? ta.box20 : null;
  let boxInfo = { sig: '无数据', sc: 's-nt', desc: '等待K线加载完成' };
  if (b) {
    if (b.up) boxInfo = { sig: '上破箱顶', sc: 's-no', desc: `已站上 20 日箱顶 ${f2(b.top)}，箱体上移。回踩不破前箱顶即为新支撑。极强势阶段。极端放量时注意短线冲高回落。` };
    else if (b.down) boxInfo = { sig: '跌破箱底', sc: 's-wn', desc: `已跌破 20 日箱底 ${f2(b.bot)}，箱体下移。此时停止做T，等重新站回箱内再谈。` };
    else if (b.pos >= 78) boxInfo = { sig: '贴近箱顶', sc: 's-wn', desc: `位于箱内 ${b.pos.toFixed(0)}%，贴近箱顶 ${f2(b.top)} 阻力。正T不宜在此追买，反而是倒T减仓的位置。` };
    else if (b.pos <= 22) boxInfo = { sig: '贴近箱底', sc: 's-ok', desc: `位于箱内 ${b.pos.toFixed(0)}%，靠近箱底 ${f2(b.bot)} 支撑。缩量止跌可分批低吸，跌破则认输。` };
    else boxInfo = { sig: '箱体中枢', sc: 's-nt', desc: `位于箱内 ${b.pos.toFixed(0)}%，既不便宜也不贵。箱体高度 ${b.height.toFixed(1)}%，波段空间充裕。` };
  }

  // MACD
  const m = ta ? ta.macd : null;
  let macdInfo = { sig: '平稳', sc: 's-nt', desc: '指标正常' };
  if (m) {
    if (m.cross === 'gold' && m.aboveZero) macdInfo = { sig: '零上金叉', sc: 's-ok', desc: '零轴上方金叉，最强买点。正T胜率最高阶段。' };
    else if (m.cross === 'gold') macdInfo = { sig: '零下金叉', sc: 's-ok', desc: '零轴下方金叉，超跌反弹性质。先当弱反弹做，控制仓位。' };
    else if (m.cross === 'dead' && !m.aboveZero) macdInfo = { sig: '零下死叉', sc: 's-no', desc: '零轴下方死叉，主跌段信号。严禁新开正T，手里有仓倒T减。' };
    else if (m.cross === 'dead') macdInfo = { sig: '零上死叉', sc: 's-wn', desc: '强势区死叉，大概率顶背离或强势回踩。正T止盈、转倒T减仓。' };
    else if (m.bar > 0 && m.barUp) macdInfo = { sig: '红柱放大', sc: 's-ok', desc: '多头动能增强，顺势持股做T。' };
    else if (m.bar > 0) macdInfo = { sig: '红柱缩短', sc: 's-wn', desc: '冲高动能衰竭，警惕见顶。贴近止盈位时先兑现。' };
    else if (m.bar < 0 && m.barUp) macdInfo = { sig: '绿柱缩短', sc: 's-ok', desc: '空头动能减弱，可能酝酿底背离。低吸关注点。' };
    else macdInfo = { sig: '绿柱放大', sc: 's-no', desc: '杀跌动能强化中，别伸手接飞刀。' };
  }

  // 量比
  const vr = +stock.vr || 0;
  let vrInfo = { sig: '常态', sc: 's-nt', desc: '量能正常' };
  if (vr >= 2.5) vrInfo = { sig: '放量明显', sc: 's-wn', desc: `量比 ${f2(vr)}，多空剧烈换手。冲高无力时大概率假突破，按倒T对待。` };
  else if (vr >= 1.5) vrInfo = { sig: '温和放量', sc: 's-ok', desc: `量比 ${f2(vr)}，资金开始关注。放量突破关键位是最佳正T加分项。` };
  else if (vr >= 0.8) vrInfo = { sig: '量能正常', sc: 's-nt', desc: `量比 ${f2(vr)}，常态波动。按既定格位执行即可。` };
  else vrInfo = { sig: '明显缩量', sc: 's-ok', desc: `量比 ${f2(vr)}，抛压衰竭。回踩重要均线+缩量 = 经典低吸环境。` };

  // 分时量能
  const vm = stock._vm;

  // 板块集中度
  let bdHits = [];
  let bdOthers = {};
  if (bd && bd.list) {
    const meaningful = x => x.type === '行业' || (x.precise && !x.type);
    const mine = {};
    bd.list.filter(meaningful).forEach(x => { mine[x.name] = 1; });
    (pool || []).forEach((o, j) => {
      if (j === poolIndex || !o._bd) return;
      (o._bd.list || []).filter(meaningful).forEach(x => {
        if (mine[x.name]) {
          (bdOthers[x.name] = bdOthers[x.name] || []).push(o.name);
        }
      });
    });
    bdHits = Object.keys(bdOthers).filter(n => bdOthers[n].length);
  }

  const beat = rs && rs.r20 != null ? rs.r20 >= 0 : null;

  return (
    <div style={{ padding: '0 4px 6px' }}>
      {/* 1. 五维技术面量化监控卡 */}
      <div className="ta-grid">
        {/* 综合评分 */}
        <div className={`ta ${scoreLvl[1]}`}>
          <div className="h">
            <span>技术面综合评分</span>
            <span className={`sig ${scoreLvl[2]}`}>{scoreLvl[0]}</span>
          </div>
          <div className="big">{ta ? ta.score + ' 分' : '— 分'}</div>
          <div className="d">
            {scoreLvl[3]}
            <br />
            <span style={{ color: 'var(--mute)' }}>由均线排列、MACD、箱体位置、MA20 方向、量能加权得出</span>
          </div>
        </div>

        {/* 20日箱体 */}
        <div className={`ta ${boxInfo.sc === 's-ok' ? 't-ok' : boxInfo.sc === 's-no' ? 't-no' : 't-wn'}`}>
          <div className="h">
            <span>20日箱体结构</span>
            <span className={`sig ${boxInfo.sc}`}>{boxInfo.sig}</span>
          </div>
          <div className="big">{b ? `${f2(b.bot)} ~ ${f2(b.top)}` : '—'}</div>
          <div className="d">{boxInfo.desc}</div>
          {b && (
            <div className="box-meter" style={{ marginTop: '6px' }}>
              <i style={{ left: `${Math.max(0, Math.min(100, b.pos))}%` }}></i>
            </div>
          )}
        </div>

        {/* MACD */}
        <div className={`ta ${macdInfo.sc === 's-ok' ? 't-ok' : macdInfo.sc === 's-no' ? 't-no' : 't-wn'}`}>
          <div className="h">
            <span>MACD 动能态势</span>
            <span className={`sig ${macdInfo.sc}`}>{macdInfo.sig}</span>
          </div>
          <div className="big">{m ? `DIF ${f3(m.dif)} · DEA ${f3(m.dea)}` : '—'}</div>
          <div className="d">{macdInfo.desc}</div>
        </div>

        {/* 量比状态 */}
        <div className={`ta ${vrInfo.sc === 's-ok' ? 't-ok' : 't-nt'}`}>
          <div className="h">
            <span>量比与多空换手</span>
            <span className={`sig ${vrInfo.sc}`}>{vrInfo.sig}</span>
          </div>
          <div className="big">{f2(vr)} 倍</div>
          <div className="d">{vrInfo.desc}</div>
        </div>

        {/* 分时量能 */}
        <div className={`ta ${(vm && vm.ok && vm.cls) || 't-nt'}`}>
          <div className="h">
            <span title="相对近 5 日同一时段均量基准">分时量能 · 同时段</span>
            <span className={`sig ${(vm && vm.ok && vm.sc) || 's-nt'}`}>
              {(vm && vm.ok && vm.label) || (vm && vm.err ? '未取到' : '未取数')}
            </span>
          </div>
          <div className="big">
            {vm && vm.ok && vm.r3 != null ? vm.r3.toFixed(2) + '×' : '—'}
          </div>
          <div className="d">
            {vm && vm.ok ? renderInlineBold(vm.text) : '点卡片右上「⟳ 取数」拉取 m5 并对比近 5 日同时段基准'}
          </div>
        </div>
      </div>

      {/* 2. 基本面研究：估值分位 · 板块归属 · 相对强弱 RS */}
      <div className="ta t-nt" style={{ padding: '12px 14px', borderRadius: '9px', border: '1px solid var(--line)' }}>
        <div className="h" style={{ marginBottom: '8px' }}>
          <span style={{ fontWeight: 700, fontSize: '13px' }}>📊 估值分位 · 板块归属 · 相对强弱</span>
          <span className="sig s-nt">{v ? `${v.bars} 个交易日序列` : '研究数据'}</span>
        </div>

        {/* 估值分位 */}
        {stock._valErr ? (
          <div style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '6px' }}>估值取数失败：{stock._valErr}</div>
        ) : !v ? (
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '6px' }}>正在加载上市以来的逐日 PE / PB 估值序列…</div>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0,1fr) 180px', gap: '10px', alignItems: 'center', fontSize: '12px', marginTop: '8px' }}>
              <div><b>PE-TTM</b><br /><span style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '14px', fontWeight: 700 }}>{f2(v.cur.pe)}</span></div>
              <VBarComponent st={v.pe['3y']} cur={v.cur.pe} />
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', lineHeight: 1.7 }}>{winTxt(v.pe)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0,1fr) 180px', gap: '10px', alignItems: 'center', fontSize: '12px', marginTop: '8px' }}>
              <div><b>PB-MRQ</b><br /><span style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '14px', fontWeight: 700 }}>{f2(v.cur.pb)}</span></div>
              <VBarComponent st={v.pb['3y']} cur={v.cur.pb} />
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', lineHeight: 1.7 }}>{winTxt(v.pb)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0,1fr) 180px', gap: '10px', alignItems: 'center', fontSize: '12px', marginTop: '8px' }}>
              <div><b>PS-TTM</b><br /><span style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '14px', fontWeight: 700 }}>{f2(v.cur.ps)}</span></div>
              <VBarComponent st={v.ps['3y']} cur={v.cur.ps} />
              <div style={{ fontSize: '11.5px', color: 'var(--sub)', lineHeight: 1.7 }}>{winTxt(v.ps)}</div>
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)', marginTop: '8px' }}>
              分位口径：统计 <b>{v.bars}</b> 个交易日（{v.start} ~ {v.end}）的历史估值分布。
              {v.pe['3y'].pct != null && v.pe['3y'].pct <= 25 && <b style={{ color: 'var(--down)', marginLeft: '6px' }}>当前估值处于近3年偏低区，对做T底仓构成安全边际支撑。</b>}
              {v.pe['3y'].pct != null && v.pe['3y'].pct >= 75 && <b style={{ color: 'var(--up)', marginLeft: '6px' }}>当前估值处于近3年偏高区，追多做T需严格控仓止损。</b>}
            </div>
          </div>
        )}

        {/* 板块题材 */}
        <div style={{ fontSize: '12px', marginTop: '13px', paddingTop: '10px', borderTop: '1px dashed var(--line)' }}>
          <b>板块题材归属</b> <span style={{ color: 'var(--mute)', fontSize: '11.5px' }}>东财行业分类与核心题材（红色标签为该股精确归属）</span>
        </div>
        {stock._bdErr ? (
          <div style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '6px' }}>板块归属取数失败：{stock._bdErr}</div>
        ) : !bd ? (
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '6px' }}>板块题材数据加载中…</div>
        ) : (
          <div>
            <div className="bdgs">
              {bd.list.slice(0, 14).map((x, idx) => {
                const cls = x.type === '行业' ? 'ind' : (x.type === '板块' ? 'sec' : (x.precise ? 'hot' : 'con'));
                return <span key={idx} className={`bdg ${cls}`}>{x.name}</span>;
              })}
            </div>
            {bdHits.length > 0 && (
              <div className="conc">
                ⚠️ 池内板块集中度：{bdHits.slice(0, 3).map(n => <span key={n}><b>{n}</b>（与 {bdOthers[n].join('、')} 同板块）；</span>)}
                同一产业链标的一旦遭遇行业杀跌可能共振回撤，请注意控制总暴露。
              </div>
            )}
          </div>
        )}

        {/* 相对强弱 RS */}
        <div style={{ fontSize: '12px', marginTop: '13px', paddingTop: '10px', borderTop: '1px dashed var(--line)' }}>
          <b>相对强弱 RS</b> <span style={{ color: 'var(--mute)', fontSize: '11.5px' }}>个股 ÷ {rs ? rs.ref : '参照指数'}，紫线=RS，橙线=RS 的 MA5，灰虚线=区间中位</span>
        </div>
        {!rs ? (
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '6px' }}>相对强弱需要个股与大盘指数日K就绪后计算（点击右上「⟳ 取数」即可）</div>
        ) : (
          <div>
            <div className="rs-wrap">
              <canvas ref={rsCanvasRef} style={{ width: '100%', height: '64px', display: 'block', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }} />
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '6px' }}>
              20日相对强弱 <b style={{ fontFamily: 'ui-monospace,Consolas,monospace', color: beat === null ? 'var(--sub)' : beat ? 'var(--up)' : 'var(--down)' }}>{rs.r20 == null ? '—' : pct(rs.r20)}</b>
              {' '}· 60日 <b style={{ fontFamily: 'ui-monospace,Consolas,monospace', color: rs.r60 == null ? 'var(--sub)' : rs.r60 >= 0 ? 'var(--up)' : 'var(--down)' }}>{rs.r60 == null ? '—' : pct(rs.r60)}</b>
              {' '}· 当前 RS 分位 {pctTag(rs.pct)}
              {beat !== null && <span> —— 近20个交易日<b>{beat ? '跑赢' : '跑输'}</b>参照指数</span>}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)', marginTop: '6px', lineHeight: 1.5 }}>
              💡 RS 持续上行代表个股跑赢大盘、资金在积极抱团承接，低吸做正T更安全；若 RS 持续向下破位，则应严格防范补跌风险。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
