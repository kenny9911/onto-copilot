// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  knowledgeLibraryApi,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
  type KnowledgeLibraryApi,
  type KnowledgeSearchResult,
} from "../src/ui/knowledge-library.js";
import { KnowledgeLibrary, splitKnowledgeTags } from "../src/ui/react/knowledge-library.js";
import { G } from "../src/ui/state.js";

const documentRow: KnowledgeDocument = {
  id: "doc-1",
  title: "采购管理制度",
  logical_name: "采购制度",
  source_class: "session_upload",
  tags: ["采购", "已评审"],
  status: "active",
  current_version_id: "ver-2",
  adopted_version_id: "ver-1",
  revision: 7,
  created_by: "fde",
  created_at: "2026-08-30T10:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z",
};

const versions: KnowledgeDocumentVersion[] = [{
  id: "ver-2",
  document_id: "doc-1",
  version_no: 2,
  file_name: "采购制度-修订版.docx",
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size_bytes: 8_192,
  sha256: "b".repeat(64),
  doc_kind: "document",
  parse_status: "degraded",
  parser_name: "docx",
  parser_version: "2",
  index_revision: "idx-2",
  chunk_count: 21,
  created_by: "fde",
  created_at: "2026-09-01T10:00:00.000Z",
}, {
  id: "ver-1",
  document_id: "doc-1",
  version_no: 1,
  file_name: "采购制度.docx",
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size_bytes: 7_168,
  sha256: "a".repeat(64),
  doc_kind: "document",
  parse_status: "ready",
  parser_name: "docx",
  parser_version: "2",
  index_revision: "idx-1",
  chunk_count: 18,
  created_by: "fde",
  created_at: "2026-08-30T10:00:00.000Z",
}];

function searchResult(hits = 1): KnowledgeSearchResult {
  return {
    query: "计划金额",
    searched_versions: ["ver-1"],
    coverage: {
      matchedTerms: hits ? ["计划", "金额"] : [],
      missingTerms: hits ? [] : ["计划", "金额"],
      queryTerms: 2,
      ratio: hits ? 1 : 0,
    },
    hits: hits ? [{
      evidence_ref: "ev_1",
      cite: "采购制度.docx#p3",
      document_id: "doc-1",
      version_id: "ver-1",
      version_no: 1,
      document_title: "采购管理制度",
      file_name: "采购制度.docx",
      chunk_id: "chunk-3",
      locator: { page: 3 },
      text: "计划金额按不含税采购预算计算。",
      text_sha256: "c".repeat(64),
      score: 3.2,
      coverage: {
        matchedTerms: ["计划", "金额"], missingTerms: [], queryTerms: 2, ratio: 1,
      },
    }] : [],
  };
}

function fakeApi(): KnowledgeLibraryApi {
  return {
    list: vi.fn(async () => ({ documents: [documentRow], attachments: [] })),
    // 阅读器：不给关键词直接打开读。这里返回一段，够断言「读全文」把正文画出来了。
    read: vi.fn(async () => ({
      document: documentRow,
      version: versions[0]!,
      level: "project" as const,
      chunks: searchResult().hits,
      total: searchResult().hits.length,
      offset: 0,
    })),
    history: vi.fn(async () => versions),
    search: vi.fn(async () => searchResult()),
    open: vi.fn(async () => {
      const hit = searchResult().hits[0];
      if (!hit) throw new Error("test fixture is missing a search hit");
      return {
        ...hit,
        raw: { paragraph: 3 },
        context: "第三页 · 采购计划",
        tags: ["采购"],
      };
    }),
    promote: vi.fn(async () => ({ ok: true, message: "已保存到项目知识库。" })),
    update: vi.fn(async () => ({ ok: true, message: "文档信息已更新。" })),
    adopt: vi.fn(async () => ({ ok: true, message: "已采用这个版本。" })),
    archive: vi.fn(async () => ({ ok: true, message: "已归档这份文档。" })),
    attach: vi.fn(async () => ({ ok: true, message: "已把这个固定版本加入本次分析。" })),
    detach: vi.fn(async () => ({ ok: true, message: "已从本次分析中移除。" })),
  };
}

