/**
 * 项目文件夹与**项目记忆** —— 移植自 `server.py` 的 1159–1396 行。
 *
 * 项目记忆是产品的一条硬特性，语义错了特性就废了：同一项目内的会话共享记忆，
 * 但别的会话留下的记忆**只能以 REFERENCE 进来**，绝不能变成新会话的
 * AUTHORITATIVE。防的是记忆污染 —— 一条模型自己猜出来的口径，在第二个会话里
 * 变成"人已拍板"，然后带着 1.0 的置信度进交付给客户的包。
 */

import type { Hono } from "hono";

import type { Decision } from "../../kernel/memory/dialogue.js";
import { PROMOTABLE, userSaid } from "../../kernel/memory/dialogue.js";
import { ProjectMemory } from "../../kernel/memory/project.js";
import { MemoryTier } from "../../kernel/memory/types.js";
import { KeyError } from "../../onto/questions.js";
import type { ProjectMemoryRow, ProjectRow } from "../../store/types.js";
import { makeProjectMemoryRow, makeProjectRow } from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { isolate, ownerId } from "../app.js";
import { SESSIONS, currentRepo } from "../session.js";
import type { Session } from "../session.js";
import { apiError, cpSlice, errTypeAndText, jsonBody, shortId } from "./sessions.js";
import type { ServerEnv } from "./sessions.js";

// ══════════════════════════════════════════════════════════════════
//  项目文件夹
// ══════════════════════════════════════════════════════════════════
//  归属校验在 authgate 的中间件里（`/api/projects/<pid>`），和会话同一道门。
//  这里的列表/创建路由没有 pid，所以归属由 owner 过滤与写入自己保证。

export function projectView(p: ProjectRow): Record<string, unknown> {
  return { id: p.id, name: p.name, sort_order: p.sort_order };
}

/** MemoryRepo 抛 `KeyError`、PgRepo 抛 unique 违例。只接一种的话，换个后端同样
 * 的冲突就变成 500 —— Python 侧那行 `except (KeyError, IntegrityError)` 记的
 * 正是这件事。 */
function isDuplicateProject(exc: unknown): boolean {
  if (exc instanceof KeyError) return true;
  // node-postgres 把 SQLSTATE 原样放在 `code` 上；23505 = unique_violation
  const code = (exc as { code?: unknown } | null)?.code;
  return code === "23505";
}

export function registerProjectRoutes(app: Hono<AppEnv>): void {
  app.get("/api/projects", async (c) => {
    const iso = isolate(c);
    const owner = iso ? ownerId(c) : null;
    const projects = await currentRepo().listProjects({ owner });
    // 会话数在这里自己聚合 —— 仓储没有"按项目计数"的方法。用的是**和会话列表
    // 完全相同**的一次 listSessions（同样的 owner 规则、同样的条数上限），
    // 否则项目上写着 3 个、展开只看得到 1 个。
    const counts = new Map<string, number>();
    for (const r of await currentRepo().listSessions({ owner })) {
      if (r.project_id) counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1);
    }
    return c.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        sort_order: p.sort_order,
        sessions: counts.get(p.id) ?? 0,
      })),
    });
  });

  app.post("/api/projects", async (c) => {
    const body = await jsonBody(c);
    const name = String(body["name"] ?? "").trim();
    if (!name) throw apiError(400, "项目名不能为空");
    const row = makeProjectRow({
      id: shortId(),
      name,
      owner: ownerId(c),
      // prefs 列 NOT NULL 且**故意没有默认值**（跨方言的默认值不一致），
      // 所以每次创建都显式写一个空 dict。
      prefs: {},
    });
    try {
      await currentRepo().createProject(row);
    } catch (exc) {
      if (isDuplicateProject(exc)) throw apiError(409, "项目已存在，请重试");
      throw exc;
    }
    return c.json(projectView(row));
  });

  app.patch("/api/projects/:pid", async (c) => {
    const pid = c.req.param("pid");
    const body = await jsonBody(c);
    if ("sort_order" in body) {
      // 仓储只有 renameProject，没有写 sort_order 的方法。同样宁可当场说不支持。
      throw apiError(400, "调整排序还没接上：仓储没有写 sort_order 的方法");
    }
    const name = String(body["name"] ?? "").trim();
    if (!name) throw apiError(400, "项目名不能为空");
    if (!(await currentRepo().renameProject(pid, name))) {
      throw apiError(404, `没有项目 ${pid}`);
    }
    const p = await currentRepo().getProject(pid);
    return c.json(p !== null ? projectView(p) : { id: pid, name, sort_order: 0 });
  });

  /** 删项目：成员会话掉回未归类（**不删会话**），项目记忆一起删掉。 */
  app.delete("/api/projects/:pid", async (c) => {
    const pid = c.req.param("pid");
    if ((await currentRepo().getProject(pid)) === null) {
      throw apiError(404, `没有项目 ${pid}`);
    }
    const released = await currentRepo().deleteProject(pid);
    // 内存里活着的会话也要跟着松开。不然它的 brief() 还挂着一个已经不存在的项目
    // id，侧栏会把它归到一个刚被删掉的分组里，直到进程重启才消失。
    for (const live of SESSIONS.values()) {
      if (live.projectId === pid) live.projectId = "";
    }
    return c.json({ ok: true, released });
  });
}

