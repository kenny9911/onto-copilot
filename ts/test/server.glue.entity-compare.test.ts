/**
 * `entity.compare` —— 「这两个是不是一回事」。
 *
 * FDE 一天问最多的判断题。今天的替代方案是让模型 `evidence.search` 捞几段原文
 * 自己目测，而口径差异恰恰是**看原文看不出来**的那一类（两段话都在说「金额」）。
 *
 * 断言重点有两条纪律：
 * - **零模型**：返回的每个字段值都必须来自 OIR 里已有的实体，不存在编造；
 * - **不替人决定**：合并不可逆，工具只能报差异和信号，不能给「就是同一个」的结论。
 */

import { describe, expect, it } from "vitest";

import { join } from "node:path";
import { tmpdir } from "node:os";

process.env["ONTOCOPILOT_WORKSPACE"] = join(tmpdir(), `ontocopilot-ecmp-${process.pid}`);

const { OIR, makeObjectType, makePropertyType, makeProvenance, extracted, inferred, BaseType } =
  await import("../src/onto/oir.js");
const { builtinRegistry: rawBuiltinRegistry } = await import("../src/server/glue/tools.js");

import type { ToolCallCtx } from "../src/kernel/tools.js";

const CTX = { turnId: "t1" } as unknown as ToolCallCtx;

function builtinRegistry(opts: Parameters<typeof rawBuiltinRegistry>[0]) {
  const registry = rawBuiltinRegistry(opts);
  return {
    call(name: string, args: Record<string, unknown>, ctx: ToolCallCtx) {
      return registry.call(name, args, ctx, { scope: "readonly" });
    },
  };
}

function prov(file: string, snippet: string) {
  return makeProvenance(file, file, { kind: "para" }, { snippet, extractor: "llm", confidence: 0.9 });
}

/** 两个「计划金额」：类型相同、口径不同 —— 真实项目里最贵的那种同名不同义。 */
function oirWithTwoAmounts() {
  const oir = new OIR();
  oir.addObject(makeObjectType({ rid: "ot_po", apiName: extracted("PurchaseOrder"), displayName: extracted("采购订单") }));
  oir.addObject(makeObjectType({ rid: "ot_ct", apiName: extracted("Contract"), displayName: extracted("合同") }));
  oir.addProperty(
    makePropertyType({
      rid: "pt_a", parent: "ot_po",
      apiName: extracted("planAmount"), displayName: extracted("计划金额"),
      baseType: extracted(BaseType.DECIMAL),
      definition: extracted("含税，按下单日汇率折人民币", prov("采购制度.docx", "含税，按下单日汇率")),
      unit: extracted("CNY"),
    }),
  );
  oir.addProperty(
    makePropertyType({
      rid: "pt_b", parent: "ot_ct",
      apiName: extracted("planAmount"), displayName: extracted("计划金额"),
      baseType: extracted(BaseType.DECIMAL),
      definition: extracted("不含税，按合同签署日汇率折人民币", prov("合同管理办法.pdf", "不含税，按签署日汇率")),
      unit: extracted("CNY"),
    }),
  );
  return oir;
}

