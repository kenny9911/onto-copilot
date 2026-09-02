import { useEffect, type ReactElement } from "react";

import { G } from "../state.js";
import { registerRegion } from "./app.js";
import { bumpUi, setUi, useUi } from "./store.js";
import { KnowledgeWorkspace } from "./knowledge-workspace.js";

const HASH = "#knowledge";

function setHash(open: boolean, replace = false): void {
  if (typeof window === "undefined") return;
  const next = open ? HASH : `${window.location.pathname}${window.location.search}`;
  if (open && window.location.hash === HASH) return;
  if (!open && window.location.hash !== HASH) return;
  const state = { ...(window.history.state ?? {}), ocPage: open ? "knowledge" : "chat" };
  if (replace) window.history.replaceState(state, "", next);
  else window.history.pushState(state, "", next);
}

export function openKnowledgePage(): void {
  if (!G.S?.id || !G.S?.project_id) return;
  setUi({ MAIN_PAGE: "knowledge" });
  setHash(true);
}

export function closeKnowledgePage(options: { replaceHistory?: boolean } = {}): void {
  if (G.MAIN_PAGE !== "chat") setUi({ MAIN_PAGE: "chat" });
  setHash(false, options.replaceHistory === true);
}

export function KnowledgePage(): ReactElement | null {
  const ui = useUi();
  const active = ui.MAIN_PAGE === "knowledge";
  const session = ui.S;
  const project = ui.PROJECTS.find((row: any) => String(row?.id ?? "") === String(session?.project_id ?? ""));

  useEffect(() => {
    if (typeof document !== "undefined") document.body.classList.toggle("knowledge-page-open", active);
    return () => { if (typeof document !== "undefined") document.body.classList.remove("knowledge-page-open"); };
  }, [active]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = (): void => {
      const next = window.location.hash === HASH && G.S?.id && G.S?.project_id ? "knowledge" : "chat";
      if (G.MAIN_PAGE !== next) {
        G.MAIN_PAGE = next;
        bumpUi();
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    if (window.location.hash === HASH && session?.id && session?.project_id && !active) sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [active, session?.id, session?.project_id]);

  if (!active) return null;
  const files = Array.isArray(session?.filelist) ? session.filelist : [];
  return <main className="knowledge-page-shell" aria-label="项目知识库页面">
    <header className="knowledge-page-head">
      <div>
        <span>项目 / {String(project?.name ?? session?.project_name ?? "当前项目")}</span>
        <h1>项目知识库</h1>
        <p>集中管理项目材料、准确版本、解析状态和 AI 可核对的原文证据。</p>
      </div>
      {/* 显式“返回会话”替换当前 #knowledge 记录，避免用户下一次按浏览器返回时
          又被送回刚刚关闭的知识库；浏览器自身的前进/后退仍由 popstate 同步。 */}
      <button type="button" className="act"
        onClick={() => closeKnowledgePage({ replaceHistory: true })}>返回会话</button>
    </header>
    <div className="knowledge-page-body">
      <KnowledgeWorkspace
        key={String(session?.id ?? "")}
        sessionId={String(session?.id ?? "")}
        sessionFiles={files.map((file: any) => ({
          name: String(file?.name ?? ""),
          state: String(file?.state ?? ""),
          issue: String(file?.issue ?? ""),
        })).filter((file: { name: string }) => Boolean(file.name))}
      />
    </div>
  </main>;
}

registerRegion("knowledgePage", KnowledgePage);
