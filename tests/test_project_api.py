"""项目文件夹的服务层：路由、归属校验、会话列表字段、两档项目记忆。

盯的是「接错线」那一类事故，它们全都不会报错：
  · ``/api/projects`` 不在会话前缀下，中间件默认不管它 —— 登录就能改别人的项目；
  · 会话列表字段在三条分支各写一遍，漏一处就是"某些会话没有项目"；
  · 模型推断的参考档只要混进拍板序列，就会印在交给客户的交付包里。
"""

from __future__ import annotations

import json
import uuid
from typing import ClassVar

import httpx
import pytest

from ontocopilot import appconfig, authgate, server
from ontocopilot.auth import hash_password
from ontocopilot.kernel.memory.types import MemoryTier
from ontocopilot.server import SESSIONS, Session, app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, ProjectRow, SessionRow, UserRow


@pytest.fixture(autouse=True)
def _isolated_server(tmp_path, monkeypatch):
    """每个用例一份干净的仓储 / 工作区 / 进程内会话表。"""
    monkeypatch.setattr(server, "ROOT", tmp_path / "workspace")
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    SESSIONS.clear()
    yield
    set_repo_for_tests(None)
    SESSIONS.clear()
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}


def _client(repo: MemoryRepo) -> httpx.AsyncClient:
    set_repo_for_tests(repo)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t")


async def _mk_user(repo: MemoryRepo, username: str, password: str) -> UserRow:
    u = UserRow(id=uuid.uuid4().hex, username=username,
                password_hash=hash_password(password), role="user")
    await repo.create_user(u)
    return u


class _Ctx:
    approved = True
    pending: ClassVar[list] = []


class _Turn:
    """``_reason`` 的返回：只带 ``_chat_claimed`` 真正读的那几个字段。"""

    answer = "查到了。"
    citations: ClassVar[list] = []
    followup = ""
    steps: ClassVar[list] = []
    next_questions: ClassVar[list] = []


async def _fake_turn() -> _Turn:
    return _Turn()


async def _noop_prompts(s, **kw) -> None:
    """上传/回答后的推荐要走网关。这些用例只关心标题，别让它真去调模型。"""


# ══════════════════════════════════════════════════════════════════
#  路由
# ══════════════════════════════════════════════════════════════════
async def test_project_crud_moves_sessions_and_frees_them_on_delete():
    repo = MemoryRepo()
    async with _client(repo) as c:
        created = await c.post("/api/sessions", json={"title": "甲"})
        sid = created.json()["id"]
        assert created.json()["project_id"] == ""      # 新会话默认未归类

        pj = await c.post("/api/projects", json={"name": "采购中台"})
        assert pj.status_code == 200, pj.text
        pid = pj.json()["id"]

        moved = await c.patch(f"/api/sessions/{sid}", json={"project_id": pid})
        assert moved.status_code == 200 and moved.json()["project_id"] == pid
        listed = (await c.get("/api/projects")).json()["projects"]
        assert listed == [{"id": pid, "name": "采购中台", "sort_order": 0,
                           "sessions": 1}]

        assert (await c.patch(f"/api/projects/{pid}",
                              json={"name": "采购中台 v2"})).json()["name"] == "采购中台 v2"

        # 移出项目：null 和 "" 都算
        out = await c.patch(f"/api/sessions/{sid}", json={"project_id": None})
        assert out.json()["project_id"] == ""
        assert (await c.get("/api/projects")).json()["projects"][0]["sessions"] == 0

        await c.patch(f"/api/sessions/{sid}", json={"project_id": pid})
        gone = await c.delete(f"/api/projects/{pid}")
        # 删项目**不删会话** —— 它们掉回未归类，而且数量要如实报出来
        assert gone.json() == {"ok": True, "released": 1}
        assert (await c.get("/api/projects")).json()["projects"] == []
        rows = (await c.get("/api/sessions")).json()
        assert [r["id"] for r in rows] == [sid]
        assert rows[0]["project_id"] == ""
        assert SESSIONS[sid].project_id == ""   # 内存里那份也得跟着松开


async def test_moving_a_session_into_a_project_that_does_not_exist_is_404():
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "甲"})).json()["id"]
        r = await c.patch(f"/api/sessions/{sid}", json={"project_id": "不存在"})
        assert r.status_code == 404


