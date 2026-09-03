// 对话：发送 / 停止 / 打字机 / 气泡 / 轮次合并。
import { G } from "./state.js";
import { $, esc, j } from "./dom.js";
import { t } from "./i18n.js";
import { md } from "./md.js";
import { newSession } from "./sessions.js";
import { render } from "./render.js";

// ── 对话 ────────────────────────────────────────────────────────
// 输入框在梳理进行中也可用。发出去的话不阻塞流水线，后端按意图决定是立即执行
// 还是排到本轮结束 —— 前端不做这个判断。
/** 轮次是不是正在路上。CHAT_ABORT 非空 = 这条 fetch 还没回来。 */
function chatInFlight(): boolean { return !!G.CHAT_ABORT; }

/** 排队。**不发也不丢** —— 硬发会撞服务端的 409，而那条错误会永久卡在气泡流里。 */
export function enqueueChat(text: string){
  G.QUEUED.push(text);
  render();
}

/** 撤回一条排队的话。**文字退回输入框**，不是丢掉 —— 用户敲的字只有他自己能决定作废。 */
export function withdrawQueued(i: number){
  const text = G.QUEUED[i];
  if (text === undefined) return;
  G.QUEUED.splice(i, 1);
  const el = $("cin");
  if (el) {
    el.value = el.value ? `${text}\n${el.value}` : text;
    autoGrow(el);
    el.focus();
  }
  render();
}

/** 插队：停掉当前这一轮，立刻发这条。
 *
 * **这是"中途调整方向"唯一能兑现的形态。** 真正的中途注入做不到：模型正在一个
 * 已经定型的上下文里推理，把新指令塞进去要么得重启这一轮（刚烧的 token 全废），
 * 要么追加到它已经推理过的上下文后面（输出前后矛盾）。停止 + 重发是确定的。 */
export async function sendQueuedNow(i: number){
  const text = G.QUEUED[i];
  if (text === undefined) return;
  G.QUEUED.splice(i, 1);
  if (chatInFlight()) await stopChat();
  await deliverChat(text);
}

/** 轮次落地后把队首发出去。停止后**不自动发** —— 他按停止是有理由的，
 *  队列还在，要发自己点。 */
function drainQueue(){
  const next = G.QUEUED.shift();
  if (next !== undefined) void deliverChat(next);
}

export async function sendChat(){
  const el = $("cin");
  const text = (el.value || "").trim();
  if (!text) return;
  // 没会话就建一个 —— 想说话之前先点「新会话」是多余的一步
  if (!G.S) await newSession(true);
  el.value = ""; autoGrow(el);
  // 轮次还在跑：排队，别硬发。以前这里直接发，服务端回 409，前端把那句 JSON
  // 原样贴成一条**永远不会消失**的错误气泡（它是 assistant 气泡，而清除逻辑
  // 只按 SSE 回来的 user turn 文本匹配删 —— 永远匹配不上）。
  if (chatInFlight()) { enqueueChat(text); return; }
  await deliverChat(text);
}

