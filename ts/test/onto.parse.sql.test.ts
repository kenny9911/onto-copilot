/**
 * DDL 解析：**列注释一条都不能丢**。
 *
 * 这个文件是 `tests/test_parse_ddl.py` 的 TS 版，加上一层 golden 对照。
 *
 * 丢注释是这个解析器里最贵的一类失败，而且**完全无声**：两张表都写
 * `plan_amount DECIMAL(18,2)`，区别全在 `-- 含税·年度累计` 与 `-- 不含税·单次`
 * 上。注释没了，口径冲突就再也检不出来，而没有任何东西会报错 —— 交付物看起来
 * 一切正常，只是少了一条本该问出来的问题。
 *
 * 换掉 sqlglot 之后这件事更要钉死：`node-sql-parser` 的 AST **根本不带行内注释**，
 * 注释全靠 `sql.ts` 里那三条来源自己捞回来。所以这里的期望值**一条都不手写** ——
 * 全部来自 `golden/onto.parse.sql.json`，由 `tools/golden/onto_parse_sql.py`
 * 直接跑 Python 原件（sqlglot）导出。手写的期望值是"我以为 Python 是这么干的"，
 * golden 是"Python 就是这么干的"。
 *
 * 末尾 "已知分叉" 一节钉的是 sqlglot → node-sql-parser 真实的能力差
 * （类型名的规范化、报错文本）。**钉住而不是跳过** —— 跳过的用例哪天真的坏了
 * 不会有人知道。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ParsedDoc } from "../src/onto/parse/base.js";
import { DdlParser, columnComments, parseDdl } from "../src/onto/parse/sql.js";

// ── golden ────────────────────────────────────────────────────────
interface DocDict {
  file_id: string;
  file_name: string;
  kind: string;
  chunks: Record<string, unknown>[];
  structured: Record<string, unknown>;
  findings: Record<string, unknown>[];
  meta: Record<string, unknown>;
}
interface Case {
  name: string;
  ddl: string;
  dialect: string | null;
  file_id: string;
  file_name: string;
  comments: Record<string, string>;
  doc: DocDict;
}

const G: Case[] = JSON.parse(
  readFileSync(join(__dirname, "../../golden/onto.parse.sql.json"), "utf8"),
) as Case[];

function byName(name: string): Case {
  const c = G.find((x) => x.name === name);
  if (c === undefined) throw new Error(`golden 里没有用例 ${name}`);
  return c;
}

function toDict(doc: ParsedDoc): Record<string, unknown> {
  return {
    file_id: doc.file_id,
    file_name: doc.file_name,
    kind: doc.kind,
    chunks: doc.chunks.map((c) => ({ ...c, tags: [...c.tags] })),
    structured: doc.structured,
    findings: doc.findings.map((f) => ({ ...f })),
    meta: doc.meta,
  };
}

/** 解析一段 DDL，返回 `{列名: 注释}` —— 与 pytest 里那个同名助手同形。 */
function columnsOf(c: Case): Record<string, string> {
  const doc = parseDdl(c.ddl, {
    fileId: c.file_id,
    fileName: c.file_name,
    dialect: c.dialect,
  });
  const tables = (doc.structured["tables"] ?? []) as { columns: { name: string; comment: string }[] }[];
  const first = tables[0];
  if (first === undefined) return {};
  return Object.fromEntries(first.columns.map((col) => [col.name, col.comment]));
}