async def test_moving_a_cold_session_does_not_hydrate_it():
    """把侧栏里一个冷会话拖进文件夹，不该把整个会话恢复一遍（重解析全部材料）。"""
    repo = MemoryRepo()
    async with _client(repo) as c:
        pid = (await c.post("/api/projects", json={"name": "P"})).json()["id"]
        sid = (await c.post("/api/sessions", json={"title": "冷的"})).json()["id"]
        SESSIONS.pop(sid)
        moved = await c.patch(f"/api/sessions/{sid}", json={"project_id": pid})
        assert moved.status_code == 200
        assert moved.json()["project_id"] == pid
        assert moved.json()["title"] == "冷的"
        assert sid not in SESSIONS                 # 没有被恢复
    assert (await repo.get_session(sid)).project_id == pid


async def test_creating_a_project_without_a_name_is_rejected():
    repo = MemoryRepo()
    async with _client(repo) as c:
        assert (await c.post("/api/projects", json={"name": "  "})).status_code == 400
        assert (await c.post("/api/projects", json={})).status_code == 400


# ══════════════════════════════════════════════════════════════════
#  归属校验（H21）
# ══════════════════════════════════════════════════════════════════
async def test_one_user_can_neither_read_nor_touch_another_users_project(monkeypatch):
    """``/api/projects/...`` 不在会话前缀下，中间件默认**不管它**。

    不补这道校验的话，任何登录用户都能列出、改名、删掉别人的项目 —— 删项目还会
    连带删掉别人的全部项目记忆，而界面上只会显示"删除成功"。
    """
    monkeypatch.setenv("ONTOCOPILOT_AUTH", "1")
    repo = MemoryRepo()
    await _mk_user(repo, "jia", "jia-pw-123")
    await _mk_user(repo, "yi", "yi-pw-123")
    async with _client(repo) as c:
        await c.post("/api/login", json={"username": "yi", "password": "yi-pw-123"})
        pid = (await c.post("/api/projects", json={"name": "乙的项目"})).json()["id"]
        yi_sid = (await c.post("/api/sessions", json={"title": "乙的会话"})).json()["id"]
        await c.post("/api/logout")

        await c.post("/api/login", json={"username": "jia", "password": "jia-pw-123"})
        assert (await c.get("/api/projects")).json()["projects"] == []   # 看不见
        assert (await c.patch(f"/api/projects/{pid}",
                              json={"name": "抢过来"})).status_code == 404
        assert (await c.delete(f"/api/projects/{pid}")).status_code == 404
        # 也不能把自己的会话塞进别人的项目 —— 那等于读到别人的项目记忆。
        # （请求**体**里的项目 id 中间件管不着，只能路由自己查。）
        jia_sid = (await c.post("/api/sessions", json={"title": "甲的会话"})).json()["id"]
        assert (await c.patch(f"/api/sessions/{jia_sid}",
                              json={"project_id": pid})).status_code == 404
        # 乙的会话本来就是 404（会话归属那道门）
        assert (await c.patch(f"/api/sessions/{yi_sid}",
                              json={"project_id": pid})).status_code == 404

    # 乙的项目一根毫毛都没少
    assert (await repo.get_project(pid)).name == "乙的项目"
    assert (await repo.get_session(yi_sid)).project_id == ""


# ══════════════════════════════════════════════════════════════════
#  会话列表的三条分支（H20）
# ══════════════════════════════════════════════════════════════════
async def test_every_session_list_branch_carries_project_id(tmp_path):
    """列表字段在三条分支各写一遍：内存活会话 / 库行 / 盘上孤儿目录。"""
    repo = MemoryRepo()
    async with _client(repo) as c:
        pid = (await c.post("/api/projects", json={"name": "P"})).json()["id"]
        live = (await c.post("/api/sessions", json={"title": "活着的"})).json()["id"]
        cold = (await c.post("/api/sessions", json={"title": "冷的"})).json()["id"]
        await c.patch(f"/api/sessions/{live}", json={"project_id": pid})
        await c.patch(f"/api/sessions/{cold}", json={"project_id": pid})
        SESSIONS.pop(cold)                       # 冷会话：只剩库行，走第二条分支
        (server.ROOT / "orphan-dir").mkdir(parents=True, exist_ok=True)

        rows = {r["id"]: r for r in (await c.get("/api/sessions")).json()}

    assert rows[live]["project_id"] == pid                 # live.brief()
    assert rows[cold]["project_id"] == pid                 # 库行
    assert rows[cold]["hydrated"] is False
    assert rows["orphan-dir"]["project_id"] == ""          # 孤儿目录
    assert rows["orphan-dir"]["orphan"] is True


