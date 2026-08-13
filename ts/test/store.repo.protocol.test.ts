/**
 * `store/repo/protocol.ts` 的结构性测试。
 *
 * 接口在运行时被擦除，所以"少写了一个方法"不会有任何东西变红 —— 而这份接口有
 * **79 个方法**、两份实现照它写，漏一个的代价是等到某条路由真被走到才炸。
 *
 * 这里的做法是把 Python 原件当权威：解析 `store/repo.py` 里 `class Repo(Protocol)`
 * 的方法名，snake_case → camelCase 之后与 `REPO_METHOD_NAMES` 逐个比对。
 * Python 侧加了方法而 TS 侧没跟，测试立刻红；TS 侧凭空多出一个，同样红。
 *
 * `REPO_METHOD_NAMES` 与 `keyof Repo` 的一致性由 protocol.ts 里那两个类型别名在
 * **编译期**保证，所以这里只需要钉住「清单 ↔ Python 原件」这一段。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DuplicateUsername, REPO_METHOD_NAMES } from "../src/store/repo/protocol.js";

const REPO_PY = join(dirname(fileURLToPath(import.meta.url)), "../../src/ontocopilot/store/repo.py");

/** 从 repo.py 里切出 `class Repo(Protocol):` 的类体。
 *
 * 按缩进切而不是按行号切：行号会随 Python 侧任何改动漂移，缩进不会。
 * 终止条件是第一行"顶格且非空非注释"的代码 —— 也就是下一个顶层定义。 */
function repoProtocolBody(): string[] {
  const lines = readFileSync(REPO_PY, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("class Repo(Protocol):"));
  expect(start, "repo.py 里找不到 class Repo(Protocol)").toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("#")) break;
    body.push(line);
  }
  return body;
}

/** 只认类体第一层（正好四个空格）的 `def` / `async def`。
 * 嵌套函数（更深缩进）不属于协议表面，`mode: str` 那种注解也不是方法。 */
function pythonMethodNames(): string[] {
  const out: string[] = [];
  for (const line of repoProtocolBody()) {
    const m = /^ {4}(?:async )?def ([A-Za-z_]\w*)\(/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** `record_decision_v1` → `recordDecisionV1`。下划线后一律大写首字母，
 * 数字段（`v1`）因此变成 `V1` —— 与 protocol.ts 里手写的名字对齐。 */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

describe("Repo 协议接口", () => {
  it("方法名清单与 Python 原件逐个对齐", () => {
    expect([...REPO_METHOD_NAMES]).toEqual(pythonMethodNames().map(toCamel));
  });

  it("方法数就是 Python 那边的 79 个", () => {
    // 写死这个数字是故意的：上一条断言只保证两边"一样"，两边同时被删掉一个方法
    // 它照样绿。这一条把绝对规模也钉住。
    expect(pythonMethodNames()).toHaveLength(79);
    expect(REPO_METHOD_NAMES).toHaveLength(79);
  });

  it("清单里没有重名", () => {
    expect(new Set(REPO_METHOD_NAMES).size).toBe(REPO_METHOD_NAMES.length);
  });

  it("Python 侧的 mode 属性不会被当成方法", () => {
    expect(repoProtocolBody().some((l) => l.trim() === "mode: str")).toBe(true);
    expect([...REPO_METHOD_NAMES]).not.toContain("mode");
  });

  it("DuplicateUsername 是从 types.ts 转出来的同一个类，不是新定义的", async () => {
    const types = await import("../src/store/types.js");
    expect(DuplicateUsername).toBe(types.DuplicateUsername);
    expect(new DuplicateUsername("x")).toBeInstanceOf(Error);
  });
});
