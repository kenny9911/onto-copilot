# 「梳理」能不能用固定工作流 —— 对抗式论证与裁决

> 2026-08-17 · 10 个 agent：3 份勘察 → **3 个攻击者专打主 agent 的立场** → 3 个另案 → 1 份裁决
> 方法说明：这一轮不是征求意见，是让 agent **尽力打倒**一个已经成型的立场。
> 「攻击失败」那一节里每条都要求攻击者自陈"我试了这几条路都没走通"。

## 人工复核（先读这一节）

上一轮有两条 agent 判断被我核出是错的，所以这一轮**逐条回代码验**。
以下四条最重的指控，**全部成立**，其中一条比 agent 说的更严重。

### ✅ A1 成立：冻结机制的自陈前提被自家调用点违反

`ts/src/kernel/dag.ts:325-327` 的注释原文：「后缀来自**用户输入**（上传的文件清单、
声明的模态列表），**不能来自材料内容** —— 这条是冻结机制成立的前提」。

实际调用是 `d.expand({ EXTRACT: segments.map((s) => s.key) })`（`pipeline.ts:1441`），
而 `segmentCorpus`（`pipeline.ts:370-379`）的 key 回退链是
`sheet → locator.object → section → page → tags[0]`。对 SQL DDL，
`locator.object` 就是解析器从**正文**里抽出的表名（`parse/sql.ts:267` 的
`locator: { kind: "ddl", object: tname }`）。

**核实结论**：EXTRACT 实例的节点 id 是客户 DDL 正文里的表名字符串，段数无上限
（`run.ts:433` 只判 `=== 0`）。`run.ts:426` 那句「段数来自材料结构，不来自内容 ——
计划冻结成立」是**不准确的**，而且是一句会被后人引用来做安全论证的不准确表述。

**但要按攻击者自己的 F3 打折**：`fanout_key` 只做 Map 键与路由分派，没有任何路径
让它变成工具名或 scope。**后果是成本失控 + 安全叙事失效，不是 RCE。**

### ✅ A2 成立，且比 agent 说的更严重

`budget.ts:299` `criticRounds()` 在 `RULES_ONLY` 档 `return 0`，配 `loop.ts:641`
的 `rounds !== 0` 守卫 → 整个 critic 环连同 refine 一起不执行。`currentLevel()`
是 latch（`budget.ts:283` `this._floor = lvl`），单调不回退。

**我额外核出来的**：`budget.ts:263` 的注释写着「产物上的**「未经语义审核」标记**
也不该悄悄消失」——
```
grep -rn "DegradeLevel|degrade|降级" canonical.ts engagement_runtime.ts run.ts
→ 零命中
```
**这个标记根本不存在。注释在描述一个没有实现的功能**，而 latch 的存在会让读代码
的人以为它实现了。

### ✅ A3 成立：唯一的人类环节是唯一没有门的节点

`engagement.ts:111-124` 的 INTERVIEW `makeNodeSpec` 字段是
id / mode / handler / deps / scope / budget / difficulty / params / retries ——
**没有 `gate`**。而 `InterviewHandler.skipModel`（`engagement_runtime.ts:568-577`）
在 `blockers().length === 0` 时返回一个非 null 的 Dict，于是 `AgentLoop.produce()`
里的 `askHuman` 不可达；返回值里 `resolved: true`，
`releaseState: pending().length > 0 ? "DRAFT" : "RELEASED"`。

**核实结论**：材料写得越干净（内部自洽、无冲突），越可能零个人类看过这次交付，
而 DAG 上显示 INTERVIEW 已完成。

### ✅ A6 成立 —— 这是整轮里最重要的发现

`CanonicalizeHandler.execute(_inputs, ctx)`（`engagement_runtime.ts:603`）——
参数名带下划线前缀，**未使用**。它直接 `buildPackage(this.runtime.oir,
this.runtime.flow, …)`，完全绕开 INTAKE/PROCESS/ERP_MAP/RULES/DATA_OBJECTS/GAP
产出的一切。

`StaticProjection.skipModel(inputs)`（`:294-296`）无条件 `return this.project(inputs)`，
永不返回 null → 五个 agentNode 的 `AgentLoop.produce()`（模型调用与 HITL 所在处）
**结构性不可达**。

全文件 `_inputs: Dict`（下划线 = 未使用）出现 **12 次**，真正读 inputs 的只有 4 处，
而**造交付物的那一个不在其中**。

**核实结论：删掉这 6 个节点，最终交付物一个字节不变。** 与 OTel 真跑数据吻合 ——
8 个 engagement 节点各 1–2ms、0 次 LLM 调用。

---

## 直接回答

**能，而且必须固定。但今天这套东西不是"固定工作流"，是"固定的空转"——所以你问的这个问题今天还没有真正被回答过。**

三条判断，按重要性排序：

**第一，"固定工作流"不是一个问题，是七个。** 用户问的"固定"，在代码里对应七个互相独立的轴（能力闭集 / 治理面 / 治理不变量 / 元模型 / 拓扑 / 顺序 / 产物形状）。这七个轴的正确答案**方向相反**：四个必须固定得比今天更硬，两个必须放开，一个今天固定错了对象。把它们打包成一个"是/否"问题，是这次讨论里最大的认知错误——而这个错误正是主 agent 五根支柱互相矛盾的根源（支柱二说"域假设焊进控制面是病"，支柱三却给同一种病在数据面上的发作开了免罪符）。

**第二，今天固定的成本还没被支付，所以"它一直没出问题"不能作为保留它的证据。** 实测：8 个 engagement 节点跑完 10.9ms、`llm_calls: 0`；`StaticProjection.skipModel()`（`ts/src/onto/engagement_runtime.ts:294-296`）无条件返回 Dict，`AgentLoop.produce()`（`ts/src/kernel/loop.ts:634`）结构性不可达；13 条声明的依赖边只有 4 条真的传数据；`CanonicalizeHandler.execute`（`engagement_runtime.ts:603-616`）完全绕开上游直接 `buildPackage(runtime.oir, runtime.flow, …)`。**删掉 INTAKE→PROCESS→{ERP_MAP,RULES,DATA_OBJECTS}→GAP→INTERVIEW 六个节点，最终交付物一个字节不变。** 拿一个可以整段删除而产物不变的结构来论证"固定工作流是对的"，是拿空转当证据。

