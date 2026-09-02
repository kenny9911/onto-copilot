# OntoCopilot 面向 FDE 的工具 / Agent / 工作流缺口分析

**日期：** 2026-08-18
**基线：** `a5c6eaf` + 工作区未提交修改
**方法：** 从代码实测动作空间，不采信文档声明
**与既有文档的关系：** `OntoCopilot-FDE-Current-Coverage-and-Gap-Analysis-2026-08-17.md` 从**架构层**（Artifact Registry / Canonical vNext / Renderer / Adapter）切缺口；本文从**动作空间层**切 —— AI 手上有哪些工具、能回答 FDE 的哪类问题。两份是同一系统的两个正交切面。

> **当前状态提示：** §0–§9 保留了审计发现与逐步修复记录；其中“六个 FDE
> Agent 只做静态投影”是改造前基线。现行实现与仍然存在的边界以 §10 为准。

---

## 0. 一句话结论

> **OntoCopilot 的 30 个对话工具里，只有 1 个能回答判断题。**
>
> *（2026-08-18 更新：本文列出的第一批 5 个判断题工具已落地，现为 6 个。见 §6。）*

其余 29 个分成两类：读材料（6）、读产物（5）、改产物（14）、交互输出（4）。真正做跨实体比较、汇总、推断并给出**结论**的，全库只有 `impact.trace` 一个。

而 FDE 一天里最难、最值钱的问题恰恰全是判断题：

- 「这两个对象是不是一回事？」
- 「这两份材料为什么矛盾，哪份算数？」
- 「我改了这个阈值，哪里跟着变了？」
- 「现在能交付了吗？」
- 「这张表的主键稳不稳？」

今天系统对这些问题的应对方式是：**让模型自己去 `evidence.search` 捞几段原文，然后凭上下文判断**。这是把确定性计算交给了概率生成，也是当前产品最大的可信度风险 —— 不是答错，是**答得像对的**。

---

## 1. 今天的动作空间（实测）

### 1.1 对话回合实际拿到 30 个工具

`ConversationAgent` 的默认 scope 是 `readonly`（`onto/converse.ts:664`），`ToolRegistry.forScope` 返回 `scopes["*"] ∪ scopes["readonly"]`（`kernel/tools.ts:650`）。据此实测：

| 类别 | 数量 | 工具 |
|---|:--:|---|
| 读材料 | 6 | `material.list` `material.parse` `material.inspect` `material.rows` `evidence.search` `evidence.rows` |
| 读产物 | 5 | `oir.query` `flow.query` `flow.issues` `template.query` `session.status` |
| 改产物 | 14 | `oir.add/edit/undo` `flow.edit/undo/preview/sketch` `template.edit/undo/recompile` `decision.record` `suggestion.apply` `draft.initialize` `build.start` |
| **判断分析** | **1** | **`impact.trace`** |
| 交互输出 | 4 | `ui.table` `export.file` `question.next` `question.answer` |

改产物类只在工作模式给（`RW = ["converse"]`，`server/dialogue/tools.ts:216`），聊天模式只有只读那一批。

### 1.2 授权表是声明式的，只对一个工具真正生效

> **勘误：** 本文初版称「`profile.column` 在对话里拿不到」。**该结论是错的**，已实测推翻。

`TOOL_SCOPES`（`kernel/agents.ts:821`）声明了每个作用域该有哪些工具，但 `builtinRegistry` 里**只有 `code.exec` 显式传了 `scopes:`**，其余四个（`evidence.search` / `evidence.rows` / `oir.query` / `profile.column`）都用默认的 `["*"]` 注册。实测 `forScope("readonly")`：

```
readonly   evidence.rows  evidence.search  impact.trace  oir.query  profile.column
extract    evidence.rows  evidence.search  impact.trace  oir.query  profile.column
analyze    code.exec  evidence.rows  evidence.search  impact.trace  oir.query  profile.column
```

所以实际情况与初版判断**方向相反**：`profile.column` 在对话里拿得到；`TOOL_SCOPES` 声明的限制对它并未生效。

这仍是一处值得记的差异，但性质是**最小权限的声明与实施不一致**（安全卫生），不是「FDE 拿不到答案」（产品能力）。`agents.ts:844` 的注释称「这里把它变成真的授权依据」，就目前而言只对 `code.exec` 成立。

`code.exec` 被限制在 `analyze / compile` 是**对的**：材料是不可信输入，一段伪装成业务说明的指令就能诱导直接读材料的 agent 调它（`serve.ts:370`）。

### 1.3 勘误二：「回答完问题下游什么都不发生」是错的

> 本文初版把这条列为「主闭环最大的断点」。**该结论是错的** —— 它照抄自更早的文档，未经代码验证。

实读 `server/routes/questions.ts` 的 `answerDomainQuestionOnce`，一次回答按顺序触发：

1. `repo.recordDecisionV1` —— Decision 落库，带幂等键；
2. `applyDecision(oir, target, optionId)` —— **真的写回 OIR**；
3. 预期受影响集合与实际不符时 **fail closed**，并把 Decision 终结为 `failed`，「人回答过但没生效」在审计里看得见；
4. `oq.answer = byUser(...)` —— OpenQuestion 回填；
5. `q.transition(ANSWERED)` + `saveQuestionDomain`；
6. `repo.appendRevision` —— **追加一条耐久 Revision**（`kind: "question_answer"`，带 `changedIds` 与 `invalidatedArtifacts`）；
7. `deps.recompile(s, { preserveQuestionRows: true })` —— **重算**；
8. `refreshAuthoritativeQuestionState` —— 以 repo 行为权威重刷；
9. `s.status` 更新、`persist`、`emit("question.answered", { question, decision, pending, affected })`。

