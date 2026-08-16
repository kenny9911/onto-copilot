/**
 * 迁移执行器 —— 手写编号 SQL，不用 Alembic（TS 侧同样不用 drizzle-kit）。
 *
 * **为什么不用 Alembic。** Alembic 的核心价值是 autogenerate：从声明式 ORM 模型
 * diff 出 DDL。这个项目**没有 ORM 模型** —— 领域对象是手写 dataclass，落库形态是
 * `toDict()` 的 JSONB，表结构由人设计而不是由类推导。没有 autogenerate 的
 * Alembic 剩下的就是"给 SQL 文件编号 + 记一张版本表"，而那是下面这 60 行。
 * 代价那边：alembic.ini + env.py 的 async engine 配置、`script_location`、
 * revision 链的分叉合并、以及一个团队里没人真正读过的 `down_revision`。
 *
 * **什么时候该换成 Alembic**：需要带数据回填的迁移（不只是 DDL）、需要多个环境
 * 停在不同版本、或者出现了分支并行开发同时改 schema。这三条现在一条都不成立。
 *
 * **没有 down migration。** 生产回滚靠"新写一个前向迁移"，不靠 downgrade ——
 * downgrade 脚本几乎从不被执行，因此几乎从不被验证，需要它的那天它是坏的。
 * （移植提醒：这条是**有意的缺失**，不是没来得及写。别好心补上。）
 *
 * ── TS 侧的三处形态决定 ──────────────────────────────────────────────────
 *
 * 1. **不 import 任何驱动。** Python 侧收下的是 SQLAlchemy engine；这里收下的是
 *    {@link MigrationEngine} —— 四个方法的接口。理由不是"为了好测"，是
 *    `store/const.ts` 那条纪律的延续：没配 DATABASE_URL 的部署不该为 Postgres
 *    驱动付任何导入代价。适配 `pg` / `postgres.js` 是调用方十几行的事。
 *
 * 2. **没有 `execution_options(isolation_level="AUTOCOMMIT")`。** SQLAlchemy 会
 *    隐式 BEGIN，所以必须显式关掉；`pg` / `postgres.js` 的连接**默认就是
 *    autocommit**（不发 BEGIN 就没有事务）。所以对等物是"别把这段包进事务"，
 *    而不是去设一个不存在的开关。这条写进 {@link MigrationEngine} 的契约里。
 *
 * 3. **占位符用 `$1` 而不是 `:k`。** Python 走 SQLAlchemy 的 `sa.text` 命名参数，
 *    pg 线协议本身只有位置参数。让 migrate 直接吐 `$N` + 位置数组，好过在这里
 *    塞一个"命名转位置"的翻译器 —— 那种翻译器迟早在 `::text` 强转或字符串字面量
 *    上出错，而这里总共只有四条语句。
 *
 * 用法（CLI 入口见文件末尾的说明）::
 *
 *     const ran = await upgrade(engine);
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 源码 checkout 继续直接读取仓库根目录，方便 CI/运维审阅；打包时把同一目录
// 拷到包根下的 `migrations`，因此安装产物也能独立执行迁移。
// 层数与 Python 侧一一对应：那边 `parents[3]` 是仓库根、`parents[1]` 是包根，
// 这里 `ts/src/store` 往上三层是仓库根、往上一层（`ts/src`）是包根。
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MIGRATIONS = resolve(HERE, "../../../migrations");
const PACKAGED_MIGRATIONS = resolve(HERE, "../migrations");

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const MIGRATIONS: string = isDir(SOURCE_MIGRATIONS)
  ? SOURCE_MIGRATIONS
  : PACKAGED_MIGRATIONS;

/** 迁移期间持有的会话级 advisory lock。多副本同时启动时只有一个真正执行，
 * 其余阻塞等待，避免两个进程同时 CREATE TABLE。0x4F4E544F == b"ONTO"。 */
export const LOCK_KEY = 0x4f4e544f;

// 四条语句。文本与 Python 侧逐字一致，只有占位符换成了位置形式（见文件头 3）。
export const SQL_LOCK = "SELECT pg_advisory_lock($1)";
export const SQL_UNLOCK = "SELECT pg_advisory_unlock($1)";
export const SQL_TABLE_EXISTS = "SELECT to_regclass('public.schema_migration') IS NOT NULL";
export const SQL_SELECT_APPLIED = "SELECT version, checksum FROM schema_migration";
export const SQL_INSERT_APPLIED =
  "INSERT INTO schema_migration (version, name, checksum) VALUES ($1, $2, $3)";

