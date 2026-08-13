/**
 * 配置加载 —— 与 Python 侧 `kernel/config.py` 行为对齐，由 golden/config.json 钉住。
 *
 * 凭证只从环境读，绝不落进源码。`.env` 已在 `.gitignore` 里。这里做的是最小可用的
 * dotenv 解析，不引第三方库：内核依赖越少越好，而且这里的语义（**不覆盖**已有环境
 * 变量 —— CI 注入的凭证优先于开发机上的文件）需要显式控制。
 *
 * ── 为什么这 50 行值得写这么多代码 ──────────────────────────────────
 * 原件每一行都恰好踩在 Python 与 JS **不等价但都不报错**的地方，照着字面翻会得到
 * 一个"大体能跑、边界上悄悄不同"的实现：
 *
 *   `line.strip()`   Python 的 isspace 是 29 个字符：比 JS `trim()` 多
 *                    `\x1c-\x1f` 和 `\x85`（NEL），少 `﻿`（BOM）。
 *                    **BOM 那条会咬人**：Windows 编辑器存出来的 .env，Python 侧
 *                    第一个键叫 `﻿CUSTOM_LLM_BASE_URL`（于是判定"变量没配"
 *                    直接抛），JS 的 trim 顺手把 BOM 吃掉就成功了 —— 同一份文件
 *                    两边得出相反结论，而且都不报错。
 *   `splitlines()`   切 10 种分隔符（`\n \v \f \r \x1c \x1d \x1e \x85
 *                     `，`\r\n` 算一次），不是 `split(/\r\n|\r|\n/)`。
 *   `strip("'\"")`   是**字符集**剥离不是"配对去引号"：`"""` → 空串，`"z` → `z`。
 *                    且它在 `.strip()` **之后**，所以引号**里面**的空格留着。
 *   `os.environ[k]`  空键 CPython 抛 OSError、含 NUL 抛 ValueError；Node 的
 *                    `process.env[k] = v` 两种都静默吞掉。一行 `=value` 在 Python
 *                    侧会让 server.py:290 的 `load_dotenv()` 把整个服务端打挂 ——
 *                    这里照抄"炸"，不许"更宽容"。
 *   `k in os.environ` `process.env` 有原型链，`"toString" in process.env` 是
 *                    **true**。照抄 `in` 会让 .env 里的 `toString=...` 被当成
 *                    "环境里已经有了"而静默跳过。
 *   `len(k)`/`k[:6]` Python 数 code point，JS `.length` 数 UTF-16 码元 ——
 *                    emoji 密钥上 `redactedKey` 的分支判断直接反过来。
 *   `rstrip("/")`    剥**全部**尾斜杠，`"///"` → `""` → 于是判定"缺变量"。
 *
 * ── 凭证不外泄 ────────────────────────────────────────────────────
 * `redactedKey()` 是**唯一**允许把 api_key 打出来的形式。本模块自己不会在任何
 * 消息里带上 key：`ConfigError` 的消息只含变量**名**（`missing` 是名字列表），
 * 不含值。注意 `LLMConfig` 是普通对象，`JSON.stringify(cfg)` / `console.log(cfg)`
 * 会原样吐出 key —— 这一点两边一样（Python 的 dataclass `__repr__` 同样不脱敏），
 * 所以这里**没有**加自定义 toString/toJSON 脱敏：那会是 TS 单方面多出来的行为。
 */

import { existsSync, readFileSync } from "node:fs";

import { pyRepr } from "./errors.js";

// ── Python 字符串原语的移植 ────────────────────────────────────────

/**
 * Python `str.isspace()` 的完整字符集（29 个，Unicode 15 / CPython 3.12）。
 *
 * 与 JS `trim()` 的差集两个方向都有，所以**不能**用 `trim()` 代替：
 *   Python 独有：`\x1c \x1d \x1e \x1f`（文件/组/记录/单元分隔符）、`\x85`（NEL）
 *   JS 独有：    `﻿`（BOM，JS 规范把它算进 WhiteSpace）
 * 这一串由 golden 的 `primitives.isspace_codepoints` 逐个钉住 —— 不用
 * `\p{White_Space}`，那个既少了 `\x1c-\x1f` 又会随 JS 引擎的 Unicode 版本漂。
 */
const PY_SPACE = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** Python `str.strip()`（无参）。 */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/**
 * Python `str.strip(chars)` —— 从两端剥掉**属于集合**的字符，剥到第一个不属于
 * 集合的为止。不是"去掉配对的引号"：`'"""'.strip('\'"')` 是空串，`'"z'` 是 `z`。
 */
export function pyStripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  let i = 0;
  let j = s.length;
  while (i < j && set.has(s[i] as string)) i++;
  while (j > i && set.has(s[j - 1] as string)) j--;
  return s.slice(i, j);
}

