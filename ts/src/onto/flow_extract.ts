/**
 * 从流程说明里抽出流图 —— 规则优先。移植自 `src/ontocopilot/onto/flow_extract.py`，
 * 由 `golden/flow_extract.json`（`tools/golden/flow_extract.py` 导出）钉住。
 *
 * 真实材料里的流程说明长这样（`实体梳理.xlsx!业务规则!A14`，一个合并单元格里
 * 塞六个节点）：
 *
 *     （1）编制集采计划：集中采购专业机构根据集采原则……编制集采计划
 *     触发条件：无（主要以集约化标准和框架到期日进行判断）；
 *     输入：集采计划编制策略及集采计划编制要求，无系统节点；
 *     输出：一级集采计划、二级集采计划、自定义集采计划；
 *     执行者：采购计划员
 *     （2）审核集采计划：对集采计划进行审批，以备注入采购需求计划；
 *     ……
 *
 * 这个格式**规则就能拆**，一行不丢。让模型去读它只有两个后果：为复述结构化文本
 * 付 Opus 的钱，以及它一定会在第十几个节点上开始漏。ADR-5 在这里的落点非常干净。
 *
 * 拆出来之后，四段各自有确定的去向：
 *
 *     动作名       →  ACTION 节点
 *     输出         →  EVENT 节点（"已审批集采计划" 就是一个事实）
 *     触发条件     →  入边的来源线索（"集采计划审批完成" 指向上一个节点的输出）
 *     执行者       →  ACTION 的 actor
 *
 * **边不能全靠猜。** 节点 N 的"输入/触发条件"里如果出现了节点 M 的"输出"原文，
 * 那条边有依据；接不上的地方按编号顺序补一条虚线，并标成推断 —— 图上一眼能
 * 看出哪里是我们连的。
 *
 * ── 移植时钉住的 Python/JS 分叉 ────────────────────────────────
 *
 * 这个模块几乎全是正则，而正则恰恰是两门语言差得最多的地方。四条分叉都会
 * **静默地少抽或多抽整个节点**，所以一条都没有放过（golden 里各有用例）：
 *
 *  1. **`\d`**：Python 的 str 模式匹配整个 Unicode Nd 类，`（１）编制集采计划`
 *     照样是一个节点头，`int("１")` 也照样是 1。JS 的 `\d` 只有 ASCII —— 照写
 *     会在中文 Excel 导出的全角编号材料上整段丢节点。这里一律用 `\p{Nd}`，
 *     取值走 {@link digitValue}。
 *  2. **`re.MULTILINE` 的 `^`**：Python 只在 `\n` 之后重新匹配，JS 的 `m` 标志
 *     把 `\r` / ` ` / ` ` 也算换行。用 `(?:^|(?<=\n))` 精确复刻 ——
 *     照 JS 写会在 CR 分隔的材料里凭空多认出一个节点头，把一段文字从中间劈开。
 *  3. **`\s`**：Python 多出 `\x1c-\x1f` 和 `\x85`，JS 多出 `﻿`。用 {@link SP}
 *     这个字符集显式拼进每条正则。
 *  4. **`$`**：Python 的 `$` 还匹配"最后一个 `\n` 之前"，JS 只匹配串尾。
 *     `_DONE` 里写成 `(?=\n?$)`。
 *
 * 另外所有 `len(...)` / `s[:n]` / `head[:-1]` 都按 **code point** 走：材料里的
 * 生僻姓氏地名住在 U+20000 区，按 UTF-16 数长度会让「40 字以内才算标题」这条
 * 判据在它们身上翻倍失效。
 */

import { makeRid, extracted, inferred, makeOpenQuestion, makeProvenance } from "./oir.js";
import type { OpenQuestion, Provenance } from "./oir.js";
import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  domainCode,
  makeFlowNode,
  makeStage,
  type FlowNode,
} from "./flow.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的 `\s`（str 模式）。比 JS 的 `\s` 多 `\x1c-\x1f` `\x85`，少 `﻿`。 */
const SP = " \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** 上面那一坨的字符类形态，直接拼进正则源码。 */
const S = `[${SP}]`;
/** `str.strip()` 剥的那批字符（== Python `str.isspace()`）。 */
const WS = new Set(
  [
    0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2000,
    0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
    0x2029, 0x202f, 0x205f, 0x3000,
  ].map((c) => String.fromCodePoint(c)),
);

/** `str.strip()`：两端剥 Unicode 空白。 */
function pyTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && WS.has(s[a]!)) a += 1;
  while (b > a && WS.has(s[b - 1]!)) b -= 1;
  return s.slice(a, b);
}

/** `str.strip(chars)`：两端剥指定字符集里的字符（**不是**剥前后缀串）。 */
function pyStrip(s: string, chars: string): string {
  const set = new Set([...chars]);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a]!)) a += 1;
  while (b > a && set.has(s[b - 1]!)) b -= 1;
  return s.slice(a, b);
}

/** `len(s)`：数 code point。 */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** `s[:n]`：按 code point 切。 */
function cpHead(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `s[:-1]`：按 code point 去掉最后一个字符。 */
function cpDropLast(s: string): string {
  const cps = [...s];
  return cps.slice(0, cps.length - 1).join("");
}

/** `str(x or "")`：`None` / `0` / `""` / 空容器全落到空串。 */
function pyStrOrEmpty(v: unknown): string {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return "";
  if (Array.isArray(v)) return v.length > 0 ? String(v) : "";
  return String(v);
}

const ND = /\p{Nd}/u;

/** 一个 Unicode 十进制数字的取值。Nd 类的每个区都是连续 10 个、前一个码位不是
 * Nd —— 靠这一条反推出本区的「零」。`int("１")` 在 Python 侧就是 1。 */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  for (let k = 0; k <= 9; k++) {
    const z = cp - k;
    if (!ND.test(String.fromCodePoint(z))) break;
    if (z === 0 || !ND.test(String.fromCodePoint(z - 1))) return k;
  }
  return Number.NaN;
}

