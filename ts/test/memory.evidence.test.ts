/**
 * kernel/memory/{evidence,short_term} 的 golden 校验。
 *
 * golden 由 `tools/golden/memory_evidence.py` 从 Python 原件真跑出来（字节确定：
 * PYTHONHASHSEED ∈ {0,1,42,777,99999} 六次跑出同一份 shasum）。**期望值一个都不是
 * 手写的** —— 手写的是我对 Python 行为的猜测，golden 是它的事实。
 *
 * 正面钉住的语言分叉：
 *   1. `\d` / `\w` / `\b` / `\s` 在 Python 是 Unicode 语义，在 JS 不是；
 *   2. `[:n]` 与 `len()` 按码点，JS 的 `.slice` / `.length` 按 UTF-16 码元；
 *   3. `sorted(key=(str,int))` 按码点，JS 默认 `sort()` 按码元；
 *   4. f-string 里缺键写 `None`，JS 写 `undefined`；
 *   5. `json.dumps` 的默认分隔符是 `", "` / `": "`。
 *
 * 有一条**故意不比对顺序**：BM25 同分条目。见 `tie_nondeterminism` 一节 ——
 * Python 侧的顺序随 PYTHONHASHSEED 变，没有可对齐的目标。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  Chunk,
  EvidenceIndex,
  tokenize,
  type ByLocatorOptions,
  type SearchOptions,
} from "../src/kernel/memory/evidence.js";
import { pyJsonDumps } from "../src/kernel/journal.js";
import {
  Scratchpad,
  Turn,
  WorkingSet,
  extractLocators,
  heuristicSummary,
  type Digest,
} from "../src/kernel/memory/short_term.js";

// ── golden 的形状 ────────────────────────────────────────────────

/** 与 `tools/golden/memory_evidence.py` 里的 `Chunk(**d)` 同一份 kwargs（snake_case）。 */
interface ChunkRow {
  chunk_id: string;
  file_id: string;
  file_name: string;
  locator: Record<string, unknown>;
  render: string;
  order: number;
  tags?: string[];
  context?: string;
}

interface TurnRow {
  thought?: string;
  action?: string;
  observation?: string;
  compressed?: boolean;
}

interface TurnOut {
  thought: string;
  action: string;
  observation: string;
  compressed: boolean;
  tokens: number;
  render: string;
}

interface PadSnapshot {
  len: number;
  turns: TurnOut[];
  locators: string[];
  tokens: number;
  compactions: number;
  render: string;
  over_budget: { threshold: number; out: boolean }[];
  digest: { max_tokens: number; out: Digest }[];
}

interface Golden {
  tokenize: { in: string; out: string[] }[];
  chunks: ChunkRow[];
  dup_chunk: ChunkRow;
  chunk_meta: { chunk_id: string; cite: string; tokens: number }[];
  index_state: {
    len: number;
    ids: string[];
    doc_len: Record<string, number>;
    df: Record<string, number>;
    avg_len: number;
    postings: Record<string, string[]>;
    by_file: Record<string, string[]>;
    file_names: Record<string, string>;
    by_file_api: Record<string, string[]>;
    get: Record<string, string | null>;
  };
  search: {
    query: string;
    kwargs: Record<string, unknown>;
    ids: string[];
    cites: string[];
    tokens: number[];
  }[];
  rerank: Record<string, string[]>;
  by_locator: { kwargs: Record<string, unknown>; ids: string[] }[];
  render: { empty: string; one: string; many: string };
  tie_nondeterminism: { chunks: string[]; query: string; sorted_ids: string[] };
  short_term: {
    extract_locators: { in: string; out: string[] }[];
    turn: { init: TurnRow; out: TurnOut }[];
    heuristic_summary: { turns: TurnRow[]; out: string }[];
    scratchpad: {
      name: string;
      init: { budget_tokens?: number; keep_verbatim?: number };
      appends: TurnRow[];
      after_append: PadSnapshot;
      steps: { op: string; args: number[]; ret: boolean | number; snapshot: PadSnapshot }[];
    }[];
    working_set: {
      name: string;
      puts: [string, unknown, Record<string, unknown> | null][];
      outputs: Record<string, unknown>;
      digests: Record<string, Record<string, unknown>>;
      output_keys: string[];
      selects: { ids: string[]; out: Record<string, unknown>; keys: string[] }[];
      gets: { id: string; out: unknown; default: unknown }[];
      json: string;
      tokens: number;
    }[];
  };
}

