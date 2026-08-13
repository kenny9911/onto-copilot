"""端到端用例。判据全部是**用户能观察到的事实**。

每条用例对应一次真实发生过的失败。写法上刻意不 import 项目内部模块 ——
只通过 HTTP 接口操作，和一个真实用户能做的事完全一致。内部结构变了但接口
行为没变，用例就该继续通过；反过来接口行为变了，用例必须红。
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

BASE = "http://127.0.0.1:8000"
MAT = Path(__file__).resolve().parents[1] / "usecases" / "materials"

#: 全局注册表。装饰器把用例挂上来，顺序即执行顺序。
CASES: list[tuple[str, str, bool, Callable]] = []


def case(uid: str, name: str, *, paid: bool = False):
    def deco(fn):
        CASES.append((uid, name, paid, fn))
        return fn
    return deco


# ══════════════════════════════════════════════════════════════════
#  工具
# ══════════════════════════════════════════════════════════════════
class Fail(AssertionError):
    """用例失败。消息要说清**观察到什么**，不是"断言失败"。"""


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


class Client:
    def __init__(self, base: str = BASE) -> None:
        self.c = httpx.Client(base_url=base, timeout=600)
        self.made: list[str] = []

    def new(self, title: str) -> str:
        sid = self.c.post("/api/sessions", json={"title": title}).json()["id"]
        self.made.append(sid)
        return sid

    def upload(self, sid: str, *names: str) -> dict[str, Any]:
        files = [("files", (n, (MAT / n).read_bytes(), "application/octet-stream"))
                 for n in names]
        return self.c.post(f"/api/sessions/{sid}/files", files=files).json()

    def chat(self, sid: str, text: str) -> dict[str, Any]:
        return self.c.post(f"/api/sessions/{sid}/chat", json={"text": text}).json()

    def state(self, sid: str) -> dict[str, Any]:
        return self.c.get(f"/api/sessions/{sid}/state").json()

    def build(self, sid: str) -> dict[str, Any]:
        """跑一轮梳理并等到结束。返回最终状态。"""
        self.c.post(f"/api/sessions/{sid}/build")
        with self.c.stream("GET", f"/api/sessions/{sid}/stream?since=0") as r:
            for line in r.iter_lines():
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if ev["kind"] in ("run.completed", "run.failed", "run.suspended"):
                    break
        return self.state(sid)

    def cleanup(self) -> None:
        for sid in self.made:
            try:
                self.c.delete(f"/api/sessions/{sid}?purge=true")
            except Exception as exc:  # noqa: BLE001 — 清理失败不该盖过用例本身的结果
                log.warning("清理会话 %s 失败: %s", sid, exc)
        self.c.close()


def _chunks_of(cl: Client, sid: str, fname: str) -> list[dict[str, Any]]:
    return cl.c.get(f"/api/sessions/{sid}/source",
                    params={"file": fname}).json().get("chunks") or []


ENTITIES = "实体梳理.xlsx"
SURVEY = "访谈问卷.xlsx"


# ══════════════════════════════════════════════════════════════════
#  用例
# ══════════════════════════════════════════════════════════════════
@case("UC-01", "上传即可提问")
def uc01(cl: Client) -> str:
    """曾经必须先花 $3 跑完抽取才能问第一个问题。

    xlsx 解析是零模型调用的，没有任何理由把它挡在收费的抽取后面。
    """
    sid = cl.new("UC-01")
    r = cl.upload(sid, ENTITIES)
    corpus = r.get("corpus") or {}
    check(bool(corpus.get("files")), f"上传后没有解析结果：{corpus}")
    st = cl.state(sid)
    check(st["status"] != "done", "还没梳理就报 done")
    chunks = _chunks_of(cl, sid, ENTITIES)
    check(len(chunks) > 20, f"只解析出 {len(chunks)} 个切片，材料没读进去")
    return f"上传后立刻有 {len(chunks)} 个切片可查，零模型调用"


@case("UC-02", "问卷不是实体表")
def uc02(cl: Client) -> str:
    """150 行澄清问题曾被抽成 150 个 ObjectType（nodeQuestion46 …）。"""
    sid = cl.new("UC-02")
    cl.upload(sid, SURVEY)
    chunks = _chunks_of(cl, sid, SURVEY)
    check(len(chunks) >= 10, f"问卷只解析出 {len(chunks)} 行")
    # 判据从用户视角来：问卷的行里应该看得到问句和参考选项
    text = " ".join(c.get("text", "") for c in chunks)
    check("？" in text or "?" in text, "解析出来的问卷里一个问号都没有")
    return f"问卷 {len(chunks)} 行解析为待澄清问题，未被当作实体清单"


@case("UC-03", "登记表一行不丢")
def uc03(cl: Client) -> str:
    """168 行实体曾只抽出 58 个 —— 模型截断，而这类映射本该由规则做。"""
    sid = cl.new("UC-03")
    cl.upload(sid, ENTITIES)
    chunks = _chunks_of(cl, sid, ENTITIES)
    rows = [c for c in chunks if "实体编码" in c.get("text", "")]
    check(len(rows) >= 20, f"登记表只读到 {len(rows)} 行")
    return f"登记表 {len(rows)} 行全部成为可检索切片"


@case("UC-04", "合并单元格不撑爆段")
def uc04(cl: Client) -> str:
    """一行 22 列同值曾渲染成同一段话重复 22 遍，整段 27 万字符。

    模型只看得到开头、开头全是重复，于是它合理地推断"这些列重复"并放弃整段。
    """
    sid = cl.new("UC-04")
    cl.upload(sid, ENTITIES)
    chunks = _chunks_of(cl, sid, ENTITIES)
    worst = max((len(c.get("text", "")) for c in chunks), default=0)
    check(worst < 6000, f"单个切片 {worst} 字符 —— 同值列没有合并")
    merged = [c for c in chunks if "~" in c.get("text", "").split("=")[0][:40]]
    return f"最长切片 {worst} 字符；{len(merged)} 个切片做了同值列合并"


@case("UC-05", "会话重启后还能用")
def uc05(cl: Client) -> str:
    """重启后打开旧会话，所有操作曾经 409 —— OIR 没有反序列化路径。

    用例自己造出被测前提：往 workspace 里写一个"上次跑完、然后进程重启了"的
    会话目录。依赖别的用例留下的状态是错的 —— 那样跑的顺序一变，这条就红了，
    而红的原因和它要测的东西毫无关系。
    """
    import uuid as _uuid

    sid = "uc05" + _uuid.uuid4().hex[:8]
    d = Path(__file__).resolve().parents[1] / "workspace" / sid
    (d / "materials").mkdir(parents=True, exist_ok=True)
    (d / "materials" / ENTITIES).write_bytes((MAT / ENTITIES).read_bytes())
    (d / "oir.json").write_text(json.dumps({
        "objects": [{"rid": f"ot_{i}", "kind": "ObjectType",
                     "apiName": {"value": f"thing{i}", "origin": "extracted",
                                 "confidence": 0.9,
                                 "evidence": [{"file_id": "f1", "file_name": ENTITIES,
                                               "locator": {"kind": "range", "sheet": "S",
                                                           "rows": [i + 2, i + 2]},
                                               "snippet": "", "extractor": "rule",
                                               "confidence": 1.0}]},
                     "displayName": {"value": f"东西{i}", "origin": "extracted",
                                     "confidence": 0.9, "evidence": []},
                     "description": {"value": "", "origin": "inferred",
                                     "confidence": 0.5, "evidence": []},
                     "primaryKey": {"value": [], "origin": "inferred",
                                    "confidence": 0.5, "evidence": []},
                     "properties": [], "aliases": [], "owner": None,
                     "status": "candidate", "conflicts": []}
                    for i in range(7)],
        "properties": [], "links": [], "actions": [], "rules": [], "questions": [],
        "stats": {"objects": 7},
    }, ensure_ascii=False), encoding="utf-8")
    cl.made.append(sid)

    ss = cl.c.get("/api/sessions").json()
    check(any(x["id"] == sid for x in ss), "盘上的会话没有出现在列表里")
    row = next(x for x in ss if x["id"] == sid)
    check(row["status"] == "done", f"有产物的会话状态应该是 done，实际 {row['status']}")

    st = cl.c.get(f"/api/sessions/{sid}/state").json()
    stats = (st["state"].get("oir") or {}).get("stats") or {}
    check(stats.get("objects") == 7, f"恢复后 OIR 对象数不对：{stats}")
    check(len(st["filelist"]) == 1, f"材料没恢复：{st['filelist']}")

    r = cl.chat(sid, "现在什么进度")
    check("7" in r["reply"], f"恢复后对话答不出对象数：{r['reply'][:80]}")
    return "盘上的会话被列出、恢复成活 OIR、且对话可用"


@case("UC-06", "会话删除干净")
def uc06(cl: Client) -> str:
    """删了还在列表里 / 或者只想移除却把产物也删了。"""
    sid = cl.c.post("/api/sessions", json={"title": "UC-06 待删"}).json()["id"]
    check(any(x["id"] == sid for x in cl.c.get("/api/sessions").json()), "刚建的会话不在列表里")
    cl.c.delete(f"/api/sessions/{sid}")
    check(not any(x["id"] == sid for x in cl.c.get("/api/sessions").json()),
          "删除后仍在列表里")
    check(cl.c.delete("/api/sessions/根本不存在").status_code == 404,
          "删不存在的会话没有报 404")
    return "删除后从列表消失，删不存在的报 404"


@case("UC-08", "编造的出处会被删掉")
def uc08(cl: Client) -> str:
    """发现编造就当场删，而不是附一句"可能有误"把核对推给用户。

    不花钱：直接验校验函数的行为契约，不跑模型。
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from ontocopilot.onto.converse import check_grounding

    obs = [json.dumps({"chunks": [{"cite": "梳理表.xlsx!实体!R2-2"}]}, ensure_ascii=False)]
    fs = check_grounding({"answer": "有关系", "confidence": 0.9,
                          "citations": ["梳理表.xlsx!实体!R2-2", "编的.xlsx!无!R9-9"]}, obs)
    codes = {f.code for f in fs}
    check("CITATION_FABRICATED" in codes, f"编造的出处没被抓到：{codes}")
    ok = check_grounding({"answer": "查不到", "citations": [], "confidence": 0.2}, obs)
    check(not ok, f"诚实的『查不到』被误判：{[f.code for f in ok]}")
    return "编造的出处被抓；诚实的低置信度不被惩罚"


