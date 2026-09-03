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
import { FlowGraph, makeStage } from "../src/onto/flow.js";
import { OIR } from "../src/onto/oir.js";
import { applyFlowEdit } from "../src/onto/flow_edit.js";
import { sketchDefects } from "../src/onto/flow_sketch.js";
import { AsyncLock } from "../src/server/pipeline/types.js";
import type { SessionEvent } from "../src/session_events.js";
import { converseTools } from "../src/server/dialogue.js";
import { syncAssetMemory } from "../src/server/asset_memory.js";
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
  /** flow.render 的图像档与可控输出。 */
  imageModel?: string;
  imageB64?: string;
  imageB64For?: (opts: Record<string, unknown>) => string;
  imageThrows?: Error;
  /**
   * 允许写流程产物。**默认仍然禁止** —— "flow.sketch 不该碰 rewriteFlowArtifacts"
   * 是一条真守卫（参考图不是产物）。只有 `draft.adopt` 这种明确要转正的工具才打开它。
   */
  allowFlowWrite?: boolean;
}

/** 只实现 `flow.sketch` 真的会碰到的那几样；碰到别的就抛，免得静默走空路。 */
function makeDeps(over: DepsOver = {}): DialogueDeps {
  const calls: Record<string, unknown>[] = [];
  const impl: Partial<DialogueDeps> & { calls: Record<string, unknown>[] } = {
    calls,
    builtinRegistry: () => new ToolRegistry(),
    // `export.file` 的描述按**运行时能力矩阵**拼（这台机器导不导得出 pdf），
    // 所以 converseTools **注册时**就要 exportApi，不只是调用时。
    exportApi: {
      FORMATS: ["xlsx", "docx", "pdf", "md", "csv"],
      availableFormats: () => ["xlsx", "docx", "md", "csv"],
      resolveFormat: (f: string) => f,
      render: async () => [new Uint8Array(), { ext: ".md", label: "MD" }],
      safeName: (t: string, ext: string) => `${t}${ext}`,
    } as unknown as DialogueDeps["exportApi"],
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
          async generateImage(name, opts) {
            calls.push({ node: name, generateImage: true, ...opts });
            if (over.imageThrows) throw over.imageThrows;
            return { b64: over.imageB64For?.(opts) ?? over.imageB64 ?? "iVBORw==" };
          },
        },
      });
    },
    imageModel: () => over.imageModel ?? "",
    // 对话编辑现在会把每次成功的改动记进 revision 台账（ports.ts 的 editRevision）。
    // 不是越权：draft.adopt / oir.add 落地时记账是编辑路径的新正当依赖。
    editRevision: async () => undefined,
    renderSvgPng:
      over.renderSvgPng ??
      (async () => {
        throw new RenderError("SVG 渲染失败: 这台机器上渲染不了");
      }),
    ...(over.allowFlowWrite === true
      ? { rewriteFlowArtifacts: (() => undefined) as DialogueDeps["rewriteFlowArtifacts"] }
      : {}),
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

async function render(
  s: SessionLike,
  deps: DialogueDeps,
  args: Record<string, unknown> = { style: "executive_minimal" },
): Promise<Record<string, unknown>> {
  const reg = converseTools(s, deps);
  const out = await reg.call("flow.render", args, { approved: true, pending: [] }, {
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

    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });

    // **不变量是"不进产物"，不是"一个 key 都不加"。**
    //
    // 这条原来断言 `JSON.stringify(s.state)` 前后逐字节相同。那比它自己的名字严：
    // 它同时禁掉了往一个**独立命名空间**里记东西。而"什么都不记"正是一个真实
    // 缺陷的成因 —— 草图画完就被丢掉，后续调用读不到它，被问到"把图里的 Action
    // 建进模型"时模型只能凭自己上一条回答的文字重想一遍，看起来就像在瞎编。
    //
    // 所以改成白名单：产物键一个都不许碰，`_sketch`/`sketch` 这两个参考图专用键
    // 允许出现，其余一律不许。
    for (const k of ["_flow", "flow", "_oir", "oir", "artifacts", "_flow_versions", "_flow_gaps"]) {
      expect(s.state[k], k).toBeUndefined();
    }
    expect(Object.keys(s.state).sort()).toEqual(["_sketch", "sketch", "已有的东西"]);
    expect(s.state["已有的东西"]).toBe(1);
  });

  it("草图落在自己的命名空间里，并且**能被读回来**", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });

    // 活对象给同一轮里的后续调用用
    const live = s.state["_sketch"] as { nodes: Map<string, unknown> };
    expect(live.nodes.size).toBeGreaterThan(0);

    // dict 给持久化用 —— 会话重载后活对象没了，得能从它重建
    const doc = s.state["sketch"] as Record<string, unknown>;
    expect(doc["domain"]).toBe("采购");
    expect(Object.keys(doc["graph"] as Record<string, unknown>)).toContain("nodes");
    // **不记墙钟**：flow.sketch 全程不碰时间，这是它能被 recorder 重放的前提
    expect(doc["created_at"]).toBeUndefined();
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