# ══════════════════════════════════════════════════════════════════
#  会话标题：手动改名 + 自动命名
# ══════════════════════════════════════════════════════════════════
#  侧栏里一屏六个「新会话」，用户认不出哪个是哪个。名字要么他自己起，要么系统
#  按确定性规则起（材料名 > 第一句话）—— 但**他起过的名字永远不许被覆盖**。
async def _renamed_titles(repo: MemoryRepo, sid: str) -> list[str]:
    return [e.payload["title"] for e in await repo.read_events(sid, since=0)
            if e.kind == "session.renamed"]


async def test_renaming_a_session_lands_in_the_repo_and_reaches_the_sidebar():
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "新会话"})).json()["id"]
        r = await c.patch(f"/api/sessions/{sid}", json={"title": "  采购计划\n梳理  "})
        assert r.status_code == 200, r.text
        assert r.json()["title"] == "采购计划 梳理"     # 空白折叠，换行不进标题
        assert (await repo.get_session(sid)).title == "采购计划 梳理"
        assert SESSIONS[sid].title == "采购计划 梳理"   # 内存态与库行同步
        # 侧栏/顶栏要**立刻**变，所以改名要发一条 SSE，不能等下次刷新
        assert await _renamed_titles(repo, sid) == ["采购计划 梳理"]


async def test_renaming_a_cold_session_does_not_hydrate_it():
    """在侧栏给一个冷会话改名，不该把整个会话恢复一遍（重解析全部材料）。"""
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "新会话"})).json()["id"]
        SESSIONS.pop(sid)
        r = await c.patch(f"/api/sessions/{sid}", json={"title": "冷着也能改"})
        assert r.status_code == 200 and r.json()["title"] == "冷着也能改"
        assert sid not in SESSIONS                     # 没有被恢复
    assert (await repo.get_session(sid)).title == "冷着也能改"
    assert await _renamed_titles(repo, sid) == ["冷着也能改"]


async def test_an_empty_or_absurdly_long_title_is_rejected():
    """空标题在侧栏就是一行看不见的会话，比「新会话」更难认；超长多半是误粘。"""
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "原名"})).json()["id"]
        assert (await c.patch(f"/api/sessions/{sid}",
                              json={"title": "   "})).status_code == 400
        assert (await c.patch(f"/api/sessions/{sid}",
                              json={"title": "长" * 121})).status_code == 400
        assert (await c.patch(f"/api/sessions/{sid}", json={})).status_code == 400
        assert (await repo.get_session(sid)).title == "原名"


async def test_a_session_is_named_after_its_first_material(monkeypatch):
    """一档规则：工作会话围着材料转，文件名比任何模型总结都准 —— 而且免费。"""
    monkeypatch.setattr(server, "_emit_ai_prompts", _noop_prompts)
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "新会话"})).json()["id"]
        r = await c.post(f"/api/sessions/{sid}/files", files=[
            ("files", ("采购计划管理实体及业务规则梳理-v2.xlsx", b"x", "application/octet-stream")),
            ("files", ("附件说明.docx", b"y", "application/octet-stream")),
        ])
        assert r.status_code == 200, r.text
    want = "采购计划管理实体及业务规则梳理-v2 等 2 份"
    assert (await repo.get_session(sid)).title == want
    assert await _renamed_titles(repo, sid) == [want]


async def test_a_session_without_materials_is_named_after_the_first_sentence(
        monkeypatch, tmp_path):
    """二档规则：没材料就用第一句话切出的第一个短句。"""
    monkeypatch.setattr(server, "_emit_ai_prompts", _noop_prompts)
    monkeypatch.setattr(server, "_reason", lambda *a, **k: _fake_turn())
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions",
                            json={"title": "新对话", "mode": "chat"})).json()["id"]
        first = await c.post(f"/api/sessions/{sid}/chat",
                             json={"text": "采购计划怎么建模？顺便说说结算"})
        assert first.status_code == 200, first.text
        assert (await repo.get_session(sid)).title == "采购计划怎么建模"
        # 第二轮不再改名 —— 名字已经有了，不是默认值
        await c.post(f"/api/sessions/{sid}/chat", json={"text": "那结算呢"})
    assert (await repo.get_session(sid)).title == "采购计划怎么建模"
    assert await _renamed_titles(repo, sid) == ["采购计划怎么建模"]


