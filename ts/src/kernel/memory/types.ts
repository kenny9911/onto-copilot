/**
 * 记忆的公共类型 —— 移植自 Python 侧 `kernel/memory/types.py`，
 * 由 `golden/memory.types.json` 钉住（枚举取值与顺序、to_dict 的键序与每个默认值、
 * round(confidence,3)、sorted(hit_runs)、render 的每条分支、mem_key）。
 *
 * 短期与长期共用一套 `MemoryItem`，靠 `scope` 区分生命周期。这样"短期晋升为长期"
 * 就是改一个字段 + 过一道闸，而不是在两套数据结构之间搬运。
 *
 * 下游 evidence / short_term / long_term / dialogue / context / project 六个模块全部
 * 依赖这一份，所以形状上的每一处选择都写了理由，别在下游各自"顺手修正"。
 */

// roundHalfEven 是 Python `round(x, nd)` 的移植（精确有理数上舍入、ties-to-even），
// 它碰巧落在 budget.ts 里，但性质上是个 Python 数值原语，和预算无关。
// 依赖方向看着别扭，也好过在这里复制一份四十行的 BigInt 舍入 —— 复制品迟早分叉。
import { roundHalfEven } from "../budget.js";
// Python 侧 slug 是**函数内 import**，这里按契约 §1 提到顶层。
import { sha256Hex, slug } from "../ids.js";

// ── token 估算 ────────────────────────────────────────────────────
// 上下文预算必须能在不调 tokenizer 的情况下算，否则每次装配都要付一次编码开销。
// CJK 约 1 字 ≈ 1 token，拉丁约 4 字符 ≈ 1 token。够用来做预算决策。

/**
 * Python 侧的 `_CJK` 是 `[㐀-鿿豈-﫿　-〿＀-￯]`，四段：
 *   U+3400–U+9FFF   CJK 扩展 A + 统一表意
 *   U+F900–U+FAFF   兼容表意
 *   U+3000–U+303F   CJK 标点（含表意空格 U+3000）
 *   U+FF00–U+FFEF   全角形式
 * **四段全在 BMP 内**，所以扩展 B（U+20000+）、部首补充（U+2E80+）、假名（U+3040+）
 * 都不算 CJK —— 与 `ids.slug` 的保留集**不是**同一组区间，别拿一个去套另一个。
 */
function isCjkCode(c: number): boolean {
  return (
    (c >= 0x3400 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

/**
 * 粗略 token 估算。
 *
 * **不能用 `text.length`**：Python 的 `len()` 数的是码点，JS 的 `.length` 数的是
 * UTF-16 码元。四个星平面字符（emoji、CJK 扩展 B）Python 算 4、JS 算 8，`//4`
 * 之后一个给 1 一个给 2 —— 预算估算凭空翻倍，golden 里钉着这几条。
 *
 * 这里按码元下标手动走，顺带把代理对合成一个码点，全程不分配中间数组：
 * 它在每次上下文装配里对每一条记忆、每一个证据切片都要跑一遍。
 */
export function estTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let cps = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    cps++;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      // 完整代理对 = 一个星平面码点，必然落在四段 CJK 区间之外
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        i++;
        continue;
      }
      // 落单的高代理：Python 的 str 里同样算一个码点，不跳
    }
    if (isCjkCode(c)) cjk++;
  }
  // `max(1, …)`：纯 CJK 串的非 CJK 部分是 0，仍要记 1 —— 照抄，别"优化"掉。
  return cjk + Math.max(1, Math.floor((cps - cjk) / 4));
}

// ── 枚举 ──────────────────────────────────────────────────────────
// 一律 const object + union（契约 §1）：记忆要 JSON 往返、要进库、要跨 Python/TS
// 比对，TS `enum` 的运行时形态和 Python StrEnum 对不上。

