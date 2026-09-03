/**
 * `oir.query` 的独立回归契约。
 *
 * 专业 FDE agent 会用它查完整 OIR，因此这里专门钉住三件容易静默退化的行为：
 * 规则桶必须可查；`q` 必须覆盖规则原文、业务名和物理名；分页必须明确告诉调用方
 * 当前拿到的是不是全集。
 */

import { describe, expect, it } from "vitest";

import type { ToolCallCtx } from "../src/kernel/tools.js";
import {
  OIR,
  extracted,
  makeBusinessRule,
  makeObjectType,
} from "../src/onto/oir.js";
import { builtinRegistry } from "../src/server/glue/tools.js";

const CTX = { rec: null, nodeId: "test.oir-query", approved: true } as ToolCallCtx;

interface QueryPage {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly next_offset: number | null;
  readonly items: Array<{ rid: string }>;
}

function searchableOir(): OIR {
  const oir = new OIR();
  oir.addObject(
    makeObjectType({
      rid: "ot_purchase_order",
      apiName: extracted("purchaseOrder"),
      displayName: extracted("采购订单"),
    }),
  );
  oir.addObject(
    makeObjectType({
      rid: "ot_supplier",
      apiName: extracted("supplierMaster"),
      displayName: extracted("供应商主数据"),
    }),
  );
  oir.addRule(
    makeBusinessRule({
      rid: "br_amount_approval",
      statement: extracted("订单金额超过十万元时必须由财务总监审批"),
    }),
  );
  oir.addRule(
    makeBusinessRule({
      rid: "br_lock_after_approval",
      statement: extracted("采购订单审批后不得修改供应商"),
    }),
  );
  return oir;
}

async function query(
  oir: OIR,
  args: Record<string, unknown>,
): Promise<QueryPage> {
  const reg = builtinRegistry({ oir });
  return (await reg.call("oir.query", args, CTX, { scope: "readonly" })) as QueryPage;
}

describe("builtinRegistry / oir.query", () => {
  it("kind=rules 返回 BusinessRule，并可用 q 搜索 statement", async () => {
    const out = await query(searchableOir(), { kind: "rules", q: "十万元" });

    expect(out.total).toBe(1);
    expect(out.returned).toBe(1);
    expect(out.items.map((item) => item.rid)).toEqual(["br_amount_approval"]);
    expect(out.truncated).toBe(false);
    expect(out.next_offset).toBeNull();
  });

  it.each([
    ["displayName", "采购订单", "ot_purchase_order"],
    ["apiName（不区分大小写）", "SUPPLIERMASTER", "ot_supplier"],
  ])("q 可搜索 %s", async (_field, q, rid) => {
    const out = await query(searchableOir(), { kind: "objects", q });

    expect(out.total).toBe(1);
    expect(out.returned).toBe(1);
    expect(out.items.map((item) => item.rid)).toEqual([rid]);
  });

  it("返回 total/returned/truncated/next_offset，调用方不会把第一页误当全集", async () => {
    const oir = new OIR();
    for (let i = 0; i < 5; i += 1) {
      oir.addObject(
        makeObjectType({
          rid: `ot_${i}`,
          apiName: extracted(`object${i}`),
          displayName: extracted(`对象${i}`),
        }),
      );
    }

    const first = await query(oir, { kind: "objects", offset: 1, limit: 2 });
    expect(first).toMatchObject({
      total: 5,
      returned: 2,
      truncated: true,
      next_offset: 3,
    });
    expect(first.items.map((item) => item.rid)).toEqual(["ot_1", "ot_2"]);

    const last = await query(oir, { kind: "objects", offset: 3, limit: 2 });
    expect(last).toMatchObject({
      total: 5,
      returned: 2,
      truncated: false,
      next_offset: null,
    });
    expect(last.items.map((item) => item.rid)).toEqual(["ot_3", "ot_4"]);
  });
});
