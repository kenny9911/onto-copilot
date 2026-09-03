/**
 * 跑批中的人工拍板：排队，不是拒绝。
 *
 * 2026-08-25 用户实拍（会话 3f6079e3e38f，status=extracting、心跳健康）：聊天里
 * 摆着「我梳理时发现了这些 · 2 个待拍板」的决策卡，用户选了选项点「确认」——
 * 什么都没发生。真相是 `POST /answer` 走 `sessionMutation`，跑批激活期租约必拒，
 * 前端 `postAnswer` 又没有 catch，409 被静默吞掉。
 *
 * 这是产品自相矛盾的一处：**系统主动请人拍板，然后不收**。而人的这一次输入是
 * 这个产品里最贵的东西，绝不能因为「机器正忙」丢掉。
 *
 * 修法沿用第 3 层已经建好的 durable mutation queue 的判断：跑中不改活状态，
 * 但**登记下来**，Run 正常收尾后按序落账。决定天生适合排队 —— idempotencyKey
 * 让重放安全，答案内容与跑批产物无关（人答的是业务口径，不是模型当前形状）。
 */

import { describe, expect, it } from "vitest";

import {
  decisionQueueOf,
  drainDecisionQueue,
  enqueueDecision,
} from "../src/server/glue/decisions_queue.js";

interface FakeSession {
  id: string;
  state: Record<string, unknown>;
  events: { kind: string; payload: Record<string, unknown> }[];
  emit: (kind: string, payload?: Record<string, unknown>) => unknown;
}

function fakeSession(): FakeSession {
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  return {
    id: "s1",
    state: {},
    events,
    emit(kind: string, payload: Record<string, unknown> = {}) {
      events.push({ kind, payload });
      return payload;
    },
  };
}

describe("决定排队", () => {
  it("入队保留原样的 qid/body，并落在会话状态里（能跨重启活下来）", () => {
    const s = fakeSession();
    const depth = enqueueDecision(s, { qid: "q1", body: { answer: "opt_a", idempotencyKey: "idem-1" } });
    expect(depth).toBe(1);
    expect(s.state["_decision_queue"]).toEqual([
      { qid: "q1", body: { answer: "opt_a", idempotencyKey: "idem-1" } },
    ]);
    expect(decisionQueueOf(s)).toHaveLength(1);
  });

  it("排队时剥掉 expected_revision —— 跨一整轮跑批的乐观锁必然过期", () => {
    // 乐观锁防的是「另一个人同时改了这条」。可排队的这一条要等一整轮跑完才落账，
    // 而跑批本身就会推进问题版本（重挖描述、重编译）—— 带着点击那一刻的版本号
    // 去落账，等于给每一次排队的拍板预约一个 409。终态守卫仍在（答过/取消过的
    // 问题在 answerDomainQuestionOnce 里会被明确拒绝，且早于任何副作用），
    // 「别人已经答了就不许覆写」这条保护不靠 CAS 也成立。
    const s = fakeSession();
    enqueueDecision(s, {
      qid: "q1",
      body: { answer: "a", idempotencyKey: "i1", expected_revision: 3, expectedRevision: 3 },
    });
    const row = (s.state["_decision_queue"] as any[])[0];
    expect(row.body).toEqual({ answer: "a", idempotencyKey: "i1" });
    expect(row.sawRevision).toBe(3);   // 人当时看到的版本仍然记下来，供审计
  });

  it("同一个 idempotencyKey 重复点不会排两遍（用户连点两下也只落一条）", () => {
    const s = fakeSession();
    enqueueDecision(s, { qid: "q1", body: { answer: "a", idempotencyKey: "idem-1" } });
    const depth = enqueueDecision(s, { qid: "q1", body: { answer: "a", idempotencyKey: "idem-1" } });
    expect(depth).toBe(1);
  });

  it("drain 按序落账并清空；每条都发事件（用户要看得到「刚才那次确认生效了」）", async () => {
    const s = fakeSession();
    enqueueDecision(s, { qid: "q1", body: { answer: "a", idempotencyKey: "i1" } });
    enqueueDecision(s, { qid: "q2", body: { answer: "b", idempotencyKey: "i2" } });
    const seen: string[] = [];
    const result = await drainDecisionQueue(s, async (qid) => { seen.push(qid); });
    expect(seen).toEqual(["q1", "q2"]);
    expect(result.applied).toEqual(["q1", "q2"]);
    expect(result.failed).toEqual([]);
    expect(decisionQueueOf(s)).toHaveLength(0);
    expect(s.events.map((e) => e.kind)).toContain("decisions.applied");
  });

  it("单条失败不拖累其余，且失败要说出来（不许静默丢一次人工拍板）", async () => {
    const s = fakeSession();
    enqueueDecision(s, { qid: "bad", body: { answer: "a", idempotencyKey: "i1" } });
    enqueueDecision(s, { qid: "ok", body: { answer: "b", idempotencyKey: "i2" } });
    const result = await drainDecisionQueue(s, async (qid) => {
      if (qid === "bad") throw new Error("问题已不在清单里");
    });
    expect(result.applied).toEqual(["ok"]);
    expect(result.failed).toEqual([{ qid: "bad", error: "问题已不在清单里" }]);
    expect(decisionQueueOf(s)).toHaveLength(0); // 失败条也出队，否则每轮重试同一条
    const failure = s.events.find((e) => e.kind === "decisions.failed");
    expect(failure?.payload["qid"]).toBe("bad");
  });

  it("空队列不发事件（每轮收尾都调它，没东西时要安静）", async () => {
    const s = fakeSession();
    const result = await drainDecisionQueue(s, async () => { throw new Error("不该被调用"); });
    expect(result.applied).toEqual([]);
    expect(s.events).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  排队的前提：**真的在跑批**
//
//  第一版分诊靠中文文案匹配（/正在梳理/），而 withSessionMutation 抢不到租约时的
//  **通用**文案是「会话正在梳理或另一个领域修改尚未提交，请稍后重试。」—— 聊天
//  轮持锁（work 模式一整轮独占 mutation 租约）也会走进这句。于是人的拍板被塞进
//  一个只在 Run 收尾才 drain 的队列，而这个会话根本没有 Run 在跑：界面说「本轮跑完
//  自动落账」，实际是永远不会落。分诊必须靠机器可读的标记，不是文案。
// ══════════════════════════════════════════════════════════════════

import { HTTPException } from "hono/http-exception";

import { BUILD_ACTIVE_CONFLICT, isBuildActiveConflict } from "../src/server/glue/decisions_queue.js";

describe("跑批冲突的机器可读标记", () => {
  it("只认标记，不认文案 —— 通用租约冲突（聊天轮持锁）不算跑批", () => {
    const generic = new HTTPException(409, {
      message: "会话正在梳理或另一个领域修改尚未提交，请稍后重试。",
    });
    expect(isBuildActiveConflict(generic)).toBe(false);
  });

  it("带标记的才算 —— 文案怎么写都不影响判定", () => {
    const marked = new HTTPException(409, {
      message: "会话正在梳理（parsing），本轮跑完才能保存这类修改。",
      cause: BUILD_ACTIVE_CONFLICT,
    });
    expect(isBuildActiveConflict(marked)).toBe(true);
  });

  it("别的异常一律不是（500、普通 Error、null 都不许被当成跑批）", () => {
    expect(isBuildActiveConflict(new HTTPException(500, { message: "会话正在梳理" }))).toBe(false);
    expect(isBuildActiveConflict(new Error("会话正在梳理"))).toBe(false);
    expect(isBuildActiveConflict(null)).toBe(false);
  });
});
