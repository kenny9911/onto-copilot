/**
 * server 段 B+C：会话 / 文件 / 项目 / 项目记忆 / SSE。
 *
 * 这一段没有 golden（HTTP 层的真相是 `server.py` 的路由体本身与前端的调用点），
 * 所以期望值全部对着 Python 原件逐行核；每处不显然的断言都注明它钉的是哪一条。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DecisionKind, DialogueMemory } from "../src/kernel/memory/dialogue.js";
import { MemoryItem, MemoryKind, MemoryTier, Scope } from "../src/kernel/memory/types.js";
import { SESSION_EVENTS } from "../src/session_events.js";
import { setRepoForTests } from "../src/store/deps.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeProjectMemoryRow, makeProjectRow, makeSessionRow } from "../src/store/types.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";
import { registerActiveScheduler, unregisterActiveScheduler } from "../src/server/pipeline/run.js";
import { SYNTHETIC_ADMIN_ID } from "../src/server/app.js";
import {
  SESSIONS,
  Session,
  refreshRoot,
  registerHydrator,
  root,
} from "../src/server/session.js";
import {
  DEFAULT_TITLES,
  autoTitle,
  normTitle,
  registerSessionRoutes,
  titleFromFiles,
  titleFromText,
} from "../src/server/routes/sessions.js";
import type { CatalogLike, ServerEnv } from "../src/server/routes/sessions.js";
import { registerFileRoutes } from "../src/server/routes/files.js";
import {
  dropReferenceMemory,
  projectMemory,
  registerProjectRoutes,
  rememberDecision,
  rememberRunLessons,
} from "../src/server/routes/projects.js";
import { registerStreamRoutes } from "../src/server/routes/stream.js";

// ══════════════════════════════════════════════════════════════════
//  测试装配
// ══════════════════════════════════════════════════════════════════

let repo: MemoryRepo;
let app: Hono<AppEnv>;
let workspace: string;
let currentUser: RequestUser | null;
/** `_persist` 被调了几次 —— 路由是不是真的落了库，靠它钉。 */
let persisted: string[];
/** `_preparse` 的调用记录。 */
let preparsed: string[];
/** 每个会话的对话记忆（`_dialogue` 的替身）。 */
const dialogues = new Map<string, DialogueMemory>();

const CATALOG: CatalogLike = {
  describe: () => [{ name: "gpt-5.5" }],
  byCapability: () => ({ vision: ["gemini-3.5-flash"] }),
  get: (name: string) => (name === "gpt-5.5" ? { name } : null),
};

const ENV: ServerEnv = {
  async persist(s) {
    persisted.push(s.id);
    // 真 `_persist` 会写 session_state；这里只落 mode / followups 两个键，
    // 因为冷路径（`coldBrief` / patch 的 mode 判断）只读它们。
    await repo.saveState(s.id, {
      mode: (s.state["mode"] as string) ?? "work",
      followups: (s.state["followups"] as never) ?? [],
    });
  },
  async sessionMutation(_s, _kind, body) {
    return await body();
  },
  busy: (s) => ["queued", "parsing", "extracting"].includes(s.status),
  async preparse(s) {
    preparsed.push(s.id);
  },
  dialogue: (s) => {
    let dm = dialogues.get(s.id);
    if (dm === undefined) {
      dm = new DialogueMemory();
      dialogues.set(s.id, dm);
    }
    return dm;
  },
  emitAiPrompts: () => undefined,
  ensureCatalog: async () => CATALOG,
  newCatalog: () => CATALOG,
  resolvedLlmConfig: () => ({
    baseUrl: "https://gw.example/v1",
    redactedKey: "sk-…cafe",
    insecureTransport: false,
  }),
  storeHealthcheck: async () => ({ mode: "memory", ok: true }),
  skillNames: () => ["sql.read"],
  restoreDialogue: async () => {},
  fdeEngagementDag: () => ({
    frozen: true,
    topoOrder: () => ["INTAKE", "PROCESS", "INTERVIEW", "EXPORT"],
    describe: () => [
      { id: "INTAKE" },
      { id: "PROCESS" },
      { id: "INTERVIEW" },
      { id: "EXPORT" },
    ],
  }),
};

/** 最小恢复器：把库里的行 + 盘上的材料变回一个活的 Session。 */
async function hydrate(sid: string): Promise<Session> {
  const cached = SESSIONS.get(sid);
  if (cached !== undefined) return cached;
  const row = await repo.getSession(sid);
  if (row === null) throw new Error(`没有会话 ${sid}`);
  const s = new Session(sid, {
    title: row.title,
    project: row.project,
    projectId: row.project_id,
    created: row.created,
    status: row.status,
    owner: row.owner,
    stateVersion: row.state_version,
  });
  Object.assign(s.state, await repo.loadState(sid));
  s.files = (await repo.listFiles(sid)).map((f) => ({
    name: f.name,
    size: f.size,
    path: join(root(), f.rel_path),
    sha256: f.sha256,
  }));
  SESSIONS.set(sid, s);
  return s;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ontocopilot-server-"));
  process.env["ONTOCOPILOT_WORKSPACE"] = workspace;
  refreshRoot();
  repo = new MemoryRepo();
  setRepoForTests(repo);
  SESSIONS.clear();
  dialogues.clear();
  persisted = [];
  preparsed = [];
  currentUser = { id: SYNTHETIC_ADMIN_ID };

  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", currentUser);
    await next();
  });
  registerSessionRoutes(app, ENV);
  registerProjectRoutes(app);
  registerFileRoutes(app, ENV);
  registerStreamRoutes(app);
});

afterEach(async () => {
  await SESSION_EVENTS.shutdown();
  setRepoForTests(null);
  registerHydrator(null);
  SESSIONS.clear();
  delete process.env["ONTOCOPILOT_WORKSPACE"];
  rmSync(workspace, { recursive: true, force: true });
});

/** 大多数用例都要恢复能力；单独开一个是为了让"未接线"也能被测到。 */
function wireHydrator(): void {
  registerHydrator(hydrate);
}

