/**
 * 模板编译器 + 动态编辑的 golden 校验。
 *
 * 四份 golden：
 *   - `golden/pipeline.template.json` —— 真材料（材料.xlsx）跑整条流水线编出来的
 *     spec。它是**独立于本次移植**产生的（tools/export_golden.py），所以拿它做
 *     断言最硬：TS 侧从 `pipeline.oir.json` 还原 OIR、带上同一批冲突重编，
 *     必须一个字节都不差。
 *   - `golden/xlsx.cells.json` —— 真实 xlsx 产物的逐格快照（openpyxl 读回）。
 *   - `golden/template.json` —— 由 `tools/golden/template.py` 导出，补上真材料里
 *     没有的属性/关系/规则三张表、自适应列、37 条编辑守卫消息，以及一份
 *     六表全的 xlsx 逐格 dump（含列宽、下拉、批注、隐藏列、填充色）。
 *
 * 期望值一律来自 golden，不手写。
 *
 * ── xlsx 那部分怎么验的 ──────────────────────────────────────────
 *
 * 这里读回产物用的是 exceljs 自己的解析器，**只能证明 exceljs 自洽**。
 * 「在 Excel 里跟 openpyxl 的产物长得一样」这条，靠的是用 openpyxl 读同一个文件：
 *
 *     cd ts && npx vitest run test/onto.template.test.ts   # 会写出 /tmp 的产物
 *     .venv/bin/python tools/golden/template.py --dump <那份 xlsx>
 *
 * 移植时这么比过：openpyxl 读 TS 产物 == golden（openpyxl 读 Python 产物），
 * 两份样本（六表全的 + 空模板）全字段相等。唯一的差异（批注作者名）写在
 * template.ts 的 writeXlsx 注释里。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fingerprint, sha256Hex } from "../src/kernel/ids.js";
import { oirFromDict } from "../src/onto/oir.js";
import {
  ANCHOR_HASH,
  ANCHOR_RID,
  Role,
  TemplateSpec,
  WEIGHTS,
  cellFromDict,
  cellToDict,
  cellWeight,
  columnLetter,
  compileTemplate,
  makeCell,
  parseRole,
  prefillHash,
  statsJson,
  writeXlsx,
  type Cell,
  type ConflictLike,
} from "../src/onto/template.js";
import {
  EditError,
  REQUIRED_BLOCKLIST,
  WRITEBACK_FIELDS,
  applyEdit,
  reconcileTemplate,
  type PatchEntry,
} from "../src/onto/template_edit.js";

const requireCjs = createRequire(import.meta.url);
const ExcelJS = requireCjs("exceljs") as typeof import("exceljs");

const GOLDEN = join(__dirname, "../../golden");
const readGolden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(GOLDEN, name), "utf8")) as Record<string, unknown>;

type Dict = Record<string, unknown>;

interface Compiled {
  conflicts: ConflictLike[];
  round_no: number;
  spec: Dict;
  stats: Dict;
  save_sha256: string;
  save_len: number;
  oir?: Dict;
}
interface Digest {
  fp: string;
  round: number;
  sheets: { name: string; guide: string; columns: string[]; nrows: number; first_row: Dict | null }[];
}
interface EditCase {
  name: string;
  ops: { op: string; args: Dict }[];
  notes: string[];
  error: string | null;
  after: Digest;
}
interface XlsxCellDump {
  ref: string;
  value: unknown;
  fill: string | null;
  bold: boolean;
  italic: boolean;
  size: number | null;
  font_color: string | null;
  wrap: boolean | null;
  valign: string | null;
  border: Record<string, [string | null, string | null]>;
  comment: string | null;
}
interface XlsxSheetDump {
  cells: XlsxCellDump[];
  hidden_cols: string[];
  widths: Record<string, number>;
  freeze: string | null;
  merged: string[];
  row_heights: Record<string, number>;
  validations: {
    sqref: string;
    type: string;
    formula1: string;
    allow_blank: boolean;
    show_error: boolean;
    error_title: string;
    error: string;
  }[];
}
interface XlsxDump {
  sheet_order: string[];
  sheets: Record<string, XlsxSheetDump>;
}

const G = readGolden("template.json") as unknown as {
  pipeline: Compiled;
  rich: Compiled & { oir: Dict };
  adaptive: Record<string, { oir: Dict; columns: string[]; guide: string; order: string[]; spec: Dict }>;
  empty: { spec: Dict; stats: Dict; sheet_names: string[] };
  cell: {
    weights: Record<string, number>;
    samples: { to_dict: Dict; weight: number; prefill_hash: string; round_trip: Dict }[];
    from_dict_minimal: Dict;
  };
  xlsx: Record<string, { project: string; dump: XlsxDump; long_comment_on?: [string, string]; long_comment_in?: string }>;
  edits: {
    base_oir: Dict;
    base_spec: Dict;
    base_save_text: string;
    cases: EditCase[];
    reconcile: { oir: Dict; patch_log: PatchEntry[]; after: Digest; stale: (PatchEntry & { why: string })[] };
  };
};

const PIPELINE_OIR = readGolden("pipeline.oir.json");
const PIPELINE_TEMPLATE = readGolden("pipeline.template.json");
const XLSX_CELLS = readGolden("xlsx.cells.json") as unknown as Record<
  string,
  { cells: { ref: string; value: unknown; fill: string; bold: boolean; comment: string | null }[];
    hidden_cols: string[]; freeze: string | null }
>;

/** 与 tools/golden/template.py 的 `_digest` 同形态。 */
function digest(spec: TemplateSpec): Digest {
  return {
    fp: fingerprint(spec.toDict()),
    round: spec.round,
    sheets: spec.sheets.map((sh) => {
      const first = sh.rows[0];
      const firstRow: Dict | null = first
        ? Object.fromEntries([...first].map(([k, c]) => [k, cellToDict(c)]))
        : null;
      return {
        name: sh.name,
        guide: sh.guide,
        columns: [...sh.columns],
        nrows: sh.rows.length,
        first_row: firstRow,
      };
    }),
  };
}

