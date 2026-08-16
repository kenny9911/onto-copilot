/**
 * 服务启动器 —— 前后端同进程。移植自 `src/ontocopilot/serve.py`，并且是**整个 TS
 * 服务唯一的接线处**。
 *
 * 前端是纯静态页面，由后端在 `/` 直接吐出来，**不单开一个前端服务器**：
 * 多一个进程就多一份 CORS、端口、部署配置要对齐，而这个 UI 没有构建步骤，
 * 分开跑没有任何好处。
 *
 * ── 为什么接线全挤在这一个文件里 ────────────────────────────────────────
 *
 * 各段（app / session / usage / store/deps / authgate / configapi）都留了
 * `registerXxx()` 注册点，谁来填是个问题。填在各自的模块顶层（import 即生效）会让
 * **import 顺序**变成隐式依赖，测试里 import 一个模块就顺手改了全局；填在
 * 每个调用点又会填好几遍。所以只有这里填，且只在 {@link wireServer} 里填一次 ——
 * 进程入口本来就该是"把零件装起来"的地方。测试要换零件就调
 * {@link registerServerParts}，不必去动被测模块。
 *
 * ── 接线现状：**全部端口都接上了真身** ─────────────────────────────────
 *
 * `server.py` 那批胶水（`_chat_run` / `_hydrate` / `_preparse` /
 * `_question_backlog` / `_sync_question_backlog` / `_recompile` /
 * `_build_flow_diagram` / `_compile` / `_answer_domain_question` /
 * `_builtin_registry` / `_act` / `_export_doc`）分别住在 `server/glue/*.ts` 与
 * `server/routes/questions.ts`；`_run_pipeline` 的正戏（`onto.pipeline` 的四个
 * DAG 入口、`onto.gaps.mine_questions`）直连 `onto/*.ts`；`harness.*` 那五个
 * TS 侧自起的端口名（Python 里是 `_run_pipeline` 函数体中间那二十行）落在
 * `server/glue/harness.ts`。
 *
 * 注意 engagement 的**恢复**那一档不走 `harness.*`：`_resume_engagement_release`
 * 自己就地装配（用的是 ScriptedBackend，见 `glue/engagement.ts` 的说明）。
 *
 * `code.exec` 的沙箱是**可选**的（要显式开 `ONTOCOPILOT_ENABLE_CODEACT`）。
 * **拿不到沙箱时 `code.exec` 不进动作空间**，而不是进了之后每次调用都失败 ——
 * 后者会让模型反复重试一个永远不会成功的工具，把预算烧光。
 *
 * {@link notWired} 保留着：它是**显式抛错**的占位，不是空实现。一个悄悄什么都
 * 不做的 `persist` 会让"梳理跑完了但什么都没存"看起来像成功，而那种失败不会在
 * 日志里留下任何痕迹，只会在几天后表现为"客户说数据没了"。下一个还没落地的端口
 * 照样用它，别改成静默返回空值。
 */

import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { chatUsdCap, installAppConfig, modelOverrides, resolvedLlmConfig } from "./appconfig.js";
import { authMiddleware, authRouter, corsOrigins, usersRouter } from "./authgate.js";
import { configRouter, registerConfigCatalog } from "./configapi.js";
import { ModelCatalog, currentCatalog } from "./kernel/catalog.js";
import { ensureCatalogFromConfig, installCatalogPort } from "./server/catalog_wiring.js";
import { insecureTransport, redactedKey } from "./kernel/config.js";
import { app, registerAuthMiddleware, registerBootReconciler, registerCorsOrigins } from "./server/app.js";
import { startServerLifespan, stopServerLifespan } from "./server/app.js";
import type { AppEnv } from "./server/app.js";
import {
  WORKER_ID,
  chatHeartbeatInterval,
  chatLeaseTtl,
  currentRepo,
  mutationHeartbeatInterval,
  mutationLeaseTtl,
  refreshFilesProjection,
  registerHydrator,
  sessAsync,
} from "./server/session.js";
import { getStore } from "./store/deps.js";
import { registerRepoBuilder } from "./store/deps.js";
import type { Store } from "./store/engine.js";
import { MemoryRepo } from "./store/repo/memory.js";
import { PgRepo } from "./store/repo/pg.js";
import type { Repo } from "./store/repo/protocol.js";
import type { JsonValue } from "./store/types.js";
import { decisionToDialogueDict, makeDecisionRow } from "./store/types.js";
import { registerFileRoutes } from "./server/routes/files.js";
import { autoTitle, registerSessionRoutes } from "./server/routes/sessions.js";
import { registerProjectRoutes, rememberDecision } from "./server/routes/projects.js";
import {
  answerDomainQuestion,
  questionBacklog,
  registerQuestionRoutes,
  type QuestionDeps,
} from "./server/routes/questions.js";
import { registerStreamRoutes } from "./server/routes/stream.js";
import type { CatalogLike, ServerEnv } from "./server/routes/sessions.js";
import type { Session } from "./server/session.js";

