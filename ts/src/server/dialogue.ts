/**
 * server 段 E —— 对话与对话侧动作工具。
 *
 * 移植自 `src/ontocopilot/server.py` 的 4513–6196 行：`_dialogue(s)` 那一节，
 * 加上整个「对话侧的动作工具」（工具本体在 `dialogue/tools.ts`）。
 *
 * 这是用户每天真正在用的那条路：聊天框里问一句，系统要能改 OIR、补证据、
 * 导出文件、回答问题。所以三件事被当成硬约束：
 *
 * * **路由路径、HTTP 方法、请求/响应的 JSON 字段名一个字都不改。** 前端是现成的，
 *   改了就静默瞎掉 —— 没有类型检查跨得过 HTTP。
 * * **工具的失败文案逐字迁。** 那些 `{"error": …}` 是设计给模型看的自纠信号。
 * * **聊天租约与 build 租约的互斥关系保住**，见 {@link chatRoute} 与
 *   {@link withSessionMutation}。
 *
 * FastAPI → Hono 的对应关系照迁移约定 §10：`@app.post("/api/sessions/{sid}/chat")`
 * → `app.post("/api/sessions/:sid/chat", …)`，`HTTPException(429, t)` →
 * `new HTTPException(429, { message: t })`。
 */

import { mkdirSync } from "node:fs";

import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";

import { app as sharedApp, type AppEnv } from "./app.js";

import { Difficulty } from "../kernel/dag.js";
import { DialogueMemory, Speaker } from "../kernel/memory/dialogue.js";
import { FlowGraph, flowFromDict } from "../onto/flow.js";
import { OIR, oirFromDict } from "../onto/oir.js";

import { cpSlice } from "../onto/parse/base.js";
import { pyJsonDumps } from "../kernel/journal.js";
import { isCancelled, makeRunHandle, RunCancelled } from "./pipeline/types.js";
import { pyTruthy } from "./pipeline/tables.js";

import { startHeartbeat, waitOrAbort } from "./dialogue/cancel.js";
import { ChatCtx } from "./dialogue/ctx.js";
import { publishTurn } from "./dialogue/memory.js";
import { converseTools, isBusy } from "./dialogue/tools.js";
import type {
  ConverseTurnLike,
  DialogueDeps,
  IntentMatchLike,
  SessionLike,
} from "./dialogue/ports.js";
import { excName, excText, formatPercent0, pyJsonIndent, pyRound } from "./dialogue/pyutil.js";

export { startHeartbeat, waitOrAbort } from "./dialogue/cancel.js";
export { ChatCtx } from "./dialogue/ctx.js";
export { dialogueOf, publishTurn, rememberTables, TABLE_MEMORY_CAP } from "./dialogue/memory.js";
export { converseTools, isBusy } from "./dialogue/tools.js";
export * from "./dialogue/ports.js";

// ══════════════════════════════════════════════════════════════════
//  对话
// ══════════════════════════════════════════════════════════════════

/**
 * 按会话当前状态构造解析器。
 *
 * 问题/建议的 **展示顺序**就是用户口中的"第几条" —— 这个映射必须来自当前状态，
 * 不能写死。用户说"第3条"时，第3条是什么完全取决于他屏幕上看到的是什么。
 */
export function parserFor(s: SessionLike, deps: DialogueDeps) {
  const oir = s.state["_oir"];
  const names =
    oir instanceof OIR ? [...oir.objects.values()].map((o) => o.apiName.value) : [];
  return deps.makeParser({
    questionIds: listOf(s, "questions").map((q) => String(q["conflict_rid"] ?? "")),
    suggestionIds: listOf(s, "suggestions").map((x) => String(x["id"] ?? "")),
    objectNames: names,
  });
}

