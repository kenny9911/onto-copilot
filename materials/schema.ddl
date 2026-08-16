-- 采购中台物理模型
CREATE TABLE pbp_header (
  plan_id      VARCHAR(32) NOT NULL PRIMARY KEY,
  plan_name    VARCHAR(200),
  plan_amount  DECIMAL(18,2),   -- 含税·年度累计·CNY
  created_at   TIMESTAMP
);

CREATE TABLE clm_contract (
  contract_id  VARCHAR(32) NOT NULL PRIMARY KEY,
  plan_id      VARCHAR(32) NOT NULL,
  plan_amount  DECIMAL(18,2),   -- 不含税·单次·CNY
  CONSTRAINT fk_plan FOREIGN KEY (plan_id) REFERENCES pbp_header(plan_id)
);
