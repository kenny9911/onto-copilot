/**
 * 会话分叉 —— 「从上一个拍板点重新梳理」。
 *
 * 借的是 pi（pi.dev）的会话树交互：会话历史是树，任意历史点都能分叉续跑。
 * 落在我们自己的数据模型上时，「历史点」有一个天然的锚：**决策 ordinal**。
 * 决策表（`DecisionRow`，见 store/types.ts）是 append-only、按计数器发号的，
 * 「回到第 N 个拍板点」于是有精确定义 —— 保留 ordinal ≤ N 的决策，其余不存在。
 *
 * ── 分叉复制什么、不复制什么（边界要清楚）─────────────────────────
 *
 * **复制**：材料文件（逐字节）、ordinal ≤ N 的决策（含被推翻的 —— 它们占号，
 * 删掉会让 ordinal 重排，supersedes 引用全部错位）、分叉血统（fork_of）。
 *
 * **不复制**：OIR / 流程图 / 问题清单 / 模板 —— 它们是**产物**，由「重新梳理」
 * 重建。这不是偷懒：产物是在**全部**决策影响下算出来的，只保留前 N 个决策时，
 * 旧产物就是错的。engagement 的 runId 恰好是 (材料指纹 + 决策 + 版本) 的指纹
 * （glue/engagement.ts），决策变了指纹就变，重跑自然发生 —— 分叉不需要任何
 * 特殊的失效逻辑，这是把血统建在指纹上的直接回报。
 *
 * ── supersede 的复活语义 ────────────────────────────────────────
 *
 * 决策 3 推翻了决策 1，在 ordinal=2 处分叉：决策 3 不存在了，于是决策 1
 * **复活**（superseded_by 指向 > N 的一律重置为 null）。这正是「回到那个时刻」
 * 的字面含义 —— 那个时刻决策 1 还生效。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Context, Hono } from "hono";

import { sha256Hex } from "../../kernel/ids.js";
import { makeSessionRow } from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { ownerId } from "../app.js";
import { SESSIONS, Session, currentRepo, root, sessAsync } from "../session.js";
import type { ServerEnv } from "./sessions.js";
import { apiError, shortId } from "./sessions.js";

/** 线上形态（snake_case，前端契约）。 */
export interface ForkLineage {
  session: string;
  at_ordinal: number;
  forked: number; // epoch 秒，与 created 同口径
}

export async function forkOnce(
  env: ServerEnv,
  src: Session,
  c: Context<AppEnv>,
  atOrdinal: number | null,
): Promise<Record<string, unknown>> {
  const repo = currentRepo();
  const rows = await repo.listDecisions(src.id);

  // 默认在**最后一个**拍板点分叉；显式给了就校验存在性 —— 一个指向不存在
  // ordinal 的分叉不是"少复制几条"，是调用方对会话历史的理解已经错了，要当场说。
  const maxOrdinal = rows.length - 1;
  const at = atOrdinal ?? maxOrdinal;
  if (at < -1 || at > maxOrdinal) {
    throw apiError(422, `没有 ordinal ${at} 的决策（当前 0..${maxOrdinal}）`);
  }
  // at = -1 是合法的：一个决策都不带，等于"只带材料从头来"。

  const ws = new Session(shortId(), {
    title: `${src.title} · 分叉@${at}`,
  });
  ws.state["mode"] = src.state["mode"] ?? "work";
  ws.owner = ownerId(c);
  ws.projectId = src.projectId;
  // 血统进 state（会被 persist 的白名单收进 docs），前端靠它画树。
  const lineage: ForkLineage = {
    session: src.id,
    at_ordinal: at,
    forked: Math.floor(Date.now() / 1000),
  };
  ws.state["fork_of"] = lineage as unknown as Record<string, unknown>;

  if (existsSync(ws.dir)) throw apiError(500, `目录已存在: ${ws.dir}`);
  mkdirSync(ws.dir, { recursive: true });

  // ── 材料：与 toWorkOnce 同一套拷贝纪律（sorted，顺序影响自动命名）──
  const srcMats = join(src.dir, "materials");
  if (existsSync(srcMats)) {
    const dstMats = join(ws.dir, "materials");
    mkdirSync(dstMats, { recursive: true });
    for (const name of readdirSync(srcMats).sort()) {
      const p = join(srcMats, name);
      if (!statSync(p).isFile()) continue;
      const dst = join(dstMats, name);
      copyFileSync(p, dst);
      ws.files.push({
        name,
        size: statSync(dst).size,
        path: dst,
        sha256: sha256Hex(readFileSync(dst)),
      });
    }
  }

  SESSIONS.set(ws.id, ws);
  try {
    await repo.createSession(
      makeSessionRow({
        id: ws.id,
        title: ws.title,
        project: "",
        status: ws.status,
        error: "",
        owner: ws.owner,
        project_id: ws.projectId,
      }),
    );

    // ── 决策：按 ordinal 升序重放进新会话 ──────────────────────────
    // recordDecision 用计数器发号（repo/memory.ts:756 与 PG 的行锁自增是同一套
    // 手法），所以**按原 ordinal 顺序**插入会精确复现 0..N 的号 —— 这也是必须
    // 连被推翻的行一起复制的原因：跳过它们，后面所有号全部前移，supersedes
    // 引用集体错位，而且不报错。
    const kept = rows
      .filter((r) => r.ordinal <= at)
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const r of kept) {
      await repo.recordDecision(ws.id, {
        ...r,
        // 推翻它的那条在分叉点之后 → 那条不存在了，这条**复活**。
        superseded_by:
          r.superseded_by !== null && r.superseded_by > at ? null : r.superseded_by,
      });
    }

    // 决策要立刻进对话记忆（不然要等下一次冷加载才看得见「已拍板」）。
    // restoreDialogue 读的就是刚写进 repo 的行，走它而不是手搓 —— 两条路径
    // 一旦分开维护，早晚一边改了另一边没跟上。
    await env.restoreDialogue(ws);
    await env.persist(ws, {});
  } catch (e) {
    // 半成品会话不能留在列表里 —— 用户点开一个"决策复制到一半"的会话，
    // 看到的是一份自相矛盾的历史。
    SESSIONS.delete(ws.id);
    throw e;
  }

  ws.emit("session.forked", { from: src.id, at_ordinal: at });
  return {
    ...ws.brief(),
    fork_of: lineage,
    decisions_carried: rows.filter((r) => r.ordinal <= at).length,
  };
}

export function registerForkRoutes(app: Hono<AppEnv>, env: ServerEnv): void {
  app.post("/api/sessions/:sid/fork", async (c) => {
    const src = await sessAsync(c.req.param("sid"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = body["at_ordinal"];
    // 只认整数。"2" 这种字符串不悄悄转 —— 分叉点是用户对历史的指认，宁可让
    // 前端改对，也不要在服务端猜。
    let at: number | null = null;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw apiError(422, "at_ordinal 必须是整数");
      }
      at = raw;
    }
    // 分叉是读源会话 + 建新会话，不改源会话 —— 但要挡住"源会话正被删除"的窗口，
    // 走 sessionMutation 与删除/改名共用同一把互斥。
    return await env.sessionMutation(src, "session.fork", async () =>
      c.json(await forkOnce(env, src, c, at)),
    );
  });
}
