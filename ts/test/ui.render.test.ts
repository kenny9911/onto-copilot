/**
 * 中栏那块还没交给 React 的东西：常驻动作栏。
 *
 * 动作栏盯的是「功能一个都不能少」清单里的一条，而且它有过一次退化：上传本身
 * 就产生事件、空状态立刻消失，所以"接下来做什么"必须常驻在输入框上方，
 * 而不是藏在一个转瞬即逝的空状态里。
 *
 * **这个文件原来还有两组，都搬走了**（判据一个字没改，只是从「innerHTML 里有这个
 * 子串」换成「渲染结果里有这个元素/这段文字」）：
 *   · 「提示气泡（chips）」5 条 → ui.react.stream.test.tsx（#stream 归 <Stream>）；
 *   · 「evCard 表格与导出」7 条 → ui.react.stream.test.tsx 的 <EvCard> 一组；
 *   · 「额度提醒条」4 条 → ui.contracts.quota.test.tsx（条子归 <QuotaBar>）。
 */
import "./ui.env.js";
import { el, resetDom } from "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G, TBL_OPEN } from "../src/ui/state.js";
import { paintActions } from "../src/ui/render.js";

beforeEach(() => {
  resetDom();
  TBL_OPEN.clear();
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 1,
          state: { dialogue: { turns: [] } }, events: [] };
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = [];
  G.THINKING = false; G.CHAT_ABORT = null; G.NEEDS_CONFIRM = false;
  G.PROMPTS = []; G.FOLLOWUPS = []; G.QUOTA = null; G.Q_BACKLOG = [];
  G.SEEN_SID = null; G.SEEN_BUBBLES = 0;
});

describe("常驻动作栏", () => {
  it("跑着的时候：进度 + 停止", () => {
    G.S.status = "extracting";
    paintActions();
    const html = el("abar").innerHTML;
    expect(html).toContain("正在梳理…");
    expect(html).toContain("stopRun()");
  });

  it("有材料没跑过：一个说清份数的主按钮", () => {
    G.S.status = "idle"; G.S.files = 3;
    paintActions();
    expect(el("abar").innerHTML).toContain("开始梳理 3 份材料");
  });

  it("跑完了：模板下载 + 交付包 + 全部产物 + 重新梳理", () => {
    G.S.status = "done";
    G.S.state.artifacts = ["填写模板.xlsx", "oir.json"];
    paintActions();
    const html = el("abar").innerHTML;
    expect(html).toContain("下载填写模板");
    expect(html).toContain("导出交付包");
    expect(html).toContain("go('art')");
    expect(html).toContain("重新梳理");
  });

  it("没有会话时动作栏是空的", () => {
    G.S = null;
    paintActions();
    expect(el("abar").innerHTML).toBe("");
  });
});
