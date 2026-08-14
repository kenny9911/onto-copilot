/**
 * 对话动态改模板 —— 结构化编辑 + 不变量守卫。移植自
 * `src/ontocopilot/onto/template_edit.py`，由 `golden/template.json` 的
 * `edits` 段钉住（37 个 case，每条的人话说明与拒绝理由都逐字比对）。
 *
 * FDE 拿到生成的模板，常常要改：加一列备注、删掉填不了的 primaryKey、把一张大表
 * 拆开、改某列的必填性。他希望通过对话让 Copilot 改，而不是我们改代码 —— 模板
 * 应该是**动态的**，不是写死的。
 *
 * 但"让 AI 改 xlsx 模板"有一个致命陷阱：这份 xlsx 靠隐藏锚点列 `_oir_rid` /
 * `_oir_hash` 做往返回读，而**列名 == Cell.field == 回写 key 是三位一体的**。
 * 模型直接吐一张新 xlsx，锚点必丢、整表回读报废，而且不报错 —— 业务方填完交回，
 * 发现什么都没读进来。
 *
 * 所以这里的做法是：**模型只选操作和参数，绝不直接生成模板。** 编辑是一组
 * 结构化操作（加列/删列/改名/加表/改角色…），每个操作维持三位一体，每次编辑后
 * 跑一遍守卫 —— 违反就拒绝并说清为什么，不静默应用。
 *
 * 守卫挡的正是往返契约会断的地方：
 *     G1 不许出现空表         G2 锚点列删不掉、列名唯一
 *     G5 REQUIRED 必须有回写路径（否则读进来算完成度却在合并时静默丢 = 黑洞）
 *     G6 同一 (rid,field) 不能跨表重复（by_rid 会塌成一个）
 *     G9 新表的每行 rid 必须能在 OIR 里查到（否则假锚点）
 *
 * ── 移植时的一个刻意选择 ────────────────────────────────────────
 *
 * Python 是 `fn(trial, **args)`，参数不对由 CPython 抛 TypeError，再被包成
 * 「add_column 的参数不对：…」。**这里连 CPython 的 TypeError 文案一起复现**
 * （`_op_add_column() missing 1 required keyword-only argument: 'name'`），
 * 因为这条消息会被原样转述给模型和用户 —— 换一套措辞，模型学到的自纠模式就
 * 与 Python 时代的日志对不上了。
 */

import { pyRepr } from "../kernel/errors.js";
import {
  ANCHOR_HASH,
  ANCHOR_RID,
  PROSE_FIELDS,
  Role,
  TemplateSpec,
  compileTemplate,
  makeCell,
  type Cell,
  type ConflictLike,
  type Sheet,
} from "./template.js";
import type { OIR } from "./oir.js";

/**
 * merge_into_oir 里有 case 的字段。REQUIRED 列的 field 必须在这里，否则业务方
 * 填了、完成度算了、合并时却 case _ 静默丢 —— 实测过的"627 填→172 落回"黑洞。
 * 与 audit.py 的 match 分支一一对应，改那边要同步改这里。
 */
export const WRITEBACK_FIELDS: ReadonlySet<string> = new Set([
  "definition",
  "description",
  "displayName",
  "cardinality",
  "owner",
  "primaryKey",
  "effects",
  "答复",
  "执行角色",
  "这条对吗",
  "管哪个单据",
]);

/**
 * 一律不许提成 REQUIRED 的列。primaryKey 是数据建模词汇，172 行全空、只有 FDE
 * 答得了、独占完成度权重 58% —— 把它设成必填就重犯了那次让达标线永远够不到的坑。
 */
export const REQUIRED_BLOCKLIST: ReadonlySet<string> = new Set(["primaryKey"]);

/** 注意**没有 guide**：那是填写指引的角色，不能设到数据格上。 */
const ROLES: Readonly<Record<string, Role>> = {
  locked: Role.LOCKED,
  prefilled: Role.PREFILLED,
  required: Role.REQUIRED,
};

