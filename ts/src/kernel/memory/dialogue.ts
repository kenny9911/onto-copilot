/**
 * 对话记忆 —— 会话作用域，介于 Run 与项目之间。移植自 `kernel/memory/dialogue.py`。
 *
 * 现有四层记忆全是 **Run 作用域**：节点执行时现装现用，Run 结束就散。这套东西
 * 处理不了对话，因为对话的生命周期和 Run 不一样 —— 一次会话里可能跑三次 build，
 * 用户在第一次 build 前说的"含税一律指增值税专用发票口径"，必须在第三次 build
 * 的每一个抽取节点里都还在。
 *
 * 所以对话记忆**不是第五层**，它是一个**喂料口**：把会话里发生的事分成两种，分别
 * 接到已有的层上。
 *
 *     用户说的"决定"  →  L3 Reflection（和 critic 教训并列），且候选晋升长期库
 *     其余往来        →  会话自己持有，压缩后只留摘要，不进节点上下文
 *
 * 这个二分是这层的全部要点。把对话历史整个塞进 prompt 是最容易想到的做法，也是
 * 错的：闲聊会挤掉证据，而真正要紧的那句口径约定会在第 40 轮被滚动窗口丢掉 ——
 * **恰恰是它最该活到最后。**
 *
 * 压缩因此有一条铁律：`Decision` **永不进压缩器**。轮次可以被摘要吃掉，
 * 决定只会被后来的决定推翻，不会被"太久了"淘汰。
 */

import { sha256Hex } from "../ids.js";
import { MemoryItem, MemoryKind, Scope, estTokens } from "./types.js";

// ── Python 语义的小工具 ──────────────────────────────────────────

/**
 * Python str 比较按码点；JS 默认 `sort()` 按 UTF-16 码元。BMP 内一致，
 * U+FFFF 与 U+10000 这类跨界比较才分叉。
 *
 * `types.ts` 里有同名私有函数但没导出，这里各写一份 —— 两处都很短，且都由各自的
 * golden 钉着，不存在"改了一处忘了另一处"的静默风险。
 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/** `s[:n]` —— 按**码点**切，CJK/emoji 才不会被切半个（契约 §1）。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `len(s)` —— 码点数，不是 `.length` 的 UTF-16 码元数。 */
function cpLen(s: string): number {
  return [...s].length;
}

/**
 * Python 的 `arr[-limit:]`。
 *
 * **`limit === 0` 时 Python 给的是整个列表**（`arr[-0:]` == `arr[0:]`），不是空。
 * `render_recent(limit=0)` 因此会把全部原文倒出来 —— 这是 Python 切片的既有行为，
 * 不是笔误，照抄。写成 `arr.slice(-limit)` 的话 JS 会给整个数组，恰好也对；
 * 但 `limit < 0` 那侧就分叉了，所以还是显式按 Python 的规则算。
 */
function pyTailSlice<T>(arr: readonly T[], limit: number): T[] {
  const start = -limit;
  if (start < 0) return arr.slice(Math.max(0, arr.length + start));
  return arr.slice(Math.min(start, arr.length));
}

/** Python 的 `str.strip(chars)`：从两端剥掉**任意**属于 chars 的字符。 */
function stripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i]!)) i++;
  while (j > i && set.has(cps[j - 1]!)) j--;
  return cps.slice(i, j).join("");
}

// ── Speaker ───────────────────────────────────────────────────────

export const Speaker = {
  USER: "user",
  ASSISTANT: "assistant",
  /** 系统事件在对话里的投影（"已完成梳理，171 个对象"）。它不是谁说的话，
   * 但用户会拿它当上下文引用（"刚才那 171 个里……"），所以必须留在轮次里。 */
  SYSTEM: "system",
} as const;
export type Speaker = (typeof Speaker)[keyof typeof Speaker];

/** 与 Python `list(Speaker)` 同序。 */
export const SPEAKERS: readonly Speaker[] = Object.values(Speaker);
const SPEAKER_VALUES: ReadonlySet<string> = new Set<string>(SPEAKERS);

