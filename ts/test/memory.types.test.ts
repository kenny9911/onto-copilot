/**
 * kernel/memory/types 的 golden 校验。
 *
 * golden 由 `tools/golden/memory_types.py` 从 Python 原件真跑出来（字节确定，重跑
 * 两次 shasum 一致）。**一个期望值都不是手写的** —— 手写的是我对 Python 行为的
 * 猜测，golden 是它的事实。下游六个模块都吃这套类型，猜错一次赔六次。
 *
 * 三条已知的语言分叉在这里被正面钉住，而不是绕开：
 *   1. `len(text)` 是码点、`.length` 是码元 —— golden 里带 cp_len，逐条对照；
 *   2. `round(x,3)` ties-to-even vs `toFixed` ties-away —— 三个精确并列点；
 *   3. `sorted()` 码点序 vs `Array.sort` 码元序 —— hit_runs 里塞了 U+FFFF/U+10000。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MEMORY_KINDS,
  MEMORY_TIERS,
  MemoryItem,
  MemoryKind,
  MemoryTier,
  SCOPES,
  Scope,
  estTokens,
  memKey,
  parseMemoryKind,
  parseMemoryTier,
  parseScope,
  type MemoryItemDict,
} from "../src/kernel/memory/types.js";

// ── golden 的形状 ────────────────────────────────────────────────

/** 与 `tools/golden/memory_types.py` 里的 `build()` 同一份 kwargs（全 snake_case）。 */
interface Init {
  key: string;
  kind: string;
  scope: string;
  content: string;
  confidence?: number;
  support?: string[];
  tags?: string[];
  meta?: Record<string, unknown>;
  created_run?: string;
  last_used_run?: string;
  use_count?: number;
  hit_runs?: string[];
  contested_by?: string[];
  tier?: string;
  origin_session?: string;
  origin_files?: string[];
}

interface Golden {
  enums: { scope: string[]; kind: string[]; tier: string[] };
  est_tokens: { in: string; cp_len: number; out: number }[];
  to_dict: {
    init: Init;
    out: MemoryItemDict;
    key_order: string[];
    tokens: number;
    contested: boolean;
  }[];
  from_dict: { in: Record<string, unknown>; out: MemoryItemDict }[];
  render: { init: Init; foreign_material: boolean; out: string }[];
  from_other_material: { init: Init; current: string[] | null; out: boolean }[];
  mem_key: { kind: string; subject: string; out: string }[];
  parse_rejects: { enum: string; value: string; message: string }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "memory.types.json"), "utf8"),
) as Golden;