/** 真正发出去的那一段。sendChat / 队列出队 / 插队 三条路都汇到这里。 */
async function deliverChat(text: string){
  if (!G.S) await newSession(true);
  // 上一次失败留下的错误气泡在这一刻作废 —— 它讲的是上一次的事，
  // 留着会让人以为这一轮也失败了。
  G.PENDING = G.PENDING.filter((x: any) => !x.error);
  let landed = false;
  // 乐观上屏：网络往返期间用户要能看见自己说了什么，否则会以为没发出去
  G.PENDING.push({speaker:"user", text, pending:true});
  G.STEPS = [];
  // 上一轮的追问在这一刻就作废：它们是**针对上一个回答**的。留着的话，这一轮
  // 若被停止或发失败，屏幕上会浮出一批看似新鲜、其实答非所问的旧提示。
  // 清空不会留下空档 —— 思考中本来就不画 chips，落地时 res.followups 顶上，
  // 顶不上还有 G.PROMPTS。
  G.FOLLOWUPS = [];
  startThinking();
  // 每一轮挂一个 AbortController，停止按钮据此 abort 掉这条 fetch，前端不再干等。
  G.CHAT_ABORT = new AbortController();
  try {
    const res = await j(`/api/sessions/${G.S.id}/chat`, {method:"POST",
      headers:{"content-type":"application/json"},
      signal: G.CHAT_ABORT.signal,
      body: JSON.stringify({text, confirm: G.CONFIRM_NEXT, lang:G.LANG})});
    // 确认是**一轮限定**的，不是给会话开长期后门
    G.CONFIRM_NEXT = false;
    // 被停止：占位气泡由 SSE 的「（已停止）」chat.turn 接管。提示还是要收下 ——
    // 停下来之后「接下来干什么」比平时更需要一个出口。
    G.FOLLOWUPS = res.followups || [];
    if (res.stopped) return;
    G.NEEDS_CONFIRM = !!res.needs_confirm;
    // **只有真的跑完一轮才继续排队。** 这个标记不能省：见下面 finally 的注释。
    landed = true;
  } catch (e: any) {
    // 是我们自己 abort 的（点了停止），不是错误 —— 别弹"没发出去"
    if (e.name === "AbortError") return;
    // 409 = 会话忙（多开一个标签页、或上一轮的租约还没还）。这不是错误，是时序：
    // 把这句话放回队列，等当前那轮落地自己会发出去。**绝不能把用户的字弄丢。**
    if (e.status === 409) { enqueueChat(text); return; }
    // 其余才是真错。e.message 现在是服务端那句人话，不再是 JSON 原文（见 dom.ts 的 j）。
    G.PENDING.push({speaker:"assistant", text:"没发出去：" + e.message, error:true});
  } finally {
    G.CHAT_ABORT = null;
    stopThinking();
    render();
    // **只在这一轮真的落地后才出队。**
    //
    // 无条件出队会炸：409 时上面刚把这句话放回队列，finally 立刻又把它取出来重发，
    // 又 409、又入队、又取出 —— 转个不停。而且递归那一层开头的
    // `PENDING.filter(x => !x.error)` 还会把刚推上去的错误气泡擦掉，于是屏幕上
    // 既没有错误提示也没有排队项，用户只看到自己的话凭空消失了。
    //
    // 失败和停止都不自动续发：那两种情况下用户需要先看一眼发生了什么，
    // 队列还在，要发他自己点。
    if (landed) drainQueue();
  }
}

// 发送 ⇄ 停止：一个按钮四种状态。**前景优先** —— 对话轮在跑就先停它；否则输入框
// 有字就是发送（梳理跑着也能插话，这是这产品的定义性交互）；再否则梳理在跑就停梳理。
export function paintSendBtn(){
  const btn = $("send");
  if (!btn) return;
  const hasText = ($("cin")?.value || "").trim().length > 0;
  const runActive = ["queued","parsing","extracting"].includes(G.S?.status);
  // **有字就先管字。** 原来是 `G.THINKING ? "stopChat" : …`，于是轮次在跑时按钮
  // 一律变成停止 —— 而回车走的是 sendChat（现在会排队）。同一个动作两条路两种
  // 结果，用户没法预期。现在的规则是一句话：**输入框里有字，按钮就作用于那些字；
  // 没字才作用于正在跑的东西。**
  const mode = hasText ? "send"
             : G.THINKING ? "stopChat"
             : runActive ? "stopRun"
             : "send";
  const stop = mode !== "send";
  btn.classList.toggle("stop", stop);
  btn.textContent = stop ? "■" : "↑";
  btn.title = stop ? t("composer.stop","停止") : t("composer.send","发送");
  btn.setAttribute("aria-label", btn.title);
  btn.disabled = !G.S;
  btn.onclick = mode === "stopChat" ? stopChat
              : mode === "stopRun"  ? stopRun
              : sendChat;
  // 输入框的流光跟"有没有事在跑"同步。**状态源就用这里已经算好的两个** ——
  // 另起一套判断迟早会和按钮的形态对不上（按钮显示■、边框却不亮）。
  document.querySelector(".cbox")?.classList.toggle("thinking", G.THINKING || runActive);
  document.getElementById("stream")?.setAttribute("aria-busy", String(G.THINKING || runActive));
}

