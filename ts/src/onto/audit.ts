/**
 * 回传审核器 —— 业务方填完交回来之后的这一关。移植自 `src/ontocopilot/onto/audit.py`。
 *
 * 流程：**锚点对齐 → 单元格级 diff → 规则审核 → 语义审核 → 自动修 → 按责任人打回**。
 *
 * 锚点是全部精度的来源。业务方会增删行、重排序、改列宽、复制粘贴 —— 按行号对齐
 * 必然错位，按内容模糊匹配会把改过名的行判成新增。隐藏的 `_oir_rid` 让这一切
 * 都不成问题，也让「这格有没有被动过」变成一次哈希比对。
 *
 * 分工照旧（架构文档 ADR-5）：必填缺失、枚举越界、命名规范走确定性规则，秒级、
 * 零成本、零方差；只有口径矛盾和疑似敷衍交模型，且先用启发式收窄候选。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`(rid, field)` 元组键**：JS 没有值相等的元组，全部走 `template.ts` 的
 *     {@link ridFieldKey}（NUL 拼串）。`new_rows` 要把键拆回 rid，见 {@link splitKey}。
 *  2. **`sorted()` 按 code point**：`unmatched_rows` / `new_rows` 里全是带中文的
 *     rid，JS 默认 sort 按 UTF-16 code unit 排。
 *  3. **`round(x, 4)`**：Python 是 round-half-**even**。完成度会印进产物、决定
 *     FDE 要不要再发一轮，差一位就是两边 diff 全红。见 {@link pyRound}。
 *  4. **slots dataclass 的 setattr**：`entity.display_name = …` 在 Python 里对
 *     没有这个字段的实体（规则/问题/关系/动作）抛 AttributeError。TS 里给对象
 *     加个新键是静默成功的 —— 那意味着回写"成功"了但没人看得见，
 *     所以 {@link setAttr} 显式抛。
 *  5. **`axis_diff` 的轴顺序**：Python 是 `pa.keys() & pb.keys()`（set，顺序
 *     由哈希定），`conflict.ts` 固定成了 AXES 声明序。多轴分歧的 summary 里
 *     各轴片段的先后因此可能与 Python 不同（内容一致）。这是 conflict 那一侧
 *     已经拍板的分叉，这里跟随，不再另发明一套。
 */

import { sha256Hex } from "../kernel/ids.js";
import {
  ConflictKind,
  Handling,
  axisDiff,
  handlingOf,
  makeConflict,
  makeOption,
  perfunctorySignals,
  toCamel,
  type Conflict,
} from "./conflict.js";
import {
  Origin,
  Status,
  byUser,
  type ActionType,
  type BusinessRule,
  type LinkType,
  type OIR,
  type ObjectType,
  type OpenQuestion,
  type PropertyType,
} from "./oir.js";
import { readSheetGrids } from "./parse/tabular.js";
import {
  ANCHOR_HASH,
  ANCHOR_RID,
  Role,
  WEIGHTS,
  ridFieldKey,
  type Cell,
  type TemplateSpec,
} from "./template.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** `conflict.ts` 的 `cid` 没有导出。**这是一份有意的、待收口的副本** ——
 * 冲突 rid 是跨轮次去重的唯一凭据（同一格重复报会让打回单里出现两条一模一样
 * 的问题），两侧算法必须逐字一致。等 conflict.ts 把 `cid` 导出后，这里应当
 * 直接 import 掉这份副本。 */
function cid(kind: ConflictKind, ...parts: string[]): string {
  return `cf_${kind}_${sha256Hex(parts.join("|")).slice(0, 10)}`;
}

/** 同上，来自 `conflict.ts` 的私有常量，逐字复制。
 *
 * Python 的 `$` 除了串尾，还匹配**末尾那一个换行之前**的位置 ——
 * `re.match(r"^[a-z][a-zA-Z0-9]*$", "planAmount\n")` 是匹配的。 */
const CAMEL_RE = /^[a-z][a-zA-Z0-9]*\n?$/u;
/** Python 侧字面写的是 `[㐀-鿿]`，也就是 U+3400–U+9FFF。 */
const HAS_CJK = /[㐀-鿿]/u;

/** Python 的 `sorted()` 比字符串按 code point。 */
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

function sortedCp(items: Iterable<string>): string[] {
  return [...items].sort(cmpCodePoint);
}

