/**
 * 全量日志的只读视图 —— 管理员跨账号看全部，普通用户只看自己的。
 *
 * ── 数据源就是 session_event，没有第二套埋点 ──────────────────────
 *
 * 日志页看到的推理轨迹，与聊天流里的 TRACE、与事后重放、与审计看到的**是同一份
 * 东西**。另起一套日志埋点的代价不是多写代码，是从此有两份会互相打架的"真相"，
 * 而出事时你不知道该信哪个。
 *
 * ── 为什么不挂在 /api/sessions/ 下面 ─────────────────────────────
 *
 * `authgate.ts` 那道中间件按 `/api/sessions/<sid>` **前缀**匹配，判
 * `row.owner !== user.id` 就回 404，**没有任何管理员豁免**，而且它跑在路由处理器
 * **之前**。挂进去的话，管理员点开别人的会话拿到的是 404，你在路由里写多少
 * requireAdmin 都不会被执行到。所以自己一个前缀，归属判定由下面 visibleSession()
 * 做一次。`/api/logs/` 不在 PUBLIC_PATHS 里，强制鉴权下仍然必须登录。
 *
 * ── 列表只回摘要 ────────────────────────────────────────────────
 *
 * readEvents 对 ref 非空的行会逐行反查 blob，一页里混进几条大 payload 就是几百 KB
 * 的响应，而那些 SELECT 串行发生在 engine 的互斥里 —— 整个进程的 DB 访问在这期间
 * 排队。今天库里 ref 非空 0 行，所以这是前瞻风险不是现症；但"列表只回 preview +
 * bytes、全文走单条详情"这个形状零成本且是对的，从第一天就立住。
 */

import type { Context, Hono } from "hono";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AppEnv } from "../app.js";
import { isolate, ownerId } from "../app.js";
import { optionalIntQuery } from "../http422.js";
import { currentRepo, root } from "../session.js";
import { eventFromDict, eventToDict, type Event } from "../../kernel/events.js";
import { FileBlobStore } from "../../kernel/journal.js";
import type { EventRow, SessionRow } from "../../store/types.js";
import { eventRowAsSse } from "../../store/types.js";
import { apiError } from "./sessions.js";

/** 摘要里最多带多少个**码点**（一个汉字算一个）。够看清"这条是什么"，不够就点开。 */
const PREVIEW_CP = 240;
/** 一页最多几条。 */
const PAGE_MAX = 500;
/** 会话清单上限。listSessions 默认 100，管理员看全部时会被静默截断，所以显式给。 */
const SESSION_MAX = 500;
/** 右栏一次最多装入多少个执行账本；更早的仍留在磁盘，通过 truncated 明说。 */
const RUNTIME_RUN_MAX = 30;
/** 单个 run 的事件上限。真实 chat run 通常几十条，build 通常数百条。 */
const RUNTIME_EVENT_MAX = 1_500;
const SAFE_RUN_FILE = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,239})\.jsonl(\.rolledback)?$/u;
const SAFE_SESSION_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/**
 * 出口处的凭证打码。
 *
 * **只认高置信度的形状，不做任何语义级的 PII 猜测。** 猜错的代价（把正常内容打成
 * 星号）比漏掉更难发现：漏掉的人还看得见原文，打错的人根本不知道自己少看了什么。
 *
 * 为什么必须有：`kernel/config.ts` 的 redactedKey 只管**系统自己持有**的密钥；
 * 用户在聊天里粘进来的凭证是原封不动进 chat.turn 并永久留存的。以前那是"自己的
 * 数据在自己的库里"，现在管理员能跨账号读，它就变成了另一个人能读到的东西。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

/** 返回 [打过码的文本, 是否动过]。**动过就要说**——打了码而不说，等于在审计日志上撒谎。 */
export function redactSecrets(text: string): [string, boolean] {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    // 每次新建 lastIndex：正则字面量带 g 时是有状态的，复用会漏匹配。
    out = out.replace(new RegExp(re.source, re.flags), (m) => `${m.slice(0, 6)}***已打码***`);
  }
  return [out, out !== text];
}

