/**
 * FastAPI / pydantic 的 **422 校验响应形状**。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 *
 * FastAPI 的 422 不是 `{"detail": "一句话"}`，是 pydantic 的**错误数组**：
 *
 * ```json
 * {"detail": [{"type": "missing", "loc": ["query", "seq"],
 *              "msg": "Field required", "input": null}]}
 * ```
 *
 * 前端有两处逐字读 `d.detail`（原 `ui/index.html:1598` / `:1728`，现在在
 * `ts/src/ui/` 下）：字符串走"直接显示"，数组走另一条渲染路径。给错形状
 * **不会报错** —— 只会让错误提示变成空白或 `[object Object]`。这是最难被
 * 测试抓到的一类回归：状态码对、Content-Type 对、JSON 合法，只有人眼能看出
 * 提示框里什么都没有。
 *
 * 所以这里**不是**一个 pydantic 等价物，只是把现有路由真正用到的四类校验
 * （必填缺失 / 整数解析 / 布尔解析 / 上传件类型）映射成同形的四元组。
 *
 * ── 事实来源 ──────────────────────────────────────────────────────────────
 *
 * 下面每条常量与解析规则都是**真起 uvicorn 逐个 curl 问出来的**，不是照
 * pydantic 文档写的。几条反直觉的（真问过才知道）：
 *
 * · `seq=1.0` **是合法整数**（小数部分全 0 就截掉），`seq=1.` 和 `seq=1e3` 不是；
 * · `seq=1_000` 合法（下划线按 Python `int()` 的规则，只能夹在数字之间），
 *   但 `seq=1.000_0` 不合法 —— 下划线只允许出现在整数部分；
 * · 整数**允许两侧空白**（`?seq=%205%20` 解析成 5），布尔**不允许**
 *   （`?purge=%20true%20` 是 422）。这不对称，但它就是 pydantic 的行为；
 * · 一次请求里多个参数都错时，**query 的错在 body 的错之前**（FastAPI 按
 *   path → query → header → cookie → body 的顺序解依赖）。
 *
 * ── 已知不复刻的部分（写在这里免得下一个人以为是漏了）────────────────────
 *
 * · 超出 2^53 的 seq：Python 的 int 无上限，会一路带到 SQLite 才炸成 500
 *   （`OverflowError: Python int too large to convert to SQLite INTEGER`）。
 *   TS 侧用 `number`，同样的输入会走到 404。这是复刻一个 Python 侧的 bug，
 *   不值得；
 * · `json_invalid` 的 `ctx.error` 是 Python `json` 模块的原话
 *   （`Expecting value` / `Extra data` …），TS 侧给 V8 的措辞。**键结构一致，
 *   字符串不同** —— 前端不读 ctx；
 * · 同一条错误里 `loc` 末位的出错位置：V8 只在长措辞的错误里报
 *   （见 {@link jsonErrorPos}），短措辞的退回 0。Python 每次都有准确的 `pos`。
 */

import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

// ══════════════════════════════════════════════════════════════════
//  错误四元组
// ══════════════════════════════════════════════════════════════════

/** pydantic 一条错误的 `loc`：字符串段 + 数组下标。 */
export type ErrorLoc = readonly (string | number)[];

/** pydantic 一条错误。字段顺序照 FastAPI 的输出（前端不依赖，但 diff 会看）。 */
export interface PydanticError {
  readonly type: string;
  readonly loc: ErrorLoc;
  readonly msg: string;
  readonly input: unknown;
  readonly ctx?: Record<string, unknown>;
}

/** `{"type": "missing", …}` —— 必填项缺失。`input` 恒为 `null`（不是省略）。 */
export function missingError(loc: ErrorLoc): PydanticError {
  return { type: "missing", loc, msg: "Field required", input: null };
}

/** `{"type": "int_parsing", …}` —— 收到了字符串但它不是整数。 */
export function intParsingError(loc: ErrorLoc, input: unknown): PydanticError {
  return {
    type: "int_parsing",
    loc,
    msg: "Input should be a valid integer, unable to parse string as an integer",
    input,
  };
}

/** `{"type": "bool_parsing", …}` —— 收到了字符串但它不在布尔字面量表里。 */
export function boolParsingError(loc: ErrorLoc, input: unknown): PydanticError {
  return {
    type: "bool_parsing",
    loc,
    msg: "Input should be a valid boolean, unable to interpret input",
    input,
  };
}

/** `{"type": "dict_type", …}` —— `body: dict` 收到了非对象。 */
export function dictTypeError(loc: ErrorLoc, input: unknown): PydanticError {
  return { type: "dict_type", loc, msg: "Input should be a valid dictionary", input };
}

/** `{"type": "json_invalid", …}` —— 请求体不是合法 JSON。`ctx.error` 见文件头。 */
export function jsonInvalidError(loc: ErrorLoc, reason: string): PydanticError {
  return {
    type: "json_invalid",
    loc,
    msg: "JSON decode error",
    input: {},
    ctx: { error: reason },
  };
}

