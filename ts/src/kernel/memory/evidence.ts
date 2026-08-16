/**
 * L2 证据记忆 —— 原始材料的按需装载。移植自 Python 侧 `kernel/memory/evidence.py`，
 * 由 `golden/memory.evidence.json` 钉住（tokenize、cite 的每个分支、索引内部状态、
 * search 的每一组过滤/扩展/预算参数、by_locator、render）。
 *
 * 6 份材料展开可能上百万 token，**绝不全量装进上下文**。装载单元是带 locator 的
 * 切片，按当前处理的实体名/列名做检索，取 top-k 再做邻域扩展（表格的上下文经常
 * 在相邻行，只取命中行会丢掉表头和分组）。
 *
 * 这里用 BM25 而不是向量：本体建模的检索词是**专有名词**（`clmContract`、
 * `采购包头`、`plan_amount`），词形匹配比语义相似更准，而且零依赖、可解释、
 * 能在事件日志里复现。生产上可以叠一层向量做召回补充，接口留在 `search` 的
 * `rerank` 钩子上。
 *
 * ## 迁移期必须知道的一件事：同分顺序在 Python 侧就是不确定的
 *
 * `sorted(scores, key=-score)` 是稳定排序，同分条目保持 `scores` 的插入序；
 * 而那个插入序来自遍历 `candidates`——一个 **set**，迭代序取决于字符串哈希，
 * 也就是 `PYTHONHASHSEED`。实测同一份索引、同一个查询，五个种子给出五种顺序。
 * 所以"对齐 Python 的同分顺序"这件事**不存在可对齐的目标**。
 *
 * 这里把候选集换成 JS 的 `Set`（保插入序）→ 顺序固定为**倒排遍历序**：
 * 按查询词首次出现的顺序、每个词按其倒排表（= 建索引的插入序）依次收集。
 * 打分公式与过滤条件一字不改，分数不同的条目顺序与 Python 逐位一致；
 * 分数相同的条目 TS 侧从此可复现，产物 diff 不再有这一类噪声。
 */

import { estTokens } from "./types.js";

// ── 词法 ──────────────────────────────────────────────────────────

/**
 * Python: `[a-zA-Z][a-zA-Z0-9]*|\d+|[㐀-鿿]+`
 *
 * `\d` **不能**直译成 JS 的 `\d`：Python 的 `\d`（str 模式）匹配整个 Unicode Nd 类，
 * 全角的 `１２３`、阿拉伯-印度数字 `٤٢` 都算数字；JS 的 `\d` 只有 ASCII 0-9。
 * 真实材料里列名带全角数字并不罕见，直译会让那一列从此检索不到。
 *
 * `[㐀-鿿]` 是 U+3400–U+9FFF（扩展 A + 统一表意），**只有这一段** ——
 * 与 `types.estTokens` 的四段 CJK、与 `ids.slug` 的保留集都不是同一组区间，
 * 别拿其中一个去"补全"另一个。
 */
const TOKEN_RE = /[a-zA-Z][a-zA-Z0-9]*|\p{Nd}+|[㐀-鿿]+/gu;

/** Python: `(?<=[a-z0-9])(?=[A-Z])`。零宽断言，`split` 时切在位置上而不吃字符。 */
const CAMEL_RE = /(?<=[a-z0-9])(?=[A-Z])/u;

const CJK_LO = 0x3400;
const CJK_HI = 0x9fff;

