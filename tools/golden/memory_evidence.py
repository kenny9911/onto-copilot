"""kernel/memory/{evidence,short_term}.py 的 golden —— L2 证据检索与 L1 工作记忆。

evidence 决定产品输出质量（问题清单/流程图/模板列全部从检索出来的证据推），
所以这里不挑"代表性"用例，而是把每一处 Python 与 JS 会分叉的地方逐个钉死：

  - `tokenize` 的 `\\d+`：Python 的 `\\d` 是 **Unicode Nd**（全角 １２３ 也算），
    JS 的 `\\d` 只有 ASCII —— 不翻译成 `\\p{Nd}` 就会漏掉全角数字列名。
  - `_CAMEL_RE` 的零宽 split、CJK 二字组、`[㐀-鿿]` 的四个边界。
  - `cite()` 每个 kind 分支，含 `loc.get('row')` 缺键时 f-string 写出 `None`
    （JS 会写 `undefined`）。
  - BM25 打分后的**排序**：`sorted(scores, key=-score)` 是稳定排序，同分时保持
    `scores` 的插入序，而那个插入序来自**遍历 set**（`candidates`）—— 见
    `tie_nondeterminism` 一节：Python 自己就随 PYTHONHASHSEED 变。
  - `_expand` / `by_locator` 的 `sort(key=(str, int))`：字符串按**码点**比较，
    JS 默认 `sort()` 按 UTF-16 码元 —— 星平面文件名会翻。
  - `search(files=...)` 过滤的是 **file_id**（不是文件名）。真实事故见
    commit 30db2d1：没有任何工具给过模型 file_id，模型一填 files 就静默拿到空
    结果，然后据此断言"材料里没有"。行为本身没改（改的是 tools 层做名字解析），
    所以这里必须把"按 id 过滤"和 `file_names()` 的映射一起钉住。
  - short_term 的 `_LOCATOR_RE`：`\\w` / `\\b` / `\\s` 在 Python 是 Unicode 语义，
    在 JS 是 ASCII 语义（`\\b`）或集合略有出入（`\\s` 差 \\x1c-\\x1f \\x85 \\ufeff）。
  - `digest` 的 `text[:int(len(text)*0.8)]` 与 `heuristic_summary` 的 `[:80]`：
    按**码点**切，emoji 用 JS 的 `.slice` 会切出半个代理对。
  - `Scratchpad.compact` 的 `head <= 1` 边界（keep_verbatim 附近的 off-by-one
    会静默吃掉用户刚说的话）。

字节确定：不序列化任何 set；分数不导出（Python 不暴露），导出的是**顺序**，
顺序才是下游看得见的东西。重跑两次 shasum 一致。

    .venv/bin/python tools/golden/memory_evidence.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.memory.evidence import (  # noqa: E402
    Chunk,
    EvidenceIndex,
    tokenize,
)
from ontocopilot.kernel.memory.short_term import (  # noqa: E402
    Scratchpad,
    Turn,
    WorkingSet,
    extract_locators,
    heuristic_summary,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  tokenize
# ══════════════════════════════════════════════════════════════════
TOKENIZE_CASES = [
    "",
    " ",
    "clmContract",
    "plan_amount",  # `_` 不被 _TOKEN_RE 匹配，所以直接就是两个词（`"_" in low` 是死枝）
    "采购包头",
    "采购业务计划头 pbpHeader 年度滚动",
    "CREATE TABLE clm_contract (plan_amount DECIMAL(18,2)) -- 不含税·单次",
    # camelCase：len(t) > 3 才拆
    "aB",
    "aBc",
    "aBcd",
    "abCd",
    "ABCD",  # 全大写：(?<=[a-z0-9]) 不成立，不拆
    "a1B2c3D",
    "XMLHttpRequest",
    "planAmount2024",
    # Unicode 数字：Python 的 \d 是 Nd，JS 的 \d 只有 ASCII
    "１２３",
    "ABC２",
    "٤٢",  # 阿拉伯-印度数字
    "R44C6",
    # [㐀-鿿] 的四个边界
    "㐀",  # U+3400 起点
    "鿿",  # U+9FFF 终点
    "㏿",  # U+33FF 起点前一个：不是 CJK 段
    "ꀀ",  # U+A000 终点后一个
    "一二三四",  # 四字 → 4 单字 + 3 二字组
    "一",  # 单字：range(0) → 无二字组
    "中a中",  # CJK 段被拉丁打断，分成两段
    "𠀀",  # 扩展 B（星平面）：_TOKEN_RE 不匹配，整个丢掉
    "采购 采购",  # 重复：Counter 计数
    "訂單 order_no 字段",
    "混合Mixed名称2024",
    "  多  空格  ",
    "a" * 40,
    "中" * 20,
    "\n\t",
]


# ══════════════════════════════════════════════════════════════════
#  切片夹具 —— evidence 全部用例共用这一份索引
# ══════════════════════════════════════════════════════════════════
#: 每个 dict 就是 `Chunk(**d)` 的入参，TS 侧照同一份造，两边才比得起来。
CHUNKS: list[dict[str, Any]] = [
    # ── f3：xlsx 的 cell 切片，order 连续，用来验邻域扩展 ──
    {"chunk_id": "f3:c0", "file_id": "f3", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "cell", "sheet": "业务对象实体梳理", "row": 40, "col": "F"},
     "render": "采购业务计划头 pbpHeader 年度滚动", "order": 0},
    {"chunk_id": "f3:c1", "file_id": "f3", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "cell", "sheet": "业务对象实体梳理", "row": 41, "col": "F"},
     "render": "采购业务计划行 pbpLine 按物料拆分", "order": 1},
    {"chunk_id": "f3:c2", "file_id": "f3", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "cell", "sheet": "业务对象实体梳理", "row": 44, "col": "F"},
     "render": "clmContract 采购合同 计划金额（含税，年度累计）", "order": 2,
     "tags": ["rule"]},
    {"chunk_id": "f3:c3", "file_id": "f3", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "cell", "sheet": "业务对象实体梳理", "row": 45, "col": "F"},
     "render": "supplierCode 供应商编码", "order": 3},
    {"chunk_id": "f3:c4", "file_id": "f3", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "range", "sheet": "供应商主数据", "rows": [80, 84]},
     "render": "poHeader 采购订单头", "order": 4,
     "context": "第 4 章 订单域"},
    # ── f5：DDL。同一个物理名在另一份材料里的口径不同 —— 跨文件冲突就靠它 ──
    {"chunk_id": "f5:d0", "file_id": "f5", "file_name": "schema.ddl",
     "locator": {"kind": "ddl", "object": "clm_contract"},
     "render": "CREATE TABLE clm_contract (plan_amount DECIMAL(18,2)) -- 不含税·单次",
     "order": 0, "tags": ["fk", "relation"]},
    {"chunk_id": "f5:d1", "file_id": "f5", "file_name": "schema.ddl",
     "locator": {"kind": "ddl", "object": "supplier"},
     "render": "CREATE TABLE supplier (supplier_code VARCHAR(32))", "order": 1},
    # ── f7：docx。section 进 _situate，不进 render ──
    {"chunk_id": "f7:p0", "file_id": "f7", "file_name": "需求说明.docx",
     "locator": {"kind": "page", "page": 3, "section": "采购流程"},
     "render": "一个执行计划可拆入多个采购包", "order": 0, "tags": ["para"]},
    {"chunk_id": "f7:p1", "file_id": "f7", "file_name": "需求说明.docx",
     "locator": {"kind": "page", "page": 3, "section": "采购流程"},
     "render": "一个执行计划可拆入多个采购包", "order": 1, "tags": ["para", "rule"]},
    # ── f9：json / meta / xml / 空 locator / 未知 kind，全是 cite() 的分支 ──
    {"chunk_id": "f9:j0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "json", "pointer": "$.components.schemas.Plan"},
     "render": "Plan: plan_amount number 计划金额", "order": 0},
    {"chunk_id": "f9:m0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "meta", "field": "title"},
     "render": "采购中台 OpenAPI", "order": 1},
    {"chunk_id": "f9:x0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "xml", "pointer": "/root/item[1]"},
     "render": "xml 里的一段", "order": 2},
    {"chunk_id": "f9:u0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "不认识的种类"}, "render": "未知 kind 的切片", "order": 3},
    {"chunk_id": "f9:e0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {}, "render": "空 locator 的切片", "order": 4},
    # cell 缺 row / col：f-string 写出字面量 "None"（JS 会写 undefined）
    {"chunk_id": "f9:n0", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "cell"}, "render": "缺 row col 的 cell", "order": 5},
    # range 缺 rows：走 loc.get("rows", [0, 0]) 的默认值
    {"chunk_id": "f9:n1", "file_id": "f9", "file_name": "openapi.json",
     "locator": {"kind": "range", "sheet": "无行号"}, "render": "缺 rows 的 range",
     "order": 6},
    # ── fZ：星平面文件名。_expand / by_locator 的排序基准（码点 vs 码元）──
    {"chunk_id": "fZ:s0", "file_id": "fZ", "file_name": "\U0001f600.xlsx",
     "locator": {"kind": "cell", "sheet": "S", "row": 1, "col": "A"},
     "render": "供应商 星平面 文件名", "order": 0},
    {"chunk_id": "fZ:s1", "file_id": "fZ", "file_name": "￿.xlsx",
     "locator": {"kind": "cell", "sheet": "S", "row": 2, "col": "A"},
     "render": "供应商 BMP 末尾 文件名", "order": 1},
]

#: 重复 chunk_id 必须被 add 直接忽略（后写的不覆盖先写的）。
DUP_CHUNK = {"chunk_id": "f3:c0", "file_id": "f3", "file_name": "冒名顶替.xlsx",
             "locator": {}, "render": "这条不该进索引", "order": 99}


def build_index() -> EvidenceIndex:
    ix = EvidenceIndex()
    ix.add_all(Chunk(**c) for c in CHUNKS)
    ix.add(Chunk(**DUP_CHUNK))
    return ix


# ══════════════════════════════════════════════════════════════════
#  search 用例
# ══════════════════════════════════════════════════════════════════
#: (query, kwargs)。**所有用例的命中分数两两不同** —— 同分顺序在 Python 侧
#: 本来就不确定（见 tie_nondeterminism），拿它当期望值等于把随机数写进 golden。
SEARCH_CASES: list[tuple[str, dict[str, Any]]] = [
    ("clmContract 计划金额", {"top_k": 5, "expand": 0}),
    ("clmContract 计划金额", {"top_k": 5, "expand": 0, "diversify_by_file": False}),
    # 邻域扩展：命中 44 行要把 41/45 带出来
    ("clmContract", {"top_k": 1, "expand": 0}),
    ("clmContract", {"top_k": 1, "expand": 1}),
    ("clmContract", {"top_k": 1, "expand": 2}),
    ("clmContract", {"top_k": 1, "expand": 99}),  # 半径超出文件长度
    # 一个查询词都不含的切片绝不该出现（倒排候选集）
    ("供应商编码", {"top_k": 10, "expand": 0}),
    # 标签加权：同样的 render，只有 rule 那条该排前
    ("执行计划 采购包", {"top_k": 2, "expand": 0, "diversify_by_file": False}),
    # 按 kind 过滤
    ("plan_amount 计划金额", {"top_k": 5, "expand": 0, "kinds": ["ddl"]}),
    ("plan_amount 计划金额", {"top_k": 5, "expand": 0, "kinds": ["ddl", "json"]}),
    ("plan_amount 计划金额", {"top_k": 5, "expand": 0, "kinds": []}),  # 空集合 = 全挡
    # 按 tags 过滤（isdisjoint）
    ("采购", {"top_k": 9, "expand": 0, "tags": ["rule"]}),
    ("采购", {"top_k": 9, "expand": 0, "tags": ["rule", "fk"]}),
    ("采购", {"top_k": 9, "expand": 0, "tags": []}),
    # **按 file_id 过滤**（不是文件名！commit 30db2d1 的事故点）
    ("计划金额", {"top_k": 9, "expand": 0, "files": ["f3"]}),
    ("计划金额", {"top_k": 9, "expand": 0, "files": ["f3", "f5"]}),
    ("计划金额", {"top_k": 9, "expand": 0, "files": ["实体梳理.xlsx"]}),  # 名字 → 空
    ("计划金额", {"top_k": 9, "expand": 0, "files": []}),  # 空集合 = 全挡
    # 轮转取样：跨文件多样性（"计划金额"双口径就是靠这个被发现的）
    ("计划金额", {"top_k": 1, "expand": 0}),
    ("计划金额", {"top_k": 2, "expand": 0}),
    ("计划金额", {"top_k": 3, "expand": 0}),
    ("计划金额", {"top_k": 0, "expand": 0}),
    ("计划金额", {"top_k": 3, "expand": 0, "diversify_by_file": False}),
    # 预算截断：超预算的**跳过**（continue，不是 break），后面小的还能装
    ("采购", {"top_k": 9, "expand": 0, "budget_tokens": 8}),
    ("采购", {"top_k": 9, "expand": 0, "budget_tokens": 0}),
    ("采购", {"top_k": 9, "expand": 0, "budget_tokens": 10_000}),
    # 所属表/章节名不进 render，但要能被检索到
    ("供应商主数据", {"top_k": 3, "expand": 0}),
    ("采购流程", {"top_k": 3, "expand": 0}),
    ("订单域", {"top_k": 3, "expand": 0}),  # context 字段
    ("实体梳理", {"top_k": 3, "expand": 0}),  # 文件名
    # 空查询 / 无命中
    ("", {"top_k": 5}),
    ("   ", {"top_k": 5}),
    ("完全不存在的词", {"top_k": 5}),
    ("𠀀", {"top_k": 5}),  # 星平面：_TOKEN_RE 不匹配 → 空查询
    # 全角数字：Python 的 \d 认，JS 的不认
    ("１２３", {"top_k": 5}),
    # 星平面文件名的排序基准
    ("星平面 BMP 文件名", {"top_k": 4, "expand": 1}),
]


def run_search(ix: EvidenceIndex, query: str, kw: dict[str, Any]) -> dict[str, Any]:
    hits = ix.search(query, **kw)
    return {
        "query": query,
        "kwargs": kw,
        "ids": [c.chunk_id for c in hits],
        "cites": [c.cite() for c in hits],
        "tokens": [c.tokens for c in hits],
    }


# ══════════════════════════════════════════════════════════════════
#  by_locator 用例
# ══════════════════════════════════════════════════════════════════
BY_LOCATOR_CASES: list[dict[str, Any]] = [
    {},
    {"file": "实体梳理"},
    {"file": ".xlsx"},
    {"file": "不存在"},
    {"container": "业务对象"},
    {"container": "采购流程"},  # section
    {"container": "clm_contract"},  # object
    {"container": "供应商"},  # sheet 与 object 同时能命中
    {"rows": [40, 41]},
    {"rows": [44, 44]},
    {"rows": [80, 80]},  # range 切片的闭区间
    {"rows": [84, 84]},
    {"rows": [85, 85]},
    {"rows": [0, 0]},  # row=0 是假值 → span=None → 全过滤掉
    {"rows": [1, 2]},  # 星平面文件名那两条，验排序基准
    {"file": "实体梳理", "container": "业务对象", "rows": [41, 45]},
    {"limit": 3},
    {"limit": 0},
]


# ══════════════════════════════════════════════════════════════════
#  short_term
# ══════════════════════════════════════════════════════════════════
LOCATOR_TEXT_CASES = [
    "",
    "见 实体梳理.xlsx!业务对象实体梳理!R44C6 与 schema.ddl#clm_contract，"
    "另有 openapi.json 的 $.components.schemas.Plan，切片 f3:sheet0",
    "f3:sheet0:rows[40..48]",
    "clm_contract:L12-18",  # 没有已知后缀 → 只有 f\d+ / R\dC\d 那两支能捞
    "R44C6",
    "R44C6x",  # 尾部 \b 不成立
    "xR44C6",  # 头部 \b 不成立
    "见R44C6",  # **Python 的 \b 是 Unicode 语义**：见 是词字符 → 不匹配；JS 会匹配
    "见f3:sheet0",  # 同上
    "R４４C６",  # 全角数字：Python 的 \d 认
    "a.xlsx b.csv c.docx d.json e.ddl f.sql g.png h.pdf",
    "i.txt",  # 不在后缀白名单
    "报价单.xlsx",
    "报价单.xlsx!Sheet1",
    "报价单.xlsx:Sheet1",
    "报价单.xlsx#Sheet1",
    "报价单.xlsx?Sheet1",  # ? 不是分隔符 → 尾巴不进
    "见 报价单.xlsx!Sheet1，然后",  # 全角逗号是终止符
    "见 报价单.xlsx!Sheet1、然后",
    "见 报价单.xlsx!Sheet1)",
    "见 报价单.xlsx!Sheet1】",
    "见 报价单.xlsx!Sheet1;x",
    "报价单.xlsx!Sheet1 尾",  # NBSP：两边的 \s 都认
    "报价单.xlsx!Sheet1　尾",  # 表意空格：两边都认
    "报价单.xlsx!Sheet1\x85尾",  # NEL：Python 的 \s 认，JS 的不认
    "报价单.xlsx!Sheet1\x1c尾",  # 文件分隔符：Python 的 \s 认，JS 的不认
    "报价单.xlsx!Sheet1﻿尾",  # BOM：Python 的 \s **不**认，JS 的认
    "$.a.b[0].*",
    "$.",  # + 至少一个 → 不匹配
    "f0:a f12:b[3].c",
    "f:x",  # 缺数字
    "重复 R1C1 R1C1 R2C2 R1C1",  # 去重保序
    "计划金额.xlsx!表!R1C1 与 计划金额.xlsx!表!R1C1",
]

TURN_CASES = [
    {},
    {"thought": "想"},
    {"action": "做"},
    {"observation": "见"},
    {"thought": "t", "action": "a", "observation": "o"},
    {"thought": "推理" * 30, "action": "evidence.search(q='计划金额')",
     "observation": "命中 实体梳理.xlsx!业务对象实体梳理!R44C6"},
    {"thought": "", "action": "", "observation": "", "compressed": True},
    {"observation": "\U0001f600" * 10},
]

SUMMARY_CASES: list[list[dict[str, Any]]] = [
    [],
    [{"action": "a1", "observation": "观察一。观察二。"}],
    # 动作 > 8 / 观察 > 4：两边的截断位置
    [{"action": f"act{i}", "observation": f"观察{i}。后半句{i}"} for i in range(10)],
    # 无 action / 无 observation
    [{"thought": "只有想法"} for _ in range(3)],
    # 观察超 80 码点：`[:80]` 按码点切，emoji 用 JS 的 slice 会切半个代理对
    [{"action": "a", "observation": "\U0001f600" * 100}],
    [{"action": "a", "observation": "中" * 100}],
    [{"action": "a", "observation": "x" * 100}],
    # 观察第一句就超 80
    [{"action": "a", "observation": "前缀" + "\U0001f600" * 50 + "。尾巴"}],
]

#: 每个场景：一串 append，然后按顺序跑 ops，每步都拍快照。
SCRATCH_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "压缩后 locator 一条不少",
        "init": {"budget_tokens": 400, "keep_verbatim": 2},
        "appends": [
            {"thought": f"第 {i} 轮：检查金额口径 " + "补充说明" * 20,
             "action": f"evidence.search(q='计划金额 {i}')",
             "observation": f"命中 实体梳理.xlsx!业务对象实体梳理!R{40 + i}C6，口径含税年度"}
            for i in range(12)
        ],
        "ops": [["compact_to_fit", 0.7]],
    },
    {
        "name": "keep_verbatim 边界：head <= 1 不压",
        "init": {"budget_tokens": 10, "keep_verbatim": 2},
        "appends": [{"thought": f"t{i}", "action": f"a{i}", "observation": f"o{i}"}
                    for i in range(3)],
        "ops": [["compact"], ["compact"], ["compact"]],
    },
    {
        "name": "keep_verbatim=0：全部可压，但压过一次就没收益",
        "init": {"budget_tokens": 10, "keep_verbatim": 0},
        "appends": [{"thought": f"t{i}", "action": f"a{i}", "observation": f"o{i}"}
                    for i in range(4)],
        "ops": [["compact"], ["compact"], ["compact_to_fit", 0.7]],
    },
    {
        "name": "只有一轮：压不动",
        "init": {"budget_tokens": 1, "keep_verbatim": 6},
        "appends": [{"thought": "只此一轮"}],
        "ops": [["compact"], ["compact_to_fit", 0.7]],
    },
    {
        "name": "空 scratchpad",
        "init": {},
        "appends": [],
        "ops": [["compact"], ["compact_to_fit", 0.7]],
    },
    {
        "name": "没有 locator 时 render 不挂尾巴",
        "init": {},
        "appends": [{"thought": "纯文字", "action": "无位置", "observation": "也没有"}],
        "ops": [],
    },
    {
        "name": "只有 locator、没有可渲染正文",
        "init": {},
        "appends": [{"thought": "", "action": "", "observation": "R44C6"}],
        "ops": [],
    },
    {
        "name": "locator 超 40 条：render 只贴前 40",
        "init": {"budget_tokens": 100000},
        "appends": [{"observation": f"R{i}C1"} for i in range(1, 70)],
        "ops": [],
    },
    {
        "name": "emoji：digest 截断按码点",
        "init": {"budget_tokens": 500, "keep_verbatim": 2},
        "appends": [{"thought": "推理" * 40, "action": "\U0001f600" * 20,
                     "observation": "观察" * 40} for _ in range(6)],
        "ops": [["compact_to_fit", 0.5]],
    },
    {
        "name": "threshold 边界：正好等于不算超",
        "init": {"budget_tokens": 100, "keep_verbatim": 1},
        "appends": [{"observation": "x" * 40} for _ in range(6)],
        "ops": [["compact_to_fit", 1.0], ["compact_to_fit", 0.1]],
    },
]

#: digest 的截断循环：`len(text) > 80` 与 `int(len*0.8)` 的每一档
DIGEST_MAX_TOKENS = [600, 200, 60, 20, 5, 1, 0]

WORKING_SET_CASES: list[dict[str, Any]] = [
    {
        "name": "通配 fan-out",
        "puts": [["PARSE.xlsx", {"n": 1}, None], ["PARSE.docx", {"n": 2}, None],
                 ["PARSE.ddl", {"n": 3}, None], ["ALIGN", {"n": 4}, {"turns": 2}]],
        "selects": [["PARSE.*"], ["PARSE.*", "ALIGN"], ["ALIGN"], ["NOPE"],
                    ["PARSE.xlsx"], [".*"], ["*"], []],
        "gets": ["ALIGN", "NOPE"],
    },
    {
        "name": "digest 为假值时不写 digests",
        "puts": [["A", 1, None], ["B", 2, {}], ["C", 3, {"turns": 0}]],
        "selects": [["A", "B", "C"]],
        "gets": ["A", "B", "C"],
    },
    {
        "name": "同 key 覆盖",
        "puts": [["A", {"v": 1}, {"d": 1}], ["A", {"v": 2}, None]],
        "selects": [["A"]],
        "gets": ["A"],
    },
    {
        "name": "tokens：中文 + 嵌套 + 小数",
        "puts": [["A", {"名称": "采购合同", "行": [1, 2, 3], "比例": 0.5}, None],
                 ["B", "纯字符串", None]],
        "selects": [["A", "B"]],
        "gets": ["A"],
    },
    {
        "name": "tokens：整数值的 float（已知分叉）",
        "puts": [["A", {"x": 1.0}, None]],
        "selects": [["A"]],
        "gets": ["A"],
    },
    {
        "name": "空",
        "puts": [],
        "selects": [["PARSE.*"]],
        "gets": ["X"],
    },
]


def turn_dict(t: Turn) -> dict[str, Any]:
    return {"thought": t.thought, "action": t.action, "observation": t.observation,
            "compressed": t.compressed, "tokens": t.tokens, "render": t.render()}


def pad_snapshot(pad: Scratchpad) -> dict[str, Any]:
    return {
        "len": len(pad),
        "turns": [turn_dict(t) for t in pad.turns],
        "locators": pad.locators,
        "tokens": pad.tokens,
        "compactions": pad.compactions,
        "render": pad.render(),
        "over_budget": [
            {"threshold": th, "out": pad.over_budget(th)} for th in (0.0, 0.5, 0.7, 1.0, 2.0)
        ],
        "digest": [
            {"max_tokens": mt, "out": pad.digest(max_tokens=mt)} for mt in DIGEST_MAX_TOKENS
        ],
    }


def main() -> None:
    out: dict[str, Any] = {}
    ix = build_index()

    # ── evidence ──────────────────────────────────────────────
    out["tokenize"] = [{"in": t, "out": tokenize(t)} for t in TOKENIZE_CASES]

    out["chunks"] = CHUNKS
    out["dup_chunk"] = DUP_CHUNK
    out["chunk_meta"] = [
        {"chunk_id": c.chunk_id, "cite": c.cite(), "tokens": c.tokens}
        for c in ix.all_chunks()
    ]

    # 索引内部状态：add() 的每一处（去重、df、len、倒排、avg_len）都被它钉住。
    # 只导出确定性的部分 —— set 一律不进。
    out["index_state"] = {
        "len": len(ix),
        "ids": [c.chunk_id for c in ix.all_chunks()],
        "doc_len": {cid: ix._len[cid] for cid in ix._len},          # noqa: SLF001
        "df": dict(ix._df),                                          # noqa: SLF001
        "avg_len": ix._avg_len,                                      # noqa: SLF001
        "postings": {t: list(v) for t, v in ix._postings.items()},   # noqa: SLF001
        "by_file": {f: list(v) for f, v in ix._by_file.items()},     # noqa: SLF001
        "file_names": ix.file_names(),
        "by_file_api": {f: [c.chunk_id for c in ix.by_file(f)]
                        for f in ("f3", "f5", "f7", "f9", "fZ", "不存在")},
        "get": {cid: (ix.get(cid).chunk_id if ix.get(cid) else None)
                for cid in ("f3:c0", "不存在")},
    }

    out["search"] = [run_search(ix, q, kw) for q, kw in SEARCH_CASES]

    # rerank 钩子：拿到的是排好序的命中，返回什么就是什么（且在预算截断**之前**跑）
    out["rerank"] = {
        "reversed": [c.chunk_id for c in ix.search(
            "计划金额", top_k=3, expand=0, rerank=lambda q, hits: list(reversed(hits)))],
        "dropped": [c.chunk_id for c in ix.search(
            "计划金额", top_k=3, expand=0, rerank=lambda q, hits: hits[:1])],
        "before_budget": [c.chunk_id for c in ix.search(
            "采购", top_k=9, expand=0, budget_tokens=8,
            rerank=lambda q, hits: list(reversed(hits)))],
    }

    out["by_locator"] = [
        {"kwargs": kw,
         "ids": [c.chunk_id for c in ix.by_locator(
             file=kw.get("file", ""), container=kw.get("container", ""),
             rows=tuple(kw["rows"]) if "rows" in kw else None,  # type: ignore[arg-type]
             limit=kw.get("limit", 60))]}
        for kw in BY_LOCATOR_CASES
    ]

    out["render"] = {
        "empty": EvidenceIndex.render([]),
        "one": EvidenceIndex.render(ix.by_file("f5")[:1]),
        "many": EvidenceIndex.render(ix.by_file("f3")),
    }

    # ── 同分顺序：Python 自己就不确定 ────────────────────────────
    # `sorted(scores, key=-score)` 是稳定排序 → 同分保持 `scores` 的插入序 →
    # 那个插入序来自遍历 `candidates`（一个 **set**）→ 随 PYTHONHASHSEED 变。
    # 这不是"TS 要对齐的行为"，而是"Python 侧没有可对齐的行为"。TS 侧固定成
    # 倒排遍历序（确定），这一节只把事实钉在这里，免得后人拿某一次的输出当真相。
    tie = EvidenceIndex()
    for i, n in enumerate(["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"]):
        tie.add(Chunk(chunk_id=n, file_id="f", file_name="x", locator={},
                      render="采购 合同", order=i))
    # 这一节**故意不导出顺序**：导出来就是把某一次的随机结果写成"真相"。
    # 实测 PYTHONHASHSEED ∈ {0,1,42,777,99999} 五次跑出五种不同顺序，而整份
    # golden 的其余部分逐字节相同 —— 也就是说除了同分，两边都是可对齐的。
    out["tie_nondeterminism"] = {
        "note": "同分条目的顺序在 Python 侧随 PYTHONHASHSEED 变（实测 5 个种子 5 种顺序），"
                "所以没有可对齐的期望值。TS 侧固定为倒排遍历序，本节只校验集合与条数。",
        "chunks": ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"],
        "query": "采购 合同",
        "sorted_ids": sorted(c.chunk_id for c in tie.search(
            "采购 合同", top_k=8, expand=0, diversify_by_file=False)),
    }

    # ── short_term ────────────────────────────────────────────
    st: dict[str, Any] = {}
    st["extract_locators"] = [{"in": t, "out": extract_locators(t)}
                              for t in LOCATOR_TEXT_CASES]
    st["turn"] = [{"init": init, "out": turn_dict(Turn(**init))} for init in TURN_CASES]
    st["heuristic_summary"] = [
        {"turns": ts, "out": heuristic_summary([Turn(**t) for t in ts])}
        for ts in SUMMARY_CASES
    ]

    scen_out = []
    for sc in SCRATCH_SCENARIOS:
        pad = Scratchpad(**sc["init"])
        for a in sc["appends"]:
            pad.append(**a)
        steps = []
        for op in sc["ops"]:
            name, *args = op
            ret = getattr(pad, name)(*args)
            steps.append({"op": name, "args": args, "ret": ret,
                          "snapshot": pad_snapshot(pad)})
        scen_out.append({"name": sc["name"], "init": sc["init"], "appends": sc["appends"],
                         "after_append": None, "steps": steps})
    # after_append 要在跑 ops 之前拍，重跑一遍拿干净的
    for sc, rec in zip(SCRATCH_SCENARIOS, scen_out, strict=True):
        pad = Scratchpad(**sc["init"])
        for a in sc["appends"]:
            pad.append(**a)
        rec["after_append"] = pad_snapshot(pad)
    st["scratchpad"] = scen_out

    ws_out = []
    for case in WORKING_SET_CASES:
        ws = WorkingSet()
        for nid, output, digest in case["puts"]:
            ws.put(nid, output, digest)
        ws_out.append({
            "name": case["name"],
            "puts": case["puts"],
            "outputs": ws.outputs,
            "digests": ws.digests,
            "output_keys": list(ws.outputs),
            "selects": [{"ids": ids, "out": ws.select(ids), "keys": list(ws.select(ids))}
                        for ids in case["selects"]],
            "gets": [{"id": nid, "out": ws.get(nid), "default": ws.get(nid, "缺省")}
                     for nid in case["gets"]],
            # tokens 走 json.dumps(ensure_ascii=False, default=str) —— 分隔符是
            # ", " / ": "，不是 JSON.stringify 的紧凑形态。把那串也导出来，
            # TS 侧才能定位差在哪一位。
            "json": json.dumps(ws.outputs, ensure_ascii=False, default=str),
            "tokens": ws.tokens,
        })
    st["working_set"] = ws_out

    out["short_term"] = st

    p = OUT / "memory.evidence.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  memory.evidence.json  {p.stat().st_size} B")


if __name__ == "__main__":
    main()
