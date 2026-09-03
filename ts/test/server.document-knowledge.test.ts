import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DocumentAclController,
  DocumentNotFoundOrForbidden,
  MemoryDocumentAclRepository,
} from "../src/document/acl.js";
import { MemoryDocumentSecurityAuditRepository } from "../src/document/audit.js";
import { diffDocumentVersions, type DocumentVersionDiff } from "../src/document/diff.js";
import type { DocumentRepository } from "../src/document/repository.js";
import { DocumentService } from "../src/document/service.js";
import type { DocumentOpenResult, StoredDocumentVersion } from "../src/document/types.js";
import { MemoryWikiPageRepository } from "../src/document/wiki_repository.js";
import { WikiPageService } from "../src/document/wiki_service.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";
import {
  registerDocumentKnowledgeRoutes,
  type DocumentDiffPort,
  type DocumentKnowledgeRouteSession,
} from "../src/server/routes/document-knowledge.js";
import { stubProjectDirectory } from "./helpers/project_directory.js";

function parsed(versionId: string, text: string): ParsedDoc {
  const doc = makeParsedDoc({ fileId: versionId, fileName: "采购规则.md", kind: "text" });
  doc.chunks = [makeChunk({
    docId: "rule",
    fileId: versionId,
    fileName: doc.file_name,
    locator: { paragraph: 1, _version_id: versionId },
    render: text,
    raw: { text },
    order: 0,
    tags: ["rule"],
  })];
  doc.structured = {
    tables: [{
      name: "采购规则表",
      internal_note: `不应越过 HTTP 边界：${text}`,
      columns: [{ name: "amount_limit", description: text }],
    }],
  };
  return doc;
}

const DIFF = diffDocumentVersions(
  { documentId: "doc1", versionId: "v1", versionNo: 1, parsedDoc: parsed("v1", "金额上限 100") },
  { documentId: "doc1", versionId: "v2", versionNo: 2, parsedDoc: parsed("v2", "金额上限 200") },
);

function evidenceRef(documentId: string, versionId: string, chunkId: string): string {
  const enc = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
  return `odoc.v1.${enc(documentId)}.${enc(versionId)}.${enc(chunkId)}`;
}

const EVIDENCE = evidenceRef("doc1", "v1", "v1:rule");

class FakeDocuments implements DocumentDiffPort {
  readonly calls: unknown[][] = [];
  error: Error | null = null;
  openText = "金额上限 100";
  adoptedVersionId = "v1";

  async list(): Promise<readonly { id: string; adoptedVersionId: string | null }[]> {
    return [{ id: "doc1", adoptedVersionId: this.adoptedVersionId }];
  }

  async versionDiff(...args: Parameters<DocumentDiffPort["versionDiff"]>): Promise<DocumentVersionDiff> {
    this.calls.push(args);
    if (this.error !== null) throw this.error;
    return DIFF;
  }

  async open(
    scope: { projectId: string; owner: string },
    input: { evidenceRef: string },
  ): Promise<DocumentOpenResult> {
    if (scope.projectId !== "p1" || scope.owner !== "u1" || input.evidenceRef !== EVIDENCE) {
      throw new DocumentNotFoundOrForbidden();
    }
    return {
      evidenceRef: EVIDENCE,
      displayCite: "采购规则（v1，paragraph=1）",
      level: "project" as const,
      documentId: "doc1",
      versionId: "v1",
      versionNo: 1,
      documentTitle: "采购规则",
      fileName: "采购规则.md",
      chunkId: "v1:rule",
      locator: { paragraph: 1 },
      text: this.openText,
      textSha256: "a".repeat(64),
      score: 1,
      coverage: { matchedTerms: [], missingTerms: [], queryTerms: 0, ratio: 1 },
      raw: { text: "金额上限 100" },
      context: "",
      tags: ["rule"],
    };
  }
}

function tickingClock(): () => string {
  let second = 0;
  return () => new Date(Date.UTC(2026, 8, 2, 10, 0, second++)).toISOString();
}

let app: Hono<AppEnv>;
let actor: RequestUser;
let documents: FakeDocuments;
let wiki: WikiPageService;
let sessions: Map<string, DocumentKnowledgeRouteSession>;

