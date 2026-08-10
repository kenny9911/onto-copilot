\set ON_ERROR_STOP on
SET search_path = oc, public;

INSERT INTO oc.project (id, slug, name)
VALUES ('11111111-1111-1111-1111-111111111111', 'procure', '采购中台');
INSERT INTO oc.session (id, project_id, title)
VALUES ('0aa54a3fac05', '11111111-1111-1111-1111-111111111111', '采购中台 Ontology 梳理');

-- ── 1. claim_run：第二次必须拿不到 ────────────────────────────────
SELECT oc.claim_run('0aa54a3fac05','build','w1') IS NOT NULL AS t1_first_claim_ok;
SELECT oc.claim_run('0aa54a3fac05','build','w2') IS NULL     AS t2_second_claim_blocked;

-- ── 2. 部分唯一索引：绕过 claim_run 直接插也要被挡 ─────────────────
DO $$
BEGIN
    INSERT INTO oc.run (session_id, kind, status) VALUES ('0aa54a3fac05','build','running');
    RAISE EXCEPTION 't3_FAILED: 第二个活跃 build 竟然插进去了';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 't3_ok 部分唯一索引挡住了并发 build';
END $$;

-- ── 3. 事件日志 append-only ────────────────────────────────────────
INSERT INTO oc.blob (ref, body, size_bytes)
VALUES ('blob:3f2a0000000000000000000000000000', '\x7b7d'::bytea, 2);

INSERT INTO oc.event (run_id, seq, kind, node_id, payload, ts_ms)
SELECT id, 0, 'run.started', NULL, '{"dag":"onto"}'::jsonb, 1754500000000 FROM oc.run LIMIT 1;
INSERT INTO oc.event (run_id, seq, kind, node_id, payload, ref, ts_ms)
SELECT id, 1, 'effect.completed', 'EXTRACT.s0',
       '{"key":"EXTRACT.s0#0","kind":"llm.call","fp":"a1b2c3d4e5f60718"}'::jsonb,
       'blob:3f2a0000000000000000000000000000', 1754500001000 FROM oc.run LIMIT 1;
INSERT INTO oc.event (run_id, seq, kind, node_id, payload, ts_ms)
SELECT id, 2, 'budget.spent', 'EXTRACT.s0',
       '{"model":"anthropic/claude-opus-4.8","tok_in":12000,"tok_out":3000,"cache_read":40000,"usd":0.135,"level":0}'::jsonb,
       1754500002000 FROM oc.run LIMIT 1;

DO $$
BEGIN
    UPDATE oc.event SET payload = '{}'::jsonb WHERE seq = 0;
    RAISE EXCEPTION 't4_FAILED: 事件被改掉了';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 't4_ok UPDATE 被 append-only 触发器挡住';
END $$;
DO $$
BEGIN
    DELETE FROM oc.event WHERE seq = 0;
    RAISE EXCEPTION 't5_FAILED: 事件被删掉了';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 't5_ok DELETE 被 append-only 触发器挡住';
END $$;

-- ── 4. seq 分配与花费重建都从日志导出 ──────────────────────────────
SELECT oc.run_next_seq(id) = 3 AS t6_next_seq_from_log FROM oc.run LIMIT 1;
SELECT oc.rebuild_run_spend(id) FROM oc.run LIMIT 1;
SELECT usd_spent = 0.1350 AS t7_usd, tokens_spent = 55000 AS t8_tokens FROM oc.run;

-- ── 5. 乐观锁 ──────────────────────────────────────────────────────
SELECT oc.bump_rev('0aa54a3fac05', 0) = 1 AS t9_bump_ok;
DO $$
BEGIN
    PERFORM oc.bump_rev('0aa54a3fac05', 0);
    RAISE EXCEPTION 't10_FAILED: 陈旧 rev 竟然通过了';
EXCEPTION WHEN serialization_failure THEN
    RAISE NOTICE 't10_ok 陈旧 rev 被拒（40001，客户端可重试）';
END $$;

-- ── 6. SSE 序号单调 ────────────────────────────────────────────────
SELECT oc.emit_session_event('0aa54a3fac05','files.attached','{"files":["采购梳理表.xlsx"]}') = 1 AS t11;
SELECT oc.emit_session_event('0aa54a3fac05','plan.frozen','{"segments":12}') = 2 AS t12;

