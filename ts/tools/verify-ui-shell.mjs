// 「HTML 骨架没动过、CSS 只按需变」的硬证据。
//
// ── 这个工具改过一次，先说清为什么 ────────────────────────────────
//
// 原来它断言的是「CSS + HTML **逐字节**都不许变」，钉在内联 JS 时代的
// ui/index.html（blob 52cc8bc，永久对象，不随分支移动）上。那条断言在**迁移期**
// 是对的：当时要证明的正是「React 化只换了脚本，没碰样式」。
//
// 但产品会继续演进样式。于是这道闸从某一天起变成了**永远红着**的灯 —— 而一道
// 永远红着的灯，唯一的效果是教会所有人忽略红灯。它不再拦截任何东西。
//
// 所以拆成两半，各自钉在合适的东西上：
//
//   1. **文档骨架的两头** —— `<style>` 之前的 DOCTYPE + `<head>`，以及
//      `</script>` 之后的整段尾巴 —— 仍然**逐字节钉死在原件 blob 上**。
//      这两段到今天都还是真的（实测一致），钉着它们几乎零成本。
//
//   2. **CSS 正文与 body 结构** —— 改钉**记录下来的基线哈希**（ui/shell.baseline.json）。
//      误改照样当场红；有意改则必须同时更新基线文件，而那是一处 reviewer 看得见的
//      diff。从"禁止变化"变成"变化必须是显式的"。
//
//      body 也进基线这件事是这次改造中**被工具自己纠正的**：我原以为 body 还冻着，
//      拆开一比才发现它早就变了 —— 预览拖杆加了 role="separator" 与 aria-*，
//      七页签的 .phead 整块被 React 侧栏取代。两者都是有意的产品演进，
//      不是漂移。把它继续算成"不许变"只会让这道闸永远红着。
//
// 为什么当初钉 blob 而不是钉 HEAD：一旦新的 index.html 提交上去，HEAD:ui/index.html
// 就是新的那份，比对会变成自己跟自己比 —— 那什么也证明不了。blob 哈希是内容寻址的，
// 指向的永远是那 4437 行原件。这条理由对上面第 1 半仍然成立。
//
// 用法：node ts/tools/verify-ui-shell.mjs
//       node ts/tools/verify-ui-shell.mjs --accept      # 有意改了样式/结构后重取基线

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * 把一份文件切成「骨架头 ｜ CSS 正文 ｜ 骨架尾 ｜ 脚本后缀」。
 *
 * **不能再按原件的前缀长度去切**：那是原来那版的做法，它隐含假设"CSS 长度不变"。
 * CSS 一变长，`</style>` 就掉到那个定长窗口外面，切出来的东西完全不对
 * （实测：`</style>` 的 indexOf 直接是 -1）。所以按每份文件**自己的** `<style>`
 * 边界切 —— CSS 全部内联在 head 那一个 style 块里，两个字面量各只出现一次。
 *
 * `bodyEnd` 要调用方给：`lastIndexOf("<script>")` 对模板是可靠的，对 index.html
 * 不是 —— 打进去的 react-dom 里有一句 `innerHTML = "<script><\/script>"`，
 * 那个串比真正的开标签更靠后（build-ui.mjs 的注释里记着这件事）。
 */
function splitShell(html, bodyEnd) {
  const a = html.indexOf("<style>");
  const b = html.indexOf("</style>");
  if (a < 0 || b < a) throw new Error("找不到唯一的 <style> 块");
  return {
    head: html.slice(0, a + "<style>".length),
    css: html.slice(a + "<style>".length, b),
    body: bodyEnd === null ? null : html.slice(b, bodyEnd),
    tail: html.slice(html.lastIndexOf("</script>")),
  };
}

const BASELINE = resolve(ROOT, "ui/shell.baseline.json");
const accept = process.argv.includes("--accept");

const O = splitShell(original, original.lastIndexOf("<script>"));

let bad = 0;
const cssHashes = new Map();
// body 段（</style> → 最后一个 <script>）只对模板比：index.html 是模板生成的，
// 模板的 body 冻住就等于它的 body 也冻住；而 index.html 上那个边界不可靠（见 splitShell）。
for (const [name, html, bodyEnd] of [
  ["ui/index.template.html", template, template.lastIndexOf("<script>")],
  ["ui/index.html", current, null],
]) {
  const N = splitShell(html, bodyEnd);
  // 钉死在原件上的只有这两头。它们一变就是真出事了（有人动了 DOCTYPE/head
  // 的元信息，或者内联脚本的收尾被破坏）。
  const checks = [
    ["骨架头（DOCTYPE + <head> 到 <style>）", O.head, N.head],
    ["后缀（</script> 之后）", O.tail, N.tail],
  ];
  const okAll = checks.every(([, a, b]) => a === b);
  cssHashes.set(name, { css: sha(N.css), body: N.body === null ? null : sha(N.body) });
  console.log(`${name}`);
  for (const [label, a, b] of checks) console.log(`  ${label}: ${a === b ? "一致" : "**不一致**"}`);
  console.log(`  CSS 正文（对基线）: ${sha(N.css).slice(0, 12)}`);
  if (N.body !== null) console.log(`  body 结构（对基线）: ${sha(N.body).slice(0, 12)}`);
  if (!okAll) {
    bad++;
    for (const [label, a, b] of checks) {
      if (a === b) continue;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.error(`  ${label} 第一处差异在偏移 ${i}：`);
      console.error(`    原件: ${JSON.stringify(a.slice(i, i + 60))}`);
      console.error(`    现在: ${JSON.stringify(b.slice(i, i + 60))}`);
    }
  }
}
console.log(`\n原件 blob ${ORIGINAL_BLOB}  sha256(整份)=${sha(original).slice(0, 16)}`);
if (bad) {
  console.error("\n**文档骨架的两头变了** —— 这两段是钉死的，出现差异就是真出事了。");
  process.exit(1);
}

// ── CSS 与 body：对基线 ─────────────────────────────────────────
// index.html 是模板生成的，两份的 CSS 必须一致 —— 先自证这一点，否则下面
// 比的是一份没重新构建的陈旧产物。
const idx = cssHashes.get("ui/index.html");
const tpl = cssHashes.get("ui/index.template.html");
if (idx.css !== tpl.css) {
  console.error("\nui/index.html 与模板的 CSS 不一致 —— 先跑 node ts/tools/build-ui.mjs。");
  process.exit(1);
}
const now = { css: tpl.css, body: tpl.body };
if (accept) {
  writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`, "utf8");
  console.log(`\n基线已更新（--accept）：css=${now.css.slice(0, 12)} body=${now.body.slice(0, 12)}`);
  console.log("**把 ui/shell.baseline.json 一起提交** —— 它就是这次改动的显式记录。");
} else {
  if (!existsSync(BASELINE)) {
    console.error("\n没有 ui/shell.baseline.json。第一次建立基线：--accept");
    process.exit(1);
  }
  const want = JSON.parse(readFileSync(BASELINE, "utf8"));
  const drift = ["css", "body"].filter((k) => want[k] !== now[k]);
  if (drift.length > 0) {
    for (const k of drift) {
      console.error(`\n${k} 变了：基线 ${String(want[k]).slice(0, 12)} ≠ 现在 ${now[k].slice(0, 12)}`);
    }
    console.error("\n有意改的话跑 node ts/tools/verify-ui-shell.mjs --accept 并提交基线文件；");
    console.error("不是有意的话，说明有人动了 ui/index.template.html 而自己不知道。");
    process.exit(1);
  }
  console.log("\n骨架两头未变，CSS 与 body 均与基线一致。");
}
