/**
 * DDL 解析 —— **本地**实现（`node-sql-parser` 拿结构 + 行扫描还原注释）。
 *
 * 以前这里是一层跨进程的薄封装，真身是 Python 的 sqlglot。那条路拆掉之后，
 * 这个文件成了真身。移植自 `onto/parse/sql.py`，一处一处对着它写。
 *
 * ── 为什么注释要单独花这么大力气 ──────────────────────────────────
 *
 * **注释是这个解析器最重要的产出**，不是附属信息。`plan_amount DECIMAL(18,2)`
 * 在两张表里长得一模一样，区别全在 `-- 含税·年度累计` 和 `-- 不含税·单次`
 * 这两行注释里。丢掉注释，口径冲突就永远发现不了 —— 而且**没有任何报错**：
 * 交付物看起来一切正常，只是少了一条本该问出来的问题。
 *
 * `node-sql-parser` 的 AST **不带行内注释**（`-- ...` 与 `/* ... *␘/` 在它的语法里
 * 是被吃掉的空白）。好消息是 Python 侧本来就不主要靠 AST 拿注释 —— `sql.py` 有
 * 三个来源依次兜底，这里逐条对应：
 *
 * | # | Python | 这里 | 说明 |
 * |---|---|---|---|
 * | 1 | `_column_comments()` 行扫描 | {@link columnComments} | **逐字搬过来**，连它认不出字符串字面量里的 `--` 这个毛病一起搬（见函数注释） |
 * | 2 | `_inline_comment()` `COMMENT '...'` | {@link inlineComment} | node-sql-parser 给 `create_definitions[].comment`，一一对应 |
 * | 3 | `_ast_comment()` sqlglot 挂在 ColumnDef 上的注释 | {@link sameLineComments} | **没有对等物**，改成自己扫括号定位每条定义，再按位置把注释配回去 |
 *
 * 第 3 条是这次替换里唯一"重新实现"的一段。它**没有**用 node-sql-parser 的
 * `includeLocations` —— 那个选项只有四种方言真的输出 `loc`，理由见
 * {@link sameLineComments}。配对规则是照着 Python 侧真跑出来的结果定的
 * （`golden/onto.parse.sql.json`），不是猜的：
 *
 * * 注释归**同一行上**它前面最近的那个定义 —— 所以
 *   `CREATE TABLE t (a DECIMAL(18,2) -- 含税` 里的注释能落到 `a` 头上
 *   （行扫描认不出这一行：它命中 `create table` 就 `continue` 了）；
 * * 注释**独占一行**时谁也不给 —— sqlglot 在这种写法下同样不挂到相邻列上
 *   （golden 里 `a INT,\n -- 说明\n b INT` 两列都是空串）；
 * * 前面最近的定义是 `PRIMARY KEY` / `CONSTRAINT` 这类**约束**时谁也不给 ——
 *   否则 `PRIMARY KEY (a) -- 主键说明` 会把"主键说明"写成列 a 的口径。
 *
 * ── 与 sqlglot 的能力差 ───────────────────────────────────────────
 *
 * 方言覆盖变窄了，这是真实的损失，见 {@link DIALECT_ALIASES} 上面那段。
 * 不认识的方言**不静默降级**：照样解析，但会在 findings 里说明白。
 */

import { createRequire } from "node:module";
import { basename } from "node:path";

import type { ParsedDoc } from "./base.js";
import { Parser as ParserBase, makeChunk, makeFinding, makeParsedDoc, readTextReplace } from "./base.js";

// node-sql-parser 是 CJS，且它的 d.ts 写成了 ESM 具名导出 —— 运行时
// `import { Parser } from "node-sql-parser"` 直接 SyntaxError（cjs-module-lexer
// 认不出它那套 `for (var e in t) r[e] = t[e]` 的导出）。与 template.ts 里的
// exceljs 同一个处理：类型来自 d.ts，值来自 module.exports。
const requireCjs = createRequire(import.meta.url);
type SqlParserModule = typeof import("node-sql-parser");
const { Parser: SqlParser } = requireCjs("node-sql-parser") as SqlParserModule;

// ══════════════════════════════════════════════════════════════════
//  0. 方言
// ══════════════════════════════════════════════════════════════════

