/**
 * 对话动态改流程图 —— 结构化编辑。移植自 `src/ontocopilot/onto/flow_edit.py`，
 * 由 `golden/flow_extract.json` 的 `flow_edit` 段钉住（每一步的人话回执、被拒时的
 * 逐字消息、以及"被拒之后图一个字节都没动"）。
 *
 * 和模板编辑同构：流图是数据结构（{@link FlowGraph}），FDE 看着生成的草稿图会要改
 * —— 改个节点措辞、补一条材料没写但他知道的边、删掉一个抽错的节点、把节点挪到
 * 另一个阶段。
 *
 * 同样的纪律：**模型只选操作和参数，不重画整张图。** 直接让模型吐一张新 FlowGraph
 * 会丢掉证据链 —— 每个节点/边的 `Provenance` 是这张图"不是瞎编"的凭证，重画一次
 * 全没了。结构化编辑保留没被碰过的部分的出处。
 *
 * 一条关键区分：**FDE 手动补的边和节点，来源是"人工添加"，不是材料。** 它们在图上
 * 和推断的边一样标出来 —— 但语义不同：推断是系统猜的，人工是 FDE 拍的板。两者都
 * 不该冒充材料依据。
 *
 * ── 移植时钉住的 Python/JS 分叉 ────────────────────────────────
 *
 * Python 的 `fn(g, **args)` 把「参数名对不对」的校验交给了解释器，`apply_flow_edit`
 * 再 `except TypeError` 把它翻译成一句人话。TS 没有 `**kwargs`，所以那两条报错
 * （多给了 / 少给了）由 {@link checkKwargs} 按 CPython 的**逐字文案和先后顺序**
 * 复刻 —— 这句话会被模型转述给用户，也会被模型当作"下次该怎么调"的提示，
 * 改一个词都可能让它一直换着参数重试同一个必然失败的调用。
 *
 * 另一处更隐蔽：`_find_node` 收到非字符串的 `node` 时，Python 是在
 * `ref in n.label.value` 这一行抛 TypeError，于是**也**被翻译成「参数不对」。
 * 照搬这条（{@link PyTypeError}），否则同一个错误调用两侧一个是 400 一个是 500。
 */

import { ValueError } from "../kernel/errors.js";
import { EdgeKind, FlowGraph, NodeKind, makeFlowNode, type FlowNode } from "./flow.js";
import { extracted, inferred, makeProvenance, makeRid, type Provenance } from "./oir.js";

/** 一次流图编辑不合法。消息要说清为什么，让模型能转述。
 *
 * 继承 `kernel/errors.ts` 的 `ValueError`（Python 侧就是 `class
 * FlowEditError(ValueError)`）—— **不要再定义第二份 ValueError**：两份同名类是
 * 两个类身份，`instanceof` 会漏掉其中一份且不报错。 */
export class FlowEditError extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "FlowEditError";
    Object.setPrototypeOf(this, FlowEditError.prototype); // 保住 instanceof
  }
}

/** Python 的 TypeError。`applyFlowEdit` **只**翻译这一类为「参数不对」。 */
class PyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
    Object.setPrototypeOf(this, PyTypeError.prototype);
  }
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 内建类型名 —— 它出现在 TypeError 文案里。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** `sorted()` 按 code point 比 —— 报错文案里的 op 名列表要稳定。 */
function pySorted(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => {
    const x = [...a];
    const y = [...b];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const ca = x[i]!.codePointAt(0)!;
      const cb = y[i]!.codePointAt(0)!;
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return x.length - y.length;
  });
}

/** Python 打印一个 str 列表的形态：`['a', 'b']`。op 名与节点类型名都是 ASCII
 * 标识符，`repr` 就是加一对单引号。 */
function pyList(items: readonly string[]): string {
  return "[" + items.map((s) => `'${s}'`).join(", ") + "]";
}

export type Args = Record<string, unknown>;

const KINDS: ReadonlyArray<readonly [string, NodeKind]> = [
  ["action", NodeKind.ACTION],
  ["event", NodeKind.EVENT],
  ["gateway", NodeKind.GATEWAY],
  ["terminal", NodeKind.TERMINAL],
  ["external", NodeKind.EXTERNAL],
];

/** 按 rid、编号或标签找节点。FDE 说的是标签，不是 rid。 */
function findNode(g: FlowGraph, ref: unknown): FlowNode {
  // `ref in g.nodes`：Python 先算哈希，list/dict 在这里就炸（不是"找不到"）
  if (Array.isArray(ref) || (typeof ref === "object" && ref !== null)) {
    throw new PyTypeError(`unhashable type: '${pyTypeName(ref)}'`);
  }
  if (typeof ref === "string" && g.nodes.has(ref)) return g.nodes.get(ref)!;
  let hit = [...g.nodes.values()].filter((n) => n.code === ref || n.label.value === ref);
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) {
    // 模糊：标签包含。**非字符串在这一行炸** —— Python 的
    // `'in <string>' requires string as left operand`，被 applyFlowEdit 翻译成
    // 「参数不对」。静默当成"找不到"会让模型以为节点名写错了，一直换名字重试。
    // 逐节点判而不是先判类型：**空图上这个循环一次都不执行**，于是非字符串的
    // ref 在空图上得到的是「找不到节点」而不是 TypeError —— 照搬这个形状。
    hit = [...g.nodes.values()].filter((n) => pyIn(ref, n.label.value));
  }
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) throw new FlowEditError(`找不到节点「${fmt(ref)}」。`);
  throw new FlowEditError(
    `「${fmt(ref)}」对应多个节点，说得更具体些：` +
      `${hit
        .slice(0, 5)
        .map((n) => n.label.value)
        .join("、")}`,
  );
}