beforeEach(() => {
  G.LANG = "zh";
  localStorage.setItem("oc_lang", "zh");
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("OntoDocument 项目知识库", () => {
  it("把项目知识库、固定版本与本次上传文件讲清楚", async () => {
    const api = fakeApi();
    const { container } = render(<KnowledgeLibrary
      sessionId="session-1"
      sessionFiles={[{ name: "新采购制度.docx", state: "parsed" }]}
      api={api}
    />);

    await waitFor(() => expect(container.textContent).toContain("采购管理制度"));
    // 页面不再以说明文字开场：直接给一棵材料树 + 一块预览区。
    expect(container.textContent).not.toContain("长期保留项目文件和版本");
    expect(container.querySelector(".od-explorer")).not.toBeNull();
    expect(container.querySelector(".od-tree")).not.toBeNull();
    // 文件夹＝标签。标签是这个产品里材料本来就有的语义，比按上传时间分更贴近「我在找什么」。
    const folders = [...container.querySelectorAll(".od-folder-name")].map((n) => n.textContent);
    expect(folders).toContain("采购");
    expect(container.querySelector(".od-file-name")?.textContent).toBe("采购管理制度");
    // 还没选中任何一份时，右边说清楚该干什么，而不是空着。
    expect(container.querySelector(".od-preview-idle")?.textContent).toContain("在左边选一份材料");
    expect(container.textContent).not.toContain("永久删除");
    expect(api.list).toHaveBeenCalledWith("session-1", false);
    expect(api.history).toHaveBeenCalledWith("session-1", "doc-1");
  });

  it("只用明确按钮固定版本、采用版本、增加版本和归档", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary
      sessionId="session-1"
      sessionFiles={[{ name: "新采购制度.docx" }]}
      api={api}
    />);
    // 操作作用于**当前选中的文件**：先在树里选中，再在预览面板头部操作。
    await waitFor(() => expect(view.container.querySelector(".od-file")).not.toBeNull());
    fireEvent.click(view.container.querySelector(".od-file") as any);
    await waitFor(() => expect(view.container.querySelector(".od-preview-acts")).not.toBeNull());
    fireEvent.click(view.getByRole("button", { name: "版本" }));
    await waitFor(() => expect(view.container.textContent).toContain("v2 · 采购制度-修订版.docx"));

    const latest = view.getByText("v2 · 采购制度-修订版.docx").closest("li") as HTMLElement;
    fireEvent.click(within(latest).getByRole("button", { name: "用于本次分析" }));
    await waitFor(() => expect(api.attach).toHaveBeenCalledWith("session-1", "doc-1", "ver-2"));

    fireEvent.click(within(latest).getByRole("button", { name: "设为项目采用版" }));
    await waitFor(() => expect(api.adopt).toHaveBeenCalledWith("session-1", "doc-1", "ver-2", 7));

    fireEvent.click(view.getByRole("button", { name: "保存为新版本" }));
    await waitFor(() => expect(api.promote).toHaveBeenCalledWith("session-1", {
      session_file_name: "新采购制度.docx",
      target_document_id: "doc-1",
      base_version_id: "ver-2",
    }));

    fireEvent.click(view.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith("session-1", "doc-1", true, 7));
  });

  it("可以编辑元数据，并用当前 revision 防止覆盖并发修改", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("采购管理制度"));

    fireEvent.click(view.container.querySelector(".od-file") as any);
    await waitFor(() => expect(view.container.querySelector(".od-preview-acts")).not.toBeNull());
    fireEvent.click(view.getByRole("button", { name: "编辑" }));
    fireEvent.change(view.getByLabelText("显示标题"), { target: { value: "采购制度（正式）" } });
    fireEvent.change(view.getByLabelText("标签（用逗号分开）"), { target: { value: "采购，正式，采购" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith("session-1", "doc-1", expect.objectContaining({
      expected_revision: 7,
      title: "采购制度（正式）",
      tags: ["采购", "正式"],
    })));
  });

  it("不用输任何关键词就能打开一份材料读，每段都能引用到对话", async () => {
    // 这是「知识库看不懂」最直接的一条：在这个入口之前，存进去的文件只能靠
    // 猜关键词去搜——用户刚传完一份 40 页的材料想知道里面有什么，无从下手。
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("采购管理制度"));

    expect(api.read).not.toHaveBeenCalled();
    // 点树里的文件就是打开预览：文件管理器的手势，不需要再多一个按钮。
    fireEvent.click(view.container.querySelector(".od-file") as any);

    await waitFor(() => expect(api.read).toHaveBeenCalled());
    // 读的是这份文档，且带分页参数——不是把整本一次性倒出来。
    expect((api.read as any).mock.calls[0][0]).toBe("session-1");
    expect((api.read as any).mock.calls[0][2]).toMatchObject({ offset: 0, limit: 50 });
    // 预览面板的操作条也在 —— 编辑/版本/归档没有随着改版消失。
    expect(view.getByRole("button", { name: "编辑" })).not.toBeNull();
    expect(view.getByRole("button", { name: "版本" })).not.toBeNull();
    expect(view.getByRole("button", { name: "归档" })).not.toBeNull();

    // 正文和出处都要在，段落级的「引用到对话」也要在。
    await waitFor(() => expect(view.container.querySelector(".od-reader")).not.toBeNull());
    expect(view.container.querySelectorAll(".od-reader-chunk").length).toBeGreaterThan(0);
    expect(view.getAllByRole("button", { name: "引用到对话" }).length).toBeGreaterThan(0);
  });

  it("搜索只展示带版本和原文定位的命中，点开后显示校验值", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("采购管理制度"));

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "计划金额" } });
    // 树里的搜索框回车即搜 —— 少一颗按钮。
    fireEvent.submit(view.container.querySelector(".od-tree-search") as any);
    await waitFor(() => expect(view.container.textContent).toContain("找到 1 处"));
    expect(view.container.textContent).toContain("采购制度.docx#p3");
    expect(view.container.textContent).toContain("计划金额按不含税采购预算计算");

    fireEvent.click(view.getByRole("button", { name: /采购管理制度 · v1/ }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith("session-1", "ev_1"));
    expect(view.container.textContent).toContain("第三页 · 采购计划");
    expect(view.container.textContent).toContain("原文校验值");
  });

  it("没有命中时明确说没有证据，而不是生成一个看似合理的答案", async () => {
    const api = fakeApi();
    vi.mocked(api.search).mockResolvedValue(searchResult(0));
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.textContent).toContain("采购管理制度"));
    fireEvent.change(view.getByRole("searchbox"), { target: { value: "计划金额" } });
    // 树里的搜索框回车即搜 —— 少一颗按钮。
    fireEvent.submit(view.container.querySelector(".od-tree-search") as any);

    await waitFor(() => expect(view.container.textContent).toContain("没有找到可直接支持这项内容的材料"));
    expect(view.container.textContent).toContain("当前知识库没有证据");
    expect(view.container.textContent).toContain("这不代表业务上一定不存在");
  });

  it("标签拆分会去重并兼容中英文分隔符", () => {
    expect(splitKnowledgeTags("采购, 正式；ERP\n采购")).toEqual(["采购", "正式", "ERP"]);
  });
});

describe("OntoDocument 浏览器 API 边界", () => {
  it("提升材料只提交当前会话文件名，不提交项目、账号或文件路径", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, message: "已保存" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetcher);

    await knowledgeLibraryApi.promote("session/with space", { session_file_name: "制度.docx" });
    const [url, init] = vi.mocked(fetcher).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions/session%2Fwith%20space/documents/promote");
    expect(JSON.parse(String(init.body))).toEqual({ session_file_name: "制度.docx" });
    expect(String(init.body)).not.toMatch(/project|owner|path/iu);
  });
});
