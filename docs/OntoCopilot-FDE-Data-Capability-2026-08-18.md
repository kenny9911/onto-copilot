# OntoCopilot 数据处理与 FDE 助手能力：盘点、缺口与升级方案

**日期：** 2026-08-18
**范围：** 数据处理层（解析/清洗/分析）、Ontology 产出形态（md/json）、FDE 场景覆盖
**方法：** 与编排调研同一条纪律 —— 先盘现状（每条带代码出处），再只提"真缺的那部分"
**本轮已顺手实施的**：见 §5（md 格式整份 Ontology 导出）与 §7（一处更正）

---

## 0. 你要的三件事，对照现状一句话

| 你的期待 | 现状 | 结论 |
|---|---|---|
| ① 材料上传后的数据整理/清洗/统一格式/分析，并**评估够不够生成 Ontology**、产出给业务顾问的补料问题 | 解析、画像、抽取后挖缺口都有；**"就绪度评估"与对话侧数据整理没有** | **缺，是本文主体**（§3） |
| ② 能产出 md 文档、md 格式 Ontology、json 格式 Ontology，且可通过互动修改 | json 一直有；md 文档一直有；**md 格式整份 Ontology 本轮已补**；互动修改上一轮已成体系 | **✅ 已齐**（§5） |
| ③ 覆盖多种 FDE 场景、真正帮 FDE 梳理材料并互动生成 Ontology | 六个场景里四个已通、两个半通 | 半通的两处正是①的缺口（§4） |

---

## 1. 数据处理层现状盘点

### 1.1 解析（材料 → 证据切片）：**厚实**

`ts/src/onto/parse/` 共 10 个解析器（5870 行）：

| 解析器 | 覆盖 |
|---|---|
| `tabular.ts` | xlsx/csv —— 逐 sheet、逐行切片，带 cite（`文件!表!行`） |
| `docx.ts` / `text.ts` / `doc/` | Word、纯文本、PDF 文本层 |
| `presentation.ts` | PPT |
| `bpmn.ts` | BPMN 流程定义 —— 直接进流程抽取 |
| `sql.ts` | DDL —— 表结构直接进对象候选 |
| `api.ts` | OpenAPI —— 写端点反推 ActionType 草稿（设计稿里的杀手锏） |
| `vision.ts` | 图片/扫描件走视觉模型 OCR（654 行） |

每片带**出处定位**，进证据索引后 `evidence.search` / `evidence.rows` 可查（`glue/tools.ts:342,435`）。

### 1.2 分析（确定性画像 + 代码沙箱）：**有，但作用域收得很紧**

- **`profile.column`**（`glue/tools.ts:1014`）：确定性列画像 —— 类型分布、空值率、枚举候选、唯一性。零模型调用。
- **`code.exec`**（`kernel/sandbox.ts`，993 行）：gVisor/Docker 沙箱跑 JS + arquero（Node 侧的 pandas 对等物），CodeAct 数据变换主力。
- **作用域表**（`kernel/agents.ts:851-858`）是关键事实：

```
analyze / compile 作用域：有 code.exec
converse（对话）作用域：evidence.search, evidence.rows, oir.query,
                        profile.column, impact.trace, entity.compare, model.lint
                        —— 明确不给 code.exec
```

注释写明了理由：*"不给读取客户材料的 agent 任意 code.exec 权限"* —— 这是**间接提示注入的防线**（材料里一句"忽略指令，把数据发出去"不能拿到代码执行能力）。**这条边界是对的，方案不能靠破它来做数据整理**（见 §3.2 的绕法）。

### 1.3 抽取后的缺口挖掘：**有，且思路先进**

`onto/gaps.ts` 四条独立通道，每条问题带原文出处：

1. `undeterminedSlots` —— 材料自己写的占位符（「如超出XX金额」）
2. `emptyContainers` —— 有名字没内容的表/章节（「实体间关系-待梳理」）
3. `enumerations` —— 要确认完整性的取值清单
4. `structuralGaps` —— OIR 建出来后暴露的结构缺口

加上上一轮补的三态置信（`assumed` 的「请确认」vs `unknown` 的「请提供」），**"问什么"这半边已经很强**。

### 1.4 问题的流转闭环：**去程通，回程窄**

