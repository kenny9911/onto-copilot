/**
 * 会话侧栏 / 对话记录合并 / 额度提醒条 / 材料分组。
 *
 * 三处各修过一次真实 bug，判据都在被测函数里：
 *   · addTurn / mergeStateSnapshot —— 盲追加会让每条消息显示两遍（/state 已带回
 *     完整 dialogue，而 SSE 重连固定 ?since=0 再放一遍）；整体覆盖会把刚由 SSE
 *     推上来的回答吞掉。身份取 说话人+时间戳+正文。
 *   · 侧栏分组（工作模式下即使一个项目都没有也要出分区结构，否则这个功能要等到
 *     "你已经有项目了"才现身，而新用户永远迈不出第一步）—— 这一组的 7 条已经
 *     跟着 react/sidebar.tsx 搬去 ui.sidebar.test.tsx 了，判据没动。
 *   · fmtAmount —— New-API 那一类返回的是 token 额度不是美元，换算不确定就不假装
 *     是钱。而 budget.capped 说成"余额不足"会让人去给一个没欠费的账户充值。
 */
import "./ui.env.js";
import { resetDom } from "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G, PJ_OFF, UNFILED } from "../src/ui/state.js";
import { addTurn, mergeStateSnapshot, turnKey } from "../src/ui/chat.js";
import { statusText } from "../src/ui/sessions.js";
import { fmtAmount } from "../src/ui/quota.js";
import { groupBySheet, sheetShape, chunkBody } from "../src/ui/preview.js";

const turn = (speaker: string, ts: number, text: string) => ({ speaker, ts, text });

beforeEach(() => {
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0, state: {}, events: [] };
  G.PENDING = [];
  G.MODE = "work";
  G.PROJECTS = [];
  G.PROJECTS_OK = false;
  G.SESSION_LIST = [];
  PJ_OFF.clear();
  resetDom();
});

describe("对话记录合并", () => {
  it("身份 = 说话人+时间戳+正文", () => {
    expect(turnKey(turn("user", 1, "hi"))).toBe("user|1|hi");
  });

  it("同一条从两条路来只留一份（重连重放不会翻倍）", () => {
    addTurn(turn("user", 1, "hi"));
    addTurn(turn("user", 1, "hi"));
    expect(G.S.state.dialogue.turns.length).toBe(1);
  });

  it("同一条再来时就地合并新字段，不追加", () => {
    addTurn(turn("assistant", 2, "答"));
    addTurn({ ...turn("assistant", 2, "答"), intent: "explain" });
    expect(G.S.state.dialogue.turns.length).toBe(1);
    expect(G.S.state.dialogue.turns[0].intent).toBe("explain");
  });

  it("按时间戳排序 —— 乱序到达也排得回去", () => {
    addTurn(turn("assistant", 5, "后"));
    addTurn(turn("user", 1, "先"));
    expect(G.S.state.dialogue.turns.map((t: any) => t.text)).toEqual(["先", "后"]);
  });

  it("用户回执到达时撤掉乐观占位", () => {
    G.PENDING = [{ speaker: "user", text: "hi", pending: true }];
    addTurn(turn("user", 1, "hi"));
    expect(G.PENDING).toEqual([]);
  });

  it("/state 快照合并**不吞**刚由 SSE 推上来的那一轮", () => {
    addTurn(turn("user", 1, "问"));
    addTurn(turn("assistant", 2, "刚推上来的答")); // 服务端那次查询还没看到它
    mergeStateSnapshot({
      id: "s1", status: "done",
      state: { dialogue: { turns: [turn("user", 1, "问")], compactions: 3 } },
    });
    expect(G.S.state.dialogue.turns.map((t: any) => t.text)).toEqual(["问", "刚推上来的答"]);
    expect(G.S.state.dialogue.compactions).toBe(3); // 远端的元数据要留住
  });

  it("合并快照不能丢掉本地事件流", () => {
    G.S.events = [{ seq: 1, kind: "corpus.ready" }];
    mergeStateSnapshot({ id: "s1", state: { dialogue: { turns: [] } } });
    expect(G.S.events.length).toBe(1);
  });
});

