"""presentation / bpmn / vision 三个解析器的 golden —— 输入 + Python 真跑出来的输出。

为什么要单独一份：这三个解析器的输出**全是拼出来的字符串和嵌套 dict**（render
文案、locator 指针、findings 的措辞），手写期望值就是在拿我对 Python 的猜测当
事实。所以这里把输入和输出一起导出，TS 侧一个字都不猜。

三样输入的落法不同，理由各不相同：

  · **PPTX 写成真的 .pptx 文件**（``golden/parse.pptx.*.pptx``）。pptx 是 zip+XML，
    TS 侧要连 zip 一起验；把成员内容塞进 JSON 再由 TS 重新打包，验的就是"我打的
    包"而不是"真的包"。为了**字节确定**，ZipInfo 的时间戳全部钉死在 1980-01-01 ——
    zipfile 默认写当前时间，重跑两次哈希就不一样了。
  · **BPMN 是纯文本 XML**，直接进 JSON，TS 读出来就能喂给解析器。
  · **视觉件写成一张真 PNG**（``golden/parse.vision.page.png``）。识别结果由桩网关
    给定，所以输出与模型无关；但 ``render_pages`` 那一段要走真的文件读取。

关于 PPTX 的一个前提：``PptxParser.parse`` 会先试 ``python-pptx``，本仓库的 .venv
里**没装**，所以真实走的是内置 OOXML 兜底路径（并在 findings[0] 插一条
``parser_fallback``）。TS 侧永远没有 python-pptx，因此这份 golden 同时导出：

    ``ooxml``  ——  直接调 ``_parse_ooxml``，与环境无关，TS 的主实现对着它比；
    ``parse``  ——  ``PptxParser().parse``，含那条 fallback finding；
    ``python_pptx_available`` —— 上面这份是在什么环境下导的。

跑法::

    .venv/bin/python tools/golden/parse_doc.py

输出（全部是新文件，不碰任何已有 golden）::

    golden/parse.doc.json
    golden/parse.pptx.minimal.pptx
    golden/parse.pptx.reordered.pptx
    golden/parse.pptx.noslides.pptx
    golden/parse.pptx.notes-by-number.pptx
    golden/parse.pptx.notzip.pptx
    golden/parse.vision.page.png
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))
GOLDEN = ROOT / "golden"

from ontocopilot.onto.parse.bpmn import BpmnParser  # noqa: E402
from ontocopilot.onto.parse.presentation import (  # noqa: E402
    PptxParser,
    _parse_ooxml,
)
from ontocopilot.onto.parse.vision import VisionParser, _bbox  # noqa: E402

#: 钉死的 zip 时间戳。zipfile 默认写"现在"，那会让每次导出的字节都不一样。
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


# ══════════════════════════════════════════════════════════════════
#  序列化
# ══════════════════════════════════════════════════════════════════
def doc_json(doc: Any) -> dict[str, Any]:
    """ParsedDoc → 纯 JSON。**chunk 的每个字段都要**，TS 侧逐字段比。"""
    return {
        "file_id": doc.file_id,
        "file_name": doc.file_name,
        "kind": doc.kind,
        "meta": doc.meta,
        "structured": doc.structured,
        "findings": [
            {"kind": f.kind, "message": f.message, "locator": f.locator,
             "severity": f.severity}
            for f in doc.findings
        ],
        "chunks": [
            {"chunk_id": c.chunk_id, "file_id": c.file_id, "file_name": c.file_name,
             "locator": c.locator, "render": c.render, "raw": c.raw,
             "order": c.order, "tags": c.tags, "context": c.context}
            for c in doc.chunks
        ],
        "stats": doc.stats(),
    }


def write_zip(path: Path, members: list[tuple[str, str]]) -> None:
    """按给定顺序写 zip。成员顺序进 infolist，解析器的体积闸门按它算。"""
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in members:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text.encode("utf-8"))


# ══════════════════════════════════════════════════════════════════
#  PPTX 素材
# ══════════════════════════════════════════════════════════════════
#: 与 tests/test_parse_fde_formats.py 里那份**一字不差**：标题占位符、正文规则句、
#: 表格、备注、docProps 元数据泄漏，一次覆盖 pptx 解析的五条主路径。
MINIMAL_SLIDE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/>
   <p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
   <p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="300" cy="50"/></a:xfrm></p:spPr>
   <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>订单履约流程</a:t></a:r></a:p></p:txBody>
  </p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
   <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>
    <a:t>每个订单必须通过信用检查后才能发货</a:t>
   </a:r></a:p></p:txBody>
  </p:sp>
  <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/>
   <p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>
   <a:graphic><a:graphicData><a:tbl><a:tblPr/><a:tblGrid/>
    <a:tr><a:tc><a:txBody><a:p><a:r><a:t>步骤</a:t></a:r></a:p></a:txBody></a:tc>
          <a:tc><a:txBody><a:p><a:r><a:t>责任人</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
    <a:tr><a:tc><a:txBody><a:p><a:r><a:t>信用检查</a:t></a:r></a:p></a:txBody></a:tc>
          <a:tc><a:txBody><a:p><a:r><a:t>财务</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
   </a:tbl></a:graphicData></a:graphic>
  </p:graphicFrame>
 </p:spTree></p:cSld>
</p:sld>"""

