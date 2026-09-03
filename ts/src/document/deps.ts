import { getStore, workspaceRoot } from "../store/deps.js";
import type { Store } from "../store/engine.js";
import { buildDocumentAclController, type DocumentAclController } from "./acl.js";
import { buildDocumentSecurityAuditRepository } from "./audit.js";
import { buildDocumentRepository, type DocumentRepository } from "./repository.js";
import { DocumentService } from "./service.js";

let current: DocumentService | null = null;
let currentRepository: DocumentRepository | null = null;
let currentAcl: DocumentAclController | null = null;
// undefined 表示测试显式注入，不应被 documentService() 按当前 Store 覆盖。
let currentStore: Store | null | undefined = null;

/** 生产入口：在 Store 启动后惰性装配，所有 HTTP/Harness 调用共享同一实例。 */
export function documentService(): DocumentService {
  if (current !== null && currentStore === undefined) return current;
  const store = getStore();
  if (current === null || currentStore !== store) {
    const securityAudit = buildDocumentSecurityAuditRepository(store);
    currentRepository = buildDocumentRepository(store);
    currentAcl = buildDocumentAclController(store, securityAudit);
    current = new DocumentService({
      repository: currentRepository,
      workspaceRoot: workspaceRoot(),
      acl: currentAcl,
    });
    currentStore = store;
  }
  return current;
}

/** 搜索快照和安全管理 API 复用的同一 ACL 控制器。 */
export function documentAclController(): DocumentAclController {
  void documentService();
  if (currentAcl === null) {
    throw new Error("测试注入的 DocumentService 没有暴露 ACL；请同时注入编排服务");
  }
  return currentAcl;
}

/**
 * 与 DocumentService 共享的权威仓储。后台解析、搜索快照等编排层必须复用它，
 * 尤其不能在 memory 模式中另建一份看不到现有文档的仓储。
 */
export function documentRepository(): DocumentRepository {
  void documentService();
  if (currentRepository === null) {
    throw new Error("测试注入的 DocumentService 没有暴露文档仓储；请同时注入编排服务");
  }
  return currentRepository;
}

/**
 * 服务路由在 Store lifespan 之前装配；此代理把真正的仓储解析延迟到首个请求。
 * 这样启动接线仍可 fail-fast 校验路由，而不会在数据库尚未启动时提前 getStore()。
 */
export function lazyDocumentService(): DocumentService {
  return new Proxy(Object.create(null) as DocumentService, {
    get(_target, property) {
      const service = documentService() as unknown as Record<PropertyKey, unknown>;
      const member = service[property];
      return typeof member === "function" ? member.bind(service) : member;
    },
  });
}

/**
 * Store 已启动时惰性装配；启动接线和不带 lifespan 的窄单测中返回 null。
 * 这样 Harness/后台 build 不必等用户先打开一次知识库 HTTP 页面才看得到文档。
 */
export function getDocumentServiceOptional(): DocumentService | null {
  if (current !== null) return current;
  try {
    return documentService();
  } catch (error) {
    if (error instanceof Error && error.message === "Store 未初始化") return null;
    throw error;
  }
}

/** 单元/路由测试缝；传 null 后下一次 documentService() 会按当前 Store 重建。 */
export function setDocumentServiceForTests(service: DocumentService | null): void {
  current = service;
  currentRepository = null;
  currentAcl = null;
  currentStore = service === null ? null : undefined;
}

/** 生命周期重启或测试隔离时清掉进程级句柄。 */
export function resetDocumentService(): void {
  current = null;
  currentRepository = null;
  currentAcl = null;
  currentStore = null;
}
