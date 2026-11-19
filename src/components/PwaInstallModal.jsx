import React, { useState, useEffect, useCallback } from 'react';
import { toastOk } from '../services/utils.js';

const DISMISS_KEY = 't-pwa-banner-dismissed-v1';

function checkIsStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    Boolean(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    Boolean(window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) ||
    window.navigator.standalone === true
  );
}

function detectPlatform() {
  if (typeof navigator === 'undefined') {
    return { isIos: false, isAndroid: false, isMobile: false };
  }
  const ua = navigator.userAgent || '';
  const isIos =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIos || isAndroid || /Mobile/i.test(ua);
  return { isIos, isAndroid, isMobile };
}

/**
 * 统一管理 PWA Service Worker 注册、全屏模式检测（自动写入 html[data-pwa]）与主屏安装提示
 */
export function usePwaManager() {
  const [isStandalone, setIsStandalone] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [platform, setPlatform] = useState({ isIos: false, isAndroid: false, isMobile: false });
  const [bannerDismissed, setBannerDismissed] = useState(true);
  const [installModalOpen, setInstallModalOpen] = useState(false);

  useEffect(() => {
    const plat = detectPlatform();
    setPlatform(plat);

    const syncStandalone = () => {
      const standalone = checkIsStandalone();
      setIsStandalone(standalone);
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.pwa = standalone ? 'standalone' : 'browser';
      }
    };
    syncStandalone();

    try {
      const dismissed = localStorage.getItem(DISMISS_KEY) === '1';
      setBannerDismissed(dismissed);
    } catch (_) {
      setBannerDismissed(false);
    }

    // 注册只缓存静态壳的轻量 Service Worker
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }

    const mq = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
    const onMqChange = () => syncStandalone();
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', onMqChange);
    }

    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      setInstallModalOpen(false);
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.pwa = 'standalone';
      }
      toastOk('📲 已添加到主屏幕！从桌面图标启动即可全屏直达今日作战台');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      if (mq && mq.removeEventListener) {
        mq.removeEventListener('change', onMqChange);
      }
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (_) {}
  }, []);

  const triggerInstall = useCallback(async () => {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          setDeferredPrompt(null);
          setInstallModalOpen(false);
          return;
        }
      } catch (_) {}
    }
    setInstallModalOpen(true);
  }, [deferredPrompt]);

  const showMobileBanner = !isStandalone && !bannerDismissed && (platform.isMobile || Boolean(deferredPrompt));

  return {
    isStandalone,
    canNativePrompt: Boolean(deferredPrompt),
    platform,
    showMobileBanner,
    dismissBanner,
    installModalOpen,
    openInstallModal: () => setInstallModalOpen(true),
    closeInstallModal: () => setInstallModalOpen(false),
    triggerInstall,
  };
}

/**
 * 手机浏览器顶部轻量安装提示条（已安装全屏模式或关闭后自动隐藏）
 */