MINIMAL_NOTES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>
 <p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>
 <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>
 <a:t>ERP 顾问确认：冻结客户不得发货</a:t></a:r></a:p></p:txBody>
 </p:sp>
 <p:sp><p:nvSpPr><p:cNvPr id="9" name="Slide Number"/><p:cNvSpPr/>
 <p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:spPr/>
 <p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld></p:notes>"""

MINIMAL_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
  Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"""

MINIMAL_CORE = """<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties
 xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
 <dc:creator>Customer A</dc:creator><cp:lastModifiedBy>FDE B</cp:lastModifiedBy>
 <dc:title>Order Process</dc:title>
</cp:coreProperties>"""

REORDERED_PRESENTATION = """<p:presentation
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:sldIdLst><p:sldId id="256" r:id="rSecond"/><p:sldId id="257" r:id="rFirst"/>
 </p:sldIdLst></p:presentation>"""

REORDERED_RELS = """<Relationships
 xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rFirst"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
  Target="slides/slide1.xml"/>
 <Relationship Id="rSecond"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
  Target="slides/slide2.xml"/>
</Relationships>"""


def reordered_slide(text: str) -> str:
    return f"""<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
 <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
 <p:spPr/><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld></p:sld>"""


#: 没有 _rels 的极简包 —— 逼 ``_notes_part`` 走"按 slideN 猜 notesSlideN"的兜底；
#: 同时用 ctrTitle 占位符和一个**多段落 + 空文本框**的形状，钉住阅读顺序与
#: ``_clean_text`` 的换行合并。
NOTES_BY_NUMBER_SLIDE = """<p:sld
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
 <p:sp><p:nvSpPr><p:cNvPr id="11" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="7" y="8"/><a:ext cx="9" cy="10"/></a:xfrm></p:spPr>
  <p:txBody><a:p><a:r><a:t>一个客户  最多   持有一个主账户</a:t></a:r></a:p>
  <a:p><a:r><a:t>第二段</a:t></a:r></a:p></p:txBody></p:sp>
 <p:sp><p:nvSpPr><p:cNvPr id="12" name="Empty"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr/><p:txBody><a:p><a:r><a:t>   </a:t></a:r></a:p></p:txBody></p:sp>
 <p:sp><p:nvSpPr><p:cNvPr id="13" name="Center Title"/><p:cNvSpPr/>
  <p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/>
  <p:txBody><a:p><a:r><a:t>账户主数据</a:t></a:r></a:p></p:txBody></p:sp>
 <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:tr><a:tc><a:txBody><a:p><a:r><a:t>字段</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t></a:t></a:r></a:p></a:txBody></a:tc></a:tr>
  <a:tr><a:tc><a:txBody><a:p><a:r><a:t>客户号</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>主键</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
  <a:tr><a:tc><a:txBody><a:p><a:r><a:t></a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t></a:t></a:r></a:p></a:txBody></a:tc></a:tr>
 </a:tbl>
 </p:spTree></p:cSld></p:sld>"""

NOTES_BY_NUMBER_NOTES = """<p:notes
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree>
 <p:sp><p:nvSpPr><p:cNvPr id="3" name="Header"/><p:cNvSpPr/>
  <p:nvPr><p:ph type="hdr"/></p:nvPr></p:nvSpPr><p:spPr/>
  <p:txBody><a:p><a:r><a:t>不该进备注的页眉</a:t></a:r></a:p></p:txBody></p:sp>
 <p:sp><p:nvSpPr><p:cNvPr id="4" name="Notes"/><p:cNvSpPr/>
  <p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>
  <p:txBody><a:p><a:r><a:t>口径以财务台账为准</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld></p:notes>"""


