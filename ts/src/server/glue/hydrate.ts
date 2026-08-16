/**
 * `_hydrate` / `_hydrate_once` / `_hydrate_into`（`server.py` 1763 / 1786 / 1826）。
 *
 * **重启后打开一个旧会话，必须真的能用** —— 只把标题和文件名读回来、而所有操作
 * 都 409，比列表里干脆不显示它更糟：用户看着一个"完成"的会话，点什么都没反应。
 *
 * 重的东西（OIR、证据索引）按需重建：OIR 从 oir.json 反序列化，索引重新解析材料
 * （xlsx 解析是零模型调用的）。扫描件例外 —— 它要过视觉模型，重建要花钱，所以留到
 * 用户真的点了「重新梳理」。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { HTTPException } from "hono/http-exception";

import { sha256Hex } from "../../kernel/ids.js";
import { flowFromDict } from "../../onto/flow.js";
import { oirFromDict } from "../../onto/oir.js";
import { QuestionBacklog } from "../../onto/questions.js";
import { eventRowAsSse } from "../../store/types.js";
import type { SessionRow } from "../../store/types.js";
import { SESSIONS, Session, root, withHydrateLock } from "../session.js";
import type { SessionFile } from "../session.js";
import type { GlueDeps } from "./deps.js";
import { syncQuestionBacklog } from "./questions.js";

/** Single-flight 地把库里/盘上的会话变回一个活的 {@link Session}。 */
export async function hydrate(sid: string, deps: GlueDeps): Promise<Session> {
  const cached = SESSIONS.get(sid);
  if (cached !== undefined) return cached;
  return await withHydrateLock(sid, async () => {
    // 等锁期间首个调用者已完成恢复；所有并发等待者必须拿同一实例。
    const again = SESSIONS.get(sid);
    if (again !== undefined) return again;
    return await hydrateOnce(sid, deps);
  });
}

export async function hydrateOnce(sid: string, deps: GlueDeps): Promise<Session> {
  const row = await deps.repo().getSession(sid);
  const d = join(root(), sid);
  if (row === null && (!existsSync(d) || existsSync(join(d, ".deleted")))) {
    throw new HTTPException(404, { message: `没有会话 ${sid}` });
  }
  const s = new Session(sid, {
    title: row !== null ? row.title : sid,
    project: row !== null ? row.project : "",
    projectId: row !== null ? row.project_id : "",
    created: row !== null ? row.created : mtime(d),
    // 有 oir.json 就是跑完过的 —— 目录里的事实比一个丢掉的状态字段可信
    status:
      row !== null ? row.status : existsSync(join(d, "oir.json")) ? "done" : "idle",
    stateVersion: row !== null ? row.state_version : 0,
    owner: row !== null ? row.owner : "",
  });
  try {
    await hydrateInto(s, deps, { row, directory: d });
  } catch (exc) {
    // 恢复失败/取消后不能留下一份可被后续请求命中的半成品。
    if (SESSIONS.get(sid) === s) SESSIONS.delete(sid);
    throw exc;
  }
  // 只有全部 repo/文件/领域状态恢复成功后才发布缓存。若提前发布，晚到请求会在
  // `sessAsync` 的 fast path 命中半成品，完全绕过上面的 single-flight 锁。
  SESSIONS.set(sid, s);
  return s;
}