/** 人工编辑的来源标记。**不是材料** —— 它是 FDE 拍的板，图上照样标出来，
 * 但和系统推断区分开。 */
function humanProv(note: string): Provenance {
  return makeProvenance("human", "人工编辑", { kind: "meta", field: note }, {
    snippet: note,
    extractor: "human",
    confidence: 1.0,
  });
}

/** `x in <string>`：Python 对非 str 的左操作数抛 TypeError。 */
function pyIn(needle: unknown, hay: string): boolean {
  if (typeof needle !== "string") {
    throw new PyTypeError(
      `'in <string>' requires string as left operand, not ${pyTypeName(needle)}`,
    );
  }
  return hay.includes(needle);
}

/** f-string 插值。参数可能不是字符串（模型什么都可能塞进来）。 */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

// ══════════════════════════════════════════════════════════════════
//  操作
// ══════════════════════════════════════════════════════════════════
function opRenameNode(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  const label = a["label"];
  const old = n.label.value;
  // 保留原出处 —— 只是改了措辞，依据没变
  const ev = n.label.evidence.length > 0 ? n.label.evidence : [humanProv(`人工改名：${old}→${fmt(label)}`)];
  n.label = extracted(fmt(label), ...ev.slice(0, 1));
  return `把「${old}」改名为「${fmt(label)}」。`;
}

function opSetActor(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  const actor = a["actor"];
  if (n.kind !== NodeKind.ACTION) {
    throw new FlowEditError(`「${n.label.value}」不是动作节点，没有执行者。`);
  }
  n.actor = extracted(fmt(actor), humanProv(`人工指定执行者：${fmt(actor)}`));
  return `「${n.label.value}」的执行者设为「${fmt(actor)}」。`;
}

function opSetStage(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  const stage = a["stage"];
  // stage 可以是 key 或阶段标题
  let key: string | null = null;
  for (const [k, st] of g.stages) {
    if (k === stage || pyIn(stage, st.title)) {
      key = k;
      break;
    }
  }
  if (key === null) {
    throw new FlowEditError(
      `没有阶段「${fmt(stage)}」。现有：` +
        `${[...g.stages.values()].map((st) => st.title).join("、")}`,
    );
  }
  n.stage = key;
  return `把「${n.label.value}」移到「${g.stages.get(key)!.title}」。`;
}

function opAddNode(g: FlowGraph, a: Args): string {
  const kind = a["kind"];
  const label = a["label"];
  const stage = a["stage"] ?? "";
  const actor = a["actor"] ?? "";
  const entry = KINDS.find(([k]) => k === kind);
  if (entry === undefined) {
    throw new FlowEditError(
      `节点类型只能是 ${pyList(KINDS.map(([k]) => k))}，不是 ${fmt(kind)}。`,
    );
  }
  let stageKey = "";
  if (stage) {
    for (const [k, st] of g.stages) {
      if (k === stage || pyIn(stage, st.title)) {
        stageKey = k;
        break;
      }
    }
    if (!stageKey) throw new FlowEditError(`没有阶段「${fmt(stage)}」。`);
  }
  const prov = humanProv(`人工添加节点：${fmt(label)}`);
  const n = g.addNode(
    makeFlowNode({
      rid: makeRid("fn", `manual_${fmt(label)}`),
      kind: entry[1],
      stage: stageKey,
      label: inferred(fmt(label)), // inferred：人工加的，不冒充材料
      actor: actor ? extracted(fmt(actor), prov) : inferred(""),
    }),
  );
  n.label.evidence = [prov]; // 标成人工来源，图上会标出来
  return `加了一个${fmt(kind)}节点「${fmt(label)}」（人工添加，图上会标注）。`;
}

function opConnect(g: FlowGraph, a: Args): string {
  const src = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const label = a["label"] ?? "";
  // 人工连的边：EdgeKind.INFERRED 让它在图上是虚线，但 evidence 标人工来源
  const prov = humanProv(`人工连边：${src.label.value}→${tgt.label.value}`);
  g.connect(src.rid, tgt.rid, { kind: EdgeKind.INFERRED, label: fmt(label), evidence: [prov] });
  return (
    `连了一条边：「${src.label.value}」→「${tgt.label.value}」` +
    `${label ? `（${fmt(label)}）` : ""}。人工添加的边图上是虚线。`
  );
}

