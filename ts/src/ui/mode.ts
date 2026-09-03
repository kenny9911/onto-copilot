// 聊天 / 工作 双模式。
import { G } from "./state.js";
import { render } from "./render.js";
import { paint } from "./preview.js";
import { loadSessions } from "./sessions.js";

// ── 启动 ────────────────────────────────────────────────────────
export function applyMode(){
  document.querySelector(".app").classList.toggle("mode-chat", G.MODE === "chat");
  document.querySelectorAll("#modetog button").forEach((b: any) =>
    b.classList.toggle("on", b.dataset.mode === G.MODE));
  document.querySelectorAll("#modetog button").forEach((b: any) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === G.MODE)));
}
// 聊天 = 纯对话（右侧工作面板收起、无材料/产物）；工作 = 完整工作台。
export function setMode(m: any){
  G.MODE = (m === "chat") ? "chat" : "work";
  localStorage.setItem("oc_mode", G.MODE);
  applyMode();
  if (G.S) { render(); paint(); }
  // 侧栏两个模式各一份列表，切过去必须重画：以前不重画，切到聊天看到的还是工作
  // 那批会话 —— 加上项目分组之后这更不能忍，聊天模式里不该有任何项目痕迹。
  loadSessions();
}