/** 一次编辑违反了守卫。消息要说清**为什么不能这么改**，让模型能转述给用户。 */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
    Object.setPrototypeOf(this, EditError.prototype); // 保住 instanceof
  }
}

// ── Python 语义垫片 ────────────────────────────────────────────────

/** `f"{sorted(xs)}"` —— Python 的 list repr（元素用 repr，`, ` 分隔）。
 * 消息里那串可用字段名是给模型看的，形态错了它会照着编一个不存在的名字。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** Python `sorted()` 按 code point 比；JS 默认 sort 按 UTF-16 code unit。
 * WRITEBACK_FIELDS 里中英混排，BMP 内两者一致。 */
function sortedCodePoint(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => {
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
  });
}

/** Python 的 `str.isdigit()`（近似）。
 *
 * CPython 认 Numeric_Type=Digit，比 `\p{Nd}` 多出上标 `²`、带圈 `①` 这类；
 * JS 的正则没有这个属性，这里只认 `\p{Nd}`。**受影响的只有"表名头两个字符是
 * 带圈数字"这种情况**，而表名编号来自编译器（`01_` / `05_`），不是外部输入。 */
function pyIsDigit(s: string): boolean {
  return s !== "" && /^\p{Nd}+$/u.test(s);
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

// ══════════════════════════════════════════════════════════════════
//  守卫
// ══════════════════════════════════════════════════════════════════

/** 编辑后的全量校验。任何一条不过就整体拒绝 —— 半应用的模板比不改更糟。 */
function guard(spec: TemplateSpec): void {
  for (const sh of spec.sheets) {
    // G1 不许空表（有列定义却没有数据行，发出去是张只有表头的空表）
    if (pyTruthy(sh.columns) && !pyTruthy(sh.rows)) {
      throw new EditError(`「${sh.name}」会变成一张空表，没有数据行。`);
    }
    // G2 列名唯一
    if (sh.columns.length !== new Set(sh.columns).size) {
      const dup = sh.columns.filter((c) => sh.columns.filter((x) => x === c).length > 1);
      throw new EditError(
        `「${sh.name}」有重名的列：${dup[0] as string}。列名必须唯一，` +
          `否则回读时按名取列会静默取错。`,
      );
    }
    // 三位一体：每行的 dict key 必须等于该行每个 cell 的 field，且都在 columns 里
    for (const row of sh.rows) {
      for (const [key, cell] of row) {
        if (cell.field !== key) {
          throw new EditError(
            `「${sh.name}」里 ${cell.rid} 的列 ${key} 和它的` +
              `字段名 ${cell.field} 对不上 —— 回读会失配。`,
          );
        }
        if (!sh.columns.includes(key) && key !== ANCHOR_RID && key !== ANCHOR_HASH) {
          throw new EditError(
            `「${sh.name}」有一列 ${key} 不在列定义里，` + `它不会被渲染却会进回读索引。`,
          );
        }
      }
    }
  }
  // G6 同一 (rid,field) 不能跨表出现两次 —— by_rid 会把它塌成一个，回读报重复
  const seen = new Map<string, string>();
  for (const sh of spec.sheets) {
    for (const row of sh.rows) {
      for (const cell of row.values()) {
        const key = `${cell.rid}\u0000${cell.field}`;
        const prev = seen.get(key);
        if (prev !== undefined && prev !== sh.name) {
          throw new EditError(
            `${cell.rid}.${cell.field} 同时出现在「${prev}」和` +
              `「${sh.name}」两张表 —— 回读时会互相覆盖。`,
          );
        }
        seen.set(key, sh.name);
      }
    }
  }
}

function findSheet(spec: TemplateSpec, name: string): Sheet {
  const hit = spec.sheets.find((x) => x.name === name);
  if (hit !== undefined) return hit;
  // 容错：模型多半不知道表名带 `01_` 前缀，说「对象清单」指的是
  // 「01_对象清单」。按去掉编号前缀后的包含关系匹配，唯一命中才认。
  const bare = (n: string): string => {
    if (!pyIsDigit([...n].slice(0, 2).join(""))) return n;
    const i = n.indexOf("_");
    return i === -1 ? n : n.slice(i + 1);
  };
  const cands = spec.sheets.filter(
    (x) => bare(x.name).includes(bare(name)) || bare(name).includes(bare(x.name)),
  );
  if (cands.length === 1) return cands[0] as Sheet;
  throw new EditError(
    `没有名为「${name}」的表。现有：` + `${spec.sheets.map((x) => x.name).join("、")}`,
  );
}

function roleOf(name: string): Role {
  const r = ROLES[name];
  if (r === undefined) {
    throw new EditError(`未知的角色 ${name}，只能是 locked/prefilled/required。`);
  }
  return r;
}

// ══════════════════════════════════════════════════════════════════
//  操作
// ══════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

function opSetGuide(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const sh = findSheet(spec, sheet);
  sh.guide = a["text"] as string;
  // 回显的是**调用方给的那个串**（可能是模糊名），与 Python 一致 ——
  // 用户说「对象清单」，回一句「改了『01_对象清单』」反而像改错了表。
  return `改了「${sheet}」的填写说明。`;
}

function opReorderSheets(spec: TemplateSpec, a: Args): string {
  const order = a["order"] as string[];
  const names = new Set(spec.sheets.map((x) => x.name));
  const same =
    new Set(order).size === names.size && [...new Set(order)].every((x) => names.has(x));
  if (!same) {
    throw new EditError(
      "新顺序必须是现有表的一个排列，不能增删表。" + `现有：${pyReprList(sortedCodePoint(names))}`,
    );
  }
  spec.sheets.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
  return `表的顺序调整为：${order.join(" → ")}。`;
}

function opAddColumn(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const name = a["name"] as string;
  const role = a["role"] as string;
  const value = a["value"] as string;
  const comment = a["comment"] as string;
  const owner = a["owner"] as string | null;
  const options = a["options"] as string[] | null;

  const sh = findSheet(spec, sheet);
  if (sh.columns.includes(name)) {
    throw new EditError(`「${sheet}」已经有一列叫 ${name} 了。`);
  }
  const r = roleOf(role);
  // G5：要业务方填（REQUIRED）的列，必须有回写路径，否则填了白填
  if (r === Role.REQUIRED && !WRITEBACK_FIELDS.has(name)) {
    throw new EditError(
      `「${name}」设成必填，但它没有回写到模型的路径 —— 业务方填了会被` +
        `算进完成度，却在合并时静默丢弃。要么设成展示列（prefilled/locked），` +
        `要么用一个有回写路径的字段名：${pyReprList(sortedCodePoint(WRITEBACK_FIELDS))}`,
    );
  }
  if (REQUIRED_BLOCKLIST.has(name) && r === Role.REQUIRED) {
    throw new EditError(`「${name}」不适合设成必填（见既有说明），换成展示列。`);
  }
  if (pyTruthy(options)) {
    checkOptions(dedupeNonBlank(options as string[]));
  }
  sh.columns.push(name);
  for (const row of sh.rows) {
    const first = row.values().next().value as Cell | undefined;
    if (first === undefined) throw new Error("StopIteration: 空行没有任何单元格");
    // **必须用 sh.name，不是调用方传的 sheet。** findSheet 是模糊匹配的
    // （模型说「对象清单」，实际表名是「01_对象清单」），把调用方那个串写进
    // Cell.sheet 会让这一格的回读身份指向一张不存在的表 —— 业务方填了，
    // 合并时按 (sheet, rid, field) 对不上，静默丢弃。
    //
    // 注意 options 传的是**原始列表**（没去重、没去空白），只有校验用的是
    // 去重后的那份 —— 照抄 Python，不"顺手修好"。
    row.set(
      name,
      makeCell(first.rid, sh.name, name, value, r, { owner, comment, options }),
    );
  }
  return `给「${sh.name}」加了一列「${name}」（${role}）。`;
}

function opDropColumn(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const column = a["column"] as string;
  const sh = findSheet(spec, sheet);
  if (column === ANCHOR_RID || column === ANCHOR_HASH) {
    throw new EditError(`${column} 是隐藏的回读锚点列，删了整表就读不回来了。`);
  }
  if (!sh.columns.includes(column)) {
    throw new EditError(`「${sheet}」没有列 ${column}。`);
  }
  if (sh.columns.length <= 1) {
    throw new EditError(`「${sheet}」只剩这一列了，删了就是空表。`);
  }
  sh.columns.splice(sh.columns.indexOf(column), 1);
  // 幽灵 cell：只删 columns 不删 rows[column]，cells() 仍会摊到它、进回读索引
  for (const row of sh.rows) row.delete(column);
  return `删掉了「${sheet}」的「${column}」列。`;
}

function opRenameColumn(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const old = a["old"] as string;
  const neu = a["new"] as string;
  const sh = findSheet(spec, sheet);
  if (old === ANCHOR_RID || old === ANCHOR_HASH) {
    throw new EditError(`${old} 是回读锚点列，不能改名。`);
  }
  if (!sh.columns.includes(old)) {
    throw new EditError(`「${sheet}」没有列 ${old}。`);
  }
  if (sh.columns.includes(neu)) {
    throw new EditError(`「${sheet}」已经有一列叫 ${neu} 了。`);
  }
  // 三处联动：列名、每行 dict key、每个 Cell.field 一次全改
  sh.columns[sh.columns.indexOf(old)] = neu;
  for (const row of sh.rows) {
    const cell = row.get(old);
    if (cell === undefined) continue;
    row.delete(old);
    // 改名切断回写路径：**任何本来能回写的列**都算，不只是 REQUIRED。
    // prefilled 的 definition/owner 同样有 merge_into_oir 的 case，业务方
    // 照样会改它；只守 REQUIRED 的话，把 owner 改成「负责人」就悄悄把这一列
    // 的回写断了 —— 填了、算进完成度、合并时丢掉。
    if (WRITEBACK_FIELDS.has(old) && !WRITEBACK_FIELDS.has(neu)) {
      throw new EditError(
        `「${old}」的内容能回写进模型，改名成「${neu}」会切断这条路径` +
          `（业务方填了会在合并时静默丢弃）。可用的名字：` +
          `${pyReprList(sortedCodePoint(WRITEBACK_FIELDS))}`,
      );
    }
    cell.field = neu;
    cell.expectsProse = PROSE_FIELDS.has(neu) && !pyTruthy(cell.options);
    row.set(neu, cell);
  }
  return `把「${sheet}」的「${old}」列改名为「${neu}」。`;
}

function opSetRole(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const column = a["column"] as string;
  const role = a["role"] as string;
  const sh = findSheet(spec, sheet);
  if (column === ANCHOR_RID || column === ANCHOR_HASH) {
    throw new EditError(`${column} 是锚点列，角色不能改。`);
  }
  const r = roleOf(role);
  if (r === Role.REQUIRED) {
    if (REQUIRED_BLOCKLIST.has(column)) {
      throw new EditError(`「${column}」不适合设成必填。`);
    }
    if (!WRITEBACK_FIELDS.has(column)) {
      throw new EditError(`「${column}」设成必填但没有回写路径 —— 填了会静默丢。`);
    }
  }
  let n = 0;
  for (const row of sh.rows) {
    const cell = row.get(column);
    if (cell !== undefined) {
      cell.role = r;
      n += 1;
    }
  }
  if (!n) throw new EditError(`「${sheet}」没有列 ${column}。`);
  return `把「${sheet}」的「${column}」列改成 ${role}。`;
}

/**
 * Excel 内联下拉（DataValidation formula1）的硬限制：整串带引号不超过 255 字符，
 * 且选项里不能有英文逗号（那是分隔符）或双引号（那是定界符）。超了/带了，openpyxl
 * 照写不误，但**打开的 xlsx 里这一列的下拉是坏的或整表报修复** —— 而我们直到业务方
 * 打不开文件才会知道。所以在编辑这一步就拒绝，并说清怎么改。
 */
const DV_MAX = 255;

/** `[o for o in dict.fromkeys(options) if str(o).strip()]` —— 保序去重 + 去空白。 */
function dedupeNonBlank(options: readonly unknown[]): string[] {
  return [...new Set(options)].filter((o) => pyStr(o).trim() !== "").map((o) => o as string);
}

function checkOptions(opts: readonly string[]): void {
  const bad = opts.filter((o) => o.includes(",") || o.includes('"'));
  if (bad.length > 0) {
    throw new EditError(
      `下拉选项里不能带英文逗号或双引号（Excel 用它们做分隔符）：` +
        `${pyReprList(bad.slice(0, 3))}。改成顿号或去掉引号。`,
    );
  }
  const inline = '"' + opts.join(",") + '"';
  // `len()` 数的是 code point，不是 UTF-16 code unit —— 选项里有 emoji 时
  // JS 的 .length 会多算，把一份 Excel 打得开的表拒掉。
  const n = [...inline].length;
  if (n > DV_MAX) {
    throw new EditError(
      `下拉选项总长 ${n} 字符，超过 Excel 内联下拉的 ` +
        `${DV_MAX} 上限（写出去的表会打不开）。减少选项或改用说明文字。`,
    );
  }
}

function opSetOptions(spec: TemplateSpec, a: Args): string {
  const sheet = a["sheet"] as string;
  const column = a["column"] as string;
  const sh = findSheet(spec, sheet);
  const opts = dedupeNonBlank(a["options"] as unknown[]);
  if (opts.length < 2) throw new EditError("下拉至少要有两个选项。");
  checkOptions(opts);
  let n = 0;
  for (const row of sh.rows) {
    const cell = row.get(column);
    if (cell !== undefined) {
      cell.options = [...opts];
      cell.expectsProse = false; // 有下拉就不是散文
      n += 1;
    }
  }
  if (!n) throw new EditError(`「${sheet}」没有列 ${column}。`);
  return `把「${sheet}」的「${column}」列改成下拉：${opts.join("/")}。`;
}

/** 一个操作的签名。`fn` 是 Python 侧的函数名 —— 它进 TypeError 文案。 */
interface OpDef {
  fn: string;
  required: readonly string[];
  defaults: Readonly<Record<string, unknown>>;
  run: (spec: TemplateSpec, a: Args) => string;
}

const OPS: Readonly<Record<string, OpDef>> = {
  set_guide: {
    fn: "_op_set_guide",
    required: ["sheet", "text"],
    defaults: {},
    run: opSetGuide,
  },
  reorder_sheets: {
    fn: "_op_reorder_sheets",
    required: ["order"],
    defaults: {},
    run: opReorderSheets,
  },
  add_column: {
    fn: "_op_add_column",
    required: ["sheet", "name"],
    defaults: { role: "prefilled", value: "", comment: "", owner: null, options: null },
    run: opAddColumn,
  },
  drop_column: {
    fn: "_op_drop_column",
    required: ["sheet", "column"],
    defaults: {},
    run: opDropColumn,
  },
  rename_column: {
    fn: "_op_rename_column",
    required: ["sheet", "old", "new"],
    defaults: {},
    run: opRenameColumn,
  },
  set_role: {
    fn: "_op_set_role",
    required: ["sheet", "column", "role"],
    defaults: {},
    run: opSetRole,
  },
  set_options: {
    fn: "_op_set_options",
    required: ["sheet", "column", "options"],
    defaults: {},
    run: opSetOptions,
  },
};

/** CPython 缺参数时的文案：1 个是 `argument: 'a'`，2 个是 `'a' and 'b'`，
 * 3 个及以上是 `'a', 'b' and 'c'`。 */
function missingArgsMessage(fn: string, missing: readonly string[]): string {
  const q = missing.map((m) => `'${m}'`);
  const names =
    q.length === 1
      ? (q[0] as string)
      : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1] as string}`;
  const plural = missing.length > 1 ? "s" : "";
  return `${fn}() missing ${missing.length} required keyword-only argument${plural}: ${names}`;
}

/** `fn(trial, **args)` 的等价物：补默认值、缺参数/多参数按 CPython 的文案报错。 */
function bindArgs(op: string, def: OpDef, args: Args): Args {
  const known = new Set([...def.required, ...Object.keys(def.defaults)]);
  for (const k of Object.keys(args)) {
    if (!known.has(k)) {
      throw new EditError(
        `${op} 的参数不对：${def.fn}() got an unexpected keyword argument ${pyRepr(k)}`,
      );
    }
  }
  const missing = def.required.filter((k) => !(k in args));
  if (missing.length > 0) {
    throw new EditError(`${op} 的参数不对：${missingArgsMessage(def.fn, missing)}`);
  }
  return { ...def.defaults, ...args };
}

/**
 * 对模板规格应用一次结构化编辑，成功返回一句人话说明。
 *
 * **在一份副本上应用、守卫通过后才写回** —— 半应用的模板（改了一半守卫拒绝）
 * 比不改更危险。守卫失败抛 {@link EditError}，调用方转述给用户，原规格不动。
 */
export function applyEdit(spec: TemplateSpec, op: string, args: Args): string {
  const def = OPS[op];
  if (def === undefined) {
    throw new EditError(
      `不支持的编辑操作 ${op}。支持：${pyReprList(sortedCodePoint(Object.keys(OPS)))}`,
    );
  }
  // 在副本上做，守卫过了再换 —— 原子性
  const trial = TemplateSpec.fromDict(spec.toDict());
  const bound = bindArgs(op, def, args);
  let note: string;
  try {
    note = def.run(trial, bound);
  } catch (exc) {
    // Python 是 `except TypeError` 包住整个调用：模型给了个类型不对的参数
    // （options 传成字符串、order 传成数字）不该把调用方打崩，而该变成一句
    // 能转述的话。**消息正文与 CPython 不同**（那是解释器生成的），前缀一致。
    if (!(exc instanceof TypeError)) throw exc;
    throw new EditError(`${op} 的参数不对：${exc.message}`);
  }
  guard(trial);
  // 通过：把 trial 的内容搬回 spec（保持同一个对象引用，调用方持有它）
  spec.sheets = trial.sheets;
  spec.round = trial.round;
  return note;
}

/** 一条结构编辑的记录。`args` 缺省时按空对象处理（`p.get("args") or {}`）。 */
export interface PatchEntry {
  op: string;
  args?: Args;
  [k: string]: unknown;
}

/** 重放不上的那条，带上为什么。 */
export type StalePatch = PatchEntry & { why: string };

/**
 * 在「按当前 OIR 新编译」的 spec 上重放人工结构编辑，得到既纳入 OIR 改动、
 * 又保留手改的模板。返回 `[spec, stale]`。
 *
 * 根因：`template.recompile` 一旦发现模板被编辑过，就走「渲染冻结 spec」分支、
 * 永不回读 OIR —— 于是采纳建议/口述/答题改的 OIR 到不了这张模板。
 *
 * 能这样合并，靠一条关键性质：**`template.edit` 只改结构（列/角色/下拉/说明/
 * 顺序），从不改单元格的值** —— 值永远来自 OIR。所以在新编译（OIR 最新）的 spec 上
 * 重放结构 op，正是想要的合并，不存在「值 vs OIR」的冲突。重放不上的 op（比如某张表
 * 的行全没了）收集为 stale 上报，**不致命**。
 */
export function reconcileTemplate(
  oir: OIR,
  conflicts: readonly ConflictLike[] | null | undefined,
  patchLog: readonly PatchEntry[] | null | undefined,
): [TemplateSpec, StalePatch[]] {
  const fresh = compileTemplate(oir, conflicts);
  const stale: StalePatch[] = [];
  for (const p of patchLog ?? []) {
    try {
      applyEdit(fresh, p.op, p.args ?? {});
    } catch (exc) {
      // 只吞 EditError。别的（比如规格本身坏了）必须炸出来 —— Python 侧
      // `except EditError` 同样只接这一种，JS 没有分类捕获，要显式判。
      if (!(exc instanceof EditError)) throw exc;
      stale.push({ ...p, why: exc.message });
    }
  }
  return [fresh, stale];
}
