# OntoCopilot Harness 编排能力：文献调研与提升方案

**日期：** 2026-08-18
**范围：** 对话层（`onto/converse.ts` + `server/dialogue/tools.ts`）的编排能力
**方法：** 先盘现状，再查文献，最后只提"我们缺的那部分"
**边界：** 本文只做调研与方案，不含代码改动

---

> **第二版（2026-08-18 晚）**：根据导出的流程图很差这一现象继续追查，找到了一个比
> 编排更靠前的结构性问题 —— 见**第二部分**。第一部分的结论不变，但优先级要改：
> P0 之外要先补一条「批量变更 + 连通骨架」，否则并行做得再好，模型也只是更快地
> 往一张空画布上加孤立节点。

## 0. 一句话结论

**外层 DAG 已经很强，对话层几乎是裸 ReAct —— 你感到的"编排能力弱"全部落在后者。**

`kernel/` 那一套（计划冻结的 DAG、依赖就绪即跑的调度器、节点内 AgentLoop、
effect 重放、critic 门禁、作用域最小权限）在文献里对应的是 2025—2026 年多数
生产 harness 还没做到的水平。但用户真正每天在用的那条路 —— 聊天里问一句、系统
去查去导 —— 走的是 `converse.ts` 的一个 `for (step < 5)` 串行循环，一步一个工具，
工具报错以纯文本回喂。**两层的成熟度差了一代。**

所以方案的重点不是"引入一个编排框架"，而是**把 kernel 已经证明有效的那几条纪律
（类型化契约、能力声明、预算、补偿、门禁）下放到对话层**。

---

## 1. 现状盘点：我们已经有什么

盘这一节是为了**避免推荐我们已经有的东西** —— 调研报告最没用的形态就是把现成
能力当成新建议再说一遍。

| 能力 | 落在哪 | 文献对位 |
|---|---|---|
| 外层固定拓扑 DAG + **计划冻结** | `kernel/dag.ts` | 比 LLMCompiler 的动态 DAG 更强的安全性质：拓扑在读取材料**内容**前确定，材料里的注入无法改变动作空间 |
| 依赖就绪即跑（流水线默认、屏障例外） | `kernel/scheduler.ts` | 与 LLMCompiler 的 Task Fetching Unit 同构 |
| 节点 = 上下文作用域边界 | `kernel/loop.ts` | TDP (arXiv:2604.11378)；等价于 Anthropic 的 subagent 上下文隔离 |
| **effect 记录/重放** | `kernel/recorder.ts` | 就是 Temporal 的 Activity 语义：非确定性动作首次执行记账，恢复时读回不重跑 |
| 预算（tool_calls / tokens / usd） | `kernel/budget.ts` | 约束驱动的资源分配 |
| 规则优先 + rubric + 生成≠评委 + 三采样 | `kernel/critic.ts` | CRITIC (2305.11738)、LLM-as-judge 综述 (2411.15594)、位置偏差 (2406.07791) |
| 工具按作用域授予 + Danger 分级 + 描述指纹 + 投毒扫描 | `kernel/tools.ts` | MCP 工具投毒 (2509.06572) |
| 技能渐进披露 | `kernel/skills.ts` | 与 RAG-MCP 的动机同源（防上下文膨胀） |
| 指令/问题二分（规则判意图） | `kernel/intent.ts` | 与 FrugalGPT / RouteLLM 的分层路由同源 |

**结论：kernel 层不缺文献里的东西。**

---

## 2. 对话层：那次导出失败的完整解剖

你给的那段 trace 不是偶发，它把对话层的四个结构性缺陷一次演全了。

```
ui.table {"kind":"actions"}                              ← 第 1 步
export.file {... name:"采购报销通用Action与Event流程映射表"}  ← 第 2 步，失败
export.file {... name:"采购报销工作流控制链路（Action 与 Event 映射）"} ← 第 3 步，成功
```

代码事实（`onto/converse.ts:781`、`:665`）：

```ts
this.maxSteps = opts.maxSteps ?? 5;
for (let step = 0; step < this.maxSteps; step += 1) { ... }   // 一步一个工具
obs = { error: `${excName(exc)}: ${excText(exc)}` };          // 错误 = 一段文本
```