// Python 是 `^(\d{4})_([a-z0-9_]+)\.sql$`。两处**故意**收紧：
//   * JS 的 `\d` 只有 ASCII，Python 的 `\d` 认全部 Unicode 十进制数字
//     （`٠٠٠١_x.sql` 那边过、这边不过）；
//   * Python 的 `$` 还匹配"结尾换行之前"，所以 `"0001_x.sql\n"` 那边也算合规。
// 两条都只在病态文件名上分叉，收紧的方向是**多报错**而不是少报错，安全。
const NAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** 一个迁移文件。纯数据（可 JSON 往返），`sql` / `checksum` 是外面的函数 ——
 * 它们要读磁盘，藏在 getter 后面会让"这一行有 I/O"看不出来。 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly path: string;
}

export function makeMigration(version: number, name: string, path: string): Migration {
  return { version, name, path };
}

/** 迁移基类。Python 侧 `discover` 抛 ValueError、`upgrade` 抛 RuntimeError；
 * 这里分成 {@link MigrationCatalogError}（目录不合规）与
 * {@link MigrationChecksumMismatch} + 方言不符（执行期），语义一一对上。 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
    Object.setPrototypeOf(this, MigrationError.prototype); // 保住 instanceof
  }
}

/** 迁移目录本身不合规：文件名不对、重号、编号不连续。== Python 的 ValueError。 */
export class MigrationCatalogError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = "MigrationCatalogError";
    Object.setPrototypeOf(this, MigrationCatalogError.prototype);
  }
}

/** **本模块的核心不变量**：已应用的迁移，内容不许再变。
 *
 * 单独一个类是因为它和别的失败不是一回事 —— 别的失败重试可能有救，这个必须有人
 * 去看为什么文件变了。发现不一致时**当场拒绝**，绝不"顺手重跑一遍"：那条历史
 * 迁移在生产库上已经生效过，重跑要么撞 already exists、要么把一张有数据的表
 * 按新形状再改一次，两种都比停机难收拾。 */
export class MigrationChecksumMismatch extends MigrationError {
  readonly version: number;
  readonly migrationName: string;
  readonly dbChecksum: string;
  readonly fileChecksum: string;

  constructor(version: number, name: string, dbChecksum: string, fileChecksum: string) {
    // 消息逐字对齐 Python（含"变了"后面那个半角空格和全角括号）。
    super(
      `迁移 ${pad4(version)}_${name} 的内容变了 ` +
        `（库里 ${dbChecksum}，文件 ${fileChecksum}）。` +
        `已应用的迁移不许改 —— 新写一个前向迁移。`,
    );
    this.name = "MigrationChecksumMismatch";
    this.version = version;
    this.migrationName = name;
    this.dbChecksum = dbChecksum;
    this.fileChecksum = fileChecksum;
    Object.setPrototypeOf(this, MigrationChecksumMismatch.prototype);
  }
}

/** == Python 的 `f"{v:04d}"`。 */
function pad4(v: number): string {
  return String(v).padStart(4, "0");
}

/** 读迁移正文。
 *
 * **必须翻换行。** Python 的 `Path.read_text` 走 universal newlines：`\r\n` 和
 * 单独的 `\r` 在返回前就被翻成 `\n`；Node 的 `readFileSync(p,"utf8")` 原样返回。
 * 校验和是从这段文本算的，所以不翻的后果不是"哈希不一样"这么抽象 —— 是一个
 * 在 Windows 上 checkout 过、或者被某个编辑器存成 CRLF 的迁移文件，会让 TS 侧
 * 对着 Python 迁过的库当场报"迁移内容变了"，启动直接死在那里。
 * BOM 不去（Python 的 "utf-8" 也不去，去 BOM 的是 "utf-8-sig"）。 */
export function migrationSql(m: Migration): string {
  return readFileSync(m.path, "utf8").replace(/\r\n?/g, "\n");
}

/** 文件 sha256 的前 32 位十六进制 —— 就是 schema_migration.checksum 那一列。 */
export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(Buffer.from(migrationSql(m), "utf8")).digest("hex").slice(0, 32);
}

