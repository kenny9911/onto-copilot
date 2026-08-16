/**
 * dag 的 golden 校验 —— golden/dag.json 由 tools/golden/dag.py 从 Python 侧真跑出来。
 *
 * golden 里存的是**程序**（ops）不是对象快照：每条用例带一串 dag/add/expand/freeze
 * 的 ops，Python 和这里各自 replay 同一串，再比对输出。所以 DAG 的构造过程不需要
 * 在这份文件里手抄一遍 —— 手抄的输入和手写的期望值一样不可信。
 *
 * ops 里只写了显式传的 kwargs，其余字段各自用各自的 defaults 补齐，于是"默认值是否
 * 一致"也被顺带钉住。
 *
 * **两条已知分叉，都在下面显式钉住，不是绕过**：
 *   1. 三个死字段（gate.timeout_s / gate.on_timeout / scope.recall_long_term）没迁。
 *      测试把它们从 golden 里摘掉再比，并断言摘掉的值恰好是 Python 默认值 ——
 *      哪天有人给它们赋了非默认值，这里立刻红。
 *   2. `dag[missing]` 在 Python 抛 KeyError，这里抛 DagError，消息不同。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DagError, FrozenPlanViolation } from "../src/kernel/errors.js";
import {
  Dag,
  Difficulty,
  isFanout,
  makeGateSpec,
  makeNodeBudget,
  makeNodeSpec,
  makeScopeSpec,
  NodeMode,
  parseDifficulty,
  parseNodeMode,
  withOverrides,
  type NodeSpec,
} from "../src/kernel/dag.js";

// ══════════════════════════════════════════════════════════════════
//  golden 形状
// ══════════════════════════════════════════════════════════════════
interface PyScope {
  evidence_top_k: number;
  evidence_files: string[] | null;
  blackboard_pattern: string;
  recall_long_term?: boolean;
}
interface PyBudget {
  tokens: number;
  iterations: number;
  wallclock_s: number;
  tool_calls: number;
}
interface PyGate {
  kind: string;
  require: string[];
  timeout_s?: number;
  on_timeout?: string;
}
interface PySpec {
  id: string;
  mode: string;
  handler: string;
  deps?: string[];
  scope?: PyScope;
  budget?: PyBudget;
  critics?: string[];
  critic_rounds?: number;
  gate?: PyGate | null;
  difficulty?: string | null;
  sandbox?: string | null;
  retries?: number;
  fanout_over?: string | null;
  params?: Record<string, unknown>;
}
type Op =
  | { op: "dag"; name: string; freeze_before?: string | null }
  | { op: "add"; spec: PySpec }
  | { op: "extend"; specs: PySpec[] }
  | { op: "expand"; cardinalities: Record<string, string[]> }
  | { op: "freeze" }
  | { op: "topo_order" }
  | { op: "describe" }
  | { op: "resolve_deps"; node: string }
  | { op: "dependents"; node: string }
  | { op: "get"; node: string };

interface Case {
  name: string;
  doc: string;
  ops: Op[];
  frozen: boolean;
  freeze_before: string | null;
  len: number;
  node_ids: string[];
  nodes: Required<PySpec>[];
  is_fanout: [string, boolean][];
  topo_order: string[];
  resolve_deps: [string, string[]][];
  dependents: [string, string[]][];
  describe: { id: string; mode: string; deps: string[]; critics: string[]; gate: string | null }[];
  contains: [string, boolean][];
}
interface ErrCase {
  name: string;
  doc: string;
  ops: Op[];
  error: { type: string; message: string };
}
interface Golden {
  enums: { NodeMode: Record<string, string>; Difficulty: Record<string, string> };
  defaults: {
    NodeSpec: Required<PySpec>;
    ScopeSpec: PyScope;
    NodeBudget: PyBudget;
    GateSpec: PyGate;
  };
  dead_fields: {
    "GateSpec.timeout_s": number;
    "GateSpec.on_timeout": string;
    "ScopeSpec.recall_long_term": boolean;
  };
  cases: Case[];
  errors: ErrCase[];
}

// dag.json 里没有超出 Number 安全范围的整数（预算最大 604800），所以直接 JSON.parse
// 就够 —— ids.test.ts 那套 source-text 保精度的把戏这里用不上。
const G: Golden = JSON.parse(readFileSync(join(__dirname, "../../golden/dag.json"), "utf8"));

// ══════════════════════════════════════════════════════════════════
//  ops 解释器 —— 与 tools/golden/dag.py 里的 run() 一一对应
// ══════════════════════════════════════════════════════════════════
function specFromPy(d: PySpec): NodeSpec {
  return makeNodeSpec({
    id: d.id,
    mode: parseNodeMode(d.mode),
    handler: d.handler,
    ...(d.deps !== undefined ? { deps: d.deps } : {}),
    ...(d.scope !== undefined
      ? {
          scope: makeScopeSpec({
            ...(d.scope.evidence_top_k !== undefined ? { evidenceTopK: d.scope.evidence_top_k } : {}),
            ...(d.scope.evidence_files != null ? { evidenceFiles: d.scope.evidence_files } : {}),
            ...(d.scope.blackboard_pattern !== undefined
              ? { blackboardPattern: d.scope.blackboard_pattern }
              : {}),
          }),
        }
      : {}),
    ...(d.budget !== undefined
      ? {
          budget: makeNodeBudget({
            tokens: d.budget.tokens,
            iterations: d.budget.iterations,
            wallclockS: d.budget.wallclock_s,
            ...(d.budget.tool_calls !== undefined ? { toolCalls: d.budget.tool_calls } : {}),
          }),
        }
      : {}),
    ...(d.critics !== undefined ? { critics: d.critics } : {}),
    ...(d.critic_rounds !== undefined ? { criticRounds: d.critic_rounds } : {}),
    ...(d.gate != null ? { gate: makeGateSpec({ kind: d.gate.kind, require: d.gate.require ?? [] }) } : {}),
    ...(d.difficulty != null ? { difficulty: parseDifficulty(d.difficulty) } : {}),
    ...(d.sandbox != null ? { sandbox: d.sandbox } : {}),
    ...(d.retries !== undefined ? { retries: d.retries } : {}),
    ...(d.fanout_over != null ? { fanoutOver: d.fanout_over } : {}),
    ...(d.params !== undefined ? { params: d.params } : {}),
  });
}

function runOps(ops: readonly Op[]): Dag {
  let dag: Dag | null = null;
  for (const op of ops) {
    if (op.op === "dag") {
      dag = new Dag(op.name, { freezeBefore: op.freeze_before ?? null });
      continue;
    }
    if (dag === null) throw new Error("第一条 op 必须是 dag");
    switch (op.op) {
      case "add":
        dag.add(specFromPy(op.spec));
        break;
      case "extend":
        dag.extend(op.specs.map(specFromPy));
        break;
      case "expand":
        // 用 Map 喂进去，保住 golden 里的键顺序（普通对象会被整数样式的键重排）
        dag.expand(new Map(Object.entries(op.cardinalities)));
        break;
      case "freeze":
        dag.freeze();
        break;
      case "topo_order":
        dag.topoOrder();
        break;
      case "describe":
        dag.describe();
        break;
      case "resolve_deps":
        dag.resolveDeps(op.node);
        break;
      case "dependents":
        dag.dependents(op.node);
        break;
      case "get":
        dag.get(op.node);
        break;
    }
  }
  if (dag === null) throw new Error("ops 为空");
  return dag;
}

/** 把 TS 的 NodeSpec 摊回 Python 的字段名，好和 golden 直接 toEqual。
 *  这层翻译只有键名映射，没有任何逻辑 —— 有逻辑就等于在测试里重写了一遍实现。 */
