/**
 * 鉴权门禁 —— 中间件、cookie 会话解析、登录/账号路由。移植自 `authgate.py`。
 *
 * 与 `auth.ts`（纯散列/令牌原语）分工：本模块是 Web 层，接 Hono。
 *
 * **门禁纪律（fail-closed）**：
 *   * `ONTOCOPILOT_AUTH` 真值 **或** 库里已存在任何账号 ⇒ 强制鉴权。
 *     "建过账号却没鉴权"这种状态不可能出现 —— 一旦有人存在，门就永远是关的。
 *   * 两者都不满足（全新实例、零账号）⇒ 开放模式，注入一个合成管理员，
 *     行为与加鉴权之前**完全一致**，本地零配置可用；启动时打一条醒目告警。
 *   * 首个管理员**只能用宿主机 CLI**（`ontocopilot useradd --admin`）创建 ——
 *     没有公开的 bootstrap 路由，杜绝"谁先访问谁当管理员"的抢注竞态。
 *
 * **SSE**：`EventSource` 发不了 Authorization 头，但会自动带上同源 cookie，
 * 所以 `/stream` 走 cookie、无需任何特殊处理。
 *
 * **scrypt 不能卡事件循环**：登录/建号里的散列一律走 `auth.ts` 的 `*Async` 版
 * （`crypto.scrypt` 的回调形态跑在 libuv 线程池里），== Python 的
 * `run_in_threadpool`。同步版一旦用在路由里，几十毫秒的 scrypt 会把整个事件
 * 循环连同所有 SSE 流一起冻住。
 *
 * ── 与 Python 侧的形态差异（行为等价，字节不同）────────────────────────────
 *
 * 1. **Set-Cookie 的属性顺序**。Starlette 走 `http.cookies.SimpleCookie`，属性按
 *    字母序输出（`HttpOnly; Max-Age=…; Path=/; SameSite=lax`）；Hono 的
 *    `setCookie` 有自己的顺序。cookie 属性与顺序无关，浏览器行为一致。
 * 2. **`delete_cookie` 的字节**。Starlette 写 `oc_auth=""; expires=Thu, 01 Jan 1970
 *    …; Max-Age=0; Path=/`，Hono 的 `deleteCookie` 写等效的 `Max-Age=0` 形态。
 * 3. **请求体不是 JSON 对象时的 422 载荷**。FastAPI 给的是 pydantic 的结构化
 *    错误数组，这里给一句话。前端从来不构造这种请求，所以不值得复刻那套形状。
 */

import { Hono } from "hono";
import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { randomUUID } from "node:crypto";

import {
  hashPasswordAsync,
  mintToken,
  normalizeUsername,
  tokenHash,
  verifyPasswordAsync,
} from "./auth.js";
import { getRepo as getRepoFromDeps } from "./store/deps.js";
import type { Repo } from "./store/repo/protocol.js";
import { DuplicateUsername, makeAuthSessionRow, makeUserRow, userPublic } from "./store/types.js";
import type { JsonObject, JsonValue, UserRow } from "./store/types.js";

export const COOKIE = "oc_auth";

/** 开放模式下注入的合成管理员。password_hash 为空 —— 它永远不会走登录校验。 */
export const SYNTHETIC_ADMIN: UserRow = makeUserRow({
  id: "__local__",
  username: "local",
  password_hash: "",
  role: "admin",
  active: true,
});

/** 登录失败也要跑一次散列，抹平"用户存在与否"的时间差（防用户名枚举）。 */
const DUMMY_HASH_CACHE: string[] = [];

async function dummyHash(): Promise<string> {
  const cached = DUMMY_HASH_CACHE[0];
  if (cached !== undefined) return cached;
  const made = await hashPasswordAsync("timing-equalizer-not-a-real-password");
  // 并发登录可能同时算出两个 —— 谁先谁后无所谓，它只是个耗时占位。
  DUMMY_HASH_CACHE[0] ??= made;
  return DUMMY_HASH_CACHE[0];
}

// ── 环境读取 ──────────────────────────────────────────────────────

