/**
 * 模板编译器 —— OIR → 可发给业务方填写的 xlsx。移植自
 * `src/ontocopilot/onto/template.py`，由 `golden/template.json` +
 * `golden/pipeline.template.json` + `golden/xlsx.cells.json` 钉住。
 *
 * 三个设计要点（原件的原话，不是复述）：
 *
 * 1. **隐藏锚点列**（架构文档 ADR-4）。每行带 `_oir_rid`（稳定 ID）与
 *    `_oir_hash`（预填内容哈希）。业务方会任意增删行、重排序、改列宽 —— 没有
 *    锚点就只能做模糊匹配，回传审核精度会崩。有锚点才能做单元格级 diff，也才抓得到
 *    「AI 预填了但被原样交回」这种情况。
 *
 * 2. **样式即语义**。黄底=业务必填，灰底锁定=已定只读，白底=可改，红角标=有冲突。
 *    业务方不用读说明就知道该动哪里。
 *
 * 3. **校验前移**。枚举做下拉、口径做正则、冲突写批注 —— 在业务方那一端就拦住
 *    一部分错误，比回传后再打回便宜得多。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`dict` 保序**。一行是 `dict[str, Cell]`，而 `_oir_hash` 那一格是按
 *     **行内插入序**拼出来的（`f"{f}={hash}"` 用 `|` 连），锚点列的内容因此依赖
 *     顺序。JS 普通对象对"整数样式"的键会重排（列名叫 `2024` 就中招），所以行用
 *     `Map` 而不是对象 —— 见 {@link Sheet}。
 *  2. **`str[:n]` 按 code point 切**。批注 900、证据片段 80，全是中文，按 UTF-16
 *     切会少一半。
 *  3. **`json.dumps` 的默认分隔符是 `", "` / `": "`**，`JSON.stringify` 是紧凑的。
 *     joinKey 那一格和填写指引里的统计行都会被业务方读到，形态不能漂。
 *  4. **Python 的空容器是假值**。`o.primary_key.value or ()`、`if not sh.rows`
 *     这些判据照 JS 语义写会全部反过来 —— 空表就会被发出去。
 *
 * ── xlsx 写出的选型 ──────────────────────────────────────────────
 *
 * Python 用 openpyxl，JS 侧选 **exceljs**（唯一一个同时支持填充色、批注、
 * 隐藏列、列宽、数据校验的成熟库；SheetJS 社区版不写批注与数据校验）。
 * 产物用 openpyxl 读回来逐格比对过：填充色 / 批注 / 隐藏列 / 列宽 / 数据校验，
 * 外加字体、边框、对齐、合并、行高、冻结窗格，与 openpyxl 的产物**逐字段相等**
 * （`tools/golden/template.py --dump <xlsx>`）。唯一的差异见 writeXlsx 的注释。
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { sha256Hex } from "../kernel/ids.js";
import {
  BaseType,
  Origin,
  Status,
  cite,
  isAnswered,
  // Python 的 `round(x, 3)` 是 round-half-even，`Math.round` 是 half-up ——
  // oir.ts 已经把它做对并导出，这里直接复用，不再抄一份。
  round3,
  type ActionType,
  type Assertion,
  type OIR,
  type OpenQuestion,
  type Provenance,
} from "./oir.js";

// exceljs 是 CJS：它的 index.d.ts 写成了 ESM 具名导出，但运行时
// `import { Workbook } from "exceljs"` 会直接 SyntaxError（cjs-module-lexer
// 认不出它的导出）。createRequire 两边都对：类型来自 d.ts，值来自 module.exports。
const requireCjs = createRequire(import.meta.url);
type ExcelJsModule = typeof import("exceljs");
const ExcelJS = requireCjs("exceljs") as ExcelJsModule;

export const ANCHOR_RID = "_oir_rid";
export const ANCHOR_HASH = "_oir_hash";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片（与 oir.ts 里的同名私有函数一致，那边没导出）
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。`[]` / `{}` / `""` / `0` 在 Python 里是假，JS 里前两个是真。
 * 「空表一律不出」「没有主键就锁死这一格」全靠它，写成 `!x` 会全部反过来。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(x)`。`f"{None}"` 是 `"None"` —— 这个形态会印进单元格，不许"顺手修好"。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** `s[:n]`：按 code point 切。批注和证据片段全是中文，按 UTF-16 切会少一半。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python 的 `sorted()` 按 code point 比；JS 默认 sort 按 UTF-16 code unit。
 * 问题表的排序键里有中文分组名，BMP 内两者一致，扩展区才分叉。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0) ?? 0;
    const cb = rb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca - cb;
  }
}

/** `sep.join(x or ())`。Python 对字符串会按字符拆开 join —— 脏数据下形态不同，
 * 照抄不"美化"。非可迭代对象在 Python 侧是 TypeError，这里同样抛。 */
function pyJoin(sep: string, v: unknown): string {
  if (!pyTruthy(v)) return "";
  if (Array.isArray(v)) return v.map(pyStr).join(sep);
  if (typeof v === "string") return [...v].join(sep);
  throw new TypeError(`can only join an iterable: ${JSON.stringify(v)}`);
}

/** `x or {}` 之后 `.get(k, "")`。非 dict 在 Python 侧是 AttributeError —— 这里
 * 同样抛：静默当成空 dict 会让「只读动作」的判据凭空变成真。 */
function asDict(v: unknown): Record<string, unknown> {
  if (!pyTruthy(v)) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(`'${typeof v}' object has no attribute 'get'`);
  }
  return v as Record<string, unknown>;
}

/** Python `json.dumps(obj, ensure_ascii=False)` —— **默认分隔符是 `", "` / `": "`**，
 * 不是 `JSON.stringify` 的紧凑形态。joinKey 那一格和填写指引里的统计行都会被
 * 业务方读到，差一个空格就是两边产物 diff 不上。
 *
 * 已知语言边界（与 ids.ts 的 canonicalJson 同一条）：JS 里 `1` 与 `1.0` 是同一个
 * 值，Python 的 `float` 印出来带 `.0`。这条路径上唯一的 float 是 `prefill_rate`，
 * 由 {@link statsJson} 显式按 float 打印。 */
