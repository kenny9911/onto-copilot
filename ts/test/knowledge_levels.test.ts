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
