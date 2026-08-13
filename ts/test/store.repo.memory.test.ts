/**
 * `store/repo/memory.ts` 的测试。
 *
 * 主体是**回放** `golden/store.repo.memory.json`：284 步操作流水连同 Python 侧
 * `MemoryRepo` 每一步的真实返回，由 `tools/golden/store_repo_memory.py` 跑真实 Python
 * 导出。场景**只存在于 golden 里**，两侧都不重写 —— 手写期望值等于把我对 Python
 * 行为的猜测钉进测试，而 golden 是它的事实。
 *
 * 回放器只做三件机械的事：方法名 snake→camel、`pos` 原样展开、`kw` 的键 snake→camel
 * 之后当作最后那个 `opts` 对象（protocol.ts 的映射规则 1/2）。所以这份测试同时也在
 * 检验那套映射规则本身是否自洽：只要某个 opts 的字段名或位置/关键字的分界写错了，
 * 回放当场就红。
 *
 * 时钟被换成和导出脚本相同的计数器（1000 起步、每次 +1），所以 `created`/`ts`/
 * `updated` 的自动填充值可以逐字比对 —— 顺带钉住了 `row.created or now()` 的**短路**
 * 语义：哪一步多调或少调一次时钟，后面所有自动时间戳整体偏移，立刻红。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryRepo, cmpCodePoint, deepEqualJson, repoTimeSource } from "../src/store/repo/memory.js";
import { REPO_METHOD_NAMES } from "../src/store/repo/protocol.js";
import { makeDecisionRow, makeProjectRow, makeSessionRow } from "../src/store/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "../../golden/store.repo.memory.json");

interface Op {
  readonly m: string;
  readonly pos: readonly unknown[];
  readonly kw: Readonly<Record<string, unknown>>;
}
type Outcome = { ok: unknown } | { err: { type: string; msg: string } };

const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
  ops: Op[];
  results: Outcome[];
};

/** `record_decision_v1` → `recordDecisionV1`，`from_statuses` → `fromStatuses`。 */
function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** 把 TS 的返回值压成和导出脚本 `ser()` 相同的 JSON 形态。 */
function ser(v: unknown): unknown {
  if (v === undefined) return null; // Python 的 None
  if (v instanceof Set) return [...v].map(ser).sort((a, b) => cmpCodePoint(String(a), String(b)));
  if (Array.isArray(v)) return v.map(ser);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = ser(x);
    return out;
  }
  return v;
}

type AnyFn = (...a: unknown[]) => Promise<unknown>;

/** **上游的一处已知分叉，不是本模块的自由发挥。**
 *
 * `store/types.ts` 的 `validateUsageRow`（DTO track 的文件，本 track 不许改）抛的是
 * 裸 `Error`，而 Python 的 `UsageRow.validate()` 抛 `ValueError`。消息逐字一致，只有
 * 类名不同。放在这里显式列出来，而不是把断言放宽成"只比消息" —— 放宽等于以后所有
 * 异常类名分叉都静默通过。这两条已上报，等 DTO track 换成 ValueError 就删掉此表。 */
const KNOWN_ERROR_NAME_DIVERGENCE: ReadonlyMap<string, string> = new Map([
  ["usage kind 不支持: 乱来", "ValueError"],
  ["usage attempts 必须至少为 1", "ValueError"],
]);

async function replay(repo: MemoryRepo, op: Op): Promise<Outcome> {
  const fn = (repo as unknown as Record<string, AnyFn | undefined>)[camel(op.m)];
  if (typeof fn !== "function") throw new Error(`MemoryRepo 上没有 ${camel(op.m)}`);
  const args = [...op.pos];
  const kwKeys = Object.keys(op.kw);
  if (kwKeys.length > 0) {
    const opts: Record<string, unknown> = {};
    for (const k of kwKeys) opts[camel(k)] = op.kw[k];
    args.push(opts);
  }
  try {
    return { ok: ser(await fn.apply(repo, args)) };
  } catch (e) {
    const err = e as Error;
    const type = KNOWN_ERROR_NAME_DIVERGENCE.get(err.message) ?? err.name;
    return { err: { type, msg: err.message } };
  }
}

/** 与导出脚本同一套假时钟：1000 起步，每次调用先 +1 再返回。 */
function installFakeClock(): () => void {
  const real = repoTimeSource.now;
  let tick = 1000;
  repoTimeSource.now = () => {
    tick += 1;
    return tick;
  };
  return () => {
    repoTimeSource.now = real;
  };
}

