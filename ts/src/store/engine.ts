/**
 * 引擎装配与优雅降级 —— 移植自 `store/engine.py`。
 *
 * **降级不是 try/except，是启动时的一次显式选路。**
 * `DATABASE_URL` 没配就走持久 SQLite；只有显式 `ONTOCOPILOT_NO_DB=1` 才走内存模式。
 * 中途连不上**不**偷偷回落到内存 —— 那样用户会以为数据存下来了。这条纪律和
 * `llm_config()`（config.py:52-68）拒绝静默换端点是同一条。
 *
 * 用法：
 * ```ts
 * const store = await Store.open();      // 读 DATABASE_URL
 * store.mode;                            // "postgres" | "sqlite" | "memory"
 * await store.lifespan(async (s) => { ... });
 * ```
 *
 * ── 驱动选型：node:sqlite + drizzle 的 sqlite-proxy ────────────────────────
 *
 * Python 侧是 SQLAlchemy(aiosqlite/asyncpg)，TS 侧按迁移计划是 Drizzle。Drizzle 的
 * SQLite 驱动里 better-sqlite3 / libsql / bun 都要新装依赖（前者还得编原生模块），
 * 而 Node 24 自带 `node:sqlite`，配 drizzle 的 `sqlite-proxy` 正好接上：proxy 要的
 * 就是一个 `(sql, params, method) => rows` 回调，`StatementSync.setReturnArrays(true)`
 * 给的正是它要的位置行。**零新依赖**，事务/savepoint 也是 proxy 自带的（它就是发
 * `begin`/`commit`/`savepoint`）。代价记在 §分叉里。
 *
 * ── 连接策略：StaticPool / NullPool 那条事故的 TS 对应物 ───────────────────
 *
 * Python 侧这段注释（engine.py:84-96）记的是真实事故，逐字迁过来：
 *
 *   **单连接只对内存库成立。** 内存库必须共享一个连接，否则每个连接看到的是不同的
 *   库。但那个 else 分支同时也接住了零配置默认的**文件**库，而 StaticPool 没有借出
 *   上限：它把同一个 DBAPI 连接同时交给每一个并发 checkout。
 *   后果不是变慢，是**静默丢数据**：SSE 每 250ms 轮询一次 read_events，聊天那边在写
 *   事件，两者跑在同一个连接上，事务边界互相穿插 —— 一方的 ROLLBACK 会把另一方正在
 *   进行的写作废。实测 session.next_event_seq 被回退到已提交行的后面，于是下一次
 *   append_event 分配到一个用过的 seq、撞 UNIQUE 约束，重试 5 次全撞同一个号，事件
 *   永远落不了库。而 SSE 只推库里的行 —— 助手的回答就这样从界面上消失，刷新才看得到。
 *
 * TS 侧对应做法：
 *   * 内存库：**必须**共享唯一一个 `DatabaseSync`（同上，不共享就是两个库）；
 *   * 文件库：每次借出**新开一个** `DatabaseSync`，用完就关（== NullPool）；
 *   * 两种模式都**加一把进程内 FIFO 互斥**再借出。`node:sqlite` 是同步 API，进程内
 *     本来就不存在真并行，串行化不损失吞吐，却把上面那类"事务边界互相穿插"从结构上
 *     排除掉 —— 包括内存库那条 Python 侧至今仍暴露着的路径。
 *     另一个必须串行的理由是 `busy_timeout=30000`：同步驱动 + 单事件循环下，两个写
 *     事务真撞上会是**死锁**（等锁的那 30 秒里事件循环停转，持锁的一方跑不动），
 *     而不是 Python 那边的"等一下就好了"。
 *   * 因此：**不要在 `connect`/`begin` 的回调里再 `connect`/`begin`** —— 会死锁。
 *
 * ── 已知分叉（对 Python 侧） ───────────────────────────────────────────────
 *
 *   1. **PG 分支已接上真驱动**（`store/pg_driver.ts`，`pg` + drizzle 的 sqlite-proxy；
 *      为什么不是 `drizzle-orm/node-postgres` 见那个文件的文件头）。仍然**不在
 *      `Store.open()` 时连库** —— 与 Python 的 `create_async_engine` 一样惰性，
 *      失败点是 `healthcheck()`，deps 的 lifespan 照旧抛
 *      "DATABASE_URL 已配置但连不上：…"。剩下的分叉：PG 上 `createAll` 不支持
 *      （schema 只有 migrations/ 一个来源），以及 `SELECT … FOR UPDATE` 仍缺
 *      （那要改 `repo/pg.ts`，见 pg_driver.ts 的分叉 1）。
 *   2. `run()` 拿不到 `changes` / `lastInsertRowid`（sqlite-proxy 的结果类型里没有
 *      这两个字段）。要影响行数就用 `.returning()`。
 *   3. `node:sqlite` 是**同步**的，查询期间事件循环是停的；Python 侧 aiosqlite 走线程池。
 *      本地单进程工具可以接受，但别拿它跑长查询。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { TABLE_NAMES, TABLE_SPECS } from "./schema.js";
import type { ColDefault, ColKind, ColSpec, IndexSpec, TableName, TableSpec } from "./schema.js";

export const DEFAULT_POOL_SIZE = 5;
export const DEFAULT_MAX_OVERFLOW = 5;
// 19：onto_document.folder_path + onto_document_folder（用户手工建的文件夹）。
export const SQLITE_SCHEMA_VERSION = 19;

// ══════════════════════════════════════════════════════════════════
//  URL
// ══════════════════════════════════════════════════════════════════

/** 规范化 `DATABASE_URL`。
 *
 * 接受 `postgres://` / `postgresql://` 这类运维习惯写法，统一补上 `+asyncpg` 驱动 ——
 * 忘了写 driver 的报错（`MissingGreenlet`）极难看懂。
 *
 * **TS 侧照样补 `+asyncpg`**：迁移期两套实现读同一个环境变量，规范化结果必须一模一样，
 * 否则同一份配置在两边算出两个 `store.url`、两条日志、两种 mode 判定。真要把它喂给
 * node 的 PG 驱动时再由 `pgConnectionString()` 摘掉这个后缀。
 */
