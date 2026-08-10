-- initdb 脚本**只在数据卷为空时跑一次**。
-- 所以这里只放"库和角色"级别、一辈子不会变的东西：扩展、时区、默认权限。
-- 表结构一律走 migrations/ —— 用 initdb 建表的话，第二个迁移上线时
-- 老开发机（卷里已有数据、initdb 不再跑）和 CI（每次全新卷）会走上两条不同的路。

-- 内容寻址的 ref 是 sha256 前 32 位，用 pgcrypto 在库里核对方便排障。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 会话/对象名的模糊搜索（"哪个会话里有 clmContract"）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER DATABASE ontocopilot SET timezone TO 'UTC';

-- 应用连库用的角色。开发机上和 superuser 同名图省事，
-- 生产上这里要拆成只有 DML 权限的 app 角色 + 只在迁移时用的 owner 角色。
ALTER ROLE onto SET search_path TO public;
