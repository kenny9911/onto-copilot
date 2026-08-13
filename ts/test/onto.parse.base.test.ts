/**
 * onto/parse 的 base + text + api + sql 四个文件的 golden 校验。
 *
 * 期望值**一个都不是手写的**：`golden/onto.parse.json` 由
 * `tools/golden/onto_parse.py` 直接跑 Python 原件导出（重跑两次 shasum 一致）。
 * 手写的期望值是"我以为 Python 是这么干的"，golden 是"Python 就是这么干的"。
 *
 * 四段的测法不同，理由也不同：
 *
 * · base / text —— 直接跑 TS 实现，逐份 ParsedDoc 与 golden 比。
 * · docx     —— golden 里成对导了 python-docx 抽出来的**原料**和最终 ParsedDoc。
 *   TS 侧吃原料、产 ParsedDoc，中间那段切段逻辑因此是真的被覆盖到的
 *   （抽取本身在 sidecar，不是这一层的事）。
 * · sql      —— golden 里的 `wire` 就是 sidecar `/sql/parse` 真返回的 dict，
 *   喂给一个假客户端即可覆盖整条接回路径，不必起进程。
 *
 * 末尾 "已知分叉" 一节钉的是 Python 与 JS 语言边界上的差（`1.0` 的序列化、
 * JSON 报错文本）。**钉住而不是跳过** —— 跳过的用例哪天真的坏了不会有人知道。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SidecarClient } from "../src/sidecar/client.js";
import type { Chunk, ParsedDoc } from "../src/onto/parse/base.js";
import {
  ParserRegistry,
  contentFileId,
  cpLen,
  cpSlice,
  docStats,
  makeChunk,
  readTextGuess,
} from "../src/onto/parse/base.js";
import { OpenApiParser, pyJsonDumps, pyStr } from "../src/onto/parse/api.js";
import type { DocxContent } from "../src/onto/parse/text.js";
import {
  DocxParser,
  RULE_HINTS,
  TextParser,
  headingLevel,
  headingOf,
  isHeading,
  parseDocxContent,
  splitSections,
} from "../src/onto/parse/text.js";
import type { SqlParseClient } from "../src/onto/parse/sql.js";
import { DdlParser, adoptWireDoc } from "../src/onto/parse/sql.js";

// ── golden ────────────────────────────────────────────────────────
interface DocDict {
  file_id: string;
  file_name: string;
  kind: string;
  chunks: Record<string, unknown>[];
  structured: Record<string, unknown>;
  findings: Record<string, unknown>[];
  meta: Record<string, unknown>;
  stats: Record<string, unknown>;
}
interface Golden {
  base: {
    content_file_id: { name: string; bytes_b64: string | null; file_id: string }[];
    make_chunk: { in: Record<string, unknown>; out: Record<string, unknown> }[];
    stats: { structured: Record<string, unknown>; out: Record<string, unknown> }[];
    dispatch: { name: string; kind: string }[];
    no_parser_message: { ascii: string; cjk: string };
  };
  text: {
    rule_hints: { s: string; hit: boolean }[];
    is_heading: { style: string | null; text: string; out: boolean }[];
    heading_level: { style: string | null; text: string; out: number }[];
    heading_of: { block: string; out: string }[];
    split_sections: { text: string; out: string[] }[];
    read_text: { bytes_b64: string; text: string; encoding: string }[];
    docs: { name: string; bytes_b64: string; file_id: string; doc: DocDict }[];
  };
  docx: { name: string; file_id: string; content: DocxContent; doc: DocDict }[];
  api: { name: string; text: string; file_id: string; doc: DocDict }[];
  sql: {
    name: string;
    sql: string;
    dialect: string | null;
    file_id: string;
    file_name: string;
    wire: Record<string, unknown>;
    doc: DocDict;
  }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/onto.parse.json"), "utf8"),
) as Golden;

/** ParsedDoc → golden 的 dict 形态。`stats` 是方法算出来的，单独补上。 */
function toDict(doc: ParsedDoc): Record<string, unknown> {
  return {
    file_id: doc.file_id,
    file_name: doc.file_name,
    kind: doc.kind,
    chunks: doc.chunks.map((c: Chunk) => ({ ...c, tags: [...c.tags] })),
    structured: doc.structured,
    findings: doc.findings.map((f) => ({ ...f })),
    meta: doc.meta,
    stats: docStats(doc),
  };
}

let TMP = "";
beforeAll(async () => {
  TMP = await mkdtemp(join(tmpdir(), "onto-parse-"));
});
afterAll(async () => {
  if (TMP) await rm(TMP, { recursive: true, force: true });
});

