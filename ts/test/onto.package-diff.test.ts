/**
 * 两份 OntologyPackage 之间的语义 diff。
 *
 * 这是 `revision.diff` 的计算核心。地基是 `snapshotHash`：答复路径现在把回写后的
 * canonical package 内容寻址存进 blob，两个 revision 之间才有可比的内容。
 *
 * 四条纪律，全部来自这一轮真实数据踩出来的坑：
 *
 *  · **「没有快照」不是「没有变化」** —— 接线之前的老 revision 哈希是空串，
 *    把它渲染成「无改动」是把「不知道」说成「已确认一致」；
 *  · **真实规模**：一个包有 175 个对象，diff 可能上千条。截断要分层、总数要全量；
 *  · **长文本**不吐原文，给「差在哪几个字」；
 *  · **系统性变更要收敛** —— 一次重建会让每个 id 都变，那不是 175 处改动，
 *    是一次重建。
 *
 * 输出形状刻意对齐前端已有的 `{rid, field, before, after}`（returncard.tsx 读
 * `a.diff || a.diffs || a.changes`），这样渲染层零改动。
 */

import { describe, expect, it } from "vitest";

import { diffOntologyPackages } from "../src/onto/package_diff.js";

/** 一份最小但形状正确的包。 */
function pkg(over: Record<string, unknown> = {}) {
  return {
    $schema: "https://schemas.ontocopilot.dev/ontology-package/1/schema.json",
    schemaVersion: "ontocopilot.ontology-package/1",
    packageId: "pkg.s1",
    revision: 1,
    baseRevision: null,
    generatedAt: "2026-08-18T00:00:00Z",
    dataObjects: [],
    links: [],
    actions: [],
    events: [],
    processNodes: [],
    processEdges: [],
    workflows: [],
    rules: [],
    integrations: [],
    ...over,
  };
}

const DO = (id: string, over: Record<string, unknown> = {}) => ({
  id, apiName: id.replace("do.", ""), displayName: "对象", description: "", primaryKey: [], ...over,
});

