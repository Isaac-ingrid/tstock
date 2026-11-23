---
version: alpha
name: tstock
description: Quiet, high-density quantitative trading terminal for A-share intraday T+0 execution and risk control.
colors:
  bg: "#0b0e14"
  card: "#12161f"
  surface: "#171c27"
  surface2: "#1e2533"
  hair: "rgba(255, 255, 255, 0.05)"
  line: "rgba(255, 255, 255, 0.08)"
  line2: "rgba(255, 255, 255, 0.15)"
  text: "#e6edf3"
  sub: "#94a3b8"
  mute: "#64748b"
  ink-inverse: "#0b0e14"
  up: "#f04438"
  up-d: "#fda29b"
  up-b: "rgba(240, 68, 56, 0.32)"
  up-bg: "rgba(240, 68, 56, 0.11)"
  down: "#12b76a"
  down-d: "#6ce9a6"
  down-b: "rgba(18, 183, 106, 0.32)"
  down-bg: "rgba(18, 183, 106, 0.11)"
  warn: "#f59e0b"
  warn-d: "#fcd34d"
  warn-b: "rgba(245, 158, 11, 0.34)"
  warn-bg: "rgba(245, 158, 11, 0.11)"
  info: "#3b82f6"
  info-d: "#93c5fd"
  info-b: "rgba(59, 130, 246, 0.34)"
  info-bg: "rgba(59, 130, 246, 0.12)"
  accent: "#38bdf8"
  accent-d: "#7dd3fc"
  accent-b: "rgba(56, 189, 248, 0.32)"
  accent-bg: "rgba(56, 189, 248, 0.11)"
  teal: "#14b8a6"
  teal-b: "rgba(20, 184, 166, 0.30)"
  teal-bg: "rgba(20, 184, 166, 0.11)"
  scrim-solid: "rgba(6, 9, 15, 0.80)"
typography:
  sans:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
  mono:
    fontFamily: "JetBrains Mono, SF Mono, ui-monospace, Menlo, Consolas, monospace"
  h1:
    fontFamily: "Inter, -apple-system, PingFang SC, sans-serif"
    fontSize: "18px"
    lineHeight: "1.2"
    fontWeight: "600"
    letterSpacing: "-0.02em"
  h2:
    fontFamily: "Inter, -apple-system, PingFang SC, sans-serif"
    fontSize: "14px"
    lineHeight: "1.3"
    fontWeight: "600"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, PingFang SC, sans-serif"
    fontSize: "13px"
    lineHeight: "1.55"
    fontWeight: "400"
  caption:
    fontFamily: "Inter, -apple-system, PingFang SC, sans-serif"
    fontSize: "11.5px"
    lineHeight: "1.4"
    fontWeight: "500"
  metric:
    fontFamily: "JetBrains Mono, SF Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "20px"
    lineHeight: "1.15"
    fontWeight: "700"
rounded:
  card: "10px"
  inner: "6px"
  xs: "4px"
spacing:
  shell-rail: "208px"
  shell-rail-collapsed: "56px"
  topbar-h: "44px"
  card-gap: "12px"
---

## Overview

`tstock` is an A-share quantitative selection, intraday T+0 execution, pre-holiday position risk control, and trade-ledger review workbench. Its visual direction is a quiet, low-glare, data-first trading console designed for extended multi-hour market sessions on desktop monitors and mobile PWA viewports.

## Colors

- Reserve `up` and `down` strictly for A-share directional values (rising prices, gains, and bull bars in red; falling prices, losses, and bear bars in green). Never use directional colors for generic brand decoration.
- Use `warn` amber exclusively for system risk gates, stop-loss alerts, pre-holiday position yellow cards, and stale-data warnings.
- Limit interactive view accents to `info` and `accent` cool cyan-blue; keep headings and structural borders neutral (`text`, `sub`, `line`).
- Consume semantic CSS custom properties (`var(--bg)`, `var(--card)`, `var(--surface)`, `var(--line)`) across all components rather than hard-coded hex literals.

## Themes

Obsidian Dark (`html[data-theme="dark"]`) is the default workspace mode; Clean Daylight (`html[data-theme="light"]`) is user-selectable via `localStorage['t-ui-theme']`.