/** `int(s)`，s 是一串 Unicode 十进制数字。 */
function pyIntDigits(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 10 + digitValue(ch);
  return n;
}

/** `re.split(pattern, s, maxsplit=1)` 在只有一个分隔符字符类时的形态。 */
function splitOnce(s: string, re: RegExp): [string] | [string, string] {
  const m = re.exec(s);
  if (m === null) return [s];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

// ══════════════════════════════════════════════════════════════════
//  拆解
// ══════════════════════════════════════════════════════════════════

/** 一个节点的开头：（1） / (1) / 1. / 1、
 *
 * 第二个分支的 `^` 是 `re.MULTILINE` 的 `^` —— 只跟在 `\n` 后面，`\r` 不算。 */
const STEP_HEAD_SRC =
  `[（(]${S}*(\\p{Nd}{1,3})${S}*[）)]${S}*` + `|(?:^|(?<=\\n))${S}*(\\p{Nd}{1,3})${S}*[.、]${S}*`;
const STEP_HEAD_G = new RegExp(STEP_HEAD_SRC, "gu");

/** 四个字段。「执行着」是材料里的错别字 —— 真实材料就是会有错别字，
 * 认不出它就会丢掉一整个节点的执行者。 */
const FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["trigger", ["触发条件", "触发时机", "触发"]],
  ["inputs", ["输入", "前置", "输入项"]],
  ["outputs", ["输出", "产出", "输出项"]],
  ["actor", ["执行者", "执行着", "责任人", "负责人", "角色"]],
];
// 交替分支的**顺序即优先级**（「触发条件」必须排在「触发」前面），照 Python 的
// 展开顺序拼，别换成 Set/对象。
const FIELD_SRC = `(${FIELDS.flatMap(([, ws]) => ws).join("|")})${S}*[:：]${S}*`;
const FIELD_RE = new RegExp(FIELD_SRC, "u");
const FIELD_RE_G = new RegExp(FIELD_SRC, "gu");

const COLON_RE = /[:：]/u;

/** 流程说明里的一个节点。纯数据 —— 要 JSON 往返，所以不是 class。 */
export interface ProcessStep {
  no: number;
  name: string;
  detail: string;
  trigger: string;
  inputs: string;
  outputs: string;
  actor: string;
  cite: string;
  fileName: string;
}

type Init<T, R extends keyof T> = Pick<T, R> & Partial<Omit<T, R>>;

export function makeProcessStep(p: Init<ProcessStep, "no" | "name">): ProcessStep {
  return {
    no: p.no,
    name: p.name,
    detail: p.detail ?? "",
    trigger: p.trigger ?? "",
    inputs: p.inputs ?? "",
    outputs: p.outputs ?? "",
    actor: p.actor ?? "",
    cite: p.cite ?? "",
    fileName: p.fileName ?? "",
  };
}

/** 线上形态是 snake_case（`file_name`），与 Python 的 `to_dict()` 逐字一致。 */
export function processStepToDict(s: ProcessStep): Record<string, unknown> {
  return {
    no: s.no,
    name: s.name,
    detail: s.detail,
    trigger: s.trigger,
    inputs: s.inputs,
    outputs: s.outputs,
    actor: s.actor,
    cite: s.cite,
    file_name: s.fileName,
  };
}

/**
 * 这段文字是不是流程说明。
 *
 * 判据是**结构**不是关键词：有编号节点、且节点里带「触发条件/输入/输出」这类
 * 字段。只看关键词的话，一句"本节说明采购流程"也会命中。
 */
export function looksLikeProcess(text: unknown): boolean {
  const t = pyStrOrEmpty(text);
  let heads = 0;
  for (const _ of t.matchAll(STEP_HEAD_G)) heads += 1;
  let fields = 0;
  for (const _ of t.matchAll(FIELD_RE_G)) fields += 1;
  return heads >= 2 && fields >= 2;
}

/** 把一个节点的正文按字段名切开。 */
function splitFields(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...body.matchAll(FIELD_RE_G)];
  if (marks.length === 0) return out;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const word = m[1]!;
    const entry = FIELDS.find(([, ws]) => ws.includes(word));
    if (entry === undefined) continue;
    const next = marks[i + 1];
    const end = next === undefined ? body.length : next.index;
    const val = pyStrip(pyTrim(body.slice(m.index + m[0].length, end)), "；;。\n ");
    // 同一个字段出现两次（材料里有），保留先出现的 —— 后面的多半是别的节点
    // 串进来的残留
    if (!out.has(entry[0])) out.set(entry[0], val);
  }
  return out;
}