function truthy(v: string | undefined | null): boolean {
  // Python: `bool(v) and v.strip().lower() not in ("", "0", "false", "no", "off")`
  if (!v) return false;
  return !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

/** 导出给测试与 golden 对照用（Python 侧是模块私有的 `_truthy`）。 */
export { truthy as envTruthy };

export function authForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env["ONTOCOPILOT_AUTH"]);
}

/** http 上置 Secure 会让浏览器**静默丢弃** cookie → 死循环登录。默认关，
 * 只有在 HTTPS 后面才显式开。 */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env["ONTOCOPILOT_COOKIE_SECURE"]);
}

export function sessionTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return pyInt(env["ONTOCOPILOT_SESSION_TTL_HOURS"] ?? "168") * 3600;
}

/** Python 的 `int(str)`：配错了要当场炸，不是悄悄回落到默认值。 */
function pyInt(raw: string): number {
  const s = raw.trim();
  if (!/^[+-]?\d(_?\d)*$/.test(s)) {
    throw new Error(`invalid literal for int() with base 10: '${raw}'`);
  }
  return Number(s.replaceAll("_", ""));
}

export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["ONTOCOPILOT_CORS_ORIGINS"] ?? "";
  // 带凭证时禁止通配 —— 浏览器也禁，这里显式挡掉误配的 "*"/空串。
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "" && o !== "*");
}

/** 把开放模式下建的会话认领给这个（首个）账号，返回认领了几个。
 *
 * **建第一个账号会顺带把整个实例翻进强制鉴权**（见 {@link enforce}：有账号就
 * 强制）。而开放模式下建的每个会话，归属记的都是合成管理员 `__local__` ——
 * 一旦强制，列表按真实 user id 过滤、中间件对不属于你的会话回 404，于是**他
 * 昨天梳理的全部东西在建号的那一秒集体消失**。从用户视角这就是数据没了，而且
 * 是他自己点了"创建账户"之后没的。
 *
 * 两条建号路径都要走这里：`POST /api/register` 和 `ontocopilot useradd`。
 * 只在其中一条上做，另一条就成了"照文档操作，然后数据全丢"。
 *
 * **项目要和会话一起认领。** 只认领会话的话，会话都还在，但项目按 owner 过滤后
 * 一个都列不出来，于是它们全部掉回「未归类」—— 用户看到的是"文件夹没了、会话
 * 散了一屏"。这和上面那个失败模式是同一件事，只是少丢一层。 */
export async function adoptLocalSessions(repo: Repo, user: UserRow): Promise<number> {
  let n = 0;
  for (const old of [SYNTHETIC_ADMIN.id, ""]) {
    n += await repo.reassignSessions(old, user.id);
    await repo.reassignProjects(old, user.id);
  }
  return n;
}

/** 是否强制鉴权：显式开关 or 已有账号。 */
export async function enforce(repo: Repo): Promise<boolean> {
  if (authForced()) return true;
  return (await repo.countUsers()) > 0;
}

// ── cookie → 用户 ─────────────────────────────────────────────────

/** 按 cookie 解析当前用户；令牌缺失/过期/账号停用一律返回 `null`。 */
export async function resolveCookieUser(c: Context, repo: Repo): Promise<UserRow | null> {
  const tok = getCookie(c, COOKIE);
  if (!tok) return null;
  // 库里存的是令牌的 sha256，不是令牌本身 —— 库泄了也换不出 cookie。
  const sess = await repo.getAuthSession(tokenHash(tok));
  if (sess === null || (sess.expires && sess.expires <= Date.now() / 1000)) return null;
  const user = await repo.getUser(sess.user_id);
  if (user === null || !user.active) return null; // 停用即时失效，不等 cookie 过期
  return user;
}

const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/api/health",
  "/api/login",
  "/api/register",
  "/api/auth/status",
]);

function isPublic(method: string, path: string): boolean {
  if (method === "OPTIONS") return true; // CORS 预检放行
  return PUBLIC_PATHS.has(path);
}

