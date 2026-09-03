/**
 * `_compile`（`server.py:3825`）、`_write_canonical_artifacts`（3866）、
 * `_drain_queue`（3357）与 `_recompile`（3383）。
 *
 * 四个放在一起：`_recompile → _resume_engagement_release → _compile` 是一条环，
 * Python 里靠"同一个模块"绕过去，TS 侧靠把它们放进同一个文件 +
 * {@link ResumeEngagementOptions.compile} 这个显式回调绕过去。拆成四个文件的话
 * 会出现真正的 import 环（ESM 下表现为某个导出在初始化时是 `undefined`，
 * 而报错点离现场很远）。
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ONTOLOGY_PACKAGE_JSON_SCHEMA,
  buildPackage,
  pyJsonDumps,
  validatePackage,
  type SkippedReview,
} from "../../onto/canonical.js";
import { makeIntentMatch, parseIntent } from "../../kernel/intent.js";
import type { OIR } from "../../onto/oir.js";
import { conflictToDict, type Conflict } from "../../onto/conflict.js";
import { compileTemplate, writeXlsx } from "../../onto/template.js";
import { finish } from "../../onto/pipeline.js";
import { dropReferenceMemory } from "../routes/projects.js";
import type { Session } from "../session.js";
import type { GlueDeps, IntentMatchLike } from "./deps.js";
import { resumeEngagementRelease } from "./engagement.js";
import { blockingPendingQuestions, syncQuestionBacklog } from "./questions.js";
import {
  commitEngagementReleaseStage,
  clearStagedEngagementDelivery,
  createEngagementReleaseStage,
  engagementReleaseFileOps,
  engagementReleaseStagePath,
  ENGAGEMENT_RELEASE_FILES,
  finalizeEngagementReleaseCommit,
  rollbackEngagementReleaseCommit,
  sealEngagementReleaseStage,
  stagedEngagementDelivery,
  validEngagementReleaseStage,
  type EngagementReleaseFileOpsOverride,
  type EngagementReleaseStage,
} from "./engagement_delivery.js";

// ══════════════════════════════════════════════════════════════════
//  Canonical 产物
// ══════════════════════════════════════════════════════════════════

/**
 * 生成并校验 OntologyPackage，再提交五个稳定 JSON 视图。
 *
 * `write=false` 是发布前预检；`prepared` 让真正提交复用同一份已校验数据，
 * 从而保证 Release Gate 检查的正是最终写出的那个 revision。
 */
