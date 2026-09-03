/**
 * 两级知识库的存储原语：总库与项目库是同一套表里的两个**互不可见**的边界。
 *
 * 产品要求（2026-09-02）：「应该有一个总的知识库，然后分不同项目还有不同项目的知识库。」
 *
 * 这里钉的是最底下那层不变量 —— 一个项目的作用域绝对读不到另一个项目的东西，
 * 也读不到总库的东西；跨层可见性必须由**上层显式合并两个作用域**来实现，而不是
 * 靠某个边界写得松。松边界的后果不是「多看到一点」，是把一份行业通用制度当成
 * 这个客户自己的规定 —— 这个产品最不能出的错。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";
import { MemoryDocumentRepository } from "../src/document/repository.js";
import { DocumentService, type DocumentParser } from "../src/document/service.js";
import {
  GLOBAL_LIBRARY_OWNER,
  GLOBAL_LIBRARY_PROJECT_ID,
  globalLibraryScope,
  levelLabel,
  levelOf,
  type DocumentScope,
} from "../src/document/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TextParser implements DocumentParser {
  async parse(path: string, opts: { readonly fileId: string }): Promise<ParsedDoc> {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(path, "utf8");
    const doc = makeParsedDoc({ fileId: opts.fileId, fileName: "fixture", kind: "text" });
    doc.chunks.push(
      makeChunk({
        docId: "body",
        fileId: opts.fileId,
        fileName: "fixture",
        locator: { section: "正文", line: 1 },
        render: text,
        raw: { text },
        order: 0,
        tags: ["body"],
      }),
    );
    return doc;
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "kb-levels-"));
  roots.push(root);
  const materials = join(root, "s_1", "materials");
  mkdirSync(materials, { recursive: true });
  let id = 0;
  let tick = 0;
  const service = new DocumentService({
    repository: new MemoryDocumentRepository(),
    workspaceRoot: root,
    parser: new TextParser(),
    newId: (kind) => `${kind === "document" ? "doc" : "ver"}_${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 2, 0, 0, tick++)).toISOString(),
  });
  const write = (name: string, text: string) => {
    const path = join(materials, name);
    writeFileSync(path, text);
    const bytes = Buffer.from(text, "utf8");
    return {
      sessionId: "s_1",
      name,
      relPath: relative(root, path),
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  };
  return { service, write };
}

const projectScope: DocumentScope = { projectId: "project_A", owner: "alice", actorId: "alice" };
const otherProjectScope: DocumentScope = { projectId: "project_B", owner: "bob", actorId: "bob" };

describe("总库与项目库是两个边界", () => {
  it("总库作用域用保留常量，且真项目 id 撞不上它", () => {
    const scope = globalLibraryScope("alice");
    expect(scope).toEqual({
      projectId: GLOBAL_LIBRARY_PROJECT_ID,
      owner: GLOBAL_LIBRARY_OWNER,
      // actorId 仍是真人：总库跨账号共享，ACL 要靠它裁决，不能退化成 owner。
      actorId: "alice",
    });
    expect(levelOf(scope)).toBe("global");
    expect(levelOf(projectScope)).toBe("project");
    expect(levelLabel("global")).toBe("总库");
    expect(levelLabel("project")).toBe("项目库");
    // 真项目 id 是 shortId() 出来的 12 位十六进制，形状上就不可能等于哨兵值。
    expect(/^[0-9a-f]{12}$/u.test(GLOBAL_LIBRARY_PROJECT_ID)).toBe(false);
  });

  it("放进总库的材料，项目作用域一条都搜不到；反过来也一样", async () => {
    const { service, write } = harness();

    await service.promoteSessionFile(globalLibraryScope("alice"), {
      source: write("行业通用采购规范.md", "行业通用做法：采购付款条件建议月结 30 天。"),
      title: "行业通用采购规范",
    });
    await service.promoteSessionFile(projectScope, {
      source: write("客户采购制度.md", "本公司规定：采购付款条件为月结 90 天。"),
      title: "客户采购制度",
    });

    const inProject = await service.search(projectScope, { query: "付款条件" });
    expect(inProject.hits.map((h) => h.documentTitle)).toEqual(["客户采购制度"]);

    const inGlobal = await service.search(globalLibraryScope("alice"), { query: "付款条件" });
    expect(inGlobal.hits.map((h) => h.documentTitle)).toEqual(["行业通用采购规范"]);

    // 别的项目两边都看不到 —— 项目之间本来就互不可见。
    const inOther = await service.search(otherProjectScope, { query: "付款条件" });
    expect(inOther.hits).toHaveLength(0);
  });

  it("证据引用自带层级：项目作用域也能打开一条总库引用", async () => {
    const { service, write } = harness();
    await service.promoteSessionFile(globalLibraryScope("alice"), {
      source: write("通用规范.md", "行业通用：验收合格后 30 天内付款。"),
      title: "通用规范",
    });

    const found = await service.search(globalLibraryScope("alice"), { query: "验收" });
    const hit = found.hits[0]!;
    expect(hit.level).toBe("global");
    // 层级写在 ref 本身里，不是只放在旁边的字段里 —— ref 是模型会原样抄进答案的
    // 那个字符串，层级放旁边，第一次做摘要就丢了。
    expect(hit.evidenceRef.startsWith("odoc.v2.global.")).toBe(true);
    // 引用文案里也要写着「总库」，读答案的人一眼分得清这是不是客户自己的规定。
    expect(hit.displayCite).toContain("总库");

    // 关键：拿**项目**作用域去打开它。旧实现会走 WHERE project_id=<项目> 查一条
    // project_id=__global__ 的切片，必然返回「没找到」—— 等于发给模型一张
    // 它自己撕不开的票。
    const opened = await service.open(projectScope, { evidenceRef: hit.evidenceRef });
    expect(opened.documentTitle).toBe("通用规范");
    expect(opened.level).toBe("global");
    expect(opened.text).toContain("验收合格后 30 天内付款");
  });

  it("v1 老引用继续认，按项目层解 —— 已经写进历史产物的引用不能一夜失效", async () => {
    const { service, write } = harness();
    await service.promoteSessionFile(projectScope, {
      source: write("客户规定.md", "本项目：验收合格后 15 天内付款。"),
      title: "客户规定",
    });
    const found = await service.search(projectScope, { query: "验收" });
    const v2 = found.hits[0]!.evidenceRef;
    // 把 v2 退回成 v1 的形状（去掉层级段），模拟历史产物里存着的引用。
    const parts = v2.split(".");
    const v1 = ["odoc", "v1", parts[3], parts[4], parts[5]].join(".");

    const opened = await service.open(projectScope, { evidenceRef: v1 });
    expect(opened.documentTitle).toBe("客户规定");
    expect(opened.level).toBe("project");
  });

  it("设为通用知识是复制而不是搬走，且同一份内容只进一次", async () => {
    const { service, write } = harness();
    const created = await service.promoteSessionFile(projectScope, {
      source: write("采购通用条款.md", "通用条款：验收合格后 30 天内付款。"),
      title: "采购通用条款",
      tags: ["制度"],
    });

    const published = await service.publishToGlobal(projectScope, created.document.id);
    expect(published.deduplicated).toBe(false);
    // 来源分类说实话：它进公共库靠的是人的一次判断，不是某个会话上传。
    expect(published.document.sourceClass).toBe("imported");
    expect(published.document.tags).toEqual(["制度"]);

    // **复制，不是搬走**：项目仍然留着自己那一份 —— 那是这个客户的材料，
    // 有自己的来源和版本链；已经固定到某个会话的版本也不能凭空消失。
    const stillThere = await service.list(projectScope, {});
    expect(stillThere.map((d) => d.title)).toEqual(["采购通用条款"]);
    const inGlobal = await service.list(globalLibraryScope("alice"), {});
    expect(inGlobal.map((d) => d.title)).toEqual(["采购通用条款"]);

    // 第二次点不再堆一份一模一样的。
    const again = await service.publishToGlobal(projectScope, created.document.id);
    expect(again.deduplicated).toBe(true);
    expect((await service.list(globalLibraryScope("alice"), {})).length).toBe(1);

    // 发布之后两层都能搜到，且命中各自标着自己的层级。
    const fromProject = await service.search(projectScope, { query: "验收" });
    expect(fromProject.hits[0]!.level).toBe("project");
    const fromGlobal = await service.search(globalLibraryScope("alice"), { query: "验收" });
    expect(fromGlobal.hits[0]!.level).toBe("global");
  });

  it("设为通用知识之后不会在检索里出现两条一模一样的命中", async () => {
    const { service, write } = harness();
    const created = await service.promoteSessionFile(projectScope, {
      source: write("通用条款.md", "通用条款：验收合格后 30 天内付款。"),
      title: "通用条款",
    });
    await service.publishToGlobal(projectScope, created.document.id);

    const merged = await service.searchLayered(
      [projectScope, globalLibraryScope("alice")],
      { query: "验收" },
    );
    // 复制之后同一段正文躺在两层里，并集打分后分数完全相同、并排出现 ——
    // 对用户就是重复的两行。按 text_sha256 去重。
    expect(merged.hits).toHaveLength(1);
    expect(merged.total).toBe(1);
    // 留下的是**项目**那一份：它才有版本链，才可能被会话固定。
    expect(merged.hits[0]!.level).toBe("project");
    // 但「总库也有」这条信息不能丢 —— 那正是用户判断「这是通用做法还是我们自己
    // 的规定」时要看的东西。
    expect(merged.hits[0]!.alsoInLevel).toBe("global");
  });

  it("公共库里的材料不能再「设为通用知识」", async () => {
    const { service, write } = harness();
    const created = await service.promoteSessionFile(globalLibraryScope("alice"), {
      source: write("行业规范.md", "行业规范正文。"),
      title: "行业规范",
    });
    await expect(
      service.publishToGlobal(globalLibraryScope("alice"), created.document.id),
    ).rejects.toThrow(/已经在公共知识库/u);
  });

  it("两级检索并成一份语料打分：客户自己的规定压得住行业通用文本", async () => {
    const { service, write } = harness();
    const global = globalLibraryScope("alice");

    // 总库塞多份，其中一份只是**勉强沾边**地提了一句付款。
    // 总库是部署级、只增不减的，任何查询几乎都能在里面碰出个这样的第 1 名。
    await service.promoteSessionFile(global, {
      source: write("行业术语表.md", "术语：付款。采购。验收。交付。结算。"),
      title: "行业术语表",
    });
    await service.promoteSessionFile(global, {
      source: write("通用合同模板.md", "第八条 其他约定。第九条 争议解决。"),
      title: "通用合同模板",
    });
    // 项目里是**正面回答问题**的那一条。
    await service.promoteSessionFile(projectScope, {
      source: write("客户付款条款.md", "本公司付款条款：付款条件为月结 90 天，付款前须完成验收。"),
      title: "客户付款条款",
    });

    const merged = await service.searchLayered([projectScope, global], { query: "付款条款" });

    // 两层都在结果里，各自标着自己的层级。
    expect(merged.hits.length).toBeGreaterThan(1);
    expect(new Set(merged.hits.map((h) => h.level))).toEqual(new Set(["project", "global"]));
    // 关键：项目那条排第一。分层各搜一次再按名次 RRF 融合的话，
    // 总库的 rank1（1/61）会恒定压过项目的 rank2（1/62），与实际相关性无关。
    expect(merged.hits[0]!.level).toBe("project");
    expect(merged.hits[0]!.documentTitle).toBe("客户付款条款");
    // searchedVersions 是两层的并集 —— 「本次搜过哪些版本」不能只报一半。
    expect(merged.searchedVersions.length).toBe(3);
  });

  it("跨层可见性必须由上层合并两个作用域，边界本身不放水", async () => {
    const { service, write } = harness();
    await service.promoteSessionFile(globalLibraryScope("alice"), {
      source: write("通用.md", "通用：验收合格后 30 天内付款。"),
      title: "通用规范",
    });
    await service.promoteSessionFile(projectScope, {
      source: write("客户.md", "本项目：验收合格后 15 天内付款。"),
      title: "客户规定",
    });

    // 这就是 glue/project_scope.ts 的 layeredScopes() 交给检索层的东西。
    //
    // 注意：这里逐层检索**只是为了断言边界互不可见**，不是合并排序的实现方式。
    // 真正的两级检索必须并集语料、只算一次 df/avgLen —— 分层分别打分再合并，
    // 分数不可比（BM25 的 idf 是语料局部量），详见 layeredScopes 的注释。
    const layered = [projectScope, globalLibraryScope("alice")];
    const merged: { title: string; level: string }[] = [];
    for (const scope of layered) {
      const result = await service.search(scope, { query: "付款" });
      for (const hit of result.hits) {
        merged.push({ title: hit.documentTitle, level: levelOf(scope) });
      }
    }

    expect(merged).toEqual([
      { title: "客户规定", level: "project" },
      { title: "通用规范", level: "global" },
    ]);
    // 顺序不是审美问题：客户自己的规定必须压过行业通用制度。
    expect(merged[0]!.level).toBe("project");
  });
});