这条链路比初版描述的完整得多。**教训**：本文 §5 说「先把已经算出来的说出来」，而这两处勘误本身就是同一个毛病的产物 —— 照抄了一份没有验证的结论。凡是「系统不做 X」这类否定判断，都必须回到代码验证后才能写。

### 1.3 Agent：13 个 spec，6 个确认不跑模型

`BUILTIN_AGENTS`（`kernel/agents.ts:585`）13 个：

- 流水线 7 个：`extractor` `rule_miner` `aligner` `conflict_hunter` `clarifier` `action_drafter` `auditor`
- FDE 专业 6 个：`fde_interviewer` `process_modeler` `erp_mapper` `rule_engineer` `data_steward` `delivery_reviewer`

后 6 个在 `engagement_runtime.ts` 里走 `skipModel`，是确定性投影而非模型分析（`engagement_runtime.ts:8`、`:283`）。可直接观察到的症状：`implementation_kind` 恒 `UNKNOWN`（`:441`）、`sensitivity` 恒 `UNKNOWN`（`:523`）、`authority` 恒 `UNKNOWN`（`:327`）。

**这个状态是对的，不该急着改。** 在没有金标之前接模型，第二轮材料理解是变好还是变坏没有任何判据。但它意味着：**今天 OntoCopilot 事实上只有一处模型理解（EXTRACT），六个"FDE 专业 agent"是名字不是能力。**

### 1.4 工作流：3 条

| 工作流 | 位置 | 状态 |
|---|---|---|
| 主流水线 `PARSE→EXTRACT→MERGE→ALIGN→CONFLICT→GAP→FINISH→EXPORT` | `onto/pipeline.ts` | 真跑；模型只在 EXTRACT |
| 对话推理循环 `single_shot / react / plan_execute` | `onto/converse.ts:410` | 真跑 |
| FDE Engagement DAG（10 节点） | `onto/engagement.ts:90` | 调度/checkpoint/HITL/gate 真跑，节点内是投影 |

---

## 2. FDE 问题图谱：今天答得了什么

按项目阶段分六组。「今天」列只写实测能力，不写文档声明。

### A. 进场与定范围

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 客户到底要解决什么？成功怎么衡量？ | ❌ 无 Mission/Outcome/KPI 一等对象 | 缺数据模型 + 工具 |
| 这次做什么、不做什么？ | ❌ agent schema 里有 `in_scope/out_of_scope`，但投影恒空 | 缺工具 |
| 谁能拍板？谁是 owner？ | ❌ `stakeholders` 恒空 | 缺工具 |
| 明天 workshop 先问什么？ | 🟡 `question.next` 给下一条，无议程 | 缺工作流 |
| 现在还缺哪些材料？ | ❌ `material.list` 只列已有的，不推缺的 | 缺工具 |

### B. 读材料、建事实基线

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 有哪些材料，读进来多少？ | ✅ `material.list`（三档状态分开） | — |
| 这个结论从哪来的？ | ✅ `evidence.search/rows` + locator | — |
| 哪些是事实、哪些是推断？ | ✅ Assertion 分层 + `grounded` 标记 | — |
| 两份材料为什么矛盾？哪份算数？ | 🟡 冲突检测在流水线里跑，**对话侧无查询出口** | 缺工具 |
| 这张表主键稳不稳、枚举全不全？ | ❌ `profile.column` 授权错配，对话拿不到 | 缺工具 + 修授权 |

### C. 还原流程

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 实际流程怎么走？ | 🟡 `flow.query`，但抽取依赖编号步骤/结构字段 | 缺 agent |
| 例外、返工、手工补救有哪些？ | ❌ `FlowNode` 无 `pathKind`，例外与主路径同构 | **缺数据模型** |
| 哪些步骤是手工/线下/重复录入？ | ❌ 无 manualness 建模 | 缺数据模型 + 工具 |
| 卡在哪、为什么？ | 🟡 `flow.issues` 查图上病灶（死路、无标签分支） | 部分覆盖 |
| As-Is 与 To-Be 差在哪？ | ❌ `FlowNode` 无 variant，全库一张图 | **缺数据模型** |

> **顺序约束：** C 组的三个 ❌ 都是数据模型问题，不是工具问题。`FlowNode` 今天只有 `rid/kind/label/code/stage/actor/objects/endpoint/status`（`onto/flow.ts:162`），`FlowEdge` 只有 `label` 没有条件表达式（`:219`）。**在 FlowNode 加 `variant` / `pathKind` / `manualness` / `sla` 之前，任何 `flow.diff`、`flow.painpoints` 工具都无处取数。**

