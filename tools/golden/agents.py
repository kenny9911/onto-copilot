"""导出 kernel/agents.py 与 kernel/skills.py 的 golden。

这两个模块**几乎全是数据**：十四个 agent 的系统提示词、十二条技能规程、一张作用域
授权表。数据的价值恰恰在于一个字都不能漂 —— 提示词改一个字模型输出就可能变，
作用域表少一行就等于把权限放开。所以这份 golden 钉的是**字节**，不是形状：

* ``skills.json``
    - ``skills``   每条技能的七个字段 + ``tokens`` + ``brief()`` + ``render()`` 全文。
    - ``catalog``  含 ``names=[]`` 那条 —— Python 写的是 ``names or self.names()``，
      **空列表落到 `or` 的假分支**，返回的是全量目录而不是空串。照着类型签名
      写成 "给了列表就按列表过滤" 就会在这里分叉。
    - ``load``     预算边界取在 ``spent + tokens > budget`` 的等号两侧，各钉一条。
    - ``select``   词元重叠打分。分数相同时靠**注册顺序**（Python sort 稳定）决定
      先后，所以这里连并列的情况一起钉。
    - ``parse_skill_md`` / ``from_dir`` 解析规则（含正则 ``\\s`` 跨行、
      ``strip(" -[]x")`` 的字符集语义）。
* ``agents.json``
    - ``agents``   每个 agent 的全部字段 + ``render_system()`` 的两种形态全文。
    - ``tool_scopes`` 作用域授权表原样。
    - ``scopes_for``  ``tools._scopes_for()`` 的结果 —— 架构审计 P0-1
      （工具最小权限失效）修好之后，这张表才真的是授权依据。

字节确定：无时间、无随机；唯一的集合迭代来自 ``TOOL_SCOPES.items()``（dict 保序）
与 ``_scopes_for`` 的结果元组（同一张表的顺序）。重跑两次 shasum 必须一致。

跑法::

    .venv/bin/python tools/golden/agents.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.agents import (  # noqa: E402
    BUILTIN_AGENTS,
    TOOL_SCOPES,
    AgentSpec,
    default_agents,
)
from ontocopilot.kernel.dag import Difficulty, NodeBudget, NodeMode  # noqa: E402
from ontocopilot.kernel.skills import (  # noqa: E402
    BUILTIN_SKILLS,
    Skill,
    SkillLibrary,
    default_library,
    parse_skill_md,
)
from ontocopilot.kernel.tools import _scopes_for  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "golden"


# ══════════════════════════════════════════════════════════════════
#  skills
# ══════════════════════════════════════════════════════════════════
def skill_dict(s: Skill) -> dict[str, Any]:
    return {
        "name": s.name,
        "description": s.description,
        "when_to_use": s.when_to_use,
        "procedure": s.procedure,
        "checklist": list(s.checklist),
        "tools": list(s.tools),
        "tags": list(s.tags),
        "tokens": s.tokens,
        "brief": s.brief(),
        "render": s.render(),
    }


CATALOG_CASES: list[dict[str, Any]] = [
    {"case": "none", "names": None},
    {"case": "empty_list_means_all", "names": []},
    {"case": "single", "names": ["口径对齐"]},
    {"case": "two_keeps_argument_order", "names": ["命名归一", "口径对齐"]},
    {"case": "duplicate_is_rendered_twice", "names": ["口径对齐", "口径对齐"]},
    {"case": "unknown_is_skipped", "names": ["不存在", "命名归一"]},
    {"case": "all_unknown_is_empty_string", "names": ["不存在"]},
]

SELECT_CASES: list[dict[str, Any]] = [
    {"task": "计划金额在两处口径不一致，含税和不含税", "limit": 2},
    {"task": "没人填 ActionType，材料里有 openapi 端点", "limit": 3},
    {"task": "", "limit": 3},
    {"task": "123 456 !!!", "limit": 3},          # 无词元 → 直接返回 []
    {"task": "ERP SAP 字段映射", "limit": 3},
    {"task": "流程 步骤 异常 分支", "limit": 5},
    {"task": "数据 质量 敏感 主数据", "limit": 1},
    {"task": "交付 审查 追溯", "limit": 3},
    {"task": "规则 决策表 例外", "limit": 3},
    {"task": "访谈 范围 干系人", "limit": 3},
    {"task": "缺口 追问 问题清单 路由", "limit": 4},
    {"task": "命名 camelCase 规范 缩写", "limit": 3},
    {"task": "对齐", "limit": 12},                # 大量并列，钉稳定排序
    {"task": "技能", "limit": 3},
    {"task": "回传 审核 打回 完成度", "limit": 2},
]

TOK_CASES = [
    "计划金额在两处口径不一致，含税和不含税",
    "ActionType openapi",
    "",
    "123",
    "MixedCase中文Mixed",
    "𠀀𡿪",           # 扩展 B（U+20000+）不在 [㐀-鿿] 内，落不进词元
    "〇一二",          # U+3007 / U+4E00：前者在 CJK 符号区，不在 [㐀-鿿] 内
]

MD_CASES: list[dict[str, Any]] = [
    {
        "case": "full",
        "fallback": "skill",
        "text": (
            "# 主键判定\n> 判断哪个字段该做主键\n\n"
            "## 何时用\n对象没有声明主键时\n\n"
            "## 步骤\n看唯一率和空值率\n\n"
            "## 完成判据\n- 唯一率 100%\n- 空值率 0\n"
        ),
    },
    {
        "case": "no_h1_uses_fallback",
        "fallback": "fallback_name",
        "text": "> 只有描述\n\n## 步骤\n做点什么\n",
    },
    {
        "case": "empty_text",
        "fallback": "空",
        "text": "",
    },
    {
        "case": "h1_whitespace_spans_newlines",
        "fallback": "skill",
        # `^#\s+(.+)$` 里的 \s **包含换行**，所以标题会跨到下一行去取。
        "text": "#\n\n跨行标题\n> 描述\n",
    },
    {
        "case": "star_bullets_and_strip_charset",
        "fallback": "skill",
        # strip(" -[]x") 剥的是字符集合，所以行首的 "- [x] " 与行尾的 "x" 一起被剥掉。
        "text": (
            "# 判据\n> d\n\n## 完成判据\n"
            "* 星号也算\n- [x] 勾选项\n- [ ] 未勾选\n"
            "  - 缩进的也算\n"
            "普通行不算\n"
            "- \n"          # 剥完是空串，被最后一道过滤掉
            "-无空格不算\n"
        ),
    },
    {
        "case": "tools_split_by_ideographic_comma",
        "fallback": "skill",
        "text": "# t\n> d\n\n## 工具\nevidence.search、 oir.query 、\n",
    },
    {
        "case": "section_titles_are_stripped",
        "fallback": "skill",
        "text": "#   带空格的名字   \n>   带空格的描述   \n\n##   步骤   \n正文\n",
    },
    {
        "case": "unknown_sections_ignored",
        "fallback": "skill",
        "text": "# n\n> d\n\n## 背景\n不该出现\n\n## 步骤\n出现\n",
    },
    {
        "case": "duplicate_section_last_wins",
        "fallback": "skill",
        "text": "# n\n> d\n\n## 步骤\n第一份\n\n## 步骤\n第二份\n",
    },
    {
        "case": "quote_line_takes_the_first",
        "fallback": "skill",
        "text": "# n\n> 第一条描述\n> 第二条描述\n",
    },
]

#: from_dir 的输入。文件名故意乱序写、按 sorted(glob) 载入；
#: 两个文件共用同一个 H1 时后注册的覆盖前一个 —— 这个覆盖顺序由文件名排序决定。
DIR_FILES: dict[str, str] = {
    "b.md": "# 乙\n> 第二个\n\n## 何时用\n乙的时机\n\n## 步骤\n乙的步骤\n",
    "a.md": "# 甲\n> 第一个\n\n## 何时用\n甲的时机\n\n## 步骤\n甲的步骤\n"
            "\n## 完成判据\n- 甲判据\n",
    "z_dup.md": "# 甲\n> 覆盖了前一个甲\n\n## 步骤\n后来的\n",
    "no_h1.md": "> 用文件名兜底\n\n## 步骤\n兜底\n",
    "not_md.txt": "# 不该被载入\n",
}


def export_load_cases(lib: SkillLibrary) -> list[dict[str, Any]]:
    """预算边界取在 `spent + s.tokens > budget_tokens` 的等号两侧各一条。"""
    one = lib.get("口径对齐")
    two = lib.get("命名归一")
    cases: list[dict[str, Any]] = [
        {"case": "no_budget", "names": ["口径对齐"], "budget_tokens": None},
        {"case": "two", "names": ["口径对齐", "命名归一"], "budget_tokens": None},
        {"case": "unknown_skipped_silently", "names": ["不存在"], "budget_tokens": None},
        {"case": "unknown_between", "names": ["口径对齐", "不存在", "命名归一"],
         "budget_tokens": None},
        {"case": "empty_names", "names": [], "budget_tokens": None},
        # 等号：spent(0) + tokens == budget，不大于，所以**载入**。
        {"case": "budget_exactly_fits", "names": ["口径对齐"], "budget_tokens": one.tokens},
        {"case": "budget_one_short", "names": ["口径对齐"], "budget_tokens": one.tokens - 1},
        {"case": "budget_zero", "names": ["口径对齐"], "budget_tokens": 0},
        # 第一条载入后 spent 恰好卡在第二条的门槛上。
        {"case": "second_exactly_fits", "names": ["口径对齐", "命名归一"],
         "budget_tokens": one.tokens + two.tokens},
        {"case": "second_one_short", "names": ["口径对齐", "命名归一"],
         "budget_tokens": one.tokens + two.tokens - 1},
        # 被丢的不是连续的一段：预算够小的那条时仍会继续尝试后面的。
        {"case": "drop_is_not_a_suffix", "names": ["回传审核", "命名归一"],
         "budget_tokens": two.tokens},
        {"case": "all_with_tiny_budget", "names": lib.names(), "budget_tokens": 80},
    ]
    for c in cases:
        c["out"] = lib.load(list(c["names"]), budget_tokens=c["budget_tokens"])
    return cases


def export_skills() -> dict[str, Any]:
    lib = default_library()
    from ontocopilot.kernel.skills import _tok

    dir_root = Path(tempfile.mkdtemp(prefix="golden-skills-"))
    for fn, body in DIR_FILES.items():
        (dir_root / fn).write_text(body, encoding="utf-8")
    from_dir = SkillLibrary.from_dir(dir_root)

    return {
        "_note": "由 tools/golden/agents.py 生成，勿手改",
        "names": lib.names(),
        "count": len(lib),
        "registry_order": [s.name for s in BUILTIN_SKILLS],
        "skills": [skill_dict(s) for s in BUILTIN_SKILLS],
        "catalog": [
            {**c, "out": lib.catalog(None if c["names"] is None else list(c["names"]))}
            for c in CATALOG_CASES
        ],
        "load": export_load_cases(lib),
        "select": [{**c, "picked": lib.select(c["task"], limit=c["limit"])}
                   for c in SELECT_CASES],
        "tok": [{"text": t, "out": _tok(t)} for t in TOK_CASES],
        "parse_skill_md": [
            {**c, "skill": skill_dict(parse_skill_md(c["text"], fallback=c["fallback"]))}
            for c in MD_CASES
        ],
        "from_dir": {
            "files": DIR_FILES,
            "names": from_dir.names(),
            "skills": [skill_dict(from_dir.get(n)) for n in from_dir.names()],
            # 单独一份 a.md 的解析结果 —— TS 侧拿它钉 CRLF 文件的载入：
            # Python 的文本模式读会把 \r\n 折成 \n，Node 不会，不补这一步正文里
            # 会多出一串 \r（而 render 出来肉眼看不出来）。
            "a_md_alone": skill_dict(parse_skill_md(DIR_FILES["a.md"], fallback="a")),
        },
        "missing_key_message": _key_error_message(lib.get, "不存在"),
        "empty_library": {
            "names": SkillLibrary().names(),
            "catalog": SkillLibrary().catalog(),
            "load": SkillLibrary().load(["x"]),
            "select": SkillLibrary().select("口径"),
            "missing_key_message": _key_error_message(SkillLibrary().get, "x"),
        },
    }


def _key_error_message(fn: Any, arg: str) -> str:
    """KeyError 的**参数**（不是 str(exc) —— 那会多一层 repr 引号）。"""
    try:
        fn(arg)
    except KeyError as exc:
        return str(exc.args[0])
    raise AssertionError("预期抛 KeyError")


# ══════════════════════════════════════════════════════════════════
#  agents
# ══════════════════════════════════════════════════════════════════
def agent_dict(a: AgentSpec, lib: SkillLibrary) -> dict[str, Any]:
    return {
        "name": a.name,
        "role": a.role,
        "mode": str(a.mode),
        "system": a.system,
        "tool_scope": a.tool_scope,
        "skills": list(a.skills),
        "critics": list(a.critics),
        "difficulty": str(a.difficulty) if a.difficulty is not None else None,
        "budget": {
            "tokens": a.budget.tokens, "iterations": a.budget.iterations,
            "wallclock_s": a.budget.wallclock_s, "tool_calls": a.budget.tool_calls,
        },
        "critic_rounds": a.critic_rounds,
        "output_schema": a.output_schema,
        "to_dict": a.to_dict(),
        "to_dict_keys": list(a.to_dict()),
        "render_system_bare": a.render_system(None),
        "render_system_with_library": a.render_system(lib),
    }


def export_agents() -> dict[str, Any]:
    lib = default_library()
    agents = default_agents()

    minimal = AgentSpec(name="x", role="r", mode=NodeMode.REACT, system="  sys  ")
    with_unknown_skill = AgentSpec(
        name="u", role="r", mode=NodeMode.SINGLE_SHOT, system="sys",
        skills=("不存在的技能",))
    no_skill = AgentSpec(name="n", role="r", mode=NodeMode.HITL, system="sys\n\n")
    fixed_diff = AgentSpec(
        name="d", role="r", mode=NodeMode.DETERMINISTIC, system="s",
        difficulty=Difficulty.LOW, budget=NodeBudget(tokens=1, iterations=2,
                                                    wallclock_s=3, tool_calls=4),
        critic_rounds=0, critics=("schema",), skills=("命名归一",))

    return {
        "_note": "由 tools/golden/agents.py 生成，勿手改",
        "names": agents.names(),
        "registry_order": [a.name for a in BUILTIN_AGENTS],
        "describe": agents.describe(),
        "agents": [agent_dict(a, lib) for a in BUILTIN_AGENTS],
        "tool_scopes": {k: list(v) for k, v in TOOL_SCOPES.items()},
        # 架构审计 P0-1：这张表要真的当授权依据用，才不是一句声明。
        "scopes_for": {
            t: list(_scopes_for(t))
            for t in ["code.exec", "evidence.search", "evidence.rows", "oir.query",
                      "profile.column", "impact.trace", "artifact.write", ""]
        },
        "ad_hoc": {
            "minimal": agent_dict(minimal, lib),
            "unknown_skill_yields_empty_catalog": agent_dict(with_unknown_skill, lib),
            "no_skill": agent_dict(no_skill, lib),
            "fixed_difficulty": agent_dict(fixed_diff, lib),
        },
        "missing_key_message": _key_error_message(default_agents().get, "不存在"),
        "empty_library_missing_key_message": _key_error_message(
            __import__("ontocopilot.kernel.agents", fromlist=["AgentLibrary"])
            .AgentLibrary().get, "x"),
        "register_returns_self_and_overwrites": _export_register(),
    }


def _export_register() -> dict[str, Any]:
    from ontocopilot.kernel.agents import AgentLibrary

    lib = AgentLibrary()
    a1 = AgentSpec(name="dup", role="第一版", mode=NodeMode.REACT, system="s1")
    a2 = AgentSpec(name="dup", role="第二版", mode=NodeMode.HITL, system="s2")
    same = lib.register(a1) is lib
    lib.register(a2)
    return {"register_returns_self": same, "names": lib.names(),
            "role_after_overwrite": lib.get("dup").role,
            "describe": lib.describe()}


# ══════════════════════════════════════════════════════════════════
def write(name: str, payload: dict[str, Any]) -> None:
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / name
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  {name:<14} {path.stat().st_size:>8} B  sha256[:16]={digest}")


def main() -> None:
    write("skills.json", export_skills())
    write("agents.json", export_agents())


if __name__ == "__main__":
    main()