/**
 * 分词 + camelCase 拆分 + 中文相邻二字组。
 *
 * `clmContract` 要能被 `contract` 命中 —— 材料里物理名和业务名混用是常态。
 *
 * 中文没有 camelCase 那样的天然切分，按单字切又区分度太低（`采`、`购`、`包`
 * 到处都是，跨领域尤其如此）。所以对每段连续汉字**同时**发单字（兜底召回）
 * 和相邻二字组（`采购`、`购包`，提精度）—— 这是 camelCase 拆分在中文上的对等物，
 * 纯词法、零依赖、检索与建索引走同一函数因而可复现。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  // `text || ""`：Python 侧写的是 `findall(text or "")`，None 也走空串
  for (const m of (text || "").matchAll(TOKEN_RE)) {
    const t = m[0];
    const head = t.codePointAt(0)!;
    if (head >= CJK_LO && head <= CJK_HI) {
      // 连续汉字段。这一段全在 BMP 内，逐 code unit 走就是逐码点走。
      for (const ch of t) out.push(ch); // 单字：召回
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); // 二字组：精度
      continue;
    }
    // 这一支的 token 只可能是 ASCII 字母数字或 Nd 数字，`toLowerCase` 与
    // Python 的 `str.lower()` 在这个子集上逐字符等价。
    const low = t.toLowerCase();
    out.push(low);
    if ([...t].length > 3 && CAMEL_RE.test(t)) {
      for (const p of t.split(CAMEL_RE)) out.push(p.toLowerCase());
    }
    // 死枝，但照抄：`_TOKEN_RE` 里没有任何分支能匹配到 `_`（`plan_amount` 一上来
    // 就被切成 `plan` / `amount` 两个 token），所以这个条件永远不成立。
    // 留着是为了两侧逐行对得上 —— 将来谁往 _TOKEN_RE 里加了 `_`，两边一起活过来。
    if (low.includes("_")) {
      for (const p of low.split("_")) if (p) out.push(p);
    }
  }
  return out;
}

// ── Python 语义的小原语 ───────────────────────────────────────────

/** Python 的真值：`""` / `0` / `false` / `None` / 空容器都是假。locator 里的值
 * 什么类型都可能有，`if loc.get(k)` 那几处必须按这套判，不能用 JS 的 `!!`。 */
function pyTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0; // NaN 在 Python 里是真值，这里也是
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python `repr()` 的字符串形态，供 `pyStr` 递归容器时用。单引号优先、内含单引号
 * 且不含双引号时改双引号 —— 与 `errors.pyRepr` 同一套规则，但那个函数在别人的
 * track 上，且这里只需要容器场景（locator 值几乎全是标量），不值得跨文件耦合。 */
function pyReprLite(v: unknown): string {
  if (typeof v !== "string") return pyStr(v);
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  let body = v.replace(/\\/g, "\\\\");
  if (q === "'") body = body.replace(/'/g, "\\'");
  return q + body + q;
}

/**
 * Python `str(v)` —— f-string 里 `{loc.get('row')}` 写出来的东西。
 *
 * 缺键时 Python 写字面量 `None`，JS 写 `undefined`：`cite()` 的结果会进 prompt、
 * 进产物的出处标注，差一个词就是"点回原文"点到一个不存在的位置。
 */
function pyStr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    // 已知分叉（与 journal.ts 同源）：JS 里 `1` 与 `1.0` 是同一个值，Python 的
    // `str(1.0)` 是 `"1.0"`。locator 的 row/page/col 在所有 parser 里都是 int 或
    // str，撞不上；真撞上了差的也只是这一处显示。
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyReprLite).join(", ")}]`;
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${pyReprLite(k)}: ${pyReprLite(val)}`,
    );
    return `{${parts.join(", ")}}`;
  }
  return String(v);
}

/**
 * Python `sorted()` 按**码点**比较字符串，JS 的 `Array.prototype.sort` 按 UTF-16
 * 码元。BMP 内两者一致，`U+FFFF` 与 `U+10000` 这种跨界比较才分叉 —— 而文件名里
 * 有 emoji 一点都不罕见（golden 的 `fZ` 那两条钉着）。
 *
 * `_expand` / `by_locator` 的排序基准都走这里。types.ts 里有同名私有函数，两处都
 * 很短且各自被 golden 钉着，不存在"改了一处忘了另一处"的静默风险。
 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/**
 * 从 locator 取"所属容器"的名字（sheet / section）。
 *
 * 这些是切片的结构归属：进 `render` 会造成逐行重复（见 tabular `_render_pairs`
 * 拼命消掉的那种重复），但进检索 token 流能让"按所属表 / 章节检索"成立。领域无关。
 */
