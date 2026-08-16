-- 0005_question_decision_revision —— 统一问题队列、决定账本与变更版本。
--
-- legacy conflict/decision 表继续保留，供旧 /answer 与 DialogueMemory 使用；新表
-- 可以先由兼容投影双写，完成 API 切换后再单独安排数据回填/下线迁移。

BEGIN;

CREATE TABLE question_item (
    session_id       text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    id               text        NOT NULL,
    text             text        NOT NULL,
    status           text        NOT NULL DEFAULT 'open',
    owner_user_id    text        NOT NULL DEFAULT '',
    audience_role    text        NOT NULL DEFAULT '',
    answer_schema    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    priority         text        NOT NULL DEFAULT 'normal',
    dependencies     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    blocked_artifacts jsonb      NOT NULL DEFAULT '[]'::jsonb,
    source_kind      text        NOT NULL DEFAULT 'manual',
    source_ref       text        NOT NULL DEFAULT '',
    doc              jsonb       NOT NULL,
    version          bigint      NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id),
    CONSTRAINT question_item_status_ck CHECK (status IN
        ('open','assigned','blocked','answered','deferred','cancelled')),
    CONSTRAINT question_item_priority_ck CHECK (priority IN
        ('blocking','high','normal','low'))
);
CREATE INDEX question_item_queue_idx
    ON question_item (session_id, status, priority);
CREATE INDEX question_item_source_idx
    ON question_item (session_id, source_kind, source_ref);


CREATE TABLE decision_record (
    session_id       text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    id               text        NOT NULL,
    question_id      text        NOT NULL,
    answer           jsonb       NOT NULL,
    actor            text        NOT NULL,
    actor_role       text        NOT NULL DEFAULT '',
    authority        text        NOT NULL DEFAULT '',
    source_turn      text        NOT NULL DEFAULT '',
    affected_ids     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    supersedes       text,
    revision         bigint,
    idempotency_key  text        NOT NULL,
    semantic_hash    text        NOT NULL,
    rationale        text        NOT NULL DEFAULT '',
    metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id)
);
CREATE INDEX decision_record_question_idx
    ON decision_record (session_id, question_id, created_at);
CREATE UNIQUE INDEX decision_record_idempotency_uq
    ON decision_record (session_id, idempotency_key);


CREATE TABLE revision_record (
    session_id          text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    id                  text        NOT NULL,
    ordinal             bigint      NOT NULL,
    parent_id           text,
    kind                text        NOT NULL,
    status              text        NOT NULL,
    patch_set           jsonb,
    changed_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    invalidated_artifacts jsonb     NOT NULL DEFAULT '[]'::jsonb,
    actor               text        NOT NULL DEFAULT 'agent',
    source_turn         text        NOT NULL DEFAULT '',
    snapshot_hash       text        NOT NULL DEFAULT '',
    idempotency_key     text        NOT NULL DEFAULT '',
    doc                 jsonb       NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id),
    CONSTRAINT revision_record_ordinal_uq UNIQUE (session_id, ordinal),
    CONSTRAINT revision_record_status_ck CHECK (status IN
        ('proposed','applied','rejected','rolled_back'))
);
CREATE UNIQUE INDEX revision_record_idempotency_uq
    ON revision_record (session_id, idempotency_key)
    WHERE idempotency_key <> '';

COMMIT;
