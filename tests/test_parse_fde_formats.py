"""FDE 前线高频流程材料的金标解析：PPTX 与 BPMN 2.0。"""

from __future__ import annotations

import zipfile

from ontocopilot.onto.parse import BpmnParser, PptxParser, build_index, default_registry


def _write_minimal_pptx(path) -> None:
    slide = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
    notes = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>
 <p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>
 <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>
 <a:t>ERP 顾问确认：冻结客户不得发货</a:t></a:r></a:p></p:txBody>
 </p:sp></p:spTree></p:cSld></p:notes>"""
    relationships = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
  Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"""
    core = """<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties
 xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
 <dc:creator>Customer A</dc:creator><cp:lastModifiedBy>FDE B</cp:lastModifiedBy>
 <dc:title>Order Process</dc:title>
</cp:coreProperties>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/slides/slide1.xml", slide)
        archive.writestr("ppt/slides/_rels/slide1.xml.rels", relationships)
        archive.writestr("ppt/notesSlides/notesSlide1.xml", notes)
        archive.writestr("docProps/core.xml", core)


def test_pptx_extracts_slide_text_table_notes_and_metadata(tmp_path):
    path = tmp_path / "前线访谈.pptx"
    _write_minimal_pptx(path)

    doc = default_registry().parse(path)

    assert doc.kind == "pptx"
    assert isinstance(default_registry().for_path(path), PptxParser)
    assert doc.structured["slide_count"] == 1
    slide = doc.structured["slides"][0]
    assert slide["title"] == "订单履约流程"
    assert slide["tables"][0]["columns"] == ["步骤", "责任人"]
    assert slide["tables"][0]["data"] == [["信用检查", "财务"]]
    assert "冻结客户不得发货" in slide["notes"]
    assert doc.meta["creator"] == "Customer A"
    assert any(f.kind == "metadata_leak" and f.severity == "warn" for f in doc.findings)

    body = "\n".join(chunk.render for chunk in doc.chunks)
    assert "每个订单必须通过信用检查" in body
    assert "步骤=信用检查" in body and "责任人=财务" in body
    assert "ERP 顾问确认" in body
    assert all(chunk.locator["kind"] == "page" for chunk in doc.chunks)
    assert all(chunk.locator["page"] == 1 for chunk in doc.chunks)
    assert any("rule" in chunk.tags for chunk in doc.chunks if "信用检查" in chunk.render)
    assert any("speaker_notes" in chunk.tags and chunk.locator["notes"]
               for chunk in doc.chunks)


def test_pptx_content_is_searchable_with_page_evidence(tmp_path):
    path = tmp_path / "流程访谈.pptx"
    _write_minimal_pptx(path)
    doc = default_registry().parse(path)

    hits = build_index([doc]).search("冻结客户 发货", top_k=3, expand=0)

    assert hits and "冻结客户不得发货" in hits[0].render
    assert hits[0].cite().endswith("#p1")


def test_pptx_page_locator_follows_presentation_order_not_part_number(tmp_path):
    path = tmp_path / "reordered.pptx"
    presentation = """<p:presentation
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:sldIdLst><p:sldId id="256" r:id="rSecond"/><p:sldId id="257" r:id="rFirst"/>
 </p:sldIdLst></p:presentation>"""
    relationships = """<Relationships
 xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rFirst"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
  Target="slides/slide1.xml"/>
 <Relationship Id="rSecond"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
  Target="slides/slide2.xml"/>
