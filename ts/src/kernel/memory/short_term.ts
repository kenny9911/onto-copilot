/**
 * 短期记忆 —— Run 之内的工作记忆。移植自 Python 侧 `kernel/memory/short_term.py`，
 * 由 `golden/memory.evidence.json` 的 `short_term` 一节钉住。
 *
 * 两个容器，生命周期不同：
 *
 *   * `Scratchpad` —— **节点作用域**。一次 agent loop 里的 thought/action/observation
 *     三元组。节点退出时整个丢掉，只留一份 `digest()`。这是控制上下文膨胀的主力：
 *     某个节点内部转了 20 轮，下游节点看到的只有结论。
 *
 *   * `WorkingSet` —— **Run 作用域**。沿 DAG 边流动的结构化产出。
 *
 * 压缩纪律（架构文档 §4.3）：working set 超过预算 70% 时压缩最老的 observation，
 * 但 **locator 永不压缩** —— locator 丢了溯源就断了，而溯源是这个产品的信任基础。
 */

import { pyJsonDumps } from "../journal.js";
import { estTokens } from "./types.js";

// ── locator 抽取 ──────────────────────────────────────────────────

/*
 * Python 的 `\w` / `\b` / `\d` / `\s` 在 str 模式下**全是 Unicode 语义**，
 * JS 的对应物有三处不同，直译这条正则会让中文材料里的 locator 大面积错抓错漏：
 *
 *   \w   Python = 字母 + 数字 + 下划线（含汉字）   JS = [A-Za-z0-9_]
 *   \b   跟着 \w 走，所以 "见f3:sheet0" 里 见/f 之间**没有**边界（不匹配）；
 *        JS 的 \b 只认 ASCII，会在那里判出边界 → 凭空抓出一个 locator
 *   \d   Python = Unicode Nd（全角 R４４C６ 也认）  JS = [0-9]
 *   \s   两边差四个：\x1c-\x1f 和 \x85 只有 Python 认，﻿ 只有 JS 认
 *
 * 所以这里把四个都写成显式集合。看着啰嗦，但这条正则决定"模型说的位置能不能被
 * pin 住"，而 pin 不住的 locator 会在压缩时被当成普通文本丢掉。
 */

/**
 * Python `\w`（str 模式）= `str.isalnum()` 加下划线。
 *
 * 逐码点比对过 0–0x10FFFF：CPython 3.12（Unicode 15.0）判真的字符这里**一个不少**；
 * 这里多出来的 9661 个在 Python 那份 Unicode 数据里全是 `Cn`（未分配）—— 差的是
 * V8 的 ICU 版本更新，不是判据不同。Unicode 15 里已分配的字符两边逐个一致。
 */
const PY_W = String.raw`\p{L}\p{N}_`;
/** Python `\d`（str 模式）= Unicode Nd。同样比对过全码点，差集也只有新版新加的 90 个。 */
const PY_D = String.raw`\p{Nd}`;
/** Python `\s`（str 模式）= `str.isspace()` 的 29 个字符，逐个列出。**不写字面字符**：
 * 那一串里有 U+2028/2029 这种源码里看不见、还会影响解析的东西。 */
const PY_S = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

/**
 * 从任意文本里捞 locator 的模式，压缩时强制保留。
 * 覆盖 `实体梳理.xlsx!业务对象实体梳理!R44C6`、`f3:sheet0:rows[40..48]`、
 * `$.components.schemas.Plan`、`clm_contract:L12-18`。
 *
 * 原件第一段字符类里的 `一-鿿` 被 `\w` 完全包住（汉字本来就是词字符），
 * 这里不再重复写一遍。
 */
const LOCATOR_RE = new RegExp(
  `(?:[${PY_W}.\\-]+\\.(?:xlsx|csv|docx|json|ddl|sql|png|pdf)` +
    `(?:[!:#][^${PY_S},;，；、)】]*)?)` +
    `|(?:(?<![${PY_W}])f${PY_D}+:[${PY_W}\\[\\].\\-]+)` +
    `|(?:\\$\\.[${PY_W}.\\[\\]*]+)` +
    `|(?:(?<![${PY_W}])R${PY_D}+C${PY_D}+(?![${PY_W}]))`,
  "gu",
);

export function extractLocators(text: string): string[] {
  // Python 用 `dict[str, None]` + setdefault —— 要的是"去重且保出现顺序"。
  const seen = new Set<string>();
  for (const m of (text || "").matchAll(LOCATOR_RE)) seen.add(m[0]);
  return [...seen];
}

// ── Turn ──────────────────────────────────────────────────────────

/** `new Turn(...)` 的入参。四个字段全有默认值。 */
export interface TurnInit {
  readonly thought?: string | undefined;
  readonly action?: string | undefined;
  readonly observation?: string | undefined;
  readonly compressed?: boolean | undefined;
}

/** agent loop 的一轮。 */
export class Turn {
  thought: string;
  action: string;
  observation: string;
  compressed: boolean;

