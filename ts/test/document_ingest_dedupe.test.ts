/**
 * 「同一份内容只进一次」—— 把 service.ts:362 那句注释钉成真的。
 *
 * 那段注释（publishToGlobal 上方）写着「按 sha256 去重；第二次点返回 deduplicated，
 * 不会堆出两份一模一样的文件」。实测下来它只在**指定了目标文档**时成立：
 * findVersionBySha 要一个 documentId，而「把这个文件加进库」这条最常走的路
 * 恰好不带 documentId，于是同一个文件点两次，库里长出两份 id 不同、字节相同的文档。
 *
 * 为什么不能当成「多一行而已」：检索按 text_sha256 去重只跨**层**做
 * （searchLayered 的 alsoInLevel），同层里的两份孪生文档会各命中一次。
 * 读起来像两个来源互相印证 —— 实际是一个来源被数了两遍。对一个把「材料事实
 * 有出处」当承诺的产品，这是承诺本身被破坏，不是列表脏了。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";
import {
  MemoryDocumentRepository, SqlDocumentRepository, type DocumentRepository,
} from "../src/document/repository.js";
import { DocumentService, type DocumentParser } from "../src/document/service.js";
import type { DocumentScope } from "../src/document/types.js";
import { Store } from "../src/store/engine.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function sqlRepo(): Promise<DocumentRepository> {
  const dir = mkdtempSync(join(tmpdir(), "kb-dedupe-sql-"));
  roots.push(dir);
  const store = await Store.open(`sqlite:///${join(dir, "db.sqlite")}`, { createAll: true });
  stores.push(store);
  return new SqlDocumentRepository(store);
}

class TextParser implements DocumentParser {
  async parse(path: string, opts: { readonly fileId: string }): Promise<ParsedDoc> {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(path, "utf8");
    const doc = makeParsedDoc({ fileId: opts.fileId, fileName: "fixture", kind: "text" });
    doc.chunks.push(makeChunk({
      docId: "body",
      fileId: opts.fileId,
      fileName: "fixture",
      locator: { section: "正文", line: 1 },
      render: text,
      raw: { text },
      order: 0,
      tags: ["body"],
    }));
    return doc;
  }
}

async function harness(repository: DocumentRepository) {
  const root = mkdtempSync(join(tmpdir(), "kb-dedupe-"));
  roots.push(root);
  const materials = join(root, "s_1", "materials");
  mkdirSync(materials, { recursive: true });
  let id = 0;
  let tick = 0;
  const service = new DocumentService({
    repository,
    workspaceRoot: root,
    parser: new TextParser(),
    newId: (kind) => `${kind === "document" ? "doc" : "ver"}_${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 4, 0, 0, tick++)).toISOString(),
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

const scope: DocumentScope = { projectId: "project_A", owner: "alice", actorId: "alice" };

// 两套实现都要跑。去重的活儿在 SQL 那边是一条挂在 current_version_id 上的 JOIN ——
// 挂错列（比如挂成「任意一版」）在内存实现上看不出来，只有真跑 SQLite 才现形。
for (const [label, make] of [
  ["内存实现", async () => new MemoryDocumentRepository() as DocumentRepository],
  ["SQL 实现", sqlRepo],
] as const) {
describe(`入库去重（${label}）`, () => {
  it("同一个会话文件入两次，只留一份文档", async () => {
    const { service, write } = await harness(await make());
    const source = write("采购制度.md", "付款条件：验收后 30 天内付 70%。");

    const first = await service.promoteSessionFile(scope, { source });
    expect(first.deduplicated).toBe(false);

    const second = await service.promoteSessionFile(scope, { source });
    expect(second.deduplicated).toBe(true);
    // 指回的必须是**同一份**，不是一份新造的孪生。
    expect(second.document.id).toBe(first.document.id);
    expect(second.version.id).toBe(first.version.id);

    const listed = await service.list(scope, { includeArchived: false });
    expect(listed.map((d) => d.title)).toEqual(["采购制度.md"]);
  });

  it("内容相同但换了文件名，仍然算同一份 —— 去重看的是字节不是名字", async () => {
    const { service, write } = await harness(await make());
    const text = "验收标准：到货 3 个工作日内完成验收。";

    const first = await service.promoteSessionFile(scope, { source: write("验收规范.md", text) });
    const again = await service.promoteSessionFile(scope, { source: write("验收规范_副本.md", text) });

    expect(again.deduplicated).toBe(true);
    expect(again.document.id).toBe(first.document.id);
    expect((await service.list(scope, { includeArchived: false })).length).toBe(1);
  });

  it("内容不同就不去重，哪怕文件名一模一样", async () => {
    const { service, write } = await harness(await make());
    await service.promoteSessionFile(scope, { source: write("台账.md", "供应商 A") });
    const changed = await service.promoteSessionFile(scope, { source: write("台账.md", "供应商 A、供应商 B") });

    // 同名不同内容是**两份东西**。想让它成为新版本，得显式指定 documentId ——
    // 静默把它并成一版会悄悄改掉某一轮分析读到的事实。
    expect(changed.deduplicated).toBe(false);
    expect((await service.list(scope, { includeArchived: false })).length).toBe(2);
  });

  it("已归档的那份不参与去重 —— 再传一次是把它重新拿出来用", async () => {
    const { service, write } = await harness(await make());
    const source = write("旧制度.md", "2024 年版采购制度。");
    const first = await service.promoteSessionFile(scope, { source });
    const stored = (await service.list(scope, { includeArchived: false })).find((d) => d.id === first.document.id)!;
    await service.archive(scope, stored.id, { archived: true, expectedRevision: stored.revision });

    const again = await service.promoteSessionFile(scope, { source });
    // 指回一份用户已经收起来、列表上默认看不见的文档，比多一份更让人迷惑：
    // 他会以为文件没进去。
    expect(again.deduplicated).toBe(false);
    expect(again.document.id).not.toBe(first.document.id);
  });

  it("跨项目不互相去重 —— 两个项目各有一份是对的", async () => {
    const { service, write } = await harness(await make());
    const source = write("行业规范.md", "行业通用：月结 30 天。");
    const a = await service.promoteSessionFile(scope, { source });
    const b = await service.promoteSessionFile(
      { projectId: "project_B", owner: "bob", actorId: "bob" },
      { source },
    );
    expect(b.deduplicated).toBe(false);
    expect(b.document.id).not.toBe(a.document.id);
  });
});
}
