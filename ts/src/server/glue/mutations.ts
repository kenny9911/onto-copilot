/**
 * durable mutation queue —— 跑中排队的对话编辑（第 3 层）。
 *
 * 此前梳理进行中一切写操作直接拒绝，且明确「不能声称已排队」（dialogue.ts 的
 * 注释）：因为根本没有队列，谎称排队会让 FDE 以为改动会自动生效。现在队列
 * 真实存在：入队落在 `_mutation_queue`（PERSISTED_PRIVATE_DOCS —— chat 侧拥有、
 * 与 build checkpoint 走 CAS 合并的那一组），Run 正常收尾后按序应用。
 *
 * 三条纪律：
 *  · **应用镜像活编辑的全套动作**：versions 栈（可撤销）+ 补丁日志（下一轮重建
 *    重放）——不是旁路，是同一条路晚点走；
 *  · **对不上的显式报 stale**（结构变了/名字没了），绝不静默丢 —— 与
 *    replayFlowPatches 的 stale 纪律同款；
 *  · **尽力而为**：单条失败不拖累其余，drain 整体绝不让 Run 收尾失败。
 */

import { FlowGraph } from "../../onto/flow.js";
import { OIR } from "../../onto/oir.js";
import { FlowEditError, applyFlowEdit } from "../../onto/flow_edit.js";
import { OIREditError, applyOirEdit, findObject } from "../../onto/oir_edit.js";
import { autoBindObjects } from "../../onto/flow_link.js";
import { pushVersion } from "../pipeline/persist.js";
import { rewriteFlowArtifacts } from "./flow.js";
import { pyJsonIndent } from "../dialogue/pyutil.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** 队列条目。args 原样保存 —— 应用时用当时的产物状态解析，不提前绑定 rid。 */
export interface QueuedMutation {
  readonly tool: "flow" | "oir";
  readonly op: string;
  readonly args: Record<string, unknown>;
  readonly source: "user" | "generic_assumption";
}

/** drain 需要的最小会话形状（run.ts 的 Session 与测试假件都满足）。 */
export interface MutationSession {
  readonly id: string;
  readonly dir: string;
  readonly state: Record<string, unknown>;
  emit(kind: string, payload?: Record<string, unknown>): unknown;
}

function queueOf(s: MutationSession): Record<string, unknown>[] {
  const raw = s.state["_mutation_queue"];
  if (!Array.isArray(raw)) {
    const fresh: Record<string, unknown>[] = [];
    s.state["_mutation_queue"] = fresh;
    return fresh;
  }
  return raw as Record<string, unknown>[];
}

/** 入队，返回排到第几位（给回执用）。 */
export function enqueueMutation(s: MutationSession, m: QueuedMutation): number {
  const q = queueOf(s);
  q.push({ tool: m.tool, op: m.op, args: { ...m.args }, source: m.source });
  return q.length;
}

function ensureList(s: MutationSession, key: string): unknown[] {
  const raw = s.state[key];
  if (Array.isArray(raw)) return raw;
  const fresh: unknown[] = [];
  s.state[key] = fresh;
  return fresh;
}

export interface DrainDeps {
  /** 图变了之后全部产物一把重出。测试注 noop；默认真身（glue/flow.ts）。 */
  readonly rewriteFlow?: (s: MutationSession, g: FlowGraph) => void;
  /** OIR 变了之后写 oir.json + 刷状态。测试注 noop。 */
  readonly persistOir?: (s: MutationSession, oir: OIR) => void;
}

export interface DrainResult {
  readonly applied: { tool: string; op: string; note: string }[];
  readonly stale: { tool: string; op: string; why: string }[];
}

/**
 * 按序应用队列并清空。**只该在 Run 正常收尾后调**（compile 之后）：那时产物
 * 是新一轮的，编辑落在最终状态上 —— 这与活编辑「不许在跑中改（会被覆盖）」
 * 是同一个判断的两半。
 */
