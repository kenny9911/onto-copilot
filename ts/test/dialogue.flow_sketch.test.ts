/**
 * `flow.sketch` —— 没有材料时凭领域通识画的**参考**流程图。
 *
 * 这一条工具的验收标准和别的工具不一样：别的工具错了是产物不对，这一条错了是
 * **溯源被污染**。它产出的东西没有任何证据支撑，而整个产品建立在"每一条断言都能
 * 回答『凭什么』"之上。所以下面四组断言里有三组不是在测功能，是在测边界：
 *
 *  · 来源标注**三处都在**（SVG 标题 / 文件名 / 聊天卡片）—— 少一处，这张图就能
 *    被当成从客户材料里读出来的现状截图进方案文档；
 *  · **不写会话状态** —— 写进 `_flow`/`_oir` 之后，冲突检测会拿模型编的环节去和
 *    客户材料对撞，缺口挖掘会为一个客户根本没有的环节生成问题；
 *  · **不进产物目录** —— 会话根目录下的文件会被算成产物、进产物 tab、进交付包 zip。
 *
 * 第四组是"换个域也出得来"：一个只会画采购的工具正好踩在"不许照抄某个域的形状"
 * 这条产品原则上。这条测试的作用是拦住后来者把采购词表写死进去。
 */

import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { AsyncLock } from "../src/server/pipeline/types.js";
import type { SessionEvent } from "../src/session_events.js";
import { converseTools } from "../src/server/dialogue.js";
import { RenderError, type DialogueDeps, type SessionLike } from "../src/server/dialogue/ports.js";
import {
  SKETCH_MARK,
  graphFromSketch,
  sketchFileName,
  sketchTitle,
  SketchError,
} from "../src/onto/flow_sketch.js";

// ══════════════════════════════════════════════════════════════════
//  假件
// ══════════════════════════════════════════════════════════════════

function makeSession(): SessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-sketch-"));
  const s: SessionLike = {
    id: "s1",
    title: "新建会话",
    project: "",
    projectId: "",
    created: 1700000000,
    files: [],
    status: "idle",
    error: "",
    dir,
    events: [],
    state: {},
    stateVersion: 0,
    owner: "",
    buildLeaseOwner: "",
    mutationLeaseOwner: "",
    buildLock: new AsyncLock(),
    chatTask: null,
    runTask: null,
    lang: "zh",
    emit(kind, payload = {}) {
      const ev = { ...payload, kind } as unknown as SessionEvent;
      (s.events as unknown[]).push(ev);
      return ev;
    },
    async emitDurable(kind, payload = {}) {
      return s.emit(kind, payload);
    },
  } as SessionLike;
  return s;
}

interface DepsOver {
  /** 模型这一轮吐出来的结构（`Completion.data`）。 */
  data?: unknown;
  /** 模型调用直接炸（配额/网络/连撞 schema）。 */
  callThrows?: Error;
  renderSvgPng?: DialogueDeps["renderSvgPng"];
}

/** 只实现 `flow.sketch` 真的会碰到的那几样；碰到别的就抛，免得静默走空路。 */
function makeDeps(over: DepsOver = {}): DialogueDeps {
  const calls: Record<string, unknown>[] = [];
  const impl: Partial<DialogueDeps> & { calls: Record<string, unknown>[] } = {
    calls,
    builtinRegistry: () => new ToolRegistry(),
    chatRun: async (_s, o, body) => {
      calls.push({ kind: o.kind, semanticInput: o.semanticInput });
      return await body({
        repoRunId: "r1",
        recorderRunId: "chat_s1_sketch",
        smart: null,
        fail: () => undefined,
        gw: {
          rec: null,
          async call(name, prompt, opts) {
            calls.push({ node: name, prompt, schema: opts.schema, system: opts.system });
            if (over.callThrows) throw over.callThrows;
            return { data: (over.data ?? null) as Record<string, unknown> | null };
          },
        },
      });
    },
    renderSvgPng:
      over.renderSvgPng ??
      (async () => {
        throw new RenderError("SVG 渲染失败: 这台机器上渲染不了");
      }),
  };
  return new Proxy(impl as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      throw new Error(`fake deps：flow.sketch 不该碰 ${k}`);
    },
  }) as unknown as DialogueDeps;
}

