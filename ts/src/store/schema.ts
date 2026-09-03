/**
 * 表定义 —— 移植自 `store/schema.py`（SQLAlchemy Core）。只有表结构，没有 ORM 映射。
 *
 * **为什么不上 ORM 实体**：领域对象（OIR / Conflict / DialogueMemory）是手写的
 * 数据类，每个值都包在 `Assertion` 里、带 `evidence: Provenance[]`。把它们映射成
 * ORM 实体意味着重写 oir.ts —— 而 oir 是这个产品的信任基础，不该为了持久化而动。
 * SQL-first 让存的形态就是 `toDict()` 的形态。（这也是选 Drizzle 而不是 Kysely 的
 * 理由：Kysely 只有 query builder，没有 schema 声明层。）
 *
 * **为什么一份定义要出两套方言**：测试要在没有容器的前提下跑，SQLite 与 Postgres
 * 共用同一份表定义，才不会出现"仓储代码写了两遍、其中一遍没人测"。
 *
 * ── 形态决策：中立 spec + 两个生成器，而不是两份手抄 ──────────────────────
 *
 * SQLAlchemy 靠 `sa.JSON().with_variant(JSONB, "postgresql")` 一份声明两用；
 * Drizzle 的 `pgTable` 与 `sqliteTable` 是**两套 builder**，没有 with_variant。
 * 摆在面前的两条路：
 *
 *   (a) 33 张表各手抄两遍 —— 66 份声明。这正是这个仓库反复吃过亏的那种漂移：
 *       `migrations/*.sql` 与 `schema.py` 就是两份手抄，靠一个测试兜着才没崩。
 *       再造一对手抄件等于再开一个同样的坑，而且这次连测试都得新写。
 *   (b) 一份中立的「表形状」描述（`TABLE_SPECS`），pg 与 sqlite 各消费一次。
 *
 * **选 (b)**。代价是 Drizzle 的逐列静态类型推断没了 —— 生成出来的列统一是
 * `PgColumn` / `SQLiteColumn` 而不是 `PgColumn<{data: string, notNull: true, …}>`。
 * 换回来的是**列名**级别的类型安全（`pgTables.session.nope` 编译期就红），以及
 * 「两套方言不可能漂移」这条由构造保证的性质。值类型在 repo 层用 `types.ts` 里的
 * Row DTO 补回来 —— 那本来就是显式的一层（Python 侧的 `_session_row(r)` 同理）。
 *
 * ── 与 migrations/*.sql 的关系 ────────────────────────────────────────────
 *
 * 这份定义与 `migrations/*.sql` 是**两份来源**：SQLite 侧靠这里建表，Postgres 侧
 * 靠迁移文件。**没有任何机制强制它们一致** —— schema.py 的文档字符串声称有个
 * `test_ddl_matches_metadata` 兜着，那个测试**根本不存在**（注释在撒谎）。真正兜
 * 底的是后补的列对齐测试；TS 侧在 `test/store.schema.test.ts` 里同样补了一个。
 *
 * 索引、CHECK、触发器**不在**对齐测试的管辖范围内，而且它们**已经漂移了**：
 *   * 0001 给 session 建的 `session_created_idx`、给 run 建的 `run_session_idx`、
 *     给 conflict 建的 `conflict_ask_idx` / `conflict_kind_idx`、给 decision 建的
 *     `decision_active_idx`，在 schema.py 里一个都没有 —— 这里照搬 schema.py，
 *     所以也一个都没有；
 *   * `touch_updated_at` / `notify_session_event` 这类 plpgsql 触发器同理。
 *     所以**别指望 `updated_at` 会自动刷新** —— SQLite 上没有触发器，该由代码显式写；
 *   * `decision.ts` / `chat_turn.ts` 的默认值：迁移写的是
 *     `extract(epoch from now())`，schema.py 写的是 `0`。这里跟 schema.py（它是
 *     移植源），差异记在这条注释里而不是悄悄"修正"成迁移那一版。
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  bigint as pgBigint,
  boolean as pgBoolean,
  check as pgCheck,
  customType,
  doublePrecision as pgDouble,
  index as pgIndex,
  integer as pgInteger,
  jsonb,
  primaryKey as pgPrimaryKey,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  unique as pgUnique,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import type { PgColumn, PgColumnBuilderBase, PgTable } from "drizzle-orm/pg-core";
import {
  blob as sqliteBlob,
  check as sqliteCheck,
  index as sqliteIndex,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  real as sqliteReal,
  sqliteTable,
  text as sqliteText,
  unique as sqliteUnique,
  uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  SQLiteColumn,
  SQLiteColumnBuilderBase,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";

export { DERIVED_KEYS, EVENT_INLINE_LIMIT } from "./const.js";

// ══════════════════════════════════════════════════════════════════
//  中立表形状
// ══════════════════════════════════════════════════════════════════

/** 跨方言的列语义。**不是** SQL 类型名 —— 每个 kind 到两种方言的落地见下面的
 * 生成器。`bigint` 与 `int` 分开是因为 PG 上确实是两个类型（SQLite 上都是
 * INTEGER，本来就是 64 位）。 */
export type ColKind =
  | "text"
  | "int"
  | "bigint"
  | "float"
  | "bool"
  | "json"
  | "bytes"
  /** SQLAlchemy 的 `DateTime(timezone=True)`。PG 是 timestamptz；SQLite 上
   * SQLAlchemy 存的是 ISO 文本，这里照做（存 epoch 数字会读不了旧库）。 */
  | "tstz";

/** `server_default` 的中立表示。`now` 对应 `sa.func.now()`。 */
export type ColDefault = { readonly kind: "now" } | { readonly kind: "lit"; readonly value: unknown };

export interface ColSpec {
  readonly kind: ColKind;
  /** 参与主键。主键列一律隐含 NOT NULL（与 SQLAlchemy 的 primary_key=True 同）。 */
  readonly pk?: true;
  readonly notNull?: true;
  readonly unique?: true;
  readonly default?: ColDefault;
  readonly ref?: {
    readonly table: string;
    readonly column: string;
    readonly onDelete: "cascade";
  };
}

export interface IndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: true;
  /** 部分索引谓词。SQLite 与 Postgres 的语法在这几条上一致，所以只写一份
   * （Python 侧就是把同一段文本同时喂给 postgresql_where 和 sqlite_where）。 */
  readonly where?: string;
}

export interface TableSpec {
  readonly columns: Readonly<Record<string, ColSpec>>;
  /** 表级 UNIQUE 约束（不是唯一索引 —— 名字会进 DDL）。 */
  readonly unique?: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly checks?: readonly { readonly name: string; readonly expr: string }[];
  readonly indexes?: readonly IndexSpec[];
}

const NOW: ColDefault = { kind: "now" };
const lit = (value: unknown): ColDefault => ({ kind: "lit", value });
const fkSession = {
  table: "session",
  column: "id",
  onDelete: "cascade",
} as const;

// ══════════════════════════════════════════════════════════════════
//  33 张表
// ══════════════════════════════════════════════════════════════════

