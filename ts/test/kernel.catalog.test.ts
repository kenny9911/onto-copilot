/**
 * `kernel/catalog.ts` + `kernel/intent.ts` 的 golden 校验。
 *
 * 这两个模块合成一件事：**一句话被路由到哪个 handler、那个 handler 花多少钱**。
 * 两边的错法都不报错，只是结果变差，所以这里几乎不手写期望值 —— 全部数据驱动，
 * 读 `golden/catalog.json` / `golden/intent.json`（Python 侧真跑出来的），逐条比。
 *
 * 手写的只有三类，且都是 **golden 覆盖不到的 TS 独有风险**：
 *
 *   1. `\b` 的 Unicode 词边界（中英混输时 Python 与 JS 天然不同，见 intent.ts 头）；
 *   2. `\s` 的空白集（Python 多 U+001C–U+001F、少 U+FEFF）；
 *   3. 引用语义（`Map` 的插入序、`slots` 不共享引用、`ModelCatalog([])` 的假值分支）。
 *
 * `discover()` 那一节把 `globalThis.fetch` 换成假的，直接照 golden 里 Python 真收到的
 * 响应回放 —— 连**打过哪个 URL、带没带 Authorization** 都一起断言。路径拼错一格
 * （少一个 `/models`、或多一个 `/v1`）在网关上表现为稳定 404，而"稳定 404"与
 * "这家网关没这个接口"长得一模一样，不断言路径就永远发现不了。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CARDS,
  CAPABILITIES,
  Capability,
  LookupError,
  ModelCatalog,
  SmartGateway,
  cardFromName,
  cardHas,
  cardName,
  cardToDict,
  cardWithout,
  currentCatalog,
  denialCapability,
  ensureCatalog,
  inferCapabilities,
  isChatModel,
  isImageModel,
  makeCatalogPort,
  parseCapability,
  resetCatalogCache,
} from "../src/kernel/catalog.js";
import type { GatewayLike, ModelCard, SmartCallOptions } from "../src/kernel/catalog.js";
import { ValueError } from "../src/kernel/errors.js";
import { ModelError, makeCompletion } from "../src/kernel/llm.js";
import type { CallOptions, Completion } from "../src/kernel/llm.js";

import {
  INTENTS,
  INTENT_SCHEMA,
  Intent,
  MUTATING,
  RuleIntentParser,
  confidentMatches,
  intentMatchToDict,
  intentParseToDict,
  isMutating,
  makeIntentMatch,
  makeIntentParse,
  needsClarification,
  parseIntent,
  splitClauses,
} from "../src/kernel/intent.js";

// ══════════════════════════════════════════════════════════════════
//  golden
// ══════════════════════════════════════════════════════════════════

const GOLDEN_DIR = join(import.meta.dirname, "..", "..", "golden");

function loadGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as T;
}

interface SpecDict {
  name: string;
  tier: string;
  usd_per_mtok_in: number;
  usd_per_mtok_out: number;
  effort: string | null;
  thinking: boolean | null;
}
interface CardDict {
  name: string;
  vendor: string;
  quality: number;
  effort: string | null;
  capabilities: string[];
}
interface CardRow {
  to_dict: CardDict;
  spec: SpecDict;
}
interface SeenRow {
  url: string;
  method: string;
  authorization: string;
}
interface DiscoverRow {
  name: string;
  base: string;
  key: string;
  live: string[];
  seen: SeenRow[];
  notes: string[];
  names: string[];
  by_capability: Record<string, string[]>;
  describe: CardDict[];
  select_vision: string[];
}
interface SmartCallRow {
  node: string;
  prompt: string;
  model: string;
  key: string | null;
  rest: Record<string, unknown>;
  effort: string | null;
}
interface SmartRow {
  name: string;
  needs: string[];
  kw: Record<string, unknown>;
  prefer: string;
  max_candidates: number;
  prefer_models: string[];
  exc: string | null;
  error?: string;
  out: string | null;
  calls: SmartCallRow[];
  report: {
    attempts: Record<string, unknown>[];
    catalog_notes: string[];
    by_capability: Record<string, string[]>;
  };
}
interface CatalogGolden {
  capability_values: string[];
  cards: CardRow[];
  default_catalog: {
    names: string[];
    describe: CardDict[];
    by_capability: Record<string, string[]>;
    empty_list_falls_back: string[];
    one_card: string[];
    get_missing: null;
  };
  denial_capability: { text: string; out: string | null }[];
  is_chat_model: { name: string; out: boolean }[];
  infer_capabilities: { name: string; out: string[] }[];
  card_from_name: (CardRow & { name: string })[];
  select: {
    needs: string[];
    prefer: string;
    limit: number;
    exclude_vendors: string[];
    out: string[];
  }[];
  require_error: { needs: string[]; error: string }[];
  record_denial: {
    steps: {
      model: string;
      text: string;
      lost: string | null;
      notes: string[];
      card: CardDict | null;
    }[];
    final_by_capability: Record<string, string[]>;
    final_names: string[];
    vision_after: string[];
  };
  discover: DiscoverRow[];
  discover_fail: { name: string; exc: string; notes: string[]; names_intact: string[] }[];
  smart: SmartRow[];
}

interface MatchDict {
  intent: string;
  confidence: number;
  slots: Record<string, unknown>;
  span: string;
  by: string;
}
interface IntentGolden {
  intent_values: string[];
  mutating: string[];
  split_clauses: { in: string; out: string[] }[];
  parse: {
    text: string;
    question_ids: string[];
    suggestion_ids: string[];
    object_names: string[];
    out: { text: string; matches: MatchDict[] };
    matches: {
      to_dict: MatchDict;
      raw_confidence: number;
      mutating: boolean;
      intent_value: string;
    }[];
    confident: string[];
    needs_clarification: boolean;
  }[];
  defaults: {
    fresh_lists: { q: string[]; s: string[]; o: string[] };
    match_defaults: MatchDict;
    parse_defaults: { text: string; matches: MatchDict[] };
    parse_defaults_confident: string[];
    parse_defaults_needs_clarification: boolean;
  };
  intent_schema: Record<string, unknown>;
  round2: { in: number; out: number }[];
}

const G = loadGolden<CatalogGolden>("catalog.json");
const GI = loadGolden<IntentGolden>("intent.json");

function specOf(c: ModelCard): SpecDict {
  return {
    name: c.spec.name,
    tier: c.spec.tier,
    usd_per_mtok_in: c.spec.usd_per_mtok_in,
    usd_per_mtok_out: c.spec.usd_per_mtok_out,
    effort: c.spec.effort,
    thinking: c.spec.thinking,
  };
}

function asCaps(names: readonly string[]): Capability[] {
  return names.map(parseCapability);
}

// ══════════════════════════════════════════════════════════════════
//  catalog：内置目录与能力枚举
// ══════════════════════════════════════════════════════════════════

describe("catalog / 内置声明", () => {
  it("Capability 的值与顺序对得上 StrEnum", () => {
    expect([...CAPABILITIES]).toEqual(G.capability_values);
  });

  it("未知能力值抛 ValueError，不许 as 断言把校验删掉", () => {
    expect(() => parseCapability("visionn")).toThrow(ValueError);
    expect(parseCapability("vision")).toBe(Capability.VISION);
  });

  it("CARDS 的每一张卡逐字段对上（含定价与 effort/thinking）", () => {
    expect(CARDS.length).toBe(G.cards.length);
    CARDS.forEach((c, i) => {
      const want = G.cards[i]!;
      expect(cardToDict(c)).toEqual(want.to_dict);
      expect(specOf(c)).toEqual(want.spec);
    });
  });

  it("没有 EFFORT 能力的卡，effort/thinking 必须是 null —— 传了网关直接 400", () => {
    for (const c of CARDS) {
      if (!c.capabilities.has(Capability.EFFORT)) {
        expect(c.spec.effort).toBeNull();
        expect(c.spec.thinking).toBeNull();
      }
    }
  });

  it("默认目录的 names / describe / by_capability", () => {
    const cat = new ModelCatalog();
    expect(cat.names()).toEqual(G.default_catalog.names);
    expect(cat.describe()).toEqual(G.default_catalog.describe);
    expect(cat.byCapability()).toEqual(G.default_catalog.by_capability);
    expect(cat.get("nope/never")).toBeNull();
  });

  it("ModelCatalog([]) 落回内置目录 —— Python 的 `cards or CARDS`，空列表是假值", () => {
    // 照抄成 `cards ?? CARDS` 会得到一个空目录，require() 立刻抛 LookupError，
    // 症状是"任何模型调用都说目录里没有满足能力的模型"。
    expect(new ModelCatalog([]).names()).toEqual(G.default_catalog.empty_list_falls_back);
    expect(new ModelCatalog([CARDS[0]!]).names()).toEqual(G.default_catalog.one_card);
  });

  it("cardHas / cardWithout 不改原卡", () => {
    const c = CARDS[0]!;
    expect(cardHas(c, [Capability.VISION, Capability.EFFORT])).toBe(true);
    expect(cardHas(c, [Capability.CHEAP])).toBe(false);
    const cut = cardWithout(c, Capability.VISION);
    expect(cut.capabilities.has(Capability.VISION)).toBe(false);
    expect(c.capabilities.has(Capability.VISION)).toBe(true);
    expect(cardName(cut)).toBe(cardName(c));
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：判据矩阵
// ══════════════════════════════════════════════════════════════════

describe("catalog / denialCapability", () => {
  it.each(G.denial_capability)("$text", ({ text, out }) => {
    expect(denialCapability(text)).toBe(out);
  });
});

describe("catalog / 按名字推断", () => {
  it.each(G.is_chat_model)("isChatModel($name)", ({ name, out }) => {
    expect(isChatModel(name)).toBe(out);
  });

  /**
   * 图像模型的名形判据 —— 「图像」档的保存校验靠它。
   * 图像模型被 NOT_CHAT_RE 有意挡在聊天卡目录外，所以不能查目录，只能认名形。
   * 判据宁可多认（网关会在真调用时报错），不许把聊天模型放进图像档。
   */
  it("isImageModel：认得住主流出图型号，拦得住聊天模型", () => {
    for (const yes of ["openai/gpt-image-2", "dall-e-3", "DALL-E-2", "black-forest-labs/flux-1.1-pro",
      "stability/stable-diffusion-xl", "google/imagen-3",
      // 真实网关（New-API 风格）上的实名：版本号夹在中间、image 是一个词段。
      // 第一版判据写的是 `gpt-image`，对着真网关一查 35 个模型零命中 —— 判据
      // 必须认「名字里含 image 词段」，不能赌各家把 image 放在哪个位置。
      "openai/gpt-5.4-image-2", "google/gemini-3.1-flash-image", "google/gemini-3-pro-image"]) {
      expect(isImageModel(yes), yes).toBe(true);
    }
    for (const no of ["google/gemini-3.5-flash", "claude-opus-4.8", "gpt-5.4-mini", "a/b",
      // imagenet / pixtral 这类含形近词的不该被误伤
      "meta/imagenet-classifier", "mistral/pixtral-12b"]) {
      expect(isImageModel(no), no).toBe(false);
    }
  });

  it.each(G.infer_capabilities)("inferCapabilities($name)", ({ name, out }) => {
    expect([...inferCapabilities(name)].sort()).toEqual([...out].sort());
  });

  it.each(G.card_from_name)("cardFromName($name)", (row) => {
    const c = cardFromName(row.name);
    expect(cardToDict(c)).toEqual(row.to_dict);
    expect(specOf(c)).toEqual(row.spec);
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：选型
// ══════════════════════════════════════════════════════════════════

describe("catalog / select 与 require", () => {
  it.each(G.select)(
    "select needs=$needs prefer=$prefer limit=$limit ex=$exclude_vendors",
    (row) => {
      const cat = new ModelCatalog();
      const got = cat.select(asCaps(row.needs), {
        prefer: row.prefer,
        limit: row.limit,
        excludeVendors: row.exclude_vendors,
      });
      expect(got.map(cardName)).toEqual(row.out);
    },
  );

  it.each(G.require_error)("require($needs) 抛 LookupError 且消息逐字一致", (row) => {
    const cat = new ModelCatalog();
    let caught: unknown = null;
    try {
      cat.require(asCaps(row.needs));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LookupError);
    expect((caught as Error).message).toBe(row.error);
  });

  it("require 挑得出来时原样返回 select 的结果", () => {
    const cat = new ModelCatalog();
    expect(cat.require([Capability.VISION], { limit: 2 }).map(cardName)).toEqual(
      cat.select([Capability.VISION], { limit: 2 }).map(cardName),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：失败学习
// ══════════════════════════════════════════════════════════════════

describe("catalog / recordDenial", () => {
  it("按 Python 的同一串调用逐步走，每步的返回、notes、卡片都对得上", () => {
    const cat = new ModelCatalog();
    for (const step of G.record_denial.steps) {
      const lost = cat.recordDenial(step.model, step.text);
      expect(lost).toBe(step.lost);
      expect(cat.notes).toEqual(step.notes);
      const c = cat.get(step.model);
      expect(c === null ? null : cardToDict(c)).toEqual(step.card);
    }
    expect(cat.byCapability()).toEqual(G.record_denial.final_by_capability);
    expect(cat.names()).toEqual(G.record_denial.final_names);
  });

  it("抹掉能力**不改变模型在目录里的位置** —— 位置决定并列时谁先被试", () => {
    // Map.set 对已存在的键保持原位置（== Python dict）。若改成 delete+set，
    // opus 会被挪到队尾，同质量档下的候选顺序就变了。
    const cat = new ModelCatalog();
    const before = cat.names();
    cat.recordDenial("anthropic/claude-opus-4.8", "does not support image input");
    expect(cat.names()).toEqual(before);
    expect(cat.select([Capability.STRUCTURED], { limit: 1 }).map(cardName)).toEqual([
      "anthropic/claude-opus-4.8",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：discover
// ══════════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  method: string;
  authorization: string;
}

function stubFetch(respond: () => { status: number; body: unknown }): FetchCall[] {
  const seen: FetchCall[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers["Authorization"] ?? "",
    });
    const { status, body } = respond();
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
  return seen;
}

describe("catalog / discover", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetCatalogCache();
  });

  it.each(G.discover)("$name", async (row) => {
    const seen = stubFetch(() => ({
      status: 200,
      // golden 里存的是 Python 收到的那份 live 列表 —— 直接回放它。
      body: { data: row.live.map((id) => ({ id })) },
    }));
    const cat = new ModelCatalog();
    const live = await cat.discover(row.base, row.key);

    expect(live).toEqual(row.live);
    // 打过的 URL 与鉴权头逐字断言：路径拼错一格在网关上就是稳定 404，
    // 而"稳定 404"与"这家网关没这接口"长得一模一样。
    expect(seen).toEqual(
      row.seen.map((s) => ({
        url: s.url,
        method: s.method,
        authorization: s.authorization,
      })),
    );
    expect(cat.notes).toEqual(row.notes);
    expect(cat.names()).toEqual(row.names);
    expect(cat.byCapability()).toEqual(row.by_capability);
    expect(cat.describe()).toEqual(row.describe);
    expect(cat.select([Capability.VISION]).map(cardName)).toEqual(row.select_vision);
  });

  it("`data` 为 null / 缺键都当空列表（Python 的 `.get(\"data\") or []`）", async () => {
    for (const body of [{ data: null }, {}, { data: [] }]) {
      stubFetch(() => ({ status: 200, body }));
      const cat = new ModelCatalog();
      expect(await cat.discover("http://gw.test/v1", "k")).toEqual([]);
      // 网关一个模型都没上 → 目录被清空，_ensure_catalog 正是靠这个退回内置目录
      expect(cat.names()).toEqual([]);
    }
  });

  it.each(G.discover_fail)("$name 抛错且目录**原封不动**", async (row) => {
    stubFetch(() => ({ status: Number(row.name.split("-")[1]), body: {} }));
    const cat = new ModelCatalog();
    await expect(cat.discover("http://gw.test/v1", "k")).rejects.toThrow();
    expect(cat.notes).toEqual(row.notes);
    expect(cat.names()).toEqual(row.names_intact);
  });

  it("模型列表里有一项缺 id 就抛错，不许把 undefined 塞进目录", async () => {
    stubFetch(() => ({ status: 200, body: { data: [{ id: "gpt-4o" }, { name: "x" }] } }));
    const cat = new ModelCatalog();
    await expect(cat.discover("http://gw.test/v1", "k")).rejects.toThrow(/缺少 id/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：SmartGateway
// ══════════════════════════════════════════════════════════════════

interface RecordedCall {
  node: string;
  prompt: string;
  model: string;
  key: string | null;
  rest: Record<string, unknown>;
  effort: string | null;
}

class FakeGateway implements GatewayLike {
  readonly calls: RecordedCall[] = [];

  constructor(readonly behavior: Record<string, string>) {}

  call(nodeId: string, prompt: string, opts: CallOptions = {}): Promise<Completion> {
    const { model = null, key = null, ...rest } = opts;
    const name = model?.name ?? "";
    this.calls.push({
      node: nodeId,
      prompt,
      model: name,
      key,
      rest: rest as Record<string, unknown>,
      effort: model?.effort ?? null,
    });
    const why = this.behavior[name] ?? "";
    if (why) return Promise.reject(new Error(why));
    return Promise.resolve(makeCompletion({ text: `completion:${name}` }));
  }
}

/** golden 里的 kw 是 Python 关键字名，映射回 CallOptions 的 camelCase。 */
function kwToOptions(kw: Record<string, unknown>): Partial<SmartCallOptions> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kw)) {
    if (k === "max_tokens") o["maxTokens"] = v;
    else o[k] = v;
  }
  return o as Partial<SmartCallOptions>;
}

/** 反向：把 TS 侧收到的 rest 映射回 Python 的关键字名，才能与 golden 比。 */
function restToPy(rest: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    o[k === "maxTokens" ? "max_tokens" : k] = v;
  }
  return o;
}

describe("catalog / SmartGateway", () => {
  it.each(G.smart)("$name", async (row) => {
    // 行为表从 golden 的 attempts 反推：哪个模型 ok:false，就让它抛出 attempts
    // 里记下的那段错误文本（那正是 Python 侧那次真抛出来的字符串）。
    const behavior: Record<string, string> = {};
    for (const a of row.report.attempts) {
      if (a["ok"] === false) behavior[String(a["model"])] = String(a["error"]);
    }
    const gw = new FakeGateway(behavior);

    const sg = new SmartGateway(gw);
    const opts: SmartCallOptions = {
      needs: asCaps(row.needs),
      prefer: row.prefer,
      maxCandidates: row.max_candidates,
      preferModels: row.prefer_models,
      ...kwToOptions(row.kw),
    };

    let caught: unknown = null;
    let out: Completion | null = null;
    try {
      out = await sg.call("n1", "p", opts);
    } catch (e) {
      caught = e;
    }

    if (row.exc === null) {
      expect(caught).toBeNull();
      expect(out?.text).toBe(row.out);
    } else {
      expect(caught).toBeInstanceOf(row.exc === "LookupError" ? LookupError : ModelError);
      // 全候选失败的消息里带每个候选的错误摘要（截断点按 code point）。
      expect((caught as Error).message).toBe(row.error);
    }

    expect(
      gw.calls.map((c) => ({
        node: c.node,
        prompt: c.prompt,
        model: c.model,
        key: c.key,
        rest: restToPy(c.rest),
        effort: c.effort,
      })),
    ).toEqual(
      row.calls.map((c) => ({
        node: c.node,
        prompt: c.prompt,
        model: c.model,
        key: c.key,
        rest: c.rest,
        effort: c.effort,
      })),
    );

    const report = sg.report();
    expect(JSON.parse(JSON.stringify(report.attempts))).toEqual(row.report.attempts);
    expect([...report.catalog_notes]).toEqual(row.report.catalog_notes);
    expect(report.by_capability).toEqual(row.report.by_capability);
  });

  it("LookupError 在**发出任何请求之前**抛 —— 不许先花一次钱再说没有模型", async () => {
    const gw = new FakeGateway({});
    const sg = new SmartGateway(gw);
    await expect(
      sg.call("n", "p", { needs: [Capability.VISION, Capability.EFFORT, Capability.CHEAP] }),
    ).rejects.toBeInstanceOf(LookupError);
    expect(gw.calls).toEqual([]);
  });

  it("全部失败时把最后一个根因挂在 cause 上 —— _money_failure 顺着它找欠费", async () => {
    const gw = new FakeGateway({});
    const sg = new SmartGateway(gw);
    for (const c of new ModelCatalog().select([Capability.VISION], { limit: 3 })) {
      gw.behavior[cardName(c)] = "nope";
    }
    const err = await sg.call("n", "p", { needs: [Capability.VISION] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("SmartGateway(gw) 不给目录时自己建一个内置目录", () => {
    expect(new SmartGateway(new FakeGateway({})).catalog.names()).toEqual(
      new ModelCatalog().names(),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  catalog：_ensure_catalog 与 CatalogPort 接线
// ══════════════════════════════════════════════════════════════════

describe("按名字推断能力：视觉与「否决票」的耦合", () => {
  // VISION_RE 和 TEXT_ONLY_RE 必须**一起**改：TEXT_ONLY_RE 是否决票
  // （inferCapabilities 里是 `VISION_RE.test(name) && !TEXT_ONLY_RE.test(name)`）。
  // moonshot / kimi 的家族名整个落在否决票里，视觉款只能靠 `-vision` / `vl`
  // 这一截捞回来 —— 少改一边，加的豁免就是死代码。
  //
  // 漏掉的后果不是「少一个模型选项」：整条扫描件 OCR 通路会以「网关上没有视觉
  // 模型」的名义**静默关掉**，而网关上明明有。这种失败没有报错、没有日志，
  // 只有用户发现图片材料永远读不出内容。
  //
  // golden/catalog.json 只覆盖内置目录里的 kimi-vl-a3b；网关现造的
  // moonshot-v1-*-vision-preview 走 cardFromName，那条路上之前一条测试都没有。
  it("moonshot / kimi 的视觉款认得出来，文本款不误认", () => {
    for (const name of [
      "moonshot-v1-8k-vision-preview",
      "moonshot-v1-32k-vision-preview",
      "moonshot-v1-128k-vision-preview",
      "kimi-vl-a3b",
      "kimi-vl-a3b-thinking",
    ]) {
      expect([...inferCapabilities(name)]).toContain("vision");
    }
    for (const name of ["moonshot-v1-8k", "moonshot-v1-128k", "kimi-k2", "kimi-latest"]) {
      expect([...inferCapabilities(name)]).not.toContain("vision");
    }
  });

  it("**带厂商前缀也要认** —— 网关回来的名字长这样", () => {
    // 网关列出来的名字普遍带前缀（anthropic/… google/… openai/… moonshotai/…）。
    // 而否决票原来写的是 `moonshot(?!.*vision)`：它在 `moonshotai/kimi-vl-a3b` 上
    // 就地命中前缀里的 `moonshot`，后面又确实没有 `vision` 这个词 —— 否决生效，
    // 一个明明是视觉款的模型被判成纯文本。
    //
    // 实测（修之前）：裸名 kimi-vl-a3b-thinking 有 vision，
    // moonshotai/kimi-vl-a3b-thinking 没有。**同一个模型，加个前缀就瞎了。**
    for (const name of ["moonshotai/kimi-vl-a3b", "moonshotai/kimi-vl-a3b-thinking"]) {
      expect([...inferCapabilities(name)]).toContain("vision");
    }
    for (const name of ["moonshotai/kimi-k2", "moonshotai/moonshot-v1-8k"]) {
      expect([...inferCapabilities(name)]).not.toContain("vision");
    }
  });

  it("kimi 的两种视觉命名都认：-vl- 和 -vision", () => {
    // 两半边判据原来不对称：moonshot 那半按 `-vision` 认，kimi 那半只按 `vl` 认，
    // 于是 kimi-latest-vision 这类命名拿不到 vision。
    expect([...inferCapabilities("kimi-latest-vision")]).toContain("vision");
    expect([...inferCapabilities("kimi-vl-a3b")]).toContain("vision");
  });

  it("cardFromName 也走同一条判据 —— 网关现造的卡不能和目录里的卡说法不一致", () => {
    expect([...cardFromName("moonshot-v1-8k-vision-preview").capabilities]).toContain("vision");
    expect([...cardFromName("moonshot-v1-8k").capabilities]).not.toContain("vision");
  });
});

describe("catalog / ensureCatalog（server.py:457）", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetCatalogCache();
  });

  it("发现成功 → 缓存，第二次不再打网关", async () => {
    const seen = stubFetch(() => ({
      status: 200,
      body: { data: [{ id: "gpt-4o" }, { id: "gemini-2.5-flash" }] },
    }));
    const cfg = { baseUrl: "http://gw.test/v1", apiKey: "sk-1" };
    const a = await ensureCatalog(() => cfg);
    const b = await ensureCatalog(() => cfg);
    expect(a).toBe(b);
    expect(seen.length).toBe(1);
    expect(a.names()).toEqual(["gemini-2.5-flash", "gpt-4o"]);
    // 过滤之后视觉候选落到网关真有的模型上 —— 不过滤的话候选是 opus/gpt-5.5，
    // 网关上没有，逐个 404，扫描件静默不进产物。
    expect(a.select([Capability.VISION]).map(cardName)).toEqual([
      "gpt-4o",
      "gemini-2.5-flash",
    ]);
    expect(currentCatalog()).toBe(a);
  });

  it("发现失败 → 退回内置目录，且**不置 OK**（下次 build 再试）", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return { status: 500, body: {} };
    });
    const cfg = { baseUrl: "http://gw.test/v1", apiKey: "sk-1" };
    const a = await ensureCatalog(() => cfg);
    expect(a.names()).toEqual(new ModelCatalog().names());
    await ensureCatalog(() => cfg);
    expect(calls).toBe(2);
  });

  it("配置解析抛错也退回内置目录 —— 发现失败不该拖垮 build", async () => {
    const cat = await ensureCatalog(() => {
      throw new Error("缺少 LLM 网关配置");
    });
    expect(cat.names()).toEqual(new ModelCatalog().names());
  });

  it("命名全不匹配把目录清空了 → 退回内置目录", async () => {
    stubFetch(() => ({ status: 200, body: { data: [{ id: "whisper-1" }] } }));
    const cat = await ensureCatalog(() => ({ baseUrl: "http://gw.test/v1", apiKey: "k" }));
    expect(cat.names()).toEqual(new ModelCatalog().names());
  });

  it("CatalogPort.current() **绝不返回 null** —— Python 是 `_CATALOG or ModelCatalog()`", () => {
    // 返回 null 的话 overrideSpec 会走"目录里没有"的保守分支，把设置页选的模型
    // 一律当 mid 档、无 effort。账单口径与推理深度都悄悄变了，日志里看不出来。
    const port = makeCatalogPort(() => ({ baseUrl: "b", apiKey: "k" }));
    const cur = port.current();
    expect(cur).not.toBeNull();
    expect(cur.get("anthropic/claude-opus-4.8")?.spec.effort).toBe("high");
    const smart = port.makeSmart(null as never, cur);
    expect(smart).toBeInstanceOf(SmartGateway);
    expect(smart.catalog).toBe(cur);
  });
});

// ══════════════════════════════════════════════════════════════════
//  intent：枚举与分句
// ══════════════════════════════════════════════════════════════════

describe("intent / 封闭集合", () => {
  it("Intent 的值与顺序对得上 StrEnum（INTENT_SCHEMA 的 enum 靠它）", () => {
    expect([...INTENTS]).toEqual(GI.intent_values);
  });

  it("MUTATING 一个不多一个不少", () => {
    expect([...MUTATING].sort()).toEqual([...GI.mutating].sort());
  });

  it("parseIntent 对未知值抛错", () => {
    expect(() => parseIntent("adopt")).toThrow();
    expect(parseIntent("adopt_suggestion")).toBe(Intent.ADOPT_SUGGESTION);
  });

  it("INTENT_SCHEMA 逐字节一致（它进 prompt，改一个字模型的输出就变）", () => {
    expect(INTENT_SCHEMA).toEqual(GI.intent_schema);
  });
});

describe("intent / splitClauses", () => {
  it.each(GI.split_clauses)("$in", ({ in: text, out }) => {
    expect(splitClauses(text)).toEqual(out);
  });
});

// ══════════════════════════════════════════════════════════════════
//  intent：规则判定
// ══════════════════════════════════════════════════════════════════

describe("intent / RuleIntentParser.parse", () => {
  it.each(GI.parse.map((r, i) => ({ ...r, i })))("[$i] $text", (row) => {
    const p = new RuleIntentParser({
      questionIds: row.question_ids,
      suggestionIds: row.suggestion_ids,
      objectNames: row.object_names,
    });
    const got = p.parse(row.text);

    expect(intentParseToDict(got)).toEqual(row.out);
    expect(got.matches.map((m) => m.confidence)).toEqual(
      row.matches.map((m) => m.raw_confidence),
    );
    expect(got.matches.map(isMutating)).toEqual(row.matches.map((m) => m.mutating));
    expect(confidentMatches(got).map((m) => m.intent)).toEqual(row.confident);
    expect(needsClarification(got)).toBe(row.needs_clarification);
  });
});

describe("intent / 数据类的默认值与引用", () => {
  it("空 match / 空 parse 的 to_dict", () => {
    expect(intentMatchToDict(makeIntentMatch(Intent.UNKNOWN))).toEqual(
      GI.defaults.match_defaults,
    );
    const p = makeIntentParse("t");
    expect(intentParseToDict(p)).toEqual(GI.defaults.parse_defaults);
    expect(confidentMatches(p).map((m) => m.intent)).toEqual(
      GI.defaults.parse_defaults_confident,
    );
    expect(needsClarification(p)).toBe(GI.defaults.parse_defaults_needs_clarification);
  });

  it("省略 slots 时每次一个新对象 —— 共享引用会让两条 match 互相看见对方的槽位", () => {
    const a = makeIntentMatch(Intent.UNKNOWN);
    const b = makeIntentMatch(Intent.UNKNOWN);
    a.slots["k"] = 1;
    expect(b.slots).toEqual({});
  });

  it("构造器把 id 列表拷一份 —— 调用方之后改自己那份不该影响解析器", () => {
    const ids = ["sg-1"];
    const p = new RuleIntentParser({ suggestionIds: ids });
    ids.push("sg-2");
    expect(p.suggestionIds).toEqual(["sg-1"]);
    expect(new RuleIntentParser().suggestionIds).toEqual(GI.defaults.fresh_lists.s);
  });

  it("round(confidence, 2) 是 half-even，不是 toFixed", () => {
    for (const row of GI.round2) {
      expect(intentMatchToDict(makeIntentMatch(Intent.UNKNOWN, row.in)).confidence).toBe(
        row.out,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  两边共同的 TS 独有风险：\b 的词边界、\s 的空白集、码点长度
// ══════════════════════════════════════════════════════════════════

describe("正则：Python 语义的 \\b / \\s（golden 覆盖不到，因为 Python 侧天然如此）", () => {
  it("中英混输时 \\b 认中文 —— 「采纳adopt」里 adopt 前**没有**词边界", () => {
    // JS 原生 \b 只认 ASCII 词字符，会认为「纳|a」之间有边界、于是命中 adopt。
    // 两边判据不一样，同一句话就会路由到不同 handler。
    const p = new RuleIntentParser({ suggestionIds: ["sg-1"] });
    // "采纳" 这条中文判据照样命中（走的是中文分支），意图不变
    expect(p.parse("采纳adopt").matches[0]!.intent).toBe(Intent.ADOPT_SUGGESTION);
    // 但纯 "xadopt" 里 adopt 前有 ASCII 词字符，两边都不该命中
    expect(p.parse("xadopt").matches[0]!.intent).toBe(Intent.UNKNOWN);
    // 中文紧贴英文动词：Python 不命中 → TS 也不许命中
    expect(p.parse("请你先x同意x").matches[0]!.intent).toBe(Intent.ADOPT_SUGGESTION);
    expect(p.parse("中文approve").matches[0]!.intent).toBe(Intent.UNKNOWN);
  });

  it("catalog 的 \\beffort\\b 同样按 Unicode 词边界判", () => {
    expect(denialCapability("unsupported: effortless mode")).toBeNull();
    expect(denialCapability("unsupported: effort mode")).toBe(Capability.EFFORT);
    // 中文紧贴：Python 的 \b 在「持effort」之间**没有**边界
    expect(denialCapability("不支持 持effort")).toBeNull();
  });

  it("\\s 用 Python 的空白集：U+001F 算空白，U+FEFF 不算", () => {
    // _CHITCHAT 两头都是 `\s*`，所以这两个字符各自决定一句话是不是寒暄：
    // Python 的 str.isspace() 对 U+001F 为真、对 U+FEFF 为假，JS 的 \s 正好反过来。
    // 照抄 `\s` 的后果是「好的<BOM>」被当成寒暄直接回一句客套，而用户真正粘进来的
    // 那段（带 BOM 很常见 —— Excel/记事本导出的文本都带）就被吃掉了。
    const p = new RuleIntentParser();
    expect(p.parse("好的\u001f").matches[0]!.intent).toBe(Intent.CHITCHAT);
    expect(p.parse("\u001f好的").matches[0]!.intent).toBe(Intent.CHITCHAT);
    expect(p.parse("好的\ufeff").matches[0]!.intent).toBe(Intent.UNKNOWN);
    expect(p.parse("\ufeff好的").matches[0]!.intent).toBe(Intent.UNKNOWN);
    // strip 的字符集是显式的 " ，,、"，两个字符都不在里面 —— 原样留在分句里
    expect(splitClauses("a；\u001fb")).toEqual(["a", "\u001fb"]);
    expect(splitClauses("a；\ufeffb")).toEqual(["a", "\ufeffb"]);
  });

  it("_pasted 的 200 阈值数的是 code point，不是 UTF-16 长度", () => {
    // 100 个 emoji：Python len == 100（不算长），JS .length == 200（正好骑在阈值上）
    const emoji = "🙃".repeat(100);
    expect(emoji.length).toBe(200);
    expect(new RuleIntentParser().parse(emoji).matches[0]!.intent).toBe(Intent.UNKNOWN);
    // 201 个中文字：两边都超阈值，span 取前 80 **码点**
    const long = "字".repeat(201);
    const m = new RuleIntentParser().parse(long).matches[0]!;
    expect(m.intent).toBe(Intent.ADD_CONTEXT);
    expect([...m.span].length).toBe(80);
  });

  it("SmartGateway 的错误摘要按码点截断，不切出半个 emoji", async () => {
    const gw = new FakeGateway({});
    const sg = new SmartGateway(gw);
    for (const c of new ModelCatalog().select([Capability.VISION], { limit: 1 })) {
      gw.behavior[cardName(c)] = "🙃".repeat(400);
    }
    const err = (await sg
      .call("n", "p", { needs: [Capability.VISION], maxCandidates: 1 })
      .catch((e: unknown) => e)) as Error;
    const tail = err.message.split(": ").at(-1)!;
    expect([...tail].length).toBe(150);
    expect(tail.endsWith("\ud83d")).toBe(false);
  });
});
