/**
 * 真实模型后端 —— 对应 Python 侧 `kernel/backends.py`，请求/响应字节由
 * `golden/llm.json` 钉住。
 *
 * 两个实现，接口相同（{@link LLMBackend}），网关不关心用的是哪个：
 *
 *   - {@link AnthropicBackend} —— Anthropic Messages API 原生。`effort`、自适应
 *     思考、system 层缓存断点、`stop_reason === "refusal"` 都用原生语义。
 *   - {@link OpenAICompatBackend} —— OpenAI `/chat/completions` 协议，用于
 *     OpenRouter 风格的聚合网关。**能拿到网关回报的真实成本**，比本地定价表准。
 *
 * 后端只做四件事：翻译请求、拿真实用量、处理拒绝、重试瞬时故障。路由、记账、
 * schema 重试、重放全在网关里。
 *
 * ── TS 侧的刻意选择 ──────────────────────────────────────────────────
 *
 * 1. **HTTP 走 `fetch`**（Python 是 httpx）。超时用 `AbortSignal.timeout`，不自己
 *    `setTimeout` —— Node 的这个 timer 是 unref 的；自己造的没 unref，进程会在
 *    最后一次请求后多吊着不退出。
 * 2. **`AnthropicBackend` 的默认 client 是本文件里的 {@link FetchAnthropicClient}**，
 *    不是 `@anthropic-ai/sdk`（TS 侧没有这个依赖）。注入口保持不变（Python 那边
 *    也是鸭子类型的 `client`），所以测试塞假 client 的写法一字不改。
 * 3. **流式响应自己解析 SSE**（SDK 原本替我们做的那件事）。跨 chunk 断开的 UTF-8
 *    多字节字符必须用 `TextDecoder({stream: true})` 拼 —— 中文正好三字节，按
 *    chunk 边界各自 `toString()` 会吐出乱码，而症状是"模型偶尔回了几个问号"，
 *    没人会往传输层想。见 {@link SseDecoder}。
 * 4. **API key 不出现在任何错误消息、日志或 toString 里。** 它只活在 `#key` /
 *    `#apiKey` 这两个 ES 私有字段里（`#` 而不是 TS 的 `private`：后者只是编译期
 *    的、`JSON.stringify(backend)` 照样把它写进日志），两个类各自显式给了
 *    `toJSON` / `toString`。下面每一处 `ModelError` 用的都是**响应**体，不是请求。
 */

import { looksLikeQuotaExhausted } from "./gateway_balance.js";
import { pyJsonDumps } from "./journal.js";
import {
  ModelError,
  ModelRefusal,
  ModelTruncated,
  QuotaExhausted,
  Usage,
  type GenerateArgs,
  type ImageGenArgs,
  type ImageGenResult,
  type LLMBackend,
  type ModelSpec,
} from "./llm.js";

/** 超过这个 max_tokens 必须走流式，否则会撞 HTTP 超时。 */
export const STREAM_THRESHOLD = 16_000;

/** 服务端兜底：安全分类器拒绝时自动换模型重跑，比我们自己接住再重试省一个往返。 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** 值得重试的瞬时故障。4xx（除 429）是请求本身的问题，重试没意义。 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 409, 429, 500, 502, 503, 504, 529,
]);

/**
 * 这个响应是不是"网关账户真的没钱了"（S1 硬信号）。
 *
 * **判据的唯一实现在 `kernel/gateway_balance.ts`**（那个模块先落地，golden 里
 * 两个方向的用例都钉在那边）。这里只是把名字转出来给后端与调用方用 —— 再抄一份
 * 就必然分叉，而分叉的症状是"有时候会重试"。
 */
export { looksLikeQuotaExhausted };

/**
 * SDK / HTTP 层异常里能读出的那点信息。
 *
 * Python 侧刻意用鸭子类型取 `status_code` / `body`，**不 import anthropic 的异常类**：
 * 离线 demo 与测试都跑在没装 SDK / 用假 client 的环境里，为了认一个状态码把整个
 * 模块变成硬依赖不划算。TS 侧同理，另外多认一组 JS SDK 的字段名（那边叫
 * `status` / `error`），因为两个 SDK 的形状本来就不一样。
 */
interface HttpishError {
  status_code?: unknown;
  status?: unknown;
  body?: unknown;
  error?: unknown;
  response?: { text?: unknown } | null;
}

/**
 * SDK 抛出来的 HTTP 异常若是欠费信号，换成 {@link QuotaExhausted}。
 *
 * 不是欠费就原样返回，由调用方把原异常抛回去 —— 这里只做分流，不吞异常。
 */
export function raiseIfQuota(model: string, exc: unknown): void {
  if (typeof exc !== "object" || exc === null) return;
  const e = exc as HttpishError;
  const status = Number(e.status_code ?? e.status ?? 0) || 0;
  const body = e.body ?? e.error ?? null;
  let text = body != null ? pyJsonDumpsCompatible(body) : "";
  if (!text) {
    const respText = e.response?.text;
    text = (typeof respText === "string" ? respText : "") || String(exc);
  }
  if (looksLikeQuotaExhausted(status, text)) {
    throw new QuotaExhausted(model, text, status);
  }
}

