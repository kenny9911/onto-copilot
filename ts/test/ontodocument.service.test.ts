import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DocumentAclController,
  MemoryDocumentAclRepository,
} from "../src/document/acl.js";
import { MemoryDocumentSecurityAuditRepository } from "../src/document/audit.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";
import { sha256Hex } from "../src/kernel/ids.js";
import { Store } from "../src/store/engine.js";
import {
  MemoryDocumentRepository,
  SqlDocumentRepository,
  type DocumentRepository,
} from "../src/document/repository.js";
import { DocumentService, type DocumentParser } from "../src/document/service.js";
import {
  DocumentConflict,
  DocumentError,
  type DocumentScope,
  type PromoteSessionFileInput,
  type SessionDocumentScope,
} from "../src/document/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TextFixtureParser implements DocumentParser {
  calls = 0;
  visionPending = false;

  async parse(path: string, opts: { readonly fileId: string }): Promise<ParsedDoc> {
    this.calls += 1;
    const text = await readFile(path, "utf8");
    const doc = makeParsedDoc({ fileId: opts.fileId, fileName: basename(path), kind: "text" });
    if (this.visionPending) {
      doc.findings.push({
        kind: "vision_pending",
        message: "需要视觉识别",
        locator: {},
        severity: "info",
      });
      return doc;
    }
    doc.chunks.push(
      makeChunk({
        docId: "body",
        fileId: opts.fileId,
        fileName: basename(path),
        locator: { section: "正文", line: 1 },
        render: text,
        raw: { text },
        order: 0,
        tags: ["body"],
      }),
    );
    doc.structured = { title: "fixture" };
    doc.meta = { parsed_by: "test" };
    return doc;
  }
}

interface Fixture {
  readonly root: string;
  readonly repo: DocumentRepository;
  readonly parser: TextFixtureParser;
  readonly service: DocumentService;
  readonly scope: DocumentScope;
  readonly session: SessionDocumentScope;
  write(name: string, text: string): PromoteSessionFileInput["source"];
}

