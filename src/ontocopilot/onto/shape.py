"""段形状推断 —— 在读内容之前先搞清楚"这段材料到底是什么表"。

这一层存在的理由是一次真实失败。一份 326 行的采购材料里有三张 sheet：

    业务对象实体梳理    168 行   一行 = 一个实体（有实体编码列，没有字段列）
    业务对象API梳理-行动 112 行   一行 = 一个行动（多一列 url）
    业务规则             45 行   一行 = 一段散文

流水线当时对三张表用同一句话提要求："每一行字段都要抽成 PropertyType"。于是
critic 判定"抽出 58 个对象却零属性 = 一定漏抽"、节点反复重试、预算烧穿，而真相
是**前两张表里本来就没有属性**。写死"表里必有字段"就是硬编码，换一份材料立刻塌。

所以这里做两件事，全部从**列的取值画像**推断，不认表名、不认关键字表：

1. :func:`classify_columns` —— 每列是标识符 / 名称 / 分组 / 端点 / 数据类型 /
   是否必填 / 散文 / 枚举中的哪一种。
2. :func:`infer_shape` —— 由列角色推出这一段**能产出什么**（对象 / 属性 / 行动 /
   规则），以及**哪些产出是规则就能确定的**。

第 2 点的下游影响是双重的：
  · critic 只对"这段应该有"的东西判缺失，假阳性消失；
  · 规则能确定的行（一行一实体、一行一行动）根本不进模型 —— 既不会丢行，
    也不会为了复述 168 行而烧 Opus 的钱。这就是 ADR-5 的落点。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

__all__ = [
    "ColumnRole",
    "ColumnView",
    "SegmentShape",
    "Yield",
    "classify_columns",
    "detect_questionnaire",
    "infer_shape",
    "looks_like_question",
    "split_options",
    "structural_extract",
]


# ══════════════════════════════════════════════════════════════════
#  列角色
# ══════════════════════════════════════════════════════════════════
class ColumnRole(str, Enum):
    """一列在建模里扮演的角色。"""

    IDENTIFIER = "identifier"   # 机器可读的编码：camelCase / snake_case / 点分
    LABEL = "label"             # 人读的名称，短、几乎不重复
    GROUP = "group"             # 分类/模块：短、重复率高
    ENDPOINT = "endpoint"       # URL 或路径 —— 一行绑定一个行动的信号
    DATATYPE = "datatype"       # 数据类型词表 —— 一行是一个字段的**决定性**信号
    REQUIRED = "required"       # 是否必填之类的布尔列
    PROSE = "prose"             # 长文本：定义、规则、职责
    ENUM = "enum"               # 取值很少的短枚举
    QUESTION = "question"       # 问句列 —— 问卷的主体
    OPTIONS = "options"         # 参考选项列（①②③）
    ANSWER_SLOT = "answer_slot" # 待填答复列：整列空，就是它把这张表标成"待填"
    EMPTY = "empty"             # 整列空
    UNKNOWN = "unknown"


#: 数据类型词表。命中要靠**取值**，不是列名 —— 列名叫"类型"但填的是中文说明的表
#: 到处都是，反过来列名叫 col7 却整列 varchar(32) 的也有。
_TYPE_WORDS = {
    "varchar", "nvarchar", "char", "text", "clob", "blob", "string", "str",
    "int", "integer", "bigint", "smallint", "tinyint", "number", "numeric",
    "decimal", "double", "float", "money", "date", "datetime", "timestamp",
    "time", "bool", "boolean", "bit", "json", "uuid", "long", "short",
    "字符", "字符串", "整数", "整型", "数值", "数字", "日期", "时间", "布尔", "金额",
}
_TYPE_RE = re.compile(r"^\s*([A-Za-z一-鿿]+)\s*(\(\s*\d+(\s*,\s*\d+)?\s*\))?\s*$")

#: 布尔取值。同样只看取值。
_BOOL_WORDS = {"是", "否", "y", "n", "yes", "no", "true", "false", "1", "0",
               "必填", "非必填", "可空", "不可空", "√", "×"}

_IDENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)*$")
_URLISH_RE = re.compile(r"^(https?://|/)[\w\-./{}:%]*$|^[\w\-]+(/[\w\-{}]+){2,}$")

#: 一列平均长度超过这个值就当散文。低于它的长中文串仍可能是名称。
_PROSE_LEN = 30


@dataclass(slots=True)
class ColumnView:
    """一列的角色判定结果。"""

    name: str
    role: ColumnRole
    fill: float          # 非空率
    distinct_ratio: float
    mean_len: float
    samples: list[str] = field(default_factory=list)
    #: 第一行填没填。合并单元格的分组列**一定**是从第一行开始的（第一组的组名
    #: 写在表首），而一列漏填几格的普通列不会正好只有第一行有值。
    first_filled: bool = False
    #: 非空取值的去重个数。分组列有几层嵌套时，靠它分辨粗细 ——
    #: 「应用模块」4 个值、「业务对象」14 个值，后者才是宿主那一层。
    distinct: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "role": self.role.value, "fill": round(self.fill, 3),
                "distinct_ratio": round(self.distinct_ratio, 3),
                "mean_len": round(self.mean_len, 1), "samples": self.samples[:3]}


def _role_of(name: str, values: list[str]) -> tuple[ColumnRole, float, float, float]:
    vals = [str(v).strip() for v in values]
    nonempty = [v for v in vals if v]
    fill = len(nonempty) / len(vals) if vals else 0.0
    if not nonempty:
        return ColumnRole.EMPTY, fill, 0.0, 0.0
    distinct = len(set(nonempty))
    dratio = distinct / len(nonempty)
    mean_len = sum(len(v) for v in nonempty) / len(nonempty)
    lower = [v.lower() for v in nonempty]

    def frac(pred: Any) -> float:
        return sum(1 for v in lower if pred(v)) / len(lower)

    # 端点：取值像 URL / 多级路径
    if frac(lambda v: bool(_URLISH_RE.match(v))) >= 0.6:
        return ColumnRole.ENDPOINT, fill, dratio, mean_len

    # 数据类型：取值落在类型词表里（允许 varchar(32) 这种带长度的写法）
    def _is_type(v: str) -> bool:
        m = _TYPE_RE.match(v)
        return bool(m) and m.group(1) in _TYPE_WORDS
    if frac(_is_type) >= 0.6:
        return ColumnRole.DATATYPE, fill, dratio, mean_len

    # 布尔
    if frac(lambda v: v in _BOOL_WORDS) >= 0.8 and distinct <= 4:
        return ColumnRole.REQUIRED, fill, dratio, mean_len

    # 散文
    if mean_len > _PROSE_LEN:
        return ColumnRole.PROSE, fill, dratio, mean_len

    # 标识符：ASCII 代码风格且几乎不重复
    if frac(lambda v: bool(_IDENT_RE.match(v))) >= 0.8:
        return (ColumnRole.IDENTIFIER if dratio >= 0.7 else ColumnRole.ENUM,
                fill, dratio, mean_len)

    # 短枚举 / 分组 / 名称，靠重复率区分
    if dratio <= 0.15 and mean_len <= 12:
        return ColumnRole.ENUM, fill, dratio, mean_len
    if dratio <= 0.5:
        return ColumnRole.GROUP, fill, dratio, mean_len
    if dratio >= 0.7 and mean_len <= _PROSE_LEN:
        return ColumnRole.LABEL, fill, dratio, mean_len
    return ColumnRole.UNKNOWN, fill, dratio, mean_len


def classify_columns(rows: list[dict[str, Any]]) -> list[ColumnView]:
    """按列取值判定角色。输入是若干行的 ``raw`` 字典。"""
    cols: dict[str, list[str]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        for k, v in r.items():
            cols.setdefault(str(k), []).append("" if v is None else str(v))
    # 补齐长度，否则整列缺失的行会让 fill 虚高
    n = len(rows)
    out = []
    for name, vals in cols.items():
        vals = vals + [""] * (n - len(vals))
        role, fill, dratio, mlen = _role_of(name, vals)
        samples = list(dict.fromkeys(v for v in vals if v.strip()))[:5]
        out.append(ColumnView(name=name, role=role, fill=fill,
                              distinct_ratio=dratio, mean_len=mlen, samples=samples,
                              first_filled=bool(vals and vals[0].strip()),
                              distinct=len({v for v in vals if v.strip()})))

    # 稀疏分组列：整表别的列都填满，唯独这一列只在每组第一行写一次、下面留空
    # 继承。Excel 里最常见的写法。单看一列判不出来 —— 它的取值互不重复，看着
    # 就是个普通名称列；只有和"别的列是满的"放在一起才知道那些空是继承不是缺失。
    #
    # 判据是**第一行有值**，不是"填充率高于某个数"。填充率下界曾经写死 0.02，
    # 意思是"500 行里少于 10 个组就不算分组列" —— 这个数没有任何依据，而且
    # 表越长越容易把真的分组列判丢。合并单元格的结构特征是：第一组的组名写在
    # 表首，后面每组换一次。第一行空着的稀疏列则多半是真的漏填。
    dense = any(c.fill >= 0.9 for c in out)
    if dense:
        for c in out:
            if (c.role in (ColumnRole.LABEL, ColumnRole.UNKNOWN)
                    and c.first_filled and 0 < c.fill <= 0.6
                    and c.mean_len <= _PROSE_LEN):
                c.role = ColumnRole.GROUP
    return out



# ── 问卷信号 ────────────────────────────────────────────────────
#: 疑问句判据。同样只看取值：列名可能叫「澄清问题」，也可能叫 col3 或
#: 「需求确认事项」，认列名换一份材料立刻塌。
_QMARK = re.compile(r"[?？]\s*$")
_INTERROGATIVE = ("是否", "哪些", "哪个", "什么", "如何", "怎么", "怎样", "多少",
                  "为什么", "是不是", "有没有", "要不要", "能不能", "能否", "可否",
                  "请说明", "请确认", "请补充", "吗")

#: 选项标记：①②③ / (1) / 1. / A) 都算
_OPTION_MARK = re.compile(r"[①-⑳❶-❿]|[(（]\s*\d+\s*[)）]|(?:^|[\s；;、])\d+\s*[.、)]|"
                          r"(?:^|[\s；;、])[A-Za-z]\s*[.、)]")

#: 问卷里夹着的分组标题行、小计行会被误当成问题。低于这个长度一律不算。
_MIN_QUESTION_LEN = 6


def looks_like_question(v: str) -> bool:
    t = str(v).strip()
    return bool(_QMARK.search(t)) or any(w in t for w in _INTERROGATIVE)


def split_options(text: str) -> list[str]:
    """把「① 全线下 ② 系统里编 ③ 线下编、系统里审」拆成三段。

    拆分放在这里而不是模板侧 —— 拆出来的选项要进 OIR，模板只是消费方。
    拆不出两段以上就返回空：**宁可不拆，也不要把一句完整的话切碎**，
    切碎的选项发到业务人员手里比不给选项更糟。
    """
    t = str(text or "").strip()
    if not t:
        return []
    marks = list(_OPTION_MARK.finditer(t))
    if len(marks) >= 2:
        cuts = [m.start() for m in marks] + [len(t)]
        parts = [t[cuts[i]:cuts[i + 1]] for i in range(len(cuts) - 1)]
        parts = [_OPTION_MARK.sub("", x, count=1).strip(" 　;；、.") for x in parts]
    else:
        parts = [x.strip() for x in re.split(r"[；;\n]", t)]
    parts = [x for x in parts if x]
    return parts if len(parts) >= 2 else []


def _question_frac(values: list[str]) -> float:
    vals = [v for v in (str(x).strip() for x in values) if v]
    if not vals:
        return 0.0
    return sum(1 for v in vals if looks_like_question(v)) / len(vals)


def detect_questionnaire(shape: SegmentShape, rows: list[dict[str, Any]]) -> bool:
    """认出「待填问卷」，命中时就地改写列角色。

    四个信号必须**同时**成立。单独任何一个都会误伤：

    1. 有一列几乎整列空（``fill <= 0.05``）—— 待填的答复槽；
    2. 除它之外**至少两列填满**（``fill >= 0.9``）—— 这一条把"待填表单"和
       "某列碰巧没填"分开，单看一列判不出来；
    3. 有一列过半是问句，且不是一两个字的短词；
    4. 行数够（``infer_shape`` 已保证 >= 3）。

    第 1 条必须读 ``ColumnView.fill`` 的**原始数值**而不是 role ——
    :func:`classify_columns` 末尾的稀疏分组列后处理会把"部分填了答复"的列
    改判成 GROUP，那时候 role 已经不是 EMPTY 了。
    """
    if len(rows) < 3:
        return False
    cols = [c for c in shape.columns if c.name]
    if len(cols) < 3:
        return False

    # 答复槽取**最右边**那一列 —— Excel 问卷的答复列总在最后
    blanks = [c for c in cols if c.fill <= 0.05]
    if not blanks:
        return False
    answer = blanks[-1]

    dense = [c for c in cols if c is not answer and c.fill >= 0.9]
    if len(dense) < 2:
        return False

    by_name = {c.name: c for c in cols}
    q_col = None
    for c in dense:
        if c.mean_len < 8:
            continue  # 一个字的"是否"不算问题
        vals = [str(r.get(c.name, "")) for r in rows if isinstance(r, dict)]
        if _question_frac(vals) >= 0.5:
            q_col = c
            break
    if q_col is None:
        return False

    # 参考选项列：拆得出两段以上就算。问卷不一定有这一列，找不到也不影响判定。
    o_col = None
    for c in cols:
        if c is answer or c is q_col:
            continue
        vals = [str(r.get(c.name, "")) for r in rows if isinstance(r, dict)]
        hit = sum(1 for v in vals if len(split_options(v)) >= 2)
        if vals and hit / len(vals) >= 0.4:
            o_col = c
            break

    q_col.role = ColumnRole.QUESTION
    answer.role = ColumnRole.ANSWER_SLOT
    if o_col is not None:
        o_col.role = ColumnRole.OPTIONS
    del by_name
    return True


# ══════════════════════════════════════════════════════════════════
#  段形状
# ══════════════════════════════════════════════════════════════════
class Yield(str, Enum):
    """一段材料能产出的东西。"""

    OBJECTS = "objects"
    PROPERTIES = "properties"
    ACTIONS = "actions"
    LINKS = "links"
    RULES = "rules"
    QUESTIONS = "questions"


@dataclass(slots=True)
class SegmentShape:
    """这一段是什么表、能出什么、其中哪些规则就能定。"""

    columns: list[ColumnView] = field(default_factory=list)
    yields: set[Yield] = field(default_factory=set)
    #: yields 的子集：规则可以直接算出来，不需要模型
    rule_decidable: set[Yield] = field(default_factory=set)
    row_count: int = 0
    #: 一行对应一个什么（object / property / action / rule / None=说不准）
    row_unit: str | None = None
    note: str = ""

    def col(self, role: ColumnRole) -> ColumnView | None:
        return next((c for c in self.columns if c.role is role), None)

    def cols(self, role: ColumnRole) -> list[ColumnView]:
        return [c for c in self.columns if c.role is role]

    def expects(self, y: Yield) -> bool:
        return y in self.yields

    def describe(self) -> str:
        """给模型看的一句话形状说明。"""
        roles = "、".join(f"{c.name}〔{c.role.value}〕" for c in self.columns
                          if c.role is not ColumnRole.EMPTY)
        unit = {"object": "一个业务对象", "property": "一个字段/属性",
                "action": "一个行动（有接口）", "rule": "一段业务规则",
                "question": "一个待澄清的问题（不是实体）"}.get(
                    self.row_unit or "", "不确定的单元")
        return (f"这一段有 {self.row_count} 行，**一行 = {unit}**。\n"
                f"列角色：{roles}\n"
                f"可产出：{'、'.join(sorted(y.value for y in self.yields)) or '（不确定）'}"
                + (f"\n{self.note}" if self.note else ""))

    def to_dict(self) -> dict[str, Any]:
        return {"row_count": self.row_count, "row_unit": self.row_unit,
                "yields": sorted(y.value for y in self.yields),
                "rule_decidable": sorted(y.value for y in self.rule_decidable),
                "columns": [c.to_dict() for c in self.columns], "note": self.note}


def infer_shape(rows: list[dict[str, Any]]) -> SegmentShape:
    """由列角色推出段形状。

    判定顺序刻意如此：**数据类型列的存在压过一切**。一张表只要有一列在填
    varchar/int/日期，它就是字段表，一行是一个属性；没有类型列却有唯一标识符
    列，那就是登记表，一行是一个实体 —— 这时"零属性"是正确答案，不是漏抽。
    """
    shape = SegmentShape(columns=classify_columns(rows), row_count=len(rows))
    # 一两行立不起一个形状。列画像靠的是取值分布，样本太少时"唯一"和"重复"没有
    # 区别 —— 文档元数据那一行（作者/路径/修改时间）就会被判成一张实体登记表，
    # 然后 critic 追着它要对象，节点白白重试两轮。
    if len(rows) < 3:
        shape.note = "样本太少（不足 3 行），不下形状判断。"
        return shape

    has_type = bool(shape.cols(ColumnRole.DATATYPE))

    # 问卷判在数据类型列**之后** —— 本模块开篇立的规矩是"数据类型列的存在压过
    # 一切"，这里不能破例。一张字段表完全可能有一列空着的「备注」，加上一列写成
    # 问句式的「口径」说明（"是否必填？…"），四个信号全中；抢在类型列前面判，
    # 整张字段表的属性会一个不剩地丢掉 —— 比它要修的那个 bug 更糟。
    if not has_type and detect_questionnaire(shape, rows):
        shape.row_unit = "question"
        shape.yields |= {Yield.QUESTIONS}
        shape.rule_decidable |= {Yield.QUESTIONS}
        shape.note = ("这是一份**待填问卷**：一列整列空着等人填，其余列都是满的，"
                      "还有一列是问句。每一行是**一个待澄清的问题，不是业务实体**。"
                      "已填答复的行是事实。**这一段没有对象、没有字段可抽。**")
        # 直接返回 —— 不走后面"散文兜底出 RULES"和"多标识符列出 LINKS"两条，
        # 问卷段不该顺带产出规则或关系。yields 里只有 QUESTIONS，下游 critic
        # 才不会追着它要对象。
        return shape

    has_endpoint = bool(shape.cols(ColumnRole.ENDPOINT))
    ident = shape.col(ColumnRole.IDENTIFIER)
    label = shape.col(ColumnRole.LABEL)
    prose = shape.cols(ColumnRole.PROSE)
    structural = [c for c in shape.columns
                  if c.role not in (ColumnRole.PROSE, ColumnRole.EMPTY)]

    if has_type:
        shape.row_unit = "property"
        shape.yields |= {Yield.PROPERTIES, Yield.OBJECTS}
        shape.note = "有数据类型列 —— 每一行都是一个字段，必须抽成 PropertyType。"
    elif has_endpoint and (ident or label):
        shape.row_unit = "action"
        shape.yields |= {Yield.ACTIONS, Yield.OBJECTS}
        # 行动**能**由规则定，对象**不能**：行动表里那列编码是行动码
        # （createPbp / queryOpenPbpLine），不是实体码。真正的宿主对象写在一列
        # 重复出现的中文名里，得靠命名归一才能给出 apiName —— 那是模型的活。
        shape.rule_decidable |= {Yield.ACTIONS}
        shape.note = ("有接口列 —— 每一行是一个行动，编码列装的是**行动码**不是实体码；"
                      "宿主对象在重复出现的名称列里，需要按命名规范起 apiName。"
                      "这段没有字段可抽。")
    elif ident and ident.fill >= 0.6:
        shape.row_unit = "object"
        shape.yields |= {Yield.OBJECTS}
        shape.rule_decidable |= {Yield.OBJECTS}
        shape.note = ("有唯一标识符列但没有数据类型列 —— 这是**实体登记表**，"
                      "一行一个对象。**这段没有属性可抽，零属性是正确结果。**")
    elif prose and len(prose) >= max(1, len(structural)):
        shape.row_unit = "rule"
        shape.yields |= {Yield.RULES}
        shape.note = "整段以长文本为主 —— 这里出的是业务规则/约束，不是实体清单。"
    elif label:
        shape.row_unit = "object"
        shape.yields |= {Yield.OBJECTS}
        shape.note = "只有名称列，没有编码也没有类型 —— 对象名要靠命名规范生成。"

    # 散文列在任何形状下都可能藏规则
    if prose and Yield.RULES not in shape.yields:
        shape.yields.add(Yield.RULES)
    # 有多个标识符列，行间往往有引用关系
    if len(shape.cols(ColumnRole.IDENTIFIER)) >= 2:
        shape.yields.add(Yield.LINKS)
    return shape


# ══════════════════════════════════════════════════════════════════
#  规则抽取
# ══════════════════════════════════════════════════════════════════
def structural_extract(rows: list[dict[str, Any]], cites: list[str],
                       shape: SegmentShape,
                       carry_in: dict[str, str] | None = None,
                       ) -> dict[str, list[dict[str, Any]]]:
    """把规则能确定的行直接抽出来，一行都不丢。

    只处理 ``shape.rule_decidable`` 认可的形状 —— 也就是"一行一实体"和
    "一行一行动"这两种映射完全确定的表。其余留给模型。

    Args:
        rows: 每行的 ``raw`` 字典，与 ``cites`` 一一对应。
        cites: 每行的出处串，直接进 provenance。
        carry_in: 本段第一行之前各列最后一个非空取值。一张表被切成多段时，
            后面几段的组首在上一段里 —— 没有它，那些行的分组列全是空的。
    """
    out: dict[str, list[dict[str, Any]]] = {"objects": [], "properties": [],
                                            "links": [], "actions": [], "questions": []}
    carry_in = carry_in or {}

    if Yield.QUESTIONS in shape.rule_decidable:
        _extract_questions(rows, cites, shape, out, carry_in)
        return out

    if not (shape.rule_decidable & {Yield.OBJECTS, Yield.ACTIONS}):
        return out

    ident = shape.col(ColumnRole.IDENTIFIER)
    endpoint = shape.col(ColumnRole.ENDPOINT)
    # 模块用满填充的枚举列；宿主对象用稀疏分组列（要向下继承）
    module = next((c for c in shape.cols(ColumnRole.ENUM) if c.fill >= 0.9), None)
    host = _host_column(shape)
    if module is None and host is not None:
        # 分组常有两层（应用模块 > 业务对象）。细的那层是宿主，粗的那层是模块 ——
        # 以前粗的那层直接被丢掉，材料里明明写着的归属信息就此消失。
        module = next((c for c in shape.cols(ColumnRole.GROUP)
                       if c is not host and c.fill < 0.9), None)
    labels = [c for c in shape.cols(ColumnRole.LABEL) if c.fill >= 0.5]
    label = max(labels, key=lambda c: c.fill) if labels else None
    if ident is None and label is None:
        return out

    # 分组列的继承值。**从上一段接过来** —— 组首可能落在别的段里。
    carry = carry_in.get(host.name, "") if host else ""
    mod_carry = carry_in.get(module.name, "") if module else ""

    seen: set[str] = set()
    for row, cite in zip(rows, cites, strict=False):
        if not isinstance(row, dict):
            continue
        api = str(row.get(ident.name, "")).strip() if ident else ""
        disp = str(row.get(label.name, "")).strip() if label else ""
        if host:  # 空 = 继承上一组，不是缺失
            carry = str(row.get(host.name, "")).strip() or carry
        if module:
            mod_carry = str(row.get(module.name, "")).strip() or mod_carry
        if not api and not disp:
            continue
        key = api or disp
        if Yield.OBJECTS in shape.rule_decidable and key not in seen:
            seen.add(key)
            obj: dict[str, Any] = {"api_name": api or disp, "display_name": disp or api,
                                   "source_locator": cite, "_origin": "rule"}
            if mod_carry:
                obj["module"] = mod_carry
            if carry:
                obj["group"] = carry
            out["objects"].append(obj)
        if endpoint and Yield.ACTIONS in shape.rule_decidable:
            url = str(row.get(endpoint.name, "")).strip()
            if not url:
                continue
            owner = carry
            out["actions"].append({
                # 编码列已经是行动码就直接用；只有没有编码列时才从路径反推
                "api_name": api or _action_name(url, owner or disp),
                "display_name": disp or api,
                # 宿主写中文名，apiName 由下游命名归一/实体对齐解析
                "object_display": owner, "module": mod_carry, "endpoint": url,
                "source_locator": cite, "_origin": "rule"})
    return out


def _host_column(shape: SegmentShape) -> ColumnView | None:
    """哪一列写的是宿主业务对象。

    分组常有两层：「应用模块」（4 个取值）套着「业务对象」（14 个取值）。
    宿主是**细的那一层** —— 取值越多，分得越细。取值一样多时取靠右的那列，
    因为表格是从粗到细往右排的。
    """
    groups = [c for c in shape.cols(ColumnRole.GROUP) if c.fill < 0.9]
    if not groups:
        return None
    order = {id(c): i for i, c in enumerate(shape.columns)}
    return max(groups, key=lambda c: (c.distinct, order[id(c)]))


_VERB_HINTS = {
    "create": "create", "add": "create", "save": "create", "insert": "create",
    "new": "create", "submit": "submit", "update": "update", "edit": "update",
    "modify": "update", "delete": "delete", "remove": "delete",
    "approve": "approve", "audit": "approve", "confirm": "approve",
    "cancel": "cancel", "close": "close", "import": "import", "export": "export",
    "sync": "sync", "push": "sync",
}


def _action_name(url: str, obj_key: str) -> str:
    """从接口路径反推行动名。取路径里最靠后的动词段，取不到就用 manage。"""
    parts = [p for p in re.split(r"[/?#]", url) if p and not p.startswith("{")]
    verb = ""
    for p in reversed(parts):
        low = re.sub(r"[^a-z]", "", p.lower())
        for hint, canon in _VERB_HINTS.items():
            if low.startswith(hint) or low.endswith(hint):
                verb = canon
                break
        if verb:
            break
    head = (obj_key[:1].upper() + obj_key[1:]) if obj_key else "Object"
    return f"{verb or 'manage'}{head}"


def _extract_questions(rows: list[dict[str, Any]], cites: list[str],
                       shape: SegmentShape,
                       out: dict[str, list[dict[str, Any]]],
                       carry_in: dict[str, str] | None = None) -> None:
    """问卷 → 待澄清问题。一行一问，映射完全确定，不进模型。

    让模型复述 150 行问题既会截断丢行，又要为零信息量的复制付 Opus 的钱 ——
    和实体登记表上的结论一模一样。
    """
    q_col = shape.col(ColumnRole.QUESTION)
    a_col = shape.col(ColumnRole.ANSWER_SLOT)
    o_col = shape.col(ColumnRole.OPTIONS)
    grp = next((c for c in shape.cols(ColumnRole.GROUP) + shape.cols(ColumnRole.ENUM)),
               None)
    code = next((c for c in shape.cols(ColumnRole.LABEL) if c.mean_len <= 8), None)
    if q_col is None:
        return

    carry = (carry_in or {}).get(grp.name, "") if grp else ""
    for row, cite in zip(rows, cites, strict=False):
        if not isinstance(row, dict):
            continue
        text = str(row.get(q_col.name, "")).strip()
        if grp:  # 「节点」列同样是每组只写一次
            carry = str(row.get(grp.name, "")).strip() or carry
        if len(text) < _MIN_QUESTION_LEN:
            continue  # 分组标题行、小计行
        raw_opts = str(row.get(o_col.name, "")).strip() if o_col else ""
        out["questions"].append({
            "text": text,
            "options": split_options(raw_opts),
            "options_raw": raw_opts,
            "answer": str(row.get(a_col.name, "")).strip() if a_col else "",
            "group": carry,
            "code": str(row.get(code.name, "")).strip() if code else "",
            "source_locator": cite, "_origin": "rule"})
