/**
 * 意图识别 —— 把一句自然语言落到一个**封闭集合**上。移植自 `kernel/intent.py`，
 * 行为由 `golden/intent.json` 逐条钉住。
 *
 * 产品里最容易做错的一步是"把用户说的话整个丢给模型，让它自由发挥"。那样做有两个
 * 后果：一是不可审计（同一句话两次跑出不同动作，事后没人说得清为什么），二是不可
 * 拒绝（模型总能编出一个动作来，哪怕它根本没听懂）。
 *
 * 这里的做法相反：
 *
 * 1. **意图是封闭集合。** 每个意图有确定的槽位和确定的执行器。集合之外的一律落到
 *    {@link Intent.UNKNOWN}，由上层去反问，而不是勉强归类。
 * 2. **规则先判。** 引用了问题编号、点了建议序号、说了"别要/排除"——这些规则判得
 *    比模型准，也不花钱（ADR-5）。规则判不了才上模型。
 * 3. **一句话可能有多个意图。** "第3条采纳，另外临时表别要了"是两件事，必须拆开，
 *    否则执行器只会做前一件。
 * 4. **低置信度不猜。** 置信度低于阈值时返回 UNKNOWN 并附上候选，让上层反问 ——
 *    猜错一个 SET_SCOPE 会静默删掉一批对象，代价远高于多问一句。
 *
 * 模型判定走**结构化输出**，且只在规则失败时调用；判出来的结果仍要过一遍槽位校验，
 * 模型说 "adopt suggestion sg-99" 而这个 id 不存在，照样降级成 UNKNOWN。
 *
 * ── 移植时非做不可的三处重写（照抄正则会判错）────────────────────────────
 *
 * 1. **`\b` 换成 Unicode 词边界。** Python 的 `\w`（`\b` 的判据）认中文，JS 的只认
 *    ASCII。中英混输在这个产品里是常态：「采纳adopt」在 Python 下 `\badopt` **不**
 *    匹配（"纳"是词字符，中间没有边界），JS 下匹配。判据两边不一样，同一句话就会
 *    路由到不同的 handler。所以下面一律用 {@link BL} / {@link BR} 拼。
 * 2. **`\s` 换成 Python 的空白集**（多 U+001C–U+001F、少 U+FEFF）。`_CONJ` 的分句、
 *    `_CHITCHAT` 的整句匹配、`_QUESTION` 的句尾判定三处都带 `\s`。
 * 3. **长度与切片按 code point**。`len(c) > 200` 与 `c[:80]` 在 Python 里数的是码点：
 *    100 个 emoji 在 JS 的 `.length` 下是 200，正好骑在 `_pasted` 的阈值上 ——
 *    一边判 ADD_CONTEXT 一边判 UNKNOWN。
 */

import { roundHalfEven } from "./budget.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义的正则零件（与 catalog.ts 同一套判据，各自本地一份以免跨模块耦合）
// ══════════════════════════════════════════════════════════════════

/** Python 的 `\s`（str 模式）。 */
const S = "[\\p{White_Space}\\x1c-\\x1f]";
/** Python 的 `\b`，词**首**那一侧。判据是 Python 的 `\w`，它认中文。 */
const BL = "(?<![\\p{L}\\p{N}_])";
/** Python 的 `\b`，词**尾**那一侧。 */
const BR = "(?![\\p{L}\\p{N}_])";

/** `re.compile(..., re.IGNORECASE)`。`u` 让 `.` 与字符类按 code point 走。 */
function re(source: string, flags = ""): RegExp {
  return new RegExp(source, `iu${flags}`);
}

/** `s[:n]` —— 按 code point 切。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `len(s)` —— Python 数的是 code point。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** `str.strip(chars)` —— 按 code point 集合裁两头，不是 `trim()`。 */
function stripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i]!)) i += 1;
  while (j > i && set.has(cps[j - 1]!)) j -= 1;
  return cps.slice(i, j).join("");
}

