# Refactor Global App Shell to Collapsible Left Rail and Compact Status Header (Phase 1)

Written against: 8af01a9

## Evidence chain

- Surface: `src/App.jsx`, `src/components/TopNav.jsx`, `src/data/site.js` (`NAV_ROUTES`), and `css/nav.css` across all `#/*` routes on desktop (`>= 960px`) and mobile PWA (`< 960px`) viewports
- Problem:
  1. `TopNav.jsx` renders a two-row horizontal capsule bar (`.topbar.topbar-v2`, `.tb-row-main` + `.tb-row-sub`) with `backdrop-filter: blur(10px)` (`css/nav.css` line 27), multicolor gradient brand text (`linear-gradient(135deg, #0284c7 0%, #059669 100%)`, `css/nav.css` line 57), neon logo `drop-shadow` (`css/nav.css` line 50), inline purple route highlights (`style={item.highlight ? { color: 'var(--accent)', fontWeight: 700 } : undefined}`, `TopNav.jsx` line 113), inline light-only archive button colors (`#f0fdf4`, `#fffbeb`, `TopNav.jsx` lines 156–159), and 15+ decorative Emojis (`🚀`, `🔥`, `⚡`, `🩺`, `💰`, `📒`, `📊`, `📖`, `🌐`, `👑`, `🔔`, `🏁`).
  2. On desktop screens, the stacked topbar plus page banners consume ~140–180px of vertical height before primary trading data starts, whereas the target quantitative terminal reference places navigation in a collapsible left rail with persistent bottom-left market index ticker cards and a thin `44px` single-row top status header.
  3. Several icon/compact controls lack explicit `aria-label` attributes or keyboard-accessible Escape handling on custom popovers (`TopNav.jsx` `.tb-more`), and full-screen modal masks use blur instead of solid scrims.
- Design evidence: `src/components/TopNav.jsx` lines 90–298, `src/data/site.js` lines 20–99, `css/nav.css` lines 1–120, user-provided dark quantitative market terminal reference (left collapsible rail + persistent 4-index mini-grid + theme toggle + `44px` top header), and `ui-skills` rules (`baseline-ui` no multicolor/purple gradients, no primary glows, `100dvh` + `safe-area-inset`, `44px` touch targets; `playbook.ts` `use-outline-icons-by-default`, `match-icon-stroke-weight`, `use-solid-modal-scrims`, `restrain-high-frequency-motion`; `fixing-accessibility` `aria-label` on icon-only controls and visible `:focus-visible`).
- Owner: `src/components/TopNav.jsx` (and extracted shell subcomponents `src/components/SideRail.jsx` + `src/components/Icons.jsx`), `src/data/site.js`, `src/App.jsx`, `css/nav.css`
- Scope and affected surfaces: Global chrome wrapping every page in `src/App.jsx`, route labels in `src/data/site.js`, theme toggle persistence (`t-ui-theme`), sidebar collapse persistence (`t-sidebar-collapsed`), and responsive mobile navigation bar
- Uncertainty: Live index quotes (`000001.SH`, `399001.SZ`, `399006.SZ`, `000688.SH`) for the bottom-left mini-ticker widget—must verify whether `fetchQuotes` in `src/services/api.js` already supports index symbols (`sh000001`, `sz399001`, `sz399006`, `sh000688`) so we reuse the existing quote pipeline without adding a new backend endpoint.

## Design decision

Replace the two-row capsule topbar on desktop (`>= 960px`) with a structured two-part quantitative terminal shell—a collapsible `208px` (`56px` collapsed) left navigation rail (`SideRail.jsx`) featuring clean `1.5px` stroke SVG outline icons (filled/accented on active state), grouped trading workflows, a persistent bottom-left 2×2 A-share core index mini-board (`上证 / 深成 / 创业 / 科创`), and a daylight/dark theme toggle, paired with a single-row `44px` top status bar (`TopNav.jsx`) housing the current view title, inline asset/cash/position quick-bar, trading clock + statutory holiday / pre-holiday yellow-card dot (`#tbClockPill`), 15:05 EOD archive trigger, and manual refresh—while adapting cleanly on `< 960px` mobile screens to a compact `44px` top status bar plus a `safe-area-inset-bottom` tab dock with `>= 44×44px` touch targets.