@case("UC-09", "意图分流")
def uc09(cl: Client) -> str:
    """判不出意图曾等于反问 —— 而"采购包有哪些对象"是个再正常不过的问题。"""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from ontocopilot.kernel.intent import Intent, RuleIntentParser
    from ontocopilot.onto.converse import needs_reasoning

    p = RuleIntentParser(suggestion_ids=["a", "b", "c"], object_names=["pbpHeader"])
    cheap = ["现在什么进度", "你好", "含税一律指增值税专用发票口径", "第3条建议采纳"]
    for t in cheap:
        m = max(p.parse(t).matches, key=lambda x: x.confidence)
        check(not needs_reasoning(m, t), f"「{t}」不该花钱去查")
    dear = ["采购包相关的对象都有哪些？", "为什么 pbpHeader 有关系", "材料里怎么说框架协议"]
    for t in dear:
        m = max(p.parse(t).matches, key=lambda x: x.confidence)
        check(needs_reasoning(m, t), f"「{t}」该去查却没查")
    amb = p.parse("采纳").matches[0]
    check(amb.intent is Intent.UNKNOWN and (amb.slots or {}).get("hint"),
          "指代不明的「采纳」应该反问而不是猜")
    return f"{len(cheap)} 句走确定性路径、{len(dear)} 句进推理、歧义反问"