describe("MemoryRepo golden 回放", () => {
  it("284 步逐个与 Python 的返回一致", async () => {
    const restore = installFakeClock();
    try {
      const repo = new MemoryRepo();
      expect(golden.ops.length).toBe(golden.results.length);
      for (let i = 0; i < golden.ops.length; i++) {
        const op = golden.ops[i]!;
        const got = await replay(repo, op);
        // 把步号和方法名带进断言消息 —— 284 步里失败一步要能一眼定位。
        expect(got, `第 ${i} 步 ${op.m}(${JSON.stringify(op.pos)}, ${JSON.stringify(op.kw)})`)
          .toEqual(golden.results[i]);
      }
    } finally {
      restore();
    }
  });

  it("覆盖了 Repo 协议里除 atomic 之外的全部方法", () => {
    // atomic 在 TS 侧是回调式（protocol.ts 里登记的形状差异），Python 那边是异步
    // 上下文管理器，没有可以逐字比对的返回值 —— 它单独测。
    const used = new Set(golden.ops.map((o) => camel(o.m)));
    const missing = REPO_METHOD_NAMES.filter((n) => n !== "atomic" && !used.has(n));
    expect(missing).toEqual([]);
  });
});

describe("MemoryRepo 结构", () => {
  it("协议里的 79 个方法一个不少地在实例上是函数", () => {
    const repo = new MemoryRepo();
    const missing = REPO_METHOD_NAMES.filter(
      (n) => typeof (repo as unknown as Record<string, unknown>)[n] !== "function",
    );
    expect(missing).toEqual([]);
    expect(repo.mode).toBe("memory");
  });
});

describe("幂等（PG 侧靠唯一约束、内存侧靠这两段代码）", () => {
  let repo: MemoryRepo;
  let restore: () => void;

  beforeEach(async () => {
    restore = installFakeClock();
    repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({ id: "s", created: 1 }));
  });
  afterEach(() => restore());

  it("session_event.event_id：重发同一条事件返回原行，seq 不涨、payload 不变", async () => {
    const a = await repo.appendEvent("s", "k", { v: 1 }, { eventId: "e" });
    const b = await repo.appendEvent("s", "k", { v: 999 }, { eventId: "e" });
    expect(b).toEqual(a);
    expect(b.payload).toEqual({ v: 1 }); // 第二次的 payload 被丢弃，不是覆盖
    expect(await repo.countEvents("s")).toBe(1);
    // 没有 event_id 的那条老形态**不**幂等 —— 0007 之前写的事件本来就没有身份
    await repo.appendEvent("s", "k", { v: 1 });
    await repo.appendEvent("s", "k", { v: 1 });
    expect(await repo.countEvents("s")).toBe(3);
  });

  it("decision_live_answer_uq：同一 target_rid 的重复回答收敛成一条 active", async () => {
    for (const statement of ["一", "二", "三"]) {
      await repo.recordDecision("s", makeDecisionRow({ ordinal: 0, kind: "answer", target_rid: "c1", statement }));
    }
    await repo.recordDecision("s", makeDecisionRow({ ordinal: 0, kind: "answer", target_rid: "c2" }));
    const active = await repo.listDecisions("s", { activeOnly: true });
    expect(active.map((d) => d.statement)).toEqual(["三", ""]);
    expect(await repo.answeredRids("s")).toEqual(new Set(["c1", "c2"]));
  });

  it("ordinal 是计数器：被推翻的那几条照样占号，不会被压缩重排", async () => {
    for (const s of ["一", "二", "三"]) {
      await repo.recordDecision("s", makeDecisionRow({ ordinal: 0, kind: "answer", target_rid: "c1", statement: s }));
    }
    const all = await repo.listDecisions("s");
    expect(all.map((d) => d.ordinal)).toEqual([0, 1, 2]);
    expect(all.map((d) => d.superseded_by)).toEqual([1, 2, null]);
  });

  it("recordDecisionV1：同一幂等键重放返回原行；换了语义就炸", async () => {
    const base = {
      id: "d1",
      question_id: "q",
      answer: "A" as const,
      actor: "u",
      actor_role: "",
      authority: "",
      source_turn: "",
      affected_ids: [],
      supersedes: null,
      revision: null,
      idempotency_key: "k",
      semantic_hash: "h",
      rationale: "",
      metadata: {},
      created: 0,
    };
    const [first, created] = await repo.recordDecisionV1("s", base);
    expect(created).toBe(true);
    const [again, created2] = await repo.recordDecisionV1("s", { ...base, id: "d2" });
    expect(created2).toBe(false);
    expect(again.id).toBe(first.id);
    await expect(
      repo.recordDecisionV1("s", { ...base, id: "d3", semantic_hash: "别的" }),
    ).rejects.toMatchObject({ name: "IdempotencyConflict" });
  });
});

