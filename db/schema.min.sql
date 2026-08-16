
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- gen_random_uuid() / digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;  -- 中文词法检索（见 memory_item）

CREATE SCHEMA IF NOT EXISTS oc;
SET search_path = oc, public;

CREATE OR REPLACE FUNCTION oc.join_text_array(text[], text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT array_to_string($1, $2)
$$;

--  1. 项目与会话

CREATE TABLE oc.project (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oc.blob (
    ref        text PRIMARY KEY,
    body       bytea,        -- 小内容直存
    ext_url    text,         -- 大内容放对象存储，这里只留指针
    size_bytes bigint      NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT blob_exactly_one_home CHECK (num_nonnulls(body, ext_url) = 1)
);

CREATE TABLE oc.session (
    id         text PRIMARY KEY,                       -- 沿用 uuid4().hex[:12]（server.py:170）
    project_id uuid        NOT NULL REFERENCES oc.project(id) ON DELETE RESTRICT,
    title      text        NOT NULL DEFAULT '新建会话',
    status     text        NOT NULL DEFAULT 'idle',
    error      text        NOT NULL DEFAULT '',
    rev        bigint      NOT NULL DEFAULT 0,
    event_seq  bigint      NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT session_status_ck CHECK (
        status IN ('idle','parsing','extracting','awaiting_answer','done','failed'))
);

CREATE TABLE oc.session_file (
    session_id  text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    file_id     text        NOT NULL,   -- 与 Provenance.file_id（oir.py:44）同一命名空间
    name        text        NOT NULL,
    size_bytes  bigint      NOT NULL,
    content_ref text        NOT NULL REFERENCES oc.blob(ref),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, file_id)
);

--  2. Run 与事件日志（唯一的恢复源）

-- ★ run.id 是每次 Run 独立的 uuid，**不再是 f"run_{s.id}"**（server.py:271）。
CREATE TABLE oc.run (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    status       text        NOT NULL,
    attempt      int         NOT NULL DEFAULT 0,
    -- ★ 刻意**不存** next_seq。Recorder._seq（recorder.py:49）的持久化形态就是
    budget       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    usd_spent    numeric(12,4) NOT NULL DEFAULT 0,
    tokens_spent bigint      NOT NULL DEFAULT 0,
    worker_id    text,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    CONSTRAINT run_kind_ck   CHECK (kind IN ('build','recompile','chat','audit')),
    CONSTRAINT run_status_ck CHECK (
        status IN ('running','suspended','completed','failed','abandoned'))
);

CREATE UNIQUE INDEX run_one_live_per_session
    ON oc.run (session_id)
    WHERE status IN ('running','suspended') AND kind IN ('build','recompile');

CREATE TABLE oc.event (
    run_id  uuid   NOT NULL REFERENCES oc.run(id) ON DELETE CASCADE,
    seq     bigint NOT NULL,
    kind    text   NOT NULL,           -- EventKind 值（kernel/events.py:22）
    node_id text,
    payload jsonb  NOT NULL DEFAULT '{}'::jsonb,
    ref     text REFERENCES oc.blob(ref),   -- Event.ref，大内容进 blob（≥2048B）
    ts_ms   bigint NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE OR REPLACE FUNCTION oc.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% 是 append-only 表，不接受 %', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON oc.event
    FOR EACH ROW EXECUTE FUNCTION oc.forbid_mutation();

CREATE OR REPLACE FUNCTION oc.run_next_seq(p_run uuid)
RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce(max(seq) + 1, 0) FROM oc.event WHERE run_id = p_run
$$;

CREATE OR REPLACE FUNCTION oc.rebuild_run_spend(p_run uuid)
RETURNS void
LANGUAGE sql AS $$
    UPDATE oc.run r SET
        usd_spent = coalesce(s.usd, 0),
        tokens_spent = coalesce(s.tok, 0)
    FROM (SELECT sum((payload->>'usd')::numeric) AS usd,
                 sum((payload->>'tok_in')::bigint
                   + (payload->>'tok_out')::bigint
                   + (payload->>'cache_read')::bigint) AS tok
            FROM oc.event
           WHERE run_id = p_run AND kind = 'budget.spent') s
    WHERE r.id = p_run;
$$;

CREATE TABLE oc.session_event (
    session_id  text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    seq         bigint      NOT NULL,
    kind        text        NOT NULL,
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    payload_ref text REFERENCES oc.blob(ref),
    ts          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
);

--  3. OIR —— 拆表存

-- ★ 刻意不存 ObjectType.conflicts / PropertyType.conflicts / LinkType.conflicts：
CREATE TABLE oc.oir_entity (
    session_id  text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rid         text NOT NULL,
    kind        text NOT NULL,
    status      text NOT NULL DEFAULT 'candidate',
    owner       text,
    parent_rid  text,                              -- PropertyType.parent
    source_rid  text,                              -- LinkType.source（to_dict 里叫 "from"）
    target_rid  text,                              -- LinkType.target（to_dict 里叫 "to"）
    applies_to  text[] NOT NULL DEFAULT '{}',      -- ActionType / BusinessRule / OpenQuestion
    member_rids text[] NOT NULL DEFAULT '{}',      -- ObjectType.properties，顺序有意义
    aliases     text[] NOT NULL DEFAULT '{}',      -- ObjectType.aliases
    q_options   text[] NOT NULL DEFAULT '{}',      -- OpenQuestion.options
    q_group     text   NOT NULL DEFAULT '',        -- OpenQuestion.group
    q_code      text   NOT NULL DEFAULT '',        -- OpenQuestion.code（客户自己的编号）
    asked_by    text   NOT NULL DEFAULT 'customer',
    ord         int    NOT NULL DEFAULT 0,         -- dict 插入序，to_dict 输出顺序靠它
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, rid),
    CONSTRAINT oir_entity_kind_ck CHECK (kind IN (
        'ObjectType','PropertyType','LinkType','ActionType','BusinessRule','OpenQuestion')),
    CONSTRAINT oir_entity_status_ck CHECK (status IN (
        'candidate','proposed','confirmed','rejected','draft_from_api'))
);

-- ★ value_domain 与 title_property 在这里有正式的家。PropertyType.to_dict
-- ★ produced_by_run / produced_by_seq 是审计链的第三跳。
CREATE TABLE oc.oir_assertion (
    session_id      text   NOT NULL,
    rid             text   NOT NULL,
    field           text   NOT NULL,
    value           jsonb,                      -- Assertion.value；JSON null 合法（semantic_type 等）
    origin          text   NOT NULL,
    confidence      double precision NOT NULL DEFAULT 0.5,
    produced_by_run uuid REFERENCES oc.run(id) ON DELETE SET NULL,
    produced_by_seq bigint,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, rid, field),
    FOREIGN KEY (session_id, rid)
        REFERENCES oc.oir_entity(session_id, rid) ON DELETE CASCADE,
    CONSTRAINT oir_assertion_origin_ck CHECK (
        origin IN ('extracted','inferred','user','auto_repaired')),
    CONSTRAINT oir_assertion_field_ck CHECK (field IN (
        'api_name','display_name','description','primary_key','title_property',
        'base_type','definition','semantic_type','unit','required','value_domain',
        'cardinality','join_key',
        'parameters','effects','source_endpoint',
        'statement','rule_kind','actor',
        'text','answer'))
);