/** Python `str.splitlines()` 的分隔符（`\r\n` 另按两字符处理）。 */
const PY_LINE_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/**
 * Python `str.splitlines()`。
 *
 * 与 `split(/\r\n|\r|\n/)` 三处不同：分隔符多 6 种；空串给 `[]` 而不是 `[""]`；
 * 末尾的分隔符不产生尾部空元素。前两条在 .env 解析里都是真会走到的路。
 */
export function pySplitlines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (PY_LINE_BREAKS.has(c)) {
      out.push(s.slice(start, i));
      i += c === 0x0d && s.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      start = i;
    } else {
      i++;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** `[a, b]` —— Python 用 f-string 插一个 list 时走的 `str(list)`，元素是 `repr`。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** JS 没有 OSError / ValueError。类型塞进 `name`、消息与 CPython 逐字一致，
 * 这样 golden 里记的 `{type, message}` 两项都能对上。 */
function pyError(type: string, message: string): Error {
  const e = new Error(message);
  e.name = type;
  return e;
}

// ── 环境变量访问 ───────────────────────────────────────────────────

/**
 * `k in os.environ`。
 *
 * **不能**写 `k in process.env`：`process.env` 挂在一个有原型的对象上，
 * `"toString" in process.env` / `"constructor" in process.env` 都是 true，而
 * `os.environ` 里根本没有这些键。用 `in` 的后果是 .env 里的 `toString=xxx`
 * 被当成"环境里已存在"直接跳过 —— 静默、且只在特定键名上发作。
 */
function envHas(name: string): boolean {
  return Object.hasOwn(process.env, name);
}

/** `os.environ.get(name, dflt)`。同样绕开原型链。 */
function envGet(name: string, dflt = ""): string {
  return envHas(name) ? (process.env[name] ?? dflt) : dflt;
}

/**
 * `os.environ[name] = value`。
 *
 * CPython 会在两种情况下抛：空名 → `OSError [Errno 22]`（glibc/BSD 的 setenv
 * 拒绝空名）、名字含 NUL → `ValueError`。Node 的 `process.env[name] = value`
 * 两种都**静默接受**。照抄 Python 的"炸"：一份 `=value` 这样的畸形 .env 在
 * Python 侧会让服务端起不来（server.py:290 的 load_dotenv 没有 try），TS 侧
 * 悄悄跳过就意味着同一份配置在两边跑出不同结果。
 */
function envSet(name: string, value: string): void {
  if (name === "") throw pyError("OSError", "[Errno 22] Invalid argument");
  if (name.includes("\0")) throw pyError("ValueError", "embedded null byte");
  process.env[name] = value;
}

// ── dotenv ────────────────────────────────────────────────────────

/**
 * Python `Path.read_text(encoding="utf-8")`。
 *
 * 两个默认值必须显式关掉：
 *   `fatal: true`      —— 非法 UTF-8 时 Python 抛 UnicodeDecodeError，
 *                         TextDecoder 默认却是替换成 U+FFFD（静默毁数据）。
 *   `ignoreBOM: true`  —— 名字是反的：它表示"**不**把 BOM 当标记吃掉"。默认
 *                         (false) 会剥掉开头的 BOM，而 Python 的 "utf-8"
 *                         （不是 utf-8-sig）会把 BOM 原样留在字符串里。
 */
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const QUOTES = "'\"";

/**
 * 读 `.env` 到环境变量，返回文件里解析出的全部键值（按出现顺序）。
 *
 * 默认**不覆盖**已存在的环境变量 —— CI 里注入的凭证优先于开发机上的文件。
 *
 * 返回值用 `Map` 而不是普通对象：键来自文件，可能是 `"2"` 这类纯数字串，普通
 * 对象会把它们重排到最前面，而"重复键谁在后面"是这个返回值仅剩的语义。
 *
 * 注意返回值与环境**可以不一致**：重复键时 `loaded` 是后写的值，环境里留的却是
 * 先写的（`override=false` 下第二次看到键已存在就跳过）。这是 Python 的行为，
 * 不是 bug，golden 的 `dup_key` 用例钉着。
 *
 * @param path     .env 路径，相对当前工作目录解析。
 * @param override Python 侧是 keyword-only 的 `*, override`；TS 没有关键字参数，
 *                 退化成第二个位置参数，调用点务必写全。
 */
export function loadDotenv(path = ".env", override = false): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const text = DECODER.decode(readFileSync(path));
  const loaded = new Map<string, string>();
  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    // 注意判定顺序与对象：三条都作用在 strip 之后的整行上，而且没有"行内注释"
    // 这回事 —— `A=1 # x` 的值是 `1 # x`。
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("="); // partition 切**第一个** =，`A=B=C` 的值是 `B=C`
    const k = pyStrip(line.slice(0, eq));
    // 先 strip 空白再 strip 引号 —— 顺序反过来的话 `A="  x  "` 的内层空格会没了
    const v = pyStripChars(pyStrip(line.slice(eq + 1)), QUOTES);
    if (override || !envHas(k)) envSet(k, v);
    loaded.set(k, v);
  }
  return loaded;
}

