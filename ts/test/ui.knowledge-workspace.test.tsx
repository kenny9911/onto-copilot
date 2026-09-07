// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/react/knowledge-library.js", () => ({
  KnowledgeLibrary: ({ sessionId }: { sessionId: string }) =>
    <section className="od-library" data-session-id={sessionId}>文件管理区</section>,
}));

import type { KnowledgeManagementApi, WikiStoredPageView } from "../src/ui/knowledge-management.js";
import {
  AccessPanel,
  JobsPanel,
  KnowledgeWorkspace,
  SourcesPanel,
  WikiPanel,
  VersionReviewPanel,
} from "../src/ui/react/knowledge-workspace.js";

const documentRow = {
  id: "doc-1", title: "采购制度", logical_name: "采购制度", source_class: "session_upload", tags: [],
  status: "active", current_version_id: "ver-2", adopted_version_id: "ver-1", revision: 2,
  created_by: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
};

const versions = [1, 2].map((version) => ({
  id: `ver-${version}`, document_id: "doc-1", version_no: version, file_name: `采购制度-v${version}.docx`,
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size_bytes: 10,
  sha256: `sha-${version}`, doc_kind: "document", parse_status: "ready", parser_name: "docx",
  parser_version: "1", index_revision: `idx-${version}`, chunk_count: 2, created_by: "u1",
  created_at: `2026-09-0${version}T00:00:00Z`,
}));

const wikiPage: WikiStoredPageView = {
  page: {
    id: "procurement", title: "采购口径", summary: "项目确认的采购口径", tags: ["采购"],
    updated_at: "2026-09-02T00:00:00Z",
    claims: [{
      id: "claim-ai", kind: "INFERENCE", subject: "计划金额", statement: "可能按含税金额计算",
      evidence_refs: ["odoc.v1.a.b.c"], state: "draft", author: { kind: "ai", id: "assistant" },
      created_at: "2026-09-02T00:00:00Z", confirmation: null, supersedes_claim_id: null,
    }, {
      id: "claim-human", kind: "HUMAN_DECISION", subject: "审批口径", statement: "按含税金额审批",
      evidence_refs: ["odoc.v1.x.y.z"], state: "confirmed", author: { kind: "human", id: "u1" },
      created_at: "2026-09-02T00:00:00Z", confirmation: {
        actor: { kind: "human", id: "u1" }, evidence_refs: ["odoc.v1.x.y.z"], confirmed_at: "2026-09-02T00:00:00Z",
      }, supersedes_claim_id: null,
    }],
  },
  status: "active", revision: 3, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
  updated_by: "u1", updated_at: "2026-09-02T00:00:00Z",
};

