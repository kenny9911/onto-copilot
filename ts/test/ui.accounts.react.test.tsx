// @vitest-environment happy-dom
/**
 * 账号面板除转义之外的组件契约（转义那 4 条在 ui.contracts.accounts.react.test.tsx）。
 * **新加的一组**，钉的是「从 innerHTML 换成组件」这一步最容易悄悄改掉的三件事：
 *
 *   · 新增账号那三个输入框是**非受控**的（doAddUser 按 id 读它们），而旧代码每次
 *     renderAccounts() 都把整块 innerHTML 重写一遍 —— 输入框跟着清空。React 会
 *     **留住**同一批 DOM 节点，不做点什么的话，新增失败后那两个框还满着，
 *     密码也一直留在页面上。
 *   · 连用户列表都没拉到时，整块只剩一句话，不该露出半张空表格。
 *   · 行内那条 .err 平时不占位置（`.err` 有底色和边框，空着也会画出一条红条）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { G } from "../src/ui/state.js";
import { I18N } from "../src/ui/i18n.js";
import { ACCT, acctError, renderAccounts } from "../src/ui/accounts.js";
import { AccountsBody } from "../src/ui/react/accounts.js";

const zh = (k: string): string => I18N.zh![k]!;

beforeEach(() => {
  G.LANG = "zh";
  G.USERS = [{ id: "u1", username: "amy", role: "admin", active: true },
             { id: "u2", username: "bob", role: "user", active: false }];
  G.RESET_ID = null;
  ACCT.err = ""; ACCT.fatal = ""; ACCT.seq = 0;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); });

describe("账号面板", () => {
  it("表头 + 每个账号一行，角色和启用状态照着数据画", () => {
    const { container } = render(<AccountsBody />);
    expect(container.querySelectorAll(".trow")).toHaveLength(3);   // 表头 + 两行
    expect(container.querySelector(".trow.thead")!.textContent)
      .toBe(zh("accounts.username") + zh("accounts.role") + zh("accounts.active") + zh("accounts.actions"));
    const selects: any[] = [...container.querySelectorAll("select.input.sm")];
    expect(selects.map(s => s.value)).toEqual(["admin", "user"]);
    const boxes: any[] = [...container.querySelectorAll('input[type="checkbox"]')];
    expect(boxes.map(b => b.checked)).toEqual([true, false]);
  });

  it("**renderAccounts() 之后新增表单是空的** —— 密码不会留在页面上", () => {
    const { container } = render(<AccountsBody />);
    const user: any = container.querySelector("#newUsername");
    const pass: any = container.querySelector("#newPassword");
    fireEvent.change(user, { target: { value: "carol" } });
    fireEvent.change(pass, { target: { value: "hunter2" } });
    expect(user.value).toBe("carol");        // 非受控：敲得进字（受控化就会被抹掉）

    // 旧代码是「整块 innerHTML 重写」，输入框因此清空 —— 新增成功、新增失败
    // （重名）、开始重置密码，走的都是这一条路。
    act(() => { renderAccounts(); });
    expect((container.querySelector("#newUsername") as any).value).toBe("");
    expect((container.querySelector("#newPassword") as any).value).toBe("");
  });

  it("行内错误：平时不占位置，acctError() 之后才出现", () => {
    const { container } = render(<AccountsBody />);
    const err = (): any => container.querySelector("#acctErr");
    expect(err().style.display).toBe("none");
    expect(err().textContent).toBe("");
    act(() => { acctError(zh("accounts.errLastAdmin")); });
    expect(err().style.display).toBe("block");
    expect(err().textContent).toBe(zh("accounts.errLastAdmin"));
  });

  it("连用户列表都没拉到：整块只剩一句话，不露出半张空表格", () => {
    ACCT.fatal = "503 service unavailable";
    const { container } = render(<AccountsBody />);
    expect(container.querySelector(".fnd")!.textContent).toBe("503 service unavailable");
    expect(container.querySelector(".tbl")).toBe(null);
    expect(container.querySelector("#newUsername")).toBe(null);
  });

  it("重置密码的行内表单只在那一行展开", () => {
    G.RESET_ID = "u2";
    const { container } = render(<AccountsBody />);
    const forms = container.querySelectorAll(".inlineform");
    expect(forms).toHaveLength(1);
    expect(forms[0]!.querySelector("#resetPwInput")).not.toBe(null);
    // 展开的是 bob 那一行（第二行数据）
    const rows = [...container.querySelectorAll(".trow:not(.thead)")];
    expect(rows[0]!.querySelector(".inlineform")).toBe(null);
    expect(rows[1]!.querySelector(".inlineform")).not.toBe(null);
    // 密码框是非受控的：doResetPassword 按 id 读它
    const input: any = container.querySelector("#resetPwInput");
    fireEvent.change(input, { target: { value: "s3cret" } });
    expect(input.value).toBe("s3cret");
    expect(input.getAttribute("type")).toBe("password");
  });
});