beforeEach(() => {
  actor = { id: "u1", role: "user" };
  documents = new FakeDocuments();
  wiki = new WikiPageService(new MemoryWikiPageRepository(), tickingClock());
  sessions = new Map([["s1", {
    id: "s1",
    projectId: "p1",
    owner: "u1",
    state: {
      answers: [{ id: "answer1", evidence_ref: EVIDENCE }],
      _document_manifest: [{
        project_id: "p1",
        document_id: "doc1",
        version_id: "v1",
        sha256: "a".repeat(64),
        index_revision: "idx1",
        acl_revision: 1,
        title: "采购规则",
        file_name: "采购规则.md",
        version_no: 1,
        parse_status: "ready",
        parser_version: "1",
      }],
      _oir: { id: "oir1", document_id: "doc1", version_id: "v1" },
    },
  }]]);
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", actor);
    await next();
  });
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  });
  registerDocumentKnowledgeRoutes(app, {
    documents,
    wiki,
    projects: stubProjectDirectory(),
    sessionById: async (sid) => {
      const session = sessions.get(sid);
      if (session === undefined) throw new HTTPException(404, { message: "没有这个会话" });
      return session;
    },
  });
});

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function jsonRequest(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

describe("OntoDocument diff 与 impact 路由", () => {
  it("只返回确定性差异投影，并从鉴权会话派生比较边界", async () => {
    const response = await app.request(
      "/api/sessions/s1/documents/doc1/diff?from_version_id=v1&to_version_id=v2",
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.diff).toMatchObject({
      document_id: "doc1",
      from_version_id: "v1",
      to_version_id: "v2",
      summary: { chunks: { modified: 1 } },
      has_changes: true,
    });
    expect(payload.diff.changes.chunks).toHaveLength(1);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("parsedDoc");
    expect(serialized).not.toContain("parsed_doc");
    expect(serialized).not.toContain('"raw"');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"definition"');
    expect(serialized).not.toContain("不应越过 HTTP 边界");
    expect(payload.diff.changes.fields[0]).toMatchObject({
      before: { name: "amount_limit", fingerprint: expect.any(String) },
      after: { name: "amount_limit", fingerprint: expect.any(String) },
    });
    expect(documents.calls).toEqual([[{ projectId: "p1", owner: "u1", actorId: "u1" }, "doc1", "v1", "v2"]]);
  });

  it("ACL 无权与不存在统一为 404，且拒绝 query 覆盖 owner/project/path", async () => {
    documents.error = new DocumentNotFoundOrForbidden();
    const denied = await app.request(
      "/api/sessions/s1/documents/doc1/diff?from_version_id=v1&to_version_id=v2",
    );
    expect(denied.status).toBe(404);

    documents.calls.splice(0);
    const injected = await app.request(
      "/api/sessions/s1/documents/doc1/diff?from_version_id=v1&to_version_id=v2&owner=u2",
    );
    expect(injected.status).toBe(400);
    expect(documents.calls).toHaveLength(0);
  });

  it("从回答、固定 manifest、模型状态和项目 Wiki 反查依赖，但不自动改任何产物", async () => {
    await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "impact-page",
      title: "采购规则",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "MATERIAL_FACT",
        subject: "金额上限",
        statement: "当前上限来自旧版材料",
        evidenceRefs: [EVIDENCE],
      }],
    });
    const stateBefore = JSON.stringify(sessions.get("s1")!.state);
    const wikiBefore = await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "impact-page");

    const response = await app.request(
      "/api/sessions/s1/documents/doc1/impact?from_version_id=v1&to_version_id=v2",
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    const kinds = new Set(payload.impact.consumers.map((item: any) => item.consumerKind));
    expect(kinds).toEqual(new Set(["answer", "manifest", "model_artifact", "wiki_claim"]));
    expect(payload.impact.stale_candidates.length).toBeGreaterThanOrEqual(4);
    expect(payload.impact.notice).toContain("不会自动修改");
    expect(JSON.stringify(sessions.get("s1")!.state)).toBe(stateBefore);
    await expect(wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "impact-page"))
      .resolves.toEqual(wikiBefore);
  });
});

