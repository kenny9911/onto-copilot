"""shape 模块的补充 golden —— 输入 + 更多形态的输出。

``tools/export_golden.py`` 已经导了四种表的 ``infer_shape`` / ``structural_extract``
结果，但**没有导输入行**。TS 侧要么照抄一遍输入（抄错了就是在拿错误的输入比对
正确的输出，红不了也绿不对），要么从这里读 —— 所以第一件事是把那四份输入原样
落进 golden。

第二件事是补 Python 测试覆盖到、而 export_golden 没导的形态，以及 TS 侧**独有**
的风险：

  · ``round(x, n)`` 是 half-even 且作用在二进制精确值上，JS 的
    ``toFixed`` / ``Math.round(x*1e3)`` 都不是 —— ``rounding`` 用例故意把
    fill / distinct_ratio / mean_len 全部凑成精确的 .5 结尾（1/16、25/4）；
  · ``\\d`` 在 Python 里认全角数字，JS 不认 —— ``split_options`` 里有一条全角的；
  · ``str(v)`` 对 None / bool 的写法（"None" / "True"）—— ``nonstring`` 用例。

跑法::

    .venv/bin/python tools/golden/shape.py

输出 ``golden/shape.extra.json``（新文件，不碰 ``golden/shape.json``）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.shape import (  # noqa: E402
    base_type_of,
    infer_shape,
    looks_like_question,
    split_options,
    structural_extract,
)


def cites(rows: list[dict[str, Any]]) -> list[str]:
    return [f"x.xlsx!Sheet1!R{i + 2}-{i + 2}" for i in range(len(rows))]


# ── export_golden.py 里那四份输入，一字不改地搬过来 ──────────────
REGISTRY = [
    {"应用模块": "采购计划管理", "业务对象": "采购需求计划",
     "实体编码": "pbpHeader", "实体名称": "采购业务计划头"},
    {"应用模块": "采购计划管理", "业务对象": "", "实体编码": "pbpLine",
     "实体名称": "采购业务计划行"},
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
SURVEY = [{"节点": "（1）编制集采计划" if i == 0 else "", "编号": str(i + 1),
           "澄清问题": "集采计划是在系统里编的，还是线下编好只录结果？",
           "参考选项": "① 全线下 ② 系统里编 ③ 线下编、系统里审",
           "答复": ""} for i in range(8)]


# ── 补充形态 ──────────────────────────────────────────────────
# 一段散文：长文本列压过一切结构列 → row_unit=rule
PROSE = [{"序号": str(i + 1),
          "规则": f"采购需求计划提交后，若金额超过 {i} 万元，需要走二级审批；"
                  f"未走完审批的计划不允许下达给供应商。"} for i in range(5)]

# 只有名称列：没有编码也没有类型
LABEL_ONLY = [{"名称": f"业务对象{i}"} for i in range(6)]

# 一两行立不起形状
TOO_FEW = [{"作者": "张三", "路径": "/tmp/a.xlsx"},
           {"作者": "李四", "路径": "/tmp/b.xlsx"}]

# 稀疏分组列的判据是**第一行有值**（合并单元格的结构特征），不是填充率。
# 两份输入只差组名写在第 0 行还是第 1 行，判定必须相反。
SPARSE_HEAD = [{"分组": {0: "甲组", 4: "乙组"}.get(i, ""),
                "编码": f"objA{i}", "名称": f"对象甲{i}"} for i in range(8)]
SPARSE_NOHEAD = [{"分组": {1: "甲组", 4: "乙组"}.get(i, ""),
                  "编码": f"objB{i}", "名称": f"对象乙{i}"} for i in range(8)]

# 两层分组：粗的（应用域，2 个取值）套细的（业务对象，4 个取值）。
# 宿主取**取值最多**的那一层，粗的那层落到 module。
TWO_LEVEL = [{"应用域": ["采购域", "供应商域"][i // 8] if i % 8 == 0 else "",
              "业务对象": f"对象{i // 4}" if i % 4 == 0 else "",
              "实体编码": f"entC{i}", "实体名称": f"实体丙{i}"} for i in range(16)]

# 一张表被切成两段：形状按**整张表**推（pipeline 的 _window_shape 就是这么干的），
# 抽取只跑后半段 —— 后半段的组首落在前半段里，全靠 carry_in 补。
CARRY_WHOLE = [{"业务对象": "采购需求计划" if i == 0 else "",
                "实体编码": f"headD{i}", "实体名称": f"头行{i}"} for i in range(6)] + [
              {"业务对象": "", "实体编码": f"tailD{i}", "实体名称": f"尾行{i}"}
              for i in range(6)]
CARRY_TAIL = CARRY_WHOLE[6:]

# 字段表的同一件事：合并单元格的「所属对象」只在整表的组首写了一次
FIELD_CARRY_WHOLE = [{"所属对象": "pbpHeader" if i == 0 else "",
                      "字段名": f"colJ{i}", "类型": _TYPES[i % 6],
                      "口径": f"第 {i} 个字段的口径说明"} for i in range(12)]
FIELD_CARRY_TAIL = FIELD_CARRY_WHOLE[6:]

# 两个标识符列 → LINKS
LINKS = [{"主表编码": f"mainE{i}", "从表编码": f"lineE{i}",
          "名称": f"关系{i}"} for i in range(6)]

# 没有编码列的行动表 —— api_name 要从路径反推动词（_action_name）
ACTION_NOCODE = [{"业务对象": "采购订单" if i == 0 else "",
                  "功能名称": f"功能{i}",
                  "接口": p} for i, p in enumerate([
                      "/api/v1/order/createOrder",
                      "/api/v1/order/updateOrder",
                      "/api/v1/order/deleteOrder",
                      "/api/v1/order/exportOrder",
                      "/api/v1/order/listOrder",
                  ])]

# 中英混填的类型列：两种写法各占一半，谁都不过 0.6
MIXED_TYPE = [{"所属对象": "poHeader", "字段名": f"colF{i}",
               "数据类型": ["varchar(32)", "字符型", "数值类型", "日期",
                            "decimal(18,2)", "整型"][i % 6],
               "说明": f"第 {i} 列"} for i in range(12)]

# 列名自称是类型列、取值多半是词表外的自造词（type_frac 只有 1/3）→ 走 0.3 那一支。
# CUSTOM_TYPE_UNNAMED 的取值一模一样，只把列名换掉 —— 判定必须相反，
# 这一对钉住的是"列名自称"只在**取值又短又高度重复**时才降阈值。
_CUSTOM_VALS = ["短文本", "长整数", "自定义编码", "短文本", "date", "int"]
CUSTOM_TYPE = [{"所属对象": "custHeader", "字段名": f"colG{i}",
                "字段类型": _CUSTOM_VALS[i % 6],
                "说明": f"第 {i} 列"} for i in range(12)]
CUSTOM_TYPE_UNNAMED = [{"所属对象": "custHeader", "字段名": f"colG{i}",
                        "特征": _CUSTOM_VALS[i % 6],
                        "说明": f"第 {i} 列"} for i in range(12)]

# 登记表 + 一列长文本 → 散文列在任何形状下都可能藏规则，RULES 要额外加上
OBJECT_WITH_PROSE = [
    {"实体编码": f"objK{i}", "实体名称": f"对象丁{i}",
     "职责说明": f"这个对象承载第 {i} 段业务的主数据，负责记录采购过程中的关键信息，"
                 f"并在审批通过后对下游系统开放查询。"} for i in range(6)]

# 只有一列是满的：问卷的第 2 个信号（除答复外至少两列填满）不成立
SURVEY_ONE_DENSE = [
    {"节点": "（1）编制计划" if i == 0 else "",
     "澄清问题": f"第 {i} 个环节是否需要二级审批？",
     "答复": ""} for i in range(6)]

# 字段表 + 一列全空的备注 + 一列问句式口径：四个问卷信号全中，
# 但**数据类型列压过一切**，必须仍然判成字段表
FIELD_LOOKS_LIKE_SURVEY = [
    {"所属对象": "pbpHeader", "字段名": f"colH{i}", "类型": _TYPES[i % 6],
     "口径": "这个字段是否必填？金额是否含税？请确认口径。",
     "备注": ""} for i in range(10)]

# 问卷：混着分组标题行（长度不足 6，必须丢掉）和一条已填答复
SURVEY_MIXED = [
    {"节点": "（1）编制计划", "编号": "1",
     "澄清问题": "计划是否需要二级审批？", "参考选项": "① 需要 ② 不需要",
     "答复": ""},
    {"节点": "", "编号": "2", "澄清问题": "小计", "参考选项": "", "答复": ""},
    {"节点": "", "编号": "3", "澄清问题": "供应商准入是否有黑名单？",
     "参考选项": "不该被拆开的一句完整的话", "答复": ""},
    {"节点": "（2）执行", "编号": "4", "澄清问题": "合同变更是否要重新走审批？",
     "参考选项": "① 要 ② 不要 ③ 视金额而定", "答复": ""},
    {"节点": "", "编号": "5", "澄清问题": "到货验收是否分批？",
     "参考选项": "① 分批 ② 不分批", "答复": ""},
    {"节点": "", "编号": "6", "澄清问题": "付款条件是否按供应商分级？",
     "参考选项": "① 分级 ② 统一", "答复": ""},
]

# 非字符串单元格：None / int / bool 各来一个。
# 浮点故意不放 —— JSON 往返之后 1.0 在 JS 里就是 1，输入本身就传不过去。
NONSTRING = [{"编码": f"objI{i}", "名称": f"对象{i}",
              "序号": i + 1, "启用": bool(i % 2), "备注": None}
             for i in range(6)]

# round(x, n) 的 half-even：fill=1/16、distinct_ratio=1/16、mean_len=25/4
# 全部是精确的二进制值且正好落在 .5 上 —— JS 的 toFixed 会朝上进位，分叉。
ROUNDING = [{"稀疏": "组一" if i == 0 else "",
             "四个": ["长度六个字啊", "另一个六字串", "第三个六字串", "第四个七字串符"][i]
                     if i < 4 else "",
             "满列": "同一个值"} for i in range(16)]


# ── 阈值的边界对 ────────────────────────────────────────────────
# 每一对都卡在判据的临界点上：改动任何一个阈值，这一对里必有一个翻面。
# 没有它们，"把 0.5 改成 0.6" 这种改动能全绿地溜过去（试过，真的溜过去了）。

# _PROSE_LEN = 30：平均长度 31 是散文，30 还是名称
PROSE_EDGE = [{"长31": "一" * 30 + str(i), "长30": "二" * 29 + str(i)}
              for i in range(6)]

# type_frac >= 0.5：列名**不**自称是类型列，只能靠取值过线
TYPE_HALF = [{"字段名": f"colM{i}", "格式": v} for i, v in enumerate(
    ["varchar(32)", "int", "date", "甲", "乙", "丙"])]
TYPE_BELOW = [{"字段名": f"colN{i}", "格式": v} for i, v in enumerate(
    ["varchar(32)", "int", "甲", "乙", "丙"])]

# URL 判据 0.6、布尔判据 0.8、标识符判据 0.8 与 dratio 0.7
URLISH_EDGE = [{"接口A": a, "接口B": b} for a, b in zip(
    ["/api/v1/a", "/api/v1/b", "/api/v1/c", "甲", "乙"],
    ["/api/v1/a", "/api/v1/b", "甲", "乙", "丙"], strict=True)]
BOOL_EDGE = [{"必填A": a, "必填B": b} for a, b in zip(
    ["是", "否", "是", "否", "甲"],
    ["是", "否", "是", "甲", "乙"], strict=True)]
IDENT_EDGE = [{"码A": a, "码B": b, "码C": c, "码D": d} for a, b, c, d in zip(
    ["aa", "bb", "cc", "dd", "ee"],            # 全是标识符、几乎不重复
    ["aa", "aa", "bb", "bb", "cc"],            # 标识符但重复率高 → 枚举
    ["aa", "bb", "cc", "dd", "甲乙"],          # 4/5 = 0.8，刚好过线
    ["aa", "bb", "cc", "甲乙", "丙丁"],        # 3/5 = 0.6，过不了
    strict=True)]

# ident.fill >= 0.6：填 6/10 是登记表（规则可定），填 5/10 就只剩名称那一支
IDENT_FILL_06 = [{"编码": f"objP{i}" if i < 6 else "", "名称": f"对象戊{i}"}
                 for i in range(10)]
IDENT_FILL_05 = [{"编码": f"objQ{i}" if i < 5 else "", "名称": f"对象己{i}"}
                 for i in range(10)]

# _HOST_MAX_LEN = 24：宿主列的取值长 24 还认，长 25 就当口径说明不认了
HOST_LEN_24 = [{"所属对象": "宿" * 24, "字段名": f"colR{i}", "类型": _TYPES[i % 6]}
               for i in range(12)]
HOST_LEN_25 = [{"所属对象": "宿" * 25, "字段名": f"colS{i}", "类型": _TYPES[i % 6]}
               for i in range(12)]

# _MIN_QUESTION_LEN = 6：6 个字的问题留，5 个字的当分组标题丢
QUESTION_LEN_EDGE = [
    {"节点": "（1）编制计划" if i == 0 else "", "编号": str(i + 1),
     "澄清问题": ["是否要审批吗", "是否要审批",
                  "集采计划是否需要在系统里编制并审批？"][min(i, 2)],
     "参考选项": "① 要 ② 不要", "答复": ""} for i in range(6)]


def _survey_edge(blank_filled: int) -> list[dict[str, Any]]:
    """问卷四信号的数值边界一次全钉住：

    答复列 fill 恰好 0.05、节点列 fill 恰好 0.9、问句列 mean_len 恰好 8、
    参考选项列命中率恰好 0.4。``blank_filled`` 一加到 2，答复列就是 0.1，
    第 1 个信号不成立 —— 整张表立刻不是问卷。
    """
    return [{"节点": f"（{i // 5 + 1}）环节" if i % 5 == 0 and i < 18 else
             ("已填节点" if i < 18 else ""),
             "编号": str(i + 1),
             "澄清问题": "是否需要二级审批",          # 恰好 8 个字
             "参考选项": "① 要 ② 不要" if i < 8 else "",
             "答复": "已答复" if i < blank_filled else ""} for i in range(20)]


# 「列名自称是类型列」那一支的下界 0.3：命中率 0.25，还是不认
TYPE_NAMED_LOW = [{"字段名": f"colT{i}",
                   "数据类型": ["短文本", "长整数", "自定义编码", "date"][i % 4]}
                  for i in range(12)]

# 各判据"差一点点"的那一侧：0.5 的 URL、0.75 的布尔、0.75 的标识符
NEAR_MISS = [{"接口": u, "必填": b, "编码": c} for u, b, c in zip(
    ["/api/v1/a", "/api/v1/b", "甲乙丙", "丁戊己"],       # 0.5，够不着 0.6
    ["是", "否", "是", "甲"],                              # 0.75，够不着 0.8
    ["aa", "bb", "cc", "甲乙"],                            # 0.75，够不着 0.8
    strict=True)]

# 问卷的两条计数信号，各卡在"差一点"的那一侧
SURVEY_DENSE_085 = [{"澄清问题": "是否需要二级审批", "半满": "有值" if i < 17 else "",
                     "答复": ""} for i in range(20)]
SURVEY_QFRAC_04 = [{"澄清问题": "是否需要二级审批" if i % 5 < 2 else "本环节由采购员发起",
                    "说明列": "本环节由采购员发起并记录", "答复": ""} for i in range(20)]
# 两列全空 —— 答复槽必须取**最右**那一列
SURVEY_TWO_BLANKS = [{"备注": "", "编号": str(i + 1),
                      "澄清问题": "是否需要二级审批", "答复": ""} for i in range(8)]

# 名称列填不到一半就不参与 display_name —— 且第一行空着，不会被提成分组列
LABEL_SPARSE_045 = [{"编码": f"objU{i}",
                     "名称": f"对象庚{i}" if 1 <= i <= 9 else ""} for i in range(20)]

# 稀疏枚举列不是模块列（模块要满填充），而这里没有分组列可退而求其次
MODULE_SPARSE_ENUM = [{"分类": "甲类" if i < 10 else "", "编码": f"objV{i}",
                       "名称": f"对象辛{i}"} for i in range(20)]

# 填到 0.7 的名称列不算合并单元格的分组列（上界 0.6）
SPARSE_07 = [{"编码": f"objW{i}", "名称": f"对象壬{i}",
              "分组": f"组{i}" if i < 7 else ""} for i in range(10)]

# 字段名取**去重率**最高的那列，不是填充率最高的那列 ——
# 这里去重率最高的恰好是稀疏的宿主列，于是整张表选不出宿主，一行都不抽
FIELD_DRATIO_PICK = [{"所属对象": "宿主甲" if i == 0 else "",
                      "字段名": f"colX{min(i, 10)}", "类型": _TYPES[i % 6]}
                     for i in range(12)]

# 两个分组列重复度一样时，优先"组首就填了"的那个（合并单元格一定从第一行开始）。
# 列序故意把没填组首的放在左边 —— 不看 first_filled 就会选错。
HOST_TIE = [{"左分组": "" if i == 0 else ("y1" if i < 6 else "y2"),
             "右分组": "x1" if i < 6 else "x2",
             "字段名": f"colY{i}", "类型": _TYPES[i % 6]} for i in range(12)]


# definition 取**最长**的那一列（口径），短的只当兜底
NOTES_PICK = [{"所属对象": "pbpHeader", "字段名": f"colZ{i}", "类型": _TYPES[i % 6],
               "中文名": f"字段{i}",
               "口径": ("金额按含税口径统计，时间粒度为自然月，币种统一折算为人民币。"
                        if i % 2 == 0 else ""),
               "备注": f"备注{i}"} for i in range(12)]
# 平均长度不足 2 的列不算口径候选（一个字的「√」不是口径）
NOTES_MINLEN = [{"所属对象": "pbpHeader", "字段名": f"colAA{i}", "类型": _TYPES[i % 6],
                 "口径": ("金额按含税口径统计，时间粒度为自然月，币种统一折算为人民币。"
                          if i % 2 == 0 else ""),
                 "单字": "甲"} for i in range(12)]

# 问卷段**必须直接返回**：这一张同时有一列长文本，落到后面的兜底就会多出 RULES
SURVEY_WITH_PROSE = [
    {"节点": "（1）编制计划" if i == 0 else "", "编号": str(i + 1),
     "澄清问题": "集采计划是否需要在系统里编制并审批？",
     "说明": "本环节由采购员发起，经部门负责人复核后进入审批流，全程留痕并可追溯。",
     "答复": ""} for i in range(8)]

# 散文列不占多数时不是规则段：1 列散文 + 2 列结构 → 还是对象
PROSE_MINORITY = [{"分类": "甲类", "名称": f"对象癸{i}",
                   "说明": f"本对象记录第 {i} 段采购过程中的关键主数据，供下游系统"
                           f"查询、对账与审计使用，任何变更都要留痕。"}
                  for i in range(6)]

# 「必填」列写成 √／× 的表 —— 词表里少一个符号，整列必填就全变 false
REQUIRED_CHECK = [{"所属对象": "pbpHeader", "字段名": f"colAB{i}",
                   "类型": _TYPES[i % 6], "必填": "√" if i % 2 else "×"}
                  for i in range(12)]


# 键存在但值是 None：Python 的 str(None) 是 "None"，不是空串 ——
# 这一格会原样变成 display_name，看着荒唐，但那就是 Python 侧的产物
NULL_CELL = [{"编码": f"objAC{i}", "名称": None if i in (3, 7) else f"对象子{i}"}
             for i in range(10)]

# 不是字典的行整行跳过，但**仍然占一个行数**（fill 的分母是 len(rows)）
JUNK_ROWS: list[Any] = [{"编码": f"objAD{i}", "名称": f"对象丑{i}"} for i in range(5)]
JUNK_ROWS = JUNK_ROWS[:2] + [["不是字典"], None, "字符串也不是"] + JUNK_ROWS[2:]

# 同一个编码出现多次 —— 对象只登记一次
DUP_OBJECTS = [{"编码": f"objAE{i if i < 8 else i - 8}",
                "名称": f"对象寅{i if i < 8 else i - 8}"} for i in range(10)]

# 路径里有两个动词段：取**最靠后**的那个（exportOrder，不是 create）
ACTION_TWO_VERBS = [{"业务对象": "采购订单" if i == 0 else "", "功能名称": f"功能{i}",
                     "接口": u} for i, u in enumerate([
                         "/api/create/order/exportOrder",
                         "/api/create/order/{id}/deleteOrder",
                         "/api/update/order/approveOrder",
                         "/api/v1/order/somethingElse",
                         # {} 里的路径参数整段跳过 —— 不跳的话这条会被
                         # 「{createId}」骗成 create
                         "/api/order/{createId}/queryOrder",
                     ])]


CASES: list[dict[str, Any]] = [
    {"name": "registry", "rows": REGISTRY},
    {"name": "actions", "rows": ACTIONS},
    {"name": "fields", "rows": FIELDS},
    {"name": "survey", "rows": SURVEY},
    {"name": "prose", "rows": PROSE},
    {"name": "label_only", "rows": LABEL_ONLY},
    {"name": "too_few", "rows": TOO_FEW},
    {"name": "sparse_head", "rows": SPARSE_HEAD},
    {"name": "sparse_nohead", "rows": SPARSE_NOHEAD},
    {"name": "two_level", "rows": TWO_LEVEL},
    {"name": "carry_tail", "rows": CARRY_TAIL, "shape_rows": CARRY_WHOLE,
     "carry_in": {"业务对象": "采购需求计划"}},
    {"name": "carry_tail_none", "rows": CARRY_TAIL, "shape_rows": CARRY_WHOLE},
    {"name": "field_carry_tail", "rows": FIELD_CARRY_TAIL,
     "shape_rows": FIELD_CARRY_WHOLE, "carry_in": {"所属对象": "pbpHeader"}},
    {"name": "field_carry_tail_none", "rows": FIELD_CARRY_TAIL,
     "shape_rows": FIELD_CARRY_WHOLE},
    {"name": "links", "rows": LINKS},
    {"name": "action_nocode", "rows": ACTION_NOCODE},
    {"name": "mixed_type", "rows": MIXED_TYPE},
    {"name": "custom_type", "rows": CUSTOM_TYPE},
    {"name": "custom_type_unnamed", "rows": CUSTOM_TYPE_UNNAMED},
    {"name": "object_with_prose", "rows": OBJECT_WITH_PROSE},
    {"name": "survey_one_dense", "rows": SURVEY_ONE_DENSE},
    {"name": "field_looks_like_survey", "rows": FIELD_LOOKS_LIKE_SURVEY},
    {"name": "survey_mixed", "rows": SURVEY_MIXED},
    {"name": "nonstring", "rows": NONSTRING},
    {"name": "rounding", "rows": ROUNDING},
    # 空输入：一列都没有，row_count=0
    {"name": "empty", "rows": []},
    # 阈值边界
    {"name": "prose_edge", "rows": PROSE_EDGE},
    {"name": "type_half", "rows": TYPE_HALF},
    {"name": "type_below", "rows": TYPE_BELOW},
    {"name": "urlish_edge", "rows": URLISH_EDGE},
    {"name": "bool_edge", "rows": BOOL_EDGE},
    {"name": "ident_edge", "rows": IDENT_EDGE},
    {"name": "ident_fill_06", "rows": IDENT_FILL_06},
    {"name": "ident_fill_05", "rows": IDENT_FILL_05},
    {"name": "host_len_24", "rows": HOST_LEN_24},
    {"name": "host_len_25", "rows": HOST_LEN_25},
    {"name": "question_len_edge", "rows": QUESTION_LEN_EDGE},
    {"name": "survey_edge", "rows": _survey_edge(1)},
    {"name": "survey_edge_over", "rows": _survey_edge(2)},
    {"name": "type_named_low", "rows": TYPE_NAMED_LOW},
    {"name": "near_miss", "rows": NEAR_MISS},
    {"name": "survey_dense_085", "rows": SURVEY_DENSE_085},
    {"name": "survey_qfrac_04", "rows": SURVEY_QFRAC_04},
    {"name": "survey_two_blanks", "rows": SURVEY_TWO_BLANKS},
    {"name": "label_sparse_045", "rows": LABEL_SPARSE_045},
    {"name": "module_sparse_enum", "rows": MODULE_SPARSE_ENUM},
    {"name": "sparse_07", "rows": SPARSE_07},
    {"name": "field_dratio_pick", "rows": FIELD_DRATIO_PICK},
    {"name": "host_tie", "rows": HOST_TIE},
    {"name": "notes_pick", "rows": NOTES_PICK},
    {"name": "notes_minlen", "rows": NOTES_MINLEN},
    {"name": "survey_with_prose", "rows": SURVEY_WITH_PROSE},
    {"name": "prose_minority", "rows": PROSE_MINORITY},
    {"name": "required_check", "rows": REQUIRED_CHECK},
    {"name": "null_cell", "rows": NULL_CELL},
    {"name": "junk_rows", "rows": JUNK_ROWS},
    {"name": "dup_objects", "rows": DUP_OBJECTS},
    {"name": "action_two_verbs", "rows": ACTION_TWO_VERBS},
    # cites 比 rows 短：zip 在短的那一头停（strict=False）
    {"name": "cites_short", "rows": REGISTRY, "cites_take": 3},
]

_SPLIT = [
    "① 全线下 ② 系统里编 ③ 线下编、系统里审",
    "1. 固定周期 2. 到期前 3. 人工发起",
    "一句不该被拆开的完整的话",
    "(1) 甲方 (2) 乙方",
    "（1）甲方（2）乙方（3）丙方",
    "A) 现金 B) 承兑",
    "甲；乙；丙",
    "甲\n乙",
    "① 只有一个标记",
    "",
    "   ",
    "１. 全角一 ２. 全角二",       # Python 的 \d 认全角数字，JS 的不认
    "❶ 圈一 ❷ 圈二",
    "1. 只有一段",
    "① 甲；乙",          # 只有一个标记：走分号那一支，标记留在原处
]

_QUESTIONS = [
    "集采计划是在系统里编的？", "是否需要二级审批", "订单", "小计",
    "多少钱", "请确认口径", "这是一句陈述句", "有没有黑名单", "问题吗",
    "  带空白的问题？  ",
]

_BASE_TYPES = [
    "varchar(64)", "VARCHAR(64)", "decimal(18,2)", "date", "int", "timestamp",
    "字符型", "数值类型", "日期类", "金额", "枚举", "布尔", "自定义编码", "",
    None, "  varchar ( 64 )  ", "长文本", "double", "uuid",
]


def main() -> None:
    out: dict[str, Any] = {"cases": [], "split_options": [],
                           "looks_like_question": [], "base_type_of": []}
    for case in CASES:
        rows = case["rows"]
        carry_in = case.get("carry_in")
        # 形状可以来自**整张表**而抽取只跑一个窗口 —— pipeline 的 _window_shape
        # 就是这么用的，carry_in 也只有在这种切段场景下才起作用。
        cs = cites(rows)[:case["cites_take"]] if "cites_take" in case else cites(rows)
        shape = infer_shape(case.get("shape_rows") or rows)
        out["cases"].append({
            "name": case["name"],
            "rows": rows,
            "shape_rows": case.get("shape_rows"),
            "cites": cs,
            "carry_in": carry_in,
            "shape": shape.to_dict(),
            "describe": shape.describe(),
            "extract": structural_extract(rows, cs, shape, carry_in=carry_in),
        })
    out["split_options"] = [{"in": s, "out": split_options(s)} for s in _SPLIT]
    out["looks_like_question"] = [{"in": s, "out": looks_like_question(s)}
                                  for s in _QUESTIONS]
    out["base_type_of"] = [{"in": s, "out": base_type_of(s)} for s in _BASE_TYPES]

    p = ROOT / "golden" / "shape.extra.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {p.name:36} {p.stat().st_size:>8} B")


if __name__ == "__main__":
    main()