function listOf(s: SessionLike, key: string): Record<string, unknown>[] {
  const v = s.state[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// ══════════════════════════════════════════════════════════════════
//  对话侧的动作工具
// ══════════════════════════════════════════════════════════════════

/**
 * 启动时只回收 lease 过期（或迁移前无 lease）的运行。
 *
 * 单个 Run 不能活过它所属 worker 重启，但其它 worker 仍可能健康运行。进程启动
 * 不等于整个服务集群重启；以 durable expiry 为准，不能以本地 Task 缓存为准。
 *
 * 以前这件事只在 `_hydrate` 里做，也就是**有人点开那个会话时**才纠正。
 * 列表里它会一直显示「进行中」，用户等一个永远不会来的结果 —— 而他不点开，
 * 就永远等不到纠正。对账必须在启动时做一次，不能等人来触发。
 */
export async function reconcileOnBoot(deps: DialogueDeps): Promise<void> {
  const repo = deps.getRepo();
  let rows;
  try {
    rows = await repo.listSessions({ limit: 500 });
  } catch {
    // 对账失败不该挡住启动
    return;
  }
  let n = 0;
  for (const r of rows) {
    if (r.status === "queued" || r.status === "parsing" || r.status === "extracting") {
      const reaped = await repo.reapExpiredBuildLease(r.id, {
        now: deps.now(),
        error:
          "上次运行的租约已过期。材料、决定和**已经跑完的那部分**都还在 ——" +
          "再点一次「开始梳理」会接着上次的进度跑，不重复花钱。",
      });
      n += reaped ? 1 : 0;
    }
  }
  if (n) console.log(`[store] 启动对账：${n} 个会话上次没跑完，已标记为中断`);
}

/**
 * 用户确认后，直接重放上一轮被拦的那个高危动作。
 *
 * 不重新推理 —— 动作和参数已经定了，重新推理只会引入不确定性（模型可能这次
 * 理解成别的意思）。用同一套工具、approved=true 执行，全程照样进 tool.call
 * 记账，可审计不变。
 */
export async function replayPending(
  s: SessionLike,
  deps: DialogueDeps,
  action: Record<string, unknown>,
  opts: { batch?: number } = {},
): Promise<string> {
  const batch = opts.batch ?? 0;
  const toolName = String(action["tool"] ?? "");
  const args = asRecord(action["args"]);
  let result: unknown;
  let failedReply = "";
  try {
    await deps.chatRun(
      s,
      {
        kind: "confirm",
        semanticInput: {
          batch,
          tool: toolName,
          args,
          artifactRevision: s.state["artifact_revision"] ?? null,
        },
      },
      async (run) => {
        const tools = converseTools(s, deps);
        const ctx = new ChatCtx({
          turnId: run.recorderRunId,
          rec: run.gw.rec as never,
          approved: true,
        });
        result = await tools.call(toolName, args, ctx, { scope: "converse" });
        if (result !== null && typeof result === "object" && !Array.isArray(result)) {
          const err = (result as Record<string, unknown>)["error"];
          if (pyTruthy(err)) {
            const error = String(err);
            run.fail(error);
            failedReply = `没执行成功：${error}`;
          }
        }
      },
    );
  } catch (exc) {
    // Python 的 `except asyncio.CancelledError: raise` 在这里是显式的：
    // JS 没有 BaseException 那层保护，取消必须自己判、自己重抛。
    if (isCancelled(exc)) throw exc;
    // 重放失败要如实说
    return `执行「${toolName}」时出错了：${excName(exc)}: ${excText(exc)}`;
  }
  if (failedReply) return failedReply;
  // 措辞成人话：用同一个 say，把结果当事实交给它
  return await say(
    s,
    deps,
    outcome("confirmed", cpSlice(pyJsonDumps(result, { defaultStr: true }), 0, 400), {
      动作: toolName,
      结果: result,
    }),
    "确认执行",
  );
}

/**
 * 聊天里用户传的文件摘成一段文本，供模型对话参考（不是正式梳理）。
 *
 * 截到 cap 字符 —— 聊天不做梳理，把全文塞进 prompt 既贵又没必要；要完整梳理
 * 就转成工作会话。
 */
export function chatDocsBrief(s: SessionLike, opts: { cap?: number } = {}): string {
  const cap = opts.cap ?? 6000;
  const parts = ["用户在这次聊天里上传了文件，内容摘录如下（供对话参考，不是正式梳理）："];
  let used = 0;
  const chunks = asRecord(s.state["_chunks"]) as Record<string, Record<string, unknown>[]>;
  for (const [fname, cs] of Object.entries(chunks)) {
    parts.push(`\n【${fname}】`);
    for (const c of cs ?? []) {
      const t = String(c["text"] ?? "").trim();
      if (!t) continue;
      parts.push(cpSlice(t, 0, 1200));
      used += Math.min([...t].length, 1200);
      if (used >= cap) {
        parts.push("…（其余略；要完整梳理请点「转成工作会话」）");
        return parts.join("\n");
      }
    }
  }
  return parts.join("\n");
}

/** 跑一轮对话推理（含预算闸与 Run 生命周期）。 */
export async function reason(
  s: SessionLike,
  deps: DialogueDeps,
  text: string,
  opts: { hint?: string; approved?: boolean; signal?: AbortSignal } = {},
): Promise<ConverseTurnLike> {
  const hint = opts.hint ?? "";
  const approved = opts.approved ?? false;
  // Cap rejection is a request-policy outcome, not a model Run.  Check it before
  // allocating a repository row so a rejected HTTP call cannot leave a useless
  // failed chat invocation behind.
  const spent = Number(s.state["_chat_usd"] ?? 0) || 0;
  const cap = deps.chatUsdCap();
  if (spent >= cap) {
    // S3：**我们自己设的闸**，网关账户跟这件事无关。走和梳理侧同一份文案，
    // 因为它是唯一一处保证不出现"充值/余额"字样的（铁律 C4）。事件也一起发：
    // 429 的响应体只有发起那一轮的人看得到，常驻提醒条要靠这条事件才亮得起来。
    const capped = deps.budgetCappedText({ spent, cap, scope: "chat" });
    s.emit("budget.capped", { message: capped, spent, cap, scope: "chat" });
    throw new HTTPException(429, { message: capped });
  }
  const dm = s.state["_dialogue"];
  const semanticInput = {
    text,
    hint,
    approved,
    lang: s.lang,
    mode: s.state["mode"] ?? "work",
    model: s.state["model"] ?? null,
    files: s.files.map((f) => [f.name, f.sha256, f.size]),
    oir: s.state["oir"] ?? null,
    flow: s.state["flow"] ?? null,
    questions: pyTruthy(s.state["question_backlog"])
      ? s.state["question_backlog"]
      : (s.state["questions"] ?? null),
    suggestions: s.state["suggestions"] ?? null,
    chunks: s.state["_chunks"] ?? null,
    dialogue: dm instanceof DialogueMemory ? dm.toDict() : null,
    model_overrides: deps.modelOverrides(),
  };
  return await deps.chatRun(s, { kind: "reason", semanticInput }, async (run) => {
    const inOpts: { hint: string; approved: boolean; signal?: AbortSignal } = { hint, approved };
    if (opts.signal !== undefined) inOpts.signal = opts.signal;
    return await reasonInRun(s, deps, text, run, inOpts);
  });
}

/**
 * 跑一轮对话推理，并把每一步投影成事件。
 *
 * 工具只给 `readonly` 作用域：对话能查任何东西，但**不能静默改产物**。
 * 要改必须走显式执行器并回显改了什么 —— 一个能在闲聊里悄悄删掉 17 个对象的
 * 副驾是不能用的。
 */
async function reasonInRun(
  s: SessionLike,
  deps: DialogueDeps,
  text: string,
  run: { recorderRunId: string; gw: import("./dialogue/ports.js").GatewayLike; fail(e: string): void },
  opts: { hint: string; approved: boolean; signal?: AbortSignal },
): Promise<ConverseTurnLike> {
  mkdirSync(s.dir, { recursive: true });
  const runId = run.recorderRunId;
  const gw = run.gw;
  // 对话花的钱要**跨轮累计**。Budget 是每轮新建的，$15 那个上限是"每一轮"的
  // 上限 —— 也就是说对话侧根本没有封顶。一轮真问题跑满 5 步实测约 $0.08，
  // 一天两百轮就是十几美元，而它们大多是本可以不花的。
  const spent = Number(s.state["_chat_usd"] ?? 0) || 0;
  const tools = converseTools(s, deps);
  let agent;
  if (s.state["mode"] === "chat") {
    // 聊天模式：通用助手 + **只读分析工具**（能检索上传的材料来分析），但**没有任何
    // 生成产物的工具** —— 不抽本体/不出流程图/不生成模板，那些是工作模式的事。
    // 用同一份注册表、但按 chat 作用域取工具：拿得到只读的看/查/读材料，
    // 拿不到任何改产物的（那些是 RW=converse）。作用域即授权，不靠提示词自律。
    agent = deps.makeAgent({
      gateway: gw,
      tools,
      scope: "chat",
      maxSteps: 4,
      system: deps.chatSystem,
      lang: s.lang,
    });
  } else {
    // 工作模式的模型选择器：选了具体模型就让对话直接用它（梳理管线仍按能力路由）
    const chosen = String(s.state["model"] ?? "");
    const modelSpec = chosen ? deps.modelSpecFor(chosen) : null;
    agent = deps.makeAgent({
      gateway: gw,
      tools,
      scope: "converse",
      maxSteps: 5,
      model: modelSpec,
      lang: s.lang,
    });
  }

  const onStep = (rec: Record<string, unknown>): void => {
    // 推理过程必须可见 —— 看不见的推理和编造的区别，用户分辨不出来。
    // 带上轮次 id：同一步会回调两次（发起时、拿到观察后），而不同轮次的
    // 步号会重复，只按步号去重会把上一轮的步骤覆盖掉。
    s.emit("chat.step", { step: { ...rec, turn: runId, q: cpSlice(text, 0, 40) } });
  };

  let ctxText = contextBrief(s);
  const dm = s.state["_dialogue"];
  if (dm instanceof DialogueMemory && dm.turns.length > 0) {
    ctxText += "\n\n最近对话（用于解析‘刚才那个/上一版’等指代）：\n" + dm.renderRecent(6);
  }
  // 聊天模式里用户传了文件 → 把文本摘录塞进上下文，模型才能就它对话（聊天无工具）
  if (s.state["mode"] === "chat" && pyTruthy(s.state["_chunks"])) {
    ctxText += "\n\n" + chatDocsBrief(s);
  }
  if (opts.hint) {
    // 规则层的判定作为**提示**给出，不是命令 —— 措辞上要让模型知道它可以不采纳。
    ctxText += `\n\n规则层对这句话的初步判断（仅供参考，你可以不同意）：${opts.hint}`;
  }
  const ctx = new ChatCtx({ turnId: runId, rec: gw.rec as never, approved: opts.approved });
  const runOpts: Parameters<typeof agent.run>[1] = { ctx, context: ctxText, onStep };
  if (opts.signal !== undefined) runOpts.signal = opts.signal;
  const turn = await agent.run(text, runOpts);
  if (turn.findings.some((f) => f.code === "GATEWAY_ERROR")) {
    run.fail(turn.answer || "conversation gateway failed");
  }
  s.state["_last_reason"] = turn.toDict();
  s.state["_chat_usd"] = spent + (Number(turn.usd ?? 0) || 0);
  // 记下这一轮被闸门拦下的高危动作，供下一轮确认时直接重放。
  // **被拦下的动作要全留。** 推理循环遇到 ToolDenied 不中断、继续往下想，所以
  // 一轮里可能连着撞上好几个要确认的写工具（oir.add 之后又 flow.edit）。只留
  // ctx.pending[0] 的话，用户点了「确认执行」也只有第一个真的发生，其余静默丢失 ——
  // 而回答里已经说了都会做。
  s.state["_pending_actions"] = [...ctx.pending];
  s.state["_pending_action"] = ctx.pending.length > 0 ? ctx.pending[0] : null;
  return turn;
}

/**
 * 给推理循环的会话状态摘要。
 *
 * 进**系统层**而不是用户层：用户说的话和系统给的事实混在一起，材料里写的
 * 「请忽略之前的指令」就有机会冒充系统事实。
 */
export function contextBrief(s: SessionLike): string {
  const parts: string[] = [];
  const st = asRecord(s.state["oir"])["stats"];
  if (pyTruthy(st)) {
    parts.push(
      "当前产物：" +
        Object.entries(asRecord(st))
          .map(([k, v]) => `${k}=${String(v)}`)
          .join("、"),
    );
  }
  // 材料清单带上"读进来多少段"：只给文件名的话，模型分不清一份材料是**内容都在**
  // 还是**只登记了文件名**（图片没识别时就是后者），于是会对着空气回答。
  const chunks = asRecord(s.state["_chunks"]) as Record<string, unknown[]>;
  if (s.files.length > 0) {
    const inv = s.files
      .map((f) => {
        const cs = chunks[f.name];
        const n = Array.isArray(cs) ? cs.length : 0;
        return `${f.name}（${n} 段` + (pyTruthy(cs) ? "" : "，尚未识别内容") + "）";
      })
      .join("、");
    parts.push(`材料：${inv}`);
  } else {
    parts.push("材料：（还没上传）");
  }
  const dm = s.state["_dialogue"];
  if (dm instanceof DialogueMemory) {
    const ds = dm.activeDecisions();
    if (ds.length > 0) parts.push("已拍板：" + ds.slice(0, 8).map((d) => d.render()).join("；"));
  }
  const qs = listOf(s, "questions");
  if (qs.length > 0) parts.push(`待拍板 ${qs.length} 个`);
  const sg = listOf(s, "suggestions");
  if (sg.length > 0) {
    parts.push(
      "待处理建议：" +
        sg
          .slice(0, 5)
          .map((x, i) => `${i + 1}.${String(x["title"] ?? "")}`)
          .join("；"),
    );
  }
  return parts.join("\n");
}

/**
 * Refresh a cached worker projection after it wins the durable chat lease.
 *
 * A lease serializes *future* mutations but does not make a worker's old object
 * current.  Compare the durable `state_version` only after claiming the lease; when
 * it advanced elsewhere, replace every persisted projection key and rebuild the live
 * OIR/flow/dialogue objects before interpreting this turn.
 *
 * Runtime handles (SSE subscribers, local build task and locks) remain on the same
 * `Session` instance.  That matters when a chat arrives while a local build is
 * active; replacing the instance would orphan the pipeline and its subscribers.
 */
export async function refreshChatProjection(
  s: SessionLike,
  deps: DialogueDeps,
): Promise<SessionLike> {
  const repo = deps.getRepo();
  const row = await repo.getSession(s.id);
  if (row === null) throw new HTTPException(404, { message: `没有会话 ${s.id}` });
  if (row.state_version === s.stateVersion) {
    // 改名**不推进** state_version（它是状态文档的 CAS，见 repo.renameSession），
    // 所以这条快路上要单独把标题接过来。不接的话：另一个 worker 上改的名字在
    // 这里永远看不见，而且 autoTitle 会拿一个陈旧的「新会话」当判据，把用户
    // 刚起的名字覆盖掉 —— 正是最惹人烦的那类 bug。
    s.title = row.title;
    await deps.refreshFilesProjection(s);
    return s;
  }

  const saved = await repo.loadState(s.id);
  const durableKeys = new Set<string>([
    ...deps.persistedKeys,
    ...deps.persistedPrivateKeys,
    ...deps.persistedPrivateDocKeys,
    "dialogue",
  ]);
  for (const key of durableKeys) delete s.state[key];
  Object.assign(s.state, saved);
  delete s.state["_dialogue"];
  await deps.restoreDialogue(s);

  const oirDoc = s.state["oir"];
  if (oirDoc !== null && typeof oirDoc === "object" && !Array.isArray(oirDoc)) {
    try {
      s.state["_oir"] = oirFromDict(oirDoc as Record<string, unknown>);
    } catch (exc) {
      throw new HTTPException(409, { message: `会话本体状态无法刷新：${excText(exc)}` });
    }
  } else {
    delete s.state["_oir"];
  }

  const flowDoc = s.state["flow"];
  if (flowDoc !== null && typeof flowDoc === "object" && !Array.isArray(flowDoc)) {
    try {
      s.state["_flow"] = flowFromDict(flowDoc as Record<string, unknown>);
    } catch (exc) {
      throw new HTTPException(409, { message: `会话流程状态无法刷新：${excText(exc)}` });
    }
  } else {
    delete s.state["_flow"];
  }

  s.title = row.title;
  s.project = row.project;
  s.projectId = row.project_id; // 另一个 worker 把会话移进/移出了项目
  s.status = row.status;
  s.error = row.error;
  s.owner = row.owner;
  s.stateVersion = row.state_version;
  await deps.refreshFilesProjection(s);
  return s;
}

/**
 * 状态文档的深拷贝。
 *
 * Python 那句是 `copy.deepcopy(s.state)`，注释写死了理由：**OIR/Flow 编辑器是
 * 就地改对象的，浅拷贝一份 dict 照样会把它们的改动漏出去。**
 *
 * TS 没有通用 deepcopy 能保住 class 原型（`structuredClone` 会把 OIR 变成裸对象，
 * 恢复回去之后 `oir.stats()` 直接不是函数）。所以这里按类型分派：
 * 有 `toDict/fromDict` 往返的三个活对象走往返，纯 JSON 走递归克隆，
 * **其余未知类实例保留引用** —— 目前只有 `_index`（只读的证据索引缓存），
 * 它不参与编辑，漏引用不会造成半应用状态。这条限制写在这里，不藏。
 */
function deepCopyState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) out[k] = deepCopyValue(v);
  return out;
}

function deepCopyValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof OIR) return oirFromDict(v.toDict());
  if (v instanceof FlowGraph) return flowFromDict(v.toDict());
  if (v instanceof DialogueMemory) return DialogueMemory.fromDict(v.toDict());
  if (Array.isArray(v)) return v.map(deepCopyValue);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, deepCopyValue(x)]));
  if (v instanceof Set) return new Set([...v].map(deepCopyValue));
  if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepCopyValue(x);
    return out;
  }
  return v; // 未知类实例：保引用（见上面的说明）
}

/**
 * Serialize one cross-table/domain mutation across all workers.
 *
 * Claim happens before refreshing the projection or touching files/tables.  Losing
 * the lease cancels the request; an exception reloads durable state so this worker's
 * cached objects cannot leak a partial edit into a later request.
 */
export async function withSessionMutation<T>(
  s: SessionLike,
  deps: DialogueDeps,
  kind: string,
  opts: { chatOwner?: string; signal?: AbortSignal; onLeaseLost?: () => void },
  body: (owner: string) => Promise<T>,
): Promise<T> {
  const owner = opts.chatOwner || `${deps.workerId}:mutation:${deps.newToken()}`;
  const claimed = await deps.getRepo().claimMutationLease(s.id, {
    owner,
    kind,
    now: deps.now(),
    ttl: deps.mutationLeaseTtl,
  });
  if (!claimed) {
    throw new HTTPException(409, {
      message: "会话正在梳理或另一个领域修改尚未提交，请稍后重试。",
    });
  }

  const beat = startHeartbeat(
    deps.mutationHeartbeatInterval,
    async () =>
      await deps.getRepo().renewMutationLease(s.id, {
        owner,
        now: deps.now(),
        ttl: deps.mutationLeaseTtl,
      }),
    // 续不上租约 = 这个 worker 已经不是会话的主人。Python 那边 `owner_task.cancel()`；
    // 这里由调用方给一个 abort 回调（chatRoute 传的是它自己那个 controller），
    // 再由下面的 waitOrAbort 把它变成一次 RunCancelled。
    () => opts.onLeaseLost?.(),
  );

  const previousOwner = s.mutationLeaseOwner;
  let stateSnapshot: Record<string, unknown> | null = null;
  let statusSnapshot = s.status;
  let errorSnapshot = s.error;
  let versionSnapshot = s.stateVersion;
  try {
    s.mutationLeaseOwner = owner;
    await refreshChatProjection(s, deps);
    await deps.refreshFilesProjection(s);
    // Rejections are part of the normal API contract (invalid transition, damaged
    // return template, failed validator).  Preserve the projection that existed
    // *after* the lease refresh so a fail-closed 4xx cannot erase live objects from
    // tests/legacy sessions whose initial state has not yet been checkpointed.
    stateSnapshot = deepCopyState(s.state);
    statusSnapshot = s.status;
    errorSnapshot = s.error;
    versionSnapshot = s.stateVersion;
    const running = body(owner);
    // 有信号就让它能打断这次 body —— Python 的 `task.cancel()` 会在下一个 await
    // 点抛出来，这里靠 waitOrAbort 达到同样的落点。
    return opts.signal === undefined ? await running : await waitOrAbort(running, opts.signal);
  } catch (exc) {
    // If no projection checkpoint committed, restore the exact leased snapshot.
    // If state_version advanced, a durable saga step won and the database is the
    // authority; hydrate it instead of rolling back a committed Decision/Revision.
    const row = await deps.getRepo().getSession(s.id);
    if (stateSnapshot !== null && row !== null && row.state_version === versionSnapshot) {
      for (const k of Object.keys(s.state)) delete s.state[k];
      Object.assign(s.state, stateSnapshot);
      s.status = statusSnapshot;
      s.error = errorSnapshot;
      s.stateVersion = versionSnapshot;
    } else {
      s.stateVersion = -1;
      try {
        await refreshChatProjection(s, deps);
      } catch (refreshExc) {
        // preserve original exception
        s.emit("mutation.refresh_failed", { error: excText(refreshExc), kind });
      }
    }
    throw exc;
  } finally {
    s.mutationLeaseOwner = previousOwner;
    await beat.stop();
    await deps.getRepo().releaseMutationLease(s.id, { owner });
  }
}

