/**
 * 流程模型 —— Workflow / Action / Event / Gateway。移植自
 * `src/ontocopilot/onto/flow.py`，由 `golden/flow.json` +
 * `golden/pipeline.flow.json`（真材料跑出来的那张图）钉住。
 *
 * 这一层是产品重心的落点。OIR 原来的六个容器（对象/属性/关系/行动/规则/问题）
 * 描述的是**静态结构**：有什么东西、它们长什么样。但 FDE 拿到一堆流程说明文档时，
 * 他真正要搞清楚的是**动态过程**：谁在什么时候做了什么、做完之后发生了什么、
 * 什么情况下走另一条路。这两件事用同一套容器表达不了。
 *
 * 目标产物是一张这样的图：
 *
 *     阶段一｜集采计划编制与审批
 *       〔EVENT〕集采计划编制已发起 ──▶ 〔ACTION〕编制集采计划 ──▶ 〔EVENT〕集采计划已生成
 *         ──▶ 〔ACTION〕审批集采计划 ──▶ ◇集采计划审批结果 ──通过──▶ 〔EVENT〕已通过
 *                                                     └──驳回──▶ 〔EVENT〕已驳回 ──▶ 回到编制
 *
 * 几条贯穿整个模块的设计判断：
 *
 * **Action 和 Event 是两种节点，不是一种。** 合成一种（"步骤"）会让图立刻失去信息：
 * "提交采购计划"和"采购计划已提交"在时间上差一个瞬间，在责任上差一整个系统边界 ——
 * 前者是有人要做的事，后者是做完之后别人能观测到的事实。下游要按 Event 挂监听、
 * 按 Action 挂权限，混在一起两边都挂不上。
 *
 * **每条边都要能回答"凭什么"。** 从流程文档里抽出来的边有出处；为了让图连通而补的
 * 边没有。**草稿图上必须一眼看得出哪些是补的** —— 一张分不清哪里是猜的流程图，
 * 比没有图更危险，因为它看起来同样确定。
 *
 * **编号由规则生成，不让模型编。** `ACT-CP-DRAFT` / `EVT-CP-PLANNING-REQUESTED`
 * 这种编号是下游系统的锚点，模型每次生成都会漂移一点，而漂移的编号意味着两版图
 * 之间没法做 diff。
 *
 * ── 移植时钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. `label[:4]` / `sha256(cn)[:4]` / `snippet[:300]` 按 **code point** 切；
 *     标签几乎全是中文，按 UTF-16 切会把动词判据整个搞错。
 *  2. `int(st.get("order", 0))` 会对非数字字符串抛 ValueError —— 照抛，不静默变 NaN：
 *     NaN 的 order 会让泳道排序变成实现细节。
 *  3. `flow_from_dict` 里 `n["kind"]` 缺键抛的是 **KeyError**（只 catch 了
 *     ValueError），照抛。
 */