describe("DocumentService 版本差异 ACL", () => {
  function version(id: string, number: number, text: string): StoredDocumentVersion {
    return {
      id,
      documentId: "doc1",
      versionNo: number,
      fileName: "采购规则.md",
      mediaType: "text/markdown",
      sizeBytes: text.length,
      sha256: id === "v1" ? "1".repeat(64) : "2".repeat(64),
      relPath: `projects/p1/documents/doc1/${id}/original/采购规则.md`,
      docKind: "text",
      parseStatus: "ready",
      parserName: "text",
      parserVersion: "1",
      indexRevision: `idx-${id}`,
      chunkCount: 1,
      createdBy: "u1",
      createdAt: `2026-09-02T10:00:0${number}.000Z`,
      parsedDoc: parsed(id, text),
    };
  }

  function serviceHarness(): {
    readonly service: DocumentService;
    readonly acl: DocumentAclController;
    readonly audit: MemoryDocumentSecurityAuditRepository;
    readonly loads: string[];
  } {
    const audit = new MemoryDocumentSecurityAuditRepository();
    let event = 0;
    const acl = new DocumentAclController(
      new MemoryDocumentAclRepository(audit),
      audit,
      () => `diff_audit_${++event}`,
      () => "2026-09-02T10:00:00.000Z",
    );
    const loads: string[] = [];
    const versions = new Map([
      ["v1", version("v1", 1, "金额上限 100")],
      ["v2", version("v2", 2, "金额上限 200")],
    ]);
    const repository = {
      async getVersion(_scope: unknown, documentId: string, versionId: string) {
        loads.push(`${documentId}/${versionId}`);
        return versions.get(versionId) ?? null;
      },
    } as unknown as DocumentRepository;
    return {
      service: new DocumentService({ repository, workspaceRoot: ".", acl }),
      acl,
      audit,
      loads,
    };
  }

  it("from/to 即使属于同一文档也各自重新做 version.read，且不外泄 ParsedDoc", async () => {
    const { service, audit, loads } = serviceHarness();
    const scope = { projectId: "p1", owner: "u1", actorId: "u1" };
    const result = await service.versionDiff(scope, "doc1", "v1", "v2");

    expect(loads).toEqual(["doc1/v1", "doc1/v2"]);
    const reads = (await audit.list(scope, 20)).filter((event) => event.action === "version.read");
    expect(reads.map((event) => event.versionId).sort()).toEqual(["v1", "v1", "v2", "v2"]);
    expect(JSON.stringify(result)).not.toContain("parsedDoc");
  });

  it("任一精确版本被 deny 时不读取该版本，也不借另一个版本的授权票据", async () => {
    const { service, acl, loads } = serviceHarness();
    const scope = { projectId: "p1", owner: "u1", actorId: "u1" };
    await acl.replaceRules({ id: "u1", groupIds: [] }, {
      boundary: scope,
      expectedRevision: 0,
      rules: [{
        id: "deny-v2",
        subject: { type: "principal", id: "u1" },
        effect: "deny",
        permission: "read",
        resource: { scopeType: "version", documentId: "doc1", versionId: "v2" },
      }],
    });

    await expect(service.versionDiff(scope, "doc1", "v1", "v2"))
      .rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(loads).not.toContain("doc1/v2");
  });
});