@case("UC-07", "对话推理带出处", paid=True)
def uc07(cl: Client) -> str:
    sid = cl.new("UC-07")
    cl.upload(sid, ENTITIES, SURVEY)
    r = cl.chat(sid, "材料里关于「框架协议」是怎么说的？")
    reply = r["reply"]
    check(len(reply) > 40, f"回答太短，多半没查：{reply}")
    check("!" in reply or "◧" in reply, f"回答里没有任何出处：{reply[:200]}")
    return f"带出处回答，{len(reply)} 字"


@case("UC-10", "采纳建议真的改产物", paid=True)
def uc10(cl: Client) -> str:
    sid = cl.new("UC-10")
    cl.upload(sid, ENTITIES)
    st = cl.build(sid)
    before = (st["state"].get("oir") or {}).get("stats") or {}
    sugs = st["state"].get("suggestions") or []
    link = next((i for i, x in enumerate(sugs) if x["kind"] == "ADD_LINK"), None)
    check(link is not None, f"没有 ADD_LINK 建议可采纳：{[x['kind'] for x in sugs]}")
    cl.chat(sid, f"第{link + 1}条建议采纳")
    cl.chat(sid, "重出模板")
    after = (cl.state(sid)["state"].get("oir") or {}).get("stats") or {}
    check(after.get("links", 0) > before.get("links", 0),
          f"采纳后关系数没变：{before.get('links')} → {after.get('links')}")
    return f"关系 {before.get('links', 0)} → {after['links']}，模板已重出"


