// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeManagementApi } from "../src/ui/knowledge-management.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function ok(payload: unknown): any {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

describe("OntoDocument 管理页 API 合同", () => {
  it("Wiki、任务和数据源写操作只提交业务字段，不接受项目、账号或密钥正文", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/wiki/pages/page-1/claims/claim-1/confirm")) return ok({ page: { page: { id: "page-1" } } });
      if (String(url).endsWith("/wiki/pages")) return ok({ page: { page: { id: "page-1" } } });
      if (String(url).endsWith("/documents/jobs")) return ok({ job: { id: "job-1" } });
      if (String(url).endsWith("/document-connectors")) return ok({ source: { id: "source-1" } });
      return ok({});
    }) as any;

    await knowledgeManagementApi.createWikiPage("session/with space", { title: "采购口径", tags: ["采购"] });
    await knowledgeManagementApi.confirmWikiClaim("session/with space", "page-1", "claim-1", 3, ["odoc.v1.a.b.c"]);
    await knowledgeManagementApi.createJob("session/with space", {
      document_id: "doc-1", version_id: "ver-2", kind: "ocr", idempotency_key: "ocr-1",
    });
    await knowledgeManagementApi.createConnector("session/with space", {
      request_id: "source-1", provider: "sharepoint", name: "采购资料", root_or_prefix: "/采购",
      credential_ref: "vault://team/sharepoint", classification: "internal",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/sessions/session%2Fwith%20space/documents/wiki/pages",
      "/api/sessions/session%2Fwith%20space/documents/wiki/pages/page-1/claims/claim-1/confirm",
      "/api/sessions/session%2Fwith%20space/documents/jobs",
      "/api/sessions/session%2Fwith%20space/document-connectors",
    ]);
    for (const call of calls) {
      const body = call.init.body ? JSON.parse(call.init.body) as Record<string, unknown> : {};
      expect(body).not.toHaveProperty("project_id");
      expect(body).not.toHaveProperty("owner");
      expect(body).not.toHaveProperty("token");
      expect(body).not.toHaveProperty("password");
    }
  });

  it("权限保存去掉只读审计字段，保留乐观锁修订号", async () => {
    let request: any = null;
    globalThis.fetch = vi.fn(async (url: string, init: any) => {
      request = { url: String(url), init };
      return ok({ revision: 5, rules: [] });
    }) as any;
    await knowledgeManagementApi.replaceAcl("s1", 4, [{
      id: "u1-read", subject: { type: "principal", id: "u1" }, effect: "allow", permission: "read",
      resource: { scope_type: "project" }, changed_revision: 4, created_by: "admin", created_at: "yesterday",
    }]);
    expect(request.url).toBe("/api/sessions/s1/documents/acl");
    expect(JSON.parse(request.init.body)).toEqual({
      expected_revision: 4,
      rules: [{ id: "u1-read", subject: { type: "principal", id: "u1" }, effect: "allow", permission: "read", resource: { scope_type: "project" } }],
    });
  });

  it("数据源运行时未装配时保留 503，让页面能区分配置已保存与暂不能同步", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 503, json: async () => ({}),
      text: async () => JSON.stringify({ detail: "连接器运行时未配置。来源设置已经保存，但现在还不能同步。" }),
    })) as any;
    await expect(knowledgeManagementApi.syncConnector("s1", "source-1", 2)).rejects.toMatchObject({
      message: "连接器运行时未配置。来源设置已经保存，但现在还不能同步。",
      status: 503,
    });
  });
});
