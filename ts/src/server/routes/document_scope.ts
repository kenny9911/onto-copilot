/**
 * 项目知识库的作用域解析 —— `documents` / `document-knowledge` / `document-connectors`
 * 三组路由共用同一道门。
 *
 * 这里收口的是两条**语义**纪律，不是三段重复代码的去重：
 *
 * 1. **`scope.owner` 是「项目的 owner」，不是「当前登录的人」。**
 *    知识库是项目资产：同一个项目下的人看到的必须是同一个库。取当前登录者会让
 *    「项目知识库」变成一个挂着项目牌子的私人文件夹 —— 而且 ACL 会退化成同义反复，
 *    因为主体本身就是分区键，给别人开的 allow 规则永远不可能命中。
 *
 *    附带修掉一条数据丢失路径：`authgate.adoptLocalSessions` 在建第一个账号时
 *    把 session 和 project 从 `__local__` 改姓，但**不碰 document**。owner 跟着
 *    项目走之后，`reassignProjects` 一句就把库一起带过去了。
 *
 * 2. **没有项目的会话不再 409。**
 *    真实库里 33/42 个会话 `project_id` 为空。直接 409 等于知识库对大多数会话
 *    根本不存在 —— 这会让「修好构建」看起来像「没修好」。这里惰性建一个属于该
 *    owner 的默认项目并把会话归进去。
 *
 *    但默认值不等于可以不告诉人：`projectAutoCreated` 会一路报到 HTTP 响应里，
 *    由页面显示一条可关闭的提示。系统可以有默认行为，不可以有**不可见**的归属决定。
 *
 * 项目目录被抽成 `ProjectDirectory` 而不是直接调 `currentRepo()`：三组路由的
 * HTTP 测试都用桩会话、不起仓储，`getRepo()` 在那种环境下是**抛**而不是回落。
 */

import type { Context } from "hono";

import { sha256Hex } from "../../kernel/ids.js";
import type { DocumentScope } from "../../document/types.js";
import { globalLibraryScope } from "../../document/types.js";
import { makeProjectRow } from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { SYNTHETIC_ADMIN_ID, isolate, ownerId } from "../app.js";
import { SESSIONS, currentRepo } from "../session.js";
import { apiError } from "./sessions.js";

/**
 * 自动建出来的默认项目名。
 *
 * **不能**叫「未归类」：侧栏里那个「未归类」是 `project_id` 为空的会话的虚拟分组，
 * 用的是一个真项目 id 长不成的哨兵键（`ui/state.ts:157`）。真建一个同名项目，
 * 侧栏会同时出现一个虚拟组和一个真文件夹，两个都叫「未归类」。
 */
export const DEFAULT_PROJECT_NAME = "我的材料";

/** 默认项目在 prefs 上的标记。用它而不是名字来找 —— 用户可以把它改名。 */
const DEFAULT_PROJECT_FLAG = "oc_default";

/**
 * 默认项目的 id 由 owner 推导，因此并发建只会撞主键、不会建出两个。
 *
 * 刻意保持 12 位十六进制，和 `shortId()`（sessions.ts 里 randomUUID 去横杠取 12 位）
 * 同形，侧栏那些拿 id 当 key 的地方看不出区别。
 */
export function defaultProjectId(owner: string): string {
  return sha256Hex(`oc:default:${owner}`).slice(0, 12);
}

/** 解析作用域时只需要会话的这三个字段；具体类型由各路由自己的会话形状决定。 */
export interface ProjectScopeSession {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
}

/** 项目目录端口。生产走仓储；HTTP 测试注入桩。 */
export interface ProjectDirectory {
  get(projectId: string): Promise<ProjectRecord | null>;
  ensureDefault(owner: string): Promise<{ project: ProjectRecord; created: boolean }>;
  assign(sessionId: string, projectId: string): Promise<void>;
}

/** 生产用的项目目录：直接落在会话仓储上。 */
export function repoProjectDirectory(): ProjectDirectory {
  return {
    async get(projectId) {
      const row = await currentRepo().getProject(projectId);
      return row === null ? null : { id: row.id, name: row.name, owner: row.owner };
    },
    /**
     * 并发不靠新约束、不靠租约，靠**确定性 id + 建失败后重读**。
     *
     * project 表上没有 (owner, name) 唯一约束，`createProject` 只在 **id** 冲突时抛
     * —— 随机 id 下「先查后建」必然能建出两个「我的材料」。用 `defaultProjectId(owner)`
     * 之后并发两路算出的是同一个主键，冲突由主键兜住。
     *
     * 冲突后**不去认错误形状**：`projects.ts` 的 `isDuplicateProject` 只认 Postgres 的
     * `23505`，而真库是 SQLite —— 那边重复主键抛的是 `ERR_SQLITE_ERROR` / errcode 1555，
     * 一个 23505 都没有。重读式重试与方言无关，是唯一稳的写法。
     */
    async ensureDefault(owner) {
      const repo = currentRepo();
      const id = defaultProjectId(owner);
      const mine = await repo.listProjects({ owner });
      // 按 prefs 标记找，不按名字 —— 用户可以把「我的材料」改成别的名字。
      const flagged = mine.find(
        (p) => (p.prefs as Record<string, unknown> | undefined)?.[DEFAULT_PROJECT_FLAG] === true,
      );
      const existing = flagged ?? mine.find((p) => p.id === id);
      if (existing !== undefined) {
        return {
          project: { id: existing.id, name: existing.name, owner: existing.owner },
          created: false,
        };
      }
      const row = makeProjectRow({
        // prefs 列 NOT NULL 且故意没有跨方言默认值 —— 和 projects.ts 的创建路径一致。
        id,
        name: DEFAULT_PROJECT_NAME,
        owner,
        prefs: { [DEFAULT_PROJECT_FLAG]: true },
      });
      try {
        await repo.createProject(row);
      } catch (exc) {
        const again = await repo.getProject(id);
        if (again === null) throw exc;
        return { project: { id: again.id, name: again.name, owner: again.owner }, created: false };
      }
      return { project: { id: row.id, name: row.name, owner: row.owner }, created: true };
    },
    async assign(sessionId, projectId) {
      await currentRepo().assignSession(sessionId, projectId);
      // 活会话也要跟着改，否则它的 brief() 还挂着空 project_id，
      // 侧栏会把它继续留在「未归类」里，直到进程重启。
      const live = SESSIONS.get(sessionId);
      if (live !== undefined) live.projectId = projectId;
    },
  };
}

