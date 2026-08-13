"""导出 kernel/critic.py 的 golden —— 评审与质量门的判定事实。

critic 是"看起来对"的重灾区：多数票的阈值、空票的真值性、finding 的去重键，
写错了都不会报错，只会让一道本该拦住的门放行。所以这份 golden 钉的是**判定结果**
（verdict.to_dict / metrics / gate 决策 / 发出的事件），而不是几个中间变量。

七组向量：

* ``schema``       —— LLMCritic 下发的 JSON Schema，逐字节。
* ``prompt``       —— ``_prompt()`` 的确切字节（含 20000 码位截断那一条）。
  prompt 变一个字，模型输出就可能变，那属于行为改动而不是迁移。
* ``rule_critic``  —— 规则视角的 verdict（note 文案、HIGH 决定 passed）。
* ``vote``         —— **多数票聚合**。这一组是全文件最要紧的：
  ``threshold = len(votes) / 2`` 是真除；``if r.data`` 走 Python 真值性
  （空 dict 是**假票**，JS 里 ``{}`` 是真，照抄就会把一批空回复变成全票通过）。
* ``metrics``      —— metrics_from（空 panel 是"未评审"而不是空洞的成功）。
* ``gate``         —— Gate.evaluate 的决策与它写进日志的 payload。
* ``panel``        —— 并行评审、预算降级跳过并记账、未注册视角整盘拒绝。

字节确定：无时间、无随机、无集合迭代序（``codes`` 由 critic.py 自己 sorted）。
重跑两次 shasum 必须一致。

跑法::

    .venv/bin/python tools/golden/critic.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.critic import (  # noqa: E402
    Critic,
    CriticContext,
    CriticPanel,
    Decision,
    Finding,
    Gate,
    GateResult,
    LLMCritic,
    RuleCritic,
    Severity,
    Verdict,
    metrics_from,
)

OUT = Path(__file__).resolve().parents[2] / "golden"


def materialize(spec: Any) -> Any:
    """``{"__repeat__": [ch, n]}`` → 长串。长串不进 golden，只写生成式。"""
    if isinstance(spec, dict) and "__repeat__" in spec:
        ch, n = spec["__repeat__"]
        return ch * n
    if isinstance(spec, dict):
        return {k: materialize(v) for k, v in spec.items()}
    if isinstance(spec, list):
        return [materialize(v) for v in spec]
    return spec


def make_finding(spec: dict[str, Any]) -> Finding:
    """从 JSON 形状造 Finding。没写的字段走 dataclass 默认值 —— 默认值也一起被钉住。"""
    kwargs: dict[str, Any] = {
        "severity": Severity(spec["severity"]),
        "code": spec["code"],
        "target": spec["target"],
        "claim": spec["claim"],
    }
    if "evidence_checked" in spec:
        kwargs["evidence_checked"] = list(spec["evidence_checked"])
    if "proposed_fix" in spec:
        kwargs["proposed_fix"] = spec["proposed_fix"]
    if "verifier" in spec:
        kwargs["verifier"] = spec["verifier"]
    return Finding(**kwargs)


def make_verdict(spec: dict[str, Any]) -> Verdict:
    kwargs: dict[str, Any] = {"lens": spec["lens"], "passed": spec["passed"]}
    if "findings" in spec:
        kwargs["findings"] = [make_finding(f) for f in spec["findings"]]
    if "note" in spec:
        kwargs["note"] = spec["note"]
    return Verdict(**kwargs)


class StubRec:
    """只需要 emit 的记录器。Python 侧 Gate/Panel 标注的是 Recorder，实际只调 emit。"""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, kind: Any, *, node_id: str | None = None,
             payload: dict[str, Any] | None = None, ref: str | None = None) -> None:
        self.events.append({"kind": str(kind), "node_id": node_id, "payload": payload or {}})


# ══════════════════════════════════════════════════════════════════
#  prompt
# ══════════════════════════════════════════════════════════════════
PROMPTS: list[dict[str, Any]] = [
    {
        "why": "最小形态：两条 rubric、无额外规范",
        "name": "semantic", "rubric": ["口径是否一致", "是否有编造的出处"],
        "instruction": "", "evidence_render": "",
        "draft": {"objects": ["采购订单头"], "props": ["planAmount"]},
    },
    {
        "why": "带项目规范",
        "name": "命名", "rubric": ["属性是否 lowerCamelCase"],
        "instruction": "项目规范：对象用中文名，属性用 lowerCamelCase。",
        "evidence_render": "", "draft": {"props": ["PlanDate"]},
    },
    {
        "why": "带可核对的证据（追加在末尾）",
        "name": "provenance", "rubric": ["每条断言是否有出处"],
        "instruction": "", "evidence_render": "材料.xlsx!Sheet1!A1: 计划金额",
        "draft": {"claims": [{"text": "计划金额来自表头", "cite": "材料.xlsx!A1"}]},
    },
    {
        "why": "空 rubric：检查项那一段是空行",
        "name": "empty", "rubric": [], "instruction": "", "evidence_render": "",
        "draft": {},
    },
    {
        "why": "draft 超过 20000 码位要按码位截断",
        "name": "big", "rubric": ["够不够"], "instruction": "", "evidence_render": "",
        "draft": {"s": {"__repeat__": ["月", 30000]}},
    },
    {
        "why": "证据超过 20000 码位同样截断",
        "name": "big_ev", "rubric": ["够不够"], "instruction": "",
        "evidence_render": {"__repeat__": ["证", 30000]}, "draft": {},
    },
]


def export_prompts() -> list[dict[str, Any]]:
    rows = []
    for p in PROMPTS:
        c = LLMCritic(p["name"], p["rubric"], instruction=p["instruction"])
        text = c._prompt(materialize(p["draft"]))
        ev = materialize(p["evidence_render"])
        if ev:
            text += f"\n\n## 可核对的证据\n{ev[:20000]}"
        row = {**{k: v for k, v in p.items()}, "len": len(text),
               "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
        # 短的直接存原文（diff 里看得见），长的只存哈希
        if len(text) <= 4000:
            row["prompt"] = text
        rows.append(row)
    return rows


# ══════════════════════════════════════════════════════════════════
#  rule critic
# ══════════════════════════════════════════════════════════════════
RULE_CASES: list[dict[str, Any]] = [
    {"why": "无 finding → 通过", "name": "schema", "findings": []},
    {"why": "只有 MEDIUM → 仍然通过（只有 HIGH 阻断）", "name": "naming",
     "findings": [{"severity": "medium", "code": "NAMING", "target": "x",
                   "claim": "命名可优化", "verifier": "dict"}]},
    {"why": "有 HIGH → 不通过", "name": "provenance",
     "findings": [{"severity": "high", "code": "EVIDENCE_MISSING", "target": "pt_x",
                   "claim": "无证据", "verifier": "rule"},
                  {"severity": "low", "code": "STYLE", "target": "pt_y",
                   "claim": "措辞", "verifier": "rule"}]},
]


async def export_rule_critics() -> list[dict[str, Any]]:
    rows = []
    for case in RULE_CASES:
        findings = [make_finding(f) for f in case["findings"]]
        c = RuleCritic(case["name"], lambda _d, f=findings: list(f))
        v = await c.judge({"any": "draft"}, None)
        rows.append({**case, "verdict": v.to_dict(), "needs_llm": c.needs_llm})
    return rows


# ══════════════════════════════════════════════════════════════════
#  多数票聚合
# ══════════════════════════════════════════════════════════════════
class StubResult:
    def __init__(self, data: Any) -> None:
        self.data = data


class StubGateway:
    """按 salt 取第 i 票。真网关的其余行为与聚合逻辑无关。"""

    def __init__(self, votes: list[Any]) -> None:
        self.votes = votes
        self.seen: list[dict[str, Any]] = []

    async def judge(self, node_id: str, prompt: str, *, generator: Any = None,
                    schema: Any = None, salt: int = 0, key: str | None = None,
                    system: str = "") -> StubResult:
        self.seen.append({"salt": salt, "key": key})
        return StubResult(self.votes[salt])


def check(item: str, passed: bool) -> dict[str, Any]:
    return {"item": item, "pass": passed}


def vote_finding(code: str, target: str, severity: str = "medium") -> dict[str, Any]:
    return {"severity": severity, "code": code, "target": target,
            "claim": f"{code} 于 {target}", "evidence_checked": ["材料.xlsx!A1"]}


VOTE_CASES: list[dict[str, Any]] = [
    {
        "why": "单票否决必须生效：阈值 0.5，1 > 0.5",
        "rubric": ["口径一致", "有出处"],
        "votes": [{"checks": [check("口径一致", False), check("有出处", True)],
                   "findings": []}],
    },
    {
        "why": "两票里只有一票判失败：1 > 1.0 不成立，不算失败",
        "rubric": ["口径一致"],
        "votes": [{"checks": [check("口径一致", False)], "findings": []},
                  {"checks": [check("口径一致", True)], "findings": []}],
    },
    {
        "why": "三票里两票判失败：2 > 1.5，算失败",
        "rubric": ["口径一致"],
        "votes": [{"checks": [check("口径一致", False)], "findings": []},
                  {"checks": [check("口径一致", False)], "findings": []},
                  {"checks": [check("口径一致", True)], "findings": []}],
    },
    {
        "why": "三票里一票判失败：1 > 1.5 不成立",
        "rubric": ["口径一致"],
        "votes": [{"checks": [check("口径一致", False)], "findings": []},
                  {"checks": [check("口径一致", True)], "findings": []},
                  {"checks": [check("口径一致", True)], "findings": []}],
    },
    {
        "why": "空 dict 是**假票**（Python 真值性），全空 → CRITIC_FAILED",
        "rubric": ["口径一致"],
        "votes": [{}, {}],
    },
    {
        "why": "None 与空 dict 混一票真的：只按那一票算",
        "rubric": ["口径一致"],
        "votes": [None, {"checks": [check("口径一致", False)], "findings": []}],
    },
    {
        "why": "checks 缺 pass 字段 → 默认算通过",
        "rubric": ["口径一致"],
        "votes": [{"checks": [{"item": "口径一致"}], "findings": []}],
    },
    {
        "why": "finding 按 (code, target) 跨票去重，先到的留下",
        "rubric": ["有出处"],
        "votes": [{"checks": [], "findings": [vote_finding("EVIDENCE_MISSING", "pt_x")]},
                  {"checks": [], "findings": [vote_finding("EVIDENCE_MISSING", "pt_x"),
                                              vote_finding("EVIDENCE_MISSING", "pt_y")]}],
    },
    {
        "why": "HIGH finding 单独就能否决，即使没有失败的检查项",
        "rubric": ["有出处"],
        "votes": [{"checks": [check("有出处", True)],
                   "findings": [vote_finding("CITATION_FABRICATED", "-", "high")]}],
    },
    {
        "why": "全通过：passed=True，note 报 0/N",
        "rubric": ["口径一致", "有出处"],
        "votes": [{"checks": [check("口径一致", True), check("有出处", True)],
                   "findings": []}],
    },
    {
        "why": "checks/findings 字段整个缺失",
        "rubric": ["口径一致"],
        "votes": [{"other": 1}],
    },
]


async def export_votes() -> list[dict[str, Any]]:
    rows = []
    for case in VOTE_CASES:
        gw = StubGateway(case["votes"])
        c = LLMCritic("semantic", case["rubric"])
        ctx = CriticContext(node_id="N", gateway=gw, generator=None,
                            samples=len(case["votes"]))
        v = await c.judge({"d": 1}, ctx)
        rows.append({**case, "verdict": v.to_dict(), "gateway_calls": gw.seen})
    return rows


# ══════════════════════════════════════════════════════════════════
#  metrics_from
# ══════════════════════════════════════════════════════════════════
METRIC_CASES: list[dict[str, Any]] = [
    {"why": "空 panel 是未评审，不是空洞的成功", "verdicts": []},
    {"why": "全过", "verdicts": [{"lens": "schema", "passed": True}]},
    {
        "why": "一过一不过，带 HIGH",
        "verdicts": [
            {"lens": "schema", "passed": True},
            {"lens": "prov", "passed": False, "findings": [
                {"severity": "high", "code": "EVIDENCE_MISSING", "target": "pt_x",
                 "claim": "无证据", "verifier": "rule"},
                {"severity": "low", "code": "AAA", "target": "pt_y", "claim": "小事"}]},
        ],
    },
    {
        "why": "codes 去重后按码位排序（含 CJK）",
        "verdicts": [
            {"lens": "a", "passed": False, "findings": [
                {"severity": "medium", "code": "Z", "target": "t", "claim": "c"},
                {"severity": "medium", "code": "A", "target": "t2", "claim": "c"},
                {"severity": "medium", "code": "命名", "target": "t3", "claim": "c"}]},
            {"lens": "b", "passed": False, "findings": [
                {"severity": "medium", "code": "A", "target": "t4", "claim": "c"},
                {"severity": "medium", "code": "a", "target": "t5", "claim": "c"}]},
        ],
    },
    {
        "why": "同名 lens 重复：后写的覆盖（dict 语义）",
        "verdicts": [{"lens": "dup", "passed": True},
                     {"lens": "dup", "passed": False}],
    },
]


# ══════════════════════════════════════════════════════════════════
#  Gate
# ══════════════════════════════════════════════════════════════════
PREDICATES = {
    "no_high": lambda m: m["high_findings"] == 0,
    "all_passed": lambda m: m["all_passed"],
    "completeness_95": lambda m: m.get("completeness", 0) >= 0.95,
    "always_false": lambda m: False,
}

#: on_fail 是调用方写的闭包，不是 critic.py 的行为。这里刻意只用可移植的写法
#: （不要 f"{m['failed']}" —— 那是 Python 的 list repr，会把 golden 绑死在列表写法上）。
ON_FAIL = {
    "abort": lambda m: GateResult(Decision.ABORT, "未过：" + "、".join(m["failed"])),
    "route_by_completeness": lambda m: GateResult(
        Decision.ROUND_TRIP if m.get("completeness", 0) < 0.95 else Decision.ASK_USER,
        "未过：" + "、".join(m["failed"]),
        {"failed": list(m["failed"])},
    ),
}

GATE_CASES: list[dict[str, Any]] = [
    {
        "why": "全部硬门通过",
        "gate": "publish", "require": [["无高危", "no_high"], ["全部通过", "all_passed"]],
        "on_fail": "abort",
        "verdicts": [{"lens": "prov", "passed": True}], "extra": {},
    },
    {
        "why": "有 HIGH → 被拦，reason 里带失败的标签",
        "gate": "交付门", "require": [["全部通过", "all_passed"], ["无高危", "no_high"]],
        "on_fail": "abort",
        "verdicts": [{"lens": "prov", "passed": False, "findings": [
            {"severity": "high", "code": "CITATION_FABRICATED", "target": "-",
             "claim": "编的出处"}]}],
        "extra": {},
    },
    {
        "why": "完成度不够 → 打回业务方（on_fail 按指标路由）",
        "gate": "publish", "require": [["无高危", "no_high"], ["完成度达标", "completeness_95"]],
        "on_fail": "route_by_completeness",
        "verdicts": [{"lens": "schema", "passed": True}], "extra": {"completeness": 0.68},
    },
    {
        "why": "完成度够了但另一条不过 → 问人",
        "gate": "publish", "require": [["完成度达标", "completeness_95"], ["恒假", "always_false"]],
        "on_fail": "route_by_completeness",
        "verdicts": [{"lens": "schema", "passed": True}], "extra": {"completeness": 0.96},
    },
    {
        "why": "空 require：无条件通过（确定性节点用）",
        "gate": "noop", "require": [], "on_fail": "abort", "verdicts": [], "extra": {},
    },
    {
        "why": "空 panel 撞上 all_passed：未评审必须拦住",
        "gate": "publish", "require": [["全部通过", "all_passed"]], "on_fail": "abort",
        "verdicts": [], "extra": {},
    },
]


def export_gates() -> list[dict[str, Any]]:
    rows = []
    for case in GATE_CASES:
        gate = Gate(case["gate"],
                    require=[(label, PREDICATES[p]) for label, p in case["require"]],
                    on_fail=ON_FAIL[case["on_fail"]])
        metrics = {**metrics_from([make_verdict(v) for v in case["verdicts"]]),
                   **case["extra"]}
        rec = StubRec()
        r = gate.evaluate(metrics, rec, "GATE")
        rows.append({**case, "metrics": metrics,
                     "result": {"decision": str(r.decision), "reason": r.reason,
                                "detail": r.detail},
                     "events": rec.events})
    return rows


# ══════════════════════════════════════════════════════════════════
#  Panel
# ══════════════════════════════════════════════════════════════════
PANEL_CASES: list[dict[str, Any]] = [
    {
        "why": "多视角并行，每个都记一条 CRITIC_VERDICT",
        "critics": [{"name": "schema", "type": "rule", "findings": []},
                    {"name": "naming", "type": "rule", "findings": [
                        {"severity": "medium", "code": "NAMING", "target": "x",
                         "claim": "命名可优化", "verifier": "dict"}]}],
        "lenses": ["schema", "naming"], "allow_llm": True,
    },
    {
        "why": "预算降级：需要模型的视角跳过并记 DEGRADED，绝不静默",
        "critics": [{"name": "rules", "type": "rule", "findings": []},
                    {"name": "semantic", "type": "llm", "rubric": ["口径是否一致"]}],
        "lenses": ["rules", "semantic"], "allow_llm": False,
    },
    {
        "why": "未注册的视角整盘拒绝（NodeFailure, retryable=False），一个 critic 都不跑",
        "critics": [{"name": "schema", "type": "rule", "findings": []}],
        "lenses": ["schema", "nam1ng", "typo", "typo"], "allow_llm": True,
    },
    {
        "why": "lenses 里同一个视角写两遍：跑两遍、记两条（dict 不去重）",
        "critics": [{"name": "schema", "type": "rule", "findings": []}],
        "lenses": ["schema", "schema"], "allow_llm": True,
    },
]


def build_critic(spec: dict[str, Any]) -> Critic:
    if spec["type"] == "rule":
        findings = [make_finding(f) for f in spec["findings"]]
        return RuleCritic(spec["name"], lambda _d, f=findings: list(f))
    return LLMCritic(spec["name"], spec["rubric"])


async def export_panels() -> list[dict[str, Any]]:
    rows = []
    for case in PANEL_CASES:
        rec = StubRec()
        panel = CriticPanel({c["name"]: build_critic(c) for c in case["critics"]}, rec)
        ctx = CriticContext(node_id="N", gateway=None, generator=None)
        row: dict[str, Any] = {**case}
        try:
            verdicts = await panel.judge({"draft": 1}, case["lenses"], ctx,
                                         allow_llm=case["allow_llm"])
            row["verdicts"] = [v.to_dict() for v in verdicts]
        except Exception as exc:  # noqa: BLE001 —— 拒绝行为本身就是要钉的
            row["error"] = {"type": type(exc).__name__, "message": str(exc),
                            "node_id": getattr(exc, "node_id", None),
                            "retryable": getattr(exc, "retryable", None)}
        row["events"] = rec.events
        rows.append(row)
    return rows


# ══════════════════════════════════════════════════════════════════
async def main() -> None:
    payload = {
        "_note": "由 tools/golden/critic.py 生成，勿手改",
        "severity": [str(s) for s in Severity],
        "decision": [str(d) for d in Decision],
        "defaults": {
            "finding": Finding(Severity.LOW, "C", "T", "claim").to_dict(),
            "verdict": Verdict("lens", True).to_dict(),
            "gate_result": {"decision": str(GateResult(Decision.PASS, "r").decision),
                            "reason": GateResult(Decision.PASS, "r").reason,
                            "detail": GateResult(Decision.PASS, "r").detail},
            "critic_context": {"evidence_render": CriticContext("N", None, None).evidence_render,
                               "facts": CriticContext("N", None, None).facts,
                               "rules": CriticContext("N", None, None).rules,
                               "samples": CriticContext("N", None, None).samples},
        },
        "schema": LLMCritic._SCHEMA,
        "prompt": export_prompts(),
        "rule_critic": await export_rule_critics(),
        "vote": await export_votes(),
        "metrics": [
            {**case, "metrics": metrics_from([make_verdict(v) for v in case["verdicts"]])}
            for case in METRIC_CASES
        ],
        "gate": export_gates(),
        "panel": await export_panels(),
    }
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "critic.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  critic.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    asyncio.run(main())
