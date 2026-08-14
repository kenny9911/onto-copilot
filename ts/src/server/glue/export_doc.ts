/**
 * `_export_doc`（`server.py:3039`）—— `export.file` 工具背后那台组装机。
 *
 * 按 `source` 把"要导出的东西"组装成一份 {@link ExportDoc}，组不出来时返回
 * `(null, 回执)`。
 *
 * ── 为什么组不出来的时候要说清是**哪一步**没有东西 ──────────────────────
 *
 * 一句"导出失败"会让模型转头跟用户说"系统限制"，而真实原因往往是他还没列过表、
 * 或者还没跑梳理 —— 那是能补的。所以每条 error 都带一句「下一步」，而且带的是
 * 具体的工具名，不是"请稍后重试"。
 *
 * ── 屏幕上的行数与文件里的行数是两回事 ──────────────────────────────────
 *
 * `ui.table` 事件里的 `rows` 是**给屏幕看的**，封了顶；文件没有这个限制。所以
 * `last_table` 这一档按事件里记的来源配方 {@link fullRowsFor} 重算全量。补不回
 * 全量时**必须说出来**，标题里那个数字也不能留着骗人 —— 否则会导出一个叫
 * 「问题清单（900 行）.xlsx」、里面只有 500 行的文件，而 FDE 会把它当完整清单
 * 发给客户。
 */

import { pyJsonDumps } from "../../kernel/journal.js";
import type { DialogueMemory } from "../../kernel/memory/dialogue.js";
import type { ParserRegistry } from "../../onto/parse/base.js";
import {
  blocksFromMarkdown,
  makeBlock,
  makeExportDoc,
  tableBlock,
  type Block,
  type ExportDoc,
} from "../../onto/export.js";
import {
  OIR_COLS,
  conversationTables,
  fullRowsFor,
  oirTable,
  pickTable,
  pyStr,
  pyTruthy,
} from "../pipeline/tables.js";
import type { MarkdownBlockLike, SessionLike } from "../pipeline/types.js";
import { seam } from "./deps.js";
import { pyStrip } from "../../onto/canonical.js";
import { QuestionBacklog, type Question } from "../../onto/questions.js";
import type { Repo } from "../../store/repo/protocol.js";

/** `_export_doc` 要用到的外部世界。`serve.ts` 里绑一次。 */
export interface ExportDocDeps {
  readonly repo: () => Repo;
  /** `_dialogue(s)`（`server/dialogue/memory.ts` 的 `dialogueOf`）。 */
  readonly dialogue: (s: SessionLike) => DialogueMemory;
  /** `onto.parse.default_registry()` —— `_full_rows_for` 重读原始材料要它。 */
  readonly registry: () => ParserRegistry;
}

/**
 * 标题尾巴上那个「（900 行）」。
 *
 * Python 是 `re.sub(r"（[^（）]*\d+\s*[行条][^（）]*）\s*$", "", name)`。JS 的 `\d`
 * 只认 ASCII，而 Python 的 `\d` 对 str 模式认**全部** Unicode 十进制数字 ——
 * 所以这里写 `\p{Nd}` 加 `u` 标志，不是 `\d`。
 */
const TAIL_COUNT = /（[^（）]*\p{Nd}+\s*[行条][^（）]*）\s*$/u;

/** `int(x or y)`。 */
function pyIntOr(v: unknown, fallback: number): number {
  if (!pyTruthy(v)) return fallback;
  return Math.trunc(Number(v));
}

/**
 * 按 source 组装要导出的内容。返回 `[ExportDoc | null, 组不出来时的回执]`。
 */