def test_a_first_sentence_without_punctuation_is_cut_not_dropped():
    """没有标点的长句要截断，不是整句灌进侧栏；英文也不能按空格切成一个词。"""
    assert server._title_from_text("采购" * 30) == "采购" * 10 + "…"
    assert server._title_from_text("How do we model purchase orders") == \
        "How do we model purc…"
    assert server._title_from_text("   ") == ""


async def test_auto_naming_never_overwrites_a_name_the_user_chose(monkeypatch):
    """他改名字就是因为自动那个不好；再被盖回去是最惹人烦的一类 bug。"""
    monkeypatch.setattr(server, "_emit_ai_prompts", _noop_prompts)
    repo = MemoryRepo()
    async with _client(repo) as c:
        sid = (await c.post("/api/sessions", json={"title": "新会话"})).json()["id"]
        await c.patch(f"/api/sessions/{sid}", json={"title": "老王那个项目"})
        await c.post(f"/api/sessions/{sid}/files", files=[
            ("files", ("采购计划.xlsx", b"x", "application/octet-stream"))])
    assert (await repo.get_session(sid)).title == "老王那个项目"
    assert await _renamed_titles(repo, sid) == ["老王那个项目"]


# ══════════════════════════════════════════════════════════════════
#  R5：聊天会话不进项目
# ══════════════════════════════════════════════════════════════════
async def test_chat_sessions_can_never_join_a_project():
    repo = MemoryRepo()
    async with _client(repo) as c:
        pid = (await c.post("/api/projects", json={"name": "P"})).json()["id"]
        chat = (await c.post("/api/sessions",
                             json={"title": "闲聊", "mode": "chat"})).json()
        assert chat["project_id"] == ""
        r = await c.patch(f"/api/sessions/{chat['id']}", json={"project_id": pid})
        assert r.status_code == 400
        assert (await repo.get_session(chat["id"])).project_id == ""
        # 移出（空值）对聊天会话仍然合法 —— 那本来就是它的状态，不该报错
        assert (await c.patch(f"/api/sessions/{chat['id']}",
                              json={"project_id": None})).status_code == 200


async def test_chat_to_work_keeps_the_source_project_id():
    """转工作时 ``project`` 照旧硬写空串（那是产物上的客户项目名），
    ``project_id`` 则跟着源会话走。"""
    repo = MemoryRepo()
    async with _client(repo) as c:
        chat = (await c.post("/api/sessions",
                             json={"title": "闲聊", "mode": "chat"})).json()
        work = (await c.post(f"/api/sessions/{chat['id']}/to_work")).json()
    row = await repo.get_session(work["id"])
    assert row.project_id == SESSIONS[chat["id"]].project_id == ""
    assert row.project == ""


# ══════════════════════════════════════════════════════════════════
#  记忆写入：拍板 → 权威档，run 收尾 → 参考档
# ══════════════════════════════════════════════════════════════════
async def test_recorded_decision_becomes_project_authoritative_memory(tmp_path):
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    await repo.create_project(ProjectRow(id="p1", name="采购中台", owner=""))
    s = Session(id="s1", title="口径会话", project_id="p1")
    s.dir.mkdir(parents=True, exist_ok=True)
    await repo.create_session(SessionRow(id=s.id, title=s.title, project_id="p1"))
    SESSIONS[s.id] = s
    reg = server._converse_tools(s)
    # 跨项目生效的约定必须指得出用户说过哪句话 —— 先让他说，再引他的原话。
    server._dialogue(s).say("user", "金额一律按含税年度累计算，别的口径都不要")

    out = await reg.call("decision.record",
                         {"kind": "caliber", "statement": "金额一律含税年度累计",
                          "quote": "金额一律按含税年度累计算"},
                         _Ctx(), scope="converse")
    assert "同项目的其它会话也会看到" in out["生效范围"]

    rows = await repo.list_project_memory("p1")
    assert [r.tier for r in rows] == [str(MemoryTier.AUTHORITATIVE)]
    assert rows[0].content.startswith("金额一律含税年度累计")
    assert rows[0].origin_session == "口径会话"

    # 「纠正」不跨会话：它是就事论事的，固化成项目约束会让同项目的下一个会话
    # 继承一堆和它无关的结论（PROMOTABLE 的判据）。
    server._dialogue(s).say("user", "第 3 行那个字段写错了")
    await reg.call("decision.record",
                   {"kind": "correction", "statement": "第 3 行那个字段写错了",
                    "quote": "第 3 行那个字段写错了"},
                   _Ctx(), scope="converse")
    assert len(await repo.list_project_memory("p1")) == 1


