/**
 * ids 的 golden 校验 —— 每个向量都是 Python 侧真跑出来的，不是手抄的期望值。
 *
 * 已知差异只有一条：JSON 里的 1.0 被 JSON.parse 读成 1，TS 无从还原 Python
 * float 的"整数值带小数点"写法。含这类值的向量不跳过 —— **钉住差异的确切形状**
 * （期望串里的 `1.0` 换成 `1` 后必须全等），漂到别处立刻红。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  childId,
  contentRef,
  fingerprint,
  rid,
  sha256Hex,
  slug,
} from "../src/kernel/ids.js";

interface Golden {
  canonical_json: { in: unknown; out: string }[];
  fingerprint: { in: unknown; out: string }[];
  sha256_hex: { in: string; out: string }[];
  slug: { in: string; out: string }[];
  rid: { kind: string; name: string; out: string }[];
  content_ref: { in: string; out: string }[];
  child_id: { parent: string; parts: (string | number)[]; out: string }[];
}

/** 读 golden 必须保精度。
 *
 * Python 的 int 是任意精度，golden 里有 2**60；`JSON.parse` 会在任何 reviver
 * 看到它之前就把它压成 1152921504606847000。用 Node 21+ 的 source text access
 * 拿到**字面量原文**，超出安全整数范围的转成 BigInt —— canonicalJson 认 bigint。
 *
 * 不这么做的话，这条向量只能被跳过，而它恰好钉的是最容易在生产里静默出错的
 * 东西（大整数 id / 时间戳 / 金额分）。
 */
function parseGolden<T>(text: string): T {
  return JSON.parse(text, function (_k, v, ctx?: { source?: string }) {
    if (typeof v === "number" && ctx?.source !== undefined) {
      const src = ctx.source;
      if (/^-?\d+$/.test(src) && !Number.isSafeInteger(v)) return BigInt(src);
    }
    return v;
  }) as T;
}

const G: Golden = parseGolden(
  readFileSync(join(__dirname, "../../golden/ids.json"), "utf8"),
);

/** Python 把整数值的 float 写成 `1.0`；经 JSON.parse 之后这个区分已经消失
 * （`-0.0` 例外 —— 它带符号，我们能还原，所以**不**在这里规整）。
 * 只碰数字字面量，不碰字符串里的 "1.5"。 */
const intFloat = (s: string) =>
  s.replace(/([:,[])(\d+)\.0(?=[,}\]])/g, "$1$2");

describe("canonical_json 与 Python 字节级一致", () => {
  for (const [i, v] of G.canonical_json.entries()) {
    it(`向量 ${i}`, () => {
      expect(canonicalJson(v.in)).toBe(intFloat(v.out));
    });
  }
});

describe("fingerprint", () => {
  for (const [i, v] of G.fingerprint.entries()) {
    const exact = canonicalJson(v.in) === G.canonical_json[i]!.out;
    it(`向量 ${i}${exact ? "" : "（含整数值 float，指纹按已知差异钉住）"}`, () => {
      const got = fingerprint(v.in);
      if (canonicalJson(v.in) === G.canonical_json[i]!.out) {
        // 序列化字节相同 → 指纹必须相同
        expect(got).toBe(v.out);
      } else {
        // 序列化按已知差异分叉 → 指纹一定不同，但**分叉原因必须只有那一条**
        expect(canonicalJson(v.in)).toBe(intFloat(G.canonical_json[i]!.out));
        expect(got).not.toBe(v.out);
        expect(got).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  }
});

describe("sha256_hex（UTF-8 编码路径）", () => {
  for (const v of G.sha256_hex) {
    it(JSON.stringify(v.in), () => expect(sha256Hex(v.in)).toBe(v.out));
  }
});

describe("slug（CJK 保留、哈希兜底、截断不清尾）", () => {
  for (const v of G.slug) {
    it(JSON.stringify(v.in), () => expect(slug(v.in)).toBe(v.out));
  }
});

describe("rid / content_ref / child_id", () => {
  it("rid", () => {
    for (const v of G.rid) expect(rid(v.kind, v.name)).toBe(v.out);
  });
  it("content_ref", () => {
    for (const v of G.content_ref) expect(contentRef(v.in)).toBe(v.out);
  });
  it("child_id", () => {
    for (const v of G.child_id) expect(childId(v.parent, ...v.parts)).toBe(v.out);
  });
});

describe("Python 侧没覆盖到、但 TS 侧必须钉住的行为", () => {
  it("键排序按 code point，不按 UTF-16 code unit（代理对键）", () => {
    // "￿" (U+FFFF) vs "🐍" (U+1F40D)：code point 序是 FFFF < 1F40D，
    // 而 UTF-16 code unit 序是 D83D < FFFF —— 排反了指纹就跨不了语言。
    expect(canonicalJson({ "🐍": 1, "￿": 2 })).toBe('{"￿":2,"🐍":1}');
  });
  it("-0 写成 -0.0（Python 形态），不是 0", () => {
    expect(canonicalJson([-0])).toBe("[-0.0]");
  });
  it("非纯数据直接拒绝，不静默 [object Object]", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
//  指数记号的浮点 —— 原来的 ids.json 一条都没覆盖到
// ══════════════════════════════════════════════════════════════════
//
// `numToJson` 曾对非整数直接 `String(n)`，注释写着"与 Python repr(float) 字节
// 一致"。有效数字确实同源，但**转指数记号的阈值**和**指数补零**两边规则不同。
// golden 里没有带指数的向量，所以这个错误声明一直没被测到 —— 而 usd 成本
// （一次调用 1.2e-5 美元）正好落在这个区间，会进 effect 指纹。

interface GoldenExtra {
  floats: { in: string; out: string; fp: string }[];
  nested: { in: unknown; out: string; fp: string }[];
}

const GX: GoldenExtra = JSON.parse(
  readFileSync(join(__dirname, "../../golden/ids.extra.json"), "utf8"),
) as GoldenExtra;

describe("指数记号的浮点与 Python 逐字节一致", () => {
  for (const v of GX.floats) {
    it(v.in, () => {
      // `in` 是 Python 的 repr()，JS 的 Number() 认得（1e-05 / 1.5e-08 都合法）
      const x = Number(v.in);
      expect(canonicalJson(x)).toBe(v.out);
      expect(fingerprint(x)).toBe(v.fp);
    });
  }

  for (const [i, v] of GX.nested.entries()) {
    it(`嵌套 ${i}：${JSON.stringify(v.in).slice(0, 40)}`, () => {
      // 指纹是对整个请求对象算的，不是对裸浮点算的 —— 嵌套路径也得对
      expect(canonicalJson(v.in)).toBe(v.out);
      expect(fingerprint(v.in)).toBe(v.fp);
    });
  }

  it("String(n) 在这些点上确实是错的（防止以后被『简化』回去）", () => {
    // 反例测试：没有它，有人把 pyFloatRepr 换回 String() 时上面那些用例会红，
    // 但红的原因看起来像"golden 过时了"。这条把原因钉死。
    expect(String(1e-5)).toBe("0.00001");
    expect(canonicalJson(1e-5)).toBe("1e-05");
    expect(String(1e-7)).toBe("1e-7"); // 指数不补零
    expect(canonicalJson(1e-7)).toBe("1e-07");
  });
});