function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  const parts = Object.entries(v as Record<string, unknown>).map(
    ([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x)}`,
  );
  return `{${parts.join(", ")}}`;
}

/** Python `repr(float)`：整数值的 float 也带 `.0`。 */
function pyFloatRepr(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : Number.isNaN(n) ? "NaN" : "-Infinity";
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

// ══════════════════════════════════════════════════════════════════
//  角色与权重
// ══════════════════════════════════════════════════════════════════

/** 单元格角色，决定样式与审核规则。 */
export const Role = {
  LOCKED: "locked", // 已定，只读（灰）
  PREFILLED: "prefilled", // AI 预填，可改（白）
  REQUIRED: "required", // 业务必填（黄）
  GUIDE: "guide", // 填写指引
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** `Role(v)` 的等价物：未知值抛错。别用 `as Role` —— 那是把校验删掉。 */
export function parseRole(v: unknown): Role {
  const s = pyStr(v);
  for (const x of Object.values(Role)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid Role`);
}

/**
 * 完成度加权。主键错了整张表报废，备注空着无所谓 —— 权重必须反映这个差异，
 * 否则"完成度 68%"这个数字没有决策价值。
 */
export const WEIGHTS: Readonly<Record<string, number>> = {
  // 答复和规则确认是这轮真正要的东西，权重最高。primaryKey 从 5.0 降到 1.0：
  // 实测它一列独占完成度权重的 58%，而 172 行全空、只有 FDE 填得了、
  // 且填了也永远不会被写回 OIR —— 一个填不了也没用的东西不该主导达标线。
  答复: 5.0,
  这条对吗: 3.0,
  执行角色: 2.0,
  管哪个单据: 2.0,
  primaryKey: 1.0,
  definition: 4.0,
  displayName: 2.0,
  cardinality: 3.0,
  description: 1.0,
  owner: 1.0,
  note: 0.5,
};

// ══════════════════════════════════════════════════════════════════
//  Cell / Sheet / TemplateSpec
// ══════════════════════════════════════════════════════════════════

/**
 * 一格。纯数据 + 自由函数（与 oir.ts 的六个实体同形态）—— 它要 JSON 往返，
 * class 的原型在 `JSON.parse` 之后就没了。字段可变：审回传那一层就是原地改
 * `role` / `value` 的。
 */
export interface Cell {
  rid: string;
  sheet: string;
  field: string;
  value: string;
  role: Role;
  owner: string | null;
  comment: string;
  /** 枚举 → 下拉。 */
  options: string[] | null;
  conflict: boolean;
  /**
   * 这格是否期望**成段的自由文本**。
   *
   * 敷衍检测的启发式（太短、整列一个值）只对自由文本成立。枚举列和责任人列
   * 本来取值就少且短，套同一套规则会把正常填写全部误报成敷衍。由编译期显式
   * 标注而不是运行时猜 —— 编译期知道这格是什么，运行时只能靠字符串猜。
   */
  expectsProse: boolean;
}

/** 必填字段照原样，其余可省 —— 对应 Python dataclass 的默认值。 */
export function makeCellRaw(
  p: Pick<Cell, "rid" | "sheet" | "field" | "value" | "role"> & Partial<Cell>,
): Cell {
  return {
    rid: p.rid,
    sheet: p.sheet,
    field: p.field,
    value: p.value,
    role: p.role,
    owner: p.owner ?? null,
    comment: p.comment ?? "",
    options: p.options === undefined ? null : p.options,
    conflict: p.conflict ?? false,
    expectsProse: p.expectsProse ?? false,
  };
}

export function cellWeight(c: Cell): number {
  return WEIGHTS[c.field] ?? 1.0;
}

/** 预填内容的哈希。回传时比一下就知道这格有没有被动过。 */
export function prefillHash(c: Cell): string {
  return c.value ? sha256Hex(c.value).slice(0, 11) : "";
}

export function cellToDict(c: Cell): Record<string, unknown> {
  return {
    rid: c.rid,
    sheet: c.sheet,
    field: c.field,
    value: c.value,
    role: c.role,
    owner: c.owner,
    comment: c.comment,
    options: c.options,
    conflict: c.conflict,
    expects_prose: c.expectsProse,
  };
}

export function cellFromDict(d: Record<string, unknown>): Cell {
  // Python 是 `d["rid"]` 这样的直接下标：缺键当场 KeyError。照抄地炸 ——
  // 一份少了 rid 的规格静默补空串，回传时整表对不上号且不报错。
  for (const k of ["rid", "sheet", "field", "value", "role"]) {
    if (!(k in d)) throw new Error(`KeyError: ${k}`);
  }
  return {
    rid: pyStr(d["rid"]),
    sheet: pyStr(d["sheet"]),
    field: pyStr(d["field"]),
    value: d["value"] as string,
    role: parseRole(d["role"]),
    owner: (d["owner"] as string | null) ?? null,
    comment: d["comment"] === undefined ? "" : (d["comment"] as string),
    options: d["options"] === undefined ? null : (d["options"] as string[] | null),
    conflict: d["conflict"] === undefined ? false : (d["conflict"] as boolean),
    expectsProse: d["expects_prose"] === undefined ? false : (d["expects_prose"] as boolean),
  };
}

/**
 * 一张表。
 *
 * `rows` 的一行是 `Map` 而不是普通对象：Python 的 dict 保插入序，而 JS 对象对
 * 整数样式的键会重排。锚点哈希列 `_oir_hash` 是按**行内顺序**拼出来的，列名叫
 * `2024` 就会让两边的锚点内容对不上 —— 而锚点错了整份回传就读不回来。
 */