### D. 建 Ontology

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 该有哪些对象？ | ✅ `oir.query` + EXTRACT | — |
| **这两个是不是一回事？** | ❌ aligner 在流水线内部合并，FDE 无法主动问 | 缺工具（**最高频**） |
| 关系是什么？基数？join key？ | 🟡 只从显式字段建关系，无候选推断 | 缺工具 |
| 这个 Action 谁能做、前置条件、副作用？ | 🟡 `action_drafter` 从 OpenAPI 反推，契约字段不全 | 缺模型字段 + agent |
| Event 谁发谁收？ | ❌ 无 producer/consumer 建模 | 缺数据模型 |
| 这条规则怎么算？ | 🟡 `rule_miner` 挖出规则，无归一表达式/测试用例 | 缺工具 |
| 哪个系统是权威源？ | ❌ `authority` 恒 UNKNOWN | 缺 agent |
| 有什么孤儿/断链？ | 🟡 `gaps.ts` 有 8 类，**对话侧无出口** | 缺工具 |

### E. 决策与收敛

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 还有什么必须问客户？ | ✅ `question.next` + backlog | — |
| 这个口径谁定的、什么时候？ | ❌ 有 `decision.record` 写，无查询 | 缺工具 |
| 我改了这个，哪里跟着变？ | ✅ `impact.trace`（纯图遍历，零编造） | — |
| **上一版到这一版变了什么？** | ❌ 全库无 diff 函数 | 缺工具 |
| 回答完问题，产物变了吗？ | ✅ 变了（见下方勘误二） | — |

### F. 交付

| FDE 的问题 | 今天 | 缺口性质 |
|---|---|---|
| 现在能交付了吗？ | 🟡 release gate 在 REVIEW/EXPORT 真跑，**对话侧问不到** | 缺工具 |
| 给我下载 X | 🟡 md/csv/xlsx/docx 真实；**PDF 生产未接线，调用即抛** | 接线或摘掉声明 |
| 这 JSON 能直接进 Foundry 吗？ | ❌ 无 target adapter | 缺 adapter 层 |

> **PDF 证据：** `toPdf` 在 `_pdfRenderer === null` 时抛 `ExportDependencyMissing`（`onto/export.ts:1204`）；全仓库只有 `ts/test/onto.export.test.ts` 调过 `registerPdfRenderer`，`serve.ts` 从未接线。格式表里 `pdf` 却与 md/csv/xlsx/docx 并列（`:1240`）。**这是"声明了但不可用"，必须二选一。**

---

## 3. 该建什么

### 3.1 判断题工具层（12 个，最高优先级）

这一层的共同特征：**输入是已有产物，输出是结论 + 依据，零模型或低模型**。它们把今天靠模型即兴判断的事情变成可复现的计算。

| 工具 | 回答的问题 | 输入 → 输出 | 为什么必须是工具 | 依赖 |
|---|---|---|---|---|
| `entity.compare` | 这两个是不是一回事？ | 两个 rid → 定义/键/粒度/时间语义/单位/来源/样例并排 + 合并或分离建议 + 置信度 | FDE 最高频判断题；今天只能让模型捞原文目测 | 无 |
| `conflict.query` | 哪两份材料矛盾？哪份算数？ | 过滤条件 → 冲突项 + 双方证据 + 生效时间/权威比较 | 冲突已在流水线算出来了，只是没有出口 | 无 |
| `model.lint` | 模型里有什么断链？ | — → 孤儿对象、无消费者事件、无 action 的步骤、无对象的规则 | 同上，`gaps.ts` 已算，缺出口 | 无 |
| `revision.diff` | 上一版到这一版变了什么？ | 两个 revision → 语义 diff（新增/删除/改口径/改阈值） | 全库无 diff 函数；无它则「改了什么」不可审计 | 无 |
| `decision.query` | 这个口径谁定的？ | 过滤条件 → Decision + 回答人 + 时间 + 替代关系 | 只写不读 | 无 |
| `release.check` | 现在能交付了吗？ | — → blocking 清单 + schema/ref 校验 + 证据覆盖率 | gate 逻辑已在 DAG 里，对话侧问不到 | 无 |
| `artifact.list` | 有哪些产物、什么版本？ | — → kind/format/revision/hash/验证状态/下载链接 | 下载卡今天答不出「从什么生成、能否重现」 | ArtifactRef |
| `profile.table` | 这张表主键稳不稳？ | 表名 → 键候选、粒度、枚举、行数、异常值 | 列级已有，表级判断缺 | `profile.column` |
| `material.gaps` | 还缺哪些材料？ | 目标产物 → 反推所需材料类型 vs 已有 → 缺件清单 + 建议 owner | 从「有什么」到「该有什么」是不同计算 | 目标产物定义 |
| `link.suggest` | 这两个对象什么关系？ | — → 候选关系 + 基数 + join key + 置信度（列名/值域重叠/profiling） | 今天只从显式字段建关系，隐式关系全丢 | `profile.table` |
| `flow.diff` | As-Is 与 To-Be 差在哪？ | 两个 variant → 节点/边/角色/系统差异 | — | **FlowNode.variant** |
| `flow.painpoints` | 哪些步骤是手工的、卡住的？ | — → 手工/线下/重复录入/等待步骤排序 | — | **FlowNode.manualness/sla** |

**修一条授权：** 把 `profile.column` 加进 `TOOL_SCOPES.readonly`。它只读、不出网、不改状态，被排除是错配不是设计。

### 3.2 项目事实工具层（4 个）

FDE 的项目上下文今天散在 agent schema 和自由文本里，不是可持续维护的一等对象。

