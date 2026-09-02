/**
 * PPT 里画的流程图 —— 连接线解析。
 *
 * 为什么单独一个模块：`presentation.ts` 只遍历有文字的 `p:sp`，`p:cxnSp`（连接线）
 * 一个都没读过。于是客户在 PPT 里画的流程图，方框被抽成了一堆互不相识的文本切片，
 * **箭头全部丢弃** —— 而箭头才是流程结构本身。
 *
 * 这里只做一件事：把一页 slide 的 XML 读成 `{from, to, label}` 的边。
 * 纯函数、零模型、不碰 zip，所以可以直接拿 XML 串测。
 */
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fromString } from "../src/onto/parse/doc/xmlet.js";
import { parseOoxml } from "../src/onto/parse/presentation.js";
import type { SlideFlowPage } from "../src/onto/parse/pptx_flow.js";
import {
  connectorsOf, shapesOf, slideFlowOf, slideFlowsFrom,
} from "../src/onto/parse/pptx_flow.js";
import { pptxOf } from "./helpers/minizip.js";

const GOLDEN = join(import.meta.dirname, "..", "..", "golden");

/**
 * 造一页 slide。`shapes` 是 [id, 文字] 或 [id, 文字, 预设几何]，
 * `cxns` 是原样插进 spTree 的 XML 片段。
 */
function slide(shapes: ([string, string] | [string, string, string])[], cxns: string): string {
  const sps = shapes.map(([id, text, geom]) => `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="100" y="100"/><a:ext cx="200" cy="80"/></a:xfrm>
        ${geom === undefined ? "" : `<a:prstGeom prst="${geom}"/>`}
      </p:spPr>
      <p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
    </p:sp>`).join("");
  return `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>${sps}${cxns}</p:spTree></p:cSld>
</p:sld>`;
}

/** 一条两端都接好的连接线。 */
function cxn(id: string, from: string, to: string, label = ""): string {
  const txt = label
    ? `<p:txBody><a:p><a:r><a:t>${label}</a:t></a:r></a:p></p:txBody>`
    : "";
  return `
    <p:cxnSp>
      <p:nvCxnSpPr>
        <p:cNvPr id="${id}" name="Connector ${id}"/>
        <p:cNvCxnSpPr>
          <a:stCxn id="${from}" idx="3"/>
          <a:endCxn id="${to}" idx="1"/>
        </p:cNvCxnSpPr>
      </p:nvCxnSpPr>
      ${txt}
    </p:cxnSp>`;
}

describe("connectorsOf", () => {
  it("把一条接好两端的箭头读成一条边", () => {
    const root = fromString(slide(
      [["2", "提交采购申请"], ["3", "部门负责人审批"]],
      cxn("7", "2", "3"),
    ));

    expect(connectorsOf(root)).toEqual([{ from: "2", to: "3", label: "" }]);
  });

  it("读出箭头上写的分支条件 —— 网关的判据就在这上面", () => {
    const root = fromString(slide(
      [["2", "金额判断"], ["3", "总经理二级审批"]],
      cxn("7", "2", "3", "金额 > 5万"),
    ));

    expect(connectorsOf(root)[0]?.label).toBe("金额 > 5万");
  });

  it("只连了一端的箭头不算边 —— 半条边比没有更误导", () => {
    const root = fromString(slide(
      [["2", "提交申请"]],
      `<p:cxnSp>
         <p:nvCxnSpPr>
           <p:cNvPr id="7" name="Connector 7"/>
           <p:cNvCxnSpPr><a:stCxn id="2" idx="3"/></p:cNvCxnSpPr>
         </p:nvCxnSpPr>
       </p:cxnSp>`,
    ));

    expect(connectorsOf(root)).toEqual([]);
  });

  it("按文档顺序返回多条边", () => {
    const root = fromString(slide(
      [["2", "甲"], ["3", "乙"], ["4", "丙"]],
      cxn("7", "2", "3") + cxn("8", "3", "4"),
    ));

    expect(connectorsOf(root).map((c) => `${c.from}->${c.to}`))
      .toEqual(["2->3", "3->4"]);
  });

  it("没有连接线的一页返回空数组，不抛", () => {
    const root = fromString(slide([["2", "只有一个框"]], ""));

    expect(connectorsOf(root)).toEqual([]);
  });
});

/**
 * 节点类型只看**形状几何**，不看文字里有没有「审批」「判断」这类词。
 *
 * 这是本项目的硬纪律：判据一旦挂在业务词表上，换一个行业的材料就整体失效，
 * 而且是静默失效 —— 框还在、图还在，只是全都判错。菱形在任何行业都是分支。
 */
describe("shapesOf", () => {
  it("菱形判成网关 —— 不靠文字里有没有「判断」二字", () => {
    const root = fromString(slide([["2", "走哪条", "diamond"]], ""));

    expect(shapesOf(root)[0]?.kind).toBe("gateway");
  });

  it("流程图判定框也判成网关", () => {
    const root = fromString(slide([["2", "金额超限？", "flowChartDecision"]], ""));

    expect(shapesOf(root)[0]?.kind).toBe("gateway");
  });

  it("椭圆判成终态", () => {
    const root = fromString(slide([["2", "结束", "ellipse"]], ""));

    expect(shapesOf(root)[0]?.kind).toBe("terminal");
  });

  it("认不出的几何一律当动作 —— 宁可粗，不猜", () => {
    const root = fromString(slide([["2", "提交申请", "hexagon"]], ""));

    expect(shapesOf(root)[0]?.kind).toBe("action");
  });

  it("没写几何的框也当动作", () => {
    const root = fromString(slide([["2", "提交申请"]], ""));

    expect(shapesOf(root)[0]?.kind).toBe("action");
  });

  it("没有文字的框不进节点 —— 那是装饰，不是步骤", () => {
    const root = fromString(slide([["2", ""], ["3", "真步骤"]], ""));

    expect(shapesOf(root).map((s) => s.id)).toEqual(["3"]);
  });

  it("带上 id 和文字，供连接线按 id 对上号", () => {
    const root = fromString(slide([["2", "提交采购申请"]], ""));

    expect(shapesOf(root)[0]).toMatchObject({ id: "2", text: "提交采购申请" });
  });

  it("连接线不会被当成节点", () => {
    const root = fromString(slide([["2", "甲"], ["3", "乙"]], cxn("7", "2", "3", "同意")));

    expect(shapesOf(root).map((s) => s.id)).toEqual(["2", "3"]);
  });
});

