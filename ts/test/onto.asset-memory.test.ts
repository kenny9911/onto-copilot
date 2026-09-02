import { describe, expect, it } from "vitest";

import {
  AssetMemory,
  normalizeRelativeAssetPath,
  type AssetRecord,
} from "../src/onto/asset_memory.js";

function byKind(rows: readonly AssetRecord[], kind: AssetRecord["kind"]): AssetRecord[] {
  return rows.filter((row) => row.kind === kind);
}

describe("AssetMemory", () => {
  it("为同一版本生成稳定 id，并合并来自状态和事件的别名、标签与时序", () => {
    const memory = new AssetMemory("session-1");
    const fromState = memory.upsert({
      kind: "image",
      name: "采购流程视觉版.png",
      path: "exports/采购流程视觉版.png",
      mime: "image/png",
      source: "state.artifacts",
      origin: "generated",
      contentDigest: "sha256:image-v1",
      seq: 8,
      aliases: ["采购流程图"],
      tags: ["流程"],
    });
    const fromEvent = memory.upsert({
      kind: "image",
      name: "采购流程视觉版.png",
      path: "exports/采购流程视觉版.png",
      source: "artifact.ready",
      origin: "generated",
      contentDigest: "sha256:image-v1",
      seq: 12,
      aliases: ["Image 2 采购图"],
      tags: ["视觉版"],
      displayOnly: true,
      metadata: { model: "openai/gpt-5.4-image-2" },
    });

    expect(fromEvent.id).toBe(fromState.id);
    expect(memory.list()).toHaveLength(1);
    expect(fromEvent.createdSeq).toBe(8);
    expect(fromEvent.updatedSeq).toBe(12);
    expect(fromEvent.aliases).toEqual(expect.arrayContaining(["采购流程图", "Image 2 采购图"]));
    expect(fromEvent.tags).toEqual(expect.arrayContaining(["流程", "视觉版"]));
    expect(fromEvent.sources).toEqual(expect.arrayContaining(["state.artifacts", "artifact.ready"]));
    expect(fromEvent.displayOnly).toBe(true);
    expect(fromEvent.metadata).toMatchObject({ model: "openai/gpt-5.4-image-2" });
  });

  it("同一逻辑资产内容变化时保留版本链，并把旧版本标记为 superseded", () => {
    const memory = new AssetMemory("session-1");
    const first = memory.upsert({
      kind: "material",
      name: "采购制度.pdf",
      path: "materials/采购制度.pdf",
      source: "files.attached",
      origin: "uploaded",
      contentDigest: "sha256:v1",
      seq: 2,
    });
    const second = memory.upsert({
      kind: "material",
      name: "采购制度.pdf",
      path: "materials/采购制度.pdf",
      source: "files.attached",
      origin: "uploaded",
      contentDigest: "sha256:v2",
      seq: 9,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.supersedes).toBe(first.id);
    expect(memory.get(first.id)?.status).toBe("superseded");
    // 领域层拿不到旧文件字节，不能让 superseded 记录继续指向会被覆盖的 locator。
    expect(memory.get(first.id)?.path).toBeNull();
    expect(memory.get(first.id)?.metadata).toMatchObject({
      bytesUnavailable: true,
      supersededSourcePath: "materials/采购制度.pdf",
    });
    expect(memory.list()).toEqual([second]);
    expect(memory.list({ includeSuperseded: true })).toHaveLength(2);
  });

  it("读取旧目录时折叠 state.sketch semantic digest 造成的伪版本链", () => {
    const legacy = new AssetMemory("legacy-sketch");
    const placeholder = legacy.upsert({
      kind: "sketch",
      name: "采购流程.svg",
      path: "exports/采购流程.svg",
      source: "state.sketch",
      origin: "model_knowledge",
      logicalRef: "sketch:采购",
      contentDigest: "semantic-graph-digest",
      seq: 7,
      metadata: { domain: "采购" },
    });
    const materialized = legacy.upsert({
      kind: "sketch",
      name: "采购流程.svg",
      path: "exports/.__asset_memory__byte__采购流程.svg",
      source: "sketch.ready",
      origin: "model_knowledge",
      logicalRef: "sketch:采购",
      contentDigest: "byte-digest",
      seq: 7,
      metadata: {
        immutable: true,
        sourcePath: "exports/采购流程.svg",
        logicalRef: "sketch:采购",
      },
    });
    expect(materialized.supersedes).toBe(placeholder.id);

    const repaired = AssetMemory.fromDict(legacy.toDict());
    const rows = repaired.list({ includeSuperseded: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: materialized.id,
      revision: 1,
      supersedes: null,
      status: "active",
    });
    expect(rows[0]?.metadata["immutable"]).toBe(true);
  });

  it("只保留安全相对路径，不让绝对路径或目录穿越进入持久化状态", () => {
    expect(normalizeRelativeAssetPath("exports/采购图.png")).toBe("exports/采购图.png");
    expect(normalizeRelativeAssetPath("exports\\nested\\flow.svg")).toBe("exports/nested/flow.svg");
    expect(normalizeRelativeAssetPath("../secrets.txt")).toBeNull();
    expect(normalizeRelativeAssetPath("/Users/person/private.png")).toBeNull();
    expect(normalizeRelativeAssetPath("C:\\private\\flow.png")).toBeNull();

    const row = new AssetMemory("s").upsert({
      kind: "document",
      name: "报告.pdf",
      path: "../../报告.pdf",
      source: "test",
      origin: "generated",
    });
    expect(row.path).toBeNull();
  });

  it("能从完整 session 投影统一收纳材料、产物、Image 2 图片、草图和问题清单", () => {
    const memory = new AssetMemory("session-采购");
    memory.ingestSession({
      sessionId: "session-采购",
      seq: 40,
      files: [
        { name: "采购政策.pdf", size: 8192, sha256: "policy-v1", mime_type: "application/pdf" },
      ],
      state: {
        materials: [
          { name: "供应商准入说明.docx", digest: "supplier-guide-v1", size: 4096 },
        ],
        artifacts: ["采购报销_视觉版.png", "访谈问题清单.xlsx"],
        sketch: {
          domain: "采购报销",
          title: "采购报销流程参考图",
          svg: "采购报销_参考图.svg",
          mermaid: "采购报销_参考图.mmd",
          source_note: "通用参考 · 非客户材料证据",
          graph: { nodes: [{ id: "request", label: "采购申请" }], edges: [] },
        },
        question_backlog: {
          questions: [
            { id: "Q-budget", text: "超预算时由谁审批？", status: "open", evidenceIds: ["ev-1"] },
            { id: "Q-match", title: "三单匹配", prompt: "差异阈值是多少？", status: "open" },
          ],
        },
      },
      events: [
        {
          kind: "artifact.ready",
          seq: 41,
          name: "采购报销_视觉版.png",
          model: "openai/gpt-5.4-image-2",
          source: "generic_reference",
          display_only: true,
          surface: "chat_card",
        },
      ],
    });

    const rows = memory.list({ includeSuperseded: true });
    expect(byKind(rows, "material")).toHaveLength(2);
    expect(byKind(rows, "image")).toHaveLength(1);
    expect(byKind(rows, "document")).toHaveLength(1);
    expect(byKind(rows, "sketch")).toHaveLength(1);
    expect(byKind(rows, "question")).toHaveLength(2);
    expect(byKind(rows, "question_list")).toHaveLength(1);

    const image = byKind(rows, "image")[0]!;
    expect(image.mime).toBe("image/png");
    expect(image.displayOnly).toBe(true);
    expect(image.metadata).toMatchObject({ model: "openai/gpt-5.4-image-2", surface: "chat_card" });
    expect(image.sources).toEqual(expect.arrayContaining(["state.artifacts", "artifact.ready"]));

    const material = byKind(rows, "material").find((row) => row.name === "采购政策.pdf")!;
    expect(material.path).toBe("materials/采购政策.pdf");
    expect(material.metadata).toMatchObject({ size: 8192 });

    const list = byKind(rows, "question_list")[0]!;
    expect(list.metadata).toMatchObject({ count: 2, questionIds: ["Q-budget", "Q-match"] });
    expect(list.evidenceRefs).toContain("ev-1");
  });

  it("理解中文/英文类别、文件名与刚才/last 指代，并优先解析最近资产", () => {
    const memory = new AssetMemory("session-1");
    const policy = memory.upsert({
      kind: "material",
      name: "采购政策2026.pdf",
      path: "materials/采购政策2026.pdf",
      source: "files.attached",
      origin: "uploaded",
      seq: 3,
      aliases: ["采购制度"],
    });
    memory.upsert({
      kind: "image",
      name: "旧版采购图.png",
      path: "exports/旧版采购图.png",
      source: "artifact.ready",
      origin: "generated",
      seq: 5,
    });
    const latest = memory.upsert({
      kind: "image",
      name: "采购报销视觉流程.png",
      path: "exports/采购报销视觉流程.png",
      source: "artifact.ready",
      origin: "generated",
      seq: 18,
      aliases: ["Image 2 flow"],
    });
    const questions = memory.upsert({
      kind: "question_list",
      name: "采购访谈问题清单",
      source: "question_backlog",
      origin: "derived",
      seq: 11,
    });

    expect(memory.search("采购政策材料")[0]?.asset.id).toBe(policy.id);
    expect(memory.search("uploaded material")[0]?.asset.id).toBe(policy.id);
    expect(memory.search("question list")[0]?.asset.id).toBe(questions.id);
    expect(memory.resolveReference("刚才那张图").asset?.id).toBe(latest.id);
    expect(memory.resolveReference("last image").asset?.id).toBe(latest.id);
    expect(memory.resolveReference("Image 2 flow").asset?.id).toBe(latest.id);
  });

  it("toDict/fromDict 可确定性往返，重启后仍可检索和解析", () => {
    const before = new AssetMemory("session-rt");
    before.upsert({
      kind: "image",
      name: "流程图.png",
      path: "exports/流程图.png",
      uri: "artifacts/流程图.png",
      source: "artifact.ready",
      origin: "generated",
      seq: 7,
      provenanceRefs: ["run:flow-render:1"],
      evidenceRefs: ["ev:采购申请"],
      aliases: ["刚生成的采购图"],
      tags: ["采购", "流程"],
      displayOnly: true,
      metadata: { width: 1536, height: 1024 },
    });

    const dict = before.toDict();
    const after = AssetMemory.fromDict(dict);
    expect(after.toDict()).toEqual(dict);
    expect(after.resolveReference("刚生成的采购图").asset?.name).toBe("流程图.png");
    expect(after.list()[0]).toMatchObject({
      provenanceRefs: ["run:flow-render:1"],
      evidenceRefs: ["ev:采购申请"],
      displayOnly: true,
    });
  });

  it("事件归一化既收 Image 2 成品，也收推荐问题与参考草图", () => {
    const memory = new AssetMemory("events");
    memory.ingestEvent({
      kind: "artifact.ready",
      seq: 20,
      name: "采购流程_视觉版.png",
      artifact: "flow_presentation",
      asset_kind: "image",
      model: "gpt-image-2",
      display_only: true,
    });
    memory.ingestEvent({
      kind: "prompts.ready",
      seq: 21,
      questions: [
        { text: "谁负责预算审批？", send: "谁负责预算审批？" },
        { text: "三单匹配阈值是多少？", send: "三单匹配阈值是多少？" },
      ],
    });
    memory.ingestEvent({
      kind: "sketch.ready",
      seq: 22,
      name: "采购参考.svg",
      mermaid: "采购参考.mmd",
      domain: "采购",
      title: "采购参考流程",
      source_note: "通用参考",
      display_only: true,
    });

    expect(memory.resolveReference("Image 2图片").asset).toMatchObject({
      name: "采购流程_视觉版.png",
      kind: "image",
      path: "采购流程_视觉版.png",
      displayOnly: true,
    });
    expect(memory.resolveReference("推荐问题清单").asset).toMatchObject({ kind: "question_list" });
    expect(memory.resolveReference("刚才的参考草图").asset).toMatchObject({
      name: "采购参考.svg",
      kind: "sketch",
    });
  });

  it("默认召回把无 logical_ref 的同字节历史图片折叠为一份，但保留完整审计历史", () => {
    const memory = new AssetMemory("legacy-image-events");
    for (let version = 1; version <= 8; version++) {
      memory.ingestEvent({
        kind: "artifact.ready",
        seq: 40 + version,
        name: `采购流程_视觉版_v${version}.png`,
        asset_kind: "image",
        mime: "image/png",
        sha256: "same-image-bytes",
        // 旧事件有意不提供 logical_ref：每个版本名都会成为不同的逻辑资产。
      });
    }

    const durable = memory.toDict().assets;
    expect(durable).toHaveLength(8);
    expect(new Set(durable.map((row) => row.metadata["logicalRef"])).size).toBe(8);

    const projected = memory.list();
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      name: "采购流程_视觉版_v8.png",
      contentDigest: "same-image-bytes",
      metadata: {
        duplicateCount: 8,
        deduplicatedBy: "session+image-kind+mime+content-digest",
      },
    });
    expect(projected[0]?.metadata["duplicateAssetIds"]).toEqual(
      expect.arrayContaining(durable.map((row) => row.id)),
    );
    expect(memory.search("采购流程图片")).toHaveLength(1);
    expect(memory.search("所有流程图")).toHaveLength(1);
    expect(memory.resolveReference("刚才那张流程图").asset?.id).toBe(projected[0]?.id);

    // 显式 API 历史模式和自然语言历史查询都绕过默认投影。
    expect(memory.list({ includeSuperseded: true })).toHaveLength(8);
    expect(memory.search("全部流程图历史版本")).toHaveLength(8);
    expect(memory.search("采购流程图片", { includeSuperseded: true })).toHaveLength(8);
  });

  it("图片投影保留不同 digest，且绝不跨 session 或折叠普通文档", () => {
    const memory = new AssetMemory("session-a");
    const addImage = (sessionId: string, name: string, digest: string, seq: number): void => {
      memory.ingestEvent({
        kind: "artifact.ready",
        seq,
        name,
        asset_kind: "image",
        mime: "image/png",
        sha256: digest,
      }, { sessionId });
    };
    addImage("session-a", "流程_v1.png", "same", 1);
    addImage("session-a", "流程_v2.png", "same", 2);
    addImage("session-a", "流程_新内容.png", "different", 3);
    addImage("session-b", "另一会话流程.png", "same", 4);

    memory.upsert({
      sessionId: "session-a",
      seq: 5,
      kind: "document",
      name: "业务说明_v1.pdf",
      path: "exports/业务说明_v1.pdf",
      mime: "application/pdf",
      contentDigest: "same-document-bytes",
    });
    memory.upsert({
      sessionId: "session-a",
      seq: 6,
      kind: "document",
      name: "业务说明_v2.pdf",
      path: "exports/业务说明_v2.pdf",
      mime: "application/pdf",
      contentDigest: "same-document-bytes",
    });

    const projected = memory.list();
    expect(byKind(projected, "image")).toHaveLength(3);
    expect(byKind(projected, "image").map((row) => row.contentDigest)).toEqual(
      expect.arrayContaining(["same", "different"]),
    );
    expect(byKind(projected, "image").filter((row) => row.contentDigest === "same")).toHaveLength(2);
    expect(new Set(byKind(projected, "image").map((row) => row.sessionRef.sessionId))).toEqual(
      new Set(["session-a", "session-b"]),
    );
    expect(byKind(projected, "document")).toHaveLength(2);
    expect(memory.list({ includeSuperseded: true })).toHaveLength(6);
  });

  it("尊重 event 的显式 path/storage/asset_kind，并不伪造问题 item 的事件 seq", () => {
    const memory = new AssetMemory("event-contract");
    const [explicit] = memory.ingestEvent({
      kind: "artifact.ready",
      seq: 30,
      name: "无扩展名视觉稿",
      path: "exports/custom/visual.png",
      asset_kind: "image",
    });
    const [exported] = memory.ingestEvent({
      kind: "export.ready",
      seq: 31,
      name: "访谈清单.xlsx",
      storage: "exports",
    });
    const questions = memory.ingestEvent({
      kind: "prompts.ready",
      seq: 32,
      questions: [{ text: "预算谁审批？" }, { text: "采购谁执行？" }],
    });

    expect(explicit).toMatchObject({ kind: "image", path: "exports/custom/visual.png" });
    expect(exported).toMatchObject({ kind: "document", path: "exports/访谈清单.xlsx" });
    expect(questions).toHaveLength(3);
    expect(questions.every((row) => row.sessionRef.eventSeq === 32)).toBe(true);
    expect(memory.resolveReference("预算谁审批的问题").asset).toMatchObject({ kind: "question" });
  });
});
