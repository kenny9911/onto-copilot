/**
 * Postgres 驱动接线 —— `engine.ts` 的 PG 分支从这里拿引擎。
 *
 * **为什么单独一个文件、且由 `engine.ts` 动态 import：** 没配 `DATABASE_URL` 的部署
 * （零配置本地 SQLite、纯内存测试）不该为 `pg` 付任何导入代价。这条纪律
 * `store/const.ts` 与 `store/migrate.ts` 的文件头都写过，这里是它的第三次落地。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  形态决策：PG 也走 drizzle 的 **sqlite-proxy**，不走 `drizzle-orm/node-postgres`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 直觉上 PG 该配 `drizzle-orm/node-postgres` + `pgTables`。**做不到，而且不该做**：
 * `store/repo/pg.ts` 是 `import { sqliteTables as t }`，130 处 `conn.db` 全部按
 * SQLite 的表对象与 `SqliteRemoteDatabase` 写成。换 PG 驱动就等于把那 2300 行整个
 * 重写一遍 —— 那是本轮明确要避免的返工，也会立刻让两个方言的代码路径分叉
 * （而 `repo.py` 存在的全部意义就是"一份语句编到两个方言"）。
 *
 * 所以这里做的是：**保持 `Conn.db` 仍然是 `SqliteRemoteDatabase`，把 proxy 的回调
 * 接到真的 PG 连接上**。`Engine` / `Conn` 接口一个字没动，`repo/pg.ts` 一行没改。
 * 代价是要在 proxy 这一层把两件事对齐，两件都收在本文件里：
 *
 *   1. **占位符**。drizzle 的 sqlite 方言发 `?`，pg 线协议只有 `$1 $2 …`。
 *      {@link toPgPlaceholders} 逐字符扫，跳过字符串字面量、引号标识符与注释。
 *   2. **回值形态**。sqlite 列声明自带解码器（`text({mode:"json"})` 要 `JSON.parse`、
 *      `integer({mode:"boolean"})` 要 `Number(v)===1`），而 pg 驱动默认给的是**已经
 *      解析好的**对象与 `true/false` —— 直接喂过去会 `JSON.parse({…})` 当场炸。
 *      解法不是在值上猜类型（猜不出来：jsonb 里存一个字符串和 text 列存同一个
 *      字符串，到了 JS 里长得一模一样），而是用 `pg` 的**按 OID 的类型解析器**：
 *      OID 就是列类型，一点都不用猜。见 {@link SQLITE_SHAPED_TYPES}。
 *
 * `timestamptz` 反而不用动：pg 默认给 `Date`，而 `repo/pg.ts` 的 `tstzEpoch()`
 * 第一条判据就是 `v instanceof Date`（那行注释写的就是"PG 驱动接上之后回的是 Date"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  池参数：SQLAlchemy 的四个开关在 node-postgres 上分别落在哪
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | SQLAlchemy | 这里 |
 * |---|---|
 * | `pool_size=5` + `max_overflow=5` | `Pool.max = 5 + 5`（node-postgres 只有"总上限"这一个旋钮） |
 * | `pool_recycle=1800` | `Pool.maxLifetimeSeconds = 1800` |
 * | `pool_pre_ping=True` | 借出前 `SELECT 1`，失败就**销毁**这条连接再取一条（见 {@link PgEngine.checkout}） |
 *
 * pre_ping 不是可有可无的装饰：PG 那边 `idle_in_transaction_session_timeout`、
 * 云厂商的 NAT 空闲回收、以及一次 failover，都会留下"看起来还在池子里、一用就
 * ECONNRESET"的连接。没有 pre_ping 时这些会变成**用户看得见的一次 500**，而重试
 * 一次就好了 —— 这正是 SQLAlchemy 默认打开它的原因。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  已知分叉（对 Python 侧 / 对 SQLite 分支）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. **`SELECT … FOR UPDATE` 仍然缺**。`repo/pg.ts` 里四处标了 `PG-FOR-UPDATE` 的
 *    地方（`reapExpiredBuildLease` / `claimChatLease` / `recordDecisionV1` /
 *    `appendRevision`）用的是 drizzle **sqlite** builder，那个 builder 根本没有
 *    `.for("update")`。SQLite 上它本来就是空操作（SQLAlchemy 静默丢掉），所以现状
 *    与 Python 的 SQLite 路径等价；与 Python 的 **PG** 路径则少了一层行锁。补它必须
 *    改 `repo/pg.ts`，那是另一条 track 的文件，本轮不动。
 * 2. **`connect`/`begin` 允许嵌套**。SQLite 分支必须禁止（同步驱动 + 单连接会死锁），
 *    PG 这边池子里有多条连接，嵌套只是多借一条 —— 与 Python 侧行为一致，所以不加
 *    那道 AsyncLocalStorage 守卫。
 * 3. **`Store.open(url, {createAll:true})` 在 PG 上仍然抛**。Python 侧
 *    `metadata.create_all` 两个方言都能跑；这里不给第二个 PG schema 来源
 *    （`Store.open` 的 docstring 原话："Postgres 上一律走 migrations/，否则线上
 *    schema 的来源就有两个"）。错误消息说清该用什么。
 */

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { types as pgTypes } from "pg";

