"""BPMN 上传解析后应确定性产出 FlowGraph / flow.json / SVG。"""

from __future__ import annotations

import json

import httpx

from ontocopilot import appconfig, authgate
from ontocopilot.onto.parse import default_registry
from ontocopilot.server import SESSIONS, Session, _build_flow_diagram, app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, SessionRow


async def test_bpmn_builds_flow_json_and_svg_with_conditions_lanes_and_sources(
    tmp_path, monkeypatch,
):
    source = tmp_path / "returns.bpmn"
    source.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <bpmn:process id="returns" name="退货审批" isExecutable="true">
  <bpmn:laneSet id="lanes"><bpmn:lane id="service" name="客服顾问">
   <bpmn:flowNodeRef>review</bpmn:flowNodeRef>
  </bpmn:lane></bpmn:laneSet>
  <bpmn:startEvent id="requested" name="收到退货申请"/>
  <bpmn:userTask id="review" name="审核退货申请"/>
  <bpmn:exclusiveGateway id="approved" name="审批通过？"/>
  <bpmn:serviceTask id="refund" name="ERP 创建退款单"/>
  <bpmn:endEvent id="closed" name="退货流程结束"/>
  <bpmn:sequenceFlow id="f1" sourceRef="requested" targetRef="review"/>
  <bpmn:sequenceFlow id="f2" sourceRef="review" targetRef="approved"/>
  <bpmn:sequenceFlow id="f3" name="通过" sourceRef="approved" targetRef="refund">
   <bpmn:conditionExpression>${decision == 'APPROVE'}</bpmn:conditionExpression>
  </bpmn:sequenceFlow>
  <bpmn:sequenceFlow id="f4" name="拒绝" sourceRef="approved" targetRef="closed"/>
 </bpmn:process>
</bpmn:definitions>""", encoding="utf-8")
    doc = default_registry().parse(source)

    # Session.dir 固定在 workspace；测试把 ROOT 定到临时目录，验证真正的落盘产物。
    from ontocopilot import server

    monkeypatch.setattr(server, "ROOT", tmp_path / "workspace")
    session = Session(id="bpmn-e2e", title="退货流程")
    session.dir.mkdir(parents=True)

    await _build_flow_diagram(session, [doc])

    flow_path = session.dir / "flow.json"
    svg_path = session.dir / "流程图.svg"
    mermaid_path = session.dir / "流程图.mmd"
    assert flow_path.exists() and svg_path.exists() and mermaid_path.exists()
    flow = json.loads(flow_path.read_text(encoding="utf-8"))

    nodes = {node["label"]["value"]: node for node in flow["nodes"]}
    assert set(nodes) == {"收到退货申请", "审核退货申请", "审批通过？",
                          "ERP 创建退款单", "退货流程结束"}
    assert nodes["收到退货申请"]["kind"] == "event"
    assert nodes["审核退货申请"]["kind"] == "action"
    assert nodes["审批通过？"]["kind"] == "gateway"
    assert nodes["退货流程结束"]["kind"] == "terminal"
    assert nodes["审核退货申请"]["actor"]["value"] == "客服顾问"
    lane_key = nodes["审核退货申请"]["stage"]
    lane = next(stage for stage in flow["stages"] if stage["key"] == lane_key)
    assert lane["title"] == "客服顾问"

    conditional = next(edge for edge in flow["edges"] if "APPROVE" in edge["label"])
    assert conditional["kind"] == "cond"
    assert conditional["grounded"] is True
    evidence = conditional["evidence"][0]
    assert evidence["extractor"] == "bpmn"
    assert evidence["confidence"] == 1.0
    assert evidence["file_name"] == "returns.bpmn"
    assert evidence["locator"]["kind"] == "xml"
    assert evidence["locator"]["id"] == "f3"
    assert 'sequenceFlow[@id="f3"]' in evidence["locator"]["pointer"]

    node_evidence = nodes["审核退货申请"]["label"]["evidence"][0]
    assert node_evidence["locator"]["id"] == "review"
    assert node_evidence["extractor"] == "bpmn"
    assert flow["stats"]["actions"] == 2
    assert flow["stats"]["events"] == 1
    assert flow["stats"]["gateways"] == 1
    assert flow["stats"]["terminals"] == 1
    assert flow["stats"]["edges"] == 4
    assert flow["stats"]["inferred_edges"] == 0

    svg = svg_path.read_text(encoding="utf-8")
    assert svg.startswith("<svg")
    assert "审核退货申请" in svg and "审批通过" in svg
    # SVG 为避免边标签互相压住只显示前 8 字符，但条件原文完整保留在 flow.json。
    assert "${decisi" in svg
    assert "flow.bpmn" in [event["kind"] for event in session.events]
    assert {"flow.json", "流程图.svg", "流程图.mmd"} <= set(session.state["artifacts"])


async def test_bpmn_dangling_sequence_flow_is_not_fabricated_into_graph(
    tmp_path, monkeypatch,
):
    source = tmp_path / "broken.bpmn"
    source.write_text("""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p"><task id="known" name="已知步骤"/>
 <sequenceFlow id="bad" sourceRef="known" targetRef="missing"/></process>
