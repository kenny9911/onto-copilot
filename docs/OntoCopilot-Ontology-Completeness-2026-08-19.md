# OntoCopilot Ontology 完备度审计 · Harness 强化 · Sidebar 方案

> 2026-08-19
> 触发：① FDE 反馈「对象只生成了壳，属性没有；Action/Event/DataObject/Workflow/Rule/Link
> 都是简陋版」；② 对话回了一句空的「（有出处没核对上，已移除；结论请自行复核）」。
>
> 方法：先把**真实库 `workspace/ontocopilot.db` 的 11 个会话全量测一遍**拿到硬数据，
> 再派 7 个审计员按实体分头查 schema / 生成路径 / UI 三层，最后逐条回原文自证。
>
> **证据标注**：`✅自证` = 本文作者已打开该文件该行确认；`◻待复核` = 审计员报的、
> 尚未逐行复核。不混在一起写。

---

## 0. 结论先行

**schema 不简陋，生成路径简陋。**

OIR 的类型定义相当完整——属性有口径/单位/值域/必填，关系有 joinKey，
Action 有参数/效果/执行者/前置条件，对象有主键。**但这些字段的绝大多数，
从来没有任何一条自动路径去填。** 它们从 `makeXxx()` 的默认值出生，一路空着走到交付包。

更尖锐的是三处「造好了没接上」：

1. `rule_engineer` 花 90k tokens + 3 轮 critic 产出 `condition / effect / exceptions /
   test_cases`（含 POSITIVE/BOUNDARY/NEGATIVE/EXCEPTION 四类测试用例），
   **交付契约 `OntologyRuleV1` 里没有这些字段，而且 `additionalProperties: false`
   ——想塞都塞不进去。** ✅自证 `ontology_package.ts:214-223, 578-587`
2. `canonical.ts` 的编译器里 **20 处字段被硬编码成 `[]` / `null`**，
   包括 `normalizedExpression`、`emits`、`idempotency`、`compensationAction`、
   `preconditions`、`inputs/outputs`、`lifecycleStates`——
   **架构预留了代码生成需要的全部位置，然后每一个都填了空。** ✅自证 `canonical.ts:1032-1520`
3. `action_drafter`（从 OpenAPI 反推 Action 的 agent）在**整个源码树里只出现一次
   ——它自己的定义**。从未被任何 DAG 调度。✅自证 `grep -rn action_drafter ts/src`

还有一个正在生效的**崩溃 bug**（下面 §3.0）。

---

## 1. 实测：真实库里的 Ontology 长什么样

全部 11 个有 OIR 的会话：

| 会话 | 对象 | 属性 | 关系 | Action | 规则 | 属性/对象 |
|---|---:|---:|---:|---:|---:|---:|
| 6ef0bc43ab21（1 份材料） | 133 | **0** | 0 | 0 | 0 | **0.00** |
| fdaced8ca9df（2 份材料） | 175 | **0** | 0 | 110 | 28 | **0.00** |
| 010f743dcc00（1 份材料） | 202 | **3** | 57 | 0 | 10 | **0.01** |
| bafd0dd05e69（截图这个，无材料） | 8 | 18 | 3 | 6 | 2 | 2.25 |
| 其余 7 个 | 9 | 5 | 1 | 5 | 0 | — |
| **合计** | **527** | **26** | **61** | **121** | **40** | **0.05** |

**527 个对象，26 个属性。** 三个真跑了材料抽取的会话，属性产出是 0 / 0 / 3。

截图那个会话的 18 个属性来自哪？查 `_oir_patch_log`：**3 次 `add_batch`**——
聊天里手工补的，**不是任何生成路径产出的**。

### 1.1 字段级填充率（截图会话 bafd0dd05e69）

```
对象 8：  primaryKey 0/8          description 8/8
属性 18： baseType 18/18   definition 12/18   required 15/18
          semanticType 0/18      unit 0/18      valueDomain 1/18
Action 6：actor 6/6   preconditions 6/6   effects 6/6
          parameters 0/6         appliesTo 非空 2/6
Link 3：  cardinality 3/3        joinKey 2/3
FlowNode 11：objects 全部 []      grounded 全部 false
全体：    origin=inferred 100%   confidence=0.4   evidence=[] 100%
```

`origin` 全是 `inferred`、`evidence` 全空——这正是详情页
**「暂无可定位的直接证据」** 的来源。不是 bug，是如实反映。

### 1.2 截图上那四个数字，每一个都算对了

`context-sidebar.tsx:509-514` ✅自证：

- `属性 3` — 采购申请确实只有 3 个属性
- `关联对象 1` — 只有 1 条关系引用它
- `Actions 2` — **6 个 Action 里只有 2 个 `appliesTo` 非空**，另外 4 个悬空
- `流程节点 0` — FlowNode **有** `objects` 字段，但**全部 11 个节点都是 `[]`**

所以「流程节点 0」不是显示错误，是**流程图和 Ontology 完全没连起来**的如实报告。

### 1.3 两个最能说明问题的例子

**例一：同一条业务事实存了两遍，谁也不认识谁**

