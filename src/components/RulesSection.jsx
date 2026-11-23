import React from 'react';
import { HOLIDAY_SOP_TIERS } from '../views/RulesPage.jsx';

export default function RulesSection({
  mktStatus = null,
  holidayReminder = null,
  holidayTiers = HOLIDAY_SOP_TIERS,
  onTabChange = null,
}) {
  const isUrgent = Boolean(holidayReminder?.isHighAlert);
  const isInHoliday = holidayReminder?.phase === 'in_holiday';

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

      {/* 新增第六章：节前长假分档控仓与跨假 T+1 风控闭环 SOP */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '8px',
          marginTop: '24px',
          marginBottom: '12px',
        }}
      >
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px' }}>
          <span
            style={{
              display: 'inline-block',
              width: '3px',
              height: '15px',
              background: 'var(--up)',
              borderRadius: '2px',
            }}
          />
          <span>六、节前长假分档控仓与跨假 T+1 风控铁律</span>
        </h2>

        {/* 实时交易日历感知状态胶囊 */}
        <span
          style={{
            fontSize: '11.5px',
            padding: '3px 10px',
            borderRadius: '999px',
            fontWeight: 700,
            background: isUrgent
              ? '#fffbeb'
              : isInHoliday
              ? '#fef2f2'
              : holidayReminder
              ? '#eff6ff'
              : 'var(--surface2)',
            color: isUrgent
              ? '#b45309'
              : isInHoliday
              ? '#b91c1c'
              : holidayReminder
              ? '#1d4ed8'
              : 'var(--sub)',
            border: `1px solid ${
              isUrgent
                ? '#fcd34d'
                : isInHoliday
                ? '#fecaca'
                : holidayReminder
                ? '#bfdbfe'
                : 'var(--line)'
            }`,
          }}
        >
          {holidayReminder
            ? holidayReminder.chipText
            : mktStatus
            ? `📅 当前日历：${mktStatus.dateStr}（${mktStatus.label} · 无临近长假，按常规情绪上限执行）`
            : '📅 沪深北法定节假日与周末恒休市自动同步'}
        </span>
      </div>

      <div
        style={{
          fontSize: '12.5px',
          color: 'var(--sub)',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: '9px',
          padding: '9px 12px',
          marginBottom: '12px',
          lineHeight: 1.6,
        }}
      >
        <b>🧭 交易所开休市基准：</b>
        全站（前端看板、定时任务与复盘诊断后端）统一按北京时间（<code>Asia/Shanghai, UTC+8</code>）读取沪深北法定休市日历；
        <b>周六、周日恒定休市（即使遇国务院周末调休补班日 A 股亦不开市）</b>。实际允许总仓位遵循{' '}
        <b><code>effectiveCap = min(大盘情绪闸门上限, 节前分档上限)</code></b> 从严取小原则。
      </div>

      {/* 节前分档控仓速查表 */}
      <div className="tbl-scroll" style={{ maxHeight: 'none', marginBottom: '14px' }}>
        <table>
          <thead>
            <tr>
              <th>连休天数档位（含紧邻周末）</th>
              <th>典型法定节假日</th>
              <th>风控激活窗口</th>
              <th>节前建议总仓上限</th>
              <th>叠加情绪闸门硬上限（从严取小）</th>
              <th>核心仓位动作</th>
            </tr>
          </thead>
          <tbody>
            {(holidayTiers || []).map((row) => (
              <tr key={row.id}>
                <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{row.tierLabel}</td>
                <td>{row.examples}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{row.windowText}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span
                    className={`pill ${
                      row.id === 'super_long' ? 'p-stop' : row.id === 'mini_long' ? 'p-sell' : 'p-none'
                    }`}
                    style={{ fontWeight: 700 }}
                  >
                    {row.holidayCapText}
                  </span>
                </td>
                <td style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                  {row.combinedCapText}
                </td>
                <td style={{ color: 'var(--sub)' }}>{row.actionText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 双栏：跨假 T+1 时间节点铁律 + 全站事前事后风控闭环 */}
      <div className="rules-grid">
        <div>
          <h4 style={{ fontSize: '13.5px', marginBottom: '8px' }}>跨假 T+1 关键节点四条铁律</h4>
          <ul className="rlist">
            <li data-n="前2">
              <b>节前取现日（倒数第 2 个交易日）</b>：场内资金过节取现的最后卖出窗口，午后易现集中避险兑现抛压；务必趁<b>早盘 09:30–10:30 冲高</b>去弱留强，提前将仓位压回安全水位线。
            </li>
            <li data-n="前1">
              <b>节前收官日（最后 1 个交易日）禁重仓偷袭</b>：受 A 股 <em>T+1 交收铁律</em>限制，收官日任何新开底仓、加仓及<b>14:30 尾盘黑马潜伏</b>均无法次日平仓，将强制跨越整个长假锁定至节后开市日！严禁尾盘超上限赌假期利好。
            </li>
            <li data-n="T0">
              <b>存量底仓日内闭环做T豁免</b>：对老底仓执行<b>当日低吸、14:55 前高抛平清</b>（或先卖后买倒T）的日内闭环操作不增加隔夜股数，可在不放大跨假敞口的前提下持续降本，<em>不计入节前超限违规</em>。
            </li>
            <li data-n="节后">
              <b>节后首日（09:15–09:45）竞价纠偏</b>：若跨假仓位超限，节后首日 09:15–09:25 集合竞价重点核查量比与封单；高开无量脉冲于 09:45 前分批高抛收回超额敞口，低开跌破 <code>slA</code> 止损线反抽均价线无力果断减出，<em>严禁节后首日盲目补仓摊平</em>。
            </li>
          </ul>
        </div>

        <div>
          <h4 style={{ fontSize: '13.5px', marginBottom: '8px' }}>事前提醒 → 盘中拦截 → 盘后复盘五维闭环</h4>
          <ul className="rlist">
            <li data-n="1">
              <b>盘前与账户水位双预警</b>：盘前准备面板提前 5 个交易日提示休市倒计时；进入长假前 1~2 日时，动态仓位风控条亮出<b>琥珀黄牌</b>，账户页自动将可用现金拆解为「跨假可动用额度」与「护城河避险储备」。
            </li>
            <li data-n="2">
              <b>下单前安全股数测算与二次确认</b>：个股作战卡片、闪电记T直接买入与尾盘黑马潜伏在预计买后超限时，实时提示<b>控仓线内最大可买整手股数</b>并弹出二次确认防冲动下单。
            </li>
            <li data-n="3">
              <b>台账自动打标与分级纪律扣分</b>：无视黄牌强行扩仓将自动挂载 <code>🏮 节前长假超限建仓</code> 并转为<em>计划外</em>（基础扣 12 分；节前剩 2 日再扣 16 分、收官日再扣 20 分、收官日尾盘买入再扣 22 分）。
            </li>
            <li data-n="4">
              <b>复盘教练与 15:05 归档减仓配额</b>：复盘教练同步扣减环境仓位分与止损纪律分、剖析「节前重仓博弈心魔」；15:05 收盘归档简报按<b>尾盘隔夜仓 → 破位锁标的 → 短线池 → 稳健底仓</b>整手（100股）生成减仓配额预案。
            </li>
          </ul>

          {onTabChange && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0 }}
                onClick={() => onTabChange('/trade')}
              >
                🎯 去今日作战台检查风控条 →
              </button>
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0 }}
                onClick={() => onTabChange('/account')}
              >
                📊 去账户页查看节前水位线 →
              </button>
              <button
                type="button"
                className="mini"
                style={{ marginLeft: 0 }}
                onClick={() => onTabChange('/ledger')}
              >
                📒 去台账呼叫复盘教练 →
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
