import React from 'react';

/**
 * 1.5px 描边线性 SVG 图标库 (Phase 1 App Shell & Quantitative UI)
 * 遵循 ui-skills / playbook 准则：
 * - 默认使用 1.5px 线性轮廓图标，激活态加粗至 1.9px 并叠加轻底色填充
 * - 统一 aria-hidden="true"，随父级 currentColor 自适应暗黑/日间双主题
 */
export default function Icon({ name, size = 16, active = false, className = '' }) {
  const sw = active ? 1.9 : 1.5;
  const fillTint = active ? 'currentColor' : 'none';
  const fillOpacity = active ? 0.14 : 0;

  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: sw,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    className: `ui-icon ${className}`.trim(),
    style: { flexShrink: 0, display: 'inline-block', verticalAlign: '-0.18em' },
  };

  switch (name) {
    case 'board':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" fill={fillTint} fillOpacity={fillOpacity} />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" fill={fillTint} fillOpacity={fillOpacity} />
        </svg>
      );
    case 'trade':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" fill={fillTint} fillOpacity={fillOpacity} />
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      );
    case 'ignition':
      return (
        <svg {...common}>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
      );
    case 'tail':
      return (
        <svg {...common}>
          <polygon
            points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"
            fill={fillTint}
            fillOpacity={fillOpacity}
          />
        </svg>
      );
    case 'diagnosis':
      return (
        <svg {...common}>
          <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
        </svg>
      );
    case 'account':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" fill={fillTint} fillOpacity={fillOpacity} />
          <path d="M16 12h2" />
          <path d="M3 9.5h18" />
        </svg>
      );
    case 'ledger':
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" fill={fillTint} fillOpacity={fillOpacity} />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
    case 'perf':
      return (
        <svg {...common}>
          <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
        </svg>
      );
    case 'rules':
      return (
        <svg {...common}>
          <path
            d="M12 3l7 3v5c0 5-3.2 8.8-7 10-3.8-1.2-7-5-7-10V6l7-3z"
            fill={fillTint}
            fillOpacity={fillOpacity}
          />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case 'all':
      return (
        <svg {...common}>
          <polygon points="12 3 2 8 12 13 22 8 12 3" fill={fillTint} fillOpacity={fillOpacity} />
          <path d="M2 13l10 5 10-5M2 17.5l10 4.5 10-4.5" />
        </svg>
      );
    case 'sidebarToggle':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <path d="M20 4v7h-7" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8.5-3 8.5h18S18 15 18 8" />
          <path d="M13.7 20a2 2 0 0 1-3.4 0" />
        </svg>
      );
    case 'bellOff':
      return (
        <svg {...common}>
          <path d="M13.7 20a2 2 0 0 1-3.4 0" />
          <path d="M18 8a6 6 0 0 0-9.3-5M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 8.5-3 8.5h13.5" />
          <path d="M3 3l18 18" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
          <path d="M9.5 13l2 2 3.5-3.5" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
        </svg>
      );
    case 'user':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" />
        </svg>
      );
    case 'copy':
      return (
        <svg {...common}>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case 'download':
      return (
        <svg {...common}>
          <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      );
    case 'upload':
      return (
        <svg {...common}>
          <path d="M12 15V3m0 0L8 7m4-4l4 4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      );
    case 'smartphone':
      return (
        <svg {...common}>
          <rect x="6" y="2.5" width="12" height="19" rx="2" />
          <path d="M11 18h2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6" />
        </svg>
      );
  }
}
