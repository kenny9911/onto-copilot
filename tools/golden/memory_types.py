"""kernel/memory/types.py 的 golden —— 记忆层公共类型的确切形状。

下游 evidence / short_term / long_term / dialogue / context / project 六个模块全部
依赖这一份类型，形状定错的代价是六个模块返工。所以这里不挑"代表性"用例，而是把
每一处 Python 与 JS 会分叉的地方都钉死：

  - `est_tokens` 的 `len(text)` 是**码点**数，JS 的 `.length` 是 UTF-16 码元数 ——
    四个星平面字符 Python 算 4、JS 算 8，`// 4` 之后一个给 1 一个给 2。
  - `_CJK` 的四段区间（3400-9FFF / F900-FAFF / 3000-303F / FF00-FFEF）**不含**
    扩展 B 及以上，也不含部首补充区 —— 边界逐个钉，免得 TS 侧"顺手补全"。
  - `to_dict` 里的 `round(confidence, 3)` 是 ties-to-even，`toFixed(3)` 是 ties-away；
    0.0625 / 0.1875 / 0.3125 是精确的二进制并列点，两边差最后一位。
  - `sorted(hit_runs)` 是**码点序**，JS 的 `Array.prototype.sort` 是 UTF-16 码元序 ——
    U+FFFF 与 U+10000 的相对顺序两边相反。
  - `to_dict` 的**键插入顺序**（journal 落盘不排序，字节直接跟着 dict 顺序走）。
  - `from_dict` 对老 mem.json（没有 tier / origin_session / origin_files）的兜底。
  - `render()` 的每一条分支，以及"标注必须挤在内容前面"那个硬约束的确切文案。
  - `mem_key` 里 `s != "x"` 那条看着像死代码的判断（subject 恰好是 "x" 时才走）。

写 `golden/memory.types.json`。字节确定：不直接序列化 set（str 的哈希随
PYTHONHASHSEED 变，迭代序不稳），一律先 sorted。重跑两次 shasum 一致。

    .venv/bin/python tools/golden/memory_types.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.memory.types import (  # noqa: E402
    MemoryItem,
    MemoryKind,
    MemoryTier,
    Scope,
    est_tokens,
    mem_key,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


def build(init: dict[str, Any]) -> MemoryItem:
    """按 golden 里的 init（全 JSON 可表示）造一条 MemoryItem。

    TS 侧照同一份 init 造，两边才比得起来。hit_runs 在 init 里是 list，
    这里转 set —— set 本身不进 JSON。
    """
    kw = dict(init)
    if "kind" in kw:
        kw["kind"] = MemoryKind(kw["kind"])
    if "scope" in kw:
        kw["scope"] = Scope(kw["scope"])
    if "tier" in kw:
        kw["tier"] = MemoryTier(kw["tier"])
    if "hit_runs" in kw:
        kw["hit_runs"] = set(kw["hit_runs"])
    return MemoryItem(**kw)


def base(**over: Any) -> dict[str, Any]:
    d: dict[str, Any] = {"key": "k1", "kind": "lesson", "scope": "run", "content": "内容"}
    d.update(over)
    return d


# ── est_tokens ────────────────────────────────────────────────────
TOKEN_CASES = [
    "",
    " ",
    "a",
    "ab",
    "abc",
    "abcd",
    "abcde",
    "abcdefgh",
    "hello world",
    "你好",
    "你好世界，这是一段中文",
    "你好 world",
    "订单 order_no 字段",
    # 四段 CJK 区间的边界：区间内外各一个
    "㏿",  # U+33FF 区间前一个，非 CJK
    "㐀",  # 区间起点
    "鿿",  # 区间终点
    "ꀀ",  # 终点后一个，非 CJK
    "",  # F900 前一个
    "豈",
    "﫿",
    "ﬀ",  # FAFF 后一个
    "⿿",  # 3000 前一个
    "　",  # 表意空格：算 CJK
    "〿",
    "぀",  # 303F 后一个（平假名，_CJK 不含！slug 含，两者区间不同）
    "﻿",  # FF00 前一个
    "Ａ",  # 全角 Ａ
    "￯",
    "￰",  # FFEF 后一个
    "⺀",  # 部首补充：**不**算 CJK
    # 星平面：len(text) 数码点，JS 的 .length 数码元 —— 四个字符就分叉
    "\U00020000",  # 扩展 B，_CJK 不含
    "\U00020000\U00020001\U00020002\U00020003",
    "\U0001f600",
    "\U0001f600\U0001f600\U0001f600\U0001f600",
    "\U0001f600\U0001f600abcd",
    "中\U0001f600中\U0001f600",
    "a" * 100,
    "中" * 100,
    "\n\t  ",
]

# ── to_dict ───────────────────────────────────────────────────────
DICT_CASES = [
    # 全默认：把每个字段的默认值一次钉死
    base(),
    base(
        key="term:采购订单",
        kind="term",
        scope="project",
        content="PO = 采购订单",
        confidence=0.875,
        support=["ev:1", "ev:2"],
        tags=["a", "b"],
        meta={"z": 1, "a": {"n": None}, "m": [1, 2]},
        created_run="r1",
        last_used_run="r9",
        use_count=3,
        hit_runs=["r1", "r9", "r2"],
        contested_by=["k1~superseded#0"],
        tier="reference",
        origin_session="会话 A",
        origin_files=["f1.xlsx", "f2.docx"],
    ),
    # round(confidence, 3)：三个精确的二进制并列点，全都 ties-to-even
    base(confidence=0.0625),  # → 0.062（toFixed 给 0.063）
    base(confidence=0.1875),  # → 0.188
    base(confidence=0.3125),  # → 0.312
    base(confidence=0.1 + 0.2),  # 0.30000000000000004
    base(confidence=1.0),
    base(confidence=0.0),
    base(confidence=-0.5),
    base(confidence=0.9995),
    base(confidence=0.0005),
    base(confidence=1e-9),
    base(confidence=2 / 3),
    # sorted(hit_runs)：码点序 vs UTF-16 码元序
    base(hit_runs=["b", "a", "B", "A", "_", "中", "￿", "\U00010000", "\U0001f600"]),
    base(hit_runs=[]),
    # 空 meta / 空 list 的确切形态
    base(meta={}, support=[], tags=[]),
]

# ── from_dict ─────────────────────────────────────────────────────
FROM_CASES = [
    # 只有必填字段：其余全走默认
    {"key": "k", "kind": "fact", "scope": "tenant", "content": "c"},
    # 老 mem.json：没有 tier / origin_session / origin_files
    {
        "key": "k",
        "kind": "decision",
        "scope": "project",
        "content": "c",
        "confidence": 0.9,
        "support": ["s"],
        "tags": ["t"],
        "meta": {"x": 1},
        "created_run": "r1",
        "last_used_run": "r2",
        "use_count": 5,
        "hit_runs": ["r2", "r1"],
        "contested_by": ["c1"],
    },
    # 全字段
    {
        "key": "k",
        "kind": "artifact",
        "scope": "node",
        "content": "c",
        "confidence": 0.5,
        "support": [],
        "tags": [],
        "meta": {},
        "created_run": "",
        "last_used_run": "",
        "use_count": 0,
        "hit_runs": [],
        "contested_by": [],
        "tier": "reference",
        "origin_session": "s",
        "origin_files": ["f"],
    },
    # hit_runs 里有重复 —— set 去重
    {"key": "k", "kind": "convention", "scope": "run", "content": "c",
     "hit_runs": ["r1", "r1", "r2"]},
    # 多余的键：Python 直接忽略（不是 **d）
    {"key": "k", "kind": "lesson", "scope": "run", "content": "c", "未知字段": 1},
]

# ── render ────────────────────────────────────────────────────────
RENDER_CASES = [
    (base(), False),
    (base(), True),  # 权威档：foreign_material 不影响输出
    (base(contested_by=["x"]), False),
    (base(tier="reference"), False),
    (base(tier="reference"), True),
    (base(tier="reference", origin_session="需求澄清"), False),
    (base(tier="reference", origin_session="需求澄清"), True),
    (base(tier="reference", origin_session="需求澄清", contested_by=["x"]), True),
    (base(tier="reference", contested_by=["x", "y"]), True),
    (base(tier="authoritative", contested_by=["x"]), True),
    (base(kind="decision", tier="reference", origin_session="", content=""), True),
]

# ── from_other_material ───────────────────────────────────────────
FOM_CASES = [
    (base(), ["f1"]),  # 权威档一律 False
    (base(tier="reference", origin_files=["f1"]), None),  # 不知道当前材料
    (base(tier="reference", origin_files=["f1"]), []),  # 当前材料为空
    (base(tier="reference", origin_files=[]), ["f1"]),  # 不知道来源 → 不算另一批
    (base(tier="reference", origin_files=["f1"]), ["f1"]),  # 有交集
    (base(tier="reference", origin_files=["f1", "f2"]), ["f2", "f3"]),  # 部分交集
    (base(tier="reference", origin_files=["f1"]), ["f2"]),  # 完全不相交
    (base(tier="reference", origin_files=["f1", "f1"]), ["f1"]),
]

# ── mem_key ───────────────────────────────────────────────────────
MEM_KEY_CASES = [
    ("term", "采购订单"),
    ("term", "Purchase Order Header"),
    ("lesson", "  Trim Me  "),
    ("fact", ""),  # slug 退化 → "x"+hash8，**不**等于 "x"，走正常分支
    ("fact", "---"),  # 同上
    ("fact", "x"),  # slug 恰好是 "x" → 走 sha256 兜底分支（唯一入口）
    ("fact", "X"),
    ("fact", " x "),
    ("fact", "x!!!"),
    ("convention", "xx"),  # 只差一个字符 → 不走兜底
    ("decision", "a" * 60),  # 超 48 截断
    ("decision", "字" * 60),
    ("artifact", "\U0001f600"),
    ("artifact", "混合 Mixed 名称 2024"),
]


def main() -> None:
    out: dict[str, Any] = {}

    out["enums"] = {
        "scope": [str(x) for x in Scope],
        "kind": [str(x) for x in MemoryKind],
        "tier": [str(x) for x in MemoryTier],
    }

    out["est_tokens"] = [
        {"in": t, "cp_len": len(t), "out": est_tokens(t)} for t in TOKEN_CASES
    ]

    rows = []
    for init in DICT_CASES:
        it = build(init)
        d = it.to_dict()
        rows.append({
            "init": init,
            "out": d,
            "key_order": list(d.keys()),
            "tokens": it.tokens,
            "contested": it.contested,
        })
    out["to_dict"] = rows

    out["from_dict"] = [
        {"in": raw, "out": MemoryItem.from_dict(dict(raw)).to_dict()} for raw in FROM_CASES
    ]

    out["render"] = [
        {"init": init, "foreign_material": fm, "out": build(init).render(foreign_material=fm)}
        for init, fm in RENDER_CASES
    ]

    out["from_other_material"] = [
        {"init": init, "current": cur,
         "out": build(init).from_other_material(None if cur is None else set(cur))}
        for init, cur in FOM_CASES
    ]

    out["mem_key"] = [
        {"kind": k, "subject": s, "out": mem_key(MemoryKind(k), s)} for k, s in MEM_KEY_CASES
    ]

    # 未知枚举值必须抛（TS 侧最容易退化成 `as Scope`）
    bad: list[dict[str, Any]] = []
    for enum, val in ((Scope, "nope"), (MemoryKind, "LESSON"), (MemoryTier, "Authoritative")):
        try:
            enum(val)
        except ValueError as e:
            bad.append({"enum": enum.__name__, "value": val, "message": str(e)})
        else:  # pragma: no cover
            raise AssertionError(f"{enum.__name__}({val!r}) 居然没抛")
    out["parse_rejects"] = bad

    p = OUT / "memory.types.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  memory.types.json  {p.stat().st_size} B")


if __name__ == "__main__":
    main()
