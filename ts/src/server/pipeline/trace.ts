/**
 * 内核事件 → 会话事件流的投影 —— `server.py` 2607–2670。
 *
 * **推理轨迹是事件日志的投影，不是另一套埋点。** 两套埋点必然漂移，漂移那天
 * 你不会知道该信哪个。所以这里只做「读日志 + emit」，一个字段都不自己算。
 *
 * 事件名（`kernel.*`）与 `detail` 的排版是前端直接消费的，**一个字都不能改**。
 */

import { pyFloatRepr } from "../../kernel/pyfmt.js";
import { pyRepr } from "../../kernel/errors.js";
import { EventKind } from "../../kernel/events.js";
import type { Event } from "../../kernel/events.js";
import { cpSlice } from "../../onto/parse/base.js";
import type { Journal } from "../../kernel/journal.js";
import type { SessionLike } from "./types.js";

/** `_pump_kernel_events` 只用 Recorder 的这两样。 */
export interface TraceRecorder {
  readonly journal: Pick<Journal, "read">;
  readonly runId: string;
}

/**
 * 内核事件里值得推到前端的那些。
 *
 * `Map` 而不是普通对象：EventKind 的值是 `"node.entered"` 这类点分串，做对象键
 * 没问题，但用 Map 才能让 `has`/`get` 在类型上就锁死 EventKind，避免有人拿一个
 * 随手拼的字符串来查表。
 */
export const KERNEL_TRACE: ReadonlyMap<EventKind, string> = new Map([
  [EventKind.NODE_ENTERED, "kernel.node_entered"],
  [EventKind.NODE_COMPLETED, "kernel.node_completed"],
  [EventKind.NODE_FAILED, "kernel.node_failed"],
  [EventKind.PLAN_CREATED, "kernel.plan"],
  [EventKind.THOUGHT, "kernel.thought"],
  [EventKind.OBSERVATION, "kernel.observation"],
  [EventKind.CRITIC_VERDICT, "kernel.critic"],
  [EventKind.DEGRADED, "kernel.degraded"],
  [EventKind.BUDGET_SPENT, "kernel.spend"],
]);

// ══════════════════════════════════════════════════════════════════
//  Python 的 str()/repr()
// ══════════════════════════════════════════════════════════════════

/** f-string 里的 `{x}` —— 就是 `str(x)`。`None` 印成 `None`，不是空串。 */
function fstr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyReprAny(v);
}

/** `repr(x)` —— 只覆盖 JSON 装得下的那几种，够 `_trace_detail` 最后那行用。 */
function pyReprAny(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return pyRepr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyReprAny).join(", ")}]`;
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${pyRepr(k)}: ${pyReprAny(val)}`,
    );
    return `{${parts.join(", ")}}`;
  }
  return String(v);
}

// ══════════════════════════════════════════════════════════════════
//  投影
// ══════════════════════════════════════════════════════════════════

/**
 * 把内核事件日志里的新事件投影到会话事件流。
 *
 * **水位必须跟 runId 绑定。** 上一版 `_kernel_seq` 是会话级的单个数字，
 * 而它比较的 `ev.seq` 是 **Recorder 实例级**的 —— 每条 run 各自从 0 开始数。
 * 于是第一条 run 结束时水位已经涨到几百几千（EFFECT_* 这类不投影的事件也推水位），
 * 第二条 run 的事件 seq 从 0 起，`ev.seq < seen` 全部成立 ——
 * **整条推理轨迹被吞掉，「推理」面板在这一轮里全程是空的**，
 * 而 FDE 判断"它到底在想什么、有没有卡住"就只有这一个窗口。
 *
 * 换了 runId 就把水位归零：水位的语义是"这条 run 我投影到哪儿了"，
 * 不是"这个会话见过多少事件"。
 */
export function pumpKernelEvents(s: SessionLike, rec: TraceRecorder): void {
  // `setdefault` —— 键不在就写 0 再取；已有值原样用
  if (!("_kernel_seq" in s.state)) s.state["_kernel_seq"] = 0;
  // runId 变了说明是新的 Recorder，它的 seq 重新从 0 数，旧水位对它没有意义
  if (s.state["_kernel_run"] !== rec.runId) {
    s.state["_kernel_run"] = rec.runId;
    s.state["_kernel_seq"] = 0;
  }
  const seen = s.state["_kernel_seq"] as number;
  let latest = seen;
  for (const ev of rec.journal.read(rec.runId)) {
    const name = KERNEL_TRACE.get(ev.kind);
    if (ev.seq < seen || name === undefined) {
      latest = Math.max(latest, ev.seq + 1);
      continue;
    }
    latest = Math.max(latest, ev.seq + 1);
    // ── P4 富化（都是投影层现算，持久事件流里绝不进按秒增长的心跳）──
    // cohort 标注：哪条思考/工具行属于哪个并行子任务；计划是不是 cohort。
    const extras: Record<string, unknown> = {};
    if (ev.payload["cohort_task"] !== undefined) extras["cohort_task"] = ev.payload["cohort_task"];
    if (ev.kind === EventKind.PLAN_CREATED && ev.payload["cohort"] === true) {
      extras["cohort"] = true;
      extras["cohort_tasks"] = ev.payload["cohort_tasks"] ?? 0;
    }
    // 节点耗时：entered 的时刻记在会话私有状态里（跨多次泵仍在），completed
    // 时相减。没见过 entered 就不硬造 —— 假耗时比没有耗时更误导。
    if (ev.kind === EventKind.NODE_ENTERED && ev.nodeId) {
      const marks = (s.state["_kernel_entered"] ??= {}) as Record<string, number>;
      marks[ev.nodeId] = ev.tsMs;
    }
    if (ev.kind === EventKind.NODE_COMPLETED && ev.nodeId) {
      const marks = (s.state["_kernel_entered"] ?? {}) as Record<string, number>;
      const at = marks[ev.nodeId];
      if (typeof at === "number") {
        extras["secs"] = Math.round((ev.tsMs - at) / 1000);
        delete marks[ev.nodeId];
      }
    }
    // run_id + ts_ms 一并带出（P4 四键中的另两键）：跨 run 恢复时前端要能分清
    // "这行是哪次 run 的"；ts_ms 是内核时刻，不是投影时刻 —— 恢复重泵的旧行
    // 用它才不会看起来像刚刚发生。handler 不在 Event 上，不硬造。
    s.emit(name, {
      node: ev.nodeId ?? "",
      detail: traceDetail(ev),
      run_id: rec.runId,
      ts_ms: ev.tsMs,
      ...extras,
    });
  }
  s.state["_kernel_seq"] = latest;
}

