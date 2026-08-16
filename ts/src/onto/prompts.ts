/**
 * 开场与追问 —— 让人知道这里能问什么。
 *
 * 一个空白输入框对新用户是最不友好的界面：他知道这工具"能分析业务文档"，但不知道
 * 该说什么才有用。而每次回答之后同样有个断层 —— 系统刚说完"有 3 个死路"，
 * 他得自己想出"哪三个"这个问题。
 *
 * 两端是同一件事：**把系统当前知道的东西，翻译成他能点的下一步。**
 *
 * 设计上有两条纪律：
 *
 * **建议必须从状态里长出来，不是写死的清单。** 没上传材料时问"这份材料里有多少个
 * 对象"是荒谬的；跑完之后还提示"上传材料"同样荒谬。所以每条建议都带一个
 * `when` 判据，状态不满足就不出。
 *
 * **只出他答得上、且答了有用的。** 一个提示如果点下去得到的是"我查不到"，
 * 它的净价值是负的 —— 用户会开始怀疑其余的提示。
 *
 * **而且一条都不能少。** 这两个函数是整个产品"接下来能干什么"的兜底，
 * 它们返回空列表，用户看到的就是一个没有任何出口的空白 —— 恰恰在最需要指路的
 * 时候（回答没跑通、梳理失败、材料传完还没开跑）。所以下面每条路径末尾都有
 * {@link always}：状态再刁钻，也要给得出三条他现在真能问的。
 *
 * 文案是产品面孔，`golden/prompts.json` 按**整条 dict** 钉住，一个字都不许漂。
 */

/** 会话状态里这个模块会读的那几处。Python 侧是 `dict[str, Any]`，这里照抄成
 * 松散字典而不是绑到别的模块的类型 —— prompts 只读几个数字，没必要跟着
 * OIR/Flow 的结构一起演化。等 session 状态那边的类型落地后再考虑收敛。 */
export type PromptState = Readonly<Record<string, unknown>>;

/** 前端拿到的形状：`send` 永远非空（缺省等于 `text`）。 */
export interface PromptDict {
  readonly text: string;
  readonly send: string;
  readonly group: string;
}

/** 一条可以直接点的提示。 */
export class Prompt {
  /** 点下去实际发送的话。默认就是 text —— 只有在显示文案和实际问法需要
   * 不同时才分开（"看看流程图" → "把流程图里的死路列出来"）。 */
  readonly send: string;

  constructor(
    readonly text: string,
    /** 分组，前端可以按它排版。 */
    readonly group: string = "",
    send = "",
  ) {
    // Python 的 __post_init__：空串才回落到 text（不是 `?? text`，
    // 因为传进来的空串必须被当成"没给"）。
    this.send = send || text;
  }

  toDict(): PromptDict {
    return { text: this.text, send: this.send, group: this.group };
  }
}

interface Rule {
  when: (f: Facts) => boolean;
  make: (f: Facts) => Prompt[];
}

interface Facts {
  readonly files: string[];
  readonly nFiles: number;
  readonly status: string;
  readonly objects: number;
  readonly properties: number;
  readonly links: number;
  readonly rules: number;
  readonly questions: number;
  readonly flowActions: number;
  readonly flowEvents: number;
  readonly deadEnds: number;
  readonly inferredEdges: number;
  readonly suggestions: string[];
  readonly pending: number;
  readonly artifacts: unknown[];
  readonly decisions: number;
}

/** Python 的 `(state.get("x") or {})`：缺失、None、空字典都退化成空字典。 */
function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `stats.get(k, 0)`。统计口径两侧都是整数，非数字一律当 0 —— Python 会把
 * 脏值原样带进文案（`f"{...}"`），那是更糟的失败，不值得照抄。 */
function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  return typeof v === "number" ? v : 0;
}

/** 把会话状态压成建议规则要看的几个数。 */
function facts(state: PromptState, files: string[], status: string): Facts {
  const oir = rec(rec(state["oir"])["stats"]);
  const flow = rec(rec(state["flow"])["stats"]);
  return {
    files,
    nFiles: files.length,
    status,
    objects: num(oir, "objects"),
    properties: num(oir, "properties"),
    links: num(oir, "links"),
    rules: num(oir, "rules"),
    questions: num(oir, "open_questions"),
    flowActions: num(flow, "actions"),
    flowEvents: num(flow, "events"),
    deadEnds: num(flow, "dead_ends"),
    inferredEdges: num(flow, "inferred_edges"),
    suggestions: arr(state["suggestions"]).map((x) => {
      const t = rec(x)["title"];
      return typeof t === "string" ? t : "";
    }),
    pending: arr(state["questions"]).length,
    artifacts: arr(state["artifacts"]),
    decisions: arr(state["decisions"]).length,
  };
}

