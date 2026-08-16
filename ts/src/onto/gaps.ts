/**
 * 缺口挖掘 —— 把"材料没说清楚的地方"变成能发给业务方的问题。
 * 移植自 `src/ontocopilot/onto/gaps.py`，由 `golden/gaps.json` + `golden/pipeline.oir.json` 钉住。
 *
 * 问题清单以前只有两个来源：客户材料里**碰巧带着**的一张问卷（有就搬、没有就空），
 * 外加流程图上四条模板句。换一份没有问卷的材料，那张「待澄清问题」表就只剩三四行
 * 系统自问自答 —— 而材料里明摆着的空白一条都没被问出来：
 *
 *     「如提前XX天需要进行预警提醒」          ← 客户自己写的占位符
 *     「如超出XX金额，则采购包创建失败」        ← 阈值没定
 *     「实体间关系-待梳理」                    ← 一张标了名字、里面一行都没有的表
 *     「进度状态标准：未开始、执行中、…」        ← 一份要确认完整性的枚举
 *     112 个接口挂在 14 个业务对象上，其中 3 个在实体表里查无此名
 *
 * 这些才是 ERP 顾问和业务专家真正能答、也只有他们能答的东西。所以这里换成从
 * **证据**里挖，四条独立通道：
 *
 * 1. `undeterminedSlots` —— 材料自己写下的未定参数（XX / N / 若干 / 待定）；
 * 2. `emptyContainers` —— 声明了名字却没有内容的表/章节；
 * 3. `enumerations` —— 成套的取值清单，要确认有没有漏；
 * 4. `structuralGaps` —— OIR 建出来之后才暴露的缺口（挂不上宿主的行动、
 *    没有口径的对象、基数靠猜的关系、挂不到对象的规则）。
 *
 * 每条问题都带**原文出处**。业务方要能点回去看上下文才答得了 —— 一个没有出处的
 * 问题等于让人凭空想象，那还不如不问。这条判据同时决定了这个模块不做什么：
 * 挖不出出处的猜测一律不产出。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **正则里的 `\s` 与 `\d` 不等价**。Python 的 str 模式下 `\s` 是
 *     「Unicode White_Space ∪ U+001C–U+001F」，JS 的 `\s` 多了 U+FEFF、少了
 *     U+001C–U+001F；Python 的 `\d` 是整个 Unicode Nd 类（含全角 `０`），
 *     JS 的 `\d` 只有 ASCII `[0-9]`。两处都用显式判据写死（`PY_S` / `\p{Nd}`）——
 *     差一个字符的后果是"同一句被问两遍"或者"该问的没问"。
 *  2. **量词按 code point 数**。`{4,160}` / `{2,20}` / `{1,10}` 在 Python 里数的是
 *     code point，JS 不带 `u` 标志时数的是 UTF-16 code unit。所有正则一律带 `u`。
 *  3. **切片按 code point**。`text[:60]` / `snippet[:300]` / `statement[:70]` 全是
 *     中文，按 UTF-16 切会多切一倍、还可能把代理对劈开。见 `cpSlice`。
 *  4. **`len(s)` 是 code point 数**，长度阈值（`< 8` / `< 6` / `_ENUM_ITEM_MAX`）
 *     一律走 `cpLen`。
 *  5. **空 dict / 空 list 在 Python 里是假**。`locator or {"kind":"raw"}` 和
 *     `source_endpoint.value or {}` 靠的就是这条；照 JS 语义写这两条永远不触发。
 */

