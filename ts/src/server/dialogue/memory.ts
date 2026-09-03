/**
 * 对话记忆的取用与投影 —— `server.py` 的 `_dialogue` / `_publish_turn` /
 * `_remember_tables`（4515–4581）。
 *
 * 单独一个文件而不是塞进 dialogue.ts：`tools.ts` 里的 `session.status` 与
 * `decision.record` 都要 `_dialogue(s)`，而 dialogue.ts 又要 import tools.ts ——
 * ESM 的循环 import 里具名导出在求值期是 `undefined`，症状是运行时"函数不是函数"，
 * 而且只在某一个 import 顺序下复现。拆开是最省事的解法。
 */

import { DialogueMemory, Speaker } from "../../kernel/memory/dialogue.js";

import type { DialogueDeps, SessionLike } from "./ports.js";
import { pyRound, tailSlice } from "./pyutil.js";

/**
 * 取会话的对话记忆，没有就建。
 *
 * 放在 `_dialogue` 这个私有 key 下而不是 `state` 的公开部分 —— 它有自己的
 * 序列化形态（toDict），直接丢进 state 会被 /state 原样吐出去，把整份对话历史
 * 塞进每一次状态轮询。
 */
export function dialogueOf(s: SessionLike): DialogueMemory {
  let dm = s.state["_dialogue"];
  if (dm === null || dm === undefined) {
    dm = new DialogueMemory();
    s.state["_dialogue"] = dm;
  }
  return dm as DialogueMemory;
}

// ══════════════════════════════════════════════════════════════════
//  改动记忆
// ══════════════════════════════════════════════════════════════════

/**
 * 一条「这个会话做过什么」的记忆。
 *
 * **为什么不复用 Decision**：`DecisionKind` 只有六档、且顺序被 golden 钉死
 * （与 Python 逐字节对齐），塞不下"凭通识补的"这一类；而这一类恰恰是真实库里
 * 的全部 —— 实测 11 个会话，`dialogue.decisions` **全是 0**，其中三个明明有
 * `_oir_patch_log`（真发生过编辑）。原因是编辑那段的决定记录写在 `else` 分支里，
 * `source === "generic_assumption"` 直接跳过，而无材料草案路径上的每一次编辑
 * 都是这个 source。于是**整条无材料工作流不留任何记忆**。
 *
 * **为什么不复用 patch log**：那是给重放用的机器格式（op + args），
 * 回答不了「为什么这么改」「这条能不能信」。人和模型要读的是这一份。
 *
 * `basis` 是这份记忆最值钱的一列：真实库里 100% 的断言都是 `inferred`，
 * 把「人拍板的」和「凭通识猜的」混在一起记，等于没记。
 */
export interface MemoryEntry {
  /** 递增序号，会话内唯一；用它排序而不是时钟（时钟会破坏 recorder 重放）。 */
  readonly seq: number;
  /** edit｜adopt｜answer｜draft｜canvas */
  readonly kind: string;
  /** 人话：改了什么。这一条会原样进 md 记忆文档和模型上下文。 */
  readonly what: string;
  /** user=人明说的｜generic_assumption=凭通识补的｜material=材料里读到的 */
  readonly basis: string;
  /** 涉及的对象/流程/问题 rid，给「改这个会影响谁」用。 */
  readonly refs: readonly string[];
  /** 哪个工具写的，出问题时能顺着查。 */
  readonly tool: string;
}

/** 封顶。一条几十字节，500 条够覆盖一个长会话，超了丢最老的。 */
export const MEMORY_LOG_CAP = 500;

/** 取改动记忆（落在公开 state 上 —— 右栏和导出都要读它，不像 `_dialogue` 那样藏着）。 */
export function memoryLog(s: SessionLike): MemoryEntry[] {
  const cur = s.state["memory_log"];
  if (!Array.isArray(cur)) {
    const fresh: MemoryEntry[] = [];
    s.state["memory_log"] = fresh;
    return fresh;
  }
  return cur as MemoryEntry[];
}

/**
 * 记一条改动。
 *
 * **不判断值不值得记 —— 改了就记。** 判断"这条重不重要"是下游（导出、召回）
 * 的事；在写入侧筛，就会重蹈"generic_assumption 直接跳过"的覆辙。
 */
export function rememberChange(
  s: SessionLike,
  entry: { kind: string; what: string; basis?: string; refs?: readonly string[]; tool?: string },
): MemoryEntry {
  const log = memoryLog(s);
  const row: MemoryEntry = {
    seq: log.length > 0 ? Number(log[log.length - 1]!.seq) + 1 : 1,
    kind: entry.kind,
    what: entry.what,
    basis: entry.basis ?? "user",
    refs: [...(entry.refs ?? [])].filter(Boolean),
    tool: entry.tool ?? "",
  };
  log.push(row);
  if (log.length > MEMORY_LOG_CAP) log.splice(0, log.length - MEMORY_LOG_CAP);
  return row;
}

/** 记多少张表。一张表几十 KB，封顶防止长会话把状态文档撑爆；超了丢最老的。 */
export const TABLE_MEMORY_CAP = 24;

/** 把一条回答里产出的表格存进会话记忆，按标题去重（同名的以新的为准）。 */
export function rememberTables(
  s: SessionLike,
  deps: DialogueDeps,
  text: string,
  ts: number,
): void {
  const fresh = deps.tablesInText(text, ts);
  if (fresh.length === 0) return;
  const prev = s.state["_tables"];
  let kept: Record<string, unknown>[] = Array.isArray(prev)
    ? [...(prev as Record<string, unknown>[])]
    : [];
  for (const rec of fresh) {
    kept = kept.filter((x) => x["title"] !== rec["title"]);
    kept.push(rec);
  }
  s.state["_tables"] = tailSlice(kept, TABLE_MEMORY_CAP);
}

/**
 * 写进对话记忆并投影成 SSE 事件，返回这条 `chat.turn` 的事件 projection。
 *
 * 两件事必须一起做：只写记忆前端看不见，只发事件刷新页面就没了。返回的是
 * projection 而不是临时序号 —— 需要权威 seq 的调用方可以 `waitSeq` 它。
 */
export function publishTurn(
  s: SessionLike,
  deps: DialogueDeps,
  speaker: Speaker,
  text: string,
  opts: { intent?: string; confidence?: number; refs?: string[] | null } = {},
): Record<string, unknown> {
  const dm = dialogueOf(s);
  const u = dm.say(speaker, text, { intent: opts.intent ?? "", refs: opts.refs ?? [] });
  // **压缩之前先把这一轮产出的表记下来。** compactToFit 会把最老的几轮合并成
  // 一句摘要，原文就没了 —— 而用户过两轮回头说"把刚才那张 AI 招聘表导出来"时，
  // 需要的正是原文。事件表里也有一份，但那要靠库；这份索引跟着会话状态走，
  // 库不可用、或者历史遗留会话，一样找得到。
  if (speaker === Speaker.ASSISTANT) rememberTables(s, deps, text, u.ts || deps.now());
  dm.compactToFit();
  return s.emit("chat.turn", {
    turn: { ...u.toDict(), confidence: pyRound(opts.confidence ?? 1.0, 2) },
  });
}
