-- 0008_build_lease —— 多 worker build 的耐久所有权与失效时间。
--
-- asyncio.Task 只能由创建它的 worker 取消；会话状态本身不能证明那个 worker
-- 是否还活着。lease 让启动对账/冷恢复只回收真正过期的任务，而不是把另一个
-- 健康 worker 正在执行的 queued/parsing/extracting 误标为 failed。

BEGIN;

CREATE TABLE build_lease (
    session_id   text             PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
    owner        text             NOT NULL,
    acquired_at  double precision NOT NULL,
    heartbeat_at double precision NOT NULL,
    expires_at   double precision NOT NULL,
    cancel_requested_at double precision
);

CREATE INDEX build_lease_expiry_idx ON build_lease (expires_at);

COMMIT;
