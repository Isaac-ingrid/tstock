import React from 'react';

export default function MethodologyFold() {
  return (
    <section>
      <details className="fold">
        <summary>一、方法论内核（四条定理）· 点击展开</summary>
        <div className="fold-bd">
          <div className="axiom-grid">
            <div className="ax">
              <b>① 做T不是赚钱，是降成本</b>
              <span>目标是把持仓成本往下推，让你比别人的账户<em>多扛一段回撤</em>。守的是仓位，不是手速。</span>
            </div>
            <div className="ax">
              <b>② 赚的是情绪波动溢价</b>
              <span>一只票日内那 3% 的无理由急跌，真正抛压可能只有 1%，剩下<em>2% 是情绪</em>——这就是T仓的猎物。</span>
            </div>
            <div className="ax">
              <b>③ 底仓与T仓必须物理隔离</b>
              <span>底仓守趋势（70%），T仓做套利（30%），当天闭环。T仓一旦隔夜，就是从"做T"变成"加仓被套"。</span>
            </div>
            <div className="ax">
              <b>④ 不做也是一种做</b>
              <span>振幅不到 4%、趋势朝下、信号模糊——<em>空着就是最优操作</em>。做T是枪，不是打卡机。</span>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
