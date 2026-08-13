/**
 * server 段 D：流水线。移植自 `src/ontocopilot/server.py` 2030–4513。
 *
 * 这是整个产品的主干：材料进来、跑 DAG、出 OIR / 问题清单 / 流程图 / Excel。
 *
 * 实现拆在 `pipeline/` 下（都是本段自己的文件）：
 *
 * | 文件 | Python 对应 |
 * |---|---|
 * | `pipeline/types.ts`   | `Session` 的结构口径 + 取消原语 + 依赖端口 |
 * | `pipeline/run.ts`     | `_claim_and_start_build` `_on_run_cancelled` `_run_pipeline` |
 * | `pipeline/routes.ts`  | `POST /build` `POST /stop` |
 * | `pipeline/trace.ts`   | `_KERNEL_TRACE` `_pump_kernel_events` `_run_with_live_trace` `_trace_detail` |
 * | `pipeline/tables.ts`  | `_oir_val` `_oir_table` `_sheet_rows` `_material_table` `_full_rows_for` `_last_card_table` `_match_file` `_tables_in_text` `_conversation_tables` `_pick_table` `_last_table` |
 * | `pipeline/persist.ts` | `_PERSISTED*` `_push_version` `_persist` |
 *
 * **尚未移植的部分**（都在 2030–4513 里，依赖还没落地的 onto/kernel 模块）见
 * 本次交付的 divergences；它们以 {@link PipelineDeps} 的字段形态留在边界上，
 * 不是被悄悄删掉的。
 */

export * from "./pipeline/types.js";
export * from "./pipeline/persist.js";
export * from "./pipeline/tables.js";
export * from "./pipeline/trace.js";
export * from "./pipeline/run.js";
export * from "./pipeline/routes.js";
