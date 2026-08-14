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
import { pendingQuestions, syncQuestionBacklog } from "./questions.js";

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
  const report = validatePackage(data as never);
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
  opts: { leaseOwner?: string } = {},
): Promise<void> {
  const leaseOwner = opts.leaseOwner ?? "";
  const oir = s.state["_oir"] as OIR;
  const conflicts = ((s.state["_conflicts"] as Conflict[] | undefined) ?? []) as Conflict[];
  // Canonical artifacts and question exports must be projections of the same unified
  // backlog.  Sync first: otherwise conflict questions/answers enter the Ledger only
  // after ontology.package.json has already been written and Decisions dangle.
  await syncQuestionBacklog(s, deps, { oir, conflicts });
  s.emit("node.entered", { node: "COMPILE", title: "编译模板" });
  const spec = compileTemplate(oir, conflicts);
  // Release Gate 必须发生在任何可下载产物写盘之前。Canonical 包若存在悬空引用、
  // 重复 ID 或 schema 破坏，模板/OIR 也不能先以"新版本"出现在下载接口里。
  // 先构建并验证一次，后面把同一份数据提交，避免两次构建的 generatedAt 漂移。
  const canonical = writeCanonicalArtifacts(s, { write: false });
  const xlsx = await writeXlsx(spec, join(s.dir, "模板_v1.xlsx"), {
    project: s.project || s.title,
  });
  spec.save(join(s.dir, "template.spec.json"));
  writeFileSync(join(s.dir, "oir.json"), pyJsonDumps(oir.toDict(), 1), "utf-8");
  writeCanonicalArtifacts(s, { prepared: canonical });
  // oir.json 写了、state 里的快照没刷 —— 前端读的是快照，于是磁盘上是新的、
  // 界面上是旧的。这种不一致只有对着文件核对才会发现。
  s.state["oir"] = oir.toDict();
  s.state["template"] = spec.stats();
  // **这一处不排序**（`[p.name for p in s.dir.iterdir() if p.is_file()]`）。
  // `_write_question_exports` / `_rewrite_flow_artifacts` 那两处是 `sorted(...)`。
  // 看起来像疏忽，但它是既有的产物形状；统一排序会改变 /state 的返回顺序，
  // 而那是前端渲染产物列表的顺序。要统一是迁移之后另开的一件事。
  s.state["artifacts"] = dirFiles(s.dir);
  s.status = pendingQuestions(s).length > 0 ? "awaiting_answer" : "done";
  await deps.persist(s, { leaseOwner });
  s.emit("artifact.ready", {
    artifact: "template",
    name: basename(xlsx),
    stats: spec.stats() as never,
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

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
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
