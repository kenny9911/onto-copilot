#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  Python 服务 vs TS 服务 —— 逐路由差分
# ══════════════════════════════════════════════════════════════════════════════
#
# 迁移的唯一验收口径是「行为等价」，而行为等价这件事**只能真起两个进程去问**。
# 单测能证明每个零件对，证明不了接线对：`wireServer()` 少挂一个 router 是一次
# 编译干净、测试全绿、但线上 404 的故障。这个脚本就是拦它的。
#
# 比什么：
#   · HTTP 状态码 —— 逐字比。
#   · 响应体的**键结构**（jq 的 paths，数组下标折叠成 `[]`）—— 不比值：
#     id / 时间戳 / 花费两边天然不同，比值只会得到一屏噪声。
#   · 非 JSON 响应（HTML / 二进制 / SSE）比 content-type 的主类型。
#
# 怎么跑：
#     tools/diff_servers.sh            # 全量
#     PYPORT=9001 TSPORT=9002 tools/diff_servers.sh
#     KEEP=1 tools/diff_servers.sh     # 保留两边的 workspace 便于事后翻
#
# 两边都用**干净的 workspace**：库里已经有账号的话 authgate 会切到强制鉴权，
# 那时全部路由都是 401，差分看起来"全都一致"而其实什么都没测到。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYPORT="${PYPORT:-8791}"
TSPORT="${TSPORT:-8792}"
WORK="${WORK:-/tmp/ontocopilot-parity}"
PY="$REPO/.venv/bin/python"

rm -rf "$WORK"
mkdir -p "$WORK/py" "$WORK/ts"

PYPID=""
TSPID=""
cleanup() {
  # **按端口收尸，不只按 pid**：`( … ) &` 记下的是子 shell，uvicorn / tsx 是它的
  # 孙子，杀 pid 杀不到。真实事故：上一轮跑剩的两个服务一直占着 8791/8792，下一轮
  # 的进程绑不上端口就死了，而 curl 打在**旧进程**上 —— 差分于是拿一份陈旧代码
  # 的行为报"全都一致"，整整一轮验证等于没做。
  [ -n "$PYPID" ] && kill "$PYPID" 2>/dev/null
  [ -n "$TSPID" ] && kill "$TSPID" 2>/dev/null
  local leftover
  leftover=$(lsof -ti ":$PYPORT" -ti ":$TSPORT" 2>/dev/null)
  [ -n "$leftover" ] && kill $leftover 2>/dev/null
  wait 2>/dev/null
  [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"
}
trap cleanup EXIT

# 同一个理由的前置检查：端口被占就当场停，别在旧进程上跑出一份假报告。
for p in "$PYPORT" "$TSPORT"; do
  if lsof -ti ":$p" >/dev/null 2>&1; then
    echo "!! 端口 $p 已被占用（pid $(lsof -ti ":$p" | tr '\n' ' '))。先停掉它，或换 PYPORT/TSPORT。"
    exit 2
  fi
done

# ── 起进程 ───────────────────────────────────────────────────────────────────
# `exec` 让子 shell **变成**服务进程本身，这样 $! 就是真身，cleanup 杀得掉。
echo "起 Python  :$PYPORT  (workspace=$WORK/py)"
( cd "$REPO" && exec env ONTOCOPILOT_WORKSPACE="$WORK/py" \
    "$PY" -m uvicorn ontocopilot.server:app --port "$PYPORT" --log-level warning \
    >"$WORK/py.log" 2>&1 ) &
PYPID=$!

echo "起 TS      :$TSPORT  (workspace=$WORK/ts)"
# 走临时 .mjs 而不是 `tsx -e`：`-e` 会被当成 CJS 编，顶层 await 直接编译失败。
cat >"$WORK/ts_serve.mjs" <<EOF
import { startServer } from "$REPO/ts/src/serve.ts";
await startServer({ port: $TSPORT });
EOF
( cd "$REPO" && exec env ONTOCOPILOT_WORKSPACE="$WORK/ts" \
    npx --prefix "$REPO/ts" tsx "$WORK/ts_serve.mjs" \
    >"$WORK/ts.log" 2>&1 ) &
TSPID=$!

wait_up() {
  local port="$1" name="$2" i
  for i in $(seq 1 120); do
    if curl -s -o /dev/null "http://127.0.0.1:$port/api/health"; then return 0; fi
    sleep 0.5
  done
  echo "!! $name 没起来，日志："
  tail -40 "$WORK/${name}.log"
  return 1
}
wait_up "$PYPORT" py || exit 1
wait_up "$TSPORT" ts || exit 1
echo

# ── 比较原语 ─────────────────────────────────────────────────────────────────
# 键结构：`paths` 的每一条，数组下标折叠成 `[]`，去重排序。值一律不看。
SKEL='def skel: [paths] | map(map(if type=="number" then "[]" else tostring end) | join("."))
      | unique | join(" ");
      skel'

TOTAL=0
SAME=0
DIFF=0
declare -a REPORT=()

# call <port> <method> <path> [body] [extra curl args…]
# 输出两行：第一行 `status<TAB>content-type`，其后是 body
call() {
  local port="$1" method="$2" path="$3" body="${4:-}"
  shift 4 2>/dev/null || shift 3
  local out
  if [ -n "$body" ]; then
    out=$(curl -s -m 25 -o "$WORK/body" -w '%{http_code}\t%{content_type}' \
      -X "$method" -H 'Content-Type: application/json' -d "$body" \
      "$@" "http://127.0.0.1:$port$path")
  else
    out=$(curl -s -m 25 -o "$WORK/body" -w '%{http_code}\t%{content_type}' \
      -X "$method" "$@" "http://127.0.0.1:$port$path")
  fi
  printf '%s\n' "$out"
  cat "$WORK/body"
}

# shape <status> <ctype> <bodyfile> —— 一次响应的可比形状
shape() {
  local status="$1" ctype="$2" file="$3" skel
  case "$ctype" in
    application/json*)
      skel=$(jq -r "$SKEL" <"$file" 2>/dev/null) || skel="<非法 JSON>"
      printf '%s | json{%s}' "$status" "$skel"
      ;;
    *)
      printf '%s | %s' "$status" "${ctype%%;*}"
      ;;
  esac
}

