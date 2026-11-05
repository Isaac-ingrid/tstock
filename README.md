# A股做T工作台

选股 → 做T执行 → 台账回算的本地工具链，外加一个部署在云服务器上的只读看板。

## 目录

```
index.html                    今日作战台（只读 data/latest.js）
做T执行台.html                 盘中执行台（账户与台账存 localStorage）
K线形态与盘口行为实战手册.html
今日作战简报.html
data/latest.json              统一数据契约（纯 JSON，给脚本读）
data/latest.js                window.WB_LATEST = {...}（给页面读）
选股引擎/                      Node 脚本与流水线
docs/                         方法论、口径与部署配置
deploy.sh                     本地 → 云服务器 的文件同步
_backup/                      历次整页快照
```

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

站点是纯静态托管（nginx），服务器只负责展示，不做计算。

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

`docs/deploy_nginx.conf` 是一份可直接替换的站点配置，处理了三件事：

1. `location ~ /\. { deny all; }` —— 挡住 `.git`。实测当前
   `http://115.29.164.8/.git/config` 可被公开下载，GitHub 仓库地址是泄露的。
2. `gzip on` —— `latest.js` 584KB 压到约 60KB。
3. `data/` 与 `*.html` 走 `no-cache` —— 避免浏览器缓存导致看到昨天的选股。

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
