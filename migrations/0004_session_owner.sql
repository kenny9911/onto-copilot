-- 0004_session_owner —— 会话按账号隔离。
--
-- 给 session 加一列 owner（app_user.id）。NULL = 无归属：迁移前的旧会话、以及开放
-- 模式创建的会话都是 NULL，在强制鉴权下对所有人隐藏（只看得到 owner = 自己 的会话）。
-- 不加外键：删账号不连带删会话，也不与 app_user 生命周期耦合。
--
-- 与 store/schema.py 的 session.owner 对齐。可空、无默认 —— 存量行自动为 NULL。

BEGIN;

ALTER TABLE session ADD COLUMN owner text;

-- 按 owner 拉列表是最常见的查询（每个用户只看自己的），建个索引。
CREATE INDEX session_owner_idx ON session (owner);

COMMIT;