# probe <标签> <method> <path> [body] [curl args…]
probe() {
  local label="$1" method="$2" path="$3" body="${4:-}"
  shift 4 2>/dev/null || shift 3
  TOTAL=$((TOTAL + 1))

  local head p_status p_ctype ps
  head=$(curl -s -m 25 -o "$WORK/py.body" -w '%{http_code}\t%{content_type}' \
    ${body:+-H 'Content-Type: application/json' -d "$body"} \
    -X "$method" "$@" "http://127.0.0.1:$PYPORT$path")
  p_status="${head%%$'\t'*}"; p_ctype="${head#*$'\t'}"
  ps=$(shape "$p_status" "$p_ctype" "$WORK/py.body")

  local t_status t_ctype ts
  head=$(curl -s -m 25 -o "$WORK/ts.body" -w '%{http_code}\t%{content_type}' \
    ${body:+-H 'Content-Type: application/json' -d "$body"} \
    -X "$method" "$@" "http://127.0.0.1:$TSPORT$path")
  t_status="${head%%$'\t'*}"; t_ctype="${head#*$'\t'}"
  ts=$(shape "$t_status" "$t_ctype" "$WORK/ts.body")

  if [ "$ps" = "$ts" ]; then
    SAME=$((SAME + 1))
    printf '  一致   %-7s %-46s %s\n' "$method" "$path" "$p_status"
    REPORT+=("一致$method $label$ps")
  else
    DIFF=$((DIFF + 1))
    printf '  差异   %-7s %-46s py=%s  ts=%s\n' "$method" "$path" "$p_status" "$t_status"
    printf '         py: %s\n         ts: %s\n' "$ps" "$ts"
    REPORT+=("差异$method $labelpy: $ps ;; ts: $ts")
  fi
}

# jget <port> <path> <jqexpr> —— 拿一个字段，用来串起后面的会话级探针
jget() {
  curl -s -m 25 "http://127.0.0.1:$1$2" | jq -r "$3" 2>/dev/null
}
jpost() {
  curl -s -m 25 -X POST -H 'Content-Type: application/json' -d "$3" \
    "http://127.0.0.1:$1$2" | jq -r "$4" 2>/dev/null
}