import {
  type Assertion,
  extracted,
  makeOpenQuestion,
  makeProvenance,
  makeRid,
  type OIR,
  type OpenQuestion,
  type Provenance,
} from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。与 `oir.ts` 里的同名私有函数同形（那边没导出）——
 * 这里 `locator or {"kind":"raw"}`、`source_endpoint.value or {}`、
 * `loc.get("sheet") or …` 三处都靠"空容器为假"，按 JS 语义写会全部失效。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(x)`。这条路径上的值来自 xlsx / JSON，只会是 str / int / None。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** `len(s)` —— Python 数 code point。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** `s[:n]` —— Python 按 code point 切。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `str.strip(chars)` —— 按 code point 集合裁两头。 */
function pyStripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i]!)) i += 1;
  while (j > i && set.has(cps[j - 1]!)) j -= 1;
  return cps.slice(i, j).join("");
}

/** Python 的 `\s`（str 模式）。JS 的 `\s` 与它有两处不同：JS 多 U+FEFF、
 * 少 U+001C–U+001F。dedup key 就是 `re.sub(r"\s+","",sent)` 算出来的 ——
 * 判据差一个字符就是"同一句被问两遍"。 */
const PY_S = "[\\p{White_Space}\\x1c-\\x1f]";

const PY_WS_RE = new RegExp(`${PY_S}+`, "gu");
const PY_LSTRIP_RE = new RegExp(`^${PY_S}+`, "u");
const PY_RSTRIP_RE = new RegExp(`${PY_S}+$`, "u");

/** `str.strip()`（不带参数）。JS 的 `trim()` 与 Python 的空白集差两处（见 `PY_S`），
 * 这里按 Python 的集合裁 —— 一个模块里两套空白定义迟早咬人。 */
function pyStrip(s: string): string {
  return s.replace(PY_LSTRIP_RE, "").replace(PY_RSTRIP_RE, "");
}

// ══════════════════════════════════════════════════════════════════
//  通用件
// ══════════════════════════════════════════════════════════════════

/**
 * 一处缺口。转成 `OpenQuestion` 之前的中间形态。
 *
 * Python 侧是带一个 `to_question()` 的 dataclass。TS 侧拆成"纯数据 interface +
 * 自由函数 `gapToQuestion`"：`to_question` 是纯变换、Gap 本身从不 JSON 往返，
 * 用 class 只会让测试里的结构比较多一层原型。
 */
export interface Gap {
  readonly text: string;
  readonly group: string;
  readonly kind: string;
  /** 出处。**尽量带真实 locator** —— 只有真 locator 才能在界面上点回原文高亮，
   * 把 cite 字符串塞进 raw.ref 只能渲染成一行文字。 */
  readonly prov: Provenance | null;
  readonly options: string[] | null;
  readonly appliesTo: string[] | null;
  /** 排序权重。同类里数值大的先问。 */
  readonly weight: number;
}

export function makeGap(p: {
  text: string;
  group: string;
  kind: string;
  prov?: Provenance | null;
  options?: string[] | null;
  appliesTo?: string[] | null;
  weight?: number;
}): Gap {
  return {
    text: p.text,
    group: p.group,
    kind: p.kind,
    prov: p.prov ?? null,
    options: p.options ?? null,
    appliesTo: p.appliesTo ?? null,
    weight: p.weight ?? 1.0,
  };
}

export function gapToQuestion(g: Gap): OpenQuestion {
  const ev = g.prov ? [g.prov] : [];
  return makeOpenQuestion({
    rid: makeRid("oq", `${g.kind}_${cpSlice(g.text, 60)}`),
    text: extracted(g.text, ...ev),
    options: [...(g.options ?? [])],
    group: g.group,
    code: "",
    appliesTo: [...(g.appliesTo ?? [])],
    askedBy: "system",
  });
}

/**
 * 切片。Python 侧全走 `getattr(c, …, 默认值)`，任何带这几个字段的对象都行 ——
 * `parse/base.ts` 的 `Chunk` 与 `kernel/memory` 的证据切片都能直接喂进来。
 */
export interface GapChunk {
  readonly file_id?: string;
  readonly file_name?: string;
  readonly locator?: Readonly<Record<string, unknown>> | null;
  readonly render?: unknown;
}

/** 解析器报出来的一条 finding。 */
export interface GapFinding {
  readonly kind?: string;
  readonly message?: string;
  readonly locator?: Readonly<Record<string, unknown>> | null;
}

/** 一份材料的解析结果。注意 `file_name` 是**必填** —— Python 侧 `empty_containers`
 * 里对 `file_id` 用 `getattr(d,"file_id","f")` 兜底、对 `file_name` 却是直接取属性，
 * 缺了就 AttributeError。这处不对称照搬进类型：缺 file_name 的文档进不来。 */
export interface GapDoc {
  readonly file_id?: string;
  readonly file_name: string;
  readonly findings?: readonly GapFinding[] | null;
}

/** 按切片建出处。切片自带 file_id / locator，直接用它们。 */
function provOf(chunk: GapChunk, snippet: string): Provenance {
  return makeProvenance(
    // `getattr(c,"file_id","f")` 只在**属性缺失**时兜底，值是空串照样用空串。
    chunk.file_id === undefined ? "f" : chunk.file_id,
    chunk.file_name === undefined ? "" : chunk.file_name,
    pyTruthy(chunk.locator) ? { ...chunk.locator } : { kind: "raw" },
    { snippet: cpSlice(snippet, 300), extractor: "rule", confidence: 1.0 },
  );
}

/** 一句话的边界。切出占位符所在的那一句，而不是把整段 800 字的规则塞进问题里。 */
const SENTENCE_RE = /[^。；;\n]{4,160}/gu;

/** 取 `at` 落在的那一句。找不到就退回前后各 40 字。
 *
 * `at` 是 UTF-16 下标（JS 正则给的就是它）。`start <= at < end` 这个比较在
 * UTF-16 与 code point 两种坐标下同序，所以这一步不用换算；只有末尾那个
 * `text[at-40:at+40]` 是真按 code point 数的，那里才换。 */
function sentenceAround(text: string, at: number): string {
  for (const m of text.matchAll(SENTENCE_RE)) {
    const start = m.index;
    if (start <= at && at < start + m[0].length) return pyStripChars(m[0], " 　、,，");
  }
  const cps = [...text];
  const cpAt = cpLen(text.slice(0, at));
  return pyStrip(cps.slice(Math.max(0, cpAt - 40), cpAt + 40).join(""));
}

/**
 * 切片所在的容器名（sheet / 章节 / 表）。
 *
 * 问题按它分组 —— **分组来自材料的结构**，不来自我们预设的一张流程节点表。
 * 换一份材料，分组名跟着换。
 */
function containerOf(chunk: GapChunk): string {
  const loc: Record<string, unknown> = pyTruthy(chunk.locator) ? { ...chunk.locator } : {};
  for (const k of ["sheet", "section", "object", "page"]) {
    if (pyTruthy(loc[k])) return pyStr(loc[k]);
  }
  return "";
}

// ══════════════════════════════════════════════════════════════════
//  1. 材料自己写下的未定参数
// ══════════════════════════════════════════════════════════════════

/**
 * 占位符的写法。**判据是"这里本该有个值、但写的是占位符"**，不是关键词表 ——
 * 所以 `XX天`/`N 天`/`百分之多少`/`若干` 走的是同一条判据的不同写法。
 *
 * 每条都要求占位符**紧挨着量词或单位**（天/金额/次/%/元…），否则"XX 部门"
 * 这种正常缩写也会命中。
 */
const SLOT_PATTERNS: readonly (readonly [string, string])[] = [
  [
    `[XxＸ×]{2,}${PY_S}*(?:个)?(?:天|日|小时|分钟|周|月|年|次|人|元|万元|金额|比例|%|％)`,
    "数值未定",
  ],
  [`(?<![A-Za-z0-9])[NnＮ]${PY_S}*(?:个工作日|天|日|小时|次|人|元|万元)`, "数值未定"],
  ["百分之多少|多少个?(?:天|日|次|元|万元|%|％)", "数值未定"],
  ["若干|数个|数天|数次", "数值未定"],
  ["待定|待确认|待补充|待梳理|TBD|tbd|暂无|未定", "内容待定"],
  ["[（(]" + PY_S + "*[）)]|【" + PY_S + "*】|_{3,}|\\?{2,}|？{2,}", "内容留空"],
];

const SLOT_RE = new RegExp(
  SLOT_PATTERNS.map(([p], i) => `(?<p${i}>${p})`).join("|"),
  "gu",
);
/** `{f"p{i}": kind}` 的等价物。用数组而不是对象是为了让"按 p0…p5 的顺序取第一个
 * 命中的组"这件事在代码里看得见 —— Python 那边靠的是 dict 的插入序。 */
const SLOT_KIND: readonly (readonly [string, string])[] = SLOT_PATTERNS.map(
  ([, k], i) => [`p${i}`, k] as const,
);

/**
 * 材料里写着占位符的地方。
 *
 * 这是**客户自己标出来的**待办：他写「提前XX天预警」的时候就知道那个数没定。
 * 把它原样问回去，比我们凭空造一个问题准得多，也更容易被回答。
 */
export function undeterminedSlots(
  chunks: readonly GapChunk[],
  opts: { limit?: number } = {},
): Gap[] {
  const limit = opts.limit ?? 40;
  const out: Gap[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const text = pyTruthy(c.render) ? pyStr(c.render) : "";
    if (cpLen(text) < 8) continue;
    for (const m of text.matchAll(SLOT_RE)) {
      const groups = m.groups ?? {};
      const hit = SLOT_KIND.find(([g]) => groups[g] !== undefined);
      const kind = hit ? hit[1] : "内容待定";
      const sent = sentenceAround(text, m.index);
      if (cpLen(sent) < 6) continue;
      const key = cpSlice(sent.replace(PY_WS_RE, ""), 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makeGap({
        text: `「${sent}」—— 这里的取值是多少？材料里写的是占位符。`,
        group: containerOf(c) || "未定参数",
        kind: `slot:${kind}`,
        prov: provOf(c, sent),
        weight: 3.0,
      }));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  2. 声明了却空着的容器
// ══════════════════════════════════════════════════════════════════

/** 解析器报出来的"这个容器是空的"。不同解析器用不同的 kind，都归到这里 ——
 * 判据是解析层已经做出的事实判断，不是我们再猜一遍。 */
const EMPTY_FINDINGS: readonly string[] = ["empty_sheet", "empty_section", "unparsed_sheet"];

/**
 * 有名字、没内容的表或章节。
 *
 * 「实体间关系-待梳理」这种表名本身就是一句话：客户知道这里要有东西，只是还
 * 没写。这类缺口在任何材料上都成立 —— 判据是"声明了一个容器却一行都没有"，
 * 和这一份材料写了什么无关。
 *
 * 数据源是解析器的 findings。解析 xlsx 的时候它已经逐个 sheet 判过空并记了
 * 一条 `empty_sheet`；那条记录以前只是发给用户看一眼就没了下文，而它其实
 * 是整份材料里**最确定**的一处缺口。
 */
export function emptyContainers(docs: readonly GapDoc[]): Gap[] {
  const out: Gap[] = [];
  for (const d of docs) {
    for (const f of d.findings ?? []) {
      if (!EMPTY_FINDINGS.includes(f.kind ?? "")) continue;
      const loc: Record<string, unknown> = pyTruthy(f.locator) ? { ...f.locator } : {};
      const name = pyStrip(pyTruthy(loc["sheet"]) ? pyStr(loc["sheet"]) : "");
      if (!name) continue;
      out.push(makeGap({
        text: `材料里有一张叫「${name}」的表，但里面一行内容都没有。` +
          `这部分能补上吗？如果内容已经在别的文档里，请指出是哪一份。`,
        group: name,
        kind: "empty_container",
        prov: makeProvenance(
          d.file_id === undefined ? "f" : d.file_id,
          d.file_name,
          { kind: "range", sheet: name, rows: [1, 1] },
          // 这里**没有** [:300] —— Python 侧也没有，截断留给 provToDict。
          { snippet: f.message === undefined ? "" : f.message, extractor: "rule", confidence: 1.0 },
        ),
        weight: 5.0,
      }));
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  3. 成套的取值清单
// ══════════════════════════════════════════════════════════════════

/**
 * 「进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消」
 * 冒号前是清单的名字，冒号后是至少三个短取值。三个是下限 —— 两个的多半是
 * 一句被顿号断开的话，不是枚举。
 *
 * 分隔符**只认顿号**。真实取值清单从头到尾用同一个分隔符；一旦混进逗号，
 * 那多半是「关键物料，会造成项目停工、关键里程碑跳票」这种并列分句 ——
 * 逗号在中文里分的是句子，顿号分的才是并列的词。这一条判据比任何长度阈值
 * 都干净，而且不认任何业务词。
 */
const ENUM_RE = new RegExp(
  `(?<name>[^\\n：:；;。，,、）)]{2,20})${PY_S}*[：:]${PY_S}*` +
    "(?<body>[^\\n。；;：:，,]{1,10}(?:、[^\\n。；;：:，,]{1,10}){2,})",
  "gu",
);

/**
 * 一个取值域里的取值有多长。**这条判据是把枚举和"被顿号断开的一句话"分开的
 * 关键** —— 「未开始/执行中/已完成」都是 3~4 个字，而
 * 「局部轻微滞后/不影响整体项目节点/可由采购员自行协调处理」长度从 6 跳到 11，
 * 那是三个并列的分句，不是三个取值。
 */
const ENUM_ITEM_MAX = 8;
const ENUM_SPREAD_MAX = 5;

/** 名字里带这些就不是取值域的名字：拼接出来的列名、编号、半截括号。
 * `\d` 写成 `\p{Nd}` —— Python 的 `\d` 认全角 `０`，JS 的只认 ASCII。
 *
 * 判据分两段，**分界线是调用方"剥列表编号"那一步**（见 `enumerations`）：
 *
 *   · `BAD_RAW_NAME` 判**没剥过**的名字。`col1` 是解析器给无表头的列编出来的
 *     名字，那个数字就是它的一部分；剥成 `col` 之后判据再也够不着，一个凭空
 *     拼出来的列名就会被当成真取值域问出去。
 *   · `BAD_NAME` 判**剥过**的名字。剩下这几条要么与剥无关（`=`、半截括号），
 *     要么正是靠"剥不掉"才成立 —— 全角 `１` 和中文数字 `一.` 都不在 strip 那串
 *     字符里，`^\p{Nd}` 与中文数字那条拦的就是它们。
 *
 * 两段不能合并成一条去卡未剥的名字：`3.进度状态` 前面那个 `3.` 是列表编号，
 * 剥掉之后是个正经取值域，一并卡掉就成了反方向的漏问。
 */
const BAD_RAW_NAME = /col\p{Nd}/u;
const BAD_NAME = /=|[（(【]|^\p{Nd}|[一二三四五六七八九十]{1,2}[、.)]/u;

/**
 * 这串东西是不是一个**取值域**。
 *
 * 判据全部是结构性的（个数、长度、长度离散度、名字形态），不认任何业务词 ——
 * 换一份材料、换一个行业，同一套判据照样成立。
 *
 * `raw` 是材料里**原样**的名字（还没剥编号）。`col1` 这类拼出来的列名只有在
 * 这一份上才看得出来。缺省就是 `name` 自己。
 */
function isValueDomain(name: string, items: readonly string[], raw?: string): boolean {
  if (cpLen(name) < 2 || BAD_NAME.test(name)) return false;
  if (BAD_RAW_NAME.test(raw === undefined ? name : raw)) return false;
  if (!(items.length >= 3 && items.length <= 10)) return false;
  const lens = items.map(cpLen);
  if (Math.max(...lens) > ENUM_ITEM_MAX || Math.max(...lens) - Math.min(...lens) > ENUM_SPREAD_MAX) {
    return false;
  }
  // 取值里不该出现句读或结果引导词 —— 那说明这是句子不是标签
  for (const x of items) {
    for (const w of ["，", "。", "则", "需", "可由", "并"]) {
      if (x.includes(w)) return false;
    }
  }
  return true;
}

/**
 * 材料里列出来的取值清单，要业务方确认完不完整。
 *
 * 枚举是下游最贵的东西之一：漏一个状态，整条状态机就少一条边，而这类遗漏在
 * 做完之后极难发现。列在这里让人一眼扫过去补，成本最低。
 */
export function enumerations(
  chunks: readonly GapChunk[],
  opts: { limit?: number } = {},
): Gap[] {
  const limit = opts.limit ?? 12;
  const out: Gap[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const text = pyTruthy(c.render) ? pyStr(c.render) : "";
    for (const m of text.matchAll(ENUM_RE)) {
      const g = m.groups ?? {};
      const raw = g["name"] ?? "";
      const name = pyStripChars(raw, " 　\n0123456789.、）)①②③④⑤⑥⑦⑧⑨⑩");
      const items = (g["body"] ?? "").split("、").map(pyStrip).filter((x) => x !== "");
      if (!isValueDomain(name, items, raw) || seen.has(name)) continue;
      seen.add(name);
      out.push(makeGap({
        text: `「${name}」目前列了 ${items.length} 个取值：${items.join("、")}。` +
          `这份清单完整吗？还有没有别的取值？`,
        group: containerOf(c) || "取值清单",
        kind: "enum",
        prov: provOf(c, m[0]),
        options: [...items, "就这些，没有遗漏"],
        weight: 2.5,
      }));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  4. OIR 建出来之后才暴露的结构缺口
// ══════════════════════════════════════════════════════════════════

/** 每类结构缺口最多问几条。同一类问二十遍，业务方看到第三条就开始跳着填 ——
 * 挑最有代表性的几条，剩下的在模板别的表里逐行确认。 */
const PER_KIND = 6;

/**
 * 从建好的 OIR 上读缺口。
 *
 * 和前三条通道不同，这里的判据是**结构**不是文本：材料读完了、模型也抽完了，
 * 剩下这些空位就是这一轮真正没搞清楚的东西。
 */
export function structuralGaps(oir: OIR): Gap[] {
  const out: Gap[] = [];

  // 挂不上宿主的行动 —— 接口在，但不知道它改的是哪个单据
  const orphan = [...oir.actions.values()].filter((a) => a.appliesTo.length === 0);
  for (const a of orphan.slice(0, PER_KIND)) {
    const ep: Record<string, unknown> = pyTruthy(a.sourceEndpoint.value)
      ? { ...a.sourceEndpoint.value }
      : {};
    out.push(makeGap({
      text: `接口「${a.apiName.value}」` +
        (pyTruthy(ep["display"]) ? `（${pyStr(ep["display"])}）` : "") +
        "在材料里找不到它操作的业务对象。它改的是哪张单据？",
      group: "接口归属",
      kind: "action_no_host",
      prov: firstProv(a.apiName),
      weight: 4.0,
    }));
  }
  if (orphan.length > PER_KIND) {
    out.push(makeGap({
      text: `另有 ${orphan.length - PER_KIND} 个接口同样挂不上业务对象，` +
        `完整清单见「动作清单」表。是不是缺一份接口与单据的对照表？`,
      group: "接口归属",
      kind: "action_no_host_more",
      weight: 3.5,
    }));
  }

  // 挂不到对象的业务规则 —— 规则在，但不知道它约束谁
  const unbound = [...oir.rules.values()].filter((r) => r.appliesTo.length === 0);
  for (const r of unbound.slice(0, PER_KIND)) {
    out.push(makeGap({
      text: `这条规则管的是哪个单据？「${cpSlice(r.statement.value, 70)}」`,
      group: "规则归属",
      kind: "rule_no_host",
      prov: firstProv(r.statement),
      weight: 3.0,
    }));
  }

  // 基数靠猜的关系 —— 一对多还是多对多，直接决定下游能不能建对工作流
  const guessed = [...oir.links.values()].filter((lt) => lt.cardinality.evidence.length === 0);
  // 注意 `[:PER_KIND]` 在过滤 src/tgt 之前 —— 端点缺失的那几条占了名额然后被跳过，
  // 最终条数可能少于 PER_KIND。照搬，不"修好"。
  for (const lt of guessed.slice(0, PER_KIND)) {
    const src = oir.objects.get(lt.source);
    const tgt = oir.objects.get(lt.target);
    if (src === undefined || tgt === undefined) continue;
    out.push(makeGap({
      text: `「${src.displayName.value}」和「${tgt.displayName.value}」之间，` +
        `一条对应几条？材料里没写，系统按常见做法填的是 ${pyStr(lt.cardinality.value)}。`,
      group: "对应关系",
      kind: "link_cardinality",
      prov: firstProv(lt.apiName),
      options: ["一对一", "一对多", "多对多"],
      appliesTo: [lt.source, lt.target],
      weight: 2.0,
    }));
  }

  // 有名字没口径的对象 —— 只报总数，不逐个问：逐个问是「对象清单」表的活
  const nodesc = [...oir.objects.values()].filter((o) => pyStrip(o.description.value) === "");
  if (nodesc.length >= 3) {
    out.push(makeGap({
      text: `有 ${nodesc.length} 个业务对象只有名字、没有一句说明` +
        `（如 ${nodesc.slice(0, 5).map((o) => o.displayName.value).join("、")}）。` +
        `这些是同一套系统里的表吗？其中哪些是业务方真正会打交道的单据？`,
      group: "对象口径",
      kind: "object_no_description",
      weight: 2.0,
    }));
  }
  return out;
}

/** 断言的第一条出处。结构缺口的出处就是"这条断言是从哪儿抽出来的"。 */
function firstProv(assertion: Assertion<unknown> | undefined): Provenance | null {
  const ev = assertion?.evidence ?? [];
  return ev.length > 0 ? ev[0]! : null;
}

/** 对齐引擎给出的一对拿不准的候选。Python 侧是 `align.PairScore`，全走 getattr。 */
export interface UncertainPair {
  readonly a?: string;
  readonly b?: string;
  readonly total?: number;
  readonly reasons?: readonly string[] | null;
  readonly alias?: boolean;
}

/**
 * 对齐拿不准的那些对 —— **"这俩是不是一个东西"是 FDE 每天问上百次的问题。**
 *
 * 对齐引擎跑上千次比对，把"名字很像但没有结构证据"的一律压进 `uncertain`
 * —— 这个保守是对的（合并不可逆，假阳性是最贵的错），但 `uncertain`
 * 以前没有任何消费者：只进了一条 SSE 事件载荷和 CLI 的调试打印。
 * 系统看出来了、然后什么也没说。
 *
 * 尤其是登记表段产出的对象**天生零属性**（代码明说"零属性是正确结果"），
 * 于是这类对象之间的相似永远拿不到结构证据、永远落进 uncertain、永远沉默。
 * 别名字面完全相同的两个对象也是这个下场。
 *
 * 转成问题而不是自动合并 —— 出口是"问一句"，不是"替他决定"。
 */
export function alignmentGaps(
  oir: OIR,
  uncertain: readonly UncertainPair[] | null = null,
  limit: number = PER_KIND,
): Gap[] {
  const out: Gap[] = [];
  // Python 的 sorted 稳定，JS 的 Array.sort 从 ES2019 起也稳定 —— 同分的保持原序。
  const rows = [...(uncertain ?? [])].sort((x, y) => {
    const kx = -(x.total ?? 0.0);
    const ky = -(y.total ?? 0.0);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  for (const s of rows.slice(0, limit)) {
    const a = oir.objects.get(s.a ?? "");
    const b = oir.objects.get(s.b ?? "");
    if (a === undefined || b === undefined) continue;
    const why = (s.reasons ?? []).join("；") || "名称相近";
    out.push(makeGap({
      text: `「${a.displayName.value || a.apiName.value}」和` +
        `「${b.displayName.value || b.apiName.value}」是同一个业务对象吗？` +
        `（${why}）合并不可逆，所以我没有自己动手。`,
      group: "同义对象",
      kind: "alignment_uncertain",
      prov: firstProv(a.displayName) ?? firstProv(a.apiName),
      options: ["是同一个，合并", "不是，各自保留", "先放着，回头问客户"],
      appliesTo: [a.rid, b.rid],
      // 别名完全重合还拿不准的，排在最前 —— 那是最像真阳性的一档
      weight: s.alias ? 4.5 : 3.2,
    }));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  汇总
// ══════════════════════════════════════════════════════════════════

/**
 * 四条通道一起挖，去重后按权重排序。
 *
 * - `oir`: 已经建好的 OIR，结构缺口从它上面读。
 * - `docs`: 解析结果，用来发现空容器。
 * - `chunks`: 全部证据切片，用来扫占位符和枚举。
 * - `extra`: 别处已经生成的问题（如流程图缺口），一起参与去重与排序。
 * - `extraGaps`: 别的模块挖出来的缺口（如流程与接口对不上的地方），
 *   和这里挖的一起排序 —— 它们竞争的是同一份注意力，分开排会让某一类
 *   无条件排在另一类前面。
 * - `limit`: 最多产出多少条。**不是越多越好** —— 一份 200 行的问题清单
 *   发出去，回来的就是 200 个空格。
 */
export function mineQuestions(
  oir: OIR,
  opts: {
    docs?: readonly GapDoc[] | null;
    chunks?: readonly GapChunk[] | null;
    extra?: readonly OpenQuestion[] | null;
    extraGaps?: readonly Gap[] | null;
    limit?: number;
  } = {},
): OpenQuestion[] {
  const chunks = [...(opts.chunks ?? [])];
  const docs = [...(opts.docs ?? [])];
  const limit = opts.limit ?? 60;
  const gaps: Gap[] = [
    ...emptyContainers(docs),
    ...undeterminedSlots(chunks),
    ...enumerations(chunks),
    ...structuralGaps(oir),
    ...(opts.extraGaps ?? []),
  ];
  // `key=lambda g: -g.weight` + Python 稳定排序。用 `<`/`>` 而不是相减，
  // 与 Python 的比较语义一一对应。
  gaps.sort((x, y) => {
    const kx = -x.weight;
    const ky = -y.weight;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

  const extra = [...(opts.extra ?? [])];
  const out: OpenQuestion[] = [];
  const seen = new Set<string>(extra.map((q) => q.rid));
  // 材料里本来就有的问题（客户自己写的问卷）永远排在最前 —— 那是他自己
  // 提的疑问，比我们发现的任何缺口都更该先答。
  out.push(...extra);

  // **limit 只约束我们自己挖出来的那部分。**
  //
  // 以前 `out.length >= limit` 把 extra 也算进名额：extra 在生产里是客户自带问卷
  // ＋流程图缺口（server 那边就是这么传的），随便一份材料就能顶满 60，于是
  // 「系统发现材料里缺什么」这件事**一条都进不来、且悄无声息**。
  // 空容器、未定槽位、枚举缺失全被饿死 —— 产品最该主动说话的地方彻底哑掉。
  let mined = 0;
  for (const g of gaps) {
    const q = gapToQuestion(g);
    if (seen.has(q.rid)) continue;
    seen.add(q.rid);
    out.push(q);
    mined += 1;
    if (mined >= limit) break;
  }
  return out;
}
