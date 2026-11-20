/* ============================================================
   智策战情室 (T-Stock) · 轻量应用壳 Service Worker
   安全铁律：绝不缓存任何实时行情、K线、选股契约或本地金库 API，
   仅对静态应用壳（HTML / JS / CSS / 图标）采用「网络优先、离线回退」，
   兼顾手机主屏秒开安装能力与盘中 100% 实时鲜活行情。
   ============================================================ */

const CACHE_NAME = 'tstock-shell-v2';
const PRECACHE_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. 跨域请求（腾讯/东财实时行情、前复权K线等）一律直连网络，零拦截零缓存
  if (url.origin !== self.location.origin) return;

  // 2. 同源动态数据接口（含 /stock-api/ 反代）与开发环境热更新流一律直连网络
  if (
    url.pathname.startsWith('/stock-api/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/data/') ||
    url.pathname.startsWith('/_next/webpack-hmr')
  ) {
    return;
  }

  // 3. 应用导航与静态构建壳资源：网络优先（保证版本最新），断网/弱网回退本地壳缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const rootShell = await caches.match('/');
          if (rootShell) return rootShell;
        }
        throw new Error('Network unavailable');
      })
  );
});
