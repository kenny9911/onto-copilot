# AI 驱动的流程图生成：多策略 + 证据驱动路由

**日期：** 2026-08-26
**状态：** 设计待评审
**范围：** 让流程图真正由 AI 分析材料产生，而不是由固定规则拼装；并让 AI 自己在多种生成策略之间做选择
**本轮不做：** 流程图之外的产物；OIR 抽取链路

---

## 1. 问题

现在的流程图由一条**零模型的正则管线**产生（`buildFlowDiagram`，[glue/flow.ts:180](../../../ts/src/server/glue/flow.ts)）。它的每一处形状都由固定表决定，而不是由对材料的理解决定：

| 环节 | 现在的判据 | 后果 |
|---|---|---|
| 文本是否进入抽取 | 长度 ≥60 码点 | 短句写的步骤一律看不见 |
| 是否算流程说明 | ≥2 个编号标题 **且** ≥2 个字段标签（触发条件/输入/输出/执行者） | 写成「前提/结果/经办」得 0 分，整份材料被丢弃 |
| 网关识别 | `text.includes("如") && (includes("则") \|\| includes("否则"))` | 不含这三个字的分支识别不出来 |
| 事件命名 | 字符串拼接 `${输出}已生成`（已是「已X」形态的会被 `DONE_RE` 放过，不重复拼） | 输出名词多半不匹配 `DONE_RE`，于是一列「XX已生成」 |
| 阶段划分 | 写死的 14 词中文采购词表 `DOMAIN_CODES` | **实测退化的是编号不是泳道**：报销域会话 `bfa65697` 仍拿到 4 条正常泳道，但 40 个节点里 31 个编号是 `*-GEN-<hash>`；`d53cb63f` 是 61/64 |
| 边 | 「触发条件+输入」子串包含**任一其它节点**的产出（无前后方向限制），上限 2 条；零入度节点固定连成 `推断顺序` 虚线 | 多数边无据 |
| 抽不出时 | `flow.skipped`，然后由 API 清单兜底 | 得到「接口按文件顺序排成一条链」 |

真实库的实测印证（`workspace/*/flow.json`，逐条实跑核对）：

- 多数会话 `action 数 == event 数`（32/32、19/19、17/17）——`flowFromActions` 机械配对的指纹。
- **6 个会话的边 100% 是 `inferred`**：`424ef360`(18/18)、`bafd0dd0`(19/19)、`bfa65697`(46/46)、`5f8efcf8`(11/11)、`f6fca93b`(11/11)、`c3e56e56`(8/8)。
- `workflows` 容器全库为 0。
- 会话 `d53cb63f` 的 32 个「动作」全是 API 端点名，阶段全叫 `api1`（stage 标题「未归属接口」）。

**事件命名的病根（此前一版 spec 写错了，这里更正）：** 32 个事件**不是**同一个串。实际分布是
`单据已修改`×10、`单据已创建`×7、`单据已提交`×4、`单据已审批`×3、`单据已导入/已同步/已关闭`各×2……
**动词是随 API 动词变化的，恒定的是前缀「单据」**——而 `单据` 是 [flow_link.ts:543](../../../ts/src/onto/flow_link.ts) 在
`oir.objects.get(host)` 未命中时的兜底字面量（`host = a.appliesTo[0]`）。stage 标题「未归属接口」印证了
这 32 个 action 一个都没绑上对象。

所以真正要修的是 **`appliesTo → object` 解析不到**，不是命名模板。同理 `d53cb63f` 的 `inferred_edges`
是 31/63 而非全部，`fc58b72e` 是 18/37。

### 1.1 被浪费的三个信号

1. **PPT/Visio 的连接线**：`presentation.ts` 只遍历有文字的 `sp` 形状，从不解析 `cxnSp`（连接线）、`stCxn`/`endCxn`（连到哪两个形状）或 SmartArt 的 `diagramData`。**文件里现成的流程结构被整体丢弃。**
2. **图片流程图的连线**：`vision.ts` 的 `OCR_SCHEMA` 已经要求并产出 `relations`（实测 gemini-flash 在百节点流程图上认出 34 条连线），但**没有任何流程构建代码读它**。
3. **`FlowNode.actor`**：一路被收集、存储、要求模型填写、还被 critic 检查——**渲染器从来不画它**。泳道图的数据早就齐了。

