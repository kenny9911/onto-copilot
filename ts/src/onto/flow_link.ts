/**
 * 把流程图和接口清单接起来。移植自 `src/ontocopilot/onto/flow_link.py`，
 * 由 `golden/flow.json` 钉住（真材料的 `pipeline.flow.json` + `pipeline.oir.json`
 * 端到端跑一遍，外加合成材料补分支）。
 *
 * 这两样东西以前是**两份互不相干的产物**：
 *
 *     流程图     17 个节点，「创建采购需求计划」「审批采购执行计划」…… 全是中文动作名
 *     动作清单   112 行接口，createPbp / cancelOpenPbp / queryPoHeader …… 全是接口码
 *
 * 于是图上看不出哪一步真的有系统支撑，接口清单里也看不出这个接口落在流程的哪一环。
 * 而这正是 ERP 顾问拿到材料后第一件要做的事：把流程和系统能力对上，找出**流程里有
 * 但系统里没有**的环节。
 *
 * 接法是两级都靠证据，不靠名字相似：
 *
 *     宿主对象   步骤名去掉动词前缀 → 匹配对象的中文名或别名 → 对象 rid
 *     动词       步骤名的动词前缀、接口码里的动词段 → 归一到同一套动词码
 *
 * 两级都命中才算数。只对上宿主不看动词的话，「取消采购需求计划」会挂到 createPbp
 * 上 —— 同一个单据上动词不同就是两回事，挂错比不挂糟得多。
 *
 * 接完之后剩下的两类缺口才是真正值钱的：
 *
 *   · 流程里有、接口清单里没有 → 「这一步在系统里由谁来做？」
 *   · 接口是写操作、却不在流程的任何一步里 → 「这个接口属于流程的哪一环？」
 *
 * 最后是 {@link flowFromActions}：材料里**只有接口清单、没有一段流程说明**时，
 * 按"同一个单据上 create → submit → approve → cancel"的生命周期出一张接口视角的
 * 草图。顺序是推的，所以边一律画虚线 —— 分不清哪里是猜的流程图比没有图更危险。
 */

import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  makeFlowNode,
  makeStage,
  type FlowNode,
} from "./flow.js";
import {
  extracted,
  inferred,
  makeProvenance,
  makeRid,
  type ActionType,
  type OIR,
  type Provenance,
} from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** Python 的真值判断。`[]` / `{}` / `""` / `0` 在 Python 里全是假。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python 的 `str(x or "")`：`None` / `0` / `""` / 空容器全部落到右边。 */
function pyOrStr(v: unknown): string {
  return pyTruthy(v) ? pyStr(v) : "";
}

/** Python 的 `sorted()` / `<` 按 code point 比字符串；JS 默认 sort 按 UTF-16
 * code unit。BMP 内一致，CJK 扩展 B（U+20000 以上的生僻字）才分叉 —— 而
 * 客户材料里的生僻字（垚、堃、玥）恰恰不少。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0) as number;
    const cb = rb.value.codePointAt(0) as number;
    if (ca !== cb) return ca - cb;
  }
}

const ASCII_RE = /^[\x00-\x7F]*$/;

function isAscii(s: string): boolean {
  return ASCII_RE.test(s);
}

/** `str.strip(chars)`：两端剥掉集合里的任意字符（按 code point）。 */
function stripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i] as string)) i += 1;
  while (j > i && set.has(cps[j - 1] as string)) j -= 1;
  return cps.slice(i, j).join("");
}

/** `a.source_endpoint.value or {}`。非空的非 dict 在 Python 侧会在 `.get`
 * 那里 AttributeError —— 照抛，不静默当成空 endpoint。 */
function endpointOf(a: ActionType): Record<string, unknown> {
  const v: unknown = a.sourceEndpoint.value;
  if (v === null || v === undefined || v === false || v === "" || v === 0) return {};
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (Array.isArray(v) && v.length === 0) return {};
  throw new TypeError(`sourceEndpoint.value 不是 dict：${JSON.stringify(v)}`);
}

