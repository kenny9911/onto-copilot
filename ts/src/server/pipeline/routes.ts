/**
 * 流水线的两条路由 —— `server.py` 2085–2136。
 *
 * **路径、方法、请求/响应的 JSON 字段名一个字都不能改**：前端是现成的，
 * 改了就静默瞎掉（没有类型检查跨得过 HTTP）。
 *
 * FastAPI 的 `HTTPException(code, "文案")` 落到线上是 `{"detail": "文案"}`。
 * Hono 的 `HTTPException` 默认渲染成纯文本，所以 app 层**必须**装
 * {@link fastapiErrorHandler}（或等价物），否则前端读 `err.detail` 会读到
 * undefined，界面上就是一句空白的报错。
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { BUILD_STARTABLE, claimAndStartBuild } from "./run.js";
import { fingerprint } from "../../kernel/ids.js";
import type { PipelineDeps, SessionLike } from "./types.js";
import {
  FDE_REPLAYABLE_AGENT_NODES,
  fdeForkReplayableNodes,
} from "../glue/engagement_handoff.js";

/** 把 Hono 的 HTTPException 渲染成 FastAPI 的 `{"detail": …}`。 */
export function fastapiErrorHandler(err: Error): Response {
  if (err instanceof HTTPException) {
    return Response.json({ detail: err.message }, { status: err.status });
  }
  return Response.json({ detail: `${err.name}: ${err.message}` }, { status: 500 });
}

/** `POST /api/sessions/{sid}/build` 的纯函数形态（路由与测试共用）。 */
export async function build(
  sid: string,
  deps: PipelineDeps,
  rawTier: string | undefined,
): Promise<{ started: true; session: string; tier: string }> {
  const s: SessionLike = await deps.sessAsync(sid);
  const tier = rawTier === "full" || rawTier === "flow_preview" ? rawTier : "full";
  let outcome = await claimAndStartBuild(s, deps, { tier });
  // 抢不到租约但状态本来就可启动 = 一次争用，不是"在跑"。重试一次再下结论。
  if (BUILD_STARTABLE.includes(outcome)) outcome = await claimAndStartBuild(s, deps, { tier });
  if (outcome === "no_files") throw new HTTPException(400, { message: "还没有上传材料" });
  if (outcome === "missing") throw new HTTPException(404, { message: `没有会话 ${sid}` });
  if (outcome === "awaiting_answer") {
    throw new HTTPException(409, {
      message: "当前正在等待业务回答；请先回答、暂缓或导出问题清单。",
    });
  }
  if (outcome !== "started") {
    throw new HTTPException(409, { message: `没能启动梳理（会话状态：${outcome}）` });
  }
  return { started: true, session: s.id, tier };
}

/**
 * 中断在跑的生成：`target` 取 `chat`（对话轮）/ `run`（梳理任务）/
 * `all`（默认，两者都停）。
 *
 * 幂等 —— 没有在跑的就是一次 200 空操作。停止意图先落仓储，再取消本 worker
 * 的 task；远端 worker 由 build heartbeat / chat token watcher 协作取消。
 */
export async function stop(
  sid: string,
  deps: PipelineDeps,
  body: Record<string, unknown> | null,
): Promise<{ stopped: string[]; requested: string[] }> {
  const s = await deps.sessAsync(sid);
  const rawTarget = (body ?? {})["target"];
  const target = rawTarget === undefined || rawTarget === null || rawTarget === "" ? "all" : String(rawTarget);
  if (!["chat", "run", "all"].includes(target)) {
    throw new HTTPException(400, { message: "target 只能是 chat、run 或 all" });
  }
  const stopped: string[] = [];
  const requested: string[] = [];
  if (target === "chat" || target === "all") {
    const durableChat = await deps.repo().requestChatCancel(sid, { now: deps.now() });
    if (s.chatTask !== null && !s.chatTask.done()) {
      s.chatTask.abort();
      stopped.push("chat");
    } else if (durableChat) {
      // The durable lease is fenced, but only its worker can acknowledge task
      // termination.  Do not report a remote request as synchronously stopped.
      requested.push("chat");
    }
  }
  if (target === "run" || target === "all") {
    const durableRun = await deps.repo().requestBuildCancel(sid, { now: deps.now() });
    if (s.runTask !== null && !s.runTask.done()) {
      s.runTask.abort();
      stopped.push("run");
    } else if (durableRun) {
      s.status = "stopped";
      s.error = "";
      requested.push("run");
    }
  }
  return { stopped, requested };
}

/** 把这两条路由挂到 app 上。 */
export function pipelineRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();

  app.post("/api/sessions/:sid/build", async (c) => {
    const sid = c.req.param("sid");
    // FastAPI 的 `tier: str = "full"` 是 query 参数（不是 body）
    return c.json(await build(sid, deps, c.req.query("tier")));
  });

  // §7.5 节点级 fork 重跑：改一个专业节点的语义结论失效时，从它往下重跑，
  // 其余专业节点零模型重放、EXTRACT 检查点原样免费复用 ——「改一个决定不重跑
  // $90」的下半场。指令一次性（run.ts 读到即删）。
  app.post("/api/sessions/:sid/engagement/fork", async (c) => {
    const sid = c.req.param("sid");
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch { /* 空 body 走下面的 400 */ }
    const node = String(body["node"] ?? "").toUpperCase();
    if (!FDE_REPLAYABLE_AGENT_NODES.includes(node)) {
      throw new HTTPException(400, {
        message: `node 只能是专业节点之一：${FDE_REPLAYABLE_AGENT_NODES.join(" / ")}`,
      });
    }
    const s: SessionLike = await deps.sessAsync(sid);
    const stored = s.state["engagement_analysis"];
    const nodes =
      stored !== null && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)["nodes"]
        : null;
    const keepable =
      nodes !== null && typeof nodes === "object" && !Array.isArray(nodes)
        ? fdeForkReplayableNodes(node, nodes as Record<string, unknown>)
        : [];
    if (keepable.length === 0) {
      throw new HTTPException(400, {
        message: "没有可复用的上一轮专业分析 —— 直接重新梳理即可，fork 没有省钱空间。",
      });
    }
    const salt = `${node.toLowerCase()}.${fingerprint({
      node,
      prior: nodes,
      artifactRevision: Number(s.state["artifact_revision"] ?? 0) || 0,
    }).slice(0, 12)}`;
    s.state["engagement_fork"] = { node, salt };
    let outcome = await claimAndStartBuild(s, deps, { tier: "full" });
    if (BUILD_STARTABLE.includes(outcome)) outcome = await claimAndStartBuild(s, deps, { tier: "full" });
    if (outcome !== "started") {
      // 起不来就撤指令 —— 留着会让下一次普通梳理被动变成 fork
      delete s.state["engagement_fork"];
      throw new HTTPException(409, { message: `没能启动 fork 重跑（会话状态：${outcome}）` });
    }
    return c.json({ forked: node, replayed: keepable, session: s.id });
  });

  app.post("/api/sessions/:sid/stop", async (c) => {
    const sid = c.req.param("sid");
    // FastAPI 的 `body: dict | None = None` —— 没有 body / body 不是 JSON 都是 None。
    // Hono 的 `c.req.json()` 对空 body 会抛，所以在这里收成 null。
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await c.req.json();
      body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return c.json(await stop(sid, deps, body));
  });

  return app;
}