/** 从 `/api/sessions/<sid>[/...]` 里取出 sid；列表/创建路由（无 sid）返回 `null`。 */
export function sessionSid(path: string): string | null {
  const prefix = "/api/sessions/";
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split("/", 1)[0] || null;
}

/** 从 `/api/projects/<pid>[/...]` 里取出 pid；列表/创建路由（无 pid）返回 `null`。 */
export function projectPid(path: string): string | null {
  const prefix = "/api/projects/";
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split("/", 1)[0] || null;
}

// ── Hono 接线 ─────────────────────────────────────────────────────

/** 中间件把当前用户挂在这里（== Python 的 `request.state.user`）。 */
export interface AuthEnv {
  Variables: {
    user: UserRow | null;
  };
}

export type AuthContext = Context<AuthEnv>;
export type RepoGetter = () => Repo;

/** 默认从 `store/deps.ts` 的进程级单例拿。deps 里 `Repo` 还是占位类型
 * （`object`，等 repo track 把 `registerRepoBuilder` 接上），所以这里下转一次。 */
export const defaultRepoGetter: RepoGetter = () => getRepoFromDeps() as Repo;

/** FastAPI `HTTPException(status, detail)` 的对等物：载荷是 `{"detail": …}`，
 * content-type 是 `application/json`，与 FastAPI 的默认异常处理器一致。
 *
 * 直接把 `res` 塞进 `HTTPException`，这样**不依赖 app 装了哪个 onError** ——
 * Hono 的默认处理器对 HTTPException 就是原样返回 `getResponse()`。 */
export function httpError(status: ContentfulStatusCode, detail: string): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ detail }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

/** 一道 fail-closed 门。解析用户挂到 `c.set("user", …)`，并按账号隔离会话。 */
export function authMiddleware(repoOf: RepoGetter = defaultRepoGetter): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const repo = repoOf();
    if (!(await enforce(repo))) {
      c.set("user", SYNTHETIC_ADMIN); // 开放模式：不鉴权、不隔离（同今日行为）
      await next();
      return;
    }

    // 强制模式：总是先尝试解析 cookie（allowlist 也解析，好让 /auth/status 知道身份）
    const user = await resolveCookieUser(c, repo);
    c.set("user", user);
    const path = c.req.path;
    if (isPublic(c.req.method, path)) {
      await next();
      return;
    }
    if (user === null) {
      return c.json({ error: "未登录", code: "auth.required" }, 401);
    }

    // 按账号隔离：访问具体会话必须是**本人**的。不存在 / 无归属 / 他人的会话一律当作
    // "不存在"（404）—— 不泄露"这个 id 存在但不是你的"。集中在这里做，避免逐个改
    // 十几条会话路由。
    const sid = sessionSid(path);
    if (sid !== null) {
      const row = await repo.getSession(sid);
      if (row === null || row.owner !== user.id) {
        return c.json({ error: "会话不存在", code: "session.not_found" }, 404);
      }
    }

    // 项目同理，而且**必须在这里做**：`/api/projects/...` 不在上面那个前缀下，
    // 光靠会话那条判断的话，任何登录用户都能改名/删掉别人的项目文件夹（连带删掉
    // 别人的项目记忆）。列表/创建路由没有 pid，归属在路由里按 owner 过滤/写入。
    const pid = projectPid(path);
    if (pid !== null) {
      const proj = await repo.getProject(pid);
      if (proj === null || (proj.owner || "") !== user.id) {
        return c.json({ error: "项目不存在", code: "project.not_found" }, 404);
      }
    }
    await next();
    return;
  };
}

// ── 依赖 ─────────────────────────────────────────────────────────

export function requireUser(c: AuthContext): UserRow {
  const user = c.get("user");
  if (user === null || user === undefined) throw httpError(401, "未登录");
  return user;
}

export function requireAdmin(c: AuthContext): UserRow {
  const user = requireUser(c);
  if (user.role !== "admin") throw httpError(403, "需要管理员权限");
  return user;
}

// ── cookie 读写 ──────────────────────────────────────────────────

function setAuthCookie(c: AuthContext, token: string): void {
  setCookie(c, COOKIE, token, {
    maxAge: sessionTtlSeconds(),
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
  });
}