/**
 * Python `json.dumps(body, ensure_ascii=False)` 的等价物，**只**用于把异常体变成
 * 一段可搜索的文本喂给欠费判据。
 *
 * 用 `JSON.stringify` 而不是 journal 的 `pyJsonDumps`：这里唯一的用途是子串匹配
 * （`insufficient_quota` / `余额`），分隔符与键序都不影响结果，而 `pyJsonDumps`
 * 对不可序列化的对象会**抛** —— 在异常处理路径上再抛一个异常，原始故障就没了。
 */
function pyJsonDumpsCompatible(body: unknown): string {
  try {
    // ensure_ascii=False 的等价：JSON.stringify 本来就不转义非 ASCII。
    return JSON.stringify(body) ?? "";
  } catch {
    return "";
  }
}

/** Python 的 `s[:n]`（按码点切）。中文错误体在 200/300/400 处按 UTF-16 切会切碎。 */
function cutCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/**
 * Python `json.dumps(x)` 的**全默认**形态：分隔符 `", "` / `": "`，且
 * `ensure_ascii=True`（非 ASCII 转成 `\uXXXX`）。
 *
 * 分隔符由 journal 的 `pyJsonDumps` 给（它是 `ensure_ascii=False` 的那一档），
 * 这里再补最后一步转义。为什么不用 `JSON.stringify`：它给的是**紧凑**分隔符，
 * 差两个空格 —— 而这段字符串是 `ModelError` 的消息，golden 逐字节钉着。
 */
function pyJsonDumpsAscii(v: unknown): string {
  let s: string;
  try {
    s = pyJsonDumps(v);
  } catch {
    // pyJsonDumps 对循环引用/不可序列化会抛。这里是**错误处理路径**，再抛一个
    // 就把原始故障弄丢了。
    return String(v);
  }
  // 非 ASCII 只可能出现在字符串字面量里，所以整串扫一遍是安全的。代理对逐个
  // 码元转义 —— Python 的 ensure_ascii 对星平面字符给的正是两个 `\uXXXX`。
  return s.replace(/[^\x20-\x7e]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return "\\u" + code.toString(16).padStart(4, "0");
  });
}

// ══════════════════════════════════════════════════════════════════
//  Anthropic 原生
// ══════════════════════════════════════════════════════════════════

/** 一条内容块。只关心 `type === "text"` 的那些。 */
export interface AnthropicBlock {
  readonly type?: string;
  readonly text?: string;
}

/** Messages API 的响应形状里本模块真正读到的那一小块。 */
export interface AnthropicMessage {
  readonly content?: readonly AnthropicBlock[];
  readonly stop_reason?: string | null;
  readonly stop_details?: { readonly category?: string | null } | null;
  readonly usage?: {
    readonly input_tokens?: number | null;
    readonly output_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  } | null;
}

/** 流式调用的句柄。SDK 的 `MessageStream` 结构上满足它。 */
export interface AnthropicStreamHandle {
  getFinalMessage?(): Promise<AnthropicMessage>;
  /** JS SDK 的名字。两个都认，因为两家 SDK 就是不一样。 */
  finalMessage?(): Promise<AnthropicMessage>;
}

export interface AnthropicMessagesApi {
  create(params: Record<string, unknown>): Promise<AnthropicMessage>;
  stream?(params: Record<string, unknown>): AnthropicStreamHandle | Promise<AnthropicStreamHandle>;
}

/** 鸭子类型的 client：`beta.messages` 用于服务端兜底，`messages` 是普通路径。 */
export interface AnthropicClientLike {
  readonly messages: AnthropicMessagesApi;
  readonly beta?: { readonly messages: AnthropicMessagesApi } | undefined;
}

export interface AnthropicBackendOptions {
  readonly client?: AnthropicClientLike | null;
  /**
   * 是否给 system 层打缓存断点。默认开 —— 这是本系统最划算的一项优化：L0 层在
   * 整个 Run 内字节稳定，而每个节点都要带上它。
   */
  readonly cacheSystem?: boolean;
  /** 拒绝时是否让服务端自动切模型。 */
  readonly serverFallback?: boolean;
  /** 不传 client 时用来构造默认 client（见 {@link FetchAnthropicClient}）。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Anthropic Messages API 后端。
 *
 * 注意当前一代模型（Opus 5 / Sonnet 5）已移除 `temperature` / `top_p` / `top_k`，
 * 传了直接 400；推理深度用 `effort`。
 */
export class AnthropicBackend implements LLMBackend {
  readonly client: AnthropicClientLike;
  readonly cacheSystem: boolean;
  readonly serverFallback: boolean;

