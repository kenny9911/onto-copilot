// @vitest-environment happy-dom
/**
 * 转义契约的 **React 版表述** —— 给另外四条 track 照抄的范例。
 *
 * ## 为什么必须换一种说法，而不是删掉
 *
 * `ui.contracts.escaping.test.ts` 那 21 条断的是「这个值经过了 esc / eattr / earg」。
 * 那是**手工拼 innerHTML** 时代的判据：值最终落在文本节点、属性值、还是内联处理器里的
 * JS 字面量，各要一层不同的转义，漏一层就是一次存储型 XSS（`x','');alert(1);//`
 * 这个用户名只要有管理员点开账号面板就会执行）。
 *
 * React 下这三层里的两层从根上没有了：JSX 的文本节点和属性值都由框架转义，
 * 内联处理器整个消失（`onclick="f('${earg(x)}')"` 变成 `onClick={() => f(x)}`，
 * 参数是**值**，不再经历「拼进属性 → HTML 实体解码 → 当 JavaScript 编译」那趟旅程）。
 * 于是「调用了 esc()」这个断言不但失去意义，反而会挡住正确的写法。
 *
 * **但要保的东西一个字没变**：恶意输入必须渲染成文本，不能变成标记。
 * 所以判据从「调用了哪个函数」换成「喂进去，看渲染结果里它是什么」——
 * 后者才是真正的契约，而且对任何实现都测得了。
 *
 * ## 照抄这个文件的四种形状
 *
 *   1. 文本位置：喂 EVIL_TAG，断言 container.querySelector("img") 是 null、字面量在 textContent 里
 *   2. 属性位置：断言整棵子树的属性名集合里没有多出来的东西（尤其没有 on*）
 *   3. 事件参数：断言渲染结果里**一个 on* 属性都没有**，且点击时处理器收到的是原样的值
 *   4. dangerouslySetInnerHTML：**只有 markdown 那一条路**，每一种 md 语法都要有一条注入用例
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// 处理器换成了真函数调用，所以断言「收到什么」要把它们换成假的。
// importOriginal 保住同模块里那些**被组件当纯函数用**的导出（statusText）。
vi.mock("../src/ui/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/sessions.js")>();
  return { ...actual, dropSession: vi.fn(), openSession: vi.fn(), renameSession: vi.fn() };
});

const { G } = await import("../src/ui/state.js");
const { dropSession, openSession, renameSession } = await import("../src/ui/sessions.js");
const { Bubble, ConvRow } = await import("../src/ui/react/reference.js");
const { Markdown } = await import("../src/ui/react/markdown.js");

/** 攻击者能控制的那几串。第一条是这次换框架之后最该盯的形状。 */
const EVIL_TAG = `"><img src=x onerror=alert(1)>`;
/** 旧世界里那条真事故：用户名只被 strip().lower() 过，引号一个都不拦。 */
const EVIL_JS = `x','');globalThis.__pwned=1;//`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_SRC = resolve(ROOT, "ts", "src", "ui");

/** ts/src/ui 下**递归**的全部源码 + 打出来的那份单文件。 */
function shippedSources(): Array<[string, string]> {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    if (f.endsWith(".d.ts")) return [];        // 声明文件里没有运行时代码
    return f.endsWith(".ts") || f.endsWith(".tsx") ? [p] : [];
  });
  const mods = walk(UI_SRC).map(p =>
    [`ts/${relative(resolve(ROOT, "ts"), p)}`, readFileSync(p, "utf8")] as [string, string]);
  return [...mods, ["ui/index.html", readFileSync(resolve(ROOT, "ui", "index.html"), "utf8")]];
}

/** 去掉整行注释。通扫要断的是**代码**，注释里写着 `earg(` 的说明文字不算违规。 */
const codeLines = (src: string): string =>
  src.split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");

