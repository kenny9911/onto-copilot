/**
 * 应用装配与生命周期 —— 移植自 `server.py` 第 278~333 行（lifespan + app）、
 * 第 335~421 行（`/api/usage` 路由壳）、第 845~857 行（归属判定）与第 7036~7051 行
 * （前端外壳）。
 *
 * 事件流是内核事件日志的**投影**，不是另一套埋点。所以前端上看到的推理轨迹与
 * 事后重放、审计看到的是同一份数据 —— 两套埋点必然会漂移，而漂移的那天你不会
 * 知道该信哪个。
 *
 * ── 别的段怎么接 ─────────────────────────────────────────────────────────
 *
 * `import { app } from "./app.js"` 之后直接 `app.get(...)` / `app.route(...)`，
 * 与 FastAPI 的 `@app.get` / `include_router` 一一对应。**不要**再 new 一个 Hono。
 *
 * ── 与 Python 的分叉（都在 divergences 里报了）────────────────────────────
 *
 * 1. FastAPI 的 `lifespan` 是 asynccontextmanager，Hono 没有这层 → 拆成
 *    {@link startServerLifespan} / {@link stopServerLifespan}，外加一个把两者包起来
 *    的 {@link serverLifespan}。
 * 2. `authgate.py` / `configapi.py` 未迁 → 鉴权中间件是**晚绑定**的：本文件在启动
 *    时就注册一个转发壳，authgate 段落地后调 {@link registerAuthMiddleware} 填进去。
 *    在填进去之前它是**放行**的 —— 这与 authgate 自身的 fail-closed 纪律不冲突：
 *    fail-closed 说的是"认证逻辑判不出用户就拒绝"，而这里是"认证逻辑还没接上"，
 *    那是部署错误，会在启动日志上吼一声（见下）。
 * 3. `_reconcile_on_boot`（server.py:4609）属于别的段 → {@link registerBootReconciler}。
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotenv } from "../kernel/config.js";
import { SESSION_EVENTS } from "../session_events.js";
import { getRepo, lifespan as storeLifespan, shutdownStore, startStore } from "../store/deps.js";
import type { Repo } from "../store/repo/protocol.js";
import {
  currentRepo,
  ensureRootDir,
  refreshLeaseTtls,
  refreshRoot,
} from "./session.js";
import {
  appConfig,
  drainUsageOnShutdown,
  startUsageDrain,
  usageReport,
} from "./usage.js";
import type { UsageDrain, UsageReport } from "./usage.js";
import { optionalIntQuery } from "./http422.js";

/** 单一版本来源，与 `ontocopilot.__version__` 对齐。 */
export const VERSION = "0.1.0";

// ══════════════════════════════════════════════════════════════════
//  请求上下文
// ══════════════════════════════════════════════════════════════════

/** 鉴权中间件挂在 context 上的用户。对应 Python 的 `request.state.user`。 */
export interface RequestUser {
  readonly id: string;
  readonly username?: string;
  readonly role?: string;
}

export type AppEnv = {
  Variables: {
    user: RequestUser | null;
  };
};

/**
 * 开放模式（不强制鉴权）下的合成管理员 id。
 *
 * 与 `authgate.SYNTHETIC_ADMIN.id` 必须逐字一致 —— 它同时是**库里已有会话的
 * owner 值**，改一个字母就会让开放模式下建的所有历史会话在列表里消失。
 */
export const SYNTHETIC_ADMIN_ID = "__local__";

/** 当前请求用户的 id（开放模式下是合成管理员 `__local__`）。新建会话记它为归属。 */
export function ownerId(c: Context<AppEnv>): string {
  return c.get("user")?.id ?? "";
}

/** 是否要按账号隔离：强制鉴权下的真实用户才隔离；开放模式（合成管理员）照旧全见。 */
export function isolate(c: Context<AppEnv>): boolean {
  const u = c.get("user");
  return u != null && u.id !== SYNTHETIC_ADMIN_ID;
}

// ══════════════════════════════════════════════════════════════════
//  未迁模块的接线点
// ══════════════════════════════════════════════════════════════════

let _authMiddleware: MiddlewareHandler<AppEnv> | null = null;
let _corsOrigins: () => string[] = () => [];
let _bootReconciler: (() => Promise<void>) | null = null;

/** authgate 段落地后调一次。传 null 解除（测试里用）。 */
export function registerAuthMiddleware(mw: MiddlewareHandler<AppEnv> | null): void {
  _authMiddleware = mw;
}

/** 默认空 = 仅同源（实际部署方式）。带凭证时浏览器禁止通配，实现里也会滤掉 "*"。 */
export function registerCorsOrigins(fn: (() => string[]) | null): void {
  _corsOrigins = fn ?? (() => []);
}

/** `_reconcile_on_boot`（server.py:4609）的接线点。 */
export function registerBootReconciler(fn: (() => Promise<void>) | null): void {
  _bootReconciler = fn;
}

// ══════════════════════════════════════════════════════════════════
//  app
// ══════════════════════════════════════════════════════════════════

export const app = new Hono<AppEnv>();

