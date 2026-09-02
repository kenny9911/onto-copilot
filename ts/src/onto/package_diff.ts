/**
 * 两份 `OntologyPackageV1` 之间的语义 diff —— `revision.diff` 的计算核心。
 *
 * **为什么是包而不是 OIR**：包里的 id 是稳定的（`do.*` / `rel.*` / `act.*` /
 * `rule.*`），而 OIR 的 rid 由名字派生（`kernel/ids.ts` 的 `${kind}_${slug(name)}`），
 * 一次改名在 rid 世界里会渲染成「删一个、加一个」。
 *
 * **零模型、纯计算。** 这条链路上不存在编造：输出的每个 id 必然来自输入的两份包。
 *
 * 输出形状刻意对齐前端已有的渲染契约 —— `ui/react/returncard.tsx` 读
 * `a.diff || a.diffs || a.changes` 并画 `{rid}.{field}：{before} → {after}`。
 * 沿用同一个形状，渲染层零改动。
 */

import { undescribedDiff } from "./conflict.js";
import { cmpCodePoint, toCodePoints } from "./difflib.js";

/**
 * 集合的**顺序偏好**：分层截断按它轮转，业务语义重的排前面。
 *
 * **这不是覆盖面清单。** 初版把它当成「比哪些」用，结果漏掉了 roles、systems、
 * evidence，以及 questions 和 gaps —— 而后两个恰恰是每次回答都会变的东西。
 * 于是一个专为「回答之后改了什么」而造的工具，在最常见的场景下会说
 * 「两版内容完全一致」。**从部分比较里断言全等**是最不能犯的错。
 *
 * 覆盖面现在由 {@link collectionKeys} 从数据推导，所以包里新增字段会自动纳入，
 * 不会再跟着类型漂移。
 */
export const DIFF_COLLECTION_ORDER: readonly string[] = [
  "dataObjects", "links", "actions", "events", "rules",
  "workflows", "processNodes", "processEdges", "integrations",
  "roles", "systems", "questions", "gaps", "evidence",
];

/**
 * 两份包里所有**数组字段**的并集，按 {@link DIFF_COLLECTION_ORDER} 排序，
 * 表里没有的排在后面（按码点序，保证可复现）。
 */
export function collectionKeys(a: unknown, b: unknown): string[] {
  const keys = new Set<string>();
  for (const pkg of [a, b]) {
    if (pkg === null || typeof pkg !== "object") continue;
    for (const [k, v] of Object.entries(pkg as Record<string, unknown>)) {
      if (Array.isArray(v)) keys.add(k);
    }
  }
  const rank = (k: string) => {
    const i = DIFF_COLLECTION_ORDER.indexOf(k);
    return i === -1 ? DIFF_COLLECTION_ORDER.length : i;
  };
  return [...keys].sort((x, y) => rank(x) - rank(y) || cmpCodePoint(x, y));
}

/** 元信息字段不参与比较：每次编译都会变，报出来全是噪音。 */
const SKIP_FIELDS: ReadonlySet<string> = new Set(["generatedAt", "revision", "baseRevision"]);

/** 超过这个长度的文本不吐原文 —— 一个包里的 description 动辄几百字。 */
const TEXT_CAP = 140;
/** 单个「差在哪几个字」片段的上限。 */
const FRAGMENT_CAP = 60;
/** 返回给调用方的改动条数上限。总数另给，不靠这个数推。 */
const CHANGE_CAP = 80;

export interface FieldChange {
  readonly rid: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly 截断?: boolean;
  readonly 差在?: readonly string[];
  readonly 单边?: "before" | "after";
}

export interface CollectionDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly aCount: number;
  readonly bCount: number;
}

export interface SystemicChange {
  readonly kind: string;
  readonly count: number;
  readonly of: number;
  readonly why: string;
}

export interface PackageDiff {
  readonly identical: boolean;
  /** 全量改动数（新增 + 删除 + 字段改动），**不受 {@link CHANGE_CAP} 影响**。 */
  readonly total: number;
  readonly collections: Readonly<Record<string, CollectionDiff>>;
  /** 实际比过哪些集合。**「没报」要能区分「比过没变」和「根本没比」。** */
  readonly compared: readonly string[];
  readonly changes: readonly FieldChange[];
  readonly systemic: readonly SystemicChange[];
  readonly note: string;
}

function rows(pkg: unknown, key: string): Record<string, unknown>[] {
  const v = (pkg as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === "object") as Record<string, unknown>[]) : [];
}

