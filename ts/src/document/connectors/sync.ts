import { sha256Hex } from "../../kernel/ids.js";
import { ConnectorRegistry } from "./registry.js";
import {
  ConnectorError,
  type ConnectorAclEntry,
  type ConnectorBinding,
  type ConnectorChange,
  type ConnectorReadResult,
  type ConnectorSourceItem,
} from "./types.js";

export interface ConnectorSyncState {
  readonly bindingId: string;
  readonly cursor: string | null;
  readonly revision: number;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastError: string | null;
}

export interface ConnectorBindingRepository {
  get(bindingId: string): Promise<ConnectorBinding | null>;
  list(projectId: string): Promise<readonly ConnectorBinding[]>;
  save(binding: ConnectorBinding, expectedRevision?: number): Promise<ConnectorBinding>;
  state(bindingId: string): Promise<ConnectorSyncState>;
  commitCursor(
    bindingId: string,
    expectedRevision: number,
    cursor: string | null,
    completedAt: string,
    /** 还有一页要在同一次调用里继续处理时，受管来源必须保持 syncing。 */
    continueSync?: boolean,
  ): Promise<ConnectorSyncState>;
  recordFailure(bindingId: string, expectedRevision: number, startedAt: string, message: string): Promise<void>;
}

export interface ConnectorSinkContext {
  readonly binding: ConnectorBinding;
  readonly idempotencyKey: string;
}

/**
 * OntoDocument 领域服务实现这个端口。适配器不能直接碰数据库或文件系统，确保每个
 * 外部变更仍经过版本、ACL、解析、审计和发布门禁。
 */
export interface ConnectorDocumentSink {
  upsert(
    context: ConnectorSinkContext,
    content: ConnectorReadResult,
    acl: readonly ConnectorAclEntry[],
  ): Promise<void>;
  remove(context: ConnectorSinkContext, item: ConnectorSourceItem): Promise<void>;
  updateAcl(
    context: ConnectorSinkContext,
    item: ConnectorSourceItem,
    acl: readonly ConnectorAclEntry[],
  ): Promise<void>;
}

export interface ConnectorSyncReport {
  readonly bindingId: string;
  readonly pages: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly aclUpdated: number;
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
}

function idempotency(binding: ConnectorBinding, change: ConnectorChange): string {
  return sha256Hex([
    "ontodocument-connector-v1",
    binding.id,
    String(binding.configRevision),
    change.kind,
    change.item.externalId,
    change.item.sourceVersion,
    change.item.etag,
  ].join("\n"));
}

function safeError(error: unknown): string {
  if (error instanceof ConnectorError) return `${error.code}: ${error.message}`.slice(0, 2_000);
  return "SOURCE_UNAVAILABLE: 外部来源同步失败";
}

export class ConnectorSyncService {
  constructor(
    private readonly bindings: ConnectorBindingRepository,
    private readonly connectors: ConnectorRegistry,
    private readonly sink: ConnectorDocumentSink,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async sync(bindingId: string, options: { readonly pageSize?: number; readonly maxPages?: number } = {}): Promise<ConnectorSyncReport> {
    const binding = await this.bindings.get(bindingId);
    if (binding === null || !binding.enabled) {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "连接器不存在或没有启用");
    }
    const connector = this.connectors.get(binding.kind);
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 20;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
      throw new ConnectorError("INVALID_BINDING", "单次同步页数必须在 1—1000 之间");
    }
    const state = await this.bindings.state(binding.id);
    const startedAt = this.now();
    let cursor = state.cursor;
    let pages = 0;
    let upserted = 0;
    let deleted = 0;
    let aclUpdated = 0;
    let hasMore = false;
    try {
      do {
        const page = await connector.scan(binding, cursor ?? undefined, pageSize);
        // 一页所有副作用成功后才提交 cursor；中途失败会重放同页，sink 必须按 key 幂等。
        for (const change of page.changes) {
          const context = { binding, idempotencyKey: idempotency(binding, change) };
          if (change.kind === "delete") {
            await this.sink.remove(context, change.item);
            deleted += 1;
            continue;
          }
          const acl = change.acl ?? await connector.readAcl(binding, change.item.externalId);
          if (change.kind === "acl") {
            await this.sink.updateAcl(context, change.item, acl);
            aclUpdated += 1;
            continue;
          }
          const content = await connector.read(binding, change.item.externalId, change.item.sourceVersion);
          await this.sink.upsert(context, content, acl);
          upserted += 1;
        }
        pages += 1;
        cursor = page.nextCursor;
        hasMore = page.hasMore;
        await this.bindings.commitCursor(
          binding.id,
          state.revision,
          cursor,
          this.now(),
          hasMore && pages < maxPages,
        );
      } while (hasMore && pages < maxPages);
    } catch (error) {
      await this.bindings.recordFailure(binding.id, state.revision, startedAt, safeError(error));
      throw error;
    }
    const completedAt = this.now();
    return {
      bindingId: binding.id,
      pages,
      upserted,
      deleted,
      aclUpdated,
      nextCursor: cursor,
      complete: !hasMore,
      startedAt,
      completedAt,
    };
  }
}

export class MemoryConnectorBindingRepository implements ConnectorBindingRepository {
  private readonly bindings = new Map<string, ConnectorBinding>();
  private readonly states = new Map<string, ConnectorSyncState>();

  async get(bindingId: string): Promise<ConnectorBinding | null> {
    return this.bindings.get(bindingId) ?? null;
  }

  async list(projectId: string): Promise<readonly ConnectorBinding[]> {
    return [...this.bindings.values()].filter((row) => row.projectId === projectId);
  }

  async save(binding: ConnectorBinding, expectedRevision?: number): Promise<ConnectorBinding> {
    const existing = this.bindings.get(binding.id);
    if (existing !== undefined && expectedRevision !== existing.configRevision) {
      throw new ConnectorError("SOURCE_CHANGED", "连接器配置刚被修改，请刷新后重试");
    }
    if (existing === undefined && expectedRevision !== undefined) {
      throw new ConnectorError("SOURCE_CHANGED", "连接器配置基线不存在");
    }
    this.bindings.set(binding.id, structuredClone(binding));
    if (!this.states.has(binding.id)) {
      this.states.set(binding.id, {
        bindingId: binding.id,
        cursor: null,
        revision: binding.configRevision,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastError: null,
      });
    } else if (existing?.configRevision !== binding.configRevision) {
      this.states.set(binding.id, {
        bindingId: binding.id,
        cursor: null,
        revision: binding.configRevision,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastError: null,
      });
    }
    return structuredClone(binding);
  }

  async state(bindingId: string): Promise<ConnectorSyncState> {
    const state = this.states.get(bindingId);
    if (state === undefined) throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "连接器不存在");
    return { ...state };
  }

  async commitCursor(
    bindingId: string,
    expectedRevision: number,
    cursor: string | null,
    completedAt: string,
  ): Promise<ConnectorSyncState> {
    const state = await this.state(bindingId);
    if (state.revision !== expectedRevision) throw new ConnectorError("SOURCE_CHANGED", "连接器配置已变化");
    const next = { ...state, cursor, lastCompletedAt: completedAt, lastError: null };
    this.states.set(bindingId, next);
    return { ...next };
  }

  async recordFailure(bindingId: string, expectedRevision: number, startedAt: string, message: string): Promise<void> {
    const state = await this.state(bindingId);
    if (state.revision !== expectedRevision) return;
    this.states.set(bindingId, { ...state, lastStartedAt: startedAt, lastError: message.slice(0, 2_000) });
  }
}
