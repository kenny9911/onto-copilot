// **React 下唯一允许出现 dangerouslySetInnerHTML 的地方。**
//
// JSX 默认转义文本节点，换 React 之后「拼 innerHTML」那一整类 XSS 从根上消失 ——
// 只剩这一个口子。所以它被收进一个组件里，由 ui.contracts.escaping.react.test.ts
// 的源码通扫钉死：整个 ts/src/ui 下 dangerouslySetInnerHTML 只准在本文件出现。
//
// ## 为什么这里必须留一个口子
//
// 助手的回答是 markdown，要变成 `<strong>` `<ul>` `<table>` 这些真元素。md.ts 产出的
// 是 **HTML 字符串**，JSX 没有办法把字符串当标记插进去 —— 除了这个属性。
// 换成「解析成 React 元素树」是重写 md.ts（它有 11 条测试），不在这次迁移的范围里。
//
// ## 为什么这个口子是安全的
//
// md() 第一句就是 `esc(src)`：输入里的 `<` `>` `&` 在任何规则跑之前已经变成实体，
// 之后所有标签都是 md() 自己按固定模板拼出来的，用户那串永远只能落在文本位置。
//
// 组件因此**只收 markdown 原文（text），不收 HTML**。没有 `html` 属性可传 ——
// 调用方即使想把一段自己拼的标记塞进来也没有入口，这是结构上的保证，不是纪律。
//
// 唯一一处把标记放回去的是 md() 末尾 `&lt;br&gt;` → `<br>`（表格单元格里模型爱写
// 字面量 <br>），那是个无属性的空元素，带不了 onerror。

import type { ReactElement } from "react";

import { md } from "../md.js";

export interface MarkdownProps {
  /** markdown **原文**。不是 HTML —— 这个组件不接受 HTML。 */
  text: unknown;
  /** 外层 div 的类名。默认 mdbody（原来 bubble() 拼的就是这个）。 */
  className?: string;
  /** 末尾那根闪烁光标（打字机还没揭示完时）。见下面 CURSOR。 */
  cursor?: boolean;
}

/**
 * 打字机那根光标。**是个写死的字面量，不是参数** —— 调用方只能说「要不要」，
 * 说不了「长什么样」，所以它进不来任何用户输入。位置必须在 .mdbody **里面**：
 * 内联 JS 时代那句 `el.innerHTML = md(…) + '<span class="cur"></span>'` 写的就是
 * 这一层，挪到外面就是换 DOM 结构，`.cur` 那条 CSS 认的位置也就变了。
 */
const CURSOR = '<span class="cur"></span>';

/** 渲染成 `<div class="mdbody">…</div>`，与内联 JS 时代 bubble() 产出的结构一致。 */
export function Markdown({ text, className = "mdbody", cursor = false }: MarkdownProps): ReactElement {
  return <div className={className}
    dangerouslySetInnerHTML={{ __html: md(text) + (cursor ? CURSOR : "") }} />;
}