### 1.2 渲染器的两个真缺陷

- **没有全局 x 轴**：列号在每个阶段带内从 0 重新开始（[diagram.ts:411-418](../../../ts/src/onto/diagram.ts)），所以跨阶段的**前向**边会命中 `tx < sx` 的「回退边」分支，被画成一条离开带框的回退弧（实测控制点 x=2，而带框从 x=24 开始）。正常的向前流程看起来像回滚。
- **`Workflow` 容器两个 emitter 都不读**，所以它永远是空的也没人发现。

---

## 2. 设计原则

1. **真相与呈现分离。** 无论哪条策略产出，都必须收敛到同一个 `FlowGraph` 契约。图像永远只能是**展示副本**，不进证据链、不参与校验、不进交付包的结构校验。
2. **保真度不可伪装。** 每条策略带一个保真度档；低保真不得冒充实证。`origin=EXTRACTED` 且 evidence 为空是非法状态。

   ⚠️ **这道门禁当前不存在，必须本设计自带。** 评审核实：两个 provenance critic
   （[pipeline.ts:1822](../../../ts/src/onto/pipeline.ts)、[engagement_runtime.ts:3064](../../../ts/src/onto/engagement_runtime.ts)）
   都只发 `Severity.MEDIUM`、都不检查 `origin`、都不看流程节点与边；engagement 那个的
   `passed` 还是恒真。只有 schema critic 会发能 block 的 HIGH。
   因此新增一条**确定性硬校验**：在 `publishFlow` / `rewriteFlowArtifacts` 落盘之前遍历
   FlowGraph，凡 `origin=EXTRACTED` 而 evidence 为空的断言直接抛错终止，不写产物。
   这是本设计所有「实证档」承诺的唯一实际支撑点。
3. **判据用结构性特征，不用业务词表。** 这是本项目既有纪律（换一个行业的材料还成立吗）。新策略一律不得引入第二张 `DOMAIN_CODES`。
4. **路由决策可审计、可覆盖。** AI 选了哪条路、为什么选，作为带出处的记录写进产物；用户可以指定策略强制覆盖。
5. **冲突不静默合并。** 多策略结果不一致时保留双方并生成问题，沿用既有问题分诊。

---

## 3. 架构：三层

```
┌─ 呈现层 ────────────────────────────────────────────┐
│ R1 确定性 SVG（产物之记录）  R2 actor 泳道           │
│ R3 边上条件   R4 图像模型「汇报版」（展示副本）        │
└──────────────────────────────────────────────────────┘
                      ↑ 只读 FlowGraph
┌─ 真相层 ────────────────────────────────────────────┐
│              FlowGraph（唯一契约）                    │
│   nodes/edges/stages/workflows + Assertion + Provenance│
└──────────────────────────────────────────────────────┘
                      ↑ 收敛
┌─ 策略层 ────────────────────────────────────────────┐
│ S1 BPMN  S2 PPT连线  S3 视觉识读  S4 LLM文本建模      │
│ S5 表格顺序  S6 API反推  S7 通识参考图                │
│              ↑ 由 flow_strategist 选择                │
│         ← 零模型材料能力扫描（信号摘要）               │
└──────────────────────────────────────────────────────┘
```

---

## 4. 策略层

### 4.1 策略清单

| 编号 | 策略 | 状态 | 保真度 | 模型成本 |
|---|---|---|---|---|
| S1 | BPMN/XML 直读 | 已有 | 实证 | 零 |
| **S2** | **PPT/Visio 连接线直读** | **新增** | 实证 | 零 |
| **S3** | **图片流程图视觉识读** | **新增（接线）** | 实证 | 已在 PARSE 付过 |
| **S4** | **LLM 文本流程建模** | **新增** | 实证 | 中 |
| S5 | 表格顺序推断 | 已有 | 推断 | 零 |
| S6 | API/DDL 反推 | 已有 | 推断 | 零 |
| S7 | 通识参考图 | 已有（`flow.sketch`） | 通识假设 | 中 |

