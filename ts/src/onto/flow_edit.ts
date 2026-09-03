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
 * 不该冒充材料依据。无材料通用草案再低一档：节点/边保持零 evidence，由会话级
 * `generic_assumption` 标记，不能伪装成 FDE 已拍板。
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
import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  flowFromDict,
  makeFlowNode,
  makeStage,
  makeWorkflow,
  parseEdgeKind,
  parseNodeKind,
  type FlowNode,
  type Stage,
} from "./flow.js";
import { Status, extracted, inferred, makeProvenance, makeRid, type Provenance } from "./oir.js";

/** `generic_assumption` 是无材料通用草案，不是 FDE 拍板、更不是材料抽取。 */
export type FlowEditSource = "user" | "generic_assumption";

export interface FlowEditOptions {
  readonly source?: FlowEditSource;
  /**
   * 业务对象名 → rid。`bind_objects` 用它把「采购申请」这种人话解析成 rid。
   *
   * 注进来而不是让 flow_edit 直接读 OIR：这个模块只认 FlowGraph，
   * 让它去 import OIR 就把「改流程图」和「读模型」焊死了。解析不出来返回空串。
   */
  readonly resolveObject?: (name: string) => string;
  /** bind_auto 的通道：按名字确定性补空绑定，返回新增条数。注入理由同上 ——
   *  这个模块只认 FlowGraph，不 import OIR。 */
  readonly autoBind?: () => number;
}

interface EditContext {
  readonly source: FlowEditSource;
  readonly generic: boolean;
  readonly resolveObject?: ((name: string) => string) | undefined;
  readonly autoBind?: (() => number) | undefined;
  provenance(note: string): Provenance | null;
}

function editContext(opts: FlowEditOptions): EditContext {
  const source = opts.source === "generic_assumption" ? "generic_assumption" : "user";
  return {
    source,
    generic: source === "generic_assumption",
    resolveObject: opts.resolveObject,
    autoBind: opts.autoBind,
    // 通用假设必须保持零 evidence；它的来源标记在会话级 draft_provenance，
    // 否则 nodeGrounded/edgeGrounded 会把假设误算成“有材料依据”。
    provenance: (note) => source === "generic_assumption" ? null : humanProv(note),
  };
}

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
function opRenameNode(g: FlowGraph, a: Args, ctx: EditContext): string {
  const n = findNode(g, a["node"]);
  const label = a["label"];
  const old = n.label.value;
  // 保留原出处 —— 只是改了措辞，依据没变
  if (ctx.generic) {
    n.label = inferred(fmt(label));
  } else {
    const ev = n.label.evidence.length > 0
      ? n.label.evidence
      : [humanProv(`人工改名：${old}→${fmt(label)}`)];
    n.label = extracted(fmt(label), ...ev.slice(0, 1));
  }
  return `把「${old}」改名为「${fmt(label)}」。`;
}

/**
 * 把业务对象绑到流程节点上（A7 的第一块）。
 *
 * 这是 `FlowNode.objects` 唯一的人工写入口。实测真实库：11 个流程节点的
 * `objects` **全部是 `[]`** —— 右栏那句「流程节点 0」不是显示错误，是流程图和
 * Ontology 压根没连起来的如实报告。而在这个 op 之前，**连补都补不上**：
 * flow.edit 的七个 op 里没有一个碰得到 objects，右栏却已经在提示
 * 「用 flow.edit 把那些节点绑到这个对象上」—— 指着一个不存在的能力。
 *
 * 用 apiName / displayName / rid 都能指对象，落盘一律存 rid：
 * `objects` 的消费方（右栏计数、canonical 编译）按 rid 比，存别的形态等于没绑。
 */
