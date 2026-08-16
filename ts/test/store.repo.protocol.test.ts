/**
 * `store/repo/protocol.ts` 的结构性测试。
 *
 * 接口在运行时被擦除，所以"少写了一个方法"不会有任何东西变红 —— 而这份接口有
 * **79 个方法**、两份实现照它写，漏一个的代价是等到某条路由真被走到才炸。
 *
 * ── 期望值从哪来 ────────────────────────────────────────────────
 *
 * 原来是**解析 Python 原件** `store/repo.py` 的 `class Repo(Protocol)`：
 * 「Python 是权威，不是手抄的期望值」。全量 TypeScript 化之后 `src/ontocopilot/`
 * 已经删掉，解析不到了 —— 但**契约本身一个字没变**，所以改读
 * `golden/python.frozen.json`：那份 golden 是删除前从 Python 原件一次性冻下来的
 * （含来源提交 `_frozen_at`，随时 `git show <sha>:src/ontocopilot/store/repo.py` 复核）。
 *
 * 换来源不换判据：TS 侧凭空多一个方法、少一个方法，照样红。
 * 代价写明白：Python 侧不会再变了（它不存在了），所以这份清单从"跟着上游走"
 * 变成了"钉住历史那一刻"——这正是删掉参照物的真实后果，不粉饰。
 *
 * `REPO_METHOD_NAMES` 与 `keyof Repo` 的一致性由 protocol.ts 里那两个类型别名在
 * **编译期**保证，所以这里只需要钉住「清单 ↔ 冻结的事实」这一段。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DuplicateUsername, REPO_METHOD_NAMES } from "../src/store/repo/protocol.js";

interface Frozen {
  _frozen_at: string;
  repo_protocol: { methods: string[]; count: number; properties: string[] };
}

const FROZEN: Frozen = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../golden/python.frozen.json"),
    "utf8",
  ),
) as Frozen;

/** `record_decision_v1` → `recordDecisionV1`。下划线后一律大写首字母，
 * 数字段（`v1`）因此变成 `V1` —— 与 protocol.ts 里手写的名字对齐。 */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

describe("Repo 协议接口", () => {
  it("方法名清单与冻结下来的 Python 原件逐个对齐", () => {
    expect([...REPO_METHOD_NAMES].sort()).toEqual(
      FROZEN.repo_protocol.methods.map(toCamel).sort(),
    );
  });

  it("方法数就是 Python 那边的 79 个", () => {
    // 写死这个数字是故意的：上一条断言只保证两边"一样"，两边同时被删掉一个方法
    // 它照样绿。这一条把绝对规模也钉住。
    expect(FROZEN.repo_protocol.count).toBe(79);
    expect(REPO_METHOD_NAMES).toHaveLength(79);
  });

  it("清单里没有重名", () => {
    expect(new Set(REPO_METHOD_NAMES).size).toBe(REPO_METHOD_NAMES.length);
  });

  it("Python 侧的 mode 属性不会被当成方法", () => {
    // 它在 Python 里是 `mode: str` 注解，不是 def —— 冻结时按属性归类。
    expect(FROZEN.repo_protocol.properties).toContain("mode");
    expect([...REPO_METHOD_NAMES]).not.toContain("mode");
  });

  it("DuplicateUsername 是从 types.ts 转出来的同一个类，不是新定义的", async () => {
    const types = await import("../src/store/types.js");
    expect(DuplicateUsername).toBe(types.DuplicateUsername);
    expect(new DuplicateUsername("x")).toBeInstanceOf(Error);
  });
});