// ══════════════════════════════════════════════════════════════════
//  项目记忆
// ══════════════════════════════════════════════════════════════════

/**
 * 装载一个项目的记忆。
 *
 * **一个项目一个实例**：`Scope` 在检索里根本不参与过滤，`memKey` 也不含
 * 项目 —— 共用一个 store 的话，两个项目里同名主题会直接撞进合并/覆盖逻辑。
 * 边界只能是这个对象本身，所以每次用都现装一份。
 */
export async function projectMemory(pid: string): Promise<ProjectMemory> {
  const rows = await currentRepo().listProjectMemory(pid);
  return ProjectMemory.fromRows(pid, rows);
}

/**
 * 只回写这次真正动过的那几条。
 *
 * `toRows()` 是整库快照。整库写回会把**另一个会话**刚写进去的同 key 版本，
 * 按我们手里这份（可能已经过期的）覆盖掉。代价是召回带来的 use_count/hit_runs
 * 不落库 —— 那只是排序统计，丢了影响排序；覆盖掉别人写的内容则是丢数据。
 */
export async function saveProjectMemory(
  pm: ProjectMemory,
  keys: ReadonlySet<string>,
): Promise<number> {
  const rows: ProjectMemoryRow[] = pm
    .toRows()
    .filter((r) => keys.has(r.key))
    .map((r) => makeProjectMemoryRow(r));
  if (rows.length === 0) return 0;
  return await currentRepo().upsertProjectMemory(rows);
}

/**
 * 人拍板 → 项目权威档。跨会话直接生效的只有这一档。
 *
 * `decision.record` 只改内存 DialogueMemory，落库靠这一轮 chat 收尾时的
 * `persist`，而那条路只写**本会话**。项目记忆不在它的白名单里，所以这里
 * 显式落一次，否则"同一项目下的会话共享约定"从第二个会话看就是假的。
 *
 * 只收 `PROMOTABLE`（口径/命名/范围）。纠正、采纳、回答某个问题都是就事
 * 论事的，绑在这份材料的具体条目上；固化成项目约束会让同项目的下一个会话继承
 * 一堆和它无关的结论。
 *
 * **必须拿得出用户原话才升项目档。** 跨项目生效的约定之所以权威，唯一的理由是
 * 人说过；拿不出他说的是哪句，这条就只能留在本会话里。拿不出原话不是错误 ——
 * 决定照样记进 DialogueMemory、照样进本会话后续节点的上下文，只是不跨会话。
 *
 * 这道 quote 校验是红队确认过的那条绕过的堵点：参考档记忆被渲染进 L3 之后，
 * 模型逐字读到、再调 `decision.record` 把它当成人拍的板写回来 —— 一条推断于是
 * 变成同项目所有后续会话的 AUTHORITATIVE。校验的实现在
 * `kernel/memory/dialogue.ts` 的 `userSaid`（**只有那一份**，抄第二份就会分叉）。
 *
 * 写失败**不抛**：板已经拍在本会话里了，跨会话共享失败是降级，不是这轮对话失败。
 */