export function databaseUrl(env?: Readonly<Record<string, string | undefined>>): string {
  const source = env ?? process.env;
  const raw = (source["DATABASE_URL"] ?? "").trim();
  if (!raw) return "";
  for (const prefix of ["postgres://", "postgresql://"]) {
    if (raw.startsWith(prefix)) return "postgresql+asyncpg://" + raw.slice(prefix.length);
  }
  return raw;
}

/** `postgresql+asyncpg://…` → `postgresql://…`。SQLAlchemy 的 driver 后缀是 Python 侧
 * 选驱动用的，node 的 PG 客户端不认识它。 */
export function pgConnectionString(url: string): string {
  const scheme = url.slice(0, Math.max(url.indexOf("://"), 0));
  const plus = scheme.indexOf("+");
  return plus < 0 ? url : "postgresql" + url.slice(scheme.length);
}

/** 与 Python 侧 `url.startswith("postgresql")` 逐字相同（大小写敏感，`Postgres://` 不算）。 */
export function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgresql");
}

/** 与 Python 侧 `":memory:" in url or "mode=memory" in url` 逐字相同。 */
export function isMemoryUrl(url: string): boolean {
  return url.includes(":memory:") || url.includes("mode=memory");
}

/** SQLAlchemy 的 `sqlite+aiosqlite:///x` 里，`://` 之后的第一个 `/` 是"库名开始"的分隔
 * 符，不是路径的一部分 —— 所以绝对路径写出来是四条斜杠。deps 拼的就是这种。 */
export function sqliteFilename(url: string): string {
  if (isMemoryUrl(url)) return ":memory:";
  const at = url.indexOf("://");
  let rest = at < 0 ? url : url.slice(at + 3);
  const query = rest.indexOf("?");
  if (query >= 0) rest = rest.slice(0, query);
  if (rest.startsWith("/")) rest = rest.slice(1);
  // 空库名（`sqlite://`）在 SQLAlchemy 里就是内存库。
  return rest === "" ? ":memory:" : rest;
}

// ══════════════════════════════════════════════════════════════════
//  pool 参数
// ══════════════════════════════════════════════════════════════════

/** Python 侧 `int(os.getenv("DB_POOL_SIZE", 5))`：**配错了要当场炸**，不是悄悄回落到
 * 默认值。`Number("")` 是 0、`Number("abc")` 是 NaN，两个都会把配置错误吞掉，所以这里
 * 按 `int(str)` 的规矩来（允许前后空白、正负号、数字间单下划线；小数点一律拒绝）。 */