| 工具 | 回答的问题 |
|---|---|
| `scope.state` / `scope.set` | 客户要什么？做什么不做什么？KPI 和验收条件？ |
| `stakeholder.map` | 谁是业务/流程/数据/技术 owner？RACI？ |
| `system.landscape` | 有哪些系统、谁是权威源、同步方向？ |
| `glossary.query` | 「有效金额」在这个项目里是什么口径？谁定的？ |

### 3.3 Agent（5 个新增，全部有前置条件）

> **硬前置：** 每个要接模型的 agent，先有金标。零标注也能立刻加的一条基线：同一份材料跑两遍，OIR 的 `api_name` 集合 Jaccard ≥ 0.95。**没有这条，接模型之后无法判断变好还是变坏。**

| Agent | 干什么 | 为什么现有 agent 不够 |
|---|---|---|
| `interview_synthesizer` | 从访谈纪要、邮件、聊天记录还原流程步骤 | `flow_extract` 依赖编号步骤和结构字段；真实项目里流程只存在于人脑和纪要里 |
| `exception_hunter` | 专挖例外路径（「如果…怎么办」「退回」「人工补」） | 现有抽取偏向主路径，例外是 FDE 最容易漏、客户最容易痛的部分 |
| `authority_arbiter` | 同一事实多份材料谁算数（生效时间/权威级别/适用范围） | 冲突检测能发现矛盾，不能判定采信哪个 |
| `rule_compiler` | 自然语言规则 → 归一表达式 + 输入 + 单位 + 测试用例 | `rule_miner` 挖出规则文本，不产出可执行/可测试形态 |
| `sor_analyst` | 字段级权威源判定 | `authority` 恒 UNKNOWN |

**六个现有 FDE agent 的升级路径**（沿用既有文档 P1-2 的判断，补触发条件）：保留一次基础抽取，**只对缺口、低置信、高风险部分**触发专业 agent；每个专业结论写成 Assertion + Evidence + Question，**不直接覆盖 canonical**。

### 3.4 工作流（4 条新增）

| 工作流 | 解决什么 | 优先级 |
|---|---|---|
| ~~`answer_propagate`~~ | ~~回答问题 → 重算受影响项 → 生成新 revision → 报告变了什么~~ | **已存在**，见勘误二 |
| `workshop_prep` | 缺口 → 按阻塞度/信息增益/影响面排序 → 议程（问谁、为何问、答案 schema） | 高。FDE 明天就要开会 |
| `evidence_reconcile` | 冲突 → 仲裁（时间/权威/范围）→ 定不了的转 question | 高 |
| `process_reconstruct` | 多源（SOP + 纪要 + 日志 + BPMN）→ 步骤聚类去重 → 主路径 + 例外 + 置信度 | 中。依赖 3.5 的数据模型 |

### 3.5 数据模型前置（不做则上面一半工具无处取数）

| 改动 | 解锁什么 |
|---|---|
| `FlowNode.variant`（as_is / to_be / option） | `flow.diff`、As-Is/To-Be 对比 |
| `FlowNode.pathKind`（happy / exception / compensation） | `exception_hunter`、例外路径可视化 |
| `FlowNode.manualness` + `slaSeconds` + `frequency` | `flow.painpoints`、改进候选排序 |
| `FlowEdge.condition`（条件表达式，不只是 label） | 规则 → 网关的可追踪影响 |
| Event 的 producer / consumer / payload | Event 契约问题 |
| Action 的 actor / precondition / effect / idempotency / compensation | Action 契约问题 |

### 3.6 一条横切协议：Answer Card

既有文档 §3.6 提出了八层回答结构（结论 / 证据 / 事实分层 / 结构化结果 / 冲突与未知 / 影响 / 建议 / Artifact 信息）。今天对话层只有 `answer + citations + confidence + followup + nextQuestions`，且最终回复会截断 citation。

建议把八层**固化成核心回答的输出契约并加 critic 校验**，而不是留在提示词里靠自律。理由与 `checkGrounding`（`converse.ts:248`）一致：纪律靠结构保证，不靠提示词。

---

## 4. 建议顺序

| 批次 | 内容 | 判据 |
|---|---|---|
| **0** | 修 `profile.column` 授权；PDF 接线或从格式表摘掉 | 半天；消除两处「声明了但不可用」 |
| **1** | `entity.compare` `conflict.query` `model.lint` `decision.query` `release.check` | 五个都是**已有数据 + 零模型**，纯出口问题，收益/成本比最高 |
| **2** | `revision.diff` + `answer_propagate` | 补主闭环最大断点：回答之后产物真的动 |
| **3** | 抽取金标集（Jaccard 基线起步） | **一切接模型工作的前置** |
| **4** | Flow 数据模型扩展 → `flow.diff` / `flow.painpoints` / `exception_hunter` | 数据模型先于工具 |
| **5** | 项目事实工具层 + `workshop_prep` | 从「初稿工作台」走向「Engagement 系统」 |
| **6** | `link.suggest` `rule_compiler` `sor_analyst` + 专业 agent 选择性触发 | 依赖批次 3 的金标 |

---

## 5. 一个必须守住的判断

批次 1 的五个工具全部是**零模型**的：数据已经算出来了，缺的只是查询出口。这不是巧合 —— 它反映了当前系统的真实形态：

