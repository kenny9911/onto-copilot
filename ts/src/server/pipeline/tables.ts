/**
 * 表格渲染工具组 —— `server.py` 2728–3036。
 *
 * 这一组直接决定用户在聊天里看到的卡片和他下载到的 xlsx，**形状不能变**。
 * 屏幕和导出共用同一份实现是刻意的：各写一份的话，AI 列出来的表和导出的文件
 * 迟早会不一样列、不一样条数，而用户会拿导出的那份去跟客户对话 —— 那时候
 * 没人知道哪份是对的。
 *
 * ── 与 Python 的两处**接口**分叉（行为不变，签名变了）────────────
 *
 * 1. **`sheetRows` / `materialTable` / `fullRowsFor` 是 async。** Python 的
 *    `ParserRegistry.parse` 是同步的（`path.read_bytes()`）；TS 侧 `parse` 返回
 *    Promise（Node 的文件 IO 与 zip 解压都是异步的），异步会一路传染上来。
 *    不为了「签名一致」而用同步 IO —— 那会阻塞唯一的事件循环线程，一份 50MB 的
 *    xlsx 能把整个服务卡死几秒。
 *
 * 2. **行记录用 `Record<string, unknown>`。** Python dict 保插入序；V8 的普通
 *    对象对**整数样式的键**（"2024"）会提到最前面。列名是纯数字的表（年份列）
 *    因此列序会与 Python 不同。之所以不换 `Map`：行记录的另一个来源是解析器的
 *    `Chunk.raw`（已经是普通对象），换 Map 要连解析器一起改，那是别人的 track。
 *    影响面被 `materialTable` 限住 —— 它的列序来自 `cols` 而不是键序，只有
 *    「第一次收集列名」那一步会受影响。
 */

import { pyRepr } from "../../kernel/errors.js";
import { pyJsonDumps } from "../../kernel/journal.js";
import { cpLen, cpSlice, readTextGuess } from "../../onto/parse/base.js";
import type { ParserRegistry } from "../../onto/parse/base.js";
import {
  csvReader,
  dedupeHeaders,
  detectHeaderRow,
  pySplitlines,
  pyStrip,
  sniffDelimiter,
} from "../../onto/parse/tabular.js";
import { eventRowAsSse } from "../../store/types.js";
import type { Repo } from "../../store/repo/protocol.js";
import type { SessionEvent } from "../../session_events.js";
import type { DialogueLike, MarkdownBlockLike, MaterialFile, SessionLike } from "./types.js";

import { basename, extname, join } from "node:path";

// ══════════════════════════════════════════════════════════════════
//  Python 原语
// ══════════════════════════════════════════════════════════════════