/** Python 的 `s[:n]`：按 code point 切。 */
function head(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python 的 `round(x, nd)` —— round-half-**even**。
 *
 * `Math.round(x * 10**nd) / 10**nd` 是 half-**up**，而且乘法本身还会再引入一次
 * 舍入误差。这里先用 `toFixed(20)` 拿到 double 的精确十进制展开，只有当尾巴
 * 恰好是 `5000…0` 时才是真正的平局，这时按末位取偶。
 *
 * 与 `oir.ts` 的 `round3` 同法（那一份已被 golden 钉死），这里推广到任意位数
 * 是因为完成度用的是 `round(x, 4)`。 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const [int = "0", frac = ""] = Math.abs(x).toFixed(20).split(".");
  const keep = frac.slice(0, nd).padEnd(nd, "0");
  const rest = frac.slice(nd);
  const h = rest[0] ?? "0";
  let up: boolean;
  if (h > "5") up = true;
  else if (h < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(keep[nd - 1] ?? int[int.length - 1]) % 2 === 1;
  const digits = up ? incDecimal(int + keep) : int + keep;
  const padded = digits.padStart(nd + 1, "0");
  const n =
    nd === 0
      ? Number(padded)
      : Number(`${padded.slice(0, -nd)}.${padded.slice(-nd)}`);
  return neg ? -n : n;
}

/** 十进制字符串 +1（只处理非负整数串）。 */
function incDecimal(s: string): string {
  const out = [...s];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== "9") {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
    out[i] = "0";
  }
  return "1" + out.join("");
}

/** Python 的 `slots` dataclass：给不存在的字段赋值抛 AttributeError。
 *
 * 不能让它静默成功 —— 回写到一个没人读的新键上，意味着填表的人以为答案生效了，
 * FDE 看到完成度上升，而模型里什么都没变。这正是 `merge_into_oir` 那条注释里
 * 记录的 455 格黑洞的形状。 */
function setAttr(entity: { rid?: string }, key: string, value: unknown): void {
  if (!(key in entity)) {
    throw new TypeError(
      `AttributeError: ${entity.rid ?? "?"} 没有字段 '${key}' —— 这次回写无处可去`,
    );
  }
  (entity as Record<string, unknown>)[key] = value;
}

function hasAttr(entity: object, key: string): boolean {
  return key in entity;
}

/** `ridFieldKey` 的逆：拆回 `(rid, field)`。分隔符是 NUL（见 template.ts）。 */
function splitKey(key: string): [string, string] {
  const i = key.indexOf("\u0000");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

// ══════════════════════════════════════════════════════════════════
//  数据形态
// ══════════════════════════════════════════════════════════════════

/** 一格的前后对比。 */
export interface CellDiff {
  rid: string;
  sheet: string;
  field: string;
  before: string;
  after: string;
  role: Role;
  owner: string | null;
}

export function makeCellDiff(
  p: Pick<CellDiff, "rid" | "sheet" | "field" | "before" | "after" | "role"> &
    Partial<CellDiff>,
): CellDiff {
  return {
    rid: p.rid,
    sheet: p.sheet,
    field: p.field,
    before: p.before,
    after: p.after,
    role: p.role,
    owner: p.owner ?? null,
  };
}

export function diffChanged(d: CellDiff): boolean {
  return d.before.trim() !== d.after.trim();
}

export function diffFilled(d: CellDiff): boolean {
  return d.after.trim() !== "";
}

/** AI 预填了、业务方原样交回 —— 说明这格他没审。 */
export function diffUntouchedPrefill(d: CellDiff): boolean {
  return d.before.trim() !== "" && !diffChanged(d);
}

/** 一份打回单。按责任人分组 —— 打回给"团队"等于打回给没有人。 */
export interface ReturnSlip {
  owner: string;
  items: Conflict[];
}

export function slipToDict(s: ReturnSlip): Record<string, unknown> {
  const byKind = new Map<string, string[]>();
  for (const c of s.items) {
    const list = byKind.get(c.kind);
    if (list === undefined) byKind.set(c.kind, [c.summary]);
    else list.push(c.summary);
  }
  return { owner: s.owner, count: s.items.length, by_kind: Object.fromEntries(byKind) };
}

export interface AuditResult {
  completeness: number;
  diffs: CellDiff[];
  findings: Conflict[];
  autoRepaired: Record<string, unknown>[];
  slips: ReturnSlip[];
  unmatchedRows: string[];
  newRows: string[];
  /** 回传件结构被破坏的地方。**空列表以外的一切都要拦住流程** ——
   * 一张读不了的表意味着那些人的工作白做了，而他们不知道。 */
  damage: string[];
}

export function auditReadable(r: AuditResult): boolean {
  return r.damage.length === 0;
}

export function auditCounts(r: AuditResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of r.findings) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}