// ══════════════════════════════════════════════════════════════════
//  1. 七种写法（tests/test_parse_ddl.py 的参数化，逐条搬过来）
// ══════════════════════════════════════════════════════════════════
describe("列注释在每一种写法下都活着", () => {
  const SHAPES = [
    // 这一条是回归本体：行扫描认不出它（命中 create table 就 continue 了），
    // 全靠第三条来源按位置配回去。
    "列与 CREATE TABLE 挤在同一行",
    // 以下本来就是好的，一并钉住免得改代码时把它们碰坏。
    "中间列 + 尾随逗号",
    "末列无逗号",
    "COMMENT 子句（MySQL/Oracle 写法）",
    "两列各带一条",
    "没有注释就是空串，不是 None",
    "单行写完整张表",
  ];

  it.each(SHAPES)("%s", (name) => {
    const c = byName(name);
    expect(columnsOf(c)).toEqual(c.comments);
  });

  it("golden 覆盖了这七种写法，一条都没少", () => {
    expect(SHAPES.length).toBe(7);
    for (const n of SHAPES) expect(byName(n).comments).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 两条语义断言（pytest 的后两个 test）
// ══════════════════════════════════════════════════════════════════
describe("语义", () => {
  it("三个来源取出来的文本必须同形，否则同一条口径在两种写法下不相等", () => {
    // 行扫描捕获的是 `--` 之后 strip 过的文本；按位置配对那条同样 strip。
    // 不对齐的话「同一行」与「换行」两种写法会产出 "含税" 与 " 含税"，
    // 冲突检测把它们当成两种不同的口径。
    const sameLine = columnsOf(byName("三来源同形·同一行"))["a"];
    const ownLine = columnsOf(byName("三来源同形·注释独占行尾"))["a"];
    expect(sameLine).toBe("含税·年度累计");
    expect(ownLine).toBe("含税·年度累计");
    expect(sameLine).toBe(ownLine);
  });

  it("两张只有注释不同的表必须能区分开", () => {
    // 这条是整个文件存在的理由：两张表的列声明逐字节相同，只有口径不同。
    // 注释一丢，它们就变成一模一样的两列，冲突检测无从下手。
    const a = columnsOf(byName("只有注释不同的两张表·A"));
    const b = columnsOf(byName("只有注释不同的两张表·B"));
    expect(a["plan_amount"]).toBe("含税·年度累计");
    expect(b["plan_amount"]).toBe("不含税·单次");
    expect(a).not.toEqual(b);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. 三条来源的分工边界（pytest 没覆盖，换解析器后最容易跑偏的地方）
// ══════════════════════════════════════════════════════════════════
describe("注释归谁：边界", () => {
  const EDGE = [
    "注释单独占一行（列的下一行）",
    "注释跟在 PRIMARY KEY 后面（不该算到列头上）",
    "注释跟在 CONSTRAINT 外键后面",
    "反引号列名",
    "注释文本里带引号和破折号",
    "字符串字面量里出现 --",
    "块注释 /* */",
    "NOT NULL + 内联 PRIMARY KEY + 注释",
    "schema 限定表名",
    "IF NOT EXISTS",
  ];

  it.each(EDGE)("%s", (name) => {
    const c = byName(name);
    expect(columnsOf(c)).toEqual(c.comments);
  });

  it("行扫描那条**逐字**搬自 Python，连它的毛病一起搬", () => {
    // `_column_comments` 不认字符串字面量：`'a--b'` 里的 `--` 会被当成注释起点。
    // Python 侧就是这个结果，改"对"了反而两边不一样 —— 所以单独钉一次，
    // 免得哪天有人"顺手修好"它。
    const c = byName("字符串字面量里出现 --");
    expect(columnComments(c.ddl).get("t")?.get("a")).toBe("b', -- 真注释");
    expect(c.comments["a"]).toBe("b', -- 真注释");
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. 整份 ParsedDoc 与 Python 逐字段比
// ══════════════════════════════════════════════════════════════════
describe("整份产物对齐 Python", () => {
  // 已知分叉的三条单列在最后一节，这里不比。
  const DIVERGENT = new Set(["解析不了的 DDL", "方言 mysql", "方言 postgres"]);

  it.each(G.filter((c) => !DIVERGENT.has(c.name)).map((c) => c.name))("%s", (name) => {
    const c = byName(name);
    const doc = parseDdl(c.ddl, {
      fileId: c.file_id,
      fileName: c.file_name,
      dialect: c.dialect,
    });
    expect(toDict(doc)).toEqual(c.doc);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. DdlParser 这一层（读文件 + 扩展名）
// ══════════════════════════════════════════════════════════════════
describe("DdlParser", () => {
  let tmp = "";
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "onto-ddl-"));
  });
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("从文件读出来的结果与直接喂文本一致", async () => {
    const c = byName("两张表 + 表级切片 + 外键切片");
    const p = join(tmp, c.file_name);
    await writeFile(p, c.ddl, "utf8");
    const doc = await new DdlParser(c.dialect).parse(p, { fileId: c.file_id });
    expect(toDict(doc)).toEqual(c.doc);
  });

  it("认 .ddl 与 .sql，不认别的", () => {
    const p = new DdlParser();
    expect(p.kind).toBe("ddl");
    expect([p.accepts("/m/a.ddl"), p.accepts("/m/a.SQL"), p.accepts("/m/a.txt")]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("没有 CREATE TABLE：structured 是空表列表 + no_tables", () => {
    const c = byName("没有 CREATE TABLE");
    const doc = parseDdl(c.ddl, { fileId: c.file_id, fileName: c.file_name });
    expect(toDict(doc)).toEqual(c.doc);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. 已知分叉（钉住，不绕过）
// ══════════════════════════════════════════════════════════════════
describe("已知分叉（sqlglot → node-sql-parser）", () => {
  it("解析失败：kind/severity/结构一致，异常文本必然不同", () => {
    const c = byName("解析不了的 DDL");
    const doc = parseDdl(c.ddl, { fileId: c.file_id, fileName: c.file_name });
    const py = c.doc.findings[0] as Record<string, unknown>;
    const ts = doc.findings[0];
    expect(py["kind"]).toBe("parse_failed");
    expect(ts?.kind).toBe("parse_failed");
    expect(ts?.severity).toBe(py["severity"]);
    // 失败时 structured 保持空 dict（不是 {tables: []}）—— 与 Python 一致，
    // 下游据此区分"解析没成"和"这份文件里真没有表"。
    expect(doc.structured).toEqual({});
    expect(c.doc.structured).toEqual({});
    // 措辞：Python 那句以 "sqlglot 解析失败" 开头，这里换成了 "DDL 解析失败"。
    // sqlglot 已经不在链路上了，继续写它的名字是句谎话。
    expect(ts?.message.startsWith("DDL 解析失败（方言 自动）：")).toBe(true);
    expect(String(py["message"]).startsWith("sqlglot 解析失败（方言 自动）：")).toBe(true);
  });

  it("类型名：sqlglot 会规范化，node-sql-parser 保留原文", () => {
    // 这是真实的行为差，不是 bug 也不是可以修的东西：sqlglot 把方言类型映到
    // 自己的类型系统再吐出来（MySQL 的 TIMESTAMP → TIMESTAMPTZ、
    // INT UNSIGNED → UINT），node-sql-parser 只是把 DDL 里写的那几个词还给你。
    //
    // 对这个产品的影响：**列类型是给人看的**（进 render、进冲突检测的对比），
    // 保留原文其实更贴近材料。但两边字符串不同这件事必须被记住 ——
    // 任何拿类型串做等值判断的下游都要知道它变了。
    const my = byName("方言 mysql");
    const myDoc = parseDdl(my.ddl, { fileId: my.file_id, fileName: my.file_name, dialect: "mysql" });
    const myCols = (myDoc.structured["tables"] as { columns: { name: string; type: string }[] }[])[0]
      ?.columns;
    expect(myCols?.map((c) => c.type)).toEqual(["TIMESTAMP", "INT UNSIGNED"]);
    const pyMyCols = (my.doc.structured["tables"] as { columns: { type: string }[] }[])[0]?.columns;
    expect(pyMyCols?.map((c) => c.type)).toEqual(["TIMESTAMPTZ", "UINT"]);
    // 注释与列名不受影响 —— 这才是这个解析器最重要的产出。
    expect(Object.fromEntries((myCols ?? []).map((c, i) => [c.name, i]))).toEqual({
      a: 0,
      b: 1,
    });

    const pg = byName("方言 postgres");
    const pgDoc = parseDdl(pg.ddl, {
      fileId: pg.file_id,
      fileName: pg.file_name,
      dialect: "postgres",
    });
    const pgCols = (pgDoc.structured["tables"] as { columns: { type: string; comment: string }[] }[])[0]
      ?.columns;
    expect(pgCols?.map((c) => c.type)).toEqual(["TIMESTAMP WITH TIME ZONE", "SERIAL"]);
    expect(pgCols?.map((c) => c.comment)).toEqual(["时间", ""]);
  });

  it("认不出的方言（oracle 等）不静默降级，findings 里说明白", () => {
    // sqlglot 认得 oracle / clickhouse / duckdb / spark / teradata……
    // node-sql-parser 一个都不认。这些 DDL 多数仍能按通用语法读出结构，
    // 但"我用的不是你要的方言"必须说出口 —— 悄悄当 MySQL 解析的后果是
    // 一份读歪了的 schema 看起来完全正常。
    const doc = parseDdl("CREATE TABLE t (\n  a VARCHAR2(32) -- 说明\n);", {
      fileId: "f_x",
      fileName: "o.ddl",
      dialect: "oracle",
    });
    const f = doc.findings.find((x) => x.kind === "dialect_unsupported");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("oracle");
    // 认得的方言不该冒出这条
    expect(
      parseDdl("CREATE TABLE t (a INT);", {
        fileId: "f_x",
        fileName: "o.ddl",
        dialect: "mysql",
      }).findings.map((x) => x.kind),
    ).toEqual([]);
  });

  it("换了方言注释也不能丢 —— 十四种方言同一个行为", () => {
    // 这条是防一次**已经发生过**的静默丢失：第三条来源本来是拿
    // node-sql-parser 的 `parseOptions.includeLocations` 写的，跑起来也全绿，
    // 直到发现 `loc` **只有 mysql / mariadb / snowflake / trino 四种方言输出**。
    // 于是 `CREATE TABLE t (a INT -- 口径` 这个写法（行扫描认不出、只能靠第三条
    // 来源接住的那个）在 PG 的 DDL 上会一声不响地丢掉注释 —— 而且只在换方言之后
    // 才出现，谁也不会想到去查。现在位置是自己扫括号扫出来的，与方言无关。
    const ddl = "CREATE TABLE t (a INT -- 口径\n);";
    for (const d of [
      null,
      "mysql",
      "mariadb",
      "postgres",
      "tsql",
      "sqlite",
      "hive",
      "athena",
      "db2",
      "redshift",
      "snowflake",
      "trino",
      "flinksql",
      "noql",
    ]) {
      const doc = parseDdl(ddl, { fileId: "f_x", fileName: "d.ddl", dialect: d });
      const cols = (doc.structured["tables"] as { columns: { comment: string }[] }[])[0]?.columns;
      expect(`${d ?? "auto"} → ${cols?.[0]?.comment ?? "<无表>"}`).toBe(`${d ?? "auto"} → 口径`);
    }
  });

  it("没指定方言时依次试，MySQL 读不动的写法不至于整份丢掉", () => {
    // Python 侧 sqlglot 有一套宽容的"通用"方言；node-sql-parser 没有，
    // 默认就是 MySQL，而 MySQL 语法吃不下 SERIAL / TIMESTAMP WITH TIME ZONE。
    // 一次失败 = 整份 DDL 全丢，所以这里换成依次尝试。
    const doc = parseDdl("CREATE TABLE t (\n  a SERIAL, -- 自增\n  b INT\n);", {
      fileId: "f_x",
      fileName: "pg.ddl",
    });
    const cols = (doc.structured["tables"] as { columns: { name: string; comment: string }[] }[])[0]
      ?.columns;
    expect(cols?.map((c) => c.name)).toEqual(["a", "b"]);
    expect(cols?.[0]?.comment).toBe("自增");
    expect(doc.findings).toEqual([]);
  });
});