function opBindObjects(g: FlowGraph, a: Args, ctx: EditContext): string {
  const n = findNode(g, a["node"]);
  const raw = a["objects"];
  const wanted = (Array.isArray(raw) ? raw : [raw]).map((x) => fmt(x)).filter((x) => x !== "");
  if (wanted.length === 0) {
    throw new FlowEditError("objects 是空的 —— 要绑哪个业务对象？给 apiName 或中文名。");
  }
  const resolve = ctx.resolveObject;
  if (resolve === undefined) {
    throw new FlowEditError("这个调用方没有接对象名解析通道，暂时绑不了对象。");
  }
  // **先全部解析，再落**：以前是边解析边 push，最后才查 missed —— 部分成功
  // 违反文件头「被拒之后图一个字节都没动」的承诺（flow_edit 没有 oir_edit 那样的
  // trial 副本，原子性只能靠 op 自己先验后改）。
  const resolved: { name: string; rid: string }[] = [];
  const missed: string[] = [];
  for (const name of wanted) {
    const rid = resolve(name);
    // 名字对不上就**点名说**，不静默跳过 —— 静默跳过会让人以为绑上了
    if (rid === "") missed.push(name);
    else resolved.push({ name, rid });
  }
  if (missed.length > 0) {
    throw new FlowEditError(
      `模型里没有这些对象：${missed.join("、")}。先用 oir.add 建出来，或换个已有的名字。`,
    );
  }
  const added: string[] = [];
  for (const { name, rid } of resolved) {
    if (!n.objects.includes(rid)) { n.objects.push(rid); added.push(name); }
  }
  return added.length > 0
    ? `把「${n.label.value}」绑到 ${added.join("、")} 上。`
    : `「${n.label.value}」本来就绑着这些对象，没有改动。`;
}

function opSetActor(g: FlowGraph, a: Args, ctx: EditContext): string {
  const n = findNode(g, a["node"]);
  const actor = a["actor"];
  if (n.kind !== NodeKind.ACTION) {
    throw new FlowEditError(`「${n.label.value}」不是动作节点，没有执行者。`);
  }
  const prov = ctx.provenance(`人工指定执行者：${fmt(actor)}`);
  n.actor = prov === null ? inferred(fmt(actor)) : extracted(fmt(actor), prov);
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

/**
 * 建一个节点并挂进图里。
 *
 * `add_node` 与 `apply_patch` 共用这一份 —— 两处各写一遍的话，"人工节点怎么标溯源"
 * 这件事迟早会漂开，而漂开的那一天没有任何测试会报警（两边都自洽）。
 */
function addOneNode(g: FlowGraph, a: Args, ctx: EditContext): FlowNode {
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
  const prov = ctx.provenance(`人工添加节点：${fmt(label)}`);
  const n = g.addNode(
    makeFlowNode({
      rid: makeRid("fn", `manual_${fmt(label)}`),
      kind: entry[1],
      stage: stageKey,
      label: inferred(fmt(label)), // inferred：人工加的，不冒充材料
      actor:
        actor && prov !== null
          ? extracted(fmt(actor), prov)
          : actor
            ? inferred(fmt(actor))
            : inferred(""),
    }),
  );
  if (prov !== null) n.label.evidence = [prov]; // 标成人工来源，图上会标出来
  return n;
}

function opAddNode(g: FlowGraph, a: Args, ctx: EditContext): string {
  addOneNode(g, a, ctx);
  return (
    `加了一个${fmt(a["kind"])}节点「${fmt(a["label"])}」（` +
    `${ctx.generic ? "通用假设，待业务验证" : "人工添加，图上会标注"}）。`
  );
}

/**
 * 加一个 Event，并且**同一次就把产生它的 Action 连上**。
 *
 * 为什么要专门有这个 op：Event 的核心契约就是"谁产生它"。分成 `add_node` +
 * `connect` 两步时，模型在预算紧张的一轮里几乎总是只做完第一步 —— 于是画布上多出
 * 一串没有来源的 Event，而 OntologyPackage 编译时它们全部落成 `producerState:
 * "unknown"`。一步做完两件事，是让"Event 必须有 producer"这条不变量**默认成立**，
 * 而不是事后靠门禁去抓。
 */
function opAddEvent(g: FlowGraph, a: Args, ctx: EditContext): string {
  const created = opAddNode(g, { ...a, kind: "event" }, ctx);
  const producer = a["producer"] ?? "";
  if (!producer) {
    return (
      `${created}**它还没有产生者** —— 用 producer 参数或 connect 把对应的 Action 连上，` +
      "否则编译成 OntologyPackage 时这个 Event 的 producer 会是 unknown。"
    );
  }
  const src = findNode(g, producer);
  const evt = findNode(g, a["label"]);
  if (src.kind !== NodeKind.ACTION && src.kind !== NodeKind.EXTERNAL) {
    throw new FlowEditError(
      `producer 必须是一个 action 或 external 节点，「${src.label.value}」是 ${String(src.kind)}。`,
    );
  }
  const prov = ctx.provenance(`人工连边：${src.label.value}→${evt.label.value}`);
  g.connect(src.rid, evt.rid, {
    kind: EdgeKind.INFERRED,
    label: "",
    evidence: prov === null ? [] : [prov],
  });
  return `${created}并把产生它的「${src.label.value}」连了上去。`;
}

/** patch 里的一项必须是对象；给出**哪一项**不合法，而不是一句"参数不对"。 */
function patchRows(v: unknown, field: string): Record<string, unknown>[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new FlowEditError(`${field} 要是一个数组。`);
  return v.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new FlowEditError(`${field}[${i}] 要是一个对象。`);
    }
    return row as Record<string, unknown>;
  });
}

