// @vitest-environment happy-dom
/**
 * 设置面板的组件契约。**这一组是新加的**：settings.ts 从「拼三段 innerHTML」变成
 * 三个组件，中间有几件事只在组件里才成立，静态检查一条都拦不住 ——
 *
 *   · 网关那一栏只有管理员看得见（普通用户连 tab 都不该有）；
 *   · 网关表单里的 API Key 是**只写字段**：脱敏串只能当 placeholder，一旦写进
 *     value，保存时就会把那串带省略号的假 key 原样发回服务端；
 *   · 用量的金额只认网关回的真实账单（cost_note==="none" 时一个数都不许显示）；
 *   · 那几个输入框必须是**非受控**的 —— saveConfig 按 id 读它们，给了 value 就
 *     变成受控，用户敲进去的字会被下一次渲染抹掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { G } from "../src/ui/state.js";
import { I18N } from "../src/ui/i18n.js";
import { CFG, SETB } from "../src/ui/settings.js";
import {
  AppearanceTab, ConfigForm, SettingsBody, SettingsTabs, UsageTab,
} from "../src/ui/react/settings.js";

const zh = (k: string): string => I18N.zh![k]!;

beforeEach(() => {
  G.LANG = "zh";
  G.CURRENT_USER = { id: "u1", username: "amy", role: "admin" };
  G.SET_TAB = "appearance";
  G.CONFIG = null; G.USAGE = null; G.USAGE_DAYS = 7; G.USAGE_ROWS_OPEN = false;
  SETB.loading = ""; SETB.error = "";
  CFG.err = ""; CFG.saved = false; CFG.seq = 0;
  localStorage.clear();
  // savePref 会把偏好同步一份到 /api/me/prefs（登录用户换台机器也该是同一套外观）。
  // 这里不测那条请求，但也不能让它真的去连 localhost:3000。
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("tab 条", () => {
  it("网关那一栏只有管理员看得见", () => {
    const admin = render(<SettingsTabs />);
    expect([...admin.container.querySelectorAll(".stab")].map(b => b.textContent))
      .toEqual([zh("appearance.title"), zh("usage.title"), zh("settings.gateway")]);
    cleanup();
    G.CURRENT_USER = { id: "u2", username: "bob", role: "user" };
    const plain = render(<SettingsTabs />);
    expect([...plain.container.querySelectorAll(".stab")].map(b => b.textContent))
      .toEqual([zh("appearance.title"), zh("usage.title")]);
  });

  it("选中的那个带 .on，别的不带", () => {
    G.SET_TAB = "usage";
    const { container } = render(<SettingsTabs />);
    const on = [...container.querySelectorAll(".stab.on")];
    expect(on).toHaveLength(1);
    expect(on[0]!.textContent).toBe(zh("usage.title"));
  });
});

describe("正文按 tab 分派", () => {
  it("外观 / 用量 / 网关各画各的", () => {
    const app = render(<SettingsBody />);
    expect(app.container.textContent).toContain(zh("appearance.theme"));
    cleanup();

    G.SET_TAB = "system";
    G.CONFIG = { gateway: {}, tiers: {}, catalog: [], env: [], budget: {} };
    const sys = render(<SettingsBody />);
    expect(sys.container.textContent).toContain(zh("settings.baseUrl"));
  });

  it("普通用户就算 SET_TAB 是 system 也进不去网关表单", () => {
    // 那一栏的 tab 本来就不给他，但 SET_TAB 是全局状态（切换账号、旧状态残留都
    // 可能留下 "system"）—— 正文这一层得自己再判一次，不能只靠 tab 条藏起来。
    G.CURRENT_USER = { id: "u2", username: "bob", role: "user" };
    G.SET_TAB = "system";
    G.CONFIG = { gateway: { base_url: "https://x" }, tiers: {}, catalog: [], env: [], budget: {} };
    const { container } = render(<SettingsBody />);
    expect(container.textContent).not.toContain(zh("settings.baseUrl"));
    expect(container.textContent).toContain(zh("appearance.theme"));
  });

  it("加载中与失败各自只占一句话，不留半张旧表单", () => {
    SETB.loading = zh("usage.loading");
    const loading = render(<SettingsBody />);
    expect(loading.container.querySelector(".cap")!.textContent).toBe(zh("usage.loading"));
    expect(loading.container.textContent).not.toContain(zh("appearance.theme"));
    cleanup();

    SETB.loading = ""; SETB.error = "网关连不上";
    const failed = render(<SettingsBody />);
    expect(failed.container.querySelector(".fnd")!.textContent).toBe("网关连不上");
    expect(failed.container.textContent).not.toContain(zh("appearance.theme"));
  });
});

describe("外观", () => {
  it("**「没选过」和「选了 green」是两回事**", () => {
    // 默认态下把 green 画成选中，用户看着像已经选了一个颜色，也就没法表达
    // 「我要回默认」——「默认」那颗按钮的选中态是这件事唯一的出口。
    /** 强调色那一段（第二个 .sgrp）。 */
    const accentRow = (c: Element): Element => c.querySelectorAll(".sgrp")[1]!;
    const fresh = render(<AppearanceTab />);
    expect(accentRow(fresh.container).querySelector(".act.pri")!.textContent)
      .toBe(zh("appearance.accent.default"));
    expect(fresh.container.querySelector(".swatch.on")).toBe(null);
    cleanup();

    localStorage.setItem("oc_accent", "green");
    const picked = render(<AppearanceTab />);
    expect(picked.container.querySelector(".swatch.on")!.getAttribute("title")).toBe("墨绿");
    expect(accentRow(picked.container).querySelector(".act.pri")).toBe(null);   // 「默认」不再选中
  });

  it("点主题：写进 localStorage，选中态跟着走", () => {
    const { container } = render(<AppearanceTab />);
    const dark = [...container.querySelectorAll(".schoice .act")]
      .find(b => b.textContent === zh("appearance.theme.dark"))!;
    fireEvent.click(dark);
    expect(localStorage.getItem("oc_theme")).toBe("dark");
    expect([...container.querySelectorAll(".schoice .act.pri")].map(b => b.textContent))
      .toContain(zh("appearance.theme.dark"));
  });
});

