/**
 * `store/pg_driver.ts` —— PG 分支的接线。
 *
 * **这个文件里没有假覆盖。** 需要真库的那一组用例只在能连上 Postgres 时才跑；
 * 连不上就整组跳过并在控制台喊一嗓子，而不是靠一堆 `it.skip` 冒充绿色。
 * 本地起法：
 *
 *     docker run -d --name oc_ts_pg -e POSTGRES_PASSWORD=oc -e POSTGRES_USER=oc \
 *                -e POSTGRES_DB=oc -p 55433:5432 postgres:16-alpine
 *
 * 覆盖的是"接线可能错、而 SQLite 那边永远看不出来"的那些地方：
 *   * 占位符改写（错位 = 越权，见 `toPgPlaceholders` 的注释）；
 *   * 三类值形态（jsonb / boolean / bigint）在 sqlite 列解码器下的还原；
 *   * 迁移能真的把 23 张表建出来，且第二次跑是空操作；
 *   * **双方言一致性**：同一串仓储操作，SQLite 与 Postgres 给出同样的结果。
 */

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/store/engine.js";
import type { Engine, PgPoolOptions } from "../src/store/engine.js";
import { upgrade } from "../src/store/migrate.js";
import { PgEngine, toPgPlaceholders } from "../src/store/pg_driver.js";
import { PgRepo } from "../src/store/repo/pg.js";
import type { Repo } from "../src/store/repo/protocol.js";
import { TABLE_NAMES } from "../src/store/schema.js";
import {
  makeAuthSessionRow,
  makeFileRow,
  makeProjectMemoryRow,
  makeProjectRow,
  makeSessionRow,
  makeUsageRow,
  makeUserRow,
} from "../src/store/types.js";

// ══════════════════════════════════════════════════════════════════
//  占位符改写（纯函数，永远跑）
// ══════════════════════════════════════════════════════════════════

describe("toPgPlaceholders", () => {
  it("按出现顺序编号", () => {
    expect(toPgPlaceholders('select * from "s" where a = ? and b = ?')).toBe(
      'select * from "s" where a = $1 and b = $2',
    );
    expect(toPgPlaceholders("select 1")).toBe("select 1"); // 没有 ? 就原样返回
  });

  it("字符串字面量里的问号不算占位符", () => {
    // 错位一个参数，在归属查询上就是"看到别人的会话"。
    expect(toPgPlaceholders("select '?' , ? from t")).toBe("select '?' , $1 from t");
    expect(toPgPlaceholders("select 'it''s ?' , ?")).toBe("select 'it''s ?' , $1");
  });

  it("引号标识符与注释里的问号也不算", () => {
    expect(toPgPlaceholders('select "a?b" , ? from t')).toBe('select "a?b" , $1 from t');
    expect(toPgPlaceholders('select "a""?b" , ?')).toBe('select "a""?b" , $1');
    expect(toPgPlaceholders("select ? -- ?\n, ?")).toBe("select $1 -- ?\n, $2");
    expect(toPgPlaceholders("select ? /* ? */ , ?")).toBe("select $1 /* ? */ , $2");
  });

  it("已经是 $N 的 SQL 原样返回（migrate.ts 发的就是这种）", () => {
    expect(toPgPlaceholders("SELECT pg_advisory_lock($1)")).toBe("SELECT pg_advisory_lock($1)");
  });
});

// ══════════════════════════════════════════════════════════════════
//  真库
// ══════════════════════════════════════════════════════════════════

const PG_URL = process.env["OC_TEST_PG_URL"] ?? "postgresql://oc:oc@127.0.0.1:55433/oc";

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const PG_UP = await pgReachable();
if (!PG_UP) {
  console.warn(
    `[store.pg_driver] 连不上 ${PG_URL} —— 真库那组用例整组跳过。` +
      "这不是绿色，是没测：起一个 postgres 再跑（见文件头）。",
  );
}

const POOL: PgPoolOptions = {
  poolPrePing: true,
  poolSize: 3,
  maxOverflow: 2,
  poolRecycle: 1800,
};

/** 每次从零开始 —— 迁移是"从空库到最新"，在残留 schema 上跑测不出这件事。 */
async function resetPublicSchema(): Promise<void> {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    await c.query("DROP SCHEMA IF EXISTS public CASCADE");
    await c.query("CREATE SCHEMA public");
  } finally {
    await c.end();
  }
}

/** 每个写数据的用例自己清干净 —— 上一个用例**失败**时留下的行会让下一个用例
 * 报一句毫不相干的 duplicate key，那种红是纯噪声。 */