保真度三档写进每个断言：实证 = `Origin.EXTRACTED` + 非空 evidence；推断 = `Origin.INFERRED`；通识假设 = 会话级 `generic_assumption` + `release_state=DRAFT`（既有机制）。

### 4.2 S2：PPT/Visio 连接线直读（新增，零模型）

**动机：** 客户材料里最常见的流程图载体就是 PPT。文件里已经明确记录了「哪个框连到哪个框」，现在被整体丢弃。

**做法**（新模块 `ts/src/onto/parse/pptx_flow.ts`，由 `presentation.ts` 调用）：

1. 遍历 `<p:cxnSp>`，读 `<a:stCxn id endIdx>` / `<a:endCxn id endIdx>` 得到**显式**的 `起点形状id → 终点形状id`。
2. SmartArt：`graphicFrame` → `dgm:relIds` → `data1.xml`，读 `dgm:pt`（节点）与 `dgm:cxn`（连接）。
3. 没有显式连接时的兜底：用**几何邻近**——连线端点落在某个形状 bbox 的容差范围内即判定连接。bbox 已经在解析（`shapeBbox`），是白捡的。容差按形状尺寸的比例算，不用绝对像素魔数。
4. 节点类型由**形状几何**推断，不用词表：`prstGeom prst="diamond"` → gateway；`ellipse`/`roundRect` 且无出边 → terminal；其余有文字的形状 → action。识别不出就一律 action，不猜。
5. 边标签取连接线自身的文字（`cxnSp` 内的 `a:t`）。

**证据：** `locator = {kind:"page", page, shape_id}`，可点回原幻灯片。

**不做：** 不解析动画、不解析分组嵌套的层级语义（有需要再说）。

### 4.3 S3：图片流程图视觉识读（新增接线）

**动机：** `relations` 已经在产出且无人消费。

**⚠️ 评审更正了三处，这条不是「接线」那么便宜：**

1. `doc.structured.relations` **已经是真数据**（[vision.ts:509-522](../../../ts/src/onto/parse/vision.ts)），
   `relations: []` 只出现在两条早退分支。**真正缺的是 blocks —— 它是个计数（整数），不是块列表。**
   块对象本身在 chunk 的 `raw` 里，locator 带 page 与 bbox，所以**不改解析器也能取到**。
2. 字段名是 `from_entity` / `to_entity` / `label`，**两端是实体文本**，不是 block id。需要一步
   「实体名 → block」解析，对不上的边按 S2 同一纪律丢弃。
3. **`blocks.kind` 的闭合枚举是 `title|entity_box|field|note|paragraph`，没有任何流程语义**
   （[vision.ts:117](../../../ts/src/onto/parse/vision.ts)），`OCR_SYSTEM` 通篇是 ER 图口径。
   所以「kind 由 block 类型推断」落不了地。

**据此定版做法（选保守档）：** S3 **只产 action 节点 + 边**，不产 gateway/terminal。
不扩 `OCR_SCHEMA`、不改提示词 —— 那会动 PARSE 主链、影响所有扫描件、要重跑 vision golden，
不属于 P1。节点类型留待人工或后续策略补。

**保真度：** 记入实证档（转写而非推断），但 `confidence` 低于 S1/S2，且**产物必须带一条显式说明**：
「识别到 N 个框 / M 条线，可能有遗漏」。原因是实测最好的模型在百节点图上只认出 34 条线
（[vision.ts:81-86](../../../ts/src/onto/parse/vision.ts)：gemini-flash 34 / opus 14 / gpt-mini 0）——
**漏掉的线会静默变成「这两个框之间没有关系」，是假阴性伪装成实证**，必须在产物上说破。