describe("flow.render：参考草图可直接走 Image 2", () => {
  it("schema 强制具体 style，并显式承接 theme/layout/visual_brief", () => {
    const spec = converseTools(makeSession(), makeDeps()).get("flow.render", "converse").spec;
    const schema = spec.inputSchema as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, unknown>;
    expect(schema["required"]).toContain("style");
    expect(Object.keys(properties)).toEqual(expect.arrayContaining([
      "style", "theme", "layout", "visual_brief", "model", "size",
    ]));
    expect((properties["layout"] as Record<string, unknown>)["enum"]).toEqual([
      "auto", "left_to_right", "top_to_bottom",
    ]);
  });

  it("auto/same/换一种 这类意图占位词不能冒充具体风格", async () => {
    for (const style of ["auto", "same_style", "different style", "换一种", "另一种"]) {
      const s = makeSession();
      const deps = makeDeps({ data: 采购, imageModel: "openai/gpt-5.4-image-2" });
      await sketch(s, deps, { domain: "采购" });
      const out = await render(s, deps, { style });
      expect(String(out["error"]), style).toContain("指定具体 style");
      const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;
      expect(calls.some((call) => call["generateImage"] === true), style).toBe(false);
    }
  });

  it("flow.sketch 默认只生成动态 SVG/Mermaid，不偷调图像模型", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 采购, imageModel: "openai/gpt-5.4-image-2" });
    const out = await sketch(s, deps, { domain: "采购" });
    const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;

    expect(calls.some((call) => call["generateImage"] === true)).toBe(false);
    expect(out).toMatchObject({
      surface: "chat_card+reference_canvas",
      canvas_updated: false,
      reference_canvas_visible: true,
      display_only: true,
    });
    expect(String(out["theme"])).toMatch(/^auto-/u);
    expect(out["layout"]).toMatchObject({ mode: "auto" });
    const card = (s.events as unknown as Record<string, unknown>[]).find(
      (event) => event["kind"] === "sketch.ready",
    );
    expect(card).toMatchObject({
      template: "auto",
      surface: "chat_card+reference_canvas",
      canvas_updated: false,
      reference_canvas_visible: true,
      display_only: true,
    });
  });

  it("不经 draft.adopt 直接渲染 _sketch，且不污染 formal flow", async () => {
    const s = makeSession();
    const deps = makeDeps({
      data: 采购,
      imageModel: "openai/gpt-5.4-image-2",
      imageB64: "iVBORw==",
    });
    await sketch(s, deps, { domain: "采购" });
    expect(s.state["_flow"]).toBeUndefined();

    const out = await render(s, deps);

    expect(out).toMatchObject({
      模型: "openai/gpt-5.4-image-2",
      source: "generic_reference",
      surface: "chat_card",
      canvas_updated: false,
      display_only: true,
      generic_reference: true,
      正式流程未改动: true,
    });
    expect(String(out["已生成"])).toContain("通用参考");
    expect(String(out["说明"])).toContain("不是客户现状");
    // Image 2 是仅展示资产，必须与正式 artifacts/Bundle 隔离。
    expect(existsSync(join(s.dir, "exports", String(out["已生成"])))).toBe(true);
    expect(existsSync(join(s.dir, String(out["已生成"])))).toBe(false);
    const card = (s.events as unknown as Record<string, unknown>[]).find(
      (event) => event["kind"] === "artifact.ready",
    );
    expect(card).toMatchObject({
      storage: "exports",
      mime: "image/png",
      display_only: true,
    });
    expect(s.state["_flow"]).toBeUndefined();

    const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;
    const image = calls.find((call) => call["generateImage"] === true);
    expect(image?.["model"]).toBe("openai/gpt-5.4-image-2");
    expect(String(image?.["prompt"])).toContain("通用参考 · 非客户材料证据");
  });

  it("风格规格同时进入 prompt、Recorder 语义输入、事件和回执；换风格不重放旧图", async () => {
    const s = makeSession();
    const deps = makeDeps({
      data: 采购,
      imageModel: "openai/gpt-5.4-image-2",
      imageB64For: (opts) => Buffer.from(
        String(opts["prompt"]).includes("blueprint_technical") ? "blueprint-bytes" : "workshop-bytes",
      ).toString("base64"),
    });
    await sketch(s, deps, { domain: "采购" });

    const blueprintArgs = {
      style: " blueprint_technical ",
      theme: " navy   and cyan ",
      layout: "left_to_right",
      visual_brief: "高留白，适合 CTO 评审",
    };
    const workshopArgs = {
      style: "hand_drawn_workshop",
      theme: "warm paper and marker ink",
      layout: "top_to_bottom",
      visual_brief: "便利贴与手绘箭头，但中文节点逐字保留",
    };
    const first = await render(s, deps, blueprintArgs);
    const second = await render(s, deps, workshopArgs);
    const replay = await render(s, deps, workshopArgs);

    const calls = (deps as unknown as { calls: Record<string, unknown>[] }).calls;
    const semantics = calls
      .filter((call) => call["kind"] === "flow_render")
      .map((call) => call["semanticInput"] as Record<string, unknown>);
    expect(semantics).toHaveLength(3);
    expect(semantics[0]?.["visual"]).toEqual({
      style: "blueprint_technical",
      theme: "navy and cyan",
      layout: "left_to_right",
      visual_brief: "高留白，适合 CTO 评审",
    });
    expect(semantics[1]?.["visual"]).toEqual({
      style: "hand_drawn_workshop",
      theme: "warm paper and marker ink",
      layout: "top_to_bottom",
      visual_brief: "便利贴与手绘箭头，但中文节点逐字保留",
    });
    // 同一规格稳定落进同一个 semantic key，真 chatRun/Recorder 会回放；换风格则必定换 key。
    expect(semantics[2]).toEqual(semantics[1]);
    expect(semantics[1]).not.toEqual(semantics[0]);
    expect(semantics[1]?.["prompt"]).not.toBe(semantics[0]?.["prompt"]);

    const imageCalls = calls.filter((call) => call["generateImage"] === true);
    expect(imageCalls).toHaveLength(3); // 此测试替身不实现 Recorder；产品 chatRun 会重放第 3 次。
    expect(String(imageCalls[0]?.["prompt"])).toContain("具体风格：blueprint_technical");
    expect(String(imageCalls[0]?.["prompt"])).toContain("配色与材质主题：navy and cyan");
    expect(String(imageCalls[0]?.["prompt"])).toContain("从左到右");
    expect(String(imageCalls[1]?.["prompt"])).toContain("具体风格：hand_drawn_workshop");
    expect(String(imageCalls[1]?.["prompt"])).toContain("从上到下");

    expect(first).toMatchObject({
      风格: "blueprint_technical",
      主题: "navy and cyan",
      排版: "left_to_right",
      created_new_version: true,
    });
    expect(second).toMatchObject({
      风格: "hand_drawn_workshop",
      排版: "top_to_bottom",
      created_new_version: true,
    });
    expect(replay).toMatchObject({
      风格: "hand_drawn_workshop",
      图像未变化: true,
      created_new_version: false,
    });
    expect(readFileSync(join(s.dir, "exports", String(first["已生成"])), "utf8"))
      .toBe("blueprint-bytes");
    expect(readFileSync(join(s.dir, "exports", String(second["已生成"])), "utf8"))
      .toBe("workshop-bytes");

    const cards = (s.events as unknown as Record<string, unknown>[])
      .filter((event) => event["kind"] === "artifact.ready");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      style: "blueprint_technical",
      theme: "navy and cyan",
      layout: "left_to_right",
    });
    expect(cards[1]).toMatchObject({
      style: "hand_drawn_workshop",
      layout: "top_to_bottom",
    });
  });

  it("同域草图保留独立文件；Image 2 相同字节复用且不重复发卡", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 采购, imageModel: "openai/gpt-5.4-image-2", imageB64: "aW1hZ2U=" });
    const firstSketch = await sketch(s, deps, { domain: "采购", format: "svg" });
    const secondSketch = await sketch(s, deps, { domain: "采购", detail: "detailed", format: "svg" });
    expect(firstSketch["已生成"]).not.toBe(secondSketch["已生成"]);
    expect(existsSync(join(s.dir, "exports", String(firstSketch["已生成"])))).toBe(true);
    expect(existsSync(join(s.dir, "exports", String(secondSketch["已生成"])))).toBe(true);

    const firstImage = await render(s, deps);
    const firstMemoryIds = syncAssetMemory(s).list({ includeSuperseded: true })
      .filter((asset) => asset.metadata["logicalRef"] === "flow.render:generic_reference")
      .map((asset) => asset.id);
    const secondImage = await render(s, deps);
    const secondMemory = syncAssetMemory(s).list({ includeSuperseded: true })
      .filter((asset) => asset.metadata["logicalRef"] === "flow.render:generic_reference");
    expect(firstImage).toMatchObject({ 已生成: "通用参考流程图_模型知识_视觉版.png", created_new_version: true });
    expect(secondImage).toMatchObject({
      图像未变化: true,
      复用已有: firstImage["已生成"],
      created_new_version: false,
    });
    expect(existsSync(join(s.dir, "exports", String(firstImage["已生成"])))).toBe(true);
    expect(readdirSync(join(s.dir, "exports")).filter(
      (name) => !name.startsWith(".__asset_memory__") && name.endsWith("_视觉版.png"),
    )).toHaveLength(1);
    expect((s.events as unknown as Record<string, unknown>[]).filter(
      (event) => event["kind"] === "artifact.ready",
    )).toHaveLength(1);
    expect(firstMemoryIds).toHaveLength(1);
    expect(secondMemory.map((asset) => asset.id)).toEqual(firstMemoryIds);
    expect(secondMemory[0]).toMatchObject({ revision: 1, status: "active" });
    expect(s.state["artifacts"]).toBeUndefined();
  });

  it("Image 2 字节真的变化才生成 _v2，并在资产记忆中形成同一逻辑图的 revision 链", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const first = await render(s, makeDeps({ imageModel: "image-2", imageB64: "c3R5bGUtYQ==" }));
    const changed = await render(s, makeDeps({ imageModel: "image-2", imageB64: "c3R5bGUtYg==" }));

    expect(first).toMatchObject({ 已生成: "通用参考流程图_模型知识_视觉版.png", 图像版本: 1 });
    expect(changed).toMatchObject({ 已生成: "通用参考流程图_模型知识_视觉版_v2.png", 图像版本: 2 });
    expect(readFileSync(join(s.dir, "exports", String(first["已生成"])), "utf8")).toBe("style-a");
    expect(readFileSync(join(s.dir, "exports", String(changed["已生成"])), "utf8")).toBe("style-b");
    expect((s.events as unknown as Record<string, unknown>[]).filter(
      (event) => event["kind"] === "artifact.ready",
    )).toHaveLength(2);

    const memory = syncAssetMemory(s);
    const versions = memory.list({ includeSuperseded: true })
      .filter((asset) => asset.metadata["logicalRef"] === "flow.render:generic_reference")
      .sort((left, right) => left.revision - right.revision);
    expect(versions).toHaveLength(2);
    expect(versions.map((asset) => [asset.revision, asset.status, asset.contentDigest])).toEqual([
      [1, "superseded", expect.any(String)],
      [2, "active", expect.any(String)],
    ]);
    expect(versions[1]?.supersedes).toBe(versions[0]?.id);
    expect(versions[0]?.path).toMatch(/^exports\/\.__asset_memory__/u);
    expect(versions[1]?.path).toMatch(/^exports\/\.__asset_memory__/u);
  });

  it("进程重启丢了 _sketch 活对象后，仍能从持久化 sketch.graph 出视觉版", async () => {
    const s = makeSession();
    const deps = makeDeps({ data: 采购, imageModel: "openai/gpt-5.4-image-2" });
    await sketch(s, deps, { domain: "采购" });
    delete s.state["_sketch"];

    const out = await render(s, deps);

    expect(out["error"]).toBeUndefined();
    expect(out["source"]).toBe("generic_reference");
    expect(s.state["_flow"]).toBeUndefined();
  });
});

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

