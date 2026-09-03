import { useEffect, useMemo, useState, type ReactElement } from "react";

import { API } from "../dom.js";
import { evDetail, evLabel, evTag } from "../events.js";
import { useUi } from "./store.js";

type RuntimeFilter = "all" | "harness" | "events" | "errors";

interface RuntimeStep {
  key: string;
  turn: string;
  n: number | string;
  question: string;
  step: Record<string, any>;
  events: any[];
  firstTs: number;
  lastTs: number;
}

interface RuntimeRun {
  id: string;
  question: string;
  firstTs: number;
  lastTs: number;
  steps: RuntimeStep[];
}

interface LedgerRun {
  id: string;
  status: string;
  quarantined: boolean;
  event_count: number;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  truncated: boolean;
  events: any[];
}

interface LedgerResponse {
  runs: LedgerRun[];
  total_runs: number;
  truncated: boolean;
}

interface LedgerStep {
  id: string;
  label: string;
  input: unknown;
  output: unknown;
  data: unknown;
  events: any[];
  status: "running" | "done" | "error";
}

interface ResolvedLedgerValue {
  status: "idle" | "loading" | "ready" | "error";
  value: unknown;
  error: string;
  redacted: boolean;
  fidelity: string;
}

const SENSITIVE_KEY = /^(?:pass(?:word|wd)?|pwd|token|(?:access|refresh|id)[_. -]?token|api[_. -]?key|authorization|cookie|secret|credential|client[_. -]?secret|private[_. -]?key)$/iu;
const INLINE_SECRET = /((?:pass(?:word|wd)?|pwd|access[_. -]?token|refresh[_. -]?token|api[_. -]?key|authorization|cookie|secret|credential|client[_. -]?secret|private[_. -]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const AUTH_SECRET = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const KEY_LIKE_SECRET = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu;
const MAX_FIELD_CHARS = 48_000;
const MAX_RAW_CHARS = 120_000;

function tr(zh: string, en: string, lang: string): string {
  return lang === "en" ? en : zh;
}

function hidden(lang: string): string {
  return tr("[已隐藏敏感信息]", "[sensitive value hidden]", lang);
}

function redactText(value: unknown, lang: string): string {
  return String(value ?? "")
    .replace(AUTH_SECRET, (_all, kind: string) => `${kind} ${hidden(lang)}`)
    .replace(INLINE_SECRET, (_all, prefix: string) => `${prefix}${hidden(lang)}`)
    .replace(KEY_LIKE_SECRET, hidden(lang));
}

/** 日志是外部输入：限制深度与节点数，避免展开一条异常事件时卡死整个工作区。 */
function redactValue(
  value: unknown,
  lang: string,
  seen = new WeakSet<object>(),
  budget = { nodes: 6_000 },
  depth = 0,
): unknown {
  if (budget.nodes-- <= 0 || depth > 16) return tr("…（内容过长，已截断）", "… (content truncated)", lang);
  if (typeof value === "string") return redactText(value, lang);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    const rows = value.slice(0, 2_000).map((item) => redactValue(item, lang, seen, budget, depth + 1));
    if (value.length > 2_000) rows.push(tr("…（数组已截断）", "… (array truncated)", lang));
    return rows;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, 2_000)) {
    out[key] = SENSITIVE_KEY.test(key) ? hidden(lang) : redactValue(item, lang, seen, budget, depth + 1);
  }
  if (entries.length > 2_000) out["…"] = tr("字段已截断", "fields truncated", lang);
  return out;
}

function inspectText(value: unknown, lang: string, max = MAX_FIELD_CHARS): string {
  let rendered = "";
  try {
    rendered = typeof value === "string"
      ? redactText(value, lang)
      : JSON.stringify(redactValue(value, lang), null, 2);
  } catch {
    rendered = redactText(value, lang);
  }
  if (rendered.length <= max) return rendered;
  return `${rendered.slice(0, max)}\n${tr("…（内容过长，已截断）", "… (content truncated)", lang)}`;
}

