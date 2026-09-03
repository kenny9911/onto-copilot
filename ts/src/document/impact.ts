import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { DocumentManifestEntry } from "./types.js";
import type {
  DocumentChange,
  DocumentChangeScope,
  DocumentVersionDiff,
  FieldSnapshot,
  TableSnapshot,
  ChunkSnapshot,
} from "./diff.js";

export type DependencyConsumerKind = "answer" | "manifest" | "model_artifact" | "wiki_claim";
export type DependencyStatus = "stale_candidate" | "unaffected" | "unresolved";

export interface DocumentDependencyReference {
  readonly documentId: string;
  readonly versionId: string | null;
  readonly chunkId: string | null;
  readonly tableKey: string | null;
  readonly fieldKey: string | null;
  readonly evidenceRef: string | null;
  readonly raw: string;
}

export interface AnswerDependencySource {
  readonly id: string;
  readonly citations?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly payload?: unknown;
}

export interface ManifestDependencySource {
  readonly id: string;
  readonly entries: readonly DocumentManifestEntry[];
}

export interface ModelArtifactDependencySource {
  readonly id: string;
  readonly artifactKind: string;
  readonly payload: unknown;
  readonly references?: readonly DocumentDependencyReference[];
}

export interface WikiClaimDependencySource {
  readonly id: string;
  readonly payload: unknown;
}

export interface ImpactSources {
  readonly answers?: readonly AnswerDependencySource[];
  readonly manifests?: readonly ManifestDependencySource[];
  readonly artifacts?: readonly ModelArtifactDependencySource[];
  readonly wikiClaims?: readonly WikiClaimDependencySource[];
}

export interface DependencyReason {
  readonly changeId: string | null;
  readonly scope: DocumentChangeScope | "version";
  readonly key: string;
  readonly message: string;
  readonly reference: DocumentDependencyReference;
}

export interface ImpactedConsumer {
  readonly consumerId: string;
  readonly consumerKind: DependencyConsumerKind;
  readonly label: string;
  readonly status: DependencyStatus;
  readonly references: readonly DocumentDependencyReference[];
  readonly reasons: readonly DependencyReason[];
}

export interface ReverseDependency {
  readonly changeId: string;
  readonly consumerIds: readonly string[];
}

export interface DocumentImpactReport {
  readonly documentId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly consumers: readonly ImpactedConsumer[];
  readonly staleCandidates: readonly ImpactedConsumer[];
  readonly unresolved: readonly ImpactedConsumer[];
  readonly reverseDependencies: readonly ReverseDependency[];
  readonly fingerprint: string;
}