// ── 接线要用到的真身 ────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { DialogueMemory } from "./kernel/memory/dialogue.js";
import { budgetCappedText } from "./kernel/gateway_balance.js";
import { Intent, RuleIntentParser, intentParseToDict } from "./kernel/intent.js";
import { defaultLibrary } from "./kernel/skills.js";
import { CHAT_SYSTEM, ConversationAgent } from "./onto/converse.js";
import { buildFdeEngagementDag } from "./onto/engagement.js";
import { buildDag, buildOir, finish, segmentCorpus } from "./onto/pipeline.js";
import { mineQuestions } from "./onto/gaps.js";
import * as exportApi from "./onto/export.js";
import { applyFlowEdit } from "./onto/flow_edit.js";
import { followupPrompts } from "./onto/prompts.js";
import { registerArtifactRoutes } from "./server/routes/artifacts.js";
import { asked, emitAiPrompts, settleFollowups, traceAux } from "./server/routes/prompts.js";
import { contextBrief, registerDialogueRoutes, withSessionMutation } from "./server/dialogue.js";
import { dialogueOf } from "./server/dialogue/memory.js";
import { isBusy } from "./server/dialogue/tools.js";
import type { DialogueDeps } from "./server/dialogue/ports.js";
import {
  PERSISTED,
  PERSISTED_PRIVATE,
  PERSISTED_PRIVATE_DOCS,
  persist as persistCheckpoint,
} from "./server/pipeline/persist.js";
import { pipelineRoutes } from "./server/pipeline/routes.js";
import { claimAndStartBuild } from "./server/pipeline/run.js";
import type { PipelineDeps } from "./server/pipeline/types.js";
import { tablesInText } from "./server/pipeline/tables.js";
import { blocksFromMarkdown } from "./onto/export.js";
import { gateways, moneyFailure } from "./server/usage.js";
import { warnLowBalance } from "./server/usage.js";
import { projectMemory, rememberRunLessons } from "./server/routes/projects.js";
import { buildHeartbeatInterval, buildLeaseTtl, runIdFor } from "./server/session.js";
import { usdCap } from "./appconfig.js";
import { Speaker } from "./kernel/memory/dialogue.js";
import { publishTurn } from "./server/dialogue/memory.js";
import { materialTable } from "./server/pipeline/tables.js";
import * as parseRegistry from "./onto/parse/index.js";

// ── glue：server.py 那批胶水（`server/glue/*.ts`）───────────────────
import { chatRun as glueChatRun } from "./server/glue/chat_run.js";
import { compile as glueCompile, recompile as glueRecompile } from "./server/glue/compile.js";
import type { GlueDeps } from "./server/glue/deps.js";
import {
  buildFlowDiagram,
  linkFlowToApi,
  replayOirPatches,
  rewriteFlowArtifacts,
} from "./server/glue/flow.js";
import { hydrate as glueHydrate } from "./server/glue/hydrate.js";
import { act } from "./server/glue/act.js";
import { exportDoc } from "./server/glue/export_doc.js";
import { HARNESS } from "./server/glue/harness.js";
import { chunkCache, preparse as gluePreparse } from "./server/glue/preparse.js";
import { pendingQuestions, syncQuestionBacklog } from "./server/glue/questions.js";
import { builtinRegistry } from "./server/glue/tools.js";
import { svgToPng } from "./onto/render.js";

// ══════════════════════════════════════════════════════════════════
//  仓储选路
// ══════════════════════════════════════════════════════════════════

/** 按 Store 的模式挑实现。**这是唯一的选路点**（`store/repo.py:3192`）。 */
export function buildRepo(store: Store): Repo {
  return store.engine === null ? new MemoryRepo() : new PgRepo(store.engine);
}

// ══════════════════════════════════════════════════════════════════
//  还没落地的那几段
// ══════════════════════════════════════════════════════════════════

/**
 * 一个还没接线的零件被调用了。
 *
 * **抛，不是静默降级。** 这些占位挡的是"梳理跑完但什么都没存""对话记忆一直是空的"
 * 这类失败 —— 它们不会在日志里留下任何痕迹，只会在几天后表现为"客户说数据没了"。
 *
 * 当前**一处都没用到**（所有端口都接上真身了）。留着并导出，是因为它是这一层的
 * 纪律：下一个新增的、还没落地的端口照样填它，而不是填一个静默返回空值的桩。
 */
export function notWired(what: string): never {
  throw new Error(`${what} 还没接线：对应的 TS 模块尚未落地，见 serve.ts 文件头`);
}

/**
 * 跨段的类型接缝。**只是 cast，运行时是同一个对象。**
 *
 * 六个段并行开发时谁也 import 不到别人的 `Session`，于是各自声明了一份结构化的
 * `SessionLike`。它们和真正的 `server/session.ts` 的 `Session` 在**运行时完全
 * 一致**，但结构类型上对不上一处：段 D/E 把 `files` 声明成
 * `Record<string, unknown> & {name: string}`，而 `SessionFile` 是个没有索引签名的
 * interface —— TS 不认后者能赋给前者（`Session` 反过来也缺 `subscribers` 之类）。
 *
 * 写成一个**具名**的接缝而不是散落各处的 `as never`：这样"这里有一处类型没接上"
 * 是能被 grep 出来的一件事，而不是十几处看不出彼此有关的断言。等 server 各段合并
 * 成一份共同的 `Session` 类型之后，删掉这个函数就是那次重构的验收标准。
 */
function seam<T>(v: unknown): T {
  return v as T;
}

/** `time.time()`：**秒**为单位的浮点。整个接线层只有这一个时钟。 */
function now(): number {
  return Date.now() / 1000;
}

/** `uuid.uuid4().hex`。 */
function newToken(): string {
  return randomUUID().replace(/-/g, "");
}

// ══════════════════════════════════════════════════════════════════
//  段 A / 段 F 的两小块胶水（Python 侧住在 server.py，本 track 落地）
// ══════════════════════════════════════════════════════════════════

/**
 * `_persist_decisions`（`server.py:3338`）：增量写决定，已经写过的不重复写。
 *
 * 对齐靠 **ordinal**，不是靠内容比对：同一句口径可以被推翻后又重新拍板，
 * 按内容去重会把第二次那条吃掉，而审计表上就少了一次真实发生的决策。
 */
