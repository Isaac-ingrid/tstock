运行 A 股尾盘黑马盘中实时精选。工作目录：D:\project\tstock\选股引擎
定时时间14：30

执行环境：
- Node 用 C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
- 所有命令前加 http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= 以绕开系统代理
- 数据源容错：全市场快照用东财 clist（分页+分域名轮换）；分时用腾讯 minute → 东财 trends2 双源；日K 用腾讯 ifzq。腾讯分时会被 WAF 间歇拦截（返回 HTML），会自动降级到东财，不要手工重试超过一次
- 注意：东财接口连续请求过多会被限流（返回 000），此时依赖备源即可，报告原因后继续

依次执行：
1) node tail.js —— 全市场实时快照 → 快照预筛 → 分时与涨停史复核 → 产出 out/tail-<日期>.json（尾盘黑马 TOP 名单）
2) node publish.js —— 把尾盘名单并入统一数据契约 ../data/latest.json 与 ../data/latest.js（入口页 index.html 与 做T执行台.html 的「尾盘买入策略推荐」区块直接读 latest.tail，这一步失败等于页面看不到今日黑马）

重要约束（不要在流程里做这些事）：
- 不要跑 engine.js。engine.js 是收盘后才跑的次日做T选股，14:30 跑会写入半日快照污染 out/snapshot-<日期>.json，且当日 15:10 任务复跑时会静默复用这份残值。
- 不要写 ledger/。ledger/close-<日期>.json 是收益回算的唯一数据源，14:30 的半日价写进去会让 returns.js 的当日收益全部失真且无法回滚。
- 不要跑 returns.js / report.js / plan.js / plan-report.js / dashboard.js / steady.js / tracker.js。这些是 15:10 任务的职责。

完成后用一段简体中文纯文本汇报（不要用 Markdown 列表、加粗、标题）：
今日尾盘黑马几只，分别是哪几只，各自现价、日内涨幅、距涨停还有多少空间、量比、换手、分时均价线上方占比、14:00 后量能密度相对全市场中位的倍数、得分；环境闸门等级与建议仓位系数；契约是否发布成功（data/latest.js 里 tail 字段有几只）；是否出现接口失败及哪一步。

注意：这是研究工具，输出不得构成投资建议。