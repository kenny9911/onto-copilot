/**
 * 内联事件处理器里的三层转义（原 tests/test_ui_question_workbench.py 的 XSS 那一组）。
 *
 * 判据不是"写法好看"，是**浏览器的真实解析顺序**：属性值先做 HTML 实体解码，
 * 解码后的字符串再当 JavaScript 编译。所以：
 *   esc   → 文本节点（只挡标签）
 *   eattr → 普通属性值（还要挡引号，否则能闭合属性）
 *   earg  → 内联处理器里的字符串参数（eattr ∘ ejs，顺序不能反）
 *
 * **eattr 一个人不够。** `&#39;` 解码回 `'`，照样劈开 onclick="f('…')" 里那个字面量。
 * 用户名只经过 strip().lower()（auth.py 的 normalize_username），引号一个都不拦，
 * 于是 `x','');alert(1);//` 对任何打开账号面板的管理员就是一次存储型 XSS ——
 * 受害者只是点开了那个面板。良性的 `o'brien` 则让按钮直接失灵。
 *
 * 下面那条端到端用例按浏览器的顺序真的走一遍：earg 拼进属性 → HTML 解码 →
 * 当 JS 编译，然后断言 ①没有执行任何注入代码 ②处理器拿到的仍是原样字符串。
 */
import "./ui.env.js";
import { el, resetDom } from "./ui.env.js";

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { G } from "../src/ui/state.js";
import { earg, eattr, ejs } from "../src/ui/dom.js";
import { I18N } from "../src/ui/i18n.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_SRC = resolve(ROOT, "ts", "src", "ui");

/** 前端会落到浏览器手里的全部源码：TS 模块 + 打包出来的那份单文件。 */
function shippedSources(): Array<[string, string]> {
  const mods = readdirSync(UI_SRC)
    .filter(f => f.endsWith(".ts") && f !== "browser.d.ts")
    .map(f => [`ts/src/ui/${f}`, readFileSync(resolve(UI_SRC, f), "utf8")] as [string, string]);
  return [...mods, ["ui/index.html", readFileSync(resolve(ROOT, "ui", "index.html"), "utf8")]];
}

// ── 按浏览器的顺序跑一遍内联处理器 ──────────────────────────────
const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
};
/** 属性值的 HTML 实体解码。**一遍扫完**，和浏览器一样，不重复解码。 */
const htmlDecode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, m => ENTITIES[m]!);

/** 取出 html 里第一个包含 `fn(` 的内联处理器的属性值。 */
function handlerAttr(html: string, fn: string): string {
  for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) {
    if (m[1]!.includes(`${fn}(`)) return m[1]!;
  }
  throw new Error(`没找到调用 ${fn}( 的内联处理器`);
}

/**
 * 把一个内联处理器当浏览器那样执行：解码 → 编译 → 调用。
 * 返回被调函数收到的参数；注入代码若真的执行了，globalThis.__pwned 会被置上。
 * `self` 就是浏览器里的 this（onchange 那两个读 this.value / this.checked）。
 */
function fireHandler(html: string, fn: string, self: unknown = null): unknown[] {
  const decoded = htmlDecode(handlerAttr(html, fn));
  let received: unknown[] = [];
  const stubs: Record<string, unknown> = {
    event: { stopPropagation() {} },
    [fn]: (...args: unknown[]) => { received = args; },
  };
  const names = Object.keys(stubs);
  // 语法错误在这里就会抛 —— 一个良性的 `o'brien` 弄坏处理器同样算失败
  const compiled = new Function(...names, decoded);
  compiled.call(self, ...names.map(n => stubs[n]));
  return received;
}

/** 攻击者能控制的那一串：用户名只被 strip().lower() 过。 */
const EVIL = `x','');globalThis.__pwned=1;//`;

