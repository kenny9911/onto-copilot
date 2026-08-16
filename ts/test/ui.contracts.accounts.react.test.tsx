// @vitest-environment happy-dom
/**
 * 账号面板的转义契约 —— **原来在 ui.contracts.escaping.test.ts 的「账号表：每一个
 * 内联处理器」那一组，四条一条不少地搬过来，换了表述。**
 *
 * 旧判据是「这个值经过了 earg（= eattr ∘ ejs）」，因为那时每一行都是
 * `onclick="doDeleteUser('${earg(id)}','${earg(username)}')"`：值要先当 JS 字面量
 * 转义、再当属性值转义，顺序反了都不行。用户名只经过 strip().lower()（auth.py 的
 * normalize_username），引号一个都不拦 —— `x','');alert(1);//` 对任何打开账号面板
 * 的管理员就是一次存储型 XSS（受害者只是点开了那个面板），而良性的 `o'brien`
 * 会让那一行的按钮直接语法错误、点了没反应。
 *
 * 组件化之后那趟「拼进属性 → HTML 实体解码 → 当 JavaScript 编译」的旅程整个不存在了：
 * 处理器是闭包，参数是**值**。所以判据换成两件真正要保的事：
 *   ① 点下去，处理器收到的是**原样**的字符串（一个字符都没被转义动过）；
 *   ② 用户名落在文本位置时是**字**，不是元素。
 * 外加一条坟头碑：这块 DOM 里一个 `on*` 属性都不许再有。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// 动作换成假的，好断言「收到了什么」。importOriginal 保住 ACCT（组件要读它）。
vi.mock("../src/ui/accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/accounts.js")>();
  return {
    ...actual,
    beginReset: vi.fn(), cancelReset: vi.fn(), changeRole: vi.fn(),
    doAddUser: vi.fn(), doDeleteUser: vi.fn(), doResetPassword: vi.fn(),
    toggleActive: vi.fn(),
  };
});

import { G } from "../src/ui/state.js";
import {
  ACCT, beginReset, changeRole, doDeleteUser, doResetPassword, toggleActive,
} from "../src/ui/accounts.js";
import { AccountsBody } from "../src/ui/react/accounts.js";

/** 攻击者能控制的那一串：用户名只被 strip().lower() 过。 */
const EVIL = `x','');globalThis.__pwned=1;//`;

const hostile = { id: EVIL, username: EVIL, role: "user", active: true };

/** 一行里的按钮：没展开重置表单时是 [重置密码, 删除]，展开后是 [确认, 取消, 删除]。 */
const rowButtons = (c: Element): any[] => [...c.querySelectorAll(".rowacts button")];
const del = (c: Element): any => rowButtons(c).at(-1);

beforeEach(() => {
  delete (globalThis as any).__pwned;
  G.LANG = "zh";
  G.USERS = [];
  G.RESET_ID = null;
  ACCT.err = ""; ACCT.fatal = ""; ACCT.seq = 0;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); });

describe("账号表：每一个处理器", () => {
  it("删除按钮：注入不执行，用户名原样传进去", () => {
    G.USERS = [hostile];
    const { container } = render(<AccountsBody />);
    fireEvent.click(del(container));
    expect(doDeleteUser).toHaveBeenCalledWith(EVIL, EVIL);
    expect((globalThis as any).__pwned).toBeUndefined();
    // 那一整类 bug 的坟头：属性里再也没有 on*，也就没有「解码之后当 JS 编译」这回事。
    expect(container.innerHTML).not.toMatch(/\son[a-z]+=/);
  });

  it("改角色 / 启停用 / 重置密码 / 开始重置 —— 一个都不能漏", () => {
    G.USERS = [hostile];
    const first = render(<AccountsBody />);
    // 这两个原来是 onchange，第二个参数来自 this.value / this.checked
    fireEvent.change(first.container.querySelector("select.input.sm")!, { target: { value: "admin" } });
    expect(changeRole).toHaveBeenCalledWith(EVIL, "admin");
    fireEvent.click(first.container.querySelector('input[type="checkbox"]')!);
    expect(toggleActive).toHaveBeenCalledWith(EVIL, false);
    fireEvent.click(rowButtons(first.container)[0]);
    expect(beginReset).toHaveBeenCalledWith(EVIL);

    cleanup();
    G.RESET_ID = EVIL;                       // 展开那个行内重置表单
    const { container } = render(<AccountsBody />);
    fireEvent.click(container.querySelector(".inlineform .act")!);
    expect(doResetPassword).toHaveBeenCalledWith(EVIL);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("良性的 `o'brien` 不会让按钮语法错误（这也是同一个 bug 的另一面）", () => {
    G.USERS = [{ id: "u1", username: "o'brien", role: "user", active: true }];
    const { container } = render(<AccountsBody />);
    fireEvent.click(del(container));
    expect(doDeleteUser).toHaveBeenCalledWith("u1", "o'brien");
    // 撇号原样显示，不会冒出 &#39; 这种东西
    expect(container.querySelector(".trow:not(.thead) span")!.textContent).toBe("o'brien");
    expect(container.innerHTML).not.toContain("&#39;");
  });

  it("用户名落在文本位置时也转义", () => {
    G.USERS = [{ id: "u1", username: "<script>globalThis.__pwned=1</script>", role: "user", active: true }];
    const { container } = render(<AccountsBody />);
    expect(container.querySelector("script")).toBe(null);
    expect(container.querySelector(".trow:not(.thead) span")!.textContent)
      .toBe("<script>globalThis.__pwned=1</script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
    expect((globalThis as any).__pwned).toBeUndefined();
  });
});
