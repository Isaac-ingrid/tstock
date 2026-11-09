'use client';

import { useEffect, useState } from 'react';
import App from '../src/App.jsx';

export default function ClientShell() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <main className="app-loading">正在加载做T执行台…</main>;
  }

  return <App />;
}