/**
 * 一次落一整块流程：阶段 + 节点 + 连线。
 *
 * 存在的理由是一笔账：一份能给客户看的通用流程要 8–12 个节点、8–14 条边、
 * 3–4 个阶段，而每个 op 一次只动一个元素、对话循环一轮只有 5 步 —— 缺口两个
 * 数量级。于是模型每次都先加几个最显眼的 Action，边永远排在最后、永远轮不到，
 * 用户拿到的就是一堆孤立节点。
 *
 * **整批成功才落地。** 全程在副本上做，任一条不合法就整批拒绝、原图一个字节不动。
 * 不允许部分成功：半张流程图比没有更糟，因为它看起来像是完整的。
 */
function opApplyPatch(g: FlowGraph, a: Args, ctx: EditContext): string {
  const stages = patchRows(a["stages"], "stages");
  const nodes = patchRows(a["nodes"], "nodes");
  const edges = patchRows(a["edges"], "edges");
  if (stages.length + nodes.length + edges.length === 0) {
    throw new FlowEditError("apply_patch 至少要给 stages / nodes / edges 里的一项。");
  }

  const draft = flowFromDict(g.toDict());
  // patch 里的 key → 新节点 rid。边可以用 key 指向本批新建的节点，也可以用
  // 名字/编号指向图上已有的节点 —— 两种都要能连，否则"给现有流程补一段"做不了。
  const keyed = new Map<string, string>();

  stages.forEach((row, i) => {
    const key = fmt(row["key"] ?? "");
    const title = fmt(row["title"] ?? "");
    if (!key || !title) throw new FlowEditError(`stages[${i}] 要有 key 和 title。`);
    draft.stages.set(
      key,
      makeStage({
        key,
        title,
        subtitle: fmt(row["subtitle"] ?? ""),
        order: draft.stages.size,
      }),
    );
  });

  nodes.forEach((row, i) => {
    let node: FlowNode;
    try {
      node = addOneNode(
        draft,
        {
          kind: row["kind"],
          label: row["label"],
          ...(row["stage"] === undefined ? {} : { stage: row["stage"] }),
          ...(row["actor"] === undefined ? {} : { actor: row["actor"] }),
        },
        ctx,
      );
    } catch (exc) {
      // 指名道姓说是**哪一条**坏了。整批拒绝时这句话是模型唯一能据以改对的信息。
      throw new FlowEditError(
        `nodes[${i}]（${fmt(row["label"] ?? "未命名")}）：${
          exc instanceof Error ? exc.message : String(exc)
        }`,
      );
    }
    const key = fmt(row["key"] ?? "");
    if (key) keyed.set(key, node.rid);
  });

  edges.forEach((row, i) => {
    const resolve = (ref: unknown, side: string): string => {
      const raw = fmt(ref ?? "");
      if (!raw) throw new FlowEditError(`edges[${i}] 缺 ${side}。`);
      const byKey = keyed.get(raw);
      if (byKey !== undefined) return byKey;
      try {
        return findNode(draft, raw).rid;
      } catch {
        throw new FlowEditError(
          `edges[${i}] 的 ${side}「${raw}」既不是这一批里的 key，也不是图上已有的节点。`,
        );
      }
    };
    const src = resolve(row["from"], "from");
    const tgt = resolve(row["to"], "to");
    const label = fmt(row["label"] ?? "");
    const prov = ctx.provenance(`人工连边：${src}→${tgt}`);
    draft.connect(src, tgt, {
      kind: EdgeKind.INFERRED,
      label,
      evidence: prov === null ? [] : [prov],
    });
  });

  // 全部通过 —— 一次性写回。到这里之前 g 一个字节都没被动过。
  g.stages.clear();
  for (const [k, v] of draft.stages) g.stages.set(k, v);
  g.nodes.clear();
  for (const [k, v] of draft.nodes) g.nodes.set(k, v);
  g.edges.clear();
  for (const [k, v] of draft.edges) g.edges.set(k, v);

  const parts = [
    stages.length ? `${stages.length} 个阶段` : "",
    nodes.length ? `${nodes.length} 个环节` : "",
    edges.length ? `${edges.length} 条连线` : "",
  ].filter(Boolean);
  return (
    `一次落了 ${parts.join(" / ")}（${
      ctx.generic ? "通用假设，待业务验证" : "人工添加，图上会标注"
    }）。`
  );
}

