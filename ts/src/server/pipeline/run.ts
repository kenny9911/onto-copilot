/**
 * 流水线主干 —— `server.py` 2030–2605。
 *
 * 材料进来、跑 DAG、出 OIR / 问题清单 / 流程图 / Excel。整个产品就是这一条。
 *
 * ── 与 Python 的三处**结构性**差异（都在 types.ts 文件头有更长的说明）────
 *
 * 1. **取消是协作式的。** `asyncio.CancelledError` → {@link RunCancelled}，
 *    `task.cancel()` → `AbortController.abort()`，`await` 点上的自动抛出 →
 *    显式 `checkCancelled(signal)`。位置与 Python 会抛的位置一一对应。
 *
 * 2. **每个节点边界和 Run 收尾都 `await journal.flush()`。** journal 的落盘在
 *    TS 侧是异步后台 drain（契约 §2.1），Recorder **不代劳**。不 flush 的后果是
 *    进程在 `finish_run` 之后立刻退出时，最后几十条事件还在队列里 —— 重放会看到
 *    一个"跑完了但没有 NODE_COMPLETED"的 Run，于是下次 resume 把已经付过钱的
 *    节点全部重跑一遍。
 *
 * 3. **`_CATALOG` / `_gateways` / `onto.pipeline` 等经 {@link PipelineDeps} 注入**，
 *    因为它们属于别的 agent 的 track。见 types.ts 文件头。
 */

// gateway_balance 的文案是**现成的**（契约 §5/§9）：这两条消息是"两种钱不够
// 要分开说"的载体，重写一遍就必然分叉，而分叉的症状是让用户去给一个一分钱
// 没少的账户充值。
import { budgetCappedText, quotaExhaustedText } from "../../kernel/gateway_balance.js";
import { RunStatus } from "../../kernel/scheduler.js";
import type { JsonObject } from "../../store/types.js";
import { AgentBus } from "../../kernel/bus/bus.js";
import type { ParsedDoc } from "../../onto/parse/base.js";
import { persist } from "./persist.js";
import type { PersistDeps } from "./persist.js";
import { pumpKernelEvents, runWithLiveTrace } from "./trace.js";
import {
  RunCancelled,
  checkCancelled,
  isCancelled,
  makeRunHandle,
  withLock,
} from "./types.js";
import type {
  ConflictLike,
  ContextManagerLike,
  Gateways,
  PipelineDeps,
  ProjectMemoryLike,
  QuestionLike,
  SessionLike,
} from "./types.js";

import { access, constants as FS } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { conflictToDict, type Conflict } from "../../onto/conflict.js";
import { clarificationSummary, questionToDict, type ClarificationSet } from "../../onto/clarify.js";
import { gapToQuestion, type Gap } from "../../onto/gaps.js";

// ══════════════════════════════════════════════════════════════════
//  Python 小工具
// ══════════════════════════════════════════════════════════════════

/** Python 的 `sorted()` 按 code point；JS 的 `sort()` 按 UTF-16 code unit。
 *  中文与 emoji 混排的分组名会分叉，而分组名直接印在事件载荷上。 */
function sortedCp(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => {
    const A = [...a];
    const B = [...b];
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i]!.codePointAt(0)!;
      const y = B[i]!.codePointAt(0)!;
      if (x !== y) return x < y ? -1 : 1;
    }
    return A.length - B.length;
  });
}

/** `round(x, n)`。**已知分叉**：Python 是 half-to-even，`toFixed` 在恰好落在
 *  半位时是 half-away-from-zero。只用在展示用的 usd 上，差一个 1e-4 不改判断。 */
function pyRound(x: number, n: number): number {
  return Number(x.toFixed(n));
}

/**
 * `datetime.fromtimestamp(x, UTC).isoformat()`。
 *
 * **不能**用 `toISOString()`：它固定给 `.000Z`，而 Python 在微秒为 0 时**不写**
 * 小数部分、时区写成 `+00:00`。这个串进 `EngagementRuntimeInput.generated_at`，
 * 而 Recorder 的重放要求输出确定 —— 差一个 `Z` 就是另一个内容指纹，resume 全部
 * 命不中，等于每次回答问题都把 engagement 重跑一遍。
 */
export function pyIsoUtc(epochSeconds: number): string {
  // fromtimestamp 先把浮点秒圆整到微秒，再拆成字段。**整秒与微秒必须一起算** ——
  // 先取毫秒再减掉尾数会把 `x.000001` 掰成上一秒（Date 的毫秒是整数，减 0.001 就
  // 退了一格），于是 `22:13:20.000001` 变成 `22:13:19.000001`。
  const us = Math.round(epochSeconds * 1e6);
  const sec = Math.floor(us / 1_000_000);
  const micro = us - sec * 1_000_000;
  const d = new Date(sec * 1000);
  const p = (v: number, w = 2): string => String(v).padStart(w, "0");
  const head =
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return micro === 0 ? `${head}+00:00` : `${head}.${p(micro, 6)}+00:00`;
}

