/**
 * AI 推荐问题（面向 FDE）—— `server.py` 6196–6414 的移植。
 *
 * 聊天窗口下面那三个可以点的气泡就是这里出来的。产出契约钉死在
 * {@link FOLLOWUPS_SCHEMA}：**至多 3 条**，`send` 缺省等于 `text`
 * （与 {@link "../../onto/prompts.js" Prompt} 同形）。前端直接按这个形状渲染，
 * 少一个字段就是一片空白，多给一条就挤掉输入框。
 *
 * 这一段在 Python 侧没有任何路由 —— 它是会话/对话两条路的公共零件：
 * `/api/sessions`、`/api/sessions/{sid}/files` 返回时带上启发式的那批，
 * 后台 {@link emitAiPrompts} 算完再用 `prompts.ready` 事件换掉。
 *
 * ## 依赖注入而不是 import 服务端单例
 *
 * Python 侧这些函数直接摸模块级的 `_chat_run` / `get_repo()` / `_persist`。
 * TS 侧 server 核心由另一段落地，所以这里把它们收进 {@link RecommendDeps} /
 * {@link EmitDeps} 显式传入 —— 顺带让这一段能脱离 HTTP 单测（Python 侧做不到）。
 */

import { Difficulty } from "../../kernel/dag.js";
import type { CallOptions, Completion, ModelSpec } from "../../kernel/llm.js";
import { pyStr } from "../../onto/canonical.js";
import { followupPrompts, type PromptDict } from "../../onto/prompts.js";
import { cpSlice } from "../../onto/parse/base.js";
import { randomUUID } from "node:crypto";
import {
  chatHeartbeatInterval as defaultChatHeartbeatInterval,
  chatLeaseTtl as defaultChatLeaseTtl,
  currentRepo,
  WORKER_ID,
} from "../session.js";
import type { Session } from "../session.js";

// ══════════════════════════════════════════════════════════════════
//  产出契约
// ══════════════════════════════════════════════════════════════════
/**
 * 推荐问题的产出契约。至多 3 条；`send` 缺省等于 `text`（同 `onto.prompts.Prompt`）。
 *
 * 这份 JSON Schema 是直接下发给模型的，键名/顺序都按 Python 原件逐字抄 ——
 * 它同时是提示词的一部分，改动会改变模型的输出分布。
 */
export const FOLLOWUPS_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "展示给 FDE 的问题，一句话" },
          send: { type: "string", description: "点下去实际发送的话；缺省等于 text" },
        },
      },
    },
  },
};

export const FDE_SYSTEM = `你在为一位 FDE（前向部署工程师）预测：结合当前项目状态，
他接下来最可能想问的问题。

给 3 条以内。每条都要：
- 具体、可执行 —— 扣住材料、产物、待拍板/建议的现状，别问空泛的（"能详细说说吗"）。
- 是这个角色真正关心的：材料哪里没写清、哪些推断没依据、口径由谁定、
  哪些必须问客户、接下来该跑什么。
- 只问答得上、且答了有用的 —— 一个点下去得到"我查不到"的问题，净价值是负的。

不要寒暄，不要重复他已经问过的，不要把一个问题拆成两条。`;

/** 一轮推荐最多给几条。schema 里的 `maxItems` 只是"请求"，模型给多了照样要截。 */
const MAX_QUESTIONS = 3;

// ══════════════════════════════════════════════════════════════════
//  外部接线
// ══════════════════════════════════════════════════════════════════
/** `run.gw` 的结构子集：一次调用 + 路由表上的快档。 */
export interface GatewayLike {
  readonly routing?: { readonly fast?: ModelSpec | null | undefined } | null | undefined;
  call(nodeId: string, prompt: string, opts?: CallOptions): Promise<Completion>;
}

/** `_chat_run(...)` 交出来的东西。这一段只用到网关。 */
export interface ChatRunHandle {
  readonly gw: GatewayLike;
}

/**
 * `async with _chat_run(s, kind=..., semantic_input=...) as run:` 的等价物。
 *
 * TS 没有异步上下文管理器，改成**回调形**：进入/退出的成对性由这个签名保证，
 * 而不是靠调用方记得写 `finally`。
 */
export type ChatRunner = <T>(
  s: Session,
  opts: { readonly kind: string; readonly semanticInput: Record<string, unknown> },
  body: (run: ChatRunHandle) => Promise<T>,
) => Promise<T>;