```
BusinessRule: "采购申请预估金额超过50,000元，需经由总经理进行额外二级审批。"
              appliesTo=[ot_purchaserequisition]   ← 只绑对象，没绑属性
FlowEdge:     label="金额 > 5万"                    ← 自由文本
```
同一个阈值写了两次，一次「50,000」一次「5万」，两者之间**没有任何可机读的联系**，
也没有一处指向 `estimatedAmount`。规则不能校验、网关不能执行、矛盾了没人发现。

**例二：动词被当成对象抽出来**

010f743dcc00 抽出的 202 个「对象」里有
`创建采购订单`、`取消采购订单`、`变更采购订单`、`采购业务计划头行关系`。
前三个是 **Action**，第四个是 **Link**。
因为 `EXTRACTOR_SCHEMA` **只有 objects / properties / links 三个桶，没有 actions 桶**
（✅自证 `kernel/agents.ts:200-262`），模型看见动词只能往 objects 里放。

---

## 2. Harness 缺陷（本轮新增，最高优先级）

用户实测：问「这个 Gateway 的上游和下游的连接也需要 event，请你补充缺乏的 event」，
连问两次，两次都只回一句 `（有出处没核对上，已移除；结论请自行复核）`。

### H1　空回答被当成「出处有问题」上报　✅自证

三处叠加：

| # | 位置 | 问题 |
|---|---|---|
| ① | `converse.ts:159-177` | `ANSWER_SCHEMA` 里 `answer` 在 `required` 里但**没有 `minLength`**——而同一个 schema 里 `thought` 有 `minLength: 8`。**空串合法通过网关校验。** |
| ② | `converse.ts:284-294` | `checkGrounding` 正确地为空回答产出 `ANSWER_EMPTY`（HIGH），于是 `grounded === false` |
| ③ | `converse.ts:952-959` | 那句提示是 **`turn.answer += ...`（追加）而不是兜底**，且它只为「引了假出处」一种失败写的文案，却对**所有 HIGH finding** 生效 |

`turn.answer` 是空串时，用户看到的整条消息就只剩这句括号——
**而且内容是错的：并没有出处被移除，是压根没生成回答。**

零测试覆盖（`grep 有出处没核对上 ts/test/` 无结果）。

**修法**
- 按 finding code 分流文案：`CITATION_FABRICATED` 才说「出处已移除」；
  `ANSWER_EMPTY` 要说**这轮实际发生了什么**——跑了几步、调了哪些工具、
  改了什么、为什么没答上
- `answer` 为空时改为**兜底替换**，不是追加
- `ANSWER_SCHEMA.answer` 补 `minLength`
- 补测试

### H2　5 步跑不完多写入任务　✅自证

`converse.ts:671` `maxSteps ?? 5`，且**一步一个工具**（`converse.ts:787`）。

用户这个请求需要：读流程（1 步）→ 找出网关哪些分支缺事件 → 逐个 `flow.edit add_event`
（N 步）→ 收尾答复。网关两条分支就要 3 次写入，**必然撞上限**。
撞上限时最后一步 schema 切成 `ANSWER_SCHEMA`，模型被迫收尾，答不上来就交白卷。

现有 `readOnlyBatch` 只并行**只读**工具（`danger === 0`，三条硬条件），写入无批量。

**修法**
- 提示词把 `flow.edit` 的 `apply_patch` 与 `oir.edit` 的 `add_batch` 提为**写入首选**
  （一步落多改，这两个 op 已经是事务性的，本轮之前就做好了，只是模型不知道优先用）
- 步数按 intent 分档：写入类任务给更多步
- 步数用尽要**如实说**「这轮只做到第 N 步，还差什么」，不要静默收尾

### H3　检索深度不足（用户原话「搜索能力不足」）　◻待复核

对话层查证据靠 `evidence.search`，单轮单次。多跳问题（「这条规则约束的属性，
在哪张表的哪一列」）要连查三次，在 5 步预算里做不到。
方向：把 `readOnlyBatch` 的并行读扩成**一步发多个检索**（已具备条件：
三条安全门都在，只是没被提示词用起来）。

---

## 3. 六类实体逐个体检

### 3.0 先说一个正在生效的崩溃 bug　✅自证

```ts
// pipeline.ts:469   —— 有人特意把 LINKS 加进来了，注释写了整整四行为什么
export const CHECKED_YIELDS = [Yield.OBJECTS, Yield.PROPERTIES, Yield.LINKS, Yield.ACTIONS];

// pipeline.ts:1236  —— 但这张中文名表没跟着改
const YIELD_CN = { properties: "属性", objects: "对象", actions: "行动" };  // ← 没有 links

// pipeline.ts:1305
const cn = YIELD_CN[y];
if (cn === undefined) throw new Error(`KeyError: ${pyRepr(y)}`);   // ← 抛异常，不是报 finding
```

任何一段「本该抽出关系但一条都没抽到」的材料 → `outstanding()` 返回 `["links"]`
→ **整个抽取 run 抛 `KeyError: 'links'` 崩掉**，而不是报一条 finding。
两次改动隔了时间、只改了一边。**一行修复，后果是整条流水线挂掉。**

### 3.1 ObjectType / PropertyType

