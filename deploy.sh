#!/usr/bin/env bash
# ============================================================
# deploy.sh —— A股做T执行台 · 智能双模态发布与部署脚本
#
# 设计原则：
#   1. 自适应双模态（Local / Remote）：
#      - 在服务器上运行：自动识别为本机，免除 SSH 与公钥依赖，
#        直接通过 rsync/cp 将 out/ 高速同步到 dist/（站点根目录），
#        杜绝「自己通过 SSH 推给自己」的死循环；
#      - 在开发机上运行：自动识别为远程，通过单连接 SSH 管道打包推流。
#   2. 报告完整性保障：
#      Next.js 导出到 out/ 后，自动将独立的作战简报、挂单计划、
#      选股工作台等独立 HTML 报告合并落地，防止线上 404。
#   3. 回读校验与幂等性：
#      发布完成后比对文件字节与 tradeDate，确保线上数据真实生效。
#
# 用法：
#   bash deploy.sh              # 全量构建并发布（自动识别本机或远程）
#   bash deploy.sh --data-only  # 仅发布数据契约（盘中快速同步，无需重构前端）
#   bash deploy.sh --dry-run    # 仅预演打印待发布文件清单
#   bash deploy.sh --local      # 强制使用本机同步模式 (out/ -> dist/)
#   bash deploy.sh --remote     # 强制使用远程 SSH 推送模式
#   bash deploy.sh --soft       # 失败不返回非 0 退出码（适合定时任务容灾）
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# ---------- 目标服务器配置 ----------
HOST="115.29.164.8"
USER_NAME="${DEPLOY_USER:-root}"
# REMOTE_DIR 留空则自动探测。显式设置时直接使用。
REMOTE_DIR="${DEPLOY_DIR:-}"
SSH_KEY="$HOME/.ssh/id_ed25519_tstock"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i "$SSH_KEY")

DRY_RUN=0
DATA_ONLY=0
SOFT=0
FORCE_LOCAL=0
FORCE_REMOTE=0

for a in "$@"; do
  case "$a" in
    --dry-run)   DRY_RUN=1 ;;
    --data-only) DATA_ONLY=1 ;;
    --soft)      SOFT=1 ;;
    --local)     FORCE_LOCAL=1 ;;
    --remote)    FORCE_REMOTE=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() {
  printf '❌ %s\n' "$*" >&2
  if [ "$SOFT" -eq 1 ]; then
    printf '（--soft 模式：不影响本次定时任务判定）\n' >&2
    exit 0
  fi
  exit 1
}

# ---------- 1. 智能判定执行模式（本机模式 vs 远程 SSH 模式） ----------
IS_LOCAL=0

if [ "$FORCE_LOCAL" -eq 1 ] || [ "${DEPLOY_TARGET:-}" = "local" ]; then
  IS_LOCAL=1
elif [ "$FORCE_REMOTE" -eq 1 ] || [ "${DEPLOY_TARGET:-}" = "remote" ]; then
  IS_LOCAL=0
