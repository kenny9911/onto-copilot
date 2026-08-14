"""DDL 解析：**列注释一条都不能丢**。

丢注释是这个解析器里最贵的一类失败，而且**完全无声**：两张表都写
``plan_amount DECIMAL(18,2)``，区别全在 ``-- 含税·年度累计`` 与 ``-- 不含税·单次``
上。注释没了，口径冲突就再也检不出来，而没有任何东西会报错 —— 交付物看起来
一切正常，只是少了一条本该问出来的问题。

所以这里把**每一种见得到的写法**都钉住。曾经漏掉的是「列与 CREATE TABLE 挤在
同一行」那一种：``_column_comments`` 按行扫描，命中 ``create table`` 那行就
``continue``，同一行上的列从来没机会被关联到；而 sqlglot 根本没丢，注释好好挂在
``ColumnDef.comments`` 上，只是提取逻辑没去拿。

注释有三个来源，依次兜底（谁都不能删）：
  1. 行扫描 —— 认得跨行、认得注释单独占一行的写法；
  2. ``COMMENT '...'`` 列约束 —— MySQL/Oracle 常这么写；
  3. sqlglot 的 ``ColumnDef.comments`` —— 认得 AST 保住而行扫描漏掉的。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from ontocopilot.onto.parse.sql import DdlParser


def _columns(ddl: str) -> dict[str, str]:
    """解析一段 DDL，返回 ``{列名: 注释}``。"""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "schema.ddl"
        p.write_text(ddl, encoding="utf-8")
        doc = DdlParser().parse(p, file_id="t")
    return {c["name"]: c["comment"] for c in doc.structured["tables"][0]["columns"]}


@pytest.mark.parametrize(
    ("label", "ddl", "want"),
    [
        # ── 这一条是回归本体 ────────────────────────────────────────
        (
            "列与 CREATE TABLE 挤在同一行",
            "CREATE TABLE t (a DECIMAL(18,2) -- 含税·年度累计\n);",
            {"a": "含税·年度累计"},
        ),
        # ── 这些本来就是好的，一并钉住免得修 bug 时把它们碰坏 ────────
        (
            "中间列 + 尾随逗号",
            "CREATE TABLE t (\n  a DECIMAL(18,2), -- 含税·年度累计\n  b VARCHAR(32)\n);",
            {"a": "含税·年度累计", "b": ""},
        ),
        (
            "末列无逗号",
            "CREATE TABLE t (\n  a VARCHAR(32),\n  b DECIMAL(18,2) -- 归口部门\n);",
            {"a": "", "b": "归口部门"},
        ),
        (
            "COMMENT 子句（MySQL/Oracle 写法）",
            "CREATE TABLE t (\n  a DECIMAL(18,2) COMMENT '含税·年度累计'\n);",
            {"a": "含税·年度累计"},
        ),
        (
            "两列各带一条",
            "CREATE TABLE t (\n  a INT, -- 第一条\n  b INT -- 第二条\n);",
            {"a": "第一条", "b": "第二条"},
        ),
        (
            "没有注释就是空串，不是 None",
            "CREATE TABLE t (\n  a INT\n);",
            {"a": ""},
        ),
        (
            "单行写完整张表",
            "CREATE TABLE t (a INT -- 编号\n, b INT -- 数量\n);",
            {"a": "编号", "b": "数量"},
        ),
    ],
)
def test_column_comments_survive_every_shape(label: str, ddl: str, want: dict[str, str]) -> None:
    assert _columns(ddl) == want, label


def test_the_comment_is_stripped_the_same_way_whichever_source_it_came_from() -> None:
    """三个来源取出来的文本必须同形，否则同一条口径在两种写法下不相等。

    行扫描的 ``_LINE_COMMENT`` 捕获的是 ``--`` 之后 strip 过的文本；sqlglot 给的
    串带一个前导空格。不对齐的话「同一行」与「换行」两种写法会产出
    ``"含税"`` 与 ``" 含税"``，冲突检测把它们当成两种不同的口径。
    """
    same_line = _columns("CREATE TABLE t (a INT --    含税·年度累计   \n);")["a"]
    own_line = _columns("CREATE TABLE t (\n  a INT, --    含税·年度累计   \n  b INT\n);")["a"]
    assert same_line == own_line == "含税·年度累计"


def test_two_tables_that_differ_only_in_the_comment_stay_distinguishable() -> None:
    """这条是整个文件存在的理由。

    两张表的列声明逐字节相同，只有口径不同。注释一丢，它们就变成一模一样的两列，
    冲突检测无从下手 —— 而这正是这个产品最值钱的输出。
    """
    a = _columns("CREATE TABLE plan_a (plan_amount DECIMAL(18,2) -- 含税·年度累计\n);")
    b = _columns("CREATE TABLE plan_b (plan_amount DECIMAL(18,2) -- 不含税·单次\n);")
    assert a["plan_amount"] == "含税·年度累计"
    assert b["plan_amount"] == "不含税·单次"
    assert a != b, "两种口径必须能区分开，否则冲突检测就是瞎的"
