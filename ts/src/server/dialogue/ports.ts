/**
 * server 段 E（对话）与其它五段之间的**接缝**。
 *
 * 原则：**别段已经落地的类型和纯函数直接 import**（`pipeline/types.ts` 的
 * `SessionLike`/`RunHandle`/`RunCancelled`、`pipeline/tables.ts` 的
 * `oirTable`/`NoRows`/`MultiSheet`、`pipeline/persist.ts` 的 `pushVersion`…），
 * 只有**本身就要注入的东西**才进 {@link DialogueDeps}：那些函数在别段也是收一个
 * deps 包的（`persist(s, deps)`、`claimAndStartBuild(s, deps)`），在这里再穿一层
 * 具体实现只会把两段绑死，还让这一段没法单测。
 *
 * 单测能力不是附赠品：这一段最值钱的是二十几个动作工具的**参数校验与失败文案**，
 * 而那正是重构里最容易悄悄漂移、线上又只表现为"模型开始胡说"的部分。
 *
 * 命名规则跟迁移约定：TS 侧 camelCase，**线上形态（HTTP JSON、事件 payload、工具
 * 回执的键）一律保持 Python 侧的原文**，一个字都不改。
 */

import type { Repo } from "../../store/repo/protocol.js";
import type { SessionEvent } from "../../session_events.js";
import type { ToolRegistry } from "../../kernel/tools.js";
import type { Difficulty } from "../../kernel/dag.js";
import type { SessionLike as PipelineSessionLike } from "../pipeline/types.js";
import type { GroundingPolicy } from "../../onto/converse.js";

// ══════════════════════════════════════════════════════════════════
//  Session
// ══════════════════════════════════════════════════════════════════

/**
 * `server.Session` 里这一段用得到的成员。
 *
 * 在 `pipeline/types.ts` 那份之上多两样：
 *
 * * `lang` —— 请求时捕获的界面语言。**这一段是唯一写它的地方**（`/chat` 的 body），
 *   后台管线只读。
 * * `emitDurable` —— `ui.table` 必须等到权威 seq 才算数：前端的「导出这张表」按钮
 *   是按 seq 拿数据的，用临时序号发出去的表点下去就是 404。
 */
export interface SessionLike extends PipelineSessionLike {
  /** zh / en。 */
  lang: string;
  emitDurable(kind: string, payload?: Record<string, unknown>): Promise<SessionEvent>;
}

// ══════════════════════════════════════════════════════════════════
//  别段的类型（只声明我用到的形状）
// ══════════════════════════════════════════════════════════════════

/** `_ChatRun`：一次对话侧调用 + 它那份可重放的 Recorder journal。 */
export interface ChatRunLike {
  readonly repoRunId: string;
  readonly recorderRunId: string;
  readonly gw: GatewayLike;
  /** 视觉模型规格（OCR 用）。 */
  readonly smart: unknown;
  fail(error: string): void;
}

export interface CompletionLike {
  readonly data?: Record<string, unknown> | null;
}

export interface GatewayLike {
  /** `ToolRegistry.call` 的记账入口。**必须给** —— 见 `ChatCtx.rec` 的注释。 */
  readonly rec: unknown;
  /** 出图（images 端点）。可选：ModelGateway 有，测试替身可以不给。 */
  generateImage?(
    nodeId: string,
    args: { model: string; prompt: string; size?: string },
  ): Promise<{ b64: string }>;
  call(
    name: string,
    prompt: string,
    opts: {
      system?: string;
      difficulty?: Difficulty;
      schema?: Record<string, unknown>;
      maxTokens?: number;
      signal?: AbortSignal;
      /** 换一个模型档（如评审换评委、看图换视觉模型）。 */
      model?: unknown;
      /**
       * 附给模型的图（base64 PNG）。
       *
       * 存在的理由：模型画完图之后**看不见自己画的是什么**。文字结构合格不代表
       * 图能读——节点重叠、连线交叉、标签截断这几类只有渲染出来才暴露。
       * IntroSVG / Render-in-the-Loop（2026）的做法就是把渲染结果回灌给模型；
       * kernel 侧的网关本来就支持 images，这里只是把它接到对话这条路上。
       */
      images?: readonly string[];
    },
  ): Promise<CompletionLike>;
}

