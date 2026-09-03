/**
 * `auth.ts` + `authgate.ts` 的测试。
 *
 * 断言的重头是**跨语言可登录性**：`golden/auth.json` 里的散列是 Python 侧
 * `hash_password()` 真跑出来的，TS 侧必须逐条验过 —— 验不过就意味着换宿主的那天
 * 所有老账号同时被锁在门外，而且没有任何报错能指向散列算法。
 *
 * 门禁部分用 `MemoryRepo` 起真的 Hono app 打请求，因为这一层的 bug 全是**越权**：
 * 光测纯函数测不出"别人的会话能不能读到"。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import {
  hashPassword,
  hashPasswordAsync,
  mintToken,
  normalizeUsername,
  tokenHash,
  verifyPassword,
  verifyPasswordAsync,
} from "../src/auth.js";
import {
  COOKIE,
  SYNTHETIC_ADMIN,
  adoptLocalSessions,
  authForced,
  authMiddleware,
  authRouter,
  cleanDisplayName,
  cookieSecure,
  corsOrigins,
  enforce,
  envTruthy,
  projectPid,
  resetLoginThrottle,
  resolveCookieUser,
  sessionSid,
  sessionTtlSeconds,
  usersRouter,
} from "../src/authgate.js";
import type { AuthEnv } from "../src/authgate.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import type { Repo } from "../src/store/repo/protocol.js";
import { makeProjectRow, makeSessionRow, makeUserRow } from "../src/store/types.js";
import { ValueError } from "../src/onto/questions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, "../../golden/auth.json"), "utf-8"),
) as {
  hashes: { password: string; encoded: string }[];
  normalize_username: { raw: string; out: string }[];
  token_hash: { token: string; out: string }[];
  clean_display_name: { raw: string; out: string }[];
  truthy: { raw: string | null; out: boolean }[];
};

// ══════════════════════════════════════════════════════════════════
//  auth.ts —— 原语
// ══════════════════════════════════════════════════════════════════

describe("auth 原语", () => {
  it("Python 生成的散列，TS 全部验得过", () => {
    expect(GOLDEN.hashes.length).toBeGreaterThan(0);
    for (const { password, encoded } of GOLDEN.hashes) {
      expect(encoded.startsWith("scrypt$16384$8$1$")).toBe(true);
      expect(verifyPassword(password, encoded)).toBe(true);
      // 错口令必须不过 —— 只测"对的过"会漏掉一个恒真的实现。
      expect(verifyPassword(password + "x", encoded)).toBe(false);
    }
  });

  it("Python 生成的散列，异步版同样验得过", async () => {
    for (const { password, encoded } of GOLDEN.hashes) {
      expect(await verifyPasswordAsync(password, encoded)).toBe(true);
    }
  });

  it("TS 生成的散列形态与 Python 逐字段相同", async () => {
    for (const make of [hashPassword("abc"), await hashPasswordAsync("abc")]) {
      const parts = make.split("$");
      expect(parts.length).toBe(6);
      expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
      expect(parts[3 + 1]).toMatch(/^[0-9a-f]{32}$/); // 16 字节盐
      expect(parts[5]).toMatch(/^[0-9a-f]{64}$/); // 32 字节派生密钥
      expect(verifyPassword("abc", make)).toBe(true);
    }
  });

  it("空口令抛 ValueError（同步与异步都是）", async () => {
    expect(() => hashPassword("")).toThrow(ValueError);
    await expect(hashPasswordAsync("")).rejects.toThrow(ValueError);
  });

  it("散列串损坏一律 false，绝不抛", () => {
    const good = GOLDEN.hashes[0]!;
    const broken = [
      "",
      "scrypt",
      "scrypt$16384$8$1$aa",
      "scrypt$16384$8$1$aa$bb$cc",
      "pbkdf2$16384$8$1$aa$bb",
      "scrypt$abc$8$1$aabb$ccdd",
      "scrypt$16384$8$1$zzzz$ccdd", // 非法十六进制
      "scrypt$16383$8$1$aabb$ccdd", // N 不是 2 的幂 → 驱动直接拒
    ];
    for (const enc of broken) expect(verifyPassword(good.password, enc)).toBe(false);
  });

  it("非法十六进制不会被静默截断成空 buffer（否则任何口令都能验过）", () => {
    // Buffer.from("zz","hex") 给的是空 buffer；若不严格校验，dklen 会被算成 0，
    // 于是"派生出 0 字节"与"期望 0 字节"比出 true —— 一条实打实的越权路径。
    expect(verifyPassword("任意口令", "scrypt$16384$8$1$zz$zz")).toBe(false);
    expect(verifyPassword("", "scrypt$16384$8$1$$")).toBe(false);
  });

  it("normalizeUsername 与 Python 逐例一致", () => {
    for (const { raw, out } of GOLDEN.normalize_username) {
      expect(normalizeUsername(raw)).toBe(out);
    }
  });

  it("tokenHash 与 Python 逐例一致（含非 ASCII）", () => {
    for (const { token, out } of GOLDEN.token_hash) expect(tokenHash(token)).toBe(out);
  });

  it("mintToken 给的是 43 字符 base64url，且第二项是它的 sha256", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const [tok, th] = mintToken();
      expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/); // == secrets.token_urlsafe(32)
      expect(th).toBe(tokenHash(tok));
      expect(seen.has(tok)).toBe(false); // 令牌重复 = 会话串号
      seen.add(tok);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  authgate —— 纯函数
// ══════════════════════════════════════════════════════════════════

describe("authgate 纯函数", () => {
  it("_truthy 与 Python 逐例一致（含 '  ' 这种 strip 后为空的）", () => {
    for (const { raw, out } of GOLDEN.truthy) expect(envTruthy(raw)).toBe(out);
  });

  it("cleanDisplayName 与 Python 逐例一致（含全角空白与换行）", () => {
    for (const { raw, out } of GOLDEN.clean_display_name) {
      expect(cleanDisplayName(raw)).toBe(out);
    }
  });

  it("cleanDisplayName 超过 40 码点就 400，汉字/emoji 都按一个算", () => {
    expect(cleanDisplayName("汉".repeat(40))).toBe("汉".repeat(40));
    expect(() => cleanDisplayName("汉".repeat(41))).toThrow();
    // emoji 是代理对：按 UTF-16 长度算的话 20 个就会被误判成 40。
    expect(cleanDisplayName("🔑".repeat(40))).toBe("🔑".repeat(40));
    expect(() => cleanDisplayName("🔑".repeat(41))).toThrow();
  });

  it("sessionSid / projectPid 只在带 id 的路径上返回值", () => {
    expect(sessionSid("/api/sessions")).toBe(null);
    expect(sessionSid("/api/sessions/")).toBe(null);
    expect(sessionSid("/api/sessions/s1")).toBe("s1");
    expect(sessionSid("/api/sessions/s1/events")).toBe("s1");
    expect(sessionSid("/api/projects/p1")).toBe(null);
    expect(projectPid("/api/projects")).toBe(null);
    expect(projectPid("/api/projects/")).toBe(null);
    expect(projectPid("/api/projects/p1")).toBe("p1");
    expect(projectPid("/api/projects/p1/memory")).toBe("p1");
  });

  it("环境读取：TTL 配错当场炸，CORS 拒绝通配", () => {
    expect(sessionTtlSeconds({} as NodeJS.ProcessEnv)).toBe(168 * 3600);
    expect(sessionTtlSeconds({ ONTOCOPILOT_SESSION_TTL_HOURS: "1" } as NodeJS.ProcessEnv)).toBe(3600);
    expect(() =>
      sessionTtlSeconds({ ONTOCOPILOT_SESSION_TTL_HOURS: "abc" } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(corsOrigins({ ONTOCOPILOT_CORS_ORIGINS: "*" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      corsOrigins({ ONTOCOPILOT_CORS_ORIGINS: " a.com , ,*, b.com " } as NodeJS.ProcessEnv),
    ).toEqual(["a.com", "b.com"]);
    expect(authForced({ ONTOCOPILOT_AUTH: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(authForced({ ONTOCOPILOT_AUTH: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(cookieSecure({ ONTOCOPILOT_COOKIE_SECURE: "yes" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  门禁 —— 起真的 app
// ══════════════════════════════════════════════════════════════════

function app(repo: Repo): Hono<AuthEnv> {
  const a = new Hono<AuthEnv>();
  a.use("*", authMiddleware(() => repo));
  a.route("/", authRouter(() => repo));
  a.route("/", usersRouter(() => repo));
  // 借几条"下游路由"验证隔离是在中间件里做的（Python 侧的原话：集中在这里做，
  // 避免逐个改十几条会话路由）。
  a.get("/api/sessions/:sid", (c) => c.json({ sid: c.req.param("sid") }));
  a.get("/api/projects/:pid", (c) => c.json({ pid: c.req.param("pid") }));
  a.get("/api/sessions", (c) => c.json([]));
  a.get("/api/health", (c) => c.json({ ok: true }));
  return a;
}

function jar(res: Response): string {
  // 只取 cookie 的 name=value 部分，模拟浏览器回发。
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function post(a: Hono<AuthEnv>, path: string, body: unknown, cookie = ""): Promise<Response> {
  return a.request(path, {
    method: "POST",
    headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("门禁", () => {
  beforeEach(() => {
    resetLoginThrottle();
    delete process.env["ONTOCOPILOT_AUTH"];
  });

  it("零账号 = 开放模式：注入合成管理员，不隔离任何会话", async () => {
    const repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({ id: "s1", owner: "别人" }));
    const a = app(repo);

    expect(await enforce(repo)).toBe(false);
    const r = await a.request("/api/sessions/s1");
    expect(r.status).toBe(200); // 开放模式下不隔离 —— 与加鉴权之前完全一致

    const me = await (await a.request("/api/me")).json();
    expect(me).toMatchObject({ id: SYNTHETIC_ADMIN.id, role: "admin" });
  });

  it("ONTOCOPILOT_AUTH 真值 ⇒ 即便零账号也强制", async () => {
    const repo = new MemoryRepo();
    process.env["ONTOCOPILOT_AUTH"] = "1";
    try {
      expect(await enforce(repo)).toBe(true);
      const r = await app(repo).request("/api/sessions");
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "未登录", code: "auth.required" });
    } finally {
      delete process.env["ONTOCOPILOT_AUTH"];
    }
  });

  it("有账号 ⇒ 门永远关着；allowlist 仍放行", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "a", password_hash: hashPassword("pw") }),
    );
    const a = app(repo);
    expect((await a.request("/api/sessions")).status).toBe(401);
    expect((await a.request("/api/health")).status).toBe(200);
    expect((await a.request("/api/auth/status")).status).toBe(200);
    // OPTIONS（CORS 预检）一律放行
    expect((await a.request("/api/sessions", { method: "OPTIONS" })).status).not.toBe(401);
  });

  it("会话归属：别人的会话一律 404，不泄露它存在", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    await repo.createSession(makeSessionRow({ id: "mine", owner: "u1" }));
    await repo.createSession(makeSessionRow({ id: "theirs", owner: "u2" }));
    await repo.createSession(makeSessionRow({ id: "orphan", owner: "" }));
    const a = app(repo);

    const login = await post(a, "/api/login", { username: "me", password: "pw123456" });
    expect(login.status).toBe(200);
    const cookie = jar(login);
    expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);

    const get = async (p: string) => a.request(p, { headers: { cookie } });
    expect((await get("/api/sessions/mine")).status).toBe(200);
    for (const sid of ["theirs", "orphan", "nonexistent"]) {
      const r = await get(`/api/sessions/${sid}`);
      expect(r.status).toBe(404);
      // 三种情况必须**同一句话**，否则 404 的措辞就成了存在性预言机。
      expect(await r.json()).toEqual({ error: "会话不存在", code: "session.not_found" });
    }
  });

  it("项目归属也在中间件里挡 —— 否则任何登录用户都能删别人的文件夹", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    await repo.createProject(makeProjectRow({ id: "mine", name: "我的", owner: "u1" }));
    await repo.createProject(makeProjectRow({ id: "theirs", name: "他的", owner: "u2" }));
    await repo.createProject(makeProjectRow({ id: "orphan", name: "无主", owner: "" }));
    const a = app(repo);
    const cookie = jar(await post(a, "/api/login", { username: "me", password: "pw123456" }));

    const get = async (p: string) => a.request(p, { headers: { cookie } });
    expect((await get("/api/projects/mine")).status).toBe(200);
    for (const pid of ["theirs", "orphan", "nope"]) {
      const r = await get(`/api/projects/${pid}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "项目不存在", code: "project.not_found" });
    }
  });

  it("停用即时失效，不等 cookie 过期", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    const a = app(repo);
    const cookie = jar(await post(a, "/api/login", { username: "me", password: "pw123456" }));
    expect((await a.request("/api/me", { headers: { cookie } })).status).toBe(200);
    await repo.updateUser("u1", { active: false });
    expect((await a.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  it("过期的 auth_session 解析成 null", async () => {
    const repo = new MemoryRepo();
    const u = await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    const [tok, th] = mintToken();
    await repo.createAuthSession({
      token_hash: th,
      user_id: u.id,
      created: 0,
      last_seen: 0,
      expires: Date.now() / 1000 - 1,
    });
    const a = new Hono<AuthEnv>();
    let seen: unknown = "未跑到";
    a.get("/x", async (c) => {
      seen = await resolveCookieUser(c, repo);
      return c.text("ok");
    });
    await a.request("/x", { headers: { cookie: `${COOKIE}=${tok}` } });
    expect(seen).toBe(null);
  });

  it("登录：用户不存在 / 密码错 / 已停用 —— 同一句 401", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    await repo.createUser(
      makeUserRow({
        id: "u2",
        username: "off",
        password_hash: hashPassword("pw123456"),
        active: false,
      }),
    );
    const a = app(repo);
    for (const body of [
      { username: "nobody", password: "pw123456" },
      { username: "me", password: "wrong" },
      { username: "off", password: "pw123456" },
    ]) {
      const r = await post(a, "/api/login", body);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ detail: "用户名或密码错误" });
      // 401 绝不能带上 cookie
      expect(r.headers.get("set-cookie")).toBe(null);
    }
  });

  it("登录限流：同一 IP 第 11 次就 429", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({ id: "u1", username: "me", password_hash: hashPassword("pw123456") }),
    );
    const a = app(repo);
    for (let i = 0; i < 10; i++) {
      expect((await post(a, "/api/login", { username: "me", password: "x" })).status).toBe(401);
    }
    const r = await post(a, "/api/login", { username: "me", password: "pw123456" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: "尝试过于频繁，请稍后再试" });
  });

  it("注册：首个是管理员，且把 __local__ 与无主的会话/项目一起认领", async () => {
    const repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({ id: "s1", owner: SYNTHETIC_ADMIN.id }));
    await repo.createSession(makeSessionRow({ id: "s2", owner: "" }));
    await repo.createProject(makeProjectRow({ id: "p1", name: "旧", owner: SYNTHETIC_ADMIN.id }));
    const a = app(repo);

    const r = await post(a, "/api/register", {
      username: " Yuhan ",
      password: "pw123456",
      display_name: "  程宇涵  ",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { user: Record<string, unknown>; adopted_sessions: number };
    expect(body.user["role"]).toBe("admin");
    expect(body.user["username"]).toBe("yuhan"); // 登录标识被规范化
    expect(body.user["display_name"]).toBe("程宇涵"); // 称呼保留大小写、折叠空白
    expect(body.user["password_hash"]).toBeUndefined(); // public() 永不带散列
    expect(body.adopted_sessions).toBe(2);

    const uid = body.user["id"] as string;
    expect((await repo.getSession("s1"))?.owner).toBe(uid);
    expect((await repo.getSession("s2"))?.owner).toBe(uid);
    expect((await repo.getProject("p1"))?.owner).toBe(uid);
    // 注册即登录
    expect(jar(r).startsWith(`${COOKIE}=`)).toBe(true);

    // 第二个人只是普通用户，且不认领任何东西
    resetLoginThrottle();
    const r2 = await post(a, "/api/register", {
      username: "bob",
      password: "pw123456",
      display_name: "Bob",
    });
    const b2 = (await r2.json()) as { user: Record<string, unknown>; adopted_sessions: number };
    expect(b2.user["role"]).toBe("user");
    expect(b2.adopted_sessions).toBe(0);
  });

  it("注册的四道校验各自回自己的那句话", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    const cases: [Record<string, unknown>, number, string][] = [
      [{ username: "", password: "pw123456", display_name: "n" }, 400, "用户名和密码不能为空"],
      [{ username: "u", password: "", display_name: "n" }, 400, "用户名和密码不能为空"],
      [{ username: "u", password: "pw123456", display_name: "  " }, 400, "请填写你的名字"],
      [{ username: "u", password: "12345", display_name: "n" }, 400, "密码至少 6 位"],
    ];
    for (const [body, status, detail] of cases) {
      resetLoginThrottle();
      const r = await post(a, "/api/register", body);
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ detail });
    }
    resetLoginThrottle();
    await post(a, "/api/register", { username: "dup", password: "pw123456", display_name: "n" });
    resetLoginThrottle();
    const dup = await post(a, "/api/register", {
      username: " DUP ",
      password: "pw123456",
      display_name: "n",
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ detail: "用户名已存在" });
  });

  // ── ONTOCOPILOT_AUTH=1 ⇒ 注册关闭 ──────────────────────────────
  //
  // 这条闸是**给联网部署用的**。`.env.example` 承诺"从首次启动起就锁死"，
  // 而在这条闸存在之前，AUTH=1 + 零账号时 `POST /api/register` 照样返回 200
  // 并把 role 设成 admin —— 谁先访问谁当管理员，正是文件头声称已经杜绝的那个竞态。
  //
  // 闸判据是 `authForced()`（显式开关），**不是** `enforce()`：不设 AUTH 但库里
  // 已有账号的本机实例，自助注册照旧开着（84b871d 定下的产品形态，不动）。

  it("AUTH=1 + 零账号：注册被拒 403，且**一个账号都没建出来**", async () => {
    const repo = new MemoryRepo();
    process.env["ONTOCOPILOT_AUTH"] = "1";
    try {
      const a = app(repo);
      const r = await post(a, "/api/register", {
        username: "attacker",
        password: "pw123456",
        display_name: "路人甲",
      });
      expect(r.status).toBe(403);
      // 最要命的不是状态码，是"有没有真的落库" —— 403 但建成了等于没拦。
      expect(await repo.countUsers()).toBe(0);
    } finally {
      delete process.env["ONTOCOPILOT_AUTH"];
    }
  });

  it("AUTH=1 + 已有账号：注册同样关闭（不是只挡首个）", async () => {
    const repo = new MemoryRepo();
    await repo.createUser(
      makeUserRow({
        id: "u1",
        username: "root",
        password_hash: await hashPasswordAsync("pw123456"),
        role: "admin",
      }),
    );
    process.env["ONTOCOPILOT_AUTH"] = "1";
    try {
      const r = await post(app(repo), "/api/register", {
        username: "later",
        password: "pw123456",
        display_name: "后来的",
      });
      expect(r.status).toBe(403);
      expect(await repo.countUsers()).toBe(1);
    } finally {
      delete process.env["ONTOCOPILOT_AUTH"];
    }
  });

  it("不设 AUTH：开放注册一个字没变 —— 首个即管理员", async () => {
    const repo = new MemoryRepo();
    const r = await post(app(repo), "/api/register", {
      username: "first",
      password: "pw123456",
      display_name: "第一个",
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as Record<string, unknown>).toMatchObject({
      user: { username: "first", role: "admin" },
    });
  });

  it("不设 AUTH 但已有账号：仍可自助注册，且拿到的是普通用户", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    await post(a, "/api/register", { username: "first", password: "pw123456", display_name: "甲" });
    resetLoginThrottle();
    const second = await post(a, "/api/register", {
      username: "second",
      password: "pw123456",
      display_name: "乙",
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({
      user: { username: "second", role: "user" },
    });
  });

  it("auth/status 如实报注册开关 —— 前端靠它决定给不给注册表单", async () => {
    const repo = new MemoryRepo();

    const open = (await (await app(repo).request("/api/auth/status")).json()) as Record<string, unknown>;
    expect(open).toMatchObject({ registration_open: true });

    process.env["ONTOCOPILOT_AUTH"] = "1";
    try {
      const shut = (await (await app(repo).request("/api/auth/status")).json()) as Record<
        string,
        unknown
      >;
      // 注册关着的时候 first_user_is_admin 必须也是 false，否则前端会默认弹出
      // 一个注册表单、填完拿 403 —— 界面在教用户走一条走不通的路。
      expect(shut).toMatchObject({
        auth_enabled: true,
        registration_open: false,
        first_user_is_admin: false,
      });
    } finally {
      delete process.env["ONTOCOPILOT_AUTH"];
    }
  });

  it("auth/status 带 display_name —— 漏了的表现是库里存着、界面永远空白", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    const zero = (await (await a.request("/api/auth/status")).json()) as Record<string, unknown>;
    expect(zero).toMatchObject({ auth_enabled: false, registration_open: true });

    await post(a, "/api/register", { username: "u", password: "pw123456", display_name: "程宇涵" });
    const login = await post(a, "/api/login", { username: "u", password: "pw123456" });
    const s = (await (
      await a.request("/api/auth/status", { headers: { cookie: jar(login) } })
    ).json()) as { auth_enabled: boolean; authenticated: boolean; user: Record<string, unknown> };
    expect(s.auth_enabled).toBe(true);
    expect(s.authenticated).toBe(true);
    expect(s.user["display_name"]).toBe("程宇涵");
    expect(s.user["password_hash"]).toBeUndefined();
  });

  it("改密码：原密码不对 403；改完踢掉全部登录会话并清 cookie", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    await post(a, "/api/register", { username: "u", password: "old123", display_name: "n" });
    const c1 = jar(await post(a, "/api/login", { username: "u", password: "old123" }));
    const c2 = jar(await post(a, "/api/login", { username: "u", password: "old123" }));

    const bad = await post(a, "/api/me/password", { old: "nope", new: "new123" }, c1);
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ detail: "原密码不正确" });

    const empty = await post(a, "/api/me/password", { old: "old123", new: "" }, c1);
    expect(empty.status).toBe(400);

    const ok = await post(a, "/api/me/password", { old: "old123", new: "new123" }, c1);
    expect(ok.status).toBe(200);
    // 另一条登录会话也必须失效 —— 密码换了而旧 cookie 还能用等于没换。
    expect((await a.request("/api/me", { headers: { cookie: c2 } })).status).toBe(401);
    resetLoginThrottle();
    expect((await post(a, "/api/login", { username: "u", password: "new123" })).status).toBe(200);
  });

  it("改名字不踢登录会话（换个称呼不是安全事件）", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    await post(a, "/api/register", { username: "u", password: "pw123456", display_name: "旧名" });
    const cookie = jar(await post(a, "/api/login", { username: "u", password: "pw123456" }));
    const r = await post(a, "/api/me/profile", { display_name: " 新  名 " }, cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: Record<string, unknown> }).user["display_name"]).toBe("新 名");
    expect((await a.request("/api/me", { headers: { cookie } })).status).toBe(200);
    const blank = await post(a, "/api/me/profile", { display_name: "  " }, cookie);
    expect(blank.status).toBe(400);
  });

  it("prefs 只收白名单键，非法时区 400", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    await post(a, "/api/register", { username: "u", password: "pw123456", display_name: "n" });
    const cookie = jar(await post(a, "/api/login", { username: "u", password: "pw123456" }));
    const patch = async (body: unknown): Promise<Response> =>
      a.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    const ok = await patch({ theme: "dark", timezone: "Asia/Shanghai", 恶意: "x" });
    expect(await ok.json()).toEqual({ prefs: { theme: "dark", timezone: "Asia/Shanghai" } });
    const bad = await patch({ timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "未知时区：Mars/Olympus" });
    // 合并而不是覆盖
    const merged = await patch({ accent: "blue" });
    expect(await merged.json()).toEqual({
      prefs: { theme: "dark", timezone: "Asia/Shanghai", accent: "blue" },
    });
  });

  it("开放模式下 /me/password 与 /me/profile 都是 400，prefs 只回显", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    expect((await post(a, "/api/me/password", { old: "a", new: "b" })).status).toBe(400);
    expect((await post(a, "/api/me/profile", { display_name: "x" })).status).toBe(400);
    const r = await a.request("/api/me/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(await r.json()).toEqual({ prefs: { theme: "dark" } });
  });

  it("登出删掉 auth_session 并清 cookie", async () => {
    const repo = new MemoryRepo();
    const a = app(repo);
    await post(a, "/api/register", { username: "u", password: "pw123456", display_name: "n" });
    const login = await post(a, "/api/login", { username: "u", password: "pw123456" });
    const cookie = jar(login);
    const tok = cookie.slice(COOKIE.length + 1);
    expect(await repo.getAuthSession(tokenHash(tok))).not.toBe(null);
    const out = await post(a, "/api/logout", {}, cookie);
    expect(await out.json()).toEqual({ ok: true });
    expect(await repo.getAuthSession(tokenHash(tok))).toBe(null);
    expect((await a.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════
//  账号管理（仅管理员）
// ══════════════════════════════════════════════════════════════════

describe("账号管理", () => {
  beforeEach(() => {
    resetLoginThrottle();
    delete process.env["ONTOCOPILOT_AUTH"];
  });

  /** 建一个管理员 + 一个普通用户，返回两人的 cookie。 */
  async function seed(): Promise<{
    repo: MemoryRepo;
    a: Hono<AuthEnv>;
    admin: string;
    plain: string;
    adminId: string;
    plainId: string;
  }> {
    const repo = new MemoryRepo();
    const a = app(repo);
    const r1 = await post(a, "/api/register", {
      username: "root",
      password: "pw123456",
      display_name: "管",
    });
    const adminId = ((await r1.json()) as { user: { id: string } }).user.id;
    resetLoginThrottle();
    const r2 = await post(a, "/api/register", {
      username: "bob",
      password: "pw123456",
      display_name: "普",
    });
    const plainId = ((await r2.json()) as { user: { id: string } }).user.id;
    resetLoginThrottle();
    const admin = jar(await post(a, "/api/login", { username: "root", password: "pw123456" }));
    resetLoginThrottle();
    const plain = jar(await post(a, "/api/login", { username: "bob", password: "pw123456" }));
    return { repo, a, admin, plain, adminId, plainId };
  }

  it("普通用户碰不到 /api/users 的任何一条", async () => {
    const { a, plain, plainId } = await seed();
    const calls: [string, string][] = [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", `/api/users/${plainId}`],
      ["POST", `/api/users/${plainId}/reset-password`],
      ["DELETE", `/api/users/${plainId}`],
    ];
    for (const [method, path] of calls) {
      const r = await a.request(path, {
        method,
        headers: { "content-type": "application/json", cookie: plain },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ detail: "需要管理员权限" });
    }
  });

  it("管理员建号：不强制填名字，角色只能是 admin/user", async () => {
    const { a, admin } = await seed();
    const r = await post(a, "/api/users", { username: " NEW ", password: "x" }, admin);
    expect(r.status).toBe(200);
    const u = (await r.json()) as Record<string, unknown>;
    expect(u["username"]).toBe("new");
    expect(u["display_name"]).toBe(""); // 没填就空着，界面回落到 username
    expect(u["role"]).toBe("user");

    const bad = await post(a, "/api/users", { username: "x", password: "y", role: "root" }, admin);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "角色只能是 admin 或 user" });
    const blank = await post(a, "/api/users", { username: "", password: "y" }, admin);
    expect(blank.status).toBe(400);
  });

  it("不能降级/停用/删除最后一个管理员 —— 那是把自己锁在门外", async () => {
    const { a, admin, adminId } = await seed();
    const patch = async (body: unknown): Promise<Response> =>
      a.request(`/api/users/${adminId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin },
        body: JSON.stringify(body),
      });
    for (const body of [{ role: "user" }, { active: false }]) {
      const r = await patch(body);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ detail: "不能降级或停用最后一个管理员" });
    }
    // 删自己有更靠前的一条判据
    const self = await a.request(`/api/users/${adminId}`, {
      method: "DELETE",
      headers: { cookie: admin },
    });
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ detail: "不能删除自己" });
  });

  it("停用普通用户会即时踢掉他的登录会话", async () => {
    const { a, admin, plain, plainId } = await seed();
    expect((await a.request("/api/me", { headers: { cookie: plain } })).status).toBe(200);
    const r = await a.request(`/api/users/${plainId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ active: false }),
    });
    expect(r.status).toBe(200);
    expect((await a.request("/api/me", { headers: { cookie: plain } })).status).toBe(401);
  });

  it("重置密码会强制该用户重新登录", async () => {
    const { a, admin, plain, plainId } = await seed();
    const r = await post(a, `/api/users/${plainId}/reset-password`, { password: "brand" }, admin);
    expect(await r.json()).toEqual({ ok: true });
    expect((await a.request("/api/me", { headers: { cookie: plain } })).status).toBe(401);
    resetLoginThrottle();
    expect((await post(a, "/api/login", { username: "bob", password: "brand" })).status).toBe(200);
    const blank = await post(a, `/api/users/${plainId}/reset-password`, {}, admin);
    expect(blank.status).toBe(400);
    const gone = await post(a, "/api/users/不存在/reset-password", { password: "x" }, admin);
    expect(gone.status).toBe(404);
  });

  it("列表投影永不含 password_hash", async () => {
    const { a, admin } = await seed();
    const list = (await (
      await a.request("/api/users", { headers: { cookie: admin } })
    ).json()) as Record<string, unknown>[];
    expect(list.length).toBe(2);
    for (const u of list) expect(u["password_hash"]).toBeUndefined();
  });

  it("删掉一个普通管理员是允许的（还剩别人）", async () => {
    const { a, admin, plainId } = await seed();
    await a.request(`/api/users/${plainId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ role: "admin" }),
    });
    const r = await a.request(`/api/users/${plainId}`, {
      method: "DELETE",
      headers: { cookie: admin },
    });
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("adoptLocalSessions 直调", () => {
  it("认领 __local__ 与空归属两批，只把会话数记进返回值", async () => {
    const repo = new MemoryRepo();
    await repo.createSession(makeSessionRow({ id: "a", owner: SYNTHETIC_ADMIN.id }));
    await repo.createSession(makeSessionRow({ id: "b", owner: "" }));
    await repo.createSession(makeSessionRow({ id: "c", owner: "别人" }));
    await repo.createProject(makeProjectRow({ id: "p", name: "x", owner: "" }));
    const u = makeUserRow({ id: "u9", username: "u", password_hash: "h" });
    expect(await adoptLocalSessions(repo, u)).toBe(2);
    expect((await repo.getSession("c"))?.owner).toBe("别人"); // 别人的不动
    expect((await repo.getProject("p"))?.owner).toBe("u9");
  });
});