interface ConsumerCandidate {
  readonly id: string;
  readonly kind: DependencyConsumerKind;
  readonly label: string;
  readonly references: readonly DocumentDependencyReference[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodePart(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded !== "" && Buffer.from(decoded, "utf8").toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/** 只解 OntoDocument 的不可变 evidence_ref；普通展示文案不能充当依赖主键。 */
export function decodeDocumentEvidenceRef(value: string): DocumentDependencyReference | null {
  const match = /^odoc\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(value.trim());
  if (match === null) return null;
  const documentId = decodePart(match[1]!);
  const versionId = decodePart(match[2]!);
  const chunkId = decodePart(match[3]!);
  if (documentId === null || versionId === null || chunkId === null) return null;
  return {
    documentId,
    versionId,
    chunkId,
    tableKey: null,
    fieldKey: null,
    evidenceRef: value.trim(),
    raw: value.trim(),
  };
}

function explicitReference(value: Record<string, unknown>): DocumentDependencyReference | null {
  const evidence = text(value["evidence_ref"] ?? value["evidenceRef"]);
  if (evidence) {
    const decoded = decodeDocumentEvidenceRef(evidence);
    if (decoded !== null) return decoded;
  }
  const documentId = text(value["document_id"] ?? value["documentId"]);
  if (!documentId) return null;
  const versionId = text(value["version_id"] ?? value["versionId"]);
  const chunkId = text(value["chunk_id"] ?? value["chunkId"]);
  const tableKey = text(value["table_key"] ?? value["tableKey"]);
  const fieldKey = text(value["field_key"] ?? value["fieldKey"]);
  return {
    documentId,
    versionId: versionId || null,
    chunkId: chunkId || null,
    tableKey: tableKey || null,
    fieldKey: fieldKey || null,
    evidenceRef: evidence || null,
    raw: canonicalJson({ documentId, versionId, chunkId, tableKey, fieldKey }),
  };
}

function stringsWithEvidence(value: string): DocumentDependencyReference[] {
  const out: DocumentDependencyReference[] = [];
  const expression = /odoc\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;
  for (const match of value.matchAll(expression)) {
    const decoded = decodeDocumentEvidenceRef(match[0]);
    if (decoded !== null) out.push(decoded);
  }
  return out;
}

/**
 * 从回答/模型产物里只提取稳定 evidence_ref 或显式 document/version/chunk 三元组。
 * 遇到任意对象也有深度和节点上限，避免导入产物造成栈溢出或无界扫描。
 */
export function collectDocumentReferences(value: unknown): DocumentDependencyReference[] {
  const out: DocumentDependencyReference[] = [];
  const seen = new Set<object>();
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32 || visited >= 50_000) return;
    visited += 1;
    if (typeof node === "string") {
      out.push(...stringsWithEvidence(node));
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    const row = record(node);
    if (row !== null) {
      const explicit = explicitReference(row);
      if (explicit !== null) out.push(explicit);
      for (const key of Object.keys(row).sort()) walk(row[key], depth + 1);
    } else {
      for (const item of node as readonly unknown[]) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  const dedup = new Map<string, DocumentDependencyReference>();
  for (const ref of out) {
    const key = canonicalJson({
      documentId: ref.documentId,
      versionId: ref.versionId,
      chunkId: ref.chunkId,
      tableKey: ref.tableKey,
      fieldKey: ref.fieldKey,
    });
    if (!dedup.has(key)) dedup.set(key, ref);
  }
  return [...dedup.values()].sort((a, b) => a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0);
}

function candidates(sources: ImpactSources): ConsumerCandidate[] {
  const out: ConsumerCandidate[] = [];
  for (const answer of sources.answers ?? []) {
    const payload = {
      citations: answer.citations ?? [],
      evidenceRefs: answer.evidenceRefs ?? [],
      payload: answer.payload ?? null,
    };
    out.push({ id: answer.id, kind: "answer", label: "回答", references: collectDocumentReferences(payload) });
  }
  for (const manifest of sources.manifests ?? []) {
    const refs = manifest.entries.map((entry): DocumentDependencyReference => ({
      documentId: entry.document_id,
      versionId: entry.version_id,
      chunkId: null,
      tableKey: null,
      fieldKey: null,
      evidenceRef: null,
      raw: canonicalJson(entry),
    }));
    out.push({ id: manifest.id, kind: "manifest", label: "会话固定清单", references: refs });
  }
  for (const artifact of sources.artifacts ?? []) {
    out.push({
      id: artifact.id,
      kind: "model_artifact",
      label: artifact.artifactKind,
      references: [...collectDocumentReferences(artifact.payload), ...(artifact.references ?? [])],
    });
  }
  for (const claim of sources.wikiClaims ?? []) {
    out.push({ id: claim.id, kind: "wiki_claim", label: "Wiki 声明", references: collectDocumentReferences(claim.payload) });
  }
  return out;
}

type AnyChange =
  | DocumentChange<ChunkSnapshot>
  | DocumentChange<TableSnapshot>
  | DocumentChange<FieldSnapshot>;

function oldChunkIds(change: DocumentChange<ChunkSnapshot>): string[] {
  return change.before === null ? [] : [change.before.chunkId];
}

function reasonFor(
  diff: DocumentVersionDiff,
  reference: DocumentDependencyReference,
  changes: readonly AnyChange[],
): { readonly status: DependencyStatus; readonly reasons: DependencyReason[] } {
  if (reference.documentId !== diff.documentId) return { status: "unaffected", reasons: [] };
  if (reference.versionId !== null && reference.versionId !== diff.fromVersionId) {
    return reference.versionId === diff.toVersionId
      ? { status: "unaffected", reasons: [] }
      : {
          status: "unresolved",
          reasons: [{
            changeId: null,
            scope: "version",
            key: reference.versionId,
            message: "引用的不是本次比较起点版本，无法用这次 diff 判定",
            reference,
          }],
        };
  }
  if (reference.fieldKey !== null) {
    const hit = diff.fields.find((item) => item.key === reference.fieldKey);
    if (hit !== undefined) {
      return { status: "stale_candidate", reasons: [changeReason(hit, reference, "依赖字段发生变化")] };
    }
    return diff.inventory.from.fieldKeys.includes(reference.fieldKey)
      ? { status: "unaffected", reasons: [] }
      : unresolvedReference(reference, "field", reference.fieldKey, "旧版本中找不到引用字段，不能假定它未受影响");
  }
  if (reference.tableKey !== null) {
    const related = changes.filter((item) =>
      (item.scope === "table" && item.key === reference.tableKey) ||
      (item.scope === "field" && (item.before as FieldSnapshot | null)?.tableKey === reference.tableKey) ||
      (item.scope === "field" && (item.after as FieldSnapshot | null)?.tableKey === reference.tableKey));
    if (related.length > 0) {
      return {
        status: "stale_candidate",
        reasons: related.map((item) => changeReason(item, reference, "依赖表或其字段发生变化")),
      };
    }
    return diff.inventory.from.tableKeys.includes(reference.tableKey)
      ? { status: "unaffected", reasons: [] }
      : unresolvedReference(reference, "table", reference.tableKey, "旧版本中找不到引用表，不能假定它未受影响");
  }
  if (reference.chunkId !== null) {
    const hit = diff.chunks.find((item) => oldChunkIds(item).includes(reference.chunkId!));
    if (hit !== undefined) {
      return { status: "stale_candidate", reasons: [changeReason(hit, reference, "引用的原文切片发生变化")] };
    }
    return diff.inventory.from.chunkIds.includes(reference.chunkId)
      ? { status: "unaffected", reasons: [] }
      : unresolvedReference(reference, "chunk", reference.chunkId, "旧版本中找不到引用切片，不能假定它未受影响");
  }
  if (reference.versionId === diff.fromVersionId || reference.versionId === null) {
    return diff.hasChanges
      ? {
          status: "stale_candidate",
          reasons: [{
            changeId: `version:${diff.fingerprint}`,
            scope: "version",
            key: diff.fromVersionId,
            message: "依赖整个旧版本；版本已变化，需要复核，不能自动判为失效",
            reference,
          }],
        }
      : { status: "unaffected", reasons: [] };
  }
  return { status: "unresolved", reasons: [] };
}

function unresolvedReference(
  reference: DocumentDependencyReference,
  scope: DocumentChangeScope,
  key: string,
  message: string,
): { readonly status: DependencyStatus; readonly reasons: DependencyReason[] } {
  return {
    status: "unresolved",
    reasons: [{ changeId: null, scope, key, message, reference }],
  };
}

function changeReason(
  change: AnyChange,
  reference: DocumentDependencyReference,
  message: string,
): DependencyReason {
  return { changeId: change.id, scope: change.scope, key: change.key, message, reference };
}

function uniqueReferences(references: readonly DocumentDependencyReference[]): DocumentDependencyReference[] {
  const out = new Map<string, DocumentDependencyReference>();
  for (const reference of references) {
    const key = canonicalJson({
      documentId: reference.documentId,
      versionId: reference.versionId,
      chunkId: reference.chunkId,
      tableKey: reference.tableKey,
      fieldKey: reference.fieldKey,
    });
    if (!out.has(key)) out.set(key, reference);
  }
  return [...out.values()];
}

/**
 * 反查回答、会话 manifest、模型产物和 Wiki 声明对旧版本的依赖。
 * 输出只叫 stale_candidate：它提示复核，不会把“可能受影响”伪装成“已经失效”。
 */
export function analyzeDocumentImpact(
  diff: DocumentVersionDiff,
  sources: ImpactSources,
): DocumentImpactReport {
  const changes: AnyChange[] = [...diff.chunks, ...diff.tables, ...diff.fields];
  const consumers: ImpactedConsumer[] = [];
  for (const source of candidates(sources).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const references = uniqueReferences(source.references).filter((ref) => ref.documentId === diff.documentId);
    if (references.length === 0) continue;
    const results = references.map((reference) => reasonFor(diff, reference, changes));
    const reasons = results.flatMap((result) => result.reasons);
    const status: DependencyStatus = results.some((result) => result.status === "stale_candidate")
      ? "stale_candidate"
      : results.some((result) => result.status === "unresolved")
        ? "unresolved"
        : "unaffected";
    consumers.push({
      consumerId: source.id,
      consumerKind: source.kind,
      label: source.label,
      status,
      references,
      reasons,
    });
  }
  const reverse = new Map<string, Set<string>>();
  for (const consumer of consumers) {
    for (const reason of consumer.reasons) {
      if (reason.changeId === null) continue;
      const ids = reverse.get(reason.changeId) ?? new Set<string>();
      ids.add(consumer.consumerId);
      reverse.set(reason.changeId, ids);
    }
  }
  const reverseDependencies = [...reverse.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([changeId, ids]) => ({ changeId, consumerIds: [...ids].sort() }));
  const stable = consumers.map((consumer) => ({
    id: consumer.consumerId,
    kind: consumer.consumerKind,
    status: consumer.status,
    reasons: consumer.reasons.map((reason) => [reason.changeId, reason.scope, reason.key]),
  }));
  return {
    documentId: diff.documentId,
    fromVersionId: diff.fromVersionId,
    toVersionId: diff.toVersionId,
    consumers,
    staleCandidates: consumers.filter((consumer) => consumer.status === "stale_candidate"),
    unresolved: consumers.filter((consumer) => consumer.status === "unresolved"),
    reverseDependencies,
    fingerprint: sha256Hex(canonicalJson({ diff: diff.fingerprint, consumers: stable })).slice(0, 32),
  };
}
