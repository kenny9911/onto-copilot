import { getStore } from "../../store/deps.js";
import type { Store } from "../../store/engine.js";
import { ConnectorRegistry } from "./registry.js";
import { ConnectorManagementService } from "./source_service.js";
import { buildConnectorSourceRepository } from "./source_repository.js";
import {
  ConnectorSyncService,
  type ConnectorDocumentSink,
} from "./sync.js";
import { ConnectorError } from "./types.js";

export interface ConnectorRuntime {
  readonly registry: ConnectorRegistry;
  readonly sink: ConnectorDocumentSink;
}

const unavailableSink: ConnectorDocumentSink = {
  async upsert() {
    throw new ConnectorError("SOURCE_UNAVAILABLE", "外部来源写入器尚未配置", true);
  },
  async remove() {
    throw new ConnectorError("SOURCE_UNAVAILABLE", "外部来源写入器尚未配置", true);
  },
  async updateAcl() {
    throw new ConnectorError("SOURCE_UNAVAILABLE", "外部来源写入器尚未配置", true);
  },
};

let runtime: ConnectorRuntime = {
  registry: new ConnectorRegistry(),
  sink: unavailableSink,
};
let runtimeReady = false;
let current: ConnectorManagementService | null = null;
let currentStore: Store | null | undefined = null;

export function buildConnectorManagementService(
  store: Store,
  configuredRuntime: ConnectorRuntime,
  now?: () => string,
  ready = true,
): ConnectorManagementService {
  const repository = buildConnectorSourceRepository(store);
  const sync = new ConnectorSyncService(repository, configuredRuntime.registry, configuredRuntime.sink, now);
  return new ConnectorManagementService(repository, sync, now, ready);
}

/**
 * 宿主在启动时注入已经拿到远端客户端的 registry 与 OntoDocument sink。这里不接收
 * token/secret/password；客户端只会在调用时拿到持久化的 credentialRef。
 */
export function registerConnectorRuntime(configuredRuntime: ConnectorRuntime | null): void {
  runtime = configuredRuntime ?? { registry: new ConnectorRegistry(), sink: unavailableSink };
  runtimeReady = configuredRuntime !== null;
  current = null;
  currentStore = null;
}

export function connectorManagementService(): ConnectorManagementService {
  if (current !== null && currentStore === undefined) return current;
  const store = getStore();
  if (current === null || currentStore !== store) {
    current = buildConnectorManagementService(store, runtime, undefined, runtimeReady);
    currentStore = store;
  }
  return current;
}

/** 路由可在 Store lifespan 之前注册；真正解析数据库延迟到第一次调用。 */
export function lazyConnectorManagementService(): ConnectorManagementService {
  return new Proxy(Object.create(null) as ConnectorManagementService, {
    get(_target, property) {
      const service = connectorManagementService() as unknown as Record<PropertyKey, unknown>;
      const member = service[property];
      return typeof member === "function" ? member.bind(service) : member;
    },
  });
}

export function setConnectorManagementServiceForTests(
  service: ConnectorManagementService | null,
): void {
  current = service;
  currentStore = service === null ? null : undefined;
}

export function resetConnectorManagementService(): void {
  current = null;
  currentStore = null;
}
