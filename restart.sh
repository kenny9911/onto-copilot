#!/bin/zsh
# OntoCopilot 的服务开关 —— 停干净、起起来、并且**确认真的起来了**。
#
#   ./restart.sh              重启全部（默认动作）
#   ./restart.sh start        只起
#   ./restart.sh stop         只停
#   ./restart.sh status       看看现在什么在跑
#   ./restart.sh 8010         换端口重启（旧用法，仍然管用）
#   PORT=8010 ./restart.sh    同上
#   ./restart.sh -f           前台跑，日志直接打在终端（调试用）
#
# ── 这里管哪些"服务" ────────────────────────────────────────────
#   1. Postgres（docker compose，:5433）—— **只在 DATABASE_URL 指向 Postgres 时**
#      才算一个服务。默认零配置走 SQLite（workspace/ontocopilot.db），那种情况下
#      没有容器要起，也不该为了"看起来完整"去起一个没人连的库。
#   2. 应用进程（TS 服务在 / 直接吐前端，所以前后端是同一个进程，只有这一个）。
#
# ── 为什么不是 `pkill node && npm start` ───────────────────────
#   1. `pkill node` 会连你别的 Node 项目一起杀。这里**按端口收尸**，只动占着这个
#      端口的那个进程。
#   2. 旧进程没退干净时，新进程绑不上端口就死了，而浏览器刷新看到的还是**旧代码** ——
#      这个坑在迁移期真的踩过一次，一整轮验证等于在测几小时前的东西。
#      所以下面等到端口真的空出来才启动，等不到就报错退出，不装作成功。
#   3. 起完还要**探一次 HTTP**。进程活着不等于服务可用：端口绑上了但 .env 写歪、
#      迁移没跑、库连不上，都会让它活着却 500。不探的话这些要等你点开页面才发现。
set -u

ROOT="${0:A:h}"
DEFAULT_PORT=3594          # 与 ts/src/serve.ts 的 DEFAULT_PORT 对齐
COMPOSE_SERVICE=postgres
PG_CONTAINER=ontocopilot-pg
RUN_DIR="$ROOT/workspace/run"
LOG_DIR="$ROOT/workspace/logs"

# ── 参数 ───────────────────────────────────────────────────────
ACTION=restart
FOREGROUND=0
PORT_ARG=""
for a in "$@"; do
  case "$a" in
    start|stop|restart|status) ACTION="$a" ;;
    -f|--foreground)           FOREGROUND=1 ;;
    <->)                       PORT_ARG="$a" ;;   # zsh：纯数字
    # 取开头那段注释，取到第一行非注释为止 —— 写死行号的话，注释一改帮助就
    # 会把 `set -u` 那几行也打出来（已经发生过一次）。
    -h|--help)                 awk 'NR>1 && !/^#/{exit} NR>1' "$0"; exit 0 ;;
    *) echo "!! 不认识的参数：$a（用 -h 看用法）" >&2; exit 2 ;;
  esac
done

# ── .env 里取一个键 ────────────────────────────────────────────
# 不用 `source`：.env 是配置不是脚本，里面一个反引号就能在你重启服务时执行任意命令。
env_val() {
  [[ -f "$ROOT/.env" ]] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)\$/\1/p" "$ROOT/.env" \
    | tail -1 | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'
}

# 端口优先级与应用自己的一致：命令行 > 环境 > .env 的 ONTOCOPILOT_PORT > 内置默认。
# 不一致的话脚本探的口和服务听的口会是两个，"起好了但连不上"就是这么来的。
PORT="${PORT_ARG:-${PORT:-$(env_val ONTOCOPILOT_PORT)}}"
[[ -n "$PORT" ]] || PORT="$DEFAULT_PORT"