async def test_a_second_session_recalls_what_the_first_one_settled(tmp_path):
    """同一项目下的下一个会话，装配上下文时要真的能召回上一个会话拍的板。

    Run 里挂上去的是 ``ProjectMemory.store``（``ContextManager(long_term=...)``），
    所以这里走的就是那条路：装载 → 召回。
    """
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    await repo.create_project(ProjectRow(id="p1", name="采购中台", owner=""))
    first = Session(id="s1", title="第一个会话", project_id="p1")
    first.dir.mkdir(parents=True, exist_ok=True)
    await repo.create_session(SessionRow(id=first.id, title=first.title,
                                         project_id="p1"))
    SESSIONS[first.id] = first
    server._dialogue(first).say("user", "金额口径以含税年度累计为准")
    await server._converse_tools(first).call(
        "decision.record", {"kind": "caliber", "statement": "金额口径以含税年度累计为准",
                            "quote": "金额口径以含税年度累计为准"},
        _Ctx(), scope="converse")

    pm = await server._project_memory("p1")
    hits = pm.recall("金额口径", run_id="run-2")
    assert [h.content for h in hits] == ["金额口径以含税年度累计为准"]
    assert hits[0].tier is MemoryTier.AUTHORITATIVE
    # 另一个项目看不到它 —— 隔离靠实例，Scope 字段在检索里根本不参与过滤
    assert len(await server._project_memory("p2")) == 0


async def test_decision_of_a_session_without_a_project_writes_nothing(tmp_path):
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    s = Session(id="s1", title="没归项目")
    s.dir.mkdir(parents=True, exist_ok=True)
    await repo.create_session(SessionRow(id=s.id, title=s.title))
    SESSIONS[s.id] = s
    reg = server._converse_tools(s)
    server._dialogue(s).say("user", "统一叫计划")
    await reg.call("decision.record", {"kind": "naming", "statement": "统一叫计划",
                                       "quote": "统一叫计划"},
                   _Ctx(), scope="converse")
    assert await repo.list_project_memory("") == []


async def test_run_lessons_land_in_the_reference_tier_with_their_origin(tmp_path):
    """本轮扛过 critic 的教训是**模型的推断**：进参考档，带来源，绝不冒充拍板。"""
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    await repo.create_project(ProjectRow(id="p1", name="采购中台", owner=""))
    s = Session(id="s1", title="第一轮梳理", project_id="p1")
    s.dir.mkdir(parents=True, exist_ok=True)
    s.files = [{"name": "实体梳理.xlsx", "size": 1, "path": "x", "sha256": ""}]

    await server._remember_run_lessons(
        s, ["coverage/missing_segment: 第 3 段一个对象都没抽到"], run_id="run-1")

    rows = await repo.list_project_memory("p1")
    assert len(rows) == 1
    assert rows[0].tier == str(MemoryTier.REFERENCE)
    assert rows[0].kind != "decision"          # DECISION 吃 1.3 prior 且不衰减
    assert rows[0].origin_session == "第一轮梳理"
    assert rows[0].origin_files == ["实体梳理.xlsx"]
    assert rows[0].confidence < 1.0

    # 下一个会话读到的每一行都带来源标注 —— 标注在**内容前面**，L3 的硬截断
    # 会把写在末尾的免责说明切掉。
    pm = await server._project_memory("p1")
    assert pm.authoritative() == []
    rendered = pm.store.all()[0].render()
    assert rendered.index("参考") < rendered.index("第 3 段")