function clearAuthCookie(c: AuthContext): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

/** 名字的长度上限（按码点算，一个汉字算一个）。够写全名和「张伟（采购）」这类备注，
 * 又不至于把界面撑破 —— 它会出现在空状态问候语和账号列表里。 */
const DISPLAY_NAME_MAX = 40;

/** Python `str.split()` 的空白集（`Py_UNICODE_ISSPACE`）。**不能用 JS 的 `\s`**：
 * 它少了 `\x1c`–`\x1f` / `\x85`，多了 `﻿`。名字里真出现过带 `\x85` 的粘贴内容。 */
const PY_WHITESPACE =
  /[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** 规整用户填的名字。
 *
 * **不复用 normalizeUsername** —— 那个做 `strip().lower()`，会把「Yuhan」变成
 * 「yuhan」，而这一列存在的全部意义就是原样称呼人。这里只折叠空白（含换行与
 * 制表符：带 `\n` 的名字会撑破账号列表的一行），两端去空。
 *
 * 空串是合法结果 = 没填。要不要允许没填由**调用方**决定：自助注册要求填，
 * 管理员建号和 CLI 不要求。 */
export function cleanDisplayName(raw: unknown): string {
  // Python 是 `str(raw or "")`：假值一律成空串。非字符串的真值走 str()，
  // 而前端只会送字符串，所以这里用 String() 折平就够。
  const s = raw ? String(raw) : "";
  const name = s.split(PY_WHITESPACE).filter((x) => x !== "").join(" ");
  // len() 按码点算，一个汉字/emoji 算一个。
  if ([...name].length > DISPLAY_NAME_MAX) {
    throw httpError(400, `名字不能超过 ${DISPLAY_NAME_MAX} 个字`);
  }
  return name;
}

// ── 登录限流（进程内、按 IP、固定窗口）──────────────────────────────

const ATTEMPTS = new Map<string, [number, number]>();
const THROTTLE_MAX = 10;
const THROTTLE_WINDOW = 60.0;

/** 只给测试用 —— 模块级状态跨用例会互相污染。 */
export function resetLoginThrottle(): void {
  ATTEMPTS.clear();
}

/** Python 是 `request.client.host if request.client else "?"`。Node 侧连接信息挂在
 * `c.env.incoming` 上；`app.request()`（单元测试）没有这一层，回落到 `"?"`。 */
function clientIp(c: AuthContext): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "?";
}

function throttle(c: AuthContext): void {
  const ip = clientIp(c);
  const now = Date.now() / 1000;
  let [start, n] = ATTEMPTS.get(ip) ?? [now, 0];
  if (now - start > THROTTLE_WINDOW) {
    start = now;
    n = 0;
  }
  n += 1;
  ATTEMPTS.set(ip, [start, n]);
  if (n > THROTTLE_MAX) throw httpError(429, "尝试过于频繁，请稍后再试");
}

// ── 请求体 ────────────────────────────────────────────────────────

/** FastAPI 的 `body: dict`。不是 JSON 对象就 422（载荷形状见文件头第 3 条）。 */
async function readBody(c: AuthContext): Promise<Record<string, JsonValue>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw httpError(422, "请求体必须是 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(422, "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, JsonValue>;
}

/** `str(body.get(k, ""))` —— Python 对 None 给 `"None"`，对数字给十进制串。
 * 前端只送字符串，所以这里只需保证"缺失/null 都不会变成 'None' 那种脏值"。 */
function bodyStr(body: Record<string, JsonValue>, key: string): string {
  const v = body[key];
  return v === undefined || v === null ? "" : typeof v === "string" ? v : String(v);
}

// ══════════════════════════════════════════════════════════════════
//  路由：登录 / 登出 / 我是谁 / 门禁状态
// ══════════════════════════════════════════════════════════════════

/** 对应 Python 的 `router = APIRouter(prefix="/api")`。这里路径写全，
 * 挂载方式是 `app.route("/", authRouter())` —— 前缀写死在路径里，
 * 谁都不可能在挂载时把 `/api` 挂丢。 */
