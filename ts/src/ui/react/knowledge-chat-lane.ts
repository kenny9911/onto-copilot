// 知识库页上那条对话栏的开关。
//
// ## 为什么单独一个文件（第三次了）
//
// 开关它的人有两个：页头那颗「对话」按钮（knowledge-page.tsx）、以及知识库里
// 任何一个「让 Copilot 来做」按钮（knowledge-library.tsx —— 预填了却看不见输入框
// 等于什么也没发生）。让后者去 import 前者会长出
//
//   knowledge-page → knowledge-workspace → knowledge-library → knowledge-page
//
// 这个仓库这一轮已经为同类环付过两次代价（stream-scroll.ts、knowledge-events.ts）。
// 第三次就不猜了，直接放叶子。
//
// 这个文件只 import `./store.js`（那是 React 状态容器，不反向依赖任何视图）。
//
// ## 状态为什么挂在 body 上而不是 React state
//
// 要生效的是 index.template.html 里那一组
// `body.knowledge-page-open.kb-chat-open .main>...` 的网格规则，而 `.main`、
// `.stream`、`.comp` 都长在冻结的 HTML 上，不归 React 管。

import { bumpUi } from "./store.js";

const CHAT_CLASS = "kb-chat-open";

export function knowledgeChatOpen(): boolean {
  return typeof document !== "undefined" && document.body.classList.contains(CHAT_CLASS);
}

export function setKnowledgeChatOpen(open: boolean): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle(CHAT_CLASS, open);
  bumpUi();
}

/** 发送、或点了「让 Copilot 来做」时用：栏关着就打开它，而不是把人送走。 */
export function openKnowledgeChat(): void {
  if (!knowledgeChatOpen()) setKnowledgeChatOpen(true);
}

/** 离开知识库页时清掉：这个 class 带回聊天页会让 .main 保持网格布局。 */
export function clearKnowledgeChatLane(): void {
  if (typeof document === "undefined") return;
  document.body.classList.remove(CHAT_CLASS);
}
