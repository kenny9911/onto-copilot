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
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./serve.js";

// ts/src/main.ts → 仓库根是上两级
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

process.exitCode = await main();