/**
 * 组装：一页 slide → 一张流程图。
 *
 * 判据是「这一页画的是不是流程图」，而不是「这一页讲不讲某个业务」。
 * 依据只有一条结构特征：**框之间有没有连线**。没有连线的一页，无论写了多少字，
 * 都只是并列的文本框，不是流程。
 */
describe("slideFlowOf", () => {
  it("有框有线才算一张流程图", () => {
    const root = fromString(slide(
      [["2", "提交采购申请"], ["3", "部门负责人审批"]],
      cxn("7", "2", "3"),
    ));

    const flow = slideFlowOf(root);

    expect(flow).not.toBeNull();
    expect(flow?.nodes.map((n) => n.text)).toEqual(["提交采购申请", "部门负责人审批"]);
    expect(flow?.edges).toEqual([{ from: "2", to: "3", label: "" }]);
  });

  it("一根线都没有就不是流程图 —— 并列文本框不算", () => {
    const root = fromString(slide([["2", "目标"], ["3", "范围"], ["4", "里程碑"]], ""));

    expect(slideFlowOf(root)).toBeNull();
  });

  it("线指向不存在的框时，那条边丢掉，图还留着", () => {
    const root = fromString(slide(
      [["2", "甲"], ["3", "乙"]],
      cxn("7", "2", "3") + cxn("8", "3", "99"),
    ));

    const flow = slideFlowOf(root);

    expect(flow?.edges).toEqual([{ from: "2", to: "3", label: "" }]);
  });

  it("所有线都指不到框时整页作废，不返回一张没有边的图", () => {
    const root = fromString(slide([["2", "甲"]], cxn("7", "88", "99")));

    expect(slideFlowOf(root)).toBeNull();
  });

  it("孤立的框仍然保留 —— 它可能是漏画了线的真实步骤", () => {
    const root = fromString(slide(
      [["2", "甲"], ["3", "乙"], ["4", "没连线的框"]],
      cxn("7", "2", "3"),
    ));

    expect(slideFlowOf(root)?.nodes.map((n) => n.id)).toEqual(["2", "3", "4"]);
  });
});

describe("slideFlowsFrom", () => {
  it("只收出得了图的页，并记住页码 —— 页码是证据能点回去的前提", () => {
    const withFlow = fromString(slide([["2", "甲"], ["3", "乙"]], cxn("7", "2", "3")));
    const noFlow = fromString(slide([["2", "只是文本框"]], ""));

    // 第 1 页没有图、第 2 页有 —— 收上来的必须写 page 2，不能写数组下标 0。
    const pages = slideFlowsFrom([{ page: 1, root: noFlow }, { page: 2, root: withFlow }]);

    expect(pages.map((p) => p.page)).toEqual([2]);
    expect(pages[0]?.edges).toEqual([{ from: "2", to: "3", label: "" }]);
  });

  it("一页图都没有时返回空数组", () => {
    const noFlow = fromString(slide([["2", "文本框"]], ""));

    expect(slideFlowsFrom([{ page: 1, root: noFlow }])).toEqual([]);
  });
});

/**
 * 接线自证。
 *
 * 本仓有过「造好了没接上」的先例（`action_drafter` 整棵树只在自己的定义里出现过）。
 * 所以除了纯函数，还要拿**真实 .pptx** 证明这段代码确实在解析路径上跑到了：
 * 这几份 golden 里没有连接线，因此期望是「键在、值为空」——
 * 而不是「键不存在」，后者说明这段代码根本没被调用。
 */
describe("接进 PptxParser", () => {
  it("画了流程图的 pptx，解析后能拿到节点和边", async () => {
    const path = join(tmpdir(), `oc-pptx-flow-${process.pid}.pptx`);
    await writeFile(path, pptxOf(slide(
      [["2", "提交采购申请"], ["3", "金额判断", "diamond"], ["4", "总经理审批"]],
      cxn("7", "2", "3") + cxn("8", "3", "4", "超过5万"),
    )));
    try {
      const doc = await parseOoxml(path, "f-pptx-flow");
      const flows = doc.structured["slide_flows"] as SlideFlowPage[];

      expect(flows).toHaveLength(1);
      expect(flows[0]?.page).toBe(1);
      expect(flows[0]?.nodes.map((n) => n.text))
        .toEqual(["提交采购申请", "金额判断", "总经理审批"]);
      expect(flows[0]?.nodes[1]?.kind).toBe("gateway");
      expect(flows[0]?.edges[1]?.label).toBe("超过5万");
    } finally {
      await rm(path, { force: true });
    }
  });

  it("没画流程图的 pptx 一个键都不多 —— golden 钉的是旧字节", async () => {
    const doc = await parseOoxml(join(GOLDEN, "parse.pptx.minimal.pptx"), "f-pptx-min");

    expect(doc.structured).not.toHaveProperty("slide_flows");
  });
});
