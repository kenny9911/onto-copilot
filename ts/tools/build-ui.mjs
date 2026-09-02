// 把 ts/src/ui/*.ts 打成一个 IIFE，塞回 ui/index.template.html 的 <script> 里，
// 产出 ui/index.html。
//
// **CSS 与 HTML 一个字节都不动** —— 模板就是原来的 index.html 只把内联 JS 换成
// 一行标记，构建只做「标记 → bundle」这一次替换。真正的证据是 verify-ui-shell.mjs：
// 它拿 git 里那份**原始 blob**做比对，而不是拿模板自证。
//
// 单文件、无外部请求是硬约束：这个页面是直接被服务端当 HTML 返回的，
// 没有静态资源路由，也没人愿意为一个内部工作台引一套构建产物目录。
//
// 用法：node ts/tools/build-ui.mjs [--check]
//   --check 只比对，不写盘（CI 里用来确认 index.html 与源码没有漂移）

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const TEMPLATE = resolve(ROOT, "ui/index.template.html");
const OUT = resolve(ROOT, "ui/index.html");
const MARKER = "//__OC_UI_BUNDLE__";

const result = await build({
  entryPoints: [resolve(ROOT, "ts/src/ui/main.ts")],
  // **必须钉死**：esbuild 把每个模块的路径以注释形式打进 bundle，而那些路径是
  // 相对 absWorkingDir 算的，默认取 process.cwd()。不写这行的话，同一份源码从
  // 仓库根构建和从 ts/ 构建会产出**不同的字节**（注释里一个是 ts/node_modules/…、
  // 另一个是 node_modules/…），于是 `--check` 的漂移检查会随「你在哪个目录跑」
  // 而间歇性报警 —— 而它报的是假警，真正的漂移反而被淹掉。
  absWorkingDir: ROOT,
  bundle: true,
  format: "iife",
  // React 组件写在 .tsx 里。"automatic" = 走 react/jsx-runtime，源码里不用再
  // `import React`（也就没有「忘了 import 导致整块白屏」这一类事故）。
  jsx: "automatic",
  // react-dom 的入口是 `process.env.NODE_ENV === "production"` 二选一。
  // **不写这一行不会报错** —— esbuild 在 platform:"browser" 且没开 minify 时会自动
  // 把它替换成 "development"，页面照样跑得起来。差别在体积和行为：
  //   不 define → 1278 KB，带着一整套开发期警告与 DEV-only 校验
  //   define    → 762 KB，dead-code 消掉那半边
  // 实测出来的两个数，别凭印象改。ui.bundle.test.ts 有一条盯着它。
  define: { "process.env.NODE_ENV": '"production"' },
  // 页面自己是 <script>（非 module），而且内联处理器要在全局作用域里找得到名字 ——
  // 名字由 globals.ts 显式挂上去，这里只要保证打出来的是一段能直接跑的普通脚本。
  platform: "browser",
  target: ["es2022"],
  charset: "utf8",           // 别把中文转成 \uXXXX：这个文件是要给人读的
  legalComments: "inline",
  minify: false,             // 不压缩：出问题时行号要能对得上源码
  write: false,
  logLevel: "warning",
});

const bundle = result.outputFiles[0].text.trimEnd();
// 内联 <script> 的终止判据是**词法**的：正文里出现 `</script`（甚至 `<!--`）
// 会被 HTML 解析器当成脚本结束，后面的代码变成页面文本。原件里没有这种串，
// 但 i18n 表和模板字面量随时可能长出一个 —— 这条断言是那一天唯一的拦截点。
for (const seq of ["</script", "<!--"]) {
  if (bundle.includes(seq)) throw new Error(`bundle 里出现了 ${seq}，内联 <script> 会被提前截断`);
}
// **单独一个 `<script`（没有 `</`）不在名单里，这是按 HTML 分词器的状态机来的，
// 不是放宽。** script data 状态只认 `</script` 作为终止；`<script` 只有在解析器
// 已经因为 `<!--` 进入 escaped 状态之后才有意义 —— 那时它会把状态推进到
// double-escaped，让后面真正的 `</script>` 失效。上面那两条已经把 `<!--` 和
// `</script` 都挡死了，剩下的 `<script` 构不成终止条件。
// 之所以要区分：react-dom 里有一句 `innerHTML = "<script><\/script>"`（它探测浏览器
// 行为用的），连坐的话 React 根本打不进这个页面，而那一句无害。
// esbuild 自己会把字符串里的 `</script` 写成 `<\/script`，所以上面第一条仍然有效。

const template = readFileSync(TEMPLATE, "utf8");
if (!template.includes(MARKER)) throw new Error(`模板里找不到标记 ${MARKER}`);
const html = template.replace(MARKER, () => bundle);

if (process.argv.includes("--check")) {
  const cur = readFileSync(OUT, "utf8");
  if (cur !== html) {
    console.error("ui/index.html 与 ts/src/ui/ 不一致 —— 跑一次 node ts/tools/build-ui.mjs");
    process.exit(1);
  }
  console.log("ui/index.html 与源码一致");
} else {
  writeFileSync(OUT, html);
  console.log(`ui/index.html 已生成（bundle ${bundle.length} 字节）`);
  // 编译版（node ts/dist/src/main.js）解析出来的 uiDir() 是 ts/dist/src/server/ui，
  // 不是仓库根的 ui/。以前那份是手工拷进去的：dist 一重建就没了，服务端于是回退到
  // 「前端未构建」，或者更糟 —— 继续吐几小时前的旧界面，而你以为看的是新代码。
  // 前端只有这一个产物，跟着它一起写出去最省事。
  const packaged = resolve(ROOT, "ts/dist/src/server");
  if (existsSync(packaged)) {
    mkdirSync(join(packaged, "ui"), { recursive: true });
    writeFileSync(join(packaged, "ui", "index.html"), html);
    console.log("ts/dist/src/server/ui/index.html 已同步");
  }
}
