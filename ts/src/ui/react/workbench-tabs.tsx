/**
 * 右侧工作台的顶层资源页签。
 *
 * 「工作台」是固定页：它承载 ContextSidebar 现有六个页面，永远存在、不可关闭。
 * 文件、画布和网页是与它并列的资源页；切资源只隐藏工作台，不卸载它，因此模型
 * 筛选、审阅草稿、Canvas 视图状态不会因为查看一份材料而丢失。
 *
 * 这个模块刻意不知道网页如何抓取、AI 如何总结，也不知道 ContextViewer 的类型。
 * 它只保存可序列化的 target 并把 renderer 注入点交给装配层。
 */
import {
  useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode,
} from "react";

export const WORKBENCH_TAB_ID = "workbench";
export const WORKBENCH_OPEN_EVENT = "oc:workbench-open";
export const WORKBENCH_ADD_EVENT = "oc:workbench-add-request";

export type WorkbenchResourceKind = "web" | "file" | "context";

/**
 * 页签层只认这些通用字段。`viewer` 由 ContextSidebar 放入 ContextViewerTarget；
 * 网页层则使用 pageId/url/viewState。以后接浏览器后端不需要修改 tab store。
 */
export interface WorkbenchResourceTarget<TViewer = unknown> {
  kind: WorkbenchResourceKind;
  /** 相同 key 永远复用同一个页签。未传时按 kind + pageId/id/url 生成。 */
  key?: string;
  id?: string;
  title: string;
  pageId?: string;
  url?: string;
  favicon?: string;
  viewState?: Record<string, unknown>;
  viewer?: TViewer;
}

export interface WorkbenchResourceTab<TViewer = unknown> {
  id: string;
  key: string;
  target: WorkbenchResourceTarget<TViewer>;
}

export interface WorkbenchTabsState<TViewer = unknown> {
  sessionId: string;
  resources: Array<WorkbenchResourceTab<TViewer>>;
  activeId: string;
  /** 最近使用在前；工作台也参与 MRU，关闭当前资源后回到真正的上一页。 */
  mru: string[];
}

export type WorkbenchResourcePatch<TViewer = unknown> = Partial<
  Omit<WorkbenchResourceTarget<TViewer>, "kind" | "key">
>;

export type WorkbenchTabsAction<TViewer = unknown> =
  | { type: "open"; target: WorkbenchResourceTarget<TViewer> }
  | { type: "patch"; id: string; patch: WorkbenchResourcePatch<TViewer> }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "replace"; state: WorkbenchTabsState<TViewer> };