/**
 * sqlglot 的方言名 → node-sql-parser 的 `database` 选项。
 *
 * **这张表就是这次替换的能力边界，数一遍：** node-sql-parser 认 14 种
 * （athena / bigquery / db2 / flinksql / hive / mariadb / mysql / noql /
 * postgresql / redshift / snowflake / sqlite / transactsql / trino），
 * sqlglot 30.x 认 32 种。**少了 22 种**：oracle / clickhouse / databricks /
 * duckdb / spark / spark2 / presto / teradata / doris / starrocks /
 * materialize / drill / druid / risingwave / tableau / dax / dremio / dune /
 * exasol / fabric / prql / solr。其中 **oracle 最疼** —— 国内 ERP 导出的 schema
 * 常见。（反过来 db2 / flinksql / mariadb / noql 是这边多出来的。）
 *
 * 客户的 schema 从哪个库导出事先不知道，这是当初选 sqlglot 的理由，
 * 所以这个损失是真的，不粉饰。缓解只有两条：认不出的方言走
 * {@link AUTO_DIALECTS} 尽力读（Oracle 的 `VARCHAR2(32)` 之类基本读得动），
 * 以及把这件事写进 findings 让人看见。
 *
 * 这些名字落到这里不会被悄悄当成 MySQL：见 {@link resolveDialect}，
 * 会走自动尝试链并在 findings 里写清楚"这个方言没有原生支持"。
 */
const DIALECT_ALIASES: Readonly<Record<string, string>> = {
  athena: "athena",
  bigquery: "bigquery",
  db2: "db2",
  flink: "flinksql",
  flinksql: "flinksql",
  hive: "hive",
  mariadb: "mariadb",
  mssql: "transactsql",
  mysql: "mysql",
  noql: "noql",
  postgres: "postgresql",
  postgresql: "postgresql",
  redshift: "redshift",
  snowflake: "snowflake",
  sqlite: "sqlite",
  transactsql: "transactsql",
  trino: "trino",
  tsql: "transactsql",
};

/**
 * 没指定方言时依次尝试的顺序。
 *
 * Python 侧 `sqlglot.parse(sql, read=None)` 用的是 sqlglot 自己那套"通用"方言，
 * 它对各家写法相当宽容。node-sql-parser 没有通用方言 —— 默认就是 MySQL，
 * 而 MySQL 语法吃不下 `TIMESTAMP WITH TIME ZONE` / `SERIAL` / `INT[]`。
 * 一次失败就等于整份 DDL 全丢（Python 侧也是这个语义），代价太大，所以这里换成
 * 依次尝试：**第一个能解析成功的方言胜出**。
 *
 * 顺序即优先级：MySQL 最常见排第一，其余按"语法与前一个差得最远"排，
 * 免得一份 PG 的 DDL 被某个更宽松的方言先"解析成功"成一个错的形状。
 */
const AUTO_DIALECTS = ["mysql", "postgresql", "transactsql", "sqlite", "bigquery"] as const;

interface ResolvedDialect {
  /** 依次尝试的 database 列表。 */
  readonly chain: readonly string[];
  /** 非空表示这个方言名 node-sql-parser 不认识，要报给用户。 */
  readonly unsupported: string;
}

function resolveDialect(dialect: string | null): ResolvedDialect {
  const key = (dialect ?? "").trim().toLowerCase();
  if (key === "") return { chain: AUTO_DIALECTS, unsupported: "" };
  const mapped = DIALECT_ALIASES[key];
  if (mapped !== undefined) return { chain: [mapped], unsupported: "" };
  // 不认识的方言：**不假装认识**。照样按自动链解析（多半也能读出结构），
  // 但把"你要的方言没有原生支持"这件事说出来 —— 静默当 MySQL 处理的话，
  // 一份 Oracle 的 DDL 会以"这个文件里没有表"的形态出现在用户面前。
  return { chain: AUTO_DIALECTS, unsupported: key };
}

// ══════════════════════════════════════════════════════════════════
//  1. node-sql-parser 的 AST 形状（只声明用得到的那几个键）
// ══════════════════════════════════════════════════════════════════

interface CreateStmt {
  readonly type?: string;
  readonly keyword?: string;
  readonly table?: readonly { readonly db?: unknown; readonly table?: unknown }[];
  readonly create_definitions?: readonly CreateDef[] | null;
}

