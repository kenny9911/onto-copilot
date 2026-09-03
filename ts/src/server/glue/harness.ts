/**
 * `_run_pipeline` 装配 agent 运行环境的那一段（`server.py` 2296–2346 与
 * 2460–2493）—— 也就是 `PipelineDeps.harness` 那五个端口的真身。
 *
 * ── 为什么 Python 侧没有同名函数 ────────────────────────────────────────
 *
 * `harness.build_tools` / `extractor_system` / `make_context` /
 * `make_extract_run` / `make_engagement_run` 是 **TS 侧自己起的端口名**。Python
 * 里这五件事是 `_run_pipeline` 函数体中间的二十来行直白代码：取 agent 与技能库
 * 拼 system、按开关探沙箱后装配工具注册表、建 ContextManager、把
 * AgentLoop + Scheduler 拼起来跑抽取、再拼一次跑 engagement。
 *
 * TS 侧把 `_run_pipeline` 拆进了 `server/pipeline/run.ts`，而这二十行牵扯
 * `kernel/{agents,skills,tools,critic,loop,scheduler,memory/context}` 与
 * `onto/{pipeline,engagement_runtime}` 十个模块 —— 段 D 并行开发时它们还不存在，
 * 于是收成了一个整块端口。这里把它填上。
 *
 * ── `code.exec` 的存在与否是**动作空间**的事，不是调用结果的事 ──────────
 *
 * 开关没开、这台机器上没有容器运行时 —— 两种"没有"都必须让 `code.exec`
 * **不出现在动作空间里**，而不是出现之后调用才报错：一个注册了却必然失败的工具，
 * 模型会把失败回执读成"参数写错了"然后反复重试，把预算烧光，而每一轮都真花钱。
 * 这条判据落在 `glue/tools.ts` 的 `sandboxForTools()` + `builtinRegistry()` 里，
 * 这里只负责把它们串起来。
 *
 * ── 与 Python 的一处签名差异 ────────────────────────────────────────────
 *
 * Python 的 `default_sandbox(production=True)` 是同步的（它只是挑一个本机运行时）；
 * TS 这边要**探一次容器运行时在不在**，是异步的。所以 {@link HarnessPort.buildTools}
 * 落成 async，`run.ts` 那一处调用点跟着 `await`。行为不变：探测在装配工具之前
 * 完成，探不到就等于没有沙箱。
 */

import { defaultAgents, renderSystem } from "../../kernel/agents.js";
import { CriticPanel } from "../../kernel/critic.js";
import { AgentLoop } from "../../kernel/loop.js";
import { ContextManager } from "../../kernel/memory/context.js";
import type { EvidenceIndex } from "../../kernel/memory/evidence.js";
import { Scratchpad } from "../../kernel/memory/short_term.js";
import { Scheduler } from "../../kernel/scheduler.js";
import { defaultLibrary } from "../../kernel/skills.js";
import { buildFdeEngagementDag } from "../../onto/engagement.js";
import {
  EngagementRuntimeInput,
  engagementCritics,
  engagementHandlers,
} from "../../onto/engagement_runtime.js";
import { CoverageCritic, handlersFor, provenanceCritic } from "../../onto/pipeline.js";
import type { Segment, SegmentIndex } from "../../onto/pipeline.js";
import type { HarnessPort } from "../pipeline/types.js";
import { builtinRegistry, sandboxForTools } from "./tools.js";
import { seam } from "./deps.js";

/**
 * `agent.render_system(skills) + "\n\n" + skills.load(list(agent.skills))`
 * （`server.py:2297`）。
 *
 * 两段是**两件事**：`render_system` 只把技能的**摘要**列进角色说明，`skills.load`
 * 把这个 agent 声明用到的那几篇技能**全文**贴进来。少了后半段，模型知道有这么
 * 一门技能却读不到它的做法。
 */
function extractorSystem(): string {
  const agent = defaultAgents().get("extractor");
  const skills = defaultLibrary();
  return `${renderSystem(agent, skills)}\n\n${skills.load([...agent.skills])}`;
}