function situate(loc: Readonly<Record<string, unknown>> | null | undefined): string {
  if (!pyTruthy(loc)) return "";
  const l = loc as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const k of ["sheet", "section"] as const) {
    if (pyTruthy(l[k])) parts.push(pyStr(l[k]));
  }
  return parts.join(" ");
}

// ── Chunk ─────────────────────────────────────────────────────────

/** `new Chunk(...)` 的入参。四个必填，其余走默认值。 */
export interface ChunkInit {
  readonly chunkId: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly locator: Record<string, unknown>;
  /** 给模型看的文本。 */
  readonly render: string;
  /** 给代码用的结构。 */
  readonly raw?: unknown;
  /** 文件内序号，邻域扩展靠它。 */
  readonly order?: number | undefined;
  readonly tags?: readonly string[] | undefined;
  /** 定位性上下文（所属表/章节的名字，或上游拼好的标题面包屑）。 */
  readonly context?: string | undefined;
}

/**
 * 一份材料的一个切片。
 *
 * `locator` 是这个产品的命脉：任何结论都要能点回原文的确切位置。
 * 格式见 `onto/oir` 的 `Provenance`。
 *
 * 字段全部可变，与 Python 的 `@dataclass(slots=True)`（非 frozen）一致。
 */
export class Chunk {
  chunkId: string;
  fileId: string;
  fileName: string;
  locator: Record<string, unknown>;
  render: string;
  raw: unknown;
  order: number;
  tags: string[];
  /**
   * 定位性上下文。**进检索 token 流、不进 render** —— 让"按所属容器检索"生效，
   * 又不把每行 render 撑重复。
   */
  context: string;

  constructor(p: ChunkInit) {
    this.chunkId = p.chunkId;
    this.fileId = p.fileId;
    this.fileName = p.fileName;
    // `locator` / `raw` **不复制**：Python 侧同样是直接持有引用。`raw` 是"给代码
    // 用的结构"（DataFrame 之类），复制它既贵又会切断上游的身份；`locator` 复制
    // 一份则会让"parser 先建 chunk 再补 locator 字段"这种写法静默失效。
    // `tags` 是 `field(default_factory=list)`，按契约 §1 复制。
    this.locator = p.locator;
    this.render = p.render;
    this.raw = p.raw ?? null;
    this.order = p.order ?? 0;
    this.tags = [...(p.tags ?? [])];
    this.context = p.context ?? "";
  }

  /** 这片占多少 token（按 render 估）。Python 侧是 `@property`。 */
  get tokens(): number {
    return estTokens(this.render);
  }

  /** 人可读的引用串，进 prompt 时贴在切片前面。 */
  cite(): string {
    const loc = this.locator;
    let tail: string;
    switch (loc["kind"]) {
      case "cell":
        tail = `!${pyStr(loc["sheet"] ?? "")}!R${pyStr(loc["row"])}C${pyStr(loc["col"])}`;
        break;
      case "range": {
        // Python: `loc.get("rows", [0, 0])` —— 只有**键缺失**才用默认值。
        const rows = "rows" in loc ? loc["rows"] : [0, 0];
        if (!Array.isArray(rows) || rows.length < 2) {
          // Python 在这里是 IndexError / TypeError 一路抛出去，不是静默给个 None。
          throw new TypeError(`range locator 的 rows 不可用: ${JSON.stringify(rows)}`);
        }
        tail = `!${pyStr(loc["sheet"] ?? "")}!R${pyStr(rows[0])}-${pyStr(rows[1])}`;
        break;
      }
      case "json":
        tail = `#${pyStr(loc["pointer"] ?? "")}`;
        break;
      case "ddl":
        tail = `#${pyStr(loc["object"] ?? "")}`;
        break;
      case "page":
        tail = `#p${pyStr(loc["page"])}`;
        break;
      case "meta":
        tail = `#${pyStr(loc["field"] ?? "")}`;
        break;
      case "xml":
        tail = `#${pyStr(loc["pointer"] ?? "")}`;
        break;
      default:
        tail = "";
    }
    return `${this.fileName}${tail}`;
  }
}