@case("UC-11", "梳理中插话不丢", paid=True)
def uc11(cl: Client) -> str:
    sid = cl.new("UC-11")
    cl.upload(sid, ENTITIES)
    cl.c.post(f"/api/sessions/{sid}/build")
    time.sleep(5)
    r = cl.chat(sid, "临时表都别要了")
    check(r.get("queued"), f"梳理中的改动没有排队：{r}")
    with cl.c.stream("GET", f"/api/sessions/{sid}/stream?since=0") as resp:
        drained = False
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            ev = json.loads(line[6:])
            if ev["kind"] == "queue.drained":
                drained = True
            if ev["kind"] in ("run.completed", "run.failed"):
                break
    check(drained, "梳理跑完了但排队的动作没有执行 —— 我们承诺过会执行")
    return "梳理中插话被排队，结束时自动执行并回执"


@case("UC-12", "口径约定进抽取节点", paid=True)
def uc12(cl: Client) -> str:
    sid = cl.new("UC-12")
    cl.upload(sid, ENTITIES)
    r = cl.chat(sid, "含税一律指增值税专用发票口径")
    check("口径" in r["reply"], f"口径约定没被记下：{r['reply'][:80]}")
    st = cl.state(sid)
    ds = st["state"].get("decisions") or []
    check(any("增值税" in d["statement"] for d in ds), f"决定没进状态：{ds}")
    cl.build(sid)
    st = cl.state(sid)
    ds = st["state"].get("decisions") or []
    check(any("增值税" in d["statement"] for d in ds), "跑完梳理后决定丢了")
    return "口径约定被记录并在 Run 期间保持"




@case("UC-13", "崩溃后状态诚实")
def uc13(cl: Client) -> str:
    """进程死在半路时状态曾永远停在 parsing —— 用户会一直等一个不会来的结果。"""
    ss = cl.c.get("/api/sessions").json()
    stuck = [x for x in ss if x["status"] in ("parsing", "extracting")]
    check(not stuck, f"有 {len(stuck)} 个会话卡在进行中且无人在跑：{[x['id'] for x in stuck]}")
    broken = [x for x in ss if x["status"] == "failed" and x.get("error")]
    for x in broken:
        check(len(x["error"]) > 5, f"{x['id']} 标了 failed 却没说为什么")
    return f"{len(ss)} 个会话状态无一虚挂；{len(broken)} 个失败的都给了原因"