export function PwaInstallBanner({ visible, canNativePrompt, onInstall, onDismiss }) {
  if (!visible) return null;

  return (
    <div className="pwa-install-banner">
      <div className="pib-left" onClick={onInstall} role="button" tabIndex={0}>
        <img src="/apple-touch-icon.png" alt="T-Stock" className="pib-icon" />
        <div className="pib-txt">
          <b>添加到主屏幕 · 全屏盯盘</b>
          <span>隐藏浏览器地址栏，点图标 0 秒直达今日作战台</span>
        </div>
      </div>
      <div className="pib-acts">
        <button type="button" className="pib-btn" onClick={onInstall}>
          {canNativePrompt ? '📲 一键安装' : '查看添加步骤'}
        </button>
        <button type="button" className="pib-close" onClick={onDismiss} title="不再提示">
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * 添加到主屏幕 / PWA 安装指引抽屉弹窗（区分 iOS Safari、Android 浏览器与桌面 Chrome/Edge）
 */
export default function PwaInstallModal({
  open,
  onClose,
  isStandalone = false,
  canNativePrompt = false,
  platform = {},
  onTriggerNative,
}) {
  if (!open) return null;

  const { isIos, isAndroid } = platform;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        <div className="modal-hd">
          <h3>📲 手机主屏全屏盯盘模式</h3>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-bd" style={{ fontSize: '13px', lineHeight: 1.65 }}>
          {/* 图标与收益亮点 */}
          <div className="pwa-hero-card">
            <img src="/apple-touch-icon.png" alt="智策战情室" className="pwa-hero-icon" />
            <div>
              <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text)' }}>
                智策战情室 · 独立全屏终端
              </div>
              <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '2px' }}>
                {isStandalone
                  ? '✅ 当前已处于全屏独立盯盘模式！切回应用自动同步最新实时行情。'
                  : '去除浏览器上下工具栏遮挡，释放近 18% 分时图看盘视野，点桌面图标直达「今日作战台」。'}
              </div>
            </div>
          </div>

          {canNativePrompt && !isStandalone && (
            <div style={{ marginBottom: '14px' }}>
              <button
                type="button"
                className="primary"
                onClick={onTriggerNative}
                style={{
                  width: '100%',
                  minHeight: '42px',
                  fontSize: '14px',
                  fontWeight: 800,
                  background: 'linear-gradient(135deg, #0284c7 0%, #059669 100%)',
                  border: 'none',
                  borderRadius: '9px',
                  color: '#fff',
                }}
              >
                📲 立即一键安装到桌面 / 主屏幕
              </button>
            </div>
          )}

          {!isStandalone && (
            <div className="pwa-steps-box">
              <div className="pwa-steps-title">
                {isIos
                  ? '🍎 iPhone / iPad (Safari) 两步添加法：'
                  : isAndroid
                  ? '🤖 Android 手机浏览器添加步骤：'
                  : '💻 手机与桌面浏览器添加步骤：'}
              </div>

              {isIos ? (
                <ol className="pwa-step-list">
                  <li>
                    点击 Safari 底部（或右上角）工具栏的 <b>「分享 ⬆️」</b> 按钮；
                  </li>
                  <li>
                    上滑菜单点击 <b>「添加到主屏幕 ➕」</b>，右上角点<b>「添加」</b>即可生成独立应用图标。
                  </li>
                </ol>
              ) : isAndroid ? (
                <ol className="pwa-step-list">
                  <li>
                    点击浏览器右上角或右下角菜单 <b>「⋮」</b>；
                  </li>
                  <li>
                    选择 <b>「安装应用」</b> 或 <b>「添加到主屏幕」</b>，即可像原生 App 一样全屏盯盘。
                  </li>
                </ol>
              ) : (
                <ol className="pwa-step-list">
                  <li>
                    <b>iPhone Safari：</b>点底部<b>「分享 ⬆️」</b> → 选<b>「添加到主屏幕 ➕」</b>；
                  </li>
                  <li>
                    <b>Android / Chrome / Edge：</b>点地址栏右侧安装图标或菜单 <b>「⋮ → 安装应用 / 添加到主屏幕」</b>。
                  </li>
                </ol>
              )}
            </div>
          )}

          {/* 长按桌面图标快捷方式预览 */}
          <div style={{ marginTop: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--sub)', marginBottom: '6px' }}>
              ⚡ 桌面图标直达与长按快捷菜单（Android / Chrome 支持长按图标秒跳）：
            </div>
            <div className="pwa-shortcut-grid">
              <div className="pwa-sc-item">
                <b>🎯 今日作战台</b>
                <span>默认启动直达持仓买卖点</span>
              </div>
              <div className="pwa-sc-item">
                <b>🚀 起爆挖掘池</b>
                <span>放量突破与首阴候选</span>
              </div>
              <div className="pwa-sc-item">
                <b>⚡ 尾盘黑马台</b>
                <span>14:30 潜伏与隔夜止盈</span>
              </div>
              <div className="pwa-sc-item">
                <b>🏁 15:05 收盘归档</b>
                <span>直达并自动拉起收盘复盘</span>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          <button type="button" className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
