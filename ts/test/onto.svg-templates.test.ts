/**
 * SVG 多模板（用户点名）：每次都是同一张米色模板图 —— 讲给不同客户看的图
 * 应该能换气质。**模板只换配色，不换布局语义。**
 */
import { describe, expect, it } from "vitest";

import { SVG_TEMPLATES, paletteFor, toSvg, makePalette } from "../src/onto/diagram.js";
import { flowFromDict } from "../src/onto/flow.js";

const g = () => flowFromDict({
  stages: [{ key: "s1", title: "阶段一" }],
  nodes: [
    { rid: "fn_a", kind: "action", code: "ACT-1", label: { value: "提交申请" }, stage: "s1" },
    { rid: "fn_e", kind: "event", code: "EV-1", label: { value: "申请已提交" }, stage: "s1" },
  ],
  edges: [{ rid: "e1", from: "fn_a", to: "fn_e", kind: "flow", label: "" }],
});

describe("SVG 模板", () => {
  it("四个模板齐、名字按用途起（不是按颜色）", () => {
    expect(Object.keys(SVG_TEMPLATES).sort()).toEqual(["blueprint", "classic", "print", "slate"]);
  });

  it("classic 就是现在的默认 —— 老图一个字节都不变", () => {
    expect(paletteFor("classic")).toEqual(makePalette());
    expect(toSvg(g(), { palette: paletteFor("classic") })).toBe(toSvg(g()));
  });

  it("**模板只换配色不换结构**：节点数、文字、布局在各模板下完全一致", () => {
    const strip = (svg: string): string => svg
      .replace(/#[0-9a-fA-F]{3,8}/gu, "#")
      .replace(/(?:fill|stroke)="[^"]*"/gu, "");
    const base = strip(toSvg(g(), { palette: paletteFor("classic") }));
    for (const name of ["slate", "print", "blueprint"]) {
      expect(strip(toSvg(g(), { palette: paletteFor(name) }))).toBe(base);
    }
  });

  it("不同模板的产物确实不同 —— 不是四个名字一张图", () => {
    const svgs = ["classic", "slate", "print", "blueprint"]
      .map((t) => toSvg(g(), { palette: paletteFor(t) }));
    expect(new Set(svgs).size).toBe(4);
  });

  it("认不出的模板名回落 classic —— 由调用方负责把回落说出来", () => {
    expect(paletteFor("neon-vaporwave")).toEqual(makePalette());
  });
});
