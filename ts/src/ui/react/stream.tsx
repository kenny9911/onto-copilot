// 聊天流 #stream 的主人。
//
// 这是用户 90% 时间在看的那块屏幕，也是 render.ts 里最长的那一段。搬过来的是
// **整段**：空状态、开场提示、推理轨迹、待办卡、时间线（气泡 + 事件卡）、乐观上屏
// 的气泡、推理卡、「正在思考」占位、推荐问题 chips、确认闸。类名与嵌套逐字对齐
// 原来的模板字符串 —— 767 行 CSS 认的是 `.wrap` `.empty` `.esub` `.sug` `.ph` `.ic`
// `.pchips` `.pchip` `.cfm` `.act.pri` 这些选择器，少一个类名就是少一块样式。
//
// ## 一个容器只能有一个主人
//
// 从 registerRegion("stream", Stream) 这一行起，**任何代码都不许再往 #stream 里写
// innerHTML**。React 按自己上一次的虚拟树 diff，别人在它背后换掉真实 DOM 之后，
// 下一次更新轻则丢节点、重则抛 NotFoundError。已经拆掉的那条捷径是打字机
// （chat.ts 的 startStream）：它以前每 16ms 直接往最后一颗 `.mdbody` 写一次
// innerHTML，现在只推进 G.STREAM.i 然后 render() —— 截断由 <Bubble> 自己做。
//
// 唯一还允许命令式碰 #stream 的是下面 useStreamEffects() 那两件事：给新气泡加
// `.in`、以及滚到底。**它们碰的都不是结构**：一个只往已有节点加类名（React 不会
// 因为 className 这个 prop 没变而重写它），一个只改容器自己的 scrollTop。
//
// ## chips 的两条规矩不在这里
//
// 「这一轮还在路上就不画」和「追问为空退回开场那批」写在 <ChatChips> 自己身上
// （react/chat.tsx）—— 拆到调用方去写，迟早有一个调用点只抄了一半。这里只管把它
// 摆在消息流的哪个位置。

import { useEffect, useLayoutEffect, type ReactNode } from "react";

import { greetLine } from "../auth.js";
import { confirmAct } from "../chat.js";
import { $ } from "../dom.js";
import { timeline } from "../events.js";
import { G } from "../state.js";
import { startBuild } from "../upload.js";
import { registerRegion } from "./app.js";
import { Bubble, ChatChips, IntroChips, StepsCard, ThinkingBubble } from "./chat.js";
import { EvCard, TraceCard } from "./events.js";
import { PendingCard } from "./pending.js";
import { Placeholder } from "./preview.js";
import { bumpUi, useUi } from "./store.js";

// ── 入场动画与滚到底 ─────────────────────────────────────────────

// 哪些气泡该播入场动画。
//
// 难点在于 render() 是整段重画：每次轮询之后所有气泡都是新造的 DOM，CSS 分不出
// "这条刚到"和"这条已经在屏幕上五分钟了"。所以在 JS 这边记一个数——上次这个会话
// 画出了几条气泡，这次超出的那些才是新的，只给它们加 .in。
//
// 换会话时把计数直接对齐总数：载入一段三十条的历史，不该三十条一起飞进来。

export function markNewBubbles(box: any){
  // **排除「思考中」那颗占位气泡。** 它和真气泡一样是 .bub，但会被答案替换掉：
  // 算进来的话，那一步是「思考中 -1、答案 +1」，净变化为零，于是助手的回答 ——
  // 整个界面上最该被看见的那条 —— 反而是唯一拿不到入场动画的。
  const bubs = box.querySelectorAll(".bub:not(.think)");
  const sid  = G.S?.id || null;
  if (sid !== G.SEEN_SID){ G.SEEN_SID = sid; G.SEEN_BUBBLES = bubs.length; return; }
  for (let i = G.SEEN_BUBBLES; i < bubs.length; i++) bubs[i].classList.add("in");
  // 只增不减会让删了消息之后的新气泡不播动画，取当前值而不是取大值。
  G.SEEN_BUBBLES = bubs.length;
}

/** 「离底不到这么多像素就算在底部」。原来那句 `< 120` 的那个 120。 */
const NEAR_BOTTOM = 120;

/**
 * 用户是不是还贴着底。
 *
 * 旧代码在**替换 innerHTML 之前**当场量一次；React 下没有那个时刻（渲染与提交
 * 是两步，量到的已经是新内容）。所以改成跟着滚动事件记：用户往上翻就记 false，
 * 翻回底部记 true。程序自己滚到底也会触发一次 scroll，于是自动回到 true ——
 * 和旧行为一致：**只要人在底部，新消息就跟着上来；人翻上去看历史，就别抢他的位置。**
 */
