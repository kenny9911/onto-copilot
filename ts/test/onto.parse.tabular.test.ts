/**
 * onto/parse/tabular 的 golden 校验 —— 期望值**一条都不是手写的**。
 *
 * 全部来自 `tools/golden/parse_tabular.py` 真跑 Python 侧导出的
 * `golden/tabular.json`：向量（infer_type / profile_column / detect_header_row /
 * dedupe_headers / _render_pairs / _fill_hierarchy）+ 两份 xlsx 的逐表 grid 与
 * 完整 ParsedDoc + 十四份 CSV 的完整 ParsedDoc。
 *
 * 两份 xlsx：
 *   · `golden/材料.xlsx` —— 主导出器合成的真实业务材料，`pipeline.*.json` 就是
 *     从它跑出来的，这里把上游那一层钉死；
 *   · `golden/tabular.hard.xlsx` —— 本 track 手写 XML 造的硬骨头：日期序列号、
 *     公式缓存值、错误值、inlineStr、合并单元格、空行、只有样式的空格子、
 *     落在空白处的批注、富文本里的拼音段、整数 1 与浮点 1.0。
 *
 * 断言分两层：`toEqual` 给可读的 diff，`JSON.stringify` 再压一遍**键序**——
 * 列画像的键序会原样进 raw、进索引、进 journal，顺序漂了就不是同一份产物。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { readTextGuess } from "../src/onto/parse/base.js";
import type { ParsedDoc } from "../src/onto/parse/base.js";
import { docStats } from "../src/onto/parse/base.js";
import {
  CsvParser,
  XlsxParser,
  dedupeHeaders,
  detectHeaderRow,
  fillHierarchy,
  inferType,
  profileColumn,
  pyFloatStr,
  pyPct,
  pySplitlines,
  readSheetGrids,
  renderPairs,
} from "../src/onto/parse/tabular.js";

const GOLDEN = fileURLToPath(new URL("../../golden/", import.meta.url));

interface DocDump {
  file_id: string;
  file_name: string;
  kind: string;
  meta: Record<string, unknown>;
  structured: Record<string, unknown>;
  findings: unknown[];
  chunks: Record<string, unknown>[];
  stats: Record<string, unknown>;
}
interface SheetDump {
  title: string;
  min_row: number; max_row: number; min_col: number; max_col: number;
  grid: string[][];
  comments: [number, number, string][];
}
interface Golden {
  infer_type: { values: string[]; type: string }[];
  profile_column: { name: string; values: string[]; profile: Record<string, unknown> }[];
  detect_header_row: { rows: string[][]; header: number }[];
  dedupe_headers: { header: string[]; out: string[] }[];
  render_pairs: {
    header: string[]; row: string[]; comments: Record<string, string>; out: string[];
  }[];
  fill_hierarchy: { header: string[]; body: string[][]; out: string[][] }[];
  pct_format: { x: number; out: string }[];
  read_text: { bytes_b64: string; text: string; encoding: string }[];
  xlsx: Record<string, { sha256_b64: string; sheets: SheetDump[]; doc: DocDump }>;
  csv: { name: string; bytes_b64: string; doc: DocDump }[];
}

const g = JSON.parse(
  await readFile(join(GOLDEN, "tabular.json"), "utf8"),
) as Golden;

/** 同时压内容与键序。 */
function same(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/**
 * ParsedDoc → 与 `tools/golden/parse_tabular.py:dump_doc` 一模一样的形状。
 *
 * 少一个键：`cite`。它是 `Chunk.cite()`，住在 `kernel/memory/evidence`（还没移植），
 * base.ts 的 `Chunk` 是纯数据、没有方法 —— 这里不替它发明一个。
 */
function dumpDoc(doc: ParsedDoc): Record<string, unknown> {
  return {
    file_id: doc.file_id,
    file_name: doc.file_name,
    kind: doc.kind,
    meta: doc.meta,
    structured: doc.structured,
    findings: doc.findings.map((f) => ({
      kind: f.kind, message: f.message, locator: f.locator, severity: f.severity,
    })),
    chunks: doc.chunks.map((c) => ({
      chunk_id: c.chunk_id, file_id: c.file_id, file_name: c.file_name,
      locator: c.locator, render: c.render, raw: c.raw, order: c.order,
      tags: c.tags, context: c.context,
    })),
    stats: docStats(doc),
  };
}

function expectedDoc(d: DocDump): Record<string, unknown> {
  return {
    ...d,
    chunks: d.chunks.map((c) => {
      const { cite: _cite, ...rest } = c;
      return rest;
    }),
  };
}

// ══════════════════════════════════════════════════════════════════
//  纯函数
// ══════════════════════════════════════════════════════════════════
describe("inferType", () => {
  it.each(g.infer_type.map((c, i) => [i, c] as const))(
    "#%i %j", (_i, c) => {
      expect(inferType(c.values)).toBe(c.type);
    });
});

describe("profileColumn", () => {
  it.each(g.profile_column.map((c, i) => [i, c] as const))(
    "#%i %s", (_i, c) => {
      same(profileColumn(c.name, c.values), c.profile);
    });
});

describe("detectHeaderRow", () => {
  it.each(g.detect_header_row.map((c, i) => [i, c] as const))(
    "#%i → %j", (_i, c) => {
      expect(detectHeaderRow(c.rows)).toBe(c.header);
    });
});

describe("dedupeHeaders", () => {
  it.each(g.dedupe_headers.map((c, i) => [i, c] as const))(
    "#%i %j", (_i, c) => {
      same(dedupeHeaders(c.header), c.out);
    });
});

describe("renderPairs", () => {
  it.each(g.render_pairs.map((c, i) => [i, c] as const))(
    "#%i %j", (_i, c) => {
      // Python 侧的键是 int 且**按插入序**迭代；普通对象会把整数键重排，
      // 所以这里必须用 Map，而且要按 golden 里的书写顺序塞进去。
      const cm = new Map<number, string>(
        Object.entries(c.comments).map(([k, v]) => [Number(k), v]),
      );
      same(renderPairs(c.header, c.row, cm), c.out);
    });
});

describe("fillHierarchy", () => {
  it.each(g.fill_hierarchy.map((c, i) => [i, c] as const))(
    "#%i", (_i, c) => {
      same(fillHierarchy(c.header, c.body), c.out);
    });
});

describe("pyPct", () => {
  // schema 切片的 render 里那个 `:.0%`。平局（12.5 / 37.5）上 toFixed 会给 13 / 38。
  it.each(g.pct_format.map((c) => [c.x, c.out] as const))(
    "format(%p, '.0%%') === %s", (x, out) => {
      expect(pyPct(x)).toBe(out);
    });
});

// ══════════════════════════════════════════════════════════════════
//  _read_text（base.ts 的 readTextGuess）
// ══════════════════════════════════════════════════════════════════
let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ontocopilot-tabular-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * `_read_text` 住在 base.ts（`readTextGuess`），tabular 是它的第一个调用方，
 * 所以编码判定的向量放在这里跑。
 *
 * 最要紧的一条是 `b"\x80\x81name,age\n"`：WHATWG 的 gb18030 解码器把单字节
 * `0x80` 映成 `€`，CPython 的 `gb18030` codec **判它非法**。Python 因此一路掉到
 * latin-1（每字节一码点），而"顺手用 TextDecoder"的实现会在这里收下一份
 * 解错编码的正文 —— 而且 `encoding_guess` 那条 finding 还会理直气壮地说它是 GBK。
 */
describe("readTextGuess", () => {
  it.each(g.read_text.map((c, i) => [i, c] as const))("#%i → %s", async (i, c) => {
    const p = join(tmp, `rt${i}.bin`);
    writeFileSync(p, Buffer.from(c.bytes_b64, "base64"));
    const [text, enc] = await readTextGuess(p);
    expect([text, enc]).toEqual([c.text, c.encoding]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  xlsx
// ══════════════════════════════════════════════════════════════════
describe.each(Object.keys(g.xlsx))("xlsx %s", (name) => {
  const fixture = g.xlsx[name]!;

  it("逐表 grid 与批注与 openpyxl 一致", async () => {
    const bytes = await readFile(join(GOLDEN, name));
    const got = readSheetGrids(bytes);
    // Python 侧 grid 为空的表照样出现在 sheets 列表里（是 XlsxParser 跳过它，
    // 不是读的时候就没有），所以两边表数必须相等。
    expect(got.map((s) => s.title)).toEqual(fixture.sheets.map((s) => s.title));
    fixture.sheets.forEach((want, i) => {
      const mine = got[i]!;
      same(mine.grid, want.grid);
      same(
        [...mine.comments].map(([k, v]) => {
          const comma = k.indexOf(",");
          return [Number(k.slice(0, comma)), Number(k.slice(comma + 1)), v];
        }),
        want.comments,
      );
    });
  });

  it("ParsedDoc 与 Python 逐字段一致", async () => {
    const doc = await new XlsxParser().parse(join(GOLDEN, name), { fileId: "f_fixed" });
    same(dumpDoc(doc), expectedDoc(fixture.doc));
  });
});

// ══════════════════════════════════════════════════════════════════
//  csv
// ══════════════════════════════════════════════════════════════════
describe("csv", () => {
  it.each(g.csv.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const p = join(tmp, name);
    writeFileSync(p, Buffer.from(c.bytes_b64, "base64"));
    const doc = await new CsvParser().parse(p, { fileId: "f_fixed" });
    same(dumpDoc(doc), expectedDoc(c.doc));
  });
});

// ══════════════════════════════════════════════════════════════════
//  TS 侧独有的风险（Python 覆盖不到，但这里非红不可）
// ══════════════════════════════════════════════════════════════════
describe("pyFloatStr", () => {
  // 期望值来自 CPython 的 repr()；这几条是 JS String() 一定会给出别的答案的：
  //   1.0 → "1"、1e16 → "10000000000000000"、1e-5 → "0.00001"、-0 → "0"
  it.each([
    [1.0, "1.0"], [1.5, "1.5"], [-3.5, "-3.5"], [0.13, "0.13"],
    [45000.5, "45000.5"], [1e15, "1000000000000000.0"], [1e16, "1e+16"],
    [1.5e20, "1.5e+20"], [0.0001, "0.0001"], [1e-5, "1e-05"], [1e-7, "1e-07"],
    [0, "0.0"], [-0, "-0.0"], [Number.NaN, "nan"], [Infinity, "inf"],
    [-Infinity, "-inf"],
  ])("repr(%p) === %s", (x, want) => {
    expect(pyFloatStr(x)).toBe(want);
  });
});

describe("pySplitlines", () => {
  // Python 在 \v \f \x1c-\x1e \x85 上也断行，`split(/\r?\n/)` 一条都不认。
  it.each([
    ["", []],
    ["a\nb", ["a", "b"]],
    ["a\r\nb", ["a", "b"]],
    ["a\rb", ["a", "b"]],
    ["a\n", ["a"]],
    ["a\x0bb\x0cc\x1dde", ["a", "b", "c", "d", "e"]],
    ["a b", ["a", "b"]],
  ])("%j", (s, want) => {
    expect(pySplitlines(s)).toEqual(want);
  });
});