export async function rememberDecision(
  env: ServerEnv,
  s: Session,
  d: Decision,
  opts: { readonly quote?: string } = {},
): Promise<void> {
  if (!s.projectId || !PROMOTABLE.has(d.kind)) return;
  const said = userSaid(env.dialogue(s), opts.quote ?? "");
  if (!said) {
    s.emit("memory.not_shared", {
      scope: "project",
      statement: cpSlice(d.statement, 80),
      why: "拿不出用户原话，只在本会话生效",
    });
    return;
  }
  const runId = String(s.state["engagement_run_id"] ?? "");
  const item = d.toMemory(runId);
  // 出处换成**用户真的说过的那句话**。原来那条 `dialogue:{run}:turn{idx}` 指向的是
  // "碰巧是最后一轮"，审计时看着像人证、其实指不到任何东西（见 userSaid）。
  item.support = [`用户原话：${cpSlice(said.trim(), 120)}`, ...item.support];
  // originSession 记的是**会话的名字**而不是 id：参考档进 prompt 时这个字段
  // 会被逐行印出来（"参考·来自会话《…》"），印一串 12 位十六进制没人看得懂。
  item.originSession = s.title || s.id;
  item.originFiles = s.files.map((f) => f.name);
  try {
    const pm = await projectMemory(s.projectId);
    const [ok] = pm.rememberDecision(item, { runId });
    if (ok) await saveProjectMemory(pm, new Set([item.key]));
  } catch (exc) {
    // 记忆写不进去不该让工具调用失败
    s.emit("memory.failed", { scope: "project", op: "decision", error: errTypeAndText(exc) });
  }
}

/** 一轮最多往项目记忆里塞多少条参考档。critic 一轮能报几十条 findings，
 * 全塞进去会让下一个会话的召回被本轮的噪声占满。 */
export const LESSON_CAP = 8;

/**
 * run 收尾 → 项目参考档。
 *
 * 收的是本轮**被 critic 逼出来的**教训：那是模型自己的推断，不是人拍的板。所以
 * 进参考档 —— 带来源标注、置信度打折、永不晋升、绝不进产物 provenance。
 *
 * run 有三个出口（正常收尾 / 免费预览档 / HITL 挂起），三个都要调；漏一个的表现
 * 是"这个项目的记忆只有跑完整档才长"，而这种漏很难从界面上看出来。
 *
 * 和 `rememberDecision` 一样，写失败不抛：这里已经在收尾路径上，
 * 再往上抛只会把一次成功的梳理变成失败。
 */
export async function rememberRunLessons(
  env: ServerEnv,
  s: Session,
  lessons: readonly string[],
  opts: { readonly runId: string; readonly pm?: ProjectMemory | null },
): Promise<void> {
  if (!s.projectId || lessons.length === 0) return;
  const files = s.files.map((f) => f.name);
  try {
    const pm = opts.pm ?? (await projectMemory(s.projectId));
    const keys = new Set<string>();
    for (const text of lessons.slice(0, LESSON_CAP)) {
      const item = pm.observe(text, {
        runId: opts.runId,
        sessionId: s.title || s.id,
        files,
        support: [`run:${opts.runId}`],
      });
      keys.add(item.key);
    }
    await saveProjectMemory(pm, keys);
  } catch (exc) {
    // 收尾路径不能被记忆写入拖垮
    s.emit("memory.failed", { scope: "project", op: "lesson", error: errTypeAndText(exc) });
  }
}

/**
 * R2 的执行点：参考档记忆绝不许出现在交付物的 decisions 里。
 *
 * 正路上参考档根本进不了 `DialogueMemory`（只有 `decision.record` 能往里写，
 * 而它写的是人拍的板）。这道过滤是为了**将来**：`dm.decisions` 会全量、不过滤
 * 地进 `OntologyPackage.decisions`，哪天有人图省事把一条推断塞进对话记忆，
 * 它就会以"已拍板"的身份印在交付给客户的包里，而且没有任何东西会报错。
 */
export function dropReferenceMemory(
  entries: readonly unknown[],
): unknown[] {
  const kept: unknown[] = [];
  for (const e of entries) {
    // 两个来源到这儿都是 dict；万一将来有人传别的形状，判不了就放行 ——
    // 这道过滤是**额外**的一层保险，不该自己变成一个能挂掉发布闸门的东西。
    const d: Record<string, unknown> =
      typeof e === "object" && e !== null && !Array.isArray(e)
        ? (e as Record<string, unknown>)
        : {};
    const tags = d["tags"];
    const tagList = Array.isArray(tags) ? (tags as unknown[]) : [];
    if (String(d["tier"] ?? "") === String(MemoryTier.REFERENCE) || tagList.includes("observed")) {
      continue;
    }
    kept.push(e);
  }
  return kept;
}
