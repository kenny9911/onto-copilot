// @vitest-environment happy-dom
/**
 * 右栏预览的组件契约 —— preview.ts 的 paint() 里属于这条 track 的四个分支
 * （材料 / 实体 / 冲突 / 流程图）加上产物下载行，换成组件之后要保的东西：
 *
 *   · 类名与结构逐字对齐旧模板串；
 *   · 材料 chip 的**文件名**、sheet 名、冲突摘要、产物名全都是用户或模型给的自由
 *     文本 —— 旧写法用 earg 拼进 onclick，漏一层就是一次存储型 XSS。React 下参数
 *     是值，这里断的是「喂恶意串进去，出来仍然是字，而且没长出新属性」；
 *   · 「再看 100 行」「点开一张 sheet」「点证据回原文」这些行为一条都不能丢。
 *
 * 分组本身（groupBySheet / sheetShape）是纯函数，仍在 preview.ts，它们的 4 条测试
 * （ui.session.test.ts）一个字没动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// 组件调的是 preview.ts / upload.ts 里现成的动作函数（它们带网络与 confirm），
// 这里要断的是「点下去谁被调、收到什么」，所以换成假的。
// importOriginal 保住被组件当纯函数用的那些导出（groupBySheet）。
vi.mock("../src/ui/preview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/preview.js")>();
  return { ...actual, loadSource: vi.fn(), openSource: vi.fn(), toggleSheet: vi.fn() };
});
vi.mock("../src/ui/upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/upload.js")>();
  return { ...actual, dropMaterial: vi.fn(), startBuild: vi.fn() };
});

const { G } = await import("../src/ui/state.js");
const { loadSource, openSource, toggleSheet } = await import("../src/ui/preview.js");
const { dropMaterial, startBuild } = await import("../src/ui/upload.js");
const {
  ArtifactRows, ChunkBody, ConflictsTab, EntitiesTab, EvidenceChip, FileChip,
  FlowTab, MaterialsTab, Placeholder, PREVIEW_TABS, PreviewBody, SheetGroup,
} = await import("../src/ui/react/preview.js");
const { ModelOptions, StartBuildButton } = await import("../src/ui/react/upload.js");
// 另外三个 tab 在**自己的模块顶层**登记进 PREVIEW_TABS —— 这两行 import 就是
// react/regions.ts 干的事。少一行 = 少一整块屏幕，而且不报错，所以要测。
const { ArtifactsTab, QuestionWorkbench } = await import("../src/ui/react/workbench.js");
const { OpsLog, ThinkTab, TraceGroups, TraceRow } = await import("../src/ui/react/think.js");
const { registeredRegions } = await import("../src/ui/react/app.js");

const EVIL = `"><img src=x onerror=alert(1)>`;
const EVIL_JS = `x','');globalThis.__pwned=1;//`;

function attrNames(root: Element): Set<string> {
  const names = new Set<string>();
  const visit = (el: Element): void => {
    for (const a of Array.from(el.attributes) as any[]) names.add(a.name);
    for (const c of Array.from(el.children) as any[]) visit(c);
  };
  visit(root);
  return names;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as any).__pwned;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0,
          filelist: [], state: {}, events: [] };
  G.LANG = "zh"; G.TAB = "mat"; G.FILE = null; G.SRC = {};
  G.MAT_N = 100; G.MAT_OPEN = new Set(); G.MODELS = [];
  G.TRACE = []; G.OPS = [];
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  切片正文：列=值|列=值 拆成对齐的键值对
// ══════════════════════════════════════════════════════════════════
describe("<ChunkBody>", () => {
  it("拆成 .kv > .kvr > (.kvk/.kvv)，同一列在不同行是对齐的", () => {
    const { container } = render(<ChunkBody c={{ text: "订单号=A1|状态=已发货" }} />);
    const rows = container.querySelectorAll(".kv > .kvr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".kvk")!.textContent).toBe("订单号");
    expect(rows[0]!.querySelector(".kvv")!.textContent).toBe("A1");
    expect(rows[1]!.querySelector(".kvk")!.textContent).toBe("状态");
    expect(rows[1]!.querySelector(".kvv")!.textContent).toBe("已发货");
  });

  it("没有 = 的那一段只出 .kvv（键位空着，比编一个键名诚实）", () => {
    const { container } = render(<ChunkBody c={{ text: "订单号=A1|光秃秃一段|状态=x" }} />);
    const bare = container.querySelectorAll(".kvr")[1]!;
    expect(bare.querySelector(".kvk")).toBeNull();
    expect(bare.querySelector(".kvv")!.textContent).toBe("光秃秃一段");
  });

  it("不是键值对形态就当纯文本，一个 .kv 都不出", () => {
    const { container } = render(<ChunkBody c={{ text: "一段散文" }} />);
    expect(container.querySelector(".kv")).toBeNull();
    expect(container.textContent).toBe("一段散文");
  });

  it("只有一对也不拆（`a=b` 拆出来反而比原样难读）", () => {
    const { container } = render(<ChunkBody c={{ text: "a=b|" }} />);
    expect(container.querySelector(".kv")).toBeNull();
  });

  it("**标记是文本** —— 材料正文完全由上传的文件决定", () => {
    const { container } = render(<ChunkBody c={{ text: `<b>散文</b>${EVIL}` }} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(`<b>散文</b>${EVIL}`);
  });

  it("超长正文截到 600 字", () => {
    const { container } = render(<ChunkBody c={{ text: "字".repeat(900) }} />);
    expect(container.textContent).toHaveLength(600);
  });
});

// ══════════════════════════════════════════════════════════════════
//  材料 chip
// ══════════════════════════════════════════════════════════════════
describe("<FileChip>", () => {
  const f = (o: Record<string, unknown> = {}) =>
    ({ name: "订单.xlsx", state: "parsed", chunks: 12, ...o });

  it("解析状态看得见（「这份读进来了没有」是个事实，不该去问助手）", () => {
    const { container } = render(<FileChip f={f()} />);
    expect(container.querySelector(".f")!.textContent).toContain("订单.xlsx");
    expect(container.querySelector("i")!.textContent).toContain("12");
    cleanup();
    const pend = render(<FileChip f={f({ state: "scan_pending" })} />);
    expect(pend.container.querySelector("i")!.textContent).toBeTruthy();
    cleanup();
    // 认不出的状态退回 unread，而不是空白或崩掉
    const weird = render(<FileChip f={f({ state: "从没见过的状态" })} />);
    expect(weird.container.querySelector("i")!.textContent).toBeTruthy();
  });

  it("当前打开的那份带 on 类", () => {
    G.FILE = "订单.xlsx";
    expect(render(<FileChip f={f()} />).container.querySelector(".f.on")).not.toBeNull();
  });

  it("点 chip：FILE 换成它、并去取原文", () => {
    const { container } = render(<FileChip f={f()} />);
    fireEvent.click(container.querySelector(".f")!);
    expect(G.FILE).toBe("订单.xlsx");
    expect(loadSource).toHaveBeenCalledWith("订单.xlsx");
  });

  it("点「×」撤材料，**不会顺带把这份文件打开**（stopPropagation 还在）", () => {
    const { container } = render(<FileChip f={f()} />);
    fireEvent.click(container.querySelector("b")!);
    expect(dropMaterial).toHaveBeenCalledWith("订单.xlsx");
    expect(loadSource).not.toHaveBeenCalled();
  });

  it("敌意文件名：是文本、不长新属性、处理器收到原样的串", () => {
    const { container } = render(<FileChip f={f({ name: EVIL_JS })} />);
    expect(container.querySelector("img")).toBeNull();
    expect([...attrNames(container.querySelector(".f")!)].filter(n => n.startsWith("on"))).toEqual([]);
    fireEvent.click(container.querySelector("b")!);
    expect(dropMaterial).toHaveBeenCalledWith(EVIL_JS);
    expect((globalThis as any).__pwned).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  sheet 分组
// ══════════════════════════════════════════════════════════════════
describe("<SheetGroup>", () => {
  const g = (n = 3, o: Record<string, unknown> = {}) => ({
    sheet: "订单表", shape: "实体清单",
    rows: Array.from({ length: n }, (_, i) => ({ cite: `a.xlsx!订单表!R${i}`, text: "行" + i })),
    ...o,
  });

  it("折叠时只有表头，行一条都不画（477 张卡片的墙没人看得下去）", () => {
    const { container } = render(<SheetGroup g={g()} />);
    expect(container.querySelector(".msheet > .mshead > .mstri")!.textContent).toBe("▸");
    expect(container.querySelector(".msname")!.textContent).toBe("订单表");
    expect(container.querySelector(".msshape")!.textContent).toBe("实体清单");
    expect(container.querySelector(".mscount")!.textContent).toBe("3 行");
    expect(container.querySelector(".msrows")).toBeNull();
  });

  it("展开时三角翻过来，行画出来并带 data-cite（证据链靠它定位）", () => {
    G.MAT_OPEN = new Set(["订单表"]);
    const { container } = render(<SheetGroup g={g()} />);
    expect(container.querySelector(".mstri")!.textContent).toBe("▾");
    const rows = container.querySelectorAll(".msrows > .mrow");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute("data-cite")).toBe("a.xlsx!订单表!R0");
    expect(rows[0]!.getAttribute("title")).toBe("a.xlsx!订单表!R0");
  });

  it("认不出形状就不出那个标签（不是出一个空的）", () => {
    expect(render(<SheetGroup g={g(1, { shape: "" })} />).container.querySelector(".msshape")).toBeNull();
  });

  it("点表头开合", () => {
    const { container } = render(<SheetGroup g={g()} />);
    fireEvent.click(container.querySelector(".mshead")!);
    expect(toggleSheet).toHaveBeenCalledWith("订单表");
  });

  it("超过 MAT_N 行只画前 MAT_N，并给一个「再看 100 行（共 N）」", () => {
    G.MAT_OPEN = new Set(["订单表"]); G.MAT_N = 2;
    const { container } = render(<SheetGroup g={g(5)} />);
    expect(container.querySelectorAll(".mrow")).toHaveLength(2);
    const more = container.querySelector(".msrows > button.act")!;
    expect(more.textContent).toContain("共 5");
    fireEvent.click(more);
    expect(G.MAT_N).toBe(102);
  });

  it("行数没超就不出那个按钮", () => {
    G.MAT_OPEN = new Set(["订单表"]);
    expect(render(<SheetGroup g={g(3)} />).container.querySelector("button.act")).toBeNull();
  });

  it("敌意 sheet 名与正文都是文本，且没长出 on* 属性", () => {
    G.MAT_OPEN = new Set([EVIL]);
    const { container } = render(
      <SheetGroup g={{ sheet: EVIL, shape: EVIL, rows: [{ cite: EVIL, text: EVIL }] }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".msname")!.textContent).toBe(EVIL);
    expect(container.querySelector(".mrow")!.getAttribute("data-cite")).toBe(EVIL);
    expect([...attrNames(container.querySelector(".msheet")!)].filter(n => n.startsWith("on"))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  材料 tab 的四种形态
// ══════════════════════════════════════════════════════════════════
describe("<MaterialsTab>", () => {
  it("空态：占位符 + 一个真能点开文件选择器的按钮", () => {
    document.body.innerHTML = `<input type="file" id="picker">`;
    let clicked = 0;
    (document.getElementById("picker") as any).click = () => { clicked++; };
    const { container } = render(<MaterialsTab />);
    expect(container.querySelector(".ph > .ic")!.textContent).toBe("MATERIALS");
    // 「还没有上传材料<br><br>」那两个 <br> 在 JSX 里必须是真元素，
    // 否则界面上会显示出四个尖括号。
    expect(container.querySelectorAll(".ph br")).toHaveLength(2);
    fireEvent.click(container.querySelector("button.act")!);
    expect(clicked).toBe(1);
  });

  it("有材料没选中：chips + 一句「还差什么」", () => {
    G.S.filelist = [{ name: "a.xlsx", state: "parsed", chunks: 3 },
                    { name: "b.pdf", state: "scan_pending" }];
    const { container } = render(<MaterialsTab />);
    expect(container.querySelectorAll(".files > .f")).toHaveLength(2);
    expect(container.querySelector(".cap")!.textContent).toBeTruthy();
  });

  it("选中但还没取回来：读取中", () => {
    G.S.filelist = [{ name: "a.xlsx", state: "parsed", chunks: 3 }];
    G.FILE = "a.xlsx";
    expect(render(<MaterialsTab />).container.textContent).toContain("读取中");
  });

  it("取失败：说清楚，且错误文本是文本", () => {
    G.S.filelist = [{ name: "a.xlsx", state: "parsed", chunks: 1 }];
    G.FILE = "a.xlsx"; G.SRC = { "a.xlsx": { error: EVIL, chunks: [] } };
    const { container } = render(<MaterialsTab />);
    expect(container.querySelector(".fnd")!.textContent).toContain("读取失败");
    expect(container.querySelector("img")).toBeNull();
  });

  it("正常：告警在前、张数行数、再按 sheet 分组", () => {
    G.S.filelist = [{ name: "a.xlsx", state: "parsed", chunks: 2 }];
    G.FILE = "a.xlsx";
    G.SRC = { "a.xlsx": {
      findings: [{ message: "元数据里有作者姓名" }],
      chunks: [{ cite: "a.xlsx!订单!R1", text: "x", locator: { sheet: "订单" } },
               { cite: "a.xlsx!客户!R1", text: "y", locator: { sheet: "客户" } }],
    } };
    const { container } = render(<MaterialsTab />);
    expect(container.querySelector(".fnd")!.textContent).toContain("元数据里有作者姓名");
    expect(container.querySelectorAll(".cap")[0]!.textContent).toBe("2 张表 · 2 行");
    expect(container.querySelectorAll(".msheet")).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════
//  实体 / 冲突 / 流程图 / 产物
// ══════════════════════════════════════════════════════════════════
describe("<EntitiesTab>", () => {
  it("没跑过就是占位符，不是一片空白", () => {
    expect(render(<EntitiesTab />).container.querySelector(".ph > .ic")!.textContent).toBe("ENTITIES");
  });

  it("统计行 + 对象列表 + 属性口径（属性只画前 40 个）", () => {
    G.S.state = { oir: {
      stats: { objects: 2, properties: 41, links: 3 },
      objects: [{ displayName: { value: "订单" }, apiName: { value: "Order" } },
                { displayName: { value: "客户" }, apiName: { value: "Customer" } }],
      properties: Array.from({ length: 41 }, (_, i) =>
        ({ apiName: { value: "p" + i }, definition: { value: "" } })),
    } };
    const { container } = render(<EntitiesTab />);
    expect(container.querySelector(".cap")!.textContent).toBe("2 个对象 · 41 个属性 · 3 条关系");
    expect(container.querySelectorAll(".elist > .e")).toHaveLength(2);
    expect(container.querySelector(".en")!.textContent).toBe("订单");
    expect(container.querySelector(".ec")!.textContent).toBe("Order");
    expect(container.querySelectorAll(".chunk")).toHaveLength(40);
    // 没写口径就说「无口径」，不是留一片空白让人以为漏渲染了
    expect(container.querySelector(".chunk")!.textContent).toContain("（无口径）");
  });

  it("对象名是模型给的，落在文本位置", () => {
    G.S.state = { oir: { stats: {}, objects: [{ displayName: { value: EVIL }, apiName: { value: "X" } }],
      properties: [] } };
    const { container } = render(<EntitiesTab />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".en")!.textContent).toBe(EVIL);
  });
});

describe("<ConflictsTab>", () => {
  const cf = (o: Record<string, unknown> = {}) => ({
    kind: "semantic_divergence", handling: "待确认", summary: "两份材料对「已发货」的口径不同",
    evidence: [{ file_name: "a.xlsx", cite: "a.xlsx!订单!R3" }], ...o,
  });

  it("没有冲突就是占位符", () => {
    expect(render(<ConflictsTab />).container.querySelector(".ph > .ic")!.textContent).toBe("CONFLICTS");
  });

  it("语义分歧那类用警示色描边，其余用普通线", () => {
    G.S.state = { conflicts: [cf(), cf({ kind: "duplicate" })] };
    const { container } = render(<ConflictsTab />);
    const [a, b] = Array.from(container.querySelectorAll(".chunk")) as any[];
    expect(a.style.borderColor).toBe("var(--warn-line)");
    expect(b.style.borderColor).toBe("var(--line)");
  });

  it("证据 chip 最多两条，点它带着**文件名和 cite**回原文", () => {
    G.S.state = { conflicts: [cf({ evidence: [
      { file_name: "a.xlsx", cite: "c1" }, { file_name: "b.xlsx", cite: "c2" }, { file_name: "c.xlsx", cite: "c3" }] })] };
    const { container } = render(<ConflictsTab />);
    const evs = container.querySelectorAll(".ev");
    expect(evs).toHaveLength(2);
    fireEvent.click(evs[0]!);
    expect(openSource).toHaveBeenCalledWith("a.xlsx", "c1");
  });

  it("摘要与 cite 都是自由文本 —— 渲染成字，不长新属性", () => {
    G.S.state = { conflicts: [cf({ summary: EVIL, evidence: [{ file_name: EVIL_JS, cite: EVIL_JS }] })] };
    const { container } = render(<ConflictsTab />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(EVIL);
    expect([...attrNames(container.querySelector(".chunk")!)].filter(n => n.startsWith("on"))).toEqual([]);
    fireEvent.click(container.querySelector(".ev")!);
    expect(openSource).toHaveBeenCalledWith(EVIL_JS, EVIL_JS);
    expect((globalThis as any).__pwned).toBeUndefined();
  });
});

describe("<EvidenceChip>", () => {
  it("不带文件名时传空串 —— 由 openSource 从 cite 的前缀兜底出文件名", () => {
    const { container } = render(<EvidenceChip cite="a.xlsx!订单!R1" />);
    fireEvent.click(container.querySelector(".ev")!);
    expect(openSource).toHaveBeenCalledWith("", "a.xlsx!订单!R1");
  });
});

describe("<FlowTab>", () => {
  const flow = (o: Record<string, unknown> = {}) => ({
    stats: { actions: 4, events: 2, stages: 1, gateways: 1, edges: 5 },
    stages: [{ key: "s1", title: "下单" }],
    nodes: [
      { stage: "s1", kind: "action", grounded: true, code: "A1", label: { value: "提交订单" },
        evidence: [{ cite: "a.xlsx!订单!R2", snippet: "客户点击提交" }] },
      { stage: "s1", kind: "event", grounded: false, label: { value: "订单已创建" } },
    ], ...o,
  });

  it("没跑过就是占位符", () => {
    expect(render(<FlowTab />).container.querySelector(".ph > .ic")!.textContent).toBe("FLOW");
  });

  it("统计 + 证据体检 + 三个下载入口（文件名要 URL 编码）", () => {
    G.S.state = { flow: flow(), artifacts: ["流程图_主干.svg"] };
    const { container } = render(<FlowTab />);
    const caps = container.querySelectorAll(".cap");
    expect(caps[0]!.textContent).toBe("4 个动作 · 2 个事件 · 1 个阶段 · 1 个判断 · 5 条边");
    expect(caps[1]!.textContent).toContain("1/2 个节点有材料依据");
    const links = Array.from(container.querySelectorAll(".acts > a")) as any[];
    expect(links).toHaveLength(3);
    expect(links[0].getAttribute("href")).toBe(
      "/api/sessions/s1/artifacts/" + encodeURIComponent("流程图.svg"));
    expect(links[2].hasAttribute("download")).toBe(true);
  });

  it("没有主干图就不出那个入口", () => {
    G.S.state = { flow: flow(), artifacts: [] };
    expect(render(<FlowTab />).container.querySelectorAll(".acts > a")).toHaveLength(2);
  });

  it("推断出来的边要说出来（虚线，需确认）", () => {
    G.S.state = { flow: flow({ stats: { edges: 5, inferred_edges: 2 } }), artifacts: [] };
    expect(render(<FlowTab />).container.querySelectorAll(".cap")[1]!.textContent)
      .toContain("2 条边是推断的");
  });

  it("没出处的节点带 guess 类，点它说「这是推断的」而不是假装有依据", () => {
    G.S.state = { flow: flow(), artifacts: [] };
    const { container } = render(<FlowTab />);
    const nodes = container.querySelectorAll(".fnode");
    expect(nodes[0]!.className).toBe("fnode action");
    expect(nodes[1]!.className).toBe("fnode event guess");
    expect(container.querySelector("#fcite.fcitebox")!.innerHTML).toBe("");
    fireEvent.click(nodes[1]!);
    expect(container.querySelector(".fcite > .fcw")!.textContent).toContain("材料里没有直接依据");
  });

  it("有出处的节点点出证据，再点它就能回原文", () => {
    G.S.state = { flow: flow(), artifacts: [] };
    const { container } = render(<FlowTab />);
    fireEvent.click(container.querySelectorAll(".fnode")[0]!);
    expect(container.querySelector(".fcite > b")!.textContent).toBe("提交订单");
    expect(container.querySelector(".fccode")!.textContent).toBe("A1");
    expect(container.querySelector(".fcsnip")!.textContent).toBe("客户点击提交");
    fireEvent.click(container.querySelector(".fcite .ev")!);
    expect(openSource).toHaveBeenCalledWith("", "a.xlsx!订单!R2");
  });

  it("节点标签是模型给的自由文本", () => {
    G.S.state = { flow: flow({ nodes: [{ stage: "s1", kind: "action", grounded: false, label: { value: EVIL } }] }),
      artifacts: [] };
    const { container } = render(<FlowTab />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".fnode")!.textContent).toBe(EVIL);
    expect([...attrNames(container.querySelector(".chunk")!)].filter(n => n.startsWith("on"))).toEqual([]);
  });
});

describe("<ArtifactRows>", () => {
  it("没有产物就是占位符", () => {
    expect(render(<ArtifactRows />).container.querySelector(".ph > .ic")!.textContent).toBe("ARTIFACTS");
  });

  it("每份产物一行下载，中文名要 URL 编码", () => {
    G.S.state = { artifacts: ["填写模板.xlsx"] };
    const { container } = render(<ArtifactRows />);
    expect(container.querySelector(".chunk > .c")!.textContent).toBe("填写模板.xlsx");
    expect(container.querySelector("a.act")!.getAttribute("href"))
      .toBe("/api/sessions/s1/artifacts/" + encodeURIComponent("填写模板.xlsx"));
  });
});

// ══════════════════════════════════════════════════════════════════
//  推理 tab（react/think.tsx）
// ══════════════════════════════════════════════════════════════════
describe("<TraceRow> / <TraceGroups>", () => {
  it("一步的三块：序号 / 思考 / 工具调用 / 观察，缺哪块就不画哪块", () => {
    const { container } = render(
      <TraceRow x={{ n: 2, thought: "先看订单表", tool: "read", args: { f: "a.xlsx" }, observation: "12 行" }} />);
    expect(container.querySelector(".trw > .trn")!.textContent).toBe("2");
    expect(container.querySelector(".trb > .trt")!.textContent).toBe("先看订单表");
    expect(container.querySelector(".trc > code")!.textContent).toBe("read");
    expect(container.querySelector(".trc")!.textContent).toContain(`{"f":"a.xlsx"}`);
    expect(container.querySelector(".tro")!.textContent).toBe("12 行");
    cleanup();
    const bare = render(<TraceRow x={{ thought: "只想了想" }} />).container;
    expect(bare.querySelector(".trn")!.textContent).toBe("·");   // 没序号也占那一格
    expect(bare.querySelector(".trc")).toBeNull();
    expect(bare.querySelector(".tro")).toBeNull();
  });

  it("**思考文字不截断** —— 截断的思考和没有思考一样不可核对", () => {
    const long = "想".repeat(900);
    expect(render(<TraceRow x={{ n: 1, thought: long }} />).container.querySelector(".trt")!.textContent)
      .toHaveLength(900);
  });

  it("按轮次分组，最新的一轮在最上面且不带「· 」前缀", () => {
    G.TRACE = [
      { turn: 1, q: "第一问", n: 2, thought: "b" }, { turn: 1, q: "第一问", n: 1, thought: "a" },
      { turn: 2, q: "第二问", n: 1, thought: "c" },
    ];
    const { container } = render(<TraceGroups />);
    const groups = container.querySelectorAll(".tgrp");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector(".tgq")!.textContent).toBe("第二问");
    expect(groups[1]!.querySelector(".tgq")!.textContent).toBe("· 第一问");
    // 同一轮里按步号排，不按到达顺序 —— SSE 补发的步骤会乱序到
    expect(Array.from(groups[1]!.querySelectorAll(".trt") as any[]).map((x: any) => x.textContent))
      .toEqual(["a", "b"]);
  });

  it("问题正文是用户打的字，落在文本位置", () => {
    G.TRACE = [{ turn: 1, q: EVIL, n: 1, thought: EVIL }];
    const { container } = render(<TraceGroups />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".tgq")!.textContent).toBe(EVIL);
  });
});

describe("<OpsLog>", () => {
  it("倒序，最新的在最上面；标签带 tag 类（失败要一眼看得出来）", () => {
    G.OPS = [
      { seq: 1, kind: "corpus.ready", ts: 1700000000, label: "读完材料", detail: "文件 2", tag: "ok" },
      { seq: 2, kind: "persist.failed", ts: 1700000060, label: "落库失败", detail: "落库炸了", tag: "err" },
    ];
    const { container } = render(<OpsLog />);
    expect(container.querySelector(".tgrp.opgrp > .tgq")!.textContent).toBe("操作记录 · 2 条");
    const rows = container.querySelectorAll(".oprow");
    expect(rows[0]!.querySelector(".tag")!.className).toBe("tag err");
    expect(rows[0]!.querySelector(".opd")!.textContent).toBe("落库炸了");
    expect(rows[0]!.querySelector(".opt")!.textContent).toBeTruthy();
    expect(rows[1]!.querySelector(".tag")!.textContent).toBe("读完材料");
  });

  it("一条都没有就整块不画", () => {
    G.OPS = [];
    expect(render(<OpsLog />).container.innerHTML).toBe("");
  });
});

describe("<ThinkTab>", () => {
  it("两条轨迹都空时给占位符 —— 但工作流条照画（那正是最该看见它的时候）", () => {
    G.TRACE = []; G.OPS = [];
    G.S.state = { engagement: { frozen: true, version: "v3", plan: [{ id: "INTAKE", state: "done" }] } };
    const { container } = render(<ThinkTab />);
    expect(container.querySelector(".eng")).not.toBeNull();
    expect(container.querySelector(".ph > .ic")!.textContent).toBe("REASONING");
  });

  it("有轨迹时：工作流条 + 推理分组 + 操作记录，次序不变", () => {
    G.S.state = { engagement: { frozen: false, version: "v1", plan: [{ id: "INTAKE" }] } };
    G.TRACE = [{ turn: 1, q: "问一句", n: 1, thought: "想一想" }];
    G.OPS = [{ seq: 1, kind: "run.completed", ts: 1700000000, label: "梳理结束", detail: "", tag: "ok" }];
    const { container } = render(<ThinkTab />);
    expect(container.querySelector(".ph")).toBeNull();
    const blocks = Array.from(container.children as any).map((x: any) => x.className);
    expect(blocks).toEqual(["eng", "tgrp", "tgrp opgrp"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  右栏整块 —— #pbody 归 React 了
// ══════════════════════════════════════════════════════════════════
describe("<PreviewBody>", () => {
  it("没会话时是 PREVIEW 占位符", () => {
    G.S = null;
    expect(render(<PreviewBody />).container.querySelector(".ph > .ic")!.textContent).toBe("PREVIEW");
  });

  it("四个 tab 各画各的", () => {
    for (const [tab, ic] of [["mat", "MATERIALS"], ["ent", "ENTITIES"], ["cf", "CONFLICTS"], ["flow", "FLOW"]]) {
      G.TAB = tab!;
      const { container } = render(<PreviewBody />);
      expect(container.querySelector(".ph > .ic")!.textContent, tab).toBe(ic);
      cleanup();
    }
  });

  it("别的 track 把自己那个 tab 登记进 PREVIEW_TABS 就接上了（不用改这个文件）", () => {
    G.TAB = "q";
    const real = PREVIEW_TABS["q"]!;              // 真的那个（<QuestionWorkbench>）先收好
    PREVIEW_TABS["q"] = () => <div className="qwb">工作台</div>;
    try {
      expect(render(<PreviewBody />).container.querySelector(".qwb")).not.toBeNull();
    } finally { PREVIEW_TABS["q"] = real; }
  });

  it("**七个页签都有主人** —— 少登记一个就是一整块空白屏幕，而且不报错", () => {
    expect(Object.keys(PREVIEW_TABS).sort())
      .toEqual(["art", "cf", "ent", "flow", "mat", "q", "think"]);
    expect(PREVIEW_TABS["q"]).toBe(QuestionWorkbench);
    expect(PREVIEW_TABS["art"]).toBe(ArtifactsTab);
    expect(PREVIEW_TABS["think"]).toBe(ThinkTab);
  });

  it("q / art / think 三个 tab 现在都画得出东西（旧 paint() 已经不写 #pbody 了）", () => {
    G.Q_BACKLOG = []; G.Q_NEXT = []; G.Q_API = true; G.Q_FILTER = "all"; G.Q_LIMIT = 40;
    G.RETURN_AUDIT = null; G.RETURN_BUSY = false; G.TRACE = []; G.OPS = [];
    for (const [tab, probe] of [["q", ".qwbhead"], ["art", ".ph > .ic"], ["think", ".ph > .ic"]]) {
      G.TAB = tab!;
      const { container } = render(<PreviewBody />);
      expect(container.innerHTML, tab).not.toBe("");
      expect(container.querySelector(probe!), tab).not.toBeNull();
      cleanup();
    }
  });

  it("#pbody 这个容器登记的就是 <PreviewBody>，而且只有它一个主人", () => {
    const mine = registeredRegions().filter(r => r.id === "pbody");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.Component).toBe(PreviewBody);
  });

  it("认不出的 tab 画空 —— 不假装用户点的是「材料」", () => {
    G.TAB = "从没见过的页签";
    expect(render(<PreviewBody />).container.innerHTML).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  上传那条路上的两个视图
// ══════════════════════════════════════════════════════════════════
describe("<ModelOptions>", () => {
  it("第一项是「自动」，带视觉的缀一个 👁", () => {
    G.MODELS = [{ name: "gpt-4o", capabilities: ["vision"] }, { name: "text-only" }];
    const { container } = render(<select><ModelOptions hostId="nope" /></select>);
    const opts = Array.from(container.querySelectorAll("option")) as any[];
    expect(opts).toHaveLength(3);
    expect(opts[0].value).toBe("");
    expect(opts[1].textContent).toBe("gpt-4o 👁");
    expect(opts[2].textContent).toBe("text-only");
  });

  it("当前模型被选中（宿主 select 住在冻结的 index.html 里，值只能命令式收口）", () => {
    G.MODELS = [{ name: "a" }, { name: "b" }];
    G.S.model = "b";
    document.body.innerHTML = `<select id="modelsel"></select>`;
    const host = document.getElementById("modelsel") as any;
    render(<ModelOptions />, { container: host });
    expect(host.value).toBe("b");
  });

  it("模型名是网关给的，落在文本与属性位置都不越界", () => {
    G.MODELS = [{ name: EVIL }];
    const { container } = render(<select><ModelOptions hostId="nope" /></select>);
    expect(container.querySelector("img")).toBeNull();
    const opt = container.querySelectorAll("option")[1] as any;
    expect(opt.textContent).toBe(EVIL);
    expect(opt.value).toBe(EVIL);
  });
});

describe("<StartBuildButton>", () => {
  it("点一下就开跑 —— 不再套一层「确定要开始吗」（点按钮本身就是确认）", () => {
    const { container } = render(<StartBuildButton />);
    expect(container.querySelector("button.sug")!.textContent).toBe("开始梳理");
    fireEvent.click(container.querySelector("button")!);
    expect(startBuild).toHaveBeenCalledWith(undefined);
  });
});

describe("<Placeholder>", () => {
  it("结构是 .ph > .ic + 说明文字", () => {
    const { container } = render(<Placeholder ic="X">说明</Placeholder>);
    expect(container.querySelector(".ph > .ic")!.textContent).toBe("X");
    expect(container.querySelector(".ph")!.textContent).toBe("X说明");
  });
});
