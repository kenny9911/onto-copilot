/**
 * kernel/llm.ts + kernel/backends.ts —— 期望值全部来自 `golden/llm.json`
 * （`tools/golden/llm.py` 导出，Python 真跑出来的）。
 *
 * 手写期望值在这两个模块上尤其危险：账目错了不报错，只是数字不对。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { Difficulty } from "../src/kernel/dag.js";
import { EventKind } from "../src/kernel/events.js";
import {
  AnthropicBackend,
  FetchAnthropicClient,
  OpenAICompatBackend,
  RETRYABLE_STATUS,
  SseDecoder,
  STREAM_THRESHOLD,
  assembleAnthropicStream,
  looksLikeQuotaExhausted,
  offendingField,
  parseSseFrame,
  pyFloat,
  raiseIfQuota,
  strictify,
  type AnthropicClientLike,
  type AnthropicMessage,
} from "../src/kernel/backends.js";
import {
  GATEWAY_MODELS,
  JsonShapeError,
  ModelError,
  ModelGateway,
  ModelRefusal,
  ModelTruncated,
  PRODUCTION_MODELS,
  QuotaExhausted,
  RoutingTable,
  ScriptedBackend,
  TIER_EFFORT,
  TIER_KEYS,
  Usage,
  gatewayRouting,
  looksTruncated,
  makeModelSpec,
  modelCost,
  parseModelJson,
  productionRouting,
  stubRouting,
  usageCost,
  validateAgainstSchema,
  type CatalogLike,
  type Completion,
  type GenerateArgs,
  type LLMBackend,
  type LlmRecorder,
  type ModelSpec,
  type UsageSinkRow,
} from "../src/kernel/llm.js";

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../golden/llm.json", import.meta.url)), "utf8"),
) as Record<string, any>;

const SPEC = makeModelSpec({
  name: "test-model",
  tier: "mid",
  usd_per_mtok_in: 3.0,
  usd_per_mtok_out: 15.0,
  effort: "medium",
});

// ══════════════════════════════════════════════════════════════════
//  测试替身
// ══════════════════════════════════════════════════════════════════

interface RecordedEvent {
  kind: EventKind;
  nodeId: string | undefined;
  payload: Record<string, unknown>;
}

/**
 * Recorder 的最小替身（`kernel/recorder.ts` 还没落地）。
 *
 * 只复刻网关依赖的两件事：**首次执行时跑 do() 并记下结果**、**重放时直接返回历史
 * 结果且不跑 do()**。第二条正是 golden 里 `gateway_replay` 要钉的东西 —— 重放
 * 时如果 do() 又跑一遍，账单就翻倍。
 *
 * 结果按 JSON 往返一次再返回：真 Recorder 从 blob/journal 读回来的就是 JSON，
 * 把这一步省掉会让 TS 侧"恰好因为拿到同一个对象引用"而通过。
 */
class FakeJournal {
  readonly events: RecordedEvent[] = [];
  readonly effects = new Map<string, unknown>();
}

class FakeRecorder implements LlmRecorder {
  readonly runId: string;
  readonly journal: FakeJournal;
  private readonly counters = new Map<string, number>();

  constructor(runId: string, journal = new FakeJournal()) {
    this.runId = runId;
    this.journal = journal;
  }

  emit(kind: EventKind, opts: { nodeId?: string; payload?: Record<string, unknown> }): null {
    this.journal.events.push({
      kind,
      nodeId: opts.nodeId,
      payload: opts.payload ?? {},
    });
    return null;
  }

  async effect(
    nodeId: string,
    _kind: string,
    _request: Record<string, unknown>,
    fn: () => unknown | Promise<unknown>,
    opts?: { key?: string | null },
  ): Promise<unknown> {
    let ekey: string;
    if (opts?.key == null) {
      const idx = this.counters.get(nodeId) ?? 0;
      this.counters.set(nodeId, idx + 1);
      ekey = `${nodeId}#${idx}`;
    } else {
      ekey = `${nodeId}#${opts.key}`;
    }
    if (this.journal.effects.has(ekey)) {
      return JSON.parse(JSON.stringify(this.journal.effects.get(ekey)));
    }
    const result = await fn();
    this.journal.effects.set(ekey, result);
    return result;
  }
}

type ScriptItem = readonly [string, Usage] | Error;

/** 按脚本产出，逐次记录**真打出去的**请求 —— 与导出脚本里的 `_Sequenced` 同形。 */
class SequencedBackend implements LLMBackend {
  readonly calls: { model: string; prompt: string; max_tokens: number; schema: boolean }[] = [];

  constructor(private readonly script: readonly ScriptItem[]) {}

  generate(args: GenerateArgs): Promise<[string, Usage]> {
    const item = this.script[Math.min(this.calls.length, this.script.length - 1)]!;
    this.calls.push({
      model: args.model.name,
      prompt: args.prompt,
      max_tokens: args.maxTokens ?? 16_000,
      schema: (args.schema ?? null) !== null,
    });
    if (item instanceof Error) return Promise.reject(item);
    return Promise.resolve([item[0], item[1]]);
  }
}

function completionDict(c: Completion): Record<string, unknown> {
  return {
    text: c.text,
    data: c.data,
    model: c.model,
    usage: c.usage.toDict(),
    usd: c.usd,
    attempts: c.attempts,
  };
}

function spentEvents(j: FakeJournal): Record<string, unknown>[] {
  return j.events.filter((e) => e.kind === EventKind.BUDGET_SPENT).map((e) => e.payload);
}

function specDict(s: ModelSpec): Record<string, unknown> {
  return {
    name: s.name,
    tier: s.tier,
    usd_per_mtok_in: s.usd_per_mtok_in,
    usd_per_mtok_out: s.usd_per_mtok_out,
    effort: s.effort,
    thinking: s.thinking,
  };
}

function routingDict(r: RoutingTable): Record<string, unknown> {
  const byDiff = (m: Partial<Record<Difficulty, unknown>>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const d of [Difficulty.LOW, Difficulty.MEDIUM, Difficulty.HIGH, Difficulty.CRITICAL]) {
      if (m[d] !== undefined) out[d] = m[d];
    }
    return out;
  };
  const models: Record<string, unknown> = {};
  for (const [d, s] of Object.entries(r.models)) {
    if (s !== undefined) models[d] = specDict(s);
  }
  return {
    models,
    judges: r.judges.map(specDict),
    fast: r.fast === null ? null : specDict(r.fast),
    max_iterations: byDiff(r.maxIterations),
    critic_rounds: byDiff(r.criticRounds),
    self_consistency: byDiff(r.selfConsistency),
  };
}

/** golden 里导出的目录卡片 → `CatalogLike`。 */
const CATALOG: CatalogLike = {
  get(name: string) {
    const raw = (GOLDEN["catalog_cards"] as Record<string, any>)[name];
    return raw === undefined ? null : { spec: raw as ModelSpec };
  },
};

// ══════════════════════════════════════════════════════════════════
//  常量与定价
// ══════════════════════════════════════════════════════════════════
describe("常量", () => {
  it("与 Python 一致", () => {
    const c = GOLDEN["constants"];
    expect(STREAM_THRESHOLD).toBe(c.stream_threshold);
    expect([...RETRYABLE_STATUS].sort((a, b) => a - b)).toEqual(c.retryable_status);
    expect(TIER_KEYS).toEqual(c.tier_keys);
    expect(TIER_EFFORT).toEqual(c.tier_effort);
  });

  it("base_url 去掉末尾斜杠（Python 的 rstrip('/')）", () => {
    const be = new OpenAICompatBackend("http://gw.test/v1/", "sk-x");
    expect(be.baseUrl).toBe(GOLDEN["constants"].base_url_rstrip);
    expect(new OpenAICompatBackend("http://gw.test/v1///", "k").baseUrl).toBe(
      "http://gw.test/v1",
    );
  });
});

