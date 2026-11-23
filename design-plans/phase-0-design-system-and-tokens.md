# Establish DESIGN.md Contract and Dual-Theme Quantitative Token Foundation (Phase 0)

Written against: 8af01a9

## Evidence chain

- Surface: `app/layout.jsx`, `css/style.css`, `css/anim.css`, and global root document rendering across all `#/*` routes
- Problem: The repository lacks a `DESIGN.md` contract, hard-codes a light-only palette in `css/style.css` (`--bg:#f4f5f7; --card:#ffffff`) and `app/layout.jsx` (`themeColor: '#ffffff'`), declares `font-variant-numeric: tabular-nums` in only 14 rules across the entire codebase, and mixes arbitrary border radii (`6px`, `7px`, `9px`, `10px`, `11px`, `12px`, `999px`) with 90 decorative gradients and drop-shadows—producing bright, inconsistent "admin-form" surfaces instead of a low-glare quantitative trading terminal.
- Design evidence: `css/style.css` lines 1–35 (`:root` token hierarchy and semantic hue separation rules for `--up`, `--down`, `--warn`, `--info`, `--accent`, `--teal`), `app/layout.jsx` lines 5–11 (`viewport.themeColor`), reference dark quantitative market dashboard (`#0b0e14` canvas, `#12161f` cards, subtle `1px` neutral borders, tabular monospace figures), and `ui-skills` rules (`create-design-md`, `baseline-ui` mandatory `tabular-nums`, concentric border radii `inner = outer - padding`, single view accent, and no decorative multicolor/purple gradients or primary glows).
- Owner: `DESIGN.md` (new root contract), `css/style.css`, `css/anim.css`, and `app/layout.jsx`
- Scope and affected surfaces: Global `html[data-theme="dark" | "light"]` root tokens, typography classes, elevation/border utilities, modal scrim rules, and initial theme hydration script in `app/layout.jsx`
- Uncertainty: None; existing semantic variable names (`--bg`, `--card`, `--surface`, `--surface2`, `--line`, `--line2`, `--hair`, `--text`, `--sub`, `--mute`, `--up`, `--down`, `--warn`, `--info`, `--accent`, `--teal`) can be preserved and extended so existing CSS consumers inherit the new theme automatically without breaking legacy selectors.

## Design decision

Create a canonical `DESIGN.md` at the repository root (following the `create-design-md` YAML frontmatter + Markdown guidance schema) and refactor `css/style.css` so Obsidian Dark (`html[data-theme="dark"]`, set as the default trading terminal theme with instant flash-free hydration in `app/layout.jsx` and persisted under `localStorage['t-ui-theme']`) and Clean Daylight (`html[data-theme="light"]`) share one strict semantic CSS custom-property contract, backed by mandatory `tabular-nums` data typography, concentric corner radii (`10px` outer card, `6px` nested control), solid modal scrims, and `<= 200ms` compositor-only (`transform`, `opacity`) transitions.

## Reuse

- Existing semantic CSS custom properties in `css/style.css`: `--bg`, `--card`, `--surface`, `--surface2`, `--line`, `--line2`, `--hair`, `--text`, `--sub`, `--mute`, `--up`, `--up-d`, `--up-b`, `--up-bg`, `--down`, `--down-d`, `--down-b`, `--down-bg`, `--warn`, `--warn-d`, `--warn-b`, `--warn-bg`, `--info`, `--info-d`, `--info-b`, `--info-bg`, `--accent`, `--accent-d`, `--accent-b`, `--accent-bg`, `--teal`, `--teal-b`, `--teal-bg`, `--shadow`
- Exemplar: `css/style.css` lines 1–28 (semantic hue separation where `--up` / `--down` are reserved strictly for A-share price/P&L direction and `--warn` is isolated for risk/staleness judgment)