/** `path.suffix.lower()` —— **Python 的 suffix 只取最后一段**，`.tar.gz` 是 `.gz`；
 *  而没有点的文件名是 `""`（不是整个名字）。 */
function suffixLower(p: string): string {
  const base = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** `asyncio.sleep(seconds)`，但能被 abort 提前叫醒。 */
function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** `asyncio.create_task(coro)` 的"发出去不管"形态。挂 catch 是必须的 ——
 *  无人 await 的 rejected promise 在 Node 里直接杀进程。 */
function fireAndForget(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

// ══════════════════════════════════════════════════════════════════
//  build 的入口
// ══════════════════════════════════════════════════════════════════

export const BUILD_STARTABLE: readonly string[] = ["idle", "done", "failed", "stopped"];

/**
 * Claim one durable build lease and start its local task.
 *
 * Every product entry point (HTTP, intent action and ConversationAgent tools)
 * uses this boundary.  The returned value is `started` or the authoritative
 * repository status; `missing`/`no_files` are explicit local failures.
 */
export async function claimAndStartBuild(
  s: SessionLike,
  deps: PipelineDeps,
  opts: { tier?: string } = {},
): Promise<string> {
  const tier = opts.tier === "full" || opts.tier === "flow_preview" ? opts.tier : "full";
  const outcome = await withLock(s.buildLock, async (): Promise<string> => {
    const leaseOwner = `${deps.workerId}:${deps.newToken()}`;
    const claimed = await deps.repo().claimBuildLease(s.id, {
      owner: leaseOwner,
      now: deps.now(),
      ttl: deps.buildLeaseTtl(),
      fromStatuses: BUILD_STARTABLE,
      toStatus: "queued",
    });
    if (!claimed) {
      const row = await deps.repo().getSession(s.id);
      if (row === null) return "missing";
      s.status = row.status;
      s.error = row.error;
      return row.status;
    }

    // Claim 先于 task，保证另一个 worker 即使持有陈旧 Session 投影，也无法
    // 启动第二条付费 DAG。pipeline 一进入就把 token 捕获到局部变量中。
    await deps.refreshFilesProjection(s);
    if (s.files.length === 0) {
      await deps.repo().releaseBuildLease(s.id, { owner: leaseOwner });
      await deps.repo().claimSessionStatus(s.id, {
        fromStatuses: ["queued"],
        toStatus: "idle",
      });
      return "no_files";
    }
    s.status = "queued";
    s.error = "";
    s.buildLeaseOwner = leaseOwner;
    try {
      const controller = new AbortController();
      s.runTask = makeRunHandle(
        () => runPipeline(s, deps, { tier, controller }),
        controller,
      );
    } catch (exc) {
      await deps.repo().releaseBuildLease(s.id, { owner: leaseOwner });
      s.buildLeaseOwner = "";
      await deps.repo().claimSessionStatus(s.id, {
        fromStatuses: ["queued"],
        toStatus: "failed",
        error: "后台任务未能启动",
      });
      throw exc;
    }
    return "";
  });
  return outcome === "" ? "started" : outcome;
}

/**
 * 梳理被用户喊停时的收尾：状态落成 `stopped`，发一条事件让前端把箭头收回。
 *
 * 不是 `failed`（没出错，是人喊停），也不回 `idle`（idle 的文案是"待上传"，
 * 材料明明在）。`stopped` 是"跑到一半被停、可以重跑"的独立状态。
 */
export function onRunCancelled(s: SessionLike): void {
  s.status = "stopped";
  s.emit("run.cancelled", { reason: "用户停止" });
}

// ══════════════════════════════════════════════════════════════════
//  _run_pipeline
// ══════════════════════════════════════════════════════════════════

const SCAN_EXT: readonly string[] = [
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
];

/**
 * 跑真正的 Harness：解析 → 切段 → DAG 调度抽取 → 合并 → 下游确定性环节。
 *
 * 抽取**不是一次大调用**。语料按 sheet/章节切段后 fan-out 成多个 DAG 节点，
 * 每个节点内部是带工具的 agent loop、出来还要过 critic。这是唯一能处理真实
 * 材料的形态 —— 一次性把几百个切片丢给模型，八成内容会被截掉，而流水线
 * 还会一路绿灯跑完。
 */
export async function runPipeline(
  s: SessionLike,
  deps: PipelineDeps,
  opts: { tier?: string; controller: AbortController },
): Promise<void> {
  const tier = opts.tier ?? "full";
  const signal = opts.controller.signal;
  const persistDeps: PersistDeps = {
    repo: deps.repo,
    now: deps.now,
    persistDecisions: deps.persistDecisions,
  };

  let backend: Gateways["backend"] = null;
  let budget: Gateways["budget"] | null = null;
  let repoRunId: string | null = null;
  const leaseOwner = s.buildLeaseOwner;
  let heartbeatDone: Promise<void> | null = null;
  const heartbeatStop = new AbortController();

  const heartbeat = async (): Promise<void> => {
    for (;;) {
      await sleep(deps.buildHeartbeatInterval(), heartbeatStop.signal);
      if (heartbeatStop.signal.aborted) return;
      const renewed = await deps.repo().renewBuildLease(s.id, {
        owner: leaseOwner,
        now: deps.now(),
        ttl: deps.buildLeaseTtl(),
      });
      if (!renewed) {
        const row = await deps.repo().getSession(s.id);
        // A successful owner-fenced terminal checkpoint intentionally makes
        // renew ineligible.  That is normal completion, not cancellation.
        if (row !== null && ["awaiting_answer", "done", "failed"].includes(row.status)) return;
        // Durable stop intent, lease takeover/expiry, or session deletion fences
        // this invocation.  Cancellation is cooperative but reaches every await.
        opts.controller.abort();
        return;
      }
    }
  };

  /** Run 收尾/节点边界的落盘。见文件头第 2 条 —— Recorder 不代劳。 */
  const flushJournal = async (gw: Gateways["gw"] | null): Promise<void> => {
    if (gw !== null) await gw.rec.journal.flush();
  };

  let gw: Gateways["gw"] | null = null;
  try {
    // The route already created this invocation-specific lease.  Capturing it in a
    // local variable avoids ABA if a stopped run is immediately restarted in the
    // same worker and mutates `s.build_lease_owner`.
    if (
      !leaseOwner ||
      !(await deps.repo().renewBuildLease(s.id, {
        owner: leaseOwner,
        now: deps.now(),
        ttl: deps.buildLeaseTtl(),
      }))
    ) {
      throw new RunCancelled();
    }
    heartbeatDone = heartbeat();
    fireAndForget(heartbeatDone);

    repoRunId = await deps.repo().nextRun(s.id, `build:${tier}`);
    checkCancelled(signal);
    s.status = "parsing";
    s.emit("node.entered", { node: "PARSE", title: "解析材料" });
    // 余额偏低要在开跑的第一秒说，不是在跑了三分钟、花了两美元之后说。放在
    // 解析前面是因为这时候还什么都没花，用户看到提醒可以直接停下来去充值。
    await deps.warnLowBalance(s);
    checkCancelled(signal);
    await deps.ensureCatalog(); // 按网关可用模型过滤目录（视觉网关/OCR 靠它）
    checkCancelled(signal);
    // resume=true：这条 Run 的日志还在盘上就接着用。上次跑到一半崩了/被停了，
    // 已完成的模型调用直接从日志读回，不重花钱；语料变了 run_id 就变了，
    // 不会误用旧结果。
    const runId = deps.runIdFor(s);
    const resumed = existsSync(join(s.dir, "journal", `${runId}.jsonl`));
    const gws = deps.gateways(s.dir, runId, {
      resume: resumed,
      sessionId: s.id,
      kind: "build",
      owner: s.owner,
    });
    backend = gws.backend;
    gw = gws.gw;
    budget = gws.budget;
    if (resumed) {
      s.emit("flow.step", {
        cite: "",
        found: "上次这批材料跑到一半中断了，已完成的部分直接接着用，不重跑。",
      });
    }

    const paths = s.files.map((f) => {
      if (!("path" in f)) throw new Error("KeyError: 'path'");
      return String(f["path"]);
    });
    // 图片和 PDF 的无文本页要过视觉模型，一页可能几十秒。不预告的话界面上就是
    // "解析中"一动不动。电子 PDF 会先直接读文本层，不能再把它说成必然整本 OCR。
    const scans = paths.filter((p) => SCAN_EXT.includes(suffixLower(p)));
    if (scans.length > 0) {
      const vis = deps.catalog().byCapability()["vision"] ?? [];
      s.emit("flow.step", {
        cite: "",
        found:
          `${scans.length} 份图片/PDF 将先读取原生内容；只有图片和 PDF 的无文本页` +
          `才用视觉模型识别（` +
          (vis.length > 0
            ? `可用：${vis.slice(0, 3).join("、")}`
            : "⚠ 网关上没有带视觉的模型，识别会失败") +
          "），单页可能要几十秒。",
      });
    }
    // 识别进度直接投影进推理面板：一页要几分钟，不报进度的话那几分钟里界面
    // 是死的，用户分不清在识别、还是又挂了。
    const docs: ParsedDoc[] = await deps
      .registry({
        visionGateway: gws.smart,
        visionProgress: (msg: string) => {
          s.emit("flow.step", { cite: "", found: msg });
        },
      })
      .parseAll(paths, { continueOnError: true });
    checkCancelled(signal);
    const index = deps.buildIndex(docs);
    const endpoints = deps.collectEndpoints(docs);
    const profiles = deps.collectProfiles(docs);
    // 留给 _recompile —— 没有它们，重出模板时接口反推那类冲突会凭空消失，
    // 用户会以为"改了个决定，怎么少了几条冲突"。
    s.state["_endpoints"] = endpoints;
    s.state["_profiles"] = profiles;
    // 对话侧的推理循环要靠它检索材料。不存的话对话只能凭 OIR 说话，
    // 而"这句话在材料哪里"恰恰是 FDE 最常问的。
    s.state["_index"] = index;
    const summary = deps.corpusSummary(docs);
    s.state["corpus"] = summary;
    s.state["_chunks"] = deps.chunkCache(docs);
    await deps.buildFlowDiagram(s, docs);
    await persist(s, persistDeps, { leaseOwner });
    await flushJournal(gw); // 节点边界
    s.emit("node.completed", {
      node: "PARSE",
      stats: {
        files: paths.length,
        chunks: index.length,
        endpoints: endpoints.length,
        profiles: countOf(profiles),
      },
      findings: (summary as Record<string, unknown>)["findings"],
    });

    // 免费流程预览：流程图已出，到此为止 —— 不进 EXTRACT 那条付费 DAG。
    // 文本/表格/SQL 语料到这里零模型成本；扫描件/PDF 因视觉解析会有少量费用。
    if (tier === "flow_preview") {
      s.status = "done";
      await persist(s, persistDeps, { leaseOwner });
      const flow = (s.state["flow"] as Record<string, unknown> | undefined) ?? {};
      const fstats = (flow["stats"] as Record<string, unknown> | undefined) ?? {};
      s.emit("run.completed", { stats: { tier: "flow_preview", ...fstats } });
      // 免费档不跑 critic，本轮没有扛过评审的教训可留，所以传空。但这个出口
      // 和另外两个一样要走同一条收尾路径：哪天这一档也开始产教训，要改的是
      // lessons 的取值，而不是"记得在这儿补一次写入"。
      await deps.rememberRunLessons(s, [], { runId });
      await flushJournal(gw); // Run 收尾
      await deps.repo().finishRun(repoRunId, { status: "done" });
      fireAndForget(deps.emitAiPrompts(s, { slot: "opening" }));
      return;
    }

    // ── 切段并冻结计划 ─────────────────────────────────────
    const segments = deps.segmentCorpus(index, docs);
    // 产品主线使用完整 FDE Engagement DAG 作为稳定的控制面：材料内容只能
    // 决定某个节点看哪些证据，不能增删角色、工具或跳过 HITL/Review/Export。
    // 现有 EXTRACT fan-out 是 PROCESS/DATA/RULES 节点内部的数据并行实现，
    // 不是另一条偷偷存在的产品流程。
    const engagement = deps.harness.engagementDag();
    s.emit("engagement.frozen", {
      version: engagement.name,
      nodes: engagement.describe(),
      current: "PROCESS",
    });
    s.emit("plan.frozen", {
      segments: segments.map((g) => ({
        key: g.key,
        label: g.label,
        file: g.fileName,
        chunks: g.chunkIds.length,
      })),
      note: "段数来自材料结构（有几个 sheet/章节），不来自内容 —— 计划冻结成立",
    });
    if (segments.length === 0) {
      // 「材料里没有可抽取的内容」对着一份明明有内容的流程图说，等于什么都
      // 没说 —— 真正发生的多半是**上游没读出东西**（扫描件识别失败/超时）。
      // 把每份材料的实际情况和解析阶段的告警一起说出来，别让人去猜。
      const detail =
        docs.map((d) => `${d.file_name} 读出 ${d.chunks.length} 段`).join("；") || "没有材料";
      const warns = docs.flatMap((d) =>
        d.findings
          .filter((f) => [
            "vision_failed", "empty_ocr", "no_vision_model", "parse_failed", "unsupported",
          ].includes(f.kind))
          .map((f) => f.message),
      );
      throw new Error(
        "没有可抽取的内容：" +
          detail +
          (warns.length > 0
            ? "。原因：" + warns.slice(0, 3).join("；")
            : "。材料可能是空的，或格式无法解析。"),
      );
    }

    // ── 装配 Harness ───────────────────────────────────────
    s.status = "extracting";
    const system = deps.harness.extractorSystem();

    const bus = new AgentBus(gw.rec);
    // HTTP 服务绝不把宿主 LocalSubprocessSandbox 暴露给不可信材料。确需
    // CodeAct 的部署必须显式开启，并且 production=true 会 fail-closed
    // 地选择 gVisor；运行时缺失时执行失败，不会退回本机子进程。
    const tools = await deps.harness.buildTools({ evidence: index, profiles });
    bus.board.write("_tools", tools, { by: "bootstrap" });

    // 项目记忆挂上 L3：同项目别的会话攒下的约定与教训，在这里才真的能被召回。
    // 两档都挂 —— 参考档的降权与来源标注在 MemoryItem.render / recall 里做，
    // 不靠调用方自觉，所以这里不需要（也不应该）先把它筛掉。
    const pmem: ProjectMemoryLike | null = s.projectId
      ? await deps.projectMemory(s.projectId)
      : null;
    const cm: ContextManagerLike = deps.harness.makeContext({
      system,
      evidence: index,
      longTerm: pmem !== null ? pmem.store : null,
    });
    // 对话里拍下的板要真的作用到每个抽取节点上。ContextManager 是 Run 作用域
    // 的局部对象，HTTP 层碰不到它 —— 所以必须在这里、Run 起来的时候灌进去。
    // 不灌的话，"我记下了你的口径约定"就是一句空话：它躺在会话状态里，
    // 一个节点也看不见。
    const dm = deps.stateDialogue(s);
    for (const d of dm !== null ? dm.activeDecisions() : []) {
      cm.reflect(`用户已拍板：${d.render()}`);
    }
    // 也挂到黑板上 —— 黑板事实会随 bus.render_facts() 进下一个节点的 prompt，
    // 和 L3 是两条独立通路，任何一条断了另一条还在。
    (dm !== null ? dm.activeDecisions() : []).forEach((d, i) => {
      bus.post(`decision.${String(d.kind)}.${i}`, d.render(), { by: "user", confidence: 1.0 });
    });
    // 项目权威档和本会话拍的板同等对待，走同样两条通路。**只喂权威档** ——
    // 黑板这条路硬编码 by="user"、confidence=1.0，参考档从这里进去就成了
    // "用户拍板、满置信"，而它其实只是上一个会话里模型的推断。
    (pmem !== null ? pmem.authoritative() : []).forEach((it, i) => {
      cm.reflect(`项目已拍板：${it.content}`);
      bus.post(`project.decision.${i}`, it.content, { by: "user", confidence: 1.0 });
    });
    // 上面这些 reflect 全是**人的**判断。收尾时只把这之后新增的（critic 逼出来
    // 的）写进参考档，否则人拍的板会被复制成一条"参考·未确认"，下一个会话读
    // 起来就成了模型的猜测。
    const seededReflections = new Set(cm.reflections);
    const dag = deps.buildDag(segments);
    const sched = deps.harness.makeExtractRun({
      gw,
      ctx: cm,
      bus,
      budget: gws.budget,
      segments,
      index,
      dag,
    });

    s.emit("node.entered", {
      node: "EXTRACT",
      title: `抽取 · ${segments.length} 段并行`,
      segments: segments.length,
    });
    pumpKernelEvents(s, gw.rec);
    // 抽取是整条链最长的一段。只在开始/结束各泵一次，等于抽取全程「推理」面板
    // 一片空白 —— FDE 看到的是一个转圈的进度条，看不见 AI 在想什么、查了什么，
    // 分不清"在干活"和"卡住了"。这里边跑边泵，让推理实时可见。
    // 用同一个 run_id —— 调度器另起一个 id 的话，恢复索引和它写的日志就对不上，
    // resume 会永远命不中。
    const outcome = await runWithLiveTrace(s, gw.rec, sched.run(runId));
    checkCancelled(signal);

    if (outcome.status !== RunStatus.COMPLETED) {
      throw new Error(`抽取失败：${outcome.error}`);
    }

    const merged = (outcome.outputs["MERGE"] as Record<string, unknown> | undefined) ?? {};
    const dropped: Record<string, unknown> = {};
    const oir = deps.buildOir(merged, index, dropped);
    // **模型抽到了、装配时挂不上，这件事必须说出来。** 属性挂不上父对象、
    // 关系两端对不上名字时只能丢（挂错父亲比不挂更糟），但丢得无声无息的话，
    // FDE 看见推理面板里模型说抽了 40 个字段、产物里只有 3 个，会归因成
    // "模型不行" —— 而真实原因是名字对不齐，是能修的。
    if (truthy(dropped["properties"]) || truthy(dropped["links"])) {
      s.emit("extract.dropped", {
        properties: dropped["properties"] ?? 0,
        links: dropped["links"] ?? 0,
        unknown_parents: ((dropped["property_parents"] as unknown[] | undefined) ?? []).slice(0, 12),
        unknown_endpoints: ((dropped["link_endpoints"] as unknown[] | undefined) ?? []).slice(0, 12),
      });
    }
    const staleOir = deps.replayOirPatches(s, oir);
    if (staleOir.length > 0) {
      s.emit("oir.stale_edits", {
        count: staleOir.length,
        items: staleOir.map((x) => ({ op: x["op"], why: x["why"] })),
      });
    }
    // 流程图和接口清单在这里接起来。图是 PARSE 阶段就出的（那时还没有 OIR），
    // 所以只能等到这一步：每个流程环节标上实现它的接口，接完再重出一次产物。
    const linkGaps = deps.linkFlowToApi(s, oir);
    // 待澄清问题的四个来源在这里合流，客户不需要知道哪条是谁提的：
    //   · 材料里本来就有的问卷（规则逐行搬进来的，asked_by=customer）
    //   · 流程图上标黄的缺口 —— 不只画图，还指出图里哪儿是空的
    //   · 流程与接口对不上的地方 —— 哪一步没有系统支撑、哪个写接口不在流程里
    //   · 从证据里挖的缺口 —— 占位符、空表、待确认的取值清单、结构空位
    // 后两条以前都不存在：材料没带问卷时，这张表就只剩三四行系统自问自答。
    const mined = deps.mineQuestions(oir, {
      docs,
      chunks: index.allChunks(),
      extra: [...((s.state["_flow_gaps"] as unknown[] | undefined) ?? [])],
      extraGaps: linkGaps,
    });
    for (const q of mined) {
      if (!hasQuestion(oir.questions, q.rid)) oir.addQuestion(q);
    }
    s.emit("gaps.mined", {
      count: mined.length,
      groups: sortedCp(new Set(mined.filter((q) => truthy(q.group)).map((q) => q.group!))).slice(
        0,
        12,
      ),
    });
    s.emit("node.completed", {
      node: "EXTRACT",
      stats: oir.stats(),
      segments: segments.length,
      usd: pyRound(spentUsd(gws.budget), 4),
    });
    await flushJournal(gw); // 节点边界

    // ── 下游：全部确定性 ───────────────────────────────────
    s.emit("node.entered", { node: "FINISH", title: "对齐 → 冲突 → 澄清 → 模板" });
    s.emit("engagement.stage", {
      node: "GAP",
      deps: ["PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS"],
    });
    const res = deps.finish(oir, {
      endpoints,
      profiles,
      project: s.project || s.title,
    });
    const conflicts: ConflictLike[] = res.conflicts;
    const kinds: Record<string, number> = {};
    for (const c of conflicts) {
      const k = String(c.kind);
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    s.emit("node.completed", {
      node: "ALIGN",
      stats: res.align,
      merged: res.merged,
      uncertain: res.uncertain,
    });
    s.emit("node.completed", {
      node: "CONFLICT",
      kinds,
      auto_repaired: res.auto_repaired,
      conflicts: conflicts.map((c) => conflictToDict(c as Conflict)),
    });

    const cs = res.clarify;
    // 对齐拿不准的那几对进问题清单。**必须在 to_dict 之前加** —— 晚一行就
    // 只存在于内存里，落库的那份没有它们。
    //
    // 这些是「这俩是不是一个东西」，FDE 一天问上百次的那类问题。以前 align
    // 把它们压进 uncertain 就到此为止：只进了一条事件载荷，没有任何界面消费。
    // 系统比对了上千对、看出来了，然后一句话没说。
    const alignQs = (res.align_gaps ?? []).map((g) => gapToQuestion(g as Gap));
    for (const q of alignQs) {
      if (!hasQuestion(oir.questions, q.rid)) oir.addQuestion(q);
    }
    if (alignQs.length > 0) {
      s.emit("gaps.mined", { count: alignQs.length, groups: ["同义对象"] });
    }
    s.state["oir"] = oir.toDict();
    s.state["conflicts"] = conflicts.map((c) => conflictToDict(c as Conflict));
    // `clarify.Question` 是**普通接口**，转换器是模块级的 questionToDict ——
    // 它跟 `onto/questions.ts` 那个有 toDict 方法的 Question 类同名不同物。
    // 这里原来写的是 `(q as { toDict(): unknown }).toDict()`：tsc 被 as 骗过，
    // 而只要这批冲突里真有 ask_user 的（材料够复杂时必然有），运行时就是
    // `TypeError: q.toDict is not a function`，整条梳理在抽取完成之后炸掉 ——
    // 钱已经花完了才失败。空数组时 map 不执行，所以它能一路潜伏到真材料上。
    s.state["questions"] = cs.questions.map((q) => questionToDict(q));
    s.state["routing"] = clarificationSummary(cs as ClarificationSet);
    s.state["budget"] = snapshotOf(gws.budget);
    s.state["_oir"] = oir;
    s.state["_conflicts"] = conflicts;
    s.state["suggestions"] = res.suggestions ?? [];
    const backlog = await deps.syncQuestionBacklog(s, {
      oir,
      clarification: cs.questions,
      conflicts,
    });
    s.emit("clarify.request", { questions: s.state["questions"], routing: clarificationSummary(cs as ClarificationSet) });
    // 梳理挂起等 FDE 拍板 —— 这正是他下一步要问的时候，出一版结合全量产物的开场。
    fireAndForget(deps.emitAiPrompts(s, { slot: "opening" }));
    if (truthy(s.state["suggestions"])) {
      // 建议不阻塞 —— 单独发一条事件，前端另起一栏，不要塞进问题流里让人
      // 误以为必须先答完才能继续。
      s.emit("suggest.ready", { suggestions: s.state["suggestions"] });
    }

    // ── 可执行的产品 Engagement DAG ───────────────────────────
    // 成熟 EXTRACT fan-out 已完成唯一一轮付费材料理解。专业节点以它的 OIR/Flow
    // 为 seed，通过规则型 skip_model 形成各自契约；但节点调度、checkpoint、HITL
    // 与 release gate 都是真实 Scheduler 执行，而不是 UI 进度事件的模拟。
    const runtime = {
      sessionId: s.id,
      project: s.project || s.title,
      oir,
      flow: s.state["_flow"],
      backlog,
      decisions: [...((s.state["decision_ledger"] as unknown[] | undefined) ?? [])],
      corpus: (s.state["corpus"] as Record<string, unknown> | undefined) ?? {},
      artifactRevision: Math.trunc(Number(s.state["artifact_revision"] ?? 0) || 0),
      // Recorder 重放要求输出确定。会话创建时刻对同一语料 run 始终稳定。
      generatedAt: pyIsoUtc(s.created),
      releaseDownloadable: await writable(s.dir),
      // 降级过就让产物自己说出来（budget.ts 的注释承诺过的那个标记）
      skippedReviews: gws.budget.skippedReviews(),
    };
    // The question/decision API must resume this exact content-addressed
    // Recorder after INTERVIEW.  Persist the identity with the suspended
    // session; deriving it again after files change would target another run.
    s.state["engagement_run_id"] = runId;
    const engagementSched = deps.harness.makeEngagementRun({
      gw,
      ctx: cm,
      bus,
      budget: gws.budget,
      runtime,
      dag: engagement,
    });
    const engagementOutcome = await runWithLiveTrace(s, gw.rec, engagementSched.run(runId));
    checkCancelled(signal);
    s.state["engagement_execution"] = {
      status: String(engagementOutcome.status),
      completed: sortedCp(Object.keys(engagementOutcome.results)),
      restored: sortedCp(engagementOutcome.skipped),
      pendingHuman: engagementOutcome.pendingHuman,
    };
    if (engagementOutcome.status === RunStatus.SUSPENDED) {
      s.status = "awaiting_answer";
      const pendingHuman = engagementOutcome.pendingHuman ?? {};
      s.emit("engagement.stage", {
        node: "INTERVIEW",
        contract: "QuestionBacklog",
        pending: truthy(pendingHuman["pending"])
          ? Math.trunc(Number(pendingHuman["pending"]))
          : deps.pendingQuestions(s).length,
      });
      s.emit("run.suspended", { reason: "等待 FDE 拍板" });
      // OIR、冲突与问题在等待人回答前必须是同一个持久检查点。以前持久化发生
      // 在这些字段赋值之前，主 HITL 路径一重启就只剩旧版本。
      await persist(s, persistDeps, { leaseOwner });
      // 挂起等人回答也是一次 run 的结束。放在 persist **之后**：这里写的是
      // 项目记忆表，和会话检查点不是一回事，不共用租约，也就不会因为写它而
      // 触发 persist 那条"租约没了就 CancelledError"的路（那会被上面当成
      // 用户点了停止）。
      await deps.rememberRunLessons(
        s,
        cm.reflections.filter((r) => !seededReflections.has(r)),
        { runId, pm: pmem },
      );
      await flushJournal(gw); // Run 收尾
      await deps.repo().finishRun(repoRunId, {
        status: "suspended",
        budget: snapshotOf(gws.budget) as JsonObject,
      });
      return;
    }
    if (engagementOutcome.status !== RunStatus.COMPLETED) {
      throw new Error(`FDE Engagement 失败：${engagementOutcome.error}`);
    }
    const exportPlan =
      (engagementOutcome.outputs["EXPORT"] as Record<string, unknown> | undefined) ?? {};
    if (
      !(
        truthy(exportPlan["review_passed"]) &&
        truthy(exportPlan["schema_valid"]) &&
        truthy(exportPlan["downloadable"])
      )
    ) {
      throw new Error("FDE Engagement EXPORT 硬门未通过，已阻止交付");
    }
    s.state["release_state"] = truthy(exportPlan["releaseState"])
      ? String(exportPlan["releaseState"])
      : "RELEASED";
    s.emit("engagement.stage", {
      node: "EXPORT",
      contract: "OntologyPackage.v1",
      artifacts: exportPlan["artifacts"] ?? [],
    });
    // 只有 REVIEW/EXPORT gate 已提交，现有原子 release 边界才真正写盘。
    await deps.compile(s, { leaseOwner });
    // 正常收尾这一个出口。同样在 compile 的 persist 之后、finishRun 之前。
    await deps.rememberRunLessons(
      s,
      cm.reflections.filter((r) => !seededReflections.has(r)),
      { runId, pm: pmem },
    );
    await flushJournal(gw); // Run 收尾
    await deps.repo().finishRun(repoRunId, {
      status: "done",
      budget: snapshotOf(gws.budget) as JsonObject,
    });
  } catch (exc) {
    if (isCancelled(exc)) {
      // 用户点了停止 —— CancelledError 是 BaseException，不会被下面的
      // `except Exception` 吞掉。收尾后**照常重抛**，让任务干净地结束。
      // A remote /stop already owns the durable `stopped` state.  Local cancellation
      // projects it in memory.  Do not write status *or documents* here: the lease may
      // have expired and a new invocation may already own the session.  Any unfenced
      // cleanup write could stop or overwrite that newer run (classic stale writer).
      onRunCancelled(s);
      const row = await deps.repo().getSession(s.id);
      if (row !== null) {
        s.status = row.status;
        s.error = row.error;
      }
      if (repoRunId !== null) {
        await deps.repo().finishRun(repoRunId, { status: "failed", error: "cancelled" });
      }
      throw exc;
    }
    // 服务边界，错误要送到前端而不是吞掉
    s.status = "failed";
    const name = exc instanceof Error ? exc.name : typeof exc;
    const msg = exc instanceof Error ? exc.message : String(exc);
    s.error = `${name}: ${msg}`;
    // 钱的问题要说人话，而且**两种"钱不够"要分开说**（契约第 2 节）：
    // 网关欠费该去充值，本地上限用满只该去设置里调 —— 说反了，用户会给一个
    // 一分钱没少的账户充钱。默认分支保持原样：不是钱的问题就别扯到钱上。
    const [sig, detail] = deps.moneyFailure(exc);
    if (sig === "quota") {
      s.error = quotaExhaustedText(detail);
      s.emit("quota.exhausted", { message: s.error, detail });
    } else if (sig === "cap") {
      const usdCap = budget !== null ? budget.limit("usd") : deps.usdCap();
      const spent = budget !== null ? budget.spent("usd") : usdCap;
      s.error = budgetCappedText({ spent, cap: usdCap, scope: "build" });
      s.emit("budget.capped", { message: s.error, spent, cap: usdCap, scope: "build" });
    }
    s.emit("run.failed", { error: s.error });
    try {
      await persist(s, persistDeps, { leaseOwner });
    } catch (inner) {
      if (isCancelled(inner)) {
        // A durable stop/stale-owner fence already chose the public status.
        if (repoRunId !== null) {
          await deps.repo().finishRun(repoRunId, {
            status: "failed",
            error: "cancelled",
            budget: (budget !== null ? snapshotOf(budget) : {}) as JsonObject,
          });
        }
        throw inner;
      }
      throw inner;
    }
    if (repoRunId !== null) {
      await deps.repo().finishRun(repoRunId, {
        status: "failed",
        error: s.error,
        budget: (budget !== null ? snapshotOf(budget) : {}) as JsonObject,
      });
    }
  } finally {
    heartbeatStop.abort();
    if (heartbeatDone !== null) await heartbeatDone.catch(() => undefined);
    // 失败与取消同样是 Run 的结束，日志一样要落盘 —— 否则下一次 resume 看到的是一个
    // 残缺的 Run，已经付过钱的节点会被当成没跑过。**吞掉 flush 自己的异常**：
    // 落盘失败不能盖掉上面那个真正的错误（用户要看的是"为什么失败"，不是"日志写不下"）。
    if (gw !== null) await gw.rec.journal.flush().catch(() => undefined);
    if (leaseOwner) {
      await deps.repo().releaseBuildLease(s.id, { owner: leaseOwner });
      if (s.buildLeaseOwner === leaseOwner) s.buildLeaseOwner = "";
    }
    if (backend !== null) await backend.aclose();
  }
}

// ══════════════════════════════════════════════════════════════════
//  小助手
// ══════════════════════════════════════════════════════════════════

/** `oir.questions` 在 Python 侧是 dict；TS 侧可能是 Map，两种都认。 */
function hasQuestion(
  questions: Map<string, QuestionLike> | Record<string, QuestionLike>,
  rid: string,
): boolean {
  return questions instanceof Map ? questions.has(rid) : rid in questions;
}

/** `len(profiles)` —— profiles 在 Python 侧是 dict/list，两种都要能数。 */
function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (typeof v === "object" && v !== null) return Object.keys(v).length;
  return 0;
}

function snapshotOf(budget: Gateways["budget"]): Record<string, unknown> {
  return { ...budget.snapshot() };
}

/** `budget.snapshot()["spent"]["usd"]`。 */
function spentUsd(budget: Gateways["budget"]): number {
  const snap = budget.snapshot() as unknown as Record<string, unknown>;
  const spent = (snap["spent"] as Record<string, unknown> | undefined) ?? {};
  return Number(spent["usd"] ?? 0);
}

/** `os.access(dir, os.W_OK)`。 */
async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, FS.W_OK);
    return true;
  } catch {
    return false;
  }
}