/** Python 的 `\s` 与 JS 的 `\s` **不是同一个集合** —— 前者认 U+001C..U+001F
 * 和 U+0085(NEL)、不认 U+FEFF；后者反过来。归一化用的字符集要是两边不一样，
 * 同一句话在两侧会算出不同的 key，"他刚问过的"就会被原样推回去。
 * 所以这里显式写死 Python `str` 的空白集，不写 `\s`。 */
// eslint-disable-next-line no-control-regex
const KEY_STRIP = new RegExp(
  "[" +
    // Python str 的空白集：比 JS 的 \\s 多了 U+001C..U+001F 和 U+0085(NEL)，
    // 少了 U+FEFF。写死才不会两侧算出不同的 key。
    "\\u0009\\u000a\\u000b\\u000c\\u000d\\u001c-\\u001f\\u0020\\u0085\\u00a0" +
    "\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000" +
    // 常见标点（全角与半角），与 Python 侧逐字符对齐
    "，。？?！!、,.：:；;（）()「」\"'" +
    "]",
  "g",
);

/**
 * 比对"是不是同一句"用的归一化：去空白与常见标点。
 *
 * 他打的是"这类项目一般怎么推进"，提示写的是"这类项目一般怎么推进？"——
 * 逐字比会认为是两句，然后把他刚问过的原样推回去。
 *
 * （Python 侧是模块私有的 `_key`；这里导出只为让测试能直接钉住字符集，
 * 调用方不该用它。）
 */
export function promptKey(text: string): string {
  return (text || "").replace(KEY_STRIP, "");
}

/**
 * 任何状态下都给得出的三条。**这是最后一道兜底，不许返回空。**
 *
 * 按"他此刻手上有什么"分档，而不是按产物统计 —— 产物统计恰恰是那些刁钻状态
 * （梳理失败、抽出来是空的）里最靠不住的东西。
 */
function always(f: Facts): Prompt[] {
  if (f.nFiles === 0) {
    return [
      new Prompt("我手上有一堆业务流程文档，你能帮我做什么？", "先了解"),
      new Prompt("这类本体建模项目一般怎么推进？", "先了解"),
      new Prompt("我把材料传上来，你先看看？", "开始"),
    ];
  }
  if (f.status !== "done") {
    return [
      new Prompt(
        `这 ${f.nFiles} 份材料里都有什么？`,
        "看材料",
        "先概括一下这些材料的结构：几张表、各是什么形状、哪些是流程说明",
      ),
      new Prompt("这些材料够不够做一轮梳理？还缺什么？", "看材料"),
      new Prompt("先挑一份最关键的讲讲它在说什么", "看材料"),
    ];
  }
  return [
    new Prompt("这一轮梳理都抽出了什么？", "看产物"),
    new Prompt("哪些结论是推断出来的、没有材料依据？", "核实"),
    new Prompt("接下来我该跟客户确认哪些事？", "分工"),
  ];
}

// ══════════════════════════════════════════════════════════════════
//  开场
// ══════════════════════════════════════════════════════════════════
const OPENING: readonly Rule[] = [
  // 什么都没有 —— 这时候他最需要知道"不上传也能聊"
  {
    when: (f) => f.nFiles === 0,
    make: () => [
      new Prompt("我手上有一堆业务流程文档，你能帮我做什么？", "先了解"),
      new Prompt("做本体建模时，主数据和事务数据怎么划分？", "先了解"),
      new Prompt("客户的梳理表里同一个字段有两种口径，一般怎么处理？", "先了解"),
    ],
  },
  // 有材料没跑 —— 这时候该让他先看看材料里有什么，而不是直接花钱
  {
    when: (f) => f.nFiles > 0 && f.status !== "done",
    make: (f) => [
      new Prompt(
        `这 ${f.nFiles} 份材料里都有什么？`,
        "看材料",
        "先概括一下这些材料的结构：几张表、各是什么形状、哪些是流程说明",
      ),
      new Prompt("材料里有哪些业务流程节点？", "看材料"),
      new Prompt("有哪些地方是写得含糊、需要跟客户确认的？", "看材料"),
    ],
  },
];

export interface OpeningArgs {
  state: PromptState;
  files: string[];
  status?: string;
}

/**
 * 新会话（或刚上传完）时给的几条起手式。
 *
 * 刻意不写"你好"这类寒暄提示 —— 提示的位置很贵，占一条就少一条真正有用的。
 */
