-- ═══════════════════════════════════════════════════════════════════════════
--  OntoCopilot — Postgres 持久化模式
--  目标 PG 版本：16（用到 gen_random_uuid / num_nonnulls / GENERATED STORED /
--  partial unique index / gin_trgm_ops）
--
--  一条纪律贯穿全表：**真相恰好一份**。
--    · OIR 的真相 = oir_entity + oir_assertion + oir_evidence 三张行表
--    · Run 的真相 = event 表（PK (run_id, seq)）
--    · 人拍的板的真相 = decision 表
--  其余带 "派生" 注释的表都是缓存，可以整表 DELETE 后重算，任何恢复逻辑
--  都不许读它们。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- gen_random_uuid() / digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;  -- 中文词法检索（见 memory_item）

CREATE SCHEMA IF NOT EXISTS oc;
SET search_path = oc, public;

-- array_to_string 在 pg_proc 里是 STABLE（元素输出函数不保证 immutable），
-- 而生成列与索引表达式都要求 IMMUTABLE。对 text[] 而言它事实上是 immutable ——
-- text 的输出函数就是恒等。这是标准做法，但**只对 text[] 成立**，别改成 anyarray。
CREATE OR REPLACE FUNCTION oc.join_text_array(text[], text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT array_to_string($1, $2)
$$;


-- ═══════════════════════════════════════════════════════════════════════════
--  1. 项目与会话
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE oc.project (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 内容寻址 blob。ref 格式见 kernel/ids.py:28 content_ref() → 'blob:'||sha256[:32]
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
    -- 乐观锁。任何改变 OIR / decision / 状态机的事务都必须 +1。
    rev        bigint      NOT NULL DEFAULT 0,
    -- SSE 流水号，取代内存里的 len(s.events)（server.py:109）
    event_seq  bigint      NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT session_status_ck CHECK (
        status IN ('idle','parsing','extracting','awaiting_answer','done','failed'))
);

-- files[i]["path"] 今天存的是绝对路径（server.py:187），换机器即失效。
-- 这里改成 content_ref：材料本体进 blob，路径不再是身份。
CREATE TABLE oc.session_file (
    session_id  text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    file_id     text        NOT NULL,   -- 与 Provenance.file_id（oir.py:44）同一命名空间
    name        text        NOT NULL,
    size_bytes  bigint      NOT NULL,
    content_ref text        NOT NULL REFERENCES oc.blob(ref),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, file_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
--  2. Run 与事件日志（唯一的恢复源）
-- ═══════════════════════════════════════════════════════════════════════════

-- ★ run.id 是每次 Run 独立的 uuid，**不再是 f"run_{s.id}"**（server.py:271）。
--   照抄那个写法的话，第二次 build 会把 seq 从 0 重来一遍，直接违反 event 的 PK。
CREATE TABLE oc.run (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    status       text        NOT NULL,
    attempt      int         NOT NULL DEFAULT 0,
    -- ★ 刻意**不存** next_seq。Recorder._seq（recorder.py:49）的持久化形态就是
    --   max(event.seq)+1，而 event 的 PK 是 (run_id, seq) —— 取 max 是一次
    --   索引末端探查，O(1)。存一个副本只会引入漂移：副本大了就在日志里留空洞，
    --   小了就直接撞主键。resume=True 时从 oc.run_next_seq() 取。
    --
    -- Budget.snapshot()（budget.py:138）。Budget 没有 from_dict，恢复时预算要按
    -- 已花金额重新构造 floor，否则重启后钱从 0 重新算。
    -- ⚠ 派生列：真相是 event 里的 budget.spent 事件流（llm.py:384 每次调用发一条）。
    --   这三列由写事件的同一个事务顺带更新，重建见 oc.rebuild_run_spend()。
    budget       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    usd_spent    numeric(12,4) NOT NULL DEFAULT 0,
    tokens_spent bigint      NOT NULL DEFAULT 0,
    -- 崩溃检测：进程活着就续租，租约过期即判定为孤儿 Run。
    worker_id    text,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    CONSTRAINT run_kind_ck   CHECK (kind IN ('build','recompile','chat','audit')),
    CONSTRAINT run_status_ck CHECK (
        status IN ('running','suspended','completed','failed','abandoned'))
);

-- 一个会话同时只能有一个活着的 build/recompile。
-- 取代 server.py:253 的 `if s.status in ("parsing","extracting"): 409` ——
-- 那是跨 worker 的 check-then-act 竞态，重复起一次 Run 要真花一次钱（USD cap 15）。
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
-- append-only 是审计要求（journal.py:96 "永不修改、永不删除"）。
--
-- ⚠ 注意 `REVOKE UPDATE, DELETE ON oc.event FROM PUBLIC` 是**空操作**：
--   PUBLIC 本来就没有这两个权限（建表时只有属主有），revoke 一个不存在的授权
--   什么也没发生。而属主自己绕过一切 GRANT —— 应用如果用建表那个角色连库，
--   这行防的是零。所以两道都要有，且顺序是：先触发器（挡属主的手滑），
--   再 GRANT（挡被盗用的应用角色）。触发器不会被 SECURITY DEFINER 绕过 ——
--   SECURITY DEFINER 改的是权限检查身份，触发器照常触发。
CREATE OR REPLACE FUNCTION oc.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% 是 append-only 表，不接受 %', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON oc.event
    FOR EACH ROW EXECUTE FUNCTION oc.forbid_mutation();

-- Recorder._seq 的唯一真相：日志末端。没有事件时返回 0，与 Recorder 初值一致。
CREATE OR REPLACE FUNCTION oc.run_next_seq(p_run uuid)
RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce(max(seq) + 1, 0) FROM oc.event WHERE run_id = p_run
$$;

-- run 的花费三列是派生缓存，这是它们的重建语句。
-- 口径与 llm.py:384 发的 budget.spent 事件逐字对齐（usd / tok_in / tok_out /
-- cache_read；注意 payload 里没有 cache_write，Usage.total 才含它）。
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

-- 前端 SSE 流。**派生表**：可以整表清空，恢复逻辑一律不读它。
-- 存在的唯一理由是 /stream?since=N 断线补发（server.py:228）需要一份持久副本 ——
-- 今天这 250–300 KB/会话在磁盘上一个副本都没有。
CREATE TABLE oc.session_event (
    session_id  text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    seq         bigint      NOT NULL,
    kind        text        NOT NULL,
    -- 单条实测最大 235,702 B（node.completed node=CONFLICT 携带 464 条冲突）。
    -- 超过 2048 B 的 payload 走 blob，和 Recorder.INLINE_LIMIT（recorder.py:31）
    -- 保持同一条纪律，避免两处阈值漂移。
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    payload_ref text REFERENCES oc.blob(ref),
    ts          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
);


-- ═══════════════════════════════════════════════════════════════════════════
--  3. OIR —— 拆表存
-- ═══════════════════════════════════════════════════════════════════════════

-- 一行 = 一个 ObjectType / PropertyType / LinkType / ActionType /
--         BusinessRule / OpenQuestion。
-- 只放**非 Assertion**字段：结构关系、状态、纯列表。带 Provenance 的值一律进
-- oir_assertion。
--
-- ★ 刻意不存 ObjectType.conflicts / PropertyType.conflicts / LinkType.conflicts：
--   detect_all（conflict.py:580-584）只追加不删除，已解决的 rid 永远留着，快照
--   之间的 diff 会一直显示"有变化"。冲突本来就不是本体的属性 —— 读的时候从
--   conflict.subjects 反查（见下方 conflict_by_subject 索引）。
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

-- 一行 = 一个 Assertion[T]（oir.py:90）。
--
-- ★ value_domain 与 title_property 在这里有正式的家。PropertyType.to_dict
--   （oir.py:183）不输出 value_domain、ObjectType.to_dict（oir.py:208）不输出
--   title_property —— 走 to_dict 落库就是往返即丢。行表直接从活对象读字段，
--   绕开了这个损耗，不用先去改 oir.py。
--
-- ★ produced_by_run / produced_by_seq 是审计链的第三跳。
--   实测：grep run_id src/ontocopilot/onto/ 零命中 —— Provenance 里没有任何
--   字段指回产生它的那次 LLM 调用。"这条断言是怎么来的"今天只能答到"某个单元格"，
--   答不到"哪次调用、花了多少钱、哪个 critic 放行的"。这两列由 build 阶段写入。
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
    -- 注：Assertion.validate（oir.py:106）的"EXTRACTED 必须有 evidence"没有做成
    -- 表级约束 —— 它跨 oir_assertion / oir_evidence 两张表，CHECK 管不着，
    -- 要做只能上 CONSTRAINT TRIGGER。目前仍由 Provenance critic 事后抓。
    CONSTRAINT oir_assertion_field_ck CHECK (field IN (
        -- ObjectType
        'api_name','display_name','description','primary_key','title_property',
        -- PropertyType
        'base_type','definition','semantic_type','unit','required','value_domain',
        -- LinkType
        'cardinality','join_key',
        -- ActionType
        'parameters','effects','source_endpoint',
        -- BusinessRule
        'statement','rule_kind','actor',
        -- OpenQuestion
        'text','answer'))
);

-- 一行 = 一条 Provenance（oir.py:41）。
--
-- ★ 不存 file_name：它在 oir.json 里被重复了 816 次（实测 41 KB 纯重复），
--   join session_file 拿。
-- ★ snippet 可空。今天 Provenance.to_dict 截到 300 字符（oir.py:77）；这里
--   优先指向 evidence_chunk（1500 字符的那份），指不到时（meta / raw / 人工决策）
--   才回退到内联 snippet。
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

-- **派生表**：OIR.to_dict() 的物化视图，给 /state 一次性吐整棵树用。
-- rev 与 session.rev 对齐；读的时候 rev 对不上就重建。这样"活对象 / state 快照 /
-- oir.json"三份真相变成一份真相 + 一份带版本戳的缓存，不可能漂移。
CREATE TABLE oc.oir_snapshot (
    session_id text        NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev        bigint      NOT NULL,
    doc        jsonb       NOT NULL,
    stats      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- OIR.stats()（oir.py:435）
    built_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, rev)
);