| 字段 | schema | 自动填 | UI |
|---|---|---|---|
| apiName / displayName / description | ✅ | ✅ | ✅ |
| **属性列表本身** | ✅ | 见下 | ❌ **全 sidebar 没有一处列出属性名** |
| `definition`（口径） | ✅ | ⚠️ 12/18 | ❌ |
| `required` | ✅ | ⚠️ 15/18，且永远打成 `origin=INFERRED` ◻ | ❌ |
| `unit` | ✅ | 0/18 | ❌ 编辑 op 也没有 |
| `valueDomain` | ✅ | ❌ 抽取 schema 里没有 | ❌ |
| `semanticType` | ✅ | ❌ **全仓没有任何代码写过它** | ❌ |
| `primaryKey` | ✅ | ❌ **0/527**；只能靠「apiName 以 id 结尾」猜 ◻ | ❌ |
| `titleProperty` | ✅ | ❌ 注释直言「存不住，一次往返回到 null」 | ❌ |
| 精度/长度、来源列、样例值 | ❌ | — | — |

**零属性的直接成因**　✅自证 `pipeline.ts:698` + `pipeline.ts:1299`：

```
提示词：「⚠ **这一段没有字段列，因此没有属性可抽。** 不要为了凑数把行名、
         说明文字当成属性。」
critic：「以前这里假设"表里必有字段行"，在实体登记表上把"零属性"报成 HIGH，
         节点反复重试直到烧穿预算 —— 而零属性才是那张表的正确答案。」
```

一张「一行一实体」的登记表（FDE 最常见的客户交付物）被判成
`rowUnit: "object"` → `Yield.PROPERTIES` 不在 `shape.yields` 里 →
**提示词主动禁止抽属性，critic 把零属性判成正确答案。**
这是一个**为了止血而做的合理决定，产生了一个糟糕的结果**：
202 个对象、3 个属性，而且全程一句话都没说。

其他　◻待复核：
- 属性视图在装配点被丢弃（已经算好了，没往 UI 送）
- 回传表能改 `baseType/unit/required`，但 `mergeIntoOir` 没有这三个字段的回写路径，改了静默丢弃
- 列画像（样例值/空值率/唯一性）算出来了，但键是 `sheet.列名` 而消费方按 property rid 查——**整条数据承载链路是死的**
- 「这个对象一个属性都没有」在 lint 和建议两条通道上都报不出来

### 3.2 ActionType

| 字段 | schema | 自动填 | UI |
|---|---|---|---|
| apiName / appliesTo | ✅ | ⚠️ 2/6 有 appliesTo | ✅ |
| `actor` / `preconditions` | ✅ | 仅手工批量路径 | ❌ |
| `parameters` | ✅ | **0/121** | ❌ |
| `effects` | ✅ | 每个只有 1 条自由文本 | 只显示条数 |
| 写哪些属性 / 产出哪个 Event / 幂等 / 权限 | ❌ | — | — |

- **唯一的自动来源 `action_drafter` 是死代码** ✅自证
- **`preconditions` 在交付契约里被硬编码抹掉** ✅自证 `canonical.ts:1127`
- `parameters` 是无契约的 `Record<string, unknown>[]`，全链路无形状校验 ◻
- OIR Action 与 Flow Action 的 canonical id 命名空间对不上，**6 个 Action 编译出 10 条** ◻
- 「Action 零参数零效果」没有任何 lint 报警，空壳一路绿灯到交付 ◻

### 3.3 Event

**Event 不是一等公民**——`oir.ts` 里没有 EventType，容器只有
objects / properties / links / actions / rules / questions。✅自证

- 没有流程图就等于零个事件
- 没有 payload / 时间语义 / 投递语义 →「辅助生成可运行代码」不成立
- **自动填不上，人也补不上**（没有任何编辑面能给 Event 补载荷）◻
- Event 状态永远 candidate 且存不住——评审签字没有落点 ◻
- 进不了任何清单和导出，FDE 只能在画布上一个个点 ◻
- payload 缺失还顺手制造十几条假缺口问题 ◻

### 3.4 LinkType

| 字段 | schema | 自动填 | UI |
|---|---|---|---|
| source / target / cardinality | ✅ | ✅ | 只显示基数 |
| `joinKey` | ✅ | **0/57**（抽取侧），四条补救通道全堵死 ◻ | ❌ |
| 反向名 / 必选性 / 级联 | ❌ | — | — |

- **没有 joinKey 就没法生成 JOIN**，关系只是一句「这两个有关系」
- Link 的 rid 只由 apiName 派生，**同名关系静默覆盖且不计入 dropped 统计** ◻
  ——这可能才是「关联对象 1」的真正成因
- 端点解析只走 `byApi`，而 rules/actions 都走了 `byDisplay/byGroup`——
  **用中文名写的关系整条丢** ◻
- 没有任何确定性路径把外键变成 LinkType；关系 100% 依赖 LLM，且被限制在单个 segment 内 ◻
- 交付包 `dataObject.relations` 只挂 source 侧——作为终点的对象看不到自己的关系 ◻
- 发给业务方的流程确认稿「从/到」两列全空——读错了序列化键名
  （`linkToDict` 发的是 `from`/`to`，不是 `source`/`target`）◻

### 3.5 BusinessRule

