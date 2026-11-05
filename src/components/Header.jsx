import React from 'react';
import { SITE_META } from '../data/site.js';

export default function Header() {
  return (
    <header className="top">
      <h1>做<span>T</span>执行台</h1>
      <p>{SITE_META.subtitle}</p>
      <div className="badge-row">
        {SITE_META.methodologyTags.map((tag, idx) => (
          <span key={idx} className="tag">{tag}</span>
        ))}
      </div>
    </header>
  );
}
