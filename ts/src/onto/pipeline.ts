/**
 * 主流水线 —— 真正跑在 Harness 上的 DAG。移植自 `src/ontocopilot/onto/pipeline.py`。
 *
 * 之前的实现是一条手写的线性序列：把语料截断到固定条数，一次性丢给模型。在真实
 * 材料上直接失败 —— 一份 326 切片的梳理表被截到 60 条，八成内容没进模型，抽出
 * 58 个对象、**0 个属性、0 个关系**。
 *
 * 真实材料不是靠"一次大调用"能处理的。这里换成 Harness 该有的形态：
 *
 * * **按 sheet / 章节切段，fan-out 成多个抽取节点。** 每段上下文有界，段与段并行。
 *   段数来自材料的**结构**（有几个 sheet），不来自内容 —— 计划冻结因此仍然成立。
 * * **节点内是 agent loop，不是单次调用。** 抽取节点能用 `evidence.search` 把
 *   需要的切片捞回来、用 `profile.column` 查列画像，边看边抽。
 * * **Critic 拦住"看起来跑完了其实什么都没抽到"。** 覆盖率视角会把"有对象没属性"
 *   判成 HIGH —— 这正是之前静默失败的形态。
 * * **反思回灌。** critic 的意见进 L3 记忆，后续段不再犯同样的错。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 * 1. **`segment_corpus` 里那个 key 表达式的运算符优先级**。Python 的条件表达式
 *    绑得最松，所以 `A or B or … or c.tags[0] if c.tags else ""` 真正的意思是
 *    `(A or … or c.tags[0]) if c.tags else ""` —— **没有 tags 的切片一律归到
 *    "main"**，哪怕它的 locator 里写着 sheet 名。照 JS 的直觉读成
 *    `A or … or (c.tags[0] if c.tags else "")` 会让分段结果整个变形。
 * 2. **`str.strip()` 的空白集**与 `String.trim()` 不同（Python 多 `\x1c-\x1f\x85`，
 *    JS 多 BOM）。分组列的继承值、宿主名、api_name 全过 strip，见 {@link pyStrip}。
 * 3. **字符串切片按码点**：`stmt[:40]` / `render[:200]` / `fname[:6]` 都进 rid 与
 *    provenance，按 UTF-16 切会把中文切出半个字、rid 跟着漂。见 {@link cpSlice}。
 * 4. **`sorted(merged.items())`** 比的是码点序，JS 默认 sort 比的是 UTF-16 码元序。
 *    段的编号 `s0/s1/s2` 全靠这个顺序，见 {@link cmpStrCp}。
 * 5. **真值判断**：`str(v or "")` 里的 `or` 在 Python 中把 `0` / `[]` / `{}` 判假，
 *    JS 里 `[]`、`{}` 是真。见 {@link pyTruthy}。
 *
 * ── 与 Python 不完全一致的一处，以及为什么 ──────────────────────
 *
 * * `_CITE_CACHE` 在 Python 里按 `id(index)` 做键，索引被回收后 id 可能被复用、
 *   缓存会串味。TS 侧改用 `WeakMap`：语义相同（缓存不随索引变化刷新），
 *   但没有 id 复用那条隐患。
 */

import { defaultAgents, renderSystem } from "../kernel/agents.js";
import { defaultLibrary } from "../kernel/skills.js";
import { pyRepr } from "../kernel/errors.js";
import {
  Critic,
  makeFinding,
  makeVerdict,
  RuleCritic,
  Severity,
  type CriticContext,
  type Finding,
  type Verdict,
} from "../kernel/critic.js";
import {
  Dag,
  Difficulty,
  makeNodeBudget,
  makeNodeSpec,
  makeScopeSpec,
  NodeMode,
} from "../kernel/dag.js";
import { NodeHandler, type RunContext } from "../kernel/loop.js";
import type { Chunk, EvidenceIndex } from "../kernel/memory/evidence.js";

import { alignAndApply, alignSummary, pairScoreToDict, pairTotal } from "./align.js";
import { ClarificationEngine, type ClarificationSet } from "./clarify.js";
import { autoRepair, detectAll, type Conflict } from "./conflict.js";
import { alignmentGaps, type Gap } from "./gaps.js";
import {
  BaseType,
  Cardinality,
  extracted,
  inferred,
  makeActionType,
  makeBusinessRule,
  makeEventType,
  makeLinkType,
  makeObjectType,
  makeOpenQuestion,
  makeProvenance,
  makePropertyType,
  makeRid,
  OIR,
  parseBaseType,
  parseCardinality,
  parseRuleKind,
  RuleKind,
  Status,
  type Provenance,
} from "./oir.js";
import {
  ColumnRole,
  inferShape,
  SegmentShape,
  structuralExtract,
  Yield,
  type ExtractOut,
} from "./shape.js";
import { suggest } from "./suggest.js";
import { compileTemplate, type TemplateSpec } from "./template.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

const PY_SPACE = "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680" +
  "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

/** `str.strip()`。**不能**用 `trim()` 代替：两边的空白集不一样，而 strip 的结果
 * 直接决定一个格子算不算"填了"—— 分组列的继承、宿主名的匹配全踩在这上面。 */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/** Python 的真值判断。`x or y` 在本模块出现几十次，每一处都靠它。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return !Number.isNaN(v) ? v !== 0 : true; // NaN 在 Python 里是真
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(v)`。`None` → `"None"`、`True` → `"True"` —— 这些串会进 api_name 与 rid。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    // 已知分叉：JS 里 1 与 1.0 是同一个值，Python `str(1.0)` 给 "1.0"。
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map);
}

/** Python 的 `d.get(k)` —— `d` 不是 dict 时 Python 是 AttributeError，这里照炸。
 *
 * **不静默返回 undefined**：抽取结果里混进一个字符串，静默跳过等于把"这份产物
 * 结构不对"吞掉，而对象计数照样出得来、照样进模板。 */
function dget(d: unknown, k: string): unknown {
  if (!isPlainDict(d)) {
    throw new TypeError(`AttributeError: ${JSON.stringify(d)} 没有 .get —— 期望一个 dict`);
  }
  const v = d[k];
  return v === undefined ? null : v;
}

/** Python 的 `d.get(k, default)`：**只有键缺失**才给默认值，键在值是 None 照给 None。 */
function dgetD(d: unknown, k: string, fallback: unknown): unknown {
  if (!isPlainDict(d)) {
    throw new TypeError(`AttributeError: ${JSON.stringify(d)} 没有 .get —— 期望一个 dict`);
  }
  return k in d ? d[k] : fallback;
}

/** `str(x.get(k) or "").strip()` —— 本模块最常见的一句话。 */
function gstr(d: unknown, k: string): string {
  const v = dget(d, k);
  return pyStrip(pyTruthy(v) ? pyStr(v) : "");
}

/** `s[:n]` —— 按**码点**切。中文与 emoji 进 rid / snippet，按码元切会切出半个字。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `len(s)` —— 按码点。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** Python 的字符串比较（码点序）。JS 默认 sort 比 UTF-16 码元，代理对会排错位。 */
function cmpStrCp(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** Python 的 `repr(list[str])`，如 `['s0', 's1']`。KeyError 的消息里要用。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** `for x in (v or [])` —— 非数组一律当空。
 *
 * Python 会去迭代任何可迭代对象（dict 给键、str 给字符），但这几处后面紧跟着
 * `isinstance(x, dict)` 过滤，非列表输入在 Python 侧的结果同样是空。 */
function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? [...v] : [];
}

// ══════════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════════

/** 一段最多送多少切片给模型。超过这个数，模型的注意力会摊薄到读不进细节 ——
 * 这不是上下文窗口的限制，是有效注意力的限制。 */
export const SEGMENT_CHUNKS = 45;

/** 一段最少要有多少切片才值得单独起一个节点。太碎会让每段都缺上下文。 */
export const MIN_SEGMENT = 6;

/** **页码派生的**分组要更大才值得单独起一个节点。
 *
 * 分组键按 `sheet → object → section → page` 依次取。前三个都是**真正的容器**
 * —— 一张工作表、一个对象、一节文档，里面的内容天然属于一起，哪怕只有几片也
 * 值得单独看。而"第 107 页幻灯片"不是容器，只是一次分页：相邻几页讲的往往是
 * 同一件事，拆开反而让每段都缺上下文。
 *
 * 一次真实事故：一份 155 页的 pptx 每页恰好 6~7 片，**刚好越过 MIN_SEGMENT=6**，
 * 于是 155 页各自成段（全库 219 段）。每段只装 6~7 片而额度是 45 —— 装了七分之一，
 * 却付了七倍的固定开销（每段一整轮 plan/execute/critic）。而队列排到后面的段
 * 连模型都没调到就被墙钟判死。
 *
 * 判据取 `SEGMENT_CHUNKS` 的三分之一：连节点额度三分之一都装不满的分页，
 * 并回同文件的"其它"再按 45 重切。155 页因此变成约 22 段。
 * **只作用于页码键**，而且**只在同一份文件里有两个以上装不满的分页时才生效** ——
 * 工作表和小节的阈值不动；只有一页的扫描件也保住它的 `p4` 标签，因为合并它
 * 一个节点都省不下。 */
export const MIN_PAGE_SEGMENT = Math.floor(SEGMENT_CHUNKS / 3);

// ══════════════════════════════════════════════════════════════════
//  切段
// ══════════════════════════════════════════════════════════════════

/**
 * 索引里的一片。**只声明 pipeline 真正读的那几样** —— Python 侧的测试替身
 * （`_Idx` / `_C`）同样只实现了 `raw` / `render` / `cite()`，`tags` 是靠
 * `getattr(chunk, "tags", ())` 兜底的，所以这里 `tags` 必须可缺。
 */
export interface ChunkLike {
  readonly raw: unknown;
  readonly render: string;
  readonly tags?: readonly string[] | undefined;
  cite(): string;
}

/** `Segment` 用到的索引能力。`EvidenceIndex` 天然满足。 */
export interface SegmentIndex {
  get(chunkId: string): ChunkLike | null | undefined;
}

/** `segment_corpus` 读的切片字段。与 `onto/parse/base.ts` 的 `Chunk` 同形。 */
export interface SegmentDocChunk {
  readonly chunk_id: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
}

/** `segment_corpus` 读的文档字段。与 `onto/parse/base.ts` 的 `ParsedDoc` 同形。 */
export interface SegmentDoc {
  readonly file_name: string;
  readonly chunks: readonly SegmentDocChunk[];
}

export interface SegmentInit {
  /** 节点后缀，要能做 DAG 节点 id。 */
  readonly key: string;
  /** 人看的名字。 */
  readonly label: string;
  readonly fileName: string;
  readonly chunkIds: readonly string[];
  readonly shape?: SegmentShape | undefined;
  readonly carryIn?: Readonly<Record<string, string>> | undefined;
}

/** 一段待抽取的语料。 */
export class Segment {
  key: string;
  label: string;
  fileName: string;
  chunkIds: string[];
  /**
   * 由列画像推出的形状。决定这段该抽什么、以及哪些不用进模型。
   * **按整张表推**，不是按这一段 —— 见 {@link segmentCorpus}。
   */
  shape: SegmentShape;
  /**
   * 本段第一行之前，各稀疏列最后一个非空取值（合并单元格的继承值）。
   * 一张表被拦腰切开时，后半段读不到组名，靠这个补回来。
   */
  carryIn: Record<string, string>;

  constructor(p: SegmentInit) {
    this.key = p.key;
    this.label = p.label;
    this.fileName = p.fileName;
    this.chunkIds = [...p.chunkIds];
    // `field(default_factory=SegmentShape)`：每个 Segment 一个新的空形状。
    this.shape = p.shape ?? new SegmentShape();
    this.carryIn = { ...(p.carryIn ?? {}) };
  }

  /** 本段的行数据与逐行出处。表格切片的 `raw` 就是一行。 */
  rows(index: SegmentIndex): [Record<string, unknown>[], string[]] {
    const rows: Record<string, unknown>[] = [];
    const cites: string[] = [];
    for (const cid of this.chunkIds) {
      const c = index.get(cid);
      if (c !== null && c !== undefined && isPlainDict(c.raw) && isDataRow(c)) {
        rows.push(c.raw);
        cites.push(c.cite());
      }
    }
    return [rows, cites];
  }

  render(index: SegmentIndex, limit: number = SEGMENT_CHUNKS): string {
    const chunks: ChunkLike[] = [];
    for (const cid of this.chunkIds.slice(0, limit)) {
      const c = index.get(cid);
      // Python 是海象赋值 `if (c := index.get(cid))`：**真值判断**，不是 `is not None`。
      if (c !== null && c !== undefined) chunks.push(c);
    }
    const body = chunks.map((c) => `⟦${c.cite()}⟧ ${c.render}`).join("\n");
    const more = this.chunkIds.length > limit
      ? `\n（本段另有 ${this.chunkIds.length - limit} 个切片。按名字找用 `
        + "evidence.search；要看某几行原文用 evidence.rows —— "
        + "行号不是关键词，search 找不到它）"
      : "";
    return `## ${this.label}（来自 ${this.fileName}）\n${body}${more}`;
  }
}