async function createSession(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════
//  标题规则（server.py:875–971）
// ══════════════════════════════════════════════════════════════════

describe("标题规则", () => {
  it("normTitle 折叠所有空白并去首尾", () => {
    expect(normTitle("  采购  计划\n管理 ")).toBe("采购 计划 管理");
    // 全角空格 U+3000 也算空白 —— Python 的 `\s` 在 str 上同样覆盖它
    expect(normTitle("A　B")).toBe("A B");
    expect(normTitle(null)).toBe("");
    expect(normTitle(undefined)).toBe("");
  });

  it("一档规则用第一份材料的文件名，多份带「等 N 份」", () => {
    expect(titleFromFiles([{ name: "采购计划-v2.xlsx" }])).toBe("采购计划-v2");
    expect(titleFromFiles([{ name: "a.xlsx" }, { name: "b.csv" }])).toBe("a 等 2 份");
    expect(titleFromFiles([])).toBe("");
    // basename：目录部分不进标题
    expect(titleFromFiles([{ name: "dir/x.md" }])).toBe("x");
  });

  it("二档规则取第一个短句并按码点截到 20 字", () => {
    expect(titleFromText("帮我梳理一下采购流程，另外还有付款")).toBe("帮我梳理一下采购流程");
    // 空格**不分句**：英文一句话不能被切成 "How"
    expect(titleFromText("How do we model POs")).toBe("How do we model POs");
    const long = "一".repeat(30);
    expect(titleFromText(long)).toBe(`${"一".repeat(20)}…`);
    // 星光面字符按码点截，不许劈出半个代理对
    const emoji = "🙂".repeat(25);
    const cut = titleFromText(emoji);
    expect([...cut].length).toBe(21); // 20 个 emoji + 省略号
  });

  it("autoTitle 只覆盖默认名，人改过的名字碰都不碰", async () => {
    wireHydrator();
    const brief = await createSession({ title: "新会话" });
    const sid = String(brief["id"]);
    const s = SESSIONS.get(sid)!;
    expect(DEFAULT_TITLES.has("新会话")).toBe(true);
    s.files = [{ name: "采购计划.xlsx", size: 1, path: join(s.dir, "x"), sha256: "" }];
    await autoTitle(s);
    expect(s.title).toBe("采购计划");
    expect((await repo.getSession(sid))!.title).toBe("采购计划");

    // 已经不是默认名了 —— 再来一次不许改回去
    s.files = [{ name: "别的.xlsx", size: 1, path: join(s.dir, "y"), sha256: "" }];
    await autoTitle(s);
    expect(s.title).toBe("采购计划");
  });
});

// ══════════════════════════════════════════════════════════════════
//  /api/health、/api/models、/model
// ══════════════════════════════════════════════════════════════════

describe("health / models", () => {
  it("health 把网关、库、目录、技能一起吐出来", async () => {
    const res = await app.request("/api/health");
    const d = (await res.json()) as Record<string, never>;
    expect(d["ok"]).toBe(true);
    expect(d["gateway"]).toEqual({
      base_url: "https://gw.example/v1",
      key: "sk-…cafe",
      insecure: false,
    });
    expect(d["database"]).toEqual({ mode: "memory", ok: true });
    expect(d["skills"]).toEqual(["sql.read"]);
  });

  it("网关配不出来时 ok=false 且只带 error", async () => {
    const broken: ServerEnv = {
      ...ENV,
      resolvedLlmConfig: () => {
        throw new Error("没有配置模型网关");
      },
    };
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("user", currentUser);
      await next();
    });
    registerSessionRoutes(a, broken);
    const d = (await (await a.request("/api/health")).json()) as Record<string, never>;
    expect(d["ok"]).toBe(false);
    expect(d["gateway"]).toEqual({ error: "没有配置模型网关" });
  });

  it("设定模型：未知模型清空，已知模型留下", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const ok = await app.request(`/api/sessions/${sid}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });
    expect(await ok.json()).toEqual({ model: "gpt-5.5" });
    const bad = await app.request(`/api/sessions/${sid}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "不存在的模型" }),
    });
    expect(await bad.json()).toEqual({ model: "" });
  });
});

// ══════════════════════════════════════════════════════════════════
//  会话 CRUD
// ══════════════════════════════════════════════════════════════════

