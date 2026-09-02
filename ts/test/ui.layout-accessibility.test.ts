// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { paintSendBtn } from "../src/ui/chat.js";
import { toggleSidebar } from "../src/ui/layout.js";
import { applyMode } from "../src/ui/mode.js";
import { G } from "../src/ui/state.js";

let mobile = false;

function shell(): void {
  document.body.innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sessionSidebar"></aside>
      <main>
        <button id="sidetoggle" aria-controls="sessionSidebar" aria-expanded="true"></button>
        <div id="modetog"><button data-mode="chat"></button><button data-mode="work"></button></div>
        <div id="stream" role="log" aria-busy="false"></div>
        <div class="cbox"><textarea id="cin"></textarea><button id="send"></button></div>
      </main>
    </div>`;
}

beforeEach(() => {
  mobile = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }),
  });
  shell();
  G.MODE = "work";
  G.S = { id: "s1", status: "idle", state: {}, events: [] } as any;
  G.THINKING = false;
});

describe("移动端会话抽屉", () => {
  it("汉堡可连续打开和关闭抽屉，并同步 aria-expanded", () => {
    mobile = true;
    const sidebar = document.getElementById("sessionSidebar")!;
    const toggle = document.getElementById("sidetoggle")!;

    toggleSidebar();
    expect(sidebar.classList.contains("mobile-open")).toBe(true);
    expect(sidebar.classList.contains("hidden")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggleSidebar();
    expect(sidebar.classList.contains("mobile-open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("桌面仍沿用 hidden 收起逻辑", () => {
    const sidebar = document.getElementById("sessionSidebar")!;
    toggleSidebar();
    expect(sidebar.classList.contains("hidden")).toBe(true);
    expect(document.getElementById("sidetoggle")!.getAttribute("aria-expanded")).toBe("false");
    toggleSidebar();
    expect(sidebar.classList.contains("hidden")).toBe(false);
  });
});

describe("工作台可访问状态", () => {
  it("模式切换用 aria-pressed 表达，不只依赖颜色", () => {
    applyMode();
    const chat = document.querySelector('[data-mode="chat"]')!;
    const work = document.querySelector('[data-mode="work"]')!;
    expect(chat.getAttribute("aria-pressed")).toBe("false");
    expect(work.getAttribute("aria-pressed")).toBe("true");
  });

  it("发送/停止按钮和聊天 live region 同步可访问状态", () => {
    const send = document.getElementById("send") as HTMLButtonElement;
    paintSendBtn();
    expect(send.getAttribute("aria-label")).toBe("发送");
    expect(document.getElementById("stream")!.getAttribute("aria-busy")).toBe("false");

    G.THINKING = true;
    paintSendBtn();
    expect(send.getAttribute("aria-label")).toBe("停止");
    expect(document.getElementById("stream")!.getAttribute("aria-busy")).toBe("true");
  });

  it("生产壳声明 log/live 语义与真正可重开的 mobile-open 规则", () => {
    const html = readFileSync(resolve(process.cwd(), "../ui/index.template.html"), "utf8");
    expect(html).toMatch(/id="stream" role="log" aria-live="polite"/u);
    expect(html).toMatch(/id="sidetoggle"[^>]*aria-controls="sessionSidebar"[^>]*aria-expanded=/u);
    expect(html).toMatch(/\.sidebar\.mobile-open\{transform:translateX\(0\)/u);
    expect(html).not.toMatch(/\.sidebar:focus-within/u);
  });
});