function opConnect(g: FlowGraph, a: Args, ctx: EditContext): string {
  const src = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const label = a["label"] ?? "";
  // 人工连的边：EdgeKind.INFERRED 让它在图上是虚线，但 evidence 标人工来源
  const prov = ctx.provenance(`人工连边：${src.label.value}→${tgt.label.value}`);
  g.connect(src.rid, tgt.rid, {
    kind: EdgeKind.INFERRED,
    label: fmt(label),
    evidence: prov === null ? [] : [prov],
  });
  return (
    `连了一条边：「${src.label.value}」→「${tgt.label.value}」` +
    `${label ? `（${fmt(label)}）` : ""}。${ctx.generic ? "通用假设边，待业务验证。" : "人工添加的边图上是虚线。"}`
  );
}

function opDisconnect(g: FlowGraph, a: Args): string {
  const src = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const hitEdges = [...g.edges.values()].filter(
    (e) => e.source === src.rid && e.target === tgt.rid,
  );
  if (hitEdges.length === 0) {
    throw new FlowEditError(`「${src.label.value}」和「${tgt.label.value}」之间没有边。`);
  }
  // A9（边侧）：有材料证据的边删了会丢证据 —— 与 OIR 侧的删除守卫同一条纪律。
  const grounded = hitEdges.filter((e) => e.evidence.some((p) => p.extractor !== "human"));
  if (grounded.length > 0) {
    throw new FlowEditError(
      `「${src.label.value}」→「${tgt.label.value}」里有 ${grounded.length} 条边带材料证据，` +
        "硬删会丢。要改流向请改材料后重跑，或用 set_branch_label 修正条件语义。",
    );
  }
  for (const e of hitEdges) g.edges.delete(e.rid);
  return `删掉了「${src.label.value}」→「${tgt.label.value}」的边。`;
}

