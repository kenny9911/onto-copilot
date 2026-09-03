/**
 * 工具注册表与 MCP 安全闸 —— 移植自 Python 侧 `kernel/tools.py`，
 * 由 golden/tools.json 钉住（判定表、投毒特征命中、指纹）。
 *
 * 动作空间二分（架构文档 ADR-2）：
 *
 * * **数据变换 → CodeAct**。清洗、透视、连接、profiling 的逻辑每个项目都不一样，
 *   预定义一百个工具也覆盖不全，"写一段 pandas"能覆盖全部。
 * * **外部交互 → 工具调用**。需要严格的权限边界和审计，代码空间太自由。
 *
 * MCP 侧的威胁是真实的：1899 个开源 server 里 7.2% 含通用漏洞、5.5% 存在**工具
 * 投毒** —— 恶意指令藏在 tool description 里（arXiv:2509.06572）。所以这里的闸门
 * 不是形式主义：描述指纹锁定防 rug pull，静态扫描拦投毒特征，描述以**数据块**而非
 * 指令块注入上下文。
 *
 * ── 移植期的两处形态变化（不是行为变化）───────────────────────────
 *
 * 1. **`@reg.fn(...)` 装饰器 → `reg.fn(spec, handler)` 显式注册。** TS 的
 *    decorator 语义与 Python 完全不同（装饰的是类/成员，不是自由函数），硬凑一个
 *    只会更难读。同时 Python 的 `fn(ctx=ctx, **args)` 是把参数**摊开**成关键字参数
 *    传给处理函数，TS 没有 kwargs —— 处理函数改成收 `(args, ctx)`，参数默认值由
 *    处理函数自己写（Python 那边是函数签名里的默认值，如 `top_k: int = 12`）。
 * 2. **`builtin_registry` 与 `impact.trace` 的那批内建工具没跟过来。** 它们依赖
 *    evidence / oir / sandbox 三个模块，其中 sandbox 按迁移约定 §2.3 **留在 Python**
 *    （`code.exec` 存在的理由就是让模型写 pandas）。等 evidence/oir 落地 TS、
 *    装配层（`server/glue/tools.ts`）接上之后再补，本文件只负责注册表与安全闸本身。
 *
 *    补的时候先读 Python 原件里那几段事故注释 —— 它们还留在 `kernel/tools.py`，
 *    没有被翻译成 TS 就等于没人会再看见：`evidence.search` 的 `files` 参数曾经按
 *    file_id 过滤，而模型手上只有文件名（还爱把中文名百分号编码），于是它一填
 *    `files` 就静默拿到空结果，并据此断言"材料里没有"；`evidence.rows` 空结果要
 *    把实际存在的容器名报回去，同理。
 */

import { ToolDenied, pyRepr } from "./errors.js";
import { EventKind } from "./events.js";
import { sha256Hex } from "./ids.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

/** Python str 比较按 code point；JS 默认 sort 按 UTF-16 code unit。
 * 与 ids.ts 里同名函数同形 —— 那边没导出，这里重写一份而不是改别人的文件。
 * 影响的是 `sorted(names)`（工具名）和 `json.dumps(sort_keys=True)`（指纹输入）。 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/** Python `len(s)` 数的是 **code point**，JS `.length` 数的是 UTF-16 code unit。
 * 一串 emoji 在两边差一倍 —— minLength / 描述长度上限 / digest 截断全靠它。 */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Python `type(x).__name__`，只覆盖 JSON 形状里出现得到的类型。
 *
 * **已知分叉**：JS 里 `1` 与 `1.0` 是同一个值，所以整数值的 float 会被报成
 * `int`（Python 报 `float`）。同 ids.ts 顶部记的那条语言边界，不是 bug。
 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "dict";
  if (typeof v === "object") return "dict";
  return typeof v;
}

