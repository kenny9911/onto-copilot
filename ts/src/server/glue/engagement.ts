/**
 * `_resume_engagement_release`（`server.py:3440`）—— Question/Decision 改动之后
 * 恢复那份冻结的 FDE Engagement。
 *
 * 只有**预期之内的 INTERVIEW 挂起**才返回 `false`；REVIEW/EXPORT 硬门不过一律抛，
 * 因此不可能被转换成一次"成功"的 HTTP 回答。抽取节点从内容寻址的 journal 恢复，
 * engagement 投影本身是确定性的，**零模型调用**。
 *
 * ── 为什么这里不走 `PipelineDeps.harness` ──────────────────────────
 *
 * 这一档跑的是 `ScriptedBackend` + `stub_routing()`：它压根不需要 API key、不需要
 * 付费后端，跑完还要断言 `offline_backend.calls` 为空。走 `harness.makeEngagementRun`
 * 那个端口的话，装配细节（尤其"用的是离线后端"这件事）就藏进了接线方，而这条
 * 断言正是"确定性恢复真的没花钱"的唯一证据。所以就地装配。
 */

import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";

import { Budget } from "../../kernel/budget.js";
import { AgentBus } from "../../kernel/bus/bus.js";
import { CriticPanel } from "../../kernel/critic.js";
import { EventKind } from "../../kernel/events.js";
import { fingerprint } from "../../kernel/ids.js";
import { FileBlobStore, FileJournal } from "../../kernel/journal.js";
import { ModelGateway, ScriptedBackend, stubRouting } from "../../kernel/llm.js";
import { AgentLoop } from "../../kernel/loop.js";
import { ContextManager } from "../../kernel/memory/context.js";
import { Scratchpad } from "../../kernel/memory/short_term.js";
import type { EvidenceIndex } from "../../kernel/memory/evidence.js";
import type { Event } from "../../kernel/events.js";
import { bridgeFromEnv } from "../../kernel/otel.js";
import { Recorder } from "../../kernel/recorder.js";
import { RunStatus, Scheduler, runOutcomeOk } from "../../kernel/scheduler.js";
import { buildFdeEngagementDag } from "../../onto/engagement.js";
import {
  EngagementRuntimeInput,
  engagementCritics,
  engagementHandlers,
} from "../../onto/engagement_runtime.js";
import type { OIR } from "../../onto/oir.js";
import type { QuestionBacklog } from "../../onto/questions.js";
import { pyIsoUtc } from "../pipeline/run.js";
import { runWithLiveTrace } from "../pipeline/trace.js";
import { runIdFor, type Session } from "../session.js";
import { builtinRegistry } from "./tools.js";
import { questionBacklog } from "../routes/questions.js";
import { seam, type GlueDeps } from "./deps.js";

export interface ResumeEngagementOptions {
  readonly backlog?: QuestionBacklog | null;
  readonly leaseOwner?: string;
  /** `_compile(s, lease_owner=…)`。递归 import 会成环（compile → recompile →
   *  engagement → compile），所以由调用方传进来。 */
  readonly compile: (s: Session, opts: { leaseOwner: string }) => Promise<void>;
}

