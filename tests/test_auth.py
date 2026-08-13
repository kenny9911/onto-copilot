"""鉴权原语单测（散列 / 令牌 / 规范化）。

HTTP 登录流程、中间件门禁、账号 CRUD 的端到端测试在 P2 一并补上；这里只钉住
纯函数的性质：加盐、常数时间校验、损坏输入不抛、令牌高熵且哈希可复算。
"""

from __future__ import annotations

import argparse
import io
import uuid

import httpx
import pytest

from ontocopilot import appconfig, authgate, server
from ontocopilot.auth import (
    hash_password,
    mint_token,
    normalize_username,
    token_hash,
    verify_password,
)
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
                          json={"username": "alice", "display_name": "Alice", "password": "pw-alice-1"})
        assert r1.status_code == 200 and r1.json()["user"]["role"] == "admin"   # 首个=管理员
        me = await c.get("/api/me")                                             # 注册即登录
        assert me.status_code == 200 and me.json()["username"] == "alice"
        c.cookies.clear()
        r2 = await c.post("/api/register",
                          json={"username": "bob", "display_name": "Bob", "password": "pw-bob-1"})
        assert r2.status_code == 200 and r2.json()["user"]["role"] == "user"    # 其余=普通


async def test_register_duplicate_and_validation(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    async with _client(MemoryRepo()) as c:
        await c.post("/api/register", json={"username": "alice", "display_name": "Alice", "password": "pw-alice-1"})
        c.cookies.clear()
        # 规范化后重名 → 409
        assert (await c.post("/api/register",
                json={"username": "Alice", "display_name": "Alice", "password": "another"})).status_code == 409
        assert (await c.post("/api/register",
                json={"username": "", "password": "pw-xxxx"})).status_code == 400
        assert (await c.post("/api/register",
                json={"username": "z", "display_name": "Z", "password": "123"})).status_code == 400   # 密码太短


async def test_session_isolation_between_accounts(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        alice = (await c.post("/api/register",
                 json={"username": "alice", "display_name": "Alice", "password": "pw-alice-1"})).json()["user"]
        # 直接在库里塞一个 alice 的会话（避开建会话路由对磁盘的依赖）
        await repo.create_session(
            SessionRow(id="sess_a", title="A", owner=alice["id"], created=1000.0))
        assert any(x["id"] == "sess_a" for x in (await c.get("/api/sessions")).json())
        # 换 bob
        c.cookies.clear()
        await c.post("/api/register", json={"username": "bob", "display_name": "Bob", "password": "pw-bob-1"})
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
                         json={"username": "yuhan", "display_name": "Yuhan", "password": "pw-yuhan-1"})
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
        await c.post("/api/register", json={"username": "alice", "display_name": "Alice", "password": "pw-alice-1"})
        c.cookies.clear()

        r = await c.post("/api/register", json={"username": "bob", "display_name": "Bob", "password": "pw-bob-11"})
        assert r.status_code == 200 and r.json()["adopted_sessions"] == 0
        assert (await c.get("/api/sessions")).json() == []
        assert (await c.get(f"/api/sessions/{sid}/state")).status_code == 404


async def test_change_password_accepts_exactly_what_the_ui_sends(monkeypatch):
    """前端发 {old_password,new_password} 而端点读 {old,new} 时，new 恒为空，
    服务端在校验旧密码之前就 400「新密码不能为空」，界面把它翻成"改不了，稍后
    再试" —— 每个人、每一次。契约两头都钉住，光测端点是测不出来的。"""
    import pathlib
    import re

    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        await c.post("/api/register", json={"username": "yuhan", "display_name": "Yuhan", "password": "pw-old-11"})

        # 前端源码里那次 POST 用的字段名
        ui = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "index.html").read_text()
        body = re.search(r'/api/me/password[\s\S]{0,400}?JSON\.stringify\((\{[^}]*\})',
                         ui).group(1)
        keys = set(re.findall(r'(\w+)\s*:', body))
        assert keys == {"old", "new"}, f"前端发的是 {keys}，端点读的是 old/new"

        r = await c.post("/api/me/password", json={"old": "pw-old-11", "new": "pw-new-11"})
        assert r.status_code == 200

        # 改完旧密码立刻失效、新密码可用（且旧 cookie 被踢掉）
        c.cookies.clear()
        assert (await c.post("/api/login",
                json={"username": "yuhan", "password": "pw-old-11"})).status_code == 401
        assert (await c.post("/api/login",
                json={"username": "yuhan", "password": "pw-new-11"})).status_code == 200


