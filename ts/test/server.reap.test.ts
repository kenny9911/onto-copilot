/**
 * 幽灵跑批的持续回收。
 *
 * 2026-08-25 实测事故（会话 3b06cae04490）：进程重启把跑批任务打没了，DB 里
 * `status='parsing'` 留着，build 租约 13:49:28 过期 —— 而**唯一两处回收器**
 * （启动对账 `reconcileOnBoot`、首次 hydrate）都发生在 13:49:21 之前，租约那时
 * 还活着 7 秒，回收器合法拒绝。之后再没有任何人复查：
 *   · 界面永远显示「解析中」，用户等了 54 分钟并两次在对话里追问进度；
 *   · `claimMutationLease` 因 status ∈ BUILD_ACTIVE 必拒 —— 审阅答复全部 409。
 * 也就是说「解析很久」和「保存不了」是同一件事。
 *
 * 修法：读会话状态与抢领域修改租约这两条**高频路径**上各补一次回收复查。
 * 回收判据仍然只由仓储那道事务给（租约确实过期/不存在才动），多 worker 语义不变。
 */

import { describe, expect, it } from "vitest";

import { REAP_COOLDOWN_S, REAP_GRACE_S, reapZombieBuild } from "../src/server/glue/reap.js";
import type { Repo } from "../src/store/repo/protocol.js";
import type { SessionLike } from "../src/server/pipeline/types.js";

let seq = 0;

/** 每条用例一个独立会话 id —— 冷却表是模块级的，共用 id 会让用例互相污染。 */
function fakeSession(over: Partial<SessionLike> = {}): SessionLike {
  const events: unknown[] = [];
  seq += 1;
  return {
    id: `s${seq}`,
    status: "parsing",
    error: "",
    events,
    emit(kind: string, payload: Record<string, unknown> = {}) {
      const ev = { ...payload, kind };
      events.push(ev);
      return ev as never;
    },
    ...over,
  } as unknown as SessionLike;
}

function fakeRepo(reap: (sid: string) => Promise<boolean>): Repo {
  return { reapExpiredBuildLease: async (sid: string) => await reap(sid) } as unknown as Repo;
}

describe("reapZombieBuild", () => {
  it("租约真过期：投影跟着落到 failed，并发事件让界面停掉「解析中」", async () => {
    const s = fakeSession();
    const reaped = await reapZombieBuild(s, fakeRepo(async () => true), () => 1_000);
    expect(reaped).toBe(true);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("中断");
    // SSE 要有东西可发 —— 否则 DB 改了、界面还停在解析中，直到用户手动刷新。
    expect((s.events as { kind: string }[]).map((e) => e.kind)).toContain("build.reaped");
  });

  it("租约还活着（仓储拒绝回收）：一个字都不改", async () => {
    const s = fakeSession();
    const reaped = await reapZombieBuild(s, fakeRepo(async () => false), () => 1_000);
    expect(reaped).toBe(false);
    expect(s.status).toBe("parsing");
    expect(s.events).toHaveLength(0);
  });

  it("不在跑批状态：连仓储都不问（这是高频读路径，不能每次都开事务）", async () => {
    const s = fakeSession({ status: "idle" });
    let asked = 0;
    const reaped = await reapZombieBuild(s, fakeRepo(async () => { asked += 1; return true; }), () => 1);
    expect(reaped).toBe(false);
    expect(asked).toBe(0);
    expect(s.status).toBe("idle");
  });

  it("冷却：同一个会话短时间内只开一次事务（/state 是最高频读路径）", async () => {
    // 跑批期 SSE 每 400ms 就可能顶一次 /state，每个打开的标签页各算一份。
    // 每次都进一次写事务，会和跑批本身抢同一把 SQLite 写锁。
    const s = fakeSession();
    let asked = 0;
    const repo = fakeRepo(async () => { asked += 1; return false; });
    let clock = 1_000;
    const now = () => clock;
    await reapZombieBuild(s, repo, now);
    await reapZombieBuild(s, repo, now);
    await reapZombieBuild(s, repo, now);
    expect(asked).toBe(1);
    clock += REAP_COOLDOWN_S + 1;         // 冷却过了才允许再问一次
    await reapZombieBuild(s, repo, now);
    expect(asked).toBe(2);
  });

  it("宽限：不拿「此刻」当判据，留一个心跳周期 —— 瞬时抖动不该被秒杀", async () => {
    // 回收器搬到高频路径之后，租约只要瞬时过期就会在 400ms 内被收走。
    // 传给仓储的 now 往回退一个宽限，真过期的照收，刚过一秒的给它自愈的机会。
    const s = fakeSession();
    let sawNow = 0;
    const repo = fakeRepo(async () => true) as any;
    repo.reapExpiredBuildLease = async (_sid: string, opts: { now: number }) => {
      sawNow = opts.now;
      return true;
    };
    await reapZombieBuild(s, repo, () => 10_000);
    expect(sawNow).toBe(10_000 - REAP_GRACE_S);
  });

  it("仓储抛错不能把读状态的请求带崩", async () => {
    const s = fakeSession();
    const repo = fakeRepo(async () => { throw new Error("db down"); });
    await expect(reapZombieBuild(s, repo, () => 1)).resolves.toBe(false);
    expect(s.status).toBe("parsing");
  });
});
