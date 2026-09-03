/**
 * store/engine.ts。
 *
 * 期望值**全部来自 golden/store.engine.json** —— 那是 Python 侧 `Store.open()` 真跑出来
 * 的库形状（PRAGMA 快照），不是我对 engine.py 的理解。手写"这张表应该有几列"是最不可信
 * 的一类断言：schema 有 27 张表、200 多列，抄错一个 NOT NULL 谁也看不出来。
 *
 * 比对的是 `table_info` / `index_list` / `index_info` / `foreign_key_list`，不是 DDL 文本：
 * TS 侧给所有标识符加引号、SQLAlchemy 只给保留字加，那是同一个库的两种写法。
 * **例外**是老库升级路径上那三张表 —— 它们的 CREATE 语句两边逐字相同（重建 DDL 是
 * 从 engine.py 抄的字面量，ALTER 也是同一条语句），所以连 `sql` 一起钉住。
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import {
  DEFAULT_MAX_OVERFLOW,
  DEFAULT_POOL_SIZE,
  SQLITE_SCHEMA_VERSION,
  Store,
  createAllSqlite,
  databaseUrl,
  isMemoryUrl,
  isPostgresUrl,
  pgConnectionString,
  pgPoolOptions,
  sqliteFilename,
  sqliteTableDdl,
  upgradeSqliteCompat,
} from "../src/store/engine.js";
import {
  getRepo,
  getStore,
  lifespan,
  registerRepoBuilder,
  setRepoForTests,
  shutdownStore,
  startStore,
  workspaceRoot,
} from "../src/store/deps.js";
import { sqliteTables } from "../src/store/schema.js";

interface GoldenDump {
  user_version: number;
  tables: Record<
    string,
    {
      columns: { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
      foreign_keys: Record<string, unknown>[];
      indexes: { name: string; unique: number; origin: string; partial: number; columns: string[] }[];
      sql: string;
    }
  >;
  healthcheck: Record<string, unknown>;
  mode: string;
  rows?: Record<string, Record<string, unknown>[]>;
  setup_sql?: string[];
}

interface Golden {
  constants: Record<string, number>;
  database_url: { env: Record<string, string>; out: string }[];
  memory: { mode: string; enabled: boolean; healthcheck: Record<string, unknown> };
  fresh: GoldenDump;
  reopen: GoldenDump;
  legacy: GoldenDump;
  legacy_unknown_schema: { type: string; message: string; setup_sql: string[] };
}

const golden = JSON.parse(
  readFileSync(new URL("../../golden/store.engine.json", import.meta.url), "utf8"),
) as Golden;

/** 在**另一个进程**里拿 EXCLUSIVE 锁握 400ms 再放。写成字符串喂给 `node -e` 是因为
 * 它必须是独立进程：node:sqlite 同步 API 在同进程里握锁会把事件循环一起冻住。 */
const HOLD_EXCLUSIVE = [
  'const { DatabaseSync } = require("node:sqlite");',
  "const d = new DatabaseSync(process.env.OC_TEST_DB);",
  'd.exec("PRAGMA locking_mode=EXCLUSIVE");',
  'd.exec("BEGIN IMMEDIATE");',
  'd.exec("CREATE TABLE IF NOT EXISTS _lockprobe(a)");',
  'process.stdout.write("LOCKED\\n");',
  'setTimeout(() => { d.exec("COMMIT"); d.close(); }, 400);',
].join("\n");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ontocopilot-engine-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 与 golden 里 `dump()` 同形的 PRAGMA 快照。**用 node:sqlite 直接读**，不走被测的
 * engine —— 断言的尺子不该是被测对象自己。 */