-- ── 7. OIR 三张行表 + 审计三跳 ─────────────────────────────────────
INSERT INTO oc.session_file (session_id, file_id, name, size_bytes, content_ref)
VALUES ('0aa54a3fac05','f_9c1a2b3d','采购梳理表.xlsx', 88112,
        'blob:3f2a0000000000000000000000000000');

INSERT INTO oc.oir_entity (session_id, rid, kind, status, member_rids)
VALUES ('0aa54a3fac05','ot_purchase_plan_header','ObjectType','confirmed',
        ARRAY['pt_plan_amount']);
INSERT INTO oc.oir_entity (session_id, rid, kind, parent_rid)
VALUES ('0aa54a3fac05','pt_plan_amount','PropertyType','ot_purchase_plan_header');

-- ★ value_domain 与 title_property 是 to_dict 丢掉的两个字段，行表存得下
INSERT INTO oc.oir_assertion (session_id, rid, field, value, origin, confidence,
                              produced_by_run, produced_by_seq)
SELECT '0aa54a3fac05','pt_plan_amount','value_domain','["含税","不含税"]'::jsonb,
       'extracted', 0.8, id, 1 FROM oc.run LIMIT 1;
INSERT INTO oc.oir_assertion (session_id, rid, field, value, origin, confidence)
VALUES ('0aa54a3fac05','ot_purchase_plan_header','title_property','"pt_plan_amount"'::jsonb,
        'inferred', 0.4);
-- semantic_type 的值是 JSON null —— 合法，不能被 NOT NULL 挡掉
INSERT INTO oc.oir_assertion (session_id, rid, field, value, origin)
VALUES ('0aa54a3fac05','pt_plan_amount','semantic_type','null'::jsonb, 'inferred');

INSERT INTO oc.oir_evidence (session_id, rid, field, ord, file_id, locator, cite,
                             snippet, extractor, confidence, produced_by_run, produced_by_seq)
SELECT '0aa54a3fac05','pt_plan_amount','value_domain', 0, 'f_9c1a2b3d',
       '{"kind":"cell","sheet":"计划头","row":14,"col":"F"}'::jsonb,
       '采购梳理表.xlsx!计划头!R14CF', '含税/不含税', 'llm', 0.8, id, 1
  FROM oc.run LIMIT 1;

INSERT INTO oc.evidence_chunk (session_id, ord, file_name, cite, body, tags)
VALUES ('0aa54a3fac05', 0, '采购梳理表.xlsx','采购梳理表.xlsx!计划头!R14CF',
        '计划金额｜DECIMAL｜口径：含税（增值税专用发票）', ARRAY['sheet:计划头']);

SELECT count(*) = 1 AS t13_trace_three_hops,
       max(event_kind) = 'effect.completed' AS t14_reached_llm_call,
       max(chunk_body) LIKE '%增值税专用发票%' AS t15_full_chunk_not_snippet
  FROM oc.trace_assertion('0aa54a3fac05','pt_plan_amount','value_domain');

-- 非法 field 必须被 CHECK 挡住
DO $$
BEGIN
    INSERT INTO oc.oir_assertion (session_id, rid, field, value, origin)
    VALUES ('0aa54a3fac05','pt_plan_amount','not_a_real_field','1'::jsonb,'inferred');
    RAISE EXCEPTION 't16_FAILED: 野字段进库了';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 't16_ok 未知 assertion 字段被 CHECK 挡住';
END $$;

-- ── 8. dlg_key 必须与 Python 的 Decision.key 逐字节一致 ─────────────
INSERT INTO oc.decision (session_id, seq, source, kind, statement, applied_at_rev)
VALUES ('0aa54a3fac05', 1, 'dialogue', 'caliber',
        '含税一律指增值税专用发票口径', 1);
SELECT dlg_key AS t17_dlg_key FROM oc.decision;

-- ── 9. 产物：重编译不覆盖，spec 与 xlsx 同版钉死 ────────────────────
INSERT INTO oc.blob (ref, ext_url, size_bytes) VALUES
  ('blob:aaaa0000000000000000000000000001','s3://oc/aa/xlsx-rev1', 41213),
  ('blob:aaaa0000000000000000000000000002','s3://oc/aa/spec-rev1', 118440),
  ('blob:aaaa0000000000000000000000000003','s3://oc/aa/xlsx-rev2', 41890);

