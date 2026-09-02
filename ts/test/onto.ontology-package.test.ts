import { describe, expect, it } from "vitest";

import { buildPackage } from "../src/onto/canonical.js";
import {
  ONTOLOGY_PACKAGE_UNKNOWN,
  ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES,
  ONTOLOGY_PACKAGE_V1_JSON_SCHEMA,
  ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
  compileOntologyPackageV1,
  ontologyPackageV1Artifacts,
  resolveOntologyPackageV1Artifact,
  validateOntologyPackageV1,
} from "../src/onto/ontology_package.js";

type Dict = Record<string, unknown>;

function assertion(value: unknown, evidence: readonly unknown[] = [], origin = "extracted") {
  return { value, origin, confidence: origin === "inferred" ? 0.4 : 0.9, evidence };
}

const evidence = {
  file_id: "f-1",
  file_name: "采购方案.docx",
  locator: { kind: "page", page: 4 },
  snippet: "创建采购订单后发布订单已创建事件，仓储服务接收后发送通知。",
  extractor: "document",
  confidence: 0.94,
  cite: "采购方案.docx#p4",
};

function source(): { oir: Dict; flow: Dict } {
  const oir: Dict = {
    objects: [
      {
        rid: "ot_purchase_order",
        apiName: assertion("PurchaseOrder", [evidence]),
        displayName: assertion("采购订单", [evidence]),
        description: assertion("采购订单记录", [evidence]),
        primaryKey: assertion(["pt_order_id"], [evidence]),
        properties: ["pt_order_id"],
        aliases: [], owner: "采购专员", status: "confirmed", conflicts: [],
      },
      {
        rid: "ot_supplier",
        apiName: assertion("Supplier", [evidence]),
        displayName: assertion("供应商", [evidence]),
        description: assertion("供应商主数据", [evidence]),
        primaryKey: assertion(["pt_supplier_id"], [evidence]),
        properties: ["pt_supplier_id"],
        aliases: [], owner: "供应商管理员", status: "confirmed", conflicts: [],
      },
    ],
    properties: [
      {
        rid: "pt_order_id", parent: "ot_purchase_order",
        apiName: assertion("orderId", [evidence]), displayName: assertion("订单编号", [evidence]),
        baseType: assertion("STRING", [evidence]), definition: assertion("订单唯一编号", [evidence]),
        semanticType: assertion(null, [evidence]), unit: assertion(null, [evidence]),
        required: assertion(true, [evidence]), valueDomain: assertion(null, [evidence]),
        status: "confirmed", conflicts: [],
      },
      {
        rid: "pt_supplier_id", parent: "ot_supplier",
        apiName: assertion("supplierId", [evidence]),
        displayName: assertion("供应商编号", [evidence]), baseType: assertion("STRING", [evidence]),
        definition: assertion("供应商唯一编号", [evidence]), semanticType: assertion(null),
        unit: assertion(null), required: assertion(true), valueDomain: assertion(null),
        status: "confirmed", conflicts: [],
      },
    ],
    links: [{
      rid: "lt_order_supplier",
      apiName: assertion("supplier", [evidence]),
      from: "ot_purchase_order", to: "ot_supplier",
      cardinality: assertion("ONE_TO_MANY", [evidence]),
      joinKey: assertion({ supplierId: "supplierId" }, [evidence]),
      status: "confirmed", conflicts: [],
    }],
    actions: [
      {
        rid: "at_create_order", apiName: assertion("createOrder", [evidence]),
        appliesTo: ["ot_purchase_order"], parameters: assertion([], [evidence]),
        effects: assertion(["订单已创建"], [evidence]),
        sourceEndpoint: assertion({
          system: "采购服务", platform: "Foundry",
          method: "POST", path: "/api/orders", operationId: "createOrder",
          database: "procurement", schema: "public", table: "purchase_order",
        }, [evidence]),
        status: "confirmed",
      },
      {
        rid: "at_notify_warehouse", apiName: assertion("notifyWarehouse", [evidence]),
        appliesTo: ["ot_purchase_order"], parameters: assertion([], [evidence]),
        effects: assertion(["仓库已收到通知"], [evidence]),
        sourceEndpoint: assertion({
          system: "仓储服务", platform: "Kubernetes",
          method: "POST", path: "/api/warehouse/notifications", operationId: "notifyWarehouse",
          database: "warehouse", schema: "public", table: "notification",
        }, [evidence]),
        status: "confirmed",
      },
    ],
    rules: [], questions: [],
  };
  const flow: Dict = {
    stages: [{ key: "create", title: "订单创建", subtitle: "", order: 1 }],
    workflows: [{
      key: "order_creation", title: "采购订单创建流程", description: "创建并通知仓储",
      entry: "fn_create_order", exits: ["fn_notify_warehouse"],
    }],
    nodes: [
      {
        rid: "fn_create_order", kind: "action", code: "ACT-ORDER-CREATE",
        label: assertion("createOrder", [evidence]), stage: "create",
        actor: assertion("采购专员", [evidence]), objects: ["ot_purchase_order"],
        endpoint: "/api/orders", status: "confirmed",
      },
      {
        rid: "fn_order_created", kind: "event", code: "EVT-ORDER-CREATED",
        label: assertion("订单已创建", [evidence]), stage: "create",
        actor: assertion("", [], "inferred"), objects: ["ot_purchase_order"],
        endpoint: "", status: "confirmed",
      },
      {
        rid: "fn_notify_warehouse", kind: "action", code: "ACT-WH-NOTIFY",
        label: assertion("notifyWarehouse", [evidence]), stage: "create",
        actor: assertion("仓储系统", [evidence]), objects: ["ot_purchase_order"],
        endpoint: "/api/warehouse/notifications", status: "confirmed",
      },
    ],
    edges: [
      {
        rid: "fe_create_event", from: "fn_create_order", to: "fn_order_created",
        kind: "flow", label: "", evidence: [evidence],
      },
      {
        rid: "fe_event_notify", from: "fn_order_created", to: "fn_notify_warehouse",
        kind: "flow", label: "", evidence: [evidence],
      },
    ],
  };
  return { oir, flow };
}