-- ★ 不存 file_name：它在 oir.json 里被重复了 816 次（实测 41 KB 纯重复），
-- ★ snippet 可空。今天 Provenance.to_dict 截到 300 字符（oir.py:77）；这里
CREATE TABLE oc.oir_evidence (
    session_id      text NOT NULL,
    rid             text NOT NULL,
    field           text NOT NULL,
    ord             int  NOT NULL,              -- evidence 列表内的位置，语义上有序
    file_id         text NOT NULL,
    locator         jsonb NOT NULL,             -- Provenance.locator，形态随 LocatorKind 变
    cite            text NOT NULL,              -- Provenance.cite()，物化：前端点它跳原文
    snippet         text,
    extractor       text NOT NULL DEFAULT 'llm',
    confidence      double precision NOT NULL DEFAULT 0.5,
    produced_by_run uuid REFERENCES oc.run(id) ON DELETE SET NULL,
    produced_by_seq bigint,
    PRIMARY KEY (session_id, rid, field, ord),
    FOREIGN KEY (session_id, rid, field)
        REFERENCES oc.oir_assertion(session_id, rid, field) ON DELETE CASCADE,
    CONSTRAINT oir_evidence_locator_kind_ck CHECK (
        locator->>'kind' IN ('cell','range','json','ddl','page','meta','raw'))
);

