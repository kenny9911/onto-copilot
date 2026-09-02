/**
 * 会话资产记忆的领域模型。
 *
 * 这层只做三件事：把材料/产物/图片/问题/草图归一成同一份可持久化索引；
 * 用内容与逻辑引用确定性去重并保留修订链；把「刚才那张图」「采购制度材料」
 * 这类自然语言指代解析回稳定 asset id。它不碰文件系统、仓储或 UI，调用方可把
 * {@link AssetMemory.toDict} 原样放进现有 session state。
 */

import { canonicalJson, sha256Hex } from "../kernel/ids.js";

export type AssetKind =
  | "material"
  | "artifact"
  | "document"
  | "image"
  | "question"
  | "question_list"
  | "sketch"
  | "reference"
  | "dataset"
  | "other";

export type AssetOrigin =
  | "uploaded"
  | "generated"
  | "derived"
  | "model_knowledge"
  | "user"
  | "system"
  | "unknown";

export type AssetStatus = "active" | "draft" | "superseded" | "deleted" | "failed";

export interface AssetSessionRef {
  readonly sessionId: string;
  readonly eventSeq: number | null;
  readonly turnId: string | null;
  readonly eventKind: string | null;
}

export interface AssetRecord {
  /** 一份不可变版本的稳定内容地址。 */
  readonly id: string;
  readonly kind: AssetKind;
  readonly mime: string;
  readonly name: string;
  /** 首个登记来源；全部来源见 sources。 */
  readonly source: string;
  readonly sources: readonly string[];
  readonly origin: AssetOrigin;
  readonly sessionRef: AssetSessionRef;
  readonly createdSeq: number;
  readonly updatedSeq: number;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly provenanceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly revision: number;
  readonly supersedes: string | null;
  readonly status: AssetStatus;
  readonly displayOnly: boolean;
  /** 可下载 URI。只接受安全相对 URI 或 http(s) URI。 */
  readonly uri: string | null;
  /** 会话目录内的安全相对 POSIX 路径；绝不保存宿主机绝对路径。 */
  readonly path: string | null;
  readonly contentDigest: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AssetUpsertInput {
  readonly kind?: AssetKind;
  readonly mime?: string;
  readonly name: string;
  readonly source?: string;
  readonly origin?: AssetOrigin;
  readonly sessionId?: string;
  readonly seq?: number;
  readonly turnId?: string | null;
  readonly eventKind?: string | null;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly provenanceRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly status?: AssetStatus;
  readonly displayOnly?: boolean;
  readonly uri?: string | null;
  readonly path?: string | null;
  readonly contentDigest?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 同名文件以外的稳定业务引用（question id、sketch domain 等）。 */
  readonly sourceRef?: string | null;
  /** 一组内容发生变化仍属于同一资产的稳定逻辑引用。 */
  readonly logicalRef?: string | null;
}

export interface AssetEventInput extends Readonly<Record<string, unknown>> {
  readonly kind?: unknown;
  readonly seq?: unknown;
  readonly payload?: unknown;
}

export interface AssetSessionSnapshot {
  readonly sessionId: string;
  readonly seq?: number;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly files?: readonly unknown[];
  readonly events?: readonly AssetEventInput[];
}

export interface AssetSearchOptions {
  readonly limit?: number;
  readonly includeSuperseded?: boolean;
  readonly kinds?: readonly AssetKind[];
}

export interface AssetSearchHit {
  readonly asset: AssetRecord;
  readonly score: number;
  readonly matched: readonly string[];
  readonly recentIntent: boolean;
}

export interface AssetResolution {
  readonly query: string;
  readonly status: "found" | "not_found";
  readonly asset: AssetRecord | null;
  readonly candidates: readonly AssetSearchHit[];
  readonly reason: "exact" | "semantic" | "recent" | "none";
}

export interface AssetMemoryDict {
  readonly $schema: "ontocopilot.asset-memory/1";
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly assets: readonly AssetRecord[];
}

type Dict = Record<string, unknown>;

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  md: "text/markdown",
  mmd: "text/x-mermaid",
  txt: "text/plain",
  zip: "application/zip",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const DOCUMENT_EXTS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "csv", "tsv", "md", "mmd", "txt"]);

