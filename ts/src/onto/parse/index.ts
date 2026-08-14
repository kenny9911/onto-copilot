/**
 * 材料解析层的**装配处** —— 异构文件 → 统一 Chunk。移植自 `onto/parse/__init__.py`。
 *
 * 用法::
 *
 *     const reg = defaultRegistry();
 *     const docs = await reg.parseAll(["实体梳理.xlsx", "schema.ddl", "openapi.json"]);
 *     const index = buildIndex(docs);   // 灌进证据索引，抽取节点就能检索了
 *
 * 派发按扩展名，未知扩展名回退到纯文本解析器 —— **绝不静默跳过**。跳过一份材料
 * 而不告诉任何人，是这类系统最阴的失败模式：产物看起来正常，只是少了一整个来源。
 *
 * ── 与 Python 的三处差异（都是被下层的既成设计逼出来的，不是我的发挥）──────
 *
 * 1. **`DdlParser` 与 `DocxParser` 要注入依赖。** Python 侧它们各自直接 import
 *    `sqlglot` / `python-docx`；TS 侧 sqlglot 是契约 §2.3 三个不迁的钉子之一，
 *    真身在 sidecar，而 `DocxParser` 按 `text.ts` 的设计**不给默认抽取器**。
 *    所以这里给：DDL 默认懒建 sidecar 客户端（`/sql/parse` 是现成的），
 *    docx 默认给一个**会抛的**抽取器 —— sidecar 目前没有 docx 端点，与其让
 *    一份 .docx 落到兜底的 TextParser 里被当二进制读成乱码（那是"内容悄悄没了"
 *    的另一种形态），不如在解析当场把缺的那根线说出来。
 * 2. **`buildIndex` 要转一次形状。** Python 侧 `parse/base.py` 的 `Chunk` 就是
 *    `kernel/memory/evidence.py` 的那一个类；TS 侧两边分成了两种形状
 *    （解析层是 snake_case 的 interface，索引层是 camelCase 的 class），所以这里
 *    必须显式搬字段。`locator` / `raw` **不复制**，与 evidence 侧的注释同一条理由。
 * 3. **`collectProfiles` 的 `Path(...).stem` 要自己实现。** Node 的 `extname`
 *    在 `"trail."` 上给 `"."`，CPython 给 `""` —— 差一个尾点，键就从 `trail.` 变成
 *    `trail`，而这个键是 TYPE_MISMATCH 检测查表用的。golden 钉着这几个名字。
 */

import { basename } from "node:path";

import { KeyError } from "../../kernel/errors.js";
import { Chunk as EvidenceChunk, EvidenceIndex } from "../../kernel/memory/evidence.js";
import { SidecarClient, sidecarFromEnv } from "../../sidecar/client.js";
import { OpenApiParser } from "./api.js";
import type { YamlLoader } from "./api.js";
import { ParserRegistry } from "./base.js";
import type { Chunk, ParsedDoc } from "./base.js";
import { docStats } from "./base.js";
import { BpmnParser } from "./bpmn.js";
import { PptxParser } from "./presentation.js";
import { DdlParser } from "./sql.js";
import type { SqlParseClient } from "./sql.js";
import { CsvParser, XlsxParser } from "./tabular.js";
import { DocxParser, TextParser } from "./text.js";
import type { DocxExtractor } from "./text.js";
import { VisionParser } from "./vision.js";
import type { VisionGateway } from "./vision.js";

// Python `__all__` 的对应物 —— 调用方 `import { XlsxParser } from ".../parse/index.js"`
// 就够了，不必知道每个解析器住在哪个文件里。
export {
  BpmnParser,
  CsvParser,
  DdlParser,
  DocxParser,
  OpenApiParser,
  ParserRegistry,
  PptxParser,
  TextParser,
  VisionParser,
  XlsxParser,
};
export { makeChunk, makeFinding, makeParsedDoc, docStats } from "./base.js";
export type { Finding, ParsedDoc, Parser } from "./base.js";
export { inferType, profileColumn } from "./tabular.js";
export type { ColumnProfile } from "./tabular.js";

// ══════════════════════════════════════════════════════════════════
//  1. default_registry
// ══════════════════════════════════════════════════════════════════

export interface DefaultRegistryOptions {
  /** 传给 `DdlParser`。sidecar 那边照着这个方言解析。 */
  sqlDialect?: string | null;
  /**
   * `kernel/catalog.ts` 的 `SmartGateway`。不传时扫描件仍会被登记，但会在
   * findings 里明说"要用视觉模型识别、现在只登记了文件" —— **不静默跳过**。
   */
  visionGateway?: VisionGateway | null;
  /** `quality`（默认）或 `cost`。整本扫描件 PDF 用 `cost`。 */
  visionPrefer?: string;
  /** 每页开始/结束回调一次。一页要几分钟，不报进度界面上就是几分钟死寂。 */
  visionProgress?: ((message: string) => void) | null;
  /** DDL 解析的真身（契约 §2.3 在 Python）。不传时按环境变量懒建 sidecar 客户端。 */
  sqlClient?: SqlParseClient;
  /** docx 抽取器。不传时给一个会抛的 —— 见文件头 1。 */
  docxExtract?: DocxExtractor;
  /** YAML 版 spec 的加载器。不传就只吃 JSON，并在 findings 里说清楚。 */
  yamlLoad?: YamlLoader | null;
  /** 供 DDL / PDF 两条路复用的 sidecar 客户端。不传则各自到用时再装配。 */
  sidecar?: SidecarClient;
}