/** `kernel.intent.IntentMatch`。 */
export interface IntentMatchLike {
  readonly intent: string;
  readonly confidence: number;
  readonly slots: Record<string, unknown>;
  readonly span: string;
}

/** `kernel.intent.IntentParse`。 */
export interface IntentParseLike {
  readonly matches: IntentMatchLike[];
  toDict(): Record<string, unknown>;
}

export interface IntentParserLike {
  parse(text: string): IntentParseLike;
}

/** `onto.converse.ConverseTurn`。 */
export interface ConverseTurnLike {
  readonly answer: string;
  readonly citations: string[];
  readonly followup: string;
  readonly nextQuestions: string[];
  readonly steps: Record<string, unknown>[];
  readonly findings: { readonly code: string }[];
  readonly usd: number;
  toDict(): Record<string, unknown>;
}

export interface ConversationAgentLike {
  run(
    text: string,
    opts: {
      ctx: unknown;
      context?: string;
      onStep?: (rec: Record<string, unknown>) => void;
      signal?: AbortSignal;
      grounding?: GroundingPolicy | null;
    },
  ): Promise<ConverseTurnLike>;
}

/** `onto.export` 里 `render()` 出来的格式规格。 */
export interface ExportSpecLike {
  readonly ext: string;
  readonly label: string;
}

export interface ExportDocLike {
  readonly title: string;
  // columns 是**回执对账**要用的（导出后把列名念回给模型，让它自己发现张冠李戴）。
  // 可选：端口层不强求每种块都带列名，读的时候按缺省处理。
  readonly tables: { readonly rows: readonly unknown[]; readonly columns?: readonly unknown[] }[];
  /**
   * 组好的块。附图那一步要往里追加 image 块 —— `makeExportDoc` 的 `tables` 是
   * 读 `blocks` 的 getter，所以追加之后表清单会自己跟上。
   *
   * 声明成 `unknown[]` 而不是 `Block[]`：端口层不该反过来依赖 `onto/export`
   * 的具体块形状，调用方自己 as 回去。可选是为了让测试里的假 doc 不必造这个字段。
   */
  readonly blocks?: unknown[];
}

/**
 * 某个导出格式所需的第三方库缺席。
 *
 * Python 侧靠 `except ImportError` 区分"这台机器上装不了 pdf"和"写文件真的失败了"
 * —— 两条回执文案不一样，模型据此决定是换格式还是如实报错。JS 没有 ImportError，
 * 由 export 段显式抛这个类来保住分支。
 */
export class ExportDependencyMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportDependencyMissing";
    Object.setPrototypeOf(this, ExportDependencyMissing.prototype);
  }
}

export interface ExportApi {
  readonly FORMATS: readonly string[];
  /**
   * 这个进程**真的**导得出哪几种 —— 用于**宣传**，与用于**解析**的 `FORMATS` 分开。
   *
   * pdf 要外部排版器，生产进程至今没接过。宣传口径若直接用 `FORMATS`，模型会照单
   * 全收地对用户说「给你导成 PDF」，用户点了才发现导不出来。
   */
  availableFormats(): string[];
  /** 口语别名（excel/word/表格）规范化成正式格式名；认不出回 `""`。 */
  resolveFormat(format: string): string;
  /** 装得下图片的格式（csv 装不下）。同 availableFormats：能力要说得出。 */
  imageFormats(): string[];
  supportsImages(format: string): boolean;
  render(doc: ExportDocLike, fmt: string): Promise<[Uint8Array, ExportSpecLike]>;
  safeName(title: string, ext: string): string;
}

// flow_edit.ts 已落地，换成 import 它那一份（这里原本是占位声明）。
// 两份 Error 类的症状是 `instanceof` 假阴性 —— 一次被守卫拒绝的流程图编辑会
// 直接冒成 500，版本栈和补丁日志都不回滚。
import { FlowEditError } from "../../onto/flow_edit.js";
export { FlowEditError };

