import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import {
  WIKI_CLAIM_KINDS,
  buildObsidianVault,
  checkWikiMaterialFactSupport,
  confirmWikiClaim,
  createClaimStateDraft,
  createWikiClaimDraft,
  createWikiPage,
  renderWikiMarkdown,
  writeObsidianVault,
  type ObsidianVaultBundle,
  type WikiClaim,
  type WikiClaimKind,
} from "../src/document/wiki.js";

const roots: string[] = [];
const NOW = "2026-09-02T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function draft(kind: WikiClaimKind = "MATERIAL_FACT", statement = "审批金额来自客户材料"): WikiClaim {
  return createWikiClaimDraft({
    projectId: "project_A",
    kind,
    subject: "采购审批",
    statement,
    evidenceRefs: ["odoc.v1.doc.ver.chunk"],
    author: { kind: "ai", id: "onto-copilot" },
    createdAt: NOW,
  });
}

function page(id: string, title: string, claims: readonly WikiClaim[] = []): ReturnType<typeof createWikiPage> {
  return createWikiPage({
    id,
    projectId: "project_A",
    title,
    summary: "项目知识",
    tags: ["采购"],
    claims,
    updatedAt: NOW,
  });
}

describe("OntoDocument project Wiki and Obsidian export", () => {
  it("材料事实只接受原文逐字命中或关键数值与用词同时覆盖，不拿真实但无关引用背书", () => {
    const related = checkWikiMaterialFactSupport("金额上限为 100 元", [{
      evidenceRef: "odoc.v1.doc.ver.amount",
      text: "现行规则：金额上限 100 元。",
      versionState: "adopted",
    }]);
    expect(related).toMatchObject({ supported: true, method: "critical_values_and_coverage" });

    const unrelated = checkWikiMaterialFactSupport("合同必须由董事会审批", [{
      evidenceRef: "odoc.v1.doc.ver.amount",
      text: "现行规则：金额上限 100 元。",
      versionState: "adopted",
    }]);
    expect(unrelated.supported).toBe(false);

    const wrongNumber = checkWikiMaterialFactSupport("金额上限为 200 元", [{
      evidenceRef: "odoc.v1.doc.ver.amount",
      text: "采购规则：金额上限 100 元。",
      versionState: "adopted",
    }]);
    expect(wrongNumber).toMatchObject({ supported: false, missingCriticalValues: ["200元"] });

    const wrongActorInLongClaim = checkWikiMaterialFactSupport(
      "采购申请必须由董事长审批后才能提交付款",
      [{
        evidenceRef: "odoc.v1.doc.ver.process",
        text: "采购申请必须由总经理审批后才能提交付款。",
        versionState: "adopted",
      }],
    );
    expect(wrongActorInLongClaim).toMatchObject({
      supported: false,
      missingTerms: expect.arrayContaining(["董事", "事长"]),
    });

    for (const text of [
      "培训材料举例：“合同必须由董事会审批”是错误答案。",
      "不要采用“合同必须由董事会审批”这条旧规则。",
      "有人问：合同必须由董事会审批吗？尚未确认。",
      "过去曾规定合同必须由董事会审批，但后来废除了。",
      "合同必须由董事会审批——这项要求现已失效。",
      "这句话有误：合同必须由董事会审批。",
      "测试用例内容：合同必须由董事会审批。",
      "以下规则不再适用。合同必须由董事会审批。",
      "合同必须由董事会审批。以上内容已废除。",
      "旧规则如下：\n合同必须由董事会审批。",
      "以下为旧版内容：合同必须由董事会审批。",
      "已删除条款：合同必须由董事会审批。",
      "仅在金额超过100万元时适用。合同必须由董事会审批。",
      "合同必须由董事会审批。仅适用于金额超过100万元的情况。",
      "例外情况是：合同必须由董事会审批。",
      "若合同金额超过一亿元，则合同必须由董事会审批。",
      "“合同必须由董事会审批”。",
      "草案建议合同必须由董事会审批。",
      "合同必须由董事会审批，待下月生效。",
    ]) {
      expect(checkWikiMaterialFactSupport("合同必须由董事会审批", [{
        evidenceRef: "odoc.v1.doc.ver.context",
        text,
        versionState: "adopted",
      }])).toMatchObject({
        supported: false,
        method: "unsupported",
        missingTerms: [expect.stringMatching(/^证据语境:/u)],
      });
    }

    for (const text of [
      "金额超过100万元时适用的规则：合同必须由董事会审批。",
      "采购部适用的规则：合同必须由董事会审批。",
      "采购部规则：合同必须由董事会审批。",
      "无效规则：合同必须由董事会审批。",
      "他说的规则：合同必须由董事会审批。",
      "现行采购部规则：合同必须由董事会审批。",
      "当前有效采购部适用的规则：合同必须由董事会审批。",
      "本版本金额超过100万元时适用的规则：合同必须由董事会审批。",
      "已生效他说的规则：合同必须由董事会审批。",
      "现行无效规则：合同必须由董事会审批。",
      "规则：合同必须由董事会审批，这条规则无效。",
      "规则：合同必须由董事会审批，这条规则是错误的。",
      "规则：合同必须由董事会审批，这是他说的。",
      "规则：合同必须由董事会审批，金额超过100万元时适用。",
      "规则：合同必须由董事会审批，适用于采购部。",
    ]) {
      expect(checkWikiMaterialFactSupport("合同必须由董事会审批", [{
        evidenceRef: "odoc.v1.doc.ver.scoped-label",
        text,
        versionState: "adopted",
      }]), text).toMatchObject({ supported: false, method: "unsupported" });
    }

    expect(checkWikiMaterialFactSupport("合同必须由董事会审批", [{
      evidenceRef: "odoc.v1.doc.ver.current",
      text: "现行规则如下：合同必须由董事会审批。",
      versionState: "adopted",
    }])).toMatchObject({ supported: true, method: "literal" });

    expect(checkWikiMaterialFactSupport("合同必须由董事会审批", [{
      evidenceRef: "odoc.v1.doc.old.rule",
      text: "合同必须由董事会审批。",
      versionState: "unadopted",
    }])).toMatchObject({
      supported: false,
      missingTerms: ["证据版本:引用的不是项目当前采用版本"],
    });
  });

  it("六类声明全部先成为草稿；只有真人带依据才能确认", () => {
    const claims = WIKI_CLAIM_KINDS.map((kind) => draft(kind));
    expect(claims.map((claim) => claim.kind)).toEqual([
      "MATERIAL_FACT", "HUMAN_DECISION", "INFERENCE", "GENERAL_GUIDANCE", "CONTESTED", "STALE",
    ]);
    expect(claims.every((claim) => claim.state === "draft" && claim.confirmation === null)).toBe(true);

    const original = claims[0]!;
    expect(() => confirmWikiClaim(original, {
      actor: { kind: "ai", id: "another-agent" }, evidenceRefs: ["customer:1"], confirmedAt: NOW,
    })).toThrow(/只有真人/u);
    expect(() => confirmWikiClaim(original, {
      actor: { kind: "human", id: "alice" }, evidenceRefs: [], confirmedAt: NOW,
    })).toThrow(/至少一条/u);

    const confirmed = confirmWikiClaim(original, {
      actor: { kind: "human", id: "alice", name: "业务负责人" },
      evidenceRefs: ["customer-answer:q-12"],
      confirmedAt: NOW,
    });
    expect(confirmed).toMatchObject({
      state: "confirmed",
      author: { kind: "ai", id: "onto-copilot" },
      confirmation: { actor: { kind: "human", id: "alice" }, evidenceRefs: ["customer-answer:q-12"] },
    });
    expect(() => confirmWikiClaim(confirmed, {
      actor: { kind: "human", id: "bob" }, evidenceRefs: ["x"], confirmedAt: NOW,
    })).toThrow(/已经确认/u);
  });

  it("争议和过期用 supersedes 新建草稿，不能原地改写旧结论", () => {
    const original = confirmWikiClaim(draft(), {
      actor: { kind: "human", id: "alice" }, evidenceRefs: ["meeting:1"], confirmedAt: NOW,
    });
    for (const kind of ["CONTESTED", "STALE"] as const) {
      const next = createClaimStateDraft(original, {
        kind,
        statement: kind === "STALE" ? "新版本发布，等待复核" : "财务部口径不同，等待裁决",
        evidenceRefs: ["impact:1"],
        author: { kind: "ai", id: "onto-copilot" },
        createdAt: NOW,
      });
      expect(next).toMatchObject({ kind, state: "draft", supersedesClaimId: original.id, confirmation: null });
      expect(original.kind).toBe("MATERIAL_FACT");
    }
  });

  it("页面和导出边界拒绝伪造的 AI 确认记录", () => {
    const fake = {
      ...draft(),
      state: "confirmed",
      confirmation: {
        actor: { kind: "ai", id: "onto-copilot" },
        evidenceRefs: ["made-up"],
        confirmedAt: NOW,
      },
    } as unknown as WikiClaim;
    expect(() => page("fake", "伪造", [fake])).toThrow(/只有真人/u);

    const valid = page("valid", "合法", [draft()]);
    const forgedPage = { ...valid, claims: [fake] };
    expect(() => renderWikiMarkdown(forgedPage)).toThrow(/只有真人/u);
    expect(() => buildObsidianVault({ projectId: "project_A", pages: [forgedPage], generatedAt: NOW }))
      .toThrow(/只有真人/u);
  });

  it("Markdown 把原材料中的 HTML、embed 和 wiki-link 当普通文字", () => {
    const unsafe = draft("INFERENCE", "![[secret]] <script>alert(1)</script> [点我](javascript:alert(1))");
    const markdown = renderWikiMarkdown(page("unsafe", "采购 <script>", [unsafe]));

    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("![[secret]]");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\!\\[\\[secret\\]\\]");
    expect(markdown).toContain("草稿（不可当作已确认事实）");
    expect(markdown).toContain("待验证推断");
  });

  it("确定性生成安全 Vault，保留系统首页并消解保留名、大小写与同名冲突", () => {
    const pages = [
      page("__proto__", "CON.txt"),
      page("case_a", "../../采购#规则[[x]]"),
      page("case_b", "../../采购#规则[[x]]"),
      page("home", "首页"),
    ];
    const first = buildObsidianVault({ projectId: "project_A", pages, generatedAt: NOW });
    const second = buildObsidianVault({ projectId: "project_A", pages: structuredClone(pages), generatedAt: NOW });

    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{32}$/u);
    expect(Object.getPrototypeOf(first.pagePaths)).toBeNull();
    expect(first.pagePaths["__proto__"]).toMatch(/^_CON\.txt/u);
    expect(first.pagePaths["home"]).not.toBe("首页.md");
    expect(first.files.filter((file) => file.path === "首页.md")).toHaveLength(1);
    expect(new Set(first.files.map((file) => file.path.toLocaleLowerCase("en-US"))).size).toBe(first.files.length);
    for (const file of first.files) {
      expect(file.path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\\|\u0000/u);
      expect(file.sha256).toBe(sha256Hex(file.content));
    }
    const casePaths = [first.pagePaths["case_a"], first.pagePaths["case_b"]];
    expect(new Set(casePaths).size).toBe(2);
    expect(casePaths.every((path) => path !== undefined && !/[#^\[\]]/u.test(path))).toBe(true);
  });

  it("只写入全新目录，校验路径和内容，不覆盖已有 Vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-wiki-"));
    roots.push(root);
    const destination = join(root, "vault");
    const bundle = buildObsidianVault({ projectId: "project_A", pages: [page("purchase", "采购规则", [draft()])], generatedAt: NOW });

    await writeObsidianVault(destination, bundle);
    expect(await readFile(join(destination, "首页.md"), "utf8")).toContain("# 项目知识库");
    expect(await readFile(join(destination, ".obsidian", "app.json"), "utf8")).toContain("showUnsupportedFiles");
    await expect(writeObsidianVault(destination, bundle)).rejects.toMatchObject({ code: "EEXIST" });

    const malicious: ObsidianVaultBundle = {
      projectId: "project_A",
      generatedAt: NOW,
      pagePaths: {},
      files: [{ path: "../escape.md", content: "escape", sha256: sha256Hex("escape") }],
      fingerprint: "irrelevant",
    };
    const rejected = join(root, "rejected");
    await expect(writeObsidianVault(rejected, malicious)).rejects.toThrow(/不安全/u);
    await expect(access(join(root, "escape.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(rejected)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