export function authRouter(repoOf: RepoGetter = defaultRepoGetter): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();

  r.post("/api/login", async (c) => {
    throttle(c);
    const repo = repoOf();
    const body = await readBody(c);
    const username = normalizeUsername(bodyStr(body, "username"));
    const password = bodyStr(body, "password");
    const user = await repo.getUserByUsername(username);
    // 无论用户是否存在都跑一次散列，抹平时间差。
    const ok = await verifyPasswordAsync(password, user ? user.password_hash : await dummyHash());
    // 用户不存在 / 密码错 / 账号停用 —— 一律同一句 401，不泄露账号是否存在或被停用。
    if (user === null || !ok || !user.active) throw httpError(401, "用户名或密码错误");
    const [token, th] = mintToken();
    await repo.createAuthSession(
      makeAuthSessionRow({
        token_hash: th,
        user_id: user.id,
        expires: Date.now() / 1000 + sessionTtlSeconds(),
      }),
    );
    setAuthCookie(c, token);
    return c.json({ user: userPublic(user) });
  });

  /** 自助注册。**首个注册的账号自动成为管理员**（可改网关/全局配置），其余为普通
   * 用户。开放注册：任何人都能建号（联网部署请自行评估是否加邀请码）。 */
  r.post("/api/register", async (c) => {
    throttle(c);
    const repo = repoOf();
    const body = await readBody(c);
    const username = normalizeUsername(bodyStr(body, "username"));
    const password = bodyStr(body, "password");
    // 自助注册**要求填名字**：界面要拿它称呼人（"欢迎回来，程宇涵"），
    // 而 username 是被 lower() 过的登录标识，不适合当称呼。
    // 管理员建号 / CLI 建号仍可不填 —— 那两条路上没人当场问得到。
    const displayName = cleanDisplayName(body["display_name"] ?? "");
    if (!username || !password) throw httpError(400, "用户名和密码不能为空");
    if (!displayName) throw httpError(400, "请填写你的名字");
    // 长度按码点算，与 clean_display_name 同一把尺子。
    if ([...password].length < 6) throw httpError(400, "密码至少 6 位");
    // 库里还没有账号 → 这个人就是管理员。有 TOCTOU 窗口（两人同时抢首个），
    // 单进程下概率极低，且最坏结果只是多一个管理员，可接受。
    const role = (await repo.countUsers()) === 0 ? "admin" : "user";
    const ph = await hashPasswordAsync(password);
    let user: UserRow;
    try {
      user = await repo.createUser(
        makeUserRow({
          id: randomUUID().replaceAll("-", ""),
          username,
          password_hash: ph,
          role,
          display_name: displayName,
        }),
      );
    } catch (e) {
      if (e instanceof DuplicateUsername) throw httpError(409, "用户名已存在");
      throw e;
    }
    const adopted = role === "admin" ? await adoptLocalSessions(repo, user) : 0;

    const [token, th] = mintToken();
    await repo.createAuthSession(
      makeAuthSessionRow({
        token_hash: th,
        user_id: user.id,
        expires: Date.now() / 1000 + sessionTtlSeconds(),
      }),
    );
    setAuthCookie(c, token); // 注册即登录
    return c.json({ user: userPublic(user), adopted_sessions: adopted });
  });

  r.post("/api/logout", async (c) => {
    const repo = repoOf();
    const tok = getCookie(c, COOKIE);
    if (tok) await repo.deleteAuthSession(tokenHash(tok));
    clearAuthCookie(c);
    return c.json({ ok: true });
  });

  r.get("/api/me", (c) => {
    const user = requireUser(c);
    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
      active: user.active,
      prefs: user.prefs,
      display_name: user.display_name,
    });
  });

  r.get("/api/auth/status", async (c) => {
    const repo = repoOf();
    const enforced = await enforce(repo);
    const user = c.get("user") ?? null;
    const n = await repo.countUsers();
    return c.json({
      auth_enabled: enforced,
      // 开放自助注册：前端在登录页始终提供"注册"。零账号时首个注册者即管理员。
      registration_open: true,
      first_user_is_admin: enforced && n === 0,
      authenticated: user !== null,
      // 前端唯一无条件调用的身份端点就是这里 —— 空状态那句问候语的名字只能从
      // 这个投影拿到。漏了 display_name 的表现是：库里存着、界面上永远空白。
      user:
        user !== null
          ? {
              id: user.id,
              username: user.username,
              role: user.role,
              prefs: user.prefs,
              display_name: user.display_name,
            }
          : null,
    });
  });

  r.post("/api/me/password", async (c) => {
    const repo = repoOf();
    const user = requireUser(c);
    if (user.id === SYNTHETIC_ADMIN.id) throw httpError(400, "开放模式下没有可改的账号");
    const body = await readBody(c);
    const old = bodyStr(body, "old");
    const next = bodyStr(body, "new");
    if (!next) throw httpError(400, "新密码不能为空");
    if (!(await verifyPasswordAsync(old, user.password_hash))) throw httpError(403, "原密码不正确");
    const ph = await hashPasswordAsync(next);
    await repo.updateUser(user.id, { passwordHash: ph });
    // 踢掉本人其它登录会话（当前这条一并作废，前端会重新登录）。
    await repo.deleteUserAuthSessions(user.id);
    clearAuthCookie(c);
    return c.json({ ok: true });
  });

  /** 改自己的个人资料。目前只有名字。
   *
   * **账号是账号，资料是资料**：username 是登录标识，改了会影响登录，这里不碰；
   * 名字只是个称呼，随时可改，改完立刻反映在界面上（问候语、左下角、头像首字）。
   *
   * 和改密码不同，这里**不踢登录会话** —— 换个称呼不是安全事件。 */
  r.post("/api/me/profile", async (c) => {
    const repo = repoOf();
    const user = requireUser(c);
    if (user.id === SYNTHETIC_ADMIN.id) throw httpError(400, "开放模式下没有可改的账号");
    const body = await readBody(c);
    const displayName = cleanDisplayName(body["display_name"] ?? "");
    if (!displayName) throw httpError(400, "请填写你的名字");
    const updated = await repo.updateUser(user.id, { displayName });
    if (updated === null) throw httpError(404, "账号不存在");
    return c.json({ user: userPublic(updated) });
  });

  r.patch("/api/me/prefs", async (c) => {
    const repo = repoOf();
    const user = requireUser(c);
    const body = await readBody(c);
    const patch: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(body)) if (PREF_KEYS.has(k)) patch[k] = v;
    const tz = patch["timezone"];
    if (tz) {
      // 非法 IANA 时区会让前端 Intl 抛错 —— 这里先替它抛，别等到界面上才炸。
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: String(tz) });
      } catch {
        throw httpError(400, `未知时区：${String(tz)}`);
      }
    }
    if (user.id === SYNTHETIC_ADMIN.id) {
      // `JsonValue` 是递归类型，直接喂给 c.json 会把 Hono 的类型实例化撑爆
      // （TS2589）。这里退回 unknown —— 线上字节不变。
      return c.json({ prefs: patch } as Record<string, unknown>);
    }
    const merged: JsonObject = { ...user.prefs, ...patch };
    await repo.updateUser(user.id, { prefs: merged });
    return c.json({ prefs: merged } as Record<string, unknown>);
  });

  return r;
}