// 同理：SVG→PNG 的失败要能与别的异常分开（它对应的动作是「改输入」，
// 不是「重试」）。**不在这里另写一个同名类** —— 两份同名 Error 就是两个类
// 身份，`instanceof` 假阴性的症状是一次渲染失败被报成一句泛泛的错误，
// 排查方向整个跑偏。
import { RenderError } from "../../onto/render.js";
export { RenderError };

/** `revision.diff` 要的 revision 行。 */
export interface RevisionRowLike {
  readonly id: string;
  readonly ordinal: number;
  readonly kind?: string;
  readonly snapshot_hash?: string;
}

/** `_material_table` 的返回：`(文件名, 表名, 列, **全部**行, 附注)`。 */
export type MaterialTable = readonly [string, string, string[], string[][], Record<string, unknown>];

// ══════════════════════════════════════════════════════════════════
//  依赖注入
// ══════════════════════════════════════════════════════════════════

/**
 * 这一段消费的、**必须注入**的能力。
 *
 * 一个显式对象，**不是 DI 框架** —— 迁移约定 §10 明确说了 `Depends()` 对应
 * "显式传参或 middleware，不要造一套 DI 框架"。
 */
export interface DialogueDeps {
  // ── 基础设施 ──────────────────────────────────────────────
  getRepo(): Repo;
  /** `time.time()`：**秒**为单位的浮点。测试要能钉住时间。 */
  now(): number;
  /** 这个会话的 revision 台账（按 ordinal 递增）。`revision.diff` 用。 */
  listRevisions(s: SessionLike): Promise<readonly RevisionRowLike[]>;
  /**
   * 按 `snapshot_hash` 取回那一版的 canonical package。
   *
   * **取不到要抛**，不要回 null 或空对象 —— 空包会被 diff 读成「所有东西都被
   * 删了」，那是把一次读取失败伪装成一次大规模变更。
   */
  readSnapshot(s: SessionLike, ref: string): Promise<unknown>;
  /**
   * 把一次**对话侧编辑**记成一条耐久 revision（kind=dialogue_edit，带内容寻址快照）。
   *
   * 存在的理由：oir.add/oir.edit/flow.edit/template.edit 以前只压 undo 栈
   * （`_*_versions`），不产生 revision 行 —— 上面 `listRevisions`/`readSnapshot`
   * 服务的 revision.diff 对「对话里改的」全盲，而那个工具的描述恰恰承诺
   * 「回答『我刚才那下改了什么』时用它」。
   *
   * **实现必须自吞异常**：编辑本体已经落进状态与产物，为一条台账行写不进就让
   * 编辑报错，比没有 diff 严重得多（与 answer 路径对 snapshot 的纪律一致：
   * 失败发事件，不冒泡）。不给就是不记（老部署、测试）。
   */
  readonly editRevision?: (
    s: SessionLike,
    info: { readonly tool: string; readonly label: string; readonly changedIds: readonly string[] },
  ) => Promise<void>;
  /** `_WORKER_ID`。 */
  readonly workerId: string;
  readonly chatLeaseTtl: number;
  readonly chatHeartbeatInterval: number;
  readonly mutationLeaseTtl: number;
  readonly mutationHeartbeatInterval: number;
  /** 每次调用生成一个新 token（Python 是 `uuid.uuid4().hex`）。 */
  newToken(): string;

  // ── 会话装载与投影 ────────────────────────────────────────
  sessAsync(sid: string): Promise<SessionLike>;
  refreshFilesProjection(s: SessionLike): Promise<void>;
  restoreDialogue(s: SessionLike): Promise<void>;
  persist(
    s: SessionLike,
    opts?: { status?: boolean; leaseOwner?: string; chatOwner?: string },
  ): Promise<void>;
  autoTitle(s: SessionLike, opts: { firstText: string }): Promise<void>;
  /** `_PERSISTED` / `_PERSISTED_PRIVATE` / `_PERSISTED_PRIVATE_DOCS`。 */
  readonly persistedKeys: readonly string[];
  readonly persistedPrivateKeys: readonly string[];
  readonly persistedPrivateDocKeys: readonly string[];

