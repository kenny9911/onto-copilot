/**
 * prompts 的 golden 校验 —— 每条向量都是 Python 侧真跑出来的。
 *
 * 这里断言的是**整条 dict 列表全等**，不是"包含某关键词"：这些文案是产品面孔，
 * 漂一个字（多一个逗号、少一个"？"）都是回归，而关键词断言恰恰看不见这种漂移。
 *
 * 这个模块没有 IO、没有随机、没有时间，所以两侧理应逐字相同 —— 一条已知差异都
 * 不该有。真出现差异就是移植错了，不要在这里加豁免。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  Prompt,
  followupPrompts,
  openingPrompts,
  promptKey,
  type PromptDict,
  type PromptState,
} from "../src/onto/prompts.js";

interface Golden {
  opening: {
    note: string;
    state: PromptState;
    files: string[];
    status: string;
    out: PromptDict[];
  }[];
  followup: {
    note: string;
    answer: string;
    state: PromptState;
    files: string[];
    status: string;
    limit: number;
    asked: string[];
    out: PromptDict[];
  }[];
  echo: { needle: string; text: string; group: string }[];
  key: { in: string; out: string }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/prompts.json"), "utf8"),
) as Golden;

describe("opening_prompts", () => {
  for (const v of G.opening) {
    it(v.note, () => {
      expect(
        openingPrompts({ state: v.state, files: v.files, status: v.status }),
      ).toEqual(v.out);
    });
  }
});

describe("followup_prompts", () => {
  for (const v of G.followup) {
    it(v.note, () => {
      expect(
        followupPrompts({
          answer: v.answer,
          state: v.state,
          files: v.files,
          status: v.status,
          limit: v.limit,
          asked: v.asked,
        }),
      ).toEqual(v.out);
    });
  }
});

describe("_key 归一化（Python 与 JS 的 \\s 不是同一个集合）", () => {
  for (const v of G.key) {
    it(JSON.stringify(v.in), () => expect(promptKey(v.in)).toBe(v.out));
  }
});

describe("_ECHO 的表本身", () => {
  it("每条 needle 单独出现时都能命中，且文案与分组来自 golden", () => {
    // 逐条走一遍，钉的是"表没被抄漏、顺序没乱、文案没漂"。
    for (const e of G.echo) {
      const got = followupPrompts({
        answer: `……${e.needle}……`,
        state: {},
        files: ["a.xlsx"],
        status: "idle",
        limit: 1,
      });
      expect(got).toEqual([{ text: e.text, send: e.text, group: e.group }]);
    }
  });
});

describe("Python 侧没覆盖到、但 TS 侧必须钉住的行为", () => {
  it("默认参数：status 缺省是 idle，limit 缺省是 3，asked 缺省为空", () => {
    // 关键字参数在 TS 里成了解构默认值 —— 默认值漂了不会有任何类型报错。
    expect(openingPrompts({ state: {}, files: ["a.xlsx"] })).toEqual(
      openingPrompts({ state: {}, files: ["a.xlsx"], status: "idle" }),
    );
    const base = followupPrompts({ answer: "嗯。", state: {}, files: [] });
    expect(base).toEqual(
      followupPrompts({
        answer: "嗯。",
        state: {},
        files: [],
        status: "idle",
        limit: 3,
        asked: [],
      }),
    );
    expect(base).toHaveLength(3);
  });

  it("send 为空串时回落到 text —— 不是 ?? 的空值合并", () => {
    // `send ?? text` 会让显式传进来的空串活下来，前端拿到一条点了发空消息的 chip。
    expect(new Prompt("问句", "组", "").toDict()).toEqual({
      text: "问句",
      send: "问句",
      group: "组",
    });
    expect(new Prompt("问句").toDict()).toEqual({
      text: "问句",
      send: "问句",
      group: "",
    });
  });

  it("状态里的统计是脏值时不把脏值印进文案", () => {
    // Python 的 f-string 会把 "17" / None 原样拼进去；TS 侧收紧成 0（当作没有）。
    // 这条是**有意的收紧**，钉住它免得哪天被"顺手放开"。
    const dirty = openingPrompts({
      state: { oir: { stats: { rules: "4" } }, flow: { stats: { actions: null } } },
      files: ["a.xlsx"],
      status: "done",
    });
    expect(dirty.every((p) => !/null|NaN|undefined/.test(p.text))).toBe(true);
    // 统计全被当成 0 → donePrompts 为空 → 兜底那三条
    expect(dirty).toEqual(
      openingPrompts({ state: {}, files: ["a.xlsx"], status: "done" }),
    );
  });

  it("state 里的 oir/flow 是数组或标量时不炸", () => {
    // 状态是从 JSON 里读回来的，形状不受本模块控制。
    for (const bad of [[], "x", 0, true, null] as unknown[]) {
      expect(
        openingPrompts({ state: { oir: bad, flow: bad }, files: ["a.xlsx"], status: "done" }),
      ).toHaveLength(3);
    }
  });

  it("asked 接受任意可迭代（Set 也行），不只是数组", () => {
    const every = followupPrompts({ answer: "嗯。", state: {}, files: [] }).map(
      (p) => p.text,
    );
    expect(
      followupPrompts({
        answer: "嗯。",
        state: {},
        files: [],
        asked: new Set(every),
      }),
    ).toHaveLength(3); // 全筛掉了也不能一条不给
  });

  it("KEY_STRIP 是全局正则，连续调用不会因 lastIndex 漏字", () => {
    // /g 正则在 .test()/.exec() 上会记住 lastIndex；.replace 不会 —— 但这条链路
    // 一次 followup 要调它十几次，回归到 .test() 的话会间歇性漏掉去重。
    const s = "这类本体建模项目一般怎么推进？";
    expect(promptKey(s)).toBe(promptKey(s));
    expect(promptKey(s)).toBe("这类本体建模项目一般怎么推进");
  });
});