/** 生命周期。 */
export const Scope = {
  NODE: "node", // 节点退出即丢，只留 digest
  RUN: "run", // Run 结束即丢
  PROJECT: "project", // 跨 Run，同一客户项目内共享
  TENANT: "tenant", // 跨项目（命名规范、通用术语）
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

/**
 * 这条记忆是谁说的 —— 决定它能不能被当真。
 *
 * `scope` 管的是活多久，`kind` 管的是长什么样，这里管的是**凭什么信**。
 * 人的判断可以跨会话传递，机器的猜测只能提示：所以参考档永不晋升
 * （见 `long_term` 的 PromotionGate）、进 prompt 必须带来源标注（见
 * `MemoryItem.render`）、也不许成为产物的出处。
 *
 * 这是"项目内记忆共享但不污染"整个特性的地基，不是可有可无的标注 ——
 * 少判一次 tier，模型的推断就会以人拍板的身份进入下一个会话。
 */
export const MemoryTier = {
  AUTHORITATIVE: "authoritative", // 人拍板：跨会话直接生效
  REFERENCE: "reference", // 模型推断：只作参考
} as const;
export type MemoryTier = (typeof MemoryTier)[keyof typeof MemoryTier];

/** 记忆类型 —— 决定检索时怎么打分、晋升时走哪条闸。 */
export const MemoryKind = {
  LESSON: "lesson", // critic 反馈沉淀的教训（Reflexion）
  TERM: "term", // 术语映射：别名 → 标准名
  CONVENTION: "convention", // 命名/建模约定
  DECISION: "decision", // 人拍板的建模决策（最高可信度）
  FACT: "fact", // 关于本项目的事实（"金额口径以财务共享中心税率表为准"）
  ARTIFACT: "artifact", // 产物指针（上一版 OIR 快照）
} as const;
export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

/** 与 Python `list(Scope)` 同序。 */
export const SCOPES: readonly Scope[] = Object.values(Scope);
/** 与 Python `list(MemoryTier)` 同序。 */
export const MEMORY_TIERS: readonly MemoryTier[] = Object.values(MemoryTier);
/** 与 Python `list(MemoryKind)` 同序。 */
export const MEMORY_KINDS: readonly MemoryKind[] = Object.values(MemoryKind);

const SCOPE_VALUES: ReadonlySet<string> = new Set<string>(SCOPES);
const TIER_VALUES: ReadonlySet<string> = new Set<string>(MEMORY_TIERS);
const KIND_VALUES: ReadonlySet<string> = new Set<string>(MEMORY_KINDS);

// 对应 Python 的 `Scope(value)` 等 —— 未知值**抛错**，不要用 `as Scope` 蒙混。
// 记忆是从库里、从老 mem.json 里读回来的外部输入：一个拼错的 tier 被放行，
// 后果不是报错而是「模型的推断以权威档身份进了别人的会话」，且不留痕迹。

export function parseScope(v: unknown): Scope {
  if (typeof v === "string" && SCOPE_VALUES.has(v)) return v as Scope;
  throw new Error(`未知的 Scope: ${JSON.stringify(v)}`);
}

export function parseMemoryTier(v: unknown): MemoryTier {
  if (typeof v === "string" && TIER_VALUES.has(v)) return v as MemoryTier;
  throw new Error(`未知的 MemoryTier: ${JSON.stringify(v)}`);
}

export function parseMemoryKind(v: unknown): MemoryKind {
  if (typeof v === "string" && KIND_VALUES.has(v)) return v as MemoryKind;
  throw new Error(`未知的 MemoryKind: ${JSON.stringify(v)}`);
}

// ── MemoryItem ────────────────────────────────────────────────────

/** 构造参数。四个必填，其余走默认值（默认值见 `DEFAULTS`）。 */
export interface MemoryItemInit {
  /** 同 key 视为同一条，重复写入走合并而非追加。 */
  readonly key: string;
  readonly kind: MemoryKind;
  readonly scope: Scope;
  readonly content: string;
  readonly confidence?: number | undefined;
  readonly support?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  readonly createdRun?: string | undefined;
  readonly lastUsedRun?: string | undefined;
  readonly useCount?: number | undefined;
  readonly hitRuns?: Iterable<string> | undefined;
  readonly contestedBy?: readonly string[] | undefined;
  readonly tier?: MemoryTier | undefined;
  readonly originSession?: string | undefined;
  readonly originFiles?: readonly string[] | undefined;
}

/**
 * `to_dict()` 的线上形态。字段名保持 snake_case，**键的插入顺序即落盘字节顺序**
 * （journal 那条路 `json.dumps` 不排序），golden 的 `key_order` 钉着它。
 */
export interface MemoryItemDict {
  key: string;
  kind: MemoryKind;
  scope: Scope;
  content: string;
  confidence: number;
  support: string[];
  tags: string[];
  meta: Record<string, unknown>;
  created_run: string;
  last_used_run: string;
  use_count: number;
  hit_runs: string[];
  contested_by: string[];
  tier: MemoryTier;
  origin_session: string;
  origin_files: string[];
}

/**
 * 默认值集中在这里，**不写成类字段初始化器**（契约 §1）：类字段的初始化发生在
 * 构造函数体之后，将来一旦有人继承 MemoryItem，子类的字段初始化会把基类构造函数
 * 刚算好的值覆盖回默认值 —— 而且不报错。
 */
const DEFAULTS = {
  confidence: 0.5,
  createdRun: "",
  lastUsedRun: "",
  useCount: 0,
  /** 出身默认是权威档 —— 既有调用点全是"人拍板"或"从规范导入"这条线，默认改成
   * 参考会让它们连带降级。新写入的模型推断必须**显式**标 REFERENCE。 */
  tier: MemoryTier.AUTHORITATIVE,
  originSession: "",
} as const;

/**
 * Python str 比较按码点；JS 默认 `sort()` 按 UTF-16 码元。BMP 内一致，
 * U+FFFF 与 U+10000 这类跨界比较才分叉（golden 的 hit_runs 里钉着）。
 *
 * ids.ts 里有同名的私有函数但没导出，这里只能各写一份 —— 两处都很短，
 * 且都由各自的 golden 钉着，不存在"改了一处忘了另一处"的静默风险。
 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/**
 * 一条记忆。
 *
 * `support` 是这条记忆的依据（事件 seq、evidence locator、人工决策 id）。
 * 没有 support 的记忆不允许晋升到长期 —— 长期记忆一旦污染，后续所有 Run 都受
 * 影响，代价远高于短期。
 *
 * 字段**全部可变**，与 Python 的 `@dataclass(slots=True)`（非 frozen）一致：
 * long_term 会就地改 `scope` / `confidence` / `support` / `contested_by`，
 * 也会 `hit_runs.add(...)`。给任何一个加 `readonly` 都会让那边被迫绕路。
 */
export class MemoryItem {
  key: string;
  kind: MemoryKind;
  scope: Scope;
  content: string;
  confidence: number;
  support: string[];
  tags: string[];
  meta: Record<string, unknown>;

  // 使用统计 —— 检索打分与衰减都靠它
  createdRun: string;
  lastUsedRun: string;
  useCount: number;
  /** 出现过它的 Run，用于"重复观察"晋升。 */
  hitRuns: Set<string>;

  /** 冲突：与已有记忆矛盾时不静默覆盖。 */
  contestedBy: string[];

  // 出身
  tier: MemoryTier;
  /** 哪个会话得出的，参考档要在 prompt 里报出来。 */
  originSession: string;
  /** 当时看的是哪几份材料。 */
  originFiles: string[];

  /**
   * 容器一律**复制**（契约 §1）：Python 的 `default_factory` 只保证默认值是新的，
   * 显式传进来的 list/dict 是共享引用。那个共享在 Python 侧只有一处用到
   * （long_term 造 superseded 变体时把旧条目的 support 直接传进去），而那之后旧
   * 条目就从库里摘掉了，观察不到差别 —— 换来的是这边不会有人踩"改了新条目的
   * tags，旧条目跟着变"的坑。
   */
  constructor(p: MemoryItemInit) {
    this.key = p.key;
    this.kind = p.kind;
    this.scope = p.scope;
    this.content = p.content;
    this.confidence = p.confidence ?? DEFAULTS.confidence;
    this.support = [...(p.support ?? [])];
    this.tags = [...(p.tags ?? [])];
    this.meta = { ...(p.meta ?? {}) };
    this.createdRun = p.createdRun ?? DEFAULTS.createdRun;
    this.lastUsedRun = p.lastUsedRun ?? DEFAULTS.lastUsedRun;
    this.useCount = p.useCount ?? DEFAULTS.useCount;
    this.hitRuns = new Set(p.hitRuns ?? []);
    this.contestedBy = [...(p.contestedBy ?? [])];
    this.tier = p.tier ?? DEFAULTS.tier;
    this.originSession = p.originSession ?? DEFAULTS.originSession;
    this.originFiles = [...(p.originFiles ?? [])];
  }

  /** 这条记忆占多少 token（按 content 估）。Python 侧是 `@property`。 */
  get tokens(): number {
    return estTokens(this.content);
  }

  get contested(): boolean {
    return this.contestedBy.length > 0;
  }

  /**
   * 这条参考记忆是不是在**另一批**材料上得出的。
   *
   * 同一项目下不同会话上传的材料可能毫无关系，隔着材料得出的结论要再降一档。
   * `originFiles` 为空 = 不知道来源，不算另一批 —— 不能凭"没记来源"就判它无关。
   *
   * 入参允许 null/undefined：Python 是 `set[str] | None`，而"没传"和"传了 None"
   * 在那边是同一件事。空集合同样走 `not current_files` 那条短路。
   */
  fromOtherMaterial(currentFiles: ReadonlySet<string> | null | undefined): boolean {
    if (
      this.tier !== MemoryTier.REFERENCE ||
      !currentFiles ||
      currentFiles.size === 0 ||
      this.originFiles.length === 0
    ) {
      return false;
    }
    return !this.originFiles.some((f) => currentFiles.has(f));
  }

  /**
   * 渲染进 prompt 的一行。
   *
   * Python 侧 `foreign_material` 是 keyword-only，TS 没有关键字参数，退化成位置
   * 参数 —— 调用点建议写成 `render(item.fromOtherMaterial(files))`，别裸传 true。
   */
  render(foreignMaterial = false): string {
    const mark = this.contested ? " ⚠争议" : "";
    const head = `[${this.kind}]${mark}`;
    if (this.tier !== MemoryTier.REFERENCE) {
      return `${head} ${this.content}`;
    }
    // 标注必须挤在**内容前面**：这些行会被拼成一段再按预算整体硬截断
    // （context 的 L3），写在条目末尾的免责说明会被切掉，只剩断言本身。
    const parts = ["参考"];
    if (this.originSession) parts.push(`来自会话《${this.originSession}》`);
    if (foreignMaterial) parts.push("另一份材料");
    parts.push("未确认");
    return `${head} ${parts.join("·")}：${this.content}`;
  }

  /**
   * 落盘形态。
   *
   * `confidence` 走 `round(x, 3)`（ties-to-even），**不是** `toFixed(3)`：
   * 0.0625 / 0.1875 / 0.3125 是精确的二进制并列点，两者差最后一位，而这个数会
   * 进库、进事件、参与 diff。
   *
   * `hit_runs` 排序按**码点**（见 codePointCompare）。
   *
   * 其余容器**原样交出引用**（与 Python 一致，`eventToDict` 也是这么干的）：
   * 这里返回的是给 `JSON.stringify` 用的投影，不是快照。需要快照的自己复制
   * （project 的 to_rows 就显式 `list(...)` 了一遍）。
   */
  toDict(): MemoryItemDict {
    return {
      key: this.key,
      kind: this.kind,
      scope: this.scope,
      content: this.content,
      confidence: roundHalfEven(this.confidence, 3),
      support: this.support,
      tags: this.tags,
      meta: this.meta,
      created_run: this.createdRun,
      last_used_run: this.lastUsedRun,
      use_count: this.useCount,
      hit_runs: [...this.hitRuns].sort(codePointCompare),
      contested_by: this.contestedBy,
      tier: this.tier,
      origin_session: this.originSession,
      origin_files: this.originFiles,
    };
  }

  /**
   * 从落盘形态读回。入参是 `unknown`：真实来源是 mem.json 的一行或库里的一行，
   * 谁也不能事先保证它长什么样。
   *
   * **老库里没有 tier / origin_session / origin_files 这三个字段**，且
   * `LongTermStore.load` 对 fromDict 没有异常兜底 —— 少一个默认值就是老库一读就崩。
   *
   * 与 Python 的一处**有意收紧**：那边不校验值类型，一个 `use_count: "3"` 会一路
   * 带进内存直到某处做算术时才炸；这里当场拒绝。
   */
  static fromDict(raw: unknown): MemoryItem {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`记忆项不是对象: ${JSON.stringify(raw)}`);
    }
    const d = raw as Readonly<Record<string, unknown>>;

    const key = d["key"];
    if (typeof key !== "string") throw new Error(`记忆项缺少 key: ${JSON.stringify(d)}`);
    const content = d["content"];
    if (typeof content !== "string") {
      throw new Error(`记忆项缺少 content: ${JSON.stringify(d)}`);
    }

    return new MemoryItem({
      key,
      kind: parseMemoryKind(d["kind"]),
      scope: parseScope(d["scope"]),
      content,
      confidence: num(d["confidence"], DEFAULTS.confidence, "confidence"),
      support: strList(d["support"], "support"),
      tags: strList(d["tags"], "tags"),
      meta: obj(d["meta"], "meta"),
      createdRun: str(d["created_run"], "created_run"),
      lastUsedRun: str(d["last_used_run"], "last_used_run"),
      useCount: num(d["use_count"], DEFAULTS.useCount, "use_count"),
      hitRuns: strList(d["hit_runs"], "hit_runs"),
      contestedBy: strList(d["contested_by"], "contested_by"),
      // Python 是 `MemoryTier(d.get("tier", MemoryTier.AUTHORITATIVE))`
      tier: d["tier"] === undefined ? DEFAULTS.tier : parseMemoryTier(d["tier"]),
      originSession: str(d["origin_session"], "origin_session"),
      originFiles: strList(d["origin_files"], "origin_files"),
    });
  }
}

