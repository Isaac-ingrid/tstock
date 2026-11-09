/**
 * timing_task/status.js
 * 查看定时任务调度器运行状态
 */

process.argv.push('--status');
require('./scheduler.js');