/** 把一段流程说明拆成节点列表。一行不丢。 */
export function parseSteps(
  text: unknown,
  opts: { cite?: string; fileName?: string } = {},
): ProcessStep[] {
  const cite = opts.cite ?? "";
  const fileName = opts.fileName ?? "";
  const t = pyStrOrEmpty(text);
  const heads = [...t.matchAll(STEP_HEAD_G)];
  if (heads.length === 0) return [];
  const steps: ProcessStep[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    // `h.group(1) or h.group(2)`：两个分支只会命中一个
    const digits = h[1] !== undefined && h[1] !== "" ? h[1] : h[2]!;
    const no = pyIntDigits(digits);
    const start = h.index + h[0].length;
    const nxt = heads[i + 1];
    const end = nxt === undefined ? t.length : nxt.index;
    const chunk = pyTrim(t.slice(start, end));

    // 首行是「动作名：说明」；冒号后面才是说明
    const firstBreak = FIELD_RE.exec(chunk);
    const headPart = firstBreak === null ? chunk : chunk.slice(0, firstBreak.index);
    const rest = firstBreak === null ? "" : chunk.slice(firstBreak.index);
    // re.split 带 maxsplit 只返回两段，不是三段 —— 用 partition 语义更清楚
    const parts = splitOnce(headPart, COLON_RE);
    const name = parts.length === 2 ? parts[0] : headPart;
    const detail = parts.length === 2 ? parts[1] : "";
    const f = splitFields(rest);
    steps.push(
      makeProcessStep({
        no,
        name: pyStrip(pyTrim(name), "；;。\n "),
        detail: cpHead(pyStrip(pyTrim(detail), "；;。\n "), 300),
        trigger: f.get("trigger") ?? "",
        inputs: f.get("inputs") ?? "",
        outputs: f.get("outputs") ?? "",
        actor: f.get("actor") ?? "",
        cite,
        fileName,
      }),
    );
  }
  return steps;
}

// ══════════════════════════════════════════════════════════════════
//  建图
// ══════════════════════════════════════════════════════════════════
/** 一个"输出"里可能列了好几个东西（"一级集采计划、二级集采计划、自定义集采计划"）。
 * 拆开之后每个都是独立事实，但**图上只画第一个** —— 三个并列的产物画三个
 * EVENT 会让图爆炸，而它们在流程上是同一个节拍。 */
const SPLIT_RE = new RegExp(`[、,，;；]|\\p{Nd}[）)]${S}*`, "u");

/** 事件名的规范化：材料里写"已审批采购需求计划"，这本身就是事件名，直接用。
 * 写"采购申请单"这种纯名词的，补一个"已生成"。
 *
 * `$` 写成 `(?=\n?$)` —— Python 的 `$` 还匹配"最后一个换行之前"。 */
const DONE_RE = /^(已|未)|(完成|生成|创建|提交|审批|取消|作废|删除|分配)(?=\n?$)/u;

function eventName(raw: string): string {
  const t = pyStrip(pyTrim(raw), "；;。 ");
  if (!t) return "";
  if (DONE_RE.test(t)) return t;
  return `${t}已生成`;
}

const NORM_RE = new RegExp(`[的了个条份项${SP}]`, "gu");

/** 比对用的规范化：去掉修饰词，只留核心名词。
 *
 * "已审批集采计划" 和 "已审批的集采计划" 要能对上 —— 边的连通性全靠这个匹配，
 * 太严就连不上、太松就乱连。 */
function norm(s: string): string {
  return s.replace(NORM_RE, "");
}

/** 没有任何阶段依据时，所有节点落进这一条泳道。它**必须被注册**，否则画出来是
 * 一条标题写着内部 key 的空白泳道 —— 真实材料上 50 个节点里有 49 个是这样的。 */
export const MAIN_STAGE = "main";

/**
 * 保证兜底泳道**存在于 g.stages 里**，返回它的 key。
 *
 * 以前各处只是把节点的 stage 字段填成 `"main"`，而 "main" 从来没被注册过 ——
 * 渲染时 `g.stages.get(key)` 拿到 None，泳道标题就直接印出内部 key。真实材料上
 * 50 个节点里有 49 个落在这条无名泳道里。
 */
function ensureMain(g: FlowGraph): string {
  if (!g.stages.has(MAIN_STAGE)) {
    g.stages.set(
      MAIN_STAGE,
      makeStage({
        key: MAIN_STAGE,
        order: g.stages.size + 1,
        title: "其它环节",
        subtitle: "材料里没有说明这些环节属于哪个阶段",
      }),
    );
  }
  return MAIN_STAGE;
}

/**
 * 给"只有一串 cite 字符串"的来源建出处。
 *
 * `cite` 通常已经是 `文件名!表名!R14-14` 这种完整引用。直接把它塞进
 * `locator.ref`，渲染出来会变成 `文件名#文件名!表名!R14-14` —— 文件名出现两次，
 * 看着像 bug，点进去也定位不到。所以这里先把开头那截文件名剥掉。
 */
function rawProv(fileName: string, cite: string, snippet: string): Provenance {
  let ref = pyStrOrEmpty(cite);
  for (const sep of ["!", "#"]) {
    const head = `${fileName}${sep}`;
    if (fileName && ref.startsWith(head)) {
      ref = ref.slice(head.length);
      break;
    }
  }
  return makeProvenance(
    "f",
    fileName,
    { kind: "raw", ref: ref || "未标注位置" },
    { snippet: cpHead(snippet, 200), extractor: "rule", confidence: 1.0 },
  );
}

/**
 * 把节点列表建成流图。
 *
 * @param opts.stages 节点号 → 阶段 key。材料里没有阶段划分，得由上层给（问卷的
 *   「节点」列、或者人工划）。不给就全放一条泳道。
 */
