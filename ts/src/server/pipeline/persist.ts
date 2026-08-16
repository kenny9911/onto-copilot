/**
 * 检查点 —— `server.py` 2676–2717（持久化白名单）+ 3152–3288（`_push_version` / `_persist`）。
 *
 * **在每个节点边界调用 `persist`。** 只在最后写一次的后果是：跑到一半崩了，
 * 前面几分钟和几美元全白花，而磁盘上什么都没有。节点边界是天然的检查点 ——
 * 那正是 Recorder 记 `NODE_COMPLETED` 的地方。
 */

import { HTTPException } from "hono/http-exception";

import type { JsonObject, JsonValue } from "../../store/types.js";
import type { Repo } from "../../store/repo/protocol.js";
import { RunCancelled, isCancelled } from "./types.js";
import type { SessionLike } from "./types.js";
import { conflictToDict, type Conflict } from "../../onto/conflict.js";

// ══════════════════════════════════════════════════════════════════
//  白名单
// ══════════════════════════════════════════════════════════════════

/**
 * 会持久化的公开状态 key。私有（`_` 开头）的一律不存 —— 它们要么是活对象
 * （OIR、证据索引），要么是能重算的（列画像），存了反而制造第二份真相。
 */
export const PERSISTED: readonly string[] = [
  "oir", "flow", "template", "artifacts", "questions", "question_backlog",
  "decision_ledger", "suggestions", "corpus", "budget", "routing", "answered", "audit",
  "mode", "model", "artifact_revision", "ontology_package",
  "engagement_run_id", "engagement_execution", "release_state",
  // 上一轮的追问 chips。落库是因为它是**会话的一部分**：重开会话时
  // "接下来能问什么"必须还在，而不是让人对着一段旧对话重新想。
  "followups",
];

/**
 * 私有的版本/补丁栈也要落库 —— 它们是「撤销历史」和「重跑时要重放的人工补丁」，
 * 恰恰是最不该随重启丢掉的一份状态（`_flow_versions`/`_tpl_versions` 以前只在内存，
 * 重启后 undo 历史全没）。都是 `_` 前缀，`/state` 路由照旧剥离、不外泄；也不在
 * DERIVED_KEYS 里，所以以 derived=false 存、hydrate 时原样载回。
 */
export const PERSISTED_PRIVATE: readonly string[] = [
  "_flow_versions", "_tpl_versions", "_oir_versions",
  "_flow_patch_log", "_tpl_patch_log", "_oir_patch_log",
];

/** 单栈封顶，防一个长命进程每编辑一次就把栈顶到天上。撤销深度 20 够用。 */
export const VERSION_STACK_CAP = 20;

/**
 * 私有的**非栈**状态：整体存、不做尾部截断（上面那圈 `stack[-CAP:]` 是给列表用的，
 * 套在 dict 上会直接 TypeError）。
 *
 * `_chunks` 必须在这里：`store/const.py` 把它排除在 DERIVED_KEYS 之外，理由写得
 * 很清楚 —— 扫描件重建要再花一次视觉模型的钱，而且 OCR 结果可能和当初抽取时不一样，
 * 那样"点回原文"看到的就不是系统真正读过的东西。但它从来没被写进任何持久化白名单，
 * 于是**每次重启，付费 OCR 出来的切片全丢**，`/source` 对一份已经识别过的材料回
 * "尚未解析"。这就是那条注释描述的后果本身。
 * `_cards` 同理：事件流是进程内的，但其中**承载内容**的那几条（AI 列出来的表、
 * 导出的文件）重开会话必须还在，否则用户以为东西丢了。见 `Session.emit`。
 */
export const PERSISTED_PRIVATE_DOCS: readonly string[] = [
  "_chunks", "_cards", "_tables", "_pending_actions", "_pending_action",
  "_last_reason", "_chat_usd",
];

/**
 * Chat reasoning always owns these documents.  Keeping the set explicit lets an
 * optimistic-CAS retry merge a turn over a simultaneous build checkpoint without
 * resubmitting stale OIR/flow, and lets build retry without erasing that turn.
 */
export const CHAT_OWNED_DOCS: ReadonlySet<string> = new Set([
  "dialogue", "_pending_actions", "_pending_action", "_last_reason", "_chat_usd",
  // 这一轮的 chips 跟着这一轮的回答走，和 dialogue 同属对话侧 —— 并发的梳理
  // checkpoint 不该把它们盖掉，也不该被它们盖掉。
  "followups",
]);

