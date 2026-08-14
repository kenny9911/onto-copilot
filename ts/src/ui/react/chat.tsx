// 聊天流的四块：气泡 / 推理卡 / 「正在思考」占位 / 推荐问题 chips。
//
// 对应 chat.ts 里的 bubble() / stepsCard() / thinkingBubble()，以及 render.ts 中栏
// 那一段 chips 的模板字符串。**类名与结构逐字对齐旧字符串** —— 767 行 CSS 认的是
// `.bub.me` `.bub.oc` `.body` `.itag.low` `.mdbody` `.steps` `.stp` `.stt` `.sto`
// `.stb` `.dots` `.tsec` `.pchips` `.pchip` 这些选择器，少一个类名就是少一块样式。
//
// ## 这一层不碰的东西
//
// 状态归约（addTurn / mergeStateSnapshot / turnKey）、发送与停止（sendChat /
// stopChat / stopRun）、打字机（startStream）全部留在 chat.ts —— 它们一行都不碰
// DOM，React 化不该动它们，它们那 27 条测试也就一条都不用改。
//
// ## chips 的两条规矩写在组件里，不写在调用方
//
// 「这一轮还在路上就不画」和「追问为空退回开场那批」是**同一处判断的两半**，
// 拆到调用方去写，迟早有一个调用点只抄了一半：
//   · 只抄前半 → 停止/出错那一刻 chips 全没了，聊天窗口一条出口都不剩；
//   · 只抄后半 → 答案由 SSE 先上屏、chips 跟着 HTTP 响应才到，中间那几十毫秒
//     里上一轮的提示会在输入框正上方闪一下再被换掉，整块跳一跳。
// 所以 <ChatChips> 自己读 G，自己决定画不画。调用方只管把它放进消息流。

import type { ReactElement, ReactNode } from "react";

import { ask } from "../chat.js";
import { Markdown } from "./markdown.js";
import { useUi } from "./store.js";

/**
 * 对话气泡。与推理轨迹卡片刻意用不同的视觉语言 ——
 * 轨迹是「系统在做事」，气泡是「人在说话」。
 *
 * 用户那半边是**纯文本**：JSX 的文本节点由 React 转义，旧代码里那句 esc(txt) 不
 * 但多余，还会把 `<` 变成界面上看得见的 `&lt;`。助手那半边走 markdown，
 * 那是 React 下唯一还能被打穿的地方（见 markdown.tsx）。
 */
export function Bubble({ turn }: { turn: any }): ReactElement {
  const G = useUi();
  const me = turn.speaker === "user";
  let txt: string = turn.text || "";
  // 正在流式的那条助手消息按当前进度截断（判据与旧 bubble() 一致）。
  // **这就是打字机的全部呈现逻辑** —— startStream 每一帧只推进 G.STREAM.i 然后
  // 通知重画，不再往 DOM 里直写；那根光标同理，揭示完（i 到全长）就收起来。
  const streaming = !me && !!G.STREAM && txt === G.STREAM.full;
  if (streaming) txt = G.STREAM.full.slice(0, G.STREAM.i);
  return (
    <div className={"bub " + (me ? "me" : "oc")}>
      <div className="body" {...(turn.pending ? { style: { opacity: .55 } } : {})}>
        {me ? txt : <>
          {turn.intent
            ? <span className={"itag" + ((turn.confidence ?? 1) < 0.6 ? " low" : "")}>{turn.intent}</span>
            : null}
          <Markdown text={txt} cursor={streaming && G.STREAM.i < G.STREAM.full.length} />
        </>}
      </div>
    </div>
  );
}

/**
 * 推理过程。看不见的推理和编造的区别，用户是分辨不出来的 —— 所以默认展开，
 * 而不是折叠在一个「查看详情」后面。
 *
 * 观察值截到 240 字：一次工具调用的返回可以是几十 KB，整段铺开会把对话流冲垮。
 */