export function buildFlow(
  steps: readonly ProcessStep[],
  opts: {
    stages?: ReadonlyMap<number, string> | null;
    fileName?: string;
    graph?: FlowGraph | null;
  } = {},
): FlowGraph {
  const g = opts.graph ?? new FlowGraph();
  const fileName = opts.fileName ?? "";
  const stages = opts.stages ?? new Map<number, string>();
  if (steps.some((st) => !stages.has(st.no))) ensureMain(g);
  // 每个节点产出的事件，供后面按"输出↔触发条件"接边
  const produced: Array<[string, string, number]> = []; // (规范化名, 事件 rid, 节点号)

  for (const st of steps) {
    const sourceFile = st.fileName || fileName;
    const prov = rawProv(sourceFile, st.cite, `（${st.no}）${st.name}：${st.detail}`);
    const stage = stages.get(st.no) ?? MAIN_STAGE;
    const act = g.addNode(
      makeFlowNode({
        rid: makeRid("fn", `act${st.no}_${st.name}`),
        kind: NodeKind.ACTION,
        stage,
        label: extracted(st.name, prov),
        actor: st.actor ? extracted(st.actor, prov) : inferred(""),
      }),
    );

    // 输出 → 事件。**只取第一个** —— 并列产物是同一个节拍。
    const outs = st.outputs.split(SPLIT_RE).filter((x) => pyTrim(x) !== "");
    const first = outs[0];
    if (first !== undefined) {
      const ename = eventName(first);
      const evt = g.addNode(
        makeFlowNode({
          rid: makeRid("fn", `evt${st.no}_${ename}`),
          kind: NodeKind.EVENT,
          stage,
          label: extracted(ename, prov),
        }),
      );
      g.connect(act.rid, evt.rid, { evidence: [prov] });
      produced.push([norm(ename), evt.rid, st.no]);
      for (const extra of outs.slice(1, 3)) {
        // 其余产物记在事件的 objects 上，不单独画节点
        evt.objects.push(pyTrim(extra));
      }
    }
  }

  // ── 接边 ────────────────────────────────────────────────────
  // 节点 N 的触发条件/输入里出现了节点 M 的产出 → 这条边有依据。
  for (const st of steps) {
    const actRid = makeRid("fn", `act${st.no}_${st.name}`);
    if (!g.nodes.has(actRid)) continue;
    const clue = norm(`${st.trigger} ${st.inputs}`);
    const hits = produced.filter(
      ([name, , no]) => no !== st.no && name !== "" && clue.includes(name),
    );
    const prov = rawProv(
      st.fileName || fileName,
      st.cite,
      `触发条件：${st.trigger}｜输入：${st.inputs}`,
    );
    for (const [, rid] of hits.slice(0, 2)) g.connect(rid, actRid, { evidence: [prov] });
  }

  // 接不上的按编号顺序补一条虚线，标成推断。**不补的话图是散的，
  // 补了不标的话人分不清哪里是我们连的** —— 后者更糟。
  const byNo = new Map<number, ProcessStep>();
  for (const st of steps) byNo.set(st.no, st);
  for (const st of [...steps].sort((a, b) => a.no - b.no)) {
    const actRid = makeRid("fn", `act${st.no}_${st.name}`);
    if (!g.nodes.has(actRid) || g.inEdges(actRid).length > 0) continue;
    const prev = byNo.get(st.no - 1);
    if (prev === undefined) continue;
    const prevEvt = produced.find(([, , no]) => no === prev.no)?.[1];
    if (prevEvt !== undefined) {
      g.connect(prevEvt, actRid, { kind: EdgeKind.INFERRED, label: "推断顺序" });
    }
  }
  return g;
}

/**
 * 把「阶段名 → 节点号列表」变成泳道定义。
 *
 * 材料里**没有**阶段划分 —— 它只给了 17 个连续编号的节点。阶段是人（或问卷的
 * 「节点」分组）划出来的，所以这里接受外部输入而不是自己猜。猜阶段会让整张图
 * 的骨架建立在一个没人确认过的判断上。
 *
 * 参数收的是 `[标题, 节点号]` 的**可迭代**（Map / 数组都行）：Python 的 dict
 * 保插入序，而 JS 普通对象对整数样式的键会重排 —— 阶段标题是中文不会踩到，
 * 但顺序在这里决定 `s1`/`s2`，不值得赌。
 */
export function stagesFromGroups(
  groups: Iterable<readonly [string, readonly number[]]>,
  graph: FlowGraph | null = null,
): [FlowGraph, Map<number, string>] {
  const g = graph ?? new FlowGraph();
  const mapping = new Map<number, string>();
  let i = 0;
  for (const [title, nos] of groups) {
    i += 1;
    const key = `s${i}`;
    g.stages.set(key, makeStage({ key, order: i, title }));
    for (const no of nos) mapping.set(no, key);
  }
  return [g, mapping];
}

/** 问卷「节点」列里的 `（N）xxx`。这是节点到阶段的**权威归属** —— 客户自己
 * 就是按这个分组讨论的，比我们按编号切分强得多。
 *
 * `(.+)` 写成 `[^\n]+`：Python 的 `.` 不匹配 `\n` 但**匹配 `\r`**，JS 的 `.`
 * 连 `\r` 一起排除。 */
const SURVEY_NODE_RE = new RegExp(`^[（(]${S}*(\\p{Nd}{1,3})${S}*[）)]${S}*([^\\n]+)`, "u");

/** 节点标签有多长。问卷「节点」列里写的是`（1）编制集采计划`这种**标题**；
 * 一个合并单元格里塞着 17 个节点全文的那种 700 字段落不是标题。
 * 真实事故：那 700 字被当成节点 1 的名字，整张图于是只有一个阶段、标题是半段
 * 说明文，另外 16 个节点全落进一条没注册的泳道。 */
const NODE_LABEL_MAX = 40;

/** 「业务场景一：采购执行计划创建（重点覆盖节点6—10）」这类场景标题。
 *
 * 编号**三种写法都要认**：中文数字、阿拉伯数字、全角数字。只认中文数字的版本
 * 在写「业务场景1」的材料上一个场景都抽不到，于是整张图退回到"按编号每 4 个
 * 切一刀"，阶段标题全是系统编的 —— 而客户明明已经把场景划好写在那儿了。 */
