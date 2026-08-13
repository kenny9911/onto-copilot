"""对话口述改 OIR —— 结构化编辑。

和模板/流图编辑同构：FDE 知道材料没写的事实（「采购包创建后状态变成已发布」、
「再加一个供应商对象」、「这条属性其实是必填」），要能**说给 Copilot 听、直接落进
本体**，而不是我们改代码。

同样的两条纪律：
    1. **模型只选操作和参数，绝不重写整份 OIR。** 直接让模型吐一份新 OIR 会把其它
       断言的溯源全抹掉 —— 每个值的 origin/evidence 是「这不是瞎编」的凭证。
    2. **口述的事实一律 `Origin.USER`（人工拍板），带 extractor="human" 的 Provenance，
       绝不冒充材料抽取（EXTRACTED）。** 它在 OIR 里可见、可信度高，但语义上是「人说的」，
       不是「材料里读到的」。这条由构造保证：所有赋值都走 :func:`by_user`。

原子性和模板编辑一样：在一份副本上应用、守卫过了才换回，半应用的 OIR 比不改更糟。
"""

from __future__ import annotations

from typing import Any

from .oir import (
    OIR,
    ActionType,
    BaseType,
    BusinessRule,
    Cardinality,
    LinkType,
    ObjectType,
    Origin,
    PropertyType,
    RuleKind,
    Status,
    by_user,
    inferred,
    make_rid,
    oir_from_dict,
)

__all__ = ["OIREditError", "apply_oir_edit"]


class OIREditError(ValueError):
    """一次 OIR 编辑不合法。消息要说清为什么，让模型能转述给用户。"""


def _human(value: Any, note: str) -> Any:
    """口述赋值的统一入口：Origin.USER + 一条 human Provenance。**不是材料证据。**"""
    return by_user(value, note=note)


def _label(ent: Any) -> str:
    for attr in ("display_name", "api_name", "statement"):
        a = getattr(ent, attr, None)
        if a is not None and getattr(a, "value", None):
            return str(a.value)
    return getattr(ent, "rid", "?")


# ══════════════════════════════════════════════════════════════════
#  解析（FDE 说的是名字/编号，不是 rid）
# ══════════════════════════════════════════════════════════════════
def _find_object(oir: OIR, ref: str) -> ObjectType:
    if ref in oir.objects:
        return oir.objects[ref]
    hit = [o for o in oir.objects.values()
           if o.api_name.value == ref or o.display_name.value == ref
           or ref in (o.aliases or [])]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        hit = [o for o in oir.objects.values()
               if ref in (o.display_name.value or "") or ref in (o.api_name.value or "")]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise OIREditError(f"找不到对象「{ref}」。")
    raise OIREditError(f"「{ref}」对应多个对象，说具体些："
                       f"{'、'.join(o.display_name.value for o in hit[:5])}")


def _find_property(oir: OIR, ref: str, *, parent: str | None = None) -> PropertyType:
    if ref in oir.properties:
        return oir.properties[ref]
    obj_ref, key = (parent, ref)
    if parent is None and "." in ref:            # 「采购包.状态」这种写法
        obj_ref, _, key = ref.partition(".")
    cands = list(oir.properties.values())
    if obj_ref:
        po = _find_object(oir, obj_ref)
        cands = [p for p in cands if p.parent == po.rid]
    hit = [p for p in cands
           if p.api_name.value == key or p.display_name.value == key]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        hit = [p for p in cands
               if key in (p.display_name.value or "") or key in (p.api_name.value or "")]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise OIREditError(f"找不到属性「{ref}」。")
    raise OIREditError(f"「{ref}」对应多个属性，说具体些（可写成「对象.属性」）。")


def _find_rule(oir: OIR, ref: str) -> BusinessRule:
    if ref in oir.rules:
        return oir.rules[ref]
    hit = [r for r in oir.rules.values() if ref in (r.statement.value or "")]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise OIREditError(f"找不到规则「{ref}」。")
    raise OIREditError(f"「{ref}」对应多条规则，说具体些。")


def _find_action(oir: OIR, ref: str) -> ActionType:
    if ref in oir.actions:
        return oir.actions[ref]
    hit = [a for a in oir.actions.values() if a.api_name.value == ref]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        hit = [a for a in oir.actions.values() if ref in (a.api_name.value or "")]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise OIREditError(f"找不到动作「{ref}」。")
    raise OIREditError(f"「{ref}」对应多个动作，说具体些。")


def _resolve_any(oir: OIR, ref: str) -> Any:
    """跨容器解析实体，供 edit_assertion / set_status 使用。"""
    for finder in (_find_object, _find_property, _find_rule, _find_action):
        try:
            return finder(oir, ref)
        except OIREditError:
            continue
    if ref in oir.links:
        return oir.links[ref]
    raise OIREditError(f"找不到「{ref}」对应的对象/属性/关系/动作/规则。")