function pyShape(s: NodeSpec): Record<string, unknown> {
  return {
    id: s.id,
    mode: s.mode,
    handler: s.handler,
    deps: [...s.deps],
    scope: {
      evidence_top_k: s.scope.evidenceTopK,
      evidence_files: s.scope.evidenceFiles === null ? null : [...s.scope.evidenceFiles],
      blackboard_pattern: s.scope.blackboardPattern,
    },
    budget: {
      tokens: s.budget.tokens,
      iterations: s.budget.iterations,
      wallclock_s: s.budget.wallclockS,
      tool_calls: s.budget.toolCalls,
    },
    critics: [...s.critics],
    critic_rounds: s.criticRounds,
    gate: s.gate === null ? null : { kind: s.gate.kind, require: [...s.gate.require] },
    difficulty: s.difficulty,
    sandbox: s.sandbox,
    retries: s.retries,
    fanout_over: s.fanoutOver,
    params: { ...s.params },
  };
}

/** 摘掉三个没迁的死字段，并**断言摘掉的正是 Python 默认值** ——
 *  哪天有人给它们赋了真值，这条断言先红，而不是让分叉悄悄扩大。 */
function stripDead(node: Required<PySpec>): Record<string, unknown> {
  const { recall_long_term, ...scope } = node.scope;
  expect(recall_long_term).toBe(G.dead_fields["ScopeSpec.recall_long_term"]);
  let gate: Record<string, unknown> | null = null;
  if (node.gate !== null) {
    const { timeout_s, on_timeout, ...rest } = node.gate;
    expect(timeout_s).toBe(G.dead_fields["GateSpec.timeout_s"]);
    expect(on_timeout).toBe(G.dead_fields["GateSpec.on_timeout"]);
    gate = rest;
  }
  return { ...node, scope, gate };
}