/** `d.get(k)`：缺键给 None。 */
function get(d: Record<string, unknown>, k: string): unknown {
  const v = d[k];
  return v === undefined ? null : v;
}

// ══════════════════════════════════════════════════════════════════
//  动词归一
// ══════════════════════════════════════════════════════════════════
/** 中英文动词 → 同一套动词码。两边都要归一，否则「创建」和 `create` 对不上。
 *
 * 顺序即优先级，**长的写在前面**：`cancelOpenPbp` 里既有 `cancel` 也有
 * `open`，先匹配到 cancel 才是对的。 */
const VERBS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["APPROVE", ["审批", "审核", "批准", "核准", "approve", "audit", "verify"]],
  ["SUBMIT", ["提交", "上报", "报送", "submit", "commit"]],
  [
    "CREATE",
    ["创建", "新建", "编制", "新增", "录入", "登记", "create", "add", "insert", "new",
      "save", "register"],
  ],
  [
    "UPDATE",
    ["修改", "变更", "调整", "更新", "维护", "update", "edit", "modify", "change", "amend"],
  ],
  ["CANCEL", ["取消", "作废", "撤销", "终止", "cancel", "void", "abort", "revoke", "subtract"]],
  ["DELETE", ["删除", "移除", "delete", "remove", "drop"]],
  ["CLOSE", ["关闭", "结束", "完结", "close", "finish", "complete"]],
  ["ALLOCATE", ["分配", "下达", "派发", "指派", "allocate", "assign", "dispatch", "distribute"]],
  ["SPLIT", ["拆分", "拆包", "split"]],
  ["MERGE", ["合并", "汇总", "merge", "combine"]],
  ["PUBLISH", ["发布", "下发", "publish", "release"]],
  ["IMPORT", ["导入", "import", "upload"]],
  ["EXPORT", ["导出", "下载", "export", "download"]],
  ["SYNC", ["同步", "推送", "sync", "push"]],
  ["RESERVE", ["预留", "占用", "锁定", "reserve", "lock", "hold"]],
  [
    "QUERY",
    ["查询", "查看", "检索", "获取", "query", "get", "list", "search", "find", "fetch",
      "detail", "page", "view", "read", "open"],
  ],
];

/** 只读动词。它们不改数据，**不属于流程的任何一步** —— 把 60 个查询接口画进
 * 流程图只会把真正的环节淹掉，为它们逐个造"这一步在哪"的问题更是纯噪声。 */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["QUERY", "EXPORT"]);

/** 动词码 → 给业务方看的中文。动词码是内部对齐用的，出现在问卷上就等于要求
 * 对方先学一遍我们的词表。 */
const VERB_CN: Readonly<Record<string, string>> = {
  APPROVE: "审批",
  SUBMIT: "提交",
  CREATE: "创建",
  UPDATE: "修改",
  CANCEL: "取消",
  DELETE: "删除",
  CLOSE: "关闭",
  ALLOCATE: "分配",
  SPLIT: "拆分",
  MERGE: "合并",
  PUBLISH: "发布",
  IMPORT: "导入",
  EXPORT: "导出",
  SYNC: "同步",
  RESERVE: "预留",
  QUERY: "查询",
};

/** 一个单据的生命周期顺序。接口视角建图时按它排先后 —— 这不是业务规则，
 * 是"先有单据才谈得上审批、审批完才谈得上取消"这种时序常识，所以边标成推断。 */
export const LIFECYCLE: readonly string[] = [
  "CREATE", "IMPORT", "UPDATE", "SUBMIT", "APPROVE", "PUBLISH", "ALLOCATE",
  "SPLIT", "MERGE", "RESERVE", "SYNC", "CANCEL", "DELETE", "CLOSE",
];

/** 中文动词，按**长的优先**排。正则的分支是最左匹配，短的排前面会先咬住。
 * （Python 的 sorted 与 JS 的 Array.sort 都是稳定排序，等长的保持原序。） */
