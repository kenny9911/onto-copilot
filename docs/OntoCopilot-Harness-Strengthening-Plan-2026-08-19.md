# OntoCopilot Harness 强化方案：目标管线对照 · 失败分类映射 · 分域设计

> 2026-08-19 深夜 · 前置：A1（抽取 schema 补齐）已完成（见完备度文档 §11）。
> 方法：6 路主题盘点 + 1 路 MAST 映射，每条结论强制 file:line，
> 最要命的 8 条派证伪者尽力推翻（结果见 §7）。

---

## 0. 目标管线七步对照

用户要的完整工作流，逐步对照现状：

| # | 目标 | 现状 | 断点 |
|---|---|---|---|
| ① | 业务文件整合/清理/重排版 | `data.transform` 六动词 + 行数账 | **缺 union/unpivot/split/aggregate/merge_header** —— 多 sheet 合并、横表转长表、复合列拆分、两级表头四类高频需求直接失败 |
| ② | 「还缺什么」差距结论 | `readiness.report` 六维评估 ✅ | 结论只活在聊天里，**编排层不消费它**（见 O1） |
| ③ | 补充文件给业务方填 | 补料清单 / 访谈包 / 确认稿 ✅ | **缺数据样例回传模板（sample_kit）** —— unit/valueDomain/semanticType 三个字段生成路径填不出、模板又不问，永远空 |
| ④ | 回传后解析补充 | 访谈包回传闭环 ✅ | 导出的 md **没有回读身份** —— 自产断言回传后被洗成客户证据（basis 体系被外部击穿） |
| ⑤ | 生成完整 Ontology | A1 后六类实体都有抽取坑位 ✅ | Action↔Event↔Flow 绑定靠 `bind_objects` 手工；`OIR.validate()` 仍是死代码 |
| ⑥ | 丰富 Ontology package | zip（JSON 8 视图 + 原材料） | **人读成文、清洗数据、访谈包全进不了包**（exports/ 被设计性排除）；**没有 ER 图**（可视化只有流程图）；**数据样本为零** |

---

## 1. 编排：动态决策点（不推翻冻结拓扑）

冻结拓扑是重放安全的根基，**不动**。改的是「冻结之前」和「节点之间」：

### O1｜readiness 结论进编排层（中）
PARTIAL 场景下 FDE 说「开始梳理」，系统照样烧全量抽取预算，缺维度的专业节点
对着空证据产出空壳分析。**改法**：`runPipeline` 在 PARSE 完成后、freeze 之前加
确定性决策点：调 `assessReadiness`（零模型调用，此刻输入齐备）——
NOT_ENOUGH 不进抽取、直接产补料清单挂起；PARTIAL 裁掉缺维度的专业节点。

### O2｜round_trip 从假选项变成真挂起（小，当天）
HITL gate 上选「打回业务方补料」，现在**整条 Run 报失败**，engagement 检查点作废。
而挂起→回传→resume 的全套基础设施都在。**改法**：`enforceGateDecision` 加
ROUND_TRIP 分支，抛 `HumanInputRequired` 走现成的 SUSPENDED 路径。

### O3｜中途插 prompt：回执不许撒谎 + 反思信箱（两步）
实测语义是「并行但脱钩」：梳理跑到第 3 段时用户拍板「金额一律含税」，
工具答「已记下，后续每个抽取节点生效」——**实际第 4~200 段照旧按旧口径抽**。
第一步（当天）：`decision.record` 在 isBusy 时把生效范围**改说真话**；
第二步：`SessionLike` 加 pendingReflections 信箱，节点边界（下一次 freeze 段间）
消费 —— 与 Reflexion 机制同一个落点，不打断当前节点。

### O4｜PlanChoice：给「冻结前的决策」一个名字（中）
计划级分支现在散在 runPipeline 的 300 行 if 里，journal 能还原每个节点做了什么、
还原不了**为什么选这条计划**。抽成纯函数 `(files, tier, chunks) → PlanChoice`，
选择进 journal —— 重放能还原决策，测试能枚举分支。

## 2. 工具与数据管线

### T1｜data.transform 补五动词（中）
`union`（多 sheet/多文件并表）、`unpivot`（横表转长表）、`split`（复合列拆分）、
`aggregate`（按键汇总）、`merge_header`（两级表头并入列名）。
每个动词带行数账语义 + 单测 —— 与既有六动词同一纪律。

### T2｜sample_kit：数据样例回传模板（中）
对每个对象出一节：表头 = 现有属性，留 5 行请业务方**贴真实数据**（脱敏提示进导语）。
回传后确定性推 baseType/valueDomain/unit/主键唯一性 —— 业务方不用会写「枚举值域」
这种词。这条取代原 A2（登记表第二遍属性扫描）：**问人要 5 行数据比让模型再猜一遍便宜且准**。