elif [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
  IS_LOCAL=1
# 检查本地网卡 IP 是否包含目标 HOST
elif command -v ip >/dev/null 2>&1 && ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$HOST"; then
  IS_LOCAL=1
elif command -v hostname >/dev/null 2>&1 && hostname -I 2>/dev/null | grep -wq "$HOST"; then
  IS_LOCAL=1
# 检查云服务器特征：本机存在 Nginx 配置且 root 指向当前项目的 dist 目录
elif [ -d "/etc/nginx" ] && grep -rqs "$ROOT/dist" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null; then
  IS_LOCAL=1
# 兜底凭据检测：无远程部署私钥，但处于 Linux 且有 dist 目录，断定为服务器本机
elif [ ! -f "$SSH_KEY" ] && [ -d "$ROOT/dist" ] && [ "$(uname -s)" = "Linux" ]; then
  IS_LOCAL=1
fi

if [ "$IS_LOCAL" -eq 1 ]; then
  LOCAL_DEST="${DEPLOY_DIR:-$ROOT/dist}"
  say "🎯 运行模式: 本机同机发布 (Local Mode -> $LOCAL_DEST)"
else
  say "🌐 运行模式: 远程推送发布 (Remote SSH Mode -> $USER_NAME@$HOST)"
fi

# ---------- 2. 收集待发布文件与构建 ----------
FILES=()
SOURCE_ROOT="$ROOT"

add() { [ -f "$SOURCE_ROOT/$1" ] && FILES+=("$1"); }

if [ "$DATA_ONLY" -eq 1 ]; then
  # 日常数据更新模式：只同步数据契约，无需重新编译前端
  add "data/latest.js"
  add "data/latest.json"
else
  command -v npm >/dev/null 2>&1 || fail "未找到 npm，无法构建 Next.js 静态站点"
  say "执行 Next.js 静态导出构建..."
  npm run build || fail "Next.js 构建失败，已停止部署"
  [ -f "out/index.html" ] || fail "构建完成但 out/index.html 不存在"

  # Next.js export 产物位于 out/
  SOURCE_ROOT="$ROOT/out"

  # 保留并合并选股引擎生成的独立复盘研报与看板
  copy_extra() {
    [ -f "$ROOT/$1" ] || return 0
    mkdir -p "$SOURCE_ROOT/$(dirname "$1")"
    cp -p "$ROOT/$1" "$SOURCE_ROOT/$1"
  }
  copy_extra "今日作战简报.html"
  copy_extra "K线形态与盘口行为实战手册.html"
  LATEST_CAND=$(ls -1 "$ROOT"/选股引擎/今日候选_*.html 2>/dev/null | sort | tail -1)
  [ -n "${LATEST_CAND:-}" ] && copy_extra "${LATEST_CAND#$ROOT/}"
  copy_extra "选股引擎/挂单计划_明日.html"
  copy_extra "选股引擎/选股工作台.html"
  copy_extra "选股引擎/稳健清单_底仓候选.html"

  while IFS= read -r f; do FILES+=("$f"); done < <(find "$SOURCE_ROOT" -type f -printf '%P\n' 2>/dev/null || (cd "$SOURCE_ROOT" && find . -type f | sed 's|^\./||') | sort)
fi

[ ${#FILES[@]} -eq 0 ] && fail "没有找到任何待传文件，检查是否在项目根目录执行"

# ---------- 3. 前置校验：本地数据是不是今天的 ----------
TRADE_DATE=$(grep -oE '"tradeDate":"[0-9]{4}-[0-9]{2}-[0-9]{2}"' data/latest.js 2>/dev/null | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
GEN_AT=$(grep -oE '"generatedAt":"[^"]*"' data/latest.js 2>/dev/null | head -1 | cut -d'"' -f4)
[ -z "$TRADE_DATE" ] && fail "data/latest.js 里读不到 tradeDate，文件可能损坏，请先运行选股流水线或 publish.js"

say "============================================================"
if [ "$IS_LOCAL" -eq 1 ]; then
  say "  目标目录：$LOCAL_DEST"
else
  say "  目标主机：${USER_NAME}@${HOST}:${REMOTE_DIR:-（自动探测）}"
fi
say "  交易日期：${TRADE_DATE}   契约生成于：${GEN_AT:-未知}"
say "  文件数量：共 ${#FILES[@]} 个待同步文件"
say "============================================================"

for f in "${FILES[@]}"; do
  printf '  %-50s %8s\n' "$f" "$(du -h "$SOURCE_ROOT/$f" 2>/dev/null | cut -f1)"
done

if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "[dry-run] 预演完毕：以上 ${#FILES[@]} 个文件已确认，未实际传输写入。"
  exit 0
fi

# ---------- 4. 执行同步与落地 ----------
START_TS=$(date +%s)
say ""

if [ "$IS_LOCAL" -eq 1 ]; then
  # ───────────── 本机模式：直接落地到 dist/ ─────────────
  say "正在执行本机高效同步（免网络回环）..."
  mkdir -p "$LOCAL_DEST"

  if [ "$DATA_ONLY" -eq 1 ]; then
    mkdir -p "$LOCAL_DEST/data"
    cp -p "$SOURCE_ROOT/data/latest.js" "$LOCAL_DEST/data/"
    cp -p "$SOURCE_ROOT/data/latest.json" "$LOCAL_DEST/data/"
  else
    if command -v rsync >/dev/null 2>&1; then
      rsync -av --delete "$SOURCE_ROOT/" "$LOCAL_DEST/" >/dev/null
    else
      cp -a "$SOURCE_ROOT/." "$LOCAL_DEST/"
    fi
  fi
  say "  ✓ 本机文件同步完成"

  # 本机文件完整性比对
  MISMATCH=()
  for f in "${FILES[@]}"; do
    if [ ! -f "$LOCAL_DEST/$f" ]; then
      MISMATCH+=("$f(目标缺失)")
      continue
    fi
    LB=$(wc -c < "$SOURCE_ROOT/$f" | tr -d ' ')
    RB=$(wc -c < "$LOCAL_DEST/$f" | tr -d ' ')
    if [ "$LB" != "$RB" ]; then
      MISMATCH+=("$f(源${LB}/目标${RB})")
    fi
  done

  if [ ${#MISMATCH[@]} -gt 0 ]; then
    fail "本地文件写入不一致：${MISMATCH[*]}"
  fi
  say "  ✓ ${#FILES[@]} 个文件字节校验完全一致"

else
  # ───────────── 远程模式：通过 SSH 管道同步 ─────────────
  say "正在连接远端并确认目标路径..."
  ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "echo ok" >/dev/null 2>&1 || {
    fail "SSH 免密连接失败。请确认公钥已加入服务器 ~/.ssh/authorized_keys"
  }

  if [ -z "$REMOTE_DIR" ]; then
    REMOTE_DIR=$(ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" '
      for c in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
        [ -f "$c" ] || continue
        r=$(grep -hoE "^[[:space:]]*root[[:space:]]+[^;]+" "$c" 2>/dev/null | head -1 | awk "{print \$2}")
        if [ -n "$r" ] && [ -f "$r/index.html" ]; then echo "$r"; exit 0; fi
      done
      for d in /var/www/tstock /root/tstock/dist /var/www/html /usr/share/nginx/html; do
        [ -f "$d/index.html" ] && { echo "$d"; exit 0; }
      done
    ' 2>/dev/null | tr -d "\r" | head -1)

    [ -z "$REMOTE_DIR" ] && fail "无法自动探测远端站点目录，请通过 DEPLOY_DIR=/路径 参数指定"
    say "  自动探测到远端站点目录：$REMOTE_DIR"
  fi

  ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "mkdir -p '$REMOTE_DIR' && test -w '$REMOTE_DIR'" 2>/dev/null || {
    fail "远端目录 $REMOTE_DIR 不可写，请检查权限"
  }

  say "传输中（单连接打包发送）…"
  TARBALL_LIST=()
  for f in "${FILES[@]}"; do TARBALL_LIST+=("$f"); done

  if tar -C "$SOURCE_ROOT" -cf - "${TARBALL_LIST[@]}" 2>/dev/null \
      | ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "cd $(printf '%s' "$REMOTE_DIR" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/") && tar xf -" 2>/dev/null; then
    say "  ✓ 远程打包传输完成"
  else
    fail "传输失败，检查远端目录 $REMOTE_DIR"
  fi

  # 远端文件大小比对
  QB64=$( ( [ "$REMOTE_DIR" = "" ] && echo "/" || printf '%s' "$REMOTE_DIR" ) | base64 | tr -d '\r\n')
  REMOTE_SIZES=$(ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" \
    "d=\$(printf '%s' '$QB64' | base64 -d); cd \"\$d\" && find . -type f -printf '%s %p\n'" 2>/dev/null | tr -d '\r')

  MISMATCH=()
  if [ -n "$REMOTE_SIZES" ]; then
    for f in "${FILES[@]}"; do
      LB=$(wc -c < "$SOURCE_ROOT/$f" | tr -d ' ')
      RB=$(printf '%s\n' "$REMOTE_SIZES" | awk -v p="./$f" '$2==p {print $1; exit}')
      if [ "$LB" != "$RB" ]; then
        MISMATCH+=("$f(本地${LB}/远端${RB:-缺失})")
      fi
    done

    if [ ${#MISMATCH[@]} -gt 0 ]; then
      fail "以下文件大小不一致，传输可能不完整：${MISMATCH[*]}"
    fi
    say "  ✓ ${#FILES[@]} 个文件字节数全部一致"
  fi
fi

say "  耗时 $(( $(date +%s) - START_TS )) 秒"

# ---------- 5. 回读校验 ----------
say ""
say "回读校验中…"

CURL=(curl -s -m 8 --noproxy '*')
CHECK_URL="http://$HOST/data/latest.js"
if [ "$IS_LOCAL" -eq 1 ]; then
  # 本机优先通过本地环回快速校验 Nginx 是否在正常服务
  if "${CURL[@]}" "http://127.0.0.1/data/latest.js" >/dev/null 2>&1; then
    CHECK_URL="http://127.0.0.1/data/latest.js"
  fi
fi

ONLINE_DATE=$("${CURL[@]}" "$CHECK_URL" 2>/dev/null \
  | grep -oE '"tradeDate":"[0-9]{4}-[0-9]{2}-[0-9]{2}"' | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)

LOCAL_SIZE=$(wc -c < data/latest.js | tr -d ' ')
ONLINE_SIZE=$("${CURL[@]}" -o /dev/null -w '%{size_download}' "$CHECK_URL" 2>/dev/null || echo "0")

if [ -n "$ONLINE_DATE" ]; then
  say "  数据源 tradeDate ${TRADE_DATE} / 线上读取到 ${ONLINE_DATE}"
  say "  本地 latest.js ${LOCAL_SIZE} 字节 / 线上服务响应 ${ONLINE_SIZE} 字节"
  if [ "$ONLINE_DATE" != "$TRADE_DATE" ]; then
    fail "线上读取的 tradeDate 与当前不一致，请检查 Nginx 缓存设置"
  fi
else
  # 无法通过 HTTP 探测时（如 Nginx 未起或防火墙），但在本机模式已比对磁盘文件一致，不强制阻断
  if [ "$IS_LOCAL" -eq 1 ]; then
    say "  ⚠️ 未能通过 HTTP 端口回测，但本地目标目录文件已通过 100% 字节一致性校验。"
  else
    fail "无法访问线上站点 $CHECK_URL，请检查网络或 Nginx 状态"
  fi
fi

say ""
say "✅ 发布完成！站点已经是 ${TRADE_DATE} 的最新状态。"
if [ "$IS_LOCAL" -eq 1 ]; then
  say "   目标目录: $LOCAL_DEST"
else
  say "   目标主机: http://$HOST/"
fi
exit 0