function mergeDefined(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** `chat.step` 的 start/result 各落一条事件；这里按 turn#n 合并为一条可核对的步骤。 */
export function buildRuntimeRuns(events: any[]): RuntimeRun[] {
  const steps = new Map<string, RuntimeStep>();
  (events || []).forEach((event: any, index: number) => {
    if (event?.kind !== "chat.step" || !event?.step || typeof event.step !== "object") return;
    const rawStep = event.step as Record<string, any>;
    const turn = String(rawStep.turn ?? "unknown");
    const n = rawStep.n ?? index + 1;
    const key = `${turn}#${String(n)}`;
    const ts = Number(event.ts) || 0;
    const previous = steps.get(key);
    if (previous) {
      previous.step = mergeDefined(previous.step, rawStep);
      previous.events.push(event);
      previous.question ||= String(rawStep.q ?? "");
      if (ts > 0) {
        previous.firstTs = previous.firstTs > 0 ? Math.min(previous.firstTs, ts) : ts;
        previous.lastTs = Math.max(previous.lastTs, ts);
      }
      return;
    }
    steps.set(key, {
      key,
      turn,
      n,
      question: String(rawStep.q ?? ""),
      step: { ...rawStep },
      events: [event],
      firstTs: ts,
      lastTs: ts,
    });
  });

  const runs = new Map<string, RuntimeRun>();
  for (const step of steps.values()) {
    const run = runs.get(step.turn);
    if (run) {
      run.steps.push(step);
      if (!run.question && step.question) run.question = step.question;
      if (step.firstTs > 0) run.firstTs = run.firstTs > 0 ? Math.min(run.firstTs, step.firstTs) : step.firstTs;
      run.lastTs = Math.max(run.lastTs, step.lastTs);
    } else {
      runs.set(step.turn, {
        id: step.turn,
        question: step.question,
        firstTs: step.firstTs,
        lastTs: step.lastTs,
        steps: [step],
      });
    }
  }
  return [...runs.values()]
    .map((run) => ({
      ...run,
      steps: run.steps.sort((a, b) => Number(a.n) - Number(b.n) || a.firstTs - b.firstTs),
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

function when(ts: unknown, lang: string): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return tr("时间未知", "Unknown time", lang);
  const date = new Date(n < 1_000_000_000_000 ? n * 1_000 : n);
  if (Number.isNaN(date.valueOf())) return String(ts);
  return date.toLocaleString(lang === "en" ? "en-US" : "zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function duration(firstTs: number, lastTs: number, lang: string): string {
  if (!(firstTs > 0 && lastTs >= firstTs)) return "";
  const seconds = (lastTs - firstTs) / (firstTs >= 1_000_000_000_000 ? 1_000 : 1);
  if (seconds < 0.001) return "";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return tr(`${minutes}分${rest}秒`, `${minutes}m ${rest}s`, lang);
}

function stepStatus(step: RuntimeStep, active = false): "running" | "done" | "error" {
  const value = step.step;
  if (value.error || value.failed || String(value.status || "").toLocaleLowerCase().includes("fail")) return "error";
  if (["observation", "output", "result", "response"].some((key) => value[key] !== undefined && value[key] !== null)) return "done";
  // “先判断再调用工具”这类 Harness 行本来就没有 observation；只有当前轮最后一条
  // 无输出记录才代表仍在进行，历史轮不能因此永久显示成运行中。
  return active ? "running" : "done";
}

function outputOf(step: Record<string, any>): unknown {
  const out: Record<string, unknown> = {};
  for (const key of ["observation", "output", "result", "response", "error"]) {
    if (step[key] !== undefined && step[key] !== null && step[key] !== "") out[key] = step[key];
  }
  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === "observation") return out.observation;
  return keys.length ? out : undefined;
}

function inputOf(step: Record<string, any>): unknown {
  for (const key of ["args", "input", "parameters", "request"]) {
    if (step[key] !== undefined && step[key] !== null) return step[key];
  }
  return undefined;
}

function metadataOf(row: RuntimeStep): Record<string, unknown> {
  const omitted = new Set(["q", "thought", "tool", "args", "input", "parameters", "request", "observation", "output", "result", "response", "error"]);
  const step: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.step)) if (!omitted.has(key)) step[key] = value;
  return {
    run_id: row.turn,
    step,
    event_count: row.events.length,
    first_event_at: row.firstTs || null,
    last_event_at: row.lastTs || null,
    envelopes: row.events.map((event) => {
      const envelope: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event || {})) if (key !== "step") envelope[key] = value;
      return envelope;
    }),
  };
}