export interface Sheet {
  name: string;
  guide: string;
  columns: string[];
  rows: Map<string, Cell>[];
}

export function makeSheet(name: string, guide: string, columns: string[]): Sheet {
  return { name, guide, columns: [...columns], rows: [] };
}

/** `by_rid()` 的键。Python 是 `(rid, field)` 元组，JS 没有值相等的元组 ——
 * 用 NUL 拼串：rid 与列名里都不可能出现 NUL，不会撞。 */
export function ridFieldKey(rid: string, field: string): string {
  return `${rid}\u0000${field}`;
}

/** 完成度统计。键名是 snake_case —— 它是**序列化形态**，会原样印进填写指引。 */
export interface TemplateStats {
  sheets: number;
  total_cells: number;
  prefilled: number;
  prefill_rate: number;
  business_required: number;
  conflicts: number;
  owners: Record<string, number>;
}

/** 编译结果。写 xlsx 与回传审核共用这一份规格 —— 两边对不上是最难查的 bug。 */
export class TemplateSpec {
  sheets: Sheet[];
  round: number;

  constructor(p: { sheets?: Sheet[]; round?: number } = {}) {
    // 不用 class field 默认值：子类的 field 初始化会覆盖基类（见迁移约定）
    this.sheets = p.sheets ?? [];
    this.round = p.round ?? 1;
  }

  cells(): Cell[] {
    const out: Cell[] = [];
    for (const s of this.sheets) for (const r of s.rows) for (const c of r.values()) out.push(c);
    return out;
  }

  /** 键见 {@link ridFieldKey}。同键后写覆盖先写 —— 与 Python 的字典推导一致，
   * 而 template_edit 的 G6 守卫存在的意义就是不让它发生。 */
  byRid(): Map<string, Cell> {
    const m = new Map<string, Cell>();
    for (const c of this.cells()) m.set(ridFieldKey(c.rid, c.field), c);
    return m;
  }

  // ── 持久化 ──────────────────────────────────────────────────
  // 发模板和审回传通常是两次独立的进程调用（中间隔着业务方填写的几天），
  // 所以规格必须能落盘再读回 —— 两边对不上是最难查的一类 bug。
  toDict(): Record<string, unknown> {
    return {
      round: this.round,
      sheets: this.sheets.map((sh) => ({
        name: sh.name,
        guide: sh.guide,
        columns: sh.columns,
        rows: sh.rows.map((row) => {
          const o: Record<string, unknown> = {};
          for (const [k, c] of row) o[k] = cellToDict(c);
          return o;
        }),
      })),
    };
  }

  static fromDict(d: Record<string, unknown>): TemplateSpec {
    // `d.get("round", 1)`：键存在但值是 null 时 Python 拿到的是 None，不是 1。
    const spec = new TemplateSpec({ round: ("round" in d ? d["round"] : 1) as number });
    for (const raw of (d["sheets"] ?? []) as Record<string, unknown>[]) {
      if (!("name" in raw)) throw new Error("KeyError: name");
      const sheet = makeSheet(
        pyStr(raw["name"]),
        raw["guide"] === undefined ? "" : (raw["guide"] as string),
        [...((raw["columns"] ?? []) as string[])],
      );
      sheet.rows = ((raw["rows"] ?? []) as Record<string, Record<string, unknown>>[]).map(
        (row) => {
          const m = new Map<string, Cell>();
          for (const [k, c] of Object.entries(row)) m.set(k, cellFromDict(c));
          return m;
        },
      );
      spec.sheets.push(sheet);
    }
    return spec;
  }

  /** 落盘。`json.dumps(..., ensure_ascii=False, indent=1)` 的字节形态 ——
   * `JSON.stringify(obj, null, 1)` 与它逐字一致（golden 钉着整段文本）。
   *
   * 保持同步 IO：一次 Run 只写一两次，且调用方（CLI / 服务端出模板）本来就在
   * 等这个文件落地。journal 那条"改异步"的理由（每 Run 上千条事件）在这里不成立。 */
  save(path: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toDict(), null, 1), "utf8");
    return path;
  }

  static load(path: string): TemplateSpec {
    return TemplateSpec.fromDict(
      JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    );
  }

  stats(): TemplateStats {
    const cells = this.cells();
    const filled = cells.filter(
      (c) => (c.role === Role.LOCKED || c.role === Role.PREFILLED) && pyTruthy(c.value),
    );
    const required = cells.filter((c) => c.role === Role.REQUIRED);
    const owners = new Map<string, number>();
    for (const c of required) {
      if (pyTruthy(c.owner)) {
        const k = c.owner as string;
        owners.set(k, (owners.get(k) ?? 0) + 1);
      }
    }
    // `sorted(..., key=lambda p: -p[1])`：按人数降序，Python 的 sort 稳定，
    // 同数的保持插入序。Array.sort 在 V8 上同样稳定。
    const sorted = [...owners.entries()].sort((a, b) => -a[1] - -b[1]);
    const ownersOut: Record<string, number> = {};
    for (const [k, v] of sorted) ownersOut[k] = v;
    return {
      sheets: this.sheets.length,
      total_cells: cells.length,
      prefilled: filled.length,
      prefill_rate: round3(filled.length / Math.max(1, cells.length)),
      business_required: required.length,
      conflicts: cells.filter((c) => c.conflict).length,
      owners: ownersOut,
    };
  }
}

/** `json.dumps(spec.stats(), ensure_ascii=False)`。
 *
 * `prefill_rate` 在 Python 侧永远是 float（`round()` 的返回值），0 和 1 要印成
 * `0.0` / `1.0` —— JS 分不出整数与整值 float，所以这一个键显式按 float 打印。 */