export function StepsCard(): ReactElement {
  const G = useUi();
  return (
    <div className="steps">
      {G.STEPS.map((x: any, i: number) => (
        <div className="stp" key={i}>
          <div className="stt">{x.thought || ""}</div>
          {x.tool
            ? <div className="sto"><code>{x.tool}</code>{" "}{JSON.stringify(x.args || {})}</div>
            : null}
          {x.observation
            ? <div className="stb">{String(x.observation).slice(0, 240)}</div>
            : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 正在思考。**必须在发出去的那一刻就出现**，不能等第一个 step 回来 ——
 * 推理循环的第一次模型调用要好几秒，这几秒里界面纹丝不动的话，
 * 用户会以为没发出去然后再点一次。
 *
 * 两个细节不能丢：
 *   · 外层的 `think` 类 —— 这颗气泡是**临时占位**，答案一到就被换掉。
 *     markNewBubbles 靠它把这颗排除在计数之外；不排除的话「思考中消失、答案出现」
 *     这一步净变化为零，于是整个界面上最该被看见的那条反而拿不到入场动画。
 *   · `id="tsec"` —— 秒数由 startThinking 的定时器每 500ms 直接写 textContent。
 *     那个计时器活在 chat.ts（状态层），不在这里；id 换掉它就再也找不到这个 span。
 */
export function ThinkingBubble(): ReactElement {
  const G = useUi();
  const last = G.STEPS.length ? G.STEPS[G.STEPS.length - 1] : null;
  const what = last && last.tool ? `正在查 ${last.tool}`
    : last && last.thought ? String(last.thought).slice(0, 40)
    : "正在想";
  return (
    <div className="bub oc think"><div className="body think">
      <span className="dots"><i></i><i></i><i></i></span>{what}
      <span className="tsec" id="tsec"></span></div></div>
  );
}

export interface Chip {
  text: string;
  /** 点下去真正发出去的话。缺省就是 text 本身。 */
  send?: string;
}

/**
 * 一排推荐问题。**点一条 = 把它当成用户自己打的字发出去**，不走特殊路径 ——
 * 特殊路径会和手打的行为漂移，而漂移的那天你不知道该信哪个。
 *
 * `data-s` 保留着：旧写法是 `onclick="ask(this.dataset.s)"`，属性是那句话的**运输
 * 工具**；React 下参数直接就是值，属性已经不承担运输，但它是这批按钮在 DOM 上
 * 的身份标记（测试与将来的埋点都按它找），去掉等于改结构。
 */
export function Chips({ chips, center = false }: { chips: Chip[]; center?: boolean }): ReactElement | null {
  if (!chips.length) return null;
  return (
    <div className="pchips" {...(center ? { style: { justifyContent: "center" } } : {})}>
      {chips.map((c, i) => {
        const send = c.send || c.text;
        return <button className="pchip" key={i} data-s={send} onClick={() => { void ask(send); }}>{c.text}</button>;
      })}
    </div>
  );
}

/**
 * 聊天窗口里那一排 —— 见文件头「chips 的两条规矩」。
 *
 * 有追问就出追问，没有就退回开场那批。两者不同时出：提示的位置很贵，占一条就
 * 少一条真正有用的。**但不能两者都不出** —— 旧逻辑在聊过一句后会把 PROMPTS 直接
 * 清空，于是追问一旦为空（梳理刚跑完、材料刚传完、上一轮出错），聊天窗口就一条
 * 出口都没有，而服务端那时刚算好的一批开场提示正躺在 PROMPTS 里没人用。
 */
export function ChatChips(): ReactElement | null {
  const G = useUi();
  // CHAT_ABORT 非空 = 这一轮还在路上。
  if (G.THINKING || G.CHAT_ABORT) return null;
  return <Chips chips={G.FOLLOWUPS.length ? G.FOLLOWUPS : G.PROMPTS} />;
}

/**
 * 空状态那一排（居中）。空状态**也要带开场提示** —— 那正是最需要它的时候：
 * 一个还没上传任何材料的人，面对的正是一个空输入框。
 */
export function IntroChips(): ReactNode {
  const G = useUi();
  return <Chips chips={G.PROMPTS} center />;
}
