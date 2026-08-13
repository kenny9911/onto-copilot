/**
 * onto/bundle.ts —— 交付包打包。
 *
 * 期望值全部来自 `golden/onto.bundle.json`（`tools/golden/onto_bundle.py` 从
 * Python 原件真跑出来的），包括 **整包 zip 的字节**。手写期望值在这里尤其没有
 * 意义：zip 的头部布局、deflate 的输出、manifest 的 JSON 缩进形态，任何一处
 * 猜错都要等到用户拿到两份 diff 全红的交付包才会发现。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import {
  BUNDLE_SCHEMA,
  buildManifest,
  buildZip,
  bundleId,
  classify,
  flowProvenance,
  oirProvenance,
  pyJsonDumps,
  readmeText,
  type ZipDateTime,
} from "../src/onto/bundle.js";

const GOLDEN_DIR = fileURLToPath(new URL("../../golden/", import.meta.url));
const G = JSON.parse(readFileSync(GOLDEN_DIR + "onto.bundle.json", "utf-8")) as GoldenFile;

interface GoldenFile {
  classify: { name: string; out: [string, string, string] }[];
  flow_provenance: { label: string; in: Record<string, unknown> | null; out: Record<string, unknown> }[];
  oir_provenance: { label: string; in: Record<string, unknown> | null; out: Record<string, unknown> }[];
  bundle_id: { files: Record<string, unknown>[]; pv: string; rs: string; id: string }[];
  manifest_cases: {
    label: string;
    session: Record<string, unknown>;
    flow: Record<string, unknown> | null;
    oir: Record<string, unknown> | null;
    open_questions: Record<string, unknown>[];
    manifest: Record<string, unknown>;
    manifest_json: string;
    readme: string;
  }[];
  manifest_files: Record<string, unknown>[];
  manifest_materials: Record<string, unknown>[];
  zip: {
    date_time: number[];
    entries: { name: string; b64: string }[];
    manifest_case: string;
    b64: string;
    namelist: string[];
  };
}

const realFlow = JSON.parse(readFileSync(GOLDEN_DIR + "pipeline.flow.json", "utf-8")) as Record<
  string,
  unknown
>;
const realOir = JSON.parse(readFileSync(GOLDEN_DIR + "pipeline.oir.json", "utf-8")) as Record<
  string,
  unknown
>;

function caseOf(label: string): GoldenFile["manifest_cases"][number] {
  const c = G.manifest_cases.find((x) => x.label === label);
  if (!c) throw new Error(`golden 缺 manifest_case ${label}`);
  return c;
}

describe("classify", () => {
  for (const v of G.classify) {
    it(`${JSON.stringify(v.name)} → ${v.out[0]}`, () => {
      expect(classify(v.name)).toEqual(v.out);
    });
  }

  it("回传前缀优先于 .xlsx 后缀 —— 回传件不是模板", () => {
    expect(classify("回传_审核.xlsx")[0]).toBe("audit_return");
    expect(classify("模板_v1.xlsx")[0]).toBe("template_xlsx");
    // 反面：前缀对了但后缀不是 xlsx，就不是回传件
    expect(classify("回传.csv")[0]).toBe("other");
  });
});

describe("溯源汇总", () => {
  for (const v of G.flow_provenance) {
    it(`flowProvenance ${v.label}`, () => {
      const input = v.label === "pipeline.flow.json" ? realFlow : v.in;
      expect(flowProvenance(input)).toEqual(v.out);
    });
  }
  for (const v of G.oir_provenance) {
    it(`oirProvenance ${v.label}`, () => {
      const input = v.label === "pipeline.oir.json" ? realOir : v.in;
      expect(oirProvenance(input)).toEqual(v.out);
    });
  }

  it("null / 空输入不炸 —— 下游不必判 None", () => {
    expect(flowProvenance(null)["nodes"]).toBe(0);
    expect(oirProvenance(null)["objects"]).toBe(0);
  });

  it("stats.inferred_edges 为 0（Python 假值）时回落到数未 grounded 的边", () => {
    // 这是 `int(stats.get("inferred_edges") or sum(...))` 的分叉点：JS 里
    // `0 || x` 也走 fallback，但 `[] || x` 不走 —— 所以真值判断必须是 Python 的。
    const flow = {
      nodes: [],
      edges: [{ grounded: true }, { grounded: false }, {}],
      stats: { inferred_edges: 0 },
    };
    expect(flowProvenance(flow)["inferred_edges"]).toBe(2);
    const flow2 = { ...flow, stats: { inferred_edges: 9 } };
    expect(flowProvenance(flow2)["inferred_edges"]).toBe(9);
  });

  it("nodes 里混进非对象 → 抛，不静默跳过", () => {
    // 静默跳过等于把「这份产物结构不对」吞掉，而汇总数字照样进交付包。
    expect(() => flowProvenance({ nodes: ["x"] })).toThrow(TypeError);
  });

  it("by_extractor：主名断言按 displayName → apiName → statement → text 取", () => {
    expect(
      oirProvenance({ objects: [{ apiName: { evidence: [{ extractor: "ocr" }] } }] })[
        "by_extractor"
      ],
    ).toEqual({ ocr: 1 });
    // displayName 存在就不再看 apiName —— 哪怕它的值是空的
    expect(
      oirProvenance({
        objects: [{ displayName: null, apiName: { evidence: [{ extractor: "ocr" }] } }],
      })["by_extractor"],
    ).toEqual({});
  });

  it("证据里缺 extractor 记成 llm", () => {
    expect(
      oirProvenance({ rules: [{ statement: { evidence: [{}, { extractor: "" }] } }] })[
        "by_extractor"
      ],
    ).toEqual({ llm: 2 });
  });
});

describe("bundleId", () => {
  for (const [i, v] of G.bundle_id.entries()) {
    it(`向量 ${i}（pv=${v.pv} rs=${JSON.stringify(v.rs)}）`, () => {
      expect(bundleId(v.files, v.pv, v.rs)).toBe(v.id);
    });
  }

  it("与文件顺序无关、随内容/版本/发布状态变", () => {
    const files = [
      { path: "oir.json", sha256: "aa" },
      { path: "flow.json", sha256: "bb" },
    ];
    const a = bundleId(files, "0.1.0");
    expect(a).toHaveLength(12);
    expect(bundleId([...files].reverse(), "0.1.0")).toBe(a);
    expect(bundleId([{ path: "oir.json", sha256: "cc" }, files[1]!], "0.1.0")).not.toBe(a);
    expect(bundleId(files, "0.2.0")).not.toBe(a);
    expect(bundleId(files, "0.1.0", "RELEASED")).not.toBe(bundleId(files, "0.1.0", "DRAFT"));
    // 空 release_state 保留旧纯函数的兼容行为（不进哈希）
    expect(bundleId(files, "0.1.0", "")).toBe(a);
  });

  it("排序按 code point —— 中文文件名不能按 UTF-16 排", () => {
    // JS 的默认 sort 比较 UTF-16 code unit，BMP 内与 code point 一致；这条
    // 用例连同 golden 的 cjk 向量一起钉住"两侧算出同一个版本戳"。
    const files = [{ path: "流程图.svg", sha256: "11" }, { path: "Zz.svg", sha256: "22" }];
    expect(bundleId(files, "0.1.0")).toBe(bundleId([...files].reverse(), "0.1.0"));
  });

  it("缺 sha256 记成空串，缺 path 直接抛", () => {
    expect(bundleId([{ path: "a" }], "v")).toBe(sha256Hex("v\na:").slice(0, 12));
    expect(() => bundleId([{ sha256: "x" }], "v")).toThrow(/KeyError/);
  });
});

describe("buildManifest / readmeText", () => {
  for (const c of G.manifest_cases) {
    it(`manifest 与 Python 逐字段一致（${c.label}）`, () => {
      const man = buildManifest({
        session: c.session,
        productVersion: "0.1.0",
        files: G.manifest_files,
        materials: G.manifest_materials,
        flow: c.flow,
        oir: c.oir,
        openQuestions: c.open_questions,
        generatedAt: 1723540123.4567,
        generatedAtIso: "2026-08-13T12:00:00Z",
      });
      expect(man).toEqual(c.manifest);
      // 键序也要一致：manifest.json 是要进包、要被 diff 的产物
      expect(pyJsonDumps(man, 2)).toBe(c.manifest_json);
    });

    it(`readme 与 Python 逐字节一致（${c.label}）`, () => {
      expect(readmeText(c.manifest)).toBe(c.readme);
    });
  }

  it("release_state：小写归一、非法值退回 DRAFT，且 DRAFT 有醒目警告", () => {
    const mk = (rs: unknown): Record<string, unknown> =>
      buildManifest({
        session: { id: "s", ...(rs === undefined ? {} : { release_state: rs }) },
        productVersion: "0.1.0",
        files: [],
        materials: [],
        flow: null,
        oir: null,
        openQuestions: [],
        generatedAt: 1.5,
      });
    expect(mk("released")["release_state"]).toBe("RELEASED");
    expect(mk("RELEASED")["release_state"]).toBe("RELEASED");
    expect(mk("BLOCKED")["release_state"]).toBe("DRAFT");
    expect(mk("")["release_state"]).toBe("DRAFT");
    expect(mk(undefined)["release_state"]).toBe("DRAFT");
    expect(readmeText(mk("released"))).toContain("发布状态：RELEASED");
    expect(readmeText(mk("released"))).not.toContain("不得视为正式发布版本");
    expect(readmeText(mk("BLOCKED"))).toContain("不得视为正式发布版本");
    // 同一批字节 DRAFT ≠ RELEASED —— 两个离线包不能共享一个版本戳
    expect(mk("released")["bundle_id"]).not.toBe(mk("BLOCKED")["bundle_id"]);
  });

  it("readme 标题回退链：project → title → id", () => {
    const base = {
      product_version: "v",
      bundle_id: "b",
      provenance_summary: { flow: flowProvenance(null), oir: oirProvenance(null) },
    };
    const t = (sess: Record<string, unknown>): string =>
      readmeText({ ...base, session: sess }).split("\n")[0]!;
    expect(t({ project: "P", title: "T", id: "i" })).toBe("# 交付包 · P");
    expect(t({ project: "", title: "T", id: "i" })).toBe("# 交付包 · T");
    expect(t({ id: "i" })).toBe("# 交付包 · i");
    expect(t({})).toBe("# 交付包 · ");
  });
});

describe("buildZip", () => {
  const z = G.zip;
  const entries: [string, Uint8Array][] = z.entries.map((e) => [
    e.name,
    new Uint8Array(Buffer.from(e.b64, "base64")),
  ]);
  const c = caseOf(z.manifest_case);
  const dt = z.date_time as unknown as ZipDateTime;

  it("容器形态 + 解压内容与 CPython zipfile 完全一致", () => {
    // **不比 deflate 流的字节**：CPython 是 zlib 1.2.12，Node 是打过 Chromium
    // 补丁的 1.3.1，同一输入产出的压缩流都合法但不同（见 bundle.ts 头部第 5 条）。
    // 除此之外的每一个字节都要对上 —— 头部字段写错的包，别的解压器打不开。
    const got = buildZip(entries, c.manifest, c.readme, { dateTime: dt });
    const want = new Uint8Array(Buffer.from(z.b64, "base64"));
    expect(parseZip(got)).toEqual(parseZip(want));
  });

  it("压缩流两侧不同是已知分叉，但内容完全一致", () => {
    const got = buildZip(entries, c.manifest, c.readme, { dateTime: dt });
    const want = new Uint8Array(Buffer.from(z.b64, "base64"));
    const a = parseZip(got);
    const b = parseZip(want);
    // 解压后一致（上一条已断言），而原始字节长度允许不同 —— 把这个事实钉住，
    // 免得后人看到长度不等以为打包坏了。
    expect(a.members.map((m) => m.contentB64)).toEqual(b.members.map((m) => m.contentB64));
    expect(got.length === want.length).toBe(false);
  });

  it("成员顺序：先给的 entries，再 manifest.json，最后 交付说明.md", () => {
    const got = buildZip(entries, c.manifest, c.readme, { dateTime: dt });
    expect(namelist(got)).toEqual(z.namelist);
  });

  it("同样的输入 + 同样的时间戳 → 同样的字节（可复现）", () => {
    const a = buildZip(entries, c.manifest, c.readme, { dateTime: dt });
    const b = buildZip(entries, c.manifest, c.readme, { dateTime: dt });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("不传 dateTime 时用当前本地时间 —— 与 Python 一致，也就是**不**确定", () => {
    // 这是 Python 原件的既定行为（zipfile.writestr 对 str 参数写 localtime），
    // 照实迁。产品要「同样输入同样字节」就得显式冻结 dateTime。
    const a = buildZip([["a.txt", "x"]], {}, "r", { dateTime: [2020, 1, 2, 3, 4, 5] });
    const b = buildZip([["a.txt", "x"]], {}, "r", { dateTime: [2021, 1, 2, 3, 4, 5] });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const now = buildZip([["a.txt", "x"]], {}, "r");
    expect(namelist(now)).toEqual(["a.txt", "manifest.json", "交付说明.md"]);
  });

  it("非 ASCII 成员名打 UTF-8 标志位，纯 ASCII 不打", () => {
    const blob = buildZip([["ascii.txt", "a"]], {}, "r", { dateTime: dt });
    const flags = localHeaderFlags(blob);
    expect(flags[0]).toBe(0); // ascii.txt
    expect(flags[1]).toBe(0); // manifest.json
    expect(flags[2]).toBe(0x800); // 交付说明.md
  });

  it("空成员也能进包", () => {
    const blob = buildZip([["空.bin", new Uint8Array(0)]], {}, "", { dateTime: dt });
    expect(namelist(blob)).toContain("空.bin");
  });
});

interface ParsedMember {
  name: string;
  localFlags: number;
  localMethod: number;
  localTime: number;
  localDate: number;
  crc: number;
  size: number;
  extraLen: number;
  createVersion: number;
  createSystem: number;
  extractVersion: number;
  centFlags: number;
  centMethod: number;
  centTime: number;
  centDate: number;
  centCrc: number;
  centSize: number;
  internalAttr: number;
  externalAttr: number;
  /** 解压后的成员内容。压缩流本身两侧不同，内容必须相同。 */
  contentB64: string;
}