function InspectBlock({ label, value, lang, className = "" }: {
  label: string; value: unknown; lang: string; className?: string;
}): ReactElement | null {
  if (value === undefined || value === null || value === "") return null;
  return <section className={`ctx-runtime-block ${className}`.trim()}>
    <div className="ctx-runtime-block-title">{label}</div>
    <pre>{inspectText(value, lang)}</pre>
  </section>;
}

function RuntimeStepCard({ row, lang, open, active }: {
  row: RuntimeStep; lang: string; open: boolean; active: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(open);
  const status = stepStatus(row, active);
  const statusLabel = status === "error"
    ? tr("失败", "Failed", lang)
    : status === "done" ? tr("完成", "Done", lang) : tr("进行中", "Running", lang);
  const tool = String(row.step.tool || tr("Harness 步骤", "Harness step", lang));
  return <details className={`ctx-runtime-step ${status}`} open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.hasAttribute("open"))}>
    <summary>
      <span className="ctx-runtime-index">{String(row.n).padStart(2, "0")}</span>
      <span className="ctx-runtime-step-main">
        <strong>{tool}</strong>
        <small>{when(row.lastTs, lang)}{duration(row.firstTs, row.lastTs, lang) ? ` · ${duration(row.firstTs, row.lastTs, lang)}` : ""}</small>
      </span>
      <span className={`ctx-runtime-status ${status}`}>{statusLabel}</span>
    </summary>
    <div className="ctx-runtime-step-body">
      <InspectBlock label={tr("Harness 判断", "Harness reasoning", lang)} value={row.step.thought} lang={lang} />
      <InspectBlock label={tr("输入", "Input", lang)} value={inputOf(row.step)} lang={lang} className="input" />
      <InspectBlock label={tr("输出", "Output", lang)} value={outputOf(row.step)} lang={lang} className={status === "error" ? "error" : "output"} />
      <InspectBlock label={tr("元数据", "Metadata", lang)} value={metadataOf(row)} lang={lang} className="metadata" />
      <details className="ctx-runtime-raw">
        <summary>{tr(`原始事件 · ${row.events.length} 条`, `Raw events · ${row.events.length}`, lang)}</summary>
        <pre>{inspectText(row.events, lang, MAX_RAW_CHARS)}</pre>
      </details>
    </div>
  </details>;
}

function RuntimeRunCard({ run, lang, query, active }: {
  run: RuntimeRun; lang: string; query: string; active: boolean;
}): ReactElement | null {
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? run.steps.filter((step) => inspectText({ question: step.question, step: step.step }, lang, MAX_RAW_CHARS).toLocaleLowerCase().includes(needle))
    : run.steps;
  if (!visible.length) return null;
  const failed = visible.filter((step) => stepStatus(step) === "error").length;
  const running = active;
  return <section className="ctx-runtime-run">
    <header className="ctx-runtime-run-head">
      <div>
        <div className="ctx-runtime-run-kicker">{run.id === "aux"
          ? tr("后台辅助 Harness", "Background harness", lang)
          : tr("对话 Harness", "Conversation harness", lang)}</div>
        <strong>{run.question || tr(`运行 ${run.id}`, `Run ${run.id}`, lang)}</strong>
        <small>{when(run.lastTs, lang)}{duration(run.firstTs, run.lastTs, lang) ? ` · ${duration(run.firstTs, run.lastTs, lang)}` : ""}</small>
      </div>
      <span className={`ctx-runtime-status ${failed ? "error" : running ? "running" : "done"}`}>
        {failed ? tr(`${failed} 步失败`, `${failed} failed`, lang) : running ? tr("运行中", "Running", lang) : tr(`${visible.length} 步`, `${visible.length} steps`, lang)}
      </span>
    </header>
    <div className="ctx-runtime-steps">
      {visible.map((step, index) => <RuntimeStepCard key={step.key} row={step} lang={lang} open={index === 0}
        active={active && index === visible.length - 1} />)}
    </div>
  </section>;
}

function eventIsError(event: any): boolean {
  const tag = evTag(String(event?.kind || ""));
  return tag === "err" || !!event?.error || /(?:fail|error|cancel)/iu.test(String(event?.kind || ""));
}