echo "── 进程级 ────────────────────────────────────────────────────────────────"
probe "/api/health"   GET /api/health
probe "/api/models"   GET /api/models
probe "/api/usage"    GET /api/usage
probe "/"             GET /

echo "── 项目 ──────────────────────────────────────────────────────────────────"
probe "/api/projects" GET  /api/projects
probe "/api/projects" POST /api/projects '{"name":"差分项目"}'
PY_PID_=$(jpost "$PYPORT" /api/projects '{"name":"P2"}' '.id')
TS_PID_=$(jpost "$TSPORT" /api/projects '{"name":"P2"}' '.id')
if [ -n "$PY_PID_" ] && [ "$PY_PID_" != "null" ]; then
  TOTAL=$((TOTAL + 1))
  a=$(curl -s -m 25 -o "$WORK/py.body" -w '%{http_code}\t%{content_type}' -X PATCH \
      -H 'Content-Type: application/json' -d '{"name":"P3"}' \
      "http://127.0.0.1:$PYPORT/api/projects/$PY_PID_")
  b=$(curl -s -m 25 -o "$WORK/ts.body" -w '%{http_code}\t%{content_type}' -X PATCH \
      -H 'Content-Type: application/json' -d '{"name":"P3"}' \
      "http://127.0.0.1:$TSPORT/api/projects/$TS_PID_")
  x=$(shape "${a%%$'\t'*}" "${a#*$'\t'}" "$WORK/py.body")
  y=$(shape "${b%%$'\t'*}" "${b#*$'\t'}" "$WORK/ts.body")
  if [ "$x" = "$y" ]; then SAME=$((SAME+1)); printf '  一致   %-7s %-46s %s\n' PATCH /api/projects/{pid} "${a%%$'\t'*}"
    REPORT+=("一致PATCH /api/projects/{pid}$x")
  else DIFF=$((DIFF+1)); printf '  差异   %-7s %-46s py=%s ts=%s\n' PATCH /api/projects/{pid} "${a%%$'\t'*}" "${b%%$'\t'*}"
    printf '         py: %s\n         ts: %s\n' "$x" "$y"
    REPORT+=("差异PATCH /api/projects/{pid}py: $x ;; ts: $y"); fi
fi

echo "── 会话 ──────────────────────────────────────────────────────────────────"
probe "/api/sessions"      GET  /api/sessions
probe "/api/sessions"      POST /api/sessions '{"title":"差分会话"}'

PY_SID=$(jpost "$PYPORT" /api/sessions '{"title":"S"}' '.id')
TS_SID=$(jpost "$TSPORT" /api/sessions '{"title":"S"}' '.id')
echo "  py sid=$PY_SID   ts sid=$TS_SID"

# 会话级：路径两边不同（sid 不同），所以不能走 probe，单独展开
sprobe() {
  local label="$1" method="$2" tmpl="$3" body="${4:-}"
  shift 4 2>/dev/null || shift 3
  TOTAL=$((TOTAL + 1))
  local pp tp a b x y
  pp="${tmpl//\{sid\}/$PY_SID}"
  tp="${tmpl//\{sid\}/$TS_SID}"
  a=$(curl -s -m 25 -o "$WORK/py.body" -w '%{http_code}\t%{content_type}' \
      ${body:+-H 'Content-Type: application/json' -d "$body"} -X "$method" "$@" \
      "http://127.0.0.1:$PYPORT$pp")
  b=$(curl -s -m 25 -o "$WORK/ts.body" -w '%{http_code}\t%{content_type}' \
      ${body:+-H 'Content-Type: application/json' -d "$body"} -X "$method" "$@" \
      "http://127.0.0.1:$TSPORT$tp")
  x=$(shape "${a%%$'\t'*}" "${a#*$'\t'}" "$WORK/py.body")
  y=$(shape "${b%%$'\t'*}" "${b#*$'\t'}" "$WORK/ts.body")
  if [ "$x" = "$y" ]; then
    SAME=$((SAME + 1)); printf '  一致   %-7s %-46s %s\n' "$method" "$label" "${a%%$'\t'*}"
    REPORT+=("一致$method $label$x")
  else
    DIFF=$((DIFF + 1)); printf '  差异   %-7s %-46s py=%s  ts=%s\n' "$method" "$label" "${a%%$'\t'*}" "${b%%$'\t'*}"
    printf '         py: %s\n         ts: %s\n' "$x" "$y"
    REPORT+=("差异$method $labelpy: $x ;; ts: $y")
  fi
}

