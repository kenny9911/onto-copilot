"""鉴权门禁 —— 中间件、cookie 会话解析、登录/账号路由。

与 :mod:`auth`（纯散列/令牌原语）分工：本模块是 Web 层，接 FastAPI。

**门禁纪律（fail-closed）**：
  * ``ONTOCOPILOT_AUTH`` 真值 **或** 库里已存在任何账号 ⇒ 强制鉴权。
    "建过账号却没鉴权"这种状态不可能出现 —— 一旦有人存在，门就永远是关的。
  * 两者都不满足（全新实例、零账号）⇒ 开放模式，注入一个合成管理员，
    行为与加鉴权之前**完全一致**，本地零配置可用；启动时打一条醒目告警。
  * 首个管理员**只能用宿主机 CLI**（``ontocopilot useradd --admin``）创建 ——
    没有公开的 bootstrap 路由，杜绝"谁先访问谁当管理员"的抢注竞态。

**SSE**：``EventSource`` 发不了 Authorization 头，但会自动带上同源 cookie，
所以 ``/stream`` 走 cookie、无需任何特殊处理。

**scrypt 不能卡事件循环**：登录/建号里的散列一律 ``run_in_threadpool`` 丢线程池。
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .auth import (
    hash_password,
    mint_token,
    normalize_username,
    token_hash,
    verify_password,
)
from .store.deps import get_repo
from .store.repo import AuthSessionRow, DuplicateUsername, Repo, UserRow

COOKIE = "oc_auth"

#: 开放模式下注入的合成管理员。password_hash 为空 —— 它永远不会走登录校验。
SYNTHETIC_ADMIN = UserRow(id="__local__", username="local", password_hash="",
                          role="admin", active=True)

#: 登录失败也要跑一次散列，抹平"用户存在与否"的时间差（防用户名枚举）。
_DUMMY_HASH_CACHE: list[str] = []


def _dummy_hash() -> str:
    if not _DUMMY_HASH_CACHE:
        _DUMMY_HASH_CACHE.append(hash_password("timing-equalizer-not-a-real-password"))
    return _DUMMY_HASH_CACHE[0]


# ── 环境读取 ──────────────────────────────────────────────────────
def _truthy(v: str | None) -> bool:
    return bool(v) and v.strip().lower() not in ("", "0", "false", "no", "off")


def auth_forced() -> bool:
    return _truthy(os.getenv("ONTOCOPILOT_AUTH"))


def cookie_secure() -> bool:
    # http 上置 Secure 会让浏览器**静默丢弃** cookie → 死循环登录。默认关，
    # 只有在 HTTPS 后面才显式开。
    return _truthy(os.getenv("ONTOCOPILOT_COOKIE_SECURE"))


def session_ttl_seconds() -> int:
    return int(os.getenv("ONTOCOPILOT_SESSION_TTL_HOURS", "168")) * 3600


def cors_origins() -> list[str]:
    raw = os.getenv("ONTOCOPILOT_CORS_ORIGINS", "")
    # 带凭证时禁止通配 —— 浏览器也禁，这里显式挡掉误配的 "*"/空串。
    return [o.strip() for o in raw.split(",") if o.strip() and o.strip() != "*"]


async def adopt_local_sessions(repo: Repo, user: UserRow) -> int:
    """把开放模式下建的会话认领给这个（首个）账号，返回认领了几个。

    **建第一个账号会顺带把整个实例翻进强制鉴权**（见 :func:`_enforce`：有账号就
    强制）。而开放模式下建的每个会话，归属记的都是合成管理员 ``__local__`` ——
    一旦强制，列表按真实 user id 过滤、中间件对不属于你的会话回 404，于是**他
    昨天梳理的全部东西在建号的那一秒集体消失**。从用户视角这就是数据没了，而且
    是他自己点了"创建账户"之后没的。

    两条建号路径都要走这里：``POST /api/register`` 和 ``ontocopilot useradd``。
    只在其中一条上做，另一条就成了"照文档操作，然后数据全丢"。
    """
    n = 0
    for old in (SYNTHETIC_ADMIN.id, ""):
        n += await repo.reassign_sessions(old, user.id)
    return n


async def _enforce(repo: Repo) -> bool:
    """是否强制鉴权：显式开关 or 已有账号。"""
    if auth_forced():
        return True
    return (await repo.count_users()) > 0


# ── cookie → 用户 ─────────────────────────────────────────────────
async def resolve_cookie_user(request: Request, repo: Repo) -> UserRow | None:
    """按 cookie 解析当前用户；令牌缺失/过期/账号停用一律返回 None。"""
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    sess = await repo.get_auth_session(token_hash(tok))
    if sess is None or (sess.expires and sess.expires <= time.time()):
        return None
    user = await repo.get_user(sess.user_id)
    if user is None or not user.active:      # 停用即时失效，不等 cookie 过期
        return None
    return user


_PUBLIC_PATHS = frozenset({"/", "/api/health", "/api/login", "/api/register",
                           "/api/auth/status"})


def _is_public(request: Request) -> bool:
    if request.method == "OPTIONS":          # CORS 预检放行
        return True
    return request.url.path in _PUBLIC_PATHS


def _session_sid(path: str) -> str | None:
    """从 ``/api/sessions/<sid>[/...]`` 里取出 sid；列表/创建路由（无 sid）返回 None。"""
    prefix = "/api/sessions/"
    if not path.startswith(prefix):
        return None
    return path[len(prefix):].split("/", 1)[0] or None


async def auth_middleware(request: Request, call_next):
    """一道 fail-closed 门。解析用户挂到 ``request.state.user``，并按账号隔离会话。"""
    repo = get_repo()
    if not await _enforce(repo):
        request.state.user = SYNTHETIC_ADMIN     # 开放模式：不鉴权、不隔离（同今日行为）
        return await call_next(request)

    # 强制模式：总是先尝试解析 cookie（allowlist 也解析，好让 /auth/status 知道身份）
    request.state.user = await resolve_cookie_user(request, repo)
    if _is_public(request):
        return await call_next(request)
    if request.state.user is None:
        return JSONResponse({"error": "未登录", "code": "auth.required"}, status_code=401)

    # 按账号隔离：访问具体会话必须是**本人**的。不存在 / 无归属 / 他人的会话一律当作
    # "不存在"（404）—— 不泄露"这个 id 存在但不是你的"。集中在这里做，避免逐个改
    # 十几条会话路由。
    sid = _session_sid(request.url.path)
    if sid is not None:
        row = await repo.get_session(sid)
        if row is None or row.owner != request.state.user.id:
            return JSONResponse({"error": "会话不存在", "code": "session.not_found"},
                                status_code=404)
    return await call_next(request)


# ── 依赖 ─────────────────────────────────────────────────────────
def require_user(request: Request) -> UserRow:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "未登录")
    return user


def require_admin(request: Request) -> UserRow:
    user = require_user(request)
    if user.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user


# ── cookie 读写 ──────────────────────────────────────────────────
def _set_cookie(resp: JSONResponse, token: str) -> None:
    resp.set_cookie(COOKIE, token, max_age=session_ttl_seconds(), httponly=True,
                    samesite="lax", secure=cookie_secure(), path="/")


def _clear_cookie(resp: JSONResponse) -> None:
    resp.delete_cookie(COOKIE, path="/")


#: 名字的长度上限（按码点算，一个汉字算一个）。够写全名和「张伟（采购）」这类备注，
#: 又不至于把界面撑破 —— 它会出现在空状态问候语和账号列表里。
_DISPLAY_NAME_MAX = 40


def clean_display_name(raw: str) -> str:
    """规整用户填的名字。

    **不复用 normalize_username** —— 那个做 ``strip().lower()``，会把「Yuhan」变成
    「yuhan」，而这一列存在的全部意义就是原样称呼人。这里只折叠空白（含换行与
    制表符：带 ``\\n`` 的名字会撑破账号列表的一行），两端去空。

    空串是合法结果 = 没填。要不要允许没填由**调用方**决定：自助注册要求填，
    管理员建号和 CLI 不要求。
    """
    name = " ".join(str(raw or "").split())
    if len(name) > _DISPLAY_NAME_MAX:
        raise HTTPException(400, f"名字不能超过 {_DISPLAY_NAME_MAX} 个字")
    return name


# ── 登录限流（进程内、按 IP、固定窗口）──────────────────────────────
_ATTEMPTS: dict[str, tuple[float, int]] = {}
_THROTTLE_MAX = 10
_THROTTLE_WINDOW = 60.0


def _throttle(request: Request) -> None:
    ip = request.client.host if request.client else "?"
    now = time.time()
    start, n = _ATTEMPTS.get(ip, (now, 0))
    if now - start > _THROTTLE_WINDOW:
        start, n = now, 0
    n += 1
    _ATTEMPTS[ip] = (start, n)
    if n > _THROTTLE_MAX:
        raise HTTPException(429, "尝试过于频繁，请稍后再试")


# ══════════════════════════════════════════════════════════════════
#  路由：登录 / 登出 / 我是谁 / 门禁状态
# ══════════════════════════════════════════════════════════════════
router = APIRouter(prefix="/api")
RepoDep = Annotated[Repo, Depends(get_repo)]


@router.post("/login")
async def login(request: Request, body: dict, repo: RepoDep):
    _throttle(request)
    username = normalize_username(str(body.get("username", "")))
    password = str(body.get("password", ""))
    user = await repo.get_user_by_username(username)
    # 无论用户是否存在都跑一次散列，抹平时间差。
    ok = await run_in_threadpool(
        verify_password, password, user.password_hash if user else _dummy_hash())
    # 用户不存在 / 密码错 / 账号停用 —— 一律同一句 401，不泄露账号是否存在或被停用。
    if user is None or not ok or not user.active:
        raise HTTPException(401, "用户名或密码错误")
    token, th = mint_token()
    await repo.create_auth_session(AuthSessionRow(
        token_hash=th, user_id=user.id, expires=time.time() + session_ttl_seconds()))
    resp = JSONResponse({"user": user.public()})
    _set_cookie(resp, token)
    return resp


@router.post("/register")
async def register(request: Request, body: dict, repo: RepoDep):
    """自助注册。**首个注册的账号自动成为管理员**（可改网关/全局配置），其余为普通
    用户。开放注册：任何人都能建号（联网部署请自行评估是否加邀请码）。"""
    _throttle(request)
    username = normalize_username(str(body.get("username", "")))
    password = str(body.get("password", ""))
    # 自助注册**要求填名字**：界面要拿它称呼人（"欢迎回来，程宇涵"），
    # 而 username 是被 lower() 过的登录标识，不适合当称呼。
    # 管理员建号 / CLI 建号仍可不填 —— 那两条路上没人当场问得到。
    display_name = clean_display_name(body.get("display_name", ""))
    if not username or not password:
        raise HTTPException(400, "用户名和密码不能为空")
    if not display_name:
        raise HTTPException(400, "请填写你的名字")
    if len(password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    # 库里还没有账号 → 这个人就是管理员。有 TOCTOU 窗口（两人同时抢首个），
    # 单进程下概率极低，且最坏结果只是多一个管理员，可接受。
    role = "admin" if await repo.count_users() == 0 else "user"
    ph = await run_in_threadpool(hash_password, password)
    try:
        user = await repo.create_user(UserRow(
            id=uuid.uuid4().hex, username=username, password_hash=ph, role=role,
            display_name=display_name))
    except DuplicateUsername:
        raise HTTPException(409, "用户名已存在") from None
    adopted = await adopt_local_sessions(repo, user) if role == "admin" else 0

    token, th = mint_token()
    await repo.create_auth_session(AuthSessionRow(
        token_hash=th, user_id=user.id, expires=time.time() + session_ttl_seconds()))
    resp = JSONResponse({"user": user.public(), "adopted_sessions": adopted})
    _set_cookie(resp, token)                        # 注册即登录
    return resp


@router.post("/logout")
async def logout(request: Request, repo: RepoDep):
    tok = request.cookies.get(COOKIE)
    if tok:
        await repo.delete_auth_session(token_hash(tok))
    resp = JSONResponse({"ok": True})
    _clear_cookie(resp)
    return resp


@router.get("/me")
async def me(request: Request):
    user = require_user(request)
    return {"id": user.id, "username": user.username, "role": user.role,
            "active": user.active, "prefs": user.prefs,
            "display_name": user.display_name}


@router.get("/auth/status")
async def auth_status(request: Request, repo: RepoDep):
    enforce = await _enforce(repo)
    user = getattr(request.state, "user", None)
    n = await repo.count_users()
    return {
        "auth_enabled": enforce,
        # 开放自助注册：前端在登录页始终提供"注册"。零账号时首个注册者即管理员。
        "registration_open": True,
        "first_user_is_admin": enforce and n == 0,
        "authenticated": user is not None,
        # 前端唯一无条件调用的身份端点就是这里 —— 空状态那句问候语的名字只能从
        # 这个投影拿到。漏了 display_name 的表现是：库里存着、界面上永远空白。
        "user": ({"id": user.id, "username": user.username, "role": user.role,
                  "prefs": user.prefs, "display_name": user.display_name}
                 if user else None),
    }


@router.post("/me/password")
async def change_own_password(request: Request, body: dict, repo: RepoDep):
    user = require_user(request)
    if user.id == SYNTHETIC_ADMIN.id:
        raise HTTPException(400, "开放模式下没有可改的账号")
    old = str(body.get("old", ""))
    new = str(body.get("new", ""))
    if not new:
        raise HTTPException(400, "新密码不能为空")
    if not await run_in_threadpool(verify_password, old, user.password_hash):
        raise HTTPException(403, "原密码不正确")
    ph = await run_in_threadpool(hash_password, new)
    await repo.update_user(user.id, password_hash=ph)
    # 踢掉本人其它登录会话（当前这条一并作废，前端会重新登录）。
    await repo.delete_user_auth_sessions(user.id)
    resp = JSONResponse({"ok": True})
    _clear_cookie(resp)
    return resp


@router.post("/me/profile")
async def update_own_profile(request: Request, body: dict, repo: RepoDep):
    """改自己的个人资料。目前只有名字。

    **账号是账号，资料是资料**：username 是登录标识，改了会影响登录，这里不碰；
    名字只是个称呼，随时可改，改完立刻反映在界面上（问候语、左下角、头像首字）。

    和改密码不同，这里**不踢登录会话** —— 换个称呼不是安全事件。
    """
    user = require_user(request)
    if user.id == SYNTHETIC_ADMIN.id:
        raise HTTPException(400, "开放模式下没有可改的账号")
    display_name = clean_display_name(body.get("display_name", ""))
    if not display_name:
        raise HTTPException(400, "请填写你的名字")
    updated = await repo.update_user(user.id, display_name=display_name)
    if updated is None:
        raise HTTPException(404, "账号不存在")
    return {"user": updated.public()}


#: 允许自助保存的外观/语言偏好键。其它键一律忽略（前端别想借它塞乱数据）。
_PREF_KEYS = frozenset({"theme", "accent", "lang", "timezone", "font_scale", "density"})


@router.patch("/me/prefs")
async def update_prefs(request: Request, body: dict, repo: RepoDep):
    user = require_user(request)
    patch = {k: v for k, v in (body or {}).items() if k in _PREF_KEYS}
    tz = patch.get("timezone")
    if tz:                                       # 非法 IANA 时区会让前端 Intl 抛错
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(str(tz))
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(400, f"未知时区：{tz}") from None
    if user.id == SYNTHETIC_ADMIN.id:
        return {"prefs": patch}                  # 开放模式无持久账号 → 前端只落 localStorage
    merged = {**(user.prefs or {}), **patch}
    await repo.update_user(user.id, prefs=merged)
    return {"prefs": merged}


# ══════════════════════════════════════════════════════════════════
#  路由：账号管理（仅管理员）
# ══════════════════════════════════════════════════════════════════
users_router = APIRouter(prefix="/api/users", dependencies=[Depends(require_admin)])


async def _active_admins(repo: Repo) -> list[UserRow]:
    return [u for u in await repo.list_users() if u.role == "admin" and u.active]


@users_router.get("")
async def list_users(repo: RepoDep):
    return [u.public() for u in await repo.list_users()]


@users_router.post("")
async def create_user(body: dict, repo: RepoDep):
    username = normalize_username(str(body.get("username", "")))
    password = str(body.get("password", ""))
    role = body.get("role", "user")
    # 管理员替别人建号时**不强制**填名字 —— 他多半只知道对方的登录名。
    # 没填就空着，界面回落到 username；本人以后可以自己补。
    display_name = clean_display_name(body.get("display_name", ""))
    if not username or not password:
        raise HTTPException(400, "用户名和密码不能为空")
    if role not in ("admin", "user"):
        raise HTTPException(400, "角色只能是 admin 或 user")
    ph = await run_in_threadpool(hash_password, password)
    try:
        u = await repo.create_user(UserRow(
            id=uuid.uuid4().hex, username=username, password_hash=ph, role=role,
            display_name=display_name))
    except DuplicateUsername:
        raise HTTPException(409, "用户名已存在") from None
    return u.public()


@users_router.patch("/{uid}")
async def patch_user(uid: str, body: dict, repo: RepoDep):
    target = await repo.get_user(uid)
    if target is None:
        raise HTTPException(404, "用户不存在")
    role = body.get("role")
    active = body.get("active")
    role = role if role in ("admin", "user") else None
    active = active if isinstance(active, bool) else None
    # 防锁死：不能把最后一个在用管理员降级或停用。
    demote = (role == "user" or active is False) and target.role == "admin" and target.active
    if demote:
        admins = await _active_admins(repo)
        if len(admins) <= 1 and admins and admins[0].id == uid:
            raise HTTPException(409, "不能降级或停用最后一个管理员")
    u = await repo.update_user(uid, role=role, active=active)
    if active is False:                       # 停用即时踢掉其全部登录会话
        await repo.delete_user_auth_sessions(uid)
    return u.public()


@users_router.post("/{uid}/reset-password")
async def reset_password(uid: str, body: dict, repo: RepoDep):
    if await repo.get_user(uid) is None:
        raise HTTPException(404, "用户不存在")
    password = str(body.get("password", ""))
    if not password:
        raise HTTPException(400, "密码不能为空")
    ph = await run_in_threadpool(hash_password, password)
    await repo.update_user(uid, password_hash=ph)
    await repo.delete_user_auth_sessions(uid)  # 强制该用户重新登录
    return {"ok": True}


@users_router.delete("/{uid}")
async def delete_user(uid: str, request: Request, repo: RepoDep):
    admin = require_admin(request)
    if uid == admin.id:
        raise HTTPException(409, "不能删除自己")
    target = await repo.get_user(uid)
    if target is None:
        raise HTTPException(404, "用户不存在")
    if target.role == "admin" and target.active:
        admins = await _active_admins(repo)
        if len(admins) <= 1:
            raise HTTPException(409, "不能删除最后一个管理员")
    await repo.delete_user(uid)
    return {"ok": True}


__all__ = [
    "COOKIE",
    "SYNTHETIC_ADMIN",
    "auth_middleware",
    "cors_origins",
    "require_admin",
    "require_user",
    "resolve_cookie_user",
    "router",
    "users_router",
]