### T3｜交付包收编三样（中）
① 自动组装「Ontology 说明.md」进 zip（数据已有，`source=ontology` 现成）；
② `exports/` 里清洗后的 CSV、访谈包给**晋级通道**（标记进包）；
③ samples 段：每个对象从来源表格取前 10 行真数据进包 ——「数据、文件、图」三件套里
「数据」现在是零。

### T4｜ER 图（中）
新建 `diagram_er.ts` 照 `diagram.ts` 的两级产物模式：`toErMermaid(oir)` ——
对象为实体（前 N 属性 + 类型 + PK 标记），Link 按 cardinality 转 erDiagram 记号。
**对客户讲 Ontology 最需要的那张图现在不存在。**

## 3. 记忆管理（四层架构与三条断裂的回路）

| 层 | 落点 | 状态 |
|---|---|---|
| 工作记忆 | scratchpad / transcript | ✅（transcript 固定 -4 有窗口问题，见 MAST-4） |
| 情景记忆 | memory_log（本轮新建） | ✅ 写入齐了，**读出断了** |
| 语义记忆 | project_memory 权威/参考两档 | 架构完整，**晋升与衰减是死代码** |
| 程序记忆 | Skills 渐进披露 | ✅ |

### M1｜memory_log 进提示词（小，当天）
现在唯一读口是子串匹配的 memory.recall——用户问「刚才改了什么」，
query 对不上就回「没有」，而 log 里明明有 20 条。**改法**：contextBrief 末尾
渲染最近 8 条（约 300 token），和「已拍板」同级；recall 的子串匹配换成分词。

### M2｜权威档自动入上下文（小，当天）
新会话第一句「按我们项目定过的口径继续」→ 上下文里零项目记忆。
**改法**：对话装配处 `recallProjectMemory(s, text, {topK:3})`，只取 authoritative
并入「已拍板」段 —— 参考档仍留给工具（两档安全模型不动）。

### M3｜情景→语义的晋升管道（中）
`memory.confirm` 工具：模型把参考档念给用户、用户答「对」后以**该轮用户原话**为
quote 走 rememberDecision —— 复用红队定过的 userSaid 堵点，不开新洞。
会话收尾扫 memory_log 里 basis=user 的条目，找得到原话的晋升项目档。

### M4｜衰减接线 + 导出文档的回读身份（中）
decay 从未执行 —— 参考档只进不出，长期库只会越来越吵。run 起点接 `startRun+decay`。
导出的 memory/sketch md 写一行机器可读标记（`<!-- ontocopilot:generated … -->`），
上传解析时识别 —— **不识别的话，自产断言经一次导出+上传就洗成客户证据**。

## 4. plan-execute 与推理策略

### P1｜kernel 计划三件套（中）
plan 现在是贴在每步 prompt 里的静态文字：无进度指针、无偏离检测、无 replan。
**改法**：① stepIdx 渲染「✔1-2 / ▶3 / 待做 4-6」；② 每步比对 action.tool 与
计划步声明，偏离记 PLAN_DIVERGED finding；③ 连续两次失败触发 replan（预算内）。

### P2｜对话侧计划固定渲染（中）
计划条目 4 个工具步后就被 transcript.slice(-4) 挤出窗口 —— 模型自己都看不见
自己列的计划。计划改成每步固定渲染的「计划+进度」区块，不走 transcript。

### P3｜三档动态策略（中）
现状是两条中文正则：single_shot 在有工具时不可达、英文用户永远进不了 plan_execute。
升级成三档纯规则选择（依然零模型、可解释）：意图直答类 → single_shot；
单实体查询 → react；多步骤/多实体写入 → plan_execute + 更高步数档。

### P4｜预算耗尽要「能救就救」（中）
kernel mustHalt 现在直接抛弃 scratchpad —— 审到第 6 步的口径矛盾证据随异常蒸发。
改成 pad 非空时降级返回 `__degraded: HALT_PARTIAL` 走 finalize，规则能并的照并。

## 5. md 文档与工作流的互动

**原则：md 是给人的投影，state 是给机器的真相 —— 单向生成、显式回流。**

- 每一份生成的 md 带回读身份（M4），回流时按身份分流：访谈包→答案通道、
  sample_kit→属性推导、说明文档→**拒绝当证据**（可当参考档）；
- 会话级 `TASKS.md` 概念**不另建状态**：它是 memory_log + question_backlog +
  readiness 三个既有源的**导出视图**（`export.file source=tasks`），
  谁写谁读一目了然，不会出现两套任务清单互相漂移；
- 推理时按需加载：contextBrief 常驻的是**摘要行**（M1 的 8 条），
  全量走工具拉取 —— L3 塞全文是把上下文预算换成幻觉率。

## 6. MAST 失败分类 → 防线映射（14 条全量）