async function persistDecisions(s: { readonly id: string }, dm: unknown): Promise<void> {
  const repo = currentRepo();
  const have = (await repo.listDecisions(s.id)).length;
  const decisions = (dm as DialogueMemory).decisions;
  for (let i = have; i < decisions.length; i += 1) {
    const d = decisions[i]!;
    await repo.recordDecision(
      s.id,
      makeDecisionRow({
        ordinal: i,
        kind: String(d.kind),
        statement: d.statement,
        scope_refs: [...d.scopeRefs],
        turn_index: d.turnIndex,
        superseded_by: d.supersededBy,
        target_rid: "",
        option_id: "",
        changed: [],
        note: "",
        ts: d.ts,
      }),
    );
  }
}

/**
 * `_restore_dialogue`（`server.py:1739`）：把库里的决定装回对话记忆。
 *
 * 不装的话，"我记下了你的口径约定"在重启之后就成了空话 —— 库里明明有，
 * 但下一次 Run 读的是内存里那份空的 DialogueMemory。
 *
 * **与 Python 的一处实现差异（行为相同）**：Python 是先 `from_dict` 再往
 * `dm._decisions` 上追加尾部；TS 的 `decisionList` 是 private，所以改成
 * **先把尾部并进 dict、再一次 `fromDict`**。`decisionToDialogueDict` 正是为这条路
 * 准备的（键名 kind/statement/scope_refs/turn/ts/superseded_by 逐字对齐）。
 */
async function restoreDialogue(s: Session): Promise<void> {
  const saved = s.state["dialogue"];
  delete s.state["dialogue"];
  let doc: Record<string, unknown> = { turns: [], decisions: [], compactions: 0 };
  if (saved !== null && saved !== undefined && typeof saved === "object" && !Array.isArray(saved)) {
    doc = { ...(saved as Record<string, unknown>) };
  }
  const existing = Array.isArray(doc["decisions"]) ? (doc["decisions"] as unknown[]) : [];
  // dialogue 文档和 decision 表有重叠：前者保留轮次，后者是决定的权威审计表。
  // 只补文档尚未包含的尾部，避免每次 hydrate 都把同一批决定复制一遍。
  const rows = await currentRepo().listDecisions(s.id);
  doc["decisions"] = [...existing, ...rows.slice(existing.length).map(decisionToDialogueDict)];
  try {
    s.state["_dialogue"] = DialogueMemory.fromDict(doc);
  } catch {
    // Python 捕的是 (KeyError, TypeError, ValueError) —— "文档坏了"。坏了要说，
    // 但不能让整个会话打不开：已拍板的决定仍然从审计表恢复得出来。
    s.emit("hydrate.partial", { error: "对话历史格式损坏，已只恢复已拍板决定" });
    doc = { turns: [], decisions: rows.map(decisionToDialogueDict), compactions: 0 };
    s.state["_dialogue"] = DialogueMemory.fromDict(doc);
  }
}

// ══════════════════════════════════════════════════════════════════
//  三个 deps 包
// ══════════════════════════════════════════════════════════════════

/** `_chat_run` 的两个外部依赖。`gateways()` 现取，理由同 {@link glueDeps}。 */
function chatRunDeps(): Parameters<typeof glueChatRun>[1] {
  return { repo: () => currentRepo(), gateways: (dir, runId, o) => gateways(dir, runId, o) };
}

/**
 * `server/glue/*` 那一批胶水共用的接缝。**每次现取** —— 与 {@link dialogueDeps}
 * 同一个理由：租约 TTL 和 repo 实例都会在 lifespan 里被换掉。
 */
function glueDeps(): GlueDeps {
  return {
    repo: () => currentRepo(),
    now,
    persist: (s, opts) =>
      persistCheckpoint(seam(s), { repo: () => currentRepo(), now, persistDecisions }, opts ?? {}),
    projectMemory: (pid) => projectMemory(pid),
    emitAiPrompts: (s, slot) => {
      PARTS.emitAiPrompts(s, slot);
    },
    // `_act`（段 F，server.py:6416）：意图执行器。`START_BUILD` 走的是**七条路由
    // 同一份** `claimAndStartBuild`，`RERUN` 走同一份 `_recompile` —— 各写一份的
    // 症状是"同一句话在聊天里和在排队执行里做的事不一样"。
    act: (s, m) =>
      act(s, m, {
        claimAndStartBuild: (x) => claimAndStartBuild(seam(x), pipelineDeps()),
        recompile: (x) => glueRecompile(x, glueDeps()),
      }),
    publishAssistant: (s, text) => {
      publishTurn(seam(s), dialogueDeps(), Speaker.ASSISTANT, text);
    },
    sessionMutation: (s, kind, body) => PARTS.sessionMutation(s, kind, body),
    restoreDialogue: (s) => restoreDialogue(s),
    preparse: (s) => PARTS.preparse(s),
  };
}

/**
 * 段 E（对话）的 deps。
 *
 * **现取**：`chatLeaseTtl()` 这类值在 lifespan 里会被重算，缓存一份就会在
 * 配置改过之后继续用旧的 TTL —— 症状是租约莫名其妙地早退或续不上。
 *
 * 还没有 TS 对应件的字段一律 {@link notWired}（不是空实现）。当前能真正跑通的
 * 是 `withSessionMutation` 那条路（`/model`、`DELETE`、`/to_work`、`/files`
 * 都走它）；`/chat` 本身会在 `chatRun` 上显式失败。
 */