**第三，冻结机制今天守着的那四样东西（critics / criticRounds / gate / budget），其中两样已经能被材料内容取消。** `Budget.criticRounds()`（`ts/src/kernel/budget.ts:297-302`）在 `RULES_ONLY` 返回 0，配合 `loop.ts:641` 的 `rounds !== 0` 守卫，让材料体量静默关掉全部 critic 且 latch 永不恢复，产物上零标记；`InterviewHandler.skipModel()`（`engagement_runtime.ts:568-577`）让"材料里没有冲突"静默取消唯一的人类环节，而 INTERVIEW 是**唯一一个没有 gate 的节点**（`ts/src/onto/engagement.ts:111-125` 的 `makeNodeSpec` 里没有 `gate` 字段）。两条的失败方向都是**没人审、照常发布**。

所以正确的表述是：**固定治理，参数化拓扑，从证据推产物形状。** 而"我们有一个固定的 8 步 FDE 方法论"这个说法必须停止使用——它描述的东西在代码里不存在。

---

## "固定"这个词被混用了几种意思 —— 先拆开

这一节是整份裁决的核心。七个轴，每个轴的可变性来源、今天的状态、正确答案各不相同。

| # | 轴 | 具体是什么 | 今天由谁决定 | 正确答案 |
|---|---|---|---|---|
| 1 | **能力闭集** | 模型能调哪些工具、能不能出网、能不能执行代码 | 编译期常量：`builtinRegistry`（`ts/src/server/glue/tools.ts:518-520`，不传 sandbox 则 `code.exec` 根本不注册）+ `ToolRegistry.forScope`（`ts/src/kernel/tools.ts:650-676`，不在白名单抛 `ToolDenied`）+ `AgentSpec.toolScope`（`ts/src/kernel/agents.ts:81`） | **必须固定。今天做对了，一行不改。** 这是唯一真正在防注入的墙 |
| 2 | **治理面** | critic 轮数下限、gate、HITL、审查预算 | 名义上是 `NodeSpec` 常量；**实际可被材料体量（`budget.ts:297`）和材料洁净度（`engagement_runtime.ts:569`）取消** | **必须固定，且今天固定得远远不够硬**。要做到类型上不可表达 |
| 3 | **治理不变量** | Assertion/Provenance（`ts/src/onto/oir.ts:290-345`）、canonicalId + legacyId（`ts/src/onto/canonical.ts:948,993`）、revision 单调 + 悬空引用零容忍（`canonical.ts:1528-1690`） | 编译期常量 | **必须固定。今天做对了。** 这才是真正域无关的那一层 |
| 4 | **元模型闭包** | `COLLECTIONS` 十项（`canonical.ts:73-84`）、`Yield` 六项（`ts/src/onto/shape.ts:561-568`）、`classification` 值域 | 编译期常量，且**自称域无关** | **可变（profile）。必须停止称它域无关。** 选择在冻结点之前由用户/项目配置定 |
| 5 | **拓扑（节点集）** | `buildFdeEngagementDag()`（`engagement.ts:85`）**不接受任何拓扑参数** | 编译期常量 | **可变，但值域是编译期闭集，选择必须在冻结点之前由人签字并进 DecisionLedger** |
| 6 | **顺序（依赖边）** | PROCESS 是 ERP_MAP/RULES/DATA_OBJECTS 的唯一前驱（`engagement.ts:94-96`） | 编译期常量 | **今天固定错了。** `PROCESS→RULES` 和 `PROCESS→DATA_OBJECTS` 是零数据流的纯调度边——今天删掉，产物一个字节不变 |
| 7 | **产物形状** | 问题清单文案（`ts/src/onto/ontology_package.ts` 30 处 `collector.add`）、`EXPECTED_ARTIFACTS` 九个写死文件名（`engagement_runtime.ts:46-56`，含 `模板_v1.xlsx`）、四张中文采购词表（`canonical.ts:769-772`、`engagement_runtime.ts:851-872`、`ts/src/onto/flow.ts:315-330`） | 硬编码 | **必须可变且必须从证据推。这是契约 A 今天最严重的违反** |

附带两个次级轴，它们不在原问题里，但决定前七个能不能成立：

| # | 轴 | 今天 | 正确答案 |
|---|---|---|---|
| 8 | **fan-out 基数与执行顺序** | `segmentCorpus`（`ts/src/onto/pipeline.ts:345-425`）的段键来自 `sheet → locator.object → section`，其中 `locator.object` 对 SQL DDL 就是**正文里 `CREATE TABLE` 后面那个词**（`ts/src/onto/parse/sql.ts:267`）。段数无上限（`ts/src/server/pipeline/run.ts:433` 只判 `=== 0`），排序键 `cmpStrCp(a.fname, b.fname) \|\| cmpStrCp(a.key, b.key)`（`pipeline.ts:406-407`）**由攻击者完全控制** | **上限必须固定且来自用户输入；排序不能由材料内容决定** |
| 9 | **节点内的工作量** | 恒定为零（五个 `StaticProjection` 一次模型都不调） | **可变，但"少做了什么"必须是产物里的一等公民** |

**这张表就是对用户问题的完整回答。** 支柱一到支柱五之所以互相打架，是因为它们每一根都同时横跨了这九个轴中的三到四个，然后用同一个词"工作流"指代。

---

## 攻击成功的地方（诚实列出）

以下八条，我自己复核过代码，全部成立。

### A1. 冻结机制的自陈前提已被自家调用点违反（反驳一 A + 反驳二 A，两份独立命中）

`ts/src/kernel/dag.ts:325-327` 原文：

> `cardinalities` 是 `{节点 id: [实例后缀, …]}`。后缀来自**用户输入**（上传的文件清单、声明的模态列表），**不能来自材料内容** —— 这条是冻结机制成立的前提。