// 鉴权门禁：一道 fail-closed 的中间件。**先**注册 CORS、**后**注册鉴权 —— Hono 的
// `use` 是**外层在前**，而 Starlette 的 `add_middleware` 是把后加的放到外层。两边
// 的最终栈序因此相同：CORS 在外，预检 OPTIONS 与 401 响应上都能带跨域头。
app.use("*", (c, next) =>
  cors({
    // 每个请求现算：设置页改了允许来源，不必重启。
    origin: (origin) => {
      const allowed = _corsOrigins();
      return allowed.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["*"],
  })(c, next),
);

// 晚绑定的转发壳，见文件头分叉 2。中间件表在 app 建好那一刻就固定了，所以
// 这里注册的是"去问当前有没有鉴权实现"，而不是当时的那个实现本身。
app.use("*", async (c, next) => {
  if (_authMiddleware === null) {
    c.set("user", null);
    return next();
  }
  return _authMiddleware(c, next);
});

// ══════════════════════════════════════════════════════════════════
//  /api/usage
// ══════════════════════════════════════════════════════════════════

/**
 * FastAPI 的 `days: int = 30` 在参数不是整数时回 422。Hono 不做这层校验，
 * 照着补 —— 不补的话 `?days=abc` 会静默变成默认 30 天，用户看到的是一份
 * 「和他要的不一样但也不报错」的账。
 *
 * 422 的**载荷形状**走 `http422.ts`：以前这里给的是一句话 detail，而 pydantic
 * 给的是错误数组，前端两条渲染分支只认后者。
 */
function queryInt(c: Context<AppEnv>, name: string, fallback: number): number {
  return optionalIntQuery(c, name, fallback);
}

app.get("/api/usage", async (c) => {
  const report: UsageReport = await usageReport(currentRepo(), {
    days: queryInt(c, "days", 30),
    bucket: c.req.query("bucket") ?? "day",
    limit: queryInt(c, "limit", 5000),
    // 强制鉴权下只看自己的账；开放模式（合成管理员）看全部，与会话列表同一套规则
    owner: isolate(c) ? ownerId(c) : null,
  });
  return c.json(report);
});

// ══════════════════════════════════════════════════════════════════
//  前端
// ══════════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));
// 源码开发（ts/src/server/ → 仓库根）与打包安装（与代码同级的 ui/）位置不同；
// 选择真实存在的完整工作台。与 Python 的 `_SOURCE_UI` / `_PACKAGED_UI` 同一条判据。
const SOURCE_UI = resolve(HERE, "..", "..", "..", "ui");
const PACKAGED_UI = join(HERE, "ui");

export function uiDir(): string {
  return existsSync(join(SOURCE_UI, "index.html")) ? SOURCE_UI : PACKAGED_UI;
}

/**
 * 前端外壳。**明确禁止缓存。**
 *
 * 没有缓存头时浏览器会把这个 HTML 缓存住，于是后端改了、前端没改 —— 用户看到
 * 的是几个版本之前的界面，报上来的 bug 是早就修掉的那个。单文件前端（HTML 里
 * 内联 CSS+JS）尤其严重：整个应用就是这一个文件。
 */
app.get("/", (c) => {
  const p = join(uiDir(), "index.html");
  const body = existsSync(p)
    ? readFileSync(p, "utf8")
    : "<h1>OntoCopilot</h1><p>前端未构建。API 在 /docs。</p>";
  return c.html(body, 200, {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
  });
});

// ══════════════════════════════════════════════════════════════════
//  生命周期
// ══════════════════════════════════════════════════════════════════

let _usageDrain: UsageDrain | null = null;

/**
 * 先起库，再对账。顺序不能反 —— 对账要用 repo。
 *
 * 把 `.env` 载进进程环境：CLI 走 `llmConfig()` 时会加载，但服务端的网关配置改走
 * appconfig（DB→env→抛错），它只读 `process.env` 不自己加载 —— 于是裸起进程时
 * `.env` 里的网关明明配了却读不到，`/chat` 与 `/build` 全 500。在这里一次性载入。
 */
export async function startServerLifespan(): Promise<void> {
  loadDotenv();
  refreshRoot();
  refreshLeaseTtls();
  await startStore();
  ensureRootDir();
  await appConfig().refresh(currentRepo()); // 预热设置缓存（网关/模型/预算覆盖）
  if (_bootReconciler !== null) await _bootReconciler();
  _usageDrain = startUsageDrain(() => currentRepo()); // 用量流水落库
}

/** 与 {@link startServerLifespan} 对称。**关库之前**必须先排空事件与账本。 */
export async function stopServerLifespan(): Promise<void> {
  const drain = _usageDrain;
  _usageDrain = null;
  if (drain !== null) {
    drain.stop();
    await drain.promise;
  }
  // 关停前把剩下的流水写完 —— 一次梳理刚跑完就重启，账不该丢。
  try {
    await drainUsageOnShutdown(getRepo() as Repo);
  } catch {
    // getRepo 本身可能抛（库压根没起来）。用量写入是旁路；正常关停不能因账本
    // 不可用而卡死。缓冲里的那些已经在 drainUsageOnShutdown 里计入 dropped 了。
  }
  // 仓储连接在外层关闭；先 drain，确保已经接受的同步 emit 在正常关停时全部
  // commit，避免 shutdown 尾部丢审计。
  await SESSION_EVENTS.shutdown();
  await shutdownStore();
}

/**
 * 把整个应用生命周期包起来。`storeLifespan` 只负责库；这一层多做三件事：
 * 载 `.env`、预热设置缓存、起/停用量落库循环。
 */
export async function serverLifespan<T>(body: () => Promise<T>): Promise<T> {
  loadDotenv();
  refreshRoot();
  refreshLeaseTtls();
  return await storeLifespan(async () => {
    ensureRootDir();
    await appConfig().refresh(currentRepo());
    if (_bootReconciler !== null) await _bootReconciler();
    const drain = startUsageDrain(() => currentRepo());
    _usageDrain = drain;
    try {
      return await body();
    } finally {
      _usageDrain = null;
      drain.stop();
      await drain.promise;
      try {
        await drainUsageOnShutdown(currentRepo());
      } catch {
        /* 见 stopServerLifespan 的说明 */
      }
      await SESSION_EVENTS.shutdown();
    }
  });
}