export function auditSummary(r: AuditResult): Record<string, unknown> {
  return {
    completeness: pyRound(r.completeness, 4),
    cells_compared: r.diffs.length,
    cells_changed: r.diffs.filter(diffChanged).length,
    findings: auditCounts(r),
    auto_repaired: r.autoRepaired.length,
    slips: r.slips.map(slipToDict),
    unmatched_rows: r.unmatchedRows,
    new_rows: r.newRows,
    damage: r.damage,
    readable: auditReadable(r),
  };
}

// ══════════════════════════════════════════════════════════════════
//  读回传件
// ══════════════════════════════════════════════════════════════════

/** 一张工作表的原始内容。`grid[r][c]` 是 1-based `(r+1, c+1)` 那一格的字符串
 * 形态（`"" if v is None else str(v)`，**不 strip**，strip 交给读取逻辑）。
 *
 * `maxRow` / `maxColumn` 对应 openpyxl 的同名属性 —— 它们算的是**有格子存在**
 * 的范围（含只有样式的空格），不是"最后一行有值的行"。 */
export interface ReturnedSheet {
  title: string;
  grid: readonly (readonly string[])[];
  maxRow: number;
  maxColumn: number;
}

/** 读回传的表格内容，按 `(rid, 字段)` 索引取值（键见 {@link ridFieldKey}）。
 *
 * 行序、行数、列宽的任何变化都不影响结果 —— 全靠隐藏的 `_oir_rid` 对齐。
 *
 * 结构损伤塞在保留键 `__damage__` 里带出去（Python 侧就是这么设计的），
 * `audit()` 会把它取走。 */
export function readReturnedFromSheets(sheets: readonly ReturnedSheet[]): Map<string, string> {
  const out = new Map<string, string>();
  const damage: string[] = [];

  for (const ws of sheets) {
    // 重复检测必须**按表**做：同一个对象本来就会同时出现在对象清单和术语表里，
    // 跨表去重会把正常结构报成损伤。
    const seenRids = new Set<string>();
    const loc = locateAnchor(ws);
    if (loc === null) {
      // 这张表读不了。以前这里是直接跳过 —— 静默丢掉整张 172 行的表，
      // 不抛异常、不告警，FDE 只能靠自己去数 unmatched_rows 才发现。
      // **读不了必须说出来**：业务方在顶上插一行标题、在最左边插一列做批注，
      // 都是极常见的动作，而它们的代价是一整张表的工作白做。
      if (looksLikeData(ws)) {
        damage.push(
          `「${ws.title}」找不到锚点列 ${ANCHOR_RID} —— 这张表的 ` +
            `${Math.max(0, ws.maxRow - 2)} 行没有被读取。` +
            `通常是因为顶部插了行、最左边插了列，或者隐藏列被删掉了`,
        );
      }
      continue;
    }
    const [hrow, rcol, headers] = loc;
    if (hrow !== 2 || rcol !== 1) {
      // 能读，但结构被动过 —— 也要说，因为下次回传可能就读不了了
      damage.push(
        `「${ws.title}」表头在第 ${hrow} 行、锚点在第 ${rcol} 列` +
          `（原本是第 2 行第 1 列），已按实际位置读取`,
      );
    }

    for (let r = hrow + 1; r <= ws.maxRow; r++) {
      const rid = cellAt(ws, r, rcol);
      if (!rid) continue;
      const key = rid;
      if (seenRids.has(key)) {
        // 复制粘贴出来的重复行会后写覆盖先写，静默替换掉原来的答案
        damage.push(`「${ws.title}」第 ${r} 行的 ${key} 与前面重复，后者已覆盖前者`);
      }
      seenRids.add(key);
      for (const [c, name] of headers) {
        out.set(ridFieldKey(key, name), cellAt(ws, r, c).trim());
      }
    }
  }

  if (damage.length > 0) {
    out.set(ridFieldKey("__damage__", "__damage__"), damage.join("\n"));
  }
  return out;
}