// ══════════════════════════════════════════════════════════════════
//  chips
// ══════════════════════════════════════════════════════════════════
/**
 * 模型给的追问 → 可点的 chips。
 *
 * 显示的和点下去发出去的是**同一句话**：chip 上写着什么，他就问了什么。
 */
export function asPrompts(questions: readonly string[]): PromptDict[] {
  return questions.map((q) => ({ text: q, send: q, group: "" }));
}

export interface SettleFollowupsOpts {
  readonly modelQuestions?: readonly unknown[] | null | undefined;
  readonly reply?: string;
}

/**
 * 定下这一轮的 chips，记进会话状态，并返回它们。
 *
 * **每一次交互结束，聊天窗口里都得有"接下来能问什么"** —— 这是这个函数存在的
 * 全部理由。两级来源，后一级保证非空：
 *
 * 1. 模型跟着回答一起给的（最贴，零额外往返）；
 * 2. 启发式（{@link followupPrompts} 不会返回空）。
 *
 * **这里不发起任何模型调用，所以它是同步的。** 曾经有过第三级"补算一次"，
 * 删掉是因为它在一条对话请求里 await：答案早就通过 SSE 上屏、思考气泡也收了，
 * 用户读完就去点 chips —— 而这条请求还攥着 chat lease 没还，那一下点击直接吃
 * 409「已有一轮对话正在处理」，连他输入框里的字都被清掉了。网关挂掉时更糟：
 * 答案本身重试完 6~9 秒，补算再对着同一个死网关重试一遍，翻倍。
 * 模型自己都判断"没什么好问的"时，用一批免费的、按状态长出来的提示顶上，
 * 比让他为此等一次往返划算得多。
 *
 * 写进 `s.state` 而不是只当返回值：chips 是会话的一部分，重开会话、刷新页面
 * 之后"接下来干什么"不该消失。调用方随后的 `_persist` 会把它落库。
 */
export function settleFollowups(s: Session, opts: SettleFollowupsOpts = {}): PromptDict[] {
  const reply = opts.reply ?? "";
  // `str(x).strip()`，**没有 `or ""`** —— 这里刻意与 `aiRecommend` 里的
  // `str(q.get("text") or "")` 不同：模型给回来的 `null` 在 Python 侧会变成
  // 字面量 "None" 并作为一条 chip 出现。照抄，不"顺手修好"（见契约 §7.3）。
  let qs = asPrompts(
    (opts.modelQuestions ?? [])
      .map((x) => pyStr(x).trim())
      .filter((q) => q !== "")
      .slice(0, MAX_QUESTIONS),
  );
  if (qs.length === 0) {
    // 下划线开头的是内部状态（`_oir`/`_dialogue`/`_chunks`…），不给启发式看。
    const publicState: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.state)) {
      if (!k.startsWith("_")) publicState[k] = v;
    }
    qs = followupPrompts({
      answer: reply,
      state: publicState,
      files: s.files.map((f) => f.name),
      status: s.status,
      asked: asked(s),
    });
  }
  s.state["followups"] = qs;
  return qs;
}

/** 他自己说过的话。启发式提示据此避开"推荐他刚问过的那句"。 */
export function asked(s: Session): string[] {
  const turns = dialogueTurns(s);
  return turns
    .filter((t) => t["speaker"] === "user")
    // `str(t.get("text") or "")`：`or ""` 在前，所以 null / 空串都落成 ""。
    .map((t) => pyStr(pyTruthy(t["text"]) ? t["text"] : ""));
}

/**
 * 辅助调用（推荐问题）用哪个模型规格：路由表给的最低推理档。
 *
 * `null` 表示这套路由没有单独的快档（Anthropic 的 Haiku、离线 stub），
 * 调用方照常按难度路由 —— 不要在这里瞎编一个 effort 下发给不认它的后端。
 */
export function fastSpec(gw: GatewayLike | null | undefined): ModelSpec | null {
  return gw?.routing?.fast ?? null;
}

// ══════════════════════════════════════════════════════════════════
//  推荐
// ══════════════════════════════════════════════════════════════════
export interface RecommendDeps {
  readonly chatRun: ChatRunner;
  /** `_context_brief(s)`：当前项目状态的一段话。 */
  readonly contextBrief: (s: Session) => string;
  /** `os.getenv` 的注入口，测试里不必去改进程环境。 */
  readonly env?: (name: string) => string | undefined;
}