import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Conn, Engine, PgPoolOptions, Row, SqlParam, SqlValue } from "./engine.js";
import type { MigrationConn, MigrationEngine } from "./migrate.js";

// ══════════════════════════════════════════════════════════════════
//  占位符
// ══════════════════════════════════════════════════════════════════

/** `?` → `$1 $2 …`。字符串字面量（`'…'`，`''` 转义）、引号标识符（`"…"`）、
 * `--` 行注释与 `/* *​/` 块注释里的问号**不算占位符**。
 *
 * drizzle 现在不会在这些位置放 `?`（值一律走参数），但这段扫描是**唯一**一处
 * "SQL 文本被改写"的地方 —— 它出错的形态是参数错位，而参数错位在鉴权/归属这类
 * 查询上就是越权。所以宁可多写二十行也不用 `replace(/\?/g, …)`。 */
export function toPgPlaceholders(sql: string): string {
  if (!sql.includes("?")) return sql;
  let out = "";
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            out += q + q; // '' / "" 是转义，不是收尾
            i += 2;
            continue;
          }
          out += q;
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      out += "/*";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i];
        i += 1;
      }
      out += "*/";
      i += 2;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** drizzle 的 sqlite 方言把 `ON CONFLICT` 的冲突目标写成**带表限定**的
 * `on conflict ("session_file"."session_id", "session_file"."name")`。
 * SQLite 收，**Postgres 不收** —— 冲突目标那里只允许裸列名（那是索引推断的语法，
 * 不是表达式），报的是一句极难对上号的 `syntax error at or near ")"`。
 *
 * 只在 `on conflict ( … )` 这一对括号里剥掉 `"表".` 前缀，别处一个字不动 ——
 * `do update set` 里的限定名是合法的，剥了反而会歧义。 */
export function stripConflictTargetQualifiers(sql: string): string {
  return sql.replace(/(\bon conflict\s*\()([^()]*)(\))/gi, (_m, head: string, body: string, tail: string) =>
    // `"tbl".` → ``。`""` 是引号内的转义，所以内容用 `(?:[^"]|"")*`。
    head + body.replace(/"(?:[^"]|"")*"\./g, "") + tail,
  );
}

/** drizzle 的 sqlite 方言 → Postgres 能跑的 SQL。两步都只做**必要**的改写：
 * 每多改一个字节，SQLite 与 Postgres 两条路径就多分叉一寸。 */
export function toPgSql(sql: string): string {
  return toPgPlaceholders(stripConflictTargetQualifiers(sql));
}

// ══════════════════════════════════════════════════════════════════
//  按 OID 的类型解析器
// ══════════════════════════════════════════════════════════════════

const OID_BOOL = 16;
const OID_INT8 = 20;
const OID_JSON = 114;
const OID_JSONB = 3802;