/** 填充已占位的 Session；只由 {@link hydrateOnce} 在恢复锁内调用。 */
export async function hydrateInto(
  s: Session,
  deps: GlueDeps,
  opts: { row: SessionRow | null; directory: string },
): Promise<void> {
  const sid = s.id;
  const d = opts.directory;
  const row = opts.row;
  // A persisted session may legitimately have no artifacts or materials yet (for
  // example, a chat-only session reopened after its first turn).  Hydration must
  // not assume the workspace directory was already created by an upload/build.
  mkdirSync(d, { recursive: true });

  const mats = join(d, "materials");
  if (existsSync(mats)) {
    const files: SessionFile[] = [];
    for (const name of [...readdirSync(mats)].sort(cmpCodePoint)) {
      const p = join(mats, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      files.push({ name, size: st.size, path: p, sha256: sha256Hex(readFileSync(p)) });
    }
    s.files = files;
  }
  if (row !== null) {
    s.owner = row.owner || ""; // 用量流水按账号记，后台管线读不到请求
    Object.assign(s.state, await deps.repo().loadState(sid));
    await deps.restoreDialogue(s);
    // 进程内 SSE 不是历史。session_event 才是断线/重启后的 cursor；恢复后
    // "上一轮生成的下载卡/审核结果/问题表"仍在原来的时间线上，而不是只剩
    // 一个笼统的 session.restored。
    const durableEvents = await deps.repo().readEvents(sid, { since: 0 });
    if (durableEvents.length > 0) {
      s.events = durableEvents.map((event) => eventRowAsSse(event));
    }
    const qrows = await deps.repo().listQuestions(sid);
    if (qrows.length > 0) {
      s.state["question_backlog"] = QuestionBacklog.fromDict(qrows.map((r) => r.doc)).toDict();
    }
    // 多 worker 下不能因本 worker 没有 Task 就宣布运行死亡。只有 lease 已过期
    // （或迁移前根本没有 lease）的运行才可回收；健康 worker 的 heartbeat 必须保留。
    if (["queued", "parsing", "extracting"].includes(s.status)) {
      const error = "上次运行被中断（租约已过期）。材料和已拍板的决定都在，可以重新开始。";
      const reaped = await deps.repo().reapExpiredBuildLease(sid, { now: deps.now(), error });
      if (reaped) {
        s.status = "failed";
        s.error = error;
      }
    }
  }

  const oirJson = join(d, "oir.json");
  if (existsSync(oirJson)) {
    try {
      const data = JSON.parse(readFileSync(oirJson, "utf-8")) as Record<string, unknown>;
      s.state["_oir"] = oirFromDict(data);
      if (!("oir" in s.state)) s.state["oir"] = data;
    } catch (exc) {
      // 读不回来要说，不能假装会话是好的
      s.emit("hydrate.partial", { error: `oir.json 读不回来：${excMessage(exc)}` });
    }
  }
  const flowJson = join(d, "flow.json");
  if (existsSync(flowJson)) {
    // 流程图是产品的主产出 —— 恢复会话时不读回来，界面上那个 tab 就是空的，
    // 而 SVG 明明躺在同一个目录里。
    try {
      const data = JSON.parse(readFileSync(flowJson, "utf-8")) as Record<string, unknown>;
      s.state["flow"] = data;
      // _flow 是活对象，「改流程图」要用它 —— 只恢复 dict 快照不够
      s.state["_flow"] = flowFromDict(data);
    } catch (exc) {
      s.emit("hydrate.partial", { error: `flow.json 读不回来：${excMessage(exc)}` });
    }
  }

  if (s.files.length > 0) await deps.preparse(s); // 证据索引重建，零模型调用
  if (s.state["_oir"] !== null && s.state["_oir"] !== undefined && !truthy(s.state["question_backlog"])) {
    await syncQuestionBacklog(s, deps);
  }
  s.state["artifacts"] = dirFiles(d);
  // 迁移前的会话可能只有 state._cards、没有 session_event；仅对此兼容。新会话
  // hydrate 已直接载入 durable seq，绝不重编号或重复灌卡片。
  const durableLoaded = row !== null && s.events.length > 0;
  if (!durableLoaded) {
    for (const c of (s.state["_cards"] as Record<string, unknown>[] | undefined) ?? []) {
      s.events.push({ ...c, seq: s.events.length } as never);
    }
  }
  // single-flight 保证并发冷启动只走一次这里。恢复完成本身是 API 返回语义的一部分，
  // 不能仅把事件排进后台队列就发布 Session：否则进程恰在返回后退出时，用户已经看见
  // "恢复成功"，审计里却没有对应记录。等待这条 FIFO 尾事件的 durable seq 也会顺带
  // 保证恢复期间较早发出的 partial/corpus 事件全部落库。
  await s.emitDurable("session.restored", {
    files: s.files.length,
    stats: ((s.state["oir"] as Record<string, unknown> | undefined) ?? {})["stats"] as never,
  });
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/** `d.stat().st_mtime` —— **秒**，且是浮点。 */
function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs / 1000;
  } catch {
    // 到这里目录一定存在（上面判过），拿不到就退回 0 而不是当前时间：
    // 一个假的"刚创建"会让会话列表按时间排序时插到最前面。
    return 0;
  }
}

function dirFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    try {
      if (statSync(join(dir, name)).isFile()) out.push(name);
    } catch {
      // 列目录与 stat 之间文件可能已被删。
    }
  }
  return out;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return x.length - y.length;
}