function opRemoveNode(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  // A9：与 oir_edit.requireEditableOrigin 同一条纪律的流程版 —— 材料抽出来的
  // 环节（label 证据里有非 human 出处）硬删会丢证据，指路软删。
  const material = n.label.evidence.filter((p) => p.extractor !== "human");
  if (material.length > 0) {
    throw new FlowEditError(
      `「${n.label.value}」是从材料抽出来的（${material.length} 条出处），硬删会丢证据。` +
        "要排除请用 set_node_status(status=rejected)。",
    );
  }
  const touching = [...g.edges.values()].filter(
    (e) => e.source === n.rid || e.target === n.rid,
  );
  // C4：破坏性编辑先看影响 —— 有连边/绑定时不带 confirm 不落，影响面列给人。
  if (touching.length + n.objects.length > 0 && a["confirm"] !== true) {
    throw new FlowEditError(
      `删「${n.label.value}」会连带 ${touching.length} 条边` +
        (n.objects.length > 0 ? `、${n.objects.length} 处对象绑定` : "") +
        "。确认要删就再调一次并带 confirm=true。",
    );
  }
  // 连带删掉挂在它上面的边 —— 留下悬空边比留下节点更糟
  for (const e of touching) g.edges.delete(e.rid);
  g.nodes.delete(n.rid);
  return touching.length > 0
    ? `删掉了节点「${n.label.value}」及其相连的 ${touching.length} 条边。`
    : `删掉了节点「${n.label.value}」。`;
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
  if (hit.length === 1) {
    hit[0]!.label = fmt(label);
    hit[0]!.kind = EdgeKind.CONDITIONAL;
    return `给「${src.label.value}」→「${tgt.label.value}」这条边标上「${fmt(label)}」。`;
  }
  // 平行边：以前 `hit[0]!` 静默只改第一条 —— 第二条永远贴不上标签，且没人知道。
  // 规则：优先给**没有标签**的贴（有标签的是别的条件，覆盖等于改语义）；
  // 全都有标签就明说让人指认；多条无标签视为重复边，全部贴上并说明。
  const bare = hit.filter((e) => !e.label);
  if (bare.length === 0) {
    throw new FlowEditError(
      `「${src.label.value}」→「${tgt.label.value}」有 ${hit.length} 条平行边且都已有标签` +
        `（${hit.map((e) => e.label).join("、")}）。要改哪条的条件，先 disconnect 重连再标。`,
    );
  }
  for (const e of bare) {
    e.label = fmt(label);
    e.kind = EdgeKind.CONDITIONAL;
  }
  return (
    `给「${src.label.value}」→「${tgt.label.value}」标上「${fmt(label)}」` +
    `（该对节点间有 ${hit.length} 条平行边，已给 ${bare.length} 条无标签的贴上）。`
  );
}

// ══════════════════════════════════════════════════════════════════
//  第 2 层「二轮编辑动词」：抽错类型 / 解绑 / 泳道改名与重排
// ══════════════════════════════════════════════════════════════════

/** 抽错类型不再需要 remove+add —— 那会丢出处和全部连边（A1 缺口）。 */
function opSetKind(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  let kind: NodeKind;
  try {
    kind = parseNodeKind(a["kind"]);
  } catch {
    throw new FlowEditError(`kind 只能是 ${pyList(Object.values(NodeKind))}。`);
  }
  if (n.kind === kind) return `「${n.label.value}」本来就是 ${kind}，没有改动。`;
  const before = n.kind;
  n.kind = kind;
  return `把「${n.label.value}」从 ${before} 改为 ${kind}（出处与连边保留）。`;
}

/** bind_objects 的反向操作（A4：以前只能加不能减，绑错了改不回来）。 */
function opUnbindObjects(g: FlowGraph, a: Args, ctx: EditContext): string {
  const n = findNode(g, a["node"]);
  const raw = a["objects"];
  const wanted = (Array.isArray(raw) ? raw : [raw]).map((x) => fmt(x)).filter((x) => x !== "");
  if (wanted.length === 0) {
    throw new FlowEditError("objects 是空的 —— 要解绑哪个业务对象？给 apiName 或中文名。");
  }
  const resolve = ctx.resolveObject;
  if (resolve === undefined) {
    throw new FlowEditError("这个调用方没有接对象名解析通道，暂时解不了绑。");
  }
  // 与 bind 同一条原子纪律：先全部解析，有一个对不上整条拒绝、图不动。
  const resolved: { name: string; rid: string }[] = [];
  const missed: string[] = [];
  for (const name of wanted) {
    const rid = resolve(name);
    if (rid === "") missed.push(name);
    else resolved.push({ name, rid });
  }
  if (missed.length > 0) {
    throw new FlowEditError(`模型里没有这些对象：${missed.join("、")}。`);
  }
  const removed: string[] = [];
  const absent: string[] = [];
  for (const { name, rid } of resolved) {
    const i = n.objects.indexOf(rid);
    if (i >= 0) {
      n.objects.splice(i, 1);
      removed.push(name);
    } else {
      absent.push(name);
    }
  }
  if (removed.length === 0) return `「${n.label.value}」本来就没绑这些对象，没有改动。`;
  return (
    `把「${n.label.value}」从 ${removed.join("、")} 上解绑。` +
    (absent.length > 0 ? `（${absent.join("、")} 本来就没绑）` : "")
  );
}

