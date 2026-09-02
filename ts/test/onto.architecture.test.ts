/**
 * 4A 架构投影：业务 / 应用 / 数据 / 技术。
 *
 * 用户要求 OntoCopilot「具备 ERP 四个架构的分析和结合」。落法是**投影而不是新标签**：
 * 层归属由「这条记录落在哪个桶」确定性推出，不给实体加 layer 字段 —— 那会让同一个
 * 事实有两个真相源。零模型调用、零 schema 变更。
 *
 * 真库先验（决定了这个模块必须诚实到什么程度）：
 *  · A1 有实料：flow 节点 31–64、阶段若干；
 *  · A2 **表面全空**（三个会话的 sourceEndpoint 都是 0/N），但内容躲在对象描述的
 *    散文里 —— fc58b72e91bd 有 311 个对象的描述提到 SAP/接口/集成，
 *    客户甚至交了《采购领域应用架构清单》。所以 A2 要报的不是「没有」，
 *    而是「有料但没有容器」，并说清下一步；
 *  · A3 有实料：对象 32–926；
 *  · A4 真的空（客户材料里没有基础设施），要**显式判空**，不许留白让人误以为在建。
 */

import { describe, expect, it } from "vitest";

import { FlowGraph } from "../src/onto/flow.js";
import { OIR, extracted, makeActionType, makeObjectType, makeProvenance, makeRid } from "../src/onto/oir.js";
import { applyFlowEdit } from "../src/onto/flow_edit.js";
import { projectFourA } from "../src/onto/architecture.js";

const ev = () => makeProvenance("f1", "清单.xlsx", { kind: "range", sheet: "S", rows: [2, 2] }, { snippet: "x" });

function oirWith(opts: { objects?: number; withEndpoint?: number; systemHints?: number } = {}): OIR {
  const o = new OIR();
  for (let i = 0; i < (opts.objects ?? 0); i += 1) {
    const hinted = i < (opts.systemHints ?? 0);
    o.addObject(makeObjectType({
      rid: makeRid("ot", `obj${i}`),
      apiName: extracted(`obj${i}`, ev()),
      displayName: extracted(`对象${i}`, ev()),
      description: extracted(hinted ? "由 SAP 写入，经接口同步到 SRM" : "一个普通业务对象", ev()),
    }));
  }
  for (let i = 0; i < (opts.withEndpoint ?? 0); i += 1) {
    o.addAction(makeActionType({
      rid: makeRid("fn", `act${i}`),
      apiName: extracted(`act${i}`, ev()),
      sourceEndpoint: extracted<Record<string, string> | null>({ path: "SAP事务码=MIR7", display: `动作${i}` }, ev()),
    }));
  }
  return o;
}