**14/14 部分覆盖，0 条无防线，0 条全覆盖** —— 架构底子是好的，缺的都是接线。

| # | 失败模式 | 现有防线（核实过） | 最值得补的一条 |
|---|---|---|---|
| 1 | 不遵守任务要求 | schema 网关强制 + 枚举 fail-closed | 「进度声明核对」：回答说「正在处理」时核对本轮真调过工具没有 |
| 2 | 不遵守角色设定 | AgentSpec + golden 钉 14 份配置 | DAG 节点装配收敛到唯一入口，绕过在类型上不可能 |
| 3 | 重复执行相同步骤 | scratchpad 已做清单 + 双层步数上限 | 轮内动作指纹：同 (tool,args) 重调直接回放上次 observation |
| 4 | 丢失对话/历史 | 分层记忆 + memory_log 持久化 | transcript 按 token 预算截断（现在固定 -4，挤掉计划） |
| 5 | 无法识别任务结束 | kind=finish 显式契约 + 用满上限如实说 | agent_analysis 问题补生命周期 —— 现在只有入口没有出口 |
| 6 | 对话状态失配 | 互斥租约 + stateVersion 判权威 | persist 改 delete-aware（一处改覆盖 B3/B12 整族幽灵） |
| 7 | 信息不足不澄清 | 意图低置信不猜 + EIG 选题 + HITL gate | followup 落成候选 Question —— 现在是打印件不是任务 |
| 8 | 讨论逐渐跑偏 | 冻结拓扑 + 节点上下文隔离 | turn 收尾比对计划工具集 vs 实际调用集 → PLAN_DIVERGED |
| 9 | 隐瞒关键信息 | DEGRADED 事件 + skippedReviews 进产物 | 守恒不变量：输入行数 == 保留 + Σdropped，一条测试钉整条管线 |
| 10 | 忽略他人信息 | 黑板事实进节点与 critic 上下文 | **LLMCritic 的「已知事实」硬编码成（无）** —— ctx.facts 装了不注入 |
| 11 | 推理与行动不一致 | thought 先行强制 + observation 入轨迹 | checkGrounding 的镜像：说「已改」却无 danger>0 成功记录 → HIGH |
| 12 | 过早宣布完成 | Gate 非 PASS 到不了下游 + 空面板算未评审 | needsReasoning 判定要查证、模型第 0 步直答且零工具 → finding |
| 13 | 验证不完整 | 多视角面板 + 降级保 1 轮规则档 | **OIR.validate() 包成 RuleCritic 挂进管线**（写好测好、从没跑过） |
| 14 | 验证方法本身错误 | golden 逐字节 + DeterminismViolation + 双向测试 | grounding 收紧：cite 须命中产生它那一步的 observation，不是全局 blob |

三条已经修掉的实例佐证这个分类的现实性：#14 的 CoverageCritic 恒判失败（今天修）、
#11 的空回答报成「出处问题」（今天修）、#6 的幽灵补丁（今天修）。

## 7. 证伪结果

**4 条送审，4 条站得住**（证伪者尽力推翻，全部失败），但每条都带回了修正 ——
这正是要证伪的原因：结论对，细节常常写宽了。

| 结论 | 判定 | 证伪者带回的修正 |
|---|---|---|
| memory_log 没进提示词、recall 是子串匹配 | ✅ | 写入点是 6 处不是 7 处；`renderRecent(6)` 在最近 6 轮内是部分缓解，多轮后照样丢 —— 而且**工具描述明文承诺「问刚才改了什么看这一段」，这个 query 恰好匹配不到任何条目：描述与实现自相矛盾，失败不是假设是必然** |
| decay 永不执行、参考档只进不出 | ✅ | `startRun/decay` 全树零生产调用、模块头注释把「不用就衰减」列为三大设计支柱之一 —— **实现完整、从未接线**。「热度从 0 起算」改成「热度冻结在上次重写时的值」（实践中几乎永远是 0），实质不变 |
| 导出 md 无回读身份、自产断言可洗成证据 | ✅ | docx 已写 `dc:creator=OntoCopilot` 且解析器会回读 —— **身份标记的一半已经存在，只是没人拿它分流**；md/xlsx 仍是零标记 |
| 晋升闸门三条理由是死代码 | ✅ | 「10 个 Run 仍 0.5 置信」是错的 —— `merge` 对同文重复观察每次 +0.1、顶到 0.98，重复奖励在 confidence 上存在；**缺的是档位晋升，不是分数累积**。方案不变（memory.confirm + critic_survived 标注） |

另有三条我在等待期间**亲手自证**（不依赖 agent）：
`LLMCritic` 的「已知事实」硬编码成（无）且注释写明是移植对齐的自觉决定
（对照 Python 已删除，同 KeyError 那次的处理逻辑 —— 可以改了）；
`Decision.ROUND_TRIP` 在枚举和映射表里存在但**全仓没有处理分支**；
`transcript.slice(-4)` 属实。

