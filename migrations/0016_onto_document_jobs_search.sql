-- 0016_onto_document_jobs_search -- 持久化解析/OCR 任务与固定语义搜索快照。
--
-- 后台任务永远钉住一个不可变 document_version；source_sha256/index_revision 是领取
-- 任务后再次核对的执行前提。lease_token 防止租约过期的旧 worker 回写新 worker 的结果。
-- 搜索快照只保存精确版本、chunk 身份和排序，不复制材料正文；每次翻页都复核项目 ACL
-- revision，撤权后旧 cursor 必须 fail closed。

BEGIN;

CREATE TABLE onto_document_job (
    id                      text        PRIMARY KEY,
    project_id              text        NOT NULL,
    owner                   text        NOT NULL,
    document_id             text        NOT NULL,
    version_id              text        NOT NULL,
    kind                    text        NOT NULL,
    idempotency_key         text        NOT NULL,
    request_sha256          text        NOT NULL,
    source_sha256           text        NOT NULL,
    expected_index_revision text        NOT NULL,
    input                   jsonb       NOT NULL,
    status                  text        NOT NULL DEFAULT 'queued',
    attempts                integer     NOT NULL DEFAULT 0,
    max_attempts            integer     NOT NULL DEFAULT 3,
    available_at            timestamptz NOT NULL,
    lease_owner             text,
    lease_token             text,
    lease_expires_at        timestamptz,
    result                  jsonb       NOT NULL,
    result_sha256           text        NOT NULL DEFAULT '',
    last_error              text        NOT NULL DEFAULT '',
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    started_at              timestamptz,
    completed_at            timestamptz,
    CONSTRAINT onto_document_job_scope_key_uq
        UNIQUE (project_id, owner, idempotency_key),
    CONSTRAINT onto_document_job_kind_ck CHECK (kind IN ('parse','ocr')),
    CONSTRAINT onto_document_job_status_ck
        CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    CONSTRAINT onto_document_job_attempts_ck
        CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
    CONSTRAINT onto_document_job_lease_shape_ck CHECK (
        (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX onto_document_job_queue_idx
    ON onto_document_job (status, available_at, lease_expires_at);
CREATE INDEX onto_document_job_version_idx
    ON onto_document_job (project_id, owner, version_id, created_at);

CREATE TABLE onto_document_search_snapshot (
    id                 text        PRIMARY KEY,
    project_id         text        NOT NULL,
    owner              text        NOT NULL,
    session_id         text,
    query_sha256       text        NOT NULL,
    manifest           jsonb       NOT NULL,
    manifest_sha256    text        NOT NULL,
    acl_revision       integer     NOT NULL,
    status             text        NOT NULL DEFAULT 'active',
    invalidated_reason text        NOT NULL DEFAULT '',
    total_items        integer     NOT NULL,
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    CONSTRAINT onto_document_search_snapshot_status_ck
        CHECK (status IN ('active','invalidated')),
    CONSTRAINT onto_document_search_snapshot_counts_ck
        CHECK (acl_revision >= 0 AND total_items >= 0)
);

CREATE INDEX onto_document_search_snapshot_scope_idx
    ON onto_document_search_snapshot (project_id, owner, status, expires_at);
CREATE INDEX onto_document_search_snapshot_session_idx
    ON onto_document_search_snapshot (session_id, created_at);

CREATE TABLE onto_document_search_snapshot_item (
    snapshot_id    text    NOT NULL,
    ordinal        integer NOT NULL,
    document_id    text    NOT NULL,
    version_id     text    NOT NULL,
    chunk_id       text    NOT NULL,
    index_revision text    NOT NULL,
    acl_revision   integer NOT NULL,
    score          double precision NOT NULL,
    text_sha256    text    NOT NULL,
    PRIMARY KEY (snapshot_id, ordinal),
    CONSTRAINT onto_document_search_snapshot_item_ordinal_ck
        CHECK (ordinal >= 0 AND acl_revision >= 0)
);

CREATE INDEX onto_document_search_snapshot_item_version_idx
    ON onto_document_search_snapshot_item (version_id, snapshot_id);
CREATE INDEX onto_document_search_snapshot_item_chunk_idx
    ON onto_document_search_snapshot_item (version_id, chunk_id);

COMMIT;