function dialogueDeps(): DialogueDeps {
  const deps: DialogueDeps = {
    getRepo: () => currentRepo(),
    now,
    workerId: WORKER_ID,
    chatLeaseTtl: chatLeaseTtl(),
    chatHeartbeatInterval: chatHeartbeatInterval(),
    mutationLeaseTtl: mutationLeaseTtl(),
    mutationHeartbeatInterval: mutationHeartbeatInterval(),
    newToken,

    sessAsync: async (sid) => seam(await sessAsync(sid)),
    refreshFilesProjection: (s) => refreshFilesProjection(seam(s)),
    restoreDialogue: (s) => restoreDialogue(seam(s)),
    persist: (s, opts) =>
      persistCheckpoint(seam(s), { repo: () => currentRepo(), now, persistDecisions }, opts ?? {}),
    autoTitle: (s, opts) => autoTitle(seam(s), opts),
    persistedKeys: PERSISTED,
    persistedPrivateKeys: PERSISTED_PRIVATE,
    persistedPrivateDocKeys: PERSISTED_PRIVATE_DOCS,

    chatUsdCap,
    modelOverrides,
    budgetCappedText: (o) => budgetCappedText(o),
    // Python 侧这是 `_chat_run` 里就地的三行（server.py:5734）：
    //   `card = (_CATALOG or ModelCatalog()).get(chosen); model_spec = card.spec if card else None`
    // **必须用过滤过的目录**（`currentCatalog()`，不是 `new ModelCatalog()`）——
    // 内置目录里有而网关上没有的模型会被当成"选得动"，然后每一轮对话都 404。
    modelSpecFor: (chosen) => currentCatalog().get(chosen)?.spec ?? null,
    ensureCatalog: () => ensureCatalogFromConfig(),

    // `IntentParse` 是个纯数据对象（无方法），段 E 声明的 `IntentParseLike` 要
    // `toDict()` —— 这里补上，转换函数用 intent 段那一份，别再写第二个。
    makeParser: (o) => {
      const parser = new RuleIntentParser(o);
      return {
        parse: (text) => {
          const parsed = parser.parse(text);
          return { matches: parsed.matches, toDict: () => seam(intentParseToDict(parsed)) };
        },
      };
    },
    unknownIntent: Intent.UNKNOWN,
    makeAgent: (o) => seam(new ConversationAgent(seam(o))),
    chatSystem: CHAT_SYSTEM,
    chatRun: (s, o, body) =>
      glueChatRun(seam(s), chatRunDeps(), o, (run) => body(seam(run))),

    // `code.exec` **不在**这条路的动作空间里 —— Python 侧同一个调用点
    // （server.py:4692）也没传 sandbox。对话是直接读用户上传材料的地方，
    // 材料里一段伪装成业务说明的指令就能诱导模型去执行代码。
    builtinRegistry: (o) => builtinRegistry({ evidence: seam(o.evidence), oir: seam(o.oir),
      profiles: seam(o.profiles) }),
    preparse: (s, opts) => gluePreparse(seam(s), { vision: seam(opts?.vision ?? null) }),
    // 与 `POST /api/sessions/{sid}/build` **同一份实现**（段 D 的 `pipeline/run.ts`）。
    // Python 侧对话工具、意图动作、HTTP 三个入口调的都是同一个 `_claim_and_start_build`
    // —— 再写一份的结果一定是"从聊天里开始梳理"和"点按钮开始梳理"抢租约的判定
    // 慢慢漂开，而那意味着两条付费 DAG 能同时起来。
    claimAndStartBuild: (s, o) =>
      claimAndStartBuild(seam(s), pipelineDeps(), { tier: o?.tier ?? "full" }),
    recompile: (s) => glueRecompile(seam(s), glueDeps()),
    rewriteFlowArtifacts: (s, g) => rewriteFlowArtifacts(seam(s), seam(g)),
    // 与七条路由**同一份实现**。chat 工具那条路带着 `mutationClaimed` 进来 ——
    // 它已经持有 mutation 租约，再抢一次会被自己挡在 409 上。
    questionBacklog: (s) => seam(questionBacklog(seam(s))),
    answerDomainQuestion: async (s, qid, body, o) =>
      seam(await answerDomainQuestion(seam(s), qid, body, questionDeps(), o ?? {})),
    rememberDecision: (s, d, o) => rememberDecision(serverEnv(), seam(s), seam(d), o),
    // `default_registry()` **每次现建**：它不做任何 IO（见 parse/index.ts 的说明），
    // 而缓存一份会把「设置页改了 SQL 方言」挡在下一次重启之后。
    materialTable: async (s, file, sheet, contains, columns) =>
      seam(await materialTable(seam(s), parseRegistry.defaultRegistry(), file, sheet, contains, columns)),
    // `registry()` 现建（理由同 `materialTable`）：`_full_rows_for` 要按事件里记的
    // 配方**重读原始材料**，用的解析器必须是当前设置下的那一套。
    exportDoc: async (s, source, contains, title, name) =>
      seam(
        await exportDoc(
          seam(s),
          {
            repo: () => currentRepo(),
            dialogue: (x) => dialogueOf(seam(x)),
            registry: () => parseRegistry.defaultRegistry(),
          },
          source,
          contains,
          title,
          name,
        ),
      ),
    exportApi: seam(exportApi),
    // 本进程内渲染（resvg）。`svgToPng` 是同步的 —— 包一层 async 是因为端口
    // 声明的是 Promise：一张流程图几百 KB，将来换个渲染器要异步也不用改接口。
    renderSvgPng: (svg, opts) => Promise.resolve(svgToPng(svg, opts ?? {})),
    applyFlowEdit: (g, op, args) => applyFlowEdit(seam(g), op, seam(args)),
    tablesInText: (text, ts) => tablesInText(text, ts, seam(blocksFromMarkdown)),

    settleFollowups: (s, o) => seam(settleFollowups(seam(s), o)),
    followupPrompts: (o) => seam(followupPrompts(seam(o))),
    asked: (s) => asked(seam(s)),
    traceAux: (s, what, detail) => traceAux(seam(s), what, detail),
  };
  return deps;
}

