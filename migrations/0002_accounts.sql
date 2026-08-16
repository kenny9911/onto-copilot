-- 0002_accounts —— 账号与登录会话（鉴权层）。
--
-- 两张**顶层**表，与建模 session 无关：数据共享（单管理员门禁，不按用户隔离），
-- 账号只用于登录与角色控制，所以没有 owner 外键、不挂在 session 之下。
-- 与 store/schema.py 的 app_user / auth_session 定义**逐字段对齐**（列名/类型/约束/索引），
-- 否则 test_ddl_matches_metadata（@pytest.mark.postgres）会检出漂移。
--
-- id / password_hash / token 都在 Python 里生成（uuid4 / scrypt / token_urlsafe），
-- 这里不用 gen_random_uuid / pgcrypto —— 同一份仓储代码还要在 SQLite 上跑。
--
-- prefs 列在**建表时**就带上：迁移一旦落库就按 checksum 锁死，外观子系统以后
-- 想再 ALTER 进来只能另开迁移，所以现在一次到位。

BEGIN;

CREATE TABLE app_user (
    id            text        PRIMARY KEY,                 -- uuid4().hex
    username      text        NOT NULL UNIQUE,             -- 调用方已 strip().lower()
    password_hash text        NOT NULL,                    -- scrypt 自描述串
    role          text        NOT NULL DEFAULT 'user',
    active        boolean     NOT NULL DEFAULT true,
    --: 外观/语言偏好（主题、强调色、时区、字号、语言）。checksum 锁定前一次到位。
    prefs         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_user_role_ck CHECK (role IN ('admin', 'user'))
);

-- 登录会话：主键是令牌的 sha256，不是令牌本身。过期行读时过滤 + 周期清理。
CREATE TABLE auth_session (
    token_hash   text        PRIMARY KEY,
    user_id      text        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

CREATE INDEX auth_session_user_idx ON auth_session (user_id);

-- 复用 0001 的 touch_updated_at() 触发器：app_user 改动时自动刷新 updated_at。
CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
