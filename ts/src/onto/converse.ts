/**
 * 对话推理 —— 用户问一句，系统真的去查、去想、再回答。
 *
 * 在此之前对话层是"规则判意图 → 套模板回复"。那套东西处理得了"采纳第 3 条"
 * 这类**指令**，处理不了"为什么这两个对象有关系"、"这份材料里跟金额有关的口径
 * 一共有几种说法"这类**问题** —— 后者没有固定答案，只能去查。
 *
 * 所以这里是两条路，不是一条：
 *
 *     指令（规则判得出意图）  →  执行器，确定性，零模型调用，可重放
 *     问题（判不出或要查证）  →  推理循环：想 → 调工具 → 看结果 → 再想 → 回答
 *
 * 分流的判据不是"难不难"，是**答案在不在系统里**。"现在什么进度"的答案就在
 * state 里，查一下字典就行，让模型跑一圈只是浪费；"跟金额有关的口径有几种说法"
 * 的答案散在 477 个切片里，只能检索。
 *
 * 推理循环的三条纪律：
 *
 * 1. **工具是只读的。** 对话可以查任何东西，但不能静默改产物 —— 要改必须走
 *    显式的执行器，并且回显改了什么。一个能在闲聊里悄悄删掉 17 个对象的副驾
 *    是不能用的。
 * 2. **答案里的每个出处都必须来自工具返回。** 没查过就说不知道。这条由
 *    {@link checkGrounding} 强制，不是靠提示词祈祷。
 * 3. **推理过程流式可见。** 用户要能看见它在查什么 —— 看不见的推理和编造的
 *    区别，用户是分辨不出来的。
 *
 * 移植说明（TS 侧要留神的三处 Python 语义）：
 *
 * - `json.dumps(..., ensure_ascii=False)` 的**默认分隔符是 `", "` / `": "`**，
 *   不是紧凑形态。工具返回的 `rendered` 会进 transcript 再进提示词，写成
 *   `JSON.stringify` 就是另一份提示词 —— 所以复用 `kernel/journal.ts` 的
 *   `pyJsonDumps`，不自己拼。
 * - `s[:4000]` / `s[:600]` 按**码点**切，CJK 与 emoji 才不会被切成半个。
 * - `round(x, n)` 是 half-**even**，复用 `onto/shape.ts` 的 `pyRound`。
 */

import { pyStr, pyStrip } from "./canonical.js";
import { cpSlice } from "./parse/base.js";
import { pyRound } from "./shape.js";
import { type Finding, Severity, findingToDict, makeFinding } from "../kernel/critic.js";
import { Difficulty } from "../kernel/dag.js";
import { Intent } from "../kernel/intent.js";
import { pyJsonDumps } from "../kernel/journal.js";

