/**
 * FastAPI / pydantic 的 422 校验响应形状。
 *
 * 这个文件钉的是一件**不会崩、不会红、只会静默变空白**的事：
 *
 *   FastAPI 的 422 body 是 `{"detail": [ …错误数组… ]}`，不是 `{"detail": "一句话"}`。
 *
 * 前端有两处逐字读 `d.detail`（原 `ui/index.html:1598` / `:1728`）：字符串走
 * "直接显示"，数组走另一条渲染路径。给错形状不会报错 —— 只会让错误提示框里
 * 什么都没有，或者显示 `[object Object]`。所以下面每条断言都先问一句
 * **`Array.isArray(detail)`**，再看四元组的内容。
 *
 * 期望值全部来自**真起 uvicorn 逐个 curl 问出来的**响应（见 http422.ts 文件头
 * 记的那几条反直觉行为），不是照 pydantic 文档写的。
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  boolParsingError,
  dictTypeError,
  intParsingError,
  jsonObjectBody,
  missingError,
  optionalBoolQuery,
  optionalIntQuery,
  pydanticBool,
  pydanticInt,
  raise422,
  requiredIntQuery,
  requiredUploads,
  uploadTypeError,
  validationException,
  ValidationErrors,
  type PydanticError,
} from "../src/server/http422.js";

const ROOT = join(tmpdir(), `ontocopilot-http422-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

/** 一次响应的 detail，断言它**是数组**之后再交出去。 */
async function detailArray(res: Response): Promise<PydanticError[]> {
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { detail: unknown };
  expect(Array.isArray(body.detail)).toBe(true);
  return body.detail as PydanticError[];
}

/** 最小的查询参数上下文 —— `requiredIntQuery` 那几个只碰 `c.req.query`。 */
function qctx(qs: Record<string, string>): { req: { query(n: string): string | undefined } } {
  return { req: { query: (n) => qs[n] } };
}

/** 抓住 `raise422` 抛出的那个 `HTTPException`，取它的响应。 */
function thrownResponse(fn: () => unknown): Response {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse: () => Response }).getResponse();
  }
  throw new Error("期望抛出 422，但什么都没抛");
}

// ══════════════════════════════════════════════════════════════════
//  四元组本身
// ══════════════════════════════════════════════════════════════════