/** 直接读一份回传的 xlsx 字节。
 *
 * 复用 `parse/tabular.ts` 的 `readSheetGrids` —— 它是 TS 侧**唯一**的 xlsx
 * 读取实现，已经用 golden 逐表对齐过 openpyxl。另起一份读法必然分叉，而分叉的
 * 症状是"同一张表在解析链上读得到、在审核链上读不到"。
 *
 * 与 openpyxl 的两处已知差异（都只影响退化输入，正常回传件不受影响）：
 *   · `readSheet` 会把**末尾全空的行**去掉，openpyxl 的 `max_row` 会把只有样式
 *     的空行也算进去 —— 于是 `looksLikeData` 的 `maxRow > 3` 和损伤文案里的
 *     "N 行没有被读取" 在这类表上会比 Python 少几行；
 *   · `readSheet` 会把合并区的值填回每一格，openpyxl 只有左上角有值。 */
export function readReturned(bytes: Uint8Array): Map<string, string> {
  const sheets: ReturnedSheet[] = readSheetGrids(Buffer.from(bytes)).map(({ title, grid }) => ({
    title,
    grid,
    maxRow: grid.length,
    maxColumn: grid.reduce((m, r) => Math.max(m, r.length), 0),
  }));
  return readReturnedFromSheets(sheets);
}

/** `ws.cell(row=r, column=c).value` 的字符串形态（越界给空串，对应 None）。 */
function cellAt(ws: ReturnedSheet, r: number, c: number): string {
  return ws.grid[r - 1]?.[c - 1] ?? "";
}

/** 扫描表头的深度。业务方在顶上加标题、加说明，通常不超过这个行数。 */
const ANCHOR_SCAN_ROWS = 8;
const ANCHOR_SCAN_COLS = 6;

/** 找出表头在第几行、锚点在第几列，以及每个数据列的位置。
 *
 * 以前这三件事全是硬编码（第 2 行、第 1 列、`00_` 前缀）。硬编码的代价不是
 * 读错，是**读不到而且不说** —— 三种最常见的用户动作（顶部插行、左侧插列、
 * 删掉看不懂的隐藏列）各自会让整张表凭空消失。
 *
 * 返回 `null` 表示这张表里没有锚点。 */
function locateAnchor(ws: ReturnedSheet): [number, number, [number, string][]] | null {
  for (let row = 1; row <= Math.min(ANCHOR_SCAN_ROWS, ws.maxRow); row++) {
    for (let col = 1; col <= Math.min(ANCHOR_SCAN_COLS, ws.maxColumn); col++) {
      if (cellAt(ws, row, col).trim() !== ANCHOR_RID) continue;
      const headers: [number, string][] = [];
      for (let c = col; c <= ws.maxColumn; c++) {
        const name = cellAt(ws, row, c).trim();
        // 锚点两列不是数据列；空列名跳过（业务方插的空白列）
        if (name && name !== ANCHOR_RID && name !== ANCHOR_HASH) headers.push([c, name]);
      }
      return [row, col, headers];
    }
  }
  return null;
}

/** 这张表看起来是不是本该有数据的。
 *
 * 用来区分"业务方自己加的说明页"和"锚点被破坏的数据表"—— 前者读不了是正常的，
 * 后者读不了是事故。判据是行列规模，不是表名：以前靠 `00_` 前缀判断，
 * 于是把 `03_关系清单` 改名成 `00_关系清单` 就能让 19 行静默消失。 */
function looksLikeData(ws: ReturnedSheet): boolean {
  return ws.maxRow > 3 && ws.maxColumn >= 3;
}

// ══════════════════════════════════════════════════════════════════
//  审核
// ══════════════════════════════════════════════════════════════════

/** 一格的敷衍信号。
 *
 * **完成度计算和打回单必须走同一个入口** —— 之前两处各自调用、参数还不同，
 * 结果就是修好一处另一处照旧误报。判「太短/整列一个值」需要知道这格是不是
 * 自由文本，而只有编译期的 {@link Cell} 知道。 */
export function cellSignals(d: CellDiff, cell: Cell | undefined, ratio: number): string[] {
  const prose = Boolean(cell && cell.expectsProse);
  return perfunctorySignals({
    value: d.after,
    columnHeader: d.field,
    aiPrefill: d.before,
    expectsDefinition: prose,
    columnDistinctRatio: prose ? ratio : 1.0,
  });
}