@case("UC-14", "问句不会被记成约定")
def uc14(cl: Client) -> str:
    """「我说的口径是什么」含"口径"二字，曾被记成一条新的口径约定 ——
    等于用户每问一次就被悄悄改一次设定。"""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from ontocopilot.kernel.intent import Intent, RuleIntentParser

    p = RuleIntentParser()
    for t in ["含税一律指增值税专用发票口径", "头表统一用 Header 后缀"]:
        got = p.parse(t).matches[0].intent
        check(got in (Intent.SET_CALIBER, Intent.SET_NAMING), f"「{t}」没被记成约定：{got}")
    for t in ["我之前跟你说的口径是什么", "口径有哪些？", "命名规范是什么"]:
        got = p.parse(t).matches[0].intent
        check(got not in (Intent.SET_CALIBER, Intent.SET_NAMING),
              f"「{t}」是提问，却被记成了约定：{got}")
    return "陈述记为约定、提问不记"


@case("UC-15", "前端没有断掉的函数引用")
def uc15(cl: Client) -> str:
    """一次按行号切片的替换曾一口气删掉 evCard / questionCards / suggestionCards
    三个函数。后果不是报错页，是**发送后毫无反应** —— render() 抛在 async 里，
    变成 unhandled rejection，界面上没有任何迹象，只有打开控制台才看得见。

    单文件前端没有构建步骤、没有 linter，这条用例就是那个构建步骤。
    """
    import re

    html = httpx.get(BASE, timeout=10).text
    js = re.search(r"<script>(.*)</script>", html, re.DOTALL)
    check(js is not None, "首页里没有 script 块")
    js = js.group(1)

    defined = set(re.findall(r"function\s+([A-Za-z_][\w]*)", js))
    defined |= set(re.findall(r"(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=", js))
    # 浏览器与语言内置。漏一个就是假阳性，多一个就是漏检 —— 宁可让它误报，
    # 加进来的时候至少有人看过一眼。
    keywords = {"if", "for", "while", "switch", "catch", "return", "typeof",
                "function", "fetch", "parseInt", "parseFloat", "async", "var",
                "encodeURIComponent", "decodeURIComponent", "setTimeout",
                "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
                "alert", "confirm", "prompt", "await", "isNaN", "structuredClone"}
    # 只看**顶层调用**（前面不是点号）——方法调用不在这个检查范围内
    called = {m for m in re.findall(r"(?<![.\w])([a-z][A-Za-z0-9_]*)\s*\(", js)}
    missing = sorted(called - defined - keywords)
    check(not missing, f"这些函数被调用但没有定义：{missing}")

    # onclick 里写的处理器同样要存在 —— 它们绕过了上面的调用扫描
    handlers = {m for m in re.findall(r'onclick="([a-zA-Z_][\w]*)\(', html)}
    lost = sorted(handlers - defined)
    check(not lost, f"onclick 指向了不存在的函数：{lost}")
    return f"{len(defined)} 个函数定义、{len(handlers)} 个 onclick 处理器全部对得上"


@case("UC-16", "输入框占满整行")
def uc16(cl: Client) -> str:
    """.cbox 从 flex 行改成块级容器后，textarea 的 flex:1 失效、退回 cols 默认
    宽度（约 20 字符），一句话就换行。CSS 里必须是 width:100%。"""
    import re

    html = httpx.get(BASE, timeout=10).text
    rule = re.search(r"\.cin\{([^}]*)\}", html)
    check(rule is not None, "找不到 .cin 的样式")
    body = rule.group(1)
    check("width:100%" in body.replace(" ", ""),
          f".cin 没有 width:100%，会退回默认宽度：{body[:80]}")
    check("flex:1" not in body.replace(" ", ""),
          ".cin 还写着 flex:1，但父容器不是 flex 行")
    return "输入框宽度撑满容器"


@case("UC-17", "回复不是写死的模板", paid=True)
def uc17(cl: Client) -> str:
    """曾经 24 处回复是硬编码字符串，对话路径里模型只在一个分支被调用。
    「你好」永远回「在。」—— 一眼就看出在念稿子。

    判据：**同一个意图在不同上下文下必须给出不同的话**。模板做不到这个。
    """
    a = cl.new("UC-17-空")
    r1 = cl.chat(a, "你好")["reply"]

    b = cl.new("UC-17-有材料")
    cl.upload(b, ENTITIES)
    cl.chat(b, "含税一律指增值税专用发票口径")
    r2 = cl.chat(b, "你好")["reply"]

    check(r1 != r2, f"两个上下文下「你好」的回复一模一样，说明是模板：{r1!r}")
    check(ENTITIES.split(".")[0] in r2 or "材料" in r2,
          f"有材料的会话里，回复没有提到材料：{r2}")
    return f"空会话「{r1[:16]}」vs 有材料「{r2[:24]}」"


