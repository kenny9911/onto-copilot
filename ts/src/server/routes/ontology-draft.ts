/**
 * 挂起态 Ontology Package 的只读 DRAFT snapshot。
 *
 * Engagement 在 INTERVIEW/SUSPENDED 时不会写正式 artifact；这是 Release Gate 的正确
 * 行为，但 FDE 仍然需要看见当前 OIR/Flow 编译出的真实 JSON。本路由只在内存中编译，
 * 不写 session.dir、不更新 artifact_revision、不修改 release_state，也不加入 bundle。
 */

import type { Hono } from "hono";

import {
  ONTOLOGY_PACKAGE_RELEASE_STATE,
  ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES,
  compileOntologyPackageV1,
  resolveOntologyPackageV1Artifact,
  type OntologyPackageV1,
} from "../../onto/ontology_package.js";
import { dropReferenceMemory } from "./projects.js";
import type { AppEnv } from "../app.js";
import { sessAsync, type Session } from "../session.js";
import { contentDisposition } from "./artifacts.js";
import { apiError } from "./sessions.js";

export const DRAFT_ONTOLOGY_SNAPSHOT_SCHEMA_VERSION =
  "ontocopilot.ontology-draft-snapshot/1" as const;

type Dict = Record<string, unknown>;

export interface DraftOntologyArtifactView {
  readonly id: string;
  readonly name: string;
  readonly view: string;
  readonly kind: "ontology_draft";
  readonly format: "json";
  readonly mediaType: "application/json";
  readonly previewable: true;
  readonly virtual: true;
  readonly releaseState: typeof ONTOLOGY_PACKAGE_RELEASE_STATE;
  readonly publishable: false;
  readonly previewUrl: string;
  readonly downloadUrl: string;
}

export interface DraftOntologySnapshotReadModel {
  readonly schemaVersion: typeof DRAFT_ONTOLOGY_SNAPSHOT_SCHEMA_VERSION;
  readonly releaseState: typeof ONTOLOGY_PACKAGE_RELEASE_STATE;
  readonly publishable: false;
  readonly notice: string;
  readonly package: OntologyPackageV1;
  readonly counts: Readonly<Record<string, number>>;
  readonly artifacts: readonly DraftOntologyArtifactView[];
}

export function registerDraftOntologyRoutes(app: Hono<AppEnv>): void {
  app.get("/api/sessions/:sid/ontology/draft", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    return c.json(buildDraftOntologySnapshot(s));
  });

  app.get("/api/sessions/:sid/ontology/draft/artifacts/:name", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const pkg = buildDraftOntologyPackage(s);
    const name = c.req.param("name");
    const artifact = resolveOntologyPackageV1Artifact(pkg, name);
    if (artifact === null) throw apiError(404, `没有 DRAFT Ontology JSON：${name}`);
    const download = ["1", "true", "yes"].includes((c.req.query("download") ?? "").toLowerCase());
    const headers: Record<string, string> = {
      "Content-Type": `${artifact.mediaType}; charset=utf-8`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-OntoCopilot-Release-State": ONTOLOGY_PACKAGE_RELEASE_STATE,
      "X-OntoCopilot-Publishable": "false",
      "Content-Disposition": download
        ? contentDisposition(artifact.name)
        : `inline; filename="${asciiInlineName(artifact.name)}"`,
    };
    return c.body(artifact.content, 200, headers);
  });
}

/**
 * 是否有足够的内存/持久化投影来构建只读 snapshot。
 *
 * 答复路径也用它：每次回答都会取一次内容哈希写进 `Revision.snapshotHash`，
 * 而 {@link buildDraftOntologyPackage} 在没有 OIR/Flow 时抛 409。**拿那个异常
 * 当判据是错的** —— 一次「还没有本体」会被记成 `revision.snapshot_failed` 告警，
 * 但那是正常状态不是故障：人会去查一个不存在的问题，`revision.diff` 的文案
 * 还会指着那条事件说「当时写入失败」。先问一句，别拿异常当判断。
 */
export function hasDraftOntologySource(s: Session): boolean {
  return sourceOf(s, "_oir", "oir") !== null || sourceOf(s, "_flow", "flow") !== null;
}

