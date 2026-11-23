# A股做T工作台

选股 → 做T执行 → 节前与盘中风控 → 台账复盘闭环的工具链。前端使用 Next.js 静态导出（`output: 'export'`），股票实时行情、筹码诊断、复盘教练与多用户金库由独立 FastAPI 后端统一提供。

## 目录结构

```
app/                          Next.js App Router 入口
src/                          React 交易工作台源码（盘前/盘中/尾盘/诊断/台账/账户/纪律）
backend/                      独立股票数据、210日筹码峰、复盘教练与金库后端（FastAPI）
backend/tests/                Python 后端单元测试套件（日历、筹码峰、形态、金库、教练）
data/latest.json              统一数据契约（纯 JSON，供脚本与后端读取）
data/latest.js                window.WB_LATEST = {...}（供前端页面直接挂载）
data/trade_calendar.json      2024–2027 沪深北法定节假日与休市统一日历源
timing_task/                  交易时段定时任务调度器与前端/日历全链路回归测试
选股引擎/                      Node 选股流水线与收益回算脚本
scripts/local-service.mjs     跨平台（macOS / Windows）本机一键启停管理脚本
scripts/server-update.mjs     云服务器本机一键拉码、保护跟踪池、重启后端与发布自检脚本
docs/                         方法论、口径、systemd 服务单元与 Nginx 部署模板
deploy.sh                     智能双模态（服务器本机直同步 / 开发机 SSH 推送）部署脚本
out/                          npm run build 生成的纯静态站点产物
```

## 本地开发与启停

```bash
# 1. 首次安装前后端依赖
npm install
cd backend
uv venv --python 3.12
uv pip install -r requirements.txt
cd ..

# 2. 跨平台一键后台启动（后端 18765 + 前端 3000 + 定时调度器，支持 macOS / Windows）
npm run start:local
npm run status:local
npm run stop:local

# Windows 也可直接使用批处理脚本
.\start.bat
.\stop.bat

# 3. 分终端手动调试启动（macOS / Linux）
python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 18765 --reload
# 另开终端启动前端开发服
cp -n .env.example .env.local
npm run dev

# 4. 定时调度器单独管理
npm run timer:start
npm run timer:status
npm run timer:stop
```

前端账户、持仓和台账采用浏览器 `localStorage` 与后端用户金库（`/api/user_vault` 原子落盘与多用户隔离）双写机制，顶栏亦支持手工导入/导出备份。

## 本机回归测试与构建校验

修改日历、仓位风控、做T台账、筹码诊断或前端组件后，在项目根目录运行以下命令完成全量验证：

```bash
# 1. 前端与调度器全链路回归测试（交易日历、节前分档控仓、台账审计、盘后归档等 266 项断言）
npm run test:calendar
# 或直接执行：node timing_task/test_trade_calendar.js

# 2. 跨时区（模拟北美美东时区 -> 北京时间 UTC+8 对齐）回归测试
TZ=America/New_York node timing_task/test_trade_calendar.js

# 3. Python 后端全量单元测试（210日筹码峰、法定节假日推导、K线形态、多用户金库、复盘教练等 28 项测试）
npm run test:backend
# 或直接执行：python3 -m unittest discover -s backend/tests -p "test_*.py" -v

# 4. 静态资源同步（latest.js / latest.json / trade_calendar.json）与 Next.js 生产构建校验
npm run build

# 一键串行跑完双时区回归 + 后端单测 + 生产构建
TZ=America/New_York node timing_task/test_trade_calendar.js && python3 -m unittest discover -s backend/tests -p "test_*.py" -v && npm run build
```

## 本地选股跑批

收盘后（或交易日 15:10 自动调度任务触发，周末与法定节假日自动跳过）在 `选股引擎/` 下按顺序执行：

```bash
node engine.js      # 盘后重跑需加 --force，避免复用盘前 out/snapshot-<日期>.json 缓存
node returns.js
node report.js
node plan.js
node plan-report.js
node dashboard.js
node publish.js
```

每周收官交易日（通常为周五，遇法定节假日自动提前至节前最后交易日）追加 `node steady.js` 与 `node steady-report.js`，随后再执行一次 `node publish.js`；也可直接运行 `node run_all.js` 一次跑完。