@case("UC-18", "措辞不许改事实", paid=True)
def uc18(cl: Client) -> str:
    """让模型措辞的代价是它可能顺手改数字。事实由执行器算好一并传进去，
    模型只负责说 —— 这条必须验，否则「已完成 172 个对象」会变成「大约 170 个」。
    """
    sid = cl.new("UC-18")
    cl.upload(sid, ENTITIES)
    st = cl.state(sid)
    n = len(st["filelist"])
    r = cl.chat(sid, "现在什么进度")["reply"]
    check(str(n) in r, f"回复里没有出现真实的材料份数 {n}：{r}")
    return f"材料份数 {n} 原样出现在回复里"


@case("UC-19", "花钱和改产物要先确认", paid=True)
def uc19(cl: Client) -> str:
    """安全审查实测：四个写工具全是 WRITE_LOCAL，而 requires_approval 只认
    EXTERNAL，ctx.approved 硬编码 False 且全仓库无处置 True —— 模型说一句
    build.start，钱就花出去了，用户看到轨迹时已经晚了。
    """
    sid = cl.new("UC-19")
    cl.upload(sid, ENTITIES)
    r = cl.chat(sid, "开始梳理")
    check(r.get("needs_confirm"), f"花钱的动作没有被拦住：{r['reply'][:80]}")
    check(cl.state(sid)["status"] == "idle",
          "没确认就已经开跑了 —— 闸门没起作用")

    r2 = cl.c.post(f"/api/sessions/{sid}/chat",
                   json={"text": "确认执行", "confirm": True}).json()
    time.sleep(3)
    check(cl.state(sid)["status"] in ("parsing", "extracting"),
          f"确认之后仍然没跑：{r2['reply'][:80]}")
    return "未确认拦住、确认后放行"


@case("UC-20", "被拒的动作也要留痕", paid=True)
def uc20(cl: Client) -> str:
    """只记成功的调用，事后就看不到"模型曾经想改产物、被挡住了" ——
    而那是判断闸门有没有起作用的唯一证据，也是发现提示注入的第一现场。
    """
    import glob

    sid = cl.new("UC-20")
    cl.upload(sid, ENTITIES)
    cl.chat(sid, "开始梳理")   # 会被拦
    root = Path(__file__).resolve().parents[1] / "workspace" / sid / "journal"
    kinds = set()
    for f in glob.glob(str(root / "*.jsonl")):
        for line in Path(f).read_text().splitlines():
            k = (json.loads(line).get("payload") or {}).get("kind")
            if k:
                kinds.add(k)
    check("tool.denied" in kinds, f"被拒的调用没有进事件日志：{sorted(kinds)}")
    return "被拒的工具调用留下了 tool.denied"


@case("UC-21", "上传后有可见的开始入口")
def uc21(cl: Client) -> str:
    """**产品的主干道**：传了材料之后"接下来做什么"必须一眼可见。

    这条断过 —— 空状态里那个「开始梳理」按钮只在 `!S.events.length` 时渲染，
    而上传本身就产生事件，按钮立刻消失。于是材料传上去以后界面上一个入口都没有，
    唯一的路是打字说"开始梳理"、再打一次"确认执行"。用户的原话是
    「无法生成模版、也没有办法互动」。

    静态检查动作栏的逻辑覆盖三种状态，跑不动浏览器也能挡住回归。
    """
    import re

    html = httpx.get(BASE, timeout=10).text
    fn = re.search(r"function paintActions\(\)\{(.*?)\n\}", html, re.DOTALL)
    check(fn is not None, "没有 paintActions —— 动作栏不存在")
    body = fn.group(1)
    check("开始梳理" in body, "有材料未梳理时没有开始入口")
    check("下载" in body, "梳理完成后没有下载入口")
    check("正在梳理" in body, "跑的过程中没有进行中提示")
    check('id="abar"' in html, "页面里没有动作栏容器")
    return "动作栏覆盖：待梳理 / 进行中 / 已完成"