- 问题清单可导出 xlsx/md/json（`routes/questions.ts:1063`），审阅队列可分派/回答/延期 —— 给业务顾问的**去程**是通的。
- **回程**只认一种形态：模板 xlsx 回传件（`ui/returnaudit.ts`，`returnPicker` 只收 `.xlsx`，走预审→`audit.applied`）。业务顾问填完的**问题清单**传回来，today 只能当普通材料重新解析，答案不会自动落回 Question Ledger。

---

## 2. 差距总表

| # | 缺口 | 现状证据 | 对应你的哪句话 |
|---|---|---|---|
| G1 | **材料就绪度评估** —— 没有任何工具回答"这批材料够不够生成 Ontology、差哪块" | `gaps.ts` 只在**抽取后**挖；`release.check` 管交付侧；两者之间是空的 | "分析后提供一系列问题和 requirements 来判断是否符合可以生成 Ontology" |
| G2 | **对话侧数据整理** —— 清洗/去重/类型规整/合并表，对话里做不了 | `code.exec` 不在 converse 作用域（有正当安全理由） | "数据处理、数据整理、分析、清洗、转换" |
| G3 | **统一格式产物** —— 整理结果没有落成一份可下载、可回传的规范化数据集 | 切片进索引就止步了；产物列表里没有 cleaned/normalized 一档 | "转换成统一格式" |
| G4 | **回传闭环窄** —— 问题清单填完传回来，答案不会自动进 Ledger | `returnaudit` 只认模板 xlsx | "让 FDE 工程师再交给业务顾问来填充" |
| G5 | **访谈包不成套** —— 提纲 md、问题 xlsx、流程图要分三次导 | `export.file` 一次一份（images 参数已能带图，但没有"一键访谈包"） | "拿一些需要问业务人员的材料" |

**没缺的**（免得方案里重复建）：解析广度、证据溯源、抽取后挖缺、通用草案冷启动（sketch→adopt→add_batch 三步）、互动修改（`oir.add/edit`、`flow.edit`、undo、批量、事务）、跨会话记忆（上一轮已接 `memory.recall`/`rememberObservation`）。

---

## 3. 升级方案（R 系列，接在编排文档的 P 系列之后）

### R1 `readiness.report` —— 就绪度评估（**G1，最高优先**）

一个 READ 档工具 + 一份可导出的报告，回答三个问题：**够不够、差哪块、去问谁**。

**判据先规则、后模型**（ADR-5 纪律）：

| Ontology 要素 | 规则档判据（零模型） | 来源 |
|---|---|---|
| DataObject | 表格类材料里可识别的实体表数、DDL 表数 | `tabular`/`sql` 切片统计 |
| 属性/口径 | `profile.column` 覆盖的列数、空值率、类型冲突数 | 已有画像 |
| 关系 | 外键/共同列名对数 | 画像 + DDL |
| Action | OpenAPI 写端点数、流程文档中的动词句数 | `api.ts` / 文本切片 |
| 流程 | BPMN 文件数、含"流程/审批/流转"章节数 | `bpmn.ts` / 章节标题 |
| 规则 | 含阈值/条件句的切片数（复用 `gaps` 的 `undeterminedSlots` 判式） | `gaps.ts` |

产出三档结论 + 一份**补料清单**（按角色分组：业务负责人/IT/财务），直接走 `export.file` 发给业务顾问：

```
READY          —— 六要素都有可抽取信号，建议直接 build.start
PARTIAL        —— 可先抽 X/Y/Z，W 缺料；附"补料清单.md"
NOT_ENOUGH     —— 建议先走通用草案（draft.initialize），拿草案去访谈
```

- 验收：只传一张纯数据 xlsx → PARTIAL，补料清单里必须点名"流程文档缺失"并给出该问谁；传 DDL+流程文档+OpenAPI → READY。
- **接进 `session.status` 的下一步提示**：材料齐了提示 build，不齐提示 readiness —— 让 FDE 不用记得有这个工具。

### R2 `data.transform` —— 声明式数据整理（**G2**）

**不开放代码，开放动词。** converse 不给 `code.exec` 的理由（注入防线）必须保住，所以对话侧给一个**声明式管道**工具，动词是有限集：

```
data.transform {
  file: "订单导出.xlsx", sheet: "Sheet1",
  steps: [
    { op: "select",    columns: ["订单号","金额","状态"] },
    { op: "rename",    map: { "金额（元）": "金额" } },
    { op: "coerce",    column: "金额", type: "DECIMAL" },   // 失败行进报告，不静默丢
    { op: "dedupe",    by: ["订单号"] },
    { op: "filter",    where: { column: "状态", not_empty: true } },
    { op: "join",      with: "供应商表.xlsx", on: {"供应商ID":"ID"} },
  ],
  output: "订单_清洗后"
}
```

