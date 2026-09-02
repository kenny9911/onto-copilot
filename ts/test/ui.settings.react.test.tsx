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
  it("网关那一栏只有管理员看得见，**日志那一栏所有人都有**", () => {
    const admin = render(<SettingsTabs />);
    expect([...admin.container.querySelectorAll(".stab")].map(b => b.textContent))
      .toEqual([zh("appearance.title"), zh("usage.title"), zh("logs.title"), zh("settings.gateway")]);
    cleanup();
    G.CURRENT_USER = { id: "u2", username: "bob", role: "user" };
    const plain = render(<SettingsTabs />);
    // 日志**不**按管理员收起：普通用户看的是自己跟 AI 说过什么，那本来就是他的数据。
    // 真正的可见范围在服务端 /api/logs/* 判 —— 前端藏 tab 只是把入口藏了，
    // 数据该给谁不该给谁跟这里无关。
    expect([...plain.container.querySelectorAll(".stab")].map(b => b.textContent))
      .toEqual([zh("appearance.title"), zh("usage.title"), zh("logs.title")]);
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

// ══════════════════════════════════════════════════════════════════
//  模型分级：从「自己敲逗号串」变成从目录里挑
//
//  2026-08-25 用户要求：「模型分配，我希望可以在一系列模型里选择，并且不同等级
//  的可以分配多个」。后端早就收逗号候选串（顺序即优先序，跑的时候取目录里第一个
//  可用的），缺的是界面 —— 此前是一个要用户手打模型名的输入框。
// ══════════════════════════════════════════════════════════════════
describe("模型分级多选", () => {
  const config = {
    gateway: { base_url: "https://gw/v1" },
    tiers: { low: { candidates: "m-small, m-big", model: "m-small" }, high: {} },
    catalog: [{ name: "m-small" }, { name: "m-big", vendor: "acme", quality: "high" }, { name: "m-new" }],
    budget: {}, env: [], balance: { known: false },
  };

  const chips = (root: Element, tk: string) => Array.from(
    root.querySelectorAll(`[data-tier="${tk}"] .tier-chip`) as any[]);

  it("已配的候选按优先序显示成芯片，序号看得见", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    expect(chips(container, "low").map((c: any) => c.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("m-small"), expect.stringContaining("m-big")]));
    expect(chips(container, "low")[0]!.textContent).toContain("1");
    expect(chips(container, "high")).toHaveLength(0);
  });

  it("从目录下拉里加一个 → 芯片和隐藏输入同时更新（保存读的是隐藏输入）", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    const add: any = container.querySelector('[data-tier="high"] .tier-add');
    // 已选过的不再出现在下拉里，避免重复配同一个模型
    fireEvent.change(add, { target: { value: "m-new" } });
    expect(chips(container, "high").map((c: any) => c.textContent.replace(/\D+/gu, "") ? c.textContent : c.textContent))
      .toHaveLength(1);
    expect((container.querySelector("#tier_high") as any).value).toBe("m-new");
  });

  it("移除一个 → 隐藏输入跟着变；全移除就是空串（＝回默认）", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    fireEvent.click(chips(container, "low")[0]!.querySelector(".tier-drop") as any);
    expect((container.querySelector("#tier_low") as any).value).toBe("m-big");
    fireEvent.click(chips(container, "low")[0]!.querySelector(".tier-drop") as any);
    expect((container.querySelector("#tier_low") as any).value).toBe("");
  });

  it("能上移改优先序 —— 顺序就是「先用哪个」", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    fireEvent.click(chips(container, "low")[1]!.querySelector(".tier-up") as any);
    expect((container.querySelector("#tier_low") as any).value).toBe("m-big, m-small");
  });

  it("下拉里不重复列已选的模型", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    const opts = Array.from(container.querySelectorAll('[data-tier="low"] .tier-add option') as any[])
      .map((o: any) => o.value).filter(Boolean);
    expect(opts).toEqual(["m-new"]);
  });

  it("说清楚多个候选是什么意思 —— 不让用户猜顺序有没有用", () => {
    G.CONFIG = config;
    const { container } = render(<ConfigForm />);
    expect(container.querySelector(".tier-hint")?.textContent).toContain("第一个可用");
  });

  /**
   * 「图像」档的可选列表来自网关探测（image_catalog），不是聊天目录 ——
   * 聊天目录被 NOT_CHAT_RE 有意挡住出图模型，从那里永远选不到。
   * 探测失败列表为空时，下拉消失、手填框兜底（设置页不能因为网关抖而废掉）。
   */
  it("图像档：网关探出清单就出下拉，聊天模型不混进来", () => {
    G.CONFIG = { ...config, image_catalog: ["openai/gpt-5.4-image-2", "dall-e-3"] };
    const { container } = render(<ConfigForm />);
    const opts = Array.from(container.querySelectorAll('[data-tier="image"] select option') as any[])
      .map((o: any) => o.value).filter(Boolean);
    expect(opts).toEqual(["openai/gpt-5.4-image-2", "dall-e-3"]);
    // 手填框仍在（兜底）
    expect(container.querySelector('[data-tier="image"] input.tier-add')).not.toBeNull();
  });

  it("图像档：清单为空只剩手填框，没有空下拉", () => {
    G.CONFIG = { ...config, image_catalog: [] };
    const { container } = render(<ConfigForm />);
    expect(container.querySelector('[data-tier="image"] select')).toBeNull();
    expect(container.querySelector('[data-tier="image"] input.tier-add')).not.toBeNull();
  });

  /**
   * 用户实报的 bug：加完出图模型点保存，**存不上**。
   * 根因：saveConfig 的档位循环写死 ["low","medium","high","critical"] ——
   * 图像档的隐藏输入更新了，保存时根本不读；保存后服务端返回的旧配置
   * 把 chip 又冲掉，看起来就是"无法保存"。
   * 这条测试走**真实路径**：手填框回车加 chip → saveConfig → 断言请求体。
   */
  it("★ 图像档加了模型后保存，请求体里必须带 models.image", async () => {
    G.CONFIG = { ...config, image_catalog: [] };
    const { container } = render(<ConfigForm />);

    const free = container.querySelector('[data-tier="image"] input.tier-add') as HTMLInputElement;
    free.value = "openai/gpt-5.4-image-2";
    fireEvent.keyDown(free, { key: "Enter" });
    // chip 已加、隐藏输入已更新
    expect((container.querySelector("#tier_image") as HTMLInputElement).value)
      .toBe("openai/gpt-5.4-image-2");

    const { saveConfig } = await import("../src/ui/settings.js");
    await saveConfig();

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes("/api/config"));
    expect(calls.length, "应当发出保存请求").toBeGreaterThan(0);
    const body = JSON.parse(String(calls[0]![1]!.body));
    expect(body.models?.image).toBe("openai/gpt-5.4-image-2");
  });
});