// ── 检索参数 ──────────────────────────────────────────────────────

/** `search` 的二次排序钩子（向量重排、cross-encoder）。 */
export type Rerank = (query: string, hits: Chunk[]) => Chunk[];

/**
 * `search` 的关键字参数。Python 侧全是 keyword-only，这里对应成一个 options 对象。
 *
 * **`null` 与 `undefined` 是"不过滤"，空数组是"全挡"** —— Python 侧
 * `set(files) if files is not None else None` 就是这个语义，`files=[]` 会把所有
 * 切片过滤光。同理 `budgetTokens: 0` 不是"不限"，是"一片都装不下"。
 */
export interface SearchOptions {
  readonly topK?: number | undefined;
  readonly files?: Iterable<string> | null | undefined;
  readonly kinds?: Iterable<unknown> | null | undefined;
  readonly tags?: Iterable<string> | null | undefined;
  /** 邻域半径。命中第 44 行时把 43/45 行也带上 —— 表格语义常常跨行。 */
  readonly expand?: number | undefined;
  /** 装载上限，超了就截断。**宁可少装也不能挤爆上下文。** */
  readonly budgetTokens?: number | null | undefined;
  /** 按文件轮转取结果，保证每个命中的文件都有代表。 */
  readonly diversifyByFile?: boolean | undefined;
  readonly rerank?: Rerank | null | undefined;
}

/** `by_locator` 的关键字参数。 */
export interface ByLocatorOptions {
  /** 文件名子串。空则不限。 */
  readonly file?: string | undefined;
  /** sheet / 章节 / 表名子串。空则不限。 */
  readonly container?: string | undefined;
  /** `[起, 止]` 闭区间行号。只对带行号的切片有效。 */
  readonly rows?: readonly [number, number] | null | undefined;
  /** 最多返回几片。 */
  readonly limit?: number | undefined;
}

// ── EvidenceIndex ─────────────────────────────────────────────────

/** 切片的 BM25 索引。 */
export class EvidenceIndex {
  static readonly K1 = 1.4;
  static readonly B = 0.72;
  /**
   * 命中后按标签加权 —— 规则/关系/外键切片承载建模决定性信息（基数、口径、
   * 引用），同等词法命中时应当排在普通正文前面。领域无关：这些标签是结构角色，
   * 不是某个业务域的词。只在已经有正命中时生效，不凭空把无关切片捞上来。
   */
  static readonly TAG_BOOST: Readonly<Record<string, number>> = {
    rule: 1.3,
    relation: 1.3,
    fk: 1.3,
  };

  private readonly _chunks = new Map<string, Chunk>();
  /** chunk_id → Counter(term)。Map 保插入序 = Python Counter 的迭代序。 */
  private readonly _tf = new Map<string, Map<string, number>>();
  private readonly _df = new Map<string, number>();
  private readonly _len = new Map<string, number>();
  private readonly _byFile = new Map<string, string[]>();
  /**
   * 倒排表 term → 含该词的 chunk_id。检索只需给候选打分，不用全库扫。
   * BM25 打分公式一字不改 —— 只是把"扫所有切片"换成"扫含查询词的切片"，
   * 结果逐位一致，可复现。
   */
  private readonly _postings = new Map<string, string[]>();
  private _avgLen = 0.0;
  /** `sum(self._len.values())` 的增量版。token 数都是整数，累加与全量求和**逐位相等**
   * （远不到 2^53），所以这个优化不改变 `_avgLen` 的任何一位。 */
  private _lenSum = 0;

  /** Python 的 `self.K1` 走实例→类查找，子类改了常量就跟着变。TS 的静态字段不会，
   * 所以这里显式从构造函数上取，保住同一条语义。 */
  private get cls(): typeof EvidenceIndex {
    return this.constructor as typeof EvidenceIndex;
  }