### 4.4 S4：LLM 文本流程建模（新增）

**动机：** 替换 §1 表格里那一整套正则判据。

**新 agent `flow_modeler`**（`ts/catalog/agents/18-flow-modeler.md`）。注意与既有 `process_modeler` 的区别：后者是 **enrich-only**，明令不得新增/删除/重排步骤，只能给既有基线补细节；而 `flow_modeler` 的职责正是**从文本创建基线**。两者不重叠。

**输出契约**（新 `FLOW_MODEL_SCHEMA`，形状沿用 `SKETCH_SCHEMA` 但**每个节点和边都必须带证据**）：

```jsonc
{
  "stages": [{ "key": "s1", "title": "…", "subtitle": "…" }],
  "nodes": [{
    "key": "n1", "kind": "action|event|gateway|terminal|external",
    "label": "…", "stage": "s1", "actor": "…",
    "evidence": { "chunk_id": "…", "quote": "…" }   // 必填
  }],
  "edges": [{
    "from": "n1", "to": "n2", "label": "金额>5万",
    "evidence": { "chunk_id": "…", "quote": "…" }   // 必填
  }],
  "caveats": ["…"]
}
```

**反编造闸门（关键，评审后加严）：** 模型给的是 `chunk_id + quote`，**不是** `Provenance`；
`Provenance` 由代码构造，模型无权直接写。核验分三层：

1. **存在**：该 `chunk_id` 存在。
2. **真伪**：`quote` 确实出现在该 chunk 的文本里（归一化后子串匹配）。
3. **相关（评审指出的漏洞）**：前两层挡不住「从材料里挑一句真话，贴到一个凭空捏造的节点上」——
   那样能拿到 `Origin.EXTRACTED` + 非空 evidence，混进实证档、被 `mainPath()` 当骨架、进交付包。
   因此增加相关性判据：**节点 label 的核心词必须能在 quote 里找到**（或 label 由 quote 派生）。
   判据本身用结构性比对，不引入业务词表。

**部分失败怎么处置（补 §9 的空白）：** 逐条拒绝会留下一张有洞的图（被拒节点的边端点消失 → dangling）。
定版规则：先逐条拒绝并回报模型自纠；**一轮之后仍有 >30% 的节点核验不过，则该策略整体作废**，
不交半张图，交由路由器换策略。两个数字都写进 `flow.strategy` 记录。

**保真度：** 鉴于第 3 层只是启发式，S4 记入**半实证**档，在图上与 S1/S2 用不同笔触区分渲染。

**输入：** PARSE 之后的 chunk（含 `_index`），按与 EXTRACT 相同的分段口径分批，避免一次塞爆上下文。

**预算：** 参照同档 agent，`difficulty: high`，token 预算与 `process_modeler`（90k）同量级；`critics: [schema, provenance]`。

### 4.5 S5 / S6 的处置

- **S5 表格顺序推断**：保留，但降级为推断档（现状已是）。
- **S6 API/DDL 反推**：保留兜底价值，但必须**改文案与标注**——当前它产出的图会被当成业务流程，而它实际是接口清单。改动：
  - 图标题与产物说明明确写「由接口清单反推，非业务流程」；
  - **修「单据」前缀的根因**：`host = a.appliesTo[0]` 解析不到对象时才落到字面量 `单据`
    （[flow_link.ts:543](../../../ts/src/onto/flow_link.ts)）。修 `appliesTo → object` 的解析，
    或用 endpoint 路径段 / `apiName` 里的资源名兜底。名字自然就分开了。

  ❌ **上一版写的「不产出事件节点」是错的，已撤销。** 评审指出：`flowFromActions` 里
  **唯一有 evidence 的边就是 `act → evt`**（[flow_link.ts:634-644](../../../ts/src/onto/flow_link.ts)）。
  删掉事件节点会让这张图的边 100% 无 evidence，连锁后果有两个：
  `mainPath()` 只保留 grounded 边 → 主干子图变空 → `流程图_主干.svg` 被删掉；
  `actionsWithoutEvents` 会给每个 action 各生成一条同模板问题。
  等于把「一列同前缀事件」换成「满屏同模板问题」，并且**直接违反 §12 自己的验收标准**。
  - 节点 `status` 改用 `draft_from_api` 是可以的，但注意 status 现在会往返序列化
    （`nodeToDict` 印、`flowFromDict` 读），改它属于**产物变更**，要进 golden 影响清单。