/** 对应 `Speaker(value)` —— 未知值抛。会话是从库里读回来的，脏值必须当场发作。 */
export function parseSpeaker(v: unknown): Speaker {
  if (typeof v === "string" && SPEAKER_VALUES.has(v)) return v as Speaker;
  throw new Error(`未知的 Speaker: ${JSON.stringify(v)}`);
}

/** `Utterance.to_dict()` 的线上形态，键序即落盘字节序。 */
export interface UtteranceDict {
  speaker: Speaker;
  text: string;
  ts: number;
  intent: string;
  refs: string[];
  compressed: boolean;
}

export interface UtteranceInit {
  readonly speaker: Speaker;
  readonly text: string;
  readonly ts?: number | undefined;
  readonly intent?: string | undefined;
  readonly refs?: readonly string[] | undefined;
  readonly compressed?: boolean | undefined;
}

const WHO: Readonly<Record<Speaker, string>> = {
  [Speaker.USER]: "用户",
  [Speaker.ASSISTANT]: "助手",
  [Speaker.SYSTEM]: "系统",
};

/** 一轮对话。 */
export class Utterance {
  speaker: Speaker;
  text: string;
  /** Python 是 `time.time()`：**秒**为单位的浮点，不是毫秒。 */
  ts: number;
  /** 这轮被判成什么意图。规则判出来的填规则名，模型判的填意图名，判不出留空。 */
  intent: string;
  /** 这轮碰到了什么（对象 rid、问题 id、建议 id）。压缩时**不丢**，因为
   * "我们上次聊的是哪几个对象"是后续指代消解的唯一依据。 */
  refs: string[];
  compressed: boolean;

  constructor(p: UtteranceInit) {
    this.speaker = p.speaker;
    this.text = p.text;
    this.ts = p.ts ?? Date.now() / 1000;
    this.intent = p.intent ?? "";
    this.refs = [...(p.refs ?? [])];
    this.compressed = p.compressed ?? false;
  }

  get tokens(): number {
    return estTokens(this.text);
  }

  render(): string {
    return `${WHO[this.speaker]}: ${this.text}`;
  }

  toDict(): UtteranceDict {
    return {
      speaker: this.speaker,
      text: this.text,
      ts: this.ts,
      intent: this.intent,
      refs: this.refs,
      compressed: this.compressed,
    };
  }
}

// ── Decision ──────────────────────────────────────────────────────

/** 决定的类型。决定它作用到哪里、以及能不能晋升长期库。 */
export const DecisionKind = {
  CALIBER: "caliber", // 口径约定："含税一律指增值税专用发票口径"
  NAMING: "naming", // 命名规范："头表统一用 Header 后缀"
  SCOPE: "scope", // 范围取舍："临时表都不要"
  ANSWER: "answer", // 回答了某个具体澄清问题
  ADOPTION: "adoption", // 采纳/否决了某条建议
  CORRECTION: "correction", // 纠正了系统的某个判断
} as const;
export type DecisionKind = (typeof DecisionKind)[keyof typeof DecisionKind];

/** 与 Python `list(DecisionKind)` 同序。 */
export const DECISION_KINDS: readonly DecisionKind[] = Object.values(DecisionKind);
const DECISION_KIND_VALUES: ReadonlySet<string> = new Set<string>(DECISION_KINDS);

export function parseDecisionKind(v: unknown): DecisionKind {
  if (typeof v === "string" && DECISION_KIND_VALUES.has(v)) return v as DecisionKind;
  throw new Error(`未知的 DecisionKind: ${JSON.stringify(v)}`);
}

/**
 * 能晋升到长期库的类型。ANSWER 和 ADOPTION 是**就事论事**的，绑在这一份材料的
 * 某个具体条目上，跨 Run 没有意义；把它们固化成长期约束，下一个项目会莫名其妙地
 * 继承一堆和它无关的结论。CORRECTION 同理 —— 纠的是这份材料上的某个判断。
 */
export const PROMOTABLE: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  DecisionKind.CALIBER,
  DecisionKind.NAMING,
  DecisionKind.SCOPE,
]);

