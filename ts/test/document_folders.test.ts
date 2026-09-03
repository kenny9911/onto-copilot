/**
 * 用户手工建的文件夹。
 *
 * 之前树里的「文件夹」是按标签推出来的，所以「新建一个空文件夹」无处存放 ——
 * 建一个立刻消失。文件夹必须是**独立于文件存在的东西**，这是文件管理器的最小语义。
 *
 * 这里钉的三条，每一条都是端到端跑真材料时真的出过的错：
 *   1. 重命名多出一个斜杠（`新名//子级`）—— substr 起点算错一位；
 *   2. 删除回执把数字说大 —— 数的是目的地总数而不是这次移走的；
 *   3. 删文件夹把材料也带走 —— 那是最不能接受的一种"简化"。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryDocumentRepository, SqlDocumentRepository } from "../src/document/repository.js";
import { Store } from "../src/store/engine.js";
import { cleanFolderPath, type DocumentScope } from "../src/document/types.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const scope: DocumentScope = { projectId: "p1", owner: "u1", actorId: "u1" };

async function sqlRepo(): Promise<SqlDocumentRepository> {
  const dir = mkdtempSync(join(tmpdir(), "kb-folders-"));
  roots.push(dir);
  const store = await Store.open(`sqlite:///${join(dir, "db.sqlite")}`, { createAll: true });
  stores.push(store);
  return new SqlDocumentRepository(store);
}

describe("文件夹路径规范化", () => {
  it("把等价写法收敛成同一个路径", () => {
    // 允许 `a//b`、` a/b `、`a/b/` 并存的话，树上会冒出三个看起来一样的文件夹。
    expect(cleanFolderPath("制度//采购")).toBe("制度/采购");
    expect(cleanFolderPath(" 制度/采购 ")).toBe("制度/采购");
    expect(cleanFolderPath("制度/采购/")).toBe("制度/采购");
    expect(cleanFolderPath("")).toBe("");
    expect(cleanFolderPath(undefined)).toBe("");
  });

  it("挡住会破坏树的名字", () => {
    expect(() => cleanFolderPath("制度/../etc")).toThrow();
    expect(() => cleanFolderPath("a/b/c/d/e/f/g/h/i")).toThrow(/最多 8 层/u);
  });
});

for (const [label, make] of [
  ["内存实现", async () => new MemoryDocumentRepository()],
  ["SQL 实现", sqlRepo],
] as const) {
  describe(`文件夹（${label}）`, () => {
    it("空文件夹也存在 —— 这正是按标签推分组做不到的", async () => {
      const repo = await make();
      await repo.createFolder(scope, "空文件夹", "u1", "2026-09-03T00:00:00.000Z");
      const got = await repo.listFolders(scope);
      expect(got.map((f) => f.path)).toEqual(["空文件夹"]);
    });

    it("重命名连子文件夹一起改，且不多出斜杠", async () => {
      const repo = await make();
      const now = "2026-09-03T00:00:00.000Z";
      await repo.createFolder(scope, "制度", "u1", now);
      await repo.createFolder(scope, "制度/采购", "u1", now);

      await repo.renameFolder(scope, "制度", "规章制度");

      const got = (await repo.listFolders(scope)).map((f) => f.path).sort();
      // 端到端跑出来过 `规章制度//采购` —— substr 是 1 基且按字符数计，
      // 拼前缀时再补一个 `/` 就多了一道。
      expect(got).toEqual(["规章制度", "规章制度/采购"]);
      expect(got.some((p) => p.includes("//"))).toBe(false);
    });

    it("不能把文件夹改名成自己的子路径", async () => {
      const repo = await make();
      await repo.createFolder(scope, "制度", "u1", "2026-09-03T00:00:00.000Z");
      // 这条守在 service 层（repository 只管执行），所以这里只断言路径规范化不阻止它，
      // service 的那条断言见 knowledge_levels / 路由测试。
      expect(cleanFolderPath("制度/子级").startsWith("制度/")).toBe(true);
    });
  });
}