function opDisconnect(g: FlowGraph, a: Args): string {
  const src = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const gone = [...g.edges.values()]
    .filter((e) => e.source === src.rid && e.target === tgt.rid)
    .map((e) => e.rid);
  if (gone.length === 0) {
    throw new FlowEditError(`「${src.label.value}」和「${tgt.label.value}」之间没有边。`);
  }
  for (const rid of gone) g.edges.delete(rid);
  return `删掉了「${src.label.value}」→「${tgt.label.value}」的边。`;
}

function opRemoveNode(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  // 连带删掉挂在它上面的边 —— 留下悬空边比留下节点更糟
  for (const e of [...g.edges.values()]) {
    if (e.source === n.rid || e.target === n.rid) g.edges.delete(e.rid);
  }
  g.nodes.delete(n.rid);
  return `删掉了节点「${n.label.value}」及其相连的边。`;
}

/** 给网关的一条出边贴条件标签（通过/驳回）。 */
function opSetBranchLabel(g: FlowGraph, a: Args): string {
  const src = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const label = a["label"];
  const hit = [...g.edges.values()].filter((e) => e.source === src.rid && e.target === tgt.rid);
  if (hit.length === 0) {
    throw new FlowEditError(`「${src.label.value}」和「${tgt.label.value}」之间没有边。`);
  }
  hit[0]!.label = fmt(label);
  hit[0]!.kind = EdgeKind.CONDITIONAL;
  return `给「${src.label.value}」→「${tgt.label.value}」这条边标上「${fmt(label)}」。`;
}

interface OpSpec {
  /** Python 侧的内部函数名 —— 它出现在 TypeError 文案里，会被念给用户听。 */
  fnName: string;
  required: readonly string[];
  optional: readonly string[];
  run: (g: FlowGraph, a: Args) => string;
}

const OPS: Record<string, OpSpec> = {
  rename_node: {
    fnName: "_op_rename_node",
    required: ["node", "label"],
    optional: [],
    run: opRenameNode,
  },
  set_actor: { fnName: "_op_set_actor", required: ["node", "actor"], optional: [], run: opSetActor },
  set_stage: { fnName: "_op_set_stage", required: ["node", "stage"], optional: [], run: opSetStage },
  add_node: {
    fnName: "_op_add_node",
    required: ["kind", "label"],
    optional: ["stage", "actor"],
    run: opAddNode,
  },
  connect: {
    fnName: "_op_connect",
    required: ["source", "target"],
    optional: ["label"],
    run: opConnect,
  },
  disconnect: {
    fnName: "_op_disconnect",
    required: ["source", "target"],
    optional: [],
    run: opDisconnect,
  },
  remove_node: { fnName: "_op_remove_node", required: ["node"], optional: [], run: opRemoveNode },
  set_branch_label: {
    fnName: "_op_set_branch_label",
    required: ["source", "target", "label"],
    optional: [],
    run: opSetBranchLabel,
  },
};

/** 可用的编辑操作名。给上层做 schema / 提示用，别再手抄一份。 */
export const FLOW_EDIT_OPS: readonly string[] = Object.keys(OPS);

/** 复现 CPython 关键字展开的两条报错。
 *
 * 顺序也照抄：**先报多余的参数，再报缺失的** —— CPython 是在绑定关键字时就
 * 抛「unexpected keyword」，缺参检查发生在那之后。 */
function checkKwargs(spec: OpSpec, args: Args): void {
  const known = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(args)) {
    if (!known.has(k)) {
      throw new PyTypeError(`${spec.fnName}() got an unexpected keyword argument '${k}'`);
    }
  }
  const missing = spec.required.filter((k) => !(k in args));
  if (missing.length > 0) {
    const names = missing.map((k) => `'${k}'`);
    const joined =
      names.length === 1
        ? names[0]!
        : names.length === 2
          ? `${names[0]!} and ${names[1]!}`
          : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]!}`;
    const plural = missing.length === 1 ? "argument" : "arguments";
    throw new PyTypeError(
      `${spec.fnName}() missing ${missing.length} required keyword-only ${plural}: ${joined}`,
    );
  }
}

/**
 * 对流图应用一次结构化编辑，成功返回一句人话。
 *
 * 抛 {@link FlowEditError} 时原图不动 —— 大多数操作是就地改单个对象，
 * 失败发生在找不到节点/参数不对，此时还没动过任何东西。
 */
export function applyFlowEdit(g: FlowGraph, op: string, args: Args): string {
  const spec = OPS[op];
  if (spec === undefined) {
    throw new FlowEditError(`不支持的流图编辑 ${op}。支持：${pyList(pySorted(Object.keys(OPS)))}`);
  }
  try {
    checkKwargs(spec, args);
    return spec.run(g, args);
  } catch (exc) {
    // **只接 TypeError**。Python 侧的 `except TypeError` 不会接住 FlowEditError
    // （它是 ValueError），接多了会把"找不到节点"伪装成"你参数写错了"。
    if (exc instanceof PyTypeError) {
      throw new FlowEditError(`${op} 的参数不对：${exc.message}`);
    }
    throw exc;
  }
}