// ══════════════════════════════════════════════════════════════════
//  画过的图要能被读回来，而且不重复画
// ══════════════════════════════════════════════════════════════════

async function call(
  s: SessionLike,
  deps: DialogueDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const reg = converseTools(s, deps);
  const out = await reg.call(name, args, { approved: true, pending: [] }, { scope: "converse" });
  return out as Record<string, unknown>;
}

describe("画过的图要能被读回来", () => {
  it("sketch.query 给出逐字的节点与连线清单 —— 模型不必凭记忆复述", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });

    const out = await call(s, makeDeps({ data: 采购 }), "sketch.query");
    const nodes = out["节点"] as Array<Record<string, string>>;
    expect(nodes.length).toBeGreaterThan(0);
    // 每个节点都带 kind / label / stage —— 建进模型时要照抄的就是这些
    for (const n of nodes) {
      expect(n["label"]).toBeTruthy();
      expect(["action", "event", "gateway", "terminal", "external"]).toContain(n["kind"]);
      expect(n["stage"]).toBeTruthy();
    }
    expect((out["连线"] as unknown[]).length).toBeGreaterThan(0);
    expect(String(out["说明"])).toContain("不是客户材料事实");
  });

  it("还没画过图时说清楚，并指到 flow.sketch，而不是回一句空", async () => {
    const s = makeSession();
    const out = await call(s, makeDeps({ data: 采购 }), "sketch.query");
    expect(String(out["error"])).toContain("还没有画过");
    expect(String(out["下一步"])).toContain("flow.sketch");
  });

  it("会话重载后（活对象没了）仍能从落库的 dict 读回来", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    delete s.state["_sketch"]; // 模拟进程重启：活对象没了，dict 还在

    const out = await call(s, makeDeps({ data: 采购 }), "sketch.query");
    expect(out["error"]).toBeUndefined();
    expect((out["节点"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("同一个领域不重复画 —— 连着要四次只画一次", async () => {
    const s = makeSession();
    let calls = 0;
    const deps = (): DialogueDeps => {
      const d = makeDeps({ data: 采购 });
      const inner = (d as unknown as { chatRun: unknown }).chatRun as (...a: unknown[]) => unknown;
      (d as unknown as Record<string, unknown>)["chatRun"] = (...a: unknown[]) => {
        calls += 1;
        return inner(...a);
      };
      return d;
    };
    await sketch(s, deps(), { domain: "采购" });
    // 换个说法指的还是同一张：归一化后「采购流程」「采购、报销」这类都该命中
    const again = await sketch(s, deps(), { domain: "采购流程" });

    expect(calls).toBe(1);
    expect(again["已有参考图"]).toBeTruthy();
    expect(String(again["说明"])).toContain("已经画过");
    expect((again["节点"] as unknown[]).length).toBeGreaterThan(0);
    // 只发过一张卡片
    const cards = (s.events as unknown as Record<string, unknown>[])
      .filter((e) => e["kind"] === "sketch.ready");
    expect(cards).toHaveLength(1);
  });

  it("**不同领域照画** —— 去重不能把「入职流程」也一起挡掉", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const out = await sketch(s, makeDeps({ data: 门诊 }), { domain: "医疗门诊" });
    expect(out["已有参考图"]).toBeUndefined();
    expect(out["已生成"]).toBeTruthy();
  });

  it("旧 classic 草图没有动态模板元数据时会重绘，而不是被去重守卫永久卡住", async () => {
    const s = makeSession();
    const firstDeps = makeDeps({ data: 采购 });
    await sketch(s, firstDeps, { domain: "采购" });
    delete (s.state["sketch"] as Record<string, unknown>)["template"];

    const secondDeps = makeDeps({ data: 采购 });
    const out = await sketch(s, secondDeps, { domain: "采购" });

    expect(out["已有参考图"]).toBeUndefined();
    expect(String(out["theme"])).toMatch(/^auto-/u);
    expect((s.state["sketch"] as Record<string, unknown>)["template"]).toBe("auto");
  });
});

describe("add_event：Event 和它的产生者一次建好", () => {
  it("producer 给了就自动连边 —— 不给 producer 的 Event 编译出来是 unknown", () => {
    const g = new FlowGraph();
    g.stages.set("s1", makeStage({ key: "s1", title: "阶段一", order: 0 }));
    applyFlowEdit(g, "add_node", { kind: "action", label: "提交报销单", stage: "s1" });
    const note = applyFlowEdit(g, "add_event", {
      label: "报销单已提交",
      stage: "s1",
      producer: "提交报销单",
    });

    const evt = [...g.nodes.values()].find((n) => n.label.value === "报销单已提交")!;
    const act = [...g.nodes.values()].find((n) => n.label.value === "提交报销单")!;
    expect(String(evt.kind)).toBe("event");
    // 一次调用就建好了节点 + 来源边
    expect([...g.edges.values()].some((e) => e.source === act.rid && e.target === evt.rid)).toBe(true);
    expect(note).toContain("产生它的");
  });

  it("不给 producer 时**明说**这个 Event 还没有来源，不静默留一个孤儿", () => {
    const g = new FlowGraph();
    g.stages.set("s1", makeStage({ key: "s1", title: "阶段一", order: 0 }));
    const note = applyFlowEdit(g, "add_event", { label: "报销单已提交", stage: "s1" });
    expect(note).toContain("还没有产生者");
    expect(note).toContain("unknown");
  });

  it("producer 必须是 action/external —— 事件产生事件是建模错误", () => {
    const g = new FlowGraph();
    g.stages.set("s1", makeStage({ key: "s1", title: "阶段一", order: 0 }));
    applyFlowEdit(g, "add_event", { label: "报销单已提交", stage: "s1" });
    expect(() =>
      applyFlowEdit(g, "add_event", {
        label: "报销审批已通过",
        stage: "s1",
        producer: "报销单已提交",
      }),
    ).toThrow(/producer 必须是/u);
  });
});

describe("结构门禁：sketch 之外那几条规则", () => {
  // **先说清这道门禁补的是哪一段。** `graphFromSketch` 本身已经拦掉了两类最严重的：
  // 0 条边（"只给了环节没给顺序"）和孤立节点（"这些环节没有任何连线"）。
  // 门禁补的是它拦不掉的三条：分叉没条件、事件没有产生者、环节重名。
  //
  // 更要紧的是：用户看到的那份 0 边、未分阶段的 Ontology **不是 sketch 产的** ——
  // 它来自 draft.initialize + 逐条 oir.add/flow.edit，那条路上一条校验都没有。
  // 同一套规则要接到那边去（文档 P2-3），这里先把规则本身钉住。

  it("分叉没写条件、事件没有产生者、环节重名 —— 三条都要抓出来", () => {
    const g = graphFromSketch(
      {
        title: "有毛病的图",
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [
          { key: "n1", kind: "action", label: "审批", stage: "s1" },
          { key: "n2", kind: "gateway", label: "金额判断", stage: "s1" },
          { key: "n3", kind: "action", label: "审批", stage: "s1" }, // 与 n1 同名
          { key: "n4", kind: "event", label: "已通过", stage: "s1" },
        ],
        edges: [
          { from: "n1", to: "n2", label: "" },
          { from: "n2", to: "n3", label: "" }, // 网关出边没条件
          { from: "n4", to: "n1", label: "" }, // 事件在最前面：它没有产生者
        ],
      },
      { domain: "采购" },
    );
    const defects = sketchDefects(g).join("\n");
    expect(defects).toContain("没写条件");
    expect(defects).toContain("没有产生它的动作");
    expect(defects).toContain("重名");
  });

  it("合格的图一条缺陷都不报，也照常出图", async () => {
    expect(sketchDefects(graphFromSketch(采购, { domain: "采购" }))).toEqual([]);
    const s = makeSession();
    const out = await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    expect(out["code"]).toBeUndefined();
    expect(out["已生成"]).toBeTruthy();
  });

  it("门禁拦下时不出图、不发卡片、不落状态 —— 半成品不许流出去", async () => {
    const s = makeSession();
    // 直接钉处理器的行为：构造一份能过 graphFromSketch、但网关出边没条件的结构
    const 网关无条件 = {
      title: "分叉没条件",
      stages: [{ key: "s1", title: "阶段一", subtitle: "" }],
      nodes: [
        { key: "n1", kind: "action", label: "提交", stage: "s1", actor: "员工" },
        { key: "n2", kind: "gateway", label: "金额判断", stage: "s1", actor: "" },
        { key: "n3", kind: "action", label: "审批", stage: "s1", actor: "主管" },
      ],
      edges: [
        { from: "n1", to: "n2", label: "" },
        { from: "n2", to: "n3", label: "" },
      ],
      caveats: [],
    };
    const out = await sketch(s, makeDeps({ data: 网关无条件 }), { domain: "采购" });

    expect(out["code"]).toBe("STRUCTURE_REJECTED");
    expect((out["缺陷"] as string[]).join("\n")).toContain("没写条件");
    const kinds = (s.events as unknown as Record<string, unknown>[]).map((e) => e["kind"]);
    expect(kinds).not.toContain("sketch.ready");
    expect(s.state["_sketch"]).toBeUndefined();
    expect(readdirSync(s.dir)).toEqual([]);
  });
});

describe("draft.adopt：参考图转正成产物", () => {
  it("把画好的图整个写进 _flow —— 修的是「好图 + 空 Ontology」", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    const drawn = s.state["_sketch"] as FlowGraph;

    const out = await call(s, makeDeps({ data: 采购, allowFlowWrite: true }), "draft.adopt");

    expect(out["已转正"]).toBe(true);
    const flow = s.state["_flow"] as FlowGraph;
    // 节点、边、阶段一个不少地进了产物
    expect(flow.nodes.size).toBe(drawn.nodes.size);
    expect(flow.edges.size).toBe(drawn.edges.size);
    expect(flow.stages.size).toBe(drawn.stages.size);
    expect(flow.dangling()).toEqual([]); // 连通性带过来了
    expect(s.state["release_state"]).toBe("DRAFT");
  });

  it("**零模型调用** —— 用的就是屏幕上那张，不重新生成", async () => {
    const s = makeSession();
    let calls = 0;
    const counting = (): DialogueDeps => {
      const d = makeDeps({ data: 采购, allowFlowWrite: true });
      const inner = (d as unknown as { chatRun: unknown }).chatRun as (...a: unknown[]) => unknown;
      (d as unknown as Record<string, unknown>)["chatRun"] = (...a: unknown[]) => {
        calls += 1;
        return inner(...a);
      };
      return d;
    };
    await sketch(s, counting(), { domain: "采购" });
    expect(calls).toBe(1);
    await call(s, counting(), "draft.adopt");
    expect(calls).toBe(1); // 转正没有再花一次
  });

  it("转正**不等于**变成客户事实：溯源、发布状态、零 evidence 三样都要对", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    await call(s, makeDeps({ data: 采购, allowFlowWrite: true }), "draft.adopt");

    const prov = s.state["draft_provenance"] as Record<string, unknown>;
    expect(prov["assertion_origin"]).toBe("generic_assumption");
    expect(prov["grounded"]).toBe(false);
    expect(s.state["flow_provenance"]).toBe("generic");
    // 一条 evidence 都不能有，否则会被算成"有材料依据"
    for (const n of (s.state["_flow"] as FlowGraph).nodes.values()) {
      expect(n.label.evidence).toEqual([]);
    }
  });

  it("没画过图时说清楚，并指到 flow.sketch", async () => {
    const s = makeSession();
    const out = await call(s, makeDeps({ data: 采购, allowFlowWrite: true }), "draft.adopt");
    expect(String(out["error"])).toContain("还没有画过");
    expect(String(out["下一步"])).toContain("flow.sketch");
  });

  it("有客户材料时拒绝 —— 通用经验不能覆盖真实梳理", async () => {
    const s = makeSession();
    await sketch(s, makeDeps({ data: 采购 }), { domain: "采购" });
    s.files = [{ name: "采购制度.docx" }] as never;

    const out = await call(s, makeDeps({ data: 采购, allowFlowWrite: true }), "draft.adopt");
    expect(String(out["error"])).toContain("已有客户材料");
    expect(s.state["_flow"]).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  端到端：一份连通的通用 Ontology 到底要几次工具调用
// ══════════════════════════════════════════════════════════════════

describe("从零到一份连通的通用 Ontology", () => {
  it("三次调用做完 —— 而不是逐个元素加、在 5 步预算里永远建不完", async () => {
    const s = makeSession();
    const deps = (): DialogueDeps => makeDeps({ data: 采购, allowFlowWrite: true });
    let toolCalls = 0;
    const step = async (name: string, args: Record<string, unknown> = {}) => {
      toolCalls += 1;
      return await call(s, deps(), name, args);
    };

    // ① 画骨架（含阶段、环节、连线；结构门禁已经过了）
    await step("flow.sketch", { domain: "采购" });
    // ② 转正成 DRAFT 产物 —— 零模型调用
    const adopted = await step("draft.adopt");
    // ③ 一次把数据对象、属性、关系、规则全建上
    const built = await step("oir.add", {
      basis: "generic_assumption",
      op: "add_batch",
      items: [
        { op: "add_object_type", api_name: "PurchaseOrder", display_name: "采购订单" },
        { op: "add_object_type", api_name: "Supplier", display_name: "供应商" },
        {
          op: "add_property",
          object: "PurchaseOrder",
          api_name: "amount",
          display_name: "金额",
          base_type: "DECIMAL",
        },
        { op: "add_link", source: "PurchaseOrder", target: "Supplier", cardinality: "ONE_TO_MANY" },
        { op: "add_rule", statement: "单笔超 5000 元需总监加签", kind: "AUTHORITY" },
      ],
    });

    expect(toolCalls).toBe(3);
    expect(adopted["已转正"]).toBe(true);
    expect(built["error"]).toBeUndefined();

    // 流程是**连通**的 —— 这是"粗糙的模板"与"一堆孤立节点"的分界线
    const flow = s.state["_flow"] as FlowGraph;
    expect(flow.nodes.size).toBeGreaterThan(4);
    expect(flow.edges.size).toBeGreaterThan(0);
    expect(flow.dangling()).toEqual([]);
    expect([...flow.nodes.values()].every((n) => n.stage !== "")).toBe(true); // 没有"未分阶段"

    // 模型侧也有东西了 —— 不再是"好图 + 空 Ontology"
    // OIR 的这几个容器是 Map，不是数组 —— toHaveLength 认 .size（实测会在数字
    // 写错时失败，不是随便过）
    const oir = s.state["_oir"] as OIR;
    expect(oir.objects).toHaveLength(2);
    expect(oir.properties).toHaveLength(1);
    expect(oir.links).toHaveLength(1);
    expect(oir.rules).toHaveLength(1);

    // 全程标着"通用假设"，一条 evidence 都没有
    expect(s.state["release_state"]).toBe("DRAFT");
    for (const n of flow.nodes.values()) expect(n.label.evidence).toEqual([]);
  });
});

describe("业务合理性评审：评委 ≠ 生成者", () => {
  /** 让 fake deps 按调用节点分别给结构和评审两份数据。 */
  function reviewDeps(review: unknown, over: Record<string, unknown> = {}): DialogueDeps {
    const d = makeDeps({ data: 采购, ...over });
    (d as unknown as Record<string, unknown>)["chatRun"] = async (
      _s: unknown,
      o: { kind: string },
      body: (run: unknown) => Promise<unknown>,
    ) =>
      await body({
        repoRunId: "r1",
        recorderRunId: "chat_s1",
        smart: "judge-model",
        fail: () => undefined,
        gw: {
          rec: null,
          async call(name: string) {
            return { data: name === "FLOW_SKETCH_REVIEW" ? review : 采购 };
          },
        },
      });
    return d;
  }

  it("detailed 档会过评审，缺环节要如实报出来 —— 但**不自动重画**", async () => {
    const s = makeSession();
    const out = await sketch(
      s,
      reviewDeps({
        verdict: "revise",
        checks: [{ item: "missing_key_step", ok: 0, why: "没有比价" }],
        missing: ["供应商比价", "合同签署"],
      }),
      { domain: "采购", detail: "detailed" },
    );

    expect(out["已生成"]).toBeTruthy(); // 图照样出了
    expect(String(out["评审认为还缺"])).toContain("供应商比价");
    expect(String(out["补法"])).toContain("apply_patch");
    expect(String(out["补法"])).toContain("先跟用户说一声");
  });

  it("评审通过时不添乱", async () => {
    const s = makeSession();
    const out = await sketch(
      s,
      reviewDeps({ verdict: "pass", checks: [{ item: "stage_coverage", ok: 1 }], missing: [] }),
      { domain: "采购", detail: "detailed" },
    );
    expect(out["评审认为还缺"]).toBeUndefined();
  });

  it("**只在 detailed 档评** —— 6–10 个环节的草图不值得再花一次判决调用", async () => {
    const s = makeSession();
    let reviewed = false;
    const d = makeDeps({ data: 采购 });
    (d as unknown as Record<string, unknown>)["chatRun"] = async (
      _s: unknown,
      o: { kind: string },
      body: (run: unknown) => Promise<unknown>,
    ) => {
      if (o.kind === "flow_sketch_review") reviewed = true;
      return await body({
        repoRunId: "r1", recorderRunId: "c", smart: null, fail: () => undefined,
        gw: { rec: null, async call() { return { data: 采购 }; } },
      });
    };
    await sketch(s, d, { domain: "采购", detail: "brief" });
    expect(reviewed).toBe(false);
  });

  it("评审跑不通不该让一张合格的图出不来 —— 它是加分项", async () => {
    const s = makeSession();
    const d = makeDeps({ data: 采购 });
    (d as unknown as Record<string, unknown>)["chatRun"] = async (
      _s: unknown,
      o: { kind: string },
      body: (run: unknown) => Promise<unknown>,
    ) => {
      if (o.kind === "flow_sketch_review") throw new Error("评审模型挂了");
      return await body({
        repoRunId: "r1", recorderRunId: "c", smart: null, fail: () => undefined,
        gw: { rec: null, async call() { return { data: 采购 }; } },
      });
    };
    const out = await sketch(s, d, { domain: "采购", detail: "detailed" });
    expect(out["已生成"]).toBeTruthy();
    expect(out["评审认为还缺"]).toBeUndefined();
  });
});

describe("渲染回看：让模型看见自己画的图", () => {
  /** 三条路各给一份数据：结构 / 业务评审 / 看图。 */
  function lookDeps(look: unknown): DialogueDeps {
    const d = makeDeps({
      data: 采购,
      renderSvgPng: async () => ({ png: new Uint8Array([137, 80, 78, 71]), width: 800, height: 600 }),
    });
    const seenImages: string[][] = [];
    (d as unknown as Record<string, unknown>)["seenImages"] = seenImages;
    (d as unknown as Record<string, unknown>)["chatRun"] = async (
      _s: unknown,
      _o: unknown,
      body: (run: unknown) => Promise<unknown>,
    ) =>
      await body({
        repoRunId: "r", recorderRunId: "c", smart: "vision-model", fail: () => undefined,
        gw: {
          rec: null,
          async call(name: string, _p: string, opts: { images?: readonly string[] }) {
            if (name === "FLOW_SKETCH_LOOK") {
              seenImages.push([...(opts.images ?? [])]);
              return { data: look };
            }
            if (name === "FLOW_SKETCH_REVIEW") return { data: { verdict: "pass", checks: [] } };
            return { data: 采购 };
          },
        },
      });
    return d;
  }

  it("**图真的被送进去了** —— 不是拿文字结构当图看", async () => {
    const s = makeSession();
    const deps = lookDeps({ readable: true, problems: [] });
    await sketch(s, deps, { domain: "采购", detail: "detailed", format: "png" });
    const seen = (deps as unknown as Record<string, string[][]>)["seenImages"] ?? [];
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBeTruthy(); // base64 PNG
  });

  it("看出问题 → 给的是**我们真有的旋钮**，不许许诺做不到的重排", async () => {
    const s = makeSession();
    const out = await sketch(
      s,
      lookDeps({ readable: false, problems: ["too_dense", "label_truncated"], note: "挤" }),
      { domain: "采购", detail: "detailed", format: "png" },
    );
    const fixes = (out["图面偏挤"] as string[]).join("\n");
    expect(fixes).toContain("detail 降一档");
    expect(fixes).toContain("改短");
    // 不自动重画 —— 改哪个是产品判断
    expect(String(out["图面说明"])).toContain("由用户定");
    expect(out["已生成"]).toBeTruthy();
  });

  it("图能读时不添乱", async () => {
    const s = makeSession();
    const out = await sketch(s, lookDeps({ readable: true, problems: [] }), {
      domain: "采购", detail: "detailed", format: "png",
    });
    expect(out["图面偏挤"]).toBeUndefined();
  });

  it("没出 PNG 就不看图（没东西可看）", async () => {
    const s = makeSession();
    const deps = lookDeps({ readable: false, problems: ["too_dense"] });
    await sketch(s, deps, { domain: "采购", detail: "detailed" }); // format 默认 svg
    expect((deps as unknown as Record<string, string[][]>)["seenImages"]).toHaveLength(0);
  });
});

describe("材料接地（用户传了流程图图片时）", () => {
  const OCR_CHUNKS = {
    "流程图.png": [
      { text: "〔title〕2.2 按业务流程匹配需求进行说明", tags: ["ocr", "title"] },
      { text: "〔paragraph〕采购需求计划流程", tags: ["ocr", "paragraph"] },
      { text: "〔paragraph〕采购执行计划流程", tags: ["ocr", "paragraph"] },
      { text: "〔paragraph〕变更采购需求计划流程", tags: ["ocr", "paragraph"] },
      { text: "〔note〕审批通过后进入执行环节", tags: ["ocr", "note"] },
    ],
  };

  it("**OCR 流程文本要喂进 prompt** —— 重画用材料里的原词，不是另编通识叫法", async () => {
    const deps = makeDeps({ data: 采购 });
    const s = makeSession();
    s.state["_chunks"] = OCR_CHUNKS;
    await sketch(s, deps, { domain: "采购" });
    const call = (deps as unknown as { calls: Record<string, unknown>[] }).calls.find((c) => c["node"] === "FLOW_SKETCH")!;
    const prompt = String(call["prompt"]);
    expect(prompt).toContain("用户材料里的流程相关内容");
    expect(prompt).toContain("采购需求计划流程");
    expect(prompt).toContain("优先用上面材料里出现的原词");
    // 记进 semanticInput —— 重放指纹要能区分接地版和纯通识版
    const runCall = (deps as unknown as { calls: Record<string, unknown>[] }).calls.find((c) => c["kind"] === "flow_sketch")!;
    expect((runCall["semanticInput"] as Record<string, unknown>)["grounded"]).toBe(true);
  });

  it("没有材料（或流程相关切片不足 5 条）时 prompt 不变 —— 纯通识路径原样", async () => {
    const deps = makeDeps({ data: 采购 });
    const s = makeSession();
    s.state["_chunks"] = { "杂.txt": [{ text: "与流程无关的内容", tags: [] }] };
    await sketch(s, deps, { domain: "采购" });
    const call = (deps as unknown as { calls: Record<string, unknown>[] }).calls.find((c) => c["node"] === "FLOW_SKETCH")!;
    expect(String(call["prompt"])).not.toContain("用户材料里的流程相关内容");
  });
});