而 `buildDag`（`ts/src/onto/pipeline.ts:1441`）的实际调用是 `d.expand({ EXTRACT: segments.map((s) => s.key) })`，`s.key` 来自 `segmentCorpus`（`pipeline.ts:372-382`）的 `sheet → pyStr(loc["object"]).split(".")[0] → section → page → tags[0]` 链。对 SQL DDL，`locator.object` 是解析器从正文抽出的表名（`parse/sql.ts:267`）；对 PDF，`section` 来自视觉模型读图的输出（`ts/src/onto/parse/vision.ts:313`）。

**实测：同一个文件、同一次上传，只改内容里的表数量 → 1/3/40/200 张表分别产生 1/3/40/200 个 EXTRACT 实例，节点 id 就是客户 DDL 里写的表名字符串。**

`run.ts:426` 的 `plan.frozen` 事件自陈"段数来自材料结构（有几个 sheet/章节），不来自内容 —— 计划冻结成立"是**假话**，而且是一句会被后来人引用来做安全论证的假话。`pipeline.ts:414` 的"形状只看列的取值分布，不看内容语义 —— 冻结计划的边界没有被破坏"是文字游戏：列的取值分布就是内容，而且它决定的东西是硬的（`inferShape` 数 IDENTIFIER 列 → 加 `Yield.LINKS` → `CoverageCritic` 在 DDL 形状上必抛 `KeyError: 'links'`）。

**裁决：支柱一的第一句话被推翻。冻结墙不是建在"用户输入"上的，是建在解析器对材料正文跑的正则上的。**

### A2. 材料体量能静默关掉全部 critic，且永不恢复，产物上零标记（反驳一 C-1）

`ts/src/kernel/budget.ts:296-301`：

```
criticRounds(requested: number): number {
  const lvl = this.currentLevel(); // 注意：latch
  if (lvl >= DegradeLevel.RULES_ONLY) return 0;
```

配 `loop.ts:641` 的 `if (node.critics.length > 0 && rounds !== 0)`——rounds 为 0 时整个 critic 环连同 refine 一起不执行。预算是整个 run 一个对象（`ts/src/server/usage.ts:370` `new Budget({ tokens: 4_000_000, usd: usdCap() })`），`currentLevel()` 单调 latch（`budget.ts:283`）。

结合 A1（段数无上限）：一份 300 张表的 Oracle EBS schema 导出，跑到大约第 220 个 EXTRACT 时预算剩余比例跌破 0.15，`RULES_ONLY` latch，**此后所有节点的 CoverageCritic 和 provenanceCritic 一次都不跑**。而排在后面的表（按码点排序，`zz_*` / 拼音靠后的中文表名）里的断言直接进 OIR、进包、进 EXPORT。

三重加剧：
- 降级从不进产物。`grep -n "degrade\|DegradeLevel\|降级"` 在 `engagement_runtime.ts` / `canonical.ts` / `run.ts` **零命中**。
- `budget.ts:263-265` 的注释写着"少跑的 critic 不会因为后来钱变多了就补跑，产物上的「未经语义审核」标记也不该悄悄消失"——**全仓没有这个标记**。注释在描述一个不存在的功能，而 latch 的存在让人以为它存在。
- **同一个降级级别上的两个方法互相矛盾**：`allowLlmCritic()`（`budget.ts:308-310`）在 `RULES_ONLY` 返回 false，说明这一档的设计意图是"只跑规则档 critic"；而 `criticRounds()` 返回 0 让规则档也不跑了，于是 `allowLlmCritic` 在这一档的分支**永远不可达**。这是一个可以今天就修的 bug。

**裁决：支柱四"内容只能让工作变少，失败方向是安全的"在这个代码库里是已经被证伪的命题，不是待引入的性质。它带来的正是安全属性的丢失。**

### A3. 材料越干净，越没有人看过这次梳理（反驳一 C-2）

`NodeMode.HITL` 只在 `loop.ts:693` 被读，而那是 `produce()` 内部；`produce()` 只在 `skipModel()` 返回 null/undefined 时可达（`loop.ts:627-635`）。`InterviewHandler.skipModel`（`engagement_runtime.ts:568-577`）在 `blockers().length === 0` 时返回一个 Dict → `askHuman` 从不被调用。

而 BLOCKING 的唯一来源是"材料里检出了冲突"（`ts/src/onto/questions.ts:1155` 的 `clarificationQuestions` 和 `:1186` 的 `ask_user` 类 conflicts）。**一份内部自洽、写得干净的制度文档——这比写出互相矛盾的文档容易得多——就能让零个人类看过这次交付**，而 DAG 显示 INTERVIEW `status: completed, resolved: true`。

更狠的是：`engagement.ts:111-125` 的 INTERVIEW `makeNodeSpec` **没有 `gate` 字段**。唯一的人类环节是唯一没有门的节点。

**裁决：HITL 今天不是节点的模式，是 handler 可以一票否决的兜底。支柱三"HITL/Review/Export 门是正当的固定"这句话里，HITL 那一项是空的。**

### A4. 门是节点的属性，跳过节点就是跳过门（反驳一 D）

`ts/src/kernel/scheduler.ts:768`：`const gate: unknown = this.dag.get(nid).gate;`——`applyGate` 在节点完成后按节点 id 取门。REVIEW 带 4 条 require（`engagement.ts:139-146`），EXPORT 带 3 条（`engagement.ts:158-161`）。

支柱四说"所有节点始终在冻结的拓扑里"——这句话在拓扑图上是真的，在执行语义上是假的：拓扑里那个节点变成空壳，而门挂在壳上。

而且"单调"论证做了一次偷换：它在**工作量**上论证单调递减（对的），把结论搬到**安全属性**上（错的）。安全属性（有人审过、critic 判过、缺口被追问过）是随工作量**单调递增**的。把两个方向相反的偏序当成一个。

**裁决：支柱四整条推翻，不是修补。**

### A5. 能力墙与拓扑正交，对话通路就是活的反例（反驳二 C）