New shared token additions justified by missing capabilities across 2+ surfaces (`BoardPage`, `TradePage`, `DiagnosisPage`, `Modals`):
- Typography & numeric alignment tokens in `css/style.css`: `--font-sans`, `--font-mono`, and utility class `.num-mono` (`font-family: var(--font-mono); font-variant-numeric: tabular-nums;`)
- Concentric radius tokens in `css/style.css`: `--radius-card: 10px`, `--radius-inner: 6px`, `--radius-xs: 4px`
- Fixed z-index scale in `css/style.css`: `--z-sticky: 20`, `--z-sidebar: 30`, `--z-popover: 40`, `--z-modal-scrim: 80`, `--z-modal: 90`, `--z-toast: 100`
- Surface status tint tokens (`--scrim-solid`, `--ring-subtle`, `--focus-ring`) that adapt cleanly between dark and light modes without `backdrop-filter: blur()`

## Changes

1. `DESIGN.md` (new file at repository root)
   - Change: Author the authoritative `DESIGN.md` using valid `version: alpha` YAML frontmatter (`name`, `description`, flat `colors` tokens for default dark theme, `typography.sans` with `Inter, -apple-system, "PingFang SC", sans-serif` and `typography.mono` with `"JetBrains Mono", "SF Mono", Menlo, monospace`, `rounded`, and `spacing`) followed by standard sections (`Overview`, `Colors`, `Themes` fallback table documenting exact Light-mode counterparts, `Typography`, `Layout`, `Elevation & Depth`, `Shapes`, `Components`, `Do's and Don'ts`).
   - Preserve: A-share convention (`--up` red for rising prices/gains, `--down` green for falling prices/losses) and 40-degree hue separation for `--warn` amber risk alerts.
   - Verify: Every YAML token key matches `^[a-zA-Z0-9][a-zA-Z0-9-]*$`, `typography` entries are named scale mappings (`fontFamily`, `fontSize`, `lineHeight`, `fontWeight`), and prose states concrete implementation rules without generic filler.

2. `css/style.css`
   - Change:
     - Define `:root, html[data-theme="dark"]` as the default Obsidian quantitative terminal palette:
       - Canvas & surfaces: `--bg: #0b0e14`, `--card: #12161f`, `--surface: #171c27`, `--surface2: #1e2533`, `--hair: rgba(255, 255, 255, 0.05)`, `--line: rgba(255, 255, 255, 0.08)`, `--line2: rgba(255, 255, 255, 0.15)`
       - Text hierarchy (WCAG AA compliant on `#12161f`): `--text: #e6edf3`, `--sub: #94a3b8`, `--mute: #64748b`
       - A-share direction & status tokens on dark surfaces: `--up: #f04438`, `--up-d: #fda29b`, `--up-b: rgba(240, 68, 56, 0.32)`, `--up-bg: rgba(240, 68, 56, 0.10)`; `--down: #12b76a`, `--down-d: #6ce9a6`, `--down-b: rgba(18, 183, 106, 0.32)`, `--down-bg: rgba(18, 183, 106, 0.10)`; `--warn: #f59e0b`, `--warn-d: #fcd34d`, `--warn-b: rgba(245, 158, 11, 0.34)`, `--warn-bg: rgba(245, 158, 11, 0.10)`; `--info: #3b82f6`, `--info-d: #93c5fd`, `--info-b: rgba(59, 130, 246, 0.34)`, `--info-bg: rgba(59, 130, 246, 0.12)`; `--accent: #38bdf8` (single cool-cyan terminal focus accent, replacing high-saturation purple across shared chrome), `--teal: #14b8a6`, `--scrim-solid: rgba(6, 9, 15, 0.78)`
     - Define `html[data-theme="light"]` preserving the existing daylight palette (`--bg: #f4f5f7`, `--card: #ffffff`, `--text: #1f2328`, `--sub: #515c69`, `--mute: #66707c`, etc.) with harmonized radius/font/z-index variables.
     - Apply `font-variant-numeric: tabular-nums` automatically to `table`, `td`, `th`, `input[type="number"]`, `.num-mono`, `b`, `.price`, `.pct`, and metric value selectors; apply `text-wrap: balance` on `h1, h2, h3` and `text-wrap: pretty` on `p`.
     - Replace hard-coded `#fff` backgrounds inside `.tag`, `.pool-tab`, `input`, `select`, `textarea`, and `.modal-box` in `css/style.css` with `var(--card)` / `var(--surface)` and add visible `:focus-visible` outlines (`2px solid var(--info)`) plus subtle `:active { transform: scale(0.97); }` button press feedback (`<= 120ms ease-out`).
   - Preserve: All existing layout class names (`.wrap`, `.card`, `.tag`, `.axioms`, `.pool-tabs`, `.tier-bar`, `.fld`, `.modal-mask`, `.modal-box`) so no React component breaks before Phase 1–3 surface refactors run.
   - Verify: Toggling `document.documentElement.dataset.theme` between `'dark'` and `'light'` switches canvas, cards, borders, inputs, tables, and semantic pills cleanly with zero unreadable white-on-white or dark-on-dark text in global CSS rules.