// ══════════════════════════════════════════════════════════════════
//  枚举与默认值
// ══════════════════════════════════════════════════════════════════
describe("枚举值与 Python StrEnum 一致", () => {
  it("NodeMode", () => expect({ ...NodeMode }).toEqual(G.enums.NodeMode));
  it("Difficulty", () => expect({ ...Difficulty }).toEqual(G.enums.Difficulty));
  it("parseX 认全部合法值", () => {
    for (const v of Object.values(G.enums.NodeMode)) expect(parseNodeMode(v)).toBe(v);
    for (const v of Object.values(G.enums.Difficulty)) expect(parseDifficulty(v)).toBe(v);
  });
  it("parseX 对未知值抛错，不静默放行", () => {
    // Python 侧 NodeMode("Deterministic") 抛 ValueError；`as NodeMode` 会把这道校验删掉
    expect(() => parseNodeMode("Deterministic")).toThrow(DagError);
    expect(() => parseNodeMode("")).toThrow(DagError);
    expect(() => parseDifficulty("HIGH")).toThrow(DagError);
  });
});

describe("默认值与 Python dataclass 默认值一致", () => {
  it("NodeSpec 全套默认", () => {
    const spec = makeNodeSpec({ id: "X", mode: NodeMode.DETERMINISTIC, handler: "h" });
    expect(pyShape(spec)).toEqual(stripDead(G.defaults.NodeSpec));
  });
  it("ScopeSpec", () => {
    const { recall_long_term, ...rest } = G.defaults.ScopeSpec;
    expect(recall_long_term).toBe(G.dead_fields["ScopeSpec.recall_long_term"]);
    const s = makeScopeSpec();
    expect({
      evidence_top_k: s.evidenceTopK,
      evidence_files: s.evidenceFiles,
      blackboard_pattern: s.blackboardPattern,
    }).toEqual(rest);
  });
  it("NodeBudget", () => {
    const b = makeNodeBudget();
    expect({
      tokens: b.tokens,
      iterations: b.iterations,
      wallclock_s: b.wallclockS,
      tool_calls: b.toolCalls,
    }).toEqual(G.defaults.NodeBudget);
  });
  it("GateSpec（timeout_s / on_timeout 没迁）", () => {
    const { timeout_s, on_timeout, ...rest } = G.defaults.GateSpec;
    expect(timeout_s).toBe(G.dead_fields["GateSpec.timeout_s"]);
    expect(on_timeout).toBe(G.dead_fields["GateSpec.on_timeout"]);
    const g = makeGateSpec({ kind: "auto" });
    expect({ kind: g.kind, require: g.require }).toEqual(rest);
  });
});

// ══════════════════════════════════════════════════════════════════
//  正常用例
// ══════════════════════════════════════════════════════════════════
describe.each(G.cases.map((c) => [c.name, c] as const))("case %s", (_name, c) => {
  const dag = runOps(c.ops);

  it(c.doc || "结构", () => {
    expect(dag.frozen).toBe(c.frozen);
    expect(dag.freezeBefore).toBe(c.freeze_before);
    expect(dag.size).toBe(c.len);
    // 插入序：Python dict 保序，这边靠 Map 对上
    expect([...dag.nodes.keys()]).toEqual(c.node_ids);
  });

  it("节点字段逐个一致", () => {
    for (const [i, nid] of c.node_ids.entries()) {
      expect(pyShape(dag.get(nid))).toEqual(stripDead(c.nodes[i]!));
    }
    expect(c.is_fanout.map(([n]) => [n, isFanout(dag.get(n))])).toEqual(c.is_fanout);
  });

  it("topoOrder / resolveDeps / dependents / describe", () => {
    expect(dag.topoOrder()).toEqual(c.topo_order);
    expect(c.resolve_deps.map(([n]) => [n, dag.resolveDeps(n)])).toEqual(c.resolve_deps);
    expect(c.dependents.map(([n]) => [n, dag.dependents(n)])).toEqual(c.dependents);
    expect(dag.describe()).toEqual(c.describe);
  });

  it("has()", () => {
    expect(c.contains.map(([n]) => [n, dag.has(n)])).toEqual(c.contains);
  });

  it("拓扑序在重复调用之间稳定", () => {
    expect(dag.topoOrder()).toEqual(dag.topoOrder());
  });
});