export function writeCanonicalArtifacts(
  s: Session,
  opts: { write?: boolean; prepared?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  const write = opts.write ?? true;
  const prepared = opts.prepared ?? null;
  const oir = (s.state["_oir"] as OIR | undefined) ?? null;
  if (oir === null) return {};
  const current = pyInt(s.state["artifact_revision"]);
  let revision = current + 1;
  let decisions: unknown[] = [];
  const dm = s.state["_dialogue"] as { decisions: { toDict(): unknown }[] } | undefined;
  if (dm !== undefined && dm !== null) decisions = dm.decisions.map((d) => d.toDict());
  // Question Decision Ledger 是 FDE 回答的权威历史。仓储读取是 async，编译函数
  // 保持同步，因此调用方在 state 中维护一份耐久投影；缺省仍兼容 legacy dialogue。
  decisions = decisions.concat([...((s.state["decision_ledger"] as unknown[] | undefined) ?? [])]);
  // R2：交付物的 provenance 里只准有人拍的板。上面两个来源都是**全量、不过滤**
  // 地拼进来的，所以在进包之前显式滤一道 —— 见 dropReferenceMemory。
  decisions = dropReferenceMemory(decisions);
  let data: Record<string, unknown>;
  if (prepared === null) {
    const pkg = buildPackage(oir, (s.state["_flow"] ?? null) as never, {
      packageId: `pkg.${s.id}`,
      revision,
      baseRevision: current || null,
      decisions,
      backlog: s.state["question_backlog"],
    });
    data = pkg.toDict();
  } else {
    data = prepared;
    const raw = data["revision"];
    revision = truthy(raw) ? pyInt(raw) : revision;
  }
  // A prepared package is the exact payload REVIEW/EXPORT already gated.  Keep
  // its budget/human-review disclosure while revalidating the bytes to write;
  // otherwise the commit step would silently rewrite "not semantically reviewed"
  // into a clean-looking validation report.
  const previousValidation = data["validation"];
  const skippedReviews =
    previousValidation !== null &&
    typeof previousValidation === "object" &&
    !Array.isArray(previousValidation) &&
    Array.isArray((previousValidation as Record<string, unknown>)["skipped_reviews"])
      ? ((previousValidation as Record<string, unknown>)["skipped_reviews"] as unknown[])
          .filter(
            (row): row is SkippedReview =>
              row !== null &&
              typeof row === "object" &&
              !Array.isArray(row) &&
              typeof (row as Record<string, unknown>)["what"] === "string" &&
              typeof (row as Record<string, unknown>)["why"] === "string" &&
              typeof (row as Record<string, unknown>)["level"] === "number" &&
              typeof (row as Record<string, unknown>)["label"] === "string",
          )
      : [];
  const report = validatePackage(data as never, skippedReviews);
  data["validation"] = report.toDict();
  if (!report.passed) {
    const findings = report.findings.filter((f) => f.severity === "error");
    s.emit("artifact.validation_failed", {
      artifact: "ontology_package",
      revision,
      findings: findings.slice(0, 20).map((f) => findingDict(f)) as never,
    });
    const summary = findings.map((f) => `${f.code}@${f.path}: ${f.message}`).join("; ");
    throw new Error(`OntologyPackage v1 校验失败，已阻止交付：${summary}`);
  }
  if (!write) return data;
  writeFileSync(join(s.dir, "ontology.package.json"), pyJsonDumps(data, 2), "utf-8");
  writeFileSync(
    join(s.dir, "ontology-package.schema.json"),
    pyJsonDumps(ONTOLOGY_PACKAGE_JSON_SCHEMA, 2),
    "utf-8",
  );
  const views: Record<string, string> = {
    "data-objects.json": "dataObjects",
    "actions.json": "actions",
    "events.json": "events",
    "rules.json": "rules",
    "questions.json": "questions",
  };
  for (const [name, key] of Object.entries(views)) {
    writeFileSync(
      join(s.dir, name),
      pyJsonDumps({ schemaVersion: data["schemaVersion"], revision, items: data[key] }, 2),
      "utf-8",
    );
  }
  s.state["artifact_revision"] = revision;
  const stats: Record<string, number> = {};
  for (const k of ["dataObjects", "actions", "events", "rules", "questions"]) {
    stats[k] = (data[k] as unknown[]).length;
  }
  s.state["ontology_package"] = {
    schemaVersion: data["schemaVersion"],
    packageId: data["packageId"],
    revision,
    validation: data["validation"],
    stats,
  };
  return data;
}

// ══════════════════════════════════════════════════════════════════
//  排队的动作
// ══════════════════════════════════════════════════════════════════

/**
 * 把梳理期间排下的改动执行掉。
 *
 * 入队的时候我们对用户说了"本轮梳理跑完就执行"。不排干的话那句话就是谎话，
 * 而且是**最坏的一种**：用户以为说过了，于是不再重复，结果什么都没发生。
 *
 * 每条都回执做了什么 —— 静默执行和静默丢弃，用户同样分辨不出来。
 */
export async function drainQueue(s: Session, deps: GlueDeps): Promise<void> {
  const queued = s.state["_queued"];
  delete s.state["_queued"];
  if (!Array.isArray(queued) || queued.length === 0) return;
  // `_act` 的返回既可能是一句话、也可能是 `_outcome(...)` 那个 dict（原件的形状，
  // 见 `glue/act.ts` 的文件头）。这里照搬 Python 的收集方式，**判类型的地方在下面
  // 的 join**：提前把 dict 转成字符串就是在偷偷发明一种原件没有的行为。
  const done: (string | Record<string, unknown>)[] = [];
  for (const raw of queued as Record<string, unknown>[]) {
    let r: string | Record<string, unknown>;
    try {
      const m: IntentMatchLike = makeIntentMatch(
        parseIntent(String(raw["intent"] ?? "")),
        truthy(raw["confidence"]) ? Number(raw["confidence"]) : 0.9,
        isPlainObject(raw["slots"]) ? raw["slots"] : {},
        String(raw["span"] ?? ""),
        String(raw["by"] ?? "queued"),
      );
      r = await deps.act(s, m);
    } catch (exc) {
      // 一条失败不该拖垮其余的。
      r = `「${String(raw["span"] ?? "")}」没执行成功：${formatExc(exc)}`;
    }
    // Python 的 `if r:` —— 空串跳过，非空 dict 是真值所以会被收进来
    if (typeof r === "string" ? r !== "" : Object.keys(r).length > 0) done.push(r);
  }
  if (done.length > 0) {
    // `"\n\n".join(done)`。**dict 在这里就是 TypeError**，照搬 —— 换成
    // `String(x)` 会往用户的回执里发一句 "[object Object]"，那比一次明确的失败
    // 难查得多。这条路当前到不了：全仓没有任何地方往 `_queued` 写过东西。
    const bad = done.findIndex((x) => typeof x !== "string");
    if (bad >= 0) {
      throw new TypeError(`sequence item ${bad}: expected str instance, dict found`);
    }
    deps.publishAssistant(s, `梳理跑完了，把你刚才排下的几件事办了：\n\n${done.join("\n\n")}`);
    s.emit("queue.drained", { count: queued.length });
  }
}

// ══════════════════════════════════════════════════════════════════
//  编译
// ══════════════════════════════════════════════════════════════════

export async function compile(
  s: Session,
  deps: GlueDeps,
  opts: { leaseOwner?: string; releaseFileOps?: EngagementReleaseFileOpsOverride } = {},
): Promise<void> {
  const leaseOwner = opts.leaseOwner ?? "";
  const fileOps = engagementReleaseFileOps(opts.releaseFileOps);
  const oir = s.state["_oir"] as OIR;
  const conflicts = ((s.state["_conflicts"] as Conflict[] | undefined) ?? []) as Conflict[];
  // 先校验由 workflow 暂存的人工验收终态，再做任何文件写入。没有正式 APPROVE
  // 的 compile 一律是 DRAFT；正式 REJECT 可以保留交付候选，但不能穿透成 RELEASED。
  const delivery = stagedEngagementDelivery(s);
  const committedReleaseState = delivery?.disposition === "RELEASED" ? "RELEASED" : "DRAFT";
  s.state["release_state"] = "DRAFT";
  // 所有 JSON 字节也在写盘前生成。这样非 JSON 模型输出会在 canonical/xlsx 之前
  // fail closed；文件路径始终来自代码内固定白名单，不读取模型的 artifacts/name。
  const deliveryDocuments =
    delivery?.documents.map((document) => ({
      name: document.name,
      json: pyJsonDumps(document.payload, 2),
    })) ?? [];
  const releaseFiles = delivery === null
    ? ENGAGEMENT_RELEASE_FILES.slice(0, 10)
    : [...ENGAGEMENT_RELEASE_FILES];
  // Canonical artifacts and question exports must be projections of the same unified
  // backlog.  Sync first: otherwise conflict questions/answers enter the Ledger only
  // after ontology.package.json has already been written and Decisions dangle.
  await syncQuestionBacklog(s, deps, { oir, conflicts });
  s.emit("node.entered", { node: "COMPILE", title: "编译模板" });
  let pending = pendingCompileRelease(s, releaseFiles, committedReleaseState, fileOps);
  if (pending === null) {
    const spec = compileTemplate(oir, conflicts);
    // Release Gate 必须发生在任何可下载产物写盘之前。Canonical 包若存在悬空引用、
    // 重复 ID 或 schema 破坏，模板/OIR 也不能先以"新版本"出现在下载接口里。
    // 先构建并验证一次，后面把同一份数据提交，避免两次构建的 generatedAt 漂移。
    const reviewed = s.state["_engagement_package"];
    const canonical =
      reviewed !== null && typeof reviewed === "object" && !Array.isArray(reviewed)
        ? writeCanonicalArtifacts(s, {
            write: false,
            prepared: reviewed as Record<string, unknown>,
          })
        : writeCanonicalArtifacts(s, { write: false });
    const stage = createEngagementReleaseStage(s.dir, releaseFiles, fileOps);
    try {
      await writeXlsx(spec, engagementReleaseStagePath(stage, "模板_v1.xlsx"), {
        project: s.project || s.title,
      });
      spec.save(engagementReleaseStagePath(stage, "template.spec.json"));
      writeFileSync(
        engagementReleaseStagePath(stage, "oir.json"),
        pyJsonDumps(oir.toDict(), 1),
        "utf-8",
      );
      writeCanonicalStage(stage, canonical);
      for (const document of deliveryDocuments) {
        writeFileSync(engagementReleaseStagePath(stage, document.name), document.json, "utf-8");
      }
      sealEngagementReleaseStage(stage, fileOps);
      pending = {
        schemaVersion: "1.0.0",
        stage,
        releaseState: committedReleaseState,
        artifactRevision: pyInt(canonical["revision"]),
        ontologyPackage: canonicalPackageState(canonical),
        oir: oir.toDict(),
        template: spec.stats() as unknown as Record<string, unknown>,
      };
      // 只保存代码生成的 staging 句柄；失败后继续用同一批 sealed 字节重试。
      s.state["_engagement_release_stage"] = pending;
    } catch (error) {
      finalizeEngagementReleaseCommit(stage, fileOps);
      throw error;
    }
  }

  const beforeCommit = snapshotCompileState(s);
  let commit;
  try {
    commit = commitEngagementReleaseStage(pending.stage, fileOps);
  } catch (error) {
    s.state["release_state"] = "DRAFT";
    throw error;
  }

  s.state["release_state"] = pending.releaseState;
  s.state["artifact_revision"] = pending.artifactRevision;
  s.state["ontology_package"] = pending.ontologyPackage;
  // oir.json 写了、state 里的快照没刷 —— 前端读的是快照，于是磁盘上是新的、
  // 界面上是旧的。这种不一致只有对着文件核对才会发现。
  s.state["oir"] = pending.oir;
  s.state["template"] = pending.template;
  // **这一处不排序**（`[p.name for p in s.dir.iterdir() if p.is_file()]`）。
  // `_write_question_exports` / `_rewrite_flow_artifacts` 那两处是 `sorted(...)`。
  // 看起来像疏忽，但它是既有的产物形状；统一排序会改变 /state 的返回顺序，
  // 而那是前端渲染产物列表的顺序。要统一是迁移之后另开的一件事。
  s.state["artifacts"] = dirFiles(s.dir);
  // 只有 blocking 问题扣状态：普通 open 问题是工作清单，不是闸门（几千条
  // 谁也答不完，awaiting_answer 会没有出口，build.start 永远 409）。
  s.status = blockingPendingQuestions(s).length > 0 ? "awaiting_answer" : "done";
  try {
    await deps.persist(s, { leaseOwner });
  } catch (persistError) {
    let rollbackError: unknown = null;
    try {
      rollbackEngagementReleaseCommit(commit, fileOps);
    } catch (error) {
      rollbackError = error;
    }
    restoreCompileState(s, beforeCommit);
    s.state["release_state"] = "DRAFT";
    // 首次 persist 可能在远端已经部分落库后才抛错；立即用 DRAFT
    // 覆盖，不让仓库中的 RELEASED 与已回滚文件分裂。staging 保留供重试。
    try {
      await deps.persist(s, { leaseOwner });
    } catch {
      // 内存状态仍 fail closed；原 persist 错误是最有用的根因。
    }
    if (rollbackError !== null) {
      throw new AggregateError([persistError, rollbackError], "发布状态持久化与文件回滚均失败");
    }
    throw persistError;
  }
  // 成功持久化是事务提交点；此前不得清除 reviewed package、delivery 或 stage。
  delete s.state["_engagement_package"];
  clearStagedEngagementDelivery(s);
  delete s.state["_engagement_release_stage"];
  finalizeEngagementReleaseCommit(pending.stage, fileOps);
  s.emit("artifact.ready", {
    artifact: "template",
    name: "模板_v1.xlsx",
    stats: pending.template as never,
  });
  // 排队的动作要在"完成"**之前**执行完。放在之后的话，用户先看到「已完成」、
  // 界面停止刷新，然后产物才悄悄变了 —— 他不会知道。
  await drainQueue(s, deps);
  if (s.status === "done") {
    s.emit("run.completed", { stats: oir.stats() });
  } else {
    s.emit("run.suspended", { reason: "仍有待业务回答的问题" });
  }
  // `asyncio.create_task(...)` —— 不 await。接线方负责挂 catch（Node 上无人处理的
  // rejection 会杀进程，契约 §2.1）。
  deps.emitAiPrompts(s, "opening");
}

// ══════════════════════════════════════════════════════════════════
//  重算
// ══════════════════════════════════════════════════════════════════

/**
 * 按当前 OIR 重算下游并重写产物。**零模型调用。**
 *
 * 对齐、冲突检测、自动修复、澄清排序、模板编译全是确定性代码 —— 用户改了
 * 一个决定就重跑一遍整个 DAG 是没必要的浪费，那要花几美元。
 */
export async function recompile(
  s: Session,
  deps: GlueDeps,
  opts: { leaseOwner?: string; preserveQuestionRows?: boolean } = {},
): Promise<void> {
  const leaseOwner = opts.leaseOwner ?? "";
  const oir = s.state["_oir"] as OIR;
  const res = finish(oir, {
    endpoints: (s.state["_endpoints"] as Record<string, unknown>[] | undefined) ?? null,
    profiles:
      (s.state["_profiles"] as Record<string, Record<string, unknown>> | undefined) ?? null,
    project: s.project,
  });
  s.state["_conflicts"] = res.conflicts;
  s.state["oir"] = oir.toDict();
  s.state["conflicts"] = res.conflicts.map((c) => conflictToDict(c));
  s.state["suggestions"] = res.suggestions.length > 0 ? res.suggestions : [];
  const backlog = await syncQuestionBacklog(s, deps, {
    oir,
    clarification: res.clarify.questions,
    conflicts: res.conflicts,
    preserveRepoLifecycle: opts.preserveQuestionRows ?? false,
  });
  // The final Question answer must resume the *same* content-addressed Recorder.
  // Otherwise `_compile` would let the HTTP answer path bypass
  // CANONICALIZE→REVIEW→EXPORT even though the initial build correctly suspended.
  const released = await resumeEngagementRelease(s, deps, {
    backlog,
    leaseOwner,
    compile: (sess, o) => compile(sess, deps, o),
  });
  if (!released) {
    s.status = "awaiting_answer";
    await deps.persist(s, { leaseOwner });
  }
  s.emit("suggest.ready", { suggestions: s.state["suggestions"] as never });
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

interface PendingCompileRelease {
  readonly schemaVersion: "1.0.0";
  readonly stage: EngagementReleaseStage;
  readonly releaseState: "RELEASED" | "DRAFT";
  readonly artifactRevision: number;
  readonly ontologyPackage: Record<string, unknown>;
  readonly oir: Record<string, unknown>;
  readonly template: Record<string, unknown>;
}

function pendingCompileRelease(
  s: Session,
  files: readonly string[],
  releaseState: "RELEASED" | "DRAFT",
  ops: ReturnType<typeof engagementReleaseFileOps>,
): PendingCompileRelease | null {
  const raw = s.state["_engagement_release_stage"];
  if (!isPlainObject(raw) || raw["schemaVersion"] !== "1.0.0") return null;
  const stage = raw["stage"];
  if (!validEngagementReleaseStage(stage, s.dir, files, ops)) return null;
  if (raw["releaseState"] !== releaseState) return null;
  if (
    typeof raw["artifactRevision"] !== "number" ||
    !isPlainObject(raw["ontologyPackage"]) ||
    !isPlainObject(raw["oir"]) ||
    !isPlainObject(raw["template"])
  ) {
    return null;
  }
  return raw as unknown as PendingCompileRelease;
}

function writeCanonicalStage(
  stage: EngagementReleaseStage,
  data: Record<string, unknown>,
): void {
  writeFileSync(
    engagementReleaseStagePath(stage, "ontology.package.json"),
    pyJsonDumps(data, 2),
    "utf-8",
  );
  writeFileSync(
    engagementReleaseStagePath(stage, "ontology-package.schema.json"),
    pyJsonDumps(ONTOLOGY_PACKAGE_JSON_SCHEMA, 2),
    "utf-8",
  );
  const revision = pyInt(data["revision"]);
  const views = [
    ["data-objects.json", "dataObjects"],
    ["actions.json", "actions"],
    ["events.json", "events"],
    ["rules.json", "rules"],
    ["questions.json", "questions"],
  ] as const;
  for (const [name, key] of views) {
    writeFileSync(
      engagementReleaseStagePath(stage, name),
      pyJsonDumps({ schemaVersion: data["schemaVersion"], revision, items: data[key] }, 2),
      "utf-8",
    );
  }
}

function canonicalPackageState(data: Record<string, unknown>): Record<string, unknown> {
  const stats: Record<string, number> = {};
  for (const key of ["dataObjects", "actions", "events", "rules", "questions"] as const) {
    const rows = data[key];
    stats[key] = Array.isArray(rows) ? rows.length : 0;
  }
  return {
    schemaVersion: data["schemaVersion"],
    packageId: data["packageId"],
    revision: pyInt(data["revision"]),
    validation: data["validation"],
    stats,
  };
}

const COMPILE_STATE_KEYS = [
  "release_state",
  "artifact_revision",
  "ontology_package",
  "oir",
  "template",
  "artifacts",
] as const;

interface CompileStateSnapshot {
  readonly status: Session["status"];
  readonly values: ReadonlyMap<string, { readonly existed: boolean; readonly value: unknown }>;
}

function snapshotCompileState(s: Session): CompileStateSnapshot {
  return {
    status: s.status,
    values: new Map(
      COMPILE_STATE_KEYS.map((key) => [
        key,
        {
          existed: Object.prototype.hasOwnProperty.call(s.state, key),
          value: s.state[key],
        },
      ]),
    ),
  };
}

function restoreCompileState(s: Session, snapshot: CompileStateSnapshot): void {
  s.status = snapshot.status;
  for (const [key, entry] of snapshot.values) {
    if (entry.existed) s.state[key] = entry.value as never;
    else delete s.state[key];
  }
}

/** `[p.name for p in dir.iterdir() if p.is_file()]` —— **不排序**。 */
function dirFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    try {
      if (statSync(join(dir, name)).isFile()) out.push(name);
    } catch {
      // 列目录与 stat 之间文件可能已被删；`is_file()` 对不存在的路径回 False。
    }
  }
  return out;
}

function findingDict(f: { code: string; path: string; message: string; severity: string }) {
  return { code: f.code, path: f.path, message: f.message, severity: f.severity };
}

function pyInt(v: unknown): number {
  if (!truthy(v)) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatExc(exc: unknown): string {
  if (exc instanceof Error) return `${exc.name}: ${exc.message}`;
  return `${typeof exc}: ${String(exc)}`;
}