| Semantic Token | Obsidian Dark (Default) | Clean Daylight (`light`) |
| :--- | :--- | :--- |
| `--bg` | `#0b0e14` | `#f4f5f7` |
| `--card` | `#12161f` | `#ffffff` |
| `--surface` | `#171c27` | `#fafbfc` |
| `--surface2` | `#1e2533` | `#f1f5f9` |
| `--hair` | `rgba(255, 255, 255, 0.05)` | `#eef1f4` |
| `--line` | `rgba(255, 255, 255, 0.08)` | `#e5e7eb` |
| `--line2` | `rgba(255, 255, 255, 0.15)` | `#cbd5e1` |
| `--text` | `#e6edf3` | `#1f2328` |
| `--sub` | `#94a3b8` | `#515c69` |
| `--mute` | `#64748b` | `#66707c` |
| `--ink-inverse` | `#0b0e14` | `#ffffff` |
| `--up` / `--up-bg` | `#f04438` / `rgba(240, 68, 56, 0.11)` | `#d32f2f` / `#fff5f5` |
| `--down` / `--down-bg` | `#12b76a` / `rgba(18, 183, 106, 0.11)` | `#0a7f42` / `#f0fbf5` |
| `--warn` / `--warn-bg` | `#f59e0b` / `rgba(245, 158, 11, 0.11)` | `#9a6700` / `#fffaf0` |
| `--info` / `--info-bg` | `#3b82f6` / `rgba(59, 130, 246, 0.12)` | `#2563eb` / `#eff6ff` |
| `--accent` / `--accent-bg` | `#38bdf8` / `rgba(56, 189, 248, 0.11)` | `#0284c7` / `#f0f9ff` |
| `--scrim-solid` | `rgba(6, 9, 15, 0.80)` | `rgba(15, 23, 42, 0.52)` |

## Typography

- Apply `font-variant-numeric: tabular-nums` to all stock codes, prices, percentages, share counts, timestamps, orderbook depths, and P&L tables so live quote ticks never shift column widths.
- Apply `text-wrap: balance` to headings and `text-wrap: pretty` to explanatory notes.
- Use `truncate` or CSS mask fades on dense stock/theme tags rather than allowing multi-line card height raggedness.

## Layout

- Desktop (`>= 960px`) uses `.app-shell` with a collapsible left navigation rail (`208px` expanded, `56px` collapsed) and a single-row `44px` top status header above `.app-main`.
- Mobile (`< 960px`) uses `min-height: 100dvh`, a compact single-row top header, and a fixed bottom navigation dock padded with `env(safe-area-inset-bottom)` and `>= 44x44px` touch targets.
- Group related metrics using Bento grid spacing (`10px`–`12px` gaps) rather than stacked full-width horizontal divider rules.

## Elevation & Depth

- Define card hierarchy through stepped surface luminance (`--bg` -> `--card` -> `--surface` -> `--surface2`) and `1px solid var(--line)` structural borders rather than heavy drop shadows.
- Render modal backdrops with solid `--scrim-solid` instead of full-screen `backdrop-filter: blur()`.

## Shapes

- Follow concentric border radii (`inner = outer - padding`): `10px` (`--radius-card`) on outer cards and dialogs, `6px` (`--radius-inner`) on nested inputs, buttons, and sub-blocks, and `4px` (`--radius-xs`) on compact tags.

## Components

- Navigation and toolbar icons use `1.5px`-stroke inline SVG outlines (`2px` stroke or subtle accent fill when active) with `aria-hidden="true"`, replacing decorative Emoji prefixes.
- Icon-only controls require an explicit `aria-label` and visible `:focus-visible` focus ring (`2px solid var(--info)`).
- Interactive buttons provide `<= 150ms ease-out` `transform: scale(0.97)` press feedback on `:active`.

## Do's and Don'ts

- Pair every risk or market status color with explicit text or iconography; never rely on color alone.
- Respect `@media (prefers-reduced-motion: reduce)` across all pulse and transition rules.
- Do not use purple or multicolor decorative gradients on headings, banners, or primary actions.
- Do not animate layout properties (`width`, `height`, `top`, `left`, `margin`) or continuous container `box-shadow` glows; animate only `transform` and `opacity`.