export function statsJson(s: TemplateStats): string {
  const owners = Object.entries(s.owners)
    .map(([k, v]) => `${JSON.stringify(k)}: ${v}`)
    .join(", ");
  return (
    `{"sheets": ${s.sheets}, "total_cells": ${s.total_cells}, ` +
    `"prefilled": ${s.prefilled}, "prefill_rate": ${pyFloatRepr(s.prefill_rate)}, ` +
    `"business_required": ${s.business_required}, "conflicts": ${s.conflicts}, ` +
    `"owners": {${owners}}}`
  );
}

// ══════════════════════════════════════════════════════════════════
//  编译
// ══════════════════════════════════════════════════════════════════

/**
 * 编译只消费冲突的 `subjects` 与 `summary` 两个字段。
 *
 * `onto/conflict.py` 还没移植，这里**不为它造替身**（迁移约定 §2.3 的同一条
 * 道理）：声明成结构类型，等 `conflict.ts` 落地后它的 `Conflict` 天然满足。
 */
export interface ConflictLike {
  readonly subjects: readonly string[];
  readonly summary: string;
}

/** 期望成段自由文本的字段。敷衍启发式只对这些成立。 */
export const PROSE_FIELDS: ReadonlySet<string> = new Set(["definition", "description"]);

/** `_cell(...)` 的移植件。template_edit 也用它 —— 那边 import 的就是这一个。 */
export function makeCell(
  rid: string,
  sheet: string,
  fld: string,
  value: string | null | undefined,
  role: Role,
  opts: {
    owner?: string | null;
    comment?: string;
    options?: string[] | null;
    conflict?: boolean;
  } = {},
): Cell {
  const options = opts.options ?? null;
  return {
    rid,
    sheet,
    field: fld,
    value: value || "", // Python 的 `value or ""`：None 和 "" 都落到空串
    role,
    owner: opts.owner ?? null,
    comment: opts.comment ?? "",
    options,
    conflict: opts.conflict ?? false,
    expectsProse: PROSE_FIELDS.has(fld) && !pyTruthy(options),
  };
}

/** 把证据出处写进批注。业务方对某个预填值有疑问时，能直接看到系统凭什么这么填。 */
function evidenceNote(a: Assertion<unknown>): string {
  if (!pyTruthy(a.evidence)) {
    return a.origin === Origin.INFERRED ? "（无证据支撑，系统推断）" : "";
  }
  const lines = a.evidence
    .slice(0, 3)
    .map((e: Provenance) => `${cite(e)}：${sliceCodePoints(e.snippet, 80)}`);
  return "依据\n" + lines.join("\n");
}

function sheetObjects(oir: OIR, conflicted: Set<string>, notes: Map<string, string[]>): Sheet {
  const sh = makeSheet(
    "01_对象清单",
    "本表列出系统从材料中识别出的业务对象。灰底=已定，无需改动；黄底=需要你确认或补充。",
    ["apiName", "displayName", "description", "primaryKey", "owner"],
  );
  for (const o of oir.objects.values()) {
    const cf = conflicted.has(o.rid);
    const note = (notes.get(o.rid) ?? []).join("\n");
    const row = new Map<string, Cell>();
    row.set(
      "apiName",
      makeCell(o.rid, sh.name, "apiName", o.apiName.value, Role.LOCKED, {
        comment: evidenceNote(o.apiName),
      }),
    );
    row.set(
      "displayName",
      makeCell(o.rid, sh.name, "displayName", o.displayName.value, Role.PREFILLED, {
        owner: o.owner,
        comment: evidenceNote(o.displayName),
      }),
    );
    row.set(
      "description",
      makeCell(o.rid, sh.name, "description", o.description.value, Role.REQUIRED, {
        owner: o.owner,
        comment: "请一句话说明这个对象在业务里代表什么",
      }),
    );
    // primaryKey **不向业务方要**。实测：172 行全空、一列独占完成度权重
    // 的 58%、只有 FDE 答得了（"主键"是数据建模词汇），而且填了也永远
    // 不会被 merge_into_oir 写回 —— 一个填不了、填了也没用的必填格，
    // 唯一的作用是把达标线永远压在够不到的地方。
    row.set(
      "primaryKey",
      makeCell(
        o.rid,
        sh.name,
        "primaryKey",
        pyJoin("、", o.primaryKey.value),
        pyTruthy(o.primaryKey.value) ? Role.PREFILLED : Role.LOCKED,
        { owner: o.owner, comment: evidenceNote(o.primaryKey), conflict: cf },
      ),
    );
    // owner 同理：172 行全空、没有任何说明该填岗位还是人名，
    // 而"这批单据归谁"是**一次**能答完的事，不该逐行问 172 遍。
    row.set(
      "owner",
      makeCell(
        o.rid,
        sh.name,
        "owner",
        o.owner || "",
        pyTruthy(o.owner) ? Role.PREFILLED : Role.LOCKED,
        { owner: o.owner, comment: note },
      ),
    );
    sh.rows.push(row);
  }
  return sh;
}

