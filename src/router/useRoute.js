import { useState, useEffect, useCallback } from 'react';
import { NAV_ROUTES } from '../data/site.js';

// 建立 tab 与 path 的双向映射字典
const TAB_TO_PATH = {};
const PATH_TO_TAB = {};

NAV_ROUTES.forEach(item => {
  TAB_TO_PATH[item.tab] = item.path;
  PATH_TO_TAB[item.path] = item.tab;
});

// 解析当前的 URL Hash
function parseHash(hashStr) {
  const currentHash = typeof window !== 'undefined' ? window.location.hash : '#/trade';
  const raw = (hashStr || currentHash || '').replace(/^#\/?/, '/');
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart ? (pathPart.startsWith('/') ? pathPart : '/' + pathPart) : '/trade';

  const query = {};
  if (queryPart) {
    const usp = new URLSearchParams(queryPart);
    for (const [k, v] of usp.entries()) {
      query[k] = v;
    }
  }

  // 映射到具体的 activeTab
  const matchedRoute = NAV_ROUTES.find(r => r.path === path) || NAV_ROUTES[0];
  const activeTab = matchedRoute.tab;

  return {
    path: matchedRoute.path,
    activeTab,
    query,
    routeInfo: matchedRoute
  };
}

/**
 * 响应式 URL 路由管理 Hook
 * 将页面激活状态与浏览器 URL (Hash) 彻底绑定，支持前进/后退、直接收藏与分享链接
 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());

  useEffect(() => {
    // 若当前没有任何 hash，自动置为默认的 #/trade
    if (!window.location.hash || window.location.hash === '#/') {
      window.location.hash = '#/trade';
    }

    const handleHashChange = () => {
      const next = parseHash();
      setRoute(next);
      // 记录到本地存储备忘
      try {
        localStorage.setItem('t-active-tab', next.activeTab);
      } catch (_) {}
    };

    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, []);

  const navigate = useCallback((target, options = {}) => {
    let destPath = '/trade';

    if (typeof target === 'string') {
      if (target.startsWith('/') || target.startsWith('#/')) {
        destPath = target.replace(/^#\/?/, '/');
      } else if (TAB_TO_PATH[target]) {
        // 支持传入 tabConsole 等旧 tab id
        destPath = TAB_TO_PATH[target];
      } else {
        destPath = '/' + target;
      }
    }

    const nextHash = `#${destPath}`;
    if (window.location.hash !== nextHash) {
      if (options.replace) {
        const urlWithoutHash = window.location.href.split('#')[0];
        window.location.replace(`${urlWithoutHash}${nextHash}`);
      } else {
        window.location.hash = nextHash;
      }
    }

    if (!options.preventScroll) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  return {
    path: route.path,
    activeTab: route.activeTab,
    query: route.query,
    routeInfo: route.routeInfo,
    navigate
  };
}

export default useRoute;
