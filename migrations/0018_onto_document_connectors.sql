-- 0018_onto_document_connectors -- 项目级外部知识来源配置与同步游标。
--
-- 凭据列只保存 credential_ref；真实 token/secret/password 由宿主凭据提供器注入，
-- 这张表没有可存秘密值、任意 URL 或本机路径的列。project_id + owner 是每一次
-- 管理操作的隔离边界，revision 负责 CAS；cursor 仅在一整页变更全部落地后推进。

BEGIN;

CREATE TABLE onto_document_connector_source (
    id                text        PRIMARY KEY,
    project_id        text        NOT NULL,
    owner             text        NOT NULL,
    provider          text        NOT NULL,
    name              text        NOT NULL,
    root_or_prefix    text        NOT NULL,
    credential_ref    text        NOT NULL,
    tags              jsonb       NOT NULL,
    classification    text        NOT NULL DEFAULT 'internal',
    enabled           boolean     NOT NULL DEFAULT true,
    revision          integer     NOT NULL DEFAULT 1,
    cursor            text,
    status            text        NOT NULL DEFAULT 'idle',
    created_by        text        NOT NULL,
    updated_by        text        NOT NULL,
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL,
    last_started_at   timestamptz,
    last_completed_at timestamptz,
    last_error        text,
    CONSTRAINT onto_document_connector_provider_ck
        CHECK (provider IN ('sharepoint','webdav','s3','confluence','datahub','openmetadata')),
    CONSTRAINT onto_document_connector_classification_ck
        CHECK (classification IN ('public','internal','confidential','restricted')),
    CONSTRAINT onto_document_connector_status_ck
        CHECK (status IN ('idle','syncing','error','archived')),
    CONSTRAINT onto_document_connector_revision_ck CHECK (revision > 0),
    CONSTRAINT onto_document_connector_archive_ck
        CHECK (status <> 'archived' OR enabled = false),
    CONSTRAINT onto_document_connector_scope_root_uq
        UNIQUE (project_id, owner, provider, root_or_prefix)
);

CREATE INDEX onto_document_connector_scope_idx
    ON onto_document_connector_source (project_id, owner, status, updated_at);

CREATE INDEX onto_document_connector_sync_idx
    ON onto_document_connector_source (enabled, status, last_started_at);

COMMIT;