const STORAGE_VERSION = 1;
const MAX_RESTORED_TABS = 24;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizedUrl(value: unknown): string {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

/** 只允许可在内嵌网页视图安全导航的 http(s) URL；裸域名默认补 https。 */
export function normalizeSafeWebUrl(value: unknown): string | null {
  const raw = clean(value);
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 稳定身份只描述资源，不描述滚动位置等 viewState。 */
export function workbenchResourceKey(target: WorkbenchResourceTarget): string {
  const explicit = clean(target.key);
  if (explicit) return explicit;
  const identity = clean(target.pageId) || clean(target.id) || normalizedUrl(target.url) || clean(target.title);
  return `${target.kind}:${identity}`;
}

function resourceTabId(key: string): string {
  return `resource:${key}`;
}

function touch(mru: string[], id: string): string[] {
  return [id, ...mru.filter((candidate) => candidate !== id)];
}

function knownIds<TViewer>(state: WorkbenchTabsState<TViewer>): Set<string> {
  return new Set([WORKBENCH_TAB_ID, ...state.resources.map((tab) => tab.id)]);
}

/**
 * 网页首次通常只有 URL，服务端完成快照后才补 pageId。两者是同一资源身份的
 * 不同成熟阶段，不能因为 key 从 URL 形态变成 pageId 形态就新开第二个 tab。
 * established key 仍由既有 tab 持有；这里只负责识别别名。
 */
function sameResourceTarget<TViewer>(
  tab: WorkbenchResourceTab<TViewer>,
  target: WorkbenchResourceTarget<TViewer>,
  candidateKey: string,
): boolean {
  if (tab.target.kind !== target.kind) return false;
  if (tab.key === candidateKey) return true;
  const pageId = clean(target.pageId);
  if (pageId && pageId === clean(tab.target.pageId)) return true;
  const url = normalizedUrl(target.url);
  return Boolean(url && url === normalizedUrl(tab.target.url));
}

export function emptyWorkbenchTabs<TViewer = unknown>(sessionId: string): WorkbenchTabsState<TViewer> {
  return { sessionId, resources: [], activeId: WORKBENCH_TAB_ID, mru: [WORKBENCH_TAB_ID] };
}

/** 纯 reducer，浏览器事件和 localStorage 都不参与，便于把 MRU/去重钉成合同。 */
export function reduceWorkbenchTabs<TViewer>(
  state: WorkbenchTabsState<TViewer>,
  action: WorkbenchTabsAction<TViewer>,
): WorkbenchTabsState<TViewer> {
  if (action.type === "replace") return action.state;

  if (action.type === "open") {
    const key = workbenchResourceKey(action.target);
    const existing = state.resources.find((tab) => sameResourceTarget(tab, action.target, key));
    if (existing) {
      const viewState = action.target.viewState === undefined
        ? existing.target.viewState
        : { ...(existing.target.viewState ?? {}), ...action.target.viewState };
      const target: WorkbenchResourceTarget<TViewer> = {
        ...existing.target,
        ...action.target,
        kind: existing.target.kind,
        key: existing.key,
      };
      if (viewState !== undefined) target.viewState = viewState;
      const resources = state.resources.map((tab) => tab.id === existing.id ? { ...tab, target } : tab);
      return { ...state, resources, activeId: existing.id, mru: touch(state.mru, existing.id) };
    }
    const id = resourceTabId(key);
    return {
      ...state,
      resources: [...state.resources, { id, key, target: action.target }],
      activeId: id,
      mru: touch(state.mru, id),
    };
  }

  if (action.type === "activate") {
    if (!knownIds(state).has(action.id)) return state;
    return { ...state, activeId: action.id, mru: touch(state.mru, action.id) };
  }

  if (action.type === "patch") {
    if (!state.resources.some((tab) => tab.id === action.id)) return state;
    const resources = state.resources.map((tab) => {
      if (tab.id !== action.id) return tab;
      const viewState = action.patch.viewState === undefined
        ? tab.target.viewState
        : { ...(tab.target.viewState ?? {}), ...action.patch.viewState };
      const target: WorkbenchResourceTarget<TViewer> = {
        ...tab.target,
        ...action.patch,
        kind: tab.target.kind,
        // 一旦形成 tab，逻辑 key 就必须显式留在轻量 target 中。网页首次由 URL
        // 打开、随后拿到 pageId 时，跨重启仍应回到同一 tab，而不是换一套身份。
        key: tab.key,
      };
      if (viewState !== undefined) target.viewState = viewState;
      return { ...tab, target };
    });
    // 内容回填不是一次导航：activeId 与 MRU 必须原样保留。否则隐藏网页的
    // 慢响应会在用户已经切走后抢回焦点，并把“上一页”历史污染掉。
    return { ...state, resources };
  }

  // 固定工作台不可关闭；不存在的 id 也不产生一次无意义的 state 更新。
  if (action.id === WORKBENCH_TAB_ID || !state.resources.some((tab) => tab.id === action.id)) return state;
  const resources = state.resources.filter((tab) => tab.id !== action.id);
  const remaining = new Set([WORKBENCH_TAB_ID, ...resources.map((tab) => tab.id)]);
  const mru = state.mru.filter((id) => id !== action.id && remaining.has(id));
  const activeId = state.activeId === action.id ? (mru[0] ?? WORKBENCH_TAB_ID) : state.activeId;
  return { ...state, resources, activeId, mru: mru.length ? mru : [WORKBENCH_TAB_ID] };
}

export function workbenchTabsStorageKey(sessionId: string): string {
  return `oc_workbench_tabs_v${STORAGE_VERSION}:${encodeURIComponent(sessionId || "__none__")}`;
}

function isResourceKind(value: unknown): value is WorkbenchResourceKind {
  return value === "web" || value === "file" || value === "context";
}

/**
 * `oc:workbench-open` 的公开输入边界。网页调用方只需发
 * `{kind:'web', pageId?, url, title?}`；畸形事件不会污染 store。
 */
export function normalizeWorkbenchTarget<TViewer = unknown>(
  raw: unknown,
): WorkbenchResourceTarget<TViewer> | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (!isResourceKind(source.kind)) return null;
  const rawUrl = clean(source.url);
  const url = source.kind === "web" ? normalizeSafeWebUrl(rawUrl) ?? "" : rawUrl;
  const pageId = clean(source.pageId);
  const id = clean(source.id);
  if (source.kind === "web" && !url) return null;
  if (source.kind !== "web" && !id && !source.viewer && !url) return null;
  const fallback = source.kind === "web" ? url : id || clean(source.key);
  const title = clean(source.title) || fallback || (source.kind === "web" ? "网页" : "资源");
  const target: WorkbenchResourceTarget<TViewer> = { kind: source.kind, title };
  const key = clean(source.key);
  const favicon = clean(source.favicon);
  if (key) target.key = key;
  if (id) target.id = id;
  if (pageId) target.pageId = pageId;
  if (url) target.url = url;
  if (favicon) target.favicon = favicon;
  if (source.viewState && typeof source.viewState === "object" && !Array.isArray(source.viewState)) {
    target.viewState = source.viewState as Record<string, unknown>;
  }
  if (source.viewer) target.viewer = source.viewer as TViewer;
  return target;
}

export function loadWorkbenchTabs<TViewer = unknown>(sessionId: string): WorkbenchTabsState<TViewer> {
  const fallback = emptyWorkbenchTabs<TViewer>(sessionId);
  if (!sessionId) return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(workbenchTabsStorageKey(sessionId)) || "null") as any;
    if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.resources)) return fallback;
    const resources: Array<WorkbenchResourceTab<TViewer>> = [];
    const keys = new Set<string>();
    for (const candidate of parsed.resources.slice(0, MAX_RESTORED_TABS)) {
      const target = normalizeWorkbenchTarget<TViewer>(candidate?.target);
      if (!target) continue;
      const key = workbenchResourceKey(target);
      if (keys.has(key)) continue;
      keys.add(key);
      resources.push({ id: resourceTabId(key), key, target });
    }
    const ids = new Set([WORKBENCH_TAB_ID, ...resources.map((tab) => tab.id)]);
    const savedMru = Array.isArray(parsed.mru) ? parsed.mru.map(clean).filter((id: string) => ids.has(id)) : [];
    const activeId = ids.has(clean(parsed.activeId)) ? clean(parsed.activeId) : WORKBENCH_TAB_ID;
    const mru = [activeId, ...savedMru, WORKBENCH_TAB_ID]
      .filter((id, index, all) => ids.has(id) && all.indexOf(id) === index);
    return { sessionId, resources, activeId, mru };
  } catch {
    return fallback;
  }
}

