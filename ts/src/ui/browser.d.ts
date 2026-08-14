// 浏览器全局的最小声明。
//
// **为什么不给根 tsconfig 打开 "DOM" lib**：那是全仓共享的文件，六条 track 的
// 每个模块都会跟着换一套全局类型 —— `fetch` / `FormData` / `AbortController` /
// `Headers` 在 @types/node 与 lib.dom.d.ts 里各有一份声明，混在一起最轻的后果是
// 服务端那批文件的推断悄悄变形。这次迁移的目标是「宿主换掉、行为不变」，
// 不是顺手改所有人的类型环境。
//
// 所以只补 @types/node **没有**的那几个（实测：document / window / CSS /
// alert / location 缺，localStorage / sessionStorage / EventSource / FormData /
// AbortController / fetch / Intl 都已由 @types/node 提供）。
// 类型故意留松 —— 这一层的价值在「能不能编译过」，不在「DOM 精确建模」；
// 假装精确反而会逼出一堆 `as` 断言，那才是真的把校验删掉。

declare const document: any;
declare const window: any;
declare const CSS: any;
declare const location: any;
declare const innerWidth: number;
declare const innerHeight: number;
declare function alert(message?: any): void;
declare function confirm(message?: any): boolean;
declare function prompt(message?: any, dflt?: any): string | null;