// 停对话轮：abort 掉自己那条 fetch（立刻不等），再并发 /stop 让服务端真的停下来。
export async function stopChat(){
  if (!G.S) return;
  G.CHAT_ABORT?.abort();
  stopThinking();
  try {
    await j(`/api/sessions/${G.S.id}/stop`, {method:"POST",
      headers:{"content-type":"application/json"}, body: JSON.stringify({target:"chat"})});
  } catch (e: any) { /* 停止本身失败无所谓，abort 已让前端归位 */ }
  // abort 把那条 /chat 的响应连同它带的 chips 一起丢了 —— 服务端为这一轮算好的
  // 那批只落进了会话状态。去把它取回来，否则停止之后剩下的是一批开场白：
  // 第一条往往正是他十轮前问过的那句。
  try {
    const st = await j(`/api/sessions/${G.S.id}/state`);
    G.FOLLOWUPS = st.followups || [];
  } catch (e: any) { /* 取不回就退回 G.PROMPTS，render 那边有兜底 */ }
  render();
}

// 停梳理任务：状态与事件由 SSE 的 run.cancelled + /state 刷新驱动，这里只发指令。
export async function stopRun(){
  if (!G.S) return;
  try {
    await j(`/api/sessions/${G.S.id}/stop`, {method:"POST",
      headers:{"content-type":"application/json"}, body: JSON.stringify({target:"run"})});
  } catch (e: any) { /* 忽略 */ }
}


// 点一条提示 = 把它当成用户自己打的字发出去。**不走特殊路径** ——
// 特殊路径会和手打的行为漂移，而漂移的那天你不知道该信哪个。
export async function ask(text: any){
  const el = $("cin");
  el.value = text;
  await sendChat();
}

export async function confirmAct(){
  G.CONFIRM_NEXT = true; G.NEEDS_CONFIRM = false;
  $("cin").value = "确认执行";
  await sendChat();
}

export function autoGrow(el: any){
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

// 回车发送、Shift+回车换行。输入法组词期间的回车不能当发送 ——
// 中文用户按回车选词时会把半截词发出去。
export function bindComposer(){
  const el = $("cin");
  let composing = false;
  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => { composing = false; });
  el.addEventListener("input", () => { autoGrow(el); paintSendBtn(); });
  el.addEventListener("keydown", (e: any) => {
    if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing) {
      e.preventDefault(); sendChat();
    }
  });
}

// 推理卡（.steps）与「正在思考」那颗占位气泡（.bub.oc.think）已经是组件 ——
// <StepsCard> / <ThinkingBubble>，住在 react/chat.tsx，由 <Stream> 摆进消息流。
// 这个模块只留不碰 DOM 的那一半：发送 / 停止 / 计时 / 打字机 / 轮次合并。

// 计时器：超过几秒的等待，用户需要看见"它还在动"而不只是三个点。

export function startThinking(){
  G.THINKING = true; G.THINK_T0 = Date.now();
  clearInterval(G.THINK_TIMER);
  G.THINK_TIMER = setInterval(() => {
    const el = document.getElementById("tsec");
    if (el) el.textContent = ` ${((Date.now() - G.THINK_T0) / 1000).toFixed(0)}s`;
  }, 500);
  render();
}
export function stopThinking(){
  G.THINKING = false; clearInterval(G.THINK_TIMER); G.THINK_TIMER = null;
  // 自己收尾，别指望调用方接着 render()。六个调用点里有一半不 render ——
  // 漏掉哪个，输入框的流光就一直转下去，看着像还在跑，其实早停了。
  paintSendBtn();
}

