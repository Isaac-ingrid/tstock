# Deslop Trade Workbench and Converge Inline Surface Styles to Semantic Tokens (Phase 3)

Written against: 8af01a9

## Evidence chain

- Surface: `#/trade` (`src/views/TradePage.jsx`, `src/components/PreMarketPanel.jsx`, `src/components/PositionRiskBar.jsx`, `src/components/ConsoleSection.jsx`, `src/components/BattleCardGrid.jsx`, `src/components/StockCard.jsx`, `src/components/SelectionSection.jsx`) and secondary workbench views (`IgnitionPage.jsx`, `TailSection.jsx`, `DiagnosisPage.jsx`, `LedgerSection.jsx`, `AccountSection.jsx`, `PerfPage.jsx`, `RulesSection.jsx`, `PostMarketModal.jsx`, `Modals.jsx`)
- Problem:
  1. `TradePage.jsx` stacks four full-width horizontal banners before stock cards appear (`MarketSentimentBar` + `PreMarketPanel` + `PositionRiskBar` + a purple-gradient cross-board promo banner `background: 'linear-gradient(90deg, #18181b, #271b30)'` at `TradePage.jsx` lines 134–188), pushing actionable T+0 buy/sell levels down the viewport.
  2. Across `src/`, there are 2,340 inline `style={{...}}` blocks and 1,359 hard-coded light-mode hex literals (`#f0f9ff`, `#fffbeb`, `#fff5f5`, `#f8fafc`, `#1e293b`, `#4f46e5`, `#7c3aed`), which create jarring bright-white / neon-tinted blocks on dark terminal surfaces and violate single-accent discipline.
  3. Horizontal stock switcher strips (`.pool-tabs .pt-scroll`) and dense tables lack consistent `tabular-nums` alignment, inline field-adjacent validation placement, and clean outline SVG iconography.
- Design evidence: `src/views/TradePage.jsx` lines 70–205, `css/style.css` lines 60–90 (`.pool-tabs` edge-fade mask exemplar), quantitative scanning audit (`2,340` inline styles, `1,359` hex literals, `90` gradients/glows), and `ui-skills` rules (`baseline-ui` deslop constraints, `limit-accent-color-usage`, `use-tabular-nums-for-data`, `show-errors-beside-fields`, `confirm-destructive-actions`, `use-solid-modal-scrims`, `fade-scroll-edges`, `peek-the-next-scroll-item`).
- Owner: `src/views/TradePage.jsx` and the surface component owners under `src/components/*` and `src/views/*`
- Scope and affected surfaces: All trading, diagnosis, tail, ignition, ledger, account, rules, and modal surfaces in `src/`
- Uncertainty: SVG canvas/chart colors inside `src/services/chart.js` (intraday chart & 5-level orderbook wall) and `CyqFlameChart` (`src/views/DiagnosisPage.jsx`) render via SVG attributes/canvas rather than CSS inheritance—must read `document.documentElement.dataset.theme` (or CSS custom properties via `getComputedStyle`) so chart gridlines, crosshair labels, and orderbook walls adapt cleanly in both `dark` and `light` modes.

## Design decision

Compress the stacked banners at the top of `#/trade` into a unified, single-row quantitative Telemetry Strip (merging emotion gate, pre-market auction/holiday status, and dual-track base/tactical position watermarks into equal-height Bento KPI cells with expandable drawers for multi-item details, while removing the decorative purple-gradient promo banner in `TradePage.jsx`), and systematically replace hard-coded light-mode hex literals across `StockCard`, `BattleCardGrid`, `DiagnosisPage`, `LedgerSection`, `AccountSection`, `TailSection`, `IgnitionPage`, `PerfPage`, `RulesSection`, and `Modals` with Phase 0 semantic CSS classes and theme-aware SVG chart tokens.

## Reuse