CREATE TABLE oc.oir_snapshot (
    session_id text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev        bigint      NOT NULL,
    doc        jsonb       NOT NULL,
    stats      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- OIR.stats()（oir.py:435）
    built_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, rev)
);

--  4. 冲突 / 问题 / 建议 —— 全是派生，零模型调用可重算（server.py:442 注释）

CREATE TABLE oc.conflict (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev        bigint NOT NULL,                  -- 在哪一版 OIR 上检出的
    rid        text NOT NULL,
    kind       text NOT NULL,
    handling   text NOT NULL,
    subjects   text[] NOT NULL DEFAULT '{}',
    summary    text NOT NULL,
    detector   text NOT NULL DEFAULT 'rule',
    owner      text,
    evidence   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 派生数据，不拆表
    options    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- Option.to_dict()，含各自的 evidence
    PRIMARY KEY (session_id, rev, rid),
    CONSTRAINT conflict_kind_ck CHECK (kind IN (
        'semantic_divergence','missing_required','naming_violation','duplicate',
        'perfunctory','orphan','type_mismatch','missing_action')),
    CONSTRAINT conflict_handling_ck CHECK (
        handling IN ('ask_user','auto_repair','round_trip','hint'))
);

CREATE TABLE oc.question (
    session_id   text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev          bigint NOT NULL,
    qid          text NOT NULL,                   -- Question.id
    conflict_rid text NOT NULL,
    title        text NOT NULL,
    impact_count int NOT NULL DEFAULT 0,
    score        double precision NOT NULL DEFAULT 0,
    reversible   boolean NOT NULL DEFAULT true,
    options      jsonb NOT NULL DEFAULT '[]'::jsonb,
    ord          int NOT NULL DEFAULT 0,          -- 展示顺序 = 用户口中的"第几条"（server.py:518）
    PRIMARY KEY (session_id, rev, qid)
);

CREATE TABLE oc.suggestion (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev        bigint NOT NULL,
    sid        text NOT NULL,
    kind       text NOT NULL,
    title      text NOT NULL,
    rationale  text NOT NULL DEFAULT '',
    impact     int NOT NULL DEFAULT 0,
    confidence double precision NOT NULL DEFAULT 0.8,
    citations  text[] NOT NULL DEFAULT '{}',
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    ord        int NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, rev, sid),
    CONSTRAINT suggestion_kind_ck CHECK (kind IN (
        'ADD_LINK','ASK_MATERIAL','EXCLUDE','NAMING','BIND_RULE','REVIEW'))
);

--  5. 人拍的板 —— 全库最该优先落库的东西

