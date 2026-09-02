import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { Chunk, ParsedDoc } from "../onto/parse/base.js";

/** OntoDocument 版本比较只接受不可变版本的必要投影，不依赖 repository。 */
export interface DiffableDocumentVersion {
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNo?: number;
  readonly parsedDoc: ParsedDoc;
}

export type DocumentChangeKind = "added" | "removed" | "modified";
export type DocumentChangeScope = "chunk" | "table" | "field";

export interface ChunkSnapshot {
  readonly key: string;
  readonly chunkId: string;
  readonly order: number;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly render: string;
  readonly raw: unknown;
  readonly tags: readonly string[];
  readonly context: string;
  readonly fingerprint: string;
}

export interface TableSnapshot {
  readonly key: string;
  readonly name: string;
  readonly sourceKind: string;
  readonly fieldOrder: readonly string[];
  /** 与 fieldOrder 对齐；字段内容变化时，所属表也会被报告为修改。 */
  readonly fieldFingerprints: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

export interface FieldSnapshot {
  readonly key: string;
  readonly tableKey: string;
  readonly name: string;
  readonly definition: unknown;
  readonly fingerprint: string;
}

export interface DocumentChange<T> {
  readonly id: string;
  readonly scope: DocumentChangeScope;
  readonly kind: DocumentChangeKind;
  readonly key: string;
  readonly before: T | null;
  readonly after: T | null;
  readonly changedParts: readonly string[];
}

export interface DocumentDiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
  readonly unchanged: number;
}

export interface DocumentVersionDiff {
  readonly documentId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly fromVersionNo: number | null;
  readonly toVersionNo: number | null;
  readonly chunks: readonly DocumentChange<ChunkSnapshot>[];
  readonly tables: readonly DocumentChange<TableSnapshot>[];
  readonly fields: readonly DocumentChange<FieldSnapshot>[];
  /** 影响分析用它区分“确实未变化”和“引用根本不存在”，避免把未知误报为安全。 */
  readonly inventory: {
    readonly from: {
      readonly chunkIds: readonly string[];
      readonly tableKeys: readonly string[];
      readonly fieldKeys: readonly string[];
    };
    readonly to: {
      readonly chunkIds: readonly string[];
      readonly tableKeys: readonly string[];
      readonly fieldKeys: readonly string[];
    };
  };
  readonly summary: {
    readonly chunks: DocumentDiffSummary;
    readonly tables: DocumentDiffSummary;
    readonly fields: DocumentDiffSummary;
  };
  readonly hasChanges: boolean;
  /** 同样两份不可变版本必得同一指纹，可用于缓存和审计。 */
  readonly fingerprint: string;
}

export interface ExtractedDocumentSchema {
  readonly tables: readonly TableSnapshot[];
  readonly fields: readonly FieldSnapshot[];
}

interface TableCandidate {
  readonly key: string;
  readonly name: string;
  readonly sourceKind: string;
  readonly fieldOrder: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly fields: readonly { readonly name: string; readonly definition: unknown }[];
}

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Persisted ParsedDoc 应为纯 JSON；这里仍把 undefined/非有限数收口，避免 diff 自己幻觉。 */
function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("ParsedDoc 不能包含循环引用");
    seen.add(value);
    const out = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (value instanceof Map) {
    if (seen.has(value)) throw new Error("ParsedDoc 不能包含循环引用");
    seen.add(value);
    const out = stableValue(Object.fromEntries(value), seen);
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("ParsedDoc 不能包含循环引用");
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(stableValue(value))).slice(0, 32);
}

function internalFreeLocator(locator: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(locator)) {
    // 会话挂载时注入的版本身份不属于原文位置；否则同一位置在每一版都变成新切片。
    if (key === "_document_id" || key === "_version_id" || key === "_chunk_id") continue;
    out[key] = stableValue(value);
  }
  return out;
}

function logicalChunkKey(chunk: Chunk): string {
  const colon = chunk.chunk_id.indexOf(":");
  const parserLocalId = colon >= 0 ? chunk.chunk_id.slice(colon + 1) : "";
  if (parserLocalId) return `chunk:${parserLocalId}`;
  const locator = internalFreeLocator(chunk.locator);
  if (Object.keys(locator).length > 0) return `locator:${digest(locator)}`;
  return `order:${chunk.order}`;
}

function chunkSnapshot(chunk: Chunk, key: string): ChunkSnapshot {
  const locator = internalFreeLocator(chunk.locator);
  const tags = [...chunk.tags];
  const raw = stableValue(chunk.raw);
  const body = {
    locator,
    render: chunk.render,
    raw,
    tags,
    context: chunk.context,
    order: chunk.order,
  };
  return {
    key,
    chunkId: chunk.chunk_id,
    order: chunk.order,
    locator,
    render: chunk.render,
    raw,
    tags,
    context: chunk.context,
    fingerprint: digest(body),
  };
}

