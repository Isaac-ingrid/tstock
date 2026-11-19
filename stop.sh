#!/usr/bin/env bash
set -euo pipefail

# One-click stopper for tstock local services
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found in PATH." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/scripts/local-service.mjs" stop "$@"
