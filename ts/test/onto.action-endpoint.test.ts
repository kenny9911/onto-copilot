/**
 * Action 的接口坑位（应用架构 A2 的唯一入口）。
 *
 * `pipeline.ts` 的 buildOir 一直在读 `actions[].endpoint` 并写进
 * `ObjectType/ActionType.sourceEndpoint` —— 但 `catalog/agents/schemas/extractor.schema.json`
 * 的 actions 项**根本没有这个属性**，而 `backends.ts` 的 strictify 会给每个 object
 * 补上 `additionalProperties: false`。于是模型即使在证据里读到「SAP事务码=MIR7」，
 * 也无处安放：这条读侧代码出厂即是死代码，sourceEndpoint 恒空。
 *
 * 后果是应用架构整层塌方（真库实测）：
 *  · 3f6079e3e38f：flow 节点带 endpoint 的 0/31，PROCESS.steps 带 system_ids 的 0/0，
 *    ERP_MAP.landscape 1 条且 product/version/module/org_scope 全 null；
 *  · fc58b72e91bd：0/38，landscape **0 条**、mappings 0 条 —— 而客户交来的材料里
 *    就有《采购领域应用架构清单》，证据串里明写「源系统=SAP｜目标系统=FIS」。
 *
 * 类型必须是 `["string","null"]` 而不是裸 string：strictify 会把属性变成**必填**，
 * 裸 string 等于逼模型给每个动作编一个接口路径，而编出来的路径会经
 * flow_link → step.system_ids → ERP landscape 直接污染产物。给得出才给，给不出给 null。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("extractor schema 的 actions 桶", () => {
  const schema = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "catalog", "agents", "schemas", "extractor.schema.json"), "utf8"),
  ) as Record<string, any>;
  const item = schema["properties"]["actions"]["items"];

  it("有 endpoint 坑位 —— 否则 buildOir 里读它的那段是死代码", () => {
    expect(Object.keys(item["properties"])).toContain("endpoint");
  });

  it("类型允许 null：给不出接口时说「没有」，不许逼模型编一个", () => {
    expect(item["properties"]["endpoint"]["type"]).toEqual(["string", "null"]);
    // 描述里必须明说「没有就给 null、不要猜」—— 否则 strictify 的必填会逼出假路径
    const desc = String(item["properties"]["endpoint"]["description"]);
    expect(desc).toContain("null");
    expect(desc).toContain("不要猜");
  });

  it("不进 required —— 它是补充信息，不是抽取的前提", () => {
    expect(item["required"]).not.toContain("endpoint");
  });
});

describe("buildOir 把 endpoint 落进 sourceEndpoint", () => {
  it("给了接口就记下来，没给就是 null（不留假路径）", async () => {
    const { buildOir } = await import("../src/onto/pipeline.js");
    const merged = {
      objects: [],
      properties: [],
      links: [],
      events: [],
      rules: [],
      actions: [
        {
          api_name: "postInvoice", display_name: "过账发票", applies_to: [],
          endpoint: "SAP事务码=MIR7",
          source_file: "清单.xlsx", source_locator: "清单.xlsx!S!R2-2",
        },
        {
          api_name: "manualCheck", display_name: "人工核对", applies_to: [],
          endpoint: null,
          source_file: "清单.xlsx", source_locator: "清单.xlsx!S!R3-3",
        },
      ],
    };
    const oir = buildOir(merged as never, null as never);
    const acts = [...oir.actions.values()];
    expect(acts).toHaveLength(2);
    const withEndpoint = acts.find((a) => a.apiName.value === "postInvoice")!;
    expect((withEndpoint.sourceEndpoint.value as Record<string, string>)["path"]).toBe("SAP事务码=MIR7");
    const without = acts.find((a) => a.apiName.value === "manualCheck")!;
    expect(without.sourceEndpoint.value).toBeNull();
  });
});