/** Single-flight wrapper for every chat mutation, including confirm replay. */
export async function chatRoute(
  sid: string,
  body: Record<string, unknown>,
  deps: DialogueDeps,
): Promise<Record<string, unknown>> {
  let s = await deps.sessAsync(sid);
  const leaseOwner = `${deps.workerId}:chat:${deps.newToken()}`;
  const claimed = await deps
    .getRepo()
    .claimChatLease(sid, { owner: leaseOwner, now: deps.now(), ttl: deps.chatLeaseTtl });
  if (!claimed) {
    throw new HTTPException(409, {
      message: "这个会话已有一轮对话正在处理，请等它结束或先停止。",
    });
  }
  // 心跳续不上 = 这个 worker 已经不是会话的主人；Python 那边直接 cancel 掉请求
  // 任务，这里对应地 abort 整条请求。
  const ctl = new AbortController();
  const beat = startHeartbeat(
    deps.chatHeartbeatInterval,
    async () =>
      await deps
        .getRepo()
        .renewChatLease(sid, { owner: leaseOwner, now: deps.now(), ttl: deps.chatLeaseTtl }),
    () => ctl.abort(),
  );

  try {
    s = await refreshChatProjection(s, deps);
    let result: Record<string, unknown>;
    if (s.state["mode"] !== "chat" && !isBusy(s)) {
      // Work-mode tools include synchronous structure editors.  Holding the mutation
      // lease for the whole turn is the only way to cover every tool call before its
      // first file/OIR side effect.  Pure chat mode never gets those tools and
      // therefore remains lease-free.
      result = await withSessionMutation(
        s,
        deps,
        "chat.structural",
        { chatOwner: leaseOwner, signal: ctl.signal, onLeaseLost: () => ctl.abort() },
        async () =>
          await chatClaimed(s, deps, body, { chatOwner: leaseOwner, signal: ctl.signal }),
      );
    } else {
      result = await chatClaimed(s, deps, body, { chatOwner: leaseOwner, signal: ctl.signal });
    }
    // 一轮说完了才起名 —— 用的是用户这句话，跑不跑得通不影响它，但要等这轮
    // 真的成立（异常路径下会话可能压根没留下这句话）。守卫在 autoTitle 里：
    // 只有还叫默认名的会话会被改，所以这一行实际只在第一轮生效。
    await deps.autoTitle(s, { firstText: String(body["text"] ?? "") });
    return result;
  } catch (exc) {
    if (!isCancelled(exc)) throw exc;
    // Remote /stop reaches the route through the durable lease heartbeat.  The cancel
    // intent already fenced this owner; do not append a stale stopped turn or perform
    // an unfenced save from a worker that has lost ownership.
    // 提示仍然要给 —— 但只用**纯函数**算，不写 state、不落库：这个 worker
    // 已经不是会话的主人了。
    const publicState: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.state)) if (!k.startsWith("_")) publicState[k] = v;
    return {
      reply: "（已停止）",
      stopped: true,
      needs_confirm: false,
      followups: deps.followupPrompts({
        answer: "（已停止）",
        state: publicState,
        asked: deps.asked(s),
        files: s.files.map((f) => f.name),
        status: s.status,
      }),
    };
  } finally {
    await beat.stop();
    await deps.getRepo().releaseChatLease(sid, { owner: leaseOwner });
  }
}