type Dict = Record<string, unknown>;

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════
/** `isinstance(x, dict)` —— 数组不是 dict，null 也不是。 */
function isMapping(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `d.get(k)`：非 Mapping 一律 undefined，省得每个调用点都判一遍。 */
function get(d: unknown, k: string): unknown {
  return isMapping(d) ? d[k] : undefined;
}

/** Python 的真值判定（`""` / `0` / `[]` / `{}` / `None` / `False` 都是假）。 */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return !Number.isNaN(v) ? v !== 0 : true;
  if (Array.isArray(v)) return v.length > 0;
  if (isMapping(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * `for x in (v or [])` —— **Python 会去迭代它拿到的任何可迭代对象**。
 *
 * 特意不写成"不是数组就当空数组"：`citations: "abc"` 在 Python 侧会被逐字符
 * 迭代成三条出处，静默换成空数组等于把一类真实的模型脏输出悄悄修好了，
 * 两边行为就此分叉。
 */
function pyIter(v: unknown): unknown[] {
  if (!truthy(v)) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  if (v instanceof Set || v instanceof Map) return [...(v as Iterable<unknown>)];
  if (isMapping(v)) return Object.keys(v);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

/** `float(x or 0.0)`。不可转换时 Python 抛，这里同样抛 —— 静默变 NaN 会混进 confidence。 */
function pyFloatOr0(v: unknown): number {
  if (!truthy(v)) return 0.0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return 1;
  if (typeof v === "string") {
    const n = Number(pyStrip(v));
    if (!Number.isNaN(n)) return n;
  }
  throw new TypeError(`float() argument must be a string or a real number`);
}

/**
 * `type(exc).__name__` / `str(exc)`。
 *
 * `server/dialogue/pyutil.ts` 里有同名的一对 —— 那是 server 层的文件，
 * onto 层往上 import 会把依赖方向倒过来。这两个各三行、没有可分叉的判据，
 * 复制的代价小于把层次搞乱的代价。
 */
function excName(e: unknown): string {
  if (e === null || e === undefined) return "NoneType";
  const ctor = (e as { constructor?: { name?: string } }).constructor;
  if (typeof ctor?.name === "string" && ctor.name !== "") return ctor.name;
  return typeof e;
}

function excText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ══════════════════════════════════════════════════════════════════
//  产出契约
// ══════════════════════════════════════════════════════════════════
/**
 * 推荐问题**跟着回答一起出**，不另起一次调用。以前是回答落地后再调一次模型
 * 去猜"他接下来会问什么"：那次调用要重新读一遍上下文、还得自己思考，实测比
 * 回答本身晚 7~8 秒才回来 —— 用户已经读完答案了，chips 才在眼皮底下换一批。
 * 而写这三条最该问的所需的一切，此刻正在模型手上（刚查过什么、答案里哪块是
 * 虚的），顺手写完既更贴、又不多花一次往返。
 *
 * 两个 schema 共用同一份定义：模型**可以在任何一步直接作答**（{@link STEP_SCHEMA} 的
 * kind=answer），只给最终 schema 加字段的话，最常见的"一步就答上来"反而拿不到
 * 推荐问题，白白退回启发式。
 */
const NEXT_QUESTIONS_DESCRIPTION =
  "FDE 读完这个回答后最该接着问的，最多 3 条，一条一句。" +
  "扣住这轮回答和当前产物：答案里哪块没依据、哪个口径要拍板、" +
  "接下来该跑什么。别问空泛的（「能详细说说吗」）、别重复他刚" +
  "问过的、别问你自己也答不上的。点下去就是原样发出去的一句话，" +
  "所以要写成他会说的话。想不出真正有用的就给空数组 —— " +
  "凑数的提示比没有更糟";

const NEXT_QUESTIONS: Dict = {
  type: "array",
  maxItems: 3,
  items: { type: "string" },
  description: NEXT_QUESTIONS_DESCRIPTION,
};

/**
 * 推理循环的产出契约。
 *
 * `citations` 是**必填数组**而不是可选字段：可选的话模型会在不确定时干脆
 * 不给，而"没有出处的断言"正是这里要防的东西。宁可让它交一个空数组、然后被
 * critic 判不通过，也不要给它一个悄悄绕过的口子。
 */
export const ANSWER_SCHEMA: Dict = {
  type: "object",
  required: ["thought", "answer", "citations", "confidence"],
  properties: {
    thought: {
      type: "string",
      minLength: 8,
      description:
        "你凭什么这么答，一到两句。会原样展示给用户 —— " +
        "看不见的推理和编造的区别，他分辨不出来。不许留空",
    },
    answer: {
      type: "string",
      description:
        "给 FDE 看的回答。直接说结论，不要复述问题。" +
        "**长度配得上问题**：简单的一两句，问「为什么/详细/" +
        "有哪些/怎么做」就展开讲透（分点、给例子、说清例外），" +
        "**不要为了短而省掉他要的信息**。" +
        "查不到就说查不到 —— 编一个听起来合理的答案，" +
        "代价是他拿着它去跟客户对话。",
    },
    citations: {
      type: "array",
      items: { type: "string" },
      description:
        "出处，原样抄工具返回里的 cite 字符串。" + "**只能写你真的查到过的**；一条都没有就给空数组",
    },
    confidence: { type: "number", description: "0~1" },
    followup: {
      type: "string",
      description:
        "如果回答依赖某个你无法确定的前提，把它写成一个问题；" + "没有就留空",
    },
    next_questions: NEXT_QUESTIONS,
  },
};

// ══════════════════════════════════════════════════════════════════
//  分流
// ══════════════════════════════════════════════════════════════════
/** 答案就在系统状态里的意图 —— 查字典即可，跑推理循环纯属浪费。 */
const ANSWERABLE_FROM_STATE: ReadonlySet<string> = new Set<string>([
  Intent.ASK_STATUS,
  Intent.CHITCHAT,
  Intent.SET_CALIBER,
  Intent.SET_NAMING,
  Intent.ADOPT_SUGGESTION,
  Intent.REJECT_SUGGESTION,
  Intent.ADD_CONTEXT,
  // 「开始梳理」「重出模板」是**指令**，不是问题。让推理循环去"查"该不该开始，
  // 它会认真地检索一圈然后回答"我查不到任何内容" —— 荒谬且花钱。
  Intent.START_BUILD,
  Intent.RERUN,
]);

/** 这些词说明用户要的是解释或查证，即使意图判出来了也得去查。 */
const WANTS_EVIDENCE =
  /为什么|凭什么|依据|出处|哪来的|怎么(?:得|判|看)出|有几种|都有哪些|列一下|列出|找一找|查一下|对不对|真的吗/;

/**
 * 一个意图判定结果里，本模块真正读到的那一个字段。
 *
 * Python 侧标注的是 `IntentMatch`，但函数体只读 `.intent` —— 收成结构类型，
 * server 那边的 `IntentMatchLike` 端口就能直接喂进来，不必造一个真 IntentMatch。
 */
export interface IntentMatchLike {
  readonly intent: string;
}

/**
 * 这一句要不要进推理循环。
 *
 * 判据是**答案在不在系统里**，不是难不难。判错的代价不对称：该查的没查，
 * 用户拿到一个想当然的答案；不该查的查了，只是多花几毛钱。所以这里偏向查。
 */
export function needsReasoning(match: IntentMatchLike, text: string): boolean {
  if (match.intent === Intent.EXPLAIN || match.intent === Intent.UNKNOWN) return true;
  if (WANTS_EVIDENCE.test(text || "")) return true;
  return !ANSWERABLE_FROM_STATE.has(match.intent);
}

// ══════════════════════════════════════════════════════════════════
//  溯源校验
// ══════════════════════════════════════════════════════════════════
/**
 * 答案里的出处必须真的在工具返回里出现过。
 *
 * 模型编出处是最难被发现的一类错误 —— 出处长得跟真的一样，FDE 拿着它去翻
 * 材料，翻不到，然后开始怀疑整个系统。所以这里做的是**字符串级的核对**，
 * 不是让另一个模型来判断"看起来合不合理"。
 */
export function checkGrounding(answer: unknown, observed: readonly string[]): Finding[] {
  const out: Finding[] = [];
  if (!isMapping(answer)) {
    return [
      makeFinding({
        severity: Severity.HIGH,
        code: "ANSWER_MALFORMED",
        target: "-",
        claim: "回答不是结构化结果",
        verifier: "rule:grounding",
      }),
    ];
  }
  const cites = pyIter(answer["citations"])
    .map((c) => pyStrip(pyStr(c)))
    .filter((c) => c !== "");
  const blob = observed.join("\n");
  for (const c of cites) {
    if (!blob.includes(c)) {
      out.push(
        makeFinding({
          severity: Severity.HIGH,
          code: "CITATION_FABRICATED",
          target: c,
          claim: `回答里引了「${c}」，但工具返回里没有这个出处`,
          proposedFix: {
            action: "RETRY",
            hint: "只引用工具真的返回过的 cite；查不到就说查不到",
          },
          verifier: "rule:grounding",
        }),
      );
    }
  }

  // 有出处但没结论、或有结论却一条出处都没有，都要拦
  const text = pyStrip(pyStr(truthy(answer["answer"]) ? answer["answer"] : ""));
  if (text === "") {
    out.push(
      makeFinding({
        severity: Severity.HIGH,
        code: "ANSWER_EMPTY",
        target: "-",
        claim: "没有给出回答",
        verifier: "rule:grounding",
      }),
    );
  } else if (cites.length === 0 && observed.length > 0 && pyFloatOr0(answer["confidence"]) >= 0.7) {
    // 查过东西、给了高置信度、却一条出处都不给 —— 这是最典型的"看起来
    // 很确定其实没依据"
    out.push(
      makeFinding({
        severity: Severity.MEDIUM,
        code: "CITATION_MISSING",
        target: "-",
        claim: "查了材料、给了高置信度，却没有引用任何出处",
        proposedFix: { action: "RETRY", hint: "把支撑结论的那几片的 cite 带上" },
        verifier: "rule:grounding",
      }),
    );
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  推理循环
// ══════════════════════════════════════════════════════════════════
/**
 * 一次对话推理的完整记录。
 *
 * 是 class 而不是纯数据 interface：它有 `grounded` 派生属性和 `toDict()`，
 * 而且 `ConversationAgent.run` 全程原地改它（流式上屏时外面拿的是同一个对象）。
 */
export class ConverseTurn {
  text: string;
  answer = "";
  citations: string[] = [];
  confidence = 0.0;
  followup = "";
  /** 他接下来最该问的几条。回答自带，不另起一次调用（见 {@link ANSWER_SCHEMA}）。 */
  nextQuestions: string[] = [];
  /** 想了几步、调了哪些工具。用于流式展示与事后审计。 */
  steps: Dict[] = [];
  findings: Finding[] = [];
  usd = 0.0;
  /** 这一轮选了哪种推理方式，以及（plan_execute 时）列出的计划。
   *  要能在推理面板里看见 —— "它凭什么这么想"和"它想了什么"一样重要。 */
  strategy = "react";
  plan: Dict[] = [];

  constructor(text: string) {
    this.text = text;
  }

  get grounded(): boolean {
    return !this.findings.some((f) => f.severity === Severity.HIGH);
  }

  toDict(): Dict {
    return {
      text: this.text,
      answer: this.answer,
      citations: this.citations,
      confidence: pyRound(this.confidence, 2),
      followup: this.followup,
      next_questions: this.nextQuestions,
      steps: this.steps,
      grounded: this.grounded,
      strategy: this.strategy,
      plan: this.plan,
      findings: this.findings.map(findingToDict),
      usd: pyRound(this.usd, 4),
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  推理方式的选择
// ══════════════════════════════════════════════════════════════════
/**
 * 三种推理方式。和 `kernel/dag.ts` 的 `NodeMode` 同名同义 —— 抽取节点用的是
 * 那一套，对话侧以前只有一条固定循环，不管问什么都按"边想边查"跑五步。
 *
 * 判据是**路径可不可枚举**，不是难不难：
 *   - 不需要查任何东西（寒暄、常识、就事论事的解释）→ 一次出答，别空转五步；
 *   - 要查、但查什么取决于上一步看到什么 → ReAct；
 *   - 目标明确、步骤当场就能列全（"把 X 连到 Y，然后重出模板"）→ 先列计划再执行，
 *     让 FDE 在动手前看见要做哪几件事。
 */
export const STRATEGY_LABEL: Readonly<Record<string, string>> = {
  single_shot: "直接回答",
  react: "边查边想",
  plan_execute: "先列计划再执行",
};

/** 推理面板里的这几行也要跟界面语言走 —— 界面切成英文、推理栏还在冒中文，
 *  是最扎眼的那种半吊子本地化。 */
export const STRATEGY_LABEL_EN: Readonly<Record<string, string>> = {
  single_shot: "answer directly",
  react: "search as I reason",
  plan_execute: "plan first, then execute",
};

export function strategyLabel(strategy: string, lang = "zh"): string {
  const table = lang === "en" ? STRATEGY_LABEL_EN : STRATEGY_LABEL;
  // `dict.get(k, k)` —— 认不出来的策略名原样回显，别悄悄换成别的。
  return Object.prototype.hasOwnProperty.call(table, strategy)
    ? (table[strategy] as string)
    : strategy;
}

/** 一句话里连着好几件事的信号词。 */
const MULTI = /然后|接着|再(?:把|给|帮|重|出|加|改)|并且|同时|一起|依次|分别|最后|之后|顺便/;
/** 改产物的动作词。计划模式是给"做事"准备的，不是给"问问题"准备的。 */
const DO_VERB = /改|加|删|连|补|标|设|生成|重出|导出|撤销|采纳|排除|移到|重命名/g;

/**
 * 选这一轮用哪种推理方式。**便宜、可解释** —— 纯规则，零模型调用。
 *
 * 选错的代价不对称：该查的没查会给出想当然的答案；不该列计划却列了，只是多
 * 一次调用。所以只在**明显**是多步动作时才上 plan_execute。
 */
export function pickStrategy(text: string, opts: { hasTools: boolean }): string {
  if (!opts.hasTools) return "single_shot";
  const t = text ?? "";
  // `re.findall` 每次从头数；带 /g 的正则有 lastIndex 状态，必须用 matchAll 而不是
  // 反复 exec —— 复用一个 /g 正则的 exec 会从上次位置接着找，计数就少了。
  const verbs = [...t.matchAll(DO_VERB)].length;
  if (MULTI.test(t) && verbs >= 2) return "plan_execute";
  return "react";
}

export const PLAN_SCHEMA: Dict = {
  type: "object",
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      maxItems: 6,
      description: "要做的几件事，按顺序。只列**这一轮真要做**的，别写待办清单",
      items: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string", description: "这一步要达成什么，一句话" },
          tool: { type: "string", description: "打算用哪个工具，不确定就留空" },
        },
      },
    },
  },
};

export const SYSTEM = `你是 OntoCopilot 的对话侧，面对的是一位 FDE 工程师。

他的工作是把客户的业务材料变成一份能落地的 Ontology。你有两种处境：

**手上有材料时** —— 你已经把它们解析、抽取成了一份中间表示，他问的多半是
材料里的事。先查再答。

**手上还没有材料时** —— 他可能在问建模本身的事（怎么划分对象、口径该怎么定、
这类项目一般怎么推进），也可能在跟你商量接下来做什么。**照常回答**，用你自己
的知识，但要说清这是通用经验而不是从他的材料里看来的。不要因为没有材料就
催他上传 —— 他自己知道什么时候该传。

工作方式：
- **绝不报告你没有亲手启动的进度。** 「正在解析」「系统正在后台处理」这类话，只有在
  你**这一轮真的调用了** build.start 之后才能说。没调就说"在跑"，是彻头彻尾的假话 ——
  他会一直等一个永远不会来的结果。不确定当前状态就调 session.status 看，别猜。
- **分清「看一下」和「梳理」—— 这两件事代价差一个数量级。**
  - 他说「分析一下这张图」「这图讲了什么」「这份材料里有什么」→ 他要的是**看懂**。
    用 \`material.parse\`（图片带 \`ocr=true\`）把内容读进来，再 \`evidence.search\`
    查着回答。**不要**调 build.start。
  - 只有他明确要**产出**东西时（「开始梳理」「抽本体」「生成流程图/模板」），
    才调 build.start —— 那会跑完整管线、花不少钱。
  拿不准就按前者做，然后问他要不要正式梳理。看错方向的代价是不对称的：多读一次
  图只是几毛钱，误启动一整轮梳理是几分钟和几美元。
- **材料要不要读、读哪几份，你来判断。** 上传只是把文件登记下来，**没有读内容**。
  \`material.list\` 看清单和每份读进来多少段；还没读的用 \`material.parse\` 读（表格/
  文档零成本）。他问材料里的事而清单显示"还没读入"时，**先读再答** —— 没读就检索
  只会查到空，然后你会误以为材料里没有。图片/扫描件要视觉模型，那个在「开始梳理」
  时做，不在这里。
- **要"列出来"就调工具列，别自己打。** 他说「列出来」「全部列一遍」「有哪些」时，
  先分清东西在哪：
  - 在**梳理产出**里（对象/属性/关系/动作/规则/待澄清问题）→ \`ui.table\`。
  - 在**他自己上传的表格**里（他整理好的问题清单、字段表、规则表）→ \`material.rows\`。
    **这种不需要先梳理**，那张表本来就在文件里，直接读直接列。
  这两个是系统直接出数，**150 行就是 150 行，一条不少**。你自己在回答里逐条打的后果
  是：一定会截断，然后只能说"其余 146 条未能呈现"，而那正是他要的东西。调完只说一句
  「已列出 N 条，见下表」，**不要复述**。
  - **第三种：东西是你现场分析出来的**（访谈提纲、卡点清单、按阶段拆的提问框架 ——
    这些材料里没有、产物里也没有，是你刚想出来的）。这时**两个工具都用不上**，
    但他要的仍然是**一张表**：就在回答正文里写 markdown 竖线表。
    **绝不要因为工具报错就退回成分点罗列** —— 他说的是「列出来表格」，给他嵌套
    小圆点等于没照做。表格前面加一行加粗标题（\`**AI 招聘业务流程梳理及访谈提问框架**\`），
    他后面会用这个名字来指它、来让你导出。
- **他要"下载/导出/转成 excel"就调 \`export.file\`。** 「把这个表转成 excel 给我」
  「导出成 word」「存成 pdf 我发给客户」—— 调完他那边直接出下载按钮。**不要把内容
  再贴一遍当作"给他"**，也不要说"你可以自己复制到 Excel 里"，那正是他不想做的事。
  导完只说一句「已导出「文件名」，点下面就能下载」。
- **\`evidence.search\` 的结果永远不是全集。** 它按相关度返回前几条，用来回答"这事在哪写
  着"。拿它凑清单必然只有零星几条 —— 那时**不要**跟用户说"系统读取异常/读取限制、
  只能给你这几条"，那是把工具选错说成了系统坏了。要全集就换 \`material.rows\` /
  \`ui.table\`。
- **先查再答。** 你有检索材料和查询 OIR 的工具，用它们。凭印象回答在这里没有价值，
  他自己也能凭印象猜。
- **每个结论都带出处 —— 如果它来自材料。** 出处原样抄工具返回里的 cite 字符串，
  一个字都不要改。来自通用经验的结论不要编出处，直接说这是经验判断。
- **查不到就说查不到。** 他会拿你的回答去跟客户对话；一个听起来合理但是编的答案，
  代价是他在客户面前说错话。
- **长度要配得上问题，不是一律求短。**
  - 「现在什么进度」「这个字段是什么类型」这类，一两句话说完就停，别灌水。
  - 但他问「为什么」「详细说说」「有哪些」「怎么做」「对比一下」，或者问题本身牵涉
    多个对象/多条规则/多个步骤时，**就要展开讲透**：分点、给例子、说清前提和例外。
    这时候答得短不是简练，是**没答**。
  - **绝不为了简短而省略他明确要的信息。** 条目多就用 \`ui.table\` 列全（那张表由
    系统出，不占你的篇幅），别写"其余若干项不再赘述"—— 那几项往往正是他要的。
  - 判断不了长短时**偏详细**：他嫌长最多略过几行，而漏掉的那条关键约束，他要在
    客户面前才发现。
- **thought 一定要写实**。它会原样显示在界面的推理面板里，他靠它判断你有没有在
  一本正经地胡说。填空串等于什么都没想。

**回答风格 —— 只给结论和结果，不露技术实现：**
- **绝不提工具名、内部机制、方法论。** 不要说"我调 flow.preview / build.start / oir.add"、
  不要讲"抽取管线 / 五段式 / 冻结 DAG"这类内部说法。你要做某件事就**直接做**，然后用
  业务语言说**做成了什么效果**：说"我把流程图生成好了""我把这个字段补进去了"，而不是
  "我调用了某某工具"。
- 用户问"你怎么做到的""用了什么模型/框架"时，简单答"这是我内置的能力"即可，不展开
  技术细节。给的是结果和结论，不是实现说明书。

改产物的工具你也有 —— 但它们动的是他辛苦得来的产物，纪律要严：
- **口述的事实要落进产物。** 他说出材料没写、但他知道的事实时，别只回「知道了」——
  按性质分派：讲的是**本体元素**（对象/属性/关系/规则/某字段的取值或口径）就用
  oir.add / oir.edit；讲的是**流程**（多一步、连一条边、加个网关、谁来做、归哪个阶段）
  就用 flow.edit；两者都涉及（如「采购包创建后状态变成已发布」既是状态取值/流程规则、
  又是流程上一个事件）就**两个都调**。
- **口述永远不是材料证据。** 它在产物里标「人工口述」(Origin=USER)，可信度高，但绝不能
  说成是从材料里读到的。改完精确复述你改了什么，不要为口述的事实编出处。
- **这些改产物的工具会先要用户确认。** 被挡下时把你打算改什么讲清楚，等他点头再来一次。
  只读的检索/查询不受此限。`;

/**
 * 「聊天」模式的系统提示：一个**通用**助手，不是 FDE 专用副驾。可以分析上传的材料，
 * 但**只分析不生产** —— 不抽本体、不出流程图、不生成模板。要产出这些就切「工作」。
 */
export const CHAT_SYSTEM = `你是 OntoCopilot 的聊天助手 —— 一个通用的 AI 助手。

聊天是**通用对话**：回答问题、帮着分析、写东西、聊聊都行，用你自己的知识。
用户若上传了文件，你可以读它、就它对话和分析 —— 但**上传只是登记，没有读内容**：
先用 \`material.list\` 看清单，显示"还没读入"的用 \`material.parse\` 读进来，再检索。

但聊天**只分析、不生产**：不抽本体、不出流程图、不生成填写模板 —— 这些是「工作」
模式的事。用户要正式梳理业务材料、产出这些东西时，告诉他切到上方「工作」模式（那边
是支持 FDE 工程师的完整工作流），或点「转成工作会话」把文件带过去接着做。

几条：
- 直接回答，不确定就说不确定、别编。**长度配得上问题**：简单的问题一两句说完；
  问「为什么/详细讲讲/有哪些/怎么做」就展开讲透，分点、给例子。答得短不等于答得好，
  **别为了简短省掉他要的东西**。
- 用检索读到的内容如实引用，别编出处。
- 别催用户上传，也别硬把话题往梳理上带 —— 他要梳理时自己会说。
- **只给结论和结果，不露技术实现**：不要提工具名、内部机制或方法论；问到"怎么做到的"
  就答"这是我内置的能力"，不展开技术细节。
`;

// ══════════════════════════════════════════════════════════════════
//  端口（网关 / 工具注册表 —— 只声明本模块真读到的那几个成员）
// ══════════════════════════════════════════════════════════════════
export interface ConverseCompletion {
  readonly data?: unknown;
  readonly usd?: unknown;
}

export interface ConverseGateway {
  call(
    nodeId: string,
    prompt: string,
    opts: {
      system?: string;
      difficulty?: Difficulty;
      model?: unknown;
      schema?: Dict;
      key?: string;
    },
  ): Promise<ConverseCompletion>;
}

/** `ToolRegistry.for_scope()` 返回的每一项：只用到 `spec.render()`。 */
export interface ConverseToolLike {
  readonly spec: { render(): string };
}

export interface ConverseToolsLike {
  forScope(scope: string): readonly ConverseToolLike[];
  call(
    name: string,
    args: Dict,
    ctx: unknown,
    opts: { scope?: string },
  ): Promise<unknown>;
}

/**
 * `ctx.turn_id` 是本模块唯一读到的成员（拼节点 id 用）。
 *
 * 两个拼写都收：Python 侧字段名是 `turn_id`，而 server track 的 `ChatCtx`
 * 已经落成 `turnId`。只认一个的后果是节点 id 变成 `CHAT.`，effect 记账全部
 * 撞在同一个键上 —— 那种坏法不报错，只是重放时读回别人的结果。
 */
export interface ConverseCtxLike {
  readonly turnId?: unknown;
  readonly turn_id?: unknown;
}

export type OnStep = (rec: Dict) => void;

export interface ConversationAgentOptions {
  gateway: ConverseGateway;
  tools: ConverseToolsLike;
  scope?: string;
  maxSteps?: number;
  system?: string | null;
  model?: unknown;
  lang?: string;
  strategy?: string | null;
}

export interface ConverseRunOptions {
  ctx: ConverseCtxLike;
  context?: string;
  onStep?: OnStep | null;
}

/**
 * 对话侧的推理循环。
 *
 * 刻意不复用 `kernel/loop.ts` 的 `AgentLoop`：那个循环是给 DAG 节点用的，
 * 带着 critic 环、预算档位、降级广播、节点重试 —— 对话要的是**低延迟、可中断、
 * 过程可见**，两者的取舍方向相反。共用的是工具注册表、证据索引和溯源纪律。
 */
export class ConversationAgent {
  readonly gw: ConverseGateway;
  readonly tools: ConverseToolsLike;
  readonly scope: string;
  /** 最多想几步。对话不该转很久 —— 转不出来就如实说，比让人干等三十秒更好。 */
  readonly maxSteps: number;
  /** 固定推理方式；`null` = 每轮按请求自动选（见 {@link pickStrategy}）。
   *  测试和特殊场景可以钉死，正常运行让它自己选。 */
  readonly strategy: string | null;
  /** 界面语言。推理面板里那几行由我们自己拼，得跟着它走 —— 界面切成英文、
   *  推理栏还在冒中文，是最扎眼的那种半吊子本地化。 */
  readonly lang: string;
  /** 系统提示可覆盖 —— 聊天模式换成通用助手 {@link CHAT_SYSTEM}，工作模式用 FDE 版。 */
  system: string;
  /** 指定模型（ModelSpec）则对话直接用它，跳过按难度的路由 —— 工作模式的模型选择器。 */
  readonly model: unknown;

  constructor(opts: ConversationAgentOptions) {
    this.gw = opts.gateway;
    this.tools = opts.tools;
    this.scope = opts.scope ?? "readonly";
    this.maxSteps = opts.maxSteps ?? 5;
    this.strategy = opts.strategy ?? null;
    this.lang = opts.lang ?? "zh";
    this.system = truthy(opts.system) ? (opts.system as string) : SYSTEM;
    if (this.lang === "en") {
      // 只加一行输出语言指令：领域内容仍是中文材料，模型照读不误，只把**它自己
      // 的话**换成英文。实体名/口径等抽取出来的术语保持原文，别硬翻。
      this.system +=
        "\n\n[Output language] Reply to the user in English. " +
        "Keep extracted domain terms (entity names, calibers, " +
        "field names) in their original language.";
    }
    this.model = opts.model ?? null;
  }

  /**
   * 跑一轮对话推理。
   *
   * `context` 是会话状态摘要（当前产物统计、已拍板的决定、待答问题）。
   * 它进系统层而不是用户层 —— 用户说的话和系统给的事实混在一起，
   * 材料里写的"请忽略之前的指令"就有机会冒充系统事实。
   *
   * `onStep` 每产生一步就回调一次，用于流式上屏。
   */
  async run(text: string, opts: ConverseRunOptions): Promise<ConverseTurn> {
    const { ctx } = opts;
    const context = opts.context ?? "";
    const onStep = opts.onStep ?? null;
    const turnId = pyStr(ctx.turnId ?? ctx.turn_id ?? "");

    const turn = new ConverseTurn(text);
    const observed: string[] = [];
    const transcript: string[] = [];
    const specs = this.tools.forScope(this.scope);

    // ── 选推理方式，并让它在推理面板里看得见 ──────────────────────
    turn.strategy = truthy(this.strategy)
      ? (this.strategy as string)
      : pickStrategy(text, { hasTools: specs.length > 0 });
    if (onStep) {
      const lbl = strategyLabel(turn.strategy, this.lang);
      onStep({
        n: 0,
        thought: this.lang === "en" ? `This turn: ${lbl}.` : `这一轮按「${lbl}」来。`,
        tool: "",
        args: {},
      });
    }

    if (turn.strategy === "single_shot") {
      // 不需要查东西就别空转五步：一次调用直接出答案。
      let comp: ConverseCompletion;
      try {
        comp = await this.gw.call(
          `CHAT.${turnId}`,
          this.prompt(text, context, transcript, specs, true),
          {
            system: this.system,
            difficulty: Difficulty.MEDIUM,
            model: this.model,
            schema: ANSWER_SCHEMA,
            key: "single",
          },
        );
      } catch (exc) {
        turn.answer = `这轮没跑通：${excName(exc)}: ${excText(exc)}`;
        turn.findings.push(
          makeFinding({
            severity: Severity.HIGH,
            code: "GATEWAY_ERROR",
            target: "-",
            claim: excText(exc),
            verifier: "rule:gateway",
          }),
        );
        return turn;
      }
      turn.usd += pyFloatOr0(comp.usd);
      return this.finish(turn, isMapping(comp.data) ? comp.data : {}, observed, onStep);
    }

    if (turn.strategy === "plan_execute") {
      // 先把这一轮要做的几件事列出来 —— FDE 在动手前就该看见清单，而不是
      // 等做完了才知道动了什么。列不出来就退回边查边想，不要卡住。
      try {
        const pc = await this.gw.call(`CHAT.${turnId}`, this.planPrompt(text, context, specs), {
          system: this.system,
          difficulty: Difficulty.MEDIUM,
          model: this.model,
          schema: PLAN_SCHEMA,
          key: "plan",
        });
        turn.usd += pyFloatOr0(pc.usd);
        turn.plan = pyIter(get(pc.data, "steps"))
          .filter((x) => truthy(get(x, "goal")))
          .map((x) => x as Dict);
      } catch {
        // 列不出计划不该让这轮失败
        turn.plan = [];
      }
      if (turn.plan.length > 0) {
        const lines = turn.plan.map((x, i) => `${i + 1}. ${pyStr(x["goal"])}`).join("；");
        transcript.push(`【本轮计划】${lines}`);
        if (onStep) {
          onStep({
            n: 0,
            tool: "",
            args: {},
            thought: this.lang === "en" ? `Plan: ${lines}` : `计划：${lines}`,
          });
        }
      } else {
        turn.strategy = "react";
      }
    }

    for (let step = 0; step < this.maxSteps; step += 1) {
      const last = step === this.maxSteps - 1;
      const prompt = this.prompt(text, context, transcript, specs, last);
      let comp: ConverseCompletion;
      try {
        comp = await this.gw.call(`CHAT.${turnId}`, prompt, {
          system: this.system,
          difficulty: Difficulty.MEDIUM,
          model: this.model,
          schema: last ? ANSWER_SCHEMA : STEP_SCHEMA,
          // key 必须给：同一个"节点"里会连着调好几次，不给 key 的话
          // effect 记账会按 (node_id, idx) 撞在一起。
          key: `step${step}`,
        });
      } catch (exc) {
        // 对话失败要如实说，不能静默
        turn.answer = `这轮没跑通：${excName(exc)}: ${excText(exc)}`;
        turn.findings.push(
          makeFinding({
            severity: Severity.HIGH,
            code: "GATEWAY_ERROR",
            target: "-",
            claim: excText(exc),
            verifier: "rule:gateway",
          }),
        );
        return turn;
      }
      turn.usd += pyFloatOr0(comp.usd);
      const data: Dict = isMapping(comp.data) ? comp.data : {};

      if (last || data["kind"] === "answer") {
        return this.finish(turn, data, observed, onStep);
      }

      const tool = pyStrip(pyStr(truthy(data["tool"]) ? data["tool"] : ""));
      const thought = pyStr(truthy(data["thought"]) ? data["thought"] : "");
      const args = parseArgs(data["args_json"]);
      const rec: Dict = { n: step + 1, thought, tool, args };
      if (onStep) onStep({ ...rec });

      if (tool === "") return this.finish(turn, data, observed, onStep);
      let obs: unknown;
      try {
        obs = await this.tools.call(tool, args, ctx, { scope: this.scope });
      } catch (exc) {
        // 工具失败回给模型，不是中断
        obs = { error: `${excName(exc)}: ${excText(exc)}` };
      }
      const rendered = cpSlice(pyJsonDumps(obs, { defaultStr: true }), 0, 4000);
      observed.push(rendered);
      rec["observation"] = cpSlice(rendered, 0, 600);
      turn.steps.push(rec);
      if (onStep) onStep({ ...rec });
      transcript.push(
        `你想：${thought}\n你调了 ${tool}(${pyJsonDumps(args)})\n` + `返回：${rendered}`,
      );
    }

    return turn;
  }

  // ── 内部 ────────────────────────────────────────────────────
  private finish(
    turn: ConverseTurn,
    data: Dict,
    observed: readonly string[],
    onStep: OnStep | null,
  ): ConverseTurn {
    // 收尾这一步同样要发出去。只在调工具时才发的话，"一步就答上来"的问题
    // （寒暄、凭经验回答）在轨迹里什么都看不到 —— 而那恰恰是最该让人核对
    // "它到底想了什么"的时候。
    const thought = pyStrip(pyStr(truthy(data["thought"]) ? data["thought"] : ""));
    const final: Dict = {
      n: turn.steps.length + 1,
      // 模型仍可能填空 —— 与其显示一个空行，不如如实说它没交代
      thought: thought !== "" ? thought : "（模型没有给出思考过程）",
      tool: "",
      args: {},
      kind: "answer",
    };
    turn.steps.push(final);
    if (onStep) onStep({ ...final });
    turn.answer = pyStrip(pyStr(truthy(data["answer"]) ? data["answer"] : ""));
    turn.citations = pyIter(data["citations"]).map((c) => pyStr(c));
    turn.confidence = pyFloatOr0(data["confidence"]);
    turn.followup = pyStrip(pyStr(truthy(data["followup"]) ? data["followup"] : ""));
    // 去空、去重、截到 3：模型偶尔会把同一个问题换个说法写两遍，
    // 而三条一样的提示等于一条，白占那三个位置。
    const seen = new Set<string>();
    for (const raw of pyIter(data["next_questions"])) {
      const q = pyStrip(pyStr(raw));
      if (q !== "" && !seen.has(q)) {
        seen.add(q);
        turn.nextQuestions.push(q);
      }
      // Python 的 break 在**循环体末尾**：空串/重复项那一轮也会走到这里，
      // 所以已经攒够 3 条时下一轮根本不会开始。位置挪了行为就变了。
      if (turn.nextQuestions.length >= 3) break;
    }
    turn.findings = checkGrounding(data, observed);
    if (!turn.grounded) {
      // 编出处是最难被发现的错误。发现了就**当场删掉**那几条，而不是
      // 附一句"以下出处可能有误" —— 后者等于把核对的活推给用户。
      const blob = observed.join("\n");
      turn.citations = turn.citations.filter((c) => blob.includes(c));
      turn.answer += "\n\n（有出处没核对上，已移除；结论请自行复核）";
    }
    return turn;
  }

  /** Python 侧是 `_prompt`（单下划线只是约定，外部照样调得到）。 */
  prompt(
    text: string,
    context: string,
    transcript: readonly string[],
    specs: readonly ConverseToolLike[],
    final: boolean,
  ): string {
    const head: string[] = [
      context !== "" ? `## 当前会话状态\n${context}\n` : "",
      `## FDE 问的是\n${text}\n`,
    ];
    if (transcript.length > 0) {
      head.push("## 你已经查过的\n" + transcript.slice(-4).join("\n\n") + "\n");
    }
    if (final) {
      head.push(
        "现在给出回答。**出处只能写你上面真的查到过的**，" +
          "一条都没查到就给空数组、并在回答里说明你没查到。",
      );
    } else {
      const tools = specs.map((t) => t.spec.render()).join("\n");
      head.push(
        `## 可用工具\n${tools}\n\n` + "查够了就把 kind 设成 answer 直接回答；还需要查就设成 tool。",
      );
    }
    return head.filter((x) => x !== "").join("\n");
  }

  /** 列计划用的提示。**只列这一轮真要做的几件事**，不是写待办清单。 */
  planPrompt(text: string, context: string, specs: readonly ConverseToolLike[]): string {
    const tools = specs.map((t) => t.spec.render()).join("\n");
    return [
      context !== "" ? `## 当前会话状态\n${context}\n` : "",
      `## FDE 要做的\n${text}\n`,
      `## 可用工具\n${tools}\n`,
      "他这一句里包含好几件事。**先把要做的按顺序列出来**（最多 6 步），" +
        "每步一句话说清要达成什么、打算用哪个工具。只列这一轮真要做的；" +
        "他没要求的别自作主张加。列完就会按这个顺序执行。",
    ]
      .filter((x) => x !== "")
      .join("\n");
  }
}

/**
 * 中间步骤的契约。和最终回答共用一个 schema 会让模型在没查够的时候就急着
 * 填 answer —— 分开两个 schema，"还要不要查"就变成一个显式选择。
 */
export const STEP_SCHEMA: Dict = {
  type: "object",
  // **thought 必须排在最前面。** 结构化输出是逐字段生成的，把它放在 answer
  // 后面等于让模型先写完答案再补一句"我是这么想的" —— 那不是推理，是事后编排。
  // 实测：放在第二位时模型直接填空串（required 只保证字段存在，不保证非空）。
  required: ["thought", "kind", "tool", "args_json"],
  properties: {
    thought: {
      type: "string",
      minLength: 8,
      description:
        "你此刻在想什么，一到两句。要查东西就说清查什么、为什么；" +
        "要直接回答就说清你凭什么这么答。" +
        "**这段会原样展示给用户**，是他核对你有没有乱说的唯一依据，" +
        "不许留空、不许写「思考中」这种废话",
    },
    kind: { type: "string", enum: ["tool", "answer"] },
    tool: { type: "string", description: "kind=answer 时填空串" },
    args_json: {
      type: "string",
      description: "工具参数的 JSON 对象字符串；kind=answer 时填 {}",
    },
    answer: { type: "string", description: "kind=answer 时填这里" },
    citations: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    // 还在查的那几步给空数组就行 —— 这一步没有回答，也就没有"接着问什么"。
    next_questions: {
      ...NEXT_QUESTIONS,
      description:
        "kind=answer 时填；kind=tool 时给空数组。" + NEXT_QUESTIONS_DESCRIPTION,
    },
  },
};

export function parseArgs(raw: unknown): Dict {
  if (isMapping(raw)) return raw;
  if (typeof raw !== "string" || pyStrip(raw) === "") return {};
  try {
    const out: unknown = JSON.parse(raw);
    return isMapping(out) ? out : {};
  } catch {
    // Python 只接 JSONDecodeError；JS 的 JSON.parse 只会抛 SyntaxError，等价。
    return {};
  }
}
