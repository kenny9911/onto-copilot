/**
 * 解析层的公共契约 —— 移植自 `onto/parse/base.py`。
 *
 * 所有解析器输出同一种东西：带 `Chunk` 的 `ParsedDoc`。下游抽取器只认 Chunk，
 * **不认文件格式** —— 这条边界让"加一种新格式"变成写一个解析器，而不是改抽取逻辑。
 *
 * 每个 Chunk 必须带 locator。没有 locator 的切片进不了索引 —— 因为它产生的任何
 * 结论都无法溯源，而无法溯源的结论在这个产品里没有价值。
 *
 * ── 形状为什么是 snake_case ──────────────────────────────────────
 *
 * `Chunk` / `Finding` / `ParsedDoc` 的字段名保持 **snake_case**：这些结构会进
 * journal 和 evidence 存储，snake_case 是它们的线上形态，改名等于改存量数据的
 * 读法。改名点也是最容易悄悄丢字段的地方。
 * 函数**参数**不跨进程，照 TS 惯例用 camelCase，两者不冲突。
 *
 * ── 与 Python 的两处结构性差异（不是翻译，是重设计）───────────────
 *
 * 1. **`parse` 是 async 的，没有 `aparse`。** Python 侧同步 `parse` + 异步
 *    `aparse` 的分工，前提是"绝大多数解析器是纯 CPU"。Node 上这个前提不成立：
 *    VisionParser 要调网关（HTTP）、PDF 要先栅格化，DocxParser 要过注入的抽取器，
 *    都无法同步实现。留一个同步 `parse` 只会逼出 `readFileSync` 和阻塞事件循环。
 *    Python 的 `parse` / `aparse` 在 TS 侧合并成一个 `parse`。
 * 2. **`parse_all` 与 `aparse_all` 合并**成 `parseAll(paths, {fileIds})`。
 *    顺序执行不并发 —— 保持与 Python 一致的产出顺序，也不让几十份材料同时去抢
 *    网关配额和内存（一页 PDF 位图就是几十 MB）。
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { pyRepr } from "../../kernel/errors.js";
import { sha256Hex } from "../../kernel/ids.js";

// ══════════════════════════════════════════════════════════════════
//  数据形状
// ══════════════════════════════════════════════════════════════════

/**
 * 一份材料的一个切片。
 *
 * `locator` 是这个产品的命脉：任何结论都要能点回原文的确切位置。
 *
 * 它的家其实在 `kernel/memory/evidence.ts`（尚未移植）。字段名与顺序已经按
 * `evidence.py` 的 `Chunk` 对齐，evidence 落地后这里应改成 re-export ——
 * 那是一次搬家，不是一次改形状。
 */
export interface Chunk {
  readonly chunk_id: string;
  readonly file_id: string;
  readonly file_name: string;
  readonly locator: Readonly<Record<string, unknown>>;
  /** 给模型看的文本。 */
  readonly render: string;
  /** 给代码用的结构。Python 默认 `None` —— 这里必须落成 `null` 而不是
   *  `undefined`，否则 JSON 序列化时整个键会消失，与 Python 的形状不同。 */
  readonly raw: unknown;
  /** 文件内序号，邻域扩展靠它。 */
  readonly order: number;
  readonly tags: readonly string[];
  /** 定位性上下文（所属表/章节的名字）。**进检索 token 流、不进 render**。 */
  readonly context: string;
}

/**
 * 解析过程中发现的、值得报给用户的事。
 *
 * 最典型的是文档元数据泄漏：Office 文件默认携带作者名和绝对保存路径，
 * 对外发布前该清一遍。这不是解析错误，但它是 FDE 真正需要知道的信息。
 */
export interface Finding {
  /** metadata_leak | unparsed_sheet | encoding_guess | ... */
  readonly kind: string;
  readonly message: string;
  readonly locator: Readonly<Record<string, unknown>>;
  /** info | warn */
  readonly severity: string;
}

/**
 * 一份材料的解析结果。
 *
 * **可变**（Python 侧也是 `@dataclass(slots=True)` 非 frozen）：解析器一边扫材料
 * 一边 `chunks.push` / `findings.push`，最后一次性写 `structured`。硬要 readonly
 * 的话每个解析器都得先攒中间数组再组装，反而离原件更远、更容易漏。
 */