/**
 * `str(x)` —— 只覆盖 JSON 能装下的那几种。
 *
 * 数字那一条是已知分叉（与 ids.ts 同族）：JSON 往返后 JS 分不出 `1` 与 `1.0`，
 * 所以 Python 的 `str(1.0) == "1.0"` 在这里是 `"1"`。真正会走到这条路的是
 * 表格单元格里的数值，两种写法在界面上都读得通，不值得为它引一层装箱。
 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return v === null ? "None" : "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNum(v);
  // **容器走 repr，不走 JSON。** `str(["a"])` 是 `['a']`（单引号），不是 `["a"]`。
  // 会走到这里的是一个把列表塞进了单元格的脏 OIR —— 印出来的形状要和 Python 一样，
  // 否则"同一份产物在两边导出不一样"这种事只有逐字符比对才看得出来。
  return pyReprAny(v);
}

function pyNum(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  return String(v);
}

/** `repr(x)` —— 只覆盖 JSON 装得下的那几种。 */
function pyReprAny(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return pyRepr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNum(v);
  if (Array.isArray(v)) return `[${v.map(pyReprAny).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${pyRepr(k)}: ${pyReprAny(val)}`)
      .join(", ")}}`;
  }
  return String(v);
}

/** Python 的真值判定：`0` / `""` / `[]` / `{}` / `None` / `False` 全是假。 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** `repr(list_of_str)` —— `['a', 'b']`。错误消息里 `{[...]}` 插值出来就是这个。 */
export function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * `urllib.parse.unquote(s)` —— 默认 `encoding="utf-8", errors="replace"`。
 *
 * **不能**用 `decodeURIComponent`：它对残缺的 `%` 序列直接抛 URIError，而
 * Python 是把解不开的那几个字符原样留下。模型很爱把中文文件名百分号编码了再传，
 * 半个编码（截断）真的会出现 —— 抛异常的话整条 `_match_file` 就废了。
 */
export function pyUnquote(s: string): string {
  if (!s.includes("%")) return s;
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  let i = 0;
  while (i < s.length) {
    if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    // 非 ASCII 字符本身也要按 UTF-8 进字节流，否则与后面的 %XX 拼不成一个码点
    for (const b of utf8.encode(s[i]!)) bytes.push(b);
    i += 1;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes));
}

/** `round(x, 3)`。**已知分叉**：Python 是 half-to-even，这里 `toFixed` 在恰好
 *  落在半位时是 half-away-from-zero。只用作去重键的一部分，而 ts 是 epoch 浮点，
 *  第 4 位小数恰好是 5 且后面全 0 的概率可以忽略。 */
function round3(x: number): number {
  return Number(x.toFixed(3));
}

/** `float(x or 0)`。 */
function pyFloat(v: unknown): number {
  if (!pyTruthy(v)) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// ══════════════════════════════════════════════════════════════════
//  产物 → 给业务方看的表
// ══════════════════════════════════════════════════════════════════

/**
 * 产物 → 给业务方看的表：每类挑**看得懂**的列，不是把内部结构原样倒出来。
 *
 * 放在模块级而不是渲染函数里面，是因为**导出必须和屏幕上看到的是同一张表**。
 */
export const OIR_LABEL: Readonly<Record<string, string>> = {
  objects: "业务对象",
  properties: "属性",
  links: "关系",
  actions: "动作",
  rules: "业务规则",
  questions: "待澄清问题",
};

/** `{"value": …}` 包装 → 里面那个值；不是 dict 就 `str(x or "")`。 */
export function oirVal(x: unknown): string {
  if (isPlainDict(x)) {
    const v = x["value"];
    return pyStr(v === undefined ? "" : v);
  }
  return pyStr(pyTruthy(x) ? x : "");
}

/**
 * `x.get(key, "")` —— 不过 `_oir_val` 那层拆包。
 *
 * **一处刻意的分叉**：Python 这几列没套 `str()`，键值是 `None` 时格子里就是
 * `None`（JSON 里的 `null`）。这里返回 `""`。理由是 `oir.to_dict()` 对
 * status/parent/from/to/code 这五个键从不产出 null，真走到这条路只可能是脏数据 ——
 * 而那时候界面上印一个 "None" 比印空格更糟（用户会以为那是个真值）。
 */
function plain(x: Record<string, unknown>, key: string): string {
  const v = x[key];
  return v === undefined || v === null ? "" : pyStr(v);
}

/** `r.get(key, "")` —— 键存在但值是 `None` 时返回 `None`（**不是** `""`）。
 *  这个区分在 `_material_table` 的"整列都是空的"判定里是实打实的：
 *  `str(None).strip()` 是 `"None"`，非空，所以一整列 None 在 Python 里算**有内容**。 */
function pyGet(r: RowRecord, key: string): unknown {
  return key in r ? r[key] : "";
}

type ColSpec = readonly [string, (x: Record<string, unknown>) => string];

export const OIR_COLS: Readonly<Record<string, readonly ColSpec[]>> = {
  objects: [
    ["名称", (o) => oirVal(o["displayName"])],
    ["API 名", (o) => oirVal(o["apiName"])],
    ["说明", (o) => cpSlice(oirVal(o["description"]), 0, 120)],
    ["状态", (o) => plain(o, "status")],
  ],
  properties: [
    ["所属对象", (p) => plain(p, "parent")],
    ["字段", (p) => oirVal(p["displayName"])],
    ["API 名", (p) => oirVal(p["apiName"])],
    ["类型", (p) => oirVal(p["baseType"])],
    ["口径", (p) => cpSlice(oirVal(p["definition"]), 0, 100)],
  ],
  links: [
    ["从", (l) => plain(l, "from")],
    ["到", (l) => plain(l, "to")],
    ["名称", (l) => oirVal(l["apiName"])],
    ["基数", (l) => oirVal(l["cardinality"])],
  ],
  actions: [
    ["动作", (a) => oirVal(a["apiName"])],
    ["作用对象", (a) => ((a["appliesTo"] as unknown[] | undefined) ?? []).map(pyStr).join("、")],
  ],
  rules: [
    ["规则", (r) => oirVal(r["statement"])],
    ["类别", (r) => oirVal(r["ruleKind"])],
    ["角色", (r) => oirVal(r["actor"])],
  ],
  questions: [
    ["问题", (q) => oirVal(q["text"])],
    ["答复", (q) => oirVal(q["answer"])],
    ["编号", (q) => plain(q, "code")],
  ],
};

/** 产物里的一类东西 → (中文类名, 表头, 行)。 */
export function oirTable(
  oir: Record<string, unknown> | null | undefined,
  kind: string,
  contains = "",
): readonly [string, string[], string[][]] {
  const cols = OIR_COLS[kind];
  // Python 是 `_OIR_COLS[kind]` 的 KeyError。调用方（`_export_doc`）先做过
  // `source in _OIR_COLS`，走到这里的未知 kind 是编程错误，照样 fail-fast。
  if (cols === undefined) throw new Error(`KeyError: ${pyRepr(kind)}`);
  let items = [...(((oir ?? {})[kind] as unknown[] | undefined) ?? [])];
  if (contains) {
    const k = contains.toLowerCase();
    items = items.filter((x) => pyJsonDumps(x).toLowerCase().includes(k));
  }
  return [
    OIR_LABEL[kind] ?? "",
    cols.map(([name]) => name),
    items.map((x) => cols.map(([, fn]) => fn(isPlainDict(x) ? x : {}))),
  ];
}

// ══════════════════════════════════════════════════════════════════
//  材料里的表
// ══════════════════════════════════════════════════════════════════

/** 材料里读不出行时抛出，消息就是给模型看的回执。 */
export class NoRows extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRows";
    Object.setPrototypeOf(this, NoRows.prototype);
  }
}

export class MultiSheet extends Error {
  readonly sheets: Record<string, number>;

  constructor(sheets: Record<string, number>) {
    super("multiple sheets");
    this.sheets = sheets;
    this.name = "MultiSheet";
    Object.setPrototypeOf(this, MultiSheet.prototype);
  }
}

/** `server.py:1666` 的 `_TABULAR_EXT`。**段 A 也有一份** —— 落地后从那边 import，
 *  这里留着只是为了本段能独立编译；两份不一致的症状是「同一个 csv 在两个工具里
 *  一个认一个不认」。 */
export const TABULAR_EXT: readonly string[] = [".xlsx", ".xlsm", ".xltx", ".csv", ".tsv"];

export type RowRecord = Record<string, unknown>;

/** Python `Path.stem`。 */
function stemOf(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

/**
 * 表格文件 → {表名: [ {列名: 值} ]}。**全量，不截断。**
 *
 * xlsx 走解析器的 row 切片（一行一片、`raw` 就是列名→值）。csv/tsv **不能**走
 * 这条路：`CsvParser` 压根不产 `row` 切片 —— 它只出一片 schema 加最多 20 片
 * `sample`，于是按 tag 过滤会把 csv 的每一行都丢掉，工具对任何 csv 都回
 * "没读出数据行"，而工具描述和后缀白名单都写着支持 csv。这里对 csv 自己读一遍。
 */
export async function sheetRows(
  path: string,
  registry: ParserRegistry,
): Promise<Record<string, RowRecord[]>> {
  const suffix = extname(path).toLowerCase();
  if (suffix === ".csv" || suffix === ".tsv") {
    const [text] = await readTextGuess(path);
    let delim: string;
    if (suffix === ".tsv") delim = "\t";
    else {
      try {
        delim = sniffDelimiter(cpSlice(text, 0, 4096), ",;\t|");
      } catch {
        delim = ",";
      }
    }
    let grid = csvReader(pySplitlines(text), delim).map((r) => r.map((c) => pyStrip(c || "")));
    grid = grid.filter((r) => r.some((c) => c !== ""));
    if (grid.length === 0) return {};
    const h = detectHeaderRow(grid);
    const width = Math.max(...grid.map((r) => r.length));
    const header =
      h >= 0
        ? dedupeHeaders(grid[h]!)
        : Array.from({ length: width }, (_, i) => `col${i + 1}`);
    // h === -1 时 Python 的 `grid[h+1:]` 就是 `grid[0:]` —— 整份都是正文
    const body = grid.slice(h + 1);
    const rows: RowRecord[] = [];
    for (const r of body) {
      if (!r.some((c) => c !== "")) continue;
      const rec: RowRecord = {};
      for (let i = 0; i < Math.min(header.length, r.length); i++) rec[header[i]!] = r[i]!;
      rows.push(rec);
    }
    return { [stemOf(path)]: rows };
  }

  const doc = await registry.parse(path);
  const out: Record<string, RowRecord[]> = {};
  for (const c of doc.chunks) {
    if (!(c.tags ?? []).includes("row")) continue;
    // `(c.locator or {}).get("sheet") or path.stem` —— sheet 是空串/缺席都退到 stem
    const sheet = (c.locator as Record<string, unknown> | null)?.["sheet"];
    const key = pyTruthy(sheet) ? pyStr(sheet) : stemOf(path);
    (out[key] ??= []).push(isPlainDict(c.raw) ? c.raw : {});
  }
  return out;
}

/**
 * 材料里的一张表 → (文件名, 表名, 列, **全部**行, 附注)。
 *
 * `material.rows` 和导出共用这一个 —— 各读各的，迟早会一个 500 行一个 900 行，
 * 而用户会拿导出的那份去跟客户对话。附注里带 blank/missing 列信息给回执用。
 */
export async function materialTable(
  s: SessionLike,
  registry: ParserRegistry,
  file: string,
  sheet = "",
  contains = "",
  columns: readonly string[] | null = null,
): Promise<readonly [string, string, string[], string[][], Record<string, unknown>]> {
  const f = matchFile(s, file);
  if (!f) {
    throw new NoRows(`没有材料「${file}」。现有：${pyReprList(s.files.map((x) => x.name))}`);
  }
  const path = pyTruthy(f["path"]) ? pyStr(f["path"]) : join(s.dir, "materials", f.name);
  const suffix = extname(path).toLowerCase();
  if (!TABULAR_EXT.includes(suffix)) {
    throw new NoRows(
      `「${f.name}」不是表格（${suffix || "无后缀"}），没有「行」可列。正文内容用 evidence.search。`,
    );
  }
  let bySheet: Record<string, RowRecord[]>;
  try {
    bySheet = await sheetRows(path, registry);
  } catch (exc) {
    const name = exc instanceof Error ? exc.name : typeof exc;
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new NoRows(`读不了「${f.name}」：${name}: ${msg}`);
  }
  const names = Object.keys(bySheet);
  if (names.length === 0) throw new NoRows(`「${f.name}」里没读出数据行。`);

  let pick =
    sheet !== "" && sheet in bySheet
      ? sheet
      : (names.find((n) => sheet !== "" && n.includes(sheet)) ?? "");
  if (pick === "") {
    if (sheet) throw new NoRows(`没有工作表「${sheet}」。现有：${pyReprList(names)}`);
    if (names.length > 1) {
      throw new MultiSheet(Object.fromEntries(names.map((n) => [n, bySheet[n]!.length])));
    }
    pick = names[0]!;
  }

  let data = bySheet[pick]!;
  // `list({k: None for r in data for k in r})` —— 保插入序去重
  let cols: string[] = [];
  const seenCol = new Set<string>();
  for (const r of data) {
    for (const k of Object.keys(r)) {
      if (seenCol.has(k)) continue;
      seenCol.add(k);
      cols.push(k);
    }
  }
  const note: Record<string, unknown> = {};
  if (columns && columns.length > 0) {
    const want = cols.filter((c) => columns.includes(c));
    if (want.length === 0) {
      throw new NoRows(`这些列都不存在：${pyReprList([...columns])}。现有列：${pyReprList(cols)}`);
    }
    const missing = columns.filter((c) => !cols.includes(c));
    if (missing.length > 0) note["没有这几列"] = missing;
    cols = want;
  }
  if (contains) {
    const k = contains.toLowerCase();
    data = data.filter((r) =>
      Object.values(r)
        .map(pyStr)
        .join(" ")
        .toLowerCase()
        .includes(k),
    );
  }
  const live = cols.filter((c) => data.some((r) => pyStrip(pyStr(pyGet(r, c))) !== ""));
  if (cols.length - live.length) {
    note["隐藏的空列"] = `${cols.length - live.length} 个整列都是空的，没列出来`;
  }
  cols = live.length > 0 ? live : cols;
  return [
    f.name,
    pick,
    cols,
    // `str(r.get(c, "") or "")` —— `or ""` 把 0/False/None 都吃成空格
    data.map((r) => cols.map((c) => (pyTruthy(pyGet(r, c)) ? pyStr(pyGet(r, c)) : ""))),
    note,
  ];
}

/**
 * 按事件里记的**来源配方**重新算一遍全量行。
 *
 * 事件里的 `rows` 是**给屏幕看的**，封了顶。文件没有这个限制 —— 导出继承屏幕的
 * 截断，就会出现一个叫「问题清单（900 行）.xlsx」、里面只有 500 行的文件，
 * 而 FDE 会把它当完整清单发给客户。所以导出按配方重算，不读 rows。
 */
export async function fullRowsFor(
  s: SessionLike,
  registry: ParserRegistry,
  ev: Record<string, unknown>,
): Promise<string[][] | null> {
  const src = isPlainDict(ev["src"]) ? ev["src"] : {};
  try {
    if (src["kind"] === "oir") {
      // Python 是 `src["oir_kind"]` —— 缺键 KeyError，被下面的 except 收成 None
      if (!("oir_kind" in src)) throw new Error("KeyError: 'oir_kind'");
      const [, , rows] = oirTable(
        (s.state["oir"] as Record<string, unknown> | undefined) ?? {},
        pyStr(src["oir_kind"]),
        pyStr(src["contains"] ?? ""),
      );
      return rows;
    }
    if (src["kind"] === "material") {
      if (!("file" in src)) throw new Error("KeyError: 'file'");
      const cols = src["columns"];
      const [, , , rows] = await materialTable(
        s,
        registry,
        pyStr(src["file"]),
        pyStr(src["sheet"] ?? ""),
        pyStr(src["contains"] ?? ""),
        pyTruthy(cols) ? (cols as string[]) : null,
      );
      return rows;
    }
  } catch {
    return null; // 重算不出来就退回事件里那份，并在 note 里说清
  }
  return null;
}

/** 上一次用 `ui.table` 卡片列出来的表。 */
export function lastCardTable(s: SessionLike): SessionEvent | null {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const ev = s.events[i]!;
    if (ev["kind"] === "ui.table") return ev;
  }
  // 事件流是进程内的，兜一层：`_cards` 是跨重启保留的那几条内容事件
  const cards = (s.state["_cards"] as SessionEvent[] | undefined) ?? [];
  for (let i = cards.length - 1; i >= 0; i--) {
    const ev = cards[i]!;
    if (ev["kind"] === "ui.table") return ev;
  }
  return null;
}

/**
 * 按名字找一份材料。全等 → 解码后全等 → 子串。
 *
 * 模型很爱把中文文件名**百分号编码**了再传（把它当 URL 片段）。同一个名字在
 * material.parse 里靠子串蒙混过去、在 evidence.search 里却直接"没有这些材料"，
 * 模型就会以为文件没读进来，转头去猜答案。名字在哪个工具里都得是同一个意思。
 */
export function matchFile(s: SessionLike, raw: string): MaterialFile | null {
  const cand = [raw];
  if (raw.includes("%")) {
    const dec = pyUnquote(raw);
    if (dec !== raw) cand.push(dec);
  }
  for (const x of cand) {
    const hit = s.files.find((f) => f.name === x);
    if (hit) return hit;
  }
  for (const x of cand) {
    const hit = s.files.find((f) => x !== "" && f.name.includes(x));
    if (hit) return hit;
  }
  return null;
}

/**
 * 一条回答正文里的所有表格（markdown 竖线表），各自带上它的标题。
 *
 * 模型经常不调 `ui.table`，而是直接把表写进回答里 —— 访谈提纲这类一次性的
 * 东西本来就不是"产物清单"。标题取表格前面最近的那个小标题或加粗行：模型写
 * 「**AI 招聘业务流程梳理及访谈提问框架**」这种很常见，而用户回头正是**用这个
 * 名字**来指它的。
 */
export function tablesInText(
  text: string,
  ts: number,
  blocksFromMarkdown: (t: string) => readonly MarkdownBlockLike[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const blocks = blocksFromMarkdown(text || "");
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind !== "table" || !b.rows || b.rows.length === 0) continue;
    let title = "";
    for (let j = i - 1; j >= 0; j--) {
      const prev = blocks[j]!;
      const cand = pyStrip(prev.text ?? "");
      const n = cpLen(cand);
      if ((prev.kind === "heading" || prev.kind === "para") && n > 0 && n <= 60) {
        title = cand;
        break;
      }
    }
    out.push({
      kind: "ui.table",
      ts: pyFloat(ts),
      title: title || "清单",
      columns: [...(b.columns ?? [])],
      rows: b.rows.map((r) => [...r]),
      total: b.rows.length,
    });
  }
  return out;
}

/**
 * 这个会话里出现过的**全部**表格，按时间从早到晚。
 *
 * 两个来源都要，缺一不可：
 *
 * · **耐久事件表**（`chat.turn`）—— 这是完整历史。DialogueMemory 会压缩：
 *   超预算时最老的几轮被合并成一句摘要，原文就没了。用户过两轮回头说"把刚才
 *   那张 AI 招聘表导出来"时，那条回答很可能已经被压掉 —— 只看 DialogueMemory
 *   就会翻出**另一张**表给他，这正是他下载到的东西不对的原因。
 * · **当前 DialogueMemory** —— 兜住耐久事件还没落库、以及历史遗留会话。
 *
 * 按 (ts, 标题, 行数) 去重，两边重复的算一份。
 */
export async function conversationTables(
  s: SessionLike,
  opts: {
    repo: () => Repo;
    dialogue: (s: SessionLike) => DialogueLike;
    blocksFromMarkdown: (t: string) => readonly MarkdownBlockLike[];
  },
): Promise<Record<string, unknown>[]> {
  // Map 而不是普通对象：键是 JSON 元组，可能整数样式开头，V8 会重排普通对象的键
  const seen = new Map<string, Record<string, unknown>>();
  const take = (rec: Record<string, unknown>): void => {
    const key = pyJsonDumps([
      round3(pyFloat(rec["ts"])),
      rec["title"] === undefined ? null : rec["title"],
      ((rec["rows"] as unknown[] | undefined) ?? []).length,
    ]);
    if (!seen.has(key)) seen.set(key, rec);
  };

  let rows: { readonly seq: number }[] = [];
  try {
    rows = (await opts.repo().readEvents(s.id, { since: 0 })) as never;
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const ev = eventRowAsSse(row as never) as Record<string, unknown>;
    if (ev["kind"] === "ui.table" && pyTruthy(ev["rows"])) {
      take({ ...ev, ts: pyFloat(ev["ts"]) });
    } else if (ev["kind"] === "chat.turn") {
      const turn = isPlainDict(ev["turn"]) ? ev["turn"] : {};
      if (pyStr(turn["speaker"]) === "assistant") {
        const ts = pyTruthy(turn["ts"]) ? pyFloat(turn["ts"]) : pyFloat(ev["ts"]);
        for (const rec of tablesInText(pyStr(turn["text"] ?? ""), ts, opts.blocksFromMarkdown)) {
          take(rec);
        }
      }
    }
  }

  const cards = (s.state["_cards"] as SessionEvent[] | undefined) ?? [];
  for (const ev of [...s.events, ...cards] as Record<string, unknown>[]) {
    if (ev["kind"] === "ui.table" && pyTruthy(ev["rows"])) take({ ...ev, ts: pyFloat(ev["ts"]) });
  }
  // 压缩前存下来的那份
  for (const rec of (s.state["_tables"] as Record<string, unknown>[] | undefined) ?? []) {
    take({ ...rec });
  }
  for (const t of opts.dialogue(s).turns) {
    if (pyStr(t.speaker) === "assistant") {
      for (const rec of tablesInText(t.text || "", pyFloat(t.ts), opts.blocksFromMarkdown)) {
        take(rec);
      }
    }
  }

  // Python 的 sorted 是稳定的；JS 的 Array.sort 自 ES2019 起也是
  return [...seen.values()].sort((a, b) => pyFloat(a["ts"]) - pyFloat(b["ts"]));
}

/**
 * 按名字挑一张表；没给名字就是最后出现的那张。
 *
 * 用户点了名（"导出成 Excel：AI 招聘业务流程梳理及访谈提问框架"）却还是拿最后
 * 一张，就会把**另一张**表发给他 —— 他会以为系统记错了，实际是代码没听。
 */
export function pickTable(
  tables: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | null {
  if (tables.length === 0) return null;
  if (!name) return tables[tables.length - 1]!;
  const key = pyStrip(name).toLowerCase();
  // 先全等、再包含、再反向包含（用户常把标题抄短或抄长一点）
  const matchers: ((t: string) => boolean)[] = [
    (t) => t === key,
    (t) => t.includes(key),
    (t) => key.includes(t) && cpLen(t) >= 4,
  ];
  for (const match of matchers) {
    const hit = tables.filter((r) => match(pyStrip(pyStr(r["title"] ?? "")).toLowerCase()));
    if (hit.length > 0) return hit[hit.length - 1]!;
  }
  return null;
}

/**
 * 用户说「这个表」指的那张。
 *
 * 给了名字就**按名字挑** —— 他点名要「AI 招聘业务流程梳理及访谈提问框架」，
 * 结果拿到最后一张（另一个话题的对比表），只会以为系统记错了。
 * 没给名字才是"最后出现的那张"。
 */
export async function lastTable(
  s: SessionLike,
  opts: Parameters<typeof conversationTables>[1],
  name = "",
): Promise<Record<string, unknown> | null> {
  return pickTable(await conversationTables(s, opts), name);
}