describe("diffOntologyPackages", () => {
  it("新增：只在 b 里的算 added", () => {
    const d = diffOntologyPackages(pkg(), pkg({ dataObjects: [DO("do.po")] }));
    expect(d.collections["dataObjects"]!.added).toEqual(["do.po"]);
    expect(d.collections["dataObjects"]!.removed).toEqual([]);
  });

  it("删除：只在 a 里的算 removed", () => {
    const d = diffOntologyPackages(pkg({ dataObjects: [DO("do.po")] }), pkg());
    expect(d.collections["dataObjects"]!.removed).toEqual(["do.po"]);
  });

  it("字段级改动给 **{rid, field, before, after}** —— 对齐前端已有渲染契约", () => {
    const d = diffOntologyPackages(
      pkg({ dataObjects: [DO("do.po", { displayName: "采购订单" })] }),
      pkg({ dataObjects: [DO("do.po", { displayName: "采购单" })] }),
    );
    expect(d.changes).toContainEqual({
      rid: "do.po", field: "displayName", before: "采购订单", after: "采购单",
    });
  });

  it("完全一样时**明确说没有变化**，且 total 为 0", () => {
    const p = pkg({ dataObjects: [DO("do.po")] });
    const d = diffOntologyPackages(p, p);
    expect(d.total).toBe(0);
    expect(d.identical).toBe(true);
  });

  it("总数是**全量**，即使 changes 被截断", () => {
    const many = (n: number, dn: string) =>
      Array.from({ length: n }, (_, i) => DO(`do.o${i}`, { displayName: dn }));
    const d = diffOntologyPackages(pkg({ dataObjects: many(300, "旧") }), pkg({ dataObjects: many(300, "新") }));
    expect(d.total).toBe(300);
    expect(d.changes.length).toBeLessThan(300);
  });

  it("**截断分层** —— 多个集合都变时，每个集合都要露面", () => {
    const d = diffOntologyPackages(
      pkg({
        dataObjects: Array.from({ length: 200 }, (_, i) => DO(`do.o${i}`, { displayName: "旧" })),
        rules: [{ id: "rule.r1", statement: "旧规则" }],
      }),
      pkg({
        dataObjects: Array.from({ length: 200 }, (_, i) => DO(`do.o${i}`, { displayName: "新" })),
        rules: [{ id: "rule.r1", statement: "新规则" }],
      }),
    );
    expect(d.changes.some((c) => c.rid === "rule.r1")).toBe(true);
  });

  it("长文本截断并给「差在哪几个字」", () => {
    const long = (t: string) => t + "填充说明".repeat(60);
    const d = diffOntologyPackages(
      pkg({ dataObjects: [DO("do.po", { description: long("甲") })] }),
      pkg({ dataObjects: [DO("do.po", { description: long("乙") })] }),
    );
    const c = d.changes.find((x) => x.field === "description")!;
    expect(String(c.before).length).toBeLessThanOrEqual(140);
    expect(c.差在).toBeDefined();
  });

  it("**一次重建要收敛** —— 每个 id 都换了不是 N 处改动", () => {
    const a = pkg({ dataObjects: Array.from({ length: 50 }, (_, i) => DO(`do.old${i}`)) });
    const b = pkg({ dataObjects: Array.from({ length: 50 }, (_, i) => DO(`do.new${i}`)) });
    const d = diffOntologyPackages(a, b);
    expect(d.systemic.some((s) => s.kind === "wholesale_replacement")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  部分比较**不许**断言「完全一致」
//
//  初版把参与比较的集合写死成 9 个，而包有 14 个 —— 漏掉了 roles、systems、
//  evidence，以及 **questions 和 gaps**。后两个恰恰是每次回答都会变的东西。
//
//  于是这个专为「回答之后改了什么」而造的工具，在最常见的场景下会说
//  「两版内容完全一致」。**从部分比较里断言全等**，是这个产品最不能犯的错。
//
//  修法不是「把清单补全」—— 那还会跟着类型漂移。是**从数据推导**：
//  比对两份包里所有数组字段，硬编码的只有顺序偏好。
// ══════════════════════════════════════════════════════════════════

describe("覆盖面不能靠硬编码清单", () => {
  it("**questions 变了必须报** —— 每次回答都会动它", () => {
    const d = diffOntologyPackages(
      pkg({ questions: [{ id: "q.1", text: "主键用哪个字段", status: "open" }] }),
      pkg({ questions: [{ id: "q.1", text: "主键用哪个字段", status: "answered" }] }),
    );
    expect(d.identical).toBe(false);
    expect(d.changes).toContainEqual({ rid: "q.1", field: "status", before: "open", after: "answered" });
  });

  it("**gaps 变了必须报**", () => {
    const d = diffOntologyPackages(
      pkg({ gaps: [{ id: "gap.1", kind: "missing_pk", resolved: false }] }),
      pkg({ gaps: [{ id: "gap.1", kind: "missing_pk", resolved: true }] }),
    );
    expect(d.identical).toBe(false);
  });

  it("roles / systems / evidence 也在覆盖面内", () => {
    for (const key of ["roles", "systems", "evidence"]) {
      const d = diffOntologyPackages(
        pkg({ [key]: [{ id: `${key}.1`, name: "旧" }] }),
        pkg({ [key]: [{ id: `${key}.1`, name: "新" }] }),
      );
      expect(d.identical, `${key} 没被比较`).toBe(false);
    }
  });

  it("**将来新增的集合自动纳入** —— 清单不会跟着类型漂移", () => {
    const d = diffOntologyPackages(
      pkg({ brandNewThings: [{ id: "x.1", v: 1 }] } as never),
      pkg({ brandNewThings: [{ id: "x.1", v: 2 }] } as never),
    );
    expect(d.identical).toBe(false);
  });

  it("说得出**比了哪些集合** —— 「没报」要能区分「比过没变」和「根本没比」", () => {
    const d = diffOntologyPackages(pkg({ rules: [{ id: "r.1" }] }), pkg({ rules: [{ id: "r.1" }] }));
    expect(d.compared).toContain("rules");
  });

  it("嵌套数组按 id 下钻 —— 改一个属性不该把整个 attributes 前后都吐出来", () => {
    const withAttrs = (v: string) =>
      pkg({
        dataObjects: [
          {
            ...DO("do.po"),
            attributes: [
              { id: "attr.a", displayName: "金额", baseType: v },
              { id: "attr.b", displayName: "编号", baseType: "STRING" },
            ],
          },
        ],
      });
    const d = diffOntologyPackages(withAttrs("STRING"), withAttrs("DECIMAL"));
    expect(d.changes).toContainEqual({
      rid: "do.po/attr.a", field: "baseType", before: "STRING", after: "DECIMAL",
    });
    // 没动的那条不该出现
    expect(d.changes.some((c) => c.rid.includes("attr.b"))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  重复 id：静默覆盖 → 改动消失 + 计数偏低
//
//  `canonicalId` 会剥掉若干 legacy 前缀，于是不同的 OIR rid 会塌成同一个包内
//  id（`br_x` 与 `rule_x` 都 → `rule.x`；`at_x` 与 `x` 都 → `act.x`）。
//  初版 byId 用 `m.set(id, row)`，后者覆盖前者：被覆盖那条的改动**完全消失**，
//  而 aCount/bCount 报的是 Map.size，比真实行数少。
//
//  两版都只剩最后一条、又恰好相同时，工具会宣布「两版内容完全一致 —— 这是
//  比较过的结论」。**又是从部分比较里断言全等。**
// ══════════════════════════════════════════════════════════════════

describe("重复 id", () => {
  const dup = (name: string) =>
    pkg({
      actions: [
        { id: "act.x", legacyId: "at_a", name },
        { id: "act.x", legacyId: "at_b", name: "另一条" },
        { id: "act.y", legacyId: "at_c", name: "无关" },
      ],
    });

  it("**不许静默吞掉** —— 重复 id 要报出来", () => {
    const d = diffOntologyPackages(dup("旧"), dup("新"));
    expect(d.systemic.some((s) => s.kind === "duplicate_id")).toBe(true);
  });

  it("计数按**真实行数**，不是去重后的 Map.size", () => {
    const d = diffOntologyPackages(dup("旧"), dup("新"));
    expect(d.collections["actions"]!.aCount).toBe(3);
  });

  it("**绝不因为重复就宣布一致** —— 那是从部分比较里断言全等", () => {
    const d = diffOntologyPackages(dup("旧"), dup("新"));
    expect(d.identical).toBe(false);
  });

  it("没有重复时不报噪音", () => {
    const d = diffOntologyPackages(
      pkg({ actions: [{ id: "act.x", name: "甲" }] }),
      pkg({ actions: [{ id: "act.x", name: "乙" }] }),
    );
    expect(d.systemic.some((s) => s.kind === "duplicate_id")).toBe(false);
  });
});