def build_pptx_fixtures() -> dict[str, Path]:
    minimal = GOLDEN / "parse.pptx.minimal.pptx"
    write_zip(minimal, [
        ("ppt/slides/slide1.xml", MINIMAL_SLIDE),
        ("ppt/slides/_rels/slide1.xml.rels", MINIMAL_RELS),
        ("ppt/notesSlides/notesSlide1.xml", MINIMAL_NOTES),
        ("docProps/core.xml", MINIMAL_CORE),
    ])

    reordered = GOLDEN / "parse.pptx.reordered.pptx"
    write_zip(reordered, [
        ("ppt/presentation.xml", REORDERED_PRESENTATION),
        ("ppt/_rels/presentation.xml.rels", REORDERED_RELS),
        ("ppt/slides/slide1.xml", reordered_slide("物理 part 一")),
        ("ppt/slides/slide2.xml", reordered_slide("业务第一页")),
    ])

    noslides = GOLDEN / "parse.pptx.noslides.pptx"
    write_zip(noslides, [("docProps/core.xml", MINIMAL_CORE)])

    by_number = GOLDEN / "parse.pptx.notes-by-number.pptx"
    write_zip(by_number, [
        ("ppt/slides/slide1.xml", NOTES_BY_NUMBER_SLIDE),
        ("ppt/notesSlides/notesSlide1.xml", NOTES_BY_NUMBER_NOTES),
    ])

    notzip = GOLDEN / "parse.pptx.notzip.pptx"
    notzip.write_bytes(b"this is not a zip archive at all\n")

    return {"minimal": minimal, "reordered": reordered, "noslides": noslides,
            "notes_by_number": by_number, "notzip": notzip}


# ══════════════════════════════════════════════════════════════════
#  BPMN 素材
# ══════════════════════════════════════════════════════════════════
BPMN_CASES: list[tuple[str, str, str]] = [
    # (case, 文件名, XML)。文件名进 ParsedDoc.file_name，所以必须钉住。
    ("order", "order.bpmn", """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
 id="defs-order" targetNamespace="urn:test:order">
 <bpmn:process id="order-process" name="订单履约" isExecutable="true">
  <bpmn:documentation>从订单接收到完成发货</bpmn:documentation>
  <bpmn:laneSet id="lanes"><bpmn:lane id="finance" name="财务">
   <bpmn:flowNodeRef>check-credit</bpmn:flowNodeRef>
  </bpmn:lane></bpmn:laneSet>
  <bpmn:startEvent id="start" name="收到订单"><bpmn:outgoing>f1</bpmn:outgoing>
   <bpmn:messageEventDefinition messageRef="order-message"/>
  </bpmn:startEvent>
  <bpmn:userTask id="check-credit" name="信用检查">
   <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
  </bpmn:userTask>
  <bpmn:exclusiveGateway id="credit-ok" name="信用通过？" default="f4">
   <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
   <bpmn:outgoing>f4</bpmn:outgoing>
  </bpmn:exclusiveGateway>
  <bpmn:serviceTask id="ship" name="创建交货单"/>
  <bpmn:endEvent id="done" name="结束"/>
  <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="check-credit"/>
  <bpmn:sequenceFlow id="f2" sourceRef="check-credit" targetRef="credit-ok"/>
  <bpmn:sequenceFlow id="f3" name="通过" sourceRef="credit-ok" targetRef="ship">
   <bpmn:conditionExpression>${creditStatus == 'PASS'}</bpmn:conditionExpression>
  </bpmn:sequenceFlow>
  <bpmn:sequenceFlow id="f4" name="拒绝" sourceRef="credit-ok" targetRef="done"/>
 </bpmn:process>
</bpmn:definitions>"""),

    ("compound", "simple.bpmn20.xml",
     """<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p1" name="退款流程">
  <startEvent id="s" name="收到退款申请"/>
  <manualTask id="approve" name="业务人员审批退款"/>
  <sequenceFlow id="go" sourceRef="s" targetRef="approve"/>
 </process>
</definitions>"""),

    ("dangling", "broken.bpmn",
     """<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><task id="known"/>
 <sequenceFlow id="bad" sourceRef="known" targetRef="missing"/></process>
</definitions>"""),

    ("unsafe", "unsafe.bpmn", """<?xml version="1.0"?>
<!DOCTYPE definitions [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><task id="t" name="&secret;"/></process>
</definitions>"""),

    # 子流程 + 多泳道 + 自定义 *Task/*Gateway/*Event 后缀（走 _category 的 endswith
    # 分支，而不是白名单）+ 无 id 的匿名节点与匿名 flow + 无 process id。
    ("anonymous", "anon.bpmn",
     """<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
 xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
 <process isExecutable="FALSE">
  <laneSet><lane id="l1" name="前台"><flowNodeRef> sub </flowNodeRef>
   <flowNodeRef>sub</flowNodeRef></lane>
   <lane id="l2"><flowNodeRef>sub</flowNodeRef></lane></laneSet>
  <subProcess id="sub" name="子流程" camunda:async="true">
   <documentation>子流程里也有节点</documentation>
   <scriptTask id="inner" name="内层脚本"/>
   <sendTask name="没有 id 的发送任务"/>
  </subProcess>
  <mailTask id="ext" name="扩展任务"/>
  <fancyGateway id="fg"/>
  <weirdEvent id="we"><timerEventDefinition><timeDuration>PT5M</timeDuration>
   </timerEventDefinition></weirdEvent>
  <sequenceFlow sourceRef="sub" targetRef="ext"/>
 </process>
</definitions>"""),

    ("no_process", "empty.bpmn",
     """<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d0"/>"""),

    ("wrong_root", "wrongroot.bpmn",
     """<process xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="p9">
 <task id="t9" name="唯一的任务"/></process>"""),

    ("malformed", "bad.bpmn", """<definitions><process id="p"></definitions>"""),
]