/** 值得跨重启留下来的事件类型 —— 判据是「里面装的是内容，不是进度」。 */
export const CARD_EVENT_KINDS: readonly string[] = ["ui.table", "export.ready"];
/** 留最近几条就够。一张 192 行的表 JSON 就有几十 KB，不封顶会把状态文档撑爆。 */
export const CARD_EVENT_CAP = 12;

// ══════════════════════════════════════════════════════════════════
//  版本栈
// ══════════════════════════════════════════════════════════════════

/**
 * 把一个「编辑前」快照压进版本栈并就地封顶，返回该栈（**活列表**）。
 *
 * 调用方在编辑失败时还要 `pop()` 掉刚压的这个，所以返回的必须是同一个数组。
 */
export function pushVersion(
  s: SessionLike,
  key: string,
  snap: Record<string, unknown>,
): unknown[] {
  if (!(key in s.state)) s.state[key] = [];
  const v = s.state[key] as unknown[];
  v.push(snap);
  if (v.length > VERSION_STACK_CAP) v.splice(0, v.length - VERSION_STACK_CAP);
  return v;
}

// ══════════════════════════════════════════════════════════════════
//  检查点
// ══════════════════════════════════════════════════════════════════

/** `_persist` 的关键字参数。Python 的默认值逐个照抄。 */
export interface PersistOptions {
  /** 无租约路径下是否顺手写一次状态列。Python 默认 True。 */
  readonly status?: boolean;
  readonly leaseOwner?: string;
  readonly chatOwner?: string;
  /** `None` = 全部 docs；给出集合则只提交这几个键。 */
  readonly docsOnly?: ReadonlySet<string> | null;
}

/** `_persist` 要用的那部分外部世界。 */
export interface PersistDeps {
  readonly repo: () => Repo;
  readonly now: () => number;
  /** `_persist_decisions`（server.py:3338）。 */
  readonly persistDecisions: (s: SessionLike, dm: unknown) => Promise<void>;
}

/** `dm.to_dict()`。 */
interface DialogueDoc {
  toDict(): Record<string, unknown>;
}

/** `_conflicts` 里那些对象的 `to_dict()`。 */
interface HasToDict {
  toDict(): Record<string, unknown>;
}

/**
 * 把会话当前状态写进库。**在每个节点边界调用。**
 *
 * 持久化失败必须上抛。继续生成一份无法恢复、审计链已断裂的"成功"产物，比明确
 * 失败更危险；调用边界会把异常转换成 failed Run 或 HTTP 失败，用户不会误以为
 * 已经保存。发出的 `persist.failed` 事件只用于诊断，不会吞掉原异常。
 */