  // ── 配置与文案 ────────────────────────────────────────────
  chatUsdCap(): number;
  modelOverrides(): unknown;
  /** 预算封顶的统一文案。**唯一一处保证不出现"充值/余额"字样的**（铁律 C4）。 */
  budgetCappedText(opts: { spent: number; cap: number; scope: string }): string;
  /** 选定模型 → ModelSpec；没选或目录里没有回 `null`。 */
  modelSpecFor(chosen: string): unknown | null;
  ensureCatalog(): Promise<unknown>;

  // ── 推理与措辞 ────────────────────────────────────────────
  makeParser(opts: {
    questionIds: string[];
    suggestionIds: string[];
    objectNames: string[];
  }): IntentParserLike;
  /** `Intent.UNKNOWN` 的字面值。拼 hint 时要排掉它。 */
  readonly unknownIntent: string;
  makeAgent(opts: {
    gateway: GatewayLike;
    tools: ToolRegistry;
    scope: string;
    maxSteps: number;
    system?: string;
    model?: unknown;
    lang: string;
  }): ConversationAgentLike;
  /** `onto.converse._CHAT_SYSTEM`。 */
  readonly chatSystem: string;
  /** Python 的 `async with _chat_run(...) as run:`。 */
  chatRun<T>(
    s: SessionLike,
    opts: { kind: string; semanticInput: unknown; resume?: boolean },
    body: (run: ChatRunLike) => Promise<T>,
  ): Promise<T>;

  // ── 工具依赖 ──────────────────────────────────────────────
  builtinRegistry(opts: { evidence: unknown; oir: unknown; profiles: unknown; flow?: () => unknown }): ToolRegistry;
  preparse(s: SessionLike, opts?: { vision?: unknown }): Promise<void>;
  claimAndStartBuild(s: SessionLike, opts?: { tier?: string }): Promise<string>;
  /**
   * 「图像」档配置的模型名（`gateway.model.image` 候选串的第一个）；没配给 null。
   * 可选端口：老的测试替身不用补。图像模型被 NOT_CHAT_RE 挡在聊天目录外，
   * 所以这不是难度路由能给的，得单独一条口子。
   */
  imageModel?(): string | null;
  recompile(s: SessionLike): Promise<void>;
  rewriteFlowArtifacts(s: SessionLike, g: unknown): void;
  questionBacklog(s: SessionLike): QuestionBacklogLike;
  answerDomainQuestion(
    s: SessionLike,
    qid: string,
    body: Record<string, unknown>,
    opts?: { mutationClaimed?: boolean },
  ): Promise<AnswerResult>;
  rememberDecision(s: SessionLike, d: unknown, opts: { quote: string }): Promise<void>;
  /**
   * 项目记忆的**参考档**写入（模型推断，永远不会晋升）。
   *
   * 与 `rememberDecision` 分岔在这一处：人拍板走那条、过晋升闸；模型看出来的东西
   * 走这条、进参考档。分岔点只有这两个，服务层就不会长出第三种写法。
   *
   * 存在的理由：对话里分析完一批材料得出的结论，以前**一个字都不落库** ——
   * 换个会话从零开始，第二批材料来的时候第一批要么重读（贵）要么已经被
   * compactToFit 压没了（丢）。
   */
  rememberObservation(
    s: SessionLike,
    content: string,
    opts?: { readonly files?: readonly string[] },
  ): Promise<void>;
  /** 按 query 召回项目记忆。没有项目、库里没东西时返回空数组，不抛。 */
  recallProjectMemory(
    s: SessionLike,
    query: string,
    opts?: { readonly topK?: number },
  ): Promise<
    readonly { readonly content: string; readonly kind: string; readonly tier: string; readonly confidence: number }[]
  >;
  /** 抛 `NoRows` / `MultiSheet`（`pipeline/tables.ts` 的那两个）。 */
  materialTable(
    s: SessionLike,
    file: string,
    sheet: string,
    contains: string,
    columns: string[] | null,
  ): Promise<MaterialTable>;
  exportDoc(
    s: SessionLike,
    source: string,
    contains: string,
    title: string,
    tableName: string,
  ): Promise<[ExportDocLike | null, Record<string, unknown>]>;
  readonly exportApi: ExportApi;
  /**
   * SVG → PNG（`onto/render.ts` 的 resvg，本进程内）。
   *
   * **渲染不出来就抛 {@link RenderError}**，不给一个"渲染不出来就当没要过 PNG"
   * 的静默回退：用户要 PNG 是因为他要把图贴进 PPT，给他一个 .svg 而不说，
   * 他会在会议室里打开文件的时候才发现。这一层只负责抛得清楚，措辞由工具那边写。
   */
  renderSvgPng(
    svg: string,
    opts?: { zoom?: number },
  ): Promise<{ png: Uint8Array; width: number; height: number }>;
  applyFlowEdit(
    g: unknown,
    op: string,
    args: Record<string, unknown>,
    opts?: {
      source?: "user" | "generic_assumption";
      /** 业务对象名 → rid，给 bind_objects 用；解析不出来返回空串。 */
      resolveObject?: (name: string) => string;
      /** bind_auto 的通道：确定性补空绑定，返回新增条数。 */
      autoBind?: () => number;
    },
  ): string;
  /** `_tables_in_text`：`pipeline/tables.ts` 那个还要一个 markdown 解析器，
   *  由接线方绑好再传进来。 */
  tablesInText(text: string, ts: number): Record<string, unknown>[];