/** 各字段的取值离散度。整列一个值是敷衍信号（仅对自由文本成立）。 */
function fieldRatios(diffs: readonly CellDiff[]): Map<string, number> {
  const cols = new Map<string, string[]>();
  for (const d of diffs) {
    const list = cols.get(d.field);
    if (list === undefined) cols.set(d.field, [d.after]);
    else list.push(d.after);
  }
  const out = new Map<string, number>();
  for (const [f, vals] of cols) {
    const nonempty = vals.filter((v) => v !== "");
    // **真除**：单列一格时 1/1 = 1.0，写成整除会把所有单行表判成敷衍。
    out.set(f, nonempty.length > 0 ? new Set(nonempty).size / nonempty.length : 1.0);
  }
  return out;
}

/** 把回传件审成一份可执行的处置清单。 */
export class ReturnAuditor {
  readonly target: number;

  /** @param target 达标线。低于它就打回，不发布。 */
  constructor(p: { target?: number } = {}) {
    this.target = p.target ?? 0.95;
  }

  /** 把结构损伤变成一条要人处理的冲突。
   *
   * 只放进 summary 的一个列表里是不够的 —— 那一行会被淹没在完成度、打回单
   * 之间。它得和别的问题一样进 findings，因为它的后果比任何一条填错都严重：
   * **一整张表的人白填了，而他们收不到任何提示。** */
  private damageFindings(damage: readonly string[]): Conflict[] {
    if (damage.length === 0) return [];
    return [
      makeConflict(
        "cf_return_damaged",
        ConflictKind.PERFUNCTORY, // 复用"这份回传不可信"这一档
        [],
        "回传件结构被改动，有内容没能读回来：\n" + damage.slice(0, 6).join("\n"),
        { evidence: [], detector: "rule:return_structure", options: [] },
      ),
    ];
  }

  audit(
    spec: TemplateSpec,
    returned: Map<string, string>,
    opts: { oir?: OIR | null } = {},
  ): AuditResult {
    const oir = opts.oir ?? null;
    const expected = spec.byRid();
    // 损伤信息由 readReturned 塞在一个保留 key 里。取出来之后必须从
    // returned 里拿掉，否则它会被当成一个 rid 进 newRows。
    // （**会改调用方传进来的 Map**，和 Python 的 dict.pop 一样。）
    const damageKey = ridFieldKey("__damage__", "__damage__");
    const damage = returned.get(damageKey) ?? "";
    returned.delete(damageKey);

    const diffs: CellDiff[] = [];
    for (const [key, cell] of expected) {
      diffs.push(
        makeCellDiff({
          rid: cell.rid,
          sheet: cell.sheet,
          field: cell.field,
          before: cell.value,
          after: returned.get(key) ?? "",
          role: cell.role,
          owner: cell.owner,
        }),
      );
    }

    const unmatched = new Set<string>();
    for (const [k, c] of expected) if (!returned.has(k)) unmatched.add(c.rid);
    const expectedRids = new Set([...expected.values()].map((c) => c.rid));
    const newRids = new Set<string>();
    for (const k of returned.keys()) {
      const rid = splitKey(k)[0];
      if (!expectedRids.has(rid)) newRids.add(rid);
    }

    const result: AuditResult = {
      completeness: 0.0,
      diffs,
      findings: [],
      autoRepaired: [],
      slips: [],
      unmatchedRows: sortedCp(unmatched),
      newRows: sortedCp(newRids),
      damage: damage.split("\n").filter((x) => x !== ""),
    };

    result.findings = [
      ...this.damageFindings(result.damage),
      ...missingFindings(diffs),
      ...enumViolations(diffs, expected),
      ...namingFindings(diffs),
      ...this.perfunctoryFindings(diffs, expected),
      ...divergenceFindings(diffs),
    ];
    result.autoRepaired = autoRepair(result.findings, oir);
    const repaired = new Set(result.autoRepaired.map((r) => String(r["conflict"])));
    result.findings = result.findings.filter((c) => !repaired.has(c.rid));
    result.completeness = this.completeness(diffs, expected);
    result.slips = slipsOf(result.findings);
    return result;
  }