function SystemEventCard({ event, lang }: { event: any; lang: string }): ReactElement {
  const tag = eventIsError(event) ? "error" : /(?:completed|ready|recorded|applied)/iu.test(String(event?.kind || "")) ? "done" : "neutral";
  const envelope = { seq: event?.seq ?? null, ts: event?.ts ?? null, event_id: event?.event_id ?? event?.id ?? null, kind: event?.kind ?? "unknown" };
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event || {})) if (!["seq", "ts", "event_id", "id", "kind"].includes(key)) payload[key] = value;
  return <details className={`ctx-runtime-event ${tag}`}>
    <summary>
      <span className={`ctx-runtime-dot ${tag}`} aria-hidden="true" />
      <span className="ctx-runtime-step-main">
        <strong>{evLabel(String(event?.kind || "")) || String(event?.kind || tr("系统事件", "System event", lang))}</strong>
        <small>{evDetail(event) || String(event?.kind || "")}</small>
      </span>
      <time>{when(event?.ts, lang)}</time>
    </summary>
    <div className="ctx-runtime-step-body">
      <InspectBlock label={tr("事件数据", "Event data", lang)} value={payload} lang={lang} />
      <InspectBlock label={tr("元数据", "Metadata", lang)} value={envelope} lang={lang} className="metadata" />
      <details className="ctx-runtime-raw">
        <summary>{tr("原始事件", "Raw event", lang)}</summary>
        <pre>{inspectText(event, lang, MAX_RAW_CHARS)}</pre>
      </details>
    </div>
  </details>;
}

function ledgerRunLabel(id: string, lang: string): string {
  if (id.includes("flow_sketch")) return tr("参考流程图生成", "Reference flow generation", lang);
  if (id.includes("engagement")) return tr("业务梳理 Engagement", "Business engagement", lang);
  if (id.includes("reason")) return tr("对话推理", "Conversation reasoning", lang);
  if (id.includes("extract") || id.includes("build")) return tr("材料梳理", "Material build", lang);
  return tr("Harness 运行", "Harness run", lang);
}

function ledgerStatusLabel(status: string, lang: string): string {
  const labels: Record<string, [string, string]> = {
    completed: ["完成", "Completed"], recorded: ["已记录", "Recorded"], failed: ["失败", "Failed"],
    suspended: ["等待输入", "Suspended"], quarantined: ["已隔离", "Quarantined"],
  };
  const pair = labels[status] || [status || "已记录", status || "Recorded"];
  return tr(pair[0], pair[1], lang);
}

function ledgerEventStatus(kind: string): "running" | "done" | "error" {
  if (/(?:failed|superseded)/u.test(kind)) return "error";
  if (/(?:requested|entered|started|resumed)/u.test(kind)) return "running";
  return "done";
}

/** 把 effect.requested + completed/failed 合成一步；其他 journal 事件逐条保留，不漏账。 */
export function buildLedgerSteps(events: any[]): LedgerStep[] {
  const steps: LedgerStep[] = [];
  const effects = new Map<string, LedgerStep>();
  for (const event of events || []) {
    const kind = String(event?.kind || "unknown");
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    if (kind.startsWith("effect.")) {
      const key = String(payload.key ?? `${event?.node_id || "effect"}#${event?.seq ?? steps.length}`);
      let step = effects.get(key);
      if (!step) {
        step = {
          id: `effect:${key}`,
          label: String(payload.kind || "effect"),
          input: undefined,
          output: undefined,
          data: undefined,
          events: [],
          status: "running",
        };
        effects.set(key, step);
        steps.push(step);
      }
      step.events.push(event);
      if (kind === "effect.requested") step.input = payload.request;
      if (kind === "effect.completed") {
        step.output = payload.result;
        step.status = "done";
      }
      if (kind === "effect.failed" || kind === "effect.superseded") {
        step.output = payload.error ?? payload;
        step.status = "error";
      }
      continue;
    }
    const outputKind = /(?:completed|verdict|evaluated|recorded|spent|compacted|promoted|evicted|observation)/u.test(kind);
    const inputKind = /(?:requested|entered|started|plan|thought|message|blackboard)/u.test(kind);
    steps.push({
      id: `event:${String(event?.seq ?? steps.length)}`,
      label: kind,
      input: inputKind ? payload : undefined,
      output: outputKind ? payload : undefined,
      data: inputKind || outputKind ? undefined : payload,
      events: [event],
      status: ledgerEventStatus(kind),
    });
  }
  return steps;
}