CREATE TABLE oc.decision (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     text   NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    seq            bigint NOT NULL,               -- 会话内单调；重放顺序靠它
    source         text   NOT NULL,
    kind           text   NOT NULL,               -- DecisionKind（dialogue.py:74）
    statement      text   NOT NULL,
    scope_refs     text[] NOT NULL DEFAULT '{}',
    conflict_rid   text,
    option_id      text,
    label          text   NOT NULL DEFAULT '',    -- apply_decision 返回的 option.label
    changed_rids   text[] NOT NULL DEFAULT '{}',  -- apply_decision 返回的 changed
    suggestion_sid text,
    note           text   NOT NULL DEFAULT '',
    turn_index     int    NOT NULL DEFAULT -1,
    superseded_by  uuid REFERENCES oc.decision(id),
    applied_at_rev bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    dlg_key text GENERATED ALWAYS AS (
        'dlg_' || substr(encode(public.digest(kind || ':' || statement, 'sha256'), 'hex'), 1, 12)
    ) STORED,
    UNIQUE (session_id, seq),
    CONSTRAINT decision_source_ck CHECK (
        source IN ('clarify_answer','suggestion','dialogue')),
    CONSTRAINT decision_kind_ck CHECK (
        kind IN ('caliber','naming','scope','answer','adoption','correction'))
);

CREATE TABLE oc.dialogue_turn (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    idx        int  NOT NULL,                     -- Decision.turn_index 指向它
    speaker    text NOT NULL,
    body       text NOT NULL,                     -- Utterance.text
    ts         double precision NOT NULL,         -- time.time() float，保持原精度
    intent     text NOT NULL DEFAULT '',
    refs       text[] NOT NULL DEFAULT '{}',      -- 压缩时不丢：指代消解的唯一依据
    compressed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (session_id, idx),
    CONSTRAINT dialogue_speaker_ck CHECK (speaker IN ('user','assistant','system'))
);

CREATE TABLE oc.dialogue_state (
    session_id    text PRIMARY KEY REFERENCES oc.session(id) ON DELETE CASCADE,
    budget_tokens int NOT NULL DEFAULT 4000,
    keep_verbatim int NOT NULL DEFAULT 8,
    compactions   int NOT NULL DEFAULT 0
);

--  5b. 产物 —— xlsx / template.spec.json
CREATE TABLE oc.artifact (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    kind        text NOT NULL,
    revision    int  NOT NULL,
    oir_rev     bigint NOT NULL,
    filename    text NOT NULL,
    content_ref text NOT NULL REFERENCES oc.blob(ref),
    media_type  text NOT NULL,
    stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivered_at timestamptz,
    produced_by uuid REFERENCES oc.run(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, kind, revision),
    CONSTRAINT artifact_kind_ck CHECK (kind IN (
        'template_xlsx',    -- write_xlsx（template.py）
        'template_spec',    -- TemplateSpec.save；有 from_dict，能真读回来
        'oir_json',         -- 给下游看的，OIR 没有 from_dict，读不回来（见 §3 注）
        'returned_xlsx'))   -- 业务方回传件，server.py:882 的 dest
);

CREATE TRIGGER artifact_no_delete BEFORE DELETE ON oc.artifact
    FOR EACH ROW EXECUTE FUNCTION oc.forbid_mutation();

CREATE TRIGGER artifact_only_delivered_at
    BEFORE UPDATE ON oc.artifact
    FOR EACH ROW
    WHEN (OLD.delivered_at IS NOT NULL          -- 已发出，永久冻结
       OR NEW.delivered_at IS NULL              -- 不是在标记发出
       OR (OLD.id, OLD.session_id, OLD.kind, OLD.revision, OLD.oir_rev,
           OLD.filename, OLD.content_ref, OLD.media_type, OLD.stats,
           OLD.produced_by, OLD.created_at)
          IS DISTINCT FROM
          (NEW.id, NEW.session_id, NEW.kind, NEW.revision, NEW.oir_rev,
           NEW.filename, NEW.content_ref, NEW.media_type, NEW.stats,
           NEW.produced_by, NEW.created_at))
    EXECUTE FUNCTION oc.forbid_mutation();

CREATE OR REPLACE FUNCTION oc.mark_delivered(p_artifact uuid)
RETURNS timestamptz
LANGUAGE sql AS $$
    UPDATE oc.artifact SET delivered_at = now()
     WHERE id = p_artifact AND delivered_at IS NULL
    RETURNING delivered_at;
