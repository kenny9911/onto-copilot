"""导出 `onto/prompts.py` 的 golden —— 推荐问题 chips 的真值。

这个模块没有一行 IO、没有随机、没有时间，所以 golden 就是「同样的状态进去，
同样的三条文案出来」的全量枚举。文案本身是产品面孔，一个字都不能漂，
所以断言的是**整个 dict 列表**，不是「包含某关键词」。

覆盖：
  * 开场四态 —— 空会话 / 传了材料未跑 / 跑完有产物 / 跑完但产物全空
    （外加规则优先级、`or {}` 兜底、`[:3]` 截断这几处只有代码知道的边界）
  * `_ECHO` 每一条命中，以及多条同时命中时的去重与截断
  * `asked` 去重（含标点归一化）与「全被筛掉也不能一条不给」
  * `_key` 的归一化字符集 —— Python 的 `\\s` 与 JS 的 `\\s` 不是同一个集合，
    这一组向量就是用来钉住那条缝的

跑法::

    .venv/bin/python tools/golden/prompts.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.prompts import (  # noqa: E402
    _ECHO,
    _key,
    followup_prompts,
    opening_prompts,
)

OUT = ROOT / "golden"

# 真实跑出来的那份统计（golden/pipeline.stats.json），别手编 —— 手编的数字
# 会悄悄避开「properties=0 但 objects>0」这类只有真数据才踩得到的分支。
_REAL = json.loads((OUT / "pipeline.stats.json").read_text(encoding="utf-8"))
_REAL_STATE: dict[str, Any] = {
    "oir": {"stats": _REAL["oir"]},
    "flow": {"stats": _REAL["flow"]},
}

#: (说明, state, files, status)
_OPENING_CASES: tuple[tuple[str, dict[str, Any], list[str], str], ...] = (
    ("空会话：什么都没有", {}, [], "idle"),
    ("空会话但状态里有残留统计 —— n_files==0 的规则必须先赢",
     _REAL_STATE, [], "done"),
    ("传了一份材料，还没跑", {}, ["实体梳理.xlsx"], "idle"),
    ("传了三份材料，正在跑（status 只要不是 done 就算没跑完）",
     {}, ["实体梳理.xlsx", "流程说明.docx", "接口清单.csv"], "running"),
    ("跑完，真实产物统计", _REAL_STATE, ["材料.xlsx"], "done"),
    ("跑完但产物全空 —— _done_prompts 返回空，兜底顶上",
     {"oir": {"stats": {}}, "flow": {"stats": {}}}, ["a.xlsx"], "done"),
    ("跑完，oir/flow 是 None —— `or {}` 那条兜底",
     {"oir": None, "flow": None}, ["a.xlsx"], "done"),
    ("跑完，只抽到对象没抽到字段", {"oir": {"stats": {"objects": 12}}},
     ["a.xlsx"], "done"),
    ("跑完，只抽到对象且字段也有 —— 那条追问不该出",
     {"oir": {"stats": {"objects": 12, "properties": 48, "open_questions": 0}}},
     ["a.xlsx"], "done"),
    ("跑完，五条建议全命中 —— 只能出前三条",
     {"oir": {"stats": {"objects": 172, "properties": 0, "rules": 9,
                        "open_questions": 150}},
      "flow": {"stats": {"actions": 17, "inferred_edges": 12, "dead_ends": 3}}},
     ["a.xlsx"], "done"),
    ("跑完，只有规则", {"oir": {"stats": {"rules": 4}}}, ["a.xlsx"], "done"),
    ("跑完，只有待澄清问题", {"oir": {"stats": {"open_questions": 7}}},
     ["a.xlsx"], "done"),
    ("跑完，state 里还挂着 suggestions/questions/artifacts/decisions",
     {"oir": {"stats": {"objects": 3, "properties": 9}},
      "suggestions": [{"title": "先补字段口径"}, {"title": ""}, {}],
      "questions": [{"id": "q1"}, {"id": "q2"}],
      "artifacts": ["模板.xlsx"], "decisions": [{"id": "d1"}]},
     ["a.xlsx"], "done"),
)

_ALWAYS_EMPTY = [p["text"] for p in
                 followup_prompts(answer="嗯。", state={}, files=[], status="idle")]

#: (说明, answer, state, files, status, limit, asked)
_FOLLOWUP_CASES: list[tuple[str, str, dict[str, Any], list[str], str, int,
                            list[str]]] = [
    (f"_ECHO 命中：{needle}", f"前面一段话，{needle}，后面一段话。",
     {}, ["a.xlsx"], "idle", 3, [])
    for needle, _text, _group in _ECHO
]
_FOLLOWUP_CASES += [
    ("一条都不命中，且什么材料都没有", "嗯。", {}, [], "idle", 3, []),
    ("一条都不命中，材料传了还没跑", "嗯。", {}, ["a.xlsx"], "idle", 3, []),
    ("一条都不命中，跑完了但什么都没抽到", "嗯。",
     {"oir": {"stats": {}}, "flow": {"stats": {}}}, ["a.xlsx"], "done", 3, []),
    ("一条都不命中，跑完了有产物 —— 状态建议顶上", "嗯。",
     _REAL_STATE, ["材料.xlsx"], "done", 3, []),
    ("回答是「这轮没跑通」—— 最需要出口，却一个关键词都命不中",
     "这轮没跑通：ModelError: 502 Bad Gateway", {}, ["a.xlsx"], "idle", 3, []),
    ("两条 _ECHO 指向同一句 —— 去重后只留一条，剩下的位置让给状态建议",
     "材料里没有写，也没有找到，查不到这一段", {}, ["a.xlsx"], "idle", 3, []),
    ("四条 _ECHO 同时命中 —— 截断在 limit，状态建议一条都轮不上",
     "推断 死路 口径 待确认 材料里没有", _REAL_STATE, ["a.xlsx"], "done", 3, []),
    ("_ECHO 命中一条 + 状态建议补齐", "材料里没有写这一段。",
     _REAL_STATE, ["材料.xlsx"], "done", 3, []),
    ("limit=1", "推断 死路 口径", _REAL_STATE, ["a.xlsx"], "done", 1, []),
    ("limit=5 —— 状态建议不够时 _always 接着补", "嗯。",
     {"oir": {"stats": {"rules": 4}}}, ["a.xlsx"], "done", 5, []),
    ("limit=0 —— 第一条 _ECHO 之后立刻返回", "推断", _REAL_STATE,
     ["a.xlsx"], "done", 0, []),
    ("asked 去重：标点不同也算同一句", "嗯。", {}, [], "idle", 3,
     ["我手上有一堆业务流程文档你能帮我做什么",
      "这类本体建模项目一般怎么推进？"]),
    ("asked 把兜底那几条全问过了 —— 一条不给比重复一条更糟", "嗯。",
     {}, [], "idle", 3, _ALWAYS_EMPTY),
    ("asked 里有全角/半角空格与引号混排", "嗯。", {}, [], "idle", 3,
     ["  我手上有 一堆业务流程文档，你能帮我做什么？  ",
      "「这类本体建模项目一般怎么推进」"]),
]

#: `_key` 的归一化 —— 前四条是产品里真会遇到的，后面几条钉的是字符集边界。
_KEY_CASES: tuple[str, ...] = (
    "",
    "这类本体建模项目一般怎么推进？",
    "这类本体建模项目一般怎么推进",
    "我手上有一堆业务流程文档，你能帮我做什么？",
    " 全角空格　与半角 混排 ",
    "带「引号」和(括号)与'单引号'及\"双引号\"",
    "制表\t换行\n回车\r竖表\v换页\f",
    "不换行空格 与窄空格 ",
    # Python 的 \s 认这几个（U+001C..U+001F 分隔符、U+0085 NEL），JS 的 \s 不认
    "分隔符\x1c\x1d\x1e\x1f与NEL\x85",
    # 反过来：JS 的 \s 认 U+FEFF，Python 不认 —— 这个字符必须原样留着
    "零宽不换行空格﻿",
    "半角句号.逗号,冒号:分号;问号?叹号!",
    "全角句号。逗号，顿号、冒号：分号；问号？叹号！",
)


def main() -> None:
    payload = {
        "opening": [
            {"note": note, "state": state, "files": files, "status": status,
             "out": opening_prompts(state=state, files=files, status=status)}
            for note, state, files, status in _OPENING_CASES
        ],
        "followup": [
            {"note": note, "answer": answer, "state": state, "files": files,
             "status": status, "limit": limit, "asked": asked,
             "out": followup_prompts(answer=answer, state=state, files=files,
                                     status=status, limit=limit, asked=asked)}
            for note, answer, state, files, status, limit, asked in _FOLLOWUP_CASES
        ],
        "echo": [{"needle": n, "text": t, "group": g} for n, t, g in _ECHO],
        "key": [{"in": s, "out": _key(s)} for s in _KEY_CASES],
    }
    OUT.mkdir(exist_ok=True)
    p = OUT / "prompts.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                 encoding="utf-8")
    print(f"  prompts.json {p.stat().st_size:>8} B")


if __name__ == "__main__":
    main()