function record(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Dict : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function lower(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function extOf(name: string): string {
  const clean = name.split(/[?#]/, 1)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? lower(clean.slice(dot + 1)) : "";
}

function assetId(identity: unknown): string {
  return `asset_${sha256Hex(canonicalJson(identity)).slice(0, 24)}`;
}

/** 把外部路径收窄成会话目录内的 POSIX 相对路径。 */
export function normalizeRelativeAssetPath(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw || raw.includes("\0")) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:\//.test(slashed)) return null;
  const pieces: string[] = [];
  for (const part of slashed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    pieces.push(part);
  }
  return pieces.length > 0 ? pieces.join("/") : null;
}

function normalizeUri(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) return null;
  return normalizeRelativeAssetPath(raw);
}

export function inferMime(name: string, explicit = ""): string {
  return text(explicit) || MIME[extOf(name)] || "application/octet-stream";
}

export function inferAssetKind(name: string, hint = ""): AssetKind {
  const h = lower(hint);
  if (h === "material" || h === "upload" || h === "uploaded") return "material";
  if (h.includes("question") || h.includes("问题清单")) return "question_list";
  if (h.includes("sketch") || h.includes("草图")) return "sketch";
  if (h.includes("reference") || h.includes("参考")) return "reference";
  if (h.includes("image") || h.includes("visual") || h.includes("图片")) return "image";
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (["json", "zip"].includes(ext)) return "artifact";
  return "artifact";
}

function originOf(value: unknown, fallback: AssetOrigin): AssetOrigin {
  const v = text(value) as AssetOrigin;
  return ["uploaded", "generated", "derived", "model_knowledge", "user", "system", "unknown"].includes(v)
    ? v
    : fallback;
}

function statusOf(value: unknown, fallback: AssetStatus): AssetStatus {
  const v = text(value) as AssetStatus;
  return ["active", "draft", "superseded", "deleted", "failed"].includes(v) ? v : fallback;
}

function kindOf(value: unknown, name: string): AssetKind {
  const v = text(value) as AssetKind;
  return ["material", "artifact", "document", "image", "question", "question_list", "sketch", "reference", "dataset", "other"].includes(v)
    ? v
    : inferAssetKind(name);
}

function clonePlain(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((v) => clonePlain(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Dict = {};
    for (const [key, item] of Object.entries(value as Dict)) out[key] = clonePlain(item, depth + 1);
    return out;
  }
  return String(value);
}

function metadataOf(value: unknown): Dict {
  return record(clonePlain(record(value)));
}

function pathName(value: string): string {
  const pieces = value.replace(/\\/g, "/").split("/");
  return pieces[pieces.length - 1] || value;
}

function questionText(raw: Dict): string {
  return text(raw["text"]) || text(raw["title"]) || text(raw["prompt"]) || text(raw["question"]);
}

function refs(raw: Dict, ...keys: string[]): string[] {
  const values: unknown[] = [];
  for (const key of keys) values.push(...array(raw[key]));
  return unique(values);
}

function searchTokens(value: string): string[] {
  const normalized = lower(value).replace(/[’'“”"`]/g, " ");
  const out = new Set<string>();
  for (const chunk of normalized.match(/[a-z0-9][a-z0-9._-]*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    out.add(chunk);
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(chunk)) {
      const chars = [...chunk];
      for (let i = 0; i < chars.length - 1; i++) out.add(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return [...out];
}

const RECENT_RE = /(?:刚才|刚刚|最近|最新|上一(?:个|张|份|版)?|last|latest|recent|previous|newest)/iu;
const HISTORY_RE = /(?:历史(?:记录|版本)?|(?:全部|所有)(?:的)?版本|旧版|更早(?:版本)?|版本历史|history|all\s+versions?|version\s+history|older\s+versions?)/iu;

function intentKinds(query: string): Set<AssetKind> {
  const q = lower(query);
  const kinds = new Set<AssetKind>();
  if (/(?:图片|图像|那张图|流程图|image|picture|png|jpg|视觉版|image\s*2)/iu.test(q)) kinds.add("image");
  if (/(?:材料|素材|上传|附件|material|upload|attachment)/iu.test(q)) kinds.add("material");
  if (/(?:问题清单|提问清单|question\s*list|questions\s+list|访谈问题)/iu.test(q)) kinds.add("question_list");
  if (/(?:问题|提问|question|questions)/iu.test(q)) {
    // 「问题清单」既可能指整份清单，也可能继续带上问题正文去找其中一条。
    kinds.add("question");
    kinds.add("question_list");
  }
  if (/(?:草图|参考图|sketch|draft\s*diagram)/iu.test(q)) kinds.add("sketch");
  if (/(?:文档|报告|表格|document|report|spreadsheet|excel|pdf)/iu.test(q)) kinds.add("document");
  return kinds;
}

function kindTerms(row: AssetRecord): string[] {
  const terms: Record<AssetKind, string[]> = {
    material: ["材料", "素材", "上传", "附件", "material", "uploaded", "upload", "attachment"],
    artifact: ["产物", "成果", "artifact", "output"],
    document: ["文档", "报告", "表格", "document", "report", "spreadsheet", "excel", "pdf"],
    image: ["图片", "图像", "流程图", "视觉版", "image", "picture", "png", "image 2"],
    question: ["问题", "提问", "question"],
    question_list: ["问题清单", "访谈问题", "question list", "questions"],
    sketch: ["草图", "参考图", "流程草图", "sketch", "reference diagram"],
    reference: ["参考", "reference"],
    dataset: ["数据集", "dataset", "data"],
    other: ["其他", "other"],
  };
  return [...terms[row.kind], row.origin, row.mime];
}

function safeRecord(raw: unknown, fallbackSession: string): AssetRecord | null {
  const row = record(raw);
  const id = text(row["id"]);
  const name = text(row["name"]);
  if (!id || !name) return null;
  const session = record(row["sessionRef"]);
  const createdSeq = integer(row["createdSeq"], 0);
  return {
    id,
    kind: kindOf(row["kind"], name),
    mime: inferMime(name, text(row["mime"])),
    name,
    source: text(row["source"]) || "unknown",
    sources: unique([...array(row["sources"]), row["source"]]),
    origin: originOf(row["origin"], "unknown"),
    sessionRef: {
      sessionId: text(session["sessionId"]) || fallbackSession,
      eventSeq: session["eventSeq"] === null ? null : integer(session["eventSeq"], createdSeq),
      turnId: text(session["turnId"]) || null,
      eventKind: text(session["eventKind"]) || null,
    },
    createdSeq,
    updatedSeq: integer(row["updatedSeq"], createdSeq),
    aliases: unique(array(row["aliases"])),
    tags: unique(array(row["tags"])),
    provenanceRefs: unique(array(row["provenanceRefs"])),
    evidenceRefs: unique(array(row["evidenceRefs"])),
    revision: Math.max(1, integer(row["revision"], 1)),
    supersedes: text(row["supersedes"]) || null,
    status: statusOf(row["status"], "active"),
    displayOnly: bool(row["displayOnly"]),
    uri: normalizeUri(text(row["uri"]) || null),
    path: normalizeRelativeAssetPath(text(row["path"]) || null),
    contentDigest: text(row["contentDigest"]) || null,
    metadata: metadataOf(row["metadata"]),
  };
}

function logicalKeyOf(input: AssetUpsertInput, sessionId: string, kind: AssetKind, path: string | null, uri: string | null): string {
  const logical = text(input.logicalRef) || text(input.sourceRef) || path || uri || lower(input.name);
  return canonicalJson({ sessionId, kind, logical });
}

function assetCompleteness(row: AssetRecord): number {
  return Number(row.path !== null) * 8
    + Number(row.uri !== null) * 8
    + row.aliases.length
    + row.tags.length
    + row.sources.length
    + row.provenanceRefs.length
    + row.evidenceRefs.length
    + Object.values(row.metadata).filter((value) => value !== null && value !== "").length;
}

/**
 * Legacy `artifact.ready` events did not carry `logical_ref`. Repeated renders of the
 * same bytes therefore acquired different logical identities through their versioned
 * filenames. Keep every immutable record in storage/audit, but collapse byte-identical
 * raster-image aliases in the default recall projection.
 *
 * The key deliberately requires both `kind=image` and an image MIME type. Ordinary
 * documents with coincidentally equal bytes remain distinct business assets.
 */
function projectDuplicateImages(rows: readonly AssetRecord[]): AssetRecord[] {
  const groups = new Map<string, AssetRecord[]>();
  const ungrouped: AssetRecord[] = [];
  for (const row of rows) {
    if (row.contentDigest === null || row.kind !== "image" || !/^image\//iu.test(row.mime)) {
      ungrouped.push(row);
      continue;
    }
    const key = canonicalJson({
      sessionId: row.sessionRef.sessionId,
      kind: row.kind,
      mime: lower(row.mime),
      contentDigest: row.contentDigest,
    });
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const projected = [...ungrouped];
  for (const group of groups.values()) {
    if (group.length === 1) {
      projected.push(group[0]!);
      continue;
    }
    const ordered = [...group].sort((a, b) =>
      b.updatedSeq - a.updatedSeq
      || assetCompleteness(b) - assetCompleteness(a)
      || b.createdSeq - a.createdSeq
      || a.id.localeCompare(b.id),
    );
    const representative = ordered[0]!;
    const duplicateIds = ordered.map((row) => row.id);
    projected.push({
      ...representative,
      // Preserve the vocabulary of every legacy alias so a query for “v2” still
      // resolves to the single latest representative rather than disappearing.
      aliases: unique(ordered.flatMap((row) => [row.name, ...row.aliases])),
      tags: unique(ordered.flatMap((row) => row.tags)),
      sources: unique(ordered.flatMap((row) => row.sources)),
      provenanceRefs: unique(ordered.flatMap((row) => row.provenanceRefs)),
      evidenceRefs: unique(ordered.flatMap((row) => row.evidenceRefs)),
      metadata: {
        ...representative.metadata,
        duplicateCount: ordered.length,
        duplicateAssetIds: duplicateIds,
        duplicateAliasIds: duplicateIds.filter((id) => id !== representative.id),
        duplicateNames: unique(ordered.map((row) => row.name)),
        deduplicatedBy: "session+image-kind+mime+content-digest",
      },
    });
  }
  return projected.sort((a, b) =>
    b.updatedSeq - a.updatedSeq || b.createdSeq - a.createdSeq || a.id.localeCompare(b.id),
  );
}

export class AssetMemory {
  readonly sessionId: string;
  private readonly assets = new Map<string, AssetRecord>();
  private readonly logicalHeads = new Map<string, string>();
  private lastSeq = 0;

  constructor(sessionId: string) {
    this.sessionId = text(sessionId) || "unknown-session";
  }

  static fromDict(raw: unknown): AssetMemory {
    const data = record(raw);
    const memory = new AssetMemory(text(data["sessionId"]));
    memory.lastSeq = integer(data["lastSeq"], 0);
    for (const item of array(data["assets"])) {
      const row = safeRecord(item, memory.sessionId);
      if (row === null) continue;
      memory.assets.set(row.id, row);
      memory.lastSeq = Math.max(memory.lastSeq, row.updatedSeq);
    }
    memory.repairLegacySemanticPlaceholders();
    memory.rebuildHeads();
    return memory;
  }

  /**
   * 早期版本把 `state.sketch.graph` 的语义摘要当成 SVG 文件的字节 digest。
   * 随后的真实文件扫描因此凭空造出 revision 2，并让“revision 1”指向仍可覆盖的
   * `exports/<name>.svg`。语义摘要从来不是一份旧文件字节：有 immutable 后继时删掉
   * 这份伪版本；尚未物化时把它还原成 locator placeholder，等待首次字节扫描原地升级。
   */
  private repairLegacySemanticPlaceholders(): void {
    const isLegacySketchPlaceholder = (row: AssetRecord): boolean =>
      row.kind === "sketch"
      && (row.path !== null || text(row.metadata["supersededSourcePath"]) !== "")
      && row.metadata["immutable"] !== true
      && row.sources.includes("state.sketch");

    const affected = new Set<string>();
    for (const row of [...this.assets.values()]) {
      if (!isLegacySketchPlaceholder(row)) continue;
      const logicalRef = text(row.metadata["logicalRef"]) || row.path || lower(row.name);
      const immutableChild = [...this.assets.values()].find((candidate) =>
        candidate.supersedes === row.id && candidate.metadata["immutable"] === true,
      );
      if (immutableChild !== undefined) {
        this.assets.delete(row.id);
        affected.add(logicalRef);
        continue;
      }
      if (row.status !== "active") continue;
      const logicalKey = canonicalJson({
        sessionId: row.sessionRef.sessionId,
        kind: row.kind,
        logical: logicalRef,
      });
      const placeholderId = assetId({ logicalKey, version: "locator" });
      const semanticDigest = row.contentDigest;
      this.assets.delete(row.id);
      this.assets.set(placeholderId, {
        ...row,
        id: placeholderId,
        contentDigest: null,
        metadata: {
          ...row.metadata,
          logicalRef,
          semanticDigest,
          semanticPlaceholder: true,
        },
      });
    }

    // 删除伪 revision 后，把同一逻辑链重新编号；真正的 byte snapshots 及其 id
    // 完全不变，只有 revision/supersedes 去掉那个不存在的语义“文件版本”。
    for (const logicalRef of affected) {
      const chain = [...this.assets.values()]
        .filter((row) => (text(row.metadata["logicalRef"]) || row.path || lower(row.name)) === logicalRef)
        .sort((a, b) => a.revision - b.revision || a.createdSeq - b.createdSeq || a.id.localeCompare(b.id));
      let previous: string | null = null;
      chain.forEach((row, index) => {
        this.assets.set(row.id, { ...row, revision: index + 1, supersedes: previous });
        previous = row.id;
      });
    }
  }

  private rebuildHeads(): void {
    this.logicalHeads.clear();
    for (const row of this.assets.values()) {
      if (row.status === "superseded" || row.status === "deleted") continue;
      const logical = canonicalJson({
        sessionId: row.sessionRef.sessionId,
        kind: row.kind,
        logical: text(row.metadata["logicalRef"]) || row.path || row.uri || lower(row.name),
      });
      const current = this.logicalHeads.get(logical);
      if (current === undefined || (this.assets.get(current)?.updatedSeq ?? -1) <= row.updatedSeq) {
        this.logicalHeads.set(logical, row.id);
      }
    }
  }

  get(id: string): AssetRecord | null {
    return this.assets.get(id) ?? null;
  }

  list(options: { readonly includeSuperseded?: boolean } = {}): AssetRecord[] {
    const rows = [...this.assets.values()]
      .filter((row) => options.includeSuperseded || (row.status !== "superseded" && row.status !== "deleted"))
      .sort((a, b) => b.updatedSeq - a.updatedSeq || b.createdSeq - a.createdSeq || a.id.localeCompare(b.id));
    return options.includeSuperseded ? rows : projectDuplicateImages(rows);
  }

  upsert(input: AssetUpsertInput): AssetRecord {
    const sessionId = text(input.sessionId) || this.sessionId;
    const seq = input.seq === undefined ? this.lastSeq + 1 : integer(input.seq, this.lastSeq + 1);
    this.lastSeq = Math.max(this.lastSeq, seq);
    const name = text(input.name) || "未命名资产";
    const kind = input.kind ?? inferAssetKind(name);
    const path = normalizeRelativeAssetPath(input.path);
    const uri = normalizeUri(input.uri);
    const digest = text(input.contentDigest) || null;
    const logicalKey = logicalKeyOf(input, sessionId, kind, path, uri);
    const logicalRef = text(input.logicalRef) || text(input.sourceRef) || path || uri || lower(name);
    const id = assetId({ logicalKey, version: digest || "locator" });
    const existingExact = this.assets.get(id);
    const headId = this.logicalHeads.get(logicalKey);
    const head = headId === undefined ? null : this.assets.get(headId) ?? null;

    // event 先到而 digest 稍后由 state/file index 补齐时，删除临时 locator id，
    // 合并进内容地址；这不是新修订，不能在记忆里制造一份幽灵旧版。
    let base = existingExact;
    if (base === undefined && digest !== null && head !== null && head.contentDigest === null) {
      this.assets.delete(head.id);
      base = { ...head, id, contentDigest: digest };
    }
    if (base === undefined && digest === null && head !== null) base = head;

    if (base !== undefined) {
      const source = text(input.source) || base.source;
      const eventKind = text(input.eventKind) || base.sessionRef.eventKind;
      const preserveImmutableLocator = digest === null
        && base.contentDigest !== null
        && base.metadata["immutable"] === true;
      const mergedMetadata: Dict = { ...base.metadata, ...metadataOf(input.metadata), logicalRef };
      if (preserveImmutableLocator) mergedMetadata["semanticPlaceholder"] = false;
      const next: AssetRecord = {
        ...base,
        name: name === "未命名资产" ? base.name : name,
        mime: inferMime(name, text(input.mime) || base.mime),
        source: base.source || source,
        sources: unique([...base.sources, source]),
        origin: input.origin ?? base.origin,
        sessionRef: {
          sessionId,
          eventSeq: seq,
          turnId: input.turnId === undefined ? base.sessionRef.turnId : input.turnId,
          eventKind,
        },
        createdSeq: Math.min(base.createdSeq, seq),
        updatedSeq: Math.max(base.updatedSeq, seq),
        aliases: unique([...base.aliases, ...(input.aliases ?? [])]),
        tags: unique([...base.tags, ...(input.tags ?? [])]),
        provenanceRefs: unique([...base.provenanceRefs, ...(input.provenanceRefs ?? [])]),
        evidenceRefs: unique([...base.evidenceRefs, ...(input.evidenceRefs ?? [])]),
        status: input.status ?? base.status,
        displayOnly: input.displayOnly ?? base.displayOnly,
        uri: preserveImmutableLocator ? base.uri : uri ?? base.uri,
        path: preserveImmutableLocator ? base.path : path ?? base.path,
        contentDigest: digest ?? base.contentDigest,
        metadata: mergedMetadata,
      };
      this.assets.set(next.id, next);
      this.logicalHeads.set(logicalKey, next.id);
      return next;
    }

    let revision = 1;
    let supersedes: string | null = null;
    if (head !== null && head.contentDigest !== digest) {
      revision = head.revision + 1;
      supersedes = head.id;
      const hasRecoverableBytes = head.path === null || head.metadata["immutable"] === true;
      this.assets.set(head.id, {
        ...head,
        status: "superseded",
        updatedSeq: Math.max(head.updatedSeq, seq),
        // 没有服务端字节快照时，宁可明确标“旧字节不可用”，也不能留下一个会
        // 静默指向新内容的可覆盖 locator。服务端 snapshotFile 路径不会走到这里。
        path: hasRecoverableBytes ? head.path : null,
        uri: hasRecoverableBytes ? head.uri : null,
        metadata: hasRecoverableBytes
          ? head.metadata
          : {
              ...head.metadata,
              bytesUnavailable: true,
              supersededSourcePath: head.path,
            },
      });
    }
    const source = text(input.source) || "unknown";
    const row: AssetRecord = {
      id,
      kind,
      mime: inferMime(name, text(input.mime)),
      name,
      source,
      sources: unique([source]),
      origin: input.origin ?? "unknown",
      sessionRef: {
        sessionId,
        eventSeq: seq,
        turnId: input.turnId ?? null,
        eventKind: input.eventKind ?? null,
      },
      createdSeq: seq,
      updatedSeq: seq,
      aliases: unique(input.aliases ?? []),
      tags: unique(input.tags ?? []),
      provenanceRefs: unique(input.provenanceRefs ?? []),
      evidenceRefs: unique(input.evidenceRefs ?? []),
      revision,
      supersedes,
      status: input.status ?? "active",
      displayOnly: input.displayOnly ?? (kind === "sketch" || kind === "reference"),
      uri,
      path,
      contentDigest: digest,
      metadata: { ...metadataOf(input.metadata), logicalRef },
    };
    this.assets.set(row.id, row);
    this.logicalHeads.set(logicalKey, row.id);
    return row;
  }

  ingestEvent(event: AssetEventInput, options: { readonly sessionId?: string } = {}): AssetRecord[] {
    const payload = { ...record(event), ...record(event.payload) };
    const kind = text(event.kind) || text(payload["kind"]);
    const seq = integer(event.seq ?? payload["seq"], this.lastSeq + 1);
    const sessionId = text(options.sessionId) || this.sessionId;
    const made: AssetRecord[] = [];
    const common = {
      sessionId,
      seq,
      eventKind: kind,
      turnId: text(payload["turn_id"]) || text(payload["turnId"]) || null,
    } as const;

    if (kind === "files.attached" || kind === "materials.registered") {
      for (const raw of array(payload["files"])) {
        const f = typeof raw === "string" ? { name: raw } : record(raw);
        const name = text(f["name"]);
        if (!name) continue;
        made.push(this.upsert({
          ...common,
          kind: "material",
          name,
          path: `materials/${pathName(name)}`,
          mime: text(f["mime"]) || text(f["mime_type"]),
          source: kind,
          origin: "uploaded",
          contentDigest: text(f["sha256"]) || text(f["digest"]) || null,
          aliases: [pathName(name)],
          metadata: { size: f["size"] ?? null, note: payload["note"] ?? null },
        }));
      }
      return made;
    }

    if (kind === "artifact.ready" || kind === "export.ready" || kind === "delivery.ready") {
      const name = text(payload["name"]) || text(payload["file"]) || text(payload["artifact"]);
      if (!name) return made;
      const assetKind = kindOf(
        payload["asset_kind"] ?? payload["assetKind"] ?? payload["type"],
        name,
      );
      const explicitPath = normalizeRelativeAssetPath(text(payload["path"]));
      const storage = lower(text(payload["storage"]));
      const inferredPath = storage === "exports" || kind === "export.ready"
        ? `exports/${pathName(name)}`
        : pathName(name);
      made.push(this.upsert({
        ...common,
        kind: assetKind,
        name: pathName(name),
        path: explicitPath ?? inferredPath,
        uri: text(payload["uri"]) || null,
        mime: text(payload["mime"]) || text(payload["media_type"]),
        source: kind,
        origin: "generated",
        logicalRef: text(payload["logical_ref"] || payload["logicalRef"]) || null,
        contentDigest: text(payload["sha256"])
          || text(payload["digest"])
          || text(payload["content_digest"])
          || null,
        aliases: unique([payload["artifact"], payload["title"]]),
        tags: unique([assetKind, payload["source"], payload["surface"]]),
        provenanceRefs: refs(payload, "provenance_refs", "provenanceRefs", "run_ids"),
        evidenceRefs: refs(payload, "evidence_ids", "evidenceIds"),
        displayOnly: bool(payload["display_only"], bool(payload["displayOnly"])),
        metadata: {
          artifact: payload["artifact"] ?? null,
          model: payload["model"] ?? null,
          surface: payload["surface"] ?? null,
          canvasUpdated: payload["canvas_updated"] ?? payload["canvasUpdated"] ?? null,
          sourceKind: payload["source"] ?? null,
        },
      }));
      return made;
    }

    if (kind === "sketch.ready") {
      const name = text(payload["name"]);
      if (!name) return made;
      const domain = text(payload["domain"]);
      made.push(this.upsert({
        ...common,
        kind: "sketch",
        name: pathName(name),
        path: `exports/${pathName(name)}`,
        source: kind,
        origin: "model_knowledge",
        logicalRef: `sketch:${domain || pathName(name)}`,
        aliases: unique([domain, payload["title"], "参考流程图"]),
        tags: ["草图", "通用参考"],
        displayOnly: true,
        metadata: {
          domain,
          title: payload["title"] ?? null,
          mermaid: payload["mermaid"] ?? null,
          png: payload["png"] ?? null,
          sourceNote: payload["source_note"] ?? null,
          caveat: payload["caveat"] ?? null,
          layout: payload["layout"] ?? null,
          theme: payload["theme"] ?? null,
        },
      }));
      const png = text(payload["png"]);
      if (png) {
        made.push(this.upsert({
          ...common,
          kind: "image",
          name: pathName(png),
          path: `exports/${pathName(png)}`,
          source: kind,
          origin: "derived",
          aliases: unique([domain, payload["title"], "参考流程 PNG"]),
          tags: ["流程图", "通用参考"],
          displayOnly: true,
          metadata: { sketchName: name, sourceNote: payload["source_note"] ?? null },
        }));
      }
      return made;
    }

    if (kind === "prompts.ready" || kind === "clarify.request" || kind === "questions.ready") {
      const questions = array(payload["questions"]);
      return [...made, ...this.ingestQuestions(questions, {
        ...common,
        source: kind,
        listName: kind === "prompts.ready" ? "推荐问题清单" : "待澄清问题清单",
      })];
    }

    return made;
  }

  private ingestQuestions(
    questions: readonly unknown[],
    context: {
      readonly sessionId: string;
      readonly seq: number;
      readonly eventKind: string | null;
      readonly turnId: string | null;
      readonly source: string;
      readonly listName: string;
    },
  ): AssetRecord[] {
    if (questions.length === 0) return [];
    const made: AssetRecord[] = [];
    const normalized: Dict[] = [];
    const allEvidence: string[] = [];
    for (let index = 0; index < questions.length; index++) {
      const raw = typeof questions[index] === "string" ? { text: questions[index] } : record(questions[index]);
      const qtext = questionText(raw);
      if (!qtext) continue;
      const qid = text(raw["id"]) || text(raw["question_id"]) || assetId({ qtext }).slice(6, 22);
      const evidence = refs(raw, "evidenceIds", "evidence_ids", "evidence_refs");
      allEvidence.push(...evidence);
      const digest = sha256Hex(canonicalJson(raw));
      normalized.push({ id: qid, text: qtext, status: raw["status"] ?? null });
      made.push(this.upsert({
        sessionId: context.sessionId,
        // 一条 durable event 里的所有 item 共享该 event 的 seq；数组位置另存在
        // metadata.index，不能伪造出仓储里从未出现过的事件序号。
        seq: context.seq,
        eventKind: context.eventKind,
        turnId: context.turnId,
        kind: "question",
        name: text(raw["title"]) || qtext,
        source: context.source,
        origin: "derived",
        sourceRef: qid,
        contentDigest: digest,
        aliases: unique([qid, qtext, raw["prompt"]]),
        tags: unique([raw["status"], raw["priority"], raw["owner"]]),
        evidenceRefs: evidence,
        metadata: { ...metadataOf(raw), questionId: qid, index },
      }));
    }
    if (normalized.length > 0) {
      const ids = normalized.map((q) => text(q["id"]));
      made.push(this.upsert({
        sessionId: context.sessionId,
        seq: context.seq,
        eventKind: context.eventKind,
        turnId: context.turnId,
        kind: "question_list",
        name: context.listName,
        source: context.source,
        origin: "derived",
        logicalRef: `question-list:${context.source}`,
        contentDigest: sha256Hex(canonicalJson(normalized)),
        aliases: ["问题清单", "questions", context.listName],
        tags: ["问题", "访谈"],
        evidenceRefs: unique(allEvidence),
        metadata: { count: normalized.length, questionIds: ids, questions: normalized },
      }));
    }
    return made;
  }

  ingestSession(snapshot: AssetSessionSnapshot): AssetRecord[] {
    const made: AssetRecord[] = [];
    const sessionId = text(snapshot.sessionId) || this.sessionId;
    const seq = integer(snapshot.seq, this.lastSeq + 1);
    const state = record(snapshot.state);

    for (const [index, raw] of (snapshot.files ?? []).entries()) {
      const f = typeof raw === "string" ? { name: raw } : record(raw);
      const name = text(f["name"]);
      if (!name) continue;
      made.push(this.upsert({
        kind: "material",
        name: pathName(name),
        path: `materials/${pathName(name)}`,
        mime: text(f["mime"]) || text(f["mime_type"]),
        source: "session.files",
        origin: "uploaded",
        sessionId,
        seq: seq + index,
        contentDigest: text(f["sha256"]) || text(f["digest"]) || null,
        aliases: unique([name, f["label"]]),
        tags: ["材料", "上传"],
        metadata: { size: f["size"] ?? null, modifiedAt: f["modified_at"] ?? null },
      }));
    }

    // 某些 hydrate/export 路径把材料投影放在 state.materials 而非 Session.files。
    // 两路同时存在时，安全路径 + digest 的逻辑键会把它们合并，而不是多记一份。
    for (const [index, raw] of array(state["materials"]).entries()) {
      const item = typeof raw === "string" ? { name: raw } : record(raw);
      const name = text(item["name"]) || text(item["path"]);
      if (!name) continue;
      made.push(this.upsert({
        kind: "material",
        name: pathName(name),
        path: `materials/${pathName(name)}`,
        mime: text(item["mime"]) || text(item["mime_type"]),
        source: "state.materials",
        origin: originOf(item["origin"], "uploaded"),
        sessionId,
        seq: seq + index,
        contentDigest: text(item["sha256"]) || text(item["digest"]) || null,
        aliases: unique([name, item["label"], item["title"]]),
        tags: ["材料"],
        provenanceRefs: refs(item, "provenanceRefs", "provenance_refs"),
        evidenceRefs: refs(item, "evidenceIds", "evidence_ids"),
        metadata: item,
      }));
    }

    for (const [index, raw] of array(state["artifacts"]).entries()) {
      const item = typeof raw === "string" ? { name: raw } : record(raw);
      const name = text(item["name"]) || text(item["path"]);
      if (!name) continue;
      const kind = kindOf(item["kind"], name);
      made.push(this.upsert({
        kind,
        name: pathName(name),
        path: normalizeRelativeAssetPath(text(item["path"]) || name),
        uri: text(item["uri"]) || null,
        mime: text(item["mime"]) || text(item["media_type"]),
        source: "state.artifacts",
        origin: originOf(item["origin"], "generated"),
        sessionId,
        seq: seq + index,
        contentDigest: text(item["sha256"]) || text(item["digest"]) || null,
        aliases: unique([item["title"], item["label"]]),
        tags: unique([item["kind"], item["source"]]),
        displayOnly: bool(item["display_only"], bool(item["displayOnly"])),
        provenanceRefs: refs(item, "provenanceRefs", "provenance_refs"),
        evidenceRefs: refs(item, "evidenceIds", "evidence_ids"),
        metadata: item,
      }));
    }

    const sketch = record(state["sketch"]);
    const svg = text(sketch["svg"]);
    if (svg) {
      const domain = text(sketch["domain"]);
      const graph = record(sketch["graph"]);
      made.push(this.upsert({
        kind: "sketch",
        name: pathName(svg),
        path: `exports/${pathName(svg)}`,
        source: "state.sketch",
        origin: "model_knowledge",
        sessionId,
        seq,
        logicalRef: `sketch:${domain || pathName(svg)}`,
        // graph digest 是语义身份，不是 SVG 文件字节。把它塞进 contentDigest 会让
        // scanFiles 的真实 byte digest 被误判为第二版，留下一个不可恢复的假旧版。
        contentDigest: null,
        aliases: unique([domain, sketch["title"], "参考流程图"]),
        tags: ["草图", "通用参考"],
        displayOnly: true,
        metadata: {
          ...sketch,
          semanticDigest: Object.keys(graph).length > 0 ? sha256Hex(canonicalJson(graph)) : null,
          semanticPlaceholder: true,
        },
      }));
    }

    const backlog = record(state["question_backlog"]);
    const backlogQuestions = array(backlog["questions"]);
    const questions = backlogQuestions.length > 0 ? backlogQuestions : array(state["questions"]);
    if (questions.length > 0) {
      made.push(...this.ingestQuestions(questions, {
        sessionId,
        seq,
        eventKind: null,
        turnId: null,
        source: backlogQuestions.length > 0 ? "question_backlog" : "state.questions",
        listName: "问题清单",
      }));
    }

    for (const event of snapshot.events ?? []) made.push(...this.ingestEvent(event, { sessionId }));
    return made;
  }

  search(query: string, options: AssetSearchOptions = {}): AssetSearchHit[] {
    const q = lower(query);
    if (!q) return [];
    const recentIntent = RECENT_RE.test(q);
    const intents = intentKinds(q);
    const explicitKinds = new Set(options.kinds ?? []);
    const kinds = explicitKinds.size > 0 ? explicitKinds : intents;
    const queryTokens = searchTokens(q).filter((token) => !RECENT_RE.test(token));
    const includeHistory = options.includeSuperseded ?? HISTORY_RE.test(q);
    const rows = this.list({ includeSuperseded: includeHistory });
    const maxSeq = rows.reduce((best, row) => Math.max(best, row.updatedSeq), 0);
    const hits: AssetSearchHit[] = [];

    for (const row of rows) {
      if (kinds.size > 0 && !kinds.has(row.kind)) continue;
      const fields = [
        row.name,
        ...row.aliases,
        ...row.tags,
        ...row.sources,
        ...kindTerms(row),
        ...Object.values(row.metadata).filter((v): v is string => typeof v === "string"),
      ].map(lower);
      const haystack = fields.join(" ");
      let score = 0;
      const matched: string[] = [];
      if (q === lower(row.name) || row.aliases.some((alias) => lower(alias) === q)) {
        score += 140;
        matched.push("exact");
      } else if (haystack.includes(q)) {
        score += 80;
        matched.push("phrase");
      }
      for (const token of queryTokens) {
        if (token.length < 2 || !haystack.includes(token)) continue;
        score += token.length >= 4 ? 12 : 6;
        matched.push(token);
      }
      if (kinds.has(row.kind)) {
        score += 55;
        matched.push(`kind:${row.kind}`);
      }
      if (recentIntent) {
        score += maxSeq === 0 ? 0 : 25 * row.updatedSeq / maxSeq;
        matched.push("recent");
      }
      if (score <= 0) continue;
      hits.push({ asset: row, score, matched: unique(matched), recentIntent });
    }

    hits.sort((a, b) => b.score - a.score || b.asset.updatedSeq - a.asset.updatedSeq || a.asset.id.localeCompare(b.asset.id));
    return hits.slice(0, Math.max(1, Math.min(100, integer(options.limit, 12))));
  }

  resolveReference(query: string, options: AssetSearchOptions = {}): AssetResolution {
    const candidates = this.search(query, { ...options, limit: options.limit ?? 8 });
    const asset = candidates[0]?.asset ?? null;
    if (asset === null) return { query, status: "not_found", asset: null, candidates, reason: "none" };
    const matched = candidates[0]?.matched ?? [];
    const reason = matched.includes("exact")
      ? "exact"
      : RECENT_RE.test(query) ? "recent" : "semantic";
    return { query, status: "found", asset, candidates, reason };
  }

  toDict(): AssetMemoryDict {
    return {
      $schema: "ontocopilot.asset-memory/1",
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      assets: [...this.assets.values()].sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({
        ...row,
        sources: [...row.sources],
        aliases: [...row.aliases],
        tags: [...row.tags],
        provenanceRefs: [...row.provenanceRefs],
        evidenceRefs: [...row.evidenceRefs],
        metadata: metadataOf(row.metadata),
      })),
    };
  }
}

export function assetMemoryFromDict(raw: unknown): AssetMemory {
  return AssetMemory.fromDict(raw);
}