/** 把 PG 的回值折成 **drizzle sqlite 列解码器期待的形态**。
 *
 * 关键在于这一层拿得到 **OID**（= 列类型），所以完全不用在值上猜：
 *   * `bool` → `1` / `0`，因为 `integer({mode:"boolean"})` 的解码器是 `Number(v)===1`；
 *   * `json` / `jsonb` → **原始 JSON 文本**（不解析），因为 `text({mode:"json"})`
 *     的解码器要自己 `JSON.parse`。这条同时解决了 jsonb 里存标量的情形 ——
 *     `app_setting.value` 是任意 JSON 值，存一个字符串 `"abc"` 时 pg 默认解析器
 *     会给 JS 字符串 `abc`，与一个 text 列长得完全一样，值层面无从分辨；
 *   * `int8` → `number`。pg 默认给字符串（怕溢出），而 schema.ts 已经拍板
 *     "这些列的量级远在 MAX_SAFE_INTEGER 之内"，回字符串只会把 DTO 层染脏。
 *
 * 其余 OID（timestamptz→Date、bytea→Buffer、float8→number、text→string）
 * 一律走 pg 的默认解析器。 */
export const SQLITE_SHAPED_TYPES = {
  getTypeParser(oid: number, format?: unknown): (value: string) => unknown {
    if (oid === OID_BOOL) return (v: string) => (v === "t" ? 1 : 0);
    if (oid === OID_JSON || oid === OID_JSONB) return (v: string) => v;
    if (oid === OID_INT8) return (v: string) => Number(v);
    return pgTypes.getTypeParser(oid, format as never) as (value: string) => unknown;
  },
};

// ══════════════════════════════════════════════════════════════════
//  连接
// ══════════════════════════════════════════════════════════════════

/** `undefined` 在 pg 里会被当成 SQL NULL 之外的东西（历史上是 `null`，但显式一点
 * 更好）；boolean 直接给 PG 也认（`'t'`/`'f'` 与 `true`/`false` 都行）。 */