DB_URL="${DATABASE_URL:-$(env_val DATABASE_URL)}"
USE_PG=0
[[ "$DB_URL" == postgres://* || "$DB_URL" == postgresql://* ]] && USE_PG=1

PID_FILE="$RUN_DIR/server-$PORT.pid"
LOG_FILE="$LOG_DIR/server-$PORT.log"

port_busy() { lsof -ti "tcp:$1" >/dev/null 2>&1 }

# ══════════════════════════════════════════════════════════════
#  停
# ══════════════════════════════════════════════════════════════
stop_app() {
  echo "==> 停应用（:$PORT）"
  local pids
  pids=$(lsof -ti "tcp:$PORT" 2>/dev/null)
  if [[ -z "$pids" ]]; then
    echo "    端口本来就是空的"
    rm -f "$PID_FILE"
    return 0
  fi
  echo "$pids" | xargs kill 2>/dev/null
  # 先给 SIGTERM 一点时间：serve.ts 的 SIGTERM 处理器要把 lifespan 收尾跑完
  # （排空用量流水、写完会话事件、关库）。直接 -9 的话「重启之后账少了一笔」
  # 就是这么来的。
  local i
  for i in {1..20}; do
    port_busy "$PORT" || break
    sleep 0.5
  done
  if port_busy "$PORT"; then
    echo "    还没退，强制杀"
    lsof -ti "tcp:$PORT" | xargs kill -9 2>/dev/null
    sleep 1
  fi
  rm -f "$PID_FILE"
  port_busy "$PORT" && { echo "    !! 仍被占用" >&2; return 1; }
  echo "    已停"
}

stop_pg() {
  (( USE_PG )) || return 0
  echo "==> 停 Postgres"
  if ! docker info >/dev/null 2>&1; then
    echo "    docker 没在跑，跳过"
    return 0
  fi
  # `stop` 而不是 `down`：down 会删掉容器（数据在具名卷里还在，但重建一次没必要），
  # 而且 `down -v` 手滑一次就是把开发库清空。停就只是停。
  ( cd "$ROOT" && docker compose stop "$COMPOSE_SERVICE" >/dev/null 2>&1 ) \
    && echo "    已停" || echo "    !! 停失败（可能本来就没起）"
}

# ══════════════════════════════════════════════════════════════
#  起
# ══════════════════════════════════════════════════════════════
start_pg() {
  (( USE_PG )) || { echo "==> Postgres：DATABASE_URL 没指向 PG，走 SQLite，跳过"; return 0 }
  echo "==> 起 Postgres"
  if ! docker info >/dev/null 2>&1; then
    echo "!! docker daemon 没在跑，而 DATABASE_URL 指着 Postgres —— 应用起来也连不上库。" >&2
    echo "   先启动 Docker Desktop，或把 .env 里的 DATABASE_URL 去掉改用 SQLite。" >&2
    return 1
  fi
  ( cd "$ROOT" && docker compose up -d "$COMPOSE_SERVICE" ) || return 1

  # 等 healthcheck 真的过 —— compose 的 `up -d` 返回只代表容器**创建**了。
  # 这时候 initdb 脚本可能还在跑，连上去建表会撞上"表已存在/还没存在"的怪错。
  echo "    等 healthcheck"
  local i state
  for i in {1..40}; do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null)
    [[ "$state" == healthy ]] && { echo "    healthy"; return 0 }
    sleep 1
  done
  echo "!! Postgres 20 秒内没到 healthy（现在是 ${state:-未知}）" >&2
  return 1
}

migrate() {
  (( USE_PG )) || return 0   # SQLite 由 Store.open(create_all) 建表，不走 migrations/
  echo "==> 跑迁移"
  # Postgres 上 schema 的唯一来源是 migrations/（store/engine.ts 明确拒绝 create_all）。
  # 没人在启动时自动跑它 —— 不跑就是拿空库起服务，报错还发生在第一次点页面的时候。
  ( cd "$ROOT/ts" && "$ROOT/ts/node_modules/.bin/tsx" tools/migrate.mts ) || return 1
}

build_ui() {
  # 前端是构建产物（React 打包内联进 ui/index.html）。源码改了没重新构建的话，
  # 页面上看到的还是上一次的 —— 这一步很快。
  echo "==> 构建前端"
  ( cd "$ROOT/ts" && npm run --silent build:ui ) || { echo "!! 前端构建失败" >&2; return 1; }
}

warn_launchd() {
  # launch.json 里记过这个坑：如果有 keepalive 的 launchd 作业占着端口，
  # 你 kill 掉它会被**立刻重新拉起**，脚本随后"启动成功"，而页面上跑的还是
  # 那个作业的旧 dist。这里只提醒，不替你去 unload 别人的作业。
  local jobs
  jobs=$(launchctl list 2>/dev/null | grep -i ontocopilot | awk '{print $3}')
  [[ -n "$jobs" ]] || return 0
  echo "!! 注意：检测到 launchd 作业 ${jobs//$'\n'/ }" >&2
  echo "   它可能 keepalive 地占着端口：kill 掉会被自动拉起，你会以为在跑新代码。" >&2
  echo "   要重启那一台：launchctl kickstart -k gui/\$UID/<作业名>" >&2
}

start_app() {
  if port_busy "$PORT"; then
    echo "!! :$PORT 仍被占用，放弃启动（不然新进程绑不上，你会以为在跑新代码）" >&2
    return 1
  fi

  local tsx="$ROOT/ts/node_modules/.bin/tsx"
  [[ -x "$tsx" ]] || { echo "!! 找不到 $tsx —— 先 cd ts && npm install" >&2; return 1; }

  if (( FOREGROUND )); then
    echo "==> 前台启动 :$PORT（Ctrl-C 停）"
    cd "$ROOT/ts"
    exec "$tsx" src/main.ts --port "$PORT"
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  echo "==> 启动 :$PORT（日志 ${LOG_FILE#$ROOT/}）"
  ( cd "$ROOT/ts" && nohup "$tsx" src/main.ts --port "$PORT" >>"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )
  local pid; pid=$(cat "$PID_FILE" 2>/dev/null)

  # 探到**能应答 HTTP** 为止。任何状态码都算起来了（开了登录门禁时 /api/health
  # 会 401，那也证明它在服务）。只看端口占用是不够的：绑上到能应答之间还有
  # 载配置、开库、装目录一整段，中间挂掉的话端口是占着的。
  local i code
  for i in {1..120}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "!! 进程已退出，最后 20 行日志：" >&2
      tail -20 "$LOG_FILE" >&2
      return 1
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
    if [[ "$code" == [1-5][0-9][0-9] ]]; then
      echo "    就绪（HTTP $code）  →  http://127.0.0.1:$PORT/"
      return 0
    fi
    sleep 0.5
  done
  echo "!! 60 秒内没能应答 HTTP，最后 20 行日志：" >&2
  tail -20 "$LOG_FILE" >&2
  return 1
}

# ══════════════════════════════════════════════════════════════
#  状态
# ══════════════════════════════════════════════════════════════
status() {
  echo "端口       :$PORT"
  echo "数据库     $( (( USE_PG )) && echo "Postgres（$DB_URL）" || echo "SQLite（workspace/ontocopilot.db）" )"
  if (( USE_PG )); then
    if docker info >/dev/null 2>&1; then
      local st; st=$(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null)
      echo "Postgres   ${st:-未创建}"
    else
      echo "Postgres   docker 没在跑"
    fi
  fi
  if port_busy "$PORT"; then
    local pids code
    pids=$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ')
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
    echo "应用       在跑（pid ${pids%% }）  HTTP ${code:-无应答}"
  else
    echo "应用       没在跑"
  fi
}

# ══════════════════════════════════════════════════════════════
case "$ACTION" in
  status) status ;;
  stop)   stop_app || exit 1; stop_pg ;;
  start)  warn_launchd; start_pg || exit 1; migrate || exit 1; build_ui || exit 1; start_app || exit 1 ;;
  restart)
    warn_launchd
    stop_app || exit 1
    start_pg || exit 1
    migrate  || exit 1
    build_ui || exit 1
    start_app || exit 1
    ;;
esac