### 4.6 S7 通识参考图

不变。已有 `flow.sketch` + `draft.adopt` + `sketch.diff`，保障齐全（generic_assumption / DRAFT / 三道质量闸）。路由器可以选它，但**只在没有任何材料信号时**，且产物标注不变。

---

## 5. 路由层：`flow_strategist`

### 5.1 材料能力扫描（零模型）

新函数 `scanFlowSignals(docs, state): FlowSignals`，纯规则、零模型：

```ts
type FlowSignals = {
  bpmnFiles: number;
  pptWithConnectors: { file: string; slides: number; connectors: number }[];
  imagePagesWithRelations: { file: string; page: number; blocks: number; relations: number }[];
  numberedStepText: { file: string; chunks: number }[];   // 不再用 60 码点 + 四字段，改为「存在编号序列」这一结构特征
  orderedTables: { file: string; sheet: string; hint: string }[];
  apiEndpoints: number;
  materialCount: number;
};
```

扫描只看结构，不看业务词。

### 5.2 决策

一次 `difficulty: low` 的模型调用，**输入只有信号摘要，不含材料全文**（因此便宜）。输出：

```jsonc
{
  "chosen": [{ "strategy": "S2", "why": "3 份 PPT 共 47 条显式连接线", "expect": "实证" }],
  "skipped": [{ "strategy": "S4", "why": "没有编号步骤文本" }],
  "note": "…"
}
```

**约束：**
- 只能从固定策略集里选，schema 用闭合枚举（不合法值直接拒绝重试）。
- 信号为零的策略不许被选中（代码侧硬校验，防模型臆造）。
- 全部策略都无信号 → 回落 S7 或明确 `flow.skipped`，两者都要说明原因。

**记录：** 决策写进 `s.state["flow_provenance"].strategy = {chosen, skipped, signals, at, model}`，并发 `flow.strategy` 事件，UI 上展示「这张图是怎么来的」。

**覆盖：** `flow.preview {strategy}` 可强制指定；强制时跳过模型调用，直接跑指定策略。

### 5.3 多策略合流

多条策略都产出图时：

⚠️ **评审更正：现有 `diffFlowGraphs` 做不到这件事。** 它的 `matched`/`leftOnly`/`rightOnly` 返回的是
**标签串不是 rid**，唯一暴露的差异维度是 `kindDiff`（[flow_diff.ts:119-128](../../../ts/src/onto/flow_diff.ts)）
——没有 actor 比对、没有边条件比对、没有 evidence。所以「evidence 取并集」和「执行者/分支条件不同 → 冲突」
都无法基于现有 API 实现。
**因此把「扩展 flow_diff：返回 rid + 逐字段差异」列为 P3 的显式前置任务。**
另注意合流后节点数容易越过 `flow_sketch.ts:370` 的 `NODE_CAP = 80`，需处置。

1. 用**扩展后的** `diffFlowGraphs`（精确名 + 相近度模糊配对的配对能力可复用）两两配对。
2. **配上且一致** → 合并为一个节点，evidence 取并集（多源互证，`confidence` 提升）。
3. **只有一方有** → 保留，标注来源策略。
4. **配上但冲突**（如同一步骤的执行者不同、分支条件不同）→ **不合并**，保留双方 + 生成 question，走既有问题分诊漏斗。

优先序：实证档优先于推断档；同档内按 S1 > S2 > S3 > S4。

---

## 6. 呈现层

### 6.1 R1 修跨阶段回退弧（缺陷修复）

