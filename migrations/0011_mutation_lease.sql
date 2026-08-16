-- 0011_mutation_lease —— 会话级领域修改租约。
--
-- Question/Decision、回传审计与对话结构编辑都是跨多张表、文件和
-- session_state 的 read/modify/write。这张表先关闭跨 worker 竞争窗口；build
-- claim 与 mutation claim 在同一事务中互斥。

BEGIN;

CREATE TABLE mutation_lease (
    session_id   text             PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
    owner        text             NOT NULL,
    kind         text             NOT NULL,
    acquired_at  double precision NOT NULL,
    heartbeat_at double precision NOT NULL,
    expires_at   double precision NOT NULL
);

CREATE INDEX mutation_lease_expiry_idx ON mutation_lease (expires_at);

COMMIT;