export interface LogEventBrief {
  seq: number;
  kind: string;
  ts: number;
  event_id: string;
  /** payload 序列化后的字节数。前端据此决定要不要提示"这条很大"。 */
  bytes: number;
  /** payload JSON 的前 PREVIEW_CP 个码点（已打码）。 */
  preview: string;
  truncated: boolean;
  redacted: boolean;
}

export function briefOf(r: EventRow): LogEventBrief {
  const raw = JSON.stringify(r.payload) ?? "";
  const [safe, redacted] = redactSecrets(raw);
  const cps = [...safe]; // 按码点切，别把 emoji 或汉字切出半个
  return {
    seq: r.seq,
    kind: r.kind,
    ts: r.ts,
    event_id: r.event_id ?? "",
    bytes: Buffer.byteLength(raw, "utf8"),
    preview: cps.slice(0, PREVIEW_CP).join(""),
    truncated: cps.length > PREVIEW_CP,
    redacted,
  };
}

interface RuntimeFile {
  runId: string;
  path: string;
  quarantined: boolean;
  mtimeMs: number;
}

/**
 * 只从**已经通过 visibleSession 的会话目录**列账本；runId 永远由服务端文件名派生，
 * 客户端不能传任意路径。`.rolledback` 是失败后隔离的账本，也要可审计但明确标记。
 */
function runtimeFiles(sid: string): RuntimeFile[] {
  if (!SAFE_SESSION_DIR.test(sid)) return [];
  const dir = join(root(), sid, "journal");
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return []; }
  const found: RuntimeFile[] = [];
  for (const name of names) {
    const match = SAFE_RUN_FILE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      found.push({ runId: match[1]!, path, quarantined: !!match[2], mtimeMs: st.mtimeMs });
    } catch {
      // 文件可能刚好在 chat 回滚时被 rename；下一次刷新会读到新名字。
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** FileJournal 的只读同口径：撕裂尾行忽略，中间坏行照抛。 */
function readRuntimeFile(file: RuntimeFile): Event[] {
  const lines = readFileSync(file.path, "utf8").split("\n");
  const events: Event[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      events.push(eventFromDict(JSON.parse(line)));
    } catch (error) {
      const tail = lines.slice(index + 1).every((candidate) => candidate.trim() === "");
      if (tail && error instanceof SyntaxError) break;
      throw error;
    }
  }
  return events;
}

const SENSITIVE_FIELD = /^(?:pass(?:word|wd)?|pwd|token|(?:access|refresh|id)[_. -]?token|api[_. -]?key|authorization|cookie|secret|credential|client[_. -]?secret|private[_. -]?key)$/iu;

/** 字段名与高置信度 token 形状双层打码；返回值保留原 JSON 结构，UI 才能分 Input/Output。 */
function redactRuntimeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  budget = { nodes: 20_000 },
): [unknown, boolean] {
  if (budget.nodes-- <= 0) return ["…（日志过大，已截断）", false];
  if (typeof value === "string") {
    const [safe, redacted] = redactSecrets(value);
    return [safe, redacted];
  }
  if (value === null || typeof value !== "object") return [value, false];
  if (seen.has(value as object)) return ["[Circular]", false];
  seen.add(value as object);
  let hit = false;
  if (Array.isArray(value)) {
    const out = value.map((item) => {
      const [safe, redacted] = redactRuntimeValue(item, seen, budget);
      hit ||= redacted;
      return safe;
    });
    return [out, hit];
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD.test(key)) {
      out[key] = "***已打码***";
      hit = true;
      continue;
    }
    const [safe, redacted] = redactRuntimeValue(item, seen, budget);
    out[key] = safe;
    hit ||= redacted;
  }
  return [out, hit];
}

function runtimeStatus(events: Event[], quarantined: boolean): string {
  if (quarantined) return "quarantined";
  if (events.some((event) => event.kind === "run.failed" || event.kind === "effect.failed" || event.kind === "node.failed")) return "failed";
  if (events.some((event) => event.kind === "run.suspended")) return "suspended";
  if (events.some((event) => event.kind === "run.completed")) return "completed";
  return "recorded";
}

