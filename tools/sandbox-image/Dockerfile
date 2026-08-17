# OntoCopilot 沙箱镜像。
#
# 基底用 node:22-alpine（这台机器到不了 registry，24 拉不下来）。node 22 跑 .mts
# 需要显式开类型剥离 —— 装进 NODE_OPTIONS，沙箱的 command() 因此不必为 node 版本分叉。
FROM node:22-alpine
ENV NODE_OPTIONS=--experimental-strip-types

# arquero 及其依赖直接从**宿主的 node_modules** 复制，不是 npm i：
#   1. 容器里没网（--network none 是沙箱的边界，构建期这台机器也到不了 registry）；
#   2. 这样容器里的版本与宿主**必然一致** —— 本地档挂的就是宿主那一份，
#      两档跑同一段代码得到同一个结果，否则"本地能跑容器跑不了"会变成常态。
COPY nm /sbx/node_modules

WORKDIR /out