describe("侧栏", () => {
  it("状态文案走 i18n，认不出就原样显示", () => {
    expect(statusText("extracting")).toBe("抽取中");
    expect(statusText("某个新状态")).toBe("某个新状态");
  });

  // 下面这 7 条（会话行、分组、折叠、未归类垫底、孤儿会话、退回平铺）**没有删**，
  // 是搬去了 test/ui.sidebar.test.tsx —— 侧栏那块界面现在由 react/sidebar.tsx 画，
  // 判据一条没改，只是从「断言拼出来的 HTML 串」换成「断言画出来的 DOM」。
  // 留在这里的两条是纯逻辑，和宿主无关。

  it("「未归类」和项目共用同一套收展存储，key 撞不上真项目 id", () => {
    expect(UNFILED).toBe("__unfiled__");
    expect(/^[0-9a-f]{12}$/.test(UNFILED)).toBe(false);
  });
});

describe("fmtAmount（额度提醒条上的数字）", () => {
  it("美元和人民币各自的符号", () => {
    expect(fmtAmount(1.5, "USD")).toBe("$1.50");
    expect(fmtAmount(1.5, "usd")).toBe("$1.50");
    expect(fmtAmount(2, "CNY")).toBe("¥2.00");
    expect(fmtAmount(2, "RMB")).toBe("¥2.00");
  });

  it("不认识的币种**不假装是钱**", () => {
    expect(fmtAmount(1500, "TOKENS")).toBe("1.5k 额度");
  });

  it("查不到就是空串 —— 不能显示 0（会被读成钱花光了）", () => {
    expect(fmtAmount(null, "USD")).toBe("");
    expect(fmtAmount(undefined, "USD")).toBe("");
    expect(fmtAmount("x", "USD")).toBe("");
    expect(fmtAmount(0, "USD")).toBe("$0.00"); // 真的是 0 才显示 0
  });
});

describe("材料预览的分组", () => {
  it("sheet 名优先取 locator，取不到从 cite 的 文件!sheet!行 里解析", () => {
    const g = groupBySheet([
      { cite: "a.xlsx!订单!R1", text: "x" },
      { locator: { sheet: "客户" }, cite: "a.xlsx!客户!R1", text: "y" },
      { cite: "b.pdf#p1", locator: { kind: "meta" }, text: "z" },
    ]);
    expect(g.map((x: any) => x.sheet)).toEqual(["订单", "客户", "文档元数据"]);
  });

  it("sheetShape 的顺序即优先级，散文兜底放最后", () => {
    expect(sheetShape([{ text: "abs_path=/x creator=y" }])).toBe("文档元数据");
    expect(sheetShape([{ text: "触发条件 执行者" }])).toBe("流程说明");
    expect(sheetShape([{ text: "这里有个问题？参考选项" }])).toBe("待填问卷");
    expect(sheetShape([{ text: "GET /v1/orders" }])).toBe("接口清单");
    expect(sheetShape([{ text: "实体编码 实体名称" }])).toBe("实体清单");
    expect(sheetShape([{ text: "x".repeat(61) }])).toBe("规则/散文");
    expect(sheetShape([{ text: "短" }])).toBe("");
  });

  it("chunkBody 把 列=值|列=值 拆成对齐的键值对", () => {
    expect(chunkBody({ text: "订单号=A1|状态=已发货" })).toBe(
      '<div class="kv"><div class="kvr"><span class="kvk">订单号</span>\n'
      + '      <span class="kvv">A1</span></div>'
      + '<div class="kvr"><span class="kvk">状态</span>\n'
      + '      <span class="kvv">已发货</span></div></div>');
  });

  it("不是键值对形态就当纯文本（并且转义）", () => {
    expect(chunkBody({ text: "<b>散文</b>" })).toBe("&lt;b&gt;散文&lt;/b&gt;");
  });
});
