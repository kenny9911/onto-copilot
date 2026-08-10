"""命令行入口 —— 在真实文件上跑完整流程。

::

    ontocopilot doctor                          # 检查配置、模型连通性、沙箱隔离等级
    ontocopilot parse 材料/*.xlsx 材料/*.ddl      # 只解析，看看读到了什么
    ontocopilot build 材料/* -o out/             # 全流程：解析→抽取→对齐→冲突→模板
    ontocopilot audit out/template.spec.json 回传.xlsx

``build`` 与 ``audit`` 通常隔着几天（中间是业务方在填表），所以模板规格会随
xlsx 一起落盘，审核时从盘上读回 —— 两边对不上是最难查的一类 bug。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

from .kernel.backends import OpenAICompatBackend
from .kernel.budget import Budget
from .kernel.config import llm_config
from .kernel.dag import Difficulty
from .kernel.journal import FileBlobStore, FileJournal
from .kernel.llm import GATEWAY_MODELS, ModelGateway, gateway_routing
from .kernel.recorder import Recorder
from .kernel.sandbox import default_sandbox
from .kernel.skills import default_library
from .kernel.tools import builtin_registry
from .onto.align import align_and_apply
from .onto.audit import ReturnAuditor, merge_into_oir, read_returned
from .onto.clarify import ClarificationEngine
from .onto.conflict import auto_repair, detect_all
from .onto.oir import (
    OIR,
    BaseType,
    Cardinality,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)
from .onto.parse import (
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)
from .onto.template import compile_template, write_xlsx

OK, WARN, BAD = "✓", "!", "✗"


def _p(*a: Any) -> None:
    print(*a, flush=True)


def _rule(title: str = "") -> None:
    _p(f"\n{'─' * 72}" + (f"\n{title}" if title else ""))


# ══════════════════════════════════════════════════════════════════
#  doctor
# ══════════════════════════════════════════════════════════════════
async def cmd_doctor(args: argparse.Namespace) -> int:
    _rule("环境自检")
    rc = 0

    try:
        cfg = llm_config()
        _p(f"{OK} 网关   {cfg.base_url}  凭证 {cfg.redacted_key}")
        if cfg.insecure_transport:
            _p(f"{WARN} 网关是明文 HTTP，凭证在链路上不加密")
    except RuntimeError as exc:
        _p(f"{BAD} 配置   {exc}")
        return 1

    backend = OpenAICompatBackend(cfg.base_url, cfg.api_key)
    routing = gateway_routing()
    for tier, label in (("flash", "便宜档"), ("sonnet", "高难档"), ("judge_openai", "评委")):
        spec = GATEWAY_MODELS[tier]
        try:
            # max_tokens 给足：Gemini Flash 这类模型即便关了 thinking 也会先吐一段
            # reasoning，探针太小会 finish_reason=length、没轮到正文，把好模型误报成红叉。
            text, u = await backend.generate(
                model=spec, prompt="回答两个字：就绪", max_tokens=1024)
            _p(f"{OK} {label:5} {spec.name:30} effort={spec.effort or '-':6} "
               f"{u.tok_in}→{u.tok_out} tok  ${u.usd or 0:.5f}")
        except Exception as exc:  # noqa: BLE001
            _p(f"{BAD} {label:5} {spec.name:30} {type(exc).__name__}: {str(exc)[:90]}")
            rc = 1

    gen = routing.model_for(Difficulty.HIGH)
    _p(f"{OK} 异构评委 生成 {gen.name} → 评委 {routing.judge_for(gen).name}")

    sbx = default_sandbox(production=args.production)
    d = sbx.describe()
    mark = OK if d["production_safe"] else WARN
    _p(f"{mark} 沙箱   {d['name']}  隔离={d['isolation']}  "
       f"生产可用={d['production_safe']}")
    if not d["production_safe"]:
        _p("      本地沙箱无内核隔离，只可用于开发。生产请用 --production（gVisor）。")
    try:
        res = await sbx.exec("emit({'ok': 1})")
        _p(f"{OK if res.ok else BAD} 沙箱执行 {res.result}  {res.duration_ms}ms")
    except Exception as exc:  # noqa: BLE001
        _p(f"{BAD} 沙箱执行 {exc}")
        rc = 1

    lib = default_library()
    _p(f"{OK} 技能   {len(lib)} 个：{'、'.join(lib.names())}")
    from .kernel.agents import default_agents

    _p(f"{OK} Agent  {len(default_agents().names())} 个："
       f"{'、'.join(default_agents().names())}")
    await backend.aclose()
    return rc


# ══════════════════════════════════════════════════════════════════
#  parse
# ══════════════════════════════════════════════════════════════════
def cmd_parse(args: argparse.Namespace) -> int:
    files = _expand(args.files)
    if not files:
        _p(f"{BAD} 没有找到任何文件")
        return 1
    docs = default_registry(sql_dialect=args.dialect).parse_all(files)
    s = corpus_summary(docs)

    _rule(f"解析 {len(files)} 份材料 → {s['chunks']} 个切片")
    for f in s["files"]:
        extra = {k: v for k, v in f.items() if k not in ("file", "kind", "chunks", "findings")}
        _p(f"  {f['kind']:8} {f['file']:28} {f['chunks']:4} 切片  {extra}")

    if s["findings"]:
        _rule("解析发现（每一条都可能改变你对产物的信任程度）")
        for fd in s["findings"]:
            _p(f"  [{WARN if fd['severity'] == 'warn' else '·'}] {fd['file']}：{fd['message']}")

    if args.json:
        Path(args.json).write_text(json.dumps(s, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
        _p(f"\n写出 {args.json}")
    return 0


# ══════════════════════════════════════════════════════════════════
#  build
# ══════════════════════════════════════════════════════════════════
async def cmd_build(args: argparse.Namespace) -> int:
    files = _expand(args.files)
    if not files:
        _p(f"{BAD} 没有找到任何文件")
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # ── 1. 解析 ────────────────────────────────────────────────
    _rule("1/6 解析")
    docs = default_registry(sql_dialect=args.dialect).parse_all(files)
    index = build_index(docs)
    endpoints = collect_endpoints(docs)
    profiles = collect_profiles(docs)
    summary = corpus_summary(docs)
    _p(f"  {len(files)} 份材料 → {len(index)} 切片 · "
       f"写端点 {len(endpoints)} · 列画像 {len(profiles)}")
    for fd in summary["findings"]:
        if fd["severity"] == "warn":
            _p(f"  {WARN} {fd['file']}：{fd['message'][:100]}")

    # ── 2. 抽取 ────────────────────────────────────────────────
    _rule("2/6 抽取")
    cfg = llm_config()
    journal = FileJournal(out / "journal")
    blobs = FileBlobStore(out / "blobs")
    rec = Recorder(args.run_id, journal, blobs)
    budget = Budget(tokens=args.max_tokens, usd=args.max_usd)
    backend = OpenAICompatBackend(cfg.base_url, cfg.api_key)
    gw = ModelGateway(backend, rec, routing=gateway_routing(), budget=budget)

    from .kernel.agents import default_agents

    agent = default_agents().get("extractor")
    skills = default_library()
    system = agent.render_system(skills) + "\n\n" + skills.load(list(agent.skills))

    corpus = _render_corpus(index, args.evidence_top_k)
    comp = await gw.call(
        "EXTRACT", f"从下面的材料中抽取业务对象、属性与关系。\n\n{corpus}",
        system=system, difficulty=Difficulty.HIGH,
        schema=agent.output_schema, max_tokens=args.extract_tokens)
    oir = _build_oir(comp.data or {})
    _p(f"  模型 {comp.model} · {comp.usage.tok_in}→{comp.usage.tok_out} tok · "
       f"${comp.usd:.4f}")
    _p(f"  抽出 {oir.stats()}")

    # ── 3. 对齐 ────────────────────────────────────────────────
    _rule("3/6 实体对齐")
    align, merge_log = align_and_apply(oir)
    _p(f"  {align.summary()}")
    for m in merge_log:
        _p(f"  合并 {m['merged']} → {m['into']}（别名保留 {m['aliases_kept']}）")
    for s in align.uncertain[:5]:
        _p(f"  {WARN} 存疑 {s.a} ~ {s.b}  总分 {s.total:.2f}  {'；'.join(s.reasons[:2])}")

    # ── 4. 冲突 ────────────────────────────────────────────────
    _rule("4/6 冲突检测")
    conflicts = detect_all(oir, endpoints=endpoints, profiles=profiles)
    repaired = auto_repair(oir, conflicts)
    kinds: dict[str, int] = {}
    for c in conflicts:
        kinds[str(c.kind)] = kinds.get(str(c.kind), 0) + 1
    _p(f"  {len(conflicts)} 条 {kinds}")
    _p(f"  自动修 {len(repaired)} 处（可逆、已记账）")

    # ── 5. 澄清 ────────────────────────────────────────────────
    _rule("5/6 澄清排序")
    cs = ClarificationEngine(max_questions=args.max_questions).rank(conflicts, oir)
    _p(f"  {cs.summary()}")
    for q in cs.questions:
        _p(f"\n  ── {q.title}")
        _p(f"     影响 {q.impact} 个实体 · 得分 {q.score:.3f} · "
           f"{'不可逆' if not q.reversible else '可逆'}")
        for o in q.options:
            cites = "、".join(e.cite() for e in o.evidence[:2])
            _p(f"       ○ {o.label}" + (f"\n         出处 {cites}" if cites else ""))

    # ── 6. 模板 ────────────────────────────────────────────────
    _rule("6/6 编译模板")
    spec = compile_template(oir, conflicts, round_no=args.round)
    xlsx = write_xlsx(spec, out / f"模板_v{args.round}.xlsx", project=args.project)
    spec_path = spec.save(out / "template.spec.json")
    st = spec.stats()
    _p(f"  {xlsx}")
    _p(f"  {st['total_cells']} 格 · 预填 {st['prefill_rate']:.0%} · "
       f"业务必填 {st['business_required']} · 责任人 {st['owners']}")

    report = {
        "corpus": summary, "oir": oir.stats(), "align": align.summary(),
        "conflicts": [c.to_dict() for c in conflicts], "auto_repaired": repaired,
        "clarifications": [q.to_dict() for q in cs.questions],
        "routing": cs.summary(), "template": st,
        "budget": budget.snapshot(),
    }
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "oir.json").write_text(
        json.dumps(oir.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")

    _rule("产物")
    _p(f"  模板     {xlsx}")
    _p(f"  规格     {spec_path}　（审回传时要用）")
    _p(f"  OIR      {out / 'oir.json'}")
    _p(f"  报告     {out / 'report.json'}")
    _p(f"  事件日志 {out / 'journal'}/{args.run_id}.jsonl")
    _p(f"\n  账单 {budget.snapshot()['spent']['tokens']:.0f} tokens · "
       f"${budget.snapshot()['spent']['usd']:.4f}")
    await backend.aclose()
    return 0


# ══════════════════════════════════════════════════════════════════
#  audit
# ══════════════════════════════════════════════════════════════════
def cmd_audit(args: argparse.Namespace) -> int:
    from .onto.template import TemplateSpec

    spec = TemplateSpec.load(args.spec)
    oir_path = Path(args.spec).with_name("oir.json")
    oir = _load_oir(oir_path) if oir_path.exists() else None

    result = ReturnAuditor(target=args.target).audit(
        spec, read_returned(args.returned), oir=oir)

    _rule(f"回传审核 · 完成度 {result.completeness:.0%}（达标线 {args.target:.0%}）")
    _p(f"  比对 {len(result.diffs)} 格 · 改动 "
       f"{sum(1 for d in result.diffs if d.changed)} 格")
    _p(f"  问题 {result.counts}")
    _p(f"  自动修 {len(result.auto_repaired)} 处")
    if result.unmatched_rows:
        _p(f"  {WARN} 回传件里缺了 {len(result.unmatched_rows)} 行："
           f"{result.unmatched_rows[:6]}")
    if result.new_rows:
        _p(f"  {WARN} 回传件里多了 {len(result.new_rows)} 行（业务方新增）")

    if result.slips:
        _rule("打回单")
        for slip in result.slips:
            _p(f"\n  {slip.owner} · {len(slip.items)} 项")
            for kind, items in slip.to_dict()["by_kind"].items():
                _p(f"    {kind}（{len(items)}）")
                for it in items[:3]:
                    _p(f"      · {it}")

    if oir is not None:
        merged, dropped = merge_into_oir(oir, result.diffs)
        _p(f"\n  写回 OIR {len(merged)} 处（原样交回的预填不算填写）")
        if dropped:
            # 读到了却没地方放，必须报出来。不报的话填表的人以为答案生效了、
            # FDE 看到完成度上升，而模型里什么都没变。
            _p(f"  {WARN} 另有 {len(dropped)} 处填了但没有回写路径：")
            for it in dropped[:6]:
                _p(f"      · {it}")

    out = Path(args.returned).with_suffix(".audit.json")
    out.write_text(json.dumps(result.summary(), ensure_ascii=False, indent=1),
                   encoding="utf-8")
    _p(f"\n  审核结果 {out}")

    passed = result.completeness >= args.target and not result.slips
    _p(f"\n  {OK + ' 达标，可进入发布门' if passed else WARN + ' 未达标，需再走一轮'}")
    return 0 if passed else 2


# ══════════════════════════════════════════════════════════════════
#  辅助
# ══════════════════════════════════════════════════════════════════
def _expand(patterns: list[str]) -> list[Path]:
    out: list[Path] = []
    for pat in patterns:
        p = Path(pat)
        if p.is_dir():
            out.extend(sorted(x for x in p.rglob("*") if x.is_file()))
        elif p.exists():
            out.append(p)
        else:
            out.extend(sorted(Path().glob(pat)))
    return [p for p in out if p.is_file() and not p.name.startswith("~$")]


def _render_corpus(index: Any, top_k: int) -> str:
    """把索引渲染成抽取用的语料。

    按文件分组呈现，每个文件都给到名额 —— 抽取要看到全部来源，不是最相关的
    那几片。这与检索场景（要精准）刚好相反。
    """
    from collections import defaultdict

    by_file: dict[str, list] = defaultdict(list)
    for cid in sorted(index._chunks):  # noqa: SLF001 — 抽取阶段要全量，不是检索
        c = index._chunks[cid]
        by_file[c.file_name].append(c)

    parts = []
    for fname, chunks in by_file.items():
        chunks.sort(key=lambda c: c.order)
        body = "\n".join(f"⟦{c.cite()}⟧ {c.render}" for c in chunks[:top_k])
        more = f"\n（本文件另有 {len(chunks) - top_k} 个切片未展示）" if len(chunks) > top_k else ""
        parts.append(f"## {fname}\n{body}{more}")
    return "\n\n".join(parts)


def _build_oir(data: dict[str, Any]) -> OIR:
    """LLM 抽取结果 → OIR。结构组装是确定性的，不交给模型。"""
    oir = OIR()
    by_api: dict[str, str] = {}

    for o in data.get("objects", ()):
        ev = _prov(o.get("source_file", ""), o.get("source_locator", ""),
                   o.get("display_name", ""))
        rid = make_rid("ot", o["api_name"])
        oir.add_object(ObjectType(
            rid=rid, api_name=extracted(o["api_name"], ev),
            display_name=extracted(o.get("display_name") or o["api_name"], ev),
            description=extracted(o["description"], ev) if o.get("description")
            else inferred(""),
            primary_key=inferred([])))
        by_api[o["api_name"].lower()] = rid

    for i, p in enumerate(data.get("properties", ())):
        parent = by_api.get(str(p.get("parent_api_name", "")).lower())
        if parent is None:
            continue
        ev = _prov(p.get("source_file", ""), p.get("source_locator", ""),
                   p.get("definition") or p.get("display_name", ""))
        try:
            bt = BaseType(p.get("base_type", "STRING"))
        except ValueError:
            bt = BaseType.STRING
        oir.add_property(PropertyType(
            rid=make_rid("pt", f"{p['parent_api_name']}_{p['api_name']}_{i}"),
            parent=parent,
            api_name=extracted(p["api_name"], ev),
            display_name=extracted(p.get("display_name") or p["api_name"], ev),
            base_type=extracted(bt, ev),
            definition=extracted(p.get("definition", ""), ev),
            unit=extracted(p["unit"], ev) if p.get("unit") else inferred(None),
            required=inferred(bool(p.get("required")))))

    for l in data.get("links", ()):
        src = by_api.get(str(l.get("from_api_name", "")).lower())
        tgt = by_api.get(str(l.get("to_api_name", "")).lower())
        if not src or not tgt:
            continue
        ev = _prov(l.get("source_file", ""), l.get("source_locator", ""), l["api_name"])
        try:
            card = Cardinality(l.get("cardinality", "ONE_TO_MANY"))
        except ValueError:
            card = Cardinality.ONE_TO_MANY
        oir.add_link(LinkType(
            rid=make_rid("lt", l["api_name"]), api_name=extracted(l["api_name"], ev),
            source=src, target=tgt, cardinality=extracted(card, ev),
            join_key=inferred(None)))

    # 主键：名字以 id 结尾的第一个属性作候选。确定性启发式，不问模型。
    for o in oir.objects.values():
        pk = [r for r in o.properties
              if oir.properties[r].api_name.value.lower().endswith("id")]
        if pk:
            o.primary_key = inferred(pk[:1])
    return oir


#: 模型返回的表格定位串，形如 ``业务对象实体梳理!R5`` 或 ``Sheet1!R5-8``。
_SHEET_ROW = re.compile(r"^(?P<sheet>[^!]+)!R?(?P<a>\d+)(?:\s*[-~]\s*R?(?P<b>\d+))?")


def _prov(file_name: str, locator: str, snippet: str) -> Provenance:
    """把模型给的定位串映射成结构化 locator。

    **解析不了就用 RAW 原样保留，绝不硬塞进结构化字段。** 塞错字段会把出处
    渲染成乱码（``实体梳理.xlsx!!R业务对象实体梳理!R5-5C``），而出处渲染错
    等于「点回原文」这个承诺失效 —— 那是这个产品的立身之本。
    """
    low = (file_name or "").lower()
    # 模型常常把文件名一起写进 locator（"实体梳理.xlsx!Sheet!R5"）。
    # 不剥掉就会渲染成 "实体梳理.xlsx#实体梳理.xlsx!Sheet!R5"。
    locator = (locator or "").strip()
    if file_name and locator.startswith(file_name):
        locator = locator[len(file_name):].lstrip("#!:/ ")
    loc: dict[str, Any]
    if low.endswith((".ddl", ".sql")):
        loc = {"kind": "ddl", "object": locator}
    elif low.endswith((".json", ".yaml", ".yml")):
        loc = {"kind": "json", "pointer": locator}
    elif low.endswith((".xlsx", ".xlsm", ".csv", ".tsv")) and (
            m := _SHEET_ROW.match(locator or "")):
        a, b = int(m.group("a")), int(m.group("b") or m.group("a"))
        loc = {"kind": "range", "sheet": m.group("sheet"), "rows": [a, b]}
    elif low.endswith(".docx"):
        loc = {"kind": "page", "page": 1, "bbox": [0, 0, 0, 0], "section": locator}
    else:
        loc = {"kind": "raw", "ref": locator or "未标注位置"}
    return Provenance(f"f_{(file_name or 'x')[:6]}", file_name or "未知来源",
                      loc, snippet=snippet, extractor="llm", confidence=0.8)


def _load_oir(path: Path) -> OIR:
    """从 oir.json 读回。只恢复审核需要的字段。"""
    from .onto.oir import Assertion, Origin

    d = json.loads(path.read_text(encoding="utf-8"))
    oir = OIR()

    def asrt(x: dict) -> Assertion:
        return Assertion(x["value"], Origin(x["origin"]), [], x.get("confidence", 0.5))

    for o in d.get("objects", ()):
        oir.add_object(ObjectType(
            rid=o["rid"], api_name=asrt(o["apiName"]), display_name=asrt(o["displayName"]),
            description=asrt(o["description"]), primary_key=asrt(o["primaryKey"]),
            properties=list(o.get("properties", ())), aliases=list(o.get("aliases", ())),
            owner=o.get("owner")))
    for p in d.get("properties", ()):
        oir.properties[p["rid"]] = PropertyType(
            rid=p["rid"], parent=p["parent"], api_name=asrt(p["apiName"]),
            display_name=asrt(p["displayName"]), base_type=asrt(p["baseType"]),
            definition=asrt(p["definition"]), owner=p.get("owner"))
    return oir


# ══════════════════════════════════════════════════════════════════
#  账号
# ══════════════════════════════════════════════════════════════════
async def cmd_useradd(args: argparse.Namespace) -> int:
    """建一个登录账号。**首个管理员只能用它创建** —— 没有公开的 bootstrap 路由，
    杜绝"谁先访问谁当管理员"的抢注竞态。助手绝不代设密码。"""
    import getpass
    import os
    import uuid
    from pathlib import Path

    from .auth import hash_password, normalize_username
    from .store.engine import Store, database_url
    from .store.repo import DuplicateUsername, UserRow, build_repo

    username = normalize_username(args.username)
    if not username:
        _p(f"{BAD} 用户名不能为空")
        return 1

    # 密码来源：--password-stdin（脚本/CI）读一行；否则交互式两次确认。
    if args.password_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = getpass.getpass("设置密码: ")
        if pw != getpass.getpass("再输一次: "):
            _p(f"{BAD} 两次输入不一致")
            return 1
    if not pw:
        _p(f"{BAD} 密码不能为空")
        return 1

    url = database_url()
    if url:
        store = await Store.open(url)
    else:
        root = Path(os.getenv("ONTOCOPILOT_WORKSPACE", "workspace"))
        root.mkdir(parents=True, exist_ok=True)
        url = f"sqlite+aiosqlite:///{(root / 'ontocopilot.db').resolve()}"
        store = await Store.open(url, create_all=True)
    repo = build_repo(store)
    role = "admin" if args.admin else "user"
    try:
        await repo.create_user(UserRow(
            id=uuid.uuid4().hex, username=username,
            password_hash=hash_password(pw), role=role))
        _p(f"{OK} 已创建{role}账号：{username}")
        return 0
    except DuplicateUsername:
        _p(f"{BAD} 用户名已存在：{username}")
        return 1
    finally:
        await store.close()


# ══════════════════════════════════════════════════════════════════
#  入口
# ══════════════════════════════════════════════════════════════════
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="ontocopilot", description="面向 FDE 的本体建模副驾")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("doctor", help="检查配置、模型连通性、沙箱隔离等级")
    d.add_argument("--production", action="store_true", help="按生产配置检查沙箱")
    d.set_defaults(fn=cmd_doctor, is_async=True)

    p = sub.add_parser("parse", help="只解析材料，看看读到了什么")
    p.add_argument("files", nargs="+")
    p.add_argument("--dialect", default=None, help="SQL 方言，默认自动")
    p.add_argument("--json", default=None, help="把解析概览写到这个文件")
    p.set_defaults(fn=cmd_parse, is_async=False)

    b = sub.add_parser("build", help="全流程：解析→抽取→对齐→冲突→澄清→模板")
    b.add_argument("files", nargs="+")
    b.add_argument("-o", "--out", default="out", help="产物目录")
    b.add_argument("--project", default="", help="项目代号（会写进模板首页）")
    b.add_argument("--round", type=int, default=1, help="第几轮")
    b.add_argument("--run-id", default="run_build", help="Run 标识，用于事件日志")
    b.add_argument("--dialect", default=None)
    b.add_argument("--max-questions", type=int, default=3)
    b.add_argument("--evidence-top-k", type=int, default=60,
                   help="每份材料最多送多少切片给抽取")
    b.add_argument("--extract-tokens", type=int, default=12000)
    b.add_argument("--max-tokens", type=int, default=2_000_000)
    b.add_argument("--max-usd", type=float, default=5.0)
    b.set_defaults(fn=cmd_build, is_async=True)

    a = sub.add_parser("audit", help="审业务方回传的模板")
    a.add_argument("spec", help="build 产出的 template.spec.json")
    a.add_argument("returned", help="业务方回传的 xlsx")
    a.add_argument("--target", type=float, default=0.95, help="达标线")
    a.set_defaults(fn=cmd_audit, is_async=False)

    u = sub.add_parser("useradd", help="创建登录账号（首个管理员只能用它创建）")
    u.add_argument("username")
    u.add_argument("--admin", action="store_true", help="创建为管理员")
    u.add_argument("--password-stdin", action="store_true",
                   help="从标准输入读一行作为密码（脚本/CI 用），否则交互式输入")
    u.set_defaults(fn=cmd_useradd, is_async=True)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return asyncio.run(args.fn(args)) if args.is_async else args.fn(args)
    except KeyboardInterrupt:
        _p("\n已中断")
        return 130
    except Exception as exc:  # noqa: BLE001 — CLI 边界，给人看得懂的错误
        _p(f"\n{BAD} {type(exc).__name__}: {exc}")
        if "--debug" in sys.argv:
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
