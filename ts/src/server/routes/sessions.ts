/**
 * 会话路由 —— 移植自 `server.py` 的 804–1160 / 1598–1968 行。
 *
 * 覆盖 `/api/health`、`/api/models`、`/api/sessions/{sid}/model`、
 * `/api/sessions`（GET/POST）、`/api/sessions/{sid}`（DELETE/PATCH）、
 * `/api/sessions/{sid}/to_work`、`/api/sessions/{sid}/state`。
 *
 * ── 还没有 TS 实现的那几样怎么接（`ServerEnv`）────────────────────────────
 *
 * `Session` / `SESSIONS` / `sessAsync` / `refreshFilesProjection` / `root()` /
 * `currentRepo()` / `ownerId` / `isolate` 都已经在别的段落地，这里**直接 import**。
 *
 * 剩下的是当前还完全没有 TS 实现的东西：`appconfig`（网关配置）、`ModelCatalog`、
 * `_persist`、`_session_mutation`、`_preparse`、`_busy`、`_dialogue`、
 * `_emit_ai_prompts`、`default_library()`、`get_store().healthcheck()`、
 * `build_fde_engagement_dag()`。它们收进一个显式的 `ServerEnv` 参数对象由装配处
 * 注入 —— **不是**造 DI 框架（契约 §10 明确不许），就是个参数。这样这四个路由文件
 * 现在能独立编译、独立测试，接线时把真实实现填进去即可。
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sha256Hex } from "../../kernel/ids.js";
import type { SpokenTurns } from "../../kernel/memory/dialogue.js";
import { FDE_CHECKPOINT_VERSION } from "../../onto/engagement.js";
import { openingPrompts } from "../../onto/prompts.js";
import type { FileRow, JsonObject, JsonValue, SessionRow } from "../../store/types.js";
import { makeFileRow, makeSessionRow } from "../../store/types.js";
import { activeScheduler } from "../pipeline/run.js";
import type { AppEnv } from "../app.js";
import { isolate, ownerId } from "../app.js";
import { materialFileList } from "../material_status.js";
import { reapZombieBuild } from "../glue/reap.js";
import {
  SESSIONS,
  Session,
  currentRepo,
  refreshFilesProjection,
  root,
  sessAsync,
} from "../session.js";
import type { SessionFile } from "../session.js";
import { boolParsingError, pydanticBool, raise422 } from "../http422.js";
import { liveBrowserRuntime } from "../live_browser.js";

// ══════════════════════════════════════════════════════════════════
//  HTTP 错误：体的形状必须是 FastAPI 的 {"detail": "…"}
// ══════════════════════════════════════════════════════════════════

/**
 * `HTTPException(code, msg)` 的等价物。
 *
 * 抛的仍是 Hono 的 `HTTPException`（契约 §10），但**额外**给一个 JSON 响应体：
 * FastAPI 回的是 `{"detail": msg}`，前端有两处逐字读 `d.detail`
 * （`ui/index.html:1598` / `:1728`）。只给 `message` 的话体是 text/plain，
 * 那两处会在 `r.json()` 上抛 —— 一个错误提示于是变成一个更难懂的错误。
 */