export interface ParsedDoc {
  file_id: string;
  file_name: string;
  /** xlsx | csv | ddl | openapi | bpmn | pptx | docx | text */
  kind: string;
  chunks: Chunk[];
  /** 结构化产物，按解析器类型不同：表格给 sheets，DDL 给 tables，OpenAPI 给 endpoints。 */
  structured: Record<string, unknown>;
  findings: Finding[];
  meta: Record<string, unknown>;
}

/** Python 的 `Finding(kind, message, locator, severity)` 是位置参数，照搬。 */
export function makeFinding(
  kind: string,
  message: string,
  locator: Readonly<Record<string, unknown>> = {},
  severity = "info",
): Finding {
  return { kind, message, locator, severity };
}

export function makeParsedDoc(init: {
  fileId: string;
  fileName: string;
  kind: string;
}): ParsedDoc {
  // 每次新容器 —— 共享引用的话两份 ParsedDoc 会往同一个数组里塞切片。
  return {
    file_id: init.fileId,
    file_name: init.fileName,
    kind: init.kind,
    chunks: [],
    structured: {},
    findings: [],
    meta: {},
  };
}

/**
 * `ParsedDoc.stats()`。
 *
 * `structured` 里 list/dict 取长度、其余原样 —— **`title` 是字符串所以原样输出**，
 * 不是长度。这条最容易在 TS 侧写成 `.length` 而无声地把标题变成一个数字。
 * `raw` 键排除在外（它是整份原始数据，长度没有意义）。
 */
export function docStats(doc: ParsedDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    file: doc.file_name,
    kind: doc.kind,
    chunks: doc.chunks.length,
    findings: doc.findings.length,
  };
  for (const [k, v] of Object.entries(doc.structured)) {
    if (k === "raw") continue;
    // Map 也算"字典" —— 契约 §1 让键可能是数字串的地方用 Map，那种 structured
    // 进到这里必须给 size，给 Object.keys 会恒等于 0。
    out[k] = Array.isArray(v)
      ? v.length
      : v instanceof Map
        ? v.size
        : v !== null && typeof v === "object"
          ? Object.keys(v).length
          : v;
  }
  return out;
}

/** 切片工厂。`chunk_id` 由 `file_id` 前缀 + 文件内 doc_id 组成 —— 全库唯一是
 *  索引去重的前提（同 id 的第二个切片会被 EvidenceIndex 直接丢掉）。 */
export function makeChunk(init: {
  docId: string;
  fileId: string;
  fileName: string;
  locator: Readonly<Record<string, unknown>>;
  render: string;
  raw?: unknown;
  order?: number;
  tags?: readonly string[];
}): Chunk {
  return {
    chunk_id: `${init.fileId}:${init.docId}`,
    file_id: init.fileId,
    file_name: init.fileName,
    locator: init.locator,
    render: init.render,
    raw: init.raw ?? null,
    order: init.order ?? 0,
    tags: [...(init.tags ?? [])],
    context: "",
  };
}

// ══════════════════════════════════════════════════════════════════
//  解析器与注册表
// ══════════════════════════════════════════════════════════════════

/** Python `FileNotFoundError(path)` —— 消息就是路径本身，与 CPython 的 `str()` 一致。 */
export class FileNotFound extends Error {
  constructor(readonly path: string) {
    super(path);
    this.name = "FileNotFound";
    Object.setPrototypeOf(this, FileNotFound.prototype);
  }
}

/** 一种格式的解析器。 */
export abstract class Parser {
  /** 与 Python 一样给了默认值（`"text"` / `()`）。子类覆盖时 TS 要求写
   *  `override` —— 这正好挡住"想覆盖却拼错了字段名"那种静默失败。 */
  readonly kind: string = "text";
  readonly extensions: readonly string[] = [];

  abstract parse(path: string, opts: { fileId: string }): Promise<ParsedDoc>;

  accepts(path: string): boolean {
    return this.extensions.includes(extname(path).toLowerCase());
  }
}

/**
 * 按扩展名派发。未知扩展名回退到纯文本 —— **不静默跳过**。
 *
 * 跳过一份材料而不告诉任何人，是这类系统最阴的失败模式：产物看起来正常，
 * 只是少了一整个来源。
 */
export class ParserRegistry {
  private readonly parsers: Parser[] = [];
  private fallbackParser: Parser | null = null;

  register(parser: Parser, opts: { fallback?: boolean } = {}): this {
    this.parsers.push(parser);
    if (opts.fallback === true) this.fallbackParser = parser;
    return this;
  }