function dump(path: string): Omit<GoldenDump, "healthcheck" | "mode"> {
  const db = new DatabaseSync(path);
  try {
    const uv = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"))
      .sort();
    const tables: GoldenDump["tables"] = {};
    for (const t of names) {
      const columns = db.prepare(`PRAGMA table_info("${t}")`).all() as GoldenDump["tables"][string]["columns"];
      const fks = (db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Record<string, unknown>[])
        .map((r) => ({
          table: r["table"],
          from: r["from"],
          to: r["to"],
          on_update: r["on_update"],
          on_delete: r["on_delete"],
          match: r["match"],
        }))
        .sort((a, b) => `${String(a.table)}${String(a.from)}`.localeCompare(`${String(b.table)}${String(b.from)}`));
      const indexes = (
        db.prepare(`PRAGMA index_list("${t}")`).all() as {
          name: string;
          unique: number;
          origin: string;
          partial: number;
        }[]
      )
        .map((r) => ({
          name: r.name,
          unique: r.unique,
          origin: r.origin,
          partial: r.partial,
          columns: (db.prepare(`PRAGMA index_info("${r.name}")`).all() as { name: string }[]).map(
            (c) => c.name,
          ),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(t) as { sql: string };
      tables[t] = { columns, foreign_keys: fks, indexes, sql: row.sql };
    }
    return { user_version: uv.user_version, tables };
  } finally {
    db.close();
  }
}

/** golden 只存了 PRAGMA 能读到的字段；比对时把 `sql` 摘掉（见文件头）。 */
function withoutSql(d: { tables: GoldenDump["tables"] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(d.tables)) {
    out[name] = { columns: t.columns, foreign_keys: t.foreign_keys, indexes: t.indexes };
  }
  return out;
}

function seed(path: string, statements: readonly string[]): void {
  const db = new DatabaseSync(path);
  try {
    for (const s of statements) db.exec(s);
  } finally {
    db.close();
  }
}

const urlFor = (path: string): string => `sqlite+aiosqlite:///${path}`;

describe("常量与 URL 规范化", () => {
  it("常量与 Python 侧一致", () => {
    expect({
      DEFAULT_POOL_SIZE,
      DEFAULT_MAX_OVERFLOW,
      SQLITE_SCHEMA_VERSION,
    }).toEqual(golden.constants);
  });

  it("databaseUrl 逐条对 golden", () => {
    for (const c of golden.database_url) {
      expect(databaseUrl(c.env), JSON.stringify(c.env)).toBe(c.out);
    }
  });

  it("databaseUrl 不传 env 时读 process.env", () => {
    const saved = process.env["DATABASE_URL"];
    try {
      process.env["DATABASE_URL"] = " postgres://u@h/db ";
      expect(databaseUrl()).toBe("postgresql+asyncpg://u@h/db");
      delete process.env["DATABASE_URL"];
      expect(databaseUrl()).toBe("");
    } finally {
      if (saved === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = saved;
    }
  });

  // Python 侧没有对应函数（SQLAlchemy 自己解 URL），是 TS 侧新增的风险点，自己补用例。
  it("sqliteFilename 认得 SQLAlchemy 的斜杠约定", () => {
    expect(sqliteFilename("sqlite+aiosqlite:////tmp/x.db")).toBe("/tmp/x.db");
    expect(sqliteFilename("sqlite:///rel.db")).toBe("rel.db");
    expect(sqliteFilename("sqlite+aiosqlite:///:memory:")).toBe(":memory:");
    expect(sqliteFilename("sqlite://")).toBe(":memory:");
    expect(sqliteFilename("sqlite:///f.db?cache=shared")).toBe("f.db");
    expect(sqliteFilename("sqlite:///f.db?mode=memory")).toBe(":memory:");
  });

  it("mode/dialect 判定与 Python 的 startswith 一致", () => {
    expect(isPostgresUrl("postgresql+asyncpg://h/db")).toBe(true);
    expect(isPostgresUrl("postgres://h/db")).toBe(false); // 规范化之后才是 postgresql
    expect(isPostgresUrl("Postgresql://h/db")).toBe(false); // 大小写敏感
    expect(isMemoryUrl("sqlite:///:memory:")).toBe(true);
    expect(isMemoryUrl("sqlite:///f.db?mode=memory")).toBe(true);
    expect(isMemoryUrl("sqlite:///f.db")).toBe(false);
  });

  it("pgConnectionString 摘掉 SQLAlchemy 的 driver 后缀", () => {
    expect(pgConnectionString("postgresql+asyncpg://u:p@h/db")).toBe("postgresql://u:p@h/db");
    expect(pgConnectionString("postgresql://u:p@h/db")).toBe("postgresql://u:p@h/db");
  });
});

describe("pool 参数", () => {
  it("默认值", () => {
    expect(pgPoolOptions({})).toEqual({
      poolPrePing: true,
      poolSize: DEFAULT_POOL_SIZE,
      maxOverflow: DEFAULT_MAX_OVERFLOW,
      poolRecycle: 1800,
    });
  });

  it("环境变量覆盖", () => {
    expect(pgPoolOptions({ DB_POOL_SIZE: "20", DB_MAX_OVERFLOW: " 7 " })).toMatchObject({
      poolSize: 20,
      maxOverflow: 7,
    });
  });

  // Python 的 int("abc") 抛 ValueError；Number("abc") 是 NaN、Number("") 是 0，
  // 两个都会把配置错误吞掉，所以这里必须炸。
  it("配错了当场炸，不是悄悄回落到默认值", () => {
    expect(() => pgPoolOptions({ DB_POOL_SIZE: "abc" })).toThrow(/invalid literal for int/);
    expect(() => pgPoolOptions({ DB_POOL_SIZE: "" })).toThrow(/invalid literal for int/);
    expect(() => pgPoolOptions({ DB_MAX_OVERFLOW: "5.5" })).toThrow(/invalid literal for int/);
  });
});

describe("内存模式", () => {
  it("URL 为空 → 内存模式，不抛异常", async () => {
    const store = await Store.open("");
    expect({ mode: store.mode, enabled: store.enabled }).toEqual({
      mode: golden.memory.mode,
      enabled: golden.memory.enabled,
    });
    expect(await store.healthcheck()).toEqual(golden.memory.healthcheck);
    await store.close();
  });

  it("lifespan 收尾一定关引擎", async () => {
    const store = await Store.open("sqlite:///:memory:");
    let seen = false;
    await store.lifespan(async (s) => {
      seen = s === store;
      return Promise.resolve();
    });
    expect(seen).toBe(true);
  });
});

describe("零配置 SQLite 建库", () => {
  it("新库的形状与 Python 逐个 PRAGMA 相同", async () => {
    const path = join(dir, "fresh.db");
    const store = await Store.open(urlFor(path), { createAll: true });
    const health = await store.healthcheck();
    await store.close();

    const got = dump(path);
    expect(got.user_version).toBe(golden.fresh.user_version);
    expect(Object.keys(got.tables)).toEqual(Object.keys(golden.fresh.tables));
    expect(withoutSql(got)).toEqual(withoutSql(golden.fresh));
    expect(health).toEqual(golden.fresh.healthcheck);
    expect(store.mode).toBe(golden.fresh.mode);
  });

  it("再开一次是幂等的", async () => {
    const path = join(dir, "reopen.db");
    for (let i = 0; i < 2; i++) {
      const store = await Store.open(urlFor(path), { createAll: true });
      await store.close();
    }
    const got = dump(path);
    expect(got.user_version).toBe(golden.reopen.user_version);
    expect(withoutSql(got)).toEqual(withoutSql(golden.reopen));
  });

  it("生成的 session DDL 里必须有 queued/stopped", () => {
    // 这两个词是升级器判断"要不要重建"的唯一依据（engine.py:211）。TS 建的库将来被
    // Python 打开时，少一个词就会触发一次没必要的整表重建。
    const ddl = sqliteTableDdl("session");
    expect(ddl).toContain("'queued'");
    expect(ddl).toContain("'stopped'");
  });
});

describe("老库兼容升级", () => {
  it("三条补丁都打上，数据不丢，且与 Python 升级出来的库一致", async () => {
    const path = join(dir, "legacy.db");
    seed(path, golden.legacy.setup_sql ?? []);
    const store = await Store.open(urlFor(path), { createAll: true });
    const health = await store.healthcheck();
    await store.close();

    const got = dump(path);
    expect(got.user_version).toBe(golden.legacy.user_version);
    expect(Object.keys(got.tables)).toEqual(Object.keys(golden.legacy.tables));
    expect(withoutSql(got)).toEqual(withoutSql(golden.legacy));
    expect(health).toEqual(golden.legacy.healthcheck);

    // 升级路径上这三张表的 CREATE 语句两边逐字相同（见文件头）。
    for (const t of ["session", "session_event", "app_user"]) {
      expect(got.tables[t]?.sql, t).toBe(golden.legacy.tables[t]?.sql);
    }

    // 重建 session 表最容易把数据弄丢。
    const db = new DatabaseSync(path);
    try {
      for (const [t, want] of Object.entries(golden.legacy.rows ?? {})) {
        const order = t === "session_event" ? "seq" : "id";
        expect(db.prepare(`SELECT * FROM "${t}" ORDER BY ${order}`).all(), t).toEqual(want);
      }
    } finally {
      db.close();
    }
  });

  it("session 重建之后 create_all 不再补 session_project_idx", () => {
    // 这不是"应该"，是 Python 的**真实行为**：create_all 只建缺的表，表在就整张跳过，
    // 连索引一起。golden 把这条钉住了，TS 侧必须一样地"缺"，否则两边的库不一样。
    const fresh = golden.fresh.tables["session"]?.indexes.map((i) => i.name) ?? [];
    const legacy = golden.legacy.tables["session"]?.indexes.map((i) => i.name) ?? [];
    expect(fresh).toContain("session_project_idx");
    expect(legacy).not.toContain("session_project_idx");
  });

  it("未知列结构必须显式失败", async () => {
    const path = join(dir, "unknown.db");
    seed(path, golden.legacy_unknown_schema.setup_sql);
    await expect(Store.open(urlFor(path), { createAll: true })).rejects.toThrow(
      golden.legacy_unknown_schema.message,
    );
    // 失败之后库必须原样：整段升级是在一个事务里跑的。
    const db = new DatabaseSync(path);
    try {
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name);
      expect(names.sort()).toEqual(["app_user", "session", "session_event"]);
    } finally {
      db.close();
    }
  });

  it("空库上的升级器是空操作", async () => {
    const path = join(dir, "empty.db");
    const store = await Store.open(urlFor(path), { createAll: true });
    await store.engine?.connect(async (conn) => {
      await upgradeSqliteCompat(conn);
      await createAllSqlite(conn);
    });
    await store.close();
    expect(withoutSql(dump(path))).toEqual(withoutSql(golden.fresh));
  });
});

describe("引擎能真的用（repo 层要的那一半）", () => {
  it("drizzle 往返 + 事务回滚", async () => {
    const store = await Store.open(urlFor(join(dir, "rw.db")), { createAll: true });
    const engine = store.engine;
    expect(engine).not.toBeNull();
    if (engine === null) return;

    await engine.begin(async (conn) => {
      await conn.db
        .insert(sqliteTables.session)
        .values({ id: "s1", title: "标题", project: "", status: "idle" })
        .run();
    });
    const rows = await engine.connect(async (conn) =>
      conn.db.select().from(sqliteTables.session).all(),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string; title: string }).title).toBe("标题");

    // 抛出去就必须 ROLLBACK —— 这条是"事务边界互相穿插"那场事故的底线。
    await expect(
      engine.begin(async (conn) => {
        await conn.db.insert(sqliteTables.session).values({ id: "s2", title: "回滚" }).run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await engine.connect(async (conn) =>
      conn.db.select().from(sqliteTables.session).all(),
    );
    expect(after).toHaveLength(1);

    // drizzle 自己的 `db.transaction()`（sqlite-proxy 就是发 begin/commit）也得能用 ——
    // repo 层多半会直接用它，而不是每次都经过 engine.begin。
    await engine.connect(async (conn) => {
      await expect(
        conn.db.transaction(async (tx) => {
          await tx.insert(sqliteTables.session).values({ id: "s3" }).run();
          throw new Error("nope");
        }),
      ).rejects.toThrow("nope");
    });
    expect(
      await engine.connect(async (conn) => conn.scalar("SELECT COUNT(*) FROM session")),
    ).toBe(1);
    await store.close();
  });

  it("每条连接都开着 foreign_keys —— 删会话要连带删事件", async () => {
    // SQLite 的 foreign_keys 是**每连接**的开关，默认 OFF。漏开的症状不是报错，是库里
    // 慢慢攒下一堆孤儿行。
    const store = await Store.open(urlFor(join(dir, "fk.db")), { createAll: true });
    const engine = store.engine;
    if (engine === null) throw new Error("engine 不该是 null");

    await engine.begin(async (conn) => {
      await conn.exec("INSERT INTO session (id) VALUES ('s1')");
      await conn.exec(
        "INSERT INTO session_event (session_id,seq,kind,ts) VALUES ('s1',0,'x',1.0)",
      );
    });
    await engine.begin(async (conn) => {
      await conn.exec("DELETE FROM session WHERE id='s1'");
    });
    const left = await engine.connect(async (conn) =>
      conn.scalar("SELECT COUNT(*) FROM session_event"),
    );
    expect(left).toBe(0);

    // WAL 与 busy_timeout 也必须落到每条连接上（文件库才有）。
    const mode = await engine.connect(async (conn) => conn.scalar("PRAGMA journal_mode"));
    expect(mode).toBe("wal");
    const busy = await engine.connect(async (conn) => conn.scalar("PRAGMA busy_timeout"));
    expect(busy).toBe(30000);
    await store.close();
  });

  it("别的进程握着排他锁时，借连接要等而不是当场抛（那 91 条 database is locked 的回归用例）", async () => {
    // 生产上 /tmp/ontocopilot-8765.stderr.log 里累计 91 条 `database is locked`，
    // 栈顶**无一例外**是 openRaw 里 `PRAGMA journal_mode=WAL` 那一行。
    //
    // 那一行会抛**跟 WAL 转换无关**：`new DatabaseSync()` 和 `PRAGMA foreign_keys`
    // 都不碰文件（SQLite 惰性打开），`PRAGMA journal_mode` 要读 schema，于是它成了
    // 第一条真正对库文件加锁的语句 —— 任何锁争用都会把栈顶钉在那儿。
    // 而 `PRAGMA busy_timeout` 写在它**下一行**，所以撞锁的那一刻 busy handler
    // 还没装上：0 重试、亚毫秒直接抛。实测同一竞争下，顺序一换就从"0ms 抛"变成"等 514ms 成功"。
    //
    // 争用窗口是 engine 自己造的：文件库每次借出新开连接、用完就 close，而 WAL 库
    // 关掉**最后一条**连接时 SQLite 会 checkpoint 并 unlink -wal/-shm，全程持排他锁。
    // 进程内有 gate 互斥所以自己不撞自己，但只要出现第二个进程（一条 sqlite3 只读
    // 查询就够格），命中率就是两位数百分比。
    const path = join(dir, "busy.db");
    const store = await Store.open(urlFor(path), { createAll: true });
    const engine = store.engine!;
    // 先借一次再还，让库落到"是 WAL、但一条连接都不开着"的静止态 —— 就是生产的样子。
    await engine.connect(async (conn) => conn.scalar("SELECT 1"));

    // node:sqlite 是同步 API，同进程里握锁会把事件循环一起冻住，所以必须真开一个进程。
    const child = spawn(process.execPath, ["-e", HOLD_EXCLUSIVE], {
      env: { ...process.env, OC_TEST_DB: path },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("LOCKED")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("子进程没拿到锁就退了")));
    });

    const t0 = Date.now();
    await expect(engine.connect(async (conn) => conn.scalar("SELECT 1"))).resolves.toBe(1);
    // 真的等了才算数：若锁没握住，这一句会瞬间返回，测试就没有测到东西。
    expect(Date.now() - t0).toBeGreaterThan(100);

    await new Promise((r) => child.once("exit", r));
    await store.close();
  });

  // root 无视目录权限位，造不出下面那个"必定抛"的条件。
  it.skipIf(process.getuid?.() === 0 || !existsSync("/dev/fd"))(
    "openRaw 抛错时不许漏掉连接句柄",
    async () => {
      // openRaw 里 `new DatabaseSync()` 成功、后面某条 PRAGMA 抛了的话，那个句柄
      // 没有任何人再去 close —— 每抛一次漏一个 fd。上面那条 busy_timeout 修复让
      // 撞锁不再抛，但错误路径本身还在：撞锁超过 30 秒、或库文件/目录不可写都会走到。
      //
      // 确定性触发器：把库所在目录改成只读。WAL 要在同目录建 -wal/-shm，建不了就抛
      // SQLITE_READONLY_DIRECTORY(1544)，而且抛在 `new DatabaseSync()` **之后**，
      // 正好是漏句柄的那个窗口。
      const sub = join(dir, "leaky");
      mkdirSync(sub);
      const path = join(sub, "leak.db");
      const seed = await Store.open(urlFor(path), { createAll: true });
      const engine = seed.engine!;
      await engine.connect(async (conn) => conn.scalar("SELECT 1"));

      chmodSync(sub, 0o555);
      try {
        const before = readdirSync("/dev/fd").length;
        let threw = 0;
        for (let i = 0; i < 5; i++) {
          await engine.connect(async (conn) => conn.scalar("SELECT 1")).catch(() => threw++);
        }
        expect(threw).toBe(5); // 触发器没生效的话，下面那条断言就是白给的
        expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(before);
      } finally {
        chmodSync(sub, 0o755);
        await seed.close();
      }
    },
  );

  it("dialect 用的是 repo 比较的那个字面量", async () => {
    // repo.py:1418 是 `self.mode = engine.dialect.name`，拿去和 "postgresql" 比。
    // Store.mode 却是 "postgres" —— 两个词，别顺手统一。
    const store = await Store.open("sqlite:///:memory:");
    expect(store.engine?.dialect).toBe("sqlite");
    expect(store.mode).toBe("sqlite");
    await store.close();
    const pg = await Store.open("postgresql+asyncpg://h/db");
    expect(pg.engine?.dialect).toBe("postgresql");
    expect(pg.mode).toBe("postgres");
    await pg.close();
  });

  it("并发事务不会互相穿插（那场丢事件事故的回归用例）", async () => {
    // Python 侧 StaticPool 把同一条连接同时借给多个 checkout，读改写就这样丢掉了
    // next_event_seq 的更新。这里 20 个事务各读一次、加一、写回；只要有一次穿插，
    // 结果就小于 20。
    const store = await Store.open(urlFor(join(dir, "race.db")), { createAll: true });
    const engine = store.engine;
    if (engine === null) throw new Error("engine 不该是 null");
    await engine.begin(async (conn) => conn.exec("INSERT INTO session (id) VALUES ('s1')"));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        engine.begin(async (conn) => {
          const cur = Number(
            await conn.scalar("SELECT next_event_seq FROM session WHERE id='s1'"),
          );
          await conn.exec("UPDATE session SET next_event_seq=? WHERE id='s1'", [cur + 1]);
        }),
      ),
    );
    const seq = await engine.connect(async (conn) =>
      conn.scalar("SELECT next_event_seq FROM session WHERE id='s1'"),
    );
    expect(seq).toBe(20);
    await store.close();
  });

  it("嵌套借用是说得清的错误，不是静默死锁", async () => {
    const store = await Store.open("sqlite:///:memory:");
    const engine = store.engine;
    if (engine === null) throw new Error("engine 不该是 null");
    await expect(engine.begin(async () => engine.connect(async () => Promise.resolve(1)))).rejects.toThrow(
      /不能嵌套/,
    );
    // 外层出错之后引擎还能继续用（互斥必须已经释放）。
    expect(await engine.connect(async (conn) => conn.scalar("SELECT 1"))).toBe(1);
    await store.close();
  });

  it("drizzle 的 sql 模板与 scalar 都通", async () => {
    const store = await Store.open("sqlite:///:memory:", { createAll: true });
    const engine = store.engine;
    if (engine === null) throw new Error("engine 不该是 null");
    // **给 repo track 的提醒**：sqlite-proxy 对裸 `sql` 模板返回的是**位置行**
    // （drizzle 只有拿到列清单才映射成对象）。要对象行就用 `db.select()`，
    // 或者走 `conn.all()`（它直接给对象行）。
    const one = await engine.connect(async (conn) => conn.db.get<number[]>(sql`select 1 as n`));
    expect(one).toEqual([1]);
    const obj = await engine.connect(async (conn) => conn.all("select 1 as n"));
    expect(obj).toEqual([{ n: 1 }]);
    // 内存库必须是**同一个库**：建完表之后另一次 checkout 还看得见它。
    const tables = await engine.connect(async (conn) =>
      conn.scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table'"),
    );
    expect(Number(tables)).toBe(Object.keys(golden.fresh.tables).length);
    await store.close();
  });
});