const CN_VERBS: readonly string[] = VERBS.flatMap(([, ws]) => ws)
  .filter((w) => !isAscii(w))
  .slice()
  .sort((a, b) => [...b].length - [...a].length);

/** 动作词在名字**两端**都可能出现：材料里既写「创建采购包」也写「采购包分配」。
 * 只认前缀的话，后一种全部认不出动词，于是整个环节被判成"缺接口"。 */
const ACTION_PREFIX = new RegExp("^(?:" + CN_VERBS.join("|") + ")", "u");
// Python 的 `$` 还会匹配"结尾换行之前"，JS 不会 —— 但这里的输入都先 strip 过，
// 尾部换行到不了这一步。
const ACTION_SUFFIX = new RegExp("(?:" + CN_VERBS.join("|") + ")$", "u");

/** 名字尾巴上的补充说明：「创建采购申请单（立项）」处理的单据是采购申请单。
 * 不剥掉它，宿主对象就永远匹配不上。 */
const ASIDE = /[（(][^（()）]*[）)]\s*$/u;

const CAMEL = /[A-Z][a-z]*|[a-z]+/g;

/**
 * 从中文动作名或英文接口码里认出动词。认不出返回空串 —— 不瞎猜。
 *
 * 英文按驼峰切段，**只看第一段**：`createPbp` 的动词是 create，而
 * `queryPoApproveHistory` 的动词是 query 不是 approve —— 它查的是审批历史，
 * 不是执行审批。只扫关键词而不看位置，这条会挂错。
 */
export function canonicalVerb(text: unknown): string {
  const t = pyOrStr(text).trim();
  if (!t) return "";
  if (isAscii(t)) {
    const parts = t.match(CAMEL);
    const head = (parts && parts.length > 0 ? (parts[0] as string) : t).toLowerCase();
    for (const [code, words] of VERBS) {
      if (words.some((w) => isAscii(w) && (head === w || head.startsWith(w)))) return code;
    }
    return "";
  }
  const head = t.replace(ASIDE, "");
  for (const [code, words] of VERBS) {
    if (words.some((w) => !isAscii(w) && head.startsWith(w))) return code;
  }
  // 动词在后面：「采购包分配」「采购需求计划审批」。前缀没命中才看后缀 ——
  // 反过来会让「审批采购需求计划」被结尾的「计划」之类误伤。
  for (const [code, words] of VERBS) {
    if (words.some((w) => !isAscii(w) && head.endsWith(w))) return code;
  }
  return "";
}

/** 步骤名去掉动词和括号补充，剩下的就是它处理的单据。
 *
 * （Python 侧是私有的 `_subject`；这里导出只是为了让 golden 能逐条钉住它 ——
 * 宿主认错整条流程就挂到错的对象上，值得单独有测试。） */
export function subjectOf(label: unknown): string {
  let t = pyOrStr(label).replace(ASIDE, "").trim();
  t = t.replace(ACTION_PREFIX, "");
  t = t.replace(ACTION_SUFFIX, "");
  return stripChars(t, "（）() 　");
}

// ══════════════════════════════════════════════════════════════════
//  接上去
// ══════════════════════════════════════════════════════════════════

/** 接的结果。缺口分析全部从这里读，不再第二次遍历图。 */
export interface LinkReport {
  /** 节点 rid → 挂上的行动 rid 列表 */
  readonly matched: Map<string, string[]>;
  /** 找到了宿主对象、但那个对象上没有对应动词的接口：(rid, 步骤名, 宿主 rid) */
  readonly unmatchedNodes: Array<readonly [string, string, string]>;
  /** 连宿主对象都没对上的节点：(rid, 步骤名) */
  readonly unresolvedNodes: Array<readonly [string, string]>;
  /** 已经被某个节点用掉的行动 rid */
  readonly usedActions: Set<string>;
}

export function makeLinkReport(): LinkReport {
  return {
    matched: new Map(),
    unmatchedNodes: [],
    unresolvedNodes: [],
    usedActions: new Set(),
  };
}

