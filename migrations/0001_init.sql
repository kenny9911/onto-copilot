-- 0001_init —— OntoCopilot 持久化基线。
--
-- 设计原则：**每个事实只有一处真相**。
--   * 活对象（OIR / Conflict / DialogueMemory）的唯一落点是 session_state / conflict /
--     decision 三张表，每次 mutation 在**同一个事务**里整体推进 state_version。
--     现在内存里 s.state["oir"]（快照）与 s.state["_oir"]（活对象）会漂移
--     （_compile 写 oir.json 却不刷 s.state["oir"]，server.py:452 vs 466），
--     这个 schema 不给漂移留位置：读的人只能读到同一个 version 下的一致快照。
--   * 冲突从 OIR 文档里拆出来单独建表。detect_all 会往 ObjectType.conflicts /
--     PropertyType.conflicts 里**只加不减**地追加 rid（conflict.py:580-584），
--     留在 OIR 文档里会让每次快照 diff 都显示"有变化"。
--   * 人拍的板（decision）append-only，永不删除、永不被 recompile 覆盖。
--     模型跑出来的可以花钱重跑，人拍的板重跑不出来。
--
-- Postgres 15+（用到 gen_random_uuid 不必装 pgcrypto、以及 jsonb 与部分唯一索引）。

BEGIN;

CREATE TABLE schema_migration (
    version    integer     PRIMARY KEY,
    name       text        NOT NULL,
    checksum   text        NOT NULL,     -- 文件 sha256，改历史迁移会被检出
    applied_at timestamptz NOT NULL DEFAULT now()
);


-- ══════════════════════════════════════════════════════════════════
--  会话
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE session (
    id            text        PRIMARY KEY,          -- uuid4().hex[:12]，server.py:170
    title         text        NOT NULL DEFAULT '新建会话',
    project       text        NOT NULL DEFAULT '',
    status        text        NOT NULL DEFAULT 'idle',
    error         text        NOT NULL DEFAULT '',
    --: 整份会话状态的单调版本号。所有 session_state / conflict 的写入都带上写入时
    --  的 version，读的人可以校验自己拿到的是同一代的数据。
    state_version bigint      NOT NULL DEFAULT 0,
    --: 下一条 SSE 事件的 seq。现在是 len(self.events)（server.py:109），多 worker 下
    --  必然重号 —— 挪到这里靠行锁发号。
    next_event_seq bigint     NOT NULL DEFAULT 0,
    next_run_ordinal integer  NOT NULL DEFAULT 0,
    --: decision.ordinal 的发号器。必须是计数器而不是 MAX(ordinal)+1 ——
    --  `SELECT max(...) ... FOR UPDATE` 在 Postgres 上直接报
    --  "FOR UPDATE is not allowed with aggregate functions"，而不加锁就会重号。
    next_decision_ordinal integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT session_status_ck CHECK (status IN (
        'idle', 'parsing', 'extracting', 'awaiting_answer', 'done', 'failed'))
);

CREATE INDEX session_created_idx ON session (created_at DESC);


CREATE TABLE session_file (
    session_id  text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    --: **相对 workspace/<session_id>/ 的路径**，不是绝对路径。
    --  现在 files[i]["path"] 存的是 str(dest) 绝对路径（server.py:187），换机器/
    --  换容器即失效；WORKSPACE_ROOT 在读的时候拼回去。
    rel_path    text        NOT NULL,
    size_bytes  bigint      NOT NULL,
    sha256      text        NOT NULL DEFAULT '',
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, name)
);


-- ══════════════════════════════════════════════════════════════════
--  Run
-- ══════════════════════════════════════════════════════════════════
-- 现在 run_id = f"run_{s.id}"（server.py:271），是**会话 id 不是 run id**：
-- 同一会话第二次 build 会往同一个 journal 里追加一批从 0 重新开始的 seq
-- （Recorder._seq 每次新建都归零，recorder.py:49）。kernel_event 上的
-- (run_id, seq) 唯一约束会让第二次 build 直接插入失败 —— 所以 run 必须先独立成行。
CREATE TABLE run (
    id         text        PRIMARY KEY,        -- f"{session_id}.{ordinal}" 或 chat_<hex>
    session_id text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    ordinal    integer     NOT NULL,
    kind       text        NOT NULL,           -- build | chat | recompile
    status     text        NOT NULL DEFAULT 'running',
    --: Budget.snapshot()（budget.py:138）。Budget 本身没有反序列化路径，
    --  存这份快照只为审计与"上一轮花了多少"，不用于重建 Budget 对象。
    budget     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    error      text        NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at   timestamptz,
    UNIQUE (session_id, ordinal),
    CONSTRAINT run_status_ck CHECK (status IN ('running', 'suspended', 'done', 'failed'))
);

CREATE INDEX run_session_idx ON run (session_id, ordinal DESC);


