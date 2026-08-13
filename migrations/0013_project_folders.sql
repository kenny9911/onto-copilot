-- 0013_project_folders —— 项目文件夹 + 项目级分层记忆。
--
-- 侧栏里的「项目」到今天为止只是 session.project 那一列文本，而那列是**印在交付物
-- 上的客户项目名**（导出的 xlsx 表头、导出包的文件名都用它）。拿它当分组键，就等于
-- 改了它的语义 —— 改个分组名会把已经发出去的文档口径也一起改掉。所以另立一张
-- project 表，session 上加一列 project_id 指过去，两者井水不犯河水。
--
-- project_memory 是同一项目下的会话共享的结论，分两档：
--   authoritative —— 人拍板的约定，跨会话直接生效；
--   reference     —— 模型推断的教训，只作提示，永不晋升成权威。
-- 这一档之分是整个功能的地基（人的判断可以传递，机器的猜测只能提示），所以它是一列
-- 带 CHECK 的枚举，而不是靠 tags 里塞个字符串约定俗成。
--
-- 记忆不能挂在 session_state 上：那张表主键含 session_id、且随会话 ON DELETE CASCADE，
-- 删掉任意一个会话就把整个项目的记忆一起带走了。
--
-- 三处都不设外键（session.project_id → project、project_memory.project_id → project）：
--   * 与 0004 的 session.owner 同一条理由，删上级不连带删下级；
--   * 删项目的清理由仓储显式做（置空成员会话的 project_id、删该项目的记忆行），
--     不交给 CASCADE —— 同一份仓储代码还要在 SQLite 上跑，那边 PRAGMA foreign_keys
--     未必在每条路径上都开着，靠 CASCADE 会得到两种方言两种结果。
--
-- 与 store/schema.py 的 project / project_memory / session.project_id 逐字段对齐。

BEGIN;

CREATE TABLE project (
    id         text        PRIMARY KEY,
    name       text        NOT NULL,
    owner      text,
    prefs      jsonb       NOT NULL,
    sort_order integer     NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 按 owner 拉列表是唯一的常见查询（每个用户只看自己的项目），同 session_owner_idx。
CREATE INDEX project_owner_idx ON project (owner);

-- 可空、无默认 —— 存量会话自动为 NULL（未归类）。
ALTER TABLE session ADD COLUMN project_id text;

-- 侧栏每次渲染都要按项目分组取会话，这条索引是那次查询的全部依据。
CREATE INDEX session_project_idx ON session (project_id);

CREATE TABLE project_memory (
    project_id     text             NOT NULL,
    key            text             NOT NULL,
    tier           text             NOT NULL,
    kind           text             NOT NULL,
    content        text             NOT NULL,
    confidence     double precision NOT NULL,
    support        jsonb            NOT NULL,
    tags           jsonb            NOT NULL,
    origin_session text             NOT NULL DEFAULT '',
    origin_files   jsonb            NOT NULL,
    contested_by   jsonb            NOT NULL,
    hit_runs       jsonb            NOT NULL,
    use_count      integer          NOT NULL DEFAULT 0,
    created_run    text             NOT NULL DEFAULT '',
    last_used_run  text             NOT NULL DEFAULT '',
    updated_at     timestamptz      NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, key),
    CONSTRAINT project_memory_tier_ck CHECK (tier IN ('authoritative','reference'))
);

COMMIT;
