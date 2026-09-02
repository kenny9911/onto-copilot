-- 0014_onto_document —— 项目级知识文档、不可变版本、可溯源切片与会话精确挂载。
--
-- 安全边界有意写进数据形状，而不是只靠调用约定：
--   * 文档每次读取同时带 project_id + owner；
--   * 会话挂载保存精确 version_id，采用版本变化不会污染正在运行的 build；
--   * 同一文档的 (version_no) 与 (sha256) 都唯一，并发追加与重复上传都在库层兜底；
--   * 版本和切片没有 UPDATE 路径，元数据修改只发生在 onto_document。
--
-- 不挂 project/session 外键，理由与 0013 相同：生命周期由仓储显式管理，避免不同
-- SQLite foreign_keys 设置得到不同级联结果。原文件只存相对 workspace 的 rel_path。

BEGIN;

CREATE TABLE onto_document (
    id                 text        PRIMARY KEY,
    project_id         text        NOT NULL,
    owner              text        NOT NULL,
    title              text        NOT NULL,
    logical_name       text        NOT NULL,
    source_class       text        NOT NULL,
    tags               jsonb       NOT NULL,
    status             text        NOT NULL DEFAULT 'active',
    current_version_id text        NOT NULL,
    adopted_version_id text,
    revision           integer     NOT NULL DEFAULT 1,
    created_by         text        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT onto_document_status_ck CHECK (status IN ('active','archived')),
    CONSTRAINT onto_document_source_class_ck CHECK (source_class IN ('session_upload','generated','external','imported'))
);

CREATE INDEX onto_document_project_owner_idx
    ON onto_document (project_id, owner, status);
CREATE INDEX onto_document_adopted_idx ON onto_document (adopted_version_id);

CREATE TABLE onto_document_version (
    id             text        PRIMARY KEY,
    document_id    text        NOT NULL,
    version_no     integer     NOT NULL,
    file_name      text        NOT NULL,
    media_type     text        NOT NULL,
    size_bytes     bigint      NOT NULL,
    sha256         text        NOT NULL,
    rel_path       text        NOT NULL,
    doc_kind       text        NOT NULL,
    parsed_doc     jsonb       NOT NULL,
    parse_status   text        NOT NULL,
    parser_name    text        NOT NULL,
    parser_version text        NOT NULL,
    index_revision text        NOT NULL,
    chunk_count    integer     NOT NULL,
    created_by     text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT onto_document_version_no_uq UNIQUE (document_id, version_no),
    CONSTRAINT onto_document_version_sha_uq UNIQUE (document_id, sha256),
    CONSTRAINT onto_document_version_no_ck CHECK (version_no > 0),
    CONSTRAINT onto_document_parse_status_ck CHECK (parse_status IN ('ready','degraded'))
);

CREATE INDEX onto_document_version_document_idx
    ON onto_document_version (document_id);

CREATE TABLE onto_document_chunk (
    version_id  text    NOT NULL,
    chunk_id    text    NOT NULL,
    document_id text    NOT NULL,
    order_no    integer NOT NULL,
    locator     jsonb   NOT NULL,
    render_text text    NOT NULL,
    raw_json    jsonb   NOT NULL,
    tags        jsonb   NOT NULL,
    context     text    NOT NULL,
    text_sha256 text    NOT NULL,
    PRIMARY KEY (version_id, chunk_id)
);

CREATE INDEX onto_document_chunk_document_idx
    ON onto_document_chunk (document_id);
CREATE INDEX onto_document_chunk_version_order_idx
    ON onto_document_chunk (version_id, order_no);

CREATE TABLE session_document (
    session_id  text        NOT NULL,
    document_id text        NOT NULL,
    version_id  text        NOT NULL,
    project_id  text        NOT NULL,
    owner       text        NOT NULL,
    role        text        NOT NULL DEFAULT 'reference',
    attached_by text        NOT NULL,
    attached_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, document_id),
    CONSTRAINT session_document_role_ck CHECK (role IN ('reference','primary'))
);

CREATE INDEX session_document_session_idx ON session_document (session_id);
CREATE INDEX session_document_scope_idx ON session_document (project_id, owner);

COMMIT;