// ── LLMConfig ─────────────────────────────────────────────────────

/**
 * 网关配置。Python 侧是 `@dataclass(frozen=True, slots=True)` 的纯数据，
 * 这里按约定用 interface + 工厂，两个 property 落成自由函数
 * （`cfg.redacted_key` → `redactedKey(cfg)`）。
 */
export interface LLMConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * 两个字段都没有默认值，Python 侧 `LLMConfig()` 是 TypeError —— 所以这里收必填
 * 位置参数而不是约定里的 `Partial<X>`，把"少给一个"留在编译期拦住。
 * `Object.freeze` 对应 `frozen=True`：`readonly` 只管编译期，运行期从 JSON 反
 * 序列化回来的对象照样能被改。
 */
export function makeLLMConfig(baseUrl: string, apiKey: string): LLMConfig {
  return Object.freeze({ baseUrl, apiKey });
}

/**
 * 打日志用。凭证永远不完整出现在日志、事件、异常里。
 *
 * 长度与切片都按 **code point**：`api_key.length` 在 JS 里是 UTF-16 码元数，
 * 12 个 emoji 的 key 会被算成 24 而走进脱敏分支（Python 算 12，返回裸 `…`），
 * 而 `slice(0, 6)` 会切出 3 个 emoji 而不是 6 个。golden 里两条 emoji 用例
 * 就是钉这个的。
 */
export function redactedKey(cfg: LLMConfig): string {
  const cp = [...cfg.apiKey];
  if (cp.length > 12) return `${cp.slice(0, 6).join("")}…${cp.slice(-4).join("")}`;
  return "…";
}

/** base_url 是明文 HTTP —— 凭证会在链路上裸奔。`startsWith` 与 Python 一样区分大小写。 */
export function insecureTransport(cfg: LLMConfig): boolean {
  return cfg.baseUrl.startsWith("http://");
}

// ── llm_config ────────────────────────────────────────────────────

/**
 * 缺少必需配置。
 *
 * Python 侧抛的是 `RuntimeError`，而 cli.py:82 和 server.py:809 都是
 * `except RuntimeError` **按类型**接的。JS 没有 RuntimeError，只 `throw new
 * Error(...)` 会逼这两处退化成匹配消息串（一改文案就静默失灵）—— 所以给一个类。
 *
 * 它**不挂在** `HarnessError` 下面：Python 侧也不是 HarnessError 的子类，
 * 挂上去会让 `catch (e instanceof HarnessError)` 那一路开始吞配置错误。
 *
 * `missing` 只装变量**名**，不装值 —— 消息里绝不能出现 api_key。
 */
export class ConfigError extends Error {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.missing = [...missing];
    this.name = "ConfigError";
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

const BASE_URL_VAR = "CUSTOM_LLM_BASE_URL";
const API_KEY_VAR = "CUSTOM_LLM_API_KEY";

/**
 * 从环境读取自定义网关配置。
 *
 * **不静默降级到别的端点** —— 悄悄换成另一个模型服务比直接失败危险得多。
 *
 * @param dotenv 传 `null` 跳过读文件（Python 侧是 keyword-only 的 `dotenv=None`）。
 * @throws {ConfigError} 缺少必需变量时。
 */
export function llmConfig(dotenv: string | null = ".env"): LLMConfig {
  if (dotenv !== null) loadDotenv(dotenv);
  // rstrip("/") 剥掉**全部**尾斜杠，所以 "///" 会变成空串、进而算"没配"。
  // `$` 没有 m 标志时只匹配串尾，与 rstrip 等价。
  const base = envGet(BASE_URL_VAR).replace(/\/+$/, "");
  const key = envGet(API_KEY_VAR);
  // Python 是 `if not v`：只有空串算缺。纯空白 "   " 是真值，照过 —— 别顺手加
  // .trim()，那会把一个 Python 侧能启动的配置在 TS 侧变成启动失败。
  const missing: string[] = [];
  if (!base) missing.push(BASE_URL_VAR);
  if (!key) missing.push(API_KEY_VAR);
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少环境变量 ${pyReprList(missing)}。把它们写进 .env（见 .env.example）或直接导出。`,
      missing,
    );
  }
  return makeLLMConfig(base, key);
}