function chunkContentFingerprint(chunk: Chunk): string {
  return digest({
    locator: internalFreeLocator(chunk.locator),
    render: chunk.render,
    raw: stableValue(chunk.raw),
    tags: [...chunk.tags],
    context: chunk.context,
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderedChunks(chunks: readonly Chunk[]): Chunk[] {
  return [...chunks].sort((a, b) =>
    a.order - b.order || compareText(a.chunk_id, b.chunk_id) ||
    compareText(canonicalJson(stableValue(a.locator)), canonicalJson(stableValue(b.locator))));
}

/**
 * 同一逻辑 key 可能出现重复切片。先按正文精确配对，再按稳定顺序配剩余项；
 * 这样在中间插入一个重复行时，不会把后面的所有行都误报为修改。
 */
function pairChunkGroup(
  key: string,
  before: readonly Chunk[],
  after: readonly Chunk[],
): { readonly before: ChunkSnapshot | null; readonly after: ChunkSnapshot | null }[] {
  const old = orderedChunks(before).map((chunk) => ({ chunk, content: chunkContentFingerprint(chunk) }));
  const fresh = orderedChunks(after).map((chunk) => ({ chunk, content: chunkContentFingerprint(chunk) }));
  const usedOld = new Set<number>();
  const usedFresh = new Set<number>();
  const pairs: { before: Chunk; after: Chunk }[] = [];
  for (let ni = 0; ni < fresh.length; ni += 1) {
    const oi = old.findIndex((item, index) => !usedOld.has(index) && item.content === fresh[ni]!.content);
    if (oi < 0) continue;
    usedOld.add(oi);
    usedFresh.add(ni);
    pairs.push({ before: old[oi]!.chunk, after: fresh[ni]!.chunk });
  }
  const remainingOld = old.filter((_, index) => !usedOld.has(index));
  const remainingFresh = fresh.filter((_, index) => !usedFresh.has(index));
  const n = Math.max(remainingOld.length, remainingFresh.length);
  const out: { before: ChunkSnapshot | null; after: ChunkSnapshot | null }[] = [];
  let occurrence = 0;
  for (const pair of pairs.sort((a, b) => a.before.order - b.before.order)) {
    occurrence += 1;
    const unique = occurrence === 1 && before.length <= 1 && after.length <= 1 ? key : `${key}#${occurrence}`;
    out.push({ before: chunkSnapshot(pair.before, unique), after: chunkSnapshot(pair.after, unique) });
  }
  for (let i = 0; i < n; i += 1) {
    occurrence += 1;
    const unique = occurrence === 1 && before.length <= 1 && after.length <= 1 ? key : `${key}#${occurrence}`;
    const left = remainingOld[i]?.chunk;
    const right = remainingFresh[i]?.chunk;
    out.push({
      before: left === undefined ? null : chunkSnapshot(left, unique),
      after: right === undefined ? null : chunkSnapshot(right, unique),
    });
  }
  return out.sort((a, b) => compareText((a.before ?? a.after)!.key, (b.before ?? b.after)!.key));
}

function fieldCandidates(columns: unknown, profile: unknown): { name: string; definition: unknown }[] {
  const profiles = rec(profile) ?? {};
  const out: { name: string; definition: unknown }[] = [];
  for (const [index, raw] of rows(columns).entries()) {
    const row = rec(raw);
    const name = row === null ? String(raw ?? "").trim() : String(row["name"] ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      definition: row === null
        ? { position: index, profile: stableValue(profiles[name] ?? null) }
        : { position: index, ...(stableValue(row) as Record<string, unknown>) },
    });
  }
  return out;
}

function withoutKeys(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = stableValue(value);
  }
  return out;
}

function candidate(
  key: string,
  name: string,
  sourceKind: string,
  source: Record<string, unknown>,
): TableCandidate {
  const fields = fieldCandidates(source["columns"], source["profile"]);
  return {
    key,
    name,
    sourceKind,
    fieldOrder: fields.map((field) => field.name),
    metadata: withoutKeys(source, ["columns", "profile", "data"]),
    fields,
  };
}

function tableCandidates(doc: ParsedDoc): TableCandidate[] {
  const out: TableCandidate[] = [];
  const structured = doc.structured;
  for (const [index, raw] of rows(structured["tables"]).entries()) {
    const table = rec(raw);
    if (table === null) continue;
    const fallback = `table_${String(table["index"] ?? index + 1)}`;
    const name = String(table["name"] ?? fallback).trim() || fallback;
    out.push(candidate(`table:${name}`, name, doc.kind, table));
  }
  for (const [index, raw] of rows(structured["sheets"]).entries()) {
    const sheet = rec(raw);
    if (sheet === null) continue;
    const fallback = `sheet_${index + 1}`;
    const name = String(sheet["name"] ?? fallback).trim() || fallback;
    out.push(candidate(`sheet:${name}`, name, "sheet", sheet));
  }
  if (Object.hasOwn(structured, "columns")) {
    out.push(candidate("table:$root", doc.file_name, doc.kind, structured));
  }
  for (const [slideIndex, rawSlide] of rows(structured["slides"]).entries()) {
    const slide = rec(rawSlide);
    if (slide === null) continue;
    const page = String(slide["number"] ?? slideIndex + 1);
    for (const [tableIndex, rawTable] of rows(slide["tables"]).entries()) {
      const table = rec(rawTable);
      if (table === null) continue;
      const ordinal = String(table["index"] ?? tableIndex + 1);
      const name = `第 ${page} 页表 ${ordinal}`;
      out.push(candidate(`slide:${page}:table:${ordinal}`, name, "slide_table", table));
    }
  }
  const sorted = out.sort((a, b) => compareText(a.key, b.key));
  const used = new Set<string>();
  const occurrences = new Map<string, number>();
  return sorted.map((table) => {
    let key = table.key;
    let occurrence = occurrences.get(table.key) ?? 0;
    while (used.has(key)) {
      occurrence += 1;
      key = `${table.key}::duplicate:${occurrence}`;
    }
    occurrences.set(table.key, occurrence);
    used.add(key);
    return key === table.key ? table : { ...table, key };
  });
}

export function extractDocumentSchema(doc: ParsedDoc): ExtractedDocumentSchema {
  const candidates = tableCandidates(doc);
  const tables: TableSnapshot[] = candidates.map((table) => {
    const fieldFingerprints = table.fields.map((field) => digest(field.definition));
    const body = {
      name: table.name,
      sourceKind: table.sourceKind,
      fieldOrder: table.fieldOrder,
      fieldFingerprints,
      metadata: table.metadata,
    };
    return {
      key: table.key,
      name: table.name,
      sourceKind: table.sourceKind,
      fieldOrder: [...table.fieldOrder],
      fieldFingerprints,
      metadata: table.metadata,
      fingerprint: digest(body),
    };
  });
  const fieldKeys = new Set<string>();
  const fields: FieldSnapshot[] = candidates.flatMap((table) => table.fields.map((field) => {
    const baseKey = `${table.key}::field:${field.name}`;
    let key = baseKey;
    let occurrence = 0;
    while (fieldKeys.has(key)) {
      occurrence += 1;
      key = `${baseKey}::duplicate:${occurrence}`;
    }
    fieldKeys.add(key);
    const definition = stableValue(field.definition);
    return {
      key,
      tableKey: table.key,
      name: field.name,
      definition,
      fingerprint: digest(definition),
    };
  })).sort((a, b) => compareText(a.key, b.key));
  return { tables, fields };
}

function changedParts(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) =>
    key !== "key" && key !== "fingerprint" && key !== "chunkId" &&
    canonicalJson(stableValue(before[key])) !== canonicalJson(stableValue(after[key]))).sort(compareText);
}