async def test_cli_created_first_admin_also_adopts_open_mode_sessions(monkeypatch, tmp_path):
    """文档和 CLI 帮助都还写着首个管理员用 `ontocopilot useradd --admin` 建。
    认领只做在 /api/register 里的话，照文档操作的人就会数据全丢。"""
    from ontocopilot.authgate import adopt_local_sessions

    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    async with _client(repo) as c:
        made = [(await c.post("/api/sessions", json={"title": f"t{i}"})).json()["id"]
                for i in range(2)]
        admin = await _mk_user(repo, "bob", "pw-bob-111", role="admin")
        assert await adopt_local_sessions(repo, admin) == 2

        rows = await repo.list_sessions(owner=admin.id)
        assert sorted(r.id for r in rows) == sorted(made)


async def test_cli_can_recover_a_locked_out_instance(tmp_path, monkeypatch, capsys):
    """忘了首个管理员的密码，以前是**没有出口的死结**：改密码要先登录、管理员
    重置别人密码也要先登录，而登录正是进不去的那一步。宿主机上必须有条路。"""
    from ontocopilot import cli
    from ontocopilot.auth import verify_password
    from ontocopilot.store.engine import Store
    from ontocopilot.store.repo import build_repo

    monkeypatch.setenv("ONTOCOPILOT_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("ONTOCOPILOT_DATABASE_URL", raising=False)
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("first-pw-1\n"))
    assert await cli.cmd_useradd(argparse.Namespace(
        username="root", admin=True, password_stdin=True)) == 0

    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("recovered-pw\n"))
    assert await cli.cmd_passwd(argparse.Namespace(
        username="root", password_stdin=True)) == 0

    store = await Store.open(f"sqlite+aiosqlite:///{tmp_path / 'ontocopilot.db'}")
    try:
        u = await build_repo(store).get_user_by_username("root")
        assert verify_password("recovered-pw", u.password_hash)
        assert not verify_password("first-pw-1", u.password_hash)
    finally:
        await store.close()

    # 太短的密码要拒绝，别人的账号不存在也要说清
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("abc\n"))
    assert await cli.cmd_passwd(argparse.Namespace(
        username="root", password_stdin=True)) == 1
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("whatever-1\n"))
    assert await cli.cmd_passwd(argparse.Namespace(
        username="ghost", password_stdin=True)) == 1