// ── fromDict 的取值助手 ───────────────────────────────────────────
// Python 那边是 `d.get(k, 默认)`：**只有键缺失**才回退，显式的 null 会原样留下 None
// 然后在别处发作。TS 侧把 null 一并当缺失处理 —— 字段类型里没有 null 的位置，
// 留一个 null 进来只会让下游每一处都要多判一次。

function str(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`记忆项的 ${field} 不是字符串: ${JSON.stringify(v)}`);
  return v;
}

function num(v: unknown, dflt: number, field: string): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number") throw new Error(`记忆项的 ${field} 不是数字: ${JSON.stringify(v)}`);
  return v;
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`记忆项的 ${field} 不是数组: ${JSON.stringify(v)}`);
  for (const x of v) {
    if (typeof x !== "string") {
      throw new Error(`记忆项的 ${field} 里有非字符串项: ${JSON.stringify(x)}`);
    }
  }
  return v as string[];
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`记忆项的 ${field} 不是对象: ${JSON.stringify(v)}`);
  }
  return v as Record<string, unknown>;
}

// ── mem_key ───────────────────────────────────────────────────────

/**
 * 稳定的记忆键。同一主题的同类记忆归到一条，避免长期库里堆同义副本。
 *
 * `s !== "x"` 那条判断看着像死代码（`slug` 退化时返回的是 `"x"+hash8`，不是 `"x"`），
 * 其实不是：`subject` 本身就是 `"x"`（或 `"X"` / `" x "` / `"x!!!"`）时 slug 正好
 * 给出 `"x"`。它是 slug 早年"退化即返回常量 x"那个 bug（见 ids.py 的说明：两个不同
 * 的中文名双双被抹成 `x`，后写的静默覆盖先写的）留下的护栏。照抄，不要"清理"。
 */
export function memKey(kind: MemoryKind, subject: string): string {
  const s = slug(subject, 48);
  return s !== "x" ? `${kind}:${s}` : `${kind}:${sha256Hex(subject).slice(0, 12)}`;
}