const SCENE_SRC =
  `业务场景${S}*(?<no>[一二三四五六七八九十]+|\\p{Nd}{1,2}|[０-９]{1,2})${S}*[:：]?${S}*` +
  `(?<name>[^（(\\n]*)` +
  `(?:[（(]${S}*(?:重点覆盖)?节点${S}*(?<lo>\\p{Nd}+)${S}*[—\\-~到至]${S}*(?<hi>\\p{Nd}+))?`;
const SCENE_RE = new RegExp(SCENE_SRC, "u");

/**
 * 从一行/一列单元格里读出场景标题。
 *
 * 场景编号和场景名常常**分在两个单元格**（A 列写「业务场景1」，B 列写
 * 「采购执行计划创建」）。只读第一列就只剩一串没有名字的编号，做出来的泳道
 * 标题是「业务场景1」——对着这张图开会的人不知道它指什么。
 *
 * @param cells 同一片区域里按顺序排列的单元格文本。
 * @returns `["业务场景1｜采购执行计划创建", …]`，按出现顺序。
 */
export function sceneHeaders(cells: readonly unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const text = pyTrim(pyStrOrEmpty(cells[i]));
    // `_SCENE.match(text)`：只从串首匹配
    const m = SCENE_RE.exec(text);
    if (m === null || m.index !== 0) continue;
    let name = pyStrip(m.groups?.["name"] ?? "", " 　:：");
    if (!name) {
      // 名字在下一个单元格。太长的不要 —— 那是正文不是标题。
      const nxt = i + 1 < cells.length ? pyTrim(pyStrOrEmpty(cells[i + 1])) : "";
      name = cpLen(nxt) > 0 && cpLen(nxt) <= NODE_LABEL_MAX && !nxt.includes("\n") ? nxt : "";
    }
    const head = pyTrim(text.split("：")[0]!.split(":")[0]!);
    out.push(name ? `${head}｜${name}` : head);
  }
  return out;
}

/**
 * 从问卷的节点分组建阶段。
 *
 * 问卷的「节点」列本身就是阶段划分：客户按 `（1）编制集采计划`…`（17）采购包分配`
 * 的分组在讨论。把连续编号按语义边界合并成阶段，比我们按每 4 个硬切强得多 ——
 * 后者的边界纯属巧合，前者是客户脑子里的真实结构。
 */
export function stagesFromSurvey(
  surveyGroups: Iterable<readonly [string, readonly number[]]>,
  graph: FlowGraph | null = null,
): [FlowGraph, Map<number, string>] {
  const g = graph ?? new FlowGraph();
  const mapping = new Map<number, string>();
  let i = 0;
  for (const [title, nos] of surveyGroups) {
    i += 1;
    if (nos.length === 0) continue;
    const key = `s${i}`;
    g.stages.set(
      key,
      makeStage({
        key,
        order: i,
        title: `阶段${i}｜${title}`,
        subtitle: `覆盖节点 ${Math.min(...nos)}–${Math.max(...nos)}（来自客户访谈问卷）`,
      }),
    );
    for (const no of nos) mapping.set(no, key);
  }
  return [g, mapping];
}

/**
 * 没有场景标题时的阶段划分：**按业务域切**，不按固定条数切。
 *
 * 以前的兜底是"每 4 个节点切一刀，标题拼成`阶段1｜编制集采计划…审批采购需求
 * 计划`"。那个 4 没有任何依据 —— 它切出来的边界纯属巧合，而拼出来的标题长到
 * 在泳道上放不下。
 *
 * 业务域是从节点名里认出来的（{@link domainCode}：集采计划 / 采购需求计划 /
 * 采购执行计划 / 采购申请 / 采购包…）。相邻且同域的节点归一段，域一变就换一段
 * —— 这条边界是材料自己给的：客户写流程的时候本来就是一个单据写完再写下一个。
 * 认不出域的节点单独成段，标题用它自己的名字，不硬塞进别人那一段。
 */
export function stagesByDomain(
  steps: readonly ProcessStep[],
  graph: FlowGraph | null = null,
): [FlowGraph, Map<number, string>] {
  const g = graph ?? new FlowGraph();
  const mapping = new Map<number, string>();
  if (steps.length === 0) return [g, mapping];

  const runs: Array<[string, ProcessStep[]]> = [];
  for (const st of [...steps].sort((a, b) => a.no - b.no)) {
    const dom = domainCode(st.name) || domainCode(st.detail);
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === dom && dom) last[1].push(st);
    else runs.push([dom, [st]]);
  }

  for (let i = 0; i < runs.length; i++) {
    const group = runs[i]![1];
    const key = `s${i + 1}`;
    // 标题用**这一段的主体**，不是首尾节点名拼接。「采购执行计划」比
    // 「阶段2｜创建采购执行计划…审批采购执行计划」在泳道上好读得多。
    const title = commonSubject(group) || group[0]!.name;
    g.stages.set(
      key,
      makeStage({
        key,
        order: i + 1,
        title: cpHead(title, NODE_LABEL_MAX),
        subtitle: `节点 ${group[0]!.no}–${group[group.length - 1]!.no}（按业务对象切分，待人工确认）`,
      }),
    );
    for (const st of group) mapping.set(st.no, key);
  }
  return [g, mapping];
}

