/**
 * 项目记忆 —— 同一项目下的会话共享的那份长期库。移植自 `kernel/memory/project.py`。
 *
 * 为什么要在 `LongTermStore` 外面再包一层：
 *
 * 1. **隔离靠实例，不靠字段。** `Scope` 在检索里完全不参与过滤，`memKey` 也是
 *    `{kind}:{slug}` 不含项目 —— 两个项目共用一个 store，同名主题会直接撞进
 *    `merge` 的争议/覆盖逻辑。所以是一个项目一个实例，边界就是这个对象本身。
 * 2. **store 不会自己落盘。** 它不收 path、不记 path，save/load 是纯手动的。要跨会话
 *    活下来只能由外面把行装进来、再把行拿回去写库。
 * 3. **两档记忆的入口在这里分岔。** 人拍板走 `rememberDecision`（过晋升闸门），
 *    模型推断走 `observe`（进参考档，永远不会晋升）。分岔点只有这一处，
 *    服务层就不会有第三种写法。
 *
 * 行的形状是纯对象，键与 `project_memory` 表的列名一一对应。kernel 不依赖 store，
 * 所以这里既不 import 也不 return 任何 store 层的类型。
 */

import { roundHalfEven } from "../budget.js";
import { LongTermStore, PromotionReason } from "./long_term.js";
import { MemoryItem, MemoryKind, MemoryTier, Scope, memKey } from "./types.js";

/**
 * toRows/fromRows 的列名。与 `store/schema.py` 的 `project_memory` 对齐；
 * 两边都是手抄的，改一边必须改另一边。
 */
export const ROW_FIELDS = [
  "project_id",
  "key",
  "tier",
  "kind",
  "content",
  "confidence",
  "support",
  "tags",
  "origin_session",
  "origin_files",
  "contested_by",
  "hit_runs",
  "use_count",
  "created_run",
  "last_used_run",
] as const;
export type RowField = (typeof ROW_FIELDS)[number];

/** 一行项目记忆。键序即 `ROW_FIELDS` 的顺序（`to_rows` 的字面量顺序）。 */
export interface ProjectMemoryRow {
  project_id: string;
  key: string;
  tier: MemoryTier;
  kind: MemoryKind;
  content: string;
  confidence: number;
  support: string[];
  tags: string[];
  origin_session: string;
  origin_files: string[];
  contested_by: string[];
  hit_runs: string[];
  use_count: number;
  created_run: string;
  last_used_run: string;
}

/**
 * Python str 比较按码点；JS 默认 `sort()` 按 UTF-16 码元。`sorted(it.hit_runs)`
 * 落进库里的那一列由它决定，跨界字符（U+FFFF vs U+10000）上两边相反。
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

/** 一个项目一个实例。包着 `LongTermStore`，负责与 repo 的装载/回写。 */
export class ProjectMemory {
  readonly projectId: string;
  readonly store: LongTermStore;

  constructor(projectId: string, store?: LongTermStore) {
    this.projectId = projectId;
    this.store = store ?? new LongTermStore(projectId);
  }

  // ── 装载 / 回写 ─────────────────────────────────────────────

  /** 从库里读出的行重建。不属于本项目的行直接丢掉 —— 隔离是这层的职责。 */
  static fromRows(projectId: string, rows: readonly unknown[]): ProjectMemory {
    const pm = new ProjectMemory(projectId);
    const items: MemoryItem[] = [];
    for (const raw of rows) {
      const d = asDict(raw);
      // `d.get("project_id", project_id)`：**没有这一列**才算本项目的
      const pid = "project_id" in d ? String(d["project_id"]) : projectId;
      if (pid !== projectId) continue;
      items.push(MemoryItem.fromDict(toItemDict(d)));
    }
    pm.store.adopt(items);
    return pm;
  }

  /** 给 repo 落库用的纯对象。含 superseded 变体 —— 那是审计留档，不能丢。 */
  toRows(): ProjectMemoryRow[] {
    return this.store.all().map((it) => ({
      project_id: this.projectId,
      key: it.key,
      tier: it.tier,
      kind: it.kind,
      content: it.content,
      // Python 是 `round(float(x), 3)` —— ties-to-even，不是 toFixed 的 ties-away
      confidence: roundHalfEven(it.confidence, 3),
      // 这里**显式复制**（Python 侧同样是 `list(...)`）：行是要交给 repo 的快照，
      // 共享引用的话，回写之前 store 里再改一次就把已经"定稿"的行也改了。
      support: [...it.support],
      tags: [...it.tags],
      origin_session: it.originSession,
      origin_files: [...it.originFiles],
      contested_by: [...it.contestedBy],
      hit_runs: [...it.hitRuns].sort(codePointCompare),
      use_count: Math.trunc(it.useCount),
      created_run: it.createdRun,
      last_used_run: it.lastUsedRun,
    }));
  }

  // ── 写入：两档，两个入口 ────────────────────────────────────

