"""对话动态改模板 —— 结构化编辑 + 不变量守卫。

FDE 拿到生成的模板，常常要改：加一列备注、删掉填不了的 primaryKey、把一张大表
拆开、改某列的必填性。他希望通过对话让 Copilot 改，而不是我们改代码 —— 模板
应该是**动态的**，不是写死的。

但"让 AI 改 xlsx 模板"有一个致命陷阱：这份 xlsx 靠隐藏锚点列 ``_oir_rid`` /
``_oir_hash`` 做往返回读，而**列名 == Cell.field == 回写 key 是三位一体的**。
模型直接吐一张新 xlsx，锚点必丢、整表回读报废，而且不报错 —— 业务方填完交回，
发现什么都没读进来。

所以这里的做法是：**模型只选操作和参数，绝不直接生成模板。** 编辑是一组
结构化操作（加列/删列/改名/加表/改角色…），每个操作维持三位一体，每次编辑后
跑一遍守卫 —— 违反就拒绝并说清为什么，不静默应用。

守卫挡的正是往返契约会断的地方：
    G1 不许出现空表         G2 锚点列删不掉、列名唯一
    G5 REQUIRED 必须有回写路径（否则读进来算完成度却在合并时静默丢 = 黑洞）
    G6 同一 (rid,field) 不能跨表重复（by_rid 会塌成一个）
    G9 新表的每行 rid 必须能在 OIR 里查到（否则假锚点）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .template import (
    ANCHOR_HASH,
    ANCHOR_RID,
    PROSE_FIELDS,
    WEIGHTS,
    Cell,
    Role,
    Sheet,
    TemplateSpec,
    _cell,
)

__all__ = ["EditError", "apply_edit", "reconcile_template",
           "WRITEBACK_FIELDS", "REQUIRED_BLOCKLIST"]


#: merge_into_oir 里有 case 的字段。REQUIRED 列的 field 必须在这里，否则业务方
#: 填了、完成度算了、合并时却 case _ 静默丢 —— 实测过的"627 填→172 落回"黑洞。
#: 与 audit.py 的 match 分支一一对应，改那边要同步改这里。
WRITEBACK_FIELDS = frozenset({
    "definition", "description", "displayName", "cardinality", "owner",
    "primaryKey", "effects", "答复", "执行角色", "这条对吗", "管哪个单据",
})

#: 一律不许提成 REQUIRED 的列。primaryKey 是数据建模词汇，172 行全空、只有 FDE
#: 答得了、独占完成度权重 58% —— 把它设成必填就重犯了那次让达标线永远够不到的坑。
REQUIRED_BLOCKLIST = frozenset({"primaryKey"})

_ROLES = {"locked": Role.LOCKED, "prefilled": Role.PREFILLED,
          "required": Role.REQUIRED}


class EditError(ValueError):
    """一次编辑违反了守卫。消息要说清**为什么不能这么改**，让模型能转述给用户。"""


# ══════════════════════════════════════════════════════════════════
#  守卫
# ══════════════════════════════════════════════════════════════════
def _guard(spec: TemplateSpec) -> None:
    """编辑后的全量校验。任何一条不过就整体拒绝 —— 半应用的模板比不改更糟。"""
    for sh in spec.sheets:
        # G1 不许空表（有列定义却没有数据行，发出去是张只有表头的空表）
        if sh.columns and not sh.rows:
            raise EditError(f"「{sh.name}」会变成一张空表，没有数据行。")
        # G2 列名唯一
        if len(sh.columns) != len(set(sh.columns)):
            dup = [c for c in sh.columns if sh.columns.count(c) > 1]
            raise EditError(f"「{sh.name}」有重名的列：{dup[0]}。列名必须唯一，"
                            f"否则回读时按名取列会静默取错。")
        # 三位一体：每行的 dict key 必须等于该行每个 cell 的 field，且都在 columns 里
        for row in sh.rows:
            for key, cell in row.items():
                if cell.field != key:
                    raise EditError(f"「{sh.name}」里 {cell.rid} 的列 {key} 和它的"
                                    f"字段名 {cell.field} 对不上 —— 回读会失配。")
                if key not in sh.columns and key not in (ANCHOR_RID, ANCHOR_HASH):
                    raise EditError(f"「{sh.name}」有一列 {key} 不在列定义里，"
                                    f"它不会被渲染却会进回读索引。")
    # G6 同一 (rid,field) 不能跨表出现两次 —— by_rid 会把它塌成一个，回读报重复
    seen: dict[tuple[str, str], str] = {}
    for sh in spec.sheets:
        for row in sh.rows:
            for cell in row.values():
                key = (cell.rid, cell.field)
                if key in seen and seen[key] != sh.name:
                    raise EditError(
                        f"{cell.rid}.{cell.field} 同时出现在「{seen[key]}」和"
                        f"「{sh.name}」两张表 —— 回读时会互相覆盖。")
                seen[key] = sh.name


def _sheet(spec: TemplateSpec, name: str) -> Sheet:
    sh = next((x for x in spec.sheets if x.name == name), None)
    if sh is None:
        # 容错：模型多半不知道表名带 `01_` 前缀，说「对象清单」指的是
        # 「01_对象清单」。按去掉编号前缀后的包含关系匹配，唯一命中才认。
        def _bare(n: str) -> str:
            return n.split("_", 1)[-1] if n[:2].isdigit() else n
        cands = [x for x in spec.sheets
                 if _bare(name) in _bare(x.name) or _bare(x.name) in _bare(name)]
        if len(cands) == 1:
            return cands[0]
        raise EditError(f"没有名为「{name}」的表。现有："
                        f"{'、'.join(x.name for x in spec.sheets)}")
    return sh


def _role_of(name: str) -> Role:
    if name not in _ROLES:
        raise EditError(f"未知的角色 {name}，只能是 locked/prefilled/required。")
    return _ROLES[name]


# ══════════════════════════════════════════════════════════════════
#  操作
# ══════════════════════════════════════════════════════════════════
def _op_set_guide(spec: TemplateSpec, *, sheet: str, text: str) -> str:
    sh = _sheet(spec, sheet)
    sh.guide = text
    return f"改了「{sheet}」的填写说明。"


def _op_reorder_sheets(spec: TemplateSpec, *, order: list[str]) -> str:
    names = {x.name for x in spec.sheets}
    if set(order) != names:
        raise EditError("新顺序必须是现有表的一个排列，不能增删表。"
                        f"现有：{sorted(names)}")
    spec.sheets.sort(key=lambda x: order.index(x.name))
    return f"表的顺序调整为：{' → '.join(order)}。"


def _op_add_column(spec: TemplateSpec, *, sheet: str, name: str,
                   role: str = "prefilled", value: str = "", comment: str = "",
                   owner: str | None = None,
                   options: list[str] | None = None) -> str:
    sh = _sheet(spec, sheet)
    if name in sh.columns:
        raise EditError(f"「{sheet}」已经有一列叫 {name} 了。")
    r = _role_of(role)
    # G5：要业务方填（REQUIRED）的列，必须有回写路径，否则填了白填
    if r is Role.REQUIRED and name not in WRITEBACK_FIELDS:
        raise EditError(
            f"「{name}」设成必填，但它没有回写到模型的路径 —— 业务方填了会被"
            f"算进完成度，却在合并时静默丢弃。要么设成展示列（prefilled/locked），"
            f"要么用一个有回写路径的字段名：{sorted(WRITEBACK_FIELDS)}")
    if name in REQUIRED_BLOCKLIST and r is Role.REQUIRED:
        raise EditError(f"「{name}」不适合设成必填（见既有说明），换成展示列。")
    if options:
        _check_options([o for o in dict.fromkeys(options) if str(o).strip()])
    sh.columns.append(name)
    for row in sh.rows:
        rid = next(iter(row.values())).rid
        # **必须用 sh.name，不是调用方传的 sheet。** _sheet() 是模糊匹配的
        # （模型说「对象清单」，实际表名是「01_对象清单」），把调用方那个串写进
        # Cell.sheet 会让这一格的回读身份指向一张不存在的表 —— 业务方填了，
        # 合并时按 (sheet, rid, field) 对不上，静默丢弃。
        row[name] = _cell(rid, sh.name, name, value, r, owner=owner,
                          comment=comment, options=options)
    return f"给「{sh.name}」加了一列「{name}」（{role}）。"


def _op_drop_column(spec: TemplateSpec, *, sheet: str, column: str) -> str:
    sh = _sheet(spec, sheet)
    if column in (ANCHOR_RID, ANCHOR_HASH):
        raise EditError(f"{column} 是隐藏的回读锚点列，删了整表就读不回来了。")
    if column not in sh.columns:
        raise EditError(f"「{sheet}」没有列 {column}。")
    if len(sh.columns) <= 1:
        raise EditError(f"「{sheet}」只剩这一列了，删了就是空表。")
    sh.columns.remove(column)
    # 幽灵 cell：只删 columns 不删 rows[column]，cells() 仍会摊到它、进回读索引
    for row in sh.rows:
        row.pop(column, None)
    return f"删掉了「{sheet}」的「{column}」列。"


def _op_rename_column(spec: TemplateSpec, *, sheet: str, old: str, new: str) -> str:
    sh = _sheet(spec, sheet)
    if old in (ANCHOR_RID, ANCHOR_HASH):
        raise EditError(f"{old} 是回读锚点列，不能改名。")
    if old not in sh.columns:
        raise EditError(f"「{sheet}」没有列 {old}。")
    if new in sh.columns:
        raise EditError(f"「{sheet}」已经有一列叫 {new} 了。")
    # 三处联动：列名、每行 dict key、每个 Cell.field 一次全改
    sh.columns[sh.columns.index(old)] = new
    for row in sh.rows:
        cell = row.pop(old, None)
        if cell is None:
            continue
        # 改名切断回写路径：**任何本来能回写的列**都算，不只是 REQUIRED。
        # prefilled 的 definition/owner 同样有 merge_into_oir 的 case，业务方
        # 照样会改它；只守 REQUIRED 的话，把 owner 改成「负责人」就悄悄把这一列
        # 的回写断了 —— 填了、算进完成度、合并时丢掉。
        if old in WRITEBACK_FIELDS and new not in WRITEBACK_FIELDS:
            raise EditError(
                f"「{old}」的内容能回写进模型，改名成「{new}」会切断这条路径"
                f"（业务方填了会在合并时静默丢弃）。可用的名字：{sorted(WRITEBACK_FIELDS)}")
        cell.field = new
        cell.expects_prose = new in PROSE_FIELDS and not cell.options
        row[new] = cell
    return f"把「{sheet}」的「{old}」列改名为「{new}」。"


def _op_set_role(spec: TemplateSpec, *, sheet: str, column: str, role: str) -> str:
    sh = _sheet(spec, sheet)
    if column in (ANCHOR_RID, ANCHOR_HASH):
        raise EditError(f"{column} 是锚点列，角色不能改。")
    r = _role_of(role)
    if r is Role.REQUIRED:
        if column in REQUIRED_BLOCKLIST:
            raise EditError(f"「{column}」不适合设成必填。")
        if column not in WRITEBACK_FIELDS:
            raise EditError(f"「{column}」设成必填但没有回写路径 —— 填了会静默丢。")
    n = 0
    for row in sh.rows:
        if column in row:
            row[column].role = r
            n += 1
    if not n:
        raise EditError(f"「{sheet}」没有列 {column}。")
    return f"把「{sheet}」的「{column}」列改成 {role}。"


#: Excel 内联下拉（DataValidation formula1）的硬限制：整串带引号不超过 255 字符，
#: 且选项里不能有英文逗号（那是分隔符）或双引号（那是定界符）。超了/带了，openpyxl
#: 照写不误，但**打开的 xlsx 里这一列的下拉是坏的或整表报修复** —— 而我们直到业务方
#: 打不开文件才会知道。所以在编辑这一步就拒绝，并说清怎么改。
_DV_MAX = 255


def _check_options(opts: list[str]) -> None:
    bad = [o for o in opts if "," in o or '"' in o]
    if bad:
        raise EditError(f"下拉选项里不能带英文逗号或双引号（Excel 用它们做分隔符）："
                        f"{bad[:3]}。改成顿号或去掉引号。")
    inline = '"' + ",".join(opts) + '"'
    if len(inline) > _DV_MAX:
        raise EditError(f"下拉选项总长 {len(inline)} 字符，超过 Excel 内联下拉的 "
                        f"{_DV_MAX} 上限（写出去的表会打不开）。减少选项或改用说明文字。")


def _op_set_options(spec: TemplateSpec, *, sheet: str, column: str,
                    options: list[str]) -> str:
    sh = _sheet(spec, sheet)
    opts = [o for o in dict.fromkeys(options) if str(o).strip()]
    if len(opts) < 2:
        raise EditError("下拉至少要有两个选项。")
    _check_options(opts)
    n = 0
    for row in sh.rows:
        if column in row:
            row[column].options = list(opts)
            row[column].expects_prose = False   # 有下拉就不是散文
            n += 1
    if not n:
        raise EditError(f"「{sheet}」没有列 {column}。")
    return f"把「{sheet}」的「{column}」列改成下拉：{'/'.join(opts)}。"


_OPS = {
    "set_guide": _op_set_guide,
    "reorder_sheets": _op_reorder_sheets,
    "add_column": _op_add_column,
    "drop_column": _op_drop_column,
    "rename_column": _op_rename_column,
    "set_role": _op_set_role,
    "set_options": _op_set_options,
}


def apply_edit(spec: TemplateSpec, op: str, args: dict[str, Any]) -> str:
    """对模板规格应用一次结构化编辑，成功返回一句人话说明。

    **在一份副本上应用、守卫通过后才写回** —— 半应用的模板（改了一半守卫拒绝）
    比不改更危险。守卫失败抛 :class:`EditError`，调用方转述给用户，原规格不动。
    """
    fn = _OPS.get(op)
    if fn is None:
        raise EditError(f"不支持的编辑操作 {op}。支持：{sorted(_OPS)}")
    # 在副本上做，守卫过了再换 —— 原子性
    trial = TemplateSpec.from_dict(spec.to_dict())
    try:
        note = fn(trial, **args)
    except TypeError as exc:
        raise EditError(f"{op} 的参数不对：{exc}") from exc
    _guard(trial)
    # 通过：把 trial 的内容搬回 spec（保持同一个对象引用，调用方持有它）
    spec.sheets = trial.sheets
    spec.round = trial.round
    return note


def reconcile_template(oir: Any, conflicts: Any,
                       patch_log: list[dict[str, Any]] | None):
    """在「按当前 OIR 新编译」的 spec 上重放人工结构编辑，得到既纳入 OIR 改动、
    又保留手改的模板。返回 ``(spec, stale)``。

    根因：``template.recompile`` 一旦发现模板被编辑过，就走「渲染冻结 spec」分支、
    永不回读 OIR —— 于是采纳建议/口述/答题改的 OIR 到不了这张模板。

    能这样合并，靠一条关键性质：**``template.edit`` 只改结构（列/角色/下拉/说明/
    顺序），从不改单元格的值** —— 值永远来自 OIR。所以在新编译（OIR 最新）的 spec 上
    重放结构 op，正是想要的合并，不存在「值 vs OIR」的冲突。重放不上的 op（比如某张表
    的行全没了）收集为 stale 上报，**不致命**。
    """
    from .template import compile_template

    fresh = compile_template(oir, conflicts)
    stale: list[dict[str, Any]] = []
    for p in patch_log or []:
        try:
            apply_edit(fresh, p["op"], p.get("args") or {})
        except EditError as exc:
            stale.append({**p, "why": str(exc)})
    return fresh, stale
