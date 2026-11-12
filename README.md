# A股做T工作台

选股 → 做T执行 → 台账回算的工具链。前端使用 Next.js 静态导出，股票行情由独立 FastAPI 后端统一获取。

## 目录

```
app/                          Next.js App Router 入口
src/                          React 交易工作台源码
backend/app.py                独立股票数据后端（FastAPI）
data/latest.json              统一数据契约（纯 JSON，给脚本读）
data/latest.js                window.WB_LATEST = {...}（给页面读）
选股引擎/                      Node 脚本与流水线
docs/                         方法论、口径与部署配置
deploy.sh                     静态前端与数据文件部署
out/                          npm run build 生成的静态站点
```

## 本地开发

```bash
# 首次安装后端依赖
cd backend
uv venv --python 3.12
uv pip install -r requirements.txt
cd ..

# Windows 一键启动全部本机服务（后端 18765 + 前端 3000 + 定时调度器）
.\start.bat
# 一键停止本机服务 / 查看状态
.\stop.bat
npm run status:local

# 也可分终端手动启动：
# 后端（项目根目录执行）
npm run backend

# 前端（另一个终端，项目根目录执行）
cp .env.example .env.local
npm install
npm run dev
```

前端账户、持仓和台账仍保存在浏览器 `localStorage`；股票检索、行情、K线、分时、逐笔和估值请求统一经过后端。

## 本地跑批

收盘后（或 15:10 自动任务触发）在 `选股引擎/` 下按顺序执行：

```
node engine.js      → node returns.js   → node report.js
node plan.js        → node plan-report.js → node dashboard.js
node publish.js
```

周五追加 `node steady.js` 与 `node steady-report.js`，之后必须再跑一次
`publish.js`。也可以直接 `node run_all.js` 一次跑完（周五自动带上 steady）。

**注意**：`engine.js` 会静默复用当日缓存 `out/snapshot-<日期>.json`。
盘前跑过一次后，收盘重跑必须加 `--force`，否则会吃盘前残值且不报错。

## 更新线上站点

前端是 Next.js `output: 'export'` 生成的纯静态站点，nginx 同时将 `/stock-api/` 反向代理到独立 FastAPI 服务。

```
bash deploy.sh              # 全量同步
bash deploy.sh --data-only  # 只传 data/（每个交易日最常用）
bash deploy.sh --dry-run    # 只看会传什么，不实际传输
bash deploy.sh --soft       # 失败不返回非零（给自动化用）
```

### 前置：SSH 免密

自动化跑批时无法交互输密码，必须先配公钥。

```
# 本机公钥（已生成）
cat ~/.ssh/id_ed25519_tstock.pub

# 服务器上执行
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<上面那行公钥>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

站点目录默认自动探测（读 nginx 配置里的 `root`）；探测不到时显式指定：

```
DEPLOY_DIR=/实际路径 bash deploy.sh
DEPLOY_USER=ubuntu bash deploy.sh
```

### 校验

`deploy.sh` 传完会回读 `http://115.29.164.8/data/latest.js`，
比对 `tradeDate` 与字节数。不一致直接报错退出，不会假装成功。

## 服务器侧

`docs/deploy_nginx.conf` 是一份可直接替换的站点配置，主要处理这些事情：

1. `location ~ /\. { deny all; }` —— 挡住 `.git` 与 `.env`。
2. `/stock-api/` —— 反向代理到 `127.0.0.1:8000` 的 FastAPI 服务。
3. `gzip on` —— 压缩数据契约与前端资源。
4. `data/` 与 `*.html` 走 `no-cache`，`/_next/static/` 使用哈希长缓存。

应用：

```
cp docs/deploy_nginx.conf /etc/nginx/sites-available/tstock
# 改其中的 root 为实际站点目录
ln -sf /etc/nginx/sites-available/tstock /etc/nginx/sites-enabled/tstock
nginx -t && systemctl reload nginx
```

## 两条硬约定

1. **引擎产出只写 `data/`，手记持仓只写 `localStorage`。** 两者不能混——
   某天引擎跑挂不应把持仓一起丢掉。执行台顶栏「导出」可备份后者。
2. **页面文案不自造动词。** 用用户已有心智的词（加入自选），不发明（并入）。

## 免责

研究工具，输出不构成投资建议。
