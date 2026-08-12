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
from ontocopilot import server
from ontocopilot.server import app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, SessionRow, UserRow


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
        assert j["auth_enabled"] and j["first_user_is_admin"] and not j["authenticated"]


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


# ══════════════════════════════════════════════════════════════════
#  自助注册 + 会话按账号隔离
# ══════════════════════════════════════════════════════════════════
async def test_register_first_is_admin_rest_user(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    async with _client(MemoryRepo()) as c:
        r1 = await c.post("/api/register",
                          json={"username": "alice", "password": "pw-alice-1"})
        assert r1.status_code == 200 and r1.json()["user"]["role"] == "admin"   # 首个=管理员
        me = await c.get("/api/me")                                             # 注册即登录
        assert me.status_code == 200 and me.json()["username"] == "alice"
        c.cookies.clear()
        r2 = await c.post("/api/register",
                          json={"username": "bob", "password": "pw-bob-1"})
        assert r2.status_code == 200 and r2.json()["user"]["role"] == "user"    # 其余=普通


async def test_register_duplicate_and_validation(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    async with _client(MemoryRepo()) as c:
        await c.post("/api/register", json={"username": "alice", "password": "pw-alice-1"})
        c.cookies.clear()
        # 规范化后重名 → 409
        assert (await c.post("/api/register",
                json={"username": "Alice", "password": "another"})).status_code == 409
        assert (await c.post("/api/register",
                json={"username": "", "password": "pw-xxxx"})).status_code == 400
        assert (await c.post("/api/register",
                json={"username": "z", "password": "123"})).status_code == 400   # 密码太短


async def test_session_isolation_between_accounts(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        alice = (await c.post("/api/register",
                 json={"username": "alice", "password": "pw-alice-1"})).json()["user"]
        # 直接在库里塞一个 alice 的会话（避开建会话路由对磁盘的依赖）
        await repo.create_session(
            SessionRow(id="sess_a", title="A", owner=alice["id"], created=1000.0))
        assert any(x["id"] == "sess_a" for x in (await c.get("/api/sessions")).json())
        # 换 bob
        c.cookies.clear()
        await c.post("/api/register", json={"username": "bob", "password": "pw-bob-1"})
        assert (await c.get("/api/sessions")).json() == []                 # 看不到 alice 的
        assert (await c.get("/api/sessions/sess_a/state")).status_code == 404  # 也访问不了


async def test_open_mode_has_no_isolation(monkeypatch):
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    repo = MemoryRepo()
    async with _client(repo) as c:
        assert (await c.get("/api/auth/status")).json()["registration_open"] is True
        await repo.create_session(SessionRow(id="s_open", owner="whoever", created=1.0))
        # 开放模式（合成管理员）不隔离 —— 看得到别人 owner 的会话
        assert any(x["id"] == "s_open" for x in (await c.get("/api/sessions")).json())


async def test_first_registration_adopts_the_sessions_made_in_open_mode(monkeypatch, tmp_path):
    """开放模式下干了一天活的人，点一下"创建账户"，不该看见自己的东西全没了。

    建号这个动作会顺带把整个实例翻进强制鉴权（有账号就强制）。而开放模式下建的
    会话归属都记的是合成管理员 `__local__` —— 一旦强制，列表按真实 user id 过滤、
    中间件对不属于你的会话回 404。从用户视角，那就是他自己点了个按钮然后数据没了。
    """
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    # 开放模式的列表还会合并"盘上的孤儿目录"，不隔离出来就会读到真实 workspace
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    async with _client(repo) as c:
        assert (await c.get("/api/auth/status")).json()["auth_enabled"] is False
        made = [(await c.post("/api/sessions", json={"title": f"梳理 {i}"})).json()["id"]
                for i in range(3)]
        assert len((await c.get("/api/sessions")).json()) == 3

        r = await c.post("/api/register",
                         json={"username": "yuhan", "password": "pw-yuhan-1"})
        assert r.status_code == 200
        assert r.json()["adopted_sessions"] == 3      # 认领这件事要说出来，不是悄悄做

        # 注册即登录，且实例已翻进强制鉴权 —— 会话必须还在，而且还能打开
        assert (await c.get("/api/auth/status")).json()["auth_enabled"] is True
        after = [s["id"] for s in (await c.get("/api/sessions")).json()]
        assert sorted(after) == sorted(made)
        for sid in made:
            assert (await c.get(f"/api/sessions/{sid}/state")).status_code == 200


async def test_second_account_does_not_inherit_anyone_elses_sessions(monkeypatch, tmp_path):
    """认领只发生在**首个**账号身上。第二个人注册时把别人的会话收走，
    就从"不丢数据"变成了"越权看别人的东西"。"""
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "alice 的活"})).json()["id"]
        await c.post("/api/register", json={"username": "alice", "password": "pw-alice-1"})
        c.cookies.clear()

        r = await c.post("/api/register", json={"username": "bob", "password": "pw-bob-11"})
        assert r.status_code == 200 and r.json()["adopted_sessions"] == 0
        assert (await c.get("/api/sessions")).json() == []
        assert (await c.get(f"/api/sessions/{sid}/state")).status_code == 404