-- ═══════════════════════════════════════════════════════════════════════════
--  4. 冲突 / 问题 / 建议 —— 全是派生，零模型调用可重算（server.py:442 注释）
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE oc.conflict (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    rev        bigint NOT NULL,                  -- 在哪一版 OIR 上检出的
    rid        text NOT NULL,
    kind       text NOT NULL,
    -- Conflict.handling 是从 POLICY（conflict.py:65）派生的属性、不是存储字段。
    -- 存下来是因为 POLICY 会随代码演进，审计要看**当时**是怎么处置的。
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
    -- apply_suggestion（suggest.py:306）消费的是 **dict** 而不是 Suggestion 对象，
    -- 所以这一列从库里直读就能直接执行，不需要反序列化器。
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    ord        int NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, rev, sid),
    CONSTRAINT suggestion_kind_ck CHECK (kind IN (
        'ADD_LINK','ASK_MATERIAL','EXCLUDE','NAMING','BIND_RULE','REVIEW'))
);


-- ═══════════════════════════════════════════════════════════════════════════
--  5. 人拍的板 —— 全库最该优先落库的东西
-- ═══════════════════════════════════════════════════════════════════════════

-- 三条今天各自散落的路径合流到一张表：
--   · apply_decision（clarify.py:196）  → source='clarify_answer'
--   · apply_suggestion（suggest.py:306）→ source='suggestion'
--   · DialogueMemory.decide（dialogue.py:196）→ source='dialogue'
-- 它们今天分别活在 s.state["answered"]、一条 SSE 事件、和 _dialogue 活对象里，
-- 进程一挂全没。模型跑出来的可以花钱重跑，人拍的板重跑不出来。
CREATE TABLE oc.decision (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     text   NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    seq            bigint NOT NULL,               -- 会话内单调；重放顺序靠它
    source         text   NOT NULL,
    kind           text   NOT NULL,               -- DecisionKind（dialogue.py:74）
    statement      text   NOT NULL,
    scope_refs     text[] NOT NULL DEFAULT '{}',
    -- clarify_answer 专属
    conflict_rid   text,
    option_id      text,
    label          text   NOT NULL DEFAULT '',    -- apply_decision 返回的 option.label
    changed_rids   text[] NOT NULL DEFAULT '{}',  -- apply_decision 返回的 changed
    -- suggestion 专属
    suggestion_sid text,
    note           text   NOT NULL DEFAULT '',
    -- dialogue 专属：Decision.turn_index（dialogue.py:106），审计要能回到原话
    turn_index     int    NOT NULL DEFAULT -1,
    -- 不删除，只标推翻（dialogue.py:108 的设计意图）
    superseded_by  uuid REFERENCES oc.decision(id),
    applied_at_rev bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- 与 Decision.key（dialogue.py:113）逐字节一致，保证晋升长期库时 key 对得上
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

-- DialogueMemory.from_dict（dialogue.py:305）不吃 budget_tokens / keep_verbatim，
-- 要靠 **kw 重新传。不存的话恢复出来的会话用的是和当初不一样的压缩阈值。
CREATE TABLE oc.dialogue_state (
    session_id    text PRIMARY KEY REFERENCES oc.session(id) ON DELETE CASCADE,
    budget_tokens int NOT NULL DEFAULT 4000,
    keep_verbatim int NOT NULL DEFAULT 8,
    compactions   int NOT NULL DEFAULT 0
);


-- ═══════════════════════════════════════════════════════════════════════════
--  5b. 产物 —— xlsx / template.spec.json
--
--  这是整套边界里最容易划错的一格。
--
--  「产物是 compile_template() 算出来的，而那是零模型调用的确定性代码
--  （server.py:442 的注释原话），所以它是派生数据，不用存，要看重算一遍就行。」
--  —— 这个推理对 spec 成立，对**已经发出去的 xlsx 不成立**。
--
--  xlsx 一旦发给业务方，它的字节就不再是一个函数的输出，而是一件**世界上发生
--  过的事**：我们究竟递给对方哪一版。这件事没有任何函数能重算，因为重算依赖的
--  OIR 在那之后被 /answer 和 apply_suggestion 改过了。
--  所以判据不是"能不能重算"，是"重算出来的东西还算不算同一个东西"。
--
--  今天这里是坏的，而且坏法很典型：
--    · _compile（server.py:464）永远写死同一个文件名 s.dir/"模板_v1.xlsx"，
--      重编译就地覆盖；
--    · s.state["template"] = spec.stats() 留的是**那一次**的统计；
--    · s.state["artifacts"] = [p.name for p in s.dir.iterdir() if p.is_file()]
--      还会把 oir.json、template.spec.json、回传_*.xlsx 一起扫进来。
--  于是"内存里的统计"和"磁盘上的文件"随时可能是两个不同版本的产物 ——
--  两份真相，而且是用户会下载走的那一份。
--
--  ★ 与 /audit 的连带关系（server.py:880）：ReturnAuditor.audit(spec, ...) 比对的
--    是回传件与 spec。若 spec 是审核时**重新编译**出来的，而 OIR 已经变了，
--    比对基准就和发出去的工作簿对不上 —— read_returned 靠隐藏的 _oir_rid 对齐
--    （audit.py:108），rid 还在，但格子的 role/owner 全变了，审出来的缺口是假的。
--    所以 spec 必须与 xlsx **同版钉死**，而不是各自重算。
CREATE TABLE oc.artifact (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    kind        text NOT NULL,
    -- 同一 kind 的第几版。重编译 = 新一行，永不覆盖。
    revision    int  NOT NULL,
    -- 这一版编译自哪一版 OIR。审计链：xlsx → oir rev → assertion → event。
    oir_rev     bigint NOT NULL,
    -- 展示与下载用的名字。**不是存储键** —— 存储键是 content_ref。
    -- '模板_v1.xlsx' 里的 v1 是 TemplateSpec.round（template.py:106），
    -- 与这里的 revision 不是一回事：round 是发给业务方的第几轮，
    -- revision 是我们内部重编译的第几次。混用会让"第二轮"这个词在两边指不同东西。
    filename    text NOT NULL,
    content_ref text NOT NULL REFERENCES oc.blob(ref),
    media_type  text NOT NULL,
    -- template_xlsx / template_spec 放 TemplateSpec.stats()（template.py:152）；
    -- oir_json 放 OIR.stats()（oir.py:435）。取代 s.state["template"]。
    stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- 只有真发出去了才置上。没发出去的产物可以随便重算、随便丢；
    -- 置上之后这一行连同它的 blob 进入保留期，GC 不许碰。
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

-- delivered_at 是发出那一刻才知道的，允许 NULL → 非 NULL **单向**置一次，
-- 且其余每一列都不许动。用触发器的 WHEN 子句声明式表达，而不是在函数里
-- DISABLE TRIGGER —— 后者要 ALTER TABLE 拿 ACCESS EXCLUSIVE 锁，
-- 在同一会话里正被查询的表上直接报错（实测：cannot ALTER TABLE ...
-- because it is being used by active queries in this session），
-- 而且它会在锁窗口内对**所有**并发写打开缺口。
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

-- 当前版本。取代 s.state["artifacts"] 那个 iterdir()。
CREATE OR REPLACE VIEW oc.v_artifact_current AS
SELECT DISTINCT ON (session_id, kind) *
  FROM oc.artifact ORDER BY session_id, kind, revision DESC;

-- 审回传时**必须**用这个 spec，不是重新编译的那个。
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


-- ═══════════════════════════════════════════════════════════════════════════
--  6. 长期记忆（L3）—— 今天磁盘上 0 字节，这层是从零接
-- ═══════════════════════════════════════════════════════════════════════════

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
    -- MemoryItem.hit_runs 是 set，to_dict 存成 sorted list（types.py:101）。
    -- 这里用数组 + 写入时去重排序，语义等价。REPEATED 晋升看它的 cardinality。
    hit_runs        text[] NOT NULL DEFAULT '{}',
    contested_by    text[] NOT NULL DEFAULT '{}',
    promoted_reason text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- 检索用的合成文本。Python 侧 _score（long_term.py:219）打的就是
    -- content + tags 的并集，这里保持一致，避免两处口径不同。
    search_doc text GENERATED ALWAYS AS (
        content || ' ' || oc.join_text_array(tags, ' ')
    ) STORED,
    PRIMARY KEY (project_id, key),
    CONSTRAINT memory_kind_ck CHECK (
        kind IN ('lesson','term','convention','decision','fact','artifact')),
    CONSTRAINT memory_scope_ck CHECK (scope IN ('node','run','project','tenant')),
    CONSTRAINT memory_reason_ck CHECK (promoted_reason IS NULL OR promoted_reason IN (
        'human_confirmed','critic_survived','repeated','imported')),
    -- PromotionGate.require_support（long_term.py:54, 默认 True）搬进 DB：
    -- 长期记忆一旦污染，之后所有 Run 都受影响。这条规则太贵，不能只靠调用方自觉。
    CONSTRAINT memory_promoted_needs_support CHECK (
        scope IN ('node','run') OR cardinality(support) > 0)
);

-- LongTermStore._run_seen（long_term.py:109）。decay() 靠 Run 的**顺序**算闲置轮数，
-- 不是靠时间戳 —— 存成有序表而不是数组，因为它只追加、且要能 join。
CREATE TABLE oc.memory_run (
    project_id uuid NOT NULL REFERENCES oc.project(id) ON DELETE CASCADE,
    run_key    text NOT NULL,
    ord        int  NOT NULL,
    seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, run_key),
    UNIQUE (project_id, ord)
);