/** `Decision.to_dict()` 的线上形态。注意 `turn` 这个键名与字段名 `turnIndex` 不同。 */
export interface DecisionDict {
  key: string;
  kind: DecisionKind;
  statement: string;
  scope_refs: string[];
  turn: number;
  ts: number;
  active: boolean;
  superseded_by: number | null;
}

export interface DecisionInit {
  readonly kind: DecisionKind;
  readonly statement: string;
  readonly scopeRefs?: readonly string[] | undefined;
  readonly turnIndex?: number | undefined;
  readonly ts?: number | undefined;
  readonly supersededBy?: number | null | undefined;
}

/**
 * 用户在对话里拍下的一个板。
 *
 * 和 `MemoryItem` 是两回事：MemoryItem 是记忆库里的一条，Decision 是**会话里
 * 发生的一个事件**，它可能变成 MemoryItem（经过闸门），也可能只在本次会话有效。
 * 混成一个类型的话，"用户随口一说"和"已经写进长期库"就分不开了。
 */
export class Decision {
  kind: DecisionKind;
  statement: string;
  /** 作用范围。空 = 全局；否则是 rid / 问题 id / 文件名。 */
  scopeRefs: string[];
  /** 出自第几轮。审计时要能回到原话 —— 摘要过的转述不能作为依据。 */
  turnIndex: number;
  ts: number;
  /** 被后来的决定推翻时置上。**不删除** —— 推翻本身是信息，
   * 用户改主意的过程比结论更值得留档。 */
  supersededBy: number | null;

  constructor(p: DecisionInit) {
    this.kind = p.kind;
    this.statement = p.statement;
    this.scopeRefs = [...(p.scopeRefs ?? [])];
    this.turnIndex = p.turnIndex ?? -1;
    this.ts = p.ts ?? Date.now() / 1000;
    this.supersededBy = p.supersededBy ?? null;
  }

  get key(): string {
    return `dlg_${sha256Hex(`${this.kind}:${this.statement}`).slice(0, 12)}`;
  }

  get active(): boolean {
    return this.supersededBy === null;
  }

  render(): string {
    const scope = this.scopeRefs.length > 0 ? `（限 ${this.scopeRefs.slice(0, 4).join("、")}）` : "";
    return `${this.statement}${scope}`;
  }

  /**
   * 转成记忆项，准备过晋升闸门。
   *
   * `support` 记的是"人在第几轮说的"。没有 support 的记忆不许晋升 ——
   * 对话决定的 support 就是那一轮本身，这也是它能算 human-confirmed 的依据。
   *
   * 注意：**光有这条 support 并不够**。真实红队路径是模型读到 L3 里的参考档
   * 断言、再调 `decision.record` 把它当成用户拍的板 —— 那时 turnIndex 只是
   * `len(turns)-1`，指向"碰巧是最后一轮"。跨会话生效前还必须过 `userSaid`。
   */
  toMemory(runId: string): MemoryItem {
    return new MemoryItem({
      key: this.key,
      kind: this.kind !== DecisionKind.NAMING ? MemoryKind.DECISION : MemoryKind.CONVENTION,
      scope: Scope.PROJECT,
      content: this.render(),
      support: [`dialogue:${runId}:turn${this.turnIndex}`],
      confidence: 1.0,
      createdRun: runId,
      tags: ["dialogue", this.kind],
    });
  }

  toDict(): DecisionDict {
    return {
      key: this.key,
      kind: this.kind,
      statement: this.statement,
      scope_refs: this.scopeRefs,
      turn: this.turnIndex,
      ts: this.ts,
      active: this.active,
      superseded_by: this.supersededBy,
    };
  }
}

// ── 压缩 ──────────────────────────────────────────────────────────

/** 压缩器签名。生产上是一次廉价 LLM 调用，降级和测试走启发式。 */
export type Digester = (turns: readonly Utterance[]) => string;

