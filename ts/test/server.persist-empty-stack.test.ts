/**
 * 撤销要真的撤销掉（B3：幽灵补丁）。
 *
 * repo 的 writeDocs / mergeDocs 都是**逐键 upsert，缺键不删旧值**。
 * persist 原来只在 `stack.length > 0` 时才把栈写进 docs —— 于是 undo 把栈
 * pop 成 `[]` 之后，库里仍然留着撤销前的那条补丁；下一次 hydrate 把它载回内存，
 * 重跑时 replayOirPatches 就把这条**用户明确撤销掉的改动**重新贴到新抽取结果上。
 *
 * 同一个仓库的 glue/flow.ts 有一条注释专门写着「不能 delete：repo 的 state
 * 文档是 merge/upsert，缺键不会删除旧值」—— 那条纪律在 persist 里漏了一处。
 */
import { describe, expect, it } from "vitest";

import { PERSISTED_PRIVATE, PERSISTED_PRIVATE_DOCS, VERSION_STACK_CAP } from "../src/server/pipeline/persist.js";

/** 复刻 persist 里那段收集逻辑（它嵌在一个大函数里，单独跑不出来）。 */
function collect(state: Record<string, unknown>): Record<string, unknown> {
  const docs: Record<string, unknown> = {};
  for (const k of PERSISTED_PRIVATE) {
    const stack = state[k] as unknown[] | undefined;
    if (stack !== undefined) {
      state[k] = stack.slice(-VERSION_STACK_CAP);
      docs[k] = state[k];
    }
  }
  for (const k of PERSISTED_PRIVATE_DOCS) {
    const doc = state[k];
    if (doc !== undefined && doc !== null) docs[k] = doc;
  }
  return docs;
}

describe("空栈也要落库", () => {
  it("**撤销把栈清空后必须写空数组** —— 不写的话 upsert 会把旧补丁留在库里", () => {
    const state: Record<string, unknown> = { _oir_patch_log: [] };
    const docs = collect(state);
    expect("_oir_patch_log" in docs).toBe(true);
    expect(docs["_oir_patch_log"]).toEqual([]);
  });

  it("压根没有这个键时才跳过 —— 那是「这个会话没用过」，不是「清空了」", () => {
    expect("_oir_patch_log" in collect({})).toBe(false);
  });

  it("非空照旧写，并且仍然按 CAP 截尾", () => {
    const long = Array.from({ length: VERSION_STACK_CAP + 3 }, (_v, i) => ({ op: `p${i}` }));
    const state: Record<string, unknown> = { _oir_versions: long };
    const docs = collect(state);
    expect(docs["_oir_versions"]).toHaveLength(VERSION_STACK_CAP);
    // 砍的是最旧的
    expect((docs["_oir_versions"] as any[])[0]).toEqual({ op: "p3" });
  });

  it("**PERSISTED_PRIVATE_DOCS 同一个洞**：清空后的 [] / {} 是假值，truthy 会跳过", () => {
    for (const k of PERSISTED_PRIVATE_DOCS) {
      expect(k in collect({ [k]: [] })).toBe(true);
      expect(k in collect({ [k]: {} })).toBe(true);
    }
  });

  it("null 和 undefined 仍然跳过 —— 它们不是「清空了」，是「没有」", () => {
    const k = PERSISTED_PRIVATE_DOCS[0]!;
    expect(k in collect({ [k]: null })).toBe(false);
    expect(k in collect({ [k]: undefined })).toBe(false);
  });

  it("源码里判的是 !== undefined，不是 length > 0（防止有人改回去）", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/server/pipeline/persist.ts", "utf8"));
    expect(src).toContain("if (stack !== undefined) {");
    // 就是这个组合把空栈挡在门外的
    expect(src).not.toContain("stack !== undefined && stack.length > 0");
    expect(src).not.toContain("if (truthy(doc)) docs[k]");
  });
});