export async function resumeEngagementRelease(
  s: Session,
  deps: GlueDeps,
  opts: ResumeEngagementOptions,
): Promise<boolean> {
  if (s.state["_oir"] === null || s.state["_oir"] === undefined) {
    throw new Error("没有可恢复的 OIR，不能继续 FDE Engagement");
  }
  const backlog = opts.backlog ?? questionBacklog(s);
  const leaseOwner = opts.leaseOwner ?? "";
  const baseRunId = runIdFor(s);
  const recordedRunId = String(s.state["engagement_run_id"] ?? "");
  const baseJournal = join(s.dir, "journal", `${baseRunId}.jsonl`);
  let runId: string;
  if (recordedRunId) {
    runId = recordedRunId;
  } else if (existsSync(baseJournal)) {
    // Sessions built after the executable engagement rollout share the mature
    // extraction Recorder.  This fallback also upgrades an early deployment
    // that suspended before `engagement_run_id` was persisted.
    runId = baseRunId;
  } else {
    // Legacy sessions/tests may have OIR artifacts but predate the engagement
    // journal entirely.  Give migration its own namespace so a later full build
    // cannot restore these projection checkpoints as extraction work.
    runId = `${baseRunId}_engagement`;
  }
  const journalStore = new FileJournal(join(s.dir, "journal"));
  let resume = existsSync(join(s.dir, "journal", `${runId}.jsonl`));
  if (
    resume &&
    [...journalStore.read(runId)].some(
      (event) => event.kind === EventKind.NODE_COMPLETED && event.nodeId === "EXPORT",
    )
  ) {
    // A completed engagement is an immutable checkpoint.  Reusing it after a
    // Question/Decision mutation would restore CANONICALIZE/REVIEW/EXPORT and
    // silently serve the old package.  Mutations after release get their own
    // deterministic revision namespace; a still-suspended INTERVIEW continues
    // to use the original run above.
    const mutation = fingerprint({
      questions: backlog.toDict(),
      decisions: [...((s.state["decision_ledger"] as unknown[] | undefined) ?? [])],
      artifactRevision: pyInt(s.state["artifact_revision"]),
    }).slice(0, 12);
    runId = `${baseRunId}_engagement_${mutation}`;
    resume = existsSync(join(s.dir, "journal", `${runId}.jsonl`));
  }
  s.state["engagement_run_id"] = runId;

  // Python 侧这里有一个 `backend = None` + `finally: if backend is not None:
  // await backend.aclose()` —— 但那个变量**从头到尾没被赋过值**（这一档用的是
  // 进程内的 ScriptedBackend，没有连接要关）。照搬一个恒为 null 的 finally 只会
  // 让下一个读代码的人以为这里有个 HTTP 后端要收尾，所以不搬。
  {
    // Every engagement handler and critic is deterministic/skip_model.  Resume
    // needs a Recorder, not an API key or a paid backend—even when its journal
    // also contains the mature extraction checkpoints.
    const engBridge = bridgeFromEnv(runId);
    const rec = new Recorder(runId, journalStore, new FileBlobStore(join(s.dir, "blobs")), {
      resume,
      ...(engBridge !== null ? { observer: (e: Event) => engBridge.observe(e) } : {}),
    });
    const budget = new Budget({ tokens: 1_000_000, usd: 1 });
    const offlineBackend = new ScriptedBackend();
    const gw = new ModelGateway(offlineBackend, rec, { routing: stubRouting(), budget });
    if (!resume) s.emit("engagement.checkpoint_migrated", { runId });
    const index = (s.state["_index"] as EvidenceIndex | undefined) ?? null;
    const bus = new AgentBus(rec);
    const tools = builtinRegistry({
      evidence: index,
      profiles: (s.state["_profiles"] as Record<string, unknown> | undefined) ?? null,
      sandbox: null,
    });
    bus.board.write("_tools", tools, { by: "bootstrap" });
    // 这条恢复路径也要能看见项目记忆：它跑的是同一批 engagement 节点，
    // 少挂一处的表现是"回答完问题重跑一遍，项目里攒的约定就不见了"。
    const pmem = s.projectId ? await deps.projectMemory(s.projectId) : null;
    const cm = new ContextManager({
      system: "FDE Engagement deterministic resume",
      evidence: index,
      budgetTokens: 90_000,
      longTerm: pmem !== null ? pmem.store : null,
    });

    const runtime = new EngagementRuntimeInput({
      sessionId: s.id,
      project: s.project || s.title,
      oir: s.state["_oir"] as OIR,
      flow: s.state["_flow"] ?? null,
      backlog,
      decisions: [...((s.state["decision_ledger"] as unknown[] | undefined) ?? [])],
      corpus: (s.state["corpus"] as Record<string, unknown> | undefined) ?? {},
      artifactRevision: pyInt(s.state["artifact_revision"]),
      generatedAt: pyIsoUtc(s.created),
      // `os.access(s.dir, os.W_OK)` —— 目录不可写就不该说产物"可下载"。
      releaseDownloadable: writable(s.dir),
      // 降级过就让产物自己说出来（budget.ts 的注释承诺过的那个标记）
      skippedReviews: budget.skippedReviews(),
    });
    const loop = new AgentLoop({
      gateway: gw,
      ctxManager: cm,
      panel: new CriticPanel(engagementCritics(), rec),
      bus,
      recorder: rec,
      budget,
      handlers: engagementHandlers(runtime),
      newScratchpad: (t) => new Scratchpad({ budgetTokens: t }),
    });
    const outcome = await runWithLiveTrace(
      seam(s),
      rec,
      new Scheduler(buildFdeEngagementDag(), loop, rec, bus, budget, {
        concurrency: 4,
      }).run(runId),
    );
    if (offlineBackend.calls.length > 0) {
      throw new Error("确定性 FDE Engagement 恢复意外触发了模型调用");
    }
    s.state["engagement_execution"] = {
      status: String(outcome.status),
      completed: Object.keys(outcome.results).sort(cmpCodePoint),
      restored: [...outcome.skipped].sort(cmpCodePoint),
      pendingHuman: outcome.pendingHuman,
    };
    if (outcome.status === RunStatus.SUSPENDED) {
      s.emit("engagement.stage", { node: "INTERVIEW", contract: "QuestionBacklog" });
      return false;
    }
    if (!runOutcomeOk(outcome)) {
      throw new Error(`FDE Engagement 恢复失败：${outcome.error}`);
    }
    const exportPlan = (outcome.outputs["EXPORT"] ?? {}) as Record<string, unknown>;
    if (
      !(
        truthy(exportPlan["review_passed"]) &&
        truthy(exportPlan["schema_valid"]) &&
        truthy(exportPlan["downloadable"])
      )
    ) {
      throw new Error("FDE Engagement EXPORT 硬门未通过，已阻止交付");
    }
    s.state["release_state"] = String(
      truthy(exportPlan["releaseState"]) ? exportPlan["releaseState"] : "RELEASED",
    );
    s.emit("engagement.stage", {
      node: "EXPORT",
      contract: "OntologyPackage.v1",
      artifacts: (truthy(exportPlan["artifacts"]) ? exportPlan["artifacts"] : []) as never,
    });
    await opts.compile(s, { leaseOwner });
    return true;
  }
}

/** `int(x or 0)`。 */
function pyInt(v: unknown): number {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** `os.access(path, os.W_OK)`。 */
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return x.length - y.length;
}