/** Python `repr(x)`。报错文本里 `{x!r}` 走这里，`{x}` 走 {@link pyStr}。 */
function pyReprValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return pyRepr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  if (v instanceof Map) {
    return `{${[...v].map(([k, x]) => `${pyReprValue(k)}: ${pyReprValue(x)}`).join(", ")}}`;
  }
  if (isPlainObject(v)) {
    const body = Object.entries(v)
      .map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`)
      .join(", ");
    return `{${body}}`;
  }
  return String(v);
}

/** Python `str(x)`：字符串是自己，其余等于 repr。 */
function pyStr(v: unknown): string {
  return typeof v === "string" ? v : pyReprValue(v);
}

/**
 * Python `==` 的结构比较。`const` / `enum` 判定用它而不是 `===`。
 *
 * 两处非直觉但必须照搬：Python 里 `True == 1`、`1 == 1.0` 都成立；列表/字典按
 * **值**比而不是按引用。用 `===` 会让 `{"enum": [[1, 2]]}` 这种 schema 永不命中。
 */
function pyEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const numLike = (x: unknown) =>
    typeof x === "number" || typeof x === "boolean" || typeof x === "bigint";
  if (numLike(a) && numLike(b)) return Number(a) === Number(b);
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEquals(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && pyEquals(a[k], b[k]));
  }
  return Object.is(a, b);
}

interface DumpOptions {
  /** `json.dumps(..., sort_keys=True)` */
  readonly sortKeys?: boolean;
  /** Python 默认 `ensure_ascii=True`（非 ASCII 转 `\uXXXX`）。 */
  readonly ensureAscii?: boolean;
  /** `json.dumps(..., default=str)` 的兜底；不给则遇到不可序列化的值直接抛。 */
  readonly fallback?: (v: unknown) => string;
}

function dumpString(s: string, ensureAscii: boolean): string {
  // 引号/反斜杠/控制字符的转义形态 JSON.stringify 与 Python 完全一致
  // （含 \b \f \n \r \t 短写法与 \u00xx 小写十六进制）。
  const base = JSON.stringify(s);
  if (!ensureAscii) return base;
  // Python 的 ESCAPE_ASCII 是 `[^ -~]`：0x7f（DEL）也要转义。
  return base.replace(/[^\x20-\x7e]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * Python `json.dumps` 的等价物 —— **不是** ids.ts 的 `canonicalJson`。
 *
 * 差别是致命的：`canonicalJson` 用的是紧凑分隔符 `(",",":")` 且 `ensure_ascii=False`，
 * 而 `ToolSpec.fingerprint` 喂给 sha256 的是 **默认分隔符 `", "` / `": "` +
 * ensure_ascii=True** 的字节。拿 canonicalJson 顶替，指纹就整片跟 Python 对不上，
 * 而指纹是 rug pull 防线的全部依据。
 *
 * **已知分叉**（同 ids.ts）：Python 把整数值的 float 写成 `1.0`，JS 无从区分，
 * 给的是 `1`。schema 里出现 `{"minimum": 1.0}` 才会碰到，golden 里刻意不放这种值。
 */
function pyJsonDumps(value: unknown, opts: DumpOptions = {}): string {
  const sortKeys = opts.sortKeys ?? false;
  const ensureAscii = opts.ensureAscii ?? true;
  const seen = new Set<object>();

  const enc = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") {
      // Python 默认 allow_nan=True，照抄它的非标准记号（这三个 token 只影响
      // 体积计算与指纹输入，不会被谁反序列化）。
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Infinity";
      if (v === -Infinity) return "-Infinity";
      return String(v);
    }
    if (typeof v === "string") return dumpString(v, ensureAscii);

    if (typeof v === "object") {
      if (seen.has(v)) throw new Error("Circular reference detected");
      seen.add(v);
      try {
        if (Array.isArray(v)) return `[${v.map(enc).join(", ")}]`;
        const entries: [string, unknown][] =
          v instanceof Map
            ? [...v].map(([k, x]) => [String(k), x])
            : Object.entries(v as Record<string, unknown>);
        if (sortKeys) entries.sort((x, y) => codePointCompare(x[0], y[0]));
        return `{${entries.map(([k, x]) =>
          `${dumpString(k, ensureAscii)}: ${enc(x)}`).join(", ")}}`;
      } finally {
        seen.delete(v);
      }
    }
    if (opts.fallback) return dumpString(opts.fallback(v), ensureAscii);
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };

  return enc(value);
}

// ══════════════════════════════════════════════════════════════════
//  Danger
// ══════════════════════════════════════════════════════════════════

/**
 * 工具的危险等级 —— 决定要不要人工确认、要不要进沙箱。
 *
 * 这里用 TS 数字 `enum`（而不是全仓通行的 const object），因为 `requires_approval`
 * 判的是 `danger >= EXTERNAL`：等级之间要能**比较大小**，对应 Python 的 IntEnum。
 */
export enum Danger {
  READ = 0, // 只读，无副作用
  COMPUTE = 1, // 有计算但不改外部状态（沙箱内）
  WRITE_LOCAL = 2, // 改本系统状态（写 OIR、产物）
  EXTERNAL = 3, // 改外部世界（发邮件、建 issue）—— 一律需人工确认
}

/** Python `Danger.READ.name`。事件 payload 里存的是名字而不是数字。 */
export function dangerName(d: Danger): string {
  const name = Danger[d];
  if (name === undefined) throw new Error(`未知 Danger: ${String(d)}`);
  return name;
}

/** Python `Danger(v)` / `Danger[name]`：未知值抛错，不做 `as` 断言。 */
export function parseDanger(v: unknown): Danger {
  if (typeof v === "number" && Danger[v] !== undefined) return v as Danger;
  if (typeof v === "string") {
    const hit = (Danger as Record<string, unknown>)[v];
    if (typeof hit === "number") return hit as Danger;
  }
  throw new Error(`未知 Danger: ${pyReprValue(v)}`);
}

// ══════════════════════════════════════════════════════════════════
//  ToolSpec
// ══════════════════════════════════════════════════════════════════

/** JSON Schema 子集。Python 侧是 `dict[str, Any]`，这里同样保持开放。 */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpecInit {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly danger?: Danger;
  /** 供应方。`builtin` 可信；`mcp:<server>` 要过安全闸。 */
  readonly origin?: string;
  /**
   * 工具返回值契约。MCP 工具不能只校验入参：被攻陷的 server
   * 可以在返回值中偷塞指令、凭证或超大 payload。
   */
  readonly outputSchema?: JsonSchema | null;
}

/** 有行为（fingerprint / render）的数据，按迁移约定用 class 而不是 interface。 */
export class ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly danger: Danger;
  readonly origin: string;
  readonly outputSchema: JsonSchema | null;

  constructor(init: ToolSpecInit) {
    this.name = init.name;
    this.description = init.description;
    this.inputSchema = init.inputSchema;
    this.danger = init.danger ?? Danger.READ;
    this.origin = init.origin ?? "builtin";
    this.outputSchema = init.outputSchema ?? null;
  }

  get requiresApproval(): boolean {
    return this.danger >= Danger.EXTERNAL;
  }

  /** 描述 + schema 的指纹。变了就说明工具被换过，必须重新审批。 */
  fingerprint(): string {
    return sha256Hex(
      this.description +
        pyJsonDumps(this.inputSchema, { sortKeys: true }) +
        pyJsonDumps(this.outputSchema, { sortKeys: true }),
    ).slice(0, 16);
  }

  /**
   * 进 prompt 的形态。
   *
   * 描述包在显式边界里 —— 它是**外部数据**，不是我们的指令。缺了边界，
   * 投毒的描述就和系统提示词混在一起了。
   */
  render(): string {
    const body = this.description.trim();
    return (
      `### ${this.name}　[${dangerName(this.danger)}]\n` +
      `<tool_description source="${this.origin}">\n${body}\n</tool_description>\n` +
      `参数：${pyJsonDumps(this.inputSchema, { ensureAscii: false })}`
    );
  }
}