/** 一棵子树上出现过的全部属性名。属性值若"逃"出去，一定表现为多出来的属性名。 */
function attrNames(root: Element): Set<string> {
  const names = new Set<string>();
  const visit = (el: Element): void => {
    for (const a of Array.from(el.attributes) as any[]) names.add(a.name);
    for (const c of Array.from(el.children) as any[]) visit(c);
  };
  visit(root);
  return names;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as any).__pwned;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0,
          state: { dialogue: { turns: [] } }, events: [] };
  G.MODE = "work"; G.PROJECTS_OK = false; G.LANG = "zh"; G.STREAM = null;
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  ① 文本位置：喂标记进去，出来必须是字
// ══════════════════════════════════════════════════════════════════
describe("文本位置", () => {
  it("会话标题里的 <img onerror> 是文本，不是元素", () => {
    const { container } = render(<ConvRow s={{ id: "s1", title: EVIL_TAG, status: "done", files: 2 }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".t")!.textContent).toBe(EVIL_TAG);
  });

  it("用户气泡里的 <script> 是文本，不是元素", () => {
    const { container } = render(<Bubble turn={{ speaker: "user", text: `<script>globalThis.__pwned=1</script>` }} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".body")!.textContent).toBe(`<script>globalThis.__pwned=1</script>`);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("良性的 `客户'A'的项目` 原样显示 —— 不冒出 &#39; 这种东西", () => {
    const { container } = render(<ConvRow s={{ id: "s1", title: `客户'A'的项目`, status: "done", files: 0 }} />);
    expect(container.querySelector(".t")!.textContent).toBe(`客户'A'的项目`);
    expect(container.innerHTML).not.toContain("&#39;");
  });
});

// ══════════════════════════════════════════════════════════════════
//  ② 属性位置：值不许长出新属性
// ══════════════════════════════════════════════════════════════════
describe("属性位置", () => {
  it("敌意标题/id 之后，属性名集合还是那几个 —— 没有 on* 混进来", () => {
    G.PROJECTS_OK = true;                       // 把 draggable 那一支也打开
    const { container } = render(<ConvRow s={{ id: EVIL_TAG, title: EVIL_TAG, status: "done", files: 1 }} />);
    const names = attrNames(container.querySelector(".conv")!);
    expect([...names].filter(n => n.startsWith("on"))).toEqual([]);
    expect([...names].sort()).toEqual(["class", "draggable", "title"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ③ 事件参数：内联处理器整套消失，参数是值
// ══════════════════════════════════════════════════════════════════
describe("事件参数", () => {
  it("渲染结果里一个内联处理器属性都没有 —— earg 那一层的 bug 无处可生", () => {
    const { container } = render(<ConvRow s={{ id: EVIL_JS, title: EVIL_JS, status: "done", files: 0 }} />);
    expect(container.innerHTML).not.toMatch(/\son[a-z]+=/);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("点删除：处理器收到的是原样字符串，一个字符都没被转义动过", () => {
    const { container } = render(<ConvRow s={{ id: EVIL_JS, title: EVIL_JS, status: "done", files: 0 }} />);
    fireEvent.click(container.querySelector(".del")!);
    expect(dropSession).toHaveBeenCalledWith(EVIL_JS, EVIL_JS);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("良性的 `o'brien` 点得动（旧世界里 eattr 单用会让这个按钮语法错误）", () => {
    const { container } = render(<ConvRow s={{ id: "u1", title: "o'brien", status: "done", files: 0 }} />);
    fireEvent.click(container.querySelector(".del")!);
    expect(dropSession).toHaveBeenCalledWith("u1", "o'brien");
  });

  it("双击改名、点整行打开：参数同样是原样的值", () => {
    const { container } = render(<ConvRow s={{ id: EVIL_TAG, title: "正常标题", status: "done", files: 0 }} />);
    fireEvent.doubleClick(container.querySelector(".t")!);
    expect(renameSession).toHaveBeenCalledWith(EVIL_TAG);
    fireEvent.click(container.querySelector(".conv")!);
    expect(openSession).toHaveBeenCalledWith(EVIL_TAG);
  });

  it("行内按钮不会顺带触发整行的 onClick（stopPropagation 还在）", () => {
    const { container } = render(<ConvRow s={{ id: "s9", title: "T", status: "done", files: 0 }} />);
    fireEvent.click(container.querySelector(".del")!);
    expect(openSession).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
//  ④ dangerouslySetInnerHTML —— React 下唯一还能被打穿的地方
// ══════════════════════════════════════════════════════════════════
describe("markdown（唯一的 dangerouslySetInnerHTML）", () => {
  const mdRender = (text: string) => render(<Markdown text={text} />).container;

  it("正文里的 <img onerror> 是文本", () => {
    const c = mdRender(`看这个 ${EVIL_TAG} 行不行`);
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain(EVIL_TAG);
  });

  it("<script> 既不成元素也不执行", () => {
    const c = mdRender(`<script>globalThis.__pwned=1</script>`);
    expect(c.querySelector("script")).toBeNull();
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("代码块里的注入也是文本（keep() 把内容原样搬进 <pre>，靠的是它已经被 esc 过）", () => {
    const c = mdRender("```html\n" + EVIL_TAG + "\n```");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("pre.mdcode")!.textContent).toContain(EVIL_TAG);
  });

  it("行内代码里的注入也是文本", () => {
    const c = mdRender("试试 `" + EVIL_TAG + "` 这个");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("code.mdik")!.textContent).toBe(EVIL_TAG);
  });

  it("表格单元格里的注入也是文本", () => {
    const c = mdRender(`| 名称 | 说明 |\n| --- | --- |\n| ${EVIL_TAG} | x |`);
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("table.mdt td")!.textContent).toBe(EVIL_TAG);
  });

  it("标题 / 列表里的注入也是文本", () => {
    const c = mdRender(`# ${EVIL_TAG}\n- ${EVIL_TAG}`);
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".mdh")!.textContent).toBe(EVIL_TAG);
    expect(c.querySelector("ul.mdl li")!.textContent).toBe(EVIL_TAG);
  });

  it("**md() 唯一放回去的标记是 <br>，而且带不了属性**", () => {
    // md() 末尾那句 `&lt;br&gt;` → `<br>` 是为了表格单元格里模型爱写的字面量换行。
    // 正则只认光秃秃的 br，`<br onload=…>` 匹配不上，仍然是文本。
    expect(mdRender("a<br>b").querySelectorAll("br").length).toBeGreaterThan(0);
    const c = mdRender(`a<br onload=alert(1)>b`);
    expect(c.querySelectorAll("br")).toHaveLength(0);          // 没变成元素
    expect(c.textContent).toContain("<br onload=alert(1)>");   // 原样显示成字
    // 顺带把「整棵子树上没有 on* 属性」也断一遍 —— textContent 里出现 "onload"
    // 是正常的（那是显示出来的字），属性名里出现才是事故。
    expect([...attrNames(c)].filter(n => n.startsWith("on"))).toEqual([]);
  });

  it("助手气泡走的就是这条路（结构仍是 .bub.oc > .body > .mdbody）", () => {
    const { container } = render(<Bubble turn={{ speaker: "assistant", text: `**粗** ${EVIL_TAG}` }} />);
    expect(container.querySelector(".bub.oc > .body > .mdbody")).not.toBeNull();
    expect(container.querySelector("strong")!.textContent).toBe("粗");
    expect(container.querySelector("img")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 源码级通扫：逐个点名会漏掉下一个新写的组件
// ══════════════════════════════════════════════════════════════════
describe("源码通扫", () => {
  it("dangerouslySetInnerHTML 只准出现在 react/markdown.tsx", () => {
    const hits = shippedSources()
      .filter(([f]) => f !== "ui/index.html" && f !== "ts/src/ui/react/markdown.tsx")
      .filter(([, src]) => codeLines(src).includes("dangerouslySetInnerHTML"))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it("组件里不许再出现 innerHTML 赋值 —— 那是绕开 React 的后门", () => {
    const bad: string[] = [];
    for (const [file, src] of shippedSources()) {
      if (!file.endsWith(".tsx")) continue;
      for (const m of codeLines(src).matchAll(/\.innerHTML\s*=/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("组件里不许再调 esc / eattr / earg —— 再转一遍只会在界面上显示出 &lt;", () => {
    const bad: string[] = [];
    for (const [file, src] of shippedSources()) {
      if (!file.endsWith(".tsx")) continue;
      for (const m of codeLines(src).matchAll(/(?<![\w.])(?:esc|eattr|earg|ejs)\(/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
