#!/usr/bin/env node
/**
 * `serve.py` 末尾那段 `if __name__ == "__main__": sys.exit(main())` 的对等物。
 *
 * **单独一个文件**（与 `cli_main.ts` 同一个理由）：`serve.ts` 会被测试 import ——
 * 把自动执行写进那个模块，一 import 就会去解析 `process.argv`、连库、占端口。
 *
 * 不用 `process.exit()`：main 起完监听就返回，进程靠还开着的 socket 活着；
 * 显式退出会把服务当场关掉。
 */

import { main } from "./serve.js";

process.exitCode = await main();
