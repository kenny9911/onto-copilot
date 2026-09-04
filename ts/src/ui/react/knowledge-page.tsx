import { useEffect, type ReactElement } from "react";

import { G } from "../state.js";
import { registerRegion } from "./app.js";
import { bumpUi, setUi, useUi } from "./store.js";
import { KnowledgeWorkspace } from "./knowledge-workspace.js";
import { stickStreamToBottom } from "./stream.js";

const HASH = "#knowledge";

/**
 * 知识库的两个层级。
 *
 * `global` 是**公共知识库**：不选项目也能打开。产品要求原话——「这个知识库是应该
 * 可以直接去访问的，应该有一个总的知识库」。在此之前侧栏那颗按钮在会话没归项目时
 * 是禁用的，提示写着「请先打开一个已归入项目的会话」。
 */
export type KnowledgeTarget = "global" | "project";

/**
 * 知识库页上的对话栏开着没有。
 *
 * 用户原话：「当我在知识库中输入对话，但是这个是不显示对话的，这个请你思考一下
 * 该如何设计。」在此之前的答法是 chat.ts:66 的「发送即把人踢回聊天页」——
 * 那是在回答他「你不能在这里对话」，而他要的正是能。
 *
 * 默认关着：进这一页是来读材料的，不该一上来就被切掉三分之一。发送的时候若它
 * 还关着，自动打开（openKnowledgeChat）—— 那一刻用户已经用行动说了他要看回答。
 *
 * 挂在 body 上而不是 React state，因为要生效的是 index.template.html 里那一组
 * `body.knowledge-page-open.kb-chat-open .main>...` 的网格规则，而 .main / .stream
 * 都长在冻结的 HTML 上，不归 React 管。
 */
const CHAT_CLASS = "kb-chat-open";

export function knowledgeChatOpen(): boolean {
  return typeof document !== "undefined" && document.body.classList.contains(CHAT_CLASS);
}

export function setKnowledgeChatOpen(open: boolean): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle(CHAT_CLASS, open);
  bumpUi();
}

/** 发送时用：栏关着就打开它，而不是把人送走。 */
export function openKnowledgeChat(): void {
  if (!knowledgeChatOpen()) setKnowledgeChatOpen(true);
}

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
 * 公共库恒可打开 —— 它不依赖会话，也不依赖项目。
 *
 * **项目库只要有会话就能打开，不再看 `project_id`。** 这一条改过两次，第二次
 * 是被用户的截图逼出来的：他会话里有 6 份材料，页面写着「0 份材料」，一条路都
 * 没有。根因是前端这个判据和后端对不上 —— 真实库里 33/42 个会话 `project_id`
 * 为空，而后端 `document_scope.ts` 早就不 409 了，它会给这种会话懒建一个叫
 * 「我的材料」的默认项目，材料照样存得进去。前端却拿一个后端已经不用的字段
 * 把人挡在门外，然后把他送进一个**结构上不可能装着他那 6 份材料**的公共库。
 * 一个说 0 的界面，比一个说"不行"的界面更伤人 —— 它看起来像东西丢了。
 */
export function openKnowledgePage(target: KnowledgeTarget = "global"): void {
  const canProject = Boolean(G.S?.id);
  setUi({
    MAIN_PAGE: "knowledge",
    KNOWLEDGE_TARGET: target === "project" && canProject ? "project" : "global",
    KNOWLEDGE_TOUCHED: true,
  });
  setHash(true);
}

export function closeKnowledgePage(options: { replaceHistory?: boolean } = {}): void {
  // 这个 class 只在知识库页上有意义；带回聊天页会让 .main 保持网格布局。
  if (typeof document !== "undefined") document.body.classList.remove(CHAT_CLASS);
  // 消息流在这一页上是 display:none，藏着的时候量不出滚动位置。回聊天的这一刻
  // 恰恰是最需要看见最新一轮的时刻 —— 人多半是刚在这一页问完一句才回来的。
  stickStreamToBottom();
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
  const chatOpen = knowledgeChatOpen();
  const files = Array.isArray(session?.filelist) ? session.filelist : [];
  const canProject = Boolean(session?.id);
  // 默认落在**有他材料的那一层**。KNOWLEDGE_TARGET 的初值是 "global"（state.ts），
  // 而按 hash 直接进来（刷新、书签、浏览器后退）不经过 openKnowledgePage，于是
  // 一个会话里躺着 6 份材料的人，刷新一次就被送进空的公共库。
  // 公共库只在**没有会话可谈**时才是合理的落点。
  const target: KnowledgeTarget = canProject
    ? (ui.KNOWLEDGE_TARGET === "global" && ui.KNOWLEDGE_TOUCHED === true ? "global" : "project")
    : "global";
  const isGlobal = target === "global";

  return <main className="knowledge-page-shell" aria-label="知识库">
    {/* 页头极简：一个标题、一个层级切换、一个返回。
        原来这里还有一行「集中管理项目材料、准确版本、解析状态和 AI 可核对的原文
        证据」—— 说明书式的句子，用户每次进来都要读一遍，而它并不帮他找到文件。 */}
    <header className="knowledge-page-head">
      <div className="kp-title">
        {/* 没归项目的会话落在后端懒建的「我的材料」里 —— 标题就照实说这个名字，
            不要写「项目 · 知识库」去指一个用户从没建过的东西。 */}
        <h1>{isGlobal ? "公共知识库" : `${String(project?.name ?? "我的材料")} · 知识库`}</h1>
        <nav className="kp-level" aria-label="知识库层级">
          {/* KNOWLEDGE_TOUCHED 记的是「这一层是人自己挑的」。没有它就分不清
              "初值恰好是 global" 和 "他刚点了公共"，切过去会被下一次渲染弹回来。 */}
          <button type="button" className={isGlobal ? "on" : ""}
            onClick={() => setUi({ KNOWLEDGE_TARGET: "global", KNOWLEDGE_TOUCHED: true })}>公共</button>
          <button type="button" className={isGlobal ? "" : "on"} disabled={!canProject}
            title={canProject ? "这个会话的材料" : "先打开一个会话"}
            onClick={() => setUi({ KNOWLEDGE_TARGET: "project", KNOWLEDGE_TOUCHED: true })}>{project?.name ?? "我的材料"}</button>
        </nav>
      </div>
      <div className="kp-acts">
        {/* 对话栏开关。写「对话」而不是一个字形 —— 这一页上另一个类似位置的
            按钮（返回会话）也是中文，两者是同级的去处选择。 */}
        <button type="button" className={`act${chatOpen ? " pri" : ""}`}
          aria-pressed={chatOpen}
          title={chatOpen ? "收起对话栏，材料占满整页" : "在这一页旁边打开对话，边读边问"}
          onClick={() => setKnowledgeChatOpen(!chatOpen)}>对话</button>
        {/* 显式“返回会话”替换当前 #knowledge 记录，避免用户下一次按浏览器返回时
            又被送回刚刚关闭的知识库；浏览器自身的前进/后退仍由 popstate 同步。 */}
        <button type="button" className="act"
          onClick={() => closeKnowledgePage({ replaceHistory: true })}>返回会话</button>
      </div>
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