/**
 * 总知识库的作用域 —— **不需要会话，也不需要项目**。
 *
 * 这是「知识库可以直接去访问」那条要求在服务端的落点：`/api/knowledge/...` 用它，
 * 于是打开总库不再需要先开一个会话、再让那个会话归进某个项目。
 *
 * 总库跨账号共享，所以它是 ACL 第一次真正承担职责的地方：存储边界是部署级常量，
 * 而 `actorId` 是真人 —— `principalOf` 用后者裁决，规则才可能命中。
 */
export function resolveGlobalScope(c: Context<AppEnv>): {
  readonly scope: DocumentScope;
  readonly actorId: string;
} {
  const actorId = ownerId(c);
  // 开放模式下 ownerId 是 `__local__`，不是空 —— 空只可能出现在鉴权中间件没接上时。
  if (!actorId) throw apiError(401, "请先登录，再使用总知识库。");
  return { scope: globalLibraryScope(actorId), actorId };
}

export interface ResolvedProjectScope<S extends ProjectScopeSession> {
  /** 已鉴权的会话原对象（`projectId` 字段可能仍是解析前的空值，以 `scope` 为准）。 */
  readonly source: S;
  /** 传给 document 层的项目边界；`owner` 是**项目的** owner。 */
  readonly scope: DocumentScope;
  /** 当前这次调用背后的真人；写操作的 `created_by` / 审计用它，不用 `scope.owner`。 */
  readonly actorId: string;
  /** 本次调用顺手建了默认项目 —— 调用方必须把它透给前端。 */
  readonly projectAutoCreated: boolean;
  /** 会话所属项目名，用于前端那条提示。 */
  readonly projectName: string;
}

/**
 * 解析一次知识库调用的项目边界。
 *
 * `sid` 由调用方自己校验后传进来 —— 三个路由文件各有一份私有的 `requiredText`，
 * 这里不再造第四份。
 */
export async function resolveProjectScope<S extends ProjectScopeSession>(
  c: Context<AppEnv>,
  sid: string,
  sessionById: (sid: string) => Promise<S>,
  directory: ProjectDirectory,
): Promise<ResolvedProjectScope<S>> {
  const source = await sessionById(sid);
  const authenticated = ownerId(c);
  if (isolate(c) && (!source.owner || source.owner !== authenticated)) {
    // 不存在和无权访问统一 404，不能用会话 ID 探测别人的项目。
    throw apiError(404, `没有会话 ${sid}`);
  }
  const actorId = authenticated || source.owner;

  let projectId = source.projectId;
  let projectName = "";
  let autoCreated = false;

  if (!projectId) {
    if (!actorId) throw apiError(401, "请先登录，再使用项目知识库。");
    const ensured = await directory.ensureDefault(actorId);
    projectId = ensured.project.id;
    projectName = ensured.project.name;
    autoCreated = ensured.created;
    await directory.assign(source.id, projectId);
  }

  const project = await directory.get(projectId);
  if (projectName === "") projectName = project?.name ?? "";
  // 项目行读不到（项目被别处删了、或历史数据没有 owner）时回落到**会话的 owner**，
  // 而不是当前请求的 actor —— 会话 owner 是会话的属性，同一个会话每次解析都一样；
  // 退成 actor 的话，两个人打同一个无主项目会各自拿到一个空库，正是这次要修的病
  // 在兜底路径上重新种一遍。
  //
  // 这条兜底必须和 `dialogue/document_tools.ts` 的 `documentScope()` **逐字一致**：
  // 两条路径对同一个项目算出不同的 owner，就等于把一个项目劈成两个存储分区，
  // HTTP 存进去的文档模型工具一份都看不见。
  const owner = project?.owner || source.owner || SYNTHETIC_ADMIN_ID;

  return {
    source,
    // owner = 存储边界（项目的）；actorId = 鉴权主体（人）。分开的理由见 types.ts。
    scope: { projectId, owner, actorId },
    actorId,
    projectAutoCreated: autoCreated,
    projectName,
  };
}