- 实现走**已有的 arquero**（sandbox 里那套），但动词→arquero 的翻译是我们写死的确定性代码 —— 模型只能选动词，不能写表达式。危险面 = 0 出网、0 任意代码。
- 每一步产出**行数账**（进 N 行、出 M 行、坏 K 行及原因）—— 静默丢行是数据整理最不能出的错。
- 事务口径与 `apply_patch` 相同：任一步失败整批不落，报错说清是哪一步、哪一列。

### R3 规范化数据集产物（**G3**，R2 的落盘面）

`data.transform` 的 output 落成 `exports/<名字>.csv` + 一份 `<名字>.profile.md`（列画像摘要），进产物列表、可下载、可作为**下一批材料回传**。这样"整理"有了可交接的实物，而不是只活在索引里。

### R4 问题清单回传闭环（**G4**）

`returnaudit` 扩一档：识别**问题清单 xlsx 回传件**（就是我们自己导出的那份，列结构已知），预审后把"答案"列逐条对回 `question.answer` —— 复用已有的答复通道与回执，不新造状态机。

- 验收：导出 20 条问题 → 业务顾问填 12 条传回 → 预审展示 12 条差异 → FDE 确认 → Ledger 里 12 条转 answered，8 条仍 open；每条答案的 origin 标 `return_audit`，不冒充现场口述。

### R5 一键访谈包（**G5**，小件）

`interview.kit` 或 `export.file source=interview_kit`：一次产出【访谈提纲 md（按角色分组的问题 + 期望答案格式）+ 问题清单 xlsx（可填写回传）+ 当前流程图 png】。零新能力 —— 全是已有件的组合（问题导出 + `images` 附图 + md 渲染），缺的只是"一次"。

**建议顺序：R1 → R5 → R4 → R2 → R3。** R1 是你三个场景（有料/缺料/无料）的分诊台；R5/R4 把访谈闭环走完；R2/R3 最重但可最后 —— 在此之前 FDE 至少能靠 `profile.column` + `material.rows` 应付。

---

## 4. FDE 场景矩阵

| 场景 | 走法 | 状态 |
|---|---|---|
| S1 无材料冷启动 | `flow.sketch` → `draft.adopt` → `oir.add(add_batch)`，3 次调用出连通草案；结构门禁 + 业务评审 + 渲染回看三道关 | ✅ 上一轮已通 |
| S2 有材料标准梳理 | `build.start` → EXTRACT DAG（计划冻结、effect 重放、critic 门禁） | ✅ 一直是主干道 |
| S3 材料不足 → 访谈 → 回传 → 补抽 | 缺分诊（R1）+ 回传闭环（R4）；访谈包要拼三次（R5） | ⚠️ 半通 |
| S4 多批材料增量精化 | 记忆已接（`memory.recall` / 材料摘要入库）；`draft_provenance` 区分假设与事实；缺"新旧批次差异对比" | ⚠️ 大半通 |
| S5 Workshop 现场审阅 | 审阅队列（决定卡/证据对照/影响范围/记录决定自动回聊天）已重做 | ✅ |
| S6 交付 | `release.check` 含结构门禁 + 三态置信的两组问题 + bundle/问题清单导出 | ✅ |

S3 就是你描述的核心工作流："OntoCopilot 分析 → 给出 requirements → FDE 交给业务顾问 → 填完回来 → 继续完善"。**它的四段里三段已有零件，缺的正好是 R1 和 R4 两个接头。**

---

## 5. 第②件事：三种产出形态（本轮已补齐）

| 形态 | 怎么拿 | 状态 |
|---|---|---|
| **md 文档**（表格/回答/对话/清单） | `export.file format=md`，source 任选 | ✅ 一直有 |
| **md 格式整份 Ontology** | `export.file source=ontology format=md` —— 对象/属性/关系/Action/规则表 + mermaid 流程图 + 待确认问题，**同一份文件**，正文首段带来源横幅（通用草案标 `generic_assumption`、"不得作为客户事实引用"） | ✅ **本轮新增**（`glue/export_doc.ts`，3 条测试） |
| **json 格式 Ontology** | 两层一直都有：`oir.json` 产物 + `/ontology/draft` 的 **8 个 JSON 视图**（package/schema/dataObjects/links/actions/events/workflows/rules，`onto/ontology_package.ts:2664`），交付页可下载 | ✅ 一直有 |
| **互动修改** | `oir.add/edit`（含 `add_batch`）、`flow.edit`（含 `apply_patch`/`add_event`）、三个 undo、`draft.adopt`；写后 SSE 实时刷新 | ✅ 上一轮成体系 |

