/**
 * 把 `migrations/` 应用到 Postgres 上。
 *
 * **为什么需要这个文件。** Postgres 上 schema 的唯一来源就是 `migrations/`
 * （`store/engine.ts` 明确拒绝在 PG 上 `create_all`，免得线上表结构有两个答案），
 * 可仓库里只有 `upgrade()` 这个库函数，没有任何入口在启动时调它。结果是：
 * 拿一个空 PG 库起服务，进程能起来、端口也绑上，直到第一次点页面才炸。
 * `restart.sh` 在起应用之前调这里，把那段空窗关掉。
 *
 * SQLite 不走这条路（表由 `Store.open(create_all)` 建），所以遇到 SQLite 直接
 * 说清楚并退 2，而不是假装跑过。
 *
 * ── cwd 与 .env ────────────────────────────────────────────────
 * 抄 `src/main.ts` 的做法：先把 cwd 摆回仓库根，再 `loadDotenv()`。`DATABASE_URL`
 * 通常只写在 `.env` 里、并没有 export 到 shell，不载的话这里会看成"没配"，
 * 于是在一个明明配了 PG 的仓库上报"这是 SQLite 模式"。`migrations/` 的发现
 * 也是相对 cwd 的，同一个 chdir 一并解决。
 *
 *     npx tsx ts/tools/migrate.mts        # 从哪个目录跑都行
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ts/tools/migrate.mts → 仓库根是上两级
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

const { loadDotenv } = await import("../src/kernel/config.js");
loadDotenv();

const { Store, databaseUrl } = await import("../src/store/engine.js");
const { upgrade, discover } = await import("../src/store/migrate.js");
type MigrationEngine = import("../src/store/migrate.js").MigrationEngine;

const url = databaseUrl();
if (!url) {
  console.error("✗ DATABASE_URL 没设 —— 这是 SQLite 模式，不需要迁移（表由 Store.open 建）。");
  process.exit(2);
}

const store = await Store.open(url);
try {
  if (store.engine === null || store.engine.dialect !== "postgresql") {
    console.error(`✗ 迁移只跑 Postgres，当前 ${store.engine?.dialect ?? "无引擎"}。`);
    process.exit(2);
  }
  const total = discover().length;
  // upgrade() 自己会拿 advisory lock，所以多个副本同时起也只有一个真的在写。
  const ran = await upgrade(store.engine as unknown as MigrationEngine);
  console.log(
    ran.length === 0
      ? `✓ 迁移已是最新（共 ${total} 个）`
      : `✓ 应用了 ${ran.length} 个迁移：${ran.join(", ")}（共 ${total} 个）`,
  );
} finally {
  await store.close();
}