/**
 * markdown 小标题 / 加粗行 —— 助手用它们给自己产出的东西起名，而用户后来正是
 * 用这个名字来指它（"把那张 AI 招聘业务流程梳理表导出来"）。
 *
 * `u` 标志是必需的：`.{2,60}?` 在 Python 里数的是**码点**，JS 不带 `u` 时数的是
 * UTF-16 码元，带 emoji 的标题会在 60 这个上限上分叉。
 *
 * 已知的窄分叉（不修，修了反而与 Python 不一致）：JS 的 `^`/`$` 在 `m` 下把
 * `\r`、U+2028、U+2029 也当行边界，Python 的只认 `\n`；Python 的 `\s` 含
 * `\x1c-\x1f`/`\x85` 而 JS 不含，JS 的含 `﻿` 而 Python 不含。助手产出的
 * markdown 走的是 `\n`，撞不上。
 */
const TITLE_LINE = /^\s*(?:#{1,6}\s*|\*\*)(.{2,60}?)(?:\*\*)?\s*$/gmu;
const TABLE_LINE = /^\s*\|.*\|\s*$/mu;

/**
 * 这条回答里**产出了什么**，用它的名字表示。
 *
 * 只在正文里出现过竖线表时才认标题 —— 否则每条回答的小标题都会被当成产出，
 * 摘要立刻变成一堆噪声。
 */
function producedIn(text: string): string[] {
  const t = text || "";
  if (!TABLE_LINE.test(t)) return [];
  const names: string[] = [];
  for (const m of t.matchAll(TITLE_LINE)) names.push(stripChars(m[1] ?? "", " *：:「」【】"));
  return names.filter((n) => cpLen(n) >= 2 && cpLen(n) <= 60).slice(0, 3);
}

/**
 * 不调模型的兜底压缩。
 *
 * **原来只保留用户说过的话**，理由是"助手的回复可以重新生成"。这条在别处成立，
 * 在这个产品里不成立：助手产出的表格/清单是**一次性的**（同一个提问再问一遍，
 * 模型给的表不会一样），而用户过两轮回头说"把刚才那张 AI 招聘表导出来"时，
 * 那条回答已经被压成一句摘要 —— 系统就只能翻出另一张表给他。
 *
 * 所以这里保三样，按重要性排：
 *   1. 用户说过什么（不可再生）；
 *   2. 助手**产出过什么**（按名字记，让它后面还能被指认）；
 *   3. 涉及的 rid（指代消解唯一的依据）。
 *
 * 另外绝不产出一条空摘要：原来 `said` 为空时，整条摘要就是
 * "（已压缩 2 轮）用户说过：" —— 冒号后面什么都没有，等于凭空吞掉两轮。
 */
export function heuristicDigest(turns: readonly Utterance[]): string {
  const said: string[] = [];
  for (const t of turns) {
    if (t.speaker === Speaker.USER && t.text.trim()) {
      said.push(cpSlice(t.text.replaceAll("\n", " ").trim(), 60));
    }
  }
  const made: string[] = [];
  for (const t of turns) {
    if (t.speaker === Speaker.ASSISTANT) {
      for (const n of producedIn(t.text)) if (!made.includes(n)) made.push(n);
    }
  }
  const refs: string[] = [];
  for (const t of turns) {
    for (const r of t.refs) if (!refs.includes(r)) refs.push(r);
  }

  const parts = [`（已压缩 ${turns.length} 轮）`];
  if (said.length > 0) parts.push("用户说过：" + said.slice(0, 8).join("；"));
  if (made.length > 0) {
    parts.push("助手产出过：" + made.slice(0, 6).map((n) => `《${n}》`).join("、"));
  }
  if (refs.length > 0) parts.push("涉及：" + refs.slice(0, 12).join("、"));
  if (parts.length === 1) {
    // 三样都没有也要留个痕，别让摘要看起来像"这两轮什么都没发生"
    parts.push(`（${turns.length} 轮内容已压缩，原文见会话事件记录）`);
  }
  return parts[0]! + parts.slice(1).join("｜");
}

// ── DialogueMemory ────────────────────────────────────────────────

export interface DialogueMemoryDict {
  turns: UtteranceDict[];
  decisions: DecisionDict[];
  compactions: number;
}

export interface DialogueMemoryInit {
  /** 轮次部分的预算。**决定不占这个预算** —— 决定是必须知道的，没有"装不下就
   * 不装"这个选项；装不下要削的是别的层。 */
  readonly budgetTokens?: number | undefined;
  /** 最近多少轮保留原文。指代消解（"那个"、"刚才那条"）只依赖最近几轮，
   * 再往前的原文没有保留价值。 */
  readonly keepVerbatim?: number | undefined;
  readonly digester?: Digester | undefined;
}

/** 一次会话的对话记忆。 */
export class DialogueMemory {
  budgetTokens: number;
  keepVerbatim: number;
  compactions = 0;
  private readonly digest: Digester;
  private turnList: Utterance[] = [];
  private readonly decisionList: Decision[] = [];

  constructor(p: DialogueMemoryInit = {}) {
    this.budgetTokens = p.budgetTokens ?? 4_000;
    this.keepVerbatim = p.keepVerbatim ?? 8;
    this.digest = p.digester ?? heuristicDigest;
  }

  // ── 写入 ────────────────────────────────────────────────────

  say(
    speaker: Speaker | string,
    text: string,
    opts: { readonly intent?: string | undefined; readonly refs?: readonly string[] | undefined } = {},
  ): Utterance {
    const u = new Utterance({
      speaker: parseSpeaker(speaker),
      text,
      intent: opts.intent ?? "",
      refs: [...(opts.refs ?? [])],
    });
    this.turnList.push(u);
    return u;
  }

  /** 记一个决定。同类同范围的旧决定会被标记为已推翻，但不删除。 */
  decide(
    kind: DecisionKind | string,
    statement: string,
    opts: { readonly scopeRefs?: readonly string[] | undefined } = {},
  ): Decision {
    const k = parseDecisionKind(kind);
    const d = new Decision({
      kind: k,
      statement,
      scopeRefs: [...(opts.scopeRefs ?? [])],
      turnIndex: this.turnList.length - 1,
    });
    const idx = this.decisionList.length;
    const mine = [...d.scopeRefs].sort(codePointCompare);
    for (const old of this.decisionList) {
      // 同类型 + 同作用域 = 后者推翻前者。作用域不同则并存 ——
      // "临时表都不要"和"但 clmSpaImportTmp 要留"不是矛盾，是细化。
      if (old.active && old.kind === k && sameList([...old.scopeRefs].sort(codePointCompare), mine)) {
        old.supersededBy = idx;
      }
    }
    this.decisionList.push(d);
    return d;
  }

  // ── 读取 ────────────────────────────────────────────────────

  get turns(): Utterance[] {
    return [...this.turnList];
  }

  /** 全部决定，含已被推翻的。 */
  get decisions(): Decision[] {
    return [...this.decisionList];
  }

  /**
   * 当前生效的决定。
   *
   * `refs`：只要作用到这些 rid 上的（含全局决定）。节点装配上下文时按自己处理的
   * 对象过滤 —— 全量注入会让每个节点都背上整个会话的决定。
   *
   * 注意两个入参的判据**不一样**：`kinds` 走真值（空数组 = 不过滤），`refs` 走
   * `is not None`（空数组 = 只留全局决定）。照抄 Python，别"统一"成一种。
   */
  activeDecisions(
    opts: {
      readonly kinds?: readonly DecisionKind[] | undefined;
      readonly refs?: readonly string[] | null | undefined;
    } = {},
  ): Decision[] {
    let out = this.decisionList.filter((d) => d.active);
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length > 0) out = out.filter((d) => kinds.includes(d.kind));
    if (opts.refs !== undefined && opts.refs !== null) {
      const want = new Set(opts.refs);
      out = out.filter((d) => d.scopeRefs.length === 0 || d.scopeRefs.some((r) => want.has(r)));
    }
    return out;
  }

  get tokens(): number {
    let n = 0;
    for (const t of this.turnList) n += t.tokens;
    return n;
  }

  overBudget(threshold = 0.7): boolean {
    return this.tokens > this.budgetTokens * threshold;
  }

  // ── 压缩 ────────────────────────────────────────────────────

  /**
   * 压掉最老的一批轮次。**决定不参与压缩。**
   *
   * 决定是从轮次里提炼出来的独立对象，压掉轮次不会带走它们 —— 这正是把两者分开
   * 存的意义。滚动窗口式的对话历史做不到这一点：第 40 轮时，第 3 轮那句口径约定
   * 已经滑出窗口了，而它恰恰是最该活到最后的东西。
   */
  compact(): boolean {
    const head = this.turnList.length - this.keepVerbatim;
    if (head <= 1) return false;
    const old = this.turnList.slice(0, head);
    const keep = this.turnList.slice(head);
    if (old.every((t) => t.compressed)) return false;
    const mergedRefs: string[] = [];
    for (const t of old) {
      for (const r of t.refs) if (!mergedRefs.includes(r)) mergedRefs.push(r);
    }
    const summary = new Utterance({
      speaker: Speaker.SYSTEM,
      text: this.digest(old),
      refs: mergedRefs,
      compressed: true,
    });
    this.turnList = [summary, ...keep];
    this.compactions += 1;
    return true;
  }

  compactToFit(threshold = 0.7): number {
    let n = 0;
    while (this.overBudget(threshold) && this.compact()) n += 1;
    return n;
  }

  // ── 装配 ────────────────────────────────────────────────────

  /** 给节点上下文用的决定清单。进 L3。 */
  renderDecisions(opts: { readonly refs?: readonly string[] | null | undefined } = {}): string {
    const ds = this.activeDecisions(opts.refs === undefined ? {} : { refs: opts.refs });
    if (ds.length === 0) return "";
    return ds.map((d) => `· 已拍板：${d.render()}`).join("\n");
  }

  /** 最近几轮原文。只在**回复用户**时用，不进节点上下文 ——
   * 抽取节点不需要知道用户跟你寒暄过什么。 */
  renderRecent(limit = 6): string {
    return pyTailSlice(this.turnList, limit)
      .map((t) => t.render())
      .join("\n");
  }

  /**
   * 够格进长期库的决定。
   *
   * 只有口径/命名/范围这三类跨 Run 才成立。回答某个问题、采纳某条建议是
   * **就事论事**的，绑在这份材料的具体条目上；固化成长期约束的话，下一个
   * 项目会继承一堆和它毫无关系的结论 —— 长期记忆一旦污染，代价远高于短期。
   */
  promotable(runId: string): MemoryItem[] {
    return this.decisionList
      .filter((d) => d.active && PROMOTABLE.has(d.kind))
      .map((d) => d.toMemory(runId));
  }

  // ── 持久化 ──────────────────────────────────────────────────

  toDict(): DialogueMemoryDict {
    return {
      turns: this.turnList.map((t) => t.toDict()),
      decisions: this.decisionList.map((d) => d.toDict()),
      compactions: this.compactions,
    };
  }

  static fromDict(data: unknown, init: DialogueMemoryInit = {}): DialogueMemory {
    const d = asObject(data, "对话记忆");
    const dm = new DialogueMemory(init);
    for (const raw of asArray(d["turns"])) {
      const t = asObject(raw, "轮次");
      dm.turnList.push(
        new Utterance({
          speaker: parseSpeaker(t["speaker"]),
          text: reqStr(t["text"], "轮次 text"),
          ts: numOr(t["ts"], 0.0),
          intent: strOr(t["intent"], ""),
          refs: strListOr(t["refs"]),
          compressed: Boolean(t["compressed"]),
        }),
      );
    }
    for (const raw of asArray(d["decisions"])) {
      const x = asObject(raw, "决定");
      const dec = new Decision({
        kind: parseDecisionKind(x["kind"]),
        statement: reqStr(x["statement"], "决定 statement"),
        scopeRefs: strListOr(x["scope_refs"]),
        turnIndex: numOr(x["turn"], -1),
        ts: numOr(x["ts"], 0.0),
      });
      // active 不是存出来的字段，靠 supersededBy 还原，避免两处真相打架
      const sb = x["superseded_by"];
      dec.supersededBy = typeof sb === "number" ? sb : null;
      dm.decisionList.push(dec);
    }
    dm.compactions = Math.trunc(numOr(d["compactions"], 0));
    return dm;
  }

  get length(): number {
    return this.turnList.length;
  }
}