export function saveWorkbenchTabs<TViewer>(state: WorkbenchTabsState<TViewer>): void {
  if (!state.sessionId) return;
  try {
    const resources = state.resources.map((tab) => {
      const source = tab.target;
      const target: WorkbenchResourceTarget = { kind: source.kind, title: source.title };
      if (source.key) target.key = source.key;
      if (source.id) target.id = source.id;
      if (source.pageId) target.pageId = source.pageId;
      if (source.url) target.url = source.url;
      if (source.favicon) target.favicon = source.favicon;
      // viewer 可能携带整棵 OIR/Flow，甚至由注入 renderer 放入不可序列化值。
      // localStorage 只记轻量身份与有限 viewState；运行期 target 仍完整保留。
      if (source.viewState) {
        try {
          const encoded = JSON.stringify(source.viewState);
          if (encoded.length <= 64_000) target.viewState = JSON.parse(encoded) as Record<string, unknown>;
        } catch { /* 单个 viewState 不可序列化时只丢它，不连累整组 tabs。 */ }
      }
      return { id: tab.id, key: tab.key, target };
    });
    localStorage.setItem(workbenchTabsStorageKey(state.sessionId), JSON.stringify({
      version: STORAGE_VERSION,
      activeId: state.activeId,
      mru: state.mru,
      resources,
    }));
  } catch {
    // 隐私模式、配额不足或某个注入 viewer 不可序列化时，当前挂载周期仍可正常使用。
  }
}

export interface WorkbenchTabsController<TViewer = unknown> {
  state: WorkbenchTabsState<TViewer>;
  open: (target: WorkbenchResourceTarget<TViewer>) => void;
  updateWithoutActivate: (id: string, patch: WorkbenchResourcePatch<TViewer>) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
}