  // ── 追问 chips ────────────────────────────────────────────
  settleFollowups(
    s: SessionLike,
    opts: { modelQuestions?: string[] | null; reply?: string },
  ): Record<string, unknown>[];
  followupPrompts(opts: {
    answer: string;
    state: Record<string, unknown>;
    files: string[];
    status: string;
    asked: string[];
  }): Record<string, unknown>[];
  asked(s: SessionLike): string[];
  traceAux(s: SessionLike, what: string, detail: string): void;
}

/** `_answer_domain_question` 的返回。字段名是 HTTP/工具回执契约，不能改。 */
export interface AnswerResult {
  decision: { id: string };
  created: boolean;
  pending: unknown;
  status: unknown;
  /**
   * `applyDecision` 的变更摘要（`onto/clarify.ts` 的 `DecisionResult`）。
   *
   * **显式写进契约**，别靠下面那条 index signature 混过去：它一路从
   * `applyDecision` 活到 HTTP 响应体，却在对话工具的返回里被丢掉，于是负责
   * 向用户复述的模型只能说一句「已记录」，说不出改了什么。类型上看不见的
   * 字段，最容易在下一次重构里被顺手删掉。
   *
   * 纯记录类问题没有回写目标时是 `null` —— 那时**不要编造改动**。
   */
  applied?: { label?: string; changed?: string[]; deferred?: boolean } | null;
  [k: string]: unknown;
}

/** `onto.questions.QuestionBacklog` —— 这一段只用到这几样。 */
export interface QuestionLike {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly priority: string;
  readonly audienceRole: string;
  readonly ownerUserId: string;
  readonly why: string;
  toDict(): Record<string, unknown>;
}

export interface QuestionBacklogLike {
  readonly questions: Map<string, QuestionLike>;
  nextBatch(opts: { limit: number }): QuestionLike[];
  stats(): Record<string, number>;
}

/**
 * `material.rows` 屏幕封顶。`server.py:1668` 的 `_ROWS_MAX`。
 *
 * 别段还没导出它，先在这里定义（同一个字面量）。别段落地后从那边 import ——
 * 两份不一致的症状是"界面说列了 500 行、回执说 300 行"。
 */
export const ROWS_MAX = 500;