describe("会话", () => {
  it("新建会话：默认 work 模式、默认标题、目录落地、行落库", async () => {
    const brief = await createSession();
    expect(brief["title"]).toBe("新的本体梳理");
    expect(brief["mode"]).toBe("work");
    expect(brief["project_id"]).toBe("");
    expect(brief["status"]).toBe("idle");
    expect(brief["files"]).toBe(0);
    const sid = String(brief["id"]);
    expect(sid).toHaveLength(12);
    expect(existsSync(join(workspace, sid))).toBe(true);
    expect(await repo.getSession(sid)).not.toBeNull();
    expect(persisted).toEqual([sid]);
  });

  it("mode 只认 work / chat，别的一律 work", async () => {
    expect((await createSession({ mode: "chat" }))["mode"]).toBe("chat");
    expect((await createSession({ mode: "hack" }))["mode"]).toBe("work");
    expect((await createSession({ mode: null }))["mode"]).toBe("work");
  });

  it("列表按 created 倒序，冷会话带 hydrated=false", async () => {
    await repo.createSession(makeSessionRow({ id: "old", title: "旧的", created: 100 }));
    await repo.createSession(makeSessionRow({ id: "new", title: "新的", created: 200 }));
    const rows = (await (await app.request("/api/sessions")).json()) as Record<string, unknown>[];
    expect(rows.map((r) => r["id"])).toEqual(["new", "old"]);
    expect(rows[0]!["hydrated"]).toBe(false);
    expect(rows[0]!["mode"]).toBe("work");
    expect(rows[0]!["project_id"]).toBe("");
  });

  it("孤儿目录也要列出来 —— 磁盘上还在的东西不能从界面上消失", async () => {
    const orphan = join(workspace, "orphan1");
    mkdirSync(join(orphan, "materials"), { recursive: true });
    writeFileSync(join(orphan, "oir.json"), "{}");
    writeFileSync(join(orphan, "materials", "a.csv"), "x");
    const rows = (await (await app.request("/api/sessions")).json()) as Record<string, unknown>[];
    const o = rows.find((r) => r["id"] === "orphan1")!;
    expect(o["orphan"]).toBe(true);
    // 有 oir.json 就是跑完过的 —— 目录里的事实比丢掉的状态字段可信
    expect(o["status"]).toBe("done");
    expect(o["files"]).toBe(1);
    expect(o["project_id"]).toBe("");
  });

  it("打了 .deleted 标记的目录不再被孤儿扫描捡回来", async () => {
    const d = join(workspace, "gone");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".deleted"), "1");
    const rows = (await (await app.request("/api/sessions")).json()) as Record<string, unknown>[];
    expect(rows.some((r) => r["id"] === "gone")).toBe(false);
  });

  it("删会话：默认只摘牌留产物，purge 才真删目录", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const res = await app.request(`/api/sessions/${sid}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ deleted: sid, purged: false });
    // 目录还在，但有了 .deleted 标记：目录是用户的资产，"已删除"是我们的状态
    expect(existsSync(join(workspace, sid))).toBe(true);
    expect(existsSync(join(workspace, sid, ".deleted"))).toBe(true);
    expect(SESSIONS.has(sid)).toBe(false);

    const sid2 = String((await createSession())["id"]);
    const res2 = await app.request(`/api/sessions/${sid2}?purge=true`, { method: "DELETE" });
    expect(await res2.json()).toEqual({ deleted: sid2, purged: true });
    expect(existsSync(join(workspace, sid2))).toBe(false);
  });

  it("删不存在的会话是 404，body 是 FastAPI 的 {detail}", async () => {
    const res = await app.request("/api/sessions/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "没有会话 nope" });
  });

  it("purge 只认布尔字面量，别的 422 —— 不能把删不干净伪装成成功", async () => {
    const res = await app.request("/api/sessions/x?purge=maybe", { method: "DELETE" });
    expect(res.status).toBe(422);
  });

  it("删会话会把 SSE 订阅者踢掉，否则连接永远挂着", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const got: Record<string, unknown>[] = [];
    SESSIONS.get(sid)!.subscribers.push({ putNowait: (e) => got.push(e) });
    await app.request(`/api/sessions/${sid}`, { method: "DELETE" });
    expect(got).toEqual([{ seq: -1, kind: "session.deleted" }]);
  });

  it("改标题：空 / 超长 / 没有可改字段都拒绝", async () => {
    const sid = String((await createSession())["id"]);
    const patch = async (body: unknown): Promise<Response> =>
      app.request(`/api/sessions/${sid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ title: "   " })).status).toBe(400);
    // 长度按码点算：121 个汉字超限
    expect((await patch({ title: "字".repeat(121) })).status).toBe(400);
    const ok = await patch({ title: "  采购\n梳理  " });
    expect(((await ok.json()) as Record<string, unknown>)["title"]).toBe("采购 梳理");
    expect((await repo.getSession(sid))!.title).toBe("采购 梳理");
  });

  it("改标题会发一条 session.renamed —— 侧栏要立刻变", async () => {
    const sid = String((await createSession())["id"]);
    await app.request(`/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新名字" }),
    });
    await SESSION_EVENTS.flush();
    const evs = await repo.readEvents(sid, { since: 0 });
    expect(evs.some((e) => e.kind === "session.renamed")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  项目文件夹
// ══════════════════════════════════════════════════════════════════

describe("停掉单个在飞节点（P4）", () => {
  it("没有在跑的梳理 → 409；有 → 命中返回 stopped，未命中 404", async () => {
    const brief = await createSession();
    const sid = String(brief["id"]);
    const miss = await app.request(`/api/sessions/${sid}/run/nodes/stop`, {
      method: "POST",
      body: JSON.stringify({ node: "PROCESS" }),
      headers: { "content-type": "application/json" },
    });
    expect(miss.status).toBe(409);

    const aborted: string[] = [];
    registerActiveScheduler(sid, {
      abortNode: (n: string) => {
        aborted.push(n);
        return n === "PROCESS";
      },
    });
    try {
      const hit = await app.request(`/api/sessions/${sid}/run/nodes/stop`, {
        method: "POST",
        body: JSON.stringify({ node: "PROCESS" }),
        headers: { "content-type": "application/json" },
      });
      expect(hit.status).toBe(200);
      expect(await hit.json()).toEqual({ stopped: true, node: "PROCESS" });
      expect(aborted).toEqual(["PROCESS"]);

      const ghost = await app.request(`/api/sessions/${sid}/run/nodes/stop`, {
        method: "POST",
        body: JSON.stringify({ node: "GHOST" }),
        headers: { "content-type": "application/json" },
      });
      expect(ghost.status).toBe(404);
    } finally {
      unregisterActiveScheduler(sid);
    }
  });

  it("栅栏注销：旧 run 的 finally 不许删掉后继 run 刚登记的调度器", async () => {
    const brief = await createSession();
    const sid = String(brief["id"]);
    const h1 = { abortNode: () => false };
    const h2 = { abortNode: () => true };
    registerActiveScheduler(sid, h1); // 旧 run 登记
    registerActiveScheduler(sid, h2); // 新 run 覆盖
    unregisterActiveScheduler(sid, h1); // 旧 run 收尾：句柄已不是自己的 → 不删
    const hit = await app.request(`/api/sessions/${sid}/run/nodes/stop`, {
      method: "POST",
      body: JSON.stringify({ node: "X" }),
      headers: { "content-type": "application/json" },
    });
    expect(hit.status, "新 run 的调度器必须还在（h2.abortNode 返回 true）").toBe(200);
    unregisterActiveScheduler(sid, h2); // 新 run 收尾：是自己的 → 删
    const gone = await app.request(`/api/sessions/${sid}/run/nodes/stop`, {
      method: "POST",
      body: JSON.stringify({ node: "X" }),
      headers: { "content-type": "application/json" },
    });
    expect(gone.status).toBe(409);
  });
});

describe("项目", () => {
  async function createProject(name: string): Promise<Response> {
    return app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  it("建项目要有名字，返回 id/name/sort_order", async () => {
    expect((await createProject("  ")).status).toBe(400);
    const d = (await (await createProject(" 采购 ")).json()) as Record<string, unknown>;
    expect(d["name"]).toBe("采购");
    expect(d["sort_order"]).toBe(0);
  });

  it("列表带会话数，且和会话列表用同一套 owner 规则", async () => {
    const p = (await (await createProject("P")).json()) as Record<string, unknown>;
    const pid = String(p["id"]);
    await repo.createSession(makeSessionRow({ id: "s1", project_id: pid, created: 1 }));
    await repo.createSession(makeSessionRow({ id: "s2", project_id: pid, created: 2 }));
    await repo.createSession(makeSessionRow({ id: "s3", created: 3 }));
    const d = (await (await app.request("/api/projects")).json()) as {
      projects: Record<string, unknown>[];
    };
    expect(d.projects).toEqual([{ id: pid, name: "P", sort_order: 0, sessions: 2 }]);
  });

  it("改排序当场说不支持，不假装写进去了", async () => {
    const pid = String(((await (await createProject("P")).json()) as never)["id"]);
    const res = await app.request(`/api/projects/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sort_order: 3 }),
    });
    expect(res.status).toBe(400);
  });

  it("改名不存在的项目是 404", async () => {
    const res = await app.request("/api/projects/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("删项目：会话掉回未归类但**不删会话**，活会话的 project_id 也松开", async () => {
    wireHydrator();
    const pid = String(((await (await createProject("P")).json()) as never)["id"]);
    const sid = String((await createSession())["id"]);
    await repo.assignSession(sid, pid);
    SESSIONS.get(sid)!.projectId = pid;
    const d = (await (await app.request(`/api/projects/${pid}`, { method: "DELETE" })).json()) as
      Record<string, unknown>;
    expect(d).toEqual({ ok: true, released: 1 });
    expect(await repo.getSession(sid)).not.toBeNull();
    expect(SESSIONS.get(sid)!.projectId).toBe("");
  });

  it("聊天会话不能归入项目（R5）", async () => {
    const pid = String(((await (await createProject("P")).json()) as never)["id"]);
    const sid = String((await createSession({ mode: "chat" }))["id"]);
    SESSIONS.delete(sid); // 走冷路径：mode 从 session_state 读
    const res = await app.request(`/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: pid }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "聊天会话不能归入项目" });
  });

  it("别人的项目 id 塞不进来 —— 否则就能读到别人的项目记忆", async () => {
    currentUser = { id: "u1" };
    const sid = String((await createSession())["id"]);
    await repo.createProject(makeProjectRow({ id: "pother", name: "别人的", owner: "u2" }));
    const res = await app.request(`/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "pother" }),
    });
    expect(res.status).toBe(404);
    expect((await repo.getSession(sid))!.project_id).toBe("");
  });

  it("project_id 传 null 或空串都是移出项目", async () => {
    const pid = String(((await (await createProject("P")).json()) as never)["id"]);
    const sid = String((await createSession())["id"]);
    await app.request(`/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: pid }),
    });
    expect((await repo.getSession(sid))!.project_id).toBe(pid);
    await app.request(`/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: null }),
    });
    expect((await repo.getSession(sid))!.project_id).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  项目记忆 —— 产品的硬特性