> **OntoCopilot 算出来的东西，比它说得出来的多。**

`conflict.ts` 的八类冲突、`gaps.ts` 的八类缺口、`aligner` 的 uncertain 对、release gate 的 blocking 判定 —— 这些结论今天都真实存在于内存里，但 FDE 在对话里问不到。

先把已经算出来的说出来，再去算更多。这个顺序比反过来便宜一个数量级，而且不引入任何新的编造风险。


---

## 6. 落地状态（2026-08-18）

批次 0 与批次 1 已实现，全部 TDD，`tsc` 通过，全量回归回到基线。

| 工具 | 位置 | 测试 | 说明 |
|---|---|---|---|
| `entity.compare` | `server/glue/tools.ts` | `server.glue.entity-compare.test.ts`（6） | 逐字段并排 + 双方出处 + 信号；**不替人决定** |
| `model.lint` | `server/glue/tools.ts` | `server.glue.model-lint.test.ts`（7） | 6 类结构病灶；空 OIR 说「还没抽过」不说「已确认健康」 |
| `conflict.query` | `server/dialogue/tools.ts` | `dialogue.judgment-tools.test.ts`（6） | 按类型/subject 过滤；**全量分布始终可见** |
| `decision.query` | `server/dialogue/tools.ts` | 同上（4） | 含被推翻的决定与推翻链 |
| `release.check` | `server/dialogue/tools.ts` | 同上（4） | 明说**哪几道门没在这儿查** |
| 导出能力矩阵 | `onto/export.ts` + `dialogue/ports.ts` | `onto.export-capability.test.ts`（8） | `availableFormats()` 与 `FORMATS` 分离 |

### 三条贯穿这批实现的纪律

1. **「查不到」绝不渲染成「健康」。** `conflict.query` 用 `state["conflicts"]` 这个键在不在来区分「没跑过」和「跑了零冲突」；`model.lint` 对空 OIR 说「还没抽过」；`release.check` 空产物时结论是 `NOT_STARTED` 而不是 `READY`。
2. **过滤视图不掩盖全局。** 按类型筛出 2 条时，`总数` 和 `分布` 仍是全量 —— 否则过滤视图会被当成全貌。
3. **说清楚没查什么。** `model.lint` 返回 `checked` 列出查了哪 6 类；`release.check` 返回 `本工具未覆盖`，点名 schema 校验/引用完整性/证据覆盖/敏感信息扫描在 DAG 的 REVIEW/EXPORT 节点。只报自己看得见的门却让人读成「全绿」，比漏报更难发现。

### 导出能力矩阵的一个设计选择

没有采用「把 pdf 从 `SPECS` 删掉」这个更简单的做法。删了之后 `resolveFormat("pdf")` 返回空，用户问 PDF 会拿到泛泛的「不支持的格式」，比现有那句具体的「这台机器上导不出 pdf：没接排版器」更差。

最终实现是**照常能解析，只是不宣传**：`FORMATS` 保持全集供解析，新增 `availableFormats()` 供宣传；`export.file` 的参数说明与推荐句都按后者生成，并在 pdf 不可用时**明说**「这台机器导不出 pdf，他点名要就直接告诉他并给 docx —— 别先答应再失败」。触发例子里仍保留「导出成 pdf」的说法，否则模型认不出这个意图。

### 还没做的

批次 2 起全部未动：`revision.diff`、`answer_propagate`（主闭环最大断点）、抽取金标集、Flow 数据模型扩展、项目事实工具层。顺序与判据见 §4。

---

## 7. 真实数据检验（2026-08-18）

§6 的五个工具全部通过了 TDD，也全部在合成 fixture 上是绿的。拿 `workspace/ontocopilot.db` 里的真实会话跑一遍之后，**四个工具各暴露一个缺陷，而且是同一族**。

用的真实数据：最大会话的 OIR（175 对象 / 0 属性 / 0 关系 / 110 行动 / 28 规则 / 192 未答问题）与它的 463 条冲突。

### 7.1 四个缺陷

| 工具 | 真实数据上的表现 | 根因 |
|---|---|---|
| `model.lint` | 515 条 findings，其中 175 条「孤儿对象」+ 175 条「没有主键」是**同一个系统性事实说了 350 遍**；截断到前 80 条后模型只看得到 `orphan_object`，永远不知道「关系层是零」 | 把系统性缺失报成个体病灶 + 按迭代顺序截断 |
| `conflict.query` | 463 条冲突只返回 60 条，59 条 `missing_required` + 1 条 `missing_action`；184 条 orphan 和 76 条 naming_violation **一条都没露面**。而那唯一 1 条 `ask_user`（真正要人拍板的）能进来纯属运气 | 按迭代顺序截断 + 分布按 kind 而非 handling |
| `entity.compare` | 4 对**显示名完全相同、只有 apiName 不同**的对象（采购合同 ×2、采购订单 ×2…）被报成泛泛的 `differs`,读起来像「这俩不一样」——正好反了。且 description 直接吐几百字抽取理由 | 信号分类太粗 + 长文本不设限 |
| `release.check` | 输出里「阻塞项 0 条」与紧挨着的产物统计「open_questions: 192」**并排出现、自相矛盾** | 只读 `question_backlog` 一个来源，台账没同步时把「不知道」当成「没有」 |

