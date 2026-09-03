import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import { defaultRegistry } from "../onto/parse/index.js";
import type { ParsedDoc } from "../onto/parse/base.js";
import {
  DocumentJobError,
  DocumentJobQueue,
  DocumentJobRunner,
  DocumentJobWorkerError,
  type DocumentJobKind,
  type DocumentJobListOptions,
  type DocumentJobRecord,
  type DocumentJobRepository,
  type DocumentJobRunOutcome,
  type DocumentJobWorker,
  type DocumentJobWorkerContext,
  type EnqueueDocumentJobInput,
} from "./jobs.js";
import type { DocumentRepository } from "./repository.js";
import type { DocumentScope, StoredDocumentVersion } from "./types.js";

export type DocumentJobFacadeErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "INTEGRITY_ERROR"
  | "COMMITTER_NOT_CONFIGURED"
  | "COMMIT_RESULT_INVALID";

export class DocumentJobFacadeError extends Error {
  constructor(
    readonly code: DocumentJobFacadeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentJobFacadeError";
    Object.setPrototypeOf(this, DocumentJobFacadeError.prototype);
  }
}

export interface ExactDocumentParser {
  parse(path: string, options: { readonly fileId: string }): Promise<ParsedDoc>;
}

export interface DocumentCandidateProcessorContext {
  readonly kind: DocumentJobKind;
  /** 已解析 realpath 且确认位于 workspaceRoot；不写入持久化任务结果。 */
  readonly exactPath: string;
  readonly job: DocumentJobRecord;
  readonly version: StoredDocumentVersion;
  heartbeat(): Promise<boolean>;
}

/** OCR 可实现这一契约；失败时可抛 DocumentJobWorkerError 表明是否值得重试。 */
export interface DocumentCandidateProcessor {
  readonly name: string;
  readonly version: string;
  process(context: DocumentCandidateProcessorContext): Promise<ParsedDoc>;
}

export interface DocumentParseCandidate {
  readonly schemaVersion: 1;
  readonly type: "onto_document_parse_candidate";
  readonly candidateKind: DocumentJobKind;
  readonly source: {
    readonly documentId: string;
    readonly versionId: string;
    readonly sourceSha256: string;
    readonly indexRevision: string;
  };
  readonly processor: {
    readonly name: string;
    readonly version: string;
  };
  readonly parsedDoc: ParsedDoc;
  readonly parsedDocSha256: string;
  readonly generatedAt: string;
  readonly immutableSource: true;
  readonly requiresNewVersion: true;
}

export interface CommitDerivedVersionInput {
  readonly scope: DocumentScope;
  readonly job: DocumentJobRecord;
  readonly sourceVersion: StoredDocumentVersion;
  readonly candidate: DocumentParseCandidate;
  /** 提交器必须在事务提交点检查它，禁止静默追加到已经变化的逻辑文档。 */
  readonly baseVersionId: string;
  readonly createdBy: string;
  /** facade 永远禁止解析任务自动采用新版本。 */
  readonly adopt: false;
}

export interface CommitDerivedVersionResult {
  readonly documentId: string;
  readonly sourceVersionId: string;
  readonly derivedVersionId: string;
  readonly adopted: false;
}

export interface DerivedDocumentVersionCommitter {
  commitDerivedVersion(input: CommitDerivedVersionInput): Promise<CommitDerivedVersionResult>;
}

export interface DocumentJobFacadeOptions {
  readonly repository: DocumentJobRepository;
  readonly documents: DocumentRepository;
  readonly workspaceRoot: string;
  readonly parser?: ExactDocumentParser;
  readonly parserName?: string;
  readonly parserVersion?: string;
  readonly ocrProcessor?: DocumentCandidateProcessor;
  readonly committer?: DerivedDocumentVersionCommitter;
  /** 在读取 exact relPath 前重做权限裁决；撤权后的排队任务必须停止。 */
  readonly beforeProcess?: (input: {
    readonly job: DocumentJobRecord;
    readonly version: StoredDocumentVersion;
  }) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly leaseMs?: number;
  readonly newLeaseToken?: () => string;
  readonly retryDelayMs?: (attempt: number, error: unknown) => number;
}