/** 会话切换先换 read namespace，再持久化；绝不把上一会话的 tabs 写进新会话。 */
export function useWorkbenchTabs<TViewer = unknown>(sessionId: string): WorkbenchTabsController<TViewer> {
  const [state, setState] = useState<WorkbenchTabsState<TViewer>>(() => loadWorkbenchTabs<TViewer>(sessionId));

  useEffect(() => {
    if (state.sessionId !== sessionId) setState(loadWorkbenchTabs<TViewer>(sessionId));
  }, [sessionId, state.sessionId]);

  useEffect(() => {
    if (state.sessionId === sessionId) saveWorkbenchTabs(state);
  }, [sessionId, state]);

  return useMemo(() => ({
    state,
    open: (target: WorkbenchResourceTarget<TViewer>) => setState((current) =>
      reduceWorkbenchTabs(current, { type: "open", target })),
    updateWithoutActivate: (id: string, patch: WorkbenchResourcePatch<TViewer>) => setState((current) =>
      reduceWorkbenchTabs(current, { type: "patch", id, patch })),
    activate: (id: string) => setState((current) => reduceWorkbenchTabs(current, { type: "activate", id })),
    close: (id: string) => setState((current) => reduceWorkbenchTabs(current, { type: "close", id })),
  }), [state]);
}

