/**
 * `_chat_run`（`server.py:572`）—— 对话侧每一次 Recorder 生产者外面的那层壳。
 *
 * `finish_run` 住在这里，是为了让**正常完成、异常、取消**三条路不会在
 * `_reason`、确认、措辞、推荐这四个调用点之间漂开。后端也一定会关掉。
 *
 * ── Python 是 `@asynccontextmanager`，这里是回调 ────────────────────
 *
 * JS 没有 `async with`。写成 `chatRun(s, opts, async run => …)`：`try/finally`
 * 的位置由这个函数负责，调用方不可能漏掉收尾。反过来（返回一个 `{run, close}`）
 * 的话，任何一条提前 return 的分支都会漏掉 `backend.aclose()`，而症状是
 * "跑久了之后连接池耗尽"，离现场很远。
 *
 * ── 取消：Node 上没有 `CancelledError`（约定 §2.2）────────────────────
 *
 * Python 那边分三个分支：`CancelledError` 记 `error="cancelled"`、其它异常记
 * 类型名+消息、正常完成记 `run.status`。`_finish_chat_repo_run` 还要用
 * `asyncio.shield` 把最后那次写库从调用方的取消里保出来。
 *
 * TS 侧只剩两个分支：抛了就是失败，没抛就是完成。`RunCancelled`（协作式取消的
 * 信号）走的是「抛了」那一支，**但 error 文案保持 `"cancelled"`** —— 那条文案会
 * 进 run 表，审计要能把"用户点了停止"和"模型炸了"分开。shield 那一层没有对等物
 * 也不需要：JS 里没有任何东西能取消一个已经开始的 `finishRun`。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Budget } from "../../kernel/budget.js";
import { isCancelled } from "../pipeline/types.js";
import type { Repo } from "../../store/repo/protocol.js";
import type { JsonObject } from "../../store/types.js";
import { chatRecorderRunId, type Session } from "../session.js";
import type { Gateways } from "../usage.js";

/** `_ChatRun`：一次对话侧调用 + 它那份可重放的 Recorder journal。 */
export class ChatRun {
  status = "done";
  error = "";

  constructor(
    readonly repoRunId: string,
    readonly recorderRunId: string,
    readonly backend: Gateways["backend"] | null,
    readonly gw: Gateways["gw"],
    readonly smart: unknown,
    readonly budget: Budget | null,
  ) {}

  fail(error: string): void {
    this.status = "failed";
    this.error = error;
  }
}

export interface ChatRunDeps {
  /** `get_repo()`。**抛错就是"仓储没起来"**，见下面 registered 的注释。 */
  readonly repo: () => Repo;
  /** `_gateways`（`server/usage.ts`）。 */
  readonly gateways: (
    dir: string,
    runId: string,
    o: { resume: boolean; sessionId: string; kind: string; owner: string },
  ) => Gateways;
}

export interface ChatRunOptions {
  readonly kind: string;
  readonly semanticInput: unknown;
  readonly resume?: boolean;
}

export async function chatRun<T>(
  s: Session,
  deps: ChatRunDeps,
  opts: ChatRunOptions,
  body: (run: ChatRun) => Promise<T>,
): Promise<T> {
  const resume = opts.resume ?? true;
  // Pure domain/unit callers may construct a Session without registering it.
  // The HTTP product path never does: create/hydrate establishes the row first.
  // Keep that narrow test seam while making every real invocation durable.
  let repo: Repo | null;
  let registered: unknown;
  try {
    repo = deps.repo();
    registered = await repo.getSession(s.id);
  } catch {
    // Python 捕的是 RuntimeError —— `get_repo()` 在没有 lifespan 的纯领域测试里
    // 抛的就是它。TS 侧同一个位置抛的是普通 Error，所以捕全部。
    repo = null;
    registered = null;
  }
  const repoRunId =
    repo !== null && registered !== null && registered !== undefined
      ? await repo.nextRun(s.id, `chat:${opts.kind}`)
      : "";
  const recorderRunId = chatRecorderRunId(s, {
    kind: opts.kind,
    semanticInput: opts.semanticInput,
  });

  let budget: Budget | null = null;
  const budgetDoc = (): JsonObject => {
    // Correlate the unique invocation row with the semantic Recorder journal.
    // Without this pointer both stores are individually correct but an audit
    // cannot follow `session.12` to the effects it produced.
    const snapshot = budget !== null ? (budget.snapshot() as unknown as JsonObject) : {};
    return { ...snapshot, recorder_run_id: recorderRunId };
  };

  let backend: Gateways["backend"] | null = null;
  try {
    const journal = join(s.dir, "journal", `${recorderRunId}.jsonl`);
    const gws = deps.gateways(s.dir, recorderRunId, {
      resume: resume && existsSync(journal),
      sessionId: s.id,
      kind: "chat",
      owner: s.owner,
    });
    backend = gws.backend;
    budget = gws.budget;
    const run = new ChatRun(repoRunId, recorderRunId, gws.backend, gws.gw, gws.smart, gws.budget);
    const out = await body(run);
    if (repoRunId && repo !== null) {
      await repo.finishRun(repoRunId, {
        status: run.status,
        error: run.error,
        budget: budgetDoc(),
      });
    }
    return out;
  } catch (exc) {
    if (repoRunId && repo !== null) {
      await repo.finishRun(repoRunId, {
        status: "failed",
        // 取消的文案与 Python 的 `CancelledError` 分支逐字一致 —— run 表里
        // "用户停止"和"炸了"必须分得开。
        error: isCancelled(exc) ? "cancelled" : formatExc(exc),
        budget: budgetDoc(),
      });
    }
    throw exc;
  } finally {
    if (backend !== null) await backend.aclose();
  }
}

/** Python 的 `f"{type(exc).__name__}: {exc}"`。 */
function formatExc(exc: unknown): string {
  if (exc instanceof Error) return `${exc.name}: ${exc.message}`;
  return `${typeof exc}: ${String(exc)}`;
}
