import { documentAclController, documentRepository, documentService } from "./deps.js";
import { DocumentJobFacade, type DocumentCandidateProcessor } from "./job_facade.js";
import { buildDocumentJobRepository } from "./jobs.js";
import { DocumentOperations, documentJobAuthorizationGuard } from "./operations.js";
import type { DocumentRepository } from "./repository.js";
import {
  HybridDocumentSearch,
  SnapshotSearchCoordinator,
  type SemanticDocumentScorer,
} from "./search_orchestration.js";
import {
  buildDocumentSearchSnapshotRepository,
  DocumentSearchSnapshotService,
} from "./search_snapshot.js";
import type { DocumentAclController } from "./acl.js";
import type { DocumentService } from "./service.js";
import { getStore, workspaceRoot } from "../store/deps.js";
import type { Store } from "../store/engine.js";

export interface BuildDocumentOperationsOptions {
  readonly store: Store;
  readonly documents: DocumentService;
  readonly repository: DocumentRepository;
  readonly acl: DocumentAclController;
  readonly workspaceRoot: string;
  readonly ocrProcessor?: DocumentCandidateProcessor;
  readonly semanticScorer?: SemanticDocumentScorer;
  readonly workerId?: string;
  /** 窄单测可关闭；生产默认唤醒数据库里因重启遗留的 queued job。 */
  readonly resumeQueued?: boolean;
}

export function buildDocumentOperations(options: BuildDocumentOperationsOptions): DocumentOperations {
  const snapshots = buildDocumentSearchSnapshotRepository(
    options.store,
    async (scope) => await options.acl.currentRevision(scope),
  );
  const snapshotService = new DocumentSearchSnapshotService({
    repository: snapshots,
    documents: options.repository,
  });
  const jobs = new DocumentJobFacade({
    repository: buildDocumentJobRepository(options.store),
    documents: options.repository,
    workspaceRoot: options.workspaceRoot,
    // OCR 单页最长可到十分钟；一份扫描件最多 20 页。runner 当前没有 AbortSignal，
    // 因此使用它允许的最大租约，并继续依靠 exact SHA + lease token 阻止过期回写。
    leaseMs: 60 * 60_000,
    beforeProcess: documentJobAuthorizationGuard(options.acl),
    ...(options.ocrProcessor === undefined ? {} : { ocrProcessor: options.ocrProcessor }),
  });
  const operations = new DocumentOperations({
    documents: options.documents,
    acl: options.acl,
    jobs,
    hybrid: new HybridDocumentSearch({
      ...(options.semanticScorer === undefined ? {} : { semanticScorer: options.semanticScorer }),
    }),
    searches: new SnapshotSearchCoordinator({
      service: snapshotService,
      snapshots,
      documents: options.repository,
    }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
  });
  if (options.resumeQueued !== false) operations.kickWorker();
  return operations;
}

let ocrProcessor: DocumentCandidateProcessor | undefined;
let semanticScorer: SemanticDocumentScorer | undefined;
let current: DocumentOperations | null = null;
let currentStore: Store | null | undefined = null;

/** 宿主只注入已装配的 OCR 处理器；token、URL 和路径都不进入路由参数。 */
export function registerDocumentOcrProcessor(processor: DocumentCandidateProcessor | null): void {
  ocrProcessor = processor ?? undefined;
  current = null;
  currentStore = null;
}

/** 可选语义评分只在 BM25 已召回的真实候选内重排，不能扩充候选集合。 */
export function registerDocumentSemanticScorer(scorer: SemanticDocumentScorer | null): void {
  semanticScorer = scorer ?? undefined;
  current = null;
  currentStore = null;
}

export function documentOperations(): DocumentOperations {
  if (current !== null && currentStore === undefined) return current;
  const store = getStore();
  if (current === null || currentStore !== store) {
    current = buildDocumentOperations({
      store,
      documents: documentService(),
      repository: documentRepository(),
      acl: documentAclController(),
      workspaceRoot: workspaceRoot(),
      ...(ocrProcessor === undefined ? {} : { ocrProcessor }),
      ...(semanticScorer === undefined ? {} : { semanticScorer }),
    });
    currentStore = store;
  }
  return current;
}

/** 允许 serve.ts 在 Store lifespan 之前注册路由。 */
export function lazyDocumentOperations(): DocumentOperations {
  return new Proxy(Object.create(null) as DocumentOperations, {
    get(_target, property) {
      const operations = documentOperations() as unknown as Record<PropertyKey, unknown>;
      const member = operations[property];
      return typeof member === "function" ? member.bind(operations) : member;
    },
  });
}

export function setDocumentOperationsForTests(operations: DocumentOperations | null): void {
  current = operations;
  currentStore = operations === null ? null : undefined;
}

export function resetDocumentOperations(): void {
  current = null;
  currentStore = null;
}
