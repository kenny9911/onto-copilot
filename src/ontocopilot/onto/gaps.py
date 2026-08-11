"""缺口挖掘 —— 把"材料没说清楚的地方"变成能发给业务方的问题。

问题清单以前只有两个来源：客户材料里**碰巧带着**的一张问卷（有就搬、没有就空），
外加流程图上四条模板句。换一份没有问卷的材料，那张「待澄清问题」表就只剩三四行
系统自问自答 —— 而材料里明摆着的空白一条都没被问出来：

    「如提前XX天需要进行预警提醒」          ← 客户自己写的占位符
    「如超出XX金额，则采购包创建失败」        ← 阈值没定
    「实体间关系-待梳理」                    ← 一张标了名字、里面一行都没有的表
    「进度状态标准：未开始、执行中、…」        ← 一份要确认完整性的枚举
    112 个接口挂在 14 个业务对象上，其中 3 个在实体表里查无此名

这些才是 ERP 顾问和业务专家真正能答、也只有他们能答的东西。所以这里换成从
**证据**里挖，四条独立通道：

1. :func:`undetermined_slots` —— 材料自己写下的未定参数（XX / N / 若干 / 待定）；
2. :func:`empty_containers` —— 声明了名字却没有内容的表/章节；
3. :func:`enumerations` —— 成套的取值清单，要确认有没有漏；
4. :func:`structural_gaps` —— OIR 建出来之后才暴露的缺口（挂不上宿主的行动、
   没有口径的对象、基数靠猜的关系、挂不到对象的规则）。

每条问题都带**原文出处**。业务方要能点回去看上下文才答得了 —— 一个没有出处的
问题等于让人凭空想象，那还不如不问。这条判据同时决定了这个模块不做什么：
挖不出出处的猜测一律不产出。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .oir import OIR, OpenQuestion, Provenance, extracted, make_rid

__all__ = ["Gap", "mine_questions", "undetermined_slots", "empty_containers",
           "enumerations", "structural_gaps"]


# ══════════════════════════════════════════════════════════════════
#  通用件
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class Gap:
    """一处缺口。转成 :class:`~.oir.OpenQuestion` 之前的中间形态。"""

    text: str
    group: str
    kind: str
    #: 出处。**尽量带真实 locator** —— 只有真 locator 才能在界面上点回原文高亮，
    #: 把 cite 字符串塞进 raw.ref 只能渲染成一行文字。
    prov: Provenance | None = None
    options: list[str] | None = None
    applies_to: list[str] | None = None
    #: 排序权重。同类里数值大的先问。
    weight: float = 1.0

    def to_question(self) -> OpenQuestion:
        ev = [self.prov] if self.prov else []
        return OpenQuestion(
            rid=make_rid("oq", f"{self.kind}_{self.text[:60]}"),
            text=extracted(self.text, *ev),
            options=list(self.options or ()),
            group=self.group, code="",
            applies_to=list(self.applies_to or ()),
            asked_by="system")


def _prov_of(chunk: Any, snippet: str) -> Provenance:
    """按切片建出处。切片自带 file_id / locator，直接用它们。"""
    return Provenance(
        getattr(chunk, "file_id", "f"), getattr(chunk, "file_name", ""),
        dict(getattr(chunk, "locator", None) or {"kind": "raw"}),
        snippet=snippet[:300], extractor="rule", confidence=1.0)


#: 一句话的边界。切出占位符所在的那一句，而不是把整段 800 字的规则塞进问题里。
_SENTENCE = re.compile(r"[^。；;\n]{4,160}")


def _sentence_around(text: str, at: int) -> str:
    """取 ``at`` 落在的那一句。找不到就退回前后各 40 字。"""
    for m in _SENTENCE.finditer(text):
        if m.start() <= at < m.end():
            return m.group(0).strip(" 　、,，")
    return text[max(0, at - 40):at + 40].strip()


def _container_of(chunk: Any) -> str:
    """切片所在的容器名（sheet / 章节 / 表）。

    问题按它分组 —— **分组来自材料的结构**，不来自我们预设的一张流程节点表。
    换一份材料，分组名跟着换。
    """
    loc = getattr(chunk, "locator", None) or {}
    return str(loc.get("sheet") or loc.get("section")
               or loc.get("object") or loc.get("page") or "")


# ══════════════════════════════════════════════════════════════════
#  1. 材料自己写下的未定参数
# ══════════════════════════════════════════════════════════════════
#: 占位符的写法。**判据是"这里本该有个值、但写的是占位符"**，不是关键词表 ——
#: 所以 `XX天`/`N 天`/`百分之多少`/`若干` 走的是同一条判据的不同写法。
#:
#: 每条都要求占位符**紧挨着量词或单位**（天/金额/次/%/元…），否则"XX 部门"
#: 这种正常缩写也会命中。
_SLOT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"[XxＸ×]{2,}\s*(?:个)?(?:天|日|小时|分钟|周|月|年|次|人|元|万元|金额|比例|%|％)",
     "数值未定"),
    (r"(?<![A-Za-z0-9])[NnＮ]\s*(?:个工作日|天|日|小时|次|人|元|万元)", "数值未定"),
    (r"百分之多少|多少个?(?:天|日|次|元|万元|%|％)", "数值未定"),
    (r"若干|数个|数天|数次", "数值未定"),
    (r"待定|待确认|待补充|待梳理|TBD|tbd|暂无|未定", "内容待定"),
    (r"[（(]\s*[）)]|【\s*】|_{3,}|\?{2,}|？{2,}", "内容留空"),
)
_SLOT_RE = re.compile("|".join(f"(?P<p{i}>{p})" for i, (p, _) in enumerate(_SLOT_PATTERNS)))
_SLOT_KIND = {f"p{i}": k for i, (_, k) in enumerate(_SLOT_PATTERNS)}


def undetermined_slots(chunks: list[Any], *, limit: int = 40) -> list[Gap]:
    """材料里写着占位符的地方。

    这是**客户自己标出来的**待办：他写「提前XX天预警」的时候就知道那个数没定。
    把它原样问回去，比我们凭空造一个问题准得多，也更容易被回答。
    """
    out: list[Gap] = []
    seen: set[str] = set()
    for c in chunks:
        text = str(getattr(c, "render", "") or "")
        if len(text) < 8:
            continue
        for m in _SLOT_RE.finditer(text):
            kind = _SLOT_KIND.get(
                next((g for g in _SLOT_KIND if m.group(g) is not None), ""), "内容待定")
            sent = _sentence_around(text, m.start())
            if len(sent) < 6:
                continue
            key = re.sub(r"\s+", "", sent)[:60]
            if key in seen:
                continue
            seen.add(key)
            out.append(Gap(
                text=f"「{sent}」—— 这里的取值是多少？材料里写的是占位符。",
                group=_container_of(c) or "未定参数", kind=f"slot:{kind}",
                prov=_prov_of(c, sent), weight=3.0))
            if len(out) >= limit:
                return out
    return out


# ══════════════════════════════════════════════════════════════════
#  2. 声明了却空着的容器
# ══════════════════════════════════════════════════════════════════
def empty_containers(docs: list[Any]) -> list[Gap]:
    """有名字、没内容的表或章节。

    「实体间关系-待梳理」这种表名本身就是一句话：客户知道这里要有东西，只是还
    没写。这类缺口在任何材料上都成立 —— 判据是"声明了一个容器却一行都没有"，
    和这一份材料写了什么无关。
    """
    out: list[Gap] = []
    for d in docs:
        rows: dict[str, int] = {}
        for c in getattr(d, "chunks", ()) or ():
            key = str(c.locator.get("sheet") or c.locator.get("section") or "")
            if not key:
                continue
            tags = set(getattr(c, "tags", ()) or ())
            rows[key] = rows.get(key, 0) + (0 if tags & {"schema", "meta"} else 1)
        for name, n in rows.items():
            if n:
                continue
            out.append(Gap(
                text=f"材料里有一张叫「{name}」的表，但里面是空的。"
                     f"这部分内容能补上吗？如果已经在别的文档里，请指出是哪一份。",
                group=name, kind="empty_container",
                cite=f"{d.file_name}!{name}", snippet=f"（{name} 整张表为空）",
                weight=5.0))
    return out


# ══════════════════════════════════════════════════════════════════
#  3. 成套的取值清单
# ══════════════════════════════════════════════════════════════════
#: 「进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消」
#: 冒号前是清单的名字，冒号后是至少三个短取值。三个是下限 —— 两个的多半是
#: 一句被顿号断开的话，不是枚举。
_ENUM_RE = re.compile(
    r"(?P<name>[^\n：:；;。，,]{2,20})\s*[：:]\s*"
    r"(?P<body>[^\n。；;]{2,12}(?:[、，,][^\n。；;]{1,12}){2,})")


def enumerations(chunks: list[Any], *, limit: int = 12) -> list[Gap]:
    """材料里列出来的取值清单，要业务方确认完不完整。

    枚举是下游最贵的东西之一：漏一个状态，整条状态机就少一条边，而这类遗漏在
    做完之后极难发现。列在这里让人一眼扫过去补，成本最低。
    """
    out: list[Gap] = []
    seen: set[str] = set()
    for c in chunks:
        text = str(getattr(c, "render", "") or "")
        cite = c.cite() if hasattr(c, "cite") else ""
        for m in _ENUM_RE.finditer(text):
            name = m.group("name").strip(" 　\n0123456789.、）)")
            items = [x.strip() for x in re.split(r"[、，,]", m.group("body")) if x.strip()]
            if len(name) < 2 or len(items) < 3 or any(len(x) > 12 for x in items):
                continue
            if name in seen:
                continue
            seen.add(name)
            out.append(Gap(
                text=f"「{name}」目前列了 {len(items)} 个取值：{'、'.join(items)}。"
                     f"这份清单完整吗？还有没有别的取值？",
                group=_sheet_of(cite) or "取值清单", kind="enum",
                cite=cite, snippet=m.group(0)[:200],
                options=[*items, "就这些，没有遗漏"], weight=2.5))
            if len(out) >= limit:
                return out
    return out


# ══════════════════════════════════════════════════════════════════
#  4. OIR 建出来之后才暴露的结构缺口
# ══════════════════════════════════════════════════════════════════
#: 每类结构缺口最多问几条。同一类问二十遍，业务方看到第三条就开始跳着填 ——
#: 挑最有代表性的几条，剩下的在模板别的表里逐行确认。
_PER_KIND = 6


def structural_gaps(oir: OIR) -> list[Gap]:
    """从建好的 OIR 上读缺口。

    和前三条通道不同，这里的判据是**结构**不是文本：材料读完了、模型也抽完了，
    剩下这些空位就是这一轮真正没搞清楚的东西。
    """
    out: list[Gap] = []

    # 挂不上宿主的行动 —— 接口在，但不知道它改的是哪个单据
    orphan = [a for a in oir.actions.values() if not a.applies_to]
    for a in orphan[:_PER_KIND]:
        ep = (a.source_endpoint.value or {}) if a.source_endpoint.value else {}
        out.append(Gap(
            text=f"接口「{a.api_name.value}」"
                 + (f"（{ep.get('display')}）" if ep.get("display") else "")
                 + "在材料里找不到它操作的业务对象。它改的是哪张单据？",
            group="接口归属", kind="action_no_host",
            cite=_cite_of(a.api_name), snippet=str(ep.get("path") or ""), weight=4.0))
    if len(orphan) > _PER_KIND:
        out.append(Gap(
            text=f"另有 {len(orphan) - _PER_KIND} 个接口同样挂不上业务对象，"
                 f"完整清单见「动作清单」表。是不是缺一份接口与单据的对照表？",
            group="接口归属", kind="action_no_host_more", weight=3.5))

    # 挂不到对象的业务规则 —— 规则在，但不知道它约束谁
    unbound = [r for r in oir.rules.values() if not r.applies_to]
    for r in unbound[:_PER_KIND]:
        out.append(Gap(
            text=f"这条规则管的是哪个单据？「{r.statement.value[:70]}」",
            group="规则归属", kind="rule_no_host",
            cite=_cite_of(r.statement), snippet=r.statement.value[:200], weight=3.0))

    # 基数靠猜的关系 —— 一对多还是多对多，直接决定下游能不能建对工作流
    guessed = [lt for lt in oir.links.values() if not lt.cardinality.evidence]
    for lt in guessed[:_PER_KIND]:
        src = oir.objects.get(lt.source)
        tgt = oir.objects.get(lt.target)
        if src is None or tgt is None:
            continue
        out.append(Gap(
            text=f"「{src.display_name.value}」和「{tgt.display_name.value}」之间，"
                 f"一条对应几条？材料里没写，系统按常见做法填的是 "
                 f"{lt.cardinality.value}。",
            group="对应关系", kind="link_cardinality",
            cite=_cite_of(lt.api_name), options=["一对一", "一对多", "多对多"],
            applies_to=[lt.source, lt.target], weight=2.0))

    # 有名字没口径的对象 —— 只报总数，不逐个问：逐个问是「对象清单」表的活
    nodesc = [o for o in oir.objects.values() if not o.description.value.strip()]
    if len(nodesc) >= 3:
        out.append(Gap(
            text=f"有 {len(nodesc)} 个业务对象只有名字、没有一句说明"
                 f"（如 {'、'.join(o.display_name.value for o in nodesc[:5])}）。"
                 f"这些是同一套系统里的表吗？其中哪些是业务方真正会打交道的单据？",
            group="对象口径", kind="object_no_description", weight=2.0))
    return out


def _cite_of(assertion: Any) -> str:
    ev = getattr(assertion, "evidence", None) or ()
    return ev[0].cite() if ev else ""


# ══════════════════════════════════════════════════════════════════
#  汇总
# ══════════════════════════════════════════════════════════════════
def mine_questions(oir: OIR, *, docs: list[Any] | None = None,
                   chunks: list[Any] | None = None,
                   extra: list[OpenQuestion] | None = None,
                   limit: int = 60) -> list[OpenQuestion]:
    """四条通道一起挖，去重后按权重排序。

    Args:
        oir: 已经建好的 OIR，结构缺口从它上面读。
        docs: 解析结果，用来发现空容器。
        chunks: 全部证据切片，用来扫占位符和枚举。
        extra: 别处已经生成的问题（如流程图缺口），一起参与去重与排序。
        limit: 最多产出多少条。**不是越多越好** —— 一份 200 行的问题清单
            发出去，回来的就是 200 个空格。

    Returns:
        :class:`~.oir.OpenQuestion` 列表，已按"最该问"排序。
    """
    chunks = list(chunks or ())
    docs = list(docs or ())
    gaps = [*empty_containers(docs), *undetermined_slots(chunks),
            *enumerations(chunks), *structural_gaps(oir)]
    gaps.sort(key=lambda g: -g.weight)

    file_name = getattr(docs[0], "file_name", "") if docs else ""
    out: list[OpenQuestion] = []
    seen: set[str] = {q.rid for q in (extra or ())}
    # 材料里本来就有的问题（客户自己写的问卷）永远排在最前 —— 那是他自己
    # 提的疑问，比我们发现的任何缺口都更该先答。
    out.extend(q for q in (extra or ()))
    for g in gaps:
        q = g.to_question(file_name)
        if q.rid in seen:
            continue
        seen.add(q.rid)
        out.append(q)
        if len(out) >= limit:
            break
    return out