# ══════════════════════════════════════════════════════════════════
#  新增（oir.add）
# ══════════════════════════════════════════════════════════════════
def _op_add_object_type(oir: OIR, *, api_name: str, display_name: str = "",
                        description: str = "") -> str:
    api_name = (api_name or "").strip()
    if not api_name:
        raise OIREditError("新增对象要给 api_name。")
    if any(o.api_name.value == api_name for o in oir.objects.values()):
        raise OIREditError(f"已有对象「{api_name}」，要改用 oir.edit。")
    ot = ObjectType(
        rid=make_rid("ot", api_name),
        api_name=_human(api_name, f"人工口述新增对象：{api_name}"),
        display_name=_human(display_name or api_name, "人工口述"),
        description=_human(description, "人工口述") if description else inferred(""))
    oir.add_object(ot)
    return f"新增对象「{display_name or api_name}」（人工口述，标 USER 来源）。"


def _op_add_property(oir: OIR, *, object: str, api_name: str, display_name: str = "",
                     base_type: str = "STRING", definition: str = "",
                     required: bool = False, value_domain: list[str] | None = None) -> str:
    parent = _find_object(oir, object)
    api_name = (api_name or "").strip()
    if not api_name:
        raise OIREditError("新增属性要给 api_name。")
    if any(p.parent == parent.rid and p.api_name.value == api_name
           for p in oir.properties.values()):
        raise OIREditError(f"对象「{parent.display_name.value}」已有属性「{api_name}」。")
    try:
        bt = BaseType(base_type)
    except ValueError:
        raise OIREditError(f"base_type 只能是 {[b.value for b in BaseType]}。") from None
    pt = PropertyType(
        rid=make_rid("pt", f"{parent.rid}_{api_name}"), parent=parent.rid,
        api_name=_human(api_name, "人工口述"),
        display_name=_human(display_name or api_name, "人工口述"),
        base_type=_human(bt, "人工口述"),
        definition=_human(definition, "人工口述") if definition else inferred(""),
        required=_human(bool(required), "人工口述"),
        value_domain=_human(list(value_domain), "人工口述") if value_domain
        else inferred(None))
    oir.add_property(pt)
    return f"给「{parent.display_name.value}」加属性「{display_name or api_name}」。"


def _op_add_link(oir: OIR, *, source: str, target: str, api_name: str = "",
                 cardinality: str = "ONE_TO_MANY",
                 join_key: dict[str, str] | None = None) -> str:
    src = _find_object(oir, source)
    tgt = _find_object(oir, target)
    try:
        card = Cardinality(cardinality)
    except ValueError:
        raise OIREditError(
            f"cardinality 只能是 {[c.value for c in Cardinality]}。") from None
    name = (api_name or "").strip() or f"{src.api_name.value}_{tgt.api_name.value}"
    lt = LinkType(
        rid=make_rid("lt", f"{src.rid}_{name}_{tgt.rid}"),
        api_name=_human(name, "人工口述"), source=src.rid, target=tgt.rid,
        cardinality=_human(card, "人工口述"),
        join_key=_human(dict(join_key), "人工口述") if join_key else inferred(None))
    oir.add_link(lt)
    return (f"连关系：「{src.display_name.value}」→「{tgt.display_name.value}」"
            f"（{card.value}）。")


def _op_add_rule(oir: OIR, *, statement: str, kind: str = "PROCESS",
                 applies_to: list[str] | None = None, actor: str = "") -> str:
    statement = (statement or "").strip()
    if not statement:
        raise OIREditError("新增规则要给 statement。")
    try:
        rk = RuleKind(kind)
    except ValueError:
        raise OIREditError(f"kind 只能是 {[k.value for k in RuleKind]}。") from None
    applies = [_find_object(oir, a).rid for a in (applies_to or [])]
    br = BusinessRule(
        rid=make_rid("br", statement),
        statement=_human(statement, "人工口述"), kind=_human(rk, "人工口述"),
        applies_to=applies,
        actor=_human(actor, "人工口述") if actor else inferred(""))
    oir.add_rule(br)
    return f"新增业务规则「{statement[:24]}」（{rk.value}）。"