$$;

CREATE OR REPLACE VIEW oc.v_artifact_current AS
SELECT DISTINCT ON (session_id, kind) *
  FROM oc.artifact ORDER BY session_id, kind, revision DESC;

CREATE OR REPLACE VIEW oc.v_audit_basis AS
SELECT x.session_id, x.revision, x.oir_rev,
       x.id AS xlsx_id, x.content_ref AS xlsx_ref, x.delivered_at,
       s.id AS spec_id, s.content_ref AS spec_ref
  FROM oc.artifact x
  JOIN oc.artifact s
    ON s.session_id = x.session_id
   AND s.kind = 'template_spec'
   AND s.oir_rev = x.oir_rev
 WHERE x.kind = 'template_xlsx';

--  6. 长期记忆（L3）—— 今天磁盘上 0 字节，这层是从零接

CREATE TABLE oc.memory_item (
    project_id      uuid NOT NULL REFERENCES oc.project(id) ON DELETE CASCADE,
    key             text NOT NULL,                -- mem_key()（types.py:124），同 key 走合并
    kind            text NOT NULL,
    scope           text NOT NULL,
    content         text NOT NULL,
    confidence      double precision NOT NULL DEFAULT 0.5,
    support         text[] NOT NULL DEFAULT '{}', -- 'dialogue:{run}:turn{n}' 等
    tags            text[] NOT NULL DEFAULT '{}',
    meta            jsonb  NOT NULL DEFAULT '{}'::jsonb,
    created_run     text NOT NULL DEFAULT '',
    last_used_run   text NOT NULL DEFAULT '',
    use_count       int  NOT NULL DEFAULT 0,
    hit_runs        text[] NOT NULL DEFAULT '{}',
    contested_by    text[] NOT NULL DEFAULT '{}',
    promoted_reason text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    search_doc text GENERATED ALWAYS AS (
        content || ' ' || oc.join_text_array(tags, ' ')
    ) STORED,
    PRIMARY KEY (project_id, key),
    CONSTRAINT memory_kind_ck CHECK (
        kind IN ('lesson','term','convention','decision','fact','artifact')),
    CONSTRAINT memory_scope_ck CHECK (scope IN ('node','run','project','tenant')),
    CONSTRAINT memory_reason_ck CHECK (promoted_reason IS NULL OR promoted_reason IN (
        'human_confirmed','critic_survived','repeated','imported')),
    CONSTRAINT memory_promoted_needs_support CHECK (
        scope IN ('node','run') OR cardinality(support) > 0)
);

CREATE TABLE oc.memory_run (
    project_id uuid NOT NULL REFERENCES oc.project(id) ON DELETE CASCADE,
    run_key    text NOT NULL,
    ord        int  NOT NULL,
    seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, run_key),
    UNIQUE (project_id, ord)
);

--  7. 证据切片（L2）与小块派生状态

CREATE TABLE oc.evidence_chunk (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    ord        int  NOT NULL,
    file_name  text NOT NULL,
    cite       text NOT NULL,
    body       text NOT NULL,                     -- Chunk.render[:1500]
    tags       text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_id, ord)
);

CREATE TABLE oc.session_kv (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    key        text NOT NULL,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, key),
    -- ★ 'template' 与 'artifacts' 从这张表里**删掉**了：
    CONSTRAINT session_kv_key_ck CHECK (key IN (
        'corpus','routing','budget','audit','endpoints','profiles'))
);

--  8. 索引清单 —— 每条都写明服务哪个查询