// ══════════════════════════════════════════════════════════════════
//  Tool
// ══════════════════════════════════════════════════════════════════

export interface Tool {
  readonly spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolCallCtx): Promise<unknown>;
}

/**
 * 处理函数。Python 是 `fn(ctx=ctx, **args)` —— 参数摊开成关键字参数、缺的用签名
 * 默认值补上。TS 没有 kwargs，改成收整个 `args` 对象，默认值由处理函数自己写。
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallCtx,
) => unknown | Promise<unknown>;

/** 把一个普通函数包成工具。 */
export class FnTool implements Tool {
  readonly spec: ToolSpec;
  private readonly fn: ToolHandler;

  constructor(spec: ToolSpec, fn: ToolHandler) {
    this.spec = spec;
    this.fn = fn;
  }

  async run(args: Record<string, unknown>, ctx: ToolCallCtx): Promise<unknown> {
    // Python 那边判 `__await__` 再 await；JS 的 await 对非 thenable 直接透传，
    // 语义相同。
    return await this.fn(args, ctx);
  }
}

// ══════════════════════════════════════════════════════════════════
//  MCP 安全闸
// ══════════════════════════════════════════════════════════════════

/**
 * 工具投毒的典型特征。描述本该只讲这个工具做什么，出现祈使句和越权措辞
 * 就说明有人想借描述给模型下指令。
 *
 * 逐条对齐 Python 的正则表，只有一处**必要的翻译**：`\.env\b` 的 `\b`。Python 的
 * `\b` 是 unicode 词边界（CJK 也算词字符），所以 `"读取.env文件"` **不**命中；JS 的
 * `\b` 只认 ASCII 词字符，直译过去会多命中一条。译成 `(?![\p{L}\p{N}_])` 才等价 ——
 * golden 里 `读取.env文件` / `读取 .env 文件` 两条用例钉的就是它。
 */
export const POISON_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/ignore\s+(?:all\s+)?(?:previous|prior|above)/iu, "试图覆盖既有指令"],
  [/忽略(?:之前|上面|以上|全部)/iu, "试图覆盖既有指令"],
  [/do\s+not\s+(?:tell|mention|inform|reveal)/iu, "要求对用户隐瞒"],
  [/不要(?:告诉|提及|告知|透露)/iu, "要求对用户隐瞒"],
  [/(?:you\s+must|always)\s+(?:first\s+)?call/iu, "试图劫持调用顺序"],
  [/<\s*(?:system|instructions?)\s*>/iu, "伪装成系统指令"],
  [/(?:api[_\s-]?key|password|token|secret)\s*[:=]/iu, "索取凭证"],
  [/\.ssh|id_rsa|\.env(?![\p{L}\p{N}_])|credentials/iu, "指向凭证文件"],
];

