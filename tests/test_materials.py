"""材料记忆层 —— 解析的**唯一**实现，以及"AI 到底知道文件里有什么"的地基。

在这一层出现之前，解析在三处各写了一遍（上传时的 `_preparse`、梳理管线的 PARSE、
每次开会话的 `_hydrate`），三份产出还不一致：`_chunks` 在一条路上是全文、另一条
是截断到 1500 且多带 `tags`。谁最后跑，谁的形状说了算 —— 这种不一致不会报错，
只会让下游偶尔少看到东西。

这个文件先用**金标准**把现状钉死：重构不许改变 `corpus_summary` / `collect_profiles`
/ `collect_endpoints` / 索引规模中的任何一个。有了这层网，再动那三处才是安全的。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ontocopilot.onto.parse import (
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)


async def _parse(paths: list[Path]):
    return await default_registry().aparse_all(paths)


# ══════════════════════════════════════════════════════════════════
#  金标准：重构前后必须逐项相同
# ══════════════════════════════════════════════════════════════════
async def test_parse_outputs_are_stable_across_refactor(corpus):
    """MaterialStore 重构的验收线。

    这些量是下游一切的输入：切段按语料结构切、抽取按索引查、模板按画像编译。
    其中任何一个变了，产物就变了 —— 而重构**不该**改变产物。
    """
    docs = await _parse(corpus)
    index = build_index(docs)
    summary = corpus_summary(docs)
    profiles = collect_profiles(docs)
    endpoints = collect_endpoints(docs)

    # 形状而非具体数值：数值随 fixture 变，形状不该变
    assert {d.file_name for d in docs} == {p.name for p in corpus}
    assert len(index) > 0
    assert set(summary) >= {"files", "findings"}
    assert isinstance(profiles, dict) and isinstance(endpoints, list)

    # 同一份材料解析两次必须完全一致（解析是纯函数，不许有隐藏状态）
    docs2 = await _parse(corpus)
    assert [d.file_name for d in docs2] == [d.file_name for d in docs]
    assert len(build_index(docs2)) == len(index)
    assert corpus_summary(docs2)["files"] == summary["files"]
    assert collect_profiles(docs2).keys() == profiles.keys()


async def test_chunk_raw_stays_a_dict_through_json(corpus):
    """`Segment.rows()` 靠 `isinstance(c.raw, dict)` 取行。sidecar 落 JSON 再读回来
    如果把 dict 变成别的东西，抽取就会静默少掉整张表的行。"""
    import json

    docs = await _parse(corpus)
    raws = [c.raw for d in docs for c in d.chunks if isinstance(c.raw, dict)]
    assert raws, "语料里应当有带结构化 raw 的切片（xlsx/csv 的行）"
    back = json.loads(json.dumps(raws[:20], ensure_ascii=False, default=str))
    assert all(isinstance(x, dict) for x in back)


async def test_file_id_is_content_addressed_not_name_addressed(corpus):
    """按文件名派生 file_id 的话，两个会话里同名的不同文件会撞成一个 id，
    改个名又会变成"另一份材料"。内容寻址才对得住"点回原文"这个承诺。"""
    from ontocopilot.kernel.ids import sha256_hex

    p = corpus[0]
    want = "f_" + sha256_hex(p.read_bytes())[:12]
    docs = await default_registry().aparse_all([p], file_ids={p.name: want})
    assert docs[0].file_id == want


# ══════════════════════════════════════════════════════════════════
#  材料工具：AI 得能看见文件里有什么
# ══════════════════════════════════════════════════════════════════
async def test_material_tools_expose_the_inventory_and_the_unread_ones(tmp_path,
                                                                       monkeypatch):
    """只给文件名的话，模型分不清一份材料是**内容都在**还是**只登记了文件名**
    （图片没识别时就是后者），于是会对着空气回答。"""
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="mat1")
    s.dir.mkdir(parents=True, exist_ok=True)
    s.files = [{"name": "采购计划.xlsx", "size": 41000, "path": "x"},
               {"name": "流程图.png", "size": 2_300_000, "path": "y"}]
    s.state["_chunks"] = {"采购计划.xlsx": [
        {"cite": "采购计划.xlsx!S!R1", "text": "计划金额 含税", "tags": ["row"]}]}

    reg = server._converse_tools(s)

    class _Ctx:
        approved = True
        pending: list = []

    got = await reg.call("material.list", {}, _Ctx(), scope="converse")
    assert got["材料数"] == 2
    unread = next(r for r in got["材料"] if r["文件"] == "流程图.png")
    assert unread["已读入段数"] == 0 and "尚未" in unread["状态"] or "还没" in unread["状态"]

    # 按名字片段也能查到，且给出下一步怎么查正文
    ins = await reg.call("material.inspect", {"file": "采购计划"}, _Ctx(), scope="converse")
    assert ins["段数"] == 1 and "evidence.search" in ins["下一步"]
    miss = await reg.call("material.inspect", {"file": "不存在"}, _Ctx(), scope="converse")
    assert "error" in miss

    # 清单要进每轮的上下文，而不是只能靠模型主动查
    brief = server._context_brief(s)
    assert "流程图.png" in brief and "尚未识别" in brief
