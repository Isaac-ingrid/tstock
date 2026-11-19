import React from 'react';

const PATTERN_STYLE_MAP = {
  TOP_ISLAND: {
    icon: '🏝️',
    label: '顶部岛形反转（高危）',
    color: '#cf1322',
    bg: '#fff1f0',
    border: '#ffa39e',
  },
  BOTTOM_ISLAND: {
    icon: '🏝️',
    label: '底部岛形反转（强反转）',
    color: '#15803d',
    bg: '#f0fdf4',
    border: '#86efac',
  },
  HIGH_GRAVESTONE: {
    icon: '⚡',
    label: '高位天量避雷针',
    color: '#b45309',
    bg: '#fffbeb',
    border: '#fcd34d',
  },
  BEARISH_ENGULFING: {
    icon: '🐻',
    label: '高位放量阴包阳',
    color: '#c2410c',
    bg: '#fff7ed',
    border: '#fdba74',
  },
  IMMORTAL_GUIDE: {
    icon: '✨',
    label: '仙人指路反包',
    color: '#0369a1',
    bg: '#f0f9ff',
    border: '#7dd3fc',
  },
};

function buildChips(klinePatterns) {
  if (!klinePatterns || typeof klinePatterns !== 'object') return [];
  const chips = [];
  const list = Array.isArray(klinePatterns.patterns) ? klinePatterns.patterns : [];

  list.forEach((p) => {
    const st = PATTERN_STYLE_MAP[p.code] || {
      icon: p.side === 'bearish' ? '⚠️' : '📈',
      label: p.name || p.code,
      color: p.side === 'bearish' ? '#b45309' : '#15803d',
      bg: p.side === 'bearish' ? '#fffbeb' : '#f0fdf4',
      border: p.side === 'bearish' ? '#fcd34d' : '#86efac',
    };
    chips.push({
      key: p.code,
      text: `${st.icon} ${st.label}`,
      desc: p.desc || '',
      side: p.side || 'neutral',
      severity: p.severity || 'medium',
      color: st.color,
      bg: st.bg,
      border: st.border,
    });
  });

  const supGap = klinePatterns.nearestSupportGap;
  if (supGap && supGap.confirmed3d) {
    chips.push({
      key: `SUP_GAP_${supGap.date || ''}`,
      text: `🧱 3日不补支撑缺口 ¥${Number(supGap.gapLow).toFixed(2)}~¥${Number(supGap.gapHigh).toFixed(2)}`,
      desc: `${supGap.date || ''} 向上跳空缺口连续 ${supGap.ageDays} 日未回补，构成有效下方支撑带`,
      side: 'bullish',
      severity: 'info',
      color: '#0369a1',
      bg: '#f0f9ff',
      border: '#7dd3fc',
    });
  }

  const resGap = klinePatterns.nearestResistanceGap;
  if (resGap && !klinePatterns.hasTopIsland) {
    chips.push({
      key: `RES_GAP_${resGap.date || ''}`,
      text: `🚧 上方压力缺口 ¥${Number(resGap.gapLow).toFixed(2)}~¥${Number(resGap.gapHigh).toFixed(2)}`,
      desc: `${resGap.date || ''} 向下跳空缺口尚未回补，反抽至此区间易遇套牢盘阻力`,
      side: 'bearish',
      severity: 'info',
      color: '#9a3412',
      bg: '#fff7ed',
      border: '#fed7aa',
    });
  }

  return chips;
}

/**
 * 统一渲染后端 klinePatterns（岛形反转 / 避雷针 / 阴包阳 / 仙人指路 / 缺口状态机）
 * - variant="compact": 仅渲染紧凑视觉徽章（适用于起爆池、抄底池、抱团池卡片）
 * - variant="banner": 渲染徽章 + 顶部高危/强反转警示说明条（适用于诊股报告主卡片）
 */
export default function KlinePatternBadges({ klinePatterns, variant = 'compact', style = {} }) {
  const chips = buildChips(klinePatterns);
  if (!chips.length) return null;

  const hasVeto = Boolean(klinePatterns?.hasTopIsland || klinePatterns?.hasHighGravestone || klinePatterns?.hasBearishEngulfing);
  const hasBull = Boolean(klinePatterns?.hasBottomIsland || klinePatterns?.hasImmortalGuide);

  if (variant === 'banner') {
    const primaryChip = chips[0];
    const bannerTheme = hasVeto
      ? { bg: '#fff1f0', border: '#ffa39e', titleColor: '#cf1322', heading: '🚨 A股K线形态风控雷达' }
      : hasBull
        ? { bg: '#f0fdf4', border: '#86efac', titleColor: '#15803d', heading: '✨ A股K线形态共振雷达' }
        : { bg: '#f0f9ff', border: '#bae6fd', titleColor: '#0369a1', heading: '🧱 A股缺口支撑/压力雷达' };

    return (
      <div
        style={{
          marginTop: '10px',
          padding: '10px 12px',
          borderRadius: '8px',
          background: bannerTheme.bg,
          border: `1px solid ${bannerTheme.border}`,
          ...style,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: primaryChip?.desc ? '6px' : 0 }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: bannerTheme.titleColor, marginRight: '4px' }}>
            {bannerTheme.heading}
          </span>
          {chips.map((c) => (
            <span
              key={c.key}
              title={c.desc}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '11.5px',
                fontWeight: 700,
                color: c.color,
                background: c.bg,
                border: `1px solid ${c.border}`,
                lineHeight: 1.4,
              }}
            >
              {c.text}
            </span>
          ))}
        </div>
        {chips.filter((c) => c.desc).slice(0, 2).map((c) => (
          <div key={`${c.key}_desc`} style={{ fontSize: '12px', color: '#334155', lineHeight: 1.55, marginTop: '2px' }}>
            · {c.desc}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '6px', ...style }}>
      {chips.map((c) => (
        <span
          key={c.key}
          title={c.desc}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '1px 7px',
            borderRadius: '999px',
            fontSize: '11px',
            fontWeight: 600,
            color: c.color,
            background: c.bg,
            border: `1px solid ${c.border}`,
            lineHeight: 1.45,
          }}
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}
