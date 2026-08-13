/**
 * 服务启动器 —— 前后端同进程。移植自 `src/ontocopilot/serve.py`，并且是**整个 TS
 * 服务唯一的接线处**。
 *
 * 前端是纯静态页面，由后端在 `/` 直接吐出来，**不单开一个前端服务器**：
 * 多一个进程就多一份 CORS、端口、部署配置要对齐，而这个 UI 没有构建步骤，
 * 分开跑没有任何好处。
 *
 * ── 为什么接线全挤在这一个文件里 ────────────────────────────────────────
 *
 * 各段（app / session / usage / store/deps / authgate / configapi）都留了
 * `registerXxx()` 注册点，谁来填是个问题。填在各自的模块顶层（import 即生效）会让
 * **import 顺序**变成隐式依赖，测试里 import 一个模块就顺手改了全局；填在
 * 每个调用点又会填好几遍。所以只有这里填，且只在 {@link wireServer} 里填一次 ——
 * 进程入口本来就该是"把零件装起来"的地方。测试要换零件就调
 * {@link registerServerParts}，不必去动被测模块。
 *
 * ── 还没落地的段（都在 divergences 里报了）──────────────────────────────
 *
 * `kernel/skills.ts`、`onto/engagement.ts`、以及 `server.py` 里的
 * `_persist_decisions` / `_session_mutation` / `_preparse` / `_dialogue` /
 * `_emit_ai_prompts` / `_reconcile_on_boot` 尚无 TS 对应件。
 * 它们在 {@link PARTS} 里各有一个**显式抛错**的占位实现 —— 不是空实现：一个悄悄
 * 什么都不做的 `persist` 会让"梳理跑完了但什么都没存"看起来像成功。落地后由
 * {@link registerServerParts} 填进来，本文件的其余部分一个字都不用改。
 *
 * 受影响的是**那几条路由**，不是整个服务：`/api/health`、`/api/config`、
 * `/api/auth/*`、`/api/users/*`、`/api/projects`、会话列表与 SSE 都是通的。
 */

import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";

import { installAppConfig, resolvedLlmConfig } from "./appconfig.js";
import { authMiddleware, authRouter, corsOrigins, usersRouter } from "./authgate.js";
import { configRouter, registerConfigCatalog } from "./configapi.js";
import { ModelCatalog } from "./kernel/catalog.js";
import { ensureCatalogFromConfig, installCatalogPort } from "./server/catalog_wiring.js";
import { insecureTransport, redactedKey } from "./kernel/config.js";
import { app, registerAuthMiddleware, registerBootReconciler, registerCorsOrigins } from "./server/app.js";
import { startServerLifespan, stopServerLifespan } from "./server/app.js";
import type { AppEnv } from "./server/app.js";
import { registerHydrator } from "./server/session.js";
import { getStore } from "./store/deps.js";
import { registerRepoBuilder } from "./store/deps.js";
import type { Store } from "./store/engine.js";
import { MemoryRepo } from "./store/repo/memory.js";
import { PgRepo } from "./store/repo/pg.js";
import type { Repo } from "./store/repo/protocol.js";
import type { JsonValue } from "./store/types.js";
import { registerFileRoutes } from "./server/routes/files.js";
import { registerProjectRoutes } from "./server/routes/projects.js";
import { registerSessionRoutes } from "./server/routes/sessions.js";
import { registerStreamRoutes } from "./server/routes/stream.js";
import type { CatalogLike, ServerEnv } from "./server/routes/sessions.js";
import type { Session } from "./server/session.js";

// ══════════════════════════════════════════════════════════════════
//  仓储选路
// ══════════════════════════════════════════════════════════════════

/** 按 Store 的模式挑实现。**这是唯一的选路点**（`store/repo.py:3192`）。 */
export function buildRepo(store: Store): Repo {
  return store.engine === null ? new MemoryRepo() : new PgRepo(store.engine);
}

// ══════════════════════════════════════════════════════════════════
//  还没落地的那几段
// ══════════════════════════════════════════════════════════════════

/**
 * 一个还没接线的零件被调用了。
 *
 * **抛，不是静默降级。** 这些占位挡的是"梳理跑完但什么都没存""对话记忆一直是空的"
 * 这类失败 —— 它们不会在日志里留下任何痕迹，只会在几天后表现为"客户说数据没了"。
 */
function notWired(what: string): never {
  throw new Error(`${what} 还没接线：对应的 TS 模块尚未落地，见 serve.ts 文件头`);
}

/**
 * `ModelCatalog` → 路由那一段声明的 `CatalogLike`。
 *
 * 只是一层 cast：`describe()` 真实返回 `ModelCardDict[]`，而路由那边声明的是
 * `JsonValue`。两者的**值**完全一样（那个 dict 本来就是要 JSON 化发给前端的），
 * 只是 TS 不认没有索引签名的接口是 `JsonValue`。写成适配器而不是在别人的文件里
 * 改类型声明 —— 这一处是接缝，不是 bug。
 */
