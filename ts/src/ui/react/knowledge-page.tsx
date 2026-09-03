import { useEffect, type ReactElement } from "react";

import { G } from "../state.js";
import { registerRegion } from "./app.js";
import { bumpUi, setUi, useUi } from "./store.js";
import { KnowledgeWorkspace } from "./knowledge-workspace.js";

const HASH = "#knowledge";

/**
 * 知识库的两个层级。
 *
 * `global` 是**公共知识库**：不选项目也能打开。产品要求原话——「这个知识库是应该
 * 可以直接去访问的，应该有一个总的知识库」。在此之前侧栏那颗按钮在会话没归项目时
 * 是禁用的，提示写着「请先打开一个已归入项目的会话」。
 */
export type KnowledgeTarget = "global" | "project";

function setHash(open: boolean, replace = false): void {
  if (typeof window === "undefined") return;
  const next = open ? HASH : `${window.location.pathname}${window.location.search}`;
  if (open && window.location.hash === HASH) return;
  if (!open && window.location.hash !== HASH) return;
  const state = { ...(window.history.state ?? {}), ocPage: open ? "knowledge" : "chat" };
  if (replace) window.history.replaceState(state, "", next);
  else window.history.pushState(state, "", next);
}

/**
 * 打开知识库。
 *
 * 公共库恒可打开 —— 它不依赖会话，也不依赖项目。只有项目库才需要当前会话
 * 已经归入某个项目；此时若条件不满足，就退回公共库而不是什么都不做
 * （旧实现是 `if (!G.S?.id || !G.S?.project_id) return;`，按钮点了没反应）。
 */
export function openKnowledgePage(target: KnowledgeTarget = "global"): void {
  const canProject = Boolean(G.S?.id && G.S?.project_id);
  setUi({ MAIN_PAGE: "knowledge", KNOWLEDGE_TARGET: target === "project" && canProject ? "project" : "global" });
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
      // 公共库不依赖会话，所以这里不再要求 project_id —— 否则刷新一次就被弹回聊天。
      const next = window.location.hash === HASH ? "knowledge" : "chat";
      if (G.MAIN_PAGE !== next) {
        G.MAIN_PAGE = next;
        bumpUi();
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    if (window.location.hash === HASH && !active) sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [active, session?.id, session?.project_id]);

  if (!active) return null;
  const files = Array.isArray(session?.filelist) ? session.filelist : [];
  const canProject = Boolean(session?.id && session?.project_id);
  const target: KnowledgeTarget = ui.KNOWLEDGE_TARGET === "project" && canProject ? "project" : "global";
  const isGlobal = target === "global";

  return <main className="knowledge-page-shell" aria-label="知识库">
    {/* 页头极简：一个标题、一个层级切换、一个返回。
        原来这里还有一行「集中管理项目材料、准确版本、解析状态和 AI 可核对的原文
        证据」—— 说明书式的句子，用户每次进来都要读一遍，而它并不帮他找到文件。 */}
    <header className="knowledge-page-head">
      <div className="kp-title">
        <h1>{isGlobal ? "公共知识库" : `${String(project?.name ?? "项目")} · 知识库`}</h1>
        <nav className="kp-level" aria-label="知识库层级">
          <button type="button" className={isGlobal ? "on" : ""}
            onClick={() => setUi({ KNOWLEDGE_TARGET: "global" })}>公共</button>
          <button type="button" className={isGlobal ? "" : "on"} disabled={!canProject}
            title={canProject ? "当前项目的知识库" : "当前会话还没有归入项目"}
            onClick={() => setUi({ KNOWLEDGE_TARGET: "project" })}>当前项目</button>
        </nav>
      </div>
      {/* 显式“返回会话”替换当前 #knowledge 记录，避免用户下一次按浏览器返回时
          又被送回刚刚关闭的知识库；浏览器自身的前进/后退仍由 popstate 同步。 */}
      <button type="button" className="act"
        onClick={() => closeKnowledgePage({ replaceHistory: true })}>返回会话</button>
    </header>
    <div className="knowledge-page-body">
      <KnowledgeWorkspace
        key={`${target}:${String(session?.id ?? "")}`}
        level={target}
        sessionId={String(session?.id ?? "")}
        sessionFiles={isGlobal ? [] : files.map((file: any) => ({
          name: String(file?.name ?? ""),
          state: String(file?.state ?? ""),
          issue: String(file?.issue ?? ""),
        })).filter((file: { name: string }) => Boolean(file.name))}
      />
    </div>
  </main>;
}

registerRegion("knowledgePage", KnowledgePage);
