import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { DocumentRepository, SearchChunkCandidate } from "./repository.js";
import {
  DocumentSearchSnapshotService,
  SearchSnapshotError,
  type DocumentSearchSnapshotRepository,
  type SearchSnapshotRecord,
} from "./search_snapshot.js";
import { levelOf } from "./types.js";
import type {
  DocumentScope,
  DocumentSearchHit,
  KnowledgeLevel,
  SearchCoverage,
} from "./types.js";

export type HybridSearchErrorCode =
  | "INVALID_ARGUMENT"
  | "SOURCE_INTEGRITY_ERROR"
  | "SEMANTIC_FAILED"
  | "SEMANTIC_RESULT_INVALID";

export class HybridSearchError extends Error {
  constructor(
    readonly code: HybridSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HybridSearchError";
    Object.setPrototypeOf(this, HybridSearchError.prototype);
  }
}

export interface SemanticScoreCandidate {
  /** 由 exact document/version/chunk 组成；scorer 不得返回列表外的 candidateId。 */
  readonly candidateId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly chunkId: string;
  readonly text: string;
  readonly textSha256: string;
}

export interface SemanticScoreRequest {
  readonly query: string;
  readonly candidates: readonly SemanticScoreCandidate[];
}

export interface SemanticScore {
  readonly candidateId: string;
  /** 只用于 scorer 内排序；不是事实置信度。 */
  readonly score: number;
}

export interface SemanticDocumentScorer {
  readonly name: string;
  score(request: SemanticScoreRequest): Promise<readonly SemanticScore[]>;
}

export interface HybridRankBreakdown {
  readonly method: "rrf";
  readonly rrfK: number;
  readonly fusedScore: number;
  readonly lexical: {
    readonly rank: number;
    readonly rawScore: number;
    readonly weight: number;
    readonly contribution: number;
  };
  readonly semantic: null | {
    readonly backend: string;
    readonly rank: number;
    readonly rawScore: number;
    readonly weight: number;
    readonly contribution: number;
  };
}

export interface HybridDocumentSearchHit extends DocumentSearchHit {
  /** score 是融合排序分；原始 BM25 与语义分均保留在 ranking 中。 */
  readonly score: number;
  readonly ranking: HybridRankBreakdown;
}

export interface HybridDocumentSearchResult {
  readonly query: string;
  readonly mode: "lexical_only" | "hybrid";
  readonly method: "rrf";
  readonly evidenceAvailable: boolean;
  readonly semantic: {
    readonly configured: boolean;
    readonly applied: boolean;
    readonly backend: string | null;
    readonly scoredCandidates: number;
  };
  readonly hits: readonly HybridDocumentSearchHit[];
}

export interface HybridDocumentSearchOptions {
  readonly semanticScorer?: SemanticDocumentScorer;
  readonly rrfK?: number;
  readonly lexicalWeight?: number;
  readonly semanticWeight?: number;
}

export interface HybridRankInput {
  readonly query: string;
  readonly bm25Hits: readonly DocumentSearchHit[];
  readonly limit?: number;
}

function cleanText(value: string, label: string, max = 4_000): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.includes("\u0000") || [...cleaned].length > max) {
    throw new HybridSearchError(
      "INVALID_ARGUMENT",
      `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`,
    );
  }
  return cleaned;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HybridSearchError("INVALID_ARGUMENT", `${label}必须是大于 0 的有限数`);
  }
  return value;
}