`chatRoute`（`ts/src/server/dialogue.ts:995`）读的是**同一批不可信材料**（`dialogue.ts:332-334` 把材料摘录拼进 prompt），动作序列 100% 由模型按内容决定，零计划冻结，没被打穿。挡住它的四样东西与拓扑完全正交：

1. `serve.ts:373-374` 的注释自陈不传 sandbox → `code.exec` 在这条路的注册表里**根本不存在**（`glue/tools.ts:518-520`）；
2. `ToolRegistry.forScope` / `get` 白名单，不在名单抛 `ToolDenied`（`tools.ts:650-676`）；
3. `danger >= EXTERNAL → requiresApproval` 的阻断门，被拒的调用还记 `tool.denied` 账（`tools.ts:692-726`）；
4. 全库无出网工具（`glue/tools.ts:202-204`）。

而 `NodeSpec`（`dag.ts:203-219`）里根本没有 tools 字段，`handler` 必须命中硬编码注册表（`loop.ts:592-597`），`sandbox` 字段全仓零读取。

**裁决：支柱一把能力边界的功劳记在了拓扑边界头上。冻结真正守住的只有 critics / criticRounds / gate / budget 四样，正确表述是"材料不能删掉审查和门禁"——而 A2/A3 证明这四样今天已经守不住了两样。**

### A6. 固定拓扑的成本尚未被支付（反驳二 E）

实测数据流：`PROCESS ignores INTAKE = true`、`RULES ignores PROCESS = true`、`DATA_OBJECTS ignores PROCESS = true`、`GAP ignores branch data = true`、`CANONICALIZE ignores INTERVIEW = true`。唯一真边是 `PROCESS→ERP_MAP`。`GapHandler.execute`（`engagement_runtime.ts:542-553`）自称"合并专业节点发现的缺口"，实际只用 `Object.keys(inputs)` 取节点名。

两个 critic 也是空的：`ContractCritic` 只检查顶层 `required` 键**是否存在**（`engagement_runtime.ts:766-772`），而每个 `project()` 都是照着 required 列表逐字硬写的，结构上不可能失败；`EngagementProvenanceCritic` **恒 `passed: true`**（`engagement_runtime.ts:819`）。

**裁决：这条改变了问题的性质。"要不要保留固定拓扑"对当前系统是伪问题，因为固定的东西还没开始工作。同时它也是最要命的警告：一旦让这些节点真的调模型、真的读上游，那 9 条假边立刻从"无害装饰"变成"每个非流程客户的强制错误开局"。**

### A7. 元模型不是不变量——它上周刚变过一次，没换域（反驳三 A/C/D）

未提交工作树里的 `ts/src/onto/ontology_package.ts` 是一个**新的、不兼容的元模型**，与 `canonical.ts` 的那个并存：顶层集合从 10 涨到 15，`links` 从"塞进 `dataObjects[].relations`"提升为顶层集合，`processes` 拆成 `processNodes`/`processEdges`/`workflows`，新增 `integrations`/`gaps`，删掉 `lifecycleStates`/`sensitivity`。两份都是 `additionalProperties: false`。

同时，支柱三连自己要固定的对象都说错了：它说"任何本体都需要 objects/links/actions/rules"，而 `COLLECTIONS`（`canonical.ts:73-84`）里**没有 links**，反而多出 `roles` 和 `systems`——那是企业信息化世界观，不是元模型；`Yield`（`shape.ts:561-568`）里**没有 EVENT**，也就是说 Event 结构上不可能从材料抽出，只能由中文编号正则产生。

`classification`（`engagement_runtime.ts:863-872`）我逐字读过：`主数据/供应商/物料/master → MASTER_DATA`、`文档/附件/document → DOCUMENT`、`交易/订单/申请/transaction/order → TRANSACTION`，其余兜底。跨域实测 23 个实体名，20 个落兜底，2 个高置信度错分——**「合同」→ document 0.65，「合约」→ transaction 0.25**，一字之差，而"合约"正是金融客户唯一重要的那个词。

`ontology_package.ts` 里 30 处 `collector.add` 把元模型空槽直接变成客户看到的问题：「Link ${id} 是一对一、一对多还是多对多？」是 Foundry 的 cardinality 枚举问题，不是业务问题。纯参考数据本体（3 张互不关联的国标码表）实测产出 7 条问题，**零条来自材料证据**。

**裁决：支柱三的"元模型是域无关的"必须撤回。它是 `foundry-osdk profile v1`，不是普适真理。契约 A 在元模型层完整复发。**

### A8. 0 processes / 0 events 的空包三门全绿，且被测试钉成期望行为

`buildPackage`（`canonical.ts:1377-1400`）无流程 → `pkg.processes = []`、`pkg.events = []`；`validatePackage`（`canonical.ts:1500+`）全文件**没有任何"集合不能为空"的判据**；`ReviewHandler`（`engagement_runtime.ts:636-690`）的 blockers 只有三种来源（包校验 error / 未决阻塞问题 / 目录不可写），没有一条与内容量有关；EXPORT 的 `downloadable` 检的是 `await writable(s.dir)`，实现是 `access(dir, FS.W_OK)`（`run.ts:866-874`）——**这道门量的是磁盘权限，不是交付质量**。

而 `ts/test/onto.converse.test.ts:984` 的 `liveRuntime()` 里写着 `flow: null`，`:1000-1014` 断言"冻结 DAG 的每个节点都跑完"且 EXPORT 三门全为 true。**"零流程仍然全程放行并发布"不是隐患，是当前被 golden 钉住的正确行为。**

同类问题：`tier === "flow_preview"` 时（`run.ts:396-410`）直接 `s.status = "done"`、`const flow = s.state["flow"] ?? {}`、发 `run.completed`——对 DDL-only 语料，这是产物为零而报"成功完成"。

---

## 攻击失败的地方，及其真正的理由

以下四条攻击**没有成功**，但每一条的失败理由都很窄，不能被当成对现状的背书。

### F1. "取消冻结不会失去重放、审计、确定性"（反驳二 D）—— 表面成立，实质不成立

