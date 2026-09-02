/**
 * 全量日志路由的**权限边界**。
 *
 * 这批断言的分量比一般路由测试重，因为线上没有真实数据能验：库里只有 root 和
 * admin 两个账号，**两个都是 role=admin**，一个 role=user 都没有。也就是说
 * "普通用户只能看自己的"这条路在真实环境里今天走不到，唯一的保护就是这里。
 *
 * 另外钉死两条容易被"顺手改好"而破掉的性质：
 *   * 看不到的会话回 **404 不是 403** —— 403 等于承认"这个 id 存在，只是不属于你"。
 *   * `?owner=` 只对能看全部的人生效 —— 否则任何人改一个 query 参数就读到别人的。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "../src/server/app.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { setRepoForTests } from "../src/store/deps.js";
import { makeSessionRow, makeUserRow, makeEventRow } from "../src/store/types.js";

const ROOT = join(tmpdir(), `ontocopilot-logs-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { registerLogRoutes, redactSecrets, briefOf } = await import("../src/server/routes/logs.js");
const { FileJournal, FileBlobStore } = await import("../src/kernel/journal.js");
const { makeEvent, EventKind } = await import("../src/kernel/events.js");

let repo: MemoryRepo;
let app: Hono<AppEnv>;

/** 当前请求扮演谁。null = 完全没有 user（理论上进不来，兜底用）。 */
let actor: { id: string; role: string } | null = null;

afterAll(() => {
  setRepoForTests(null);
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  mkdirSync(ROOT, { recursive: true });
  repo = new MemoryRepo();
  setRepoForTests(repo);
  app = new Hono<AppEnv>();
  // 装一个最小的"鉴权中间件替身"：真中间件在 authgate 里，这里只需要 c.get("user")。
  app.use("*", async (c, next) => {
    if (actor !== null) c.set("user", makeUserRow({ id: actor.id, username: actor.id, password_hash: "x", role: actor.role }));
    await next();
  });
  app.onError((err) => {
    if (err instanceof HTTPException) return Response.json({ detail: err.message }, { status: err.status });
    return Response.json({ detail: String(err) }, { status: 500 });
  });
  registerLogRoutes(app);

  // u1 一条、u2 一条、无归属一条
  for (const [id, owner] of [["s-u1", "u1"], ["s-u2", "u2"], ["s-orphan", ""]] as const) {
    await repo.createSession(makeSessionRow({ id, title: `会话 ${id}`, owner }));
  }
  await repo.createUser(makeUserRow({ id: "u1", username: "alice", password_hash: "x", role: "user" }));
  await repo.createUser(makeUserRow({ id: "u2", username: "bob", password_hash: "x", role: "user" }));
  for (let i = 0; i < 5; i += 1) {
    await repo.appendEvent("s-u1", i % 2 ? "chat.step" : "chat.turn", { n: i, thought: `想了第 ${i} 步` });
  }
});

const get = async (p: string): Promise<Response> => app.request(p);

async function writeRuntimeLedger(sid = "s-u1", runId = "chat_s-u1_reason_demo"): Promise<void> {
  const journal = new FileJournal(join(ROOT, sid, "journal"));
  const blobs = new FileBlobStore(join(ROOT, sid, "blobs"));
  const requestRef = await blobs.putJson({
    query: "采购审批",
    options: { max_tokens: 16_000 },
    credentials: { api_key: "request-secret-key" },
    nested: [{ password: "request-password" }],
  });
  const outputRef = await blobs.putJson({ answer: "完整工具输出", access_token: "top-secret-token" });
  journal.append(makeEvent({
    runId, seq: 0, kind: EventKind.EFFECT_REQUESTED, nodeId: "TOOL", tsMs: 1_000,
    payload: {
      key: "TOOL#0", kind: "tool.call",
      request: { query: "采购审批", max_tokens: "16000", api_key: "secret-key" },
      request_fidelity: "full",
    },
    ref: requestRef,
  }));
  journal.append(makeEvent({
    runId, seq: 1, kind: EventKind.EFFECT_COMPLETED, nodeId: "TOOL", tsMs: 1_200,
    payload: { key: "TOOL#0", kind: "tool.call" }, ref: outputRef,
  }));
  await journal.flush();
}

