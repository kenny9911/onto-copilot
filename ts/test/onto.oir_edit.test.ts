/**
 * onto/oir_edit.ts —— 对话口述改 OIR。
 *
 * 期望值全部来自 `golden/onto.oir_edit.json`（`tools/golden/onto_oir_edit.py` 从
 * Python 原件真跑出来的）：每一步的**回执文案**、**报错文案**、以及**整份 OIR 的
 * to_dict()**。起始 OIR 也是从 golden 的 `before` 还原的 —— 手写一份起始状态就
 * 等于手写期望值，两侧一漂就全白测。
 *
 * 除了逐案比对，这里还跨全部用例守三条不变式（它们才是这个模块存在的理由）：
 *   G-origin  任何编辑都不能凭空造出 `origin=extracted` 的断言（不许冒充材料证据）；
 *   原子性     被拒的编辑让 OIR 一个字节都不变；
 *   幂等       同一条编辑做两次，第二次要么被拒、要么不改变状态。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OIR, Origin, Status, oirFromDict } from "../src/onto/oir.js";
import { OIREditError, OIR_EDIT_OPS, applyOirEdit } from "../src/onto/oir_edit.js";

const GOLDEN = fileURLToPath(new URL("../../golden/onto.oir_edit.json", import.meta.url));

interface Step {
  op: string;
  args: Record<string, unknown>;
  ok: boolean;
  note?: string;
  error?: string;
  message?: string;
  unchanged?: boolean;
  after: Record<string, unknown>;
}
interface Case {
  label: string;
  before: Record<string, unknown>;
  steps: Step[];
}
const G = JSON.parse(readFileSync(GOLDEN, "utf-8")) as {
  origins: Record<string, string>;
  cases: Case[];
};

function caseOf(label: string): Case {
  const c = G.cases.find((x) => x.label === label);
  if (!c) throw new Error(`golden 缺用例 ${label}`);
  return c;
}

/** 收集一份 OIR dict 里所有断言（带路径），供不变式检查用。 */
function assertions(d: unknown, path = ""): { path: string; a: Record<string, unknown> }[] {
  const out: { path: string; a: Record<string, unknown> }[] = [];
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    if ("value" in o && "origin" in o && "evidence" in o) {
      out.push({ path: p, a: o });
      return;
    }
    for (const [k, x] of Object.entries(o)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(d, path);
  return out;
}

describe("golden 逐案比对", () => {
  for (const c of G.cases) {
    it(c.label, () => {
      const oir = oirFromDict(c.before);
      // 起点先自证：fromDict∘toDict 必须是恒等，否则后面的 diff 全不可信
      expect(oir.toDict()).toEqual(c.before);
      for (const step of c.steps) {
        if (step.ok) {
          expect(applyOirEdit(oir, step.op, step.args)).toBe(step.note);
        } else {
          expect(() => applyOirEdit(oir, step.op, step.args)).toThrow(OIREditError);
          try {
            applyOirEdit(oir, step.op, step.args);
          } catch (e) {
            expect((e as Error).message).toBe(step.message);
          }
        }
        expect(oir.toDict()).toEqual(step.after);
      }
    });
  }
});

describe("不变式（跨全部用例）", () => {
  it("G-origin：编辑不能凭空造出 origin=extracted 的断言", () => {
    // 冒充材料抽取是这个产品最不能碰的一条 —— 一旦人说的话被标成"材料里读到的"，
    // 「你怎么知道的」就再也答不上来了。
    for (const c of G.cases) {
      const before = new Set(
        assertions(c.before)
          .filter((x) => x.a["origin"] === Origin.EXTRACTED)
          .map((x) => JSON.stringify(x.a)),
      );
      const oir = oirFromDict(c.before);
      for (const step of c.steps) {
        try {
          applyOirEdit(oir, step.op, step.args);
        } catch {
          /* 被拒的步骤也要检查：拒了之后状态更不该变 */
        }
        for (const x of assertions(oir.toDict())) {
          if (x.a["origin"] === Origin.EXTRACTED) {
            expect(
              before.has(JSON.stringify(x.a)),
              `${c.label} / ${step.op} 在 ${x.path} 造出了新的 extracted 断言`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("原子性：被拒的编辑让 OIR 一个字节都不变", () => {
    let rejected = 0;
    for (const c of G.cases) {
      const oir = oirFromDict(c.before);
      for (const step of c.steps) {
        const snapshot = JSON.stringify(oir.toDict());
        if (step.ok) {
          applyOirEdit(oir, step.op, step.args);
          continue;
        }
        rejected++;
        expect(step.unchanged, `${c.label}: golden 说这步改了状态？`).toBe(true);
        expect(() => applyOirEdit(oir, step.op, step.args)).toThrow(OIREditError);
        expect(JSON.stringify(oir.toDict())).toBe(snapshot);
      }
    }
    expect(rejected).toBeGreaterThan(15); // 别让这条不变式因为用例没了而空转
  });

  it("口述赋值一律带 extractor=human 的 Provenance", () => {
    for (const c of G.cases) {
      const oir = oirFromDict(c.before);
      const seenBefore = new Set(assertions(c.before).map((x) => JSON.stringify(x.a)));
      for (const step of c.steps) {
        try {
          applyOirEdit(oir, step.op, step.args);
        } catch {
          continue;
        }
      }
      for (const x of assertions(oir.toDict())) {
        if (x.a["origin"] !== Origin.USER) continue;
        if (seenBefore.has(JSON.stringify(x.a))) continue; // 本来就有的，不归这次编辑管
        const ev = x.a["evidence"] as Record<string, unknown>[];
        expect(ev.length, `${c.label} ${x.path} 没有 human 出处`).toBeGreaterThan(0);
        expect(ev[0]!["extractor"]).toBe("human");
      }
    }
  });
});

describe("幂等", () => {
  it("同一个取值加两次：第二次被拒，状态不变", () => {
    const c = caseOf("add_enum_value_twice");
    const oir = oirFromDict(c.before);
    applyOirEdit(oir, "add_enum_value", { property: "采购包.状态", value: "已发布" });
    const after1 = JSON.stringify(oir.toDict());
    expect(() =>
      applyOirEdit(oir, "add_enum_value", { property: "采购包.状态", value: "已发布" }),
    ).toThrow(/已经有取值/);
    expect(JSON.stringify(oir.toDict())).toBe(after1);
  });

  it("同一条规则挂同一个对象两次：不重复追加", () => {
    const c = caseOf("bind_rule_twice");
    const oir = oirFromDict(c.before);
    applyOirEdit(oir, "bind_rule", { rule: "审批", object: "供应商" });
    const after1 = JSON.stringify(oir.toDict());
    applyOirEdit(oir, "bind_rule", { rule: "审批", object: "供应商" });
    expect(JSON.stringify(oir.toDict())).toBe(after1);
  });

  it("set_status 重复设同一个值：状态不变", () => {
    const c = caseOf("set_status_rejected");
    const oir = oirFromDict(c.before);
    applyOirEdit(oir, "set_status", { target: "采购包", status: "rejected" });
    const after1 = JSON.stringify(oir.toDict());
    applyOirEdit(oir, "set_status", { target: "采购包", status: "rejected" });
    expect(JSON.stringify(oir.toDict())).toBe(after1);
  });

  it("set_action_scope 重复设同一批对象：状态不变", () => {
    const c = caseOf("set_action_scope");
    const oir = oirFromDict(c.before);
    const args = { action: "publishPackage", objects: ["采购包", "供应商"] };
    applyOirEdit(oir, "set_action_scope", args);
    const after1 = JSON.stringify(oir.toDict());
    applyOirEdit(oir, "set_action_scope", args);
    expect(JSON.stringify(oir.toDict())).toBe(after1);
  });
});

describe("溯源不被破坏", () => {
  it("edit_assertion 只动那一个字段，其它断言的 origin 原封不动", () => {
    const c = caseOf("edit_assertion_required");
    const oir = oirFromDict(c.before);
    applyOirEdit(oir, "edit_assertion", { target: "状态", field: "required", value: true });
    const p = [...oir.properties.values()].find((x) => x.apiName.value === "状态")!;
    expect(p.required.value).toBe(true);
    expect(p.required.origin).toBe(Origin.USER);
    // 结构化编辑的全部意义就在这一行
    expect(p.apiName.origin).toBe(Origin.EXTRACTED);
    expect(p.displayName.origin).toBe(Origin.EXTRACTED);
    expect(p.apiName.evidence[0]!.extractor).toBe("docling");
  });

  it("从材料抽出来的实体不许硬删，但可以标 rejected（可逆）", () => {
    const oir = oirFromDict(caseOf("remove_extracted_object").before);
    expect(() => applyOirEdit(oir, "remove_object_type", { target: "采购包" })).toThrow(
      /不是人工口述加的/,
    );
    applyOirEdit(oir, "set_status", { target: "采购包", status: "rejected" });
    const o = [...oir.objects.values()].find((x) => x.apiName.value === "采购包")!;
    expect(o.status).toBe(Status.REJECTED);
    expect(o.apiName.evidence.length).toBeGreaterThan(0); // 证据还在
  });

  it("删掉人工口述加的对象会级联删属性与相关关系", () => {
    const oir = oirFromDict(caseOf("remove_user_object_cascades").before);
    applyOirEdit(oir, "remove_object_type", { target: "供应商" });
    expect([...oir.objects.values()].some((o) => o.apiName.value === "供应商")).toBe(false);
    expect([...oir.properties.values()].some((p) => p.apiName.value === "评级")).toBe(false);
    expect(oir.links.size).toBe(0); // 指向它的关系一起走
  });

  it("编辑后重新序列化再载回，USER 来源不会被降级成 INFERRED", () => {
    const oir = oirFromDict(caseOf("add_enum_value").before);
    applyOirEdit(oir, "add_enum_value", { property: "采购包.状态", value: "已发布" });
    const restored = oirFromDict(oir.toDict());
    const p = [...restored.properties.values()].find((x) => x.apiName.value === "状态")!;
    expect(p.valueDomain.origin).toBe(Origin.USER);
    expect(p.valueDomain.value).toContain("已发布");
    expect(p.baseType.value).toBe("ENUM"); // 有取值域了，类型自动改 ENUM
  });
});

describe("守卫与解析", () => {
  it("引用不存在的对象整体拒绝，活 OIR 不动", () => {
    const oir = oirFromDict(caseOf("add_property_no_object").before);
    const before = JSON.stringify(oir.toDict());
    expect(() => applyOirEdit(oir, "add_property", { object: "不存在的对象", api_name: "x" })).toThrow(
      OIREditError,
    );
    expect(JSON.stringify(oir.toDict())).toBe(before);
  });

  it("对象 api_name 重复直接拒绝", () => {
    const oir = oirFromDict(caseOf("add_object_type_dup").before);
    expect(() => applyOirEdit(oir, "add_object_type", { api_name: "采购包" })).toThrow(
      /已有对象/,
    );
  });

  it("按 rid / apiName / displayName / 别名 / 子串都能找到对象", () => {
    const c = caseOf("add_object_type");
    for (const ref of ["ot_采购包", "采购包", "采购单", "采购"]) {
      const oir = oirFromDict(c.before);
      expect(applyOirEdit(oir, "add_property", { object: ref, api_name: "x" })).toContain(
        "给「采购包」加属性",
      );
    }
  });

  it("「对象.属性」的写法能消歧", () => {
    const oir = oirFromDict(caseOf("remove_user_property").before);
    expect(applyOirEdit(oir, "remove_property", { target: "供应商.评级" })).toBe(
      "删掉了属性「评级」。",
    );
  });

  it("remove_link 只认 rid —— 用名字会被明确拒绝", () => {
    const oir = oirFromDict(caseOf("remove_link_by_name").before);
    expect(() => applyOirEdit(oir, "remove_link", { target: "包_供" })).toThrow(/用 rid/);
  });
});

describe("参数校验（模型就是靠这句话学会怎么调的）", () => {
  const base = (): OIR => oirFromDict(caseOf("add_object_type").before);

  it("未知 op 报出全部支持的 op", () => {
    expect(() => applyOirEdit(base(), "frobnicate", {})).toThrow(
      /不支持的 OIR 编辑 frobnicate。支持：\['add_action_type'/,
    );
  });

  it("OIR_EDIT_OPS 与实现同源，不许另抄一份", () => {
    expect([...OIR_EDIT_OPS].sort()).toEqual(
      [
        "add_action_type",
        "add_enum_value",
        "add_link",
        "add_object_type",
        "add_property",
        "add_rule",
        "bind_rule",
        "edit_assertion",
        "remove_action_type",
        "remove_link",
        "remove_object_type",
        "remove_property",
        "remove_rule",
        "set_action_scope",
        "set_status",
      ].sort(),
    );
  });

  it("缺参 / 多参的文案逐字复现 CPython", () => {
    const shot = (op: string, args: Record<string, unknown>): string => {
      try {
        applyOirEdit(base(), op, args);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("本该抛");
    };
    expect(shot("add_object_type", {})).toBe(
      "add_object_type 的参数不对：_op_add_object_type() missing 1 required keyword-only argument: 'api_name'",
    );
    expect(shot("add_property", {})).toBe(
      "add_property 的参数不对：_op_add_property() missing 2 required keyword-only arguments: 'object' and 'api_name'",
    );
    expect(shot("edit_assertion", {})).toBe(
      "edit_assertion 的参数不对：_op_edit_assertion() missing 3 required keyword-only arguments: 'target', 'field', and 'value'",
    );
    expect(shot("add_object_type", { api_name: "x", nope: 1 })).toBe(
      "add_object_type 的参数不对：_op_add_object_type() got an unexpected keyword argument 'nope'",
    );
    // 多参优先于缺参 —— CPython 绑定关键字时就抛了，缺参检查发生在那之后
    expect(shot("add_object_type", { nope: 1 })).toContain("unexpected keyword argument 'nope'");
  });

  it("可选参数不传不报错", () => {
    expect(applyOirEdit(base(), "add_object_type", { api_name: "合同" })).toBe(
      "新增对象「合同」（人工口述，标 USER 来源）。",
    );
  });
});
