/**
 * 进程入口。`serve.ts` 导出 `main()`，这个文件负责**把工作目录摆正、调它、交出退出码**。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * serve.ts 被测试 import（`serve.wiring.test.ts` 要验 `wireServer()` 的幂等性），
 * 模块体里放启动逻辑意味着 import 它就会试图监听端口 —— 测试之间抢端口，
 * 症状是随机的 EADDRINUSE。入口和库分开，两边都干净。
 *
 * ── 为什么要 chdir ────────────────────────────────────────────
 * 这些路径**全是相对当前工作目录**解析的：
 *
 *     .env            kernel/config.ts 的 loadDotenv(path = ".env")
 *     workspace/      server/session.ts 的 root()
 *     ui/index.html   server/app.ts 的 uiDir()
 *
 * Python 版一直从仓库根启动（`uvicorn ontocopilot.server:app`），所以这件事
 * 从来没人注意。TS 侧的 `npm start` 跑在 `ts/` 里，于是 `.env` 找不到 ——
 * 表现出来是一句莫名其妙的「缺少 LLM 网关配置」，而 `.env` 明明就在那儿。
 *
 * 在入口处一次性把 cwd 摆回仓库根，而不是去改 `loadDotenv` 的默认值：
 * 那个默认值是忠实移植 Python 的语义（相对 cwd），改它等于让同一个函数
 * 在两边行为不同；而且真正错的是"从哪儿启动"，不是"怎么找文件"。
 *
 * **不要数目录层数。** 这里原来写死 `../..`，从 `ts/src/main.ts` 跑是对的，从
 * `ts/dist/src/main.js` 跑就少算了 `dist/` 那一层，cwd 落在 `ts/`：于是开的是
 * `ts/workspace/` 那个空库，零账号 → 门禁判定"全新实例"走开放模式 → 真账号
 * 登不进去，而真库就在旁边。改用 `findRepoRoot` 向上找标志物，两种布局都成立。
 *
 * ── 为什么这里也要 loadDotenv ────────────────────────────────
 * `serve.ts` 的 `parseArgs` 跑在 `startServer` **之前**，而 `.env` 原本要等
 * `app.ts` 起 lifespan 时才载。于是 `.env` 里的 `ONTOCOPILOT_PORT` 对参数默认值
 * 根本不可见 —— 端口只能靠命令行传，每次启动一个样。在 chdir 之后立刻载一次，
 * `override=false` 保证真实环境变量与 node `--env-file` 仍然优先。
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotenv } from "./kernel/config.js";
import { findRepoRoot } from "./repo_root.js";
import { main } from "./serve.js";

process.chdir(findRepoRoot(dirname(fileURLToPath(import.meta.url))));
loadDotenv();

process.exitCode = await main();