## Reuse

- `evaluateTopNavClockBadge` (`src/services/risk.js`) and `syncRemoteTradeCalendar` (`src/services/calendar.js`) — keep 100% of existing statutory holiday & pre-holiday overcap yellow-card logic and DOM IDs (`#tbClockPill`, `#tbClockPhase`, `#tbClockHolidayBadge`, `#tbQuoteTime`, `#tbAccPill`, `#btnEodArchive`, `#btnRefreshAll`, `#btnToggleNotify`) intact.
- `DirectMoneyInput` (`src/components/DirectMoneyInput.jsx`) — reuse directly inside the compact top status bar for one-click total-asset and cash editing.
- `NAV_ROUTES` (`src/data/site.js`) & `useRoute` (`src/router/useRoute.js`) — keep all 10 `path` / `tab` identifiers unchanged; add clean semantic `iconName` and `group` (`'实战盯盘'` | `'盘后资产'`) metadata while stripping decorative Emoji prefixes from `label` (`'起爆挖掘'`, `'连板打板'`, `'尾盘黑马'`, `'全景诊断'`, `'战绩透视'`, `'全览'`).
- New shared primitive `src/components/Icons.jsx`: Minimal zero-dependency `1.5px`-stroke inline SVG icon set (`16×16` / `18×18`, `aria-hidden="true"`) shared across `SideRail.jsx`, `TopNav.jsx`, `BoardPage.jsx`, and `TradePage.jsx` because no SVG icon primitive currently exists in the repository.

## Changes

1. `src/components/Icons.jsx` (new lightweight shared SVG primitive)
   - Change: Implement crisp `1.5px`-stroke outline SVG icons (`2px` stroke or subtle fill tint when `active={true}`) for all 10 routes (`trade`, `ignition`, `board`, `tail`, `diagnosis`, `account`, `ledger`, `perf`, `rules`, `all`) and shell controls (`clock`, `refresh`, `bell`, `bellOff`, `archive`, `sun`, `moon`, `sidebarCollapse`, `user`, `more`, `copy`, `download`, `upload`).
   - Preserve: Zero third-party icon package installation.
   - Verify: All icons render with `aria-hidden="true"` and inherit `currentColor`.

2. `src/data/site.js`
   - Change: Strip leading Emojis from `NAV_ROUTES[*].label` so labels read cleanly in sentence/title form (`今日作战`, `起爆挖掘`, `连板打板`, `尾盘黑马`, `全景诊断`, `账户总览`, `交易台账`, `战绩透视`, `实战纪律`, `全览模式`), and add `iconKey` + `group` fields (`core` for real-time market/trading views, `review` for account/ledger/perf/rules).
   - Preserve: Every `path`, `tab`, and `badgeKey` value verbatim so `useRoute.js` and `test_trade_calendar.js` suffer zero breaking changes.
   - Verify: Hash navigation across all 10 routes resolves identically.

