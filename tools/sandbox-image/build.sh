#!/usr/bin/env bash
# 构建沙箱镜像 ontocopilot/sandbox:node24。
#
# 容器里 `--network none`，构建期这台机器也到不了 npm registry，所以镜像里的
# arquero **从宿主的 node_modules 复制**，不 npm i。附带的好处更重要：容器里的
# 版本与本地档挂的那一份**必然一致** —— 否则"本地能跑、容器跑不了"会变成常态。
#
# 依赖闭包由 node 自己按 package.json 的 dependencies 递归算出来，不手工列 ——
# 手工列的下场是每加一层依赖就报一次 `Cannot find package 'x'`，追到第三层才发现。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NM="$ROOT/ts/node_modules"
IMAGE="${IMAGE:-ontocopilot/sandbox:node24}"

[ -d "$NM/arquero" ] || { echo "缺 $NM/arquero —— 先在 ts/ 下 npm ci" >&2; exit 1; }

CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp "$(dirname "${BASH_SOURCE[0]}")/Dockerfile" "$CTX/"
mkdir -p "$CTX/nm"

NM="$NM" OUT="$CTX/nm" node --input-type=module -e '
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const NM = process.env.NM, OUT = process.env.OUT;
const deps = (d) => {
  const p = join(NM, d, "package.json");
  return existsSync(p) ? Object.keys(JSON.parse(readFileSync(p, "utf8")).dependencies ?? {}) : [];
};
const seen = new Set(), queue = ["arquero"];
while (queue.length) {
  const n = queue.pop();
  if (seen.has(n) || !existsSync(join(NM, n))) continue;
  seen.add(n);
  cpSync(join(NM, n), join(OUT, n), { recursive: true });
  queue.push(...deps(n));
}
console.error(`依赖闭包 ${seen.size} 个包: ${[...seen].sort().join(", ")}`);
'

docker build -t "$IMAGE" "$CTX"
echo "已构建 $IMAGE"