  /** 兼容旧调用点的别名。 */
  static contentId(path: string): Promise<string> {
    return contentFileId(path);
  }

  forPath(path: string): Parser {
    for (const p of this.parsers) {
      if (p.accepts(path)) return p;
    }
    if (this.fallbackParser === null) {
      // 消息里的 `!r` 用 pyRepr —— 非 ASCII 后缀（".中文"）在 CPython 的 repr 下
      // 是不转义的，手写引号会在别的地方对不上。
      throw new Error(
        `没有能处理 ${pyRepr(extname(path))} 的解析器，也没有配置兜底解析器`,
      );
    }
    return this.fallbackParser;
  }

  async parse(path: string, opts: { fileId?: string } = {}): Promise<ParsedDoc> {
    await assertExists(path);
    const fid = opts.fileId ?? (await contentFileId(path));
    return this.forPath(path).parse(path, { fileId: fid });
  }

  /**
   * 解析全部材料。**顺序执行**，见文件头 2。
   *
   * @param fileIds 文件名 → 指定的 file_id。缓存/边车按 id 索引，重解析时要能
   *   钉住同一个 id，否则同一份材料换个 id 就成了"另一份"。
   *   用 `Map` 而不是普通对象：文件名是外部输入，叫 `constructor` 或
   *   `__proto__` 的文件会从原型链上取到东西，那是个能读出函数当 file_id 的洞。
   */
  async parseAll(
    paths: readonly string[],
    opts: {
      fileIds?: ReadonlyMap<string, string>;
      /** 一份坏材料是否只记 finding、继续解析其余文件。服务端批量入口应开启。 */
      continueOnError?: boolean;
    } = {},
  ): Promise<ParsedDoc[]> {
    const out: ParsedDoc[] = [];
    for (const p of paths) {
      const fid = opts.fileIds?.get(basename(p));
      try {
        out.push(await this.parse(p, fid === undefined ? {} : { fileId: fid }));
      } catch (e) {
        // 文件清单指向一个不存在的路径是存储/竞态错误，不是某种格式读不懂；继续
        // 下去会把“材料丢了”伪装成一条普通 finding，所以仍然 fail-fast。
        if (opts.continueOnError !== true || e instanceof FileNotFound) throw e;
        const parser = this.forPath(p);
        const fileId = fid ?? (await contentFileId(p));
        const doc = makeParsedDoc({ fileId, fileName: basename(p), kind: parser.kind });
        const name = e instanceof Error ? e.name : typeof e;
        const message = e instanceof Error ? e.message : String(e);
        doc.findings.push(makeFinding(
          "parse_failed",
          `${basename(p)} 解析失败（${name}）：${message}`,
          {},
          "warn",
        ));
        out.push(doc);
      }
    }
    return out;
  }
}

async function assertExists(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    // Python 是 `if not p.exists()`：目录也算存在（随后由解析器读失败）。
    throw new FileNotFound(path);
  }
}

/**
 * 按**内容**派生 file_id。
 *
 * 以前是按文件名（`f_{sha256(name)[:8]}`）：两个会话里同名的不同材料会撞成
 * 同一个 id，而改个名的同一份材料又会变成"另一份" —— 缓存、边车、按 file 过滤
 * 的检索全都跟着错位。内容寻址还顺带让"这份材料解析过没有"变成可判定的。
 *
 * 读不到内容（权限/竞态）时退回文件名，宁可退化也不要在解析入口抛。
 */
export async function contentFileId(path: string): Promise<string> {
  try {
    return "f_" + sha256Hex(await readFile(path)).slice(0, 12);
  } catch (e) {
    // Python 只吞 OSError。JS 里对应的是带 errno 码的 SystemError；别的异常
    // （比如 path 传了个奇怪类型）要原样抛出去，吞掉只会把 bug 变成一个错的 id。
    if (!isSystemError(e)) throw e;
    return "f_" + sha256Hex(basename(path)).slice(0, 12);
  }
}

