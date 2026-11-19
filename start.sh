#!/usr/bin/env bash
set -euo pipefail

# One-click launcher for tstock local services (backend:18765, frontend:3000, timing_task)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found in PATH. Please install Node.js first (e.g. brew install node)." >&2
  exit 1
fi

if ! node "$SCRIPT_DIR/scripts/local-service.mjs" start "$@"; then
  echo "" >&2
  echo "[HINT] Startup did not finish. Check logs above or in ./logs/" >&2
  exit 1
fi