把「每个阶段带内独立 Kahn 分层」改为**全局分层**，阶段仍决定 y（带），x 由全局层号决定。

**⚠️ 评审推翻了原来的落地方式，改为新增模式：**

- **golden 不能重生成**：`golden/onto.diagram.json` 里那 28 张 SVG 记录的是**Python 真跑的输出**
  （`ts/test/onto.diagram.test.ts` 文件头写明「期望值一个都没有手写」），而**生成器已经不在仓库里**
  （`git ls-files tools/golden` 返回 0 条）。从 TS 侧重生成 = 把跨语言一致性测试改写成「TS 自证」，
  测试就此失效。
- **定版做法**：现有 `toSvg` **逐字节不动**，全局分层走**新函数 + 新 golden**。这与 §6.2「新增
  泳道 SVG 不替换现有」是同一条思路，两处标准统一。
- **代价要计入分期**：带宽现在按本带层数算，改成全局层号后每条带都要按全局最大层数张开
  ——32 节点跨 6 阶段会得到 32 列宽、每带 31 列空白。`rows` 的算法要一起改。
  **R1 不是一个分支修复，是一次布局重写**，工作量按此上调。

### 6.2 R2 actor 泳道（数据早就有）

新增布局模式：**阶段 = 列（x），actor = 泳道（y）**，输出 `流程图_泳道.svg`，不替换现有产物。

**评审指出的三个坑：**

- **绝不能加进 `structureDefects`**：它是**硬门禁**不是 lint —— 有缺陷就返回 `STRUCTURE_REJECTED`
  直接不出图（[tools.ts:4072](../../../ts/src/server/dialogue/tools.ts)）。而 `SKETCH_SCHEMA` 的 actor 是可选、
  event/gateway/terminal 天然没有 actor，加了这条**每一张 sketch 都会被拒**。
  泳道缺失走非门禁通道（`flow.ready` 的 issues 或产物说明）。
- **BPMN 图上 stage ≡ actor**：`flow_bpmn.ts` 把 lane 同时映射成 stage 和 actor，
  「阶段=列、actor=道」在这类图上退化成一条对角线。需写明：检测到 stage≡actor 时合并成一维。
- **数据要清洗**：实测 `fdaced8ca9df` 的 actor 带尾随换行（`"采购计划员\n"`），不 trim 会把同一角色
  劈成两条道。另外 `d53cb63f` / `fc58b72e` 的 action actor 覆盖率是 **0/32 和 0/19**——
  而这两个正是 §10.5 的验收会话，泳道在它们身上无从谈起；rule-extracted 那条路
  （`bfa65697` 14/14、`c3e56e56` 7/7）才有数据。验收会话要相应调整。

### 6.3 R3 边标签

❌ **原来写的「渲染到边上而非省略」是错的**：边标签**本来就渲染**
（[diagram.ts:515-521](../../../ts/src/onto/diagram.ts)，mermaid 侧 `:186`）。

真问题是 **`cpSlice(e.label, 8)` 的 8 码点截断**，以及标签固定放在边中点会互相压。
R3 改为：放宽/取消截断 + 标签避让。**不新增结构化 condition 字段**（YAGNI）。

### 6.4 R4 图像模型「汇报版」（展示副本）

**新增能力：**

1. `Capability.IMAGE_GEN` 加入 `kernel/catalog.ts` 的 `Capability` 与 `CAPABILITIES`（注意：`CAPABILITIES` 的声明顺序被 golden 钉住，新值追加到**末尾**）。
2. 新后端方法 `generateImage(req): Promise<ImageResult>`——images 端点与 chat completions 不同，不复用 `generate()`。
3. 模型目录支持该能力标记。

**产物：** `流程图_汇报版.png`，写入会话目录，在 `artifacts` 里**显式标注**：

```jsonc
{ "kind": "display_only", "notice": "由图像模型渲染，仅供汇报展示；不可编辑、无出处、不参与校验与交付门禁" }
```

