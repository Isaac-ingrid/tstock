# ⏰ A股做T执行台 · 自动化定时任务系统 (Timing Task)

本项目将原本在 Workbuddy AI 中手动提示词触发的 **3 个核心交易节点任务**，重构为**高度健壮、零外部依赖、开箱即用的自动化独立脚本**，支持直接部署在 Linux 或 Windows 云服务器上 7×24 小时无人值守运行。

---

## 📅 任务清单与时间表

| 任务时刻 | 对应任务脚本 | 核心功能与工作流 |
| :--- | :--- | :--- |
| **工作日 09:26** | `timing_task/tasks/task_auction.js` | **集合竞价存档与弱参考校准**<br>1. 抓取今日 09:26 集合竞价最新开盘价、高低开幅、高开异动<br>2. 评估大盘环境弱参考基调并入库<br>3. 自动同步更新到 `data/` 与前端 `public/data/` |
| **工作日 14:30** | `timing_task/tasks/task_tail.js` | **尾盘黑马实时精选与操作发布**<br>1. 扫描短线候选池在尾盘半小时的量能突增、分时走势与承接力<br>2. 智能产出 TOP 尾盘黑马候选（附带底仓建议与防守位）<br>3. 实时发布到 `data/latest.json`，前端即时响应 |
| **工作日 15:10** | `timing_task/tasks/task_daily.js` | **收盘全量选股、双轨回算、计划与周五底仓发布**<br>1. 全量执行选股引擎（短线、波段、题材、多因子筛选）<br>2. 双轨收益回算并更新台账 (`returns.csv`)<br>3. 生成次日操盘挂单计划与多维复盘研报<br>4. 周五闭盘自动触发中长线稳健底仓池轮动<br>5. 触发 `publish.js` 统一发布最新数据契约，并触发部署钩子 |

---

## 🚀 快捷执行与调试（NPM Scripts）

在项目根目录下，可以通过已配置的 `npm run` 命令直接调用：

```bash
# === 1. 单独手动触发某个定时任务（立即测试执行） ===
npm run task:auction   # 手动测试 09:26 集合竞价任务
npm run task:tail      # 手动测试 14:30 尾盘黑马任务
npm run task:daily     # 手动测试 15:10 收盘全量选股与回算

# === 2. 调度器后台守护进程管理 ===
npm run timer:start    # 后台启动常驻调度器
npm run timer:status   # 查询当前运行状态、上次触发历史与下次计划时刻
npm run timer:stop     # 安全停止后台调度器
```

---

## 🖥️ 服务器部署方案（推荐 3 选 1）

### 推荐方案 A：Linux Crontab（最稳定、无常驻内存开销）

Linux 自带的 cron 是服务器上最轻量、最防崩溃的执行方式，不占用任何常驻内存：

1. 确认 Node 路径与项目路径：
   ```bash
   which node    # 例如得到 /usr/bin/node
   pwd           # 例如得到 /data/tstock
   ```
2. 编辑当前用户的定时表：
   ```bash
   crontab -e
   ```
3. 复制以下配置（根据实际路径稍作替换）并保存：
   ```crontab
   # 工作日 09:26 集合竞价任务
   26 9 * * 1-5 cd /data/tstock && env -u http_proxy -u https_proxy /usr/bin/node timing_task/tasks/task_auction.js >> timing_task/logs/cron.log 2>&1

   # 工作日 14:30 尾盘黑马任务
   30 14 * * 1-5 cd /data/tstock && env -u http_proxy -u https_proxy /usr/bin/node timing_task/tasks/task_tail.js >> timing_task/logs/cron.log 2>&1

   # 工作日 15:10 收盘全量计算与发布任务
   10 15 * * 1-5 cd /data/tstock && env -u http_proxy -u https_proxy /usr/bin/node timing_task/tasks/task_daily.js >> timing_task/logs/cron.log 2>&1
   ```
4. 查看已生效的 crontab：
   ```bash
   crontab -l
   ```

---

### 推荐方案 B：Linux Systemd 守护进程（开机自启、故障自愈）

如果你希望将内置调度器注册为 Linux 系统服务：

1. 检查并按需编辑服务模板文件 `timing_task/tstock-timer.service` 中的路径与用户名；
2. 复制到系统服务目录：
   ```bash
   sudo cp timing_task/tstock-timer.service /etc/systemd/system/tstock-timer.service
   ```
3. 激活并启动：
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable tstock-timer
   sudo systemctl start tstock-timer
   ```
4. 运维命令：
   ```bash
   sudo systemctl status tstock-timer    # 查看运行状态
   sudo journalctl -u tstock-timer -f    # 实时查看输出日志
   sudo systemctl stop tstock-timer      # 停止
   ```

---

### 推荐方案 C：内置轻量调度器（跨平台、一键后台启停）

无需任何系统级 root 权限，纯 Node.js 实现，同时支持 Linux 与 Windows：

#### Linux / macOS：
```bash
bash timing_task/start.sh    # 后台静默启动（自动记录 PID）
node timing_task/status.js   # 查看运行状态与心跳
bash timing_task/stop.sh     # 优雅关闭
```

#### Windows：
```bat
timing_task\start.bat        # 启动后台守护
node timing_task\status.js   # 查看状态
timing_task\stop.bat         # 停止
```

---

## 📊 状态查询与日志监控

调度器运行中会持续维护 `timing_task/logs/` 目录：
- **今日调度日志**：`timing_task/logs/YYYY-MM-DD.log`
- **任务运行状态快照**：`timing_task/logs/scheduler_state.json`
- **查询终端直观看板**：
  ```bash
  node timing_task/status.js
  ```
  *控制台将打印包含【服务状态】、【进程 PID】、【心跳更新时间】、【三大任务当日执行记录】以及【下次触发倒计时】的完整汇总面板。*

---

## 🛡️ 网络与安全容错特性

1. **自动清除代理污染**：脚本内置 `cleanEnv()`，在发起请求时自动清除 `http_proxy`、`https_proxy`，彻底防止腾讯行情和东方财富接口被云服务器的科学上网代理屏蔽；
2. **周末自动静默跳过**：内置周末（周六/周日）自动休眠判定，避免周末休市期间产生无效请求与空脏数据；
3. **防重入锁控制**：每日每个任务在触发成功后记录防重复执行标志，避免由于时间边缘跳变发生重复抓取；
4. **前端契约双写发布**：统一调用 `publish.js`，同步写入 `data/` 与 `public/data/`，确保无论是纯静态托管还是 Next.js 服务，网页端均能立即加载最新选股与尾盘结果。