export function linkReportSummary(r: LinkReport): Record<string, number> {
  return {
    接上接口的环节: r.matched.size,
    有单据但缺接口的环节: r.unmatchedNodes.length,
    认不出单据的环节: r.unresolvedNodes.length,
    用到的接口: r.usedActions.size,
  };
}

/** 中文名 / 别名 → 对象 rid。行动表和流程说明之间只有中文名对得上。 */
function hostIndex(oir: OIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rid, o] of oir.objects) {
    for (const name of [o.displayName.value, ...o.aliases]) {
      const n = pyOrStr(name).trim();
      if (n && !out.has(n)) out.set(n, rid);
    }
  }
  return out;
}

/** 步骤处理的单据 → 对象 rid。
 *
 * 先精确，再**唯一**的包含匹配。命中多个说明这个名字有歧义，宁可挂空 ——
 * 挂空会变成一个反问，挂错会把接口标在错误的环节上。 */
function resolveHost(subject: string, hosts: Map<string, string>): string | null {
  if (!subject) return null;
  const hit = hosts.get(subject);
  if (hit) return hit;
  const near = new Set<string>();
  for (const [name, rid] of hosts) {
    if (name.includes(subject) || subject.includes(name)) near.add(rid);
  }
  return near.size === 1 ? ([...near][0] as string) : null;
}

/**
 * 给流程图上的每个 ACTION 节点挂上实现它的接口。就地改图，返回接的结果。
 *
 * @param maxPerNode 一个环节最多标几个接口。标满一屏没人看得完，
 *   而"有没有系统支撑"这个问题第一个接口就回答了。
 */
export function attachEndpoints(
  g: FlowGraph,
  oir: OIR,
  opts: { maxPerNode?: number } = {},
): LinkReport {
  const maxPerNode = opts.maxPerNode ?? 3;
  const report = makeLinkReport();
  const hosts = hostIndex(oir);
  // 行动按 (宿主, 动词) 建索引。112 个行动 × 17 个节点全表扫是浪费，
  // 更重要的是索引让"同一个宿主上有哪些动词"这个问题一次就能答。
  // （Python 侧还建了一份 by_host 索引，建完之后没有任何地方读它 —— 死代码，
  //  不迁。）
  const byHostVerb = new Map<string, Map<string, ActionType[]>>();
  for (const a of oir.actions.values()) {
    const verb =
      canonicalVerb(a.apiName.value) || canonicalVerb(get(endpointOf(a), "display") ?? "");
    for (const host of a.appliesTo) {
      let byVerb = byHostVerb.get(host);
      if (!byVerb) {
        byVerb = new Map();
        byHostVerb.set(host, byVerb);
      }
      const bucket = byVerb.get(verb);
      if (bucket) bucket.push(a);
      else byVerb.set(verb, [a]);
    }
  }

  for (const [rid, n] of g.nodes) {
    if (n.kind !== NodeKind.ACTION) continue;
    const label = n.label.value;
    const host = resolveHost(subjectOf(label), hosts);
    if (host === null) {
      report.unresolvedNodes.push([rid, label]);
      continue;
    }
    if (!n.objects.includes(host)) n.objects.push(host);
    const verb = canonicalVerb(label);
    const hits = verb ? (byHostVerb.get(host)?.get(verb) ?? []) : [];
    if (hits.length === 0) {
      report.unmatchedNodes.push([rid, label, host]);
      continue;
    }
    const picked = hits.slice(0, maxPerNode);
    // 节点上写**路径**不写接口码：路径是实际调用的东西，接口码只是个名字。
    n.endpoint = picked
      .map((a) => pyStr(pyOrStr(get(endpointOf(a), "path")) || a.apiName.value))
      .join("　");
    report.matched.set(
      rid,
      picked.map((a) => a.rid),
    );
    for (const a of picked) report.usedActions.add(a.rid);
  }
  return report;
}

// ══════════════════════════════════════════════════════════════════
//  缺口 → 问题
// ══════════════════════════════════════════════════════════════════