/**
 * 不是数据行的切片。解析器每张表还会额外产一片**列画像**、每份文件一片元数据 ——
 * 它们的 `raw` 同样是 dict，混进行里就会被抽成一个 apiName 是整坨 profile JSON
 * 的"实体"，一路混进模板和 critic 报告。判据用 tag，对所有解析器都成立。
 */
/** 形状像数据行、语义不是的切片。
 *
 * `slide_text` 是被真材料教出来的：pptx 的**文本框**切片 raw 是
 * `{id, name, text, bbox}`（形状元数据，不是业务字段），tags 是
 * `["pptx","slide_text"]` —— 一条都不在原来的名单里，于是被当成数据行。
 * 后果是 `classifyColumns` 拿到 6 列、填充率 43%/57% 的垃圾输入，`inferShape`
 * 据此告诉模型「这一段有 7 行，一行 = 一个业务对象」，而眼前只有 4 条真表格行。
 * 模型于是去找不存在的第 5~7 行 —— 一次真实事故里，把节点墙钟耗光的正是这个。 */
export const NON_ROW_TAGS: ReadonlySet<string> = new Set([
  "schema", "meta", "toc", "slide_text",
]);

export function isDataRow(chunk: unknown): boolean {
  const tags = (chunk as { tags?: unknown } | null | undefined)?.tags;
  const list = pyTruthy(tags) && Array.isArray(tags) ? tags : [];
  for (const t of list) if (NON_ROW_TAGS.has(String(t))) return false;
  return true;
}

/**
 * 把语料切成有界的段。
 *
 * 切分依据是材料的**结构**（sheet、章节、表名），不是内容 —— 所以段数在读取
 * 内容之前就确定，计划冻结成立。按结构切也保证了段内语义是完整的：一个 sheet
 * 就是一张表，切开它才会真的丢信息。
 *
 * **形状按整张表推，不按切出来的窗口推。** 一张 112 行的表被切成三段之后，
 * 第二段里「业务对象」那一列可能整列是空的（合并单元格只在组首写一次）——
 * 单看那一段，它是个空列；放回整张表看，它是分组列。按窗口推形状的后果是
 * 同一张表的三段判出三种形状，后两段的宿主全部丢失。
 */
export function segmentCorpus(
  index: SegmentIndex,
  docs: readonly SegmentDoc[],
): Segment[] {
  // 键是 (文件名, 段名) 二元组 —— JS 没有元组键，用 Map + 显式的成对数组。
  const groups = new Map<string, { fname: string; key: string; ids: string[] }>();
  // Python 那边键是元组 `(file_name, key)`，JS 的 Map 没有结构化元组键，只能拼成
  // 字符串。用 U+0000 当分隔符是因为它**不可能**出现在文件名或 key 里，换成 "|"
  // 之类会在名字里带分隔符时把两个不同的组合并成一个。
  //
  // 写成 `\u0000` 转义而不是嵌一个裸 NUL 字节：裸字节会让整个文件被 `file(1)`
  // 判成 binary，`grep` 于是**静默跳过它**（不是报错，是什么都不输出）——
  // 在一个 1500 行的文件上找符号时，这会让人以为文件是空的。
  const gkey = (fname: string, key: string): string => `${fname}\u0000${key}`;
  /** 哪些分组的键是从页码来的。页不是容器，合并阈值更高（MIN_PAGE_SEGMENT）。 */
  const pageKeys = new Set<string>();

  for (const doc of docs) {
    for (const c of doc.chunks) {
      const loc = c.locator;
      // ⚠ 运算符优先级：Python 的条件表达式绑得最松，整个 `or` 链都在
      // `if c.tags` 的**真值分支**里。也就是说 —— **没有 tags 的切片，
      // 不管 locator 里写了什么，key 都是空串、最后归到 "main"**。
      let key = "";
      if (pyTruthy(c.tags)) {
        const sheet = loc["sheet"];
        const objectRaw = "object" in loc ? loc["object"] : "";
        const section = loc["section"];
        const page = loc["page"];
        key = pyTruthy(sheet) ? pyStr(sheet) : "";
        if (!key) {
          const head = pyStr(objectRaw).split(".")[0] ?? "";
          key = head;
        }
        if (!key && pyTruthy(section)) key = pyStr(section);
        if (!key) {
          key = pyTruthy(page) ? `p${pyStr(page)}` : "";
          // 记住这一组是"分页"而不是"容器" —— 合并阈值不同，见 MIN_PAGE_SEGMENT。
          if (key) pageKeys.add(gkey(doc.file_name, key));
        }
        if (!key) key = pyStr(c.tags[0]);
      }
      const k = key || "main";
      const id = gkey(doc.file_name, k);
      let bucket = groups.get(id);
      if (bucket === undefined) {
        bucket = { fname: doc.file_name, key: k, ids: [] };
        groups.set(id, bucket);
      }
      bucket.ids.push(c.chunk_id);
    }
  }

  // 太小的段并回同文件的"其它"，避免每段都缺上下文
  const merged = new Map<string, { fname: string; key: string; ids: string[] }>();
  // 同一份文件里有几个"装不满"的分页组。**合并要真的能省下节点才做** ——
  // 只有一个小分页时合并一个节点都省不下，却把 `p4` 这种标签换成了「其它」，
  // 纯损失。所以下面要求同文件至少有两个才合。
  const smallPages = new Map<string, number>();
  for (const g of groups.values()) {
    if (pageKeys.has(gkey(g.fname, g.key)) && g.ids.length < MIN_PAGE_SEGMENT) {
      smallPages.set(g.fname, (smallPages.get(g.fname) ?? 0) + 1);
    }
  }
  for (const g of groups.values()) {
    const isPage = pageKeys.has(gkey(g.fname, g.key));
    const floor = isPage && (smallPages.get(g.fname) ?? 0) >= 2 ? MIN_PAGE_SEGMENT : MIN_SEGMENT;
    const tk = g.ids.length >= floor ? g.key : "其它";
    const id = gkey(g.fname, tk);
    let bucket = merged.get(id);
    if (bucket === undefined) {
      bucket = { fname: g.fname, key: tk, ids: [] };
      merged.set(id, bucket);
    }
    bucket.ids.push(...g.ids);
  }

  // `sorted(merged.items())`：先比文件名再比段名，**按码点**。
  const ordered = [...merged.values()].sort(
    (a, b) => cmpStrCp(a.fname, b.fname) || cmpStrCp(a.key, b.key));

  const out: Segment[] = [];
  ordered.forEach(({ fname, key, ids }, i) => {
    const whole = new Segment({ key: `s${i}`, fileName: fname, label: key, chunkIds: ids });
    const [rows] = whole.rows(index);
    // 形状只看列的取值分布，不看内容语义 —— 冻结计划的边界没有被破坏。
    const shape = inferShape(rows);
    // 超长的段再按 SEGMENT_CHUNKS 拆，保证每个节点上下文有界
    const carry: Record<string, string> = {};
    for (let part = 0; part < Math.max(1, ids.length); part += SEGMENT_CHUNKS) {
      const sliceIds = ids.slice(part, part + SEGMENT_CHUNKS);
      if (sliceIds.length === 0) continue;
      const seg = new Segment({
        key: `s${i}_${Math.floor(part / SEGMENT_CHUNKS)}`,
        fileName: fname,
        label: key + (ids.length > SEGMENT_CHUNKS
          ? `（第 ${Math.floor(part / SEGMENT_CHUNKS) + 1} 部分）` : ""),
        chunkIds: sliceIds,
        shape,
        carryIn: carry,
      });
      const [partRows] = seg.rows(index);
      seg.shape = windowShape(shape, partRows);
      for (const r of partRows) {
        for (const [k, v] of Object.entries(r)) {
          const text = pyStrip(pyTruthy(v) ? pyStr(v) : "");
          if (text) carry[String(k)] = text;
        }
      }
      out.push(seg);
    }
  });
  return out;
}

/**
 * 整张表的形状 + 这一窗口的行数。
 *
 * 列角色、能出什么、哪些规则可定 —— 全部沿用整张表的判断；只有"这一段有几行"
 * 是窗口自己的，因为 critic 的行覆盖判据要拿它和抽出来的条数比。
 */
export function windowShape(
  sheetShape: SegmentShape,
  partRows: readonly unknown[],
): SegmentShape {
  // `dataclasses.replace` 是浅拷贝：列与两个集合仍然是同一批对象。
  return sheetShape.withRowCount(partRows.length);
}

// ══════════════════════════════════════════════════════════════════
//  「这一段还欠什么」—— 任务描述与 critic 的共同判据
// ══════════════════════════════════════════════════════════════════

/**
 * 会被 critic 判缺失的产出类型。任务描述必须逐条点名要，否则模型不知道要抽，
 * critic 却照判 —— 两边不闭合就会空转、并在修订环里把已抽的东西冲掉。
 *
 * LINKS **必须在这里面**。原来它不在，于是"一条关系都没抽到"这件事在整条链路上
 * 不产生任何 finding：`outstanding()` 只遍历这个元组，CoverageCritic 也就永远
 * 不会为零关系报警。交付物里一条关系都没有，而系统从头到尾一句话都没说。
 */
export const CHECKED_YIELDS: readonly Yield[] = [
  Yield.OBJECTS, Yield.PROPERTIES, Yield.LINKS, Yield.ACTIONS,
];

/** 每类产出对应的要求文案。 */
export const ASK: Readonly<Partial<Record<Yield, string>>> = {
  [Yield.OBJECTS]: "这一段涉及的**业务对象**（apiName + 中文名），"
    + "一个对象出现多次只抽一次",
  [Yield.PROPERTIES]: "**每一行字段抽成一个 PropertyType**，"
    + "口径（税/时间粒度/口径主体/币种）写进 definition",
  // 这一条以前是缺的，而 LINKS 又不在 CHECKED_YIELDS 里，两个缺口正好互相
  // 掩盖：模型没被要求抽关系，critic 也不检查关系 —— 于是"零关系"从来不是
  // 一个问题。现在两边一起补上；只补一边会让模型空转（被判缺却没人告诉它要）。
  [Yield.LINKS]: "对象之间的**关系**（头—行、主—从、引用）。"
    + "两端写 apiName、基数写 ONE_TO_ONE / ONE_TO_MANY / MANY_TO_MANY；"
    + "**两端必须是你在本段抽出来的对象**，名字对不上的关系会被丢掉",
  [Yield.ACTIONS]: "对象上的**行动**（谁在什么条件下能改这条数据）",
};

/** `_ASK[y]` —— 缺键在 Python 里是 KeyError，不是静默的 `undefined`。 */
function askFor(y: Yield): string {
  const s = ASK[y];
  if (s === undefined) throw new Error(`KeyError: ${pyRepr(y)}`);
  return s;
}

/** `outstanding()` 的 `have` 参数：按 {@link Yield} 的值分桶。 */
export interface YieldBuckets {
  readonly objects?: readonly unknown[] | undefined;
  readonly properties?: readonly unknown[] | undefined;
  readonly links?: readonly unknown[] | undefined;
  readonly actions?: readonly unknown[] | undefined;
  readonly rules?: readonly unknown[] | undefined;
  readonly questions?: readonly unknown[] | undefined;
}

/**
 * 这一段还欠哪些产出。
 *
 * @param shape 段形状，决定"本该有什么"。
 * @param have 已经拿到的产出（规则抽的 / 最终产物），按 {@link Yield} 的值分桶。
 */
export function outstanding(shape: SegmentShape, have: YieldBuckets): Yield[] {
  const owed: Yield[] = [];
  for (const y of CHECKED_YIELDS) {
    if (!shape.expects(y)) continue;
    const raw = (have as Record<string, unknown>)[y];
    const got = asList(pyTruthy(raw) ? raw : []).filter(isPlainDict);
    if (got.length === 0) {
      owed.push(y);
      continue;
    }
    // **属性例外：行搬到了不等于口径读到了。**
    //
    // 规则能把字段表逐行搬成 PropertyType（名字、类型、必填都写在格子里），
    // 这保证一行不丢。但一个字段最值钱的是**口径** —— 「金额」含不含税、
    // 「日期」按自然月还是按账期 —— 那要读散文、要跨行对照，是模型的活。
    // 全靠规则等于把最难问出来的那部分丢掉；全靠模型则是零属性时无人察觉。
    // 所以规则搬完之后**仍然向模型索要**，由 finalize() 合并（规则侧权威）。
    if (y === Yield.PROPERTIES
      && got.every((x) => dget(x, "_origin") === "rule")
      && got.some((x) => !gstr(x, "definition"))) {
      owed.push(y);
    }
  }
  return owed;
}

/** 规则从分组列里读到的宿主业务对象名，按出现顺序去重。 */
export function hostNames(pre: YieldBuckets): string[] {
  // `dict.setdefault` + `list(dict)` = 保序去重。
  const seen = new Set<string>();
  for (const a of asList(pre.actions)) {
    const name = gstr(a, "object_display");
    if (name) seen.add(name);
  }
  for (const o of asList(pre.objects)) {
    const name = gstr(o, "group");
    if (name) seen.add(name);
  }
  return [...seen];
}

// ══════════════════════════════════════════════════════════════════
//  抽取
// ══════════════════════════════════════════════════════════════════