function fixture(repo: DocumentRepository, acl?: DocumentAclController): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ontodocument-"));
  roots.push(root);
  const sessionId = "s_1";
  const materials = join(root, sessionId, "materials");
  mkdirSync(materials, { recursive: true });
  const parser = new TextFixtureParser();
  let id = 0;
  let tick = 0;
  const service = new DocumentService({
    repository: repo,
    workspaceRoot: root,
    parser,
    ...(acl === undefined ? {} : { acl }),
    newId: (kind) => `${kind === "document" ? "doc" : "ver"}_${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString(),
  });
  const scope = { projectId: "project_A", owner: "alice" };
  const session = { ...scope, sessionId };
  return {
    root,
    repo,
    parser,
    service,
    scope,
    session,
    write(name: string, text: string) {
      const path = join(materials, name);
      writeFileSync(path, text);
      const bytes = Buffer.from(text, "utf8");
      return {
        sessionId,
        name,
        relPath: relative(root, path),
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    },
  };
}

function secureFixture(): Fixture & {
  readonly acl: DocumentAclController;
  readonly audit: MemoryDocumentSecurityAuditRepository;
} {
  const audit = new MemoryDocumentSecurityAuditRepository();
  const acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
  return { ...fixture(new MemoryDocumentRepository(), acl), acl, audit };
}

async function promoteFirst(f: Fixture, text = "approved purchase amount is 100"): Promise<{
  documentId: string;
  versionId: string;
}> {
  const result = await f.service.promoteSessionFile(f.scope, {
    source: f.write("采购规则.txt", text),
    title: "采购规则",
    tags: ["采购", "规则"],
  });
  expect(result.deduplicated).toBe(false);
  expect(result.document.revision).toBe(1);
  expect(result.document.currentVersionId).toBe(result.version.id);
  expect(result.document.adoptedVersionId).toBe(result.version.id);
  expect(result.version.chunkCount).toBe(1);
  return { documentId: result.document.id, versionId: result.version.id };
}

describe("OntoDocument memory P0", () => {
  it("解析器失败也先保存不可变原件，并明确标成没有可核验证据", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const failing = new DocumentService({
      repository: f.repo,
      workspaceRoot: f.root,
      parser: { async parse() { throw new Error("暂不支持这种旧格式"); } },
      newId: (() => {
        let n = 0;
        return (kind: "document" | "version") => `${kind}_failed_${++n}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z",
    });
    const promoted = await failing.promoteSessionFile(f.scope, {
      source: f.write("历史流程.doc", "legacy-binary-placeholder"),
      title: "历史流程",
    });

    expect(promoted.version.parseStatus).toBe("degraded");
    expect(promoted.version.chunkCount).toBe(0);
    expect(await failing.search(f.scope, { query: "审批" })).toMatchObject({
      hits: [],
      searchedVersions: [promoted.version.id],
    });
    const loaded = await f.repo.getVersion(
      f.scope,
      promoted.document.id,
      promoted.version.id,
    );
    expect(loaded?.parsedDoc.findings).toEqual([
      expect.objectContaining({ kind: "parse_failed", severity: "warn" }),
    ]);
  });

  it("没有读到正文的图片类版本明确降级，搜索范围仍保留该精确版本", async () => {
    const f = fixture(new MemoryDocumentRepository());
    f.parser.visionPending = true;
    const promoted = await f.service.promoteSessionFile(f.scope, {
      source: f.write("扫描件.png", "not-real-image-fixture"),
      title: "扫描件",
    });

    expect(promoted.version.parseStatus).toBe("degraded");
    expect(promoted.version.chunkCount).toBe(0);
    const result = await f.service.search(f.scope, { query: "审批" });
    expect(result.hits).toEqual([]);
    expect(result.searchedVersions).toEqual([promoted.version.id]);
  });

  it("保存完整 ParsedDoc，追加不可变版本，不把新版本静默设为已采用", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const first = await promoteFirst(f);
    const second = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "draft purchase amount is 200"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    });

    expect(second.version.versionNo).toBe(2);
    expect(second.document.currentVersionId).toBe(second.version.id);
    expect(second.document.adoptedVersionId).toBe(first.versionId);
    expect(second.document.revision).toBe(2);
    const history = await f.service.history(f.scope, first.documentId);
    expect(history.map((v) => [v.versionNo, v.sha256])).toEqual([
      [2, second.version.sha256],
      [1, history[1]!.sha256],
    ]);
    const stored = await f.repo.getVersion(f.scope, first.documentId, second.version.id);
    expect(stored?.parsedDoc.structured).toEqual({ title: "fixture" });
    expect(stored?.parsedDoc.chunks[0]?.raw).toEqual({ text: "draft purchase amount is 200" });
  });

  it("baseVersionId 做 OCC；同文档相同 SHA 去重且不重复解析", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const first = await promoteFirst(f, "same bytes");
    const second = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "new bytes"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    });
    await expect(
      f.service.promoteSessionFile(f.scope, {
        source: f.write("采购规则.txt", "third bytes"),
        documentId: first.documentId,
        baseVersionId: first.versionId,
      }),
    ).rejects.toMatchObject({ code: "BASE_VERSION_CONFLICT" });

    const before = f.parser.calls;
    const duplicate = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "same bytes"),
      documentId: first.documentId,
      baseVersionId: second.version.id,
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.version.id).toBe(first.versionId);
    expect(duplicate.document.currentVersionId).toBe(second.version.id);
    expect(f.parser.calls).toBe(before);
    expect(await f.service.history(f.scope, first.documentId)).toHaveLength(2);
  });

  it("默认只搜索已采用版本，会话搜索只读精确挂载版本，并可用 evidence_ref 打开原文", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const first = await promoteFirst(f, "approved purchase amount 100");
    const second = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "draft quantum banana amount 200"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    });

    expect((await f.service.search(f.scope, { query: "quantum banana" })).hits).toHaveLength(0);
    await f.service.attach(f.scope, f.session, {
      documentId: first.documentId,
      versionId: second.version.id,
      role: "primary",
    });
    const attached = await f.service.search(f.scope, {
      query: "quantum banana",
      sessionId: f.session.sessionId,
    });
    expect(attached.hits).toHaveLength(1);
    expect(attached.hits[0]?.versionId).toBe(second.version.id);
    expect(attached.hits[0]?.coverage.ratio).toBe(1);
    const opened = await f.service.open(f.scope, { evidenceRef: attached.hits[0]!.evidenceRef });
    expect(opened.text).toBe("draft quantum banana amount 200");
    expect(opened.textSha256).toBe(sha256Hex(opened.text));
    expect(opened.locator).toEqual({ section: "正文", line: 1 });

    const bundle = await f.service.loadAttachedParsedDocs(f.session);
    expect(bundle.documents[0]?.chunks[0]?.render).toBe("draft quantum banana amount 200");
    expect(bundle.documents[0]?.file_name).toContain(`${first.documentId}@${second.version.id}`);
    expect(bundle.documents[0]?.chunks[0]?.locator).toMatchObject({
      _document_id: first.documentId,
      _version_id: second.version.id,
    });
    expect(bundle.manifest[0]).toMatchObject({
      project_id: f.scope.projectId,
      document_id: first.documentId,
      version_id: second.version.id,
      parse_status: "ready",
    });
    const detach = vi.spyOn(f.repo, "detach");
    await expect(f.service.detach(f.scope, f.session, first.documentId)).resolves.toBe(true);
    expect(detach).toHaveBeenCalledWith(
      f.scope,
      f.session,
      first.documentId,
      second.version.id,
    );
    expect(await f.repo.listAttachments(f.scope, f.session)).toEqual([]);
  });

  it("metadata/adopt/archive 都用 revision；归档后默认检索消失但固定挂载仍可重放", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const first = await promoteFirst(f);
    const second = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "new adopted fact"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    });
    const renamed = await f.service.updateMetadata(f.scope, first.documentId, {
      expectedRevision: second.document.revision,
      title: "采购规则（已核对）",
      tags: ["已核对"],
    });
    await expect(
      f.service.adopt(f.scope, first.documentId, {
        versionId: second.version.id,
        expectedRevision: second.document.revision,
      }),
    ).rejects.toBeInstanceOf(DocumentConflict);
    const adopted = await f.service.adopt(f.scope, first.documentId, {
      versionId: second.version.id,
      expectedRevision: renamed.revision,
    });
    await f.service.attach(f.scope, f.session, {
      documentId: first.documentId,
      versionId: second.version.id,
    });
    const archived = await f.service.archive(f.scope, first.documentId, {
      archived: true,
      expectedRevision: adopted.revision,
    });
    expect((await f.service.list(f.scope)).length).toBe(0);
    expect((await f.service.list(f.scope, { includeArchived: true }))[0]?.status).toBe("archived");
    expect((await f.service.search(f.scope, { query: "new adopted" })).hits).toHaveLength(0);
    expect(
      (await f.service.search(f.scope, {
        query: "new adopted",
        sessionId: f.session.sessionId,
      })).hits,
    ).toHaveLength(1);
    expect(archived.revision).toBe(adopted.revision + 1);
  });

  it("owner/project 隔离覆盖 list/search/open/history，证据引用不能跨边界复用", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const first = await promoteFirst(f, "secret merger threshold");
    const result = await f.service.search(f.scope, { query: "secret merger" });
    const other = { projectId: f.scope.projectId, owner: "bob" };
    expect(await f.service.list(other)).toEqual([]);
    expect((await f.service.search(other, { query: "secret merger" })).hits).toEqual([]);
    await expect(f.service.history(other, first.documentId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.service.open(other, { evidenceRef: result.hits[0]!.evidenceRef }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("拒绝目录穿越、跨会话路径、SHA 不一致和非当前会话 scope", async () => {
    const f = fixture(new MemoryDocumentRepository());
    const valid = f.write("safe.txt", "trusted bytes");
    await expect(
      f.service.promoteSessionFile(f.scope, {
        source: { ...valid, relPath: "../secret.txt" },
      }),
    ).rejects.toBeInstanceOf(DocumentError);
    await expect(
      f.service.promoteSessionFile(f.scope, {
        source: { ...valid, sessionId: "another-session" },
      }),
    ).rejects.toBeInstanceOf(DocumentError);
    await expect(
      f.service.promoteSessionFile(f.scope, {
        source: { ...valid, sha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    await expect(
      f.service.attach(f.scope, { ...f.session, owner: "bob" }, {
        documentId: "doc_missing",
        versionId: "ver_missing",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("OntoDocument ACL production integration", () => {
  it("list/search 先生成精确版本白名单，拒绝文档不会进入 chunk 召回", async () => {
    const f = secureFixture();
    const allowed = await promoteFirst(f, "shared evidence allowed");
    const denied = await f.service.promoteSessionFile(f.scope, {
      source: f.write("供应商规则.txt", "shared evidence forbidden"),
      title: "供应商规则",
    });
    await f.service.replaceAclRules(f.scope, {
      expectedRevision: 0,
      rules: [{
        id: "deny_doc_read",
        subject: { type: "principal", id: "alice" },
        effect: "deny",
        permission: "read",
        resource: { scopeType: "document", documentId: denied.document.id },
      }],
    });

    expect((await f.service.list(f.scope)).map((document) => document.id)).toEqual([allowed.documentId]);
    const recall = vi.spyOn(f.repo, "chunksForSearch");
    const result = await f.service.search(f.scope, { query: "shared evidence" });
    expect(result.hits.map((hit) => hit.documentId)).toEqual([allowed.documentId]);
    expect(result.searchedVersions).toEqual([allowed.versionId]);
    expect(recall).toHaveBeenLastCalledWith(f.scope, { documentIds: [allowed.documentId] });

    const empty = await f.service.search(f.scope, {
      query: "shared evidence",
      documentIds: [denied.document.id],
    });
    expect(empty.hits).toEqual([]);
    expect(empty.searchedVersions).toEqual([]);
    // 这是关键防回退断言：空白名单仍传 []，不能省略 documentIds 后查整个项目。
    expect(recall).toHaveBeenLastCalledWith(f.scope, { documentIds: [] });
  });

  it("history/open/attach/Harness load 每次读取前重新鉴权，撤权立即生效", async () => {
    const f = secureFixture();
    const first = await promoteFirst(f, "revocable exact evidence");
    const evidence = (await f.service.search(f.scope, { query: "revocable exact" })).hits[0]!;
    await f.service.attach(f.scope, f.session, {
      documentId: first.documentId,
      versionId: first.versionId,
    });
    const originalDocumentRevision = (await f.repo.get(f.scope, first.documentId))!.revision;
    expect((await f.service.manifest(f.session))[0]?.acl_revision).toBe(0);
    await f.service.replaceAclRules(f.scope, {
      expectedRevision: 0,
      rules: [{
        id: "explicit_allow",
        subject: { type: "principal", id: "alice" },
        effect: "allow",
        permission: "read",
        resource: { scopeType: "document", documentId: first.documentId },
      }],
    });
    expect((await f.service.manifest(f.session))[0]?.acl_revision).toBe(1);
    expect((await f.service.loadAttachedParsedDocs(f.session)).manifest[0]?.acl_revision).toBe(1);
    expect((await f.repo.get(f.scope, first.documentId))!.revision).toBe(originalDocumentRevision);
    await f.service.replaceAclRules(f.scope, {
      expectedRevision: 1,
      rules: [{
        id: "deny_after_attach",
        subject: { type: "principal", id: "alice" },
        effect: "deny",
        permission: "read",
        resource: { scopeType: "document", documentId: first.documentId },
      }],
    });

    await expect(f.service.history(f.scope, first.documentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "没有找到这份项目文档",
    });
    await expect(f.service.history(f.scope, "doc_does_not_exist")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "没有找到这份项目文档",
    });
    await expect(f.service.open(f.scope, { evidenceRef: evidence.evidenceRef })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(f.service.attach(f.scope, f.session, {
      documentId: first.documentId,
      versionId: first.versionId,
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(f.service.detach(f.scope, f.session, first.documentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    // 无权时不能借 detach 改写会话关系；底层固定版本仍完整保留。
    expect(await f.repo.listAttachments(f.scope, f.session)).toMatchObject([{
      documentId: first.documentId,
      versionId: first.versionId,
    }]);
    expect(await f.service.listAttachments(f.scope, f.session)).toEqual([]);
    await expect(f.service.loadAttached(f.session)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });

    const audit = await f.service.securityAudit(f.scope, 100);
    expect(audit.some((event) => event.action === "chunk.read" && event.decision === "deny")).toBe(true);
    expect(audit.some((event) => event.action === "version.read" && event.decision === "deny")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("revocable exact evidence");
  });

  it("open 在正文加载后若权限被并发撤销，返回前 ACL fence 会拒绝泄露", async () => {
    const f = secureFixture();
    await promoteFirst(f, "return fence confidential evidence");
    const hit = (await f.service.search(f.scope, { query: "return fence confidential" })).hits[0]!;
    const originalGetChunk = f.repo.getChunk.bind(f.repo);
    let loaded = false;
    let revoked = false;
    vi.spyOn(f.repo, "getChunk").mockImplementationOnce(async (scope, documentId, versionId, chunkId) => {
      const candidate = await originalGetChunk(scope, documentId, versionId, chunkId);
      loaded = candidate !== null;
      await f.acl.replaceRules({ id: "alice", groupIds: [] }, {
        boundary: f.scope,
        expectedRevision: 0,
        rules: [{
          id: "deny_during_open",
          subject: { type: "principal", id: "alice" },
          effect: "deny",
          permission: "read",
          resource: { scopeType: "chunk", documentId, versionId, chunkId },
        }],
      });
      revoked = true;
      return candidate;
    });

    await expect(f.service.open(f.scope, { evidenceRef: hit.evidenceRef })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect({ loaded, revoked, aclRevision: await f.acl.currentRevision(f.scope) }).toEqual({
      loaded: true,
      revoked: true,
      aclRevision: 1,
    });
  });

  it("versionDiff 的两个最终裁决不在同一 ACL revision 时不返回旧版差异", async () => {
    const f = secureFixture();
    const first = await promoteFirst(f, "version one confidential evidence");
    const second = await f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "version two replacement evidence"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    });
    const originalAuthorize = f.acl.authorizeRead.bind(f.acl);
    let call = 0;
    let releaseRevoked!: () => void;
    const revoked = new Promise<void>((resolve) => { releaseRevoked = resolve; });
    vi.spyOn(f.acl, "authorizeRead").mockImplementation(async (...args) => {
      const currentCall = ++call;
      if (currentCall === 3) {
        const authorization = await originalAuthorize(...args);
        await f.acl.replaceRules({ id: "alice", groupIds: [] }, {
          boundary: f.scope,
          expectedRevision: 0,
          rules: [{
            id: "revoke_old_version_during_diff",
            subject: { type: "principal", id: "alice" },
            effect: "deny",
            permission: "read",
            resource: {
              scopeType: "version",
              documentId: first.documentId,
              versionId: first.versionId,
            },
          }],
        });
        releaseRevoked();
        return authorization;
      }
      if (currentCall === 4) await revoked;
      return originalAuthorize(...args);
    });

    await expect(
      f.service.versionDiff(f.scope, first.documentId, first.versionId, second.version.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(call).toBe(4);
  });

  it("列表、搜索和 Harness 加载在返回前发现 ACL generation 漂移时统一失败关闭", async () => {
    const f = secureFixture();
    const first = await promoteFirst(f, "generation fenced project evidence");
    await f.service.attach(f.scope, f.session, {
      documentId: first.documentId,
      versionId: first.versionId,
    });
    vi.spyOn(f.acl, "currentRevision").mockResolvedValue(1);

    await expect(f.service.list(f.scope)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      f.service.search(f.scope, { query: "generation fenced" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      f.service.listAttachments(f.scope, f.session),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(f.service.loadAttached(f.session)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("安全审计要求 manage_acl，显式 deny 对 owner 也统一返回 404", async () => {
    const f = secureFixture();
    await f.service.replaceAclRules(f.scope, {
      expectedRevision: 0,
      rules: [{
        id: "deny_audit_management",
        subject: { type: "principal", id: "alice" },
        effect: "deny",
        permission: "manage_acl",
        resource: { scopeType: "project" },
      }],
    });
    await expect(f.service.securityAudit(f.scope, 20)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(f.service.aclSnapshot(f.scope)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("显式 write deny 阻止元数据、采用、归档和新旧版本入库，且不改变原状态", async () => {
    const f = secureFixture();
    const first = await promoteFirst(f, "write protected evidence");
    const before = await f.repo.get(f.scope, first.documentId);
    await f.service.replaceAclRules(f.scope, {
      expectedRevision: 0,
      rules: [
        {
          id: "deny_existing_write",
          subject: { type: "principal", id: "alice" },
          effect: "deny",
          permission: "write",
          resource: { scopeType: "document", documentId: first.documentId },
        },
        {
          id: "deny_new_write",
          subject: { type: "principal", id: "alice" },
          effect: "deny",
          permission: "write",
          resource: { scopeType: "project" },
        },
      ],
    });

    await expect(f.service.updateMetadata(f.scope, first.documentId, {
      expectedRevision: before!.revision,
      title: "不应写入",
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(f.service.adopt(f.scope, first.documentId, {
      versionId: first.versionId,
      expectedRevision: before!.revision,
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(f.service.archive(f.scope, first.documentId, {
      archived: true,
      expectedRevision: before!.revision,
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const parserCalls = f.parser.calls;
    await expect(f.service.promoteSessionFile(f.scope, {
      source: f.write("采购规则.txt", "blocked replacement"),
      documentId: first.documentId,
      baseVersionId: first.versionId,
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(f.service.promoteSessionFile(f.scope, {
      source: f.write("新文档.txt", "blocked new document"),
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(f.parser.calls).toBe(parserCalls);
    expect(await f.repo.get(f.scope, first.documentId)).toEqual(before);
    expect(await f.repo.history(f.scope, first.documentId)).toHaveLength(1);
  });
});

describe("OntoDocument SQLite persistence", () => {
  it("真实 SQL 表可保存、重建 service 后读取版本/检索/挂载", async () => {
    const store = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
    try {
      const repo = new SqlDocumentRepository(store);
      const f = fixture(repo);
      const first = await promoteFirst(f, "sqlite durable evidence");
      await f.service.attach(f.scope, f.session, {
        documentId: first.documentId,
        versionId: first.versionId,
      });

      const again = new DocumentService({
        repository: new SqlDocumentRepository(store),
        workspaceRoot: f.root,
        parser: f.parser,
      });
      expect((await again.list(f.scope))[0]?.id).toBe(first.documentId);
      expect((await again.history(f.scope, first.documentId))[0]).toMatchObject({
        id: first.versionId,
        versionNo: 1,
        chunkCount: 1,
      });
      const search = await again.search(f.scope, { query: "sqlite durable" });
      expect(search.hits[0]?.text).toBe("sqlite durable evidence");
      expect((await again.loadAttachedParsedDocs(f.session)).documents[0]?.file_id).toBe(first.versionId);
    } finally {
      await store.close();
    }
  });
});
