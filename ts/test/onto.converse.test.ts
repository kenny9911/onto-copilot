/**
 * `onto/converse` + `onto/engagement` + `onto/engagement_runtime` 的 golden 校验。
 *
 * 期望值全部来自 `golden/onto.converse.json`（`tools/golden/onto_converse.py`
 * 导出，字节确定，重跑两次 shasum 一致）。**没有一个手写的期望值** —— 手写的是
 * 我对 Python 行为的猜测，golden 是它的事实。
 *
 * 重心放在三处最容易悄悄退化的地方：
 *
 * 1. **分流与溯源**（`needsReasoning` / `checkGrounding`）。这两个函数一松，
 *    要么所有问题都掉回"我没把握理解"，要么模型编的出处混进回答。
 * 2. **推理循环的轨迹**。`steps` / `on_step` 的每一条都会显示在推理面板上，
 *    少发一条 = 用户看不见它想了什么 = 编造和推理无从分辨。所以这里比对的是
 *    **整条轨迹**，不是"跑通了没有"。
 * 3. **engagement 的冻结拓扑与门禁指标**。REVIEW / EXPORT 交出去的
 *    `blocker_count` / `schema_valid` / `downloadable` 直接喂给 GateSpec ——
 *    这几个数错一个，没通过审查的包就发出去了。
 *
 * 另外钉住三处 Python/JS 语义分叉（都在 golden 里有对应向量）：
 *
 * · 工具返回渲染成提示词时走 `json.dumps` 的**默认分隔符**（`", "` / `": "`），
 *   不是 `JSON.stringify` 的紧凑形态；
 * · `_evidence_ids` 的兜底串里 locator 是 **Python 的 dict repr**
 *   （`口述.txt#{'kind': 'raw', 'ref': 'x'}`），不是 JSON；
 * · `round(x, n)` 是 half-**even**（`confidence` 2 位、`usd` 4 位）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { AgentBus } from "../src/kernel/bus/bus.js";
import { CriticPanel, findingToDict, makeCriticContext } from "../src/kernel/critic.js";
import { EventKind } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { ModelGateway, ScriptedBackend, stubRouting } from "../src/kernel/llm.js";
import { AgentLoop } from "../src/kernel/loop.js";
import { ContextManager } from "../src/kernel/memory/context.js";
import { Scratchpad } from "../src/kernel/memory/short_term.js";
import { Recorder } from "../src/kernel/recorder.js";
import { RunStatus, Scheduler } from "../src/kernel/scheduler.js";
import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import {
  ANSWER_SCHEMA,
  CHAT_SYSTEM,
  ConversationAgent,
  type ConverseCompletion,
  ConverseTurn,
  PLAN_SCHEMA,
  STEP_SCHEMA,
  STRATEGY_LABEL,
  STRATEGY_LABEL_EN,
  SYSTEM,
  checkGrounding,
  guardCanvasCompletion,
  needsReasoning,
  parseArgs,
  pickStrategy,
  strategyLabel,
} from "../src/onto/converse.js";
import { FDE_ENGAGEMENT_AGENTS, buildFdeEngagementDag } from "../src/onto/engagement.js";
import {
  CanonicalizeHandler,
  ContractCritic,
  EXPECTED_ARTIFACTS,
  EngagementProvenanceCritic,
  EngagementRuntimeInput,
  ExportHandler,
  classification,
  edgeKind,
  engagementCritics,
  engagementHandlers,
  oirStats,
  traceability,
} from "../src/onto/engagement_runtime.js";
import { Question, QuestionBacklog, QuestionStatus } from "../src/onto/questions.js";

type Dict = Record<string, unknown>;

/** 五个确定性投影 handler 共有的那一个方法（`StaticProjection` 是模块私有的）。 */
interface Projection {
  project(inputs: Dict): Dict;
}

const G = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "onto.converse.json"), "utf8"),
) as {
  converse: Dict;
  converse_runs: Dict[];
  engagement: Dict;
  engagement_runtime: Dict;
};

const C = G.converse;
const ER = G.engagement_runtime;
const FIXTURE = ER["fixture"] as Dict;

// ══════════════════════════════════════════════════════════════════
//  测试替身
// ══════════════════════════════════════════════════════════════════
/** Python 的 `RuntimeError` —— `type(exc).__name__` 会原样进 answer 文案，
 *  所以类名必须叫这个，不能用裸 Error。 */
class RuntimeError_ extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
    Object.setPrototypeOf(this, RuntimeError_.prototype);
  }
}
Object.defineProperty(RuntimeError_, "name", { value: "RuntimeError" });

class Comp implements ConverseCompletion {
  readonly data: unknown;
  readonly text = "";
  readonly usd: number;
  constructor(data: unknown, usd: number) {
    this.data = data;
    this.usd = usd;
  }
}

/** 按脚本回放的网关，同时记录每次调用的 prompt 与 key —— 与导出脚本里那个一一对应。 */
class ScriptGateway {
  private readonly script: unknown[];
  readonly calls: { nodeId: string; prompt: string; key: string | undefined; required: unknown }[] =
    [];

  constructor(script: readonly unknown[]) {
    this.script = [...script];
  }

  call(
    nodeId: string,
    prompt: string,
    opts: { schema?: Dict; key?: string },
  ): Promise<ConverseCompletion> {
    this.calls.push({
      nodeId,
      prompt,
      key: opts.key,
      required: (opts.schema ?? {})["required"] ?? null,
    });
    const data = this.script.length > 0 ? this.script.shift() : { answer: "没有更多了", citations: [], confidence: 0.1 };
    if (data instanceof Error) return Promise.reject(data);
    return Promise.resolve(new Comp(data, 0.001));
  }
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.fn(
    {
      name: "evidence.search",
      description: "检索材料",
      schema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      danger: Danger.READ,
      scopes: ["readonly"],
    },
    (args) => ({
      chunks: [{ cite: "梳理表.xlsx!实体!R2-2", text: `命中 ${String(args["query"])}` }],
    }),
  );
  reg.fn(
    {
      name: "oir.query",
      description: "查中间表示",
      schema: {
        type: "object",
        required: ["kind"],
        properties: { kind: { type: "string" } },
      },
      danger: Danger.READ,
      scopes: ["readonly"],
    },
    (args) => {
      throw new RuntimeError_(`故意炸给模型看：${String(args["kind"])}`);
    },
  );
  return reg;
}

function ctx(): Dict {
  return { turnId: "t1", approved: true, rec: null, pending: [] };
}