function change<T extends { readonly key: string; readonly fingerprint: string }>(
  scope: DocumentChangeScope,
  before: T | null,
  after: T | null,
): DocumentChange<T> | null {
  const key = (before ?? after)!.key;
  if (before !== null && after !== null && before.fingerprint === after.fingerprint) return null;
  const kind: DocumentChangeKind = before === null ? "added" : after === null ? "removed" : "modified";
  return {
    id: `${scope}:${kind}:${sha256Hex(canonicalJson({
      key,
      before: before?.fingerprint ?? null,
      after: after?.fingerprint ?? null,
    })).slice(0, 16)}`,
    scope,
    kind,
    key,
    before,
    after,
    changedParts: before === null || after === null
      ? []
      : changedParts(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
  };
}

function mapChanges<T extends { readonly key: string; readonly fingerprint: string }>(
  scope: DocumentChangeScope,
  before: readonly T[],
  after: readonly T[],
): { readonly changes: DocumentChange<T>[]; readonly unchanged: number } {
  const old = new Map(before.map((item) => [item.key, item]));
  const fresh = new Map(after.map((item) => [item.key, item]));
  const keys = [...new Set([...old.keys(), ...fresh.keys()])].sort(compareText);
  const changes: DocumentChange<T>[] = [];
  let unchanged = 0;
  for (const key of keys) {
    const item = change(scope, old.get(key) ?? null, fresh.get(key) ?? null);
    if (item === null) unchanged += 1;
    else changes.push(item);
  }
  return { changes, unchanged };
}

function chunkChanges(
  before: readonly Chunk[],
  after: readonly Chunk[],
): { readonly changes: DocumentChange<ChunkSnapshot>[]; readonly unchanged: number } {
  const old = new Map<string, Chunk[]>();
  const fresh = new Map<string, Chunk[]>();
  for (const chunk of before) {
    const key = logicalChunkKey(chunk);
    old.set(key, [...(old.get(key) ?? []), chunk]);
  }
  for (const chunk of after) {
    const key = logicalChunkKey(chunk);
    fresh.set(key, [...(fresh.get(key) ?? []), chunk]);
  }
  const keys = [...new Set([...old.keys(), ...fresh.keys()])].sort(compareText);
  const changes: DocumentChange<ChunkSnapshot>[] = [];
  let unchanged = 0;
  for (const key of keys) {
    for (const pair of pairChunkGroup(key, old.get(key) ?? [], fresh.get(key) ?? [])) {
      const item = change("chunk", pair.before, pair.after);
      if (item === null) unchanged += 1;
      else changes.push(item);
    }
  }
  return { changes, unchanged };
}

function summary<T>(changes: readonly DocumentChange<T>[], unchanged: number): DocumentDiffSummary {
  return {
    added: changes.filter((item) => item.kind === "added").length,
    removed: changes.filter((item) => item.kind === "removed").length,
    modified: changes.filter((item) => item.kind === "modified").length,
    unchanged,
  };
}

/** 确定性比较 Chunk、表和字段；不调用模型，不把“像是改名”猜成已确认改名。 */
export function diffDocumentVersions(
  before: DiffableDocumentVersion,
  after: DiffableDocumentVersion,
): DocumentVersionDiff {
  if (!before.documentId.trim() || before.documentId !== after.documentId) {
    throw new Error("只能比较同一 documentId 的两个版本");
  }
  if (!before.versionId.trim() || !after.versionId.trim()) throw new Error("版本 ID 不能为空");
  // 仓储契约要求 ParsedDoc 是可持久化 JSON。先完整走一遍，避免循环/异常对象藏在
  // 当前提取器尚未识别的分支里，从而被静默当成“没有变化”。
  stableValue(before.parsedDoc);
  stableValue(after.parsedDoc);
  const chunkResult = chunkChanges(before.parsedDoc.chunks, after.parsedDoc.chunks);
  const oldSchema = extractDocumentSchema(before.parsedDoc);
  const newSchema = extractDocumentSchema(after.parsedDoc);
  const tableResult = mapChanges("table", oldSchema.tables, newSchema.tables);
  const fieldResult = mapChanges("field", oldSchema.fields, newSchema.fields);
  const inventory = {
    from: {
      chunkIds: [...new Set(before.parsedDoc.chunks.map((chunk) => chunk.chunk_id))].sort(compareText),
      tableKeys: oldSchema.tables.map((table) => table.key).sort(compareText),
      fieldKeys: oldSchema.fields.map((field) => field.key).sort(compareText),
    },
    to: {
      chunkIds: [...new Set(after.parsedDoc.chunks.map((chunk) => chunk.chunk_id))].sort(compareText),
      tableKeys: newSchema.tables.map((table) => table.key).sort(compareText),
      fieldKeys: newSchema.fields.map((field) => field.key).sort(compareText),
    },
  };
  const payload = {
    documentId: before.documentId,
    fromVersionId: before.versionId,
    toVersionId: after.versionId,
    chunks: chunkResult.changes,
    tables: tableResult.changes,
    fields: fieldResult.changes,
    inventory,
  };
  const hasChanges = payload.chunks.length + payload.tables.length + payload.fields.length > 0;
  return {
    documentId: before.documentId,
    fromVersionId: before.versionId,
    toVersionId: after.versionId,
    fromVersionNo: before.versionNo ?? null,
    toVersionNo: after.versionNo ?? null,
    chunks: chunkResult.changes,
    tables: tableResult.changes,
    fields: fieldResult.changes,
    inventory,
    summary: {
      chunks: summary(chunkResult.changes, chunkResult.unchanged),
      tables: summary(tableResult.changes, tableResult.unchanged),
      fields: summary(fieldResult.changes, fieldResult.unchanged),
    },
    hasChanges,
    fingerprint: digest(payload),
  };
}