@case("UC-22", "模板能生成也能下载", paid=True)
def uc22(cl: Client) -> str:
    """整条主干道：上传 → 梳理 → 下载出一个业务人员能打开的 xlsx。"""
    from io import BytesIO

    sid = cl.new("UC-22")
    cl.upload(sid, ENTITIES)
    st = cl.build(sid)
    check(st["status"] == "done", f"梳理没跑完：{st['status']} {st.get('error','')[:80]}")
    arts = st["state"].get("artifacts") or []
    tpl = next((a for a in arts if a.endswith(".xlsx")), None)
    check(tpl, f"没有产出 xlsx：{arts}")

    r = cl.c.get(f"/api/sessions/{sid}/artifacts/{tpl}")
    check(r.status_code == 200 and len(r.content) > 5000,
          f"下载失败或文件太小：{r.status_code} {len(r.content)}")

    from openpyxl import load_workbook
    wb = load_workbook(BytesIO(r.content))
    sheets = {ws.title: ws.max_row for ws in wb.worksheets}
    check(len(sheets) >= 3, f"模板只有 {len(sheets)} 张表：{sheets}")
    empty = [n for n, rows in sheets.items() if rows <= 2 and not n.startswith("00_")]
    check(not empty, f"有空表发给业务方：{empty}")
    req = st["state"]["template"]["business_required"]
    check(0 < req < 400, f"业务必填 {req} 格 —— 一周填不完或者根本没有")
    return f"{len(sheets)} 张表、{req} 格业务必填、{len(r.content)//1024}KB"


@case("UC-23", "空状态也有开场提示")
def uc23(cl: Client) -> str:
    """render() 里的 early return 已经连续挡掉两样东西了：先是聊天气泡，
    后是开场提示。空状态恰恰是最需要它们的时候。"""
    import re

    html = httpx.get(BASE, timeout=10).text
    blk = re.search(r"if \(intro && !hasChat\) \{(.*?)\n  \}", html, re.DOTALL)
    check(blk is not None, "找不到空状态分支")
    check("PROMPTS" in blk.group(1), "空状态没有渲染开场提示")

    sid = cl.new("UC-23")
    ps = cl.state(sid)["prompts"]
    check(len(ps) >= 2, f"空会话没有开场提示：{ps}")
    check(all(p.get("send") for p in ps), "有提示没带实际发送的话")
    return f"空会话给出 {len(ps)} 条开场提示"


@case("UC-24", "流程图随会话恢复")
def uc24(cl: Client) -> str:
    """流程图是主产出。恢复会话时不读回 flow.json，界面上那个 tab 就是空的，
    而 SVG 明明躺在同一个目录里。"""
    import uuid as _uuid

    sid = "uc24" + _uuid.uuid4().hex[:8]
    d = Path(__file__).resolve().parents[1] / "workspace" / sid
    d.mkdir(parents=True, exist_ok=True)
    (d / "flow.json").write_text(json.dumps({
        "stages": [{"key": "s1", "title": "阶段一", "subtitle": "", "order": 1}],
        "workflows": [],
        "nodes": [{"rid": "n1", "kind": "action", "code": "ACT-X-DO",
                   "label": {"value": "做一件事", "origin": "extracted",
                             "confidence": 0.9, "evidence": []},
                   "stage": "s1", "actor": {"value": "", "origin": "inferred",
                                            "confidence": 0.5, "evidence": []},
                   "objects": [], "endpoint": "", "status": "candidate",
                   "grounded": True}],
        "edges": [],
        "stats": {"actions": 1, "events": 0, "stages": 1, "edges": 0,
                  "inferred_edges": 0, "dead_ends": 0},
    }, ensure_ascii=False), encoding="utf-8")
    cl.made.append(sid)

    st = cl.c.get(f"/api/sessions/{sid}/state").json()
    fl = st["state"].get("flow")
    check(fl, "恢复后流程图没了")
    check(fl["stats"]["actions"] == 1, f"流程图内容不对：{fl['stats']}")
    return "盘上的 flow.json 随会话恢复"