function isSystemError(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

// ══════════════════════════════════════════════════════════════════
//  Python 字符串 / 文件原语（解析层各文件共用，别再复制）
// ══════════════════════════════════════════════════════════════════

/** Python `len(s)` —— 数码点，不是 UTF-16 码元。emoji 上两者差一倍。 */
export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Python `s[:n]` —— 按码点切，CJK/emoji 才不会被切成半个。 */
export function cpSlice(s: string, start: number, end?: number): string {
  return [...s].slice(start, end).join("");
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
// ignoreBOM:true 才等于 Python 的 `codecs.utf_8`：它**不**吃掉 BOM，BOM 会以
// U+FEFF 留在字符串里。默认的 TextDecoder 会悄悄吃掉，那是 utf-8-sig 的语义。
const UTF8_REPLACE_KEEP_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

/** Python `path.read_text(encoding="utf-8", errors="replace")`。 */
export async function readTextReplace(path: string): Promise<string> {
  return UTF8_REPLACE_KEEP_BOM.decode(await readFile(path));
}

/**
 * `tabular.py` 的 `_read_text` —— 按常见编码依次尝试。
 * 中文 CSV 里 GBK 极常见，直接用 utf-8 会炸。
 *
 * Python 的顺序是 utf-8-sig → utf-8 → gb18030 → big5 → latin-1。前两个在这里
 * 合成一次：utf-8-sig 对**不带** BOM 的合法 UTF-8 同样成功（它只是"有 BOM 就
 * 剥掉"），所以只要是合法 UTF-8 永远走第一条，返回的编码名恒为 `"utf-8"`。
 *
 * latin-1 **手写**而不是用 TextDecoder：WHATWG 把 `iso-8859-1` 映射到
 * windows-1252，0x80–0x9F 那 32 个字节会解成 `€‚ƒ„…` 而不是 U+0080–U+009F。
 * 一个字节一个码点才是 Python 的 latin-1。
 */
export async function readTextGuess(path: string): Promise<[string, string]> {
  const raw = await readFile(path);
  try {
    return [UTF8_STRICT.decode(raw), "utf-8"];
  } catch {
    /* 落到下一个编码 */
  }
  for (const [enc, structOk] of [
    ["gb18030", isGb18030Bytes],
    ["big5", isBig5Bytes],
  ] as const) {
    // 先过自己的字节骨架校验，**不能只信 TextDecoder 的 fatal**：Node 的 ICU
    // 解码器对 0x80 / 0xFF 这类 CPython 直接报错的字节是**静默丢掉**的
    // （`fatal: true` 也不抛）。真实事故形态：一份 latin-1 的材料被 big5 "成功"
    // 解出来，非 ASCII 字节全部消失，产物看起来正常、内容少了一半。
    if (!structOk(raw)) continue;
    try {
      return [new TextDecoder(enc, { fatal: true }).decode(raw), enc];
    } catch {
      /* ICU 比骨架规则更严的那些（未定义映射）照样落下一个 */
    }
  }
  // latin-1 对任意字节都成立，所以 Python 那条 `utf-8(replace)` 兜底其实
  // 永远走不到。照抄这个结构（包括它走不到）比"顺手删掉"安全：哪天有人往
  // 列表里加一个会失败的编码，兜底就又有意义了。
  let out = "";
  for (const b of raw) out += String.fromCharCode(b);
  return [out, "latin-1"];
}

/**
 * GB18030 的**字节骨架**（不查映射表）：单字节 <0x80；双字节 0x81–0xFE +
 * 0x40–0xFE（去掉 0x7F）；四字节 0x81–0xFE 0x30–0x39 0x81–0xFE 0x30–0x39。
 * 0x80 与 0xFF 一律非法 —— 与 CPython 的 codec 逐条对齐（golden 钉着边界字节）。
 */
function isGb18030Bytes(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    if (c < 0x80) {
      i += 1;
      continue;
    }
    if (c === 0x80 || c === 0xff) return false;
    const n = b[i + 1];
    if (n === undefined) return false;
    if (n >= 0x30 && n <= 0x39) {
      const t = b[i + 2];
      const f = b[i + 3];
      if (t === undefined || f === undefined) return false;
      if (t < 0x81 || t > 0xfe || f < 0x30 || f > 0x39) return false;
      i += 4;
      continue;
    }
    if (n < 0x40 || n === 0x7f || n > 0xfe) return false;
    i += 2;
  }
  return true;
}

/** Big5 的字节骨架：首字节 0xA1–0xF9，尾字节 0x40–0x7E 或 0xA1–0xFE。 */
function isBig5Bytes(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    if (c < 0x80) {
      i += 1;
      continue;
    }
    if (c < 0xa1 || c > 0xf9) return false;
    const n = b[i + 1];
    if (n === undefined) return false;
    if (!((n >= 0x40 && n <= 0x7e) || (n >= 0xa1 && n <= 0xfe))) return false;
    i += 2;
  }
  return true;
}
