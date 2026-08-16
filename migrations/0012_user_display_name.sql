-- 0012_user_display_name —— 给账号加一个人类可读的名字。
--
-- username 是 strip().lower() 之后的登录标识（见 auth.py），它不适合拿来称呼人：
-- 「欢迎回来，yuhancheng」和「欢迎回来，程宇涵」是两回事。所以另存一列**原样保留
-- 大小写与空格**的显示名，只用于展示，不参与任何唯一性判定。
--
-- NOT NULL DEFAULT '' 而不是 nullable：让"没填名字"在全栈只有空串一种表示，
-- 前端不必同时判 null 和 ''。存量行自动补 ''，展示时回落到 username。
--
-- 不加唯一约束（重名是合法的：两个「张伟」很正常），不加索引（永远不按它查）。

BEGIN;

ALTER TABLE app_user ADD COLUMN display_name text NOT NULL DEFAULT '';

COMMIT;