let atBottom = true;

function useStreamEffects(): void {
  useEffect(() => {
    const box = $("stream");
    if (!box?.addEventListener) return;
    const onScroll = (): void => {
      atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    };
    box.addEventListener("scroll", onScroll);
    return () => { box.removeEventListener("scroll", onScroll); };
  }, []);
  // **useLayoutEffect 而不是 useEffect**：滚动位置要在浏览器画这一帧之前就位，
  // 晚一帧的话新消息会先在半截位置闪一下再跳到底。
  useLayoutEffect(() => {
    const box = $("stream");
    if (!box) return;
    markNewBubbles(box);
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

// ── 空状态 ──────────────────────────────────────────────────────
/**
 * 空状态**不是一个终点，是一块内容**。
 *
 * 用户完全可能还没上传材料就先聊起来（「我手上有三份材料，先跟你说说背景」），
 * 这恰恰是最常见的入口 —— 所以它返回的是一块可以和气泡并存的东西，<Stream> 据此
 * 决定是「只画它」还是「把它钉在消息流最上方」。**返回 null 就是没有空状态**，
 * 这一个判据两处都用，不会出现「只有 chips 没有问候语」的那一屏。
 *
 * 问候语只在**还没开口**时出现：有对话时 intro 会被钉在流的最上方，不分叉的话
 * 「欢迎回来，张三」会永久挂在一段半年前的五十轮对话顶上。
 */
function intro(G: any, hasChat: boolean): ReactNode {
  if (!G.S.files) {
    return (
      <div className="empty"><h3>OntoCopilot</h3>
        {hasChat ? null : <div className="esub">{greetLine()}</div>}
      </div>
    );
  }
  if (!G.S.events.length && G.S.status === "idle") {
    return (
      <div className="empty"><h3>{G.S.files} 份材料已读完</h3>
        <button className="sug" onClick={() => { void startBuild(undefined); }}>开始梳理</button>
      </div>
    );
  }
  return null;
}

/**
 * 确认闸。**挡的是模型自作主张花钱，不是挡人** —— 所以它只在模型说需要时出现，
 * 用户点按钮本身就是确认，不再多问一次。
 */
function ConfirmBar(): ReactNode {
  return (
    <div className="cfm">这一步会改产物或花钱，需要你点头。
      <button className="act pri" onClick={() => { void confirmAct(); }}>确认执行</button>
      <button className="act" onClick={() => { G.NEEDS_CONFIRM = false; bumpUi(); }}>先不要</button>
    </div>
  );
}

// ── 消息流整块 ───────────────────────────────────────────────────
export function Stream(): ReactNode {
  const G = useUi();
  useStreamEffects();
  if (!G.S) return <Placeholder ic="NO SESSION">新建一个会话开始</Placeholder>;

  const dlg = (G.S.state?.dialogue?.turns || []).filter((t: any) => t.speaker !== "system");
  const hasChat = !!(dlg.length || G.PENDING.length);
  const head = intro(G, hasChat);

  // 空状态也要带提示条 —— 那正是最需要它的时候：一个还没上传任何材料的人，
  // 面对的正是一个空输入框。上一次这里的 early return 把聊天气泡挡在外面，
  // 后来挡的是开场提示，同一类错误。
  if (head && !hasChat) return <>{head}<IntroChips /></>;

  return (
    <div className="wrap">
      {head}
      <TraceCard />
      {/* 待办（决策 + 建议）是**对话流里的一条消息**，钉在梳理刚完成、用户还没
          开口那个时间点。用户一旦提问，后面的气泡自然把它推上去 —— 它不再钉在
          最下方，而是像所有消息一样往上滚。这是一个连续的聊天窗口，不是两块区域。 */}
      <PendingCard />
      {timeline(dlg).map((it, i) => (it.turn
        ? <Bubble turn={it.turn} key={`t${i}`} />
        : <EvCard ev={it.ev} key={`e${i}`} />))}
      {G.PENDING.map((t: any, i: number) => <Bubble turn={t} key={`p${i}`} />)}
      {G.STEPS.length ? <StepsCard /> : null}
      {G.THINKING ? <ThinkingBubble /> : null}
      <ChatChips />
      {G.NEEDS_CONFIRM && !G.THINKING ? <ConfirmBar /> : null}
    </div>
  );
}

// #stream 从这一行起归 React。render() 的函数体末尾只剩一句 bumpUi()，
// **它那几十个调用点一个都没动** —— 那是这次换框架能做到「行为等价」的全部依据。
registerRegion("stream", Stream);