/**
 * 内置解析器。**顺序即优先级** —— `.json` 归 `OpenApiParser` 而不是兜底的
 * `TextParser`，靠的就是它排在前面。
 *
 * 这个函数**不做任何 IO、不碰网络**：装配一个注册表不该因为 sidecar 没起就失败，
 * 上传一份 xlsx 的路径根本用不到 sidecar。要 sidecar 的两个解析器都是到解析
 * 当场才装配（`sidecarFromEnv` 缺 token 会抛，那时候抛才指得准）。
 */
export function defaultRegistry(opts: DefaultRegistryOptions = {}): ParserRegistry {
  const prefer = opts.visionPrefer ?? "quality";
  const progress = opts.visionProgress ?? undefined;
  return new ParserRegistry()
    .register(new XlsxParser())
    .register(new CsvParser())
    .register(new DdlParser(opts.sqlClient ?? lazySqlClient(opts.sidecar), opts.sqlDialect ?? null))
    .register(new OpenApiParser(opts.yamlLoad ?? null))
    .register(new BpmnParser())
    .register(new PptxParser())
    .register(new DocxParser(opts.docxExtract ?? missingDocxExtractor))
    .register(
      new VisionParser(opts.visionGateway ?? null, {
        prefer,
        // exactOptionalPropertyTypes：显式传 undefined 与"没传"不是一回事。
        ...(progress === undefined ? {} : { onProgress: progress }),
        ...(opts.sidecar === undefined ? {} : { sidecar: opts.sidecar }),
      }),
    )
    .register(new TextParser(), { fallback: true });
}

/** 到 `parseSql` 被真正调用时才装配 sidecar —— 见 {@link defaultRegistry} 的理由。 */
function lazySqlClient(sidecar: SidecarClient | undefined): SqlParseClient {
  return {
    async parseSql(sql: string, o: { dialect?: string; fileName?: string }): Promise<unknown> {
      return (sidecar ?? new SidecarClient(sidecarFromEnv())).parseSql(sql, o);
    },
  };
}

/**
 * 没配 docx 抽取器时的占位。**抛**，不返回空文档。
 *
 * 返回一个空 `ParsedDoc` 的话，用户会看到"这份 .docx 里什么都没有"——而材料里
 * 明明写满了口径。这正是这一层反复在防的那种失败：产物看起来正常，只是少了
 * 一整个来源。
 */
const missingDocxExtractor: DocxExtractor = (path: string) => {
  return Promise.reject(
    new Error(
      `没有配置 docx 抽取器，${basename(path)} 的内容一个字都读不出来。`
      + `装配时传 docxExtract，或等 sidecar 补上 docx 抽取端点。`,
    ),
  );
};

// ══════════════════════════════════════════════════════════════════
//  2. build_index
// ══════════════════════════════════════════════════════════════════

/**
 * 把解析结果灌进证据索引。
 *
 * 传了 `index` 就**就地灌入并返回同一个对象** —— 重解析要能往同一个索引里补，
 * 而不是每次换一个新的（换新的会让上一轮花钱 OCR 出来的切片静默蒸发）。
 */
export function buildIndex(
  docs: readonly ParsedDoc[],
  index: EvidenceIndex | null = null,
): EvidenceIndex {
  const ix = index === null ? new EvidenceIndex() : index;
  for (const d of docs) ix.addAll(d.chunks.map(toEvidenceChunk));
  return ix;
}

/** 解析层的 `Chunk`（snake_case interface）→ 索引层的 `Chunk`（camelCase class）。 */
function toEvidenceChunk(c: Chunk): EvidenceChunk {
  return new EvidenceChunk({
    chunkId: c.chunk_id,
    fileId: c.file_id,
    fileName: c.file_name,
    // Python 侧两层是同一个对象，`locator` / `raw` 连引用都是同一个。这里照做：
    // 复制 locator 会让"解析器先建 chunk 再补 locator 字段"那种写法静默失效。
    locator: c.locator as Record<string, unknown>,
    render: c.render,
    raw: c.raw,
    order: c.order,
    tags: c.tags,
    context: c.context,
  });
}

// ══════════════════════════════════════════════════════════════════
//  3. corpus_summary / collect_endpoints / collect_profiles
// ══════════════════════════════════════════════════════════════════

/** `corpusSummary` 里展平的一条 finding —— 比 `Finding` 多一个 `file`。 */
export interface CorpusFinding {
  readonly file: string;
  readonly kind: string;
  readonly severity: string;
  readonly message: string;
  readonly locator: Readonly<Record<string, unknown>>;
}

export interface CorpusSummary {
  readonly files: Record<string, unknown>[];
  readonly chunks: number;
  readonly findings: CorpusFinding[];
}