/**
 * 一处缺口。转成 `OpenQuestion` 之前的中间形态。
 *
 * **规范定义住在 `onto/gaps.py` 的 `Gap`**（连同 `to_question()`）。那个模块
 * 这一轮还没迁到 TS，所以这里先按 Python dataclass 逐字段给出同形结构；
 * `onto/gaps.ts` 落地后应当改成从那里 import，并把这个定义删掉。
 * 字段名和默认值都照 Python：`options` / `appliesTo` 的缺省是 `null` 而不是
 * `[]` —— 「没给选项」和「给了一个空选项表」在问卷渲染上是两回事。
 */
export interface Gap {
  text: string;
  group: string;
  kind: string;
  /** 出处。**尽量带真实 locator** —— 只有真 locator 才能在界面上点回原文高亮，
   * 把 cite 字符串塞进 raw.ref 只能渲染成一行文字。 */
  prov: Provenance | null;
  options: string[] | null;
  appliesTo: string[] | null;
  /** 排序权重。同类里数值大的先问。 */
  weight: number;
}

function makeGap(p: {
  text: string;
  group: string;
  kind: string;
  prov?: Provenance | null;
  weight?: number;
}): Gap {
  return {
    text: p.text,
    group: p.group,
    kind: p.kind,
    prov: p.prov ?? null,
    options: null,
    appliesTo: null,
    weight: p.weight ?? 1.0,
  };
}

function provOfAssertion(a: { evidence?: readonly Provenance[] } | null | undefined): Provenance | null {
  const ev = a?.evidence;
  return ev && ev.length > 0 ? (ev[0] as Provenance) : null;
}

/**
 * 接完之后剩下的两类缺口，转成能发给业务方的问题。
 *
 * 这是接起来之后**真正值钱的部分**：一张标着接口的流程图是好看，一份
 * "第 6 步没有任何系统支撑""这 4 个写接口不在流程里"的清单才是要拿去开会的。
 */