/**
 * 跑一段长任务，同时按节拍把内核推理事件泵到会话事件流。
 *
 * 抽取要跑几分钟；不边跑边泵的话，「推理」面板在这几分钟里是空的，FDE 看不出
 * AI 到底在想什么、有没有卡住。泵本身只是读日志 + emit，很便宜。
 *
 * **与 Python 的分叉**：`asyncio.wait_for(asyncio.shield(task), timeout)` 在超时
 * 后 task 继续跑、外层拿到 TimeoutError。JS 里 `Promise.race` 给的是同一个效果
 * （输的那条继续跑），所以这一处**不是**在假装取消 —— shield 的语义本来就是
 * 「超时了也别动里面那个」。真正没有对等物的是取消，见 types.ts 文件头。
 */
export async function runWithLiveTrace<T>(
  s: SessionLike,
  rec: TraceRecorder,
  work: Promise<T>,
  opts: { every?: number } = {},
): Promise<T> {
  const every = opts.every ?? 1.0;
  let settled = false;
  // 立刻挂 handler：泵的循环里 race 输掉的那一侧若先 reject，无人处理的
  // rejection 会触发 unhandledRejection 把进程打死（契约 §2.1 同一条坑）。
  const task = work.then(
    (v) => {
      settled = true;
      return v;
    },
    (e: unknown) => {
      settled = true;
      throw e;
    },
  );
  task.catch(() => undefined);
  try {
    while (!settled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, every * 1000);
        task.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
        );
      });
      // 泵是**观测面**，不是工作负载：它读日志、发 UI 事件，失败的代价应该是
      // 「推理面板少几行」，绝不是把一条 $40 的 run 判死。真实案发：泵在读者
      // 与写者赛跑时撕裂读到半行 JSON，裸 SyntaxError 从这里冒出去，整条
      // run 的状态落成 failed —— 而 journal 事后看完好无损。
      try {
        pumpKernelEvents(s, rec);
      } catch (exc) {
        s.emit("trace.pump_failed", { error: exc instanceof Error ? exc.message : String(exc) });
      }
    }
    return await task;
  } finally {
    try {
      pumpKernelEvents(s, rec); // 收尾再泵一次，别漏最后几条
    } catch (exc) {
      s.emit("trace.pump_failed", { error: exc instanceof Error ? exc.message : String(exc) });
    }
  }
}

/** 一条内核事件在推理面板上的一行。排版（含全角空格 U+3000）逐字照抄。 */
export function traceDetail(ev: Event): string {
  const p = ev.payload;
  if (ev.kind === EventKind.CRITIC_VERDICT) {
    const head = `${fstr(p["lens"])} ${truthy(p["passed"]) ? "通过" : "未通过"}`;
    // `(p.get("findings") or [{}])[0]` —— findings 缺席/为空都退成一个空 dict
    const findings = (p["findings"] as Record<string, unknown>[] | undefined) ?? [];
    const head0 = truthy(findings) ? findings[0]! : {};
    const first = pyGetD(head0, "claim", "");
    return truthy(first) ? `${head}　${cpSlice(fstr(first), 0, 90)}` : head;
  }
  if (ev.kind === EventKind.THOUGHT) return cpSlice(fstr(pyGetD(p, "text", "")), 0, 160);
  if (ev.kind === EventKind.OBSERVATION) {
    return `${fstr(pyGetD(p, "tool", ""))} → ${cpSlice(fstr(pyGetD(p, "summary", "")), 0, 110)}`;
  }
  if (ev.kind === EventKind.BUDGET_SPENT) {
    return `${fstr(p["model"])} ${fstr(p["tok_in"])}→${fstr(p["tok_out"])} $${fstr(p["usd"])}`;
  }
  if (ev.kind === EventKind.PLAN_CREATED) {
    const steps = ((p["steps"] as Record<string, unknown>[] | undefined) ?? []).slice(0, 4);
    return steps.map((x) => cpSlice(fstr(pyGetD(x, "goal", "")), 0, 40)).join("；");
  }
  const keep = ["mode", "attempt", "error", "label"];
  const parts = Object.entries(p)
    .filter(([k]) => keep.includes(k))
    .map(([k, v]) => `${pyRepr(k)}: ${pyReprAny(v)}`);
  return `{${parts.join(", ")}}`;
}

/** `d.get(key, default)` —— **键存在但值是 `None` 时返回 `None`**，不是默认值。
 *  差别是可见的：`str(None)` 是 `"None"`，会真的印在推理面板那一行上。 */
function pyGetD(d: Record<string, unknown>, key: string, dflt: unknown): unknown {
  return key in d ? d[key] : dflt;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}
