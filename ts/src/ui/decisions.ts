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
//
// **这次点击的结局必须说出来。** 以前这里没有 catch：跑批激活期服务端回 409
// （mutation 租约必拒），异常穿过 pending.tsx 的 `.finally()` 变成一条 unhandled
// rejection —— 用户看到的是「点了没反应」，而他刚刚做的是这个产品里最贵的一次
// 输入（2026-08-25 用户实拍）。现在服务端跑批时改成**排队**，于是有三种结局，
// 三种都要讲清楚：已落账（安静刷新）、已登记（说明何时生效）、真失败（报出来）。
export async function postAnswer(qid: any, conflictRid: any){
  const oid = G.ANSWERS[qid];
  if (!oid) return;
  try {
    const r: any = await j(`/api/sessions/${G.S.id}/answer`, {method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({conflict_rid: conflictRid, option_id: oid, note: "由 FDE 在界面上确认", lang:G.LANG})});
    if (r?.queued) alert(r.message || "会话正在梳理，这次确认已经登记，本轮跑完自动落账。");
    await refresh();
  } catch (e: any) {
    alert(`没有确认成功：${e?.message || e}`);
  }
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