def _op_add_action_type(
    oir: OIR,
    *,
    api_name: str,
    applies_to: list[str] | None = None,
    parameters: list[dict[str, Any]] | None = None,
    effects: list[str] | None = None,
    source_endpoint: dict[str, str] | None = None,
) -> str:
    """新增可执行语义动作；所有口述字段保持 USER provenance。"""
    api_name = (api_name or "").strip()
    if not api_name:
        raise OIREditError("新增动作要给 api_name。")
    if any(a.api_name.value == api_name for a in oir.actions.values()):
        raise OIREditError(f"已有动作「{api_name}」，要改用 oir.edit。")
    targets = [_find_object(oir, ref).rid for ref in (applies_to or [])]
    action = ActionType(
        rid=make_rid("at", api_name),
        api_name=_human(api_name, f"人工口述新增动作：{api_name}"),
        applies_to=targets,
        parameters=_human(list(parameters or []), "人工口述动作参数"),
        effects=_human(list(effects or []), "人工口述动作效果"),
        source_endpoint=(
            _human(dict(source_endpoint), "人工口述动作接口")
            if source_endpoint
            else inferred(None)
        ),
    )
    oir.add_action(action)
    return f"新增动作「{api_name}」（人工口述，标 USER 来源）。"


def _op_add_enum_value(oir: OIR, *, property: str, value: str) -> str:
    pt = _find_property(oir, property)
    dom = list(pt.value_domain.value or [])
    if value in dom:
        raise OIREditError(f"「{property}」已经有取值「{value}」。")
    dom.append(value)
    pt.value_domain = _human(dom, f"人工口述新增取值：{value}")
    if pt.base_type.value is not BaseType.ENUM:
        pt.base_type = _human(BaseType.ENUM, "人工口述：有取值域了，类型改 ENUM")
    return f"给属性「{pt.display_name.value}」加取值「{value}」。"


# ══════════════════════════════════════════════════════════════════
#  修改（oir.edit）
# ══════════════════════════════════════════════════════════════════
#: 可用 edit_assertion 改的断言字段 → 值的强制转换。
_COERCE = {
    "base_type": lambda v: BaseType(v),
    "cardinality": lambda v: Cardinality(v),
    "required": lambda v: bool(v) if isinstance(v, bool) else str(v).lower() in ("1", "true", "是", "yes"),
    "parameters": lambda v: list(v),
    "effects": lambda v: list(v),
    "source_endpoint": lambda v: dict(v) if v is not None else None,
}
_EDITABLE = {"display_name", "description", "definition", "base_type",
             "cardinality", "api_name", "required", "actor", "statement",
             "parameters", "effects", "source_endpoint"}


def _op_edit_assertion(oir: OIR, *, target: str, field: str, value: Any,
                       note: str = "") -> str:
    ent = _resolve_any(oir, target)
    if field not in _EDITABLE or not hasattr(ent, field):
        raise OIREditError(
            f"「{field}」不是可改字段。这个实体上可改：{sorted(_EDITABLE)}")
    try:
        coerced = _COERCE.get(field, lambda v: v)(value)
    except (ValueError, KeyError):
        raise OIREditError(f"{field} 的值「{value}」不合法。") from None
    setattr(ent, field, _human(coerced, note or f"人工口述改 {field}"))
    return f"把「{_label(ent)}」的 {field} 改为「{value}」。"


def _op_set_status(oir: OIR, *, target: str, status: str) -> str:
    ent = _resolve_any(oir, target)
    try:
        st = Status(status)
    except ValueError:
        raise OIREditError(f"status 只能是 {[s.value for s in Status]}。") from None
    ent.status = st
    return f"把「{_label(ent)}」标为 {st.value}。"


def _op_bind_rule(oir: OIR, *, rule: str, object: str) -> str:
    br = _find_rule(oir, rule)
    obj = _find_object(oir, object)
    if obj.rid not in br.applies_to:
        br.applies_to.append(obj.rid)
    br.status = Status.PROPOSED
    return f"把规则「{br.statement.value[:16]}」挂到「{obj.display_name.value}」。"


def _op_set_action_scope(oir: OIR, *, action: str, objects: list[str]) -> str:
    at = _find_action(oir, action)
    at.applies_to = [_find_object(oir, ref).rid for ref in objects]
    at.status = Status.PROPOSED
    return f"把动作「{at.api_name.value}」关联到 {len(at.applies_to)} 个数据对象。"


def _require_user_origin(ent: Any, kind: str) -> None:
    """只有人工口述加错的才能硬删；材料抽出来的删了会丢证据，引导去 set_status。"""
    for attr in ("display_name", "api_name", "statement"):
        a = getattr(ent, attr, None)
        if a is not None and a.origin is Origin.USER:
            return
    raise OIREditError(
        f"「{_label(ent)}」不是人工口述加的（是从材料抽出来的），删除会丢证据。"
        f"要排除请用 set_status(status=rejected)。")