  // ── 建索引 ──────────────────────────────────────────────────
  add(chunk: Chunk): void {
    if (this._chunks.has(chunk.chunkId)) return;
    const toks = [
      ...tokenize(chunk.render),
      ...tokenize(chunk.fileName),
      ...tokenize(chunk.context),
      ...tokenize(situate(chunk.locator)),
    ];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    this._chunks.set(chunk.chunkId, chunk);
    this._tf.set(chunk.chunkId, tf);
    this._len.set(chunk.chunkId, toks.length);
    for (const t of tf.keys()) {
      this._df.set(t, (this._df.get(t) ?? 0) + 1);
      const post = this._postings.get(t);
      if (post === undefined) this._postings.set(t, [chunk.chunkId]);
      else post.push(chunk.chunkId);
    }
    const sibs = this._byFile.get(chunk.fileId);
    if (sibs === undefined) this._byFile.set(chunk.fileId, [chunk.chunkId]);
    else sibs.push(chunk.chunkId);
    this._lenSum += toks.length;
    this._avgLen = this._lenSum / Math.max(1, this._len.size);
  }

  addAll(chunks: Iterable<Chunk>): void {
    for (const c of chunks) this.add(c);
  }

  // ── 检索 ────────────────────────────────────────────────────
  search(query: string, opts: SearchOptions = {}): Chunk[] {
    const topK = opts.topK ?? 20;
    const expand = opts.expand ?? 1;
    const diversifyByFile = opts.diversifyByFile ?? true;
    const budgetTokens = opts.budgetTokens ?? null;
    const rerank = opts.rerank ?? null;
    // `== null` 一次挡掉 null 和 undefined：Python 那边"没传"就是 None，两者同义。
    const allow = opts.files == null ? null : new Set(opts.files);
    const kindAllow = opts.kinds == null ? null : new Set<unknown>(opts.kinds);
    const tagAllow = opts.tags == null ? null : new Set(opts.tags);

    const q = new Map<string, number>();
    for (const t of tokenize(query)) q.set(t, (q.get(t) ?? 0) + 1);
    if (q.size === 0 || this._chunks.size === 0) return [];

    const n = this._chunks.size;
    // 倒排候选：只看含至少一个查询词的切片。不含任何查询词的切片 BM25 分必为 0，
    // 本就会被 `s > 0` 丢掉，所以候选集之外一个不漏、结果逐位一致。
    const candidates = new Set<string>();
    for (const term of q.keys()) {
      const post = this._postings.get(term);
      if (post !== undefined) for (const cid of post) candidates.add(cid);
    }

    const { K1, B, TAG_BOOST } = this.cls;
    const scores = new Map<string, number>();
    for (const cid of candidates) {
      const ch = this.mustGet(cid);
      const tf = this._tf.get(cid)!;
      if (allow !== null && !allow.has(ch.fileId)) continue;
      // `loc.get("kind")` 缺键时是 `None`，不是 `undefined` —— `kinds=[None]`
      // 在 Python 侧会筛出"没有 kind 的切片"，`?? null` 把这条语义带过来。
      if (kindAllow !== null && !kindAllow.has(ch.locator["kind"] ?? null)) continue;
      if (tagAllow !== null && !ch.tags.some((t) => tagAllow.has(t))) continue;
      const dl = this._len.get(cid) || 1; // Python 的 `or 1`：长度 0 也当 1
      let s = 0.0;
      for (const [term, qc] of q) {
        const f = tf.get(term) ?? 0;
        if (!f) continue;
        const df = this._df.get(term)!;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = f + K1 * (1 - B + (B * dl) / Math.max(1e-9, this._avgLen));
        s += idf * ((f * (K1 + 1)) / denom) * qc;
      }
      if (s > 0) {
        // Python 是 `max(生成器, default=1.0)`：tags 为空才取默认 1.0，
        // 非空时就是标签自身的最大加权（子类把某个标签调到 <1 也照样生效）。
        let boost = 1.0;
        for (let i = 0; i < ch.tags.length; i++) {
          const b = TAG_BOOST[ch.tags[i]!] ?? 1.0;
          boost = i === 0 ? b : Math.max(boost, b);
        }
        scores.set(cid, s * boost);
      }
    }

    // 稳定排序 + 降序。同分保持 candidates 的插入序（= 倒排遍历序，确定）。
    let ranked = [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
    ranked = diversifyByFile ? this.roundRobin(ranked, topK) : ranked.slice(0, topK);
    let hits = expand ? this.expandNeighbors(ranked, expand) : ranked.map((c) => this.mustGet(c));

    if (rerank !== null) hits = rerank(query, hits);
    if (budgetTokens === null) return hits;

    const out: Chunk[] = [];
    let spent = 0;
    for (const c of hits) {
      // `continue` 不是 `break`：装不下的跳过，后面更小的切片还有机会进来。
      if (spent + c.tokens > budgetTokens) continue;
      out.push(c);
      spent += c.tokens;
    }
    return out;
  }

  /**
   * 按文件轮转取结果，文件内保持原排名。
   *
   * 效果是"每个命中的文件先拿一个名额，再按分数补齐"。这让检索结果天然带上
   * 来源多样性，而多样性正是跨文件冲突检测的前提：「计划金额」的两个口径分别
   * 在 xlsx 批注和 DDL 注释里，纯按分数取 top-k 时中文密集的切片会把 DDL 挤出去，
   * 跨文件冲突就永远发现不了。宁可牺牲一点单点精度，也要保证证据的来源多样性。
   */
  private roundRobin(ranked: string[], topK: number): string[] {
    const buckets = new Map<string, string[]>();
    for (const cid of ranked) {
      const f = this.mustGet(cid).fileId;
      const b = buckets.get(f);
      if (b === undefined) buckets.set(f, [cid]);
      else b.push(cid);
    }
    // 文件之间按各自最高分排序，保证最相关的文件先出。桶是按 ranked 顺序建的，
    // 这一步实际已经有序 —— 照抄 Python 的写法，免得将来谁改了建桶顺序才发现。
    const order = [...buckets.keys()].sort(
      (a, b) => ranked.indexOf(buckets.get(a)![0]!) - ranked.indexOf(buckets.get(b)![0]!),
    );
    const out: string[] = [];
    let i = 0;
    while (out.length < topK && order.some((f) => buckets.get(f)!.length > i)) {
      for (const f of order) {
        const b = buckets.get(f)!;
        if (b.length > i) {
          out.push(b[i]!);
          if (out.length >= topK) break;
        }
      }
      i += 1;
    }
    return out;
  }

  /** 按文件内序号做邻域扩展，保持原文顺序。 */
  private expandNeighbors(chunkIds: string[], radius: number): Chunk[] {
    // Python 用的是 `dict[str, None]` + setdefault —— 要的就是"去重且保插入序"，
    // 那正是 JS `Set` 的语义。
    const picked = new Set<string>();
    for (const cid of chunkIds) {
      const c = this.mustGet(cid);
      const sibs = this._byFile.get(c.fileId) ?? [];
      const i = sibs.indexOf(cid);
      if (i < 0) {
        picked.add(cid);
        continue;
      }
      const lo = Math.max(0, i - radius);
      const hi = Math.min(sibs.length, i + radius + 1);
      for (let j = lo; j < hi; j++) picked.add(sibs[j]!);
    }
    const chunks = [...picked].map((c) => this.mustGet(c));
    chunks.sort((a, b) => codePointCompare(a.fileId, b.fileId) || a.order - b.order);
    return chunks;
  }

  // ── 渲染 ────────────────────────────────────────────────────
  /** 装进 prompt 的形态。每片都带引用，模型才有可能正确归因。 */
  static render(chunks: Iterable<Chunk>): string {
    const parts: string[] = [];
    for (const c of chunks) parts.push(`⟦${c.cite()}⟧\n${c.render}`);
    return parts.join("\n\n");
  }

  get(chunkId: string): Chunk | null {
    return this._chunks.get(chunkId) ?? null;
  }

  byFile(fileId: string): Chunk[] {
    return (this._byFile.get(fileId) ?? []).map((c) => this.mustGet(c));
  }

  /**
   * **按位置**取切片，不走关键词检索。
   *
   * 关键词检索答不了"把第 30 到 46 行给我看看"这种问题：行号不是词，
   * BM25 打不出分。真实材料上模型为此连发两轮同样的检索、拿到同样一批
   * 无关切片，然后在推理里写下"检索工具对这批行号不敏感"——它是对的，
   * 那个能力当时确实不存在，于是它只能就着看不见的行下结论。
   *
   * @returns 按文件内顺序排好的切片。
   */
  byLocator(opts: ByLocatorOptions = {}): Chunk[] {
    const file = opts.file ?? "";
    const container = opts.container ?? "";
    const rows = opts.rows ?? null;
    const limit = opts.limit ?? 60;

    const out: Chunk[] = [];
    for (const c of this._chunks.values()) {
      if (file && !c.fileName.includes(file)) continue;
      const loc = pyTruthy(c.locator) ? c.locator : {};
      if (container) {
        // Python: `str(loc.get("sheet") or loc.get("section") or loc.get("object") or "")`
        const where = pyTruthy(loc["sheet"])
          ? pyStr(loc["sheet"])
          : pyTruthy(loc["section"])
            ? pyStr(loc["section"])
            : pyTruthy(loc["object"])
              ? pyStr(loc["object"])
              : "";
        if (!where.includes(container)) continue;
      }
      if (rows !== null) {
        const span = this.rowSpan(loc);
        // `row: 0` 是假值 → span 为 null → 这一片被整个过滤掉。看着像 bug，
        // 但真实材料里行号从 1 起，0 行只会来自"没解析出行号"的兜底路径，
        // 那种切片本来也不该按行号被捞出来。照抄。
        if (span === null || span[span.length - 1]! < rows[0] || span[0]! > rows[1]) continue;
      }
      out.push(c);
    }
    out.sort((a, b) => codePointCompare(a.fileName, b.fileName) || a.order - b.order);
    return out.slice(0, limit);
  }

  /** Python: `loc.get("rows") or ([loc["row"]] * 2 if loc.get("row") else None)` */
  private rowSpan(loc: Readonly<Record<string, unknown>>): number[] | null {
    const raw = loc["rows"];
    if (pyTruthy(raw)) {
      if (!Array.isArray(raw)) {
        // Python 会在 `span[-1]` 上抛 TypeError；这里提前抛，消息里带上真实的值。
        throw new TypeError(`locator 的 rows 不是数组: ${JSON.stringify(raw)}`);
      }
      return raw as number[];
    }
    const one = loc["row"];
    if (!pyTruthy(one)) return null;
    return [one as number, one as number];
  }

  /** 全部切片。调用方要把**文件名**映回 file_id 时用（模型只看得到文件名）。 */
  allChunks(): Chunk[] {
    return [...this._chunks.values()];
  }

  /**
   * 文件名 → file_id。同名取先出现的那个。
   *
   * 真实事故（commit 30db2d1）：`search(files=[...])` 过滤的是 **file_id**，
   * 但没有任何工具给过模型 file_id —— 它只看得到文件名和 cite。模型一填 files
   * 就静默拿到空结果，然后据此断言"材料里没有"，比报错还糟。名字解析在 tools
   * 层做，靠的就是这张表；`search` 本身**按 id 过滤的行为没有变**，别在这里
   * "顺手"改成按名字匹配，那会让 tools 层的显式报错（认不出的文件名要说出来）
   * 变成又一次静默。
   */
  fileNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const ch of this._chunks.values()) {
      if (!out.has(ch.fileName)) out.set(ch.fileName, ch.fileId);
    }
    return out;
  }

  /** Python 的 `__len__`。 */
  get size(): number {
    return this._chunks.size;
  }

  /** Python 的 `self._chunks[cid]`：不存在就是索引坏了，别静默返回 undefined。 */
  private mustGet(chunkId: string): Chunk {
    const c = this._chunks.get(chunkId);
    if (c === undefined) throw new Error(`索引里没有这个切片: ${chunkId}`);
    return c;
  }
}