/** 写进临时目录。`sub` 用来让**文件名与 golden 一致** —— file_name 会进
 *  ParsedDoc、进每个切片、进 endpoints 的每一条，加前缀就对不上了。 */
async function write(name: string, b64: string, sub = ""): Promise<string> {
  const dir = sub ? join(TMP, sub) : TMP;
  if (sub) await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, Buffer.from(b64, "base64"));
  return p;
}

// 只为 dispatch / 构造用，永远不会被调用到网络那一步
const NULL_SQL_CLIENT: SqlParseClient = {
  parseSql: () => Promise.reject(new Error("测试里不该真调 sidecar")),
};
const NULL_DOCX: DocxContent = {
  paragraphs: [],
  tables: [],
  core: { creator: null, last_modified_by: null, modified: null, title: null },
};

// ══════════════════════════════════════════════════════════════════
describe("base", () => {
  it("content_file_id 按内容寻址，读不到内容才退回文件名", async () => {
    for (const c of G.base.content_file_id) {
      const p = join(TMP, c.name);
      if (c.bytes_b64 === null) await mkdir(p, { recursive: true });
      else await writeFile(p, Buffer.from(c.bytes_b64, "base64"));
      expect(await contentFileId(p)).toBe(c.file_id);
    }
  });

  it("make_chunk 的字段布局", () => {
    for (const c of G.base.make_chunk) {
      const i = c.in;
      expect({
        ...makeChunk({
          docId: i["doc_id"] as string,
          fileId: i["file_id"] as string,
          fileName: i["file_name"] as string,
          locator: i["locator"] as Record<string, unknown>,
          render: i["render"] as string,
          raw: i["raw"],
          order: (i["order"] as number | undefined) ?? 0,
          tags: (i["tags"] as string[] | undefined) ?? [],
        }),
      }).toEqual(c.out);
    }
  });

  it("stats：list/dict 取长度，str/数字/None 原样，raw 排除在外", () => {
    for (const c of G.base.stats) {
      const doc: ParsedDoc = {
        file_id: "f_x",
        file_name: "x.json",
        kind: "openapi",
        chunks: [
          makeChunk({ docId: "s0", fileId: "f_x", fileName: "x.json", locator: {}, render: "a" }),
        ],
        findings: [{ kind: "k", message: "m", locator: {}, severity: "info" }],
        structured: c.structured,
        meta: {},
      };
      expect(docStats(doc)).toEqual(c.out);
    }
  });

  it("注册表按扩展名派发，未知扩展名落到兜底解析器", () => {
    const reg = new ParserRegistry()
      .register(new DdlParser(NULL_SQL_CLIENT))
      .register(new OpenApiParser())
      .register(new DocxParser(() => Promise.resolve(NULL_DOCX)))
      .register(new TextParser(), { fallback: true });
    for (const c of G.base.dispatch) {
      expect([c.name, reg.forPath(c.name).kind]).toEqual([c.name, c.kind]);
    }
  });

  it("没有兜底解析器时的报错消息（含 !r 的非 ASCII 后缀）", () => {
    const bare = new ParserRegistry().register(new DdlParser(NULL_SQL_CLIENT));
    expect(() => bare.forPath("a.xyz")).toThrow(G.base.no_parser_message.ascii);
    expect(() => bare.forPath("a.中文")).toThrow(G.base.no_parser_message.cjk);
  });

  it("parse 前先判存在，不存在抛 FileNotFound", async () => {
    const reg = new ParserRegistry().register(new TextParser(), { fallback: true });
    await expect(reg.parse(join(TMP, "根本没有这个文件.md"))).rejects.toThrow("根本没有这个文件.md");
  });

  it("readTextGuess：合法 UTF-8 恒报 utf-8（BOM 被剥掉），latin-1 一定兜得住", async () => {
    const p1 = await write("guess-bom.txt", Buffer.from("﻿hi", "utf8").toString("base64"));
    expect(await readTextGuess(p1)).toEqual(["hi", "utf-8"]);
    // 0x80–0x9f 这 32 个字节是 latin-1 与 windows-1252 的分水岭：
    // TextDecoder("iso-8859-1") 会给出 €‚ƒ，Python 的 latin-1 给 U+0080–U+009F
    const p2 = await write("guess-latin.bin", Buffer.from([0x80, 0x9f, 0xff]).toString("base64"));
    expect(await readTextGuess(p2)).toEqual(["ÿ", "latin-1"]);
  });

  it("readTextGuess：编码猜测逐字节向量（选错编码 = 后面全部文本都错）", async () => {
    for (const [i, c] of G.text.read_text.entries()) {
      const p = await write(`enc${i}.bin`, c.bytes_b64, "enc");
      const [text, enc] = await readTextGuess(p);
      // 逐字节向量：Node 的 ICU 与 CPython 的 codec 在这 12 条上完全一致，
      // 包括 GBK 用户自定义区（a140 → U+E4C6）和四字节形式。
      expect([i, text, enc]).toEqual([i, c.text, c.encoding]);
    }
  });

  it("cpLen / cpSlice 按码点，不按 UTF-16 码元", () => {
    expect(cpLen("🙂a")).toBe(2);
    expect(cpSlice("🙂🙂🙂", 0, 2)).toBe("🙂🙂");
  });
});