-- ══════════════════════════════════════════════════════════════════
--  会话状态（文档区）
-- ══════════════════════════════════════════════════════════════════
-- 一个 key 一行，当前值语义（不留历史 —— 历史在 kernel_event 里）。
-- 已知的 key 与实测体量：
--   oir             802 KB（230 对象 / 111 行动 / 22 规则）    | 真相，必须存
--   questions       ≤3 条 / ~7 KB                              | 真相，必须存
--   suggestions     ≤8 条 / ~12 KB                             | 真相，必须存
--   routing         ~190 B                                     | 派生自 clarify
--   budget          ~258 B                                     | 派生
--   corpus          ~1.7 KB                                    | 派生
--   template        ~129 B（spec.stats()）                     | 派生
--   audit           ~3.4 KB                                    | 真相（回传审计结论）
--   dialogue        DialogueMemory.to_dict()                   | 真相，必须存
--   _chunks         312 KB（477 切片）                         | 派生但**重建要花钱**
--   _profiles       98 KB（43 key）                            | 派生，重建便宜
--   _endpoints      <1 KB                                      | 派生，重建便宜
-- derived=true 的行是"丢了能重算"的，恢复时可以跳过；_chunks 例外，标 false ——
-- 扫描件重新解析要再调一次视觉模型，而且 OCR 结果可能与抽取时不同，
-- 那样"点回原文"看到的就不是系统当初读到的东西（server.py:840-844 的注释）。
CREATE TABLE session_state (
    session_id text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    key        text        NOT NULL,
    doc        jsonb       NOT NULL,
    version    bigint      NOT NULL,      -- 写入时的 session.state_version
    derived    boolean     NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, key)
);


-- ══════════════════════════════════════════════════════════════════
--  冲突
-- ══════════════════════════════════════════════════════════════════
-- 实测 464 条 / 235 KB（8a629b219808）。answer 路由要按 rid 查
-- （server.py:483 `next(c for c in conflicts if c.rid == ...)`），所以建表而不是塞文档。
-- 每次 _recompile 整代替换：DELETE + INSERT 在同一事务里，version 一起推进。
-- **已答的板不在这里** —— 在 decision 表，所以整代替换不会抹掉人的决定。
CREATE TABLE conflict (
    session_id text    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    rid        text    NOT NULL,                        -- cf_<kind>_<10 hex>
    kind       text    NOT NULL,                        -- ConflictKind
    --: 派生字段（Conflict.handling ← POLICY[kind]，conflict.py:113）。
    --  冗余存一份只为按 handling 过滤，反序列化时**不读它**，仍从 POLICY 反查。
    handling   text    NOT NULL,
    summary    text    NOT NULL DEFAULT '',
    subjects   jsonb   NOT NULL DEFAULT '[]'::jsonb,
    detector   text    NOT NULL DEFAULT 'rule',
    owner      text,
    doc        jsonb   NOT NULL,                         -- Conflict.to_dict() 全量
    --: 这条冲突被澄清引擎选中问人了吗、排第几。ClarificationEngine 只问 ≤3 个。
    asked      boolean NOT NULL DEFAULT false,
    ask_rank   integer,
    version    bigint  NOT NULL,
    PRIMARY KEY (session_id, rid),
    CONSTRAINT conflict_handling_ck CHECK (handling IN
        ('ask_user', 'auto_repair', 'round_trip', 'hint'))
);

CREATE INDEX conflict_ask_idx ON conflict (session_id, ask_rank) WHERE asked;
CREATE INDEX conflict_kind_idx ON conflict (session_id, kind);


-- ══════════════════════════════════════════════════════════════════
--  人的决定 —— 这张表是整份 schema 里最重要的一张
-- ══════════════════════════════════════════════════════════════════
-- append-only。ordinal 是**会话内的序号**，等于 DialogueMemory._decisions 的下标，
-- superseded_by 直接就是那个下标（dialogue.py:208 `old.superseded_by = idx`），
-- 这样 DialogueMemory.from_dict（dialogue.py:305，已写好但生产代码零调用）
-- 能原样读回，不必另造一层 id 映射。
CREATE TABLE decision (
    session_id    text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    ordinal       integer     NOT NULL,
    kind          text        NOT NULL,       -- DecisionKind
    statement     text        NOT NULL DEFAULT '',
    scope_refs    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    turn_index    integer     NOT NULL DEFAULT -1,
    superseded_by integer,                    -- → 同会话内另一条的 ordinal
    --: ANSWER 专用：拍的是哪条冲突、选的哪个选项、apply_decision 实际改了什么。
    --  apply_decision（clarify.py）返回的 changed 列表现在只 emit 成一条 SSE
    --  就丢了（server.py:487）—— 这是"快照+增量"里增量部分唯一的落点。
    target_rid    text        NOT NULL DEFAULT '',
    option_id     text        NOT NULL DEFAULT '',
    changed       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    note          text        NOT NULL DEFAULT '',
    actor         text        NOT NULL DEFAULT 'user',
    ts            double precision NOT NULL DEFAULT extract(epoch from now()),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, ordinal),
    CONSTRAINT decision_kind_ck CHECK (kind IN
        ('caliber', 'naming', 'scope', 'answer', 'adoption', 'correction')),
    CONSTRAINT decision_supersede_ck CHECK (superseded_by IS NULL OR superseded_by <> ordinal)
);