/**
 * 对话入口。
 *
 * **不阻塞流水线**：梳理跑着的时候仍可查询、解释和补充上下文。会改产物的工具
 * 在 Run 进行中明确拒绝并提示稍后重试；当前实现没有 durable mutation queue，
 * 因而不能声称动作已排队，否则 FDE 会误以为改动将在后台自动生效。
 */
export async function chatClaimed(
  s: SessionLike,
  deps: DialogueDeps,
  body: Record<string, unknown>,
  opts: { chatOwner: string; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const chatOwner = opts.chatOwner;
  // 请求时捕获界面语言：助手回复语言、意图解析规则表都据此选（后台管线读不到请求）。
  s.lang = String(body["lang"] ?? "").toLowerCase().startsWith("en") ? "en" : "zh";
  const text = String(body["text"] ?? "").trim();
  if (!text) throw new HTTPException(400, { message: "说点什么" });
  // 用户对上一轮那个被挡住的动作说「确认」。**这一轮限定放行** ——
  // 不是给会话开一个长期后门。
  const approved = pyTruthy(body["confirm"]);

  // 确认时**直接重放**上一轮被拦的动作，不重新推理。全局 approved bool 不记得
  // 在确认什么，模型重新推理时会把「确认」理解成别的意思（采纳哪条建议）——
  // 用户明明在确认一个模板编辑，却被问"要采纳第几条建议"。重放才是确定的。
  const many = s.state["_pending_actions"];
  const one = s.state["_pending_action"];
  const pendingAll: Record<string, unknown>[] = pyTruthy(many)
    ? (many as Record<string, unknown>[])
    : pyTruthy(one)
      ? [one as Record<string, unknown>]
      : [];
  if (approved && pendingAll.length > 0) {
    publishTurn(s, deps, Speaker.USER, text, { intent: "confirm", confidence: 1.0 });
    // 逐个重放，逐个回执 —— 做了几件就说几件，不能只报第一件
    const parts: string[] = [];
    for (let i = 0; i < pendingAll.length; i += 1) {
      parts.push(await replayPending(s, deps, pendingAll[i] as Record<string, unknown>, { batch: i }));
    }
    const reply = parts.filter((x) => x).join("\n\n");
    publishTurn(s, deps, Speaker.ASSISTANT, reply);
    s.state["_pending_actions"] = [];
    s.state["_pending_action"] = null;
    // 重放没走推理循环，也就没有自带的追问 —— 这条路上补算一次。
    const replayFollowups = deps.settleFollowups(s, { reply });
    await deps.persist(s, { status: false, chatOwner });
    return { reply, needs_confirm: false, replayed: true, followups: replayFollowups };
  }

  const parse = parserFor(s, deps).parse(text);
  const top = pyMaxByConfidence(parse.matches);
  publishTurn(s, deps, Speaker.USER, text, {
    intent: String(top.intent),
    confidence: top.confidence,
  });

  // **每一轮都进推理循环。** 以前是规则判出意图就直接执行、模型只负责措辞 ——
  // 那样「你好」根本走不到推理，轨迹永远是空的；规则判错时模型也没有机会纠正，
  // 它拿到的已经是既成事实。
  //
  // 规则的判定没有丢，降级成提示塞进 prompt：它便宜、准、可审计，
  // 但不再是绕过模型的旁路。
  const hint = parse.matches
    .filter((m) => m.intent !== deps.unknownIntent)
    .map(
      (m) =>
        `${m.intent}(${formatPercent0(m.confidence)}` +
        (pyTruthy(m.slots) ? `, ${pyJsonDumps(m.slots)}` : "") +
        ")",
    )
    .join("、");

  // `s.chatTask` 是 /stop 的抓手（段 A 的 stop 路由调 `abort()`）。
  // **不能只 await handle.promise**：`abort()` 只是打信号，被取消方查不查是它自己
  // 的事，而"点停止立刻回一句（已停止）"是 HTTP 契约。所以外面再包一层
  // `waitOrAbort` —— 信号一到调用方就往下走，不指望下游配合。
  let turnBox: ConverseTurnLike | null = null;
  const handle = makeRunHandle(async (signal) => {
    turnBox = await reason(s, deps, text, { hint, approved, signal });
  });
  s.chatTask = handle;
  // 外层（chat 租约丢了）也要能把这一轮停下来 —— 否则一个已经不是主人的 worker
  // 会一路把结果写完再落库。
  const outer = opts.signal;
  const onOuterAbort = (): void => handle.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  let turn: ConverseTurnLike;
  try {
    await waitOrAbort(handle.promise, handle.signal);
    // 信号赢了 race、而推理其实已经成功返回过 —— 不可能同时成立，但类型上要收口。
    if (turnBox === null) throw new RunCancelled();
    turn = turnBox;
  } catch (exc) {
    if (!isCancelled(exc)) throw exc;
    // **两种取消不是一回事，落点也不一样。**
    // 用户点停止（只有内层 handle 被 abort）→ 落一个"已停止"标记，安静收尾。
    // 租约丢了（外层也 abort 了）→ 这个 worker 已经不是会话的主人，既不能追加
    // 一条陈旧的 stopped 轮次、也不能做一次没有围栏的落库，原样上抛给 chatRoute。
    if (outer?.aborted === true) throw exc;
    publishTurn(s, deps, Speaker.ASSISTANT, "（已停止）");
    // 停下来之后更需要一个出口。
    const stoppedFollowups = deps.settleFollowups(s, { reply: "（已停止）" });
    await deps.persist(s, { status: false, chatOwner });
    return { reply: "（已停止）", stopped: true, needs_confirm: false, followups: stoppedFollowups };
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
    s.chatTask = null;
  }

  const replies: string[] = [];
  if (turn.answer) replies.push(turn.answer);
  if (turn.citations.length > 0) {
    replies.push("依据：" + turn.citations.slice(0, 4).map((c) => `◧ ${c}`).join("　"));
  }
  if (turn.followup) replies.push(`（我不确定的一点：${turn.followup}）`);

  const reply = replies.filter((r) => r).join("\n\n") || "收到。";
  publishTurn(s, deps, Speaker.ASSISTANT, reply);
  // 系统刚说完"有 3 个死路"，用户得自己想出"哪三个"这个问题 —— 这个断层
  // 没理由留给他。**在 persist 之前定下来**，chips 才跟着这一轮一起落库。
  const followups = deps.settleFollowups(s, { modelQuestions: turn.nextQuestions, reply });
  // 人拍的板是最不该丢的一份状态，每轮都落。
  await deps.persist(s, { status: false, chatOwner });
  // 这一轮有没有动作被确认门挡住 —— 前端据此显示确认按钮。靠子串匹配确认门的
  // 拒绝语（tools.ts 里 requiresApproval 挡下时的固定措辞）：确认门是唯一产出
  // 这些字样的地方，约定稳定，比另开一条并行布尔信号更不容易走岔。
  const pending = turn.steps.filter((x) => {
    const obs = String(x["observation"] ?? "");
    return obs.includes("需要人工确认") || obs.includes("要用户确认");
  });
  return {
    intents: parse.toDict(),
    reply,
    needs_confirm: pending.length > 0,
    usd: pyRound(Number(s.state["_chat_usd"] ?? 0) || 0, 4),
    followups,
  };
}

/**
 * Python 的 `max(matches, key=lambda m: m.confidence)`。
 *
 * 两处细节不能省：**并列时取第一个**（JS 的 reduce 用 `>` 才有这个性质），
 * 以及**空列表抛异常**（Python 的 `max()` 抛 ValueError；真正的解析器至少会给
 * 一条 UNKNOWN，静默回一个假 match 只会把"解析器坏了"藏起来）。
 */
function pyMaxByConfidence(matches: readonly IntentMatchLike[]): IntentMatchLike {
  const first = matches[0];
  if (first === undefined) throw new Error("max() arg is an empty sequence");
  let best = first;
  for (const m of matches) if (m.confidence > best.confidence) best = m;
  return best;
}

/**
 * 判不出意图时反问。**不猜** —— 猜错一个 SET_SCOPE 会静默删掉一批对象。
 *
 * 返回类型写成联合是**照实翻译**：Python 那边的注解是 `-> str`，但 `adopt_which`
 * 之外的分支返回的是 `_outcome(...)` 这个 dict，调用方 `_act` 靠 `_as_outcome`
 * 两种都收。annotation 是错的，行为不是 —— 迁过来时按行为写。
 */
export function askBack(s: SessionLike, m: IntentMatchLike): string | Record<string, unknown> {
  const hint = m.slots["hint"];
  if (hint === "adopt_which") {
    const ss = listOf(s, "suggestions");
    const opts = ss
      .slice(0, 5)
      .map((x, i) => `${i + 1}. ${String(x["title"] ?? "")}`)
      .join("；");
    return opts ? `你是要采纳哪一条？现在有：${opts}` : "现在还没有建议可以采纳。";
  }
  return outcome(
    "not_understood",
    "这句我没把握理解成一个具体动作。你可以直接说：回答第几个问题、" +
      "采纳第几条建议、约定口径、排除哪些对象、或者让我解释某个判断。",
    {
      没听懂的原话: String(m.slots["phrase"] ?? m.span ?? ""),
      我能做的: [
        "回答某个待拍板的问题",
        "采纳/否决某条建议",
        "约定口径或命名",
        "排除某些对象",
        "解释某个判断的依据",
        "开始或重跑梳理",
      ],
      当前有几条建议: listOf(s, "suggestions").length,
      当前有几个待拍板: listOf(s, "questions").length,
    },
  );
}

// ══════════════════════════════════════════════════════════════════
//  措辞
// ══════════════════════════════════════════════════════════════════

/**
 * 措辞生成的产出契约。**只让模型措辞，不让它决定事实** —— 事实由执行器算好
 * 一并传进去，模型的任务是把它说成人话。
 */
export const SAY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["reply"],
  properties: {
    reply: {
      type: "string",
      description:
        "给 FDE 的回复。用给你的事实说话，**一个数字都不要改、" +
        "不要补充事实里没有的东西**。简短、像人说话、不要复述他的问题。",
    },
  },
};

