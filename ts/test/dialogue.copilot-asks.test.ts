/**
 * 界面按钮预填的那几句话，必须真的能过意图闸。
 *
 * 「让 Copilot 帮我做」这类按钮有一个不明显的失败模式：按钮工作、句子发出去、
 * 模型也想做，但服务端的意图闸（explicitDocumentActions）不认这句话的写法，
 * 于是什么都没发生。用户看到的是「Copilot 不听话」，而真正的原因是**按钮上的
 * 文案和一条正则对不上**——一个纯文案改动就能悄悄制造它。
 *
 * 闸是全句锚定的（`^…$`），多一句寒暄、少一个「把」字都可能不匹配。所以这些
 * 字符串是**功能**，这个文件是它们的守门人：改了 copilot-asks.ts 的措辞，
 * 这里会立刻告诉你还过不过得去。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { ChatCtx } from "../src/server/dialogue/ctx.js";
import { managedToolRegistrar } from "../src/catalog/tools.js";
import {
  authorizeDocumentToolsForTurn,
  registerDocumentDialogueTools,
} from "../src/server/dialogue/document_tools.js";
import { setDocumentServiceForTests } from "../src/document/deps.js";
import {
  askArchive, askIngestAll, askIngestOne, askAttach,
} from "../src/ui/copilot-asks.js";
import type { DocumentService } from "../src/document/service.js";

type Dict = Record<string, unknown>;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  setDocumentServiceForTests(null);
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-asks-"));
  roots.push(root);
  mkdirSync(join(root, "session_1", "materials"), { recursive: true });
  writeFileSync(join(root, "session_1", "materials", "采购制度.md"), "内容");

  // 库里必须真有一份材料：resolveExactOperation 解析「这份文档」这类指代靠的是
  // service.list 的候选集，空列表下任何 manage 动作都签不出票 —— 那会让这个测试
  // 因为桩太薄而误报「按钮文案不过闸」。
  const doc = {
    id: "doc_1", projectId: "project_A", owner: "alice",
    title: "采购制度.md", logicalName: "采购制度", sourceClass: "session_upload",
    tags: [], status: "active", currentVersionId: "v1", adoptedVersionId: "v1",
    revision: 1, createdBy: "alice", folderPath: "",
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const service = {
    list: vi.fn(async () => [doc]),
    listAttachments: vi.fn(async () => []),
    history: vi.fn(async () => [{
      id: "v1", documentId: "doc_1", versionNo: 1, fileName: "采购制度.md",
      sha256: "d".repeat(64), parseStatus: "ready", chunkCount: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
    }]),
    archive: vi.fn(async () => doc),
    promoteSessionFile: vi.fn(async () => ({
      document: doc,
      version: { id: "v1", versionNo: 1, sha256: "a".repeat(64), parseStatus: "ready", chunkCount: 1 },
      deduplicated: false,
    })),
  } as unknown as DocumentService;
  setDocumentServiceForTests(service);

  const session = {
    id: "session_1",
    projectId: "project_A",
    owner: "alice",
    emitDurable: vi.fn(async () => ({})),
    state: {} as Dict,
    files: [{ name: "采购制度.md", path: join(root, "session_1", "materials", "采购制度.md"), size: 6, sha256: "c".repeat(64) }],
  } as any;

  const registry = new ToolRegistry();
  registerDocumentDialogueTools(managedToolRegistrar(registry, "dialogue"), session, { persist: vi.fn() } as any);
  return { session, registry };
}

/** 没拿到能力票时，写工具返回的就是这一句。 */
const NO_TICKET = "这一轮没有可执行的知识库修改授权";

/**
 * 一句话能不能**授权**某个写动作。
 *
 * 判据刻意只看「票签没签出来」，不看整次调用成不成功。
 *
 * 理由：这个文件要守的是**按钮文案和意图闸对不对得上**，而调用在拿到票之后还要
 * 过一串和文案无关的东西（workspace 路径守卫、文件重验、乐观锁 revision）。
 * 用「ok === true」当判据，等于让任何一个桩没搭好的细节都伪装成「文案不过闸」——
 * 我第一版就是这么写的，两条正例红了，而真实原因是临时目录不在 workspace 下面。
 * 一个会因为无关原因变红的守门人，教会所有人忽略它。
 *
 * 闸的入口 authorizeDocumentToolsForTurn 是导出的，但 explicitDocumentActions
 * 不是；从工具的拒绝话术反推是目前最贴近真实行为、又不动生产代码的判据。
 */
async function authorizes(text: string, tool: string, args: Dict): Promise<boolean> {
  const { session, registry } = fixture();
  const turn = `turn_${tool}`;
  await authorizeDocumentToolsForTurn(session, turn, text);
  const out = await registry.call(tool, args, new ChatCtx({ turnId: turn, approved: false }), { scope: "converse" }) as Dict;
  return !String(out["error"] ?? "").includes(NO_TICKET);
}

describe("按钮预填的原话必须能过意图闸", () => {
  it("批量入库：「请把这 N 份材料存入知识库」", async () => {
    // 这一句要同时命中两处：promote 的动词表（存入 + 知识库）和 BATCH_QUANTIFIER
    // 的量词表（`这\s*\d+\s*份`）。少一个都签不出批量票。
    expect(await authorizes(askIngestAll(6), "document.promote_batch", {
      session_file_names: ["采购制度.md"],
    })).toBe(true);
  });

  it("单份入库：「请把<文件名>保存到项目知识库」", async () => {
    expect(await authorizes(askIngestOne("采购制度.md"), "document.promote", {
      session_file_name: "采购制度.md",
    })).toBe(true);
  });

  it("归档：「请归档这份文档」", async () => {
    // manage_archive 的正则**没有自由目标位**，只吃 DOCUMENT_REF 那几种指代写法。
    // 所以按钮只能说「这份文档」，指用户当前选中的那一份 ——
    // 写成「请归档采购制度.md」反而过不了闸。这是个反直觉的约束，
    // 所以按钮文案不能凭感觉改。
    expect(await authorizes(askArchive(), "document.manage", {
      action: "archive", document_id: "doc_1", expected_revision: 1,
    })).toBe(true);
  });

  it("固定到本次分析：「请把<标题>固定到本次分析」", async () => {
    expect(await authorizes(askAttach("采购制度.md"), "document.attach", {
      document_id: "doc_1", version_id: "v1", role: "reference",
    })).toBe(true);
  });

  it("反例：不带量词的批量说法签不出批量票", async () => {
    // 「帮我把材料整理进知识库」听起来完全正常，但没有量词，BATCH_QUANTIFIER
    // 不认 —— 这正是这个测试文件存在的理由：这类句子失败得很安静。
    expect(await authorizes("帮我把材料整理进知识库", "document.promote_batch", {
      session_file_names: ["采购制度.md"],
    })).toBe(false);
  });

  it("反例：否定句不授权", async () => {
    expect(await authorizes("先别把这 6 份材料存入知识库", "document.promote_batch", {
      session_file_names: ["采购制度.md"],
    })).toBe(false);
  });

  it("检索与整理建议这两句不需要票 —— 它们走的是只读工具", () => {
    const { registry } = fixture();
    expect(registry.get("document.search", "chat").spec.danger).toBe(Danger.READ);
    expect(registry.get("document.folders", "chat").spec.danger).toBe(Danger.READ);
  });
});