import { sha256Hex } from "../kernel/ids.js";
import {
  Origin,
  Status,
  assertionToDict,
  inferred,
  makeProvenance,
  makeRid,
  parseOrigin,
  provToDict,
  type Assertion,
  type Provenance,
} from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片（oir.ts 里的同名函数是私有的，等它导出后收敛）
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。`[]` / `{}` / `""` / `0` 在 Python 里全是假。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(x)`。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** `float(x)`。不可转换的照抛，绝不静默变成 NaN 混进 confidence。 */
function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (!Number.isNaN(n) || /^nan$/i.test(v.trim())) return n;
  }
  throw new TypeError(`float() 接不了 ${JSON.stringify(v)}`);
}

/** `int(x)`。float 向零截断（`int(-2.9) === -2`，不是 `Math.floor`），
 * 字符串只接受整数字面量 —— `int("3.5")` 在 Python 侧是 ValueError。 */
function pyInt(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`int() 接不了 ${v}`);
    return Math.trunc(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[+-]?\d+$/.test(t)) return Number(t);
    throw new Error(`invalid literal for int(): ${JSON.stringify(v)}`);
  }
  throw new TypeError(`int() 接不了 ${JSON.stringify(v)}`);
}

/** Python 的 `d.get(k)`：键不存在给 None。JS 的 undefined 一律归一成 null。 */
function g(d: Record<string, unknown>, k: string): unknown {
  const v = d[k];
  return v === undefined ? null : v;
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `for x in data.get(k, ())`。非序列在 Python 侧是 TypeError，照抛 —— 一份
 * 结构不对的 flow.json 静默丢掉半张图，比崩掉难查一百倍。 */
function rowsOf(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  throw new TypeError(`不可迭代：${JSON.stringify(v)}`);
}

/** `s[:n]` 按 code point 切。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// ══════════════════════════════════════════════════════════════════
//  节点 / 边 / 泳道 / 业务流
// ══════════════════════════════════════════════════════════════════

/** 流程图上的节点类型。颜色与形状由它决定。 */
export const NodeKind = {
  ACTION: "action", // 蓝色圆角矩形：有人/系统要做的一件事
  EVENT: "event", // 橙色圆角矩形：做完之后可观测的事实
  GATEWAY: "gateway", // 黄色菱形：分叉点，出边带条件
  TERMINAL: "terminal", // 绿色矩形：终态或汇聚点
  EXTERNAL: "external", // 外部平台/接口，虚线框
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export function parseNodeKind(v: unknown): NodeKind {
  for (const x of Object.values(NodeKind)) if (x === v) return x;
  throw new RangeError(`'${pyStr(v)}' is not a valid NodeKind`);
}

/** 边的类型。虚线和实线的区别不是好看，是**可信度**。 */
export const EdgeKind = {
  FLOW: "flow", // 实线：材料里写明的顺序
  CONDITIONAL: "cond", // 实线带标签：网关的一条出边
  COMPENSATE: "comp", // 紫色：逆向补偿/撤销路径
  EXTERNAL: "external", // 虚线：跨系统调用，或延伸设计
  INFERRED: "inferred", // 虚线灰：**我们补的**，材料里没有直接依据
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export function parseEdgeKind(v: unknown): EdgeKind {
  for (const x of Object.values(EdgeKind)) if (x === v) return x;
  throw new RangeError(`'${pyStr(v)}' is not a valid EdgeKind`);
}

/** 流程图上的一个节点。纯数据 —— 要 JSON 往返，所以不是 class。 */
export interface FlowNode {
  rid: string;
  kind: NodeKind;
  /** 人读的名字，中文。图上显示的就是它。 */
  label: Assertion<string>;
  /** 机器编号，如 `ACT-CP-DRAFT`。下游系统按它挂钩子，**必须稳定**。 */
  code: string;
  /** 所属阶段（泳道）。 */
  stage: string;
  /** 承担这一步的角色。Action 才有意义。 */
  actor: Assertion<string>;
  /** 关联的业务对象 rid —— 把流程图和实体模型接起来。 */
  objects: string[];
  /** 外部系统节点专用：调的是哪个平台的什么接口。 */
  endpoint: string;
  status: Status;
}

/** 必填字段照原样，其余可省 —— 对应 Python dataclass 的默认值。 */
type Init<T, R extends keyof T> = Pick<T, R> & Partial<Omit<T, R>>;

export function makeFlowNode(p: Init<FlowNode, "rid" | "kind" | "label">): FlowNode {
  return {
    rid: p.rid,
    kind: p.kind,
    label: p.label,
    code: p.code ?? "",
    stage: p.stage ?? "",
    actor: p.actor ?? inferred(""),
    // 每次新数组，别共享引用：attach_endpoints 会往 objects 里 push。
    objects: [...(p.objects ?? [])],
    endpoint: p.endpoint ?? "",
    status: p.status ?? Status.CANDIDATE,
  };
}

/** 这个节点有没有材料依据。没有的要在图上标出来。 */
export function nodeGrounded(n: FlowNode): boolean {
  return n.label.evidence.length > 0;
}

export function nodeToDict(n: FlowNode): Record<string, unknown> {
  return {
    rid: n.rid,
    kind: n.kind,
    code: n.code,
    label: assertionToDict(n.label),
    stage: n.stage,
    actor: assertionToDict(n.actor),
    objects: n.objects,
    endpoint: n.endpoint,
    status: n.status,
    grounded: nodeGrounded(n),
  };
}

/** 一条边。 */
export interface FlowEdge {
  rid: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** 条件标签，如"通过"/"驳回"。网关的出边必须有。 */
  label: string;
  evidence: Provenance[];
}

export function makeFlowEdge(p: Init<FlowEdge, "rid" | "source" | "target">): FlowEdge {
  return {
    rid: p.rid,
    source: p.source,
    target: p.target,
    kind: p.kind ?? EdgeKind.FLOW,
    label: p.label ?? "",
    evidence: [...(p.evidence ?? [])],
  };
}

export function edgeGrounded(e: FlowEdge): boolean {
  return e.evidence.length > 0;
}

export function edgeToDict(e: FlowEdge): Record<string, unknown> {
  return {
    rid: e.rid,
    from: e.source,
    to: e.target,
    kind: e.kind,
    label: e.label,
    grounded: edgeGrounded(e),
    // 只印前三条 —— 产物是给人看的，第四条之后没人翻。
    evidence: e.evidence.slice(0, 3).map(provToDict),
  };
}

/** 一个阶段 = 图上的一条泳道。 */
export interface Stage {
  key: string;
  title: string; // 阶段一｜集采计划编制与审批
  subtitle: string; // 泳道标题下面那行小字
  order: number;
}

export function makeStage(p: Init<Stage, "key" | "title">): Stage {
  return { key: p.key, title: p.title, subtitle: p.subtitle ?? "", order: p.order ?? 0 };
}

export function stageToDict(s: Stage): Record<string, unknown> {
  return { key: s.key, title: s.title, subtitle: s.subtitle, order: s.order };
}

/** 一条完整的业务流。
 *
 * 和 Stage 是两个维度：一条 Workflow 可以横跨多个阶段（采购计划从编制一路走到
 * 寻源），一个阶段里也可以有多条 Workflow 并行。图上泳道按 Stage 分，
 * 而 Workflow 是"从这里出发能走到哪"的追踪单位。 */
export interface Workflow {
  key: string;
  title: string;
  entry: string; // 入口节点 rid
  exits: string[];
  description: string;
}

export function makeWorkflow(p: Init<Workflow, "key" | "title">): Workflow {
  return {
    key: p.key,
    title: p.title,
    entry: p.entry ?? "",
    exits: [...(p.exits ?? [])],
    description: p.description ?? "",
  };
}

export function workflowToDict(w: Workflow): Record<string, unknown> {
  return {
    key: w.key,
    title: w.title,
    entry: w.entry,
    exits: w.exits,
    description: w.description,
  };
}

// ══════════════════════════════════════════════════════════════════
//  编号
// ══════════════════════════════════════════════════════════════════
/** 常见业务域的短码。命中不了就从名字里生成，**永远不问模型** ——
 * 编号是下游系统的锚点，模型每次生成都会漂一点，而漂移的编号意味着两版图
 * 之间没法 diff。
 *
 * 用数组而不是对象：**顺序即优先级**（"集采计划"排在"采购需求计划"前面，
 * 所以「集采计划编制」拿 CP 而不是 PBP），对象字面量的键序是引擎行为，不该赌。 */
const DOMAIN_CODES: ReadonlyArray<readonly [string, string]> = [
  ["集采计划", "CP"],
  ["采购需求计划", "PBP"],
  ["采购执行计划", "EP"],
  ["采购申请", "PR"],
  ["采购包", "PKG"],
  ["采购合同", "CT"],
  ["库存", "INV"],
  ["预算", "BDG"],
  ["寻源", "SRC"],
  ["供应商", "SUP"],
  ["跟踪", "TRK"],
  ["预警", "ALM"],
  ["报告", "RPT"],
  ["审批", "APR"],
];

/** Action 的动词短码。中文动词 → 英文，图上编号才读得懂。 */
const VERB_CODES: ReadonlyArray<readonly [string, string]> = [
  ["编制", "DRAFT"],
  ["创建", "CREATE"],
  ["新建", "CREATE"],
  ["生成", "GENERATE"],
  ["提交", "SUBMIT"],
  ["审批", "APPROVE"],
  ["审核", "REVIEW"],
  ["确认", "CONFIRM"],
  ["驳回", "REJECT"],
  ["修改", "UPDATE"],
  ["变更", "CHANGE"],
  ["取消", "CANCEL"],
  ["作废", "VOID"],
  ["关闭", "CLOSE"],
  ["分配", "ALLOCATE"],
  ["拆分", "SPLIT"],
  ["合并", "MERGE"],
  ["导入", "IMPORT"],
  ["导出", "EXPORT"],
  ["同步", "SYNC"],
  ["调拨", "TRANSFER"],
  ["占用", "RESERVE"],
  ["释放", "RELEASE"],
  ["发布", "PUBLISH"],
  ["升级", "ESCALATE"],
  ["查询", "QUERY"],
  ["监控", "MONITOR"],
  ["评估", "ASSESS"],
];

// Python 的 `[一-鿿]` 就是 U+4E00–U+9FFF（CJK 统一表意基本区）。
const CN_RE = /[一-鿿]+/gu;

/** 从一段中文里认出业务域短码。认不出返回空串 —— 不瞎编。 */
export function domainCode(text: string): string {
  for (const [name, code] of DOMAIN_CODES) if (text.includes(name)) return code;
  return "";
}

function verbCode(text: string): string {
  // `text[:4]` 是 code point 切片：中文标签里按 UTF-16 切会多切一个字。
  const head4 = sliceCodePoints(text, 4);
  for (const [verb, code] of VERB_CODES) {
    if (text.startsWith(verb) || head4.includes(verb)) return code;
  }
  return "";
}

/** 事件名 → 编号后缀。事件是**已经发生的事**，编号也该读起来像
 * （`EVT-CP-PLANNING-REQUESTED`），而不是一串哈希。
 * 顺序即优先级：先匹配到的赢，所以更具体的排在前面。 */
const EVENT_CODES: ReadonlyArray<readonly [string, string]> = [
  ["编制已发起", "PLANNING-REQUESTED"],
  ["已发起", "REQUESTED"],
  ["已生成", "GENERATED"],
  ["已创建", "CREATED"],
  ["已提交", "SUBMITTED"],
  ["已通过", "APPROVED"],
  ["已批准", "APPROVED"],
  ["已驳回", "REJECTED"],
  ["已拒绝", "REJECTED"],
  ["已取消", "CANCELLED"],
  ["已作废", "VOIDED"],
  ["已关闭", "CLOSED"],
  ["已修改", "CHANGED"],
  ["已变更", "CHANGED"],
  ["已分配", "ALLOCATED"],
  ["已拆分", "SPLIT"],
  ["已合并", "MERGED"],
  ["已完成", "COMPLETED"],
  ["已失败", "FAILED"],
  ["已超时", "TIMEOUT"],
  ["已发布", "PUBLISHED"],
  ["已升级", "ESCALATED"],
  ["已确认", "CONFIRMED"],
  ["已占用", "RESERVED"],
  ["已释放", "RELEASED"],
  ["已入池", "POOLED"],
  ["已中止", "ABORTED"],
  ["已生效", "EFFECTIVE"],
  ["已归档", "ARCHIVED"],
  ["已检测", "DETECTED"],
  ["已触发", "TRIGGERED"],
];

/** 从事件名末尾认出状态词。认不出返回空 —— 兜底交给上层，不在这里编。 */
function eventCode(text: string): string {
  for (const [cn, code] of EVENT_CODES) if (text.includes(cn)) return code;
  return "";
}

const CODE_PREFIX: Record<NodeKind, string> = {
  [NodeKind.ACTION]: "ACT",
  [NodeKind.EVENT]: "EVT",
  [NodeKind.GATEWAY]: "GW",
  [NodeKind.TERMINAL]: "END",
  [NodeKind.EXTERNAL]: "EXT",
};

/**
 * 给一个节点生成稳定编号。
 *
 * `ACT-CP-DRAFT` / `EVT-CP-PLANNING-REQUESTED` 这种形态。规则生成而不是
 * 让模型编：同一个节点在两次运行里必须得到同一个编号，否则两版图之间没法
 * 做 diff，而 diff 恰恰是这个工具第二轮之后的主要价值。
 *
 * @param taken 已用编号。撞号时加数字后缀 —— 撞号会让下游的钩子挂错节点。
 */
export function codeFor(
  kind: NodeKind,
  label: string,
  opts: { stageHint?: string; taken?: ReadonlySet<string> | null } = {},
): string {
  const stageHint = opts.stageHint ?? "";
  const taken = opts.taken ?? null;
  const prefix = CODE_PREFIX[kind];
  const dom = domainCode(label) || domainCode(stageHint) || "GEN";

  let tail = kind === NodeKind.EVENT ? eventCode(label) : verbCode(label);
  if (!tail) {
    // 认不出语义就用**内容哈希**，不是 Python 的 hash() ——
    // 后者带进程随机盐，同一个节点每次启动都会拿到不同编号，
    // 两版图之间的 diff 直接全红。
    const cn = (label.match(CN_RE) ?? []).join("") || label;
    tail = sha256Hex(cn).slice(0, 4).toUpperCase();
  }

  const code = `${prefix}-${dom}-${tail}`;
  if (taken === null || !taken.has(code)) return code;
  let i = 2;
  while (taken.has(`${code}-${i}`)) i += 1;
  return `${code}-${i}`;
}

// ══════════════════════════════════════════════════════════════════
//  图
// ══════════════════════════════════════════════════════════════════

/** 一个项目的完整流程图。
 *
 * 四个容器用 `Map` 而不是普通对象：Python 的 dict 保插入序，而 JS 普通对象对
 * 整数样式的键会重排 —— BPMN 的 element id 完全可能是纯数字。 */
export class FlowGraph {
  readonly nodes: Map<string, FlowNode>;
  readonly edges: Map<string, FlowEdge>;
  readonly stages: Map<string, Stage>;
  readonly workflows: Map<string, Workflow>;

  constructor(
    init: {
      nodes?: Map<string, FlowNode>;
      edges?: Map<string, FlowEdge>;
      stages?: Map<string, Stage>;
      workflows?: Map<string, Workflow>;
    } = {},
  ) {
    this.nodes = init.nodes ?? new Map();
    this.edges = init.edges ?? new Map();
    this.stages = init.stages ?? new Map();
    this.workflows = init.workflows ?? new Map();
  }

  // ── 构建 ────────────────────────────────────────────────────
  addNode(n: FlowNode): FlowNode {
    if (!n.code) {
      const taken = new Set<string>();
      for (const x of this.nodes.values()) taken.add(x.code);
      n.code = codeFor(n.kind, n.label.value, { stageHint: n.stage, taken });
    }
    this.nodes.set(n.rid, n);
    return n;
  }

  addEdge(e: FlowEdge): FlowEdge {
    this.edges.set(e.rid, e);
    return e;
  }

  connect(
    src: string,
    dst: string,
    opts: { kind?: EdgeKind; label?: string; evidence?: readonly Provenance[] | null } = {},
  ): FlowEdge {
    const label = opts.label ?? "";
    return this.addEdge(
      makeFlowEdge({
        rid: makeRid("fe", `${src}->${dst}:${label}`),
        source: src,
        target: dst,
        kind: opts.kind ?? EdgeKind.FLOW,
        label,
        evidence: [...(opts.evidence ?? [])],
      }),
    );
  }

  // ── 查询 ────────────────────────────────────────────────────
  outEdges(rid: string): FlowEdge[] {
    return [...this.edges.values()].filter((e) => e.source === rid);
  }

  inEdges(rid: string): FlowEdge[] {
    return [...this.edges.values()].filter((e) => e.target === rid);
  }

  /** 按泳道分组。（Python 的 docstring 说"泳道内按 order"，但代码没排 ——
   * 照实迁，不顺手"修好"：排了就和 Python 的产物 diff 不上。） */
  byStage(): Map<string, FlowNode[]> {
    const out = new Map<string, FlowNode[]>();
    for (const n of this.nodes.values()) {
      const k = n.stage || "未分阶段";
      const bucket = out.get(k);
      if (bucket) bucket.push(n);
      else out.set(k, [n]);
    }
    return out;
  }

  // ── 规模化 ──────────────────────────────────────────────────
  /**
   * 只留主干：有材料依据的节点和边。
   *
   * 47 个 Action + 101 个 Event 全画出来会边全交叉、字全重叠 —— 一张看不清
   * 的图和没有图一样没用。主干视图砍掉两类噪声：**推断出来的边**（我们补的，
   * 本就不确定）和**只连着推断边的孤立节点**。保留的是"材料明确写了顺序"的
   * 那条骨架，客户第一眼要看的就是它。
   *
   * 返回一个新图，不改原图 —— 完整图仍然可查，只是默认先给主干。
   */
  mainPath(): FlowGraph {
    const keepEdges = [...this.edges.values()].filter(edgeGrounded);
    const touched = new Set<string>();
    for (const e of keepEdges) {
      touched.add(e.source);
      touched.add(e.target);
    }
    // 浅拷贝：Stage / Workflow 对象与原图共享，和 Python 的 dict(...) 一致。
    const sub = new FlowGraph({
      stages: new Map(this.stages),
      workflows: new Map(this.workflows),
    });
    for (const [rid, n] of this.nodes) {
      // 保留：连在有依据的边上的，或本身有依据且不是纯散文叶子的
      if (touched.has(rid) || (nodeGrounded(n) && n.kind !== NodeKind.TERMINAL)) {
        sub.nodes.set(rid, n);
      }
    }
    for (const e of keepEdges) {
      if (sub.nodes.has(e.source) && sub.nodes.has(e.target)) sub.edges.set(e.rid, e);
    }
    return sub;
  }

  // ── 体检 ────────────────────────────────────────────────────
  /** 既没有入边也没有出边的节点 —— 抽出来了但没接上，多半是漏了边。 */
  dangling(): FlowNode[] {
    return [...this.nodes.values()].filter(
      (n) => this.inEdges(n.rid).length === 0 && this.outEdges(n.rid).length === 0,
    );
  }

  /** 有入边、没出边、又不是终态 —— 流程在这里断了。
   *
   * 这是流程图上最容易被忽略的错误：图看起来是连的，但顺着走会走进死胡同，
   * 而那往往意味着材料里少了一段。 */
  deadEnds(): FlowNode[] {
    return [...this.nodes.values()].filter(
      (n) =>
        n.kind !== NodeKind.TERMINAL &&
        this.inEdges(n.rid).length > 0 &&
        this.outEdges(n.rid).length === 0,
    );
  }

  /** 网关的出边没有条件标签 —— 看图的人不知道什么时候走哪条。 */
  unlabeledBranches(): FlowNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.kind === NodeKind.GATEWAY && this.outEdges(n.rid).some((e) => !e.label),
    );
  }

  /** 做了一件事却没有任何可观测的结果 —— 下游没法挂监听。 */
  actionsWithoutEvents(): FlowNode[] {
    const out: FlowNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.kind !== NodeKind.ACTION) continue;
      const hasEvent = this.outEdges(n.rid).some((e) => {
        // Python 的兜底是 `self.nodes.get(target, FlowNode("", EVENT, ...))` ——
        // **目标节点不存在时按 EVENT 算**，于是这个 Action 被判成"有事件"。
        // 看着像 bug，但它是既定行为：改了两边的体检数字就对不上。
        const t = this.nodes.get(e.target);
        return (t ? t.kind : NodeKind.EVENT) === NodeKind.EVENT;
      });
      if (!hasEvent) out.push(n);
    }
    return out;
  }

  /**
   * 结构病灶：一份**能给客户看**的流程图必须过的几条。
   *
   * 与上面那几个体检方法的关系：`dangling` / `deadEnds` 各回答一个具体问题，
   * 这里把"这张图现在能不能交出去"合成一句话。判据全部可规则化，所以一条模型
   * 调用都不花（ADR-5；而且 Huang et al. ICLR'24 说明这类结构判断交给模型自省
   * 反而会掉点）。
   *
   * 返回空数组 = 结构上没问题。非空时每条都写清**缺什么、缺在哪几个节点上**，
   * 让模型能据此改对，而不是收到一句"图不合格"。
   */
  structureDefects(): string[] {
    const out: string[] = [];
    const name = (n: FlowNode): string => n.label.value || n.code;
    if (this.nodes.size === 0) return ["一个环节都没有。"];
    if (this.edges.size === 0) {
      out.push(
        `${this.nodes.size} 个环节之间一条连线都没有 —— 流程图的顺序全在边上，` +
          "没有边就只是一张名词表。",
      );
    }
    const dangling = this.dangling();
    if (dangling.length > 0) {
      out.push(
        `${dangling.length} 个环节既没有上一步也没有下一步：` +
          `${dangling.slice(0, 6).map(name).join("、")}。`,
      );
    }
    const unstaged = [...this.nodes.values()].filter((n) => !n.stage);
    if (unstaged.length > 0) {
      out.push(
        `${unstaged.length} 个环节没有归到任何阶段：${unstaged.slice(0, 6).map(name).join("、")}。`,
      );
    }
    const unlabeled = this.unlabeledBranches();
    if (unlabeled.length > 0) {
      out.push(
        `${unlabeled.length} 个分叉点的出边没写条件：${unlabeled.slice(0, 6).map(name).join("、")}。` +
          "看图的人不知道什么时候走哪条。",
      );
    }
    // 事件必须有产生它的一步 —— 否则编译成 OntologyPackage 时 producer 是 unknown
    const orphanEvents = [...this.nodes.values()].filter(
      (n) => n.kind === NodeKind.EVENT && this.inEdges(n.rid).length === 0,
    );
    if (orphanEvents.length > 0) {
      out.push(
        `${orphanEvents.length} 个事件没有产生它的动作：` +
          `${orphanEvents.slice(0, 6).map(name).join("、")}。`,
      );
    }
    const seen = new Map<string, number>();
    for (const n of this.nodes.values()) {
      const key = name(n).trim();
      if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    if (dup.length > 0) out.push(`环节重名：${dup.slice(0, 6).join("、")}。`);
    return out;
  }

  stats(): Record<string, number> {
    const kinds: Record<string, number> = {};
    for (const k of Object.values(NodeKind)) kinds[k] = 0;
    for (const n of this.nodes.values()) {
      if (!(n.kind in kinds)) throw new Error(`KeyError: ${pyStr(n.kind)}`);
      kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    }
    let inferredEdges = 0;
    for (const e of this.edges.values()) if (!edgeGrounded(e)) inferredEdges += 1;
    return {
      stages: this.stages.size,
      workflows: this.workflows.size,
      actions: kinds[NodeKind.ACTION] ?? 0,
      events: kinds[NodeKind.EVENT] ?? 0,
      gateways: kinds[NodeKind.GATEWAY] ?? 0,
      terminals: kinds[NodeKind.TERMINAL] ?? 0,
      externals: kinds[NodeKind.EXTERNAL] ?? 0,
      edges: this.edges.size,
      // 有多少是我们补的 —— 这个数字直接决定这张图能不能拿去跟客户对
      inferred_edges: inferredEdges,
      dangling: this.dangling().length,
      dead_ends: this.deadEnds().length,
    };
  }

  toDict(): Record<string, unknown> {
    // Python 的 sorted 是稳定排序，JS 的 Array.sort 自 ES2019 起同样稳定。
    const stages = [...this.stages.values()].sort((a, b) => a.order - b.order);
    return {
      stages: stages.map(stageToDict),
      workflows: [...this.workflows.values()].map(workflowToDict),
      nodes: [...this.nodes.values()].map(nodeToDict),
      edges: [...this.edges.values()].map(edgeToDict),
      stats: this.stats(),
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  反序列化
// ══════════════════════════════════════════════════════════════════

function provFromDict(d: unknown): Provenance {
  // Python 是 `d.get(...)`：不是 dict 就 AttributeError。照抛 —— 静默产出一条
  // 空 Provenance 等于凭空捏造出处。
  if (!isPlainDict(d)) throw new TypeError(`evidence 里不是对象：${JSON.stringify(d)}`);
  const loc = g(d, "locator");
  if (!(loc === null || isPlainDict(loc))) {
    // Python 的 `dict(x)`：字符串/数字当场炸。
    throw new TypeError(`locator 不是对象：${JSON.stringify(loc)}`);
  }
  return makeProvenance(
    pyTruthy(g(d, "file_id")) ? pyStr(g(d, "file_id")) : "",
    pyTruthy(g(d, "file_name")) ? pyStr(g(d, "file_name")) : "",
    loc === null ? {} : { ...loc },
    {
      snippet: pyTruthy(g(d, "snippet")) ? pyStr(g(d, "snippet")) : "",
      extractor: pyTruthy(g(d, "extractor")) ? pyStr(g(d, "extractor")) : "llm",
      // `or 0.5`：明确写成 0 的 confidence 会被当成"没填"落回 0.5。
      // 看着像 bug，是 Python 侧的既定行为，改了两边产物就 diff 不上。
      confidence: pyTruthy(g(d, "confidence")) ? pyFloat(g(d, "confidence")) : 0.5,
    },
  );
}

function assertFromDict(d: unknown): Assertion<unknown> {
  if (!isPlainDict(d)) return inferred(d === undefined ? null : d);
  let origin: Origin;
  try {
    origin = parseOrigin(pyTruthy(g(d, "origin")) ? pyStr(g(d, "origin")) : "inferred");
  } catch {
    origin = Origin.INFERRED;
  }
  return {
    value: g(d, "value"),
    origin,
    evidence: rowsOf(g(d, "evidence")).map(provFromDict),
    // 默认 0.5 而不是 inferred() 的 0.4 —— Python 这里直接构造 Assertion，
    // 没走工厂。
    confidence: pyTruthy(g(d, "confidence")) ? pyFloat(g(d, "confidence")) : 0.5,
  };
}

function dictRow(v: unknown, what: string): Record<string, unknown> {
  if (!isPlainDict(v)) throw new TypeError(`${what}: 行不是对象 ${JSON.stringify(v)}`);
  return v;
}

/** `x.get(k, "")`：只有键缺失才给空串。null 在 Python 侧会原样留在字段里
 * （然后 to_dict 印出 null），TS 这里的字段类型是 string，统一收敛成空串 ——
 * 与 `oir.ts` 的 `str0` 同一处**有意的分叉**，只影响脏输入的产物形态。 */
function str0(d: Record<string, unknown>, k: string): string {
  return d[k] === undefined || d[k] === null ? "" : pyStr(d[k]);
}

/**
 * 从 `FlowGraph.toDict()` 还原。
 *
 * 恢复会话时要用 —— `_flow` 是活对象，重启后没了，只剩磁盘上的 flow.json。
 * 不还原它，对话里「改流程图」就无从下手。溯源要原样还原：人工加的节点
 * （extractor=human）和材料抽的、系统推断的，三者在图上区分开，降级成 inferred
 * 会让这个区分消失。
 *
 * **注意 status 存不住**：`toDict` 印了 status，这里不读，还原出来一律是
 * CANDIDATE。照实迁 —— 补上会让 TS 的产物和 Python 的对不上。
 */
/** status 的宽容解析：老数据没写、或写了认不出的，一律 candidate ——
 *  反序列化是恢复路径，在这里炸等于旧会话打不开。 */
function parseStatusSoft(v: unknown): Status {
  const s = typeof v === "string" ? v : "";
  return (Object.values(Status) as string[]).includes(s) ? (s as Status) : Status.CANDIDATE;
}

export function flowFromDict(data: Record<string, unknown>): FlowGraph {
  const graph = new FlowGraph();
  for (const raw of rowsOf(g(data, "stages"))) {
    const st = dictRow(raw, "stages");
    if (st["key"] === undefined) throw new Error("KeyError: key");
    const key = pyStr(st["key"]);
    graph.stages.set(
      key,
      makeStage({
        key,
        title: str0(st, "title"),
        subtitle: str0(st, "subtitle"),
        order: pyInt(st["order"] === undefined ? 0 : st["order"]),
      }),
    );
  }
  for (const raw of rowsOf(g(data, "workflows"))) {
    const w = dictRow(raw, "workflows");
    if (w["key"] === undefined) throw new Error("KeyError: key");
    const key = pyStr(w["key"]);
    graph.workflows.set(
      key,
      makeWorkflow({
        key,
        title: str0(w, "title"),
        entry: str0(w, "entry"),
        exits: rowsOf(g(w, "exits")).map(pyStr),
        description: str0(w, "description"),
      }),
    );
  }
  for (const raw of rowsOf(g(data, "nodes"))) {
    const n = dictRow(raw, "nodes");
    if (n["rid"] === undefined) throw new Error("KeyError: rid");
    // `n["kind"]` 缺键抛的是 KeyError —— Python 只 catch 了 ValueError。
    if (n["kind"] === undefined) throw new Error("KeyError: kind");
    let kind: NodeKind;
    try {
      kind = parseNodeKind(n["kind"]);
    } catch {
      kind = NodeKind.ACTION;
    }
    const node = makeFlowNode({
      rid: pyStr(n["rid"]),
      kind,
      label: assertFromDict(g(n, "label")) as Assertion<string>,
      code: str0(n, "code"),
      stage: str0(n, "stage"),
      actor: assertFromDict(g(n, "actor")) as Assertion<string>,
      // 只收 rid 形（`<kind>_<slug>`）。历史会话里落过原始标签串甚至裸换行符
      // （flow_extract 的旧写法，见那里的注释），读回来照样会让 autoBindObjects
      // 把这些节点当作"已绑过"跳过。在反序列化这一处过滤，老会话一加载就自愈。
      objects: rowsOf(g(n, "objects")).map(pyStr).filter((o) => /^[a-z]+_/u.test(o)),
      endpoint: str0(n, "endpoint"),
      // A10 修复：status 原本「to_dict 印、from_dict 不读」（照迁 Python 的死字段，
      // 一次往返归零）。Python 侧已退役，而这个字段是流程侧 rejected 软删路径
      // （set_node_status + 删除守卫）的地基 —— 有意翻转。认不出的值落回 candidate。
      status: parseStatusSoft(n["status"]),
    });
    graph.nodes.set(node.rid, node);
  }
  for (const raw of rowsOf(g(data, "edges"))) {
    const e = dictRow(raw, "edges");
    if (e["rid"] === undefined) throw new Error("KeyError: rid");
    if (e["kind"] === undefined) throw new Error("KeyError: kind");
    let kind: EdgeKind;
    try {
      kind = parseEdgeKind(e["kind"]);
    } catch {
      kind = EdgeKind.FLOW;
    }
    const rid = pyStr(e["rid"]);
    graph.edges.set(
      rid,
      makeFlowEdge({
        rid,
        source: str0(e, "from"),
        target: str0(e, "to"),
        kind,
        label: str0(e, "label"),
        evidence: rowsOf(g(e, "evidence")).map(provFromDict),
      }),
    );
  }
  return graph;
}