describe("ModelSpec.cost", () => {
  it("含缓存计价，逐字节等于 Python", () => {
    for (const c of GOLDEN["cost"] as any[]) {
      const spec = c.spec as ModelSpec;
      expect(modelCost(spec, c.tok_in, c.tok_out, c.cache_read, c.cache_write)).toBe(c.usd);
    }
  });

  it("makeModelSpec 的默认值：effort=high / thinking=true，且 null 不被默认值顶掉", () => {
    const d = makeModelSpec({
      name: "m",
      tier: "mid",
      usd_per_mtok_in: 1,
      usd_per_mtok_out: 2,
    });
    expect([d.effort, d.thinking]).toEqual(["high", true]);
    // effort: null 是"这个模型不支持 effort"的显式声明。被 `||` 悄悄改回 "high"
    // 就是每次请求 400 —— 这条断言是那个 bug 的绊线。
    const flash = makeModelSpec({
      name: "f",
      tier: "mid",
      usd_per_mtok_in: 1,
      usd_per_mtok_out: 2,
      effort: null,
      thinking: null,
    });
    expect([flash.effort, flash.thinking]).toEqual([null, null]);
  });
});

describe("Usage", () => {
  it("total / toDict 与 Python 一致", () => {
    for (const c of GOLDEN["usage"] as any[]) {
      const u = new Usage(c.init);
      expect(u.total).toBe(c.total);
      expect(u.toDict()).toEqual(c.to_dict);
    }
  });

  it("usd=null 表示「网关没给」，不是零元", () => {
    const u = new Usage({ tok_in: 1000, tok_out: 0 });
    expect(u.usd).toBeNull();
    expect(usageCost(SPEC, u)).toBe(modelCost(SPEC, 1000, 0, 0, 0));
    // 有网关账单就直接用它，不再按本地价目表算
    expect(usageCost(SPEC, new Usage({ tok_in: 1000, usd: 0.42 }))).toBe(0.42);
    // 0 是个**真实的账单金额**，不能被当成"没给"
    expect(usageCost(SPEC, new Usage({ tok_in: 1000, usd: 0 }))).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  截断判据
// ══════════════════════════════════════════════════════════════════
describe("looksTruncated", () => {
  it("Python 时代的字符串（CPython json 的报错 + 我们自己的中文）分类不变", () => {
    for (const c of GOLDEN["looks_truncated"] as any[]) {
      expect(looksTruncated(c.err), c.err).toBe(c.out);
    }
  });

  it("V8 的 JSON 报错也要认出来 —— 否则「截断就加大预算」静默失效", () => {
    // 这四条是 CPython 那四条的对应物。少了它们，TS 侧遇到截断只会用同样的预算
    // 重试三次然后整条链路失败，而账上看起来一切正常。
    for (const bad of ["", "{", '{"a":', '{"a": "b', "[1,2", '{"a":1,}']) {
      let msg = "";
      try {
        JSON.parse(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(looksTruncated(msg), `${bad} → ${msg}`).toBe(true);
    }
  });

  it("真·格式错误不该被当成截断（那样只会白花更多钱）", () => {
    expect(looksTruncated("字段 foo 不是 string")).toBe(false);
    expect(looksTruncated("$ 应为 object，实际 list")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  结构化输出：解析
// ══════════════════════════════════════════════════════════════════
function classify(msg: string): string {
  if (msg === "输出里找不到 JSON") return "not_found";
  if (msg === "JSON 不完整（输出被截断）") return "incomplete";
  if (msg.startsWith("JSON 解析失败: ")) return "decode";
  return "other";
}

describe("parseModelJson", () => {
  it("golden 的分支矩阵：成功值逐个相等，失败按分类 + 截断判定相等", () => {
    for (const c of GOLDEN["parse_json"] as any[]) {
      if (c.ok && c.nonfinite) continue; // 见下面那条专门的分叉用例
      if (c.ok) {
        expect(parseModelJson(c.text), JSON.stringify(c.text)).toEqual(c.value);
        continue;
      }
      let msg = "";
      expect(() => {
        try {
          parseModelJson(c.text);
        } catch (e) {
          msg = (e as Error).message;
          throw e;
        }
      }, JSON.stringify(c.text)).toThrow(JsonShapeError);
      // CPython 与 V8 的 JSON 报错文案完全不同，字符串没法直接比 —— 但**分类**与
      // **是不是截断**必须一致，那两个才是判据。
      expect(classify(msg), JSON.stringify(c.text)).toBe(c.error_kind);
      expect(looksTruncated(msg), `${JSON.stringify(c.text)} → ${msg}`).toBe(c.truncated);
      // 我们自己写的两条消息要逐字一致（它们会原样喂回给模型）
      if (c.error_kind !== "decode") expect(msg).toBe(c.message);
    }
  });

  it("真实事故：回答内容里的 ```json 范例不许把外层结构顶掉", () => {
    // 无条件先抠围栏（而 FENCE 是全文搜索）会拿范例去当结构化输出解析，连撞三次
    // 报「Expecting property name…」。问 JSON/代码问题必挂，正常路径反而没事。
    const got = parseModelJson(
      JSON.stringify({
        thought: "给他一份 schema 范例",
        answer: '可以这样写：\n```json\n{\n  "type": "object"\n}\n```\n照着改。',
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(got)).toContain("thought");
    expect(String(got["answer"])).toContain("```json");
  });

  it("【已知分叉】CPython 认 NaN / Infinity 字面量，JSON.parse 不认", () => {
    // 钉住分叉的确切形状（契约 §3）：Python 侧 `_parse_json("NaN")` 返回 float nan，
    // TS 侧只能报"输出里找不到 JSON"。修不了 —— 除非自己写一个 JSON 解析器。
    // 后果是可接受的：模型吐 `Infinity` 本来就是坏输出，TS 侧当解析失败去重试。
    const nan = (GOLDEN["parse_json"] as any[]).find((c) => c.text === "NaN");
    expect(nan.ok).toBe(true);
    expect(nan.value).toBe("__nan__");
    expect(() => parseModelJson("NaN")).toThrow("输出里找不到 JSON");

    const inf = (GOLDEN["parse_json"] as any[]).find((c) => c.text === '{"x": Infinity}');
    expect(inf.ok).toBe(true);
    expect(() => parseModelJson('{"x": Infinity}')).toThrow(/^JSON 解析失败: /);
  });
});

// ══════════════════════════════════════════════════════════════════
//  结构化输出：校验
// ══════════════════════════════════════════════════════════════════
/**
 * 已知分叉：JS 里 `2` 与 `2.0` 是同一个值，Python 分得出（golden 里那两条数据
 * 写的是 `2.0`）。值是 **TS 侧**该有的结果 —— 断言分叉本身，而不是跳过用例。
 */
const INT_FLOAT_DIVERGENCE: {
  match: (c: any) => boolean;
  ok: boolean;
  message?: string;
}[] = [
  { match: (c) => c.data === 2 && c.schema.type === "integer", ok: true },
  {
    match: (c) => c.data === 2 && c.schema.type === "object",
    ok: false,
    message: "$ 应为 object，实际 int",
  },
];

describe("validateAgainstSchema", () => {
  it("golden 的判定与报错文案（这些字符串会原样进重试提示词）", () => {
    for (const c of GOLDEN["validate"] as any[]) {
      const key = `${JSON.stringify(c.data)}|${JSON.stringify(c.schema)}`;
      const div = INT_FLOAT_DIVERGENCE.find((d) => d.match(c));
      const run = (): void => validateAgainstSchema(c.data, c.schema);

      if (div !== undefined) {
        // 分叉：golden 说的和 TS 该做的不一样，两边都断言，别只断言一边。
        // 这一条是绊线 —— 哪天两边真一致了（比如换了个能分辨 int/float 的解析器），
        // 它会红，提醒把这条特例删掉，而不是让特例一直挂着掩盖回归。
        const stillDivergent = div.ok !== c.ok || (!div.ok && div.message !== c.message);
        expect(stillDivergent, `分叉用例 ${key} 已经不分叉了，请删掉这条特例`).toBe(true);
        if (div.ok) {
          expect(run).not.toThrow();
        } else {
          expect(run).toThrow(div.message);
        }
        continue;
      }

      if (c.ok) {
        expect(run, key).not.toThrow();
      } else {
        let err: JsonShapeError | null = null;
        try {
          run();
        } catch (e) {
          err = e as JsonShapeError;
        }
        expect(err, key).toBeInstanceOf(JsonShapeError);
        expect(err!.message, key).toBe(c.message);
        // Python 抛的是 ValueError 还是 TypeError 也要一致：调用点是
        // `except (ValueError, TypeError)`，将来若有人只接一种，形状得对得上。
        expect(err!.pyType, key).toBe(c.exc);
      }
    }
  });

  it("required 只看自有键 —— `in` 会翻原型链", () => {
    // `"constructor" in {}` 在 JS 是 true。照抄 Python 的 `req not in data` 会让
    // 一个缺 constructor 字段的对象静默通过。
    expect(() =>
      validateAgainstSchema({}, { type: "object", required: ["constructor"] }),
    ).toThrow("$ 缺少必填字段 'constructor'");
    expect(() =>
      validateAgainstSchema({}, { type: "object", required: ["toString"] }),
    ).toThrow("$ 缺少必填字段 'toString'");
  });

  it("空 items / 空 enum 在 Python 是假值 → 不查", () => {
    // JS 里 `{}` 和 `[]` 都是真值，照抄 `if (x)` 会把"不查"变成"查"。
    expect(() => validateAgainstSchema([1, "x"], { type: "array", items: {} })).not.toThrow();
    expect(() => validateAgainstSchema("随便", { enum: [] })).not.toThrow();
  });

  it("enum 按 Python 的 == 比：容器结构相等、True == 1", () => {
    expect(() => validateAgainstSchema({ a: 1 }, { enum: [{ a: 1 }] })).not.toThrow();
    expect(() => validateAgainstSchema(1, { enum: [true] })).not.toThrow();
    expect(() => validateAgainstSchema({ a: 2 }, { enum: [{ a: 1 }] })).toThrow(/不在允许集合/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  strictify
// ══════════════════════════════════════════════════════════════════
describe("strictify", () => {
  it("golden：required 列全、additionalProperties=false、递归", () => {
    for (const c of GOLDEN["strictify"] as any[]) {
      expect(strictify(c.in), JSON.stringify(c.in)).toEqual(c.out);
    }
  });

  it("required 按 code point 排（JS 默认 sort 按 UTF-16 code unit，星平面会跑到前面）", () => {
    const out = strictify({
      type: "object",
      properties: { z: {}, 中: {}, "\u{1F600}": {}, "￿": {}, A: {} },
    });
    expect(out["required"]).toEqual(["A", "z", "中", "￿", "\u{1F600}"]);
    // 默认 sort 会把 emoji（高代理 0xD83D）排在 U+FFFF 前面 —— 这条对照说明
    // 上面那个顺序不是碰巧。
    expect(["A", "z", "中", "￿", "\u{1F600}"].slice().sort()).not.toEqual(out["required"]);
  });

  it("不改原对象，且非 object/array 原样返回", () => {
    const src = { type: "object", properties: { a: { type: "string" } } };
    const copy = JSON.parse(JSON.stringify(src));
    strictify(src);
    expect(src).toEqual(copy);
    const leaf = { type: "string", enum: ["a"] };
    expect(strictify(leaf)).toBe(leaf);
  });
});

// ══════════════════════════════════════════════════════════════════
//  欠费判定
// ══════════════════════════════════════════════════════════════════
describe("looksLikeQuotaExhausted", () => {
  it("golden 的判定矩阵（两个方向都钉）", () => {
    for (const c of GOLDEN["quota_judgement"] as any[]) {
      expect(looksLikeQuotaExhausted(c.status, c.body), `${c.status} ${c.body}`).toBe(c.out);
    }
  });

  it("判据看的是整个 body，不只是 message", () => {
    // 真实网关的欠费 429：message 写得跟限流一模一样，只有 type/code 说了实话。
    const real = (GOLDEN["quota_judgement"] as any[]).find(
      (c) => c.status === 429 && String(c.body).includes("insufficient_user_quota"),
    );
    expect(real.out).toBe(true);
    const messageOnly = JSON.stringify({
      error: { message: JSON.parse(real.body).error.message },
    });
    expect(looksLikeQuotaExhausted(429, messageOnly)).toBe(false);
  });
});

describe("QuotaExhausted / ModelRefusal 的消息", () => {
  it("golden 逐字一致，detail 按**码点**截断到 300", () => {
    for (const c of GOLDEN["errors"].quota_exhausted as any[]) {
      const exc = new QuotaExhausted(c.model, c.detail, c.status);
      expect(exc.message).toBe(c.message);
      expect(exc.detail).toBe(c.detail_out);
      expect([...exc.detail].length).toBe(c.detail_len);
    }
  });

  it("refusal 的 category 空串也落到「未标注」", () => {
    for (const c of GOLDEN["errors"].refusal as any[]) {
      expect(new ModelRefusal(c.model, c.category).message).toBe(c.message);
    }
  });

  it("三个子类都在 ModelError 之下 —— scheduler 靠类型分派", () => {
    expect(GOLDEN["errors"].hierarchy.QuotaExhausted[0]).toBe("ModelError");
    expect(new QuotaExhausted("m", "d", 402)).toBeInstanceOf(ModelError);
    expect(new ModelTruncated("t")).toBeInstanceOf(ModelError);
    expect(new ModelRefusal("m", null)).toBeInstanceOf(ModelError);
    expect(new ModelError("x")).not.toBeInstanceOf(QuotaExhausted);
  });
});

// ══════════════════════════════════════════════════════════════════
//  路由
// ══════════════════════════════════════════════════════════════════
describe("路由表", () => {
  it("三张表逐字段等于 Python（哪个模型配哪个 effort 是厂商事实）", () => {
    const r = GOLDEN["routing"];
    for (const [k, v] of Object.entries(r.production_models as Record<string, unknown>)) {
      expect(specDict(PRODUCTION_MODELS[k]!), k).toEqual(v);
    }
    for (const [k, v] of Object.entries(r.gateway_models as Record<string, unknown>)) {
      expect(specDict(GATEWAY_MODELS[k]!), k).toEqual(v);
    }
    expect(routingDict(productionRouting())).toEqual(r.production);
    expect(routingDict(stubRouting())).toEqual(r.stub);
    expect(routingDict(gatewayRouting())).toEqual(r.gateway_default);
  });

  it("覆盖某档模型时 effort 由能力服务端派生", () => {
    for (const c of GOLDEN["routing"].gateway_overrides as any[]) {
      const cat = c.catalog ? CATALOG : null;
      expect(c.ok, JSON.stringify(c.overrides)).toBe(true);
      expect(routingDict(gatewayRouting(c.overrides, cat)), JSON.stringify(c.overrides)).toEqual(
        c.value,
      );
    }
    // 关键安全点重申一遍：不支持 effort 的模型必须 effort=null，否则后端把
    // effort 下发给网关会直接 400。
    expect(gatewayRouting({ high: "google/gemini-3.5-flash" }, CATALOG).modelFor(Difficulty.HIGH)
      .effort).toBeNull();
    expect(gatewayRouting({ high: "some/unknown-model" }, CATALOG).modelFor(Difficulty.HIGH)
      .effort).toBeNull();
  });

  it("modelFor / judgeFor 的返回与报错", () => {
    const stub = stubRouting();
    for (const c of GOLDEN["routing"].model_for as any[]) {
      expect(specDict(stub.modelFor(c.difficulty)), c.difficulty).toEqual(c.value);
    }
    expect(() => new RoutingTable().modelFor(Difficulty.HIGH)).toThrow(
      GOLDEN["routing"].model_for_missing.message,
    );

    const prod = productionRouting();
    for (const c of GOLDEN["routing"].judge_for as any[]) {
      const gen = makeModelSpec({
        name: c.generator,
        tier: "mid",
        usd_per_mtok_in: 1,
        usd_per_mtok_out: 1,
      });
      expect(prod.judgeFor(gen, c.salt).name, `${c.generator}/${c.salt}`).toBe(c.value);
    }
    expect(() => new RoutingTable({ judges: [SPEC] }).judgeFor(SPEC)).toThrow(
      GOLDEN["routing"].judge_for_empty.message,
    );
  });

  it("负 salt 也要落在池子里（Python 的 % 给非负余数，JS 给负数）", () => {
    // 直接下标会拿到 undefined，然后在 call 里炸成一句莫名其妙的报错。
    const prod = productionRouting();
    const gen = makeModelSpec({
      name: "other",
      tier: "mid",
      usd_per_mtok_in: 1,
      usd_per_mtok_out: 1,
    });
    for (const salt of [-1, -2, -3, -7]) {
      expect(prod.judges.map((j) => j.name)).toContain(prod.judgeFor(gen, salt).name);
    }
  });

  it("循环参数：iterations / criticRounds / samples", () => {
    const gw = new ModelGateway(new ScriptedBackend(), new FakeRecorder("r"), {
      routing: stubRouting(),
      budget: new Budget(),
    });
    for (const [d, p] of Object.entries(GOLDEN["routing"].params as Record<string, any>)) {
      const diff = d as Difficulty;
      expect(gw.iterationsFor(diff), d).toBe(p.iterations);
      expect(gw.criticRoundsFor(diff), d).toBe(p.critic_rounds);
      expect(gw.samplesFor(diff), d).toBe(p.self_consistency);
    }
    // 显式 requested 压过路由表的默认值
    expect(gw.criticRoundsFor(Difficulty.LOW, 3)).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ScriptedBackend
// ══════════════════════════════════════════════════════════════════
describe("ScriptedBackend", () => {
  it("按规则顺序匹配，用量走 estTokens", async () => {
    const be = new ScriptedBackend(
      [
        ["抽取 ObjectType", '{"objects": ["a"]}'],
        ["多行.*匹配", "命中"],
      ],
      "{}",
    );
    for (const c of GOLDEN["scripted_backend"] as any[]) {
      const [text, usage] = await be.generate({
        model: SPEC,
        prompt: c.prompt,
        system: c.system,
      });
      expect(text, c.prompt).toBe(c.text);
      expect(usage.toDict(), c.prompt).toEqual(c.usage);
    }
    expect(be.calls).toHaveLength(4);
  });
});

// ══════════════════════════════════════════════════════════════════
//  网关记账 —— 本轮最要紧的一组
// ══════════════════════════════════════════════════════════════════
async function runScenario(g: any): Promise<{
  outcome: Record<string, unknown>;
  backend: SequencedBackend;
  ledger: UsageSinkRow[];
  journal: FakeJournal;
  budget: Budget;
}> {
  const script: ScriptItem[] = (g.name === "quota"
    ? [new QuotaExhausted("stub-small", quotaBody(), 429)]
    : g.name === "truncated"
      ? [new ModelTruncated("只有推理没有正文"), ["{\"ok\": true}", new Usage({ tok_in: 30, tok_out: 3 })]]
      : g.name === "truncated-forever"
        ? [new ModelTruncated("一直只有推理")]
        : g.name === "no-schema-truncated"
          ? [new ModelTruncated("正文空")]
          : SCRIPTS[g.name]!) as ScriptItem[];

  const backend = new SequencedBackend(script);
  const journal = new FakeJournal();
  const budget = new Budget();
  const ledger: UsageSinkRow[] = [];
  const gw = new ModelGateway(backend, new FakeRecorder(g.name, journal), {
    routing: stubRouting(),
    budget,
    usageSink: (r) => ledger.push(r),
    maxSchemaRetries: SCENARIO_RETRIES[g.name] ?? 2,
  });

  let outcome: Record<string, unknown>;
  try {
    const comp = await gw.call("NODE", g.backend_calls[0].prompt, {
      difficulty: Difficulty.LOW,
      ...(SCENARIO_SCHEMA[g.name] !== undefined ? { schema: SCENARIO_SCHEMA[g.name]! } : {}),
    });
    outcome = { ok: true, completion: completionDict(comp) };
  } catch (e) {
    outcome = {
      ok: false,
      exc: (e as Error).name,
      message: (e as Error).message,
    };
  }
  return { outcome, backend, ledger, journal, budget };
}

function quotaBody(): string {
  return (GOLDEN["quota_judgement"] as any[]).find(
    (c) => c.status === 429 && String(c.body).includes("insufficient_user_quota"),
  ).body as string;
}

const SCHEMA_OK = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

const SCENARIO_SCHEMA: Record<string, Record<string, unknown> | undefined> = {
  plain: undefined,
  "gateway-usd": undefined,
  "estimated-usd": undefined,
  "validate-retry": SCHEMA_OK,
  "parse-retry": SCHEMA_OK,
  "all-bad": SCHEMA_OK,
  "mixed-usd": SCHEMA_OK,
  truncated: SCHEMA_OK,
  "truncated-forever": SCHEMA_OK,
  quota: SCHEMA_OK,
  "no-schema-truncated": undefined,
};

const SCENARIO_RETRIES: Record<string, number> = {
  "truncated-forever": 1,
  "no-schema-truncated": 0,
};

const SCRIPTS: Record<string, ScriptItem[]> = {
  plain: [["ok", new Usage({ tok_in: 120, tok_out: 30, cache_read: 10 })]],
  "gateway-usd": [["ok", new Usage({ tok_in: 1000, tok_out: 1000, usd: 0.42 })]],
  "estimated-usd": [["ok", new Usage({ tok_in: 1_000_000, tok_out: 0 })]],
  "validate-retry": [
    ['{"a": 1}', new Usage({ tok_in: 100, tok_out: 50 })],
    ['{"ok": "真"}', new Usage({ tok_in: 110, tok_out: 60 })],
    ['{"ok": true}', new Usage({ tok_in: 120, tok_out: 20 })],
  ],
  "parse-retry": [
    ["不是 JSON", new Usage({ tok_in: 100, tok_out: 50 })],
    ['{"ok": true}', new Usage({ tok_in: 120, tok_out: 20 })],
  ],
  "all-bad": [['{"a": 1}', new Usage({ tok_in: 200, tok_out: 10 })]],
  "mixed-usd": [
    ['{"a": 1}', new Usage({ tok_in: 10, tok_out: 1, usd: 0.1 })],
    ['{"ok": true}', new Usage({ tok_in: 20, tok_out: 2 })],
  ],
};

describe("ModelGateway 记账", () => {
  it("golden 的每个场景：账本行 / BUDGET_SPENT payload / Budget 水位全部逐字段相等", async () => {
    for (const g of GOLDEN["gateway"] as any[]) {
      const r = await runScenario(g);
      expect(r.outcome, g.name).toEqual(g.outcome);
      expect(r.ledger, `${g.name} ledger`).toEqual(g.ledger);
      expect(spentEvents(r.journal), `${g.name} events`).toEqual(g.budget_spent_events);
      expect(r.budget.spent("tokens"), `${g.name} tokens`).toBe(g.budget.tokens);
      expect(r.budget.spent("usd"), `${g.name} usd`).toBe(g.budget.usd);
      // 重试的每一次都真打出去了 —— max_tokens 的升级序列也要对上，那是
      // 「截断就加大预算」有没有生效的唯一证据。
      if (g.name !== "parse-retry") {
        expect(r.backend.calls, `${g.name} calls`).toEqual(g.backend_calls);
      } else {
        // parse-retry 的重试提示词里嵌的是 CPython 的 json 报错文案，跨语言不可比；
        // 次数与预算仍然要逐条对。
        expect(r.backend.calls.map((c) => [c.model, c.max_tokens, c.schema])).toEqual(
          g.backend_calls.map((c: any) => [c.model, c.max_tokens, c.schema]),
        );
        expect(r.backend.calls[0]!.prompt).toBe(g.backend_calls[0].prompt);
        expect(r.backend.calls[1]!.prompt).toMatch(/^给我 JSON\n\n【上次输出不合要求】/);
      }
    }
  });

  it("一次调用重试三回就是三份 token 的钱（只记最后一次等于把账做小）", async () => {
    const g = (GOLDEN["gateway"] as any[]).find((s) => s.name === "validate-retry");
    const r = await runScenario(g);
    expect(r.backend.calls).toHaveLength(3);
    expect(r.ledger).toHaveLength(1); // 一次逻辑调用一行
    expect(r.ledger[0]!.attempts).toBe(3);
    expect([r.ledger[0]!.tok_in, r.ledger[0]!.tok_out]).toEqual([330, 130]);
  });

  it("最终失败的调用也花了钱，账上必须留一行", async () => {
    const g = (GOLDEN["gateway"] as any[]).find((s) => s.name === "all-bad");
    const r = await runScenario(g);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]!.status).toBe("failed");
    expect(r.ledger[0]!.tok_in).toBe(600); // 三次 × 200
  });

  it("欠费一次都不重试，但账上仍留一行 failed", async () => {
    const g = (GOLDEN["gateway"] as any[]).find((s) => s.name === "quota");
    const r = await runScenario(g);
    expect(r.backend.calls).toHaveLength(1); // 网关又替用户重试三遍欠费，账户还是没钱
    expect(r.ledger[0]!.status).toBe("failed");
    expect(r.ledger[0]!.attempts).toBe(1);
    expect(r.outcome["exc"]).toBe("QuotaExhausted");
  });

  it("截断加大预算重试；一直截断就原样抛 ModelTruncated", async () => {
    const ok = await runScenario((GOLDEN["gateway"] as any[]).find((s) => s.name === "truncated"));
    expect(ok.backend.calls.map((c) => c.max_tokens)).toEqual([16_000, 48_000]);
    const bad = await runScenario(
      (GOLDEN["gateway"] as any[]).find((s) => s.name === "truncated-forever"),
    );
    expect(bad.outcome["exc"]).toBe("ModelTruncated");
  });

  it("网关账单 vs 本地估算要分开标记（界面据此决定敢不敢当钱显示）", async () => {
    const g1 = (GOLDEN["gateway"] as any[]).find((s) => s.name === "gateway-usd");
    const r1 = await runScenario(g1);
    expect(r1.ledger[0]!.usd_source).toBe("gateway");
    expect(r1.ledger[0]!.usd).toBeCloseTo(0.42, 10);

    const g2 = (GOLDEN["gateway"] as any[]).find((s) => s.name === "estimated-usd");
    const r2 = await runScenario(g2);
    expect(r2.ledger[0]!.usd_source).toBe("estimated");

    // 部分尝试有账单、部分没有 → 整笔标 estimated，且 usage.usd 保持 null
    const g3 = (GOLDEN["gateway"] as any[]).find((s) => s.name === "mixed-usd");
    const r3 = await runScenario(g3);
    expect(r3.ledger[0]!.usd_source).toBe("estimated");
    expect((r3.outcome["completion"] as any).usage.usd).toBeNull();
  });

  it("重放不再打模型、不再记一笔账、也不再发第二条 BUDGET_SPENT", async () => {
    // **最要命的一种账目错误**：resume 恰恰是常态（跑到一半中断、改配置重跑）。
    const g = GOLDEN["gateway_replay"];
    const journal = new FakeJournal();
    const backend = new SequencedBackend([
      ["not json", new Usage({ tok_in: 10, tok_out: 2, cache_read: 3, usd: 0.1 })],
      ['{"ok": true}', new Usage({ tok_in: 20, tok_out: 4, cache_write: 5, usd: 0.2 })],
    ]);
    const ledger: UsageSinkRow[] = [];
    const budget = new Budget();
    const gw = new ModelGateway(backend, new FakeRecorder("run-usage", journal), {
      routing: stubRouting(),
      budget,
      usageSink: (r) => ledger.push(r),
      maxSchemaRetries: 1,
    });
    const first = await gw.call("NODE", "give json", {
      difficulty: Difficulty.LOW,
      schema: SCHEMA_OK,
    });
    expect(completionDict(first)).toEqual(g.first.completion);
    expect(ledger).toEqual(g.first.ledger);
    expect(budget.spent("tokens")).toBe(g.first.budget.tokens);
    expect(spentEvents(journal)).toEqual(g.first.budget_spent_events);

    const ledger2: UsageSinkRow[] = [];
    const budget2 = new Budget();
    const gw2 = new ModelGateway(backend, new FakeRecorder("run-usage", journal), {
      routing: stubRouting(),
      budget: budget2,
      usageSink: (r) => ledger2.push(r),
      maxSchemaRetries: 1,
    });
    const second = await gw2.call("NODE", "give json", {
      difficulty: Difficulty.LOW,
      schema: SCHEMA_OK,
    });

    expect(completionDict(second)).toEqual(g.replay.completion);
    expect(backend.calls).toHaveLength(g.replay.backend_calls);
    expect(ledger2, "重放不该再记一笔账").toEqual([]);
    // Budget 是进程内的运行投影，重放要恢复水位……
    expect(budget2.spent("tokens")).toBe(g.replay.budget.tokens);
    // ……但**不能**再发一条付费事件，否则事件审计看起来像付了两次钱。
    expect(spentEvents(journal)).toEqual(g.replay.budget_spent_events);
  });

  it("评委走同一个收口点，且强制换模型", async () => {
    const g = GOLDEN["gateway_judge"];
    const journal = new FakeJournal();
    const ledger: UsageSinkRow[] = [];
    const backend = new SequencedBackend([["ok", new Usage({ tok_in: 5, tok_out: 5 })]]);
    const routing = new RoutingTable({
      models: {
        [Difficulty.LOW]: SPEC,
        [Difficulty.MEDIUM]: SPEC,
        [Difficulty.HIGH]: SPEC,
        [Difficulty.CRITICAL]: SPEC,
      },
      judges: [
        makeModelSpec({
          name: "judge-model",
          tier: "mid",
          usd_per_mtok_in: 1,
          usd_per_mtok_out: 2,
          effort: null,
        }),
        makeModelSpec({
          name: "judge-two",
          tier: "mid",
          usd_per_mtok_in: 1,
          usd_per_mtok_out: 2,
          effort: "high",
        }),
      ],
    });
    const gw = new ModelGateway(backend, new FakeRecorder("run-judge", journal), {
      routing,
      budget: new Budget(),
      usageSink: (r) => ledger.push(r),
    });
    const comp = await gw.judge("NODE", "评一下", { generator: SPEC, salt: 1 });
    expect(completionDict(comp)).toEqual(g.completion);
    expect(ledger).toEqual(g.ledger);
    expect(backend.calls.map((c) => c.model)).toEqual(
      (g.backend_calls as any[]).map((c) => c.model),
    );
  });

  it("记账 sink 挂了不该把一次梳理带下去", async () => {
    const g = GOLDEN["gateway_broken_sink"];
    const journal = new FakeJournal();
    const gw = new ModelGateway(
      new SequencedBackend([["ok", new Usage({ tok_in: 1, tok_out: 1 })]]),
      new FakeRecorder("run-sink", journal),
      {
        routing: stubRouting(),
        budget: new Budget(),
        usageSink: () => {
          throw new Error("库挂了");
        },
      },
    );
    const comp = await gw.call("NODE", "x", { difficulty: Difficulty.LOW });
    expect(completionDict(comp)).toEqual(g.completion);
    expect(spentEvents(journal)).toEqual(g.budget_spent_events);
  });

  it("请求指纹里图片只留内容哈希，不留 base64", async () => {
    // 完整 base64 塞进事件日志会把它撑爆，但重放又要确定性 —— 所以按内容哈希。
    let seen: Record<string, unknown> = {};
    const rec: LlmRecorder = {
      runId: "r",
      emit: () => null,
      effect: async (_n, _k, request, fn) => {
        seen = request;
        return fn();
      },
    };
    const gw = new ModelGateway(
      new SequencedBackend([["ok", new Usage()]]),
      rec,
      { routing: stubRouting(), budget: new Budget() },
    );
    const big = "data:image/png;base64," + "A".repeat(10_000);
    await gw.call("N", "看图", { difficulty: Difficulty.LOW, images: [big] });
    const images = seen["images"] as string[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(seen)).not.toContain("AAAA");
    // 键名是持久契约：改一个字母，所有历史 effect 都对不上。
    expect(Object.keys(seen).sort()).toEqual([
      "effort",
      "images",
      "max_tokens",
      "model",
      "prompt",
      "schema",
      "system",
      "thinking",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  OpenAICompatBackend
// ══════════════════════════════════════════════════════════════════
/** 一个假网关：按脚本回响应，并数自己被打了几次。 */
class FakeGateway {
  hits = 0;
  readonly bodies: unknown[] = [];

  constructor(private readonly script: readonly (readonly [number, string])[]) {}

  fetch = (_url: string, init: RequestInit): Promise<Response> => {
    const [status, body] = this.script[Math.min(this.hits, this.script.length - 1)]!;
    this.hits += 1;
    this.bodies.push(JSON.parse(String(init.body)));
    return Promise.resolve(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );
  };
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const RATE_429 = JSON.stringify({
  error: {
    message: "Rate limit reached for this model, please slow down",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
});

/** 把退避换成计数器：既不真睡，又能直接断言"这次一秒都没白等"。 */
function makeBackend(
  gw: FakeGateway,
  maxRetries = 3,
): { be: OpenAICompatBackend; sleeps: number[] } {
  const sleeps: number[] = [];
  const be = new OpenAICompatBackend("http://gw.test/v1", "sk-super-secret-key", {
    maxRetries,
    fetchImpl: gw.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    rng: () => 0,
  });
  return { be, sleeps };
}

describe("OpenAICompatBackend", () => {
  it("请求组装逐字节等于 Python", () => {
    const be = new OpenAICompatBackend("http://gw.test/v1", "k");
    for (const c of GOLDEN["openai_build"] as any[]) {
      const got = be.build({
        model: c.args.model as ModelSpec,
        prompt: c.args.prompt,
        system: c.args.system,
        schema: c.args.schema,
        maxTokens: c.args.max_tokens,
        drop: new Set(c.args.drop as string[]),
        images: c.args.images,
      });
      expect(got, JSON.stringify(c.args.drop)).toEqual(c.out);
    }
  });

  it("响应解析：用量、缓存扣减、拒绝、只有推理没正文", () => {
    const be = new OpenAICompatBackend("http://gw.test/v1", "k");
    for (const c of GOLDEN["openai_parse"] as any[]) {
      const label = JSON.stringify(c.data);
      if (c.ok) {
        const [text, usage] = be.parse(SPEC, c.data);
        expect(text, label).toBe(c.text);
        expect(usage.toDict(), label).toEqual(c.usage);
      } else {
        let err: Error | null = null;
        try {
          be.parse(SPEC, c.data);
        } catch (e) {
          err = e as Error;
        }
        expect(err, label).not.toBeNull();
        expect(err!.name, label).toBe(c.exc);
        expect(err!.message, label).toBe(c.message);
      }
    }
  });

  it("offendingField：字段既要在 body 里、又要被报错点名", () => {
    for (const c of GOLDEN["offending_field"] as any[]) {
      const body: Record<string, unknown> = {};
      for (const k of c.body_keys as string[]) body[k] = {};
      expect(offendingField(c.error_text, body), c.error_text).toBe(c.out);
    }
  });

  it("402 / 带配额信号的 429：立刻抛，一次都不退避", async () => {
    for (const [status, body] of [
      [402, JSON.stringify({ error: { message: "Payment Required" } })],
      [429, quotaBody()],
    ] as const) {
      const gw = new FakeGateway([[status, body]]);
      const { be, sleeps } = makeBackend(gw);
      await expect(be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 })).rejects.toThrow(
        QuotaExhausted,
      );
      expect(gw.hits, "余额不足还退避重试，纯粹是让用户白等").toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("真限流照常退避重试并恢复（这条能力不许丢）", async () => {
    const gw = new FakeGateway([
      [429, RATE_429],
      [200, OK_BODY],
    ]);
    const { be, sleeps } = makeBackend(gw);
    const [text, usage] = await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect(text).toBe("ok");
    expect(gw.hits).toBe(2);
    expect(sleeps).toEqual([800]); // 2^0 * 0.8s，rng 钉成 0
    expect(usage.tok_in).toBe(10);
  });

  it("一直限流：走完重试后报普通失败，**不是**余额不足", async () => {
    const gw = new FakeGateway([[429, RATE_429]]);
    const { be, sleeps } = makeBackend(gw, 2);
    let err: Error | null = null;
    await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch((e) => {
      err = e as Error;
    });
    expect(err).toBeInstanceOf(ModelError);
    expect(err).not.toBeInstanceOf(QuotaExhausted);
    expect(gw.hits).toBe(3); // 首次 + 2 次重试
    expect(sleeps).toEqual([800, 1600, 3200]);
    expect(String(err)).not.toContain("余额");
  });

  it("非 402/429 的 4xx 原样抛，不被新判据顺手改了类型", async () => {
    const gw = new FakeGateway([[401, JSON.stringify({ error: { message: "invalid api key" } })]]);
    const { be } = makeBackend(gw);
    let err: Error | null = null;
    await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch((e) => {
      err = e as Error;
    });
    expect(err).toBeInstanceOf(ModelError);
    expect(err).not.toBeInstanceOf(QuotaExhausted);
    expect(err!.message).toContain("401");
    expect(gw.hits).toBe(1);
  });

  it("400 点名某个可选字段 → 记下来、降级重发，且不退避", async () => {
    const gw = new FakeGateway([
      [400, JSON.stringify({ error: { message: "unsupported parameter: reasoning" } })],
      [200, OK_BODY],
    ]);
    const { be, sleeps } = makeBackend(gw);
    const [text] = await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect(text).toBe("ok");
    expect(sleeps).toEqual([]); // 少一档推理好过没结果，但也别白等
    expect(be.unsupported.has("reasoning")).toBe(true);
    expect((gw.bodies[0] as any).reasoning).toBeDefined();
    expect((gw.bodies[1] as any).reasoning).toBeUndefined();
    // 记下来之后，后续请求直接不带 —— 避免每次都白试一轮。
    const gw2 = new FakeGateway([[200, OK_BODY]]);
    const be2 = new OpenAICompatBackend("http://gw.test/v1", "k", { fetchImpl: gw2.fetch });
    be2.unsupported.add("reasoning");
    await be2.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect((gw2.bodies[0] as any).reasoning).toBeUndefined();
  });

  it("网络层故障可重试", async () => {
    let hits = 0;
    const sleeps: number[] = [];
    const be = new OpenAICompatBackend("http://gw.test/v1", "k", {
      fetchImpl: () => {
        hits += 1;
        if (hits === 1) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(new Response(OK_BODY, { status: 200 }));
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      rng: () => 0,
    });
    const [text] = await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect(text).toBe("ok");
    expect(hits).toBe(2);
    expect(sleeps).toEqual([800]);
  });

  it("retry-after 走 Python 的 float() 语义", async () => {
    // Number("") 给 0（Python 抛）、Number("1_0") 给 NaN（Python 给 10.0）——
    // 判错的后果要么是不退避继续撞墙，要么是退一个荒谬的时长。
    expect(pyFloat("1.5")).toBe(1.5);
    expect(pyFloat("  2 ")).toBe(2);
    expect(pyFloat("1_0")).toBe(10);
    expect(pyFloat("1e3")).toBe(1000);
    expect(pyFloat("")).toBeNull();
    expect(pyFloat("0x10")).toBeNull();
    expect(pyFloat("abc")).toBeNull();
    expect(pyFloat("Infinity")).toBe(Infinity);

    const sleeps: number[] = [];
    const be = new OpenAICompatBackend("http://gw.test/v1", "k", {
      maxRetries: 1,
      fetchImpl: () =>
        Promise.resolve(
          new Response(RATE_429, { status: 429, headers: { "retry-after": "2.5" } }),
        ),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      rng: () => 0,
    });
    await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch(() => undefined);
    expect(sleeps).toEqual([2500, 2500]);
  });

  it("retry-after 是 60000 秒也钳在 30s；解析不出来就走抖动", async () => {
    const run = async (header: string): Promise<number[]> => {
      const sleeps: number[] = [];
      const be = new OpenAICompatBackend("http://gw.test/v1", "k", {
        maxRetries: 0,
        fetchImpl: () =>
          Promise.resolve(new Response(RATE_429, { status: 429, headers: { "retry-after": header } })),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        rng: () => 0,
      });
      await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch(() => undefined);
      return sleeps;
    };
    expect(await run("60000")).toEqual([30_000]);
    expect(await run("Wed, 21 Oct 2026 07:28:00 GMT")).toEqual([800]);
  });

  it("**API key 绝不出现在任何错误消息 / 序列化 / toString 里**", async () => {
    const KEY = "sk-super-secret-key";
    const gw = new FakeGateway([[401, JSON.stringify({ error: { message: "bad key" } })]]);
    const { be } = makeBackend(gw);
    let err: Error | null = null;
    await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch((e) => {
      err = e as Error;
    });
    expect(err!.message).not.toContain(KEY);
    expect(String(err!.stack)).not.toContain(KEY);
    expect(JSON.stringify(be)).not.toContain(KEY);
    expect(String(be)).not.toContain(KEY);
    expect(Object.values(be).join("|")).not.toContain(KEY);
    // 但请求头里必须**真的**带上它，别把这条测试变成"功能坏了所以泄不出去"
    const sent = new FakeGateway([[200, OK_BODY]]);
    let headers: Record<string, string> = {};
    const be2 = new OpenAICompatBackend("http://gw.test/v1", KEY, {
      fetchImpl: (u, init) => {
        headers = init.headers as Record<string, string>;
        return sent.fetch(u, init);
      },
    });
    await be2.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("重试耗尽的报错带上最后一次的原因", async () => {
    const gw = new FakeGateway([[503, "上游挂了"]]);
    const { be } = makeBackend(gw, 1);
    await expect(be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 })).rejects.toThrow(
      /重试 1 次后仍失败/,
    );
    expect(gw.hits).toBe(2);
  });

  it("错误体按码点截断（中文不许被切成半个字符）", async () => {
    const gw = new FakeGateway([[404, "错".repeat(500)]]);
    const { be } = makeBackend(gw);
    let err: Error | null = null;
    await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 }).catch((e) => {
      err = e as Error;
    });
    const body = err!.message.split(": ").slice(1).join(": ");
    expect([...body]).toHaveLength(400);
    expect(body).not.toContain("�");
  });
});

// ══════════════════════════════════════════════════════════════════
//  AnthropicBackend
// ══════════════════════════════════════════════════════════════════
function fakeAnthropic(
  impl: (params: Record<string, unknown>) => Promise<AnthropicMessage>,
  streamImpl?: (params: Record<string, unknown>) => Promise<AnthropicMessage>,
): { client: AnthropicClientLike; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const api = {
    create: (p: Record<string, unknown>) => {
      calls.push(p);
      return impl(p);
    },
    stream: (p: Record<string, unknown>) => {
      calls.push(p);
      const run = streamImpl ?? impl;
      return Promise.resolve({ getFinalMessage: () => run(p) });
    },
  };
  return { client: { messages: api, beta: { messages: api } }, calls };
}

describe("AnthropicBackend", () => {
  it("请求组装逐字节等于 Python", () => {
    const be = new AnthropicBackend({ client: fakeAnthropic(() => Promise.resolve({})).client });
    for (const c of GOLDEN["anthropic_build"] as any[]) {
      expect(
        be.build({
          model: c.args.model as ModelSpec,
          prompt: c.args.prompt,
          system: c.args.system,
          schema: c.args.schema,
          maxTokens: c.args.max_tokens,
          cacheSystem: c.args.cache_system,
        }),
        JSON.stringify(c.args),
      ).toEqual(c.out);
    }
  });

  it("用量四个字段全部映射（少记一类就是账目静默错误）", async () => {
    const { client } = fakeAnthropic(() =>
      Promise.resolve({
        content: [
          { type: "text", text: "前" },
          { type: "thinking" as string, text: "不该算进去" },
          { type: "text", text: "后" },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      }),
    );
    const be = new AnthropicBackend({ client, serverFallback: false });
    const [text, usage] = await be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 });
    expect(text).toBe("前后");
    expect(usage.toDict()).toEqual({
      tok_in: 11,
      tok_out: 22,
      cache_read: 33,
      cache_write: 44,
      usd: null,
    });
  });

  it("stop_reason=refusal 是 200 响应，不是 HTTP 错误", async () => {
    const { client } = fakeAnthropic(() =>
      Promise.resolve({ stop_reason: "refusal", stop_details: { category: "self_harm" } }),
    );
    const be = new AnthropicBackend({ client, serverFallback: false });
    await expect(be.generate({ model: SPEC, prompt: "hi", maxTokens: 100 })).rejects.toThrow(
      ModelRefusal,
    );
  });

  it("服务端兜底走 beta.messages 并带上 betas / fallbacks", async () => {
    const { client, calls } = fakeAnthropic(() => Promise.resolve({ content: [] }));
    await new AnthropicBackend({ client }).generate({
      model: SPEC,
      prompt: "hi",
      maxTokens: 100,
    });
    expect(calls[0]!["betas"]).toEqual(["server-side-fallback-2026-07-01"]);
    expect(calls[0]!["fallbacks"]).toBe("default");
  });

  it("max_tokens 超阈值走流式（否则会撞 HTTP 超时）", async () => {
    let usedStream = false;
    const client: AnthropicClientLike = {
      messages: {
        create: () => Promise.resolve({ content: [{ type: "text", text: "no" }] }),
        stream: () => {
          usedStream = true;
          return Promise.resolve({
            getFinalMessage: () =>
              Promise.resolve({ content: [{ type: "text", text: "streamed" }] }),
          });
        },
      },
    };
    const be = new AnthropicBackend({ client, serverFallback: false });
    const [small] = await be.generate({
      model: SPEC,
      prompt: "hi",
      maxTokens: STREAM_THRESHOLD,
    });
    expect([small, usedStream]).toEqual(["no", false]);
    const [big] = await be.generate({
      model: SPEC,
      prompt: "hi",
      maxTokens: STREAM_THRESHOLD + 1,
    });
    expect([big, usedStream]).toEqual(["streamed", true]);
  });

  it("SDK 异常里的欠费信号分流成 QuotaExhausted，其余原样冒上去", async () => {
    class SDKError extends Error {
      constructor(
        readonly status_code: number,
        readonly body: unknown,
      ) {
        super(`HTTP ${status_code}`);
      }
    }
    const quota = new SDKError(402, { error: { message: "credit balance too low" } });
    const { client } = fakeAnthropic(() => Promise.reject(quota));
    let err: unknown = null;
    await new AnthropicBackend({ client, serverFallback: false })
      .generate({ model: SPEC, prompt: "hi", maxTokens: 100 })
      .catch((e) => {
        err = e;
      });
    expect(err).toBeInstanceOf(QuotaExhausted);
    expect((err as QuotaExhausted).status).toBe(402);

    // C5 的同款纪律：分流只认欠费，别的错误必须原样冒上去、别被改了形状。
    const boom = new SDKError(500, { error: { message: "internal" } });
    const other = fakeAnthropic(() => Promise.reject(boom));
    await expect(
      new AnthropicBackend({ client: other.client, serverFallback: false }).generate({
        model: SPEC,
        prompt: "hi",
        maxTokens: 100,
      }),
    ).rejects.toBe(boom);
  });

  it("raiseIfQuota 也认 JS SDK 的字段名（status / error）", async () => {
    // Python SDK 是 status_code / body，JS SDK 是 status / error。两个都得认，
    // 否则换个 SDK 欠费就又变成"白等几轮再报一句看不懂的错"。
    expect(() =>
      raiseIfQuota("m", { status: 429, error: { code: "insufficient_user_quota" } }),
    ).toThrow(QuotaExhausted);
    expect(() => raiseIfQuota("m", { status: 500, error: { code: "insufficient_quota" } })).not.toThrow();
    expect(() => raiseIfQuota("m", new Error("boom"))).not.toThrow();
    expect(() => raiseIfQuota("m", null)).not.toThrow();
    // body 里塞个循环引用也不能在异常处理路径上再抛一个异常
    const circular: Record<string, unknown> = { status_code: 402 };
    circular["self"] = circular;
    expect(() => raiseIfQuota("m", circular)).toThrow(QuotaExhausted);
  });

  it("视觉输入没接线时直说，不静默丢图", async () => {
    const { client } = fakeAnthropic(() => Promise.resolve({}));
    await expect(
      new AnthropicBackend({ client }).generate({
        model: SPEC,
        prompt: "看图",
        maxTokens: 100,
        images: ["data:image/png;base64,AAA"],
      }),
    ).rejects.toThrow(/视觉输入尚未接线/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  流式解析：跨 chunk 的 UTF-8 与 SSE 帧
// ══════════════════════════════════════════════════════════════════
function sse(events: readonly Record<string, unknown>[]): Uint8Array {
  const text = events
    .map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new TextEncoder().encode(text);
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe("SSE / 流式解析", () => {
  const CJK = "本体建模的第一步是把口径对齐——不是把字段抄一遍。🚀";

  it("跨 chunk 断开的 UTF-8 多字节字符必须拼回来（中文正好三字节）", async () => {
    const bytes = sse([
      { type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 3 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: CJK } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
    ]);

    // 先证明这个切法**真的**切在了字符中间 —— 否则这条测试等于没测。
    const naive = [];
    for (let i = 0; i < bytes.length; i += 7) {
      naive.push(Buffer.from(bytes.subarray(i, i + 7)).toString("utf8"));
    }
    expect(naive.join(""), "切点没落在多字节字符中间，这条用例失去意义").toContain("�");

    for (const size of [1, 2, 3, 5, 7, 13, 64, 100_000]) {
      const msg = await assembleAnthropicStream(chunked(bytes, size));
      const text = (msg.content ?? []).map((b) => b.text ?? "").join("");
      expect(text, `chunk=${size}`).toBe(CJK);
      expect(text, `chunk=${size}`).not.toContain("�");
    }
  });

  it("跨 chunk 断开的事件帧也要拼回来，用量取累计值不累加", async () => {
    const bytes = sse([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
        },
      },
      { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    ]);
    const msg = await assembleAnthropicStream(chunked(bytes, 4));
    expect((msg.content ?? [])[0]!.text).toBe("ab");
    // output_tokens 是**累计值**：累加就是 1+9=10，账单直接虚高。
    expect(msg.usage).toEqual({
      input_tokens: 10,
      output_tokens: 9,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    });
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("SSE 帧格式：注释行、多行 data、\\r\\n 换行、结尾没有空行", () => {
    const dec = new SseDecoder();
    const enc = new TextEncoder();
    const frames = [
      ...dec.push(enc.encode(": keep-alive\r\n\r\nevent: a\r\ndata: {\"x\":\r\ndata: 1}\r\n\r\n")),
      ...dec.push(enc.encode("event: b\ndata: last")),
      ...dec.flush(), // 结尾没有空行的最后一帧也要交付
    ];
    const parsed = frames.map(parseSseFrame);
    // 保活注释自成一帧，解析出来是空事件空数据 —— decoder 只切帧不做语义判断，
    // 由 assembler 忽略（`data === ""` 直接 return）。
    expect(parsed.map((p) => [p.event, p.data])).toEqual([
      ["", ""],
      ["a", '{"x":\n1}'],
      ["b", "last"],
    ]);
  });

  it("流里的 error 事件变成 ModelError，坏帧忽略", async () => {
    const bad = new TextEncoder().encode(
      'data: 这不是 JSON\n\nevent: error\ndata: {"type":"error","error":{"message":"上游超时"}}\n\n',
    );
    await expect(assembleAnthropicStream(chunked(bad, 3))).rejects.toThrow(/上游超时/);
  });

  it("FetchAnthropicClient 端到端：流式响应拼回完整消息，且不带出 key", async () => {
    const KEY = "sk-ant-secret";
    const bytes = sse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: CJK } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
    ]);
    let sentHeaders: Record<string, string> = {};
    let sentBody: any = null;
    const client = new FetchAnthropicClient({
      apiKey: KEY,
      fetchImpl: (_u, init) => {
        sentHeaders = init.headers as Record<string, string>;
        sentBody = JSON.parse(String(init.body));
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.subarray(i, i + 5));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      },
    });
    const be = new AnthropicBackend({ client, serverFallback: true });
    const [text, usage] = await be.generate({
      model: SPEC,
      prompt: "hi",
      system: "系统",
      maxTokens: STREAM_THRESHOLD + 1,
    });
    expect(text).toBe(CJK);
    expect(usage.toDict()).toEqual({
      tok_in: 5,
      tok_out: 8,
      cache_read: 0,
      cache_write: 0,
      usd: null,
    });
    expect(sentBody.stream).toBe(true);
    // betas 是 SDK 的参数名，走 HTTP 时是头，不该留在 body 里
    expect(sentBody.betas).toBeUndefined();
    expect(sentHeaders["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(sentHeaders["x-api-key"]).toBe(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(String(client)).not.toContain(KEY);
  });

  it("FetchAnthropicClient 的 HTTP 错误带得出状态码，供欠费判据分流", async () => {
    const client = new FetchAnthropicClient({
      apiKey: "sk-x",
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { type: "insufficient_quota" } }), { status: 429 }),
        ),
    });
    await expect(
      new AnthropicBackend({ client, serverFallback: false }).generate({
        model: SPEC,
        prompt: "hi",
        maxTokens: 100,
      }),
    ).rejects.toThrow(QuotaExhausted);
  });
});
