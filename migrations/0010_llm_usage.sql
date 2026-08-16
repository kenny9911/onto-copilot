-- 0010_llm_usage —— 模型用量流水账：一次调用一行，跨会话、跨重启。
--
-- 现状是"每处都在记，但谁也答不上账"：ModelGateway 每次调用 spend 进一个
-- **每轮新建**的 Budget，快照落在 run.budget；session_state["budget"] 只是最后
-- 一次梳理的快照；聊天那份 _chat_usd 连持久化白名单都不在，重启即清零。三份都
-- 加不起来，于是"这个月烧了多少 token""哪个模型最贵"没有任何地方能回答。
--
-- 为什么不复用盘上的 journal jsonl：它按 run 散在各会话目录里、不带归属、
-- 会话 purge 会连目录一起 rmtree，而且**重放会重复记账**（Recorder 回放不真的
-- 调模型，旧代码却照样 spend 一次）。
--
-- 会话删了账还得在，所以 session_id 不设外键、不跟着 CASCADE；owner 与
-- session.owner 一样是裸 text（见 0004），写入时冗余存下来而不是 join 过去。
--
-- day 是**写入时算好存下来的**：date_trunc 只有 PG 有、strftime 只有 SQLite 有，
-- 用任何一个都会打破"两种方言走同一条代码路径"这条规矩。

BEGIN;

CREATE TABLE llm_usage (
    id          text             PRIMARY KEY,
    ts          double precision NOT NULL,
    day         text             NOT NULL,
    owner       text             NOT NULL DEFAULT '',
    session_id  text             NOT NULL DEFAULT '',
    run_id      text             NOT NULL DEFAULT '',
    node_id     text             NOT NULL DEFAULT '',
    kind        text             NOT NULL DEFAULT 'build',
    model       text             NOT NULL,
    effort      text             NOT NULL DEFAULT '',
    tok_in      bigint           NOT NULL DEFAULT 0,
    tok_out     bigint           NOT NULL DEFAULT 0,
    cache_read  bigint           NOT NULL DEFAULT 0,
    cache_write bigint           NOT NULL DEFAULT 0,
    usd         double precision NOT NULL DEFAULT 0,
    usd_source  text             NOT NULL DEFAULT 'estimated',
    attempts    integer          NOT NULL DEFAULT 1,
    status      text             NOT NULL DEFAULT 'ok',
    created_at  timestamptz      NOT NULL DEFAULT now(),
    CONSTRAINT llm_usage_kind_ck CHECK (kind IN ('build','chat','aux')),
    CONSTRAINT llm_usage_tokens_ck CHECK (
        tok_in >= 0 AND tok_out >= 0 AND cache_read >= 0 AND cache_write >= 0
    ),
    CONSTRAINT llm_usage_usd_ck CHECK (usd >= 0),
    CONSTRAINT llm_usage_attempts_ck CHECK (attempts >= 1),
    CONSTRAINT llm_usage_usd_source_ck CHECK (usd_source IN ('gateway','estimated')),
    CONSTRAINT llm_usage_status_ck CHECK (status IN ('ok','failed'))
);

CREATE INDEX llm_usage_owner_day_idx ON llm_usage (owner, day);
CREATE INDEX llm_usage_ts_idx        ON llm_usage (ts);
CREATE INDEX llm_usage_model_day_idx ON llm_usage (model, day);

COMMIT;
