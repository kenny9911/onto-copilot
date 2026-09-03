/**
 * store/migrate.ts —— 全部断言来自 `golden/store_migrate.json`，那是拿一个**记录型
 * 假 engine** 真跑 Python 的 `upgrade()` 导出来的：语句顺序、参数、报错文本、
 * 连 CLI 的 stdout 都是 Python 真吐出来的字节，不是我写的期望值。
 *
 * 这里最要紧的一条不变量是**校验和锁定**：已应用的迁移内容一旦改动，必须当场
 * 拒绝，而不是"顺手重跑一遍"。golden 里 `tampered_*` 三个场景钉的就是它 ——
 * 包括 dry_run 也照拒（检查在 dry_run 分支之前），以及**解锁仍然发生**
 * （在 finally 里），不会把 advisory lock 连同异常一起漏在会话上。
 *
 * ── 没有真库这件事 ──────────────────────────────────────────────────────
 *
 * 这个文件不连 Postgres，也不 skip 任何用例。能这么做是因为 `migrate.ts` 收下的
 * 是 {@link MigrationEngine} 接口而不是驱动：**它自己产生的全部可观察行为**
 * （发哪些语句、什么顺序、带什么参数、什么时候不发）都在假 engine 上验得到，
 * 而且是逐字节和 Python 对齐的。
 *
 * 真库才验得到的只剩**服务端语义**，本模块不产生、也不实现它们：
 *   1. `pg_advisory_lock` 是否真的让第二个进程阻塞；
 *   2. 迁移脚本自带的 BEGIN/COMMIT 在 simple query protocol 下的事务边界；
 *   3. 某条 DDL 失败时"版本表如实反映停在哪"。
 * 这三条要的是一个真 Postgres + 两个进程的集成测试，不属于单元层。
 *
 * ── 与 Python 的两处形状差异（不是行为差异）────────────────────────────
 *
 * 1. Python 每次都发 `execution_options(isolation_level="AUTOCOMMIT")`，因为
 *    SQLAlchemy 会隐式 BEGIN。`pg` / `postgres.js` 默认就是 autocommit，没有这个
 *    开关，所以 TS 侧没有这一步 —— 比对轨迹时把它滤掉，并且**显式断言它出现过**，
 *    免得哪天 Python 侧删了这行而这里毫无察觉。
 * 2. 占位符 `:k` → `$1`。下面那张 {@link PY_SQL} 是唯一的翻译表，而且要求 golden
 *    里出现的每一条语句都在表里 —— Python 改了 SQL 文本，这里立刻红。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applied,
  discover,
  LOCK_KEY,
  MIGRATIONS,
  makeMigration,
  migrationChecksum,
  migrationSql,
  MigrationCatalogError,
  MigrationChecksumMismatch,
  MigrationError,
  NO_DATABASE_URL_NOTE,
  SQL_INSERT_APPLIED,
  SQL_LOCK,
  SQL_SELECT_APPLIED,
  SQL_TABLE_EXISTS,
  SQL_UNLOCK,
  statusLine,
  summaryLine,
  upgrade,
  type MigrationConn,
  type MigrationEngine,
} from "../src/store/migrate.js";

// ══════════════════════════════════════════════════════════════════
//  golden
// ══════════════════════════════════════════════════════════════════

interface CatalogEntry {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  sha256_full: string;
  chars: number;
  bytes: number;
}
interface DiscoverCase {
  label: string;
  files: string[];
  versions?: number[];
  names?: string[];
  error?: { type: string; message: string };
}
interface ChecksumCase {
  label: string;
  bytes_b64: string;
  text: string;
  checksum: string;
  sha256_full: string;
}
// 判别式必须一个成员一个字面量，`{op:"connect"|"close"}` 合成一条的话
// TS 在 `||` 链上narrow 不干净。
type PyOp =
  | { op: "connect" }
  | { op: "close" }
  | { op: "execution_options"; kw: Record<string, string> }
  | { op: "execute"; sql: string; params: Record<string, unknown> | null }
  | { op: "script"; sha256: string; chars: number };
interface ScenarioInput {
  dialect: string;
  table_exists: boolean;
  rows: unknown[][];
  root_kind: "default" | "empty";
}
interface Scenario {
  scenario: string;
  dry_run: boolean;
  input: ScenarioInput;
  applied?: number[];
  error?: { type: string; message: string };
  trace: PyOp[];
}
interface CliCase {
  label: string;
  argv: string[];
  rc: number;
  input: { url: string; table_exists: boolean; rows: unknown[][] };
  stdout: string;
  stderr: string;
}
interface Golden {
  lock_key: number;
  migrations_dir: string;
  migrations_is_source_checkout: boolean;
  catalog: CatalogEntry[];
  discover_cases: DiscoverCase[];
  checksum_cases: ChecksumCase[];
  upgrade_scenarios: Scenario[];
  cli_cases: CliCase[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/store_migrate.json"), "utf8"),
) as Golden;

const scenario = (name: string): Scenario => {
  const s = G.upgrade_scenarios.find((x) => x.scenario === name);
  if (!s) throw new Error(`golden 里没有场景 ${name}`);
  return s;
};

// ══════════════════════════════════════════════════════════════════
//  假 engine —— 记录 migrate.ts 发出的每一步
// ══════════════════════════════════════════════════════════════════

type TsStmtOp = { op: "scalar" | "rows" | "execute"; sql: string; params: unknown[] | null };
type TsScriptOp = { op: "script"; sha256: string; chars: number };
type TsOp = { op: "connect" } | { op: "close" } | TsStmtOp | TsScriptOp;

const isStmt = (t: TsOp): t is TsStmtOp =>
  t.op === "scalar" || t.op === "rows" || t.op === "execute";
const isScript = (t: TsOp): t is TsScriptOp => t.op === "script";
const isInsert = (t: TsOp): t is TsStmtOp =>
  isStmt(t) && t.op === "execute" && t.sql === SQL_INSERT_APPLIED;

class FakeEngine implements MigrationEngine {
  readonly trace: TsOp[] = [];
  constructor(
    readonly dialect: string,
    private readonly tableExists: boolean,
    private readonly dbRows: readonly (readonly unknown[])[],
  ) {}

  async withConnection<T>(fn: (conn: MigrationConn) => Promise<T>): Promise<T> {
    this.trace.push({ op: "connect" });
    try {
      return await fn(this.conn());
    } finally {
      // Python 的 `async with` 在异常穿过之后才关连接，所以 close 永远是最后一条。
      this.trace.push({ op: "close" });
    }
  }

  private rec(op: "scalar" | "rows" | "execute", sql: string, params?: readonly unknown[]): void {
    this.trace.push({ op, sql, params: params === undefined ? null : [...params] });
  }

  private conn(): MigrationConn {
    const self = this;
    return {
      async scalar(sql, params) {
        self.rec("scalar", sql, params);
        return sql === SQL_TABLE_EXISTS ? self.tableExists : null;
      },
      async rows(sql, params) {
        self.rec("rows", sql, params);
        return self.dbRows;
      },
      async execute(sql, params) {
        self.rec("execute", sql, params);
      },
      async executeScript(script) {
        self.trace.push({
          op: "script",
          sha256: createHash("sha256").update(Buffer.from(script, "utf8")).digest("hex"),
          // Python 的 len(str) 数的是 code point，不是 UTF-16 单元。
          chars: [...script].length,
        });
      },
    };
  }
}

/** Python 语句 → TS 语句 + 参数顺序 + 该走哪个方法。**唯一**的翻译表。 */
const PY_SQL: Record<string, { sql: string; order: string[]; op: "scalar" | "rows" | "execute" }> = {
  "SELECT pg_advisory_lock(:k)": { sql: SQL_LOCK, order: ["k"], op: "execute" },
  "SELECT pg_advisory_unlock(:k)": { sql: SQL_UNLOCK, order: ["k"], op: "execute" },
  "SELECT to_regclass('public.schema_migration') IS NOT NULL": {
    sql: SQL_TABLE_EXISTS,
    order: [],
    op: "scalar",
  },
  "SELECT version, checksum FROM schema_migration": {
    sql: SQL_SELECT_APPLIED,
    order: [],
    op: "rows",
  },
  "INSERT INTO schema_migration (version, name, checksum) VALUES (:v, :n, :c)": {
    sql: SQL_INSERT_APPLIED,
    order: ["v", "n", "c"],
    op: "execute",
  },
};