export async function exportDoc(
  s: SessionLike,
  deps: ExportDocDeps,
  source: string,
  contains: string,
  title: string,
  tableName = "",
): Promise<[ExportDoc | null, Record<string, unknown>]> {
  // ── 统一问题台账 ────────────────────────────────────────────
  // 判据是 `source == "questions" and s.state.get("question_backlog")` —— 台账
  // 还没建起来时**要掉到下面 `_OIR_COLS` 那一档**（"questions" 也是 OIR 的一类），
  // 从本轮梳理的产物里导。少了后半个条件，新会话导问题清单会拿到一份空台账。
  if (source === "questions" && pyTruthy(s.state["question_backlog"])) {
    const backlog = questionBacklogOf(s);
    let items = [...backlog.values()];
    if (contains) {
      const needle = contains.toLowerCase();
      items = items.filter((q) => pyJsonDumps(q.toDict()).toLowerCase().includes(needle));
    }
    if (items.length === 0) return [null, { error: "统一问题台账里没有符合条件的问题。" }];
    const head = ["问题ID", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问"];
    const rows = items.map((q) => [
      q.id,
      q.text,
      String(q.status),
      String(q.priority),
      q.audienceRole,
      q.ownerUserId,
      q.why,
    ]);
    return [
      makeExportDoc({
        title: title || "待澄清问题",
        blocks: tableBlock(head, rows),
        note: `共 ${rows.length} 条，由统一 QuestionBacklog 导出`,
      }),
      {},
    ];
  }

  // ── 本轮梳理产物里的一类 ────────────────────────────────────
  if (Object.hasOwn(OIR_COLS, source)) {
    const oir = (s.state["oir"] as Record<string, unknown> | undefined) ?? {};
    if (!pyTruthy(oir[source])) {
      return [
        null,
        {
          error: `还没有 ${source} —— 梳理还没跑过或这一类是空的。`,
          下一步:
            "如果他要导的是**自己上传的表**，先用 material.rows " +
            "列出来，再用 source=last_table 导。",
        },
      ];
    }
    const [label, head, rows] = oirTable(oir, source, contains);
    if (rows.length === 0) {
      return [null, { error: `${label}里没有含「${contains}」的条目，导出会是空表。` }];
    }
    const name = title || (contains ? `${label}（含${contains}）` : label);
    return [
      makeExportDoc({
        title: name,
        blocks: tableBlock(head, rows),
        note: `共 ${rows.length} 条，由 OntoCopilot 从本次梳理产物导出`,
      }),
      {},
    ];
  }

  // ── 对话里出现过的某一张表 ──────────────────────────────────
  if (source === "last_table") {
    const tblOpts = {
      repo: deps.repo,
      dialogue: deps.dialogue,
      // `Block.rows` 是 `unknown[][]`，段 D 的 `MarkdownBlockLike.rows` 声明成
      // `string[][]` —— 运行时是同一份数组，只是两段各写了一份结构声明。
      blocksFromMarkdown: seam<(t: string) => readonly MarkdownBlockLike[]>(blocksFromMarkdown),
    };
    const tables = await conversationTables(s, tblOpts);
    const ev = pickTable(tables, tableName);
    if (ev === null && tableName) {
      // 点了名却找不到 —— **把有哪些告诉模型**，别让它默默导另一张给用户
      const titles = tables.map((r) => r["title"] ?? null).slice(-8);
      return [
        null,
        {
          error: `这段对话里没有叫「${tableName}」的表。`,
          现有的表: titles.length > 0 ? titles : "一张都没有",
          下一步: "用上面列出的名字之一重试；或者不传 name，导最后一张。",
        },
      ];
    }
    if (ev === null) {
      return [
        null,
        {
          error: "还没有列过表，没有「这个表」可导。",
          下一步:
            "先用 ui.table（产物）或 material.rows（上传的表）" + "把内容列给他看，再导出。",
        },
      ];
    }
    const head = [...((ev["columns"] as unknown[] | undefined) ?? [])].map(pyStr);
    const full = await fullRowsFor(s, deps.registry(), ev);
    let rows: string[][] =
      full !== null
        ? full
        : ((ev["rows"] as unknown[][] | undefined) ?? []).map((r) => [...r].map(pyStr));
    const partial = full === null && pyIntOr(ev["total"], rows.length) > rows.length;
    if (contains) {
      const k = contains.toLowerCase();
      rows = rows.filter((r) => r.map(pyStr).join(" ").toLowerCase().includes(k));
      if (rows.length === 0) return [null, { error: `这张表里没有含「${contains}」的行。` }];
    }
    let name = title || pyStr(pyTruthy(ev["title"]) ? ev["title"] : "清单");
    let note = `共 ${rows.length} 条，由 OntoCopilot 导出`;
    if (partial) {
      // 补不回全量时**必须说出来**，标题里那个数字也不能留着骗人。原标题结尾常有
      // 个「（900 行）」—— 那是屏幕上那张表的总数，直接换掉，别再追加一个括号
      // 变成「（900 行）（前 500 行）」。
      name = pyStrip(name.replace(TAIL_COUNT, ""));
      name = `${name}（前 ${rows.length} 行，原表 ${pyStr(ev["total"])} 行）`;
      note =
        `只含前 ${rows.length} 行，原表共 ${pyStr(ev["total"])} 行 —— ` +
        `重新读原始材料失败，这份**不是全量**。`;
    }
    const doc = makeExportDoc({ title: name, blocks: tableBlock(head, rows), note });
    return [doc, partial ? { 注意: note } : {}];
  }

  // **system 轮次不能一律丢掉。** DialogueMemory 每轮都 compactToFit()，超预算的
  // 旧轮次会被换成一条 Speaker.SYSTEM 的摘要（"（已压缩 N 轮）…"）—— 那是那些轮次
  // 仅存的记录。过滤掉它，导出的"整段对话"就从中间开始，而且还宣称自己是全部。
  const rawTurns = deps.dialogue(s).turns;
  const turns = rawTurns.filter((t) => String(t.speaker) !== "system");

  if (source === "last_answer") {
    const answer = [...turns].reverse().find((t) => String(t.speaker) === "assistant") ?? null;
    if (answer === null) return [null, { error: "这轮之前还没有过回答，没有「刚才那段」可导。" }];
    return [
      makeExportDoc({
        title: title || "OntoCopilot 回答",
        blocks: blocksFromMarkdown(answer.text),
        note: "由 OntoCopilot 导出",
      }),
      {},
    ];
  }

  if (source === "conversation") {
    if (rawTurns.length === 0) return [null, { error: "这个会话还没有对话内容。" }];
    const blocks: Block[] = [];
    let compacted = 0;
    for (const t of rawTurns) {
      const sp = String(t.speaker);
      if (sp === "system") {
        compacted += 1;
        blocks.push(makeBlock("heading", { text: "（早前对话摘要）", level: 2 }));
      } else {
        blocks.push(
          makeBlock("heading", { text: sp === "user" ? "FDE" : "OntoCopilot", level: 2 }),
        );
      }
      blocks.push(...blocksFromMarkdown(t.text));
    }
    let note = `共 ${turns.length} 轮，由 OntoCopilot 导出`;
    if (compacted > 0) {
      note += `；更早的轮次已被压缩成 ${compacted} 条摘要，原文不再保留`;
    }
    return [makeExportDoc({ title: title || s.title || "对话记录", blocks, note }), {}];
  }

  return [null, { error: `不认识的 source「${source}」。` }];
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/**
 * `_question_backlog(s)`（`server.py:3291`）。
 *
 * 不 import `routes/questions.ts` 那一份：它收的是段 G 的具体 `Session` 类，而
 * 这里拿到的是 `SessionLike`。反序列化本来就全在 `QuestionBacklog.fromDict` 里，
 * 这一句只是把状态取出来喂给它 —— 两处走的是同一个反序列化实现，不会漂开。
 */
function questionBacklogOf(s: SessionLike): Map<string, Question> {
  const raw = s.state["question_backlog"];
  const doc = (pyTruthy(raw) ? raw : { questions: [] }) as Record<string, unknown>;
  return QuestionBacklog.fromDict(doc).questions;
}