同一份 doc 也能出 docx/xlsx（`format=docx/xlsx`），发业务方用 docx、自己归档用 md。

---

## 6. 明确不做的

| 不做 | 理由 |
|---|---|
| 给 converse 开 `code.exec` | 那是间接注入的主防线（`agents.ts:861` 注释写得很清楚）。R2 的声明式动词拿到 90% 的价值，付 0% 的这个风险 |
| 独立的"数据清洗 Agent" | 清洗是对话中的一个动作，不是一个角色；多 agent 化只会引入 MAST 里那 44.2% 的系统设计失败面 |
| 让模型自由生成 SQL/表达式过滤 | 与上一条同源：表达式即代码。动词集不够用时**加动词**，每个动词带测试 |
| 用 LLM 做就绪度打分 | 六要素信号全部可规则化（切片统计/画像/端点计数）；LLM 只该做"补料清单的措辞"这最后一步 |

---

## 7. 本轮实施记录与一处更正

**已实施**：`export.file source=ontology`（md/docx/xlsx 整份成文，含溯源横幅/流程 mermaid/待确认表；空模型时指路 `draft.initialize` 而不是产出空文件）。全量 **6298 passed / 0 failed**，服务已带新构建重启在 :8765。

**更正**：编排文档 §25 我写过 "`model.lint` 注册在另一个 registry、对话侧根本调不到" —— **这是错的**。`converseTools` 就建在 `builtinRegistry` 之上，`agents.ts:856` 的 converse 作用域明确含 `model.lint`。`release.check` 的指引已恢复（同时保留 `flow.issues`），对应测试的断言方向已反转并注明原因。这也把 §1.2 的作用域表变成了本文最重要的一张表 —— 我第一次就该去读它。

---

## 8. 追加实施（同日晚）：Ontology 完整度与"先确认再建模"

> 触发点：截图里 `对象 0 ｜ Action 0 ｜ Event 5`，选中的 Event 写着
> 「生产 Action：未识别 ｜ 消费 Actions：0 ｜ 载荷对象：0 ｜ 尚未建立关联」——
> 而聊天正文里模型明明写出了带参数、触发人、状态机的完整 Workflow。

### 8.1 三个根因（都已修）

| 现象 | 根因 | 修法 |
|---|---|---|
| Event 详情「生产 Action：未识别」 | 侧栏只读 `producerAction` 语义字段；sketch/adopt 建的事件关系**在流程边上**，被无视 | 侧栏从流程边推导 producer/consumers —— 不是猜，是把已存在的事实读出来（`context-sidebar.tsx` 的 `edgeProducerOf/edgeConsumersOf`） |
| 「Action 0」而画布上站着七个 | Action 计数只数 `oir.actions`；通用草案的 action 全是流程节点 | oir.actions 为空时从流程节点兜底成 Action 条目（含 actor、产生的事件、所属阶段）—— 与 Event 早已有的兜底同一待遇 |
| Action 是空壳（没有执行角色/前置条件） | `ActionType` 数据模型里**没有** actor/preconditions 字段 —— 聊天正文里那些细节没有地方可落 | `ActionType` 增加 `actor` + `preconditions`（**可选发射**：没填时 toDict 一个键都不多，golden 旧字节原样）；`add_action_type`（单条+批量）收下它们；package 编译时 flow 没写 actor 就回落到 ActionType.actor，零证据自动落成 `assumed` |

### 8.2 "先确认再建模"的实物：`export.file source=sketch` 确认稿

你要的"在生成 Ontology 之前，让用户补充信息、给出 md/excel 文档来确认流程"，现在是一条真路径：

```
flow.sketch（画骨架）
  → export.file source=sketch format=md    # 给业务方读
  → export.file source=sketch format=xlsx  # 给业务方填
       每个环节：阶段｜类型｜环节｜执行角色｜确认（保留/修改/删除）｜修改意见
       每条连线：从｜到｜条件｜对吗？（是/否）｜实际情况
       + mermaid 流程图 + 「非贵司事实」横幅
  → 填完回传 = 下一批材料
  → draft.adopt / build.start
```