  /** 加权完成度。
   *
   * 只统计**业务必填**的格子 —— 系统自己填好的部分算进去会把数字虚高，
   * 而这个数字是 FDE 决定要不要再发一轮的依据。原样交回的预填不算「已填」，
   * 命中敷衍信号的也不算。 */
  completeness(diffs: readonly CellDiff[], expected?: Map<string, Cell>): number {
    const target = diffs.filter((d) => d.role === Role.REQUIRED);
    if (target.length === 0) return 1.0;
    const exp = expected ?? new Map<string, Cell>();
    const ratios = fieldRatios(diffs);
    let total = 0;
    for (const d of target) total += WEIGHTS[d.field] ?? 1.0;
    let got = 0;
    for (const d of target) {
      if (!diffFilled(d) || diffUntouchedPrefill(d)) continue;
      const sig = cellSignals(d, exp.get(ridFieldKey(d.rid, d.field)), ratios.get(d.field) ?? 1.0);
      if (sig.length > 0) continue;
      got += WEIGHTS[d.field] ?? 1.0;
    }
    return total !== 0 ? got / total : 1.0;
  }

  /** 启发式收窄候选。命中信号的才进 LLM 终判队列，没命中的连模型都不用调。 */
  private perfunctoryFindings(
    diffs: readonly CellDiff[],
    expected: Map<string, Cell>,
  ): Conflict[] {
    const out: Conflict[] = [];
    const ratios = fieldRatios(diffs);
    for (const d of diffs) {
      if (d.role !== Role.REQUIRED || !diffFilled(d)) continue;
      const sig = cellSignals(
        d,
        expected.get(ridFieldKey(d.rid, d.field)),
        ratios.get(d.field) ?? 1.0,
      );
      if (sig.length === 0) continue;
      out.push(
        makeConflict(
          cid(ConflictKind.PERFUNCTORY, d.rid, d.field),
          ConflictKind.PERFUNCTORY,
          [d.rid],
          `${d.sheet} · ${d.field} 疑似敷衍（${sig.join("、")}）` +
            (sig.includes("UNCHANGED_PREFILL")
              ? "：AI 预填值被原样交回，这格没有被真正审过"
              : ""),
          { owner: d.owner, detector: "heuristic:PERF-01" },
        ),
      );
    }
    return out;
  }
}

// ── 规则审核 ────────────────────────────────────────────────────

function missingFindings(diffs: readonly CellDiff[]): Conflict[] {
  const out: Conflict[] = [];
  for (const d of diffs) {
    if (d.role !== Role.REQUIRED || diffFilled(d)) continue;
    out.push(
      makeConflict(
        cid(ConflictKind.MISSING_REQUIRED, d.rid, d.field),
        ConflictKind.MISSING_REQUIRED,
        [d.rid],
        `${d.sheet} · ${d.field} 未填`,
        { owner: d.owner, detector: "rule:REQ-01" },
      ),
    );
  }
  return out;
}

function enumViolations(diffs: readonly CellDiff[], expected: Map<string, Cell>): Conflict[] {
  const out: Conflict[] = [];
  for (const d of diffs) {
    const cell = expected.get(ridFieldKey(d.rid, d.field));
    // `not cell.options`：Python 里空列表是假 —— 写成 `cell.options === null`
    // 会让「选项列表为空」的格子走进枚举校验，然后每一格都判越界。
    if (cell === undefined || cell.options === null || cell.options.length === 0) continue;
    if (!diffFilled(d)) continue;
    if (!cell.options.includes(d.after)) {
      out.push(
        makeConflict(
          cid(ConflictKind.TYPE_MISMATCH, d.rid, d.field),
          ConflictKind.TYPE_MISMATCH,
          [d.rid],
          `${d.sheet} · ${d.field} 取值「${d.after}」不在允许集合 ` + cell.options.join("、"),
          { owner: d.owner, detector: "rule:ENUM-01" },
        ),
      );
    }
  }
  return out;
}

function namingFindings(diffs: readonly CellDiff[]): Conflict[] {
  const out: Conflict[] = [];
  for (const d of diffs) {
    // 只审业务方改过的；没动过的在编译期已经合规
    if (d.field !== "apiName" || !diffFilled(d) || !diffChanged(d)) continue;
    if (HAS_CJK.test(d.after) || !CAMEL_RE.test(d.after)) {
      out.push(
        makeConflict(
          cid(ConflictKind.NAMING_VIOLATION, d.rid, d.field),
          ConflictKind.NAMING_VIOLATION,
          [d.rid],
          `${d.sheet} · apiName「${d.after}」不符合 lowerCamelCase`,
          {
            owner: d.owner,
            detector: "rule:NAME-01",
            options: [
              makeOption("apply", `改为 ${toCamel(d.after)}`, "可逆、零语义损失", {
                effect: { set_api_name: toCamel(d.after) },
              }),
            ],
          },
        ),
      );
    }
  }
  return out;
}