export interface RecommendOpts {
  readonly slot: string;
  readonly userText?: string | null | undefined;
  readonly reply?: string | null | undefined;
}

/**
 * 结合上下文，让模型预测 FDE 接下来会问的问题。
 *
 * 失败 / 空结果一律返回 `null` —— 调用方据此退回启发式 `prompts.ts`。
 * `slot="followup"` 传 `userText`/`reply`（他刚问的和刚给的答复）；
 * `slot="opening"` 只看当前项目状态。
 */
export async function aiRecommend(
  s: Session,
  deps: RecommendDeps,
  opts: RecommendOpts,
): Promise<PromptDict[] | null> {
  const env = deps.env ?? ((n: string) => process.env[n]);
  // 对话花费封顶时就别再花这一次 —— 推荐问题是锦上添花，不值得顶着上限跑。
  const spent = pyFloat(s.state["_chat_usd"]);
  const cap = Number.parseFloat(env("ONTOCOPILOT_CHAT_USD_CAP") ?? "3");
  if (spent >= cap) return null;
  try {
    const corpus = asRecord(s.state["corpus"]);
    const findings = asArray(corpus["findings"])
      .slice(0, 5)
      .map((f) => pyStr(asRecord(f)["message"] ?? ""))
      .join("；");
    const dlg = dialogueTurns(s);
    const recent = dlg
      .slice(-4)
      .filter((t) => t["speaker"] !== "system")
      // `str(t.get("text",""))[:200]` 是**按 code point** 切的，中文一个字算一个。
      // `t.get("text", "")` 的默认值只在**键缺席**时生效：键在但值是 null，
      // Python 给的是 "None"，不是空串。用 hasOwn 分开这两种情况。
      .map(
        (t) =>
          `${pyStr(t["speaker"])}: ` +
          cpSlice(pyStr(Object.hasOwn(t, "text") ? t["text"] : ""), 0, 200),
      )
      .join("\n");
    const userText = opts.userText ?? "";
    const reply = opts.reply ?? "";
    const prompt =
      `## 当前项目状态\n${deps.contextBrief(s)}\n` +
      (findings ? `\n## 材料里已发现的问题\n${findings}\n` : "") +
      (recent ? `\n## 最近几轮对话\n${recent}\n` : "") +
      (userText ? `\n## 他刚问的\n${userText}\n` : "") +
      (reply ? `\n## 刚给他的回复\n${reply}\n` : "");
    const comp = await deps.chatRun(
      s,
      { kind: "recommend", semanticInput: { slot: opts.slot, prompt, lang: s.lang } },
      // 400 太紧了：会思考的模型（gemini-2.5+/o 系列）推理 token 也算进这个额度，
      // 实测三条推荐问题连撞三次「JSON 不完整」然后整个失败。这几百 token 的差价
      // 远小于"每轮推荐问题都算不出来"的代价。
      //
      // 走**最低推理档**（routing.fast）。这一档的模型思考不能关（网关明说
      // "Reasoning is mandatory"），但能压到最低：实测同一句提示 7.8s/934 出
      // token → 3.5s/202，四分之一的钱。猜三条追问不值得一次深度推理。
      async (run) =>
        run.gw.call("CHAT.recommend", prompt, {
          system: FDE_SYSTEM,
          difficulty: Difficulty.LOW,
          model: fastSpec(run.gw),
          schema: FOLLOWUPS_SCHEMA,
          maxTokens: 4000,
        }),
    );
    s.state["_chat_usd"] = spent + pyFloat(comp.usd);
    const out: PromptDict[] = [];
    for (const raw of asArray(asRecord(comp.data)["questions"])) {
      const q = asRecord(raw);
      const text = pyStrTrim(q["text"]);
      if (!text) continue;
      const send = pyStrTrim(q["send"]) || text;
      out.push({ text, send, group: "" });
      if (out.length >= MAX_QUESTIONS) break;
    }
    return out.length > 0 ? out : null;
  } catch {
    // 推荐失败不该影响回复，退回启发式即可。
    return null;
  }
}