interface CreateDef {
  readonly resource?: string;
  readonly column?: unknown;
  readonly definition?: unknown;
  readonly nullable?: { readonly type?: string } | null;
  readonly primary_key?: string | null;
  readonly comment?: unknown;
  readonly constraint?: unknown;
  readonly constraint_type?: string | null;
  readonly reference_definition?: {
    readonly definition?: readonly unknown[] | null;
    readonly table?: readonly { readonly table?: unknown }[] | null;
  } | null;
}

// ══════════════════════════════════════════════════════════════════
//  2. 解析器
// ══════════════════════════════════════════════════════════════════

export interface DdlTableColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly comment: string;
}

export interface DdlForeignKey {
  readonly name: string | null;
  readonly column: string;
  readonly ref_table: string;
  readonly ref_column: string;
}

export interface DdlTable {
  readonly name: string;
  readonly columns: readonly DdlTableColumn[];
  readonly primary_key: readonly string[];
  readonly foreign_keys: readonly DdlForeignKey[];
}

export class DdlParser extends ParserBase {
  override readonly kind = "ddl";
  override readonly extensions = [".ddl", ".sql"];

  constructor(readonly dialect: string | null = null) {
    super();
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileName = basename(path);
    // Python 侧是 `read_text(encoding="utf-8", errors="replace")`，不是 tabular
    // 那套编码猜测 —— DDL 基本都是 UTF-8，猜错编码比读出替换字符更难查。
    const sql = await readTextReplace(path);
    return parseDdl(sql, { fileId: opts.fileId, fileName, dialect: this.dialect });
  }
}

/**
 * 一段 DDL 文本 → `ParsedDoc`。`DdlParser.parse` 只是"读文件 + 调它"。
 *
 * 单独导出是为了测试能直接喂文本（golden 里的用例就是一段段 DDL 字符串），
 * 不必为每条用例落一个临时文件。
 */
export function parseDdl(
  sql: string,
  opts: { fileId: string; fileName: string; dialect?: string | null },
): ParsedDoc {
  const dialect = opts.dialect ?? null;
  const doc = makeParsedDoc({ fileId: opts.fileId, fileName: opts.fileName, kind: "ddl" });
  const { chain, unsupported } = resolveDialect(dialect);
  if (unsupported !== "") {
    doc.findings.push(
      makeFinding(
        "dialect_unsupported",
        `方言 ${unsupported} 没有原生支持（node-sql-parser 只认 ` +
          `${Object.keys(DIALECT_ALIASES).join(" / ")}），已按通用语法尽力解析`,
        {},
        "warn",
      ),
    );
  }

  let statements: CreateStmt[];
  try {
    statements = astify(sql, chain);
  } catch (exc) {
    // 方言千奇百怪，解析失败要报出来而不是静默 —— 与 Python 侧同一句话。
    doc.findings.push(
      makeFinding(
        "parse_failed",
        `DDL 解析失败（方言 ${dialect === null || dialect === "" ? "自动" : dialect}）：` +
          `${exc instanceof Error ? exc.message : String(exc)}`,
        {},
        "warn",
      ),
    );
    return doc;
  }

  const lineComments = columnComments(sql);
  const positional = sameLineComments(sql);

  const tables: DdlTable[] = [];
  let order = 0;
  for (const stmt of statements) {
    if (stmt.type !== "create" || String(stmt.keyword ?? "").toLowerCase() !== "table") continue;
    const tname = tableName(stmt);
    const { cols, pks, fks } = columnsOf(
      stmt,
      lineComments.get(tname) ?? new Map<string, string>(),
      positional.get(tname) ?? new Map<string, string>(),
    );
    tables.push({ name: tname, columns: cols, primary_key: pks, foreign_keys: fks });

    // 表级切片：一眼看清这张表是什么 + 主键 + 列名概览。检索"这张表有哪些字段"
    // 时不必把每个列切片都捞出来。
    const pkStr = pks.length > 0 ? `，主键 ${pks.join("+")}` : "";
    doc.chunks.push(
      makeChunk({
        docId: tname,
        fileId: opts.fileId,
        fileName: opts.fileName,
        locator: { kind: "ddl", object: tname },
        render:
          `表 ${tname}（${cols.length} 列${pkStr}）：` + cols.map((c) => c.name).join("、"),
        raw: { table: tname, primary_key: pks, columns: cols.map((c) => c.name) },
        order,
        tags: ["table"],
      }),
    );
    order += 1;

    for (const c of cols) {
      const bits = [`${tname}.${c.name} ${c.type}`];
      if (pks.includes(c.name)) bits.push("PRIMARY KEY");
      if (!c.nullable) bits.push("NOT NULL");
      if (c.comment !== "") bits.push(`-- ${c.comment}`);
      doc.chunks.push(
        makeChunk({
          docId: `${tname}.${c.name}`,
          fileId: opts.fileId,
          fileName: opts.fileName,
          locator: { kind: "ddl", object: `${tname}.${c.name}` },
          render: bits.join(" "),
          raw: c,
          order,
          tags: ["column"],
        }),
      );
      order += 1;
    }

    for (const fk of fks) {
      doc.chunks.push(
        makeChunk({
          docId: `${tname}.fk.${fk.column}`,
          fileId: opts.fileId,
          fileName: opts.fileName,
          locator: { kind: "ddl", object: `${tname}.${fk.name ?? "fk"}` },
          render:
            `${tname}.${fk.column} → ${fk.ref_table}.${fk.ref_column}` +
            `（外键，暗示 ${fk.ref_table} 一对多 ${tname}）`,
          raw: fk,
          order,
          tags: ["fk"],
        }),
      );
      order += 1;
    }
  }

  doc.structured = { tables };
  if (tables.length === 0) {
    doc.findings.push(makeFinding("no_tables", "文件里没有 CREATE TABLE 语句", {}, "warn"));
  }
  return doc;
}