- Existing horizontal scroll mask exemplar in `css/style.css` lines 66–68 (`.pool-tabs .pt-scroll.has-more` `mask-image` edge fade) — extend with `16–24px` next-item peek padding (`peek-the-next-scroll-item`).
- All existing domain services (`src/services/risk.js`, `calendar.js`, `eod.js`, `ledger.js`, `tail.js`, `auction.js`, `chart.js`) — preserve 100% of business formulas, holiday cap watermarks (`<= 30%` / `<= 50%`), T+1 lock calculations, and pre-trade confirmation guards.
- Phase 0 semantic CSS variables (`var(--card)`, `var(--surface)`, `var(--surface2)`, `var(--line)`, `var(--text)`, `var(--sub)`, `var(--mute)`, `var(--up)`, `var(--up-bg)`, `var(--down)`, `var(--down-bg)`, `var(--warn)`, `var(--warn-bg)`, `var(--info)`, `var(--info-bg)`, `.num-mono`) and Phase 1 `Icons.jsx`.

## Changes

1. `src/views/TradePage.jsx`, `src/components/PreMarketPanel.jsx`, & `src/components/PositionRiskBar.jsx`
   - Change:
     - Combine `MarketSentimentBar` (`variant="strip"`), `PreMarketPanel`, and `PositionRiskBar` into a cohesive `.trade-telemetry-grid` (4 compact equal-height Bento cells on desktop: `市场情绪与仓位总阀`, `底仓 / 机动双轨水位条`, `节假日与集合竞价定盘窗口`, `持仓公告排雷与熔断状态`; clicking any cell expands its detail drawer inline without pushing the page down permanently).
     - Remove the decorative `linear-gradient(90deg, #18181b, #271b30)` cross-board banner in `TradePage.jsx` lines 134–188 (since `起爆挖掘` and `连板打板` are already permanently accessible one click away in the Phase 1 `SideRail`, and per-stock jump actions remain on each card).
   - Preserve: All holiday countdown / pre-holiday yellow-card warnings, tilt-lock unlock/relock actions, `posRules` customization modal, and announcement risk badges (`noticeRisks`).
   - Verify: On `1440×900`, `BattleCardGrid` / active `StockCard` buy-sell points appear immediately in the upper half of the first screen without scrolling.

2. `src/components/ConsoleSection.jsx`, `src/components/BattleCardGrid.jsx`, `src/components/StockCard.jsx`, `src/components/SelectionSection.jsx`, & `src/services/chart.js`
   - Change:
     - Replace inline light-only hex fills/borders on battle cards, 7-grid box levels, orderbook 5-level walls, leading-resonance kinetic bars, and selection tables with semantic CSS classes (`.surface-card`, `.surface-subtle`, `.pill-up`, `.pill-down`, `.pill-warn`, `.pill-info`).
     - Enforce `.num-mono` (`tabular-nums`) on every price, grid target (`inA`, `outA`, `tp1`, `slA`), breakeven price, share count, volume ratio, and orderbook volume column.
     - Update `src/services/chart.js` intraday SVG/Canvas palette helper to resolve gridlines, session dividers, VWAP line, OBV subchart, and tooltip surfaces from active `data-theme` (`dark` vs `light`).
   - Preserve: Point-and-click orderbook price fill, `QuickTModal` pre-trade holiday guard confirmation, single-stock battle plan copy, and `resolveStockTier` mutual-exclusion logic.
   - Verify: Real-time 8-second quote refreshes cause zero horizontal digit jitter; intraday chart and 5-level orderbook are crisp and high-contrast in both themes.

