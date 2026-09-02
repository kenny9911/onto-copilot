import { afterEach, describe, expect, it } from "vitest";

import { Store } from "../src/store/engine.js";
import type { DocumentScope } from "../src/document/types.js";
import {
  MemoryWikiPageRepository,
  SqlWikiPageRepository,
  type WikiPageRepository,
} from "../src/document/wiki_repository.js";
import { WikiPageService } from "../src/document/wiki_service.js";
import {
  confirmWikiClaim,
  createWikiClaimDraft,
  createWikiPage,
  type WikiActor,
} from "../src/document/wiki.js";

const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const scope: DocumentScope = { projectId: "project_A", owner: "alice" };
const ai: WikiActor = { kind: "ai", id: "onto-copilot" };
const human: WikiActor = { kind: "human", id: "alice" };

function tickingClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 2, 8, 0, tick++)).toISOString();
}

async function repository(kind: "memory" | "sqlite"): Promise<WikiPageRepository> {
  if (kind === "memory") return new MemoryWikiPageRepository();
  const store = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
  stores.push(store);
  return new SqlWikiPageRepository(store);
}

for (const backend of ["memory", "sqlite"] as const) {
  describe(`OntoDocument Wiki persistence · ${backend}`, () => {
    it("项目与 owner 双重隔离；同一个 pageId 可安全存在于三个边界", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      const boundaries: DocumentScope[] = [
        scope,
        { projectId: "project_A", owner: "bob" },
        { projectId: "project_B", owner: "alice" },
      ];
      for (const [index, boundary] of boundaries.entries()) {
        await service.createPage(boundary, {
          id: "same_page",
          title: `边界 ${index}`,
          actor: ai,
          drafts: [{
            kind: "MATERIAL_FACT",
            subject: "来源",
            statement: `只属于 ${boundary.projectId}/${boundary.owner}`,
            evidenceRefs: [`odoc.${index}`],
          }],
        });
      }

      await expect(service.getPage(scope, "same_page")).resolves.toMatchObject({
        owner: "alice",
        page: { projectId: "project_A", title: "边界 0" },
      });
      await expect(service.getPage({ projectId: "project_A", owner: "bob" }, "same_page"))
        .resolves.toMatchObject({ owner: "bob", page: { title: "边界 1" } });
      await expect(service.getPage({ projectId: "project_X", owner: "alice" }, "same_page"))
        .rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    });

    it("每次写入 CAS 增加 revision；旧 revision 无法覆盖新内容", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      const created = await service.createPage(scope, {
        id: "cas",
        title: "CAS 页面",
        actor: ai,
      });
      expect(created.revision).toBe(1);

      const first = await service.addDraft(scope, "cas", {
        expectedRevision: 1,
        kind: "MATERIAL_FACT",
        subject: "采购规则",
        statement: "十万元以上需要审批",
        evidenceRefs: ["odoc.v1.doc.ver.chunk"],
        actor: ai,
      });
      expect(first.revision).toBe(2);

      await expect(service.addDraft(scope, "cas", {
        expectedRevision: 1,
        kind: "INFERENCE",
        subject: "过期写入",
        statement: "这条不能覆盖 revision 2",
        actor: ai,
      })).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        status: 409,
        details: { expectedRevision: 1, actualRevision: 2 },
      });
      expect((await service.getPage(scope, "cas")).page.claims).toHaveLength(1);
    });

    it("AI 经 facade 和 repository 直写两条路径都不能伪造 confirmed", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      const created = await service.createPage(scope, {
        id: "no_hallucination",
        title: "不允许 AI 确认",
        actor: ai,
        drafts: [{
          kind: "INFERENCE",
          subject: "付款周期",
          statement: "可能是 30 天，等待客户确认",
          evidenceRefs: ["odoc.v1.p3"],
        }],
      });
      const claim = created.page.claims[0]!;

      await expect(service.confirmClaim(scope, created.page.id, {
        claimId: claim.id,
        expectedRevision: 1,
        evidenceRefs: ["made-up"],
        actor: ai,
      })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

      const forged = {
        ...claim,
        state: "confirmed" as const,
        confirmation: {
          actor: { kind: "human" as const, id: "fake-human" },
          evidenceRefs: ["fabricated"],
          confirmedAt: "2026-09-02T08:00:10.000Z",
        },
      };
      const forgedPage = createWikiPage({
        ...created.page,
        claims: [forged],
        updatedAt: "2026-09-02T08:00:10.000Z",
      });
      await expect(repo.commit({
        scope,
        pageId: created.page.id,
        expectedRevision: 1,
        page: forgedPage,
        status: "active",
        action: "confirm_claim",
        actor: ai,
        recordedAt: "2026-09-02T08:00:10.000Z",
      })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

      const preConfirmed = confirmWikiClaim(createWikiClaimDraft({
        projectId: scope.projectId,
        kind: "MATERIAL_FACT",
        subject: "绕过创建",
        statement: "即使真人字段完整，也不能在创建页时直接 confirmed",
        author: ai,
        createdAt: "2026-09-02T08:01:00.000Z",
      }), {
        actor: human,
        evidenceRefs: ["customer-answer:q1"],
        confirmedAt: "2026-09-02T08:01:01.000Z",
      });
      const page = createWikiPage({
        id: "preconfirmed",
        projectId: scope.projectId,
        title: "绕过创建",
        claims: [preConfirmed],
        updatedAt: "2026-09-02T08:01:02.000Z",
      });
      await expect(repo.create({
        scope,
        page,
        actor: human,
        createdAt: "2026-09-02T08:01:02.000Z",
      })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("真人确认必须有依据和时间，确认后声明不可原地修改", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      const material = await service.createPage(scope, {
        id: "material_requires_open",
        title: "材料事实",
        actor: ai,
        drafts: [{
          kind: "MATERIAL_FACT",
          subject: "金额上限",
          statement: "金额上限为 100 元",
          evidenceRefs: ["odoc.v1.rule"],
        }],
      });
      await expect(service.confirmClaim(scope, material.page.id, {
        claimId: material.page.claims[0]!.id,
        expectedRevision: 1,
        evidenceRefs: ["odoc.v1.rule"],
        actor: human,
      })).rejects.toThrow(/逐条打开原文/u);

      const created = await service.createPage(scope, {
        id: "confirmation",
        title: "人工确认",
        actor: ai,
        drafts: [{
          kind: "HUMAN_DECISION",
          subject: "审批人",
          statement: "等待业务负责人拍板",
          evidenceRefs: ["odoc.v1.rule"],
        }],
      });
      const claimId = created.page.claims[0]!.id;
      await expect(service.confirmClaim(scope, "confirmation", {
        claimId,
        expectedRevision: 1,
        evidenceRefs: [],
        actor: human,
      })).rejects.toThrow(/至少一条/u);

      const confirmed = await service.confirmClaim(scope, "confirmation", {
        claimId,
        expectedRevision: 1,
        evidenceRefs: ["customer-answer:q-12"],
        actor: human,
      });
      expect(confirmed.page.claims[0]).toMatchObject({
        state: "confirmed",
        confirmation: {
          actor: { kind: "human", id: "alice" },
          evidenceRefs: ["customer-answer:q-12"],
        },
      });
      expect(confirmed.page.claims[0]!.confirmation!.confirmedAt).toBe(confirmed.updatedAt);
      await expect(service.editDraft(scope, "confirmation", {
        claimId,
        expectedRevision: 2,
        statement: "偷偷换一条结论",
        actor: ai,
      })).rejects.toThrow(/不可原地改写/u);

      const history = await service.history(scope, "confirmation");
      expect(history.map((entry) => [entry.revision, entry.action])).toEqual([
        [1, "create"],
        [2, "confirm_claim"],
      ]);
      expect(history.every((entry) => /^[a-f0-9]{64}$/u.test(entry.contentSha256))).toBe(true);
      expect(history[0]!.page.claims[0]!.state).toBe("draft");
      expect(history[1]!.page.claims[0]!.state).toBe("confirmed");
    });

    it("删除语义只能归档：默认列表隐藏但页面与完整历史仍可读取，并可人工恢复", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      await service.createPage(scope, { id: "archive", title: "可归档页面", actor: ai });
      await expect(service.archivePage(scope, "archive", { expectedRevision: 1, actor: ai }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      const archived = await service.archivePage(scope, "archive", { expectedRevision: 1, actor: human });
      expect(archived).toMatchObject({ status: "archived", revision: 2 });
      expect(await service.listPages(scope)).toEqual([]);
      expect(await service.listPages(scope, true)).toHaveLength(1);
      await expect(service.getPage(scope, "archive")).resolves.toMatchObject({ status: "archived" });
      expect((await service.history(scope, "archive")).map((entry) => entry.action)).toEqual([
        "create",
        "archive",
      ]);

      const restored = await service.restorePage(scope, "archive", { expectedRevision: 2, actor: human });
      expect(restored).toMatchObject({ status: "active", revision: 3 });
      expect(await service.listPages(scope)).toHaveLength(1);
    });

    it("Markdown 与 Obsidian 导出复用安全渲染，并默认排除已归档页面", async () => {
      const repo = await repository(backend);
      const service = new WikiPageService(repo, tickingClock());
      const created = await service.createPage(scope, {
        id: "safe_export",
        title: "采购 <script>",
        actor: ai,
        drafts: [{
          kind: "INFERENCE",
          subject: "危险文本",
          statement: "![[secret]] <script>alert(1)</script>",
        }],
      });
      const markdown = await service.renderMarkdown(scope, created.page.id);
      expect(markdown).not.toContain("<script>");
      expect(markdown).toContain("草稿（不可当作已确认事实）");

      const activeVault = await service.buildObsidianVault(scope);
      expect(activeVault.pagePaths[created.page.id]).toBeDefined();
      await service.archivePage(scope, created.page.id, { expectedRevision: 1, actor: human });
      const defaultVault = await service.buildObsidianVault(scope);
      expect(defaultVault.pagePaths[created.page.id]).toBeUndefined();
      const fullVault = await service.buildObsidianVault(scope, { includeArchived: true });
      expect(fullVault.pagePaths[created.page.id]).toBeDefined();
    });
  });
}