const G: Golden = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "memory.evidence.json"), "utf8"),
) as Golden;

/** 照 golden 的 init 造一片 —— 两边必须是同一组入参，否则比的不是同一件事。 */
function makeChunk(row: ChunkRow): Chunk {
  return new Chunk({
    chunkId: row.chunk_id,
    fileId: row.file_id,
    fileName: row.file_name,
    locator: row.locator,
    render: row.render,
    order: row.order,
    tags: row.tags,
    context: row.context,
  });
}

function buildIndex(): EvidenceIndex {
  const ix = new EvidenceIndex();
  ix.addAll(G.chunks.map(makeChunk));
  ix.add(makeChunk(G.dup_chunk));
  return ix;
}

/** golden 的 kwargs 是 snake_case（Python 的关键字参数），TS 侧是 options 对象。 */
function toSearchOptions(kw: Record<string, unknown>): SearchOptions {
  const o: {
    topK?: number;
    files?: string[];
    kinds?: unknown[];
    tags?: string[];
    expand?: number;
    budgetTokens?: number;
    diversifyByFile?: boolean;
  } = {};
  if ("top_k" in kw) o.topK = kw["top_k"] as number;
  if ("files" in kw) o.files = kw["files"] as string[];
  if ("kinds" in kw) o.kinds = kw["kinds"] as unknown[];
  if ("tags" in kw) o.tags = kw["tags"] as string[];
  if ("expand" in kw) o.expand = kw["expand"] as number;
  if ("budget_tokens" in kw) o.budgetTokens = kw["budget_tokens"] as number;
  if ("diversify_by_file" in kw) o.diversifyByFile = kw["diversify_by_file"] as boolean;
  return o;
}

function toByLocatorOptions(kw: Record<string, unknown>): ByLocatorOptions {
  const o: { file?: string; container?: string; rows?: [number, number]; limit?: number } = {};
  if ("file" in kw) o.file = kw["file"] as string;
  if ("container" in kw) o.container = kw["container"] as string;
  if ("rows" in kw) o.rows = kw["rows"] as [number, number];
  if ("limit" in kw) o.limit = kw["limit"] as number;
  return o;
}

function ids(chunks: Chunk[]): string[] {
  return chunks.map((c) => c.chunkId);
}

/** 索引的内部状态：`private` 在 TS 里只是编译期约束，运行时照样读得到。
 * 建索引（去重、df、倒排、avg_len）是检索质量的地基，只比对外部结果的话，
 * 一个 df 算错要等到某个查询排序诡异时才被发现。 */
interface Internals {
  _len: Map<string, number>;
  _df: Map<string, number>;
  _avgLen: number;
  _postings: Map<string, string[]>;
  _byFile: Map<string, string[]>;
}
function peek(ix: EvidenceIndex): Internals {
  return ix as unknown as Internals;
}

function mapToObj<T>(m: Map<string, T>): Record<string, T> {
  return Object.fromEntries(m);
}

