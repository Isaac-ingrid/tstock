# Rebuild Market & Limit-Up Board into Zero-Scroll Quantitative Bento Grid (Phase 2)

Written against: 8af01a9

## Evidence chain

- Surface: `#/board` (`src/views/BoardPage.jsx`, `src/components/MarketSentimentBar.jsx`, `src/components/board/StrongPoolPanel.jsx`, `src/components/board/HerdPoolPanel.jsx`, `src/components/board/MainThemesPanel.jsx`, and `src/components/board/boardShared.jsx`)
- Problem:
  1. `BoardPage.jsx` stacks full-width panels vertically with verbose prose headers, mixed pill filters, and 200+ inline light-theme hex styles, forcing multi-screen vertical scrolling before the user can correlate market breadth, emotion score, limit-up ladder height, and leading themes.
  2. Loading states rely on plain text / spinner placeholders rather than structural skeletons matching card geometry, causing layout jumps (`CLS`) when `/api/stock/limitup_pool` resolves.
  3. Empty filter states (e.g., non-trading morning or strict multi-tag filter returning 0 stocks) display passive text without a single clear recovery action.
- Design evidence: `src/views/BoardPage.jsx` lines 1–90, `src/components/MarketSentimentBar.jsx` lines 1–60, user-provided dark quantitative `市场看板` reference screenshot (Row 1: 4 index cards; Row 2: 6 breadth KPI cards; Row 3: 4 equal-height visual cards—breadth histogram, 6-axis emotion radar, trend/broken-seal matrix, and horizontal limit-up ladder bars; Row 4: leading concept/industry heat columns + live monitor stream), and `ui-skills` rules (`playbook.ts` `group-with-space-not-lines`, `use-structural-skeletons`, `give-empty-states-one-action`, `clamp-overflowing-titles`, `use-tabular-nums-for-data`).
- Owner: `src/views/BoardPage.jsx`, `src/components/MarketSentimentBar.jsx`, and `src/components/board/*`
- Scope and affected surfaces: `#/board` view and `MarketSentimentBar` (`compact` variant shared with `#/trade`)
- Uncertainty: If `/api/stock/limitup_pool` does not include full-market 8-bucket advance/decline histogram counts on historical replay dates, the breadth card must gracefully fall back to rendering the verified `涨停 / 跌停 / 炸板 / 连板晋级` bar distribution returned by `data.sentiment` and `data.ladder` without inventing unretrieved numbers.

## Design decision

Restructure `BoardPage.jsx` into a responsive, equal-height 12-column Bento dashboard (`gap: 10px`) governed by Phase 0 semantic tokens: a top market-pulse strip (4 index cards + 6 breadth/emotion KPI cells), a middle 4-card analytical Bento row (`涨跌/封板广度柱状条`, SVG `六维情绪雷达`, `盘中监控六宫格`, and `涨停梯队横向进度条` with clickable tier drill-down), and a bottom split workspace pairing `题材/强势抱团热度排行` on the left with a compact `实时异动/炸板/字辈共振监控流` on the right—backed by geometry-matched structural skeletons and one-click empty-state filter reset.

## Reuse

- `fetchLimitUpPool` & `postHerdAction` (`src/services/api.js`) — preserve all existing API calls, 60-second / auto-refresh timers, historical date picker (`boardDate` bounded by `todayStr()`), and `BoardStockActions` (`加入自选`, `直达诊股`, `起爆联动`).
- `MarketSentimentBar.jsx` — refactor to support two clean token-driven variants: `variant="bento"` (used inside `BoardPage`) and `variant="strip"` (single-line compact risk valve used at the top of `TradePage`), sharing one emotion-tier calculation owner.
- Phase 0 semantic tokens (`var(--card)`, `var(--surface)`, `var(--line)`, `var(--up)`, `var(--down)`, `var(--warn)`, `var(--info)`, `.num-mono`) and Phase 1 `Icons.jsx`.

## Changes