export function coverageGaps(
  report: LinkReport,
  oir: OIR,
  opts: { perKind?: number } = {},
): Gap[] {
  const perKind = opts.perKind ?? 8;
  const out: Gap[] = [];

  // 1. 流程里有、接口清单里没有
  for (const [, label, host] of report.unmatchedNodes.slice(0, perKind)) {
    const obj = oir.objects.get(host);
    // 报给业务方看的是**中文**。动词码是我们内部对齐用的，把 CANCEL/SPLIT
    // 直接摆到问卷上，等于让人先学一遍我们的词表再回答问题。
    const sibSet = new Set<string>();
    for (const a of oir.actions.values()) {
      if (!a.appliesTo.includes(host)) continue;
      const v = canonicalVerb(a.apiName.value);
      if (v) sibSet.add(VERB_CN[v] ?? v);
    }
    const siblings = [...sibSet].sort(cmpCodePoint);
    const middle =
      obj !== undefined && siblings.length > 0
        ? `材料里「${pyStr(obj.displayName.value)}」上只有` +
          `${siblings.slice(0, 6).join("、")}这几类接口，没有对应的。`
        : "材料的接口清单里找不到对应的接口。";
    out.push(
      makeGap({
        text: `「${label}」这一步在系统里由哪个接口完成？` + middle + "如果这一步是线下做的，请直接说明。",
        group: "流程与系统",
        kind: "step_without_api",
        prov: provOfAssertion(obj?.apiName),
        weight: 4.5,
      }),
    );
  }

  // 2. 写接口在流程里没有出现。**只算写接口** —— 查询接口不改数据，
  //    它本来就不属于流程的任何一步，为它造问题纯粹是噪声。
  //    注意这里只看 apiName，不像 attachEndpoints 那样回落到 sourceEndpoint.display：
  //    动词只能从 display 认出来的接口因此不会被当成孤儿。照实迁。
  const orphan: ActionType[] = [];
  for (const a of oir.actions.values()) {
    if (report.usedActions.has(a.rid)) continue;
    const v = canonicalVerb(a.apiName.value);
    if (v && !READ_ONLY_VERBS.has(v)) orphan.push(a);
  }
  for (const a of orphan.slice(0, perKind)) {
    const ep = endpointOf(a);
    // Python 是 `next((oir.objects.get(h) for h in applies_to), None)`：取的是
    // **第一个 h 的查找结果**，查不到就是 None —— 不会继续找第二个。
    const first = a.appliesTo.length > 0 ? oir.objects.get(a.appliesTo[0] as string) : undefined;
    const host = first ?? null;
    const display = get(ep, "display");
    out.push(
      makeGap({
        text:
          `接口「${pyStr(a.apiName.value)}」` +
          (pyTruthy(display) ? `（${pyStr(display)}）` : "") +
          "会改动数据，但它不在流程说明的任何一步里。" +
          (host !== null
            ? `它属于「${pyStr(host.displayName.value)}」的哪一环？`
            : "它属于流程的哪一环？"),
        group: "流程与系统",
        kind: "api_without_step",
        prov: provOfAssertion(a.apiName),
        weight: 3.5,
      }),
    );
  }
  if (orphan.length > perKind) {
    out.push(
      makeGap({
        text:
          `另有 ${orphan.length - perKind} 个写接口同样不在流程说明里，` +
          "完整清单见「动作清单」表。是不是还有一段流程没有提供？",
        group: "流程与系统",
        kind: "api_without_step_more",
        weight: 3.0,
      }),
    );
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  接口视角建图
// ══════════════════════════════════════════════════════════════════
/** 建接口视角时，一个宿主对象至少要有几个写接口才值得单独画一条泳道。
 * 只有一个 create 的对象画出来是一个孤零零的框，占地方不给信息。 */
const MIN_ACTIONS_PER_LANE = 2;

/** 动词 → 事件名。事件是**已经发生的事**，名字要读起来像一个事实。 */
const EVENT_NAME: Readonly<Record<string, string>> = {
  CREATE: "已创建",
  IMPORT: "已导入",
  UPDATE: "已修改",
  SUBMIT: "已提交",
  APPROVE: "已审批",
  PUBLISH: "已发布",
  ALLOCATE: "已分配",
  SPLIT: "已拆分",
  MERGE: "已合并",
  RESERVE: "已占用",
  SYNC: "已同步",
  CANCEL: "已取消",
  DELETE: "已删除",
  CLOSE: "已关闭",
};

/**
 * 从动作名里取资源名 —— 去掉动词段，剩下的就是它操作的东西。
 *
 * 为什么需要它：`eventNameOf` 原本在绑不到对象时一律兜底成字面量「单据」，
 * 于是一个只有接口清单的会话会得到一屏「单据已创建 / 单据已修改 / 单据已提交」
 * （真实库 d53cb63f7e18 就是 32 个这样的事件）。而 `CreatePurchaseRequisition`
 * 这个名字里本来就写着它操作的是什么。
 *
 * 判据是结构性的（切驼峰 / 切中文动词前后缀），不含任何业务词表 ——
 * 动词表 `VERBS` 是既有的、`canonicalVerb` 已经在用的那一份，不新增第二张。
 */
export function resourceNameOf(apiName: string): string {
  const t = pyOrStr(apiName).trim();
  if (!t) return "";

  if (isAscii(t)) {
    const parts = t.match(CAMEL);
    if (parts === null || parts.length === 0) return "";
    const head = (parts[0] as string).toLowerCase();
    // 首段是动词就丢掉它，否则整名都是资源
    const isVerbHead = [...VERBS].some(([, words]) =>
      words.some((w) => isAscii(w) && (head === w || head.startsWith(w))));
    const rest = isVerbHead ? parts.slice(1) : parts;
    return rest.join(" ");
  }

  const head = t.replace(ASIDE, "");
  for (const [, words] of VERBS) {
    for (const w of words) {
      if (isAscii(w)) continue;
      // 动词在前：「创建采购申请」
      if (head.startsWith(w)) return head.slice(w.length);
      // 动词在后：「采购需求计划审批」
      if (head.endsWith(w) && head.length > w.length) return head.slice(0, -w.length);
    }
  }
  return head;
}

function eventNameOf(
  verb: string,
  obj: { displayName: { value: string } } | undefined,
  apiName = "",
): string {
  // 绑上对象最好；绑不上就用动作名里写着的资源名；再取不出才落到「单据」。
  // 三级兜底，每一级都比上一级模糊，但都比"全都叫单据"强。
  const name = obj !== undefined
    ? pyStr(obj.displayName.value)
    : (resourceNameOf(apiName) || "单据");
  return `${name}${EVENT_NAME[verb] ?? "已处理"}`;
}

/**
 * 只有接口清单、没有流程说明时，出一张接口视角的流程草图。
 *
 * 以前这种材料的结果是 `flow.skipped`：一张图都没有。而 112 行接口里
 * "同一个单据上先 create 再 approve 再 cancel"这层先后关系本身就是一份可以
 * 拿去和客户对的草稿 —— 对的过程中他会立刻指出哪里不对，那比一张白纸有用得多。
 *
 * 三条纪律：
 *
 * * **节点有依据**：每个节点都来自接口清单里的一行，带原始出处；
 * * **边是推的**：顺序来自 {@link LIFECYCLE} 这层时序常识，不是材料写的，
 *   所以一律 `EdgeKind.INFERRED`（图上是虚线）；
 * * **只画写接口**：查询接口不改数据，画进去只会把真正的环节淹掉。
 *
 * @param maxLanes 最多画几条泳道。按接口数从多到少取 —— 接口最多的对象就是
 *   这份材料的主线。
 */
export function flowFromActions(
  oir: OIR,
  opts: { fileName?: string; maxLanes?: number } = {},
): FlowGraph {
  const fileName = opts.fileName ?? "";
  const maxLanes = opts.maxLanes ?? 12;
  const g = new FlowGraph();
  const lanes = new Map<string, Array<[string, ActionType]>>();
  for (const a of oir.actions.values()) {
    const verb =
      canonicalVerb(a.apiName.value) || canonicalVerb(get(endpointOf(a), "display") ?? "");
    if (!verb || READ_ONLY_VERBS.has(verb)) continue;
    const host = a.appliesTo.length > 0 ? (a.appliesTo[0] as string) : "";
    const bucket = lanes.get(host);
    if (bucket) bucket.push([verb, a]);
    else lanes.set(host, [[verb, a]]);
  }

  const ranked = [...lanes.entries()].sort((x, y) => {
    // Python 的 key 是 (-len, host)：先按接口数从多到少，同数按 rid 排。
    if (x[1].length !== y[1].length) return y[1].length - x[1].length;
    return cmpCodePoint(x[0], y[0]);
  });
  let order = 0;
  // 注意 max_lanes 的截断在**过滤之前**：只有一个接口的宿主照样占掉一个名额。
  for (const [host, items] of ranked.slice(0, maxLanes)) {
    if (items.length < MIN_ACTIONS_PER_LANE) continue;
    const obj = oir.objects.get(host);
    order += 1;
    const key = `api${order}`;
    g.stages.set(
      key,
      makeStage({
        key,
        order,
        title: obj !== undefined ? pyStr(obj.displayName.value) : "未归属接口",
        subtitle: "按接口清单推出的顺序，材料里没有写明，待人工确认",
      }),
    );
    items.sort((p, q) => {
      const ip = LIFECYCLE.indexOf(p[0]);
      const iq = LIFECYCLE.indexOf(q[0]);
      const a = ip < 0 ? 99 : ip;
      const b = iq < 0 ? 99 : iq;
      if (a !== b) return a - b;
      return cmpCodePoint(pyStr(p[1].apiName.value), pyStr(q[1].apiName.value));
    });
    let prevEvt: string | null = null;
    for (const [verb, a] of items) {
      const ep = endpointOf(a);
      const path = pyOrStr(get(ep, "path"));
      const prov: Provenance =
        provOfAssertion(a.apiName) ??
        makeProvenance("f", fileName, { kind: "raw", ref: a.apiName.value }, {
          snippet: path,
          extractor: "rule",
          confidence: 1.0,
        });
      const act: FlowNode = g.addNode(
        makeFlowNode({
          rid: makeRid("fn", `api_${pyStr(a.apiName.value)}`),
          kind: NodeKind.ACTION,
          stage: key,
          label: extracted(pyOrStr(get(ep, "display")) || pyStr(a.apiName.value), prov),
          actor: inferred(""),
          objects: host ? [host] : [],
          endpoint: path,
        }),
      );
      const evt: FlowNode = g.addNode(
        makeFlowNode({
          rid: makeRid("fn", `apievt_${pyStr(a.apiName.value)}`),
          kind: NodeKind.EVENT,
          stage: key,
          // 传 apiName：绑不到对象时用动作名里的资源名，别让整张图都叫「单据」
          label: extracted(eventNameOf(verb, obj, pyStr(a.apiName.value)), prov),
        }),
      );
      g.connect(act.rid, evt.rid, { evidence: [prov] });
      if (prevEvt) g.connect(prevEvt, act.rid, { kind: EdgeKind.INFERRED, label: "推断顺序" });
      prevEvt = evt.rid;
    }
  }
  return g;
}

// ══════════════════════════════════════════════════════════════════
//  对象 ↔ 流程节点的自动绑定（C2 前置）与流程侧依赖查询
// ══════════════════════════════════════════════════════════════════

/**
 * 按名字确定性补空绑定。实测真实库 11 个流程节点的 objects 全部为空 ——
 * 本体与流程之间的桥没搭，impact.trace 想看流程也连不过去。
 *
 * 规则（零模型、幂等）：
 *  · **只补空的**：人工绑过（bind_objects）或 BPMN 带来的绑定一概不动。
 *    注意 unbind 清到空之后，再显式跑 bind_auto 会重新补上 —— 要排除某个
 *    误绑，请 unbind 后手动绑上正确的那个，而不是留空；
 *  · 对象的 displayName / 别名（≥2 个码点）作为**子串**出现在节点 label 里即命中；
 *  · 一个节点最多绑 3 个，按名字长度降序取 —— 长名更具体（「采购订单」优先于「订单」）。
 */
export function autoBindObjects(g: FlowGraph, oir: OIR): number {
  const names: { name: string; rid: string }[] = [];
  for (const o of oir.objects.values()) {
    for (const name of [o.displayName.value, ...o.aliases]) {
      if ([...name].length >= 2) names.push({ name, rid: o.rid });
    }
  }
  // 长名优先；同长按 rid 稳定
  names.sort((a, b) => [...b.name].length - [...a.name].length || (a.rid < b.rid ? -1 : 1));
  let added = 0;
  for (const n of g.nodes.values()) {
    if (n.objects.length > 0) continue;
    const hits: string[] = [];
    for (const { name, rid } of names) {
      if (hits.length >= 3) break;
      if (hits.includes(rid)) continue;
      if (n.label.value.includes(name)) hits.push(rid);
    }
    if (hits.length > 0) {
      n.objects.push(...hits);
      added += hits.length;
    }
  }
  return added;
}

/** impact.trace 的流程侧一半：给一组对象 rid，返回绑着它们的节点（rid + 名字）。 */
export function flowDependents(
  g: FlowGraph,
  objectRids: readonly string[],
): { rid: string; label: string; via: string }[] {
  const want = new Set(objectRids);
  const out: { rid: string; label: string; via: string }[] = [];
  for (const n of g.nodes.values()) {
    const hit = n.objects.find((r) => want.has(r));
    if (hit !== undefined) out.push({ rid: n.rid, label: n.label.value, via: hit });
  }
  return out;
}
