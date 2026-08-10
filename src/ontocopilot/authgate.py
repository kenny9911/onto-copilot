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


_PUBLIC_PATHS = frozenset({"/", "/api/health", "/api/login", "/api/auth/status"})


def _is_public(request: Request) -> bool:
    if request.method == "OPTIONS":          # CORS 预检放行
        return True
    return request.url.path in _PUBLIC_PATHS


async def auth_middleware(request: Request, call_next):
    """一道 fail-closed 门。解析用户挂到 ``request.state.user``。"""
    repo = get_repo()
    if not await _enforce(repo):
        request.state.user = SYNTHETIC_ADMIN     # 开放模式
        return await call_next(request)

    # 强制模式：总是先尝试解析 cookie（allowlist 也解析，好让 /auth/status 知道身份）
    request.state.user = await resolve_cookie_user(request, repo)
    if _is_public(request):
        return await call_next(request)
    if request.state.user is None:
        return JSONResponse({"error": "未登录", "code": "auth.required"}, status_code=401)
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


@router.post("/login")
async def login(request: Request, body: dict, repo: Repo = Depends(get_repo)):
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


@router.post("/logout")
async def logout(request: Request, repo: Repo = Depends(get_repo)):
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
            "active": user.active, "prefs": user.prefs}


@router.get("/auth/status")
async def auth_status(request: Request, repo: Repo = Depends(get_repo)):
    enforce = await _enforce(repo)
    user = getattr(request.state, "user", None)
    n = await repo.count_users()
    return {
        "auth_enabled": enforce,
        # 强制鉴权但零账号 = 被锁死，需宿主机 CLI 播种首个管理员。
        "bootstrap_needed": enforce and n == 0,
        "authenticated": user is not None,
        "user": ({"id": user.id, "username": user.username, "role": user.role,
                  "prefs": user.prefs} if user else None),
    }


@router.post("/me/password")
async def change_own_password(request: Request, body: dict, repo: Repo = Depends(get_repo)):
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


# ══════════════════════════════════════════════════════════════════
#  路由：账号管理（仅管理员）
# ══════════════════════════════════════════════════════════════════
users_router = APIRouter(prefix="/api/users", dependencies=[Depends(require_admin)])


async def _active_admins(repo: Repo) -> list[UserRow]:
    return [u for u in await repo.list_users() if u.role == "admin" and u.active]


@users_router.get("")
async def list_users(repo: Repo = Depends(get_repo)):
    return [u.public() for u in await repo.list_users()]


@users_router.post("")
async def create_user(body: dict, repo: Repo = Depends(get_repo)):
    username = normalize_username(str(body.get("username", "")))
    password = str(body.get("password", ""))
    role = body.get("role", "user")
    if not username or not password:
        raise HTTPException(400, "用户名和密码不能为空")
    if role not in ("admin", "user"):
        raise HTTPException(400, "角色只能是 admin 或 user")
    ph = await run_in_threadpool(hash_password, password)
    try:
        u = await repo.create_user(UserRow(
            id=uuid.uuid4().hex, username=username, password_hash=ph, role=role))
    except DuplicateUsername:
        raise HTTPException(409, "用户名已存在") from None
    return u.public()


@users_router.patch("/{uid}")
async def patch_user(uid: str, body: dict, repo: Repo = Depends(get_repo)):
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
async def reset_password(uid: str, body: dict, repo: Repo = Depends(get_repo)):
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
async def delete_user(uid: str, request: Request, repo: Repo = Depends(get_repo)):
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


__all__ = ["auth_middleware", "require_user", "require_admin", "router",
           "users_router", "cors_origins", "resolve_cookie_user", "COOKIE",
           "SYNTHETIC_ADMIN"]
