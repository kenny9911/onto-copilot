"""参考档能不能被"洗"成权威档。

红队实跑打穿过一次，这个文件钉住那条路。原始复现：

1. 第一个会话里 critic 的教训进参考档 —— 带「参考·未确认」标注，正确
2. 第二个会话把它渲染进 L3，模型**逐字读到**那句推断
3. 模型调 ``decision.record``，statement 就是那句推断
4. ``Decision.to_memory()`` 合成 ``support=["dialogue:{run}:turn{idx}"]``、confidence 1.0、
   tier 默认 AUTHORITATIVE → 晋升闸门放行

闸门没有被绕过 —— 它检查的是**传进去的那个对象**，而这条路造的是一条全新的条目。
真正缺的东西是：**没有任何代码验证过这句话出自人**。那条 support 里的 turn_index
只是 ``len(turns)-1``，复现里它指向的原话是「你好，这份材料能看吗」。

修复的原则：一条跨项目生效的约定之所以权威，唯一的理由是人说过；那么写入路径就
必须指得出他说的是哪句，而且这个指认要被验证。
"""

from __future__ import annotations

import pytest

from ontocopilot import server
from ontocopilot.kernel.errors import ToolDenied
from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.memory.types import MemoryTier
from ontocopilot.server import SESSIONS, Session
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, ProjectRow, SessionRow

#: 模型自己猜出来的口径 —— 它自己都写明了「材料里没有依据」。
GUESS = "计划金额一律按含税年度累计（材料里没有依据，按常见做法推断）"


class _Ctx:
    rec = None
    node_id = ""
    approved = False
    budget = None

    def __init__(self) -> None:
        self.pending: list = []


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    SESSIONS.clear()
    yield
    set_repo_for_tests(None)
    SESSIONS.clear()


async def _project_with_a_guess_on_record() -> tuple[MemoryRepo, Session]:
    """第一个会话留下一条参考档；返回同项目下的第二个会话。"""
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    await repo.create_project(ProjectRow(id="p1", name="采购中台", owner=""))

    first = Session(id="s1", title="第一轮梳理", project_id="p1")
    first.dir.mkdir(parents=True, exist_ok=True)
    first.files = [{"name": "实体梳理.xlsx", "size": 1, "path": "x", "sha256": ""}]
    await server._remember_run_lessons(first, [GUESS], run_id="r1")
    assert [r.tier for r in await repo.list_project_memory("p1")] == ["reference"]

    second = Session(id="s2", title="第二轮梳理", project_id="p1")
    second.dir.mkdir(parents=True, exist_ok=True)
    await repo.create_session(SessionRow(id="s2", title="第二轮梳理", project_id="p1"))
    SESSIONS["s2"] = second
    second.state["engagement_run_id"] = "r9"
    return repo, second


async def test_the_model_really_does_see_the_guess_in_its_context(tmp_path):
    """前提：这条路之所以存在，是因为模型确实读得到那句推断。

    这不是缺陷 —— 参考档就是要进上下文的。钉住它是为了防止有人"修"错地方：
    把它从上下文里拿掉会让整个分层记忆失去意义。
    """
    await _project_with_a_guess_on_record()
    pm = await server._project_memory("p1")
    cm = ContextManager(system="sys", long_term=pm.store, budget_tokens=4000)
    l3 = cm.assemble(task="计划金额口径", query="计划金额 含税").layers["L3_reflection"]

    assert GUESS in l3
    assert "参考" in l3 and "未确认" in l3          # 标注在，且在内容前面
    assert l3.index("参考") < l3.index(GUESS)


async def test_the_guess_cannot_be_laundered_into_a_project_wide_convention(tmp_path):
    """核心回归：没有用户说过这句话，它就升不了项目档。"""
    repo, second = await _project_with_a_guess_on_record()
    # 用户这一轮说的是完全无关的话
    server._dialogue(second).say("user", "你好，这份材料能看吗")
    reg = server._converse_tools(second)

    # 连 quote 都不给 —— 工具层直接拒
    with pytest.raises(ToolDenied, match="quote"):
        await reg.call("decision.record", {"kind": "caliber", "statement": GUESS},
                       _Ctx(), scope="converse")

    # 给一段用户没说过的话冒充出处 —— 校验不过，只在本会话生效
    out = await reg.call(
        "decision.record",
        {"kind": "caliber", "statement": GUESS, "quote": "金额按含税年度累计"},
        _Ctx(), scope="converse")
    assert "只在本会话生效" in out
    assert "同项目的其它会话也会看到" not in out["生效范围"]

    rows = await repo.list_project_memory("p1")
    assert [r.tier for r in rows] == ["reference"], "项目里不该多出一条权威档"
    pm = await server._project_memory("p1")
    assert pm.authoritative() == []

    # 板照样拍在本会话里 —— 这是降级，不是拒绝服务
    assert any(GUESS in d.statement for d in server._dialogue(second).decisions)


async def test_a_convention_the_user_actually_stated_still_gets_shared(tmp_path):
    """对照组：人真的说过，就照常跨会话生效，而且出处是他的原话。

    没有这一条，上面那个测试可以靠"把功能关掉"来通过。
    """
    repo, second = await _project_with_a_guess_on_record()
    server._dialogue(second).say("user", "金额就按含税年度累计算，别的口径不要")
    reg = server._converse_tools(second)

    out = await reg.call(
        "decision.record",
        {"kind": "caliber", "statement": "金额一律含税年度累计",
         "quote": "金额就按含税年度累计算"},          # 标点与原话不同，仍要认得出
        _Ctx(), scope="converse")
    assert "同项目的其它会话也会看到" in out["生效范围"]

    auth = [r for r in await repo.list_project_memory("p1")
            if r.tier == str(MemoryTier.AUTHORITATIVE)]
    assert len(auth) == 1
    # 出处必须是**用户真的说过的那句话**，而不是一个长得像出处的字符串
    assert any(x.startswith("用户原话：") and "含税年度累计" in x for x in auth[0].support)


async def test_quoting_the_assistants_own_words_is_not_the_user_speaking(tmp_path):
    """助手自己说过的话不算数 —— 否则模型只要先说一遍就能给自己背书。"""
    repo, second = await _project_with_a_guess_on_record()
    dm = server._dialogue(second)
    dm.say("user", "这个我不确定")
    dm.say("assistant", f"根据前面的梳理，{GUESS}")

    out = await server._converse_tools(second).call(
        "decision.record",
        {"kind": "caliber", "statement": GUESS, "quote": GUESS[:12]},
        _Ctx(), scope="converse")
    assert "只在本会话生效" in out
    assert [r.tier for r in await repo.list_project_memory("p1")] == ["reference"]
