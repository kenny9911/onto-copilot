// 全量日志 tab 的取数与状态。
//
// **为什么是设置弹窗里的一个 tab 而不是独立弹窗**：模板 `ui/index.template.html`
// 的 CSS + HTML 被 `verify-ui-shell.mjs` 钉在一个 git blob 上逐字节比对。加一个
// `#logsModal` 就要往模板里加 HTML 和 CSS，那道守卫会多一处红（它现在已经因为
// 右栏改版是红的）。设置弹窗的 `#setTabs` / `#setBody` 是现成的 React region，
// 复用它一个字节都不用碰模板。
//
// 数据全部来自 `/api/logs/*`，而那批路由读的是 `session_event` —— 与聊天流里的
// TRACE、与事后重放看到的是同一份东西，不是另一套埋点。

import { j } from "./dom.js";
import { bumpUi } from "./react/store.js";

export interface LogSessionRow {
  id: string;
  title: string;
  status: string;
  created: number;
  owner: string;
  owner_name: string;
}

export interface LogEventBrief {
  seq: number;
  kind: string;
  ts: number;
  event_id: string;
  bytes: number;
  preview: string;
  truncated: boolean;
  redacted: boolean;
}

/** 日志 tab 的全部状态。挂在模块里而不是 G 上：它只服务这一个 tab，
 *  塞进 G 会让每次 bumpUi 都带着一坨与当前视图无关的东西。 */
export const LOGB = {
  loading: "",
  error: "",
  /** 能不能看到别人的（管理员或开放模式）。决定要不要显示「归属」这一列。 */
  canSeeAll: false,
  sessions: [] as LogSessionRow[],
  /** 当前展开的会话；空 = 还停在清单页。 */
  openSid: "",
  openTitle: "",
  events: [] as LogEventBrief[],
  total: 0,
  nextSince: null as number | null,
  /** 只看某一类事件。空 = 全部。 */
  kind: "",
  /** 展开看全文的那一条：seq → 全文 JSON 字符串。 */
  full: new Map<number, string>(),
};

export function resetLogs(): void {
  LOGB.openSid = ""; LOGB.openTitle = ""; LOGB.events = [];
  LOGB.total = 0; LOGB.nextSince = null; LOGB.kind = ""; LOGB.full.clear();
}

export async function loadLogSessions(): Promise<void> {
  LOGB.loading = "加载中…"; LOGB.error = ""; resetLogs(); bumpUi();
  try {
    const r = await j("/api/logs/sessions");
    LOGB.canSeeAll = !!r.can_see_all;
    LOGB.sessions = (r.sessions || []) as LogSessionRow[];
    LOGB.loading = "";
  } catch (e: any) {
    LOGB.loading = ""; LOGB.error = String(e?.message || e);
  }
  bumpUi();
}

/** 打开一个会话的事件流。`since=0` 表示从头读（切换 kind 时也走这条）。 */
export async function loadLogEvents(sid: string, title: string, since = 0): Promise<void> {
  LOGB.loading = "加载中…"; LOGB.error = "";
  if (since === 0) { LOGB.events = []; LOGB.full.clear(); }
  LOGB.openSid = sid; LOGB.openTitle = title;
  bumpUi();
  try {
    const q = new URLSearchParams({ since: String(since), limit: "200" });
    if (LOGB.kind) q.set("kind", LOGB.kind);
    const r = await j(`/api/logs/sessions/${encodeURIComponent(sid)}/events?${q.toString()}`);
    // 翻页是**追加**不是替换 —— 替换的话点"更多"会把已经读过的那批冲掉。
    LOGB.events = since === 0 ? (r.events || []) : LOGB.events.concat(r.events || []);
    LOGB.total = r.total || 0;
    LOGB.nextSince = r.next_since ?? null;
    LOGB.loading = "";
  } catch (e: any) {
    LOGB.loading = ""; LOGB.error = String(e?.message || e);
  }
  bumpUi();
}

/** 展开单条的全文。已经取过就直接收起，不重复打网络。 */
export async function toggleLogFull(seq: number): Promise<void> {
  if (LOGB.full.has(seq)) { LOGB.full.delete(seq); bumpUi(); return; }
  try {
    const r = await j(`/api/logs/sessions/${encodeURIComponent(LOGB.openSid)}/events/${seq}`);
    LOGB.full.set(seq, JSON.stringify(r, null, 2));
  } catch (e: any) {
    LOGB.full.set(seq, `读取失败：${String(e?.message || e)}`);
  }
  bumpUi();
}

export function setLogKind(kind: string): void {
  LOGB.kind = kind;
  if (LOGB.openSid) void loadLogEvents(LOGB.openSid, LOGB.openTitle, 0);
  else bumpUi();
}

export function backToLogSessions(): void { resetLogs(); bumpUi(); }

/** 给 settings.ts 的 renderSettingsShell 用。 */
export function loadAndRenderLogs(): void { void loadLogSessions(); }