function flowWith(nodes: number): FlowGraph {
  const g = new FlowGraph();
  applyFlowEdit(g, "apply_patch", {
    stages: [{ key: "s1", title: "阶段一" }],
    nodes: Array.from({ length: nodes }, (_, i) => ({
      key: `n${i}`, kind: "action", label: `环节${i}`, stage: "s1", actor: i % 2 ? "采购员" : "",
    })),
    edges: Array.from({ length: Math.max(0, nodes - 1) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  }, { source: "user" });
  return g;
}

describe("projectFourA", () => {
  it("四层都在，顺序固定 —— 这是一份要交给客户的文档骨架", () => {
    const view = projectFourA(oirWith({ objects: 3 }), flowWith(2));
    expect(view.layers.map((l) => l.id)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(view.layers.map((l) => l.name)).toEqual(["业务架构", "应用架构", "数据架构", "技术架构"]);
    // 每层都要说清它回答什么问题 —— 否则客户不知道该看什么
    for (const l of view.layers) expect(l.question.length).toBeGreaterThan(6);
  });

  it("A1 从流程来：环节、阶段、执行角色", () => {
    const view = projectFourA(oirWith({}), flowWith(4));
    const a1 = view.layers[0]!;
    expect(a1.counts["流程环节"]).toBe(4);
    expect(a1.counts["阶段"]).toBe(1);
    expect(a1.counts["执行角色"]).toBe(1);          // 只有一个不重复的 actor
    expect(a1.coverage).not.toBe("none");
  });

  it("A3 从对象/属性/关系来", () => {
    const view = projectFourA(oirWith({ objects: 5 }), null);
    const a3 = view.layers[2]!;
    expect(a3.counts["数据对象"]).toBe(5);
    expect(a3.coverage).not.toBe("none");
  });

  it("A2 有接口就据实报（这条通道刚在 extractor schema 里补上）", () => {
    const view = projectFourA(oirWith({ objects: 2, withEndpoint: 3 }), null);
    const a2 = view.layers[1]!;
    expect(a2.counts["带接口的动作"]).toBe(3);
    expect(a2.items.some((i) => i.label.includes("MIR7"))).toBe(true);
    // 标签要带得出动作名 —— ActionType 没有 displayName，读错字段就会全是空白
    expect(a2.items[0]!.label).toMatch(/^act\d/u);
  });

  it("**A2 没有接口、但对象描述里提到系统时，要说「有料没容器」而不是「没有」**", () => {
    // 真库形态：sourceEndpoint 0/N，而几百个对象的描述里写着 SAP / 接口 / 集成。
    const view = projectFourA(oirWith({ objects: 10, systemHints: 6 }), null);
    const a2 = view.layers[1]!;
    expect(a2.counts["带接口的动作"]).toBe(0);
    expect(a2.notes.join("\n")).toContain("6");            // 数出来了
    expect(a2.notes.join("\n")).toContain("描述");          // 说清它躲在哪
    expect(a2.coverage).toBe("thin");                      // 不是 none，也不是 partial
    expect(a2.missing.join("").length).toBeGreaterThan(0);
    expect(a2.askWho).toContain("系统");                    // 找谁要说得出
  });

  it("A4 真空时**显式判空**，并说清要问谁要什么 —— 不留白让人以为在建", () => {
    const view = projectFourA(oirWith({ objects: 5 }), flowWith(3));
    const a4 = view.layers[3]!;
    expect(a4.coverage).toBe("none");
    expect(a4.items).toEqual([]);
    expect(a4.missing.length).toBeGreaterThan(0);
    expect(a4.askWho.length).toBeGreaterThan(0);
    // 空不等于沉默：必须有一句给人看的话
    expect(a4.notes.join("")).toContain("材料");
  });

  it("对齐矩阵：一行一个流程环节，看它连着哪些数据对象与系统", () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", {
      stages: [{ key: "s1", title: "阶段一" }],
      nodes: [
        { key: "n1", kind: "action", label: "提交请购单", stage: "s1", actor: "采购员" },
        { key: "n2", kind: "action", label: "审批", stage: "s1" },
      ],
      edges: [{ from: "n1", to: "n2" }],
    }, { source: "user" });
    const o = oirWith({ objects: 1 });
    const view = projectFourA(o, g);
    expect(view.matrix.rows.length).toBe(2);
    expect(view.matrix.columns).toEqual(["流程环节", "执行角色", "数据对象", "应用系统", "技术组件"]);
    const first = view.matrix.rows[0]!;
    expect(first[0]).toBe("提交请购单");
    expect(first[1]).toBe("采购员");
    // 没连上的一律写「未接入」，不留空格 —— 空格会被读成「这里不用填」
    expect(first[3]).toContain("未");
    expect(first[4]).toContain("未");
  });

  it("整份模型为空时不炸，四层各自说空", () => {
    const view = projectFourA(new OIR(), null);
    expect(view.layers).toHaveLength(4);
    expect(view.layers.every((l) => l.coverage === "none")).toBe(true);
    expect(view.matrix.rows).toEqual([]);
  });
});