function sheetProperties(oir: OIR, conflicted: Set<string>, notes: Map<string, string[]>): Sheet {
  const sh = makeSheet(
    "02_属性明细",
    "口径定义是本轮的重点：请写清楚这个字段到底统计的是什么（含税/不含税、" +
      "时间粒度、口径主体）。红角标的格子存在冲突，批注里有详情。",
    ["parent", "apiName", "baseType", "definition", "unit", "required", "owner"],
  );
  const baseTypes = Object.values(BaseType) as string[];
  for (const p of oir.properties.values()) {
    const cf = conflicted.has(p.rid);
    const parent = oir.objects.get(p.parent);
    const row = new Map<string, Cell>();
    row.set(
      "parent",
      makeCell(
        p.rid,
        sh.name,
        "parent",
        parent ? parent.displayName.value : p.parent,
        Role.LOCKED,
      ),
    );
    row.set(
      "apiName",
      makeCell(p.rid, sh.name, "apiName", p.apiName.value, Role.LOCKED, {
        comment: evidenceNote(p.apiName),
      }),
    );
    row.set(
      "baseType",
      makeCell(p.rid, sh.name, "baseType", pyStr(p.baseType.value), Role.PREFILLED, {
        options: baseTypes,
        comment: evidenceNote(p.baseType),
      }),
    );
    // ★ 口径永远是业务必填 —— 系统抽出来的只是候选，必须有人认领
    row.set(
      "definition",
      makeCell(p.rid, sh.name, "definition", p.definition.value, Role.REQUIRED, {
        owner: p.owner,
        conflict: cf,
        comment: [...(notes.get(p.rid) ?? []), evidenceNote(p.definition)].join("\n").trim(),
      }),
    );
    row.set(
      "unit",
      makeCell(p.rid, sh.name, "unit", p.unit.value || "", Role.PREFILLED, { owner: p.owner }),
    );
    row.set(
      "required",
      makeCell(
        p.rid,
        sh.name,
        "required",
        pyTruthy(p.required.value) ? "是" : "否",
        Role.PREFILLED,
        { options: ["是", "否"], owner: p.owner },
      ),
    );
    row.set(
      "owner",
      makeCell(
        p.rid,
        sh.name,
        "owner",
        p.owner || "",
        pyTruthy(p.owner) ? Role.PREFILLED : Role.REQUIRED,
        { owner: p.owner },
      ),
    );
    sh.rows.push(row);
  }
  return sh;
}

function sheetLinks(oir: OIR, conflicted: Set<string>, notes: Map<string, string[]>): Sheet {
  const sh = makeSheet(
    "03_关系清单",
    "请确认两个对象之间的对应关系。一对多还是多对多，直接影响下游能不能建出正确的工作流。",
    ["apiName", "from", "to", "cardinality", "joinKey"],
  );
  const cards = ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"];
  for (const lt of oir.links.values()) {
    const src = oir.objects.get(lt.source);
    const tgt = oir.objects.get(lt.target);
    const row = new Map<string, Cell>();
    row.set("apiName", makeCell(lt.rid, sh.name, "apiName", lt.apiName.value, Role.LOCKED));
    row.set(
      "from",
      makeCell(lt.rid, sh.name, "from", src ? src.displayName.value : lt.source, Role.LOCKED),
    );
    row.set(
      "to",
      makeCell(lt.rid, sh.name, "to", tgt ? tgt.displayName.value : lt.target, Role.LOCKED),
    );
    row.set(
      "cardinality",
      makeCell(lt.rid, sh.name, "cardinality", pyStr(lt.cardinality.value), Role.REQUIRED, {
        options: cards,
        conflict: conflicted.has(lt.rid),
        comment: [...(notes.get(lt.rid) ?? []), evidenceNote(lt.cardinality)].join("\n").trim(),
      }),
    );
    row.set(
      "joinKey",
      makeCell(
        lt.rid,
        sh.name,
        "joinKey",
        pyTruthy(lt.joinKey.value) ? pyJsonDumps(lt.joinKey.value) : "",
        Role.LOCKED,
      ),
    );
    sh.rows.push(row);
  }
  return sh;
}

/** 只读动作的动词。判据是**接口路径里的动词**，不是接口名 —— 名字可以随便起，
 * 路径是实际调用的东西。 */
const READ_VERBS = [
  "query",
  "get",
  "list",
  "search",
  "find",
  "fetch",
  "detail",
  "page",
  "export",
  "download",
  "view",
  "read",
] as const;

const WRITE_VERBS = [
  "create",
  "update",
  "delete",
  "save",
  "submit",
  "cancel",
  "approve",
  "import",
  "subtract",
  "close",
] as const;

/** 这个动作改不改数据。改不了的，"影响范围"就不该问人。 */
function readOnly(action: ActionType): boolean {
  const ep = asDict(action.sourceEndpoint.value);
  const get0 = (k: string): string => (ep[k] === undefined ? "" : pyStr(ep[k]));
  const blob = `${action.apiName.value} ${get0("path")} ${get0("display")}`.toLowerCase();
  if (WRITE_VERBS.some((v) => blob.includes(v))) return false;
  return READ_VERBS.some((v) => blob.includes(v));
}

function sheetActions(oir: OIR): Sheet {
  const sh = makeSheet(
    "04_动作清单",
    "带「待确认」的是系统从 OpenAPI 反推的草稿。请核对参数与影响范围 —— " +
      "改比从零写快得多，但草稿未经确认不算数。",
    ["apiName", "appliesTo", "sourceEndpoint", "effects", "confirmed"],
  );
  for (const a of oir.actions.values()) {
    const drafted = a.status === Status.DRAFT_FROM_API;
    const ep = asDict(a.sourceEndpoint.value);
    const get0 = (k: string): string => (ep[k] === undefined ? "" : pyStr(ep[k]));
    const ro = readOnly(a);
    const row = new Map<string, Cell>();
    row.set(
      "apiName",
      makeCell(a.rid, sh.name, "apiName", a.apiName.value, Role.PREFILLED, {
        comment: evidenceNote(a.apiName),
      }),
    );
    row.set(
      "appliesTo",
      makeCell(a.rid, sh.name, "appliesTo", pyJoin("、", a.appliesTo), Role.PREFILLED),
    );
    row.set(
      "sourceEndpoint",
      makeCell(
        a.rid,
        sh.name,
        "sourceEndpoint",
        `${get0("method").toUpperCase()} ${get0("path")}`.trim(),
        Role.LOCKED,
        { comment: evidenceNote(a.sourceEndpoint) },
      ),
    );
    // 查询类接口不改任何数据，"影响范围"的答案是确定的 —— 逐个问
    // 111 遍里有一半是在问同一个已知答案。
    row.set(
      "effects",
      makeCell(
        a.rid,
        sh.name,
        "effects",
        ro ? "只读，不改动单据" : pyJoin("、", a.effects.value),
        ro ? Role.LOCKED : Role.REQUIRED,
      ),
    );
    // 只有**真的是草稿**的才要确认。111 行全预填「已确认」再要人确认一遍，
    // 结果是他核对后觉得没问题、不动，然后被判敷衍 —— 实测这一条让
    // "每格都认真填满"的完成度卡在 0.8861，永远够不到 0.95。
    row.set(
      "confirmed",
      makeCell(
        a.rid,
        sh.name,
        "confirmed",
        drafted ? "待确认" : "已确认",
        drafted ? Role.REQUIRED : Role.PREFILLED,
        { options: ["已确认", "待确认", "不适用"] },
      ),
    );
    sh.rows.push(row);
  }
  return sh;
}

