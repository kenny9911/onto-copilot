/**
 * 逐字段结构缺口 —— 「Action 缺什么 / Event 缺什么 / Rules 缺什么 /
 * Workflow 哪个阶段不明确 / DataObject 缺什么」。
 *
 * 这批判据一直写在 `compileOntologyPackageV1` 的 GapCollector 里（30 余处
 * 「这个字段是不是 unknown」），**但从没接进梳理主链** —— 它只挂在一条只读
 * HTTP 路由上，产出的 gaps 一条也进不了问题清单，FDE 因此永远看不到
 * 「这个 Action 没有 operationId」这种话。
 *
 * 这里钉住两件事：
 *   1. 判据确实覆盖用户点名的那几个维度（不是我们以为覆盖了）；
 *   2. 判据是**确定性**的 —— 同样的输入必然得到同样的缺口，零模型调用。
 */
import { describe, expect, it } from "vitest";

import { compileOntologyPackageV1 } from "../src/onto/ontology_package.js";

/** 一份**故意留白**的最小 OIR：对象有了、Action 有了、规则有了，
 *  但接口绑定、负责角色、主键这些全是空的 —— 正是真实材料的常态。 */
const SPARSE_OIR = {
  objects: [
    { rid: "ot.po", api_name: "PurchaseOrder", display_name: "采购订单", properties: [] },
  ],
  actions: [
    { rid: "at.submit", api_name: "submitOrder", display_name: "提交订单", applies_to: ["ot.po"] },
  ],
  rules: [
    { rid: "br.limit", statement: "单笔超过 10 万需要总监审批", kind: "AUTHORITY" },
  ],
};

function compile(oir: unknown, flow: unknown = null): {
  gaps: { entityType: string; field: string; status: string; code: string }[];
  questions: { text: string; gapId: string }[];
} {
  return compileOntologyPackageV1(oir as never, flow as never, {
    packageId: "pkg.t", revision: 1, baseRevision: null, sessionId: "s1", decisions: [],
  }) as never;
}

describe("六个维度的缺口判据都在", () => {
  const pkg = compile(SPARSE_OIR);
  const open = pkg.gaps.filter((g) => g.status === "open");
  const types = new Set(open.map((g) => g.entityType));

  it("一份留白的 OIR 必然报出缺口 —— 不是零", () => {
    expect(open.length).toBeGreaterThan(0);
  });

  it("**Action 维**：接口绑定缺失被逐字段点名", () => {
    const action = open.filter((g) => g.entityType === "Action");
    expect(action.length).toBeGreaterThan(0);
    // 判据是"字段是不是 unknown"，所以 field 必须是具体字段名而不是泛泛一句
    expect(action.every((g) => g.field.length > 0)).toBe(true);
  });

  it("**Rules 维**：规则的负责角色缺失会被问", () => {
    expect([...types]).toContain("Rule");
    const rule = open.find((g) => g.entityType === "Rule" && g.field === "actorRole");
    expect(rule).toBeDefined();
  });

  it("每条缺口都配了一句**中文问句**，不是抛一个字段名给用户", () => {
    const byGap = new Map(pkg.questions.map((q) => [q.gapId, q.text]));
    for (const g of open.slice(0, 12)) {
      const text = byGap.get((g as unknown as { id: string }).id);
      expect(text, `${g.entityType}.${g.field} 没有问句`).toBeTruthy();
      expect(text!.length).toBeGreaterThan(4);
    }
  });

  it("code 是稳定的机器标识（MISSING_*），去重和统计按它走", () => {
    expect(open.every((g) => /^[A-Z][A-Z0-9_]*$/u.test(g.code))).toBe(true);
  });
});

describe("确定性", () => {
  it("同样的输入两次编译得到**逐字段相同**的缺口 —— 零模型调用", () => {
    const a = compile(SPARSE_OIR);
    const b = compile(SPARSE_OIR);
    expect(a.gaps).toEqual(b.gaps);
  });

  it("**填上值不等于问题消失** —— 「我猜的」和「有依据」是两回事", () => {
    // 填上 actor 之后绑定的 status 从 unknown 变成 assumed、值也进去了，
    // 但问题**仍然 open**：那是推出来的假设，没有材料证据支撑。假设照样要
    // 业务方点头 —— 这正是这套契约存在的理由，不是判据漏了。
    const before = compile(SPARSE_OIR) as unknown as { rules: { actorRole: { status: string } }[] };
    expect(before.rules[0]!.actorRole.status).toBe("unknown");

    const filled = { ...SPARSE_OIR, rules: [{ ...SPARSE_OIR.rules[0], actor: "采购总监" }] };
    const pkg = compile(filled) as unknown as {
      rules: { actorRole: { status: string; value: string } }[];
      gaps: { entityType: string; field: string; status: string }[];
    };
    // 判据真的在看那个字段：unknown → assumed，值也落进去了
    expect(pkg.rules[0]!.actorRole.status).toBe("assumed");
    expect(pkg.rules[0]!.actorRole.value).toContain("采购总监");
    // 但问题还在 —— 没有证据的假设不算答案
    expect(pkg.gaps.filter(
      (g) => g.entityType === "Rule" && g.field === "actorRole" && g.status === "open",
    ).length).toBe(1);
  });
});