/**
 * 段 D（流水线）的 deps。
 *
 * 现在只有 `/stop` 这条路是全通的（它只碰 `repo` / `now` / `sessAsync`）；
 * `/build` 会在 `claimAndStartBuild` 往下第一个未落地的端口上显式失败。
 * 照样挂上去 —— 一条会明确报"还没接线"的路由，比一条 404 好查得多，而且
 * 前端的按钮至少还在原来的位置上。
 */
function pipelineDeps(): PipelineDeps {
  const deps: PipelineDeps = {
    repo: () => currentRepo(),
    workerId: WORKER_ID,
    now,
    buildLeaseTtl,
    buildHeartbeatInterval,
    newToken,

    sessAsync: async (sid) => seam(await sessAsync(sid)),
    refreshFilesProjection: (s) => refreshFilesProjection(seam(s)),
    runIdFor: (s) => runIdFor(seam(s)),
    gateways: (dir, runId, o) => seam(gateways(dir, runId, o)),
    ensureCatalog: async () => seam(await ensureCatalogFromConfig()),
    // `_CATALOG or ModelCatalog()`（server.py:2220）—— **过滤过的那一份**。
    // 曾经写成 `new ModelCatalog()`（未过滤的内置目录），症状很具体：上一行
    // 刚 `ensureCatalog()` 按网关 /v1/models 筛过，这里却把网关上根本没有的
    // 视觉模型报给用户「可用：…」，然后识别必然失败。
    catalog: () => seam(currentCatalog()),
    warnLowBalance: (s) => warnLowBalance(seam(s)),
    moneyFailure: (e) => moneyFailure(e),
    usdCap,
    projectMemory: async (pid) => seam(await projectMemory(pid)),
    rememberRunLessons: (s, lessons, o) =>
      rememberRunLessons(serverEnv(), seam(s), lessons, {
        runId: o.runId,
        pm: seam(o.pm ?? null),
      }),
    chunkCache: (docs) => chunkCache(seam(docs)),
    // `s_state_dialogue`（server.py:1971）：**只读，没有就是 null，不新建。**
    // 与 `_dialogue(s)`（下一行）的区别是这条不会给一个没聊过天的会话凭空造一份
    // 空记忆 —— 造了就会被 `_persist` 当成"这一轮有对话"写进去。
    stateDialogue: (s) => seam((s.state["_dialogue"] as unknown) ?? null),
    dialogue: (s) => seam(dialogueOf(seam(s))),
    emitAiPrompts: async (s, o) => {
      await emitAiPrompts(seam(s), emitDeps(), { slot: o.slot });
    },
    persistDecisions: (s, dm) => persistDecisions(s, dm),

    registry: (o) => parseRegistry.defaultRegistry(seam(o)),
    buildIndex: (docs) => seam(parseRegistry.buildIndex(seam(docs))),
    collectEndpoints: (docs) => parseRegistry.collectEndpoints(seam(docs)),
    collectProfiles: (docs) => parseRegistry.collectProfiles(seam(docs)),
    corpusSummary: (docs) => seam(parseRegistry.corpusSummary(seam(docs))),
    segmentCorpus: (index, docs) => seam(segmentCorpus(seam(index), seam(docs))),
    buildDag: (segments) => buildDag(seam(segments)),
    buildOir: (merged, index, dropped) => seam(buildOir(merged, seam(index), seam(dropped))),
    // `endpoints` / `profiles` 走 `?? null`：Python 侧传的是
    // `s.state.get("_endpoints")`，没有就是 None，而 `finish` 的默认参数正是 None。
    finish: (oir, o) =>
      seam(
        finish(seam(oir), {
          endpoints: seam(o.endpoints ?? null),
          profiles: seam(o.profiles ?? null),
          project: o.project,
        }),
      ),
    mineQuestions: (oir, o) =>
      seam(
        mineQuestions(seam(oir), {
          docs: seam(o.docs),
          chunks: seam(o.chunks),
          extra: seam(o.extra),
          extraGaps: seam(o.extraGaps),
        }),
      ),
    blocksFromMarkdown: (text) => seam(blocksFromMarkdown(text)),
    harness: HARNESS,
    // Python 的 `_build_flow_diagram` 是 `async def`，但函数体里**一个 await 都
    // 没有**（它零模型调用）。TS 侧落成同步函数，这里补一个 resolved promise ——
    // 而不是把整条链条改成同步，段 D 的端口签名是 async。
    buildFlowDiagram: (s, docs) => {
      buildFlowDiagram(seam(s), seam(docs));
      return Promise.resolve();
    },
    linkFlowToApi: (s, oir) => linkFlowToApi(seam(s), seam(oir)),
    replayOirPatches: (s, oir) => replayOirPatches(seam(s), seam(oir)),
    syncQuestionBacklog: (s, o) =>
      syncQuestionBacklog(seam(s), glueDeps(), {
        oir: seam(o.oir ?? null),
        clarification: seam(o.clarification ?? null),
        conflicts: seam(o.conflicts ?? null),
      }),
    pendingQuestions: (s) => pendingQuestions(seam(s)),
    compile: (s, o) => glueCompile(seam(s), glueDeps(), { leaseOwner: o.leaseOwner }),
  };
  return deps;
}

/**
 * 段 G（问题清单）的 deps。
 *
 * `persist` / `sessionMutation` 走 {@link PARTS} 的那一份 —— 与 PATCH/DELETE 等
 * 别的领域修改**共用同一把 mutation 租约**，否则"改问题"和"改会话"会各 claim
 * 各的，两条路能同时改同一个会话。
 *
 * `recompile` / `syncQuestionBacklog` 接的是 `server/glue/` 那两份真身。**注意
 * `syncQuestionBacklog` 这里不传 `oir`** —— 它自己会从 `s.state["_oir"]` 取，
 * 与 Python 的 `oir = oir or s.state.get("_oir")` 是同一条路。
 */