async function truncateAll(): Promise<void> {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    // **`schema_migration` 不能清**：清了下一次 upgrade 会以为是空库，把 13 个
    // 迁移在已有的表上重跑一遍，然后整条连接卡在 "current transaction is aborted"。
    const list = TABLE_NAMES.filter((n) => n !== "schema_migration")
      .map((n) => `"${n}"`)
      .join(", ");
    await c.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await c.end();
  }
}

/** schema 到位（幂等）。用例之间不假设执行顺序。 */
async function ensureSchema(): Promise<void> {
  const e = new PgEngine(PG_URL, POOL);
  try {
    await upgrade(e);
  } finally {
    await e.dispose();
  }
}

describe.skipIf(!PG_UP)("Postgres 真库", () => {
  it("Store.open 走到真引擎，healthcheck 报 schema_migration 的版本", async () => {
    await resetPublicSchema();
    const store = await Store.open(`postgresql+asyncpg://${PG_URL.slice("postgresql://".length)}`);
    try {
      expect(store.mode).toBe("postgres");
      expect(store.engine?.dialect).toBe("postgresql");
      // 空库里连 schema_migration 都没有 → healthcheck 必须**如实报失败**，
      // 不能给一个看起来正常的 0。
      const empty = await store.healthcheck();
      expect(empty.ok).toBe(false);

      const ran = await upgrade(store.engine as unknown as PgEngine);
      expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      // 第二次是空操作 —— 迁移不是幂等的话，滚动发布第二个副本就会重建表。
      expect(await upgrade(store.engine as unknown as PgEngine)).toEqual([]);

      const health = await store.healthcheck();
      expect(health).toEqual({ mode: "postgres", ok: true, schema_version: 13 });
    } finally {
      await store.close();
    }
  }, 60_000);

  it("迁移建出来的表覆盖 schema.ts 声明的 23 张", async () => {
    await ensureSchema();
    const engine = new PgEngine(PG_URL, POOL);
    try {
      const rows = await engine.connect(async (conn) =>
        conn.all<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        ),
      );
      const have = new Set(rows.map((r) => r.tablename));
      const missing = TABLE_NAMES.filter((n) => !have.has(n));
      expect(missing).toEqual([]);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  it("三类值形态（jsonb / boolean / bigint）在 sqlite 列解码器下原样还原", async () => {
    await ensureSchema();
    await truncateAll();
    const engine = new PgEngine(PG_URL, POOL);
    const repo: Repo = new PgRepo(engine);
    try {
      // jsonb 里存**标量**是最容易翻车的一种：pg 默认解析器会把它变成一个普通
      // JS 字符串/数字，与 text 列的回值在值层面完全无从分辨。
      const values: [string, unknown][] = [
        ["obj", { a: 1, b: ["x", null], c: { d: true } }],
        ["str", "裸字符串"],
        ["num", 12.5],
        ["bool", true],
        ["arr", [1, "二", false, null]],
      ];
      for (const [k, v] of values) await repo.setSetting(`t_${k}`, v as never);
      for (const [k, v] of values) expect(await repo.getSetting(`t_${k}`), k).toEqual(v);

      // boolean：PG 回 't'/'f'，sqlite 的解码器要的是 1/0。
      const u = await repo.createUser(
        makeUserRow({ id: "pgu1", username: "pgu1", password_hash: "h", active: false }),
      );
      expect(u.active).toBe(false);
      expect((await repo.getUser("pgu1"))?.active).toBe(false);
      expect((await repo.updateUser("pgu1", { active: true }))?.active).toBe(true);
      expect((await repo.getUser("pgu1"))?.active).toBe(true);

      // bigint：pg 默认回字符串，DTO 层必须是 number。
      await repo.createSession(makeSessionRow({ id: "pgs1", owner: "pgu1" }));
      for (let i = 0; i < 3; i++) await repo.appendEvent("pgs1", "k", { i });
      const evs = await repo.readEvents("pgs1");
      expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
      for (const e of evs) expect(typeof e.seq).toBe("number");
      expect(await repo.countEvents("pgs1")).toBe(3);

      // tstz：pg 回 Date，tstzEpoch 认它。
      const s = await repo.getSession("pgs1");
      expect(typeof s?.created).toBe("number");
      expect(s!.created).toBeGreaterThan(1_600_000_000);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  it("双方言一致性：同一串操作，SQLite 与 Postgres 给同样的结果", async () => {
    await ensureSchema();
    await truncateAll();
    const dir = mkdtempSync(join(tmpdir(), "oc-pgdual-"));
    const sqliteStore = await Store.open(`sqlite+aiosqlite:///${join(dir, "x.db")}`, {
      createAll: true,
    });
    const pgEngine = new PgEngine(PG_URL, POOL);
    try {
      const sqliteOut = await battery(new PgRepo(sqliteStore.engine as Engine));
      const pgOut = await battery(new PgRepo(pgEngine));
      // **"两边同样地炸"也会全绿。** 所以先钉住：除了那一条故意撞唯一约束的，
      // 剩下每一步都得真的成功。少了这道，接线全断都能通过。
      const failed = (xs: Step[]): string[] =>
        xs
          .filter((x) => x.value !== null && typeof x.value === "object" && "__threw" in x.value)
          .map((x) => x.step);
      expect(failed(pgOut)).toEqual(["createUser/dup"]);
      expect(failed(sqliteOut)).toEqual(["createUser/dup"]);
      expect(pgOut.length).toBeGreaterThan(60);
      expect(pgOut.map((x) => x.step)).toEqual(sqliteOut.map((x) => x.step));
      for (const [i, a] of pgOut.entries()) {
        expect(a, `第 ${i} 步 ${a.step}`).toEqual(sqliteOut[i]);
      }
    } finally {
      await sqliteStore.close();
      await pgEngine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("pool 的三个旋钮真的落到驱动上", async () => {
    const engine = new PgEngine(PG_URL, {
      poolPrePing: true,
      poolSize: 2,
      maxOverflow: 3,
      poolRecycle: 7,
    });
    try {
      const pool = (engine as unknown as { pool: { options: Record<string, unknown> } }).pool;
      // pool_size + max_overflow → node-postgres 只有一个总上限。
      expect(pool.options["max"]).toBe(5);
      // pool_recycle → maxLifetimeSeconds。
      expect(pool.options["maxLifetimeSeconds"]).toBe(7);
      // 并发借出确实能同时拿到多条（否则 SSE 轮询会把聊天写堵死 —— 那正是
      // engine.ts 文件头记的那条 StaticPool 事故）。
      const pids = await Promise.all(
        [0, 1, 2, 3].map(() =>
          engine.connect(async (conn) => conn.scalar("SELECT pg_backend_pid()")),
        ),
      );
      expect(new Set(pids).size).toBeGreaterThan(1);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  it("pool_pre_ping：服务端把连接掐了，下一次借出仍然可用", async () => {
    const engine = new PgEngine(PG_URL, {
      poolPrePing: true,
      poolSize: 1,
      maxOverflow: 0,
      poolRecycle: 1800,
    });
    try {
      const pid = await engine.connect(async (conn) => conn.scalar("SELECT pg_backend_pid()"));
      // 从另一条连接上把它掐掉 —— 这模拟的是 PG 重启 / 云厂商回收空闲连接。
      const killer = new Client({ connectionString: PG_URL });
      await killer.connect();
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);
      await killer.end();
      // 没有 pre_ping 的话这里会是用户看得见的一次 500。
      const again = await engine.connect(async (conn) => conn.scalar("SELECT 1"));
      expect(Number(again)).toBe(1);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  it("begin 抛出即回滚，正常返回即提交", async () => {
    await ensureSchema();
    await truncateAll();
    const engine = new PgEngine(PG_URL, POOL);
    const repo: Repo = new PgRepo(engine);
    try {
      await expect(
        engine.begin(async (conn) => {
          await conn.exec(
            `INSERT INTO "session" (id, title, project, status, error, state_version, ` +
              `next_event_seq, next_run_ordinal, next_decision_ordinal) ` +
              `VALUES ('rollback_me', 't', '', 'idle', '', 0, 0, 0, 0)`,
          );
          throw new Error("故意炸");
        }),
      ).rejects.toThrow("故意炸");
      expect(await repo.getSession("rollback_me")).toBe(null);

      await engine.begin(async (conn) => {
        await conn.exec(
          `INSERT INTO "session" (id, title, project, status, error, state_version, ` +
            `next_event_seq, next_run_ordinal, next_decision_ordinal) ` +
            `VALUES ('commit_me', 't', '', 'idle', '', 0, 0, 0, 0)`,
        );
      });
      expect((await repo.getSession("commit_me"))?.id).toBe("commit_me");
    } finally {
      await engine.dispose();
    }
  }, 30_000);
});

// ══════════════════════════════════════════════════════════════════
//  双方言剧本
// ══════════════════════════════════════════════════════════════════

interface Step {
  step: string;
  value: unknown;
}

/** 把返回值里的时间与自动生成的 id 抹平 —— 两个方言只应在**这些**地方不同。 */
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v instanceof Set) return [...v].sort();
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = ["created", "updated", "last_seen", "ts", "expires", "started", "ended"].includes(k)
        ? "<ts>"
        : norm(x);
    }
    return out;
  }
  return v;
}

/** 覆盖每一类列（text / bigint / bool / json / tstz / bytes / float）与每一类写法
 * （upsert / returning / 计数器发号 / 租约仲裁 / CAS）。 */
async function battery(repo: Repo): Promise<Step[]> {
  const out: Step[] = [];
  const rec = async (step: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      out.push({ step, value: norm(await fn()) });
    } catch (e) {
      // 用一个不可能与 DTO 撞名的键（`SessionRow` 本身就有一列叫 error）。
      out.push({ step, value: { __threw: e instanceof Error ? e.message : String(e) } });
    }
  };

  const sid = "dual_s1";
  await rec("createSession", () => repo.createSession(makeSessionRow({ id: sid, owner: "o1" })));
  await rec("getSession", () => repo.getSession(sid));
  await rec("listSessions", () => repo.listSessions({ owner: "o1" }));
  await rec("renameSession", () => repo.renameSession(sid, "改过的标题"));
  await rec("setStatus", () => repo.setStatus(sid, "parsing", { error: "" }));

  // 文件（text + int）
  await rec("addFiles", () =>
    repo.addFiles(sid, [
      makeFileRow({ name: "a.xlsx", rel_path: "x/a.xlsx", size: 12, sha256: "aa" }),
      makeFileRow({ name: "b.ddl", rel_path: "x/b.ddl", size: 0, sha256: "bb" }),
    ]),
  );
  await rec("listFiles", () => repo.listFiles(sid));
  await rec("removeFile", () => repo.removeFile(sid, "b.ddl"));

  // state（json + CAS）
  await rec("saveState", () => repo.saveState(sid, { oir: { objects: [1, 2] } }));
  await rec("saveState/stale", () => repo.saveState(sid, { oir: {} }, { expectedVersion: 0 }));
  await rec("loadState", () => repo.loadState(sid));
  await rec("saveState/conflicts", () =>
    repo.saveState(
      sid,
      { oir: {} },
      {
        conflicts: [
          { rid: "c.1", kind: "gap", handling: "hint", summary: "", subjects: [], detector: "r" },
        ],
      },
    ),
  );
  await rec("listConflicts", () => repo.listConflicts(sid));
  await rec("getConflict", () => repo.getConflict(sid, "c.1"));

  // 事件（bigint 发号 + json payload + 幂等键）
  for (const i of [0, 1, 2]) {
    await rec(`appendEvent/${i}`, () => repo.appendEvent(sid, "tick", { i, 中文: "值" }));
  }
  await rec("appendEvent/idem", () =>
    repo.appendEvent(sid, "tick", { i: 9 }, { eventId: "ev-fixed" }),
  );
  await rec("appendEvent/idem2", () =>
    repo.appendEvent(sid, "tick", { i: 9 }, { eventId: "ev-fixed" }),
  );
  await rec("readEvents", () => repo.readEvents(sid));
  await rec("readEvents/since", () => repo.readEvents(sid, { since: 2 }));
  await rec("countEvents", () => repo.countEvents(sid));

  // Run（自增 ordinal）
  await rec("nextRun/1", () => repo.nextRun(sid, "build"));
  await rec("nextRun/2", () => repo.nextRun(sid, "chat"));

  // 租约仲裁（bool + tstz 比较）
  const now = 1_800_000_000;
  await rec("claimBuildLease", () =>
    repo.claimBuildLease(sid, { owner: "w1", now, ttl: 60, fromStatuses: ["idle", "parsing"] }),
  );
  await rec("claimBuildLease/夺", () =>
    repo.claimBuildLease(sid, { owner: "w2", now, ttl: 60, fromStatuses: ["idle", "parsing"] }),
  );
  await rec("renewBuildLease", () => repo.renewBuildLease(sid, { owner: "w1", now, ttl: 60 }));
  await rec("renewBuildLease/别人", () =>
    repo.renewBuildLease(sid, { owner: "w2", now, ttl: 60 }),
  );
  await rec("releaseBuildLease", () => repo.releaseBuildLease(sid, { owner: "w1" }));
  await rec("claimChatLease", () => repo.claimChatLease(sid, { owner: "c1", now, ttl: 30 }));
  await rec("releaseChatLease", () => repo.releaseChatLease(sid, { owner: "c1" }));

  // 账号（bool + json prefs + 唯一约束）
  await rec("createUser", () =>
    repo.createUser(
      makeUserRow({
        id: "dual_u1",
        username: "dual",
        password_hash: "scrypt$x",
        prefs: { theme: "dark", n: 1 },
        display_name: "程宇涵",
      }),
    ),
  );
  await rec("createUser/dup", () =>
    repo.createUser(makeUserRow({ id: "dual_u2", username: "dual", password_hash: "y" })),
  );
  await rec("getUserByUsername", () => repo.getUserByUsername("dual"));
  await rec("countUsers", () => repo.countUsers());
  await rec("updateUser/prefs", () => repo.updateUser("dual_u1", { prefs: { theme: "light" } }));
  await rec("updateUser/noop", () => repo.updateUser("dual_u1"));
  await rec("listUsers", () => repo.listUsers());

  // 登录会话（tstz 过期 + 计数返回）
  await rec("createAuthSession", () =>
    repo.createAuthSession(
      makeAuthSessionRow({ token_hash: "th1", user_id: "dual_u1", expires: now + 100 }),
    ),
  );
  await rec("getAuthSession", () => repo.getAuthSession("th1"));
  await rec("pruneAuthSessions", () => repo.pruneAuthSessions({ now: now + 1000 }));
  await rec("getAuthSession/gone", () => repo.getAuthSession("th1"));

  // 用量（float + text）
  await rec("addUsage", () =>
    repo.addUsage(
      makeUsageRow({
        id: "usg1",
        ts: now,
        day: "2027-01-15",
        model: "gemini-flash",
        owner: "dual_u1",
        session_id: sid,
        kind: "chat",
        tok_in: 10,
        tok_out: 20,
        usd: 0.0125,
        usd_source: "gateway",
        status: "ok",
        attempts: 1,
      }),
    ),
  );
  await rec("usageSince", () => repo.usageSince(0, { owner: "dual_u1" }));

  // 项目（upsert + 级联 + 返回计数）
  await rec("createProject", () =>
    repo.createProject(makeProjectRow({ id: "dual_p1", name: "项目一", owner: "dual_u1" })),
  );
  await rec("assignSession", () => repo.assignSession(sid, "dual_p1"));
  await rec("listProjects", () => repo.listProjects({ owner: "dual_u1" }));
  await rec("upsertProjectMemory", () =>
    repo.upsertProjectMemory([
      makeProjectMemoryRow({
        project_id: "dual_p1",
        key: "caliber:月",
        tier: "authoritative",
        kind: "caliber",
        content: "按自然月",
      }),
    ]),
  );
  await rec("upsertProjectMemory/覆盖", () =>
    repo.upsertProjectMemory([
      makeProjectMemoryRow({
        project_id: "dual_p1",
        key: "caliber:月",
        tier: "reference",
        kind: "caliber",
        content: "改过",
      }),
    ]),
  );
  await rec("listProjectMemory", () => repo.listProjectMemory("dual_p1"));
  await rec("renameProject", () => repo.renameProject("dual_p1", "项目二"));
  await rec("reassignSessions", () => repo.reassignSessions("o1", "dual_u1"));
  await rec("reassignProjects", () => repo.reassignProjects("dual_u1", "o9"));
  await rec("deleteProject", () => repo.deleteProject("dual_p1"));

  // 设置（jsonb 标量）
  for (const [k, v] of [
    ["s_obj", { a: 1 }],
    ["s_str", "裸串"],
    ["s_num", 3.5],
    ["s_bool", false],
    ["s_arr", [1, "二"]],
  ] as [string, unknown][]) {
    await rec(`setSetting/${k}`, () => repo.setSetting(k, v as never));
    await rec(`getSetting/${k}`, () => repo.getSetting(k));
  }
  await rec("listSettings", () => repo.listSettings());

  // 收尾：删掉自己造的东西，好让下一次跑从同一个起点开始。
  await rec("deleteSession", () => repo.deleteSession(sid));
  await rec("deleteUser", () => repo.deleteUser("dual_u1"));
  for (const k of ["s_obj", "s_str", "s_num", "s_bool", "s_arr"]) {
    await rec(`deleteSetting/${k}`, () => repo.deleteSetting(k));
  }
  return out;
}