/** 把 Python 轨迹翻成 TS 侧应有的形状。滤掉 execution_options（见文件头差异 1）。 */
function expectedTrace(py: PyOp[]): TsOp[] {
  const out: TsOp[] = [];
  for (const step of py) {
    if (step.op === "execution_options") continue;
    if (step.op === "connect" || step.op === "close" || step.op === "script") {
      out.push(step);
      continue;
    }
    const m = PY_SQL[step.sql];
    if (!m) throw new Error(`翻译表里没有这条语句，Python 侧改过 SQL？ ${step.sql}`);
    out.push({
      op: m.op,
      sql: m.sql,
      params: step.params === null ? null : m.order.map((k) => step.params![k]),
    });
  }
  return out;
}

/** 场景装配全部来自 golden 的 input，避免这里照抄一遍导出脚本。 */
function engineFor(s: Scenario): FakeEngine {
  return new FakeEngine(s.input.dialect, s.input.table_exists, s.input.rows);
}

const emptyDir = (): string => mkdtempSync(join(tmpdir(), "onto-mig-"));

async function runScenario(s: Scenario): Promise<{ eng: FakeEngine; ran?: number[]; err?: Error }> {
  const eng = engineFor(s);
  const opts: { root?: string; dryRun?: boolean } = { dryRun: s.dry_run };
  if (s.input.root_kind === "empty") opts.root = emptyDir();
  try {
    return { eng, ran: await upgrade(eng, opts) };
  } catch (e) {
    return { eng, err: e as Error };
  }
}