function apiFixture(): KnowledgeManagementApi {
  const confirmed: WikiStoredPageView = {
    ...wikiPage,
    revision: 4,
    page: { ...wikiPage.page, claims: wikiPage.page.claims.map((claim) => claim.id === "claim-ai"
      ? { ...claim, state: "confirmed", confirmation: {
          actor: { kind: "human", id: "u1" }, evidence_refs: claim.evidence_refs, confirmed_at: "2026-09-02T01:00:00Z",
        } }
      : claim) },
  };
  return {
    listDocuments: vi.fn(async () => [documentRow as any]),
    history: vi.fn(async () => versions as any),
    diff: vi.fn(async () => ({
      document_id: "doc-1", from_version_id: "ver-1", to_version_id: "ver-2", from_version_no: 1, to_version_no: 2,
      summary: { chunks: { added: 0, removed: 0, modified: 1, unchanged: 1 }, tables: { added: 0, removed: 0, modified: 0, unchanged: 0 }, fields: { added: 0, removed: 0, modified: 0, unchanged: 0 } },
      changes: { chunks: [], tables: [], fields: [] }, has_changes: true, fingerprint: "diff-fp",
    })),
    impact: vi.fn(async () => ({
      document_id: "doc-1", from_version_id: "ver-1", to_version_id: "ver-2", consumers: [],
      stale_candidates: [{ consumerId: "answer-1", consumerKind: "answer", label: "已有回答", status: "stale_candidate", reasons: [{ message: "引用的正文发生变化" }] }],
      unresolved: [], fingerprint: "impact-fp", notice: "这里只标记需要复核的候选项，不会自动修改回答、模型产物或 Wiki。",
    })),
    listWikiPages: vi.fn(async () => [wikiPage]), createWikiPage: vi.fn(async () => wikiPage),
    updateWikiPage: vi.fn(async () => wikiPage), changeWikiPageStatus: vi.fn(async () => wikiPage),
    addWikiDraft: vi.fn(async () => wikiPage), editWikiDraft: vi.fn(async () => wikiPage),
    removeWikiDraft: vi.fn(async () => wikiPage), confirmWikiClaim: vi.fn(async () => confirmed),
    wikiMarkdownUrl: vi.fn(() => "/wiki.md"), obsidianUrl: vi.fn(() => "/obsidian.zip"),
    listJobs: vi.fn(async () => [{
      id: "job-1", document_id: "doc-1", version_id: "ver-1", kind: "ocr", status: "running",
      attempts: 1, max_attempts: 3, candidate_ready: false, result_sha256: "", last_error: "",
      created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:01:00Z",
    }]),
    createJob: vi.fn(async (_sid, input) => ({
      id: "job-new", ...input, status: "queued", attempts: 0, max_attempts: 3, candidate_ready: false,
      result_sha256: "", last_error: "", created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
    })),
    cancelJob: vi.fn(async () => ({
      id: "job-1", document_id: "doc-1", version_id: "ver-1", kind: "ocr", status: "cancelled",
      attempts: 1, max_attempts: 3, candidate_ready: false, result_sha256: "", last_error: "",
      created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:01:00Z",
    })),
    listConnectors: vi.fn(async () => [{
      id: "source-1", provider: "sharepoint", name: "项目 SharePoint", root_or_prefix: "/采购",
      credential_ref: "vault://team/sharepoint", tags: [], classification: "internal", enabled: true,
      revision: 2, status: "idle", has_cursor: true, created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z", last_started_at: null, last_completed_at: "2026-09-02T00:00:00Z", last_error: "",
    }]),
    createConnector: vi.fn(async () => { throw new Error("not used"); }),
    updateConnector: vi.fn(async (_sid, _sourceId, revision, input) => ({
      id: "source-1", provider: input.provider || "sharepoint", name: input.name || "项目 SharePoint",
      root_or_prefix: input.root_or_prefix || "/采购", credential_ref: input.credential_ref || "vault://team/sharepoint",
      tags: [], classification: input.classification || "internal", enabled: true, revision: revision + 1,
      status: "idle", has_cursor: false, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
      last_started_at: null, last_completed_at: null, last_error: "",
    })),
    changeConnectorStatus: vi.fn(async () => { throw new Error("not used"); }),
    syncConnector: vi.fn(async () => ({
      source_id: "source-1", pages: 1, upserted: 2, deleted: 0, acl_updated: 1,
      complete: true, has_next_cursor: false, started_at: "2026-09-02T00:00:00Z", completed_at: "2026-09-02T00:00:01Z",
    })),
    acl: vi.fn(async () => ({ revision: 2, rules: [{
      id: "owner-read", subject: { type: "principal", id: "u1" }, effect: "allow", permission: "read",
      resource: { scope_type: "project" }, changed_revision: 2, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
    }] })),
    replaceAcl: vi.fn(async (_sid, revision, rules) => ({ revision: revision + 1, rules })),
    audit: vi.fn(async () => [{ action: "search", decision: "deny", scope_type: "project", acl_revision: 2, denied_count: 1 }]),
  } as KnowledgeManagementApi;
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => cleanup());