INSERT INTO oc.artifact (session_id, kind, revision, oir_rev, filename, content_ref, media_type, stats)
VALUES
 ('0aa54a3fac05','template_xlsx',1,1,'模板_v1.xlsx','blob:aaaa0000000000000000000000000001',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '{"sheets":5,"prefilled":812,"business_required":37}'::jsonb),
 ('0aa54a3fac05','template_spec',1,1,'template.spec.json','blob:aaaa0000000000000000000000000002',
  'application/json','{"sheets":5}'::jsonb);

SELECT oc.mark_delivered(id) IS NOT NULL AS t18_delivered
  FROM oc.artifact WHERE kind='template_xlsx' AND revision=1;

-- 人拍板 → OIR 变了 → 重编译。旧的那一版必须还在。
SELECT oc.bump_rev('0aa54a3fac05', 1);
INSERT INTO oc.artifact (session_id, kind, revision, oir_rev, filename, content_ref, media_type, stats)
VALUES ('0aa54a3fac05','template_xlsx',2,2,'模板_v1.xlsx','blob:aaaa0000000000000000000000000003',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '{"sheets":5,"prefilled":840,"business_required":31}'::jsonb);

SELECT count(*) = 2 AS t19_both_revisions_survive
  FROM oc.artifact WHERE kind = 'template_xlsx';
SELECT revision = 2 AS t20_current_is_rev2
  FROM oc.v_artifact_current WHERE session_id='0aa54a3fac05' AND kind='template_xlsx';
-- 审回传用的是**发出去那一版**的 spec，不是当前版
SELECT revision = 1 AS t21_audit_basis_is_delivered_rev, oir_rev = 1 AS t22_pinned
  FROM oc.v_audit_basis WHERE delivered_at IS NOT NULL;

-- ── 10. blob 只能有一个家 ──────────────────────────────────────────
DO $$
BEGIN
    INSERT INTO oc.blob (ref, body, ext_url, size_bytes)
    VALUES ('blob:bbbb0000000000000000000000000000','\x00'::bytea,'s3://x',1);
    RAISE EXCEPTION 't23_FAILED: blob 同时内联又外链';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 't23_ok blob 只能有一个家';
END $$;

-- ── 11. 长期记忆晋升闸门进了 DB ────────────────────────────────────
DO $$
BEGIN
    INSERT INTO oc.memory_item (project_id, key, kind, scope, content, support)
    VALUES ('11111111-1111-1111-1111-111111111111','convention:header_suffix',
            'convention','project','头表统一用 Header 后缀', '{}');
    RAISE EXCEPTION 't24_FAILED: 无 support 的记忆晋升到了 project 域';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 't24_ok 无 support 不许晋升（PromotionGate.require_support 进了 DB）';
END $$;
INSERT INTO oc.memory_item (project_id, key, kind, scope, content, support, tags)
VALUES ('11111111-1111-1111-1111-111111111111','convention:header_suffix',
        'convention','project','头表统一用 Header 后缀',
        ARRAY['dialogue:run_0aa54a3fac05:turn3'], ARRAY['dialogue','naming']);
SELECT search_doc = '头表统一用 Header 后缀 dialogue naming' AS t25_search_doc
  FROM oc.memory_item;

-- ── 12. 发出去之后连文件名都不许改 ─────────────────────────────────
DO $$
BEGIN
    UPDATE oc.artifact SET filename = '模板_v2.xlsx'
     WHERE kind='template_xlsx' AND revision=1;
    RAISE EXCEPTION 't26_FAILED: 已交付的产物被改了';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 't26_ok 已交付产物被冻结';
END $$;
-- 未交付的也不许改内容（只有 delivered_at 这一列可以从 NULL 单向置）
DO $$
BEGIN
    UPDATE oc.artifact SET content_ref = 'blob:aaaa0000000000000000000000000001'
     WHERE kind='template_xlsx' AND revision=2;
    RAISE EXCEPTION 't27_FAILED: 产物内容被换掉了';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 't27_ok 产物内容不可变，换版本要新开一行';
END $$;
DO $$
BEGIN
    DELETE FROM oc.artifact WHERE revision = 2;
    RAISE EXCEPTION 't28_FAILED: 产物被删了';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 't28_ok 产物不可删';
END $$;