/**
 * 给 FDE 看的解析概览。
 *
 * **findings 必须一并给出** —— 表头偏移、编码猜测、大表采样、元数据泄漏，
 * 每一条都可能改变他对产物的信任程度。
 *
 * 键序照 Python 的字面量顺序（`file` / `kind` / `severity` / `message` /
 * `locator`）：这份 dict 会原样进 `session.state["corpus"]`、落库、再回到前端，
 * 键序漂了 diff 就全是噪声。
 */
export function corpusSummary(docs: readonly ParsedDoc[]): CorpusSummary {
  const findings: CorpusFinding[] = [];
  let chunks = 0;
  for (const d of docs) {
    chunks += d.chunks.length;
    for (const f of d.findings) {
      findings.push({
        file: d.file_name,
        kind: f.kind,
        severity: f.severity,
        message: f.message,
        locator: f.locator,
      });
    }
  }
  return { files: docs.map(docStats), chunks, findings };
}

/** 所有 OpenAPI 写操作端点 —— ActionType 反推的输入。 */
export function collectEndpoints(docs: readonly ParsedDoc[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const d of docs) {
    for (const e of iterSeq(d.structured["endpoints"], "endpoints", d.file_name)) {
      const ep = asDict(e, "endpoints 里的元素", d.file_name);
      // Python 是 `if e.get("write")` —— **取真值**，不是 `is True`。
      // 写成 `=== true` 的话 `"write": 1` 这种（JSON 往返回来很常见）会被静默丢掉，
      // 而丢掉一个写操作端点 = 少推出一个 ActionType。
      if (pyTruthy(ep["write"])) out.push(ep);
    }
  }
  return out;
}

/**
 * 所有列画像，按 `表名.列名` 索引 —— TYPE_MISMATCH 检测的输入。
 *
 * 这些统计由**确定性代码**产出。LLM 无法可靠发现需要跨行分布理解的问题
 * （arXiv:2503.06664），这类检测绝不能交给模型。
 *
 * 键一定含 `.`，所以普通对象保插入序（V8 只对整数键重排），不必用 Map。
 */
export function collectProfiles(
  docs: readonly ParsedDoc[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const d of docs) {
    for (const s of iterSeq(d.structured["sheets"], "sheets", d.file_name)) {
      const sheet = asDict(s, "sheets 里的元素", d.file_name);
      // Python 是 `sheet['name']` —— 缺键就是 KeyError，不是 "undefined.列名"。
      // 一个叫 "undefined.金额" 的画像键永远查不到，而查不到的表现是
      // "这列没有画像"，也就是又一次静默漏检。
      if (!Object.hasOwn(sheet, "name")) throw new KeyError("name");
      const name = String(sheet["name"]);
      // `(sheet.get("profile") or {})` —— None / 空字典都当空处理。
      const prof = sheet["profile"];
      if (!pyTruthy(prof)) continue;
      for (const [col, p] of Object.entries(asDict(prof, "sheet.profile", d.file_name))) {
        out[`${name}.${col}`] = asDict(p, "列画像", d.file_name);
      }
    }
    // `if prof := d.structured.get("profile")` —— **空字典是假值，整段跳过**。
    // CSV 那条路在没有数据行时正好产出 `profile: {}`，那时候不该往表里塞任何键。
    const own = d.structured["profile"];
    if (!pyTruthy(own)) continue;
    const stem = pyStem(d.file_name);
    for (const [col, p] of Object.entries(asDict(own, "structured.profile", d.file_name))) {
      out[`${stem}.${col}`] = asDict(p, "列画像", d.file_name);
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义的小零件
// ══════════════════════════════════════════════════════════════════

/**
 * CPython `PurePath.stem`。
 *
 * 后缀的定义是 `i = name.rfind('.')` 且 `0 < i < len(name) - 1` —— 首字符的点
 * （`.hidden`）和末字符的点（`trail.`）都**不算**后缀。Node 的 `extname` 在后者
 * 上给 `"."`，差这一个字符就是另一个查表键。
 */
export function pyStem(fileName: string): string {
  const name = basename(fileName);
  const chars = [...name];
  const i = chars.lastIndexOf(".");
  return 0 < i && i < chars.length - 1 ? chars.slice(0, i).join("") : name;
}

/** Python 的真值判断。`{}` / `[]` / `""` / `0` / `null` 全是假 —— JS 里前两个是真。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return !Number.isNaN(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * `d.structured.get(key, ())` 的对应物：**缺键就是空序列**，有键但不是数组则抛。
 *
 * Python 在"有键但类型不对"这条路上是 AttributeError 一路抛出去的。照抄这个
 * "响"：structured 的形状漂了要当场知道，静默当成空的话，症状会以"这份材料里
 * 没有任何表"的形态出现，排查方向整个跑偏。
 */
function iterSeq(v: unknown, key: string, file: string): readonly unknown[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  throw new TypeError(`${file} 的 structured[${JSON.stringify(key)}] 不是数组`);
}

function asDict(v: unknown, what: string, file: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(`${file} 的 ${what} 不是对象`);
  }
  return v as Record<string, unknown>;
}