// ══════════════════════════════════════════════════════════════════
//  错误用例 —— 类型和消息都要一致
// ══════════════════════════════════════════════════════════════════
describe.each(G.errors.map((c) => [c.name, c] as const))("error %s", (name, c) => {
  it(c.doc || `抛 ${c.error.type}`, () => {
    let caught: unknown;
    try {
      runOps(c.ops);
    } catch (e) {
      caught = e;
    }
    expect(caught, "本该抛异常").toBeInstanceOf(Error);

    if (c.error.type === "KeyError") {
      // 已知分叉：Python `dag[missing]` 抛 KeyError（str(exc) 就是键的 repr），
      // JS 没有 KeyError。这里抛 DagError，消息也不同 —— 全仓没有任何地方 catch
      // 这个异常，所以只影响 crash 时的堆栈。**钉住新形状**，不是跳过。
      expect(name).toBe("missing_node_lookup");
      expect(c.error.message).toBe("'GHOST'");
      expect(caught).toBeInstanceOf(DagError);
      expect((caught as Error).message).toBe("节点不存在: 'GHOST'");
      return;
    }

    const cls = c.error.type === "FrozenPlanViolation" ? FrozenPlanViolation : DagError;
    expect(caught).toBeInstanceOf(cls);
    expect((caught as Error).message).toBe(c.error.message);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Python 侧没覆盖、但 TS 侧必须钉住的行为
// ══════════════════════════════════════════════════════════════════
describe("TS 侧的额外风险", () => {
  it("排序按 code point，不按 UTF-16 code unit", () => {
    // golden 的 sort_is_by_code_point 用例已经比过一次；这里把"如果用默认 sort
    // 会怎样"写出来，免得后人觉得那几行 sortedCp 是多余的装饰。
    const c = G.cases.find((x) => x.name === "sort_is_by_code_point")!;
    const ids = c.topo_order.filter((n) => n !== "ALIGN");
    expect(ids).toEqual(["P.z", "P.\uffff", "P.\u{1f40d}"]);
    expect([...ids].sort()).not.toEqual(ids); // 默认 sort 会把 emoji 排到 U+FFFF 前面
    expect(runOps(c.ops).topoOrder()).toEqual(c.topo_order);
  });

  it("冻结后的拒绝是硬抛，不是静默忽略 —— 拓扑必须一个字节没变", () => {
    const dag = new Dag("t").add(
      makeNodeSpec({ id: "A", mode: NodeMode.DETERMINISTIC, handler: "echo" }),
    ).freeze();
    const before = [...dag.nodes.keys()];
    expect(() =>
      dag.add(makeNodeSpec({ id: "EVIL_EXFIL", mode: NodeMode.REACT, handler: "http.fetch" })),
    ).toThrow(FrozenPlanViolation);
    expect(() => dag.extend([])).not.toThrow(); // 空 extend 不碰 _guard
    expect(() => dag.expand({ A: ["x"] })).toThrow(FrozenPlanViolation);
    expect([...dag.nodes.keys()]).toEqual(before);
    expect(dag.size).toBe(1);
  });

  it("nodes 是浅拷贝，外面改不动冻结的拓扑", () => {
    const dag = new Dag("t")
      .add(makeNodeSpec({ id: "A", mode: NodeMode.DETERMINISTIC, handler: "echo" }))
      .freeze();
    const copy = dag.nodes;
    copy.delete("A");
    copy.set("B", makeNodeSpec({ id: "B", mode: NodeMode.DETERMINISTIC, handler: "echo" }));
    expect([...dag.nodes.keys()]).toEqual(["A"]);
  });

  it("集合字段不共享引用（Python 那边是 tuple，天然没这问题）", () => {
    const deps = ["A"];
    const a = makeNodeSpec({ id: "X", mode: NodeMode.DETERMINISTIC, handler: "h", deps });
    const b = makeNodeSpec({ id: "Y", mode: NodeMode.DETERMINISTIC, handler: "h", deps });
    deps.push("B");
    expect(a.deps).toEqual(["A"]);
    expect(b.deps).toEqual(["A"]);
    expect(a.deps).not.toBe(b.deps);
  });

  it("withOverrides 不改原件（对应 dataclasses.replace）", () => {
    const base = makeNodeSpec({
      id: "P",
      mode: NodeMode.DETERMINISTIC,
      handler: "h",
      fanoutOver: "files",
      params: { keep: 1 },
    });
    const inst = withOverrides(base, {
      id: "P.f1",
      fanoutOver: null,
      params: { ...base.params, fanout_key: "f1" },
    });
    expect(base.id).toBe("P");
    expect(base.fanoutOver).toBe("files");
    expect(base.params).toEqual({ keep: 1 });
    expect(inst.params).toEqual({ keep: 1, fanout_key: "f1" });
    expect(inst.handler).toBe("h");
  });

  it("expand 接受 Map，键顺序按给的来（普通对象会被整数样式的键重排）", () => {
    const dag = new Dag("t")
      .add(makeNodeSpec({ id: "P", mode: NodeMode.DETERMINISTIC, handler: "h", fanoutOver: "f" }))
      .expand(new Map([["P", ["10", "2"]]]));
    expect([...dag.nodes.keys()]).toEqual(["P.10", "P.2"]);
    // 但拓扑序仍然是排过序的 —— 插入序不影响调度顺序
    expect(dag.topoOrder()).toEqual(["P.10", "P.2"]);
  });

  it("repr 的引号形态（dag.py 里的 {x!r} 全从这里出去）", () => {
    // 期望值都是 .venv/bin/python -c "print(repr(...))" 的原文：
    //   "a'b" / 'a"b' / '换\n行' / 'emoji🐍' / '普通 空格'
    const dup = (id: string) => () =>
      new Dag("t")
        .add(makeNodeSpec({ id, mode: NodeMode.DETERMINISTIC, handler: "h" }))
        .add(makeNodeSpec({ id, mode: NodeMode.DETERMINISTIC, handler: "h" }));
    expect(dup("a'b")).toThrow(`节点 id 重复: "a'b"`); // 有 ' 没 " → 换双引号少转义
    expect(dup('a"b')).toThrow(`节点 id 重复: 'a"b'`);
    expect(dup("换\n行")).toThrow("节点 id 重复: '换\\n行'");
    expect(dup("emoji🐍")).toThrow("节点 id 重复: 'emoji🐍'"); // 可打印的非 ASCII 原样保留
    expect(dup("普通 空格")).toThrow("节点 id 重复: '普通 空格'"); // U+0020 是可打印的
  });

  it("非 ASCII 的不可打印字符按 Python 的形态转义", () => {
    // 这条曾经钉的是一处**分叉**：errors.ts 的 pyRepr 只处理 ASCII 控制字符。
    // 判据只差一个 /[\p{C}\p{Z}]/u 减掉 U+0020（Python 的 isprintable() 为假的
    // 正是 Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs），已经补进 errors.ts，两边现在完全一致。
    //
    // 源码里一律写转义序列，不放裸的不可见字符 —— 否则这段自己就没法 review。
    const dup = (id: string) => () =>
      new Dag("t")
        .add(makeNodeSpec({ id, mode: NodeMode.DETERMINISTIC, handler: "h" }))
        .add(makeNodeSpec({ id, mode: NodeMode.DETERMINISTIC, handler: "h" }));
    expect(dup("\uffff")).toThrow("节点 id 重复: '\\uffff'");
    expect(dup("nbsp\u00a0x")).toThrow("节点 id 重复: 'nbsp\\xa0x'");
    expect(dup("zwj\u200dx")).toThrow("节点 id 重复: 'zwj\\u200dx'");
  });

  it("环检测消息 repr 的是一个 list —— 逐元素 repr + `, ` 连接", () => {
    // dag.py 那条消息是 f"...涉及节点: {stuck}"，stuck 是 list[str]，格式来自
    // list.__repr__ 而不是 str.__repr__：多一层方括号，元素间是 ", "。
    const cyc = new Dag("t")
      .add(makeNodeSpec({ id: "a", mode: NodeMode.DETERMINISTIC, handler: "h", deps: ["b"] }))
      .add(makeNodeSpec({ id: "b", mode: NodeMode.DETERMINISTIC, handler: "h", deps: ["a"] }));
    expect(() => cyc.topoOrder()).toThrow("DAG 存在环，涉及节点: ['a', 'b']");
  });
});
