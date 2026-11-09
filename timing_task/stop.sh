#!/usr/bin/env bash
# ============================================================
# timing_task/stop.sh —— Linux 服务器定时调度器停止脚本
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"
node "$SCRIPT_DIR/stop.js"
