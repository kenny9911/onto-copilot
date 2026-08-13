"""budget 的补充 golden —— `golden/budget.json` 没覆盖到的那半边。

主导出器的 budget.json 只钉了「七档消耗比例 → level/critic_rounds/三个开关」外加
一条 latch。剩下这些在 TS 侧全是真会踩的坑，所以单独导一份：

  - `snapshot()` 里的 `round(r, 4)` —— Python 是 **ties-to-even**，JS 的
    `toFixed`/`Math.round` 是 ties-away；ratio=0.03125（花掉 96.875%）就是精确的
    二进制半整数，两边差最后一位。snapshot 进事件日志和 UI，差一位就是 diff 噪声。
  - `tightest` 的**并列取首**语义 —— Python `min(key=...)` 返回第一个最小值，
    全新预算四个维度 ratio 都是 1.0，返回的是 "tokens" 而不是随便哪个。
  - `limit <= 0` / 超支 / 负额度这几条边界（ratio 恒 1.0、remaining 夹到 0）。
  - `BudgetExhausted` 的消息串 —— server.py 靠 `"usd 预算耗尽" in text` 做判定，
    形态属于契约；里面的 `:.0f` 同样是 ties-to-even。
  - `spend()` 未知维度必须抛（TS 侧 index signature 很容易把它退化成静默建键）。

写 `golden/budget.extra.json`，**不碰** `golden/budget.json`（主 agent 的文件）。
重跑两次字节一致。

    .venv/bin/python tools/golden/budget.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.budget import Budget, DegradeLevel  # noqa: E402
from ontocopilot.kernel.errors import BudgetExhausted  # noqa: E402

OUT = Path(__file__).resolve().parent.parent.parent / "golden"

DIMS = ("tokens", "wallclock_s", "tool_calls", "usd")


def build(limits: dict, spends: list[dict]) -> Budget:
    b = Budget(**limits)
    for s in spends:
        b.spend(**s)
    return b


def snap_case(limits: dict, spends: list[dict]) -> dict:
    b = build(limits, spends)
    return {"limits": limits, "spends": spends, "out": b.snapshot()}


def acc_case(limits: dict, spends: list[dict]) -> dict:
    b = build(limits, spends)
    return {
        "limits": limits, "spends": spends,
        "dims": [{"dim": d, "limit": b.limit(d), "spent": b.spent(d),
                  "remaining": b.remaining(d), "ratio": b.ratio(d)} for d in DIMS],
        "tightest": list(b.tightest),
    }


def check_case(limits: dict, spends: list[dict], dim: str | None) -> dict:
    b = build(limits, spends)
    row: dict = {"limits": limits, "spends": spends, "dim": dim}
    try:
        b.check() if dim is None else b.check(dim)
    except BudgetExhausted as e:
        row |= {"raises": True, "message": str(e), "dimension": e.dimension,
                "limit": e.limit, "spent": e.spent}
    else:
        row["raises"] = False
    return row


def main() -> None:
    out: dict = {}

    # ── snapshot：含两个 round-half-even 的精确并列点 ────────────────
    out["snapshot"] = [
        snap_case({}, []),
        # 968.75/1000 → ratio 恰好 0.03125，round(.,4) 是精确并列 → 取偶 0.0312
        snap_case({"tokens": 1000, "usd": 10.0}, [{"tokens": 968.75}]),
        # 843.75/1000 → ratio 恰好 0.15625 → 取偶 0.1562（toFixed 会给 0.1563）
        snap_case({"tokens": 1000, "usd": 10.0}, [{"tokens": 843.75}]),
        # 多次 spend 累加；最紧的是 usd 而不是 tokens
        snap_case({"tokens": 1000, "usd": 10.0},
                  [{"tokens": 100, "usd": 4.0}, {"usd": 5.0}]),
        # 超支：remaining 夹到 0，ratio 夹到 0.0
        snap_case({"tokens": 1000}, [{"tokens": 2000}]),
        # 额度为 0 → ratio 恒 1.0（不是 0/0）
        snap_case({"tokens": 0}, []),
        # 负额度 → 同样走 lim <= 0 分支
        snap_case({"tokens": -5}, []),
        # 四维都收紧，最紧的是 tool_calls
        snap_case({"tokens": 1000, "wallclock_s": 100, "tool_calls": 10, "usd": 1.0},
                  [{"wallclock_s": 50, "tool_calls": 9, "usd": 0.5}]),
    ]

    # ── 逐维读数 + tightest 的并列取首 ──────────────────────────────
    out["accessors"] = [
        acc_case({}, []),                                    # 四维全 1.0 → 取首 tokens
        acc_case({"tokens": 1000, "usd": 10.0}, [{"tokens": 300, "usd": 3.0}]),
        # wallclock_s 与 tool_calls 并列最小（都剩 0.2）→ 必须取 DIMS 里靠前的
        acc_case({"tokens": 1000, "wallclock_s": 100, "tool_calls": 10, "usd": 10.0},
                 [{"wallclock_s": 80, "tool_calls": 8}]),
        acc_case({"tokens": 1000}, [{"tokens": 2000}]),
        acc_case({"tokens": 0}, []),
    ]

    # ── check / BudgetExhausted ────────────────────────────────────
    out["check"] = [
        check_case({"tokens": 1000}, [{"tokens": 300}], None),
        check_case({"tokens": 1000}, [{"tokens": 1000}], None),
        check_case({"tokens": 1000}, [{"tokens": 1200}], "tokens"),
        # :.0f 也是 ties-to-even：2.5 → "2"（JS toFixed 会给 "3"）
        check_case({"tokens": 2.5}, [{"tokens": 2.5}], "tokens"),
        check_case({"usd": 10.0}, [{"usd": 10.5}], "usd"),
        # 额度为 0 → remaining 也是 0 → 一上来就耗尽
        check_case({"tokens": 0}, [], "tokens"),
        check_case({"tokens": -5}, [], "tokens"),
    ]

    # ── spend 未知维度必须抛 ────────────────────────────────────────
    b = Budget()
    try:
        b.spend(nope=1.0)
    except KeyError as e:
        unknown = {"key": "nope", "arg0": e.args[0]}
    else:  # pragma: no cover
        raise AssertionError("spend 未知维度居然没抛")
    # 抛之后不许留下痕迹（不能半途改了别的维度也不能新建键）
    unknown["spent_after"] = dict(b._spent)
    out["spend_unknown_dim"] = unknown

    # dict 是保序的，混在一起时前面合法的维度**已经**记上了 —— 钉住这个形状，
    # 不要在 TS 侧"优化"成先校验后统一写入。
    b2 = Budget(tokens=1000)
    try:
        b2.spend(tokens=10, nope=1.0)
    except KeyError:
        pass
    out["spend_partial_before_throw"] = dict(b2._spent)

    # ── 阶梯标签与派生 ──────────────────────────────────────────────
    out["labels"] = [{"level": int(l), "name": l.name, "label": l.label}
                     for l in DegradeLevel]

    rows = []
    for lvl in DegradeLevel:
        b = Budget()
        b.pin_level(lvl)
        rows.append({
            "pinned": int(lvl),
            "level": int(b.level),
            "critic_rounds": [{"requested": r, "out": b.critic_rounds(r)}
                              for r in (0, 1, 2, 3, 5)],
            "allow_self_consistency": b.allow_self_consistency(),
            "allow_llm_critic": b.allow_llm_critic(),
            "must_halt": b.must_halt(),
        })
    out["pinned"] = rows

    # pin_level 只升不降：先钉 3 再钉 1，必须还是 3
    b = Budget()
    b.pin_level(DegradeLevel.RULES_ONLY)
    a = int(b.level)
    b.pin_level(DegradeLevel.NO_SELF_CONSISTENCY)
    out["pin_monotonic"] = {"after_pin_3": a, "after_pin_1": int(b.level)}

    # ── round(r, 4) 本身 ────────────────────────────────────────────
    out["round4"] = [{"in": x, "out": round(x, 4)} for x in (
        0.03125, 0.15625, 0.09375, 0.21875, 0.12345, 0.00005, 0.99995,
        0.0, 1.0, 0.5, 1 / 3, 2 / 3, 0.1 + 0.2, 0.1234500000000001,
    )]

    p = OUT / "budget.extra.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  budget.extra.json  {p.stat().st_size} B")


if __name__ == "__main__":
    main()