/**
 * 按 id 建索引，并**把重复挑出来**。
 *
 * `canonicalId` 会剥掉若干 legacy 前缀，不同的 OIR rid 会塌成同一个包内 id
 * （`br_x` 与 `rule_x` 都 → `rule.x`）。初版直接 `m.set(id, row)`，后者覆盖前者：
 * 被覆盖那条的改动**完全消失**，而计数报的是去重后的 size。两版都只剩最后一条
 * 又恰好相同时，工具会宣布「完全一致 —— 这是比较过的结论」——
 * **又是从部分比较里断言全等**。
 */
function byId(list: readonly Record<string, unknown>[]): {
  readonly map: Map<string, Record<string, unknown>>;
  readonly dups: string[];
  readonly rows: number;
} {
  const m = new Map<string, Record<string, unknown>>();
  const dups = new Set<string>();
  let rows = 0;
  for (const r of list) {
    const id = String(r["id"] ?? "");
    if (id === "") continue;
    rows += 1;
    if (m.has(id)) dups.add(id);
    else m.set(id, r);
  }
  return { map: m, dups: [...dups].sort(cmpCodePoint), rows };
}

/** 稳定的深比较。数组按序、对象按键序 —— 结果必须可复现。 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  }
  return String(a) === String(b);
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort(cmpCodePoint)) {
      out[k] = sorted((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function cut(s: string, n: number): string {
  const cp = toCodePoints(s);
  return cp.length <= n ? s : cp.slice(0, n).join("");
}

function fieldChange(rid: string, field: string, before: unknown, after: unknown): FieldChange {
  const isText = typeof before === "string" && typeof after === "string";
  if (!isText || (before.length <= TEXT_CAP && after.length <= TEXT_CAP)) {
    return { rid, field, before, after };
  }
  const base: FieldChange = {
    rid, field, before: cut(before, TEXT_CAP), after: cut(after, TEXT_CAP), 截断: true,
  };
  // 一边有一边空**不是**「差在哪几个字」：那时 opcodes 只会把有内容那一边
  // 整段当成片段吐出来，比不给还糟。
  if (before.trim() === "" || after.trim() === "") {
    return { ...base, 单边: before.trim() === "" ? "after" : "before" };
  }
  return { ...base, 差在: undescribedDiff(before, after).map((x) => cut(x, FRAGMENT_CAP)) };
}

/**
 * 两个「元素带 id 的数组」之间的逐条差异；不是这种形状就回 null，由调用方按
 * 普通字段处理。
 *
 * 只认**两边都是带 id 的对象数组**：一边空一边有内容时下钻等于把整边逐条报成
 * 新增，那还不如按整体字段报「一边有一边空」。
 */
function nestedRows(a: unknown, b: unknown): FieldChange[] | null {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return null;
  const ok = (arr: unknown[]) =>
    arr.every((x) => x !== null && typeof x === "object" && !Array.isArray(x) &&
      typeof (x as Record<string, unknown>)["id"] === "string");
  if (!ok(a) || !ok(b)) return null;

  const A = byId(a as Record<string, unknown>[]).map;
  const B = byId(b as Record<string, unknown>[]).map;
  const out: FieldChange[] = [];
  for (const [id, ra] of [...A].sort((x, y) => cmpCodePoint(x[0], y[0]))) {
    const rb = B.get(id);
    if (rb === undefined) {
      out.push({ rid: id, field: "(整条)", before: "存在", after: null });
      continue;
    }
    for (const f of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort(cmpCodePoint)) {
      if (f === "id" || same(ra[f], rb[f])) continue;
      out.push(fieldChange(id, f, ra[f] ?? null, rb[f] ?? null));
    }
  }
  for (const id of [...B.keys()].filter((x) => !A.has(x)).sort(cmpCodePoint)) {
    out.push({ rid: id, field: "(整条)", before: null, after: "新增" });
  }
  return out;
}

