/**
 * 三个转义函数 + 几个格式化小工具。
 *
 * 这一组是**安全边界**，不是格式化偏好：原文件里那段注释记着一次真实事故 ——
 * 用户名 `x','');window.__pwned=1;//` 只经过 eattr 时，管理员点一下删除按钮
 * 就执行了。浏览器对内联处理器是「先 HTML 实体解码、再当 JS 编译」两道，
 * 所以 earg 必须是 eattr∘ejs，顺序反了就等于没转。这里把那条链钉死。
 */
import "./ui.env.js";

import { describe, expect, it } from "vitest";

import { earg, eattr, ejs, esc, fmtSize, hhmm, nfmt, ph } from "../src/ui/dom.js";

describe("esc / eattr / ejs / earg", () => {
  it("esc 只挡标签，不动引号", () => {
    expect(esc('<b>&"\'')).toBe('&lt;b&gt;&amp;"\'');
  });

  it("eattr 连引号一起挡（属性值会被引号闭合）", () => {
    expect(eattr('<b>&"\'')).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("ejs 按 JS 字面量转义，含 U+2028/U+2029（JS 里也是换行符）", () => {
    expect(ejs("a'b\"c\\d")).toBe("a\\'b\\\"c\\\\d");
    expect(ejs("a\nb\rc")).toBe("a\\nb\\rc");
    expect(ejs("a\u2028b\u2029c")).toBe("a\\u2028b\\u2029c");
  });

  it("earg 让那次真实的注入载荷失效", () => {
    // 原件注释里记的那个用户名。只用 eattr 时它能劈开 onclick="f('…')" 的字符串字面量。
    const payload = `x','');window.__pwned=1;//`;
    const withEattrOnly = eattr(payload);
    // eattr 之后单引号变成 &#39;，浏览器解码回 ' —— 字符串照样被闭合
    expect(withEattrOnly).toContain("&#39;");
    expect(withEattrOnly.replace(/&#39;/g, "'")).toContain("'");

    const safe = earg(payload);
    // earg 之后解码回来的是 \' —— 编译时是一个转义引号，留在字符串里
    const afterHtmlDecode = safe
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(afterHtmlDecode).toBe(`x\\',\\'\\');window.__pwned=1;//`);
    // 这一步是判据本身：解码后的每个单引号前面都必须有反斜杠
    expect(/(^|[^\\])'/.test(afterHtmlDecode)).toBe(false);
  });

  it("null / undefined 一律当空串，不吐 \"null\"", () => {
    for (const f of [esc, eattr, ejs, earg]) {
      expect(f(null)).toBe("");
      expect(f(undefined)).toBe("");
    }
  });
});

describe("格式化小工具", () => {
  it("fmtSize 三档", () => {
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(1023)).toBe("1023 B");
    expect(fmtSize(1024)).toBe("1.0 KB");
    expect(fmtSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(fmtSize(1024 * 1024)).toBe("1.0 MB");
    expect(fmtSize("x")).toBe("0 B"); // +n || 0
  });

  it("nfmt 到 k/M/B", () => {
    expect(nfmt(999)).toBe("999");
    expect(nfmt(1000)).toBe("1.0k");
    expect(nfmt(1_500_000)).toBe("1.50M");
    expect(nfmt(2_000_000_000)).toBe("2.00B");
    expect(nfmt(null)).toBe("0");
  });

  it("hhmm 对非法/零时间戳给空串而不是 1970", () => {
    expect(hhmm(0)).toBe("");
    expect(hhmm(-1)).toBe("");
    expect(hhmm("nope")).toBe("");
    expect(hhmm(1_700_000_000)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("ph 是占位卡片", () => {
    expect(ph("PREVIEW", "空")).toBe('<div class="ph"><div class="ic">PREVIEW</div>空</div>');
  });
});
