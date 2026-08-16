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