describe("用量", () => {
  const usage = (extra: Record<string, unknown>): any => ({
    total: { tokens: 100, calls: 2, tok_in: 60, tok_out: 40 },
    series: [], by_model: [], by_kind: [], rows: [], ...extra,
  });

  it("cost_note 是 none 时一个金额都不显示", () => {
    // 本地价目表对经网关发现的模型是统一编的，拿它算出来的钱看着精确其实是错的 ——
    // 显示一个假的金额比不显示更糟。
    G.USAGE = usage({ cost_note: "none" });
    const { container } = render(<UsageTab />);
    expect(container.textContent).not.toContain(zh("usage.cost"));
    expect(container.textContent).not.toContain("$");
    cleanup();

    G.USAGE = usage({ cost_note: "billed", total: { tokens: 1, calls: 1, usd_billed: 1.5, billed_calls: 1 } });
    const billed = render(<UsageTab />);
    expect(billed.container.textContent).toContain("$1.5000");
  });

  it("明细默认只出 8 行，「展开」之后才全出", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ ts: 0, model: `m${i}`, tokens: 1, status: "ok" }));
    G.USAGE = usage({ cost_note: "none", rows });
    const { container } = render(<UsageTab />);
    expect(container.querySelectorAll(".envtbl .envrow")).toHaveLength(8);
    fireEvent.click([...container.querySelectorAll("button.act")].at(-1)!);
    expect(container.querySelectorAll(".envtbl .envrow")).toHaveLength(12);
  });
});

describe("网关表单", () => {
  const config = {
    gateway: { base_url: "https://gw.example/v1", api_key: "sk-…9f2" },
    tiers: { low: { model: "m-small" } },
    catalog: [{ name: "m-small" }, { name: "m-big", vendor: "acme", quality: "high" }],
    budget: { usd_cap: 5 },
    env: [{ name: "OC_DB", set: true, value: "postgres://…", secret: true }],
    balance: { known: false },
  };

  it("API Key 是只写字段：脱敏串只当 placeholder，输入框本身是空的", () => {
    // 写进 value 的话，用户什么都没改也会把那串带省略号的假 key 发回服务端 ——
    // saveConfig 里那句 `!apiKey.includes("…")` 是第二道闸，这里是第一道。
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    const key: any = container.querySelector("#cfgApiKey");
    expect(key.getAttribute("placeholder")).toBe("sk-…9f2");
    expect(key.value).toBe("");
    expect(key.getAttribute("type")).toBe("password");
  });

  it("saveConfig 按 id 读的那几个框都在，而且都是**非受控**的（敲得进字）", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    for (const id of ["cfgBaseUrl", "cfgApiKey", "cfgUsdCap", "cfgChatUsdCap",
      "tier_low", "tier_medium", "tier_high", "tier_critical"]) {
      expect(container.querySelector("#" + id), `${id} 不在了 —— saveConfig 会读到 null`).not.toBe(null);
    }
    const base: any = container.querySelector("#cfgBaseUrl");
    expect(base.value).toBe("https://gw.example/v1");
    fireEvent.change(base, { target: { value: "https://other/v1" } });
    expect(base.value, "受控化了：用户敲进去的字被渲染抹掉了").toBe("https://other/v1");
    expect((container.querySelector("#tier_low") as any).value).toBe("m-small");
  });

  it("保存的两行反馈：平时都不占位置，出错和成功各自只出一条", () => {
    G.CONFIG = config;
    const clean = render(<ConfigForm />);
    expect((clean.container.querySelector("#cfgErr") as any).style.display).toBe("none");
    expect((clean.container.querySelector("#cfgSaved") as any).style.display).toBe("none");
    cleanup();

    CFG.err = "403 forbidden";
    const bad = render(<ConfigForm />);
    expect(bad.container.querySelector("#cfgErr")!.textContent).toBe("403 forbidden");
    expect((bad.container.querySelector("#cfgErr") as any).style.display).toBe("block");
    cleanup();

    CFG.err = ""; CFG.saved = true;
    const ok = render(<ConfigForm />);
    expect((ok.container.querySelector("#cfgSaved") as any).style.display).toBe("inline");
    expect(ok.container.querySelector("#cfgSaved")!.textContent).toBe(zh("settings.saved"));
  });
});