const LSTRIP = new RegExp(`^${S}+`, "u");
const RSTRIP = new RegExp(`${S}+$`, "u");

/** `str.strip()`（不带参数）。按 Python 的空白集裁，不是 `trim()`。 */
function pyStrip(s: string): string {
  return s.replace(LSTRIP, "").replace(RSTRIP, "");
}

/** `s.split(sep, 1)[-1]`：找不到分隔符时返回原串。 */
function afterFirst(s: string, sep: string): string {
  const i = s.indexOf(sep);
  return i < 0 ? s : s.slice(i + sep.length);
}

/** `next((int(g) for g in m.groups() if g), 0)`。未参与的组是 undefined（假值）。 */
function firstGroupInt(m: RegExpExecArray): number {
  for (let i = 1; i < m.length; i += 1) {
    const g = m[i];
    // 注意 `"0"` 是**真值**：Python 里同样会走到 int("0") == 0。
    if (g !== undefined && g !== "") return Number.parseInt(g, 10);
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════
//  Intent
// ══════════════════════════════════════════════════════════════════

/** 封闭意图集合。新增意图必须同时给出槽位与执行器，否则不许加。 */
export const Intent = {
  /** 回答某个澄清问题。 */
  ANSWER_QUESTION: "answer_question",
  /** 采纳建议。 */
  ADOPT_SUGGESTION: "adopt_suggestion",
  REJECT_SUGGESTION: "reject_suggestion",
  /** 约定口径。 */
  SET_CALIBER: "set_caliber",
  /** 约定命名。 */
  SET_NAMING: "set_naming",
  /** 纳入/排除一批对象。 */
  SET_SCOPE: "set_scope",
  /** 纠正系统的某个判断。 */
  CORRECT: "correct",
  /** 要求解释某个判断。 */
  EXPLAIN: "explain",
  /** 重跑某段/某节点。 */
  RERUN: "rerun",
  /** 开始梳理。 */
  START_BUILD: "start_build",
  /** 现在什么情况。 */
  ASK_STATUS: "ask_status",
  /** 补充背景，不触发动作。 */
  ADD_CONTEXT: "add_context",
  CHITCHAT: "chitchat",
  UNKNOWN: "unknown",
} as const;

export type Intent = (typeof Intent)[keyof typeof Intent];

/** 声明顺序 == Python 的 `list(Intent)`（`INTENT_SCHEMA` 的 enum 靠它）。 */
export const INTENTS: readonly Intent[] = Object.freeze([
  Intent.ANSWER_QUESTION,
  Intent.ADOPT_SUGGESTION,
  Intent.REJECT_SUGGESTION,
  Intent.SET_CALIBER,
  Intent.SET_NAMING,
  Intent.SET_SCOPE,
  Intent.CORRECT,
  Intent.EXPLAIN,
  Intent.RERUN,
  Intent.START_BUILD,
  Intent.ASK_STATUS,
  Intent.ADD_CONTEXT,
  Intent.CHITCHAT,
  Intent.UNKNOWN,
]);

const INTENT_SET: ReadonlySet<string> = new Set<string>(INTENTS);

/** `Intent(v)` —— 未知值 **抛错**。server 从 `state["_queued"]` 读回时靠它把关。 */
export function parseIntent(v: string): Intent {
  if (INTENT_SET.has(v)) return v as Intent;
  throw new Error(`'${v}' is not a valid Intent`);
}

/** 会改变产物的意图。这些执行前要回显确认 —— 静默改掉一批对象是最难发现的错误。 */
export const MUTATING: ReadonlySet<Intent> = new Set<Intent>([
  Intent.ADOPT_SUGGESTION,
  Intent.SET_SCOPE,
  Intent.CORRECT,
  Intent.RERUN,
  Intent.ANSWER_QUESTION,
  Intent.START_BUILD,
]);

// ══════════════════════════════════════════════════════════════════
//  IntentMatch / IntentParse
// ══════════════════════════════════════════════════════════════════

export type Slots = Record<string, unknown>;

/** 一个意图及其槽位。Python 侧是 `@dataclass(slots=True)`（**可变**）。 */
export interface IntentMatch {
  intent: Intent;
  /** 0~1。规则命中给高分，模型判定用它自己的分。 */
  confidence: number;
  /** 槽位。不同意图槽位不同，校验在上层做。 */
  slots: Slots;
  /** 原句里触发这个判定的片段。回显给用户看"我是这么理解你的"。 */
  span: string;
  /** 规则名或 "llm"。审计时要能区分这一条是怎么判出来的。 */
  by: string;
}

/**
 * dataclass 的默认值搬到工厂里。
 *
 * 省略 `slots` 时**每次都是新对象**（对应 `field(default_factory=dict)`）——
 * 共享一个引用的话，两条 match 会互相看见对方写进去的槽位。显式传进来的那个
 * 则**按引用收**，与 Python 的 dataclass 一致（server 从 `_queued` 读回时靠这条）。
 */
export function makeIntentMatch(
  intent: Intent,
  confidence = 0.0,
  slots: Slots = {},
  span = "",
  by = "",
): IntentMatch {
  return { intent, confidence, slots, span, by };
}

export function isMutating(m: IntentMatch): boolean {
  return MUTATING.has(m.intent);
}

export interface IntentMatchDict {
  readonly intent: string;
  readonly confidence: number;
  readonly slots: Slots;
  readonly span: string;
  readonly by: string;
}

export function intentMatchToDict(m: IntentMatch): IntentMatchDict {
  return {
    intent: m.intent,
    // `round(x, 2)` 是 half-**even**：0.125 → 0.12，而 JS 的 toFixed 给 0.13。
    confidence: roundHalfEven(m.confidence, 2),
    slots: m.slots,
    span: m.span,
    by: m.by,
  };
}

/** 一整句话的解析结果 —— 可能含多个意图。 */
export interface IntentParse {
  text: string;
  matches: IntentMatch[];
}

export function makeIntentParse(text: string, matches: IntentMatch[] = []): IntentParse {
  // 与 dataclass 一致：显式传进来的列表按引用收，省略时每次一个新列表。
  return { text, matches };
}

export function confidentMatches(p: IntentParse): IntentMatch[] {
  return p.matches.filter((m) => m.intent !== Intent.UNKNOWN);
}

/** 一个都没判出来，或者全是低置信度 —— 该反问而不是硬做。 */
export function needsClarification(p: IntentParse): boolean {
  return confidentMatches(p).length === 0;
}

export interface IntentParseDict {
  readonly text: string;
  readonly matches: readonly IntentMatchDict[];
}

export function intentParseToDict(p: IntentParse): IntentParseDict {
  return { text: p.text, matches: p.matches.map(intentMatchToDict) };
}

// ══════════════════════════════════════════════════════════════════
//  分句
// ══════════════════════════════════════════════════════════════════

/**
 * 并列连词。"第3条采纳，另外临时表别要了"是两件事 —— 不拆的话执行器只做前一件。
 * 英文只在 "and also" 处拆（纯 "and" 太容易误拆 "temp and staging tables"）。
 */
const CONJ = re(
  `[；;。\\n]+|，${S}*(?=另外|还有|以及|同时|再有|顺便|此外|并且)|` + `,?${S}+and${S}+also${S}+`,
  "g",
);

/**
 * 把一句话拆成可以各自判意图的分句。
 *
 * 只在**强分隔符**和并列连词处拆。逗号本身不拆 —— "如果没有字段，就先按接口反推"
 * 拆开之后两半都变成了别的意思。
 */
export function splitClauses(text: string): string[] {
  // `String.split(re)` 与 `re.split` 在这条模式上同形（模式里没有捕获组，
  // 也匹配不了空串，所以不会出现 JS 特有的空片段/捕获内容混入）。
  const parts = (text || "").split(CONJ).map((p) => stripChars(p, " ，,、"));
  return parts.filter((p) => p !== "");
}

// ══════════════════════════════════════════════════════════════════
//  规则层
// ══════════════════════════════════════════════════════════════════
const NUM = "(\\d{1,3})";

/**
 * 引用某个问题：#12 / 第3个问题 / 问题5 / Q7 / question 5
 *
 * 注意 "question" 的分支要排在 "Q" 前面，且 Q 必须后跟数字 —— 否则 `[Qq]` 会先
 * 咬住 "question" 里的那个 q，导致 n=0 判不出。
 */
const Q_REF = re(
  `(?:#|问题${S}*|第${S}*${NUM}${S}*(?:个|条)?${S}*问题|question${S}*|${BL}[Qq](?=${S}*\\d))` +
    `${S}*${NUM}?`,
);
/** 引用某条建议：第3条建议 / 建议2 / 第 3 条 / suggestion 2 */
const S_REF = re(
  `(?:第${S}*${NUM}${S}*条${S}*建议|建议${S}*${NUM}|第${S}*${NUM}${S}*条|suggestion${S}*${NUM})`,
);
/**
 * 选项：选① / 第二个 / 选 B / 选项2 / option B / pick 2
 *
 * 英文序数词（"the second one"）不在此列 —— 交给模型兜底，避免槽位歧义。
 */
const OPT = re(
  `选${S}*([①②③④⑤ABCDabcd\\d])|第${S}*([一二三四五12345])${S}*个|` +
    `(?:option|pick|choose)${S}*([ABCDabcd\\d])`,
);

// 中英双语：中文规则要 CJK 才命中、英文规则要 ASCII 词才命中，两套互不串味，
// 所以合成一条正则、单一代码路径，既支持中文也支持英文命令（含混输）。
const ADOPT = re(
  `采纳|接受|同意|照(?:着)?做|就这么(?:办|干)|按你说的|可以，?${S}*执行|同意执行|` +
    `${BL}(?:adopt|accept|agree|go ahead|do it|sounds good|approve|apply it)${BR}`,
);
const REJECT = re(
  `不采纳|不接受|否决|不同意|别(?:这么|那么)做|先不|算了|` +
    `${BL}(?:reject|decline|do ?n'?t do|skip (?:it|that)|never ?mind|not now|no thanks)${BR}`,
);
const EXCLUDE = re(
  `(?:都)?(?:别|不)要|排除|去掉|删掉|不(?:用|需要)(?:建模|进本体)|剔除|` +
    `${BL}(?:exclude|drop|leave out|omit|get rid of|do ?n'?t (?:need|want|model))${BR}`,
);
const INCLUDE = re(
  `要保留|留(?:着|下)|加回来|要(?:建模|进本体)|纳入|` +
    `${BL}(?:include|keep|add back|bring back|retain)${BR}`,
);
const EXPLAIN = re(
  `为什么|凭什么|依据是|怎么(?:得|判|看)出|从哪(?:看|来)|解释一下|说明一下理由|` +
    `${BL}(?:why|explain|on what basis|how did you|justify|what makes you)${BR}`,
);
// "重出模板"和"重新抽一遍"是两件代价差三个数量级的事，但都以"重"开头 ——
// 正则要都认得，分流交给槽位里的 phrase。
const RERUN = re(
  `重(?:跑|新|出|做|算|编译|生成)|再(?:跑|抽|来|生成)一?(?:遍|次)?|` +
    `重新(?:分析|识别|编译|生成|梳理)|` +
    `${BL}(?:re-?run|re-?do|regenerate|rebuild|recompile|re-?extract|` +
    `run (?:it )?again|try again)${BR}`,
);
/**
 * 开始梳理。判在 {@link RERUN} **之前** —— "重新梳理"两条都命中，但用户说"重新"时
 * 意思是重跑，说"开始"时意思是第一次跑。
 */
const START = re(
  `^${S}*(?:开始|跑一下|梳理一下|处理一下|分析一下|来吧|开工)|` +
    `(?:开始|启动)(?:梳理|抽取|分析|处理)|把(?:材料|文件).{0,4}(?:梳理|处理|分析)|` +
    `^${S}*(?:start|begin|go|let'?s go|kick off|run it)${BR}|` +
    `${BL}(?:start|begin) (?:the )?(?:build|modeling|extraction|analysis)${BR}`,
);

const STATUS = re(
  `(?:现在|目前)?(?:什么|啥)(?:情况|进度|状态)|进度(?:怎么样|如何)|做到哪|跑完了吗|` +
    `${BL}(?:status|progress|how'?s it going|are we done|done yet|where are we)${BR}`,
);
/**
 * 问句。「含税按专票算」是在**约定**口径，「我说的口径是什么」是在**问**它 ——
 * 只看关键词的话两者一模一样，而把提问记成一条新约定，等于用户每问一次就被
 * 悄悄改一次设定。
 */
const QUESTION = re(
  `[?？]${S}*$|^(?:什么|哪|谁|多少|怎么|如何|是否|有没有)|` +
    `(?:是什么|有哪些|是多少|对不对|吗)${S}*[?？]?${S}*$|` +
    `^(?:what|which|who|whose|how|why|when|where|is|are|do|does|can|` +
    `could|should|would)${BR}`,
);

function isQuestion(c: string): boolean {
  return QUESTION.test(pyStrip(c));
}

const CHITCHAT = re(
  `^${S}*(?:你好|hi|hey|hello|在吗|谢谢|thanks?|thank you|辛苦了|好的|嗯+|` +
    `ok|okay|great|cool|got it)${S}*[!！。.~]*${S}*$`,
);

/**
 * 口径词。这些词一出现，这句话几乎一定是在约定口径。
 *
 * 刻意不含"统一指/按/用"这类泛化说法 —— 它同样出现在命名约定里
 * （"头表统一用 Header 后缀"），会把命名判成口径。判据要落在口径**本身的词**上。
 */
const CALIBER = re(
  `含税|不含税|税率|口径|币种|本位币|折算|时间粒度|按(?:年|月|日|季)度?|` +
    `自然(?:年|月)|财(?:年|月)|` +
    `${BL}(?:tax[- ]?(?:in|ex)clusive|with(?:out)? tax|currency|granularity|` +
    `fiscal (?:year|month)|caliber)${BR}`,
);
const NAMING = re(
  `命名|前缀|后缀|驼峰|下划线|apiName|统一叫|统一用.{0,6}(?:命名|名字|后缀|前缀)|` +
    `${BL}(?:naming|prefix|suffix|camel ?case|snake ?case|api ?name)${BR}`,
);

/** `_start` 里那条让位给 `_rerun` 的判据。提到模块级 —— 每次调用重编一次正则纯浪费。 */
const RERUN_WORDS = re("重新|再来|重跑|again|re-?run|re-?do|regenerate");

/** 粘进来的结构化片段 —— DDL、JSON、接口定义。这是补充材料，不是指令。 */
const PASTED = re(
  `CREATE${S}+TABLE|ALTER${S}+TABLE|^${S}*[{\\[]|${BL}varchar${S}*\\(|` +
    `${BL}GET${S}+/|${BL}POST${S}+/`,
  "m",
);

/**
 * 规则优先的意图解析。
 *
 * @param questionIds 当前待答问题的 id，按展示顺序。用户说"第3个问题"要能对上号。
 * @param suggestionIds 当前建议的 id，按展示顺序。
 * @param objectNames 已知对象名，用于把"临时表别要了"里的指代落到具体 rid 上。
 */
export class RuleIntentParser {
  readonly questionIds: string[];
  readonly suggestionIds: string[];
  readonly objectNames: string[];

  constructor(
    o: {
      questionIds?: readonly string[] | null;
      suggestionIds?: readonly string[] | null;
      objectNames?: readonly string[] | null;
    } = {},
  ) {
    // `list(x or [])`：每次都是新数组，调用方之后改自己那份不该影响解析器。
    this.questionIds = [...(o.questionIds ?? [])];
    this.suggestionIds = [...(o.suggestionIds ?? [])];
    this.objectNames = [...(o.objectNames ?? [])];
  }

  // ── 主入口 ──────────────────────────────────────────────────
  parse(text: string): IntentParse {
    const out: IntentMatch[] = [];
    for (const clause of splitClauses(text)) {
      const m = this.one(clause);
      if (m !== null) out.push(m);
    }
    if (out.length === 0) {
      out.push(makeIntentMatch(Intent.UNKNOWN, 0.0, {}, text, "rule:none"));
    }
    return makeIntentParse(text, out);
  }

  private one(c: string): IntentMatch | null {
    // 顺序即优先级。先判**带明确指代**的，再判泛化的语气词 ——
    // "第3条采纳"里既有建议引用又有采纳动词，前者信息量更大。
    // 命名在口径**之前** —— 命名的判据（前缀/后缀/驼峰/apiName）更具体，
    // 而口径词更容易在别的语境里误命中。具体的先判。
    const probes: readonly ((c: string) => IntentMatch | null)[] = [
      (x) => this.chitchat(x),
      (x) => this.suggestion(x),
      (x) => this.question(x),
      (x) => this.scope(x),
      (x) => this.naming(x),
      (x) => this.caliber(x),
      (x) => this.explain(x),
      (x) => this.start(x),
      (x) => this.rerun(x),
      (x) => this.status(x),
      (x) => this.pasted(x),
    ];
    for (const probe of probes) {
      const m = probe(c);
      if (m !== null) return m;
    }
    return null;
  }

  // ── 各条规则 ────────────────────────────────────────────────
  private chitchat(c: string): IntentMatch | null {
    // Python 是 `.match()`（锚在串首）；这条模式本身带 `^` 与 `$`，所以 test 等价。
    if (CHITCHAT.test(c)) {
      return makeIntentMatch(Intent.CHITCHAT, 0.95, {}, c, "rule:chitchat");
    }
    return null;
  }

  private suggestion(c: string): IntentMatch | null {
    const ref = S_REF.exec(c);
    const adopt = ADOPT.test(c);
    const reject = REJECT.test(c);
    if (!(adopt || reject)) return null;
    let sid = "";
    if (ref !== null) {
      const n = firstGroupInt(ref);
      if (n >= 1 && n <= this.suggestionIds.length) sid = this.suggestionIds[n - 1]!;
    }
    // 没点名但只有一条建议时，指代是无歧义的
    if (!sid && this.suggestionIds.length === 1) sid = this.suggestionIds[0]!;
    if (!sid) {
      // 说了"采纳"却对不上具体哪条 —— 这正是该反问的情形，不许猜
      return makeIntentMatch(
        Intent.UNKNOWN,
        0.3,
        { hint: "adopt_which" },
        c,
        "rule:suggestion_ambiguous",
      );
    }
    const kind = reject ? Intent.REJECT_SUGGESTION : Intent.ADOPT_SUGGESTION;
    return makeIntentMatch(kind, 0.92, { suggestion_id: sid }, c, "rule:suggestion");
  }

  private question(c: string): IntentMatch | null {
    const ref = Q_REF.exec(c);
    const opt = OPT.exec(c);
    if (!(ref !== null && (opt !== null || c.includes("：") || c.includes(":")))) return null;
    const n = firstGroupInt(ref);
    if (!(n >= 1 && n <= this.questionIds.length)) return null;
    const slots: Slots = { question_id: this.questionIds[n - 1]! };
    if (opt !== null) {
      // 交替分支保证必有一个组参与，所以这里一定拿得到值（Python 那边拿不到会
      // 直接 StopIteration —— 两边都不该走到）。
      slots["option"] = opt.slice(1).find((g) => g !== undefined && g !== "");
    } else {
      slots["answer"] = pyStrip(afterFirst(afterFirst(c, "："), ":"));
    }
    return makeIntentMatch(Intent.ANSWER_QUESTION, 0.9, slots, c, "rule:question");
  }

  private scope(c: string): IntentMatch | null {
    const ex = EXCLUDE.test(c);
    const inc = INCLUDE.test(c);
    if (!(ex || inc)) return null;
    // 落到具体对象上。落不到就带着原话交给上层做模糊匹配 ——
    // 但**不许**在这里凭空猜一个模式去批量删。
    const named = this.objectNames.filter((n) => n !== "" && c.includes(n));
    const slots: Slots = { action: ex ? "exclude" : "include", named, phrase: c };
    const conf = named.length > 0 ? 0.88 : 0.55;
    return makeIntentMatch(Intent.SET_SCOPE, conf, slots, c, "rule:scope");
  }

  private caliber(c: string): IntentMatch | null {
    if (CALIBER.test(c) && !EXPLAIN.test(c) && !isQuestion(c)) {
      return makeIntentMatch(Intent.SET_CALIBER, 0.85, { statement: c }, c, "rule:caliber");
    }
    return null;
  }

  private naming(c: string): IntentMatch | null {
    if (NAMING.test(c) && !EXPLAIN.test(c) && !isQuestion(c)) {
      return makeIntentMatch(Intent.SET_NAMING, 0.85, { statement: c }, c, "rule:naming");
    }
    return null;
  }

  private explain(c: string): IntentMatch | null {
    if (!EXPLAIN.test(c)) return null;
    const named = this.objectNames.filter((n) => n !== "" && c.includes(n));
    return makeIntentMatch(Intent.EXPLAIN, 0.9, { named, question: c }, c, "rule:explain");
  }

  private start(c: string): IntentMatch | null {
    // "重新/再来" 与 "again/re-run/redo" 都是重跑，不是首次开始 —— 让给 rerun。
    if (START.test(c) && !RERUN_WORDS.test(c)) {
      return makeIntentMatch(Intent.START_BUILD, 0.9, {}, c, "rule:start");
    }
    return null;
  }

  private rerun(c: string): IntentMatch | null {
    if (RERUN.test(c)) {
      return makeIntentMatch(Intent.RERUN, 0.85, { phrase: c }, c, "rule:rerun");
    }
    return null;
  }

  private status(c: string): IntentMatch | null {
    if (STATUS.test(c)) {
      return makeIntentMatch(Intent.ASK_STATUS, 0.9, {}, c, "rule:status");
    }
    return null;
  }

  private pasted(c: string): IntentMatch | null {
    // `len(c) > 200` 数的是 **code point**：100 个 emoji 在 JS 的 .length 下是 200，
    // 正好骑在阈值上，用 .length 会把一句 100 字的表情判成"粘进来的材料"。
    if (PASTED.test(c) || cpLen(c) > 200) {
      return makeIntentMatch(Intent.ADD_CONTEXT, 0.8, { content: c }, cpSlice(c, 80), "rule:pasted");
    }
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  模型层的输出契约
// ══════════════════════════════════════════════════════════════════

/**
 * 规则判不出来时才用。要求模型**只**在封闭集合里选，并给出置信度 ——
 * 没有 "other" 这个逃生舱，判不出就得选 unknown，让上层去反问。
 */
export const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      description: "一句话里的全部意图。判不出就给一条 unknown，不要硬凑。",
      items: {
        type: "object",
        required: ["intent", "confidence", "span", "slots_json"],
        properties: {
          intent: { type: "string", enum: [...INTENTS] },
          confidence: {
            type: "number",
            description: "0~1。不确定就给低分，低分会转成反问，比猜错强",
          },
          span: { type: "string", description: "原句里触发这个判定的片段，原样引用" },
          slots_json: {
            type: "string",
            description:
              "槽位 JSON 对象字符串。" +
              "answer_question 要 question_id/answer；" +
              "adopt_suggestion 要 suggestion_id；" +
              "set_scope 要 action(exclude|include)/named；" +
              "set_caliber/set_naming 要 statement；" +
              "explain 要 named/question。判不出就给 {}",
          },
        },
      },
    },
  },
};
