/**
 * 项目知识库的作用域语义 —— 这三条钉的是「知识库属于项目」这件事本身。
 *
 * 之前的实现把 `scope.owner` 取成当前登录者，于是：
 *   1. 同一个项目下不同的人各自看到一个空库（挂着项目牌子的私人文件夹）；
 *   2. `principalOf(scope)` 用的就是 `scope.owner`，和 ACL 的 `boundary.owner`
 *      永远相等，`acl.ts:445` 的 `project_owner` 捷径恒真，整套规则形同虚设；
 *   3. 会话没归项目就 409 —— 而真实库里 33/42 个会话 `project_id` 为空。
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppEnv, RequestUser } from "../src/server/app.js";
import type { DocumentRouteSession, DocumentServicePort } from "../src/server/routes/documents.js";
import { stubProjectDirectory, type StubProjectDirectory } from "./helpers/project_directory.js";

const ROOT = join(tmpdir(), `ontocopilot-document-scope-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;
mkdirSync(ROOT, { recursive: true });

const { refreshRoot } = await import("../src/server/session.js");
const { registerDocumentRoutes } = await import("../src/server/routes/documents.js");

type Dict = Record<string, unknown>;

/** 只记录被传进来的 scope；这些用例断言的就是那个 scope 本身。 */
function recordingService(): DocumentServicePort & { readonly scopes: Dict[] } {
  const scopes: Dict[] = [];
  const service = {
    scopes,
    async list(scope: Dict) {
      scopes.push(scope);
      return [];
    },
    async listAttachments(scope: Dict) {
      scopes.push(scope);
      return [];
    },
  };
  return service as unknown as DocumentServicePort & { readonly scopes: Dict[] };
}

let app: Hono<AppEnv>;
let actor: RequestUser | null;
let documents: ReturnType<typeof recordingService>;
let projects: StubProjectDirectory;
let sessions: Map<string, DocumentRouteSession>;

function build(): void {
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", actor);
    await next();
  });
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    return Response.json({ detail: String(error) }, { status: 500 });
  });
  registerDocumentRoutes(app, {
    documents,
    projects,
    sessionById: async (sid) => {
      const session = sessions.get(sid);
      if (session === undefined) throw new HTTPException(404, { message: `没有会话 ${sid}` });
      return session;
    },
  });
}

beforeEach(() => {
  refreshRoot();
  actor = { id: "u1", role: "user" };
  documents = recordingService();
  sessions = new Map([
    ["filed", { id: "filed", projectId: "project-1", owner: "u1", files: [] }],
    ["orphan", { id: "orphan", projectId: "", owner: "u1", files: [] }],
  ]);
});

describe("知识库的存储边界是项目，不是人", () => {
  it("scope.owner 取项目 owner；发起调用的人只出现在 actorId 上", async () => {
    // 项目属于 team-lead，来访的是同项目里的 u1。
    projects = stubProjectDirectory({ "project-1": "team-lead" });
    build();

    const response = await app.request("/api/sessions/filed/documents");
    expect(response.status).toBe(200);

    // 存储边界跟着项目走 —— 否则 u1 会看到一个空库，而 team-lead 存的文档一份都不在。
    expect(documents.scopes[0]).toMatchObject({ projectId: "project-1", owner: "team-lead" });
    // 鉴权主体仍是真人。两者合一时 principalOf(scope).id === boundary.owner 恒成立，
    // ACL 的 project_owner 捷径永远命中，规则永远轮不到执行。
    expect(documents.scopes[0]).toMatchObject({ actorId: "u1" });
  });

  it("项目行读不到时回落到会话 owner，而不是回落到发起请求的人", async () => {
    // 会话记着一个已经不存在的项目（项目被别处删掉）。
    projects = stubProjectDirectory({});
    build();

    const response = await app.request("/api/sessions/filed/documents");
    expect(response.status).toBe(200);
    // 会话 owner 是会话的属性，同一个会话每次解析都一样；退成 actor 会让两个人
    // 打同一个无主项目时各自拿到一个空库 —— 正是这次要修的病。
    expect(documents.scopes[0]).toMatchObject({ owner: "u1", actorId: "u1" });
  });
});

describe("没有项目的会话不再 409", () => {
  beforeEach(() => {
    projects = stubProjectDirectory({});
    build();
  });

  it("惰性建默认项目、把会话归进去，并把这件事报给前端", async () => {
    const response = await app.request("/api/sessions/orphan/documents");
    expect(response.status).toBe(200);

    expect(projects.assigned.get("orphan")).toBe("auto-1");
    expect(projects.projects.get("auto-1")).toMatchObject({ name: "我的材料", owner: "u1" });
    expect(documents.scopes[0]).toMatchObject({ projectId: "auto-1", owner: "u1" });

    // 系统可以有默认行为，不可以有**不可见**的归属决定。
    const payload = (await response.json()) as Dict;
    expect(payload["project"]).toEqual({ name: "我的材料", auto_created: true });
  });

  it("同一个 owner 的第二个孤儿会话复用同一个默认项目，不再报「刚建了」", async () => {
    await app.request("/api/sessions/orphan/documents");
    sessions.set("orphan2", { id: "orphan2", projectId: "", owner: "u1", files: [] });

    const response = await app.request("/api/sessions/orphan2/documents");
    expect(response.status).toBe(200);
    expect(projects.assigned.get("orphan2")).toBe("auto-1");
    expect(projects.projects.size).toBe(1);

    const payload = (await response.json()) as Dict;
    expect(payload["project"]).toEqual({ name: "我的材料", auto_created: false });
  });
});

// 临时 workspace 交给操作系统的 tmp 清理；这里只保证不同 pid 之间互不干扰。
rmSync(join(ROOT, ".keep"), { force: true });