  constructor(opts: AnthropicBackendOptions = {}) {
    this.client =
      opts.client ??
      // Python 是 `from anthropic import AsyncAnthropic`（延迟导入：离线 demo 不
      // 需要 SDK）。TS 侧没有这个依赖，默认 client 就是本文件的 fetch 实现。
      new FetchAnthropicClient({
        apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "",
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      });
    this.cacheSystem = opts.cacheSystem ?? true;
    this.serverFallback = opts.serverFallback ?? true;
  }

  build(o: {
    model: ModelSpec;
    prompt: string;
    system: string;
    schema: Record<string, unknown> | null;
    maxTokens: number;
    cacheSystem: boolean;
  }): Record<string, unknown> {
    const kwargs: Record<string, unknown> = {
      model: o.model.name,
      max_tokens: o.maxTokens,
      messages: [{ role: "user", content: o.prompt }],
    };
    if (o.system) {
      const block: Record<string, unknown> = { type: "text", text: o.system };
      if (o.cacheSystem) {
        // 渲染顺序是 tools → system → messages，所以这一个断点同时覆盖两者。
        block["cache_control"] = { type: "ephemeral" };
      }
      kwargs["system"] = [block];
    }

    const outputConfig: Record<string, unknown> = {};
    if (o.model.effort) outputConfig["effort"] = o.model.effort;
    if (o.schema !== null) {
      outputConfig["format"] = { type: "json_schema", schema: strictify(o.schema) };
    }
    if (Object.keys(outputConfig).length > 0) kwargs["output_config"] = outputConfig;
    if (o.model.thinking) kwargs["thinking"] = { type: "adaptive" };
    return kwargs;
  }

  async generate(args: GenerateArgs): Promise<[string, Usage]> {
    const model = args.model;
    const maxTokens = args.maxTokens ?? 16_000;
    if (args.images && args.images.length > 0) {
      throw new ModelError("AnthropicBackend 的视觉输入尚未接线，请用 OpenAICompatBackend");
    }
    const kwargs = this.build({
      model,
      prompt: args.prompt,
      system: args.system ?? "",
      schema: args.schema ?? null,
      maxTokens,
      cacheSystem: (args.cacheSystem ?? true) && this.cacheSystem,
    });

    let api: AnthropicMessagesApi;
    if (this.serverFallback) {
      kwargs["betas"] = [FALLBACK_BETA];
      kwargs["fallbacks"] = "default";
      const beta = this.client.beta;
      if (beta === undefined) {
        throw new ModelError("client 没有 beta.messages，服务端兜底用不了");
      }
      api = beta.messages;
    } else {
      api = this.client.messages;
    }

    let msg: AnthropicMessage;
    try {
      if (maxTokens > STREAM_THRESHOLD) {
        if (api.stream === undefined) {
          throw new ModelError("client 不支持流式，但 max_tokens 超过了阈值");
        }
        const stream = await api.stream(kwargs);
        const finalize = stream.getFinalMessage ?? stream.finalMessage;
        if (finalize === undefined) {
          throw new ModelError("流式句柄没有 getFinalMessage/finalMessage");
        }
        msg = await finalize.call(stream);
      } else {
        msg = await api.create(kwargs);
      }
    } catch (exc) {
      // 只分流欠费信号，其余原样抛。
      // Anthropic 直连也会 402（账户余额耗尽），SDK 把它抛成一个普通的
      // APIStatusError，上层只看得到"调用失败"。分流出来才有人话可说。
      raiseIfQuota(model.name, exc);
      throw exc;
    }

    if (msg.stop_reason === "refusal") {
      throw new ModelRefusal(model.name, msg.stop_details?.category ?? null);
    }

    const text = (msg.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const u = msg.usage ?? {};
    return [
      text,
      new Usage({
        tok_in: u.input_tokens ?? 0,
        tok_out: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
      }),
    ];
  }
}

// ══════════════════════════════════════════════════════════════════
//  SSE：流式响应的解析
// ══════════════════════════════════════════════════════════════════

/**
 * 把字节流切成 SSE 事件。
 *
 * **两个坑，都只在真流式下才出现，而且都不会报错、只会给出坏数据：**
 *
 * 1. **跨 chunk 断开的 UTF-8 多字节字符。** 一个汉字是三字节，网络分包不认字符
 *    边界，`chunk.toString("utf8")` 逐块转就会在断点两侧各吐一个 U+FFFD。所以
 *    这里用**一个** `TextDecoder`，全程 `{stream: true}` —— 它会把半个字符留在
 *    内部缓冲里等下一块。绝不能每块新建一个 decoder。
 * 2. **跨 chunk 断开的事件帧。** `data: ...\n\n` 同样可能被切开，所以行缓冲要
 *    跨块保留，只在看到空行时才交付一帧。
 */
export class SseDecoder {
  // stream: true 的 decoder 会把不完整的多字节序列留在内部缓冲里 —— 这正是我们要的。
  private readonly decoder = new TextDecoder("utf-8");
  private buf = "";