/** 回传后新产生的口径矛盾 —— 两个人各填各的，轴上冲突。 */
function divergenceFindings(diffs: readonly CellDiff[]): Conflict[] {
  const byField = new Map<string, CellDiff[]>();
  for (const d of diffs) {
    if (d.field !== "definition" || !diffFilled(d)) continue;
    // `rid.rsplit("_", 1)[0]`：按**最后一个**下划线切，前半段是同族
    const i = d.rid.lastIndexOf("_");
    const group = i < 0 ? d.rid : d.rid.slice(0, i);
    const list = byField.get(group);
    if (list === undefined) byField.set(group, [d]);
    else list.push(d);
  }

  const out: Conflict[] = [];
  for (const group of byField.values()) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i]!;
      for (const b of group.slice(i + 1)) {
        const diff = axisDiff(a.after, b.after);
        if (diff.size === 0) continue;
        const axes = [...diff]
          .map(([k, [va, vb]]) => `${k}（${va} vs ${vb}）`)
          .join("、");
        const owners = sortedCp(new Set([a.owner, b.owner].filter((o): o is string => Boolean(o))));
        out.push(
          makeConflict(
            cid(ConflictKind.SEMANTIC_DIVERGENCE, a.rid, b.rid, "returned"),
            ConflictKind.SEMANTIC_DIVERGENCE,
            [a.rid, b.rid],
            `回传后仍存在口径矛盾：${axes}` +
              (owners.length > 1 ? `，需 ${owners.join("、")} 对齐` : ""),
            { owner: owners.length > 0 ? owners[0]! : null, detector: "rule:AXIS-01" },
          ),
        );
      }
    }
  }
  return out;
}

// ── 自动修 ──────────────────────────────────────────────────────

/** 只修可逆、零语义损失、可完整记账的。命名满足；口径统一不满足。 */
function autoRepair(findings: readonly Conflict[], oir: OIR | null): Record<string, unknown>[] {
  const log: Record<string, unknown>[] = [];
  for (const c of findings) {
    if (handlingOf(c) !== Handling.AUTO_REPAIR || c.options.length === 0) continue;
    const newName = c.options[0]!.effect["set_api_name"];
    if (!newName) continue;
    const entry: Record<string, unknown> = {
      conflict: c.rid,
      rid: c.subjects[0],
      field: "apiName",
      to: newName,
      reversible: true,
    };
    if (oir !== null) {
      const subject = c.subjects[0]!;
      // 四个容器都看，**不 break** —— 与 Python 一致：同一个 rid 若同时落在
      // 两个容器里，两边都改，`from` 记的是最后一个。
      for (const bucket of [oir.objects, oir.properties, oir.links, oir.actions] as const) {
        const e = bucket.get(subject);
        if (e === undefined) continue;
        entry["from"] = e.apiName.value;
        e.apiName.value = String(newName);
        e.apiName.origin = Origin.AUTO_REPAIRED;
      }
    }
    log.push(entry);
  }
  return log;
}

// ── 打回单 ──────────────────────────────────────────────────────

function slipsOf(findings: readonly Conflict[]): ReturnSlip[] {
  const grouped = new Map<string, ReturnSlip>();
  for (const c of findings) {
    const h = handlingOf(c);
    if (h !== Handling.ROUND_TRIP && h !== Handling.ASK_USER) continue;
    const owner = c.owner ?? "未分派";
    let slip = grouped.get(owner);
    if (slip === undefined) {
      slip = { owner, items: [] };
      grouped.set(owner, slip);
    }
    slip.items.push(c);
  }
  // Python 的 sorted 是稳定的：条数相同的责任人保持首次出现的先后。
  return [...grouped.values()].sort((a, b) => b.items.length - a.items.length);
}

// ══════════════════════════════════════════════════════════════════
//  回写
// ══════════════════════════════════════════════════════════════════

type MergeTarget = ObjectType | PropertyType | LinkType | ActionType | BusinessRule | OpenQuestion;

