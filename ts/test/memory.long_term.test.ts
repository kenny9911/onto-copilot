/**
 * kernel/memory 的 long_term / dialogue / context / project 四件套的 golden 校验。
 *
 * golden 由 `tools/golden/memory_long_term.py` 从 Python 原件真跑出来（字节确定，
 * 重跑两次 shasum 一致）。**期望值一个都不是手写的** —— 手写的是我对 Python 行为
 * 的猜测，golden 是它的事实。
 *
 * 这一组是「项目内记忆共享但不污染」那个产品特性的全部实现，语义错了特性就废了。
 * 所以除了逐条重放 golden，下面还按护栏的名字各留了一组**反例**断言：不该晋升的
 * 没晋升、不该覆盖的没覆盖、参考档没被洗成权威档、伪造的 quote 被拒。这些断言
 * 即使 golden 某天被人重新导出成"当前行为"，也仍然会在语义倒退时炸掉。
 *
 * 有状态的部分（store / dialogue / project）比的是**算子流**：两边照同一串 ops
 * 重放，逐步比返回值，最后比终态快照。单点断言测不出"第三次写入才出问题"这类
 * 顺序相关的退化。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ContextManager,
  RenderedContext,
  clip,
  makeLayerShares,
  renderUpstream,
} from "../src/kernel/memory/context.js";
import {
  DECISION_KINDS,
  Decision,
  DecisionKind,
  DialogueMemory,
  PROMOTABLE,
  SPEAKERS,
  Speaker,
  Utterance,
  heuristicDigest,
  normQuote,
  parseDecisionKind,
  parseSpeaker,
  userSaid,
} from "../src/kernel/memory/dialogue.js";
import { Chunk, EvidenceIndex } from "../src/kernel/memory/evidence.js";
import {
  LongTermStore,
  PROMOTION_REASONS,
  PromotionGate,
  PromotionReason,
  makeDecayPolicy,
  parsePromotionReason,
  variantOf,
} from "../src/kernel/memory/long_term.js";
import { ProjectMemory, ROW_FIELDS } from "../src/kernel/memory/project.js";
import { Scratchpad, WorkingSet } from "../src/kernel/memory/short_term.js";
import {
  MemoryItem,
  MemoryKind,
  MemoryTier,
  parseMemoryKind,
  parseScope,
  parseMemoryTier,
} from "../src/kernel/memory/types.js";
import type { MemoryItemDict } from "../src/kernel/memory/types.js";

// ── golden 的形状 ────────────────────────────────────────────────

/** 与 `tools/golden/memory_long_term.py` 的 `build()` 同一份 kwargs（snake_case）。 */
interface Init {
  key: string;
  kind: string;
  scope: string;
  content: string;
  confidence?: number;
  support?: string[];
  tags?: string[];
  created_run?: string;
  last_used_run?: string;
  use_count?: number;
  hit_runs?: string[];
  contested_by?: string[];
  tier?: string;
  origin_session?: string;
  origin_files?: string[];
}

interface StoreOp {
  op: string;
  item?: Init;
  items?: Init[];
  reason?: string;
  run_id?: string;
  critic_rounds?: number;
  query?: string;
  kinds?: string[] | null;
  limit?: number;
  budget_tokens?: number | null;
  current_files?: string[] | null;
  run?: string;
  key?: string;
}

interface StoreSpec {
  name: string;
  project?: string;
  gate?: Record<string, unknown>;
  decay?: Record<string, unknown>;
  ops: StoreOp[];
}

interface DialogueOp {
  op: string;
  speaker?: string;
  text?: string;
  intent?: string;
  refs?: string[] | null;
  kind?: string;
  statement?: string;
  scope_refs?: string[];
  kinds?: string[] | null;
  run_id?: string;
  limit?: number;
  threshold?: number;
}

interface DialogueSpec {
  name: string;
  init?: { budget_tokens?: number; keep_verbatim?: number };
  ops: DialogueOp[];
}

interface ProjectOp {
  op: string;
  item?: Init;
  run_id?: string;
  content?: string;
  kind?: string;
  session_id?: string;
  files?: string[];
  support?: string[];
  confidence?: number;
  query?: string;
  current_files?: string[] | null;
  top_k?: number;
}

interface ProjectSpec {
  name: string;
  project_id?: string;
  ops: ProjectOp[];
}

interface ChunkRow {
  chunk_id: string;
  file_id: string;
  file_name: string;
  locator: Record<string, unknown>;
  render: string;
  order?: number;
  tags?: string[];
  context?: string;
}

interface ContextSpec {
  name: string;
  budget: number;
  system: string;
  shares?: Record<string, number>;
  memories: { op: string; item: Init; reason?: string; run_id?: string }[] | null;
  chunks: ChunkRow[];
  reflect?: string[];
  scratch?: {
    budget_tokens: number;
    keep_verbatim: number;
    turns: { thought?: string; action?: string; observation?: string }[];
  };
  assemble: {
    task: string;
    query?: string;
    working?: Record<string, unknown>;
    deps?: string[];
    run_id?: string;
    current_files?: string[];
    recall_kinds?: string[];
    budget_tokens?: number;
    evidence_top_k?: number;
  };
}

interface Golden {
  promotion_reasons: string[];
  speakers: string[];
  decision_kinds: string[];
  promotable_kinds: string[];
  row_fields: string[];
  gate_defaults: Record<string, unknown>;
  decay_defaults: Record<string, unknown>;
  layer_shares_defaults: Record<string, number>;
  gate: {
    gate: Record<string, unknown>;
    item: Init;
    reason: string;
    critic_rounds: number;
    out: [boolean, string];
  }[];
  store: { spec: StoreSpec; results: unknown[]; final: unknown }[];
  score: { item: Init; query: string; current_files: string[] | null; out: number }[];
  variant_of: { old: Init; new: Init; out: string }[];
  heuristic_digest: {
    turns: { speaker: string; text: string; refs?: string[] }[];
    out: string;
  }[];
  dialogue: { spec: DialogueSpec; results: unknown[]; final: unknown }[];
  decision: {
    case: { kind: string; statement: string; scope_refs: string[]; turn: number; run_id: string };
    key: string;
    render: string;
    memory: MemoryItemDict;
  }[];
  user_said: {
    turns: { speaker: string; text: string }[];
    cases: { quote: string; norm: string; out: string }[];
  };
  store_save: { name: string; text: string; reloaded: unknown }[];
  store_load: { in: unknown; out: unknown }[];
  dialogue_from_dict: { in: unknown; out: unknown; active: string[] }[];
  project: { spec: ProjectSpec; results: unknown[]; rows: unknown[] }[];
  from_rows: { project_id: string; rows: Record<string, unknown>[]; out: unknown[] }[];
  clip: { in: string; max_tokens: number; out: string }[];
  render_upstream: { upstream: Record<string, unknown>; budget: number; out: string }[];
  context: {
    spec: ContextSpec;
    text: string;
    layers: Record<string, string>;
    tokens: Record<string, number>;
    chunk_ids: string[];
    recalled: string[];
    compactions: number;
    dropped: string[];
    stats: Record<string, unknown>;
    reflections: string[];
  }[];
}