// ══════════════════════════════════════════════════════════════════
//  1. 真材料 —— 与独立产生的 pipeline.template.json 逐字节比
// ══════════════════════════════════════════════════════════════════
describe("compileTemplate —— 真材料", () => {
  const oir = oirFromDict(PIPELINE_OIR);
  const spec = compileTemplate(oir, G.pipeline.conflicts);

  it("编出来的 spec 与流水线产物一字不差", () => {
    expect(spec.toDict()).toEqual(PIPELINE_TEMPLATE);
  });

  it("与 tools/golden/template.py 重跑的那份也一致", () => {
    expect(spec.toDict()).toEqual(G.pipeline.spec);
  });

  it("stats 与 Python 一致（prefill_rate 是 round-half-even）", () => {
    expect(spec.stats() as unknown as Dict).toEqual(G.pipeline.stats);
  });

  it("表的顺序即优先级：问题在最前，对象清单在后", () => {
    // 顺序不是装饰：业务人员从上往下填，最该他答的排在最前面
    expect(spec.sheets.map((s) => s.name)).toEqual([
      "02_待澄清问题",
      "01_对象清单",
      "04_动作清单",
      "05_术语表",
    ]);
  });

  it("空表一律不出 —— 属性/关系/规则三张表这份材料里没有内容", () => {
    expect(spec.sheets.map((s) => s.name)).not.toContain("02_属性明细");
    expect(spec.sheets.every((s) => s.rows.length > 0)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 六表全的样本 —— 属性 / 关系 / 规则 / 术语表
// ══════════════════════════════════════════════════════════════════
describe("compileTemplate —— 六张表全跑到", () => {
  const oir = oirFromDict(G.rich.oir);
  const spec = compileTemplate(oir, G.rich.conflicts, { roundNo: G.rich.round_no });

  it("spec 与 Python 一致", () => {
    expect(spec.toDict()).toEqual(G.rich.spec);
  });

  it("stats 与 Python 一致", () => {
    expect(spec.stats() as unknown as Dict).toEqual(G.rich.stats);
  });

  it("口径永远是业务必填 —— 系统抽出来的只是候选，必须有人认领", () => {
    const defs = spec.cells().filter((c) => c.field === "definition");
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.every((c) => c.role === Role.REQUIRED)).toBe(true);
  });

  it("冲突的格子带红角标，并且批注里写清了理由", () => {
    const flagged = spec.cells().filter((c) => c.conflict);
    expect(flagged.length).toBeGreaterThan(0);
    const amount = flagged.find((c) => c.rid === "pt_amount_budget");
    expect(amount?.comment).toContain("口径不一致");
  });

  it("预填值带着它的证据出处 —— 业务方能看到系统凭什么这么填", () => {
    const api = spec
      .cells()
      .find((c) => c.rid === "pt_amount_budget" && c.field === "apiName");
    expect(api?.comment).toContain("实体梳理.xlsx!业务对象实体梳理!R44CF");
  });

  it("只读接口的影响范围是确定答案，锁死不问人", () => {
    const eff = spec.cells().find((c) => c.rid === "at_query_plan" && c.field === "effects");
    expect(eff?.value).toBe("只读，不改动单据");
    expect(eff?.role).toBe(Role.LOCKED);
    // 路径里带 create 的，即便也带 export 也算写操作（黑名单优先）
    const write = spec.cells().find((c) => c.rid === "at_export_create" && c.field === "effects");
    expect(write?.role).toBe(Role.REQUIRED);
  });

  it("只有真的是草稿的才要人确认", () => {
    const drafted = spec.cells().find((c) => c.rid === "at_submit_plan" && c.field === "confirmed");
    const done = spec.cells().find((c) => c.rid === "at_query_plan" && c.field === "confirmed");
    expect([drafted?.value, drafted?.role]).toEqual(["待确认", Role.REQUIRED]);
    expect([done?.value, done?.role]).toEqual(["已确认", Role.PREFILLED]);
  });

  it("save() 落盘的字节与 Python 的 json.dumps(indent=1) 一致", () => {
    const text = JSON.stringify(spec.toDict(), null, 1);
    expect([...text].length).toBe(G.rich.save_len);
    // sha256 复用 kernel/ids（与 Python 侧同实现）
    expect(sha256Hex(text)).toBe(G.rich.save_sha256);
  });
});


// ══════════════════════════════════════════════════════════════════
//  3. 自适应列 —— 「模板列要从证据推出来」的可执行判据
// ══════════════════════════════════════════════════════════════════
describe("_Q_COLUMNS —— 列由问题内容算出来，不是写死的表头", () => {
  const compiled = Object.fromEntries(
    Object.entries(G.adaptive).map(([k, v]) => [k, compileTemplate(oirFromDict(v.oir))]),
  );
  const qsheet = (spec: TemplateSpec) =>
    spec.sheets.find((s) => s.name === "02_待澄清问题");

  for (const [name, want] of Object.entries(G.adaptive)) {
    it(`${name}：列与 Python 一致`, () => {
      const sh = qsheet(compiled[name] as TemplateSpec);
      expect(sh?.columns).toEqual(want.columns);
      expect(sh?.guide).toBe(want.guide);
      expect(sh?.rows.map((r) => (r.values().next().value as Cell).rid)).toEqual(want.order);
      expect((compiled[name] as TemplateSpec).toDict()).toEqual(want.spec);
    });
  }

  it("两份不同的问题集必须产生不同的列（列写死了这里就红）", () => {
    // 客户问卷带编号和参考选项；从证据里挖出来的带出处、没有编号也没有选项。
    // 这两组内容不同，列就必须不同 —— 一样说明列又被写死成某份材料的形状了。
    const a = qsheet(compiled["questionnaire"] as TemplateSpec)?.columns;
    const b = qsheet(compiled["mined"] as TemplateSpec)?.columns;
    const c = qsheet(compiled["bare"] as TemplateSpec)?.columns;
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
    // 没有内容的列一列都不许出：只有正文时只剩两列必出列
    expect(c).toEqual(["澄清问题", "答复"]);
    // 「材料出处」有内容才出，出了才在说明里加那句话
    expect(b).toContain("材料出处");
    expect(qsheet(compiled["mined"] as TemplateSpec)?.guide).toContain("按出处翻回原文核对");
    expect(qsheet(compiled["bare"] as TemplateSpec)?.guide).not.toContain("按出处翻回原文核对");
  });

  it("客户自己提的排最前", () => {
    const order = qsheet(compiled["mixed"] as TemplateSpec)?.rows.map(
      (r) => (r.values().next().value as Cell).rid,
    );
    expect(order?.[0]).toBe("oq6"); // asked_by=customer，尽管分组 Z 排最后
  });

  it("答过的问题不再出现在待澄清表里", () => {
    const oir = oirFromDict(G.rich.oir);
    const spec = compileTemplate(oir, G.rich.conflicts, { roundNo: G.rich.round_no });
    const rids = spec
      .sheets.find((s) => s.name === "02_待澄清问题")
      ?.rows.map((r) => (r.values().next().value as Cell).rid);
    expect(rids).toContain("oq_tax");
    expect(rids).not.toContain("oq_answered");
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. 空 OIR
// ══════════════════════════════════════════════════════════════════
describe("compileTemplate —— 空 OIR", () => {
  const spec = compileTemplate(oirFromDict({}), []);
  it("对象清单永远出，其余表都不出", () => {
    expect(spec.sheets.map((s) => s.name)).toEqual(G.empty.sheet_names);
    expect(spec.toDict()).toEqual(G.empty.spec);
    expect(spec.stats() as unknown as Dict).toEqual(G.empty.stats);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. Cell 的标量行为
// ══════════════════════════════════════════════════════════════════
describe("Cell", () => {
  it("权重表与 Python 一致", () => {
    expect(WEIGHTS).toEqual(G.cell.weights);
  });

  it("weight / prefill_hash / to_dict / from_dict 往返", () => {
    for (const s of G.cell.samples) {
      const c = cellFromDict(s.to_dict);
      expect(cellToDict(c)).toEqual(s.to_dict);
      expect(cellWeight(c)).toBe(s.weight);
      expect(prefillHash(c)).toBe(s.prefill_hash);
      expect(cellToDict(cellFromDict(cellToDict(c)))).toEqual(s.round_trip);
    }
  });

  it("from_dict 的缺省：owner/comment/options/conflict/expects_prose 全可省", () => {
    const c = cellFromDict({ rid: "r4", sheet: "s", field: "f", value: "v", role: "locked" });
    expect(cellToDict(c)).toEqual(G.cell.from_dict_minimal);
  });

  it("未知角色抛错，不静默降级", () => {
    expect(() => parseRole("readonly")).toThrow(/not a valid Role/);
    expect(() => cellFromDict({ rid: "r", sheet: "s", field: "f", value: "", role: "x" })).toThrow();
  });

  it("缺键当场炸 —— 静默补空串会让整表对不上号且不报错", () => {
    expect(() => cellFromDict({ sheet: "s", field: "f", value: "", role: "locked" })).toThrow(
      /KeyError: rid/,
    );
  });

  it("expects_prose 由编译期定：口径是散文，有下拉的不是", () => {
    expect(makeCell("r", "s", "definition", "x", Role.REQUIRED).expectsProse).toBe(true);
    expect(
      makeCell("r", "s", "definition", "x", Role.REQUIRED, { options: ["甲", "乙"] }).expectsProse,
    ).toBe(false);
    expect(makeCell("r", "s", "owner", "x", Role.REQUIRED).expectsProse).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. 落盘 / 读回
// ══════════════════════════════════════════════════════════════════
describe("TemplateSpec 的持久化", () => {
  it("save 的文本与 Python 的 json.dumps(ensure_ascii=False, indent=1) 逐字一致", () => {
    const spec = TemplateSpec.fromDict(G.edits.base_spec);
    const dir = mkdtempSync(join(tmpdir(), "ontocopilot-tpl-"));
    try {
      const p = spec.save(join(dir, "sub", "spec.json"));
      expect(readFileSync(p, "utf8")).toBe(G.edits.base_save_text);
      expect(TemplateSpec.load(p).toDict()).toEqual(G.edits.base_spec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("byRid 的键是 (rid, field)", () => {
    const spec = TemplateSpec.fromDict(G.edits.base_spec);
    const m = spec.byRid();
    expect(m.size).toBe(spec.cells().length);
    expect(m.get("ot_0\u0000apiName")?.value).toBe("obj0");
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. xlsx —— 样式即语义
// ══════════════════════════════════════════════════════════════════

/** 读回一份 xlsx，dump 成与 `tools/golden/template.py::_dump_xlsx` 同形态的结构。 */
async function dumpXlsx(path: string): Promise<XlsxDump> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheets: Record<string, XlsxSheetDump> = {};
  for (const ws of wb.worksheets) {
    const cells: XlsxCellDump[] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        // 合并区里的从格：openpyxl 读出来是 MergedCell(value=None)，会被过滤掉
        if (cell.type === ExcelJS.ValueType.Merge) return;
        const note = noteText(cell.note);
        const value = cell.value === undefined || cell.value === "" ? null : cell.value;
        if (value === null && note === null) return;
        const f = cell.font as
          | { bold?: boolean; italic?: boolean; size?: number; color?: { argb?: string } }
          | undefined;
        const al = cell.alignment as
          | { wrapText?: boolean; vertical?: string }
          | undefined;
        const fill = cell.fill as { fgColor?: { argb?: string } } | undefined;
        const side = (s?: { style?: string; color?: { argb?: string } }): [string | null, string | null] => [
          s?.style ?? null,
          s?.color?.argb ?? null,
        ];
        const b = (cell.border ?? {}) as Record<string, { style?: string; color?: { argb?: string } }>;
        cells.push({
          ref: cell.address,
          value,
          // 没有填充的格：openpyxl 读出来是 "00000000"
          fill: fill?.fgColor?.argb ?? "00000000",
          bold: Boolean(f?.bold),
          italic: Boolean(f?.italic),
          // 完全没有字体的格用工作簿默认字号（openpyxl 报 11.0）；有字体但没写
          // 字号的（必填格是 Font(bold, color)）openpyxl 报 None。
          size: f === undefined ? 11 : (f.size ?? null),
          font_color: f?.color?.argb ?? null,
          wrap: al?.wrapText ?? null,
          valign: al?.vertical ?? null,
          border: {
            left: side(b["left"]),
            right: side(b["right"]),
            top: side(b["top"]),
            bottom: side(b["bottom"]),
          },
          comment: note,
        });
      });
    });

    const hidden: string[] = [];
    const widths: Record<string, number> = {};
    for (let i = 1; i <= ws.columnCount; i++) {
      const col = ws.getColumn(i);
      if (col.hidden) hidden.push(columnLetter(i));
      else if (col.width !== undefined) widths[columnLetter(i)] = col.width;
    }
    const rowHeights: Record<string, number> = {};
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      // exceljs 会给每一行一个默认高度对象，只有显式设过的才有 height
      if (row.height !== undefined && row.height !== null) rowHeights[String(n)] = row.height;
    });
    // 没设过视图的表（填写指引）读回来是 null，不是空数组
    const view = (ws.views ?? [])[0] as
      | { state?: string; xSplit?: number; ySplit?: number }
      | undefined;
    const freeze =
      view?.state === "frozen"
        ? `${columnLetter((view.xSplit ?? 0) + 1)}${(view.ySplit ?? 0) + 1}`
        : null;
    sheets[ws.name] = {
      cells,
      hidden_cols: hidden,
      widths,
      freeze,
      merged: (ws.model as unknown as { merges?: string[] }).merges ?? [],
      row_heights: rowHeights,
      validations: [], // 逐格展开后单独比（见 dvMap）
    };
  }
  return { sheet_order: wb.worksheets.map((w) => w.name), sheets };
}

function noteText(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note === "string") return note;
  const texts = (note as { texts?: { text?: string }[] }).texts;
  return texts ? texts.map((t) => t.text ?? "").join("") : null;
}

/** 把 golden 的 sqref（可能是 `E3:E7`，也可能是空格分隔的多段）摊成逐格。 */
function expandSqref(sqref: string): string[] {
  const out: string[] = [];
  for (const part of sqref.split(/\s+/)) {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(part);
    if (!m) throw new Error(`看不懂的 sqref: ${part}`);
    const [, c1, r1, c2, r2] = m;
    const colNum = (s: string): number =>
      [...s].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    const a = colNum(c1 as string);
    const b = c2 ? colNum(c2) : a;
    for (let c = a; c <= b; c++) {
      for (let r = Number(r1); r <= Number(r2 ?? r1); r++) out.push(`${columnLetter(c)}${r}`);
    }
  }
  return out;
}

interface FlatDv {
  type: string;
  formula1: string;
  allow_blank: boolean;
  show_error: boolean;
  error_title: string;
  error: string;
}

function goldenDvMap(sh: XlsxSheetDump): Record<string, FlatDv> {
  const out: Record<string, FlatDv> = {};
  for (const dv of sh.validations) {
    for (const addr of expandSqref(dv.sqref)) {
      out[addr] = {
        type: dv.type,
        formula1: dv.formula1,
        allow_blank: dv.allow_blank,
        show_error: dv.show_error,
        error_title: dv.error_title,
        error: dv.error,
      };
    }
  }
  return out;
}

async function readDvMap(path: string, sheetName: string): Promise<Record<string, FlatDv>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`没有这张表：${sheetName}`);
  // exceljs 读回来是逐格的（它把 sqref 的区间摊开了），所以两边都摊平再比
  const model = (
    ws as unknown as {
      dataValidations: {
        model: Record<
          string,
          {
            type: string;
            formulae: string[];
            allowBlank?: boolean;
            showErrorMessage?: boolean;
            errorTitle?: string;
            error?: string;
          }
        >;
      };
    }
  ).dataValidations.model;
  const out: Record<string, FlatDv> = {};
  for (const [addr, dv] of Object.entries(model)) {
    out[addr] = {
      type: dv.type,
      formula1: dv.formulae[0] as string,
      allow_blank: dv.allowBlank ?? false,
      show_error: dv.showErrorMessage ?? false,
      error_title: dv.errorTitle ?? "",
      error: dv.error ?? "",
    };
  }
  return out;
}

describe("writeXlsx —— 填充色 / 批注 / 隐藏锚点列 / 列宽 / 下拉", () => {
  const dir = mkdtempSync(join(tmpdir(), "ontocopilot-xlsx-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("六表全的产物逐格与 openpyxl 的产物一致", async () => {
    const oir = oirFromDict(G.rich.oir);
    const spec = compileTemplate(oir, G.rich.conflicts, { roundNo: G.rich.round_no });
    // golden 里那一格被换成了 900+ 字符的批注，用来钉住截断
    const [shName, colName] = G.xlsx["rich"]?.long_comment_on as [string, string];
    const sh = spec.sheets.find((s) => s.name === shName);
    (sh?.rows[0]?.get(colName) as Cell).comment = G.xlsx["rich"]?.long_comment_in as string;

    const path = await writeXlsx(spec, join(dir, "rich.xlsx"), { project: "ONT-112" });
    const dump = await dumpXlsx(path);
    const want = G.xlsx["rich"]?.dump as XlsxDump;

    expect(dump.sheet_order).toEqual(want.sheet_order);
    for (const name of want.sheet_order) {
      const got = dump.sheets[name] as XlsxSheetDump;
      const exp = want.sheets[name] as XlsxSheetDump;
      expect({ sheet: name, cells: got.cells }).toEqual({ sheet: name, cells: exp.cells });
      expect(got.hidden_cols).toEqual(exp.hidden_cols);
      expect(got.widths).toEqual(exp.widths);
      expect(got.freeze).toEqual(exp.freeze);
      expect(got.merged).toEqual(exp.merged);
      expect(got.row_heights).toEqual(exp.row_heights);
      expect(await readDvMap(path, name)).toEqual(goldenDvMap(exp));
    }
  });

  it("空模板也写得出（对象清单只有表头）", async () => {
    const spec = compileTemplate(oirFromDict({}), []);
    const path = await writeXlsx(spec, join(dir, "empty.xlsx"), { project: "" });
    const dump = await dumpXlsx(path);
    const want = G.xlsx["empty"]?.dump as XlsxDump;
    expect(dump.sheet_order).toEqual(want.sheet_order);
    for (const name of want.sheet_order) {
      expect(dump.sheets[name]?.cells).toEqual(want.sheets[name]?.cells);
      expect(dump.sheets[name]?.hidden_cols).toEqual(want.sheets[name]?.hidden_cols);
      expect(dump.sheets[name]?.widths).toEqual(want.sheets[name]?.widths);
    }
  });

  it("真材料那份与 xlsx.cells.json（独立产生的快照）一致", async () => {
    // 这份 golden 的 OIR 只有一个对象和一个问题，直接照 export_golden.py 的输入重建
    const oir = oirFromDict({
      objects: [
        {
          rid: "ot_po",
          apiName: { value: "poHeader", origin: "inferred", confidence: 0.4, evidence: [] },
          displayName: { value: "采购订单头", origin: "inferred", confidence: 0.4, evidence: [] },
          description: { value: "", origin: "inferred", confidence: 0.4, evidence: [] },
          primaryKey: { value: [], origin: "inferred", confidence: 0.4, evidence: [] },
        },
      ],
      questions: [
        {
          rid: "oq1",
          text: { value: "金额含不含税？", origin: "inferred", confidence: 0.4, evidence: [] },
          options: ["含税", "不含税"],
          answer: { value: "", origin: "inferred", confidence: 0.4, evidence: [] },
          group: "口径",
          code: "1",
          askedBy: "customer",
        },
      ],
    });
    const path = await writeXlsx(compileTemplate(oir), join(dir, "golden.xlsx"), {
      project: "golden",
    });
    const dump = await dumpXlsx(path);
    for (const [name, want] of Object.entries(XLSX_CELLS)) {
      const got = dump.sheets[name] as XlsxSheetDump;
      expect(got.cells.map((c) => ({
        ref: c.ref, value: c.value, fill: c.fill, bold: c.bold, comment: c.comment,
      }))).toEqual(want.cells);
      expect(got.hidden_cols).toEqual(want.hidden_cols);
      expect(got.freeze).toEqual(want.freeze);
    }
  });

  it("统计行里的 prefill_rate 是 Python float 的形态（0.0 不是 0）", () => {
    expect(statsJson(compileTemplate(oirFromDict({})).stats())).toContain('"prefill_rate": 0.0');
  });
});

// ══════════════════════════════════════════════════════════════════
//  8. template_edit —— 守卫与人话说明
// ══════════════════════════════════════════════════════════════════
describe("applyEdit —— 每条守卫的消息一个字都不能漂", () => {
  const fresh = (): TemplateSpec => TemplateSpec.fromDict(G.edits.base_spec);

  for (const c of G.edits.cases) {
    it(c.name, () => {
      const spec = fresh();
      const notes: string[] = [];
      let err: string | null = null;
      for (const { op, args } of c.ops) {
        try {
          notes.push(applyEdit(spec, op, args));
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          err = e.message;
          break;
        }
      }
      expect(notes).toEqual(c.notes);
      expect(err).toEqual(c.error);
      // 被拒的编辑不许留下任何痕迹 —— 半应用的模板比不改更糟
      expect(digest(spec)).toEqual(c.after);
    });
  }

  it("锚点列在任何编辑之后都还在", () => {
    const spec = fresh();
    applyEdit(spec, "add_column", { sheet: "01_对象清单", name: "备注", role: "prefilled" });
    applyEdit(spec, "drop_column", { sheet: "01_对象清单", column: "primaryKey" });
    for (const s of spec.sheets) {
      expect(s.columns).not.toContain(ANCHOR_RID);
      expect(s.columns).not.toContain(ANCHOR_HASH);
    }
  });

  it("加列后再删掉 == 什么都没改", () => {
    const spec = fresh();
    const before = spec.sheets.map((s) => [...s.columns]);
    applyEdit(spec, "add_column", { sheet: "01_对象清单", name: "临时", role: "locked" });
    applyEdit(spec, "drop_column", { sheet: "01_对象清单", column: "临时" });
    expect(spec.sheets.map((s) => [...s.columns])).toEqual(before);
  });

  it("模糊表名命中的是真表名，写进 Cell.sheet 的也是真表名", () => {
    const spec = fresh();
    applyEdit(spec, "add_column", { sheet: "对象清单", name: "备注" });
    const sh = spec.sheets.find((s) => s.name === "01_对象清单");
    expect(sh?.rows.every((r) => r.get("备注")?.sheet === "01_对象清单")).toBe(true);
  });

  it("WRITEBACK_FIELDS / REQUIRED_BLOCKLIST 与 Python 一致", () => {
    // 这两张表是"填了会不会被静默丢弃"的唯一判据，漂了就是黑洞
    expect([...WRITEBACK_FIELDS].sort()).toEqual(
      [
        "cardinality", "definition", "description", "displayName", "effects", "owner",
        "primaryKey", "执行角色", "答复", "管哪个单据", "这条对吗",
      ].sort(),
    );
    expect([...REQUIRED_BLOCKLIST]).toEqual(["primaryKey"]);
  });
});

describe("reconcileTemplate —— OIR 改动进手改模板", () => {
  it("新对象进来了，手改的列也还在；重放不上的报出来但不致命", () => {
    const oir = oirFromDict(G.edits.reconcile.oir);
    const [spec, stale] = reconcileTemplate(oir, [], G.edits.reconcile.patch_log);
    expect(digest(spec)).toEqual(G.edits.reconcile.after);
    expect(stale).toEqual(G.edits.reconcile.stale);
  });
});