async def test_memory_write_failure_does_not_fail_the_run(tmp_path, monkeypatch):
    """记忆写不进去是降级，不是这次梳理失败。"""
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    await repo.create_project(ProjectRow(id="p1", name="P", owner=""))
    s = Session(id="s1", title="T", project_id="p1")
    s.dir.mkdir(parents=True, exist_ok=True)

    async def boom(*a, **k):
        raise RuntimeError("库连不上")

    monkeypatch.setattr(repo, "upsert_project_memory", boom)
    await server._remember_run_lessons(s, ["lens/code: 教训"], run_id="r1")
    assert [e["kind"] for e in s.events] == ["memory.failed"]


# ══════════════════════════════════════════════════════════════════
#  R2：参考档绝不进交付物
# ══════════════════════════════════════════════════════════════════
async def test_reference_memory_can_never_reach_the_delivered_package(tmp_path):
    """``dm.decisions`` 全量、不过滤地进 ``OntologyPackage.decisions``。

    正路上参考档进不了 DialogueMemory；这道过滤是为了将来 —— 哪天有人图省事把一条
    推断塞进对话记忆，它就会以"已拍板"的身份印在交付给客户的包里，而且没人会报错。
    """
    from ontocopilot.kernel.memory.dialogue import DialogueMemory
    from ontocopilot.onto.oir import OIR

    repo = MemoryRepo()
    set_repo_for_tests(repo)
    s = Session(id="s1", title="T")
    s.dir.mkdir(parents=True, exist_ok=True)
    s.state["_oir"] = OIR()

    class _Smuggled:
        """一条被塞进拍板序列的参考档记忆。"""

        def to_dict(self):
            return {"key": "lesson:x", "kind": "lesson",
                    "statement": "模型猜的：金额多半是不含税",
                    "tier": str(MemoryTier.REFERENCE), "tags": ["observed"]}

    dm = DialogueMemory()
    dm._decisions.append(_Smuggled())
    s.state["_dialogue"] = dm
    s.state["decision_ledger"] = [
        {"id": "dec_ok", "statement": "人拍板：口径含税", "kind": "caliber"},
        {"id": "dec_ref", "statement": "模型猜的：账期 30 天", "tags": ["observed"]},
    ]

    data = server._write_canonical_artifacts(s, write=False)
    blob = json.dumps(data, ensure_ascii=False)
    assert "模型猜的" not in blob
    assert "人拍板：口径含税" in blob


async def test_free_tier_run_of_a_project_session_still_finishes(tmp_path, monkeypatch):
    """免费预览档是 run 的三个出口之一，收尾时也要走项目记忆那条路。

    它不跑 critic，所以本轮没有教训可留 —— 但这个出口一样会执行那次写入调用，
    这里钉住它不会把一次本该成功的免费梳理变成失败。
    """
    async def _noop_catalog():
        return None

    class _Backend:
        async def aclose(self):
            return None

    def _fake_gateways(_out, _run_id, *, resume=False, **_identity):
        del resume, _identity
        return _Backend(), None, None, None

    monkeypatch.setattr(server, "_ensure_catalog", _noop_catalog)
    monkeypatch.setattr(server, "_gateways", _fake_gateways)
    repo = MemoryRepo()
    xml = b"""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><startEvent id="s" name="Start"/><task id="w" name="Do work"/>
 <sequenceFlow id="a" sourceRef="s" targetRef="w"/></process></definitions>"""
    async with _client(repo) as c:
        pid = (await c.post("/api/projects", json={"name": "P"})).json()["id"]
        sid = (await c.post("/api/sessions", json={"title": "梳理"})).json()["id"]
        await c.patch(f"/api/sessions/{sid}", json={"project_id": pid})
        up = await c.post(f"/api/sessions/{sid}/files",
                          files={"files": ("流程.bpmn20.xml", xml, "application/xml")})
        assert up.status_code == 200, up.text
        started = await c.post(f"/api/sessions/{sid}/build?tier=flow_preview")
        assert started.status_code == 200, started.text
        await SESSIONS[sid].run_task
        state = (await c.get(f"/api/sessions/{sid}/state")).json()
    assert state["status"] == "done"
    assert state["project_id"] == pid
    assert await repo.list_project_memory(pid) == []   # 没有教训就不编教训


def test_reference_entries_are_dropped_whichever_marker_they_carry():
    kept = {"id": "d1", "statement": "人拍的板"}
    out = server._drop_reference_memory([
        kept,
        {"id": "d2", "statement": "推断 A", "tier": "reference"},
        {"id": "d3", "statement": "推断 B", "tags": ["observed"]},
    ])
    assert out == [kept]
