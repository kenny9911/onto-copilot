import { afterEach, describe, expect, it, vi } from "vitest";

import { managedToolRegistrar } from "../src/catalog/tools.js";
import { setDocumentServiceForTests } from "../src/document/deps.js";
import { DocumentError } from "../src/document/types.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { Recorder } from "../src/kernel/recorder.js";
import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { extractGroundingEvidence } from "../src/onto/converse.js";
import { root } from "../src/server/session.js";
import { ChatCtx } from "../src/server/dialogue/ctx.js";
import {
  authorizeDocumentToolsForTurn,
  hasExplicitDocumentWriteIntent,
  isPureDocumentManagementRequest,
  registerDocumentDialogueTools,
} from "../src/server/dialogue/document_tools.js";

type Dict = Record<string, unknown>;

const documentRow = (over: Dict = {}) => ({
  id: "doc_1",
  projectId: "project_A",
  owner: "alice",
  title: "采购规则",
  logicalName: "purchase-rules",
  sourceClass: "imported",
  tags: ["采购", "规则"],
  status: "active",
  currentVersionId: "ver_2",
  adoptedVersionId: "ver_1",
  revision: 3,
  createdBy: "alice",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T01:00:00.000Z",
  ...over,
});

const hit = {
  evidenceRef: "odoc.v1.doc_1.ver_1.body",
  displayCite: "采购规则（v1，正文）",
  // 层级是 DocumentSearchHit 的必填字段（types.ts:296）。桩少了它，测试就测不出
  // 「模型看不看得见层级」—— 而那正是这个产品最不能出的错所在的那条轴。
  level: "project" as const,
  documentId: "doc_1",
  versionId: "ver_1",
  versionNo: 1,
  documentTitle: "采购规则",
  fileName: "采购规则.txt",
  chunkId: "body",
  locator: { section: "正文", line: 1 },
  text: "采购金额超过 100 万元时需要总经理审批。",
  textSha256: "a".repeat(64),
  score: 0.95,
  coverage: { matched: 3, total: 3, ratio: 1 },
  context: "上一段\n采购金额超过 100 万元时需要总经理审批。\n下一段",
  tags: ["body"],
};

function fixture() {
  const service = {
    list: vi.fn(async () => [documentRow()]),
    listAttachments: vi.fn(async () => [{
      sessionId: "session_1", projectId: "project_A", owner: "alice",
      documentId: "doc_1", versionId: "ver_1", role: "reference", attachedBy: "alice",
      attachedAt: "2026-09-01T00:00:00.000Z",
    }]),
    // 两级检索：模型工具现在打的是 searchLayered（项目库 + 公共库并成一份语料）。
    searchLayered: vi.fn(async (_scopes: unknown, input: Dict) => ({
      query: String(input["query"] ?? ""),
      hits: [hit],
      total: 1,
      searchedVersions: ["ver_1"],
      coverage: { matchedTerms: ["采购"], missingTerms: [], queryTerms: 1, ratio: 1 },
    })),
    // 通读整篇：document.read 打的是它。
    read: vi.fn(async (_scope: unknown, _documentId: string, options: Dict = {}) => {
      const offset = Number(options["offset"] ?? 0);
      const limit = Number(options["limit"] ?? 30);
      return {
        document: documentRow(),
        version: { id: "ver_1", versionNo: 1 },
        level: "project" as const,
        chunks: offset === 0 && limit > 0 ? [hit] : [],
        total: 1,
        offset,
      };
    }),
    listFolders: vi.fn(async () => []),
    search: vi.fn(async (_scope: unknown, input: Dict) => ({
      query: String(input["query"] ?? ""),
      searchedVersions: ["ver_1"],
      coverage: { ready: 1, degraded: 0, failed: 0 },
      hits: [hit],
    })),
    open: vi.fn(async () => hit),
    history: vi.fn(async (_scope: unknown, _documentId: string) => [{
      id: "ver_1", documentId: "doc_1", versionNo: 1, fileName: "采购规则.txt",
      mediaType: "text/plain", sizeBytes: 42, sha256: "a".repeat(64), relPath: "docs/v1.txt",
      docKind: "text", parseStatus: "ready", parserName: "test", parserVersion: "test-v1",
      indexRevision: "idx-1", chunkCount: 1, createdBy: "alice",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      id: "ver_2", documentId: "doc_1", versionNo: 2, fileName: "采购规则-v2.txt",
      mediaType: "text/plain", sizeBytes: 43, sha256: "c".repeat(64), relPath: "docs/v2.txt",
      docKind: "text", parseStatus: "ready", parserName: "test", parserVersion: "test-v1",
      indexRevision: "idx-2", chunkCount: 1, createdBy: "alice",
      createdAt: "2026-09-01T01:00:00.000Z",
    }]),
    attach: vi.fn(async (_scope: unknown, _session: unknown, input: Dict) => ({
      documentId: String(input["documentId"]), versionId: String(input["versionId"]),
      role: String(input["role"]),
    })),
    detach: vi.fn(async () => true),
    manifest: vi.fn(async () => [{
      project_id: "project_A", document_id: "doc_1", version_id: "ver_1", role: "primary",
    }]),
    // attach 之后正文要当场进证据索引 —— 只写挂载行不加载，会让严格材料门认定
    // 「证据存在」却检索不到。这个桩返回空 documents：这里断言的是加载被调到、
    // 且 manifest 用的是加载时重新裁决的那一份，不是切片内容本身。
    loadAttachedParsedDocs: vi.fn(async () => ({
      documents: [],
      manifest: [{
        project_id: "project_A", document_id: "doc_1", version_id: "ver_1", role: "primary",
      }],
    })),
    promoteSessionFile: vi.fn(async (_scope: unknown, _input: Dict) => ({
      deduplicated: false,
      document: documentRow({ currentVersionId: "ver_3", revision: 4 }),
      version: {
        id: "ver_3", versionNo: 3, sha256: "b".repeat(64), parseStatus: "ready", chunkCount: 1,
      },
    })),
    updateMetadata: vi.fn(async () => documentRow({ title: "采购规则（确认版）", revision: 4 })),
    adopt: vi.fn(async () => documentRow({ adoptedVersionId: "ver_2", revision: 4 })),
    archive: vi.fn(async (_scope: unknown, _id: string, input: Dict) =>
      documentRow({ status: input["archived"] ? "archived" : "active", revision: 4 })),
  };
  setDocumentServiceForTests(service as never);

  const session = {
    id: "session_1",
    projectId: "project_A",
    owner: "alice",
    // 知识库写入之后要发一条 document.changed，界面靠它知道「刚才库里变了」。
    // 桩里必须有它，否则 announceDocumentChange 的 catch 会把缺失悄悄吃掉，
    // 测试也就永远看不出这条通道断没断。
    emitDurable: vi.fn(async (kind: string, payload?: Dict) => ({ kind, payload, seq: 1 })),
    state: {} as Dict,
    files: [{
      name: "采购规则.txt",
      path: `${root()}/session_1/materials/采购规则.txt`,
      size: 42,
      sha256: "b".repeat(64),
    }],
  } as any;
  const deps = { persist: vi.fn(async () => undefined) } as any;
  const registry = new ToolRegistry();
  registerDocumentDialogueTools(managedToolRegistrar(registry, "dialogue"), session, deps);
  const call = async (
    name: string,
    args: Dict,
    id = "turn_1",
    approved = false,
    scope = "converse",
  ) => await registry.call(name, args, new ChatCtx({ turnId: id, approved }), { scope });
  return { service, session, deps, registry, call };
}