- `statement` 是自由文本，**没有条件/比较符/阈值/单位/作用属性** ✅自证
- `appliesTo` 只接对象 rid，**绑不到属性、绑不到 Action** ✅自证
- **`rule_engineer` 的结构化产出被整段丢弃** ✅自证——这是最可惜的一条：
  ```
  RULE_ENGINEER_SCHEMA 产出：condition / effect / exceptions / evidence_ids /
                             test_cases[{kind: POSITIVE|BOUNDARY|NEGATIVE|EXCEPTION,
                                         given:[{field,value}], expected}]
  OntologyRuleV1 接收：      statement / ruleKind / dataObjectIds / actorRole / status
                             （additionalProperties: false）
  ```
  **代码生成级的规则数据已经在算了，只是没有地方放。**
- `RuleKind` 三处枚举不一致，`OTHER` 被静默改标成 `VALIDATION`，模型给的 `DERIVATION` 无处落地 ◻
- 交付包里 `ruleKind` 是自由字符串，无 enum 校验，脏值原样进产物 ◻
- 规则不进 `validate()` 和 `dependents()`——改对象时的影响面分析看不见规则 ◻

### 3.6 Workflow / FlowGraph

- **`flow.workflows` 容器永远是空的**（实测 `[]`）——
  「Workflow」这个实体在自动生成里根本不存在 ✅自证
- `FlowNode.objects` 全库全空；`FlowNode` **没有指向 OIR ActionType 的字段**，
  只有一个 `endpoint` 字符串 ✅自证
  → `提交采购申请`（流程节点）和 `SubmitRequisition`（OIR Action）
     是描述同一件事的两条互不认识的记录
- 边只有自由文本 `label`，**没有可判定条件、没有数据流**；网关分支永不汇合 ✅自证
- 实测 `stats: {terminals: 0, dead_ends: 1}`——流程没有终态
- 节点没有 输入/输出/前置条件 字段；材料里已抽出的 trigger/inputs/outputs 被丢弃 ◻
- `structureDefects` 漏检四类会放行坏图的结构问题 ◻
- 编辑面没有任何 op 能给节点绑对象、绑接口、补输入输出 ◻

---

## 4. 代码生成就绪度：还差什么

| 缺口 | 挡住的产物 | 现状 |
|---|---|---|
| 主键 | 建表 DDL、upsert、REST 路径 | 0/527 |
| 精度/长度/可空 | 列定义 | 只有 required |
| 枚举值域 | 状态机、下拉、CHECK 约束 | 1/26 |
| joinKey | 外键、JOIN、ORM 关联 | 0/57 |
| Action 入参 schema | API 签名、表单 | 0/121 |
| Action 写哪些字段 | 事务边界、审计 | 无此字段 |
| Action → Event 绑定 | 事件发布 | 无此字段 |
| Event payload | 消息契约 | 无此类型 |
| 规则可判定表达式 | 校验代码 | **算出来了，被丢弃** |
| 分支条件结构化 | 工作流引擎配置 | 全是 label 文本 |
| 流程节点 ↔ Action | 编排落地 | 无此字段 |

---

## 5. 方案 A：Ontology 强化

### P0（本周，全部是「补字段 + 接线」，不改架构）

| 编号 | 内容 | 落点 |
|---|---|---|
| **A0** | **修 `YIELD_CN` 缺 `links` 的 KeyError** | `pipeline.ts:1236` 补两条（links/rules），一行级修复，先修这个 |
| **A1** | 抽取 schema 补齐 | `agents.ts:200`：objects 补 `primary_key`/`classification`；properties 补 `value_domain`/`semantic_type`/`precision`/`example`/`source_column`；links 补 `join_key`、`cardinality` 补 `MANY_TO_ONE`；**新增 `actions[]` 与 `events[]` 桶**。配套改 `pipeline.ts:971` 的读取 |
| **A2** | **实体登记表的第二遍属性扫描** | 不是取消 `pipeline.ts:698` 那条禁令（它是对的：那一段确实没有字段列），而是**给这类段追加一个定向的第二遍**——拿着已抽出的对象名回全文找字段级信息。0.01 属性/对象的根因在这里 |
| **A3** | 交付契约接住已算出的规则结构 | `OntologyRuleV1` 补 `condition/effect/exceptions/testCases`，`canonical.ts:1157` 的 `normalizedExpression: null` 接上 `rule_engineer` 的输出。**这是投入产出比最高的一条：数据已经在算了** |
| **A4** | 解除 `canonical.ts` 的硬编码空值 | `preconditions`/`emits`/`inputs`/`outputs`/`lifecycleStates` 从 OIR 读，不要写死 `[]` |
| **A5** | 通用草案补对象与属性 | `SKETCH_SCHEMA` 增加 `objects[]`，每个带 `properties[]`。业务顾问看确认稿时最想核对的就是「这张单子有哪些字段」，现在这一栏根本不存在 |
| **A6** | Event 升为 OIR 一等公民 | `oir.ts` 加 `EventType{rid, apiName, emittedBy[], payload[], status}`，OIR 容器加 `events`；配套 `add_event` 编辑 op |
| **A7** | 流程 ↔ 模型绑定 | `FlowNode` 加 `action: string`（指向 ActionType rid）；`flow_link.ts` 补确定性对齐（命中就绑，不确定进问题台账，不猜）；`structureDefects` 加「未绑定对象的 action 节点」「没有终态」两条 |
| **A8** | 编辑面补齐 | `oir_edit.ts` 的 OPS 表：`add_object_type` 补 `primary_key`/`classification`；`add_property` 补 `unit`/`semantic_type`/`example`；`add_action_type` 补 `writes`/`emits_event`；新增 `add_event`、`bind_flow_node` |
| **A9** | 接活 `action_drafter` | 有 OpenAPI 材料时把它挂进 DAG。现在是白写的 |