/**
 * `kernel.agents.AgentSpec` 里 handler 真正读的部分 —— **只有 `output_schema`**。
 *
 * 收窄到这一个字段不是洁癖：这让"段"这一层不必知道 agent 长什么样，测试造替身
 * 也不用把 11 个字段全填一遍。`kernel/agents.ts` 的 `AgentSpec` 天然满足它。
 */
export interface AgentSpecLike {
  /** `output_schema`。给了就强制结构化输出。 */
  readonly outputSchema: Record<string, unknown> | null;
}

/** `f"{type(exc).__name__}: {exc}"`。取**类名**而不是 `e.name` —— 子类忘了设
 * `name` 时 `e.name` 会退回 "Error"，而 Python 给的是子类名。 */
function errorLabel(e: unknown): string {
  if (e instanceof Error) {
    const cls = e.constructor.name;
    return `${cls === "" ? e.name : cls}: ${e.message}`;
  }
  return `${typeof e}: ${String(e)}`;
}

/** 黑板上 `_tools` 那个工具注册表。 */
interface ToolCaller {
  call(
    name: string,
    args: Record<string, unknown>,
    ctx: RunContext,
    opts: { scope?: string },
  ): Promise<unknown>;
}

/** `ctx.bus.read(...)` —— `LoopBus` 只声明了 `renderFacts`，黑板读取要自己收窄。
 * 真跑起来 bus 就是 `AgentBus`；不是的话这里 TypeError，与 Python 的
 * AttributeError 同一档。 */
interface BlackboardBus {
  read(key: string): unknown;
}

async function dispatchTool(action: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
  const tools = (ctx.bus as unknown as BlackboardBus).read("_tools") as ToolCaller | null;
  if (tools === null || tools === undefined) return { error: "本节点没有可用工具" };
  try {
    const args = dget(action, "args");
    return await tools.call(
      pyStr(dgetD(action, "tool", "")),
      (pyTruthy(args) ? args : {}) as Record<string, unknown>,
      ctx,
      { scope: "extract" },
    );
    // 工具失败要回给模型，不是中断整个节点
  } catch (exc) {
    return { error: errorLabel(exc) };
  }
}

/** 抽一段。节点内是 agent loop —— 能用工具把需要的切片捞回来再抽。 */
export class ExtractSegment extends NodeHandler {
  readonly segment: Segment;
  readonly index: SegmentIndex;
  private _pre: ExtractOut | null = null;

  constructor(segment: Segment, index: SegmentIndex, agent: AgentSpecLike, system: string) {
    super();
    this.segment = segment;
    this.index = index;
    this.schema = agent.outputSchema;
    this.system = system;
  }

  /** 规则先抽一遍。结果缓存 —— dispatch 和 critic 都要看同一份。 */
  prefilled(): ExtractOut {
    if (this._pre === null) {
      const [rows, cites] = this.segment.rows(this.index);
      this._pre = structuralExtract(rows, cites, this.segment.shape, this.segment.carryIn);
    }
    return this._pre;
  }

  /**
   * 这一段还欠模型哪些产出。**任务描述和 critic 判据共用这一个判据。**
   *
   * 以前两边各写各的：critic 按 `shape.yields` 判缺失，任务描述按另一串
   * 手写的 if 点名。行动表段上两边分道扬镳 —— critic 判「对象缺失」，任务
   * 描述从头到尾没提过对象。模型照着任务做完被打回，重出一版反而把规则抽好的
   * 45 个行动冲掉了。契约闭合之后这类空转不会再有。
   */
  wants(): Yield[] {
    return outstanding(this.segment.shape, this.prefilled());
  }

  override task(_inputs: Record<string, unknown>): string {
    const shape = this.segment.shape;
    const pre = this.prefilled();
    const nObj = pre.objects.length;
    const nAct = pre.actions.length;
    const nProp = pre.properties.length;

    const lines: string[] = [`这一段材料的形状已经由规则判定过了：\n${shape.describe()}\n`];
    if (nProp) {
      // 行已经搬好了，模型要补的是**口径**，不是再抄一遍字段名
      const blank = pre.properties.filter((p) => !gstr(p, "definition"));
      lines.push(
        `其中 ${nProp} 个字段**已经由规则逐行搬好了**（名字、类型、必填都齐），`
        + "你不要重复抽、不要改名字、不要改类型。\n"
        + (blank.length > 0
          ? `**还缺口径的有 ${blank.length} 个** —— 你要做的是回到原文，`
            + "为这些字段补 definition（含不含税、什么时间粒度、口径主体是谁、"
            + "币种）。读不出来就留空，**不要编**。\n"
            + `缺口径的字段：${previewNames(blank)}\n`
          : ""));
    }
    if (nObj || nAct) {
      // 规则抽出来的东西**不要**让模型复述一遍。让它复述 168 行既会丢行
      // （模型一定会截断），又要为零信息量的复制付 Opus 的钱。
      lines.push(
        `其中 ${nObj} 个对象` + (nAct ? `、${nAct} 个行动` : "")
        + "**已经由规则逐行抽好了，你不要重复抽，也不要改动它们**。\n"
        + `已抽出的对象名：${previewNames(pre.objects)}\n`);
    }
    if (pre.links.length > 0) {
      lines.push(
        `其中 ${pre.links.length} 条关系**已经由规则逐行抽好了**（两端对象名、`
        + "基数都来自表格原文），你不要重复抽、不要改两端的名字。"
        + "关系两端的对象在别的表里登记过，**不要在这一段把它们再抽成对象**。\n");
    }

    const owed = this.wants();
    const want = owed.map(askFor);
    // 宿主对象名就写在分组列里，直接摆给模型看。不给的话它只能满库检索去猜
    // ——真实材料上那是四轮 evidence.search 之后一个对象也没抽出来。
    if (owed.includes(Yield.OBJECTS)) {
      const hosts = hostNames(pre);
      if (hosts.length > 0) {
        lines.push(`这一段的宿主业务对象（分组列的取值，共 ${hosts.length} 个）：`
          + `${hosts.slice(0, 20).join("、")}\n`
          + "它们是中文业务名，要按命名规范给出 apiName；"
          + "同名的只出一次。\n");
      }
    }
    if (shape.yields.has(Yield.LINKS) || nObj) {
      want.push("对象之间的**关系**（主从、引用、头行结构）—— "
        + "材料里明确写了的才算，命名相似不构成关系");
    }
    if (shape.yields.has(Yield.RULES)) {
      want.push("散文里的**业务规则与约束**，挂到它约束的对象上");
    }
    if (want.length === 0) want.push("补齐上面规则没能确定的部分");

    if (!shape.yields.has(Yield.PROPERTIES)) {
      lines.push("⚠ **这一段没有字段列，因此没有属性可抽。**"
        + "不要为了凑数把行名、说明文字当成属性。\n");
    }

    return `${lines.join("")}\n`
      + "你要做的是：\n"
      + want.map((w, i) => `${i + 1}. ${w}`).join("\n")
      + `\n\n${this.segment.render(this.index)}\n\n`
      + "规矩：\n"
      + "- 出处用 ⟦⟧ 里的原样字符串，不要改写。\n"
      + "- 单元格里的说明文字（如「与某某一致」「见附件」）**不是实体名**。\n"
      + "- 材料里没提到的东西一个字都不要补。拿不准就去捞原文："
      + "按名字找用 evidence.search，按位置（第几行、哪张表）取用 evidence.rows。\n"
      + "- 捞回来是空的**不等于材料里没有** —— 先确认位置写对了再下结论。";
  }

  override query(_inputs: Record<string, unknown>): string {
    return `${this.segment.label} ${this.segment.fileName}`;
  }

  /** 把规则抽出的对象/行动并进模型产出。规则的那份是权威，冲突以它为准。 */
  override finalize(draft: unknown, _inputs: Record<string, unknown>): unknown {
    const pre = this.prefilled() as unknown as Record<string, unknown>;
    const src = isPlainDict(draft) ? draft : {};
    const out: Record<string, unknown> = { ...src };
    // questions 走单独分支：它的去重键不是 api_name，而且模型永远不该产出
    // 问题（schema 里没有这个字段），规则那份直接全收。
    out["questions"] = asList(pyTruthy(pre["questions"]) ? pre["questions"] : []);
    for (const key of ["objects", "properties", "links", "actions"]) {
      const modelSide = asList(pyTruthy(out[key]) ? out[key] : []);
      const ruleSide = asList(pyTruthy(pre[key]) ? pre[key] : []);
      if (ruleSide.length === 0) {
        out[key] = modelSide;
        continue;
      }
      // **属性的去重键必须带宿主。** 上一版只按裸 api_name：
      // PurchaseOrder.amount 和 Supplier.amount 撞键，模型抽的第二个被当成
      // "重复"整条丢掉 —— 不同对象上的同名字段是常态（编号/金额/状态哪张表都有）。
      const keyOf = (x: unknown): string => {
        if (!isPlainDict(x)) return "";
        const api = pyStrip(pyStr(dgetD(x, "api_name", ""))).toLowerCase();
        if (key !== "properties") return api;
        return `${pyStrip(pyStr(dgetD(x, "parent_api_name", ""))).toLowerCase()}::${api}`;
      };
      const ruleByKey = new Map<string, Record<string, unknown>>();
      for (const x of ruleSide) {
        if (isPlainDict(x)) ruleByKey.set(keyOf(x), x as Record<string, unknown>);
      }
      // 同键相遇时不是丢掉模型那份，而是**嫁接**：规则那份权威（名字/类型/必填
      // 逐行搬自表格，带出处），但这一段专门跑一轮模型就是为了拿**口径** ——
      // outstanding() 的注释早就承诺了「规则搬完之后仍向模型索要，由 finalize()
      // 合并（规则侧权威）」，而上一版 finalize 只会丢，从没合过：
      // 模型写出的 definition 被原样扔掉，规则行的口径永远是空。
      if (key === "properties") {
        for (const x of modelSide) {
          const hit = ruleByKey.get(keyOf(x));
          if (hit === undefined || !isPlainDict(x)) continue;
          for (const f of ["definition", "unit", "semantic_type", "value_domain"]) {
            const mine = hit[f];
            const theirs = (x as Record<string, unknown>)[f];
            if (!pyTruthy(mine) && pyTruthy(theirs)) hit[f] = theirs;
          }
        }
      }
      out[key] = [
        ...ruleSide,
        ...modelSide.filter((x) => isPlainDict(x) && !ruleByKey.has(keyOf(x))),
      ];
    }
    return out;
  }

  /** agent loop 里的工具调用。 */
  override dispatch(action: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return dispatchTool(action, ctx);
  }
}

/**
 * 散文段的抽取。和实体抽取是两件事，所以是两个 handler、两套 schema。
 *
 * 之前这类段落走的是实体抽取那条路：让模型从"采购计划员职责：1、负责……"里抽
 * ObjectType。模型照做了，抽出一堆「与采购需求计划一致」这样的伪实体；抽对的
 * 那部分（规则本身）反而因为 schema 里没有容器被整段丢掉，critic 只能报一句
 * "什么都没抽出来"。**没地方放的东西，模型抽得再准也等于没抽。**
 */
export class MineRules extends NodeHandler {
  readonly segment: Segment;
  readonly index: SegmentIndex;

  constructor(segment: Segment, index: SegmentIndex, agent: AgentSpecLike, system: string) {
    super();
    this.segment = segment;
    this.index = index;
    this.schema = agent.outputSchema;
    this.system = system;
  }

  override task(_inputs: Record<string, unknown>): string {
    return `下面这段是散文，不是表格。${this.segment.shape.describe()}\n\n`
      + "把里面**可判定**的业务规则一条条挖出来：谁、在什么条件下、能做或不能做"
      + "什么。一段话里编号列了几条就是几条，不要合并。\n"
      + "规则约束哪个业务对象 —— 只有材料里点了名的才填 applies_to，"
      + "拿不准留空（留空会转成一个反问，挂错则会把错误约束焊死）。\n\n"
      + `${this.segment.render(this.index)}\n\n`
      + "出处用 ⟦⟧ 里的原样字符串。";
  }

  override query(_inputs: Record<string, unknown>): string {
    return `${this.segment.label} 业务规则 约束 职责`;
  }

  override dispatch(action: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return dispatchTool(action, ctx);
  }
}

/**
 * 问卷段。**一次模型都不调。**
 *
 * 一行一个问题，列角色已经判定，映射完全确定 —— 让模型复述 150 行既会截断
 * 丢行，又要为零信息量的复制付 Opus 的钱。这一段的价值不在"理解"，在"一条
 * 不落地搬过来，并且每条都带着原始单元格的出处"。
 */
export class HarvestQuestions extends NodeHandler {
  readonly segment: Segment;
  readonly index: SegmentIndex;
  private _pre: ExtractOut | null = null;

  constructor(segment: Segment, index: SegmentIndex) {
    super();
    this.segment = segment;
    this.index = index;
    this.schema = null;
    this.system = "";
  }

  prefilled(): ExtractOut {
    if (this._pre === null) {
      const [rows, cites] = this.segment.rows(this.index);
      this._pre = structuralExtract(rows, cites, this.segment.shape, this.segment.carryIn);
    }
    return this._pre;
  }

