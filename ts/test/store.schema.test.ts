/**
 * store/schema.ts 与 store/types.ts。
 *
 * 这个文件里最重要的一块是**列对齐**：`migrations/*.sql` 与表声明是两份来源，
 * 没有任何机制强制它们一致。schema.py 的文档字符串声称有个 `test_ddl_matches_metadata`
 * 兜着 —— 那个测试**根本不存在**，注释在撒谎。Python 侧后补了
 * `test_migrations_and_metadata_declare_the_same_columns`，这里是它的对应物：
 * 读迁移文本解析列名，与 TABLE_SPECS 比对。
 *
 * 少写一份的症状是"本地一切正常、线上第一次读就 relation does not exist /
 * no such column"，而且要等到那条路径真被走到才暴露 —— 所以先把**列**这一类
 * 钉死。索引/CHECK/触发器不在管辖范围内，它们确实已经漂了（见 schema.ts 头部）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";

import {
  columnNames,
  pgTables,
  sqliteTables,
  TABLE_NAMES,
  TABLE_SPECS,
  type ColKind,
  type TableName,
} from "../src/store/schema.js";
import {
  decisionIsActive,
  decisionRecordRowFromDomain,
  decisionToDialogueDict,
  DuplicateUsername,
  EMPTY_AS_NULL,
  emptyToNull,
  eventRowAsSse,
  makeDecisionRow,
  makeEventRow,
  makeProjectMemoryRow,
  makeProjectRow,
  makeSessionRow,
  makeUsageRow,
  makeUserRow,
  nullToEmpty,
  questionRowFromDomain,
  revisionRowFromDomain,
  sessionBrief,
  usageTotal,
  userPublic,
  validateUsageRow,
  type JsonObject,
} from "../src/store/types.js";

const MIGRATIONS = join(__dirname, "../../migrations");

const pgCfg = (n: TableName) => pgConfig(pgTables[n] as never);
const sqliteCfg = (n: TableName) => sqliteConfig(sqliteTables[n] as never);

// ══════════════════════════════════════════════════════════════════
//  migrations 与表声明的对齐
// ══════════════════════════════════════════════════════════════════

/** 从 migrations/*.sql 的文本里读出每张表的列名 —— 逐行照搬 Python 侧的解析。
 *
 * 只认 CREATE TABLE 的列定义与 ALTER TABLE ... ADD COLUMN；索引、CHECK、触发器、
 * plpgsql 函数一概不管 —— 那些确实已经漂移（schema 里一个 session 索引都没建过），
 * 把它们一起管起来会让这个测试从第一天就是红的，于是被 skip 掉。
 * 列是**运行时会崩**的那一类漂移（"no such column"），先把这一类钉死。 */
function columnsDeclaredByMigrations(): Map<string, string[]> {
  const create = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\);/gs;
  const alter = /ALTER TABLE (\w+)\s+ADD COLUMN (\w+)/gi;
  // \b 是必须的：没有它，"checksum text NOT NULL" 会被 CHECK 前缀吃掉。
  const notAColumn = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK)\b/i;
  const out = new Map<string, string[]>();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const [, table, body] of text.matchAll(create)) {
      const cols: string[] = [];
      for (const raw of body!.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("--") || notAColumn.test(line)) continue;
        const m = /^(\w+)\s+\w/.exec(line);
        if (m) cols.push(m[1]!);
      }
      out.set(table!, cols);
    }
    for (const [, table, col] of text.matchAll(alter)) {
      const prev = out.get(table!);
      if (prev) prev.push(col!);
      else out.set(table!, [col!]);
    }
  }
  return out;
}

describe("migrations 与表声明必须逐列对齐", () => {
  const declared = columnsDeclaredByMigrations();

  it("每张声明的表都得有迁移，否则 Postgres 上它根本不存在", () => {
    expect(new Set(TABLE_NAMES)).toEqual(new Set(declared.keys()));
  });

  for (const name of TABLE_NAMES) {
    it(`${name} 的列对得上`, () => {
      const fromSql = declared.get(name);
      expect(fromSql, `${name} 没有任何迁移`).toBeDefined();
      expect(new Set(fromSql)).toEqual(new Set(columnNames(name)));
      // 同一列被两个迁移各加一次 —— 在 PG 上第二次会直接失败，别让它先在这里蒙混
      expect(new Set(fromSql).size).toBe(fromSql!.length);
    });
  }

  it("解析器本身不是空转（否则上面全是真空真理）", () => {
    // 抽两条已知的：0004/0013 靠 ALTER 加的列必须被 alter 分支捡到
    expect(declared.get("session")).toContain("owner");
    expect(declared.get("session")).toContain("project_id");
    expect(declared.get("app_user")).toContain("display_name");
    expect(declared.get("session_event")).toContain("event_id");
    // CHECK 前缀不能把 checksum 吃掉（那个 \b 的理由）
    expect(declared.get("schema_migration")).toContain("checksum");
  });
});