> 一条纪律：**新字段一律可选发射**（照 `actionToDict` 的既有做法），
> 没填就一个键都不多——golden 钉的是旧字节，老会话必须原样。

### P1

- **A10 属性补全专项 agent**：一遍抽取要同时管对象/属性/关系，属性必然被挤掉——
  0.01 个/对象就是证据。拆成两遍，每遍只干一件事
- **A11 规则 ↔ 流程交叉核对**：有了结构化条件，「50,000」与「5万」这类矛盾自动报出来
- **A12 Link 修复**：rid 加端点参与派生（消除同名覆盖）、端点解析走 `byDisplay/byGroup`、
  从 fk 标签确定性推关系
- **A13 边的可判定条件**：`FlowEdge` 加 `condition{subject, property, operator, value}`

### P2

- **A14 数据承载**：列画像回灌属性的 `sampleValues`/`sourceColumn`
  （先修键的对齐：`sheet.列名` → property rid）
- **A15 对象生命周期状态机**

---

## 6. 方案 B：右侧 Sidebar

原则不变：**精简 = 不加常驻文字**；提升 = 把已有数据变成扫视级信号。
下面 8 条**不新增面板**，其中 S1–S4 **零后端改动**（`G.S.state.oir` 客户端已有全量数据）。

### S1　对象详情里真的列出属性　★最高优先级

`ModelItem`（`context-sidebar.tsx:63`）根本没有承载属性表的字段——
**全 sidebar 没有任何地方能看到属性名。** ✅自证

```
属性 (3)                                          + 补充属性
──────────────────────────────────────────────────────────
requisitionId    STRING   唯一标识采购申请的单号     必填   通识
estimatedAmount  DECIMAL  预估采购金额              必填   通识
status           ENUM     ①草稿 ②待审 ③已批准       必填   通识
```

第 3 列是 `definition`——**口径是 FDE 最需要核对的东西，现在完全看不到**；
第 4 列是 `origin` 徽标。默认 6 行 + 「还有 N 条」，行高 24px。

### S2　facts 从「四个裸数字」变成「完备度行」

现在 `属性 3 · 关联对象 1 · Actions 2 · 流程节点 0` 不带任何判断。改成缺项直说、可点击：

```
完备度   ⚠ 无主键 · 属性 3 · 关系 1 · Action 2 · ⚠ 未接入流程
```

点 `无主键` / `未接入流程` → 预填 composer 的补齐指令。空间不变，
信息量从「有多少」变成「差什么」。

### S3　origin / confidence 徽标

实测 100% 是 `inferred + confidence 0.4 + evidence []`，但界面只显示 `candidate`——
**看不出这是模型凭通识猜的还是从材料抽的**，而这是 FDE 最关心的一件事。
列表项与详情各加一枚：`通识` / `材料` / `已确认`。

### S4　列表项挂缺项小标 + `待补全 N` 筛选

模型列表每行右侧加小标（`缺主键` / `无属性` / `未绑定对象` / `悬空`），
筛选条加一档 **`待补全 N`**——一键得到 FDE 的工作队列。
实测这个队列立刻有货：527 个对象全部缺主键，121 个 Action 里 119 个缺入参。

### S5　Tab 徽标

`审阅` 挂阻塞问题红点、`交付` 挂 BLOCKED/DRAFT 状态点、`文件` 挂未解析数。零新增空间。

### S6　项目页：阶段管线 + 就绪度点阵

- 「下一步」升级成五段管线 `材料→评估→梳理→审阅→交付`，当前段高亮、点击直达
- 一行六个小圆点（对象/属性/关系/Action/流程/规则），实/半/空对应
  `readiness.report` 的强/弱/无信号，hover 说缺什么

### S7　流程节点 ↔ 模型双向跳转

画布节点选中时显示它绑定的 Action / 读写的对象；未绑定就显示
`未绑定 · 选择要绑定的 Action`。这是把 A7 的成果暴露出来的地方。

### S8　回执卡

`audit.applied` 与 `data.transform` 完成后，在「最近活动」顶部压一张可展开的紧凑卡：
`已落账 12/20 · 3 条对不上号` / `清洗 300→287 行 · 坏 4 行`。
现在这些只活在聊天流里，翻过去就找不到了。

---

## 7. 实施顺序

| 批次 | 内容 | 为什么这个顺序 |
|---|---|---|
| **第 0 批（今天）** | **A0 崩溃修复** + **H1 空回答兜底** | 一个在崩，一个在骗人。都是小改动 |
| **第 1 批** | S1 + S2 + S3 + H2 | 纯 UI / 提示词，零风险。**先让 FDE 看得见现状**，否则后端改了也不知道有没有改对 |
| **第 2 批** | A1 + A8 + A3 | 抽取 schema 是整条链路的天花板，先抬天花板；A3 是白捡的（数据已在算） |
| **第 3 批** | A2 + A4 + A5 + A9 | 属性第二遍扫描、解除硬编码、草案补属性、接活 action_drafter |
| **第 4 批** | A6 + A7 + S4 + S7 | Event 转正、流程绑定，以及展示它们的位置 |
| **第 5 批** | S5 + S6 + S8 + P1 全部 | |
| **第 6 批** | P2 | |