  /** 喂一块字节，吐出这一块里**完整**的事件帧（原始文本，含各 field 行）。 */
  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** 流结束：冲掉 decoder 的残留，并把最后一帧（可能没有结尾空行）交出来。 */
  flush(): string[] {
    this.buf += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    // SSE 规范允许 \n / \r\n / \r 三种换行；统一成 \n 再按空行切帧。
    this.buf = this.buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: string[] = [];
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx < 0) break;
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      if (frame.trim() !== "") frames.push(frame);
    }
    if (final && this.buf.trim() !== "") {
      frames.push(this.buf);
      this.buf = "";
    }
    return frames;
  }
}

/** 一帧 SSE 的 `event:` 与拼好的 `data:`（多行 data 按规范用 \n 连接）。 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export function parseSseFrame(frame: string): SseEvent {
  let event = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 注释行（网关用来保活）
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

/**
 * 把 Anthropic 的流式事件拼回一条完整消息 —— SDK 的 `get_final_message()` 做的
 * 就是这件事，TS 侧没有 SDK，只能自己拼。
 *
 * 用量分两处到：`message_start` 带输入侧（含两个缓存字段），`message_delta` 带
 * 输出侧。**只取后到的那个 output_tokens** —— 它是累计值不是增量，累加会让出
 * token 翻好几倍，而那直接就是账单。
 */
export class AnthropicStreamAssembler {
  private readonly texts: string[] = [];
  private stopReason: string | null = null;
  private stopCategory: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  feed(ev: SseEvent): void {
    if (ev.data === "" || ev.data === "[DONE]") return;
    let obj: unknown;
    try {
      obj = JSON.parse(ev.data);
    } catch {
      return; // 网关偶尔插一条非 JSON 的保活帧，忽略即可
    }
    if (typeof obj !== "object" || obj === null) return;
    const rec = obj as Record<string, unknown>;
    const type = typeof rec["type"] === "string" ? (rec["type"] as string) : ev.event;

    if (type === "error") {
      const err = rec["error"];
      const msg = isRecord(err) && typeof err["message"] === "string" ? err["message"] : ev.data;
      throw new ModelError(`流式响应报错: ${cutCodePoints(msg, 300)}`);
    }
    if (type === "message_start") {
      const message = rec["message"];
      if (isRecord(message)) {
        const usage = message["usage"];
        if (isRecord(usage)) {
          this.inputTokens = numOr0(usage["input_tokens"]);
          this.cacheRead = numOr0(usage["cache_read_input_tokens"]);
          this.cacheWrite = numOr0(usage["cache_creation_input_tokens"]);
          this.outputTokens = numOr0(usage["output_tokens"]);
        }
      }
      return;
    }
    if (type === "content_block_delta") {
      const delta = rec["delta"];
      if (isRecord(delta) && typeof delta["text"] === "string") {
        this.texts.push(delta["text"]);
      }
      return;
    }
    if (type === "message_delta") {
      const delta = rec["delta"];
      if (isRecord(delta)) {
        if (typeof delta["stop_reason"] === "string") this.stopReason = delta["stop_reason"];
        const sd = delta["stop_details"];
        if (isRecord(sd) && typeof sd["category"] === "string") {
          this.stopCategory = sd["category"];
        }
      }
      const usage = rec["usage"];
      // 累计值，直接覆盖。累加 = 账单翻倍。
      if (isRecord(usage) && usage["output_tokens"] !== undefined) {
        this.outputTokens = numOr0(usage["output_tokens"]);
      }
    }
  }

  message(): AnthropicMessage {
    return {
      content: [{ type: "text", text: this.texts.join("") }],
      stop_reason: this.stopReason,
      stop_details: { category: this.stopCategory },
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cache_read_input_tokens: this.cacheRead,
        cache_creation_input_tokens: this.cacheWrite,
      },
    };
  }
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 从一个字节流里拼出完整的 Anthropic 消息。导出是为了能单独测 —— 上面那两个坑
 * 只有拿真的分块流去喂才试得出来。
 */
export async function assembleAnthropicStream(
  chunks: AsyncIterable<Uint8Array>,
): Promise<AnthropicMessage> {
  const dec = new SseDecoder();
  const asm = new AnthropicStreamAssembler();
  for await (const chunk of chunks) {
    for (const frame of dec.push(chunk)) asm.feed(parseSseFrame(frame));
  }
  for (const frame of dec.flush()) asm.feed(parseSseFrame(frame));
  return asm.message();
}

/** HTTP 层失败。字段名同时按两家 SDK 的习惯给，好让 {@link raiseIfQuota} 认出来。 */
export class AnthropicHttpError extends Error {
  readonly status_code: number;
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, text: string) {
    // **消息里只放响应体，不放任何请求内容** —— 请求头里有 API key。
    super(`Anthropic HTTP ${status}: ${cutCodePoints(text, 400)}`);
    this.status_code = status;
    this.status = status;
    this.body = body;
    this.name = "AnthropicHttpError";
    Object.setPrototypeOf(this, AnthropicHttpError.prototype);
  }
}