CREATE INDEX session_by_project_updated
    ON oc.session (project_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX oir_entity_by_kind
    ON oc.oir_entity (session_id, kind, ord);
CREATE INDEX oir_entity_by_parent
    ON oc.oir_entity (session_id, parent_rid)
    WHERE parent_rid IS NOT NULL;

CREATE INDEX decision_by_conflict
    ON oc.decision (session_id, conflict_rid)
    WHERE conflict_rid IS NOT NULL;
CREATE INDEX decision_active
    ON oc.decision (session_id, seq)
    WHERE superseded_by IS NULL;

CREATE INDEX run_stale_lease
    ON oc.run (heartbeat_at)
    WHERE status IN ('running','suspended');
CREATE INDEX run_by_session
    ON oc.run (session_id, started_at DESC);

CREATE INDEX memory_recall_pool
    ON oc.memory_item (project_id, kind, confidence DESC)
    WHERE NOT (tags @> ARRAY['superseded']);
CREATE INDEX memory_search_trgm
    ON oc.memory_item USING gin (search_doc gin_trgm_ops);
CREATE INDEX memory_by_support
    ON oc.memory_item USING gin (support);

CREATE INDEX evidence_by_file
    ON oc.oir_evidence (file_id, session_id);
CREATE INDEX evidence_by_cite
    ON oc.oir_evidence (session_id, cite);
CREATE INDEX evidence_chunk_by_cite
    ON oc.evidence_chunk (session_id, cite);
CREATE INDEX assertion_by_event
    ON oc.oir_assertion (produced_by_run, produced_by_seq)
    WHERE produced_by_run IS NOT NULL;
CREATE INDEX evidence_by_event
    ON oc.oir_evidence (produced_by_run, produced_by_seq)
    WHERE produced_by_run IS NOT NULL;
CREATE INDEX assertion_human_touched
    ON oc.oir_assertion (session_id, origin, updated_at DESC)
    WHERE origin IN ('user','auto_repaired');

CREATE INDEX conflict_by_subject
    ON oc.conflict USING gin (subjects);
CREATE INDEX conflict_by_handling
    ON oc.conflict (session_id, rev, handling);
CREATE INDEX session_file_by_blob
    ON oc.session_file (content_ref);

--  9. 并发：乐观锁的两个原语

CREATE OR REPLACE FUNCTION oc.bump_rev(p_session text, p_expected bigint)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_new bigint;
BEGIN
    UPDATE oc.session
       SET rev = rev + 1, updated_at = now()
     WHERE id = p_session AND rev = p_expected
    RETURNING rev INTO v_new;

    IF v_new IS NULL THEN
        RAISE EXCEPTION 'stale_rev: session=% expected=% actual=%',
            p_session, p_expected,
            (SELECT rev FROM oc.session WHERE id = p_session)
            USING ERRCODE = '40001';   -- serialization_failure，客户端可据此重试
    END IF;
    RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION oc.emit_session_event(
    p_session text, p_kind text, p_payload jsonb, p_payload_ref text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_seq bigint;
BEGIN
    UPDATE oc.session SET event_seq = event_seq + 1
     WHERE id = p_session
    RETURNING event_seq INTO v_seq;

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'no_session: %', p_session;
    END IF;

    INSERT INTO oc.session_event (session_id, seq, kind, payload, payload_ref)
    VALUES (p_session, v_seq, p_kind, p_payload, p_payload_ref);

    PERFORM pg_notify('oc_session_' || p_session, v_seq::text);
    RETURN v_seq;
END;
$$;

CREATE OR REPLACE FUNCTION oc.claim_run(
    p_session text, p_kind text, p_worker text)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_run uuid;
BEGIN
    PERFORM 1 FROM oc.session WHERE id = p_session FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no_session: %', p_session;
    END IF;

    SELECT id INTO v_run FROM oc.run
     WHERE session_id = p_session
       AND status IN ('running','suspended')
       AND kind IN ('build','recompile');

    IF v_run IS NOT NULL THEN
        RETURN NULL;                      -- 已经在跑了；调用方回 409
    END IF;

    INSERT INTO oc.run (session_id, kind, status, worker_id)
    VALUES (p_session, p_kind, 'running', p_worker)
    RETURNING id INTO v_run;
    RETURN v_run;
END;
$$;

--  10. 五个必备查询的规范写法

CREATE OR REPLACE VIEW oc.v_session_brief AS
SELECT s.id, s.project_id, s.title, s.status, s.error, s.rev,
       s.created_at, s.updated_at,
       (SELECT count(*) FROM oc.session_file f WHERE f.session_id = s.id) AS files
  FROM oc.session s
 WHERE s.deleted_at IS NULL;

CREATE OR REPLACE VIEW oc.v_orphan_run AS
SELECT r.id AS run_id, r.session_id, r.kind, r.status,
       r.usd_spent, r.heartbeat_at,
       (SELECT max(seq) FROM oc.event e WHERE e.run_id = r.id) AS last_seq,
       oc.run_next_seq(r.id) AS next_seq
  FROM oc.run r
 WHERE r.status IN ('running','suspended')
   AND r.heartbeat_at < now() - interval '90 seconds';

CREATE OR REPLACE FUNCTION oc.trace_assertion(
    p_session text, p_rid text, p_field text)
RETURNS TABLE (
    ord             int,
    origin          text,
    assert_conf     double precision,
    file_name       text,
    cite            text,
    locator         jsonb,
    chunk_body      text,       -- 1500 字符的原文，比 snippet[:300] 完整
    extractor       text,
    ev_conf         double precision,
    event_run       uuid,
    event_seq       bigint,
    event_kind      text,
    event_node      text,
    event_payload   jsonb,
    event_blob_ref  text
)
LANGUAGE sql STABLE AS $$
    SELECT ev.ord, a.origin, a.confidence,
           f.name, ev.cite, ev.locator,
           coalesce(ch.body, ev.snippet),
           ev.extractor, ev.confidence,
           e.run_id, e.seq, e.kind, e.node_id, e.payload, e.ref
      FROM oc.oir_assertion a
      LEFT JOIN oc.oir_evidence ev
             ON (ev.session_id, ev.rid, ev.field) = (a.session_id, a.rid, a.field)
      LEFT JOIN oc.session_file f
             ON (f.session_id, f.file_id) = (ev.session_id, ev.file_id)
      LEFT JOIN oc.evidence_chunk ch
             ON (ch.session_id, ch.cite) = (ev.session_id, ev.cite)
      LEFT JOIN oc.event e
             ON e.run_id = coalesce(ev.produced_by_run, a.produced_by_run)
            AND e.seq    = coalesce(ev.produced_by_seq, a.produced_by_seq)
     WHERE a.session_id = p_session AND a.rid = p_rid AND a.field = p_field
     ORDER BY ev.ord;
$$;

CREATE OR REPLACE FUNCTION oc.assertions_from_file(p_file_id text)
RETURNS TABLE (session_id text, rid text, field text, origin text, cite text)
LANGUAGE sql STABLE AS $$
    SELECT a.session_id, a.rid, a.field, a.origin, ev.cite
      FROM oc.oir_evidence ev
      JOIN oc.oir_assertion a
        ON (a.session_id, a.rid, a.field) = (ev.session_id, ev.rid, ev.field)
     WHERE ev.file_id = p_file_id
       AND a.origin <> 'user';
$$;

CREATE OR REPLACE FUNCTION oc.recall_candidates(
    p_project uuid, p_query text, p_kinds text[] DEFAULT NULL, p_limit int DEFAULT 64)
RETURNS SETOF oc.memory_item
LANGUAGE sql STABLE AS $$
    SELECT m.*
      FROM oc.memory_item m
     WHERE m.project_id = p_project
       AND NOT (m.tags @> ARRAY['superseded'])
       AND (p_kinds IS NULL OR m.kind = ANY(p_kinds))
       AND (p_query = '' OR m.search_doc % p_query)   -- pg_trgm 相似度阈值
     ORDER BY similarity(m.search_doc, p_query) DESC, m.confidence DESC
     LIMIT p_limit;
$$;