sprobe /api/sessions/{sid}/state          GET   '/api/sessions/{sid}/state'
sprobe /api/sessions/{sid}                PATCH '/api/sessions/{sid}' '{"title":"改名"}'
sprobe /api/sessions/{sid}/model          POST  '/api/sessions/{sid}/model' '{"model":"gpt-4o-mini"}'
sprobe /api/sessions/{sid}/to_work        POST  '/api/sessions/{sid}/to_work' '{}'
sprobe /api/sessions/{sid}/questions      GET   '/api/sessions/{sid}/questions'
sprobe /api/sessions/{sid}/questions/export GET '/api/sessions/{sid}/questions/export'
sprobe /api/sessions/{sid}/revisions      GET   '/api/sessions/{sid}/revisions'
sprobe /api/sessions/{sid}/answer         POST  '/api/sessions/{sid}/answer' '{"qid":"nope","text":"x"}'
sprobe /api/sessions/{sid}/questions/{qid} PATCH '/api/sessions/{sid}/questions/nope' '{"status":"answered"}'
sprobe /api/sessions/{sid}/questions/{qid}/reopen POST '/api/sessions/{sid}/questions/nope/reopen' '{}'
sprobe /api/sessions/{sid}/questions/{qid}/answer POST '/api/sessions/{sid}/questions/nope/answer' '{"text":"x"}'
sprobe /api/sessions/{sid}/build          POST  '/api/sessions/{sid}/build' '{}'
sprobe /api/sessions/{sid}/stop           POST  '/api/sessions/{sid}/stop' '{"target":"all"}'
# 对话轮真的会去调模型，25s 的默认超时不够（超时会记成 `000`，看起来像差异）。
sprobe /api/sessions/{sid}/chat           POST  '/api/sessions/{sid}/chat' '{"text":"你好"}' -m 120
sprobe /api/sessions/{sid}/stream         GET   '/api/sessions/{sid}/stream?since=0' '' -m 3

# ── 产物侧：换一对**新会话** ──────────────────────────────────────────────
# 上面那批探针在两侧留下的痕迹不一样（Python 的 `/chat` 真跑通了、会往会话目录
# 写东西，TS 的还没接线），继续用同一个会话去问 `/bundle` 只会比出"上一条探针
# 的副作用"，不是这条路由本身的行为。产物侧从干净会话重新开始。
PY_SID=$(jpost "$PYPORT" /api/sessions '{"title":"A"}' '.id')
TS_SID=$(jpost "$TSPORT" /api/sessions '{"title":"A"}' '.id')
echo "  产物侧 py sid=$PY_SID   ts sid=$TS_SID"
sprobe /api/sessions/{sid}/artifacts/{n}  GET   '/api/sessions/{sid}/artifacts/oir.json'
sprobe /api/sessions/{sid}/export         GET   '/api/sessions/{sid}/export?seq=1'
sprobe /api/sessions/{sid}/exports/{n}    GET   '/api/sessions/{sid}/exports/nope.md'
sprobe /api/sessions/{sid}/bundle         GET   '/api/sessions/{sid}/bundle'
sprobe /api/sessions/{sid}/source         GET   '/api/sessions/{sid}/source?file=nope&seq=1'
sprobe /api/sessions/{sid}/audit          POST  '/api/sessions/{sid}/audit' '{}'

# ── 材料与删除：再换一对新会话 ────────────────────────────────────────────
PY_SID=$(jpost "$PYPORT" /api/sessions '{"title":"B"}' '.id')
TS_SID=$(jpost "$TSPORT" /api/sessions '{"title":"B"}' '.id')
echo "  材料侧 py sid=$PY_SID   ts sid=$TS_SID"
sprobe /api/sessions/{sid}/files          POST  '/api/sessions/{sid}/files' '' \
        -F 'files=@'"$REPO"'/README.md'