export function apiError(status: number, detail: string): HTTPException {
  // Hono 把状态码收得比 FastAPI 窄（`ContentfulStatusCode`）。这一层用到的
  // 400/404/409/413/422/500 全在集合里，断言只是让 TS 别去枚举它们。
  return new HTTPException(status as ContentfulStatusCode, {
    message: detail,
    // FastAPI 的 JSONResponse 用紧凑分隔符，`JSON.stringify` 正好一致。
    res: new Response(JSON.stringify({ detail }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

// ══════════════════════════════════════════════════════════════════
//  跨段接缝：当前还没有 TS 实现的那几样
// ══════════════════════════════════════════════════════════════════

/** `ModelCatalog` 里本段用到的三个方法。 */
export interface CatalogLike {
  describe(): JsonValue;
  byCapability(): JsonValue;
  /** 网关上有这个模型吗；Python 侧返回条目或 None，这里只看真假。 */
  get(name: string): unknown;
}

/** `appconfig.resolved_llm_config()` 的投影。**key 必须是脱敏后的那一个。** */
export interface LlmConfigView {
  readonly baseUrl: string;
  readonly redactedKey: string;
  readonly insecureTransport: boolean;
}

/** 冻结的 FDE Engagement DAG（`onto/engagement.py`，尚未迁移）。 */
export interface EngagementDagLike {
  readonly frozen: boolean;
  topoOrder(): string[];
  describe(): readonly Readonly<Record<string, unknown>>[];
}

/** 本段四个路由文件共用的运行时接缝。 */
export interface ServerEnv {
  /** `_persist(s, status=...)`。**持久化失败必须上抛**，不许吞。 */
  persist(s: Session, opts?: { readonly status?: boolean }): Promise<void>;
  /** `async with _session_mutation(s, kind)`：跨 worker 串行一次领域修改。
   * 抢不到租约抛 409；回调抛出时按 Python 的 except 分支恢复投影再原样上抛。 */
  sessionMutation<T>(s: Session, kind: string, body: () => Promise<T>): Promise<T>;
  /** `_busy`：正在跑 DAG（queued/parsing/extracting）。 */
  busy(s: Session): boolean;
  /** `_preparse`：重解析材料、重建证据索引。**零模型调用。** */
  preparse(s: Session): Promise<void>;
  /** `_dialogue(s)`：取会话的对话记忆，没有就建。 */
  dialogue(s: Session): SpokenTurns;
  /** `asyncio.create_task(_emit_ai_prompts(s, slot=...))` —— **不 await**。 */
  emitAiPrompts(s: Session, slot: string): void;
  /** `_ensure_catalog()`：按网关 /v1/models 过滤，懒发现、成功一次即缓存。 */
  ensureCatalog(): Promise<CatalogLike>;
  /** `ModelCatalog()`：**未经过滤**的内置目录（/api/health 用的就是这一份）。 */
  newCatalog(): CatalogLike;
  /** `appconfig.resolved_llm_config()`；配不出来时**抛错**（health 会接住）。 */
  resolvedLlmConfig(): LlmConfigView;
  /** `get_store().healthcheck()`。 */
  storeHealthcheck(): Promise<JsonObject>;
  /** `default_library().names()`。 */
  skillNames(): string[];
  /** `build_fde_engagement_dag()`。 */
  fdeEngagementDag(): EngagementDagLike;
  /** `_restore_dialogue`：把 repo 里的决策行并进对话记忆。fork 复制完决策后要
   *  立刻调它 —— 不然「已拍板」要等下一次冷加载才看得见。 */
  restoreDialogue(s: Session): Promise<void>;
}

// ══════════════════════════════════════════════════════════════════
//  冷会话投影
// ══════════════════════════════════════════════════════════════════

/**
 * 库里有、但内存里没活着的会话的公共投影。
 *
 * 字段与 `Session.brief()` **逐个对齐**，只多一个 `hydrated: false`。抽成
 * 一个函数是因为它原来在列表路由里手抄了一遍：加字段时漏抄一处，表现就是"某些
 * 会话没有项目"，而且只在会话冷着的时候才复现。
 */
export async function coldBrief(r: SessionRow): Promise<Record<string, unknown>> {
  const files = await currentRepo().listFiles(r.id);
  const st = await currentRepo().loadState(r.id, { keys: ["mode"] });
  return {
    id: r.id,
    title: r.title,
    project: r.project,
    project_id: r.project_id,
    status: r.status,
    files: files.length,
    // `st.get("mode", "work")`：键**存在但为 null** 时 Python 给的是 null，
    // `?? "work"` 会把它悄悄改成 "work"。这里按"键在不在"判。
    mode: "mode" in st ? st["mode"] : "work",
    created: r.created,
    error: r.error,
    hydrated: false,
  };
}

// ══════════════════════════════════════════════════════════════════
//  会话标题
// ══════════════════════════════════════════════════════════════════

/** 侧栏一行放得下的长度。Text 列本身不限长，挡在这里是因为超长标题只会把侧栏
 * 撑坏 —— 而且没人会**故意**取一个 200 字的名字，那多半是误粘了一整段。 */
export const TITLE_MAX = 120;
/** 自动命名的截断长度（第二档规则：用第一句话）。 */
export const TITLE_FROM_TEXT_MAX = 20;

/**
 * 「这个会话还没有名字」的判据 —— 也就是自动命名唯一允许覆盖的一组值。
 *
 * **为什么用一组默认值，而不是另存一个 `title_source` 标记：** 那个标记要么进
 * session_state（于是改名就得走 `_persist`，占租约、推 state_version，让侧栏上
 * 一次改名有可能撞掉正在跑的梳理），要么另加一列（一次迁移）。而标题本身已经
 * 携带了这个信息：默认名 = 没人起过名。用户手动改过之后标题必然不在这个集合里，
 * 自动命名于是**永远**碰不到它 —— 这正是"改过的名字不许被盖回去"要的性质。
 * 代价是一个可以接受的边角：用户手动把标题改回「新会话」这四个字，下一次自动
 * 命名会再次接管。
 *
 * 含 zh/en 两套（前端 `session.newChat` / `session.newWork`）和两个服务端默认值
 * （`Session.title` 的默认、`POST /api/sessions` 不带 title 时的默认）。
 */
export const DEFAULT_TITLES: ReadonlySet<string> = new Set([
  "新会话",
  "新对话",
  "新建会话",
  "新的本体梳理",
  "新任务",
  "New chat",
  "New session",
  "New work",
]);

/** 切「第一个短句」的分隔符：标点 + 换行/制表。**空格不算** —— 中文里它本来就
 * 不分句，而英文里按空格切会把 "How do we model POs" 切成 "How"。 */
const TITLE_BREAK = /[。．.！!？?；;，,、：:\n\r\t…]+/u;

/**
 * 标题的规范形：折叠所有空白、去首尾。
 *
 * 换行留在标题里会把侧栏那一行撑成两行，而它在标题里没有任何意义。
 */
export function normTitle(raw: unknown): string {
  // Python 的 `re.sub(r"\s+", " ", str(raw if raw is not None else ""))`。
  // 两边的 `\s` 都覆盖全角空格 U+3000 与 NBSP，所以折叠结果一致。
  return String(raw ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * 一档规则：用第一份材料的文件名（去扩展名）。
 *
 * 工作会话本来就是围着材料转的，「采购计划管理实体及业务规则梳理-v2」比任何
 * 模型总结都准，而且免费、瞬时、可复现。
 */
export function titleFromFiles(files: readonly { readonly name?: unknown }[]): string {
  const first = files[0];
  if (first === undefined) return "";
  const stem = normTitle(pathStem(String(first.name ?? "")));
  if (!stem) return "";
  return files.length === 1 ? stem : `${stem} 等 ${files.length} 份`;
}

/** `Path(name).stem`：先取 basename，再去掉**最后一个**点及其后缀。
 * 纯以点开头（".env"）在 Python 里没有后缀 —— stem 就是 ".env" 本身。 */
function pathStem(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** `Path(x).name`：防路径穿越用的 basename。反斜杠在 POSIX 上**是合法文件名字符**，
 * Python 的 PurePosixPath 不把它当分隔符，所以这里也只按 "/" 切。 */
export function baseName(name: string): string {
  const parts = name.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p) return p;
  }
  return "";
}

/** 二档规则：用用户第一句话的第一个短句，截到 20 字。 */
export function titleFromText(text: string): string {
  const whole = normTitle(text);
  // Python 的 `split(pat, 1)[0]`：只切第一次，取前半段
  const idx = whole.search(TITLE_BREAK);
  const first = normTitle(idx < 0 ? whole : whole.slice(0, idx));
  if (!first) return "";
  // 按**码点**截断：`first[:20]` 在 Python 里是码点，JS 的 slice 是 UTF-16 码元，
  // 直接 slice 会把一个 emoji / 星光面汉字劈成半个代理对。
  const cps = [...first];
  return cps.length <= TITLE_FROM_TEXT_MAX
    ? first
    : `${cps.slice(0, TITLE_FROM_TEXT_MAX).join("")}…`;
}

/** 按码点截断，等价于 Python 的 `s[:n]`。 */
export function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/**
 * 把新标题推给正在看的人。侧栏和顶栏要**立刻**变，不能等下次刷新。
 *
 * 冷会话不为了发一条事件就整个恢复一遍（那要重解析全部材料）：直接 append
 * 到事件表即可 —— `/stream` 的游标以仓储为准，别的 worker 上的订阅者最多
 * 250ms 后也能读到同一条。
 *
 * 活会话用 `emitDurable`：改名接口一返回，前端多半立刻就要重连/刷新列表，
 * 这条事件必须已经在事件表里，否则重放会漏掉它、侧栏又变回旧名字。
 */
export async function emitSessionRenamed(sid: string, title: string): Promise<void> {
  const live = SESSIONS.get(sid);
  if (live !== undefined) {
    await live.emitDurable("session.renamed", { id: sid, title });
    return;
  }
  await currentRepo().appendEvent(sid, "session.renamed", { id: sid, title });
}

/**
 * 会话还叫默认名时，按确定性规则给它起一个。**不调模型。**
 *
 * 跑一次梳理已经要几分钟几美元；给会话起个名不该再花钱，也不该让用户等一次
 * 往返。优先级：材料名 > 第一句话 > 保持默认。
 *
 * 起名失败**不能**把调用方那次操作也拖垮：材料早已装好、这一轮回复早已落库，
 * 为一个装饰性的列丢掉整个 HTTP 响应，用户看到的是"上传失败/回复没了"。所以
 * 这里吞掉异常，但留一条事件说明为什么侧栏上还挂着「新会话」。
 */
export async function autoTitle(
  s: Session,
  opts: { readonly firstText?: string } = {},
): Promise<void> {
  if (!DEFAULT_TITLES.has(normTitle(s.title))) return; // 已经有名字了（自动起的或人改的）
  let title = normTitle(titleFromFiles(s.files) || titleFromText(opts.firstText ?? ""));
  title = cpSlice(title, TITLE_MAX);
  if (!title || title === s.title) return;
  try {
    if (!(await currentRepo().renameSession(s.id, title))) return; // 会话已被删掉
    s.title = title;
    await emitSessionRenamed(s.id, title);
  } catch (exc) {
    // 见上：不许拖垮调用方
    s.emit("session.rename_failed", { error: errText(exc), title });
  }
}

/** Python 的 `str(exc)`。JS 的 Error 没有等价物，取 message；非 Error 走 String()。 */
export function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python 的 `f"{type(exc).__name__}: {exc}"`。 */
export function errTypeAndText(exc: unknown): string {
  const name = exc instanceof Error ? exc.name : typeof exc;
  return `${name}: ${errText(exc)}`;
}

// ══════════════════════════════════════════════════════════════════
//  查询参数与请求体
// ══════════════════════════════════════════════════════════════════

/** `purge: bool = False`。pydantic 只认那两组字面量，其余 422 —— 不能把
 * `purge=maybe` 悄悄当成 false，那会让一次"彻底删除"变成"只从列表移除"。
 *
 * 解析与 422 载荷都走 `http422.ts`：那边**不 trim**（`?purge=%20true%20` 在
 * Python 侧是 422），载荷是 pydantic 的错误数组而不是一句话。 */
export function boolQuery(raw: string | undefined, dflt: boolean, name = "purge"): boolean {
  if (raw === undefined) return dflt;
  const v = pydanticBool(raw);
  if (v === null) raise422(boolParsingError(["query", name], raw));
  return v;
}

/** FastAPI 的 `body: dict[str, Any] | None = None`：空体/非对象都当 `{}`。 */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════
//  Engagement 投影
// ══════════════════════════════════════════════════════════════════

/** 把冻结的 FDE Engagement DAG 投影为前端可跟踪的阶段状态。 */
export function engagementView(env: ServerEnv, s: Session): Record<string, unknown> {
  const dag = env.fdeEngagementDag();
  const order = dag.topoOrder();
  const execution =
    s.state["engagement_execution"] !== null &&
    typeof s.state["engagement_execution"] === "object" &&
    !Array.isArray(s.state["engagement_execution"])
      ? (s.state["engagement_execution"] as Record<string, unknown>)
      : {};
  const pendingHuman =
    execution["pendingHuman"] !== null &&
    typeof execution["pendingHuman"] === "object" &&
    !Array.isArray(execution["pendingHuman"])
      ? (execution["pendingHuman"] as Record<string, unknown>)
      : {};
  const suspendedNode = String(pendingHuman["node"] ?? "");
  const current =
    s.status === "awaiting_answer"
      ? order.includes(suspendedNode)
        ? suspendedNode
        : "INTERVIEW"
      : s.status === "done"
        ? "EXPORT"
        : s.status === "idle" || s.status === "stopped" || s.status === "failed"
          ? "INTAKE"
          : "PROCESS";
  const currentIndex = order.indexOf(current);
  const completed = new Set(
    Array.isArray(execution["completed"])
      ? execution["completed"].map((node) => String(node))
      : [],
  );
  const plan: Record<string, unknown>[] = [];
  dag.describe().forEach((node, index) => {
    const state =
      node["id"] === current
        ? "active"
        : completed.has(String(node["id"])) || index < currentIndex
          ? "completed"
          : "pending";
    plan.push({ ...node, state });
  });
  return { version: FDE_CHECKPOINT_VERSION, frozen: dag.frozen, current, plan };
}

/** `{k: v for k, v in s.state.items() if not k.startswith("_")}` —— 私有键不出网。 */
export function publicState(s: Session): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.state)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  路由
// ══════════════════════════════════════════════════════════════════

export function registerSessionRoutes(app: Hono<AppEnv>, env: ServerEnv): void {
  // ── /api/health ────────────────────────────────────────────────
  app.get("/api/health", async (c) => {
    let gateway: Record<string, unknown>;
    try {
      const cfg = env.resolvedLlmConfig(); // 设置 → env → 抛错
      gateway = {
        base_url: cfg.baseUrl,
        key: cfg.redactedKey,
        insecure: cfg.insecureTransport,
      };
    } catch (exc) {
      gateway = { error: errText(exc) };
    }
    const cat = env.newCatalog();
    let db: JsonObject;
    try {
      db = await env.storeHealthcheck();
    } catch (exc) {
      // 健康检查本身不该把 /health 打挂
      db = { mode: "unknown", ok: false, error: errText(exc) };
    }
    return c.json({
      ok: !("error" in gateway),
      gateway,
      database: db,
      models: cat.describe(),
      capabilities: cat.byCapability(),
      skills: env.skillNames(),
    });
  });

  // ── /api/models ────────────────────────────────────────────────
  /** 「工作」模式模型选择器：列出网关**实际可用**的模型（懒发现，回落内置目录）。 */
  app.get("/api/models", async (c) => {
    const cat = await env.ensureCatalog();
    return c.json({ models: cat.describe() });
  });

  // ── 设定会话对话模型 ────────────────────────────────────────────
  /** 空 / 未知则清除，回落到按难度路由。 */
  // ── P4：停掉单个在飞节点 ─────────────────────────────────────
  // run 级 /stop 是全停；这个是外科手术：某个节点跑飞了（转圈不出活、材料
  // 特别脏），点它的停止 —— 协作式取消（P0-1 的信号通道），下一个循环边界
  // 退出，不截断在飞 HTTP。后果走既有语义（节点 NodeFailure 定案），不发明
  // 第三种终态。没有活跃调度器 = 没在跑，409；节点不在飞，404。
  app.post("/api/sessions/:sid/run/nodes/stop", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const sched = activeScheduler(s.id);
    if (sched === null) {
      return c.json({ error: "当前没有在跑的梳理，没有可停的节点" }, 409);
    }
    const body = await jsonBody(c);
    const node = body["node"] ? String(body["node"]) : "";
    if (!node) return c.json({ error: "缺 node" }, 400);
    if (sched.abortNode?.(node) !== true) {
      return c.json({ error: `节点 ${node} 不在飞（可能刚结束）` }, 404);
    }
    s.emit("node.stop_requested", { node });
    return c.json({ stopped: true, node });
  });

  app.post("/api/sessions/:sid/model", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const body = await jsonBody(c);
    return await env.sessionMutation(s, "session.model", async () => {
      // `str((body or {}).get("model") or "")`：0 / "" / null 都归一成空串
      const raw = body["model"];
      const name = raw ? String(raw) : "";
      const cat = await env.ensureCatalog();
      s.state["model"] = name && cat.get(name) ? name : "";
      await env.persist(s, { status: false });
      return c.json({ model: s.state["model"] });
    });
  });

  // ── 会话列表 ───────────────────────────────────────────────────
  /** 会话列表**以库为准**。强制鉴权下只列归属自己的；开放模式保持原行为
   * （合并内存里活着的 + 盘上孤儿目录）。 */
  app.get("/api/sessions", async (c) => {
    const iso = isolate(c);
    const rows = await currentRepo().listSessions(iso ? { owner: ownerId(c) } : {});
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const live = SESSIONS.get(r.id);
      out.push(live !== undefined ? { ...live.brief() } : await coldBrief(r));
    }
    if (iso) {
      // 隔离模式到此为止：只列库里归属自己的会话（每次创建都已落库带 owner）。
      // 不合并"内存里活着但不在结果集"的会话，也不扫孤儿目录 —— 那些会泄露他人
      // 或无归属的会话。
      return c.json(sortByCreatedDesc(out));
    }

    const known = new Set(rows.map((r) => r.id));
    for (const s of SESSIONS.values()) {
      if (!known.has(s.id)) out.push({ ...s.brief() });
    }
    for (const x of out) known.add(String(x["id"]));

    // 盘上的孤儿目录也要列。它们是数据库接上之前建的会话 —— 产物、材料、
    // 事件日志都还在，只是没人认领。不列的话用户看到的是"我的东西没了"，
    // 而磁盘上明明还有 14MB。
    const rootDir = root();
    if (existsSync(rootDir)) {
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        const dir = join(rootDir, entry.name);
        if (!entry.isDirectory() || known.has(entry.name) || existsSync(join(dir, ".deleted"))) {
          continue;
        }
        const arts = readdirSync(dir, { withFileTypes: true })
          .filter((x) => x.isFile())
          .map((x) => x.name);
        const mats = join(dir, "materials");
        out.push({
          id: entry.name,
          title: entry.name,
          project: "",
          // 孤儿目录没有库行，也就没有归属项目 —— 空串即「未归类」。这一条
          // 分支漏了字段的话，前端拿到 undefined 会把它排到"某些会话没有项目"。
          project_id: "",
          // 有产物就是跑完过的。目录里的事实比一个丢掉的状态字段可信。
          status: arts.includes("oir.json") ? "done" : "idle",
          // Python 的 `len(list(mats.iterdir()))` 连子目录也算在内，照搬。
          files: existsSync(mats) ? readdirSync(mats).length : 0,
          created: statSync(dir).mtimeMs / 1000,
          error: "",
          mode: "work",
          orphan: true,
        });
      }
    }
    return c.json(sortByCreatedDesc(out));
  });

  // ── 新建会话 ───────────────────────────────────────────────────
  app.post("/api/sessions", async (c) => {
    const body = await jsonBody(c);
    const rawTitle = body["title"];
    const rawProject = body["project"];
    const s = new Session(shortId(), {
      title: rawTitle ? String(rawTitle) : "新的本体梳理",
      project: rawProject === undefined || rawProject === null ? "" : String(rawProject),
    });
    // 聊天 / 工作 双模式：chat = 纯对话（只读工具、无梳理管线），work = 完整工作台。
    const mode = body["mode"];
    s.state["mode"] = mode === "work" || mode === "chat" ? mode : "work";
    mkdirSync(s.dir, { recursive: true });
    s.owner = ownerId(c); // 用量流水按账号记
    SESSIONS.set(s.id, s);
    let createdRow = false;
    try {
      await currentRepo().createSession(
        makeSessionRow({
          id: s.id,
          title: s.title,
          project: s.project,
          status: s.status,
          error: "",
          created: s.created,
          state_version: 0,
          owner: s.owner,
        }),
      );
      createdRow = true;
      await env.persist(s, { status: false }); // 把 mode 落下来，重载前就存在
      return c.json(s.brief());
    } catch (exc) {
      SESSIONS.delete(s.id);
      if (createdRow) await currentRepo().deleteSession(s.id);
      // A failed create is not a user asset yet.  Leaving the directory behind
      // makes the orphan scanner resurrect a session that never committed.
      if (existsSync(s.dir)) rmSync(s.dir, { recursive: true, force: true });
      throw exc;
    }
  });

  // ── 删会话 ─────────────────────────────────────────────────────
  /**
   * `purge` 连 `workspace/<sid>/` 一起删。默认 **false** —— 产物、事件日志、
   * 原始材料都在那儿，"从列表里去掉"和"把东西删了"是两件事，后者要用户明确说。
   */
  app.delete("/api/sessions/:sid", async (c) => {
    const sid = c.req.param("sid");
    const purge = boolQuery(c.req.query("purge"), false);
    // A normal persisted session is deleted under the same cross-worker mutation
    // lease as every other structural write.  Otherwise a remote build can claim the
    // session between this route's read and `deleteSession` and keep writing files
    // after the user has removed the project.  Legacy orphan directories have no row
    // (and therefore no lease target), so preserve the old direct cleanup path.
    const row = await currentRepo().getSession(sid);
    if (row !== null) {
      const s = await sessAsync(sid);
      return await env.sessionMutation(s, "session.delete", async () =>
        c.json(await deleteSessionOnce(sid, purge)),
      );
    }
    return c.json(await deleteSessionOnce(sid, purge));
  });

  // ── 改标题 / 改归属项目 ────────────────────────────────────────
  /**
   * `project_id` 落的是 `session.project_id` 这一列，不是 `session.project`
   * （那是印在 xlsx 和交付包文件名上的客户项目名，改它会改产物内容）。
   * 传 `null` 或空串都是移出项目。
   *
   * 走的是仓储的 `renameSession` / `assignSession` 而不是 `persist` ——
   * 后者只写 session_state 文档，从来不写会话表的元数据列。也因此这里不占
   * mutation 租约：改的列与梳理管线写的东西完全不相干，不存在要串行的冲突。
   */
  app.patch("/api/sessions/:sid", async (c) => {
    const sid = c.req.param("sid");
    const body = await jsonBody(c);
    if (!("title" in body) && !("project_id" in body)) {
      throw apiError(400, "没有可改的字段");
    }
    const row = await currentRepo().getSession(sid);
    if (row === null) throw apiError(404, `没有会话 ${sid}`);
    // **故意不 sessAsync**：那会把冷会话整个恢复一遍（重解析全部材料、发一条
    // session.restored）。在侧栏里改个名字、把会话拖进一个文件夹都不该付这个
    // 代价，而这里要改的列也不需要任何领域状态。
    const live = SESSIONS.get(sid);
    let patched = row;

    if ("title" in body) {
      const title = normTitle(body["title"]);
      if (!title) {
        // 空标题会让侧栏出现一行看不见的会话 —— 比留着「新会话」更难认。
        throw apiError(400, "标题不能为空");
      }
      // 长度按**码点**算，与 `_norm_title` 之后的 `len(title)` 一致
      if ([...title].length > TITLE_MAX) {
        throw apiError(400, `标题不能超过 ${TITLE_MAX} 个字符`);
      }
      if (!(await currentRepo().renameSession(sid, title))) {
        throw apiError(404, `没有会话 ${sid}`);
      }
      // Python 直接改 `row.title`（dataclass 可变）；TS 的 SessionRow 是 readonly，
      // 所以换一份新快照 —— 返回值只看这一份，语义等价。
      patched = { ...patched, title };
      if (live !== undefined) live.title = title;
      await emitSessionRenamed(sid, title);
    }

    if ("project_id" in body) {
      const raw = body["project_id"];
      const pid = raw === null || raw === undefined ? "" : String(raw).trim();
      const modeRaw =
        live !== undefined
          ? live.state["mode"]
          : (await currentRepo().loadState(sid, { keys: ["mode"] }))["mode"];
      const mode = (modeRaw as string | undefined) || "work";
      if (pid && mode === "chat") {
        // R5：聊天会话不进项目。聊天里没有梳理、没有产物，把它塞进项目只会让
        // 项目记忆混进一堆闲聊得来的"教训"。
        throw apiError(400, "聊天会话不能归入项目");
      }
      if (pid) {
        // 归属校验：中间件只认路径里的 sid/pid，请求**体**里的项目 id 它管不着。
        // 不查的话，甲可以把自己的会话塞进乙的项目，从而读到乙的项目记忆。
        const proj = await currentRepo().getProject(pid);
        if (proj === null || (isolate(c) && (proj.owner || "") !== ownerId(c))) {
          throw apiError(404, `没有项目 ${pid}`);
        }
      }
      if (!(await currentRepo().assignSession(sid, pid || null))) {
        throw apiError(404, `没有会话 ${sid}`);
      }
      patched = { ...patched, project_id: pid };
      if (live !== undefined) live.projectId = pid;
    }

    return c.json(live !== undefined ? live.brief() : await coldBrief(patched));
  });

  // ── 聊天会话转工作会话 ─────────────────────────────────────────
  /**
   * 把一个聊天会话转成工作会话：把聊天里传的文件带过去，在那边正式梳理。
   *
   * 聊天只对话、不梳理；真要抽本体/出流程图，转成工作会话即可 —— 文件跟着走，
   * 不用重新上传。
   */
  app.post("/api/sessions/:sid/to_work", async (c) => {
    const src = await sessAsync(c.req.param("sid"));
    return await env.sessionMutation(src, "session.to_work", async () =>
      c.json(await toWorkOnce(env, src, c)),
    );
  });

  // ── 会话全量状态 ───────────────────────────────────────────────
  /**
   * `filelist` 必须一并返回 —— 只给数量的话，重新打开一个会话时前端就没法
   * 渲染材料列表，"点回原文"这条路直接断掉。
   */
  app.get("/api/sessions/:sid/state", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    // 幽灵跑批复查：进程重启会留下 status=parsing 而任务已死，而回收器此前只在
    // 启动对账与首次 hydrate 各跑一次 —— 租约在那之后过期就再没人管，界面会一直
    // 显示「解析中」（实测挂了 54 分钟）。这是最高频的状态读，复查放这里最省事。
    await reapZombieBuild(s, currentRepo(), () => Date.now() / 1000);
    await refreshFilesProjection(s);
    const pub = publicState(s);
    const dm = s.state["_dialogue"] as DialogueLike | null | undefined;
    if (dm !== undefined && dm !== null) {
      pub["dialogue"] = dm.toDict();
      pub["decisions"] = dm.activeDecisions().map((d) => d.toDict());
    }
    pub["engagement"] = engagementView(env, s);
    const names = s.files.map((f) => f.name);
    // 每份材料的**解析状态**要跟着回去。只给名字和大小的话，界面上没有任何地方
    // 能回答"这份读进来了没有" —— 用户只能去问助手，而助手（在工具回执含糊时）
    // 会猜。状态是事实，应该看得见，不该靠问。
    return c.json({
      ...s.brief(),
      // **会话状态版本必须回给前端。** 右栏的 /context 拉取依赖它作为
      // useEffect 的 dep（context-region.tsx），不回的话它永远是 undefined ——
      // 于是 /context 只在进会话时取一次，之后改了本体、跑完梳理、编辑了流程图，
      // 右栏都纹丝不动，用户只能手动刷新页面。而他刚刚明明看见系统说改好了。
      //
      // 不加进 brief()：那是被 golden 钉着的前端契约（server.core.json 的
      // session_brief），修一个刷新 bug 不该顺带改它的形状。
      state_version: s.stateVersion,
      filelist: materialFileList(s),
      state: pub,
      events: s.events.length,
      // 一个空白输入框对新用户是最不友好的界面 —— 他知道这工具能分析
      // 业务文档，但不知道该说什么才有用。
      prompts: openingPrompts({ state: pub, files: names, status: s.status }),
      // 上一轮那批追问也要还回去。它以前只活在前端内存里，于是**每次重开
      // 会话、每次刷新，chips 就永久消失** —— 恰恰是"接着上次干"的时候。
      followups: s.state["followups"] ?? [],
    });
  });
}