  constructor(p: TurnInit = {}) {
    this.thought = p.thought ?? "";
    this.action = p.action ?? "";
    this.observation = p.observation ?? "";
    this.compressed = p.compressed ?? false;
  }

  /** Python 侧是 `@property`。 */
  get tokens(): number {
    return estTokens(this.thought) + estTokens(this.action) + estTokens(this.observation);
  }

  render(): string {
    const parts: string[] = [];
    if (this.thought) parts.push(`想: ${this.thought}`);
    if (this.action) parts.push(`做: ${this.action}`);
    if (this.observation) parts.push(`见: ${this.observation}`);
    return parts.join("\n");
  }
}

/**
 * 压缩器签名：拿到若干轮，返回一段摘要。生产上是一次廉价 LLM 调用，
 * 测试和降级路径用启发式。
 */
export type Summarizer = (turns: Turn[]) => string;

/** 不调模型的兜底压缩：保留动作序列和观察的首句。 */
export function heuristicSummary(turns: Turn[]): string {
  const acts: string[] = [];
  const obs: string[] = [];
  for (const t of turns) if (t.action) acts.push(t.action);
  for (const t of turns) {
    // `[:80]` 按**码点**切：观察里带 emoji 时，JS 的 `.slice(0,80)` 会在代理对
    // 中间切开，拼出来的摘要里是半个字符（而这段摘要会进 prompt）。
    if (t.observation) obs.push([...t.observation.split("。")[0]!].slice(0, 80).join(""));
  }
  return (
    `（已压缩 ${turns.length} 轮）动作: ${acts.slice(0, 8).join(" → ")}；` +
    `要点: ${obs.slice(0, 4).join("；")}`
  );
}

// ── Scratchpad ────────────────────────────────────────────────────

/** `Scratchpad.digest()` 的返回形态 —— **只有这个会跨节点**，键序即落盘字节序。 */
export interface Digest {
  turns: number;
  summary: string;
  locators: string[];
  compactions: number;
}

/** 构造参数。 */
export interface ScratchpadOptions {
  /** 触发压缩的软上限。 */
  readonly budgetTokens?: number | undefined;
  /** 最近多少轮不压缩 —— 近期上下文对下一步决策最有用。 */
  readonly keepVerbatim?: number | undefined;
  /** 压缩器，默认走启发式。 */
  readonly summarizer?: Summarizer | null | undefined;
}

/** 节点作用域的工作记忆。 */
export class Scratchpad {
  budgetTokens: number;
  keepVerbatim: number;
  compactions: number;

  private readonly _summarize: Summarizer;
  private _turns: Turn[] = [];
  /** 压缩中幸存下来的 locator。Python 侧是 list + `not in` 去重（O(n²)），
   * 这里另挂一个 Set 做查重 —— 顺序与去重结果完全一致，只是不再逐条线性扫。 */
  private readonly _pinned: string[] = [];
  private readonly _pinnedSeen = new Set<string>();

  constructor(opts: ScratchpadOptions = {}) {
    this.budgetTokens = opts.budgetTokens ?? 24_000;
    this.keepVerbatim = opts.keepVerbatim ?? 6;
    this._summarize = opts.summarizer ?? heuristicSummary;
    this.compactions = 0;
  }

  // ── 写入 ────────────────────────────────────────────────────
  append(thought = "", action = "", observation = ""): Turn {
    const turn = new Turn({ thought, action, observation });
    this._turns.push(turn);
    for (const text of [thought, action, observation]) {
      for (const loc of extractLocators(text)) {
        if (!this._pinnedSeen.has(loc)) {
          this._pinnedSeen.add(loc);
          this._pinned.push(loc);
        }
      }
    }
    return turn;
  }

  // ── 状态 ────────────────────────────────────────────────────
  get turns(): Turn[] {
    return [...this._turns];
  }

  get tokens(): number {
    let s = 0;
    for (const t of this._turns) s += t.tokens;
    return s + estTokens(this._pinned.join(" "));
  }

  get locators(): string[] {
    return [...this._pinned];
  }

  overBudget(threshold = 0.7): boolean {
    return this.tokens > this.budgetTokens * threshold;
  }

  // ── 压缩 ────────────────────────────────────────────────────
  /**
   * 压缩最老的若干轮。返回是否真的压了。
   *
   * locator 不进压缩器 —— 它们已经被 pin 住，压缩后仍完整挂在 scratchpad 上。
   *
   * `head <= 1` 这条边界照抄：`head` 是"要被压掉的轮数"，只压一轮没有收益
   * （一轮换一条摘要），而 `head <= 0` 时 `_turns[:head]` 在 Python 里是**从尾部
   * 倒数**的切片 —— 真按 `head < 0` 走下去会把最近几轮当成"最老的"压掉，
   * 也就是把用户刚说的话吃掉。这里 JS 的 `slice(0, 负数)` 语义还不一样，
   * 更不能靠"反正切片会给空"糊过去，必须由这个前置判断挡住。
   */
  compact(): boolean {
    const head = this._turns.length - this.keepVerbatim;
    if (head <= 1) return false;
    const old = this._turns.slice(0, head);
    const keep = this._turns.slice(head);
    if (old.every((t) => t.compressed)) return false; // 已经压过了，再压没有收益
    const summary = new Turn({ observation: this._summarize(old), compressed: true });
    this._turns = [summary, ...keep];
    this.compactions += 1;
    return true;
  }

