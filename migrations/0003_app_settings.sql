-- 0003_app_settings —— 全局应用设置（管理员可改的网关/预算配置）。
--
-- 键值对，value 是 jsonb（与 session_state 同一套形态）。**顶层**表，与建模
-- session 无关、不随其级联。与 store/schema.py 的 app_setting 逐字段对齐。
-- 已知键：gateway.base_url / gateway.api_key（只写不回显） /
--         gateway.model.{low,medium,high,critical} / budget.usd_cap /
--         budget.chat_usd_cap。

BEGIN;

CREATE TABLE app_setting (
    key        text        PRIMARY KEY,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