3. `src/components/TopNav.jsx` & `src/components/SideRail.jsx`
   - Change:
     - Desktop left rail (`SideRail.jsx`): `208px` expanded / `56px` collapsed (`transform`/`width` avoided on heavy containers—use fixed CSS grid column on `.app-shell` with instant toggle per `restrain-high-frequency-motion`), brand header + collapse button (`aria-label="收起侧边导航"`), grouped route items with neutral count badges, bottom-left 2×2 real-time index mini-grid (`上证指数`, `深证成指`, `创业板指`, `科创综指` with `tabular-nums`), and bottom footer bar (`日间/暗色切换` button + `账号/设置` button).
     - Single-row `44px` top header (`TopNav.jsx`): Left shows current view title + live market status pill; center-right shows `#tbAccPill` (`DirectMoneyInput` for assets/cash + position `%` in `tabular-nums`), `#tbClockPill` (preserving `#tbClockPhase`, `#tbClockHolidayBadge`, `#tbQuoteTime`), `#btnToggleNotify`, `#btnEodArchive` (replacing inline `#f0fdf4`/`#fffbeb` styles with dual-theme semantic classes `.is-archived` / `.is-eod-due`), `#btnRefreshAll`, and accessible overflow menu (closing on `Escape` and outside click).
     - Mobile (`< 960px`): Hide desktop left rail; render compact `44px` top header + fixed bottom navigation bar (`padding-bottom: env(safe-area-inset-bottom)`) with 5 primary tabs (`作战`, `看板`, `起爆`, `诊断`, `台账`) and a `更多` sheet trigger, each `>= 44×44px`.
   - Preserve: All props passed from `src/App.jsx`, all DOM `id` hooks (`#topbar`, `#topNav`, `#tbClockPill`, `#tbClockHolidayBadge`, `#tbAccPill`, `#btnEodArchive`, `#btnRefreshAll`, `#btnToggleNotify`), and holiday yellow-card badge logic.
   - Verify: Zero Emoji clutter in primary chrome, zero multicolor/purple gradients, zero `backdrop-filter: blur()`, and instant keyboard Tab + Escape navigation.

4. `src/App.jsx` & `css/nav.css`
   - Change: Wrap the main layout in `.app-shell` (`min-height: 100dvh`, CSS grid `208px minmax(0, 1fr)` on desktop, `56px minmax(0, 1fr)` when collapsed, single column on `< 960px`), wire `theme` (`dark` | `light`) and `sidebarCollapsed` state, fetch lightweight 4-index quotes alongside the existing refresh cycle, and replace all `backdrop-filter` rules on `.topbar` and `.modal-mask` with solid theme tokens (`var(--card)` and `var(--scrim-solid)`).
   - Preserve: Multi-user vault auth gate, toast notifications, keyboard shortcuts, and all modal triggers.
   - Verify: Above-the-fold vertical height on `1440×900` desktop increases by at least `80px`, and switching tabs triggers zero layout shift or animation jank.

## Scope

- Inherit: All 10 routes wrapped by `src/App.jsx`
- Verify: `TopNav` holiday yellow-card badge (`#tbClockHolidayBadge`), `DirectMoneyInput` inline editing, PWA standalone mode (`isStandalone`), and mobile `< 960px` bottom dock safe-area clearance
- Exclude: Internal layout of `BoardPage.jsx` (Phase 2) and internal inline styles of `TradePage.jsx` / `LedgerSection.jsx` / `DiagnosisPage.jsx` (Phase 3)

## Validation

- Product: Navigate across all 10 routes via left rail (desktop) and bottom dock (mobile), edit total assets/cash inline in `#tbAccPill`, open `TradingClockModal` via `#tbClockPill`, toggle dark/light theme, and trigger 15:05 EOD modal.
- Interface: Test at `1440×900` (expanded & collapsed rail), `1024×768`, and `390×844` (iPhone PWA viewport with `safe-area-inset-bottom`); verify all icon-only buttons expose `aria-label` and visible `:focus-visible` rings, and Escape closes the overflow menu.
- System: Confirm `SideRail` and `TopNav` consume only Phase 0 semantic CSS variables (`var(--bg)`, `var(--card)`, `var(--line)`, `var(--info)`, `var(--warn)`, `var(--up)`, `var(--down)`) with zero inline hex color literals.
- Repository: `TZ=America/New_York npm run test:calendar && npm run test:backend && npm run build` → 266 assertions pass, 28 backend tests pass, static build succeeds.

## Stop conditions

- Stop if index quote symbols (`sh000001`, `sz399001`, `sz399006`, `sh000688`) return an incompatible payload shape from `fetchQuotes` without a small parser adapter in `src/services/api.js` (verify payload shape first before rendering the mini-index board).

## Design documentation

- After acceptance and validation: Record `.app-shell` breakpoint (`960px`), left-rail width tokens (`208px` / `56px`), and `Icons.jsx` stroke rules (`1.5px` default, `2px` active) in `DESIGN.md` under `Layout` and `Components`.
