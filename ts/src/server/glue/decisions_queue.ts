/**
 * 跑批中的人工拍板队列。
 *
 * 与 `glue/mutations.ts` 同一个判断的另一半：**跑中不动活状态，但绝不丢掉人的
 * 输入**。此前跑批激活期 `POST /answer` 直接被 mutation 租约拒成 409 —— 而系统
 * 恰恰在这时把决策卡摆在用户面前请他拍板（2026-08-25 实拍：会话正在 extracting，
 * 聊天里「2 个待拍板」，点确认毫无反应）。请人回答又不收，是产品自相矛盾。
 *
 * 决定天生适合排队：
 *  · `idempotencyKey` 让重放安全 —— 落账走的仍是同一个 `answerDomainQuestionOnce`；
 *  · 人答的是业务口径（谁是 SoR、哪个才算准），与跑批当前把模型改成什么形状无关；
 *  · 队列进 `_decision_queue`（PERSISTED_PRIVATE_DOCS 那一组），跨重启还在。
 *
 * 纪律与 mutation 队列一致：按序、单条失败不拖累其余、失败必须发事件说出来。
 * 失败条也出队 —— 留着只会每一轮重试同一条必然失败的回答。
 */

/**
 * 跑批激活期租约冲突的机器可读标记。
 *
 * **不许靠中文文案分诊。** `withSessionMutation` 抢不到租约时的通用文案是
 * 「会话正在梳理或另一个领域修改尚未提交，请稍后重试。」—— 它同样含「正在梳理」
 * 四个字，而它覆盖的是**聊天轮持锁**这类与跑批无关的情况（work 模式一整轮
 * 独占 mutation 租约）。第一版按文案匹配的后果：那种冲突下人的拍板被塞进一个
 * 只在 Run 收尾才 drain 的队列，而这个会话根本没有 Run —— 界面说「本轮跑完自动
 * 落账」，实际永远不会落，比当场报错更糟。
 */
export const BUILD_ACTIVE_CONFLICT = "ontocopilot.lease.build_active";

/** 这个异常是不是「跑批激活期」那一种 409。只认标记。 */
export function isBuildActiveConflict(exc: unknown): boolean {
  if (exc === null || typeof exc !== "object") return false;
  const status = (exc as { status?: unknown }).status;
  if (status !== 409) return false;
  return (exc as { cause?: unknown }).cause === BUILD_ACTIVE_CONFLICT;
}

/** 队列里一条：保管 qid 与请求体，落账时照旧走既有回答实现。 */
export interface QueuedDecision {
  readonly qid: string;
  readonly body: Record<string, unknown>;
  /** 人点下去那一刻看到的问题版本。**只作审计留痕，不作落账判据** —— 见下。 */
  readonly sawRevision?: number;
}

interface DecisionSession {
  readonly id: string;
  readonly state: Record<string, unknown>;
  emit: (kind: string, payload?: Record<string, unknown>) => unknown;
}

const QUEUE_KEY = "_decision_queue";

/** 当前队列（就地建）。 */
export function decisionQueueOf(s: DecisionSession): QueuedDecision[] {
  const raw = s.state[QUEUE_KEY];
  if (Array.isArray(raw)) return raw as QueuedDecision[];
  const fresh: QueuedDecision[] = [];
  (s.state as Record<string, unknown>)[QUEUE_KEY] = fresh;
  return fresh;
}

/**
 * 排一条，返回排队后的深度。同 idempotencyKey 视为同一次点击，不重复排。
 *
 * **剥掉 expected_revision**：乐观锁防的是「另一个人同时改了这条」，而排队的这条
 * 要等一整轮跑批结束才落账 —— 跑批本身就会推进问题版本（重挖描述、重编译），
 * 带着点击那一刻的版本号去落账等于给每次排队的拍板预约一个 409，人的输入照样丢，
 * 只是换了个死法。「别人已经答过就不许覆写」这条保护不靠 CAS：
 * `answerDomainQuestionOnce` 的终态守卫在任何副作用之前就会拒绝 answered/cancelled。
 * 人当时看到的版本仍然留痕（sawRevision），审计要得回来。
 */
export function enqueueDecision(s: DecisionSession, d: QueuedDecision): number {
  const q = decisionQueueOf(s);
  const idem = String(d.body["idempotencyKey"] ?? d.body["idempotency_key"] ?? "");
  if (idem) {
    const dup = q.some((row) =>
      String(row.body["idempotencyKey"] ?? row.body["idempotency_key"] ?? "") === idem);
    if (dup) return q.length;
  }
  const body = { ...d.body };
  const saw = body["expected_revision"] ?? body["expectedRevision"];
  delete body["expected_revision"];
  delete body["expectedRevision"];
  const sawRevision = typeof saw === "number" ? saw : Number.parseInt(String(saw ?? ""), 10);
  q.push({
    qid: d.qid,
    body,
    ...(Number.isFinite(sawRevision) ? { sawRevision } : {}),
  });
  return q.length;
}

export interface DecisionDrainResult {
  readonly applied: string[];
  readonly failed: { qid: string; error: string }[];
}

/**
 * 按序落账并清空。**只该在 Run 正常收尾后调**（与 drainMutationQueue 同一处）：
 * 那时 OIR/产物是这一轮的终态，回写落在最终状态上。
 */
export async function drainDecisionQueue(
  s: DecisionSession,
  answer: (qid: string, body: Record<string, unknown>) => Promise<unknown>,
): Promise<DecisionDrainResult> {
  const q = decisionQueueOf(s);
  if (q.length === 0) return { applied: [], failed: [] };
  const pending = [...q];
  (s.state as Record<string, unknown>)[QUEUE_KEY] = [];
  const applied: string[] = [];
  const failed: { qid: string; error: string }[] = [];
  for (const row of pending) {
    try {
      await answer(row.qid, row.body);
      applied.push(row.qid);
    } catch (exc) {
      const error = exc instanceof Error ? exc.message : String(exc);
      failed.push({ qid: row.qid, error });
      // 一次人工拍板没落上账是必须让人看见的事，不能只留在日志里。
      s.emit("decisions.failed", { qid: row.qid, error });
    }
  }
  if (applied.length > 0) s.emit("decisions.applied", { count: applied.length, questions: applied });
  return { applied, failed };
}
