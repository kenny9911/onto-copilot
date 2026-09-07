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
    publish: vi.fn(async () => ({ ok: true, message: "已设为通用知识" })),
    reparse: vi.fn(async () => ({ ok: true, message: "已重新解析，读出 12 段可检索正文（存为新的一版）。" })),
    // 用户手工建的文件夹。树上的分组来自这里，不再是「按标签推出来的」。
    listFolders: vi.fn(async () => [
      { path: "制度", created_at: "2026-09-03T00:00:00.000Z" },
      { path: "制度/采购", created_at: "2026-09-03T00:00:00.000Z" },
      { path: "空文件夹", created_at: "2026-09-03T00:00:00.000Z" },
    ]),
    createFolder: vi.fn(async (_s: string, path: string) => [{ path, created_at: "2026-09-03T00:00:00.000Z" }]),
    renameFolder: vi.fn(async () => ({ ok: true, message: "已重命名" })),
    deleteFolder: vi.fn(async () => ({ ok: true, message: "文件夹已删除；里面的 0 份材料移到了根目录，没有删除。" })),
    moveDocument: vi.fn(async () => ({ ok: true, message: "已移动" })),
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
    // 库里有东西就直接摊开第一份的正文。
    //
    // 右栏原来的默认是一句「在左边选一份材料，正文就显示在这里」—— 一整栏的空话，
    // 在这一页最宽的那块地方写着「你还没做够」。第一次打开的人想干的事是**看看
    // 里面有什么**，不是先学会这一页的操作方式。
    expect(container.querySelector(".od-preview-idle")).toBeNull();
    expect(container.querySelector(".od-file.on")?.textContent).toContain("采购管理制度");
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

  it("树上的文件夹是用户建的，不是按标签推出来的 —— 空文件夹也在", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-file-name")).not.toBeNull());

    expect(api.listFolders).toHaveBeenCalledWith("session-1");
    const names = [...view.container.querySelectorAll(".od-folder-name")].map((n) => n.textContent);
    // 「空文件夹」里一份材料都没有，按标签推分组时它根本不会出现 —— 这正是
    // 「用户手工建文件夹」和「按标签分组」的分界线。
    expect(names).toContain("空文件夹");
    // 子文件夹显示的是最后一段，不是整条路径；层级靠缩进表达。
    expect(names).toContain("采购");
    expect(names).toContain("制度");
  });

  it("新建文件夹就地展开一行，并说清楚会建在哪儿", async () => {
    // 原来这里用的是 window.prompt。它在这个产品上有两个硬问题：弹窗盖在页面
    // **之外**，用户看不见自己正在哪个文件夹下面建；而且它不进无障碍树、
    // 在自动化里只能靠 spy 假装。就地展开一行，两个问题一起没了。
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-folder-name")).not.toBeNull());

    fireEvent.click(view.getByText("新建文件夹"));
    const draft = view.container.querySelector(".od-folder-draft") as HTMLElement;
    expect(draft).not.toBeNull();
    // 「建在哪儿」必须写在屏幕上，不能只存在于用户的记忆里。
    expect(draft.textContent).toContain("建在根目录");

    fireEvent.change(draft.querySelector("input") as HTMLInputElement, { target: { value: "台账" } });
    fireEvent.click(view.getByText("建好"));
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith("session-1", "台账"));
  });

  it("删除文件夹的后果和按钮同屏，且默认不删", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-folder-name")).not.toBeNull());

    fireEvent.click(view.getAllByText("删除")[0]!);
    // 「材料会移到根目录，不会被删除」这句话正是他不敢点那个按钮的原因，
    // 所以它必须和确认按钮在同一块屏幕上 —— 不是一个只能读一遍的 confirm 弹窗。
    const confirmRow = view.container.querySelector(".od-folder-confirm") as HTMLElement;
    expect(confirmRow).not.toBeNull();
    expect(confirmRow.textContent).toContain("一份都不会被删");
    expect(api.deleteFolder).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("删掉文件夹"));
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalled());
  });

  it("读不出正文时不瞎猜原因，并给出重新解析的出路", async () => {
    // 现场（2026-09-07 用户截图）：点开一个 .json，正文区写着
    // 「它可能是扫描件，需要先做识别。」—— 一个纯文本格式，永远不可能是扫描件。
    // 这不只是文案难看：它把人引向一条根本不存在的路（去哪儿"做识别"？），
    // 而真正的原因（入库那天的解析器读不了这个形状）一个字都没说。
    const api = fakeApi();
    api.read = vi.fn(async () => ({
      document: documentRow, version: versions[0]!, level: "project" as const,
      chunks: [], total: 0, offset: 0,
    })) as never;
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-library-empty")).not.toBeNull());

    const empty = view.container.querySelector(".od-library-empty") as HTMLElement;
    expect(empty.textContent).not.toContain("扫描件");
    expect(empty.textContent).toContain("没有读出可检索的正文");

    fireEvent.click(view.getByText("重新解析这份材料"));
    await waitFor(() => expect(api.reparse).toHaveBeenCalledWith("session-1", "doc-1"));
  });

  it("「设为通用参考」要先确认，并说清楚撤不回来", async () => {
    // 这是这一屏**唯一不可逆**的动作：service.ts 里根本没有 unpublish。
    // 而它以前是一颗裸链接，解释只写在 title 里（触屏永远看不见），
    // 一键就把材料复制进跨项目共享的库。
    //
    // 对比之下，拖动归类（folder_path 不进检索语料、不进流水线，改了不影响任何
    // 输出）反而是可逆的。这两者的界面权重必须和它们的后果一致，否则用户会
    // 反推出一个正好相反的因果模型。
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-preview-head")).not.toBeNull());

    fireEvent.click(view.getByText("设为通用参考"));
    const confirm = view.container.querySelector(".od-publish-confirm") as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain("撤不回来");
    expect(confirm.textContent).toContain("所有项目");
    // 只是打开确认行，还没有真的发出去。
    expect(api.publish).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("确认设为通用参考"));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("session-1", "doc-1"));
  });

  it("确认行上点「先不要」不会发出去", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-preview-head")).not.toBeNull());
    fireEvent.click(view.getByText("设为通用参考"));
    fireEvent.click(view.getByText("先不要"));
    expect(view.container.querySelector(".od-publish-confirm")).toBeNull();
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("拖一份材料到文件夹上就移过去了", async () => {
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-file")).not.toBeNull());

    const row = view.container.querySelector(".od-file") as HTMLElement;
    expect(row.getAttribute("draggable")).toBe("true");
    // 行是 treeitem 不是 button：HTML 不许 button 套 button，而行上要挂 ⋯ 菜单。
    expect(row.getAttribute("role")).toBe("treeitem");

    const folder = view.container.querySelector(".od-folder") as HTMLElement;
    fireEvent.dragStart(row);
    fireEvent.dragOver(folder);
    fireEvent.drop(folder);
    await waitFor(() => expect(api.moveDocument).toHaveBeenCalled());
  });

  it("拖不了的时候有一条等价的路 —— 触屏和键盘都够得着", async () => {
    // HTML5 拖拽在触屏上根本不发 dragstart，键盘更没有；而窄屏会把这一页压成单列，
    // 是常见形态不是边角情况。所以拖拽**不能是唯一的路**。
    const api = fakeApi();
    const view = render(<KnowledgeLibrary sessionId="session-1" sessionFiles={[]} api={api} />);
    await waitFor(() => expect(view.container.querySelector(".od-file")).not.toBeNull());

    fireEvent.click(view.container.querySelector(".od-file-menu") as HTMLElement);
    const pick = view.container.querySelector(".od-move-pick") as HTMLElement;
    expect(pick).not.toBeNull();
    // 「根目录」在页面上有两处（这个选择条，和右栏那个「移动到」下拉的选项），
    // 所以从这个条里找，不用全局 getByText。
    const root = [...pick.querySelectorAll("button")].find((b) => b.textContent === "根目录")!;
    fireEvent.click(root);
    await waitFor(() => expect(api.moveDocument).toHaveBeenCalledWith("session-1", expect.any(String), ""));
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