### 7.2 共同根因

> **合成 fixture 里每类只有 1–3 个实体 —— 比例、截断、优先级这三件事全都测不出来。**

三条只在真实规模下才成立的判据：

1. **比例**：175/175 是一个系统性事实，3/175 是三个信号。同一段代码，同一个检查，结论性质完全相反。
2. **截断**：任何 `slice(0, N)` 在真实规模下都会变成「第一类占满名额」。必须**分层**取。
3. **优先级**：463 条里那 1 条要人拍板的，不排最前就等于不存在。

### 7.3 五处修正

- `model.lint`：命中率 ≥90% 且基数 ≥10 的检查收敛成一条 `systemic` 结论（带计数与例子）；零关系单独报 `no_links_at_all`；截断改为按 kind 轮转分层。真实数据从 515 条噪音变成 **3 条结论**，而 `counts`/`total` 仍是全量。
- `conflict.query`：新增 `按处置` 分布与 `handling` 筛选参数；`ask_user` 排最前，其余按 `POLICY.irreversibility`；分层截断。真实数据上四类各 20/20/19/1，唯一那条 ask_user 排第一，且 `handling=ask_user` 直接回答「还有什么必须我拍板」。
- `entity.compare`：新增 `naming_variance` 信号（业务名相同、技术编码不同 = 最强合并候选），但**口径冲突压过它** —— 同名而口径不同时若读成「只是编码不一样」，就把最贵的错误伪装成一次无害重命名；长文本截断到 140 并复用 `undescribedDiff` 给「差在哪几个字」，片段各自封顶 60。
- `entity.compare`：一边有一边空时**不算差异片段** —— 那时 opcodes 只会把有内容那一边整段吐出来，比不给还糟（真实数据上出现过 250 字的「片段」）。
- `release.check`：检测台账与 OIR stats 的跨来源不一致，**取较严值**并明说原因，不再输出自相矛盾的 0。

### 7.4 该记住的

本文 §5 说「先把已经算出来的说出来」。这一轮补一条同等重要的：

> **说出来之前，先拿真实规模的数据看一眼你说的是什么样子。**

TDD 保证了「行为符合我写的预期」，但预期本身是在 3 个实体的世界里写的。真实数据不是用来「验证」的，是用来**发现预期写错了**的。

---

## 8. 对抗式核查：答复链路与 `revision.diff`（2026-08-18）

30 个 agent（5 路只读测绘 + 24 路对抗式反驳 + 1 路综合）跑完，结论经我逐条回代码复核。

### 8.1 `revision.diff` 现在**造不出来**

不是接口问题，是**内容没存**：

| 事实 | 证据 |
|---|---|
| `patch_set.ops` 在两个生产写入点都硬编码为空 | `routes/questions.ts:844`、`routes/artifacts.ts:761` |
| `snapshotHash` 在答复路径上从未赋值（默认 `""`） | `routes/questions.ts:835-853` 的 `new Revision({...})` 没有这个键 |
| `changedIds` 记的是**预测**不是观察 | `changedIds: decision.affectedIds`,而 affectedIds 来自 `predictDecisionEffect` |
| 旧状态哪儿都不留 | `ontology.package.json` 每次编译原地覆盖（`glue/compile.ts:89`）；`_oir_versions` 是上限 20 的 LIFO 撤销栈，且**答复路径根本不 push** |

**最小改动（零 schema 迁移）**：`snapshot_hash` 列**已存在**（`store/schema.ts:485`,notNull 默认 `""`），域字段、行投影、pg 读写全都已打通、只是没人用；内容寻址的 blob store 也已存在（`kernel/journal.ts:253` 的 `FileBlobStore`,已按会话根目录挂载）；确定性快照构建器同样已存在（`routes/ontology-draft.ts:112` 的 `buildDraftOntologyPackage`,只读、不推进 revision）。

把这三样接起来即可：回写之后、`appendRevision` 之前，`blobs.put(pyJsonDumps(buildDraftOntologyPackage(s)))`,把返回的摘要写进 `snapshotHash`。`diff(N,M)` 就变成加载两个 blob 做比较。内容寻址意味着「什么都没改的一次回答」零新增字节。

**不要走「填充 patchSet.ops」那条路**：`PatchOp` 只有 `op/path/value/fromPath/targetIds`,**没有 `oldValue`**（`onto/questions.ts:1245-1268`）—— 只能前向应用，画不出 before→after；而且全仓没有任何 applier，`PatchSet.fingerprint` 还哈希 ops，填了会改动已存在 revision 的指纹。更多工作、更少能力。

### 8.2 真正的最大缺口：算出来了，然后一路丢掉

`applyDecision` 返回 `{conflict, option, label, changed, note, deferred}` —— `label` 是被选中选项的原话，`changed` 是**实际**变更的 rid（`onto/clarify.ts:314-321`）。它活到了 HTTP 响应体的 `applied` 字段，然后：

