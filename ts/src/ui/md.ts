// 轻量 markdown → HTML。
import { esc } from "./dom.js";

// 轻量 markdown → HTML。**先转义再套用**，杜绝注入；只覆盖助手回答里常见的子集：
// 代码块 / 行内代码 / 加粗 / 标题 / 有序无序列表 / 换行。
export function md(src: any){
  let s = esc(src || "");
  const stash: string[] = [];
  const keep = (html: any) => { stash.push(html); return `\x00${stash.length - 1}\x00`; };
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) =>
        keep(`<pre class="mdcode">${c.replace(/\n$/, "")}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code class="mdik">${c}</code>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 斜体：**必须在加粗之后**，否则 ** 会被单星规则先吃掉。模型很爱用 *(补充说明)*，
  // 不认的话满篇星号。
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");

  const lines = s.split("\n");
  const out = [];
  const isRow = (x: any) => /^\s*\|.*\|\s*$/.test(x);
  const isSep = (x: any) => /^\s*\|[\s:|-]+\|\s*$/.test(x);
  const cells = (x: any) => x.trim().replace(/^\||\|$/g, "").split("|").map((c: any) => c.trim());

  // 列表用**栈**维护：模型写的是嵌套结构（一级编号下挂二级要点），原来只有一个
  // ul/ol 布尔量，遇到缩进的子项就先把父列表关掉再开一个新的 —— 层级全丢，
  // 还会切出空的编号项。栈按缩进深度开合，父子关系才留得住。
  const stack: {indent: number; tag: string}[] = [];   // [{indent, tag}]
  const closeTo = (n: any) => { while (stack.length > n) out.push(`</${stack.pop()!.tag}>`); };

  for (let li = 0; li < lines.length; li++){
    const ln = lines[li]!;

    // ── 表格 ─────────────────────────────────────────────────────
    if (isRow(ln) && li + 1 < lines.length && isSep(lines[li + 1])){
      closeTo(0);
      const head = cells(ln), body = [];
      li += 2;
      while (li < lines.length && isRow(lines[li])){ body.push(cells(lines[li])); li++; }
      li--;
      out.push('<div class="mdtw"><table class="mdt"><thead><tr>'
        + head.map((c: any) => `<th>${c}</th>`).join("")
        + '</tr></thead><tbody>'
        + body.map(r => `<tr>${r.map((c: any) => `<td>${c}</td>`).join("")}</tr>`).join("")
        + '</tbody></table></div>');
      continue;
    }

    // ── 标题：#..###### 都认（原来只到 ###，#### 直接当正文显示出来）──
    let m = ln.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
    if (m){ closeTo(0); out.push(`<div class="mdh">${m[2]}</div>`); continue; }

    // ── 分隔线 ───────────────────────────────────────────────────
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(ln)){ closeTo(0); out.push('<hr class="mdhr">'); continue; }

    // ── 列表项（按缩进定层级）────────────────────────────────────
    m = ln.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/);
    if (m){
      const indent = m[1]!.replace(/\t/g, "    ").length;
      const tag = /\d/.test(m[2]!) ? "ol" : "ul";
      const text = m[3]!.trim();
      while (stack.length && indent < stack[stack.length - 1]!.indent) closeTo(stack.length - 1);
      const top: {indent: number; tag: string} | undefined = stack[stack.length - 1];
      if (!top || indent > top.indent){
        out.push(`<${tag} class="mdl">`); stack.push({indent, tag});
      } else if (top.tag !== tag){
        closeTo(stack.length - 1);
        out.push(`<${tag} class="mdl">`); stack.push({indent, tag});
      }
      // 空条目（只有一个 "*" 或 "1." 的行）不产出 <li> —— 那正是界面上冒出
      // 空编号的来源。
      if (text) out.push(`<li>${text}</li>`);
      continue;
    }

    // 空行不关闭列表：模型常在父项和子项之间空一行，一关就断了父子关系。
    if (!ln.trim()){ out.push(""); continue; }
    closeTo(0); out.push(ln);
  }
  closeTo(0);
  s = out.join("\n");
  s = s.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  s = s.replace(/(<\/(?:ul|ol|pre|div|hr)>|<hr class="mdhr">)(?:<br>)+/g, "$1")
       .replace(/(?:<br>)+(<(?:ul|ol|pre|div|hr))/g, "$1")
       .replace(/(<(?:ul|ol)[^>]*>)(?:<br>)+/g, "$1")
       .replace(/(?:<br>)+(<\/(?:ul|ol)>)/g, "$1")
       .replace(/(<\/li>)(?:<br>)+/g, "$1");
  // 表格单元格里模型爱写字面量 <br> 换行；esc 之后成了可见的 &lt;br&gt;
  s = s.replace(/&lt;br\s*\/?&gt;/g, "<br>");
  return s.replace(/\x00(\d+)\x00/g, (_: any, i: any) => stash[i] ?? "");
}
