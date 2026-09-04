import { getStore } from "../store/deps.js";
import type { Store } from "../store/engine.js";
import { MemoryWikiPageRepository, SqlWikiPageRepository } from "./wiki_repository.js";
import { WikiPageService } from "./wiki_service.js";

let current: WikiPageService | null = null;
// undefined 表示测试显式注入；不要被下一次 getStore() 覆盖。
let currentStore: Store | null | undefined = null;

/** 生产惰性装配：数据库 Store 用 SQL 仓储，显式纯内存 Store 用等价内存仓储。 */
export function wikiPageService(): WikiPageService {
  if (current !== null && currentStore === undefined) return current;
  const store = getStore();
  if (current === null || currentStore !== store) {
    current = new WikiPageService(
      store.engine === null
        ? new MemoryWikiPageRepository()
        : new SqlWikiPageRepository(store),
    );
    currentStore = store;
  }
  return current;
}

/**
 * Store 还没起来时返回 null，而不是抛。
 *
 * 对话工具要用它：一个工具在 Store 未就绪时应当**说自己现在不可用**，而不是让
 * 整轮对话炸掉。和 getDocumentServiceOptional（document/deps.ts:71）同一个形状，
 * 也同一个理由。
 */
export function getWikiPageServiceOptional(): WikiPageService | null {
  try {
    return wikiPageService();
  } catch (error) {
    if (error instanceof Error && error.message === "Store 未初始化") return null;
    throw error;
  }
}

/** 路由可以在 Store lifespan 之前注册；真正实例到第一次请求才解析。 */
export function lazyWikiPageService(): WikiPageService {
  return new Proxy(Object.create(null) as WikiPageService, {
    get(_target, property) {
      const service = wikiPageService() as unknown as Record<PropertyKey, unknown>;
      const member = service[property];
      return typeof member === "function" ? member.bind(service) : member;
    },
  });
}

export function setWikiPageServiceForTests(service: WikiPageService | null): void {
  current = service;
  currentStore = service === null ? null : undefined;
}

export function resetWikiPageService(): void {
  current = null;
  currentStore = null;
}