async function sketch(
  s: SessionLike,
  deps: DialogueDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reg = converseTools(s, deps);
  const out = await reg.call("flow.sketch", args, { approved: true, pending: [] }, {
    scope: "converse",
  });
  return out as Record<string, unknown>;
}

// ── 两个域的模型输出。**形状一样、一个中文词都不重**，用来证明没有写死的词表 ──

const 采购 = {
  title: "一般采购流程",
  stages: [
    { key: "s1", title: "阶段一｜需求与计划", subtitle: "从提出需求到计划批准" },
    { key: "s2", title: "阶段二｜寻源与下单", subtitle: "" },
  ],
  nodes: [
    { key: "n1", kind: "action", label: "提交采购申请", stage: "s1", actor: "需求部门" },
    { key: "n2", kind: "event", label: "采购申请已提交", stage: "s1" },
    { key: "n3", kind: "gateway", label: "预算是否充足", stage: "s1" },
    { key: "n4", kind: "action", label: "选定供应商", stage: "s2", actor: "采购部" },
    { key: "n5", kind: "terminal", label: "采购完成", stage: "s2" },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "充足" },
    { from: "n3", to: "n1", label: "不足" },
    { from: "n4", to: "n5" },
  ],
  caveats: ["谁有权批预算，各家差别很大", "是否要走招标"],
};

const 门诊 = {
  title: "一般门诊就诊流程",
  stages: [
    { key: "a", title: "阶段一｜挂号与分诊", subtitle: "" },
    { key: "b", title: "阶段二｜诊查与处置", subtitle: "" },
  ],
  nodes: [
    { key: "p1", kind: "action", label: "患者挂号", stage: "a", actor: "患者" },
    { key: "p2", kind: "event", label: "号源已锁定", stage: "a" },
    { key: "p3", kind: "action", label: "医师问诊", stage: "b", actor: "接诊医师" },
    { key: "p4", kind: "gateway", label: "是否需要检查", stage: "b" },
    { key: "p5", kind: "external", label: "检验科出报告", stage: "b" },
    { key: "p6", kind: "terminal", label: "离院", stage: "b" },
  ],
  edges: [
    { from: "p1", to: "p2" },
    { from: "p2", to: "p3" },
    { from: "p3", to: "p4" },
    { from: "p4", to: "p5", label: "需要" },
    { from: "p5", to: "p3", label: "报告回传" },
    { from: "p4", to: "p6", label: "不需要" },
  ],
};

function svgOf(s: SessionLike, domain: string): string {
  return readFileSync(join(s.dir, "exports", sketchFileName(domain, "svg")), "utf8");
}

// ══════════════════════════════════════════════════════════════════
//  模型出结构 → 渲染出的 SVG 里有对应的节点与泳道
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：模型给结构，toSvg() 画图", () => {
  it("模型给的每个环节与每条泳道都出现在 SVG 里", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    expect(out["error"]).toBeUndefined();

    const svg = svgOf(s, "采购");
    for (const n of 采购.nodes) expect(svg, n.label).toContain(n.label);
    for (const st of 采购.stages) expect(svg, st.title).toContain(st.title);
    // 网关的出边条件 —— 分叉没有条件的图看不懂
    expect(svg).toContain("充足");
    expect(svg).toContain("不足");
    // 抬头那行统计：5 条边全部无出处，所以「N 条边为系统推断」= 5
    expect(svg).toContain("5 条边为系统推断，需人工确认");
  });

  it("**模型不出 SVG，只出结构** —— 送过去的是带 schema 的结构化请求", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 采购 });
    await sketch(s, deps, { domain: "采购", detail: "brief" });
    const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;
    const gwCall = calls.find((c) => c["node"] === "FLOW_SKETCH");
    expect(gwCall).toBeDefined();
    // schema 在，且要的是 stages/nodes/edges 三样，不是一段 svg 文本
    const schema = gwCall!["schema"] as Record<string, unknown>;
    expect(schema["required"]).toEqual(["stages", "nodes", "edges"]);
    expect(JSON.stringify(schema)).not.toContain("svg");
    // 系统提示里明写"没有客户材料，不许假装有"
    expect(String(gwCall!["system"])).toContain("不许假装有");
  });

  it("图上每个框都是虚线 —— 参考图没有一条有出处的断言", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const svg = svgOf(s, "采购");
    // `to_svg` 对 grounded==false 的节点画 stroke-dasharray。5 个节点 = 5 个虚线框。
    const dashed = svg.match(/stroke-dasharray="4 3"/g) ?? [];
    expect(dashed.length).toBe(采购.nodes.length);
  });

  it("mermaid 一起落盘 —— 改不动的草稿只是一张图片", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const mmd = readFileSync(join(s.dir, "exports", sketchFileName("采购", "mmd")), "utf8");
    expect(mmd).toContain("flowchart");
    expect(mmd).toContain("提交采购申请");
  });
});