export async function persist(
  s: SessionLike,
  deps: PersistDeps,
  opts: PersistOptions = {},
): Promise<void> {
  const status = opts.status ?? true;
  const leaseOwner = opts.leaseOwner ?? "";
  const chatOwner = opts.chatOwner ?? "";
  const docsOnly = opts.docsOnly ?? null;
  const repo = deps.repo();
  let dm: DialogueDoc | null = null;
  try {
    let docs: Record<string, JsonValue> = {};
    for (const k of PERSISTED) {
      if (k in s.state) docs[k] = s.state[k] as JsonValue;
    }
    // 私有的版本/补丁栈也落，顺手把内存态也封顶
    for (const k of PERSISTED_PRIVATE) {
      const stack = s.state[k] as unknown[] | undefined;
      if (stack !== undefined && stack.length > 0) {
        s.state[k] = stack.slice(-VERSION_STACK_CAP);
        docs[k] = s.state[k] as JsonValue;
      }
    }
    for (const k of PERSISTED_PRIVATE_DOCS) {
      // 整体存，不截断
      const doc = s.state[k];
      if (truthy(doc)) docs[k] = doc as JsonValue;
    }
    dm = (s.state["_dialogue"] as DialogueDoc | undefined) ?? null;
    if (dm !== null) {
      // Dialogue and every domain edit from the turn are one projection commit.
      // Saving dialogue in a second transaction lets a new worker slip between
      // them and observe a half turn (or have the old worker overwrite it).
      docs["dialogue"] = dm.toDict() as JsonValue;
    }
    if (docsOnly !== null) {
      docs = Object.fromEntries(Object.entries(docs).filter(([k]) => docsOnly.has(k)));
    }
    // `s.state["_conflicts"]` 存的是 `onto/conflict.ts` 的 `Conflict` —— **纯数据，
    // 没有 toDict() 方法**（约定 §1）。这里原本按 `HasToDict` 读再调 `.toDict()`，
    // 与 run.ts 那两处是同一个 bug：类型上说得通、真跑就是
    // `TypeError: c.toDict is not a function`。
    const conflicts = ((s.state["_conflicts"] as Conflict[] | undefined) ?? []).map((c) =>
      conflictToDict(c),
    ) as JsonObject[];
    const persistConflicts =
      docsOnly === null ||
      ["questions", "question_backlog", "oir"].some((k) => docsOnly.has(k));
    // `q["conflict_rid"]` —— Python 是直接下标，缺键就是 KeyError。照搬：
    // 一条没有 conflict_rid 的澄清问题混进 `questions` 是数据损坏，不该静默跳过。
    const askedRids = ((s.state["questions"] as Record<string, unknown>[] | undefined) ?? []).map(
      (q) => {
        if (!("conflict_rid" in q)) throw new Error("KeyError: 'conflict_rid'");
        return String(q["conflict_rid"]);
      },
    );
    const mutationOwner = s.mutationLeaseOwner;
    if (leaseOwner && (chatOwner || mutationOwner)) {
      throw new Error("build lease 和 chat lease 不能同时提交同一 checkpoint");
    }
    const conflictArg = persistConflicts ? (conflicts.length > 0 ? conflicts : null) : null;
    let version: number | null;
    if (mutationOwner) {
      version = await repo.saveMutationState(s.id, docs, {
        owner: mutationOwner,
        now: deps.now(),
        status: s.status,
        error: s.error,
        conflicts: conflictArg,
        askedRids,
        chatOwner,
        expectedVersion: s.stateVersion,
      });
      if (version === null) {
        throw new HTTPException(409, { message: "领域修改租约已失效或会话已更新；未覆盖最新状态。" });
      }
    } else if (leaseOwner) {
      version = await repo.saveBuildState(s.id, docs, {
        owner: leaseOwner,
        now: deps.now(),
        status: s.status,
        error: s.error,
        conflicts: conflictArg,
        askedRids,
        expectedVersion: s.stateVersion,
      });
      if (version === null) {
        // The build owner can stay alive while another worker adds a dialogue
        // turn.  Retry once without the chat-owned documents: build never owns
        // dialogue/chat spend, so dropping them is a lossless merge.
        const buildDocs = Object.fromEntries(
          Object.entries(docs).filter(([k]) => !CHAT_OWNED_DOCS.has(k)),
        );
        const row = await repo.getSession(s.id);
        if (row !== null) {
          version = await repo.saveBuildState(s.id, buildDocs, {
            owner: leaseOwner,
            now: deps.now(),
            status: s.status,
            error: s.error,
            conflicts: conflictArg,
            askedRids,
            expectedVersion: row.state_version,
          });
        }
      }
      if (version === null) throw new RunCancelled();
    } else if (chatOwner) {
      version = await repo.saveChatState(s.id, docs, {
        owner: chatOwner,
        now: deps.now(),
        conflicts: conflictArg,
        askedRids,
        expectedVersion: s.stateVersion,
      });
      if (version === null) {
        // A build/question/audit mutation won after this chat refreshed.
        // Chat-only state is disjoint, so merge just those keys on top of the
        // new version instead of replaying paid reasoning or stale OIR/flow.
        const chatDocs = Object.fromEntries(
          Object.entries(docs).filter(([k]) => CHAT_OWNED_DOCS.has(k)),
        );
        const row = await repo.getSession(s.id);
        if (row !== null) {
          version = await repo.saveChatState(s.id, chatDocs, {
            owner: chatOwner,
            now: deps.now(),
            conflicts: null,
            askedRids: [],
            expectedVersion: row.state_version,
          });
        }
      }
      if (version === null) throw new RunCancelled();
    } else {
      if (status) await repo.setStatus(s.id, s.status, { error: s.error });
      version = await repo.saveState(s.id, docs, {
        conflicts: conflictArg,
        askedRids,
        expectedVersion: s.stateVersion,
      });
      if (version === null) {
        throw new HTTPException(409, {
          message: "会话已在另一工作进程更新；请刷新后重试，未覆盖对方改动。",
        });
      }
    }
    s.stateVersion = version;
    if (dm !== null) await deps.persistDecisions(s, dm);
  } catch (exc) {
    // Python 的 `except Exception` **接不到** CancelledError（它是 BaseException），
    // 所以取消路径上没有 persist.failed 事件。JS 没有这一层，必须显式放它过去 ——
    // 否则每一次用户点停止都会多出一条"持久化失败"的假告警。
    if (isCancelled(exc)) throw exc;
    const name = exc instanceof Error ? exc.name : typeof exc;
    const msg = exc instanceof Error ? exc.message : String(exc);
    s.emit("persist.failed", { error: `${name}: ${msg}` });
    throw exc;
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}
