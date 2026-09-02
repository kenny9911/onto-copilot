/**
 * 引文核验闸门 —— S4（LLM 文本流程建模）能不能算「实证档」，全靠这一道。
 *
 * 模型交上来的**不是** Provenance，而是 `{chunk_id, quote}`。Provenance 由代码构造，
 * 模型无权直接写。核验分三层，设计评审逐条压出来的：
 *
 *   1. 存在 —— 这个 chunk_id 真的在语料里；
 *   2. 真伪 —— 这句 quote 真的出现在那个 chunk 里；
 *   3. 相关 —— **这句话真的支撑这个节点**。
 *
 * 第 3 层是评审揪出来的漏洞：只做前两层的话，模型可以从材料里挑一句真话，
 * 贴到一个凭空捏造的节点上，照样拿到 `origin=extracted` + 非空 evidence，
 * 混进实证档、被 mainPath() 当骨架、进交付包。前两层一个字都拦不住。
 *
 * 相关性判据只看结构（节点名的字在不在引文里），不引入业务词表。
 */
import { describe, expect, it } from "vitest";

import { verifyCitation } from "../src/onto/flow_citation.js";

const CHUNKS = new Map([
  ["c1", "采购申请由发起人填写并提交，金额超过5万元的需要总经理二级审批。"],
  ["c2", "验收合格后由财务在三个工作日内完成付款。"],
]);

describe("verifyCitation", () => {
  it("三层都过：chunk 在、原文对得上、和节点名相关", () => {
    const r = verifyCitation(
      { label: "提交采购申请", chunkId: "c1", quote: "采购申请由发起人填写并提交" },
      CHUNKS,
    );

    expect(r.ok).toBe(true);
  });

  it("chunk 编号不存在 —— 第一层拦", () => {
    const r = verifyCitation(
      { label: "提交采购申请", chunkId: "c99", quote: "采购申请由发起人填写并提交" },
      CHUNKS,
    );

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/c99/u);
  });

  it("原文里根本没这句话 —— 第二层拦编造的引文", () => {
    const r = verifyCitation(
      { label: "提交采购申请", chunkId: "c1", quote: "采购申请须经三名董事联署" },
      CHUNKS,
    );

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/原文/u);
  });

  it("★ 真引文贴到不相干的节点上 —— 第三层拦，这是前两层拦不住的那种编造", () => {
    const r = verifyCitation(
      // 引文是 c2 里真实存在的句子，但节点讲的是完全另一回事
      { label: "供应商资质年审", chunkId: "c2", quote: "验收合格后由财务在三个工作日内完成付款" },
      CHUNKS,
    );

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/对不上|不相关|支撑/u);
  });

  it("空白差异不算编造 —— 材料里的换行和空格不该判人死刑", () => {
    const chunks = new Map([["c1", "采购申请  由发起人\n填写并提交"]]);
    const r = verifyCitation(
      { label: "提交采购申请", chunkId: "c1", quote: "采购申请由发起人填写并提交" },
      chunks,
    );

    expect(r.ok).toBe(true);
  });

  it("引文太短不足以支撑 —— 一个字的引文谁都能命中", () => {
    const r = verifyCitation(
      { label: "提交采购申请", chunkId: "c1", quote: "采" },
      CHUNKS,
    );

    expect(r.ok).toBe(false);
  });

  it("拒绝理由要能直接回给模型自纠", () => {
    const r = verifyCitation(
      { label: "供应商资质年审", chunkId: "c2", quote: "验收合格后由财务在三个工作日内完成付款" },
      CHUNKS,
    );

    expect(r.reason.length).toBeGreaterThan(8);
    expect(r.reason).toMatch(/供应商资质年审/u);
  });
});
