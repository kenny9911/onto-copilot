/**
 * 对话推理的运行上下文。移植自 `server.py:_ChatCtx`。
 */

import type { ToolCallCtx, ToolRecorder } from "../../kernel/tools.js";

/**
 * 对话推理的运行上下文。
 *
 * ``rec`` **必须给**。没有它，``ToolRegistry.call`` 的 EFFECT_REQUESTED 记账
 * 直接跳过（tools.ts 里 `rec === null` 就不 emit）—— 改产物的工具调用一条都
 * 不进事件日志。实测过：chat_*.jsonl 里 grep ``tool.call`` 零命中。
 * 进程一重启，"哪一轮、凭什么把这 17 个对象标成 REJECTED"就永久查不到了，
 * 这和事件日志 append-only、审计可追的前提直接矛盾。
 */
export class ChatCtx implements ToolCallCtx {
  readonly turnId: string;
  readonly rec: ToolRecorder | null;
  readonly bus: unknown;
  /** 用户是否已经批准了这一轮里的高危动作。由 /chat 的 confirm 参数置上，
   * 不是默认放行。 */
  readonly approved: boolean;
  /** 被闸门拒绝的高危动作会追加到这里，供确认时**直接重放**（而不是重新推理）。 */
  readonly pending: { tool: string; args: Record<string, unknown> }[];

  constructor(p: {
    turnId: string;
    rec?: ToolRecorder | null;
    bus?: unknown;
    approved?: boolean;
    pending?: { tool: string; args: Record<string, unknown> }[];
  }) {
    this.turnId = p.turnId;
    this.rec = p.rec ?? null;
    this.bus = p.bus ?? null;
    this.approved = p.approved ?? false;
    // 每次新数组，别共享引用（迁移约定：`field(default_factory=list)`）。
    this.pending = p.pending ?? [];
  }
}
