import React from 'react';

export default function Header() {
  return (
    <header className="top">
      <h1>做<span>T</span>执行台</h1>
      <p>选股之后，在这里执行：一张表算出今天的买卖点、仓位和纪律线。</p>
      <div className="badge-row">
        <span className="tag">七格箱体定位置</span>
        <span className="tag">七底三仓定仓位</span>
        <span className="tag">1.5% 止损铁律</span>
        <span className="tag">无信号不交易</span>
      </div>
    </header>
  );
}