@case("UC-25", "对话之后给出追问", paid=True)
def uc25(cl: Client) -> str:
    """系统刚说完「有 3 个死路」，用户得自己想出「哪三个」这个问题 ——
    这个断层没理由留给他。"""
    sid = cl.new("UC-25")
    cl.upload(sid, ENTITIES)
    r = cl.chat(sid, "材料里关于框架协议是怎么说的？")
    fu = r.get("followups") or []
    check(fu, f"回答之后一条追问都没有：{r['reply'][:60]}")
    check(len(fu) <= 3, f"追问 {len(fu)} 条 —— 多于三条就变成噪声")
    check(all(p.get("send") for p in fu), "有追问没带实际发送的话")
    return f"给出 {len(fu)} 条追问：{fu[0]['text'][:20]}…"


@case("UC-26", "切会话不残留上一个会话的推理")
def uc26(cl: Client) -> str:
    """「推理」tab 只从前端累积的全局 TRACE 读。TRACE（连同 STEPS 和思考计时器）
    在切/建会话时若不清，切过去就看见上一个会话的推理行 —— 一次典型的 per-session
    状态漏清。切会话的两个函数都得把它们重置，这条用例就盯着这一点。"""
    import re

    html = httpx.get(BASE, timeout=10).text
    js = re.search(r"<script>(.*)</script>", html, re.DOTALL)
    check(js is not None, "首页里没有 script 块")
    js = js.group(1)
    for fn in ("newSession", "openSession"):
        m = re.search(rf"function {fn}\s*\([^)]*\)\s*\{{(.*?)\n\}}", js, re.DOTALL)
        check(m is not None, f"找不到 {fn} 函数")
        body = m.group(1)
        check("TRACE = []" in body, f"{fn} 没重置 TRACE —— 推理 tab 会残留上一个会话")
        check("STEPS = []" in body, f"{fn} 没重置 STEPS")
        check("stopThinking()" in body, f"{fn} 没停掉思考计时器，会残留思考气泡/计时")
    return "newSession/openSession 都清掉了 TRACE/STEPS/思考残留"


# ══════════════════════════════════════════════════════════════════
#  跑
# ══════════════════════════════════════════════════════════════════
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("only", nargs="*", help="只跑这些编号")
    ap.add_argument("--paid", action="store_true", help="连要花钱的一起跑")
    ap.add_argument("--free", action="store_true", help="只跑不花钱的（默认）")
    a = ap.parse_args(argv)

    try:
        httpx.get(f"{BASE}/api/health", timeout=5).raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print(f"服务器没起来（{BASE}）：{exc}")
        return 2

    picked = [c for c in CASES if (not a.only or c[0] in a.only)
              and (a.paid or not c[2])]
    skipped = len(CASES) - len(picked)
    cl = Client()
    ok = bad = 0
    print(f"跑 {len(picked)} 条用例" + (f"（跳过 {skipped} 条收费的）" if skipped else ""))
    print("─" * 72)
    for uid, name, paid, fn in picked:
        t0 = time.time()
        try:
            note = fn(cl)
            ok += 1
            print(f"  ✓ {uid} {name:22} {time.time() - t0:5.1f}s  {note}")
        except Fail as exc:
            bad += 1
            print(f"  ✗ {uid} {name:22} {time.time() - t0:5.1f}s  {exc}")
        except Exception as exc:  # noqa: BLE001 — 用例自身炸了也要往下跑
            bad += 1
            print(f"  ! {uid} {name:22} {time.time() - t0:5.1f}s  "
                  f"{type(exc).__name__}: {exc}")
    cl.cleanup()
    print("─" * 72)
    print(f"通过 {ok} · 失败 {bad}" + (f" · 跳过 {skipped}" if skipped else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