</Relationships>"""

    def slide(text):
        return f"""<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
 <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
 <p:spPr/><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld></p:sld>"""

    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/presentation.xml", presentation)
        archive.writestr("ppt/_rels/presentation.xml.rels", relationships)
        archive.writestr("ppt/slides/slide1.xml", slide("物理 part 一"))
        archive.writestr("ppt/slides/slide2.xml", slide("业务第一页"))

    doc = default_registry().parse(path)
    business_first = next(chunk for chunk in doc.chunks if "业务第一页" in chunk.render)
    physical_first = next(chunk for chunk in doc.chunks if "物理 part 一" in chunk.render)

    assert business_first.locator["page"] == 1
    assert physical_first.locator["page"] == 2


def test_bpmn_preserves_process_nodes_gateways_conditions_and_edges(tmp_path):
    path = tmp_path / "order.bpmn"
    path.write_text("""<?xml version="1.0" encoding="UTF-8"?>
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
</bpmn:definitions>""", encoding="utf-8")

    doc = default_registry().parse(path)

    assert doc.kind == "bpmn"
    assert isinstance(default_registry().for_path(path), BpmnParser)
    assert doc.meta["target_namespace"] == "urn:test:order"
    assert len(doc.structured["processes"]) == 1
    process = doc.structured["processes"][0]
    assert process["isExecutable"] is True
    assert {node["category"] for node in process["nodes"]} == {"event", "task", "gateway"}
    check = next(node for node in process["nodes"] if node["id"] == "check-credit")
    assert check["lanes"] == [{"id": "finance", "name": "财务"}]
    start = next(node for node in process["nodes"] if node["id"] == "start")
    assert start["event_definitions"] == [{
        "type": "messageEventDefinition",
        "attributes": {"messageRef": "order-message"},
        "text": "",
    }]
    conditional = next(flow for flow in process["sequenceFlows"] if flow["id"] == "f3")
    assert conditional["sourceRef"] == "credit-ok"
    assert conditional["targetRef"] == "ship"
    assert conditional["condition"] == "${creditStatus == 'PASS'}"

    evidence = next(chunk for chunk in doc.chunks if chunk.raw == conditional)
    assert evidence.locator == {
        "kind": "xml",
        "pointer": ('/definitions/process[@id="order-process"]//'
                    'sequenceFlow[@id="f3"]'),
        "process": "order-process",
        "element": "sequenceFlow",
        "id": "f3",
    }
    assert {"sequenceFlow", "relation", "rule"} <= set(evidence.tags)
    assert "信用通过？" in evidence.render and "创建交货单" in evidence.render
    assert evidence.cite().endswith('sequenceFlow[@id="f3"]')


def test_bpmn20_xml_compound_extension_is_dispatched_and_searchable(tmp_path):
    path = tmp_path / "simple.bpmn20.xml"
    path.write_text("""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p1" name="退款流程">
  <startEvent id="s" name="收到退款申请"/>
  <manualTask id="approve" name="业务人员审批退款"/>
  <sequenceFlow id="go" sourceRef="s" targetRef="approve"/>
 </process>
</definitions>""", encoding="utf-8")

    registry = default_registry()
    assert isinstance(registry.for_path(path), BpmnParser)
    doc = registry.parse(path)
    hits = build_index([doc]).search("审批退款", top_k=3, expand=0)

    task_hit = next(hit for hit in hits if hit.locator.get("id") == "approve")
    assert task_hit.locator["element"] == "manualTask"


def test_bpmn_dangling_reference_is_reported_with_locator(tmp_path):
    path = tmp_path / "broken.bpmn"
    path.write_text("""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><task id="known"/>
 <sequenceFlow id="bad" sourceRef="known" targetRef="missing"/></process>
</definitions>""", encoding="utf-8")

    doc = BpmnParser().parse(path, file_id="f-broken")
    finding = next(item for item in doc.findings if item.kind == "dangling_reference")

    assert finding.severity == "warn"
    assert finding.locator["id"] == "bad"
    assert "targetRef='missing'" in finding.message


def test_bpmn_rejects_entity_declarations(tmp_path):
    path = tmp_path / "unsafe.bpmn"
    path.write_text("""<?xml version="1.0"?>
<!DOCTYPE definitions [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><task id="t" name="&secret;"/></process>
</definitions>""", encoding="utf-8")

    doc = BpmnParser().parse(path, file_id="f-unsafe")

    assert not doc.chunks
    assert any(item.kind == "unsafe_xml" and item.severity == "warn"
               for item in doc.findings)