/** 把业务方真正填的内容写回 OIR，标 `Origin.USER`。
 *
 * 返回 `[写回了什么, 读到了却没地方放的]`。
 *
 * 第二个返回值是新加的，因为它对应一个实测过的黑洞：**627 格被判为真正填写，
 * 最后只有 172 条落回 OIR**。primaryKey / owner / effects 共 455 格被读进来、
 * 被算进完成度、然后在这个分派的兜底分支里静默丢弃 —— 填表的人以为答案生效了，
 * FDE 看到完成度上升，而模型里什么都没变。
 *
 * 丢弃有时是对的（有些列本来就只是给人核对的），但**丢了必须说**。
 *
 * **原样交回的预填不算填写** —— 那格没有被人认领过，不该获得 USER 的可信度。 */
export function mergeIntoOir(oir: OIR, diffs: readonly CellDiff[]): [string[], string[]] {
  const changed: string[] = [];
  const dropped: string[] = [];
  for (const d of diffs) {
    if (!diffFilled(d) || diffUntouchedPrefill(d)) continue;
    const entity: MergeTarget | undefined =
      oir.properties.get(d.rid) ??
      oir.objects.get(d.rid) ??
      oir.links.get(d.rid) ??
      oir.actions.get(d.rid) ??
      // 规则和问题以前不在这个链上 —— 即使模板里有了它们的 sheet，
      // 回写这一步也接不住。
      oir.rules.get(d.rid) ??
      oir.questions.get(d.rid);
    if (entity === undefined) {
      dropped.push(`${d.rid}.${d.field}（找不到这个条目）`);
      continue;
    }
    const note = `业务方回传（${d.owner ?? "未分派"}）`;
    const ent = entity as unknown as Record<string, unknown>;
    switch (true) {
      case d.field === "definition" && hasAttr(entity, "definition"):
        ent["definition"] = byUser(d.after, note);
        break;
      case d.field === "description" && hasAttr(entity, "description"):
        ent["description"] = byUser(d.after, note);
        break;
      case d.field === "displayName":
        setAttr(entity, "displayName", byUser(d.after, note));
        break;
      case d.field === "cardinality" && hasAttr(entity, "cardinality"):
        ent["cardinality"] = byUser(d.after, note);
        break;
      case d.field === "owner":
        setAttr(entity, "owner", d.after);
        break;
      case d.field === "primaryKey" && hasAttr(entity, "primaryKey"):
        ent["primaryKey"] = byUser(splitList(d.after), note);
        break;
      case d.field === "effects" && hasAttr(entity, "effects"):
        ent["effects"] = byUser(splitList(d.after), note);
        break;
      // ── 新表的回写 ──────────────────────────────────────
      case d.field === "答复" && hasAttr(entity, "answer"):
        // 答了就不再是待办。**这是整轮往返里最有价值的一次写入** ——
        // 一个待澄清问题变成了一条事实。
        ent["answer"] = byUser(d.after, note);
        ent["status"] = Status.CONFIRMED;
        break;
      case d.field === "执行角色" && hasAttr(entity, "actor"):
        ent["actor"] = byUser(d.after, note);
        break;
      case d.field === "这条对吗" && hasAttr(entity, "statement"):
        ent["status"] =
          d.after.trim() === "对"
            ? Status.CONFIRMED
            : d.after.trim() === "不对"
              ? Status.REJECTED
              : Status.PROPOSED;
        break;
      case d.field === "管哪个单据": {
        const byName = new Map<string, string>();
        for (const [rid, o] of oir.objects) byName.set(o.displayName.value, rid);
        const hosts: string[] = [];
        for (const x of d.after.replace(/，/gu, "、").split("、")) {
          const t = x.trim();
          const hit = byName.get(t);
          if (hit !== undefined) hosts.push(hit);
        }
        if (hosts.length === 0) {
          dropped.push(`${d.rid}.${d.field}（「${head(d.after, 20)}」对不上任何对象）`);
          continue;
        }
        setAttr(entity, "appliesTo", hosts);
        break;
      }
      default:
        dropped.push(`${d.rid}.${d.field}（没有回写路径）`);
        continue;
    }
    changed.push(`${d.rid}.${d.field}`);
  }
  return [changed, dropped];
}

/** `[x.strip() for x in s.replace("，", "、").split("、") if x.strip()]` */
function splitList(s: string): string[] {
  return s
    .replace(/，/gu, "、")
    .split("、")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}