// ══════════════════════════════════════════════════════════════════
//  两套方言由同一份 spec 生成 —— 不可能漂移
// ══════════════════════════════════════════════════════════════════

describe("pg 与 sqlite 两套声明同形", () => {
  for (const name of TABLE_NAMES) {
    it(name, () => {
      const p = pgCfg(name);
      const s = sqliteCfg(name);
      const shape = (
        cols: { name: string; notNull: boolean; hasDefault: boolean }[],
      ) => cols.map((c) => [c.name, c.notNull, c.hasDefault]);
      expect(shape(s.columns)).toEqual(shape(p.columns));
      expect(shape(p.columns)).toEqual(
        columnNames(name).map((c) => {
          const spec = TABLE_SPECS[name].columns[c] as {
            notNull?: true;
            pk?: true;
            default?: unknown;
          };
          return [c, spec.notNull === true || spec.pk === true, spec.default !== undefined];
        }),
      );
      expect(s.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(
        p.primaryKeys[0]?.columns.map((c) => c.name),
      );
      expect(s.checks.map((c) => c.name)).toEqual(p.checks.map((c) => c.name));
      expect(s.indexes.map((i) => i.config.name)).toEqual(p.indexes.map((i) => i.config.name));
      expect(s.foreignKeys.length).toBe(p.foreignKeys.length);
    });
  }
});

describe("方言类型映射（形态决策，改动必须是有意的）", () => {
  // 一个 kind 一个见证列。Drizzle 没有 with_variant，这张表就是"一份声明两套方言"
  // 落地成什么的全部答案 —— 谁改了它，下面的期望值必须跟着改，改不动就说明改错了。
  const witness: Record<ColKind, [TableName, string, string, string]> = {
    text: ["session", "title", "text", "text"],
    int: ["session", "next_run_ordinal", "integer", "integer"],
    bigint: ["session", "state_version", "bigint", "integer"],
    float: ["decision", "ts", "double precision", "real"],
    bool: ["session_state", "derived", "boolean", "integer"],
    json: ["session_state", "doc", "jsonb", "text"],
    bytes: ["blob", "data", "bytea", "blob"],
    tstz: ["session", "created_at", "timestamp with time zone", "text"],
  };
  for (const [kind, [table, col, pgType, sqType]] of Object.entries(witness)) {
    it(`${kind} → pg ${pgType} / sqlite ${sqType}`, () => {
      expect(TABLE_SPECS[table].columns[col as never]!["kind"]).toBe(kind);
      expect(pgCfg(table).columns.find((c) => c.name === col)!.getSQLType()).toBe(pgType);
      expect(sqliteCfg(table).columns.find((c) => c.name === col)!.getSQLType()).toBe(sqType);
    });
  }
});

describe("外键与部分索引", () => {
  it("每个外键的目标表/列都真实存在", () => {
    for (const name of TABLE_NAMES) {
      for (const [col, spec] of Object.entries(TABLE_SPECS[name].columns)) {
        const ref = (spec as { ref?: { table: TableName; column: string } }).ref;
        if (!ref) continue;
        expect(TABLE_NAMES, `${name}.${col} 指向不存在的表`).toContain(ref.table);
        expect(columnNames(ref.table), `${name}.${col} 指向不存在的列`).toContain(ref.column);
      }
    }
  });

  it("部分唯一索引两边都带上了 WHERE（丢了就从'幂等'变成'撞唯一约束'）", () => {
    // decision_live_answer_uq 没有 WHERE 的话，一个会话里第二条 target_rid='' 的
    // 非 answer 决定就会插不进去。
    for (const [t, ix] of [
      ["decision", "decision_live_answer_uq"],
      ["revision_record", "revision_record_idempotency_uq"],
      ["session_event", "session_event_event_id_uq"],
    ] as const) {
      for (const cfg of [pgCfg(t), sqliteCfg(t)]) {
        const found = cfg.indexes.find((i) => i.config.name === ix)!;
        expect(found, `${t}.${ix}`).toBeDefined();
        expect(found.config.unique).toBe(true);
        expect(found.config.where, `${t}.${ix} 少了 WHERE`).toBeDefined();
      }
    }
  });

  it("llm_usage 不挂 session 外键 —— 会话 purge 之后账还得在", () => {
    expect(pgCfg("llm_usage").foreignKeys).toHaveLength(0);
    // 同理：session.owner / session.project_id / project.owner 也都不设外键
    expect(pgCfg("session").foreignKeys).toHaveLength(0);
    expect(pgCfg("project").foreignKeys).toHaveLength(0);
    expect(pgCfg("project_memory").foreignKeys).toHaveLength(0);
  });

  it("llm_usage 的 CHECK 不重名（schema.py 里那四条各写了两遍）", () => {
    const names = pgCfg("llm_usage").checks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set([
        "llm_usage_kind_ck",
        "llm_usage_tokens_ck",
        "llm_usage_usd_ck",
        "llm_usage_attempts_ck",
        "llm_usage_usd_source_ck",
        "llm_usage_status_ck",
      ]),
    );
  });

  it("project.prefs 故意没有默认值，app_user.prefs 故意有 —— 两边都别'顺手统一'", () => {
    // 前者的理由写在 0013 里：跨方言的 JSON 默认值不一致，由代码总是显式写 {}。
    // 后者是 0002 就锁进 checksum 的既成事实。这条不一致是**已知**的，不是 bug。
    expect(pgCfg("project").columns.find((c) => c.name === "prefs")!.hasDefault).toBe(false);
    expect(pgCfg("app_user").columns.find((c) => c.name === "prefs")!.hasDefault).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  "" ↔ NULL
// ══════════════════════════════════════════════════════════════════

describe('"" 与 NULL 的双表示', () => {
  it("写库方向：假值一律 NULL", () => {
    expect(emptyToNull("")).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
    expect(emptyToNull("u1")).toBe("u1");
  });

  it("读库方向：NULL 一律 ''", () => {
    expect(nullToEmpty(null)).toBe("");
    expect(nullToEmpty(undefined)).toBe("");
    expect(nullToEmpty("")).toBe("");
    expect(nullToEmpty("u1")).toBe("u1");
  });

  it("往返幂等 —— 两个实现必须给出同一种空值，前端只判一种", () => {
    for (const v of ["", "u1"]) expect(nullToEmpty(emptyToNull(v))).toBe(v);
    expect(emptyToNull(nullToEmpty(null))).toBeNull();
  });

  it("清单里的列在 schema 里确实是可空的 text", () => {
    for (const ref of EMPTY_AS_NULL) {
      const [t, c] = ref.split(".") as [TableName, string];
      expect(columnNames(t), ref).toContain(c);
      const spec = TABLE_SPECS[t].columns[c as never] as { kind: string; notNull?: true; pk?: true };
      expect(spec.kind, `${ref} 不是 text`).toBe("text");
      expect(spec.notNull === true || spec.pk === true, `${ref} 是 NOT NULL，折叠没有意义`).toBe(
        false,
      );
    }
  });

  it("真的可空但**不**折叠的那几列没有混进清单", () => {
    // 这些列的 NULL 是"真的没有"：折叠成 "" 会把"没有父版本"和"父版本是空串"
    // 混成一件事。别看见可空 text 就往 EMPTY_AS_NULL 里加。
    const list: readonly string[] = EMPTY_AS_NULL;
    for (const ref of [
      "conflict.owner",
      "revision_record.parent_id",
      "decision_record.supersedes",
      "kernel_event.node_id",
      "kernel_event.ref",
      "session_event.ref",
    ]) {
      expect(list).not.toContain(ref);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  Row DTO
// ══════════════════════════════════════════════════════════════════

describe("工厂的默认值与 Python dataclass 一致", () => {
  it("SessionRow", () => {
    expect(makeSessionRow({ id: "s1" })).toEqual({
      id: "s1",
      title: "新建会话",
      project: "",
      status: "idle",
      error: "",
      created: 0,
      state_version: 0,
      owner: "",
      project_id: "",
    });
  });

  it("ProjectRow / ProjectMemoryRow", () => {
    expect(makeProjectRow({ id: "p1", name: "采购域" })).toEqual({
      id: "p1",
      name: "采购域",
      owner: "",
      prefs: {},
      sort_order: 0,
    });
    const m = makeProjectMemoryRow({
      project_id: "p1",
      key: "term:采购包",
      tier: "authoritative",
      kind: "decision",
      content: "采购包 = 一次招标里打包的若干标的",
    });
    expect(m.confidence).toBe(0.5);
    expect([m.support, m.tags, m.origin_files, m.contested_by, m.hit_runs]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
    // tier 是整个功能的地基：仓储不判断谁能晋升，但绝不能弄丢或改写这个标记
    expect(m.tier).toBe("authoritative");
  });

  it("UsageRow / UserRow / DecisionRow", () => {
    const u = makeUsageRow({ id: "u1", ts: 1, day: "2026-08-13", model: "x" });
    expect([u.kind, u.usd_source, u.attempts, u.status, u.usd]).toEqual([
      "build",
      "estimated",
      1,
      "ok",
      0,
    ]);
    expect(makeUserRow({ id: "u", username: "a", password_hash: "h" }).active).toBe(true);
    expect(makeDecisionRow({ ordinal: 0, kind: "answer" }).turn_index).toBe(-1);
  });

  it("每次都给新数组/新对象，绝不共享引用", () => {
    const shared = ["a"];
    const a = makeProjectMemoryRow({
      project_id: "p",
      key: "k",
      tier: "reference",
      kind: "fact",
      content: "c",
      support: shared,
    });
    const b = makeProjectMemoryRow({
      project_id: "p",
      key: "k2",
      tier: "reference",
      kind: "fact",
      content: "c",
      support: shared,
    });
    shared.push("b");
    expect(a.support).toEqual(["a"]);
    expect(a.support).not.toBe(b.support);
    expect(makeSessionRow({ id: "s" })).not.toBe(makeSessionRow({ id: "s" }));
  });
});

describe("DTO 上的行为", () => {
  it("sessionBrief 的键与 server.py:115-118 一一对应", () => {
    expect(Object.keys(sessionBrief(makeSessionRow({ id: "s1" }), 3))).toEqual([
      "id",
      "title",
      "project",
      "status",
      "files",
      "created",
      "error",
      "project_id",
    ]);
  });

  it("eventRowAsSse：payload 展开在中间，kind 永远在最后赢", () => {
    const r = makeEventRow({
      seq: 7,
      kind: "node.completed",
      ts: 1.5,
      payload: { node: "CONFLICT", kind: "冒充的" },
    });
    const sse = eventRowAsSse(r);
    // payload 里的 kind **不能**盖掉行上的 kind —— 盖掉了 SSE 的事件类型就跟库里对不上
    expect(sse["kind"]).toBe("node.completed");
    expect(sse["node"]).toBe("CONFLICT");
    expect(sse["eventId"]).toBeUndefined();
    // 反过来，payload 里的 seq **会**盖掉外层的 seq（Python 就是这个顺序）
    expect(eventRowAsSse(makeEventRow({ seq: 7, kind: "k", ts: 0, payload: { seq: 99 } }))["seq"])
      .toBe(99);
    expect(eventRowAsSse(makeEventRow({ seq: 1, kind: "k", ts: 0, event_id: "e" }))["eventId"])
      .toBe("e");
  });

  it("decisionIsActive / decisionToDialogueDict", () => {
    expect(decisionIsActive(makeDecisionRow({ ordinal: 0, kind: "answer" }))).toBe(true);
    expect(decisionIsActive(makeDecisionRow({ ordinal: 0, kind: "answer", superseded_by: 3 })))
      .toBe(false);
    // DialogueMemory.fromDict 读的是 turn，不是 turn_index
    expect(
      decisionToDialogueDict(makeDecisionRow({ ordinal: 1, kind: "naming", turn_index: 4 })),
    ).toEqual({
      kind: "naming",
      statement: "",
      scope_refs: [],
      turn: 4,
      ts: 0,
      superseded_by: null,
    });
  });

  it("userPublic 永不带 password_hash", () => {
    const pub = userPublic(makeUserRow({ id: "u", username: "a", password_hash: "scrypt$x" }));
    expect(pub["password_hash"]).toBeUndefined();
    expect(Object.values(pub)).not.toContain("scrypt$x");
    expect(pub["display_name"]).toBe("");
  });

  it("usageTotal 把四种 token 都算进去 —— 少算一项就是把账做小", () => {
    const u = makeUsageRow({
      id: "u",
      ts: 0,
      day: "d",
      model: "m",
      tok_in: 1,
      tok_out: 2,
      cache_read: 4,
      cache_write: 8,
    });
    expect(usageTotal(u)).toBe(15);
  });

  it("validateUsageRow 在两个实现落库之前就把契约拉平", () => {
    const base = { id: "u", ts: 0, day: "2026-08-13", model: "m" };
    expect(() => validateUsageRow(makeUsageRow(base))).not.toThrow();
    expect(() => validateUsageRow(makeUsageRow({ ...base, id: "" }))).toThrow(/id\/model/);
    expect(() => validateUsageRow(makeUsageRow({ ...base, kind: "?" }))).toThrow(/kind/);
    expect(() => validateUsageRow(makeUsageRow({ ...base, tok_in: -1 }))).toThrow(/负数/);
    expect(() => validateUsageRow(makeUsageRow({ ...base, usd: -0.01 }))).toThrow(/usd/);
    expect(() => validateUsageRow(makeUsageRow({ ...base, usd_source: "猜的" }))).toThrow(
      /usd_source/,
    );
    expect(() => validateUsageRow(makeUsageRow({ ...base, attempts: 0 }))).toThrow(/attempts/);
    expect(() => validateUsageRow(makeUsageRow({ ...base, status: "?" }))).toThrow(/status/);
  });

  it("DuplicateUsername 过得了 instanceof", () => {
    const e = new DuplicateUsername("alice 已存在");
    expect(e).toBeInstanceOf(DuplicateUsername);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DuplicateUsername");
  });
});

describe("从领域对象投影（Python 的 from_domain）", () => {
  const dom = (d: JsonObject) => ({ toDict: () => d });

  it("缺 key 用默认，值存在但为假**不**回落（.get(k, dflt) 不是 x or dflt）", () => {
    const full = questionRowFromDomain(
      dom({ id: "q1", text: "谁负责", status: "open", priority: "", sourceKind: "" }),
    );
    // priority/"sourceKind" 键在、值是空串 → 照原样留空串，不变成 normal/manual
    expect([full.priority, full.source_kind]).toEqual(["", ""]);
    const bare = questionRowFromDomain(dom({ id: "q1", text: "谁负责", status: "open" }));
    expect([bare.priority, bare.source_kind]).toEqual(["normal", "manual"]);
    // answerSchema 那几个是 `or {}` / `or []` —— 假值确实回落
    expect(bare.answer_schema).toEqual({});
    expect(bare.dependencies).toEqual([]);
    expect(bare.doc["id"]).toBe("q1");
  });

  it("必需键缺失就抛，不静默 undefined", () => {
    expect(() => questionRowFromDomain(dom({ text: "x", status: "open" }))).toThrow(/id/);
  });

  it("int() 是向零截断，不是四舍五入", () => {
    // Python `int(d["ordinal"])`：3.9 → 3。用 Number() 会留下 3.9，落进 bigint 列
    // 之后再读出来就不是同一个数了。
    const r = revisionRowFromDomain(
      dom({ id: "r1", ordinal: 3.9, kind: "edit", status: "applied" }),
    );
    expect(r.ordinal).toBe(3);
    expect(r.parent_id).toBeNull();
    expect(r.patch_set).toBeNull();
    expect(r.idempotency_key).toBe("");
  });

  it("非数值不静默变 NaN（NaN 会一路飘进库里）", () => {
    expect(() => revisionRowFromDomain(dom({ id: "r", ordinal: "三" }))).toThrow(/int\(\)/);
  });

  it("semantic_hash 来自领域对象的 fingerprint，不在 toDict() 里", () => {
    const row = decisionRecordRowFromDomain({
      toDict: () => ({ id: "d1", questionId: "q1", answer: { pick: "A" } }),
      fingerprint: "abc123",
    });
    expect(row.semantic_hash).toBe("abc123");
    expect(row.actor).toBe("user");
    expect(row.supersedes).toBeNull();
    expect(row.revision).toBeNull();
    expect(row.answer).toEqual({ pick: "A" });
  });
});