/** 允许自助保存的外观/语言偏好键。其它键一律忽略（前端别想借它塞乱数据）。 */
const PREF_KEYS: ReadonlySet<string> = new Set([
  "theme",
  "accent",
  "lang",
  "timezone",
  "font_scale",
  "density",
]);

// ══════════════════════════════════════════════════════════════════
//  路由：账号管理（仅管理员）
// ══════════════════════════════════════════════════════════════════

async function activeAdmins(repo: Repo): Promise<UserRow[]> {
  return (await repo.listUsers()).filter((u) => u.role === "admin" && u.active);
}

/** 对应 `users_router = APIRouter(prefix="/api/users", dependencies=[Depends(require_admin)])`。
 * 那个 router 级依赖在这里是一条 `use("*")` 中间件 —— 每条路由自己判会漏掉新加的那条。 */
export function usersRouter(repoOf: RepoGetter = defaultRepoGetter): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();

  r.use("/api/users", (c, next) => {
    requireAdmin(c);
    return next();
  });
  r.use("/api/users/*", (c, next) => {
    requireAdmin(c);
    return next();
  });

  r.get("/api/users", async (c) => {
    const repo = repoOf();
    return c.json((await repo.listUsers()).map(userPublic));
  });

  r.post("/api/users", async (c) => {
    const repo = repoOf();
    const body = await readBody(c);
    const username = normalizeUsername(bodyStr(body, "username"));
    const password = bodyStr(body, "password");
    const role = body["role"] ?? "user";
    // 管理员替别人建号时**不强制**填名字 —— 他多半只知道对方的登录名。
    // 没填就空着，界面回落到 username；本人以后可以自己补。
    const displayName = cleanDisplayName(body["display_name"] ?? "");
    if (!username || !password) throw httpError(400, "用户名和密码不能为空");
    if (role !== "admin" && role !== "user") throw httpError(400, "角色只能是 admin 或 user");
    const ph = await hashPasswordAsync(password);
    try {
      const u = await repo.createUser(
        makeUserRow({
          id: randomUUID().replaceAll("-", ""),
          username,
          password_hash: ph,
          role,
          display_name: displayName,
        }),
      );
      return c.json(userPublic(u));
    } catch (e) {
      if (e instanceof DuplicateUsername) throw httpError(409, "用户名已存在");
      throw e;
    }
  });

  r.patch("/api/users/:uid", async (c) => {
    const repo = repoOf();
    const uid = c.req.param("uid");
    const target = await repo.getUser(uid);
    if (target === null) throw httpError(404, "用户不存在");
    const body = await readBody(c);
    const rawRole = body["role"];
    const rawActive = body["active"];
    const role = rawRole === "admin" || rawRole === "user" ? rawRole : null;
    const active = typeof rawActive === "boolean" ? rawActive : null;
    // 防锁死：不能把最后一个在用管理员降级或停用。
    const demote = (role === "user" || active === false) && target.role === "admin" && target.active;
    if (demote) {
      const admins = await activeAdmins(repo);
      if (admins.length <= 1 && admins.length > 0 && admins[0]!.id === uid) {
        throw httpError(409, "不能降级或停用最后一个管理员");
      }
    }
    const u = await repo.updateUser(uid, { role, active });
    if (active === false) await repo.deleteUserAuthSessions(uid); // 停用即时踢掉其全部登录会话
    // Python 这里直接 `u.public()`：并发删号时会 AttributeError → 500。
    // 同一类结局（5xx），但错误消息说得清是什么情况。
    if (u === null) throw new Error(`用户在更新过程中消失了：${uid}`);
    return c.json(userPublic(u));
  });

  r.post("/api/users/:uid/reset-password", async (c) => {
    const repo = repoOf();
    const uid = c.req.param("uid");
    if ((await repo.getUser(uid)) === null) throw httpError(404, "用户不存在");
    const body = await readBody(c);
    const password = bodyStr(body, "password");
    if (!password) throw httpError(400, "密码不能为空");
    const ph = await hashPasswordAsync(password);
    await repo.updateUser(uid, { passwordHash: ph });
    await repo.deleteUserAuthSessions(uid); // 强制该用户重新登录
    return c.json({ ok: true });
  });

  r.delete("/api/users/:uid", async (c) => {
    const repo = repoOf();
    const uid = c.req.param("uid");
    const admin = requireAdmin(c);
    if (uid === admin.id) throw httpError(409, "不能删除自己");
    const target = await repo.getUser(uid);
    if (target === null) throw httpError(404, "用户不存在");
    if (target.role === "admin" && target.active) {
      const admins = await activeAdmins(repo);
      if (admins.length <= 1) throw httpError(409, "不能删除最后一个管理员");
    }
    await repo.deleteUser(uid);
    return c.json({ ok: true });
  });

  return r;
}