## 7.5 本轮顺手落地的两件

- **O3 第一步已做**：`decision.record` 在 isBusy 时生效范围改说真话
  （「本轮正在跑的部分不受影响，跑完重跑才应用」）—— 回执撒谎是最先要停的。
- **A1 全量完成**（见完备度文档 §11）：objects 主键/分类、properties 值域/语义类型、
  links joinKey + MANY_TO_ONE 对调、actions/events/rules 三个新桶、
  EventType 成为 OIR 一等公民、MergeSegments 桶清单同步。12 条新测试全绿。

## 8. 实施顺序建议

| 批 | 内容 | 理由 |
|---|---|---|
| 当天件 | O2 round_trip 真挂起 · O3 第一步（回执说真话）· M1 · M2 · CODEACT 降级披露 | 全部小改，两条还是「回执撒谎」级别的诚实问题 |
| 一周件 | T1 五动词 · T2 sample_kit · T3 包收编 · T4 ER 图 · M3/M4 · P1/P2/P3 | 目标管线①③⑥的实体缺口 + 记忆回路 |
| 两周件 | O1 readiness 进编排 · O4 PlanChoice · P4 · MAST 表里的 8 条接线 | 动编排层，逐条带 golden |

---

## 9. 方法

6 路主题盘点（记忆/plan-execute/编排/工具/md 互动/验证收尾）+ 1 路 MAST 全量映射，
共 33 条 findings + 14 条模式判定；每条强制 file:line；今天已修/在修的不重报；
另一个会话的在途改动不算 bug。最要命的 8 条派独立证伪者读原文推翻，结果见 §7。


---

## 10. 开工记录 · 第一批（同日深夜）

**当天件 5/5 全部落地：**

| 项 | 内容 |
|---|---|
| **M1** | memory_log 进 contextBrief（最近 8 条，带依据标注）；recall 从整句子串换成分词匹配（中文 2-gram），虚词 query 退化成最近 8 条，**有实义词却不中就是没有 —— 不拿不相干的凑数** |
| **M2** | 项目权威档自动入对话上下文（topK=3，**只取 authoritative** —— 把推断混进系统层事实就是教模型把猜测当已确认）；召回失败不挡对话 |
| **CODEACT 披露** | 节点声明 codeact 但动作空间没有 code.exec 时发 DEGRADED 事件（reason=CODEACT_NO_SANDBOX）—— **贴牌运行变成可见事实**，与降级标记进产物同一条纪律 |
| **O2** | `Decision.ROUND_TRIP` 接上处理分支：抛 HumanInputRequired 走现成的 SUSPENDED 挂起路径（requestId 用 `:roundtrip` 后缀避免与 `:gate` 撞幂等键）；两处 askHuman 的 actions 补上 round_trip —— **存在但不被展示的选项等于不存在** |
| **O3 第一步** | 上一轮已做（decision.record 忙时回执说真话） |

**一周件先落了三大项：**

| 项 | 内容 |
|---|---|
| **T4 ER 图** | 新建 `diagram_er.ts`：mermaid erDiagram，实体带中文别名、属性带类型、主键标 PK、**值域进注释**（讲解时最常被问）；关系按基数转记号、joinKey 当边标签；事件用弱关系连载荷对象（Action 是行为不进 ER 图）；only 过滤时悬空关系不画。接进 `source=ontology` 成文（结构在前、流转在后） |
| **T1 五动词** | `union`（按**列名**对齐 —— 按位置对齐在列序不同的月表上会串列；对方多列丢弃/缺列补空都记账）、`unpivot`、`split`（段数对不上进坏行账）、`aggregate`（sum/count/first；规不上数字的不进和、点名）、`merge_header`。工具层 union 与 join 一样预取第二张表 —— 漏了就是又一个「能力存在但接不到」 |
| **T2 sample_kit** | `export.file source=sample_kit`：每对象一张空表让业务方贴 5 行真数据（脱敏导语、隐藏 rid 列对号、零属性对象让对方自列字段名）。**要 5 行数据比要术语便宜得多** |

新增 **28 条测试**（round_trip 3、ER 6、五动词 7、sample_kit 3、
codeact golden 更新、scheduler golden 两处 actions、loop golden 插降级事件）。
全量 **6488 passed / 6 failed**（6 条仍是另一会话在途）。

**一处配合说明**：8765 端口现由另一个会话启动的 `node ts/dist/src/main.js` 占用 ——
同一份 dist、包含本轮全部改动，健康检查通过，**没有动他们的进程**。

剩余一周件：T3 交付包收编、M3 memory.confirm、M4 decay 接线 + 回读身份、P1/P2/P3。
