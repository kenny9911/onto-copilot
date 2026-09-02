import { DocumentNotFoundOrForbidden, type DocumentAclController } from "./acl.js";
import { DocumentJobFacade, type DocumentJobListPage } from "./job_facade.js";
import {
  DocumentJobWorkerError,
  type DocumentJobListOptions,
  type DocumentJobRecord,
  type EnqueueDocumentJobInput,
} from "./jobs.js";
import {
  HybridDocumentSearch,
  SnapshotSearchCoordinator,
  type CoordinatedSearchSnapshotPage,
  type HybridDocumentSearchResult,
} from "./search_orchestration.js";
import type { SearchSnapshotRecord } from "./search_snapshot.js";
import type { DocumentService } from "./service.js";
import type {
  DocumentScope,
  DocumentSearchOptions,
  DocumentSearchResult,
} from "./types.js";

function principal(scope: DocumentScope) {
  // 必须和 service.ts 的 principalOf 逐字一致：主体是**发起调用的人**，不是存储边界。
  //
  // 用 scope.owner 会在总知识库上给出与 service 相反的裁决 —— 总库边界 owner 是
  // `__global__`，于是 `principal.id === boundary.owner` 恒真、acl.ts 的 project_owner
  // 捷径恒中，startSearch 会放行每一条切片，而 service.search 在同一批资源上按真人裁决。
  // 同一份资源两条路径给出相反答案，ACL 就成了装饰。
  return { id: scope.actorId ?? scope.owner, groupIds: [] as string[] };
}

function jobScope(job: DocumentJobRecord): DocumentScope {
  return { projectId: job.projectId, owner: job.owner };
}

function jobResource(job: DocumentJobRecord) {
  return {
    scopeType: "version" as const,
    documentId: job.documentId,
    versionId: job.versionId,
  };
}

export interface StartDocumentSearchInput {
  readonly options: DocumentSearchOptions;
  readonly pageSize?: number;
  readonly ttlMs?: number;
}

export interface StartDocumentSearchResult {
  readonly search: DocumentSearchResult;
  readonly ranking: HybridDocumentSearchResult;
  readonly snapshot: SearchSnapshotRecord | null;
  readonly page: CoordinatedSearchSnapshotPage | null;
}

export interface ContinueDocumentSearchInput {
  readonly snapshotId: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DocumentOperationsOptions {
  readonly documents: DocumentService;
  readonly acl: DocumentAclController;
  readonly jobs: DocumentJobFacade;
  readonly searches: SnapshotSearchCoordinator;
  readonly hybrid: HybridDocumentSearch;
  readonly workerId?: string;
  readonly onWorkerError?: (error: unknown) => void;
}

/**
 * HTTP/Harness 上层共用的安全编排面。它不暴露 run/commit；后台 worker 只由 enqueue
 * 后的内部 kick 驱动，并在真正读文件前再次检查 exact version 的写权限。
 */
export class DocumentOperations {
  private readonly documents: DocumentService;
  private readonly acl: DocumentAclController;
  private readonly jobs: DocumentJobFacade;
  private readonly searches: SnapshotSearchCoordinator;
  private readonly hybrid: HybridDocumentSearch;
  private readonly workerId: string;
  private readonly onWorkerError: (error: unknown) => void;
  private draining: Promise<void> | null = null;

  constructor(options: DocumentOperationsOptions) {
    this.documents = options.documents;
    this.acl = options.acl;
    this.jobs = options.jobs;
    this.searches = options.searches;
    this.hybrid = options.hybrid;
    this.workerId = options.workerId ?? `document-worker-${process.pid}`;
    this.onWorkerError = options.onWorkerError ?? ((error) => console.error("[OntoDocument worker]", error));
  }

  async enqueueJob(
    scope: DocumentScope,
    input: EnqueueDocumentJobInput,
  ): Promise<DocumentJobRecord> {
    await this.acl.authorizeWrite(scope, principal(scope), {
      scopeType: "version",
      documentId: input.documentId,
      versionId: input.versionId,
    });
    const job = await this.jobs.enqueue(scope, input);
    this.kickWorker();
    return job;
  }

  async listJobs(
    scope: DocumentScope,
    options: DocumentJobListOptions = {},
  ): Promise<DocumentJobListPage> {
    const page = await this.jobs.list(scope, options);
    const visible: DocumentJobRecord[] = [];
    for (const job of page.items) {
      try {
        await this.acl.authorizeRead(scope, principal(scope), jobResource(job));
        visible.push(job);
      } catch (error) {
        if (!(error instanceof DocumentNotFoundOrForbidden)) throw error;
      }
    }
    return { ...page, items: visible };
  }

