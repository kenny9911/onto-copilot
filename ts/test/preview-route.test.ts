/** 统一预览路由：格式能力、live graph 与路径边界。 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequire } from "node:module";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Question, QuestionBacklog } from "../src/onto/questions.js";
import type { AppEnv } from "../src/server/app.js";
import { setRepoForTests } from "../src/store/deps.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeFileRow, makeSessionRow } from "../src/store/types.js";

const ExcelJS = createRequire(import.meta.url)("exceljs") as typeof import("exceljs");

const { PREVIEW_SHEET_HARD_ROWS, PREVIEW_SHEET_ROWS } = await import("../src/server/routes/preview.js");

const ROOT = join(tmpdir(), `ontocopilot-preview-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Session, SESSIONS, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);
const {
  PREVIEW_SCHEMA_VERSION,
  registerPreviewRoutes,
} = await import("../src/server/routes/preview.js");
type SessionT = InstanceType<typeof Session>;

let repo: MemoryRepo;
let app: Hono<AppEnv>;

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
  registerHydrator(async (sid: string) => {
    throw new HTTPException(404, { message: `没有会话 ${sid}` });
  });
});

afterAll(() => {
  registerHydrator(null);
  setRepoForTests(null);
  SESSIONS.clear();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  repo = new MemoryRepo();
  setRepoForTests(repo);
  SESSIONS.clear();
  app = new Hono<AppEnv>();
  app.onError((error) => {
    if (error instanceof HTTPException) {
      if (error.res !== undefined) return error.getResponse();
      return Response.json({ detail: error.message }, { status: error.status });
    }
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, {
      status: 500,
    });
  });
  registerPreviewRoutes(app);
});

async function makeSession(id: string): Promise<SessionT> {
  await repo.createSession(makeSessionRow({ id, title: "预览会话", status: "done" }));
  const s = new Session(id, { title: "预览会话", status: "done" });
  SESSIONS.set(id, s);
  mkdirSync(join(s.dir, "materials"), { recursive: true });
  return s;
}

function addArtifact(s: SessionT, name: string, body: string | Uint8Array): void {
  writeFileSync(join(s.dir, name), body);
  const artifacts = Array.isArray(s.state["artifacts"])
    ? s.state["artifacts"] as string[]
    : [];
  s.state["artifacts"] = [...artifacts, name];
}

async function addMaterial(s: SessionT, name: string, body: string | Uint8Array): Promise<void> {
  writeFileSync(join(s.dir, "materials", name), body);
  const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
  await repo.addFiles(s.id, [makeFileRow({
    name,
    rel_path: `${s.id}/materials/${name}`,
    size: bytes,
    sha256: "sha",
  })]);
}

function pngHeader(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  return bytes;
}

function assertion(value: unknown, evidence: readonly unknown[] = [], origin = "extracted") {
  return { value, origin, confidence: origin === "inferred" ? 0.4 : 0.9, evidence };
}

describe("GET /api/sessions/:sid/preview", () => {
  it("PNG 只通过白名单内嵌流返回，并带防嗅探与 sandbox 头", async () => {
    const s = await makeSession("preview-png");
    addArtifact(s, "流程图.png", pngHeader());

    const metadata = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("流程图.png")}`,
    );
    expect(metadata.status).toBe(200);
    const body = await metadata.json() as Record<string, any>;
    expect(body).toMatchObject({
      schemaVersion: PREVIEW_SCHEMA_VERSION,
      target: { source: "artifact", name: "流程图.png", format: "png", mediaType: "image/png" },
      previewKind: "image",
      capabilities: { inline: true, parsed: true, zoom: true, download: true },
      downloadUrl: `/api/sessions/${s.id}/artifacts/${encodeURIComponent("流程图.png")}`,
    });
    expect(body.inlineUrl).toContain("/preview/content?");

    const inline = await app.request(body.inlineUrl);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toBe("inline");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inline.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(pngHeader());
  });

  it("安全 SVG 可内嵌；含脚本的 SVG 明确降级且 content 路由拒绝", async () => {
    const s = await makeSession("preview-svg");
    addArtifact(s, "安全.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    addArtifact(s, "危险.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const safe = await (await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("安全.svg")}`,
    )).json() as Record<string, any>;
    expect(safe.capabilities.inline).toBe(true);
    const inline = await app.request(safe.inlineUrl);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/svg+xml");

    const unsafe = await (await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("危险.svg")}`,
    )).json() as Record<string, any>;
    expect(unsafe).toMatchObject({
      previewKind: "image",
      capabilities: { inline: false, parsed: false },
      inlineUrl: "",
    });
    expect(unsafe.notice).toContain("可执行");
    const rejected = await app.request(
      `/api/sessions/${s.id}/preview/content?source=artifact&name=${encodeURIComponent("危险.svg")}`,
    );
    expect(rejected.status).toBe(415);
  });

  it("Markdown 与 JSON 只返回原文/结构，不在后端生成 HTML", async () => {
    const s = await makeSession("preview-text");
    addArtifact(s, "说明.md", "# 交付说明\n\n<script>不能作为 HTML 执行</script>");
    addArtifact(s, "ontology.package.json", JSON.stringify({ actions: [{ id: "act-1" }] }));

    const markdown = await (await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("说明.md")}`,
    )).json() as Record<string, any>;
    expect(markdown).toMatchObject({
      previewKind: "markdown",
      capabilities: { inline: true, parsed: true, search: true },
      data: { text: expect.stringContaining("<script>") },
    });
    expect(markdown.data).not.toHaveProperty("html");

    const json = await (await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("ontology.package.json")}`,
    )).json() as Record<string, any>;
    expect(json).toMatchObject({
      previewKind: "json",
      capabilities: { parsed: true },
      data: { value: { actions: [{ id: "act-1" }] } },
    });
  });

  it("材料 Excel/DOCX 复用现有切片；无切片产物明确为仅下载能力", async () => {
    const s = await makeSession("preview-office");
    await addMaterial(s, "实体梳理.xlsx", "not-read-by-preview");
    await addMaterial(s, "采购流程.docx", "not-read-by-preview");
    addArtifact(s, "模板_v1.xlsx", "system-generated-placeholder");
    s.state["_chunks"] = {
      "实体梳理.xlsx": [
        {
          cite: "实体梳理.xlsx!对象!R2",
          text: "对象编码=PO | 对象名称=采购订单",
          tags: ["row"],
          locator: { kind: "range", sheet: "对象", rows: [2, 2] },
        },
      ],
      "采购流程.docx": [
        {
          cite: "采购流程.docx#审批",
          text: "采购订单提交后需要负责人审批。",
          tags: ["rule"],
          locator: { kind: "section", section: "审批流程" },
        },
      ],
    };

    const excel = await (await app.request(
      `/api/sessions/${s.id}/preview?source=material&name=${encodeURIComponent("实体梳理.xlsx")}`,
    )).json() as Record<string, any>;
    expect(excel).toMatchObject({
      previewKind: "spreadsheet",
      capabilities: { inline: true, parsed: true, search: true, sourceSlices: true },
      downloadUrl: "",
      data: {
        chunks: 1,
        groups: [{
          name: "对象",
          rows: [{ cells: { 对象编码: "PO", 对象名称: "采购订单" } }],
        }],
      },
    });

    const docx = await (await app.request(
      `/api/sessions/${s.id}/preview?source=material&name=${encodeURIComponent("采购流程.docx")}`,
    )).json() as Record<string, any>;
    expect(docx).toMatchObject({
      previewKind: "document",
      capabilities: { inline: true, parsed: true },
      data: { groups: [{ name: "审批流程" }] },
    });

    const artifact = await (await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("模板_v1.xlsx")}`,
    )).json() as Record<string, any>;
    expect(artifact).toMatchObject({
      previewKind: "spreadsheet",
      capabilities: { inline: false, parsed: false, download: true },
      data: { groups: [], chunks: 0 },
    });
    expect(artifact.notice).toContain("不会在 GET 中重跑解析");
  });

  it("live graph 复用 context item，暴露 Workflow/Action/Event、证据与问题引用", async () => {
    const s = await makeSession("preview-graph");
    const evidence = {
      file_id: "f1",
      file_name: "流程说明.docx",
      locator: { section: "审批" },
      snippet: "提交后触发审批",
      cite: "流程说明.docx#审批",
      extractor: "document",
      confidence: 0.9,
    };
    const bag = new QuestionBacklog();
    bag.add(new Question({
      id: "q-node",
      text: "审批失败后如何处理？",
      scopeRefs: ["node-submit", "act-submit"],
      createdAt: 1,
      updatedAt: 1,
    }), { preserveLifecycle: false });
    s.state["question_backlog"] = bag.toDict();
    s.state["oir"] = {
      objects: [], properties: [], links: [], rules: [], questions: [],
      actions: [{
        rid: "act-submit",
        kind: "ActionType",
        apiName: assertion("submitOrder", [evidence]),
        appliesTo: [],
        parameters: assertion([], [evidence]),
        effects: assertion(["触发审批"], [evidence]),
        sourceEndpoint: assertion(null, [], "inferred"),
        status: "proposed",
      }],
      stats: {},
    };
    s.state["flow"] = {
      provenance: "generic",
      stages: [{ key: "approval", title: "审批", order: 1 }],
      workflows: [{
        key: "wf-order",
        title: "订单审批",
        entry: "node-submit",
        exits: ["node-approved"],
        description: "提交到审批通过",
      }],
      nodes: [
        {
          rid: "node-submit",
          kind: "action",
          code: "ACT-ORDER-SUBMIT",
          label: assertion("提交订单", [evidence]),
          actor: assertion("采购员", [evidence]),
          stage: "approval",
          objects: [],
          endpoint: "",
          status: "proposed",
          grounded: true,
        },
        {
          rid: "node-approved",
          kind: "event",
          code: "EVT-ORDER-APPROVED",
          label: assertion("订单已审批", [], "inferred"),
          actor: assertion("", [], "inferred"),
          stage: "approval",
          objects: [],
          endpoint: "",
          status: "candidate",
          grounded: false,
        },
      ],
      edges: [{
        rid: "edge-1",
        from: "node-submit",
        to: "node-approved",
        kind: "flow",
        label: "通过",
        grounded: true,
        evidence: [evidence],
      }],
      stats: { actions: 1, events: 1, inferred_edges: 0 },
    };
    addArtifact(s, "流程图.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    const beforeState = JSON.stringify(s.state);
    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=model&name=flow`,
    );
    expect(response.status).toBe(200);
    const graph = await response.json() as Record<string, any>;
    expect(graph).toMatchObject({
      previewKind: "graph",
      capabilities: { inline: true, parsed: true, search: true, zoom: true, download: true },
      data: {
        provenance: { kind: "generic", grounded: false, draft: true },
        nodeCounts: { action: 1, event: 1, total: 2 },
        workflows: [{ id: "wf-order", title: "订单审批" }],
        ontologyActions: [{ id: "act-submit", type: "action", label: "submitOrder" }],
        events: [{ id: "node-approved", type: "event", label: "订单已审批" }],
      },
    });
    expect(graph.data.nodes.find((node: any) => node.id === "node-submit")).toMatchObject({
      type: "action",
      label: "提交订单",
      grounded: true,
      questionIds: ["q-node"],
    });
    expect(graph.data.nodes.find((node: any) => node.id === "node-submit").evidenceIds).toHaveLength(1);
    expect(graph.data.edges[0]).toMatchObject({
      source: "node-submit",
      target: "node-approved",
      type: "flow",
      grounded: true,
      evidence: [{ fileName: "流程说明.docx", cite: "流程说明.docx#审批" }],
    });
    expect(graph.data.questionIds).toContain("q-node");
    expect(graph.data.relatedArtifacts[0]).toMatchObject({ name: "流程图.svg", format: "svg" });
    // 预览复用 read model，但不持久化/回写任何 graph projection。
    expect(JSON.stringify(s.state)).toBe(beforeState);
  });

  it("即使 artifact 索引被污染，路径穿越与非白名单文件仍不可读", async () => {
    const s = await makeSession("preview-boundary");
    writeFileSync(join(ROOT, "secret.png"), pngHeader());
    s.state["artifacts"] = ["../secret.png"];

    const traversal = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("../secret.png")}`,
    );
    expect(traversal.status).toBe(404);

    writeFileSync(join(s.dir, "not-indexed.png"), pngHeader());
    const unlisted = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=not-indexed.png`,
    );
    expect(unlisted.status).toBe(404);
  });

  it("我们自己生成的 xlsx 产物能直接解析出表（它永远没有材料解析切片）", async () => {
    // 2026-08-25 用户截图：交付页的 `数据字典.xlsx` 打不开预览。原因是
    // spreadsheet 分支只认 `_chunks[file.name]` —— 那是**材料**解析出来的切片，
    // 我们自己生成的产物一条都不会有，于是永远回落成「只能下载」。
    // 读一个自己刚写出来的 xlsx 是确定性的、零模型的，本来就该当场读。
    const s = await makeSession("preview-xlsx-artifact");
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("字段");
    sheet.addRow(["表", "字段", "类型"]);
    sheet.addRow(["采购订单", "orderNo", "string"]);
    sheet.addRow(["采购订单", "amount", "number"]);
    addArtifact(s, "数据字典.xlsx", new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer));

    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("数据字典.xlsx")}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.previewKind).toBe("spreadsheet");
    expect(body.capabilities.inline).toBe(true);
    expect(body.notice).toBe("");
    const group = body.data.groups[0];
    expect(group.name).toBe("字段");
    expect(group.rows[0].cells).toEqual({ "表": "采购订单", "字段": "orderNo", "类型": "string" });
    expect(group.rows).toHaveLength(2); // 表头行不当数据行
  });

  it("csv 产物同样当场读成表", async () => {
    const s = await makeSession("preview-csv-artifact");
    addArtifact(s, "覆盖率.csv", "对象,字段数\n采购订单,12\n供应商,7\n");
    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("覆盖率.csv")}`,
    );
    const body = await response.json() as any;
    expect(body.previewKind).toBe("spreadsheet");
    expect(body.data.groups[0].rows.map((r: any) => r.cells)).toEqual([
      { "对象": "采购订单", "字段数": "12" },
      { "对象": "供应商", "字段数": "7" },
    ]);
  });

  it("有解析切片时仍然优先用切片（引文能点回原文，直读没有这个）", async () => {
    const s = await makeSession("preview-xlsx-chunks");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["a"]);
    await addMaterial(s, "材料.xlsx", new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer));
    s.state["_chunks"] = {
      "材料.xlsx": [{ text: "订单编号: PO-1", cite: "材料.xlsx!S!R2C1", locator: { sheet: "S" }, tags: [] }],
    };
    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=material&name=${encodeURIComponent("材料.xlsx")}`,
    );
    const body = await response.json() as any;
    expect(body.data.groups[0].rows[0].cite).toBe("材料.xlsx!S!R2C1");
  });

  it("超过直读上限的表格：说清楚是「太大」，不是含糊的「没有切片」", async () => {
    // 直读是同步的，Node 是单线程 —— 实测 308K 的 xlsx 要 92ms，线性外推 8MB
    // 就是两秒多的事件循环阻塞，那两秒里所有人的请求都在排队。所以设上限；
    // 但超限时要说出真实原因，否则用户以为是「没解析」而去重跑解析。
    const s = await makeSession("preview-xlsx-huge");
    addArtifact(s, "巨表.csv", "a,b\n1,2\n");
    const { PREVIEW_SHEET_BYTES } = await import("../src/server/routes/preview.js");
    expect(PREVIEW_SHEET_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);

    // 撑一个超限的产物：写足够大的内容
    addArtifact(s, "超大.csv", "x,y\n" + "1,2\n".repeat(PREVIEW_SHEET_BYTES / 4));
    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("超大.csv")}`,
    );
    const body = await response.json() as any;
    expect(body.capabilities.inline).toBe(false);
    expect(body.notice).toContain("太大");
    expect(body.capabilities.download).toBe(true);
  });

  it("行数超硬阈值 → 不直读（xlsx 是 ZIP，压缩字节根本挡不住解压后的规模）", async () => {
    // 2026-08-25 实测：1.91MB 的 xlsx（11 万行）解压后 readFile 吃 545MB RSS、
    // 阻塞 609ms；6 并发峰值 2GB。文件大小闸卡的是压缩后的字节，代价却按单元格数
    // 算 —— 量纲就不对。真正的闸必须按**行数**来，而且要在读的过程中就停。
    const s = await makeSession("preview-xlsx-rows");
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("大表");
    sheet.addRow(["a", "b"]);
    for (let i = 0; i < PREVIEW_SHEET_HARD_ROWS + 5; i++) sheet.addRow([i, "x"]);
    addArtifact(s, "行数超标.xlsx", new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer));

    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("行数超标.xlsx")}`,
    );
    const body = await response.json() as any;
    expect(body.capabilities.inline).toBe(false);
    expect(body.notice).toContain("太大");
    expect(body.capabilities.download).toBe(true);
  });

  it("行数在阈值内但超过展示上限：只读前 N 行，并说清楚共有多少行", async () => {
    const s = await makeSession("preview-xlsx-truncate");
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("中表");
    sheet.addRow(["序号"]);
    for (let i = 0; i < PREVIEW_SHEET_ROWS + 40; i++) sheet.addRow([i]);
    addArtifact(s, "要截断.xlsx", new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer));

    const response = await app.request(
      `/api/sessions/${s.id}/preview?source=artifact&name=${encodeURIComponent("要截断.xlsx")}`,
    );
    const body = await response.json() as any;
    expect(body.data.groups[0].rows).toHaveLength(PREVIEW_SHEET_ROWS);
    expect(body.data.truncated).toBe(true);
    expect(body.notice).toContain(String(PREVIEW_SHEET_ROWS));
  });

  it("沿用 session 的 404 与全局鉴权装配边界", async () => {
    const response = await app.request("/api/sessions/missing/preview?source=model&name=flow");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "没有会话 missing" });
  });
});
