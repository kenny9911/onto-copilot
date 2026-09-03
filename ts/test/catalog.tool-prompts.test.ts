import { describe, expect, it } from "vitest";

import {
  TOOL_POLICIES,
  composeManagedToolPrompt,
  managedToolRegistrar,
  toolPolicy,
} from "../src/catalog/tools.js";
import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { converseTools } from "../src/server/dialogue/tools.js";
import { builtinRegistry } from "../src/server/glue/tools.js";

describe("managed tool routing prompts", () => {
  it("66 个工具都有短、单行且互不重复的选择边界", () => {
    expect(TOOL_POLICIES).toHaveLength(66);
    const prompts = new Set<string>();
    for (const policy of TOOL_POLICIES) {
      expect(policy.routingPrompt.trim(), policy.name).toBe(policy.routingPrompt);
      expect(policy.routingPrompt, policy.name).not.toContain("\n");
      expect([...policy.routingPrompt].length, policy.name).toBeLessThanOrEqual(220);
      expect(prompts.has(policy.routingPrompt), policy.name).toBe(false);
      prompts.add(policy.routingPrompt);
    }
  });

  it("最容易误选的工具对在 catalog 中明确互相指路", () => {
    expect(toolPolicy("material.parse").routingPrompt).toContain("不生成 Ontology");
    expect(toolPolicy("build.start").routingPrompt).toContain("material.parse");
    expect(toolPolicy("memory.recall").routingPrompt).toContain("revision.diff");
    expect(toolPolicy("revision.diff").routingPrompt).toContain("memory.recall");
    expect(toolPolicy("question.answer").routingPrompt).toContain("decision.record");
    expect(toolPolicy("decision.record").routingPrompt).toContain("question.answer");
    expect(toolPolicy("flow.sketch").routingPrompt).toContain("draft.adopt");
    expect(toolPolicy("flow.sketch").routingPrompt).toContain("flow.render");
    expect(toolPolicy("flow.sketch").routingPrompt).toContain("右侧通用参考只读层");
    expect(toolPolicy("flow.sketch").routingPrompt).toContain("不更新正式工作流画布");
    expect(toolPolicy("flow.render").routingPrompt).toContain("Image 2");
    expect(toolPolicy("flow.render").routingPrompt).toContain("先 flow.sketch");
    expect(toolPolicy("flow.render").routingPrompt).toContain("不为出图 draft.adopt");
    expect(toolPolicy("flow.render").routingPrompt).toContain("只要 SVG/Mermaid 时不调");
    expect(toolPolicy("flow.render").routingPrompt).toContain("具体 style");
    expect(toolPolicy("flow.render").routingPrompt).toContain("theme/layout/visual_brief");
    expect(toolPolicy("flow.render").routingPrompt).toContain("同轮不得");
    expect(toolPolicy("web.search").routingPrompt).toContain("不得把客户材料");
    expect(toolPolicy("web.search").routingPrompt).toContain("scope=global");
    expect(toolPolicy("web.search").routingPrompt).toContain("英文查询");
    expect(toolPolicy("web.search").routingPrompt).toContain("不得声称来自 Google");
    expect(toolPolicy("document.search").routingPrompt).toContain("自动检索");
    expect(toolPolicy("document.search").routingPrompt).toContain("不能证明");
    expect(toolPolicy("document.open").routingPrompt).toContain("evidence_ref");
    expect(toolPolicy("document.promote").routingPrompt).toContain("用户明确要求");
    expect(toolPolicy("document.manage").routingPrompt).toContain("不能永久删除");
  });

  it("core 路由不会把专业 Agent 指向 dialogue-only 工具", () => {
    for (const policy of TOOL_POLICIES.filter((item) => item.assembly === "core")) {
      const refs = policy.routingPrompt.match(/[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/gu) ?? [];
      for (const ref of refs) {
        expect(toolPolicy(ref).assembly, `${policy.name} → ${ref}`).toBe("core");
      }
    }
  });

  it("组合时保留 handler 详细说明，并且重复组合不会叠两层", () => {
    const detailed = "原有详细说明：动态格式、参数与操作契约保持原样。";
    const once = composeManagedToolPrompt("web.search", detailed);
    const twice = composeManagedToolPrompt("web.search", once);
    expect(once).toContain(toolPolicy("web.search").routingPrompt);
    expect(once.endsWith(detailed)).toBe(true);
    expect(twice).toBe(once);
  });

  it("只有显式启用 managed registrar 的 registry 才组合 prompt", () => {
    const raw = new ToolRegistry();
    raw.fn(
      {
        name: "web.search",
        description: "原始说明",
        schema: { type: "object", properties: {} },
        danger: Danger.READ,
        scopes: ["converse", "chat"],
      },
      () => ({}),
    );
    expect(raw.get("web.search", "chat").spec.description).toBe("原始说明");

    const managed = new ToolRegistry();
    managedToolRegistrar(managed, "dialogue").fn(
      {
        name: "web.search",
        description: "原始说明",
        schema: { type: "object", properties: {} },
        danger: Danger.READ,
        scopes: ["converse", "chat"],
      },
      () => ({}),
    );
    const description = managed.get("web.search", "chat").spec.description;
    expect(description.startsWith("选择边界：")).toBe(true);
    expect(description.endsWith("原始说明")).toBe(true);
  });

  it("registrar 拒绝跨装配注册", () => {
    const reg = new ToolRegistry();
    expect(() => managedToolRegistrar(reg, "core").fn(
      {
        name: "web.search",
        description: "x",
        schema: { type: "object", properties: {} },
        danger: Danger.READ,
        scopes: ["converse", "chat"],
      },
      () => ({}),
    )).toThrow(/属于 dialogue 装配/u);
    expect(reg.registrationSnapshot()).toEqual([]);
  });

  it("core 与 dialogue 的生产 registry 都显式启用组合", () => {
    const core = builtinRegistry({
      evidence: {
        search: () => [],
        fileNames: () => new Map<string, string>(),
        byLocator: () => [],
        allChunks: () => [],
      },
    });
    expect(core.get("evidence.search", "readonly").spec.description)
      .toMatch(/^选择边界：/u);

    const dialogue = converseTools(
      {
        state: {},
        files: [],
        dir: "/tmp/ontochat-tool-prompt-test",
        title: "test",
        project: "test",
      } as never,
      {
        builtinRegistry: () => new ToolRegistry(),
        exportApi: {
          FORMATS: ["xlsx", "docx", "md", "csv"],
          availableFormats: () => ["xlsx", "docx", "md", "csv"],
        },
      } as never,
    );
    expect(dialogue.get("material.parse", "chat").spec.description)
      .toMatch(/^选择边界：/u);
    expect(dialogue.get("build.start", "converse").spec.description)
      .toContain("只在用户明确要完整 Ontology");
  });
});
