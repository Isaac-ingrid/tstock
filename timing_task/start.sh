#!/usr/bin/env bash
# ============================================================
# timing_task/start.sh —— Linux 服务器定时调度器后台启动脚本
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/scheduler.pid"
LOG_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOG_DIR"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="$LOG_DIR/daemon_${TODAY}.log"

# 检查 Node 环境
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 错误: 未检测到 node 命令，请先安装 Node.js" >&2
  exit 1
fi

# 检查是否已有进程在运行
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" | tr -d ' ')"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "⚠️ 调度器已在运行中 (PID: $OLD_PID)，请勿重复启动。"
    echo "查看状态: bash timing_task/status.sh 或 node timing_task/status.js"
    echo "停止服务: bash timing_task/stop.sh"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

echo "🚀 正在后台启动 A股做T执行台定时调度服务..."
cd "$ROOT_DIR"

# 启动后台守护进程（清理代理，nohup 脱离终端）
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  nohup node "$SCRIPT_DIR/scheduler.js" >> "$LOG_FILE" 2>&1 &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "✅ 调度服务已成功启动 (PID: $NEW_PID)！"
  echo "  · 日志文件: $LOG_FILE"
  echo "  · 状态查询: node timing_task/status.js"
  echo "  · 停止服务: bash timing_task/stop.sh"
else
  echo "❌ 启动失败，请检查日志: $LOG_FILE" >&2
  exit 1
fi