3. `src/views/DiagnosisPage.jsx`, `src/views/IgnitionPage.jsx`, `src/components/TailSection.jsx`, & `src/views/PerfPage.jsx`
   - Change:
     - Convert inline light hex cards in `DiagnosisPage.jsx` (including `CyqFlameChart` SVG background, gridlines, holding-cost line, and T-breakeven line labels), `IgnitionPage.jsx`, `TailSection.jsx`, and `PerfPage.jsx` to semantic theme variables.
     - Add structural loading skeletons during diagnosis / scan fetches and ensure empty states (such as `#/diagnosis` initial idle state before searching a code) present clean focused search input + quick-pick chips for current holdings (`give-empty-states-one-action`).
   - Preserve: `#/diagnosis` idle-on-entry behavior until `?code=` or explicit search, 210-day turnover-decay CYQ flame rendering, `wechatSummary` copy format, and tail 14:30–14:55 buy-guard confirmation.
   - Verify: `CyqFlameChart` flame bars, cost line, and T-breakeven line maintain clear visual contrast in both `dark` and `light` themes.

4. `src/components/LedgerSection.jsx`, `src/components/AccountSection.jsx`, `src/components/RulesSection.jsx`, `src/components/PostMarketModal.jsx`, & `src/components/Modals.jsx`
   - Change:
     - Migrate remaining inline `#fff*` / `#f8fafc` / `#fef3c7` / `#f0f9ff` styles in ledger tables, coach modal, account net-value curve & pre-holiday watermark ruler, rules manual cards, `TradingClockModal`, `QuickTModal`, and `PostMarketModal` to semantic CSS classes.
     - Place inline validation hints directly adjacent to form inputs in `LedgerSection.jsx` and `QuickTModal` (`show-errors-beside-fields`), ensure every modal traps/restores focus and closes on `Escape` over a solid `--scrim-solid` backdrop (`use-solid-modal-scrims`), and require explicit confirmation on destructive actions (`删除记录`, `重置默认股池`).
   - Preserve: Single-sided `底仓建仓 / 尾盘买入` (`sell` optional) ledger submission, `pre_holiday_overcap` audit tags, 15:05 EOD 5-step archive workflow, and account holiday watermark line.
   - Verify: Every modal and secondary route renders cohesively in both `dark` and `light` modes with zero raw light-hex bleed-through.

## Scope

- Inherit: `#/trade`, `#/ignition`, `#/tail`, `#/diagnosis`, `#/account`, `#/ledger`, `#/perf`, `#/rules`, `#/all`, and all global modals
- Verify: `chart.js` intraday rendering, `CyqFlameChart` SVG rendering, `QuickTModal` & `LedgerSection` form validation, and `AccountSection` holiday watermark chart
- Exclude: Standalone static HTML report generators under `选股引擎/*.html` (separate offline report artifacts outside the Next.js app shell)

## Validation

- Product: Walk through a complete intraday T+0 workflow across `#/trade` → `QuickTModal` → `#/diagnosis` → `#/tail` → `#/ledger` (manual `底仓建仓` & closed `正T`) → `PostMarketModal` → `#/account` → `#/rules` in both `dark` and `light` themes.
- Interface: Verify at `1440×900` and `390×844` that `#/trade` shows battle cards above the fold, digits remain tabular-aligned during live refresh, modals use solid scrims and close via `Escape`, and zero bright white boxes appear in dark mode.
- System: Verify JSX inline hex count (`grep -rnE '#[0-9a-fA-F]{3,6}' src/`) drops by `> 90%` (retaining only intentional SVG data-series strokes where CSS variables are resolved via helper), and zero multicolor decorative gradients remain.
- Repository: `TZ=America/New_York npm run test:calendar && npm run test:backend && npm run build` → 266 frontend/calendar assertions pass, 28 backend tests pass, and Next.js static export builds cleanly.

## Stop conditions

- Stop if refactoring any inline style in `StockCard.jsx`, `LedgerSection.jsx`, `AccountSection.jsx`, or `Modals.jsx` alters a DOM `id`, data calculation, or export signature asserted by `timing_task/test_trade_calendar.js`.

## Design documentation

- After acceptance and validation: Update `DESIGN.md` with finalized telemetry-strip patterns and SVG chart theme-token binding conventions.