// ══════════════════════════════════════════════════════════════════
//  换个域照样出得来
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：不许写死成采购", () => {
  it("医疗门诊照样出得来，图里一个采购词都没有", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 门诊 }), { domain: "医疗门诊" });
    expect(out["error"]).toBeUndefined();

    const svg = svgOf(s, "医疗门诊");
    for (const n of 门诊.nodes) expect(svg, n.label).toContain(n.label);
    for (const st of 门诊.stages) expect(svg, st.title).toContain(st.title);
    // 词表写死的症状就是这个：采购域的词漏进了别的域
    for (const w of ["采购", "供应商", "预算", "招标"]) {
      expect(svg, `不该出现「${w}」`).not.toContain(w);
    }
    expect(out["领域"]).toBe("医疗门诊");
  });

  it("域名进 prompt，不进代码 —— 换域只是换一个参数", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 门诊 });
    await sketch(s, deps, { domain: "设备维修" });
    const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;
    expect(String(calls.find((c) => c["node"] === "FLOW_SKETCH")!["prompt"])).toContain("设备维修");
  });

  it("节点编号由规则生成，认不出行业动词也编得出来", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 门诊 }), { domain: "医疗门诊" });
    const svg = svgOf(s, "医疗门诊");
    // `codeFor` 认不出动词时回退到内容哈希 —— 编号必须仍然出得来（不是空）
    expect(svg).toMatch(/(ACT|EVT|GW|END|EXT)-[A-Z0-9]+-[A-Z0-9-]+/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  来源标注：三处都要在
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：来源标注三处都在", () => {
  it("SVG 标题 / 文件名 / 聊天卡片，一处都不能少", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });

    // 1. SVG 标题
    const svg = svgOf(s, "采购");
    expect(svg).toContain(sketchTitle("采购"));
    expect(svg).toContain(SKETCH_MARK);

    // 2. 产物文件名
    const names = readdirSync(join(s.dir, "exports"));
    for (const n of names) {
      expect(n, n).toContain("通用参考");
      expect(n, n).toContain("模型知识");
    }

    // 3. 聊天卡片（sketch.ready 的 payload）
    const card = (s.events as unknown as Record<string, unknown>[]).find(
      (e) => e["kind"] === "sketch.ready",
    );
    expect(card).toBeDefined();
    expect(card!["source_note"]).toBe(SKETCH_MARK);
    expect(String(card!["caveat"])).toContain("不是");

    // 顺带：工具回执里也有，模型转述时不会漏
    expect(out["来源"]).toBe(SKETCH_MARK);
    expect(String(out["说明"])).toContain("通用参考");
  });

  it("卡片是 sketch.ready，不是 export.ready —— 混成一种卡，标记就没地方挂", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const kinds = (s.events as unknown as Record<string, unknown>[]).map((e) => e["kind"]);
    expect(kinds).toContain("sketch.ready");
    expect(kinds).not.toContain("export.ready");
    expect(kinds).not.toContain("flow.ready");
    expect(kinds).not.toContain("artifact.ready");
  });
});