// ══════════════════════════════════════════════════════════════════
//  目录发现
// ══════════════════════════════════════════════════════════════════

describe("discover", () => {
  it("默认目录就是仓库根的 migrations/", () => {
    expect(MIGRATIONS.endsWith(`/${G.migrations_dir}`)).toBe(true);
    expect(G.migrations_is_source_checkout).toBe(true);
  });

  it("扫出的目录与 Python 一模一样（版本号、名字、文件名）", () => {
    const got = discover().map((m) => ({
      version: m.version,
      name: m.name,
      filename: m.path.slice(m.path.lastIndexOf("/") + 1),
    }));
    expect(got).toEqual(
      G.catalog.map((c) => ({ version: c.version, name: c.name, filename: c.filename })),
    );
  });

  it("编号连续且从 1 起 —— 这是 discover 自己的判据，顺带钉住目录", () => {
    const versions = G.catalog.map((c) => c.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  for (const c of G.discover_cases) {
    it(`用例 ${c.label}`, () => {
      const dir = emptyDir();
      for (const f of c.files) writeFileSync(join(dir, f), `-- ${f}\n`, "utf8");
      if (c.error) {
        expect(() => discover(dir)).toThrow(MigrationCatalogError);
        expect(() => discover(dir)).toThrow(c.error.message);
        // Python 的 ValueError 在这里对应 MigrationCatalogError，且都在 MigrationError 之下。
        expect(c.error.type).toBe("ValueError");
      } else {
        expect(discover(dir).map((m) => m.version)).toEqual(c.versions);
        expect(discover(dir).map((m) => m.name)).toEqual(c.names);
      }
    });
  }

  it("报错文本连标点都不许漂（逐字节比对，不是 toThrow 的子串匹配）", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "0002_a.sql"), "x", "utf8");
    const msg = G.discover_cases.find((c) => c.label === "starts_at_two")!.error!.message;
    let caught: unknown;
    try {
      discover(dir);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe(msg);
    expect(caught).toBeInstanceOf(MigrationError);
  });
});

// ══════════════════════════════════════════════════════════════════
//  校验和
// ══════════════════════════════════════════════════════════════════

describe("checksum", () => {
  it("真实迁移文件的校验和与 Python 一致", () => {
    for (const [i, m] of discover().entries()) {
      const want = G.catalog[i]!;
      expect(`${m.version} ${migrationChecksum(m)}`).toBe(`${want.version} ${want.checksum}`);
      expect([...migrationSql(m)].length).toBe(want.chars);
    }
  });

  it("校验和是 sha256 的前 32 位，不是别的截法", () => {
    for (const [i, m] of discover().entries()) {
      expect(G.catalog[i]!.sha256_full.startsWith(migrationChecksum(m))).toBe(true);
      expect(migrationChecksum(m)).toHaveLength(32);
    }
  });

  for (const c of G.checksum_cases) {
    it(`换行/编码用例 ${c.label}`, () => {
      const dir = emptyDir();
      const p = join(dir, "0001_x.sql");
      writeFileSync(p, Buffer.from(c.bytes_b64, "base64"));
      const m = makeMigration(1, "x", p);
      // 先比文本，再比哈希 —— 哈希对不上时能一眼看出是不是换行翻译的问题。
      expect(migrationSql(m)).toBe(c.text);
      expect(migrationChecksum(m)).toBe(c.checksum);
    });
  }

  it("CRLF / CR / LF 三种换行给同一个校验和 —— 不然 Python 迁过的库会被误判成被改过", () => {
    const byLabel = new Map(G.checksum_cases.map((c) => [c.label, c.checksum]));
    expect(byLabel.get("crlf")).toBe(byLabel.get("lf"));
    expect(byLabel.get("cr_only")).toBe(byLabel.get("lf"));
  });

  it("BOM 不被吞掉（Python 的 utf-8 不是 utf-8-sig）", () => {
    const bom = G.checksum_cases.find((c) => c.label === "bom")!;
    expect(bom.text.startsWith("﻿")).toBe(true);
    expect(bom.checksum).not.toBe(
      G.checksum_cases.find((c) => c.label === "no_trailing_newline")!.checksum,
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  upgrade —— 逐场景比对语句轨迹
// ══════════════════════════════════════════════════════════════════

describe("upgrade", () => {
  for (const s of G.upgrade_scenarios) {
    it(`场景 ${s.scenario}${s.dry_run ? "（dry run）" : ""}`, async () => {
      const { eng, ran, err } = await runScenario(s);
      if (s.error) {
        expect(err, "Python 侧在这个场景抛了，TS 侧必须也抛").toBeInstanceOf(MigrationError);
        expect(err!.message).toBe(s.error.message);
      } else {
        expect(err).toBeUndefined();
        expect(ran).toEqual(s.applied);
      }
      expect(eng.trace).toEqual(expectedTrace(s.trace));
    });
  }

  it("Python 侧确实每次都设了 AUTOCOMMIT —— 这里滤掉它，但不许它悄悄消失", () => {
    for (const s of G.upgrade_scenarios) {
      const opts = s.trace.filter((t) => t.op === "execution_options");
      if (s.scenario.endsWith("_dialect")) {
        expect(opts, "方言不对时根本没连上，自然也没有这一步").toHaveLength(0);
        continue;
      }
      expect(opts).toHaveLength(1);
      expect((opts[0] as { kw: Record<string, string> }).kw).toEqual({
        isolation_level: "AUTOCOMMIT",
      });
    }
  });

  it("advisory lock 用的是 0x4F4E544F（b\"ONTO\"），并且加锁在读版本表之前", () => {
    expect(LOCK_KEY).toBe(G.lock_key);
    expect(LOCK_KEY).toBe(0x4f4e544f);
    const trace = expectedTrace(scenario("partial").trace);
    const lock = trace.findIndex((t) => isStmt(t) && t.sql === SQL_LOCK);
    const probe = trace.findIndex((t) => t.op === "scalar");
    const unlock = trace.findIndex((t) => isStmt(t) && t.sql === SQL_UNLOCK);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(probe);
    expect(unlock).toBeGreaterThan(probe);
  });

  it("**核心不变量**：已应用的迁移被改动 → 当场拒绝，一条脚本都不再跑", async () => {
    for (const name of ["tampered_first", "tampered_middle", "tampered_dry_run"]) {
      const s = scenario(name);
      const { eng, err } = await runScenario(s);
      expect(err).toBeInstanceOf(MigrationChecksumMismatch);
      expect(err!.message).toBe(s.error!.message);
      // "顺手重跑一遍"是这个模块最不能干的事：那条迁移在生产库上已经生效过。
      expect(eng.trace.filter(isScript)).toEqual([]);
      expect(eng.trace.filter(isInsert)).toEqual([]);
    }
  });

  it("拒绝之后 advisory lock 仍然被释放（解锁在 finally 里）", async () => {
    const { eng } = await runScenario(scenario("tampered_middle"));
    const tail = eng.trace.slice(-2);
    expect(tail).toEqual([{ op: "execute", sql: SQL_UNLOCK, params: [LOCK_KEY] }, { op: "close" }]);
  });

  it("篡改异常带得出定位信息（版本、名字、两个校验和）", async () => {
    const { err } = await runScenario(scenario("tampered_middle"));
    const e = err as MigrationChecksumMismatch;
    expect(e.version).toBe(3);
    expect(e.migrationName).toBe(G.catalog[2]!.name);
    expect(e.dbChecksum).toBe("0".repeat(32));
    expect(e.fileChecksum).toBe(G.catalog[2]!.checksum);
    // 消息里版本号是四位零填充的
    expect(e.message.startsWith(`迁移 0003_${G.catalog[2]!.name} `)).toBe(true);
  });

  it("dry run 只报要跑什么，一条脚本都不执行、一行版本都不写", async () => {
    const { eng, ran } = await runScenario(scenario("fresh_dry_run"));
    expect(ran).toEqual(G.catalog.map((c) => c.version));
    expect(eng.trace.some(isScript)).toBe(false);
    expect(eng.trace.some(isInsert)).toBe(false);
  });

  it("空库不去查版本表 —— 表都还没建", async () => {
    const { eng } = await runScenario(scenario("fresh"));
    expect(eng.trace.some((t) => t.op === "rows")).toBe(false);
    const scripts = eng.trace.filter(isScript);
    // 每个迁移的正文原样走过 executeScript：sha256 与 golden 目录逐条对上
    expect(scripts.map((t) => t.sha256)).toEqual(G.catalog.map((c) => c.sha256_full));
    expect(scripts.map((t) => t.chars)).toEqual(G.catalog.map((c) => c.chars));
  });

  it("每跑完一个迁移就立刻写版本行（脚本 → INSERT 交替），失败时停在哪一目了然", async () => {
    const { eng } = await runScenario(scenario("partial"));
    const shape = eng.trace.filter((t) => isScript(t) || isInsert(t)).map((t) => t.op);
    // partial 场景已经应用 1..5；剩余迁移必须逐个保持 script → INSERT 交替。
    const pending = G.catalog.filter((migration) => migration.version > 5).length;
    expect(shape).toEqual(Array.from({ length: pending * 2 }, (_, i) => (i % 2 ? "execute" : "script")));
    const inserts = eng.trace.filter(isInsert);
    expect(inserts.map((t) => t.params)).toEqual(
      G.catalog.slice(5).map((c) => [c.version, c.name, c.checksum]),
    );
  });

  it("库里有代码里没有的版本号（回滚到旧代码）不报错，只是不管它", async () => {
    const s = scenario("unknown_version_in_db");
    const { ran, err } = await runScenario(s);
    expect(err).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("version 列被驱动给成字符串时也能对上", async () => {
    const s = scenario("version_as_text");
    expect(s.input.rows[0]![0], "golden 的这条输入必须真是字符串").toBe("1");
    const { ran, err } = await runScenario(s);
    expect(err).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("非 Postgres 方言：在连接之前就抛，一条语句都不发", async () => {
    for (const name of ["sqlite_dialect", "mysql_dialect"]) {
      const s = scenario(name);
      const { eng, err } = await runScenario(s);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err).not.toBeInstanceOf(MigrationChecksumMismatch);
      expect(err!.message).toBe(s.error!.message);
      expect(eng.trace).toEqual([]);
    }
  });

  it("空目录照样加锁解锁 —— 别以为没得跑就不用排队", async () => {
    const { eng, ran } = await runScenario(scenario("empty_catalog"));
    expect(ran).toEqual([]);
    expect(eng.trace.filter(isStmt).map((t) => t.sql)).toEqual([
      SQL_LOCK,
      SQL_TABLE_EXISTS,
      SQL_UNLOCK,
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  applied
// ══════════════════════════════════════════════════════════════════

describe("applied", () => {
  /** 只为 applied 单测造一条最小连接。 */
  function connOf(tableExists: boolean, rows: readonly (readonly unknown[])[]): MigrationConn {
    return {
      async scalar() {
        return tableExists;
      },
      async rows() {
        return rows;
      },
      async execute() {},
      async executeScript() {},
    };
  }

  it("表不存在 → 空 Map", async () => {
    expect(await applied(connOf(false, [[1, "x"]]))).toEqual(new Map());
  });

  it("整数与字符串的 version 归一到同一个键", async () => {
    const m = await applied(connOf(true, [[1, "a"], ["2", "b"], [3n, "c"]]));
    expect([...m.entries()]).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
  });

  it("同一个版本出现两行时后写的赢（== Python 字典推导）", async () => {
    const m = await applied(connOf(true, [[1, "a"], [1, "b"]]));
    expect(m.get(1)).toBe("b");
  });

  it("version 不是整数 → 抛，不静默当成 NaN", async () => {
    await expect(applied(connOf(true, [["v1", "a"]]))).rejects.toBeInstanceOf(MigrationError);
  });

  it("真实目录 + 全部已应用 → 每一条都对得上，upgrade 无事可做", async () => {
    const rows = G.catalog.map((c) => [c.version, c.checksum]);
    const m = await applied(connOf(true, rows));
    for (const mig of discover()) expect(m.get(mig.version)).toBe(migrationChecksum(mig));
  });
});

// ══════════════════════════════════════════════════════════════════
//  CLI 的可见字节
// ══════════════════════════════════════════════════════════════════

describe("CLI 输出", () => {
  for (const c of G.cli_cases.filter((x) => x.argv.includes("--status"))) {
    it(`--status / ${c.label}`, () => {
      const done = new Map(c.input.rows.map((r) => [Number(r[0]), String(r[1])]));
      const lines = discover().map((m) => statusLine(m, c.input.table_exists ? done : new Map()));
      expect(lines.join("\n") + "\n").toBe(c.stdout);
    });
  }

  for (const c of G.cli_cases.filter((x) => !x.argv.includes("--status") && x.input.url)) {
    it(`迁移汇总行 / ${c.label}`, async () => {
      const eng = new FakeEngine("postgresql", c.input.table_exists, c.input.rows);
      const ran = await upgrade(eng, { dryRun: c.argv.includes("--dry-run") });
      expect(summaryLine(ran) + "\n").toBe(c.stdout);
    });
  }

  it("没配 DATABASE_URL 的那行走 stderr，且退出码是 0", () => {
    const c = G.cli_cases.find((x) => x.label === "no_database_url")!;
    expect(NO_DATABASE_URL_NOTE + "\n").toBe(c.stderr);
    expect(c.stdout).toBe("");
    expect(c.rc).toBe(0);
  });

  it("statusLine 的勾/空格与四位补零", () => {
    const m = makeMigration(7, "session_event_idempotency", "/x");
    expect(statusLine(m, new Map([[7, "abc"]]))).toBe("[✓] 0007_session_event_idempotency");
    expect(statusLine(m, new Set([1]))).toBe("[ ] 0007_session_event_idempotency");
  });
});