/**
 * 问题表可能出现的列，按**这份材料实际有的东西**取子集。
 *
 * 以前这五列是写死的（节点 | 编号 | 澄清问题 | 参考选项 | 答复），照抄的是某一位
 * 客户那份问卷的样子。换一份没有问卷的材料，「编号」和「参考选项」就是两列
 * 从头空到尾的空格 —— 业务方看到空列的第一反应是"这是不是要我填"，而它们
 * 根本没有内容可填。列要么有内容，要么不出现。
 */
const Q_COLUMNS: readonly (readonly [string, (q: OpenQuestion) => unknown])[] = [
  ["所属部分", (q) => q.group],
  ["编号", (q) => q.code],
  ["澄清问题", (q) => q.text.value],
  ["参考选项", (q) => q.options.map((o, i) => `${i + 1}）${o}`).join("　")],
  ["答复", () => ""],
  ["材料出处", (q) => (pyTruthy(q.text.evidence) ? cite(q.text.evidence[0] as Provenance) : "")],
] as const;

/** 无论如何都要出的两列。没有问题正文就没有这张表，没有答复栏就没法回收。 */
const Q_REQUIRED_COLUMNS: ReadonlySet<string> = new Set(["澄清问题", "答复"]);

/**
 * 待澄清问题。
 *
 * 这张表以前不存在 —— 150 个待澄清问题在编译到 xlsx 这一步整体蒸发，而它们是
 * 整份 OIR 里**信息密度最高**的内容：客户自己写的、按流程节点分好组、带参考
 * 选项、只差一个答复。
 *
 * 问题的来源现在有三条（客户问卷 / 流程图缺口 / 证据里挖出来的缺口），三条给的
 * 字段不一样：问卷带编号和参考选项，挖出来的带出处和分组。所以**列是算出来的**
 * ——哪一列有内容才出哪一列。参考选项原样保留 ①②③ 不做下拉：有的问题答案不在
 * 选项里，做成下拉等于逼人二选一。
 *
 * 「材料出处」是新加的一列。业务方对一个问题的第一反应通常是"这是从哪儿冒出来
 * 的"，答不上来他就跳过了；写清楚"业务规则!R47"，他能自己翻回去看上下文。
 */
function sheetQuestions(oir: OIR): Sheet {
  const pending = [...oir.questions.values()].filter((q) => !pyTruthy(q.answer.value.trim()));
  // 客户自己提的排最前 —— 那是他本来就想问的，比我们发现的任何缺口都该先答。
  // Python 的元组排序键 (bool, str, str)；JS 的 sort 在 V8 上同样稳定。
  pending.sort((a, b) => {
    const ka = a.askedBy !== "customer" ? 1 : 0;
    const kb = b.askedBy !== "customer" ? 1 : 0;
    if (ka !== kb) return ka - kb;
    const g = cmpCodePoint(a.group, b.group);
    if (g !== 0) return g;
    return cmpCodePoint(a.code, b.code);
  });

  const cols = Q_COLUMNS.filter(
    ([name, get]) =>
      Q_REQUIRED_COLUMNS.has(name) || pending.some((q) => pyStr(get(q)).trim() !== ""),
  ).map(([name]) => name);
  const sh = makeSheet(
    "02_待澄清问题",
    "这些是梳理过程中没法从材料里确定的事。答复栏按你了解的实际情况填，" +
      "拿不准就写「不确定」——写不确定比猜一个有用。" +
      (cols.includes("材料出处") ? "　带「材料出处」的可以按出处翻回原文核对。" : ""),
    cols,
  );
  const getters = new Map(Q_COLUMNS.map(([name, get]) => [name, get]));
  for (const q of pending) {
    const row = new Map<string, Cell>();
    for (const name of cols) {
      const get = getters.get(name);
      if (!get) continue; // 到不了：cols 是 Q_COLUMNS 的子集
      row.set(
        name,
        makeCell(q.rid, sh.name, name, pyStr(get(q)), name === "答复" ? Role.REQUIRED : Role.LOCKED, {
          comment: name === "澄清问题" ? evidenceNote(q.text) : "",
        }),
      );
    }
    sh.rows.push(row);
  }
  return sh;
}

/**
 * 业务规则确认。
 *
 * 规则原文是成段中文，业务专家一眼能读。要他补的只有两件他知道、而系统猜不到
 * 的事：**这条归谁执行**，以及**这条管的是哪个单据**。两列都短，答起来快。
 */
function sheetRules(oir: OIR): Sheet {
  const sh = makeSheet(
    "03_业务规则确认",
    "下面是从材料里挖出来的业务规则。请确认它对不对、归谁执行、管的是哪个单据。",
    ["规则原文", "执行角色", "管哪个单据", "这条对吗"],
  );
  const byRid = new Map<string, string>();
  for (const o of oir.objects.values()) byRid.set(o.rid, o.displayName.value);
  for (const r of oir.rules.values()) {
    const hosts = r.appliesTo.map((h) => byRid.get(h) ?? h).join("、");
    const row = new Map<string, Cell>();
    row.set(
      "规则原文",
      makeCell(r.rid, sh.name, "规则原文", r.statement.value, Role.LOCKED, {
        comment: evidenceNote(r.statement),
      }),
    );
    // 系统读到了就预填，没读到才要人填 —— 已经知道的不该再问一遍
    row.set(
      "执行角色",
      makeCell(
        r.rid,
        sh.name,
        "执行角色",
        r.actor.value,
        pyTruthy(r.actor.value) ? Role.PREFILLED : Role.REQUIRED,
      ),
    );
    row.set(
      "管哪个单据",
      makeCell(
        r.rid,
        sh.name,
        "管哪个单据",
        hosts,
        pyTruthy(hosts) ? Role.PREFILLED : Role.REQUIRED,
      ),
    );
    row.set(
      "这条对吗",
      makeCell(r.rid, sh.name, "这条对吗", "", Role.REQUIRED, {
        options: ["对", "不对", "需要改", "看不懂"],
      }),
    );
    sh.rows.push(row);
  }
  return sh;
}

