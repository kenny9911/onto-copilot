import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentAclController,
  DocumentNotFoundOrForbidden,
  MemoryDocumentAclRepository,
  SqlDocumentAclRepository,
  evaluateAcl,
  type AclPrincipal,
  type AclRule,
  type AclRuleSeed,
  type AclSnapshot,
} from "../src/document/acl.js";
import {
  MemoryDocumentSecurityAuditRepository,
  SqlDocumentSecurityAuditRepository,
  makeDocumentSecurityAuditEvent,
} from "../src/document/audit.js";
import { Store } from "../src/store/engine.js";
import type { DocumentScope } from "../src/document/types.js";

const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const boundary: DocumentScope = { projectId: "project_A", owner: "alice" };
const alice: AclPrincipal = { id: "alice", groupIds: ["owners"] };
const bob: AclPrincipal = { id: "bob", groupIds: ["analysts"] };

function stored(seed: AclRuleSeed, revision = 1): AclRule {
  return {
    ...seed,
    subject: { ...seed.subject },
    resource: { ...seed.resource },
    changedRevision: revision,
    createdBy: "alice",
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function rule(
  id: string,
  effect: "allow" | "deny",
  resource: AclRuleSeed["resource"],
  subject: AclRuleSeed["subject"] = { type: "group", id: "analysts" },
  permission: AclRuleSeed["permission"] = "read",
): AclRuleSeed {
  return { id, subject, effect, permission, resource };
}

function deterministicController(
  repo: MemoryDocumentAclRepository,
  audit: MemoryDocumentSecurityAuditRepository,
): DocumentAclController {
  let id = 0;
  let tick = 0;
  return new DocumentAclController(
    repo,
    audit,
    () => `audit_${++id}`,
    () => `2026-09-02T00:00:0${tick++}.000Z`,
  );
}

describe("OntoDocument ACL 纯裁决", () => {
  it("principal/group 同时命中时 deny 全局优先，并按项目/文档/版本/片段继承", () => {
    const snapshot: AclSnapshot = {
      boundary,
      revision: 7,
      rules: [
        stored(rule("allow_project", "allow", { scopeType: "project" })),
        stored(rule("deny_doc", "deny", { scopeType: "document", documentId: "doc_secret" })),
        stored(
          rule(
            "allow_version",
            "allow",
            { scopeType: "version", documentId: "doc_secret", versionId: "v1" },
            { type: "principal", id: "bob" },
          ),
        ),
        stored(
          rule(
            "deny_chunk",
            "deny",
            { scopeType: "chunk", documentId: "doc_public", versionId: "v2", chunkId: "c9" },
            { type: "principal", id: "bob" },
          ),
        ),
      ],
    };

    expect(
      evaluateAcl(snapshot, bob, { scopeType: "chunk", documentId: "doc_secret", versionId: "v1", chunkId: "c1" }, "read"),
    ).toMatchObject({ allowed: false, reason: "explicit_deny", revision: 7 });
    expect(
      evaluateAcl(snapshot, bob, { scopeType: "chunk", documentId: "doc_public", versionId: "v2", chunkId: "c9" }, "read"),
    ).toMatchObject({ allowed: false, reason: "explicit_deny" });
    expect(
      evaluateAcl(snapshot, bob, { scopeType: "chunk", documentId: "doc_public", versionId: "v2", chunkId: "c8" }, "read"),
    ).toMatchObject({ allowed: true, reason: "explicit_allow" });
    expect(
      evaluateAcl(snapshot, { id: "carol", groupIds: [] }, { scopeType: "document", documentId: "doc_public" }, "read"),
    ).toMatchObject({ allowed: false, reason: "no_matching_allow" });
  });

  it("owner 默认可引导 ACL，但显式 deny 仍优先于 owner", () => {
    const empty: AclSnapshot = { boundary, revision: 0, rules: [] };
    expect(evaluateAcl(empty, alice, { scopeType: "project" }, "manage_acl")).toMatchObject({
      allowed: true,
      reason: "project_owner",
    });
    const denied: AclSnapshot = {
      boundary,
      revision: 1,
      rules: [
        stored(rule("lock_owner", "deny", { scopeType: "project" }, { type: "principal", id: "alice" }, "manage_acl")),
      ],
    };
    expect(evaluateAcl(denied, alice, { scopeType: "project" }, "manage_acl")).toMatchObject({
      allowed: false,
      reason: "explicit_deny",
    });
  });

  it("真实 chunk_id 可包含工作表名和空格，但控制字符仍被拒绝", () => {
    const snapshot: AclSnapshot = {
      boundary,
      revision: 1,
      rules: [stored(rule("all", "allow", { scopeType: "project" }))],
    };
    expect(
      evaluateAcl(
        snapshot,
        bob,
        { scopeType: "chunk", documentId: "doc_1", versionId: "ver_1", chunkId: "ver_1:采购 计划:r1" },
        "read",
      ).allowed,
    ).toBe(true);
    expect(() =>
      evaluateAcl(
        snapshot,
        bob,
        { scopeType: "chunk", documentId: "doc_1", versionId: "ver_1", chunkId: "bad\u0000id" },
        "read",
      ),
    ).toThrow(/安全资源标识符/u);
  });
});

describe("OntoDocument ACL 控制器", () => {
  it("检索前只放行 resource id；撤权后 open 会重新加载 ACL 并拒绝旧命中", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    await controller.replaceRules(alice, {
      boundary,
      expectedRevision: 0,
      eventId: "change_1",
      occurredAt: "2026-09-02T00:00:00.000Z",
      rules: [
        rule("read_project", "allow", { scopeType: "project" }),
        rule(
          "deny_secret_chunk",
          "deny",
          { scopeType: "chunk", documentId: "doc_1", versionId: "v1", chunkId: "secret" },
          { type: "principal", id: "bob" },
        ),
      ],
    });
    const publicChunk = { scopeType: "chunk", documentId: "doc_1", versionId: "v1", chunkId: "public" } as const;
    const secretChunk = { scopeType: "chunk", documentId: "doc_1", versionId: "v1", chunkId: "secret" } as const;
    const plan = await controller.filterSearchTargets(boundary, bob, [publicChunk, secretChunk], {
      querySha256: "a".repeat(64),
    });
    expect(plan).toEqual({ aclRevision: 1, allowedTargets: [publicChunk] });

    await controller.replaceRules(alice, {
      boundary,
      expectedRevision: 1,
      eventId: "change_2",
      occurredAt: "2026-09-02T00:00:02.000Z",
      rules: [rule("deny_doc", "deny", { scopeType: "document", documentId: "doc_1" })],
    });
    await expect(controller.authorizeRead(boundary, bob, publicChunk)).rejects.toMatchObject({
      code: "NOT_FOUND_OR_FORBIDDEN",
      status: 404,
    });

    const events = await audit.list(boundary);
    expect(events.find((event) => event.action === "search.filter")?.detail).toMatchObject({
      candidateCount: 2,
      allowedCount: 1,
      deniedCount: 1,
      querySha256: "a".repeat(64),
    });
    expect(JSON.stringify(events)).not.toContain("采购金额正文");
  });

  it("不存在和无权统一成 NOT_FOUND_OR_FORBIDDEN，且无权时不调用 loader", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    let loaded = false;
    const target = { scopeType: "document", documentId: "guessable_doc" } as const;
    await expect(
      controller.readAuthorized(boundary, bob, target, async () => {
        loaded = true;
        return { body: "secret" };
      }),
    ).rejects.toBeInstanceOf(DocumentNotFoundOrForbidden);
    expect(loaded).toBe(false);

    await expect(controller.readAuthorized(boundary, alice, target, async () => null)).rejects.toMatchObject({
      code: "NOT_FOUND_OR_FORBIDDEN",
      status: 404,
    });
  });

  it("读取期间 ACL revision 变化时不返回已经撤权的正文", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    const target = { scopeType: "document", documentId: "doc_race" } as const;

    await expect(
      controller.readAuthorized(boundary, alice, target, async () => {
        await controller.replaceRules(alice, {
          boundary,
          expectedRevision: 0,
          rules: [
            rule(
              "revoke_owner_read",
              "deny",
              target,
              { type: "principal", id: "alice" },
            ),
          ],
        });
        return { body: "不应越过权限边界的正文" };
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND_OR_FORBIDDEN", status: 404 });
  });

  it("非 owner 必须已有 manage_acl；body 伪造 actorId 没有入口", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    await expect(
      controller.replaceRules(bob, { boundary, expectedRevision: 0, rules: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND_OR_FORBIDDEN" });

    await controller.replaceRules(alice, {
      boundary,
      expectedRevision: 0,
      rules: [rule("admins_manage", "allow", { scopeType: "project" }, { type: "group", id: "admins" }, "manage_acl")],
    });
    const admin = { id: "carol", groupIds: ["admins"] };
    const changed = await controller.replaceRules(admin, {
      boundary,
      expectedRevision: 1,
      rules: [rule("readers", "allow", { scopeType: "project" })],
    });
    expect(changed.revision).toBe(2);
    expect(changed.rules[0]?.createdBy).toBe("carol");
  });

  it("manage 授权快照必须等于提交 CAS 基线，不能猜未来 revision 跨过撤权", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    await controller.replaceRules(alice, {
      boundary,
      expectedRevision: 0,
      rules: [rule("bob_manage", "allow", { scopeType: "project" }, { type: "principal", id: "bob" }, "manage_acl")],
    });
    await expect(
      controller.replaceRules(bob, { boundary, expectedRevision: 2, rules: [] }),
    ).rejects.toMatchObject({
      code: "ACL_REVISION_CONFLICT",
      expectedRevision: 2,
      actualRevision: 1,
    });
    expect((await repo.snapshot(boundary)).revision).toBe(1);
  });
});

describe("ACL 仓储与无正文审计", () => {
  it("空检索范围不伪装成权限拒绝", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    const controller = deterministicController(repo, audit);
    const plan = await controller.filterSearchTargets(boundary, alice, [], {
      querySha256: "a".repeat(64),
    });
    expect(plan.allowedTargets).toEqual([]);
    const [event] = await audit.list(boundary);
    expect(event).toMatchObject({
      action: "search.filter",
      decision: "allow",
      detail: { candidateCount: 0, allowedCount: 0, deniedCount: 0 },
    });
  });

  it("拒绝伪造作用域/枚举；审计构造器丢弃未知正文键", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    await expect(
      repo.replaceRules({
        boundary,
        expectedRevision: 0,
        actorId: "alice",
        rules: [
          {
            ...rule("bad", "allow", { scopeType: "document", documentId: "doc", versionId: "forged" } as never),
            effect: "super_allow" as never,
          },
        ],
      }),
    ).rejects.toThrow(/effect|作用域/u);

    const event = makeDocumentSecurityAuditEvent({
      id: "audit_safe",
      boundary,
      actorType: "principal",
      actorId: "alice",
      action: "document.read",
      decision: "allow",
      resource: { scopeType: "document", documentId: "doc_1" },
      aclRevision: 1,
      detail: { requestId: "req_1", text: "采购金额正文" } as never,
      occurredAt: "2026-09-02T00:00:00.000Z",
    });
    expect(event.detail).toEqual({ requestId: "req_1" });
    expect(JSON.stringify(event)).not.toContain("采购金额正文");
  });

  it("内存仓储 revision CAS 与 project/owner 边界隔离", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    await repo.replaceRules({
      boundary,
      expectedRevision: 0,
      actorId: "alice",
      eventId: "cas_1",
      rules: [rule("read", "allow", { scopeType: "project" })],
    });
    await expect(
      repo.replaceRules({ boundary, expectedRevision: 0, actorId: "alice", rules: [] }),
    ).rejects.toMatchObject({ code: "ACL_REVISION_CONFLICT", expectedRevision: 0, actualRevision: 1 });
    expect((await repo.snapshot({ projectId: "project_A", owner: "mallory" })).revision).toBe(0);
    expect((await repo.snapshot({ projectId: "project_B", owner: "alice" })).rules).toEqual([]);
  });

  it("清空 ACL 仍在 change event 记录被删除规则 id，不写规则正文", async () => {
    const audit = new MemoryDocumentSecurityAuditRepository();
    const repo = new MemoryDocumentAclRepository(audit);
    await repo.replaceRules({
      boundary,
      expectedRevision: 0,
      actorId: "alice",
      eventId: "remove_1",
      rules: [rule("old_rule", "allow", { scopeType: "project" })],
    });
    await repo.replaceRules({
      boundary,
      expectedRevision: 1,
      actorId: "alice",
      eventId: "remove_2",
      rules: [],
    });
    const event = (await audit.list(boundary)).find((item) => item.id === "remove_2");
    expect(event).toMatchObject({
      aclRevision: 2,
      matchedRuleIds: ["old_rule"],
      detail: { changedRuleCount: 1 },
    });
  });

  it("SQLite 持久化 ACL/审计；重复事件导致整个 ACL 事务回滚", async () => {
    const store = await Store.open("sqlite:///:memory:", { createAll: true });
    stores.push(store);
    const audit = new SqlDocumentSecurityAuditRepository(store);
    const repo = new SqlDocumentAclRepository(store);
    await repo.replaceRules({
      boundary,
      expectedRevision: 0,
      actorId: "alice",
      eventId: "same_event",
      occurredAt: "2026-09-02T00:00:00.000Z",
      rules: [rule("read_1", "allow", { scopeType: "document", documentId: "doc_1" })],
    });
    expect(await repo.snapshot(boundary)).toMatchObject({ revision: 1 });
    expect((await audit.list(boundary))[0]).toMatchObject({
      action: "acl.change",
      decision: "changed",
      aclRevision: 1,
      detail: { changedRuleCount: 1 },
    });

    await expect(
      repo.replaceRules({
        boundary,
        expectedRevision: 1,
        actorId: "alice",
        eventId: "same_event",
        occurredAt: "2026-09-02T00:00:01.000Z",
        rules: [rule("read_2", "allow", { scopeType: "document", documentId: "doc_2" })],
      }),
    ).rejects.toThrow();
    const after = await repo.snapshot(boundary);
    expect(after.revision).toBe(1);
    expect(after.rules.map((item) => item.id)).toEqual(["read_1"]);
    expect(await audit.list(boundary)).toHaveLength(1);
  });
});