-- ═══════════════════════════════════════════════════════════════════════════
--  7. 证据切片（L2）与小块派生状态
-- ═══════════════════════════════════════════════════════════════════════════

-- s.state["_chunks"]（server.py:287）。实测 477 切片 / 312 KB / 会话，磁盘无副本。
-- 丢了之后扫描件的"点回原文"直接断（server.py:863-867 返回 not_parsed_yet），
-- 而且重跑 OCR 拿到的文本可能和抽取时不同 —— 那样这个功能的意义正好被抵消。
CREATE TABLE oc.evidence_chunk (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    ord        int  NOT NULL,
    file_name  text NOT NULL,
    cite       text NOT NULL,
    body       text NOT NULL,                     -- Chunk.render[:1500]
    tags       text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_id, ord)
);

-- 小块派生状态。都是几百字节到几十 KB、且从不按字段查询的东西，
-- 一张 kv 表比八个会漂移的列干净。
--   corpus     1,274 B    routing  190 B    budget  258 B
--   template     129 B    audit  3,373 B    endpoints <1 KB
--   profiles  98,040 B（_recompile 与 builtin_registry 都要）
--   artifacts  几十字节（唯一能从磁盘重建的）
CREATE TABLE oc.session_kv (
    session_id text NOT NULL REFERENCES oc.session(id) ON DELETE CASCADE,
    key        text NOT NULL,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, key),
    -- ★ 'template' 与 'artifacts' 从这张表里**删掉**了：
    --   前者是 oc.artifact.stats，后者是 oc.artifact 的行本身。
    --   留在这里就是同一个事实的第二个写入者 —— 而这正好是今天
    --   s.state["template"]（那一次的统计）与 s.dir 里那个被覆盖的 xlsx
    --   会对不上的原因。
    CONSTRAINT session_kv_key_ck CHECK (key IN (
        'corpus','routing','budget','audit','endpoints','profiles'))
);