反驳二列了四条（Recorder 按 effect 指纹重放、每次工具调用过 `rec.effect`、DecisionLedger 挂在决策上、成本由段数决定），说这些都是**内核机制**而非**拓扑机制**，所以取消冻结不损失它们。逐条属实。

**但对照组选错了。** 对话通路确实有 journal + 指纹，但它**没有 critic、没有 gate、没有 HITL、没有 DecisionLedger v1 的 claim→副作用→finalize 三段式**。用一条不承担质量义务的路径去证明"质量门不需要拓扑"，是拿一个不做同样工作的对照组做实验。

而且反驳二漏了一个自己方案里的代价：`ts/src/kernel/recorder.ts:363-372` 的 effect 键是 `${nodeId}#${idx}`——**位置寻址**。取消节点就必须改成因果寻址，而另案甲自己承认（F6）这会让"改一个决策后重跑"的 journal 命中率显著下降，全额重付。**"不失去重放"这句话在动态方案里不是免费的，是有账要付的。**

### F2. "跳过 REVIEW 让 EXPORT 静默放行"（反驳一自认失败）

`ExportHandler.execute`（`engagement_runtime.ts:705-710`）对缺失的 `inputs["REVIEW"]` 落 `{}`，`review["verdict"] === "PASS"` 为 false，门判 fail；`requirementPasses` 遇到未知 metric 路径 `throw NodeFailure`（`scheduler.ts:1052`）。

**门的判定逻辑确实是 fail-closed 的，这是这个代码库里少数几个真正做对的地方。** 但反驳一自己给出了正确的注脚：**门是 fail-closed 的，门量的东西不是**。`verdict` / `blocker_count` / `downloadable` 没有一个与"审查是否真的发生过"相关。所以这条攻击的失败不构成对现状的辩护，它只是把攻击面从"门本身"推到了"门之前"——而 A2/A3/A8 全部发生在门之前。

### F3. "节点 id 来自不可信内容 ⇒ 可被注入执行"（反驳二自认失败）

追过 `fanout_key` 的去处：它只做 Map 键和 `SegmentRouter` 的分派参数，没有任何路径把它变成工具名、scope 或文件路径。能力仍由 `forScope` + 注册表闭集兜住。

**这个区分决定了 A1 的修复优先级：A1 的后果是成本失控 + 安全叙事失效，不是 RCE。** 所以它是 P1 不是 hotfix。但它同时**加强**了 A5：兜住的是能力墙，不是拓扑墙。

### F4. "梳理根本不需要任何固定结构"（反驳二自认部分失败）

治理不变量确实必须固定，而且反驳三 §G 给出了比反驳二自己更精确的划界：真正换域一个字不用改的是 **Assertion/Provenance**（`oir.ts:290-345`）、**id 稳定性与迁移**（`canonical.ts:948,993` 的 canonicalId + legacyId + 碰撞补 hash 后缀）、**版本单调 + 悬空引用零容忍**（`canonical.ts:1528-1690`），加上三道治理门。

而 `dataObjects / actions / events / processNodes / roles / systems` 是**一个具体建模学派的分类学**（Palantir Foundry 的），跟它同级的还有 ER、RDF/OWL、事件溯源、DDD 聚合。支柱三把"治理不变量"和"实体分类学"打包成一个词叫"元模型闭包"，用前者的正当性给后者背书——这是偷换，反驳三赢了这一场。

---

## 裁决：哪些必须固定、哪些必须可变、哪些今天固定错了

### 必须固定，且今天做对了（不动）

**1. 能力闭集。** `builtinRegistry` 不传 sandbox（`serve.ts:373-374`）、`forScope` 白名单（`tools.ts:650-676`）、`danger >= EXTERNAL` 阻断门与 `tool.denied` 记账（`tools.ts:692-726`）、全库无出网工具。这是唯一真正在防注入的墙，任何方案都不许动它。**并且必须停止把它的功劳记在拓扑头上。**

**2. 治理不变量。** Assertion/Provenance、canonicalId + legacyId、revision 单调、悬空引用零容忍。这四样加上三道治理门是"元模型必须固定"这个主张里唯一站得住的部分。

**3. 门的 fail-closed 判定。** `requirementPasses` 未知路径抛 `NodeFailure`（`scheduler.ts:1052`）、`ExportHandler` 对缺失输入落 `{}` 后判 false。保留。

### 必须固定，但今天固定得远远不够硬（要加硬到类型层面）

**4. critic 轮数下限。** `budget.criticRounds()` 的 `return 0` 必须改成 `return 1`（`RULES_ONLY` 的语义本来就是"只跑规则档"，`allowLlmCritic()` 已经在同一档返回 false）。`loop.ts:641` 的 `rounds !== 0` 条件必须从代码里消失。**"0 轮 critic" 必须在类型上不可表达。**

**5. HITL。** `loop.ts:627` 改成 `const skipped = node.mode === NodeMode.HITL ? null : handler.skipModel(inputs);`——HITL 是节点的模式，不是 handler 可以一票否决的兜底。INTERVIEW 必须加 gate。人有没有看过这次交付，不能由材料里有没有冲突决定。

**6. 审查预算。** critic 走独立分账（`CRITIC_RESERVE`），生产预算耗尽 → 明确 FAILED，而不是静默不审。失败方向从"静默发布未经审核的产物"改成"明确报失败"。

**7. fan-out 基数上限与执行顺序。** `MAX_SEGMENTS` 硬上限，值写进 `plan.frozen` 事件；排序键从 `(fname, key)` 改成 `(fname, 段内首个 chunk 的原始序号)`——内容仍然决定段的划分，但不再决定执行顺序。

**8. 步数与成本的上界。** 点估计放弃，上界必须是编译期常量并公开在 `run.started` 里。

### 必须可变（今天错在固定）

**9. 拓扑与顺序。** `buildFdeEngagementDag()`（`engagement.ts:85`）必须接受参数，选择必须在 `freezeBefore` 之前由人签字并进 DecisionLedger，换选择 = fork。今天 `PROCESS→RULES` / `PROCESS→DATA_OBJECTS` 这两条零数据流的调度边必须删——**删掉它们今天就能做，产物一个字节不变，风险为零**，而收益是把"必须先有流程"这个域假设从控制面移除。