  async getJob(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    const job = await this.jobs.get(scope, jobId);
    if (job === null) return null;
    try {
      await this.acl.authorizeRead(scope, principal(scope), jobResource(job));
      return job;
    } catch (error) {
      if (error instanceof DocumentNotFoundOrForbidden) return null;
      throw error;
    }
  }

  async cancelJob(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    const job = await this.jobs.get(scope, jobId);
    if (job === null) return null;
    await this.acl.authorizeWrite(scope, principal(scope), jobResource(job));
    return this.jobs.cancel(scope, jobId);
  }

  async startSearch(
    scope: DocumentScope,
    input: StartDocumentSearchInput,
  ): Promise<StartDocumentSearchResult> {
    const search = await this.documents.search(scope, input.options);
    const ranking = await this.hybrid.rank({
      query: search.query,
      bm25Hits: search.hits,
      ...(search.hits.length === 0 ? {} : { limit: search.hits.length }),
    });
    // 空命中是真实且有意义的结果，但不能伪造一个“有证据”的快照，更不能推断
    // 文件或业务事实不存在。searchedVersions/coverage 原样返回给调用方说明检索范围。
    if (!ranking.evidenceAvailable) return { search, ranking, snapshot: null, page: null };

    // DocumentService.search 的白名单只对那次检索窗口有效。语义重排和快照物化之间
    // 可能发生撤权，因此对每个将要固定的 exact chunk 再授权，并记住同一 ACL
    // generation。不能只让 snapshot.create 读取“当前 revision”：若它恰好在撤权后
    // 读取到新 revision，却没有重新裁决资源，就会把撤权前 hit 包进一份“新鲜”快照。
    let authorizedRevision: number | null = null;
    for (const hit of ranking.hits) {
      const authorization = await this.acl.authorizeRead(scope, principal(scope), {
        scopeType: "chunk",
        documentId: hit.documentId,
        versionId: hit.versionId,
        chunkId: hit.chunkId,
      });
      if (authorizedRevision === null) authorizedRevision = authorization.aclRevision;
      else if (authorization.aclRevision !== authorizedRevision) {
        throw new DocumentNotFoundOrForbidden("搜索期间项目权限已经变化，请重新搜索");
      }
    }
    const snapshot = await this.searches.create(scope, {
      query: search.query,
      hits: ranking.hits,
      ...(input.options.sessionId === undefined ? {} : { sessionId: input.options.sessionId }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
    const finalAclRevision = await this.acl.currentRevision(scope);
    if (
      authorizedRevision === null ||
      snapshot.aclRevision !== authorizedRevision ||
      finalAclRevision !== authorizedRevision
    ) {
      await this.searches.invalidate(scope, snapshot.id, "authorization_generation_changed");
      throw new DocumentNotFoundOrForbidden("搜索期间项目权限已经变化，请重新搜索");
    }
    const page = await this.searches.page(scope, {
      snapshotId: snapshot.id,
      query: search.query,
      ...(input.pageSize === undefined ? {} : { limit: input.pageSize }),
    });
    return { search, ranking, snapshot, page };
  }

  continueSearch(
    scope: DocumentScope,
    input: ContinueDocumentSearchInput,
  ): Promise<CoordinatedSearchSnapshotPage> {
    return this.searches.page(scope, {
      snapshotId: input.snapshotId,
      query: input.query,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  /** 仅供进程内部唤醒；HTTP 和模型工具都不持有 DocumentJobFacade，不能调用它。 */
  kickWorker(): void {
    if (this.draining !== null) return;
    this.draining = Promise.resolve()
      .then(async () => {
        for (;;) {
          const outcome = await this.jobs.run(this.workerId);
          if (outcome.state === "idle") return;
        }
      })
      .catch((error: unknown) => this.onWorkerError(error))
      .finally(() => {
        this.draining = null;
      });
  }
}

/** 构建 facade 时使用：任务排队期间撤权，就在读取原文件前永久停止。 */
export function documentJobAuthorizationGuard(acl: DocumentAclController) {
  return async (input: {
    readonly job: DocumentJobRecord;
  }): Promise<void> => {
    const scope = jobScope(input.job);
    try {
      await acl.authorizeWrite(scope, principal(scope), jobResource(input.job));
    } catch (error) {
      if (error instanceof DocumentNotFoundOrForbidden) {
        throw new DocumentJobWorkerError("任务权限已经变化，源版本未处理", false);
      }
      throw error;
    }
  };
}