// ── fromDict 的取值助手 ──────────────────────────────────────────

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${what}不是对象: ${JSON.stringify(v)}`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function reqStr(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what}不是字符串: ${JSON.stringify(v)}`);
  return v;
}

// 与 `types.fromDict` 的助手同一套姿态：**只有缺失/null 才回退**，类型不对当场拒。
// Python 那边不校验值类型，一个 `"ts": "刚才"` 会一路带进内存直到某处做算术才炸；
// 静默换成默认值更糟 —— 那是不留痕地丢数据。

function strOr(v: unknown, dflt: string): string {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "string") throw new Error(`期望字符串: ${JSON.stringify(v)}`);
  return v;
}

function numOr(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number") throw new Error(`期望数字: ${JSON.stringify(v)}`);
  return v;
}

function strListOr(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`期望数组: ${JSON.stringify(v)}`);
  for (const x of v) {
    if (typeof x !== "string") throw new Error(`数组里有非字符串项: ${JSON.stringify(x)}`);
  }
  return v as string[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ══════════════════════════════════════════════════════════════════
//  quote 校验 —— 「参考档洗成权威档」那条路的堵点
// ══════════════════════════════════════════════════════════════════
//
// 这两个函数在 Python 侧住在 `server.py`（`_norm_quote` / `_user_said`），但它们
// 问的是**对话记忆**的问题（"用户这次真的说过这句话吗"），数据也只在这里。移植
// 时放进 dialogue.ts，server 层接过来直接用这一份 —— 抄第二份就一定会分叉，而
// 分叉的表现是这道校验在某条路上悄悄失效，正好是它要防的事故本身。

/** 归一化：只留下能承载意思的字符。模型复述用户的话时标点和空白几乎一定会变，
 * 按原样比对等于这道校验永远不通过。 */
const QUOTE_NOISE = /[\s，,。.、；;：:！!？?「」『』"'（）()【】\[\]—\-…]+/gu;

export function normQuote(text: string | null | undefined): string {
  return String(text ?? "").replace(QUOTE_NOISE, "");
}

/** `userSaid` 只需要"有哪些轮、谁说的、说了什么" —— 结构化依赖，DialogueMemory
 * 天然满足，server 层的任何轮次容器也能满足。 */
export interface SpokenTurns {
  readonly turns: readonly { readonly speaker: string; readonly text: string }[];
}

/**
 * `quote` 是不是用户**真的说过**的话。是就返回命中的那句原文，否则空串。
 *
 * 这道校验是「参考档洗成权威档」那条路的堵点。红队复现过：第一个会话里模型自己
 * 猜出来的口径进了参考档（带「参考·未确认」标注），第二个会话把它渲染进 L3，
 * 模型逐字读到之后调 `decision.record` 把这句话当成用户拍的板记下来 —— 于是
 * 一条推断变成了同项目所有后续会话的「人已拍板」，置信度 1.0、不带任何标注、
 * 还能进交付给客户的包。
 *
 * 晋升闸门拦不住它，因为闸门检查的是**传进去的那个对象**，而这条路造的是一条
 * 全新的、tier 默认为 AUTHORITATIVE 的条目。真正缺的东西是：**没有任何代码
 * 验证过这句话出自人**。原来的 support 是 `dialogue:{run}:turn{idx}`，而
 * `turnIndex` 只是 `len(turns)-1` —— 指向"碰巧是最后一轮"的那句话。
 * 复现里它指向的原话是「你好，这份材料能看吗」。那不是出处，是一个长得像出处
 * 的字符串。
 *
 * 比对做了归一化（去空白与常见标点），因为模型转述时标点几乎一定会变。
 */
export function userSaid(dm: SpokenTurns | null | undefined, quote: string): string {
  const q = normQuote(quote);
  // 一两个字的"引用"能命中几乎任何一句话，等于没校验
  if (cpLen(q) < 2) return "";
  const turns = dm?.turns ?? [];
  // 倒着找：同一句话说过多次时，出处应当是**最近**的那一轮
  for (let i = turns.length - 1; i >= 0; i--) {
    const u = turns[i]!;
    if (String(u.speaker) !== Speaker.USER) continue;
    if (normQuote(u.text).includes(q)) return u.text;
  }
  return "";
}