// ══════════════════════════════════════════════════════════════════

describe("项目记忆", () => {
  async function sessionInProject(pid: string): Promise<Session> {
    const s = new Session("sess-mem", { title: "会话甲" });
    s.projectId = pid;
    SESSIONS.set(s.id, s);
    await repo.createSession(makeSessionRow({ id: s.id, project_id: pid }));
    return s;
  }

  it("拿得出用户原话的拍板才升权威档", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    dm.say("user", "含税一律按增值税专用发票口径算");
    const d = dm.decide(DecisionKind.CALIBER, "含税=增值税专用发票口径");

    await rememberDecision(ENV, s, d, { quote: "含税一律按增值税专用发票口径算" });
    const rows = await repo.listProjectMemory("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe(MemoryTier.AUTHORITATIVE);
    // 出处换成了用户真的说过的那句话，而不是那条指不到任何东西的 turn 引用
    expect(rows[0]!.support[0]).toBe("用户原话：含税一律按增值税专用发票口径算");
    // origin_session 记的是**名字**：参考档进 prompt 要逐行印出来
    expect(rows[0]!.origin_session).toBe("会话甲");
  });

  it("**伪造 quote 会被拒**：模型转述的、用户没说过的话进不了项目档", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    // 用户真正说过的只有这一句
    dm.say("user", "你好，这份材料能看吗");
    dm.say("assistant", "含税一律按增值税专用发票口径算");
    const d = dm.decide(DecisionKind.CALIBER, "含税=增值税专用发票口径");

    // 模型把**自己**说过的那句当成人证递上来 —— 这正是红队复现的那条路
    await rememberDecision(ENV, s, d, { quote: "含税一律按增值税专用发票口径算" });
    expect(await repo.listProjectMemory("p1")).toHaveLength(0);
    const evs = s.events.filter((e) => e["kind"] === "memory.not_shared");
    expect(evs).toHaveLength(1);
    expect(evs[0]!["why"]).toBe("拿不出用户原话，只在本会话生效");
  });

  it("完全不给 quote 同样进不了项目档", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    dm.say("user", "含税一律按增值税专用发票口径算");
    const d = dm.decide(DecisionKind.CALIBER, "含税=增值税专用发票口径");
    await rememberDecision(ENV, s, d);
    expect(await repo.listProjectMemory("p1")).toHaveLength(0);
  });

  it("一两个字的「引用」不算原话 —— 那能命中几乎任何一句话", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    dm.say("user", "含税一律按增值税专用发票口径算");
    const d = dm.decide(DecisionKind.CALIBER, "含税=增值税专用发票口径");
    await rememberDecision(ENV, s, d, { quote: "税" });
    expect(await repo.listProjectMemory("p1")).toHaveLength(0);
  });

  it("标点和空白变了照样认 —— 模型转述时几乎一定会变", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    dm.say("user", "含税，一律按「增值税专用发票」口径算。");
    const d = dm.decide(DecisionKind.CALIBER, "含税=增值税专用发票口径");
    await rememberDecision(ENV, s, d, { quote: "含税 一律按增值税专用发票口径算" });
    expect(await repo.listProjectMemory("p1")).toHaveLength(1);
  });

  it("只有 PROMOTABLE 的三类升项目档；ANSWER/ADOPTION/CORRECTION 就地留在本会话", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const dm = ENV.dialogue(s) as DialogueMemory;
    dm.say("user", "这条就按方案二来");
    for (const kind of [DecisionKind.ANSWER, DecisionKind.ADOPTION, DecisionKind.CORRECTION]) {
      const d = dm.decide(kind, "按方案二");
      await rememberDecision(ENV, s, d, { quote: "这条就按方案二来" });
    }
    expect(await repo.listProjectMemory("p1")).toHaveLength(0);
    // 连"拿不出原话"的事件都不该发 —— 根本没走到那一步
    expect(s.events.filter((e) => e["kind"] === "memory.not_shared")).toHaveLength(0);
  });

  it("没有项目的会话不写项目记忆", async () => {
    const s = new Session("solo", {});
    const dm = new DialogueMemory();
    dialogues.set("solo", dm);
    dm.say("user", "含税按专票口径");
    const d = dm.decide(DecisionKind.CALIBER, "含税=专票");
    await rememberDecision(ENV, s, d, { quote: "含税按专票口径" });
    expect(await repo.listProjectMemory("")).toHaveLength(0);
  });

  it("**参考档不能被洗成权威档**：内核闸门在这条路上照样生效", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const pm = await projectMemory("p1");
    const laundered = new MemoryItem({
      key: "k/laundered",
      kind: MemoryKind.DECISION,
      scope: Scope.PROJECT,
      content: "上一轮模型自己猜的口径",
      tier: MemoryTier.REFERENCE,
    });
    const [ok, why] = pm.rememberDecision(laundered, { runId: "r1" });
    expect(ok).toBe(false);
    expect(why).toContain("参考档不能改标成权威");
  });

  it("run 收尾的教训进参考档，且一轮最多 8 条", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    const s = await sessionInProject("p1");
    const lessons = Array.from({ length: 12 }, (_, i) => `教训 ${i}`);
    await rememberRunLessons(ENV, s, lessons, { runId: "run-1" });
    const rows = await repo.listProjectMemory("p1");
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.tier).toBe(MemoryTier.REFERENCE);
      expect(r.tags).toContain("observed");
    }
  });

  it("dropReferenceMemory 挡住 tier=reference 和 observed 两种形状", () => {
    const kept = dropReferenceMemory([
      { statement: "人拍的板", tier: MemoryTier.AUTHORITATIVE },
      { statement: "推断", tier: MemoryTier.REFERENCE },
      { statement: "推断2", tags: ["observed"] },
      { statement: "没有 tier 也没有 tags" },
      "形状判不了就放行", // 额外的一层保险，不该自己变成能挂掉发布闸门的东西
    ]);
    expect(kept).toEqual([
      { statement: "人拍的板", tier: MemoryTier.AUTHORITATIVE },
      { statement: "没有 tier 也没有 tags" },
      "形状判不了就放行",
    ]);
  });

  it("只回写这次动过的键，别的会话刚写的同项目条目不被整库覆盖", async () => {
    await repo.createProject(makeProjectRow({ id: "p1", name: "P" }));
    // 另一个会话先写了一条
    await repo.upsertProjectMemory([
      makeProjectMemoryRow({
        project_id: "p1",
        key: "other/key",
        tier: MemoryTier.REFERENCE,
        kind: MemoryKind.LESSON,
        content: "别人写的",
      }),
    ]);
    const s = await sessionInProject("p1");
    await rememberRunLessons(ENV, s, ["我这轮的教训"], { runId: "run-2" });
    const rows = await repo.listProjectMemory("p1");
    expect(rows.map((r) => r.content)).toContain("别人写的");
    expect(rows.map((r) => r.content)).toContain("我这轮的教训");
  });
});