const G: Golden = JSON.parse(
  readFileSync(pathJoin(import.meta.dirname, "..", "..", "golden", "memory.long_term.json"), "utf8"),
) as Golden;

// ── 造件（与 Python 侧 build() 同一组入参） ─────────────────────

function buildItem(init: Init): MemoryItem {
  return new MemoryItem({
    key: init.key,
    kind: parseMemoryKind(init.kind),
    scope: parseScope(init.scope),
    content: init.content,
    confidence: init.confidence,
    support: init.support,
    tags: init.tags,
    createdRun: init.created_run,
    lastUsedRun: init.last_used_run,
    useCount: init.use_count,
    hitRuns: init.hit_runs,
    contestedBy: init.contested_by,
    tier: init.tier === undefined ? undefined : parseMemoryTier(init.tier),
    originSession: init.origin_session,
    originFiles: init.origin_files,
  });
}

function makeGate(g: Record<string, unknown>): PromotionGate {
  return new PromotionGate({
    minCriticRounds: g["min_critic_rounds"] as number | undefined,
    minDistinctRuns: g["min_distinct_runs"] as number | undefined,
    minConfidence: g["min_confidence"] as number | undefined,
    requireSupport: g["require_support"] as boolean | undefined,
  });
}

/** `time.time()` 出来的时间戳换成占位符 —— golden 侧做了同样的替换。 */
function maskTs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskTs);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === "ts" ? "<ts>" : maskTs(x);
    }
    return out;
  }
  return v;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ══════════════════════════════════════════════════════════════════
//  枚举与默认值
// ══════════════════════════════════════════════════════════════════
describe("枚举与默认值", () => {
  it("PromotionReason 只有四种，顺序与 Python 一致", () => {
    expect(PROMOTION_REASONS).toEqual(G.promotion_reasons);
  });

  it("未知的晋升理由必须抛 —— 从 JSON 读回来的脏值不能悄悄放行", () => {
    expect(() => parsePromotionReason("HUMAN_CONFIRMED")).toThrow();
    expect(() => parsePromotionReason("promoted")).toThrow();
    expect(() => parsePromotionReason(null)).toThrow();
  });

  it("Speaker / DecisionKind 与 Python 同序，未知值抛", () => {
    expect(SPEAKERS).toEqual(G.speakers);
    expect(DECISION_KINDS).toEqual(G.decision_kinds);
    expect(() => parseSpeaker("User")).toThrow();
    expect(() => parseDecisionKind("CALIBER")).toThrow();
  });

  it("PROMOTABLE 只有口径/命名/范围 —— answer/adoption/correction 是就事论事的", () => {
    expect([...PROMOTABLE].sort()).toEqual(G.promotable_kinds);
    expect(PROMOTABLE.has(DecisionKind.ANSWER)).toBe(false);
    expect(PROMOTABLE.has(DecisionKind.ADOPTION)).toBe(false);
    expect(PROMOTABLE.has(DecisionKind.CORRECTION)).toBe(false);
  });

  it("闸门 / 衰减 / 分层占比的默认值", () => {
    const g = new PromotionGate();
    expect(g.minCriticRounds).toBe(G.gate_defaults["min_critic_rounds"]);
    expect(g.minDistinctRuns).toBe(G.gate_defaults["min_distinct_runs"]);
    expect(g.minConfidence).toBe(G.gate_defaults["min_confidence"]);
    expect(g.requireSupport).toBe(G.gate_defaults["require_support"]);

    const d = makeDecayPolicy();
    expect(d.idleRunsBeforeDecay).toBe(G.decay_defaults["idle_runs_before_decay"]);
    expect(d.decayPerRun).toBe(G.decay_defaults["decay_per_run"]);
    expect(d.evictBelow).toBe(G.decay_defaults["evict_below"]);
    expect([...d.immuneKinds].sort()).toEqual(G.decay_defaults["immune_kinds"]);

    const s = makeLayerShares();
    expect(s.system).toBe(G.layer_shares_defaults["system"]);
    expect(s.reflection).toBe(G.layer_shares_defaults["reflection"]);
    expect(s.working).toBe(G.layer_shares_defaults["working"]);
    expect(s.evidenceFloor).toBe(G.layer_shares_defaults["evidence_floor"]);
  });

  it("makeDecayPolicy 每次给新集合 —— 别共享那份 frozenset 的替身", () => {
    const a = makeDecayPolicy();
    const b = makeDecayPolicy();
    expect(a.immuneKinds).not.toBe(b.immuneKinds);
  });

  it("ROW_FIELDS 与 project_memory 表的列名对齐", () => {
    expect([...ROW_FIELDS]).toEqual(G.row_fields);
  });
});