/**
 * 供 `/context` 的 delivery 列表复用；只组 URL，不触发编译。
 */
export function draftOntologyArtifactViews(sessionId: string): DraftOntologyArtifactView[] {
  return (Object.entries(ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES) as [string, string][])
    .map(([view, name]) => {
      const encodedSession = encodeURIComponent(sessionId);
      const encodedName = encodeURIComponent(name);
      const previewUrl = `/api/sessions/${encodedSession}/ontology/draft/artifacts/${encodedName}`;
      return {
        id: `virtual:ontology-draft:${view}`,
        name,
        view,
        kind: "ontology_draft",
        format: "json",
        mediaType: "application/json",
        previewable: true,
        virtual: true,
        releaseState: ONTOLOGY_PACKAGE_RELEASE_STATE,
        publishable: false,
        previewUrl,
        downloadUrl: `${previewUrl}?download=1`,
      };
    });
}

export function buildDraftOntologyPackage(s: Session): OntologyPackageV1 {
  const oir = sourceOf(s, "_oir", "oir");
  const flow = sourceOf(s, "_flow", "flow");
  if (oir === null && flow === null) {
    throw apiError(409, "当前会话尚无 OIR/Flow，无法生成 DRAFT Ontology snapshot");
  }
  const current = positiveInt(s.state["artifact_revision"]);
  let decisions: unknown[] = [];
  const dialogue = s.state["_dialogue"] as { decisions?: readonly { toDict(): unknown }[] } | undefined;
  if (dialogue?.decisions !== undefined) decisions.push(...dialogue.decisions.map((item) => item.toDict()));
  if (Array.isArray(s.state["decision_ledger"])) decisions.push(...s.state["decision_ledger"]);
  decisions = dropReferenceMemory(decisions);
  return compileOntologyPackageV1(oir, flow, {
    packageId: `pkg.${s.id}`,
    revision: current + 1,
    baseRevision: current || null,
    generatedAt: generatedAt(s),
    decisions,
    backlog: s.state["question_backlog"],
    sessionId: s.id,
  });
}

export function buildDraftOntologySnapshot(s: Session): DraftOntologySnapshotReadModel {
  const pkg = buildDraftOntologyPackage(s);
  return {
    schemaVersion: DRAFT_ONTOLOGY_SNAPSHOT_SCHEMA_VERSION,
    releaseState: ONTOLOGY_PACKAGE_RELEASE_STATE,
    publishable: false,
    notice: "只读 DRAFT snapshot；待审阅问题完成并通过 Release Gate 后才会生成正式交付产物。",
    package: pkg,
    counts: {
      dataObjects: pkg.dataObjects.length,
      links: pkg.links.length,
      actions: pkg.actions.length,
      events: pkg.events.length,
      processNodes: pkg.processNodes.length,
      processEdges: pkg.processEdges.length,
      workflows: pkg.workflows.length,
      rules: pkg.rules.length,
      integrations: pkg.integrations.length,
      gaps: pkg.gaps.length,
      openGaps: pkg.validation.openGapCount,
      resolvedGaps: pkg.validation.resolvedGapCount,
      questions: pkg.questions.length,
      validationErrors: pkg.validation.errors.length,
    },
    artifacts: draftOntologyArtifactViews(s.id),
  };
}

function sourceOf(s: Session, privateKey: string, publicKey: string): Dict | { toDict(): Dict } | null {
  const privateValue = s.state[privateKey];
  if (isSource(privateValue)) return privateValue;
  const publicValue = s.state[publicKey];
  return isSource(publicValue) ? publicValue : null;
}

function isSource(value: unknown): value is Dict | { toDict(): Dict } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { toDict?: unknown };
  return typeof candidate.toDict === "function" || Object.keys(value).length > 0;
}

function generatedAt(s: Session): string {
  const millis = Number.isFinite(s.created) ? s.created * 1_000 : 0;
  return new Date(millis).toISOString();
}

function positiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function asciiInlineName(name: string): string {
  const safe = name.replaceAll(/[^a-zA-Z0-9._-]+/gu, "_");
  return safe || "ontology-draft.json";
}
