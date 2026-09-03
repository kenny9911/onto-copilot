import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AssetMemory } from "../src/onto/asset_memory.js";
import {
  assetAccess,
  loadOrMigrateAssetMemory,
  syncAssetMemory,
  type AssetSessionLike,
} from "../src/server/asset_memory.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import type { Repo } from "../src/store/repo/protocol.js";
import { makeSessionRow } from "../src/store/types.js";

function session(): AssetSessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-asset-memory-"));
  return { id: "s-assets", dir, files: [], events: [], state: {} };
}

describe("server asset memory integration", () => {
  it("同名产物覆盖时保存不可变字节、revision 链和重启后可访问 URL", () => {
    const s = session();
    const current = join(s.dir, "问题清单.json");
    s.state["artifacts"] = ["问题清单.json"];
    writeFileSync(current, "before");
    (s.events as Record<string, unknown>[]).push({
      kind: "artifact.ready",
      seq: 1,
      name: "问题清单.json",
      artifact: "question_list",
    });
    syncAssetMemory(s);

    writeFileSync(current, "after");
    (s.events as Record<string, unknown>[]).push({
      kind: "artifact.ready",
      seq: 2,
      name: "问题清单.json",
      artifact: "question_list",
    });
    const latest = syncAssetMemory(s);
    const versions = latest.list({ includeSuperseded: true })
      .filter((asset) => asset.name === "问题清单.json")
      .sort((a, b) => a.revision - b.revision);
    expect(versions).toHaveLength(2);
    expect(versions.map((asset) => [asset.revision, asset.status])).toEqual([
      [1, "superseded"],
      [2, "active"],
    ]);
    for (const asset of versions.filter((row) => row.status === "superseded" && row.path !== null)) {
      expect(asset.metadata["immutable"]).toBe(true);
      expect(asset.path).toMatch(/^exports\/\.__asset_memory__/);
    }
    expect(versions[0]?.path).not.toBe(versions[1]?.path);
    expect(readFileSync(join(s.dir, ...(versions[0]?.path ?? "").split("/")), "utf8")).toBe("before");
    expect(readFileSync(join(s.dir, ...(versions[1]?.path ?? "").split("/")), "utf8")).toBe("after");

    // 模拟 session_state JSON 往返 / 进程重启；稳定 id、路径与字节不能漂。
    const restored = AssetMemory.fromDict(JSON.parse(JSON.stringify(s.state["asset_memory"])));
    const old = restored.get(versions[0]!.id)!;
    expect(old.contentDigest).toBe(versions[0]?.contentDigest);
    const access = assetAccess(old, s.dir);
    expect(access).toMatchObject({ available: true });
    expect(access.downloadUrl).toContain("/exports/");
  });

  it("state.sketch 的语义摘要只是 placeholder，首次同字节扫描原地物化而不制造假 revision", () => {
    const s = session();
    const exportsDir = join(s.dir, "exports");
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "采购流程.svg"), "<svg><text>采购申请</text></svg>");
    s.state["sketch"] = {
      domain: "采购",
      title: "采购参考流程",
      svg: "采购流程.svg",
      graph: { nodes: [{ id: "request", label: "采购申请" }], edges: [] },
    };
    (s.events as Record<string, unknown>[]).push({
      kind: "sketch.ready",
      seq: 7,
      name: "采购流程.svg",
      domain: "采购",
      title: "采购参考流程",
      display_only: true,
    });

    const first = syncAssetMemory(s);
    const firstVersions = first.list({ includeSuperseded: true })
      .filter((asset) => asset.name === "采购流程.svg");
    expect(firstVersions).toHaveLength(1);
    expect(firstVersions[0]).toMatchObject({ revision: 1, status: "active" });
    expect(firstVersions[0]?.metadata).toMatchObject({ immutable: true });
    expect(firstVersions[0]?.path).toMatch(/^exports\/\.__asset_memory__/);

    const second = syncAssetMemory(s);
    const rescanned = second.list({ includeSuperseded: true })
      .filter((asset) => asset.name === "采购流程.svg");
    expect(rescanned).toHaveLength(1);
    expect(rescanned[0]?.id).toBe(firstVersions[0]?.id);
    expect(rescanned[0]?.revision).toBe(1);
  });

  it("问题、材料、图片与聊天表格落入同一个持久化目录", () => {
    const s = session();
    const material = join(s.dir, "制度.pdf");
    writeFileSync(material, "pdf");
    (s as unknown as { files: Array<Record<string, unknown>> }).files.push({
      name: "制度.pdf",
      path: material,
      size: 3,
      sha256: "",
    });
    s.state["question_backlog"] = {
      questions: [{ id: "Q1", text: "谁审批？", status: "open", priority: "high" }],
    };
    (s.events as Record<string, unknown>[]).push({
      kind: "ui.table",
      seq: 9,
      title: "采购数据表",
      columns: ["问题"],
      rows: [["谁审批？"]],
    });
    const memory = syncAssetMemory(s);
    const kinds = new Set(memory.list().map((asset) => asset.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(["material", "question", "question_list", "dataset"]));
    expect(memory.search("采购数据表")[0]?.asset.kind).toBe("dataset");
    expect(memory.search("制度材料")[0]?.asset.kind).toBe("material");
  });

  it("旧会话惰性迁移用 CAS 只写资产目录，并在重启后直接读回", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "onto-asset-migrate-"));
    const sid = "legacy-assets";
    const directory = join(workspace, sid);
    const materials = join(directory, "materials");
    const exports = join(directory, "exports");
    mkdirSync(materials, { recursive: true });
    mkdirSync(exports, { recursive: true });
    writeFileSync(join(materials, "采购制度.pdf"), "policy");
    writeFileSync(join(exports, "采购报销_Image2.png"), "image-two");

    const repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({
      id: sid,
      owner: "fde-1",
      project_id: "project-p2p",
    }));
    await repo.addFiles(sid, [{
      name: "采购制度.pdf",
      rel_path: `${sid}/materials/采购制度.pdf`,
      size: 6,
      sha256: "",
    }]);
    await repo.appendEvent(sid, "artifact.ready", {
      name: "采购报销_Image2.png",
      path: "exports/采购报销_Image2.png",
      storage: "exports",
      mime: "image/png",
      source: "generic_reference",
      display_only: true,
    });
    await repo.saveState(sid, {
      question_backlog: {
        questions: [{ id: "Q-采购-1", text: "报销超过多少需要总监审批？", status: "open" }],
      },
    });

    // 第一次迁移提交前模拟另一 worker 抢先写入。迁移必须 CAS 失败后重读，且只能
    // 把 asset_memory 合并到新版本，不能把 concurrent_marker / 问题台账盖掉。
    let injected = false;
    const racingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "saveState") {
          return async (
            id: string,
            docs: Record<string, unknown>,
            opts?: { expectedVersion?: number | null },
          ) => {
            if (!injected && "asset_memory" in docs) {
              injected = true;
              await target.saveState(id, { concurrent_marker: "keep-me" }, {
                expectedVersion: opts?.expectedVersion,
              });
              return null;
            }
            return await target.saveState(id, docs as never, opts);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Repo;

    const migrated = await loadOrMigrateAssetMemory(
      racingRepo,
      sid,
      { owner: "fde-1", projectId: "project-p2p" },
      { directory },
    );
    expect(migrated.status).toBe("persisted");
    expect(injected).toBe(true);
    const saved = await repo.loadState(sid);
    expect(saved["concurrent_marker"]).toBe("keep-me");
    expect(saved["question_backlog"]).toBeDefined();
    const restored = AssetMemory.fromDict(saved["asset_memory"]);
    expect(restored.search("刚才 Image 2 那张图")[0]?.asset.name).toBe("采购报销_Image2.png");
    expect(restored.search("采购材料")[0]?.asset.name).toBe("采购制度.pdf");
    expect(restored.search("问题清单")[0]?.asset.kind).toBe("question_list");

    // 模拟进程重启：丢掉迁移返回值，只从 repo 读取。已有目录不能再次推进版本。
    const beforeRestart = (await repo.getSession(sid))!.state_version;
    const afterRestart = await loadOrMigrateAssetMemory(
      repo,
      sid,
      { owner: "fde-1", projectId: "project-p2p" },
      { directory },
    );
    expect(afterRestart.status).toBe("current");
    expect(afterRestart.memory?.search("报销审批问题")[0]?.asset.kind).toBe("question");
    expect((await repo.getSession(sid))!.state_version).toBe(beforeRestart);

    const forbidden = await loadOrMigrateAssetMemory(
      repo,
      sid,
      { owner: "another-owner", projectId: "project-p2p" },
      { directory },
    );
    expect(forbidden).toMatchObject({ status: "out_of_scope", memory: null });
  });
});
