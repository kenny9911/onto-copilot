// 消息流「贴不贴着底」这一点状态，单独住在这里。
//
// ## 为什么是一个自己的文件
//
// 它天然有三个调用方：画消息流的 stream.tsx、换会话的 sessions.ts、
// 关知识库页的 knowledge-page.tsx。把它留在 stream.tsx 上会长出两个 import 环 ——
//
//   stream.tsx → chat.ts → knowledge-page.tsx → stream.tsx
//   stream.tsx → chat.ts → sessions.ts → stream.tsx
//
// —— 而 ESM 的环不会报错，只会让先被求值的那一头在另一头眼里是 undefined。
// 实测的表现是 preview 和 stream 的一批测试里「spy 没被调用过」：出问题的根本
// 不是那些组件，是环里某个模块拿到了半个未初始化的对象。这种 bug 从症状回溯到
// 成因要很久，而避免它只需要让这点状态住在一个**谁都不 import**的叶子模块里。
//
// 所以这个文件**必须保持零 import**。往这里加任何 import 之前，先想清楚它会不会
// 把上面那两个环又接回来。

/**
 * 用户是不是还贴着底。
 *
 * 旧代码在**替换 innerHTML 之前**当场量一次；React 下没有那个时刻（渲染与提交
 * 是两步，量到的已经是新内容）。所以改成跟着滚动事件记：用户往上翻就记 false，
 * 翻回底部记 true。程序自己滚到底也会触发一次 scroll，于是自动回到 true ——
 * 和旧行为一致：**只要人在底部，新消息就跟着上来；人翻上去看历史，就别抢他的位置。**
 */
let atBottom = true;

/** 「离底不到这么多像素就算在底部」。原来那句 `< 120` 的那个 120。 */
const NEAR_BOTTOM = 120;

export function isStreamAtBottom(): boolean {
  return atBottom;
}

/** 滚动事件里调：按当前几何重新判断。 */
export function noteStreamScroll(box: {
  scrollHeight: number; scrollTop: number; clientHeight: number;
}): void {
  atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
}

/**
 * 回到底部。
 *
 * `atBottom` 是模块级的、从不重置 —— 这有两个后果，都不是设计：
 *   · 换会话时它带着上一个会话的姿势过来。在旧会话里往上翻过历史，打开新会话
 *     就停在顶上，看不见最新一轮。
 *   · 从知识库页回到聊天时同理，而知识库页恰恰鼓励人一边读材料一边问 ——
 *     问完回来正是最需要看见答案的时刻。
 *
 * 所以「换了要看的东西」这件事必须显式说一声。调用点：openSession、
 * closeKnowledgePage。
 */
export function stickStreamToBottom(): void {
  atBottom = true;
}