// 助手回答的打字机流式呈现。后端一次性给完整 turn，这里在前端按段揭示 ——
// 「思考」气泡收起后，答案一段段流出来，而不是整块蹦出来。
export function startStream(text: any){
  if (G.STREAM) clearInterval(G.STREAM.timer);
  // **按墙钟时间揭示，不按 tick 数。** 以前是每 tick 推进固定字数，而浏览器在
  // 标签页切走时会把 setInterval 节流到一秒甚至几秒一次 —— 实测切后台后 47 秒
  // 才推进 21/68 个字。用户回来看到的就是一条卡在半截的回答，只能刷新。
  // 改成按经过的时间算进度：无论 tick 多稀，到点就是全文。
  const DUR = 900;                       // 整段揭示时长（毫秒），与长度无关
  G.STREAM = { full: text || "", i: 0, timer: null, t0: Date.now() };
  try { render(); } catch (e: any) {}         // 首帧画不出来也要把流跑起来
  G.STREAM.timer = setInterval(() => {
    if (!G.STREAM){ return; }
    const p = Math.min(1, (Date.now() - G.STREAM.t0) / DUR);
    G.STREAM.i = Math.ceil(G.STREAM.full.length * p);
    const done = p >= 1;
    const timer = G.STREAM.timer;
    // 画这一帧。**整段包在 try 里**：渲染再怎么出错，也不能挡住下面的收尾 ——
    // 否则这条流永远结束不了，定时器一直空转。
    //
    // 以前这里走的是捷径：直接往最后一颗 `.stream .bub.oc .mdbody` 里写 innerHTML，
    // 只有找不到那颗气泡时才整体重画。#stream 归 React 之后这条捷径**必须拆掉** ——
    // React 按自己上一次的虚拟树 diff，在它背后换掉真实 DOM，下一次更新轻则丢节点、
    // 重则抛 NotFoundError。截断进度（G.STREAM.i）与那根光标由 <Bubble> 自己从 G 读，
    // 这里只负责推进进度、通知重画。滚到底也一样，搬进了 <Stream> 的布局副作用。
    try { render(); } catch (e: any) { /* 这一帧没画上，下一帧再说；收尾照常走 */ }
    if (done){
      clearInterval(timer);
      G.STREAM = null;
      // 收尾重画一次，让最终文本落进正常渲染路径，而不是只躺在那次直写里。
      try { render(); } catch (e: any) {}
    }
  }, 16);
}

// 对话记录只能**按身份合并**，不能盲追加、更不能整体覆盖。两条真实的 bug 都出在
// 这一点上：
//
//   * 盲追加 → 每条消息两遍。/state 已经带回了完整的 dialogue，而 SSE 断线重连
//     固定用 ?since=0、从耐久事件表把同样的 chat.turn 再重放一遍。刷新一次就翻倍。
//   * 整体覆盖 → 回答被吞。question.updated/audit.applied 这类事件会触发一次
//     /state 重取，回来后 Object.assign 把整个 state 换掉；如果那次请求发出时
//     助手这一轮还没落库，回来的 dialogue 里就没有它，于是 SSE 刚推上来的回答被
//     覆盖掉 —— 屏幕上只剩追问 chips，刷新才看得到。
//
// 身份取 说话人+时间戳+正文：同一条消息无论从哪条路来，这三样都一样。
export const turnKey = (t: any) => `${t.speaker}|${t.ts}|${t.text}`;

export function addTurn(turn: any){
  const d = (G.S.state.dialogue = G.S.state.dialogue || {turns: []});
  const k = turnKey(turn);
  const i = d.turns.findIndex((x: any) => turnKey(x) === k);
  if (i >= 0) { d.turns[i] = {...d.turns[i], ...turn}; return; }
  d.turns.push(turn);
  d.turns.sort((a: any, b: any) => (+a.ts || 0) - (+b.ts || 0));
  // 回执到了，撤掉对应的乐观占位
  if (turn.speaker === "user") G.PENDING = G.PENDING.filter(x => x.text !== turn.text);
}

//: 把服务端那份**权威**对话并进来，而不是拿它整体替换 —— 替换会丢掉此刻刚由
//  SSE 推上来、服务端那次查询还没看到的轮次。
export function mergeTurns(serverTurns: any){
  for (const t of serverTurns || []) addTurn(t);
}

// /state 的对话位于 ``st.state.dialogue``，不是响应顶层。先保存远端对象，再做
// Object.assign；随后用一个新容器保留服务端 decisions/compactions 等元数据，并把
// 请求期间由 SSE 抵达的本地轮次与远端轮次合并。绝不能先清空 st.state.dialogue：
// G.S.state 与 st.state 在 assign 后是同一引用，那样会连远端快照一起抹掉。
export function mergeStateSnapshot(st: any){
  const evs = G.S.events;
  const mine = [...(G.S.state?.dialogue?.turns || [])];
  const remote = st.state?.dialogue || {turns: []};
  Object.assign(G.S, st); G.S.events = evs;
  G.S.state = G.S.state || {};
  G.S.state.dialogue = {...remote, turns: []};
  mergeTurns(mine); mergeTurns(remote.turns);
}

// 对话气泡是 <Bubble>（react/chat.tsx）。与推理轨迹卡片刻意用不同的视觉语言 ——
// 轨迹是"系统在做事"，气泡是"人在说话"。