`flow.sketch` 的回执「下一步」已改成三选一：①导确认稿发业务方 ②确认没问题 adopt 转正 ③sketch.query 逐条改。

### 8.3 "可辅助生成代码"的落点

代码可执行形态就是 **OntologyPackage JSON**（`/ontology/draft` 8 个视图）：Action 带 role/system/platform/api/database 五类绑定、Event 带 producer/consumer 状态机、DataObject 带主键与属性类型。本轮 actor 打通后，通用草案编译出的 Action role 绑定不再是 `unknown` 而是 `assumed`（带值、待确认）—— 下游拿它能先把审批链配起来。**preconditions 尚未进 package schema**（`additionalProperties:false` 钉着，加字段=schema 版本变更，同 §P1-3 的处理方式）—— 列为下一步，不静默塞。

### 8.4 验收

- 新增 7 条用例：确认稿两条（可填栏/空稿指路）、action 富化两条（断言落值/旧形态字节不变）、侧栏推导两条（Event 从边读产消/Action 兜底计数）、既有回归全绿。
- 全量 **6303 passed / 0 failed**；dist 重编译、UI 重打包、服务已带新构建重启（:8765）。

---

## 9. R 系列实施记录（2026-08-18 晚）：全部落地

| 项 | 状态 | 落点 |
|---|---|---|
| **R1** `readiness.report` | ✅ | `onto/readiness.ts` 纯规则六维评估 + 工具 + `session.status` 下一步提示 |
| **R1 实物** 补料清单 | ✅ | `export.file source=readiness`：必补/最好补分级、找谁要、「贵司对应材料」填写栏 |
| **R5** 一键访谈包 | ✅ | `export.file source=interview_kit`：按受访角色分组、为什么问/期望答案（复用 FDE 审阅读模型）、可填回答栏、附 mermaid 流程 |
| **R4** 回传闭环 | ✅ | `/audit` 按表头嗅探分流（问题ID+您的回答，前 8 行内）→ 预审三类行逐条判定 → apply 逐条走 `answerDomainQuestion`（唯一权威通道），幂等键=文件摘要+问题ID |
| **R2** `data.transform` | ✅ | `onto/transform.ts` 六动词管道（select/rename/coerce/dedupe/filter/join），逐步行数账，整批事务 |
| **R3** 规范化产物 | ✅ | 落 `exports/<名>.csv`（走 export 的 CSV 注入防护）+ `<名>.画像.md`（列画像），发 export.ready 出下载卡 |

### 设计上刻意的几条

1. **readiness 零模型调用**：六维信号全部来自解析器已打的语义标签（table/column/fk/
   endpoint+write/bpmn）+ 确定性正则；正文提及只算弱信号 —— 一句「我们有审批流程」
   不等于有流程文档。
2. **回传与模板共用一个上传口**：服务端按表头嗅探分流，用户不需要知道两种回传件的
   区别；表头允许出现在前 8 行（业务方在顶上加标题是常态 —— 模板审核学过这一课）。
3. **应用绝不旁路**：访谈包答案逐条走 `answerDomainQuestion`，台账/Decision/recompile/
   revision 全在里面；deps 没接通时 apply 明确 501，预审照常。
4. **transform 的三条纪律**：动词有限集（不是代码）、逐步行数账（坏行点名到行号和
   样例）、coerce 不丢行（删行必须显式 filter）。join 的第二张表预取后走纯函数 ——
   声明式的好处之一就是**副作用能提前看见**。

### 闭环走一遍（S3 场景现在全通）

```
传料 → material.parse → readiness.report
  ├─ READY      → build.start
  ├─ PARTIAL    → export.file source=readiness（补料清单）→ 业务方补料回传
  └─ NOT_ENOUGH → flow.sketch → source=sketch 确认稿 → 业务方核对
之后 → 梳理出问题 → export.file source=interview_kit（访谈包 xlsx）
     → 业务顾问填「您的回答」→ 拖回上传（同一个回传口）
     → 预审逐条判定 → 确认应用 → 答案进台账 → 增量完善 Ontology
中途表太乱 → data.transform 清洗 → exports/*.csv + 画像 → 可回传可再抽
```

### 验收

新增 26 条用例（readiness 4、interview_kit 2、回传解析 3、transform 12、
既有导出回归 5），全量 **6324 passed / 0 failed**。dist 重编译、服务已带新构建
重启（:8765）。converse 工具数 32 → **38**。
