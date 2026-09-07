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
      // FDE 项目上下文：聚合证据、模型、审阅与交付的只读 read model
      "GET /api/sessions/:sid/context",
      // 统一预览清单与安全内嵌内容（材料、产物和 live model 画布）
      "GET /api/sessions/:sid/preview",
      "GET /api/sessions/:sid/preview/content",
      // 挂起态只读 Ontology DRAFT snapshot 与虚拟 JSON；不进入正式 artifact/bundle
      "GET /api/sessions/:sid/ontology/draft",
      "GET /api/sessions/:sid/ontology/draft/artifacts/:name",
      // 访谈包一键下载：回传闭环的正确载体（按角色分组 + 「您的回答」列）。
      // 以前只有对话暗号（export.file source=interview_kit）一条出口，界面下载
      // 按钮给的是问题清单.xlsx —— FDE 发错文件是结构性的。
      "GET /api/sessions/:sid/questions/interview-kit",
      // §7.5 节点级 fork 重跑：保留其余专业节点重放、EXTRACT 免费复用
      "POST /api/sessions/:sid/engagement/fork",
      // 全量日志：管理员跨账号看全部，普通用户只看自己的。
      // **故意不挂在 /api/sessions/ 下面** —— authgate 那道按 `row.owner !== user.id`
      // 判的中间件对管理员不豁免、且跑在路由之前，挂进去管理员只会拿到 404。
      "GET /api/logs/sessions",
      "GET /api/logs/sessions/:sid/events",
      "GET /api/logs/sessions/:sid/events/:seq",
      "GET /api/logs/sessions/:sid/runtime/runs",
      "GET /api/logs/sessions/:sid/runtime/runs/:runId/events/:seq",
      // P4：停掉单个在飞节点（协作式取消该 slot；run 级 /stop 是全停）
      "POST /api/sessions/:sid/run/nodes/stop",
      // 安全网页工作台：reader snapshot、版本化引用、翻译/总结与材料记忆。
      "GET /api/sessions/:sid/web/pages",
      "POST /api/sessions/:sid/web/pages",
      "POST /api/sessions/:sid/web/live-snapshots",
      "GET /api/sessions/:sid/web/pages/:pageId",
      "GET /api/sessions/:sid/web/pages/:pageId/content",
      "GET /api/sessions/:sid/web/pages/:pageId/analyses",
      "POST /api/sessions/:sid/web/pages/:pageId/translate",
      "POST /api/sessions/:sid/web/pages/:pageId/summarize",
      "POST /api/sessions/:sid/web/pages/:pageId/save",
      // 独立 Chromium Live Browser：第三方 DOM/JS 不进入 OntoCopilot origin，前端只取
      // 同源 PNG frame；Reader 路由仍保留用于引用、翻译和总结。
      "GET /api/sessions/:sid/live-browser/capabilities",
      "GET /api/sessions/:sid/live-browser/sessions",
      "POST /api/sessions/:sid/live-browser/sessions",
      "GET /api/sessions/:sid/live-browser/sessions/:browserSessionId",
      "GET /api/sessions/:sid/live-browser/sessions/:browserSessionId/frame",
      "DELETE /api/sessions/:sid/live-browser/sessions/:browserSessionId",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/navigate",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/back",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/forward",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/reload",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/screenshot",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/pointer",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/scroll",
      "POST /api/sessions/:sid/live-browser/sessions/:browserSessionId/key",
      // OntoDocument：项目级长期知识库、不可变版本、精确会话挂载与证据读取。
      "GET /api/sessions/:sid/documents/acl",
      "PUT /api/sessions/:sid/documents/acl",
      "GET /api/sessions/:sid/documents/audit",
      "GET /api/sessions/:sid/documents",
      "POST /api/sessions/:sid/documents/promote",
      "GET /api/sessions/:sid/documents/search",
      // 后台任务只开放入队/查看/取消；run/commit 留在服务端内部。
      "POST /api/sessions/:sid/documents/jobs",
      "GET /api/sessions/:sid/documents/jobs",
      "GET /api/sessions/:sid/documents/jobs/:jobId",
      "DELETE /api/sessions/:sid/documents/jobs/:jobId",
      // 固定 exact version/index/ACL/text hash 的搜索结果与续页。
      "POST /api/sessions/:sid/documents/search-snapshots",
      "POST /api/sessions/:sid/documents/search-snapshots/:snapshotId/page",
      "GET /api/sessions/:sid/documents/:documentId/history",
      // 打开一份材料按原文顺序读。此前知识库只有 search（要关键词）和
      // evidence/:ref/open（要一个已经拿到的引用）——存进去的文件没有打开入口。
      "GET /api/sessions/:sid/documents/:documentId/content",
      // 「设为通用知识」：把项目材料复制进公共库。人点的动作，没有自动调用点。
      "POST /api/sessions/:sid/documents/:documentId/publish",
      "POST /api/sessions/:sid/documents/:documentId/reparse",
      // 用户手工建的文件夹。之前树里的分组是按标签推出来的，空文件夹无处存放 ——
      // 建一个立刻消失。文件夹必须是独立于文件存在的东西。
      "GET /api/sessions/:sid/documents/folders",
      "POST /api/sessions/:sid/documents/folders",
      "PATCH /api/sessions/:sid/documents/folders",
      "DELETE /api/sessions/:sid/documents/folders",
      "PATCH /api/sessions/:sid/documents/:documentId/folder",
      "GET /api/knowledge/documents/folders",
      "POST /api/knowledge/documents/folders",
      "PATCH /api/knowledge/documents/:documentId/folder",
      // 公共知识库：**不经过会话**。产品要求「这个知识库应该可以直接去访问」——
      // 在此之前所有知识库路由都挂在 /api/sessions/:sid 下，侧栏按钮在会话没归项目时
      // 是禁用的。这一组只有读与整理；attach/promote 依赖会话语义，刻意没挂。
      "GET /api/knowledge/documents",
      "GET /api/knowledge/documents/search",
      "GET /api/knowledge/documents/evidence/:ref/open",
      "GET /api/knowledge/documents/:documentId/content",
      "GET /api/knowledge/documents/:documentId/history",
      "GET /api/sessions/:sid/documents/evidence/:ref/open",
      "PATCH /api/sessions/:sid/documents/:documentId",
      "PATCH /api/sessions/:sid/documents/:documentId/adopt",
      "PATCH /api/sessions/:sid/documents/:documentId/archive",
      "POST /api/sessions/:sid/documents/:documentId/attach",
      "DELETE /api/sessions/:sid/documents/:documentId/attach",
      // 不可变版本的确定性 diff/影响分析，以及独立项目 Wiki 页面。
      "GET /api/sessions/:sid/documents/:documentId/diff",
      "GET /api/sessions/:sid/documents/:documentId/impact",
      "GET /api/sessions/:sid/documents/wiki/pages",
      "POST /api/sessions/:sid/documents/wiki/pages",
      "GET /api/sessions/:sid/documents/wiki/pages/:pageId",
      "PATCH /api/sessions/:sid/documents/wiki/pages/:pageId",
      "GET /api/sessions/:sid/documents/wiki/pages/:pageId/history",
      "POST /api/sessions/:sid/documents/wiki/pages/:pageId/archive",
      "POST /api/sessions/:sid/documents/wiki/pages/:pageId/restore",
      "POST /api/sessions/:sid/documents/wiki/pages/:pageId/claims",
      "PATCH /api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId",
      "DELETE /api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId",
      "POST /api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId/confirm",
      "GET /api/sessions/:sid/documents/wiki/pages/:pageId/export.md",
      "GET /api/sessions/:sid/documents/wiki/export/obsidian.zip",
      // 外部来源只保存凭据引用；真实客户端与文档 sink 由宿主注入。
      "GET /api/sessions/:sid/document-connectors",
      "POST /api/sessions/:sid/document-connectors",
      "GET /api/sessions/:sid/document-connectors/:sourceId/status",
      "PATCH /api/sessions/:sid/document-connectors/:sourceId",
      "POST /api/sessions/:sid/document-connectors/:sourceId/enable",
      "POST /api/sessions/:sid/document-connectors/:sourceId/disable",
      "POST /api/sessions/:sid/document-connectors/:sourceId/archive",
      "POST /api/sessions/:sid/document-connectors/:sourceId/restore",
      "POST /api/sessions/:sid/document-connectors/:sourceId/sync",
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