describe("entity.compare", () => {
  it("认不出目标时说清楚，并提示别猜 rid（与 impact.trace 同一纪律）", async () => {
    const reg = builtinRegistry({ oir: new OIR() });
    const out = (await reg.call("entity.compare", { a: "根本没有这个", b: "也没有" }, CTX)) as {
      error: string; note: string;
    };
    expect(out.error).toContain("根本没有这个");
    expect(out.note).toContain("别照着材料里的写法猜 rid");
  });

  it("同名不同口径的两个属性：把 definition 差异报成差异项，而不是只说「都叫计划金额」", async () => {
    const reg = builtinRegistry({ oir: oirWithTwoAmounts() });
    const out = (await reg.call("entity.compare", { a: "pt_a", b: "pt_b" }, CTX)) as {
      differences: { field: string; a: unknown; b: unknown }[];
      same: string[];
    };
    const fields = out.differences.map((d) => d.field);
    expect(fields).toContain("definition");
    // 类型和单位真的一样 —— 一样的不该混进差异里制造噪声
    expect(out.same).toContain("baseType");
    expect(out.same).toContain("unit");
  });

  it("差异项带双方出处 —— 「凭什么说它们不同」必须能点回原文", async () => {
    const reg = builtinRegistry({ oir: oirWithTwoAmounts() });
    const out = (await reg.call("entity.compare", { a: "pt_a", b: "pt_b" }, CTX)) as {
      evidence: { side: string; file: string; snippet: string }[];
    };
    const files = out.evidence.map((e) => e.file);
    expect(files).toContain("采购制度.docx");
    expect(files).toContain("合同管理办法.pdf");
  });

  it("**不替人决定**：即使两边完全一致，也只给信号不给「就是同一个」的结论", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_1", apiName: extracted("Customer"), displayName: extracted("客户") }));
    oir.addObject(makeObjectType({ rid: "ot_2", apiName: extracted("Customer"), displayName: extracted("客户") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_1", b: "ot_2" }, CTX)) as {
      signal: string; note: string; differences: unknown[];
    };
    expect(out.differences).toHaveLength(0);
    // 合并不可逆 —— 工具的出口是「值得问一句」，不是「替他合了」
    expect(out.note).toContain("合并不可逆");
    expect(out.signal).toBe("high_similarity");
  });

  it("类型不同（对象 vs 属性）时明说不可比，不硬凑字段", async () => {
    const reg = builtinRegistry({ oir: oirWithTwoAmounts() });
    const out = (await reg.call("entity.compare", { a: "ot_po", b: "pt_a" }, CTX)) as {
      comparable: boolean; note: string;
    };
    expect(out.comparable).toBe(false);
    expect(out.note).toContain("不是同一类");
  });

  it("对象对比会列出各自独有的属性 —— 粒度差异靠属性集合才看得出来", async () => {
    const oir = oirWithTwoAmounts();
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_po", b: "ot_ct" }, CTX)) as {
      only_in_a: string[]; only_in_b: string[]; shared_properties: string[];
    };
    // 两边各有一个同名 apiName 的属性 → 共有；没有独有的
    expect(out.shared_properties).toContain("planAmount");
    expect(out.only_in_a).toEqual([]);
    expect(out.only_in_b).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  真实数据打脸出来的两条
//
//  workspace 里那份 175 对象的 OIR，有 **4 对显示名完全相同、只有 apiName
//  不同**的对象（供应商价格协议分配信息 ×2、项目团队成员信息 ×2、
//  采购订单 ×2、采购合同 ×2）。它们是全模型最该合并的候选，初版实现却给了
//  和「真的不同」一样的 `differs` 信号 —— 读起来像「这俩不一样」，正好反了。
//
//  第二条：description 差异直接吐出几百字原文（抽取理由，不是业务定义）。
//  一次对比就能把上下文撑爆，而 FDE 要的是「差在哪」不是两堵墙。
//  仓库里 `undescribedDiff` 就是干这个的，复用它。
// ══════════════════════════════════════════════════════════════════

describe("entity.compare：真实数据", () => {
  it("**显示名相同、只有 apiName 不同 → naming_variance**，不是泛泛的 differs", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_contract", apiName: extracted("contract"), displayName: extracted("采购合同") }));
    oir.addObject(makeObjectType({ rid: "ot_clmcontract", apiName: extracted("clmContract"), displayName: extracted("采购合同") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_contract", b: "ot_clmcontract" }, CTX)) as {
      signal: string; note: string;
    };
    expect(out.signal).toBe("naming_variance");
    // 仍然不替人决定
    expect(out.note).toContain("合并不可逆");
  });

  it("口径冲突**压过** naming_variance —— 同名但口径不同时绝不能读成「只是编码不一样」", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_a", apiName: extracted("amtA"), displayName: extracted("金额") }));
    oir.addObject(makeObjectType({ rid: "ot_b", apiName: extracted("amtB"), displayName: extracted("金额") }));
    oir.addProperty(makePropertyType({
      rid: "pt_a", parent: "ot_a", apiName: extracted("v"), displayName: extracted("值"),
      baseType: extracted(BaseType.DECIMAL), definition: extracted("含税"), unit: extracted("CNY"),
    }));
    oir.addProperty(makePropertyType({
      rid: "pt_b", parent: "ot_b", apiName: extracted("v"), displayName: extracted("值"),
      baseType: extracted(BaseType.DECIMAL), definition: extracted("不含税"), unit: extracted("USD"),
    }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "pt_a", b: "pt_b" }, CTX)) as { signal: string };
    expect(out.signal).toBe("caliber_conflict");
  });

  it("**长文本不吐原文** —— 截断，并给「差在哪几个字」", async () => {
    const long = (tag: string) => `${tag}：` + "这是一段很长的抽取理由".repeat(30);
    const oir = new OIR();
    oir.addObject(makeObjectType({
      rid: "ot_1", apiName: extracted("a"), displayName: extracted("甲"),
      description: extracted(long("甲方口径")),
    }));
    oir.addObject(makeObjectType({
      rid: "ot_2", apiName: extracted("b"), displayName: extracted("乙"),
      description: extracted(long("乙方口径")),
    }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_1", b: "ot_2" }, CTX)) as {
      differences: { field: string; a: unknown; b: unknown; 差在?: string[] }[];
    };
    const d = out.differences.find((x) => x.field === "description")!;
    expect(String(d.a).length).toBeLessThanOrEqual(140);
    expect(d.差在).toBeDefined();
    expect(d.差在!.join("")).toContain("甲");
  });

  it("短文本照原样给 —— 截断只该发生在真的很长的时候", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_1", apiName: extracted("a"), displayName: extracted("甲"), description: extracted("很短") }));
    oir.addObject(makeObjectType({ rid: "ot_2", apiName: extracted("b"), displayName: extracted("乙"), description: extracted("也很短") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_1", b: "ot_2" }, CTX)) as {
      differences: { field: string; a: unknown }[];
    };
    expect(out.differences.find((x) => x.field === "description")!.a).toBe("很短");
  });

  it("一边有一边空时**不算「差在哪几个字」** —— 那会把整段原文当片段吐出来", async () => {
    const long = "这是一段很长的抽取理由".repeat(30);
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_1", apiName: extracted("a"), displayName: extracted("甲"), description: extracted(long) }));
    oir.addObject(makeObjectType({ rid: "ot_2", apiName: extracted("b"), displayName: extracted("乙"), description: extracted("") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_1", b: "ot_2" }, CTX)) as {
      differences: { field: string; 差在?: string[]; 单边?: string }[];
    };
    const d = out.differences.find((x) => x.field === "description")!;
    expect(d.差在).toBeUndefined();
    expect(d.单边).toBe("a");
  });

  it("片段本身也要封顶 —— 六个片段各几百字仍然是一堵墙", async () => {
    // 两段**完全不共享字符**的长文本：opcodes 会给出整段级别的大片段，
    // 正好是没有封顶时最糟的形态。
    const mk = (x: string) => x.repeat(400);
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_1", apiName: extracted("a"), displayName: extracted("甲"), description: extracted(mk("甲乙丙丁")) }));
    oir.addObject(makeObjectType({ rid: "ot_2", apiName: extracted("b"), displayName: extracted("乙"), description: extracted(mk("戊己庚辛")) }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("entity.compare", { a: "ot_1", b: "ot_2" }, CTX)) as {
      differences: { field: string; 差在?: string[] }[];
    };
    const frags = out.differences.find((x) => x.field === "description")!.差在!;
    for (const f of frags) expect(f.length).toBeLessThanOrEqual(60);
  });
});