  override task(_inputs: Record<string, unknown>): string {
    return `搬运问卷：${this.segment.label}`;
  }

  override skipModel(_inputs: Record<string, unknown>): unknown {
    return this.prefilled();
  }
}

/** 把各段的抽取结果合并成 OIR。结构组装是确定性的，不交给模型。 */
export class MergeSegments extends NodeHandler {
  readonly index: SegmentIndex;

  constructor(index: SegmentIndex) {
    super();
    this.index = index;
  }

  override task(_inputs: Record<string, unknown>): string {
    return "合并各段抽取结果";
  }

  override execute(
    inputs: Record<string, unknown>,
    _ctx: RunContext,
  ): Promise<Record<string, unknown[]>> {
    const merged: Record<string, unknown[]> = {
      // events 必须在这张表里 —— 合并按键遍历，不在表里的桶在这一步**静默蒸发**。
      // （A1 给 EXTRACTOR_SCHEMA 加了 events 桶；schema、merge、buildOir 三处
      //   同一份桶清单，漏一处就是"模型抽了、产物里没有、没人报错"。）
      objects: [], properties: [], links: [], actions: [], rules: [], questions: [], events: [],
    };
    // `inputs.values()` 是插入序；节点 id 形如 `EXTRACT.s0`，不会被 V8 当整数键重排。
    for (const out of Object.values(inputs)) {
      if (!isPlainDict(out)) continue;
      for (const k of Object.keys(merged)) {
        const v = out[k];
        merged[k]!.push(...asList(pyTruthy(v) ? v : []));
      }
    }
    return Promise.resolve(merged);
  }
}

// ══════════════════════════════════════════════════════════════════
//  OIR 组装
// ══════════════════════════════════════════════════════════════════

/** `build_oir` 的丢弃统计。**就地改写**调用方传进来的那个对象（Python 亦然）。 */
export interface DroppedStats {
  properties?: number;
  links?: number;
  property_parents?: string[];
  link_endpoints?: string[];
  /** 出处不存在，或真实出处与模型主张无关而被拒绝的条目。 */
  ungrounded?: number;
  /** 同一个对象上抽出两个同名字段，形如 `PurchaseOrder.amount`。 */
  property_dupes?: string[];
  [k: string]: unknown;
}

/**
 * 抽取结果 → OIR。
 *
 * 这一步全是确定性代码：查重、挂父子、推主键。让模型做这些只会引入随机性，
 * 而结构错了后面所有环节都跟着错。
 *
 * @param dropped 给了就把**丢弃统计**写进去。属性挂不上父对象、关系两端对不上名字
 *   时这里只能 `continue` —— 那是对的（挂错父亲比不挂更糟）。但原来丢得
 *   **完全无声**：模型在推理面板里说抽了 40 个字段，最后 OIR 里 3 个，
 *   FDE 只会归因成"模型不行"，而真实原因是名字对不齐、是能修的。
 *   丢失量必须可观测。
 */