function bind(params: readonly unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

function makeConn(client: PoolClient): Conn {
  const db = drizzle(async (sql, params, method) => {
    const text = toPgSql(sql);
    const res = await client.query({
      text,
      values: bind(params),
      // proxy 要的是**位置行**（`mapResultRow` 按字段下标取值），不是对象行。
      rowMode: "array",
      types: SQLITE_SHAPED_TYPES,
    });
    if (method === "run") return { rows: [] };
    const rows = res.rows as unknown as unknown[][];
    // `get` 传的是"那一行"本身；没查到必须给 undefined，给 `[]` 的话 drizzle 会把
    // 一行全 undefined 的对象当成查到了。
    return method === "get" ? { rows: rows[0] as unknown[] } : { rows };
  });

  /** 直通驱动的那三个方法（== `exec_driver_sql`）**不走**上面那套 sqlite 形态折算：
   * 它们的调用方是 engine/healthcheck 这类原生 SQL，期待的是 pg 的原生回值。 */
  const raw = async (sql: string, params?: readonly SqlParam[]): Promise<unknown[][]> => {
    if (params === undefined) {
      const r = await client.query({ text: sql, rowMode: "array" });
      return r.rows as unknown as unknown[][];
    }
    const r = await client.query({
      text: toPgPlaceholders(sql),
      values: bind(params),
      rowMode: "array",
    });
    return r.rows as unknown as unknown[][];
  };

  return {
    db,
    exec: async (sql, params) => {
      if (params === undefined) await client.query(sql);
      else await client.query(toPgPlaceholders(sql), bind(params));
    },
    all: async <T = Row>(sql: string, params?: readonly SqlParam[]): Promise<T[]> => {
      const r =
        params === undefined
          ? await client.query(sql)
          : await client.query(toPgPlaceholders(sql), bind(params));
      return r.rows as unknown as T[];
    },
    scalar: async (sql, params) => {
      const rows = await raw(sql, params);
      const first = rows[0];
      return first === undefined ? undefined : (first[0] as SqlValue);
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  引擎
// ══════════════════════════════════════════════════════════════════

export class PgEngine implements Engine, MigrationEngine {
  /** 与 Python 侧 `engine.dialect.name` 同名同值。**注意它与 `Store.mode`
   * （`"postgres"`）不是一个词** —— Python 侧就是这两个不同的字符串。 */
  readonly dialect = "postgresql" as const;

  private readonly pool: Pool;
  private disposed = false;

  constructor(
    readonly connectionString: string,
    readonly options: PgPoolOptions,
  ) {
    this.pool = new Pool({
      connectionString,
      // SQLAlchemy 的 pool_size 是"常驻"、max_overflow 是"应急再借"；
      // node-postgres 只有一个总上限，所以取两者之和。
      max: options.poolSize + options.maxOverflow,
      maxLifetimeSeconds: options.poolRecycle,
    });
    // 池里空闲连接被服务端切断时 pg 会在 Pool 上发 'error'。**必须接住** ——
    // 无人监听的 'error' 事件在 Node 里直接杀进程，而这是一条正常会发生的路径
    // （PG 重启、云厂商回收空闲连接）。接住之后那条连接会被池子丢弃，
    // 下一次借出自然拿到新的。
    this.pool.on("error", () => {});
  }

  /** 借一条**能用**的连接。`pool_pre_ping` 就落在这里：拿到手先 `SELECT 1`，
   * 死了就销毁（`release(true)`）再取下一条。只重试一次 —— 池子整体不可用时
   * 应当尽快报错，而不是在这里空转。 */
  private async checkout(): Promise<PoolClient> {
    if (this.disposed) throw new Error("引擎已 dispose，不能再借连接");
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.pool.connect();
      if (!this.options.poolPrePing) return client;
      try {
        await client.query("SELECT 1");
        return client;
      } catch (e) {
        last = e;
        client.release(true); // true = 销毁，别放回池子
      }
    }
    throw last instanceof Error
      ? new Error(`连接池里的连接都不可用（pool_pre_ping）：${last.message}`, { cause: last })
      : new Error("连接池里的连接都不可用（pool_pre_ping）");
  }

  async connect<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const client = await this.checkout();
    try {
      return await fn(makeConn(client));
    } finally {
      client.release();
    }
  }

  async begin<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const client = await this.checkout();
    try {
      await client.query("BEGIN");
      try {
        const out = await fn(makeConn(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        // ROLLBACK 自己也可能失败（连接已断）。那时候把**原始**错误抛出去 ——
        // "rollback 失败" 这条消息会盖掉真正的原因。
        try {
          await client.query("ROLLBACK");
        } catch {
          /* 原因以外层的 e 为准 */
        }
        throw e;
      }
    } finally {
      client.release();
    }
  }

  // ── MigrationEngine ────────────────────────────────────────────
  //
  // migrate.ts 要的是**autocommit** 连接（每个迁移文件自带 BEGIN/COMMIT）。
  // pg 的连接不发 BEGIN 就没有事务，所以这里只要**别包事务**即可 ——
  // 见 migrate.ts 文件头第 2 条。

  async withConnection<T>(fn: (conn: MigrationConn) => Promise<T>): Promise<T> {
    const client = await this.checkout();
    try {
      return await fn(migrationConn(client));
    } finally {
      client.release();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.pool.end();
  }
}

function migrationConn(client: PoolClient): MigrationConn {
  const query = async (sql: string, params?: readonly unknown[]): Promise<unknown[][]> => {
    const r = await client.query({
      text: params === undefined ? sql : toPgPlaceholders(sql),
      ...(params === undefined ? {} : { values: bind(params) }),
      rowMode: "array",
    });
    return r.rows as unknown as unknown[][];
  };
  return {
    scalar: async (sql, params) => {
      const rows = await query(sql, params);
      return rows[0]?.[0];
    },
    rows: async (sql, params) => query(sql, params),
    execute: async (sql, params) => {
      await query(sql, params);
    },
    // **不接参数**：`pg` 的 `query(text)` 不带 values 时走 simple query protocol，
    // 接受整段脚本；一旦带上 values 就转扩展协议，于是只剩单条语句。
    // 这不是省事，是协议要求（migrate.ts 文件头把同一个坑的 asyncpg 版记在那里）。
    executeScript: async (script) => {
      await client.query(script);
    },
  };
}
