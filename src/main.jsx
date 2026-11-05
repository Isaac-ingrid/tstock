import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import '../css/style.css';
import '../css/nav.css';
import '../css/anim.css';

console.log('[T-Stock] React 19 现代化执行台启动...');

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  console.error('[T-Stock] 未找到 #root 挂载节点');
}