export function buildOir(
  data: Readonly<Record<string, unknown>>,
  index: EvidenceIndex | null = null,
  dropped: DroppedStats | null = null,
): OIR {
  const oir = new OIR();
  const lost: DroppedStats = dropped !== null ? dropped : {};
  if (!("properties" in lost)) lost.properties = 0;
  if (!("links" in lost)) lost.links = 0;
  if (!("property_parents" in lost)) lost.property_parents = [];
  if (!("link_endpoints" in lost)) lost.link_endpoints = [];
  // property_dupes 是**懒建**的：不撞就不出现这个键 ——
  // 每一份丢弃统计里都挂一个空数组，只会让"有没有重复"这件事更难看出来。

  const lostProps = (): number => Number(lost.properties ?? 0);
  const lostLinks = (): number => Number(lost.links ?? 0);
  const propParents = lost.property_parents as string[];
  const noteDupe = (name: string): void => {
    if (!Array.isArray(lost.property_dupes)) lost.property_dupes = [];
    const arr = lost.property_dupes as string[];
    if (!arr.includes(name)) arr.push(name);
  };
  const linkEndpoints = lost.link_endpoints as string[];
  const supported = (item: unknown, bucket: GroundedBucket): boolean => {
    if (index === null) return true;
    if (extractionEvidenceSupport(item, bucket, index).ok) return true;
    lost.ungrounded = Number(lost.ungrounded ?? 0) + 1;
    return false;
  };
  /**
   * 行级 cite 只能证明“这行与对象/行动有关”，不能证明行里的每个字段都是真的。
   * 字段只有在同一真实切片（render/raw/context）中逐字出现时才算 EXTRACTED；
   * 否则保留为明确的 INFERRED 候选，或在没有 Assertion 容器时直接省略。
   *
   * `_origin=rule` 的值来自 structuralExtract 的确定性搬运/归一化，可作为第二条
   * 受信路径（例如材料写“一对多”，规则层规范化成 ONE_TO_MANY）。模型抽取不走
   * 这条捷径。
   */
  const fieldSupported = (item: unknown, value: unknown, deterministicRule = false): boolean => {
    if (index === null) return true; // 老部署 / 离线调用保持原有行为
    if (deterministicRule && dget(item, "_origin") === "rule") return true;
    const chunk = extractionChunk(item, index);
    if (chunk === null) return false;
    const body = supportNorm([
      chunk.render,
      chunk.context,
      isPlainDict(chunk.raw) || Array.isArray(chunk.raw) ? JSON.stringify(chunk.raw) : chunk.raw,
    ].filter((x) => x !== null && x !== undefined).join("\n"));
    const values = Array.isArray(value) ? value : [value];
    const claims = values.map(supportNorm).filter(Boolean);
    return claims.length > 0 && claims.every((claim) => body.includes(claim));
  };
  const fieldAssertion = <T>(
    item: unknown,
    value: T,
    ev: Provenance,
    deterministicRule = false,
  ) => fieldSupported(item, value, deterministicRule) ? extracted(value, ev) : inferred(value);
  const supportedItems = (item: unknown, values: readonly string[]): string[] =>
    values.filter((value) => fieldSupported(item, value));

  const byApi = new Map<string, string>();
  /** 材料里明确声明的主键（对象 rid → 属性 apiName 列表）。属性建完后解析成 rid。 */
  const declaredPks = new Map<string, { names: string[]; ev: Provenance }>();
  /**
   * 分组列（「业务对象」那一列）的取值 → 该组**第一行**实体的 rid。
   *
   * 行动表和实体表之间唯一对得上的东西就是这个中文分组名：行动表写
   * 「业务对象=采购需求计划」，实体表把 pbpHeader/pbpLine/pbpRel 归在同一个
   * 「采购需求计划」下。取第一行不是随手挑的 —— Excel 里合并单元格的组首
   * 就是头实体（pbpHeader / poHeader），这是材料自己的书写顺序。
   * 没有这张表，112 行接口会全部变成挂不上宿主的孤儿。
   */
  const byGroup = new Map<string, string>();

  for (const o of asList(dgetD(data, "objects", []))) {
    const api = gstr(o, "api_name");
    if (!api || looksLikeProse(api)) continue; // 单元格说明文字不是实体名
    // 模型为满足行覆盖对读不出的行编的占位符（「MISSING_REQUIRED（第10行/
    // CF-10，内容未知）」）。占位符不是实体：该行读不出是一个**问题**，
    // 不是一个对象。api/display 任一命中都拦。
    if (PLACEHOLDER_RE.test(api) || PLACEHOLDER_RE.test(gstr(o, "display_name"))) continue;
    if (!supported(o, "objects")) continue;
    const rid = makeRid("ot", api);
    const rawGroup = gstr(o, "group");
    const group = rawGroup && fieldSupported(o, rawGroup, true) ? rawGroup : "";
    const existing = oir.objects.get(rid);
    if (existing !== undefined) {
      // 多段抽到同一个对象：保留先出现的，把别名并进去
      const alias = gstr(o, "display_name");
      if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
      byApi.set(api.toLowerCase(), rid);
      if (group && !byGroup.has(group)) byGroup.set(group, rid);
      continue;
    }
    const ev = prov(o, index);
    const desc = dget(o, "description");
    const cls = pyStr(pyTruthy(dget(o, "classification")) ? dget(o, "classification") : "");
    const display = pyTruthy(dget(o, "display_name")) ? pyStr(dget(o, "display_name")) : api;
    const added = oir.addObject(makeObjectType({
      rid,
      apiName: fieldAssertion(o, api, ev, true),
      displayName: fieldAssertion(o, display, ev, true),
      description: pyTruthy(desc) ? fieldAssertion(o, pyStr(desc), ev) : inferred(""),
      primaryKey: inferred<string[]>([]),
      ...(cls ? { classification: fieldAssertion(o, cls, ev) } : {}),
    }));
    // 声明主键先记 apiName —— 属性还没建，rid 解析要等属性循环之后
    const declaredPk = asList(dget(o, "primary_key")).map((x) => pyStr(x)).filter(Boolean);
    // 复合主键必须每一列都能在对象出处中找到；只找到一半不能升级成事实。
    if (declaredPk.length > 0 && declaredPk.every((name) => fieldSupported(o, name))) {
      declaredPks.set(rid, { names: declaredPk, ev });
    }
    byApi.set(api.toLowerCase(), rid);
    if (group && !byGroup.has(group)) {
      byGroup.set(group, rid);
      // 组首同时以业务名示人。这是一条**推断**，所以要进术语表让业务方
      // 确认 —— 「采购需求计划 = 采购业务计划头」对不对，只有他知道。
      if (!added.aliases.includes(group)) added.aliases.push(group);
    }
  }

  // 名字解析要认**显示名和别名**，不能只认 api_name。中文材料里跨段（乃至
  // 同段的规则抽取）唯一稳定的身份是中文名：主数据清单的关键属性列写宿主
  // 「物料主数据」，关系表写「供应商主数据 → 采购信息记录」，而实体登记段的
  // 模型各自现起英文 api_name —— 只按 api_name 对，属性挂不上、39 条带基数
  // 的关系整批 lost（记了账，但没人看见）。
  const byAnyName = new Map<string, string>();
  for (const [orid, ot] of oir.objects) {
    for (const nm of [ot.apiName.value, ot.displayName.value, ...ot.aliases]) {
      const k = pyStrip(pyStr(nm)).toLowerCase();
      if (k && !byAnyName.has(k)) byAnyName.set(k, orid);
    }
  }
  const resolveEnd = (raw: unknown): string | undefined => {
    const k = pyStrip(pyTruthy(raw) ? pyStr(raw) : "").toLowerCase();
    if (!k) return undefined;
    return byApi.get(k) ?? byAnyName.get(k);
  };

  asList(dgetD(data, "properties", [])).forEach((p, i) => {
    const parent = resolveEnd(dget(p, "parent_api_name"));
    const api = gstr(p, "api_name");
    if (parent === undefined || !api) {
      // 挂不上父对象就丢 —— 但**要记下来**。名字对不齐是能修的，
      // 静默丢弃会让人以为是模型没抽到。
      lost.properties = lostProps() + 1;
      const miss = gstr(p, "parent_api_name");
      if (miss && !propParents.includes(miss)) propParents.push(miss);
      return;
    }
    // Python 是 `p['parent_api_name']`（直接索引，缺键 KeyError）—— 上面已经
    // 靠它查到了 parent，所以这里必然有键。
    //
    // **rid 里不能有段内数组下标。** 上一版是 `${parent}_${api}_${i}`，
    // 真实库里直接看得到：`pt_person_name_0`、`pt_organization_org_name_1`。
    // 而模板回传是按 `(rid, 字段)` 匹配的（onto/audit.ts 的 ridFieldKey），
    // 于是这条链是：补料 → 重跑抽取（`_replay_flow_patches` 就是为这个设计的）
    // → 模型输出顺序一变 → rid 变 → **业务顾问填好的那份模板一格都对不上，
    // 而且不报错**。id 里嵌"这次恰好排第几"，等于把稳定标识绑在了模型的心情上。
    //
    // 去掉 `i` 之后同段内重名属性会撞 rid。上一版靠 `has(rid) return` 静默跳过 ——
    // 那也是错的（第二条被丢了却不计入 lost）。现在撞了就**记账**：
    // 同一个对象上出现两个同名字段，是模型抽重了或材料本身有歧义，都该被看见。
    // rid 用**宿主对象的 apiName**，不用草稿里写的那个名字：草稿可能写中文
    // 显示名（关键属性列的规则抽取就是），同一个属性从两条路进来必须撞同一个
    // rid，否则 pt_物料主数据_编码 和 pt_materialmaster_编码 并存。对 api_name
    // 直给的老路径，两者本来就是同一个串 —— rid 不变。
    const parentApi = oir.objects.get(parent)?.apiName.value
      ?? pyStr((p as Record<string, unknown>)["parent_api_name"]);
    const rid = makeRid("pt", `${parentApi}_${api}`);
    if (oir.properties.has(rid)) {
      lost.properties = lostProps() + 1;
      noteDupe(`${parentApi}.${api}`);
      return;
    }
    if (!supported(p, "properties")) return;
    const parentClaim = gstr(p, "parent_api_name");
    if (!fieldSupported(p, parentClaim, true)) {
      // 属性本身虽被提到，但“属于哪个对象”没有材料支持时不能静默焊到对象上。
      lost.properties = lostProps() + 1;
      lost.ungrounded = Number(lost.ungrounded ?? 0) + 1;
      if (parentClaim && !propParents.includes(parentClaim)) propParents.push(parentClaim);
      return;
    }
    const ev = prov(p, index);
    let bt: BaseType;
    try {
      bt = parseBaseType(pyStr(dgetD(p, "base_type", "STRING")).toUpperCase());
    } catch {
      bt = BaseType.STRING;
    }
    const unit = dget(p, "unit");
    const vd = asList(dget(p, "value_domain")).map((x) => pyStr(x)).filter(Boolean);
    const semType = pyStr(pyTruthy(dget(p, "semantic_type")) ? dget(p, "semantic_type") : "");
    const display = pyTruthy(dget(p, "display_name")) ? pyStr(dget(p, "display_name")) : api;
    const definition = pyTruthy(dget(p, "definition")) ? pyStr(dget(p, "definition")) : "";
    oir.addProperty(makePropertyType({
      rid,
      parent,
      apiName: fieldAssertion(p, api, ev, true),
      displayName: fieldAssertion(p, display, ev, true),
      baseType: fieldAssertion(p, bt, ev, true),
      // 历史离线调用把空 definition 也记为 EXTRACTED；有真实索引时，空值没有
      // 可引用的主张，明确留作 INFERRED。这样既收紧生产路径又不漂老产物。
      definition: index === null
        ? extracted(definition, ev)
        : definition ? fieldAssertion(p, definition, ev) : inferred(""),
      unit: pyTruthy(unit)
        ? fieldAssertion<string | null>(p, pyStr(unit), ev)
        : inferred<string | null>(null),
      required: inferred(pyTruthy(dget(p, "required"))),
      // A1：值域与语义类型。schema 里有坑位了，落库也要接住 —— 只声明不落，
      // 模型填了也是白填（那正是这一轮修的病）。
      ...(vd.length > 0
        ? { valueDomain: fieldAssertion<string[] | null>(p, vd, ev) }
        : {}),
      ...(semType
        ? { semanticType: fieldAssertion<string | null>(p, semType, ev) }
        : {}),
    }));
  });

  for (const l of asList(dgetD(data, "links", []))) {
    const src = resolveEnd(dget(l, "from_api_name"));
    const tgt = resolveEnd(dget(l, "to_api_name"));
    const api = gstr(l, "api_name");
    if (src === undefined || tgt === undefined || !api) {
      lost.links = lostLinks() + 1;
      for (const got of [dget(l, "from_api_name"), dget(l, "to_api_name")]) {
        const nm = pyStrip(pyTruthy(got) ? pyStr(got) : "");
        if (nm && byApi.get(nm.toLowerCase()) === undefined && !linkEndpoints.includes(nm)) {
          linkEndpoints.push(nm);
        }
      }
      continue;
    }
    const rid = makeRid("lt", api);
    if (oir.links.has(rid)) continue;
    if (!supported(l, "links")) continue;
    const ev = prov(l, index);
    let card: Cardinality;
    let flipped = false;
    const rawCard = pyStr(dgetD(l, "cardinality", "ONE_TO_MANY")).toUpperCase();
    // MANY_TO_ONE 是合法的建模说法，用方向来表达：对调两端落成 ONE_TO_MANY。
    // 以前这条路径静默改成 ONE_TO_MANY **不对调** —— 和对话路径（oir_edit 的
    // add_batch 会对调）语义相反，同一句话两条路两个意思。
    if (rawCard === "MANY_TO_ONE") {
      card = Cardinality.ONE_TO_MANY;
      flipped = true;
    } else {
      try {
        card = parseCardinality(rawCard);
      } catch {
        card = Cardinality.ONE_TO_MANY;
      }
    }
    const [linkSrc, linkTgt] = flipped ? [tgt, src] : [src, tgt];
    // join_key：{from_property, to_property} → {from: to}。翻转时键值也要跟着换边。
    const jk = dget(l, "join_key");
    // join_key 是可选桶：缺席时 jk 是 undefined，对它 dget 会抛 —— 先判形状
    const jkFrom = isPlainDict(jk) ? pyStr(pyTruthy(jk["from_property"]) ? jk["from_property"] : "") : "";
    const jkTo = isPlainDict(jk) ? pyStr(pyTruthy(jk["to_property"]) ? jk["to_property"] : "") : "";
    const joinKey = jkFrom && jkTo
      ? (flipped ? { [jkTo]: jkFrom } : { [jkFrom]: jkTo })
      : null;
    oir.addLink(makeLinkType({
      rid,
      apiName: fieldAssertion(l, api, ev, true),
      source: linkSrc,
      target: linkTgt,
      cardinality: fieldAssertion(l, card, ev, true),
      joinKey: joinKey !== null
        ? (fieldSupported(l, [jkFrom, jkTo])
          ? extracted<Record<string, string> | null>(joinKey, ev)
          : inferred<Record<string, string> | null>(joinKey))
        : inferred<Record<string, string> | null>(null),
    }));
  }

  // 行动。宿主写的是中文名（"采购需求计划"），apiName 得靠显示名反查 ——
  // 行动表和实体表是两张表，它们之间只有中文名对得上。
  const byDisplay = new Map<string, string>();
  for (const [rid, ot] of oir.objects) {
    const disp = pyStrip(ot.displayName.value);
    if (!byDisplay.has(disp)) byDisplay.set(disp, rid);
    for (const a of ot.aliases) {
      const k = pyStrip(a);
      if (!byDisplay.has(k)) byDisplay.set(k, rid);
    }
  }

  for (const a of asList(dgetD(data, "actions", []))) {
    const api = gstr(a, "api_name");
    // 说明文字同样不是接口名。行动表里「与采购需求计划一致」这种格子，
    // 抽成一个行动之后既挂不上宿主，又会占着模板里的一行。
    if (!api || looksLikeProse(api)) continue;
    const rid = makeRid("at", api);
    if (oir.actions.has(rid)) continue;
    if (!supported(a, "actions")) continue;
    const host = resolveHost(a, byApi, byDisplay, byGroup);
    const ev = prov(a, index);
    const actActor = pyStr(pyTruthy(dget(a, "actor")) ? dget(a, "actor") : "");
    const actPre = asList(dget(a, "preconditions")).map((x) => pyStr(x)).filter(Boolean);
    const actEff = asList(dget(a, "effects")).map((x) => pyStr(x)).filter(Boolean);
    const groundedPre = supportedItems(a, actPre);
    const groundedEff = supportedItems(a, actEff);
    const objectClaim = gstr(a, "object") || gstr(a, "object_display");
    const groundedHost = host !== null && objectClaim && fieldSupported(a, objectClaim, true)
      ? host : null;
    const endpoint = pyTruthy(dget(a, "endpoint")) ? pyStr(dget(a, "endpoint")) : "";
    const endpointDisplay = pyTruthy(dget(a, "display_name"))
      && fieldSupported(a, pyStr(dget(a, "display_name")))
      ? pyStr(dget(a, "display_name")) : "";
    oir.addAction(makeActionType({
      rid,
      apiName: fieldAssertion(a, api, ev, true),
      appliesTo: groundedHost !== null ? [groundedHost] : [],
      // A1：语义字段落库。以前这里只写 apiName 和 endpoint —— schema 有
      // actor/preconditions/effects 的坑位、编辑面也能改，唯独抽取不填，
      // 于是「Action 出厂即空壳」（实测 parameters 0/121、actor 只有手补的 6 条）。
      ...(actActor ? { actor: fieldAssertion(a, actActor, ev) } : {}),
      ...(actPre.length > 0
        ? { preconditions: groundedPre.length === actPre.length
          ? extracted(groundedPre, ev) : inferred(actPre) }
        : {}),
      ...(actEff.length > 0
        ? { effects: groundedEff.length === actEff.length
          ? extracted(groundedEff, ev) : inferred(actEff) }
        : {}),
      sourceEndpoint: endpoint
        ? (fieldSupported(a, endpoint, true)
          ? extracted<Record<string, string> | null>({ path: endpoint, display: endpointDisplay }, ev)
          : inferred<Record<string, string> | null>({ path: endpoint, display: endpointDisplay }))
        : inferred<Record<string, string> | null>(null),
    }));
  }

  // 业务规则。挂不上对象的照样收下 —— 它会变成一个反问，而不是被丢掉。
  asList(dgetD(data, "rules", [])).forEach((r, i) => {
    const stmt = gstr(r, "statement");
    if (cpLen(stmt) < 6) return;
    const rid = makeRid("br", `${cpSlice(stmt, 40)}_${i}`);
    if (oir.rules.has(rid)) return;
    if (!supported(r, "rules")) return;
    const ev = prov(r, index);
    let rk: RuleKind;
    try {
      rk = parseRuleKind(pyStr(dgetD(r, "kind", "OTHER")).toUpperCase());
    } catch {
      rk = RuleKind.OTHER;
    }
    const hosts: string[] = [];
    for (const name of asList(pyTruthy(dget(r, "applies_to")) ? dget(r, "applies_to") : [])) {
      if (!fieldSupported(r, pyStr(name))) continue;
      const h = byApi.get(pyStr(name).toLowerCase())
        ?? byDisplay.get(pyStrip(pyStr(name)))
        ?? byGroup.get(pyStrip(pyStr(name)));
      if (h !== undefined && h !== "") hosts.push(h);
    }
    const cond = pyStr(pyTruthy(dget(r, "condition")) ? dget(r, "condition") : "");
    const actor = pyTruthy(dget(r, "actor")) ? pyStr(dget(r, "actor")) : "";
    oir.addRule(makeBusinessRule({
      rid,
      statement: extracted(stmt, ev),
      kind: fieldAssertion(r, rk, ev, true),
      appliesTo: hosts,
      actor: index === null
        ? extracted(actor, ev)
        : actor ? fieldAssertion(r, actor, ev) : inferred(""),
      ...(cond ? { condition: fieldAssertion(r, cond, ev) } : {}),
    }));
  });

  // 待澄清问题。已填答复的是**事实**（status=CONFIRMED，answer 带出处），
  // 未填的才是待办 —— 下游模板只搬未填的那部分。
  asList(dgetD(data, "questions", [])).forEach((q, i) => {
    const text = gstr(q, "text");
    if (cpLen(text) < 6) return;
    const code = dget(q, "code");
    const rid = makeRid("oq", `${pyTruthy(code) ? pyStr(code) : ""}_${cpSlice(text, 40)}_${i}`);
    if (oir.questions.has(rid)) return;
    const ev = prov(q, index);
    const ans = gstr(q, "answer");
    const appliesTo: string[] = [];
    for (const name of asList(pyTruthy(dget(q, "applies_to")) ? dget(q, "applies_to") : [])) {
      const h = byApi.get(pyStr(name).toLowerCase())
        ?? byDisplay.get(pyStrip(pyStr(name)))
        ?? byGroup.get(pyStrip(pyStr(name)));
      if (h !== undefined && h !== "") appliesTo.push(h);
    }
    oir.addQuestion(makeOpenQuestion({
      rid,
      text: extracted(text, ev),
      options: asList(pyTruthy(dget(q, "options")) ? dget(q, "options") : []).map((x) => pyStr(x)),
      answer: ans ? extracted(ans, ev) : inferred(""),
      group: pyTruthy(dget(q, "group")) ? pyStr(dget(q, "group")) : "",
      code: pyTruthy(code) ? pyStr(code) : "",
      appliesTo,
      askedBy: "customer",
      status: ans ? Status.CONFIRMED : Status.CANDIDATE,
    }));
  });

  // ── 事件（A1 新桶）─────────────────────────────────────────
  // emitted_by 解析成 Action rid（认不出就存原样 —— 宁可粗也不丢）；
  // payload_objects 走 byApi/byDisplay。
  for (const e of asList(dgetD(data, "events", []))) {
    const api = gstr(e, "api_name");
    if (!api || looksLikeProse(api)) continue;
    const rid = makeRid("et", api);
    if (oir.events.has(rid)) continue;
    if (!supported(e, "events")) continue;
    const emitter = gstr(e, "emitted_by");
    const emitterRid = emitter ? makeRid("at", emitter) : "";
    const rawPayload = asList(dget(e, "payload_objects"))
      .map((x) => pyStrip(pyStr(x)))
      .filter((nm) => fieldSupported(e, nm));
    const payload = rawPayload
      .map((nm) => byApi.get(nm.toLowerCase()) ?? byDisplay.get(nm) ?? byGroup.get(nm) ?? "")
      .filter(Boolean);
    const eev = prov(e, index);
    const display = pyTruthy(dget(e, "display_name")) ? pyStr(dget(e, "display_name")) : api;
    oir.addEvent(makeEventType({
      rid,
      apiName: fieldAssertion(e, api, eev, true),
      displayName: fieldAssertion(e, display, eev, true),
      emittedBy: emitter && fieldSupported(e, emitter)
        ? [oir.actions.has(emitterRid) ? emitterRid : emitter]
        : [],
      payload,
    }));
  }

  // ── 主键 ──────────────────────────────────────────────────
  // 声明的优先：材料里明确标了主键（extracted，带出处）就用它；
  // apiName 以 id 结尾的启发式只做兜底（inferred —— 它就是猜的）。
  for (const [orid, decl] of declaredPks) {
    const o = oir.objects.get(orid);
    if (o === undefined) continue;
    const rids = decl.names
      .map((nm) => o.properties.find((pr) => {
        const pp = oir.properties.get(pr);
        return pp !== undefined && pp.apiName.value.toLowerCase() === nm.toLowerCase();
      }))
      .filter((x): x is string => x !== undefined);
    // 一个都解析不到就不写 —— 写一半的复合主键比不写更误导
    if (rids.length === decl.names.length && rids.length > 0) {
      o.primaryKey = extracted(rids, decl.ev);
    }
  }
  for (const o of oir.objects.values()) {
    if (o.primaryKey.value.length > 0) continue; // 声明过的不动
    const pk = o.properties.filter((r) => {
      const p = oir.properties.get(r);
      // Python 是 `oir.properties[r]`：不存在就 KeyError，不静默跳过。
      if (p === undefined) throw new Error(`KeyError: ${pyRepr(r)}`);
      return p.apiName.value.toLowerCase().endsWith("id");
    });
    if (pk.length > 0) o.primaryKey = inferred(pk.slice(0, 1));
  }
  return oir;
}