-- 一条冲突同时只能有一个生效的答复 —— 让 POST /answer 天然幂等，
-- 并且取代内存里的 s.state["answered"]（server.py:490-492）。
CREATE UNIQUE INDEX decision_live_answer_uq ON decision (session_id, target_rid)
    WHERE kind = 'answer' AND superseded_by IS NULL;

CREATE INDEX decision_active_idx ON decision (session_id, kind)
    WHERE superseded_by IS NULL;


-- ══════════════════════════════════════════════════════════════════
--  对话轮次
-- ══════════════════════════════════════════════════════════════════
-- Utterance.to_dict()（dialogue.py:68）逐条落行，而不是把 DialogueMemory 整份
-- 塞进 session_state —— 压缩（compact_to_fit）会**改写已有轮次的 text**，
-- 逐行存才能看出哪些被压过。
CREATE TABLE chat_turn (
    session_id text             NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    ordinal    integer          NOT NULL,
    speaker    text             NOT NULL,      -- user | assistant | system
    text       text             NOT NULL,
    intent     text             NOT NULL DEFAULT '',
    refs       jsonb            NOT NULL DEFAULT '[]'::jsonb,
    compressed boolean          NOT NULL DEFAULT false,
    ts         double precision NOT NULL DEFAULT extract(epoch from now()),
    PRIMARY KEY (session_id, ordinal)
);


-- ══════════════════════════════════════════════════════════════════
--  前端事件流
-- ══════════════════════════════════════════════════════════════════
-- Session.events（server.py:94）现在在磁盘上**没有任何副本**，实测 250-300 KB/会话
-- 且永不裁剪。它是 SSE 断线重连 `?since=` 的唯一数据源（server.py:228）。
-- payload 超过 INLINE_LIMIT 落 blob，事件里只留 ref —— 单条
-- `node.completed node=CONFLICT` 实测 235 KB，而那份内容在 conflict 表里已经有了。
CREATE TABLE session_event (
    session_id text        NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    seq        bigint      NOT NULL,
    kind       text        NOT NULL,
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ref        text,
    ts         double precision NOT NULL,
    PRIMARY KEY (session_id, seq)
);

-- 多 worker 下 Session.subscribers（list[asyncio.Queue]，绑死在创建它的 event loop）
-- 完全不可迁移。这个触发器让每个 worker 的 SSE 协程 LISTEN 一个通道就能收到
-- 别的 worker 写入的事件。payload 只带 (session_id, seq) —— NOTIFY 载荷上限 8000 B，
-- 而单条事件能到 235 KB，必须让订阅方回表取。
CREATE FUNCTION notify_session_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('session_event', NEW.session_id || ':' || NEW.seq::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_event_notify
    AFTER INSERT ON session_event
    FOR EACH ROW EXECUTE FUNCTION notify_session_event();


-- ══════════════════════════════════════════════════════════════════
--  内核事件日志与 blob
-- ══════════════════════════════════════════════════════════════════
-- Journal / BlobStore 的接口（journal.py:95-108、25-38）保持不变。
-- (run_id, seq) 唯一 —— 这正是 Recorder._lock（asyncio.Lock，绑 loop）与
-- FileJournal._lock（threading.Lock，只在进程内有效）在多 worker 下失效之后，
-- 事件顺序唯一的保障。
-- 注意 run_id 上的外键：对话侧现在自己造 id（server.py:564
-- `run_id = f"chat_{uuid.uuid4().hex[:10]}"`），那个 id 在 run 表里没有行，
-- 会直接违反外键。搬库时 _reason 必须改成走 repo.next_run(sid, "chat")。
CREATE TABLE kernel_event (
    run_id  text   NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq     bigint NOT NULL,
    kind    text   NOT NULL,                          -- EventKind
    node_id text,
    payload jsonb  NOT NULL DEFAULT '{}'::jsonb,
    ref     text,                                     -- content_ref → blob.ref
    ts_ms   bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, seq)
);

-- _pump_kernel_events（server.py:414）按 (run_id, seq >= 位点) 扫，
-- 主键索引 (run_id, seq) 本身就是这个范围扫描 —— **不再额外建索引**。
-- 它只投影 _KERNEL_TRACE 里那 9 种 kind，但那是 404 行里的过滤，
-- 加个 kind 索引省不下什么，反倒让每次 append 多维护一棵树。


-- 内容寻址，ref = content_ref() = 'blob:' || 32 位十六进制（ids.py:30）。
-- 实测全会话合计 2.7 MB / 最大单个 143 KB —— bytea 足够，不必上对象存储。
-- 同内容写多次只占一份，天然幂等（journal.py:26），所以 put 是 ON CONFLICT DO NOTHING。
CREATE TABLE blob (
    ref        text        PRIMARY KEY,
    data       bytea       NOT NULL,
    size_bytes integer     NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT blob_ref_ck CHECK (ref ~ '^blob:[0-9a-f]{32}$')
);


-- ══════════════════════════════════════════════════════════════════
--  updated_at
-- ══════════════════════════════════════════════════════════════════
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_touch BEFORE UPDATE ON session
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER session_state_touch BEFORE UPDATE ON session_state
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