/** `String.prototype.isWellFormed` 要 ES2024 的 lib，这个仓库钉在 ES2023 —— 而
 * tsconfig 不是我这一 track 的文件，所以自己写一个：只要有落单的代理，说明某处
 * 按码元切了字符串。 */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = s.charCodeAt(i + 1);
      if (!(lo >= 0xdc00 && lo <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
//  tokenize
// ══════════════════════════════════════════════════════════════════
describe("tokenize", () => {
  it.each(G.tokenize.map((c, i) => [i, c.in] as const))("#%i %j", (i) => {
    const c = G.tokenize[i]!;
    expect(tokenize(c.in)).toEqual(c.out);
  });

  it("全角数字必须被认成数字 —— Python 的 \\d 是 Unicode Nd", () => {
    // 直译成 JS 的 `\d` 会让带全角数字的列名从此检索不到，且不报错。
    const full = G.tokenize.find((c) => c.in === "１２３")!;
    expect(full.out).toEqual(["１２３"]);
    expect(tokenize("１２３")).toEqual(full.out);
  });

  it("星平面汉字不在 [㐀-鿿] 内，整个丢掉", () => {
    expect(tokenize("\u{20000}")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Chunk：cite / tokens
// ══════════════════════════════════════════════════════════════════
describe("Chunk", () => {
  const ix = buildIndex();

  it.each(G.chunk_meta.map((m, i) => [i, m.chunk_id] as const))("cite/tokens #%i %s", (i) => {
    const m = G.chunk_meta[i]!;
    const c = ix.get(m.chunk_id)!;
    expect(c.cite()).toBe(m.cite);
    expect(c.tokens).toBe(m.tokens);
  });

  it("cell 缺 row/col 时写的是字面量 None，不是 undefined", () => {
    // 这串会进 prompt、进产物的出处标注；写成 undefined 就是"点回原文"点到
    // 一个 Python 时代从来没出现过的位置。
    expect(ix.get("f9:n0")!.cite()).toBe("openapi.json!!RNoneCNone");
  });

  it("tags 是复制的，locator/raw 保持引用", () => {
    const tags = ["a"];
    const loc = { kind: "cell" };
    const raw = { df: 1 };
    const c = new Chunk({
      chunkId: "x",
      fileId: "f",
      fileName: "n",
      locator: loc,
      render: "r",
      raw,
      tags,
    });
    tags.push("b");
    expect(c.tags).toEqual(["a"]);
    expect(c.locator).toBe(loc);
    expect(c.raw).toBe(raw);
  });
});

// ══════════════════════════════════════════════════════════════════
//  建索引
// ══════════════════════════════════════════════════════════════════
describe("EvidenceIndex.add", () => {
  const ix = buildIndex();
  const inner = peek(ix);
  const S = G.index_state;

  it("重复 chunk_id 被忽略，先写的赢", () => {
    expect(ix.size).toBe(S.len);
    expect(ids(ix.allChunks())).toEqual(S.ids);
    expect(ix.get("f3:c0")!.fileName).toBe("实体梳理.xlsx");
  });

  it("文档长度 / df / 倒排 / by_file 逐项对齐", () => {
    expect(mapToObj(inner._len)).toEqual(S.doc_len);
    expect(mapToObj(inner._df)).toEqual(S.df);
    expect(mapToObj(inner._postings)).toEqual(S.postings);
    expect(mapToObj(inner._byFile)).toEqual(S.by_file);
  });

  it("avg_len 逐位相等（增量求和对整数是精确的）", () => {
    expect(inner._avgLen).toBe(S.avg_len);
  });

  it("get / by_file / file_names", () => {
    for (const [cid, want] of Object.entries(S.get)) {
      expect(ix.get(cid)?.chunkId ?? null).toBe(want);
    }
    for (const [f, want] of Object.entries(S.by_file_api)) {
      expect(ids(ix.byFile(f))).toEqual(want);
    }
    expect(mapToObj(ix.fileNames())).toEqual(S.file_names);
  });

  it("空索引上检索直接返回空", () => {
    expect(new EvidenceIndex().search("采购")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  search
// ══════════════════════════════════════════════════════════════════
describe("EvidenceIndex.search", () => {
  const ix = buildIndex();

  it.each(G.search.map((c, i) => [i, c.query, JSON.stringify(c.kwargs)] as const))(
    "#%i %j %s",
    (i) => {
      const c = G.search[i]!;
      const hits = ix.search(c.query, toSearchOptions(c.kwargs));
      expect(ids(hits)).toEqual(c.ids);
      expect(hits.map((h) => h.cite())).toEqual(c.cites);
      expect(hits.map((h) => h.tokens)).toEqual(c.tokens);
    },
  );

  it("files= 过滤的是 file_id，不是文件名（commit 30db2d1 的事故点）", () => {
    // 真实事故：没有任何工具给过模型 file_id，它只看得到文件名 —— 一填 files
    // 就静默拿到空结果，然后据此断言"材料里没有"。行为本身没改（名字解析在
    // tools 层做），所以这里必须两个方向都钉住，免得有人"顺手"在这里改成按名字。
    expect(ids(ix.search("计划金额", { files: ["f3"], topK: 9, expand: 0 })).length).toBeGreaterThan(
      0,
    );
    expect(ix.search("计划金额", { files: ["实体梳理.xlsx"], topK: 9, expand: 0 })).toEqual([]);
    expect(ix.fileNames().get("实体梳理.xlsx")).toBe("f3");
  });

  it("files=[] 是全挡，files 不传才是不过滤", () => {
    expect(ix.search("计划金额", { files: [], topK: 9, expand: 0 })).toEqual([]);
    expect(ix.search("计划金额", { files: null, topK: 9, expand: 0 }).length).toBeGreaterThan(0);
    expect(ix.search("计划金额", { topK: 9, expand: 0 }).length).toBeGreaterThan(0);
  });

  it("budgetTokens=0 是一片都装不下，不是不限", () => {
    expect(ix.search("采购", { topK: 9, expand: 0, budgetTokens: 0 })).toEqual([]);
    expect(ix.search("采购", { topK: 9, expand: 0, budgetTokens: null }).length).toBeGreaterThan(0);
  });

  it("超预算的切片是跳过而不是截断，后面小的还能进来", () => {
    const hits = ix.search("采购", { topK: 9, expand: 0, budgetTokens: 8 });
    const all = ix.search("采购", { topK: 9, expand: 0 });
    expect(hits.length).toBeGreaterThan(0);
    // golden 里这一格的结果不是 all 的前缀 —— 证明走的是 continue 不是 break
    expect(ids(hits)).not.toEqual(ids(all).slice(0, hits.length));
  });

  it("rerank 在预算截断之前跑", () => {
    const rev = (_q: string, hits: Chunk[]): Chunk[] => [...hits].reverse();
    expect(ids(ix.search("计划金额", { topK: 3, expand: 0, rerank: rev }))).toEqual(
      G.rerank["reversed"],
    );
    expect(
      ids(ix.search("计划金额", { topK: 3, expand: 0, rerank: (_q, h) => h.slice(0, 1) })),
    ).toEqual(G.rerank["dropped"]);
    expect(ids(ix.search("采购", { topK: 9, expand: 0, budgetTokens: 8, rerank: rev }))).toEqual(
      G.rerank["before_budget"],
    );
  });

  it("同分顺序：Python 侧不确定，TS 侧必须确定", () => {
    // `sorted(scores, key=-score)` 稳定 → 同分保持 scores 插入序 → 那个插入序来自
    // 遍历一个 set → 随 PYTHONHASHSEED 变（实测 5 个种子 5 种顺序）。所以这里
    // 只能比集合；能比的是"TS 自己每次都一样"，而这正是产物 diff 不带噪声的前提。
    const T = G.tie_nondeterminism;
    const build = (): EvidenceIndex => {
      const tie = new EvidenceIndex();
      T.chunks.forEach((n, i) => {
        tie.add(
          new Chunk({
            chunkId: n,
            fileId: "f",
            fileName: "x",
            locator: {},
            render: "采购 合同",
            order: i,
          }),
        );
      });
      return tie;
    };
    const run = (): string[] =>
      ids(build().search(T.query, { topK: 8, expand: 0, diversifyByFile: false }));
    const first = run();
    expect([...first].sort()).toEqual(T.sorted_ids);
    for (let i = 0; i < 5; i++) expect(run()).toEqual(first);
    // 倒排遍历序 = 建索引的插入序（查询词的两个 token 命中的是同一批切片）
    expect(first).toEqual(T.chunks);
  });
});

// ══════════════════════════════════════════════════════════════════
//  by_locator / render
// ══════════════════════════════════════════════════════════════════
describe("EvidenceIndex.byLocator", () => {
  const ix = buildIndex();

  it.each(G.by_locator.map((c, i) => [i, JSON.stringify(c.kwargs)] as const))("#%i %s", (i) => {
    const c = G.by_locator[i]!;
    expect(ids(ix.byLocator(toByLocatorOptions(c.kwargs)))).toEqual(c.ids);
  });

  it("排序基准是码点：\\uFFFF.xlsx 排在 😀.xlsx 前面", () => {
    // U+FFFF(65535) < U+1F600(128512) → 码点序把 ￿ 排前面；
    // 而 😀 的 UTF-16 高位代理是 D83D(55357) < FFFF → JS 默认 sort 会反过来。
    // 这条一开始被我写反了，是 golden 把它按回去的 —— 手写期望值就是这么来的。
    const got = ix.byLocator({ rows: [1, 2] });
    expect(got.map((c) => c.fileName)).toEqual(["￿.xlsx", "\u{1F600}.xlsx"]);
    expect([...got].sort((a, b) => (a.fileName < b.fileName ? -1 : 1)).map((c) => c.fileName)) //
      .toEqual(["\u{1F600}.xlsx", "￿.xlsx"]);
  });

  it("row=0 是假值 → 那一片按行号永远捞不出来", () => {
    expect(ix.byLocator({ rows: [0, 0] })).toEqual([]);
  });
});

describe("EvidenceIndex.render", () => {
  const ix = buildIndex();
  it("每片都带引用", () => {
    expect(EvidenceIndex.render([])).toBe(G.render.empty);
    expect(EvidenceIndex.render(ix.byFile("f5").slice(0, 1))).toBe(G.render.one);
    expect(EvidenceIndex.render(ix.byFile("f3"))).toBe(G.render.many);
  });
});

// ══════════════════════════════════════════════════════════════════
//  short_term：extract_locators
// ══════════════════════════════════════════════════════════════════
describe("extractLocators", () => {
  const cases = G.short_term.extract_locators;

  it.each(cases.map((c, i) => [i, c.in] as const))("#%i %j", (i) => {
    expect(extractLocators(cases[i]!.in)).toEqual(cases[i]!.out);
  });

  it("\\b 是 Unicode 语义：汉字紧邻时不算词边界", () => {
    // JS 原生的 \b 只认 ASCII，会在 见/f 之间判出边界 → 凭空抓出一个 locator，
    // 而凭空抓出来的 locator 会被 pin 住并进 prompt，看着像有出处其实没有。
    expect(extractLocators("见f3:sheet0")).toEqual([]);
    expect(extractLocators("见R44C6")).toEqual([]);
    expect(extractLocators(" f3:sheet0")).toEqual(["f3:sheet0"]);
  });

  it("\\d 是 Unicode Nd：全角行列号照样认", () => {
    expect(extractLocators("R４４C６")).toEqual(["R４４C６"]);
  });

  it("\\s 按 Python 的 29 个空白字符切，不是 JS 的那一套", () => {
    // \x85 / \x1c 只有 Python 认（要断开），﻿ 只有 JS 认（不能断开）
    expect(extractLocators("a.xlsx!S\x85尾")).toEqual(["a.xlsx!S"]);
    expect(extractLocators("a.xlsx!S\x1c尾")).toEqual(["a.xlsx!S"]);
    expect(extractLocators("a.xlsx!S﻿尾")).toEqual(["a.xlsx!S﻿尾"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  short_term：Turn / heuristicSummary
// ══════════════════════════════════════════════════════════════════
function makeTurn(row: TurnRow): Turn {
  return new Turn({
    thought: row.thought,
    action: row.action,
    observation: row.observation,
    compressed: row.compressed,
  });
}

function turnOut(t: Turn): TurnOut {
  return {
    thought: t.thought,
    action: t.action,
    observation: t.observation,
    compressed: t.compressed,
    tokens: t.tokens,
    render: t.render(),
  };
}

describe("Turn", () => {
  it.each(G.short_term.turn.map((c, i) => [i, JSON.stringify(c.init)] as const))("#%i %s", (i) => {
    const c = G.short_term.turn[i]!;
    expect(turnOut(makeTurn(c.init))).toEqual(c.out);
  });
});

describe("heuristicSummary", () => {
  it.each(G.short_term.heuristic_summary.map((c, i) => [i, c.turns.length] as const))(
    "#%i（%i 轮）",
    (i) => {
      const c = G.short_term.heuristic_summary[i]!;
      expect(heuristicSummary(c.turns.map(makeTurn))).toBe(c.out);
    },
  );

  it("观察的 [:80] 按码点切，不会切出半个 emoji", () => {
    const out = heuristicSummary([new Turn({ action: "a", observation: "\u{1F600}".repeat(100) })]);
    expect(out).toContain("\u{1F600}".repeat(80));
    expect(out).not.toContain("\u{1F600}".repeat(81));
    // 半个代理对会让这串不是 well-formed，落到 JSON / 日志里就是 U+FFFD
    expect(isWellFormed(out)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  short_term：Scratchpad
// ══════════════════════════════════════════════════════════════════
function padSnapshot(pad: Scratchpad, digestMaxTokens: number[]): PadSnapshot {
  return {
    len: pad.size,
    turns: pad.turns.map(turnOut),
    locators: pad.locators,
    tokens: pad.tokens,
    compactions: pad.compactions,
    render: pad.render(),
    over_budget: [0.0, 0.5, 0.7, 1.0, 2.0].map((threshold) => ({
      threshold,
      out: pad.overBudget(threshold),
    })),
    digest: digestMaxTokens.map((max_tokens) => ({ max_tokens, out: pad.digest(max_tokens) })),
  };
}

function buildPad(sc: Golden["short_term"]["scratchpad"][number]): Scratchpad {
  const opts: { budgetTokens?: number; keepVerbatim?: number } = {};
  if (sc.init.budget_tokens !== undefined) opts.budgetTokens = sc.init.budget_tokens;
  if (sc.init.keep_verbatim !== undefined) opts.keepVerbatim = sc.init.keep_verbatim;
  const pad = new Scratchpad(opts);
  for (const a of sc.appends) pad.append(a.thought ?? "", a.action ?? "", a.observation ?? "");
  return pad;
}

describe("Scratchpad", () => {
  const scenarios = G.short_term.scratchpad;

  it.each(scenarios.map((s, i) => [i, s.name] as const))("#%i %s", (i) => {
    const sc = scenarios[i]!;
    const maxes = sc.after_append.digest.map((d) => d.max_tokens);

    expect(padSnapshot(buildPad(sc), maxes)).toEqual(sc.after_append);

    const pad = buildPad(sc);
    for (const step of sc.steps) {
      const ret =
        step.op === "compact"
          ? pad.compact()
          : step.op === "compact_to_fit"
            ? pad.compactToFit(step.args[0])
            : (() => {
                throw new Error(`golden 里出现了没实现的 op: ${step.op}`);
              })();
      expect(ret).toBe(step.ret);
      expect(padSnapshot(pad, step.snapshot.digest.map((d) => d.max_tokens))).toEqual(
        step.snapshot,
      );
    }
  });

  it("压缩后 locator 一条不少 —— 溯源是这个产品的信任基础", () => {
    const sc = scenarios[0]!;
    const pad = buildPad(sc);
    const before = new Set(pad.locators);
    expect(before.size).toBeGreaterThanOrEqual(12);
    pad.compactToFit();
    expect(pad.compactions).toBeGreaterThan(0);
    expect(new Set(pad.locators)).toEqual(before);
    expect(pad.render()).toContain("R44C6");
  });

  it("digest 是唯一跨节点的东西，且截断按码点", () => {
    const pad = new Scratchpad();
    for (let i = 0; i < 20; i++) pad.append("想".repeat(200), `act${i}`, "见".repeat(200));
    const d = pad.digest(200);
    expect(d.turns).toBe(20);
    expect(d.locators).toEqual([]);
    expect(isWellFormed(d.summary)).toBe(true);
    expect(Object.keys(d)).toEqual(["turns", "summary", "locators", "compactions"]);
  });

  it("自定义 summarizer 拿到的是要压掉的那几轮", () => {
    const seen: number[] = [];
    const pad = new Scratchpad({
      budgetTokens: 10,
      keepVerbatim: 2,
      summarizer: (turns) => {
        seen.push(turns.length);
        return "S";
      },
    });
    for (let i = 0; i < 5; i++) pad.append(`t${i}`);
    expect(pad.compact()).toBe(true);
    expect(seen).toEqual([3]);
    expect(pad.turns[0]!.observation).toBe("S");
    expect(pad.turns[0]!.compressed).toBe(true);
    expect(pad.turns.map((t) => t.thought)).toEqual(["", "t3", "t4"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  short_term：WorkingSet
// ══════════════════════════════════════════════════════════════════
describe("WorkingSet", () => {
  const cases = G.short_term.working_set;

  it.each(cases.map((c, i) => [i, c.name] as const))("#%i %s", (i) => {
    const c = cases[i]!;
    const ws = new WorkingSet();
    for (const [nid, output, digest] of c.puts) ws.put(nid, output, digest);

    expect(ws.outputs).toEqual(c.outputs);
    expect(Object.keys(ws.outputs)).toEqual(c.output_keys);
    expect(ws.digests).toEqual(c.digests);
    for (const s of c.selects) {
      expect(ws.select(s.ids)).toEqual(s.out);
      expect(Object.keys(ws.select(s.ids))).toEqual(s.keys);
    }
    for (const g of c.gets) {
      expect(ws.get(g.id)).toEqual(g.out ?? null);
      expect(ws.get(g.id, "缺省")).toEqual(g.default);
    }
  });

  it("tokens 走 Python 的 json.dumps（分隔符 \", \" / \": \"）", () => {
    // 用 JSON.stringify 会少掉每个键值对的两个空格 —— 一份几百个键的产出能差出
    // 上百 token，而这个数直接决定 context 装配要不要裁掉 working set。
    for (const c of cases) {
      if (c.name.includes("已知分叉")) continue;
      const ws = new WorkingSet();
      for (const [nid, output, digest] of c.puts) ws.put(nid, output, digest);
      expect(pyJsonDumps(ws.outputs, { defaultStr: true })).toBe(c.json);
      expect(ws.tokens).toBe(c.tokens);
    }
  });

  it("已知分叉：整数值的 float 在 JS 里写不出 1.0", () => {
    // Python `json.dumps({"x": 1.0})` → `{"x": 1.0}`，JS 里 1 与 1.0 是同一个值。
    // 差两个字符 → est_tokens 可能差 1。不绕过，钉在这里（与 journal.ts 同一条）。
    const c = cases.find((x) => x.name.includes("已知分叉"))!;
    const ws = new WorkingSet();
    for (const [nid, output, digest] of c.puts) ws.put(nid, output, digest);
    expect(c.json).toBe('{"A": {"x": 1.0}}'); // 17 字符
    expect(pyJsonDumps(ws.outputs, { defaultStr: true })).toBe('{"A": {"x": 1}}'); // 15 字符
    // 差两个字符正好跨过一个 `// 4` 的台阶：Python 记 4 token，TS 记 3。
    expect(c.tokens).toBe(4);
    expect(ws.tokens).toBe(3);
  });

  it("digest 为假值时不写 digests", () => {
    const ws = new WorkingSet();
    ws.put("A", 1);
    ws.put("B", 2, {});
    ws.put("C", 3, null);
    expect(ws.digests).toEqual({});
  });
});