</definitions>""", encoding="utf-8")
    doc = default_registry().parse(source)
    from ontocopilot import server

    monkeypatch.setattr(server, "ROOT", tmp_path / "workspace")
    session = Session(id="broken-bpmn")
    session.dir.mkdir(parents=True)

    await _build_flow_diagram(session, [doc])
    flow = json.loads((session.dir / "flow.json").read_text(encoding="utf-8"))

    assert [node["label"]["value"] for node in flow["nodes"]] == ["已知步骤"]
    assert flow["edges"] == []
    assert any(item.kind == "dangling_reference" for item in doc.findings)


async def test_http_upload_and_flow_preview_produces_downloadable_bpmn_artifacts(
    tmp_path, monkeypatch,
):
    """真正走 HTTP 上传 + build；flow_preview 不需要网关，也不进入付费抽取。"""
    from ontocopilot import server

    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path / "workspace")
    monkeypatch.setattr(server, "_ensure_catalog", _noop_catalog)
    monkeypatch.setattr(server, "_gateways", _fake_gateways)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    session = Session(id="http-bpmn", title="HTTP BPMN")
    session.dir.mkdir(parents=True)
    SESSIONS[session.id] = session
    await repo.create_session(SessionRow(id=session.id))
    xml = b"""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="p" name="HTTP Process"><startEvent id="s" name="Start"/>
 <task id="work" name="Do work"/><endEvent id="e" name="Done"/>
 <sequenceFlow id="a" sourceRef="s" targetRef="work"/>
 <sequenceFlow id="b" sourceRef="work" targetRef="e"/></process></definitions>"""
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        ) as client:
            uploaded = await client.post(
                f"/api/sessions/{session.id}/files",
                files={"files": ("frontline.bpmn20.xml", xml, "application/xml")},
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json()["files"][0]["name"] == "frontline.bpmn20.xml"
            started = await client.post(
                f"/api/sessions/{session.id}/build?tier=flow_preview")
            assert started.status_code == 200, started.text
            await session.run_task

            state = (await client.get(f"/api/sessions/{session.id}/state")).json()
            assert state["status"] == "done"
            assert state["state"]["flow"]["stats"]["edges"] == 2
            assert {"flow.json", "流程图.svg", "流程图.mmd"} <= set(
                state["state"]["artifacts"])
            downloaded = await client.get(
                f"/api/sessions/{session.id}/artifacts/flow.json")
            assert downloaded.status_code == 200
            assert downloaded.json()["stats"]["edges"] == 2
    finally:
        set_repo_for_tests(None)
        SESSIONS.clear()
        authgate._ATTEMPTS.clear()
        appconfig._CACHE = {}


async def _noop_catalog():
    return None


class _Backend:
    async def aclose(self):
        return None


def _fake_gateways(_out, _run_id, *, resume=False, **_identity):
    del resume, _identity
    return _Backend(), None, None, None