def _op_remove_object_type(oir: OIR, *, target: str) -> str:
    o = _find_object(oir, target)
    _require_user_origin(o, "对象")
    for r in [p.rid for p in oir.properties.values() if p.parent == o.rid]:
        oir.properties.pop(r, None)
    for r in [l.rid for l in oir.links.values() if o.rid in (l.source, l.target)]:
        oir.links.pop(r, None)
    oir.objects.pop(o.rid, None)
    return f"删掉了对象「{o.display_name.value}」及其属性/相关关系。"


def _op_remove_property(oir: OIR, *, target: str) -> str:
    p = _find_property(oir, target)
    _require_user_origin(p, "属性")
    oir.properties.pop(p.rid, None)
    if (parent := oir.objects.get(p.parent)) and p.rid in parent.properties:
        parent.properties.remove(p.rid)
    return f"删掉了属性「{p.display_name.value}」。"


def _op_remove_link(oir: OIR, *, target: str) -> str:
    lt = oir.links.get(target)
    if lt is None:
        raise OIREditError(f"找不到关系「{target}」（用 rid）。")
    _require_user_origin(lt, "关系")
    oir.links.pop(lt.rid, None)
    return f"删掉了关系「{lt.api_name.value}」。"


def _op_remove_rule(oir: OIR, *, target: str) -> str:
    r = _find_rule(oir, target)
    _require_user_origin(r, "规则")
    oir.rules.pop(r.rid, None)
    return f"删掉了规则「{r.statement.value[:16]}」。"


def _op_remove_action_type(oir: OIR, *, target: str) -> str:
    action = _find_action(oir, target)
    _require_user_origin(action, "动作")
    oir.actions.pop(action.rid, None)
    return f"删掉了动作「{action.api_name.value}」。"


_OPS = {
    # add
    "add_object_type": _op_add_object_type,
    "add_property": _op_add_property,
    "add_link": _op_add_link,
    "add_rule": _op_add_rule,
    "add_action_type": _op_add_action_type,
    "add_enum_value": _op_add_enum_value,
    # edit
    "edit_assertion": _op_edit_assertion,
    "set_status": _op_set_status,
    "bind_rule": _op_bind_rule,
    "set_action_scope": _op_set_action_scope,
    "remove_object_type": _op_remove_object_type,
    "remove_property": _op_remove_property,
    "remove_link": _op_remove_link,
    "remove_rule": _op_remove_rule,
    "remove_action_type": _op_remove_action_type,
}


# ══════════════════════════════════════════════════════════════════
#  守卫
# ══════════════════════════════════════════════════════════════════
def _guard(oir: OIR) -> None:
    """编辑后的引用/唯一性校验。**PK/joinKey 缺失只是告警不阻塞** —— 口述是增量的，
    一个刚加的对象合理地还没主键。任何一条硬约束不过就整体拒绝、原 OIR 不动。"""
    for p in oir.properties.values():
        if p.parent not in oir.objects:
            raise OIREditError(f"属性 {p.rid} 的父对象 {p.parent} 不存在。")
    for l in oir.links.values():
        for side, r in (("from", l.source), ("to", l.target)):
            if r not in oir.objects:
                raise OIREditError(f"关系 {l.rid} 的 {side} 指向不存在的对象 {r}。")
    for r in oir.rules.values():
        for a in r.applies_to:
            if a not in oir.objects:
                raise OIREditError(f"规则 {r.rid} 挂到了不存在的对象 {a}。")
    for action in oir.actions.values():
        for target in action.applies_to:
            if target not in oir.objects:
                raise OIREditError(f"动作 {action.rid} 关联了不存在的对象 {target}。")
    seen: dict[str, str] = {}
    for o in oir.objects.values():
        k = o.api_name.value
        if k and k in seen:
            raise OIREditError(f"对象 api_name 重复：{k}")
        seen[k] = o.rid


def apply_oir_edit(oir: OIR, op: str, args: dict[str, Any]) -> str:
    """对 OIR 应用一次结构化编辑，成功返回一句人话。

    **在副本上应用、守卫通过后才换回** —— 被拒的编辑让活 OIR 字节不变，未触碰部分
    的溯源全保留。抛 :class:`OIREditError` 时调用方转述给用户。
    """
    fn = _OPS.get(op)
    if fn is None:
        raise OIREditError(f"不支持的 OIR 编辑 {op}。支持：{sorted(_OPS)}")
    trial = oir_from_dict(oir.to_dict())
    try:
        note = fn(trial, **args)
    except TypeError as exc:
        raise OIREditError(f"{op} 的参数不对：{exc}") from exc
    _guard(trial)
    # 通过：把 trial 的内容搬回 oir（保持同一个对象引用，s.state["_oir"] 持有它）
    oir.objects = trial.objects
    oir.properties = trial.properties
    oir.links = trial.links
    oir.actions = trial.actions
    oir.rules = trial.rules
    oir.questions = trial.questions
    return note