describe("独立项目知识库工作区", () => {
  it("首屏只有材料，内部机器不占主位", async () => {
    // 原来是五个 Tab：文件 / 项目 Wiki / 处理任务 / 数据源 / 权限审计 —— 那是**后端
    // 五个路由文件的镜像**，不是用户的五件事。其中三个是纯内部机器（数据源的同步
    // 永远抛异常、权限审计要手填 chunk id），却和「我的材料」抢同一排主位。
    const api = apiFixture();
    const view = render(<KnowledgeWorkspace sessionId="session/1" sessionFiles={[{ name: "采购制度.docx" }]} api={api} />);

    // 这一屏现在**只有一件事**：材料在树上，正文在右边。
    //
    // 前三轮「简化」砍的都是可见性（五个 Tab → 两个 Tab + 一个「高级」），
    // 结构一动没动，用户第四次还是说复杂。这一次动结构：页签和折叠层整个退场。
    //
    // 拿他自己的库查过的账：「已确认知识」全库 0 条 Wiki；「高级」四块里三块
    // 零数据；「数据源」的同步更是结构上不可能成功（registerConnectorRuntime
    // 全仓零调用方，必定 503）。一个通向空房间的常驻页签，比没有它更糟。
    expect(view.container.querySelector(".odm-switch"), "页签整个退场").toBeNull();
    expect(view.container.querySelector(".odm-tabs"), "五个 Tab 的旧结构早已消失").toBeNull();
    expect(view.container.querySelector(".odm-advanced-toggle"), "「高级」折叠层退场").toBeNull();
    expect(view.container.textContent).not.toContain("新建处理任务");
    expect(view.container.textContent).not.toContain("版本变化与影响");

    expect(view.container.querySelector(".od-library")?.getAttribute("data-session-id")).toBe("session/1");
    expect(view.container.querySelector(".ctx-sidebar"), "知识库内容被放回右侧 sidebar").toBeNull();
  });

  it("版本影响只有点击比较后才调用，并明确不会自动修改产物", async () => {
    const api = apiFixture();
    // 直接挂面板：这条测的是**面板自己的行为**，不是它挂在哪一屏上。
    // 它现在不挂在知识库页上了（那一屏只剩材料），但组件本身照旧要能用。
    const view = render(<VersionReviewPanel sessionId="s1" api={api} />);
    const compare = await view.findByRole("button", { name: "比较并检查影响" });
    await waitFor(() => expect(compare.hasAttribute("disabled")).toBe(false));
    expect(api.diff).not.toHaveBeenCalled();
    fireEvent.click(compare);
    await waitFor(() => expect(api.diff).toHaveBeenCalledWith("s1", "doc-1", "ver-1", "ver-2"));
    expect(view.container.textContent).toContain("这里只标记需要复核的候选项，不会自动修改回答、模型产物或 Wiki");
  });

  it("Wiki 清楚区分 AI 草稿和人工确认，确认必须由按钮提交且带证据", async () => {
    const api = apiFixture();
    // WikiPanel 现在是**有内容才出现**的一节（库里 0 条 Wiki 时整节不渲染 ——
    // 一个通向空房间的常驻页签比没有它更糟）。这条测的是面板自己的行为，直接挂它。
    const view = render(<WikiPanel sessionId="s1" api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("AI 草稿 · 待人工确认"));
    expect(view.container.textContent).toContain("人工已确认");
    expect(api.confirmWikiClaim).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "审阅并确认" }));
    fireEvent.click(view.getByRole("button", { name: "确认这是项目知识" }));
    await waitFor(() => expect(api.confirmWikiClaim).toHaveBeenCalledWith(
      "s1", "procurement", "claim-ai", 3, ["odoc.v1.a.b.c"],
    ));
  });

  it("处理任务不会自动创建；人工确认后才提交固定文档版本", async () => {
    const api = apiFixture();
    const view = render(<JobsPanel sessionId="s1" api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("OCR 识别"));
    expect(api.createJob).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "新建处理任务" }));
    fireEvent.click(view.getByRole("button", { name: "确认创建任务" }));
    await waitFor(() => expect(api.createJob).toHaveBeenCalled());
    expect(api.createJob).toHaveBeenCalledWith("s1", expect.objectContaining({
      document_id: "doc-1", version_id: "ver-1", kind: "parse", idempotency_key: expect.any(String),
    }));
  });

  it("数据源只显示凭据引用，只有点击同步才读取远端", async () => {
    const api = apiFixture();
    const view = render(<SourcesPanel sessionId="s1" api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("项目 SharePoint"));
    expect(view.container.textContent).toContain("vault://team/sharepoint");
    expect(view.container.textContent).toContain("不接收密码或 Token");
    expect(api.syncConnector).not.toHaveBeenCalled();
    expect(api.updateConnector).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "编辑设置" }));
    fireEvent.click(view.getByRole("button", { name: "保存数据源设置" }));
    await waitFor(() => expect(api.updateConnector).toHaveBeenCalledWith("s1", "source-1", 2, expect.objectContaining({
      credential_ref: "vault://team/sharepoint",
    })));
    fireEvent.click(view.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(api.syncConnector).toHaveBeenCalledWith("s1", "source-1", 3));
  });

  it("权限默认只读，点击编辑和确认保存后才写；并如实说明当前账号边界", async () => {
    const api = apiFixture();
    const view = render(<AccessPanel sessionId="s1" api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("允许 用户 u1"));
    expect(view.container.textContent).toContain("当前版本以项目所属账号为访问边界");
    expect(view.queryByRole("button", { name: "确认保存权限" })).toBeNull();
    expect(api.replaceAcl).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "编辑权限" }));
    expect(view.queryByRole("option", { name: "用户组" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "确认保存权限" }));
    await waitFor(() => expect(api.replaceAcl).toHaveBeenCalledWith("s1", 2, expect.any(Array)));
    expect(view.container.textContent).toContain("已拒绝");
  });
});
