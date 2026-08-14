#!/bin/zsh
# OntoCopilot 重启 —— 前后端是**同一个进程**（TS 服务在 / 直接吐前端），所以只有一个。
#
#   ./restart.sh              # 默认 8000
#   ./restart.sh 8010         # 换端口
#   PORT=8010 ./restart.sh    # 同上
#
# 为什么不是一句 `pkill node && npm start`：
#   1. `pkill node` 会连你别的 Node 项目一起杀。这里**按端口收尸**，只动占着这个
#      端口的那个进程。
#   2. 旧进程没退干净时，新进程绑不上端口就死了，而浏览器刷新看到的还是**旧代码** ——
#      这个坑在这次迁移里真的踩过一次，一整轮验证等于在测几小时前的东西。
#      所以下面等到端口真的空出来才启动，等不到就报错退出，不装作成功。
set -u

ROOT="${0:A:h}"
PORT="${1:-${PORT:-8000}}"

echo "==> 停掉占用 :$PORT 的进程"
pids=$(lsof -ti "tcp:$PORT" 2>/dev/null)
if [[ -n "$pids" ]]; then
  echo "$pids" | xargs kill 2>/dev/null
  # 先给 SIGTERM 一点时间：serve.ts 的 SIGTERM 处理器要把 lifespan 收尾跑完
  # （排空用量流水、写完会话事件、关库）。直接 -9 的话「重启之后账少了一笔」
  # 就是这么来的。
  for i in {1..20}; do
    lsof -ti "tcp:$PORT" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
    echo "    还没退，强制杀"
    lsof -ti "tcp:$PORT" | xargs kill -9 2>/dev/null
    sleep 1
  fi
  echo "    已停"
else
  echo "    端口本来就是空的"
fi

if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "!! :$PORT 仍被占用，放弃启动（不然新进程绑不上，你会以为在跑新代码）" >&2
  exit 1
fi

# 前端是构建产物（React 打包内联进 ui/index.html）。源码改了没重新构建的话，
# 页面上看到的还是上一次的 —— 这一步很快，且 --check 会告诉你有没有漂移。
echo "==> 构建前端"
( cd "$ROOT/ts" && npm run --silent build:ui ) || { echo "!! 前端构建失败" >&2; exit 1; }

echo "==> 启动 :$PORT"
cd "$ROOT/ts"
exec npx --silent tsx src/main.ts --port "$PORT"
