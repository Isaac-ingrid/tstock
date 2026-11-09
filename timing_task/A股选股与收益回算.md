运行 A 股选股与收益回算流水线。工作目录：D:\project\tstock\选股引擎
定时时间15：10

执行环境：
- Node 用 C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
- 所有命令前加 http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= 以绕开系统代理
- 数据源已做多级容错：全市场快照用东财 clist（分页+分域名轮换+当日缓存）；日K 顺序尝试东财 push2his → 腾讯 fqkline → 新浪；分时用腾讯 minute → 东财 trends2。任一源失败会自动降级，不要手工重试超过一次
- 注意：东财接口连续请求过多会被限流（返回 000），此时依赖缓存与备源即可，报告原因后继续

依次执行：
1) node engine.js —— 全市场扫描，输出当日候选，并写 ledger/picks-<日期>.json 与 ledger/close-<日期>.json
2) node returns.js —— 回算台账历史清单的 T+1/T+2/T+3/T+5/T+10/T+20 双口径收益，写 ledger/returns.csv
3) node report.js —— 生成当日候选看板 今日候选_<日期>.html
4) node plan.js —— 生成明日挂单计划（含做T系统三闸门与第四条双指数环境闸门的判定）
5) node plan-report.js —— 生成 挂单计划_明日.html
6) node dashboard.js —— 更新 选股工作台.html
7) node publish.js —— 生成统一数据契约 ../data/latest.json 与 ../data/latest.js（入口页 index.html 与 做T执行台.html 都靠它读选股结果，这一步失败等于两个页面看不到今日选股）

每周五额外执行一次（仅周五）：node steady.js 与 node steady-report.js，更新稳健型底仓候选名单；之后必须再跑一次 node publish.js 让契约带上最新稳健名单。

8) 全部跑完后，把结果发布到线上站点。先回到项目根目录 D:\project\tstock，执行：
   http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= bash deploy.sh --soft
   这一步用单个 ssh 连接打包上传 data/latest.js、data/latest.json 以及各报告页到云服务器 115.29.164.8，传完会自动回读线上 latest.js 比对 tradeDate 与字节数。
   注意 --soft 参数：上传失败（比如服务器不可达、公钥失效）时脚本返回 0，不让整个任务判失败，但会在输出里打印 ❌ 原因。此时选股结果依然有效，汇报时把上传失败单独列一句，不要含糊成"全部成功"。
   如果输出里出现「线上 tradeDate 与本地不一致」，说明传了但没生效，通常是 nginx 缓存或站点目录不对，如实报出来。

完成后用一段简体中文纯文本汇报（不要用 Markdown 列表、加粗、标题）：
今日扫描只数、严格六步法幸存只数、通过涨停史与VWAP复核只数、可做/小做/观察各几只；
明日挂单计划里第四条双指数环境闸门是否放行（上证与中证1000各自偏离 MA20 多少）、可挂单几只；
契约是否发布成功（data/latest.js 是否已更新，短线候选几只、稳健几只）；
线上同步是否成功（deploy.sh 结果的最后一行，成功则报线上交易日，失败则报具体原因）；
台账已累积几个交易日与多少条持有期记录；是否出现接口失败及哪一步。

注意：这是研究工具，输出不得构成投资建议。