/** key 或标题都能指到阶段。key 是节点归属的锚，永远不改。 */
function findStage(g: FlowGraph, ref: unknown): Stage {
  const want = fmt(ref);
  const direct = g.stages.get(want);
  if (direct) return direct;
  const hit = [...g.stages.values()].filter((s) => s.title === want);
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) {
    throw new FlowEditError(
      `找不到阶段「${want}」。现有：${[...g.stages.values()].map((s) => s.title).join("、") || "（还没有阶段）"}`,
    );
  }
  throw new FlowEditError(`「${want}」对应多个阶段，用 key 指定。`);
}

/** 泳道改名只动 title —— 节点引用的是 key，key 一动全部归属跟着断（A2 缺口）。 */
function opRenameStage(g: FlowGraph, a: Args): string {
  const st = findStage(g, a["stage"]);
  const title = fmt(a["title"]);
  if (!title) throw new FlowEditError("title 是空的 —— 新名字叫什么？");
  const old = st.title;
  st.title = title;
  return `把阶段「${old}」改名为「${title}」（key=${st.key} 不变，节点归属不受影响）。`;
}

/** 重排必须给全量排列 —— 半份顺序比没有顺序更乱（A2 缺口）。 */
function opReorderStages(g: FlowGraph, a: Args): string {
  const raw = a["order"];
  const refs = (Array.isArray(raw) ? raw : []).map((x) => fmt(x)).filter((x) => x !== "");
  if (refs.length === 0) {
    throw new FlowEditError("order 是空的 —— 按想要的先后把全部阶段列一遍。");
  }
  const seen = new Set<string>();
  const picked: Stage[] = [];
  for (const r of refs) {
    const st = findStage(g, r);
    if (seen.has(st.key)) throw new FlowEditError(`「${r}」在 order 里出现了两次。`);
    seen.add(st.key);
    picked.push(st);
  }
  const missing = [...g.stages.values()].filter((s) => !seen.has(s.key));
  if (missing.length > 0) {
    throw new FlowEditError(
      `order 必须是全量排列，缺：${missing.map((s) => s.title).join("、")}。缺一个都不落。`,
    );
  }
  picked.forEach((st, i) => {
    st.order = i;
  });
  return `阶段顺序已更新：${picked.map((s) => s.title).join(" → ")}。`;
}

/** 边类型的口语别名：模型/人常写全词，EdgeKind 存的是缩值。 */
const EDGE_KIND_ALIAS: Readonly<Record<string, string>> = {
  compensate: EdgeKind.COMPENSATE,
  conditional: EdgeKind.CONDITIONAL,
};

/**
 * 改一条边的类型（A5：COMPENSATE/EXTERNAL 此前人工建不出来 —— EdgeKind 定义了
 * 它们，connect 却一律写死 INFERRED）。平行边用 label 指认，指不清就报错列出
 * 现有标签 —— 与 set_branch_label 的 A6 修复同一条纪律：不猜、不静默改第一条。
 */
function opSetEdgeKind(g: FlowGraph, a: Args): string {
  const src2 = findNode(g, a["source"]);
  const tgt = findNode(g, a["target"]);
  const rawKind = fmt(a["kind"]);
  let kind: EdgeKind;
  try {
    kind = parseEdgeKind(EDGE_KIND_ALIAS[rawKind] ?? rawKind);
  } catch {
    throw new FlowEditError(
      `kind 只能是 ${pyList([...Object.values(EdgeKind), ...Object.keys(EDGE_KIND_ALIAS)])}。`,
    );
  }
  const hit = [...g.edges.values()].filter((e) => e.source === src2.rid && e.target === tgt.rid);
  if (hit.length === 0) {
    throw new FlowEditError(`「${src2.label.value}」和「${tgt.label.value}」之间没有边。`);
  }
  const wantLabel = a["label"] === undefined ? null : fmt(a["label"]);
  let edge;
  if (hit.length === 1 && wantLabel === null) {
    edge = hit[0]!;
  } else {
    const byLabel = wantLabel === null ? [] : hit.filter((e) => e.label === wantLabel);
    if (byLabel.length !== 1) {
      throw new FlowEditError(
        `「${src2.label.value}」→「${tgt.label.value}」有 ${hit.length} 条平行边` +
          `（标签：${hit.map((e) => e.label || "（无）").join("、")}），` +
          "用 label 指认要改哪条。",
      );
    }
    edge = byLabel[0]!;
  }
  const before = edge.kind;
  edge.kind = kind;
  return `把「${src2.label.value}」→「${tgt.label.value}」${
    edge.label ? `（${edge.label}）` : ""
  }的类型从 ${before} 改为 ${kind}。`;
}