function sheetGlossary(oir: OIR): Sheet {
  const sh = makeSheet(
    "05_术语表",
    "系统识别到的别名。如果某个别名其实指的是别的东西，请在这里指出。",
    ["standard", "aliases", "correct"],
  );
  for (const o of oir.objects.values()) {
    if (!pyTruthy(o.aliases)) continue;
    const row = new Map<string, Cell>();
    row.set(
      "standard",
      makeCell(o.rid, sh.name, "standard", o.displayName.value, Role.LOCKED),
    );
    row.set(
      "aliases",
      makeCell(o.rid, sh.name, "aliases", pyJoin("、", o.aliases), Role.PREFILLED),
    );
    row.set(
      "correct",
      makeCell(o.rid, sh.name, "correct", "", Role.REQUIRED, {
        options: ["正确", "有误"],
        owner: o.owner,
      }),
    );
    sh.rows.push(row);
  }
  return sh;
}

/** 把 OIR 编译成填写模板规格。 */
export function compileTemplate(
  oir: OIR,
  conflicts?: readonly ConflictLike[] | null,
  opts: { roundNo?: number } = {},
): TemplateSpec {
  const roundNo = opts.roundNo ?? 1;
  const conflicted = new Set<string>();
  const notes = new Map<string, string[]>();
  for (const c of conflicts ?? []) {
    for (const rid of c.subjects) {
      conflicted.add(rid);
      const bucket = notes.get(rid);
      if (bucket) bucket.push(c.summary);
      else notes.set(rid, [c.summary]);
    }
  }

  const spec = new TemplateSpec({ round: roundNo });
  // 顺序即优先级：业务人员从上往下填，最该他答的排在最前面。
  // 待澄清问题和业务规则以前根本不在模板里 —— OIR 里最贵的两类内容在编译这
  // 一步整体蒸发，而剩下的 apiName / baseType / cardinality 他一列都读不懂。
  for (const build of [sheetQuestions, sheetRules]) {
    const sh = build(oir);
    if (pyTruthy(sh.rows)) spec.sheets.push(sh);
  }
  spec.sheets.push(sheetObjects(oir, conflicted, notes));
  for (const build of [sheetProperties, sheetLinks]) {
    const sh = build(oir, conflicted, notes);
    // **空表一律不出。** 一张只有表头的「属性明细」配上一句"口径定义是本轮
    // 重点"，是这份模板给业务方最强的指令指向一张空表。
    if (pyTruthy(sh.rows)) spec.sheets.push(sh);
  }
  for (const build of [sheetActions, sheetGlossary]) {
    const sh = build(oir);
    if (pyTruthy(sh.rows)) spec.sheets.push(sh);
  }
  return spec;
}

// ══════════════════════════════════════════════════════════════════
//  写出 xlsx
// ══════════════════════════════════════════════════════════════════

/** 填充色即语义。**openpyxl 写的是 6 位十六进制，读回来带 `00` 前缀**，
 * exceljs 要显式给 8 位 ARGB —— 给 `FF` 前缀会让两边的产物 diff 不上。 */
export const FILL: Readonly<Record<Role, string>> = {
  [Role.REQUIRED]: "FDF6E3", // 黄：业务必填
  [Role.LOCKED]: "F3F1ED", // 灰：已定只读
  [Role.PREFILLED]: "FFFFFF", // 白：可改
  [Role.GUIDE]: "EEF1F6",
};

const ARGB = (rgb6: string): string => `00${rgb6}`;

/** exceljs 的表级数据校验集合（d.ts 里没有，运行时有 —— 见 writeXlsx 的注释）。 */
interface DataValidationsApi {
  add(address: string, validation: import("exceljs").DataValidation): unknown;
}

/** 列号 → 列字母（openpyxl 的 `cell.column_letter`）。 */
export function columnLetter(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = n % 26 || 26;
    out = String.fromCharCode(64 + rem) + out;
    n = (n - rem) / 26;
  }
  return out;
}

/**
 * 写出带样式、校验、批注和隐藏锚点列的 xlsx。
 *
 * 与 openpyxl 产物**唯一的已知差异**（用 openpyxl 读回逐字段比对过，其余全等）：
 * **批注的作者**。openpyxl 写 `"OntoCopilot"`，exceljs 把作者名写死成 `"Author"`
 * （`comments-xform.js` 里有个 TODO）。批注正文一字不差，受影响的只有 Excel
 * 审阅面板里显示的作者名。
 *
 * 为了对齐而特意做的一件事：**值为空串的格不写值，只写样式**。openpyxl 的
 * `value=""` 落盘就是一个没有值的格（读回来是 None）；写成空串会让 `ISBLANK` /
 * `COUNTA` 的结果变掉，而业务方的表里常有这类公式。
 *
 * 另有一处 openpyxl 的行为**没有跟**：openpyxl 会把以 `=` 开头的字符串当成公式
 * 写进去（`data_type='f'`）。规则原文这类自由文本一旦以 `=` 开头，openpyxl 产出
 * 的表在 Excel 里会报公式错误 —— 这里一律当文本写。
 */
