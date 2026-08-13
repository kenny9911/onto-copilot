"""kernel/intent.py 的 golden —— 「这句话被路由到哪个 handler」的全部判据。

写 `golden/intent.json`（新文件，本 track 独占）。重跑两次字节一致。

    .venv/bin/python tools/golden/intent.py

意图判错不会报错，只会**做错事**：把 `set_scope` 判成 `add_context`，用户说的
"临时表别要了"就静默没生效；反过来把一句提问判成 `set_caliber`，用户每问一次
口径就被悄悄改一次设定。所以这里钉的是**整张判定表**：

  - 十几条正则各自的正例/反例（尤其是刻意排除的那些：`_CALIBER` 不含"统一用"、
    `_START` 让位给 `_RERUN`、`_QUESTION` 把"约定"与"提问"分开）；
  - `_one()` 的**探针顺序**（顺序即优先级，换一位就换一个 handler）；
  - 分句：只在强分隔符与并列连词处拆，逗号本身不拆；
  - 槽位：`suggestion_id` / `question_id` 的下标映射，越界时**不猜**。

TS 侧独有的风险，专门导了：

  1. `re.split` 的结果与 JS `String.split(re)` 在**尾部空片段**上的处理；
  2. `.strip(" ，,、")` 是 code point 集合裁两头，不是 `trim()`；
  3. `len(c) > 200` 与 `c[:80]` 按 code point 算 —— 中文/emoji 用 UTF-16 长度
     会在 `_pasted` 的阈值上分叉（一段 150 字的中文里若有 emoji，两边一个判
     ADD_CONTEXT 一个不判）；
  4. `round(confidence, 2)` 是 half-even；
  5. Python 的 `\\s` 与 JS 的 `\\s` 空白集不同（JS 多 U+FEFF、少 U+001C–U+001F），
     `_CONJ` / `_CHITCHAT` / `_QUESTION` 三条都带 `\\s`；
  6. `next((int(g) for g in ref.groups() if g), 0)`：未参与的组 Python 给 None、
     JS 给 undefined，两边都是假值；但字符串 `"0"` 是**真值**，会变成 n=0。
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.intent import (  # noqa: E402
    INTENT_SCHEMA,
    MUTATING,
    Intent,
    IntentMatch,
    IntentParse,
    RuleIntentParser,
    split_clauses,
)

# ══════════════════════════════════════════════════════════════════
#  分句
# ══════════════════════════════════════════════════════════════════
_CLAUSES = [
    "",
    "   ",
    "第3条采纳，另外临时表别要了",
    "第3条采纳；临时表别要了",
    "采纳。重跑一遍",
    "采纳\n重跑一遍",
    "如果没有字段，就先按接口反推",          # 逗号不拆
    "adopt suggestion 2 and also rerun",
    "adopt suggestion 2, and also rerun",
    "adopt suggestion 2 AND ALSO rerun",
    "adopt and also",
    "，，，",
    "、临时表别要了、",
    "a；；b。。c",
    "含税按专票算，还有币种统一人民币",
    "含税按专票算，币种统一人民币",          # 逗号后不是并列词 → 不拆
    "第1条采纳，并且第2条也采纳",
    "先不，算了",
    "a\n\n\nb",
    "  开始  ；  重跑  ",
]

# ══════════════════════════════════════════════════════════════════
#  规则判定：一个用例 = (文本, 问题 id, 建议 id, 对象名)
# ══════════════════════════════════════════════════════════════════
_Q2 = ["q-1", "q-2"]
_Q0: list[str] = []
_S1 = ["sg-1"]
_S3 = ["sg-1", "sg-2", "sg-3"]
_S0: list[str] = []
_OBJ = ["临时表", "temp", "pbpHeader", "pbpLine"]

_CASES: list[tuple[str, list[str], list[str], list[str]]] = []


def _add(texts: list[str], q: list[str] = _Q0, s: list[str] = _S0,
         o: list[str] = _OBJ) -> None:
    for t in texts:
        _CASES.append((t, q, s, o))


# ── chitchat：整句匹配，多一个字就不是寒暄 ──────────────────────────
_add(["你好", "hello", "hi!", "hey", "在吗", "谢谢", "thanks", "thank you",
      "辛苦了", "好的", "嗯", "嗯嗯嗯", "ok", "okay", "OK。", "great", "cool",
      "got it", "  好的  ", "好的~", "你好啊", "hello world", "thanksgiving"])

# ── 建议：采纳/否决 + 序号映射 ──────────────────────────────────────
_add(["采纳", "接受", "同意", "照做", "照着做", "就这么办", "就这么干",
      "按你说的", "可以，执行", "可以执行", "同意执行",
      "adopt", "accept", "agree", "go ahead", "do it", "sounds good",
      "approve", "apply it", "Adopt It"], s=_S1)
_add(["不采纳", "不接受", "否决", "不同意", "别这么做", "先不", "算了",
      "reject", "decline", "dont do", "don't do", "do not do", "skip it",
      "skip that", "never mind", "nevermind", "not now", "no thanks"], s=_S1)
# 多条建议时必须点名，点不到就 UNKNOWN（不许猜）
_add(["采纳", "第2条建议采纳", "建议2采纳", "第 2 条采纳", "adopt suggestion 2",
      "adopt suggestion 9", "第9条建议采纳", "第0条建议采纳",
      "suggestion 3 reject", "第3条建议不采纳"], s=_S3)
_add(["采纳"], s=_S0)
# 只有序号、没有动词 → 不是建议意图
_add(["第2条建议"], s=_S3)

# ── 问题：必须同时有引用与（选项 or 冒号）───────────────────────────
_add(["question 2: option B", "问题2：选B", "#2：分公司", "第2个问题：选①",
      "Q2: pick 2", "q 2 : option a", "问题 1：按自然年",
      "question 2 option B", "question 2", "问题2：", "#5：越界了",
      "第2个问题 选第一个", "问题2:answer here", "问题2：  留白  ",
      "question 0: x"], q=_Q2)
_add(["question 2: option B"], q=_Q0)

# ── 范围：排除/纳入 + 对象落点 ──────────────────────────────────────
_add(["临时表别要了", "临时表都别要了", "exclude temp tables",
      "drop the staging tables", "keep the header table", "纳入",
      "要保留", "留着", "留下", "加回来", "要建模", "要进本体",
      "去掉 pbpLine", "删掉临时表", "剔除", "不用建模", "不需要进本体",
      "leave out temp", "omit temp", "get rid of temp", "dont need temp",
      "don't want temp", "do not model temp", "include pbpHeader",
      "add back temp", "bring back temp", "retain pbpLine",
      "别要", "不要"])

# ── 口径 / 命名：命名判在口径之前 ───────────────────────────────────
_add(["含税按专票算", "不含税", "税率13", "口径按财年", "币种统一人民币",
      "本位币是美元", "折算按月末汇率", "时间粒度按月", "按年度", "按季",
      "自然年", "财月", "tax-inclusive", "tax exclusive", "without tax",
      "with tax", "currency is CNY", "granularity is daily",
      "fiscal year starts in April", "caliber", "口径是什么", "口径是什么？",
      "什么口径", "为什么按财年", "含税按专票算吗？"])
_add(["命名统一驼峰", "头表统一用 Header 后缀", "前缀用 pbp", "后缀用 Line",
      "下划线命名", "apiName 用驼峰", "统一叫头表", "naming convention",
      "prefix pbp", "suffix Line", "camel case", "camelcase", "snake_case",
      "api name", "命名是什么？", "为什么用这个前缀",
      # 命名 + 口径同时命中 → 命名先判
      "币种字段的命名统一用后缀"])

# ── 解释 ────────────────────────────────────────────────────────────
_add(["为什么", "凭什么", "依据是什么", "怎么得出", "怎么判出", "怎么看出",
      "从哪看", "从哪来", "解释一下", "说明一下理由", "why", "explain",
      "on what basis", "how did you", "justify", "what makes you",
      "为什么 pbpLine 要建模"])

# ── 开始 / 重跑：顺序是判据（"重新梳理" 必须落到 RERUN）──────────────
_add(["开始", "跑一下", "梳理一下", "处理一下", "分析一下", "来吧", "开工",
      "开始梳理", "启动抽取", "把材料梳理一下", "把文件都处理一下",
      "start", "begin", "go", "let's go", "lets go", "kick off", "run it",
      "start the build", "begin modeling", "start extraction",
      "重新梳理", "再来一遍", "开始重跑", "start again", "begin again"])
_add(["重跑", "重新", "重出", "重做", "重算", "重编译", "重生成", "再跑一遍",
      "再抽一次", "再来一遍", "再生成", "重新分析", "重新识别", "重新编译",
      "重新生成", "rerun", "re-run", "redo", "re-do", "regenerate",
      "rebuild", "recompile", "reextract", "re-extract", "run it again",
      "run again", "try again", "重出模板", "重新抽一遍"])

# ── 状态 ────────────────────────────────────────────────────────────
_add(["什么情况", "现在什么情况", "目前啥进度", "进度怎么样", "进度如何",
      "做到哪了", "跑完了吗", "status", "progress", "how's it going",
      "hows it going", "are we done", "done yet", "where are we"])

# ── 粘贴的结构化片段 / 超长 ─────────────────────────────────────────
_add(["CREATE TABLE t (id int)", "alter table t add c varchar(10)",
      '{"a": 1}', "  [1,2,3]", "id varchar(32)", "GET /api/x", "POST /api/x",
      "第一行\n{\"a\":1}",
      # 200 的边界：按 code point 数
      "字" * 200, "字" * 201, "x" * 200, "x" * 201,
      "🙃" * 100, "🙃" * 101])

# ── 判不出来 ────────────────────────────────────────────────────────
_add(["", "   ", "嗯？", "把它弄好", "这个东西", "asdfgh"])

# ── 空白集与词边界：TS 侧照抄 \s / \b 就会在这几条上分叉 ───────────────
# U+001F 是 Python 的空白（JS 的 \s 不是）；U+FEFF 是 JS 的空白（Python 的不是）。
# _CHITCHAT 两头都吃 \s*，所以这两个字符各自决定一句话是不是寒暄。
_add(["好的\x1f", "好的﻿", "\x1f好的", "﻿好的",
      "a；\x1fb", "a；﻿b", "含税按专票算吗\x1f", "对不对﻿"])
# \b 认不认中文：Python 的 \w 认，所以「采纳adopt」里 adopt 前**没有**词边界。
_add(["中文approve", "xadopt", "采纳adopt", "临时表exclude", "excludeX",
      "为什么why", "whyX", "重跑rerun", "统一用后缀prefix"], s=_S1)

# ── 多意图：一句话拆成几件事 ────────────────────────────────────────
_CASES.append(("第2条建议采纳，另外临时表别要了", _Q0, _S3, _OBJ))
_CASES.append(("adopt suggestion 2 and also rerun", _Q0, _S3, _OBJ))
_CASES.append(("问题2：选B；第1条建议采纳；重跑", _Q2, _S3, _OBJ))
_CASES.append(("你好，另外开始梳理", _Q0, _S0, _OBJ))
_CASES.append(("采纳。为什么", _Q0, _S1, _OBJ))


def _match(m: IntentMatch) -> dict[str, Any]:
    """连 dataclass 字段本身一起导 —— to_dict 会 round confidence，原值也要钉。"""
    return {"to_dict": m.to_dict(), "raw_confidence": m.confidence,
            "mutating": m.mutating, "intent_value": str(m.intent)}


def _parse_rows() -> list[dict[str, Any]]:
    rows = []
    for text, q, s, o in _CASES:
        p = RuleIntentParser(question_ids=q, suggestion_ids=s, object_names=o)
        r = p.parse(text)
        rows.append({
            "text": text, "question_ids": q, "suggestion_ids": s,
            "object_names": o,
            "out": r.to_dict(),
            "matches": [_match(m) for m in r.matches],
            "confident": [str(m.intent) for m in r.confident],
            "needs_clarification": r.needs_clarification,
        })
    return rows


def _defaults() -> dict[str, Any]:
    """构造器的默认值：None → 空列表，且**必须是新列表**（不共享引用）。"""
    p = RuleIntentParser()
    p.question_ids.append("mutated")
    p2 = RuleIntentParser()
    empty = IntentMatch(Intent.UNKNOWN)
    empty.slots["k"] = 1
    empty2 = IntentMatch(Intent.UNKNOWN)
    parse = IntentParse(text="t")
    parse.matches.append(empty)
    parse2 = IntentParse(text="t")
    return {
        "fresh_lists": {"q": p2.question_ids, "s": p2.suggestion_ids,
                        "o": p2.object_names},
        "match_defaults": empty2.to_dict(),
        "parse_defaults": parse2.to_dict(),
        "parse_defaults_confident": [str(m.intent) for m in parse2.confident],
        "parse_defaults_needs_clarification": parse2.needs_clarification,
    }


def main() -> None:
    out: dict[str, Any] = {
        "intent_values": [str(i) for i in Intent],
        "mutating": sorted(str(i) for i in MUTATING),
        "split_clauses": [{"in": t, "out": split_clauses(t)} for t in _CLAUSES],
        "parse": _parse_rows(),
        "defaults": _defaults(),
        "intent_schema": INTENT_SCHEMA,
        # to_dict 的 round(x, 2) 是 half-even —— 这几个值 JS 的 toFixed 会给别的
        "round2": [{"in": v, "out": IntentMatch(Intent.UNKNOWN, v).to_dict()["confidence"]}
                   for v in [0.0, 0.125, 0.135, 0.145, 0.155, 0.005, 0.015,
                             0.925, 0.875, 1.0, 0.9, 0.92, 0.88, 0.85, 0.55, 0.3]],
    }

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "intent.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}  {dst.stat().st_size} B")


if __name__ == "__main__":
    main()