/**
 * 不可见字符 —— 藏在描述里的指令用它们躲过肉眼审查。必须写成 escape，
 * 源码本身不能真的含这些双向/零宽控制字符。
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/** 扫描工具描述里的投毒特征。返回命中的原因。 */
export function scanDescription(text: string): string[] {
  const hits: string[] = [];
  if (INVISIBLE.test(text)) hits.push("含不可见控制字符（可能藏有隐藏指令）");
  const normalized = text.normalize("NFKC");
  for (const [pattern, reason] of POISON_PATTERNS) {
    if (pattern.test(normalized)) hits.push(reason);
  }
  // Python 的 len 是 code point 数：2100 个 emoji 在 JS 里 `.length` 是 4200，
  // 用 `.length` 会把正常长度的描述误判成"异常长"。
  if (codePointLength(text) > 4000) {
    hits.push("描述异常长（正常工具描述不需要几千字）");
  }
  return [...new Set(hits)]; // Python 是 dict.fromkeys：去重且保序
}

export interface MCPGatewayInit {
  readonly approved?: ReadonlyMap<string, string> | Record<string, string>;
  /** 出网白名单。空 = 不允许任何出网。 */
  readonly egressAllowlist?: readonly string[];
  /**
   * 安全默认：首次出现的 MCP 工具只进隔离区，不自动变成已批准。
   * 开发环境若确实要保留旧行为，可显式设 `autoApproveFirst: true`。
   */
  readonly autoApproveFirst?: boolean;
  readonly maxResultBytes?: number;
}

/**
 * MCP server 接入闸。
 *
 * 三道防线，缺一不可：
 *
 * 1. **静态扫描** —— 接入时扫描述里的投毒特征。
 * 2. **指纹锁定** —— 首次接入登记指纹；描述变了自动禁用，需人工复审
 *    （防 rug pull：先用良性描述通过审核，之后再改成恶意的）。
 * 3. **参数双向校验** —— 出入参按声明 schema 严校验，越权字段直接丢弃。
 */
export class MCPGateway {
  /** name → 已批准的指纹。用 Map 而不是普通对象：工具名可能是纯数字串
   * （`"1"`），普通对象会把它排到最前面，隔离区的顺序就不是插入序了。 */
  readonly approved: Map<string, string>;
  readonly quarantined = new Map<string, string[]>();
  readonly egressAllowlist: readonly string[];
  readonly autoApproveFirst: boolean;
  readonly maxResultBytes: number;

  constructor(init: MCPGatewayInit = {}) {
    const app = init.approved;
    this.approved = new Map(
      app instanceof Map ? app : Object.entries((app ?? {}) as Record<string, string>),
    );
    this.egressAllowlist = [...(init.egressAllowlist ?? [])];
    this.autoApproveFirst = init.autoApproveFirst ?? false;
    this.maxResultBytes = init.maxResultBytes ?? 1_048_576;
  }

  /** 接入一个 MCP 工具。返回 `[是否放行, 说明]`。 */
  admit(spec: ToolSpec, opts: { force?: boolean } = {}): [boolean, string] {
    const hits = scanDescription(spec.description);
    if (hits.length > 0) {
      this.quarantined.set(spec.name, hits);
      if (!opts.force) return [false, `描述命中投毒特征：${hits.join("；")}`];
    }

    const fp = spec.fingerprint();
    const known = this.approved.get(spec.name);
    if (known === undefined) {
      if (!this.autoApproveFirst) {
        this.quarantined.set(spec.name, ["首次接入，等待管理员审批指纹"]);
        return [false, `首次接入，已隔离待审（指纹 ${fp}）`];
      }
      this.approved.set(spec.name, fp);
      return [true, "首次接入，开发模式已自动登记指纹"];
    }
    if (known !== fp) {
      this.quarantined.set(spec.name, ["描述或 schema 与已批准版本不一致"]);
      return [
        false,
        `${spec.name} 的描述已变更（${known} → ${fp}）。这是 rug pull 的典型形态，` +
          "工具已禁用，需人工复审后重新登记。",
      ];
    }
    return [true, "指纹匹配"];
  }