describe("pydantic 错误四元组", () => {
  it("必填缺失：input 是 null 而不是省略键", async () => {
    const res = thrownResponse(() => raise422(missingError(["query", "seq"])));
    const detail = await detailArray(res);
    expect(detail).toEqual([
      { type: "missing", loc: ["query", "seq"], msg: "Field required", input: null },
    ]);
    // `input: null` 必须真的出现在 JSON 里 —— 省略它前端就分不清"没传"和"传了 null"。
    expect(JSON.stringify(detail[0])).toContain('"input":null');
  });

  it("类型不对：int_parsing 带原始输入串", async () => {
    const detail = await detailArray(
      thrownResponse(() => raise422(intParsingError(["query", "seq"], "abc"))),
    );
    expect(detail).toEqual([
      {
        type: "int_parsing",
        loc: ["query", "seq"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
    ]);
  });

  it("类型不对：bool_parsing 带原始输入串", async () => {
    const detail = await detailArray(
      thrownResponse(() => raise422(boolParsingError(["query", "apply"], "maybe"))),
    );
    expect(detail[0]).toEqual({
      type: "bool_parsing",
      loc: ["query", "apply"],
      msg: "Input should be a valid boolean, unable to interpret input",
      input: "maybe",
    });
  });

  it("dict_type 的 loc 不带下标（json_invalid 才带）", async () => {
    const detail = await detailArray(thrownResponse(() => raise422(dictTypeError(["body"], [1]))));
    expect(detail[0]?.loc).toEqual(["body"]);
    expect(detail[0]?.type).toBe("dict_type");
  });

  it("上传件收到文本：value_error 的 loc 带下标，ctx.error 是空对象", async () => {
    const detail = await detailArray(
      thrownResponse(() => raise422(uploadTypeError(["body", "files", 0], "hello"))),
    );
    expect(detail[0]?.loc).toEqual(["body", "files", 0]);
    // Python 那边 ctx.error 是异常对象，jsonable_encoder 编成 `{}`。键在、值空。
    expect(detail[0]?.ctx).toEqual({ error: {} });
  });

  it("多条错误一次回，顺序保持加入顺序", async () => {
    const bag = new ValidationErrors();
    expect(bag.length).toBe(0);
    bag.add(boolParsingError(["query", "apply"], "maybe"));
    bag.add(missingError(["body", "files"]));
    expect(bag.length).toBe(2);
    const detail = await detailArray(
      thrownResponse(() => {
        bag.raise();
      }),
    );
    expect(detail.map((e) => e.type)).toEqual(["bool_parsing", "missing"]);
  });

  it("没有错误时 raise() 什么都不做", () => {
    expect(() => new ValidationErrors().raise()).not.toThrow();
  });

  it("validationException 的 message 只进日志，body 仍是数组", async () => {
    const exc = validationException([missingError(["query", "seq"])]);
    expect(exc.message).toBe("query.seq: Field required");
    const detail = await detailArray(exc.getResponse());
    expect(detail).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  标量解析（真问出来的接受集）
// ══════════════════════════════════════════════════════════════════

describe("pydanticInt：lax 模式的 str -> int", () => {
  // 左边这批在 Python 侧 **不是** 422（真 curl 过），右边是解析结果。
  const ok: [string, number][] = [
    ["1", 1],
    ["007", 7],
    ["-0", 0],
    ["+5", 5],
    ["  12  ", 12],
    ["\t5\n", 5],
    // 反直觉之一：小数部分全 0 会被截掉。
    ["1.0", 1],
    ["2.0000", 2],
    ["-1.0", -1],
    ["+1.0", 1],
    ["0002.0", 2],
    ["1.00000000000000000000", 1],
    // 反直觉之二：下划线按 Python `int()` 的规则认，且只允许在整数部分。
    ["1_000", 1000],
    ["1_0.0", 10],
  ];
  for (const [raw, want] of ok) {
    it(`认 ${JSON.stringify(raw)} -> ${want}`, () => {
      expect(pydanticInt(raw)).toBe(want);
    });
  }

  // 这批在 Python 侧是 int_parsing 的 422。
  const bad = [
    "abc",
    "",
    "  ",
    "1e3",
    "1E3",
    "3.0e2",
    "1.0e0",
    "0x10",
    "1.",
    ".5",
    "1.5",
    "1.0.0",
    "inf",
    "nan",
    "1e400",
    "1 000",
    "1__0",
    "_1",
    "1_",
    "+_1",
    "1.000_0", // 小数部分里的下划线不认
    "true",
    "１", // 全角数字：Python 的 int() 认，pydantic 不认
  ];
  for (const raw of bad) {
    it(`不认 ${JSON.stringify(raw)}`, () => {
      expect(pydanticInt(raw)).toBeNull();
    });
  }
});

describe("pydanticBool：lax 模式的 str -> bool", () => {
  for (const raw of ["1", "on", "t", "true", "y", "yes", "TRUE", "oN", "Y"]) {
    it(`${JSON.stringify(raw)} 是真`, () => expect(pydanticBool(raw)).toBe(true));
  }
  for (const raw of ["0", "off", "f", "false", "n", "no", "F", "No"]) {
    it(`${JSON.stringify(raw)} 是假`, () => expect(pydanticBool(raw)).toBe(false));
  }
  // **不 trim** —— 与整数那条不对称，但这是真问出来的行为。改成 trim 会让一次
  // 带空格的 `purge=true` 从"报错"变成"真的彻底删除"。
  for (const raw of [" true ", "true ", "2", "1.0", "0.0", "", "maybe"]) {
    it(`${JSON.stringify(raw)} 解析不出来`, () => expect(pydanticBool(raw)).toBeNull());
  }
});

// ══════════════════════════════════════════════════════════════════
//  查询参数的封装
// ══════════════════════════════════════════════════════════════════

describe("查询参数", () => {
  it("必填整数缺席 -> missing", async () => {
    const detail = await detailArray(thrownResponse(() => requiredIntQuery(qctx({}), "seq")));
    expect(detail[0]).toEqual({
      type: "missing",
      loc: ["query", "seq"],
      msg: "Field required",
      input: null,
    });
  });

  it("必填整数坏值 -> int_parsing", async () => {
    const detail = await detailArray(
      thrownResponse(() => requiredIntQuery(qctx({ seq: "abc" }), "seq")),
    );
    expect(detail[0]?.type).toBe("int_parsing");
    expect(detail[0]?.input).toBe("abc");
  });

  it("有默认值的整数：缺席取默认，坏值仍 422", async () => {
    expect(optionalIntQuery(qctx({}), "days", 30)).toBe(30);
    expect(optionalIntQuery(qctx({ days: "7" }), "days", 30)).toBe(7);
    const detail = await detailArray(
      thrownResponse(() => optionalIntQuery(qctx({ days: "abc" }), "days", 30)),
    );
    expect(detail[0]?.loc).toEqual(["query", "days"]);
  });

  it("有默认值的布尔：缺席取默认，坏值 422", async () => {
    expect(optionalBoolQuery(qctx({}), "materials", true)).toBe(true);
    expect(optionalBoolQuery(qctx({ materials: "no" }), "materials", true)).toBe(false);
    const detail = await detailArray(
      thrownResponse(() => optionalBoolQuery(qctx({ materials: "zz" }), "materials", true)),
    );
    expect(detail[0]?.type).toBe("bool_parsing");
  });
});

// ══════════════════════════════════════════════════════════════════
//  请求体
// ══════════════════════════════════════════════════════════════════

describe("jsonObjectBody", () => {
  const bctx = (text: string) => ({ req: { text: async () => text } });

  it("正常对象直接给回来", async () => {
    expect(await jsonObjectBody(bctx('{"a":1}'))).toEqual({ a: 1 });
  });

  it("空体 -> missing（不是 json_invalid）", async () => {
    // FastAPI 在 `json.loads` **之前**先判 `if body_bytes`，空体走必填缺失那条。
    // 混成 json_invalid 会让前端把"你什么都没发"说成"你发的 JSON 坏了"。
    let res: Response | undefined;
    try {
      await jsonObjectBody(bctx(""));
    } catch (e) {
      res = (e as { getResponse: () => Response }).getResponse();
    }
    const detail = await detailArray(res as Response);
    expect(detail[0]).toEqual({
      type: "missing",
      loc: ["body"],
      msg: "Field required",
      input: null,
    });
  });

  it("坏 JSON -> json_invalid，loc 带那个 0", async () => {
    let res: Response | undefined;
    try {
      await jsonObjectBody(bctx("nope"));
    } catch (e) {
      res = (e as { getResponse: () => Response }).getResponse();
    }
    const detail = await detailArray(res as Response);
    expect(detail[0]?.type).toBe("json_invalid");
    expect(detail[0]?.loc).toEqual(["body", 0]);
    expect(detail[0]?.msg).toBe("JSON decode error");
    expect(detail[0]?.input).toEqual({});
    // ctx.error 的**措辞**两侧不同（Python `json` vs V8），键在即可。
    expect(Object.keys(detail[0]?.ctx ?? {})).toEqual(["error"]);
  });

  it("坏 JSON：V8 报了位置时 loc 末位跟着走", async () => {
    // `{"a":1` 在两边都是 6 —— V8 的 `at position 6` 与 Python 的
    // `JSONDecodeError.pos` 正好对上。短措辞的错误 V8 不报位置，退回 0。
    const posOf = async (text: string): Promise<unknown> => {
      try {
        await jsonObjectBody(bctx(text));
      } catch (e) {
        const body = (await (e as { getResponse: () => Response }).getResponse().json()) as {
          detail: PydanticError[];
        };
        return body.detail[0]?.loc[1];
      }
      throw new Error("期望抛出 422");
    };
    expect(await posOf('{"a":1')).toBe(6);
    expect(await posOf('{"a":1}x')).toBe(7);
    expect(await posOf("{a:1}")).toBe(1);
    expect(await posOf("nope")).toBe(0);
  });

  it("合法 JSON 但不是对象 -> dict_type，input 是原值", async () => {
    let res: Response | undefined;
    try {
      await jsonObjectBody(bctx("[1]"));
    } catch (e) {
      res = (e as { getResponse: () => Response }).getResponse();
    }
    const detail = await detailArray(res as Response);
    expect(detail[0]?.type).toBe("dict_type");
    expect(detail[0]?.loc).toEqual(["body"]);
    expect(detail[0]?.input).toEqual([1]);
  });
});

describe("requiredUploads", () => {
  /** 起一个只做上传校验的最小 app，省得把整条 audit 路由拖进来。 */
  function uploadApp(): Hono {
    const app = new Hono();
    app.post("/u", async (c) => {
      const bag = new ValidationErrors();
      const files = await requiredUploads(bag, c);
      bag.raise();
      return c.json({ names: files.map((f) => f.filename) });
    });
    return app;
  }

  it("表单里没有 files 字段 -> missing", async () => {
    const form = new FormData();
    form.append("x", "1");
    const res = await uploadApp().request("/u", { method: "POST", body: form });
    const detail = await detailArray(res);
    expect(detail).toEqual([
      { type: "missing", loc: ["body", "files"], msg: "Field required", input: null },
    ]);
  });

  it("根本不是表单体（JSON）也算 missing，不是 500", async () => {
    // 差分脚本就是这么问的：`-H 'Content-Type: application/json' -d '{}'`。
    // 以前这里把它当成"空列表"一路走到"还没有编译出模板"的 409 —— 报错指向
    // 一个完全无关的地方。
    const res = await uploadApp().request("/u", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const detail = await detailArray(res);
    expect(detail[0]?.type).toBe("missing");
    expect(detail[0]?.loc).toEqual(["body", "files"]);
  });

  it("files 那一位是普通文本 -> value_error，loc 带下标", async () => {
    const form = new FormData();
    form.append("files", "hello");
    const res = await uploadApp().request("/u", { method: "POST", body: form });
    const detail = await detailArray(res);
    expect(detail[0]?.type).toBe("value_error");
    expect(detail[0]?.loc).toEqual(["body", "files", 0]);
    expect(detail[0]?.input).toBe("hello");
  });

  it("同名多值全收，不折成最后一个", async () => {
    const form = new FormData();
    form.append("files", new File([new Uint8Array([1])], "一.xlsx"));
    form.append("files", new File([new Uint8Array([2])], "二.xlsx"));
    const res = await uploadApp().request("/u", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: ["一.xlsx", "二.xlsx"] });
  });

  it("真文件的字节能读回来", async () => {
    const app = new Hono();
    app.post("/u", async (c) => {
      const bag = new ValidationErrors();
      const files = await requiredUploads(bag, c);
      bag.raise();
      const bytes = await files[0]!.read();
      return c.json({ bytes: [...bytes] });
    });
    const form = new FormData();
    form.append("files", new File([new Uint8Array([7, 8, 9])], "a.bin"));
    const res = await app.request("/u", { method: "POST", body: form });
    expect(await res.json()).toEqual({ bytes: [7, 8, 9] });
  });
});

// ══════════════════════════════════════════════════════════════════
//  真路由：差分脚本里那两条
// ══════════════════════════════════════════════════════════════════

describe("接线：artifacts 段的两条 422", () => {
  // 路由体不会跑到（校验在 `sessAsync` 之前），所以 deps 全给假的就够。
  const deps = {
    exportModule: {
      resolveFormat: () => "xlsx",
      tableBlock: () => ({}) as never,
      makeDoc: () => ({ title: "x" }) as never,
      render: () => [new Uint8Array(), { ext: "xlsx", media_type: "x", label: "x" }] as never,
      safeName: () => "x.xlsx",
    },
    parseRegistry: { parse: async () => ({ chunks: [] }) },
    persist: async () => {},
    recompile: async () => {},
    sessionMutation: async (_s: unknown, _k: string, body: () => unknown) => body(),
  };

  async function app(): Promise<Hono> {
    const { registerArtifactRoutes } = await import("../src/server/routes/artifacts.js");
    const a = new Hono();
    registerArtifactRoutes(a, deps as never);
    return a;
  }

  it("GET /export 少 seq -> loc ['query','seq'] 的 missing", async () => {
    const res = await (await app()).request("/api/sessions/zzz/export");
    const detail = await detailArray(res);
    expect(detail).toEqual([
      { type: "missing", loc: ["query", "seq"], msg: "Field required", input: null },
    ]);
  });

  it("GET /export seq 不是整数 -> int_parsing", async () => {
    const res = await (await app()).request("/api/sessions/zzz/export?seq=abc");
    const detail = await detailArray(res);
    expect(detail[0]?.type).toBe("int_parsing");
    expect(detail[0]?.input).toBe("abc");
  });

  it("GET /source 少 file -> missing", async () => {
    const res = await (await app()).request("/api/sessions/zzz/source");
    const detail = await detailArray(res);
    expect(detail[0]?.loc).toEqual(["query", "file"]);
  });

  it("POST /audit 不带 files -> 422 missing（以前是 409『还没有编译出模板』）", async () => {
    const res = await (await app()).request("/api/sessions/zzz/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const detail = await detailArray(res);
    expect(detail).toEqual([
      { type: "missing", loc: ["body", "files"], msg: "Field required", input: null },
    ]);
  });

  it("POST /audit query 与 body 同时错：两条都回，query 在前", async () => {
    // FastAPI 解依赖是 path -> query -> body，所以顺序不是随便的。
    const res = await (await app()).request("/api/sessions/zzz/audit?apply=maybe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const detail = await detailArray(res);
    expect(detail.map((e) => [e.type, e.loc])).toEqual([
      ["bool_parsing", ["query", "apply"]],
      ["missing", ["body", "files"]],
    ]);
  });

  it("校验先于取会话：会话不存在时仍是 422 而不是 404", async () => {
    const res = await (await app()).request("/api/sessions/根本没有这个会话/export");
    expect(res.status).toBe(422);
  });
});
