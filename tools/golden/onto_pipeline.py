"""onto/pipeline.py 的 golden 导出 —— 给 ts/src/onto/pipeline.ts 当安全网。

`golden/pipeline.{segments,oir,template,stats}.json` 已经把**端到端**那条路钉住了
（真材料 `golden/材料.xlsx` 跑出来的）。这份补的是端到端跑不到的分支，以及那些
"产物是给模型看的中文长句"的地方 —— 手写期望值等于把 f-string 在脑子里重跑一遍，
错了还看不出来（一句话读着通顺就以为对了）。

导什么、为什么导它：

* ``_looks_like_prose`` —— `_CODE_NAME` 那条正则是主 agent 为真实事故加的：
  `bdPurchaseDocSubtypeMapping` 27 个字符，长度判据把一批合法 apiName 报成了
  "说明文字"。正则里的 ``$`` 在 Python 也匹配串尾换行之前、JS 不带 ``m`` 时不匹配
  —— 从 xlsx 抽出来的名字末尾带 ``\\n`` 非常常见，所以 ``poHeader\\n`` 也导一条：
  它由前面的 ``.strip()`` 兜住，两侧同为 False，**这条向量就是那个"兜住了"的证据**。
  长度阈值（64 / 24）按**码点**，所以 emoji 名也导一条。
* ``outstanding`` —— 任务描述与 critic **共用**的判据；属性那条例外
  （"行搬到了不等于口径读到了"）只有向量说得清。
* ``ExtractSegment.task()`` —— 整段正文逐字导出。里面拼了计数、对象名预览、
  宿主名列表、省略号，还有 ``if blank else ""`` 这种条件拼接。
* ``CoverageCritic`` —— 每条 finding 的 code / claim / proposed_fix 逐字导出。
  **含一条会抛 KeyError 的**：``CHECKED_YIELDS`` 里有 LINKS，而 ``_check`` 里那张
  中文名表 ``cn`` 没有 LINKS。两列标识符的表走到这里就炸。这是 Python 侧的缺陷，
  照实导出、照实迁，不在迁移里"顺手修好"。
* ``_prov`` —— 命中索引与没命中索引两条路的置信度（1.0 / 0.85 / 0.6），以及
  ``snippet[:200]``、``f_{fname[:6]}`` 的**码点**切片。
* ``build_oir`` —— 每条分支各一例，**连同丢弃统计**：属性挂不上父对象、关系
  两端对不上名字时只能丢，但丢多少必须可观测。
* ``finish`` —— 九个键一次导全，外加**执行后的 OIR**（它会就地改写）。

跑法::

    .venv/bin/python tools/golden/onto_pipeline.py

输出 ``golden/onto.pipeline.json``（新文件，我独占）。输入全是字面量，
重跑两次 shasum 一致。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.kernel.critic import CriticContext  # noqa: E402
from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex  # noqa: E402
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    BusinessRule,
    ObjectType,
    OpenQuestion,
    PropertyType,
    extracted,
    inferred,
)
from ontocopilot.onto.pipeline import (  # noqa: E402
    _ASK,
    CHECKED_YIELDS,
    MIN_SEGMENT,
    SEGMENT_CHUNKS,
    CoverageCritic,
    ExtractSegment,
    HarvestQuestions,
    MergeSegments,
    MineRules,
    Segment,
    _host_names,
    _is_data_row,
    _looks_like_prose,
    _preview_names,
    _prov,
    _resolve_host,
    _window_shape,
    build_dag,
    build_oir,
    finish,
    outstanding,
    provenance_critic,
    segment_corpus,
)
from ontocopilot.onto.shape import Yield, infer_shape, structural_extract  # noqa: E402

OUT = ROOT / "golden" / "onto.pipeline.json"


def _w(obj: object) -> None:
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {OUT.name:36} {OUT.stat().st_size:>8} B")


# ══════════════════════════════════════════════════════════════════
#  三种真实形状的原型（与 tests/test_shape_suggest.py 同源）
# ══════════════════════════════════════════════════════════════════
REGISTRY = [
    {"应用模块": "采购计划管理", "业务对象": "采购需求计划",
     "实体编码": "pbpHeader", "实体名称": "采购业务计划头"},
    {"应用模块": "采购计划管理", "业务对象": "", "实体编码": "pbpLine",
     "实体名称": "采购业务计划行"},
    {"应用模块": "供应商关系管理", "业务对象": "", "实体编码": "clmContract",
     "实体名称": "采购合同"},
] + [{"应用模块": "供应商关系管理", "业务对象": "", "实体编码": f"clmDoc{i}",
      "实体名称": f"合同附件{i}"} for i in range(12)]

ACTIONS = [
    {"应用模块": "采购计划管理", "业务对象": "采购需求计划",
     "实体编码": "createPbp", "实体名称": "创建PBP",
     "url": "/msourcing/openapi/v1/createPbp"},
] + [{"应用模块": "采购计划管理", "业务对象": "", "实体编码": f"queryPbp{i}",
      "实体名称": f"查询PBP{i}", "url": f"/msourcing/openapi/v1/queryPbp{i}"}
     for i in range(11)]

_TYPES = ["varchar(64)", "decimal(18,2)", "date", "int", "varchar(32)", "timestamp"]
FIELDS = [{"所属对象": "pbpHeader", "字段名": f"field{i}", "类型": _TYPES[i % 6],
           "口径": f"第 {i} 个字段的口径说明", "必填": "是" if i % 2 else "否"}
          for i in range(12)]

SURVEY = [{"节点": "（1）编制集采计划" if i == 0 else "",
           "编号": str(i + 1),
           "澄清问题": [
               "什么情况下使用集采，什么情况下使用普通采购？",
               "集采计划具体包括哪些内容？列出全部字段",
               "集采计划到底是在系统里编的，还是线下用 Excel 编好只把结果录进来？",
               "这项工作什么时候启动？固定周期做，还是看到框架快到期了才做？",
               "编制时主要依据什么具体数据？从哪里获取？",
               "收集是指各单位先上报、再由集采部门汇总吗？",
               "审批需要几级？分别是谁？",
               "驳回之后走什么流程？",
           ][i % 8],
           "参考选项": ["① 全线下，系统只存结果 ② 系统里编 ③ 线下编、系统里审",
                    "① 固定周期 ② 框架到期前 ③ 人工发起", ""][i % 3],
           "答复": ""} for i in range(16)]

PROSE = [{"col1": f"采购计划员职责第 {i} 条：负责依据采购需求计划编制采购执行计划，"
                  f"并负责集采计划收集及复核编制、采购包创建分配及调整"}
         for i in range(8)]

#: 两列标识符 + 一列类型 —— `yields` 会带上 LINKS，正是 CoverageCritic 炸的形状。
TWO_IDENT = [{"主键": f"codeA{i}", "外键": f"codeB{i}", "类型": _TYPES[i % 6]}
             for i in range(10)]


def _cites(rows: list[dict]) -> list[str]:
    return [f"x.xlsx!Sheet1!R{i + 2}-{i + 2}" for i in range(len(rows))]


def _renders(rows: list[dict]) -> list[str]:
    """切片的 render。`str(dict)` 是 Python 的写法，JS 没有对等物 —— 所以
    渲染串必须由 golden 给出，TS 侧的假索引直接读它。"""
    return [str(r) for r in rows]


class _Idx:
    """够 Segment / ExtractSegment 用的最小索引替身。"""

    def __init__(self, rows: list[dict], cites: list[str], renders: list[str]) -> None:
        self._rows, self._cites, self._renders = rows, cites, renders

    def get(self, cid: str) -> Any:
        if not cid.startswith("c") or not cid[1:].isdigit():
            return None
        i = int(cid[1:])
        if i >= len(self._rows):
            return None
        raw, cite, render = self._rows[i], self._cites[i], self._renders[i]

        class _C:
            tags = ["row"]

            def cite(self_inner) -> str:  # noqa: N805
                return cite

        c = _C()
        c.raw = raw
        c.render = render
        return c


def _seg(rows: list[dict], key: str = "s0", label: str = "测试段") -> Segment:
    return Segment(key=key, label=label, file_name="x.xlsx",
                   chunk_ids=[f"c{i}" for i in range(len(rows))],
                   shape=infer_shape(rows))


def _handler(rows: list[dict], label: str) -> tuple[ExtractSegment, _Idx]:
    idx = _Idx(rows, _cites(rows), _renders(rows))

    class _Agent:
        output_schema = None

    return ExtractSegment(_seg(rows, "s0", label), idx, _Agent(), ""), idx


# ══════════════════════════════════════════════════════════════════
#  1. 常量与纯函数
# ══════════════════════════════════════════════════════════════════
def _consts() -> dict[str, Any]:
    return {
        "SEGMENT_CHUNKS": SEGMENT_CHUNKS,
        "MIN_SEGMENT": MIN_SEGMENT,
        "CHECKED_YIELDS": [y.value for y in CHECKED_YIELDS],
        "ASK": {y.value: t for y, t in _ASK.items()},
    }


def _prose_cases() -> list[dict[str, Any]]:
    names = [
        "", "   ", "pbpHeader", "bdPurchaseDocSubtypeMapping",
        "poChangeApplicationHeader", "a" * 64, "a" * 65,
        "snake_case_name", "dotted.name.parts", "kebab-case-name",
        "9startsWithDigit", "_startsWithUnderscore", "has space",
        "与采购需求计划一致", "见附件", "同上", "略", "无", "详见附件说明",
        "这一列的取值和上面那张表里写的口径保持一致即可",
        "采购需求计划", "采购订单头",
        "一二三四五六七八九十一二三四五六七八九十一二三四五",  # 25 个字，>24
        "一二三四五六七八九十一二三四五六七八九十一二三四",      # 24 个字，不超
        # `$` 在 Python 也匹配串尾换行之前 —— xlsx 里回车没清干净的名字
        "poHeader\n",
        "🐍🐍🐍",
    ]
    return [{"in": n, "out": _looks_like_prose(n)} for n in names]


def _is_data_row_cases() -> list[dict[str, Any]]:
    tagsets = [[], ["row"], ["schema"], ["meta"], ["toc"], ["row", "schema"],
               ["profile"], ["ROW"]]
    return [{"tags": t, "out": _is_data_row(type("C", (), {"tags": t})())}
            for t in tagsets]


def _preview_cases() -> list[dict[str, Any]]:
    twelve = [{"api_name": f"obj{i}"} for i in range(12)]
    thirteen = [{"api_name": f"obj{i}"} for i in range(13)]
    return [
        {"items": [], "limit": 12, "out": _preview_names([], 12)},
        {"items": [{"api_name": "pbpHeader"}], "limit": 12,
         "out": _preview_names([{"api_name": "pbpHeader"}], 12)},
        {"items": twelve, "limit": 12, "out": _preview_names(twelve, 12)},
        {"items": thirteen, "limit": 12, "out": _preview_names(thirteen, 12)},
        {"items": thirteen, "limit": 3, "out": _preview_names(thirteen, 3)},
        # 空名字被过滤掉，但**仍然计入总数** —— 这个不对称是有意的
        {"items": [{"api_name": ""}, {"api_name": "a"}], "limit": 12,
         "out": _preview_names([{"api_name": ""}, {"api_name": "a"}], 12)},
        {"items": [{"no_api": 1}, {"api_name": "b"}], "limit": 12,
         "out": _preview_names([{"no_api": 1}, {"api_name": "b"}], 12)},
    ]


def _host_cases() -> list[dict[str, Any]]:
    cases = [
        {},
        {"actions": [{"object_display": "采购需求计划"},
                     {"object_display": "采购需求计划"},
                     {"object_display": " 采购订单 "},
                     {"object_display": ""}],
         "objects": [{"group": "采购合同"}, {"group": "采购需求计划"}, {}]},
        {"objects": [{"group": "采购合同"}], "actions": []},
        {"actions": [{"object_display": None}], "objects": [{"group": None}]},
    ]
    return [{"pre": c, "out": _host_names(c)} for c in cases]


def _resolve_cases() -> list[dict[str, Any]]:
    by_api = {"pbpheader": "ot_pbpheader", "poheader": "ot_poheader"}
    by_display = {"采购业务计划头": "ot_pbpheader", "采购需求计划": "ot_pbpheader",
                  "采购订单头": "ot_poheader"}
    by_group = {"采购需求计划": "ot_pbpheader", "采购合同": "ot_clmcontract"}
    cases = [
        ("apiName 直接命中", {"object": "pbpHeader"}),
        ("apiName 大小写无关", {"object": "  PBPHEADER "}),
        ("中文名命中 by_display", {"object_display": "采购业务计划头"}),
        ("命中 by_group", {"object_display": "采购合同"}),
        ("前缀唯一命中", {"object_display": "采购订单"}),
        ("什么都没给", {}),
        ("给了但对不上", {"object_display": "不存在的对象"}),
        ("object 优先于 object_display",
         {"object": "poHeader", "object_display": "采购业务计划头"}),
    ]
    return [{"note": note, "action": a, "by_api": by_api, "by_display": by_display,
             "by_group": by_group,
             "out": _resolve_host(a, by_api, by_display, by_group)}
            for note, a in cases]


def _outstanding_cases() -> list[dict[str, Any]]:
    def run(note: str, rows: list[dict], have: dict) -> dict[str, Any]:
        shape = infer_shape(rows)
        return {"note": note, "rows": rows, "have": have,
                "out": [y.value for y in outstanding(shape, have)]}

    reg_pre = structural_extract(REGISTRY, _cites(REGISTRY), infer_shape(REGISTRY))
    fld_pre = structural_extract(FIELDS, _cites(FIELDS), infer_shape(FIELDS))
    act_pre = structural_extract(ACTIONS, _cites(ACTIONS), infer_shape(ACTIONS))
    filled = {**fld_pre, "properties": [{**p, "definition": "含税口径"}
                                        for p in fld_pre["properties"]]}
    return [
        run("登记表：什么都没抽", REGISTRY, {}),
        run("登记表：规则抽好了对象", REGISTRY, dict(reg_pre)),
        run("字段表：规则搬完行仍要向模型索要口径", FIELDS, dict(fld_pre)),
        run("字段表：口径齐了就不必再问", FIELDS, filled),
        run("字段表：模型抽的（_origin 不是 rule）就不再追口径", FIELDS,
            {**fld_pre, "properties": [{**p, "_origin": "llm", "definition": ""}
                                       for p in fld_pre["properties"]]}),
        run("行动表：规则抽了行动，对象还欠着", ACTIONS, dict(act_pre)),
        run("问卷段：yields 里只有 QUESTIONS，一条都不欠", SURVEY, {}),
        run("散文段：yields 里只有 RULES，一条都不欠", PROSE, {}),
        run("非 dict 混进桶里会被过滤掉", REGISTRY, {"objects": ["不是字典", 3]}),
    ]


def _window_cases() -> list[dict[str, Any]]:
    out = []
    for note, rows, part in [("整表 15 行、窗口 5 行", REGISTRY, REGISTRY[:5]),
                             ("窗口是空的", ACTIONS, [])]:
        whole = infer_shape(rows)
        out.append({"note": note, "rows": rows, "part_rows": part,
                    "out": _window_shape(whole, part).to_dict()})
    return out


# ══════════════════════════════════════════════════════════════════
#  2. _prov
# ══════════════════════════════════════════════════════════════════
def _prov_section() -> dict[str, Any]:
    chunks = [
        Chunk(chunk_id="k1", file_id="f_abc123", file_name="材料.xlsx",
              locator={"kind": "range", "sheet": "实体", "rows": [2, 2]},
              render="应用模块=采购计划管理 | 实体编码=pbpHeader" + "尾" * 300,
              raw={"实体编码": "pbpHeader"}, order=0, tags=["row"]),
        Chunk(chunk_id="k2", file_id="f_abc123", file_name="材料.xlsx",
              locator={"kind": "cell", "sheet": "实体", "row": 3, "col": 2},
              render="单元格内容", raw={"a": 1}, order=1, tags=["row"]),
    ]
    index = EvidenceIndex()
    for c in chunks:
        index.add(c)

    cases = [
        ("规则抽的、cite 精确命中 → confidence 1.0",
         {"source_locator": "材料.xlsx!实体!R2-2", "_origin": "rule"}, True),
        ("模型给的、cite 精确命中 → confidence 0.85",
         {"source_locator": "材料.xlsx!实体!R2-2"}, True),
        ("cite 是后缀、带 source_file → 退化到 endswith 匹配",
         {"source_locator": "实体!R3C2", "source_file": "材料.xlsx"}, True),
        ("有索引但 cite 对不上 → 落到 raw locator",
         {"source_locator": "别的文件!X!R9-9", "source_file": "别的文件.xlsx",
          "definition": "口径说明" * 80}, True),
        ("没有索引 → 直接落到 raw locator",
         {"source_locator": "材料.xlsx!实体!R2-2", "_origin": "rule",
          "display_name": "采购业务计划头"}, False),
        ("什么都没有 → f_x / 未知来源 / 未标注位置", {}, False),
        ("文件名超过 6 个码点（中文）—— file_id 按码点切",
         {"source_file": "一二三四五六七八九.xlsx"}, False),
    ]
    return {
        "chunks": [{"chunk_id": c.chunk_id, "file_id": c.file_id,
                    "file_name": c.file_name, "locator": c.locator,
                    "render": c.render, "raw": c.raw, "order": c.order,
                    "tags": list(c.tags)} for c in chunks],
        "cases": [
            {"note": note, "item": item, "with_index": use,
             "out": _pv(_prov(item, index if use else None))}
            for note, item, use in cases
        ],
    }


def _pv(p: Any) -> dict[str, Any]:
    return {"file_id": p.file_id, "file_name": p.file_name, "locator": p.locator,
            "snippet": p.snippet, "extractor": p.extractor,
            "confidence": p.confidence}


# ══════════════════════════════════════════════════════════════════
#  3. Segment / segment_corpus
# ══════════════════════════════════════════════════════════════════
def _segment_render_cases() -> list[dict[str, Any]]:
    out = []
    for note, rows, limit, extra_ids in [
        ("四行全进 render", REGISTRY[:4], 45, []),
        ("limit=2，剩下的写成一句「本段另有 N 个切片」", REGISTRY[:5], 2, []),
        ("索引里没有的 chunk_id 直接跳过", REGISTRY[:3], 45, ["c99", "cX"]),
    ]:
        idx = _Idx(rows, _cites(rows), _renders(rows))
        ids = [f"c{i}" for i in range(len(rows))] + extra_ids
        seg = Segment(key="s0", label="业务对象实体梳理", file_name="材料.xlsx",
                      chunk_ids=ids)
        got_rows, got_cites = seg.rows(idx)
        out.append({
            "note": note, "key": seg.key, "label": seg.label,
            "file_name": seg.file_name, "chunk_ids": ids,
            "rows": rows, "cites": _cites(rows), "renders": _renders(rows),
            "limit": limit,
            "out_rows": got_rows, "out_cites": got_cites,
            "out_render": seg.render(idx, limit),
        })
    return out


def _doc(sheet: str, rows: list[dict], *, file_name: str = "x.xlsx",
         extra: list[Chunk] | None = None, tags: list[str] | None = None) -> Any:
    """伪造一份解析结果：一行一个 range 切片，外加若干非数据切片。"""

    class _Doc:
        pass

    d = _Doc()
    d.file_name = file_name
    d.chunks = [
        Chunk(chunk_id=f"{sheet}_{i}", file_id="f1", file_name=file_name,
              locator={"kind": "range", "sheet": sheet, "rows": [i + 2, i + 2]},
              render=str(r), raw=r, order=i, tags=list(tags if tags is not None else ["row"]))
        for i, r in enumerate(rows)
    ] + list(extra or [])
    return d


def _corpus_cases() -> list[dict[str, Any]]:
    out = []

    def run(note: str, doc: Any) -> None:
        index = EvidenceIndex()
        for c in doc.chunks:
            index.add(c)
        segs = segment_corpus(index, [doc])
        out.append({
            "note": note, "file_name": doc.file_name,
            "chunks": [{"chunk_id": c.chunk_id, "file_id": c.file_id,
                        "file_name": c.file_name, "locator": c.locator,
                        "render": c.render, "raw": c.raw, "order": c.order,
                        "tags": list(c.tags)} for c in doc.chunks],
            "out": [{"key": s.key, "label": s.label, "file_name": s.file_name,
                     "chunk_ids": list(s.chunk_ids), "shape": s.shape.to_dict(),
                     "carry_in": dict(s.carry_in)} for s in segs],
        })

    # 真实事故：112 行接口表被按 45 行切成三段，第二段开头正卡在组中间
    rows = [{"应用模块": "采购计划管理", "业务对象": "采购需求计划",
             "实体编码": "createPbp", "实体名称": "创建PBP", "url": "/v1/createPbp"}]
    rows += [{"应用模块": "", "业务对象": "", "实体编码": f"queryPbp{i}",
              "实体名称": f"查询{i}", "url": f"/v1/queryPbp{i}"}
             for i in range(SEGMENT_CHUNKS + 10)]
    run("一张表被拦腰切开，后半段靠 carry_in 补回组名", _doc("行动", rows))

    rows2 = [{"应用模块": "采购", "业务对象": "采购订单", "实体编码": "poHeader",
              "实体名称": "采购订单头"}]
    rows2 += [{"应用模块": "", "业务对象": "", "实体编码": f"poLine{i}",
               "实体名称": f"行{i}"} for i in range(SEGMENT_CHUNKS + 5)]
    run("形状按整张表推，两段的 row_unit 必须一致", _doc("实体", rows2))

    # 解析器为每张表额外产一片列画像 —— 它不是一行数据
    schema = Chunk(chunk_id="schema", file_id="f1", file_name="x.xlsx",
                   locator={"kind": "range", "sheet": "实体", "rows": [1, 1]},
                   render="列画像", order=99,
                   raw={"实体编码": {"name": "实体编码", "count": 8, "null_rate": 0.0}},
                   tags=["schema"])
    run("列画像切片不算数据行",
        _doc("实体", [{"实体编码": f"po{i}", "实体名称": f"名{i}"} for i in range(8)],
             extra=[schema]))

    # 小于 MIN_SEGMENT 的段并回同文件的"其它"
    class _Multi:
        pass

    small = _doc("小表", [{"编码": f"a{i}"} for i in range(3)])
    big = _doc("大表", [{"编码": f"b{i}", "名称": f"n{i}"} for i in range(9)])
    m = _Multi()
    m.file_name = "x.xlsx"
    m.chunks = small.chunks + big.chunks
    run("太小的段并进「其它」", m)

    # tags 是空的 —— 条件表达式绑得最松，整个 or 链根本没被求值
    run("没有 tags 的切片一律归 main",
        _doc("实体", [{"编码": f"po{i}"} for i in range(8)], tags=[]))

    # locator 里没有 sheet 时，key 依次退到 object / section / page / tags[0]。
    # 这四条支路端到端跑不到（材料是 xlsx，永远走 sheet 那一支）。
    class _Loc:
        pass

    def loc_doc(name: str, locs: list[dict], tags: list[str]) -> Any:
        d = _Loc()
        d.file_name = name
        d.chunks = [
            Chunk(chunk_id=f"k{i}", file_id="f1", file_name=name, locator=loc,
                  render=f"内容{i}", raw={"编码": f"c{i}", "名称": f"n{i}"},
                  order=i, tags=list(tags))
            for i, loc in enumerate(locs)
        ]
        return d

    run("locator 用 object（点分的取第一段）",
        loc_doc("db.sql", [{"kind": "ddl", "object": f"public.t{0}"} for _ in range(7)],
                ["row"]))
    run("locator 用 section",
        loc_doc("说明.docx", [{"kind": "json", "section": "第三章"} for _ in range(7)],
                ["row"]))
    run("locator 用 page",
        loc_doc("扫描件.pdf", [{"kind": "page", "page": 4} for _ in range(7)], ["row"]))
    run("四样都没有 → 退到 tags[0]",
        loc_doc("随便.txt", [{"kind": "raw"} for _ in range(7)], ["para", "row"]))
    return out


# ══════════════════════════════════════════════════════════════════
#  4. handler
# ══════════════════════════════════════════════════════════════════
def _task_cases() -> list[dict[str, Any]]:
    out = []
    for note, rows, label in [
        ("行动表：宿主名要直接摆给模型看", ACTIONS, "业务对象API梳理-行动"),
        ("字段表：行已搬好，欠的是口径", FIELDS, "字段清单"),
        ("登记表：零属性是正确结果", REGISTRY, "业务对象实体梳理"),
        ("问卷段：yields 里只有 QUESTIONS", SURVEY, "待澄清问题"),
        ("散文段：没有一条产出是规则能定的", PROSE, "岗位职责"),
    ]:
        h, _idx = _handler(rows, label)
        out.append({
            "note": note, "key": "s0", "label": label,
            "rows": rows, "cites": _cites(rows), "renders": _renders(rows),
            "wants": [y.value for y in h.wants()],
            "task": h.task({}), "query": h.query({}),
        })
    return out


def _finalize_cases() -> list[dict[str, Any]]:
    out = []
    for note, rows, label, draft in [
        ("模型重复抽了规则已有的对象 —— 丢掉模型那份", REGISTRY, "登记表",
         {"objects": [{"api_name": "pbpHeader", "display_name": "重复"},
                      {"api_name": "newThing", "display_name": "模型新抽的"}],
          "links": [{"api_name": "pbpLines"}]}),
        ("规则侧为空时模型那份全留", PROSE, "散文",
         {"objects": [{"api_name": "x"}], "rules": [{"statement": "一条规则"}]}),
        ("draft 不是 dict 时当空 dict", ACTIONS, "行动表", "不是字典"),
        ("questions 直接全收规则那份", SURVEY, "问卷",
         {"questions": [{"text": "模型编的问题"}], "objects": []}),
    ]:
        h, _idx = _handler(rows, label)
        out.append({
            "note": note, "label": label,
            "rows": rows, "cites": _cites(rows), "renders": _renders(rows),
            "draft": draft, "out": h.finalize(draft, {}),
        })
    return out


def _mine_rules() -> dict[str, Any]:
    idx = _Idx(PROSE, _cites(PROSE), _renders(PROSE))

    class _Agent:
        output_schema = {"type": "object"}

    h = MineRules(_seg(PROSE, "s0", "岗位职责"), idx, _Agent(), "sys")
    return {"label": "岗位职责", "rows": PROSE, "cites": _cites(PROSE),
            "renders": _renders(PROSE), "task": h.task({}), "query": h.query({})}


def _harvest() -> dict[str, Any]:
    idx = _Idx(SURVEY, _cites(SURVEY), _renders(SURVEY))
    h = HarvestQuestions(_seg(SURVEY, "s0", "待澄清问题"), idx)
    return {"label": "待澄清问题", "rows": SURVEY, "cites": _cites(SURVEY),
            "renders": _renders(SURVEY), "task": h.task({}),
            "skip_model": h.skip_model({})}


def _router() -> dict[str, Any]:
    """形状 → handler 的挑选，以及散文段拿到的 system。

    `_SegmentRouter` 是 fan-out 的分派点。挑错了不会报错 —— 散文段走实体抽取会
    产出一堆「与采购需求计划一致」这样的伪实体，看起来一切正常。
    """
    from ontocopilot.kernel.agents import default_agents
    from ontocopilot.onto.pipeline import _SegmentRouter

    segs = [_seg([{"编码": "a"}, {"编码": "b"}, {"编码": "c"}], "s0", "表"),
            _seg(PROSE, "s1", "散文"),
            _seg(SURVEY, "s2", "问卷")]
    idx = _Idx([], [], [])
    extractor = default_agents().get("extractor")
    r = _SegmentRouter(segs, idx, extractor, "sys")
    return {
        "row_units": [s.shape.row_unit for s in segs],
        "handlers": {s.key: type(r.for_node(f"EXTRACT.{s.key}")).__name__ for s in segs},
        "rule_miner_system": default_agents().get("rule_miner").render_system(),
        "extractor_system_arg": "sys",
        "missing_key_error": _router_missing(r),
    }


def _router_missing(r: Any) -> str:
    try:
        r.for_node("EXTRACT.s9")
    except KeyError as exc:
        return str(exc.args[0])
    return ""


def _dispatch() -> list[dict[str, Any]]:
    """`dispatch` 的错误文案。工具失败要**回给模型**，不是中断整个节点 ——
    中断的话模型永远学不到"这个参数传错了"。"""
    cases = []
    for note, exc in [("TypeError", TypeError("参数不对")),
                      ("KeyError（repr 会带引号）", KeyError("evidence.rows")),
                      ("自定义异常类", type("ToolDenied", (Exception,), {})("没权限"))]:
        cases.append({"note": note,
                      "out": {"error": f"{type(exc).__name__}: {exc}"}})
    cases.append({"note": "黑板上没有 _tools", "out": {"error": "本节点没有可用工具"}})
    return cases


def _merge() -> dict[str, Any]:
    inputs = {
        "EXTRACT.s0": {"objects": [{"api_name": "a"}], "links": [],
                       "questions": [{"text": "q1"}]},
        "EXTRACT.s1": {"objects": [{"api_name": "b"}], "rules": [{"statement": "r"}],
                       "unknown_bucket": [1, 2]},
        "EXTRACT.s2": "不是字典",
        "EXTRACT.s3": {"properties": None, "actions": [{"api_name": "createPbp"}]},
    }
    got = asyncio.run(MergeSegments(None).execute(inputs, None))
    return {"inputs": inputs, "out": got}


# ══════════════════════════════════════════════════════════════════
#  5. critic
# ══════════════════════════════════════════════════════════════════
def _verdict(v: Any) -> dict[str, Any]:
    return {
        "lens": v.lens, "passed": v.passed, "note": v.note,
        "findings": [{"severity": f.severity.value, "code": f.code,
                      "target": f.target, "claim": f.claim,
                      "evidence_checked": list(f.evidence_checked),
                      "proposed_fix": f.proposed_fix, "verifier": f.verifier}
                     for f in v.findings],
    }


def _coverage_cases() -> list[dict[str, Any]]:
    out = []

    def run(note: str, rows: list[dict], draft: Any, *, key: str = "s0",
            node_id: str | None = None, label: str = "测试段") -> None:
        seg = Segment(key=key, label=label, file_name="x.xlsx",
                      chunk_ids=[f"c{i}" for i in range(len(rows))],
                      shape=infer_shape(rows))
        critic = CoverageCritic([seg], None)
        ctx = CriticContext(node_id=node_id or f"EXTRACT.{key}",
                            gateway=None, generator=None)
        out.append({"note": note, "key": key, "label": label, "rows": rows,
                    "draft": draft, "node_id": ctx.node_id,
                    "out": _verdict(asyncio.run(critic.judge(draft, ctx)))})

    run("登记表抽出对象、零属性 —— 必须通过", REGISTRY,
        {"objects": [{"api_name": f"o{i}"} for i in range(len(REGISTRY))],
         "properties": [], "links": []})
    run("168 行只抽出 4 个 —— ROWS_DROPPED", REGISTRY,
        {"objects": [{"api_name": f"o{i}"} for i in range(4)],
         "properties": [], "links": []})
    run("字段表零属性 —— PROPERTIES_MISSING", FIELDS,
        {"objects": [{"api_name": "pbpHeader"}], "properties": [], "links": []})
    run("散文段判 rules，不判对象", PROSE, {"rules": []})
    run("散文段交了规则就通过", PROSE,
        {"rules": [{"statement": "采购包创建后不得修改采购方式"}]})
    run("问卷段判 questions", SURVEY, {"questions": []})
    run("问卷段交了问题就通过", SURVEY, {"questions": [{"text": "一个问题"}]})
    run("draft 不是 dict —— EXTRACT_EMPTY(type)", REGISTRY, ["不是字典"])
    run("说明文字被当成实体名 —— PROSE_AS_ENTITY", REGISTRY,
        {"objects": [{"api_name": f"o{i}"} for i in range(len(REGISTRY))]
                    + [{"api_name": "与采购需求计划一致"}],
         "properties": [], "links": []})
    run("节点 id 认不出对应的段 —— 一条 finding 都不出", REGISTRY,
        {"objects": []}, key="s0", node_id="EXTRACT.s9")
    run("行动表：规则抽好行动、对象仍缺 —— OBJECTS_MISSING", ACTIONS,
        {"objects": [], "properties": [],
         "actions": [{"api_name": "createPbp"}]})
    return out


def _coverage_keyerror() -> dict[str, Any]:
    """两列标识符的表 → `yields` 带上 LINKS → `cn[Yield.LINKS]` KeyError。

    这是 Python 侧真实存在的缺陷（`CHECKED_YIELDS` 有 LINKS，`cn` 没有）。
    照实导出，TS 侧照实抛 —— 迁移期的目标是行为等价，不是趁机修 bug。
    """
    rows = TWO_IDENT
    draft = {"objects": [{"api_name": "a"}], "properties": [{"api_name": "p"}],
             "actions": []}
    seg = Segment(key="s0", label="两列标识符", file_name="x.xlsx",
                  chunk_ids=[f"c{i}" for i in range(len(rows))],
                  shape=infer_shape(rows))
    critic = CoverageCritic([seg], None)
    ctx = CriticContext(node_id="EXTRACT.s0", gateway=None, generator=None)
    try:
        asyncio.run(critic.judge(draft, ctx))
        err = None
    except Exception as exc:  # noqa: BLE001
        err = type(exc).__name__
    return {"rows": rows, "draft": draft, "python_error": err,
            "shape_yields": sorted(y.value for y in infer_shape(rows).yields)}


def _provenance_cases() -> list[dict[str, Any]]:
    out = []
    for note, draft in [
        ("全都有出处 —— 零 finding",
         {"objects": [{"api_name": "a", "source_locator": "x!S!R2-2"}],
          "properties": [], "links": []}),
        ("三个桶各缺一条",
         {"objects": [{"api_name": "a"}],
          "properties": [{"api_name": "p", "source_locator": "  "}],
          "links": [{"source_locator": None}]}),
        ("超过 12 条只留前 12",
         {"objects": [{"api_name": f"o{i}"} for i in range(20)]}),
        ("draft 不是 dict", "不是字典"),
    ]:
        v = asyncio.run(provenance_critic().judge(draft, CriticContext(
            node_id="N", gateway=None, generator=None)))
        out.append({"note": note, "draft": draft, "out": {
            "lens": v.lens, "passed": v.passed, "note": v.note,
            "findings": [{"severity": f.severity.value, "code": f.code,
                          "target": f.target, "claim": f.claim,
                          "verifier": f.verifier} for f in v.findings]}})
    return out


# ══════════════════════════════════════════════════════════════════
#  6. DAG
# ══════════════════════════════════════════════════════════════════
def _dag() -> dict[str, Any]:
    keys = ["s0_0", "s1_0", "s2_0"]
    segs = [Segment(key=k, label=k, file_name="x.xlsx", chunk_ids=[]) for k in keys]
    return {"keys": keys, "describe": build_dag(segs).describe()}


# ══════════════════════════════════════════════════════════════════
#  7. build_oir
# ══════════════════════════════════════════════════════════════════
def _build_oir_cases() -> list[dict[str, Any]]:
    reg_shape = infer_shape(REGISTRY)
    reg = structural_extract(REGISTRY, _cites(REGISTRY), reg_shape)
    act_shape = infer_shape(ACTIONS)
    act = structural_extract(ACTIONS, _cites(ACTIONS), act_shape)

    cases: list[tuple[str, dict[str, Any]]] = [
        ("空输入", {}),
        ("行动挂到分组列写的宿主上（两张表之间唯一对得上的东西）",
         {"objects": reg["objects"], "actions": act["actions"]}),
        ("说明文字不许变成实体名或接口名",
         {"objects": [{"api_name": "与采购需求计划一致"}, {"api_name": "pbpHeader"}],
          "actions": [{"api_name": "与采购需求计划一致"}, {"api_name": "createPbp"}]}),
        ("属性挂不上父对象 → 丢弃并记账",
         {"objects": [{"api_name": "pbpHeader", "display_name": "采购业务计划头"}],
          "properties": [
              {"parent_api_name": "pbpHeader", "api_name": "planId",
               "base_type": "string", "definition": "计划编号", "required": True},
              {"parent_api_name": "pbpHeader", "api_name": "amount",
               "base_type": "不认识的类型", "unit": "元"},
              {"parent_api_name": "对不上的名字", "api_name": "lost1"},
              {"parent_api_name": "对不上的名字", "api_name": "lost2"},
              {"parent_api_name": "pbpHeader", "api_name": ""},
          ]}),
        ("关系两端对不上名字 → 丢弃并记账",
         {"objects": [{"api_name": "pbpHeader"}, {"api_name": "pbpLine"}],
          "links": [
              {"api_name": "pbpLines", "from_api_name": "pbpHeader",
               "to_api_name": "pbpLine", "cardinality": "one_to_many"},
              {"api_name": "bad", "from_api_name": "pbpHeader",
               "to_api_name": "不存在"},
              {"api_name": "", "from_api_name": "pbpHeader",
               "to_api_name": "pbpLine"},
              {"api_name": "weird", "from_api_name": "pbpHeader",
               "to_api_name": "pbpLine", "cardinality": "不认识"},
          ]}),
        ("规则：太短的丢、挂不上的照收",
         {"objects": [{"api_name": "pbpHeader", "display_name": "采购业务计划头"}],
          "rules": [
              {"statement": "采购包创建后不得修改采购方式", "kind": "validation",
               "actor": "采购计划员", "applies_to": ["pbpHeader"]},
              {"statement": "年度采购计划须经二级审批", "kind": "不认识",
               "applies_to": []},
              {"statement": "见上"},
              {"statement": "按中文名挂上去", "applies_to": ["采购业务计划头"]},
          ]}),
        ("问题：已答的是事实（CONFIRMED），未答的才是待办",
         {"objects": [{"api_name": "pbpHeader", "display_name": "采购业务计划头"}],
          "questions": [
              {"text": "集采计划是在系统里编的还是线下编的？", "code": "3",
               "group": "（1）编制集采计划",
               "options": ["全线下", "系统里编"], "answer": ""},
              {"text": "审批需要几级？分别是谁？", "code": "7",
               "answer": "两级", "applies_to": ["采购业务计划头"]},
              {"text": "太短", "code": "9"},
          ]}),
        ("同名对象出现两次 → 保留先出现的，别名并进去",
         {"objects": [
             {"api_name": "pbpHeader", "display_name": "采购业务计划头",
              "group": "采购需求计划"},
             {"api_name": "pbpHeader", "display_name": "另一个中文名",
              "group": "另一个分组"},
         ]}),
        ("主键从 *Id 结尾的属性里推",
         {"objects": [{"api_name": "pbpHeader"}],
          "properties": [
              {"parent_api_name": "pbpHeader", "api_name": "name"},
              {"parent_api_name": "pbpHeader", "api_name": "planId"},
              {"parent_api_name": "pbpHeader", "api_name": "otherID"},
          ]}),
        ("行动带 endpoint → source_endpoint 落 path/display",
         {"objects": [{"api_name": "pbpHeader", "display_name": "采购业务计划头",
                       "group": "采购需求计划"}],
          "actions": [
              {"api_name": "createPbp", "display_name": "创建PBP",
               "endpoint": "/v1/createPbp", "object_display": "采购需求计划"},
              {"api_name": "queryPbp", "object": "pbpHeader"},
          ]}),
    ]
    out = []
    for note, data in cases:
        dropped: dict[str, Any] = {}
        oir = build_oir(data, None, dropped)
        out.append({"note": note, "data": data, "out": oir.to_dict(),
                    "dropped": dropped})
    return out


# ══════════════════════════════════════════════════════════════════
#  8. finish
# ══════════════════════════════════════════════════════════════════
def _finish_cases() -> list[dict[str, Any]]:
    def mk() -> OIR:
        oir = OIR()
        for api, disp in [("pbpHeader", "采购业务计划头"), ("pbpLine", "采购业务计划行"),
                          ("clmContract", "采购合同"), ("clmContractHeader", "采购合同头")]:
            oir.add_object(ObjectType(rid=f"ot_{api.lower()}", api_name=inferred(api),
                                      display_name=inferred(disp),
                                      primary_key=inferred([])))
        oir.add_property(PropertyType(
            rid="pt_1", parent="ot_pbpheader", api_name=inferred("amount"),
            display_name=inferred("计划金额"), base_type=inferred("DECIMAL"),
            definition=inferred("含税金额")))
        oir.add_property(PropertyType(
            rid="pt_2", parent="ot_pbpline", api_name=inferred("amount"),
            display_name=inferred("计划金额"), base_type=inferred("DECIMAL"),
            definition=inferred("不含税金额")))
        oir.add_rule(BusinessRule(rid="br_1",
                                  statement=inferred("采购包创建后不得修改采购方式")))
        oir.add_question(OpenQuestion(rid="oq_1", text=inferred("集采计划怎么编？"),
                                      options=["线下", "系统"], group="编制"))
        return oir

    out = []
    for note, max_q, project in [("默认 3 个问题", 3, "golden"),
                                 ("只问 1 个", 1, "")]:
        oir = mk()
        base = oir.to_dict()
        res = finish(oir, max_questions=max_q, project=project)
        cs = res["clarify"]
        out.append({
            "note": note, "oir": base, "max_questions": max_q, "project": project,
            "out": {
                "align": res["align"],
                "merged": res["merged"],
                "uncertain": res["uncertain"],
                "align_gaps": [_gap(g) for g in res["align_gaps"]],
                "conflicts": [c.to_dict() for c in res["conflicts"]],
                "auto_repaired": res["auto_repaired"],
                "clarify": {
                    "summary": cs.summary(),
                    "questions": [q.to_dict() for q in cs.questions],
                    "auto_repairable": [c.rid for c in cs.auto_repairable],
                    "deferred_to_template": [c.rid for c in cs.deferred_to_template],
                    "round_trip": [c.rid for c in cs.round_trip],
                    "hints": [c.rid for c in cs.hints],
                    "stopped_because": cs.stopped_because,
                },
                "suggestions": res["suggestions"],
                "template_spec": res["template_spec"].to_dict(),
            },
            "oir_after": oir.to_dict(),
        })
    return out


def _gap(g: Any) -> dict[str, Any]:
    return {"text": g.text, "group": g.group, "kind": g.kind,
            "prov": _pv(g.prov) if g.prov else None,
            "options": g.options, "applies_to": g.applies_to, "weight": g.weight}


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    _w({
        "consts": _consts(),
        "looks_like_prose": _prose_cases(),
        "is_data_row": _is_data_row_cases(),
        "preview_names": _preview_cases(),
        "host_names": _host_cases(),
        "resolve_host": _resolve_cases(),
        "outstanding": _outstanding_cases(),
        "window_shape": _window_cases(),
        "prov": _prov_section(),
        "segment_render": _segment_render_cases(),
        "segment_corpus": _corpus_cases(),
        "extract_task": _task_cases(),
        "finalize": _finalize_cases(),
        "mine_rules": _mine_rules(),
        "harvest": _harvest(),
        "merge": _merge(),
        "segment_router": _router(),
        "dispatch": _dispatch(),
        "coverage": _coverage_cases(),
        "coverage_links_keyerror": _coverage_keyerror(),
        "provenance": _provenance_cases(),
        "build_dag": _dag(),
        "build_oir": _build_oir_cases(),
        "finish": _finish_cases(),
    })


if __name__ == "__main__":
    main()
