/**
 * 空回答不许被报成「出处有问题」（H1）。
 *
 * 现场：FDE 连问两次「补充缺乏的 event」，两次都只收到一句
 * `（有出处没核对上，已移除；结论请自行复核）` —— 而那句话**是假的**：
 * 一条出处都没被移除，因为压根没有回答。
 */
import { describe, expect, it } from "vitest";

import { ANSWER_SCHEMA, emptyAnswerReport } from "../src/onto/converse.js";

const step = (n: number, tool: string) => ({ n, thought: "t", tool, args: {} });

describe("emptyAnswerReport", () => {
  it("撞上步数上限时点名说「用满了」，并给拆小/批量的建议", () => {
    const out = emptyAnswerReport({
      steps: [step(1, "evidence.search"), step(2, "flow.query"), step(3, "")],
      maxSteps: 3,
    });
    expect(out).toContain("没有生成回答");
    expect(out).toContain("已经用满 3 步的上限");
    expect(out).toContain("evidence.search、flow.query");
    expect(out).toContain("apply_patch");
  });

  it("没用满上限时不谎称用满", () => {
    const out = emptyAnswerReport({ steps: [step(1, "evidence.search")], maxSteps: 5 });
    expect(out).toContain("想了 1 步");
    expect(out).not.toContain("用满");
  });

  it("**改没改要给准话** —— 有写入工具就说改动可能已落，别让人自己猜", () => {
    const danger = new Map([["evidence.search", 0], ["flow.edit", 1]]);
    const out = emptyAnswerReport({
      steps: [step(1, "evidence.search"), step(2, "flow.edit")],
      maxSteps: 5,
      danger,
    });
    expect(out).toContain("flow.edit 是写入类工具，改动很可能已经落了");
    expect(out).toContain("重复执行");
    // 只读的那个不能被算进写入名单
    expect(out).not.toContain("evidence.search 是写入类工具");
  });

  it("全是只读工具 → 明确说没有改动落库", () => {
    const out = emptyAnswerReport({
      steps: [step(1, "evidence.search"), step(2, "oir.query")],
      maxSteps: 5,
      danger: new Map([["evidence.search", 0], ["oir.query", 0]]),
    });
    expect(out).toContain("都是只读工具，**没有任何改动落库**");
  });

  it("一个工具都没调 → 直说什么都没改", () => {
    const out = emptyAnswerReport({ steps: [step(1, "")], maxSteps: 5 });
    expect(out).toContain("一个工具都没调");
    expect(out).toContain("什么都没改");
  });

  it("同一个工具调多次只列一次（列表是给人看的，不是调用日志）", () => {
    const out = emptyAnswerReport({
      steps: [step(1, "evidence.search"), step(2, "evidence.search")],
      maxSteps: 5,
    });
    expect(out.match(/evidence\.search/gu)).toHaveLength(1);
  });
});

describe("ANSWER_SCHEMA", () => {
  it("answer 有 minLength —— 空串本来就不该过网关这一关", () => {
    const answer = (ANSWER_SCHEMA["properties"] as Record<string, any>)["answer"];
    expect(answer.minLength).toBeGreaterThan(0);
    // thought 早就有 minLength，answer 没有才是那个不一致
    const thought = (ANSWER_SCHEMA["properties"] as Record<string, any>)["thought"];
    expect(thought.minLength).toBeGreaterThan(0);
  });
});

describe("对话步数预算（H2）", () => {
  it("写入作用域的步数要明显高于只读 —— 改一件事是「查→写→复查」，不是查一下", async () => {
    const src = await import("node:fs/promises")
      .then((fs) => fs.readFile("src/server/dialogue.ts", "utf8"));
    const chat = /scope: "chat",[\s\S]{0,200}?maxSteps: (\d+)/u.exec(src);
    const conv = /scope: materialAnalysisScope,[\s\S]{0,1200}?maxSteps: editOps >= 2 \? (\d+) : (\d+)/u.exec(src);
    expect(chat).not.toBeNull();
    expect(conv).not.toBeNull();
    expect(src).toMatch(/const strictMaterial = strictMaterialCandidate && !pureDocumentManagement/u);
    expect(src).toMatch(/const materialAnalysisScope = strictMaterial &&[\s\S]{0,160}!MATERIAL_WRITE_REQUEST\.test\(text\)[\s\S]{0,160}!documentWriteIntent[\s\S]{0,100}\? "chat"\s*:\s*"converse"/u);
    const readOnly = Number(chat![1]);
    const compoundWrite = Number(conv![1]);
    const writeable = Number(conv![2]);
    // 不钉死具体数字（那会让调参变成改测试），钉的是**两者的关系**：
    // 写入侧至少要能装下「读 2 + 写 3 + 收尾 1」。
    expect(writeable).toBeGreaterThanOrEqual(6);
    expect(writeable).toBeGreaterThan(readOnly);
    expect(compoundWrite).toBeGreaterThan(writeable);
  });
});