/**
 * 把**辅助性的模型调用**也投影进推理面板。
 *
 * 措辞、推荐问题这些调用一样在花钱、一样是"AI 在想事情"，但它们不走对话推理
 * 循环，于是推理面板里完全看不见 —— 用户看到的是一个偶尔卡一下、不知道在干嘛
 * 的界面。既然那一栏叫「推理」，它就该是**这一轮所有模型工作**的全集。
 */
export function traceAux(s: Session, what: string, detail: string): void {
  const n =
    s.events.filter((e) => e["kind"] === "chat.step" && asRecord(e["step"])["turn"] === "aux")
      .length + 1;
  s.emit("chat.step", {
    step: { turn: "aux", q: "后台", n, thought: `${what}：${detail}` },
  });
}

// ══════════════════════════════════════════════════════════════════
//  开场推荐（后台）
// ══════════════════════════════════════════════════════════════════
/** {@link emitAiPrompts} 要用的耐久层。方法名与 `store/repo/protocol.ts` 一致。 */
export interface ChatLeaseRepo {
  claimChatLease(
    sid: string,
    opts: { readonly owner: string; readonly now: number; readonly ttl: number },
  ): Promise<boolean>;
  renewChatLease(
    sid: string,
    opts: { readonly owner: string; readonly now: number; readonly ttl: number },
  ): Promise<boolean>;
  releaseChatLease(sid: string, opts: { readonly owner: string }): Promise<boolean>;
}