**硬约束：**
- 不进 `ontology.package.json`，不参与 REVIEW/EXPORT 门禁，不进 `flow_diff`。
- 只在用户显式请求时生成（`flow.render {style:"presentation"}`），**不在 `开始梳理` 默认路径产出**——它要花钱且非必需。
- 输入给图像模型的是**结构化 FlowGraph 的文字描述**（节点、边、泳道），不是让它自由发挥。
- **已知局限必须在产物说明里写明**：中文标签在图像模型下可能出现错字或糊字；以 `流程图.svg` 为准。

---

## 7. `flow.preview` 的改造

现状：零参数、零模型、跑正则、`tier=flow_preview` 在 PARSE 后立即返回。

改为：

```jsonc
{ "strategy": "auto | S1 | S2 | S3 | S4 | S5 | S6 | S7", "detail": "brief|standard|detailed" }
```

- 默认 `auto` → 走 §5 路由器。
- 仍是「便宜档」，但**便宜的原因变成「只跑选中的策略」**，而不是「不调模型」。
- 若路由选中 S4（要花钱的那条），回执里明确告知预计花费档位，沿用既有低余额提醒。

顺带修：路由层丢弃 UI 传来的 `{lang}` 请求体这个死参数（要么用起来，要么两边都删）。

---

## 8. 数据契约与不变量

新代码必须满足：

1. 输出 `FlowGraph` 或其 `toDict()` 形状；`code` 字段**留空**，由 `addNode` 经 `codeFor()` 生成（编号必须稳定，否则两版图无法 diff）。
2. `NodeKind` / `EdgeKind` 是闭合枚举，`parseNodeKind` / `parseEdgeKind` 遇未知值抛错。
3. 每个 `Assertion` 的 `origin=EXTRACTED` 必须有非空 `evidence`。
4. `FlowNode.objects` 只存对象 rid——**顺带修一个既有 bug**：`flow_extract.ts` 把次要输出的原始标签串塞进了 `objects`，与契约冲突，并导致这些节点被 `autoBindObjects` 永久跳过。
5. 序列化边用 `from`/`to` 键（非 `source`/`target`），且只保留前三条 evidence。

---

## 9. 失败与降级

| 情况 | 行为 |
|---|---|
| 路由器模型调用失败 | 回落到确定性优先序（S1>S2>S3>S5>S6），发 `flow.strategy.degraded`，产物标注 |
| S4 的证据核验大面积失败 | 该策略整体作废（不采纳半张图），报 finding，让路由器换策略 |
| 视觉识别超时 | 沿用既有 `OCR_TIMEOUT_MS` 与失败记录；不静默当作「材料里没有流程图」 |
| 图像生成失败 | 只影响展示副本；核心产物不受影响；错误如实回报 |
| 所有策略无信号 | 明确 `flow.skipped` 并说明「材料里没有可识别的流程结构」+ 建议下一步（上传流程图/BPMN，或用通识参考图起草） |

沿用既有纪律：降级必须披露，不得静默。

---

## 10. 测试策略

1. **单元**：每条新策略一组。S2 用最小 PPTX fixture（显式连接 + 几何兜底 + SmartArt 各一）；S3 用固定的 vision 输出 fixture；S4 用「引文核验通过/失败」两类样本，重点钉住**编造引文必须被拒**。
2. **路由器**：给定信号组合 → 期望策略集，纯函数可测；模型调用打桩。
3. **合流**：一致/只单边/冲突三类，钉住冲突不合并且生成问题。
4. **渲染器**：golden 需重生成（R1 是有意语义变更）；新增泳道布局的 golden。
5. **真实数据冒烟**（项目纪律：新能力必须拿 workspace 真实会话跑）：
   - `d53cb63f7e18`（32 个 API 端点排成一条链）→ 期望路由不再默认 S6 出「业务流程」，或至少正确标注；
   - `bafd0dd05e69`、`fc58b72e91bd`（inferred 边占满）→ 期望实证边比例上升；
   - 找一份带 PPT 流程图的材料验证 S2。