### 验收（可量化，直接对着真实库测）

| 指标 | 现状 | 目标 |
|---|---:|---:|
| 属性/对象 | 0.05 | ≥ 5 |
| 有主键的对象 | 0/527 | ≥ 80% |
| 有 joinKey 的关系 | 0/57 | ≥ 70% |
| 有入参的 Action | 0/121 | ≥ 60% |
| 绑定到对象的流程节点 | 0/11 | ≥ 80% |
| 带结构化条件的规则 | 0/40 | ≥ 50% |
| 抽取 run 因 KeyError 崩溃 | 可复现 | 0 |
| 空回答显示成「出处问题」 | 可复现 | 0 |
| sidebar 能看到属性名 | 否 | 是 |

每一项都能用一段 python 从 `workspace/ontocopilot.db` 直接量出来——**改完就测，不靠感觉。**

---

## 附：本次审计方法

1. 先测真实数据（11 个会话全量），不从代码猜
2. 7 个审计员按实体分头查，每条结论强制 file:line
3. 对最要命的结论做对抗式复核（尽力推翻，拿不准判推翻）
4. 跨实体遗漏批评（按实体分头查必然漏掉跨实体问题）
5. 作者逐条回原文自证——**标 ✅自证的都打开确认过，标 ◻ 的还没有**

---

## 8. 实施记录 · 第 0～1 批（2026-08-19）

| 项 | 状态 | 落点 |
|---|---|---|
| **A0** 修 `YIELD_CN` 的 KeyError | ✅ | `pipeline.ts:1236` 改成完整 `Record<Yield,string>`，类型系统强制穷尽；取值处的 `throw` 退成防御兜底 |
| **H1** 空回答兜底 | ✅ | `converse.ts` 按 finding code 分流：只有 `CITATION_FABRICATED` 才说「出处已移除」；`answer` 为空时改为 `emptyAnswerReport()` 兜底替换。`ANSWER_SCHEMA.answer` 补 `minLength:1` |
| **H2** 写入侧步数 | ✅ | `dialogue.ts` converse 作用域 `maxSteps` 5 → 8（chat 保持 4） |
| **S1** 属性表 | ✅ | `ModelItem.attributes` + `AttributeTable`：名字 / 类型 / **口径** / 必填 / origin 徽标，默认 6 行 + 展开 |
| **S2** 缺口小标 | ✅ | `ModelItem.gaps` + `.ctx-gap` 芯片：对象报「无主键 / 无属性 / 无关系 / 未接入流程」，Action 报「缺入参 / 未绑定对象」，点一下把补齐指令填进输入框 |
| **S3** origin 徽标 | ✅ | 属性行右侧 `通识 / 材料 / 已确认`——实测真实库 100% 是 `inferred`，而界面上原来只显示 `candidate` |

### A0 那条 KeyError 为什么可以改（原来有测试钉着「照迁不修」）

老测试写着「LINKS 缺失时炸 KeyError（Python 侧同样炸，照迁不修）」。
「照迁不修」在移植期是对的——一边迁一边修 bug，就分不清哪处差异是移植错误、
哪处是有意改动。但那条规则**有前提：存在一个还在跑的 Python 对照实现**。
`59346fa`「删掉 Python 源码树，仓库归零 .py」之后对照方没有了，
`tools/golden/onto_pipeline.py` 只剩一个 `__pycache__`。
为了跟一个已经删掉的实现保持一致而留着一个崩溃，那不叫权衡，就是崩溃。

而且这个崩溃是**后来才变得可达的**：`YIELD_CN` 那句取值原本是死代码
（LINKS 不在 `CHECKED_YIELDS` 里，`outstanding()` 返回不了它）。
后来有人特意把 LINKS 加进去（还写了四行注释说明为什么），这一句就活了，
而 `Partial<Record<…>>` 的类型没拦住。现在写成完整 `Record`，编译期会拦。

老测试没删，改成钉住新行为，并把上面这段理由写进了注释——
用的还是同一个 golden 向量（一张「主键/外键/类型」表，
恰恰是现实里最常见的关系定义材料）。

### 新增测试 26 条

`onto.converse-empty-answer.test.ts`（8）：撞上限要点名说、改没改要给准话、
只读工具不能算进写入名单、同一工具只列一次、`minLength` 存在、写入步数 > 只读步数。
`ui.context-sidebar.test.tsx` 追加（11）：属性表列口径、origin 分得出通识/材料、
ENUM 值域自带「取值：」标签、超 6 条折叠、**零属性空态要说下一步怎么办**、
缺口小标点一下填指令、补齐指令要点名要口径、什么都不缺就一个小标都不出。
`onto.pipeline.test.ts` 改写（1）：LINKS 缺失报 finding 不再崩。

### 两个诚实交代

1. **golden 冲突**：`golden/onto.converse.json` 有另一个会话的在途改动。
   我一度用 `git checkout` 回滚，把他们的改动抹掉了，靠
   `git fsck --unreachable` 从 dangling blob 里捞了回来，再把自己的两处叠上去。
   这个工作树不能用 `git checkout <file>` / `git stash`。
