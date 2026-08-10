-- 只装扩展，不建表。
--
-- 建表走迁移文件（src/ontocopilot/store/migrations/），因为初始化脚本**只在
-- 数据卷为空时跑一次** —— 把模式定义放这里，等于宣布"改模式必须删库"。
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- 名称模糊匹配（实体对齐的候选召回）
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
