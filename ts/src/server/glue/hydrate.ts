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
import { FlowGraph, flowFromDict } from "../../onto/flow.js";
import { oirFromDict } from "../../onto/oir.js";
import { QuestionBacklog } from "../../onto/questions.js";
import { eventRowAsSse } from "../../store/types.js";
import type { SessionRow } from "../../store/types.js";
import { SESSIONS, Session, root, withHydrateLock } from "../session.js";
import type { SessionFile } from "../session.js";
import type { GlueDeps } from "./deps.js";
import { syncQuestionBacklog } from "./questions.js";
import { loadOrMigrateAssetMemory, syncAssetMemory } from "../asset_memory.js";
import { getDocumentServiceOptional } from "../../document/deps.js";
import { reconcileDocumentEvidence } from "./preparse.js";

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
    // 冲突也要恢复。它不在 PERSISTED 白名单里（那份注释说私有键"要么是活对象、
    // 要么是能重算的"），但**没有人重算它**，而三个读侧都直接读 `s.state`：
    //   · routes/questions.ts 读不到 `_conflicts` → 冲突来源的问题一律 409
    //     「尚未恢复」，而那句文案预设了一条用户看不见的恢复动作；
    //   · dialogue/tools.ts 拿 `Array.isArray(state.conflicts)` 当"跑没跑过"的判据
    //     → 对一个检出过 463 条冲突的会话回「还没跑过冲突检测」；
    //   · routes/context.ts 的评审面板显示 0 条。
    // 真实库里 conflict 表有 1137 行分布在 4 个会话，而 session_state 里
    // **压根没有 conflicts 这个键** —— 表是只写不读的。
    // listConflicts 在这之前全仓零生产调用点，这里给它第一个。
    // 参考图活对象从快照重建（快照经 PERSISTED 已在 loadState 里回来了）
    const sk = s.state["sketch"] as Record<string, unknown> | undefined;
    if (sk && typeof sk === "object" && sk["graph"] && !(s.state["_sketch"] instanceof FlowGraph)) {
      try {
        s.state["_sketch"] = flowFromDict(sk["graph"] as Record<string, unknown>);
      } catch (exc) {
        s.emit("hydrate.partial", { error: `sketch 快照读不回来：${excMessage(exc)}` });
      }
    }
    const crows = await deps.repo().listConflicts(sid);
    if (crows.length > 0) {
      // 两个键都要：`conflicts` 是给面板/工具读的投影，`_conflicts` 是
      // routes/questions.ts 按 rid 找的那份。`Conflict` 是纯 interface
      // （不是 class，见 onto/conflict.ts:244），而 doc 列存的就是它的字面形态，
      // 所以这里不需要反序列化器 —— 直接就是它。
      s.state["conflicts"] = crows;
      s.state["_conflicts"] = crows;
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
  } else if (
    s.state["oir"] !== null &&
    s.state["oir"] !== undefined &&
    typeof s.state["oir"] === "object" &&
    !Array.isArray(s.state["oir"])
  ) {
    // 挂起在 INTERVIEW 的会话还没写过 oir.json 产物 —— 权威 OIR 只在 state
    // 文档里。只恢复 dict 快照、不恢复活对象的话，重启后的 worker 上一切
    // 回写全部失灵：applyDecision 崩「Cannot read properties of undefined
    // (reading 'properties')」，transition 的 recompile 因 `_oir` 缺席**静默
    // 跳过** —— 3784 次问题处置没有一次触发过重算（真实案发）。
    try {
      s.state["_oir"] = oirFromDict(s.state["oir"] as Record<string, unknown>);
    } catch (exc) {
      s.emit("hydrate.partial", { error: `state.oir 建不回活对象：${excMessage(exc)}` });
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

  // 项目知识库挂载不属于 Session.files。重启后即使没有临时附件，也要刷新并加载
  // 精确版本，否则“只用项目知识库”的会话会看起来像没有材料，严格证据门也会失效。
  const documentStore = getDocumentServiceOptional();
  let hasAttachedDocuments = false;
  if (documentStore !== null && s.projectId) {
    try {
      const manifest = await documentStore.manifest({
        sessionId: s.id,
        projectId: s.projectId,
        owner: s.owner,
      });
      s.state["_document_manifest"] = manifest;
      delete s.state["_document_manifest_error"];
      reconcileDocumentEvidence(s, manifest);
      hasAttachedDocuments = manifest.length > 0;
    } catch (exc) {
      s.state["_document_manifest"] = [];
      s.state["_document_manifest_error"] = excMessage(exc);
      reconcileDocumentEvidence(s, [], { forceRebuild: true });
      s.emit("document.manifest_failed", { error: excMessage(exc) });
    }
  } else if (s.projectId) {
    s.state["_document_manifest"] = [];
    s.state["_document_manifest_error"] = "项目知识库服务尚未就绪，未使用任何历史项目切片。";
    reconcileDocumentEvidence(s, [], { forceRebuild: true });
  } else {
    s.state["_document_manifest"] = [];
    delete s.state["_document_manifest_error"];
    reconcileDocumentEvidence(s, [], { forceRebuild: true });
  }
  if (s.files.length > 0 || hasAttachedDocuments) await deps.preparse(s); // 证据索引重建，零模型调用
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
  // 旧会话升级：从文件、问题台账和 durable 内容事件重建统一资产目录，并为仍在
  // 使用固定文件名的历史产物补不可变快照。索引失败要显式可见，但不能让一份本来
  // 可打开的旧会话因为辅助记忆迁移而整体 500。
  const rawAssetMemory = s.state["asset_memory"];
  const needsAssetMigration =
    rawAssetMemory === null ||
    typeof rawAssetMemory !== "object" ||
    Array.isArray(rawAssetMemory) ||
    (rawAssetMemory as Record<string, unknown>)["$schema"] !== "ontocopilot.asset-memory/1" ||
    (rawAssetMemory as Record<string, unknown>)["sessionId"] !== sid ||
    !Array.isArray((rawAssetMemory as Record<string, unknown>)["assets"]);
  try {
    syncAssetMemory(s);
    if (needsAssetMigration && row !== null) {
      const migrated = await loadOrMigrateAssetMemory(
        deps.repo(),
        sid,
        { owner: s.owner, projectId: s.projectId },
        { directory: d },
      );
      if (migrated.memory !== null) s.state["asset_memory"] = migrated.memory.toDict();
      // 只有迁移读到的 base 就是当前 hydrate 投影时，才可推进本地 CAS 游标。
      // 若中途有另一个 worker 写过，保留旧游标，下一次结构性操作会按既有刷新路径
      // 重载全量 state；绝不能只推进版本号、却把其它内存文档留在旧版本。
      if (
        migrated.status === "persisted" &&
        migrated.basedOnVersion === s.stateVersion &&
        migrated.stateVersion !== null
      ) {
        s.stateVersion = migrated.stateVersion;
      }
      if (migrated.status === "conflict") {
        s.emit("hydrate.partial", { error: "资产记忆迁移遇到并发更新，已保留对方状态，稍后会重试。" });
      }
    }
  } catch (exc) {
    s.emit("hydrate.partial", { error: `资产记忆重建失败：${excMessage(exc)}` });
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