function ledgerMetadata(step: LedgerStep): unknown {
  return step.events.map((event) => {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event?.payload || {})) {
      if (!["request", "result", "error"].includes(key)) payload[key] = value;
    }
    return {
      run_id: event?.run_id,
      seq: event?.seq,
      kind: event?.kind,
      ts_ms: event?.ts_ms,
      node_id: event?.node_id ?? null,
      ref: event?.ref ?? null,
      payload,
      redacted: !!event?.redacted,
    };
  });
}

function inputIsDigest(input: unknown): boolean {
  try { return JSON.stringify(input).includes("…(+"); }
  catch { return false; }
}

function useResolvedLedgerValue(
  sid: string,
  runId: string,
  event: any,
  expanded: boolean,
): ResolvedLedgerValue {
  const hasRef = typeof event?.ref === "string" && event.ref.length > 0;
  const seq = hasRef ? Number(event?.seq) : -1;
  const [detail, setDetail] = useState<ResolvedLedgerValue>({
    status: "idle", value: undefined, error: "", redacted: false, fidelity: "",
  });
  useEffect(() => {
    setDetail({ status: "idle", value: undefined, error: "", redacted: false, fidelity: "" });
  }, [runId, seq, sid]);
  useEffect(() => {
    if (!expanded || !hasRef || !Number.isSafeInteger(seq) || seq < 0 || detail.status !== "idle") return;
    const controller = new AbortController();
    setDetail({ status: "loading", value: undefined, error: "", redacted: false, fidelity: "" });
    void fetch(`${API}/api/logs/sessions/${encodeURIComponent(sid)}/runtime/runs/${encodeURIComponent(runId)}/events/${seq}`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return await response.json();
    }).then((body: any) => {
      setDetail({
        status: body?.resolve_error ? "error" : "ready",
        value: body?.resolved,
        error: String(body?.resolve_error || ""),
        redacted: !!body?.redacted,
        fidelity: String(body?.fidelity || ""),
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setDetail({
        status: "error", value: undefined,
        error: error instanceof Error ? error.message : String(error),
        redacted: false, fidelity: "",
      });
    });
    return () => controller.abort();
  }, [detail.status, expanded, hasRef, runId, seq, sid]);
  return detail;
}

function LedgerStepCard({ sid, runId, step, lang, open }: {
  sid: string; runId: string; step: LedgerStep; lang: string; open: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(open);
  const inputRefEvent = step.events.find((event) => !!event?.ref && /(?:requested|entered|started)$/u.test(String(event?.kind || "")));
  const outputRefEvent = step.events.find((event) => !!event?.ref && event !== inputRefEvent);
  const inputDetail = useResolvedLedgerValue(sid, runId, inputRefEvent, expanded);
  const outputDetail = useResolvedLedgerValue(sid, runId, outputRefEvent, expanded);

  const first = step.events[0];
  const last = step.events[step.events.length - 1] || first;
  const input = inputRefEvent
    ? inputDetail.status === "ready" ? inputDetail.value
      : inputDetail.status === "error" ? { error: inputDetail.error }
        : tr("正在读取完整输入…", "Loading full input…", lang)
    : step.input;
  const output = outputRefEvent
    ? outputDetail.status === "ready" ? outputDetail.value
      : outputDetail.status === "error" ? { error: outputDetail.error }
        : tr("正在读取完整输出…", "Loading full output…", lang)
    : step.output;
  const digest = !inputRefEvent && inputIsDigest(step.input);
  const fullInput = !!inputRefEvent;
  const redacted = step.events.some((event) => event?.redacted) || inputDetail.redacted || outputDetail.redacted;
  return <details className={`ctx-runtime-step ctx-ledger-step ${step.status}`} open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.hasAttribute("open"))}>
    <summary>
      <span className="ctx-runtime-index">{String(first?.seq ?? "·").padStart(2, "0")}</span>
      <span className="ctx-runtime-step-main">
        <strong>{step.label}</strong>
        <small>{String(first?.node_id || tr("运行级事件", "Run event", lang))} · {when(last?.ts_ms, lang)}</small>
      </span>
      {digest ? <span className="ctx-ledger-fidelity" title={tr("历史请求只保存了摘要，截断部分无法恢复", "Historical request is stored as a digest", lang)}>
        {tr("输入摘要", "Input digest", lang)}</span> : null}
      {fullInput ? <span className="ctx-ledger-fidelity full" title={tr("完整请求已从审计 blob 按需读取", "Full request is loaded lazily from the audit blob", lang)}>
        {tr("完整输入", "Full input", lang)}</span> : null}
      <span className={`ctx-runtime-status ${step.status}`}>{step.status === "error"
        ? tr("失败", "Failed", lang) : step.status === "running" ? tr("开始", "Started", lang) : tr("完成", "Done", lang)}</span>
    </summary>
    <div className="ctx-runtime-step-body">
      {redacted ? <div className="ctx-ledger-redacted">{tr("敏感字段已在服务端打码", "Sensitive fields were redacted on the server", lang)}</div> : null}
      <InspectBlock label={digest ? tr("输入（历史摘要）", "Input (historical digest)", lang) : tr("输入", "Input", lang)} value={input} lang={lang} className="input" />
      <InspectBlock label={tr("输出", "Output", lang)} value={output} lang={lang} className={step.status === "error" ? "error" : "output"} />
      <InspectBlock label={tr("事件数据", "Event data", lang)} value={step.data} lang={lang} />
      <InspectBlock label={tr("元数据", "Metadata", lang)} value={ledgerMetadata(step)} lang={lang} className="metadata" />
      <details className="ctx-runtime-raw">
        <summary>{tr(`原始内核事件 · ${step.events.length} 条`, `Raw kernel events · ${step.events.length}`, lang)}</summary>
        <pre>{inspectText(step.events, lang, MAX_RAW_CHARS)}</pre>
      </details>
    </div>
  </details>;
}