export async function writeXlsx(
  spec: TemplateSpec,
  path: string,
  opts: { project?: string } = {},
): Promise<string> {
  const project = opts.project ?? "";
  const wb = new ExcelJS.Workbook();

  const thin = { style: "thin" as const, color: { argb: ARGB("E0DDD6") } };
  const border = { left: thin, right: thin, top: thin, bottom: thin };
  const headFont = { bold: true, size: 10, color: { argb: ARGB("4A453C") } };
  const guideFont = { italic: true, size: 10, color: { argb: ARGB("6B6862") } };

  // ── 填写指引 ────────────────────────────────────────────────
  const gs = wb.addWorksheet("00_填写指引");
  gs.getColumn(1).width = 100;
  const lines = [
    `OntoCopilot 实体梳理模板 · ${project} · 第 ${spec.round} 轮`,
    "",
    "颜色含义：",
    "  黄底  = 业务必填，本轮需要你填写或确认",
    "  灰底  = 已定，只读，请勿改动",
    "  白底  = 系统预填，如有出入可直接改",
    "  红角标 = 存在冲突，把鼠标停在格子上看批注",
    "",
    "填写要点：",
    "  1. 「口径定义」是本轮重点。请写清含税/不含税、时间粒度、口径主体。",
    "  2. 预填值不是结论。原样交回等于没审，系统会识别出来并再次打回。",
    "  3. 每张表第一行是本表的填写说明，已冻结。",
    "  4. 前两列被隐藏，是系统的对齐锚点，请勿删除或改动行结构以外的内容。",
    "",
    `本轮统计：${statsJson(spec.stats())}`,
  ];
  lines.forEach((text, i) => {
    const c = gs.getCell(i + 1, 1);
    if (text !== "") c.value = text;
    c.font = { bold: i === 0, size: i === 0 ? 12 : 10 };
    c.alignment = { wrapText: true, vertical: "top" };
  });

  // ── 数据表 ──────────────────────────────────────────────────
  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);

    // 第 1 行：填写说明；第 2 行：表头；数据从第 3 行开始
    const g = ws.getCell(1, 1);
    if (sheet.guide !== "") g.value = sheet.guide;
    g.font = guideFont;
    ws.mergeCells(1, 1, 1, Math.max(3, sheet.columns.length + 2));
    ws.getRow(1).height = 30;

    const headers = [ANCHOR_RID, ANCHOR_HASH, ...sheet.columns];
    headers.forEach((name, i) => {
      const c = ws.getCell(2, i + 1);
      c.value = name;
      c.font = headFont;
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ARGB("FAF9F6") } };
      c.border = border;
    });

    sheet.rows.forEach((row, i) => {
      const r = i + 3;
      const first = row.values().next().value as Cell | undefined;
      // Python 是 `next(iter(row.values()))`：空行当场 StopIteration。
      if (first === undefined) throw new Error("StopIteration: 空行没有任何单元格");
      ws.getCell(r, 1).value = first.rid;
      const hash = [...row.entries()]
        .filter(([, c]) => prefillHash(c) !== "")
        .map(([f, c]) => `${f}=${prefillHash(c)}`)
        .join("|");
      if (hash !== "") ws.getCell(r, 2).value = hash;
      sheet.columns.forEach((name, j) => {
        const cell = row.get(name);
        if (cell === undefined) return;
        const x = ws.getCell(r, j + 3);
        if (cell.value !== "") x.value = cell.value;
        x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ARGB(FILL[cell.role]) } };
        x.border = border;
        x.alignment = { wrapText: true, vertical: "top" };
        if (cell.role === Role.REQUIRED) x.font = { bold: true, color: { argb: ARGB("8A6D1F") } };
        if (cell.comment) {
          x.note = { texts: [{ text: sliceCodePoints(cell.comment, 900) }] };
        }
        if (cell.conflict) {
          // 红角标：openpyxl 没有原生角标，用红色粗边框 + 批注等效表达
          const red = { style: "medium" as const, color: { argb: ARGB("9C3B32") } };
          x.border = { left: thin, right: red, top: red, bottom: thin };
        }
      });
    });

    // 枚举列做下拉：错误在业务方那端就被拦住，比回传后再打回便宜得多
    sheet.columns.forEach((name, j) => {
      const col = j + 3;
      let opts2: string[] | null = null;
      for (const row of sheet.rows) {
        const c = row.get(name);
        if (c && pyTruthy(c.options)) {
          opts2 = c.options;
          break;
        }
      }
      if (!opts2) return;
      const letter = columnLetter(col);
      // exceljs 的 index.d.ts 只暴露了单元格上的 `cell.dataValidation`，而**按格设**
      // 会写出一格一条 `<dataValidation>`；openpyxl 写的是一条带区间 sqref 的。
      // 表级的 `ws.dataValidations.add(区间, …)` 运行时是有的，只是 d.ts 漏了。
      const dvs = (ws as unknown as { dataValidations: DataValidationsApi }).dataValidations;
      const last = Math.max(3, sheet.rows.length + 2);
      // openpyxl 的 sqref 会把 `E3:E3` 归一成 `E3`，这里照做 —— 不然产物的
      // XML 与 Python 时代的表在这一处逐字不同。
      const sqref = last === 3 ? `${letter}3` : `${letter}3:${letter}${last}`;
      dvs.add(sqref, {
        type: "list",
        allowBlank: true,
        formulae: [`"${opts2.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "取值不在允许范围",
        error: `请从下拉中选择：${opts2.join("、")}`,
      });
    });

    ws.getColumn(1).hidden = true; // _oir_rid
    ws.getColumn(2).hidden = true; // _oir_hash
    sheet.columns.forEach((name, j) => {
      ws.getColumn(j + 3).width = name === "definition" || name === "description" ? 40 : 20;
    });
    // freeze_panes = "C3"
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];
  }

  mkdirSync(dirname(path), { recursive: true });
  await wb.xlsx.writeFile(path);
  return path;
}
