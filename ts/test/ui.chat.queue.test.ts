/**
 * 轮次在跑时又发一句话：排队、撤回、插队；以及那条**永远消不掉的错误气泡**。
 *
 * 用户报的症状，三条都在这里：
 *
 *   1. 出现 `没发出去：{"detail":"这个会话已有一轮对话正在处理…"}` 之后，这句话
 *      **会一直挂着**，接着问别的也不消失。根因：它是 assistant 气泡，而 PENDING
 *      的清除逻辑只在 SSE 回来一条 **user** turn 时按文本匹配删 —— 永远匹配不上，
 *      只能靠切会话才没。
 *   2. 那句话没被翻成人话，把服务端本来写好的中文包在 JSON 里念给用户听。
 *      根因：`j()` 直接 `throw new Error(await r.text())`，连状态码都丢了，
 *      调用方分不清 409（忙）和 500（真错）。
 *   3. 轮次在跑时发送就该排队，不该硬发去撞 409。
 */
import "./ui.env.js";
import { resetDom } from "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G } from "../src/ui/state.js";
import { enqueueChat, sendChat, withdrawQueued } from "../src/ui/chat.js";

const g = globalThis as any;

/** 让 /chat 挂起不返回，模拟"轮次正在跑"。 */
function installHangingChat(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  g.fetch = async (url: string) => {
    if (/\/chat$/.test(String(url))) {
      await gate;
      return { ok: true, status: 200, json: async () => ({ followups: [] }), text: async () => "{}" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  return { release };
}

beforeEach(() => {
  resetDom();
  G.S = { id: "s1", state: {}, events: [] } as any;
  G.PENDING = []; G.QUEUED = []; G.CHAT_ABORT = null; G.THINKING = false;
});

describe("轮次在跑时又发一句", () => {
  it("**排队而不是硬发** —— 硬发会撞 409，而那条错误以前永远消不掉", async () => {
    const { release } = installHangingChat();
    const cin = document.getElementById("cin") as HTMLTextAreaElement;

    cin.value = "第一句";
    const first = sendChat();
    await Promise.resolve();
    expect(G.CHAT_ABORT).not.toBeNull();      // 第一轮在路上

    cin.value = "第二句";
    await sendChat();
    // 没有第二条 fetch，第二句进了队列
    expect(G.QUEUED).toEqual(["第二句"]);
    // 输入框清空了，但字没丢 —— 它在队列里看得见
    expect(cin.value).toBe("");

    release();
    await first;
    // 第一轮落地后队首自动发出
    expect(G.QUEUED).toEqual([]);
  });

  it("撤回把文字**退回输入框**，不是丢掉", () => {
    enqueueChat("要改的那句");
    const cin = document.getElementById("cin") as HTMLTextAreaElement;
    cin.value = "";
    withdrawQueued(0);
    expect(G.QUEUED).toEqual([]);
    expect(cin.value).toBe("要改的那句");
  });

  it("撤回时输入框已有字：拼在前面，不覆盖他正在敲的", () => {
    enqueueChat("排队的");
    const cin = document.getElementById("cin") as HTMLTextAreaElement;
    cin.value = "正在敲的";
    withdrawQueued(0);
    expect(cin.value).toBe("排队的\n正在敲的");
  });
});

describe("失败气泡的生命周期", () => {
  it("**下一次发送时上一次的错误气泡作废** —— 它讲的是上一次的事", async () => {
    g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ followups: [] }), text: async () => "{}" });
    G.PENDING = [{ speaker: "assistant", text: "没发出去：上次那个错", error: true } as any];
    const cin = document.getElementById("cin") as HTMLTextAreaElement;
    cin.value = "新的一句";
    await sendChat();
    expect(G.PENDING.some((x: any) => x.error)).toBe(false);
  });

  it("409 不是错误是时序 —— 回队列，不弹错误气泡，字也不丢", async () => {
    g.fetch = async (url: string) => {
      if (/\/chat$/.test(String(url))) {
        return {
          ok: false, status: 409,
          text: async () => JSON.stringify({ detail: "这个会话已有一轮对话正在处理，请等它结束或先停止。" }),
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    const cin = document.getElementById("cin") as HTMLTextAreaElement;
    cin.value = "撞上忙的那句";
    await sendChat();
    expect(G.QUEUED).toEqual(["撞上忙的那句"]);
    expect(G.PENDING.some((x: any) => x.error)).toBe(false);
  });

  it("真错才弹气泡，且**是人话不是 JSON**", async () => {
    g.fetch = async (url: string) => {
      if (/\/chat$/.test(String(url))) {
        return {
          ok: false, status: 500,
          text: async () => JSON.stringify({ detail: "网关连不上" }),
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    const cin = document.getElementById("cin") as HTMLTextAreaElement;
    cin.value = "会失败的那句";
    await sendChat();
    const bubble = G.PENDING.find((x: any) => x.error) as any;
    expect(bubble).toBeDefined();
    expect(bubble.text).toContain("网关连不上");
    // 关键：不许把 JSON 原文念给用户听
    expect(bubble.text).not.toContain("detail");
    expect(bubble.text).not.toContain("{");
  });
});