/**
 * 用客户自己写的场景名给泳道改标题。返回改了几条。
 *
 * 材料里明写着「业务场景1｜采购执行计划创建」，而我们按业务域切出来的那一段
 * 标题是「采购执行计划」——同一段东西，客户的说法更完整，也是他开会时会用的
 * 词。**只在两者真的指同一段时才换**：场景名里要出现泳道的主体词。对不上的
 * 保持原样，不硬凑 —— 硬凑的后果是给一段流程贴上另一段的名字。
 */
export function applySceneTitles(g: FlowGraph, scenes: readonly string[]): number {
  const used = new Set<number>();
  let changed = 0;
  for (const st of [...g.stages.values()].sort((a, b) => a.order - b.order)) {
    const parts = st.title.split("｜");
    const subject = parts[parts.length - 1]!;
    if (cpLen(subject) < 2) continue;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      if (used.has(i) || !scene.includes(subject)) continue;
      // 场景名进**副标题**，不占标题。标题保持"这条泳道在处理哪个单据"，
      // 六条泳道的标题才是同一种东西；混着「集采计划」和
      // 「业务场景1｜采购执行计划创建」看起来像出了 bug。
      st.subtitle = st.subtitle ? `${scene} · ${st.subtitle}` : scene;
      used.add(i);
      changed += 1;
      break;
    }
  }
  return changed;
}

/** 动作前缀。切标题时把它们剥掉，剩下的才是这一段在处理的单据。 */
const ACTION_PREFIX_RE =
  /^(?:编制|创建|新建|修改|变更|调整|取消|作废|删除|审批|审核|提交|分配|发布|下达|确认|执行|录入|导入|同步)/u;

/** 一段节点共同处理的单据名。取不出就返回空串 —— 不硬编一个。 */
function commonSubject(steps: readonly ProcessStep[]): string {
  const names = steps
    .map((st) => pyStrip(st.name.replace(ACTION_PREFIX_RE, ""), "（）() "))
    .filter((n) => n !== "");
  let head = names[0];
  if (head === undefined) return "";
  for (const n of names.slice(1)) {
    // `head[:-1]` 按 code point 削 —— 生僻字削半个会得到一个永远匹配不上的串
    while (head !== "" && !n.includes(head)) head = cpDropLast(head);
    if (!head) return "";
  }
  return cpLen(head) >= 2 ? head : "";
}

/** `dict.values()`：Map 与普通对象都收（sheet 名是中文，普通对象不会重排）。 */
function valuesOf<T>(d: ReadonlyMap<string, T> | Readonly<Record<string, T>>): T[] {
  return d instanceof Map ? [...d.values()] : Object.values(d as Record<string, T>);
}

/**
 * 从问卷各 sheet 的第一列读出阶段分组。
 *
 * 两种线索都用：
 * - 「流程节点问题」sheet 的 `（N）xxx` 给出节点的确切名字与顺序；
 * - 「规则问题」sheet 的 `业务场景X（重点覆盖节点6—10）` 给出场景到区间的映射。
 *
 * @param sheets sheet 名 → 该 sheet 第一列的非空文本列表。
 * @returns `[(阶段标题, [节点号...])]`，按出现顺序。抽不到就返回空 —— 上层据此
 *   退回按编号切分，并注明"阶段待确认"。
 */
export function surveyStageGroups(
  sheets: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>,
): Array<[string, number[]]> {
  // 先看有没有明写区间的场景（最强的信号）
  const scenes: Array<[string, number, number]> = [];
  for (const col of valuesOf(sheets)) {
    for (const cell of col) {
      // `_SCENE.search(cell)`：从任意位置找
      const m = SCENE_RE.exec(cell);
      const lo = m?.groups?.["lo"];
      const hi = m?.groups?.["hi"];
      if (m !== null && lo !== undefined && hi !== undefined) {
        scenes.push([pyTrim(m.groups?.["name"] ?? ""), pyIntDigits(lo), pyIntDigits(hi)]);
      }
    }
  }
  if (scenes.length > 0) {
    return scenes.map(([name, lo, hi]) => {
      const nos: number[] = [];
      for (let n = lo; n <= hi; n++) nos.push(n);
      return [name, nos] as [string, number[]];
    });
  }

  // 退而求其次：按 `（N）名字` 里的动作前缀分组（编制/审批/创建…同族的并一段）
  const nodes: Array<[number, string]> = [];
  for (const col of valuesOf(sheets)) {
    for (const cell of col) {
      const text = pyTrim(cell);
      // **标题才算标题。** 一个塞了 17 个节点全文的合并单元格同样以
      // `（1）` 开头，认下去就会把整段说明当成节点 1 的名字。
      if (cpLen(text) > NODE_LABEL_MAX || text.includes("\n")) continue;
      const m = SURVEY_NODE_RE.exec(text);
      if (m !== null) nodes.push([pyIntDigits(m[1]!), pyTrim(m[2]!)]);
    }
  }
  if (nodes.length === 0) return [];
  // `nodes.sort()` 比的是元组：先编号，再按 code point 比名字
  nodes.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : cmpCodePoint(a[1], b[1])));
  // 按名字里的业务域切段：相邻节点域码相同就并入同一阶段
  const groups: Array<[string, number[]]> = [];
  for (const [no, name] of nodes) {
    const dom = domainCode(name);
    const last = groups[groups.length - 1];
    if (last !== undefined && domainCode(last[0]) === dom && dom) last[1].push(no);
    else groups.push([name, [no]]);
  }
  // 用每段第一个节点的名字做标题
  return groups.map(([name, nos]) => [name, nos] as [string, number[]]);
}

/** Python 的 `<` 比字符串按 code point；JS 默认按 UTF-16 code unit。 */
function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return x.length - y.length;
}