| 边界 | 丢在哪 | 后果 |
|---|---|---|
| ① 前端 | `ui/questions.ts:112-117` 只判 `r.ok` 就 `loadQuestions()`,**从不调 `r.json()`** | 响应体整个丢弃 |
| ② 对话工具 | `dialogue/tools.ts` 的返回里没有 `applied` | 负责复述的模型只能说「已记录」,说不出改了什么 |
| ③ SSE | emit 发 `{question, ...}`,渲染器读 `ev.question_id \|\| ev.qid` —— **两个都不存在** | 操作记录里每条「答复问题」详情是空白 |
| ④ 右侧栏 | 重取的依赖键 `state_version`/`stateVersion`/`revision` 在任何 HTTP 响应体里都不存在 | 回答之后侧栏永远停在开会话时的快照 |

**这是管道漏水，不是建模缺失** —— 东西已经算出来了。

### 8.3 已修（③②① 的服务端半边）

| 改动 | 位置 |
|---|---|
| 事件带上 `label` 与**实际** `changed`（`affected` 保留不动，不打断既有消费者） | `routes/questions.ts` |
| `question.answer` 交回 `拍板内容`/`实际改动`/`改动说明`,并把 `applied` 显式写进 `AnswerResult` 契约 | `dialogue/tools.ts`、`dialogue/ports.ts` |
| 渲染读对键（`question` 优先，`question_id`/`qid` 保留给老会话），并优先显示「定了什么 · 改了 N 处」 | `ui/events.ts` |

未做：① 的前端半边（`ui/questions.ts` 读响应体）与 ④（侧栏刷新键）—— 两处都在 `ts/src/ui`,而 `ui/index.html` 是生成物且当前有大量未提交改动，重新生成会覆盖它。**等工作区干净后再动。**

---

## 9. `revision.diff` 落地（2026-08-18）

§8.1 说这条造不出来，因为内容没存。这一轮把地基和工具一起做了。

### 9.1 地基：Revision 快照

`QuestionDeps` 新增可选依赖 `snapshot(s): Promise<string>`。答复路径在 **OIR 回写之后、`appendRevision` 之前**取一次内容哈希，写进 `Revision.snapshotHash`。

生产接线用的**全是现成件**，零 schema 迁移、零新依赖：

| 部件 | 位置 | 原本状态 |
|---|---|---|
| `snapshot_hash` 列 | `store/schema.ts:485` | 存在、读写打通、**没人写** |
| `FileBlobStore`（内容寻址） | `kernel/journal.ts:253` | engagement recorder 已在用 |
| `buildDraftOntologyPackage` | `routes/ontology-draft.ts:112` | 只读、不推进 revision |
| `pyJsonDumps`（canonical 那份） | `onto/canonical.ts:366` | 编译本体包用的同一个 |

**为什么存包而不是 OIR**：包的 id 稳定（`do.*`/`rel.*`/`act.*`/`rule.*`），而 OIR 的 rid 由名字派生 —— 一次改名在 rid 世界里会渲染成「删一个、加一个」。

**两条硬约束，各有测试钉住**：

- **快照失败绝不让回答失败。** 回答是这个产品里最重的一次人工输入，为写不进一个 blob 就丢掉它，比没有 diff 严重得多。
- **但不许静默。** 失败发一条 `revision.snapshot_failed` 事件；空哈希与「快照成功但内容没变」在下游是两回事。

### 9.2 计算核心：`onto/package_diff.ts`

纯函数、零模型。输出形状刻意对齐前端已有的渲染契约 —— `ui/react/returncard.tsx` 读 `a.diff || a.diffs || a.changes` 并画 `{rid}.{field}：{before} → {after}`,沿用同一形状则渲染层零改动。

这一轮学到的东西全部前置进了实现，而不是等真实数据再打一次脸：

| 纪律 | 实现 |
|---|---|
| 真实规模 | 按集合轮转的分层截断（`CHANGE_CAP=80`），`total` 与各集合 added/removed/changed 全量 |
| 长文本 | 截断到 140 + 复用 `undescribedDiff` 给「差在哪几个字」，片段各封顶 60 |
| 一边有一边空 | 不算差异片段（否则整段原文会被当片段吐出来），标 `单边` |
| 系统性变更 | 旧版一项都没留下时报 `wholesale_replacement` —— 那是一次重建，不是 N 处改动 |
| 元信息 | `generatedAt`/`revision`/`baseRevision` 不参与比较，否则每次都全是噪音 |

### 9.3 工具：`revision.diff`

不给参数比最近两版，也可以指定 `from`/`to`。最要紧的一条是**四条「不知道」的出口互相分得开**：

| 情形 | 回答 |
|---|---|
| 一条 revision 都没有 | 「还没有任何版本 …… 是**无从比较**,不是已确认一致」 |
| 只有一版 | 「只有 1 个版本，没有可比的前一版」 |
| 某版没有快照 | 「**没有快照** …… 这不等于没有变化，是比不了」 |
| blob 读不出来 | 「快照**读不出来** …… 这不是没有变化，是取不到内容」 |
| 真的一致 | 「两版内容**完全一致** —— 这是比较过的结论，不是没查」 |

端到端验证（真实 blob 写入→取回→diff）：

```
两版快照 ref: blob:dc332ac8eb5… blob:a2eb40f0eb7…
内容寻址生效（同内容同 ref）: true
改动总数: 3 | 一致: false
  · do.po.primaryKey：[] → ["poNo"]
  · rule.r1.statement："金额超 10 万需总监审批" → "金额超 20 万需总监审批"
```

内容寻址意味着**一次什么都没改的回答零新增字节**。

