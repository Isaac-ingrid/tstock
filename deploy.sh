#!/usr/bin/env bash
# ============================================================
# deploy.sh —— 把本地跑批结果同步到线上站点
#
# 设计原则：
#   1. 只传「展示层」，不传计算层。out/ 与 ledger/ 留在本机，
#      服务器只当静态文件服务器用。
#   2. 传完必须回读校验，不能「以为传上去了」。脚本退出码非 0
#      时自动化要如实报失败，不要当成功。
#   3. 幂等：重复执行结果一致，中途失败重跑即可。
#
# 用法：
#   bash deploy.sh              # 全量同步
#   bash deploy.sh --dry-run    # 只打印将传的文件，不实际传输
#   bash deploy.sh --data-only  # 只传 data/（数据契约，最常用）
#
# 凭据：~/.ssh/id_ed25519_tstock（需已装到服务器 authorized_keys）
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# ---------- 配置 ----------
HOST="115.29.164.8"
USER_NAME="${DEPLOY_USER:-root}"
# REMOTE_DIR 留空则自动探测。显式设置时不做探测，直接用它。
REMOTE_DIR="${DEPLOY_DIR:-}"
SSH_KEY="$HOME/.ssh/id_ed25519_tstock"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i "$SSH_KEY")

DRY_RUN=0
DATA_ONLY=0
SOFT=0
for a in "$@"; do
  case "$a" in
    --dry-run)   DRY_RUN=1 ;;
    --data-only) DATA_ONLY=1 ;;
    # --soft：上传失败不返回非 0 退出码。
    # 给自动化用：选股跑批成功但网络/服务器有问题时，不应该让整个
    # 定时任务被判定为失败（那样会掩盖「选股其实跑好了」这个事实）。
    --soft)      SOFT=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() {
  printf '❌ %s\n' "$*" >&2
  if [ "$SOFT" -eq 1 ]; then
    printf '（--soft 模式：不影响本次跑批结果）\n' >&2
    exit 0
  fi
  exit 1
}

# ---------- 1. 收集待传文件 ----------
# 注意：这里显式列举，不用通配符扫全目录。
# 原因：选股引擎/out 有 8.5MB 快照、_backup 有历次整页快照，
# 一旦用 scp -r 就会把它们全推上去，既慢又把服务器当垃圾场。
FILES=()

add() { [ -f "$1" ] && FILES+=("$1"); }

# 数据契约：两个页面都靠它，必须有
add "data/latest.js"
add "data/latest.json"

if [ "$DATA_ONLY" -eq 0 ]; then
  # 静态资源
  add "index.html"
  add "做T执行台.html"
  add "style.css"
  add "script.js"
  add "今日作战简报.html"
  add "K线形态与盘口行为实战手册.html"

  # 模块化资产（CSS 与 ES Modules）
  for f in css/*.css; do [ -f "$f" ] && FILES+=("$f"); done
  for f in js/*.js; do [ -f "$f" ] && FILES+=("$f"); done
  for f in js/vendor/*.js; do [ -f "$f" ] && FILES+=("$f"); done

  # 引擎产出的报告（文件名带日期的用 glob，今日候选只传最新一份）
  LATEST_CAND=$(ls -1 选股引擎/今日候选_*.html 2>/dev/null | sort | tail -1)
  [ -n "${LATEST_CAND:-}" ] && add "$LATEST_CAND"
  add "选股引擎/挂单计划_明日.html"
  add "选股引擎/选股工作台.html"
  add "选股引擎/稳健清单_底仓候选.html"
fi

[ ${#FILES[@]} -eq 0 ] && fail "没有找到任何待传文件，检查是否在项目根目录执行"

# ---------- 2. 前置校验：本地数据是不是今天的 ----------
# 这是防「传了昨天的数据还以为更新了」的第一道闸门。
TRADE_DATE=$(grep -oE '"tradeDate":"[0-9]{4}-[0-9]{2}-[0-9]{2}"' data/latest.js 2>/dev/null | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
GEN_AT=$(grep -oE '"generatedAt":"[^"]*"' data/latest.js 2>/dev/null | head -1 | cut -d'"' -f4)
[ -z "$TRADE_DATE" ] && fail "data/latest.js 里读不到 tradeDate，文件可能损坏，先跑 publish.js"

say "============================================================"
say "  同步到 ${USER_NAME}@${HOST}:${REMOTE_DIR}"
say "  交易日 ${TRADE_DATE}   契约生成于 ${GEN_AT:-未知}"
say "  待传 ${#FILES[@]} 个文件"
say "============================================================"
for f in "${FILES[@]}"; do
  printf '  %-50s %8s\n' "$f" "$(du -h "$f" | cut -f1)"
done

# ---------- 3. 连通性与远端目录确认（dry-run 跳过） ----------
if [ "$DRY_RUN" -eq 0 ]; then
  ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "echo ok" >/dev/null 2>&1 || {
    say ""
    fail "SSH 免密登录失败。请确认公钥已装到 $USER_NAME@$HOST 的 ~/.ssh/authorized_keys。
    公钥内容（本机 ~/.ssh/id_ed25519_tstock.pub）：
    $(cat "$SSH_KEY.pub" 2>/dev/null)
    在服务器上执行：
      mkdir -p ~/.ssh && chmod 700 ~/.ssh
      echo '<上面这行公钥>' >> ~/.ssh/authorized_keys
      chmod 600 ~/.ssh/authorized_keys
    若登录用户不是 root，用 DEPLOY_USER=xxx bash deploy.sh 覆盖"
  }
fi

# 远端目录必须存在且可写，避免传到一半才发现路径错
if [ -z "$REMOTE_DIR" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    REMOTE_DIR="（自动探测）"
  else
    # 自动探测：优先问 nginx 站点配置里的 root，退回到「找 index.html 所在目录」。
    # 不写死路径是必要的——不同装机方式站点可能在 /var/www、/usr/share/nginx、/home 下。
    REMOTE_DIR=$(ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" '
      for c in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
        [ -f "$c" ] || continue
        r=$(grep -hoE "^[[:space:]]*root[[:space:]]+[^;]+" "$c" 2>/dev/null | head -1 | awk "{print \$2}")
        if [ -n "$r" ] && [ -f "$r/index.html" ]; then echo "$r"; exit 0; fi
      done
      for d in /var/www/tstock /var/www/html /usr/share/nginx/html /home/*/tstock; do
        [ -f "$d/index.html" ] && { echo "$d"; exit 0; }
      done
    ' 2>/dev/null | tr -d "\r" | head -1)

    [ -z "$REMOTE_DIR" ] && fail "无法自动探测站点目录。请在服务器上确认 index.html 的绝对路径后这样运行：
    DEPLOY_DIR=/实际路径 bash deploy.sh"
    say "自动探测到站点目录：$REMOTE_DIR"
  fi
