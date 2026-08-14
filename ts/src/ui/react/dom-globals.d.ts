// 给 `Element` / `Event` 这批全局接口补上真正用得到的成员。
//
// ## 这几个接口是哪来的
//
// `@types/react/global.d.ts` 为「不开 DOM lib 的 React 工程」（React Native 那类）
// 声明了一整套**空壳**：`interface Element {}` `interface HTMLElement extends Element {}`
// `interface Event {}` …… 名字有了，一个成员都没有。于是 `container.querySelector(".t")`
// 这种最普通的一句在 tsc 下是错的。
//
// ## 为什么不干脆打开 "DOM" lib
//
// 跟 browser.d.ts 里写的是同一个理由，而且这次能拿到证据：`Response` `fetch`
// `AbortController` `Headers` 这些名字在 src/server、src/kernel、src/onto 下有
// **三十来个文件**在用，它们现在拿的是 @types/node 那份声明（hono 那套也建立在
// 它上面）。lib.dom 会给同样的名字换一份声明，最轻的后果是那批文件的推断悄悄变形 ——
// 而这次要换的是前端的宿主，不该顺手改另外五条 track 的类型环境。
//
// ## 松到什么程度
//
// 和 browser.d.ts 同一个尺度：**价值在「能不能编译过」，不在「DOM 精确建模」**。
// 返回值大量用 any，因为假装精确只会逼出一堆 `as` 断言 —— 那才是真的把校验删掉。
// 但成员名是**逐个列出来**的，不是一个 `[k: string]: any` 兜底：属性名写错
// （`textcontent`）仍然会被拦下，那正是这一层唯一还能挡住的错误。
//
// 缺什么就往下加，加的时候顺手写一句为什么需要它。
//
// **哪天真的开了 DOM lib，整个文件要删掉** —— 那时这些声明会和 lib.dom 打架。

interface Element {
  readonly attributes: any;
  readonly children: any;
  readonly firstChild: any;
  readonly parentElement: any;
  readonly classList: any;
  readonly dataset: any;
  readonly style: any;
  className: string;
  id: string;
  title: string;
  hidden: boolean;
  innerHTML: string;
  outerHTML: string;
  textContent: string | null;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  closest(selectors: string): any;
  matches(selectors: string): boolean;
  contains(other: any): boolean;
  appendChild(node: any): any;
  removeChild(node: any): any;
  remove(): void;
  focus(): void;
  click(): void;
  scrollIntoView(arg?: any): void;
  getBoundingClientRect(): any;
  addEventListener(type: string, handler: any, options?: any): void;
  removeEventListener(type: string, handler: any, options?: any): void;
}

// 受控组件的 onChange 里第一句就是 `e.target.value` —— React 把 target 的类型给到
// HTMLInputElement / HTMLSelectElement / HTMLTextAreaElement，而 @types/react 那份
// 空壳里它们一个成员都没有。**不写 extends**：合并到已有声明上即可，改动继承关系
// 只会跟 @types/react 自己那句 `extends HTMLElement` 抢。
interface HTMLInputElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  readonly files: any;
}
interface HTMLSelectElement {
  value: string;
  disabled: boolean;
}
interface HTMLTextAreaElement {
  value: string;
  disabled: boolean;
}

interface Event {
  readonly currentTarget: any;
  readonly target: any;
  stopPropagation(): void;
  preventDefault(): void;
}