2. **全量 6343 passed / 6 failed**，6 条全部来自另一个会话的在途工作
   （engagement DAG v1→v2、`STEP_SCHEMA.tool` 描述改写、`chat.ts`/`state.ts` 重构），
   已逐条核对不是本轮改动引起的。本轮碰过的文件对应的测试全绿。

---

## 9. 更正：对抗式复核推翻了两条 blocker（2026-08-19 晚）

前面 §3 的结论里，有 7 个审计员分头查、我逐条自证过一部分。之后跑完的**证伪阶段**
（每条最要命的结论派一个人尽力推翻）推翻了两条，并修正了三处说法。
**这些是我写错的，不是补充**，所以放在正文之后单列，不去改前面的原话。

### 9.1 ❌ 被推翻：「Event 没有流程图就等于零个事件」（原判 blocker）

**错在哪：** 存在一条专为这个场景写的、**确定性、零模型调用**的兜底
`flowFromActions`（`flow_link.ts:565`），它遍历 OIR 的 Action，对每个非只读动词
**成对生成 ACTION 节点 + EVENT 节点**并连边。而且它是接上的 ——
`server/glue/flow.ts:331` 在没有流程材料时就走这条。✅自证

**准确的说法（降级为 medium）：** Event 只存在于 FlowGraph，**OIR 侧没有对应容器**
（`oir.ts` 全文零处 "event"，容器只有六个），`ActionType` 也没有 `emits` 字段。
后果是 Event 拿不到证据、进不了交付包的对象模型、编辑面也补不了载荷 ——
但**不是「零个事件」**。§5 的 A6（Event 升为 OIR 一等公民）仍然成立，理由要换成这个。

### 9.2 ❌ 被推翻：「主键没有任何坑位，人工也补不回来」（原判 blocker）

**错在哪：** `DATA_STEWARD_SCHEMA.data_objects` 把 `business_keys` 列为**必填**
（`agents.ts:525、537`），而 `data_steward` 是正式 agent、在冻结拓扑里是
`DATA_OBJECTS` 节点（`engagement.ts:103`）。模型**有**位置放主键。

**准确的说法（拆成一条 major + 一条 minor）：**
- **major**：主键在自动路径上确实填不上，但成因是**分析结果不回写 OIR** ——
  data_steward 产出的 `business_keys / system_of_record / lifecycle_states`
  只活一个 revision，重编译即蒸发。抽取 agent 那侧确实没有主键字段，
  唯一自动来源是 `pipeline.ts:1113` 的 `apiName.endsWith("id")` 启发式，
  零属性对象必空、`plan_no`/`编号` 这种命名也必空。
- **minor**：每个空 primaryKey 的对象都会被 `conflict.ts:573` 无条件报一条
  「未声明主键」，但它被路由成模板回传而不是问题 —— 所以 FDE 在界面上看不到。

### 9.3 三处说法要收紧

| 原话 | 准确说法 |
|---|---|
| 「Action 的 actor 在交付契约里被抹掉」 | **只有 `preconditions` 是真丢的。** `actorRole` 在 legacy 层确实写死 null（`canonical.ts:1121`），但 V1 交付层回捞了原始 OIR 的 actor（`ontology_package.ts:1257`），落进 `bindings.role` |
| 「属性从没上过屏」 | 准确说法是**「上过屏的组件被新右栏顶掉、留成了死代码」**：`preview.tsx:200-219` 的 EntitiesTab 会画属性统计和前 40 条的 apiName + definition，还有测试钉着（`ui.react.preview.test.tsx:303`）。它不可达是因为新 sidebar 替代了它 |
| 「列画像算好了没往 OIR 回灌」 | 更准确：**三套 context read-model 并存，最厚的那套在装配点被整个丢弃** —— `context.ts:424-660` 的 `buildModel` 为每个属性发 `baseType/semanticType/unit/required/valueDomain`，右栏拿到的却是另一套只有计数的 |

### 9.4 遗漏批评补的新缺口（跨实体，◻ 待复核）

按实体分头查必然漏掉跨实体问题。这几条是补出来的：

1. **blocker｜属性 rid 里嵌了段内数组下标**：`pipeline.ts:961`
   `makeRid("pt", ${parent}_${api}_${i})`，`i` 是该段 properties 数组的位置。
   重跑一次抽取顺序一变，**整份模板回传就对不上号**。
2. **blocker｜`OIR.validate()` 是彻底的死代码**：全仓 `.validate()` 只有两个调用点，
   都在测试里。「未声明主键 / 父对象不存在 / 未声明 joinKey」三条校验从未在生产路径跑过。
3. **blocker｜extractor 的 schema 没有 actions/rules 容器，任务描述却向它索要**：
   `backends.ts:1014` 的 `strictify` 强制 `additionalProperties:false`，
   模型抽出来的 action/rule **在结构化输出这一层就被截掉**，一句话都不说。
4. **blocker｜「对象零属性」在整条链路上不产生任何 finding / question / conflict / gate**：
   `gaps.ts:483` 的四类检查里没有零属性，`conflict.ts:129` 的 8 种 ConflictKind 也没有。