/** 把 zip 解析成「除压缩流外的一切」。两侧的这份结构必须逐字段相等。 */
function parseZip(blob: Uint8Array): { count: number; members: ParsedMember[] } {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let eocd = blob.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("EOCD 没找到");
  const count = dv.getUint16(eocd + 10, true);
  expect(dv.getUint16(eocd + 8, true)).toBe(count); // 本盘数量 == 总数量
  expect(dv.getUint16(eocd + 4, true)).toBe(0);
  expect(dv.getUint16(eocd + 6, true)).toBe(0);
  expect(dv.getUint16(eocd + 20, true)).toBe(0); // 无注释
  const dec = new TextDecoder();
  const members: ParsedMember[] = [];
  let at = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(at, true)).toBe(0x02014b50);
    const nlen = dv.getUint16(at + 28, true);
    const elen = dv.getUint16(at + 30, true);
    const clen = dv.getUint16(at + 32, true);
    const name = dec.decode(blob.slice(at + 46, at + 46 + nlen));
    const off = dv.getUint32(at + 42, true);
    expect(dv.getUint32(off, true)).toBe(0x04034b50);
    const lnlen = dv.getUint16(off + 26, true);
    const lelen = dv.getUint16(off + 28, true);
    const csize = dv.getUint32(off + 18, true);
    const start = off + 30 + lnlen + lelen;
    const payload = blob.slice(start, start + csize);
    members.push({
      name,
      localFlags: dv.getUint16(off + 6, true),
      localMethod: dv.getUint16(off + 8, true),
      localTime: dv.getUint16(off + 10, true),
      localDate: dv.getUint16(off + 12, true),
      crc: dv.getUint32(off + 14, true),
      size: dv.getUint32(off + 22, true),
      extraLen: lelen,
      createVersion: blob[at + 4]!,
      createSystem: blob[at + 5]!,
      extractVersion: blob[at + 6]!,
      centFlags: dv.getUint16(at + 8, true),
      centMethod: dv.getUint16(at + 10, true),
      centTime: dv.getUint16(at + 12, true),
      centDate: dv.getUint16(at + 14, true),
      centCrc: dv.getUint32(at + 16, true),
      centSize: dv.getUint32(at + 24, true),
      internalAttr: dv.getUint16(at + 36, true),
      externalAttr: dv.getUint32(at + 38, true),
      contentB64: inflateRawSync(payload).toString("base64"),
    });
    at += 46 + nlen + elen + clen;
  }
  return { count, members };
}

/** 从 zip 尾部的中央目录读成员名 —— 只为断言，不做通用解析。 */
function namelist(blob: Uint8Array): string[] {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let eocd = blob.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("EOCD 没找到");
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const nlen = dv.getUint16(at + 28, true);
    const elen = dv.getUint16(at + 30, true);
    const clen = dv.getUint16(at + 32, true);
    out.push(dec.decode(blob.slice(at + 46, at + 46 + nlen)));
    at += 46 + nlen + elen + clen;
  }
  return out;
}

/** 依次读每个本地文件头的 flag bits。 */
function localHeaderFlags(blob: Uint8Array): number[] {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out: number[] = [];
  let at = 0;
  while (at + 30 <= blob.length && dv.getUint32(at, true) === 0x04034b50) {
    out.push(dv.getUint16(at + 6, true));
    const csize = dv.getUint32(at + 18, true);
    const nlen = dv.getUint16(at + 26, true);
    const elen = dv.getUint16(at + 28, true);
    at += 30 + nlen + elen + csize;
  }
  return out;
}