export interface FetchAnthropicClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 直接打 Anthropic Messages API 的最小 client —— 顶替 Python 侧的 `AsyncAnthropic()`。
 *
 * **只实现网关真正用到的那两个方法**（`create` / `stream`）。它不是 SDK 的替身：
 * 想要重试策略、tool use、批量接口的，注入真 SDK 的 client 即可（构造参数就是
 * 为此留的接缝）。
 */
export class FetchAnthropicClient implements AnthropicClientLike {
  readonly messages: AnthropicMessagesApi;
  readonly beta: { readonly messages: AnthropicMessagesApi };

  // API key 只活在这里。**不要**把它塞进任何字段名可枚举的对象 —— 一次
  // `JSON.stringify(client)` 或者一条 `console.log(backend)` 就会把它写进日志。
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #version: string;
  readonly #timeoutMs: number;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(opts: FetchAnthropicClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "");
    this.#version = opts.version ?? ANTHROPIC_VERSION;
    this.#timeoutMs = opts.timeoutMs ?? 300_000;
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    const api: AnthropicMessagesApi = {
      create: (params) => this.#create(params),
      stream: (params) => this.#stream(params),
    };
    this.messages = api;
    this.beta = { messages: api };
  }

  /** `toJSON` / `toString` 都不吐凭证 —— 这个类会被塞进 backend 的公有字段。 */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.#baseUrl, version: this.#version };
  }

  toString(): string {
    return `FetchAnthropicClient(${this.#baseUrl})`;
  }

  async #post(params: Record<string, unknown>, stream: boolean): Promise<Response> {
    // `betas` 是 SDK 的参数名，走 HTTP 时是 `anthropic-beta` 头。
    const { betas, ...body } = params as { betas?: unknown } & Record<string, unknown>;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.#apiKey,
      "anthropic-version": this.#version,
    };
    if (Array.isArray(betas) && betas.length > 0) {
      headers["anthropic-beta"] = betas.map(String).join(",");
    }
    const res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(stream ? { ...body, stream: true } : body),
      // 不自己 setTimeout：Node 的 AbortSignal.timeout 是 unref 的，自造的 timer
      // 会让进程在最后一次请求之后多吊着不退出。
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      throw new AnthropicHttpError(res.status, parsed ?? text, text);
    }
    return res;
  }

  async #create(params: Record<string, unknown>): Promise<AnthropicMessage> {
    const res = await this.#post(params, false);
    return (await res.json()) as AnthropicMessage;
  }

  async #stream(params: Record<string, unknown>): Promise<AnthropicStreamHandle> {
    const res = await this.#post(params, true);
    const body = res.body;
    if (body === null) throw new ModelError("流式响应没有 body");
    const msg = await assembleAnthropicStream(iterateBody(body));
    return { getFinalMessage: () => Promise.resolve(msg) };
  }
}

async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ══════════════════════════════════════════════════════════════════
//  OpenAI 兼容网关
// ══════════════════════════════════════════════════════════════════

export interface OpenAICompatOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly extraHeaders?: Record<string, string>;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** 测试接缝：把真睡换成计数器。ESM 换不掉模块级绑定，只能从签名里递进来。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 抖动源。同上，为了让退避可断言。 */
  readonly rng?: () => number;
}

/**
 * OpenAI `/chat/completions` 协议后端（OpenRouter 风格聚合网关）。
 *
 * 与 Anthropic 原生的三点差异，都会影响上层行为，所以在这里显式处理：
 *
 *   1. **结构化输出**走 `response_format.json_schema` 而不是 `output_config.format`，
 *      且 `strict` 要求每个 object 显式关掉 `additionalProperties`。
 *   2. **推理深度**走 `reasoning.effort`（OpenRouter 约定）。网关不认这个字段时会
 *      400，此时降级重发一次而不是整个失败 —— 少一档推理好过没结果。
 *   3. **成本由网关回报**（`usage.cost`），比本地定价表准。网关没给才回退到
 *      {@link modelCost} 估算。
 */
export class OpenAICompatBackend implements LLMBackend {
  readonly baseUrl: string;
  readonly maxRetries: number;
  /** 网关明确拒绝过的可选字段，后续请求直接不带 —— 避免每次都白试一轮。 */
  readonly unsupported = new Set<string>();

  // 凭证只活在私有字段里，且只在拼请求头时读一次。
  readonly #key: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #rng: () => number;