/** `/state` 只读 `_dialogue` 的这两个方法。 */
interface DialogueLike {
  toDict(): unknown;
  activeDecisions(): readonly { toDict(): unknown }[];
}

/** `sorted(out, key=lambda x: -x["created"])`。JS 的 sort 自 ES2019 起稳定，
 * 与 Python 的 sorted 一致，所以 created 相同的两条保持原顺序。 */
function sortByCreatedDesc(out: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...out].sort((a, b) => Number(b["created"]) - Number(a["created"]));
}

/** `uuid.uuid4().hex[:12]`。 */
export function shortId(): string {
  return randomUUID().replace(/-/gu, "").slice(0, 12);
}

/** Delete a session after the caller has fenced concurrent mutations. */
export async function deleteSessionOnce(
  sid: string,
  purge: boolean,
): Promise<Record<string, unknown>> {
  // Cancel pending opens first, then close every isolated Chromium context for this session.  TTL
  // remains a leak backstop, not the normal deletion path.
  await liveBrowserRuntime.closeSession(sid);
  const existed = await currentRepo().deleteSession(sid);
  const live = SESSIONS.get(sid) ?? null;
  SESSIONS.delete(sid);
  if (live !== null) {
    // 断开订阅者，否则 SSE 会一直挂着
    for (const q of [...live.subscribers]) q.putNowait({ seq: -1, kind: "session.deleted" });
    live.subscribers.length = 0;
  }
  let removed = false;
  const d = join(root(), sid);
  if (!purge && existsSync(d)) {
    // 只从列表移除、产物留着 —— 但目录还在，孤儿扫描会把它再捡回来。
    // 留一个标记：目录是用户的资产，"已删除"是我们的状态，两者要能共存。
    writeFileSync(join(d, ".deleted"), String(Date.now() / 1000), { encoding: "utf-8" });
  }
  if (purge && existsSync(d)) {
    rmSync(d, { recursive: true, force: true });
    removed = true;
  }
  if (!existed && live === null && !removed) throw apiError(404, `没有会话 ${sid}`);
  return { deleted: sid, purged: removed };
}