5. **blocker｜无材料草案路径产出的 OIR 是空对象**：`tools.ts:2131`（draft.initialize）
   与 `:2894`（draft.adopt）都是 `new OIR()`，只搬 FlowGraph。属性必然为空。
6. **blocker｜`FlowNode.objects` 没有声明 id 空间**：两个写入方 + 四个消费方各按各的口径
   解释（`flow_link.ts:358` 推的是 `resolveHost` 的返回值）。新加的 `bind_objects`
   统一存 rid，但**老写入方还没对齐**。
7. **major｜`oirTable` 是全链路最窄的一层投影**：`tables.ts:195` 对象只有四列
   （名称/API 名/说明/状态）—— 聊天里那张「业务对象列表」没有属性列，就是它。
8. **major｜影响面分析 `dependents()` 看不见规则、事件和流程节点**（`oir.ts:797`）。

---

## 10. 实施记录 · 补 A7 第一块（同日）

**起因：遗漏批评读到了我 20 分钟前刚写的代码，并指出它在撒谎。**

S2 的「未接入流程」缺口小标会生成一句
「用 `flow.edit` 把那些节点绑到这个对象上」——
而 `flow_edit.ts` 的七个 op 里**没有一个碰得到 `FlowNode.objects`**（全文零处 "objects"）。
右栏指着一个不存在的能力。

**改法不是把提示词改软，是把能力补上**（这本来就是 §5 的 A7）：

- `flow_edit.ts` 新增 `bind_objects` op：`node` + `objects[]`，
  中文名 / apiName / rid 都能指对象，**落盘一律存 rid**（消费方按 rid 比）
- 名字对不上**整条报错并点名**，不静默跳过 —— 静默跳过会让人以为绑上了
- 对象名解析复用 `oir_edit.ts` 的 `findObject`（导出复用，不抄第二份判据），
  经 `FlowEditOptions.resolveObject` 注入 —— flow_edit 不 import OIR，
  否则「改流程图」和「读模型」就焊死了
- 工具 schema 的 op 枚举与描述同步补上（枚举里没有 = 模型看不见 = 等于没做）
- 7 条测试：中文名/apiName 都能绑、存的是 rid、对不上号点名报错、
  报错不留半绑状态、重复绑不绑两遍、事件节点也能绑、op 在表里

**这一条是本轮最值得记的：** 缺口提示必须指向真实存在的能力。
报缺不给下一步已经是把活推回给人，**给一个假的下一步比不给更糟**。

---

## 11. 实施记录 · A1 抽取 schema 补齐（2026-08-19 晚，最后一块）

| 件 | 内容 |
|---|---|
| **objects** | `primary_key`（数组，材料里明确标了才给）、`classification`（复用 data_steward 的五类枚举） |
| **properties** | `value_domain`（枚举取值表）、`semantic_type`（金额/日期/编号/状态…） |
| **links** | `cardinality` 补 `MANY_TO_ONE`（落库时对调两端 —— 与对话路径同一个语义，原来两条路两个意思）、`join_key {from_property, to_property}` → `{from: to}`，翻转时键值跟着换边 |
| **新桶 ×3** | `actions[]`（actor/preconditions/effects/applies_to）、`events[]`（emitted_by/payload_objects）、`rules[]`（statement/kind/actor/condition）—— 以前任务描述向模型点名要 action 和 rule，schema 里却没有位置，**strictify 在结构化输出层整桶截掉、一句话不说**；202 个对象里混着「创建采购订单」就是这么来的 |
| **OIR** | `ObjectType.classification` 新字段；**`EventType` 成为一等公民**（rid/apiName/displayName/emittedBy/payload，序列化键 producerAction/objectIds 与右栏 modelItems 的既有读法对齐 —— UI 早就在读这两个键，只是从来没人发过）；`OIR.events` 容器 + `addEvent`；toDict/stats **可选发射**（没有事件时一个键都不多） |
| **buildOir** | 全部新字段接住落库：声明主键**胜过**「以 id 结尾」启发式（extracted 带出处 vs inferred），复合主键解析不全就不写（写一半更误导）；emitted_by 解析成 Action rid，认不出存原样（宁可粗也不丢） |
| **MergeSegments** | 桶清单补 `events` —— schema、merge、buildOir 三处同一份清单，漏一处就是「模型抽了、产物里没有、没人报错」 |

### 纪律复述（这一块全程贯彻的三条）

1. **schema 有坑位、落库就要接住** —— 只声明不落，模型填了也是白填；
2. **新字段一律可选发射** —— 老会话字节原样，全部旧 golden 逐字节通过；
3. **声明的胜过猜的** —— extracted（带出处）压过 inferred（启发式），origin 如实。

新增 12 条测试（onto.extract-a1.test.ts）。golden 改动三处：agents.json 的
extractor output_schema（从 TS 源导出注入，不手抄第二份）、onto.pipeline.json 的
merge.out 补空 events 桶、属性 rid 去下标（上一批已做）。
全量 **6458 passed / 6 failed**，6 条仍是另一个会话在途工作。

**至此 §5 的 P0 全部完成**：A0–A9 里除 A3（交付契约接规则结构）与 A9（接活
action_drafter）外全部落地；A2（登记表第二遍属性扫描）由 sample_kit 方案取代
（见强化方案文档）。