/** 照 golden 的 init 造一条 —— 两边必须是同一组入参，否则比的不是同一件事。 */
function build(init: Init): MemoryItem {
  return new MemoryItem({
    key: init.key,
    kind: parseMemoryKind(init.kind),
    scope: parseScope(init.scope),
    content: init.content,
    confidence: init.confidence,
    support: init.support,
    tags: init.tags,
    meta: init.meta,
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

// ── 枚举 ─────────────────────────────────────────────────────────

describe("枚举", () => {
  it("取值与顺序与 Python 一致", () => {
    expect(SCOPES).toEqual(G.enums.scope);
    expect(MEMORY_KINDS).toEqual(G.enums.kind);
    expect(MEMORY_TIERS).toEqual(G.enums.tier);
  });

  it("AUTHORITATIVE / REFERENCE 的字面量就是落盘的那两个串", () => {
    // 这两个串会进库、进 mem.json、进 prompt 判断。改一个字母 = 老库全部降级。
    expect(MemoryTier.AUTHORITATIVE).toBe("authoritative");
    expect(MemoryTier.REFERENCE).toBe("reference");
    expect(Scope.PROJECT).toBe("project");
    expect(MemoryKind.DECISION).toBe("decision");
  });

  it("未知值一律抛，不静默放行", () => {
    // golden 的 parse_rejects 钉的是「Python 侧确实抛了 ValueError」这件事；
    // 消息文案两边不同（TS 侧沿用 events.ts 的中文格式），只断言抛。
    const parsers: Record<string, (v: unknown) => unknown> = {
      Scope: parseScope,
      MemoryKind: parseMemoryKind,
      MemoryTier: parseMemoryTier,
    };
    for (const row of G.parse_rejects) {
      const parse = parsers[row.enum]!;
      expect(() => parse(row.value)).toThrow();
    }
    // 大小写、空串、非串一律不认
    expect(() => parseScope("Node")).toThrow();
    expect(() => parseScope("")).toThrow();
    expect(() => parseMemoryKind(null)).toThrow();
    expect(() => parseMemoryTier(0)).toThrow();
  });
});

// ── est_tokens ───────────────────────────────────────────────────

describe("estTokens", () => {
  it("与 Python 逐条一致（含四段 CJK 区间的边界）", () => {
    for (const row of G.est_tokens) {
      expect(estTokens(row.in), JSON.stringify(row.in)).toBe(row.out);
    }
  });

  it("星平面字符按码点数，不按 UTF-16 码元数", () => {
    // 这条是 .length 与 len() 分叉的最短复现：Python 4 码点 → 1，
    // 用 .length（8）会算成 2。golden 里已经含这几条，这里再单独立一个断言，
    // 让将来"优化"成 text.length 的人第一时间看到红的是什么。
    const four = "\u{20000}\u{20001}\u{20002}\u{20003}";
    expect(four.length).toBe(8);
    expect([...four].length).toBe(4);
    expect(estTokens(four)).toBe(1);
    expect(estTokens("\u{1f600}\u{1f600}\u{1f600}\u{1f600}")).toBe(1);
    // golden 里对应的那两条必须给同样的数
    const g = G.est_tokens.find((r) => r.in === four)!;
    expect(g.cp_len).toBe(4);
    expect(g.out).toBe(1);
  });

  it("落单代理算一个码点（Python 的 str 也是）", () => {
    // Python 侧无法直接从 JSON 里带一个落单代理过来（json.dumps 会写成 \ud800，
    // 而那不是合法 JSON 文本的常见路径），所以这条是 TS 侧补的风险用例：
    // 落单高代理不能被当成半个字符吞掉，否则估算会随材料编码问题突然偏。
    expect(estTokens("\ud800")).toBe(1);
    expect(estTokens("\ud800\ud800\ud800\ud800")).toBe(1); // 4 码点 → max(1, 1)
    expect(estTokens("\udc00abc")).toBe(1);
  });
});

// ── MemoryItem ───────────────────────────────────────────────────

describe("MemoryItem.toDict", () => {
  it("与 Python 逐条一致", () => {
    for (const row of G.to_dict) {
      expect(build(row.init).toDict(), JSON.stringify(row.init)).toEqual(row.out);
    }
  });

  it("键的插入顺序与 Python 一致（落盘字节直接跟着它走）", () => {
    for (const row of G.to_dict) {
      expect(Object.keys(build(row.init).toDict())).toEqual(row.key_order);
    }
  });

  it("默认值一个不差", () => {
    // 第一条 golden 就是"只给四个必填字段"，它把每个默认值都摊开了。
    const row = G.to_dict[0]!;
    expect(row.out.confidence).toBe(0.5);
    expect(row.out.tier).toBe(MemoryTier.AUTHORITATIVE);
    expect(build(row.init).toDict()).toEqual(row.out);
  });

  it("confidence 走 ties-to-even，不是 toFixed", () => {
    const conf = (c: number): number => {
      const row = G.to_dict.find((r) => r.init.confidence === c)!;
      const got = build(row.init).toDict().confidence;
      expect(got).toBe(row.out.confidence);
      return got;
    };
    // 三个精确的二进制并列点。取偶的方向由前一位的奇偶决定，不是一律向下：
    //   0.0625 → 0.062（62 偶，toFixed 给 0.063）
    //   0.1875 → 0.188（188 偶，与 toFixed 恰好同值 —— 仍然要对，只是分不出两法）
    //   0.3125 → 0.312（312 偶，toFixed 给 0.313）
    expect(conf(0.0625)).not.toBe(Number((0.0625).toFixed(3)));
    expect(conf(0.1875)).toBe(0.188);
    expect(conf(0.3125)).not.toBe(Number((0.3125).toFixed(3)));
  });

  it("hit_runs 按码点排序，不是默认的码元排序", () => {
    const row = G.to_dict.find((r) => (r.init.hit_runs?.length ?? 0) > 3)!;
    const got = build(row.init).toDict().hit_runs;
    expect(got).toEqual(row.out.hit_runs);
    // 默认 sort 会把 U+10000/U+1F600 排到 U+FFFF 前面 —— 钉住这个分叉存在
    expect([...row.init.hit_runs!].sort()).not.toEqual(row.out.hit_runs);
  });

  it("tokens / contested 与 Python 一致", () => {
    for (const row of G.to_dict) {
      const it = build(row.init);
      expect(it.tokens).toBe(row.tokens);
      expect(it.contested).toBe(row.contested);
    }
  });

  it("构造时复制容器，调用方之后改自己的数组不会渗进来", () => {
    // Python 的 default_factory 只保证默认值是新的；这里一律复制（契约 §1）。
    const support = ["a"];
    const meta = { x: 1 };
    const it = new MemoryItem({
      key: "k",
      kind: MemoryKind.LESSON,
      scope: Scope.RUN,
      content: "c",
      support,
      meta,
      hitRuns: ["r1"],
    });
    support.push("b");
    meta.x = 2;
    expect(it.support).toEqual(["a"]);
    expect(it.meta).toEqual({ x: 1 });
    // 两条独立的记忆不共享默认容器
    const a = new MemoryItem({ key: "a", kind: MemoryKind.FACT, scope: Scope.RUN, content: "" });
    const b = new MemoryItem({ key: "b", kind: MemoryKind.FACT, scope: Scope.RUN, content: "" });
    a.support.push("x");
    a.hitRuns.add("r");
    expect(b.support).toEqual([]);
    expect(b.hitRuns.size).toBe(0);
  });

  it("字段可写（long_term 会就地改）", () => {
    const it = build(G.to_dict[0]!.init);
    it.scope = Scope.PROJECT;
    it.confidence = 0.95;
    it.hitRuns.add("r1");
    it.useCount += 1;
    it.contestedBy.push("k~superseded#0");
    expect(it.toDict()).toMatchObject({
      scope: "project",
      confidence: 0.95,
      hit_runs: ["r1"],
      use_count: 1,
      contested_by: ["k~superseded#0"],
    });
  });
});

describe("MemoryItem.fromDict", () => {
  it("与 Python 逐条一致（含缺 tier/origin_* 的老 mem.json）", () => {
    for (const row of G.from_dict) {
      expect(MemoryItem.fromDict(row.in).toDict(), JSON.stringify(row.in)).toEqual(row.out);
    }
  });

  it("老库没有 tier 时补权威档 —— 少这个默认值就是一读就崩", () => {
    const old = G.from_dict.find((r) => r.in["tier"] === undefined)!;
    expect(MemoryItem.fromDict(old.in).tier).toBe(MemoryTier.AUTHORITATIVE);
    expect(old.out.tier).toBe("authoritative");
  });

  it("toDict → fromDict 往返不变形", () => {
    for (const row of G.to_dict) {
      const once = build(row.init).toDict();
      // 走一遍真正的 JSON，逼出所有"只在内存里成立"的形状
      const back = MemoryItem.fromDict(JSON.parse(JSON.stringify(once)) as unknown);
      expect(back.toDict()).toEqual(once);
    }
  });

  it("必填字段缺失或类型不对一律抛", () => {
    const ok = { key: "k", kind: "lesson", scope: "run", content: "c" };
    expect(() => MemoryItem.fromDict(null)).toThrow();
    expect(() => MemoryItem.fromDict([])).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, key: undefined })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, content: 1 })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, kind: "nope" })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, scope: undefined })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, tier: "human" })).toThrow();
    // 比 Python 收紧的一档：那边不校验值类型，坏值会一路带到某处做算术时才炸
    expect(() => MemoryItem.fromDict({ ...ok, use_count: "3" })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, support: "s" })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, support: [1] })).toThrow();
    expect(() => MemoryItem.fromDict({ ...ok, meta: [] })).toThrow();
  });
});

