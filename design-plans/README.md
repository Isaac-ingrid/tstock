# tstock 量化终端 UI 焕新执行设计单索引（基于 `ui-skills`）

基准提交：`8af01a9`  
适用规范：`ui-skills`（`improve-ui` / `plan-template.md`、`create-design-md`、`baseline-ui`、`fixing-motion-performance`、`fixing-accessibility`、Playbook 46 条设计工程准则）

## 审计基线摘要（Design language）

- **Audited surface**: `tstock` Web / PWA 交易终端（`app/layout.jsx` → `src/App.jsx` → `NAV_ROUTES` 十个核心路由视图）
- **Design sources**: `css/style.css`（`:root` 色彩与排版基础令牌）、`css/nav.css`（双行吸顶导航栏与卡片紧凑布局）、`css/anim.css`（过渡与反馈动效）、用户指定的现代暗色量化看板视觉参照
- **Documented decisions**:
  - A 股方向色语义隔离：涨红（`--up`）与跌绿（`--down`）仅用于价格、金额、比例与 K 线，不承担系统结论或装饰职责（见 `css/style.css` 第 11–14 行注释契约）
  - 判定色与方向色色相分离：系统风控/止损/陈旧警示使用琥珀色（`--warn`），与涨红保持色相间距（见 `css/style.css` 第 15–17 行）
  - 页面文案不自造生僻动词，选股产出（`data/`）与个人持仓台账（`localStorage` + `/api/user_vault`）严格解耦（见 `README.md` 两条硬约定）
- **Governing owners and consumers**:
  - 全局样式与令牌持有者：`app/layout.jsx`、`css/style.css`、`css/nav.css`、`css/anim.css`
  - 路由与导航持有者：`src/data/site.js`（`NAV_ROUTES`）、`src/router/useRoute.js`、`src/components/TopNav.jsx`、`src/App.jsx`
  - 视图消费端：`src/views/TradePage.jsx`、`BoardPage.jsx`、`IgnitionPage.jsx`、`TailPage.jsx`、`DiagnosisPage.jsx`、`AccountPage.jsx`、`LedgerPage.jsx`、`PerfPage.jsx`、`RulesPage.jsx`
- **Explicit exceptions**: None documented

## 独立执行设计单列表与依赖顺序

每份设计单均严格按照 `improve-ui/references/plan-template.md` 编写，保持完全自包含（执行 Agent 无需依赖历史对话上下文即可独立实施与验收）：

| 阶段序号 | 设计单文件 | 作用域与核心目标 | 前置依赖 |
| :--- | :--- | :--- | :--- |
| **Phase 0** | [`phase-0-design-system-and-tokens.md`](./phase-0-design-system-and-tokens.md) | 创建根目录 `DESIGN.md` 权威契约；升级 `css/style.css` 为黑曜石暗色默认 + 浅色可切换双态语义令牌；落地全站 `tabular-nums` 等宽数字与同心圆角尺度 | 无（首个基础设施阶段） |
| **Phase 1** | [`phase-1-app-shell-and-navigation.md`](./phase-1-app-shell-and-navigation.md) | 桌面端重构为「左侧 `208px` 可折叠导航栏（含常驻迷你指数盯盘与日/夜切换）+ 顶部 `44px` 单行状态条」；移动端适配 `100dvh` 与底部安全区触控栏；用 `1.5px` 线性 SVG 图标替代导航 Emoji，纯色遮罩替代全屏毛玻璃 | Phase 0 |
| **Phase 2** | [`phase-2-board-bento-dashboard.md`](./phase-2-board-bento-dashboard.md) | 将 `#/board`（连板与情绪看板）重构为一屏高密度等高 Bento 网格（4 指数卡 + 6 广度卡 + 4 列核心图表/梯队进度条 + 题材热度与右侧实时信号流），接入等比例结构骨架屏 | Phase 0、Phase 1 |
| **Phase 3** | [`phase-3-trade-surfaces-token-convergence.md`](./phase-3-trade-surfaces-token-convergence.md) | 压缩 `#/trade` 顶部多层盘前/情绪/仓位横幅为紧凑量化指标带；清除 `src/` 内 1,359 处硬编码浅色 Hex、紫色渐变横幅与装饰发光；收敛个股作战卡、210 日筹码诊断、台账、账户与弹窗双主题表现 | Phase 0、Phase 1 |

## 全局安全门禁（所有阶段通用）

1. **零业务逻辑回归**：每阶段收尾必须通过 `TZ=America/New_York npm run test:calendar`（266 项断言）、`npm run test:backend`（28 项后端单元测试）与 `npm run build`（Next.js 静态导出构建）。
2. **零外部重型 UI 依赖**：不引入第三方组件库或新动画引擎，保持现有 `next` + `react` 极简包体积与云服务器低内存编译稳定性。