/**
 * `{"type": "value_error", …}` —— `files: list[UploadFile]` 那一位收到的是普通
 * 表单字段而不是文件。
 *
 * Python 的 `ctx.error` 是一个**异常对象**，`jsonable_encoder` 把它编成 `{}`。
 * 这里照抄那个空对象 —— 键在、值空，正是线上的样子。
 */
export function uploadTypeError(loc: ErrorLoc, input: unknown): PydanticError {
  return {
    type: "value_error",
    loc,
    msg: "Value error, Expected UploadFile, received: <class 'str'>",
    input,
    ctx: { error: {} },
  };
}

// ══════════════════════════════════════════════════════════════════
//  抛出
// ══════════════════════════════════════════════════════════════════

/**
 * 组装成 `RequestValidationError` 落地后的那个响应。
 *
 * 走 `res` 而不是 `message`：`HTTPException` 的 message 只能是字符串，
 * 而这里的 body 必须是**数组**。`serve.ts` 的 `onError` 见到 `res` 会原样发。
 */
export function validationException(errors: readonly PydanticError[]): HTTPException {
  const body = JSON.stringify({ detail: errors });
  return new HTTPException(422, {
    // message 只进日志；给一句能看懂的，别把 JSON 塞进去。
    message: errors.map((e) => `${e.loc.join(".")}: ${e.msg}`).join("; "),
    res: new Response(body, {
      status: 422,
      headers: { "content-type": "application/json" },
    }),
  });
}

/**
 * 收集器。
 *
 * 为什么要收集而不是遇错就抛：`POST /audit?apply=maybe` 且不带 `files` 时，
 * FastAPI 一次回**两条**错误。逐个抛只会回第一条 —— 用户改完第一处再提交，
 * 又被第二处顶回来，来回三趟。
 */
export class ValidationErrors {
  private readonly items: PydanticError[] = [];

  add(err: PydanticError): void {
    this.items.push(err);
  }

  get length(): number {
    return this.items.length;
  }

  /** 有错就抛；没错就什么都不做。 */
  raise(): void {
    if (this.items.length > 0) throw validationException(this.items);
  }
}

/** 单条错误的快捷抛法。 */
export function raise422(err: PydanticError): never {
  throw validationException([err]);
}

// ══════════════════════════════════════════════════════════════════
//  标量解析（pydantic 的 lax 模式）
// ══════════════════════════════════════════════════════════════════

/**
 * pydantic v2 的 `str -> int`（lax）。解析不出来给 `null`。
 *
 * 语法（逐个 curl 问出来的，见文件头）：两侧空白 → 可选正负号 → 十进制数字
 * （可用**单个**下划线分隔，不能开头/结尾/连用）→ 可选的全零小数部分。
 * 指数形式（`1e3`）、空小数部分（`1.`）、小数部分里的下划线一律**不认**。
 */
export function pydanticInt(raw: string): number | null {
  const s = raw.trim();
  const m = /^([+-]?)(\d+(?:_\d+)*)(?:\.(0+))?$/.exec(s);
  if (m === null) return null;
  const digits = (m[2] ?? "").replace(/_/g, "");
  const n = Number(`${m[1] ?? ""}${digits}`);
  // `?seq=-0`：JS 给 `-0`，Python 的 `int("-0")` 给 `0`。`===` 分不出这两个，
  // 但 `Object.is` / `Map` 的键 / `Math.sign` 分得出。把它压回 `+0`，免得一个
  // 只在负零上出现的分叉埋在这儿。
  return n === 0 ? 0 : n;
}

/** pydantic 认的真值字面量（大小写不敏感）。 */
export const TRUE_LITERALS: ReadonlySet<string> = new Set(["1", "on", "t", "true", "y", "yes"]);
/** pydantic 认的假值字面量（大小写不敏感）。 */
export const FALSE_LITERALS: ReadonlySet<string> = new Set(["0", "off", "f", "false", "n", "no"]);

/**
 * pydantic v2 的 `str -> bool`（lax）。解析不出来给 `null`。
 *
 * **不做 trim** —— `?purge=%20true%20` 在 Python 侧是 422。跟整数那条不对称，
 * 但这是真问出来的行为，不是笔误：改成 trim 会让一次带空格的 `purge=true`
 * 从"报错"变成"真的彻底删除"，那是不可撤销的一步。
 */
