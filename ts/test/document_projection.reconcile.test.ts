/**
 * 「没有项目正文就不要撤权」—— 这条钉的是一个正在影响多数会话的活 bug。
 *
 * `dialogue.reason()` 对没有 projectId 的会话每轮都调
 * `reconcileDocumentEvidence(s, [], { forceRebuild: true })`。旧实现里
 * `forceInvalidateDerived` 是无条件生效的，于是每聊一轮就会：
 *
 *   - `delete state["_profiles"]` / `delete state["_endpoints"]`，而这两个**只有**
 *     preparse 和 DAG 流水线会重算（glue/preparse.ts:232-233），reconcile 自己从不重算，
 *     并且它们只活在内存里（`session_state` 里查不到这两个 key）；
 *   - `glue/tools.ts:1039` 是 `if (profiles !== null && Object.keys(profiles).length > 0)`
 *     才注册 `data.profile`，所以列画像一没，这个工具就跟着掉线，直到下次 preparse；
 *   - 顺带把整份 `_chunks` 重新灌一次 EvidenceIndex（真库里最大的会话约 3.9k 切片），
 *     结果和上一轮一模一样。
 *
 * 真实库里 33/42 个会话 `project_id` 为空 —— 这是常态，不是边角。
 */

import { describe, expect, it } from "vitest";

import { reconcileProjectDocumentProjection } from "../src/server/glue/document_projection.js";

type Dict = Record<string, unknown>;

const sessionChunk = { text: "采购申请由部门负责人审批。", locator: { page: 1 } };
const projectChunk = {
  text: "付款条件为月结 30 天。",
  locator: { _document_id: "doc_1", _version_id: "ver_1" },
};

function stateWithDerived(chunks: Dict): Dict {
  return {
    _chunks: chunks,
    _index: { fake: "live index" },
    _profiles: { amount: { kind: "number" } },
    _endpoints: { "/orders": ["GET"] },
  };
}

describe("reconcileProjectDocumentProjection 的撤权范围", () => {
  it("投影里没有项目正文时，forceInvalidateDerived 是空操作", () => {
    const state = stateWithDerived({ "采购制度.md": [sessionChunk] });

    const result = reconcileProjectDocumentProjection(state, [], {
      forceInvalidateDerived: true,
    });

    expect(result.invalidatedDerived).toBe(false);
    expect(result.removedFiles).toEqual([]);
    // 会话自己上传的材料一份都不能少。
    expect(Object.keys(state["_chunks"] as Dict)).toEqual(["采购制度.md"]);
    // 关键：没有任何东西需要撤权，就不该动这三个派生状态。
    expect(state["_profiles"]).toEqual({ amount: { kind: "number" } });
    expect(state["_endpoints"]).toEqual({ "/orders": ["GET"] });
    expect(state["_index"]).toEqual({ fake: "live index" });
  });

  it("投影里确实有项目正文时，照旧 fail-closed 地全部撤掉", () => {
    const state = stateWithDerived({
      "采购制度.md": [sessionChunk],
      "DOC[doc_1@ver_1] 付款条件": [projectChunk],
    });

    const result = reconcileProjectDocumentProjection(state, [], {
      forceInvalidateDerived: true,
    });

    expect(result.invalidatedDerived).toBe(true);
    expect(result.removedFiles).toEqual(["DOC[doc_1@ver_1] 付款条件"]);
    // 撤权后的项目正文必须立刻消失，不能等下次 hydrate。
    expect(Object.keys(state["_chunks"] as Dict)).toEqual(["采购制度.md"]);
    expect(state["_profiles"]).toBeUndefined();
    expect(state["_endpoints"]).toBeUndefined();
    expect(state["_index"]).toBeUndefined();
  });

  it("manifest 仍授权同一版本时，项目正文留下且派生状态不动", () => {
    const state = stateWithDerived({
      "DOC[doc_1@ver_1] 付款条件": [projectChunk],
    });

    const result = reconcileProjectDocumentProjection(
      state,
      [{ document_id: "doc_1", version_id: "ver_1" }],
      {},
    );

    expect(result.invalidatedDerived).toBe(false);
    expect(result.removedFiles).toEqual([]);
    expect(Object.keys(state["_chunks"] as Dict)).toEqual(["DOC[doc_1@ver_1] 付款条件"]);
    expect(state["_profiles"]).toEqual({ amount: { kind: "number" } });
  });
});