export function drainMutationQueue(s: MutationSession, deps: DrainDeps = {}): DrainResult {
  const q = queueOf(s);
  if (q.length === 0) return { applied: [], stale: [] };
  const rewriteFlow = deps.rewriteFlow ?? ((ss, g) => rewriteFlowArtifacts(ss as never, g));
  const persistOir =
    deps.persistOir ??
    ((ss, oir) => {
      ss.state["oir"] = oir.toDict();
      writeFileSync(join(ss.dir, "oir.json"), pyJsonIndent(oir.toDict(), 1), "utf8");
    });

  const applied: DrainResult["applied"] = [];
  const stale: DrainResult["stale"] = [];
  let flowTouched = false;
  let oirTouched = false;

  for (const raw of q) {
    const tool = String(raw["tool"] ?? "");
    const op = String(raw["op"] ?? "");
    const args = (raw["args"] ?? {}) as Record<string, unknown>;
    const source = raw["source"] === "generic_assumption" ? "generic_assumption" : "user";
    try {
      if (tool === "flow") {
        const g = s.state["_flow"];
        if (!(g instanceof FlowGraph)) throw new FlowEditError("这一轮没有流程图，编辑无处应用。");
        const oir = s.state["_oir"];
        const versions = pushVersion(s as never, "_flow_versions", g.toDict());
        const patch = ensureList(s, "_flow_patch_log");
        patch.push({ op, args, ...(source === "generic_assumption" ? { source } : {}) });
        let note: string;
        try {
          note = applyFlowEdit(g, op, args, {
            source,
            resolveObject: (name) => {
              if (!(oir instanceof OIR)) return "";
              try {
                return findObject(oir, name).rid;
              } catch {
                return "";
              }
            },
            autoBind: () => (oir instanceof OIR ? autoBindObjects(g, oir) : 0),
          });
        } catch (exc) {
          versions.pop();
          patch.pop();
          throw exc;
        }
        flowTouched = true;
        applied.push({ tool, op, note });
      } else if (tool === "oir") {
        const oir = s.state["_oir"];
        if (!(oir instanceof OIR)) throw new OIREditError("这一轮没有 OIR，编辑无处应用。");
        const versions = pushVersion(s as never, "_oir_versions", oir.toDict());
        const patched = ensureList(s, "_oir_version_patched");
        patched.push(true);
        const patch = ensureList(s, "_oir_patch_log");
        patch.push({ op, args, ...(source === "generic_assumption" ? { source } : {}) });
        let note: string;
        try {
          note = applyOirEdit(oir, op, args, { source });
        } catch (exc) {
          versions.pop();
          patched.pop();
          patch.pop();
          throw exc;
        }
        oirTouched = true;
        applied.push({ tool, op, note });
      } else {
        throw new Error(`未知的排队工具「${tool}」`);
      }
    } catch (exc) {
      // 单条失败 → stale，继续下一条。为什么不整批拒：入队的人已经离场，
      // 半批能落的落上比全丢强 —— 与编辑工具的原子性相反，理由是场景相反。
      const why =
        exc instanceof FlowEditError || exc instanceof OIREditError
          ? exc.message
          : `${(exc as Error)?.name ?? "Error"}: ${(exc as Error)?.message ?? String(exc)}`;
      stale.push({ tool, op, why });
    }
  }

  const g = s.state["_flow"];
  if (flowTouched && g instanceof FlowGraph) rewriteFlow(s, g);
  const oir = s.state["_oir"];
  if (oirTouched && oir instanceof OIR) persistOir(s, oir);

  s.state["_mutation_queue"] = [];
  s.emit("mutations.applied", {
    applied: applied.length,
    ...(stale.length > 0 ? { stale: stale.map((x) => ({ op: x.op, why: x.why })) } : {}),
    notes: applied.map((a) => a.note).slice(0, 12),
  });
  return { applied, stale };
}
