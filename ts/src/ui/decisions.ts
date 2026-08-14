// 待办卡片背后的三个动作：选一个选项 / 提交答复 / 采纳一条建议。
//
// 卡片本身（决策 + 建议 + 那个可折叠的外壳）是 <PendingCard> / <DecisionCards> /
// <SuggestionCards>，住在 react/pending.tsx。以前和它们一起的 pick() /
// submitAnswer() 也没了 —— 那两个是内联 JS 时代「自己动手改 .sel、把按钮文字换成
// 提交中…」的做法，组件从 G.ANSWERS 和自己的 busy 状态推得出这两件事。
import { G } from "./state.js";
import { $, j } from "./dom.js";
import { refresh } from "./sessions.js";
import { sendChat } from "./chat.js";

// 只发请求，一个 DOM 节点都不碰。
export async function postAnswer(qid: any, conflictRid: any){
  const oid = G.ANSWERS[qid];
  if (!oid) return;
  await j(`/api/sessions/${G.S.id}/answer`, {method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({conflict_rid: conflictRid, option_id: oid, note: "由 FDE 在界面上确认", lang:G.LANG})});
  await refresh();
}

/** 选一个选项。**只改状态** —— .sel 与「确认」按钮的可用性由组件从 G.ANSWERS 推出来。 */
export function pickAnswer(qid: any, oid: any){ G.ANSWERS[qid] = oid; }

// 采纳走对话通道，和用户自己打字说「第 N 条建议采纳」完全同一条路径 ——
// 两条路径会漂移，而漂移的那天你不会知道该信哪个。
export async function adopt(n: any){
  const el = $("cin");
  el.value = `第${n}条建议采纳`;
  await sendChat();
}