function parsePyInt(raw: string, name: string): number {
  const s = raw.trim();
  if (!/^[+-]?\d(_?\d)*$/.test(s)) {
    throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(raw)}（${name}）`);
  }
  return Number(s.replaceAll("_", ""));
}

export interface PgPoolOptions {
  readonly poolPrePing: true;
  readonly poolSize: number;
  readonly maxOverflow: number;
  readonly poolRecycle: number;
}

/** 只有 Postgres 分支有池参数；SQLite 分支在 Python 侧走的是 StaticPool/NullPool。 */
export function pgPoolOptions(env?: Readonly<Record<string, string | undefined>>): PgPoolOptions {
  const source = env ?? process.env;
  const size = source["DB_POOL_SIZE"];
  const overflow = source["DB_MAX_OVERFLOW"];
  return {
    poolPrePing: true,
    poolSize: size === undefined ? DEFAULT_POOL_SIZE : parsePyInt(size, "DB_POOL_SIZE"),
    maxOverflow:
      overflow === undefined ? DEFAULT_MAX_OVERFLOW : parsePyInt(overflow, "DB_MAX_OVERFLOW"),
    poolRecycle: 1800,
  };
}

// ══════════════════════════════════════════════════════════════════
//  连接与引擎
// ══════════════════════════════════════════════════════════════════

export type StoreMode = "memory" | "sqlite" | "postgres";

export type SqlParam = null | number | bigint | string | Uint8Array;
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export type SqliteDb = SqliteRemoteDatabase<Record<string, never>>;

/** 一条**独占**连接 —— 对应 SQLAlchemy 的 `AsyncConnection`。
 * `db` 是绑在这条连接上的 drizzle，所以 `begin()` 里的 drizzle 语句与手写 SQL 在
 * 同一个事务里。 */
export interface Conn {
  readonly db: SqliteDb;
  /** 对应 `conn.exec_driver_sql`：直通驱动，不过 drizzle 的构建器。 */
  exec(sql: string, params?: readonly SqlParam[]): Promise<void>;
  all<T = Row>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  scalar(sql: string, params?: readonly SqlParam[]): Promise<SqlValue | undefined>;
}

export interface Engine {
  /** 与 Python 侧 `engine.dialect.name` **同名同值**（repo.py:1418 拿它分方言，
   * 比较的字面量是 `"postgresql"`）。**注意它与 `Store.mode` 不是一个词** ——
   * mode 是 `"postgres"`。Python 侧就是这两个不同的字符串，照搬，别顺手统一掉。 */
  readonly dialect: "sqlite" | "postgresql";
  /** 借一条连接（自动提交模式）。**不要嵌套调用**（见文件头）。 */
  connect<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
  /** 借一条连接并包在事务里，对应 `engine.begin()`：正常返回就 COMMIT，抛了就 ROLLBACK。 */
  begin<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/** 进程内 FIFO 互斥。见文件头"连接策略"：串行化是这里唯一能真正排除事务穿插的手段。 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** 嵌套借用会在互斥上**永久等下去**（外层不还、内层不走）。静默死锁是最难查的一类
 * 故障，所以用 AsyncLocalStorage 把它变成一条说得清的错误。
 * repo 那边 `atomic()` 的注释说"若已在作用域里就复用" —— 复用逻辑得由 repo 自己实现
 * （传 conn 下去），引擎这层没有上下文去猜。 */
const borrowed = new AsyncLocalStorage<true>();

/** drizzle 的 sql 模板会把 JS 值原样透下来，而 `node:sqlite` 不认 boolean
 * （列定义走 `mode:"boolean"` 的那些 drizzle 自己会转，手写 SQL 不会）。 */
function bind(params: readonly unknown[]): SqlParam[] {
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : (p as SqlParam)));
}

function makeConn(raw: DatabaseSync): Conn {
  const db = drizzle(async (sql, params, method) => {
    const st: StatementSync = raw.prepare(sql);
    if (method === "run") {
      st.run(...bind(params));
      return { rows: [] };
    }
    // proxy 要的是**位置行**（`mapResultRow` 按字段下标取值），不是对象行。
    st.setReturnArrays(true);
    const rows = st.all(...bind(params)) as unknown as unknown[][];
    // `get` 传的是"那一行"本身；没查到必须给 undefined，给 `[]` 的话 drizzle 会把
    // 一行全 undefined 的对象当成查到了。
    return method === "get" ? { rows: rows[0] as unknown[] } : { rows };
  });
  return {
    db,
    exec: async (sql, params) => {
      // 不带参数时走 exec：它能一次跑多条语句（建表用得上）。
      if (params === undefined) raw.exec(sql);
      else raw.prepare(sql).run(...bind(params));
      return Promise.resolve();
    },
    all: async <T = Row>(sql: string, params?: readonly SqlParam[]) =>
      Promise.resolve(raw.prepare(sql).all(...bind(params ?? [])) as unknown as T[]),
    scalar: async (sql, params) => {
      const st = raw.prepare(sql);
      st.setReturnArrays(true);
      const row = st.get(...bind(params ?? [])) as unknown as SqlValue[] | undefined;
      return Promise.resolve(row === undefined ? undefined : row[0]);
    },
  };
}

class SqliteEngine implements Engine {
  readonly dialect = "sqlite" as const;

  private readonly gate = new Mutex();
  /** 只有内存库有共享句柄；文件库每次借出新开一个（见文件头）。 */
  private shared: DatabaseSync | null = null;

  constructor(
    private readonly filename: string,
    private readonly memory: boolean,
  ) {}

  /** SQLite 的 foreign_keys 默认是**每连接** OFF。光在表定义里写 ON DELETE CASCADE，
   * 零配置生产模式下就会留下一堆孤儿 state/files/runs —— 每条连接都得自己打开。
   * （`node:sqlite` 的构造参数默认是 true，但这条纪律不能靠某个驱动的默认值。） */
  private openRaw(foreignKeys: boolean): DatabaseSync {
    const raw = new DatabaseSync(this.filename, { enableForeignKeyConstraints: foreignKeys });
    try {
      // busy_timeout 必须是连上之后的**第一条**语句 —— 顺序是有意的，别调回去，理由见下。
      if (!this.memory) raw.exec("PRAGMA busy_timeout=30000");
      raw.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
      if (!this.memory) {
        // 现在是真的多连接了，得让它们能好好共处：WAL 让读不再挡写（SSE 一直在轮询读），
        // busy_timeout 让偶发争用等一下而不是直接抛 "database is locked"。
        //
        // ── 为什么 busy_timeout 必须在前 ────────────────────────────────
        // 曾经它写在这一行**后面**，结果是生产日志里 91 条 `database is locked`，
        // 栈顶无一例外钉在下面这行 journal_mode 上。那**跟 WAL 转换无关**：
        // `new DatabaseSync()` 和 `PRAGMA foreign_keys` 都不碰文件（SQLite 惰性打开），
        // 而 `PRAGMA journal_mode` 要读 schema —— 它才是第一条真正对库文件加锁的语句，
        // 于是任何锁争用都会把栈顶钉在这儿。busy_timeout 设在它之后，等于撞锁那一刻
        // busy handler 还没装上：0 重试、亚毫秒直接抛。实测同一竞争下，仅调换顺序
        // 就从"0ms 抛"变成"等 514ms 成功"。
        //
        // 争用窗口是本类自己造的：文件库每次借出新开连接、用完就 close（见 checkout），
        // 而 WAL 库关掉**最后一条**连接时 SQLite 会 checkpoint 并 unlink -wal/-shm，
        // 全程持排他锁。gate 那把互斥保证进程内不自撞，但只要出现第二个进程
        // （一条 `sqlite3 db "SELECT …"` 就够格），命中率就是两位数百分比。
        // 回归用例见 test/store.engine.test.ts「别的进程握着排他锁时…」。
        raw.exec("PRAGMA journal_mode=WAL");
      }
      return raw;
    } catch (err) {
      // 句柄这时已经开着了，而 checkout 的 release 闭包是在本函数**返回之后**才建的 ——
      // 直接把异常抛出去就再没人 close 它，每抛一次漏一个 fd。（上面的 busy_timeout
      // 修复让撞锁不再抛，但错误路径本身还在：撞锁超过 30 秒、或库目录不可写都会走到。）
      // close 自己再抛的话不许盖掉原始错误 —— 原因是那个，不是收尾没收干净。
      try {
        raw.close();
      } catch {
        /* 原始错误更重要 */
      }
      throw err;
    }
  }

  private checkout(foreignKeys: boolean): { raw: DatabaseSync; release: () => void } {
    if (this.memory) {
      // 内存库必须共享唯一那条连接（不共享就是两个不同的库）。dispose 之后再用会开出
      // 一个**新的空库** —— 与 Python 侧 dispose 掉 StaticPool 之后的行为一致。
      const shared = (this.shared ??= this.openRaw(foreignKeys));
      shared.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
      return { raw: shared, release: () => {} };
    }
    const raw = this.openRaw(foreignKeys);
    return { raw, release: () => raw.close() };
  }

  async connect<T>(fn: (conn: Conn) => Promise<T>, foreignKeys = true): Promise<T> {
    if (borrowed.getStore() === true) {
      throw new Error(
        "connect/begin 不能嵌套：外层已经借着连接，内层会在互斥上死等。" +
          "要在同一个事务里做多件事，把 conn 传下去。",
      );
    }
    return this.gate.run(async () =>
      borrowed.run(true, async () => {
        const { raw, release } = this.checkout(foreignKeys);
        try {
          return await fn(makeConn(raw));
        } finally {
          release();
        }
      }),
    );
  }

  async begin<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    return this.connect(async (conn) => {
      await conn.exec("BEGIN");
      try {
        const out = await fn(conn);
        await conn.exec("COMMIT");
        return out;
      } catch (e) {
        await conn.exec("ROLLBACK");
        throw e;
      }
    });
  }

  async dispose(): Promise<void> {
    // 排队进去关，免得把正在用的句柄从别人手里抽走。
    await this.gate.run(async () => {
      this.shared?.close();
      this.shared = null;
      return Promise.resolve();
    });
  }
}

/** 建一个真的 PG 引擎。**动态 import**：没配 `DATABASE_URL` 的部署（零配置本地
 * SQLite、纯内存测试）不该为 `pg` 付导入代价 —— 与 `store/const.ts`、
 * `store/migrate.ts` 文件头写的是同一条纪律。
 *
 * 与 Python 一样**不在这里连库**：`new Pool()` 是惰性的，第一次借连接才拨号。
 * 失败点因此仍然是 `healthcheck()`，deps 的"显式配了 DATABASE_URL 却连不上就直接
 * 失败、绝不偷偷回落到内存"那条纪律照样成立。 */
async function makePgEngine(url: string, pool: PgPoolOptions): Promise<Engine> {
  const { PgEngine } = await import("./pg_driver.js");
  return new PgEngine(pgConnectionString(url), pool);
}

// ══════════════════════════════════════════════════════════════════
//  SQLite DDL —— `metadata.create_all` 的对应物
// ══════════════════════════════════════════════════════════════════
//
// Drizzle 没有运行时的建表 API（drizzle-kit 是构建期工具，本轮没装），所以这里从
// `schema.ts` 的中立 `TABLE_SPECS` 直接生成 DDL —— **同一份来源**，不会与 repo 查询
// 用的那 33 张表漂移。
//
// 类型名与默认值的渲染**照抄 SQLAlchemy 在 SQLite 上的输出**（`BIGINT DEFAULT '0'`
// 是带引号的，因为 schema.py 的 server_default 传的就是字符串；`BOOLEAN DEFAULT 0`
// 不带，因为那是 sa.false()）。这样 TS 建出来的库与 Python 建出来的库在 PRAGMA 层面
// 一模一样，迁移期同一个 workspace/ontocopilot.db 两边都能开。由
// golden/store.engine.json 逐表钉住。
//
// **标识符一律加引号**，SQLAlchemy 只给保留字加（`"key"` / `"conflict"`）——
// 那是同一个库的两种写法，PRAGMA 读出来没有区别，所以不为了抄它的引号规则把
// SQLAlchemy 的保留字表也搬过来。

const SQLITE_TYPE: Readonly<Record<ColKind, string>> = {
  text: "TEXT",
  int: "INTEGER",
  bigint: "BIGINT",
  float: "FLOAT",
  bool: "BOOLEAN",
  json: "JSON",
  bytes: "BLOB",
  tstz: "DATETIME",
};

function q(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}

function strLit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function sqliteDefault(kind: ColKind, d: ColDefault): string {
  if (d.kind === "now") return "CURRENT_TIMESTAMP";
  // 布尔是唯一不带引号的一种（sa.false()/sa.true() 渲染成 0/1）。
  if (kind === "bool") return d.value === true ? "1" : "0";
  const raw = typeof d.value === "string" ? d.value : (JSON.stringify(d.value) ?? "");
  return strLit(raw);
}

/** 一张表的 CREATE TABLE。约束顺序是 PRIMARY KEY → UNIQUE → CHECK → FOREIGN KEY：
 * **PK 必须排在 UNIQUE 前面**，否则 SQLite 给隐式唯一索引编的号
 * （`sqlite_autoindex_<表>_N`）会与 Python 侧对不上。 */
export function sqliteTableDdl(name: TableName): string {
  const spec: TableSpec = TABLE_SPECS[name];
  const cols = Object.entries(spec.columns) as [string, ColSpec][];
  const parts: string[] = [];
  for (const [col, cs] of cols) {
    let s = `${q(col)} ${SQLITE_TYPE[cs.kind]}`;
    if (cs.default !== undefined) s += ` DEFAULT ${sqliteDefault(cs.kind, cs.default)}`;
    // 主键列也要显式 NOT NULL：SQLite 里非 INTEGER 主键**默认允许 NULL**（历史包袱），
    // 少写这两个字 PRAGMA 的 notnull 就是 0。
    if (cs.notNull === true || cs.pk === true) s += " NOT NULL";
    parts.push(s);
  }
  const pk = cols.filter(([, cs]) => cs.pk === true).map(([c]) => c);
  if (pk.length > 0) parts.push(`PRIMARY KEY (${pk.map(q).join(", ")})`);
  for (const u of spec.unique ?? []) {
    parts.push(`CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(", ")})`);
  }
  for (const [col, cs] of cols) if (cs.unique === true) parts.push(`UNIQUE (${q(col)})`);
  for (const ck of spec.checks ?? []) parts.push(`CONSTRAINT ${q(ck.name)} CHECK (${ck.expr})`);
  for (const [col, cs] of cols) {
    const ref = cs.ref;
    if (ref !== undefined) {
      parts.push(
        `FOREIGN KEY(${q(col)}) REFERENCES ${q(ref.table)} (${q(ref.column)}) ` +
          `ON DELETE ${ref.onDelete.toUpperCase()}`,
      );
    }
  }
  return `CREATE TABLE ${q(name)} (\n\t${parts.join(", \n\t")}\n)`;
}

export function sqliteIndexDdl(table: TableName, ix: IndexSpec): string {
  const head = ix.unique === true ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  const base = `${head} ${q(ix.name)} ON ${q(table)} (${ix.columns.map(q).join(", ")})`;
  return ix.where === undefined ? base : `${base} WHERE ${ix.where}`;
}

async function tableNames(conn: Conn): Promise<Set<string>> {
  const rows = await conn.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set(rows.map((r) => r.name));
}

/** 对应 `metadata.create_all(checkfirst=True)`：**只建缺的表**。
 *
 * 表已存在就整张跳过 —— 连它的索引一起跳过，这不是省事，是 SQLAlchemy 的真实行为，
 * 而且有可观察后果：老库重建过 session 表之后，`session_project_idx` 就再也补不上了
 * （golden 的 legacy 用例把这条钉住了）。加列/换约束那类事一律归
 * `upgradeSqliteCompat`，不要在这里用 `IF NOT EXISTS` 悄悄"修好"。 */
export async function createAllSqlite(conn: Conn): Promise<void> {
  const existing = await tableNames(conn);
  for (const name of TABLE_NAMES) {
    if (existing.has(name)) continue;
    await conn.exec(sqliteTableDdl(name));
    const spec: TableSpec = TABLE_SPECS[name];
    for (const ix of spec.indexes ?? []) await conn.exec(sqliteIndexDdl(name, ix));
  }
}

// ══════════════════════════════════════════════════════════════════
//  老库兼容升级
// ══════════════════════════════════════════════════════════════════

/** 与 Python 侧 engine.py:226 那段字符串**逐字相同** —— 重建出来的表要连
 * `sqlite_master.sql` 的字节都一样，老库在两边升级完必须是同一个库。
 * （注意它与 create_all 建的 session 不完全一致：这里的 `DEFAULT 0` 不带引号。
 * 那是 Python 侧手写 DDL 与 SQLAlchemy 渲染之间的既有差异，照搬，不"修正"。） */
const SESSION_REBUILD_DDL = `
                CREATE TABLE session__upgrade (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '新建会话',
                    project TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'idle',
                    error TEXT NOT NULL DEFAULT '',
                    state_version BIGINT NOT NULL DEFAULT 0,
                    next_event_seq BIGINT NOT NULL DEFAULT 0,
                    next_run_ordinal INTEGER NOT NULL DEFAULT 0,
                    next_decision_ordinal INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    owner TEXT,
                    project_id TEXT,
                    CONSTRAINT session_status_ck CHECK (status IN (
                        'idle','queued','parsing','extracting','awaiting_answer',
                        'done','failed','stopped'))
                )
            `;

/** 迁移前版本建的零配置 SQLite 库的兼容升级。
 *
 * `create_all` 只建缺的表，它**从不加列、也不换 CHECK**。这个升级器只管本地单进程库，
 * 范围要一直保持这么窄；PostgreSQL 一律由带 checksum 的 SQL 迁移目录管。 */
export async function upgradeSqliteCompat(conn: Conn): Promise<void> {
  const tables = await tableNames(conn);
  if (!tables.has("session")) return;

  const columnNamesOf = async (t: string): Promise<string[]> =>
    (await conn.all<{ name: string }>(`PRAGMA table_info("${t}")`)).map((r) => r.name);

  const sessionColumns = new Set(await columnNamesOf("session"));
  // 0004 是可空、无约束的列，就地 ADD 是安全的。
  if (!sessionColumns.has("owner")) {
    await conn.exec('ALTER TABLE "session" ADD COLUMN owner TEXT');
    sessionColumns.add("owner");
  }
  // 0013 同样是可空无约束的列，就地 ADD 即可。补在重建分支**之前**，所以下面那个
  // required 集合必须一起认它 —— 少一个名字，老库走到重建时就是 RuntimeError。
  if (!sessionColumns.has("project_id")) {
    await conn.exec('ALTER TABLE "session" ADD COLUMN project_id TEXT');
    sessionColumns.add("project_id");
  }

  // 0019：知识库文档加 folder_path（用户手工建的文件夹）。空串 = 根目录，
  // 所以既有数据不会因为这次升级而"消失"到某个新分组里。
  // 和上面两条一样是可空/带默认的普通列，就地 ADD 是安全的；
  // onto_document_folder 那张新表由 createAllSqlite 的 IF NOT EXISTS 负责。
  if (tables.has("onto_document")) {
    const documentColumns = new Set(await columnNamesOf("onto_document"));
    if (!documentColumns.has("folder_path")) {
      await conn.exec(`ALTER TABLE "onto_document" ADD COLUMN folder_path TEXT NOT NULL DEFAULT ''`);
    }
  }

  // 0006：SQLite 改不了具名 CHECK 约束。只在存下来的 CREATE 语句里还没有
  // queued/stopped 时才重建，且逐列保住现有数据。
  const sessionSql = String(
    (await conn.scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='session'")) ??
      "",
  );
  if (!sessionSql.includes("queued") || !sessionSql.includes("stopped")) {
    const columns = await columnNamesOf("session");
    const required = new Set([
      "id",
      "title",
      "project",
      "status",
      "error",
      "state_version",
      "next_event_seq",
      "next_run_ordinal",
      "next_decision_ordinal",
      "created_at",
      "updated_at",
      "owner",
      "project_id",
    ]);
    // 只重建已知的生产形态。未知/自定义 schema 必须**显式失败**，不许 best-effort
    // 拷贝时悄悄把列丢掉。
    const seen = new Set(columns);
    if (seen.size !== required.size || [...required].some((c) => !seen.has(c))) {
      throw new Error(
        "SQLite session 表需要升级，但列结构不是受支持的历史版本：" + columns.join(","),
      );
    }
    await conn.exec(SESSION_REBUILD_DDL);
    const quoted = columns.map((n) => `"${n}"`).join(",");
    await conn.exec(`INSERT INTO session__upgrade (${quoted}) SELECT ${quoted} FROM "session"`);
    await conn.exec('DROP TABLE "session"');
    await conn.exec('ALTER TABLE session__upgrade RENAME TO "session"');
  }

  // 0007：加上事件重试的持久身份和它的部分唯一索引。
  if (tables.has("session_event")) {
    const eventColumns = new Set(await columnNamesOf("session_event"));
    if (!eventColumns.has("event_id")) {
      await conn.exec('ALTER TABLE "session_event" ADD COLUMN event_id TEXT');
    }
    await conn.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS session_event_event_id_uq " +
        "ON session_event (event_id) WHERE event_id IS NOT NULL",
    );
  }

  // 0012：display_name 是 NOT NULL 带默认值的列，SQLite 能就地加。下面的 create_all
  // 只建缺的**表** —— 已存在的 app_user 会永远保持老形态，然后每次读都
  // "no such column"。
  if (tables.has("app_user")) {
    const userColumns = new Set(await columnNamesOf("app_user"));
    if (!userColumns.has("display_name")) {
      await conn.exec(
        'ALTER TABLE "app_user" ADD COLUMN display_name TEXT NOT NULL ' + "DEFAULT ''",
      );
    }
  }

  // 紧跟其后的 create_all 会补上 0008–0017 引入的那些只增不改的表/索引（含 0013 的
  // project / project_memory 与 OntoDocument 表 —— 它们是**新表**，create_all 建得出来；只有加到既有表
  // 上的列才需要上面那些补丁）。先跑这个函数，才分得清老库。
}

// ══════════════════════════════════════════════════════════════════
//  Store
// ══════════════════════════════════════════════════════════════════

/** `/api/health` 的响应形态。字段名是**线上形态**（snake_case），直接进 JSON。 */
export type Health =
  | { readonly mode: "memory"; readonly ok: true; readonly note: string }
  | { readonly mode: StoreMode; readonly ok: true; readonly schema_version: number }
  | { readonly mode: StoreMode; readonly ok: false; readonly error: string };

function errText(e: unknown): string {
  // Python 侧是 f"{type(exc).__name__}: {exc}"。JS 这边类名取 `name`。
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** 数据库句柄。`mode === "memory"` 时 `engine === null`。 */
export class Store {
  private constructor(
    readonly mode: StoreMode,
    readonly engine: Engine | null,
    readonly url: string,
  ) {}

  get enabled(): boolean {
    return this.engine !== null;
  }

  /** 按 URL 建引擎。URL 为空 → 内存模式，**不抛异常**。
   *
   * @param url `null` 表示读 `DATABASE_URL`；`""` 表示显式内存。
   * @param createAll 直接建表而不跑 PostgreSQL 迁移。用于零配置 SQLite（以及测试）；
   *   Postgres 上一律走 `migrations/`，否则线上 schema 的来源就有两个。
   */
  static async open(
    url: string | null = null,
    opts: { readonly createAll?: boolean } = {},
  ): Promise<Store> {
    const resolved = url === null ? databaseUrl() : url;
    if (!resolved) return new Store("memory", null, "");

    if (isPostgresUrl(resolved)) {
      // pool 参数在这里就算出来：配错了（DB_POOL_SIZE=abc）要在启动时炸，
      // 与 Python 侧 int() 的失败时机一致。
      const pool = pgPoolOptions();
      // createAll 在 PG 上只有 Python 侧的测试会用（线上一律走 migrations/）。
      // TS 侧**不给第二个 PG schema 来源** —— 那会让"线上表结构从哪来"有两个答案，
      // 而两个答案迟早不一致。显式报错，并说清该用什么。
      if (opts.createAll === true) {
        throw new Error(
          "Postgres 上不支持 create_all：schema 的唯一来源是 migrations/。" +
            "请用 store/migrate.ts 的 upgrade(engine) 跑迁移（PgEngine 已实现 MigrationEngine）。",
        );
      }
      return new Store("postgres", await makePgEngine(resolved, pool), resolved);
    }

    const engine = new SqliteEngine(sqliteFilename(resolved), isMemoryUrl(resolved));
    const store = new Store("sqlite", engine, resolved);
    if (opts.createAll === true) {
      // 重建父表要求 FK 校验在**事务开始之前**就关掉；PRAGMA foreign_keys 在事务中间
      // 是空操作。
      await engine.connect(async (conn) => {
        try {
          await conn.exec("BEGIN");
          try {
            await upgradeSqliteCompat(conn);
            await createAllSqlite(conn);
            await conn.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
            await conn.exec("COMMIT");
          } catch (e) {
            await conn.exec("ROLLBACK");
            throw e;
          }
        } finally {
          await conn.exec("PRAGMA foreign_keys=ON");
        }
      }, false);
    }
    return store;
  }

  async close(): Promise<void> {
    if (this.engine !== null) await this.engine.dispose();
  }

  /** 对应 Python 的 `@asynccontextmanager lifespan()`：跑完 `body` 一定关引擎。 */
  async lifespan<T>(body: (store: Store) => Promise<T>): Promise<T> {
    try {
      return await body(this);
    } finally {
      await this.close();
    }
  }

  /** 给 `/api/health` 用。内存模式返回 ok —— 它是**受支持的模式**，不是故障。 */
  async healthcheck(): Promise<Health> {
    if (this.engine === null) {
      return {
        mode: "memory",
        ok: true,
        note: "未配置 DATABASE_URL，会话状态只在内存里，进程重启即丢",
      };
    }
    try {
      const v = await this.engine.connect(async (conn) =>
        this.mode === "sqlite"
          ? // SQLite 走 create_all + 兼容升级器，没有逐条写 schema_migration；
            // 它的权威版本标记是 PRAGMA user_version。
            conn.scalar("PRAGMA user_version")
          : conn.scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migration"),
      );
      return { mode: this.mode, ok: true, schema_version: Math.trunc(Number(v ?? 0)) };
    } catch (e) {
      // 健康检查要报出原因，不能吞。
      return { mode: this.mode, ok: false, error: errText(e) };
    }
  }
}
