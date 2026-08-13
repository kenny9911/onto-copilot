"""golden/ids.extra.json —— 补 golden/ids.json 漏掉的那一类：**指数记号的浮点**。

原来的 ids.json 里一条带指数的向量都没有，于是 `ids.ts` 的 `numToJson` 对非整数
直接 `String(n)`（注释还写着"与 Python repr(float) 字节一致"）这个**错误声明**
一直没被测到。usd 成本正好落在这个区间（一次调用 1.2e-5 美元），而它会进 effect
指纹 —— 指纹错了，重放一致性校验就在保护一个错的东西。

单独一个文件而不是重导 ids.json：那份 golden 有 34 个向量已经在服役，
重导会把一次"补测试"变成一次"动地基"。

导出必须字节确定（无时间戳、无 set 迭代、全字面量），重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.ids import canonical_json, fingerprint  # noqa: E402

#: 分成三组，每组盯一个具体的分叉方向。
#: 注释里写的是 **JS 未修复前** 会给出的错误答案，方便回归时一眼看出退化。
FLOATS: list[float] = [
    # ── 转指数记号的阈值不同（CPython decpt<=-4，JS <1e-6）──────────
    1e-5,        # JS String(): "0.00001"
    1.2e-5,      # JS String(): "0.000012"      ← 一次 LLM 调用的美元成本量级
    9.99e-5,     # JS String(): "0.0000999"
    1e-6,        # JS String(): "0.000001"
    # ── 指数补零不同（CPython 至少两位，JS 不补）────────────────────
    1e-7,        # JS String(): "1e-7"
    1.5e-8,      # JS String(): "1.5e-8"
    1e-100,      # JS String(): "1e-100"（三位指数，两边都不补，应一致）
    # ── 不转指数的那一侧，两边本来就一致（防止"修过头"）─────────────
    0.0001,
    0.00012,
    10.25,
    0.13,
    1.5,
    -0.0001,
    -1.2e-5,
    # ── 有效数字位数：shortest round-trip 的边界 ────────────────────
    0.1 + 0.2,   # 0.30000000000000004
    2 ** -1074,  # 最小次正规数
    1.7976931348623157e308,   # 最大有限 double（整数值，走 int 那条路）
]

#: 嵌套进真实形状里 —— 指纹是对整个请求对象算的，不是对裸浮点算的。
NESTED: list[object] = [
    {"usd": 1.2e-5, "model": "opus"},
    {"cost": {"in": 3.4e-6, "out": 1.1e-5}, "n": 3},
    [1e-5, 1e-7, 0.0001],
    {"混合": [1.2e-5, "文本", True, None]},
]


def main() -> None:
    out = {
        "_doc": "Python 侧真跑出来的。TS 的 canonicalJson/fingerprint 必须逐字节一致。",
        "floats": [{"in": repr(x), "out": canonical_json(x), "fp": fingerprint(x)}
                   for x in FLOATS],
        "nested": [{"in": v, "out": canonical_json(v), "fp": fingerprint(v)}
                   for v in NESTED],
    }
    p = Path(__file__).resolve().parents[2] / "golden" / "ids.extra.json"
    # sort_keys=True：这份 golden 钉的是**数字记号**，键序不在管辖范围内。
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
