/**
 * `_pending_questions`（`server.py:3296`）与 `_sync_question_backlog`（3302）。
 *
 * 这两个是问题清单**写侧**的入口，被 `_recompile` / `_compile` / hydrate 调用。
 * 读侧（`_question_backlog` / `_question_payload` / `_write_question_exports` /
 * `_answer_domain_question` …）住在 `server/routes/questions.ts`，那是另一条
 * track 的文件 —— **直接复用，不在这里再写一份**：两份导出逻辑一旦漂开，症状是
 * "界面上问题答完了、导出的清单里还在"，而没有任何东西会报错。
 */

import { buildQuestionBacklog, QuestionBacklog } from "../../onto/questions.js";
import type { Question } from "../../onto/questions.js";
import { QuestionStatus } from "../../onto/questions.js";
import type { OIR } from "../../onto/oir.js";
import { questionRowFromDomain } from "../../store/types.js";
import { questionBacklog, writeQuestionExports } from "../routes/questions.js";
import type { Session } from "../session.js";
import type { GlueDeps } from "./deps.js";

const PENDING_STATUSES: ReadonlySet<string> = new Set([
  QuestionStatus.OPEN,
  QuestionStatus.ASSIGNED,
  QuestionStatus.BLOCKED,
]);

/** `_pending_questions`（`server.py:3296`）。 */
export function pendingQuestions(s: Session): Question[] {
  return [...questionBacklog(s).questions.values()].filter((q) => PENDING_STATUSES.has(q.status));
}

export interface SyncBacklogOptions {
  readonly oir?: OIR | null;
  readonly clarification?: readonly unknown[] | null;
  readonly conflicts?: readonly unknown[] | null;
  readonly preserveRepoLifecycle?: boolean;
}

/**
 * 把 OIR 问题与 conflict cards 合到唯一 Backlog，并同时写 repo/state/文件。
 *
 * 三处必须一起更新：仓储的 `question` 表（权威，多 worker 都在写）、
 * `s.state["question_backlog"]`（本进程的渲染缓存）、盘上那三份问题清单
 * （下载路由直接吐这三份字节）。少更新任何一处都不会报错。
 */
export async function syncQuestionBacklog(
  s: Session,
  deps: GlueDeps,
  opts: SyncBacklogOptions = {},
): Promise<QuestionBacklog> {
  const preserve = opts.preserveRepoLifecycle ?? false;
  // Python：`None if preserve_repo_lifecycle else s.state.get("question_backlog")`。
  // 注意是 `is None` 判定，不是真值 —— 一份空 backlog 文档也算"有"。
  let existing: unknown = preserve ? null : (s.state["question_backlog"] ?? null);
  let authoritativeExisting: QuestionBacklog | null = null;
  if (existing === null) {
    const rows = await deps.repo().listQuestions(s.id);
    if (rows.length > 0) {
      existing = { questions: rows.map((r) => r.doc) };
      authoritativeExisting = QuestionBacklog.fromDict(existing as Record<string, unknown>);
    }
  }
  const oir = (opts.oir ?? (s.state["_oir"] as OIR | undefined) ?? null) as OIR | null;
  const backlog = buildQuestionBacklog({
    openQuestions: oir !== null ? [...oir.questions.values()] : [],
    clarificationQuestions:
      firstNonEmpty(opts.clarification, s.state["questions"]) ?? [],
    conflicts: firstNonEmpty(opts.conflicts, s.state["_conflicts"]) ?? [],
    existing: existing as Record<string, unknown> | null,
  });
  if (authoritativeExisting !== null) {
    // build_question_backlog refreshes descriptive/source fields.  Priority and
    // blocked-artifact classification, however, are durable workflow controls;
    // an OIR OpenQuestion projection must not downgrade a manually promoted
    // release blocker back to normal during deterministic finish().
    for (const [qid, old] of authoritativeExisting.questions) {
      const current = backlog.questions.get(qid);
      if (current !== undefined) {
        current.priority = old.priority;
        current.blockedArtifacts = [...old.blockedArtifacts];
        current.dependencies = [...old.dependencies];
        current.metadata = { ...old.metadata };
      }
    }
  }
  s.state["question_backlog"] = backlog.toDict();
  await deps
    .repo()
    .upsertQuestions(s.id, [...backlog.questions.values()].map((q) => questionRow(q)));
  await writeQuestionExports(s, backlog);
  return backlog;
}

/**
 * `QuestionRow.from_domain(q)`。
 *
 * 只是一层 cast：`Question.toDict()` 声明的是 `Record<string, unknown>`，而
 * `store/types.ts` 的 `HasToDict` 要 `JsonObject`。**值**完全一样（那个 dict 本来
 * 就要 JSON 化落库），只是 TS 不认前者能赋给后者。
 */
function questionRow(q: Question) {
  return questionRowFromDomain(q as unknown as Parameters<typeof questionRowFromDomain>[0]);
}

/** Python 的 `a or b or ()` —— 按**真值**回退（空序列算假）。 */
function firstNonEmpty(a: unknown, b: unknown): readonly unknown[] | null {
  for (const v of [a, b]) {
    if (Array.isArray(v)) {
      if (v.length > 0) return v as readonly unknown[];
      continue;
    }
    if (v !== null && v !== undefined && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function") {
      const arr = [...(v as Iterable<unknown>)];
      if (arr.length > 0) return arr;
    }
  }
  return null;
}
