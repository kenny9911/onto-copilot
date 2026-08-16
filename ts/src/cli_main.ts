#!/usr/bin/env node
/**
 * `cli.py` 末尾那段 `if __name__ == "__main__": sys.exit(main())` 的对等物。
 *
 * **单独一个文件**，因为 `cli.ts` 会被测试 import —— 把自动执行写进那个模块，
 * 一 import 就会去解析 `process.argv`、动数据库、退进程。
 *
 * 用 `process.exitCode` 而不是 `process.exit()`：后者会在 stdout 是管道时
 * **截断还没冲出去的输出**（`ontocopilot users | head` 会丢行）。
 */

import { main } from "./cli.js";

process.exitCode = await main();
