import React from 'react';
import { SITE_META } from '../data/site.js';

export default function Header() {
  return (
    <header className="top">
      <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <img
          src="/favicon.svg"
          alt="T-Stock Logo"
          style={{
            width: '36px',
            height: '36px',
            filter: 'drop-shadow(0 4px 12px rgba(56, 189, 248, 0.3))',
            borderRadius: '10px'
          }}
        />
        <h1 style={{ margin: 0 }}>智策<span>战情室</span></h1>
      </div>
      <p>{SITE_META.subtitle}</p>
      <div className="badge-row">
        {SITE_META.methodologyTags.map((tag, idx) => (
          <span key={idx} className="tag">{tag}</span>
        ))}
      </div>
    </header>
  );
}