// ══════════════════════════════════════════════════════════════════
//  网关（黄色菱形）
// ══════════════════════════════════════════════════════════════════
/**
 * 「如…则…」句式。业务规则里的条件分叉，全图唯一带出边标签的东西。
 * 三种写法都见于真实材料：如X，则Y / 如X则Y / 超出X，则Z失败。
 *
 * 「如」要在**从句开头**（前面是句首或标点），否则「如果」「例如」「比如」里
 * 那个「如」会把半句话当成条件。用「如果」写的整句也要认，所以「果」可选。
 *
 * 结果引导词前面加了否定前瞻：「如所需服务/物资**无需**再进行采购」里的「需」
 * 不是结果引导词，它是「无需」的后半个字。少了这道前瞻，条件会被切成
 * 「所需服务/物资无」—— 一个读不懂的半截短语，画在菱形里比不画还糟。
 */
const COND_RE = new RegExp(
  `(?:^|[，,；;。：:、${SP}])(?:如果?|若|倘若|当|一旦)${S}*` +
    `(?<cond>[^，,；;。：]{3,40}?)${S}*[，,]?${S}*` +
    `(?<![无不未])(?:则|即|就需?|需要?|应当?|自动|会|方可|才能)${S}*` +
    `(?<then>[^，,；;。]{2,50})`,
  "u",
);

/** 条件的结尾。以这些字收尾说明这句话被切断了 —— 「单一来源等」后面还有内容，
 * 「采购物资和」更是明显只剩半句。宁可丢一个网关，也不要在图上放一句读不懂的话。 */
const TRUNCATED_TAIL = ["、", "，", "和", "或", "等", "及", "与", "的"] as const;

/** 分叉的第二条边：「如满足…否则…」「可满足…如不满足…」。 */
const ELSE_RE = /(?:否则|反之|如不|若不|不满足|超出|无法)/u;

/** 括号内容用占位符替换，切句时不被里面的标点干扰，切完再还原。 */
const PAREN_RE = /[（(][^（()）]*[）)]/gu;

function maskParens(text: string): string {
  return text.replace(
    PAREN_RE,
    (m) => "\x00" + m.replace(/；/gu, "﹔").replace(/;/gu, "﹔").replace(/、/gu, "﹑") + "\x01",
  );
}

function unmask(text: string): string {
  return text
    .replace(/\x00/gu, "")
    .replace(/\x01/gu, "")
    .replace(/﹔/gu, "；")
    .replace(/﹑/gu, "、");
}

const CLAUSE_SPLIT_RE = new RegExp(`[；;]${S}*|\\p{Nd}+[、.）)]${S}*`, "u");

/** 从一条业务规则里认出的判断分叉。 */
export interface Gateway {
  /** 判断依据（菱形里的字）。 */
  condition: string;
  /** (标签, 去向短语)。 */
  branches: Array<[string, string]>;
  cite: string;
  ruleText: string;
}

export function makeGateway(p: Init<Gateway, "condition">): Gateway {
  return {
    condition: p.condition,
    branches: [...(p.branches ?? [])],
    cite: p.cite ?? "",
    ruleText: p.ruleText ?? "",
  };
}

/** `rule_text` **不进 to_dict** —— 照 Python 原样，它只在建图时当 snippet 用。 */
export function gatewayToDict(gw: Gateway): Record<string, unknown> {
  return { condition: gw.condition, branches: gw.branches, cite: gw.cite };
}

/**
 * 从一段规则文本里认出所有「如…则…」分叉。
 *
 * 只认**真的有分叉语义**的：一条规则里如果同时出现「满足…则不…」和
 * 「不满足…则…」，那是一个双分支网关。单条「如X则Y」也算 —— 它是一条
 * 带条件的边，图上画成网关最忠实。
 *
 * 判据是句式不是关键词。「如实填写」这种「如+副词」不会命中，因为它没有
 * 「则/需/自动」这类结果引导词。
 */
export function parseGateways(text: unknown, opts: { cite?: string } = {}): Gateway[] {
  const cite = opts.cite ?? "";
  const out: Gateway[] = [];
  // 规则常按分号/编号分条，逐条看。但**括号内的分号不能切** —— 「（各阶段：
  // 采购立项创建、采购包分配…）」里的顿号和它前后的分号会把一条规则劈碎，
  // 于是「当前时间、」这种半截 condition 就冒出来了。先把括号内容抠掉再切。
  for (const rawClause of maskParens(pyStrOrEmpty(text)).split(CLAUSE_SPLIT_RE)) {
    const clause = pyTrim(unmask(rawClause));
    const m = COND_RE.exec(clause);
    if (m === null) continue;
    const cond = pyTrim(m.groups?.["cond"] ?? "");
    if (cpLen(cond) < 3 || TRUNCATED_TAIL.some((t) => cond.endsWith(t))) {
      continue; // 半截条件，多半是被切坏的，宁可丢不要糊弄
    }
    const then = pyTrim(m.groups?.["then"] ?? "");
    const branches: Array<[string, string]> = [[branchLabel(then), cpHead(then, 30)]];
    // 同一条里的另一分支
    const tail = clause.slice(m.index + m[0].length);
    const m2 = COND_RE.exec(tail);
    if (m2 !== null) {
      branches.push([
        branchLabel(m2.groups?.["then"] ?? ""),
        cpHead(pyTrim(m2.groups?.["then"] ?? ""), 30),
      ]);
    } else if (ELSE_RE.test(tail)) {
      // 「否则/如不满足…」但没写成第二个完整的「如…则…」
      branches.push(["否则", cpHead(pyTrim(tail), 30)]);
    }
    out.push(
      makeGateway({ condition: cpHead(cond, 36), branches, cite, ruleText: cpHead(clause, 120) }),
    );
  }
  return out;
}

