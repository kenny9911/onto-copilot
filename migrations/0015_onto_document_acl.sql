-- 0015_onto_document_acl -- OntoDocument 文档/版本/片段 ACL 与无正文安全审计。
--
-- 所有表都重复保存 project_id + owner，仓储查询必须同时带两者。ACL 采用项目级
-- revision 做 CAS；规则替换、revision 递增和 acl.change 审计在同一事务内提交。
-- 审计表故意没有正文、查询原文、render/raw/context 等列。

BEGIN;

CREATE TABLE onto_document_acl_state (
    project_id text        NOT NULL,
    owner      text        NOT NULL,
    revision   integer     NOT NULL DEFAULT 0,
    updated_by text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, owner),
    CONSTRAINT onto_document_acl_revision_ck CHECK (revision >= 0)
);

CREATE TABLE onto_document_acl_rule (
    project_id       text        NOT NULL,
    owner            text        NOT NULL,
    id               text        NOT NULL,
    subject_type     text        NOT NULL,
    subject_id       text        NOT NULL,
    effect           text        NOT NULL,
    permission       text        NOT NULL,
    scope_type       text        NOT NULL,
    document_id      text,
    version_id       text,
    chunk_id         text,
    changed_revision integer     NOT NULL,
    created_by       text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, owner, id),
    CONSTRAINT onto_document_acl_subject_ck CHECK (subject_type IN ('principal','group')),
    CONSTRAINT onto_document_acl_effect_ck CHECK (effect IN ('allow','deny')),
    CONSTRAINT onto_document_acl_permission_ck CHECK (permission IN ('read','write','manage_acl')),
    CONSTRAINT onto_document_acl_scope_ck CHECK (scope_type IN ('project','document','version','chunk')),
    CONSTRAINT onto_document_acl_changed_revision_ck CHECK (changed_revision > 0),
    CONSTRAINT onto_document_acl_target_shape_ck CHECK (
        (scope_type = 'project' AND document_id IS NULL AND version_id IS NULL AND chunk_id IS NULL) OR
        (scope_type = 'document' AND document_id IS NOT NULL AND version_id IS NULL AND chunk_id IS NULL) OR
        (scope_type = 'version' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NULL) OR
        (scope_type = 'chunk' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NOT NULL)
    )
);

CREATE INDEX onto_document_acl_subject_idx
    ON onto_document_acl_rule (project_id, owner, subject_type, subject_id);
CREATE INDEX onto_document_acl_target_idx
    ON onto_document_acl_rule (project_id, owner, document_id, version_id, chunk_id);

CREATE TABLE onto_document_security_audit (
    id               text        PRIMARY KEY,
    project_id       text        NOT NULL,
    owner            text        NOT NULL,
    actor_type       text        NOT NULL,
    actor_id         text        NOT NULL,
    action           text        NOT NULL,
    decision         text        NOT NULL,
    scope_type       text        NOT NULL,
    document_id      text,
    version_id       text,
    chunk_id         text,
    acl_revision     integer     NOT NULL,
    matched_rule_ids jsonb       NOT NULL,
    detail           jsonb       NOT NULL,
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT onto_document_security_actor_ck CHECK (actor_type IN ('principal','service')),
    CONSTRAINT onto_document_security_action_ck CHECK (action IN ('acl.change','search.filter','document.read','version.read','chunk.read')),
    CONSTRAINT onto_document_security_decision_ck CHECK (decision IN ('allow','deny','changed')),
    CONSTRAINT onto_document_security_scope_ck CHECK (scope_type IN ('project','document','version','chunk')),
    CONSTRAINT onto_document_security_revision_ck CHECK (acl_revision >= 0),
    CONSTRAINT onto_document_security_target_shape_ck CHECK (
        (scope_type = 'project' AND document_id IS NULL AND version_id IS NULL AND chunk_id IS NULL) OR
        (scope_type = 'document' AND document_id IS NOT NULL AND version_id IS NULL AND chunk_id IS NULL) OR
        (scope_type = 'version' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NULL) OR
        (scope_type = 'chunk' AND document_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NOT NULL)
    )
);

CREATE INDEX onto_document_security_project_idx
    ON onto_document_security_audit (project_id, owner, occurred_at);
CREATE INDEX onto_document_security_actor_idx
    ON onto_document_security_audit (actor_type, actor_id, occurred_at);

COMMIT;
