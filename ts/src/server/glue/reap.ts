/**
 * 幽灵跑批的持续回收。
 *
 * 回收器本身早就有（仓储的 `reapExpiredBuildLease`，一道事务里判租约、改状态），
 * 缺的是**复查时机**：此前只在启动对账与会话首次 hydrate 各跑一次。
 * 2026-08-25 实测事故（3b06cae04490）正好落在这个洞里 —— 进程重启把跑批任务打没，
 * hydrate 发生在 13:49:21、租约 13:49:28 才过期，回收器合法拒绝，此后再没人复查：
 * 界面「解析中」挂了 54 分钟，期间一切领域修改（审阅答复、分派、延期）
 * 因 status ∈ BUILD_ACTIVE 被 `claimMutationLease` 全数拒成 409。
 *
 * 于是把复查挪到**高频路径**上：读会话状态、抢领域修改租约时各来一次。
 * 判据一个字没改 —— 能不能回收始终由仓储那道事务说了算，多 worker 下健康
 * worker 的 heartbeat 依然保护它自己的运行。这里只负责：状态对得上才问、
 * 回收成功后把内存投影和 SSE 一起对齐、以及绝不因回收失败带崩调用方。
 */

import type { Repo } from "../../store/repo/protocol.js";
import type { JsonObject } from "../../store/types.js";

/** 跑批激活态（与仓储 `BUILD_ACTIVE`、`isBusy` 同一份口径）。 */
const BUILD_ACTIVE = ["queued", "parsing", "extracting"];

/**
 * 同一个会话两次复查之间的最小间隔（秒）。
 *
 * 复查挂在 `/state` 上 —— 跑批期 SSE 每 400ms 就可能顶一次，每个打开的标签页
 * 各算一份。仓储那道回收事务里有一条 `delete(build_lease) where expires_at<=now`，
 * 命中 0 行也要拿写锁，会和跑批自己的写抢同一把 SQLite 锁。冷却让热路径的成本
 * 与请求频率脱钩：真幽灵最多晚 5 秒被发现，而那 5 秒本来就无关紧要。
 */
export const REAP_COOLDOWN_S = 5;

/**
 * 回收判据的宽限（秒），取一个心跳周期。
 *
 * 以前只有启动对账和首次 hydrate 会来收，租约瞬时过期没人管；现在挂在高频路径上，
 * 只要事件循环被同步活儿卡过一下、租约刚过期，400ms 内就会被收走 —— 而跑批本身
 * 还活着，续租能自愈。往回退一个心跳周期再判：真死的照收，抖一下的给它自愈的机会。
 */
export const REAP_GRACE_S = 10;

/** 上次真的问过仓储的时刻（按会话）。只用于冷却，不参与判据。 */
const LAST_CHECK = new Map<string, number>();

/** 回收后写给用户看的话。**要说清材料和决定还在** —— 否则用户以为白跑一轮。 */
export const REAPED_ERROR =
  "上次运行被中断（进程重启或租约过期），已经跑完的那部分和你的决定都还在。" +
  "再点一次「开始梳理」会接着上次的进度跑。";

/** 这个会话的跑批是幽灵吗？是就回收，并把内存投影与 SSE 对齐。 */
export async function reapZombieBuild(
  s: {
    id: string;
    status: string;
    error: string;
    // payload 收窄成 JsonObject —— Session.emit 的签名就是这个，宽了会不兼容。
    emit: (kind: string, payload?: JsonObject) => unknown;
  },
  repo: Pick<Repo, "reapExpiredBuildLease">,
  now: () => number,
): Promise<boolean> {
  // 高频读路径：状态对不上就连事务都不要开。
  if (!BUILD_ACTIVE.includes(s.status)) return false;
  const at = now();
  const last = LAST_CHECK.get(s.id);
  // 时钟倒退（测试里换钟、线上校时）不算「刚问过」—— 负的间隔按冷却已过处理。
  const since = last === undefined ? Infinity : at - last;
  if (since >= 0 && since < REAP_COOLDOWN_S) return false;
  LAST_CHECK.set(s.id, at);
  let reaped = false;
  try {
    reaped = await repo.reapExpiredBuildLease(s.id, { now: at - REAP_GRACE_S, error: REAPED_ERROR });
  } catch {
    // 回收是**顺带**做的对账，不是调用方的目的。库抖一下不该让「看一眼状态」失败。
    return false;
  }
  if (!reaped) return false;
  s.status = "failed";
  s.error = REAPED_ERROR;
  // 事件是给界面用的：DB 改了而 SSE 不响，用户会一直盯着「解析中」直到手动刷新。
  s.emit("build.reaped", { id: s.id, error: REAPED_ERROR });
  return true;
}