-- ═══════════════════════════════════════════════════════════════════════════
--  8. 索引清单 —— 每条都写明服务哪个查询
-- ═══════════════════════════════════════════════════════════════════════════

-- Q1 列出某项目的全部会话，按更新时间倒序。
--    ORDER BY 与 WHERE 同在一个索引里，直接 index scan 取前 N，不排序。
--    （注意今天 list_sessions 按 -created 排，server.py:164 —— 需求要的是 updated。）
CREATE INDEX session_by_project_updated
    ON oc.session (project_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- Q2 打开会话。以下 8 处全部靠主键前缀 (session_id, ...) 做范围扫描，
--    额外只需要这两条：
--    · 按 kind 分组取实体（前端左侧树先渲染 ObjectType，再懒加载其余）
CREATE INDEX oir_entity_by_kind
    ON oc.oir_entity (session_id, kind, ord);
--    · 属性挂在哪个对象下（props_of，oir.py:383）
CREATE INDEX oir_entity_by_parent
    ON oc.oir_entity (session_id, parent_rid)
    WHERE parent_rid IS NOT NULL;

-- Q2 续：当前建议 / 待答问题 / 冲突都按 (session_id, rev) 前缀取，PK 已覆盖。
--    "还剩几个没答" = question 左连 decision：
CREATE INDEX decision_by_conflict
    ON oc.decision (session_id, conflict_rid)
    WHERE conflict_rid IS NOT NULL;
--    对话面板要的 active_decisions（dialogue.py:279）：
CREATE INDEX decision_active
    ON oc.decision (session_id, seq)
    WHERE superseded_by IS NULL;

-- Q3 恢复跑到一半的会话。
--    · 崩溃清扫器：找租约过期的孤儿 Run（今天 18 个 workspace 目录就是这么变孤儿的）
CREATE INDEX run_stale_lease
    ON oc.run (heartbeat_at)
    WHERE status IN ('running','suspended');
--    · 会话详情页要的"这个会话跑过几次"
CREATE INDEX run_by_session
    ON oc.run (session_id, started_at DESC);
--    · Recorder._load_history（recorder.py:63）按 seq 顺序全量读一个 Run 的事件：
--      PK (run_id, seq) 直接覆盖，**不再加 kind 索引** —— 实测单 Run 最多 404 条，
--      按 kind 过滤省下的 I/O 抵不过多一棵 B-tree 的写放大。

-- Q4 跨会话检索长期记忆。
--    · recall() 的候选池过滤：按项目 + kind，排除 superseded（long_term.py:190），
--      按 confidence 降序（它是 _score 的主导乘子）
CREATE INDEX memory_recall_pool
    ON oc.memory_item (project_id, kind, confidence DESC)
    WHERE NOT (tags @> ARRAY['superseded']);
--    · 词法召回。**用 trigram 而不是 to_tsvector**：默认分词器把一整串中文当
--      一个 token，而 _tok（long_term.py:28）是按**单字**切的 —— 单字切分让
--      "计划金额"和"金额计划"得分完全相同。trigram 是 3 字窗口，精度严格更好，
--      且零 API 调用、结果确定（重放不会因为 embedding 漂移而失败）。
CREATE INDEX memory_search_trgm
    ON oc.memory_item USING gin (search_doc gin_trgm_ops);
--    · 审计反查："这条长期记忆是从哪次对话来的"（support 里是 'dialogue:{run}:turn{n}'）
CREATE INDEX memory_by_support
    ON oc.memory_item USING gin (support);

-- Q5 审计：assertion → evidence locator → 原始事件。
--    正向（已知 rid）：oir_assertion / oir_evidence 的 PK 前缀直接命中，不需要索引。
--    以下四条是**反向**与**跨会话**的那几跳：
--    · "材料 X 改了，哪些断言受影响" / "这个文件贡献了多少条证据"
CREATE INDEX evidence_by_file
    ON oc.oir_evidence (file_id, session_id);
--    · 前端点某条 cite → 拉原文切片（join evidence_chunk）
CREATE INDEX evidence_by_cite
    ON oc.oir_evidence (session_id, cite);
CREATE INDEX evidence_chunk_by_cite
    ON oc.evidence_chunk (session_id, cite);
--    · 第三跳与它的反向："这次 LLM 调用产出了哪些断言"
--      （run_id + seq 一起进索引，因为 event 的 PK 就是这两列，join 才走 index-only）
CREATE INDEX assertion_by_event
    ON oc.oir_assertion (produced_by_run, produced_by_seq)
    WHERE produced_by_run IS NOT NULL;
CREATE INDEX evidence_by_event
    ON oc.oir_evidence (produced_by_run, produced_by_seq)
    WHERE produced_by_run IS NOT NULL;
--    · "人拍过哪些板 / 系统自动修了哪些" —— 1430 条断言里通常只有个位数，
--      部分索引小到能常驻内存
CREATE INDEX assertion_human_touched
    ON oc.oir_assertion (session_id, origin, updated_at DESC)
    WHERE origin IN ('user','auto_repaired');

-- 补：取代被删掉的 OIR.conflicts 字段 —— "这个对象上有哪些冲突"
CREATE INDEX conflict_by_subject
    ON oc.conflict USING gin (subjects);
-- 补：冲突面板按处置方式分栏（ask_user 要人拍板，hint 只提示）
CREATE INDEX conflict_by_handling
    ON oc.conflict (session_id, rev, handling);
-- 补：blob 引用计数清扫（session 删除后哪些 blob 没人引用了）
CREATE INDEX session_file_by_blob
    ON oc.session_file (content_ref);


-- ═══════════════════════════════════════════════════════════════════════════
--  9. 并发：乐观锁的两个原语
-- ═══════════════════════════════════════════════════════════════════════════

-- 所有改 OIR / decision 的事务都以这个函数开头。rev 不匹配 → 抛错 → 应用层 409。
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

-- SSE 序号分配。UPDATE 拿的行锁把同一会话的并发发射串行化 ——
-- 会话内的事件顺序必须是全序，这是 /stream?since=N 断线补发能对上号的前提。
--
-- NOTIFY 只带 (session_id, seq)：NOTIFY 的 payload 上限 8000 字节，
-- 而实测单条事件最大 235,702 B。订阅端收到通知后回表按 seq 拉。
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

-- 抢占一次 Run。悲观锁只用在这一处：重复起 Run 要真花一次钱。
-- 行锁 + 上面的 run_one_live_per_session 部分唯一索引双保险 ——
-- 前者防同事务窗口内的竞态，后者防任何绕过这个函数的调用方。
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


-- ═══════════════════════════════════════════════════════════════════════════
--  10. 五个必备查询的规范写法
-- ═══════════════════════════════════════════════════════════════════════════

-- Q1 列出某项目的全部会话，按更新时间倒序（走 session_by_project_updated）
CREATE OR REPLACE VIEW oc.v_session_brief AS
SELECT s.id, s.project_id, s.title, s.status, s.error, s.rev,
       s.created_at, s.updated_at,
       (SELECT count(*) FROM oc.session_file f WHERE f.session_id = s.id) AS files
  FROM oc.session s
 WHERE s.deleted_at IS NULL;
-- SELECT * FROM oc.v_session_brief WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 50;

-- Q3 恢复跑到一半的会话：找孤儿 Run（租约 90 秒）
CREATE OR REPLACE VIEW oc.v_orphan_run AS
SELECT r.id AS run_id, r.session_id, r.kind, r.status,
       r.usd_spent, r.heartbeat_at,
       (SELECT max(seq) FROM oc.event e WHERE e.run_id = r.id) AS last_seq,
       oc.run_next_seq(r.id) AS next_seq
  FROM oc.run r
 WHERE r.status IN ('running','suspended')
   AND r.heartbeat_at < now() - interval '90 seconds';
-- 拿到 run_id 后：Recorder(run_id, PgJournal(), PgBlobStore(), resume=True)
-- —— resume=True 今天在生产代码里从没被构造过（server.py:136、cli.py:183 都没传），
--    这是"重放"从死变活必须补的一行。

-- Q5 审计：一条断言 → 证据 locator → 原始事件。三跳一次查完。
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
      -- 第一跳：断言 → 证据
      LEFT JOIN oc.oir_evidence ev
             ON (ev.session_id, ev.rid, ev.field) = (a.session_id, a.rid, a.field)
      -- 第二跳：证据 → 材料与原文切片
      LEFT JOIN oc.session_file f
             ON (f.session_id, f.file_id) = (ev.session_id, ev.file_id)
      LEFT JOIN oc.evidence_chunk ch
             ON (ch.session_id, ch.cite) = (ev.session_id, ev.cite)
      -- 第三跳：证据 → 产生它的那条事件（哪次 LLM 调用、哪个节点、花了多少）
      LEFT JOIN oc.event e
             ON e.run_id = coalesce(ev.produced_by_run, a.produced_by_run)
            AND e.seq    = coalesce(ev.produced_by_seq, a.produced_by_seq)
     WHERE a.session_id = p_session AND a.rid = p_rid AND a.field = p_field
     ORDER BY ev.ord;
$$;

-- Q5 反向：某份材料被改了 / 被质疑，哪些断言站不住了（走 evidence_by_file）
CREATE OR REPLACE FUNCTION oc.assertions_from_file(p_file_id text)
RETURNS TABLE (session_id text, rid text, field text, origin text, cite text)
LANGUAGE sql STABLE AS $$
    SELECT a.session_id, a.rid, a.field, a.origin, ev.cite
      FROM oc.oir_evidence ev
      JOIN oc.oir_assertion a
        ON (a.session_id, a.rid, a.field) = (ev.session_id, ev.rid, ev.field)
     WHERE ev.file_id = p_file_id
       -- 人拍过的板不受材料变动影响：Origin.USER 是业务事实，不是从材料推的
       AND a.origin <> 'user';
$$;

-- Q4 长期记忆召回。**在 SQL 里只做候选集收窄**，最终排序留在 Python 的
--    LongTermStore._score（long_term.py:217）里 —— 打分公式含 heat/prior/预算裁剪，
--    在库里重写一遍就是第二份真相，两边一漂移就没人知道该信哪个。
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