afterEach(() => setDocumentServiceForTests(null));

describe("OntoDocument dialogue harness", () => {
  it("区分纯知识库管理与管理后继续分析", () => {
    expect(isPureDocumentManagementRequest("请把这个版本固定到当前会话供本次梳理使用")).toBe(true);
    expect(isPureDocumentManagementRequest("请把采购规则.txt保存到项目知识库，供后续分析")).toBe(true);
    expect(isPureDocumentManagementRequest("请把文档标题改成确认版，便于后续分析")).toBe(true);
    expect(isPureDocumentManagementRequest("请把这个版本关联到会话，然后分析采购规则")).toBe(false);
    expect(isPureDocumentManagementRequest("保存到知识库并总结这份材料")).toBe(false);
    expect(isPureDocumentManagementRequest("请分析这份文档，不要归档它")).toBe(false);
  });
  it("十三个工具的 scopes 与 danger 固定：七个只读双模式、六个写入仅工作模式", () => {
    const { registry } = fixture();
    const rows = registry.registrationSnapshot().filter((row) => row.name.startsWith("document."));
    expect(rows).toEqual([
      { name: "document.attach", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.detach", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      // 看目录结构。只读 —— 建文件夹、移动材料仍然只能是人点的：那是用户对自己
      // 材料的编排意图，模型可以建议但不该代做。
      { name: "document.folders", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.history", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.list", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.manage", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.open", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.promote", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      // 批量入库：用户说「把这些／全部材料收进知识库」时用它。名单在签发能力票
      // 那一刻冻死 —— 这不是放宽「不许猜目标」，「本次会话里所有还没入库的材料」
      // 本来就是个确定集合。
      { name: "document.promote_batch", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      // 通读正文。在它之前模型只有 search（要关键词）和 open（要已有的
      // evidence_ref）—— 一份没猜中关键词的材料，对模型等于不存在，而它会把
      // 自己的盲区说成「本次检索没有命中」。
      { name: "document.read", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      // 文档记忆的读侧。跨会话保留，所以聊天模式也给 —— 「上次是怎么定的」
      // 这种问题在纯聊天里问得最多。
      { name: "document.recall_knowledge", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
      // 写侧。写进去的永远是 draft（wiki.ts:420「AI 没有能创建 confirmed 的 API」），
      // 所以它不需要能力票：它改不了任何已确认的事实，人不点确认它就只是一条待审的
      // 草稿。这和 question.answer「当前作答即授权」是同一类判断。
      { name: "document.remember", danger: "WRITE_LOCAL", scopes: ["converse"], origin: "builtin", fingerprint: expect.any(String) },
      { name: "document.search", danger: "READ", scopes: ["converse", "chat"], origin: "builtin", fingerprint: expect.any(String) },
    ]);
    expect(registry.forScope("chat").filter((tool) => tool.spec.name.startsWith("document.")))
      .toHaveLength(7);
    expect(registry.forScope("converse").filter((tool) => tool.spec.name.startsWith("document.")))
      .toHaveLength(13);
    expect(registry.get("document.search", "chat").spec.danger).toBe(Danger.READ);
  });

  it("list/search/open/read/folders/history 返回稳定结构；search/open 可直接进入 grounding 白名单", async () => {
    const { call } = fixture();
    const listed = await call("document.list", {}, "read-list", false, "chat") as Dict;
    expect(listed).toMatchObject({
      ok: true,
      count: 1,
      documents: [{
        document_id: "doc_1",
        current_version_id: "ver_2",
        adopted_version_id: "ver_1",
        attached_version_id: "ver_1",
        selected_version_no: 1,
        readable_status: "已读入",
        searchable_chunks: 1,
        status: "使用中",
      }],
    });

    const searched = await call("document.search", { query: "100 万元" }, "read-search", false, "chat") as Dict;
    expect(searched).toMatchObject({
      ok: true,
      searched_versions: ["ver_1"],
      hits: [{
        evidence_ref: hit.evidenceRef,
        cite: hit.displayCite,
        document_id: "doc_1",
        version_id: "ver_1",
        locator: hit.locator,
        text: hit.text,
        text_sha256: hit.textSha256,
      }],
    });
    expect(extractGroundingEvidence("document.search", searched)).toEqual([
      { cite: hit.evidenceRef, text: hit.text },
    ]);
    // 层级必须逐条出现在模型看得见的字段里。
    //
    // types.ts:293 的注释把理由写死了：两级合并之后一次结果里同时有总库和项目库
    // 的片段，让调用方从作用域反推，就会把行业通用制度说成客户自己的规定。
    // 这里曾经一条都没带 —— HTTP 侧（routes/documents.ts:856）一直带，于是同一份
    // 数据在人眼前分了层、在模型眼前没分，而正是模型在替人转述这些内容。
    //
    // 「层级也编在 evidence_ref 的 odoc.v2.<level> 段里」不算数：那是一个 id，
    // 把承诺挂在「模型自己会去解析 id」上，等于没有承诺。
    expect((searched["hits"] as Dict[])[0]).toMatchObject({
      level: "project",
      level_label: "项目库",
    });
    expect(searched["total"]).toBe(1);

    const opened = await call("document.open", { evidence_ref: hit.evidenceRef }, "read-open", false, "chat") as Dict;
    expect(opened).toMatchObject({
      ok: true,
      evidence: {
        evidence_ref: hit.evidenceRef,
        cite: hit.displayCite,
        document_id: "doc_1",
        version_id: "ver_1",
        text: hit.text,
        context: hit.context,
      },
    });
    expect(extractGroundingEvidence("document.open", opened)).toEqual([
      { cite: hit.evidenceRef, text: hit.text },
    ]);

    // document.read：通读。这是「分析文档」那一类唯一的工具 —— 没有它，一份没被
    // 关键词命中的材料对模型等于不存在。
    const readPage = await call("document.read", { document_id: "doc_1", limit: 1 }, "read-read", false, "chat") as Dict;
    expect(readPage).toMatchObject({
      ok: true,
      document_id: "doc_1",
      total: 1,
      offset: 0,
      returned: 1,
      level: "project",
      chunks: [{ evidence_ref: hit.evidenceRef, text: hit.text, text_sha256: hit.textSha256 }],
    });
    // 读完了就说读完了；没读完要给出下一页的 offset，不能让模型以为这就是全部。
    expect(String(readPage["note"])).toContain("已读完全部");

    const folders = await call("document.folders", {}, "read-folders", false, "chat") as Dict;
    expect(folders).toMatchObject({ ok: true, root_count: 1, folders: [] });

    const history = await call("document.history", { document_id: "doc_1" }, "read-history", false, "chat") as Dict;
    expect(history).toMatchObject({
      ok: true,
      document: { document_id: "doc_1", revision: 3 },
      versions: [
        { version_id: "ver_1", parse_status: "ready", chunk_count: 1 },
        { version_id: "ver_2", parse_status: "ready", chunk_count: 1 },
      ],
    });
  });

  it("模型改完知识库要发 document.changed —— 界面靠它知道刚才库里变了", async () => {
    const { call, session } = fixture();
    // 这条通道以前**整条不存在**：模型 promote 成功之后服务端什么也不发，
    // 前端 sse.ts 十三条分支里没有一条和 document 有关。于是知识库页开着的时候，
    // 刚存进去的材料不会出现在左边的树里，用户只能自己去点刷新 ——
    // 而他刚刚明明看见系统说改好了。
    await authorizeDocumentToolsForTurn(session, "turn_promote", "请把采购规则.txt保存到项目知识库");
    await call("document.promote", { session_file_name: "采购规则.txt" }, "turn_promote");
    const emitted = session.emitDurable.mock.calls.find((row: unknown[]) => row[0] === "document.changed");
    expect(emitted).toBeDefined();
    expect(emitted![1]).toMatchObject({ action: "promote" });
  });

  it("要求存进「通用知识库」时，回执直说只能进项目库、公共库怎么走", async () => {
    // 模型没有写公共库的工具，这是刻意的（公共库跨项目共享，自动生长三个月就是
    // 垃圾场）。但「做不了」和「说不清为什么做不了」是两回事：现场用户说
    // 「放进通用的知识库里」，模型回的是「未被授予写入和归档权限」——
    // 一句既不准确又没出路的话，而东西其实**已经**进了项目库。
    const { call, session } = fixture();
    await authorizeDocumentToolsForTurn(session, "turn_g", "请把采购规则.txt放进通用的知识库里");
    const out = await call("document.promote", { session_file_name: "采购规则.txt" }, "turn_g") as Dict;
    expect(out["ok"]).toBe(true);
    const message = String(out["message"] ?? "");
    // 三件事都要说：进了哪儿、为什么不是公共库、公共库怎么进。
    expect(message).toContain("项目知识库");
    expect(message).toContain("公共");
    expect(message).toContain("设为通用知识");
  });

  it("没提公共库时不加这段话 —— 免得每次入库都念一遍", async () => {
    const { call, session } = fixture();
    await authorizeDocumentToolsForTurn(session, "turn_p", "请把采购规则.txt保存到项目知识库");
    const out = await call("document.promote", { session_file_name: "采购规则.txt" }, "turn_p") as Dict;
    expect(String(out["message"] ?? "")).not.toContain("设为通用知识");
  });

  it("层级缺失时 fail closed —— 绝不把来路不明的片段说成客户自己的规定", async () => {
    const { call, service } = fixture();
    // 造一条没有 level 的命中。类型上不该发生，但 levelLabel 的实现是
    // `level === "global" ? "总库" : "项目库"` —— 任何非 global 的值（包括
    // undefined）都会被说成「项目库」。在这条轴上 fail open 的后果，是模型把一段
    // 行业通用做法当作这个客户的规定转述出去。
    const { level: _level, ...noLevel } = hit;
    service.searchLayered.mockResolvedValueOnce({
      query: "采购",
      // 类型上 level 是必填的，所以这里必须显式绕过 —— 绕过本身就是这条测试要说的
      // 话：「类型保证不了的时候，运行时也不许猜」。
      hits: [noLevel as unknown as typeof hit],
      total: 1,
      searchedVersions: ["ver_1"],
      coverage: { matchedTerms: ["采购"], missingTerms: [], queryTerms: 1, ratio: 1 },
    });
    const searched = await call("document.search", { query: "采购" }, "read-nolevel", false, "chat") as Dict;
    const first = (searched["hits"] as Dict[])[0]!;
    expect(first["level"]).toBe("unknown");
    expect(String(first["level_label"])).toContain("不要当作客户自己的规定");
  });

  it("crash → revoke → resume：document.search 重新鉴权，不回放撤权前正文", async () => {
    const { registry, service } = fixture();
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const first = new Recorder("document-read-run", journal, blobs);
    const before = await registry.call(
      "document.search",
      { query: "100 万元" },
      new ChatCtx({ turnId: "same-turn", rec: first }),
      { scope: "chat" },
    ) as Dict;
    expect(JSON.stringify(before)).toContain(hit.text);

    service.searchLayered.mockRejectedValueOnce(
      new DocumentError("FORBIDDEN", "ACL 已撤销", 404),
    );
    const resumed = new Recorder("document-read-run", journal, blobs, { resume: true });
    const after = await registry.call(
      "document.search",
      { query: "100 万元" },
      new ChatCtx({ turnId: "same-turn", rec: resumed }),
      { scope: "chat" },
    ) as Dict;

    expect(after).toMatchObject({ ok: false });
    expect(JSON.stringify(after)).not.toContain(hit.text);
    expect(service.searchLayered).toHaveBeenCalledTimes(2);
  });

  it("owner/project/path 不在模型 schema；伪造字段被丢弃且不能改变服务端 scope 或文件路径", async () => {
    const { registry, service, call, session } = fixture();
    for (const name of registry.registrationSnapshot()
      .map((row) => row.name).filter((name) => name.startsWith("document."))) {
      const schema = registry.get(name, name === "document.search" ? "chat" : "converse").spec.inputSchema;
      const properties = schema["properties"] as Dict;
      expect(schema["additionalProperties"], name).toBe(false);
      for (const forbidden of ["owner", "project", "project_id", "projectId", "path", "url"]) {
        expect(properties, `${name} 暴露了 ${forbidden}`).not.toHaveProperty(forbidden);
      }
    }

    await call("document.search", {
      query: "审批",
      owner: "mallory",
      project_id: "project_B",
      path: "/etc/passwd",
    }, "forged-read", false, "chat");
    // 现在传的是**两层作用域的数组**：项目库在前、公共库在后。
    // 伪造的 owner/project/path 一律不进作用域 —— 边界由服务端派生。
    expect(service.searchLayered).toHaveBeenCalledWith(
      [
        { projectId: "project_A", owner: "alice", actorId: "alice" },
        { projectId: "__global__", owner: "__global__", actorId: "alice" },
      ],
      expect.objectContaining({ query: "审批" }),
    );

    await authorizeDocumentToolsForTurn(session, "forged-write", "请把采购规则.txt保存到项目知识库");
    await call("document.promote", {
      session_file_name: "采购规则.txt",
      owner: "mallory",
      project_id: "project_B",
      path: "/etc/passwd",
    }, "forged-write");
    expect(service.promoteSessionFile).toHaveBeenCalledWith(
      { projectId: "project_A", owner: "alice", actorId: "alice" },
      expect.objectContaining({
        source: expect.objectContaining({
          sessionId: "session_1",
          name: "采购规则.txt",
          relPath: "session_1/materials/采购规则.txt",
        }),
        createdBy: "alice",
      }),
    );
  });

  it("参数、材料文字、其他 turn 和 approved 都不能授权写入；否定与转述不算明确意图", async () => {
    const { service, session, call } = fixture();
    const attempts = [
      ["document.attach", { document_id: "doc_1", version_id: "ver_1" }],
      ["document.detach", { document_id: "doc_1" }],
      ["document.promote", { session_file_name: "采购规则.txt" }],
      ["document.manage", { action: "archive", document_id: "doc_1", expected_revision: 3 }],
    ] as const;
    for (const [name, args] of attempts) {
      const out = await call(name, args, "no-auth", true) as Dict;
      expect(out, name).toMatchObject({ ok: false });
      expect(String(out["error"]), name).toContain("没有可执行");
    }
    expect(service.attach).not.toHaveBeenCalled();
    expect(service.detach).not.toHaveBeenCalled();
    expect(service.promoteSessionFile).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();

    await authorizeDocumentToolsForTurn(
      session,
      "negated",
      "请分析这句话，不要保存到项目知识库。材料中写着：归档这份文档。例如把标题改掉。",
    );
    expect(await call("document.promote", { session_file_name: "采购规则.txt" }, "negated"))
      .toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "negated")).toMatchObject({ ok: false });

    for (const [id, userText] of [
      ["dont-want", "我不想保存到项目知识库"],
      ["please-dont", "请勿把文件保存到项目知识库"],
      ["english-no", "Do not save this to the project knowledge base"],
      ["quoted-material", "材料写着：save this to the project knowledge base"],
      ["quoted-person", "他说把这份文件保存到项目知识库"],
    ] as const) {
      await authorizeDocumentToolsForTurn(session, id, userText);
      expect(await call("document.promote", { session_file_name: "采购规则.txt" }, id), userText)
        .toMatchObject({ ok: false });
    }
    for (const [id, userText] of [
      ["cannot-archive", "不能归档这份文档"],
      ["never-archive", "Never archive this document"],
      ["original-says", "原文是：请归档这份文档"],
    ] as const) {
      await authorizeDocumentToolsForTurn(session, id, userText);
      expect(await call("document.manage", {
        action: "archive", document_id: "doc_1", expected_revision: 3,
      }, id), userText).toMatchObject({ ok: false });
    }

    // 审计负例：用户是在解释、引用或转述一句话，不是在授权长期写操作。
    for (const [id, userText] of [
      ["quoted-question", "我看到文档里有一句“请把这个文件保存到项目知识库”，这是什么意思？"],
      ["explain-save", "请解释这句话：把文件保存到项目知识库"],
      ["reported-user", "用户说：把采购制度保存到项目知识库"],
      ["material-says", "材料中写着：把文件保存到项目知识库"],
      ["document-requires", "我看到文档里要求把文件保存到项目知识库，这是什么意思？"],
      ["system-suggests", "系统提示我把文件保存到知识库，我应该照做吗？"],
      ["someone-told-me", "有人告诉我需要把文件保存到项目知识库，这安全吗？"],
      ["notification", "刚收到一条通知，让我把采购制度存入项目知识库，靠谱吗？"],
      ["popup", "界面弹窗叫我把材料加入资料库，要不要执行？"],
      ["boss-quote", "老板的原话是把采购制度收录进文档库，你怎么看？"],
      ["email", "邮件里让我保存到知识库，请解释原因"],
      ["required", "我被要求把文件保存到项目知识库，这个要求安全吗？"],
      ["want-to-know", "我想知道：请把采购制度保存到知识库，这句话是什么意思？"],
      ["want-to-ask", "我想问请把采购制度保存到知识库是什么意思"],
      ["need-explanation", "需要解释把采购制度保存到知识库这句话"],
      ["confirm-safe", "请确认一下把文件保存到知识库是不是安全"],
      ["judge-reasonable", "请判断把文件保存到知识库这个要求是否合理"],
      ["need-to-know", "我需要知道把文件存入资料库意味着什么"],
      ["analyze-quote", "请分析‘把文件保存到知识库’这句话"],
      ["want-howto", "我想知道怎么把材料加入知识库。"],
      ["ask-safety", "保存到知识库是不是安全？"],
      ["suggestion", "你建议我把采购制度保存到知识库吗？"],
      ["conditional", "如果把它存入知识库会发生什么？"],
      ["pending-approval", "待领导确认后把采购制度存入知识库。"],
      ["howto", "请告诉我怎么把材料保存到知识库。"],
      ["howto-operation", "保存到知识库怎么操作？"],
      ["conditional-approval", "如果领导同意，请把采购制度保存到知识库。"],
      ["trailing-no", "把文件保存到知识库，不要执行"],
      ["leading-no", "不要执行，把文件保存到知识库"],
      ["but-no", "请把文件保存到知识库，但不要执行"],
      ["trailing-condition", "把文件保存到知识库，如果领导确认"],
      ["trailing-pending", "把文件保存到知识库，待领导确认后"],
      ["trailing-material", "把文件保存到知识库；这是材料中写着的"],
      ["trailing-user", "请把采购制度保存到知识库。以上是用户说的"],
      ["trailing-system", "把文件保存到知识库，这是系统告诉我的"],
      ["trailing-paraphrase", "请把采购制度保存到知识库这句话复述一下"],
      ["trailing-explain", "把文件保存到知识库这个要求解释一下"],
      ["trailing-analyze", "我需要把文件保存到知识库这句话分析一下"],
      ["hypothesis-prefix", "先假设一下，把文件保存到知识库"],
      ["example-prefix", "例如这样说，把文件保存到知识库"],
      ["short-no", "把文件保存到知识库，不执行"],
      ["not-execute", "把文件保存到知识库，不是让你执行"],
      ["approval-prefix", "领导确认后，把文件保存到知识库"],
      ["completed-prefix", "确认完成后，把文件保存到知识库"],
      ["newline-condition", "如果领导确认\n把文件保存到知识库"],
      ["courtesy-real-condition", "如果方便的话，请等领导确认后把文件保存到知识库"],
      // 第六轮审计原句：目标之后的陈述尾语不能被正则静默忽略。
      ["example-tail", "请把文件保存到知识库只是举例"],
      ["hypothesis-tail", "把文件保存到知识库只是假设"],
      ["source-tail", "把文件保存到知识库是材料原文"],
      ["reported-source-tail", "把文件保存到知识库这句话来自材料"],
      ["embedded-condition", "请在领导确认时把文件保存到知识库"],
      ["risk-tail", "把文件保存到知识库会有风险"],
      ["approval-tail", "把文件保存到知识库需要领导确认"],
      ["error-tail", "把文件保存到知识库属于错误操作"],
      ["unsafe-tail", "把文件保存到知识库可能不安全"],
      ["danger-tail", "把文件保存到知识库是危险操作"],
    ] as const) {
      expect(hasExplicitDocumentWriteIntent(userText), userText).toBe(false);
      await authorizeDocumentToolsForTurn(session, id, userText);
      expect(await call("document.promote", {
        session_file_name: "采购规则.txt",
      }, id), userText).toMatchObject({ ok: false });
    }

    // 同构尾语换动作后仍须拒绝，验证边界来自 full-match，而不是保存词黑名单。
    for (const [id, userText, tool, args] of [
      ["attach-tail", "把当前版本关联到本次分析只是举例", "document.attach", {
        document_id: "doc_1", version_id: "ver_1",
      }],
      ["adopt-tail", "请采用 v2 版本需要领导确认", "document.manage", {
        action: "adopt_version", document_id: "doc_1", expected_revision: 3, version_id: "ver_2",
      }],
      ["archive-tail", "请归档这份文档会有风险", "document.manage", {
        action: "archive", document_id: "doc_1", expected_revision: 3,
      }],
      ["restore-tail", "请恢复这份文档是危险操作", "document.manage", {
        action: "restore", document_id: "doc_1", expected_revision: 3,
      }],
    ] as const) {
      expect(hasExplicitDocumentWriteIntent(userText), userText).toBe(false);
      await authorizeDocumentToolsForTurn(session, id, userText);
      expect(await call(tool, args, id), userText).toMatchObject({ ok: false });
    }

    await authorizeDocumentToolsForTurn(
      session,
      "quote-archive",
      "请引用“归档这份文档”这句话，不要执行",
    );
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "quote-archive")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(
      session,
      "paraphrase-attach",
      "请转述一下“把这个版本挂载到当前会话”这句话",
    );
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1",
    }, "paraphrase-attach")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(session, "right-turn", "请把这个版本关联到当前会话用于本次分析");
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1",
    }, "wrong-turn")).toMatchObject({ ok: false });
  });

  it("明确意图只放行对应写动作；manage 的 metadata/adopt/archive 不能互相借权", async () => {
    const { service, session, call } = fixture();

    await authorizeDocumentToolsForTurn(session, "attach", "请把这个版本关联到当前会话用于本次分析");
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "attach")).toMatchObject({ ok: true });

    await authorizeDocumentToolsForTurn(session, "attach-current", "把当前版本关联到本次分析");
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "attach-current")).toMatchObject({ ok: true });

    await authorizeDocumentToolsForTurn(session, "detach", "请停止使用这个项目文档并取消关联");
    expect(await call("document.detach", { document_id: "doc_1" }, "detach"))
      .toMatchObject({ ok: true, detached: true });

    await authorizeDocumentToolsForTurn(session, "promote", "请把采购规则.txt保存到项目知识库");
    expect(await call("document.promote", { session_file_name: "采购规则.txt" }, "promote"))
      .toMatchObject({ ok: true, deduplicated: false });

    await authorizeDocumentToolsForTurn(session, "promote-polite", "可以帮我把这份附件存入项目知识库吗？");
    expect(await call("document.promote", { session_file_name: "采购规则.txt" }, "promote-polite"))
      .toMatchObject({ ok: true, deduplicated: false });

    await authorizeDocumentToolsForTurn(session, "metadata", "请把文档标题改成采购规则确认版");
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "metadata")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3,
      title: "采购规则确认版",
    }, "metadata")).toMatchObject({ ok: true });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3,
      title: "采购规则确认版", tags: ["未获授权的标签"],
    }, "metadata")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(session, "adopt", "请采用 v2 版本");
    expect(await call("document.manage", {
      action: "adopt_version", document_id: "doc_1", expected_revision: 3, version_id: "ver_2",
    }, "adopt")).toMatchObject({ ok: true });

    await authorizeDocumentToolsForTurn(session, "archive", "请归档这份文档");
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "archive")).toMatchObject({ ok: true });
    expect(await call("document.manage", {
      action: "restore", document_id: "doc_1", expected_revision: 3,
    }, "archive")).toMatchObject({ ok: false });

    service.list.mockResolvedValueOnce([documentRow({ status: "archived" })]);
    await authorizeDocumentToolsForTurn(session, "restore", "请恢复这份文档");
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "restore")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "restore", document_id: "doc_1", expected_revision: 3,
    }, "restore")).toMatchObject({ ok: true });

    expect(service.attach).toHaveBeenCalledTimes(2);
    expect(service.detach).toHaveBeenCalledTimes(1);
    expect(service.promoteSessionFile).toHaveBeenCalledTimes(2);
    expect(service.updateMetadata).toHaveBeenCalledTimes(1);
    expect(service.adopt).toHaveBeenCalledTimes(1);
    expect(service.archive).toHaveBeenCalledTimes(2);
  });

  it("promote 能力固定会话文件且只允许原样新建，不能换文件、追加版本或自加信息", async () => {
    const { service, session, call, registry } = fixture();
    session.files.push({
      name: "财务制度.txt",
      path: `${root()}/session_1/materials/财务制度.txt`,
      size: 84,
      sha256: "d".repeat(64),
    });
    await authorizeDocumentToolsForTurn(session, "promote-bound", "请把采购规则.txt保存到项目知识库");

    expect(Object.keys(
      registry.get("document.promote", "converse").spec.inputSchema["properties"] as Dict,
    )).toEqual(["session_file_name"]);

    expect(await call("document.promote", {
      session_file_name: "财务制度.txt",
    }, "promote-bound")).toMatchObject({ ok: false });
    expect(await call("document.promote", {
      session_file_name: "采购规则.txt", target_document_id: "doc_1", base_version_id: "ver_2",
    }, "promote-bound")).toMatchObject({ ok: true });
    expect(service.promoteSessionFile).toHaveBeenCalledWith(
      { projectId: "project_A", owner: "alice", actorId: "alice" }, expect.any(Object),
    );
    const promoteInput = service.promoteSessionFile.mock.calls[0]?.[1] as Dict;
    for (const key of ["documentId", "baseVersionId", "title", "logicalName", "sourceClass", "tags"]) {
      expect(promoteInput).not.toHaveProperty(key);
    }
    expect(await call("document.promote", {
      session_file_name: "采购规则.txt",
    }, "promote-bound")).toMatchObject({ ok: false });
    expect(service.promoteSessionFile).toHaveBeenCalledTimes(1);

    await authorizeDocumentToolsForTurn(session, "ambiguous-file", "请把这份附件存入项目知识库");
    expect(await call("document.promote", {
      session_file_name: "采购规则.txt",
    }, "ambiguous-file")).toMatchObject({ ok: false });
  });

  it("metadata 能力固定文档、revision 和用户原句中的精确值，不替用户润色标题", async () => {
    const { service, session, call } = fixture();
    await authorizeDocumentToolsForTurn(session, "title-bound", "请把文档标题改成采购规则确认版");

    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_2", expected_revision: 3,
      title: "采购规则确认版",
    }, "title-bound")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 4,
      title: "采购规则确认版",
    }, "title-bound")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3,
      title: "采购规则（确认版）",
    }, "title-bound")).toMatchObject({ ok: false });
    expect(service.updateMetadata).not.toHaveBeenCalled();

    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3,
      title: "采购规则确认版",
    }, "title-bound")).toMatchObject({ ok: true });
    expect(service.updateMetadata).toHaveBeenCalledWith(
      { projectId: "project_A", owner: "alice", actorId: "alice" }, "doc_1",
      { expectedRevision: 3, title: "采购规则确认版" },
    );
  });

  it("标签添加/删除在签发时计算完整最终集合，不能借 add 权限覆盖或误清空", async () => {
    const { service, session, call } = fixture();
    await authorizeDocumentToolsForTurn(session, "tags-add", "请给文档标签添加合规");
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3, tags: ["合规"],
    }, "tags-add")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3,
      tags: ["采购", "规则", "合规"],
    }, "tags-add")).toMatchObject({ ok: true });

    await authorizeDocumentToolsForTurn(session, "tags-remove", "请删除文档标签规则");
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3, tags: [],
    }, "tags-remove")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3, tags: ["采购"],
    }, "tags-remove")).toMatchObject({ ok: true });

    service.list.mockResolvedValueOnce([documentRow({ tags: ["采购"] })]);
    await authorizeDocumentToolsForTurn(session, "tags-no-clear", "请删除文档标签采购");
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_1", expected_revision: 3, tags: [],
    }, "tags-no-clear")).toMatchObject({ ok: false });
    expect(service.updateMetadata).toHaveBeenCalledTimes(2);
  });

  it("archive/adopt 能力固定 document、version、revision，且一次成功后不能重复消费", async () => {
    const { service, session, call } = fixture();
    await authorizeDocumentToolsForTurn(session, "archive-bound", "请归档这份文档");
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_2", expected_revision: 3,
    }, "archive-bound")).toMatchObject({ ok: false });
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "archive-bound")).toMatchObject({ ok: true });
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "archive-bound")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(session, "adopt-bound", "请采用 v2 版本");
    for (const args of [
      { action: "adopt_version", document_id: "doc_2", expected_revision: 3, version_id: "ver_2" },
      { action: "adopt_version", document_id: "doc_1", expected_revision: 3, version_id: "ver_1" },
      { action: "adopt_version", document_id: "doc_1", expected_revision: 4, version_id: "ver_2" },
    ]) {
      expect(await call("document.manage", args, "adopt-bound")).toMatchObject({ ok: false });
    }
    expect(await call("document.manage", {
      action: "adopt_version", document_id: "doc_1", expected_revision: 3, version_id: "ver_2",
    }, "adopt-bound")).toMatchObject({ ok: true });
    expect(service.archive).toHaveBeenCalledTimes(1);
    expect(service.adopt).toHaveBeenCalledTimes(1);
  });

  it("attach/detach 能力固定文档、版本和角色，不能换目标或借同轮重复调用", async () => {
    const { service, session, call } = fixture();
    await authorizeDocumentToolsForTurn(session, "attach-bound", "请把这个版本关联到当前会话用于本次分析");
    for (const args of [
      { document_id: "doc_2", version_id: "ver_1", role: "reference" },
      { document_id: "doc_1", version_id: "ver_2", role: "reference" },
      { document_id: "doc_1", version_id: "ver_1", role: "primary" },
    ]) {
      expect(await call("document.attach", args, "attach-bound")).toMatchObject({ ok: false });
    }
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "attach-bound")).toMatchObject({ ok: true });
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "attach-bound")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(session, "detach-bound", "请停止使用这个项目文档并取消关联");
    expect(await call("document.detach", { document_id: "doc_2" }, "detach-bound"))
      .toMatchObject({ ok: false });
    service.listAttachments.mockResolvedValueOnce([{
      sessionId: "session_1", projectId: "project_A", owner: "alice",
      documentId: "doc_1", versionId: "ver_2", role: "reference", attachedBy: "alice",
      attachedAt: "2026-09-01T00:00:00.000Z",
    }]);
    expect(await call("document.detach", { document_id: "doc_1" }, "detach-bound"))
      .toMatchObject({ ok: false });
    await authorizeDocumentToolsForTurn(
      session, "detach-bound-role", "请停止使用这个项目文档并取消关联",
    );
    service.listAttachments.mockResolvedValueOnce([{
      sessionId: "session_1", projectId: "project_A", owner: "alice",
      documentId: "doc_1", versionId: "ver_1", role: "primary", attachedBy: "alice",
      attachedAt: "2026-09-01T00:00:00.000Z",
    }]);
    expect(await call("document.detach", { document_id: "doc_1" }, "detach-bound-role"))
      .toMatchObject({ ok: false });
    await authorizeDocumentToolsForTurn(
      session, "detach-bound-exact", "请停止使用这个项目文档并取消关联",
    );
    expect(await call("document.detach", { document_id: "doc_1" }, "detach-bound-exact"))
      .toMatchObject({ ok: true, detached: true });
    expect(service.attach).toHaveBeenCalledTimes(1);
    expect(service.detach).toHaveBeenCalledTimes(1);
  });

  it("多个候选时只按唯一文件名、标题或逻辑名解析；纯指代不签发", async () => {
    const { service, session, call } = fixture();
    const second = documentRow({
      id: "doc_2", title: "财务制度", logicalName: "finance-policy",
      currentVersionId: "fin_ver_1", adoptedVersionId: "fin_ver_1", revision: 8,
    });
    service.list.mockResolvedValue([documentRow(), second]);
    const purchaseHistory = await service.history({}, "doc_1");
    service.history.mockImplementation(async (_scope: unknown, documentId: string) =>
      documentId === "doc_1" ? purchaseHistory : [{
        ...purchaseHistory[0]!, id: "fin_ver_1", documentId: "doc_2", versionNo: 1,
        fileName: "财务制度.txt",
      }]
    );

    // 新标题恰好等于第二份文档标题时，不能把赋值内容误当成目标名称。
    await authorizeDocumentToolsForTurn(session, "value-is-not-target", "请把文档标题改成财务制度");
    expect(await call("document.manage", {
      action: "update_metadata", document_id: "doc_2", expected_revision: 8, title: "财务制度",
    }, "value-is-not-target")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(
      session, "ambiguous-doc", "请把这个版本关联到当前会话用于本次分析",
    );
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "ambiguous-doc")).toMatchObject({ ok: false });

    await authorizeDocumentToolsForTurn(
      session, "title-doc", "请把采购规则关联到当前会话用于本次分析",
    );
    expect(await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "reference",
    }, "title-doc")).toMatchObject({ ok: true });

    await authorizeDocumentToolsForTurn(
      session, "logical-doc", "请把 finance-policy 关联到当前会话用于本次分析",
    );
    expect(await call("document.attach", {
      document_id: "doc_2", version_id: "fin_ver_1", role: "reference",
    }, "logical-doc")).toMatchObject({ ok: true });
    expect(service.attach).toHaveBeenCalledTimes(2);
  });

  it("能力绑定 turn/session/project/owner；任何身份变化都拒绝旧票", async () => {
    const { service, session, call } = fixture();
    await authorizeDocumentToolsForTurn(session, "identity-bound", "请归档这份文档");
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "other-turn")).toMatchObject({ ok: false });

    session.owner = "mallory";
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "identity-bound")).toMatchObject({ ok: false });
    session.owner = "alice";
    session.projectId = "project_B";
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "identity-bound")).toMatchObject({ ok: false });
    session.projectId = "project_A";
    session.id = "session_2";
    expect(await call("document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 3,
    }, "identity-bound")).toMatchObject({ ok: false });
    expect(service.archive).not.toHaveBeenCalled();
  });

  it("attach 成功后刷新 _document_manifest 并持久化；不沿用旧清单", async () => {
    const { service, session, deps, call } = fixture();
    session.state["_document_manifest"] = [{ document_id: "stale" }];
    await authorizeDocumentToolsForTurn(
      session, "attach-refresh", "请把这个版本作为主要材料固定到当前会话供本次梳理使用",
    );
    const out = await call("document.attach", {
      document_id: "doc_1", version_id: "ver_1", role: "primary",
    }, "attach-refresh") as Dict;

    expect(out).toMatchObject({ ok: true, document_id: "doc_1", version_id: "ver_1", role: "primary" });
    expect(service.manifest).toHaveBeenCalledWith({
      sessionId: "session_1", projectId: "project_A", owner: "alice", actorId: "alice",
    });
    expect(session.state["_document_manifest"]).toEqual([{
      project_id: "project_A", document_id: "doc_1", version_id: "ver_1", role: "primary",
    }]);
    expect(deps.persist).toHaveBeenCalledWith(session, { status: false });
  });

  it("授权写入仍经过 Recorder.effect，审计请求只记录清洗后的参数", async () => {
    const { registry, session } = fixture();
    const effects: { nodeId: string; kind: string; request: Dict }[] = [];
    const recorder = {
      emit: vi.fn(),
      effect: vi.fn(async (
        nodeId: string,
        kind: string,
        request: Dict,
        run: () => unknown | Promise<unknown>,
      ) => {
        effects.push({ nodeId, kind, request });
        return await run();
      }),
    };
    await authorizeDocumentToolsForTurn(
      session, "recorded-attach", "请把这个版本作为主要材料固定到当前会话供本次梳理使用",
    );
    const result = await registry.call("document.attach", {
      document_id: "doc_1",
      version_id: "ver_1",
      role: "primary",
      owner: "mallory",
      project_id: "project_B",
      path: "/etc/passwd",
    }, new ChatCtx({ turnId: "recorded-attach", rec: recorder as never }), {
      scope: "converse",
    });

    expect(result).toMatchObject({ ok: true });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      nodeId: "TOOL",
      kind: "tool.call",
      request: {
        tool: "document.attach",
        scope: "converse",
        danger: "WRITE_LOCAL",
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        args: { document_id: "doc_1", version_id: "ver_1", role: "primary" },
      },
    });
  });
});
