import { useState, useEffect, useCallback } from 'react';
import { NAV_ROUTES } from '../data/site.js';

// 建立 tab 与 path 的双向映射字典
const TAB_TO_PATH = {};
const PATH_TO_TAB = {};

NAV_ROUTES.forEach((item) => {
  TAB_TO_PATH[item.tab] = item.path;
  PATH_TO_TAB[item.path] = item.tab;
});

function normalizeTargetPath(rawTarget) {
  if (!rawTarget) return '';
  const clean = String(rawTarget).trim().replace(/^#\/?/, '');
  if (!clean) return '';
  if (TAB_TO_PATH[clean]) return TAB_TO_PATH[clean];
  const withSlash = clean.startsWith('/') ? clean : '/' + clean;
  const matched = NAV_ROUTES.find((r) => r.path === withSlash);
  return matched ? matched.path : '';
}

/**
 * 解析当前 URL（同时兼容 `#/trade?code=xxx` 与 PWA `start_url` / `shortcuts` 的 `/?tab=trade&eod=1`）
 * 规则优先级：URL Search `?tab=`（主屏启动与快捷菜单显式直达） > URL Hash `#/...` > 默认 `/trade`（今日作战台）
 */
function parseCurrentLocation(overrideHash) {
  if (typeof window === 'undefined') {
    return {
      path: '/trade',
      activeTab: NAV_ROUTES[0].tab,
      query: {},
      routeInfo: NAV_ROUTES[0],
      fromSearchParam: false,
    };
  }

  const searchParams = new URLSearchParams(window.location.search || '');
  const searchTab = normalizeTargetPath(searchParams.get('tab') || searchParams.get('route'));

  const currentHash = overrideHash !== undefined ? overrideHash : window.location.hash;
  const rawHash = (currentHash || '').replace(/^#\/?/, '/');
  const [hashPathPart, hashQueryPart] = rawHash.split('?');
  const hashPath = hashPathPart
    ? hashPathPart.startsWith('/')
      ? hashPathPart
      : '/' + hashPathPart
    : '';

  const effectivePath = searchTab || hashPath || '/trade';
  const matchedRoute = NAV_ROUTES.find((r) => r.path === effectivePath) || NAV_ROUTES[0];

  const query = {};
  for (const [k, v] of searchParams.entries()) {
    if (k !== 'tab' && k !== 'route' && k !== 'source') {
      query[k] = v;
    }
  }
  if (hashQueryPart) {
    const usp = new URLSearchParams(hashQueryPart);
    for (const [k, v] of usp.entries()) {
      query[k] = v;
    }
  }

  return {
    path: matchedRoute.path,
    activeTab: matchedRoute.tab,
    query,
    routeInfo: matchedRoute,
    fromSearchParam: Boolean(searchTab || searchParams.get('eod') || searchParams.get('source')),
  };
}

/**
 * 响应式 URL 路由管理 Hook
 * 支持浏览器 Hash 导航与手机主屏幕 PWA 图标/长按快捷方式直达今日作战台
 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseCurrentLocation());

  useEffect(() => {
    const initial = parseCurrentLocation();

    // 若从 PWA 桌面图标或快捷方式（如 /?tab=trade&source=pwa 或 /?tab=tail）启动，静默收敛为干净的 Hash URL
    if (initial.fromSearchParam) {
      const passthrough = new URLSearchParams();
      if (initial.query.code) passthrough.set('code', initial.query.code);
      const qSuffix = passthrough.toString() ? `?${passthrough.toString()}` : '';
      const cleanUrl = `${window.location.pathname}#${initial.path}${qSuffix}`;
      try {
        window.history.replaceState(null, '', cleanUrl);
      } catch (_) {}
      setRoute(initial);
    } else if (!window.location.hash || window.location.hash === '#/') {
      try {
        window.history.replaceState(null, '', `${window.location.pathname}#/trade`);
      } catch (_) {
        window.location.hash = '#/trade';
      }
    }

    const handleHashChange = () => {
      const next = parseCurrentLocation(window.location.hash);
      setRoute(next);
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
        destPath = TAB_TO_PATH[target];
      } else {
        destPath = '/' + target;
      }
    }

    const nextHash = `#${destPath}`;
    if (window.location.hash !== nextHash) {
      if (options.replace) {
        const base = window.location.pathname || '/';
        window.location.replace(`${base}${nextHash}`);
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
    navigate,
  };
}

export default useRoute;
