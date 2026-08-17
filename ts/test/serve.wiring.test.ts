/**
 * 接线的回归测试 —— 挡的是**只有起进程才看得见**的那一类故障。
 *
 * 单测能证明每个路由文件里的处理器对，证明不了 `wireServer()` 把它们挂上了。
 * 少挂一个 `registerXxx()` 是一次编译干净、别的测试全绿、而线上 404 的事故；
 * 装两遍则是"改了代码不生效"（Hono 的路由表是数组，同一路径只会命中先注册的
 * 那一个）。这两件事都只能在这里断言。
 *
 * 权威清单来自 `grep -n "^@app\." src/ontocopilot/server.py` —— **34 条**。
 * FastAPI 的 `{sid}` 对应 Hono 的 `:sid`，除此之外路径与方法逐字相同。
 */

import { describe, expect, it } from "vitest";

import { app } from "../src/server/app.js";
import { serverEnv, wireServer } from "../src/serve.js";

/** Python 侧 34 条路由（`server.py`），路径已按 Hono 的参数写法转过。 */
const PYTHON_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/usage"],
  ["GET", "/api/health"],
  ["GET", "/api/models"],
  ["POST", "/api/sessions/:sid/model"],
  ["GET", "/api/sessions"],
  ["POST", "/api/sessions"],
  ["DELETE", "/api/sessions/:sid"],
  ["PATCH", "/api/sessions/:sid"],
  ["GET", "/api/projects"],
  ["POST", "/api/projects"],
  ["PATCH", "/api/projects/:pid"],
  ["DELETE", "/api/projects/:pid"],
  ["POST", "/api/sessions/:sid/files"],
  ["DELETE", "/api/sessions/:sid/files/:name"],
  ["POST", "/api/sessions/:sid/to_work"],
  ["GET", "/api/sessions/:sid/state"],
  ["GET", "/api/sessions/:sid/stream"],
  ["POST", "/api/sessions/:sid/build"],
  ["POST", "/api/sessions/:sid/stop"],
  ["GET", "/api/sessions/:sid/questions"],
  ["PATCH", "/api/sessions/:sid/questions/:qid"],
  ["POST", "/api/sessions/:sid/questions/:qid/reopen"],
  ["POST", "/api/sessions/:sid/questions/:qid/answer"],
  ["GET", "/api/sessions/:sid/questions/export"],
  ["GET", "/api/sessions/:sid/revisions"],
  ["POST", "/api/sessions/:sid/answer"],
  ["POST", "/api/sessions/:sid/chat"],
  ["GET", "/api/sessions/:sid/artifacts/:name"],
  ["GET", "/api/sessions/:sid/export"],
  ["GET", "/api/sessions/:sid/exports/:name"],
  ["GET", "/api/sessions/:sid/bundle"],
  ["GET", "/api/sessions/:sid/source"],
  ["POST", "/api/sessions/:sid/audit"],
  ["GET", "/"],
];

/**
 * 还没迁的路由。**已经空了** —— 七条问题清单路由（`server.py` 4075–4513）落地在
 * `server/routes/questions.ts` 之后，这份名单清零，路由表与 Python 逐条对齐。
 *
 * 保留这个常量（而不是删掉断言）：下一次有人往 Python 侧加路由、TS 侧忘了跟，
 * 差集会重新非空，而这里是唯一会因此变红的地方。
 */
const NOT_MIGRATED: ReadonlySet<string> = new Set<string>([]);

/** `app.routes` 里真正的处理器（把 `*` 上的中间件排掉）。 */
function handlerRoutes(): string[] {
  return app.routes
    .filter((r) => r.method !== "ALL" && r.path !== "*")
    .map((r) => `${r.method} ${r.path}`);
}

describe("wireServer", () => {
  it("幂等：装第二遍不会让路由表变长", () => {
    wireServer();
    const first = handlerRoutes();
    wireServer();
    wireServer();
    expect(handlerRoutes()).toEqual(first);
    // 同一条 (method, path) 只能出现一次。重复注册时 Hono 不报错，只是永远命中
    // 第一个 —— 症状是"改了代码不生效"，最难查的那种。
    expect(new Set(first).size).toBe(first.length);
  });

  it("Python 的 34 条路由全部挂上了", () => {
    wireServer();
    const have = new Set(handlerRoutes());
    const missing = PYTHON_ROUTES.map(([m, p]) => `${m} ${p}`).filter((k) => !have.has(k));
    expect([...missing].sort()).toEqual([...NOT_MIGRATED].sort());
  });

  it("没有 Python 侧不存在的多余路由", () => {
    wireServer();
    // authgate / configapi 在 Python 侧用 `APIRouter` 注册，不在 `^@app.` 那份
    // 清单里 —— 但它们**也是**必须逐条对上的路由，所以在这里显式列出来，而不是
    // 用一条 `/api/(auth|users|config)` 的正则放行（那样 TS 侧多长出一条
    // `/api/users/whatever` 也不会有人发现）。
    const ROUTER_ROUTES = [
      "POST /api/login",
      "POST /api/register",
      "POST /api/logout",
      "GET /api/me",
      "GET /api/auth/status",
      "POST /api/me/password",
      "POST /api/me/profile",
      "PATCH /api/me/prefs",
      "GET /api/users",
      "POST /api/users",
      "PATCH /api/users/:uid",
      "POST /api/users/:uid/reset-password",
      "DELETE /api/users/:uid",
      "GET /api/config",
      "PUT /api/config",
    ];
    // 迁移完成后**新增**的路由 —— 它们没有 Python 对应物（Python 已经不存在了），
    // 但同样必须逐条列出：这张清单的价值就在于"多一条路由必须有人显式认领"。
    const POST_MIGRATION_ROUTES = [
      // 会话分叉（借 pi 的会话树交互）：从拍板点 ordinal 复制材料+决策，重新梳理
      "POST /api/sessions/:sid/fork",
    ];
    const known = new Set([
      ...PYTHON_ROUTES.map(([m, p]) => `${m} ${p}`),
      ...ROUTER_ROUTES,
      ...POST_MIGRATION_ROUTES,
    ]);
    expect(handlerRoutes().filter((k) => !known.has(k))).toEqual([]);
  });

  it("skills 不是空表 —— `/api/health` 要给出技能库的名字", () => {
    wireServer();
    // 曾经这里硬编码成 `[]`（注释写着"技能库还没迁"），而 kernel/skills.ts 早已
    // 落地。差分脚本正是从 `/api/health` 的这个字段抓到的。
    expect(serverEnv().skillNames().length).toBeGreaterThan(0);
  });

  it("engagement DAG 是冻结的，且能投影出阶段清单", () => {
    wireServer();
    const dag = serverEnv().fdeEngagementDag();
    expect(dag.frozen).toBe(true);
    expect(dag.topoOrder()).toContain("INTERVIEW");
  });
});
