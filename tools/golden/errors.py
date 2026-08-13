"""导出 kernel/errors.py 的 golden —— 异常的**消息字节**与**继承关系**。

异常类本身没什么可导的，值钱的是两样东西：

1. 消息格式串。`BudgetExhausted` 的那条被 server.py:799 拿文本在匹配
   （``if "usd 预算耗尽" in text``），措辞漂了那条兜底就瞎了。
2. 消息里那两个**格式化原语**：`{x:.0f}` 和 `{s!r}`。它们在 JS 里没有等价物 ——
   `toFixed(0)` 的舍入方向、大数指数形态、inf 拼写全和 CPython 不一样，
   `JSON.stringify` 的引号选择也和 `repr` 不一样。所以除了整条消息，
   还单独导原语的向量，好让 TS 侧能定位是哪一层错了。

字节确定：无时间、无随机、无 set 迭代，`sort_keys=True`。重跑哈希一致。
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.errors import (  # noqa: E402
    BudgetExhausted,
    DagError,
    DeterminismViolation,
    FrozenPlanViolation,
    HarnessError,
    HumanInputRequired,
    NodeFailure,
    SandboxError,
    ToolDenied,
)

# 数值向量用**字面量字符串**而不是 JSON number 携带：JSON 表达不了 inf/nan，
# 而这两个恰好是 .0f 分叉最大的地方。float(lit) 与 JS Number(lit) 都是
# 正确舍入的十进制→double，两边拿到的是同一个 double。
_NUMS = [
    "0", "1", "0.4", "0.5", "1.5", "2.5", "3.5", "-0.0", "-0.4", "-0.5", "-2.5",
    "0.05", "1e-9", "9.99", "10.0", "1234.567", "1e15", "9007199254740993",
    "1.2345678901234568e20", "1e21", "1e22", "Infinity", "-Infinity", "NaN",
]

# repr 向量：覆盖引号选择（Python 会为了少转义而改用双引号）、反斜杠、
# 控制字符、CJK/emoji（可打印，原样保留），以及**非 ASCII 的不可打印字符**
# —— 最后这类要靠 unicodedata 表才判得出来，是 TS 侧的已知分叉点。
_KEYS = [
    "EXTRACT#0",
    "抽取节点#3",
    "llm.call#retry",
    "",
    "a'b",
    'a"b',
    "a'\"b",
    "a\\b",
    "a\nb",
    "a\tb",
    "a\rb",
    "\x00",
    "\x1f",
    "\x7f",
    "\xa0",
    "​",
    "🐍#1",
]


def _mro(cls: type) -> list[str]:
    """到 Exception 为止的祖先名（含自己），object/BaseException 不要。"""
    return [c.__name__ for c in cls.__mro__ if c.__name__ not in ("object", "BaseException")]


def main() -> None:
    classes = [
        HarnessError, DagError, FrozenPlanViolation, DeterminismViolation,
        BudgetExhausted, ToolDenied, SandboxError, NodeFailure, HumanInputRequired,
    ]

    budget = []
    for dim in ("usd", "tokens", "wall_s"):
        for lim in _NUMS:
            for sp in _NUMS:
                # 全组合太大，只取对角线 + 几个交叉，够钉住格式化的每个分支
                if lim != sp and not (lim == "10.0" and sp in ("9.99", "1e21")):
                    continue
                exc = BudgetExhausted(dim, float(lim), float(sp))
                budget.append({
                    "dimension": dim,
                    "limit_lit": lim,
                    "spent_lit": sp,
                    "message": str(exc),
                })

    determinism = [
        {
            "key": k,
            "recorded": "a1b2c3d4e5f60718",
            "replayed": "0f1e2d3c4b5a6978",
            "message": str(DeterminismViolation(k, "a1b2c3d4e5f60718", "0f1e2d3c4b5a6978")),
        }
        for k in _KEYS
    ]

    node_failure = [
        {"node_id": nid, "reason": rsn, "retryable": rt, "message": str(NodeFailure(nid, rsn, retryable=rt))}
        for nid, rsn, rt in [
            ("EXTRACT", "工具返回空结果", True),
            ("EXTRACT", "预算耗尽，已保存 checkpoint", False),
            ("", "", True),
            ("节点#1", "上游 400", False),
        ]
    ]

    human = [
        {
            "node_id": nid,
            "request_id": rid,
            "message": str(HumanInputRequired(nid, rid, {"q": "选哪个"})),
        }
        for nid, rid in [("INTERVIEW", "req_7f3a"), ("", ""), ("面谈#2", "req_中文")]
    ]

    out = {
        "hierarchy": {c.__name__: _mro(c) for c in classes},
        "budget_exhausted": budget,
        "determinism_violation": determinism,
        "node_failure": node_failure,
        "human_input_required": human,
        # 原语单独导，便于 TS 侧定位分叉层次
        "format_fixed0": [{"lit": n, "out": format(float(n), ".0f")} for n in _NUMS],
        "repr_str": [{"in": k, "out": repr(k)} for k in _KEYS],
        # NodeFailure / HumanInputRequired 的默认值也钉一下
        "defaults": {"node_failure_retryable": NodeFailure("n", "r").retryable},
    }

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "errors.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
