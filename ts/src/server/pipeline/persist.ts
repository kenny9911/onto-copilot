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
import { syncAssetMemory } from "../asset_memory.js";
import { filterProjectDocumentChunks } from "../glue/document_projection.js";

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
  "engagement_run_id", "engagement_execution", "engagement_analysis", "release_state",
  // 无材料通用草案的来源边界。没有这两项，重启后同一批无证据断言会退化成
  // 普通 inferred，UI/后续编辑都无法再区分“通用假设”和“材料推断”。
  "draft_provenance", "flow_provenance",
  // 导出台账（P3 产物迭代）：文件名 → 生成时的 artifact_revision。丢了它，
  // 重启后所有导出卡都答不上「这份是基于第几版」。
  "export_meta",
  // 上一轮的追问 chips。落库是因为它是**会话的一部分**：重开会话时
  // "接下来能问什么"必须还在，而不是让人对着一段旧对话重新想。
  "followups",
  // 公开网页检索签发的来源登记。`web.read` 只收 source_id；跨重启仍要能用同一个
  // 编号回到当时那条 URL，而不是逼模型重新搜索后猜一个新编号。
  "web_sources",
  // 网页工作台的 reader snapshots。只保存经过 SSRF/content-type/大小门禁后的纯文本
  // 段落与引用；绝不保存或回放第三方脚本。pageId + digest 也是翻译/总结的 basedOn。
  "web_pages",
  // 与具体 pageId+digest 绑定的网页翻译/AI 总结。Recorder 是付费效果重放账本，
  // 不是用户可发现的记忆；这份投影让刷新/重启后仍能打开已经生成的分析。
  "web_analyses",
  // 改动记忆。会话记「做过什么、依据是什么」，重启后必须还在 ——
  // 它是 md 记忆文档和 memory.recall 的数据源，丢了等于这个会话失忆。
  "memory_log",
  // 材料、图片、问题、导出件和外部素材的统一可检索目录。文件正文仍在原权威位置，
  // 这里保存稳定 id、不可变快照、版本、来源与别名；缺它重启后“刚才那张图”就失忆。
  "asset_memory",
  // 参考图快照（B11）。三处代码按"它落了库"写（重画守卫读它、draft.adopt 从
  // 它转正、右栏预览它），但它从来不在任何白名单里 —— 重载会话参考图整个消失，
  // 用户对着"刚才画过了"的守卫却看不到那张图。`_sketch` 活对象不存，
  // hydrate 时从这份快照的 graph 重建。
  "sketch",
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
  // 与 _oir_versions 并行的「这版带不带补丁」标记 —— 两者必须一起存一起截，
  // 只存一半的话重启后 undo 又会回到"无条件弹补丁"的老行为。
  "_oir_version_patched",
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
  // 当前会话钉住的 OntoDocument 精确版本。正文与完整 ParsedDoc 在文档库里，
  // 这里只持久化轻量 manifest，供严格证据模式、Run 指纹和界面恢复使用。
  "_document_manifest",
  // durable mutation queue：chat 侧写入、Run 收尾时消费 —— 放在这一组正合适：
  // 它就是「chat 拥有、要与 build checkpoint 做 CAS 合并」的文档。
  "_mutation_queue",
  // 跑中排队的人工拍板：同理 —— 一次确认排了队，重启后必须还在，否则用户的
  // 拍板会随进程一起消失（glue/decisions_queue.ts）。
  "_decision_queue",
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
  "web_sources",
  "web_pages",
  "web_analyses",
  // 这是 build/chat 共同派生的并集。CAS 冲突时 build 宁可丢掉自己的旧投影（文件与
  // durable event 仍在，下次 sync 会补），也不能覆盖另一 worker 刚登记的新图片/材料。
  "asset_memory",
  // document.attach/detach 可以从对话侧发生，CAS 合并时不能被并发 build 的旧投影覆盖。
  "_document_manifest",
]);

/** 值得跨重启留下来的事件类型 —— 判据是「里面装的是内容，不是进度」。 */
export const CARD_EVENT_KINDS: readonly string[] = ["ui.table", "export.ready", "web.sources"];
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
    // 在收集 docs 之前，把这一节点已经写成的文件/问题/素材登记到统一资产记忆，并为
    // 可覆盖文件保存不可变快照。失败必须和其它 checkpoint 失败一样 fail closed。
    syncAssetMemory(s);
    let docs: Record<string, JsonValue> = {};
    for (const k of PERSISTED) {
      if (k in s.state) docs[k] = s.state[k] as JsonValue;
    }
    // 私有的版本/补丁栈也落，顺手把内存态也封顶。
    //
    // **空数组也要写。** 判据是 `!== undefined`，不是 `length > 0` ——
    // repo 的 writeDocs / mergeDocs 都是**逐键 upsert，缺键不删旧值**
    // （pg.ts 的 onConflictDoUpdate、memory.ts 的 mergeDocs）。撤销把栈 pop 成
    // `[]` 之后，如果这里因为"空就不写"而跳过，库里仍然留着撤销前的那条补丁；
    // 下一次 hydrate 或 refreshChatProjection 把它载回内存，重跑时
    // `replayOirPatches` 就把这条**用户明确撤销掉的改动**重新贴到新抽取结果上，
    // 出现在交付产物里，而且全程没有任何事件说过它回来了。
    //
    // 同一个仓库的 glue/flow.ts 有一条注释专门写着「不能 delete：repo 的 state
    // 文档是 merge/upsert，缺键不会删除旧值」—— 那条纪律在这里漏了一处。
    for (const k of PERSISTED_PRIVATE) {
      const stack = s.state[k] as unknown[] | undefined;
      if (stack !== undefined) {
        s.state[k] = stack.slice(-VERSION_STACK_CAP);
        docs[k] = s.state[k] as JsonValue;
      }
    }
    for (const k of PERSISTED_PRIVATE_DOCS) {
      // 整体存，不截断。同样不能用 truthy —— 清空后的 `[]`/`{}` 是假值，
      // 跳过就等于把"已经清空"这件事瞒下来，库里那份旧的照旧生效。
      const doc = s.state[k];
      if (doc !== undefined && doc !== null) {
        // OntoDocument 正文由不可变版本库持有；Session 只保存 manifest。把项目切片
        // 再存进 `_chunks` 会让撤权前正文在 hydrate 时复活。临时附件/OCR 仍照常存。
        docs[k] = (k === "_chunks" ? filterProjectDocumentChunks(doc) : doc) as JsonValue;
      }
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