export const SAY_SYSTEM = `你是 OntoCopilot 的对话侧，面对一位 FDE 工程师。

系统刚刚替他做了一件事，把结果告诉你。你的任务只有一个：**把这个结果说成人话**。

纪律：
- 事实以给你的为准。数字、名字、条数一个都不许改，也不许补充没给你的东西。
- 简短。他要的是"做了什么、接下来能干什么"，不是解释。
- 不要用"好的""收到""没问题"开头。直接说结果。
- 他没问的别答，别推销功能。`;

/**
 * 兼容：执行器可以返回结构化 outcome，也可以直接返回一句话。
 *
 * 逐个改造二十几个分支是可以的，但一次改完全部会让这次改动没法验证 ——
 * 先让两种形态都能走，再逐个把有价值的分支改成带事实的。
 */
export function asOutcome(r: unknown): Record<string, unknown> {
  if (r !== null && typeof r === "object" && !Array.isArray(r)) return r as Record<string, unknown>;
  return { kind: "text", facts: { 结果: String(r) }, fallback: String(r) };
}

/**
 * 把执行结果措辞成一句回复。
 *
 * 以前这里是二十几处写死的字符串。规则决定**做什么**是对的（可审计、免费、
 * 确定），但"这句话怎么说"是对话本身 —— 模板化的结果是一个明显在念稿子的
 * 副驾：问它"你好"，它回"在。"
 *
 * 事实和措辞分开的好处是双向的：数字不会被模型改掉，措辞不会被模板卡死。
 * 模型不可用时退回 `fallback` —— 说得难听点总比不说话强。
 */