/** 结果短语 → 分支标签。给菱形出边贴的字，要短。 */
function branchLabel(then: string): string {
  const t = pyTrim(then);
  if (["失败", "不通过", "驳回", "拒绝", "预警", "无法"].some((w) => t.includes(w))) return "不满足";
  if (["不", "无需", "禁止", "不允许", "不进行"].some((w) => t.startsWith(w))) return "否";
  if (["满足", "通过", "成功", "允许", "可以", "继续", "则创建"].some((w) => t.includes(w))) {
    return "满足";
  }
  return "是";
}

/**
 * 把网关挂到流图上。
 *
 * `gateways` 是 `(网关, 挂到哪个节点号)`。挂不上具体节点的（node=null）
 * 仍然建出来，独立悬在对应阶段里 —— 一个抽出来却没接上的网关，比不抽更该
 * 让人看见，它标示着"这条规则我认出来了但不知道插在哪"。
 */
export function attachGateways(
  g: FlowGraph,
  gateways: Iterable<readonly [Gateway, number | null]>,
  opts: { fileName?: string } = {},
): FlowGraph {
  const fileName = opts.fileName ?? "";
  for (const [gw, nodeNo] of gateways) {
    const prov = rawProv(fileName, gw.cite, gw.ruleText);
    let anchor: FlowNode | null = null;
    let stage = ensureMain(g);
    if (nodeNo !== null) {
      // Python 这里先 `g.nodes.get(make_rid("fn", f"act{node_no}_"))`，结果立刻被
      // 下一行覆盖（act rid 带名字，只能按前缀找）。那次查表没有副作用，不搬。
      anchor =
        [...g.nodes.entries()].find(([rid]) => rid.startsWith(`fn_act${nodeNo}_`))?.[1] ?? null;
      if (anchor !== null) stage = anchor.stage;
    }
    const gwNode = g.addNode(
      makeFlowNode({
        rid: makeRid("fn", `gw_${gw.condition}_${gw.cite}`),
        kind: NodeKind.GATEWAY,
        stage,
        label: extracted(gw.condition, prov),
      }),
    );
    if (anchor !== null) {
      // 网关插在动作之后：动作 → 网关 → 各分支
      g.connect(anchor.rid, gwNode.rid, { evidence: [prov] });
    }
    for (const [label, dest] of gw.branches) {
      // 分支去向是散文短语，承接它的节点是流程末梢 —— 用 TERMINAL 而不是
      // EVENT。否则它们全被 deadEnds() 报成"流程断点"（散文短语当然没有
      // 下游），淹掉真正的断点。
      const leaf = g.addNode(
        makeFlowNode({
          rid: makeRid("fn", `gwend_${dest}_${gw.cite}`),
          kind: NodeKind.TERMINAL,
          stage,
          label: extracted(dest, prov),
        }),
      );
      g.connect(gwNode.rid, leaf.rid, { kind: EdgeKind.CONDITIONAL, label, evidence: [prov] });
    }
  }
  return g;
}

// ══════════════════════════════════════════════════════════════════
//  缺口 → 问题
// ══════════════════════════════════════════════════════════════════
/**
 * 把流程图上的缺口变成给客户的待澄清问题。
 *
 * 这是这个工具真正的价值落点：它不只是画一张图，而是**指出图里哪儿是空的、
 * 并把空的地方翻译成一个能问客户的问题**。图上标黄（推断/断路）的每一处，
 * 背后都有一个 FDE 本该问却容易漏掉的问题。
 *
 * 产出 {@link OpenQuestion}，直接进 OIR 的问题容器，和问卷里搬来的问题合流成
 * 一份清单 —— 客户不需要知道哪条是他自己提的、哪条是系统发现的。
 */
export function gapsToQuestions(g: FlowGraph, opts: { fileName?: string } = {}): OpenQuestion[] {
  const fileName = opts.fileName ?? "";
  const qs: OpenQuestion[] = [];

  const q = (text: string, group: string, node: FlowNode | null): void => {
    const ev =
      node !== null && node.label.evidence.length > 0
        ? node.label.evidence
        : [rawProv(fileName, "", text)];
    qs.push(
      makeOpenQuestion({
        rid: makeRid("oq", `flow_${cpHead(text, 40)}`),
        text: extracted(text, ...ev.slice(0, 1)),
        group,
        askedBy: "system",
      }),
    );
  };

  // 死路：流程走到这里断了，材料没写下游
  for (const n of g.deadEnds()) {
    q(`「${n.label.value}」之后是什么？流程走到这里就断了，材料里没有写它的下一步。`, "流程断点", n);
  }

  // 网关没标条件的分支：读图人不知道什么时候走哪条
  for (const n of g.unlabeledBranches()) {
    q(`「${n.label.value}」这个判断，各个分支的触发条件分别是什么？`, "判断条件", n);
  }

  // 动作没有对应事件：下游没法挂监听
  for (const n of g.actionsWithoutEvents()) {
    q(
      `「${n.label.value}」做完之后，系统里能观测到什么结果（状态变化/生成的单据）？`,
      "动作结果",
      n,
    );
  }

  // 推断出来的边太多，说明整条链的衔接靠猜
  const inferredEdges = g.stats()["inferred_edges"] ?? 0;
  if (inferredEdges >= 3) {
    q(
      `整个流程有 ${inferredEdges} 处衔接是系统按节点顺序推断的，材料里没有明确写。` +
        `这些节点之间的实际先后顺序，能确认一下吗？`,
      "流程顺序",
      null,
    );
  }

  return qs;
}
