"""把 kernel/bus/ 的行为导成 golden，给 TS 侧 blackboard.ts / bus.ts 当安全网。

Python 侧 tests/test_bus.py 只有 11 条断言，覆盖的是「黑板冲突不覆盖」这条主
线。真正会在 TS 上悄悄分叉的是另外三样，它们一条都没被 Python 测试碰过：

  1. **fnmatch 的通配语义**。作用域隔离（ScopeSpec.blackboard_pattern）靠它
     成立 —— 匹配范围一宽，节点就能读到不该读的上游状态。JS 没有 fnmatch，
     TS 侧是手写的，字符类（``[a-z]`` / ``[!x]`` / 逆序区间 / 未闭合方括号）
     每一条都得对着 CPython 校一遍。
  2. **排序基准**。``keys()`` 用 ``sorted()``（按 code point），JS 默认 sort
     按 UTF-16 code unit —— 键里有 emoji 就分叉。
  3. **``{confidence:.2f}``**。CPython 是「精确二进制值 + 银行家舍入」，
     JS ``toFixed(2)`` 是「就近 + 向上」。0.125 一个就能把 render 的字节打偏。

所以这份 golden 存三类东西：fnmatch 真值表、黑板 op 程序的回放结果、
以及若干格式化/切片向量。

**设计沿用 dag.py：golden 里存的是「程序」而不是「对象快照」。** 每个用例带一
串 ops（watch/write），两边各自用同一个解释器 replay 同一串，再比对输出。

跑法::

    .venv/bin/python tools/golden/bus.py

字节确定：无时间、无随机、无集合迭代序（要排序的地方 blackboard.py 自己排了；
``contested()`` 走 dict 插入序，同样确定）。重跑两次哈希必须一致。
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.bus.blackboard import (  # noqa: E402
    Blackboard,
    Revision,
    _fmt,
)
from ontocopilot.kernel.ids import fingerprint  # noqa: E402

OUT = Path(__file__).resolve().parent.parent.parent / "golden" / "bus.json"


# ══════════════════════════════════════════════════════════════════
#  1. fnmatch 真值表
# ══════════════════════════════════════════════════════════════════
#: 模式 × 名字的笛卡尔积太大且大半没信息量，所以按「模式 → 一组针对性的名字」
#: 组织。每组名字都是冲着这个模式的边界去的。
FNMATCH_GROUPS: list[tuple[str, list[str]]] = [
    # ── 纯字面量 + 正则元字符必须被当成字面量 ──
    ("", ["", "a"]),
    ("a", ["a", "", "aa", "A", "ab"]),
    ("a.b", ["a.b", "axb", "ab"]),
    ("a+b", ["a+b", "ab", "aab"]),
    ("a(b)c", ["a(b)c", "abc"]),
    ("a$", ["a$", "a", "a$\n"]),
    ("^a", ["^a", "a"]),
    ("a{2}", ["a{2}", "aa"]),
    ("a|b", ["a|b", "a", "b"]),
    ("a\\b", ["a\\b", "ab", "a\\\\b"]),
    ("a&b", ["a&b", "ab"]),
    ("a~b", ["a~b", "ab"]),
    ("a#b", ["a#b", "ab"]),
    ("a b", ["a b", "ab", "a\tb"]),
    ("a\tb", ["a\tb", "a b"]),
    ("a\nb", ["a\nb", "ab", "a b"]),
    # ── * ──
    ("*", ["", "a", "a/b", "a\nb", "\n", "😀", "中文"]),
    ("**", ["", "a", "ab"]),
    ("***", ["", "abc"]),
    ("a*", ["a", "ab", "abc", "", "ba"]),
    ("*a", ["a", "ba", "", "ab"]),
    ("*a*", ["a", "bab", "b", "", "aa"]),
    ("*a*b", ["ab", "ba", "aab", "axb", "ab_b", "b"]),
    ("*a*ab", ["aab", "ab", "aaab", "xaxab"]),
    ("a*b*c", ["abc", "axbxc", "ac", "abcc", "abbc"]),
    ("*.xlsx", ["材料.xlsx", ".xlsx", "xlsx", "a.xlsx.bak"]),
    ("oir/*", ["oir/", "oir/x", "oir/x/def", "oirx", "oir"]),
    ("oir/*/def", ["oir/x/def", "oir/def", "oir/x/y/def", "oir/x/defx"]),
    ("*/*", ["a/b", "a/b/c", "ab", "/"]),
    # ── ? ──
    ("?", ["", "a", "ab", "\n", "😀", "中"]),
    ("??", ["ab", "a", "abc", "😀", "中文"]),
    ("a?c", ["abc", "ac", "a\nc", "a😀c"]),
    ("?*?", ["ab", "a", "abc", ""]),
    # ── 字符类：基本 ──
    ("[abc]", ["a", "b", "c", "d", "", "ab", "[abc]"]),
    ("[a-c]", ["a", "b", "c", "d", "-", "A"]),
    ("[!abc]", ["a", "d", "", "ab", "!", "\n"]),
    ("[!a-c]", ["a", "d", "-", "!"]),
    ("[a-cx-z]", ["a", "c", "x", "z", "d", "w", "-"]),
    ("x[0-9]y", ["x0y", "x9y", "xay", "x-y"]),
    # ── 字符类：边界（CPython translate 里最阴的一段）──
    ("[]]", ["]", "", "[]]", "a"]),
    ("[!]]", ["]", "a", "!", ""]),
    ("[]-]", ["]", "-", "a", ""]),
    ("[-]", ["-", "a", ""]),
    ("[a-]", ["a", "-", "b"]),
    ("[-a]", ["-", "a", "b"]),
    ("[--0]", ["-", ".", "0", "/", "1"]),
    ("[b-a]", ["a", "b", "-", ""]),
    ("[!b-a]", ["a", "b", "-", "", "\n", "ab"]),
    ("[a-c-e]", ["a", "b", "c", "d", "e", "-"]),
    ("[d-c-b-a]", ["a", "b", "c", "d", "-"]),
    ("[a-b-c]", ["a", "b", "c", "-", "d"]),
    ("[\\]", ["\\", "a", ""]),
    ("[a\\]", ["a", "\\", "b"]),
    ("[\\-a]", ["\\", "a", "-", "]"]),
    ("[^a]", ["^", "a", "b", ""]),
    ("[[]", ["[", "a", "]"]),
    ("[[a]", ["[", "a", "b"]),
    ("[&]", ["&", "a"]),
    ("[&&]", ["&", "a"]),
    ("[a&&b]", ["a", "b", "&", "c"]),
    ("[|]", ["|", "a"]),
    ("[~]", ["~", "a"]),
    ("[a~~b]", ["a", "b", "~"]),
    ("[!!]", ["!", "a", ""]),
    ("[!^]", ["^", "a", "!"]),
    # ── 字符类：未闭合 → 整个 [ 退化成字面量 ──
    ("[", ["[", "", "a"]),
    ("[]", ["[]", "]", "", "["]),
    ("[!", ["[!", "!", "["]),
    ("[!]", ["[!]", "]", "!"]),
    ("[abc", ["[abc", "a", "abc"]),
    ("a[b", ["a[b", "ab"]),
    ("[a-", ["[a-", "a", "-"]),
    # ── 字符类 + 星号混用 ──
    ("*[0-9]", ["x1", "1", "x", "x1y"]),
    ("[a-z]*", ["a", "abc", "A", "", "1a"]),
    ("oir/[!_]*", ["oir/x", "oir/_x", "oir/", "oir/xy"]),
    # ── 非 BMP：Python 按 code point，JS 默认按 UTF-16 code unit ──
    ("😀", ["😀", "a"]),
    ("?😀", ["a😀", "😀😀", "😀"]),
    ("[😀😁]", ["😀", "😁", "😂"]),
    ("[\U0001f600-\U0001f64f]", ["😀", "🙏", "😿", "a"]),
    ("[￿-\U0001f600]", ["￿", "😀", "￾", "\U0001f601"]),
    ("中*文", ["中文", "中间文", "中", "文中"]),
    ("术语/*", ["术语/采购包", "术语/", "术语"]),
]


#: 落单代理码元的用例单独放：它们**无法用 UTF-8 编码**，塞进 JSON 字符串会让
#: 导出直接炸（surrogates not allowed）。所以这一组的 pat/name 存成 code point
#: 数组，两边各自 String.fromCharCode / chr 还原。
#: 钉的是：`?` 与 `[😀😁]` 在 Python 里吃的是**一个 code point**，半个代理对
#: 既不是 😀 也不匹配任何单字符模式 —— TS 若退回 UTF-16 语义，这里立刻红。
FNMATCH_SURROGATE: list[tuple[str, list[str]]] = [
    ("😀", ["\ud83d", "\ude00"]),
    ("?", ["\ud83d", "\ud83d\ud83d"]),
    ("??", ["😀", "\ud83d\ud83d"]),
    ("[😀😁]", ["\ud83d", "\ude00"]),
]


def fnmatch_surrogate_vectors() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for pat, names in FNMATCH_SURROGATE:
        for name in names:
            out.append({
                "pat_cp": [ord(c) for c in pat],
                "name_cp": [ord(c) for c in name],
                "match": fnmatch.fnmatchcase(name, pat),
            })
    return out


#: 手挑的用例只覆盖我想得到的边界，而 CPython 的 ``translate`` 里那段
#: chunk 切分 + 逆序区间合并 + 「中间 chunk 只剩一个字符时第二个连字符退化成
#: 字面量」的连锁反应，是想不全的。所以再补一批**确定性伪随机**向量：种子写死，
#: 字母表专挑元字符，重跑逐字节一致。TS 侧写错任何一条分支这里都会红。
FUZZ_SEED = 20260813
FUZZ_PAT_ALPHABET = list("ab-*?[]!\\^&|~ .0") + ["中", "😀", "\n"]
FUZZ_NAME_ALPHABET = list("ab-]^&|~ .0[!\\") + ["中", "😀", "\n"]


def fuzz_vectors() -> list[dict[str, Any]]:
    import random

    rng = random.Random(FUZZ_SEED)
    out: list[dict[str, Any]] = []
    for _ in range(320):
        pat = "".join(rng.choice(FUZZ_PAT_ALPHABET) for _ in range(rng.randint(1, 8)))
        names = [pat]  # 模式自身当名字：字面量路径最容易被写漏
        names += [
            "".join(rng.choice(FUZZ_NAME_ALPHABET) for _ in range(rng.randint(0, 4)))
            for _ in range(3)
        ]
        for name in names:
            row: dict[str, Any] = {"pat": pat, "name": name}
            try:
                row["match"] = fnmatch.fnmatchcase(name, pat)
            except Exception as exc:
                row["error"] = type(exc).__name__
            out.append(row)
    return out


def fnmatch_vectors() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for pat, names in FNMATCH_GROUPS:
        for name in names:
            row: dict[str, Any] = {"pat": pat, "name": name}
            try:
                row["match"] = fnmatch.fnmatchcase(name, pat)
            except Exception as exc:  # CPython 的 translate 在个别退化输入上会炸
                row["error"] = type(exc).__name__
            out.append(row)
    return out


# ══════════════════════════════════════════════════════════════════
#  2. 黑板 op 程序
# ══════════════════════════════════════════════════════════════════
#: 每个用例：先按 watch 注册订阅，再顺序执行 ops，最后跑 queries。
BOARD_CASES: list[dict[str, Any]] = [
    {
        "name": "same_value_twice_is_not_a_conflict",
        "watch": ["glossary/*"],
        "ops": [
            {"key": "glossary/采购包", "value": "purchasePackage",
             "by": "EXTRACT.object", "confidence": 0.6},
            {"key": "glossary/采购包", "value": "purchasePackage",
             "by": "EXTRACT.property", "confidence": 0.7},
        ],
    },
    {
        "name": "disagreement_keeps_both",
        "watch": [],
        "ops": [
            {"key": "oir/pt_plan_amount/definition", "value": "含税·年度累计",
             "by": "EXTRACT.xlsx", "support": ["实体梳理.xlsx!R44C6"], "confidence": 0.8},
            {"key": "oir/pt_plan_amount/definition", "value": "不含税·单次",
             "by": "EXTRACT.ddl", "support": ["schema.ddl#clm_contract"], "confidence": 0.75},
        ],
    },
    {
        "name": "watchers_fire_on_new_conflict_only",
        "watch": ["oir/*", "*", "glossary/?"],
        "ops": [
            {"key": "oir/a", "value": 1, "by": "X"},
            {"key": "oir/a", "value": 2, "by": "Y"},
            {"key": "oir/a", "value": 2, "by": "Z"},
            {"key": "glossary/b", "value": 1, "by": "X"},
        ],
    },
    {
        "name": "tie_on_confidence_takes_latest",
        "watch": [],
        "ops": [
            {"key": "k", "value": "A", "by": "n1", "confidence": 0.5},
            {"key": "k", "value": "B", "by": "n2", "confidence": 0.5},
            {"key": "k", "value": "C", "by": "n3", "confidence": 0.5},
        ],
    },
    {
        "name": "variants_dedup_by_canonical_value",
        "watch": [],
        "ops": [
            # 同一个 dict 的两种书写顺序 —— canonical_json 之后是同一个值，
            # 不算分歧。这是 contested 用 canonical_json 而不是 == 的理由。
            {"key": "k", "value": {"a": 1, "b": 2}, "by": "n1", "confidence": 0.3},
            {"key": "k", "value": {"b": 2, "a": 1}, "by": "n2", "confidence": 0.9},
            {"key": "k", "value": {"a": 1, "b": 3}, "by": "n3", "confidence": 0.9},
            {"key": "k", "value": {"a": 1, "b": 3}, "by": "n4", "confidence": 0.2},
        ],
    },
    {
        "name": "value_shapes_roundtrip",
        "watch": [],
        "ops": [
            {"key": "z/null", "value": None, "by": "n"},
            {"key": "z/bool", "value": True, "by": "n"},
            {"key": "z/int", "value": -7, "by": "n"},
            {"key": "z/list", "value": [1, "二", None, {"三": 3}], "by": "n"},
            {"key": "z/str", "value": "带\n换行与「引号」", "by": "n"},
            {"key": "z/empty", "value": "", "by": "n"},
        ],
    },
    {
        "name": "sort_order_is_by_code_point",
        "watch": [],
        "ops": [
            # "😀" 是代理对：Python 按 code point 排在 "￿" 之后，
            # JS 默认 sort 按 UTF-16 code unit 会把它排到 "￿" 之前。
            {"key": "￿", "value": 1, "by": "n"},
            {"key": "😀", "value": 2, "by": "n"},
            {"key": "z", "value": 3, "by": "n"},
            {"key": "Z", "value": 4, "by": "n"},
            {"key": "10", "value": 5, "by": "n"},
            {"key": "2", "value": 6, "by": "n"},
            {"key": "_", "value": 7, "by": "n"},
            {"key": "中", "value": 8, "by": "n"},
        ],
        "queries": {"keys": ["*", "?", "[0-9]*"], "snapshot": ["*"]},
    },
    {
        "name": "render_confidence_two_decimals",
        "watch": [],
        "ops": [
            # 全是二进制精确表示的半整数 —— CPython 的 .2f 走银行家舍入，
            # JS toFixed(2) 走「就近且向上」，这一组是两者唯一会分叉的地方。
            {"key": "c", "value": "v0", "by": "a", "confidence": 0.125},
            {"key": "c", "value": "v1", "by": "b", "confidence": 0.375},
            {"key": "c", "value": "v2", "by": "c", "confidence": 0.625},
            {"key": "c", "value": "v3", "by": "d", "confidence": 0.875},
            {"key": "c", "value": "v4", "by": "e", "confidence": 1.0},
            {"key": "c", "value": "v5", "by": "f", "confidence": 0.0},
            {"key": "c", "value": "v6", "by": "g", "confidence": 0.005},
            {"key": "c", "value": "v7", "by": "h", "confidence": 0.3333333333333333},
            {"key": "c", "value": "v8", "by": "i", "confidence": 2.675},
            {"key": "c", "value": "v9", "by": "j", "confidence": -0.125},
        ],
    },
    {
        "name": "render_support_is_capped_at_three",
        "watch": [],
        "ops": [
            {"key": "oir/x/def", "value": "含税", "by": "A",
             "support": ["s1", "s2", "s3", "s4"], "confidence": 0.8},
            {"key": "oir/x/def", "value": "不含税", "by": "B",
             "support": [], "confidence": 0.7, "note": "无出处"},
        ],
    },
    {
        "name": "render_limit_and_pattern",
        "watch": [],
        "ops": [
            {"key": f"k{i:02d}", "value": i, "by": "n"} for i in range(8)
        ],
        "queries": {
            "keys": ["*", "k0?", "k[0-2]*"],
            "render": [
                {"pattern": "*", "limit": 60},
                {"pattern": "*", "limit": 3},
                {"pattern": "*", "limit": 0},
                {"pattern": "k0[0-2]", "limit": 60},
            ],
            "snapshot": ["*", "k0[0-2]"],
        },
    },
    {
        "name": "render_truncates_long_values",
        "watch": [],
        "ops": [
            {"key": "long/str", "value": "夯" * 120, "by": "n"},
            {"key": "long/exact90", "value": "x" * 90, "by": "n"},
            {"key": "long/exact91", "value": "x" * 91, "by": "n"},
            {"key": "long/astral", "value": "😀" * 95, "by": "n"},
            {"key": "long/list", "value": list(range(60)), "by": "n"},
        ],
    },
]


def run_board_case(case: dict[str, Any]) -> dict[str, Any]:
    bb = Blackboard()
    fired: list[dict[str, Any]] = []

    def make_cb(pattern: str):
        def cb(k: str, rev: Revision, newly: bool) -> None:
            fired.append({"pattern": pattern, "key": k, "rev": rev.rev, "newly": newly})

        return cb

    for pattern in case.get("watch", []):
        bb.watch(pattern, make_cb(pattern))

    writes: list[dict[str, Any]] = []
    for op in case["ops"]:
        rev, newly = bb.write(
            op["key"],
            op["value"],
            by=op["by"],
            support=tuple(op.get("support", ())),
            confidence=op.get("confidence", 0.5),
            note=op.get("note", ""),
        )
        writes.append({"rev": rev.to_dict(), "newly": newly})

    q = case.get("queries", {})
    entries: dict[str, Any] = {}
    for k in bb.keys("*"):
        e = bb.entry(k)
        assert e is not None
        entries[k] = {
            "current": e.current.to_dict(),
            "contested": e.contested,
            "variants": [v.to_dict() for v in e.variants],
            "writers": e.writers(),
            "n_revisions": len(e.revisions),
        }

    # 从事件形态（write 返回的 to_dict）重建一遍，钉住 replay 的等价性；
    # 再补一次 write，把 _rev 水位一并暴露出来（_rev 是私有的，只能这样观测）。
    bb2 = Blackboard()
    bb2.replay([w["rev"] for w in writes])
    replay_state = {
        "keys": bb2.keys("*"),
        "snapshot": bb2.snapshot("*"),
        "snapshot_keys": list(bb2.snapshot("*")),
    }
    probe, _ = bb2.write("__probe__", 0, by="probe")

    return {
        "name": case["name"],
        "writes": writes,
        "fired": fired,
        "len": len(bb),
        "contested_keys": [e.key for e in bb.contested()],
        "keys": {p: bb.keys(p) for p in q.get("keys", ["*"])},
        "snapshot": {p: bb.snapshot(p) for p in q.get("snapshot", ["*"])},
        # snapshot 的**键序**要单独存成数组：JSON 对象一旦被 JS 的 JSON.parse
        # 读回来，"2"/"10" 这种整数形键就会被重排，dict 的顺序信息就没了。
        "snapshot_keys": {p: list(bb.snapshot(p)) for p in q.get("snapshot", ["*"])},
        "render": [
            {"pattern": r["pattern"], "limit": r["limit"],
             "out": bb.render(r["pattern"], limit=r["limit"])}
            for r in q.get("render", [{"pattern": "*", "limit": 60}])
        ],
        "entries": entries,
        # 快照取的是 replay 之后、探针写入**之前**的状态；next_rev 是探针拿到的
        # 号码，用来观测私有的 _rev 水位（replay 必须把它推到历史最大值）。
        "replay": {**replay_state, "next_rev": probe.rev},
    }


# ══════════════════════════════════════════════════════════════════
#  3. _fmt 切片 + read 默认值 + bus 的 effect key
# ══════════════════════════════════════════════════════════════════
FMT_VECTORS: list[Any] = [
    "",
    "abc",
    "x" * 89,
    "x" * 90,
    "x" * 91,
    "夯" * 91,
    "😀" * 45,
    "😀" * 46,
    None,
    True,
    False,
    0,
    -7,
    [1, 2, 3],
    {"b": 1, "a": 2},
    list(range(40)),
]


def fmt_vectors() -> list[dict[str, Any]]:
    return [{"value": v, "out": _fmt(v)} for v in FMT_VECTORS]


#: bus.request 的 effect key —— 同一节点内并发请求靠它区分，算错了就会
#: 相互串结果。fingerprint 已由 golden/ids.json 钉住，这里钉的是拼接形状。
EKEY_VECTORS: list[dict[str, Any]] = [
    {"to": "ACTOR", "kind": "justify", "payload": None},
    {"to": "ACTOR", "kind": "justify", "payload": {}},
    {"to": "EXTRACT.property", "kind": "justify",
     "payload": {"claim": "planAmount 是 DECIMAL(18,2)"}},
    {"to": "ACTOR", "kind": "ask", "payload": {"i": 0}},
    {"to": "ACTOR", "kind": "ask", "payload": {"i": 3}},
    {"to": "A:B", "kind": "k:1", "payload": {"x": [1, "二", None]}},
]


def ekey_vectors() -> list[dict[str, Any]]:
    out = []
    for v in EKEY_VECTORS:
        req = {"to": v["to"], "kind": v["kind"], "payload": v["payload"] or {}}
        out.append({**v, "req_fp": fingerprint(req),
                    "ekey": f"msg:{v['to']}:{v['kind']}:{fingerprint(req)}"})
    return out


# ══════════════════════════════════════════════════════════════════
#  4. AgentBus：它自己往日志里写的那些事件
# ══════════════════════════════════════════════════════════════════
#: 只收 bus **自己** emit 的两种事件（BLACKBOARD_WRITE / MESSAGE_SENT）——
#: EFFECT_* 是 Recorder 发的，属于另一个模块的 golden。ts_ms 一律丢掉（墙钟）。
def bus_scenario() -> dict[str, Any]:
    import asyncio

    from ontocopilot.kernel.bus.bus import AgentBus, BusError
    from ontocopilot.kernel.events import EventKind
    from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
    from ontocopilot.kernel.recorder import Recorder

    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    bus = AgentBus(Recorder("r1", journal, blobs))

    seen: list[str] = []
    bus.subscribe("budget/*", lambda m: seen.append(f"budget:{m.payload.get('level')}"))
    bus.subscribe("*", lambda m: seen.append(f"all:{m.to}"))
    bus.register("ACTOR", lambda m: {"ok": True, "kind": m.kind})

    out: dict[str, Any] = {}

    bus.post("glossary/采购包", "purchasePackage", by="N1", confidence=0.6)
    bus.post("oir/x/def", "含税", by="N1", support=["a.xlsx!R1C1"], confidence=0.8)
    bus.post("oir/x/def", "不含税", by="N2", confidence=0.7, note="来自 DDL")

    out["broadcast_n"] = [
        bus.broadcast(frm="SCHED", topic="budget/degrade", payload={"level": "critic_rounds=1"}),
        bus.broadcast(frm="SCHED", topic="run/cancel"),
        # payload 里塞与信封同名的键 —— 展开在最后，会覆盖 topic/mode/receivers。
        bus.broadcast(frm="SCHED", topic="t", payload={"mode": "覆盖", "receivers": -1}),
    ]
    out["subscribers_seen"] = seen

    async def drive() -> None:
        try:
            await bus.request(frm="A", to="不存在", kind="x")
        except BusError as exc:
            out["unregistered_message"] = str(exc)
        out["request_result"] = await bus.request(
            frm="CRITIC", to="ACTOR", kind="justify", payload={"claim": "c"}
        )
        out["request_result_keyed"] = await bus.request(
            frm="CRITIC", to="ACTOR", kind="ask", payload={"i": 1}, key="q1"
        )

    asyncio.run(drive())

    events = list(journal.read("r1"))
    out["events"] = [
        # payload_keys 单独留一份：JSON 对象的键序过不了 JS 的 JSON.parse，
        # 而 broadcast 那条恰恰要钉「payload 展开覆盖同名键时位置不变」。
        {**{k: v for k, v in ev.to_dict().items() if k != "ts_ms"},
         "payload_keys": list(ev.payload)}
        for ev in events
        if ev.kind in (EventKind.BLACKBOARD_WRITE, EventKind.MESSAGE_SENT)
    ]
    # Recorder 记的 effect key —— bus 拼 ekey 的形状端到端钉在这里。
    out["effect_keys"] = [
        ev.payload["key"] for ev in events if ev.kind is EventKind.EFFECT_REQUESTED
    ]
    out["restore_board"] = AgentBus(Recorder("r1", journal, blobs, resume=True)).restore_board()
    return out


#: 已知分叉：Python 内存里的 float 值经 canonical_json 是 "1.0"，JS 无从区分
#: 1 与 1.0 只能给 "1"（见 ids.ts 头部）。黑板的 value 一旦是 float，
#: contested / variants 的分组键和 _fmt 的输出都会跟着分叉。**钉住形状，
#: 不绕过** —— TS 侧的断言写的是"这里必须不同，且不同成这个样子"。
FLOAT_DIVERGENCE: list[dict[str, Any]] = [
    {"value": 1.0, "fmt": _fmt(1.0)},
    {"value": -0.0, "fmt": _fmt(-0.0)},
    {"value": [1.0, 2.5], "fmt": _fmt([1.0, 2.5])},
]


def main() -> None:
    data = {
        "fnmatch": fnmatch_vectors(),
        "fnmatch_surrogate": fnmatch_surrogate_vectors(),
        "fnmatch_fuzz": fuzz_vectors(),
        "board": [run_board_case(c) for c in BOARD_CASES],
        "fmt": fmt_vectors(),
        "ekey": ekey_vectors(),
        "bus": bus_scenario(),
        "float_divergence": FLOAT_DIVERGENCE,
    }
    text = json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    OUT.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    print(f"{OUT}  {len(text)} bytes  sha256={digest[:16]}")


if __name__ == "__main__":
    main()
