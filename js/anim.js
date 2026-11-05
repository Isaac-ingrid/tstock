/* ============================================================
   A股做T执行台 · Anime.js 动效中枢 (anim.js)
   使用官方 Anime.js v4 ESM 模块驱动高质量金融终端动画
   ============================================================ */

let animateFn = null;
let staggerFn = null;

try {
  // 按照规范引入 Anime.js v4 ESM 模块
  const animeModule = await import("https://cdn.jsdelivr.net/npm/animejs@4/+esm");
  animateFn = animeModule.animate;
  staggerFn = animeModule.stagger;
} catch (_) {
  try {
    // 本地离线备选模块
    const localModule = await import("./vendor/anime.esm.js");
    animateFn = localModule.animate;
    staggerFn = localModule.stagger;
  } catch (err) {
    console.warn('[Anim] Anime.js 模块加载降级，改用标准 CSS 动效');
  }
}

/**
 * 1. 选项卡切换平滑入场动效
 */
export function animTabTransition(panelEl) {
  if (!panelEl) return;
  if (animateFn) {
    try {
      animateFn(panelEl, {
        opacity: [0, 1],
        translateY: [10, 0],
        duration: 300,
        ease: 'outCubic'
      });
      return;
    } catch (_) {}
  }
  panelEl.style.opacity = '1';
  panelEl.style.transform = 'translateY(0)';
}

/**
 * 2. 个股卡片级联瀑布入场
 */
export function animCardsStagger(containerSelector = '#pool') {
  const cards = document.querySelectorAll(`${containerSelector} .card`);
  if (!cards || !cards.length) return;

  if (animateFn && staggerFn) {
    try {
      animateFn(cards, {
        opacity: [0, 1],
        translateY: [14, 0],
        delay: staggerFn(40, { start: 50 }),
        duration: 400,
        ease: 'outQuad'
      });
      return;
    } catch (_) {}
  }
  cards.forEach(c => { c.style.opacity = '1'; c.style.transform = 'translateY(0)'; });
}

/**
 * 3. 资产与市值数字平滑滚动跳动动效
 */
export function animCounter(el, startVal, endVal, prefix = '', duration = 650) {
  if (!el) return;
  const targetNum = Number(endVal) || 0;
  const startNum = Number(startVal) || 0;

  if (animateFn) {
    try {
      const state = { val: startNum };
      animateFn(state, {
        val: targetNum,
        duration,
        ease: 'outExpo',
        onUpdate: () => {
          el.textContent = (prefix || '') + Math.round(state.val).toLocaleString('zh-CN');
        }
      });
      return;
    } catch (_) {}
  }
  el.textContent = (prefix || '') + Math.round(targetNum).toLocaleString('zh-CN');
}

/**
 * 4. 价格变动微脉冲动效
 */
export function animPricePulse(el, isUp = true) {
  if (!el) return;
  const cls = isUp ? 'anim-flash-up' : 'anim-flash-dn';
  el.classList.remove('anim-flash-up', 'anim-flash-dn');
  // 触发重绘
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1200);

  if (animateFn) {
    try {
      animateFn(el, {
        scale: [1, 1.06, 1],
        duration: 260,
        ease: 'outBack'
      });
    } catch (_) {}
  }
}

/**
 * 5. 尾盘雷达卡片发光呼吸动效
 */
export function animRadarGlow(radarEl) {
  if (!radarEl) return;
  radarEl.classList.add('live-pulse');
}