/** 流程侧的评审状态（A10 复活后）：rejected = 排除但保留证据 —— 不硬删的正路。 */
function opSetNodeStatus(g: FlowGraph, a: Args): string {
  const n = findNode(g, a["node"]);
  const want = fmt(a["status"]);
  if (!(Object.values(Status) as string[]).includes(want)) {
    throw new FlowEditError(`status 只能是 ${pyList(Object.values(Status))}。`);
  }
  n.status = want as Status;
  return (
    `把环节「${n.label.value}」标为 ${want}。` +
    (want === Status.REJECTED ? "（排除但保留证据 —— 这正是不硬删的理由）" : "")
  );
}

/**
 * 定义/更新一条业务流（A3 缺口：非 BPMN 材料建的图 workflows 恒空，
 * 「这条流程从哪进、到哪结束」说不出来，编译时还专门报缺口）。
 * entry/exits 全部解析成功才落 —— 半条业务流比没有更误导。
 */
function opSetWorkflow(g: FlowGraph, a: Args): string {
  const key = fmt(a["workflow"]);
  if (!key || key === "None") throw new FlowEditError("workflow 是空的 —— 给这条业务流一个 key。");
  const entry = findNode(g, a["entry"]);
  const raw = a["exits"];
  const exitRefs = (Array.isArray(raw) ? raw : [raw]).map((x) => fmt(x)).filter((x) => x !== "" && x !== "None");
  if (exitRefs.length === 0) throw new FlowEditError("exits 是空的 —— 这条流程走到哪算完？");
  const exits = exitRefs.map((r) => findNode(g, r).rid);
  const title = a["title"] === undefined || fmt(a["title"]) === "" ? key : fmt(a["title"]);
  g.workflows.set(key, makeWorkflow({
    key,
    title,
    entry: entry.rid,
    exits,
    description: a["description"] === undefined ? "" : fmt(a["description"]),
  }));
  return `业务流「${title}」已定：从「${entry.label.value}」进，${exits.length} 个出口。`;
}

function opRemoveWorkflow(g: FlowGraph, a: Args): string {
  const want = fmt(a["workflow"]);
  const direct = g.workflows.get(want);
  const hit = direct ?? [...g.workflows.values()].find((w) => w.title === want);
  if (hit === undefined) {
    throw new FlowEditError(
      `找不到业务流「${want}」。现有：${[...g.workflows.values()].map((w) => w.title).join("、") || "（还没有）"}`,
    );
  }
  g.workflows.delete(hit.key);
  return `删掉了业务流「${hit.title}」（结构元数据，节点与边不受影响）。`;
}

/** 自动绑定的手动触发口（C2 前置：实测真实库流程节点 objects 全空）。 */
function opBindAuto(g: FlowGraph, a: Args, ctx: EditContext): string {
  void g;
  void a;
  if (ctx.autoBind === undefined) {
    throw new FlowEditError("这个调用方没有接自动绑定通道，暂时自动绑不了。");
  }
  const n = ctx.autoBind();
  return n > 0
    ? `自动绑定完成：新增 ${n} 处对象↔环节关联（只补空的，人工绑过的不动）。`
    : "自动绑定跑完：没有可补的（都绑过了，或对象名在环节名里对不上）。";
}

interface OpSpec {
  /** Python 侧的内部函数名 —— 它出现在 TypeError 文案里，会被念给用户听。 */
  fnName: string;
  required: readonly string[];
  optional: readonly string[];
  run: (g: FlowGraph, a: Args, ctx: EditContext) => string;
}