describe("删会话的清理边界", () => {
  it("session id 与 project id 撞车时，删会话不碰项目/项目记忆/账号/设置", async () => {
    // 红队确认过的坑：清理循环拿 **session id** 去 pop，而项目容器是按
    // **project id** 键的。把项目容器加进清理列表，这一步就会连项目一起删掉。
    const repo = new MemoryRepo();
    await repo.createProject(makeProjectRow({ id: "X", name: "同名项目" }));
    await repo.upsertProjectMemory([
      { project_id: "X", key: "k", tier: "authoritative", kind: "convention", content: "c",
        confidence: 0.5, support: [], tags: [], origin_session: "", origin_files: [],
        contested_by: [], hit_runs: [], use_count: 0, created_run: "", last_used_run: "" },
    ]);
    await repo.setSetting("X", 1);
    await repo.createSession(makeSessionRow({ id: "X", created: 1 }));

    expect(await repo.deleteSession("X")).toBe(true);
    expect(await repo.getSession("X")).toBeNull();
    expect(await repo.getProject("X")).not.toBeNull();
    expect((await repo.listProjectMemory("X")).length).toBe(1);
    expect(await repo.getSetting("X")).toBe(1);
  });
});

describe("atomic", () => {
  it("回调的返回值原样透出", async () => {
    const repo = new MemoryRepo();
    const scope = await repo.atomic(async (s) => s);
    expect(scope).toBe(repo); // MemoryRepo 交出的就是它自己
    expect(await repo.atomic(async () => 42)).toBe(42);
  });

  it("**不假装有事务**：半途抛出会留下部分写入", async () => {
    // 这不是待修的缺陷，是内存模式的代价。假装能回滚会让人在内存模式下写出依赖
    // 回滚的代码，切到 Postgres 才发现语义对不上。
    const repo = new MemoryRepo();
    await expect(
      repo.atomic(async () => {
        await repo.createSession(makeSessionRow({ id: "a", created: 1 }));
        throw new Error("半途炸了");
      }),
    ).rejects.toThrow("半途炸了");
    expect(await repo.getSession("a")).not.toBeNull();
  });
});

describe("移植期新增的判据（Python 侧不可能踩的坑）", () => {
  it("cmpCodePoint 按码位排，不按 UTF-16 码元", () => {
    // U+FFFD(65533) > U+1F600(128512) 在码元序下成立（代理对首元 0xD83D=55357），
    // 在码位序下不成立。Python 的 sorted 是后者。
    expect(cmpCodePoint("�", "\u{1F600}")).toBe(-1);
    expect("�" < "\u{1F600}").toBe(false); // JS 默认比较正好反过来
    expect(cmpCodePoint("a", "a")).toBe(0);
    expect(cmpCodePoint("ab", "a")).toBe(1);
  });

  it("deepEqualJson 与 Python 的 dict/list 相等语义一致", () => {
    expect(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true); // 键序无关
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false); // 列表有序
    expect(deepEqualJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqualJson({ a: 1 }, { a: 1, b: null })).toBe(false); // 多一个键就不等
    expect(deepEqualJson(undefined, undefined)).toBe(true);
    expect(deepEqualJson({ a: 1 }, undefined)).toBe(false);
  });

  it("载荷与状态文档的存储走 Map：整数样式的键不会被提到最前", async () => {
    const repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({ id: "s", created: 1 }));
    await repo.setSetting("10", 1);
    await repo.setSetting("2", 2);
    await repo.setSetting("b", 3);
    // 普通对象在这里会给出 2,10,b —— Python 的 dict 是插入序。
    expect((await repo.listSettings()).map((r) => r.key)).toEqual(["10", "2", "b"]);
    await repo.addFiles("s", [
      { name: "10.pdf", rel_path: "x", size: 1, sha256: "" },
      { name: "2.pdf", rel_path: "x", size: 1, sha256: "" },
    ]);
    expect((await repo.listFiles("s")).map((f) => f.name)).toEqual(["10.pdf", "2.pdf"]);
  });
});