export async function say(
  s: SessionLike,
  deps: DialogueDeps,
  oc: Record<string, unknown>,
  userText: string,
): Promise<string> {
  const fallback = pyTruthy(oc["fallback"]) ? String(oc["fallback"]) : "";
  if (pyTruthy(oc["verbatim"])) return fallback; // 有些回复必须一字不差（比如引用原文）
  deps.traceAux(s, "措辞", `把「${"kind" in oc ? String(oc["kind"]) : "结果"}」的事实说成人话`);
  try {
    const prompt =
      `## 他说的\n${userText}\n\n` +
      `## 系统做了什么（事实，照它说）\n` +
      `${pyJsonIndent(asRecord(oc["facts"]), 1)}\n\n` +
      `## 备用措辞（可参考，但你可以说得更好）\n${fallback}`;
    const comp = await deps.chatRun(
      s,
      { kind: "say", semanticInput: { prompt, lang: s.lang } },
      async (run) =>
        await run.gw.call("CHAT.say", prompt, {
          system: SAY_SYSTEM,
          difficulty: Difficulty.LOW,
          schema: SAY_SCHEMA,
          maxTokens: 600,
        }),
    );
    const said = String(asRecord(comp.data)["reply"] ?? "").trim();
    return said || fallback;
  } catch (exc) {
    // 措辞失败不该让整轮对话失败 —— 但**取消不是失败**，必须原样往上抛
    // （Python 那边 CancelledError 属于 BaseException，天然不被 except Exception 吞）。
    if (isCancelled(exc)) throw exc;
    return fallback;
  }
}

/** 执行器的返回形态：**事实 + 备用措辞**，不是一句成品。 */
export function outcome(
  kind: string,
  fallback: string,
  facts: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, facts, fallback };
}

// ══════════════════════════════════════════════════════════════════
//  路由挂载
// ══════════════════════════════════════════════════════════════════

/**
 * 把 `POST /api/sessions/{sid}/chat` 挂上去。
 *
 * **路径、方法、字段名一个字都不能改。** 前端是现成的。
 */
export function registerDialogueRoutes(
  deps: DialogueDeps,
  target: Hono<AppEnv> = sharedApp,
): void {
  target.post("/api/sessions/:sid/chat", async (c) => {
    const sid = c.req.param("sid");
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json(await chatRoute(sid, body, deps));
  });
}