  /** 人拍板的约定进权威档。`item` 通常来自 `Decision.toMemory()`。 */
  rememberDecision(
    item: MemoryItem,
    opts: { readonly runId?: string | undefined } = {},
  ): [boolean, string] {
    if (item.tier === MemoryTier.REFERENCE) {
      // 参考档不能就地翻牌成权威 —— 那正是"升权威只能靠人重新拍板"要堵的路。
      // 人真拍了板，就该由拍板那一轮新造一条带 support 的权威条目。
      return [false, "参考档不能改标成权威 —— 请用本轮拍板的 Decision 重新构造一条"];
    }
    item.scope = Scope.PROJECT;
    return this.store.promote(item, PromotionReason.HUMAN_CONFIRMED, {
      runId: opts.runId ?? "",
    });
  }

  /**
   * 模型推断出来的教训/事实进参考档。
   *
   * 返回构造出的条目（不一定就是库里那条：同 key 撞上权威档时会被合并规则挡下）。
   */
  observe(
    content: string,
    opts: {
      readonly kind?: MemoryKind | undefined;
      readonly runId?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly files?: Iterable<string> | undefined;
      readonly support?: Iterable<string> | undefined;
      readonly confidence?: number | undefined;
    } = {},
  ): MemoryItem {
    const kind = opts.kind ?? MemoryKind.LESSON;
    // DECISION 这个 kind 在检索里吃 1.3 prior、在衰减里完全豁免，是留给人拍板的。
    // 推断借它表达就成了既排前又永不过期 —— 改记成 LESSON，它本来就是教训。
    const k = kind === MemoryKind.DECISION ? MemoryKind.LESSON : kind;
    const item = new MemoryItem({
      // `content[:48]` 按码点切（memKey 内部还会再 slug 一次）
      key: memKey(k, [...content].slice(0, 48).join("")),
      kind: k,
      scope: Scope.PROJECT,
      content,
      confidence: opts.confidence ?? 0.5,
      support: [...(opts.support ?? [])],
      tags: ["observed"],
      tier: MemoryTier.REFERENCE,
      originSession: opts.sessionId ?? "",
      originFiles: [...(opts.files ?? [])],
    });
    this.store.note(item, { runId: opts.runId ?? "" });
    return item;
  }

  // ── 读取 ────────────────────────────────────────────────────

  recall(
    query: string,
    opts: {
      readonly runId?: string | undefined;
      readonly currentFiles?: ReadonlySet<string> | null | undefined;
      readonly topK?: number | undefined;
    } = {},
  ): MemoryItem[] {
    return this.store.recall(query, {
      runId: opts.runId ?? "",
      limit: opts.topK ?? 8,
      currentFiles: opts.currentFiles ?? null,
    });
  }

  /** 权威档条目。产物的 provenance / decisions 只准取这一份。 */
  authoritative(): MemoryItem[] {
    return this.store.all().filter((it) => it.tier === MemoryTier.AUTHORITATIVE);
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * 行既可能是 repo 读出的普通对象，也可能是别处造的实例。两种都收，但都当纯数据看。
 *
 * Python 那边额外收 dataclass（`dataclasses.asdict`）。TS 没有对等物 ——
 * 类实例的字段本来就在自身上，`in` / 下标取值直接可用，不需要转换。
 */
function asDict(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError(`项目记忆行必须是对象，收到 ${row === null ? "null" : typeof row}`);
  }
  return row as Record<string, unknown>;
}

/**
 * 行 → `MemoryItem.fromDict` 的入参。
 *
 * `project_memory` 表没有 scope 和 meta 两列（项目记忆按定义就是项目作用域，
 * meta 是节点内的临时挂载），所以这里补一个 PROJECT 回去而不是指望行里有。
 */
function toItemDict(d: Record<string, unknown>): Record<string, unknown> {
  return {
    key: d["key"],
    kind: d["kind"],
    scope: Scope.PROJECT,
    content: d["content"],
    // 注意这一条是 `d.get("confidence", 0.5)`（只有**键缺失**才回退），
    // 下面几条是 `d.get(k) or 默认`（0 / "" / [] 也会被回退掉）。别统一。
    confidence: "confidence" in d ? d["confidence"] : 0.5,
    support: or(d["support"], []),
    tags: or(d["tags"], []),
    created_run: or(d["created_run"], ""),
    last_used_run: or(d["last_used_run"], ""),
    use_count: or(d["use_count"], 0),
    hit_runs: or(d["hit_runs"], []),
    contested_by: or(d["contested_by"], []),
    tier: or(d["tier"], MemoryTier.AUTHORITATIVE),
    origin_session: or(d["origin_session"], ""),
    origin_files: or(d["origin_files"], []),
  };
}

/** Python 的 `x or default`：假值（None/""/0/[]）一律回退。 */
function or<T>(v: unknown, dflt: T): unknown {
  if (v === undefined || v === null || v === "" || v === 0 || v === false) return dflt;
  if (Array.isArray(v) && v.length === 0) return dflt;
  return v;
}