export function diffOntologyPackages(a: unknown, b: unknown): PackageDiff {
  const collections: Record<string, CollectionDiff> = {};
  const dupIds = new Set<string>();
  const perCollection = new Map<string, FieldChange[]>();
  let total = 0;

  const keys = collectionKeys(a, b);
  for (const key of keys) {
    const ia = byId(rows(a, key));
    const ib = byId(rows(b, key));
    const A = ia.map;
    const B = ib.map;
    if (A.size === 0 && B.size === 0) continue;
    for (const id of [...new Set([...ia.dups, ...ib.dups])]) dupIds.add(`${key}:${id}`);

    const added = [...B.keys()].filter((id) => !A.has(id)).sort(cmpCodePoint);
    const removed = [...A.keys()].filter((id) => !B.has(id)).sort(cmpCodePoint);
    const changed: string[] = [];
    const bucket: FieldChange[] = [];

    for (const [id, ra] of [...A].sort((x, y) => cmpCodePoint(x[0], y[0]))) {
      const rb = B.get(id);
      if (rb === undefined) continue;
      const fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort(cmpCodePoint);
      let touched = false;
      for (const f of fields) {
        if (f === "id" || SKIP_FIELDS.has(f)) continue;
        if (same(ra[f], rb[f])) continue;
        // 嵌套的**带 id 数组**要下钻。`dataObjects[].attributes` 是最常变的东西，
        // 整个数组前后对吐既看不出改了哪一条，又能一条撑爆上下文。
        const nested = nestedRows(ra[f], rb[f]);
        if (nested !== null) {
          for (const c of nested) {
            bucket.push({ ...c, rid: `${id}/${c.rid}` });
          }
          touched = true;
          continue;
        }
        bucket.push(fieldChange(id, f, ra[f] ?? null, rb[f] ?? null));
        touched = true;
      }
      if (touched) changed.push(id);
    }

    // 计数按**真实行数**：去重后的 size 会比实际少，读的人不会知道。
    collections[key] = { added, removed, changed, aCount: ia.rows, bCount: ib.rows };
    perCollection.set(key, bucket);
    total += added.length + removed.length + bucket.length;
  }

  // ── 系统性变更 ────────────────────────────────────────────
  //
  // 一次重建会让每个 id 都换掉（rid 由名字派生，改一次名字整批重编）。
  // 逐条报「新增 50 个 + 删除 50 个」是把一个事实说了 100 遍，而真正的结论
  // 是「这两版之间发生过一次重建，不适合逐条比」。
  const systemic: SystemicChange[] = [];
  if (dupIds.size > 0) {
    systemic.push({
      kind: "duplicate_id",
      count: dupIds.size,
      of: dupIds.size,
      why:
        `有 ${dupIds.size} 个 id 在同一个集合里出现多次（${[...dupIds].slice(0, 5).join("、")}` +
        `${dupIds.size > 5 ? " …" : ""}）。同 id 的后几条**没有参与比较** —— ` +
        "这一版的结论是不完整的，别当成全等。多半是 canonicalId 把不同的 legacy rid 归到了一起。",
    });
  }
  for (const [key, d] of Object.entries(collections)) {
    if (d.aCount < 5 || d.bCount < 5) continue;
    const survived = d.aCount - d.removed.length;
    if (survived > 0) continue;
    systemic.push({
      kind: "wholesale_replacement",
      count: d.removed.length,
      of: d.aCount,
      why:
        `${key}：旧版 ${d.aCount} 项**没有一项**留到新版（新版 ${d.bCount} 项全是新 id）。` +
        "这多半是一次重建而不是 " + `${d.removed.length + d.added.length} 处改动 —— ` +
        "id 由名字派生，改名或重跑抽取会整批换号。逐条比没有意义。",
    });
  }

  // ── 分层截断 ──────────────────────────────────────────────
  //
  // 按集合顺序切前 N 条会让 dataObjects 占满名额，rules 一条都露不出来。
  const changes: FieldChange[] = [];
  for (let round = 0; changes.length < CHANGE_CAP; round += 1) {
    let added = false;
    for (const key of keys) {
      const bucket = perCollection.get(key);
      if (bucket === undefined || round >= bucket.length) continue;
      if (changes.length >= CHANGE_CAP) break;
      changes.push(bucket[round]!);
      added = true;
    }
    if (!added) break;
  }

  // 有重复就**不许**说全等：那部分根本没比过。
  const identical = total === 0 && dupIds.size === 0;
  return {
    identical,
    total,
    collections,
    compared: keys,
    changes,
    systemic,
    note: identical
      ? "两版内容**完全一致** —— 这是比较过的结论，不是「没查」。"
      : systemic.length > 0
        ? "有集合被整批换号（见 systemic）—— 先判断这是不是一次重建，再看逐条改动。"
        : total > changes.length
          ? `共 ${total} 处改动，这里按集合分层给了 ${changes.length} 条。` +
            "总数与各集合的 added/removed/changed 是全量的。"
          : "以下是全部改动。",
  };
}