// ══════════════════════════════════════════════════════════════════
//  不污染会话状态与产物目录
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：参考图不是交付物", () => {
  it("一个字都不写 OIR / flow 会话状态", async () => {
    const s = makeSession();
    s.state["已有的东西"] = 1; // 证明断言看的是"没被动过"，不是"状态恰好空"
    const before = JSON.stringify(s.state);
    // 钉的是**这个处理器**：`chatRun` 自己的 run 行与 journal 记账不落 s.state
    // （见 glue/chat_run.ts），所以线上这条路的 state 同样不该被动。

    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });

    expect(JSON.stringify(s.state)).toBe(before);
    for (const k of ["_flow", "flow", "_oir", "oir", "artifacts", "_flow_versions", "_flow_gaps"]) {
      expect(s.state[k], k).toBeUndefined();
    }
  });

  it("落在 exports/，会话根目录下一个文件都不多", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    // 根目录下的文件会被算成产物（artifacts = 根目录下所有文件）、进交付包 zip
    expect(readdirSync(s.dir)).toEqual(["exports"]);
    expect(existsSync(join(s.dir, "exports", sketchFileName("采购", "svg")))).toBe(true);
  });

  it("回执明说它不进产物 —— 模型不会把它当交付物报给用户", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    expect(String(out["没写进产物"])).toContain("不是交付物");
  });
});

// ══════════════════════════════════════════════════════════════════
//  畸形结构：可读的错误，不是崩
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：模型给的结构不合用", () => {
  const bad: [string, unknown, RegExp][] = [
    ["压根不是对象", "一段话", /没给出结构（拿到的是 string）|没给出结构/],
    ["没有阶段", { stages: [], nodes: [], edges: [] }, /stages 是空的/],
    ["没有环节", { stages: [{ key: "s1", title: "阶段一" }], nodes: [], edges: [] }, /nodes 是空的/],
    [
      "节点的 kind 不认识",
      {
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [{ key: "n1", kind: "步骤", label: "干活", stage: "s1" }],
        edges: [{ from: "n1", to: "n1" }],
      },
      /kind 是「步骤」/,
    ],
    [
      "节点挂到一个不存在的泳道上",
      {
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [{ key: "n1", kind: "action", label: "干活", stage: "s9" }],
        edges: [{ from: "n1", to: "n1" }],
      },
      /stage 是「s9」/,
    ],
    [
      "边引用了不存在的节点",
      {
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [
          { key: "n1", kind: "action", label: "干活", stage: "s1" },
          { key: "n2", kind: "event", label: "已干完", stage: "s1" },
        ],
        edges: [{ from: "n1", to: "n7" }],
      },
      /to 是「n7」/,
    ],
    [
      "只给了环节没给顺序",
      {
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [{ key: "n1", kind: "action", label: "干活", stage: "s1" }],
        edges: [],
      },
      /edges 是空的/,
    ],
  ];

  for (const [why, data, re] of bad) {
    it(`${why} → 一句人话，不是崩`, async () => {
      const s = makeSession();
      const out = await sketch(s, makeDeps({ data }), { domain: "采购" });
      expect(String(out["error"])).toContain("模型给的流程结构不合用");
      expect(String(out["error"])).toMatch(re);
      // 失败就不该留半张图在盘上
      expect(existsSync(join(s.dir, "exports"))).toBe(false);
      expect(s.events).toHaveLength(0);
    });
  }

  it("孤立环节要报出来 —— 一张连不起来的图看不懂", () => {
    expect(() =>
      graphFromSketch(
        {
          stages: [{ key: "s1", title: "阶段一" }],
          nodes: [
            { key: "n1", kind: "action", label: "干活", stage: "s1" },
            { key: "n2", kind: "event", label: "已干完", stage: "s1" },
            { key: "n3", kind: "action", label: "没人管的活", stage: "s1" },
          ],
          edges: [{ from: "n1", to: "n2" }],
        },
        { domain: "采购" },
      ),
    ).toThrow(SketchError);
  });

  it("**模型没调通**和**结构不合用**是两条不同的回执", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ callThrows: new Error("配额到顶") }), {
      domain: "采购",
    });
    expect(String(out["error"])).toContain("参考图没画成");
    expect(String(out["error"])).toContain("配额到顶");
    expect(String(out["error"])).not.toContain("结构不合用");
  });

  it("没给 domain / detail 或 format 不认识时，先告诉他怎么改", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 采购 });
    expect(String((await sketch(s, deps, { domain: "  " }))["error"])).toContain("要画哪个领域");
    expect(String((await sketch(s, deps, { domain: "采购", format: "pdf" }))["error"])).toContain(
      "format 只能是 svg 或 png",
    );
    expect(
      String((await sketch(s, deps, { domain: "采购", detail: "超细" }))["error"]),
    ).toContain("详细程度只能是");
  });
});

