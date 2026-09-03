/**
 * 接口视角建图时的事件命名 —— 修「一屏『单据已…』」的根因。
 *
 * 真实库 `d53cb63f7e18`：32 个动作全是 API 端点名，32 个事件全部以「单据」开头
 * （`单据已修改`×10、`单据已创建`×7…）。动词是随接口变的，**恒定的是前缀**。
 *
 * 根因不是命名模板，是 `host = a.appliesTo[0]` 解析不到对象：
 * `oir.objects.get("")` 落空后 `eventNameOf` 兜底成字面量「单据」。
 * 那个会话的 stage 标题「未归属接口」印证了 32 个动作一个都没绑上对象。
 *
 * 修法：绑不到对象时，从**动作自己的名字**里取资源名 —— `CreatePurchaseRequisition`
 * 去掉动词段就是 `PurchaseRequisition`。这是内容派生，不引入任何业务词表，
 * 换个行业照样成立。真取不出来才落到「单据」。
 */
import { describe, expect, it } from "vitest";

import { resourceNameOf } from "../src/onto/flow_link.js";

describe("resourceNameOf", () => {
  it("驼峰接口名去掉动词段，剩下的就是资源", () => {
    expect(resourceNameOf("CreatePurchaseRequisition")).toBe("Purchase Requisition");
  });

  it("小驼峰同样切得开", () => {
    expect(resourceNameOf("createInvoiceByContract")).toBe("Invoice By Contract");
  });

  it("中文动词在前时切掉动词", () => {
    expect(resourceNameOf("创建采购申请")).toBe("采购申请");
  });

  it("中文动词在后时也切掉动词", () => {
    expect(resourceNameOf("采购需求计划审批")).toBe("采购需求计划");
  });

  it("认不出动词就整名当资源 —— 宁可粗，不猜", () => {
    expect(resourceNameOf("PurchaseOrder")).toBe("Purchase Order");
  });

  it("空名字给空串，由调用方决定兜底", () => {
    expect(resourceNameOf("")).toBe("");
    expect(resourceNameOf("   ")).toBe("");
  });

  it("只有动词、切完什么都不剩时给空串", () => {
    expect(resourceNameOf("Create")).toBe("");
    expect(resourceNameOf("创建")).toBe("");
  });
});