/** `PipelineDeps.harness` 的真身。 */
export const HARNESS: HarnessPort = {
  // `codeact_enabled ? default_sandbox(production=True) : None` +
  // `builtin_registry(evidence=…, profiles=…, sandbox=…)`（server.py:2305）。
  async buildTools(opts) {
    return builtinRegistry({
      evidence: seam<EvidenceIndex>(opts.evidence),
      oir: seam(opts.oir ?? null),
      profiles: seam<Record<string, unknown> | null>(opts.profiles ?? null),
      sandbox: opts.codeact === false ? null : await sandboxForTools(),
    });
  },

  extractorSystem,

  // `ContextManager(system=…, evidence=index, budget_tokens=90_000, long_term=…)`
  // （server.py:2316）。90k 是写死的：抽取节点的上下文预算不跟着模型窗口走，
  // 换个窗口更大的模型不该让每个节点悄悄贵一倍。
  makeContext(opts) {
    return new ContextManager({
      system: opts.system,
      evidence: seam<EvidenceIndex>(opts.evidence),
      budgetTokens: 90_000,
      longTerm: seam<null>(opts.longTerm ?? null),
    });
  },

  // `CriticPanel + AgentLoop + Scheduler(concurrency=4)`（server.py:2338–2345）。
  makeExtractRun(opts) {
    const segments = seam<readonly Segment[]>(opts.segments);
    const index = seam<SegmentIndex>(opts.index);
    // 两个视角是**规则型**的（零模型调用）：覆盖度看这一段的证据有没有被引用，
    // 出处看每条断言是不是都带 file!locator。它们挡的是"抽得又快又多但没有一条
    // 说得出出处"那种产物。
    const panel = new CriticPanel(
      // provenance 也拿索引：不给索引它只判「字段非空」，而**格式对、却在索引里
      // 指不到切片**的 cite 正是「证据 = 它自己的名字」那种静默退化的来源。
      { coverage: new CoverageCritic(segments, index), provenance: provenanceCritic(seam(opts.index)) },
      seam(opts.gw.rec),
    );
    const loop = new AgentLoop({
      gateway: seam(opts.gw),
      ctxManager: seam(opts.ctx),
      panel,
      bus: seam(opts.bus),
      recorder: seam(opts.gw.rec),
      budget: opts.budget,
      // system 与 extractorSystem() 是同一份字符串：handler 拿它当节点 system，
      // ContextManager 拿它当 L0。分别算两遍就会在改角色说明时漏掉一处。
      handlers: handlersFor(segments, index, defaultAgents().get("extractor"), extractorSystem()),
      newScratchpad: (t) => new Scratchpad({ budgetTokens: t }),
    });
    return new Scheduler(
      seam(opts.dag),
      loop,
      seam(opts.gw.rec),
      seam(opts.bus),
      opts.budget,
      { concurrency: 8 },
    );
  },

  engagementDag: (opts) => buildFdeEngagementDag(null, opts ?? {}),

  // `EngagementRuntimeInput + AgentLoop(engagement_handlers) + Scheduler`.
  // Professional nodes run independent semantic analysis in the initial build;
  // deterministic projections remain their coverage/fail-safe baseline.
  makeEngagementRun(opts) {
    const r = opts.runtime;
    const runtime = new EngagementRuntimeInput({
      sessionId: r.sessionId,
      project: r.project,
      oir: seam(r.oir),
      flow: r.flow,
      backlog: seam(r.backlog),
      decisions: r.decisions,
      corpus: r.corpus,
      artifactRevision: r.artifactRevision,
      generatedAt: r.generatedAt,
      releaseDownloadable: r.releaseDownloadable,
      evidenceRefs: r.evidenceRefs,
      evidenceRecords: r.evidenceRecords,
      materialEvidenceRequired: r.materialEvidenceRequired,
      skippedReviews: r.skippedReviews,
    });
    const loop = new AgentLoop({
      gateway: seam(opts.gw),
      ctxManager: seam(opts.ctx),
      panel: new CriticPanel(engagementCritics(), seam(opts.gw.rec)),
      bus: seam(opts.bus),
      recorder: seam(opts.gw.rec),
      budget: opts.budget,
      handlers: engagementHandlers(runtime, {
        modelAnalysis: true,
        tools: seam(opts.tools ?? null),
        // §7.5 fork：保留节点零模型重放，被 fork 的照常走活模型
        ...(opts.replayOutputs !== undefined ? { replayOutputs: seam(opts.replayOutputs) } : {}),
      }),
      newScratchpad: (t) => new Scratchpad({ budgetTokens: t }),
    });
    return new Scheduler(
      seam(opts.dag),
      loop,
      seam(opts.gw.rec),
      seam(opts.bus),
      opts.budget,
      { concurrency: 8 },
    );
  },
};