function LedgerRunCard({ sid, run, lang, open }: {
  sid: string; run: LedgerRun; lang: string; open: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(open);
  const steps = useMemo(() => buildLedgerSteps(run.events), [run.events]);
  const statusClass = run.status === "failed" || run.status === "quarantined" ? "error"
    : run.status === "suspended" ? "running" : "done";
  return <details className={`ctx-ledger-run ${statusClass}`} open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.hasAttribute("open"))}>
    <summary className="ctx-runtime-run-head">
      <div>
        <div className="ctx-runtime-run-kicker">KERNEL JOURNAL</div>
        <strong>{ledgerRunLabel(run.id, lang)}</strong>
        <small>{run.id} · {when(run.ended_at_ms, lang)}{duration(Number(run.started_at_ms), Number(run.ended_at_ms), lang)
          ? ` · ${duration(Number(run.started_at_ms), Number(run.ended_at_ms), lang)}` : ""}</small>
      </div>
      <span className={`ctx-runtime-status ${statusClass}`}>{ledgerStatusLabel(run.status, lang)} · {run.event_count}</span>
    </summary>
    {expanded ? <div className="ctx-runtime-steps">
      {run.truncated ? <div className="ctx-warning">{tr("这次运行事件过多，当前只载入前一部分。", "This run is large; only the first page is loaded.", lang)}</div> : null}
      {steps.map((step, index) => <LedgerStepCard key={step.id} sid={sid} runId={run.id} step={step} lang={lang} open={index === 0} />)}
    </div> : null}
  </details>;
}