export interface DocumentJobListPage {
  readonly items: readonly DocumentJobRecord[];
  readonly offset: number;
  readonly nextOffset: number | null;
}

export interface CommitCandidateInput {
  readonly baseVersionId: string;
  readonly createdBy?: string;
}

function text(value: string, label: string, max = 2_048): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.includes("\u0000") || [...cleaned].length > max) {
    throw new DocumentJobFacadeError(
      "INVALID_ARGUMENT",
      `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`,
    );
  }
  return cleaned;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function persistedJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("含非有限数");
    return value;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error(`含不可持久化的 ${typeof value}`);
  }
  if (typeof value !== "object") throw new Error("含未知值");
  if (seen.has(value)) throw new Error("含循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => persistedJson(item, seen));
    if (value instanceof Map) {
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of value) {
        const name = String(key);
        if (Object.hasOwn(out, name)) throw new Error(`Map 键 ${name} 重复`);
        out[name] = persistedJson(item, seen);
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("含非 JSON 对象");
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error(`字段 ${key} 是 undefined`);
      out[key] = persistedJson(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function normalizeCandidate(doc: ParsedDoc, version: StoredDocumentVersion): ParsedDoc {
  let persisted: unknown;
  try {
    persisted = persistedJson(doc);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentJobWorkerError(`解析器结果不能安全持久化：${detail}`, false);
  }
  if (persisted === null || typeof persisted !== "object" || Array.isArray(persisted)) {
    throw new DocumentJobWorkerError("解析器没有返回 ParsedDoc", false);
  }
  const candidate = persisted as unknown as ParsedDoc;
  if (
    candidate.file_id !== version.id ||
    candidate.file_name !== version.fileName ||
    typeof candidate.kind !== "string" ||
    !candidate.kind.trim() ||
    !Array.isArray(candidate.chunks) ||
    !Array.isArray(candidate.findings) ||
    candidate.structured === null ||
    typeof candidate.structured !== "object" ||
    Array.isArray(candidate.structured) ||
    candidate.meta === null ||
    typeof candidate.meta !== "object" ||
    Array.isArray(candidate.meta)
  ) {
    throw new DocumentJobWorkerError("解析器结果与任务绑定的精确版本不一致", false);
  }
  // 空正文只能说明“仍未读到材料”，不能作为成功解析候选进入后续分析。
  if (candidate.chunks.length === 0) {
    throw new DocumentJobWorkerError("解析结果没有任何可定位正文；需要 OCR 或人工检查", false);
  }
  const ids = new Set<string>();
  for (const chunk of candidate.chunks) {
    if (
      typeof chunk.chunk_id !== "string" ||
      !chunk.chunk_id ||
      ids.has(chunk.chunk_id) ||
      chunk.file_id !== version.id ||
      chunk.file_name !== version.fileName ||
      chunk.locator === null ||
      typeof chunk.locator !== "object" ||
      Array.isArray(chunk.locator) ||
      typeof chunk.render !== "string" ||
      !chunk.render.trim() ||
      !Number.isSafeInteger(chunk.order) ||
      !Array.isArray(chunk.tags) ||
      chunk.tags.some((tag) => typeof tag !== "string") ||
      typeof chunk.context !== "string"
    ) {
      throw new DocumentJobWorkerError(
        "解析结果含空白、重复或无法定位的切片；已拒绝把它标成成功",
        false,
      );
    }
    ids.add(chunk.chunk_id);
  }
  for (const finding of candidate.findings) {
    if (
      finding === null ||
      typeof finding !== "object" ||
      typeof finding.kind !== "string" ||
      !finding.kind.trim() ||
      typeof finding.message !== "string" ||
      !finding.message.trim() ||
      typeof finding.severity !== "string" ||
      !finding.severity.trim() ||
      finding.locator === null ||
      typeof finding.locator !== "object" ||
      Array.isArray(finding.locator)
    ) {
      throw new DocumentJobWorkerError("解析结果含无法核验的 finding", false);
    }
  }
  return candidate;
}

function parseCandidate(value: unknown): DocumentParseCandidate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<DocumentParseCandidate>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.type !== "onto_document_parse_candidate" ||
    (candidate.candidateKind !== "parse" && candidate.candidateKind !== "ocr") ||
    candidate.immutableSource !== true ||
    candidate.requiresNewVersion !== true ||
    candidate.source === undefined ||
    candidate.source === null ||
    typeof candidate.source !== "object" ||
    candidate.processor === undefined ||
    candidate.processor === null ||
    typeof candidate.processor !== "object" ||
    candidate.parsedDoc === undefined ||
    candidate.parsedDoc === null ||
    typeof candidate.parsedDoc !== "object" ||
    typeof candidate.parsedDocSha256 !== "string" ||
    typeof candidate.generatedAt !== "string"
  ) {
    return null;
  }
  return candidate as DocumentParseCandidate;
}

function parserProcessor(
  parser: ExactDocumentParser,
  name: string,
  version: string,
): DocumentCandidateProcessor {
  return {
    name,
    version,
    process: ({ exactPath, version }) => parser.parse(exactPath, { fileId: version.id }),
  };
}

function candidateWorker(options: {
  readonly workspaceRoot: string;
  readonly processor: DocumentCandidateProcessor;
  readonly kind: DocumentJobKind;
  readonly now: () => Date;
  readonly beforeProcess?: DocumentJobFacadeOptions["beforeProcess"];
}): DocumentJobWorker {
  const configuredRoot = resolve(options.workspaceRoot);
  const processorName = text(options.processor.name, "处理器名称", 256);
  const processorVersion = text(options.processor.version, "处理器版本", 256);
  return {
    async run(context: DocumentJobWorkerContext) {
      if (context.job.kind !== options.kind) {
        throw new DocumentJobWorkerError("worker 与任务类型不一致", false);
      }
      if (options.beforeProcess !== undefined) {
        await options.beforeProcess({ job: context.job, version: context.version });
      }
      const relPath = context.version.relPath;
      if (!relPath || isAbsolute(relPath) || relPath.includes("\u0000")) {
        throw new DocumentJobWorkerError("版本保存的相对路径无效", false);
      }
      const root = await realpath(configuredRoot).catch(() => configuredRoot);
      const declared = resolve(root, relPath);
      if (!pathInside(root, declared)) {
        throw new DocumentJobWorkerError("版本文件不在 workspace 内", false);
      }
      let exactPath: string;
      try {
        exactPath = await realpath(declared);
      } catch {
        throw new DocumentJobWorkerError("版本原文件不存在", false);
      }
      if (!pathInside(root, exactPath)) {
        throw new DocumentJobWorkerError("版本文件通过链接逃出了 workspace", false);
      }
      const beforeStat = await stat(exactPath);
      if (!beforeStat.isFile()) throw new DocumentJobWorkerError("版本路径不是普通文件", false);
      const beforeBytes = await readFile(exactPath);
      if (
        beforeBytes.byteLength !== context.version.sizeBytes ||
        sha256Hex(beforeBytes) !== context.job.sourceSha256
      ) {
        throw new DocumentJobWorkerError("版本原文件与任务绑定的 SHA-256 不一致", false);
      }
      if (!(await context.heartbeat())) throw new DocumentJobWorkerError("任务租约已经丢失", false);
      let parsed: ParsedDoc;
      try {
        parsed = await options.processor.process({
          kind: options.kind,
          exactPath,
          job: context.job,
          version: context.version,
          heartbeat: context.heartbeat,
        });
      } catch (error) {
        if (error instanceof DocumentJobWorkerError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new DocumentJobWorkerError(
          `${options.kind === "ocr" ? "OCR" : "解析"}没有完成：${detail}`,
          options.kind === "ocr",
        );
      }
      // A parser/OCR backend can run for minutes. Its initial authorization is
      // not a durable capability, so revoke-sensitive jobs must re-authorize
      // after the processor returns and before any candidate can be persisted.
      if (options.beforeProcess !== undefined) {
        await options.beforeProcess({ job: context.job, version: context.version });
      }
      const afterBytes = await readFile(exactPath);
      const afterStat = await stat(exactPath);
      if (
        sha256Hex(afterBytes) !== context.job.sourceSha256 ||
        afterBytes.byteLength !== beforeBytes.byteLength ||
        afterStat.size !== beforeStat.size ||
        afterStat.mtimeMs !== beforeStat.mtimeMs ||
        afterStat.ctimeMs !== beforeStat.ctimeMs
      ) {
        throw new DocumentJobWorkerError("版本原文件在处理期间发生了变化", false);
      }
      if (!(await context.heartbeat())) throw new DocumentJobWorkerError("任务租约已经丢失", false);
      const normalized = normalizeCandidate(parsed, context.version);
      const parsedDocSha256 = sha256Hex(canonicalJson(normalized));
      const output: DocumentParseCandidate = {
        schemaVersion: 1,
        type: "onto_document_parse_candidate",
        candidateKind: options.kind,
        source: {
          documentId: context.job.documentId,
          versionId: context.job.versionId,
          sourceSha256: context.job.sourceSha256,
          indexRevision: context.job.expectedIndexRevision,
        },
        processor: {
          name: processorName,
          version: processorVersion,
        },
        parsedDoc: normalized,
        parsedDocSha256,
        generatedAt: options.now().toISOString(),
        immutableSource: true,
        requiresNewVersion: true,
      };
      return { output };
    },
  };
}

/** 面向 HTTP/Harness 的窄编排面；身份 scope 必须由认证层注入。 */
export class DocumentJobFacade {
  readonly queue: DocumentJobQueue;
  readonly runner: DocumentJobRunner;
  private readonly repository: DocumentJobRepository;
  private readonly documents: DocumentRepository;
  private readonly committer: DerivedDocumentVersionCommitter | undefined;

  constructor(options: DocumentJobFacadeOptions) {
    const now = options.now ?? (() => new Date());
    this.repository = options.repository;
    this.documents = options.documents;
    this.committer = options.committer;
    this.queue = new DocumentJobQueue({
      repository: options.repository,
      documents: options.documents,
      now,
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    });
    const workers: Partial<Record<DocumentJobKind, DocumentJobWorker>> = {
      parse: candidateWorker({
        workspaceRoot: options.workspaceRoot,
        processor: parserProcessor(
          options.parser ?? defaultRegistry(),
          options.parserName ?? (options.parser === undefined ? "default-registry" : "injected-parser"),
          options.parserVersion ?? "1",
        ),
        kind: "parse",
        now,
        ...(options.beforeProcess === undefined ? {} : { beforeProcess: options.beforeProcess }),
      }),
      ...(options.ocrProcessor === undefined
        ? {}
        : {
            ocr: candidateWorker({
              workspaceRoot: options.workspaceRoot,
              processor: options.ocrProcessor,
              kind: "ocr",
              now,
              ...(options.beforeProcess === undefined ? {} : { beforeProcess: options.beforeProcess }),
            }),
          }),
    };
    this.runner = new DocumentJobRunner({
      queue: this.queue,
      workers,
      now,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.newLeaseToken === undefined ? {} : { newLeaseToken: options.newLeaseToken }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    });
  }

  enqueue(scope: DocumentScope, input: EnqueueDocumentJobInput): Promise<DocumentJobRecord> {
    return this.queue.enqueue(scope, input);
  }

  async list(
    scope: DocumentScope,
    options: DocumentJobListOptions = {},
  ): Promise<DocumentJobListPage> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DocumentJobFacadeError("INVALID_ARGUMENT", "limit 必须是 1 到 100 的整数");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new DocumentJobFacadeError("INVALID_ARGUMENT", "offset 必须是 0 到 1000000 的整数");
    }
    const rows = await this.repository.list(scope, { ...options, limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit),
      offset,
      nextOffset: hasMore ? offset + limit : null,
    };
  }

  get(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    return this.queue.get(scope, jobId);
  }

  cancel(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    return this.queue.cancel(scope, jobId);
  }

  run(workerId: string): Promise<DocumentJobRunOutcome> {
    return this.runner.runOne(workerId);
  }

  async commitCandidate(
    scope: DocumentScope,
    jobId: string,
    input: CommitCandidateInput,
  ): Promise<CommitDerivedVersionResult> {
    const job = await this.get(scope, jobId);
    if (job === null) throw new DocumentJobFacadeError("NOT_FOUND", "没有找到这个项目中的解析任务");
    if (job.status !== "succeeded") {
      throw new DocumentJobFacadeError("INVALID_STATE", "只有成功且通过校验的候选结果才能提交");
    }
    if (sha256Hex(canonicalJson(job.result)) !== job.resultSha256) {
      throw new DocumentJobFacadeError("INTEGRITY_ERROR", "任务结果摘要校验失败");
    }
    const candidate = parseCandidate(job.result);
    if (
      candidate === null ||
      candidate.candidateKind !== job.kind ||
      candidate.source.documentId !== job.documentId ||
      candidate.source.versionId !== job.versionId ||
      candidate.source.sourceSha256 !== job.sourceSha256 ||
      candidate.source.indexRevision !== job.expectedIndexRevision ||
      sha256Hex(canonicalJson(candidate.parsedDoc)) !== candidate.parsedDocSha256
    ) {
      throw new DocumentJobFacadeError("INTEGRITY_ERROR", "候选解析结果与任务绑定版本不一致");
    }
    const sourceVersion = await this.documents.getVersion(
      scope,
      job.documentId,
      job.versionId,
    );
    if (
      sourceVersion === null ||
      sourceVersion.sha256 !== job.sourceSha256 ||
      sourceVersion.indexRevision !== job.expectedIndexRevision
    ) {
      throw new DocumentJobFacadeError("INTEGRITY_ERROR", "任务绑定的源版本已经变化");
    }
    if (this.committer === undefined) {
      throw new DocumentJobFacadeError(
        "COMMITTER_NOT_CONFIGURED",
        "没有配置派生版本提交器；候选结果仍保留在任务中，源版本未被修改",
      );
    }
    const sourceFingerprint = sha256Hex(canonicalJson(sourceVersion));
    const result: unknown = await this.committer.commitDerivedVersion({
      scope,
      job,
      sourceVersion,
      candidate,
      baseVersionId: text(input.baseVersionId, "基础版本 ID"),
      createdBy: text(input.createdBy ?? scope.owner, "创建人", 256),
      adopt: false,
    });
    const sourceAfter = await this.documents.getVersion(scope, job.documentId, job.versionId);
    if (sourceAfter === null || sha256Hex(canonicalJson(sourceAfter)) !== sourceFingerprint) {
      throw new DocumentJobFacadeError("INTEGRITY_ERROR", "提交派生版本时源版本被修改，已拒绝结果");
    }
    if (
      result === null ||
      typeof result !== "object" ||
      !("documentId" in result) ||
      !("sourceVersionId" in result) ||
      !("derivedVersionId" in result) ||
      !("adopted" in result) ||
      typeof result.documentId !== "string" ||
      typeof result.sourceVersionId !== "string" ||
      typeof result.derivedVersionId !== "string" ||
      result.documentId !== job.documentId ||
      result.sourceVersionId !== job.versionId ||
      result.derivedVersionId === job.versionId ||
      !result.derivedVersionId.trim() ||
      result.adopted !== false
    ) {
      throw new DocumentJobFacadeError(
        "COMMIT_RESULT_INVALID",
        "提交器没有返回一个未自动采用的新派生版本",
      );
    }
    return result as CommitDerivedVersionResult;
  }
}

/** 便于上层把 job error 映射到统一错误响应，不丢失底层幂等冲突码。 */
export function isDocumentJobFacadeError(
  error: unknown,
): error is DocumentJobFacadeError | DocumentJobError {
  return error instanceof DocumentJobFacadeError || error instanceof DocumentJobError;
}