// ══════════════════════════════════════════════════════════════════
//  材料
// ══════════════════════════════════════════════════════════════════

describe("材料", () => {
  function form(files: [string, string][]): FormData {
    const fd = new FormData();
    for (const [name, body] of files) fd.append("files", new File([body], name));
    return fd;
  }

  async function upload(sid: string, files: [string, string][]): Promise<Response> {
    return app.request(`/api/sessions/${sid}/files`, { method: "POST", body: form(files) });
  }

  it("上传登记材料但**不解析**", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const res = await upload(sid, [
      ["a.csv", "1,2\n"],
      ["b.md", "# x"],
    ]);
    expect(res.status).toBe(200);
    const d = (await res.json()) as { files: { name: string; sha256: string; state: string }[] };
    expect(d.files.map((f) => f.name)).toEqual(["a.csv", "b.md"]);
    expect(d.files[0]!.sha256).toHaveLength(64);
    expect(d.files.map((f) => f.state)).toEqual(["unread", "unread"]);
    expect(readdirSync(join(workspace, sid, "materials")).sort()).toEqual(["a.csv", "b.md"]);
    expect((await repo.listFiles(sid)).map((f) => f.name)).toEqual(["a.csv", "b.md"]);
    // 库里存的必须是**相对路径** —— 绝对路径换个部署环境就失效
    expect((await repo.listFiles(sid))[0]!.rel_path).toBe(`${sid}/materials/a.csv`);
    // 上传只登记，不解析
    expect(preparsed).toEqual([]);
    const kinds = SESSIONS.get(sid)!.events.map((e) => e["kind"]);
    expect(kinds).toContain("materials.registered");
  });

  it("上传第一份材料顺手把默认标题起了", async () => {
    wireHydrator();
    const sid = String((await createSession({ title: "新会话" }))["id"]);
    await upload(sid, [["采购计划-v2.xlsx", "x"]]);
    expect((await repo.getSession(sid))!.title).toBe("采购计划-v2");
  });

  it("同名上传是替换，不是在语料清单里追加两遍", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    await upload(sid, [["a.csv", "old"]]);
    const d = (await (await upload(sid, [["a.csv", "new-content"]])).json()) as {
      files: { name: string; size: number }[];
    };
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.size).toBe("new-content".length);
    expect(await repo.listFiles(sid)).toHaveLength(1);
  });

  it("同名替换立即失效旧正文，但保留未变化材料的缓存与检索", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    await upload(sid, [["a.csv", "old"], ["b.md", "stable"]]);
    const s = SESSIONS.get(sid)!;
    s.state["_chunks"] = {
      "a.csv": [{ cite: "a.csv!1", text: "旧版机密正文", tags: ["rule"], locator: {} }],
      "b.md": [{ cite: "b.md!1", text: "保留的稳定正文", tags: ["body"], locator: {} }],
    };
    s.state["_index"] = { stale: true };
    s.state["corpus"] = {
      files: [
        { file: "a.csv", kind: "csv", chunks: 1, findings: 0 },
        { file: "b.md", kind: "text", chunks: 1, findings: 1 },
      ],
      chunks: 2,
      findings: [{
        file: "b.md", kind: "encoding_guess", severity: "info",
        message: "保留这份材料的状态", locator: {},
      }],
    };
    s.state["_profiles"] = { stale: true };

    await upload(sid, [["a.csv", "new-content"]]);

    const chunks = s.state["_chunks"] as Record<string, unknown[]>;
    expect(chunks["a.csv"]).toBeUndefined();
    expect(chunks["b.md"]).toHaveLength(1);
    const index = s.state["_index"] as { allChunks(): Array<{ render: string; tags: string[] }> };
    expect(index.allChunks().map((c) => c.render)).toEqual(["保留的稳定正文"]);
    expect(index.allChunks()[0]?.tags).toEqual(["body"]);
    expect(s.state["corpus"]).toEqual({
      files: [{ file: "b.md", kind: "text", chunks: 1, findings: 1 }],
      chunks: 1,
      findings: [{
        file: "b.md", kind: "encoding_guess", severity: "info",
        message: "保留这份材料的状态", locator: {},
      }],
    });
    expect(s.state["_profiles"]).toBeUndefined();
  });

  it("同一 multipart 里名字重复以最后一份为准，前一份不落盘也不计配额", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const d = (await (
      await upload(sid, [
        ["dup.txt", "first"],
        ["dup.txt", "second"],
      ])
    ).json()) as { files: { name: string; size: number }[] };
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.size).toBe("second".length);
    // 临时文件全部清干净，只剩正式文件
    expect(readdirSync(join(workspace, sid, "materials"))).toEqual(["dup.txt"]);
  });

  it("文件名走 basename，路径穿越写不出 materials 目录", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    await upload(sid, [["../../evil.txt", "x"]]);
    expect(readdirSync(join(workspace, sid, "materials"))).toEqual(["evil.txt"]);
  });

  it("正在梳理时不许换材料", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    SESSIONS.get(sid)!.status = "extracting";
    const res = await upload(sid, [["a.csv", "x"]]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "正在梳理，不能同时替换材料。" });
  });

  it("超过单文件上限报的是文件那条，报文里带 MB 数", async () => {
    wireHydrator();
    process.env["ONTOCOPILOT_MAX_UPLOAD_MB"] = "1";
    try {
      const sid = String((await createSession())["id"]);
      const res = await upload(sid, [["big.bin", "x".repeat(1024 * 1024 + 1)]]);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ detail: "big.bin 超过单文件 1MB 限制" });
      // 失败的一批一个字节都不许留在 materials 里
      expect(readdirSync(join(workspace, sid, "materials"))).toEqual([]);
    } finally {
      delete process.env["ONTOCOPILOT_MAX_UPLOAD_MB"];
    }
  });

  it("超过会话总量上限报的是会话那条", async () => {
    wireHydrator();
    process.env["ONTOCOPILOT_MAX_UPLOAD_MB"] = "10";
    process.env["ONTOCOPILOT_MAX_SESSION_MB"] = "1";
    try {
      const sid = String((await createSession())["id"]);
      const res = await upload(sid, [
        ["a.bin", "x".repeat(700 * 1024)],
        ["b.bin", "x".repeat(700 * 1024)],
      ]);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ detail: "会话材料总量超过 1MB 限制" });
      expect(readdirSync(join(workspace, sid, "materials"))).toEqual([]);
    } finally {
      delete process.env["ONTOCOPILOT_MAX_UPLOAD_MB"];
      delete process.env["ONTOCOPILOT_MAX_SESSION_MB"];
    }
  });

  it("材料数超上限直接拒，不写任何一份", async () => {
    wireHydrator();
    process.env["ONTOCOPILOT_MAX_FILES"] = "1";
    try {
      const sid = String((await createSession())["id"]);
      const res = await upload(sid, [
        ["a.csv", "1"],
        ["b.csv", "2"],
      ]);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ detail: "会话材料数不能超过 1 份" });
    } finally {
      delete process.env["ONTOCOPILOT_MAX_FILES"];
    }
  });

  it("撤材料：文件、库、索引三处一起收缩，followups 写空数组而不是删键", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    await upload(sid, [
      ["a.csv", "1"],
      ["b.csv", "2"],
    ]);
    const s = SESSIONS.get(sid)!;
    s.state["followups"] = ["还问不问 a.csv"];
    s.state["corpus"] = { files: 2 };
    const res = await app.request(`/api/sessions/${sid}/files/a.csv`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(readdirSync(join(workspace, sid, "materials"))).toEqual(["b.csv"]);
    expect((await repo.listFiles(sid)).map((f) => f.name)).toEqual(["b.csv"]);
    // 还有材料 → 重建索引
    expect(preparsed).toEqual([sid]);
    // 写空数组，不能删键：`_persist` 只做 upsert，删键等于库里那份原样留着
    expect(s.state["followups"]).toEqual([]);
  });

  // 判据从「键不在」改成「值为空」（B12）：persist 是纯 upsert，delete 掉内存里
  // 的键只是让它不进本次写库，**库里那份原样留着** —— 换个 worker hydrate 一次，
  // 被删材料的切片重新进模型提示词。写空值才能让 upsert 把旧值盖掉。
  // followups 那几行早就写明了这条纪律，派生状态这组当时漏了。
  it("撤掉最后一份材料会把上一轮的派生状态**写空**（不是 delete —— upsert 盖不掉缺键）", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    await upload(sid, [["a.csv", "1"]]);
    const s = SESSIONS.get(sid)!;
    for (const k of ["_docs", "_index", "_chunks", "_profiles", "_endpoints", "corpus"]) {
      s.state[k] = "残留";
    }
    await app.request(`/api/sessions/${sid}/files/a.csv`, { method: "DELETE" });
    // 键还在（要随 persist 写库把旧值盖掉），值必须已清空
    expect(s.state["_chunks"]).toEqual({});
    expect(s.state["corpus"]).toBe("");
    expect(s.state["_docs"]).toEqual({});
    expect(s.state["_profiles"]).toEqual({});
    expect(s.state["_endpoints"]).toEqual([]);
    expect(s.state["_index"]).toBeNull();
    // 一个「残留」都不许剩
    for (const k of ["_docs", "_index", "_chunks", "_profiles", "_endpoints", "corpus"]) {
      expect(s.state[k]).not.toBe("残留");
    }
    expect(preparsed).toEqual([]); // 没材料了就不重解析
  });

  it("撤一份不存在的材料是 404", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const res = await app.request(`/api/sessions/${sid}/files/none.csv`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "none.csv" });
  });
});