function unresolvedSource(): { oir: Dict; flow: Dict } {
  return {
    oir: {
      objects: [], properties: [], links: [], rules: [], questions: [],
      actions: [{
        rid: "at_lonely", apiName: assertion("lonelyAction"), appliesTo: [],
        parameters: assertion([]), effects: assertion([]),
        sourceEndpoint: assertion({ path: "/relative/only" }), status: "candidate",
      }],
    },
    flow: {
      stages: [], workflows: [], edges: [],
      nodes: [
        {
          rid: "fn_lonely", kind: "action", code: "ACT-LONELY",
          label: assertion("lonelyAction"), stage: "", actor: assertion(""),
          objects: [], endpoint: "/relative/only", status: "candidate",
        },
        {
          rid: "fn_terminal", kind: "event", code: "EVT-TERMINAL",
          label: assertion("terminalEvent"), stage: "", actor: assertion(""),
          objects: [], endpoint: "", status: "candidate",
        },
      ],
    },
  };
}

describe("ontocopilot.ontology-package/1", () => {
  it("输出具体 DataObject/Link/Action/Event/Workflow 与 producer→event→consumer 绑定", () => {
    const { oir, flow } = source();
    const pkg = compileOntologyPackageV1(oir, flow, {
      packageId: "pkg.procurement",
      revision: 3,
      baseRevision: 2,
      generatedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(pkg.schemaVersion).toBe(ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION);
    expect(pkg).toMatchObject({ releaseState: "DRAFT", publishable: false });
    expect(pkg.dataObjects).toHaveLength(2);
    expect(pkg.dataObjects[0]).toMatchObject({
      kind: "DataObject",
      id: "do.purchase.order",
      primaryKeyAttributeIds: ["attr.order.id"],
      attributes: [{ apiName: "orderId", dataType: "STRING" }],
    });
    expect(pkg.links).toEqual([
      expect.objectContaining({
        kind: "Link",
        id: "link.order.supplier",
        sourceDataObjectId: "do.purchase.order",
        targetDataObjectId: "do.supplier",
        cardinality: "ONE_TO_MANY",
        join: expect.objectContaining({ status: "known", value: { supplierId: "supplierId" } }),
      }),
    ]);

    const producer = pkg.actions.find((item) => item.id === "act.create.order")!;
    const consumer = pkg.actions.find((item) => item.id === "act.notify.warehouse")!;
    const event = pkg.events.find((item) => item.id === "evt.order.created")!;
    expect(producer.emitsEventIds).toEqual([event.id]);
    expect(consumer.consumesEventIds).toEqual([event.id]);
    expect(producer.bindings).toMatchObject({
      role: { status: "known", value: "采购专员" },
      system: { status: "known", value: "采购服务" },
      platform: { status: "known", value: "Foundry" },
      api: { status: "known", method: "POST", path: "/api/orders", operationId: "createOrder" },
      database: {
        status: "known", database: "procurement", schema: "public", table: "purchase_order",
      },
    });
    expect(event).toMatchObject({
      producerState: "known",
      producers: [{ actionId: producer.id }],
      producer: { actionId: producer.id },
      consumerState: "known",
      consumers: [{ actionId: consumer.id }],
    });
    expect(pkg.workflows[0]).toMatchObject({
      kind: "Workflow",
      id: "wf.order.creation",
      actionIds: [producer.id, consumer.id],
      eventIds: [event.id],
    });
    expect(pkg.processNodes).toHaveLength(3);
    expect(pkg.processEdges).toHaveLength(2);
    expect(pkg.workflows[0]!.nodeIds.every((id) =>
      pkg.processNodes.some((node) => node.id === id))).toBe(true);
    expect(pkg.workflows[0]!.edgeIds.every((id) =>
      pkg.processEdges.some((edge) => edge.id === id))).toBe(true);
    expect(pkg.integrations.find((item) => item.actionId === producer.id))
      .toMatchObject({ api: { path: "/api/orders" }, database: { table: "purchase_order" } });
    // DataObject 的 system-of-record 尚无材料，必须显式 unknown + gap/question。
    expect(pkg.dataObjects[0]!.systemOfRecord).toMatchObject({
      status: "unknown", value: ONTOLOGY_PACKAGE_UNKNOWN,
      gapId: expect.stringMatching(/^gap\./), questionId: expect.stringMatching(/^q\./),
    });
    expect(pkg.gaps.length).toBeGreaterThan(0);
    expect(pkg.validation).toMatchObject({ status: "valid_with_gaps", gapCount: pkg.gaps.length });
    expect(pkg.validation.errors).toEqual([]);
  });

  it("缺失 producer/consumer/API/database 时不猜，稳定生成 unknown + gap + question", () => {
    const pkg = compileOntologyPackageV1(
      { objects: [], properties: [], links: [], actions: [], rules: [], questions: [] },
      {
        stages: [], workflows: [],
        nodes: [{
          rid: "fn_lonely_event", kind: "event", label: assertion("孤立事件", [], "inferred"),
          code: "", stage: "", actor: assertion("", [], "inferred"), objects: [], endpoint: "",
          status: "candidate",
        }],
        edges: [],
      },
      { generatedAt: "2026-08-17T00:00:00.000Z" },
    );
    expect(pkg.events[0]).toMatchObject({
      producer: {
        actionId: ONTOLOGY_PACKAGE_UNKNOWN,
        bindings: { api: { value: ONTOLOGY_PACKAGE_UNKNOWN } },
      },
      consumerState: "unknown",
      consumers: [],
    });
    expect(pkg.gaps.map((gap) => gap.field)).toEqual(expect.arrayContaining([
      "producerAction", "consumerActions", "workflows",
    ]));
    expect(pkg.questions.filter((question) => question.origin === "generated_gap").length)
      .toBe(pkg.gaps.length);
  });

  it("JSON Schema 不再用空 object 占位，artifact 接口提供全部虚拟 JSON 视图", () => {
    const defs = ONTOLOGY_PACKAGE_V1_JSON_SCHEMA["$defs"] as Dict;
    const action = defs["action"] as Dict;
    const actionProperties = action["properties"] as Dict;
    expect(Object.keys(defs)).toEqual(expect.arrayContaining([
      "dataObject", "link", "action", "event", "processNode", "processEdge",
      "workflow", "integration", "gap",
    ]));
    expect(actionProperties).toHaveProperty("bindings");
    expect(actionProperties).toHaveProperty("emitsEventIds");

    const { oir, flow } = source();
    const pkg = compileOntologyPackageV1(oir, flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    const artifacts = ontologyPackageV1Artifacts(pkg);
    expect(artifacts.map((item) => item.name)).toEqual(Object.values(ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES));
    expect(JSON.parse(resolveOntologyPackageV1Artifact(
      pkg, ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES.links,
    )!.content)).toMatchObject({
      schemaVersion: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
      releaseState: "DRAFT",
      view: "links",
      items: [{ kind: "Link" }],
    });
    expect(resolveOntologyPackageV1Artifact(pkg, "../secret.json")).toBeNull();
    expect(JSON.parse(resolveOntologyPackageV1Artifact(
      pkg, ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES.workflows,
    )!.content)).toMatchObject({
      view: "workflows",
      processNodes: expect.arrayContaining([expect.objectContaining({ kind: "ProcessNode" })]),
      processEdges: expect.arrayContaining([expect.objectContaining({ kind: "ProcessEdge" })]),
    });
  });

  it("相对 endpoint 只形成 partial API，不会被 legacy 派生标签误认成 known system", () => {
    const input = unresolvedSource();
    const pkg = compileOntologyPackageV1(input.oir, input.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    const action = pkg.actions.find((item) => item.id === "act.lonely")!;
    expect(action.bindings.system).toMatchObject({
      status: "unknown", value: ONTOLOGY_PACKAGE_UNKNOWN,
    });
    expect(action.bindings.api).toMatchObject({
      status: "partial", path: "/relative/only",
      method: ONTOLOGY_PACKAGE_UNKNOWN, operationId: ONTOLOGY_PACKAGE_UNKNOWN,
    });
    expect(pkg.systems).toEqual([]);

    const absolute = structuredClone(input);
    ((absolute.oir["actions"] as Dict[])[0]!["sourceEndpoint"] as Dict)["value"] = {
      method: "POST", path: "https://orders.example.test/v1/orders", operationId: "create",
    };
    const withHost = compileOntologyPackageV1(absolute.oir, absolute.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(withHost.actions.find((item) => item.id === "act.lonely")!.bindings.system)
      .toMatchObject({ status: "known", value: "orders.example.test" });
    expect(withHost.systems).toContainEqual(expect.objectContaining({ name: "orders.example.test" }));
  });

  it("Event 保留全部显式 publisher，且 Action↔Event 双向关系可校验", () => {
    const input = structuredClone(source());
    (input.oir["actions"] as Dict[]).push({
      rid: "at_retry_order", apiName: assertion("retryOrder"), appliesTo: ["ot_purchase_order"],
      parameters: assertion([]), effects: assertion([]),
      sourceEndpoint: assertion({ system: "重试服务", method: "POST", path: "/retry",
        operationId: "retryOrder" }), status: "confirmed",
    });
    (input.flow["nodes"] as Dict[]).push({
      rid: "fn_retry_order", kind: "action", code: "ACT-ORDER-RETRY",
      label: assertion("retryOrder"), stage: "create", actor: assertion("采购专员"),
      objects: ["ot_purchase_order"], endpoint: "/retry", status: "confirmed",
    });
    (input.flow["edges"] as Dict[]).push({
      rid: "fe_retry_event", from: "fn_retry_order", to: "fn_order_created",
      kind: "flow", label: "", evidence: [evidence],
    });
    input.flow["workflows"] = [];
    const pkg = compileOntologyPackageV1(input.oir, input.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    const event = pkg.events.find((item) => item.id === "evt.order.created")!;
    expect(event.producers.map((item) => item.actionId)).toEqual([
      "act.create.order", "act.retry.order",
    ]);
    expect(event.producer.actionId).toBe("act.create.order");
    expect(pkg.actions.find((item) => item.id === "act.retry.order")!.emitsEventIds)
      .toContain(event.id);
    expect(pkg.validation.errors.filter((item) => item.code === "ACTION_EVENT_RECIPROCITY"))
      .toEqual([]);

    const tampered = {
      ...pkg,
      events: pkg.events.map((item) => item.id === event.id
        ? { ...item, producers: item.producers.slice(1) }
        : item),
    };
    expect(validateOntologyPackageV1(tampered).errors.map((item) => item.code))
      .toContain("ACTION_EVENT_RECIPROCITY");
  });

  it("applied Decision/backlog 能关闭 generated gap，claimed 不会吞掉旧结论", () => {
    const input = unresolvedSource();
    const baseline = compileOntologyPackageV1(input.oir, input.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    const gap = (entityType: string, entityId: string, field: string) =>
      baseline.gaps.find((item) => item.entityType === entityType &&
        item.entityId === entityId && item.field === field)!;
    const emits = gap("Action", "act.lonely", "emitsEventIds");
    const platform = gap("Action", "act.lonely", "bindings.platform");
    const database = gap("Action", "act.lonely", "bindings.database");
    const system = gap("Action", "act.lonely", "bindings.system");
    const role = gap("Action", "act.lonely", "bindings.role");
    const terminal = gap("Event", "evt.terminal", "consumerActions");
    const decisions = [
      { id: "dec-emits-old", questionId: emits.questionId, answer: "confirmed_none",
        metadata: { status: "applied" } },
      { id: "dec-emits-claimed", questionId: emits.questionId, answer: "not_applicable",
        supersedes: "dec-emits-old", metadata: { status: "claimed" } },
      { id: "dec-platform", questionId: platform.questionId, answer: "not_applicable",
        metadata: { status: "applied" } },
      { id: "dec-database", questionId: database.questionId, answer: "confirmed_none",
        metadata: { status: "applied" } },
      { id: "dec-system", questionId: system.questionId,
        answer: { status: "resolved", value: "SAP S/4HANA" }, metadata: { status: "applied" } },
      { id: "dec-terminal-old", questionId: terminal.questionId, answer: "confirmed_none",
        metadata: { status: "applied" } },
      { id: "dec-terminal-new", questionId: terminal.questionId, answer: "not_applicable",
        supersedes: "dec-terminal-old", metadata: { status: "applied" } },
    ];
    const pkg = compileOntologyPackageV1(input.oir, input.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
      decisions,
      backlog: { questions: [{
        id: role.questionId, status: "answered",
        metadata: { resolutionStatus: "not_applicable" },
      }] },
    });
    const resolved = (questionId: string) => pkg.gaps.find((item) =>
      item.questionId === questionId)!;
    expect(resolved(emits.questionId)).toMatchObject({
      status: "confirmed_none", sourceDecisionId: "dec-emits-old",
    });
    expect(resolved(platform.questionId).status).toBe("not_applicable");
    expect(resolved(database.questionId).status).toBe("confirmed_none");
    expect(resolved(system.questionId)).toMatchObject({
      status: "resolved", resolutionValue: "SAP S/4HANA", sourceDecisionId: "dec-system",
    });
    expect(resolved(role.questionId).status).toBe("not_applicable");
    expect(resolved(terminal.questionId)).toMatchObject({
      status: "not_applicable", sourceDecisionId: "dec-terminal-new",
    });
    expect(pkg.questions.find((item) => item.id === emits.questionId)?.status).toBe("answered");
    const action = pkg.actions.find((item) => item.id === "act.lonely")!;
    expect(action.emitsEventIds).toEqual([]);
    expect(action.bindings).toMatchObject({
      system: { status: "known", value: "SAP S/4HANA" },
      platform: { status: "not_applicable", value: "none" },
      database: { status: "confirmed_none", value: "none" },
      role: { status: "not_applicable", value: "none" },
    });
    expect(pkg.events.find((item) => item.id === "evt.terminal")!.consumerState)
      .toBe("not_applicable");
    expect(pkg.validation.openGapCount).toBe(baseline.validation.openGapCount - 6);
    expect(pkg.validation.resolvedGapCount).toBeGreaterThanOrEqual(6);
    expect(pkg.validation.warnings.some((item) =>
      item.path.includes(emits.id) || item.path.includes(terminal.id))).toBe(false);
  });

  it("Workflow membership/reachability、PK 与 literal escape 都产生可审计校验", () => {
    const input = source();
    ((input.oir["objects"] as Dict[])[0]!["displayName"] as Dict)["value"] = "采购订单\\n";
    const pkg = compileOntologyPackageV1(input.oir, input.flow, {
      generatedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(pkg.gaps).toContainEqual(expect.objectContaining({
      code: "SUSPICIOUS_LITERAL_ESCAPE", entityType: "PackageInput",
    }));
    const workflow = pkg.workflows[0]!;
    const invalid = {
      ...pkg,
      dataObjects: pkg.dataObjects.map((item, index) => index === 0
        ? { ...item, primaryKeyAttributeIds: ["attr.does.not.exist"] }
        : item),
      workflows: [{ ...workflow, nodeIds: workflow.nodeIds.slice(1) }],
    };
    const codes = validateOntologyPackageV1(invalid).errors.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "PRIMARY_KEY_REF", "WORKFLOW_ENTRY_MEMBER", "WORKFLOW_EDGE_MEMBER",
    ]));
  });

  it("长 Action id 下多个深字段 gap 仍保持一对一，不因 slug 截断而合并", () => {
    const longId = `fn_${"very_long_action_identity_".repeat(4)}`;
    const pkg = compileOntologyPackageV1(
      { objects: [], properties: [], links: [], actions: [], rules: [], questions: [] },
      {
        stages: [], workflows: [], edges: [],
        nodes: [{
          rid: longId, kind: "action", label: assertion("长动作", [], "inferred"), code: "",
          stage: "", actor: assertion("", [], "inferred"), objects: [], endpoint: "",
          status: "candidate",
        }],
      },
      { generatedAt: "2026-08-17T00:00:00.000Z" },
    );
    expect(pkg.gaps.length).toBeGreaterThan(5);
    expect(new Set(pkg.gaps.map((gap) => gap.id)).size).toBe(pkg.gaps.length);
    const generated = pkg.questions.filter((question) => question.origin === "generated_gap");
    expect(new Set(generated.map((question) => question.id)).size).toBe(generated.length);
    expect(pkg.validation.errors).toEqual([]);
  });
});

describe("legacy canonical role/system id collision", () => {
  it("无碰撞 id 保持不变；不同长 identity 碰撞时仅后者追加稳定 hash", () => {
    const commonRole = "超长角色" + "甲".repeat(50);
    const commonPath = "/api/" + "segment".repeat(12);
    const oir: Dict = {
      objects: [], properties: [], links: [], questions: [],
      rules: [
        { rid: "br_1", statement: assertion("规则一"), ruleKind: assertion("AUTHORITY"),
          appliesTo: [], actor: assertion(`${commonRole}一`), status: "confirmed" },
        { rid: "br_2", statement: assertion("规则二"), ruleKind: assertion("AUTHORITY"),
          appliesTo: [], actor: assertion(`${commonRole}二`), status: "confirmed" },
      ],
      actions: [
        { rid: "at_1", apiName: assertion("actionOne"), appliesTo: [], parameters: assertion([]),
          effects: assertion([]), sourceEndpoint: assertion({ path: `${commonPath}/one` }),
          status: "confirmed" },
        { rid: "at_2", apiName: assertion("actionTwo"), appliesTo: [], parameters: assertion([]),
          effects: assertion([]), sourceEndpoint: assertion({ path: `${commonPath}/two` }),
          status: "confirmed" },
      ],
    };
    const first = buildPackage(oir, null, { generatedAt: "2026-08-17T00:00:00.000Z" });
    const second = buildPackage(oir, null, { generatedAt: "2026-08-17T00:00:00.000Z" });
    const roleIds = first.roles.map((item) => item["id"] as string);
    const systemIds = first.systems.map((item) => item["id"] as string);
    expect(new Set(roleIds).size).toBe(2);
    expect(new Set(systemIds).size).toBe(2);
    expect(roleIds.some((id) => /\.h[0-9a-f]{8}$/u.test(id))).toBe(true);
    expect(systemIds.some((id) => /\.h[0-9a-f]{8}$/u.test(id))).toBe(true);
    expect(first.toDict()).toEqual(second.toDict());
    expect(first.validation.passed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  assumed：通用模板与空模板必须在 schema 上有区别
// ══════════════════════════════════════════════════════════════════

describe("三态置信：unknown / assumed / known", () => {
  /** 一份通用草案：节点带执行角色，但**一条证据都没有**。 */
  function genericSource(): { oir: Dict; flow: Dict } {
    const { oir } = source();
    return {
      oir,
      flow: {
        stages: {},
        edges: {},
        nodes: [
          {
            rid: "fn_approve",
            kind: "action",
            code: "ACT-APPROVE",
            label: assertion("审批采购申请"),
            stage: "",
            // 有值、零证据 —— 这正是"行业通识先填"的形状
            actor: { value: "部门负责人", evidence: [] },
            objects: [],
            endpoint: "",
            status: "candidate",
          },
        ],
      },
    };
  }

  it("有值但零证据 → assumed，**带着值同时明说待确认**", () => {
    const { oir, flow } = genericSource();
    const pkg = compileOntologyPackageV1(oir, flow, {
      packageId: "pkg.generic",
      revision: 1,
      generatedAt: "2026-08-18T00:00:00.000Z",
    });
    const roles = pkg.actions
      .map((a) => (a as unknown as Dict)["bindings"] as Dict | undefined)
      .map((i) => (i?.["role"] ?? null) as Dict | null)
      .filter((r): r is Dict => r !== null);

    const assumed = roles.find((r) => r["status"] === "assumed");
    expect(assumed).toBeDefined();
    expect(assumed!["value"]).toBe("部门负责人"); // 值留着 —— 空模板就没有这个
    expect(assumed!["source"]).toBe("generic_assumption"); // 绝不冒充材料抽取
    expect(assumed!["evidenceIds"]).toEqual([]); // 零证据
    expect(assumed!["gapId"]).toBeTruthy(); // gap 照开：assumed ≠ 已解决
  });

  it("带 assumed 的包升 generic_assumed；**不带的仍逐字节是 missing_is_unknown**", () => {
    const generic = compileOntologyPackageV1(genericSource().oir, genericSource().flow, {
      packageId: "p", revision: 1, generatedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(generic.source.assumptionPolicy).toBe("generic_assumed");

    // 材料驱动那份（原 fixture 的 actor 全是空串）不产生 assumed
    const { oir, flow } = source();
    const material = compileOntologyPackageV1(oir, flow, {
      packageId: "p", revision: 1, generatedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(material.source.assumptionPolicy).toBe("missing_is_unknown");
    // 下游只见过这一种，它一个字节都没变
  });

  it("assumed 的问法是「请确认」，unknown 的是「请提供」—— 答起来差一个量级", () => {
    const { oir, flow } = genericSource();
    const pkg = compileOntologyPackageV1(oir, flow, {
      packageId: "p", revision: 1, generatedAt: "2026-08-18T00:00:00.000Z",
    });
    const qs = (pkg as unknown as Dict)["questions"] as Dict[] | undefined;
    const all = JSON.stringify(qs ?? []);
    // 有通识草稿的：点个头或改一个词就行
    expect(all).toContain("请确认");
    expect(all).toContain("部门负责人");
  });

  it("没有值仍然是 unknown —— 三态不能塌回两态", () => {
    const { oir, flow } = source();
    const pkg = compileOntologyPackageV1(oir, flow, {
      packageId: "p", revision: 1, generatedAt: "2026-08-18T00:00:00.000Z",
    });
    const all = JSON.stringify(pkg);
    expect(all).toContain('"status":"unknown"');
    expect(all).not.toContain('"status":"assumed"');
  });
});
