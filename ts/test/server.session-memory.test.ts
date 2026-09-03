/**
 * 会话记忆（改动记忆）。
 *
 * 实测真实库：11 个会话 `dialogue.decisions` **全是 0**，而其中三个明明有
 * `_oir_patch_log`（真发生过编辑）。原因是编辑那段的决定记录写在 `else` 分支里，
 * `source === "generic_assumption"` 直接跳过 —— 而无材料草案路径上的每一次编辑
 * 都是这个 source。于是**整条无材料工作流不留任何记忆**。
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_LOG_CAP, memoryLog, rememberChange,
} from "../src/server/dialogue/memory.js";

const session = (): any => ({ id: "s1", state: {} as Record<string, unknown> });

describe("rememberChange", () => {
  it("序号从 1 起、按写入顺序递增 —— 用序号排序而不是时钟（时钟会破坏重放）", () => {
    const s = session();
    rememberChange(s, { kind: "edit", what: "改了 A" });
    rememberChange(s, { kind: "edit", what: "改了 B" });
    expect(memoryLog(s).map((e) => [e.seq, e.what]))
      .toEqual([[1, "改了 A"], [2, "改了 B"]]);
  });

  it("**basis 是这份记忆最值钱的一列** —— 人明说的和凭通识补的必须分得开", () => {
    const s = session();
    rememberChange(s, { kind: "edit", what: "人说的", basis: "user" });
    rememberChange(s, { kind: "edit", what: "猜的", basis: "generic_assumption" });
    expect(memoryLog(s).map((e) => e.basis)).toEqual(["user", "generic_assumption"]);
  });

  it("不给 basis 默认按人明说的算 —— 只有显式标了才是假设", () => {
    const s = session();
    rememberChange(s, { kind: "edit", what: "x" });
    expect(memoryLog(s)[0]!.basis).toBe("user");
  });

  it("**改了就记，不在写入侧筛** —— 在写入侧判断「重不重要」就是当初那个 bug", () => {
    const s = session();
    for (const basis of ["user", "generic_assumption", "material"]) {
      rememberChange(s, { kind: "edit", what: `by ${basis}`, basis });
    }
    expect(memoryLog(s)).toHaveLength(3);
  });

  it("封顶后丢最老的，序号不回退", () => {
    const s = session();
    for (let i = 0; i < MEMORY_LOG_CAP + 5; i += 1) {
      rememberChange(s, { kind: "edit", what: `第 ${i} 条` });
    }
    const log = memoryLog(s);
    expect(log).toHaveLength(MEMORY_LOG_CAP);
    expect(log[0]!.what).toBe("第 5 条");
    expect(log[log.length - 1]!.seq).toBe(MEMORY_LOG_CAP + 5);
  });

  it("refs 去空、tool 记下来 —— 出问题要能顺着查是谁写的", () => {
    const s = session();
    rememberChange(s, { kind: "canvas", what: "绑了对象", refs: ["ot_a", "", "ot_b"], tool: "flow.bind_objects" });
    expect(memoryLog(s)[0]).toMatchObject({ refs: ["ot_a", "ot_b"], tool: "flow.bind_objects" });
  });

  it("落在公开 state 上（右栏和导出都要读），并且进了持久化白名单", async () => {
    const s = session();
    rememberChange(s, { kind: "edit", what: "x" });
    expect(Array.isArray(s.state["memory_log"])).toBe(true);
    const { PERSISTED } = await import("../src/server/pipeline/persist.js");
    expect([...PERSISTED]).toContain("memory_log");
  });
});