1. `src/views/BoardPage.jsx` & new scoped stylesheet rules in `css/style.css` (`.bento-board-*`)
   - Change:
     - Top toolbar: Single-row header bar with `市场看板` title, live emotion badge (`冰点 / 混沌 / 回暖 / 主升 / 高潮` + numeric score), Beijing date selector (`input[type="date"]`), `实时/暂停` toggle, `重载` button, and sub-view tab switcher (`全景看板` | `连板天梯明细` | `强势股池` | `抱团跟踪`).
     - Bento Row 1 & 2 (Market Pulse): 4-column index summary (`上证指数`, `深证成指`, `创业板指`, `科创综指`) + 6-column KPI strip (`涨停/跌停`, `封板率/炸板`, `最高连板` + leader names, `连板晋级率`, `主线最强题材`, `建议仓位上限`), all rendered in `tabular-nums` with zero decorative gradients.
     - Bento Row 3 (4 Equal-Height Visual Cards, `grid-template-columns: repeat(4, minmax(0, 1fr))` on `>= 1200px`, `repeat(2, 1fr)` on tablet, `1fr` on mobile):
       1. `涨跌与封板广度`: Vertical mini-bars + horizontal red/green ratio bar.
       2. `情绪雷达`: Pure inline SVG hexagon radar (`指数 / 主线 / 赚钱 / 量能 / 投机 / 抗跌`) computed deterministically from `sentiment` metrics, displaying the composite score at center.
       3. `盘中风控监控`: 2×3 mini-grid (`炸板数`, `跌停数`, `封板率`, `首板数`, `2板+接力数`, `高标淘汰预警`).
       4. `涨停梯队`: Horizontal proportional bars for `4板+`, `3板`, `2板`, `首板` listing top leader names (`truncate` fade) and clicking through to filter the detail table below.
     - Bento Row 4 (Themes + Actionable Pool / Signal Stream): Left 8 columns render `MainThemesPanel` / `StrongPoolPanel` / `HerdPoolPanel` with clean neutral borders; right 4 columns render real-time limit-up / broken-seal / mystic-cluster signal cards with one-click `BoardStockActions`.
     - Structural Skeletons & Empty States: Render fixed-height `.bento-skeleton` blocks while `loading && !data`, and render a single `重置筛选条件` action button whenever active filters return zero stocks.
   - Preserve: All filter states (`filterTier`, `onlyMainboard`, `selectedTheme`, `searchKw`, `strongSelectedTags`, `herdHealthFilter`, `mysticRoots`), `buildDailyReviewBrief` copy action, and `postHerdAction` mutations.
   - Verify: Above-the-fold at `1440×900` displays Rows 1–3 completely without scrolling; zero layout shift occurs when switching `boardDate`.

2. `src/components/MarketSentimentBar.jsx`
   - Change: Replace inline light-theme background banners and Emoji headers with semantic token classes (`.msb-strip`, `.msb-bento`), keeping status communication paired with both text labels and subtle semantic dot/badge indicators (`pair-status-with-labels`).
   - Preserve: `externalSentiment`, `compact`, and `onSentimentChange` prop contract used by `TradePage.jsx`.
   - Verify: Renders cleanly in both `dark` and `light` themes across `#/board` and `#/trade`.

3. `src/components/board/MainThemesPanel.jsx`, `StrongPoolPanel.jsx`, `HerdPoolPanel.jsx`, `boardShared.jsx`
   - Change: Replace hard-coded light hex backgrounds/borders (`#f8fafc`, `#fff1f2`, `#fef3c7`, `#eef2ff`, etc.) with `var(--card)`, `var(--surface)`, `var(--line)`, `var(--up-bg)`, `var(--down-bg)`, and `var(--warn-bg)`; apply `.num-mono` to all prices, seal amounts, and board counts; clamp overflowing theme/stock tags cleanly.
   - Preserve: All sorting, resonance tag toggles, sector grouping, and stock action callbacks.
   - Verify: Switching between `dark` and `light` themes leaves zero bright white islands or low-contrast text.

## Scope

- Inherit: `#/board` and `MarketSentimentBar` on `#/trade`
- Verify: Historical replay date selection (`boardDate`), mobile single-column stacking (`390px`), and `BoardStockActions` (`加入自选` / `诊股`)
- Exclude: `IgnitionPage.jsx`, `TailPage.jsx`, `TradePage.jsx` stock battle cards, `DiagnosisPage.jsx`, `LedgerPage.jsx`, `AccountPage.jsx`, and `RulesPage.jsx` (covered in Phase 3)

## Validation

- Product: Open `#/board`, inspect live & historical limit-up data, click a ladder tier (`3板`) to filter stocks, toggle `仅看主板`, copy daily review brief, and add a candidate to watchlist.
- Interface: Verify 4-column Bento alignment at `1440×900`, 2-column wrap at `1024×768`, and 1-column stack at `390×844`; verify structural skeleton matches loaded card heights and empty filter state shows `重置筛选条件`.
- System: Confirm `grep -rnE '#[0-9a-fA-F]{3,6}' src/views/BoardPage.jsx src/components/board/ src/components/MarketSentimentBar.jsx` contains zero un-tokenized background/text hex literals outside SVG chart data palettes.
- Repository: `TZ=America/New_York npm run test:calendar && npm run test:backend && npm run build` → 266 assertions pass, 28 backend tests pass, static build succeeds.

## Stop conditions

- Stop if any metric displayed in the 6-axis emotion radar cannot be derived deterministically from existing `/api/stock/limitup_pool` fields (`sentiment`, `ladder`, `themes`, `zbPool`)—omit any unsupported axis rather than fabricating synthetic scores.

## Design documentation

- After acceptance and validation: Document `.bento-grid` spacing (`10px` gap, `12px` card padding) and structural skeleton conventions in `DESIGN.md` under `Layout` and `Components`.