**10. 元模型闭包。** 降级为 `foundry-osdk profile v1`，在冻结点之前由用户/项目配置选定（与 `dag.ts:325-327` 的"后缀只能来自用户输入"同构，冻结机制原封不动）。**停止称它域无关。**

**11. 角色。** `ERP_MAP` → `SYSTEM_BINDING`，`erp_mapper` → `system_binder`。今天 `ERPMapHandler`（`engagement_runtime.ts:407-451`）的实际算法是"把字符串按 `//` 和 `/` 切出主机名"——golden 里的产物是 `{"product": "erp.example.com"}`，**把一个域名叫做 ERP 产品**。这是域无关的算法穿了一身域相关的外衣。词表（`ts/src/kernel/skills.ts:601,614` 写死的 "SAP、Oracle、用友、金蝶"）下沉 profile。

**12. 产物形状。** 四张中文词表（`canonical.ts:769-772`、`engagement_runtime.ts:851-860`、`:863-872`、`flow.ts:315-330`）搬进 profile 数据文件，**并且加一条比搬家更重要的规则**：

> **词表只能产生先验，不能产生结论。** 任何来自词表的取值必须落成 `Assertion{ origin: INFERRED, evidence: [], confidence <= 0.5 }`，并在问题清单里生成一条可推翻的确认问题。证据支持的取值 confidence 可以高，词表命中的不行。

这一条直接杀掉「保证金通知」→ message 0.8 这种"靠两个汉字拿到高置信度"的情况。`EXPECTED_ARTIFACTS`（`engagement_runtime.ts:46-56`）改成从实际产出推。

### 必须新增（三个另案独立收敛到的同一个东西）

**13. 覆盖账本进交付包，作为第 11 个顶层集合。** 甲叫"义务台账"、乙叫"覆盖账本"、丙叫 `coverage_ledger`——三个独立设计的方案收敛到同一个机制，这本身就是最强的信号。

它必须记录：每段材料被 account 了没有、每个角色跑了没有、每个 critic 降级了没有、有没有人看过。判据是**"这段材料被交代了吗"**，不是"这个节点跑了吗"——按节点组织的账本会自证清白（丙自己的 F2）。

配套：`validatePackage` 加一条判据——**允许交付一个空的东西，不允许交付一个来历不明的空**。零 processes / 零 events 不是 error，但必须在覆盖账本里有对应的"材料中不存在"记录，否则是 `MISSING_COVERAGE_RECORD` error。

---

## 选定方案与实施要点

### 选定：以丙为主干，吸收乙的拓扑参数化，吸收甲的账本组织方式

**三个另案不是三种架构，是同一根轴上的三个位置**（多少计划由内容决定、什么时候决定），外加一个共同发现（覆盖账本）。共同发现才是真正的答案，轴上的位置是次要的。

**主干选丙（固定骨架 + 节点内自适应），三条理由：**

1. **只有丙把可变性降到了"门"这个约束之下。** 门挂在节点上（`scheduler.ts:768`），所以任何动节点集的方案都要正面处理"跳节点=跳门"；丙把变化降到节点内的 lens 子集，节点永不消失、critic 永不为零轮、gate 永不缺席——它绕过了这个约束而不是对抗它。
2. **丙的承重机制是类型层面的不可表达**（`onFail: "degrade"` 单成员字面量类型、`CriticRounds` branded type），比乙的 `assertGovernanceSpine`（乙自认 F2："靠的是纪律而不是结构"）和甲的"planner 工具集里没有 discharge"（靠注册表纪律）都硬一档。
3. **只有丙在付 A6 那笔账。** 甲和乙都是在一个空转的结构上做手术；丙的 P0 删假边、P5 让 lens 真的跑，是先让这些节点开始工作，再谈冻结值不值。

**不选甲（模型自主规划）的三条理由：**

- **甲的全部收益依赖"模型在这个域上的规划能力"，而我们对此零数据。** 8 个 engagement 节点从来没让模型跑过一次（`StaticProjection.skipModel` 无条件返回 Dict）。用零数据去换掉一个已知的、可测的结构，是拿不确定性换确定性，方向错了。
- **甲要改 `recorder.ts:363-372` 的 effect 键从位置寻址到因果寻址。** 那是重放、会话分叉、`resumeEngagementRelease` 的内容寻址 runId、`DeterminismViolation` 的共同地基。为一个没有数据支持的收益去动它，不值。甲自认 F6（恢复命中率真实下降）、F5（没有 GC 策略）。
- **甲自认 F4 解决不了**（注入制造假证据 discharge 闭包义务），并且诚实地说"我守住的是放行，不是内容"。
- **但甲赢了一个论点必须吸收**：A6"删掉 DAG 产物不变"成立，所以"这是伪问题"的诊断是对的。只是正确结论不是"所以删掉它"，而是"所以先让它开始工作，再谈要不要删"。以及甲的账本组织方式（按段/按实体，不按节点）优于丙。

**不选乙（剧本库）为主干的三条理由：**

- **乙的可变性粒度今天收益接近零。** 乙让"跑哪几个 band"可变，但 band 之间今天根本没有数据流——`RulesHandler` / `DataObjectsHandler` 都忽略 `_inputs`（`engagement_runtime.ts:458,500`）。所以"换一套 band"在今天等于"换一组名字"，而风险（判别器在真实混合材料上长期摇摆、剧本名半年后长回域词）是实的。乙自认 F1 和 F5。
- **乙的承重机制是一个函数调用，乙自己承认靠纪律**。
- **乙自认 F6**：如果 profile 层永远停在 `"generic"`，剧本库会成为"我们已经处理了域假设"的挡箭牌，而反驳三指认的所有问题一个都没解决。
- **但乙赢了两件事必须吸收**：(1) 拓扑参数化 + 换选择=fork，这正好补上丙自认答不了的 F7（丙 §11.7"不给它拓扑表达位"）；(2) 只有乙注意到 `glue/engagement.ts:169` 调 `buildFdeEngagementDag()` **不带参数**——不改这里，任何参数化方案都会在 FDE 答完一个问题后静默换回旧拓扑。