function questionDeps(): QuestionDeps {
  return {
    persist: (s) => PARTS.persist(s),
    sessionMutation: (s, kind, body) => PARTS.sessionMutation(s, kind, body),
    recompile: (s, o) =>
      glueRecompile(s, glueDeps(), { preserveQuestionRows: o.preserveQuestionRows }),
    syncQuestionBacklog: (s, o) =>
      syncQuestionBacklog(s, glueDeps(), {
        clarification: o?.clarification ?? null,
        conflicts: o?.conflicts ?? null,
      }),
  };
}

/** {@link emitAiPrompts} 的 deps。 */
function emitDeps(): Parameters<typeof emitAiPrompts>[1] {
  return {
    chatRun: (s, o, body) => glueChatRun(seam(s), chatRunDeps(), o, (run) => body(seam(run))),
    contextBrief: (s) => contextBrief(seam(s)),
    repo: currentRepo(),
    persist: (s, opts) =>
      persistCheckpoint(
        seam(s),
        { repo: () => currentRepo(), now, persistDecisions },
        { status: opts.status, chatOwner: opts.chatOwner, docsOnly: opts.docsOnly },
      ),
    workerId: WORKER_ID,
    chatLeaseTtl: chatLeaseTtl(),
    chatHeartbeatInterval: chatHeartbeatInterval(),
    newToken,
  };
}

/**
 * `ModelCatalog` → 路由那一段声明的 `CatalogLike`。
 *
 * 只是一层 cast：`describe()` 真实返回 `ModelCardDict[]`，而路由那边声明的是
 * `JsonValue`。两者的**值**完全一样（那个 dict 本来就是要 JSON 化发给前端的），
 * 只是 TS 不认没有索引签名的接口是 `JsonValue`。写成适配器而不是在别人的文件里
 * 改类型声明 —— 这一处是接缝，不是 bug。
 */
function asServerCatalog(cat: ModelCatalog): CatalogLike {
  return {
    describe: () => cat.describe() as unknown as JsonValue,
    byCapability: () => cat.byCapability() as unknown as JsonValue,
    get: (name) => cat.get(name),
  };
}

/** 各段落地后往这里填。字段全部可选，只填自己那一份。 */
export interface ServerParts {
  persist?: (s: Session, opts?: { readonly status?: boolean }) => Promise<void>;
  sessionMutation?: <T>(s: Session, kind: string, body: () => Promise<T>) => Promise<T>;
  busy?: (s: Session) => boolean;
  preparse?: (s: Session) => Promise<void>;
  dialogue?: ServerEnv["dialogue"];
  emitAiPrompts?: (s: Session, slot: string) => void;
  ensureCatalog?: () => Promise<CatalogLike>;
  newCatalog?: () => CatalogLike;
  skillNames?: () => string[];
  fdeEngagementDag?: ServerEnv["fdeEngagementDag"];
  hydrator?: Parameters<typeof registerHydrator>[0];
  bootReconciler?: (() => Promise<void>) | null;
}

const PARTS: {
  persist: NonNullable<ServerParts["persist"]>;
  sessionMutation: NonNullable<ServerParts["sessionMutation"]>;
  busy: NonNullable<ServerParts["busy"]>;
  preparse: NonNullable<ServerParts["preparse"]>;
  dialogue: NonNullable<ServerParts["dialogue"]>;
  emitAiPrompts: NonNullable<ServerParts["emitAiPrompts"]>;
  ensureCatalog: NonNullable<ServerParts["ensureCatalog"]>;
  newCatalog: NonNullable<ServerParts["newCatalog"]>;
  skillNames: NonNullable<ServerParts["skillNames"]>;
  fdeEngagementDag: NonNullable<ServerParts["fdeEngagementDag"]>;
} = {
  // `_persist(s, status=...)`：每个节点边界写一次检查点。失败必须上抛。
  persist: (s, opts) =>
    persistCheckpoint(seam(s), { repo: () => currentRepo(), now, persistDecisions }, opts ?? {}),
  // `async with _session_mutation(s, kind)`：跨 worker 串行一次领域修改。
  // deps **每次现取**，这样 lifespan 重算过的租约 TTL 立刻生效。
  sessionMutation: (s, kind, body) =>
    withSessionMutation(seam(s), dialogueDeps(), kind, {}, async () => await body()),
  busy: (s) => isBusy(seam(s)),
  preparse: (s) => gluePreparse(s),
  dialogue: (s) => dialogueOf(seam(s)),
  // `asyncio.create_task(_emit_ai_prompts(...))` —— **不 await**。
  //
  // 但**必须挂 catch**：Python 那边一个没人收的 task 异常只是一条
  // "Task exception was never retrieved" 警告；Node 上无人处理的 rejection 会
  // 触发 unhandledRejection，默认行为是**直接杀进程**（契约 §2.1）。一次推荐
  // 问题算不出来就把整个服务带走，是这条路上最容易埋的雷。
  emitAiPrompts: (s, slot) => {
    void emitAiPrompts(s, emitDeps(), { slot }).catch((exc: unknown) => {
      s.emit("prompts.failed", { error: exc instanceof Error ? exc.message : String(exc), slot });
    });
  },
  // `_ensure_catalog()`：按网关 /v1/models 过滤，懒发现、成功一次即缓存
  ensureCatalog: async () => asServerCatalog(await ensureCatalogFromConfig()),
  // `ModelCatalog()`：**未经过滤**的内置目录，`/api/health` 用的就是这一份 ——
  // 网关连不上时它照样答得出"这个版本认识哪些模型"
  newCatalog: () => asServerCatalog(new ModelCatalog()),
  // `default_library().names()`。**曾经是 `() => []`**，注释写着"技能库还没迁"，
  // 而 `kernel/skills.ts` 其实早就落地了 —— 症状是 `/api/health` 的 skills
  // Python 给 12 个名字、TS 给空数组。差分脚本抓到的就是这一条。
  skillNames: () => defaultLibrary().names(),
  fdeEngagementDag: () => seam(buildFdeEngagementDag()),
};