describe("deps —— 启动选路", () => {
  /** deps 的状态是**进程级单例**（连接池就该是进程级的），所以每个用例自己收干净。 */
  async function withEnv(
    env: Record<string, string | undefined>,
    body: () => Promise<void>,
  ): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await body();
    } finally {
      await shutdownStore();
      registerRepoBuilder(null);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("workspaceRoot 的默认值与空串折平", () => {
    const saved = process.env["ONTOCOPILOT_WORKSPACE"];
    try {
      delete process.env["ONTOCOPILOT_WORKSPACE"];
      expect(workspaceRoot()).toBe("workspace");
      process.env["ONTOCOPILOT_WORKSPACE"] = "/data/workspace";
      expect(workspaceRoot()).toBe("/data/workspace");
      // Python 侧 Path("") 就是 Path(".")，别让空串一路传到 mkdir 才炸。
      process.env["ONTOCOPILOT_WORKSPACE"] = "";
      expect(workspaceRoot()).toBe(".");
    } finally {
      if (saved === undefined) delete process.env["ONTOCOPILOT_WORKSPACE"];
      else process.env["ONTOCOPILOT_WORKSPACE"] = saved;
    }
  });

  it("没配 DATABASE_URL → 落到 workspace 里的 SQLite 文件（不是丢数据）", async () => {
    const root = join(dir, "ws-zero");
    await withEnv(
      { ONTOCOPILOT_WORKSPACE: root, DATABASE_URL: undefined, ONTOCOPILOT_NO_DB: undefined },
      async () => {
        const store = await startStore();
        expect(store.mode).toBe("sqlite");
        expect(getStore()).toBe(store);
        expect(await store.healthcheck()).toEqual(golden.fresh.healthcheck);
        expect(withoutSql(dump(join(root, "ontocopilot.db")))).toEqual(withoutSql(golden.fresh));
      },
    );
  });

  it("ONTOCOPILOT_NO_DB=1 → 纯内存，且必须是**显式**才走这条路", async () => {
    const root = join(dir, "ws-nodb");
    await withEnv(
      { ONTOCOPILOT_WORKSPACE: root, DATABASE_URL: undefined, ONTOCOPILOT_NO_DB: "1" },
      async () => {
        const store = await startStore();
        expect(store.mode).toBe("memory");
        expect(store.enabled).toBe(false);
      },
    );
  });

  it("显式 DATABASE_URL 指向 SQLite 也建表", async () => {
    const root = join(dir, "ws-explicit");
    const db = join(dir, "explicit.db");
    await withEnv(
      {
        ONTOCOPILOT_WORKSPACE: root,
        DATABASE_URL: urlFor(db),
        ONTOCOPILOT_NO_DB: undefined,
      },
      async () => {
        const store = await startStore();
        expect(store.mode).toBe("sqlite");
        // 不建表的话，healthcheck 会成功，第一次读 app_setting 才 "no such table"。
        expect(withoutSql(dump(db))).toEqual(withoutSql(golden.fresh));
      },
    );
  });

  it("显式配了 DATABASE_URL 却连不上 → 直接失败，绝不偷偷回落到内存", async () => {
    await withEnv(
      {
        ONTOCOPILOT_WORKSPACE: join(dir, "ws-pg"),
        DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
        ONTOCOPILOT_NO_DB: undefined,
      },
      async () => {
        await expect(startStore()).rejects.toThrow(/DATABASE_URL 已配置但连不上/);
      },
    );
  });

  it("repo：没注册就显式报错，注册了就拿得到；测试可以整条换掉", async () => {
    expect(() => getRepo()).toThrow(/仓储未初始化/);
    const fake = { fake: true };
    setRepoForTests(fake);
    expect(getRepo()).toBe(fake);
    setRepoForTests(null);

    const root = join(dir, "ws-repo");
    await withEnv(
      { ONTOCOPILOT_WORKSPACE: root, DATABASE_URL: undefined, ONTOCOPILOT_NO_DB: "1" },
      async () => {
        const built: Store[] = [];
        registerRepoBuilder((s) => {
          built.push(s);
          return fake;
        });
        await lifespan(async (s) => {
          expect(built).toEqual([s]);
          expect(getRepo()).toBe(fake);
          return Promise.resolve();
        });
        // lifespan 收尾之后单例必须清干净。
        expect(() => getRepo()).toThrow(/仓储未初始化/);
        expect(() => getStore()).toThrow(/Store 未初始化/);
      },
    );
  });
});

describe("Postgres 分支", () => {
  it("open 不连库（与 Python 一致），healthcheck 才报错", async () => {
    const store = await Store.open("postgresql+asyncpg://u:p@127.0.0.1:1/db");
    expect(store.mode).toBe("postgres");
    expect(store.enabled).toBe(true);
    const health = await store.healthcheck();
    expect(health.ok).toBe(false);
    // 驱动接上之后（store/pg_driver.ts），这里报的是**真的连不上**，
    // 而不是从前那句"驱动未安装"。原样把驱动的错带出来，别加工。
    expect("error" in health ? health.error : "").toMatch(/ECONNREFUSED|ENOTFOUND|timeout/i);
    await store.close();
  });

  it("pool 参数配错了在 open 时就炸", async () => {
    const saved = process.env["DB_POOL_SIZE"];
    process.env["DB_POOL_SIZE"] = "many";
    try {
      await expect(Store.open("postgresql+asyncpg://h/db")).rejects.toThrow(
        /invalid literal for int/,
      );
    } finally {
      if (saved === undefined) delete process.env["DB_POOL_SIZE"];
      else process.env["DB_POOL_SIZE"] = saved;
    }
  });
});