6. **回归**：既有 `flow.walk` / `sketch.diff` / `flow.edit` / canonical 编译全部仍须通过——这是「不破坏下游」的验收。

---

## 11. 分期

| 期 | 内容 | 理由 / 评审修正 |
|---|---|---|
| **P0** | ①§2 原则 2 的**证据硬校验**（当前无门禁）②`COND_RE` 预筛 bug | 都是小改动且解锁后续。②：外层 `text.includes("如")` 预筛把「若…则」「当…就」整段挡在门外，而 `COND_RE` 本身支持这些词——**一行 bug，不需要模型** |
| **P1** | S2（PPT 连线）+ S3（视觉连线，保守档）+ §8.4 objects 契约修复 | ⚠️ **不是「白捡」**：S2 要自写整套 `cxnSp` 遍历（`shapeBbox` 只在有文字的 `sp` 上调用，`cxnSp` 从未被访问）；S3 受限于 ER 口径的 OCR schema 只能出 action。objects 修复还要一次**历史数据迁移**（脏串已落进老会话的 flow.json） |
| **P2** | S4（`flow_modeler` + 三层引文闸门）+ S6 根因修复（`appliesTo` 解析） | agent 的 golden 有生成器 `npm run update:catalog-golden`，与 P4 处境相反；注意 `golden/agents.json` 的 `names` 是字母序，`flow_modeler` 插在中间不是追加 |
| **P3** | **前置：扩展 flow_diff（rid + 字段级差异）、`{strategy}` 参数管道** → 路由器 + 合流 + `flow.preview` 参数化 | 参数管道要同时改 tools.ts / dialogue.ts / serve.ts 两处 / routes.ts / run.ts，现在全链只认 `tier` 一个字段；另需解决 `flow_preview` 早退导致 `_flow_gaps` 无人收 |
| **P4** | R1 全局分层（**新函数+新 golden**）+ R2 泳道 + R3 标签截断与避让 | 现有 `toSvg` 逐字节不动；golden 记录的是 Python 输出且生成器已不在仓库 |
| **P5** | R4 图像生成 | 未评估依赖：`LLMBackend` 接口扩展（两个实现）、Recorder 二进制重放（`INLINE_LIMIT=2048`，PNG 塞不进内联）、`Usage` 计量、`CAPABILITY_DENIALS` 缺 image_gen 的降级识别、`cardToDict` 的 capabilities 是排序后插入不是追加 |

### 11.1 尚未解决的遗留问题

- **`codeFor` 的三张中文业务词表**（`DOMAIN_CODES` 14 词 / `VERB_CODES` 28 词 / `EVENT_CODES` 30 词，
  [flow.ts:315-417](../../../ts/src/onto/flow.ts)）：§8.1 要求所有新策略的 code 都走 `codeFor`，
  于是**新策略把节点抽得再准，换个行业编号照样退化成 `*-GEN-<hash>`**（实测 31/40、61/64）——
  而编号正是本设计自己说的「下游锚点、diff 的地基」。§2 原则 3 只说了「不得引入第二张」，
  第一张怎么办**本设计未解决**，需单独立项。
- **`workflows` 容器**：`canonical.ts:1425-1443` **确实读它**并用来命名交付包里的流程。
  任何策略一旦开始填 workflows，交付包的流程名会静默改变。**本轮明确不填。**
- **S5 顺序表的判据未定**：必须钉成结构性判据（某列取值为单调递增整数且覆盖率≥阈值，**不看列名**），
  否则极易被写成「有一列叫『序号』」——那正是本项目禁止的硬编码。

---

## 12. 验收

- 拿真实会话测：实证边（`grounded=true`）占比显著上升，`inferred_edges == 全部边` 的会话消失；
- 不再出现「一屏同名事件」（罐头事件命名被移除）；
- 产物能回答「这张图是怎么来的」（策略决策可见）；
- 多策略冲突进入问题清单而不是被静默合并；
- 全部既有下游（走查/diff/编辑/编译/交付门禁）零回归。