function asServerCatalog(cat: ModelCatalog): CatalogLike {
  return {
    describe: () => cat.describe() as unknown as JsonValue,
    byCapability: () => cat.byCapability() as unknown as JsonValue,
    get: (name) => cat.get(name),
  };
}

/** 各段落地后往这里填。字段全部可选，只填自己那一份。 */
export interface ServerParts {
  persist?: (s: Session, opts?: { readonly status?: boolean }) => Promise<void>;
  sessionMutation?: <T>(s: Session, kind: string, body: () => Promise<T>) => Promise<T>;
  busy?: (s: Session) => boolean;
  preparse?: (s: Session) => Promise<void>;
  dialogue?: ServerEnv["dialogue"];
  emitAiPrompts?: (s: Session, slot: string) => void;
  ensureCatalog?: () => Promise<CatalogLike>;
  newCatalog?: () => CatalogLike;
  skillNames?: () => string[];
  fdeEngagementDag?: ServerEnv["fdeEngagementDag"];
  hydrator?: Parameters<typeof registerHydrator>[0];
  bootReconciler?: (() => Promise<void>) | null;
}

const PARTS: {
  persist: NonNullable<ServerParts["persist"]>;
  sessionMutation: NonNullable<ServerParts["sessionMutation"]>;
  busy: NonNullable<ServerParts["busy"]>;
  preparse: NonNullable<ServerParts["preparse"]>;
  dialogue: NonNullable<ServerParts["dialogue"]>;
  emitAiPrompts: NonNullable<ServerParts["emitAiPrompts"]>;
  ensureCatalog: NonNullable<ServerParts["ensureCatalog"]>;
  newCatalog: NonNullable<ServerParts["newCatalog"]>;
  skillNames: NonNullable<ServerParts["skillNames"]>;
  fdeEngagementDag: NonNullable<ServerParts["fdeEngagementDag"]>;
} = {
  persist: () => notWired("_persist"),
  sessionMutation: () => notWired("_session_mutation"),
  busy: () => notWired("_busy"),
  preparse: () => notWired("_preparse"),
  dialogue: () => notWired("_dialogue"),
  emitAiPrompts: () => notWired("_emit_ai_prompts"),
  // `_ensure_catalog()`：按网关 /v1/models 过滤，懒发现、成功一次即缓存
  ensureCatalog: async () => asServerCatalog(await ensureCatalogFromConfig()),
  // `ModelCatalog()`：**未经过滤**的内置目录，`/api/health` 用的就是这一份 ——
  // 网关连不上时它照样答得出"这个版本认识哪些模型"
  newCatalog: () => asServerCatalog(new ModelCatalog()),
  // `default_library().names()`：技能库还没迁，先给空表
  skillNames: () => [],
  fdeEngagementDag: () => notWired("build_fde_engagement_dag"),
};

export function registerServerParts(parts: ServerParts): void {
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined) continue;
    if (k === "hydrator") {
      registerHydrator(parts.hydrator ?? null);
    } else if (k === "bootReconciler") {
      registerBootReconciler(parts.bootReconciler ?? null);
    } else {
      (PARTS as Record<string, unknown>)[k] = v;
    }
  }
}

/** 四个路由文件共用的运行时接缝。全部**现取**，这样后填的零件立刻生效。 */
export function serverEnv(): ServerEnv {
  return {
    persist: (s, opts) => PARTS.persist(s, opts),
    sessionMutation: (s, kind, body) => PARTS.sessionMutation(s, kind, body),
    busy: (s) => PARTS.busy(s),
    preparse: (s) => PARTS.preparse(s),
    dialogue: (s) => PARTS.dialogue(s),
    emitAiPrompts: (s, slot) => PARTS.emitAiPrompts(s, slot),
    ensureCatalog: () => PARTS.ensureCatalog(),
    newCatalog: () => PARTS.newCatalog(),
    // `appconfig.resolved_llm_config()`：**key 必须是脱敏后的那一个** ——
    // /api/health 是会被贴进工单和截图的那个响应
    resolvedLlmConfig: () => {
      const cfg = resolvedLlmConfig();
      return {
        baseUrl: cfg.baseUrl,
        redactedKey: redactedKey(cfg),
        insecureTransport: insecureTransport(cfg),
      };
    },
    storeHealthcheck: async () => {
      const h = await getStore().healthcheck();
      return h as unknown as Record<string, never>;
    },
    skillNames: () => PARTS.skillNames(),
    fdeEngagementDag: () => PARTS.fdeEngagementDag(),
  } as ServerEnv;
}

// ══════════════════════════════════════════════════════════════════
//  装配
// ══════════════════════════════════════════════════════════════════

let _wired = false;

/**
 * 把所有注册点填上。**幂等** —— Hono 的路由表是数组，装两遍会让同一条路径匹配到
 * 第一个注册的处理器，症状是"改了代码不生效"。
 */