/** 单元格里的说明文字被当成实体名，是真实材料上最常见的抽取噪声。
 * 「与采购需求计划一致」「见附件」这种不是对象。
 *
 * **按命中方式分三档，不是一把子串**。上一版对全部提示词做 `includes` ——
 * `looksLikeProse("采购策略") === true`（命中「略」）、「无形资产」命中「无」、
 * 「一致性校验」命中「一致」：**合法中文对象名被当噪声静默丢掉**。
 * 单字提示只能整格匹配；「一致」只在句尾才是"照抄上文"的意思；
 * 只有「见附件/参见/详见」这类短语出现在哪里都是说明文字。 */
export const PROSE_EXACT: readonly string[] = ["略", "无", "同上", "同前", "待定"];
export const PROSE_SUFFIX: readonly string[] = ["一致", "如下", "以上", "即可"];
export const PROSE_CONTAINS: readonly string[] = ["见附件", "参见", "详见"];
/** 兼容导出（有测试和下游按名字引它）。语义以上面三档为准。 */
export const PROSE_HINTS: readonly string[] = [...PROSE_EXACT, ...PROSE_SUFFIX, ...PROSE_CONTAINS];

/** 占位符实体名：模型对读不出的行编出来交差的名字。整词短语，不收单字 ——
 * 「未知」两个字会误杀「未知数管理」这类合法名。 */
export const PLACEHOLDER_RE = /内容未知|无法识别|未能识别|不可读|missing_required|unknown_row|placeholder/iu;

/** 代码风格的标识符。长度判据对它**不成立** ——
 * `bdPurchaseDocSubtypeMapping` 27 个字符，是个规规矩矩的 apiName；
 * 真实材料上这条把一批合法实体名报成了"说明文字"。 */
const CODE_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[_.\-][A-Za-z0-9]+)*$/;

export function looksLikeProse(name: unknown): boolean {
  const n = pyStrip(pyStr(name));
  if (!n) return true;
  if (CODE_NAME.test(n)) {
    // 标识符按标识符的规矩判：只有长到不像人会起的名字才算噪声
    return cpLen(n) > 64;
  }
  if (cpLen(n) > 24) return true;
  if (PROSE_EXACT.includes(n)) return true;
  if (PROSE_SUFFIX.some((h) => n.endsWith(h))) return true;
  return PROSE_CONTAINS.some((h) => n.includes(h));
}

/**
 * 一个行动挂在哪个对象上。四条线索**按可信度**依次试，绝不猜。
 *
 * 1. `object`：模型直接给了 apiName，最硬；
 * 2. `object_display` 命中某个实体的中文名或别名；
 * 3. `object_display` 命中分组列 —— 行动表和实体表之间的正规接缝；
 * 4. 分组名是某个实体名的**前缀或后缀**（「采购订单」⊂「采购订单头」）。
 *    只在唯一命中时采纳；命中多个说明这个名字有歧义，宁可挂空 ——
 *    挂空会变成一个反问，挂错会把错误的权限焊在错误的对象上。
 */
export function resolveHost(
  action: unknown,
  byApi: ReadonlyMap<string, string>,
  byDisplay: ReadonlyMap<string, string>,
  byGroup: ReadonlyMap<string, string>,
): string | null {
  const direct = byApi.get(gstr(action, "object").toLowerCase());
  if (direct !== undefined && direct !== "") return direct;
  const name = gstr(action, "object_display");
  if (!name) return null;
  const hit = byDisplay.get(name) ?? byGroup.get(name);
  if (hit !== undefined && hit !== "") return hit;
  const near: string[] = [];
  for (const [disp, rid] of byDisplay) {
    if (disp.startsWith(name) || disp.endsWith(name)) near.push(rid);
  }
  return new Set(near).size === 1 ? near[0]! : null;
}

/**
 * 按出处串还原 locator。
 *
 * 优先在索引里按 cite 精确匹配 —— 匹配上就拿到**真实的结构化 locator**，
 * 而不是把自由文本硬塞进字段（那会渲染成乱码，等于溯源失效）。
 *
 * 规则抽出来的条目 cite 是本地生成的、必然命中，置信度给满；模型给的 cite 可能
 * 是改写过的，命中也只给 0.85 —— 它证明的是"这句话在这里"，不是"这个判断对"。
 */
type GroundedBucket = "objects" | "properties" | "links" | "actions" | "events" | "rules";

interface ExtractionEvidenceVerdict {
  readonly ok: boolean;
  readonly code: "" | "EVIDENCE_MISSING" | "EVIDENCE_UNRESOLVED" | "EVIDENCE_NOT_SUPPORTING_CLAIM";
  readonly cite: string;
}

/** 精确定位模型声称使用的材料切片；定位不到时绝不拿条目自身内容补一份“证据”。 */
function extractionChunk(item: unknown, index: EvidenceIndex): Chunk | null {
  const cite = gstr(item, "source_locator");
  if (!cite) return null;
  const fname = gstr(item, "source_file");
  const table = citeIndex(index);
  let chunk = table.get(cite) ?? resolveCite(table, cite);
  if (chunk === null && fname) {
    for (const [key, candidate] of table) {
      if (key.endsWith(cite)) {
        chunk = candidate;
        break;
      }
    }
  }
  return chunk;
}

