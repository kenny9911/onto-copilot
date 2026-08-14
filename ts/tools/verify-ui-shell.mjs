// 「样式没动过」的**唯一硬证据**。
//
// 拿 git 里那份内联 JS 时代的 ui/index.html（blob 52cc8bc，永久对象，不随分支移动）
// 和现在生成的 ui/index.html 比：把两边最后一个 <script>…</script> 之间的内容挖掉，
// 剩下的 CSS + HTML **必须逐字节相同**。
//
// 为什么钉 blob 而不是钉 HEAD：一旦新的 index.html 提交上去，HEAD:ui/index.html
// 就是新的那份，比对会变成自己跟自己比 —— 那什么也证明不了。blob 哈希是内容寻址的，
// 指向的永远是那 4437 行原件。
//
// 用法：node ts/tools/verify-ui-shell.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGINAL_BLOB = "52cc8bc190446cdadc30524400043d6148c9e301";

/**
 * 挖掉最后一个 <script>…</script> 的内容，返回 [前缀, 后缀]。
 * **只对原件用** —— 原件里只有 head 那个小块和正文这一大块两个 <script>，
 * lastIndexOf 找得准。
 */
function shell(html) {
  const a = html.lastIndexOf("<script>");
  const b = html.lastIndexOf("</script>");
  if (a < 0 || b < a) throw new Error("找不到内联脚本块");
  return [html.slice(0, a + "<script>".length), html.slice(b)];
}

/**
 * 待检文件的外壳：前缀取**原件前缀那么多字节**，后缀取最后一个 `</script>` 起。
 *
 * 为什么不能也用 lastIndexOf("<script>")：打进来的 react-dom 里有一句
 * `innerHTML = "<script><\/script>"`，那串 `<script>` 在文件里比真正的开标签更靠后，
 * lastIndexOf 会切在 bundle 中间，于是「CSS 变了」这个结论纯属切错了地方。
 * 反过来 `</script` 是构建时硬拦掉的（见 build-ui.mjs），后缀这一头始终可靠。
 *
 * 按原件前缀长度切还更强一层：它断言的是「这份文件**开头这些字节**就是原件的
 * DOCTYPE + head + 767 行 CSS + body + <script>」，而不是「某处切出来的两段碰巧相等」。
 */
function shellAgainst(html, originalPrefix) {
  const b = html.lastIndexOf("</script>");
  if (b < 0) throw new Error("找不到内联脚本块");
  return [html.slice(0, originalPrefix.length), html.slice(b)];
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const original = execFileSync("git", ["cat-file", "blob", ORIGINAL_BLOB], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 32 << 20,
});
const current = readFileSync(resolve(ROOT, "ui/index.html"), "utf8");
const template = readFileSync(resolve(ROOT, "ui/index.template.html"), "utf8");

let bad = 0;
for (const [name, html] of [["ui/index.html", current], ["ui/index.template.html", template]]) {
  const [op, os] = shell(original);
  const [np, ns] = shellAgainst(html, op);
  const okPre = op === np, okPost = os === ns;
  console.log(`${name}`);
  console.log(`  前缀（DOCTYPE + <head> + 767 行 CSS + <body>）: ${okPre ? "一致" : "**不一致**"}  ${sha(np).slice(0, 12)}`);
  console.log(`  后缀（</script> 之后）:                        ${okPost ? "一致" : "**不一致**"}  ${sha(ns).slice(0, 12)}`);
  if (!okPre || !okPost) {
    bad++;
    for (const [label, a, b] of [["前缀", op, np], ["后缀", os, ns]]) {
      if (a === b) continue;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.error(`  ${label}第一处差异在偏移 ${i}：`);
      console.error(`    原件: ${JSON.stringify(a.slice(i, i + 60))}`);
      console.error(`    现在: ${JSON.stringify(b.slice(i, i + 60))}`);
    }
  }
}
console.log(`\n原件 blob ${ORIGINAL_BLOB}  sha256(整份)=${sha(original).slice(0, 16)}`);
if (bad) { console.error("\nCSS/HTML 发生了改动 —— 这是不允许的。"); process.exit(1); }
console.log("CSS 与 HTML 逐字节未变。");