const OPS: Record<string, OpSpec> = {
  rename_node: {
    fnName: "_op_rename_node",
    required: ["node", "label"],
    optional: [],
    run: opRenameNode,
  },
  set_actor: { fnName: "_op_set_actor", required: ["node", "actor"], optional: [], run: opSetActor },
  bind_objects: {
    fnName: "_op_bind_objects",
    required: ["node", "objects"],
    optional: [],
    run: opBindObjects,
  },
  set_stage: { fnName: "_op_set_stage", required: ["node", "stage"], optional: [], run: opSetStage },
  add_node: {
    fnName: "_op_add_node",
    required: ["kind", "label"],
    optional: ["stage", "actor"],
    run: opAddNode,
  },
  apply_patch: {
    fnName: "_op_apply_patch",
    required: [],
    optional: ["stages", "nodes", "edges"],
    run: opApplyPatch,
  },
  add_event: {
    fnName: "_op_add_event",
    required: ["label"],
    optional: ["stage", "producer", "actor"],
    run: opAddEvent,
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
  remove_node: {
    fnName: "_op_remove_node",
    required: ["node"],
    optional: ["confirm"],
    run: opRemoveNode,
  },
  set_branch_label: {
    fnName: "_op_set_branch_label",
    required: ["source", "target", "label"],
    optional: [],
    run: opSetBranchLabel,
  },
  set_kind: { fnName: "_op_set_kind", required: ["node", "kind"], optional: [], run: opSetKind },
  unbind_objects: {
    fnName: "_op_unbind_objects",
    required: ["node", "objects"],
    optional: [],
    run: opUnbindObjects,
  },
  rename_stage: {
    fnName: "_op_rename_stage",
    required: ["stage", "title"],
    optional: [],
    run: opRenameStage,
  },
  reorder_stages: {
    fnName: "_op_reorder_stages",
    required: ["order"],
    optional: [],
    run: opReorderStages,
  },
  set_node_status: {
    fnName: "_op_set_node_status",
    required: ["node", "status"],
    optional: [],
    run: opSetNodeStatus,
  },
  set_workflow: {
    fnName: "_op_set_workflow",
    required: ["workflow", "entry", "exits"],
    optional: ["title", "description"],
    run: opSetWorkflow,
  },
  remove_workflow: {
    fnName: "_op_remove_workflow",
    required: ["workflow"],
    optional: [],
    run: opRemoveWorkflow,
  },
  bind_auto: { fnName: "_op_bind_auto", required: [], optional: [], run: opBindAuto },
  set_edge_kind: {
    fnName: "_op_set_edge_kind",
    required: ["source", "target", "kind"],
    optional: ["label"],
    run: opSetEdgeKind,
  },
};

/** 可用的编辑操作名。给上层做 schema / 提示用，别再手抄一份。 */
export const FLOW_EDIT_OPS: readonly string[] = Object.keys(OPS);

/** 每个 op 认的关键字全集。同 `OIR_EDIT_OP_KEYS` —— flow 侧现在是对的，
 * 导出它是**防退化**：契约测试盯着，将来加 op 忘了同步 schema 会当场红。 */
export const FLOW_EDIT_OP_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(OPS).map(([op, spec]) => [op, [...spec.required, ...spec.optional]]),
  ),
);

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
export function applyFlowEdit(
  g: FlowGraph,
  op: string,
  args: Args,
  opts: FlowEditOptions = {},
): string {
  const spec = OPS[op];
  if (spec === undefined) {
    throw new FlowEditError(`不支持的流图编辑 ${op}。支持：${pyList(pySorted(Object.keys(OPS)))}`);
  }
  try {
    checkKwargs(spec, args);
    return spec.run(g, args, editContext(opts));
  } catch (exc) {
    // **只接 TypeError**。Python 侧的 `except TypeError` 不会接住 FlowEditError
    // （它是 ValueError），接多了会把"找不到节点"伪装成"你参数写错了"。
    if (exc instanceof PyTypeError) {
      throw new FlowEditError(`${op} 的参数不对：${exc.message}`);
    }
    throw exc;
  }
}