/** Copy one stable source snapshot into a new work session. */
export async function toWorkOnce(
  env: ServerEnv,
  src: Session,
  c: Context<AppEnv>,
): Promise<Record<string, unknown>> {
  const ws = new Session(shortId(), {
    // `str.replace` 在 Python 里换掉**所有**出现，JS 的 `replace` 只换第一个
    title: `${src.title.replaceAll("对话", "").trim() || "梳理"}（自聊天）`,
  });
  ws.state["mode"] = "work";
  ws.owner = ownerId(c);
  let createdRow = false;
  try {
    // Python 是 `mkdir(parents=True, exist_ok=False)`：id 撞了要当场炸，不能往
    // 别人的目录里写。Node 的 `recursive: true` 对已存在的目录**不报错**，这个
    // 判断因此必须自己补 —— 少了它，一次 id 碰撞会静默污染另一个会话的工作区。
    if (existsSync(ws.dir)) throw apiError(500, `目录已存在: ${ws.dir}`);
    mkdirSync(ws.dir, { recursive: true });
    const srcMats = join(src.dir, "materials");
    if (existsSync(srcMats)) {
      const dstMats = join(ws.dir, "materials");
      mkdirSync(dstMats, { recursive: true });
      // `sorted(src_mats.iterdir())`：拷贝顺序要确定 —— files 的顺序会影响自动命名
      for (const name of readdirSync(srcMats).sort()) {
        const p = join(srcMats, name);
        if (!statSync(p).isFile()) continue;
        const dst = join(dstMats, name);
        copyFileSync(p, dst);
        ws.files.push({
          name,
          size: statSync(dst).size,
          path: dst,
          sha256: sha256Hex(readFileSync(dst)),
        });
      }
    }
    SESSIONS.set(ws.id, ws);
    // project 硬写空串是原样保留的老行为（那是印在产物上的客户项目名，聊天
    // 会话上本来就没有）。project_id 则跟着源会话走 —— 聊天会话按 R5 恒为空，
    // 所以今天它总是 ""；写成常量的话，哪天聊天真的能归项目，这里会静默把它
    // 丢掉，而表现只是"转工作后会话跑到未归类去了"。
    ws.projectId = src.projectId;
    await currentRepo().createSession(
      makeSessionRow({
        id: ws.id,
        title: ws.title,
        project: "",
        status: ws.status,
        error: "",
        created: ws.created,
        state_version: 0,
        owner: ws.owner,
        project_id: ws.projectId,
      }),
    );
    createdRow = true;
    if (ws.files.length > 0) {
      await currentRepo().addFiles(ws.id, ws.files.map(fileRowOf));
      await env.preparse(ws);
    }
    await env.persist(ws, { status: false });
    return { id: ws.id, files: ws.files.length };
  } catch (exc) {
    SESSIONS.delete(ws.id);
    if (createdRow) await currentRepo().deleteSession(ws.id);
    if (existsSync(ws.dir)) rmSync(ws.dir, { recursive: true, force: true });
    throw exc;
  }
}

/** `FileRow(name=…, rel_path=str(Path(path).relative_to(ROOT)), …)`。 */
export function fileRowOf(f: SessionFile): FileRow {
  return makeFileRow({
    name: f.name,
    rel_path: relativeToRoot(root(), f.path),
    size: f.size,
    sha256: f.sha256 ?? "",
  });
}

/** `Path.relative_to(ROOT)`：不在 ROOT 之下就**抛错**，不像 `path.relative` 那样
 * 悄悄回一串 `../` —— 那会让库里的 rel_path 变成能逃出 workspace 的路径。 */
export function relativeToRoot(rootDir: string, abs: string): string {
  const base = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  if (!abs.startsWith(base)) throw apiError(500, `${abs} 不在 workspace ${rootDir} 之下`);
  return abs.slice(base.length);
}