  /**
   * @param baseUrl 形如 `http://host:3010/v1`。
   * @param apiKey 凭证。**只从环境/设置读，不接受源码硬编码**（见 `kernel/config.ts`）。
   */
  constructor(baseUrl: string, apiKey: string, opts: OpenAICompatOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#key = apiKey;
    this.maxRetries = opts.maxRetries ?? 3;
    this.#timeoutMs = opts.timeoutMs ?? 300_000;
    this.#headers = {
      Authorization: `Bearer ${this.#key}`,
      "content-type": "application/json",
      ...(opts.extraHeaders ?? {}),
    };
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#rng = opts.rng ?? Math.random;
  }

  /** 与 Python 的 `aclose()` 对应。fetch 没有连接池句柄，留着是为了调用点对齐。 */
  async aclose(): Promise<void> {
    /* fetch/undici 的连接池是全局的，没有可关的东西 */
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, maxRetries: this.maxRetries };
  }

  toString(): string {
    return `OpenAICompatBackend(${this.baseUrl})`;
  }

  // ── 请求组装 ────────────────────────────────────────────────
  build(o: {
    model: ModelSpec;
    prompt: string;
    system: string;
    schema: Record<string, unknown> | null;
    maxTokens: number;
    drop: ReadonlySet<string>;
    images?: readonly string[] | null;
  }): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (o.system) messages.push({ role: "system", content: o.system });
    const images = o.images ?? [];
    if (images.length > 0) {
      // 文字在前、图在后：先说清要干什么，模型看图时才有目标
      const content: Record<string, unknown>[] = [{ type: "text", text: o.prompt }];
      for (const u of images) content.push({ type: "image_url", image_url: { url: u } });
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: o.prompt });
    }

    const body: Record<string, unknown> = {
      model: o.model.name,
      max_tokens: o.maxTokens,
      messages,
    };
    if (o.schema !== null && !o.drop.has("response_format")) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "output", strict: true, schema: strictify(o.schema) },
      };
    }
    if (o.model.effort && !o.drop.has("reasoning")) {
      body["reasoning"] = { effort: o.model.effort };
    }
    return body;
  }

  /**
   * 出图 —— `/images/generations`，与 chat completions 不是一条路。
   *
   * 不走 `generate` 的重试梯子：那套梯子（截断加预算、schema 反馈重试）全是为
   * 文本设计的，对图像没有意义。这里只做一次调用 + 可读的错误 —— 展示副本
   * 失败不影响主链，调用方如实报告即可，不值得为它烧重试预算。
   */
  async generateImage(args: ImageGenArgs): Promise<ImageGenResult> {
    const body: Record<string, unknown> = {
      model: args.model,
      prompt: args.prompt,
      response_format: "b64_json",
    };
    if (args.size) body["size"] = args.size;

    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (exc) {
      throw new ModelError(`图像生成请求没发出去：${String(exc)}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 404/400 多半是"网关上没有这个图像模型"。把话说明白 —— 用户对着
      // 一条裸 404 只会去查网络，而其实该去设置页选一个带出图能力的模型。
      throw new ModelError(
        `图像生成失败（HTTP ${res.status}）。多半是网关上没有可用的图像模型，`
        + `或所选模型不支持出图。原始信息：${cutCodePoints(text, 300)}`,
      );
    }

    const parsed = (await res.json().catch(() => null)) as
      | { data?: { b64_json?: string }[] }
      | null;
    const b64 = parsed?.data?.[0]?.b64_json ?? "";
    if (!b64) {
      throw new ModelError("图像生成的响应里没有图（data 为空）—— 不把空结果装成成功。");
    }
    return { b64 };
  }

  // ── 调用 ────────────────────────────────────────────────────
  async generate(args: GenerateArgs): Promise<[string, Usage]> {
    const model = args.model;
    const drop = new Set(this.unsupported);
    let last: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const body = this.build({
        model,
        prompt: args.prompt,
        system: args.system ?? "",
        schema: args.schema ?? null,
        maxTokens: args.maxTokens ?? 16_000,
        drop,
        images: args.images ?? null,
      });

      let res: Response;
      try {
        res = await this.#fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (exc) {
        // 网络层故障（连不上、超时、DNS）—— 可重试。Python 那边是
        // `except httpx.RequestError`；fetch 把这些一律抛成 TypeError/DOMException，
        // 分不出来，所以整块当瞬时故障。**响应已经拿到之后**的错误不会走这里。
        last = exc;
        await this.backoff(attempt);
        continue;
      }

      // httpx 的 `resp.text` 能读很多次，fetch 的 body 只能读一次 —— 所以这里
      // 一次读成字符串，后面的状态判定与 JSON 解析都用它。
      //
      // **body 读取失败不能吞成空串。** 网关先回了 200 头、随后连接悬死，
      // AbortSignal 在读 body 时才触发 —— 以前 `.catch(() => "")` 把这种超时
      // 变成空文本，200 分支里 `JSON.parse("")` 再抛裸 SyntaxError 逃出重试
      // 循环，整个节点被判死（真实案发：EXTRACT.s37_27，一次调用悬挂 18 分钟）。
      // 读不到 body 和连不上是同一类瞬时故障：退避重试。
      let text: string;
      try {
        text = await res.text();
      } catch (exc) {
        last = new ModelError(`${model.name} 响应体读取失败（连接中断/超时）: ${pyStrException(exc)}`);
        await this.backoff(attempt);
        continue;
      }

      if (res.status === 400) {
        const field = offendingField(text, body);
        if (field !== null) {
          // 网关不认某个可选字段：记下来，降级重发。少一档推理好过没结果。
          this.unsupported.add(field);
          drop.add(field);
          last = new ModelError(
            `${model.name} 不支持 ${field}，已降级重发：${cutCodePoints(text, 200)}`,
          );
          continue;
        }
      }

      // **必须排在 RETRYABLE_STATUS 之前。** 欠费与限流共用 429，落进重试分支
      // 就是纯浪费：退避多少轮账户也不会自己有钱，用户白等一遍才收到一句
      // `HTTP 429`。这里立刻抛、一次都不重试。
      if (looksLikeQuotaExhausted(res.status, text)) {
        throw new QuotaExhausted(model.name, text, res.status);
      }

      if (RETRYABLE_STATUS.has(res.status)) {
        last = new ModelError(
          `${model.name} HTTP ${res.status}: ${cutCodePoints(text, 200)}`,
        );
        await this.backoff(attempt, res.headers.get("retry-after"));
        continue;
      }

      if (res.status >= 400) {
        throw new ModelError(
          `${model.name} HTTP ${res.status}: ${cutCodePoints(text, 400)}`,
        );
      }

      // 2xx 但 body 不是合法 JSON = 网关把响应截断了（悬死连接最终吐出半个体）。
      // 这是瞬时故障，不是程序错误 —— 裸 SyntaxError 会逃出重试循环。
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        last = new ModelError(
          `${model.name} 2xx 响应体不是合法 JSON（疑似截断，len=${text.length}）: ${cutCodePoints(text, 120)}`,
        );
        await this.backoff(attempt);
        continue;
      }
      return this.parse(model, parsed);
    }

    throw new ModelError(
      `${model.name} 重试 ${this.maxRetries} 次后仍失败: ${pyStrException(last)}`,
    );
  }

  // ── 响应解析 ────────────────────────────────────────────────
  parse(model: ModelSpec, data: Record<string, unknown>): [string, Usage] {
    const rawChoices = data["choices"];
    const choices = Array.isArray(rawChoices) ? rawChoices : [];
    if (choices.length === 0) {
      throw new ModelError(
        `${model.name} 返回空 choices: ${cutCodePoints(pyJsonDumpsAscii(data), 300)}`,
      );
    }
    const first = isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : {};
    const msg = isRecord(first["message"]) ? (first["message"] as Record<string, unknown>) : {};

    const refusal = msg["refusal"];
    if (refusal) throw new ModelRefusal(model.name, cutCodePoints(String(refusal), 120));
    if (first["finish_reason"] === "content_filter") {
      throw new ModelRefusal(model.name, "content_filter");
    }

    const rawText = msg["content"];
    // Python 是 `msg.get("content") or ""`，不检查类型。**小分叉**：个别网关会回
    // `content: [{type:"text",...}]`（多模态形态），Python 会把那个 list 当 text
    // 一路带上去、最终在 `_parse_json` 里 AttributeError；这里给空串，于是走
    // "输出不合 schema" 的重试再报 ModelError。两边都失败，但这边的报错说得清。
    const text = typeof rawText === "string" && rawText ? rawText : "";
    if (!text && msg["reasoning"]) {
      // 只出了思考没出正文 —— max_tokens 被思考吃光了。抛**可重试**的
      // ModelTruncated，让网关加大预算再来一次；抛普通 ModelError 的话这份
      // 材料就直接白传了。
      throw new ModelTruncated(
        `${model.name} 只返回了推理内容、没有正文，` +
          `多半是 max_tokens 不够（本次 finish_reason=` +
          `${pyStrValue(first["finish_reason"])}）`,
      );
    }

    const u = isRecord(data["usage"]) ? (data["usage"] as Record<string, unknown>) : {};
    const pd = isRecord(u["prompt_tokens_details"])
      ? (u["prompt_tokens_details"] as Record<string, unknown>)
      : {};
    const cached = numOr0(pd["cached_tokens"]);
    const usage = new Usage({
      // prompt_tokens 含缓存命中部分，扣掉才是真正按全价计的输入
      tok_in: Math.max(0, numOr0(u["prompt_tokens"]) - cached),
      tok_out: numOr0(u["completion_tokens"]),
      cache_read: cached,
      cache_write: numOr0(pd["cache_write_tokens"]),
      // 网关回报的真实成本，优先于本地估算。**只认数字** —— 网关偶尔回
      // `"cost": "0.01"`，字符串进了账本就是 NaN 或者被当成 0。
      usd: typeof u["cost"] === "number" ? (u["cost"] as number) : null,
    });
    return [text, usage];
  }

  // ── 辅助 ────────────────────────────────────────────────────
  /**
   * 退避。**可覆盖** —— Python 侧测试是 monkeypatch 掉 `_backoff` 的静态方法，
   * ESM 换不掉模块绑定，所以这里做成实例方法（子类可覆盖）+ 构造时可注入 sleep。
   */
  protected async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    if (retryAfter) {
      const v = pyFloat(retryAfter);
      if (v !== null) {
        await this.#sleep(pyMin(30.0, v) * 1000);
        return;
      }
    }
    // 抖动：并发节点同时撞限流时避免整齐重试再次撞墙
    await this.#sleep(pyMin(20.0, 2 ** attempt * 0.8 + this.#rng()) * 1000);
  }
}

/**
 * 400 是不是因为某个可选字段不被支持。
 *
 * Python 是 `_offending_field(error_text, body)` 的静态方法；这里是自由函数，
 * 判据一字不改：字段既要出现在**我们发出去的 body** 里，又要在网关的报错文本里
 * 被点名，才算数。
 */
export function offendingField(
  errorText: string,
  body: Record<string, unknown>,
): string | null {
  const low = errorText.toLowerCase();
  for (const field of ["response_format", "reasoning"]) {
    if (field in body && low.includes(field)) return field;
  }
  return null;
}

/** Python 的 `str(exc)`：异常给消息，None 给 "None"。 */
function pyStrException(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v instanceof Error) return v.message;
  return String(v);
}

/** Python 的 f-string 插值：None → "None"，其余走 str()。 */
function pyStrValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/**
 * Python 的 `float(s)`。**不要**用 `Number(s)` 代替：`Number("")` 给 0（Python 抛），
 * `Number("0x10")` 给 16（Python 抛），`Number("1_0")` 给 NaN（Python 给 10.0）。
 * 这个值来自网关的 `retry-after` 头，什么都可能有；判错的后果是要么不退避（继续
 * 撞墙）要么退避一个荒谬的时长。
 *
 * 解析不出来返回 null —— 对应 Python 那边 `except ValueError: pass` 走抖动退避。
 */
export function pyFloat(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  // Python 允许数字之间有下划线分隔（PEP 515），但不允许开头/结尾/连续。
  if (/_/.test(t)) {
    if (!/^[+-]?(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(t)) return null;
  }
  const clean = t.replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(clean)) {
    return clean.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/i.test(clean)) return NaN;
  // 十进制字面量：必须至少有一位数字，不接受 0x / 0b / 结尾的 "."e 之类。
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(clean)) return null;
  return Number(clean);
}

/**
 * Python 的 `min(a, b)`：返回 `b < a ? b : a`。
 *
 * 与 `Math.min` 在 NaN 上不同 —— `min(30.0, nan)` 在 Python 是 30.0（`nan < 30.0`
 * 为假），`Math.min(30, NaN)` 是 NaN，然后 `setTimeout(NaN)` 立刻触发，退避等于没有。
 */
function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/**
 * 默认的 sleep。**不 unref** —— 退避期间正被 await，unref 掉会让进程在只剩这个
 * timer 时直接退出，promise 永远不 resolve（那比多吊几秒糟得多）。
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ══════════════════════════════════════════════════════════════════
//  共用
// ══════════════════════════════════════════════════════════════════

/** Python str 比较按 code point；JS 默认 sort 按 UTF-16 code unit。BMP 内一致，
 * 键里出现代理对（emoji）才分叉 —— schema 的属性名不能假设都是 ASCII。 */
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

/**
 * 结构化输出要求每个 object 显式关掉 `additionalProperties`，且 `required` 必须
 * 列全所有属性（OpenAI strict 模式的硬要求）。
 *
 * 我们内部的 schema 只写业务字段，这里统一补齐，免得每处定义都写一遍模板噪音。
 *
 * 键序照 Python 的 `{**schema, ...}`：原有键保持原位（值被覆盖），新键追加在后。
 * JS 的对象展开对字符串键是同样的语义 —— 但**整数样式的键**（"0"/"12"）会被 V8
 * 提到最前面。schema 的属性名不会长成那样，真需要时得换 Map。
 */
export function strictify(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema["type"] === "object") {
    const props = isRecord(schema["properties"])
      ? (schema["properties"] as Record<string, unknown>)
      : {};
    const strictProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      strictProps[k] = isRecord(v) ? strictify(v as Record<string, unknown>) : v;
    }
    return {
      ...schema,
      additionalProperties: false,
      required: Object.keys(props).sort(codePointCompare), // strict 模式要求列全
      properties: strictProps,
    };
  }
  const item = schema["items"];
  // Python 是 `if schema.get("type") == "array" and (item := schema.get("items"))`
  // —— 空 dict 在 Python 是假值，在 JS 是真值，所以要显式判非空。
  if (schema["type"] === "array" && isRecord(item) && Object.keys(item).length > 0) {
    return { ...schema, items: strictify(item as Record<string, unknown>) };
  }
  return schema;
}
