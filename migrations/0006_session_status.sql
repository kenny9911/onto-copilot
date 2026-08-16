-- 0006_session_status —— queued/stopped 是 HTTP 状态机中的真实状态。
-- 0001 的约束漏掉它们，导致“开始任务占位”和“用户停止”无法持久化。
-- 历史迁移受 checksum 保护，不能回改 0001；已有库和新库都通过本前向迁移升级。

BEGIN;

ALTER TABLE session DROP CONSTRAINT IF EXISTS session_status_ck;
ALTER TABLE session ADD CONSTRAINT session_status_ck CHECK (status IN (
    'idle', 'queued', 'parsing', 'extracting', 'awaiting_answer', 'done', 'failed',
    'stopped'
));

COMMIT;