/**
 * 按 {@link AUTO_DIALECTS} 依次试，第一个成功的胜出；全失败则抛**第一个**错误。
 *
 * 抛第一个而不是最后一个：链首是最可能的方言，它的报错离真实原因最近
 * （最后一个的报错多半是"BigQuery 不认识 ENGINE=InnoDB"这种误导性的话）。
 */
function astify(sql: string, chain: readonly string[]): CreateStmt[] {
  let first: unknown = null;
  for (const database of chain) {
    try {
      const ast = new SqlParser().astify(sql, { database });
      return (Array.isArray(ast) ? ast : [ast]) as CreateStmt[];
    } catch (e) {
      if (first === null) first = e;
    }
  }
  throw first instanceof Error ? first : new Error(String(first));
}

function tableName(stmt: CreateStmt): string {
  const t = stmt.table?.[0];
  // Python 取的是 `a.b` 里的最后一段（`_table_name` 走 sqlglot 的 Table.name）。
  // node-sql-parser 已经把 db 拆到单独的键，所以这里天然只剩最后一段。
  return identName(t?.table);
}

function columnsOf(
  stmt: CreateStmt,
  lineComments: ReadonlyMap<string, string>,
  positional: ReadonlyMap<string, string>,
): { cols: DdlTableColumn[]; pks: string[]; fks: DdlForeignKey[] } {
  const cols: DdlTableColumn[] = [];
  const pks: string[] = [];
  const fks: DdlForeignKey[] = [];

  for (const d of stmt.create_definitions ?? []) {
    if (d.resource === "column") {
      const name = identName(d.column);
      if (d.primary_key !== undefined && d.primary_key !== null) pks.push(name);
      cols.push({
        name,
        type: typeSql(d.definition),
        nullable: String(d.nullable?.type ?? "").toLowerCase() !== "not null",
        // 口径可能在 `-- 行注释`（行扫描）、行内 `COMMENT '...'`（AST 约束）、
        // 或与列定义同一行上的注释（AST 偏移量配对）里，三处依次兜底。
        comment:
          lineComments.get(name.toLowerCase()) ||
          inlineComment(d) ||
          positional.get(name.toLowerCase()) ||
          "",
      });
      continue;
    }
    const ct = String(d.constraint_type ?? "").toLowerCase();
    if (ct === "primary key") {
      for (const c of asArray(d.definition)) pks.push(identName(c));
    } else if (ct === "foreign key") {
      fks.push(...fkEdges(d));
    }
  }
  // Python 的 `list(dict.fromkeys(pks))` —— 去重且保序。
  return { cols, pks: [...new Set(pks)], fks };
}

/** 行内 `COMMENT '...'` → 文本（MySQL/Oracle 常这么写口径）。 */
function inlineComment(d: CreateDef): string {
  const c = d.comment;
  if (c === null || typeof c !== "object") return "";
  const value = (c as { value?: unknown }).value;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return "";
}

