// **两个样板组件。** 它们不是「新功能」，是给另外四条 track 照抄的参考实现：
//
//   <ConvRow>  ← sessions.ts 的 convRow()   ：文本 / 属性 / 事件参数三种插值都有，
//                                             原来分别要 esc / eattr / earg
//   <Bubble>   ← chat.ts 的 bubble()        ：走 markdown 那条路，是 React 下唯一
//                                             还能被 XSS 打穿的地方
//
// 对应的旧函数**还留在原处**（这次只搭骨架，不动别人的模块）。sessions / chat 那两条
// track 落地时，把这里的组件搬进自己的模块、删掉旧函数即可 —— 到那时这个文件就该空掉。
//
// ## 照抄时盯住三件事
//
// 1. **类名与结构逐字对齐旧字符串。** 767 行 CSS 认的是 `.conv` `.conv.on` `.t` `.s`
//    `.mv` `.del` `.bub.me` `.body` `.itag.low` `.mdbody` 这些选择器，少一个类名就是
//    少一块样式 —— 那等于改设计。写完对着旧函数的模板字符串逐个核。
// 2. **esc / eattr / earg 全部删掉。** 值直接以 JSX 表达式传进去：文本节点、属性、
//    事件参数三条路径 React 各自处理，再手工转一遍只会在界面上显示出 `&lt;`。
//    唯一的例外是 markdown（见 markdown.tsx）。
// 3. **内联处理器整套消失。** `onclick="dropSession('${earg(id)}','${earg(title)}')"`
//    变成 `onClick={() => dropSession(s.id, s.title)}`：参数是**值**，不再经过一次
//    「拼进属性 → HTML 解码 → 当 JS 编译」的旅程，earg 那个层次的 bug 无处可生。
//    因此这些函数也不必再挂 window（globals.ts 那份名单会随各 track 的迁移缩短）。

// <Bubble> 已经搬进它自己那条 track 的模块（react/chat.tsx，和 <StepsCard>
// <ThinkingBubble> <ChatChips> 住在一起）。这里留一行转出口，纯粹是为了让
// 「照抄这两个样板」这件事仍然在同一个文件里说得通，以及不惊动已经按这个路径
// 引用它的测试。**实现只有一份**，改的时候改 react/chat.tsx。
export { Bubble } from "./chat.js";

// <ConvRow> 同理，实现搬进了 react/sidebar.tsx —— 它和项目分组
// （<Sidebar> / <ProjectGroup>）是同一块界面，拆两个文件住只会让「会话行归谁管」
// 这件事变得要问一次。sessions.ts 里那个拼串的 convRow() 已经删掉，
// 每一行都登记在 tools/verify-ui-port.mjs 的 REACT_REPLACED 里。
export { ConvRow } from "./sidebar.js";