// ══════════════════════════════════════════════════════════════════
describe("text", () => {
  it("规则句线索（含把 \\b 换成 Unicode 词边界的那几条反例）", () => {
    for (const c of G.text.rule_hints) {
      expect([c.s, RULE_HINTS.test(c.s)]).toEqual([c.s, c.hit]);
    }
  });

  it("标题判定", () => {
    for (const c of G.text.is_heading) {
      expect([c.text, isHeading(c.style, c.text)]).toEqual([c.text, c.out]);
    }
  });

  it("标题层级（全角数字的 int() 也要给对）", () => {
    for (const c of G.text.heading_level) {
      expect([c.text, headingLevel(c.style, c.text)]).toEqual([c.text, c.out]);
    }
  });

  it("切段：软上限、句号回切、CRLF 与冷门分隔符、代理对下标", () => {
    for (const c of G.text.split_sections) {
      expect(splitSections(c.text)).toEqual(c.out);
    }
  });

  it("块首标题（first[:60] 按码点切）", () => {
    for (const c of G.text.heading_of) {
      expect(headingOf(c.block)).toEqual(c.out);
    }
  });

  it("TextParser：五份材料（utf-8 / gbk / BOM / latin-1 / emoji）", async () => {
    for (const c of G.text.docs) {
      const p = await write(c.name, c.bytes_b64);
      const doc = await new TextParser().parse(p, { fileId: c.file_id });
      expect(toDict(doc)).toEqual(c.doc);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
describe("docx", () => {
  it("原料 → ParsedDoc（面包屑、软上限、表格、元数据泄漏）", () => {
    for (const c of G.docx) {
      const doc = parseDocxContent(c.content, {
        fileId: c.file_id,
        fileName: c.name.split("/").pop() as string,
      });
      expect(toDict(doc)).toEqual(c.doc);
    }
  });

  it("DocxParser 把抽取器的产出交给同一段逻辑", async () => {
    const c = G.docx[0] as (typeof G.docx)[number];
    const parser = new DocxParser(() => Promise.resolve(c.content));
    const doc = await parser.parse(join(TMP, c.name), { fileId: c.file_id });
    expect(toDict(doc)).toEqual(c.doc);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("api", () => {
  /** 两处**已知分叉**（见文件头）：坏 JSON 的异常文本、Python 的 float `1.0`。
   *  这里只把这两处替换成 golden 的值，其余全部逐字比 —— 分叉的确切形状由下面
   *  "已知分叉" 那一节单独钉住。 */
  function normalize(actual: Record<string, unknown>, expected: DocDict): Record<string, unknown> {
    const findings = (actual["findings"] as Record<string, unknown>[]).map((f, i) => {
      const exp = expected.findings[i];
      if (f["kind"] !== "parse_failed" || exp === undefined) return f;
      const em = exp["message"] as string;
      const am = f["message"] as string;
      const head = "既不是合法 JSON 也读不成 YAML：";
      return am.startsWith(head) && em.startsWith(head) ? { ...f, message: em } : f;
    });
    return { ...actual, findings };
  }

  it("OpenAPI / 普通 JSON / 顶层不是对象 / 坏 JSON", async () => {
    for (const [i, c] of G.api.entries()) {
      const p = await write(
        c.name.split("/").pop() as string,
        Buffer.from(c.text, "utf8").toString("base64"),
        `api${i}`,
      );
      const doc = await new OpenApiParser().parse(p, { fileId: c.file_id });
      const got = normalize(toDict(doc), c.doc);
      if (c.name === "plain.json") {
        // 1.0 那一条留到下面单独钉
        const skip = (d: Record<string, unknown>): Record<string, unknown> => ({
          ...d,
          chunks: (d["chunks"] as Record<string, unknown>[]).filter(
            (ch) => ch["chunk_id"] !== `${c.file_id}:k2`,
          ),
        });
        expect(skip(got)).toEqual(skip(c.doc as unknown as Record<string, unknown>));
        continue;
      }
      expect(got).toEqual(c.doc);
    }
  });

  it("pyStr / pyJsonDumps 的分隔符与 True/False/None", () => {
    expect(pyStr(true)).toBe("True");
    expect(pyStr(null)).toBe("None");
    expect(pyJsonDumps({ a: [1, "甲"], b: null })).toBe('{"a": [1, "甲"], "b": null}');
  });
});

// ══════════════════════════════════════════════════════════════════
describe("sql", () => {
  // 编译期断言：真正的 SidecarClient 必须满足 DdlParser 要的那一小片接口。
  // 哪天 client.ts 改了 parseSql 的签名，这一行先红。
  type AssertClient = SidecarClient extends SqlParseClient ? true : never;
  const assertClient: AssertClient = true;

  it("SidecarClient 结构上就是 SqlParseClient", () => {
    expect(assertClient).toBe(true);
  });

  it("wire → ParsedDoc：chunk_id 重新加前缀、补回 file_id/file_name", () => {
    for (const c of G.sql) {
      const doc = adoptWireDoc(c.wire as never, {
        fileId: c.file_id,
        fileName: c.file_name,
      });
      expect(toDict(doc)).toEqual(c.doc);
    }
  });

  it("DdlParser 把文件内容原样交给 sidecar，方言跟着走", async () => {
    for (const [i, c] of G.sql.entries()) {
      const p = await write(c.file_name, Buffer.from(c.sql, "utf8").toString("base64"), `ddl${i}`);
      const seen: { sql: string; opts: { dialect?: string; fileName?: string } }[] = [];
      const client: SqlParseClient = {
        parseSql: (sql, opts) => {
          seen.push({ sql, opts });
          return Promise.resolve(c.wire);
        },
      };
      const doc = await new DdlParser(client, c.dialect).parse(p, { fileId: c.file_id });
      // 文件内容原样、方言原样、文件名取的是 basename（sidecar 那边靠它做 file_name）
      expect(seen).toEqual([
        { sql: c.sql, opts: { dialect: c.dialect ?? "", fileName: c.file_name } },
      ]);
      expect(toDict(doc)).toEqual(c.doc);
    }
  });

  it("形状漂移要响，不许静默变成空文档", () => {
    expect(() =>
      adoptWireDoc({ file_id: "sidecar", file_name: "a.ddl", kind: "ddl", structured: {} } as never, {
        fileId: "f_x",
        fileName: "a.ddl",
      }),
    ).toThrow("chunks / findings 不是数组");
  });

  it("不同文件的切片 id 不会互相顶掉（sidecar 侧 file_id 恒为 sidecar）", () => {
    const wire = G.sql[0]?.wire as never;
    const a = adoptWireDoc(wire, { fileId: "f_aaa", fileName: "a.ddl" });
    const b = adoptWireDoc(wire, { fileId: "f_bbb", fileName: "b.ddl" });
    const ids = new Set([...a.chunks, ...b.chunks].map((c) => c.chunk_id));
    expect(ids.size).toBe(a.chunks.length + b.chunks.length);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("已知分叉（钉住，不绕过）", () => {
  it("Python 的 float 1.0 序列化成 '1.0'，JS 只能给 '1'", () => {
    const c = G.api.find((x) => x.name === "plain.json");
    const golden = c?.doc.chunks.find((ch) => ch["chunk_id"] === `${c.file_id}:k2`);
    expect(golden?.["render"]).toBe('嵌套: {"a": 1.0, "b": null, "c": true}');
    // JS 里 1 与 1.0 是同一个值，无从区分 —— 与 ids.ts 文件头钉的是同一条边界
    expect(`嵌套: ${pyJsonDumps({ a: 1.0, b: null, c: true })}`).toBe(
      '嵌套: {"a": 1, "b": null, "c": true}',
    );
  });

  it("坏 JSON 的 finding：kind/severity/前半句一致，异常文本必然不同", () => {
    const c = G.api.find((x) => x.name === "broken.json");
    const f = c?.doc.findings[0];
    expect(f?.["kind"]).toBe("parse_failed");
    expect(f?.["severity"]).toBe("warn");
    expect(f?.["message"]).toContain("既不是合法 JSON 也读不成 YAML：");
    // CPython 的 JSONDecodeError 文本；V8 的措辞完全不同，逐字对齐要手写一个
    // CPython 兼容的 JSON 解析器，不值当
    expect(f?.["message"]).toContain("Expecting property name enclosed in double quotes");
  });
});