# ══════════════════════════════════════════════════════════════════
#  视觉件素材
# ══════════════════════════════════════════════════════════════════
def write_png(path: Path) -> None:
    """手写一张 4x4 PNG。

    不用 PIL 生成是因为要**字节确定**：PIL 的编码参数随版本变，而这张图的字节
    只是 TS 侧 ``renderPages`` 的输入，内容无关紧要、稳定才重要。
    """
    raw = b"".join(b"\x00" + bytes([(x * 60) % 256 for x in range(4 * 3)])
                   for _ in range(4))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


#: 桩网关返回的一页识别结果。故意塞进四类脏数据：空文本块、只有表头的表、
#: 越界/字符串/缺项的 bbox、没有 label 的关系 —— 这些分支在真实扫描件里天天出现。
OCR_PAGE: dict[str, Any] = {
    "blocks": [
        {"text": "客户主数据", "kind": "title", "bbox": [0.1, 0.05, 0.9, 0.12]},
        {"text": "  ", "kind": "note", "bbox": [0, 0, 1, 1]},
        {"text": "客户号", "kind": "field", "bbox": ["0.2", 0.3, 2.0, -0.5]},
        {"text": "每个客户至多一个主账户", "kind": "paragraph"},
    ],
    "tables": [
        {"caption": "字段表", "rows": [["字段", "类型", "说明"],
                                       ["cust_no", "string", "主键"],
                                       ["name", "string", ""]],
         "bbox": [0.1, 0.4, 0.9, 0.8]},
        {"caption": "只有表头", "rows": [["A", "B"]], "bbox": [0, 0, 1, 1]},
        {"caption": "空表", "rows": [], "bbox": None},
    ],
    "relations": [
        {"from_entity": "客户", "to_entity": "账户", "label": "1:N"},
        {"from_entity": "账户", "to_entity": "流水"},
    ],
}

#: ``_bbox`` 的判据表。每一行都在钉一条 JS 会踩的坑：
#:   · "nan" → Python 的 ``max(0.0, min(1.0, nan))`` 给 **1.0**，而 JS 的
#:     ``Math.max(0, Math.min(1, NaN))`` 给 NaN —— 两语言的 min/max 语义不同；
#:   · 字符串数字要被 ``float()`` 吃掉，纯字母要抛（退回整页）；
#:   · 少于 4 项退回整页，多于 4 项取前 4。
BBOX_CASES: list[Any] = [
    [0.1, 0.2, 0.3, 0.4],
    ["0.25", 2.0, -1, 0.5],
    ["nan", 0, 1, 1],
    ["inf", "-inf", 0.5, 0.5],
    [True, False, 0.5, 0.5],
    [1, 2, 3],
    [0, 0, 1, 1, 9],
    None,
    [],
    "abcd",
    {},
    {"a": 1},
    [None, 0, 1, 1],
    [[0.1], 0, 1, 1],
]


class StubCompletion:
    def __init__(self, data: Any) -> None:
        self.data = data