// ══════════════════════════════════════════════════════════════════
//  converse —— 契约本体
// ══════════════════════════════════════════════════════════════════
describe("converse / 产出契约", () => {
  it("三个 schema 与 Python 字段一致；用户文案与并行批是 TS 产品层覆盖", () => {
    const pyAnswer = C["answer_schema"] as Dict;
    const pyAnswerProps = pyAnswer["properties"] as Dict;
    const answerProps = ANSWER_SCHEMA["properties"] as Dict;
    expect({
      ...ANSWER_SCHEMA,
      properties: {
        ...answerProps,
        answer: {
          ...(answerProps["answer"] as Dict),
          description: (pyAnswerProps["answer"] as Dict)["description"],
        },
        next_questions: {
          ...(answerProps["next_questions"] as Dict),
          description: (pyAnswerProps["next_questions"] as Dict)["description"],
        },
        // TS 对话网关额外把 0..1 做成结构校验；Python golden 只写在 description 里。
        confidence: {
          ...(answerProps["confidence"] as Dict),
          minimum: undefined,
          maximum: undefined,
        },
      },
    }).toEqual(pyAnswer);
    expect(PLAN_SCHEMA).toEqual(C["plan_schema"]);

    // `tools` 是 TS 侧新增的只读并行批，Python 那边没有这条路。照本文件已有的
    // 先例（见下面 SYSTEM 那条）：新增能力不再与旧 Python 逐字节相等，
    // **但除它以外必须仍然逐字段一致** —— 把它摘掉再比，漂移照样拦得住。
    const { tools, tool, ...rest } = STEP_SCHEMA["properties"] as Dict;
    const pyStep = C["step_schema"] as Dict;
    const { tool: pyToolField, ...pyRest } = pyStep["properties"] as Dict;
    const normalizedRest = {
      ...rest,
      answer: {
        ...(rest["answer"] as Dict),
        description: (pyRest["answer"] as Dict)["description"],
      },
      next_questions: {
        ...(rest["next_questions"] as Dict),
        description: (pyRest["next_questions"] as Dict)["description"],
      },
    };
    expect({ ...STEP_SCHEMA, properties: normalizedRest }).toEqual({ ...pyStep, properties: pyRest });
    expect(tools).toBeDefined();
    // `tool` 的描述也跟着并行批改了一句 —— 它是同一个能力的另一半（模型得知道
    // 什么时候该改用 tools）。所以这里**不放过它，只是分开比**：Python 那句必须
    // 一字不差地还在，新增的部分必须确实是在指路 tools。除此以外的任何改动照样红。
    const pyDesc = String((pyToolField as Dict)["description"]);
    const nowDesc = String((tool as Dict)["description"]);
    expect(nowDesc.startsWith(pyDesc)).toBe(true);
    expect(nowDesc.slice(pyDesc.length)).toBe("；一次要查多样时改用 tools");
    expect({ ...(tool as Dict), description: pyDesc }).toEqual(pyToolField);
    expect(String((answerProps["answer"] as Dict)["description"])).toContain("日常中文");
    expect(String((answerProps["answer"] as Dict)["description"])).toContain("不得展示 q.agent");
    expect(String((answerProps["next_questions"] as Dict)["description"])).toContain("不超过 28 个字");
  });

  it("并行批的安全边界写在 schema 里，不靠模型自觉", () => {
    const batch = (STEP_SCHEMA["properties"] as Dict)["tools"] as Dict;
    expect(batch["type"]).toBe("array");
    // 一次最多 4 个：再多就不是"顺手一起查"，而是在拿并行当计划用
    expect(batch["maxItems"]).toBe(4);
    const desc = String(batch["description"]);
    expect(desc).toContain("只读");
    expect(desc).toContain("退回串行");
    // 依赖关系也要说清 —— 后一步要用前一步结果时不能并行
    expect(desc).toContain("后一步要用前一步结果");
  });

  it("两个 schema 都要有 next_questions —— 只加最终 schema 的话最常见的一步就答上来拿不到", () => {
    for (const schema of [ANSWER_SCHEMA, STEP_SCHEMA]) {
      const props = schema["properties"] as Dict;
      const field = props["next_questions"] as Dict;
      expect(field["type"]).toBe("array");
      expect(field["maxItems"]).toBe(3);
    }
  });

  it("系统提示保留 FDE 基线，并显式约束无材料通用草案的来源边界", () => {
    // 通用草案是 TS 产品新增能力，故不再与旧 Python 文案逐字节相等；其它 schema
    // 仍走 golden。这里钉住新增能力最容易退化、也最危险的四条语义。
    expect(SYSTEM).toContain("面对的是一位 FDE 工程师");
    expect(SYSTEM).toContain("draft.initialize");
    expect(SYSTEM).toContain("`basis` 设为 `generic_assumption`");
    expect(SYSTEM).toContain("发布状态只能是 DRAFT");
    expect(SYSTEM).toContain("不要给假设编 cite");
    expect(CHAT_SYSTEM).toContain("通用的 AI 助手");
    expect(CHAT_SYSTEM).toContain("web.search");
    expect(SYSTEM).toContain("`scope=global`");
    expect(SYSTEM).toContain("改写成简洁英文查询");
    expect(SYSTEM).toContain("不代表搜索提供商就是 Google");
    expect(SYSTEM).toContain("图片/生图/Image 2/视觉版/PPT/好看");
    expect(SYSTEM).toContain("先 `flow.sketch`、再 `flow.render`");
    expect(SYSTEM).toContain("为了生图不得先");
    expect(SYSTEM).toContain("`theme` / `layout` / `visual_brief`");
    expect(SYSTEM).toContain("不得在同一轮用相同参数重复调用 `flow.render`");
    expect(SYSTEM).toContain("surface=chat_card+reference_canvas");
    expect(SYSTEM).toContain("reference_canvas_visible=true");
    expect(CHAT_SYSTEM).toContain("`scope=regional`");
    expect(CHAT_SYSTEM).toContain("不能凭记忆伪造网页或 URL");
  });

  it("canvas_updated=false 时会删掉‘右侧画布已更新’的虚假完成声明", () => {
    const lie = "我已经根据行业经验生成参考图，该图已经呈现在您屏幕右侧的画布上。";
    const guarded = guardCanvasCompletion(lie, [{
      tool: "flow.sketch",
      observation: '{"surface": "chat_card", "canvas_updated": false}',
    }]);

    expect(guarded).not.toContain("已经呈现在您屏幕右侧的画布");
    expect(guarded).toContain("参考图已显示在聊天主线");
    expect(guarded).toContain("右侧工作流画布尚未更新");
  });

  it("参考只读层可见时，完成声明会区分参考层与正式画布", () => {
    const lie = "流程图已经呈现在右侧工作流画布。";
    const guarded = guardCanvasCompletion(lie, [{
      tool: "flow.sketch",
      observation:
        '{"surface":"chat_card+reference_canvas","reference_canvas_visible":true,"canvas_updated":false}',
    }]);

    expect(guarded).toContain("右侧“通用参考”只读层");
    expect(guarded).toContain("正式工作流画布尚未更新");
  });

  it("同一轮真有 formal flow 写入回执时，不误杀右侧画布完成声明", () => {
    const answer = "参考图已经转正，右侧工作流画布已更新。";
    const guarded = guardCanvasCompletion(answer, [
      { tool: "flow.sketch", observation: '{"canvas_updated": false}' },
      { tool: "draft.adopt", observation: '{"canvas_updated": true}' },
    ]);
    expect(guarded).toBe(answer);
  });

  it("lang=en 只追加一行输出语言指令，领域术语不动", () => {
    const en = new ConversationAgent({
      gateway: null as never,
      tools: registry(),
      lang: "en",
    });
    expect(en.system).toBe(
      SYSTEM +
        "\n\n[Output language] Reply to the user in English. " +
        "Keep extracted domain terms (entity names, calibers, " +
        "field names) in their original language.",
    );
    const overridden = new ConversationAgent({
      gateway: null as never,
      tools: registry(),
      lang: "en",
      system: "自定义",
    });
    expect(overridden.system).toBe(C["system_override_en"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  converse —— 分流
// ══════════════════════════════════════════════════════════════════
describe("converse / 分流", () => {
  it("needsReasoning 在全部 14 个意图 × 7 句话上与 Python 一致", () => {
    const rows = C["needs_reasoning"] as [string, string, boolean][];
    expect(rows.length).toBeGreaterThan(80);
    for (const [intent, text, want] of rows) {
      expect(needsReasoning({ intent }, text), `${intent} / ${text}`).toBe(want);
    }
  });

  it("判不出意图 ≠ 该反问：unknown 一律去查", () => {
    const rows = (C["needs_reasoning"] as [string, string, boolean][]).filter(
      ([i]) => i === "unknown",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const [, , want] of rows) expect(want).toBe(true);
  });

  it("pickStrategy 的判据是路径可不可枚举，纯规则零模型调用", () => {
    for (const [text, hasTools, want] of C["pick_strategy"] as [string, boolean, string][]) {
      expect(pickStrategy(text, { hasTools }), `${text} / ${String(hasTools)}`).toBe(want);
    }
  });

  it("strategyLabel 跟着界面语言走，认不出的策略名原样回显", () => {
    expect(STRATEGY_LABEL).toEqual(C["strategy_label_zh"]);
    expect(STRATEGY_LABEL_EN).toEqual(C["strategy_label_en"]);
    for (const [s, lang, want] of C["strategy_label"] as [string, string, string][]) {
      expect(strategyLabel(s, lang), `${s}/${lang}`).toBe(want);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  converse —— 溯源校验
// ══════════════════════════════════════════════════════════════════
describe("converse / 溯源校验", () => {
  it("checkGrounding 的 12 组向量逐条一致（含 strip、空答案、非 dict）", () => {
    for (const row of C["check_grounding"] as {
      answer: unknown;
      observed: string[];
      findings: Dict[];
    }[]) {
      expect(
        checkGrounding(row.answer, row.observed).map(findingToDict),
        JSON.stringify(row.answer),
      ).toEqual(row.findings);
    }
  });

  it("编出处一定被抓（HIGH），真出处一定放行", () => {
    const rows = C["check_grounding"] as { findings: Dict[] }[];
    expect(rows.some((r) => r.findings.some((f) => f["code"] === "CITATION_FABRICATED"))).toBe(true);
    expect(rows.some((r) => r.findings.some((f) => f["code"] === "CITATION_MISSING"))).toBe(true);
    expect(rows.some((r) => r.findings.length === 0)).toBe(true);
  });

  it("parseArgs：坏 JSON 与非对象一律回空字典，不抛", () => {
    for (const [raw, want] of C["parse_args"] as [unknown, Dict][]) {
      expect(parseArgs(raw), JSON.stringify(raw)).toEqual(want);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  converse —— ConverseTurn
// ══════════════════════════════════════════════════════════════════
describe("converse / ConverseTurn", () => {
  it("toDict 的取整是 Python 的 half-even（confidence 2 位、usd 4 位）", () => {
    const want = C["turn_to_dict"] as Dict[];

    const t1 = new ConverseTurn("问");
    t1.answer = "答";
    t1.citations = ["a"];
    t1.confidence = 0.123456;
    t1.usd = 0.000123456;
    t1.nextQuestions = ["x"];
    t1.steps = [{ n: 1 }];
    t1.strategy = "react";
    expect(t1.toDict()).toEqual(want[0]);

    const t2 = new ConverseTurn("问2");
    t2.findings = checkGrounding(
      { answer: "有", citations: ["假的"], confidence: 0.9 },
      (C["check_grounding"] as { observed: string[] }[])[0]!.observed,
    );
    t2.confidence = 0.005;
    t2.usd = 0.00005;
    expect(t2.toDict()).toEqual(want[1]);
    // 有 HIGH finding 就不算 grounded —— 这条判据决定要不要删掉那几条出处
    expect(t2.grounded).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  converse —— 提示词拼装
// ══════════════════════════════════════════════════════════════════
describe("converse / 提示词", () => {
  const agent = new ConversationAgent({ gateway: null as never, tools: registry() });
  const specs = registry().forScope("readonly");

  it("_prompt 的六种组合逐字节一致（transcript 只带最近 4 条）", () => {
    for (const row of C["prompt"] as {
      context: string;
      transcript: string[];
      final: boolean;
      out: string;
    }[]) {
      const plainLanguageSuffix = row.final
        ? "先用一句常用中文说结论，再给必要细节；删掉内部 ID、协议标签、未解释的英文缩写和顾问腔。"
        : "";
      expect(agent.prompt("问句", row.context, row.transcript, specs, row.final))
        .toBe(row.out + plainLanguageSuffix);
    }
  });

  it("_plan_prompt 逐字节一致", () => {
    for (const row of C["plan_prompt"] as { context: string; out: string }[]) {
      expect(agent.planPrompt("做事", row.context, specs)).toBe(row.out);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  converse —— 推理循环（整条轨迹比对）
// ══════════════════════════════════════════════════════════════════
describe("converse / 推理循环", () => {
  for (const run of G.converse_runs) {
    const name = run["name"] as string;
    it(`${name}：turn / on_step / 网关调用序列三者都与 Python 一致`, async () => {
      const gw = new ScriptGateway(SCRIPTS[name] ?? []);
      const reg = NO_TOOL_RUNS.has(name) ? new ToolRegistry() : registry();
      const seen: Dict[] = [];
      const agent = new ConversationAgent({
        gateway: gw,
        tools: reg,
        ...(AGENT_OPTS[name] ?? {}),
      });
      const turn = await agent.run(run["text"] as string, {
        ctx: ctx(),
        onStep: (rec) => seen.push(rec),
      });
      // TS 产品层比旧 Python golden 更严格：一旦发现伪造出处，不再保留“结论请自行
      // 复核”的原草稿。轨迹与 finding 仍逐字段对齐，只覆盖这个安全收口结果。
      const expectedTurn = name === "fabricated_citation_stripped"
        ? {
            ...(run["turn"] as Dict),
            answer: "这次回答有出处没有通过核对。为避免把没有依据的内容当成事实，我先不发布这份结论。请让我重新检索后再答。",
            citations: [],
            confidence: 0,
          }
        : run["turn"];
      expect(turn.toDict()).toEqual(expectedTurn);
      expect(seen).toEqual(run["steps_seen"]);
      expect(
        gw.calls.map((c) => ({ node_id: c.nodeId, key: c.key ?? null, schema_required: c.required })),
      ).toEqual(run["gw_calls"]);
      // 提示词也钉住：它是模型真正看到的东西，改一个字就是换了一个产品
      expect(gw.calls.map((c) => c.prompt)).toEqual(
        (run["prompts"] as string[]).map((prompt) => prompt.endsWith(
          "现在给出回答。**出处只能写你上面真的查到过的**，一条都没查到就给空数组、并在回答里说明你没查到。",
        )
          ? prompt + "先用一句常用中文说结论，再给必要细节；删掉内部 ID、协议标签、未解释的英文缩写和顾问腔。"
          : prompt),
      );
    });
  }

  it("步数预算真的封顶 —— 转不出来就如实说，不让人干等", () => {
    const run = G.converse_runs.find((r) => r["name"] === "step_budget")!;
    expect((run["gw_calls"] as unknown[]).length).toBe(3);
    const steps = (run["turn"] as Dict)["steps"] as Dict[];
    expect(steps.at(-1)!["kind"]).toBe("answer");
  });

  it("计划中的写入未调用或只收到失败回执时，不能被最终回答冒充为已完成", async () => {
    const reg = new ToolRegistry();
    reg.fn({
      name: "oir.edit", description: "编辑规则", schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL, scopes: ["converse"],
    }, () => ({ error: "目标不存在", 改动: "无" }));
    reg.fn({
      name: "flow.edit", description: "编辑流程", schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL, scopes: ["converse"],
    }, () => ({ 已改: "流程" }));
    const gw = new ScriptGateway([
      { steps: [
        { goal: "把退款阈值参数化", tool: "oir.edit" },
        { goal: "删除旧动作并新增失败终态", tool: "flow.edit" },
      ] },
      { kind: "tool", thought: "先改规则", tool: "oir.edit", args_json: "{}" },
      { kind: "answer", thought: "全部完成", answer: "两项都已经完成。", citations: [], confidence: 1 },
    ]);
    const agent = new ConversationAgent({
      gateway: gw,
      tools: reg,
      scope: "converse",
      strategy: "plan_execute",
      maxSteps: 2,
    });

    const turn = await agent.run("改规则并改流程", { ctx: ctx() });

    expect(turn.answer).toContain("尚未落地");
    expect(turn.answer).toContain("把退款阈值参数化");
    expect(turn.answer).toContain("删除旧动作并新增失败终态");
  });

  it("复合写入的持久化回执是最终权威状态，模型总结说反了也看得见真结果", async () => {
    const reg = new ToolRegistry();
    reg.fn({
      name: "flow.edit", description: "编辑流程", schema: {
        type: "object", properties: { op: { type: "string" } },
      },
      danger: Danger.WRITE_LOCAL, scopes: ["converse"],
    }, (args) => args["op"] === "remove"
      ? { 已改: "删掉了节点「旧动作」及其相连的 1 条边。", 当前: { actions: 5 } }
      : { 已改: "新增了事件「退款失败」，并连到「退款及金额分摊」。", 当前: { events: 3 } });
    const gw = new ScriptGateway([
      { kind: "tool", thought: "先删除", tool: "flow.edit", args_json: '{"op":"remove"}' },
      { kind: "tool", thought: "再新增", tool: "flow.edit", args_json: '{"op":"add"}' },
      {
        kind: "answer", thought: "总结", answer: "旧动作不存在，所以没有删除。",
        citations: [], confidence: 1,
      },
    ]);
    const agent = new ConversationAgent({
      gateway: gw, tools: reg, scope: "converse", strategy: "react", maxSteps: 3,
    });

    const turn = await agent.run("删除旧动作并新增退款失败事件", { ctx: ctx() });

    expect(turn.answer).toContain("系统核对的实际写入回执");
    expect(turn.answer).toContain("删掉了节点「旧动作」及其相连的 1 条边。");
    expect(turn.answer).toContain("新增了事件「退款失败」，并连到「退款及金额分摊」。");
    expect(turn.answer).toContain("若与上文表述冲突，请以此清单为准");
    expect(turn.answer).not.toContain("flow.edit");
  });

  it("收尾步永远在轨迹里 —— 一步就答上来的问题也看得见它想了什么", () => {
    for (const run of G.converse_runs) {
      const steps = (run["turn"] as Dict)["steps"] as Dict[];
      if (steps.length === 0) continue; // 网关直接炸的那两条没有步骤
      expect(steps.at(-1)!["kind"], run["name"] as string).toBe("answer");
    }
  });
});

/** 每条 run 的脚本 —— 与 `tools/golden/onto_converse.py::_converse_runs` 一一对应。 */
const SCRIPTS: Record<string, unknown[]> = {
  tool_then_answer: [
    {
      kind: "tool",
      thought: "先查材料",
      tool: "evidence.search",
      args_json: '{"query":"采购计划"}',
    },
    {
      kind: "answer",
      thought: "查到了就答",
      answer: "查到了",
      citations: ["梳理表.xlsx!实体!R2-2"],
      confidence: 0.9,
    },
  ],
  fabricated_citation_stripped: [
    { kind: "tool", thought: "查", tool: "evidence.search", args_json: '{"query":"x"}' },
    {
      kind: "answer",
      thought: "答",
      answer: "结论",
      citations: ["梳理表.xlsx!实体!R2-2", "编的.xlsx!无!R9-9"],
      confidence: 0.9,
    },
  ],
  unknown_tool_goes_back_to_model: [
    { kind: "tool", thought: "查", tool: "不存在的工具", args_json: "{}" },
    { kind: "answer", thought: "那个没有", answer: "那个工具没有", citations: [], confidence: 0.3 },
  ],
  tool_raises_goes_back_to_model: [
    { kind: "tool", thought: "查", tool: "oir.query", args_json: '{"kind":"objects"}' },
    { kind: "answer", thought: "工具炸了", answer: "查不到", citations: [], confidence: 0.3 },
  ],
  gateway_error_is_reported: [new RuntimeError_("网关挂了")],
  step_budget: Array.from({ length: 10 }, (_, i) => ({
    kind: "tool",
    thought: `第${i}次`,
    tool: "evidence.search",
    args_json: '{"query":"x"}',
  })),
  answer_at_first_step: [
    { kind: "answer", thought: "打招呼，不用查东西", answer: "在", citations: [], confidence: 0.9 },
  ],
  empty_thought_is_reported: [
    { kind: "answer", thought: "", answer: "随便说说", citations: [], confidence: 0.5 },
  ],
  no_tool_name_finishes: [
    {
      kind: "tool",
      thought: "忘了填工具名",
      tool: "  ",
      answer: "那就直接答",
      citations: [],
      confidence: 0.4,
      args_json: "{}",
    },
  ],
  next_questions_dedup_and_cap: [
    {
      kind: "answer",
      thought: "答",
      answer: "答",
      citations: [],
      confidence: 0.5,
      next_questions: [" 一 ", "", "一", "二", "三", "四"],
    },
  ],
  missing_next_questions: [
    { kind: "answer", thought: "答", answer: "答", citations: [], confidence: 0.5 },
  ],
  single_shot_no_tools: [
    { thought: "寒暄", answer: "在。", citations: [], confidence: 0.9 },
  ],
  single_shot_gateway_error: [new RuntimeError_("网关又挂了")],
  plan_execute: [
    { steps: [{ goal: "把采购包连到订单" }, { goal: "重出模板" }, { nogoal: "会被丢掉" }] },
    {
      kind: "answer",
      thought: "做完了",
      answer: "两件事都办了。",
      citations: [],
      confidence: 0.9,
    },
  ],
  plan_execute_empty_plan_falls_back: [
    { steps: [] },
    { kind: "answer", thought: "直接答", answer: "好了。", citations: [], confidence: 0.9 },
  ],
  plan_execute_plan_call_fails_falls_back: [
    new RuntimeError_("列计划失败"),
    { kind: "answer", thought: "直接答", answer: "好了。", citations: [], confidence: 0.9 },
  ],
  forced_strategy_en: [
    { kind: "answer", thought: "just answer", answer: "OK", citations: [], confidence: 0.5 },
  ],
  plan_execute_en: [
    { steps: [{ goal: "link it" }] },
    { kind: "answer", thought: "done", answer: "done", citations: [], confidence: 0.5 },
  ],
};

const NO_TOOL_RUNS = new Set(["single_shot_no_tools", "single_shot_gateway_error"]);

const AGENT_OPTS: Record<string, { maxSteps?: number; lang?: string; strategy?: string }> = {
  step_budget: { maxSteps: 3 },
  forced_strategy_en: { strategy: "react", lang: "en" },
  plan_execute_en: { lang: "en" },
};

// ══════════════════════════════════════════════════════════════════
//  engagement —— 冻结的控制面
// ══════════════════════════════════════════════════════════════════
describe("engagement / 冻结拓扑", () => {
  const E = G.engagement;

  it("六个角色、名字与顺序都不能改（下游按名字引用 handler）", () => {
    expect([...FDE_ENGAGEMENT_AGENTS]).toEqual(E["agents"]);
  });

  it("DAG 的每个节点逐字段一致：mode / deps / scope / budget / gate / params", () => {
    const dag = buildFdeEngagementDag();
    expect(dag.name).toBe(E["name"]);
    expect(dag.freezeBefore).toBe(E["freeze_before"]);
    expect(dag.frozen).toBe(E["frozen"]);
    expect(dag.topoOrder()).toEqual(E["topo_order"]);
    expect(dag.describe()).toEqual(E["describe"]);

    for (const want of E["nodes"] as Dict[]) {
      const node = dag.get(want["id"] as string);
      const scope = want["scope"] as Dict;
      const budget = want["budget"] as Dict;
      expect({
        id: node.id,
        mode: node.mode,
        handler: node.handler,
        deps: [...node.deps],
        evidenceTopK: node.scope.evidenceTopK,
        evidenceFiles: node.scope.evidenceFiles,
        blackboardPattern: node.scope.blackboardPattern,
        budget: [
          node.budget.tokens,
          node.budget.iterations,
          node.budget.wallclockS,
          node.budget.toolCalls,
        ],
        critics: [...node.critics],
        criticRounds: node.criticRounds,
        gate: node.gate === null ? null : { kind: node.gate.kind, require: [...node.gate.require] },
        difficulty: node.difficulty,
        sandbox: node.sandbox,
        retries: node.retries,
        fanoutOver: node.fanoutOver,
        params: node.params,
      }).toEqual({
        id: want["id"],
        mode: want["mode"],
        handler: want["handler"],
        deps: want["deps"],
        evidenceTopK: scope["evidence_top_k"],
        evidenceFiles: scope["evidence_files"],
        blackboardPattern: scope["blackboard_pattern"],
        budget: [
          budget["tokens"],
          budget["iterations"],
          budget["wallclock_s"],
          budget["tool_calls"],
        ],
        critics: want["critics"],
        criticRounds: want["critic_rounds"],
        gate: want["gate"],
        difficulty: want["difficulty"],
        sandbox: want["sandbox"],
        retries: want["retries"],
        fanoutOver: want["fanout_over"],
        params: want["params"],
      });
    }
  });

  it("GAP 是同步屏障，EXPORT 同时依赖包和审查结论", () => {
    const dag = buildFdeEngagementDag();
    for (const [nodeId, want] of Object.entries(E["resolve_deps"] as Record<string, string[]>)) {
      expect(dag.resolveDeps(nodeId), nodeId).toEqual(want);
    }
  });

  it("冻结之后材料内容改不动拓扑 —— 这是整个防注入设计的地基", () => {
    const dag = buildFdeEngagementDag();
    expect(() =>
      dag.add(
        buildFdeEngagementDag().get("INTAKE"), // 任意节点都行，冻结判定在 add 的第一行
      ),
    ).toThrowError(/材料内容/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  engagement_runtime
// ══════════════════════════════════════════════════════════════════
function runtimeOf(opts: {
  oir?: Dict;
  flow?: unknown;
  backlog?: Dict;
  downloadable?: boolean;
}): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "engagement-test",
    project: "采购到付款",
    oir: opts.oir ?? (FIXTURE["oir"] as Dict),
    flow: opts.flow === undefined ? (FIXTURE["flow"] as Dict) : opts.flow,
    backlog: QuestionBacklog.fromDict(opts.backlog ?? (FIXTURE["backlog"] as Dict)),
    decisions: [...(FIXTURE["decisions"] as unknown[])],
    generatedAt: "2026-08-12T00:00:00+00:00",
    releaseDownloadable: opts.downloadable ?? true,
  });
}

/** `clear` 那一档：把唯一的阻塞问题标成已答，其余原样。 */
function clearBacklog(): Dict {
  const src = FIXTURE["backlog"] as Dict;
  const rows = (src["questions"] as Dict[]).map((row) => {
    if (row["id"] !== "q.erp.version") return { ...row };
    return { ...row, status: "answered", blockedArtifacts: [], priority: "high" };
  });
  return { ...src, questions: rows };
}

const fakeCtx = (nodeId: string): never => ({ nodeId }) as never;

describe("engagement_runtime / 纯函数", () => {
  it("边的类型判定（异常/超时/取消/条件都要认得中英文）", () => {
    for (const [v, want] of ER["edge_kind"] as [unknown, string][]) {
      expect(edgeKind(v), JSON.stringify(v)).toBe(want);
    }
  });

  it("数据对象分类的命中顺序 —— 主数据在交易之前，「主数据的订单」归主数据", () => {
    for (const [v, want] of ER["classification"] as [string, string][]) {
      expect(classification(v), v).toBe(want);
    }
  });

  it("oirStats 六个计数", () => {
    expect(oirStats(FIXTURE["oir"] as Dict)).toEqual(ER["oir_stats"]);
    expect(oirStats({})).toEqual(ER["oir_stats_empty"]);
  });

  it("traceability 只数 assertion，且跳过 assertion/validation 两个子树", () => {
    for (const [pkg, want] of ER["traceability"] as [Dict, [number, string[]]][]) {
      expect(traceability(pkg), JSON.stringify(pkg)).toEqual(want);
    }
  });

  it("交付件清单一个都不能少（REVIEW 的 artifact_checks 按它逐条出）", () => {
    expect([...EXPECTED_ARTIFACTS]).toEqual(ER["expected_artifacts"]);
  });
});

describe("engagement_runtime / 输入投影", () => {
  it("pending 含全部未决问题，blockers 只含真正阻塞发布的那些", () => {
    const rt = runtimeOf({});
    const want = ER["input"] as Dict;
    expect(Object.keys(rt.oirDict()).sort()).toEqual(want["oir_dict_keys"]);
    expect(rt.flowDict()).toEqual(want["flow_dict"]);
    expect(rt.decisionRows()).toEqual(want["decision_rows"]);
    expect(rt.pending().map((q) => q.id)).toEqual(want["pending"]);
    expect(rt.blockers().map((q) => q.id)).toEqual(want["blockers"]);
    // 延后/已答的不进 pending —— 它们不该拖住交付
    expect(rt.pending().map((q) => q.id)).not.toContain("q.deferred");
  });

  it("flow/decisions 的三种输入形态都收（None、{decisions:[…]}、空账本）", () => {
    const want = ER["input_variants"] as Dict;
    const oir = FIXTURE["oir"] as Dict;
    expect(new EngagementRuntimeInput({ sessionId: "s", project: "p", oir }).flowDict()).toEqual(
      want["flow_none"],
    );
    expect(
      new EngagementRuntimeInput({
        sessionId: "s",
        project: "p",
        oir,
        decisions: { decisions: [{ id: "d" }] },
      }).decisionRows(),
    ).toEqual(want["decisions_mapping"]);
    expect(
      new EngagementRuntimeInput({ sessionId: "s", project: "p", oir }).decisionRows(),
    ).toEqual(want["decisions_empty_ledger"]);
  });
});

describe("engagement_runtime / handlers", () => {
  const H = ER["handlers"] as Dict;

  it("五个确定性投影 + GAP 的产出与 Python 逐字段一致", async () => {
    const rt = runtimeOf({});
    const hs = engagementHandlers(rt);
    const intake = (hs["agent.fde_interviewer"] as unknown as Projection).project({});
    const process = (hs["agent.process_modeler"] as unknown as Projection).project({});
    const erp = (hs["agent.erp_mapper"] as unknown as Projection).project({ PROCESS: process });
    const rules = (hs["agent.rule_engineer"] as unknown as Projection).project({});
    const objects = (hs["agent.data_steward"] as unknown as Projection).project({});
    expect(intake).toEqual(H["INTAKE"]);
    expect(process).toEqual(H["PROCESS"]);
    expect(erp).toEqual(H["ERP_MAP"]);
    expect(rules).toEqual(H["RULES"]);
    expect(objects).toEqual(H["DATA_OBJECTS"]);

    const gap = await hs["engagement.collect_gaps"]!.execute(
      { PROCESS: process, ERP_MAP: erp, RULES: rules, DATA_OBJECTS: objects },
      fakeCtx("GAP"),
    );
    expect(gap).toEqual(H["GAP"]);
  });

  it("流程节点没有 rid 时退回 id，都没有就退回空串（畸形流程不许炸）", () => {
    const alt = runtimeOf({ flow: FIXTURE["flow_alt"] });
    const hs = engagementHandlers(alt);
    expect((hs["agent.process_modeler"] as unknown as Projection).project({})).toEqual(
      H["PROCESS_alt"],
    );
    expect(
      (hs["agent.erp_mapper"] as unknown as Projection).project({
        PROCESS: H["PROCESS_alt"],
      }),
    ).toEqual(H["ERP_MAP_alt"]);
  });

  it("有阻塞问题时 INTERVIEW 不跳过模型，而是把这一批问题交给人", () => {
    const rt = runtimeOf({});
    const hs = engagementHandlers(rt);
    expect(hs["engagement.interview"]!.skipModel({})).toEqual(H["INTERVIEW_skip_model"]);
    expect(hs["engagement.interview"]!.skipModel({})).toBeNull();
    expect(hs["engagement.interview"]!.humanRequest(null, {})).toEqual(H["INTERVIEW_human_request"]);
  });

  it("每个 handler 的 task 文案与注册表键名都不动（键名就是 DAG 里的 handler 字段）", () => {
    const hs = engagementHandlers(runtimeOf({}));
    expect(Object.keys(hs).sort()).toEqual(H["registry_keys"]);
    const tasks: Dict = {};
    for (const k of Object.keys(hs).sort()) tasks[k] = hs[k]!.task({});
    expect(tasks).toEqual(H["tasks"]);
  });
});

/** Run the deterministic v3 delivery projections exactly in frozen-DAG order. */
async function v3DeliveryInputs(
  runtime: EngagementRuntimeInput,
  hs: ReturnType<typeof engagementHandlers>,
): Promise<Dict> {
  const project = (key: string, inputs: Dict): Dict =>
    (hs[key] as unknown as Projection).project(inputs);
  const execute = async (key: string, inputs: Dict): Promise<Dict> =>
    await hs[key]!.execute(inputs, fakeCtx(key)) as Dict;
  const out: Dict = {};
  out["INTAKE"] = project("agent.fde_interviewer", out);
  out["PROCESS"] = project("agent.process_modeler", out);
  out["ERP_MAP"] = project("agent.erp_mapper", out);
  out["RULES"] = project("agent.rule_engineer", out);
  out["DATA_OBJECTS"] = project("agent.data_steward", out);
  out["GAP"] = await execute("engagement.collect_gaps", out);
  out["INTERVIEW"] = hs["engagement.interview"]!.skipModel(out);
  out["DECISION_PROPOSAL"] = project("agent.decision_integrator", out);
  out["DECISION_APPLY"] = await execute("engagement.validate_decision_application", out);
  out["REQUIREMENTS"] = project("agent.requirements_engineer", out);
  out["ARCHITECTURE"] = project("agent.solution_architect", out);
  out["TEST_PLAN"] = project("agent.acceptance_test_engineer", out);
  out["CANONICALIZE"] = await execute("engagement.canonicalize", out);
  out["REVIEW"] = project("agent.delivery_reviewer", out);
  const acceptanceRequest = hs["engagement.human_acceptance"]!.humanRequest(null, out);
  const acceptanceQuestion = acceptanceRequest["question"] as Dict;
  expect(Array.isArray(runtime.decisions)).toBe(true);
  (runtime.decisions as unknown[]).push({
    id: "d.acceptance.golden",
    questionId: acceptanceQuestion["id"],
    answer: "APPROVE",
    actor: "Golden Reviewer",
    actorRole: "admin",
    authority: "admin",
    createdAt: 1_776_000_000,
  });
  out["HUMAN_ACCEPTANCE"] = hs["engagement.human_acceptance"]!.skipModel(out) as Dict;
  out["EXPORT"] = await execute("engagement.export", out);
  return out;
}

describe("engagement_runtime / 门禁指标", () => {
  it("阻塞问题清零后：v3 专业交付链、人工验收与 EXPORT 整包一致", async () => {
    const rt = runtimeOf({ backlog: clearBacklog() });
    const hs = engagementHandlers(rt);
    const want = ER["clear"] as Dict;

    expect(hs["engagement.interview"]!.skipModel({})).toEqual(want["INTERVIEW_skip_model"]);
    expect(rt.pending().map((q) => q.id)).toEqual(want["pending"]);
    expect(rt.blockers().map((q) => q.id)).toEqual(want["blockers"]);

    const delivery = await v3DeliveryInputs(rt, hs);
    const canon = delivery["CANONICALIZE"] as Dict;
    expect(canon).toEqual(want["CANONICALIZE"]);
    const review = delivery["REVIEW"] as Dict;
    expect(review).toEqual(want["REVIEW"]);
    expect(delivery["HUMAN_ACCEPTANCE"]).toEqual(want["HUMAN_ACCEPTANCE"]);
    const exported = delivery["EXPORT"];
    expect(exported).toEqual(want["EXPORT"]);
    expect(traceability(canon)).toEqual(want["traceability"]);
  });

  it("交付目录不可写 → REVIEW 判 BLOCKED，EXPORT 的 downloadable 为假", async () => {
    const rt = runtimeOf({ backlog: clearBacklog(), downloadable: false });
    const hs = engagementHandlers(rt);
    const want = ER["not_downloadable"] as Dict;
    const delivery = await v3DeliveryInputs(rt, hs);
    const review = delivery["REVIEW"] as Dict;
    expect(review).toEqual(want["REVIEW"]);
    expect(review["verdict"]).toBe("BLOCKED");
    const exported = delivery["EXPORT"] as Dict;
    expect(exported).toEqual(want["EXPORT"]);
    expect(exported["downloadable"]).toBe(false);
  });

  it("仍有阻塞问题 → REVIEW 多一条 OPEN_BLOCKING_QUESTIONS", async () => {
    const rt = runtimeOf({});
    const hs = engagementHandlers(rt);
    const review = (await v3DeliveryInputs(rt, hs))["REVIEW"] as Dict;
    expect(review["blockers"]).toEqual(((ER["blocked"] as Dict)["REVIEW"] as Dict)["blockers"]);
  });

  it("包校验不过 → NodeFailure 且 retryable=false（重试不会让重复 id 消失）", async () => {
    const rt = runtimeOf({ backlog: clearBacklog(), oir: FIXTURE["oir_dup"] as Dict, flow: null });
    const handler = engagementHandlers(rt)["engagement.canonicalize"] as CanonicalizeHandler;
    const want = ER["canonicalize_failure"] as Dict;
    await expect(handler.execute({}, fakeCtx("CANONICALIZE"))).rejects.toMatchObject({
      name: want["type"],
      message: want["message"],
      nodeId: want["node_id"],
      retryable: want["retryable"],
    });
  });

  it("上游没跑时 REVIEW/EXPORT 拿到空包也要给出确定的形态（不能静默放行）", async () => {
    const hs = engagementHandlers(runtimeOf({}));
    expect((hs["agent.delivery_reviewer"] as unknown as Projection).project({})).toEqual(
      ER["review_empty_input"],
    );
    const exported = (await (hs["engagement.export"] as ExportHandler).execute(
      {},
      fakeCtx("EXPORT"),
    )) as Dict;
    expect(exported).toEqual(ER["export_empty_input"]);
    expect(exported["downloadable"]).toBe(false);
    expect(exported["review_passed"]).toBe(false);
  });
});

describe("engagement_runtime / critics", () => {
  const CR = ER["critics"] as Dict;

  it("两个 critic 都是纯规则（needs_llm=false），降级到 RULES_ONLY 也照跑", () => {
    const cs = engagementCritics();
    expect(Object.keys(cs).sort()).toEqual(CR["names"]);
    const flags: Dict = {};
    for (const k of Object.keys(cs).sort()) flags[k] = cs[k]!.needsLlm;
    expect(flags).toEqual(CR["needs_llm"]);
    expect(new ContractCritic().name).toBe("schema");
    expect(new EngagementProvenanceCritic().name).toBe("provenance");
  });

  it("13 组判定与 Python 一致（缺必填字段拦、无证据的推断只警告不拦）", async () => {
    const rt = runtimeOf({});
    const hs = engagementHandlers(rt);
    const intake = (hs["agent.fde_interviewer"] as unknown as Projection).project({});
    const process = (hs["agent.process_modeler"] as unknown as Projection).project({});
    const drafts: Record<string, unknown> = {
      INTAKE: intake,
      PROCESS: process,
      REVIEW: ((ER["clear"] as Dict)["REVIEW"] as Dict),
    };

    const cs = engagementCritics();
    const rows = CR["verdicts"] as { lens: string; node_id: string; verdict: Dict }[];
    // golden 里的 draft 与这里重建的一一对应：前七条走 schema，后六条走 provenance
    const DRAFTS: unknown[] = [
      drafts["INTAKE"],
      { engagement: {} },
      drafts["PROCESS"],
      drafts["REVIEW"],
      { 随便: 1 },
      "不是 object",
      null,
      drafts["REVIEW"],
      { traceability: { unresolved: Array.from({ length: 12 }, (_, i) => `/x/${i}`) } },
      { traceability: { unresolved: [] } },
      {},
      { traceability: { unresolved: ["/a"] } },
      "不是 object",
    ];
    expect(DRAFTS.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const verdict = await cs[row.lens]!.judge(DRAFTS[i], makeCriticContext({ nodeId: row.node_id }));
      expect(
        {
          lens: verdict.lens,
          passed: verdict.passed,
          high: verdict.findings.filter((f) => f.severity === "high").length,
          findings: verdict.findings.map(findingToDict),
          note: verdict.note,
        },
        `#${i} ${row.lens}/${row.node_id}`,
      ).toEqual(row.verdict);
    }
  });
});

describe("engagement_runtime / 与 AgentLibrary 的接线", () => {
  it("每个投影节点挂的 schema/system 直接来自 AgentLibrary，不另抄一份", () => {
    const rt = runtimeOf({});
    const hs = engagementHandlers(rt);
    const want = ER["static_projection"] as Record<string, Dict>;
    const byAgent: Record<string, string> = {
      fde_interviewer: "agent.fde_interviewer",
      process_modeler: "agent.process_modeler",
      erp_mapper: "agent.erp_mapper",
      rule_engineer: "agent.rule_engineer",
      data_steward: "agent.data_steward",
      delivery_reviewer: "agent.delivery_reviewer",
    };
    for (const [agentName, key] of Object.entries(byAgent)) {
      const h = hs[key]!;
      expect((h.schema ?? {})["required"], agentName).toEqual(want[agentName]!["schema_required"]);
      expect(h.system.split("\n", 1)[0], agentName).toBe(want[agentName]!["system_head"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  engagement_runtime —— 真调度器上的端到端行为
// ══════════════════════════════════════════════════════════════════
/**
 * 这一段不用 golden：它钉的是**状态机**，不是某个字典的形状。
 *
 * 三条命脉，任何一条错了产品就废：
 *   · 专业投影一次模型都不该调（`backend.calls` 必须是空的）—— 抽取那一轮已经
 *     为同一份证据付过钱了；
 *   · INTERVIEW 遇到阻塞问题**真的挂起**，问题清掉后重放只跑剩下的节点；
 *   · REVIEW 的门禁不过时 EXPORT 根本不该开始，且失败节点不许进 checkpoint。
 */
function engagementScheduler(
  runtime: EngagementRuntimeInput,
  opts: { journal?: InMemoryJournal; blobs?: InMemoryBlobStore; resume?: boolean } = {},
): {
  sched: Scheduler;
  journal: InMemoryJournal;
  blobs: InMemoryBlobStore;
  backend: ScriptedBackend;
} {
  const journal = opts.journal ?? new InMemoryJournal();
  const blobs = opts.blobs ?? new InMemoryBlobStore();
  const rec = new Recorder("engagement-run", journal, blobs, { resume: opts.resume ?? false });
  const bus = new AgentBus(rec);
  const budget = new Budget({ tokens: 1_000_000, usd: 10 });
  const backend = new ScriptedBackend([], "{}");
  const gw = new ModelGateway(backend, rec, { routing: stubRouting(), budget });
  const loop = new AgentLoop({
    gateway: gw,
    ctxManager: new ContextManager({ system: "FDE engagement runtime", budgetTokens: 32_000 }),
    panel: new CriticPanel(engagementCritics(), rec),
    bus,
    recorder: rec,
    budget,
    handlers: engagementHandlers(runtime),
    newScratchpad: (t) => new Scratchpad({ budgetTokens: t }),
  });
  const sched = new Scheduler(buildFdeEngagementDag(), loop, rec, bus, budget, { concurrency: 4 });
  return { sched, journal, blobs, backend };
}

function liveRuntime(
  opts: {
    pending?: boolean;
    blocking?: boolean;
    downloadable?: boolean;
    decisions?: unknown[];
  } = {},
): EngagementRuntimeInput {
  const backlog = new QuestionBacklog();
  if (opts.pending === true) {
    backlog.add(
      new Question({
        id: "q.erp.version",
        text: "当前 ERP 产品版本是什么？",
        status: QuestionStatus.OPEN,
        audienceRole: "ERP顾问",
        blockedArtifacts: opts.blocking === false ? [] : ["ontology.package.json"],
        createdAt: 1_760_000_000,
        updatedAt: 1_760_000_000,
      }),
      { preserveLifecycle: false },
    );
  }
  return new EngagementRuntimeInput({
    sessionId: "engagement-test",
    project: "采购到付款",
    oir: FIXTURE["oir"] as Dict,
    flow: null,
    backlog,
    decisions: opts.decisions ?? [],
    generatedAt: "2026-08-12T00:00:00+00:00",
    releaseDownloadable: opts.downloadable ?? true,
  });
}

function completedNodes(journal: InMemoryJournal): Set<string> {
  const out = new Set<string>();
  for (const ev of journal.read("engagement-run")) {
    if (ev.kind === EventKind.NODE_COMPLETED && ev.nodeId !== null) out.add(ev.nodeId);
  }
  return out;
}

function recordAcceptance(
  decisions: unknown[],
  suspended: { pendingHuman: Dict | null },
  answer: "APPROVE" | "REJECT",
): void {
  const question = suspended.pendingHuman?.["question"] as Dict | undefined;
  expect(question?.["id"]).toEqual(expect.any(String));
  decisions.push({
    id: `d.acceptance.${answer.toLowerCase()}`,
    questionId: question!["id"],
    answer,
    actor: "Alice",
    actorRole: "admin",
    authority: "admin",
    rationale: answer === "REJECT" ? "验收范围尚需调整" : "验收通过",
    createdAt: 1_777_000_000,
  });
}

describe("engagement_runtime / 端到端（真 Scheduler + AgentLoop）", () => {
  it("冻结 DAG 在精确 APPROVE Decision 后跑完，且专业投影一次模型都没调", async () => {
    const decisions: unknown[] = [];
    const runtime = liveRuntime({ decisions });
    const first = engagementScheduler(runtime);
    const suspended = await first.sched.run("engagement-run");
    expect(suspended.status).toBe(RunStatus.SUSPENDED);
    expect(suspended.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
    expect(Object.keys(suspended.outputs)).not.toContain("EXPORT");
    recordAcceptance(decisions, suspended, "APPROVE");
    const resumed = engagementScheduler(runtime, {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const outcome = await resumed.sched.run("engagement-run");

    expect(outcome.status).toBe(RunStatus.COMPLETED);
    const expected = new Set(buildFdeEngagementDag().topoOrder());
    expect(completedNodes(first.journal)).toEqual(expected);
    expect(new Set(Object.keys(outcome.outputs))).toEqual(expected);
    expect((outcome.outputs["PROCESS"] as Dict)["source"]).toBe("mature_extract_composite");
    for (const k of ["review_passed", "schema_valid", "downloadable"]) {
      expect((outcome.outputs["EXPORT"] as Dict)[k], k).toBe(true);
    }
    // 抽取那一轮已经为同一份证据付过钱了 —— 这里再调一次就是重复付费
    expect(first.backend.calls).toEqual([]);
    expect(resumed.backend.calls).toEqual([]);
  });

  it("有阻塞问题时 INTERVIEW 真的挂起；问题清掉后重放只跑剩下的节点", async () => {
    const decisions: unknown[] = [];
    const runtime = liveRuntime({ pending: true, decisions });
    const first = engagementScheduler(runtime);
    const suspended = await first.sched.run("engagement-run");

    expect(suspended.status).toBe(RunStatus.SUSPENDED);
    expect(suspended.pendingHuman).not.toBeNull();
    expect(suspended.pendingHuman!["node"]).toBe("INTERVIEW");
    expect(suspended.pendingHuman!["pending"]).toBe(1);
    expect(Object.keys(suspended.outputs)).not.toContain("CANONICALIZE");
    expect(first.backend.calls).toEqual([]);

    // Question/Decision API 才是权威：它把 backlog 解决掉之后，重放恢复已完成的
    // 阶段，再把同一个 DAG 的剩余部分跑完。
    runtime.questionBacklog().questions.get("q.erp.version")!.status = QuestionStatus.ANSWERED;
    const second = engagementScheduler(runtime, {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const acceptanceSuspended = await second.sched.run("engagement-run");
    expect(acceptanceSuspended.status).toBe(RunStatus.SUSPENDED);
    expect(acceptanceSuspended.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
    for (const n of ["INTAKE", "PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS", "GAP"]) {
      expect(acceptanceSuspended.skipped, n).toContain(n);
    }
    for (const n of ["INTERVIEW", "DECISION_PROPOSAL", "DECISION_APPLY", "REQUIREMENTS", "ARCHITECTURE", "TEST_PLAN", "CANONICALIZE", "REVIEW"]) {
      expect(Object.keys(acceptanceSuspended.results), n).toContain(n);
    }
    recordAcceptance(decisions, acceptanceSuspended, "APPROVE");
    const third = engagementScheduler(runtime, {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const outcome = await third.sched.run("engagement-run");
    expect(outcome.status).toBe(RunStatus.COMPLETED);
    expect(outcome.outputs["HUMAN_ACCEPTANCE"]).toMatchObject({
      decision: "APPROVE",
      package_bound: true,
      releaseState: "RELEASED",
    });
    expect(second.backend.calls).toEqual([]);
    expect(third.backend.calls).toEqual([]);
  });

  it("交付目录不可写时 REVIEW 的门禁拦住 EXPORT，且失败节点不进 checkpoint", async () => {
    const { sched, journal, backend } = engagementScheduler(liveRuntime({ downloadable: false }));
    const outcome = await sched.run("engagement-run");

    expect(outcome.status).toBe(RunStatus.FAILED);
    expect(outcome.error).toContain("REVIEW");
    expect(outcome.error).toContain("质量门");
    expect(Object.keys(outcome.outputs)).not.toContain("EXPORT");
    const done = completedNodes(journal);
    expect(done.has("REVIEW"), "门禁失败产物不得提交 WorkingSet/checkpoint").toBe(false);
    expect(done.has("EXPORT")).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it("普通未决问题不阻塞分析；人工 REJECT 后以 DRAFT 正常结束", async () => {
    const decisions: unknown[] = [];
    const runtime = liveRuntime({ pending: true, blocking: false, decisions });
    const first = engagementScheduler(runtime);
    const suspended = await first.sched.run("engagement-run");
    expect(suspended.status).toBe(RunStatus.SUSPENDED);
    expect(suspended.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
    expect((suspended.outputs["INTERVIEW"] as Dict)["releaseState"]).toBe("DRAFT");
    recordAcceptance(decisions, suspended, "REJECT");
    const resumed = engagementScheduler(runtime, {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const outcome = await resumed.sched.run("engagement-run");

    expect(outcome.status).toBe(RunStatus.COMPLETED);
    for (const n of ["INTERVIEW", "HUMAN_ACCEPTANCE", "EXPORT"]) {
      expect((outcome.outputs[n] as Dict)["releaseState"], n).toBe("DRAFT");
    }
    expect(outcome.outputs["HUMAN_ACCEPTANCE"]).toMatchObject({
      decision: "REJECT",
      decision_recorded: true,
      package_bound: true,
    });
    expect(outcome.outputs["EXPORT"]).toMatchObject({
      human_decided: true,
      human_accepted: false,
    });
    expect((outcome.outputs["EXPORT"] as Dict)["downloadable"]).toBe(true);
    expect(
      ((outcome.outputs["EXPORT"] as Dict)["warnings"] as string[]).some((w) =>
        w.includes("非阻塞问题"),
      ),
    ).toBe(true);
    expect(completedNodes(first.journal)).toEqual(new Set(buildFdeEngagementDag().topoOrder()));
    expect(first.backend.calls).toEqual([]);
    expect(resumed.backend.calls).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  只读并行：Danger 是前提，不是装饰
// ══════════════════════════════════════════════════════════════════

describe("converse / 只读并行", () => {
  /** 一个能按名字给 danger 的假注册表，外加调用顺序观测点。 */
  function toolsWith(
    dangers: Record<string, number>,
    log: { order: string[]; concurrent: number; peak: number },
  ) {
    return {
      forScope: () =>
        Object.entries(dangers).map(([name, danger]) => ({
          spec: { render: () => name, name, danger },
        })),
      async call(name: string) {
        log.order.push(name);
        log.concurrent += 1;
        log.peak = Math.max(log.peak, log.concurrent);
        await new Promise((r) => setTimeout(r, 5));
        log.concurrent -= 1;
        return { ok: name };
      },
    };
  }

  /** 让 gateway 先给一个批，再给一个 answer。 */
  function gatewayGiving(first: Record<string, unknown>) {
    let n = 0;
    return {
      async call() {
        n += 1;
        return {
          data:
            n === 1
              ? { thought: "一起查", kind: "tool", tool: "", args_json: "{}", ...first }
              : { thought: "答", kind: "answer", tool: "", args_json: "{}", answer: "好了" },
          usd: 0,
        };
      },
    };
  }

  it("三个只读工具**真的并发跑** —— 这才是 3.7× 的来源", async () => {
    const log = { order: [] as string[], concurrent: 0, peak: 0 };
    const agent = new ConversationAgent({
      gateway: gatewayGiving({
        tools: [
          { tool: "ui.table", args_json: "{}" },
          { tool: "flow.query", args_json: "{}" },
          { tool: "question.next", args_json: "{}" },
        ],
      }) as never,
      tools: toolsWith({ "ui.table": 0, "flow.query": 0, "question.next": 0 }, log) as never,
      scope: "converse",
    });
    const turn = await agent.run("现在什么情况", { ctx: { turnId: "t1" } });

    expect(log.order).toHaveLength(3);
    expect(log.peak).toBe(3); // 同时在跑 —— 不是串行
    expect(turn.steps[0]!["tool"]).toBe("ui.table + flow.query + question.next");
  });

  it("**混进一个会改东西的就整批退回串行** —— 这条是并行成立的唯一前提", async () => {
    const log = { order: [] as string[], concurrent: 0, peak: 0 };
    const agent = new ConversationAgent({
      gateway: gatewayGiving({
        // oir.add 是 WRITE_LOCAL（danger 2）
        tools: [
          { tool: "ui.table", args_json: "{}" },
          { tool: "oir.add", args_json: "{}" },
        ],
        tool: "ui.table",
        args_json: "{}",
      }) as never,
      tools: toolsWith({ "ui.table": 0, "oir.add": 2 }, log) as never,
      scope: "converse",
    });
    await agent.run("加个对象", { ctx: { turnId: "t1" } });

    // 退回串行：只跑了单工具那条路，且并发峰值是 1
    expect(log.peak).toBe(1);
    expect(log.order).toEqual(["ui.table"]);
  });

  it("**认不出的工具也退回串行** —— fail closed，不拿不确定的东西去并发", async () => {
    const log = { order: [] as string[], concurrent: 0, peak: 0 };
    const agent = new ConversationAgent({
      gateway: gatewayGiving({
        tools: [
          { tool: "ui.table", args_json: "{}" },
          { tool: "根本没这个工具", args_json: "{}" },
        ],
        tool: "ui.table",
        args_json: "{}",
      }) as never,
      tools: toolsWith({ "ui.table": 0 }, log) as never,
      scope: "converse",
    });
    await agent.run("查点东西", { ctx: { turnId: "t1" } });
    expect(log.peak).toBe(1);
  });

  it("只给一个工具时不走并行路（一个也谈不上并行）", async () => {
    const log = { order: [] as string[], concurrent: 0, peak: 0 };
    const agent = new ConversationAgent({
      gateway: gatewayGiving({
        tools: [{ tool: "ui.table", args_json: "{}" }],
        tool: "ui.table",
        args_json: "{}",
      }) as never,
      tools: toolsWith({ "ui.table": 0 }, log) as never,
      scope: "converse",
    });
    const turn = await agent.run("查一下", { ctx: { turnId: "t1" } });
    expect(turn.steps[0]!["tool"]).toBe("ui.table"); // 不是 "ui.table + ..."
  });

  it("批里某个工具失败不拖垮其它 —— 各自的错各自回给模型", async () => {
    const log = { order: [] as string[], concurrent: 0, peak: 0 };
    const tools = toolsWith({ a: 0, b: 0 }, log);
    const orig = tools.call.bind(tools);
    tools.call = async (name: string) => {
      if (name === "b") throw new Error("b 挂了");
      return await orig(name);
    };
    const agent = new ConversationAgent({
      gateway: gatewayGiving({
        tools: [
          { tool: "a", args_json: "{}" },
          { tool: "b", args_json: "{}" },
        ],
      }) as never,
      tools: tools as never,
      scope: "converse",
    });
    const turn = await agent.run("查", { ctx: { turnId: "t1" } });
    const obs = String(turn.steps[0]!["observation"]);
    expect(obs).toContain("b 挂了");
    expect(obs).toContain("ok");
  });
});

describe("converse / 同轮副作用去重", () => {
  function renderTools(
    result: (n: number, args: Dict) => unknown = () => ({ 已生成: "视觉版.png" }),
  ) {
    const calls: Dict[] = [];
    return {
      calls,
      port: {
        forScope: () => [{
          spec: {
            render: () => "flow.render",
            name: "flow.render",
            danger: Danger.WRITE_LOCAL,
          },
        }],
        async call(_name: string, args: Dict) {
          calls.push(args);
          return result(calls.length, args);
        },
      },
    };
  }

  const renderStep = (style: string) => ({
    thought: "调用图像模型生成指定风格的流程图",
    kind: "tool",
    tool: "flow.render",
    args_json: JSON.stringify({ style }),
  });

  it("相同参数成功一次后立刻阻止重复执行，不再生成多个同图版本", async () => {
    const tools = renderTools();
    const gateway = new ScriptGateway([
      renderStep("flat-modern"),
      renderStep("flat-modern"),
      // 若闸没生效，循环才会读到这条；测试同时钉住它应提前结束。
      renderStep("flat-modern"),
    ]);
    const agent = new ConversationAgent({
      gateway,
      tools: tools.port as never,
      scope: "converse",
      strategy: "react",
      maxSteps: 6,
    });

    const turn = await agent.run("换成扁平现代风格", { ctx: { turnId: "dup-1" } });

    expect(tools.calls).toHaveLength(1);
    expect(gateway.calls).toHaveLength(2);
    expect(turn.answer).toContain("已阻止本轮重复调用");
    expect(turn.answer).toContain("风格、主题、布局或视觉要求");
    expect(turn.steps.some((x) => x["duplicate_blocked"] === true)).toBe(true);
  });

  it("第一次失败不记作成功，允许用相同参数重试", async () => {
    const tools = renderTools((n) => n === 1 ? { error: "图像网关临时失败" } : { 已生成: "成功.png" });
    const gateway = new ScriptGateway([
      renderStep("editorial"),
      renderStep("editorial"),
      {
        thought: "第二次已经成功，可以如实回答",
        kind: "answer",
        tool: "",
        args_json: "{}",
        answer: "已经生成成功。",
        citations: [],
        confidence: 0.6,
      },
    ]);
    const agent = new ConversationAgent({
      gateway,
      tools: tools.port as never,
      scope: "converse",
      strategy: "react",
      maxSteps: 4,
    });

    const turn = await agent.run("换成编辑插画风格", { ctx: { turnId: "retry-1" } });

    expect(tools.calls).toHaveLength(2);
    expect(turn.answer).toBe("已经生成成功。");
    expect(turn.steps.some((x) => x["duplicate_blocked"] === true)).toBe(false);
  });

  it("只要求一张时，即使模型偷偷换了参数也只能付费生成一次", async () => {
    const tools = renderTools();
    const gateway = new ScriptGateway([
      renderStep("minimal"),
      renderStep("isometric"),
      renderStep("editorial"),
    ]);
    const agent = new ConversationAgent({
      gateway,
      tools: tools.port as never,
      scope: "converse",
      strategy: "react",
      maxSteps: 6,
    });

    const turn = await agent.run("换一种图片风格", { ctx: { turnId: "single-image-1" } });

    expect(tools.calls).toEqual([{ style: "minimal" }]);
    expect(gateway.calls).toHaveLength(2);
    expect(turn.answer).toContain("已阻止本轮重复调用");
  });

  it("同一工具但风格参数不同会分别执行", async () => {
    const tools = renderTools();
    const gateway = new ScriptGateway([
      renderStep("minimal"),
      renderStep("isometric"),
      {
        thought: "两个明确不同的视觉版本都已生成",
        kind: "answer",
        tool: "",
        args_json: "{}",
        answer: "两个不同风格版本都已生成。",
        citations: [],
        confidence: 0.6,
      },
    ]);
    const agent = new ConversationAgent({
      gateway,
      tools: tools.port as never,
      scope: "converse",
      strategy: "react",
      maxSteps: 4,
    });

    await agent.run("生成两个不同风格", { ctx: { turnId: "styles-1" } });

    expect(tools.calls).toEqual([{ style: "minimal" }, { style: "isometric" }]);
  });
});