export function openingPrompts({
  state,
  files,
  status = "idle",
}: OpeningArgs): PromptDict[] {
  const f = facts(state, files, status);
  for (const r of OPENING) {
    if (r.when(f)) return r.make(f).map((p) => p.toDict());
  }
  // 已经跑完了：开场就该是产物相关的。产物统计全是 0（只抽到对象、没流程没规则、
  // 问题也答完了 —— 一个正常终态）时 donePrompts 会空，兜底顶上。
  const done = donePrompts(f);
  return (done.length ? done : always(f)).slice(0, 3).map((p) => p.toDict());
}

function donePrompts(f: Facts): Prompt[] {
  const out: Prompt[] = [];
  if (f.flowActions) {
    out.push(
      new Prompt(
        `流程图抽出了 ${f.flowActions} 个动作，有哪些环节是断的？`,
        "流程",
        "流程图里有哪些死路和悬空节点？分别是材料哪里没写清楚",
      ),
    );
  }
  if (f.inferredEdges) {
    out.push(
      new Prompt(
        `有 ${f.inferredEdges} 条边是你补的，凭什么这么连？`,
        "流程",
        "流程图里被标成推断的那些边，分别是怎么连出来的？没有依据的话就说没有",
      ),
    );
  }
  if (f.questions) {
    out.push(new Prompt(`${f.questions} 个待澄清问题里，哪些最该先问？`, "待办"));
  }
  if (f.objects && !f.properties) {
    out.push(
      new Prompt("为什么一个字段都没抽到？", "追问", "材料里为什么没有字段定义？我该跟客户要什么"),
    );
  }
  if (f.rules) {
    out.push(new Prompt(`${f.rules} 条业务规则分别管哪些单据？`, "追问"));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  追问
// ══════════════════════════════════════════════════════════════════
/** 回答里出现这些词，说明有个自然的下一问。**从回答本身长出来**的追问，
 * 比从状态长出来的更贴 —— 用户刚读完那句话，正想问的就是它。 */
const ECHO: readonly (readonly [string, string, string])[] = [
  ["查不到", "那我该跟客户要什么材料？", "补材料"],
  ["材料里没有", "那我该跟客户要什么材料？", "补材料"],
  ["没有写", "这一块要问客户哪些问题？", "补材料"],
  ["推断", "这个推断的依据是什么？没有依据就说没有", "核实"],
  ["死路", "这些断掉的环节，材料里是怎么写的？", "核实"],
  ["建议", "把这条建议的影响范围列一下", "核实"],
  ["口径", "材料里关于这个口径一共有几种说法？", "核实"],
  ["待确认", "这些待确认的，哪些是我自己能定的、哪些必须问客户？", "分工"],
];

export interface FollowupArgs {
  answer: string;
  state: PromptState;
  files: string[];
  status?: string;
  limit?: number;
  asked?: Iterable<string>;
}

/**
 * 一次回答之后，给几条他多半想接着问的。
 *
 * `asked` 是他这轮之前说过的话。**已经问过的不再推荐** —— 聊了十轮之后
 * 还把开场白推给他（"我手上有一堆业务流程文档，你能帮我做什么？"）是这套
 * 提示最伤人的失败模式：它证明系统没在听。
 *
 * 优先从**回答内容**长出来（他刚读完，正想问的就是它），不够再用状态补，
 * 还不够就用 {@link always} 兜底。去重后截断 —— 提示多于三条就变成噪声，
 * 人会一条都不看。
 *
 * **不会返回空。** 以前只有"一份材料都没有"时才兜底，于是最常见的中间态
 * （材料传了、还没梳理）和最需要指路的时刻（回答是"这轮没跑通：…"）
 * 反而一条提示都没有。
 * （唯一的例外是调用方自己传了 `limit <= 0`；golden 把这个形状也钉住了。）
 */
export function followupPrompts({
  answer,
  state,
  files,
  status = "idle",
  limit = 3,
  asked = [],
}: FollowupArgs): PromptDict[] {
  const a = answer || "";
  const out: Prompt[] = [];
  const seen = new Set<string>();
  for (const x of asked) seen.add(promptKey(x));

  const take = (p: Prompt): void => {
    if (!seen.has(promptKey(p.text))) {
      out.push(p);
      seen.add(promptKey(p.text));
    }
  };

  for (const [needle, text, group] of ECHO) {
    if (a.includes(needle)) take(new Prompt(text, group));
    // 这个检查在 if 外面：Python 侧每轮循环都查一次，limit=0 时第一轮就返回。
    if (out.length >= limit) return out.map((p) => p.toDict());
  }

  const f = facts(state, files, status);
  for (const p of donePrompts(f)) {
    take(p);
    if (out.length >= limit) break;
  }

  for (const p of always(f)) {
    if (out.length >= limit) break;
    take(p);
  }
  // 全被"他已经问过"筛掉了 —— 一条提示都不给比重复一条更糟，原样顶上。
  return (out.length ? out : always(f)).slice(0, limit).map((p) => p.toDict());
}