describe("会话清单的可见范围", () => {
  it("普通用户只看得到自己的 —— 别人的和无归属的都不出现", async () => {
    actor = { id: "u1", role: "user" };
    const body = await (await get("/api/logs/sessions")).json() as any;
    expect(body.can_see_all).toBe(false);
    expect(body.sessions.map((s: any) => s.id)).toEqual(["s-u1"]);
  });

  it("管理员看得到全部，且归属显示成人名不是一串 hex", async () => {
    actor = { id: "admin1", role: "admin" };
    const body = await (await get("/api/logs/sessions")).json() as any;
    expect(body.can_see_all).toBe(true);
    expect(body.sessions.map((s: any) => s.id).sort()).toEqual(["s-orphan", "s-u1", "s-u2"]);
    expect(body.sessions.find((s: any) => s.id === "s-u1").owner_name).toBe("alice");
    // owner 为空要明说，别显示成空白让人以为是 bug
    expect(body.sessions.find((s: any) => s.id === "s-orphan").owner_name).toBe("（无归属）");
  });

  it("**普通用户带 ?owner=u2 仍然只看到自己的** —— 越权参数被吃掉", async () => {
    actor = { id: "u1", role: "user" };
    const body = await (await get("/api/logs/sessions?owner=u2")).json() as any;
    expect(body.sessions.map((s: any) => s.id)).toEqual(["s-u1"]);
  });

  it("管理员的 ?owner= 才生效", async () => {
    actor = { id: "admin1", role: "admin" };
    const body = await (await get("/api/logs/sessions?owner=u2")).json() as any;
    expect(body.sessions.map((s: any) => s.id)).toEqual(["s-u2"]);
  });

  it("开放模式（合成管理员 __local__）不隔离，全见", async () => {
    actor = { id: "__local__", role: "admin" };
    const body = await (await get("/api/logs/sessions")).json() as any;
    expect(body.can_see_all).toBe(true);
    expect(body.sessions.length).toBe(3);
  });
});