function domToken(id: string): string {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function targetIcon(target: WorkbenchResourceTarget): string {
  if (target.kind === "web") return "◎";
  if (target.kind === "file") return "▤";
  return "◇";
}

function tabsInOrder<TViewer>(state: WorkbenchTabsState<TViewer>): Array<{ id: string; title: string; target?: WorkbenchResourceTarget<TViewer> }> {
  return [
    { id: WORKBENCH_TAB_ID, title: "工作台" },
    ...state.resources.map((tab) => ({ id: tab.id, title: tab.target.title, target: tab.target })),
  ];
}

export interface WorkbenchTabShellProps<TViewer = unknown> {
  controller: WorkbenchTabsController<TViewer>;
  workbench: ReactNode;
  renderResource: (target: WorkbenchResourceTarget<TViewer>, tab: WorkbenchResourceTab<TViewer>) => ReactNode;
  onActivate?: (id: string) => void;
  onClose?: (tab: WorkbenchResourceTab<TViewer>) => void;
}

/** 顶层壳。所有 sibling page 同时挂载，`hidden` 只管可见性。 */
export function WorkbenchTabShell<TViewer = unknown>({
  controller, workbench, renderResource, onActivate, onClose,
}: WorkbenchTabShellProps<TViewer>): ReactElement {
  const { state } = controller;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlError, setUrlError] = useState("");
  const stripRef = useRef<any>(null);
  const urlInputRef = useRef<any>(null);
  const tabs = tabsInOrder(state);

  const activate = (id: string): void => {
    controller.activate(id);
    onActivate?.(id);
    setOverflowOpen(false);
  };
  const close = (tab: WorkbenchResourceTab<TViewer>): void => {
    controller.close(tab.id);
    onClose?.(tab);
    setOverflowOpen(false);
  };
  const focusTab = (id: string): void => {
    stripRef.current?.querySelector(`[data-workbench-tab="${domToken(id)}"]`)?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent, id: string): void => {
    const index = tabs.findIndex((tab) => tab.id === id);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if ((event.key === "Delete" || event.key === "Backspace") && id !== WORKBENCH_TAB_ID) {
      const resource = state.resources.find((tab) => tab.id === id);
      if (!resource) return;
      event.preventDefault();
      close(resource);
      const nextId = state.mru.find((candidate) => candidate !== id) ?? WORKBENCH_TAB_ID;
      setTimeout(() => focusTab(nextId), 0);
      return;
    } else return;
    event.preventDefault();
    const nextId = tabs[next]?.id;
    if (!nextId) return;
    activate(nextId);
    focusTab(nextId);
  };
  const toggleAdd = (): void => {
    const next = !addOpen;
    setAddOpen(next);
    setUrlError("");
    setOverflowOpen(false);
    if (next) {
      window.dispatchEvent(new CustomEvent(WORKBENCH_ADD_EVENT));
      setTimeout(() => urlInputRef.current?.focus(), 0);
    }
  };
  const submitUrl = (event: FormEvent): void => {
    event.preventDefault();
    const url = normalizeSafeWebUrl(urlDraft);
    if (!url) {
      setUrlError("请输入有效的 http(s) 网页地址");
      return;
    }
    const parsed = new URL(url);
    controller.open({ kind: "web", url, title: parsed.hostname.replace(/^www\./iu, "") || url });
    setUrlDraft("");
    setUrlError("");
    setAddOpen(false);
  };

  return <div className="wb-shell" data-active-kind={state.activeId === WORKBENCH_TAB_ID ? "workbench" : "resource"}>
    <div className="wb-tabbar">
      <div className="wb-tabs-scroll" role="tablist" aria-label="工作台与打开的资源" ref={stripRef}>
        {tabs.map((tab) => {
          const selected = state.activeId === tab.id;
          const resource = state.resources.find((candidate) => candidate.id === tab.id);
          return <div className={`wb-tab-wrap ${selected ? "on" : ""}`} key={tab.id}>
            <button type="button" role="tab" aria-selected={selected}
              aria-controls={`wb-panel-${domToken(tab.id)}`}
              id={`wb-tab-${domToken(tab.id)}`}
              tabIndex={selected ? 0 : -1}
              data-workbench-tab={domToken(tab.id)}
              className="wb-tab"
              title={tab.title}
              onKeyDown={(event) => onTabKeyDown(event, tab.id)}
              onClick={() => activate(tab.id)}>
              <span className="wb-tab-icon" aria-hidden="true">{tab.target
                ? (tab.target.favicon ? <img src={tab.target.favicon} alt="" /> : targetIcon(tab.target))
                : "⌂"}</span>
              <span className="wb-tab-title">{tab.title}</span>
            </button>
            {resource ? <button type="button" className="wb-tab-close"
              aria-label={`关闭 ${tab.title}`}
              title={`关闭 ${tab.title}`}
              onClick={() => close(resource)}>×</button> : null}
          </div>;
        })}
      </div>
      <button type="button" className="wb-tab-add" aria-label="打开资源" title="打开网页或文件"
        aria-expanded={addOpen} aria-controls="wb-add-resource"
        onClick={toggleAdd}>＋</button>
      <div className="wb-overflow-wrap">
        <button type="button" className="wb-tab-overflow" aria-label="所有打开的资源"
          aria-haspopup="menu" aria-expanded={overflowOpen}
          onClick={() => setOverflowOpen((open) => !open)}>•••</button>
        {overflowOpen ? <div className="wb-overflow" role="menu">
          {tabs.map((tab) => <button type="button" role="menuitem" key={tab.id}
            className={state.activeId === tab.id ? "on" : ""}
            onClick={() => activate(tab.id)}>
            <span>{tab.target ? targetIcon(tab.target) : "⌂"}</span>
            <span>{tab.title}</span>
          </button>)}
        </div> : null}
      </div>
    </div>
    {addOpen ? <form className="wb-add-resource" id="wb-add-resource" onSubmit={submitUrl}>
      <label htmlFor="wb-add-url">打开网页</label>
      <input id="wb-add-url" ref={urlInputRef} type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" value={urlDraft}
        aria-invalid={urlError ? "true" : "false"}
        aria-describedby={urlError ? "wb-add-url-error" : undefined}
        placeholder="https://example.com"
        onChange={(event) => { setUrlDraft(event.target.value); if (urlError) setUrlError(""); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setAddOpen(false); setUrlError(""); }
        }} />
      <button type="submit" className="act pri">打开</button>
      <button type="button" className="act" onClick={() => { setAddOpen(false); setUrlError(""); }}>取消</button>
      {urlError ? <span className="wb-add-error" id="wb-add-url-error" role="alert">{urlError}</span> : null}
    </form> : null}

    <section id={`wb-panel-${domToken(WORKBENCH_TAB_ID)}`} role="tabpanel"
      aria-labelledby={`wb-tab-${domToken(WORKBENCH_TAB_ID)}`}
      className="wb-page wb-workbench-page" hidden={state.activeId !== WORKBENCH_TAB_ID}>
      {workbench}
    </section>
    {state.resources.map((tab) => <section key={tab.id}
      id={`wb-panel-${domToken(tab.id)}`} role="tabpanel"
      aria-labelledby={`wb-tab-${domToken(tab.id)}`}
      className="wb-page wb-resource-page" hidden={state.activeId !== tab.id}>
      {renderResource(tab.target, tab)}
    </section>)}
  </div>;
}