  /**
   * 管理员显式批准当前版本，返回锁定的指纹。
   *
   * 批准也不能跳过投毒扫描；描述/schema 任一变化后旧批准自动失效。
   */
  approve(spec: ToolSpec): string {
    const hits = scanDescription(spec.description);
    if (hits.length > 0) {
      this.quarantined.set(spec.name, hits);
      throw new ToolDenied(`${spec.name} 描述命中投毒特征：${hits.join("；")}`);
    }
    const fp = spec.fingerprint();
    this.approved.set(spec.name, fp);
    this.quarantined.delete(spec.name);
    return fp;
  }

  /**
   * 按声明 schema 过滤入参。**未声明的字段直接丢弃**，不是报错。
   *
   * 丢弃比报错好：报错会让调用方知道哪些字段被拒，反而给了试探边界的信号。
   */
  validateArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
    const rawProps = spec.inputSchema["properties"];
    const props = isPlainObject(rawProps) ? rawProps : {};
    const clean: Record<string, unknown> = {};
    // 保持 args 的插入序（Python 的 dict comprehension 同样保序）。
    for (const [k, v] of Object.entries(args)) {
      if (k in props) clean[k] = v;
    }
    const schema = Object.keys(spec.inputSchema).length > 0
      ? spec.inputSchema
      : { type: "object" };
    validateSchema(clean, schema, `${spec.name}.args`);
    return clean;
  }

  /**
   * 校验工具返回值的形状与体积。
   *
   * 只对声明了 `outputSchema` 的工具做结构校验；体积上限对所有
   * 工具生效，防止工具结果把 Agent context 和日志撑爆。
   */
  validateResult(spec: ToolSpec, result: unknown): unknown {
    let size: number;
    try {
      // Python 是 `json.dumps(result, ensure_ascii=False, default=str)` 再取
      // UTF-8 字节数 —— 中文一个字三字节，用 `.length` 会低估到三分之一。
      size = Buffer.byteLength(
        pyJsonDumps(result, { ensureAscii: false, fallback: String }),
        "utf8",
      );
    } catch (exc) {
      // 异常文本两边必然不同（Python 的 TypeError/ValueError 措辞），前缀一致。
      throw new ToolDenied(`${spec.name} 返回值无法序列化：${String(exc)}`);
    }
    if (size > this.maxResultBytes) {
      throw new ToolDenied(`${spec.name} 返回 ${size} 字节，超过上限 ${this.maxResultBytes}`);
    }
    if (spec.outputSchema && Object.keys(spec.outputSchema).length > 0) {
      validateSchema(result, spec.outputSchema, `${spec.name}.result`);
    }
    return result;
  }
}

// ══════════════════════════════════════════════════════════════════
//  注册表
// ══════════════════════════════════════════════════════════════════

/**
 * 调用上下文的**局部最小类型**。真身是 `kernel/loop.ts` 的 RunContext（别人的
 * track，尚未落地）—— 这里只声明本模块真正读到的成员，等 RunContext 落地后收敛
 * 成 `import type`。Python 那边是 `getattr(ctx, ..., default)` 的鸭子类型，所以
 * 成员**全是可选的**，这一点要保住：ToolRegistry 不该要求调用方备齐整个 Run 环境。
 */
export interface ToolCallCtx {
  readonly rec?: ToolRecorder | null;
  readonly nodeId?: string;
  readonly approved?: boolean;
  /** 被拒动作的重放队列，见 {@link ToolRegistry.call}。 */
  readonly pending?: { tool: string; args: Record<string, unknown> }[];
  readonly budget?: ToolBudget | null;
  /** 节点级工具调用配额，与 Run 级 budget 相互独立。 */
  spendToolCall?: () => void;
  readonly toolEffectKey?: string | null;
}

/** Recorder 的局部最小类型，同样等 `kernel/recorder.ts` 落地后收敛。 */
export interface ToolRecorder {
  emit(
    kind: EventKind,
    opts: { nodeId?: string; payload?: Record<string, unknown> },
  ): unknown;
  effect(
    nodeId: string,
    kind: string,
    request: Record<string, unknown>,
    fn: () => unknown | Promise<unknown>,
    opts?: { key?: string | null; replay?: "reuse" | "never" },
  ): Promise<unknown>;
}

/** Budget 的局部最小类型。Python 是 `budget.spend(tool_calls=1)` 的 kwargs。 */
export interface ToolBudget {
  check(dim: string): void;
  spend(amounts: Record<string, number>): void;
}

export interface FnToolInit {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly danger?: Danger;
  readonly scopes?: readonly string[];
  readonly outputSchema?: JsonSchema | null;
}

/** Read-only view used to verify runtime registration against the tool catalog. */
export interface ToolRegistrationSnapshot {
  readonly name: string;
  readonly origin: string;
  readonly danger: string;
  readonly fingerprint: string;
  readonly scopes: readonly string[];
}