export function registerServerParts(parts: ServerParts): void {
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined) continue;
    if (k === "hydrator") {
      registerHydrator(parts.hydrator ?? null);
    } else if (k === "bootReconciler") {
      registerBootReconciler(parts.bootReconciler ?? null);
    } else {
      (PARTS as Record<string, unknown>)[k] = v;
    }
  }
}

/** 四个路由文件共用的运行时接缝。全部**现取**，这样后填的零件立刻生效。 */
export function serverEnv(): ServerEnv {
  return {
    persist: (s, opts) => PARTS.persist(s, opts),
    sessionMutation: (s, kind, body) => PARTS.sessionMutation(s, kind, body),
    busy: (s) => PARTS.busy(s),
    preparse: (s) => PARTS.preparse(s),
    dialogue: (s) => PARTS.dialogue(s),
    emitAiPrompts: (s, slot) => PARTS.emitAiPrompts(s, slot),
    ensureCatalog: () => PARTS.ensureCatalog(),
    newCatalog: () => PARTS.newCatalog(),
    // `appconfig.resolved_llm_config()`：**key 必须是脱敏后的那一个** ——
    // /api/health 是会被贴进工单和截图的那个响应
    resolvedLlmConfig: () => {
      const cfg = resolvedLlmConfig();
      return {
        baseUrl: cfg.baseUrl,
        redactedKey: redactedKey(cfg),
        insecureTransport: insecureTransport(cfg),
      };
    },
    storeHealthcheck: async () => {
      const h = await getStore().healthcheck();
      return h as unknown as Record<string, never>;
    },
    skillNames: () => PARTS.skillNames(),
    fdeEngagementDag: () => PARTS.fdeEngagementDag(),
  } as ServerEnv;
}

// ══════════════════════════════════════════════════════════════════
//  装配
// ══════════════════════════════════════════════════════════════════

let _wired = false;

/**
 * 把所有注册点填上。**幂等** —— Hono 的路由表是数组，装两遍会让同一条路径匹配到
 * 第一个注册的处理器，症状是"改了代码不生效"。
 */