// ══════════════════════════════════════════════════════════════════
//  /state 与 to_work
// ══════════════════════════════════════════════════════════════════

describe("state / to_work", () => {
  // **右栏能不能自动刷新，全看这一个字段。**
  //
  // context-region.tsx 的 /context 拉取用 `[sid, stateVersion]` 当 useEffect 的
  // dep，而 stateVersion 来自 `G.S`，`G.S` 又是 mergeStateSnapshot 从 /state 的
  // 响应体 Object.assign 进去的。/state 不回这个字段时它恒为 undefined ——
  // 依赖数组永远不变，/context 只在进会话时取一次。
  //
  // 症状是"看不见的坏"：不报错、不白屏，只是改完本体、跑完梳理之后右栏纹丝不动，
  // 用户得手动刷新页面，而他刚刚明明看见系统说改好了。
  it("**/state 必须回 state_version** —— 右栏靠它决定要不要重取 /context", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const s = SESSIONS.get(sid)!;
    s.stateVersion = 7;
    const d = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as {
      state_version?: number;
    };
    expect(d.state_version).toBe(7);
  });

  it("state 带 filelist 与每份材料的解析状态", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const fd = new FormData();
    fd.append("files", new File(["1,2"], "a.csv"));
    fd.append("files", new File(["img"], "scan.png"));
    fd.append("files", new File(["t"], "note.md"));
    await app.request(`/api/sessions/${sid}/files`, { method: "POST", body: fd });
    const s = SESSIONS.get(sid)!;
    s.state["_chunks"] = { "a.csv": [{ cite: "a:1" }] };

    const d = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as {
      filelist: { name: string; state: string; chunks: number }[];
      state: Record<string, unknown>;
      events: number;
      followups: unknown;
    };
    expect(d.filelist).toEqual([
      { name: "a.csv", size: 3, chunks: 1, state: "parsed" },
      { name: "scan.png", size: 3, chunks: 0, state: "pending" },
      { name: "note.md", size: 1, chunks: 0, state: "unread" },
    ]);
    // 私有键（下划线打头）绝不出网
    expect(Object.keys(d.state).some((k) => k.startsWith("_"))).toBe(false);
    expect((d.state["engagement"] as Record<string, unknown>)["current"]).toBe("INTAKE");
    expect(d.followups).toEqual([]);
  });

  it("state 用 findings 区分失败、不支持、部分完成与待识别", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const fd = new FormData();
    for (const name of ["坏文档.docx", "旧表.xls", "混合.pdf", "扫描.png", "规则.txt"]) {
      fd.append("files", new File(["x"], name));
    }
    await app.request(`/api/sessions/${sid}/files`, { method: "POST", body: fd });
    const s = SESSIONS.get(sid)!;
    s.state["_chunks"] = {
      "坏文档.docx": [], "旧表.xls": [], "混合.pdf": [{ cite: "mixed!p1" }],
      "扫描.png": [], "规则.txt": [{ cite: "rules!1" }],
    };
    s.state["corpus"] = { findings: [
      { file: "坏文档.docx", kind: "parse_failed", severity: "warn", message: "损坏" },
      { file: "旧表.xls", kind: "unsupported", severity: "warn", message: "旧格式" },
      { file: "混合.pdf", kind: "vision_pending", severity: "info", message: "第 2 页待识别" },
      { file: "扫描.png", kind: "vision_pending", severity: "info", message: "待识别" },
    ] };

    const body = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as {
      filelist: Array<{ state: string; issue?: string }>;
    };
    expect(body.filelist.map((f) => f.state)).toEqual([
      "failed", "unsupported", "partial", "pending", "parsed",
    ]);
    expect(body.filelist.slice(0, 4).map((f) => f.issue)).toEqual([
      "损坏", "旧格式", "第 2 页待识别", "待识别",
    ]);
  });

  it("engagement 的阶段按 status 走", async () => {
    wireHydrator();
    const sid = String((await createSession())["id"]);
    const s = SESSIONS.get(sid)!;
    s.status = "awaiting_answer";
    const d1 = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as never;
    const eng1 = (d1["state"] as never)["engagement"] as {
      current: string;
      plan: { id: string; state: string }[];
    };
    expect(eng1.current).toBe("INTERVIEW");
    expect(eng1.plan.map((p) => p.state)).toEqual(["completed", "completed", "active", "pending"]);

    // FDE v3 还有独立的 HUMAN_ACCEPTANCE 人工门。阶段投影必须服从 Scheduler
    // 持久化的 pendingHuman.node，不能把所有挂起一律伪装成 INTERVIEW。
    s.state["engagement_execution"] = {
      status: "suspended",
      completed: ["INTAKE", "PROCESS", "INTERVIEW"],
      pendingHuman: { node: "EXPORT", request_id: "release:hitl" },
    };
    const dSignoff = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as never;
    const signoffEngagement = (dSignoff["state"] as never)["engagement"] as {
      current: string;
      plan: { id: string; state: string }[];
    };
    expect(signoffEngagement.current).toBe("EXPORT");
    expect(signoffEngagement.plan.map((p) => p.state)).toEqual([
      "completed", "completed", "completed", "active",
    ]);

    s.status = "extracting";
    const d2 = (await (await app.request(`/api/sessions/${sid}/state`)).json()) as never;
    expect(((d2["state"] as never)["engagement"] as never)["current"]).toBe("PROCESS");
  });

  it("to_work 把聊天里的材料带到新的工作会话", async () => {
    wireHydrator();
    const chat = String((await createSession({ mode: "chat", title: "采购对话" }))["id"]);
    const fd = new FormData();
    fd.append("files", new File(["1,2"], "a.csv"));
    await app.request(`/api/sessions/${chat}/files`, { method: "POST", body: fd });

    const d = (await (
      await app.request(`/api/sessions/${chat}/to_work`, { method: "POST" })
    ).json()) as { id: string; files: number };
    expect(d.files).toBe(1);
    const ws = SESSIONS.get(d.id)!;
    // "对话"两个字被去掉（Python 的 str.replace 换所有出现）
    expect(ws.title).toBe("采购（自聊天）");
    expect(ws.state["mode"]).toBe("work");
    expect(existsSync(join(workspace, d.id, "materials", "a.csv"))).toBe(true);
    expect((await repo.listFiles(d.id)).map((f) => f.name)).toEqual(["a.csv"]);
    expect(preparsed).toContain(d.id);
    // 源会话的材料原样留着 —— 这是拷贝，不是搬家
    expect(existsSync(join(workspace, chat, "materials", "a.csv"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  SSE
// ══════════════════════════════════════════════════════════════════

describe("SSE 事件流", () => {
  /** 读到 `want` 条 `data:` 行就收工；到点没读够也收工，避免整个用例挂住。 */
  async function readSse(res: Response, want: number, ms = 3000): Promise<string[]> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const lines: string[] = [];
    let buf = "";
    const deadline = Date.now() + ms;
    try {
      while (lines.length < want && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
          ),
        ]);
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        // 每轮重扫整个 buf：SSE 的分帧是 "\n\n"，一个 chunk 里可能有半帧
        lines.length = 0;
        for (const part of buf.split("\n\n")) {
          if (part.startsWith("data: ")) lines.push(part.slice("data: ".length));
        }
      }
    } finally {
      await reader.cancel();
    }
    return lines;
  }

  async function seed(sid: string, kinds: string[]): Promise<void> {
    await repo.createSession(makeSessionRow({ id: sid }));
    for (const k of kinds) await repo.appendEvent(sid, k, { note: k });
  }

  it("since=0 先发 stream.reset，再按 durable seq 重放全部", async () => {
    wireHydrator();
    await seed("s-sse", ["a", "b", "c"]);
    const res = await app.request("/api/sessions/s-sse/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const lines = await readSse(res, 4);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: "stream.reset", seq: -1, ts: 0 });
    expect(lines.slice(1).map((l) => JSON.parse(l).kind)).toEqual(["a", "b", "c"]);
    expect(lines.slice(1).map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);
  });

  it("since=N 从第 N 格接着发，且**不发** reset —— 断线重连靠这一格", async () => {
    wireHydrator();
    await seed("s-sse2", ["a", "b", "c", "d"]);
    const res = await app.request("/api/sessions/s-sse2/stream?since=2");
    const lines = await readSse(res, 2);
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["c", "d"]);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([2, 3]);
  });

  it("负数 since 夹到 0，但**不发** reset —— reset 的判据是 `since == 0` 这一格", async () => {
    wireHydrator();
    await seed("s-sse3", ["a", "b"]);
    const res = await app.request("/api/sessions/s-sse3/stream?since=-5");
    const lines = await readSse(res, 2);
    // 游标 `max(0, since)` 夹到 0，所以从头重放；但 reset 只在 since 恰为 0 时发。
    // 这一格错了就会多发一条 stream.reset，前端会把已经渲染的轨迹清空一次。
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["a", "b"]);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1]);
  });

  it("跑起来之后新 append 的事件也会被推出去", async () => {
    wireHydrator();
    await seed("s-sse4", ["a"]);
    const res = await app.request("/api/sessions/s-sse4/stream");
    const p = readSse(res, 3);
    // repo poll 最多 250ms 一轮，等它转两圈
    await new Promise((r) => setTimeout(r, 60));
    await repo.appendEvent("s-sse4", "late", { note: "late" });
    const lines = await p;
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["stream.reset", "a", "late"]);
  });

  it("推出去的事件同时补进 s.events，按 seq 排好且不重复", async () => {
    wireHydrator();
    await seed("s-sse5", ["a", "b"]);
    const s = await hydrate("s-sse5");
    s.events.length = 0;
    const res = await app.request("/api/sessions/s-sse5/stream");
    await readSse(res, 3);
    expect(s.events.map((e) => e["seq"])).toEqual([0, 1]);
    expect(s.events.map((e) => e["kind"])).toEqual(["a", "b"]);
  });

  it("断开后订阅者从会话上摘掉，不会越堆越多", async () => {
    wireHydrator();
    await seed("s-sse6", ["a"]);
    const s = await hydrate("s-sse6");
    const res = await app.request("/api/sessions/s-sse6/stream");
    await readSse(res, 2);
    // 取消读之后循环条件 `!stream.aborted` 会退出，finally 摘掉队列
    await new Promise((r) => setTimeout(r, 400));
    expect(s.subscribers).toHaveLength(0);
  });
});