async def test_cli_role_change_refuses_to_lock_everyone_out(tmp_path, monkeypatch):
    """网关设置和账户管理都是管理员专属。把最后一个管理员降级 = 把所有人锁在
    门外，而且没有任何界面能救回来。"""
    from ontocopilot import cli
    from ontocopilot.store.engine import Store
    from ontocopilot.store.repo import build_repo

    monkeypatch.setenv("ONTOCOPILOT_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("ONTOCOPILOT_DATABASE_URL", raising=False)
    for name, admin in (("root", True), ("admin", False)):
        monkeypatch.setattr(cli.sys, "stdin", io.StringIO(f"pw-{name}-11\n"))
        await cli.cmd_useradd(argparse.Namespace(
            username=name, admin=admin, password_stdin=True))

    # 普通用户提成管理员 —— 这正是"我登的号看不到网关"的解法
    assert await cli.cmd_role(argparse.Namespace(
        username="admin", admin=True, user=False)) == 0
    assert await cli.cmd_role(argparse.Namespace(
        username="root", admin=False, user=True)) == 0     # 还剩一个管理员，放行
    assert await cli.cmd_role(argparse.Namespace(
        username="admin", admin=False, user=True)) == 1    # 最后一个，拦住

    store = await Store.open(f"sqlite+aiosqlite:///{tmp_path / 'ontocopilot.db'}")
    try:
        repo = build_repo(store)
        assert (await repo.get_user_by_username("admin")).role == "admin"
    finally:
        await store.close()


# ══════════════════════════════════════════════════════════════════
#  名字：注册时收，界面上用来称呼人
# ══════════════════════════════════════════════════════════════════
async def test_display_name_reaches_the_one_endpoint_the_ui_reads(monkeypatch):
    """身份投影有四份（public / me / auth.status / 前端兜底），各写各的。

    空状态那句问候语的名字**只能从 /api/auth/status 拿到** —— 它是页面加载时
    唯一无条件调用的身份端点。只改 UserRow.public() 的话测试能绿，界面上永远空白。
    """
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        r = await c.post("/api/register", json={
            "username": "yuhan", "display_name": "程宇涵", "password": "pw-yuhan-1"})
        assert r.status_code == 200
        assert r.json()["user"]["display_name"] == "程宇涵"          # public()
        assert (await c.get("/api/me")).json()["display_name"] == "程宇涵"
        st = (await c.get("/api/auth/status")).json()
        assert st["user"]["display_name"] == "程宇涵"                # 界面真正读的那份


async def test_display_name_is_kept_verbatim_not_lowercased(monkeypatch):
    """username 走 strip().lower()，名字**不能**跟着走 ——
    这一列存在的全部意义就是原样称呼人。顺便折叠掉换行/制表/连续空格。"""
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        r = await c.post("/api/register", json={
            "username": "  Yuhan ", "display_name": "  Yuhan   Cheng \n",
            "password": "pw-yuhan-1"})
        assert r.status_code == 200
        u = r.json()["user"]
        assert u["username"] == "yuhan"                  # 登录标识照旧归一
        assert u["display_name"] == "Yuhan Cheng"        # 称呼原样保留大小写


async def test_registration_requires_a_name(monkeypatch):
    """用户要的就是"注册时让人写上自己的名字"。空的、纯空白的都不算填了。"""
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        for name in ("", "   ", "\n\t"):
            r = await c.post("/api/register", json={
                "username": "yuhan", "display_name": name, "password": "pw-yuhan-1"})
            assert r.status_code == 400, name
            assert "名字" in r.json()["detail"]


async def test_display_name_length_is_capped(monkeypatch):
    """自由文本要有上限：它会出现在问候语和账号列表里，撑破的是布局。"""
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        assert (await c.post("/api/register", json={
            "username": "a", "display_name": "名" * 40, "password": "pw-aaaa-1"},
        )).status_code == 200
        assert (await c.post("/api/register", json={
            "username": "b", "display_name": "名" * 41, "password": "pw-bbbb-1"},
        )).status_code == 400


async def test_admin_created_accounts_may_omit_the_name(monkeypatch):
    """管理员替别人建号时多半只知道登录名。不强制，展示时回落到 username。"""
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        await c.post("/api/register", json={
            "username": "admin", "display_name": "Admin", "password": "admin-pw-1"})
        r = await c.post("/api/users", json={"username": "carol", "password": "carol-pw"})
        assert r.status_code == 200
        assert r.json()["display_name"] == ""
        # 管理员愿意填也收得下
        r2 = await c.post("/api/users", json={
            "username": "dave", "display_name": "Dave Li", "password": "dave-pw"})
        assert r2.json()["display_name"] == "Dave Li"


async def test_register_sends_exactly_what_the_endpoint_reads(monkeypatch):
    """前端发 name 而后端读 display_name 时，裸 dict **静默丢弃**未知键 ——
    200、cookie 也发了，名字没了，每个人每一次注册都如此。契约两头都要钉。"""
    import pathlib
    import re

    ui = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "index.html").read_text()
    body = re.search(r'/api/register[\s\S]{0,400}?JSON\.stringify\((\{[^}]*\})',
                     ui).group(1)
    keys = set(re.findall(r'(\w+)\s*:', body))
    assert keys == {"username", "password", "display_name"}, f"前端发的是 {keys}"


