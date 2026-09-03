import { describe, expect, it } from "vitest";

import { checkCatalog } from "../src/catalog/check.js";
import {
  assertManagedToolRegistrations,
  toolPolicies,
} from "../src/catalog/tools.js";
import { Danger, ToolRegistry } from "../src/kernel/tools.js";

describe("runtime definition catalog", () => {
  it("loads Skills, Agents, Tools and the frozen FDE workflow as one consistent catalog", () => {
    expect(checkCatalog()).toEqual({
      skills: 18,
      // 18：新增 flow_modeler —— 从文字材料建流程基线，每个环节带原文出处。
      // 与 process_modeler 分工：那个只给已有基线补细节，一个环节都不许新增。
      agents: 18,
      // 66：在既有 58 项上新增 8 项 OntoDocument 管理与检索工具。
      tools: 66,
      coreTools: 8,
      dialogueTools: 58,
      workflows: 1,
      workflowNodes: 16,
    });
  });

  it("keeps every managed dialogue tool under an explicit non-global scope", () => {
    for (const policy of toolPolicies("dialogue")) {
      expect(policy.scopes.length, policy.name).toBeGreaterThan(0);
      expect(policy.scopes, policy.name).not.toContain("*");
    }
  });

  it("fails fast when executable danger or scope drifts from the catalog", () => {
    const reg = new ToolRegistry();
    reg.fn(
      {
        name: "web.search",
        description: "test",
        schema: { type: "object" },
        danger: Danger.WRITE_LOCAL,
        scopes: ["converse", "chat"],
      },
      () => ({}),
    );
    expect(() => assertManagedToolRegistrations(reg.registrationSnapshot(), "dialogue"))
      .toThrow(/danger 与 catalog 不一致/u);
  });
});