function ExecutionLedger({ sid, ledger, status, error, lang }: {
  sid: string;
  ledger: LedgerResponse | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string;
  lang: string;
}): ReactElement | null {
  if (status === "idle") return null;
  return <section className="ctx-runtime-ledger">
    <div className="ctx-runtime-ledger-head">
      <div>
        <div className="ctx-section-title">{tr("Harness 执行账本", "Harness execution ledger", lang)}</div>
        <small>{tr("来自内核 journal；大输出在展开步骤时按需读取。", "Backed by the kernel journal; large outputs load on demand.", lang)}</small>
      </div>
      {status === "ready" ? <span className="ctx-badge confirmed">{ledger?.total_runs ?? 0} RUNS</span> : null}
    </div>
    {status === "loading" ? <div className="ctx-empty-inline">{tr("正在读取执行账本…", "Loading execution ledger…", lang)}</div> : null}
    {status === "error" ? <div className="ctx-warning">{tr("执行账本暂时不可用：", "Execution ledger unavailable: ", lang)}{error}</div> : null}
    {status === "ready" && !ledger?.runs?.length ? <div className="ctx-empty-inline">{tr("这次会话还没有内核执行账本。", "No kernel execution ledger exists for this session yet.", lang)}</div> : null}
    {status === "ready" && ledger?.runs?.length ? <div className="ctx-ledger-run-list">
      {ledger.runs.map((run, index) => <LedgerRunCard key={`${run.id}:${run.quarantined}`} sid={sid} run={run} lang={lang} open={index === 0} />)}
      {ledger.truncated ? <div className="ctx-list-cap">{tr("这里只载入最近的运行，更早记录仍保留在审计账本中。", "Only recent runs are loaded; older runs remain in the audit ledger.", lang)}</div> : null}
    </div> : null}
  </section>;
}

function EmptyRuntime({ lang }: { lang: string }): ReactElement {
  return <div className="ctx-empty ctx-runtime-empty">
    <div className="ctx-empty-label">RUNTIME</div>
    <div className="ctx-detail-title">{tr("还没有运行记录", "No runtime records yet", lang)}</div>
    <div className="ctx-empty-copy">{tr(
      "发起一次对话或开始梳理后，这里会按顺序记录 Harness 的每一步输入、输出和元数据。",
      "Start a conversation or build to inspect every harness input, output, and metadata field here.",
      lang,
    )}</div>
  </div>;
}