### 9.4 判断题工具现状

从 1 个（`impact.trace`）到 7 个：`entity.compare`、`model.lint`、`conflict.query`、`decision.query`、`release.check`、`revision.diff`。

---

## 10. FDE 专业 Agent 模型能力落地（2026-08-18）

### 10.1 “13 个 Agent 不等于 13 个模型能力”已经被拆开说明

当前 Agent 能力分三层：

| 层 | 模型能力 | 控制方式 |
|---|---|---|
| 材料理解 | `extractor`、`rule_miner` | 主抽取 DAG，证据驱动 |
| 用户交互 | `ConversationAgent` | `single_shot / react / plan_execute` |
| FDE 专业分析 | `fde_interviewer`、`process_modeler`、`erp_mapper`、`rule_engineer`、`data_steward`、`delivery_reviewer` | Engagement v2，混合式模型分析 |

这里的“模型能力”不意味着模型拥有最终事实。六个专业节点统一采用：

```text
确定性 seed
  → 模型只补 UNKNOWN / 空槽 / 跨产物语义
  → 角色只读工具取证
  → 白名单 finalize 合并
  → 引用闭包与 Evidence 校验
  → GAP / CANONICALIZE
  → REVIEW / EXPORT 硬门
```

模型不能删除 seed、修改稳定 ID、替换原始名称/结构边，也不能自行把交付门改成
PASS。`delivery_reviewer` 可以追加语义 blocker/warning；`schema_valid`、
`downloadable`、`blocker_count`、最终 verdict 仍由确定性代码计算下界。

### 10.2 六个专业节点现在各自分析什么

| Agent | 独立模型分析 | 确定性保留 |
|---|---|---|
| FDE Interviewer | 范围、stakeholder、事实/假设、问题候选 | 既有问题生命周期、验收硬门、稳定 ID |
| Process Modeler | actor、trigger、precondition、输入输出语义 | 步骤/边拓扑、原名、来源证据 |
| ERP Mapper | 产品/版本/模块/组织范围、实施方式 | step/system/target 原始映射 |
| Rule Engineer | 条件、效果、例外、测试用例 | 原规则、适用对象、稳定 ID |
| Data Steward | 分类、SoR、owner、生命周期、敏感度、质量规则 | 对象、业务键、原始证据 |
| Delivery Reviewer | 跨产物语义问题与附加 blocker | 所有 release-critical 指标与最终门禁 |

专业产出不再停在临时 DAG output：问题候选进入统一 QuestionBacklog；有真实证据的
ERP、规则、流程和数据治理增量进入最终 OntologyPackage，并由 REVIEW 审核同一个
exact package 后交给 EXPORT。

### 10.3 Tool scope 现在是执行边界

`TOOL_SCOPES` 已成为中央授权真源；内建只读工具注册时显式带 scope，未知工具默认
无授权。专业 handler 还保留第二道角色 allowlist，调用时使用构造自 AgentSpec 的
scope，模型 action 里伪造 `scope` 无效。

- 所有专业角色：按需使用 `evidence.search`、`evidence.rows`、`oir.query`、
  `impact.trace`。
- ERP / Data：可额外使用 `profile.column`。
- Data / Reviewer：可使用 `entity.compare`、`model.lint`。
- 专业角色与 `converse`：均无 `code.exec`；`code.exec` 只留给显式分析/编译作用域。
- `oir.query` 已支持规则查询、`apiName/displayName/statement` 搜索和带
  `total/returned/truncated/next_offset` 的分页。

### 10.4 Provenance、checkpoint 与恢复

- 模型新增语义必须携带 EvidenceIndex 中真实存在的 cite；canonical 只复用已有
  `ev.*`，或导入包含 file、locator、snippet 的完整 Evidence 记录，不再制造空占位。
- Engagement v2 的 node、LLM/tool effect 与 attempt 都按
  `checkpoint_version` 隔离，旧静态投影不能冒充新模型结果。
- 持久化专业分析绑定 OIR、Flow、artifact revision 与完整证据记录的来源指纹；
  指纹变化会换 run namespace，不恢复旧专业 checkpoint。
- Scheduler 完成后先 flush journal，再写 release 文件与会话状态。
- HITL/修订恢复目前使用确定性 Reviewer，不会静默宣称做过语义复审；包内会留下
  skipped-review 标记。

### 10.5 当前明确边界

1. 专业 Agent 新发现的问题目前是**非阻塞 advisory question**。在字段级确定性
   answer applier 落地前，直接回答会返回 409 并保持 OPEN，避免“答案记成 applied，
   但 ERP/规则/治理字段没变化”的假闭环。
2. 多文件交付仍是顺序写入，不是 staging + manifest 的原子发布；Gate 审核的是
   exact package，但进程在多文件写入中途崩溃时仍可能留下新旧混合文件。
3. 本地服务固定由 `.env` 的 `ONTOCOPILOT_PORT=8765` 启动，地址为
   `http://127.0.0.1:8765/`；本次 Agent/Tool 改造没有改端口。

验证：FDE/Agent/Tool 相关定向回归 548/548 通过，TypeScript 编译通过；全量回归
6,245 项通过。其余失败来自受限测试环境的监听/沙箱权限、Postgres 探测，以及当前
工作区已有的 UI 源码与生成物漂移，不属于本节改造路径。
