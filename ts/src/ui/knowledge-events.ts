// 「知识库刚被改了」这个通知的名字和形状。
//
// ## 为什么又是一个自己的文件
//
// 它有两个调用方，而这两个在 import 图上离得很远：发的人是 sse.ts（SSE 归约），
// 收的人是 knowledge-library.tsx（画左边那棵树）。让后者去 import sse.ts 会长出
//
//   knowledge-library → sse → chat → knowledge-page → knowledge-workspace
//                                                   → knowledge-library
//
// 一个环。这个仓库刚为同一类错误付过一次代价（stream-scroll.ts 那次），症状是
// preview/stream 一批测试里「spy 没被调用过」—— ESM 的环不报错，只让先求值的
// 那一头在另一头眼里是 undefined，从症状回溯到成因很花时间。
//
// 所以这个文件**必须保持零 import**。
//
// ## 事件里为什么不带内容
//
// 只说「变了、是什么动作」，不带文档清单、不带正文。收到的人自己去打 API 重拉，
// 那条路上有 ACL 和作用域解析；把内容塞进一个浏览器内广播的事件，等于给它开一条
// 绕过鉴权的旁路。省下的那一次请求不值这个。

/** 知识库发生了写入。detail 里只有一个 action 字符串。 */
export const KNOWLEDGE_CHANGED_EVENT = "ontocopilot:knowledge-changed";

export interface KnowledgeChangedDetail {
  /** promote / promote_batch / attach / detach / archive / restore / … */
  readonly action: string;
}

export function emitKnowledgeChanged(action: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<KnowledgeChangedDetail>(KNOWLEDGE_CHANGED_EVENT, { detail: { action } }),
  );
}

/** 订阅。返回退订函数 —— 组件卸载时必须调，否则换会话会攒出一堆重复刷新。 */
export function onKnowledgeChanged(handler: (detail: KnowledgeChangedDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event): void => {
    handler((event as CustomEvent<KnowledgeChangedDetail>).detail ?? { action: "" });
  };
  window.addEventListener(KNOWLEDGE_CHANGED_EVENT, listener);
  return () => { window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, listener); };
}
