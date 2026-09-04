/**
 * 「文档记忆」这一类的模型侧入口。
 *
 * 用户原话：「我们的Copilot是必须具备搜索文档、管理文档、分析文档、文档记忆
 * 等等功能互动的。」四类里这一类原本是**空的** —— 模型读完一份材料得出的结论，
 * 没有任何一条路能存回去，下一轮、下一个会话都读不到，它每次从零开始。
 *
 * 领域层（document/wiki.ts）其实早就完整：声明分 draft / confirmed 两态，
 * wiki.ts 里那行注释写着「AI 没有能创建 confirmed 的 API」。缺的只是把它接进
 * 模型可调的注册表。这个文件钉的就是**接进去之后那条纪律仍然成立**：
 * 模型能记，但它记下的东西在人点头之前永远只是草稿。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { registerDocumentDialogueTools } from "../src/server/dialogue/document_tools.js";
import { MemoryWikiPageRepository } from "../src/document/wiki_repository.js";
import { WikiPageService } from "../src/document/wiki_service.js";
import { setWikiPageServiceForTests } from "../src/document/wiki_deps.js";
import { setDocumentServiceForTests } from "../src/document/deps.js";
import type { DocumentService } from "../src/document/service.js";

type Dict = Record<string, unknown>;

const SESSION = {
  id: "session_1",
  owner: "alice",
  projectId: "project_A",
  files: [],
  state: {},
} as never;

function fixture() {
  let tick = 0;
  const wiki = new WikiPageService(
    new MemoryWikiPageRepository(),
    () => new Date(Date.UTC(2026, 8, 4, 0, 0, tick++)).toISOString(),
  );
  setWikiPageServiceForTests(wiki);
  // 记忆这一路不碰文档服务，但 registerDocumentDialogueTools 里别的工具要，
  // 而 unavailable() 会去问它在不在。给一个最小桩。
  setDocumentServiceForTests({ list: async () => [] } as unknown as DocumentService);

  const registry = new ToolRegistry();
  registerDocumentDialogueTools(registry, SESSION, {
    projectDirectory: {
      ensureDefaultProject: async () => ({ id: "project_A", name: "我的材料", created: false }),
    },
  } as never);

  const call = async (name: string, args: Dict): Promise<Dict> =>
    await registry.get(name, "converse").run(args, { turnId: "t1" } as never) as Dict;
  return { wiki, registry, call };
}

beforeEach(() => {
  setWikiPageServiceForTests(null);
  setDocumentServiceForTests(null);
  vi.restoreAllMocks();
});

describe("文档记忆：模型能记，但记的永远是草稿", () => {
  it("记一条推断，再读回来 —— 这是「跨轮不再从零开始」的最小闭环", async () => {
    const { call } = fixture();
    const written = await call("document.remember", {
      subject: "付款账期",
      statement: "这家客户的付款账期实际执行的是验收后 30 天，与合同模板写的月结不一致。",
      kind: "INFERENCE",
    });
    expect(written["ok"]).toBe(true);
    expect(written["state"]).toBe("draft");
    expect(written["page_title"]).toBe("项目知识");

    const recalled = await call("document.recall_knowledge", {});
    expect(recalled["count"]).toBe(1);
    expect(recalled["confirmed_count"]).toBe(0);
    const claims = recalled["claims"] as Dict[];
    expect(claims[0]).toMatchObject({
      subject: "付款账期",
      kind: "INFERENCE",
      kind_label: "待验证推断",
      state: "draft",
      author: "ai",
    });
  });

  it("material_fact 没有出处就拒绝，并指出该改成哪一类", async () => {
    const { call } = fixture();
    const refused = await call("document.remember", {
      subject: "验收期限",
      statement: "验收期限是 3 个工作日。",
      kind: "MATERIAL_FACT",
    });
    // 拦在这里而不是等确认环节：模型这一刻还记得自己刚读过哪一段，补一个
    // evidence_ref 是举手之劳；等人去确认时才发现没出处，那条草稿基本就废了。
    expect(refused["ok"]).toBe(false);
    expect(String(refused["error"])).toContain("evidence_ref");
    expect(String(refused["error"])).toContain("INFERENCE");
  });

  it("带了出处的 material_fact 能记下来，出处原样留着", async () => {
    const { call } = fixture();
    const ref = "odoc.v2.project.doc_1.ver_1.body";
    const written = await call("document.remember", {
      subject: "验收期限",
      statement: "到货 3 个工作日内完成验收。",
      kind: "MATERIAL_FACT",
      evidence_refs: [ref],
    });
    expect(written["ok"]).toBe(true);

    const claims = (await call("document.recall_knowledge", {}))["claims"] as Dict[];
    expect(claims[0]!["evidence_refs"]).toEqual([ref]);
  });

  it("模型写不出 confirmed —— 不管它怎么说，落库的都是 draft", async () => {
    const { call, wiki } = fixture();
    // 这是这一类功能的**核心安全性质**：记忆一旦能被模型自己标成「已确认」，
    // 下一轮它就会引用自己昨天的猜测，而且引用时带着「人确认过」的分量。
    // schema 里根本没有 state 通道，多传的字段会被丢掉。
    await call("document.remember", {
      subject: "审批门槛",
      statement: "超过 100 万元需要总经理审批。",
      kind: "INFERENCE",
      state: "confirmed",
      confirmation: { actor: { kind: "human", id: "alice" } },
    } as Dict);

    const pages = await wiki.listPages({ projectId: "project_A", owner: "alice", actorId: "alice" }, false);
    const claim = pages[0]!.page.claims[0]!;
    expect(claim.state).toBe("draft");
    expect(claim.confirmation).toBeNull();
    expect(claim.author).toEqual({ kind: "ai", id: "copilot" });
  });

  it("同一页反复记，不会每次新建一页", async () => {
    const { call, wiki } = fixture();
    await call("document.remember", { subject: "口径 A", statement: "甲。", kind: "INFERENCE" });
    await call("document.remember", { subject: "口径 B", statement: "乙。", kind: "INFERENCE" });
    const pages = await wiki.listPages({ projectId: "project_A", owner: "alice", actorId: "alice" }, false);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page.claims.map((c) => c.subject)).toEqual(["口径 A", "口径 B"]);
  });

  it("读回来的说明里点名草稿不算已确认口径", async () => {
    const { call } = fixture();
    await call("document.remember", { subject: "口径", statement: "甲。", kind: "INFERENCE" });
    const recalled = await call("document.recall_knowledge", {});
    // 记忆功能最容易长出来的幻觉回路，是模型下一轮把自己写的草稿当成已确认事实
    // 引用。工具结果这句话是唯一挡在中间的东西。
    expect(String(recalled["note"])).toContain("还没被确认");
  });

  it("写侧只在工作模式可见，读侧两种模式都在", () => {
    const { registry } = fixture();
    expect(registry.get("document.recall_knowledge", "chat").spec.danger).toBe(Danger.READ);
    expect(() => registry.get("document.remember", "chat")).toThrow();
  });
});