export const TABLE_SPECS = {
  schema_migration: {
    columns: {
      version: { kind: "int", pk: true },
      name: { kind: "text", notNull: true },
      /** 文件 sha256，改历史迁移会被检出。 */
      checksum: { kind: "text", notNull: true },
      applied_at: { kind: "tstz", notNull: true, default: NOW },
    },
  },

  /** 项目文件夹。**只是分组，不是交付物上的项目名** —— 后者是 `session.project`
   * （一列文本，会印进导出的 xlsx 与包名），两者语义不同，不要互相顶替。
   *
   * 不设 owner 外键，理由与 `session.owner` 相同（见 0004）：删账号不连带删项目。 */
  project: {
    columns: {
      id: { kind: "text", pk: true },
      name: { kind: "text", notNull: true },
      /** app_user.id；NULL/'' = 无归属。与 session.owner 同源、同样不设外键。 */
      owner: { kind: "text" },
      /** 项目级偏好（命名规范/受众/问多少）。这轮恒为 {}，先把位置留出来。
       * **不给 default** —— 跨方言的默认值不一致，由代码总是显式写 {}。
       * （app_user.prefs 反倒给了 '{}'::jsonb，是历史遗留的不一致，照搬不"修正"。） */
      prefs: { kind: "json", notNull: true },
      sort_order: { kind: "int", notNull: true, default: lit(0) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
    indexes: [{ name: "project_owner_idx", columns: ["owner"] }],
  },

  /** 项目记忆：同一项目下的会话共享的结论。**跨会话，所以不能挂在 session_state 上**
   * —— 那张表主键含 session_id 且随会话 CASCADE，删掉任意一个会话就把记忆一起删了。
   *
   * `tier` 是这张表存在的理由：`authoritative` 是人拍板的约定，跨会话直接生效；
   * `reference` 是模型推断的教训，只作提示、永不晋升、不许进交付物的 provenance。
   * 两者混在一起存但**必须能分开查**，所以是一列受 CHECK 约束的枚举而不是布尔或标签。
   *
   * 不设到 project 的外键（同 0013 的理由）：删项目时由仓储显式删这些行，别把清理
   * 交给 CASCADE —— SQLite 侧的 PRAGMA foreign_keys 未必在每条路径上都开着。 */
  project_memory: {
    columns: {
      project_id: { kind: "text", pk: true },
      /** MemoryItem.key，形如 "{kind}:{slug}"。**不含 project** —— 隔离靠这里的
       * 复合主键，不靠 key 本身，所以同名主题在不同项目下互不干扰。 */
      key: { kind: "text", pk: true },
      tier: { kind: "text", notNull: true },
      kind: { kind: "text", notNull: true },
      content: { kind: "text", notNull: true },
      confidence: { kind: "float", notNull: true },
      support: { kind: "json", notNull: true },
      tags: { kind: "json", notNull: true },
      /** 这条记忆是在哪个会话里形成的。reference 档进 prompt 时要逐行标出来源。 */
      origin_session: { kind: "text", notNull: true, default: lit("") },
      /** 这条记忆来自哪几份材料。换会话换材料时据此再降一档权重。 */
      origin_files: { kind: "json", notNull: true },
      contested_by: { kind: "json", notNull: true },
      hit_runs: { kind: "json", notNull: true },
      use_count: { kind: "int", notNull: true, default: lit(0) },
      created_run: { kind: "text", notNull: true, default: lit("") },
      last_used_run: { kind: "text", notNull: true, default: lit("") },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      { name: "project_memory_tier_ck", expr: "tier IN ('authoritative','reference')" },
    ],
  },

  session: {
    columns: {
      id: { kind: "text", pk: true },
      title: { kind: "text", notNull: true, default: lit("新建会话") },
      project: { kind: "text", notNull: true, default: lit("") },
      status: { kind: "text", notNull: true, default: lit("idle") },
      error: { kind: "text", notNull: true, default: lit("") },
      state_version: { kind: "bigint", notNull: true, default: lit(0) },
      next_event_seq: { kind: "bigint", notNull: true, default: lit(0) },
      next_run_ordinal: { kind: "int", notNull: true, default: lit(0) },
      next_decision_ordinal: { kind: "int", notNull: true, default: lit(0) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
      /** 会话归属的账号 id（app_user.id）。NULL/'' = 无归属 —— 迁移前的旧会话与开放
       * 模式创建的会话都是这种，在强制鉴权下对所有人隐藏。不设外键：删账号不连带
       * 删会话（归属改判交给上层），也避免与 app_user 的生命周期耦合。 */
      owner: { kind: "text" },
      /** 所属项目文件夹（project.id）。NULL/'' = 未归类。聊天模式的会话恒为空。
       * 不设外键：删项目时由仓储显式把成员会话置空（同 owner 的先例）。 */
      project_id: { kind: "text" },
    },
    checks: [
      {
        name: "session_status_ck",
        expr:
          "status IN ('idle','queued','parsing','extracting','awaiting_answer'," +
          "'done','failed','stopped')",
      },
    ],
    indexes: [{ name: "session_project_idx", columns: ["project_id"] }],
  },

  // A build task itself lives in one ASGI worker, but its ownership must not.  A
  // lease prevents another worker (or a newly started replica) from treating a
  // still-live ``queued/parsing/extracting`` session as abandoned.
  build_lease: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      owner: { kind: "text", notNull: true },
      acquired_at: { kind: "float", notNull: true },
      heartbeat_at: { kind: "float", notNull: true },
      expires_at: { kind: "float", notNull: true },
      cancel_requested_at: { kind: "float" },
    },
    indexes: [{ name: "build_lease_expiry_idx", columns: ["expires_at"] }],
  },

  // Chat mutates DialogueMemory and several session_state documents via a read/modify/write
  // cycle.  An invocation-scoped lease prevents two ASGI workers from both reading the
  // same snapshot and committing last-writer-wins updates.
  chat_lease: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      owner: { kind: "text", notNull: true },
      acquired_at: { kind: "float", notNull: true },
      heartbeat_at: { kind: "float", notNull: true },
      expires_at: { kind: "float", notNull: true },
      cancel_requested_at: { kind: "float" },
    },
    indexes: [{ name: "chat_lease_expiry_idx", columns: ["expires_at"] }],
  },

  // Domain mutations span Question/Decision/Revision rows, session_state and generated
  // files.  One durable lease serializes that read/modify/write unit across workers and
  // is mutually exclusive with a build lease.
  mutation_lease: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      owner: { kind: "text", notNull: true },
      kind: { kind: "text", notNull: true },
      acquired_at: { kind: "float", notNull: true },
      heartbeat_at: { kind: "float", notNull: true },
      expires_at: { kind: "float", notNull: true },
    },
    indexes: [{ name: "mutation_lease_expiry_idx", columns: ["expires_at"] }],
  },

  session_file: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      name: { kind: "text", pk: true },
      /** 相对 workspace/<session_id>/ —— 绝不存绝对路径（现状 server.py:187）。 */
      rel_path: { kind: "text", notNull: true },
      size_bytes: { kind: "bigint", notNull: true },
      sha256: { kind: "text", notNull: true, default: lit("") },
      uploaded_at: { kind: "tstz", notNull: true, default: NOW },
    },
  },

  /** OntoDocument 的项目级逻辑文档。文档与版本分表：元数据可以人工修订，已经入库的
   * 版本内容永远不改。owner/project_id 都是强制列，仓储每条读取都同时过滤两者；
   * 不挂外键，避免删除项目/用户时由数据库暗中级联掉可审计的知识资产。 */
  onto_document: {
    columns: {
      id: { kind: "text", pk: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      title: { kind: "text", notNull: true },
      logical_name: { kind: "text", notNull: true },
      source_class: { kind: "text", notNull: true },
      tags: { kind: "json", notNull: true },
      status: { kind: "text", notNull: true, default: lit("active") },
      current_version_id: { kind: "text", notNull: true },
      adopted_version_id: { kind: "text" },
      revision: { kind: "int", notNull: true, default: lit(1) },
      created_by: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
      /** 用户手工建的文件夹路径。空串 = 根目录（既有数据的默认落点）。 */
      folder_path: { kind: "text", notNull: true, default: lit("") },
    },
    checks: [
      { name: "onto_document_status_ck", expr: "status IN ('active','archived')" },
      {
        name: "onto_document_source_class_ck",
        expr: "source_class IN ('session_upload','generated','external','imported')",
      },
    ],
    indexes: [
      { name: "onto_document_project_owner_idx", columns: ["project_id", "owner", "status"] },
      { name: "onto_document_adopted_idx", columns: ["adopted_version_id"] },
    ],
  },

  /** 一次解析后的不可变版本。parsed_doc 保存完整 ParsedDoc（含 structured/findings/meta
   * 与全部 chunks），chunk 表则给检索和精确打开提供可索引的扁平读路径。 */
  onto_document_version: {
    columns: {
      id: { kind: "text", pk: true },
      document_id: { kind: "text", notNull: true },
      version_no: { kind: "int", notNull: true },
      file_name: { kind: "text", notNull: true },
      media_type: { kind: "text", notNull: true },
      size_bytes: { kind: "bigint", notNull: true },
      sha256: { kind: "text", notNull: true },
      rel_path: { kind: "text", notNull: true },
      doc_kind: { kind: "text", notNull: true },
      parsed_doc: { kind: "json", notNull: true },
      parse_status: { kind: "text", notNull: true },
      parser_name: { kind: "text", notNull: true },
      parser_version: { kind: "text", notNull: true },
      index_revision: { kind: "text", notNull: true },
      chunk_count: { kind: "int", notNull: true },
      created_by: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    unique: [
      { name: "onto_document_version_no_uq", columns: ["document_id", "version_no"] },
      { name: "onto_document_version_sha_uq", columns: ["document_id", "sha256"] },
    ],
    checks: [
      { name: "onto_document_version_no_ck", expr: "version_no > 0" },
      { name: "onto_document_parse_status_ck", expr: "parse_status IN ('ready','degraded')" },
    ],
    indexes: [{ name: "onto_document_version_document_idx", columns: ["document_id"] }],
  },

  onto_document_chunk: {
    columns: {
      version_id: { kind: "text", pk: true },
      chunk_id: { kind: "text", pk: true },
      document_id: { kind: "text", notNull: true },
      order_no: { kind: "int", notNull: true },
      locator: { kind: "json", notNull: true },
      render_text: { kind: "text", notNull: true },
      raw_json: { kind: "json", notNull: true },
      tags: { kind: "json", notNull: true },
      context: { kind: "text", notNull: true },
      text_sha256: { kind: "text", notNull: true },
    },
    indexes: [
      { name: "onto_document_chunk_document_idx", columns: ["document_id"] },
      { name: "onto_document_chunk_version_order_idx", columns: ["version_id", "order_no"] },
    ],
  },

  /** 会话固定到精确 version_id。采用版本以后发生变化，也不会让正在运行的 build
   * 偷偷换材料。project_id/owner 是冗余的安全边界列，每条查询仍会与文档表交叉校验。 */
  session_document: {
    columns: {
      session_id: { kind: "text", pk: true },
      document_id: { kind: "text", pk: true },
      version_id: { kind: "text", notNull: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      role: { kind: "text", notNull: true, default: lit("reference") },
      attached_by: { kind: "text", notNull: true },
      attached_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      { name: "session_document_role_ck", expr: "role IN ('reference','primary')" },
    ],
    indexes: [
      { name: "session_document_session_idx", columns: ["session_id"] },
      { name: "session_document_scope_idx", columns: ["project_id", "owner"] },
    ],
  },

  /** 项目知识库 ACL 的 CAS 版本。规则变更和 revision 递增必须在同一事务提交，
   * 检索快照和打开前复核都携带这个版本，避免撤权后继续使用旧命中。 */
  onto_document_acl_state: {
    columns: {
      project_id: { kind: "text", pk: true },
      owner: { kind: "text", pk: true },
      revision: { kind: "int", notNull: true, default: lit(0) },
      updated_by: { kind: "text", notNull: true },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [{ name: "onto_document_acl_revision_ck", expr: "revision >= 0" }],
  },

  /** principal/group 的 allow/deny 规则。scope_type 决定后三个 target id 的合法形状；
   * 仓储还会做同样校验，不能依赖某个数据库恰好启用了 CHECK。 */
  onto_document_acl_rule: {
    columns: {
      project_id: { kind: "text", pk: true },
      owner: { kind: "text", pk: true },
      id: { kind: "text", pk: true },
      subject_type: { kind: "text", notNull: true },
      subject_id: { kind: "text", notNull: true },
      effect: { kind: "text", notNull: true },
      permission: { kind: "text", notNull: true },
      scope_type: { kind: "text", notNull: true },
      document_id: { kind: "text" },
      version_id: { kind: "text" },
      chunk_id: { kind: "text" },
      changed_revision: { kind: "int", notNull: true },
      created_by: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      { name: "onto_document_acl_subject_ck", expr: "subject_type IN ('principal','group')" },
      { name: "onto_document_acl_effect_ck", expr: "effect IN ('allow','deny')" },
      { name: "onto_document_acl_permission_ck", expr: "permission IN ('read','write','manage_acl')" },
      { name: "onto_document_acl_scope_ck", expr: "scope_type IN ('project','document','version','chunk')" },
      { name: "onto_document_acl_changed_revision_ck", expr: "changed_revision > 0" },
      {
        name: "onto_document_acl_target_shape_ck",
        expr:
          "(scope_type = 'project' AND document_id IS NULL AND version_id IS NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'document' AND document_id IS NOT NULL AND version_id IS NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'version' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'chunk' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NOT NULL)",
      },
    ],
    indexes: [
      {
        name: "onto_document_acl_subject_idx",
        columns: ["project_id", "owner", "subject_type", "subject_id"],
      },
      {
        name: "onto_document_acl_target_idx",
        columns: ["project_id", "owner", "document_id", "version_id", "chunk_id"],
      },
    ],
  },

  /** 文档安全审计只存身份、动作、裁决、资源 id 和摘要计数；没有正文、查询原文、
   * chunk render/raw/context 等列。detail 的键和值还会由 audit.ts 白名单化。 */
  onto_document_security_audit: {
    columns: {
      id: { kind: "text", pk: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      actor_type: { kind: "text", notNull: true },
      actor_id: { kind: "text", notNull: true },
      action: { kind: "text", notNull: true },
      decision: { kind: "text", notNull: true },
      scope_type: { kind: "text", notNull: true },
      document_id: { kind: "text" },
      version_id: { kind: "text" },
      chunk_id: { kind: "text" },
      acl_revision: { kind: "int", notNull: true },
      matched_rule_ids: { kind: "json", notNull: true },
      detail: { kind: "json", notNull: true },
      occurred_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      { name: "onto_document_security_actor_ck", expr: "actor_type IN ('principal','service')" },
      {
        name: "onto_document_security_action_ck",
        expr: "action IN ('acl.change','search.filter','document.read','version.read','chunk.read')",
      },
      { name: "onto_document_security_decision_ck", expr: "decision IN ('allow','deny','changed')" },
      { name: "onto_document_security_scope_ck", expr: "scope_type IN ('project','document','version','chunk')" },
      { name: "onto_document_security_revision_ck", expr: "acl_revision >= 0" },
      {
        name: "onto_document_security_target_shape_ck",
        expr:
          "(scope_type = 'project' AND document_id IS NULL AND version_id IS NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'document' AND document_id IS NOT NULL AND version_id IS NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'version' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NULL) OR " +
          "(scope_type = 'chunk' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NOT NULL)",
      },
    ],
    indexes: [
      {
        name: "onto_document_security_project_idx",
        columns: ["project_id", "owner", "occurred_at"],
      },
      {
        name: "onto_document_security_actor_idx",
        columns: ["actor_type", "actor_id", "occurred_at"],
      },
    ],
  },

  /** 可被多副本领取的解析/OCR 任务。任务复制目标版本的内容摘要与索引版本，worker
   * 开始执行前必须再次核对；lease_token 让过期 worker 无法覆盖后来重领的结果。 */
  onto_document_job: {
    columns: {
      id: { kind: "text", pk: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      document_id: { kind: "text", notNull: true },
      version_id: { kind: "text", notNull: true },
      kind: { kind: "text", notNull: true },
      idempotency_key: { kind: "text", notNull: true },
      request_sha256: { kind: "text", notNull: true },
      source_sha256: { kind: "text", notNull: true },
      expected_index_revision: { kind: "text", notNull: true },
      input: { kind: "json", notNull: true },
      status: { kind: "text", notNull: true, default: lit("queued") },
      attempts: { kind: "int", notNull: true, default: lit(0) },
      max_attempts: { kind: "int", notNull: true, default: lit(3) },
      available_at: { kind: "tstz", notNull: true },
      lease_owner: { kind: "text" },
      lease_token: { kind: "text" },
      lease_expires_at: { kind: "tstz" },
      result: { kind: "json", notNull: true },
      result_sha256: { kind: "text", notNull: true, default: lit("") },
      last_error: { kind: "text", notNull: true, default: lit("") },
      created_at: { kind: "tstz", notNull: true },
      updated_at: { kind: "tstz", notNull: true },
      started_at: { kind: "tstz" },
      completed_at: { kind: "tstz" },
    },
    unique: [
      {
        name: "onto_document_job_scope_key_uq",
        columns: ["project_id", "owner", "idempotency_key"],
      },
    ],
    checks: [
      { name: "onto_document_job_kind_ck", expr: "kind IN ('parse','ocr')" },
      {
        name: "onto_document_job_status_ck",
        expr: "status IN ('queued','running','succeeded','failed','cancelled')",
      },
      {
        name: "onto_document_job_attempts_ck",
        expr: "attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts",
      },
      {
        name: "onto_document_job_lease_shape_ck",
        expr:
          "(status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL " +
          "AND lease_expires_at IS NOT NULL) OR " +
          "(status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL " +
          "AND lease_expires_at IS NULL)",
      },
    ],
    indexes: [
      {
        name: "onto_document_job_queue_idx",
        columns: ["status", "available_at", "lease_expires_at"],
      },
      {
        name: "onto_document_job_version_idx",
        columns: ["project_id", "owner", "version_id", "created_at"],
      },
    ],
  },

  /** 一次搜索的固定语义清单和过期边界。query 只存摘要，避免任务表复制用户查询；
   * manifest 固定 version/index/ACL revision，翻页时逐项复核。 */
  onto_document_search_snapshot: {
    columns: {
      id: { kind: "text", pk: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      session_id: { kind: "text" },
      query_sha256: { kind: "text", notNull: true },
      manifest: { kind: "json", notNull: true },
      manifest_sha256: { kind: "text", notNull: true },
      acl_revision: { kind: "int", notNull: true },
      status: { kind: "text", notNull: true, default: lit("active") },
      invalidated_reason: { kind: "text", notNull: true, default: lit("") },
      total_items: { kind: "int", notNull: true },
      expires_at: { kind: "tstz", notNull: true },
      created_at: { kind: "tstz", notNull: true },
      updated_at: { kind: "tstz", notNull: true },
    },
    checks: [
      {
        name: "onto_document_search_snapshot_status_ck",
        expr: "status IN ('active','invalidated')",
      },
      {
        name: "onto_document_search_snapshot_counts_ck",
        expr: "acl_revision >= 0 AND total_items >= 0",
      },
    ],
    indexes: [
      {
        name: "onto_document_search_snapshot_scope_idx",
        columns: ["project_id", "owner", "status", "expires_at"],
      },
      {
        name: "onto_document_search_snapshot_session_idx",
        columns: ["session_id", "created_at"],
      },
    ],
  },

  /** 搜索命中的稳定顺序。只存 chunk 身份和摘要，不复制 render/raw/context。 */
  onto_document_search_snapshot_item: {
    columns: {
      snapshot_id: { kind: "text", pk: true },
      ordinal: { kind: "int", pk: true },
      document_id: { kind: "text", notNull: true },
      version_id: { kind: "text", notNull: true },
      chunk_id: { kind: "text", notNull: true },
      index_revision: { kind: "text", notNull: true },
      acl_revision: { kind: "int", notNull: true },
      score: { kind: "float", notNull: true },
      text_sha256: { kind: "text", notNull: true },
    },
    checks: [
      {
        name: "onto_document_search_snapshot_item_ordinal_ck",
        expr: "ordinal >= 0 AND acl_revision >= 0",
      },
    ],
    indexes: [
      {
        name: "onto_document_search_snapshot_item_version_idx",
        columns: ["version_id", "snapshot_id"],
      },
      {
        name: "onto_document_search_snapshot_item_chunk_idx",
        columns: ["version_id", "chunk_id"],
      },
    ],
  },

  /** Wiki 页面当前快照。id 只在 project_id + owner 内唯一，避免从一个租户探测另一个
   * 租户的页面。页面只允许归档，不提供物理删除路径。 */
  onto_document_wiki_page: {
    columns: {
      project_id: { kind: "text", pk: true },
      owner: { kind: "text", pk: true },
      id: { kind: "text", pk: true },
      title: { kind: "text", notNull: true },
      summary: { kind: "text", notNull: true },
      tags: { kind: "json", notNull: true },
      claims: { kind: "json", notNull: true },
      status: { kind: "text", notNull: true, default: lit("active") },
      revision: { kind: "int", notNull: true, default: lit(1) },
      created_by_kind: { kind: "text", notNull: true },
      created_by_id: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true },
      updated_by_kind: { kind: "text", notNull: true },
      updated_by_id: { kind: "text", notNull: true },
      updated_at: { kind: "tstz", notNull: true },
    },
    checks: [
      {
        name: "onto_document_wiki_page_status_ck",
        expr: "status IN ('active','archived')",
      },
      { name: "onto_document_wiki_page_revision_ck", expr: "revision > 0" },
      {
        name: "onto_document_wiki_page_created_actor_ck",
        expr: "created_by_kind IN ('ai','human')",
      },
      {
        name: "onto_document_wiki_page_updated_actor_ck",
        expr: "updated_by_kind IN ('ai','human')",
      },
    ],
    indexes: [
      {
        name: "onto_document_wiki_page_scope_idx",
        columns: ["project_id", "owner", "status", "updated_at"],
      },
    ],
  },

  /** 每次 CAS 写入留下完整不可变快照和审计字段。仓储只有 INSERT 历史行，绝不
   * UPDATE/DELETE；content_sha256 让导出或审计方能验证快照内容。 */
  onto_document_wiki_page_revision: {
    columns: {
      project_id: { kind: "text", pk: true },
      owner: { kind: "text", pk: true },
      page_id: { kind: "text", pk: true },
      revision: { kind: "int", pk: true },
      title: { kind: "text", notNull: true },
      summary: { kind: "text", notNull: true },
      tags: { kind: "json", notNull: true },
      claims: { kind: "json", notNull: true },
      status: { kind: "text", notNull: true },
      action: { kind: "text", notNull: true },
      actor_kind: { kind: "text", notNull: true },
      actor_id: { kind: "text", notNull: true },
      recorded_at: { kind: "tstz", notNull: true },
      content_sha256: { kind: "text", notNull: true },
    },
    checks: [
      { name: "onto_document_wiki_revision_number_ck", expr: "revision > 0" },
      {
        name: "onto_document_wiki_revision_status_ck",
        expr: "status IN ('active','archived')",
      },
      {
        name: "onto_document_wiki_revision_action_ck",
        expr: "action IN ('create','edit','confirm_claim','archive','restore')",
      },
      {
        name: "onto_document_wiki_revision_actor_ck",
        expr: "actor_kind IN ('ai','human')",
      },
    ],
    indexes: [
      {
        name: "onto_document_wiki_revision_history_idx",
        columns: ["project_id", "owner", "page_id", "revision"],
      },
    ],
  },

  /**
   * 用户手工创建的文件夹。
   *
   * 存完整路径（`制度/采购`）而不是父子指针：树只有几层，要的操作是列全部和按前缀筛。
   */
  onto_document_folder: {
    columns: {
      project_id: { kind: "text", pk: true },
      owner: { kind: "text", pk: true },
      path: { kind: "text", pk: true },
      created_by: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    indexes: [
      { name: "onto_document_folder_scope_idx", columns: ["project_id", "owner"] },
    ],
  },

  /** 项目级外部知识来源。credential_ref 只是宿主凭据仓的引用，不保存 token/secret；
   * root_or_prefix 是经过服务层验证的远端定位，不接受 URL 或本机路径。revision 是
   * 管理操作与同步游标共同使用的 CAS 栅栏。 */
  onto_document_connector_source: {
    columns: {
      id: { kind: "text", pk: true },
      project_id: { kind: "text", notNull: true },
      owner: { kind: "text", notNull: true },
      provider: { kind: "text", notNull: true },
      name: { kind: "text", notNull: true },
      root_or_prefix: { kind: "text", notNull: true },
      credential_ref: { kind: "text", notNull: true },
      tags: { kind: "json", notNull: true },
      classification: { kind: "text", notNull: true, default: lit("internal") },
      enabled: { kind: "bool", notNull: true, default: lit(true) },
      revision: { kind: "int", notNull: true, default: lit(1) },
      cursor: { kind: "text" },
      status: { kind: "text", notNull: true, default: lit("idle") },
      created_by: { kind: "text", notNull: true },
      updated_by: { kind: "text", notNull: true },
      created_at: { kind: "tstz", notNull: true },
      updated_at: { kind: "tstz", notNull: true },
      last_started_at: { kind: "tstz" },
      last_completed_at: { kind: "tstz" },
      last_error: { kind: "text" },
    },
    unique: [
      {
        name: "onto_document_connector_scope_root_uq",
        columns: ["project_id", "owner", "provider", "root_or_prefix"],
      },
    ],
    checks: [
      {
        name: "onto_document_connector_provider_ck",
        expr: "provider IN ('sharepoint','webdav','s3','confluence','datahub','openmetadata')",
      },
      {
        name: "onto_document_connector_classification_ck",
        expr: "classification IN ('public','internal','confidential','restricted')",
      },
      {
        name: "onto_document_connector_status_ck",
        expr: "status IN ('idle','syncing','error','archived')",
      },
      { name: "onto_document_connector_revision_ck", expr: "revision > 0" },
      {
        name: "onto_document_connector_archive_ck",
        expr: "status <> 'archived' OR enabled = false",
      },
    ],
    indexes: [
      {
        name: "onto_document_connector_scope_idx",
        columns: ["project_id", "owner", "status", "updated_at"],
      },
      {
        name: "onto_document_connector_sync_idx",
        columns: ["enabled", "status", "last_started_at"],
      },
    ],
  },

  run: {
    columns: {
      id: { kind: "text", pk: true },
      session_id: { kind: "text", notNull: true, ref: fkSession },
      ordinal: { kind: "int", notNull: true },
      kind: { kind: "text", notNull: true },
      status: { kind: "text", notNull: true, default: lit("running") },
      budget: { kind: "json", notNull: true, default: lit({}) },
      error: { kind: "text", notNull: true, default: lit("") },
      started_at: { kind: "tstz", notNull: true, default: NOW },
      ended_at: { kind: "tstz" },
    },
    unique: [{ name: "run_session_ordinal_uq", columns: ["session_id", "ordinal"] }],
    checks: [
      { name: "run_status_ck", expr: "status IN ('running','suspended','done','failed')" },
    ],
  },

  session_state: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      key: { kind: "text", pk: true },
      doc: { kind: "json", notNull: true },
      version: { kind: "bigint", notNull: true },
      derived: { kind: "bool", notNull: true, default: lit(false) },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
  },

  conflict: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      rid: { kind: "text", pk: true },
      kind: { kind: "text", notNull: true },
      handling: { kind: "text", notNull: true },
      summary: { kind: "text", notNull: true, default: lit("") },
      subjects: { kind: "json", notNull: true, default: lit([]) },
      detector: { kind: "text", notNull: true, default: lit("rule") },
      /** 真的可空 —— 反序列化走 doc，不做 ""↔NULL 折叠。别顺手加进 EMPTY_AS_NULL。 */
      owner: { kind: "text" },
      doc: { kind: "json", notNull: true },
      asked: { kind: "bool", notNull: true, default: lit(false) },
      ask_rank: { kind: "int" },
      version: { kind: "bigint", notNull: true },
    },
    checks: [
      {
        name: "conflict_handling_ck",
        expr: "handling IN ('ask_user','auto_repair','round_trip','hint')",
      },
    ],
  },

  decision: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      /** DialogueMemory._decisions 的下标。superseded_by 直接引用它
       * （dialogue.py:208），这样 DialogueMemory.from_dict 能原样读回。 */
      ordinal: { kind: "int", pk: true },
      kind: { kind: "text", notNull: true },
      statement: { kind: "text", notNull: true, default: lit("") },
      scope_refs: { kind: "json", notNull: true, default: lit([]) },
      turn_index: { kind: "int", notNull: true, default: lit(-1) },
      superseded_by: { kind: "int" },
      target_rid: { kind: "text", notNull: true, default: lit("") },
      option_id: { kind: "text", notNull: true, default: lit("") },
      changed: { kind: "json", notNull: true, default: lit([]) },
      note: { kind: "text", notNull: true, default: lit("") },
      actor: { kind: "text", notNull: true, default: lit("user") },
      ts: { kind: "float", notNull: true, default: lit(0) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      {
        name: "decision_kind_ck",
        expr: "kind IN ('caliber','naming','scope','answer','adoption','correction')",
      },
    ],
    indexes: [
      /** 一条冲突同时只能有一个生效的答复 —— POST /answer 因此天然幂等，
       * 并且取代内存里的 s.state["answered"]（server.py:490-492）。
       * SQLite 与 Postgres 都支持部分唯一索引，语法一致。 */
      {
        name: "decision_live_answer_uq",
        columns: ["session_id", "target_rid"],
        unique: true,
        where: "kind = 'answer' AND superseded_by IS NULL",
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════
  //  统一 Question / Decision / Revision（v1）
  // ══════════════════════════════════════════════════════════════════
  // 保留上面的 legacy decision：DialogueMemory 与 conflict /answer 仍按 ordinal 工作。
  // 新表承接所有来源的问题和自由文本/结构化回答；两套数据可由兼容投影逐步迁移，
  // 不要求一次性改完所有调用点。
  question_item: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      id: { kind: "text", pk: true },
      text: { kind: "text", notNull: true },
      status: { kind: "text", notNull: true, default: lit("open") },
      owner_user_id: { kind: "text", notNull: true, default: lit("") },
      audience_role: { kind: "text", notNull: true, default: lit("") },
      answer_schema: { kind: "json", notNull: true, default: lit({}) },
      priority: { kind: "text", notNull: true, default: lit("normal") },
      dependencies: { kind: "json", notNull: true, default: lit([]) },
      blocked_artifacts: { kind: "json", notNull: true, default: lit([]) },
      source_kind: { kind: "text", notNull: true, default: lit("manual") },
      source_ref: { kind: "text", notNull: true, default: lit("") },
      doc: { kind: "json", notNull: true },
      version: { kind: "bigint", notNull: true, default: lit(0) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [
      {
        name: "question_item_status_ck",
        expr: "status IN ('open','assigned','blocked','answered','deferred','cancelled')",
      },
      { name: "question_item_priority_ck", expr: "priority IN ('blocking','high','normal','low')" },
    ],
    indexes: [
      { name: "question_item_queue_idx", columns: ["session_id", "status", "priority"] },
      { name: "question_item_source_idx", columns: ["session_id", "source_kind", "source_ref"] },
    ],
  },

  decision_record: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      id: { kind: "text", pk: true },
      question_id: { kind: "text", notNull: true },
      answer: { kind: "json", notNull: true },
      actor: { kind: "text", notNull: true },
      actor_role: { kind: "text", notNull: true, default: lit("") },
      authority: { kind: "text", notNull: true, default: lit("") },
      source_turn: { kind: "text", notNull: true, default: lit("") },
      affected_ids: { kind: "json", notNull: true, default: lit([]) },
      supersedes: { kind: "text" },
      revision: { kind: "bigint" },
      idempotency_key: { kind: "text", notNull: true },
      semantic_hash: { kind: "text", notNull: true },
      rationale: { kind: "text", notNull: true, default: lit("") },
      metadata: { kind: "json", notNull: true, default: lit({}) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    indexes: [
      {
        name: "decision_record_question_idx",
        columns: ["session_id", "question_id", "created_at"],
      },
      {
        name: "decision_record_idempotency_uq",
        columns: ["session_id", "idempotency_key"],
        unique: true,
      },
    ],
  },

  revision_record: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      id: { kind: "text", pk: true },
      ordinal: { kind: "bigint", notNull: true },
      parent_id: { kind: "text" },
      kind: { kind: "text", notNull: true },
      status: { kind: "text", notNull: true },
      patch_set: { kind: "json" },
      changed_ids: { kind: "json", notNull: true, default: lit([]) },
      invalidated_artifacts: { kind: "json", notNull: true, default: lit([]) },
      actor: { kind: "text", notNull: true, default: lit("agent") },
      source_turn: { kind: "text", notNull: true, default: lit("") },
      snapshot_hash: { kind: "text", notNull: true, default: lit("") },
      idempotency_key: { kind: "text", notNull: true, default: lit("") },
      doc: { kind: "json", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    unique: [{ name: "revision_record_ordinal_uq", columns: ["session_id", "ordinal"] }],
    checks: [
      {
        name: "revision_record_status_ck",
        expr: "status IN ('proposed','applied','rejected','rolled_back')",
      },
    ],
    indexes: [
      {
        name: "revision_record_idempotency_uq",
        columns: ["session_id", "idempotency_key"],
        unique: true,
        where: "idempotency_key <> ''",
      },
    ],
  },

  chat_turn: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      ordinal: { kind: "int", pk: true },
      speaker: { kind: "text", notNull: true },
      text: { kind: "text", notNull: true },
      intent: { kind: "text", notNull: true, default: lit("") },
      refs: { kind: "json", notNull: true, default: lit([]) },
      compressed: { kind: "bool", notNull: true, default: lit(false) },
      ts: { kind: "float", notNull: true, default: lit(0) },
    },
  },

  session_event: {
    columns: {
      session_id: { kind: "text", pk: true, ref: fkSession },
      seq: { kind: "bigint", pk: true },
      kind: { kind: "text", notNull: true },
      payload: { kind: "json", notNull: true, default: lit({}) },
      ref: { kind: "text" },
      ts: { kind: "float", notNull: true },
      // 进程在 commit 成功、回执返回前退出时，同一队列项恢复重试不能再写一条。
      // UUID 是跨 worker 的幂等身份；seq 仍是每会话的展示/游标顺序。
      event_id: { kind: "text" },
    },
    indexes: [
      {
        name: "session_event_event_id_uq",
        columns: ["event_id"],
        unique: true,
        where: "event_id IS NOT NULL",
      },
    ],
  },

  kernel_event: {
    columns: {
      run_id: { kind: "text", pk: true, ref: { table: "run", column: "id", onDelete: "cascade" } },
      seq: { kind: "bigint", pk: true },
      kind: { kind: "text", notNull: true },
      node_id: { kind: "text" },
      payload: { kind: "json", notNull: true, default: lit({}) },
      ref: { kind: "text" },
      ts_ms: { kind: "bigint", notNull: true, default: lit(0) },
    },
  },

  blob: {
    columns: {
      ref: { kind: "text", pk: true },
      data: { kind: "bytes", notNull: true },
      size_bytes: { kind: "int", notNull: true },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
  },

  // ══════════════════════════════════════════════════════════════════
  //  账号与登录会话（鉴权层）—— 与建模 session 无关的两张顶层表
  // ══════════════════════════════════════════════════════════════════
  // 数据是共享的（单管理员门禁，不按用户隔离），账号只用于登录与角色控制，
  // 所以这两张表**不挂在建模 session 之下**、没有 owner 外键。
  // id / password_hash / token 一律在应用层生成（uuid4 / scrypt / token_urlsafe），
  // **不用** gen_random_uuid / pgcrypto —— 否则 SQLite 与 MemoryRepo 两条路都跑不通。
  app_user: {
    columns: {
      id: { kind: "text", pk: true }, // uuid4().hex
      username: { kind: "text", notNull: true, unique: true }, // 调用方已 trim().toLowerCase()
      /** 称呼用的名字，**原样保留大小写与空格**。username 被 lower() 过，拿来问候人
       * 不合适。空串 = 没填（管理员建号、CLI 建号、迁移前的老账号），展示时回落到
       * username。不唯一、不索引 —— 重名合法，也从不按它查。 */
      display_name: { kind: "text", notNull: true, default: lit("") },
      password_hash: { kind: "text", notNull: true }, // scrypt 自描述串
      role: { kind: "text", notNull: true, default: lit("user") },
      active: { kind: "bool", notNull: true, default: lit(true) },
      /** 外观/语言偏好（主题、强调色、时区、字号、语言）。必须在**建表时**就有 ——
       * 迁移一旦落库就按 checksum 锁死，以后想 ALTER 进来得单开一个迁移文件。 */
      prefs: { kind: "json", notNull: true, default: lit({}) },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
    checks: [{ name: "app_user_role_ck", expr: "role IN ('admin','user')" }],
  },

  // 登录会话：主键是令牌的 sha256，**不是令牌本身** —— 库里泄了也换不出 cookie。
  // 明文令牌只活在浏览器的 HttpOnly cookie 里。过期行读时过滤 + 周期性清理。
  auth_session: {
    columns: {
      token_hash: { kind: "text", pk: true },
      user_id: {
        kind: "text",
        notNull: true,
        ref: { table: "app_user", column: "id", onDelete: "cascade" },
      },
      created_at: { kind: "tstz", notNull: true, default: NOW },
      last_seen_at: { kind: "tstz", notNull: true, default: NOW },
      expires_at: { kind: "tstz", notNull: true },
    },
    indexes: [{ name: "auth_session_user_idx", columns: ["user_id"] }],
  },

  /** 模型用量流水。**一次模型调用一行，跨会话、独立于会话生命周期。**
   *
   * 为什么是独立的顶层表，而不是挂在 session 或复用 run.budget：
   *   * 它要回答的是"这个月一共烧了多少 token""哪个模型最贵"——那是跨会话的问题，
   *     而 `run.budget` 是每次调用新建一个 Budget 的**每轮快照**，
   *     `session_state["budget"]` 更只是最后一次梳理的快照，两个都加不起来。
   *   * 会话删掉/purge 之后，账还得在。所以 session_id **不设外键**、不跟着 CASCADE。
   *   * 盘上那份 journal jsonl 不能当账本：它按 run 散在各会话目录里、没有归属、
   *     purge 会连目录一起 rmtree，而且**重放会重复记账**（Recorder 回放不真的调
   *     模型，但旧代码照样 spend 一次）。
   *
   * `day` 是**存出来的**而不是查询时算的：date_trunc 只有 PG 有、strftime 只有
   * SQLite 有，任何一个都会把"两种实现走同一条代码路径"这条规矩打破。 */
  llm_usage: {
    columns: {
      id: { kind: "text", pk: true },
      ts: { kind: "float", notNull: true },
      /** 'YYYY-MM-DD'（UTC），写入时算好，按天聚合直接 GROUP BY 它 */
      day: { kind: "text", notNull: true },
      /** app_user.id；'' = 无归属。和 session.owner 一样**不设外键**（见 0004） */
      owner: { kind: "text", notNull: true, default: lit("") },
      session_id: { kind: "text", notNull: true, default: lit("") },
      run_id: { kind: "text", notNull: true, default: lit("") },
      node_id: { kind: "text", notNull: true, default: lit("") },
      /** build | chat | aux —— 这次调用是干什么的 */
      kind: { kind: "text", notNull: true, default: lit("build") },
      model: { kind: "text", notNull: true },
      effort: { kind: "text", notNull: true, default: lit("") },
      tok_in: { kind: "bigint", notNull: true, default: lit(0) },
      tok_out: { kind: "bigint", notNull: true, default: lit(0) },
      cache_read: { kind: "bigint", notNull: true, default: lit(0) },
      cache_write: { kind: "bigint", notNull: true, default: lit(0) },
      usd: { kind: "float", notNull: true, default: lit(0) },
      /** gateway = 网关回的真实账单；estimated = 本地价目表估的（**很多模型的价目
       * 是编的**，见 catalog.card_from_name 的 2.0/8.0），界面据此决定敢不敢显示金额 */
      usd_source: { kind: "text", notNull: true, default: lit("estimated") },
      /** 实际打给模型几次（schema 重试、截断加预算重试都算），tok 是这几次的总和 */
      attempts: { kind: "int", notNull: true, default: lit(1) },
      status: { kind: "text", notNull: true, default: lit("ok") },
      created_at: { kind: "tstz", notNull: true, default: NOW },
    },
    // schema.py 里 kind/tokens/usd/attempts 这四条 CHECK 各写了**两遍**（同名重复，
    // 复制粘贴留下的）。这里各留一份 —— 重名约束在 PG 上建表会直接失败。
    checks: [
      { name: "llm_usage_kind_ck", expr: "kind IN ('build','chat','aux')" },
      {
        name: "llm_usage_tokens_ck",
        expr: "tok_in >= 0 AND tok_out >= 0 AND cache_read >= 0 AND cache_write >= 0",
      },
      { name: "llm_usage_usd_ck", expr: "usd >= 0" },
      { name: "llm_usage_attempts_ck", expr: "attempts >= 1" },
      { name: "llm_usage_usd_source_ck", expr: "usd_source IN ('gateway','estimated')" },
      { name: "llm_usage_status_ck", expr: "status IN ('ok','failed')" },
    ],
    indexes: [
      { name: "llm_usage_owner_day_idx", columns: ["owner", "day"] },
      { name: "llm_usage_ts_idx", columns: ["ts"] },
      { name: "llm_usage_model_day_idx", columns: ["model", "day"] },
    ],
  },

  // 全局应用设置（管理员可改的网关/预算配置）。键值对，value 是 JSON —— 与
  // session_state 同一套形态。**顶层**，与建模会话无关，故不随会话级联。
  app_setting: {
    columns: {
      key: { kind: "text", pk: true },
      value: { kind: "json", notNull: true },
      updated_at: { kind: "tstz", notNull: true, default: NOW },
    },
  },
} as const satisfies Readonly<Record<string, TableSpec>>;

export type TableName = keyof typeof TABLE_SPECS;
export type ColumnNames<N extends TableName> = keyof (typeof TABLE_SPECS)[N]["columns"] & string;

export const TABLE_NAMES = Object.keys(TABLE_SPECS) as TableName[];

/** 某张表按声明顺序的列名。对齐测试与 repo 层的显式列清单都用它。 */
export function columnNames<N extends TableName>(name: N): ColumnNames<N>[] {
  return Object.keys(TABLE_SPECS[name].columns) as ColumnNames<N>[];
}

// ══════════════════════════════════════════════════════════════════
//  Postgres 生成器
// ══════════════════════════════════════════════════════════════════

/** PG 上 blob.data 是 bytea。drizzle-orm 0.45 的 pg-core 没有内建 bytea，
 * customType 是官方给的口子。 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
});

function pgColumn(name: string, spec: ColSpec, reg: Record<string, PgTable>): PgColumnBuilderBase {
  const notNull = spec.notNull === true || spec.pk === true;
  const d = spec.default;
  let col;
  switch (spec.kind) {
    case "text":
      col = pgText(name);
      break;
    case "int":
      col = pgInteger(name);
      break;
    // mode:"number" —— 这些列（seq / state_version / tok_*）的量级远在
    // Number.MAX_SAFE_INTEGER 之内，让驱动回 bigint 只会把 DTO 层染成 bigint。
    case "bigint":
      col = pgBigint(name, { mode: "number" });
      break;
    case "float":
      col = pgDouble(name);
      break;
    case "bool":
      col = pgBoolean(name);
      break;
    case "json":
      col = jsonb(name);
      break;
    case "bytes":
      col = bytea(name);
      break;
    case "tstz":
      col = pgTimestamp(name, { withTimezone: true, mode: "date" });
      break;
  }
  // 八种 kind 的 builder 在类型上没有公共父类型能承载 `.default(具体值类型)`，
  // 但**运行时**这套链式方法是一样的。这里过一次结构化接口，把 cast 收在一处，
  // 而不是每个分支各写一个 `as`。kind ↔ 默认值类型的对应由测试兜住。
  let b = col as unknown as ChainablePg;
  if (notNull) b = b.notNull();
  if (d !== undefined) b = d.kind === "now" ? b.defaultNow() : b.default(d.value);
  if (spec.unique === true) b = b.unique();
  if (spec.ref !== undefined) {
    const ref = spec.ref;
    // 用 thunk 取表，所以建表顺序无关紧要 —— 前向引用（kernel_event → run）也成立。
    b = b.references(() => (reg[ref.table] as unknown as Record<string, PgColumn>)[ref.column]!, {
      onDelete: ref.onDelete,
    });
  }
  return b as unknown as PgColumnBuilderBase;
}

interface ChainablePg {
  notNull(): ChainablePg;
  default(v: unknown): ChainablePg;
  defaultNow(): ChainablePg;
  unique(): ChainablePg;
  references(f: () => PgColumn, o: { onDelete: "cascade" }): ChainablePg;
}

/** drizzle 的 `.on()` / `primaryKey({columns})` 要求非空元组；`map` 只给数组。 */
type Cols<T> = [T, ...T[]];

function buildPgTables(): Record<string, PgTable> {
  const reg: Record<string, PgTable> = {};
  for (const name of TABLE_NAMES) {
    const spec: TableSpec = TABLE_SPECS[name];
    const cols: Record<string, PgColumnBuilderBase> = {};
    for (const [c, cs] of Object.entries(spec.columns)) cols[c] = pgColumn(c, cs, reg);
    reg[name] = pgTable(name, cols, (t) => {
      const pick = (c: string) => (t as Record<string, PgColumn>)[c]!;
      const pk = Object.keys(spec.columns).filter((c) => spec.columns[c]!.pk === true);
      const out: unknown[] = [];
      // 主键一律走表级 PRIMARY KEY（单列也是）：生成器只有一条路径，复合/单列
      // 不必分叉。PG/SQLite 上 `PRIMARY KEY (id)` 与列内 PRIMARY KEY 等价。
      if (pk.length > 0) {
        out.push(pgPrimaryKey({ name: `${name}_pkey`, columns: pk.map(pick) as Cols<PgColumn> }));
      }
      for (const u of spec.unique ?? []) {
        out.push(pgUnique(u.name).on(...(u.columns.map(pick) as Cols<PgColumn>)));
      }
      for (const ck of spec.checks ?? []) out.push(pgCheck(ck.name, sql.raw(ck.expr)));
      for (const ix of spec.indexes ?? []) {
        const base = (ix.unique === true ? pgUniqueIndex(ix.name) : pgIndex(ix.name)).on(
          ...(ix.columns.map(pick) as Cols<PgColumn>),
        );
        out.push(ix.where === undefined ? base : base.where(sql.raw(ix.where) as SQL));
      }
      return out as never;
    });
  }
  return reg;
}

// ══════════════════════════════════════════════════════════════════
//  SQLite 生成器
// ══════════════════════════════════════════════════════════════════

function sqliteColumn(
  name: string,
  spec: ColSpec,
  reg: Record<string, SQLiteTable>,
): SQLiteColumnBuilderBase {
  const notNull = spec.notNull === true || spec.pk === true;
  const d = spec.default;
  let col;
  switch (spec.kind) {
    case "text":
      col = sqliteText(name);
      break;
    // SQLite 的 INTEGER 本来就是 64 位，int 与 bigint 落到同一个类型。
    case "int":
    case "bigint":
      col = sqliteInteger(name);
      break;
    case "float":
      col = sqliteReal(name);
      break;
    case "bool":
      col = sqliteInteger(name, { mode: "boolean" });
      break;
    // SQLAlchemy 在非 PG 方言上把 JSON 存成 TEXT（自己 dumps/loads），这里同形。
    case "json":
      col = sqliteText(name, { mode: "json" });
      break;
    case "bytes":
      col = sqliteBlob(name, { mode: "buffer" });
      break;
    // SQLAlchemy 的 DateTime 在 SQLite 上是 ISO 文本，不是 epoch 数字。存数字会
    // 让 Python 时代建的库读不出来，也让 `ORDER BY created_at` 与 PG 侧不同解。
    case "tstz":
      col = sqliteText(name);
      break;
  }
  // 同 pgColumn：cast 收在一处的结构化链式接口。
  let b = col as unknown as ChainableSqlite;
  if (notNull) b = b.notNull();
  if (d !== undefined) {
    // SQLite 没有 defaultNow()，用 CURRENT_TIMESTAMP —— 它给的是 UTC 的
    // 'YYYY-MM-DD HH:MM:SS' 文本，正好是 tstz 列在这个方言下的存储形态。
    b = d.kind === "now" ? b.default(sql`CURRENT_TIMESTAMP`) : b.default(d.value);
  }
  if (spec.unique === true) b = b.unique();
  if (spec.ref !== undefined) {
    const ref = spec.ref;
    b = b.references(
      () => (reg[ref.table] as unknown as Record<string, SQLiteColumn>)[ref.column]!,
      { onDelete: ref.onDelete },
    );
  }
  return b as unknown as SQLiteColumnBuilderBase;
}

interface ChainableSqlite {
  notNull(): ChainableSqlite;
  default(v: unknown): ChainableSqlite;
  unique(): ChainableSqlite;
  references(f: () => SQLiteColumn, o: { onDelete: "cascade" }): ChainableSqlite;
}

function buildSqliteTables(): Record<string, SQLiteTable> {
  const reg: Record<string, SQLiteTable> = {};
  for (const name of TABLE_NAMES) {
    const spec: TableSpec = TABLE_SPECS[name];
    const cols: Record<string, SQLiteColumnBuilderBase> = {};
    for (const [c, cs] of Object.entries(spec.columns)) cols[c] = sqliteColumn(c, cs, reg);
    reg[name] = sqliteTable(name, cols, (t) => {
      const pick = (c: string) => (t as Record<string, SQLiteColumn>)[c]!;
      const pk = Object.keys(spec.columns).filter((c) => spec.columns[c]!.pk === true);
      const out: unknown[] = [];
      if (pk.length > 0) {
        out.push(
          sqlitePrimaryKey({ name: `${name}_pkey`, columns: pk.map(pick) as Cols<SQLiteColumn> }),
        );
      }
      for (const u of spec.unique ?? []) {
        out.push(sqliteUnique(u.name).on(...(u.columns.map(pick) as Cols<SQLiteColumn>)));
      }
      for (const ck of spec.checks ?? []) out.push(sqliteCheck(ck.name, sql.raw(ck.expr)));
      for (const ix of spec.indexes ?? []) {
        const base = (ix.unique === true ? sqliteUniqueIndex(ix.name) : sqliteIndex(ix.name)).on(
          ...(ix.columns.map(pick) as Cols<SQLiteColumn>),
        );
        out.push(ix.where === undefined ? base : base.where(sql.raw(ix.where) as SQL));
      }
      return out as never;
    });
  }
  return reg;
}

// ══════════════════════════════════════════════════════════════════
//  导出
// ══════════════════════════════════════════════════════════════════

/** 列名级别的类型安全：`pgTables.session.owner` 过，`pgTables.session.nope` 红。
 * 逐列的值类型（data/notNull/hasDefault）在生成路径上丢了 —— 见文件头的形态决策。 */
export type PgTables = {
  readonly [N in TableName]: PgTable & { readonly [C in ColumnNames<N>]: PgColumn };
};
export type SqliteTables = {
  readonly [N in TableName]: SQLiteTable & { readonly [C in ColumnNames<N>]: SQLiteColumn };
};

/** Postgres 方言的 33 张表。仓储层按 `import { pgTables as t }` 用 `t.session`，
 * 与 Python 侧 `from . import schema as t; t.session` 同形。 */
export const pgTables = buildPgTables() as unknown as PgTables;

/** SQLite 方言的同 33 张表，由同一份 `TABLE_SPECS` 生成 —— 两套声明不可能漂移。 */
export const sqliteTables = buildSqliteTables() as unknown as SqliteTables;