# 传完材料两侧都会起一个**后台**任务去算推荐问题（`_emit_ai_prompts`），它握着
# chat 租约，这期间任何领域修改都是 409。Python 那边真的会去调模型，一次要二三十
# 秒；TS 那边 `_chat_run` 还没接线、瞬间就结束了。于是同一条 DELETE 在 py 上是
# 409、在 ts 上是 200 —— **这不是行为差异，是两边后台任务的时长不同**。
#
# 所以这两条探针等后台落定再比：只要两边还没一致、且至少一边是 409（"另一个领域
# 修改尚未提交"），就重试。**不是**在掩盖差异 —— 真正的差异不会因为多等一会儿
# 就消失，而这个会。
# 等法：拿一条**幂等**的领域修改（改成同名的 PATCH）去探路，直到两边都不再 409。
# 绝不能拿 DELETE 本身去重试 —— 第一次就已经删成功了，第二次自然 404。
settle() {
  local i ok=0
  # 先让出两秒：后台任务是 `create_task` 起的，它还没抢到租约时第一轮探路会
  # 假阳性通过。同理要求**连续两轮**干净才算落定。
  sleep 3
  for i in $(seq 1 24); do
    local pc tc
    pc=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X PATCH \
        -H 'Content-Type: application/json' -d '{"title":"B"}' \
        "http://127.0.0.1:$PYPORT/api/sessions/$PY_SID")
    tc=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X PATCH \
        -H 'Content-Type: application/json' -d '{"title":"B"}' \
        "http://127.0.0.1:$TSPORT/api/sessions/$TS_SID")
    if [ "$pc" != "409" ] && [ "$tc" != "409" ]; then
      ok=$((ok + 1))
      [ "$ok" -ge 2 ] && return 0
    else
      ok=0
    fi
    sleep 5
  done
  echo "  （提示：等了 120s 后台任务仍占着租约，下面两条探针可能受影响）"
}
settle
sprobe /api/sessions/{sid}/files/{name}   DELETE '/api/sessions/{sid}/files/README.md'
sprobe /api/sessions/{sid}                DELETE '/api/sessions/{sid}'

if [ -n "$PY_PID_" ] && [ "$PY_PID_" != "null" ]; then
  TOTAL=$((TOTAL + 1))
  a=$(curl -s -m 25 -o "$WORK/py.body" -w '%{http_code}\t%{content_type}' -X DELETE \
      "http://127.0.0.1:$PYPORT/api/projects/$PY_PID_")
  b=$(curl -s -m 25 -o "$WORK/ts.body" -w '%{http_code}\t%{content_type}' -X DELETE \
      "http://127.0.0.1:$TSPORT/api/projects/$TS_PID_")
  x=$(shape "${a%%$'\t'*}" "${a#*$'\t'}" "$WORK/py.body")
  y=$(shape "${b%%$'\t'*}" "${b#*$'\t'}" "$WORK/ts.body")
  if [ "$x" = "$y" ]; then SAME=$((SAME+1)); printf '  一致   %-7s %-46s %s\n' DELETE /api/projects/{pid} "${a%%$'\t'*}"
    REPORT+=("一致DELETE /api/projects/{pid}$x")
  else DIFF=$((DIFF+1)); printf '  差异   %-7s %-46s py=%s ts=%s\n' DELETE /api/projects/{pid} "${a%%$'\t'*}" "${b%%$'\t'*}"
    printf '         py: %s\n         ts: %s\n' "$x" "$y"
    REPORT+=("差异DELETE /api/projects/{pid}py: $x ;; ts: $y"); fi
fi

echo
echo "══ 汇总 ═══════════════════════════════════════════════════════════════════"
printf '  %d 条探针：一致 %d，差异 %d\n' "$TOTAL" "$SAME" "$DIFF"
if [ "$DIFF" -gt 0 ]; then
  echo
  echo "  差异清单："
  for r in "${REPORT[@]}"; do
    case "$r" in 差异*) printf '   · %s\n     %s\n' "$(printf '%s' "$r" | cut -d$'\x1f' -f2)" "$(printf '%s' "$r" | cut -d$'\x1f' -f3)";; esac
  done
fi
exit $(( DIFF > 0 ? 1 : 0 ))