function safeRuntimeEvent(event: Event): Record<string, unknown> {
  const [safe, redacted] = redactRuntimeValue(eventToDict(event));
  return { ...(safe as Record<string, unknown>), redacted };
}

function isAdmin(c: Context<AppEnv>): boolean {
  return c.get("user")?.role === "admin";
}

/**
 * 这条会话该不该给这个人看。三档，次序不能反：
 *
 *   1. 开放模式（合成管理员 `__local__`）—— 不隔离，全见，与 /api/sessions 同一条规则
 *   2. 管理员 —— 跨账号全见
 *   3. 其他人 —— 只有 owner 是自己的
 *
 * 看不到一律当作**不存在**（404），不回 403 —— 403 等于告诉对方"这个 id 存在，
 * 只是不属于你"，而 id 本身就是信息。
 */
async function visibleSession(c: Context<AppEnv>, sid: string): Promise<SessionRow | null> {
  const row = await currentRepo().getSession(sid);
  if (row === null) return null;
  if (!isolate(c)) return row;
  if (isAdmin(c)) return row;
  return row.owner !== "" && row.owner === ownerId(c) ? row : null;
}

export function registerLogRoutes(app: Hono<AppEnv>): void {
  // ── 会话清单 ─────────────────────────────────────────────────
  app.get("/api/logs/sessions", async (c) => {
    const repo = currentRepo();
    const admin = isAdmin(c);
    const iso = isolate(c);
    const seeAll = admin || !iso;
    // **query 上的 owner 只对管理员生效**，否则任何人改一个参数就读到别人的。
    const asked = (c.req.query("owner") ?? "").trim();
    const owner = seeAll ? (asked === "" ? null : asked) : ownerId(c);
    const rows = await repo.listSessions({ owner, limit: SESSION_MAX });
    // 归属显示成人名而不是一串 hex。只有能看全部的人才需要这张表。
    const users = seeAll ? await repo.listUsers() : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return c.json({
      can_see_all: seeAll,
      sessions: rows.map((r) => {
        const u = byId.get(r.owner);
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          created: r.created,
          owner: r.owner,
          // owner 为空 = 开放模式或迁移前留下的旧会话，明说，别显示成空白让人以为是 bug。
          owner_name: u ? u.display_name || u.username : r.owner === "" ? "（无归属）" : "",
        };
      }),
      // 命中上限就说出来，别让人以为总共就这些。
      truncated: rows.length >= SESSION_MAX,
    });
  });

  // ── 一个会话的事件（摘要 + 分页）─────────────────────────────
  app.get("/api/logs/sessions/:sid/events", async (c) => {
    const sid = c.req.param("sid");
    const row = await visibleSession(c, sid);
    if (row === null) throw apiError(404, "会话不存在");
    const since = Math.max(0, optionalIntQuery(c, "since", 0));
    const limit = Math.max(1, Math.min(optionalIntQuery(c, "limit", 200), PAGE_MAX));
    // 多读一条来判断"还有没有下一页"，比再打一次 COUNT 便宜。
    const rows = await currentRepo().readEvents(sid, { since, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const kind = (c.req.query("kind") ?? "").trim();
    const shown = kind === "" ? page : page.filter((r) => r.kind === kind);
    const last = page[page.length - 1];
    return c.json({
      session: { id: row.id, title: row.title, owner: row.owner },
      total: await currentRepo().countEvents(sid),
      events: shown.map(briefOf),
      // 游标是**下一条的 seq**，不是条数 —— seq 可能有洞（删过/迁移过）。
      next_since: rows.length > limit && last !== undefined ? last.seq + 1 : null,
    });
  });

  // ── 单条事件的全文 ───────────────────────────────────────────
  app.get("/api/logs/sessions/:sid/events/:seq", async (c) => {
    const sid = c.req.param("sid");
    if ((await visibleSession(c, sid)) === null) throw apiError(404, "会话不存在");
    const seq = Number.parseInt(c.req.param("seq"), 10);
    if (!Number.isFinite(seq)) throw apiError(400, "seq 必须是整数");
    const rows = await currentRepo().readEvents(sid, { since: seq, limit: 1 });
    const row = rows[0];
    if (row === undefined || row.seq !== seq) throw apiError(404, "没有这条事件");
    // eventRowAsSse：前端已经认识这个扁平形状（SSE 走的就是它），不发明第二种。
    const flat = eventRowAsSse(row);
    const [safe, redacted] = redactSecrets(JSON.stringify(flat) ?? "");
    return c.json({ ...(JSON.parse(safe) as Record<string, unknown>), redacted });
  });

  // ── 内核执行账本（run 列表 + 事件）────────────────────────────
  // session_event 是给产品 UI 的投影；这里读 Recorder journal，补回 effect、node、
  // critic、gate、budget 以及 blob ref 等完整执行元数据。输入摘要若历史上已经截断，
  // fidelity 明确标 digest，绝不把不可恢复的内容伪装成全文。
  app.get("/api/logs/sessions/:sid/runtime/runs", async (c) => {
    const sid = c.req.param("sid");
    const row = await visibleSession(c, sid);
    if (row === null) throw apiError(404, "会话不存在");
    const runLimit = Math.max(1, Math.min(optionalIntQuery(c, "limit_runs", 12), RUNTIME_RUN_MAX));
    const eventLimit = Math.max(1, Math.min(optionalIntQuery(c, "limit_events", 800), RUNTIME_EVENT_MAX));
    const files = runtimeFiles(row.id);
    const selected = files.slice(0, runLimit);
    const runs = selected.map((file) => {
      const all = readRuntimeFile(file);
      const events = all.slice(0, eventLimit);
      const first = all[0];
      const last = all[all.length - 1];
      return {
        id: file.runId,
        quarantined: file.quarantined,
        status: runtimeStatus(all, file.quarantined),
        event_count: all.length,
        started_at_ms: first?.tsMs ?? null,
        ended_at_ms: last?.tsMs ?? null,
        truncated: all.length > eventLimit,
        events: events.map(safeRuntimeEvent),
      };
    });
    return c.json({
      session: { id: row.id, title: row.title, owner: row.owner },
      runs,
      total_runs: files.length,
      truncated: files.length > runLimit,
    });
  });

  // 大 output 按需解 blob。ref 只能来自服务端在该 run 中读到的事件，客户端不能
  // 自己提交 blob ref，因而无法借这个入口探测同会话外的文件。
  app.get("/api/logs/sessions/:sid/runtime/runs/:runId/events/:seq", async (c) => {
    const sid = c.req.param("sid");
    const row = await visibleSession(c, sid);
    if (row === null) throw apiError(404, "会话不存在");
    const runId = c.req.param("runId");
    const file = runtimeFiles(row.id).find((candidate) => candidate.runId === runId);
    if (!file) throw apiError(404, "没有这次运行");
    const seq = Number.parseInt(c.req.param("seq"), 10);
    if (!Number.isSafeInteger(seq) || seq < 0) throw apiError(400, "seq 必须是非负整数");
    const event = readRuntimeFile(file).find((candidate) => candidate.seq === seq);
    if (!event) throw apiError(404, "没有这条执行事件");
    let resolved: unknown = null;
    let resolveError = "";
    if (event.ref) {
      try { resolved = await new FileBlobStore(join(root(), row.id, "blobs")).getJson(event.ref); }
      catch (error) { resolveError = error instanceof Error ? error.message : String(error); }
    }
    const safeEvent = safeRuntimeEvent(event);
    const [safeResolved, resolvedRedacted] = redactRuntimeValue(resolved);
    return c.json({
      event: safeEvent,
      resolved: safeResolved,
      resolve_error: resolveError,
      // 新 journal 的 effect.requested.ref 是完整 request；没有 ref 的历史事件或
      // 捕获失败事件仍只有 digest。先判 ref，不能把 requested 一律标成摘要。
      fidelity: event.ref ? "full" : event.kind === "effect.requested" ? "digest" : "inline",
      redacted: resolvedRedacted || safeEvent["redacted"] === true,
    });
  });
}