function supportNorm(value: unknown): string {
  return pyStrip(pyStr(value ?? ""))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function supportLabels(item: unknown, bucket: GroundedBucket): string[] {
  const values: unknown[] = bucket === "rules"
    ? [dget(item, "statement")]
    : bucket === "links"
      ? [dget(item, "from_api_name"), dget(item, "to_api_name"), dget(item, "display_name"), dget(item, "api_name")]
      : [dget(item, "display_name"), dget(item, "api_name")];
  const out: string[] = [];
  for (const value of values) {
    const label = supportNorm(value);
    if (!label || out.includes(label)) continue;
    // 单个字/字母几乎必然在无关原文中撞上，不能拿来证明一条业务主张。
    const han = [...label].some((ch) => /\p{Script=Han}/u.test(ch));
    if ([...label].length < (han ? 2 : 4)) continue;
    out.push(label);
  }
  return out;
}

/**
 * 材料引用的三层门：cite 存在、引用位置可解析、该切片确实提到了被抽取的对象。
 * 这是保守的字面支持检查：宁可把需要改写/推断的内容留作候选，也不能把它标成
 * “材料明确写了”。跨句推理应走待确认问题，不在这里自动升级成 EXTRACTED。
 */
export function extractionEvidenceSupport(
  item: unknown,
  bucket: GroundedBucket,
  index: EvidenceIndex,
): ExtractionEvidenceVerdict {
  const cite = gstr(item, "source_locator");
  if (!cite) return { ok: false, code: "EVIDENCE_MISSING", cite: "" };
  const chunk = extractionChunk(item, index);
  if (chunk === null) return { ok: false, code: "EVIDENCE_UNRESOLVED", cite };
  const body = supportNorm(chunk.render);
  const labels = supportLabels(item, bucket);
  const quote = supportNorm(dget(item, "source_quote"));
  if (quote && !body.includes(quote)) {
    return { ok: false, code: "EVIDENCE_NOT_SUPPORTING_CLAIM", cite };
  }
  let related = false;
  if (bucket === "links") {
    // 关系必须让两端都在同一切片里出现；只出现一端不能证明二者有关系。
    const ends = [dget(item, "from_api_name"), dget(item, "to_api_name")]
      .map(supportNorm)
      .filter(Boolean);
    related = ends.length === 2 && ends.every((label) => body.includes(label));
    if (!related) {
      const explicitRelationship = [dget(item, "display_name"), dget(item, "api_name")]
        .map(supportNorm)
        .filter((label) => [...label].length >= 4);
      related = explicitRelationship.some((label) => body.includes(label));
    }
  } else {
    related = labels.some((label) => body.includes(label));
  }
  return related
    ? { ok: true, code: "", cite }
    : { ok: false, code: "EVIDENCE_NOT_SUPPORTING_CLAIM", cite };
}

export function prov(item: unknown, index: EvidenceIndex | null): Provenance {
  const cite = gstr(item, "source_locator");
  const fname = gstr(item, "source_file");
  const byRule = dget(item, "_origin") === "rule";
  if (index !== null && cite) {
    const c = extractionChunk(item, index);
    if (c !== null) {
      return makeProvenance(c.fileId, c.fileName, c.locator, {
        snippet: cpSlice(c.render, 200),
        extractor: byRule ? "rule" : "llm",
        confidence: byRule ? 1.0 : 0.85,
      });
    }
  }
  const defn = dget(item, "definition");
  const disp = dget(item, "display_name");
  const snip = pyTruthy(defn) ? pyStr(defn) : pyTruthy(disp) ? pyStr(disp) : "";
  return makeProvenance(
    `f_${cpSlice(fname || "x", 6)}`,
    fname || "未知来源",
    { kind: "raw", ref: cite || "未标注位置" },
    {
      snippet: cpSlice(snip, 200),
      extractor: byRule ? "rule" : "llm",
      confidence: 0.6,
    },
  );
}

/**
 * cite 的写法归一。
 *
 * 索引里的 cite 是 `文件!表!R12-12`，而模型手写时常有两处偏差：
 *  · 单行写成 `R12`（索引里是 `R12-12`）；
 *  · 文件与表之间用 `#` 而不是 `!`（`#` 在索引里是给文件级引用留的）。
 * 这两种都是**同一个位置的不同写法**，认不出来的代价不是报错，而是悄悄退化成
 * 「证据 = 它自己的名字」的兜底（2026-08-25 真库：27 个对象里 24 个如此）。
 *
 * 只做写法归一，不做模糊匹配 —— 指不到就该如实回落，硬认一个更糟。
 */
function normalizeCite(cite: string): string[] {
  const out = new Set<string>([cite]);
  const swapped = cite.replace("#", "!");
  out.add(swapped);
  for (const form of [...out]) {
    // R12 → R12-12（单行的两种写法）
    const single = form.replace(/!R(\d+)$/u, (_m, n: string) => `!R${n}-${n}`);
    out.add(single);
    // R12-12 → R12（反向，索引里存的是短写法时）
    const collapsed = form.replace(/!R(\d+)-\1$/u, (_m, n: string) => `!R${n}`);
    out.add(collapsed);
  }
  out.delete(cite);
  return [...out];
}

function resolveCite(table: Map<string, Chunk>, cite: string): Chunk | null {
  for (const form of normalizeCite(cite)) {
    const hit = table.get(form);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** cite → chunk。每条断言都全表扫一遍的话，162 个对象 × 326 个切片就是五万次
 * 字符串比较，而这张表在一次 build 里是不变的。 */
const CITE_CACHE = new WeakMap<EvidenceIndex, Map<string, Chunk>>();

function citeIndex(index: EvidenceIndex): Map<string, Chunk> {
  let table = CITE_CACHE.get(index);
  if (table === undefined) {
    table = new Map<string, Chunk>();
    for (const c of index.allChunks()) table.set(c.cite(), c);
    CITE_CACHE.set(index, table);
  }
  return table;
}

// ══════════════════════════════════════════════════════════════════
//  Critic
// ══════════════════════════════════════════════════════════════════

/**
 * `cn[y]` —— 判缺文案里那个中文名。
 *
 * **类型是完整的 `Record<Yield, string>`，不是 `Partial`。** 这不是洁癖：
 * 上一版是 Partial 且只写了三条，而 `CHECKED_YIELDS` 后来特意加进了 LINKS ——
 * 于是任何"本该抽出关系却一条都没抽到"的段，都会在下面那句取值上抛
 * `KeyError: 'links'`，**把整个抽取 run 崩掉**，而不是报一条 finding。
 * 两次改动隔了时间、只改了一边，类型没拦住。
 *
 * 写成完整 Record 之后，`Yield` 再加成员时**编译期**就会报这里缺一条 ——
 * 这类"两处要一起改"的耦合，靠人记是记不住的。
 */
const YIELD_CN: Readonly<Record<Yield, string>> = {
  [Yield.PROPERTIES]: "属性",
  [Yield.OBJECTS]: "对象",
  [Yield.ACTIONS]: "行动",
  [Yield.LINKS]: "关系",
  [Yield.RULES]: "业务规则",
  [Yield.QUESTIONS]: "待确认问题",
};

/**
 * 覆盖率视角 —— 拦住"看起来跑完了其实什么都没抽到"。
 *
 * 这是真实材料上最危险的失败：抽出一串对象名、零个属性，流水线一路绿灯跑到底，
 * 产出一份空模板。**规则能判的必须规则判** —— 靠人看统计数字是靠不住的。
 *
 * 按 `ctx.nodeId` 认领自己那一段，所以一个实例服务所有 fan-out 节点。
 *
 * **已知的 Python 侧缺陷，照迁不修**：`CHECKED_YIELDS` 里有 LINKS，
 * 而下面那张中文名表 `cn` 里没有。一张有两列标识符的表（`yields` 会带上 LINKS）
 * 走到这里就是 `KeyError: Yield.LINKS`。要修得在 Python 侧一起修。
 */
/**
 * 这一行是**表格结构**，不是一条业务数据吗。
 *
 * 2026-08-25 实拍：一张 sheet 里叠着三张子表，于是行里混着横幅行（整行合并，
 * 各列同值）、子表头行（这一行的取值就是下面几行的列名）和序号行（「二、」）。
 * 它们被当成「漏掉的对象」逐条念给模型，模型于是把它们建成了对象 ——
 * `do.一` / `do.三` / `do.业务对象` 就是这么来的。
 *
 * 判据全是**形状**，不含任何词表：
 *  · 横幅：非空取值去重只剩 1 个，而这张表有 ≥3 列（合并单元格填充的痕迹）；
 *  · 序号：整格就是一个中文/阿拉伯数字序号（可带顿号句点），本身不是名字；
 *  · 子表头回声：这一格的内容与本表的某个列名逐字相同。
 */
export function isStructuralRow(
  name: string,
  row: Record<string, unknown>,
  nameColumn: string,
): boolean {
  const cols = Object.keys(row);
  const values = cols.map((k) => pyStrip(pyStr(row[k] ?? ""))).filter((v) => v !== "");
  if (cols.length >= 3 && new Set(values).size <= 1) return true;
  const bare = name.replace(/[、,，.．。:：]+$/u, "");
  if (/^[一二三四五六七八九十百千]+$/u.test(bare) || /^\d+$/u.test(bare)) return true;
  // 序号开头且整格就是「N、某某」这种小标题（「二、规则体系明细」）——
  // 名称列里出现带序号前缀的整句，是分节标题的写法，不是对象名。
  if (/^(?:[一二三四五六七八九十百千]+|\d+)[、.．]/u.test(name)) return true;
  if (cols.some((k) => k !== nameColumn && pyStrip(k) === name)) return true;
  // 子表头回声：这一行有两格以上的内容与它**自己那一列的列名**逐字相同。
  // 数据行偶尔会有一格这样（一个叫「说明」的对象），两格同时中的只有表头。
  let echo = 0;
  for (const k of cols) {
    const v = pyStrip(pyStr(row[k] ?? ""));
    if (v !== "" && v === pyStrip(k)) echo += 1;
  }
  if (echo >= 2) return true;
  return false;
}

export class CoverageCritic extends Critic {
  private readonly _byKey: Map<string, Segment>;
  readonly index: SegmentIndex | null;

  constructor(segments: readonly Segment[], index: SegmentIndex | null) {
    super();
    this.name = "coverage";
    this._byKey = new Map(segments.map((s) => [s.key, s]));
    this.index = index;
  }

  override judge(draft: unknown, ctx: CriticContext): Promise<Verdict> {
    let findings: Finding[];
    try {
      const parts = ctx.nodeId.split(".");
      const seg = this._byKey.get(parts[parts.length - 1]!);
      findings = seg !== undefined ? this.check(draft, seg) : [];
    } catch (exc) {
      // Python 的 `async def judge` 抛出的异常是**被拒的 coroutine**，不是同步抛。
      // 评审面板是 `asyncio.gather` / `Promise.all` 并发跑多个视角的 —— 同步抛会
      // 让别的视角连数组都组不起来，而 Python 那边只是其中一个 future 被拒。
      return Promise.reject(exc instanceof Error ? exc : new Error(String(exc)));
    }
    return Promise.resolve(makeVerdict({
      lens: this.name,
      passed: !findings.some((f) => f.severity === Severity.HIGH),
      findings,
      note: `覆盖率视角 · ${findings.length} 条`,
    }));
  }

  /** 登记表按名称列点名缺行。没有可用名称列（或行读不回来）就给空数组，
   *  回落到纯数量阈值 —— 点名是增强，不是新的硬依赖。 */
  private missingRowNames(segment: Segment, objs: readonly unknown[]): string[] {
    const shape = segment.shape;
    const nameCol = shape.col(ColumnRole.IDENTIFIER)
      ?? shape.cols(ColumnRole.LABEL).filter((c) => c.fill >= 0.6)
        .sort((x, y) => y.fill - x.fill)[0] ?? null;
    if (nameCol === null || this.index === null) return [];
    let rows: Record<string, unknown>[];
    try {
      [rows] = segment.rows(this.index);
    } catch {
      return [];
    }
    const have: string[] = [];
    for (const o of objs) {
      if (!isPlainDict(o)) continue;
      for (const k of ["api_name", "display_name"]) {
        const v = pyStrip(pyStr(dgetD(o, k, ""))).toLowerCase();
        if (v) have.push(v);
      }
    }
    const missing: string[] = [];
    for (const r of rows) {
      const nm = pyStrip(pyStr(r[nameCol.name] ?? ""));
      if (!nm || looksLikeProse(nm) || isStructuralRow(nm, r, nameCol.name)) continue;
      const key = nm.toLowerCase();
      if (have.some((h) => h.includes(key) || key.includes(h))) continue;
      if (!missing.includes(nm)) missing.push(nm);
    }
    return missing;
  }

  /** 名称列上**去重后**的业务实体数 —— 「抽到几个」要和它比，不能和行数比。 */
  entityCount(segment: Segment): number | null {
    const shape = segment.shape;
    const nameCol = shape.col(ColumnRole.IDENTIFIER)
      ?? shape.cols(ColumnRole.LABEL).filter((c) => c.fill >= 0.6)
        .sort((x, y) => y.fill - x.fill)[0] ?? null;
    if (nameCol === null || this.index === null) return null;
    let rows: Record<string, unknown>[];
    try {
      [rows] = segment.rows(this.index);
    } catch {
      return null;
    }
    const names = new Set<string>();
    for (const r of rows) {
      const nm = pyStrip(pyStr(r[nameCol.name] ?? ""));
      if (!nm || looksLikeProse(nm) || isStructuralRow(nm, r, nameCol.name)) continue;
      names.add(nm.toLowerCase());
    }
    return names.size > 0 ? names.size : null;
  }

  check(draft: unknown, segment: Segment): Finding[] {
    if (!isPlainDict(draft)) {
      return [makeFinding({
        severity: Severity.HIGH, code: "EXTRACT_EMPTY", target: segment.key,
        claim: "抽取没有返回结构化结果", verifier: "type",
      })];
    }
    const objs = asList(pyTruthy(draft["objects"]) ? draft["objects"] : []);
    const props = asList(pyTruthy(draft["properties"]) ? draft["properties"] : []);
    const acts = asList(pyTruthy(draft["actions"]) ? draft["actions"] : []);
    // **links 桶必须读**。漏了它不是少判一类，是**恒判一类**：
    // `have.links` 为 undefined 时 outstanding() 一律当成"零关系"，于是任何
    // 形状带 LINKS 的段，无论模型抽没抽到关系，评审都判「一条都没抽到」——
    // 精炼循环反复重试直到烧穿预算，而抽得好好的那份被打成不合格。
    // （上一版这里更响：YIELD_CN 缺 links 直接抛 KeyError 把整个 run 崩掉。
    //   补了 YIELD_CN 之后崩变成了"永远失败"，比崩更难发现 —— 两处要一起修。）
    const lnks = asList(pyTruthy(draft["links"]) ? draft["links"] : []);
    const shape = segment.shape;
    const out: Finding[] = [];

    // 只对"这段确实应该有"的产出判缺失。以前这里假设"表里必有字段行"，在
    // 实体登记表上把"零属性"报成 HIGH，节点反复重试直到烧穿预算 —— 而零属性
    // 才是那张表的正确答案。判据必须来自形状，不能来自对材料的假设。
    //
    // 判据函数与 `ExtractSegment.wants()` 是同一个 —— critic 判缺的每一类，
    // 任务描述里都点名要过。两边各写各的判据是上一版真实卡死的成因。
    for (const y of outstanding(shape, {
      objects: objs, properties: props, links: lnks, actions: acts,
    })) {
      // 类型已保证穷尽（见 YIELD_CN 的注释）。留这一句是防运行时喂进来野值 ——
      // 但它现在是"不该发生"的兜底，不再是正常路径上的地雷。
      const cn = YIELD_CN[y] ?? pyStr(y);
      out.push(makeFinding({
        severity: Severity.HIGH,
        code: `${y.toUpperCase()}_MISSING`,
        target: segment.key,
        claim: `这段的形状是「${pyStr(shape.rowUnit)}」、${shape.rowCount} 行，`
          + `应该能抽出${cn}，实际一个都没有`,
        evidenceChecked: [segment.label],
        proposedFix: { action: "RETRY", hint: `逐行抽${cn}；${shape.note}` },
        verifier: "rule:coverage",
      }));
    }

    // 行覆盖：一行一实体的登记表，抽出的对象数应当与行数同量级。
    // 这才是这类材料真正的失败模式 —— 168 行只抽了 58 个，模型截断了。
    if (shape.rowUnit === "object" && shape.rowCount >= 10) {
      const names = new Set<string>();
      for (const o of objs) {
        if (isPlainDict(o)) names.add(pyStrip(pyStr(dgetD(o, "api_name", ""))).toLowerCase());
      }
      const got = names.size;
      // 登记表有名称列时，缺的是**哪几行**是可以算出来的。只报数量的 finding
      // 逼模型「逐行过一遍」重出全表；点名的 finding 一轮补齐。真实案发：
      // 36 行漏 3 行（91.7%），0.8 的量级阈值放行 —— 违约索赔单/监造计划/
      // 质量通知就此消失，连带关系表里指向它们的 2 条关系整批 lost。
      const missing = this.missingRowNames(segment, objs);
      // **分母要和被数的东西同量纲。** rowCount 数的是行，got 数的是对象，而
      // 同一个业务对象常横跨多行（采购计划占 3 行、执行偏差占 2 行）——
      // 拿 7 个对象去比 26 行的 80%，清单清干净了也永远不达标，hint 退化成
      // 「逐行过一遍，不要跳行」，模型只能去编。能数出去重实体数就用它。
      const denom = this.entityCount(segment) ?? shape.rowCount;
      if (got < denom * 0.8 || missing.length > 0) {
        out.push(makeFinding({
          severity: Severity.HIGH, code: "ROWS_DROPPED", target: segment.key,
          claim: `这段有 ${denom} 个待抽实体、一行一个对象，但只抽出 ${got} 个 —— `
            + `漏了 ${Math.max(denom - got, 0)} 个`
            + (missing.length > 0
              ? `。缺的行（按名称列）：${missing.slice(0, 12).join("、")}`
              : ""),
          evidenceChecked: [segment.label],
          proposedFix: {
            action: "RETRY",
            hint: missing.length > 0
              ? `把这些行补进来（其余已抽出的不要动）：${missing.slice(0, 12).join("、")}`
              : "逐行过一遍，不要跳行、不要合并",
          },
          verifier: "rule:coverage",
        }));
      }
    }

    if (shape.rowUnit === "question") {
      // 问卷段的产出是 questions。判它有没有对象等于问错了问题 —— 而报
      // HIGH 会让节点反复重试直到烧穿预算。
      if (!pyTruthy(draft["questions"])) {
        out.push(makeFinding({
          severity: Severity.HIGH, code: "QUESTIONS_MISSING", target: segment.key,
          claim: `这段 ${shape.rowCount} 行是待填问卷，一个问题都没抽出来`,
          verifier: "rule:coverage",
        }));
      }
      return out;
    }

    if (shape.rowUnit === "rule") {
      // 规则段的产出是 rules，判它有没有对象等于问错了问题
      if (!pyTruthy(draft["rules"])) {
        out.push(makeFinding({
          severity: Severity.HIGH, code: "RULES_MISSING", target: segment.key,
          claim: `这段 ${shape.rowCount} 行全是散文，一条业务规则都没挖出来`,
          proposedFix: { action: "RETRY", hint: "按编号逐条挖，可判定的才算" },
          verifier: "rule:coverage",
        }));
      }
      return out;
    }

    if (shape.rowUnit === "link") {
      // 关系表的产出是 links，一行一条。判它有没有对象是问错了问题 ——
      // 正是这个错问把 40 行关系表逼成了零关系 + 一堆假对象（critic 按行数
      // 要对象，模型只好把关系两端的名字当实体交差）。
      // 零 links 由上面 outstanding() 的 LINKS_MISSING 兜着；这里管**漏行**。
      if (lnks.length > 0 && lnks.length < shape.rowCount * 0.8) {
        out.push(makeFinding({
          severity: Severity.HIGH, code: "LINKS_DROPPED", target: segment.key,
          claim: `这段有 ${shape.rowCount} 行、一行一条关系，但只抽出 ${lnks.length} 条 —— `
            + `漏了 ${shape.rowCount - lnks.length} 行`,
          evidenceChecked: [segment.label],
          proposedFix: { action: "RETRY", hint: "逐行过一遍，不要跳行、不要合并" },
          verifier: "rule:coverage",
        }));
      }
      return out;
    }

    if (objs.length === 0 && props.length === 0 && acts.length === 0) {
      out.push(makeFinding({
        severity: Severity.HIGH, code: "EXTRACT_EMPTY", target: segment.key,
        claim: `这段 ${segment.chunkIds.length} 个切片什么都没抽出来`,
        verifier: "rule:coverage",
      }));
    }

    for (const o of objs) {
      const nameRaw = dget(o, "api_name");
      const name = pyTruthy(nameRaw) ? pyStr(nameRaw) : "";
      if (looksLikeProse(name)) {
        out.push(makeFinding({
          severity: Severity.MEDIUM, code: "PROSE_AS_ENTITY", target: name,
          claim: `「${name}」看起来是单元格里的说明文字，不是实体名`,
          verifier: "rule:prose",
        }));
      }
    }
    return out;
  }
}

/** 溯源视角 —— 每条断言都要指向材料里真实存在的位置。 */
/**
 * @param index 给了就多判一件事：这个 cite **解析得出来吗**。
 *
 * 只判「字段非空」是不够的：模型给一个格式对、却在索引里指不到任何切片的 cite，
 * 字段有值，于是 `prov()` 悄悄退化成兜底 —— locator.kind=raw、confidence 0.6、
 * snippet 就是条目自己的名字（「证据 = 它自己」）。2026-08-25 真库审计：一个会话
 * 27 个对象里 24 个如此，而 provenance 这一关三轮都判「0 条」。
 *
 * 这是一道发布前硬门：有材料索引时，缺出处、出处不存在、或出处与主张无关都
 * 是 HIGH。模型可以少抽、可以把内容留作待确认，但不能把猜测标成 EXTRACTED。
 */
export function provenanceCritic(index: EvidenceIndex | null = null): RuleCritic {
  const check = (draft: unknown): Finding[] => {
    if (!isPlainDict(draft)) return [];
    const out: Finding[] = [];
    if (index === null) {
      // 兼容没有 EvidenceIndex 的离线部署：仍保留旧的“缺引用可见”检查，
      // 但无法声称已核验出处真伪或相关性。
      for (const bucket of ["objects", "properties", "links"] as const) {
        for (const item of asList(pyTruthy(draft[bucket]) ? draft[bucket] : [])) {
          if (gstr(item, "source_locator")) continue;
          const target = pyStr(pyTruthy(dget(item, "api_name")) ? dget(item, "api_name") : "?");
          out.push(makeFinding({
            severity: Severity.MEDIUM,
            code: "EVIDENCE_MISSING",
            target,
            claim: `${bucket} 里有条目没给出处`,
            verifier: "rule:provenance",
          }));
        }
      }
      return out.slice(0, 12);
    }
    for (const bucket of ["objects", "properties", "links", "actions", "events", "rules"] as const) {
      for (const item of asList(pyTruthy(draft[bucket]) ? draft[bucket] : [])) {
        const target = pyStr(
          pyTruthy(dget(item, "display_name"))
            ? dget(item, "display_name")
            : pyTruthy(dget(item, "api_name"))
              ? dget(item, "api_name")
              : pyTruthy(dget(item, "statement"))
                ? dget(item, "statement")
                : "?",
        );
        const verdict = extractionEvidenceSupport(item, bucket, index);
        if (verdict.ok) continue;
        const claim = verdict.code === "EVIDENCE_MISSING"
          ? `${bucket} 里有条目没给材料出处`
          : verdict.code === "EVIDENCE_UNRESOLVED"
            ? `出处 ${verdict.cite} 在证据索引里指不到任何切片`
            : `出处 ${verdict.cite} 虽然存在，但原文不支持「${target}」`;
        out.push(makeFinding({
          severity: Severity.HIGH,
          code: verdict.code,
          target,
          claim,
          evidenceChecked: verdict.cite ? [verdict.cite] : [],
          proposedFix: {
            action: "RETRY",
            hint: "逐字引用真正支持该条目的材料；找不到就删除该候选并提出待确认问题",
          },
          verifier: "rule:provenance",
        }));
      }
    }
    return out.slice(0, 50);
  };
  return new RuleCritic("provenance", check);
}

// ══════════════════════════════════════════════════════════════════
//  DAG
// ══════════════════════════════════════════════════════════════════

/**
 * 按段数展开的抽取 DAG。
 *
 * `EXTRACT.*` 是通配依赖，所以 MERGE 天然是同步屏障 —— 各段并行抽，抽完
 * 才合并。不需要额外的 barrier 语法。
 */
export function buildDag(segments: readonly Segment[]): Dag {
  const d = new Dag("onto_extract", { freezeBefore: "EXTRACT" });
  d.add(makeNodeSpec({
    id: "EXTRACT",
    mode: NodeMode.PLAN_EXECUTE,
    handler: "extract",
    fanoutOver: "segments",
    // evidenceTopK=0：段内容已经在任务描述里，L2 再预灌一遍就是同样的东西喂
    // 两遍 —— 真实材料上这让每次调用涨到 90k 输入、9 段直接烧穿预算。
    // 要额外证据请用 evidence.search 工具按需捞。
    scope: makeScopeSpec({ evidenceTopK: 0 }),
    // wallclockS 现在真的是"单段跑多久"的上界 —— 墙钟已改成从拿到 permit 起算
    // （见 kernel/scheduler.ts），排队不再算在节点头上。实测单段 66~120 秒，
    // 给足是因为超时的代价是**整段白跑**，而这一档的成本远高于多等一会儿。
    // 900 曾被真实案发打穿：网关连接悬死时 backend 每次要等满 300s 超时才
    // 判负，3 次悬死 + 退避 + 一次真实生成 ≈ 1200s+（EXTRACT.s37_27 实测
    // 1258s），节点在**等待重试**里被判死。上界必须盖过 backend 的最坏重试
    // 链条：4×300s + 退避 + 生成 → 1800。
    budget: makeNodeBudget({ tokens: 24_000, iterations: 4, wallclockS: 1800 }),
    critics: ["coverage", "provenance"],
    criticRounds: 2,
    difficulty: Difficulty.HIGH,
    retries: 1,
  }));
  d.add(makeNodeSpec({
    id: "MERGE", mode: NodeMode.DETERMINISTIC, handler: "merge", deps: ["EXTRACT.*"],
  }));
  d.expand({ EXTRACT: segments.map((s) => s.key) });
  return d.freeze();
}

export function handlersFor(
  segments: readonly Segment[],
  index: SegmentIndex,
  agent: AgentSpecLike,
  system: string,
): Record<string, NodeHandler> {
  return {
    extract: new SegmentRouter(segments, index, agent, system),
    merge: new MergeSegments(index),
  };
}

/**
 * 一个 handler 服务所有 fan-out 实例，按 `fanout_key` 分派到对应的段。
 *
 * 比给每段注册一个 handler 干净：段是数据，不该变成注册表里的条目。
 */
export class SegmentRouter extends NodeHandler {
  private readonly _byKey = new Map<string, NodeHandler>();

  constructor(
    segments: readonly Segment[],
    index: SegmentIndex,
    agent: AgentSpecLike,
    system: string,
  ) {
    super();
    // 形状决定用哪个 agent —— 散文段交给 rule_miner，表格段交给 extractor。
    // 这是"计划冻结"允许的：形状来自列画像，不来自内容语义。
    //
    // Python 是 `default_agents().get("rule_miner")` 后再判 `is not None` ——
    // 而 `AgentLibrary.get` 找不到时抛 KeyError，那条判断实际上永远为真。
    // 照搬这个形状（取不到就炸），不把它"修"成静默降级：散文段悄悄走了实体
    // 抽取，产出的是一堆「与采购需求计划一致」这样的伪实体，没人会发现。
    const miner = defaultAgents().get("rule_miner");
    // 与 extractor 的装配保持一致：Agent system 带 Skill 目录，随后注入它显式
    // 声明的 Skill 全文。旧实现只调用 renderSystem(miner)，导致 frontmatter 里
    // 的「口径对齐」在生产路径从未生效，catalog 里的 Prompt 改得再好也到不了模型。
    const skills = defaultLibrary();
    const minerSystem = `${renderSystem(miner, skills)}\n\n${skills.load([...miner.skills])}`;
    for (const seg of segments) {
      if (seg.shape.rowUnit === "question") {
        this._byKey.set(seg.key, new HarvestQuestions(seg, index));
      } else if (seg.shape.rowUnit === "rule") {
        this._byKey.set(seg.key, new MineRules(seg, index, miner, minerSystem));
      } else {
        this._byKey.set(seg.key, new ExtractSegment(seg, index, agent, system));
      }
    }
    this.schema = agent.outputSchema;
    this.system = system;
  }

  override task(_inputs: Record<string, unknown>): string {
    return "抽取一段材料"; // 只在没走 forNode 时兜底
  }

  override forNode(nodeId: string): NodeHandler {
    const parts = nodeId.split(".");
    const key = parts[parts.length - 1]!;
    const h = this._byKey.get(key);
    if (h === undefined) {
      throw new Error(
        `KeyError: 节点 ${nodeId} 找不到对应的段（已知 `
        + `${pyReprList([...this._byKey.keys()].sort(cmpStrCp))}）`);
    }
    return h;
  }
}

// ══════════════════════════════════════════════════════════════════
//  下游（确定性）
// ══════════════════════════════════════════════════════════════════

/** `finish()` 的返回。**键名照 Python 的 dict**：事件载荷直接用它。 */
export interface FinishResult {
  align: Record<string, number>;
  merged: Record<string, unknown>[];
  uncertain: Record<string, unknown>[];
  align_gaps: Gap[];
  conflicts: Conflict[];
  auto_repaired: Record<string, unknown>[];
  clarify: ClarificationSet;
  suggestions: Record<string, unknown>[];
  template_spec: TemplateSpec;
}

/** 对齐 → 冲突 → 自动修 → 澄清排序 → 编译模板。全部确定性。
 *
 * `project` 在 Python 侧同样只是形参、函数体里不读它 —— 照搬，不"顺手"删掉：
 * 调用方（server 的 `_run_pipeline`）是按关键字传的。 */
export function finish(
  oir: OIR,
  opts: {
    endpoints?: readonly Record<string, unknown>[] | null;
    profiles?: Readonly<Record<string, Record<string, unknown>>> | null;
    maxQuestions?: number;
    project?: string;
  } = {},
): FinishResult {
  const [align, mergeLog] = alignAndApply(oir);
  const conflicts = detectAll(oir, {
    endpoints: opts.endpoints ?? null,
    profiles: opts.profiles ?? null,
  });
  const repaired = autoRepair(oir, conflicts);
  const cs = new ClarificationEngine({ maxQuestions: opts.maxQuestions ?? 3 })
    .rank(conflicts, oir);
  const spec = compileTemplate(oir, conflicts);
  // 建议在冲突之后算 —— 自动修补完的东西不该再拿出来建议一遍。
  //
  // align 拿不准的那些对要**带着出口**回去（见 gaps.alignmentGaps）：
  // 以前 uncertain 只进了摘要和一条事件载荷，等于系统看出来了却没告诉任何人。
  return {
    align: alignSummary(align),
    merged: mergeLog,
    uncertain: align.uncertain.slice(0, 8).map(pairScoreToDict),
    // `PairScore.total` 在 Python 侧是 property，`getattr(s,"total",0.0)` 取得到；
    // TS 的 PairScore 是纯数据 interface，排序键要在这里补上，否则 gaps 那边
    // 全部按 0 排，顺序跟 Python 对不上。
    align_gaps: alignmentGaps(oir, align.uncertain.map((s) => ({
      a: s.a, b: s.b, reasons: s.reasons, alias: s.alias, total: pairTotal(s),
    }))),
    conflicts,
    auto_repaired: repaired,
    clarify: cs,
    suggestions: suggest(oir),
    template_spec: spec,
  };
}

/** 给模型看的已抽对象名预览。只列名字 —— 列全了等于把 168 行又喂了一遍。 */
export function previewNames(items: readonly unknown[], limit = 12): string {
  const names: string[] = [];
  for (const x of items) {
    if (isPlainDict(x)) names.push(pyStr(dgetD(x, "api_name", "")));
  }
  const head = names.slice(0, limit).filter((n) => n).join("、");
  return head + (names.length > limit ? ` …（共 ${names.length} 个）` : "");
}