## 服务器部署与线上更新

线上采用 Next.js 静态站点（落地于 `/root/tstock/dist`）配合 Nginx `:80` 服务，并将 `/stock-api/` 反向代理至本机 `127.0.0.1:8000` 的 FastAPI 服务（`tstock-api.service`）。

### 方式一：登录云服务器本机一键更新（推荐日常发版）

在服务器 `/root/tstock` 目录下直接执行，脚本会自动备份线上实时跟踪池与策略账本、拉取最新 `origin/main`、按需安装新增依赖、重启 `tstock-api`、构建前端同步至 `dist/`，并完成 `8000` 与 Nginx `80` 双链路健康自检：

```bash
cd /root/tstock
npm run update:server                 # 或 bash deploy.sh --update（全流程拉码 + 重启后端 + 构建发布 + 自检）
npm run update:server -- --data-only  # 仅快速同步 data/ 选股契约，免重新编译前端
npm run update:server -- --force-deps # 强制重新执行 npm install 与 pip install
```

### 方式二：本地开发机远程 SSH 推送或本机指定模式发布

`deploy.sh` 会自动识别当前处于云服务器本机（免 SSH 直同步 `out/ -> dist/`）还是本地开发机（单连接 SSH 管道推送并逐文件校验字节数与 `tradeDate`）：

```bash
bash deploy.sh              # 全量构建并发布（自动识别本机或远程 SSH）
bash deploy.sh --data-only  # 仅同步 data/latest.js 与 data/latest.json
bash deploy.sh --dry-run    # 仅预演打印待同步文件清单，不实际写入
bash deploy.sh --local      # 强制本机同步模式 (out/ -> dist/)
bash deploy.sh --remote     # 强制远程 SSH 推送模式
bash deploy.sh --soft       # 失败不返回非零退出码（供自动化定时任务容灾使用）
```

若开发机首次远程推送，需预先配置 SSH 免密公钥（默认读取 `~/.ssh/id_ed25519_tstock`），必要时可通过环境变量覆盖目标参数：

```bash
DEPLOY_DIR=/root/tstock/dist DEPLOY_USER=root bash deploy.sh
```

### 服务器 Nginx 与 Systemd 首次部署 / 模板变更同步

注意：`npm run update:server` 不会自动覆盖系统级 `/etc/nginx/` 与 `/etc/systemd/` 配置。首次装机或修改 `docs/deploy_nginx.conf`、`docs/tstock-api.service` 后，请在云服务器上手动同步一次：

1. **Systemd 后端常驻服务（`127.0.0.1:8000`）**：

```bash
cp /root/tstock/docs/tstock-api.service /etc/systemd/system/tstock-api.service
systemctl daemon-reload
systemctl enable --now tstock-api
systemctl status tstock-api
```

2. **Nginx `:80` 站点配置（`/etc/nginx/sites-available/default`）**：
   - 同机 `443` 端口运行有 Otto 服务，`80` 端口保持 `server_name _;`，切勿在 `80` 端口绑定裸 IP。
   - `location ^~ /.well-known/acme-challenge/` 前缀优先放行同机 Otto 短期 IP 证书续期校验（根目录 `/var/www/letsencrypt`），紧随其后的 `location ~ /\. { deny all; }` 严密拦截 `.git` 与 `.env` 等其余隐藏文件。
   - `/stock-api/` 反向代理至 `127.0.0.1:8000`（90 秒超时兼容起爆扫描、尾盘扫描与复盘教练）。
   - `/data/`、`/sw.js`、`/manifest.json` 与 `*.html` 走 `no-cache`，`/_next/static/` 走哈希长缓存。

```bash
mkdir -p /var/www/letsencrypt
cp /root/tstock/docs/deploy_nginx.conf /etc/nginx/sites-available/default
ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 两条硬约定

1. **选股引擎产出只写 `data/`，个人实盘持仓与台账只走用户金库与 `localStorage`。** 两者严格解耦——某天选股跑批异常绝不影响实盘持仓与台账记录。
2. **页面文案不自造生僻动词。** 统一使用符合交易直觉的词汇（如「加入自选」「底仓建仓」「节前控仓」）。

## 免责

研究与个人复盘辅助工具，所有输出不构成投资建议。
