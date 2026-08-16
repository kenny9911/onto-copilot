/**
 * 助手回答的轻量 markdown 渲染。
 *
 * 这是全前端**唯一**把模型输出往 innerHTML 里塞的地方，所以第一条判据永远是
 * 「先转义再套用」。其余用例钉的都是原件注释里记着的返工点：
 *   · 斜体规则必须排在加粗后面，否则满篇星号；
 *   · 列表用栈按缩进开合，一个布尔量会把父子层级全丢掉；
 *   · 空行不关闭列表（模型爱在父项和子项之间空一行）；
 *   · 只有 "*" 或 "1." 的空行不产出 <li>（界面上冒出的空编号就是它）；
 *   · 表格单元格里的字面量 <br> 要还原（esc 之后成了可见的 &lt;br&gt;）。
 */
import "./ui.env.js";

import { describe, expect, it } from "vitest";

import { md } from "../src/ui/md.js";

describe("md()", () => {
  it("先转义再套用 —— 标签进不去", () => {
    expect(md("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(md("**<script>**")).toBe("<strong>&lt;script&gt;</strong>");
  });

  it("代码块与行内代码原样保留（内容不再被后续规则改写）", () => {
    expect(md("```py\na*b*c\n```")).toBe('<pre class="mdcode">a*b*c</pre>');
    expect(md("用 `a*b*` 表示")).toBe('用 <code class="mdik">a*b*</code> 表示');
  });

  it("加粗在斜体之前 —— ** 不会被单星规则先吃掉", () => {
    expect(md("**粗** 和 *斜*")).toBe("<strong>粗</strong> 和 <em>斜</em>");
    expect(md("*(补充说明)*")).toBe("<em>(补充说明)</em>");
  });

  it("#..###### 六级标题都认", () => {
    expect(md("#### 四级")).toBe('<div class="mdh">四级</div>');
    expect(md("###### 六级")).toBe('<div class="mdh">六级</div>');
  });

  it("嵌套列表按缩进开合，父子关系留得住", () => {
    const out = md("1. 甲\n   - 子一\n   - 子二\n2. 乙");
    expect(out).toBe(
      '<ol class="mdl"><li>甲</li><ul class="mdl"><li>子一</li><li>子二</li></ul><li>乙</li></ol>');
  });

  it("父项与子项之间的空行不关闭列表", () => {
    const out = md("- 甲\n\n  - 子\n");
    expect(out).toBe('<ul class="mdl"><li>甲</li><ul class="mdl"><li>子</li></ul></ul>');
  });

  it("只有记号没有正文的行不产出空 <li>", () => {
    // 注意是 "- "（记号后有空白）：列表正则要求记号后跟 \s+，光一个 "-" 是正文。
    expect(md("- 甲\n- \n- 乙")).toBe('<ul class="mdl"><li>甲</li><li>乙</li></ul>');
  });

  it("表格：表头 + 分隔行 + 若干行", () => {
    const out = md("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    expect(out).toBe('<div class="mdtw"><table class="mdt">'
      + "<thead><tr><th>a</th><th>b</th></tr></thead>"
      + "<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody>"
      + "</table></div>");
  });

  it("单元格里的字面量 <br> 还原成换行，不显示成 &lt;br&gt;", () => {
    const out = md("| a |\n| --- |\n| 一<br>二 |");
    expect(out).toContain("<td>一<br>二</td>");
    expect(out).not.toContain("&lt;br&gt;");
  });

  it("分隔线三种写法都认", () => {
    for (const s of ["---", "***", "___"]) expect(md(s)).toBe('<hr class="mdhr">');
  });

  it("空输入不炸", () => {
    expect(md("")).toBe("");
    expect(md(null)).toBe("");
    expect(md(undefined)).toBe("");
  });
});
