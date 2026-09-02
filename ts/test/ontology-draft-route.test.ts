/** 挂起态 Ontology DRAFT snapshot：只读编译、虚拟 JSON 与 context 暴露。 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "../src/server/app.js";
import { setRepoForTests } from "../src/store/deps.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeSessionRow } from "../src/store/types.js";

const ROOT = join(tmpdir(), `ontocopilot-ontology-draft-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Session, SESSIONS, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);
const {
  DRAFT_ONTOLOGY_SNAPSHOT_SCHEMA_VERSION,
  registerDraftOntologyRoutes,
} = await import("../src/server/routes/ontology-draft.js");
const { registerContextRoutes } = await import("../src/server/routes/context.js");
type SessionT = InstanceType<typeof Session>;

let repo: MemoryRepo;
let app: Hono<AppEnv>;

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
  registerHydrator(async (sid: string) => {
    throw new HTTPException(404, { message: `没有会话 ${sid}` });
  });
});

afterAll(() => {
  registerHydrator(null);
  setRepoForTests(null);
  SESSIONS.clear();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  repo = new MemoryRepo();
  setRepoForTests(repo);
  SESSIONS.clear();
  app = new Hono<AppEnv>();
  app.onError((error) => {
    if (error instanceof HTTPException) {
      if (error.res !== undefined) return error.getResponse();
      return Response.json({ detail: error.message }, { status: error.status });
    }
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, {
      status: 500,
    });
  });
  registerDraftOntologyRoutes(app);
  registerContextRoutes(app);
});

async function session(id: string): Promise<SessionT> {
  await repo.createSession(makeSessionRow({
    id, title: "待拍板采购流程", status: "awaiting_answer", created: 1_787_000_000,
  }));
  const s = new Session(id, {
    title: "待拍板采购流程", status: "awaiting_answer", created: 1_787_000_000,
  });
  SESSIONS.set(id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

function assertion(value: unknown, origin = "inferred") {
  return { value, origin, confidence: origin === "inferred" ? 0.4 : 0.9, evidence: [] };
}

function addDraftSource(s: SessionT): void {
  s.state["artifact_revision"] = 4;
  s.state["release_state"] = "DRAFT";
  s.state["artifacts"] = [];
  s.state["oir"] = {
    objects: [{
      rid: "ot_order", apiName: assertion("Order"), displayName: assertion("订单"),
      description: assertion(""), primaryKey: assertion([]), properties: [], aliases: [],
      owner: null, status: "candidate", conflicts: [],
    }],
    properties: [], links: [], actions: [], rules: [], questions: [],
  };
  s.state["flow"] = {
    stages: [], workflows: [],
    nodes: [{
      rid: "fn_order_created", kind: "event", label: assertion("订单已创建"), code: "",
      stage: "", actor: assertion(""), objects: ["ot_order"], endpoint: "", status: "candidate",
    }],
    edges: [],
  };
}

describe("GET /api/sessions/:sid/ontology/draft", () => {
  it("SUSPENDED 会话得到真实但不可发布的 snapshot，且 GET 不写任何状态/文件", async () => {
    const s = await session("draft-readonly");
    addDraftSource(s);
    const beforeState = JSON.stringify(s.state);
    const beforeFiles = readdirSync(s.dir);

    const response = await app.request(`/api/sessions/${s.id}/ontology/draft`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body).toMatchObject({
      schemaVersion: DRAFT_ONTOLOGY_SNAPSHOT_SCHEMA_VERSION,
      releaseState: "DRAFT",
      publishable: false,
      counts: {
        dataObjects: 1, events: 1, processNodes: 1, processEdges: 0,
        openGaps: expect.any(Number), resolvedGaps: 0, validationErrors: 0,
      },
      package: {
        schemaVersion: "ontocopilot.ontology-package/1",
        revision: 5,
        baseRevision: 4,
        releaseState: "DRAFT",
        publishable: false,
        validation: { status: "valid_with_gaps" },
      },
    });
    expect(body.package.gaps.map((gap: any) => gap.field)).toEqual(expect.arrayContaining([
      "primaryKeyAttributeIds", "systemOfRecord", "producerAction", "consumerActions", "workflows",
    ]));
    expect(body.artifacts.map((artifact: any) => artifact.name)).toContain("links.draft.json");
    expect(body.artifacts.every((artifact: any) =>
      artifact.virtual === true && artifact.publishable === false)).toBe(true);

    expect(JSON.stringify(s.state)).toBe(beforeState);
    expect(readdirSync(s.dir)).toEqual(beforeFiles);
  });

  it("虚拟 JSON 同时支持 inline preview 与明确 DRAFT download，不进入正式 artifacts", async () => {
    const s = await session("draft-artifact");
    addDraftSource(s);
    const base = `/api/sessions/${s.id}/ontology/draft/artifacts/`;
    const preview = await app.request(`${base}events.draft.json`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("application/json");
    expect(preview.headers.get("content-disposition")).toContain("inline");
    expect(preview.headers.get("x-ontocopilot-release-state")).toBe("DRAFT");
    expect(preview.headers.get("x-ontocopilot-publishable")).toBe("false");
    const document = await preview.json() as Record<string, any>;
    expect(document).toMatchObject({
      schemaVersion: "ontocopilot.ontology-package/1",
      releaseState: "DRAFT",
      view: "events",
      items: [{ kind: "Event", name: "订单已创建" }],
    });

    const download = await app.request(`${base}events.draft.json?download=1`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-disposition")).toContain("events.draft.json");
    expect(s.state["artifacts"]).toEqual([]);
    expect(readdirSync(s.dir)).toEqual([]);
  });

  it("context delivery 暴露虚拟视图，但不把它当 bundle/Release artifact", async () => {
    const s = await session("draft-context");
    addDraftSource(s);
    const response = await app.request(`/api/sessions/${s.id}/context`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    const draft = body.delivery.artifacts.find((item: any) => item.name === "ontology.package.draft.json");
    expect(draft).toMatchObject({
      kind: "ontology_draft", format: "json", virtual: true,
      releaseState: "DRAFT", publishable: false,
    });
    expect(draft.previewUrl).toContain("/ontology/draft/artifacts/");
    expect(body.delivery.bundle.available).toBe(false);
    expect(body.project.releaseState).toBe("DRAFT");
  });

  it("无 OIR/Flow 或未知虚拟文件返回明确错误", async () => {
    const empty = await session("draft-empty");
    const missingSource = await app.request(`/api/sessions/${empty.id}/ontology/draft`);
    expect(missingSource.status).toBe(409);
    expect(await missingSource.json()).toEqual({
      detail: "当前会话尚无 OIR/Flow，无法生成 DRAFT Ontology snapshot",
    });

    const s = await session("draft-not-found");
    addDraftSource(s);
    const missing = await app.request(
      `/api/sessions/${s.id}/ontology/draft/artifacts/not-found.json`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "没有 DRAFT Ontology JSON：not-found.json" });
  });

  it("结构校验错误保留在 200 DRAFT response，不会被 counts 或预览层吞掉", async () => {
    const s = await session("draft-invalid-visible");
    addDraftSource(s);
    const oir = s.state["oir"] as Record<string, any>;
    oir.objects.push({
      ...oir.objects[0],
      displayName: assertion("重复订单", "extracted"),
    });

    const response = await app.request(`/api/sessions/${s.id}/ontology/draft`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.package.validation.status).toBe("invalid");
    expect(body.package.validation.errors).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_ID", severity: "error",
    }));
    expect(body.counts.validationErrors).toBeGreaterThan(0);
    expect(body).toMatchObject({ releaseState: "DRAFT", publishable: false });
  });
});

// ══════════════════════════════════════════════════════════════════
//  「没有可快照的内容」不是「快照失败」
//
//  答复路径每次都会取一次内容哈希写进 Revision.snapshotHash。会话还没有
//  OIR/Flow 时 `buildDraftOntologyPackage` 抛 409 —— 那被上层 catch 之后会
//  变成一条 `revision.snapshot_failed` 告警。
//
//  但「还没有本体可快照」是**正常状态**，不是故障：告警会让人去查一个不存在的
//  故障，而 `revision.diff` 的文案还会指着那条事件说「当时写入失败」。
//  接线层必须先问一句「有东西可快照吗」，而不是拿异常当判断。
// ══════════════════════════════════════════════════════════════════

describe("hasDraftOntologySource（答复快照也用它）", () => {
  it("既没有 OIR 也没有 Flow 时是 false", async () => {
    const { hasDraftOntologySource } = await import("../src/server/routes/ontology-draft.js");
    expect(hasDraftOntologySource({ state: {} } as never)).toBe(false);
  });

  it("有 OIR（私有键或公开投影任一）就是 true", async () => {
    const { hasDraftOntologySource } = await import("../src/server/routes/ontology-draft.js");
    expect(hasDraftOntologySource({ state: { _oir: { objects: {} } } } as never)).toBe(true);
    expect(hasDraftOntologySource({ state: { oir: { objects: [] } } } as never)).toBe(true);
  });

  it("只有 Flow 也算 —— 流程图本身就是可交付的本体内容", async () => {
    const { hasDraftOntologySource } = await import("../src/server/routes/ontology-draft.js");
    expect(hasDraftOntologySource({ state: { flow: { nodes: [] } } } as never)).toBe(true);
  });

  it("空对象不算 —— 一个 `{}` 不是「有本体」", async () => {
    const { hasDraftOntologySource } = await import("../src/server/routes/ontology-draft.js");
    expect(hasDraftOntologySource({ state: { oir: {}, flow: {} } } as never)).toBe(false);
  });
});