export function wireServer(): void {
  if (_wired) return;
  _wired = true;

  // 1. 运行时配置：DB 覆盖 → env → 抛错（换掉 usage.ts 里 env-only 的默认实现）
  installAppConfig();
  // 2. 仓储选路：store/deps.ts 在 startStore() 里会调它
  registerRepoBuilder(buildRepo);
  // 3. 鉴权门禁。app.ts 注册的是一个**晚绑定的转发壳**，没填之前一律放行；
  //    填上之后才是 fail-closed 的那道门。类型上两边的 `user` 不同名同姓
  //    （authgate 的 UserRow vs app 的 RequestUser），运行时是同一个对象。
  registerAuthMiddleware(authMiddleware() as unknown as MiddlewareHandler<AppEnv>);
  // 4. 允许的跨域来源：每个请求现算，设置页改了不必重启
  registerCorsOrigins(() => corsOrigins());
  // 5. 模型目录：`gateways()` 用过滤后的那一份，设置页用未过滤的内置目录
  //    （与 Python 的 `_ensure_catalog()` / `ModelCatalog()` 两个调用点一一对应）
  installCatalogPort();
  // 同一层 cast，同一个理由（见 asServerCatalog）：configapi 声明的是
  // `Record<string, unknown>[]`，`ModelCardDict` 没有索引签名所以结构上不匹配
  registerConfigCatalog(() => {
    const cat = new ModelCatalog();
    return {
      get: (name) => cat.get(name),
      names: () => cat.names(),
      describe: () => cat.describe() as unknown as Record<string, unknown>[],
    };
  });

  // 6. 路由。`app.route("/", r)` 对应 FastAPI 的 `include_router` —— 子 router 里
  //    路径已经写全，所以挂在根上。
  const env = serverEnv();
  app.route("/", authRouter());
  app.route("/", usersRouter());
  app.route("/", configRouter());
  registerSessionRoutes(app, env);
  registerFileRoutes(app, env);
  registerProjectRoutes(app);
  registerStreamRoutes(app);
}

// ══════════════════════════════════════════════════════════════════
//  进程
// ══════════════════════════════════════════════════════════════════

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  /** 关掉监听并跑完 lifespan 的收尾（排空事件、写完账本、关库）。 */
  close(): Promise<void>;
}

/**
 * 起服务。`lifespan` 在**开始监听之前**跑完 —— 反过来的话，第一个请求可能撞上
 * 一个还没建好的 repo，而那表现为一次随机的 500。
 */
export async function startServer(
  opts: { host?: string; port?: number } = {},
): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  wireServer();
  await startServerLifespan();
  let server: ReturnType<typeof serve>;
  let port: number;
  try {
    // **等到真的 listening 再返回**：绑定是异步的，立刻问 `address()` 会拿到 null，
    // 而 `port: 0`（让内核挑一个）下那就意味着调用方拿着一个 0 去连 —— 症状是
    // 一个看起来毫不相干的 EADDRNOTAVAIL。
    ({ server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
      (resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? 8000 }, (info) =>
          resolve({ server: s, port: info.port }),
        );
        s.on("error", reject);
      },
    ));
  } catch (e) {
    // 端口被占之类：lifespan 已经起来了，得原路关掉，不然测试会留下一个连着库的进程
    await stopServerLifespan();
    throw e;
  }
  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopServerLifespan();
    },
  };
}

/** `argparse` 的那一小块：`--host` / `--port` / `--reload`。 */
export interface ServeArgs {
  host: string;
  port: number;
  reload: boolean;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
    Object.setPrototypeOf(this, ArgError.prototype);
  }
}

export function parseArgs(argv: readonly string[]): ServeArgs {
  const out: ServeArgs = { host: "127.0.0.1", port: 8000, reload: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const [name, inline] = eq > 1 && a.startsWith("--") ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const take = (): string => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined) throw new ArgError(`argument ${name}: expected one argument`);
      i += 1;
      return v;
    };
    if (name === "--host") out.host = take();
    else if (name === "--port") {
      const raw = take();
      // argparse 的 `type=int`：解析不出来是 exit code 2，不是悄悄用默认值
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new ArgError(`argument --port: invalid int value: '${raw}'`);
      }
      out.port = Number(raw);
    } else if (name === "--reload") out.reload = true;
    else throw new ArgError(`unrecognized arguments: ${a}`);
  }
  return out;
}

/**
 * 启动进程。返回退出码（0 正常、2 参数错误）。
 *
 * **`--reload` 在 TS 侧只是一句提示。** uvicorn 的 reloader 是它自己 fork 出来的
 * 监视进程；Node 上对等物是 `node --watch` / `tsx watch`，那是**外层**的事，在
 * 进程内部实现一遍等于自己写一个监视器。接着这个参数是为了让原来的命令行不报错。
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: ServeArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`ontocopilot-server: error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.reload) {
    console.log("  提示  --reload 请用 `node --watch` / `tsx watch` 在外层做");
  }
  console.log(`  界面  http://${args.host}:${args.port}/`);
  console.log(`  API   http://${args.host}:${args.port}/docs`);
  const running = await startServer({ host: args.host, port: args.port });

  // Ctrl-C / docker stop：**先把 lifespan 收尾跑完**再退，否则缓冲里的用量流水与
  // 还没落盘的会话事件会一起丢 —— 而那正是"重启之后账少了一笔"的由来。
  const stop = (): void => {
    void running.close().then(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return 0;
}