  compactToFit(threshold = 0.7): number {
    let n = 0;
    while (this.overBudget(threshold) && this.compact()) n += 1;
    return n;
  }

  // ── 输出 ────────────────────────────────────────────────────
  render(): string {
    const rendered: string[] = [];
    for (const t of this._turns) {
      const r = t.render();
      if (r) rendered.push(r);
    }
    const body = rendered.join("\n\n");
    if (this._pinned.length === 0) return body;
    const locs = this._pinned.slice(0, 40).join("、");
    return body ? `${body}\n\n[本节点已引用的证据位置] ${locs}` : `[证据位置] ${locs}`;
  }

  /** 节点退出时留给下游的东西 —— **只有这个会跨节点**。 */
  digest(maxTokens = 600): Digest {
    // Python 把 `self._turns` 本体（不是副本）交给压缩器，这里同样 —— 换成副本
    // 会让"压缩器就地标记 compressed"这类写法在两侧行为不同。
    let text = this._turns.length > 0 ? this._summarize(this._turns) : "";
    // `len(text)` / `text[:n]` 都按**码点**。摘要里必然有中文，还可能有 emoji，
    // 用 JS 的 `.length` / `.slice` 会同时错判长度和切出半个代理对。
    let cps = [...text];
    while (estTokens(text) > maxTokens && cps.length > 80) {
      cps = cps.slice(0, Math.trunc(cps.length * 0.8));
      text = cps.join("");
    }
    return {
      turns: this._turns.length,
      summary: text,
      locators: this._pinned.slice(0, 64),
      compactions: this.compactions,
    };
  }

  /** Python 的 `__len__`。 */
  get size(): number {
    return this._turns.length;
  }
}

// ── WorkingSet ────────────────────────────────────────────────────

/**
 * Run 作用域：沿 DAG 边流动的节点产出。
 *
 * 只存**结构化产出**，不存节点内部过程 —— 那是 Scratchpad 的事，且不跨节点。
 */
export class WorkingSet {
  /** 键序 = 插入序，与 Python dict 一致。**例外**：形如 `"0"` / `"12"` 的整数样式
   * 键会被 V8 提到最前面。节点 id 是 `PARSE.xlsx` 这种，撞不上。 */
  outputs: Record<string, unknown> = {};
  digests: Record<string, Record<string, unknown>> = {};

  put(nodeId: string, output: unknown, digest?: Record<string, unknown> | null): void {
    this.outputs[nodeId] = output;
    // Python 是 `if digest:` —— 空 dict 也不写。空摘要写进去只会让下游多一次
    // "有 digest 但里面什么都没有"的分支。
    if (digest !== undefined && digest !== null && Object.keys(digest).length > 0) {
      this.digests[nodeId] = digest;
    }
  }

  /**
   * `Object.hasOwn` 而不是 `in`：`in` 会命中原型链，`ws.get("toString")` 就会返回
   * `Object.prototype.toString` 而不是默认值 —— Python 的 dict 没有这层，
   * 而节点 id 是上游传下来的字符串，不该由它决定走哪条分支。
   * （同理，`put("__proto__", …)` 在 JS 里是改原型不是写字段。节点 id 来自 DAG
   * 定义，撞不上；真要防住得给这两个 dict 用 null 原型，那是另一次设计决定。）
   */
  get(nodeId: string, dflt: unknown = null): unknown {
    return Object.hasOwn(this.outputs, nodeId) ? this.outputs[nodeId] : dflt;
  }

  /** 按 DAG 依赖取上游产出。支持 `PARSE.*` 通配 fan-out 节点。 */
  select(nodeIds: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const nid of nodeIds) {
      if (nid.endsWith(".*")) {
        const pre = nid.slice(0, -1); // `PARSE.*` → 前缀 `PARSE.`
        for (const [k, v] of Object.entries(this.outputs)) {
          if (k.startsWith(pre)) out[k] = v;
        }
      } else if (Object.hasOwn(this.outputs, nid)) {
        out[nid] = this.outputs[nid];
      }
    }
    return out;
  }

  /**
   * Python 侧是 `est_tokens(json.dumps(self.outputs, ensure_ascii=False, default=str))`。
   *
   * 必须走 journal 的 `pyJsonDumps` 而不是 `JSON.stringify`：Python 的默认分隔符是
   * `", "` / `": "`，每个键值对多两个空格 —— 一份几百个键的产出能差出上百 token，
   * 而这个数字直接决定 context 装配时要不要裁掉 working set。
   */
  get tokens(): number {
    return estTokens(pyJsonDumps(this.outputs, { defaultStr: true }));
  }
}
