"""鉴权原语单测（散列 / 令牌 / 规范化）。

HTTP 登录流程、中间件门禁、账号 CRUD 的端到端测试在 P2 一并补上；这里只钉住
纯函数的性质：加盐、常数时间校验、损坏输入不抛、令牌高熵且哈希可复算。
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from ontocopilot import appconfig, authgate
from ontocopilot.auth import (
    hash_password,
    mint_token,
    normalize_username,
    token_hash,
    verify_password,
)
from ontocopilot.server import app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, UserRow


def test_hash_is_salted_and_verifies():
    h1 = hash_password("hunter2")
    h2 = hash_password("hunter2")
    assert h1 != h2                       # 每次不同盐 → 同口令不同散列
    assert h1.startswith("scrypt$")
    assert verify_password("hunter2", h1)
    assert verify_password("hunter2", h2)


def test_wrong_password_fails():
    h = hash_password("correct horse")
    assert not verify_password("Correct Horse", h)   # 大小写敏感
    assert not verify_password("", h)


def test_malformed_hash_is_false_not_error():
    assert not verify_password("x", "not-a-hash")
    assert not verify_password("x", "bcrypt$whatever")
    assert not verify_password("x", "scrypt$bad")


def test_empty_password_rejected():
    with pytest.raises(ValueError):
        hash_password("")


def test_normalize_username():
    assert normalize_username("  Alice ") == "alice"
    assert normalize_username("BOB@Example.com") == "bob@example.com"


def test_mint_token_hash_matches():
    tok, th = mint_token()
    assert token_hash(tok) == th
    assert len(th) == 64                  # sha256 十六进制
    tok2, th2 = mint_token()
    assert tok != tok2 and th != th2      # 高熵、不重复


# ══════════════════════════════════════════════════════════════════
#  HTTP 流程：中间件门禁 + 登录 + 账号 CRUD（ASGI，走内存仓储）
# ══════════════════════════════════════════════════════════════════
@pytest.fixture(autouse=True)
def _reset_auth_state():
    """每个用例前后清掉进程内限流计数、设置缓存与测试仓储，避免相互污染。"""
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    yield
    set_repo_for_tests(None)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}


def _client(repo: MemoryRepo) -> httpx.AsyncClient:
    set_repo_for_tests(repo)          # 中间件与路由都读这个模块级单例
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t")


async def _mk_user(repo, username, password, role="user"):
    u = UserRow(id=uuid.uuid4().hex, username=username,
                password_hash=hash_password(password), role=role)
    await repo.create_user(u)
    return u


async def test_open_mode_grants_synthetic_admin(monkeypatch):
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    async with _client(MemoryRepo()) as c:            # 零账号 → 开放模式
        assert (await c.get("/api/auth/status")).json()["auth_enabled"] is False
        me = await c.get("/api/me")
        assert me.status_code == 200 and me.json()["role"] == "admin"


async def test_enforced_blocks_protected_but_allows_allowlist(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    async with _client(MemoryRepo()) as c:
        assert (await c.get("/api/me")).status_code == 401          # 受保护
        assert (await c.get("/api/health")).status_code == 200      # allowlist
        j = (await c.get("/api/auth/status")).json()
        assert j["auth_enabled"] and j["bootstrap_needed"] and not j["authenticated"]


async def test_login_me_logout(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "s3cret-pw", role="admin")
    async with _client(repo) as c:
        assert (await c.post("/api/login",
                json={"username": "admin", "password": "wrong"})).status_code == 401
        ok = await c.post("/api/login",
                          json={"username": "Admin", "password": "s3cret-pw"})  # 大小写归一
        assert ok.status_code == 200 and ok.json()["user"]["username"] == "admin"
        assert "password_hash" not in ok.json()["user"]
        me = await c.get("/api/me")
        assert me.status_code == 200 and me.json()["role"] == "admin"
        assert (await c.post("/api/logout")).status_code == 200
        assert (await c.get("/api/me")).status_code == 401           # cookie 已清


async def test_inactive_account_is_generic_401(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    u = await _mk_user(repo, "bob", "pw-bob-123")
    await repo.update_user(u.id, active=False)
    async with _client(repo) as c:
        # 停用账号与"密码错"返回同一句 401 —— 不泄露账号是否存在/被停用。
        assert (await c.post("/api/login",
                json={"username": "bob", "password": "pw-bob-123"})).status_code == 401


async def test_admin_user_crud(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "admin", "password": "admin-pw-1"})
        r = await c.post("/api/users",
                         json={"username": "carol", "password": "carol-pw", "role": "user"})
        assert r.status_code == 200
        cid = r.json()["id"]
        assert (await c.post("/api/users",
                json={"username": "carol", "password": "x"})).status_code == 409   # dup
        users = (await c.get("/api/users")).json()
        assert {u["username"] for u in users} == {"admin", "carol"}
        assert all("password_hash" not in u for u in users)
        assert (await c.patch(f"/api/users/{cid}", json={"role": "admin"})).status_code == 200
        assert (await c.post(f"/api/users/{cid}/reset-password",
                json={"password": "new-pw"})).status_code == 200
        assert (await c.delete(f"/api/users/{cid}")).status_code == 200
        assert len((await c.get("/api/users")).json()) == 1


async def test_non_admin_forbidden_on_users(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    await _mk_user(repo, "bob", "bob-pw-1", role="user")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "bob", "password": "bob-pw-1"})
        assert (await c.get("/api/users")).status_code == 403
        assert (await c.post("/api/users",
                json={"username": "x", "password": "y"})).status_code == 403


async def test_last_admin_and_self_delete_guards(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    admin = await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "admin", "password": "admin-pw-1"})
        assert (await c.delete(f"/api/users/{admin.id}")).status_code == 409       # 删自己
        assert (await c.patch(f"/api/users/{admin.id}",
                json={"role": "user"})).status_code == 409                          # 降级末位管理员
        assert (await c.patch(f"/api/users/{admin.id}",
                json={"active": False})).status_code == 409                         # 停用末位管理员


async def test_login_throttle_kicks_in(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        codes = [(await c.post("/api/login",
                  json={"username": "admin", "password": "nope"})).status_code
                 for _ in range(12)]
        assert 429 in codes            # 超过窗口上限后限流


# ── 设置页后端（/api/config，仅管理员）──────────────────────────────
async def test_config_requires_admin(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    await _mk_user(repo, "bob", "bob-pw-1", role="user")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "bob", "password": "bob-pw-1"})
        assert (await c.get("/api/config")).status_code == 403


async def test_config_get_redacts_and_put_overrides(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    monkeypatch.setenv("CUSTOM_LLM_BASE_URL", "http://env:3010/v1")
    monkeypatch.setenv("CUSTOM_LLM_API_KEY", "sk-secretkey-1234")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "admin", "password": "admin-pw-1"})
        cfg = (await c.get("/api/config")).json()
        assert cfg["gateway"]["base_url"] == "http://env:3010/v1"
        assert "…" in cfg["gateway"]["api_key"] and "secretkey" not in cfg["gateway"]["api_key"]
        assert set(cfg["tiers"]) == {"low", "medium", "high", "critical"}
        # PUT：覆盖 high 档 + 改 base_url；api_key 原样把 redacted 送回 → 应被忽略。
        put = await c.put("/api/config", json={
            "base_url": "http://db:3010/v1",
            "api_key": cfg["gateway"]["api_key"],
            "models": {"high": "google/gemini-3.5-flash"},
            "usd_cap": 9.0})
        assert put.status_code == 200
        j = put.json()
        assert j["gateway"]["base_url"] == "http://db:3010/v1"
        assert j["tiers"]["high"]["model"] == "google/gemini-3.5-flash"
        assert j["tiers"]["high"]["effort"] is None        # effort 派生成 None（Flash）
        assert j["budget"]["usd_cap"] == 9.0
        assert await repo.get_setting("gateway.api_key") is None   # redacted 未被写回


async def test_config_api_key_write_only(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "admin", "password": "admin-pw-1"})
        await c.put("/api/config", json={"base_url": "http://x:3010/v1",
                                         "api_key": "sk-brand-new-key-9"})
        assert await repo.get_setting("gateway.api_key") == "sk-brand-new-key-9"
        cfg = (await c.get("/api/config")).json()
        assert "brand-new" not in cfg["gateway"]["api_key"]   # 回显仍 redacted


async def test_config_rejects_unknown_model(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "admin", "admin-pw-1", role="admin")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "admin", "password": "admin-pw-1"})
        assert (await c.put("/api/config",
                json={"models": {"high": "foo/nonexistent"}})).status_code == 400