/**
 * 外键 → 边列表。源列与引用列**按位配对** —— 复合外键 (x,y)→(x,y) 才不会
 * 全指向第一个引用列。
 */
function fkEdges(d: CreateDef): DdlForeignKey[] {
  const ref = d.reference_definition ?? null;
  const refTable = ref === null ? "" : identName(ref.table?.[0]?.table);
  const refCols = ref === null ? [] : asArray(ref.definition).map(identName);
  const name = d.constraint === undefined || d.constraint === null ? null : identName(d.constraint);
  const out: DdlForeignKey[] = [];
  asArray(d.definition).forEach((c, i) => {
    const rc = i < refCols.length ? refCols[i] : (refCols[0] ?? "");
    out.push({ name, column: identName(c), ref_table: refTable, ref_column: rc ?? "" });
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  3. 注释的三个来源
// ══════════════════════════════════════════════════════════════════

// 与 `sql.py` 顶上那四条**同形**。唯一的改写是 `\w`：Python 3 的 `\w` 是
// Unicode 的（列名叫 `金额` 也算 word char），JS 的 `\w` 只有 ASCII —— 直接抄
// 会让中文列名的注释在这一条来源上整条消失。用 `\p{...}` 把 Python 的语义补回来。
const PY_W = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";
const LINE_COMMENT = /--\s*(.+?)\s*$/u;
const IDENT = new RegExp(`^\\s*[\`"\\[]?(${PY_W}+)[\`"\\]]?\\s+`, "iu");
const NON_COL = /^\s*(constraint|primary\s+key|foreign\s+key|unique|key|index|check)\b/iu;
const CREATE_TABLE_SRC =
  `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?[\`"\\[]?((?:${PY_W}|\\.)+)[\`"\\]]?`;
const CREATE_TABLE = new RegExp(CREATE_TABLE_SRC, "iu");
/** 同一条模式的全局版 —— `defAnchors` 要把整份 DDL 里的 CREATE TABLE 都走一遍。 */
const CREATE_TABLE_G = new RegExp(CREATE_TABLE_SRC, "giu");

/**
 * 按行号把 `--` 注释关联回列 —— `sql.py` 的 `_column_comments` **逐字搬过来**。
 *
 * AST 不保证保留注释位置，而口径信息几乎全在注释里 —— 所以宁可用行扫描这种
 * 土办法，也不能丢。
 *
 * 两个"看起来像 bug、但必须一起搬"的地方：
 *
 * * 它不认字符串字面量：`a VARCHAR(8) DEFAULT 'a--b', -- 真注释` 会从 `'a` 里
 *   那个 `--` 起算，取出 `b', -- 真注释`。Python 侧就是这个结果（golden 钉着），
 *   改"对"了反而两边不一样。
 * * 命中 `create table` 那行就 `continue` —— 同一行上的列在这条来源里永远
 *   没机会被关联到。那正是第三条来源（{@link sameLineComments}）要接住的。
 *
 * 返回 `表名 → {小写列名 → 注释}`。表名大小写照原样（Python 的键也是原样）。
 */
export function columnComments(sql: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let table = "";
  // Python 的 `str.splitlines()` 比 JS 的 `split("\n")` 多认 \v \f \x1c-\x1e
  // \x85 U+2028 U+2029。DDL 里见不到这些，但按 Python 的集合切才不会在某份
  // 从 Word 里粘出来的材料上悄悄差一行。
  for (const line of pySplitLines(sql)) {
    const m = CREATE_TABLE.exec(line);
    if (m !== null) {
      table = (m[1] ?? "").split(".").at(-1) ?? "";
      if (!out.has(table)) out.set(table, new Map());
      continue;
    }
    if (table === "") continue;
    const cm = LINE_COMMENT.exec(line);
    if (cm === null) continue;
    const head = line.slice(0, cm.index);
    if (NON_COL.test(head)) continue;
    const im = IDENT.exec(head);
    if (im === null) continue;
    let bucket = out.get(table);
    if (bucket === undefined) {
      bucket = new Map();
      out.set(table, bucket);
    }
    bucket.set((im[1] ?? "").toLowerCase(), cm[1] ?? "");
  }
  return out;
}

/** Python `str.splitlines()` 的分隔符集合。 */
function pySplitLines(s: string): string[] {
  return s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
}

interface ScannedComment {
  readonly text: string;
  readonly line: number;
  readonly offset: number;
}

/**
 * 扫出 SQL 里所有 `--` 与 `/* *␘/` 注释的**文本 + 起始行 + 起始偏移**。
 *
 * 与行扫描不同，这一条**认字符串字面量**：`'a--b'` 里的 `--` 不是注释。
 * 它替代的是 sqlglot 的 AST 注释，而 sqlglot 是真的在词法层认得引号的。
 */
function scanComments(sql: string): ScannedComment[] {
  const out: ScannedComment[] = [];
  let line = 1;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i += 1;
      while (i < sql.length) {
        const c = sql[i] as string;
        if (c === "\\" && ch === "'") {
          i += 2;
          continue;
        }
        if (c === "\n") line += 1;
        if (c === ch) {
          // `''` / `""` 是转义写法，不是结束。
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      let text = "";
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") {
        text += sql[i];
        i += 1;
      }
      out.push({ text: text.trim(), line, offset: start });
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      const startLine = line;
      i += 2;
      let text = "";
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        if (sql[i] === "\n") line += 1;
        text += sql[i];
        i += 1;
      }
      i += 2;
      out.push({ text: text.trim(), line: startLine, offset: start });
      continue;
    }
    i += 1;
  }
  return out;
}

interface Anchor {
  readonly offset: number;
  readonly line: number;
  /** 列名；`null` 表示这是个约束定义（`PRIMARY KEY` / `CONSTRAINT ...`）。 */
  readonly column: string | null;
  readonly table: string;
}

/**
 * 第三条来源：**按位置**把注释配回列，替代 sqlglot 的 `ColumnDef.comments`。
 *
 * 规则（照 `golden/onto.parse.sql.json` 里 Python 的真实行为定的，不是猜的）：
 * 一条注释归**同一行上、它前面最近**的那个定义；那个定义是约束就谁也不给；
 * 同一行上前面没有定义（注释独占一行）也谁也不给。
 *
 * ── 为什么定义的位置是自己扫出来的，不是从 AST 拿的 ────────────────
 *
 * node-sql-parser 有 `parseOptions.includeLocations`，AST 节点上会挂 `loc`。
 * 用它写这一段最省事 —— 但**它只在 mysql / mariadb / snowflake / trino 四种
 * 方言下真的输出 `loc`**，postgresql / transactsql / sqlite / hive / athena /
 * db2 / redshift / flinksql / noql 一律没有。靠 `loc` 的话，
 * `CREATE TABLE t (a INT -- 口径` 这种写法在 PG 的 DDL 上会**悄悄丢注释** ——
 * 正是这个文件存在的理由那一类失败，而且只在换了方言之后才出现，
 * 谁也不会想到去查。所以这里自己扫括号：一份代码，十四种方言同一个行为。
 *
 * 返回 `表名 → {小写列名 → 注释}`（与行扫描那条同形）。同列多条时取第一条。
 */
function sameLineComments(sql: string): Map<string, Map<string, string>> {
  const anchors = defAnchors(sql);
  const out = new Map<string, Map<string, string>>();
  for (const c of scanComments(sql)) {
    // 前面最近的那个定义。anchors 已按 offset 升序，线性扫足够（DDL 里
    // 列数是几十的量级，二分的复杂度不值得）。
    let hit: Anchor | null = null;
    for (const a of anchors) {
      if (a.offset >= c.offset) break;
      hit = a;
    }
    if (hit === null || hit.line !== c.line || hit.column === null) continue;
    let bucket = out.get(hit.table);
    if (bucket === undefined) {
      bucket = new Map();
      out.set(hit.table, bucket);
    }
    const key = hit.column.toLowerCase();
    if (!bucket.has(key)) bucket.set(key, c.text);
  }
  return out;
}

/**
 * 扫出每个 `CREATE TABLE (...)` 里**每条定义的起点**（顶层逗号分段）。
 *
 * 括号深度、字符串字面量、注释都要认 —— `DECIMAL(18,2)` 里那个逗号不是分隔符，
 * `DEFAULT 'a,b'` 里那个也不是。
 */
function defAnchors(sql: string): Anchor[] {
  const lineOf = lineIndex(sql);
  const out: Anchor[] = [];
  for (const m of sql.matchAll(CREATE_TABLE_G)) {
    const table = (m[1] ?? "").split(".").at(-1) ?? "";
    let i = skipToBodyParen(sql, m.index + m[0].length);
    if (i < 0) continue;
    let depth = 1;
    i += 1;
    let defStart = -1;
    while (i < sql.length && depth > 0) {
      const ch = sql[i] as string;
      if (ch === "'" || ch === '"' || ch === "`") {
        i = skipQuoted(sql, i);
        continue;
      }
      if (ch === "-" && sql[i + 1] === "-") {
        while (i < sql.length && sql[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && sql[i + 1] === "*") {
        const close = sql.indexOf("*/", i + 2);
        i = close < 0 ? sql.length : close + 2;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ")") {
        depth -= 1;
        i += 1;
        continue;
      }
      if (depth === 1 && ch === ",") {
        defStart = -1;
        i += 1;
        continue;
      }
      if (depth === 1 && defStart < 0 && !/\s/u.test(ch)) {
        defStart = i;
        // 一条定义只取它的起点：NON_COL 命中就是约束（注释不归它），
        // 否则第一个标识符就是列名。两条正则与行扫描用的是同一对。
        const head = sql.slice(i, i + 256);
        const im = NON_COL.test(head) ? null : IDENT.exec(head);
        out.push({
          offset: i,
          line: lineOf(i),
          column: im === null ? null : (im[1] ?? ""),
          table,
        });
      }
      i += 1;
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** 跳过 `CREATE TABLE t` 之后的空白/注释，返回列定义那个 `(` 的下标；没有给 -1。 */
function skipToBodyParen(sql: string, from: number): number {
  let i = from;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? sql.length : close + 2;
      continue;
    }
    return ch === "(" ? i : -1;
  }
  return -1;
}

/** 跳过一段引号包起来的东西，返回结束引号之后的下标。 */
function skipQuoted(sql: string, at: number): number {
  const q = sql[at] as string;
  let i = at + 1;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "\\" && q === "'") {
      i += 2;
      continue;
    }
    if (c === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/** 偏移量 → 行号（1 起）。行首表二分，逐字符数行在大文件上是 O(n²)。 */
function lineIndex(sql: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "\n") starts.push(i + 1);
  }
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ══════════════════════════════════════════════════════════════════
//  4. 小工具
// ══════════════════════════════════════════════════════════════════

/**
 * 列/表名。node-sql-parser 在不同方言下给的形状不一样：多数时候是字符串，
 * 引号标识符或新版语法下可能是 `{value}` / `{expr:{value}}`。三种都认，
 * 认不出就给空串 —— **不抛**：一个名字取不到不该让整份 DDL 消失。
 */
function identName(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return "";
  const rec = v as Record<string, unknown>;
  for (const k of ["column", "value", "expr", "name", "table"]) {
    const inner = rec[k];
    if (inner === undefined) continue;
    const got = identName(inner);
    if (got !== "") return got;
  }
  return "";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

/**
 * 列类型 → 文本。对齐 sqlglot 的 `DataType.sql()`：类型名大写，参数用 `, ` 分隔
 * （`DECIMAL(18, 2)` —— **逗号后有空格**，写成 `18,2` 就与 Python 侧对不上了）。
 */
function typeSql(def: unknown): string {
  if (def === null || typeof def !== "object") return "UNKNOWN";
  const d = def as Record<string, unknown>;
  const base = String(d["dataType"] ?? "").toUpperCase();
  if (base === "") return "UNKNOWN";
  const args: string[] = [];
  for (const k of ["length", "scale"]) {
    const v = d[k];
    if (typeof v === "number" || (typeof v === "string" && v !== "")) args.push(String(v));
  }
  let out = base;
  if (args.length > 0) {
    out += `(${args.join(", ")})`;
  } else {
    // ENUM('x','y') / SET(...) —— 值列表挂在 expr 上而不是 length 上。
    const expr = d["expr"] as { value?: unknown } | undefined;
    const items = asArray(expr?.value)
      .map((x) => (x !== null && typeof x === "object" ? (x as { value?: unknown }).value : x))
      .filter((x) => x !== undefined && x !== null);
    if (items.length > 0) out += `(${items.map((x) => `'${String(x)}'`).join(", ")})`;
  }
  const suffix = d["suffix"];
  if (Array.isArray(suffix) && suffix.length > 0) out += ` ${suffix.map(String).join(" ")}`;
  return out;
}