describe("OntoDocument Wiki HTTP 边界", () => {
  it("请求体不能伪造 actor/project/owner/confirmed，合法声明只能先进入 draft", async () => {
    for (const payload of [
      { title: "坏页面", actor: { kind: "ai", id: "model" } },
      { title: "坏页面", project_id: "other" },
      { title: "坏页面", drafts: [{ kind: "MATERIAL_FACT", subject: "s", statement: "x", state: "confirmed" }] },
    ]) {
      const rejected = await app.request(
        "/api/sessions/s1/documents/wiki/pages",
        jsonRequest("POST", payload),
      );
      expect(rejected.status).toBe(400);
    }

    const created = await app.request(
      "/api/sessions/s1/documents/wiki/pages",
      jsonRequest("POST", {
        id: "page1",
        title: "采购规则",
        drafts: [{
          kind: "MATERIAL_FACT",
          subject: "金额",
          statement: "金额上限为 100",
          evidence_refs: [EVIDENCE],
        }],
      }),
    );
    expect(created.status).toBe(201);
    const payload = await body(created);
    expect(payload.page).toMatchObject({
      revision: 1,
      page: { id: "page1", claims: [{ state: "draft", author: { kind: "human", id: "u1" } }] },
    });
  });

  it("只有服务端派生的 human actor 能确认；每次修改都做 revision CAS", async () => {
    const created = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "cas-page",
      title: "CAS",
      actor: { kind: "human", id: "u1" },
      drafts: [{ kind: "INFERENCE", subject: "结论", statement: "待确认", evidenceRefs: [EVIDENCE] }],
    });
    const claimId = created.page.claims[0]!.id;

    const forged = await app.request(
      `/api/sessions/s1/documents/wiki/pages/cas-page/claims/${claimId}/confirm`,
      jsonRequest("POST", {
        expected_revision: 1,
        evidence_refs: [EVIDENCE],
        actor: { kind: "ai", id: "model" },
      }),
    );
    expect(forged.status).toBe(400);

    const confirmed = await app.request(
      `/api/sessions/s1/documents/wiki/pages/cas-page/claims/${claimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );
    expect(confirmed.status).toBe(200);
    const confirmedBody = await body(confirmed);
    expect(confirmedBody.page).toMatchObject({
      revision: 2,
      page: { claims: [{ state: "confirmed", confirmation: { actor: { kind: "human", id: "u1" } } }] },
    });

    const stale = await app.request(
      "/api/sessions/s1/documents/wiki/pages/cas-page",
      jsonRequest("PATCH", { expected_revision: 1, title: "不应覆盖" }),
    );
    expect(stale.status).toBe(409);
    const current = await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "cas-page");
    expect(current.page.title).toBe("CAS");
    expect(current.revision).toBe(2);
  });

  it("伪造或当前无权打开的 evidence_ref 不能把 Wiki 草稿升级为已确认", async () => {
    const created = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "grounded-confirm",
      title: "证据门禁",
      actor: { kind: "human", id: "u1" },
      drafts: [{ kind: "MATERIAL_FACT", subject: "金额", statement: "上限为 100" }],
    });
    const claimId = created.page.claims[0]!.id;
    for (const ref of ["随便写的依据", evidenceRef("doc1", "v1", "missing")]) {
      const response = await app.request(
        `/api/sessions/s1/documents/wiki/pages/grounded-confirm/claims/${claimId}/confirm`,
        jsonRequest("POST", { expected_revision: 1, evidence_refs: [ref] }),
      );
      expect([400, 404]).toContain(response.status);
    }
    const current = await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "grounded-confirm");
    expect(current.revision).toBe(1);
    expect(current.page.claims[0]!.state).toBe("draft");
  });

  it("材料事实必须被原文支持；真人决定可引用材料背景但不会伪装成材料事实", async () => {
    const supportedMaterial = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "supported-material",
      title: "有原文支持的事实",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "MATERIAL_FACT",
        subject: "金额上限",
        statement: "金额上限为 100",
      }],
    });
    const supportedClaimId = supportedMaterial.page.claims[0]!.id;
    const accepted = await app.request(
      `/api/sessions/s1/documents/wiki/pages/supported-material/claims/${supportedClaimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );
    expect(accepted.status).toBe(200);
    expect((await body(accepted)).page.page.claims[0]).toMatchObject({
      kind: "MATERIAL_FACT",
      state: "confirmed",
    });

    const material = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "material-support",
      title: "事实证据门禁",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "MATERIAL_FACT",
        subject: "合同审批",
        statement: "合同必须由董事会审批",
      }],
    });
    const materialClaimId = material.page.claims[0]!.id;
    const rejected = await app.request(
      `/api/sessions/s1/documents/wiki/pages/material-support/claims/${materialClaimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );
    expect(rejected.status).toBe(422);
    expect((await body(rejected)).detail).toContain("没有直接证明");
    expect((await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "material-support")))
      .toMatchObject({ revision: 1, page: { claims: [{ state: "draft" }] } });

    const decision = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "human-decision",
      title: "人工决定",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "HUMAN_DECISION",
        subject: "合同审批",
        statement: "合同必须由董事会审批",
      }],
    });
    const decisionClaimId = decision.page.claims[0]!.id;
    const confirmed = await app.request(
      `/api/sessions/s1/documents/wiki/pages/human-decision/claims/${decisionClaimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );
    expect(confirmed.status).toBe(200);
    expect((await body(confirmed)).page.page.claims[0]).toMatchObject({
      kind: "HUMAN_DECISION",
      state: "confirmed",
      confirmation: { actor: { kind: "human", id: "u1" }, evidence_refs: [EVIDENCE] },
    });
  });

  it("真实引用里的错误示例、旧规则或未确认问句不能确认 MATERIAL_FACT", async () => {
    const page = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "unsupported-context",
      title: "语境证据门禁",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "MATERIAL_FACT",
        subject: "合同审批",
        statement: "合同必须由董事会审批",
      }],
    });
    const claimId = page.page.claims[0]!.id;
    documents.openText = "培训材料举例：“合同必须由董事会审批”是错误答案。";

    const rejected = await app.request(
      `/api/sessions/s1/documents/wiki/pages/unsupported-context/claims/${claimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );
    expect(rejected.status).toBe(422);
    expect((await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "unsupported-context")))
      .toMatchObject({ revision: 1, page: { claims: [{ state: "draft" }] } });
  });

  it("可打开但未被项目采用的旧版本不能确认 MATERIAL_FACT", async () => {
    const page = await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "unadopted-evidence",
      title: "采用版本门禁",
      actor: { kind: "human", id: "u1" },
      drafts: [{
        kind: "MATERIAL_FACT",
        subject: "金额上限",
        statement: "金额上限为 100",
      }],
    });
    documents.adoptedVersionId = "v2";
    const claimId = page.page.claims[0]!.id;

    const rejected = await app.request(
      `/api/sessions/s1/documents/wiki/pages/unadopted-evidence/claims/${claimId}/confirm`,
      jsonRequest("POST", { expected_revision: 1, evidence_refs: [EVIDENCE] }),
    );

    expect(rejected.status).toBe(422);
    expect((await wiki.getPage({ projectId: "p1", owner: "u1", actorId: "u1" }, "unadopted-evidence")))
      .toMatchObject({ revision: 1, page: { claims: [{ state: "draft" }] } });
  });

  it("支持归档、恢复、历史和安全下载；永远不接受客户端文件路径", async () => {
    await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "export-page",
      title: "导出页面",
      actor: { kind: "human", id: "u1" },
    });
    const archived = await app.request(
      "/api/sessions/s1/documents/wiki/pages/export-page/archive",
      jsonRequest("POST", { expected_revision: 1 }),
    );
    expect(archived.status).toBe(200);
    expect((await body(archived)).page.status).toBe("archived");

    const activeList = await body(await app.request("/api/sessions/s1/documents/wiki/pages"));
    expect(activeList.pages).toHaveLength(0);
    const restored = await app.request(
      "/api/sessions/s1/documents/wiki/pages/export-page/restore",
      jsonRequest("POST", { expected_revision: 2 }),
    );
    expect(restored.status).toBe(200);
    const history = await body(await app.request(
      "/api/sessions/s1/documents/wiki/pages/export-page/history",
    ));
    expect(history.revisions.map((item: any) => item.action)).toEqual(["create", "archive", "restore"]);

    const markdown = await app.request(
      "/api/sessions/s1/documents/wiki/pages/export-page/export.md",
    );
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-disposition")).toContain("attachment");
    expect(await markdown.text()).toContain("# 导出页面");

    const rejectedPath = await app.request(
      "/api/sessions/s1/documents/wiki/export/obsidian.zip?path=/tmp/out",
    );
    expect(rejectedPath.status).toBe(400);
    const zip = await app.request("/api/sessions/s1/documents/wiki/export/obsidian.zip");
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toContain("application/zip");
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it("其他账号不能借当前 session id 查看项目 Wiki", async () => {
    await wiki.createPage({ projectId: "p1", owner: "u1", actorId: "u1" }, {
      id: "private-page",
      title: "私有页面",
      actor: { kind: "human", id: "u1" },
    });
    actor = { id: "u2", role: "user" };
    const response = await app.request("/api/sessions/s1/documents/wiki/pages/private-page");
    expect(response.status).toBe(404);
  });
});
