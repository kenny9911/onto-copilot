-- 0009_chat_lease —— chat 跨 worker single-flight 与协作取消。
--
-- DialogueMemory/session_state 的聊天修改是 read-modify-write；只有进程内 Task 锁时，
-- 两个 worker 会同时读取同一快照并发生 last-writer-wins。每次 invocation 使用独有
-- owner token；过期才允许接管，取消意图会阻断原 owner 续租。

BEGIN;

CREATE TABLE chat_lease (
    session_id   text             PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
    owner        text             NOT NULL,
    acquired_at  double precision NOT NULL,
    heartbeat_at double precision NOT NULL,
    expires_at   double precision NOT NULL,
    cancel_requested_at double precision
);

CREATE INDEX chat_lease_expiry_idx ON chat_lease (expires_at);

COMMIT;
