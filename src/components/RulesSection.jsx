import React from 'react';

export default function RulesSection() {
  return (
    <section id="secRule">
      <h2>四、执行纪律</h2>
      <div className="rules-grid">
        <div>
          <h4 style={{ fontSize: '13.5px', marginBottom: '8px' }}>八条保命铁律</h4>
          <ul className="rlist">
            <li data-n="1"><b>趋势优先</b>：日线空头 / 大盘单边跌，分时再诱人也<em>不T</em>。</li>
            <li data-n="2"><b>仓位隔离</b>：底仓守趋势、T仓做套利，7:3，互不挪用。</li>
            <li data-n="3"><b>当日闭环</b>：14:57 前T仓必须平掉，<em>绝不隔夜</em>。</li>
            <li data-n="4"><b>无信号不交易</b>：没有明确高低点就空仓等。</li>
            <li data-n="5"><b>止盈有度</b>：常规 3%~6% 落袋，强势最多 8%。</li>
            <li data-n="6"><b>果断止损</b>：T仓浮亏 <em>1.5% 无条件砍</em>，不补仓。</li>
            <li data-n="7"><b>只做活跃标的</b>：日均振幅 &lt; 4% 的票直接放弃。</li>
            <li data-n="8"><b>控制频率</b>：每天最多 1~2 次，不反复进出。</li>
          </ul>
        </div>
        <div>
          <h4 style={{ fontSize: '13.5px', marginBottom: '8px' }}>三大量价口诀</h4>
          <ul className="rlist">
            <li data-n="A"><b>缩量急跌是机会，放量急跌是陷阱。</b>早盘急跌要看前5分钟量能：缩量=洗盘可接，放量=真出逃不接。</li>
            <li data-n="B"><b>无量拉升全是耍流氓</b>：价格线拉升超 4%，量柱却小于前5分钟均量 —— 标准量价背离，卖。</li>
            <li data-n="C"><b>三格以内静观望，三至六格可做T，六格之上需谨慎。</b>日内振幅不足 4% 直接不做。</li>
          </ul>
          <h4 style={{ fontSize: '13.5px', margin: '14px 0 8px' }}>做反了怎么办</h4>
          <ul className="rlist">
            <li data-n="1"><b>买跌了</b>：只认错，不补仓，不反手做空。砍掉，<em>今天不再碰这只票</em>。</li>
            <li data-n="2"><b>卖飞了</b>：<em>绝不追高接回</em>。想参与就去看同板块还没启动的跟风票。</li>
          </ul>
        </div>
      </div>

      <h2 style={{ marginTop: '22px' }}>五、时间窗口</h2>
      <div className="tw">
        <div className="b">
          <h4>09:30–10:00　情绪博弈期</h4>
          <p>只擒确定性：低开缩量急跌可试探正T，高开放量破位优先倒T避险。<b>不追高、不冲动。</b></p>
        </div>
        <div className="b">
          <h4>10:00–14:00　趋势稳定期</h4>
          <p>分时高低点最清晰，全天最适合做T的时段。回踩均价线低吸、拉升背离高抛。</p>
        </div>
        <div className="b">
          <h4>14:30–15:00　方向确认期</h4>
          <p><b>只了结、不开新仓。</b>尾盘无量拉升坚决高抛，规避次日低开。</p>
        </div>
      </div>
    </section>
  );
}