async def test_public_projection_carries_the_name_but_never_the_hash(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        await c.post("/api/register", json={
            "username": "admin", "display_name": "Admin", "password": "admin-pw-1"})
        rows = (await c.get("/api/users")).json()
        assert rows and all("display_name" in u for u in rows)
        assert all("password_hash" not in u for u in rows)


async def test_profile_edit_changes_the_name_not_the_account(monkeypatch):
    """账号是账号，资料是资料。

    username 是登录标识，改了会影响登录，个人资料这条路**不碰它**；
    名字只是个称呼，随时能改。注册时填错一个字不该是一锤子买卖。
    """
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        await c.post("/api/register", json={
            "username": "yuhan", "display_name": "程宇函", "password": "pw-yuhan-1"})

        r = await c.post("/api/me/profile", json={"display_name": "程宇涵"})
        assert r.status_code == 200
        assert r.json()["user"]["display_name"] == "程宇涵"
        assert r.json()["user"]["username"] == "yuhan"      # 账号没动

        # 界面读的是 auth/status，改完必须立刻反映在那儿
        st = (await c.get("/api/auth/status")).json()
        assert st["user"]["display_name"] == "程宇涵"
        assert st["user"]["username"] == "yuhan"

        # 改称呼不是安全事件 —— 不该把人踢下线（对比改密码）
        assert (await c.get("/api/me")).status_code == 200


async def test_profile_edit_applies_the_same_rules_as_registration(monkeypatch):
    """同一个 clean_display_name：空白折叠、不 lower、40 字上限。"""
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    async with _client(repo) as c:
        await c.post("/api/register", json={
            "username": "yuhan", "display_name": "Yuhan", "password": "pw-yuhan-1"})

        assert (await c.post("/api/me/profile", json={"display_name": "  "})
                ).status_code == 400
        assert (await c.post("/api/me/profile", json={"display_name": "名" * 41})
                ).status_code == 400
        r = await c.post("/api/me/profile", json={"display_name": "  Yuhan   Cheng \n"})
        assert r.json()["user"]["display_name"] == "Yuhan Cheng"


async def test_open_mode_has_no_profile_to_edit(monkeypatch):
    """本地模式的合成管理员不落库，改它没有意义（和改密码同一个判断）。"""
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    repo = MemoryRepo()
    async with _client(repo) as c:
        r = await c.post("/api/me/profile", json={"display_name": "谁"})
        assert r.status_code == 400
        assert "开放模式" in r.json()["detail"]


async def test_profile_sends_exactly_what_the_endpoint_reads(monkeypatch):
    """裸 dict 会静默丢掉不认识的键 —— 前端发 name 而端点读 display_name 的话，
    保存成功、名字没变，用户只会以为这个功能坏了。"""
    import pathlib
    import re

    ui = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "index.html").read_text()
    body = re.search(r'/api/me/profile[\s\S]{0,400}?JSON\.stringify\((\{[^}]*\})',
                     ui).group(1)
    assert set(re.findall(r'(\w+)\s*:', body)) == {"display_name"}


async def test_first_registration_also_adopts_the_projects_made_in_open_mode(
    monkeypatch, tmp_path,
):
    """会话被认领、项目没有 —— 用户看到的是「文件夹没了、会话散了一屏」。

    这和上面那条「建号那一秒数据全丢」是同一个失败模式，只是少丢一层：会话还在，
    但项目按 owner 过滤后一个都列不出来，归属它们的会话全部掉回「未归类」。
    """
    from ontocopilot.authgate import adopt_local_sessions
    from ontocopilot.store.repo import ProjectRow

    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "开放模式建的"})).json()["id"]
        # 开放模式下建的项目，归属是空的
        await repo.create_project(ProjectRow(id="p1", name="中广核112项目", owner=""))
        await repo.assign_session(sid, "p1")

        admin = await _mk_user(repo, "carol", "pw-carol-11", role="admin")
        assert await adopt_local_sessions(repo, admin) == 1

        assert [p.name for p in await repo.list_projects(owner=admin.id)] == ["中广核112项目"]
        # 会话仍然待在那个项目里，没有掉回「未归类」
        assert (await repo.get_session(sid)).project_id == "p1"
