// @vitest-environment happy-dom
/**
 * 侧栏底部那块身份区的组件契约。**新加的一组** —— renderIdentity() 原来是一大段
 * 模板字符串，里面藏着几件只在渲染结果里才看得出来的事：
 *
 *   · **本地模式下也必须有一个登录入口。** 后端的注册/登录一直是通的，但界面上
 *     只有「已经开了鉴权」这一条路会弹登录框 —— 而默认没开，于是曾经没有任何
 *     地方能建出第一个账号，只能去命令行敲 `ontocopilot useradd`。
 *   · 「账户管理」只给管理员。
 *   · 头像那个字要按**码点**取：名字里的 emoji 是代理对，按码元切会切出半个。
 *   · 菜单默认收着；点任何一项都要先把它关掉（否则遮罩弹出来，菜单还浮在上面）。
 *   · renderIdentity() 顺手收菜单 —— 旧实现是整块重写 innerHTML 带出来的，换了
 *     框架之后得**显式**写一句，否则切语言时菜单会挂在那儿不动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("../src/ui/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/settings.js")>();
  return { ...actual, openSettings: vi.fn() };
});
vi.mock("../src/ui/accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/accounts.js")>();
  return { ...actual, openAccounts: vi.fn() };
});

import { G } from "../src/ui/state.js";
import { I18N } from "../src/ui/i18n.js";
import { ACCT_MENU, renderIdentity } from "../src/ui/auth.js";
import { openAccounts } from "../src/ui/accounts.js";
import { openSettings } from "../src/ui/settings.js";
import { Identity } from "../src/ui/react/identity.js";

const zh = (k: string): string => I18N.zh![k]!;
const items = (c: Element): string[] => [...c.querySelectorAll(".acctitem")].map(b => b.textContent!);

beforeEach(() => {
  vi.clearAllMocks();
  G.LANG = "zh";
  ACCT_MENU.open = false;
  G.CURRENT_USER = { id: "u1", username: "amy", display_name: "张三", role: "user" };
});
afterEach(() => { cleanup(); });

describe("身份区", () => {
  it("没有当前用户时一格都不占", () => {
    G.CURRENT_USER = null;
    const { container } = render(<Identity />);
    expect(container.innerHTML).toBe("");
  });

  it("本地模式：头像是 OC，给的是**登录入口**而不是「退出」", () => {
    G.CURRENT_USER = { id: "__local__", username: "local", role: "admin" };
    const { container } = render(<Identity />);
    expect(container.querySelector(".acctava")!.textContent).toBe("OC");
    expect(container.querySelector(".acctava")!.className).toContain("ghosted");
    expect(container.querySelector(".acctname")!.textContent).toBe(zh("auth.local"));
    const labels = items(container).join("|");
    expect(labels).toContain(zh("auth.signIn"));
    expect(labels).not.toContain(zh("auth.logout"));
    // 本地模式没有「谁」，个人资料 / 改密码 / 账户管理都不该出现
    expect(labels).not.toContain(zh("auth.profile"));
    expect(labels).not.toContain(zh("auth.accounts"));
    expect(container.querySelector(".idrole")).toBe(null);
  });

  it("「账户管理」只给管理员，退出给所有登录用户", () => {
    const plain = render(<Identity />);
    expect(items(plain.container).join("|")).not.toContain(zh("auth.accounts"));
    expect(items(plain.container).join("|")).toContain(zh("auth.logout"));
    expect(plain.container.querySelector(".idrole")).toBe(null);
    cleanup();

    G.CURRENT_USER = { ...G.CURRENT_USER, role: "admin" };
    const admin = render(<Identity />);
    expect(items(admin.container).join("|")).toContain(zh("auth.accounts"));
    expect(admin.container.querySelector(".idrole")!.textContent).toBe(zh("role.admin"));
  });

  it("头像按**码点**取首字：emoji 名字不会被切出半个", () => {
    G.CURRENT_USER = { id: "u1", username: "amy", display_name: "🐙 章鱼", role: "user" };
    const { container } = render(<Identity />);
    expect(container.querySelector(".acctava")!.textContent).toBe("🐙");
  });

  it("菜单默认收着，点账号按钮才展开", () => {
    const { container } = render(<Identity />);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(true);
    fireEvent.click(container.querySelector("button.acct")!);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(false);
    fireEvent.click(container.querySelector("button.acct")!);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(true);
  });

  it("点菜单项：先关菜单，再做那件事", () => {
    // 不关的话，设置那层遮罩弹出来时菜单还浮在上面 —— 关掉遮罩才发现它一直开着。
    G.CURRENT_USER = { ...G.CURRENT_USER, role: "admin" };
    ACCT_MENU.open = true;
    const { container } = render(<Identity />);
    // 每一项的文字前面还有一个图标 span（`⚙设置`），所以按包含取。
    const pick = (label: string): any =>
      [...container.querySelectorAll(".acctitem")].find(b => b.textContent!.includes(label))!;

    fireEvent.click(pick(zh("auth.settings")));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(ACCT_MENU.open).toBe(false);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(true);

    fireEvent.click(container.querySelector("button.acct")!);   // 再开一次
    fireEvent.click(pick(zh("auth.accounts")));
    expect(openAccounts).toHaveBeenCalledTimes(1);
    expect(ACCT_MENU.open).toBe(false);
  });

  it("renderIdentity() 会顺手把菜单收掉 —— 和旧实现一致", () => {
    // 旧实现整块重写 innerHTML，而模板里的 #acctMenu 写死了 hidden。唯一看得见的
    // 地方是在菜单里点「中 / EN」：setLang → applyI18n → renderIdentity，切完语言
    // 菜单就收起来。换框架不改外观，所以这条得照搬。
    ACCT_MENU.open = true;
    const { container } = render(<Identity />);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(false);
    act(() => { renderIdentity(); });
    expect(ACCT_MENU.open).toBe(false);
    expect((container.querySelector("#acctMenu") as any).hidden).toBe(true);
  });

  it("语言开关：当前语言那颗带 .on（applyI18n 认的就是这个结构）", () => {
    // #langsw 与 data-lang 不能改名 —— applyI18n() 切语言时按这两个选择器给它打勾。
    const { container } = render(<Identity />);
    const sw = container.querySelector("#langsw")!;
    const btn = (l: string): any => sw.querySelector(`button[data-lang="${l}"]`);
    expect(btn("zh").className).toBe("on");
    expect(btn("en").className).toBe("");
    expect(btn("zh").textContent).toBe("中");
    expect(btn("en").textContent).toBe("EN");
  });
});