class StubGateway:
    """只记录被问了什么、按脚本作答的网关。真网关在 kernel/catalog.py。"""

    def __init__(self, script: list[Any]) -> None:
        self.script = script
        self.seen: list[dict[str, Any]] = []

    async def call(self, node_id: str, prompt: str, **kw: Any) -> Any:
        self.seen.append({"node_id": node_id, "prompt": prompt,
                          "needs": sorted(str(c) for c in kw.get("needs", ())),
                          "prefer": kw.get("prefer"),
                          "prefer_models": list(kw.get("prefer_models", ())),
                          "max_tokens": kw.get("max_tokens"),
                          "key": kw.get("key"),
                          "images": len(kw.get("images", ()))})
        item = self.script[min(len(self.seen) - 1, len(self.script) - 1)]
        if isinstance(item, BaseException):
            raise item
        return StubCompletion(item)


def vision_case(png: Path, *, gateway: Any, max_pages: int = 20) -> dict[str, Any]:
    notes: list[str] = []
    parser = VisionParser(gateway, max_pages=max_pages,
                          on_progress=notes.append)
    doc = asyncio.run(parser.aparse(png, file_id="f-vision"))
    out = doc_json(doc)
    # 进度回调的文案也是产物的一部分：一页要几分钟，界面上只有这几行字。
    # 但"第 N 页识别完成（X 秒）"里的秒数每次都不一样，所以把它抹成占位。
    out["progress"] = [n if "秒）" not in n else
                       n.split("（")[0] + "（<秒>）" + n.split("）", 1)[1]
                       for n in notes]
    out["gateway_calls"] = getattr(gateway, "seen", [])
    return out


# ══════════════════════════════════════════════════════════════════
#  主流程
# ══════════════════════════════════════════════════════════════════
def main() -> None:
    GOLDEN.mkdir(exist_ok=True)
    pptx_files = build_pptx_fixtures()
    png = GOLDEN / "parse.vision.page.png"
    write_png(png)

    pptx: dict[str, Any] = {}
    for case, path in pptx_files.items():
        file_id = f"f-pptx-{case}"
        pptx[case] = {
            "file": path.name,
            "ooxml": doc_json(_parse_ooxml(path, file_id=file_id)),
            "parse": doc_json(PptxParser().parse(path, file_id=file_id)),
        }

    bpmn: dict[str, Any] = {}
    tmp = GOLDEN / ".parse_doc_tmp"
    tmp.mkdir(exist_ok=True)
    try:
        for case, name, xml in BPMN_CASES:
            path = tmp / name
            path.write_text(xml, encoding="utf-8")
            bpmn[case] = {
                "file": name,
                "xml": xml,
                "accepts": BpmnParser().accepts(path),
                "doc": doc_json(BpmnParser().parse(path, file_id=f"f-bpmn-{case}")),
            }
    finally:
        for leftover in tmp.iterdir():
            leftover.unlink()
        tmp.rmdir()

    vision = {
        "no_gateway": vision_case(png, gateway=None),
        "ok": vision_case(png, gateway=StubGateway([OCR_PAGE])),
        "empty": vision_case(png, gateway=StubGateway([{}])),
        "none_data": vision_case(png, gateway=StubGateway([None])),
        "page_limit": vision_case(png, gateway=StubGateway([OCR_PAGE]), max_pages=1),
        "lookup_error": vision_case(png, gateway=StubGateway([LookupError("no vision")])),
        "timeout": vision_case(png, gateway=StubGateway([asyncio.TimeoutError()])),
        "other_error": vision_case(png, gateway=StubGateway([ValueError("boom")])),
    }

    payload = {
        "_readme": "由 tools/golden/parse_doc.py 导出。期望值一律取自这里，不要手写。",
        "python_pptx_available": importlib.util.find_spec("pptx") is not None,
        "pptx": pptx,
        "bpmn": bpmn,
        "vision": vision,
        "bbox": [{"raw": raw, "out": _bbox(raw)} for raw in BBOX_CASES],
        "accepts": {
            "pptx": {ext: PptxParser().accepts(Path(f"x{ext}"))
                     for ext in (".pptx", ".pptm", ".ppsx", ".PPTX", ".ppt", ".xml")},
            "bpmn": {name: BpmnParser().accepts(Path(name))
                     for name in ("a.bpmn", "A.BPMN", "a.bpmn20.xml", "a.xml",
                                  "a.bpmn20.XML", "bpmn", "a.bpmnx")},
        },
    }
    out = GOLDEN / "parse.doc.json"
    out.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