beforeEach(() => {
  resetDom();
  delete (globalThis as any).__pwned;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0,
          state: { dialogue: { turns: [] } }, events: [] };
  G.MODE = "work"; G.PROJECTS_OK = false; G.SESSION_LIST = [];
  G.LANG = "zh"; G.CURRENT_USER = null; G.USERS = []; G.RESET_ID = null;
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = [];
  G.PROMPTS = []; G.FOLLOWUPS = []; G.QUOTA = null; G.Q_BACKLOG = [];
  G.THINKING = false; G.CHAT_ABORT = null; G.NEEDS_CONFIRM = false;
  G.SEEN_SID = null; G.SEEN_BUBBLES = 0;
  (globalThis as any).sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

// ══════════════════════════════════════════════════════════════════
//  三层转义各自的位置
// ══════════════════════════════════════════════════════════════════
describe("earg = eattr ∘ ejs —— 顺序不能反", () => {
  it("先按 JS 字面量转义，再按属性转义", () => {
    for (const s of [EVIL, `客户'A'的项目`, 'a"b', "a\\b", "行一\n行二", "a\u2028b"]) {
      expect(earg(s)).toBe(eattr(ejs(s)));
    }
  });

  it("反过来（先 eattr 再 ejs）会把值毁掉 —— 不是「两个都用了就行」", () => {
    const wrong = ejs(eattr(`客户'A'`));
    expect(wrong).not.toBe(earg(`客户'A'`));
    // 反序之后实体里的分号/井号被 JS 转义带走，解码回来已经不是原来那串
    expect(htmlDecode(wrong)).not.toBe(htmlDecode(earg(`客户'A'`)));
  });

  it("ejs 挡的是 JS 字面量里的一切分隔符，含 U+2028/U+2029", () => {
    expect(ejs("a'b")).toBe("a\\'b");
    expect(ejs("a\nb")).toBe("a\\nb");
    expect(ejs("a\u2028b")).toBe("a\\u2028b");   // eslint-disable-line no-irregular-whitespace
    expect(ejs("a\\b")).toBe("a\\\\b");
  });
});

// ══════════════════════════════════════════════════════════════════
//  「会话行：删除与改名处理器」那 4 条搬去了 test/ui.sidebar.test.tsx。
//
//  **不是删掉，是换了表述**：会话行现在是 <ConvRow>（react/sidebar.tsx），
//  `onclick="dropSession('${earg(id)}','${earg(title)}')"` 那一整层已经不存在，
//  参数直接是值。原来断的是「拼出来的字面量劈不开」，搬过去之后断的是
//  「渲染结果里一个 on* 属性都没有，且处理器收到的是原样的值」—— 后者才是那 4 条
//  真正要保的东西，而且对组件测得了。earg 本身的契约（上面那 3 条）留在原处。
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  「账号表：每一个内联处理器」那 4 条搬去了 test/ui.contracts.accounts.react.test.tsx。
//
//  同样**不是删掉，是换了表述**：账号表现在是 <AccountsBody>（react/accounts.tsx），
//  `onclick="doDeleteUser('${earg(id)}','${earg(username)}')"` 那一层不存在了。
//  搬过去之后断的是「点下去处理器收到的是原样的值」+「用户名落在文本位置时是字
//  不是元素」+「这块 DOM 里一个 on* 属性都没有」。
//  earg 本身的契约（上面那 3 条）留在原处：decisions.ts 与 preview.ts 还在拼内联
//  处理器，那两处一天没迁完，这三条就一天不能少。
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  通杀式回归：逐个点名会漏掉下一个新写的处理器，所以按模式扫
// ══════════════════════════════════════════════════════════════════
describe("源码级通扫", () => {
  it("内联处理器里的字符串参数只能用 earg，esc / eattr 单用都不行", () => {
    const bad: string[] = [];
    for (const [file, src] of shippedSources()) {
      for (const m of src.matchAll(/on[a-z]+="[^"]*\$\{(?:esc|eattr)\(/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("display_name 是自由文本，**绝不能**进内联处理器", () => {
    const bad: string[] = [];
    for (const [file, src] of shippedSources()) {
      for (const m of src.matchAll(/on[a-z]+="[^"]*display_name/g)) bad.push(`${file}: ${m[0]}`);
      for (const m of src.matchAll(/'\$\{esc\([A-Za-z_.]*display_name/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});

// 「空状态问候语」那 5 条搬去了 ui.react.stream.test.tsx —— 那一行字现在落进
//  <Stream> 的一个 JSX 文本节点（react/stream.tsx），由 React 转义，不再是拼进
//  innerHTML 的一段标记。判据一个字没改：认得出人就叫名字、认不出回落到 tagline、
//  刚注册的说「欢迎」、有对话时不再挂在流顶上，以及**名字里的标记必须是字**。

describe("i18n 字典", () => {
  it("zh / en 的键完全对齐 —— 少一个键就是界面上冒出一句原始 key", () => {
    const zh = Object.keys(I18N["zh"]!).sort(), en = Object.keys(I18N["en"]!).sort();
    expect(en.filter(k => !I18N["zh"]![k])).toEqual([]);
    expect(zh.filter(k => !I18N["en"]![k])).toEqual([]);
  });

  it("问候语与登录/注册那几个键两边都在", () => {
    for (const key of ["login.displayName", "register.needName",
                       "empty.tagline", "empty.welcomeBack", "empty.welcomeNew"]) {
      expect(I18N["zh"]![key], `zh 少了 ${key}`).toBeTruthy();
      expect(I18N["en"]![key], `en 少了 ${key}`).toBeTruthy();
    }
  });

  it("t() 自己不转义（所以调用方必须先 esc）", () => {
    expect(I18N["zh"]!["empty.welcomeBack"]).toContain("{name}");
  });
});