function candidateId(hit: Pick<DocumentSearchHit, "documentId" | "versionId" | "chunkId">): string {
  return Buffer.from(canonicalJson([hit.documentId, hit.versionId, hit.chunkId]), "utf8").toString(
    "base64url",
  );
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

/**
 * 只在已经由 BM25/ACL 召回并带原文哈希的候选集合内重排。语义后端没有资格
 * 生成新文档、新切片或新正文，因此它返回未知 candidateId 时直接拒绝结果。
 */
export class HybridDocumentSearch {
  private readonly semanticScorer: SemanticDocumentScorer | undefined;
  private readonly rrfK: number;
  private readonly lexicalWeight: number;
  private readonly semanticWeight: number;

  constructor(options: HybridDocumentSearchOptions = {}) {
    this.semanticScorer = options.semanticScorer;
    this.rrfK = options.rrfK ?? 60;
    if (!Number.isSafeInteger(this.rrfK) || this.rrfK < 1 || this.rrfK > 10_000) {
      throw new HybridSearchError("INVALID_ARGUMENT", "rrfK 必须是 1 到 10000 的整数");
    }
    this.lexicalWeight = positiveFinite(options.lexicalWeight ?? 1, "lexicalWeight");
    this.semanticWeight = positiveFinite(options.semanticWeight ?? 1, "semanticWeight");
  }

  async rank(input: HybridRankInput): Promise<HybridDocumentSearchResult> {
    const query = cleanText(input.query, "搜索内容");
    const limit = input.limit ?? Math.max(1, input.bm25Hits.length);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new HybridSearchError("INVALID_ARGUMENT", "limit 必须是 1 到 1000 的整数");
    }
    if (input.bm25Hits.length > 10_000) {
      throw new HybridSearchError("INVALID_ARGUMENT", "一次最多融合 10000 条候选证据");
    }
    if (input.bm25Hits.length === 0) {
      return {
        query,
        mode: "lexical_only",
        method: "rrf",
        evidenceAvailable: false,
        semantic: {
          configured: this.semanticScorer !== undefined,
          applied: false,
          backend: this.semanticScorer?.name.trim() || null,
          scoredCandidates: 0,
        },
        hits: [],
      };
    }

    const seen = new Set<string>();
    const lexical = [...input.bm25Hits];
    for (const hit of lexical) {
      cleanText(hit.documentId, "候选文档 ID", 2_048);
      cleanText(hit.versionId, "候选版本 ID", 2_048);
      cleanText(hit.chunkId, "候选切片 ID", 4_096);
      const key = candidateId(hit);
      if (seen.has(key)) {
        throw new HybridSearchError("INVALID_ARGUMENT", "BM25 候选中含重复的精确切片");
      }
      seen.add(key);
      if (!Number.isFinite(hit.score)) {
        throw new HybridSearchError("INVALID_ARGUMENT", "BM25 分数必须是有限数");
      }
      if (sha256Hex(hit.text) !== hit.textSha256) {
        throw new HybridSearchError(
          "SOURCE_INTEGRITY_ERROR",
          "BM25 候选正文与 textSha256 不一致，已拒绝融合",
        );
      }
    }
    lexical.sort(
      (a, b) => b.score - a.score || candidateId(a).localeCompare(candidateId(b)),
    );
    const lexicalRank = new Map(
      lexical.map((hit, index) => [candidateId(hit), { rank: index + 1, score: hit.score }]),
    );

    let semanticRank = new Map<string, { rank: number; score: number }>();
    let semanticBackend: string | null = null;
    if (this.semanticScorer !== undefined) {
      semanticBackend = cleanText(this.semanticScorer.name, "语义评分器名称", 256);
      let rawScores: unknown;
      try {
        rawScores = await this.semanticScorer.score({
          query,
          candidates: lexical.map((hit) => ({
            candidateId: candidateId(hit),
            documentId: hit.documentId,
            versionId: hit.versionId,
            chunkId: hit.chunkId,
            text: hit.text,
            textSha256: hit.textSha256,
          })),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new HybridSearchError("SEMANTIC_FAILED", `语义评分没有完成：${detail}`);
      }
      if (!Array.isArray(rawScores)) {
        throw new HybridSearchError("SEMANTIC_RESULT_INVALID", "语义评分器没有返回数组");
      }
      const scores = rawScores as readonly SemanticScore[];
      // 配置了后端却返回空集合，不能静默贴上 hybrid 标签或伪造零分。
      if (scores.length === 0) {
        throw new HybridSearchError("SEMANTIC_RESULT_INVALID", "语义评分器返回了空结果");
      }
      const semanticSeen = new Set<string>();
      for (const score of scores) {
        if (
          score === null ||
          typeof score !== "object" ||
          typeof score.candidateId !== "string" ||
          !seen.has(score.candidateId) ||
          semanticSeen.has(score.candidateId)
        ) {
          throw new HybridSearchError(
            "SEMANTIC_RESULT_INVALID",
            "语义评分器返回了未知或重复的候选 ID",
          );
        }
        if (!Number.isFinite(score.score)) {
          throw new HybridSearchError("SEMANTIC_RESULT_INVALID", "语义评分必须是有限数");
        }
        semanticSeen.add(score.candidateId);
      }
      semanticRank = new Map(
        [...scores]
          .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
          .map((score, index) => [score.candidateId, { rank: index + 1, score: score.score }]),
      );
    }

    const ranked: HybridDocumentSearchHit[] = lexical.map((hit) => {
      const key = candidateId(hit);
      const lexicalPart = lexicalRank.get(key)!;
      const semanticPart = semanticRank.get(key);
      const lexicalContribution = this.lexicalWeight / (this.rrfK + lexicalPart.rank);
      const semanticContribution = semanticPart === undefined
        ? 0
        : this.semanticWeight / (this.rrfK + semanticPart.rank);
      const fusedScore = rounded(lexicalContribution + semanticContribution);
      return {
        ...hit,
        locator: structuredClone(hit.locator),
        coverage: {
          ...hit.coverage,
          matchedTerms: [...hit.coverage.matchedTerms],
          missingTerms: [...hit.coverage.missingTerms],
        },
        score: fusedScore,
        ranking: {
          method: "rrf",
          rrfK: this.rrfK,
          fusedScore,
          lexical: {
            rank: lexicalPart.rank,
            rawScore: lexicalPart.score,
            weight: this.lexicalWeight,
            contribution: rounded(lexicalContribution),
          },
          semantic: semanticPart === undefined || semanticBackend === null
            ? null
            : {
                backend: semanticBackend,
                rank: semanticPart.rank,
                rawScore: semanticPart.score,
                weight: this.semanticWeight,
                contribution: rounded(semanticContribution),
              },
        },
      };
    });
    ranked.sort(
      (a, b) =>
        b.ranking.fusedScore - a.ranking.fusedScore ||
        a.ranking.lexical.rank - b.ranking.lexical.rank ||
        candidateId(a).localeCompare(candidateId(b)),
    );
    return {
      query,
      mode: this.semanticScorer === undefined ? "lexical_only" : "hybrid",
      method: "rrf",
      evidenceAvailable: true,
      semantic: {
        configured: this.semanticScorer !== undefined,
        applied: this.semanticScorer !== undefined,
        backend: semanticBackend,
        scoredCandidates: semanticRank.size,
      },
      hits: ranked.slice(0, limit),
    };
  }
}

export type SnapshotSearchCoordinatorErrorCode =
  | "INVALID_ARGUMENT"
  | "EMPTY_RESULT"
  | "QUERY_MISMATCH"
  | "SOURCE_CHANGED"
  | "INTEGRITY_ERROR";

export class SnapshotSearchCoordinatorError extends Error {
  constructor(
    readonly code: SnapshotSearchCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SnapshotSearchCoordinatorError";
    Object.setPrototypeOf(this, SnapshotSearchCoordinatorError.prototype);
  }
}

export interface SnapshotSearchCoordinatorOptions {
  readonly service: DocumentSearchSnapshotService;
  readonly snapshots: DocumentSearchSnapshotRepository;
  readonly documents: DocumentRepository;
}

export interface CreateCoordinatedSearchSnapshotInput {
  readonly query: string;
  readonly hits: readonly DocumentSearchHit[];
  readonly sessionId?: string;
  readonly ttlMs?: number;
}

export interface ReadCoordinatedSearchSnapshotInput {
  readonly snapshotId: string;
  /** 快照不保存查询明文；读取方必须重交原查询并通过 SHA-256 校验。 */
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CoordinatedSearchSnapshotPage {
  readonly snapshotId: string;
  readonly manifestSha256: string;
  readonly aclRevision: number;
  readonly totalItems: number;
  readonly querySha256: string;
  readonly hits: readonly DocumentSearchHit[];
  readonly nextCursor: string | null;
  readonly expiresAt: string;
}

function tokenize(input: string): string[] {
  const normalized = input.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (const match of normalized.matchAll(
    /[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
  )) {
    const token = match[0];
    if (/^[a-z0-9_]+$/u.test(token)) {
      if (token.length > 1) out.push(token);
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) out.push(chars[0]!);
    else for (let index = 0; index < chars.length - 1; index += 1) {
      out.push(chars[index]! + chars[index + 1]!);
    }
  }
  return out;
}

function coverageOf(query: string, candidate: SearchChunkCandidate): SearchCoverage {
  const unique = [...new Set(tokenize(query))];
  const available = new Set(
    tokenize(
      `${candidate.document.title} ${candidate.document.logicalName} ` +
        `${candidate.document.tags.join(" ")} ${candidate.chunk.context} ${candidate.chunk.render}`,
    ),
  );
  const matchedTerms = unique.filter((term) => available.has(term));
  const missingTerms = unique.filter((term) => !available.has(term));
  return {
    matchedTerms,
    missingTerms,
    queryTerms: unique.length,
    ratio: unique.length === 0 ? 1 : Number((matchedTerms.length / unique.length).toFixed(6)),
  };
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function evidenceRef(candidate: SearchChunkCandidate): string {
  return `odoc.v1.${encodePart(candidate.document.id)}.${encodePart(candidate.version.id)}.${encodePart(candidate.chunk.chunkId)}`;
}

function cite(candidate: SearchChunkCandidate, level: KnowledgeLevel): string {
  const preferred = ["sheet", "section", "page", "row", "cell", "path", "line", "paragraph"];
  const details: string[] = [];
  for (const key of preferred) {
    const value = candidate.chunk.locator[key];
    if (value !== undefined && value !== null && value !== "") details.push(`${key}=${String(value)}`);
  }
  const suffix = details.length > 0 ? details.join("，") : canonicalJson(candidate.chunk.locator);
  // 与 service.ts 的 cite() 逐字一致：总库片段要在引用里就说清楚。
  // 两处不一致时快照重放会因为 sameHitContent 判定 displayCite 不同而误报 SOURCE_CHANGED。
  const prefix = level === "global" ? "总库 " : "";
  return `${candidate.document.title}（${prefix}v${candidate.version.versionNo}，${suffix || `chunk=${candidate.chunk.chunkId}`}）`;
}

function materializeHit(
  query: string,
  score: number,
  candidate: SearchChunkCandidate,
  level: KnowledgeLevel,
): DocumentSearchHit {
  if (sha256Hex(candidate.chunk.render) !== candidate.chunk.textSha256) {
    throw new SnapshotSearchCoordinatorError(
      "INTEGRITY_ERROR",
      "快照切片正文与 textSha256 不一致，已拒绝返回",
    );
  }
  return {
    evidenceRef: evidenceRef(candidate),
    displayCite: cite(candidate, level),
    level,
    documentId: candidate.document.id,
    versionId: candidate.version.id,
    versionNo: candidate.version.versionNo,
    documentTitle: candidate.document.title,
    fileName: candidate.version.fileName,
    chunkId: candidate.chunk.chunkId,
    locator: structuredClone(candidate.chunk.locator),
    text: candidate.chunk.render,
    textSha256: candidate.chunk.textSha256,
    score,
    coverage: coverageOf(query, candidate),
  };
}

function sameHitContent(actual: DocumentSearchHit, expected: DocumentSearchHit): boolean {
  return (
    actual.evidenceRef === expected.evidenceRef &&
    actual.displayCite === expected.displayCite &&
    actual.documentId === expected.documentId &&
    actual.versionId === expected.versionId &&
    actual.versionNo === expected.versionNo &&
    actual.documentTitle === expected.documentTitle &&
    actual.fileName === expected.fileName &&
    actual.chunkId === expected.chunkId &&
    canonicalJson(actual.locator) === canonicalJson(expected.locator) &&
    actual.text === expected.text &&
    actual.textSha256 === expected.textSha256 &&
    canonicalJson(actual.coverage) === canonicalJson(expected.coverage)
  );
}

/**
 * 把一次 DocumentService.search 的真实命中固定成 exact version/index/ACL 快照，
 * 翻页时从仓储重新物化完整 hit；不保存查询明文，也不信任调用方回传的正文。
 */
export class SnapshotSearchCoordinator {
  private readonly service: DocumentSearchSnapshotService;
  private readonly snapshots: DocumentSearchSnapshotRepository;
  private readonly documents: DocumentRepository;

  constructor(options: SnapshotSearchCoordinatorOptions) {
    this.service = options.service;
    this.snapshots = options.snapshots;
    this.documents = options.documents;
  }

  async create(
    scope: DocumentScope,
    input: CreateCoordinatedSearchSnapshotInput,
  ): Promise<SearchSnapshotRecord> {
    const query = cleanText(input.query, "搜索内容");
    if (tokenize(query).length === 0) {
      throw new SnapshotSearchCoordinatorError("INVALID_ARGUMENT", "搜索内容没有可检索的文字");
    }
    if (input.hits.length === 0) {
      throw new SnapshotSearchCoordinatorError(
        "EMPTY_RESULT",
        "没有可固定的材料证据；不能把空结果包装成可用快照",
      );
    }
    if (input.hits.length > 10_000) {
      throw new SnapshotSearchCoordinatorError("INVALID_ARGUMENT", "一次最多固定 10000 条命中");
    }
    const pins = new Map<string, { documentId: string; versionId: string; indexRevision: string }>();
    const items: Array<{ documentId: string; versionId: string; chunkId: string; score: number }> = [];
    const seen = new Set<string>();
    for (const hit of input.hits) {
      if (!Number.isFinite(hit.score)) {
        throw new SnapshotSearchCoordinatorError("INVALID_ARGUMENT", "搜索命中分数必须是有限数");
      }
      const key = candidateId(hit);
      if (seen.has(key)) {
        throw new SnapshotSearchCoordinatorError("INVALID_ARGUMENT", "同一精确切片不能重复进入快照");
      }
      seen.add(key);
      const candidate = await this.documents.getChunk(
        scope,
        hit.documentId,
        hit.versionId,
        hit.chunkId,
      );
      if (candidate === null) {
        throw new SnapshotSearchCoordinatorError("SOURCE_CHANGED", "命中指向的精确切片已经不存在");
      }
      const expected = materializeHit(query, hit.score, candidate, levelOf(scope));
      if (!sameHitContent(hit, expected)) {
        throw new SnapshotSearchCoordinatorError(
          "SOURCE_CHANGED",
          "命中内容、定位信息或原文哈希与仓储中的精确版本不一致",
        );
      }
      const prior = pins.get(hit.versionId);
      if (prior !== undefined && prior.documentId !== hit.documentId) {
        throw new SnapshotSearchCoordinatorError("INTEGRITY_ERROR", "同一版本 ID 指向了不同文档");
      }
      pins.set(hit.versionId, {
        documentId: hit.documentId,
        versionId: hit.versionId,
        indexRevision: candidate.version.indexRevision,
      });
      items.push({
        documentId: hit.documentId,
        versionId: hit.versionId,
        chunkId: hit.chunkId,
        score: hit.score,
      });
    }
    return this.service.create(scope, {
      query,
      pins: [...pins.values()],
      items,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
  }

  /**
   * 编排层在 create 后的最终授权 fence 失败时使用。快照 id 尚未返回给用户也必须
   * 立即作废：审计日志、错误跟踪或可预测测试 id 都不能成为读取这份孤儿快照的旁路。
   */
  async invalidate(
    scope: DocumentScope,
    snapshotId: string,
    reason: string,
  ): Promise<void> {
    await this.snapshots.invalidate(
      scope,
      cleanText(snapshotId, "搜索快照 ID", 2_048),
      cleanText(reason, "失效原因", 512),
      new Date().toISOString(),
    );
  }

  async page(
    scope: DocumentScope,
    input: ReadCoordinatedSearchSnapshotInput,
  ): Promise<CoordinatedSearchSnapshotPage> {
    const snapshotId = cleanText(input.snapshotId, "搜索快照 ID", 2_048);
    const query = cleanText(input.query, "搜索内容");
    const record = await this.snapshots.get(scope, snapshotId);
    if (record === null) throw new SearchSnapshotError("NOT_FOUND", "没有找到这个搜索快照");
    const querySha256 = sha256Hex(query);
    if (querySha256 !== record.querySha256) {
      throw new SnapshotSearchCoordinatorError(
        "QUERY_MISMATCH",
        "查询内容与快照不一致；已拒绝用别的问题解释旧结果",
      );
    }
    const page = await this.service.page(scope, {
      snapshotId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const hits: DocumentSearchHit[] = [];
    for (const item of page.items) {
      const candidate = await this.documents.getChunk(
        scope,
        item.documentId,
        item.versionId,
        item.chunkId,
      );
      if (
        candidate === null ||
        candidate.version.indexRevision !== item.indexRevision ||
        candidate.chunk.textSha256 !== item.textSha256
      ) {
        await this.snapshots.invalidate(
          scope,
          snapshotId,
          "coordinator_source_changed",
          new Date().toISOString(),
        );
        throw new SnapshotSearchCoordinatorError(
          "SOURCE_CHANGED",
          "快照所引用的精确切片已经变化，已拒绝恢复结果",
        );
      }
      hits.push(materializeHit(query, item.score, candidate, levelOf(scope)));
    }
    // DocumentSearchSnapshotService fences its own item read, but this
    // coordinator subsequently re-loads and materializes the source text.
    // Re-check the live ACL generation after that final await window so a
    // concurrent revoke cannot leak a fully materialized hit.
    if ((await this.snapshots.currentAclRevision(scope)) !== page.aclRevision) {
      await this.snapshots.invalidate(
        scope,
        snapshotId,
        "coordinator_acl_revision_changed",
        new Date().toISOString(),
      );
      throw new SearchSnapshotError("ACL_CHANGED", "项目权限已经变化，请重新搜索");
    }
    return {
      snapshotId: page.snapshotId,
      manifestSha256: page.manifestSha256,
      aclRevision: page.aclRevision,
      totalItems: page.totalItems,
      querySha256,
      hits,
      nextCursor: page.nextCursor,
      expiresAt: page.expiresAt,
    };
  }
}
