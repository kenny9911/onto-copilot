-- 0007_session_event_idempotency —— durable event producer retry identity。
-- append 的事务可能已经提交，而应用在收到回执前退出；event_id 让重试返回原行，
-- 不会生成第二条语义相同但 seq 不同的审计事件。

BEGIN;

ALTER TABLE session_event ADD COLUMN event_id text;
CREATE UNIQUE INDEX session_event_event_id_uq
    ON session_event (event_id) WHERE event_id IS NOT NULL;

COMMIT;