// ══════════════════════════════════════════════════════════════════
//  PNG：渲染不出来就明说
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：format=png", () => {
  it("渲染失败时**明说 PNG 不可用**，不是悄悄给一张 SVG", async () => {
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 采购 }), { domain: "采购", format: "png" });
    const note = String(out["PNG不可用"]);
    expect(note).toContain("PNG 没生成");
    expect(note).toContain("本进程内渲染");
    expect(note).toContain("回答里必须说这一句");
    expect(out["PNG"]).toBeUndefined();
    // SVG 照给（它是好的），只是必须说清给的是什么
    expect(out["已生成"]).toBe(sketchFileName("采购", "svg"));
  });

  it("渲染得出来的时候 PNG 真落盘", async () => {
    const s = makeSession();
    const deps = makeDeps({
      data: 采购,
      renderSvgPng: async (svg) => {
        expect(svg).toContain("<svg");
        return { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 100, height: 50 };
      },
    });
    const out = await sketch(s, deps, { domain: "采购", format: "png" });
    expect(out["PNG不可用"]).toBeUndefined();
    expect(out["PNG"]).toBe(sketchFileName("采购", "png"));
    const png = readFileSync(join(s.dir, "exports", sketchFileName("采购", "png")));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // 卡片上要带 PNG 的名字，不然界面上下载不到它
    const card = (s.events as unknown as Record<string, unknown>[])[0]!;
    expect(card["png"]).toBe(sketchFileName("采购", "png"));
  });
});

// ══════════════════════════════════════════════════════════════════
//  作用域与危险等级
// ══════════════════════════════════════════════════════════════════

describe("flow.sketch：权限边界", () => {
  const reg = converseTools(makeSession(), makeDeps());

  it("只给工作模式 —— 聊天模式那条路不该能发起付费生成", () => {
    expect(reg.forScope("converse").map((t) => t.spec.name)).toContain("flow.sketch");
    expect(reg.forScope("chat").map((t) => t.spec.name)).not.toContain("flow.sketch");
  });

  it("WRITE_LOCAL，不弹确认 —— 它只写本地文件、不碰 OIR（与 flow.preview 同一档）", () => {
    const spec = reg.get("flow.sketch", "converse").spec;
    expect(spec.danger).toBe(Danger.WRITE_LOCAL);
    expect(spec.danger).toBe(reg.get("flow.preview", "converse").spec.danger);
    expect(spec.requiresApproval).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  命名与标注函数本身
// ══════════════════════════════════════════════════════════════════

describe("标注函数", () => {
  it("文件名里的域名被清洗，但标注词一个字不动", () => {
    expect(sketchFileName("采购/入库", "svg")).toBe("通用参考流程图_模型知识_采购_入库.svg");
    expect(sketchFileName("  ", "svg")).toBe("通用参考流程图_模型知识_未命名.svg");
    // 域名再长也不许把标注挤掉
    const long = sketchFileName("采".repeat(200), "svg");
    expect(long).toContain("通用参考流程图_模型知识_");
    expect([...long].length).toBeLessThan(60);
  });

  it("标题里带域名和标注", () => {
    expect(sketchTitle("放款审批")).toContain("放款审批");
    expect(sketchTitle("放款审批")).toContain(SKETCH_MARK);
  });
});
