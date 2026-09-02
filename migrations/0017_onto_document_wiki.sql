-- 0017_onto_document_wiki -- 项目 Wiki 当前页与不可变修订历史。
--
-- project_id + owner 是每一次读写都必须携带的隔离边界。页面没有 DELETE 语义；
-- "删除"只能写成 archived 状态并追加一条 revision。revision 行是完整快照，保留
-- 操作者、动作、时间与内容摘要，仓储没有 UPDATE/DELETE 历史行的入口。

BEGIN;

CREATE TABLE onto_document_wiki_page (
    project_id      text        NOT NULL,
    owner           text        NOT NULL,
    id              text        NOT NULL,
    title           text        NOT NULL,
    summary         text        NOT NULL,
    tags            jsonb       NOT NULL,
    claims          jsonb       NOT NULL,
    status          text        NOT NULL DEFAULT 'active',
    revision        integer     NOT NULL DEFAULT 1,
    created_by_kind text        NOT NULL,
    created_by_id   text        NOT NULL,
    created_at      timestamptz NOT NULL,
    updated_by_kind text        NOT NULL,
    updated_by_id   text        NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (project_id, owner, id),
    CONSTRAINT onto_document_wiki_page_status_ck
        CHECK (status IN ('active','archived')),
    CONSTRAINT onto_document_wiki_page_revision_ck CHECK (revision > 0),
    CONSTRAINT onto_document_wiki_page_created_actor_ck
        CHECK (created_by_kind IN ('ai','human')),
    CONSTRAINT onto_document_wiki_page_updated_actor_ck
        CHECK (updated_by_kind IN ('ai','human'))
);

CREATE INDEX onto_document_wiki_page_scope_idx
    ON onto_document_wiki_page (project_id, owner, status, updated_at);

CREATE TABLE onto_document_wiki_page_revision (
    project_id    text        NOT NULL,
    owner         text        NOT NULL,
    page_id       text        NOT NULL,
    revision      integer     NOT NULL,
    title         text        NOT NULL,
    summary       text        NOT NULL,
    tags          jsonb       NOT NULL,
    claims        jsonb       NOT NULL,
    status        text        NOT NULL,
    action        text        NOT NULL,
    actor_kind    text        NOT NULL,
    actor_id      text        NOT NULL,
    recorded_at   timestamptz NOT NULL,
    content_sha256 text       NOT NULL,
    PRIMARY KEY (project_id, owner, page_id, revision),
    CONSTRAINT onto_document_wiki_revision_number_ck CHECK (revision > 0),
    CONSTRAINT onto_document_wiki_revision_status_ck
        CHECK (status IN ('active','archived')),
    CONSTRAINT onto_document_wiki_revision_action_ck
        CHECK (action IN ('create','edit','confirm_claim','archive','restore')),
    CONSTRAINT onto_document_wiki_revision_actor_ck
        CHECK (actor_kind IN ('ai','human'))
);

CREATE INDEX onto_document_wiki_revision_history_idx
    ON onto_document_wiki_page_revision (project_id, owner, page_id, revision);

COMMIT;