export function wireServer(): void {
  if (_wired) return;
  _wired = true;

  // 1. 运行时配置：DB 覆盖 → env → 抛错（换掉 usage.ts 里 env-only 的默认实现）
  installAppConfig();
  // 2. 仓储选路：store/deps.ts 在 startStore() 里会调它
  registerRepoBuilder(buildRepo);
  // 2.5 冷会话唤醒。**没填之前 `sessAsync` 是显式抛错的**（不是 404）——
  //     把"接线漏了"伪装成"会话不存在"，用户根本改不动。
  registerHydrator((sid) => glueHydrate(sid, glueDeps()));
  // 3. 鉴权门禁。app.ts 注册的是一个**晚绑定的转发壳**，没填之前一律放行；
  //    填上之后才是 fail-closed 的那道门。类型上两边的 `user` 不同名同姓
  //    （authgate 的 UserRow vs app 的 RequestUser），运行时是同一个对象。
  registerAuthMiddleware(authMiddleware() as unknown as MiddlewareHandler<AppEnv>);
  // 4. 允许的跨域来源：每个请求现算，设置页改了不必重启
  registerCorsOrigins(() => corsOrigins());
  // 5. 模型目录：`gateways()` 用过滤后的那一份，设置页用未过滤的内置目录
  //    （与 Python 的 `_ensure_catalog()` / `ModelCatalog()` 两个调用点一一对应）
  installCatalogPort();
  // 同一层 cast，同一个理由（见 asServerCatalog）：configapi 声明的是
  // `Record<string, unknown>[]`，`ModelCardDict` 没有索引签名所以结构上不匹配
  registerConfigCatalog(() => {
    const cat = new ModelCatalog();
    return {
      get: (name) => cat.get(name),
      names: () => cat.names(),
      describe: () => cat.describe() as unknown as Record<string, unknown>[],
    };
  });

  // 6. 错误体的形状。FastAPI 的 `HTTPException(code, "文案")` 落到线上是
  //    `{"detail": "文案"}`；Hono 默认把它渲染成 **text/plain**。前端有两处逐字
  //    读 `d.detail`（`ui/index.html:1598` / `:1728`），拿到 text/plain 会在
  //    `r.json()` 上抛 —— 一句能看懂的报错于是变成一个更难懂的报错。
  //
  //    `sessions.ts` 的 `apiError()` 与 `authgate.ts` 的 `httpError()` 已经自带
  //    `res`，这里 `getResponse()` 会原样用它们那一份；裸的
  //    `new HTTPException(404, {message})`（artifacts / pipeline / dialogue 三段
  //    用的就是裸的）才走下面的兜底。
  //
  //    **非 HTTPException 一律回 Starlette 的那句纯文本 500**，不是 JSON：
  //    FastAPI 未捕获异常走的是 `ServerErrorMiddleware` 的
  //    `PlainTextResponse("Internal Server Error", 500)`。这里改成 JSON 会让
  //    "服务端崩了"和"这是一次业务拒绝"在前端长得一模一样。
  app.onError((err) => {
    if (err instanceof HTTPException) {
      if (err.res !== undefined) return err.getResponse();
      return Response.json({ detail: err.message }, { status: err.status });
    }
    console.error(err);
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // 7. 路由。`app.route("/", r)` 对应 FastAPI 的 `include_router` —— 子 router 里
  //    路径已经写全，所以挂在根上。
  const env = serverEnv();
  app.route("/", authRouter());
  app.route("/", usersRouter());
  app.route("/", configRouter());
  registerSessionRoutes(app, env);
  registerFileRoutes(app, env);
  registerProjectRoutes(app);
  registerStreamRoutes(app);
  registerArtifactRoutes(seam(app), {
    exportModule: {
      resolveFormat: exportApi.resolveFormat,
      tableBlock: (columns, rows, title) => exportApi.tableBlock(columns, rows, title),
      makeDoc: (p) => exportApi.makeExportDoc(p as never) as never,
      render: (doc, fmt) => exportApi.render(doc as never, fmt) as never,
      safeName: (title, ext) => exportApi.safeName(title, ext),
    },
    // `/source` 与 material.parse / build 共用同一条解析状态写入路径，不能只写
    // `_chunks` 而漏掉索引和 findings。
    preparse: (s) => env.preparse(seam(s)),
    persist: (s) => PARTS.persist(s),
    recompile: (s) => glueRecompile(seam(s), glueDeps()),
    sessionMutation: (s, kind, body) => PARTS.sessionMutation(s, kind, body),
  });
  registerQuestionRoutes(app, questionDeps());
  app.route("/", pipelineRoutes(pipelineDeps()));
  registerDialogueRoutes(dialogueDeps(), app);
}

// ══════════════════════════════════════════════════════════════════
//  进程
// ══════════════════════════════════════════════════════════════════

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  /** 关掉监听并跑完 lifespan 的收尾（排空事件、写完账本、关库）。 */
  close(): Promise<void>;
}

/**
 * 起服务。`lifespan` 在**开始监听之前**跑完 —— 反过来的话，第一个请求可能撞上
 * 一个还没建好的 repo，而那表现为一次随机的 500。
 */
export async function startServer(
  opts: { host?: string; port?: number } = {},
): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  wireServer();
  await startServerLifespan();
  let server: ReturnType<typeof serve>;
  let port: number;
  try {
    // **等到真的 listening 再返回**：绑定是异步的，立刻问 `address()` 会拿到 null，
    // 而 `port: 0`（让内核挑一个）下那就意味着调用方拿着一个 0 去连 —— 症状是
    // 一个看起来毫不相干的 EADDRNOTAVAIL。
    ({ server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
      (resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? 8000 }, (info) =>
          resolve({ server: s, port: info.port }),
        );
        // **关掉 Node 的 5 分钟请求超时。** uvicorn 没有这个限制，所以 Python 时代
        // 一次跑很久的请求只会慢，不会断；Node 默认 `requestTimeout = 300_000`，
        // 超过就把连接掐了 —— 前端看到的是一句 `TypeError: Failed to fetch`，
        // 而**服务端那一轮还在继续跑并通过 SSE 交付结果**，于是「报错了但结果又出来了」，
        // 没有任何日志说明发生过什么。
        //
        // 这不是假想：实测一次「读一张图 + 回答」的对话轮就要 54 秒，而一次完整梳理
        // 重材料远不止。
        //
        // 只关**整条请求**的总时长，`headersTimeout`（60s，防慢速头攻击）保持不变：
        // 慢的是我们自己的处理，不是对端发头。
        //
        // `serve()` 的返回类型是个联合（HTTP/1 与 HTTP/2 两种 server），后者没有
        // `requestTimeout`。这里按属性在不在来判，而不是 `as` 硬转 —— 硬转的话
        // 哪天真跑在 HTTP/2 上，这行会静默什么都不做。
        if ("requestTimeout" in s) s.requestTimeout = 0;
        s.on("error", reject);
      },
    ));
  } catch (e) {
    // 端口被占之类：lifespan 已经起来了，得原路关掉，不然测试会留下一个连着库的进程
    await stopServerLifespan();
    throw e;
  }
  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopServerLifespan();
    },
  };
}

/** `argparse` 的那一小块：`--host` / `--port` / `--reload`。 */
export interface ServeArgs {
  host: string;
  port: number;
  reload: boolean;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
    Object.setPrototypeOf(this, ArgError.prototype);
  }
}

export function parseArgs(argv: readonly string[]): ServeArgs {
  const out: ServeArgs = { host: "127.0.0.1", port: 8000, reload: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const [name, inline] = eq > 1 && a.startsWith("--") ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const take = (): string => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined) throw new ArgError(`argument ${name}: expected one argument`);
      i += 1;
      return v;
    };
    if (name === "--host") out.host = take();
    else if (name === "--port") {
      const raw = take();
      // argparse 的 `type=int`：解析不出来是 exit code 2，不是悄悄用默认值
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new ArgError(`argument --port: invalid int value: '${raw}'`);
      }
      out.port = Number(raw);
    } else if (name === "--reload") out.reload = true;
    else throw new ArgError(`unrecognized arguments: ${a}`);
  }
  return out;
}

/**
 * 启动进程。返回退出码（0 正常、2 参数错误）。
 *
 * **`--reload` 在 TS 侧只是一句提示。** uvicorn 的 reloader 是它自己 fork 出来的
 * 监视进程；Node 上对等物是 `node --watch` / `tsx watch`，那是**外层**的事，在
 * 进程内部实现一遍等于自己写一个监视器。接着这个参数是为了让原来的命令行不报错。
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: ServeArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`ontocopilot-server: error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.reload) {
    console.log("  提示  --reload 请用 `node --watch` / `tsx watch` 在外层做");
  }
  console.log(`  界面  http://${args.host}:${args.port}/`);
  console.log(`  API   http://${args.host}:${args.port}/docs`);
  const running = await startServer({ host: args.host, port: args.port });

  // Ctrl-C / docker stop：**先把 lifespan 收尾跑完**再退，否则缓冲里的用量流水与
  // 还没落盘的会话事件会一起丢 —— 而那正是"重启之后账少了一笔"的由来。
  const stop = (): void => {
    void running.close().then(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return 0;
}