/**
 * 节点可用工具的唯一来源。
 *
 * 工具按**节点作用域**授予，不是全局可用 —— 抽取节点不该有发邮件的能力。
 * 这也是间接提示注入的主要防线：材料内容再怎么诱导，抽取节点的动作空间里
 * 根本没有出网工具。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly scopes = new Map<string, Set<string>>(); // 作用域名 → 工具名
  private readonly toolScopes = new Map<string, readonly string[]>();
  readonly gateway: MCPGateway;

  constructor(gateway?: MCPGateway | null) {
    this.gateway = gateway ?? new MCPGateway();
  }

  // ── 注册 ────────────────────────────────────────────────────
  /**
   * 注册一个工具。**`scopes` 不给就是 `["*"]`，即每个作用域都拿得到。**
   *
   * 这条默认值出过事（架构审计 P0-1，工具最小权限失效）：`TOOL_SCOPES` 那张表
   * 一直是声明式的，而 `builtin_registry` 全用默认值注册，于是表里写的限制一条也
   * 没生效 —— 直接读用户上传材料的 extract 作用域照样拿到了 `code.exec`，材料里
   * 一段伪装成业务说明的指令就能诱导模型调它。给外部/计算类工具注册时**必须**显式
   * 写 scopes。
   */
  register(tool: Tool, opts: { scopes?: readonly string[] } = {}): this {
    const name = tool.spec.name;
    if (this.tools.has(name)) {
      // Python 抛的是 ValueError（编程错误，不是安全拒绝）—— 不要换成 ToolDenied，
      // 那会让"注册重名"看起来像"被闸门拦下"。
      throw new Error(`工具 ${pyRepr(name)} 已注册，拒绝静默覆盖`);
    }
    if (tool.spec.origin.startsWith("mcp:")) {
      const [ok, why] = this.gateway.admit(tool.spec);
      if (!ok) throw new ToolDenied(`${name} 未通过 MCP 安全闸：${why}`);
    }
    this.tools.set(name, tool);
    const granted = [...(opts.scopes ?? ["*"])];
    this.toolScopes.set(name, granted);
    for (const s of granted) {
      let bucket = this.scopes.get(s);
      if (bucket === undefined) {
        bucket = new Set<string>();
        this.scopes.set(s, bucket);
      }
      bucket.add(name);
    }
    return this;
  }

  /** Python 那边是 `@reg.fn(...)` 装饰器；TS 没有等价语义，改成显式注册。 */
  fn(init: FnToolInit, handler: ToolHandler): this {
    const spec = new ToolSpec({
      name: init.name,
      description: init.description,
      inputSchema: init.schema,
      danger: init.danger ?? Danger.READ,
      outputSchema: init.outputSchema ?? null,
    });
    return this.register(new FnTool(spec, handler), { scopes: init.scopes ?? ["*"] });
  }

  // ── 查询 ────────────────────────────────────────────────────
  registrationSnapshot(): readonly ToolRegistrationSnapshot[] {
    return [...this.tools.values()]
      .sort((a, b) => codePointCompare(a.spec.name, b.spec.name))
      .map((tool) => ({
        name: tool.spec.name,
        origin: tool.spec.origin,
        danger: dangerName(tool.spec.danger),
        fingerprint: tool.spec.fingerprint(),
        scopes: [...(this.toolScopes.get(tool.spec.name) ?? [])],
      }));
  }

  forScope(scope: string): Tool[] {
    const names = new Set([
      ...(this.scopes.get("*") ?? []),
      ...(this.scopes.get(scope) ?? []),
    ]);
    return [...names]
      .sort(codePointCompare)
      .map((n) => this.tools.get(n))
      .filter((t): t is Tool => t !== undefined);
  }

  get(name: string, scope = "*"): Tool {
    const allowed = this.forScope(scope).map((t) => t.spec.name);
    if (!allowed.includes(name)) {
      throw new ToolDenied(
        `作用域 ${pyRepr(scope)} 里没有工具 ${pyRepr(name)}（可用：` +
          `${pyReprValue([...allowed].sort(codePointCompare))}）`,
      );
    }
    return this.tools.get(name)!;
  }

  /** 进 prompt 的工具目录。 */
  catalog(scope = "*"): string {
    const tools = this.forScope(scope);
    if (tools.length === 0) return "（本节点没有可用工具）";
    return tools.map((t) => t.spec.render()).join("\n\n");
  }

  // ── 调用 ────────────────────────────────────────────────────
  /** 调一个工具。走这里而不是直接拿 tool 调，才能统一做校验和记账。 */
  async call(
    name: string,
    args: Record<string, unknown> | null | undefined,
    ctx: ToolCallCtx,
    opts: { scope?: string } = {},
  ): Promise<unknown> {
    const scope = opts.scope ?? "*";
    const tool = this.get(name, scope);
    const clean = this.gateway.validateArgs(tool.spec, args ?? {});

    const rec = ctx.rec ?? null;
    const node = ctx.nodeId ?? "";

    if (tool.spec.requiresApproval && !ctx.approved) {
      // **被拒也要记账。** 只记成功的调用，事后就看不到"模型曾经想改产物、
      // 被闸门挡住了"—— 而这恰恰是判断闸门有没有在起作用的唯一证据，
      // 也是发现提示注入的第一现场。
      if (rec !== null) {
        rec.emit(EventKind.EFFECT_REQUESTED, {
          nodeId: node,
          payload: {
            kind: "tool.denied",
            tool: name,
            danger: dangerName(tool.spec.danger),
            args: digest(clean),
          },
        });
      }
      // 把被拒的动作记在 ctx.pending 上，供上层在用户确认时**直接重放** ——
      // 而不是让模型重新推理一遍。全局的 approved bool 不记得在确认什么，
      // 于是"确认"会被理解成别的意思（采纳哪条建议）。重放才是确定的。
      if (ctx.pending !== undefined && ctx.pending !== null) {
        ctx.pending.push({ tool: name, args: { ...clean } });
      }
      // 措辞别提"花钱"。这道闸判的是 `danger >= EXTERNAL`，而 EXTERNAL 的语义是
      // **改外部世界或不可逆**，跟花不花钱无关：真正烧钱的 build.start 是
      // WRITE_LOCAL、根本不走这里，而被挡下的 template.recompile 恰恰是零模型
      // 调用。原来那句"会改变产物或花钱"对每个被拦的工具都是假的，模型照抄给
      // 用户就变成凭空反问一句"要花钱吗"。
      //
      // "要用户确认"这四个字是契约 —— dialogue.ts 的 needsConfirm 靠它认这一轮
      // 被拦过。改文案可以，别把它改没了。
      throw new ToolDenied(
        `${name} 是不可逆或影响外部的动作（${dangerName(tool.spec.danger)}），要用户确认后才能执行。` +
          "请把你打算做什么、影响多大告诉他，让他说一句确认。",
      );
    }
    if (typeof ctx.spendToolCall === "function") ctx.spendToolCall();
    const budget = ctx.budget ?? null;
    if (budget !== null) {
      budget.check("tool_calls");
      budget.spend({ tool_calls: 1 });
    }

    const invoke = async (): Promise<unknown> => {
      const result = await tool.run(clean, ctx);
      return this.gateway.validateResult(tool.spec, result);
    };

    // 非确定性工具与 LLM 一样走 Recorder.effect：首次执行记完整
    // requested/completed/failed，恢复时直接读回结果，不重复修文档或付费。
    if (rec !== null) {
      let effectKey = ctx.toolEffectKey ?? null;
      if (!effectKey && clean["idempotency_key"]) {
        effectKey = `tool:${name}:${String(clean["idempotency_key"])}`;
      }
      return await rec.effect(
        node || "TOOL",
        "tool.call",
        {
          tool: name,
          scope,
          danger: dangerName(tool.spec.danger),
          fingerprint: tool.spec.fingerprint(),
          args: clean,
        },
        invoke,
        {
          key: effectKey,
          // 项目知识库正文与元数据受可变 ACL 保护。Recorder 的历史结果是审计账，
          // 不是永久 capability：恢复时必须重新进入 DocumentService 做当前权限
          // 裁决。覆盖全部 document.* READ，避免 list/history 成为旁路。
          ...(tool.spec.danger === Danger.READ && name.startsWith("document.")
            ? { replay: "never" as const }
            : {}),
        },
      );
    }
    return await invoke();
  }
}