fi

if [ "$DRY_RUN" -eq 0 ]; then
  ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "test -d '$REMOTE_DIR' && test -w '$REMOTE_DIR'" 2>/dev/null || {
    fail "远端目录 $REMOTE_DIR 不存在或不可写。用 DEPLOY_DIR 指定正确路径后重试"
  }
else
  say ""
  say "[dry-run] 以上 ${#FILES[@]} 个文件将被同步，未实际传输。"
  exit 0
fi

# ---------- 4. 传输 ----------
# 实测：Git Bash 下每建一条 ssh 连接开销约 8 秒（Windows 进程创建慢），
# 11 个文件逐个传要 2 分钟以上，失败面也大。
# 改成「本地 tar 打包 → 单条 ssh 管道 → 远端解包」：一条连接搞定，
# 且 tar 按字节存文件名，中文名不会像 scp 那样有编码坑。
TARBALL_LIST=()
for f in "${FILES[@]}"; do TARBALL_LIST+=("$f"); done

say ""
say "传输中（单连接打包发送）…"
START_TS=$(date +%s)

if tar cf - "${TARBALL_LIST[@]}" 2>/dev/null \
    | ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "cd $(printf '%s' "$REMOTE_DIR" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/") && tar xf -" 2>/dev/null; then
  say "  ✓ 打包传输完成"
else
  fail "传输失败。检查远端目录 $REMOTE_DIR 是否存在且可写"
fi

say "  耗时 $(( $(date +%s) - START_TS )) 秒"

# ---------- 4b. 逐文件字节数比对（远端一次调用取回全部大小） ----------
# 打包传输一条命令就完事，但不能假设一定完整落地，
# 所以再取一次远端实际大小，逐项和本地比。
QB64=$( ( [ "$REMOTE_DIR" = "" ] && echo "/" || printf '%s' "$REMOTE_DIR" ) | base64 | tr -d '\r\n')
REMOTE_SIZES=$(ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" \
  "d=\$(printf '%s' '$QB64' | base64 -d); cd \"\$d\" && find . -type f -printf '%s %p\n'" 2>/dev/null | tr -d '\r')

MISMATCH=()
if [ -z "$REMOTE_SIZES" ]; then
  say "  （远端未能返回文件清单，跳过逐项比对）"
else
  for f in "${FILES[@]}"; do
    LB=$(wc -c < "$f" | tr -d ' ')
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

# ---------- 5. 回读校验 ----------
# 传完不看一眼就等于没传。这里直接请求线上地址，比对 tradeDate
# 与文件大小，确保用户刷新浏览器看到的是今天的数据。
# --noproxy：本机常驻系统代理（127.0.0.1:2430）会拦内网/直连 IP，
# 不加这个参数可能拿到代理返回的假结果。
CURL=(curl -s -m 15 --noproxy '*')

say ""
say "回读校验中…"
ONLINE_DATE=$("${CURL[@]}" "http://$HOST/data/latest.js" 2>/dev/null \
  | grep -oE '"tradeDate":"[0-9]{4}-[0-9]{2}-[0-9]{2}"' | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')

LOCAL_SIZE=$(wc -c < data/latest.js | tr -d ' ')
ONLINE_SIZE=$("${CURL[@]}" -o /dev/null -w '%{size_download}' "http://$HOST/data/latest.js" 2>/dev/null)

say "  本地 tradeDate ${TRADE_DATE} / 线上 ${ONLINE_DATE:-读取失败}"
say "  本地 latest.js ${LOCAL_SIZE} 字节 / 线上 ${ONLINE_SIZE:-0} 字节"

if [ "$ONLINE_DATE" != "$TRADE_DATE" ]; then
  fail "线上 tradeDate 与本地不一致，同步未生效（可能是缓存或目录不对）。刷新页面时强制 Ctrl+F5"
fi
if [ "$ONLINE_SIZE" != "$LOCAL_SIZE" ]; then
  fail "线上文件大小与本地不一致，传输可能不完整"
fi

say ""
say "✅ 同步完成：线上已经是 ${TRADE_DATE} 的数据"
say "   入口 http://$HOST/"
say ""
say "若浏览器仍显示旧数据，先 Ctrl+F5 强刷；若仍不对，说明 nginx 开了缓存头。"
exit 0