// ══════════════════════════════════════════════════════════════════
//  PromotionGate
// ══════════════════════════════════════════════════════════════════
describe("PromotionGate —— 四种理由之外一律拒", () => {
  it.each(G.gate.map((c, i) => [i, c] as const))("gate[%i]", (_i, c) => {
    const [ok, why] = makeGate(c.gate).check(
      buildItem(c.item),
      parsePromotionReason(c.reason),
      c.critic_rounds,
    );
    expect([ok, why]).toEqual(c.out);
  });

  it("反例：参考档在闸门内部被无条件挡掉，四种理由一个都不放行", () => {
    // 位置是刻意的 —— 写在 reason 分支里的话，HUMAN_CONFIRMED / IMPORTED 那两条
    // 直通分支等于没写；写在调用方的话，recall 攒出来的 hit_runs 就是绕行路。
    const gate = new PromotionGate();
    for (const reason of PROMOTION_REASONS) {
      const it = buildItem({
        key: "lesson:k",
        kind: "lesson",
        scope: "project",
        content: "计划金额大概是含税的",
        support: ["ev:1"],
        hit_runs: ["r1", "r2", "r3"], // REPEATED 的判据凑满
        tier: "reference",
      });
      const [ok, why] = gate.check(it, reason, 9); // critic 轮数也凑满
      expect(ok, `${reason} 竟然放行了参考档`).toBe(false);
      expect(why).toContain("参考档");
    }
  });

  it("反例：没有 support 的记忆一律拒 —— 拿不出依据的不许进长期库", () => {
    const gate = new PromotionGate();
    const it = buildItem({
      key: "fact:k",
      kind: "fact",
      scope: "run",
      content: "金额一律含税",
      support: [],
    });
    for (const reason of PROMOTION_REASONS) {
      expect(gate.check(it, reason, 9)[0]).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  LongTermStore
// ══════════════════════════════════════════════════════════════════
function runStore(spec: StoreSpec): { results: unknown[]; final: unknown } {
  const dk = spec.decay ?? {};
  const store = new LongTermStore(spec.project ?? "proj", {
    gate: makeGate(spec.gate ?? {}),
    decay: makeDecayPolicy({
      idleRunsBeforeDecay: dk["idle_runs_before_decay"] as number | undefined,
      decayPerRun: dk["decay_per_run"] as number | undefined,
      evictBelow: dk["evict_below"] as number | undefined,
      immuneKinds:
        dk["immune_kinds"] === undefined
          ? undefined
          : (dk["immune_kinds"] as string[]).map(parseMemoryKind),
    }),
  });
  const results: unknown[] = [];
  for (const op of spec.ops) {
    switch (op.op) {
      case "promote": {
        const it = buildItem(op.item!);
        const [ok, why] = store.promote(it, parsePromotionReason(op.reason), {
          runId: op.run_id ?? "",
          criticRounds: op.critic_rounds ?? 0,
        });
        results.push({ ok, why, item_after: it.toDict() });
        break;
      }
      case "note": {
        const it = buildItem(op.item!);
        const [ok, why] = store.note(it, { runId: op.run_id ?? "" });
        results.push({ ok, why, item_after: it.toDict() });
        break;
      }
      case "adopt":
        results.push(store.adopt(op.items!.map(buildItem)));
        break;
      case "recall": {
        const got = store.recall(op.query!, {
          runId: op.run_id ?? "",
          kinds: op.kinds == null ? null : op.kinds.map(parseMemoryKind),
          limit: op.limit ?? 8,
          budgetTokens: op.budget_tokens ?? null,
          currentFiles: op.current_files == null ? null : new Set(op.current_files),
        });
        results.push({
          keys: got.map((m) => m.key),
          use_count: got.map((m) => m.useCount),
          hit_runs: got.map((m) => [...m.hitRuns].sort()),
        });
        break;
      }
      case "start_run":
        store.startRun(op.run!);
        results.push(null);
        break;
      case "decay":
        results.push(store.decay(op.run!).map((e) => e.key));
        break;
      case "snapshot":
        results.push(store.toDict());
        break;
      case "get": {
        const got = store.get(op.key!);
        results.push(got === undefined ? null : got.toDict());
        break;
      }
      case "len":
        results.push(store.size);
        break;
      default:
        throw new Error(`未知算子 ${op.op}`);
    }
  }
  return { results, final: store.toDict() };
}

describe("LongTermStore —— 算子流重放", () => {
  it.each(G.store.map((s) => [s.spec.name, s] as const))("%s", (_name, s) => {
    const got = runStore(s.spec);
    expect(got.results).toEqual(s.results);
    expect(got.final).toEqual(s.final);
  });

  it("toDict 的键序即落盘字节序", () => {
    const store = new LongTermStore("proj");
    expect(Object.keys(store.toDict())).toEqual(["project", "runs", "items"]);
  });
});

describe("LongTermStore —— 护栏的反例", () => {
  const auth = (content: string, over: Partial<Init> = {}): MemoryItem =>
    buildItem({
      key: "fact:k",
      kind: "fact",
      scope: "run",
      content,
      support: ["ev:1"],
      ...over,
    });
  const ref = (content: string, over: Partial<Init> = {}): MemoryItem =>
    auth(content, { tier: "reference", scope: "project", ...over });

  it("contested-not-overwrite：冲突时两条并存并标记，不是后写覆盖先写", () => {
    const store = new LongTermStore("proj");
    const a = auth("计划金额口径为含税年度累计");
    store.promote(a, PromotionReason.IMPORTED, { runId: "r1" });
    const b = auth("计划金额口径为不含税单次", { support: ["ev:9"], hit_runs: ["r2", "r3"] });
    const [ok, why] = store.promote(b, PromotionReason.REPEATED, { runId: "r3" });

    expect(ok).toBe(true);
    expect(why).toContain("争议");
    const kept = store.get("fact:k")!;
    // 先写的内容原样还在 —— 静默覆盖等于让系统忘记自己曾经知道过别的
    expect(kept.content).toBe("计划金额口径为含税年度累计");
    expect(kept.contested).toBe(true);
    expect(kept.contestedBy).toEqual([variantOf(kept, b)]);
    expect(kept.confidence).toBeLessThanOrEqual(0.55); // 有争议就不该自信
  });

  it("红队 R4：参考档就算自称 0.99，也不能把人拍板的条目打成 superseded", () => {
    // superseded 会被 recall 直接排除 —— 借到 0.95 这个数字就等于人的约定静默消失。
    const store = new LongTermStore("proj");
    store.promote(auth("计划金额一律按含税年度累计"), PromotionReason.HUMAN_CONFIRMED, {
      runId: "r1",
    });
    const guess = ref("计划金额一律按不含税单次", { confidence: 0.99, support: ["llm:r2"] });
    const [ok, why] = store.note(guess, { runId: "r2" });

    const kept = store.get("fact:k")!;
    expect(ok).toBe(true);
    expect(why).toContain("权威");
    expect(kept.content).toContain("含税年度累计");
    expect(kept.tier).toBe(MemoryTier.AUTHORITATIVE);
    expect(store.all().filter((i) => i.tags.includes("superseded"))).toEqual([]);
    expect(kept.confidence).toBeGreaterThanOrEqual(0.95); // 也不许从排名侧变相覆盖
    expect(store.recall("计划金额", { runId: "r3" }).map((m) => m.key)).toEqual(["fact:k"]);
  });

  it("红队 R4 的判别性用例：权威档只有 0.5 时，参考档的 0.99 也不许覆盖它", () => {
    // 上一条里权威档已经是 0.95，`new >= 0.95 > old` 这个旧判据本来就为假 ——
    // 单靠它测不出洞。真正的洞在 IMPORTED 这条路：confidence 停在 0.5，
    // 参考档借个 0.99 就能把人拍板的条目打进坟场。所以覆盖判据必须**先看档位**。
    const store = new LongTermStore("proj");
    store.promote(auth("计划金额一律按含税年度累计"), PromotionReason.IMPORTED, { runId: "r1" });
    store.note(ref("计划金额一律按不含税单次", { confidence: 0.99, support: ["llm:r2"] }), {
      runId: "r2",
    });

    const kept = store.get("fact:k")!;
    expect(kept.content).toContain("含税年度累计");
    expect(kept.tier).toBe(MemoryTier.AUTHORITATIVE);
    expect(store.all().filter((i) => i.tags.includes("superseded"))).toEqual([]);
    expect(kept.confidence).toBe(0.5); // 也不许从排名侧变相压低
    expect(kept.contested).toBe(true); // 但矛盾要记下来，人能看见
  });

  it("档位裁得了就不回落到数字：0.5 的权威档照样顶掉参考档", () => {
    const store = new LongTermStore("proj");
    store.note(ref("采购包与计划是一对多"), { runId: "r1" });
    const [ok, why] = store.promote(auth("采购包与计划是多对多"), PromotionReason.IMPORTED, {
      runId: "r2",
    });
    expect(ok).toBe(true);
    expect(why).toContain("旧值降级留档");
    expect(store.get("fact:k")!.content).toContain("多对多");
    expect(store.all().filter((i) => i.tags.includes("superseded"))).toHaveLength(1);
  });

  it("反向必须通：人重新拍板顶掉模型的猜测，旧值降级留档而不是删掉", () => {
    const store = new LongTermStore("proj");
    store.note(ref("采购包与计划是一对多"), { runId: "r1" });
    const decided = auth("采购包与计划是多对多", { support: ["human:q2"] });
    const [ok] = store.promote(decided, PromotionReason.HUMAN_CONFIRMED, { runId: "r2" });

    expect(ok).toBe(true);
    expect(store.get("fact:k")!.content).toContain("多对多");
    expect(store.get("fact:k")!.tier).toBe(MemoryTier.AUTHORITATIVE);
    const superseded = store.all().filter((i) => i.tags.includes("superseded"));
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.content).toContain("一对多");
  });

  it("参考档的 support 不许并进权威档 —— 那是从后门进交付物的溯源", () => {
    const store = new LongTermStore("proj");
    store.promote(auth("金额含税", { support: ["human:q1"] }), PromotionReason.HUMAN_CONFIRMED, {
      runId: "r1",
    });
    store.note(ref("金额不含税", { support: ["llm:猜的"] }), { runId: "r2" });
    expect(store.get("fact:k")!.support).toEqual(["human:q1"]);
  });

  it("recall 不给参考档攒 hit_runs（REPEATED 的判据），use_count 照记（衰减要用）", () => {
    const store = new LongTermStore("proj");
    const r = ref("采购包和计划八成是一对多", { key: "lesson:ref", kind: "lesson" });
    store.note(r, { runId: "r1" });
    const a = auth("采购包与计划一对多", { key: "fact:auth" });
    store.promote(a, PromotionReason.IMPORTED, { runId: "r1" });

    for (const run of ["r2", "r3", "r4"]) store.recall("采购包 计划", { runId: run, limit: 10 });

    expect([...store.get("lesson:ref")!.hitRuns]).toEqual([]);
    expect(store.get("lesson:ref")!.useCount).toBe(3);
    expect(store.get("fact:auth")!.hitRuns.size).toBeGreaterThanOrEqual(3);
  });

  it("参考档不许借 DECISION 这个 kind（1.3 prior + 衰减豁免）", () => {
    const store = new LongTermStore("proj");
    const bad = ref("金额口径以财务表为准", { kind: "decision" });
    const [ok1, why1] = store.promote(bad, PromotionReason.HUMAN_CONFIRMED, { runId: "r1" });
    const [ok2, why2] = store.note(bad, { runId: "r1" });
    expect(ok1).toBe(false);
    expect(why1).toContain("decision");
    expect(ok2).toBe(false);
    expect(why2).toContain("decision");
    expect(store.size).toBe(0);
  });

  it("衰减：老记忆掉权重但**不删除**，跌破地板才淘汰；DECISION 完全豁免", () => {
    const store = new LongTermStore("proj", {
      decay: makeDecayPolicy({ idleRunsBeforeDecay: 1, decayPerRun: 0.2, evictBelow: 0.1 }),
    });
    const stale = auth("旧约定：金额列叫 amt", { key: "convention:stale", confidence: 0.9 });
    store.promote(stale, PromotionReason.IMPORTED, { runId: "r1" });
    const decision = auth("拆成两个属性", { key: "decision:keep", kind: "decision" });
    store.promote(decision, PromotionReason.HUMAN_CONFIRMED, { runId: "r1" });

    for (const r of ["r2", "r3", "r4"]) store.startRun(r);
    const evicted = store.decay("r4");

    expect(evicted).toEqual([]); // 还没跌破地板 → 一条都不许消失
    expect(store.get("convention:stale")!.confidence).toBeLessThan(0.9);
    expect(store.get("decision:keep")!.confidence).toBe(0.95); // 人拍板的不衰减
    expect(store.size).toBe(2);
  });

  it("note() 只收参考档 —— 权威档必须走 promote 过闸门", () => {
    const store = new LongTermStore("proj");
    const [ok, why] = store.note(auth("人拍的板"), { runId: "r1" });
    expect(ok).toBe(false);
    expect(why).toContain("promote");
    expect(store.size).toBe(0);
  });
});

describe("LongTermStore 的持久化", () => {
  const tmp = (): string => mkdtempSync(pathJoin(tmpdir(), "ontocopilot-mem-"));

  it.each(G.store_save.map((c) => [c.name, c] as const))("save/load 往返：%s", (_n, c) => {
    // 先证明 TS 读得懂 Python 时代那份 mem.json —— 迁移的目标是原地换宿主，
    // 不是换一套数据格式（契约 §7.2 对 store 层的同一条要求）。
    const dir = tmp();
    const py = pathJoin(dir, "py.json");
    writeFileSync(py, c.text, "utf8");
    const fromPython = LongTermStore.load(py);
    expect(fromPython.toDict()).toEqual(c.reloaded);

    // 再证明 TS 自己写出来的能被自己读回来，且内容与 Python 那份等价。
    const ts = pathJoin(dir, "嵌套/目录/ts.json"); // save 要自己建父目录
    fromPython.save(ts);
    expect(LongTermStore.load(ts).toDict()).toEqual(c.reloaded);
    // **已知分叉**：`json.dumps` 把 float 1.0 写成 "1.0"，`JSON.stringify` 写成
    // "1"。所以两份文件按**解析后**等价、按字节不等价。save 只在测试/离线工具里
    // 用（服务端走 project_memory 表），这个差别不影响任何生产路径。
    expect(JSON.parse(readFileSync(ts, "utf8"))).toEqual(JSON.parse(c.text));
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(G.store_load.map((c, i) => [i, c] as const))("load[%i]", (_i, c) => {
    const dir = tmp();
    const p = pathJoin(dir, "mem.json");
    writeFileSync(p, JSON.stringify(c.in), "utf8");
    expect(LongTermStore.load(p).toDict()).toEqual(c.out);
    rmSync(dir, { recursive: true, force: true });
  });

  it("老 mem.json 没有 tier / origin_* 三个字段，读回来必须是权威档", () => {
    // load 对 fromDict 没有异常兜底 —— 少一个默认值就是老库一读就崩。
    const c = G.store_load[0]!;
    const dir = tmp();
    const p = pathJoin(dir, "mem.json");
    writeFileSync(p, JSON.stringify(c.in), "utf8");
    const st = LongTermStore.load(p);
    expect(st.size).toBe(1);
    expect(st.all()[0]!.tier).toBe(MemoryTier.AUTHORITATIVE);
    expect(st.all()[0]!.originSession).toBe("");
    expect(st.all()[0]!.originFiles).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("DialogueMemory.fromDict", () => {
  it.each(G.dialogue_from_dict.map((c, i) => [i, c] as const))("from_dict[%i]", (_i, c) => {
    const dm = DialogueMemory.fromDict(c.in);
    expect(maskTs(dm.toDict())).toEqual(c.out);
    expect(dm.activeDecisions().map((d) => d.statement)).toEqual(c.active);
  });

  it("active 不是存出来的字段 —— 靠 supersededBy 还原，避免两处真相打架", () => {
    // 存档里那个 `"active": true` 是**输出**，读回来必须忽略它。
    const dm = DialogueMemory.fromDict({
      decisions: [
        { kind: "caliber", statement: "含税", active: true, superseded_by: 1 },
        { kind: "caliber", statement: "不含税", active: false, superseded_by: null },
      ],
    });
    expect(dm.decisions[0]!.active).toBe(false);
    expect(dm.decisions[1]!.active).toBe(true);
  });
});

describe("_score", () => {
  it.each(G.score.map((c, i) => [i, c] as const))("score[%i]", (_i, c) => {
    const store = new LongTermStore("p");
    // `score` 在 TS 侧是 private（Python 是 `_score`）。这里用下标访问穿透 ——
    // 打分是排序的唯一依据，排序出问题时要能一眼分清是分数错了还是排序错了。
    const got = (store as unknown as { score: (i: MemoryItem, q: string, f: Set<string> | null) => number }).score(
      buildItem(c.item),
      c.query,
      c.current_files === null ? null : new Set(c.current_files),
    );
    // `math.log1p` 与 `Math.log1p` 都不是规范要求正确舍入的，理论上可能差 1 ulp。
    // 所以分数用近似断言，**顺序**（store 场景里的 recall）用精确断言。
    if (c.out === 0) expect(got).toBe(0);
    else expect(got).toBeCloseTo(c.out, 12);
  });
});

describe("variantOf", () => {
  it.each(G.variant_of.map((c, i) => [i, c] as const))("variant_of[%i]", (_i, c) => {
    expect(variantOf(buildItem(c.old), buildItem(c.new))).toBe(c.out);
  });
});

// ══════════════════════════════════════════════════════════════════
//  dialogue
// ══════════════════════════════════════════════════════════════════
describe("heuristicDigest", () => {
  it.each(G.heuristic_digest.map((c, i) => [i, c] as const))("digest[%i]", (_i, c) => {
    const turns = c.turns.map(
      (t) => new Utterance({ speaker: parseSpeaker(t.speaker), text: t.text, refs: t.refs ?? [] }),
    );
    expect(heuristicDigest(turns)).toBe(c.out);
  });

  it("绝不产出一条空摘要 —— 冒号后面什么都没有等于凭空吞掉两轮", () => {
    const turns = [new Utterance({ speaker: Speaker.USER, text: "  " })];
    const out = heuristicDigest(turns);
    expect(out.endsWith("：")).toBe(false);
    expect(out).toContain("已压缩");
  });
});

function runDialogue(spec: DialogueSpec): { results: unknown[]; final: unknown } {
  const dm = new DialogueMemory({
    budgetTokens: spec.init?.budget_tokens,
    keepVerbatim: spec.init?.keep_verbatim,
  });
  const results: unknown[] = [];
  for (const op of spec.ops) {
    switch (op.op) {
      case "say":
        results.push(
          maskTs(
            dm.say(op.speaker!, op.text!, { intent: op.intent ?? "", refs: op.refs ?? [] }).toDict(),
          ),
        );
        break;
      case "decide":
        results.push(
          maskTs(dm.decide(op.kind!, op.statement!, { scopeRefs: op.scope_refs ?? [] }).toDict()),
        );
        break;
      case "active_decisions": {
        const got = dm.activeDecisions({
          ...(op.kinds == null ? {} : { kinds: op.kinds.map(parseDecisionKind) }),
          ...(has(op, "refs") ? { refs: op.refs } : {}),
        });
        results.push(got.map((d) => d.statement));
        break;
      }
      case "promotable":
        results.push(dm.promotable(op.run_id!).map((m) => m.toDict()));
        break;
      case "render_decisions":
        results.push(dm.renderDecisions(has(op, "refs") ? { refs: op.refs } : {}));
        break;
      case "render_recent":
        results.push(dm.renderRecent(op.limit!));
        break;
      case "compact":
        results.push(dm.compact());
        break;
      case "compact_to_fit":
        results.push(dm.compactToFit(op.threshold ?? 0.7));
        break;
      case "over_budget":
        results.push(dm.overBudget(op.threshold ?? 0.7));
        break;
      case "tokens":
        results.push(dm.tokens);
        break;
      case "len":
        results.push(dm.length);
        break;
      case "snapshot":
        results.push(maskTs(dm.toDict()));
        break;
      default:
        throw new Error(`未知算子 ${op.op}`);
    }
  }
  return { results, final: maskTs(dm.toDict()) };
}

describe("DialogueMemory —— 算子流重放", () => {
  it.each(G.dialogue.map((s) => [s.spec.name, s] as const))("%s", (_name, s) => {
    const got = runDialogue(s.spec);
    expect(got.results).toEqual(s.results);
    expect(got.final).toEqual(s.final);
  });

  it("反例：压缩吃掉轮次，但决定一条都不掉", () => {
    // 滚动窗口做不到这一点：第 40 轮时第 3 轮那句口径约定已经滑出窗口了，
    // 而它恰恰是最该活到最后的东西。
    const dm = new DialogueMemory({ keepVerbatim: 2 });
    dm.say(Speaker.USER, "含税一律指增值税专用发票口径");
    dm.decide(DecisionKind.CALIBER, "含税一律指增值税专用发票口径");
    for (let i = 0; i < 6; i++) dm.say(Speaker.USER, `闲聊第 ${i} 句`);
    expect(dm.compact()).toBe(true);
    expect(dm.length).toBe(3);
    expect(dm.activeDecisions()).toHaveLength(1);
    expect(dm.renderDecisions()).toContain("增值税专用发票");
  });

  it("反例：被推翻的决定不删除也不进 promotable —— 改主意的过程要留档", () => {
    const dm = new DialogueMemory();
    dm.decide(DecisionKind.CALIBER, "含税");
    dm.decide(DecisionKind.CALIBER, "不含税");
    expect(dm.decisions).toHaveLength(2);
    expect(dm.decisions[0]!.active).toBe(false);
    expect(dm.decisions[0]!.supersededBy).toBe(1);
    expect(dm.promotable("r1").map((m) => m.content)).toEqual(["不含税"]);
  });

  it("renderRecent(0) 是 Python 切片陷阱：给的是**全部**，不是空", () => {
    const dm = new DialogueMemory();
    dm.say(Speaker.USER, "一");
    dm.say(Speaker.ASSISTANT, "二");
    expect(dm.renderRecent(0)).toBe("用户: 一\n助手: 二");
    expect(dm.renderRecent(1)).toBe("助手: 二");
  });
});

describe("Decision", () => {
  it.each(G.decision.map((c, i) => [i, c] as const))("decision[%i]", (_i, c) => {
    const d = new Decision({
      kind: parseDecisionKind(c.case.kind),
      statement: c.case.statement,
      scopeRefs: c.case.scope_refs,
      turnIndex: c.case.turn,
    });
    expect(d.key).toBe(c.key);
    expect(d.render()).toBe(c.render);
    expect(d.toMemory(c.case.run_id).toDict()).toEqual(c.memory);
  });

  it("NAMING 转成 CONVENTION，其余转 DECISION", () => {
    const naming = new Decision({ kind: DecisionKind.NAMING, statement: "s" });
    const caliber = new Decision({ kind: DecisionKind.CALIBER, statement: "s" });
    expect(naming.toMemory("r1").kind).toBe(MemoryKind.CONVENTION);
    expect(caliber.toMemory("r1").kind).toBe(MemoryKind.DECISION);
  });
});

// ══════════════════════════════════════════════════════════════════
//  quote 校验 —— 「参考档洗成权威档」的堵点
// ══════════════════════════════════════════════════════════════════
describe("userSaid / normQuote", () => {
  const dm = new DialogueMemory();
  for (const t of G.user_said.turns) dm.say(t.speaker, t.text);

  it.each(G.user_said.cases.map((c, i) => [i, c] as const))("user_said[%i]", (_i, c) => {
    expect(normQuote(c.quote)).toBe(c.norm);
    expect(userSaid(dm, c.quote)).toBe(c.out);
  });

  it("反例：伪造的 quote 被拒 —— 模型从 L3 里读到的参考档断言不算人说过", () => {
    // 红队复现：第一个会话里模型猜出来的口径进了参考档，第二个会话把它渲染进
    // L3，模型逐字读到之后调 decision.record 把它当成用户拍的板 —— 一条推断就
    // 这样变成同项目所有后续会话的「人已拍板」，置信度 1.0、不带任何标注。
    const s = new DialogueMemory();
    s.say(Speaker.USER, "你好，这份材料能看吗");
    s.say(Speaker.ASSISTANT, "参考·来自会话《需求澄清》·未确认：计划金额一律按含税年度累计");
    expect(userSaid(s, "计划金额一律按含税年度累计")).toBe("");
    // 助手说过不算，系统说过也不算
    s.say(Speaker.SYSTEM, "已完成梳理，171 个对象");
    expect(userSaid(s, "已完成梳理")).toBe("");
    // 用户真说过才算，且标点/空白变了仍然算
    expect(userSaid(s, "这份材料，能看吗？")).toBe("你好，这份材料能看吗");
    expect(userSaid(s, " 这 份 材 料 能 看 吗 ")).toBe("你好，这份材料能看吗");
  });

  it("反例：归一化后不足两个字符的 quote 一律拒 —— 一个字能命中几乎任何一句", () => {
    const s = new DialogueMemory();
    s.say(Speaker.USER, "计划金额一律按含税年度累计");
    expect(userSaid(s, "计")).toBe("");
    expect(userSaid(s, "，。")).toBe("");
    expect(userSaid(s, "")).toBe("");
    expect(userSaid(s, "计划")).toBe("计划金额一律按含税年度累计");
  });

  it("同一句话说过多次时，出处取**最近**的那一轮", () => {
    const s = new DialogueMemory();
    s.say(Speaker.USER, "金额含税（第一次说）");
    s.say(Speaker.USER, "金额含税（第二次说）");
    expect(userSaid(s, "金额含税")).toBe("金额含税（第二次说）");
  });
});

// ══════════════════════════════════════════════════════════════════
//  project
// ══════════════════════════════════════════════════════════════════
function runProject(spec: ProjectSpec): { results: unknown[]; rows: unknown[] } {
  const pm = new ProjectMemory(spec.project_id ?? "p1");
  const results: unknown[] = [];
  for (const op of spec.ops) {
    switch (op.op) {
      case "remember_decision": {
        const [ok, why] = pm.rememberDecision(buildItem(op.item!), { runId: op.run_id ?? "" });
        results.push({ ok, why });
        break;
      }
      case "observe":
        results.push(
          pm
            .observe(op.content!, {
              kind: parseMemoryKind(op.kind ?? "lesson"),
              runId: op.run_id ?? "",
              sessionId: op.session_id ?? "",
              files: op.files ?? [],
              support: op.support ?? [],
              confidence: op.confidence ?? 0.5,
            })
            .toDict(),
        );
        break;
      case "recall":
        results.push(
          pm
            .recall(op.query!, {
              runId: op.run_id ?? "",
              currentFiles: op.current_files == null ? null : new Set(op.current_files),
              topK: op.top_k ?? 8,
            })
            .map((m) => m.key),
        );
        break;
      case "authoritative":
        results.push(pm.authoritative().map((m) => m.key));
        break;
      case "rows":
        results.push(pm.toRows());
        break;
      case "len":
        results.push(pm.size);
        break;
      default:
        throw new Error(`未知算子 ${op.op}`);
    }
  }
  return { results, rows: pm.toRows() };
}

describe("ProjectMemory —— 算子流重放", () => {
  it.each(G.project.map((s) => [s.spec.name, s] as const))("%s", (_name, s) => {
    const got = runProject(s.spec);
    expect(got.results).toEqual(s.results);
    expect(got.rows).toEqual(s.rows);
  });

  it.each(G.from_rows.map((c, i) => [i, c] as const))("from_rows[%i]", (_i, c) => {
    expect(ProjectMemory.fromRows(c.project_id, c.rows).toRows()).toEqual(c.out);
  });

  it("行的键序与 ROW_FIELDS 一致", () => {
    const pm = new ProjectMemory("p1");
    pm.observe("随便一条", { runId: "r1" });
    expect(Object.keys(pm.toRows()[0]!)).toEqual([...ROW_FIELDS]);
  });

  it("反例：参考档不能改标成权威 —— 升权威只能靠人在本会话里重新拍板", () => {
    const pm = new ProjectMemory("p1");
    const stale = buildItem({
      key: "lesson:k",
      kind: "lesson",
      scope: "project",
      content: "我猜金额是含税的",
      support: ["ev:1"],
      tier: "reference",
    });
    const [ok, why] = pm.rememberDecision(stale, { runId: "r1" });
    expect(ok).toBe(false);
    expect(why).toContain("重新构造");
    expect(pm.size).toBe(0);
  });

  it("反例：另一个项目的行被丢掉 —— 隔离靠实例，memKey 不含 project", () => {
    const pm = ProjectMemory.fromRows("p1", [
      { project_id: "p1", key: "fact:a", tier: "authoritative", kind: "fact", content: "本项目金额含税" },
      { project_id: "p2", key: "fact:a", tier: "authoritative", kind: "fact", content: "另一个项目金额不含税" },
    ]);
    expect(pm.size).toBe(1);
    expect(pm.store.get("fact:a")!.content).toContain("本项目");
  });

  it("反例：落盘一圈不会把参考档洗白 —— 装回来还是参考档，且照样晋升不了", () => {
    const pm = new ProjectMemory("p1");
    pm.observe("采购包名在 DDL 里叫 pkg_no", { runId: "r1", sessionId: "s7", files: ["schema.ddl"] });
    const again = ProjectMemory.fromRows("p1", pm.toRows());
    const refs = again.store.all().filter((i) => i.tier === MemoryTier.REFERENCE);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.originSession).toBe("s7");
    expect(refs[0]!.originFiles).toEqual(["schema.ddl"]);
    const [ok] = again.store.promote(refs[0]!, PromotionReason.HUMAN_CONFIRMED, { runId: "r2" });
    expect(ok).toBe(false);
  });

  it("observe 借 DECISION 会被改记成 LESSON，而不是放它进 DECISION", () => {
    const pm = new ProjectMemory("p1");
    const it = pm.observe("金额口径以财务表为准", { kind: MemoryKind.DECISION, runId: "r1" });
    expect(it.kind).toBe(MemoryKind.LESSON);
    expect(it.tier).toBe(MemoryTier.REFERENCE);
    expect(pm.authoritative()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  context —— 四层装配
// ══════════════════════════════════════════════════════════════════
describe("_clip / _render_upstream", () => {
  it.each(G.clip.map((c, i) => [i, c] as const))("clip[%i]", (_i, c) => {
    expect(clip(c.in, c.max_tokens)).toBe(c.out);
  });

  it.each(G.render_upstream.map((c, i) => [i, c] as const))("render_upstream[%i]", (_i, c) => {
    expect(renderUpstream(c.upstream, c.budget)).toBe(c.out);
  });

  it("切点按码点 —— 切在代理对中间会产生落单代理，那是坏数据", () => {
    const out = clip("😀".repeat(50), 5);
    expect([...out].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
      true,
    );
  });
});

function runContext(spec: ContextSpec): Record<string, unknown> {
  let lt: LongTermStore | null = null;
  if (spec.memories !== null) {
    lt = new LongTermStore("proj");
    for (const m of spec.memories) {
      const it = buildItem(m.item);
      if (m.op === "promote") {
        lt.promote(it, parsePromotionReason(m.reason), { runId: m.run_id ?? "" });
      } else {
        lt.note(it, { runId: m.run_id ?? "" });
      }
    }
  }

  const ix = new EvidenceIndex();
  for (const c of spec.chunks) {
    ix.add(
      new Chunk({
        chunkId: c.chunk_id,
        fileId: c.file_id,
        fileName: c.file_name,
        locator: c.locator,
        render: c.render,
        order: c.order ?? 0,
        tags: c.tags ?? [],
        context: c.context ?? "",
      }),
    );
  }

  const cm = new ContextManager({
    system: spec.system,
    longTerm: lt,
    evidence: ix,
    budgetTokens: spec.budget,
    shares: makeLayerShares({
      system: spec.shares?.["system"],
      reflection: spec.shares?.["reflection"],
      working: spec.shares?.["working"],
      evidenceFloor: spec.shares?.["evidence_floor"],
    }),
  });
  for (const lesson of spec.reflect ?? []) cm.reflect(lesson);

  const a = spec.assemble;
  let ws: WorkingSet | null = null;
  if (a.working !== undefined) {
    ws = new WorkingSet();
    for (const [nid, out] of Object.entries(a.working)) ws.put(nid, out);
  }
  let pad: Scratchpad | null = null;
  if (spec.scratch !== undefined) {
    pad = new Scratchpad({
      budgetTokens: spec.scratch.budget_tokens,
      keepVerbatim: spec.scratch.keep_verbatim,
    });
    for (const t of spec.scratch.turns) pad.append(t.thought ?? "", t.action ?? "", t.observation ?? "");
  }

  const ctx = cm.assemble({
    task: a.task,
    query: a.query ?? "",
    working: ws,
    deps: a.deps ?? null,
    scratch: pad,
    runId: a.run_id ?? "",
    evidenceTopK: a.evidence_top_k ?? 24,
    budgetTokens: a.budget_tokens ?? null,
    recallKinds: a.recall_kinds === undefined ? null : a.recall_kinds.map(parseMemoryKind),
    currentFiles: a.current_files === undefined ? null : new Set(a.current_files),
  });

  return {
    text: ctx.text,
    layers: ctx.layers,
    tokens: ctx.tokens,
    chunk_ids: ctx.chunks.map((c) => c.chunkId),
    recalled: ctx.recalled.map((m) => m.key),
    compactions: ctx.compactions,
    dropped: ctx.dropped,
    stats: ctx.stats(),
    reflections: cm.reflections,
  };
}

describe("ContextManager.assemble —— 逐层比对", () => {
  it.each(G.context.map((c) => [c.spec.name, c] as const))("%s", (_name, c) => {
    const got = runContext(c.spec);
    expect(got["layers"]).toEqual(c.layers);
    expect(got["tokens"]).toEqual(c.tokens);
    expect(got["text"]).toBe(c.text);
    expect(got["chunk_ids"]).toEqual(c.chunk_ids);
    expect(got["recalled"]).toEqual(c.recalled);
    expect(got["compactions"]).toBe(c.compactions);
    expect(got["dropped"]).toEqual(c.dropped);
    expect(got["stats"]).toEqual(c.stats);
    expect(got["reflections"]).toEqual(c.reflections);
  });

  it("装配顺序即优先级：L0 → L3 → L1 → L2", () => {
    // 顺序错了模型看到的上下文就变了，而那是不报错的那种错。
    const c = G.context.find((x) => x.spec.name === "layers_in_priority_order")!;
    const body = c.text;
    expect(body.indexOf("本体建模助手")).toBeLessThan(body.indexOf("已知约定"));
    expect(body.indexOf("已知约定")).toBeLessThan(body.indexOf("上游产出"));
    expect(body.indexOf("上游产出")).toBeLessThan(body.indexOf("证据切片"));
    const got = runContext(c.spec);
    expect(got["text"]).toBe(body);
    expect(Object.keys(got["tokens"] as object)).toEqual([
      "L0_system",
      "L3_reflection",
      "L1_working",
      "L2_evidence",
    ]);
  });

  it("反例：前三层挤占证据地板时削 working，不削证据", () => {
    const c = G.context.find((x) => x.spec.name === "evidence_floor_defended")!;
    const got = runContext(c.spec) as { tokens: Record<string, number>; dropped: string[] };
    expect(got.tokens["L2_evidence"]!).toBeGreaterThan(0); // 证据层不能被挤到 0
    expect(got.dropped.some((d) => d.includes("working"))).toBe(true);
    const total = Object.values(got.tokens).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(c.spec.budget);
  });

  it("反例：L3 被硬截断时，参考档的来源标注仍挤在每条**内容前面**", () => {
    // 标注写在条目末尾会被 _clip 切掉，只剩一句看着像事实的断言。
    const c = G.context.find((x) => x.spec.name === "reference_annotation_survives_clipping")!;
    const got = runContext(c.spec) as { layers: Record<string, string> };
    const l3 = got.layers["L3_reflection"]!;
    expect(l3).toContain("…[已截断]"); // 预算没卡住就没测到东西
    expect(l3).toContain("上一个会话");
    const carrying = l3.split("\n").filter((ln) => ln.includes("计划金额"));
    expect(carrying.length).toBeGreaterThan(0);
    for (const ln of carrying) {
      expect(ln).toContain("参考");
      expect(ln).toContain("未确认");
    }
  });

  it("反例：只有跨材料那条被标「另一份材料」，且它排在后面", () => {
    const c = G.context.find((x) => x.spec.name === "foreign_material_marked_once")!;
    const got = runContext(c.spec) as { recalled: string[]; text: string };
    expect(got.recalled).toEqual(["lesson:near", "lesson:far"]);
    expect(got.text).toContain("另一份材料");
    expect(got.text.split("另一份材料").length - 1).toBe(1);
  });

  it("reflect 去重且忽略空串", () => {
    const cm = new ContextManager();
    cm.reflect("教训");
    cm.reflect("教训");
    cm.reflect("");
    expect(cm.reflections).toEqual(["教训"]);
    // 返回的是副本 —— 外面改它不该动到内部状态
    cm.reflections.push("偷偷加的");
    expect(cm.reflections).toEqual(["教训"]);
  });

  it("RenderedContext.totalTokens 是各层之和", () => {
    const ctx = new RenderedContext("");
    ctx.tokens["a"] = 3;
    ctx.tokens["b"] = 4;
    expect(ctx.totalTokens).toBe(7);
  });
});
