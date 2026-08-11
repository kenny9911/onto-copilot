"""让 AI 把模板**改得贴这个项目** —— 但一格 xlsx 也不由它生成。

`compile_template()` 是确定性的：固定几张表、固定顺序、固定列。它保证了往返契约
（隐藏锚点列、列名==field==回写 key），但也意味着不管做的是采购、保险还是排产，
业务方拿到的都是同一张骨架，列名是 `apiName`/`baseType`/`cardinality` 这种他一列
都读不懂的词。

这里加的是**适配**，不是生成：

    确定性编译器出骨架  →  AI 只选一串结构化编辑 op  →  守卫逐条校验  →  应用

模型永远不产出 xlsx、也不产出整份 spec，它只能从 `template_edit` 已有的 op 里选
（改列名、调顺序、写说明、设下拉、改必填性）。所以：

* 锚点列删不掉、改不了名 —— 守卫拦着，和人工编辑走同一套；
* 回写路径断不了 —— `WRITEBACK_FIELDS` 那条守卫对 AI 一视同仁；
* 出错不致命 —— 某条 op 违规就丢掉那一条，其余照常应用，最差退回原始骨架。

这条分界线是有意的：**能确定性做的事不要交给模型**（哪些行进表、值从哪来、锚点
怎么埋），模型只做确定性代码做不了的那部分 —— 判断这个项目里哪些列重要、该用
客户的哪个词、哪些取值该做成下拉。
"""

from __future__ import annotations

from typing import Any

from .template_edit import EditError, apply_edit

__all__ = ["PLAN_SCHEMA", "plan_prompt", "apply_plan", "adapt_template"]


#: AI 只能选 op + 参数。**没有"直接给我一张表"这个选项** —— 那会丢掉锚点。
#: 白名单也刻意不含 add_column/drop_column：加列要有回写路径才有意义，删列容易
#: 把业务方要填的东西删没；这两个留给人工显式指令，AI 适配只做"改措辞、调顺序、
#: 给提示、设下拉、定必填"。
PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["edits"],
    "properties": {
        "edits": {
            "type": "array", "maxItems": 12,
            "items": {
                "type": "object", "required": ["op", "why"],
                "properties": {
                    "op": {"type": "string",
                           "enum": ["rename_column", "set_guide", "set_options",
                                    "set_role", "reorder_sheets"]},
                    "sheet": {"type": "string"},
                    "column": {"type": "string"},
                    "old": {"type": "string"}, "new": {"type": "string"},
                    "text": {"type": "string", "description": "set_guide：给业务方的说明"},
                    "role": {"type": "string",
                             "enum": ["locked", "prefilled", "required"]},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "order": {"type": "array", "items": {"type": "string"}},
                    "why": {"type": "string",
                            "description": "为什么这么改，一句话。会记进补丁日志备查"},
                },
            },
        },
    },
}


def plan_prompt(*, project: str, stats: dict[str, Any], sheets: list[dict[str, Any]],
                vocabulary: list[str], open_questions: list[str]) -> str:
    """让模型看着**这个项目的骨架和词汇**提改法。"""
    sheet_lines = "\n".join(
        f"- 「{s['name']}」{s.get('rows', 0)} 行；列：{'、'.join(s.get('columns') or [])}"
        for s in sheets)
    return "\n".join(x for x in [
        f"## 项目\n{project or '（未命名）'}\n",
        f"## 已抽出的产物规模\n{stats}\n",
        f"## 当前模板骨架\n{sheet_lines}\n",
        f"## 材料里出现的业务词\n{'、'.join(vocabulary[:40])}\n" if vocabulary else "",
        f"## 待澄清的问题\n" + "\n".join(f"- {q}" for q in open_questions[:8]) + "\n"
        if open_questions else "",
        "这张模板要发给**业务方**填。他们不是建模的人：`apiName`、`baseType`、"
        "`cardinality` 这些词他们读不懂，也不知道该往哪一列写什么。\n\n"
        "在**不改变有哪些行、值从哪来**的前提下，提一组改法让它更好填：\n"
        "- 把列名换成客户材料里的说法（用上面那些业务词，别自己造词）；\n"
        "- 给每张表写一句说明：这张表要他回答什么、答到什么程度算完；\n"
        "- 取值有限的列做成下拉（选项要来自材料里真出现过的值）；\n"
        "- 把最该他答、只有他答得了的表排前面。\n\n"
        "每条都要写 why。**没有把握就少提几条** —— 提一条错的改法比不提更糟。",
    ] if x)


def apply_plan(spec: Any, edits: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    """把 AI 提的改法逐条应用。返回 ``(应用成功的说明, 被拒的条目)``。

    **逐条独立**：一条违规只丢那一条，不影响其余，也绝不半途把 spec 留在中间态
    （`apply_edit` 本身是写时复制 + 守卫，被拒时原 spec 不动）。
    """
    done: list[str] = []
    rejected: list[dict[str, Any]] = []
    for e in edits or ():
        op = str(e.get("op") or "")
        args = {k: v for k, v in e.items()
                if k not in ("op", "why") and v not in (None, "", [])}
        try:
            done.append(apply_edit(spec, op, args))
        except (EditError, TypeError) as exc:
            # 守卫拒了就记下来。AI 提的改法和人工的一视同仁 —— 锚点、回写路径、
            # 下拉长度这些不变量对谁都不放行。
            rejected.append({**e, "why_rejected": str(exc)})
    return done, rejected


async def adapt_template(spec: Any, *, gateway: Any, node_id: str, project: str,
                         stats: dict[str, Any], vocabulary: list[str],
                         open_questions: list[str]) -> dict[str, Any]:
    """给骨架做一轮 AI 适配。**失败就用原骨架，绝不让这一步弄挂整次编译。**

    Returns:
        ``{"applied": [...], "rejected": [...], "error": str|None}``
    """
    sheets = [{"name": sh.name, "rows": len(sh.rows), "columns": list(sh.columns)}
              for sh in spec.sheets]
    try:
        comp = await gateway.call(
            node_id, plan_prompt(project=project, stats=stats, sheets=sheets,
                                 vocabulary=vocabulary, open_questions=open_questions),
            schema=PLAN_SCHEMA, max_tokens=4000, key="tpl_plan")
        edits = list((comp.data or {}).get("edits") or [])
    except Exception as exc:  # noqa: BLE001 — 模型不可用不该让模板出不来
        return {"applied": [], "rejected": [], "error": f"{type(exc).__name__}: {exc}"}
    applied, rejected = apply_plan(spec, edits)
    return {"applied": applied, "rejected": rejected, "error": None}