export interface EmitDeps extends RecommendDeps {
  /** 缺省取 `currentRepo()`。 */
  readonly repo?: ChatLeaseRepo;
  /** `_persist(s, status=False, chat_owner=..., docs_only={"_chat_usd"})`。 */
  readonly persist: (
    s: Session,
    opts: {
      readonly status: boolean;
      readonly chatOwner: string;
      readonly docsOnly: ReadonlySet<string>;
    },
  ) => Promise<unknown>;
  readonly workerId?: string;
  readonly chatLeaseTtl?: number;
  readonly chatHeartbeatInterval?: number;
  /** owner 后缀的随机部分。测试里注入定值，生产给 `randomUUID().replace(/-/g,"")`。 */
  readonly newToken?: () => string;
  /**
   * 心跳的等待。测试里注入假时钟；生产走 `setTimeout`。
   *
   * **必须接 `signal`**：收尾时要能立刻把还在等的那一觉叫醒。定时器是能真取消的
   * （和"取消一个已经发出去的模型调用"完全两回事，见 {@link emitAiPrompts} 的说明），
   * 不接的话 `finally` 会一直卡在 `await heartbeat` 上 —— 最长一个心跳周期，
   * 而调用方以为这个函数早就返回了。
   */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

/**
 * 后台算**开场**推荐问题，算出来了就发 `prompts.ready` 换掉启发式那批。
 *
 * 只有开场（新会话、材料传完）走后台：那会儿人在读文件列表，晚几秒换一批提示
 * 不打断任何事。**一轮对话的追问不走这里** —— 它跟着回答一起回来（见
 * `converse.ANSWER_SCHEMA` 的 next_questions），所以这里不需要对轮次，
 * 也就不会有一个活过 chat lease 的后台 writer。
 *
 * 失败就什么都不发 —— `/files`、`/sessions` 早已带着启发式提示返回，
 * chips 已经在了。
 *
 * This optional model call still writes chat spend and durable events.  Give it a
 * real chat lease rather than letting a fire-and-forget task outlive the request
 * that spawned it and race the next worker's turn.  If a human turn already owns
 * the session, simply keep the heuristic prompts that the HTTP response included.
 *
 * **与 Python 的一处结构性差异**（契约 §2.2「取消：不假装有」）：Python 的心跳
 * 一旦续约失败就 `owner_task.cancel()`，把还在 await 的模型调用当场打断。Node
 * 没有真正的任务取消，这里改成**打丢标记**：调用照常跑完，但之后的花费落库与
 * `prompts.ready` 一律不做。耐久侧的可观察结果一致 —— 丢了 owner 就既不投影
 * 花费也不投递提示；差别只在那一次已经付过钱的请求会跑到底。
 */
export async function emitAiPrompts(
  s: Session,
  deps: EmitDeps,
  opts: { readonly slot?: string } = {},
): Promise<void> {
  const slot = opts.slot ?? "opening";
  const now = deps.now ?? (() => Date.now() / 1000);
  const sleep = deps.sleep ?? defaultSleep;
  const repo = deps.repo ?? currentRepo();
  const ttl = deps.chatLeaseTtl ?? defaultChatLeaseTtl();
  const beat = deps.chatHeartbeatInterval ?? defaultChatHeartbeatInterval();
  const token = deps.newToken ?? (() => randomUUID().replace(/-/g, ""));
  const owner = `${deps.workerId ?? WORKER_ID}:recommend:${token()}`;
  const claimed = await repo.claimChatLease(s.id, { owner, now: now(), ttl });
  if (!claimed) return;

  // 丢了 owner 的信号。Python 那边是 CancelledError，这里只能是一面旗子。
  let lost = false;
  const stop = new AbortController();
  const heartbeat = (async () => {
    while (!stop.signal.aborted) {
      await sleep(beat * 1000, stop.signal);
      if (stop.signal.aborted) return;
      const renewed = await repo.renewChatLease(s.id, { owner, now: now(), ttl });
      if (!renewed) {
        lost = true;
        return;
      }
    }
  })();
  // 无人 await 的 rejected promise 在 Node 里会触发 unhandledRejection 直接杀进程
  // （契约 §2.1）。心跳自己出错不该带走整个进程 —— 就当续约失败处理。
  heartbeat.catch(() => {
    lost = true;
  });

  try {
    // 推理面板记的是**它在想什么**，不是它想出来的东西。算完的推荐问题不再往这里
    // 抄一份：那是给人点的产物，位置在聊天窗口的 chips 上；抄进推理面板只会得到
    // 一行截断到 18 字、点不了的半截问题，还让人以为回答还没完。
    const before = pyFloat(s.state["_chat_usd"]);
    traceAux(s, "想推荐问题", "结合当前材料和产物，算他最该从哪问起");
    const qs = await aiRecommend(s, deps, { slot });
    // Losing the durable owner fences both spend projection and prompt delivery.
    if (lost) return;
    if (pyFloat(s.state["_chat_usd"]) !== before) {
      await deps.persist(s, {
        status: false,
        chatOwner: owner,
        docsOnly: new Set(["_chat_usd"]),
      });
    }
    // `questions` 展开成普通对象字面量：`PromptDict` 是 interface，没有隐式索引
    // 签名，直接塞进 `JsonObject` 过不了类型检查。字段名与顺序不变。
    if (qs && qs.length > 0) {
      s.emit("prompts.ready", {
        slot,
        questions: qs.map((q) => ({ text: q.text, send: q.send, group: q.group })),
      });
    }
  } finally {
    stop.abort();
    await heartbeat.catch(() => undefined);
    await repo.releaseChatLease(s.id, { owner });
  }
}

/** 可被叫醒的 `setTimeout`。abort 之后立刻 resolve —— 心跳的循环体会自己看
 * `signal.aborted` 再退出，所以这里 resolve 而不是 reject。 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════
/** `s.state["_dialogue"].to_dict()["turns"]`，缺一环就当空。 */
function dialogueTurns(s: Session): Record<string, unknown>[] {
  const dm = s.state["_dialogue"];
  if (dm === null || dm === undefined) return [];
  const toDict = (dm as { toDict?: () => Record<string, unknown> }).toDict;
  if (typeof toDict !== "function") return [];
  return asArray(toDict.call(dm)["turns"]).map((t) => asRecord(t));
}

/** `str(x).strip()`。`null`/`undefined` 在 Python 侧是 `str(None)` = "None"，
 * 但这里所有调用点都先经过 `or ""`（`q.get("text") or ""`），所以空值 → ""。 */
function pyStrTrim(x: unknown): string {
  if (x === null || x === undefined || x === "" || x === false) return "";
  return String(x).trim();
}

/** `float(x or 0.0)`：`None`/`""`/`0` 都落到 0。 */
function pyFloat(x: unknown): number {
  if (x === null || x === undefined || x === "" || x === false) return 0;
  const n = typeof x === "number" ? x : Number.parseFloat(String(x));
  return Number.isNaN(n) ? 0 : n;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** Python 的真值判断（`x or ""`）。就地一份，理由同 `artifacts.ts`。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === "" || Number.isNaN(v as number)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}
