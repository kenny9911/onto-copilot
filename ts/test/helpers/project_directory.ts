/**
 * 知识库 HTTP 测试用的项目目录桩。
 *
 * 路由层的作用域解析要读项目行才能拿到 `scope.owner`（知识库是项目资产，
 * owner 取项目的而不是当前登录者 —— 见 `server/routes/document_scope.ts`）。
 * 这些测试都用桩会话、不起仓储，`getRepo()` 在那种环境下是**抛**而不是回落，
 * 所以生产实现不能直接被复用。
 */

import type { ProjectDirectory, ProjectRecord } from "../../src/server/routes/document_scope.js";

export interface StubProjectDirectory extends ProjectDirectory {
  /** 被自动归入项目的会话，供断言「没有项目的会话不再 409」这条行为。 */
  readonly assigned: Map<string, string>;
  readonly projects: Map<string, ProjectRecord>;
}

/**
 * @param seed 预置项目；测试里最常见的是 `{ "project-1": "u1" }`（项目 → owner）。
 */
export function stubProjectDirectory(
  seed: Readonly<Record<string, string>> = { "project-1": "u1" },
): StubProjectDirectory {
  const projects = new Map<string, ProjectRecord>();
  for (const [id, owner] of Object.entries(seed)) {
    projects.set(id, { id, name: `项目 ${id}`, owner });
  }
  const assigned = new Map<string, string>();
  let seq = 0;
  return {
    projects,
    assigned,
    async get(projectId) {
      return projects.get(projectId) ?? null;
    },
    async ensureDefault(owner) {
      for (const p of projects.values()) {
        if (p.owner === owner && p.name === "我的材料") return { project: p, created: false };
      }
      seq += 1;
      const project: ProjectRecord = { id: `auto-${seq}`, name: "我的材料", owner };
      projects.set(project.id, project);
      return { project, created: true };
    },
    async assign(sessionId, projectId) {
      assigned.set(sessionId, projectId);
    },
  };
}