### 实施要点（按批次，每批独立可回滚）

**P0 — 止血与说真话。零风险，产物不变，今天就能合。**

| 动作 | 位置 |
|---|---|
| 删 `PROCESS→RULES` / `PROCESS→DATA_OBJECTS` 两条零数据流边，三个分支并列依赖 INTAKE | `ts/src/onto/engagement.ts:95-96` |
| 删假注释"EXTRACT fan-out 是 PROCESS/DATA/RULES 节点内部的数据并行实现"（EXTRACT 是另一张 DAG、另一次 `Scheduler.run`，在 engagement DAG 被构造**之前**跑完：`run.ts:501/523` vs `run.ts:418`） | `ts/src/server/pipeline/run.ts:414-417` |
| 改假注释"段数来自材料结构，不来自内容 —— 计划冻结成立" → "段数来自解析器结构，**上限与排序来自用户输入**" | `run.ts:426` |
| 修写死的 `current: "PROCESS"`（冻结起点是 INTAKE） | `run.ts:422` |
| 删在真 DAG 跑之前手工播报的 `engagement.stage` | `run.ts:587-590` |
| 删 `EventKind.NODE_SKIPPED`（全仓零发射点，且与 `scheduler.ts:531-548` 的"从 journal 恢复的已完成节点"语义撞车，是读混陷阱） | `ts/src/kernel/events.ts:33` |
| 修 `dag.ts:325-327` 的注释——它现在是一句会被引用来做安全论证的假话 | `ts/src/kernel/dag.ts:325-327` |

**P1 — 堵住 A2 和 A3 这两条最狠的攻击链。**

| 动作 | 位置 |
|---|---|
| `criticRounds()` 的 `return 0` → `return 1`；引入 `CriticRounds` branded type（`< 1` 抛） | `ts/src/kernel/budget.ts:297-301`、`ts/src/kernel/loop.ts` |
| 删 `rounds !== 0` 守卫 | `loop.ts:641` |
| HITL 不可被 handler 否决：`const skipped = node.mode === NodeMode.HITL ? null : handler.skipModel(inputs)` | `loop.ts:627` |
| INTERVIEW 加 `gate: makeGateSpec({ kind: "hitl", require: ["human_ack == true"] })` | `ts/src/onto/engagement.ts:111-125` |
| `humanRequest` 在无 blocker 时改成展示覆盖情况的确认题 | `engagement_runtime.ts:579-593` |
| `MAX_SEGMENTS` 硬上限 + 超限时按文件名二次归并 + 写进 `plan.frozen`；排序键换成 chunk 原始序号 | `ts/src/onto/pipeline.ts:406-407`、`run.ts:433` |
| `CoverageCritic` 的 `outstanding()` 传 links、`YIELD_CN` 补条目——今天 SQL DDL 形状**必抛 `KeyError: 'links'`**，而且炸在模型产出**之后**（钱已花完） | `pipeline.ts:1304-1306`；同步改 `ts/test/onto.pipeline.test.ts:432-443` |

**P2 — 覆盖账本进产物。这一步之后"空包盖章"就死了。**

| 动作 | 位置 |
|---|---|
| `coverageLedger` 成为第 11 个顶层集合 | `ts/src/onto/canonical.ts:73-84` |
| `criticRounds()` 返回值低于 requested 时 emit `CRITIC_DEGRADED`，降级级别逐节点进账本——这就是 `budget.ts:263-265` 承诺过但全仓不存在的那个"未经语义审核"标记 | `budget.ts:297`、`ts/src/kernel/events.ts` |
| `validatePackage` 加 `MISSING_COVERAGE_RECORD`：允许空集合，不允许来历不明的空 | `canonical.ts:1500+` |
| `ReviewHandler` blockers 加第四类"审查完整性"：降级节点数 > 0 → blocker；`humanSeen === false` 无对应确认 → blocker；`segmentsCapped` → 强制 `releaseState: "DRAFT"` | `engagement_runtime.ts:636-690` |
| `downloadable` 从 `access(dir, W_OK)` 改成检"承诺的产物文件真的存在且非空"；`EXPECTED_ARTIFACTS` 从实际产出推 | `run.ts:866-874`、`engagement_runtime.ts:46-56,666-670` |
| `flow_preview` 档改 `releaseState: "PREVIEW"` + 不可导出，不再报"成功完成" | `run.ts:396-410` |
| **翻转两组 golden 断言**：`onto.converse.test.ts:984,1000-1014`（零流程三门全绿 → DRAFT + 账本非空）、`onto.pipeline.test.ts:432-443`（KeyError → 判欠 links） | 同上 |

**P3 — 拓扑参数化（吸收乙）。**

| 动作 | 位置 |
|---|---|
| `buildFdeEngagementDag(agents?)` → `buildEngagementDag(playbookId, agents?)`；`freezeBefore` 从 `"INTAKE"` 改成骨架第一个节点 | `ts/src/onto/engagement.ts:85-90` |
| **三个调用点全部同步改，漏一个就静默失效** | `ts/src/serve.ts:641`、`ts/src/server/glue/engagement.ts:169`、`ts/src/server/glue/harness.ts:127` |
| `run.ts` 在 `segmentCorpus` 之后、`engagementDag()` 之前做画像 + 选型；margin 低时**在花钱之前**挂起问人；选择进 DecisionLedger | `run.ts:413-418` |
| runId 拼上 playbook，否则换选择会命中旧 journal | `ts/src/server/session.ts:574` |
| `routes/fork.ts` 加 `playbookOverride`——换选择 = fork，不是原地改 | `ts/src/server/routes/fork.ts:153` |
| 剧本值域是 `Object.freeze` 的编译期常量，**不从磁盘加载、不从环境变量读**；bands 只能引用 `engagementHandlers()` 已注册的 key；硬上限 8 套；名字里不许出现域名词 | `engagement_runtime.ts:829-842` |

**P4 — 节点内自适应 + 去域化（丙的主体）。**