/** Python 的 str 比较按 code point，JS 的默认 sort 按 UTF-16 code unit ——
 * 只在星平面字符上分叉。文件名排序决定的是"哪个不合规的名字先报错"，
 * 便宜就对齐，省一条已知差异。 */
function byCodePoint(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i]!.codePointAt(0)!;
    const y = cb[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/** 扫出 `NNNN_name.sql`，按编号排序。编号必须连续、不许重号。
 *
 * 点开头的文件**也算**（Python 的 `Path.glob` 收 dotfile，shell glob 才不收），
 * 于是 `.keep.sql` 会因为名字不合规而报错 —— 照搬，不"贴心"地跳过。 */
export function discover(root?: string): Migration[] {
  const dir = root ?? MIGRATIONS;
  const out: Migration[] = [];
  for (const fname of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort(byCodePoint)) {
    const m = NAME_RE.exec(fname);
    if (!m) {
      throw new MigrationCatalogError(`迁移文件名不合规（要 NNNN_name.sql）: ${fname}`);
    }
    out.push(makeMigration(Number.parseInt(m[1]!, 10), m[2]!, join(dir, fname)));
  }
  const seen = out.map((x) => x.version);
  if (new Set(seen).size !== seen.length) {
    throw new MigrationCatalogError(`迁移编号重复: ${pyList(seen)}`);
  }
  if (seen.length && !seen.every((v, i) => v === i + 1)) {
    throw new MigrationCatalogError(`迁移编号不连续: ${pyList(seen)}`);
  }
  return out;
}

/** == Python 的 `str(list[int])`，如 `[1, 3]`。版本号来自 4 位 ASCII 数字，
 * 一定是安全整数，`String()` 与 `repr()` 在这个范围内同形。 */
function pyList(xs: readonly number[]): string {
  return `[${xs.join(", ")}]`;
}

// ══════════════════════════════════════════════════════════════════
//  连接抽象
// ══════════════════════════════════════════════════════════════════

/** 一条 **autocommit** 连接。见文件头第 2 条：`pg` / `postgres.js` 默认就是，
 * 适配器只要保证别把这段包进事务即可。 */
export interface MigrationConn {
  /** 单值查询（== SQLAlchemy 的 `.scalar()`）。 */
  scalar(sql: string, params?: readonly unknown[]): Promise<unknown>;
  /** 多行查询，每行按列序给数组（== `.all()` 的元组）。 */
  rows(sql: string, params?: readonly unknown[]): Promise<readonly (readonly unknown[])[]>;
  /** 参数化执行。走扩展协议，**只能是单条语句**。 */
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  /**
   * 执行**整段脚本**（一个迁移文件自带 BEGIN/…/COMMIT，是多条语句）。
   *
   * Python 那边这一步必须绕开 SQLAlchemy 直取 asyncpg 的原生 `execute()`：
   * `exec_driver_sql` 会走 prepared statement，而 asyncpg 对预编译语句只允许
   * **单条** —— 一个带 BEGIN/CREATE TABLE/COMMIT 的迁移文件会直接报
   * `cannot insert multiple commands into a prepared statement`。
   * Node 侧是同一个坑的同一副面孔：`pg` 的 `query(text)` **不带参数**时走
   * simple query protocol，接受整段脚本；一旦带上 values 就转扩展协议，
   * 于是同样只剩单条。所以这个方法**不接参数**，这不是省事，是协议要求。
   */
  executeScript(script: string): Promise<void>;
}

/** 引擎。`dialect` 对齐 SQLAlchemy 的 `engine.dialect.name`（Postgres 是
 * `"postgresql"`）。`withConnection` 负责借出/归还，让"连接一定被关掉"由结构
 * 保证，而不是靠调用方记得。 */
export interface MigrationEngine {
  readonly dialect: string;
  withConnection<T>(fn: (conn: MigrationConn) => Promise<T>): Promise<T>;
}

/** == Python 的 `int(v)`：驱动可能把 integer 列给成 number、bigint 给成 string。
 * 认不出来就抛，不静默当成 NaN —— 版本号错一位，"已应用"的判断整个就歪了。 */
function toVersion(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  throw new MigrationError(`schema_migration.version 不是整数: ${JSON.stringify(v)}`);
}

/** 已应用的 {version: checksum}。表还不存在时返回空。
 *
 * 表不存在就**不再查第二条** —— 这是空库的正常路径，不是异常路径。 */
export async function applied(conn: MigrationConn): Promise<Map<number, string>> {
  const exists = await conn.scalar(SQL_TABLE_EXISTS);
  if (!exists) return new Map();
  const rs = await conn.rows(SQL_SELECT_APPLIED);
  const out = new Map<number, string>();
  for (const r of rs) {
    // checksum 列是 NOT NULL text；真拿到别的东西就让它去比对里对不上（=> 报
    // 内容变了），而不是在这里放行。
    out.set(toVersion(r[0]), String(r[1]));
  }
  return out;
}

export interface UpgradeOptions {
  readonly root?: string;
  readonly dryRun?: boolean;
}

/** 把库迁到最新。返回本次实际执行的版本号。
 *
 * 每个迁移文件**自带 BEGIN/COMMIT**，所以连接跑在 AUTOCOMMIT 上，由文件自己
 * 控制事务边界。一个文件失败不会让前面成功的那些回滚，版本表如实反映停在哪。
 *
 * 只支持 Postgres —— SQLite（测试）走 `create_all()` 的等价物，
 * 见 `Store.open` 的 `createAll` 参数。 */
export async function upgrade(
  engine: MigrationEngine,
  opts: UpgradeOptions = {},
): Promise<number[]> {
  if (engine.dialect !== "postgresql") {
    throw new MigrationError(
      `迁移只跑 Postgres，当前方言 ${engine.dialect}；SQLite 请用 Store.open(create_all=True)`,
    );
  }
  const todo: number[] = [];
  // discover 在连接之前 —— 目录不合规就不该去占那把 advisory lock。
  const migs = discover(opts.root);

  await engine.withConnection(async (conn) => {
    // 多副本同时启动时只有一个真正执行，其余在这里排队。
    await conn.execute(SQL_LOCK, [LOCK_KEY]);
    try {
      const done = await applied(conn);
      for (const m of migs) {
        const dbSum = done.get(m.version);
        if (dbSum !== undefined) {
          const fileSum = migrationChecksum(m);
          if (dbSum !== fileSum) {
            // 当场停住，后面的迁移一条都不许再跑（哪怕 dry_run）。
            throw new MigrationChecksumMismatch(m.version, m.name, dbSum, fileSum);
          }
          continue;
        }
        todo.push(m.version);
        if (opts.dryRun) continue;
        await conn.executeScript(migrationSql(m));
        await conn.execute(SQL_INSERT_APPLIED, [m.version, m.name, migrationChecksum(m)]);
      }
    } finally {
      // 解锁必须在 finally 里：会话级锁如果连接被复用而没释放，下一个迁移进程
      // 会永远排在队里等一把没人持有意图的锁。
      await conn.execute(SQL_UNLOCK, [LOCK_KEY]);
    }
  });
  return todo;
}

// ══════════════════════════════════════════════════════════════════
//  CLI 的可见字节
// ══════════════════════════════════════════════════════════════════
//
// Python 侧 `_main` 是 `python -m ontocopilot.store.migrate [--status|--dry-run]`。
// 它的接线（`database_url()` / `Store.open` / `store.close()`）要等 `engine.ts`
// 落地才能接，**这里先只把运维看得见的那几行字节钉住** —— 换行、方括号、那个
// 全角"（已是最新）"都是会被 grep 的东西。接线补上时直接用这三个函数拼。

/** `--status` 的一行：`[✓] 0001_init` / `[ ] 0002_accounts`。 */
export function statusLine(m: Migration, done: ReadonlySet<number> | ReadonlyMap<number, string>): string {
  const has = done instanceof Map ? done.has(m.version) : (done as ReadonlySet<number>).has(m.version);
  return `[${has ? "✓" : " "}] ${pad4(m.version)}_${m.name}`;
}

/** 迁移完成后的那一行。空列表印全角的"（已是最新）"，非空印 Python 列表形态。 */
export function summaryLine(ran: readonly number[]): string {
  return `应用了 ${ran.length} 个迁移: ${ran.length ? pyList(ran) : "（已是最新）"}`;
}

/** 没配 DATABASE_URL 时打到 **stderr** 的那行；退出码仍是 0（内存模式是合法部署）。 */
export const NO_DATABASE_URL_NOTE = "DATABASE_URL 未配置 —— 内存模式不需要迁移。";
