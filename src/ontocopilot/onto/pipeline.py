"""主流水线 —— 真正跑在 Harness 上的 DAG。

之前的实现是一条手写的线性序列：把语料截断到固定条数，一次性丢给模型。在真实
材料上直接失败 —— 一份 326 切片的梳理表被截到 60 条，八成内容没进模型，抽出
58 个对象、**0 个属性、0 个关系**。

真实材料不是靠"一次大调用"能处理的。这里换成 Harness 该有的形态：

* **按 sheet / 章节切段，fan-out 成多个抽取节点。** 每段上下文有界，段与段并行。
  段数来自材料的**结构**（有几个 sheet），不来自内容 —— 计划冻结因此仍然成立。
* **节点内是 agent loop，不是单次调用。** 抽取节点能用 ``evidence.search`` 把
  需要的切片捞回来、用 ``profile.column`` 查列画像，边看边抽。
* **Critic 拦住"看起来跑完了其实什么都没抽到"。** 覆盖率视角会把"有对象没属性"
  判成 HIGH —— 这正是之前静默失败的形态。
* **反思回灌。** critic 的意见进 L3 记忆，后续段不再犯同样的错。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from ..kernel.agents import AgentSpec, default_agents
from ..kernel.critic import (
    Critic,
    CriticContext,
    Finding,
    RuleCritic,
    Severity,
    Verdict,
)
from ..kernel.dag import Dag, Difficulty, NodeBudget, NodeMode, NodeSpec, ScopeSpec
from ..kernel.loop import NodeHandler, RunContext
from ..kernel.memory.evidence import Chunk, EvidenceIndex
from .align import align_and_apply
from .shape import SegmentShape, Yield, infer_shape, structural_extract
from .clarify import ClarificationEngine
from .conflict import auto_repair, detect_all
from .oir import (
    OIR,
    ActionType,
    BusinessRule,
    BaseType,
    Cardinality,
    RuleKind,
    Status,
    LinkType,
    ObjectType,
    OpenQuestion,
    PropertyType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)
from .suggest import suggest
from .template import compile_template

#: 一段最多送多少切片给模型。超过这个数，模型的注意力会摊薄到读不进细节 ——
#: 这不是上下文窗口的限制，是有效注意力的限制。
SEGMENT_CHUNKS = 45

#: 一段最少要有多少切片才值得单独起一个节点。太碎会让每段都缺上下文。
MIN_SEGMENT = 6


# ══════════════════════════════════════════════════════════════════
#  切段
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class Segment:
    """一段待抽取的语料。"""

    key: str  # 节点后缀，要能做 DAG 节点 id
    label: str  # 人看的名字
    file_name: str
    chunk_ids: list[str]
    #: 由列画像推出的形状。决定这段该抽什么、以及哪些不用进模型。
    #: **按整张表推**，不是按这一段 —— 见 :func:`segment_corpus`。
    shape: SegmentShape = field(default_factory=SegmentShape)
    #: 本段第一行之前，各稀疏列最后一个非空取值（合并单元格的继承值）。
    #: 一张表被拦腰切开时，后半段读不到组名，靠这个补回来。
    carry_in: dict[str, str] = field(default_factory=dict)

    def rows(self, index: EvidenceIndex) -> tuple[list[dict[str, Any]], list[str]]:
        """本段的行数据与逐行出处。表格切片的 ``raw`` 就是一行。"""
        rows, cites = [], []
        for cid in self.chunk_ids:
            c = index.get(cid)
            if c is not None and isinstance(c.raw, dict) and _is_data_row(c):
                rows.append(c.raw)
                cites.append(c.cite())
        return rows, cites

    def render(self, index: EvidenceIndex, limit: int = SEGMENT_CHUNKS) -> str:
        chunks = [c for cid in self.chunk_ids[:limit] if (c := index.get(cid))]
        body = "\n".join(f"⟦{c.cite()}⟧ {c.render}" for c in chunks)
        more = (f"\n（本段另有 {len(self.chunk_ids) - limit} 个切片，"
                f"需要时用 evidence.search 按名字捞）" if len(self.chunk_ids) > limit else "")
        return f"## {self.label}（来自 {self.file_name}）\n{body}{more}"


#: 不是数据行的切片。解析器每张表还会额外产一片**列画像**、每份文件一片元数据 ——
#: 它们的 ``raw`` 同样是 dict，混进行里就会被抽成一个 apiName 是整坨 profile JSON
#: 的"实体"，一路混进模板和 critic 报告。判据用 tag，对所有解析器都成立。
_NON_ROW_TAGS = frozenset({"schema", "meta", "toc"})


def _is_data_row(chunk: Any) -> bool:
    return not (_NON_ROW_TAGS & set(getattr(chunk, "tags", ()) or ()))


def segment_corpus(index: EvidenceIndex, docs: list[Any]) -> list[Segment]:
    """把语料切成有界的段。

    切分依据是材料的**结构**（sheet、章节、表名），不是内容 —— 所以段数在读取
    内容之前就确定，计划冻结成立。按结构切也保证了段内语义是完整的：一个 sheet
    就是一张表，切开它才会真的丢信息。

    **形状按整张表推，不按切出来的窗口推。** 一张 112 行的表被切成三段之后，
    第二段里「业务对象」那一列可能整列是空的（合并单元格只在组首写一次）——
    单看那一段，它是个空列；放回整张表看，它是分组列。按窗口推形状的后果是
    同一张表的三段判出三种形状，后两段的宿主全部丢失。
    """
    groups: dict[tuple[str, str], list[str]] = {}
    for doc in docs:
        for c in doc.chunks:
            loc = c.locator
            key = (loc.get("sheet") or loc.get("object", "").split(".")[0]
                   or loc.get("section") or (f"p{loc.get('page')}" if loc.get("page") else "")
                   or c.tags[0] if c.tags else "") or "main"
            groups.setdefault((doc.file_name, str(key)), []).append(c.chunk_id)

    # 太小的段并回同文件的"其它"，避免每段都缺上下文
    merged: dict[tuple[str, str], list[str]] = {}
    for (fname, key), ids in groups.items():
        target = (fname, key) if len(ids) >= MIN_SEGMENT else (fname, "其它")
        merged.setdefault(target, []).extend(ids)

    out: list[Segment] = []
    for i, ((fname, key), ids) in enumerate(sorted(merged.items())):
        whole = Segment(key=f"s{i}", file_name=fname, label=key, chunk_ids=ids)
        rows, _ = whole.rows(index)
        # 形状只看列的取值分布，不看内容语义 —— 冻结计划的边界没有被破坏。
        shape = infer_shape(rows)
        # 超长的段再按 SEGMENT_CHUNKS 拆，保证每个节点上下文有界
        carry: dict[str, str] = {}
        for part in range(0, max(1, len(ids)), SEGMENT_CHUNKS):
            slice_ids = ids[part:part + SEGMENT_CHUNKS]
            if not slice_ids:
                continue
            seg = Segment(
                key=f"s{i}_{part // SEGMENT_CHUNKS}", file_name=fname,
                label=key + (f"（第 {part // SEGMENT_CHUNKS + 1} 部分）"
                             if len(ids) > SEGMENT_CHUNKS else ""),
                chunk_ids=slice_ids, shape=shape, carry_in=dict(carry))
            part_rows, _ = seg.rows(index)
            seg.shape = _window_shape(shape, part_rows)
            for r in part_rows:
                for k, v in r.items():
                    if (text := str(v or "").strip()):
                        carry[str(k)] = text
            out.append(seg)
    return out


def _window_shape(sheet_shape: SegmentShape, part_rows: list[dict[str, Any]]) -> SegmentShape:
    """整张表的形状 + 这一窗口的行数。

    列角色、能出什么、哪些规则可定 —— 全部沿用整张表的判断；只有"这一段有几行"
    是窗口自己的，因为 critic 的行覆盖判据要拿它和抽出来的条数比。
    """
    from dataclasses import replace

    return replace(sheet_shape, row_count=len(part_rows))


# ══════════════════════════════════════════════════════════════════
#  「这一段还欠什么」—— 任务描述与 critic 的共同判据
# ══════════════════════════════════════════════════════════════════
#: 会被 critic 判缺失的产出类型。任务描述必须逐条点名要，否则模型不知道要抽，
#: critic 却照判 —— 两边不闭合就会空转、并在修订环里把已抽的东西冲掉。
CHECKED_YIELDS: tuple[Yield, ...] = (Yield.OBJECTS, Yield.PROPERTIES, Yield.ACTIONS)

#: 每类产出对应的要求文案。
_ASK: dict[Yield, str] = {
    Yield.OBJECTS: "这一段涉及的**业务对象**（apiName + 中文名），"
                   "一个对象出现多次只抽一次",
    Yield.PROPERTIES: "**每一行字段抽成一个 PropertyType**，"
                      "口径（税/时间粒度/口径主体/币种）写进 definition",
    Yield.ACTIONS: "对象上的**行动**（谁在什么条件下能改这条数据）",
}


def outstanding(shape: SegmentShape, have: dict[str, Any]) -> list[Yield]:
    """这一段还欠哪些产出。

    Args:
        shape: 段形状，决定"本该有什么"。
        have: 已经拿到的产出（规则抽的 / 最终产物），按 :class:`Yield` 的值分桶。
    """
    return [y for y in CHECKED_YIELDS
            if shape.expects(y) and not (have.get(y.value) or [])]


def _host_names(pre: dict[str, list[dict[str, Any]]]) -> list[str]:
    """规则从分组列里读到的宿主业务对象名，按出现顺序去重。"""
    seen: dict[str, None] = {}
    for a in pre.get("actions") or ():
        if name := str(a.get("object_display") or "").strip():
            seen.setdefault(name, None)
    for o in pre.get("objects") or ():
        if name := str(o.get("group") or "").strip():
            seen.setdefault(name, None)
    return list(seen)


# ══════════════════════════════════════════════════════════════════
#  抽取
# ══════════════════════════════════════════════════════════════════
class ExtractSegment(NodeHandler):
    """抽一段。节点内是 agent loop —— 能用工具把需要的切片捞回来再抽。"""

    def __init__(self, segment: Segment, index: EvidenceIndex, agent: AgentSpec,
                 system: str) -> None:
        self.segment = segment
        self.index = index
        self.schema = agent.output_schema
        self.system = system
        self._pre: dict[str, list[dict[str, Any]]] | None = None

    def prefilled(self) -> dict[str, list[dict[str, Any]]]:
        """规则先抽一遍。结果缓存 —— dispatch 和 critic 都要看同一份。"""
        if self._pre is None:
            rows, cites = self.segment.rows(self.index)
            self._pre = structural_extract(rows, cites, self.segment.shape,
                                           carry_in=self.segment.carry_in)
        return self._pre

    def wants(self) -> list[Yield]:
        """这一段还欠模型哪些产出。**任务描述和 critic 判据共用这一个判据。**

        以前两边各写各的：critic 按 ``shape.yields`` 判缺失，任务描述按另一串
        手写的 if 点名。行动表段上两边分道扬镳 —— critic 判「对象缺失」，任务
        描述从头到尾没提过对象。模型照着任务做完被打回，重出一版反而把规则抽好的
        45 个行动冲掉了。契约闭合之后这类空转不会再有。
        """
        return outstanding(self.segment.shape, self.prefilled())

    def task(self, inputs: dict[str, Any]) -> str:
        shape = self.segment.shape
        pre = self.prefilled()
        n_obj, n_act = len(pre["objects"]), len(pre["actions"])

        lines = [f"这一段材料的形状已经由规则判定过了：\n{shape.describe()}\n"]
        if n_obj or n_act:
            # 规则抽出来的东西**不要**让模型复述一遍。让它复述 168 行既会丢行
            # （模型一定会截断），又要为零信息量的复制付 Opus 的钱。
            lines.append(
                f"其中 {n_obj} 个对象" + (f"、{n_act} 个行动" if n_act else "")
                + "**已经由规则逐行抽好了，你不要重复抽，也不要改动它们**。\n"
                  f"已抽出的对象名：{_preview_names(pre['objects'])}\n")

        owed = self.wants()
        want = [_ASK[y] for y in owed]
        # 宿主对象名就写在分组列里，直接摆给模型看。不给的话它只能满库检索去猜
        # ——真实材料上那是四轮 evidence.search 之后一个对象也没抽出来。
        if Yield.OBJECTS in owed and (hosts := _host_names(pre)):
            lines.append(f"这一段的宿主业务对象（分组列的取值，共 {len(hosts)} 个）："
                         f"{'、'.join(hosts[:20])}\n"
                         "它们是中文业务名，要按命名规范给出 apiName；"
                         "同名的只出一次。\n")
        if Yield.LINKS in shape.yields or n_obj:
            want.append("对象之间的**关系**（主从、引用、头行结构）—— "
                        "材料里明确写了的才算，命名相似不构成关系")
        if Yield.RULES in shape.yields:
            want.append("散文里的**业务规则与约束**，挂到它约束的对象上")
        if not want:
            want.append("补齐上面规则没能确定的部分")

        if Yield.PROPERTIES not in shape.yields:
            lines.append("⚠ **这一段没有字段列，因此没有属性可抽。**"
                         "不要为了凑数把行名、说明文字当成属性。\n")

        return (
            f"{''.join(lines)}\n"
            f"你要做的是：\n"
            + "\n".join(f"{i + 1}. {w}" for i, w in enumerate(want))
            + f"\n\n{self.segment.render(self.index)}\n\n"
            "规矩：\n"
            "- 出处用 ⟦⟧ 里的原样字符串，不要改写。\n"
            "- 单元格里的说明文字（如「与某某一致」「见附件」）**不是实体名**。\n"
            "- 材料里没提到的东西一个字都不要补；拿不准就用 evidence.search 去捞原文。"
        )

    def query(self, inputs: dict[str, Any]) -> str:
        return f"{self.segment.label} {self.segment.file_name}"

    def finalize(self, draft: Any, inputs: dict[str, Any]) -> Any:
        """把规则抽出的对象/行动并进模型产出。规则的那份是权威，冲突以它为准。"""
        pre = self.prefilled()
        if not isinstance(draft, dict):
            draft = {}
        out = dict(draft)
        # questions 走单独分支：它的去重键不是 api_name，而且模型永远不该产出
        # 问题（schema 里没有这个字段），规则那份直接全收。
        out["questions"] = list(pre.get("questions") or [])
        for key in ("objects", "properties", "links", "actions"):
            model_side = list(out.get(key) or [])
            rule_side = pre.get(key) or []
            if not rule_side:
                out[key] = model_side
                continue
            taken = {str(x.get("api_name", "")).strip().lower()
                     for x in rule_side if isinstance(x, dict)}
            # 模型若重复抽了同名的，丢掉模型那份 —— 规则那份带着逐行出处
            out[key] = rule_side + [x for x in model_side if isinstance(x, dict)
                                    and str(x.get("api_name", "")).strip().lower() not in taken]
        return out

    async def dispatch(self, action: dict[str, Any], ctx: RunContext) -> Any:
        """agent loop 里的工具调用。"""
        tools = ctx.bus.read("_tools")
        if tools is None:
            return {"error": "本节点没有可用工具"}
        try:
            return await tools.call(action.get("tool", ""), action.get("args") or {},
                                    ctx, scope="extract")
        except Exception as exc:  # noqa: BLE001 — 工具失败要回给模型，不是中断整个节点
            return {"error": f"{type(exc).__name__}: {exc}"}



class MineRules(NodeHandler):
    """散文段的抽取。和实体抽取是两件事，所以是两个 handler、两套 schema。

    之前这类段落走的是实体抽取那条路：让模型从"采购计划员职责：1、负责……"里抽
    ObjectType。模型照做了，抽出一堆「与采购需求计划一致」这样的伪实体；抽对的
    那部分（规则本身）反而因为 schema 里没有容器被整段丢掉，critic 只能报一句
    "什么都没抽出来"。**没地方放的东西，模型抽得再准也等于没抽。**
    """

    def __init__(self, segment: Segment, index: EvidenceIndex, agent: AgentSpec,
                 system: str) -> None:
        self.segment = segment
        self.index = index
        self.schema = agent.output_schema
        self.system = system

    def task(self, inputs: dict[str, Any]) -> str:
        return (
            f"下面这段是散文，不是表格。{self.segment.shape.describe()}\n\n"
            "把里面**可判定**的业务规则一条条挖出来：谁、在什么条件下、能做或不能做"
            "什么。一段话里编号列了几条就是几条，不要合并。\n"
            "规则约束哪个业务对象 —— 只有材料里点了名的才填 applies_to，"
            "拿不准留空（留空会转成一个反问，挂错则会把错误约束焊死）。\n\n"
            f"{self.segment.render(self.index)}\n\n"
            "出处用 ⟦⟧ 里的原样字符串。"
        )

    def query(self, inputs: dict[str, Any]) -> str:
        return f"{self.segment.label} 业务规则 约束 职责"

    async def dispatch(self, action: dict[str, Any], ctx: RunContext) -> Any:
        tools = ctx.bus.read("_tools")
        if tools is None:
            return {"error": "本节点没有可用工具"}
        try:
            return await tools.call(action.get("tool", ""), action.get("args") or {},
                                    ctx, scope="extract")
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}



class HarvestQuestions(NodeHandler):
    """问卷段。**一次模型都不调。**

    一行一个问题，列角色已经判定，映射完全确定 —— 让模型复述 150 行既会截断
    丢行，又要为零信息量的复制付 Opus 的钱。这一段的价值不在"理解"，在"一条
    不落地搬过来，并且每条都带着原始单元格的出处"。
    """

    def __init__(self, segment: Segment, index: EvidenceIndex) -> None:
        self.segment = segment
        self.index = index
        self.schema = None
        self.system = ""
        self._pre: dict[str, list[dict[str, Any]]] | None = None

    def prefilled(self) -> dict[str, list[dict[str, Any]]]:
        if self._pre is None:
            rows, cites = self.segment.rows(self.index)
            self._pre = structural_extract(rows, cites, self.segment.shape,
                                           carry_in=self.segment.carry_in)
        return self._pre

    def task(self, inputs: dict[str, Any]) -> str:
        return f"搬运问卷：{self.segment.label}"

    def skip_model(self, inputs: dict[str, Any]) -> Any:
        return self.prefilled()


class MergeSegments(NodeHandler):
    """把各段的抽取结果合并成 OIR。结构组装是确定性的，不交给模型。"""

    def __init__(self, index: EvidenceIndex) -> None:
        self.index = index

    def task(self, inputs: dict[str, Any]) -> str:
        return "合并各段抽取结果"

    async def execute(self, inputs: dict[str, Any], ctx: RunContext) -> Any:
        merged = {"objects": [], "properties": [], "links": [], "actions": [],
                  "rules": [], "questions": []}
        for out in inputs.values():
            if not isinstance(out, dict):
                continue
            for k in merged:
                merged[k].extend(out.get(k) or [])
        return merged


# ══════════════════════════════════════════════════════════════════
#  OIR 组装
# ══════════════════════════════════════════════════════════════════
def build_oir(data: dict[str, Any], index: EvidenceIndex | None = None) -> OIR:
    """抽取结果 → OIR。

    这一步全是确定性代码：查重、挂父子、推主键。让模型做这些只会引入随机性，
    而结构错了后面所有环节都跟着错。
    """
    oir = OIR()
    by_api: dict[str, str] = {}
    #: 分组列（「业务对象」那一列）的取值 → 该组**第一行**实体的 rid。
    #:
    #: 行动表和实体表之间唯一对得上的东西就是这个中文分组名：行动表写
    #: 「业务对象=采购需求计划」，实体表把 pbpHeader/pbpLine/pbpRel 归在同一个
    #: 「采购需求计划」下。取第一行不是随手挑的 —— Excel 里合并单元格的组首
    #: 就是头实体（pbpHeader / poHeader），这是材料自己的书写顺序。
    #: 没有这张表，112 行接口会全部变成挂不上宿主的孤儿。
    by_group: dict[str, str] = {}

    for o in data.get("objects", ()):
        api = str(o.get("api_name") or "").strip()
        if not api or _looks_like_prose(api):
            continue  # 单元格说明文字不是实体名
        rid = make_rid("ot", api)
        group = str(o.get("group") or "").strip()
        if rid in oir.objects:
            # 多段抽到同一个对象：保留先出现的，把别名并进去
            alias = str(o.get("display_name") or "").strip()
            if alias and alias not in oir.objects[rid].aliases:
                oir.objects[rid].aliases.append(alias)
            by_api[api.lower()] = rid
            if group:
                by_group.setdefault(group, rid)
            continue
        ev = _prov(o, index)
        oir.add_object(ObjectType(
            rid=rid, api_name=extracted(api, ev),
            display_name=extracted(str(o.get("display_name") or api), ev),
            description=extracted(o["description"], ev) if o.get("description")
            else inferred(""),
            primary_key=inferred([])))
        by_api[api.lower()] = rid
        if group:
            if group not in by_group:
                by_group[group] = rid
                # 组首同时以业务名示人。这是一条**推断**，所以要进术语表让业务方
                # 确认 —— 「采购需求计划 = 采购业务计划头」对不对，只有他知道。
                if group not in oir.objects[rid].aliases:
                    oir.objects[rid].aliases.append(group)

    for i, p in enumerate(data.get("properties", ())):
        parent = by_api.get(str(p.get("parent_api_name") or "").lower())
        api = str(p.get("api_name") or "").strip()
        if parent is None or not api:
            continue
        rid = make_rid("pt", f"{p['parent_api_name']}_{api}_{i}")
        if rid in oir.properties:
            continue
        ev = _prov(p, index)
        try:
            bt = BaseType(str(p.get("base_type", "STRING")).upper())
        except ValueError:
            bt = BaseType.STRING
        oir.add_property(PropertyType(
            rid=rid, parent=parent,
            api_name=extracted(api, ev),
            display_name=extracted(str(p.get("display_name") or api), ev),
            base_type=extracted(bt, ev),
            definition=extracted(str(p.get("definition") or ""), ev),
            unit=extracted(p["unit"], ev) if p.get("unit") else inferred(None),
            required=inferred(bool(p.get("required")))))

    for l in data.get("links", ()):
        src = by_api.get(str(l.get("from_api_name") or "").lower())
        tgt = by_api.get(str(l.get("to_api_name") or "").lower())
        api = str(l.get("api_name") or "").strip()
        if not src or not tgt or not api:
            continue
        rid = make_rid("lt", api)
        if rid in oir.links:
            continue
        ev = _prov(l, index)
        try:
            card = Cardinality(str(l.get("cardinality", "ONE_TO_MANY")).upper())
        except ValueError:
            card = Cardinality.ONE_TO_MANY
        oir.add_link(LinkType(
            rid=rid, api_name=extracted(api, ev), source=src, target=tgt,
            cardinality=extracted(card, ev), join_key=inferred(None)))

    # 行动。宿主写的是中文名（"采购需求计划"），apiName 得靠显示名反查 ——
    # 行动表和实体表是两张表，它们之间只有中文名对得上。
    by_display: dict[str, str] = {}
    for rid, ot in oir.objects.items():
        by_display.setdefault(ot.display_name.value.strip(), rid)
        for a in ot.aliases:
            by_display.setdefault(a.strip(), rid)

    for a in data.get("actions", ()):
        api = str(a.get("api_name") or "").strip()
        # 说明文字同样不是接口名。行动表里「与采购需求计划一致」这种格子，
        # 抽成一个行动之后既挂不上宿主，又会占着模板里的一行。
        if not api or _looks_like_prose(api):
            continue
        rid = make_rid("at", api)
        if rid in oir.actions:
            continue
        host = _resolve_host(a, by_api, by_display, by_group)
        ev = _prov(a, index)
        oir.add_action(ActionType(
            rid=rid, api_name=extracted(api, ev),
            applies_to=[host] if host else [],
            source_endpoint=extracted({"path": str(a.get("endpoint") or ""),
                                       "display": str(a.get("display_name") or "")}, ev)
            if a.get("endpoint") else inferred(None)))


    # 业务规则。挂不上对象的照样收下 —— 它会变成一个反问，而不是被丢掉。
    for i, r in enumerate(data.get("rules", ())):
        stmt = str(r.get("statement") or "").strip()
        if len(stmt) < 6:
            continue
        rid = make_rid("br", f"{stmt[:40]}_{i}")
        if rid in oir.rules:
            continue
        ev = _prov(r, index)
        try:
            rk = RuleKind(str(r.get("kind", "OTHER")).upper())
        except ValueError:
            rk = RuleKind.OTHER
        hosts = [h for name in (r.get("applies_to") or [])
                 if (h := by_api.get(str(name).lower())
                     or by_display.get(str(name).strip())
                     or by_group.get(str(name).strip()))]
        oir.add_rule(BusinessRule(
            rid=rid, statement=extracted(stmt, ev), kind=extracted(rk, ev),
            applies_to=hosts, actor=extracted(str(r.get("actor") or ""), ev)))

    # 待澄清问题。已填答复的是**事实**（status=CONFIRMED，answer 带出处），
    # 未填的才是待办 —— 下游模板只搬未填的那部分。
    for i, q in enumerate(data.get("questions", ())):
        text = str(q.get("text") or "").strip()
        if len(text) < 6:
            continue
        rid = make_rid("oq", f"{q.get('code') or ''}_{text[:40]}_{i}")
        if rid in oir.questions:
            continue
        ev = _prov(q, index)
        ans = str(q.get("answer") or "").strip()
        oir.add_question(OpenQuestion(
            rid=rid, text=extracted(text, ev),
            options=list(q.get("options") or []),
            answer=extracted(ans, ev) if ans else inferred(""),
            group=str(q.get("group") or ""), code=str(q.get("code") or ""),
            applies_to=[h for name in (q.get("applies_to") or [])
                        if (h := by_api.get(str(name).lower())
                            or by_display.get(str(name).strip())
                            or by_group.get(str(name).strip()))],
            asked_by="customer",
            status=Status.CONFIRMED if ans else Status.CANDIDATE))

    for o in oir.objects.values():
        pk = [r for r in o.properties
              if oir.properties[r].api_name.value.lower().endswith("id")]
        if pk:
            o.primary_key = inferred(pk[:1])
    return oir


#: 单元格里的说明文字被当成实体名，是真实材料上最常见的抽取噪声。
#: 「与采购需求计划一致」「见附件」这种不是对象。
_PROSE_HINTS = ("一致", "同上", "见附件", "待定", "参见", "同前", "略", "无",
                "如下", "以上", "详见")

#: 代码风格的标识符。长度判据对它**不成立** ——
#: `bdPurchaseDocSubtypeMapping` 27 个字符，是个规规矩矩的 apiName；
#: 真实材料上这条把一批合法实体名报成了"说明文字"。
_CODE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?:[_.\-][A-Za-z0-9]+)*$")


def _looks_like_prose(name: str) -> bool:
    n = str(name).strip()
    if not n:
        return True
    if _CODE_NAME.match(n):
        # 标识符按标识符的规矩判：只有长到不像人会起的名字才算噪声
        return len(n) > 64
    if len(n) > 24:
        return True
    return any(h in n for h in _PROSE_HINTS)


def _resolve_host(action: dict[str, Any], by_api: dict[str, str],
                  by_display: dict[str, str], by_group: dict[str, str]) -> str | None:
    """一个行动挂在哪个对象上。四条线索**按可信度**依次试，绝不猜。

    1. ``object``：模型直接给了 apiName，最硬；
    2. ``object_display`` 命中某个实体的中文名或别名；
    3. ``object_display`` 命中分组列 —— 行动表和实体表之间的正规接缝；
    4. 分组名是某个实体名的**前缀或后缀**（「采购订单」⊂「采购订单头」）。
       只在唯一命中时采纳；命中多个说明这个名字有歧义，宁可挂空 ——
       挂空会变成一个反问，挂错会把错误的权限焊在错误的对象上。
    """
    if host := by_api.get(str(action.get("object") or "").strip().lower()):
        return host
    name = str(action.get("object_display") or "").strip()
    if not name:
        return None
    if host := by_display.get(name) or by_group.get(name):
        return host
    near = [rid for disp, rid in by_display.items()
            if disp.startswith(name) or disp.endswith(name)]
    return near[0] if len(set(near)) == 1 else None


def _prov(item: dict[str, Any], index: EvidenceIndex | None) -> Provenance:
    """按出处串还原 locator。

    优先在索引里按 cite 精确匹配 —— 匹配上就拿到**真实的结构化 locator**，
    而不是把自由文本硬塞进字段（那会渲染成乱码，等于溯源失效）。

    规则抽出来的条目 cite 是本地生成的、必然命中，置信度给满；模型给的 cite 可能
    是改写过的，命中也只给 0.85 —— 它证明的是"这句话在这里"，不是"这个判断对"。
    """
    cite = str(item.get("source_locator") or "").strip()
    fname = str(item.get("source_file") or "").strip()
    by_rule = item.get("_origin") == "rule"
    if index is not None and cite:
        c = _cite_index(index).get(cite)
        if c is None and fname:
            c = next((x for k, x in _cite_index(index).items() if k.endswith(cite)), None)
        if c is not None:
            return Provenance(c.file_id, c.file_name, c.locator,
                              snippet=c.render[:200],
                              extractor="rule" if by_rule else "llm",
                              confidence=1.0 if by_rule else 0.85)
    return Provenance(f"f_{(fname or 'x')[:6]}", fname or "未知来源",
                      {"kind": "raw", "ref": cite or "未标注位置"},
                      snippet=str(item.get("definition") or item.get("display_name") or "")[:200],
                      extractor="rule" if by_rule else "llm", confidence=0.6)


#: cite → chunk。每条断言都全表扫一遍的话，162 个对象 × 326 个切片就是五万次
#: 字符串比较，而这张表在一次 build 里是不变的。
_CITE_CACHE: dict[int, dict[str, Chunk]] = {}


def _cite_index(index: EvidenceIndex) -> dict[str, Chunk]:
    key = id(index)
    if key not in _CITE_CACHE:
        _CITE_CACHE[key] = {c.cite(): c for c in index._chunks.values()}  # noqa: SLF001
    return _CITE_CACHE[key]


# ══════════════════════════════════════════════════════════════════
#  Critic
# ══════════════════════════════════════════════════════════════════
class CoverageCritic(Critic):
    """覆盖率视角 —— 拦住"看起来跑完了其实什么都没抽到"。

    这是真实材料上最危险的失败：抽出一串对象名、零个属性，流水线一路绿灯跑到底，
    产出一份空模板。**规则能判的必须规则判** —— 靠人看统计数字是靠不住的。

    按 ``ctx.node_id`` 认领自己那一段，所以一个实例服务所有 fan-out 节点。
    """

    name = "coverage"
    needs_llm = False

    def __init__(self, segments: list[Segment], index: EvidenceIndex) -> None:
        self._by_key = {s.key: s for s in segments}
        self.index = index

    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict:
        seg = self._by_key.get(ctx.node_id.rsplit(".", 1)[-1])
        findings = self._check(draft, seg) if seg else []
        return Verdict(
            lens=self.name,
            passed=not any(f.severity is Severity.HIGH for f in findings),
            findings=findings, note=f"覆盖率视角 · {len(findings)} 条")

    def _check(self, draft: Any, segment: Segment) -> list[Finding]:
        index = self.index
        if not isinstance(draft, dict):
            return [Finding(Severity.HIGH, "EXTRACT_EMPTY", segment.key,
                            "抽取没有返回结构化结果", verifier="type")]
        objs = draft.get("objects") or []
        props = draft.get("properties") or []
        acts = draft.get("actions") or []
        shape = segment.shape
        out: list[Finding] = []

        # 只对"这段确实应该有"的产出判缺失。以前这里假设"表里必有字段行"，在
        # 实体登记表上把"零属性"报成 HIGH，节点反复重试直到烧穿预算 —— 而零属性
        # 才是那张表的正确答案。判据必须来自形状，不能来自对材料的假设。
        #
        # 判据函数与 `ExtractSegment.wants()` 是同一个 —— critic 判缺的每一类，
        # 任务描述里都点名要过。两边各写各的判据是上一版真实卡死的成因。
        cn = {Yield.PROPERTIES: "属性", Yield.OBJECTS: "对象", Yield.ACTIONS: "行动"}
        for y in outstanding(shape, {"objects": objs, "properties": props,
                                     "actions": acts}):
            out.append(Finding(
                Severity.HIGH, f"{y.value.upper()}_MISSING", segment.key,
                f"这段的形状是「{shape.row_unit}」、{shape.row_count} 行，"
                f"应该能抽出{cn[y]}，实际一个都没有",
                evidence_checked=[segment.label],
                proposed_fix={"action": "RETRY",
                              "hint": f"逐行抽{cn[y]}；{shape.note}"},
                verifier="rule:coverage"))

        # 行覆盖：一行一实体的登记表，抽出的对象数应当与行数同量级。
        # 这才是这类材料真正的失败模式 —— 168 行只抽了 58 个，模型截断了。
        if shape.row_unit == "object" and shape.row_count >= 10:
            got = len({str(o.get("api_name", "")).strip().lower() for o in objs
                       if isinstance(o, dict)})
            if got < shape.row_count * 0.8:
                out.append(Finding(
                    Severity.HIGH, "ROWS_DROPPED", segment.key,
                    f"这段有 {shape.row_count} 行、一行一个对象，但只抽出 {got} 个 —— "
                    f"漏了 {shape.row_count - got} 行",
                    evidence_checked=[segment.label],
                    proposed_fix={"action": "RETRY", "hint": "逐行过一遍，不要跳行、不要合并"},
                    verifier="rule:coverage"))

        if shape.row_unit == "question":
            # 问卷段的产出是 questions。判它有没有对象等于问错了问题 —— 而报
            # HIGH 会让节点反复重试直到烧穿预算。
            if not (draft.get("questions") or []):
                out.append(Finding(
                    Severity.HIGH, "QUESTIONS_MISSING", segment.key,
                    f"这段 {shape.row_count} 行是待填问卷，一个问题都没抽出来",
                    verifier="rule:coverage"))
            return out

        if shape.row_unit == "rule":
            # 规则段的产出是 rules，判它有没有对象等于问错了问题
            if not (draft.get("rules") or []):
                out.append(Finding(
                    Severity.HIGH, "RULES_MISSING", segment.key,
                    f"这段 {shape.row_count} 行全是散文，一条业务规则都没挖出来",
                    proposed_fix={"action": "RETRY",
                                  "hint": "按编号逐条挖，可判定的才算"},
                    verifier="rule:coverage"))
            return out

        if not objs and not props and not acts:
            out.append(Finding(
                Severity.HIGH, "EXTRACT_EMPTY", segment.key,
                f"这段 {len(segment.chunk_ids)} 个切片什么都没抽出来",
                verifier="rule:coverage"))

        for o in objs:
            name = str(o.get("api_name") or "")
            if _looks_like_prose(name):
                out.append(Finding(
                    Severity.MEDIUM, "PROSE_AS_ENTITY", name,
                    f"「{name}」看起来是单元格里的说明文字，不是实体名",
                    verifier="rule:prose"))
        return out


def provenance_critic() -> RuleCritic:
    """溯源视角 —— 每条断言都要指向材料里真实存在的位置。"""

    def check(draft: Any) -> list[Finding]:  # noqa: D401
        if not isinstance(draft, dict):
            return []
        out: list[Finding] = []
        for bucket in ("objects", "properties", "links"):
            for item in draft.get(bucket) or []:
                if not str(item.get("source_locator") or "").strip():
                    out.append(Finding(
                        Severity.MEDIUM, "EVIDENCE_MISSING",
                        str(item.get("api_name") or "?"),
                        f"{bucket} 里有条目没给出处", verifier="rule:provenance"))
        return out[:12]

    return RuleCritic("provenance", check)


# ══════════════════════════════════════════════════════════════════
#  DAG
# ══════════════════════════════════════════════════════════════════
def build_dag(segments: list[Segment]) -> Dag:
    """按段数展开的抽取 DAG。

    ``EXTRACT.*`` 是通配依赖，所以 MERGE 天然是同步屏障 —— 各段并行抽，抽完
    才合并。不需要额外的 barrier 语法。
    """
    d = Dag("onto_extract", freeze_before="EXTRACT")
    d.add(NodeSpec("EXTRACT", NodeMode.PLAN_EXECUTE, "extract",
                   fanout_over="segments",
                   # evidence_top_k=0：段内容已经在任务描述里，L2 再预灌一遍就是
                   # 同样的东西喂两遍 —— 真实材料上这让每次调用涨到 90k 输入、
                   # 9 段直接烧穿预算。要额外证据请用 evidence.search 工具按需捞。
                   scope=ScopeSpec(evidence_top_k=0),
                   budget=NodeBudget(tokens=24_000, iterations=4, wallclock_s=420),
                   critics=("coverage", "provenance"), critic_rounds=2,
                   difficulty=Difficulty.HIGH, retries=1))
    d.add(NodeSpec("MERGE", NodeMode.DETERMINISTIC, "merge", deps=("EXTRACT.*",)))
    d.expand({"EXTRACT": [s.key for s in segments]})
    return d.freeze()


def handlers_for(segments: list[Segment], index: EvidenceIndex,
                 agent: AgentSpec, system: str) -> dict[str, NodeHandler]:
    return {
        "extract": _SegmentRouter(segments, index, agent, system),
        "merge": MergeSegments(index),
    }


class _SegmentRouter(NodeHandler):
    """一个 handler 服务所有 fan-out 实例，按 ``fanout_key`` 分派到对应的段。

    比给每段注册一个 handler 干净：段是数据，不该变成注册表里的条目。
    """

    def __init__(self, segments: list[Segment], index: EvidenceIndex,
                 agent: AgentSpec, system: str) -> None:
        # 形状决定用哪个 agent —— 散文段交给 rule_miner，表格段交给 extractor。
        # 这是"计划冻结"允许的：形状来自列画像，不来自内容语义。
        miner = default_agents().get("rule_miner")
        self._by_key: dict[str, NodeHandler] = {}
        for seg in segments:
            if seg.shape.row_unit == "question":
                self._by_key[seg.key] = HarvestQuestions(seg, index)
            elif seg.shape.row_unit == "rule" and miner is not None:
                self._by_key[seg.key] = MineRules(seg, index, miner,
                                                  miner.render_system())
            else:
                self._by_key[seg.key] = ExtractSegment(seg, index, agent, system)
        self.schema = agent.output_schema
        self.system = system

    def task(self, inputs: dict[str, Any]) -> str:
        return "抽取一段材料"  # 只在没走 for_node 时兜底

    def for_node(self, node_id: str) -> NodeHandler:
        key = node_id.rsplit(".", 1)[-1]
        if key not in self._by_key:
            raise KeyError(f"节点 {node_id} 找不到对应的段（已知 {sorted(self._by_key)}）")
        return self._by_key[key]


# ══════════════════════════════════════════════════════════════════
#  下游（确定性）
# ══════════════════════════════════════════════════════════════════
def finish(oir: OIR, *, endpoints: list[dict] | None = None,
           profiles: dict | None = None, max_questions: int = 3,
           project: str = "") -> dict[str, Any]:
    """对齐 → 冲突 → 自动修 → 澄清排序 → 编译模板。全部确定性。"""
    align, merge_log = align_and_apply(oir)
    conflicts = detect_all(oir, endpoints=endpoints, profiles=profiles)
    repaired = auto_repair(oir, conflicts)
    cs = ClarificationEngine(max_questions=max_questions).rank(conflicts, oir)
    spec = compile_template(oir, conflicts)
    # 建议在冲突之后算 —— 自动修补完的东西不该再拿出来建议一遍。
    return {
        "align": align.summary(), "merged": merge_log,
        "uncertain": [x.to_dict() for x in align.uncertain[:8]],
        "conflicts": conflicts, "auto_repaired": repaired,
        "clarify": cs, "suggestions": suggest(oir), "template_spec": spec,
    }


def _preview_names(items: list[dict[str, Any]], limit: int = 12) -> str:
    """给模型看的已抽对象名预览。只列名字 —— 列全了等于把 168 行又喂了一遍。"""
    names = [str(x.get("api_name", "")) for x in items if isinstance(x, dict)]
    head = "、".join(n for n in names[:limit] if n)
    return head + (f" …（共 {len(names)} 个）" if len(names) > limit else "")