/** 右侧运行检查器：聊天主线不再承载日志，所有耐久事件在这里集中核对。 */
export function RuntimePanel({ query = "" }: { query?: string }): ReactElement {
  const G = useUi();
  const lang = G.LANG;
  const [filter, setFilter] = useState<RuntimeFilter>("all");
  const [ledgerState, setLedgerState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    data: LedgerResponse | null;
    error: string;
  }>({ status: "idle", data: null, error: "" });
  const events = G.S?.events || [];
  const sid = String(G.S?.id || "");
  useEffect(() => {
    if (!sid) {
      setLedgerState({ status: "idle", data: null, error: "" });
      return;
    }
    const controller = new AbortController();
    setLedgerState({ status: "loading", data: null, error: "" });
    void fetch(`${API}/api/logs/sessions/${encodeURIComponent(sid)}/runtime/runs`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        return await response.json();
      })
      .then((body: any) => {
        if (controller.signal.aborted) return;
        setLedgerState({
          status: "ready",
          data: {
            runs: Array.isArray(body?.runs) ? body.runs : [],
            total_runs: Number(body?.total_runs || 0),
            truncated: !!body?.truncated,
          },
          error: "",
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLedgerState({ status: "error", data: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [G.THINKING, sid]);
  const runs = useMemo(() => buildRuntimeRuns(events), [events]);
  const systemEvents = useMemo(() => events.filter((event: any) => !["chat.turn", "chat.step"].includes(event?.kind)), [events]);
  const harnessEvents = events.filter((event: any) => event?.kind === "chat.step" || String(event?.kind || "").startsWith("kernel."));
  const stepCount = runs.reduce((sum, run) => sum + run.steps.length, 0);
  const errors = [...runs.flatMap((run) => run.steps).filter((step) => stepStatus(step) === "error"), ...systemEvents.filter(eventIsError)].length;
  const needle = query.trim().toLocaleLowerCase();
  const visibleSystem = systemEvents.filter((event: any) => {
    if (filter === "harness" && !String(event?.kind || "").startsWith("kernel.")) return false;
    if (filter === "errors" && !eventIsError(event)) return false;
    if (filter === "events" || filter === "all" || filter === "harness" || filter === "errors") {
      return !needle || inspectText(event, lang, MAX_RAW_CHARS).toLocaleLowerCase().includes(needle);
    }
    return true;
  });
  const showRuns = filter === "all" || filter === "harness" || filter === "errors";
  const filteredRuns = filter === "errors"
    ? runs.map((run) => ({ ...run, steps: run.steps.filter((step) => stepStatus(step) === "error") })).filter((run) => run.steps.length)
    : runs;
  const runMatchCount = showRuns ? filteredRuns.reduce((sum, run) => sum + run.steps.filter((step) => !needle
    || inspectText({ question: step.question, step: step.step }, lang, MAX_RAW_CHARS).toLocaleLowerCase().includes(needle)).length, 0) : 0;
  const hasVisible = runMatchCount > 0 || visibleSystem.length > 0;

  const filters: Array<[RuntimeFilter, string, number]> = [
    ["all", tr("全部", "All", lang), events.filter((event: any) => event?.kind !== "chat.turn").length],
    ["harness", "Harness", stepCount + harnessEvents.filter((event: any) => String(event?.kind || "").startsWith("kernel.")).length],
    ["events", tr("系统事件", "System events", lang), systemEvents.length],
    ["errors", tr("异常", "Errors", lang), errors],
  ];
  return <div className="ctx-runtime">
    <section className="ctx-runtime-overview">
      <div className="ctx-runtime-overview-head">
        <div>
          <div className="ctx-eyebrow">RUNTIME INSPECTOR</div>
          <div className="ctx-detail-title">{tr("运行记录", "Runtime records", lang)}</div>
          <p>{tr("汇总当前会话已记录的 Harness 调用与系统事件，逐项核对输入、输出和元数据。", "Inspect the recorded harness calls, inputs, outputs, metadata, and system events in this session.", lang)}</p>
        </div>
        <span className={`ctx-runtime-live ${G.THINKING ? "running" : ""}`}>
          <i />{G.THINKING ? tr("运行中", "Running", lang) : tr("已同步", "Synced", lang)}
        </span>
      </div>
      <div className="ctx-runtime-metrics">
        <div><strong>{runs.length}</strong><span>{tr("会话轮次", "Conversation runs", lang)}</span></div>
        <div><strong>{stepCount}</strong><span>{tr("Harness 步骤", "Harness steps", lang)}</span></div>
        <div><strong>{systemEvents.length}</strong><span>{tr("系统事件", "System events", lang)}</span></div>
        <div className={errors ? "warn" : ""}><strong>{errors}</strong><span>{tr("异常", "Errors", lang)}</span></div>
      </div>
    </section>
    <ExecutionLedger sid={sid} ledger={ledgerState.data} status={ledgerState.status} error={ledgerState.error} lang={lang} />
    {!events.length ? (ledgerState.status === "ready" && ledgerState.data?.runs?.length
      ? <div className="ctx-empty-inline">{tr("没有会话层事件；上方内核账本仍可完整核对。", "No session-level events; the kernel ledger above remains available.", lang)}</div>
      : <EmptyRuntime lang={lang} />) : <>
      <div className="ctx-filters ctx-runtime-filters" aria-label={tr("运行记录筛选", "Runtime filters", lang)}>
        {filters.map(([key, label, count]) => <button type="button" key={key}
          className={`ctx-filter ${filter === key ? "on" : ""}`}
          aria-pressed={filter === key}
          onClick={() => setFilter(key)}>{label}<span className="ctx-count">{count}</span></button>)}
      </div>
      {!hasVisible ? <div className="ctx-empty-inline">{tr("当前筛选下没有匹配的运行记录。", "No runtime records match this filter.", lang)}</div> : null}
      {showRuns && filteredRuns.length ? <div className="ctx-runtime-run-list">
        {filteredRuns.map((run, index) => <RuntimeRunCard key={run.id} run={run} lang={lang} query={query}
          active={G.THINKING && index === 0} />)}
      </div> : null}
      {visibleSystem.length ? <section className="ctx-runtime-system">
        <div className="ctx-section-title">{filter === "harness"
          ? tr("内核 Harness 事件", "Kernel harness events", lang)
          : tr("系统事件", "System events", lang)} <span className="ctx-count">{visibleSystem.length}</span></div>
        <div className="ctx-runtime-event-list">
          {visibleSystem.slice().reverse().map((event: any, index: number) => <SystemEventCard
            key={String(event?.seq ?? event?.event_id ?? `${event?.kind}:${index}`)} event={event} lang={lang} />)}
        </div>
      </section> : null}
    </>}
  </div>;
}

export default RuntimePanel;