| # | 缺陷 | 这次的代价 | 文献对位 |
|---|---|---|---|
| D1 | **错误回执无结构** —— 只有一句话 + 截断的清单 | 烧掉 1 步（20% 预算）纯粹用来重猜名字 | Self-Reflective APIs (2606.05037)：结构化 `suggestions[]` 相对纯英文诊断，任务完成率 **+36.7~40.0pp**，每次成功的 token 效率 **1.8~2.2×** |
| D2 | **无能力边界自述** —— 工具做不到"图进 Excel"，但没有任何地方说它做不到 | 模型自行发明了替代方案（"你去右侧画布自己导"），把工具该做的事推回给人 | FAIL-TALMS：LLM **普遍缺乏能力边界意识**；survey 2603.22862 把它列为开放问题 |
| D3 | **严格串行，一步一工具** | `ui.table` 与 `export.file` 之间本无依赖的查询也只能排队 | LLMCompiler (ICML'24)：显式依赖 DAG + 并行执行，相对 ReAct **延迟 ↓3.7×、成本 ↓6.7×、准确率 ↑9%** |
| D4 | **无重试/补偿策略** —— 失败与成功走同一条"回喂给模型"的路 | 靠模型自觉重试；它这次做对了，下次不一定 | SagaLLM (VLDB'25)：补偿代理 + 独立校验为一等公民 |

再加一条 trace 里没暴露但已存在的隐患：

| # | 缺陷 | 说明 |
|---|---|---|
| D5 | **32 个工具全量进上下文** | 目前尚可（论文的崩溃点在 49–741 个工具时 7–85% 掉点），但我们的描述极长（`export.file` 一条就上百字），已经在挤占对话预算 |

---

## 3. 文献与项目综述

只收录**对我们这个形态真正适用**的。每条给"关键数字 / 适用性判断"。

### 3.1 并行编排：LLMCompiler（ICML 2024）

三段式：**Function Calling Planner**（产出依赖 DAG）→ **Task Fetching Unit**
（拓扑分析，依赖满足即派发）→ **Executor**（并行执行）。相对 ReAct 延迟最多
↓3.7×、成本 ↓6.7×、准确率 ↑9%。

**适用性：高，但必须加一条我们自己的约束。** 我们的 scheduler 已经是同一个模式，
只是没有下放到对话层。而 survey 2603.22862 的原话是并行"**只有在依赖结构显式、
副作用被充分控制时才最有效**"—— 我们恰好有现成的副作用分级（`Danger`）：

> **只对 `Danger.READ` 的工具并行；`WRITE_LOCAL` 及以上一律串行，且保持现有确认闸。**

这条不是保守，是把论文的前提条件用我们已有的类型系统表达出来。

### 3.2 结构化恢复：Self-Reflective APIs（arXiv:2606.05037，Siemens，2026-06）

核心主张：**校验失败时，agent 需要的不是"哪里错了"，而是"下一步该怎么做"。**
API 在失败时返回机器可读的 `recovery_feedback.suggestions[]`，足以让 agent 直接
修好重试，不需要额外推理。Anthropic 系模型上任务完成率 +36.7~40.0pp
（Fisher 精确检验 p ≤ 0.0022）。注意其局限：在 gpt-4o-mini 上不显著（p=0.435）。

**适用性：最高，且我们已经无意中验证过一次。** 上一轮我给 `export.file` 加的
`最接近的: ["…（71% 像）"]` + `"照抄原名，别用你自己的转述"` 正是这个模式的一个
实例。论文说明的是：**这不该是一个工具的特例，而该是全部 32 个工具的统一契约。**

### 3.3 失败分类学：MAST（NeurIPS 2025 D&B，UC Berkeley）

150 条轨迹人工标注（κ=0.88）得出 14 种失败模式、3 大类。其中**系统设计问题占
44.2%**，细分含：不遵守任务规格 11.8%、**步骤重复 15.7%**、**不知道何时终止 12.4%**、
丢失对话历史 2.8%。

**适用性：作为验收清单。** 我们那次的失败正是"步骤重复"（同一个 `export.file`
调两遍）。这份分类学可以直接变成对话轨迹的**回归检查项**。

另一条重要结论：**MAS 在基准上的收益常常很小** —— 这是不引入多 agent 框架的直接依据。

### 3.4 事务与补偿：SagaLLM（VLDB 2025，arXiv:2503.11951）

针对 LLM 规划的四个基础缺陷：不可靠的自校验、上下文丢失、**缺乏事务保障**、
协调不足。做法是把 Saga 事务模式 + 持久记忆 + 自动补偿 + 独立校验代理结合：
每个工作流节点同时挂一个**事务代理**和一个**补偿代理**。放弃严格 ACID，但保证
工作流级一致性与可恢复性。

**适用性：高，而且我们已经有一半。** 仓库里已有 `oir.undo` / `flow.undo` /
`template.undo` 三个反向工具 —— 缺的是编排层把它们**自动串成补偿链**：目前一个
多步写操作中途失败，前面已经落地的改动不会回滚，要靠人去点 undo。

### 3.5 分层规划：ADaPT（AllenAI，arXiv:2311.05772）

**按需**递归分解：只有当执行器搞不定时才分解子任务。相对 ReAct 与
Plan-and-Execute，ALFWorld +28.3%、WebShop +27%、TextCraft +33%（绝对值）；
TextCraft 深度 2 的场景成功率 26.9% → 78.2%。

**适用性：中。** 它的价值在长程任务；我们的对话轮通常 2–5 步。真正可借的是它的
**判据**："不是任务难就分解，而是执行器失败了才分解" —— 这可以直接变成我们
"一次结构化重试后仍失败 → 才升级为多步计划"的策略，避免为简单问题付规划的钱。

### 3.6 工具检索：RAG-MCP / AnyTool / ToolkenGPT / ScaleMCP

规模化后的共识：工具描述每条 300–500 token，生产环境 20–100+ 个工具很常见；
压力测试显示 49–741 个工具时性能掉 7–85%。方法从向量检索（RAG-MCP、ScaleMCP）
到**分层目录树渐进过滤**（AnyTool），再到把工具压成单个特殊 token（ToolkenGPT）。

**适用性：中（现在），高（很快）。** 32 个工具还没到崩溃点，但描述长度已经是问题。
建议采用 **AnyTool 的分层目录**而不是向量检索 —— 因为我们的工具是**人工分好类的
固定集合**，不是动态 MCP 池；而且分层披露与 `skills.ts` 的渐进披露是同一机制，可以
复用而不是新建一套。

### 3.7 持久执行：Temporal / 事件溯源（工程侧）

工作流代码必须确定性，副作用推进 Activity；服务存事件历史并重放以重建状态。
LLM 调用天然非确定，必须包成 Activity，首次执行记账、重放时不重跑。

**适用性：已具备，值得对照复核。** `recorder.effect()` 就是这个语义。可借的是
Temporal 的**确定性约束检查**：我们的对话循环里若出现 `Date.now()` / 随机数直接
参与决策，重放就会漂 —— 值得做一次静态审计。

### 3.8 双控评估：τ²-bench（Sierra，arXiv:2506.07982）

**agent 与用户同时改共享状态**的对话基准。从自主模式切到"引导用户操作"，
SOTA 模型掉 18–25%；电信域 pass@1 从 74–56% 掉到 34%。

**适用性：这就是我们的形态。** FDE 与系统共同改 Ontology 状态，正是双控。我们目前
的 golden 是单元级的，**没有任何轨迹级的双控回归**。

### 3.9 CodeAct（ICML 2024）

把动作空间统一成可执行代码，用控制流在**一次执行**里编排多个工具。

**适用性：低 —— 明确不建议扩用。** 我们的 `code.exec` 已经按 ADR-2 定位在
**数据变换**。把它扩成编排层意味着工具调用绕过 `Danger` 分级与 scope 闸门 ——
那是我们最主要的间接注入防线，不是形式主义。这条要写进"不做什么"。

---

## 4. 差距矩阵

| 维度 | kernel 层 | 对话层 | 文献要求 | 缺口 |
|---|---|---|---|---|
| 依赖建模 | 冻结 DAG ✅ | 无（严格串行） | LLMCompiler | **大** |
| 并行执行 | 就绪即跑 ✅ | 无 | LLMCompiler | **大** |
| 错误结构化 | 部分（typed errors） | 无（纯文本） | Self-Reflective APIs | **大** |
| 能力边界自述 | 有（`availableFormats`） | 部分 | FAIL-TALMS | **中** |
| 补偿/回滚 | 无（节点级重跑） | 有 undo 工具但不自动 | SagaLLM | **中** |
| 工具检索 | scope 过滤 ✅ | 全量 32 个 | RAG-MCP / AnyTool | **中（会变大）** |
| 重放/持久 | effect ✅ | 复用 kernel ✅ | Temporal | 无 |
| 轨迹级验证 | critic ✅（产物） | grounding ✅（出处） | MAST / DVR | **中** |
| 双控评估 | 无 | 无 | τ²-bench | **大** |

---

## 5. 提升方案

按"投入产出比 × 风险"排序。每项写明改哪、怎么验收。

### P0 —— 统一工具契约（1–2 天，风险低，收益最高）

> 依据：Self-Reflective APIs +36.7~40.0pp；MAST"步骤重复"15.7%

**P0-1 结构化失败回执，成为全 32 个工具的强制契约**

```ts
interface ToolFailure {
  error: string;                    // 人读的一句话（保持现状）
  code: string;                     // 机器读：NOT_FOUND / AMBIGUOUS / UNSUPPORTED / NEEDS_ARG …
  suggestions: Array<{              // ← 新增，论文的核心
    arg: string;                    // 改哪个参数
    value: unknown;                 // 改成什么
    why: string;                    // 为什么是它
    confidence: number;
  }>;
}
```

- 改动点：`kernel/tools.ts` 增加 `outputSchema` 校验分支；32 个工具的 error 分支逐个补 `suggestions`。
- **`export.file` 已有雏形**（`最接近的`），把它规范化后推广。
- 验收：构造 10 条"名字/参数写错"的对抗用例，要求**第一次重试即成功**，不允许出现同一工具连调两次相同参数。

**P0-2 能力边界写进契约，而不是让模型猜**

- 工具描述中显式声明"做不到什么"；回执用 `code: "UNSUPPORTED"` + 可行替代。
- 已有先例：`availableFormats()` / 上一轮新增的 `imageFormats()`。推广到全部工具。
- 验收：模型不得再自行发明"你去右侧画布自己导"这类把工具能力推回给人的说法。

**P0-3 步数预算与失败解耦**

- 现状 `maxSteps=5` 且一次失败的重试白吃一步 = 20% 预算。
- 改为：结构化重试（`code` 明确 + 有 `suggestions`）**不计入 maxSteps**，但单独设上限 2 次。
- 验收：那条真实 trace 在新策略下应为 2 步（`ui.table` + 一次成功的 `export.file`）。

### P1 —— 只读并行 + 分层工具目录（1–2 周，风险中）

> 依据：LLMCompiler ↓3.7× 延迟 / ↓6.7× 成本；AnyTool 分层目录

**P1-1 对话层的只读并行**

在 `converse.ts` 增加可选的 plan 阶段：模型一次产出**一组**工具调用及其依赖，
`Danger.READ` 的部分并行执行。

**硬约束（写进类型，不靠自觉）：**
- 只有 `Danger.READ` 进并行批；
- 任一 `WRITE_LOCAL+` 出现即退回串行；
- 确认闸、预算记账、`recorder.effect` 全部保持不变。

- 验收：一轮里"查对象 + 查流程 + 查问题"从 3 次往返降到 1 次；`Danger` 混合时必须可证明地退回串行。

**P1-2 工具目录分层披露**

一级目录 8 个类目（材料 / 模型 / 流程 / 问题 / 决策 / 导出 / 产物 / 会话），
模型选类目后再展开该类工具的完整描述。复用 `skills.ts` 的渐进披露机制。

- 验收：对话首轮的工具描述 token 降 60% 以上，工具选择准确率不下降（用现有 golden 轨迹回归）。

### P2 —— 事务补偿 + 轨迹验证（2–4 周，风险中高）

> 依据：SagaLLM（VLDB'25）；MAST 系统设计类失败 44.2%

**P2-1 给写类工具挂补偿元数据**

```ts
reg.fn({ name: "oir.add", danger: Danger.WRITE_LOCAL, compensate: "oir.undo" }, handler)
```

多步写操作中途失败时，编排层**按逆序自动执行补偿链**，并把补偿结果如实回执。
我们已有三个 undo 工具，缺的只是这层串联。

- 验收：构造"第 3 步失败"的场景，前两步的改动必须被自动回滚，且用户看到一条明确的"已回滚"回执。

**P2-2 承诺兑现检查（对话轮出门前的 critic）**

现有 `checkGrounding` 保证"出处必须来自工具返回"。补一条**对称**的检查：
**回执里说没做到的事，回答里不许说做到了。**

那次事故的直接防线就是这一条 —— 若模型在回执含 `图没附上` 时仍宣称"已附上流程图"，
应当被拦下。

- 验收：注入"工具部分失败但模型宣称全部成功"的用例，必须被 critic 拦截。

### P3 —— 双控回归集（持续）

> 依据：τ²-bench 掉点 18–25%

建一组**轨迹级**回归：FDE 与系统交替改同一份 Ontology 状态，断言最终状态一致、
无步骤重复、无未终止循环（对齐 MAST 的 14 种失败模式）。

现有 golden 是单元级的，这是目前**最大的评估空白**。

---

## 6. 明确不做的

同样重要 —— 这几条都是文献里热门但**对我们是负收益**的：

| 不做 | 理由 |
|---|---|
| 引入 AutoGen / CrewAI / LangGraph 等多 agent 框架 | MAST：MAS 在基准上收益常常很小，且 44.2% 的失败是系统设计问题。我们的 DAG 已经是 hierarchical 拓扑并带**计划冻结**这一安全性质，换框架等于扔掉已验证的安全边界去换一个新的失败面 |
| DFSDT 全树搜索回溯 | token 与时延成本高；对话层用户在等。P0 的结构化重试能拿到 80% 的收益，成本是它的零头 |
| 把 CodeAct 扩成编排层 | 会绕过 `Danger` 分级与 scope 闸门 —— 那是间接注入的主要防线（ADR-2 已把 `code.exec` 限定在数据变换） |
| 向量检索式工具选择 | 我们的工具是人工分类的固定集合，不是动态 MCP 池。分层目录更准、可解释、可测，且能复用 skills 已有机制 |
| 让模型自选执行模式 | `loop.ts` 的注释已经写明理由：FDE 场景需要可预测性 |

---

## 7. 建议的推进顺序

```
P0-1 结构化回执 ─┬─> P0-3 预算解耦 ──> P1-1 只读并行 ──> P2-1 补偿链
P0-2 能力边界 ───┘                └──> P1-2 分层目录
                                       P2-2 承诺兑现检查（可与 P1 并行）
                                       P3 双控回归集（贯穿）
```

**先做 P0。** 三项加起来 1–2 天，是唯一一个"投入以天计、收益有 +36.7~40.0pp
量级实证"的档位，而且它是 P1/P2 的地基：并行批里的失败若仍是纯文本，
并行只会让失败更快地堆起来。

---

## 参考文献

1. Kim et al. **An LLM Compiler for Parallel Function Calling.** ICML 2024. arXiv:2312.04511
2. Canedo & Chethan. **Self-Reflective APIs: Structure Beats Verbosity for AI Agent Recovery.** Siemens, 2026. arXiv:2606.05037
3. Cemri, Pan, Yang et al. **Why Do Multi-Agent LLM Systems Fail?** NeurIPS 2025 D&B (MAST). arXiv:2503.13657
4. Chang et al. **SagaLLM: Context Management, Validation, and Transaction Guarantees for Multi-Agent LLM Planning.** VLDB 2025. arXiv:2503.11951
5. Prasad et al. **ADaPT: As-Needed Decomposition and Planning with Language Models.** AllenAI. arXiv:2311.05772
6. **The Evolution of Tool Use in LLM Agents: From Single-Tool Call to Multi-Tool Orchestration.** 2026. arXiv:2603.22862
7. Barres et al. **τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment.** Sierra, 2025. arXiv:2506.07982
8. Wang et al. **Executable Code Actions Elicit Better LLM Agents (CodeAct).** ICML 2024. arXiv:2402.01030
9. Qin et al. **ToolLLM / DFSDT.** arXiv:2307.16789
10. **ScaleMCP / RAG-MCP / MCP-Zero** —— 工具检索规模化. arXiv:2505.06416, 2506.01056
11. Shinn et al. **Reflexion: Language Agents with Verbal Reinforcement Learning.** arXiv:2303.11366
12. Anthropic. **Effective context engineering for AI agents** / **How we built our multi-agent research system.** 2025

仓库里已经引用、本文未重复的：TDP (2604.11378)、CRITIC (2305.11738)、
LLM-as-judge 综述 (2411.15594)、位置偏差 (2406.07791)、MCP 工具投毒 (2509.06572)。

---
---

# 第二部分：Ontology 生成质量与记忆管理

> 追加于 2026-08-18 晚。触发点：导出的 Excel 里那张流程图很差。
> 追下去发现图差只是表象，根因比编排更靠前。

## 8. 第二次解剖：通用模板为什么是一堆孤立节点

导出的图上写着：`3 个 Action ｜ 4 个 Event ｜ 1 个阶段 ｜ 0 条边`，全部堆在
「未分阶段」里，竖着排成一列。**这不是渲染问题，是数据里真的没有边。**

### 8.1 根因链（三段代码，缺一不可）

**① `draft.initialize` 建的是一张空画布**（`server/dialogue/tools.ts`）

```ts
const oir = new OIR();          // 空
const flow = new FlowGraph();   // 空
flow.stages.set("generic_draft", makeStage({ ... }));   // 只有一个阶段
```

回执自己也这么写：`本体: "空草案，可继续补对象/属性/关系/Action/Rule"`。
**它把"生成一份通用 Ontology"降级成了"开一张白纸"**，剩下的全靠后续对话去填。

**② 每一次变更只能动一个元素**（`onto/flow_edit.ts` / `onto/oir_edit.ts`）

```
flow: rename_node | set_actor | set_stage | add_node | connect | disconnect | remove_node | set_branch_label
oir : add_object_type | add_property | add_link | add_rule | add_action_type | add_enum_value | ...
```

`add_node` 一次一个节点，`connect` 一次一条边，`add_property` 一次一个属性。

**③ 对话循环一轮最多 5 步，一步一个工具**（`onto/converse.ts:665,781`）

### 8.2 算一笔账

一份"能给客户看"的通用采购报销 Ontology，最低配：

| 元素 | 数量 | 需要的调用 |
|---|---:|---:|
| DataObject | 4–6 | 4–6 |
| Property | 12–18 | 12–18 |
| Link | 4–8 | 4–8 |
| ActionType | 5–8 | 5–8 |
| Rule | 4–6 | 4–6 |
| 流程节点 | 8–12 | 8–12 |
| **流程边** | **8–14** | **8–14** |
| 阶段归属 | 8–12 | 8–12 |
| **合计** | | **≈ 55–85 次** |

**预算是 5 步。** 缺口两个数量级。

模型的实际行为完全可以预测：它在 5 步里先加了几个 Action / Event（因为那是列表
里最显眼的），**边永远排在最后，于是永远轮不到**。阶段归属同理 —— 所以是
「未分阶段」。

> **这解释了你说的"每次生成的 Ontology 缺乏很多信息和 schema"**：不是模型不懂，
> 是它没有预算把懂的东西写下来。

### 8.3 一个现成的反例：`flow.sketch` 其实做对了

同一个仓库里，`onto/flow_sketch.ts` 的 `SKETCH_SCHEMA` **把 edges 列进了
`required`**，而且明写「分叉的出边一定要写条件」：

```ts
required: ["stages", "nodes", "edges"],
```

它一次模型调用就能产出**带阶段、带边、带条件**的完整骨架。问题在于它的产出被
定位成"参考图"（`SKETCH_MARK` / `SKETCH_CAVEAT`），不写进产物、不进交付包 ——
而 `draft.initialize` 这条真正写产物的路，反倒什么都不生成。

**两条路走反了。**

### 8.4 Excel 里那张图的次要缺陷（我上一轮引入的）

图差的 80% 是上面的数据问题，但那张 sheet 本身也有两处我该修的：

| 缺陷 | 原因 | 修法 |
|---|---|---|
| 图注「流程图.svg」挤成两行 | 我给图专用 sheet 传了 `widths: new Map()`（无列宽）+ `titleCell: true`（大号加粗） | 给图注列设宽 60，改用普通样式 |
| 图注没说这图是什么、可不可信 | 只写了文件名 | 补一行来源：通用假设 / 材料推断 / 已确认，与 `draft_provenance` 一致 |

---

## 9. 两种入口，同一套要求

你提的两个场景在需求上是同一个，只是证据来源不同：

| | 通用模板（无材料） | 材料驱动 |
|---|---|---|
| 入口 | `draft.initialize` | `build.start` → EXTRACT 管线 |
| 证据 | 无，全部 `generic_assumption` | 材料切片 + cite |
| **流程必须连通** | ✅ 必须 | ✅ 必须 |
| 细节可省 | ✅ 可以粗 | ❌ 材料里有的不能丢 |
| 未知项 | 标成"假设，待验证" | 标成"材料没说，待补" |
| 可交互增删改 | ✅ | ✅ |
| 跨会话记住 | ✅ | ✅ |

**共同的硬要求只有一条：连通性。** 一份没有边的 Ontology 不是"粗糙的 Ontology"，
它根本不是 Ontology —— Action 与 Event 之间的因果、DataObject 的状态迁移，
全都编码在边上。丢了边等于只剩一张名词表。

### 9.1 "未知"要分成两种

从你给的 `events.draft.json` 看，每个绑定槽都是：

```json
"role": { "status": "unknown", "value": "unknown", "source": "unknown",
          "gapId": "gap.event...", "questionId": "q.gap.event..." }
```

`ontology_package.ts` 的 `assumptionPolicy: "missing_is_unknown"` 把两件不同的事
压成了一件：

- **真不知道**（没人说过审批人是谁）→ 该问业务方"请提供"
- **按行业通识可以先填**（报销审批的审批人通常是部门负责人）→ 该问业务方"请确认"

后者是**通用模板的全部价值所在**，而现在它被一律降级成 `unknown`，于是通用模板
和空模板在 schema 上没有区别。

仓库里其实已经有这个概念 —— `draft_provenance.assertion_origin = "generic_assumption"`
是**会话级**的。缺的是把它下放到**绑定级**。

---

## 10. 记忆：写入口只有一个，而且不在对话上

### 10.1 现状

| 记忆档 | 写入者 | 触发时机 |
|---|---|---|
| 项目长期记忆（晋升档） | `rememberDecision` | 人在 `decision.record` 里拍板 |
| 项目长期记忆（参考档） | `rememberRunLessons` | **只在梳理 run 完成/挂起时**（`pipeline/run.ts:714,751`） |
| 会话状态 | 各工具 | 本会话内 |
| 对话历史 | `DialogueMemory` | 每轮，超预算即 `compactToFit` 压成摘要 |

**对话层向长期记忆写的东西：只有人拍板的决定。** 模型在对话里分析材料得出的结论、
一起搭出来的通用模板、确认过的口径 —— 一律不进项目记忆。换个会话从零开始。

`memory/long_term.ts` 的三条纪律（晋升过闸、冲突不静默覆盖、不用就衰减）设计得
很好，**但对话层根本没接上这条路**。

### 10.2 你要的能力对应到哪

> "可以通过和 OntoCopilot 互动来拿一些需要问业务人员的材料，完成后再上传，
> OntoCopilot 需要具备记忆管理能力，能够记住分析后的材料内容"

这是一条**跨会话、跨材料批次**的增量精化流程，需要三样现在没有的东西：

1. **材料摘要记忆** —— `material.parse` 之后写一份**结构化摘要**（候选对象 / 口径 /
   阈值 / 角色 / 未定项）进项目记忆。否则第二批材料来的时候，第一批的 477 个切片
   要么重读一遍（贵），要么已经被 `compactToFit` 压没了（丢）。
2. **对话侧的 observe 通道** —— 模型推断进参考档，人确认走晋升闸。分岔点
   `memory/project.ts` 已经写好了，接上即可。
3. **模板版本谱系** —— 通用模板 → 补第一批材料 → 补第二批……每一步是谁改的、
   依据是什么。`revision` 表和 `snapshot_hash` 列都在（另一个会话正在补 `revision.diff`），
   缺的是把对话轮的变更也记成 revision。

---

## 11. 追加方案（与第一部分合并后的完整视图）

### P0-4 批量变更 op（**新增，且应最先做**）

> 依据：§8.2 的 55–85 次 vs 5 步；SagaLLM 的"工具调用即有界工作流"

给 `flow.edit` / `oir.add` 增加一个 `apply_patch` 批量 op：

```ts
flow.edit {
  op: "apply_patch",
  nodes: [{key,kind,label,stage,actor}, ...],
  edges: [{from,to,label}, ...],
  stages: [{key,title}, ...]
}
```

**必须是事务性的**：整批校验通过才落地，任一条不合法就整批拒绝并返回
`suggestions[]`（P0-1 的契约）。**不允许部分成功** —— 半张流程图比没有更糟，
因为它看起来像是完整的。

- 收益：55–85 次 → **2–4 次**，一轮对话内可完成。
- 验收：一次 `apply_patch` 建出 8 节点 10 边 3 阶段；注入一条非法边（指向不存在的节点），
  整批回滚且回执指出是哪一条。

### P0-5 `draft.initialize` 直接产出连通骨架（**新增**）

> 依据：§8.3 —— `SKETCH_SCHEMA` 已经强制 edges，管线现成

把 `flow.sketch` 的生成能力接进 `draft.initialize`：一次模型调用产出
stages + nodes + **edges**，直接写进 `_flow`，而不是开一张白纸。

- 保留全部诚实标记：`assertion_origin = generic_assumption`、`release_state = DRAFT`、
  caveats 进问题清单。
- 验收：`draft.initialize` 之后立刻导出，流程图**边数 > 0 且无孤立节点**；
  每个 Action 至少一条出边或入边。

### P1-3 绑定级的三态置信（**新增**）

> 依据：§9.1

`BindingStatus` 从 `unknown | confirmed` 扩成三态：

| status | 含义 | 问法 | 门禁 |
|---|---|---|---|
| `unknown` | 没人说过 | "请提供" | 阻塞发布 |
| `assumed` | 行业通识先填 | "请确认" | DRAFT 可带，RELEASED 不可 |
| `confirmed` | 材料证据或人确认 | — | 可发布 |

- `assumptionPolicy` 增加 `generic_assumed` 档；`gaps.ts` 按 status 分流两种问法。
- 这条同时让**审阅队列**的价值翻倍：确认题比提供题便宜得多，可以先批量清掉。
- 验收：通用模板生成后，`assumed` 槽位数 > 0（说明通识真的被写下来了），
  且导出的问题清单里"请确认"与"请提供"分开成两组。

### P2-3 连通性与完整性成为**被检查的不变量**（**新增**）

> 依据：MAST（44.2% 是系统设计问题）；DVR 把验证子图嵌进执行图

在 critic 里加一组结构规则（零模型调用，纯规则）：

| 规则 | 判据 | 违反时 |
|---|---|---|
| 无孤立节点 | 每个流程节点至少一条边 | 阻断导出，回执点名哪几个 |
| Event 有 producer | 每个 Event 有产生它的 Action | 生成"请确认"问题 |
| Action 有宿主对象 | 每个 Action 挂在 DataObject 上 | 同上 |
| 阶段归属完整 | 无「未分阶段」节点 | 警告 |
| 入口出口可达 | 从入口能走到至少一个终态 | 阻断 |

**关键：这些必须在导出/交付前拦，而不是在提示词里请求。** 那次生成的 0 边
Ontology 应该在导出那一刻就被拦下并说清缺什么。

### P2-4 对话层接上记忆写入（**新增**）

> 依据：§10；Anthropic context engineering 的 memory tools

1. `material.parse` 完成后写结构化摘要进项目记忆（参考档，走 `observe`）。
2. 对话中确认的口径/决定走 `rememberDecision`（晋升档，已有闸门）。
3. 新会话启动时按项目 `recall` 注入摘要，而不是重读切片。

- 验收：会话 A 传材料并分析 → 新建会话 B（同项目）→ B 在**不重读材料**的情况下
  答得出 A 里确认过的口径，且答案带"来自项目记忆，非本会话证据"的标记。

### P2-5 图注与来源（小，但该顺手做）

修 §8.4 那两处：图注列宽、普通样式、补一行 provenance。

---

## 12. 修订后的推进顺序

```
P0-4 批量变更 op ──┐
P0-5 连通骨架 ─────┼──> P2-3 连通性不变量（拦在导出前）
P0-1 结构化回执 ───┤
P0-2 能力边界 ─────┤
P0-3 预算解耦 ─────┘
                    └──> P1-1 只读并行 ──> P1-3 三态置信
                         P1-2 分层目录      P2-4 记忆写入通道
                                            P2-1 补偿链
                                            P2-2 承诺兑现检查
                                            P3   双控回归集
```

**顺序变了：P0-4 与 P0-5 排到最前。**

理由很直接 —— 并行（P1-1）优化的是"多快能调完工具"，而当前的瓶颈是
**调 80 次才够，预算只有 5 次**。先把 80 次压成 3 次，再谈并行；
否则 3.7× 的加速作用在一个错两个数量级的基数上，等于没做。

同样，P2-3 的不变量检查必须在 P0-5 之后立刻跟上：先让系统**能**生成连通的图，
再让它**必须**生成连通的图。反过来做只会得到一个永远拦住自己的门禁。

---

## 13. 第二部分新增参考

13. Wang et al. **Executable Code Actions**（对照：为什么我们不走这条路，见 §6）
14. **FAIL-TALMS** —— LLM 的能力边界意识缺失（转引自 survey 2603.22862）
15. **DVR / SagaLLM** —— 把验证子图与补偿逻辑嵌进执行图（同上）
16. Anthropic. **Effective context engineering for AI agents** —— memory tools 与
    上下文压缩，对应 §10 的材料摘要记忆

---
---

# 第三部分：反思能力与生成质量闭环

> 追加于 2026-08-18 深夜。触发点：让它画流程图，它一口气给了**四张几乎一样的图**，
> 而且每一张都是一次成型，没有任何自我检查。

## 14. 第三次解剖：四张一模一样的图

### 14.1 为什么是四张 —— 重放省了钱，但没省下卡片

仓库里其实**有**语义级的重放机制（`server/session.ts:585`）：

```ts
export function chatRecorderRunId(s, o: { kind, semanticInput }): string {
  return `chat_${s.id}_${o.kind}_${fingerprint(o.semanticInput).slice(0, 16)}`;
}
```

`flow.sketch` 传的 `semanticInput` 是 `{ domain, detail }`，而 `chatRun` 的
`resume` **默认就是 true**（`glue/chat_run.ts:79`）。也就是说：同样的
domain + detail 再调一次，模型调用会命中日志、不重新付费。**设计是对的。**

问题出在**副作用的位置**（`server/dialogue/tools.ts`）：

```ts
data = await deps.chatRun(s, { kind: "flow_sketch", semanticInput }, async (run) => {
  return (await run.gw.call("FLOW_SKETCH", ...)).data;   // ← 只有这一句在可重放的 body 里
});
// ↓ 下面全部在 body 外，每次调用都会重新执行
writeFileSync(join(outdir, svgName), svg);
s.emit("sketch.ready", { ... });                          // ← 每次都发一张新卡片
```

**结论：重放机制拦住了重复付费，但没拦住重复呈现。** 第 2/3/4 次调用可能一分钱
没花，却照样在聊天里堆出三张卡片、在活动流里记四条「参考流程图」。用户看到的是
系统在犯傻，而系统自己觉得自己很省。

再加一层：`semanticInput` 是**字面量指纹**。domain 写「采购报销」和「采购与报销」
是两个完全不同的 key，于是连省钱那一半也丢了。工具层没有任何"你刚画过这张"的
守卫。

> 对应 MAST 的 **Step Repetition（15.7%，系统设计类失败里的第二大项）**。

### 14.2 为什么没有反思 —— 生成路径上一个检查点都没有

`flow.sketch` 的完整生命周期：

```
一次模型调用 → graphFromSketch（只校验结构是否畸形）→ toSvg → 写盘 → 发卡片
```

`graphFromSketch` 只在**数据畸形**时抛错（引用了不存在的节点 key 之类）。
一张结构合法但**业务上很差**的图 —— 0 条边、所有节点堆在一个阶段、
gateway 出边没有条件、Event 没有产生它的 Action —— 会顺利通过，直接发给用户。

对照仓库自己的 `kernel/critic.ts`：它有规则档、有 rubric、有"生成模型 ≠ 评委模型"、
有 CRITICAL 档三采样多数票。**但这一整套只挂在梳理管线的产物上，对话层生成的东西
一次都不过。** 同一个仓库里，两条生成路径的质量门禁待遇完全不同。

### 14.3 更刺眼的一点：图再好，也没进 Ontology

截图里侧栏写着 `材料 0 ｜ 对象 0 ｜ 流程 0 ｜ 待审阅 0 ｜ 产物 0`，
而正文里模型刚刚给出了 **4 个阶段、7 个 Action、4 个 Event** 的完整流程。

这正是 §8.3 说的"两条路走反了"的实证：`flow.sketch` 生成质量其实不错
（第二版截图里的图有阶段、有边、有条件分支、有网关），但它被定位成"参考图"，
`不写进产物、不进交付包`。而真正写产物的 `draft.initialize` 开的是一张白纸。

**用户拿到了一张好图和一个空 Ontology。**

---

## 15. "让 AI 反思一下" —— 文献说这件事要分三类做

你的直觉是对的，但直接实现成"再问模型一遍你觉得行不行"会**变差**。这一点有硬证据。

### 15.1 关键反例：内省式自我纠正会掉点

**Huang et al., ICLR 2024, arXiv:2310.01798 —《Large Language Models Cannot
Self-Correct Reasoning Yet》**：在**没有外部反馈**的条件下让 LLM 自我纠正推理，
不仅普遍无效，**性能常常还会下降**。

这条直接否定了最省事的那个实现（在 prompt 里加一句"请检查并改进你的输出"）。

### 15.2 但 Self-Refine 在生成类任务上确实有效

**Madaan et al., NeurIPS 2023, arXiv:2303.17651**：同一个 LLM 做生成者、反馈者、
精炼者，7 类任务上人类与自动指标都更偏好精炼后的结果，**平均提升约 20%**。

差别在哪：Self-Refine 的有效场景是**质量是整体观感、且反馈可操作**的任务
（写作、对话、代码可读性）；Huang 的失败场景是**有唯一正确答案的推理**。

### 15.3 视觉产物：2026 年的答案恰好就是你说的"让 AI 看自己画的图"

| 工作 | 做法 |
|---|---|
| **IntroSVG**（CVPR 2026） | 同一个 VLM 兼任 Generator 与 Critic，`generate → critique → refine` 闭环，**让模型"看见"渲染结果**再自我修正 |
| **RefineSVG** | 把渲染结果与目标的**视觉残差**回灌成显式纠正信号，MLLM 从"被动代码生成器"变成"自纠正视觉 agent" |
| **Render-in-the-Loop** | 模型同时是"手"（写 XML）和"眼"（看画布），提出 Render-and-Verify 解码策略 |

**这正是你提的多模态 OCR 分析。** 而且我们**已经有全部零件**：
`onto/render.ts` 的 `svgToPng` 能栅格化，`material.parse {ocr:true}` 已经在调视觉
模型 —— 缺的只是把这条线接到自己生成的图上。

### 15.4 三分法（这是我建议的实现口径）

| 要检查的东西 | 用什么检查 | 成本 | 依据 |
|---|---|---|---|
| **结构正确性**：孤立节点、Event 无 producer、gateway 出边无条件、入口不可达终态、标签重复 | **确定性规则**，零模型调用 | 免费、无方差 | 仓库 ADR-5 已有此纪律；Huang et al. 说明这类不能交给自省 |
| **业务合理性**：阶段划分是否符合领域常识、有没有漏掉关键环节、caveats 是否切中要害 | **LLM critic，评委 ≠ 生成者**，rubric 打分 | 一次判决调用 | Self-Refine +20%；`critic.ts` 的 `judge_for` 已经强制换模型 |
| **视觉可读性**：节点重叠、连线交叉、标签截断、密度过高 | **渲染成 PNG 后交视觉模型看** | 一次视觉调用，可选 | IntroSVG / RefineSVG / Render-in-the-Loop |

**绝不做的**：在同一次调用里让模型"自己再想想"。那是 Huang et al. 明确证伪的那一档。

---

## 16. 追加方案

### P0-6 生成类工具的幂等与去重（**新增，几小时的活**）

> 依据：MAST Step Repetition 15.7%；§14.1

三处小改：

1. **副作用移进可重放的 body**：`writeFileSync` 与 `s.emit("sketch.ready")` 挪进
   `chatRun` 的回调里，让重放同时抑制重复卡片。
2. **语义归一化再做指纹**：`semanticInput` 用归一化后的 domain（复用我上一轮为
   表名解析写的 `normalizeTitle` 那套二元组归一），"采购报销"与"采购与报销"落到同一个 key。
3. **工具层加一条守卫**：同一会话内已经为相近 domain 画过图时，**不重新生成**，
   而是返回已有的那张 + 一句"要改哪里？"，并给出 `suggestions[]`（P0-1 的契约）。

- 验收：连续四次要"采购报销流程图"，只产生 **1 张卡片、1 次模型调用**；
  第 2–4 次的回执明确说"已有一张，是要改还是要重画"。

### P0-7 结构规则门禁挂到生成路径上（**新增**）

> 依据：ADR-5（可规则化的不给 LLM）；§15.4 第一行

把 §11 的 P2-3 连通性不变量**前移**，直接挂在 `flow.sketch` / `draft.initialize` /
`flow.edit(apply_patch)` 的出口：不合格就**不发卡片**，回执里点名缺什么，让模型重出。

规则表（全部零模型调用）：

| 规则 | 阈值 |
|---|---|
| 孤立节点 | = 0 |
| Event 有产生它的 Action | 100% |
| gateway 出边带条件 | 100% |
| 入口能走到终态 | ≥ 1 条路径 |
| 阶段归属 | 无「未分阶段」 |
| 标签重复 | = 0 |

- 验收：构造一份 0 边的 sketch 结构，必须被拦下且回执说明"缺 N 条边、M 个孤立节点"；
  重出一版合格的才发卡片。

### P1-4 业务合理性 critic（**新增**）

> 依据：Self-Refine +20%；`critic.ts` 的 judge≠generator 已经现成

结构过关后，用**另一个模型**按 rubric 打分（每条 0/1，不给自由分值 —— 压冗长偏差，
`critic.ts` 已经这么做）：

- 阶段划分是否覆盖该领域的主干？
- 有没有漏掉行业里普遍存在的关键环节（如采购的三方比价、报销的发票查重）？
- caveats 是否指向各家差异最大的地方（这是它对 FDE 的核心价值）？

不过关就**带着具体缺项重出一次**，最多两轮（防止 §3.4 提到的无效反思循环，
对应 SPIRAL/PreFlect 的做法）。

- 验收：注入一份"漏掉审批环节"的采购流程，critic 必须点名并在第二轮补上。

### P1-5 渲染回看：把图交给视觉模型（**新增，这是你提的那条**）

> 依据：IntroSVG / RefineSVG / Render-in-the-Loop（2026）

结构与业务都过关后，**可选**再走一步：`svgToPng` 栅格化 → 视觉模型看图 → 只回答
四个具体问题（不要开放式"你觉得怎么样"）：

1. 有没有节点框重叠？
2. 有没有连线穿过节点、或交叉到看不清？
3. 有没有标签被截断（末尾是省略号或半个字）？
4. 单个阶段里的节点是否密到读不出来？

有问题就调**布局参数**（阶段列宽、节点间距、换行阈值）重渲染 —— **注意：改的是
排版，不是改流程内容**。让视觉反馈去改业务语义是危险的，图看着丑不等于流程错。

- 成本控制：默认只在 `detail=detailed`（22–34 个环节）或用户明确说"图太乱"时才触发。
- 验收：构造一份 30 节点的密集流程，首次渲染必然重叠，回看后重排应消除重叠且
  不改变任何节点/边的语义（图的 mermaid 表示前后一致）。

### P1-6 让 sketch 的产出能"转正"（**新增，与 P0-5 是同一件事的两面**）

`flow.sketch` 生成的是好东西，但它进不了产物。加一条显式的**转正**动作：

```
flow.sketch → （FDE 看过、认可）→ draft.adopt → 写进 _flow/_oir，标 generic_assumption
```

- 保留全部诚实标记，转正**不等于**变成客户事实，只是从"聊天里的参考图"变成
  "DRAFT 状态的待验证草案"。
- 验收：转正后侧栏的 `流程` 计数 > 0，导出的 Ontology 包含这些节点与边，
  且每一项的 `assertion_origin` 都是 `generic_assumption`。

---

## 17. 三部分合并后的最终顺序

```
第一梯队（对症、天级、互相独立）
  P0-1 结构化回执 ── P0-2 能力边界 ── P0-3 预算解耦
  P0-6 幂等去重  ── P0-7 结构规则门禁

第二梯队（补齐"能生成一份完整 Ontology"这件事）
  P0-4 批量变更 op ──> P0-5 连通骨架 ──> P1-6 sketch 转正
                                        └─> P2-3 不变量拦在导出前

第三梯队（质量闭环）
  P1-4 业务 critic ──> P1-5 渲染回看
  P1-3 三态置信

第四梯队（编排与记忆）
  P1-1 只读并行 ── P1-2 分层目录
  P2-1 补偿链  ── P2-2 承诺兑现检查 ── P2-4 记忆写入通道
  P3   双控回归集
```

**建议先做第一梯队的 P0-6 + P0-7。** 理由：这两条加起来大概一天，却同时消掉
你这两轮提的三个现象 —— 重复出图、图没有边、生成物不过任何检查。而且 P0-7 的
规则表是 P1-4 / P1-5 的判据基础：先有确定性的"什么叫合格"，再谈让模型去评。

---

## 18. 第三部分参考

17. Huang, Chen et al. **Large Language Models Cannot Self-Correct Reasoning Yet.**
    ICLR 2024. arXiv:2310.01798 —— *内省式自我纠正无外部反馈时会掉点，本文最重要的反例*
18. Madaan et al. **Self-Refine: Iterative Refinement with Self-Feedback.**
    NeurIPS 2023. arXiv:2303.17651 —— 7 类任务约 +20%
19. Wang et al. **IntroSVG: Learning from Rendering Feedback for Text-to-SVG
    Generation via an Introspective Generator–Critic Framework.** CVPR 2026. arXiv:2603.09312
20. **RefineSVG: Visual Feedback-Driven Reinforcement Learning for Image-to-SVG
    Generation.** arXiv:2607.27699
21. **Render-in-the-Loop: Vector Graphics Generation via Visual Self-Feedback.** arXiv:2604.20730
22. Cemri et al. **MAST**（同 §3.3）—— Step Repetition 15.7%

---
---

# 第四部分：为什么它"没看图就瞎编了两个 Action"

> 追加于 2026-08-18。触发点：先让它画通用流程图（4 阶段 / 7 Action / 4 Event），
> 再让它"把模板里的 Action、Event 生成出来放进画布"，结果只加了 **2 个 Action、
> 0 个 Event**，而且要手动点刷新才看得到。

## 19. 五个根因（逐条有代码证据）

### 19.1 它**看不到**那张图 —— 草图画完就扔了

`flow.sketch` 的处理器：

```ts
g = graphFromSketch(data, { domain });   // FlowGraph 建出来了
const svg = toSvg(g, { title });          // 画成图
writeFileSync(join(outdir, svgName), svg);
s.emit("sketch.ready", { ... });
// ← g 到这里就结束了。没有任何一句把它写进 s.state
```

**那张图的结构从未进入会话状态。** 后续任何一次工具调用都读不到它 ——
`flow.query` 读的是 `_flow`（真产物），而 sketch 从不写 `_flow`。

于是当你说"把模板里的 Action、Event 生成出来"时，模型手上**只有自己上一条回答的
文字**。那段文字还要跟整个对话历史一起挤 `DialogueMemory` 的预算，随时会被
`compactToFit` 压成摘要。它不是"不去看图"，是**没有任何工具能让它看**。

> 这也解释了你怀疑的"硬编码"。我全仓搜过：`PurchaseRequisition` / `采购申请单`
> 在 `ts/src` 里**一个字都没有**，不是硬编码。但现象很像硬编码，因为模型每次都在
> 从同一段自己写的通用文字里**重新想一遍**，自然每次都想出差不多的名字。
> **根因不是硬编码，是没有可读的中间产物。**

### 19.2 它**没有**创建 Event 的工具

`onto/oir_edit.ts` 的全部 15 个 op：

```
add_object_type  add_property  add_link  add_rule  add_action_type  add_enum_value
edit_assertion   set_status    bind_rule set_action_scope
remove_object_type  remove_property  remove_link  remove_rule  remove_action_type
```

**没有 `add_event`。** `ts/src/onto/oir.ts` 里也没有任何 event 容器。

Event 实际上要走**另一条路**：`flow.edit { op:"add_node", kind:"event" }`。
而 `oir.add` 的描述写的是「加数据对象/属性/关系/Action/业务规则/枚举状态值」——
**没有一个字提到 Event 要去别处加**。

模型被要求"生成 Action 和 Event"，用 `oir.add` 加完 Action，找不到 event op，
于是 Event 就没了。**这不是模型偷懒，是工具面根本不提供这个动作。**

> 侧栏的 `Event 0` 与模型 taxonomy 里那个 Event 筛选器构成了一个错觉：
> UI 承诺了一类实体，编辑面却造不出它。

### 19.3 5 步预算，7 个 Action 只来得及加 2 个

§8.2 那笔账的又一次现场复现。截图里模型自己写了：

> "接下来我将继续将其余的核心动作……以及流程中对应的关键触发事件（Events）补全"

**它知道该做什么，只是没有预算做完。** 一个 `add_action_type` 一步，7 个 Action +
4 个 Event + 编排就是 15–20 步起，而它只有 5 步。

### 19.4 要手动刷新 —— 对话层的写入事件不在刷新白名单里

`ui/sse.ts` 的状态重取白名单：

```ts
["corpus.ready","corpus.restored","parse.failed","run.completed","run.failed",
 "run.suspended","run.cancelled","artifact.ready","human.recorded",
 "question.updated","question.answered","audit.applied"]
```

而对话层工具实际发的是：

```
draft.initialized  draft.updated  oir.edited  flow.ready  sketch.ready  template.edited
```

**六个里有六个不在白名单上。** 这些事件进得了活动流（`G.OPS`，所以你在"最近活动"
里看得到"改了本体"），但**永远不会触发 `/state` 重取**；`state_version` 在客户端
不变，右栏 `/context` 的 effect 也就不会重跑。

**这就是必须点刷新的全部原因。** 一行白名单的事。

### 19.5 信息不全 —— Action 只有名字，没有契约

截图里两个 Action 都只有 `apiName` + `displayName` + `applies`。而
`ontology_package.ts` 的 Action 契约要的是：调用者、作用对象、参数、preconditions、
effects、幂等策略、失败码、绑定的 role/system/platform/api/database。

`add_action_type` 的参数表根本没有这些槽位 —— 于是即使预算够，模型也只能造出
一个空壳 Action。**编辑面的表达力低于产物契约的要求**，这是 §9.1"未知要分两种"
在 Action 上的同一个病。

---

## 20. 追加方案

### P0-8 把对话层写入事件接进刷新白名单（**几分钟，先做这个**）

`ui/sse.ts` 的白名单补上 `draft.initialized / draft.updated / oir.edited /
flow.ready / sketch.ready / template.edited`。

- 风险：几乎没有。这些事件本来就代表"会话状态变了"。
- 验收：`oir.add` 之后右栏计数**不刷新也会变**。

### P0-9 草图必须落进会话状态（**这是 §19.1 的直接解**）

`flow.sketch` 把 `g` 写进 `s.state["_sketch"]`（与 `_flow` 分开，保持"参考图不是
产物"的定位），并：

1. 新增只读工具 `sketch.query` —— 让后续调用能读到阶段/节点/边的完整结构；
2. 回执里带上 `节点清单`（label + kind + stage），让模型**不必重新想**；
3. 与 P1-6 的 `draft.adopt` 打通：一句话把草图转正成 DRAFT 产物。

- 验收：画完图后问"刚才那张图里有哪些 Action"，模型能**逐字**列全 7 个，
  且不发生第二次生成调用。

### P0-10 补齐 Event 的编辑面（**§19.2 的直接解**）

两个选择，我建议**同时做**：

1. **短期**：在 `oir.add` 与 `flow.edit` 的描述里写明分工 ——
   "Action 用 `oir.add`；**Event 是流程节点，用 `flow.edit {op:'add_node', kind:'event'}`**"，
   并在 `oir.add` 收到 `op:"add_event"` 时返回 `code:"WRONG_TOOL"` +
   `suggestions:[{tool:"flow.edit", ...}]`（P0-1 的契约）。
2. **正解**：`flow_edit` 增加 `add_event` 语义糖（内部就是 `add_node kind=event`），
   并让它能同时声明 producer Action —— Event 的核心契约就是"谁产生它"。

- 验收：说"给这个流程补上 4 个关键 Event"，侧栏 `Event` 计数从 0 变 4，
  且每个 Event 都有 producer。

### P1-7 Action 契约槽位补齐（**§19.5**）

`add_action_type` 增加可选参数：`actor` / `preconditions` / `effects` /
`idempotency` / `failureCodes`，缺省时按 §9.1 的三态标 `assumed`（通用假设）
而不是 `unknown`。

- 验收：通用模板里的 Action 至少带 actor 与 effects，且都标 `assumed`、
  进"请确认"问题组。

---

## 21. 立即动手的顺序（本轮实施）

按"改动小 × 直接消掉你看到的现象"排：

| 序 | 项 | 现象 |
|---|---|---|
| 1 | **P0-8** SSE 刷新白名单 | 要手动刷新 |
| 2 | **P0-6** 副作用移进可重放 body + 语义归一 | 四张一样的图 |
| 3 | **P0-9** 草图落状态 + `sketch.query` | 没看图就瞎编 |
| 4 | **P0-10** Event 编辑面 | Event 0 |
| 5 | **P0-7** 结构规则门禁 | 图没有边也能过 |

后面的 P0-4（批量变更）与 P0-5（连通骨架）是同一处改动的两面，规模更大，单独一轮做。

---

## 22. 本轮实施记录（2026-08-18）与一处更正

| 项 | 状态 | 落点 |
|---|---|---|
| **P0-8** 对话层写入进 SSE 刷新白名单 | ✅ | `ui/sse.ts` 补 `draft.initialized/draft.updated/oir.edited/flow.ready/sketch.ready/template.edited` |
| **P0-9** 草图落状态 + `sketch.query` | ✅ | `_sketch`（活对象）+ `sketch.graph`（可落库），回执带逐字节点清单；新工具 `sketch.query`，会话重载后能从 dict 重建 |
| **P0-6** 重画守卫 | ✅ | 归一化领域名后判重，同一领域不重画；返回已有图 + "要改哪里" |
| **P0-10** Event 编辑面 | ✅ | `flow_edit` 新增 `add_event`（**一次建好事件 + 它的产生者边**）；`oir.add` / `flow.edit` 描述写明分工 |
| **P0-7** 结构门禁 | ✅（范围收窄） | `sketchDefects()`：分叉无条件 / 事件无产生者 / 环节重名；不合格不出图、不发卡片、不落状态 |

### 一处更正：`flow.sketch` 本来就比我说的严

写第三部分时我判断"生成路径上一个检查点都没有"。实测后要更正：
`graphFromSketch` **已经**拦掉了两类最严重的结构问题 ——

- `edges` 为空 → "只给了环节没给顺序，那不是流程图"
- 有节点没有任何连线 → "这些环节没有任何连线：…给它们补上前后顺序"

所以门禁真正补的只有三条（分叉无条件、事件无产生者、重名）。

**更要紧的推论**：你看到的那份 0 边、未分阶段的 Ontology **不是 `flow.sketch` 产的**
—— 它来自 `draft.initialize` + 逐条 `oir.add` / `flow.edit`，**那条路上一条结构校验
都没有**。同一套规则要接到那边去（P2-3），这是下一轮的事。

### 两处被现有测试挡回来的改动（都挡对了）

1. `flow.sketch` 里我一度用 `deps.now()` 记时间戳 —— 测试写着"不该碰 now"。
   它是对的：碰墙钟就破坏了 recorder 重放的前提。已去掉。
2. 我一度把 `add_event` 塞进 `oir.add` 的 op enum，好让处理器有机会"指路"。
   `schema 与 op 表双向对齐`那条契约拒了它 —— 也是对的：enum 里出现表外的名字，
   等于允许一批参数被静默丢弃。改成只在**描述**里指路 + `flow.edit` 自己 enum 里
   那个真实的 `add_event`。

---

## 23. 第二轮实施（2026-08-18 续）：批量变更与参考图转正

第一轮消掉的是"看得见的怪现象"；这一轮动的是 §8.2 那笔账 —— **55–85 次调用 vs
5 步预算**。

| 项 | 落点 | 效果 |
|---|---|---|
| **P0-4** `flow.edit / apply_patch` | `onto/flow_edit.ts` | 一次落 stages + nodes + edges；全程在 `flowFromDict` 副本上做，**整批成功才写回** |
| **P0-5** `draft.adopt` | `server/dialogue/tools.ts` | 把已画好的参考图整个转正成 DRAFT 产物，**零模型调用** |
| **OIR 批量** `oir.add / add_batch` | `onto/oir_edit.ts` | 一次落一批 `add_*`；原子性是白捡的（`applyOirEdit` 本来就在 trial 上跑、guard 过了才 refill） |

### 账重新算一遍

```
以前：draft.initialize（空白纸）
      + add_object_type ×5 + add_property ×15 + add_link ×6 + add_rule ×5
      + add_node ×10 + connect ×12 + set_stage ×10
      ≈ 55–85 次，而一轮只有 5 步 → 永远建不完，边永远排在最后

现在：flow.sketch（画骨架，含边）
      → draft.adopt（转正，0 次模型调用）
      → oir.add{op:add_batch}（对象/属性/关系/规则一次落）
      = 3 次
```

端到端用例 `从零到一份连通的通用 Ontology` 把这条路钉住了：**3 次工具调用**，
产出 `dangling() === []`、没有「未分阶段」节点、OIR 侧对象/属性/关系/规则齐全、
全程 `release_state=DRAFT` 且一条 evidence 都没有。

### 三条刻意的设计约束

1. **不允许部分成功。** 两个批量 op 都是要么整批落地、要么原图一个字节不动 ——
   半张流程图比没有更糟，因为它看起来像是完整的。测试直接比对操作前后的
   `JSON.stringify(toDict())`。
2. **批量只收 `add_*`。** 删除与改断言各有溯源讲究（材料抽出来的不能硬删），
   批量做等于把那些讲究一次绕过去。
3. **`draft.adopt` 不调模型。** 它用的就是屏幕上那张图。这保住了
   `draft.initialize` 当初选 `WRITE_LOCAL` 而不是 `EXTERNAL` 的那条理由
   （"不额外调模型"），也不必再为转正付一次钱。

### 被现有契约挡回来的地方（都挡对了）

- `golden/flow_extract.json` 与 `golden/onto.oir_edit.json` 里的 op 清单是钉死的，
  新增 `add_event` / `apply_patch` / `add_batch` 都要显式重取基线 —— 这正是它该有的
  行为：**能力扩容必须留下痕迹**。
- `OIR_EDIT_OPS 与实现同源` 那条不许 op 表和测试各抄一份，同样要显式更新。

### 一处差点写成假测试的地方

`OIR.objects` 是 **Map** 不是数组，我一度写成 `oir.objects.length`（恒为
`undefined`）。实测确认 vitest 的 `toHaveLength` 认 Map 的 `.size`、且数字写错时
**会失败**（拿 `Map(2)` 断言 99 确实红），所以断言是真的。记在这里，免得下次
看到 `toHaveLength` 用在 Map 上以为是错的。

---

## 24. 现在的状态与下一步

**已落地**（两轮共 11 项）：

- 实时刷新、幂等去重、草图可读、Event 编辑面、结构门禁
- 批量事务变更（flow + OIR）、参考图转正

**还没做**，按价值排：

1. **P2-3 把结构门禁接到编辑路径** —— 目前只挂在 `flow.sketch` 出口。
   `draft.initialize` + 逐条编辑那条路仍然没有校验，导出前也没拦。
2. **P1-3 绑定级三态置信**（`unknown` / `assumed` / `confirmed`）—— 通用模板的
   价值全在 `assumed` 上，现在被一律压成 `unknown`。
3. **P1-4 / P1-5 业务 critic 与渲染回看** —— 质量闭环。
4. **P2-4 记忆写入通道** —— 对话层至今只有人拍板的决定进项目记忆。
5. **P0-1 / P0-2 结构化回执与能力边界** —— 已在 `export.file` 上试过一次
   （`最接近的（71% 像）`），要推广成全部 32 个工具的统一契约。
6. **P1-1 只读并行** —— 现在才轮到它：基数已经从 80 压到 3，加速才有意义。

---

## 25. 第三轮实施：结构门禁下放 + 跨会话记忆

### P2-3 结构门禁接到编辑路径与交付闸 ✅

规则从 `flow_sketch.sketchDefects` **搬到 `FlowGraph.structureDefects()`** ——
生成、编辑、交付三条路共用一份判据，两处各写一遍迟早会漂开。

三条路的强度**刻意不同**：

| 路径 | 强度 | 理由 |
|---|---|---|
| `flow.sketch` 出口 | **硬拒**（不出图、不发卡片、不落状态） | 它该一次产出完整成品 |
| `flow.edit` 回执 | **软提醒**（`结构还差` + 补法） | 增量建图时中间态不合格很正常，硬拦就没法建了 |
| `release.check` | **硬闸**（判 BLOCKED） | 结构不合格的东西不该读成可交付 |

顺带修掉一条**永远走不通的指引**：`release.check` 原来写着"结构断链用 `model.lint`
单独查"，而 `model.lint` 注册在 `glue/tools.ts` 的另一个 registry 上，
**对话侧根本调不到**。已改成指向它真能调的 `flow.issues`。

> 这也补上了第三部分那条更正指出的缺口：用户看到的 0 边 Ontology 来自
> `draft.initialize` + 逐条编辑那条路，而那条路**以前一条校验都没有**。

### P2-4 跨会话记忆：对话层以前既不写也不读 ✅

实测确认：`server/dialogue.ts` 与 `onto/converse.ts` 里 **`recall` / `projectMemory`
一次都没出现**。`memory/long_term.ts` 那套设计得很好的三条纪律（晋升过闸、冲突不
静默覆盖、不用就衰减）对话层完全没接上。

补了两个端口 + 一个工具：

- `rememberObservation(s, content)` —— 参考档写入（模型推断，永不晋升）。
  `material.parse` 成功后写一条"已解析材料：X（N 个片段）"。**写失败不抛**。
- `recallProjectMemory(s, query)` —— 按 query 召回。
- **`memory.recall` 工具** —— 光写不读是没用的。它把 `authoritative`（人拍过板）
  与 `reference`（模型推断）**分开呈现**，并在描述里写死"没查到就是没有，
  不许因此说「我记得…」"。

分岔点仍然只有两个：人拍板走 `rememberDecision`（过晋升闸），模型推断走
`rememberObservation`（进参考档）—— 与 `memory/project.ts` 原本的设计一致。

---

## 26. 一个需要你拍板的契约问题：P1-3 三态置信

这一项我**没有动手**，因为它不是实现选择，是一次**交付契约变更**。

`ontology_package.ts` 里：

```ts
readonly status: "known" | "partial" | "unknown" | "confirmed_none" | "not_applicable";
assumptionPolicy: { const: "missing_is_unknown" }        // ← schema 里是 const
```

要把"行业通识可以先填"表达出来，有两条路，代价完全不同：

**方案 A：加 `assumed` 到 enum（= OntologyPackage v2）**
- 优点：语义最干净，`gaps.ts` 能直接分出"请确认"与"请提供"两组问题。
- 代价：`additionalProperties: false` + `enum` 的 schema 是**发布出去的契约**，
  严格校验的下游会当场拒收。`assumptionPolicy` 的 `const` 也必须跟着改 ——
  它现在字面写着"missing_is_unknown"，加了 `assumed` 这句话就不再成立。
  **这是 v1→v2，不是打补丁。**

**方案 B：status 保持 `unknown`，用 `source` 记来源**
- 优点：v1 内可加，下游不受影响。
- 代价：**不诚实**。binding 的注释写着"unknown 不伪造来源"，而
  `status:"unknown"` 配一个填了值的 `value` 是自相矛盾的 —— 等于把通识伪装成
  "不知道"，正是我们一直在防的那类事。

**我的建议是 A，但需要你确认两件事**：

1. 现在有没有**已经在消费 v1 包**的下游（Palantir 侧的 ingestion、或客户那边的
   校验脚本）？有的话要先谈版本迁移。
2. 愿不愿意接受 `ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES` 之外再多一套 v2 产物名，
   还是就地升 v1（更省事，但对已交付的包不友好）。

在你拍板之前，通用模板里的通识仍然只能落成 `unknown` —— 也就是说
**通用模板和空模板在 schema 上仍然没有区别**。这是目前最大的一处未解。

---

## 27. 第四轮实施：回执结构化、业务评审、只读并行

| 项 | 状态 | 落点 |
|---|---|---|
| **P0-1** 结构化失败回执 | ✅ | `notFound()` 统一 helper，应用在"找不到 X"那一类 |
| **P0-2** 能力边界自述 | ✅ | `session.status` 增加「这台机器做不到的」 |
| **P1-4** 业务合理性 critic | ✅ | `SKETCH_REVIEW_SCHEMA` + 换模型评审，只在 detailed 档 |
| **P1-1** 只读并行 | ✅ | `STEP_SCHEMA.tools` + `readOnlyBatch()`，Danger 作硬约束 |

### P0-1 的范围是**有意收窄**的

63 处 error 返回没有全改。判据是论文的适用面：Self-Reflective APIs 量化的是
**"校验失败后能自我修复"**那一类，而"梳理正在跑""还没有材料"这类**状态受阻**
的错误，给参数建议毫无意义（该做的是等或换动作），而且它们的措辞被 19 处
`toEqual` 钉死。

所以只改了"找不到 X"这一类：`flow.query` 的节点、`material.inspect` 的材料、
附图解析的图名 —— 都是模型拿自己转述的名字去调、然后猜一轮的地方。

一处细节：`material.inspect` 的 Python list repr 措辞是**被测试钉住的契约**，
结构化字段是**加上去的**而不是换掉的，对应测试从 `toEqual` 改成 `toMatchObject`
并写明了理由。

### P1-4 的三条节制

1. **评委必须换模型**（`run.smart`）—— 同一个模型评自己刚写的东西就掉进
   Huang et al. ICLR'24 那个坑。
2. **只在 detailed 档评** —— 6–10 个环节的 brief 图不值得再花一次判决调用。
3. **不自动重画** —— 评审意见如实给出，补哪几个环节是业务判断，该由 FDE 看一眼
   再定。自动补等于让模型替他做主。

评审跑不通时**静默降级**（图照出），因为它是加分项，不是门禁；门禁是上一层的
结构规则。

### P1-1 的安全边界写在类型里

`ConverseToolLike.spec` 增加了 `danger`，`readOnlyBatch()` 三条硬条件：
≥2 个工具、每个都在作用域里认得、每个 `danger === 0`。**取不到 danger 一律当成
不安全**（fail closed）。混进任何一个写类工具，整批退回串行。

这条判据来自注册表，不靠模型自觉 —— survey 2603.22862 的原话是并行"只有在
副作用被充分控制时才最有效"，我们把那个前提用已有的 `Danger` 分级表达进了类型。

`STEP_SCHEMA` 因此与 Python 产生了一处**声明过的分叉**。照本文件既有先例
（SYSTEM 提示那条）：摘掉 `tools` 之后仍逐字段比对 golden，另加一条用例钉住
并行批自己的安全语义（maxItems 4、只读、退回串行、依赖不能并行）。

---

## 28. 一个必须告诉你的观察：goldens 正在被并发重写

实施过程中发现 `golden/onto.converse.json` 在 **17:56** 被改写，内容正是我几分钟前
写进 `converse.ts` 的那句描述；`golden/budget.json` 与 `budget.extra.json` 的
mtime 是 **20:01**，而我全程没碰过 budget。`tools/golden/` 下有 `__pycache__`，
说明 Python 侧的 golden 生成器跑过。

**后果**：在另一个会话同时工作的这段时间里，"golden 拦住了漂移"**不是一个可靠
信号** —— 它可能只是被重新生成成了当前源码的样子。我这几轮里凡是动到 golden 的
地方（`add_event` / `apply_patch` / `add_batch` 三处 op 清单）都是**显式重取基线
并在提交信息里写明**，但如果生成器在背后跑，这种显式性会被冲掉。

建议你确认一下另一个会话在做什么，以及 golden 的重生成是不是有意为之。

---

## 29. 第五轮：全部做完

| 项 | 状态 |
|---|---|
| **P1-3** 绑定级三态置信 | ✅ |
| **P1-5** 渲染回看 | ✅ |

### P1-3：按你的决定做了，用影响面最小的方式

你两次确认后我按方案 A 实施，但把爆炸半径压到最小：

**渐进式契约。** `assumptionPolicy` 从 `const: "missing_is_unknown"` 变成
`enum: ["missing_is_unknown", "generic_assumed"]`，而**只有真的含 assumed 绑定的
包才会报后者**。材料驱动的包（绑定都有证据）走的还是 `knownBinding`，
输出一个字节没变 —— 已经在消费 v1 的下游看到的东西完全一样。
测试直接钉住了这条：`material.assumptionPolicy === "missing_is_unknown"`。

**顺带修掉一个自相矛盾**：Action 的 `bindings.role` 原来直接走 `knownBinding`，
于是通用草案里模型按通识填的执行角色被标成 `status:"known"` **却带着空
`evidenceIds`** —— 一个下游会当成客户事实的组合。现在它和 processNode 走同一条
`roleBinding`：有证据 → known，有值零证据 → assumed，没值 → unknown。

**问法也分开了**：assumed 的问题措辞是「请确认：…我们按行业通识填的是「部门负责人」，
对吗？」，unknown 的仍是「请提供」。答起来的成本差一个量级，把两类混成一句
等于把最便宜的一批问题也变贵了。

### P1-5：渲染回看

`GatewayLike.call` 加了 `images`（kernel 侧的网关本来就支持，只是没接到对话这条路）。
`flow.sketch` 在 detailed + png 档把渲染结果送给视觉模型，**只问四个具体问题**
（节点重叠 / 连线交叉 / 标签截断 / 太密），不问"你觉得怎么样" —— 开放式提问只会
得到"建议优化布局"这类没法执行的话。

**四个问题各自对应一个我们真有的旋钮**：降 detail 档、按阶段拆图、改短环节名、
调阶段顺序。没有的旋钮不许诺 —— 我没有做"自动重排"，因为 `toSvg` 的布局是内部
算的，没有间距参数可调；假装能重排就是又一次"承诺做不到的事"。

同样**不自动重画**：改哪个是产品判断，而且重画要再花一次生成调用。

### 三道关的最终形态

```
flow.sketch
  ├─ graphFromSketch   结构畸形          → 硬拒（本来就有）
  ├─ structureDefects  孤立/无条件/重名  → 硬拒，零模型调用
  ├─ 业务评审           漏关键环节        → 软报，换模型判，仅 detailed
  └─ 渲染回看           图读不清          → 软报，视觉模型，仅 detailed+png
```

强度从硬到软、成本从零到一次视觉调用 —— 越贵的关卡管越主观的事，这是
`kernel/critic.ts` 的 ADR-5 纪律在对话层的复刻。

---

## 30. 收尾状态

**五轮共 17 项全部落地**：实时刷新、幂等去重、草图可读、Event 编辑面、结构门禁
（生成/编辑/交付三档）、批量事务变更（flow + OIR）、参考图转正、跨会话记忆、
结构化回执、能力边界、业务评审、只读并行、三态置信、渲染回看。

**测试**：6287 passed / 2 failed，五轮共新增约 80 条用例。两条失败是
**本次工作之前就红的** `ui.build.test.ts` 冻结闸（钉在迁移期 blob 上，任何 CSS
改动都会让它红）。

**仍然悬着的一件事**：§28 说的 goldens 并发重写。在另一个会话同时跑的这段时间里，
"golden 拦住了漂移"不是可靠信号。这不是代码问题，是协作问题。

---

## 31. 收尾：两道红灯

### 31.1 goldens 并发重写 —— 核实结论：没有掩盖漂移

不写新机制，先查事实：

| 文件 | 谁改的 | 核实结果 |
|---|---|---|
| `flow_extract.json` | 我 | 只有一行：op 清单加 `add_event` / `apply_patch` ✅ |
| `onto.oir_edit.json` | 我 | 只有一行：op 清单加 `add_batch` ✅ |
| `loop.json` `agents.json` `onto.converse.json` `server.core.json` | 另一个会话 | 与 `loop.ts`(+23) / `agents.ts`(+82) 等真实源码改动对应 ✅ |

**没有发现被掩盖的漂移。** 我的两处重取基线是最小的、精确的；其余四处对应别人真实的
源码改动。

**为什么不加一个"防并发重写"的机制**：git 已经把每一次 golden 变化显示成 diff，
再加一层哈希清单只是把同一件事记两遍。这是**协作问题**，不是代码问题 —— 用代码
去假装解决它，只会多一个要维护的东西，以及一种"已经防住了"的错觉。

### 31.2 那道永远红的闸 —— 拆成"冻死的"与"要显式改的"

`verify-ui-shell.mjs` 原来断言「CSS + HTML 逐字节都不许变」，钉在迁移期 blob 上。
那在迁移期是对的；产品开始演进样式之后它就**永远红着**，而一道永远红的灯只会教会
所有人忽略红灯——它不再拦截任何东西。

改造后：

| 部分 | 钉在哪 | 理由 |
|---|---|---|
| DOCTYPE + `<head>` 到 `<style>` | **原件 blob，逐字节** | 实测至今一致，钉着零成本 |
| `</script>` 之后的整段尾巴 | **原件 blob，逐字节** | 同上 |
| CSS 正文 | `ui/shell.baseline.json` | 误改当场红；有意改要 `--accept` 并提交基线 |
| body 结构 | 同上 | 同上 |

**一处被工具自己纠正的判断**：我原以为 body 还冻着，拆开一比才发现它早就变了 ——
预览拖杆加了 `role="separator"` 与 `aria-*`，七页签的 `.phead` 整块被 React 侧栏
取代。两者都是有意的产品演进。**把它继续算成"不许变"正是这道闸失效的原因。**

还有一个隐藏 bug 顺带修掉：原来按"原件前缀长度"切窗口，隐含假设 CSS 长度不变。
CSS 一变长，`</style>` 就掉到窗口外（实测 indexOf 直接是 -1）。现在按每份文件
**自己的** `<style>` 边界切。

**证明它真的会红**（一道不会失败的闸没有价值）：

```
干净时                   → 退出码 0
改一处 CSS 字号后        → 退出码 1，报 "css 变了：基线 2206c0… ≠ 现在 5b9303…"
还原后                   → 退出码 0
```

### 31.3 `verify-ui-port.mjs`：用它自己的豁免机制

13 行原件内联 JS 找不到对应。**逐条去 ts/src/ui 里核实过**，全部有真实对应件 ——
逻辑活着，只是重构了（常量提取、加了形参、加了过滤参数）。所以写进 `EXPECTED`
豁免表并注明各自的去处，这正是这个工具设计好的机制。

一条自律：**为不理解的改动写豁免理由，等于用这道闸自己去掩盖回归**，那比让它红着
更糟。所以每条豁免都写明了对应件在哪个文件第几行。

工具自己也验这件事：`未命中的豁免 0 条` —— 我写的 13 条全部真的命中了原件里的行，
没有一条是凭空加的。

---

## 32. 最终状态

```
vitest run  →  6291 passed, 0 failed
```

**本会话第一次全绿。** 之前一直红着的两道 UI 闸，一道拆成了活的漂移检测器，
一道用它自己的豁免机制归位。