`AdaptiveProjection` 替换 `StaticProjection`（`engagement_runtime.ts:283-297`），lens 表是编译期常量数组（轮数上界 = 表长，材料只能决定跑哪个子集），merge patch 路径白名单（模型不能重写规则已从证据抽出的部分），三个停止条件（coverage 不增长 / 预算不足 / active 跑完）。lens 的目标就是今天那些恒空的槽：`trigger`/`precondition` 恒 null（`:374-375`）、`input_data_ids` 与 `output_data_ids` 同一数组（`:377-378`）、`condition` 与 `effect` 同一句原话（`:480-481`）、`test_cases` 恒 `[]`（`:484`）、`lifecycle_states`/`system_of_record`/`quality_rules` 恒空（`:515-518`）、`implementation_kind` 恒 `"UNKNOWN"`（`:435`）。

同批：`ERP_MAP → SYSTEM_BINDING`、词表下沉 profile、词表命中的 confidence 上限 0.5、真 LLM provenance critic（`EngagementProvenanceCritic` 今天恒 `passed: true`，而 lens 刚把模型引进产物，这是最该花钱的地方）。

**P4 之后 LLM 调用从 3 次涨到约 23 次，上界 = `Σ|lenses| + nodes × criticRounds + 1`，每一项都是编译期常量。**

---

## 我们放弃了什么

1. **放弃"拓扑在读材料内容之前定死"这个安全叙事。** 它今天就是假的（A1）。四处引用它的注释（`dag.ts:325-327`、`run.ts:414-417`、`run.ts:426`、`pipeline.ts:414`）要么改写要么删——留着比没有更危险，因为它会被后来人引用来论证一个不成立的安全属性。

2. **放弃"内容只能让工作变少，失败方向安全"这个论证。** 替代表述：**节点永不消失、critic 永不为零轮、gate 永不缺席；变的只有节点内跑了哪几个 lens，而"没跑"是产物里的一等公民。** 安全属性随工作量单调**递增**，所以要守的不是工作量的下界，是**未完成工作的可见性**。

3. **放弃"我们有一个域无关的普适元模型"。** 它是 `foundry-osdk profile v1`，在冻结点之前由用户选定，换域必须换 profile。

4. **放弃"每次梳理都跑满 8 个专业角色"这个交付叙事。** 今天那 8 个节点 10.9ms、零次模型调用、删掉六个产物不变。承认这件事是诚实上的进步、销售话术上的退步。

5. **放弃成本点估计。** 从"这条流水线固定跑 8 个节点"变成"这一档最多 N 步 / $X，超了停在人这里"。同时接受 P4 之后成本 2–4 倍。

6. **放弃无人值守发布。** INTERVIEW 必须有人点一次。

7. **放弃两组 golden 断言**（零流程全绿放行、CoverageCritic 的 KeyError）。它们把缺陷钉成了期望行为，是这次整改最大的单点阻力。

8. **放弃 run 内的回退重判。** 真 FDE 读到第三份材料发现"这不是采购流程，是资产台账"会回去重做前两份的定性——这个方案做不到，它只能"花钱前问一次 + 事后 fork"。这是 Recorder 内容寻址换来的重放能力的直接代价，我们选择保留重放。**这是本裁决最大的已知缺口，不粉饰。**

---

## 什么情况下这个结论会失效（可证伪的判据）

每一条都给出具体的观测量和阈值。到了阈值就说明这份裁决错了，该改的是裁决不是数据。

**V1｜如果 P4 落地后，lens 产出的字段在人工抽检中错误率高于规则底稿。**
判据：随机抽 50 个 lens 产出的字段（`trigger` / `test_cases` / `lifecycle_states`），由 FDE 判对错。如果模型填的比"恒空"更糟（错的比空的伤害大），那么"节点内自适应"这个方向错了，正确答案是保持确定性投影并把这些字段作为问题问出去。**这条如果失效，丙的主干就失效，应当退回乙。**

**V2｜如果拓扑参数化上线后，选型判别器的 `needsHuman` 比例长期高于 30%。**
说明"按主证据种类分剧本"这条轴切错了，真实客户材料是混合的。此时应当放弃剧本枚举，退回单一拓扑 + 更强的节点内自适应（即纯丙，放弃吸收乙）。

**V3｜如果覆盖账本上线后，DRAFT 命中率高于 40%。**
说明阈值定错了，而 DRAFT 会变成默认状态、所有人学会无视它——**这比没有覆盖账本更糟**，因为它制造了"我们有覆盖检查"的错觉。上线前必须用现有 golden 语料先测一遍。

**V4｜如果一年内剧本数超过 6 套，或任一剧本名里出现域名词（制造/零售/银行/采购）。**
说明域假设从 `ERP_MAP` 换了个位置复发，架构已经失败。该做的是把域搬进 profile 而不是加剧本。

**V5｜如果 profile 层半年后仍然只有 `"generic"` 一套。**
说明"元模型是 profile"只是一句话，`classification` 的中文采购词表还在原地。此时剧本库和覆盖账本会成为"我们已经处理了域假设"的挡箭牌——**比什么都不做更糟**。缓解只有一条：词表 confidence 上限 0.5 那个改动必须和 P4 同一个 PR 交付，不许拆。

**V6｜如果 `CRITIC_RESERVE` 上线后，大语料（>150 段）的 run 失败率超过 20%。**
说明"明确失败优于静默不审"这个交易在产品上不可接受，需要的是分批梳理机制——而分批是拓扑之外的东西，本方案没有表达它的位置。

**V7｜如果 P0 删掉两条零数据流边之后，任何一个测试变红或任何产物字节变化。**
说明"13 条边只有 4 条传数据"这个实测是错的，本裁决的事实基础不成立，整份文档作废重来。**这是最快、最便宜的一次证伪，应当第一个做。**

**V8｜如果有人能在能力闭集不变的前提下，用材料内容让系统调出一个 `forScope("converse")` 之外的工具。**
说明 A5 错了，能力墙不是正交的，冻结拓扑确实在承重。此时支柱一恢复，本裁决的第 9、10、11 条（拓扑/元模型/角色可变）全部作废。