describe("MemoryItem.render", () => {
  it("与 Python 逐条一致（含参考档标注的确切文案与顺序）", () => {
    for (const row of G.render) {
      expect(build(row.init).render(row.foreign_material), JSON.stringify(row.init)).toBe(row.out);
    }
  });

  it("参考档的标注挤在内容前面 —— 尾部截断也切不掉它", () => {
    // context 的 L3 会把这些行拼起来整体硬截断；标注写在末尾就会被切掉，
    // 只剩断言本身，模型看到的就是一条"事实"。
    const ref = G.render.find((r) => r.init.tier === "reference")!;
    const idx = ref.out.indexOf(ref.init.content);
    expect(ref.out.indexOf("参考")).toBeLessThan(idx);
    expect(ref.out.indexOf("未确认")).toBeLessThan(idx);
  });

  it("权威档不带任何来源标注", () => {
    for (const row of G.render) {
      if (row.init.tier !== "reference") expect(row.out).not.toContain("参考");
    }
  });
});

describe("MemoryItem.fromOtherMaterial", () => {
  it("与 Python 逐条一致", () => {
    for (const row of G.from_other_material) {
      const cur = row.current === null ? null : new Set(row.current);
      expect(build(row.init).fromOtherMaterial(cur), JSON.stringify(row)).toBe(row.out);
    }
  });

  it("undefined 与 null 等价（Python 那边就是同一件事）", () => {
    const it = build({
      key: "k",
      kind: "fact",
      scope: "run",
      content: "c",
      tier: "reference",
      origin_files: ["f1"],
    });
    expect(it.fromOtherMaterial(undefined)).toBe(false);
    expect(it.fromOtherMaterial(null)).toBe(false);
    expect(it.fromOtherMaterial(new Set(["f2"]))).toBe(true);
  });
});

describe("memKey", () => {
  it("与 Python 逐条一致", () => {
    for (const row of G.mem_key) {
      expect(memKey(parseMemoryKind(row.kind), row.subject), row.subject).toBe(row.out);
    }
  });

  it("subject 恰好是 \"x\" 时走 sha256 兜底，那条判断不是死代码", () => {
    const x = G.mem_key.find((r) => r.subject === "x")!;
    expect(x.out).not.toBe("fact:x");
    expect(memKey(MemoryKind.FACT, "x")).toBe(x.out);
    // 相邻的正常情况仍走 slug 分支
    expect(memKey(MemoryKind.CONVENTION, "xx")).toBe("convention:xx");
  });
});