export function pydanticBool(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (TRUE_LITERALS.has(v)) return true;
  if (FALSE_LITERALS.has(v)) return false;
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  查询参数（路由直接用这几个）
// ══════════════════════════════════════════════════════════════════

type QueryReader = { req: { query(name: string): string | undefined } };

/** FastAPI 的 `x: int`（必填）。缺失 → missing，坏值 → int_parsing。 */
export function requiredIntQuery(c: QueryReader, name: string): number {
  const raw = c.req.query(name);
  if (raw === undefined) raise422(missingError(["query", name]));
  const n = pydanticInt(raw);
  if (n === null) raise422(intParsingError(["query", name], raw));
  return n;
}

/** FastAPI 的 `x: int = dflt`。缺失取默认，坏值 → int_parsing。 */
export function optionalIntQuery(c: QueryReader, name: string, dflt: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return dflt;
  const n = pydanticInt(raw);
  if (n === null) raise422(intParsingError(["query", name], raw));
  return n;
}

/** FastAPI 的 `x: bool = dflt`。缺失取默认，坏值 → bool_parsing。 */
export function optionalBoolQuery(c: QueryReader, name: string, dflt: boolean): boolean {
  const raw = c.req.query(name);
  if (raw === undefined) return dflt;
  const v = pydanticBool(raw);
  if (v === null) raise422(boolParsingError(["query", name], raw));
  return v;
}

/**
 * 同上，但把错误**收进 bag** 而不是当场抛 —— 给"query 和 body 都可能出错"的
 * 路由（`POST /audit`）用。坏值时返回默认值，反正后面 `raise()` 会拦住。
 */
export function collectBoolQuery(
  bag: ValidationErrors,
  c: QueryReader,
  name: string,
  dflt: boolean,
): boolean {
  const raw = c.req.query(name);
  if (raw === undefined) return dflt;
  const v = pydanticBool(raw);
  if (v === null) {
    bag.add(boolParsingError(["query", name], raw));
    return dflt;
  }
  return v;
}

/** FastAPI 的 `x: str`（必填查询参数）。缺失 → missing。 */
export function requiredStrQuery(c: QueryReader, name: string): string {
  const raw = c.req.query(name);
  if (raw === undefined) raise422(missingError(["query", name]));
  return raw;
}

// ══════════════════════════════════════════════════════════════════
//  请求体
// ══════════════════════════════════════════════════════════════════

/**
 * FastAPI 的 `body: dict`（必填的 JSON 对象体）。
 *
 * 三种失败在 Python 侧是**三种不同的错误**，前端据此分辨"你没发东西"和
 * "你发的东西坏了"：
 *
 * · 体是空的 → `missing`（loc `["body"]`）。注意：不是 `json_invalid` ——
 *   FastAPI 在 `json.loads` **之前**先判 `if body_bytes`，空体走必填缺失那条；
 * · 体非空但不是合法 JSON → `json_invalid`（loc `["body", 0]`，那个 0 是
 *   Python `json` 报的出错字符位置）；
 * · 合法 JSON 但不是对象 → `dict_type`（loc `["body"]`）。
 */
export async function jsonObjectBody(
  c: { req: { text(): Promise<string> } },
  loc: ErrorLoc = ["body"],
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text === "") raise422(missingError(loc));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    raise422(jsonInvalidError([...loc, jsonErrorPos(msg)], msg));
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    raise422(dictTypeError(loc, raw));
  }
  return raw as Record<string, unknown>;
}

/**
 * `loc` 末位那个出错位置：Python 给的是 `JSONDecodeError.pos`。
 *
 * V8 在**长措辞**的错误里会带 `at position N`（`{"a":1` → 6，与 Python 一模一样），
 * 短措辞的（`Unexpected token 'o'`）不带，那时退回 0。这里不重写一遍 JSON 扫描器
 * 去补齐剩下那几个位置 —— 前端不读 loc，差分脚本只比键结构，为几个下标造一个会
 * 慢慢烂掉的复刻件不划算。残留差异记在文件头。
 */
function jsonErrorPos(message: string): number {
  const m = /at position (\d+)/.exec(message);
  return m === null ? 0 : Number(m[1]);
}

/** 一份上传件。`UploadFile` 的调用面只用到这两处。 */
export interface UploadLike {
  readonly filename: string;
  read(): Promise<Uint8Array>;
}

/**
 * `files: list[UploadFile]` 的等价物 —— **带 FastAPI 的那层校验**。
 *
 * 两件事必须照做，少一件就是一条静默分叉：
 *
 * 1. Hono 的 `parseBody` 要显式打开 `all` 才把同名多值收成数组，否则只留最后
 *    一个 —— 那正是"传了三份只审了一份"；
 * 2. 字段整个缺席是 `missing`，字段在但那一位是普通文本是 `value_error`
 *    （带下标的 loc）。以前这里把文本**静默跳过**，于是"字段名打错"这种最常见
 *    的调用错误会一路走到"还没有编译出模板"的 409 —— 报错指向一个完全无关的
 *    地方，人会去查模板而不是去查请求。
 */
export async function requiredUploads(
  bag: ValidationErrors,
  c: Context,
  field = "files",
): Promise<UploadLike[]> {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  } catch {
    // 非表单体（探针会送 `Content-Type: application/json`）：等同于字段缺席。
    body = {};
  }
  const raw = body[field];
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) {
    bag.add(missingError(["body", field]));
    return [];
  }
  const out: UploadLike[] = [];
  items.forEach((item, i) => {
    if (typeof item === "string") {
      bag.add(uploadTypeError(["body", field, i], item));
      return;
    }
    const f = item as File;
    out.push({
      filename: f.name,
      read: async () => new Uint8Array(await f.arrayBuffer()),
    });
  });
  return out;
}