3. `css/anim.css`
   - Change: Audit all keyframes and transitions against `fixing-motion-performance`: restrict continuous/interactive transitions to `transform` and `opacity` (`<= 200ms ease-out`), remove layout-thrashing width/height transitions where applicable, and add a `@media (prefers-reduced-motion: reduce)` block disabling non-essential animations.
   - Preserve: Existing class hooks referenced by `src/services/anim.js` so runtime calls never throw or miss selectors.
   - Verify: Zero continuous `blur()` animations and full `prefers-reduced-motion` support.

4. `app/layout.jsx`
   - Change: Update `viewport.themeColor` to an array supporting media/theme (`#0b0e14` default dark, `#f4f5f7` light) and inject a tiny synchronous inline `<script>` in `<head>` (or top of `<body>`) that reads `localStorage.getItem('t-ui-theme') || 'dark'` and sets `document.documentElement.dataset.theme` prior to first paint to prevent light-to-dark flash (FOUC).
   - Preserve: Static export compatibility (`output: 'export'`), PWA manifest links, icons, and metadata.
   - Verify: `npm run build` succeeds as pure static export (`out/index.html`) and cold reload in dark mode shows zero white flash.

## Scope

- Inherit: All routes rendered under `app/layout.jsx` (`#/trade`, `#/ignition`, `#/board`, `#/tail`, `#/diagnosis`, `#/account`, `#/ledger`, `#/perf`, `#/rules`, `#/all`)
- Verify: `css/style.css` base form controls (`input`, `select`, `button`), tables, `.modal-mask`, and `.tag` badges in both `dark` and `light` themes
- Exclude: Navigation structure (`TopNav.jsx` — covered in Phase 1), `BoardPage.jsx` Bento grid restructuring (covered in Phase 2), and component-level inline `style={{...}}` cleanup across JSX views (covered in Phase 3)

## Validation

- Product: Load the workbench in dark mode (default) and switch `data-theme="light"`, confirming all global surfaces, text contrast ratios (`>= 4.5:1`), A-share red/green direction colors, and amber risk tokens render legibly.
- Interface: Inspect numeric tables, inputs, headings, and modal backdrops at `1440px` desktop and `390px` mobile viewports; verify numbers remain vertically aligned during 8-second quote refreshes (`tabular-nums`).
- System: Confirm zero parallel `-dark` / `-light` CSS variable forks—every component consumes one unified semantic variable set.
- Repository: `TZ=America/New_York npm run test:calendar && npm run test:backend && npm run build` → 266 frontend/calendar assertions pass, 28 backend tests pass, and Next.js static export completes with exit code `0`.

## Stop conditions

- Stop if Next.js static export (`output: 'export'`) rejects inline theme-hydration script placement without `dangerouslySetInnerHTML`, or if any semantic variable rename would break existing class selectors in `css/nav.css` before Phase 1 runs.

## Design documentation

- After acceptance and validation: Commit root `DESIGN.md` as the single source of truth governing Phase 1, Phase 2, and Phase 3 implementation plans.