describe("事件读取的可见范围", () => {
  it("看自己的会话拿得到事件", async () => {
    actor = { id: "u1", role: "user" };
    const body = await (await get("/api/logs/sessions/s-u1/events")).json() as any;
    expect(body.total).toBe(5);
    expect(body.events.length).toBe(5);
    expect(body.events[0].kind).toBe("chat.turn");
  });

  it("**看别人的会话回 404 不是 403** —— 403 等于承认这个 id 存在", async () => {
    actor = { id: "u1", role: "user" };
    const res = await get("/api/logs/sessions/s-u2/events");
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("无归属的会话对普通用户也是 404 —— owner='' 不等于属于所有人", async () => {
    actor = { id: "u1", role: "user" };
    expect((await get("/api/logs/sessions/s-orphan/events")).status).toBe(404);
  });

  it("管理员能读别人的会话", async () => {
    actor = { id: "admin1", role: "admin" };
    const body = await (await get("/api/logs/sessions/s-u1/events")).json() as any;
    expect(body.session.owner).toBe("u1");
    expect(body.events.length).toBe(5);
  });

  it("单条全文同样受归属约束", async () => {
    actor = { id: "u1", role: "user" };
    expect((await get("/api/logs/sessions/s-u2/events/0")).status).toBe(404);
    const ok = await (await get("/api/logs/sessions/s-u1/events/0")).json() as any;
    expect(ok.seq).toBe(0);
  });
});

describe("分页游标", () => {
  it("正好一页时 next_since 是 null，多一条时是下一条 seq", async () => {
    actor = { id: "u1", role: "user" };
    const full = await (await get("/api/logs/sessions/s-u1/events?limit=5")).json() as any;
    expect(full.next_since).toBeNull();
    const partial = await (await get("/api/logs/sessions/s-u1/events?limit=2")).json() as any;
    expect(partial.events.length).toBe(2);
    // 游标是**下一条的 seq**，不是条数 —— seq 可能有洞
    expect(partial.next_since).toBe(2);
  });

  it("kind 过滤只筛当前页，不改游标", async () => {
    actor = { id: "u1", role: "user" };
    const body = await (await get("/api/logs/sessions/s-u1/events?kind=chat.step")).json() as any;
    expect(body.events.every((e: any) => e.kind === "chat.step")).toBe(true);
    expect(body.total).toBe(5); // total 仍是全量，不是筛后的
  });
});

describe("凭证打码", () => {
  it("高置信度的凭证被打码，且**明说打了**", () => {
    const [out, hit] = redactSecrets(`key=sk-abcdefghijklmnopqrstuvwxyz012345 end`);
    expect(hit).toBe(true);
    expect(out).toContain("已打码");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("end"); // 只吃掉凭证，别把整段吞了
  });

  it("正常内容一个字都不动 —— 猜错比漏掉更难发现", () => {
    const plain = "报销单在审批通过时触发 ERP 凭证生成，负责人是财务";
    const [out, hit] = redactSecrets(plain);
    expect(out).toBe(plain);
    expect(hit).toBe(false);
  });

  it("briefOf 把打码结果和标志一起带出去", () => {
    const row = makeEventRow({
      seq: 0, kind: "chat.turn", ts: 0,
      payload: { text: "我的 key 是 ghp_abcdefghijklmnopqrstuvwxyz" },
    });
    const b = briefOf(row);
    expect(b.redacted).toBe(true);
    expect(b.preview).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("内核执行账本", () => {
  it("普通用户能读取自己的 run，并拿到结构化输入与完整元数据", async () => {
    await writeRuntimeLedger();
    actor = { id: "u1", role: "user" };
    const res = await get("/api/logs/sessions/s-u1/runtime/runs");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total_runs).toBe(1);
    expect(body.runs[0]).toMatchObject({
      id: "chat_s-u1_reason_demo", event_count: 2, status: "recorded", truncated: false,
    });
    expect(body.runs[0].events[0].kind).toBe("effect.requested");
    expect(body.runs[0].events[0].payload.request.query).toBe("采购审批");
    expect(body.runs[0].events[0].payload.request.max_tokens).toBe("16000");
    expect(body.runs[0].events[0].payload.request.api_key).toBe("***已打码***");
    expect(body.runs[0].events[0].redacted).toBe(true);
  });

  it("账本与单事件详情都服从 owner 404 边界", async () => {
    await writeRuntimeLedger("s-u2", "chat_s-u2_reason_demo");
    actor = { id: "u1", role: "user" };
    expect((await get("/api/logs/sessions/s-u2/runtime/runs")).status).toBe(404);
    expect((await get("/api/logs/sessions/s-u2/runtime/runs/chat_s-u2_reason_demo/events/1")).status).toBe(404);
  });

  it("带 ref 的完成事件按需解出完整 output，并在出口递归打码", async () => {
    await writeRuntimeLedger();
    actor = { id: "u1", role: "user" };
    const body = await (await get(
      "/api/logs/sessions/s-u1/runtime/runs/chat_s-u1_reason_demo/events/1",
    )).json() as any;
    expect(body.fidelity).toBe("full");
    expect(body.resolved.answer).toBe("完整工具输出");
    expect(body.resolved.access_token).toBe("***已打码***");
    expect(body.redacted).toBe(true);
    expect(body.event.ref).toMatch(/^blob:/u);
  });

  it("requested.ref 被识别为完整 input，解引用后仍由服务端递归打码", async () => {
    await writeRuntimeLedger();
    actor = { id: "u1", role: "user" };
    const body = await (await get(
      "/api/logs/sessions/s-u1/runtime/runs/chat_s-u1_reason_demo/events/0",
    )).json() as any;
    expect(body.fidelity).toBe("full");
    expect(body.resolve_error).toBe("");
    expect(body.resolved.query).toBe("采购审批");
    expect(body.resolved.options.max_tokens).toBe(16_000);
    expect(body.resolved.credentials.api_key).toBe("***已打码***");
    expect(body.resolved.nested[0].password).toBe("***已打码***");
    expect(body.event.payload.request.api_key).toBe("***已打码***");
    expect(body.redacted).toBe(true);
  });

  it("request blob 捕获失败的事件明确保持 digest，并脱敏事件内的错误", async () => {
    const runId = "chat_s-u1_reason_capture_failed";
    const journal = new FileJournal(join(ROOT, "s-u1", "journal"));
    journal.append(makeEvent({
      runId, seq: 0, kind: EventKind.EFFECT_REQUESTED, nodeId: "TOOL", tsMs: 2_000,
      payload: {
        key: "TOOL#0", kind: "tool.call", request: { query: "采购审批" },
        request_fidelity: "digest",
        request_capture_error: "Error: token=sk-abcdefghijklmnopqrstuvwxyz012345",
      },
    }));
    await journal.flush();
    actor = { id: "u1", role: "user" };

    const body = await (await get(
      `/api/logs/sessions/s-u1/runtime/runs/${runId}/events/0`,
    )).json() as any;
    expect(body.fidelity).toBe("digest");
    expect(body.resolved).toBeNull();
    expect(body.event.payload.request_fidelity).toBe("digest");
    expect(body.event.payload.request_capture_error).toContain("已打码");
    expect(body.redacted).toBe(true);
  });
});
