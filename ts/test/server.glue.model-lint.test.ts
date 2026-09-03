/**
 * `model.lint` —— 「模型里有什么断链」。
 *
 * `gaps.ts` 早就在挖这些洞，但只在流水线里跑一次、结果转成问题；FDE 在对话里
 * 问「现在模型有什么问题」时没有任何出口。这条工具补的是**出口**，不是新算法。
 *
 * 纪律：纯图检查、零模型。每一条 finding 指向的 rid 必然是 OIR 里已有的实体。
 * 尤其是**空 OIR 要说「还没抽过」而不是「没有问题」** —— 后者是把「查不到」
 * 伪装成「已确认健康」，是这个产品最不能犯的一类错。
 */

import { describe, expect, it } from "vitest";

import { join } from "node:path";
import { tmpdir } from "node:os";

process.env["ONTOCOPILOT_WORKSPACE"] = join(tmpdir(), `ontocopilot-lint-${process.pid}`);

const { OIR, makeObjectType, makePropertyType, makeLinkType, makeActionType, extracted, inferred, BaseType, Cardinality } =
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

type Lint = {
  total: number;
  findings: { kind: string; rid: string; name: string; why: string }[];
  counts: Record<string, number>;
  note: string;
  checked: string[];
};

describe("model.lint", () => {
  it("空 OIR 说「还没抽过」，**不说「没有问题」**", async () => {
    const reg = builtinRegistry({ oir: new OIR() });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    expect(out.total).toBe(0);
    expect(out.note).toContain("还没抽过");
    expect(out.note).not.toContain("没有问题");
  });

  it("孤儿对象：谁都不连它 —— 报出来", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_x", apiName: extracted("Orphan"), displayName: extracted("孤儿对象") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    const orphan = out.findings.find((f) => f.kind === "orphan_object");
    expect(orphan?.rid).toBe("ot_x");
    expect(orphan?.name).toBe("孤儿对象");
  });

  it("断链关系：两端指向不存在的对象 —— 这是**真的坏**，不只是不完整", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_a", apiName: extracted("A"), displayName: extracted("甲") }));
    oir.addLink(
      makeLinkType({
        rid: "lt_1", apiName: extracted("aToGhost"),
        source: "ot_a", target: "ot_ghost", cardinality: extracted(Cardinality.ONE_TO_MANY),
      }),
    );
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    const broken = out.findings.find((f) => f.kind === "broken_link");
    expect(broken?.rid).toBe("lt_1");
    expect(broken?.why).toContain("ot_ghost");
  });

  it("无宿主属性：parent 指向不存在的对象", async () => {
    const oir = new OIR();
    oir.addProperty(
      makePropertyType({
        rid: "pt_1", parent: "ot_nope",
        apiName: extracted("amount"), displayName: extracted("金额"),
        baseType: extracted(BaseType.DECIMAL),
      }),
    );
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    expect(out.findings.map((f) => f.kind)).toContain("orphan_property");
  });

  it("行动挂在不存在的对象上", async () => {
    const oir = new OIR();
    oir.addAction(makeActionType({ rid: "at_1", apiName: extracted("approve"), appliesTo: ["ot_missing"] }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    const f = out.findings.find((x) => x.kind === "action_no_host");
    expect(f?.rid).toBe("at_1");
    expect(f?.why).toContain("ot_missing");
  });

  it("按 kind 过滤；counts 给全量分布，findings 给过滤后的", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_x", apiName: extracted("Orphan"), displayName: extracted("孤儿") }));
    oir.addAction(makeActionType({ rid: "at_1", apiName: extracted("approve"), appliesTo: ["ot_missing"] }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", { kind: "action_no_host" }, CTX)) as Lint;
    expect(out.findings.every((f) => f.kind === "action_no_host")).toBe(true);
    // counts 是**全量**分布 —— 过滤视图不能让人以为别的病灶不存在
    expect(out.counts["orphan_object"]).toBe(1);
  });

  it("**说清楚查了哪几项** —— 没报的病灶要能区分「查过没有」和「根本没查」", async () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({ rid: "ot_a", apiName: extracted("A"), displayName: extracted("甲") }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint;
    expect(out.checked).toContain("orphan_object");
    expect(out.checked).toContain("broken_link");
    expect(out.checked).toContain("object_no_primary_key");
  });
});

// ══════════════════════════════════════════════════════════════════
//  系统性缺失 vs 个体病灶
//
//  这一组来自**真实数据**：workspace 里最大的那份 OIR 有 175 个对象、
//  0 条关系、0 个属性。初版实现在它上面报出 515 条 findings，其中
//  175 条「孤儿对象」+ 175 条「没有主键」是**同一个系统性事实被说了 350 遍**；
//  再截断到前 80 条之后，模型看到的全是 orphan_object，既看不到别的病灶，
//  也永远不知道「关系层是零」。
//
//  合成 fixture 抓不到这个 —— 它只有两三个实体，比例失真看不出来。
// ══════════════════════════════════════════════════════════════════

/** n 个对象，零关系、零属性 —— 真实 OIR 的形状。 */
function bigOirNoLinks(n: number) {
  const oir = new OIR();
  for (let i = 0; i < n; i += 1) {
    oir.addObject(
      makeObjectType({
        rid: `ot_${i}`,
        apiName: extracted(`Obj${i}`),
        displayName: extracted(`对象${i}`),
        description: extracted(`第 ${i} 个对象的说明`),
        primaryKey: extracted([`k${i}`]),
      }),
    );
  }
  return oir;
}

describe("model.lint：系统性缺失不能报成个体病灶", () => {
  it("整份模型零关系时，报**一条**系统性结论，而不是 N 条孤儿", async () => {
    const reg = builtinRegistry({ oir: bigOirNoLinks(175) });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint & {
      systemic: { kind: string; count: number; why: string }[];
    };
    const sys = out.systemic.find((x) => x.kind === "no_links_at_all");
    expect(sys).toBeDefined();
    expect(sys!.count).toBe(175);
    // 175 条孤儿**不该**再逐条出现 —— 那是同一件事说 175 遍
    expect(out.findings.filter((f) => f.kind === "orphan_object")).toHaveLength(0);
  });

  it("少数孤儿仍然逐条报 —— 3/175 是信号，不是系统性缺失", async () => {
    const oir = bigOirNoLinks(175);
    // 给 172 个对象两两连上，剩 3 个真孤儿
    for (let i = 0; i < 172; i += 2) {
      oir.addLink(
        makeLinkType({
          rid: `lt_${i}`, apiName: extracted(`l${i}`),
          source: `ot_${i}`, target: `ot_${i + 1}`,
          cardinality: extracted(Cardinality.ONE_TO_MANY),
        }),
      );
    }
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint & { systemic: unknown[] };
    expect(out.findings.filter((f) => f.kind === "orphan_object")).toHaveLength(3);
    expect(out.systemic).toHaveLength(0);
  });

  it("某一类命中率接近全体时收敛成系统性结论，并**带几个例子**", async () => {
    const oir = new OIR();
    for (let i = 0; i < 40; i += 1) {
      // 全都没有主键、没有描述
      oir.addObject(makeObjectType({ rid: `ot_${i}`, apiName: extracted(`O${i}`), displayName: extracted(`对象${i}`) }));
      oir.addLink(makeLinkType({
        rid: `lt_${i}`, apiName: extracted(`l${i}`),
        source: `ot_${i}`, target: `ot_${(i + 1) % 40}`,
        cardinality: extracted(Cardinality.ONE_TO_MANY),
      }));
    }
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint & {
      systemic: { kind: string; count: number; examples: string[] }[];
    };
    const pk = out.systemic.find((x) => x.kind === "object_no_primary_key");
    expect(pk?.count).toBe(40);
    expect(pk!.examples.length).toBeGreaterThan(0);
    expect(pk!.examples.length).toBeLessThanOrEqual(3);
  });

  it("**截断要分层** —— 不能让前一类占满名额把后面的类挤没", async () => {
    const oir = new OIR();
    // 100 个断链关系 + 2 个挂空的行动。断链在迭代顺序上排前面。
    for (let i = 0; i < 100; i += 1) {
      oir.addObject(makeObjectType({
        rid: `ot_${i}`, apiName: extracted(`O${i}`), displayName: extracted(`对象${i}`),
        description: extracted("有说明"), primaryKey: extracted(["k"]),
      }));
      oir.addLink(makeLinkType({
        rid: `lt_${i}`, apiName: extracted(`l${i}`),
        source: `ot_${i}`, target: "ot_ghost",
        cardinality: extracted(Cardinality.ONE_TO_MANY),
      }));
    }
    oir.addAction(makeActionType({ rid: "at_1", apiName: extracted("a1"), appliesTo: ["ot_missing"] }));
    oir.addAction(makeActionType({ rid: "at_2", apiName: extracted("a2"), appliesTo: ["ot_missing"] }));
    const reg = builtinRegistry({ oir });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint & { systemic: unknown[] };
    const kinds = new Set(out.findings.map((f) => f.kind));
    // action_no_host 只有 2 条，但**必须**露面
    expect(kinds).toContain("action_no_host");
  });

  it("系统性结论**不**吃掉总数 —— 全量仍然数得出来", async () => {
    const reg = builtinRegistry({ oir: bigOirNoLinks(175) });
    const out = (await reg.call("model.lint", {}, CTX)) as Lint & { systemic: unknown[] };
    expect(out.counts["orphan_object"]).toBe(175);
    expect(out.total).toBeGreaterThanOrEqual(175);
  });

  it("**显式按 kind 筛时，收敛不该挡路** —— 他明确要看孤儿就给他孤儿", async () => {
    const reg = builtinRegistry({ oir: bigOirNoLinks(175) });
    const out = (await reg.call("model.lint", { kind: "orphan_object" }, CTX)) as Lint & {
      systemic: unknown[];
    };
    // 默认视图里这一类被收敛成一条；但他点名要，就要拿到逐条
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.every((f) => f.kind === "orphan_object")).toBe(true);
    // 收敛结论仍然给 —— 它解释了「为什么有这么多」
    expect(out.systemic.length).toBeGreaterThan(0);
  });
});