/**
 * 严格校验工具契约需要的 JSON Schema 子集。
 *
 * 支持 type/enum/const/required/properties/items/长度/数值范围；未识别的
 * keyword 留给上层完整 validator，但已声明的约束绝不 fail-open。
 *
 * **不要换成 zod 或别的库。** 它的两处行为被 Python 侧测试和 server 的错误处理
 * 依赖着：未声明字段在 `validateArgs` 里是**丢弃**（不是报错），以及每条报错的
 * 文本形态（`args 缺少必填参数 ['b']` 这种 Python list repr）。换库就是换语义。
 *
 * Python 侧这个函数是模块私有的 `_validate_schema`；TS 侧导出它，golden 测试要
 * 直接喂判定表 —— 它是本模块最需要逐条钉住的东西。
 */
export function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  // Python 的 `if not schema` 对空 dict 也成立：空 schema 放行一切。
  if (!schema || Object.keys(schema).length === 0) return;

  if ("const" in schema && !pyEquals(value, schema["const"])) {
    throw new ToolDenied(`${path} 必须等于 ${pyReprValue(schema["const"])}`);
  }
  if ("enum" in schema) {
    const allowed = schema["enum"];
    const list = Array.isArray(allowed) ? allowed : [];
    if (!list.some((x) => pyEquals(value, x))) {
      throw new ToolDenied(`${path} 必须是 ${pyReprValue(allowed)} 之一`);
    }
  }

  const rawType = schema["type"];
  const kinds: string[] =
    typeof rawType === "string"
      ? [rawType]
      : Array.isArray(rawType)
        ? rawType.map(String)
        : [];
  const checks: Record<string, (x: unknown) => boolean> = {
    // Python 的 None 只有一个；JS 的 undefined 也当 None 收（args 里的
    // `{a: undefined}` 与 Python 的 `{"a": None}` 是同一种"没值"）。
    null: (x) => x === null || x === undefined,
    boolean: (x) => typeof x === "boolean",
    // Python 的 bool 是 int 的子类，所以两条都要显式排除 bool。
    // **已知分叉**：JS 的 1.0 就是 1，整数值的 float 这里会被判成 integer 合规，
    // Python 会拒。见 ts/test/kernel.tools.test.ts 里钉住的那条。
    integer: (x) => (typeof x === "number" && Number.isInteger(x)) || typeof x === "bigint",
    // NaN/Infinity 在 Python 里是货真价实的 float，`isinstance(nan, float)` 为真 ——
    // 这里不额外拦，拦了就是偷偷加了一条 Python 没有的约束。
    number: (x) => typeof x === "number" || typeof x === "bigint",
    string: (x) => typeof x === "string",
    array: (x) => Array.isArray(x),
    object: (x) => isPlainObject(x),
  };
  if (kinds.length > 0 && !kinds.some((k) => (checks[k] ?? (() => true))(value))) {
    throw new ToolDenied(
      `${path} 类型必须是 ${pyReprValue(kinds)}，实际是 ${pyTypeName(value)}`,
    );
  }

  if (isPlainObject(value)) {
    const required = schema["required"];
    const missing = (Array.isArray(required) ? required : [])
      .map(String)
      .filter((x) => !(x in value));
    if (missing.length > 0) {
      throw new ToolDenied(`${path} 缺少必填参数 ${pyReprValue(missing)}`);
    }
    const rawProps = schema["properties"];
    const props = isPlainObject(rawProps) ? rawProps : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value && isPlainObject(sub)) {
        validateSchema(value[key], sub, `${path}.${key}`);
      }
    }
    if (schema["additionalProperties"] === false) {
      const extra = Object.keys(value)
        .filter((k) => !(k in props))
        .sort(codePointCompare);
      if (extra.length > 0) {
        throw new ToolDenied(`${path} 含未声明字段 ${pyReprValue(extra)}`);
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    if (minItems !== undefined && minItems !== null && value.length < Number(minItems)) {
      throw new ToolDenied(`${path} 数量少于 ${pyStr(minItems)}`);
    }
    const maxItems = schema["maxItems"];
    if (maxItems !== undefined && maxItems !== null && value.length > Number(maxItems)) {
      throw new ToolDenied(`${path} 数量多于 ${pyStr(maxItems)}`);
    }
    const items = schema["items"];
    if (isPlainObject(items)) {
      value.forEach((item, i) => validateSchema(item, items, `${path}[${i}]`));
    }
  }

  if (typeof value === "string") {
    // 长度按 code point 数，与 Python 的 len 一致。
    const n = codePointLength(value);
    const minLength = schema["minLength"];
    if (minLength !== undefined && minLength !== null && n < Number(minLength)) {
      throw new ToolDenied(`${path} 长度小于 ${pyStr(minLength)}`);
    }
    const maxLength = schema["maxLength"];
    if (maxLength !== undefined && maxLength !== null && n > Number(maxLength)) {
      throw new ToolDenied(`${path} 长度大于 ${pyStr(maxLength)}`);
    }
  }

  if (typeof value === "number" || typeof value === "bigint") {
    const minimum = schema["minimum"];
    if (minimum !== undefined && minimum !== null && Number(value) < Number(minimum)) {
      throw new ToolDenied(`${path} 不能小于 ${pyStr(minimum)}`);
    }
    const maximum = schema["maximum"];
    if (maximum !== undefined && maximum !== null && Number(value) > Number(maximum)) {
      throw new ToolDenied(`${path} 不能大于 ${pyStr(maximum)}`);
    }
  }
}

/**
 * 参数摘要 —— 只进审计事件，不进 prompt。长值截断，避免一条被拒的调用把整份
 * 材料抄进日志。Python 侧是私有的 `_digest`。
 */
export function digest(
  args: Record<string, unknown>,
  limit = 200,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    const s = pyStr(v);
    const n = codePointLength(s);
    out[k] = n <= limit ? s : [...s].slice(0, limit).join("") + `…(+${n - limit})`;
  }
  return out;
}
