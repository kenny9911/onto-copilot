# 本体数据包生成：精细化梳理流程设计

> 2026-08-17 · 12 个 agent 的多角度设计（5 份代码勘察 → 3 份独立提案 → 3 个视角横向评审 → 综合）
> 评审得分：可实施性 C=7 > A=5 > B=4 ｜ 反硬编码 A=8 > B=7 > C=5 ｜ FDE 可用性 C=9 > B=8 > A=6

## 核实说明（人工复核，先读这一节）

下面正文里的既存缺陷判断，我逐条回到代码核过。**多数成立，但有两条要纠正**——
照单全收会让实施路线的 Step 0 做错事。

### 成立，且是设计的真前提

| 判断 | 核实结果 |
|---|---|
| OIR 只有六桶，无 Event / Workflow | 成立。`ts/src/onto/oir.ts:718-723` |
| `applyOirEdit` 的 refill 是**硬编码 6 次调用** | 成立。`ts/src/onto/oir_edit.ts:878-883`。今天不是 bug，但加第 7 个桶而不改这里，新桶会被每次编辑静默清空 —— 这是"先做桶注册表"的真实理由 |
| `questionToDict` 不写 `informationGain` / `blastRadius` | 成立且影响真实。`oir.ts:700-714` 只写 rid/kind/text/options/answer/group/code/appliesTo/askedBy/owner/status；`questions.ts:701-704` 的 `fromDict` 找不到就取 0。于是 **OIR 来源的问题排序键恒为 0**，`nextBatch` 退化成 id 序。（clarify 来源的问题带 `score`/`impact_count`，不受影响 —— 正文没区分这一点） |
| `flow.ts` 的 `DOMAIN_CODES` 是 14 条采购短码 | 成立。`ts/src/onto/flow.ts:315-329`。此前已单独立项记录，本次由"反硬编码"评审独立复现 |
| 主仓已无 `.py` | 成立（搜到的几个在 `.claude/worktrees/` 的陈旧副本里，不在项目树内） |

### 需要纠正

**① `CoverageCritic` 的 LINKS KeyError —— 不是"未被发现的 bug"，是**明知**照迁的 Python 缺陷。**

抛错路径确实存在：`pipeline.ts:1304` 调 `outstanding()` 时只传 objects/properties/actions，
而 `CHECKED_YIELDS`（`:469-471`）含 `Yield.LINKS`、`YIELD_CN`（`:1236-1240`）没有 LINKS，
一旦某个 segment shape 期待 LINKS 就 `throw KeyError`。

但 `YIELD_CN` 的注释原文就写着「LINKS 不在这张表里，Python 侧就是 KeyError」，
且 `test/onto.pipeline.test.ts:432` 有一条测试把它钉住：
「CoverageCritic 在 LINKS 缺失时炸 KeyError（Python 侧同样炸，照迁不修）」。

**结论不变但理由变了**：该修 —— 因为"与 Python 保持一致"这条理由已经随 Python 删除而失效，
不是因为没人发现。修的时候要连那条 golden 测试一起改，并说明理由变更。

**② 「`preserveLifecycle=true` 把 ANSWERED 覆盖回 open」—— 方向反了。**

读 `questions.ts:1015-1027`：`preserve` 为真时是把 **`old.status` 复制到新问题上**，
也就是**保住**已回答状态，不是覆盖掉。正文设计六 §6.5 基于正确理解（"保留旧 status
时保留的就是 ANSWERED"），但"现状"一节把它列为断点，那一条是错的。

**实际影响**：不影响设计结论（走 Decision 关问题仍是对的），但**别按"修复 preserveLifecycle"
去动那段合并语义** —— 它现在的行为是对的，改了会让"重跑挖掘合法地重开问题"失效。

**③ 「`audienceRole` 恒为空串」—— 说过头了。**

存在填充路径：`canonical.ts:1197` 的 `roleFor(audience)`，以及 `routes/questions.ts:505/511`
让 FDE 手工指派。ERP_MAP（`engagement_runtime.ts:446`）用 `includes("erp")` 过滤时
是否恰好为空，取决于 canonical 是否已跑 —— **未核实**，按"很可能为空、需实测"处理，
不要当成已确认事实写进验收标准。

---

## 一句话结论

以 **C（FDE 工作流优先）为骨架**——所有新增能力一律追加在 `MERGE` 之后、不动 fan-out 基数与冻结边界，回填闭环靠 Decision 而不是靠改合并语义；把 **A 的 Step 0 地基与 GapClass 九类**、**B 的 COVERAGE 确定性节点与"元模型可写死、域模型不可"判据**嫁接进来；同时删掉三份提案里被核实为装不上、编不过或买贵了的六处主张（A 的 `appliesTo` getter 垫片与 EXTRACT 改名、B 的分片多 handler 与"形如状态词"、C 的 `outcomes/effects` 双字段与行数阈值分类器），并把契约 A 的执法机器从"最后一步"提到"新类型之前"。

---

## 现状：我们已经有什么、缺什么

### 已经有、且健康的部分（不动）

`Assertion<T>` / `Provenance` / `Origin` / `Status` 这套断言机制（`ts/src/onto/oir.ts:180-187`、`:268-273`、`:290-295`）、`makeRid`+`slug` 的无随机可复现 rid（`ts/src/kernel/ids.ts`）、Recorder 的 effect 指纹与重放（`ts/src/kernel/recorder.ts:376`）、`Scheduler` 按节点 id 恢复不重付（`ts/src/kernel/scheduler.ts:537-548`）、HITL 门与契约门（`ts/src/kernel/scheduler.ts:765-835`）、`TOOL_SCOPES.extract` 的工具作用域隔离（`ts/src/kernel/agents.ts:823`，无出网、无 `code.exec`）、`flow.ts:147` 的零模型流程图、`template.ts:808-851` 的证据驱动列过滤范式。

### 缺什么：分四类，每条都可指行

**(一) 类型系统的空洞**

| 事实 | 位置 |
|---|---|
| OIR 只有六桶，无 Event、无 Workflow | `oir.ts:718-723` |
| `ActionType` 无 actor、无 trigger，`effects` 是自由文本且 golden 里 6 条全空 | `oir.ts:550-560`、`golden/pipeline.oir.json` |
| 后果：`actorRole: null`、`trigger: null`、`preconditions: []`、`emits: []`、`lifecycleStates: []` 全部写死 | `canonical.ts:1045`、`:1081`、`:1051`、`:1053`、`:989` |
| `canonical.ts:1622-1626` 检查 `effects[j].object` 指向 dataObjects 的那段校验，因 `isMapping(effect)` 恒 false **从未执行过** | `canonical.ts:1622-1626` |
| `Cardinality` 只有 3 值，缺 `MANY_TO_ONE`；无反向名、无可选性、无派生标记 | `oir.ts:385-389` |
| `pkg.events` 唯一来源是 FlowGraph 的 `kind==="event"` 节点，无流程图则**永远是空数组** | `canonical.ts:1292-1309` |
| `processes[0].workflows` 是 `deepCopy` 的不透明块，`entry/exits` 仍是 `fn_*` 而同批节点已是 `pn_*`，`validatePackage` **一个字都不查** | `canonical.ts:1367`、`:1571-1588` |
| 材料里的"触发条件"被抽进 `ProcessStep.trigger`，只用于接边字符串匹配，随后折进 snippet 就消失 | `flow_extract.ts:167/185`、`:449-458` |
| `appliesTo`/`properties`/`source`/`target` 全是裸 rid 数组，无出处——"这个 Action 归属这个 Object 是谁说的"答不出 | `oir.ts:553`、`:618`、`:466`、`:513-514` |
| OIR 无任何版本号 | `oir.ts:863-873` |

**(二) 抽取链上的三处必炸/失效**

- `CoverageCritic` 无条件 `KeyError: 'links'`：`pipeline.ts:1304` 调 `outstanding` 漏传 `links`，`CHECKED_YIELDS` 含 `Yield.LINKS`（`:469-471`），`YIELD_CN`（`:1236-1240`）无 LINKS → 只要 `shape.expects(LINKS)` 就抛错，**钱花完才炸**。
- `applyOirEdit` 先 `oirFromDict(oir.toDict())` 往返，再**六个桶逐个 refill**（`oir_edit.ts:878-883`）→ 新桶每次编辑被整个清空。
- 模型从未看到工具目录：`ToolRegistry.catalog(scope)`（`kernel/tools.ts:673-677`）全库无调用者，`profile.column` / `oir.query` 虽在作用域内但模型无从得知。

**(三) 问题—提问—回收链的四个断点**

- **排序链断在源头**：`questionToDict`（`oir.ts:700-714`）不写 `informationGain`/`blastRadius`，`Question.fromDict`（`questions.ts:701-704`）取不到 → 全为 0 → `nextBatch`（`questions.ts:1082`）第二排序位恒 0，退化成 id 码点序。`Gap.weight`（`gaps.ts:155`）整套算白算。
- **模板回传的答复关不掉问题**：`/audit apply=true` → `mergeIntoOir`（`audit.ts:815-820`）→ `syncQuestionBacklog` → `backlog.add(q, preserveLifecycle=true)`（`questions.ts:1015-1027`）把 ANSWERED 覆盖回 open。golden `ts/test/onto.questions.test.ts:595-614` 钉住了这个 bug。
- **答完什么都不发生**：`applyDecision`（`clarify.ts:330-387`）只改 `oir.properties` 的三个字段，不碰 objects/links/actions/rules。
- **`audienceRole` 恒为空串**：三条生成路径都不产它；`engagement_runtime.ts:446` 的 ERP_MAP 靠 `includes("erp")` 挑问题 → **恒挑不出**；候选值硬编码在 `workbench.tsx:57`。

**(四) "要一份新材料"完全没有载体**

`gaps.ts` 全部 9 种 kind 都是"材料里的空白"或"OIR 内部空位"；`SuggestionKind.ASK_MATERIAL`（`suggest.ts:82`）是一张**没有按钮的卡**（`react/pending.tsx:110-114`），`applySuggestion` 对它 no-op（`suggest.ts:509-581`），下一次 compile 整体覆盖（`glue/compile.ts:258`）。补充材料与初始材料同路由、同目录、无来源标记（`routes/files.ts:48`），上传时正在梳理直接 409（`:106`）。

**(五) 契约 A 的现存违约（含三份提案都漏掉的一处）**

| 位置 | 内容 |
|---|---|
| `canonical.ts:769-772` | `MASTER_WORDS/REFERENCE_WORDS/...` = 供应商/物料/订单/合同/发票，纯采购域，驱动 `dataKind()`（`:783-790`），换域全落 `["transaction", 0.25]` |
| `engagement_runtime.ts:862-872` | **第二份并行且取值域不一致**的词表 |
| `workbench.tsx:57` | 六个硬编码中文角色 |
| **`flow.ts:316-329`** | **`DOMAIN_CODES` 14 条采购短码（集采计划→CP、采购申请→PR、供应商→SUP…），产出流程图节点编号，注释自陈"编号是下游系统的锚点"。三份提案的换域测试全抓不到它——PBP/SUP 不是中文域词。** |
| `flow_extract.ts:317-325` | `eventName()` 一律补"已生成"，把中文单据文书命名习惯焊死，而所有 Event 设计都建在它之上 |
| `flow_extract.ts:163-168` | `FIELDS`（触发条件/输入/输出/执行者）——体裁假设：材料必须是中文编号式流程说明书 |
| `template.ts:519/583/657/740/887/935` | 六张表里五张列头写死；只有 `02_待澄清问题` 兑现了证据驱动 |

**(六) 一条必须先纠正的集体误判**

三份提案都把"已录 journal 重放失败"当成头号硬约束，据此付出永久架构代价（B 建两个平行 agent、C 建 `outcomes/effects` 双字段）。核实结果：`runId` 由语料内容派生（`run.ts:319` `runIdFor`），resume 只在同一批材料崩溃重启时命中；workspace 里只有 2 个会话有真实 `llm.call` 日志；`golden/recorder.json` 钉的是 Recorder 自身的合成指纹，**没有任何 golden 钉住 extractor 的 system/prompt 原文**。改 schema 或改 system 文本的代价是"两个中断态会话重跑"，不是核心资产报废。同时 `src/ontocopilot` 下**已无 .py 文件**（只剩 `__pycache__` 空壳），所有"照迁 Python 缺陷"的注释都是陈迹。

**本设计据此做两个决定：一次性指纹断代是可接受的；`effects` 原地升级，不做双字段。**

---

## 设计一：本体类型系统的补完

### 1.1 前置：桶注册表（推翻六桶硬编码）

**新增** `ts/src/onto/buckets.ts`：

```ts
export const OIR_BUCKETS = [
  "objects","properties","links","actions","rules","questions","events","workflows",
] as const;

export interface BucketSpec<E> {
  name: BucketName;
  cn: string;                       // UI 统计中文名，收 ui/events.ts:115 的 EV_STAT_CN
  ridPrefix: string;
  hasConflicts: boolean;
  slots: readonly SlotSpec[];       // 见设计四，覆盖度矩阵与缺口探测的元数据源
  toDict(e: E): Dict;
  fromDict(d: Dict): E;
  refs(e: E): readonly EntityRef[]; // 出边，供 guard / dependents / 闭合校验通用遍历
}
export const BUCKET_SPECS: readonly BucketSpec<any>[];
```

**改造为从 `BUCKET_SPECS` 派生**（不改一处，新桶就在那一处静默失效）：

`oir.ts:718-723`（字段声明）、`:843-861`（stats）、`:863-873`（toDict）、`:961-1067`（fromDict）、`:814-840`（validate）、**`oir_edit.ts:878-883`（refill，最高优先级）**、`oir_edit.ts:813-847`（guard）、`bundle.ts:285`、`engagement_runtime.ts:876`、`pipeline.ts:727`、`pipeline.ts:1393`、`conflict.ts:1061-1065`、`audit.ts:722`、`dialogue/tools.ts:309`、`glue/tools.ts:379`、`artifacts.ts:726`、`ui/events.ts:115`。

**新增** `OIR.toDict()` 写 `$schema: "oir/2.0"`；`oirFromDict` 遇到未知版本**显式抛错，不走 `assertFrom` 的宽松兜底**（`oir.ts:927-932` 那条静默降级成 INFERRED 的路径是最难查的一类问题）。

### 1.2 `EventType`（新增，rid 前缀 `ev_`）

**新增** `ts/src/onto/events.ts`。

```ts
interface EventType {
  rid: string;                                  // ev_<slug>
  apiName: Assertion<string>;
  displayName: Assertion<string>;
  producerAction: Assertion<string | null>;     // at_* rid
  payloadObject: Assertion<string | null>;      // ot_* rid
  fromState: Assertion<string>;                 // 空 = 创建
  toState: Assertion<string>;
  consumers: Assertion<string[]>;               // at_* rid[]
  delivery: Assertion<string | null>;           // 取值不预设枚举，见下
  trigger: Assertion<TriggerSpec | null>;
  status: Status;
  conflicts: string[];                          // 跟 objects/properties/links 走
}
```

`TriggerSpec` 是**建模语言的语法**，六个值与域无关，硬编码正当（判别标准见设计七末）：

```ts
type TriggerSpec =
  | { kind: "temporal"; expr: string }                      // 自由表达式，不限 cron
  | { kind: "stateChange"; object: string; from: string; to: string }
  | { kind: "actionCompleted"; action: string }
  | { kind: "external"; system: string; endpoint: string }
  | { kind: "manual"; actorRole: Assertion<string> }
  | { kind: "threshold"; expr: string };                    // 自由表达式，允许跨属性
```

> `temporal` 用自由表达式而非 cron，`threshold` 用表达式而非 `{prop, op, value}` 三元组——A 的原设计表达不了"出院后 30 天内随访""库存 < 安全库存×1.2"。表达式串带证据，解析留给下游。

**`delivery` 不预设枚举**（推翻 C §1.1 注释里的"同步/异步/批量/人工"）：它是自由字符串 + 证据，取值域由设计四的 `need_value_domain` 缺口问出来。这类词是系统集成方言，预设即假定客户已有接口架构。

**rid 前缀必须是 `ev_`**：`canonical.ts:1293` 的 `canonicalId("evt", legacyId, "fn_", "evt_")` 剥前缀**命中一个就停**，OIR 若用 `evt_` 与流程图 event 撞 canonical id，整包校验挂在重复 id 上。**改造** `canonical.ts:1292-1309`：把 `"ev_"` 加进剥离列表，并仿 `canonical.ts:1253-1267` 的 action 撞 id 合并逻辑写一份 event 对偶（OIR 来源优先，flow 来源并入 `sourceProcessNodes`）。

### 1.3 `WorkflowType`（新增，rid 前缀 `wft_`）

`wf_` 已被 `flow_bpmn.ts:195` 占用。**新增** `ts/src/onto/workflows.ts`：

```ts
interface WorkflowType {
  rid: string;                            // wft_<slug>
  apiName / displayName: Assertion<string>;
  scopeObject: Assertion<string | null>;
  entry: Assertion<TriggerSpec | null>;
  steps: Assertion<WorkflowStep[]>;       // 有序
  exits: Assertion<WorkflowExit[]>;
  actors: Assertion<string[]>;
  stageKey: Assertion<string>;
  flowRef: Assertion<string | null>;      // flow.ts Workflow.key，双向可追
  status: Status; conflicts: string[];
}
interface WorkflowStep {
  rid: string; seq: number;
  action: string | null;                  // at_* —— 步骤不再是字符串
  emits: string[];                        // ev_*
  actorRole: Assertion<string>;
  guard: Assertion<string>;
  sourceFlowNode: string | null;          // fn_*，保留双向追溯
}
```

**保留 `flow.ts:278-284` 的 `Workflow` 不动**（C §11 取舍 3，采纳）：它是图追踪单位，`flow.ts:273-277` 的注释说清了它与 Stage 是两个维度；升成本体实体会让 `flow_bpmn` 导入路径与 `buildFlowDiagram` 的零模型保证一起复杂化。两者靠 `flowRef` 关联。

**改造** `canonical.ts:1367`：`deepCopy(flowData.workflows)` → 从 OIR `workflows` 桶 canonical id 化；**改造** `canonical.ts:1571-1588` 的 `validatePackage` 补 workflow 的 step→action / emits→event 引用校验。这是把一个从未被验证过的悬空产物接进校验。

### 1.4 `ActionType` 原地升级（推翻 C 的双字段方案）

```ts
ActionType += {
  actor:   Assertion<string>;
  trigger: Assertion<string | null>;      // ev_*
}
ActionType.effects: Assertion<Effect[]>   // 原地升级，删除自由文本形态
interface Effect { object: string; verb: "create"|"update"|"delete"|"read"|"transition";
                   field?: string; fromState?: string; toState?: string }
ActionType.conflicts: string[]            // 补上与 objects/properties/links 的不对称
```

`effects` 原地升级、**不设 `outcomes` 并列字段、不写 `outcomes ?? effects` 回落分支**：C 为它付的代价（永久 schema 疤 + 传染到 canonical/gaps/模板每一处读 action 的地方）买的是一条已经不存在的约束。原地升级的即时收益：`canonical.ts:1622-1626` 那段从未执行过的交叉校验第一次接通。

`ObjectType` 相应新增 `lifecycleStates: Assertion<string[]>`，给 `Effect.toState` / `Event.fromState/toState` 一个值域，同时解决 `canonical.ts:989` 的写死空数组。

### 1.5 `LinkType` 补全

- `Cardinality` 加 `MANY_TO_ONE`；**`gaps.ts:538` 那三个写死的中文选项改为从枚举生成**（顺手清一处硬编码）。
- 新增 `inverseApiName: Assertion<string>`（Palantir 双向 link 名）。
- 新增 `sourceOptional / targetOptional: Assertion<boolean>`（0..1 vs 1..1）。
- 新增 `derivation: Assertion<Derivation|null>`，`{kind: "declared"|"joinKey"|"flowAdjacency"|"nameMatch", expression?}`——OIR 层缺少 `flow.ts:154` 的 `EdgeKind.INFERRED` 那种"这条是我们连的"信号。

### 1.6 引用出处：`RefLedger` 旁挂表（采纳 C，推翻 A 的 getter 垫片）

A 的 `appliesTo` getter 垫片装不上：`ObjectType`（`oir.ts:458`）/`ActionType`（`oir.ts:550`）都是 plain interface + 对象字面量工厂，而 `applyOirEdit`（`oir_edit.ts:858-885`）每次编辑都做完整 JSON 往返——getter 要么逼你把所有 interface 改成 class（波及每个工厂、每个 fromDict、每处 spread），要么用 `defineProperty`（往返一次就没了，和 `titleProperty` 现在丢失的机制一模一样）。垫片会在它自己点名的那条路径上静默失效。

**改用旁挂表**：实体字段形状一字不动（`guard`/`dependents`/`canonical.buildPackage` 零改动），出处与角色单独存。

```ts
// ts/src/onto/ref_ledger.ts [新增]
type RefRole = "hosts"|"reads"|"writes"|"creates"|"deletes"|"emits"|"consumes"|"triggers";
interface RefRecord { subject: string; field: string; target: string;
                      role: RefRole; assertion: Assertion<string> }
class RefLedger {
  records: RefRecord[];
  byKey: Map<string, RefRecord[]>;   // `${rid}#${field}`
}
```

`OIR.toDict()` 多写一个 `refs` 键；读侧全部可选，取不到就是现状。`validate()` 不强制。`cite()`（`oir.ts:210-254`）在 UI 上支持点回原文。

### 1.7 `dependents()` 真图遍历

**改造** `oir.ts:788-810`：从"只走 objects/properties 两支"改成正向 `BucketSpec.refs()` + 反向索引的双向遍历。A 与 C 都把这写成大工程，核实后并非如此：`dependents` 在 `ts/src` 只有两个调用方（`clarify.ts:272`、`glue/tools.ts:453`），需重录的 golden 只有 `golden/onto.clarify.json` 一个。

---

## 设计二：抽取流水线的分层与节点契约

### 2.0 一条不可违反的分层规则

> **冻结边界内不允许出现任何依赖内容语义的判据。新增抽取能力一律走 `MERGE` 之后的追加节点。**

这条规则同时否决了 A 的 `shape.hasTriggerLikeColumn()`（要新引中文表头词表，而它决定 fan-out 基数）和 B 的 `Yield.EVENTS`"值形如状态词"（同样要词表，且坐在 expand 路径上——漏判不报错、不产缺口、不花钱，**一个 pass 从来没跑过是不可观测的**）。

`shape.ts` 现有实现是守这条规则的：`TYPE_NAME_RE`（`:246`）与 `BOOL_WORDS`（`:263`）都注明词表只作辅助、主判据看取值分布。

### 2.1 五层与谁花钱

| 层 | 节点 | 模式 | 输入契约 | 输出契约 | 模型调用 |
|---|---|---|---|---|---|
| L0 解析 | `parseAll`/`buildIndex`/`collectEndpoints`/`collectProfiles`（`run.ts:358-369`） | — | 文件 | `ParsedDoc[]`+`EvidenceIndex`+`Profile[]`+**`MaterialProfile[]`（新）** | 仅扫描件视觉模型 |
| L1 结构 | `buildFlowDiagram`（`run.ts:380`）+`segmentCorpus`（`pipeline.ts:345`） | 确定性 | ParsedDoc[] | `FlowGraph`+`Segment[]` | **0** |
| L2 段内抽取 | `EXTRACT.*` fan-out + `MERGE`（`pipeline.ts:1421-1443`） | PLAN_EXECUTE | 段正文+shape+carryIn+outstanding | 六桶片段 | **17 次（不变）** |
| **L2.5 缝合** | **`TRIGGER` → `STATE` → `WEAVE`（新增，deps 链在 MERGE 之后）** | 确定性 / 单次 LLM / 确定性 | OIR+FlowGraph+Profiles | Action.trigger 回填 / `EventType[]` / `WorkflowType[]` | **+6~8 次（仅 STATE）** |
| **L2.6 覆盖度** | **`COVERAGE`（新增，deps: `["WEAVE"]`）** | DETERMINISTIC | OIR+EvidenceIndex+MaterialProfile | `CoverageReport` | **0** |
| L3 收敛 | `finish()`（`pipeline.ts:1531`） | 确定性 | OIR+CoverageReport | 冲突/澄清/模板 | 0 |
| L4 交付 | engagement DAG 10 节点（`engagement.ts:85-170`） | skipModel/DETERMINISTIC | QuestionBacklog | DecisionLedger→OntologyPackage | 0 |

**节点 id 一字不改**：`EXTRACT`、`MERGE` 保持原名，`freezeBefore: "EXTRACT"` 不动。A 的 `EXTRACT→EXTRACT_S` 改名是零收益自伤——`Scheduler.run` 靠 `rec.nodeIsComplete(nid)` 按 id 恢复（`scheduler.ts:537-548`），改名让所有中断态 run 的抽取节点全部重跑重付。

**`forNode` 契约不动**：一节点一 handler。B 的 `s0_0.extract`/`s0_0.events` 方案按字面写法编不过——`Dag.expand` 产出 `${base}.${sfx}`，而 `SegmentRouter.forNode`（`pipeline.ts:1497-1507`）取 `nodeId.split(".")` 最后一段当段 key，节点变成 `EXTRACT.s0_0.events` 后 key 落成 `"events"`，直接走进 KeyError 分支。

### 2.2 `TRIGGER`（零成本，白捡）

**新增** `ts/src/onto/weave.ts` 的 `TriggerHandler`。输入 `MERGE` 后的 OIR + `flow_extract` 的 `ProcessStep[]`；把 `ProcessStep.trigger`（`flow_extract.ts:167/185`，现在只用于接边字符串匹配、随后在 `:449-458` 折进 snippet 消失）解析成 `TriggerSpec` 回填 `ActionType.trigger`，并产出 `EventType` 候选。零模型调用。

### 2.3 `STATE`（全案唯一新增付费点，输入装配写清楚）

**新增** `ts/src/onto/state_mine.ts` + `kernel/agents.ts` 新增 agent `state_miner` 与 `STATE_MINER_SCHEMA`（仿 `RULE_MINER_SCHEMA`，`agents.ts:265-299`，独立 agent 独立 schema 是本仓已有的扩展范式）。

**输入装配**（C 对此一笔带过，这里补完）：

1. **属性目录**：MERGE 后所有 `PropertyType` 的 `rid / apiName / parent / baseType`。
2. **列画像**：对每个 property 从 `collectProfiles`（`run.ts:369`）取 `ColumnProfile` 的 distinct 数、fill rate、按频次排序的前 K 个样本取值。
3. **候选收敛**：**不预筛"哪些是状态列"**（那是词表）。把 `distinct/rows` 落在**本语料内低分位**、非数值、fill > 本语料内低分位的所有列全部作为候选交给模型。分位数取值写进产物 manifest 的 `thresholds` 块（见设计七）。
4. **散文证据**：节点 `evidenceTopK` 设 32，查询串由 `handler.query(inputs)` 用对象 displayName + 候选列 apiName 拼。**这是 `evidenceTopK` 第一次真正生效**——engagement 那五个节点的 40/48/24 是死配置，`loop.ts:661-676` 算完就丢。
5. **工具**：作用域仍是 `extract`（`agents.ts:823`，无出网、无 `code.exec`），可用 `evidence.search` / `profile.column` / `oir.query`。

**为什么这个候选切法可接受而 B 的 expand 切法不可接受**：这里的切法是**付费节点内部的 prompt 圈定**，切错是可观测的——模型报不出东西 → 覆盖度不涨 → 设计四的缺口探测器把它捞出来问人。B 的切法在 expand 路径上，切错完全无信号。

预算：`iterations: 3`、`difficulty: HIGH`、critic 规则型（`needsLlm=false`），单次 `1 plan + ≤3 step + 1 final + ≤R refine` = **+6~8 次调用**，不是 +N 段。

### 2.4 `WEAVE`（零成本）

`weaveWorkflows(flow, oir): WorkflowType[]`。复用 `linkFlowToApi`（`run.ts:566` 已在用）做 flow 节点 ↔ OIR action 的对齐；`FlowGraph.workflows` 的 `{entry, exits}` 交叉展开成 `WorkflowStep[]`。**对齐失败留空并产缺口，不猜**（沿用 `canonical.ts:1371` "不猜"的注释精神）。同时回填 `Action.emits` / `Event.consumers`。

### 2.5 `COVERAGE`（新增确定性节点，deps: `["WEAVE"]`）

采纳 B 的形态判断——纯追加的 DETERMINISTIC 节点是本仓最省事的扩展方式，不碰任何已录节点的 request。

**新增** `ts/src/onto/coverage.ts`：

```ts
type CellState = "confirmed"|"grounded"|"corroborated"|"inferred"|"unfounded"|"missing";
interface CoverageCell { bucket: BucketName; rid: string; slot: string; state: CellState;
                         evidenceFiles: string[]; container: string | null }
interface CoverageReport {
  cells: CoverageCell[];
  byBucket: Map<BucketName, {total, grounded, inferred, missing}>;
  material: { byContainer: Map<string, number>; zeroYieldContainers: string[] };
  closure: { danglingRefs: EntityRef[] };
  thresholds: Record<string, number>;   // 本次生效的全部阈值，进 manifest
}
```

**材料轴用容器级归属，不做 chunk 级反查**（裁决 B 的最重假设）：B 的 `Provenance → chunk_id` 反查表要求 locator 是全域单射键，而 locator 形状按解析器各不相同（sheet/row 区间 vs section vs page）。改用 `containerOf(locator)`——这个纯函数在仓里**已经实现了两次**：`gaps.ts:234-240`（sheet/section/object/page 依次取）和 `pipeline.ts:360-390` 的分组键。用它把每条 Claim 归到容器，再与 `MaterialProfile` 列出的全部容器做差，即得 `zeroYieldContainers`。零新假设。

`state` 必须用 `pyTruthy` 判空——`oir.ts:822` 明确写了写 `!value` 那条永远不触发。

### 2.6 L2 层必须同时修的四处

| 位置 | 改什么 | 不改的后果 |
|---|---|---|
| `pipeline.ts:1304` + `:1236-1240` | `outstanding` 补 `links` 入参；`YIELD_CN` 从 `Yield` 枚举派生 | 新增 link 抽取必炸，钱花完才炸 |
| `harness.ts:62-66` | system 拼装加 `## 可用工具\n${tools.catalog(node.scope.tools)}` | 模型不知道 `oir.query`/`profile.column` 存在 |
| `pipeline.ts:1484` | `MineRules` / `state_miner` 传 library | rule_miner 连技能 brief 都没有 |
| `agents.ts:775` | "规则结构化"规程从 `rule_engineer` 改挂 `rule_miner` | 那篇规程挂在 skipModel 投影上（`engagement_runtime.ts:453-493`），**永远不会执行** |

第二项会改 system 文本 → 改指纹（`llm.ts:882-893` 把 system 与 prompt 原文一起放进被 fingerprint 的 req）。按现状核实，代价是两个中断态会话重跑。**与 L2.5 一起上，作为一次性指纹断代，在同一个 commit 里重录。**

---

## 设计三：证据、置信与"推断 vs 事实"的表达

### 3.1 不加 `Origin` 枚举值（采纳 B 的克制）

`oir.ts:927-932` 的 `assertFrom` 对未知 origin 静默降级成 INFERRED，跨版本会静默丢信息。四档 `extracted|inferred|user|auto_repaired` 不动。

**新增** `ts/src/onto/grounding.ts`，`GroundingLevel` 是**派生函数、不落盘**：

```ts
function grounding(a: Assertion<unknown>, oir: OIR): GroundingLevel {
  if (a.origin === Origin.USER) return "authoritative";
  if (a.origin === Origin.AUTO_REPAIRED) return a.evidence.length ? "grounded" : "unfounded";
  if (a.origin === Origin.EXTRACTED)
    return new Set(a.evidence.map(e => e.fileId)).size >= 2 ? "corroborated" : "grounded";
  return a.evidence.length ? "inferred_cited" : "unfounded";
}
```

跨文件互证这一档是白捡的：`EvidenceIndex.roundRobin`（`evidence.ts:477-503`）本来就按文件轮转保证跨文件多样性。

**UI 只显示三档**（推翻 B 的五档色标）：`材料里写的 / 我们推的 / 人拍板的`。`corroborated` 与 `inferred_cited` 的区别 FDE 不会用来做任何决定，五档色标是噪声。五档保留在内部用于统计与打分。契约 B：在 `index.html` 现有配色里加三个语义色，不改布局、不改组件结构。

### 3.2 `Provenance` 加可选 `derivedFrom`

`validateAssertion`（`oir.ts:301-306`）唯一的不变量只检 `EXTRACTED && evidence 为空`——**INFERRED 无证据是合法的**，于是 L2.5 缝合出来的 Event 和"瞎猜的"在系统里没有区别。

`Provenance += { derivedFrom?: readonly string[] }`（可选，不破坏现有 `fromDict`）。`cite()`（`oir.ts:210-254`）加一个分支：非空时打印 `由 at_xxx 推出`。

### 3.3 置信度默认表（写进 `oir.ts` 常量）

| 来源 | origin | conf |
|---|---|---|
| 段内抽取 | EXTRACTED | 0.8（现状 `oir.ts:321`） |
| L2.5 缝合，两端都有证据 | INFERRED + derivedFrom | 0.6 |
| L2.5 缝合，只有一端 | INFERRED + derivedFrom | 0.4（现状 `:325`） |
| **结构默认值（如 cardinality 落 ONE_TO_MANY）** | **INFERRED，evidence 空** | **0.3（新档）** |
| 人工决策 | USER | 0.98（现状 `:329-341`） |
| 业务方 Excel 回填 | USER | 0.95 |

0.3 那一档让 `gaps.ts:536` 的 `link_cardinality` 判据从"evidence 为空"改成"confidence ≤ 0.3"，更准。

### 3.4 修三处静默降级

- `oir.ts:939-941`：缺 `confidence` 落 0.5 而非工厂默认 → 一次往返把所有置信度抹平到 0.5。改成按 origin 查工厂默认值。
- `oir.ts:904-906`：`confidence: 0` 被 `or` 吃掉 → 用 `??`。
- `oir.ts:464-466` / `:986`：`titleProperty` 有字段但 toDict 不写、fromDict 硬塞 `inferred(null)`，而 `applyOirEdit` 每次编辑都做往返（`oir_edit.ts:868`），所以这个字段**实际上永远是 null**。补进 toDict。

### 3.5 证据的升降级

**新增** `ts/src/onto/promote.ts`：

- **提升**：`recheck(oir, index)`——对每个 unfounded 断言拿它的值当 query 跑 `index.search`，BM25 超阈值且返回切片含该值字面形式 → 追加 Provenance 并把 origin 改成 EXTRACTED。触发时机：新材料到达、定向回填生效、`/audit` 回读之后。`Assertion` 可变（`oir.ts:288-289` 已为 auto_repair 开了口子），这是正当用法。
- **降级**：`DELETE /api/sessions/:sid/files/:name`（`routes/files.ts:70`）删材料后重跑 preparse，但 **OIR 里指向已删文件的 Provenance 没人清**。摘掉后为空的 EXTRACTED 断言必须降级成 INFERRED，否则违反 `validateAssertion` 直接把 `validate()` 炸掉。这是一个真实的数据完整性洞。

### 3.6 溯源的交付含义

`traceability(pkg)`（`engagement_runtime.ts:882-911`）现在只进 REVIEW warnings（`:677-679`）与一条 MEDIUM finding（`:800-818`），只警告。

**改造为两条**：
1. ungrounded 的 **hard-required 槽位** → 进设计四的缺口探测，成为可派单可关闭的问题（**rollup 成一条**，不逐条炸）。
2. ungrounded 比例超阈值 → `releaseState` 强制 `DRAFT`（`engagement_runtime.ts:671-672`），**不阻断交付**。业务方拿到的包上盖"草稿"戳，`交付说明.md`（`bundle.ts:388`）首屏写明 DRAFT 含义与还差什么。

---

## 设计四：缺口类型学

### 4.1 `GapClass` 九类（采纳 A，替换 B 的八类）

```ts
export const GapClass = {
  NEED_EVIDENCE:     "need_evidence",      // 有值但没出处
  NEED_DEFINITION:   "need_definition",    // 口径
  NEED_VALUE_DOMAIN: "need_value_domain",  // 取值域
  NEED_OWNER:        "need_owner",         // 责任人/执行角色
  NEED_MATERIAL:     "need_material",      // 要一份新文件
  NEED_SAMPLE_DATA:  "need_sample_data",   // 要几行真实数据
  NEED_MAPPING:      "need_mapping",       // 两个称呼之间的对照表
  NEED_CONFIRMATION: "need_confirmation",  // 我们推的，请确认
  NEED_DECISION:     "need_decision",      // 冲突拍板（现 clarify）
} as const;
```

A 的九类比 B 的八类干净：B 的 `cardinality_unknown` 是元模型槽位不是需求类型。

`Gap`（`gaps.ts:126-137`）加：`gapClass`、`why`、`cellIds: string[]`（对应覆盖度矩阵的格）、`informationGain`、`blastRadius`、`aggregate: "per_instance"|"rollup"`。现有 9 个 kind 全部落 `STRUCTURE` 语义并映射到对应 GapClass，零回归。

### 4.2 探测器**手写**，不用通用遍历（裁决：A vs 评审三）

**A 的 `mineTypeHoles` 通用遍历不作为问题正文的生产者。** 两个理由，都是评审三核实的：

1. **数量**：8 桶 × 每桶 10+ slot × N 实例 = 数千条，A 全篇无聚合规则。而现有 `gaps.ts` 是聚合的——`gaps.ts:545-546` 把"N 个对象没有说明"聚成**一条**，`gaps.ts:502-509` 的接口孤儿 `PER_KIND` 截断后聚合成"另有 N 个同样挂不上"。通用遍历把这个已经写对了的能力整个丢掉。
2. **措辞**：A §10 自己的边界是"模板里只允许出现实体自己的 displayName 和槽位的通用名"，而槽位名就是 `primaryKey`/`cardinality`/`lifecycleStates`——全是建模行话。现在手写的是"『采购申请单』和『供应商』之间，一个对应几个？"（`gaps.ts:533`），模板化之后只会退回"『采购申请单』的 cardinality 未定"。

**SlotSpec 保留，但只作内部表示**：供覆盖度矩阵定义格子、供缺口探测器声明它盯的是哪些格、供 `validate()` 的必填判断。**不直接把空槽位翻译成发给业务方的问题。**

```ts
interface SlotSpec {
  path: string;                       // 技术路径，只在内部与 FDE 界面出现
  required: "hard"|"soft"|"no";
  evidenceRequired: boolean;
  gapClass: GapClass;
}
interface GapDetector {
  id: string;
  slotRefs: readonly string[];        // 它盯的格子，供覆盖度反查"这一格谁在管"
  aggregate: "per_instance"|"rollup";
  rollupThreshold?: () => number;     // 本语料内分位数，不是字面量
  detect(ctx: GapContext): Gap[];     // 手写，措辞手写
}
```

**措辞规约（写进 CONTRIBUTING，作为 review 检查项）**：每条新增探测器的文案必须过一遍"这句话给一个不懂建模的人看，他能不能开口回答"。禁用词 grep 门：

```
grep -nE '(cell|格子|slot|槽位|blastRadius|Assertion|rid|apiName|baseType|cardinality|primaryKey)' <面向业务方的文案模板>
```

必须为空。**FDE 内部界面不受此限**——`blastRadius` 与 `blockedArtifacts` 在 FDE 那侧作为结构化字段单独展示，不塞进 `why` 文本。这一条同时否决了 B §7.1 那种"『采购订单.供应商』这一格没有证据"的样例。

### 4.3 保留的探测器与新增的探测器

**保留措辞与聚合行为不动**（只重新归类 + 补 `slotRefs`）：
- `undeterminedSlots`（`gaps.ts:281-311`，正则找"XX 天""待定"占位符）→ `NEED_DEFINITION`
- `enumerations`（`:438-467`）→ `NEED_VALUE_DOMAIN`
- `emptyContainers`（`:332-357`）→ `NEED_MATERIAL`。**顺手修 `:338-339` 只认 `locator.sheet`，`empty_section` 写 `section` 键就被静默丢弃的 bug**
- `structuralGaps`（`:483-557`）五条 → 按 slot 归类，`object_no_description` 与 `action_no_host_more` 的 rollup 形态**原样保留**
- `alignmentGaps`（`:588-619`）→ `NEED_MAPPING`

**新增探测器**（判据全部结构统计，零域词表）：

| GapClass | 探测器 | 判据 | 聚合 |
|---|---|---|---|
| NEED_MATERIAL | `zeroYieldContainer` | `CoverageReport.material.byContainer` 某容器产出 Claim 数为 0 且切片数 ≥ 本语料分位数 | per_instance |
| NEED_MATERIAL | `noFieldSpec` | 无属性的对象占比 ≥ 本语料分位数 **且** 无任何 `MaterialProfile.hasDataTypeColumn` | rollup |
| NEED_MATERIAL | `danglingSystem` | `action.sourceEndpoint` 的 host 段（`canonical.ts:1016-1025` 已在提取）在 `EvidenceIndex._byFile` 里无对应接口文档 chunk | per_instance |
| NEED_MATERIAL | `crossFileRefMiss` | chunk 文本命中"详见/见附件/参见" + 2-20 字名词，且该名词不在 fileName 集合里 | per_instance |
| NEED_MATERIAL | `noProcessGenre` | `flow_extract` 的 FIELDS 命中率为 0（见 4.5） | rollup |
| NEED_SAMPLE_DATA | `pkAmbiguous` | `primaryKey` 空且候选标识列 ≥2 | per_instance |
| NEED_SAMPLE_DATA | `cardinalityUnsupported` | `cardinality` conf ≤ 0.3 且两端无 profile 支撑 | per_instance |
| NEED_OWNER | `ownerlessRollup` | `object.owner`/`rule.actor`/`action.actor`/`workflowStep.actorRole` 为空 | **rollup（一条，带表格答案）** |
| NEED_CONFIRMATION | `derivedNeedsConfirm` | 所有 `derivedFrom` 非空的 hard 槽位 | **rollup** |
| NEED_EVIDENCE | `ungroundedHard` | `evidenceRequired` 且 evidence 空的 hard 槽位 | **rollup** |

`crossFileRefMiss` 的"详见/参见"是**语言学模式不是域词表**——在医疗、保险、制造材料里同样成立。这是判据合法性的分界线。

`ownerlessRollup` 用 rollup 而非逐条，是同时解决评审二（守住 routeAudience 拒绝推断）与评审三（首屏几十条"这块归谁管"）的关键：**一条问题 + 一张表格答案，不是 N 条问题。**

### 4.4 判据阈值一律用本语料内分位数

**推翻 A 的全部字面阈值**（`distinct/total < 0.05`、`distinct ≤ 30`、`typeCoverage ≥ 0.85`、`behaviorSegs` filter）。这些是在采购语料上调出来的魔数，一张 20 行的医嘱类型表 `distinct=15/total=20 = 0.75` 直接漏判。词表能 grep，阈值不能——A 的 grep 门对这类完全无效，必须单独立规。

**判据阈值 vs 策略阈值**（本设计的裁决，同时回应评审二与评审三）：

- **判据阈值**（决定"这个东西算不算缺口"）：一律取本语料内分位数（如"本会话所有列的 distinct 比率的 25 分位"）。
- **策略阈值**（决定"我们什么时候停、什么时候盖 DRAFT"）：允许是常量，但必须是一处具名配置。

**两类阈值的生效值都写进 `ontology.package.json` 的 `thresholds` 块与 manifest**，供审计与跨域对比。这是防止阈值退化成隐形词表的唯一手段。

### 4.5 三处体裁/词表清算（评审二发现，三份提案都漏了）

| 位置 | 改法 |
|---|---|
| `flow.ts:316-329` `DOMAIN_CODES` | 删表。编号改为**语料内稳定分配**：`(语料指纹, 名称) → 短码`，纯函数、无内置表、跨重跑稳定（保住"编号是下游系统锚点"的性质）。采购材料失去人工校准的短码，是可接受的代价 |
| `flow_extract.ts:317-325` `eventName()` 补"已生成" | 删后缀。`EventType.displayName` 由抽取给出并带证据；拼不出就留空并产 `NEED_DEFINITION` |
| `flow_extract.ts:163-168` `FIELDS` | 承认它是"中文编号式流程说明书"解析器，**显式降级为一个可选 parser profile**。命中率进 `MaterialProfile`；命中率为 0 时**不静默出空流程图**，产一条 `noProcessGenre` 的 NEED_MATERIAL 缺口 |
| `canonical.ts:769-772` + `engagement_runtime.ts:862-872` | **删两份词表**。`dataKind()` 判不出时返回 `["unknown", 0.0]` → 进 NEED_CONFIRMATION 问人。**推翻 C 的行数阈值分类器**（`master = 10²~10⁴`、`transaction ≥ 10⁴`）：医院科室主数据 40 行落 transaction、零售 SKU 主数据 10⁶ 行也落 transaction，而 FDE 手上是 200 行 Excel 摘录不是生产库。C 的替换比现状更坏——现状落 0.25 明示不知道，C 换成一个高置信度的错分类。**弃权优于猜测。** |

### 4.6 两个修复

- **weight 活到终点**：`OpenQuestion`（`oir.ts:657-672`）加 `informationGain`/`blastRadius`/`why`/`audienceRole`/`gapClass`，`questionToDict`（`oir.ts:700-714`）写出。三十行以内修好整条排序链。
- **rid 折叠**：`gaps.ts:162` 的 `makeRid("oq", kind + "_" + text.slice(0,60))` 遇上 `slug` 的 40 字截断（`ids.ts`）→ 同类型、开头 40 字相同的两条静默折叠。改成 `makeRid("oq", gapClass + "_" + subjectRid + "_" + slotPath)`——主体+槽位天然唯一且幂等可复现（`run.ts:568` 的"同 rid 保留旧问题"语义才有意义）。

---

## 设计五：问题对象与提问协议

### 5.1 问谁：`audienceRole` 从材料自举，推不出就留空

**新增** `ts/src/onto/roles.ts`：

```ts
buildRoleRegistry(oir, flow): RoleRegistry
// 角色 = rule.actor ∪ flowNode.actor ∪ workflowStep.actorRole ∪ 材料里"审批人/负责人"列取值
// 每个角色带 Provenance 与出现频次
routeAudience(gap, registry): string | null
```

路由依据是**证据来源**不是词表：MATERIAL/SAMPLE → 该 gap 证据所在文件的 owner；SEMANTICS(object) → 该对象上 action.actor 频次最高者；STRUCTURE(link) → 两端对象 actor 交集。

**推不出返回 null，不硬编码兜底**（推翻 `workbench.tsx:57` 的六个角色与 `engagement_runtime.ts:331` 的 `|| "业务负责人"`）。留空的部分由 4.3 的 `ownerlessRollup` **聚成一条**问 FDE，而不是几十条。

UI 下拉从 `GET /api/sessions/:sid/roles` 拉（新路由）。契约 B：还是那个 select，只是选项从接口来。

### 5.2 为什么问：`why` 面向业务方

`why` 现在恒为空串（`questions.ts:684-693`，唯一写入点是人工 PATCH `routes/questions.ts:484-511`），导出模板"为什么问"一列默认全空。

每个探测器必填 `why`，规约：**说清"答了它会解锁什么"，且受 4.2 的禁用词 grep 门约束**。例："这条关系一对几条，决定一张单据能不能挂多张下游单据，直接影响交付包里关系的形状。"

FDE 侧看到的 `blastRadius`、`blockedArtifacts` 是**结构化字段单独渲染**，不进 `why` 文本。

### 5.3 影响什么

`blastRadius = oir.dependents(appliesTo).size`（用 1.7 改造后的真图遍历）；`informationGain` = `gap.weight` 归一化 × 该 gap 能点亮的格数。两者进 `questionToDict`，`nextBatch`（`questions.ts:1055-1099`）——**全系统唯一按信息价值排的序**——第一次真正生效。

**改造** `workbench.tsx:108-120` 的 `NextBatch`：现在只读显示前 5 条、不可点、不能答，是一个算对了却接不上动作的组件。改成可直接展开回答。

### 5.4 怎么答：`answerSchema` 按 gapClass 分派

现状实际取值只有 `{type:"string"}` 或 conflict 的 enum（`questions.ts:651-662`）——因为 `gapToQuestion` 产的问题 `sourceKind` 被判成 `"open_question"`（`:627-635`），**`link_cardinality` 的三个选项、`enum` 的取值清单、`alignment_uncertain` 的三个选项全部退化成自由文本**。

| gapClass | answerSchema | UI 控件 |
|---|---|---|
| NEED_DEFINITION（无选项） | `{type:"string", minLength:2}` | textarea（现状不动） |
| NEED_VALUE_DOMAIN / NEED_DECISION / STRUCTURE(有选项) | `{type:"string", enum:[...]}` | 下拉 |
| NEED_OWNER（rollup） | `{type:"array", items:{type:"object", properties:{subject, role}}}` | 批量指派表（见 5.6） |
| NEED_MATERIAL / NEED_SAMPLE_DATA | **`{type:"material", requiredColumns:[...]}`** | 上传按钮 |

**改造** `questions.ts:1504-1514` 的 `TYPE_CHECKS` 加 `material` 一档（值形如 `{fileId, fileName, digest, sheet?}`）。**注意 `:1534` 的 `TYPE_CHECKS.get(k) ?? (()=>true)` 未知 type 一律放行——不加进去等于不校验。**

**改造** `questions.ts:651-662`：schema 生成按 `gapClass` 判，不按 `sourceKind` 判。

**放弃 answerSchema 驱动的通用表单渲染器**（三份一致，采纳）：只加下拉与上传两种控件。契约 B + 无底洞。

### 5.5 答完做什么：`fulfillment`

**新增** `ts/src/onto/gap_answer.ts` 的 `applyGapAnswer(oir, question, answer)`，按 gapClass 分派：

| gapClass | 副作用 |
|---|---|
| NEED_VALUE_DOMAIN | `property.valueDomain` / `object.lifecycleStates` / `event.delivery` = `byUser(...)` |
| NEED_OWNER | `rule.actor` / `object.owner` / `action.actor` = `byUser(...)`，新角色注册进 RoleRegistry |
| NEED_DEFINITION | `definition` / `description` = `byUser(...)` |
| STRUCTURE(cardinality) | `link.cardinality` = `byUser(...)` |
| NEED_CONFIRMATION | 只置 `Status.CONFIRMED` |
| NEED_DECISION | 走现有 `applyDecision`（`clarify.ts:330-387`），不动 |
| NEED_MATERIAL / NEED_SAMPLE_DATA | 不直接改 OIR，推进 `MaterialRequest.status` |

**必须走 `routes/questions.ts:673-880` 的正规链**（repo claim → 副作用 → finalize → transition → Revision）。**不用 `questions.ts:1195-1236` 的 `answerQuestion`**——它在 `ts/src` 里零调用方，只有测试引用，没有仓储 claim、没有幂等、没有 Revision。A 提议"正好在这里第一次派上用场"，那会把回填闭环建在一个孤儿入口上。

### 5.6 UI：两个批量入口（契约 B 内，三份提案都漏了）

访谈后频次最高的两个动作，现有 UI 都是一次一条（`workbench.tsx:196-208` 一张卡一个 textarea 一次保存；`:186-195` 一张卡一个下拉）：

1. **"本次访谈回填"多行表单**：左列问题正文、右列答复框、一次提交。用现有表格样式，不需要重设计。
2. **"按对象/按材料批量指派 owner"**：`ownerlessRollup` 那条问题的答案控件，多选 + 一个角色下拉 + 应用。

没有这两个入口，前面所有分册、排序、停止准则的收益都会被录入摩擦吃掉。

同时修 `routes/questions.ts:483-487`：`questionUpdateOnce` 只读四个键，`ui/questions.ts:131-133` prompt 出来的延期原因 **100% 消失**。补收 `reason` → `metadata.defer_reason` → 进导出。

---

## 设计六：资料需求清单 + Excel 定向回填

### 6.1 `MaterialRequest`（推翻 `ASK_MATERIAL` 的无按钮卡）

**新增** `ts/src/onto/rfi.ts`（rid 前缀 `mr_`）：

```ts
interface MaterialRequest {
  rid: string;                       // mr_ + sha256(gapClass|targetCells 排序)[:12]，幂等
  title: string; whyNeeded: string;
  expectedShape: Column[];
  coversQuestions: string[];
  targetCells: string[];             // 收到能点亮哪些格 = 回填的写入白名单
  audienceRole: string; ownerUserId: string;
  status: QuestionStatus;            // 复用 questions.ts:310-342 的状态机
  bindKey: string;                   // sha256(rid + expectedShape 规范化)[:16]
  evidence: Provenance[];
  fulfilledBy: {fileId, fileName, uploadedAt}[];
}
```

**`expectedShape` 的列名直接取材料里的原始列名**（`ColumnProfile.header`）——这是全部三份提案里最锋利的一条可用性判断。业务方拿到一张列头是他自己写的表，填写率和拿到"PropertyType / baseType / valueDomain"差一个量级。列的来源是"我们缺的是哪些 Assertion"反推，**绝不写"供应商主数据通常包含 编码/名称/税号"**。

**推翻** `suggest.ts:82` 的 `ASK_MATERIAL`：它的唯一动作变成"生成一条 MaterialRequest"，卡上加按钮，走 `applySuggestion`（`suggest.ts:509-581`）的正常分支。

### 6.2 两份产物 + 一个会议包

**`资料需求清单.xlsx`**——列用 `template.ts:808-851` 的 `Q_COLUMNS` 过滤范式（仓里唯一真正兑现契约 A 的实现）：

```ts
const RFI_COLUMNS: readonly [string, (r: MaterialRequest) => unknown][] = [
  ["需要什么", r => r.title], ["为什么需要", r => r.whyNeeded],
  ["需要哪些列", r => r.expectedShape.map(c => c.name).join("、")],
  ["能回答的问题", r => r.coversQuestions.length ? `${r.coversQuestions.length} 条` : ""],
  ["谁能提供", r => r.audienceRole],
  ["材料出处", r => r.evidence[0] ? cite(r.evidence[0]) : ""],
  ["预计给出时间", () => ""], ["状态", r => r.status],
];
const RFI_REQUIRED = new Set(["需要什么","为什么需要","预计给出时间"]);
```

第二部分：每条 request 一张**带隐藏锚点的空白回填 sheet**，列 = `expectedShape`，前两列 `_rfi_key`/`_rfi_hash`（形制对齐 `template.ts:69-70`，写入位置对齐 `:1100`）。

**`访谈提纲_{角色}.md`**——按 `audienceRole` 分册，每条问题末尾三个复选框：

```
### 1. <question.text>
   为什么问：<why>
   材料出处：<cite>          ← 可翻回原文
   参考答案：□ …  □ …  □ 其它 ______
   [ ] 已答   [ ] 转派给 ______   [ ] 需要材料 → 转 RFI-03
```

三个复选框精确对应会议现场只会发生的三种结局，直接映射到设计五的三条副作用路径。

**会议包 zip**（采纳 A §6.2）：`GET /api/sessions/:sid/meeting-kit?role=<roleId>` → `访谈提纲_<角色>.md` + `资料需求清单_<角色>.xlsx` + `请确认_<角色>.xlsx`（NEED_CONFIRMATION）+ 按角色过滤泳道的 `流程图_<角色>.svg` + `会议纪要模板.md`。一次下载拿全。

### 6.3 `问题清单` 的定位推翻

`routes/questions.ts:339-351` 的 10 列表头写死、**没有"答复"列、没有回读锚点**——业务方填了没有任何路由能读回来。它现在被当问卷发出去是在浪费客户的时间。

- `问题清单.{json,md,xlsx}` 明确定位为 **FDE 内部状态报表**（保留），修 `:367-378` 与 `:384/412` 的排序自相矛盾（json 用排序后 rows、md/xlsx 用插入序，编号对不上），统一到 `nextBatch` 的排序键。
- 发给业务方的是 `访谈提纲_{角色}.md` + `模板_v1.xlsx` 的 `02_待澄清问题` + `资料需求清单.xlsx`。
- **改造** `routes/questions.ts:1044-1048` 的 `EXPORT_NAMES`：路由接 `?role=&gapClass=&owner=&status=`。
- **改造** `workbench.tsx:76-77` 的 DeliverBar 正则（现在匹配不到 `模板_v1.xlsx`——最该给业务方的那份产物不在交付条里），加 `模板|资料需求|访谈提纲`。

### 6.4 定向回填：**双路径**（裁决 C vs B）

C 的单锚点路径在第二个客户身上就会失效——真实项目里业务方回传的九成是他自己那张表（会另存、会删列、会加表头行）。**必须两条路都有。**

**新增路由** `ts/src/server/routes/rfi.ts`：`POST /api/sessions/:sid/rfi/:mrId/fulfill?apply=false|true`（两阶段形制照抄 `routes/artifacts.ts:553-571` 那条已跑通的 audit）。

**路径 A（默认）——有锚点走锚点**：`readReturned`（`audit.ts:358`）→ 校 `_rfi_key == mr.bindKey`，不符 422。

**路径 B（兜底）——无锚点走确定性列绑定**（采纳 B §9.2）：**新增** `bindColumns(upload, request, oir, profiles): ColumnBinding[]`，零模型：
- 用 `shape.ts` 的 `classifyColumns` 给上传件画像
- 列名归一（复用 `ids.ts` 的 `slug`）+ 值域与已有 profile 的重叠度 + 语义类型比对
- 每条 binding 带 confidence，低于阈值**必须 FDE 在 `apply=false` 预览页确认**

**共同的第三段——`targetCells` 白名单**：`applyRequestFill` **只允许写 `request.targetCells` 里列出的格子**，`byUser(value, "RFI-xx 回填（<owner>）")`，conf 0.95。范围外的一律进 `dropped` 并**显式列在预览页给 FDE 看，不许静默丢**。

> 这一条直接来自 `audit.ts:760-772` 的教训：**627 格被判为真正填写，最后只有 172 条落回 OIR**，455 格被读进来、算进完成度、然后静默丢弃。解法不是把兜底分支写全，而是事先声明写入范围。

**不能复用 `mergeIntoOir`**（`audit.ts:772-885`）：它按 `WRITEBACK_FIELDS`（`template_edit.ts:54-66`）11 个固定 field 名 switch，只能改**已存在实体的已知字段**，不能新建 `PropertyType`。

### 6.5 为什么不是重跑，以及回填后问题真的关掉

**不重跑的四条硬理由**：`routes/files.ts:106` 会 409；重付 17 次；`run.ts:568` 的"同 rid 保留旧问题"让答过的问题不会关闭；人的决策会被冲掉。

**落地机制**：文件落 `s.dir/fills/<mrId>/`，**不进 `materials`** → `preparse` 不扫 → 不触发 `runPipeline`，零模型调用。同时以 `tags: ["fill", mrId]` 加进 `EvidenceIndex`（`evidence.ts:363` 逐 chunk `add`），供 3.5 的 `recheck` 把 unfounded 断言批量转绿。落地后调 `deps.recompile(s, {preserveQuestionRows:true})`——**现有路径**（`routes/questions.ts:859-863` 已这么用）。

**关问题走 Decision，不改 `preserveLifecycle`**（裁决：A 与 B 都要改 `questions.ts:1015-1027` 的合并语义并重录 `ts/test/onto.questions.test.ts:595-614`，且会让"重跑挖掘合法地重开一个问题"这条正确行为失效）：

回填成功后，对 `mr.coversQuestions` 逐条调 `answerDomainQuestionOnce`（`routes/questions.ts:673-880`），`answer = {fileId, fileName, digest, sheet}`（匹配 5.4 的 `material` schema），`idempotencyKey = sha256(mrId + fileDigest + qid)`。

**状态由 Decision 决定**，`preserveLifecycle` 保留旧 status 时保留的就是 ANSWERED。零 golden 变更，还白捡完整审计链（幂等 `questions.ts:954-975`、失败可审计 `routes/questions.ts:808-817`、Revision + `invalidatedArtifacts` `:835-855`）。

### 6.6 HITL 请求体接线

`InterviewHandler.humanRequest`（`engagement_runtime.ts:576-588`）产出的 `{contract:"QuestionBacklog", action:"answer_questions"}` 在整个 `ts/src/ui/` 里**零引用**；而 `engagementView`（`routes/sessions.ts:363-382`）按 `s.status` 硬映射进度节点、不读 journal。

**改造**：`humanRequest` 扩展成 `{questions, materialRequests, coverage}`，UI 接成"当前卡在这里，需要这 N 个答案 + 这 M 份材料"。比一个猜出来的进度条有用一个量级。

---

## 设计七：停止准则

### 7.1 三层

**层一：单条该不该问。**

保留 `clarify.ts:231-239` 的乘法结构与从左到右求值（`:230` 注释明说不许改括号），**新增乘子 `answerability` 但只作用在 gapClass 分桶排序上，不进 `clarify` 的 score 公式**——这样 `golden/onto.clarify.json` 的 factors 不受影响（裁决评审三：避免动 golden）：

```
answerability = 命中真实角色 1.0 / 落到 FDE 0.7 / 无人可问 0.3
```

理由已经在仓里被记录过一次：`template_edit.ts:70-73` 的 `REQUIRED_BLOCKLIST` 注释——172 行全空、只有 FDE 答得了、独占完成度权重 58%。

**改造** `clarify.ts:158`：`thetaAsk` 从构造函数默认（**现在无任何配置能改**，`pipeline.ts:1544-1545` 只传 maxQuestions）提到 `finish()` 参数。首轮 0.25、回填轮 0.45。现状 0.35 意味着 `blast < 3` 的 ask_user 冲突结构性地永远问不出来。

**层二：单轮发多少。**

**每角色每轮 ≤ 12 条，其中 blocking ≤ 4。**（采纳 C，**推翻 B 的 `clamp(ceil(openCells×0.15), 5, 25)`**——cells 数随实体数线性增长，任何真实材料的 openCells 都远超 167，clamp 天天顶上界，形式自适应实际恒等于 25。25 条一场会过不完，后 13 条要么草草带过要么下次重问，而"重问"在客户那里的代价是信任。)

12 的依据：60 分钟访谈，一条口径问题平均 3-5 分钟（要翻材料、要举例、要确认）。

**层内提前截断**（采纳 B 第二层）：按 `informationGain × log1p(blastRadius)` 累加，下一条期望点亮格数 < 1 时提前停，不必凑满 12。

`nextBatch`（`questions.ts:1055-1099`）传 `audienceRole` + `limit=12` 直接生成分册提纲。

**层三：整体够不够。**

```
1. blockingClosure == 1.0
2. groundedRatio >= θ，  θ = 0.6 + 0.2 × min(1, materialCoverage)
3. 无 priority=blocking 且未 fulfilled 的 MaterialRequest
   或  marginalGain < ε（上一轮回填后覆盖度增量）
```

**采纳 B 的自适应 θ，推翻 A 的固定 `typeCoverage ≥ 0.85`**：A 那个硬门槛分母是全部 hard 槽位，槽位一多永远够不到，FDE 会卡在"blocking 全关了还是不让交付"而且看不出差在哪。B 的写法承认"材料本来就少，卡死没意义"。

θ 公式里的 0.6/0.2/ε 是**策略阈值**，允许是常量，但必须是一处具名配置并写进 manifest 的 `thresholds` 块。

**接线**：`engagement.ts:135-147` 的 REVIEW gate `require` 加 `coverage_sufficient == true`；`ReviewHandler.project`（`engagement_runtime.ts:636-690`）的 blockers 来源加 `COVERAGE_INSUFFICIENT`。

### 7.2 分级阻断（采纳 C §8）

| gapClass | 阻断 | 阻断什么 |
|---|---|---|
| NEED_MATERIAL（`noFieldSpec` 覆盖 ≥ 本语料分位数） | 是 | `data-objects.json`、`模板_v1.xlsx` |
| NEED_DECISION / NEED_DEFINITION 且 blastRadius 高于本语料分位数 | 是 | `ontology.package.json` |
| NEED_VALUE_DOMAIN / NEED_SAMPLE_DATA / NEED_OWNER / NEED_CONFIRMATION | **否** | 进模板必填项，`releaseState = DRAFT` |

**DOMAIN/SAMPLE/OWNER 不阻断是有意的**：交一个盖 DRAFT 戳的完整包，比卡在那里等业务方补齐取值域有用得多——FDE 可以拿着 DRAFT 包去做下一轮讨论，而讨论本身就是补齐取值域的最快路径。业务方对着一个具体的包能说出话来，对着一份问题清单说不出话来。

**收口 `blockedArtifacts` 的语义分裂**：同一字段名在 Question 层是**文件名**、在 Package 层（`canonical.ts:1157-1172`）是**语义实体 id**（文件名被 `filter(r => pyInSet(r, knownSemantics))` 一律丢掉）。拆成 `blockedArtifacts: string[]`（文件名）+ `blockedEntities: string[]`（rid），`canonical` 只吃后者。

同时给 Gap 补 `blockedArtifacts`——现在 `gaps.ts` 全文没有这个字段，**阻断能力事实上只由冲突驱动**（`questions.ts:1152` 对 clarification 无条件 BLOCKING）。

### 7.3 EXPORT 门语义修复

现状 `downloadable` 唯一来源是 `os.access(s.dir, W_OK)`（`glue/engagement.ts:154`、`:227-234`），而 EXPORT 门在**任何交付文件写盘之前**通过（真正写盘在 `run.ts:747` 的 `deps.compile`，`engagement_runtime.ts:702` 自陈）。`schema_valid` 是死代码（CANONICALIZE 校验失败先抛 `NodeFailure`，`:617-624`）。`EXPECTED_ARTIFACTS`（`:46-56`）9 项与实际写盘的 20 多个文件对不上，**没有任何代码检查它们是否存在于磁盘**。

**改造**：EXPORT 拆两段——`export.stage`（写盘，无门）→ `export.verify`（对派生自实际 views map 的清单逐个 `statSync` + 非空检查，带门）。`params.formats`（`engagement.ts:164`，现在被 `ExportHandler` 原样回吐、无人读）要么接线要么删——留着是骗人的。

### 7.4 契约 A 的判别标准（写进 CONTRIBUTING）

> **元模型可以写死，域模型不能。**

- **元模型（写死正当）**：`OIR_BUCKETS`、`SlotSpec`、`GapClass` 九类、`GroundingLevel` 五档、`Cardinality` 四值、`RefRole` 八值、`TriggerSpec.kind` 六值、`Effect.verb` 五值。这些是建模语言的语法，与材料属于哪个域无关。
- **域模型（写死即违约）**：业务对象分类词表、角色名清单、模板列头、`expectedShape` 的期望列、流程节点短码、事件名后缀。
- **判据阈值（第三类，词表 grep 抓不到）**：一律本语料分位数，生效值进 manifest。

---

## 实施路线

每一步独立可 merge、独立产生价值。验证手段：单测 / 变异测试 / EvalOps 真跑（语义门槛 + pass^k + 成本）。

### Step 0 — 必炸修复 + 桶收口（零行为变化）

**改造**：`pipeline.ts:1304`（补 `links`）、`pipeline.ts:1236-1240`（`YIELD_CN` 从枚举派生）、**新增** `ts/src/onto/buckets.ts`、**改造** 1.1 表里全部 17 处硬编码列举（`oir_edit.ts:878-883` 优先）、`oir.ts` 加 `$schema` 与未知版本显式抛错、修 `oir.ts:939-941`/`:904-906`/`:464-466`。**删除**死模板 `ui/questions.ts:179-269`/`:294-309`/`ui/returnaudit.ts:65-105`（`#pbody` 已归 React，`preview.tsx:365`）。

**怎么知道做对了**
- 单测：给 `OIR` 塞一个测试用的第七桶，跑 `toDict→fromDict→applyOirEdit→toDict`，桶必须还在。这条测试在改 `refill` 之前必须红。
- 变异测试：从 `BUCKET_SPECS` 删掉任一桶 → 至少一条测试红（证明收口点真的被覆盖）；把 `outstanding` 的 `links` 参数删回去 → `CoverageCritic` 测试红。
- EvalOps 真跑：现有采购语料端到端，调用次数应仍为 17，成本与基线一致（`golden` 不变）。

### Step 1 — 契约 A 执法机器先上线（**顺序上移，这是本设计对三份提案的最大修正**）

三份提案都把契约 A 清算排在最后（A 第 8 步、B 的 P5、C 的 Step 7）——那意味着 Event/Workflow/MaterialRequest/expectedShape 全部在无人看守的情况下写完，再回头证明它们守法。**顺序反了。**

**新增 fixture 两份**（不用医疗：医疗诊疗与采购**结构同构**——单据+状态+审批链+具名角色+中文编号流程文档，只换名词，能证伪词表但证伪不了体裁假设与规模假设）：
- **制造 MES**：设备台账 + 工艺路线 + 量测数据导出 + PLC 点表。无编号流程说明书、无审批链、无具名岗位、状态由传感器区间推出、主数据 30 行而事实表 10⁶ 行。专打体裁假设。
- **零售**：SKU 主数据 10⁵ 行 + 促销规则 + 门店清单。专打行数阈值。

**新增** `ts/test/onto.crossdomain.test.ts`，断言：
1. 三域产出的 `模板_v1.xlsx` 列集合两两不同；
2. `pkg.roles` 两两交集为空且都非空；
3. `资料需求清单.xlsx` 的列数两两不同；
4. **反作弊（采纳 A §10 第 4 条）**：三域的 `typeCoverage` 都 > 0.6——没有它，一个什么都不抽的实现能通过前三条；
5. **抓 `DOMAIN_CODES`**：三域的流程节点编号命中内置表的比例之差 < 20%；
6. 三域的 `dataKind` 分布不同，且 `unknown` 占比在 MES/零售上不高于采购的 2 倍（弃权可以，但不能全弃权）。

**同步清算**：`flow.ts:316-329`、`flow_extract.ts:317-325`、`flow_extract.ts:163-168`、`canonical.ts:769-772`、`engagement_runtime.ts:862-872`、`workbench.tsx:57`（见 4.5 与 5.1）。**明确不做** C 的行数阈值分类器与它的两条测试（`classificationConfidence` 中位数 > 0.5 奖励自信的错误；6 桶分类上的 KL 散度 > 0.3 是噪声）。

**怎么知道做对了**
- 测试在采购 fixture 上绿，在 MES/零售 fixture 上三条断言成立。
- 变异测试：把 `dataKind` 改回词表版本 → 断言 6 红；把 `DOMAIN_CODES` 加回去 → 断言 5 红；把 `eventName` 的"已生成"加回去 → MES fixture 的事件名断言红。
- 这一步**不产生任何新功能**，但它之后每一步都在看守下写。

### Step 2 — 排序链 + `dependents` 真图 + `RefLedger`

**改造** `oir.ts:700-714`（补五个键）、`oir.ts:788-810`（真图遍历）、`gaps.ts:162`（rid 改主体+槽位）、`routes/questions.ts:367-436`（三格式排序统一）、`routes/questions.ts:483-487`（收 `defer_reason`）、`workbench.tsx:76-77`（DeliverBar 正则）。**新增** `ts/src/onto/ref_ledger.ts`。

**怎么知道做对了**
- 单测：构造两条 weight 不同的 gap，`nextBatch` 顺序必须与 weight 一致（现在与 id 码点序一致）。
- 变异测试：把 `informationGain` 写回 0 → 顺序测试红。
- 只重录 `golden/onto.clarify.json` 一个文件（`dependents` 只有两个调用方：`clarify.ts:272`、`glue/tools.ts:453`），diff 逐条说明 blast 变化。

### Step 3 — 类型系统落地

**新增** `ts/src/onto/events.ts`、`ts/src/onto/workflows.ts`。**改造** `oir.ts`（Action 加 actor/trigger/conflicts、effects 原地升级、Object 加 lifecycleStates、Link 四改）、`canonical.ts:1029-1062`（读 actor/trigger/effects）、`canonical.ts:1292-1309`（events 从 OIR 来 + 撞 id 合并）、`canonical.ts:1367`+`:1571-1588`（workflows canonical id 化 + 补校验）、`gaps.ts:538`（选项从枚举生成）。

**怎么知道做对了**
- 单测：一条 `Effect{object: "ot_不存在"}` 让 `validatePackage` 报 error——**这是 `canonical.ts:1622-1626` 从未执行过的那段校验第一次跑起来**，测试必须证明它确实执行（而不是因为 `isMapping` 为 false 被跳过）。
- 单测：一个 workflow 的 step 指向不存在的 action → `validatePackage` 红。
- 重录 `golden/oir.json`、`golden/pipeline.oir.json`，diff 逐条说明（新增两桶、Action 三字段、Link 四字段、`$schema`）。**在同一个 commit 里重录，不许分批**——分批会让"哪些红是预期的"在两周后无人答得上来。
- EvalOps：成本不变（这一步不加模型调用）。

### Step 4 — L2.5 三节点

**新增** `ts/src/onto/weave.ts`（TRIGGER + WEAVE，确定性）、`ts/src/onto/state_mine.ts`、`agents.ts` 加 `state_miner` + `STATE_MINER_SCHEMA`。**改造** `pipeline.ts:1421-1443`（DAG 追加三节点，`EXTRACT`/`MERGE` id 不动）、`harness.ts:62-66`（工具目录）、`pipeline.ts:1484` + `agents.ts:775`（技能断链）。

**怎么知道做对了**
- TRIGGER / WEAVE 是确定性 → 直接钉 golden：给定 FlowGraph + OIR，输出必须逐字节一致。
- STATE 走 **EvalOps 真跑**：
  - **语义门槛**：抽出的每条 EventType 必须 (a) 带至少一条 Provenance，(b) `producerAction` 指向 MERGE 后已存在的 rid，(c) `fromState`/`toState` 落在宿主对象的 `lifecycleStates` 或产出对应的 NEED_VALUE_DOMAIN 缺口。三条全过才算 pass。
  - **pass^k**：k=5，门槛 4/5。
  - **成本上限**：单次 STATE ≤ 8 次调用，端到端 ≤ 25 次；超了 CI 红。
- 一次性指纹断代：重录两个中断态会话的 journal，commit message 写明"system 加入工具目录导致的断代"。

### Step 5 — COVERAGE + 缺口类型学

**新增** `ts/src/onto/coverage.ts`、`ts/src/onto/grounding.ts`、`ts/src/onto/promote.ts`、`ts/src/onto/parse/profile_material.ts`。**改造** `gaps.ts`（GapClass 归类 + `slotRefs` + `aggregate` + 新增 10 个手写探测器 + 修 `:338-339`）、`engagement_runtime.ts:882-911`（traceability 产 rollup 缺口 + DRAFT）、`routes/files.ts:70`（删材料后的证据降级）。

**怎么知道做对了**
- 单测：每个探测器一个最小 fixture，断言产出条数与文案。
- **rollup 回归测试**：`object_no_description` 在 20 个无说明对象上必须产 **1 条**不是 20 条；`ownerlessRollup` 同理。变异测试：把 `aggregate` 改成 `per_instance` → 条数断言红。
- **禁用词门**：面向业务方的全部文案模板过 4.2 的 grep，必须为空。
- 覆盖度在采购 fixture 上的基线值进 golden；`thresholds` 块必须出现在 `ontology.package.json`。
- 变异测试：把某个探测器的分位数换成字面量 → 跨域测试的某条断言红（证明分位数不是摆设）。

### Step 6 — 问题对象与提问协议

**新增** `ts/src/onto/roles.ts`、`ts/src/onto/gap_answer.ts`、`GET /api/sessions/:sid/roles`。**改造** `questions.ts:1504-1514`（`material` 类型）、`questions.ts:651-662`（按 gapClass 生成 schema）、`routes/questions.ts:783-807`（加 `applyGapAnswer` 分支）、`workbench.tsx`（下拉选项来源、`NextBatch` 可展开、两个批量入口）。

**怎么知道做对了**
- 端到端单测：回答一条 NEED_VALUE_DOMAIN → `oir.properties[x].valueDomain.origin === "user"` 且 `confidence === 0.98`；覆盖度对应格从 missing 变 confirmed。
- 单测：`material` 类型的答案通过校验，普通字符串被拒（防 `TYPE_CHECKS.get(k) ?? (()=>true)` 放行）。
- 变异测试：把 `applyGapAnswer` 的某个分支删掉 → 对应的"答完格子变绿"测试红。
- 跨域测试第 2 条（roles 交集为空）此时才真正有数据可断。

### Step 7 — 资料需求清单 + 定向回填

**新增** `ts/src/onto/rfi.ts`、`ts/src/server/routes/rfi.ts`、`ts/src/server/glue/rfi.ts`、`ts/src/ui/react/rfi.tsx`。**改造** `suggest.ts:509-581`（ASK_MATERIAL 走正常分支）、`routes/questions.ts:1044-1048`（分册导出）、`engagement_runtime.ts:576-588`（humanRequest 扩展）。

**怎么知道做对了**
- 单测：锚点不符 → 422；`targetCells` 白名单外的格 → 进 `dropped` 且 OIR 未被写。
- **变异测试**：去掉白名单校验 → "越界写入必须被拒"测试红。这条最重要，它防的是 `audit.ts:760-772` 那个 627→172 黑洞的重演。
- 真跑一次"业务方另存 + 删两列 + 加一行表头"的样本，`bindColumns` 必须给出低置信绑定并要求 FDE 确认（不是静默绑定，也不是直接失败）。
- 端到端：回填 → `mr.coversQuestions` 全部 `status === "answered"` 且各有一条 Decision；重复提交同一份文件 → 幂等回放，不产生第二条 Decision。
- 成本断言：整条回填链 **0 次模型调用**。

### Step 8 — 停止准则 + EXPORT 门 + 会议包

**改造** `clarify.ts:158`（thetaAsk 可配）、`engagement.ts:135-147`/`:148-167`（REVIEW 加 coverage_sufficient、EXPORT 拆两段）、`engagement_runtime.ts:705-724`（downloadable 真 stat）、`canonical.ts:1157-1172` + `questions.ts`（blockedArtifacts/blockedEntities 拆分）。**新增** `GET /meeting-kit`。

**怎么知道做对了**
- 注入用例：门通过后删掉一个产物文件 → `export.verify` 必须红（现在的 `downloadable` 永远绿）。
- 单测：`blockingClosure < 1` 时 REVIEW 门红；DOMAIN/SAMPLE/OWNER 全开时门绿且 `releaseState === "DRAFT"`。
- 变异测试：把 θ 改回固定 0.85 → 在材料稀疏的 MES fixture 上"应能交付 DRAFT"的测试红。
- EvalOps：三个域各跑一遍全链路，记录停止时的轮次、问题总数、覆盖度、成本，进基线。

---

## 风险与取舍：我们放弃了什么

| 放弃 | 换来 | 理由 |
|---|---|---|
| **Event 在段内抽** | +6~8 次调用而不是 +N 段；fan-out 基数、`forNode` 契约、冻结边界全不动 | 只在单份材料出现且未被合流保留的状态词会漏。可接受——冻结边界内不许有内容语义判据是硬规则 |
| **`flow.Workflow` 与 `WorkflowType` 合并** | `flow_bpmn` 导入路径与 `buildFlowDiagram` 零模型保证不变复杂 | 概念重复。`flow.ts:273-277` 说清了它是图追踪单位 |
| **通用表单渲染器** | 只加下拉 + 上传两种控件 | 契约 B；`answerSchema` 支持递归但 UI 只用三种，是有意的欠拟合 |
| **`duplicate` 检测器** | 不做 | `conflict.ts:190` 声明了但全库无实现。**明确加注释标 dead policy**，好过留着让人以为它在工作 |
| **增量 coverage 重算** | 第一版全量跑（确定性、O(实体×slot)、毫秒级） | 过早优化一个便宜的纯函数。留 `dirtyRids` 参数位 |
| **gap 与 conflict 两条打分管线统一** | `clarify.ts` 公式与 golden 完全不动 | 排序键、名额、投影目标全不同。只在 `Question` 层合流 |
| **一次性指纹断代与 golden 重录** | 工具目录接通、类型系统原地升级、无双字段疤 | 已核实代价是两个中断态会话重跑；`golden/recorder.json` 钉的是 Recorder 自身指纹，无 golden 钉 extractor prompt |
| **`DOMAIN_CODES` 在采购语料上的人工校准编号** | 编号由 `(语料指纹, 名称)` 纯函数生成，跨域对称 | 采购语料失去手调短码。不对称降级比不好看更贵 |
| **非中文编号式材料的流程图** | `flow_extract` 体裁假设显式化，命中率为 0 时产 NEED_MATERIAL 缺口而不是静默出空图 | MES 语料不会有流程图。诚实的空 + 一条"没有可识别的流程说明材料"，好过一张假的空图 |
| **`dataKind` 在非命中时给出分类** | 弃权 `["unknown", 0.0]` → NEED_CONFIRMATION | 高置信度的错分类比明示不知道更贵 |
| **首轮零 OWNER 问题** | 一条 rollup 分工问题 + 批量指派入口 | routeAudience 拒绝推断是契约 A 的底线；rollup + 批量入口把代价压到一次点击 |

---

## 被否决的方案及理由

**来自 A：**

1. **`appliesTo` 保留为 getter 的兼容垫片。** 实体是 plain interface + 对象字面量工厂（`oir.ts:458`/`:550`），而 `applyOirEdit`（`oir_edit.ts:858-885`）每次编辑做完整 JSON 往返——getter 要么逼你把所有 interface 改成 class，要么用 `defineProperty`（往返一次就没了，和 `titleProperty` 现在丢失的机制一模一样）。垫片在它自己点名的那条路径上静默失效，而它是 A 用来避免"12 处全线分叉"的全部依据。→ 改 `RefLedger` 旁挂表。
2. **`EXTRACT → EXTRACT_S` 改名 + 挪 `freezeBefore` 锚点。** `Scheduler.run` 按节点 id 恢复（`scheduler.ts:537-548`），改名让所有中断态 run 的抽取节点重跑重付；保留 `EXTRACT`、只追加节点可零成本达成同样分层。
3. **`shape.hasTriggerLikeColumn()`。** 不存在也建不出来——`shape.ts` 里 `TYPE_NAME_RE`(`:246`)/`BOOL_WORDS`(`:263`) 都注明词表只作辅助，判"条件/触发/时机"必须新引中文表头词表。而它决定 fan-out 基数，等于把词表塞进冻结边界内侧，同时违反 A 自己第十节写的契约 A。
4. **`mineTypeHoles` 作为问题正文的生产者。** 数量爆炸（8 桶 × 10+ slot × N 实例，全篇无聚合规则，而 `gaps.ts:545-546`/`:502-509` 已经写对了聚合）+ 措辞退化（槽位名就是 `primaryKey`/`cardinality` 这些行话）。→ SlotSpec 只作内部表示，探测器手写。
5. **固定 `typeCoverage >= 0.85` 硬门。** 分母是全部 hard 槽位，槽位一多永远够不到，FDE 卡在"blocking 全关了还是不让交付"且看不出差在哪。
6. **全部字面阈值**（`distinct/total < 0.05`、`distinct ≤ 30`、`behaviorSegs` filter）。在采购语料上调出来的魔数，20 行的低基数表直接漏判；词表能 grep，阈值不能。
7. **在 `TriggerSpec` 里把 `temporal` 限成 cron、`threshold` 限成 `{prop, op, value}`。** "出院后 30 天内随访""库存 < 安全库存×1.2"表达不了。→ 自由表达式 + 证据。

**来自 B：**

8. **`s0_0.extract` / `s0_0.events` 多 handler 分片。** `Dag.expand` 产出 `${base}.${sfx}`，`SegmentRouter.forNode`（`pipeline.ts:1497-1507`）取 `split(".")` 最后一段当段 key → key 落成 `"events"` 直接进 KeyError；且 `NodeHandler.forNode` 签名是一节点一 handler，返回列表无处可接。按字面写法编不过也跑不通。
9. **`Yield.EVENTS` 的"值形如状态词"。** 没有非词表实现；坐在 fan-out expand 路径上——**漏判不报错、不产缺口、不花钱，一个 pass 从来没跑过是不可观测的**。这是三份提案里最危险的一处违约。→ 状态值域只由人回答 NEED_VALUE_DOMAIN 后写入（origin=USER）。
10. **`EvidenceLedger` + `Provenance → chunk_id` 反查表。** `Provenance` 只有 `fileId + locator`，locator 形状按解析器各不相同，B 假定它是全域单射键却不给退化处理，而整条"材料轴"挂在上面。→ 改用 `containerOf(locator)`（`gaps.ts:234-240`，仓里已实现两次）做容器级归属。
11. **`askBudget = clamp(ceil(openCells × 0.15), 5, 25)`。** 任何真实材料的 openCells 都远超 167，clamp 天天顶上界，形式自适应实际恒等于 25。
12. **五档 grounding 直接做 UI 色标。** `corroborated` 与 `inferred_cited` 的区别 FDE 不会用来做任何决定。→ 内部五档、UI 三档。
13. **"格子"心智模型泄漏进业务方文本**（`『采购订单.供应商』这一格没有证据…挡住 1 个 Action`）。→ 禁用词 grep 门。
14. **同时"不改 EXTRACTOR_SCHEMA 保重放"与"改 harness system 塞 catalog"。** `llm.ts:882-893` 把 system 与 prompt 原文一起 fingerprint——后者破坏的正是前者花两个 agent 买来的东西。付了复杂度什么也没买到。→ 本设计承认断代便宜，两件事都做，一次性重录。

**来自 C：**

15. **`outcomes` / `effects` 双字段并存 + `outcomes ?? effects` 回落分支。** 买的是"Python 侧产物不被静默降级"，而 `src/ontocopilot` 下已无 `.py` 文件（只剩 `__pycache__` 空壳）。→ `effects` 原地升级。
16. **`dataKind` 的行数阈值分类器**（`master = 10²~10⁴`、`transaction ≥ 10⁴`）。把采购 ERP 的数据规模写死成"结构判据"：医院科室主数据 40 行落 transaction、零售 SKU 主数据 10⁶ 行也落 transaction；且 FDE 手上是 200 行 Excel 摘录不是生产库。比现状更坏。→ 弃权。
17. **`classificationConfidence` 中位数 > 0.5 的测试。** 奖励自信的错误——新分类器按构造必过。
18. **`need` 分布 KL 散度 > 0.3 的测试。** 6 桶分类、两个单一 fixture 上就是噪声，阈值最后必然被调到能过然后被删。
19. **回填只走锚点单路径**（锚点不符 422 打回）。业务方另存一次表或发来他自己的台账就走不通，FDE 只能退回 `POST /files` 全量重跑——正好回到 C 自己在 §7.1 列了四条硬理由否掉的那条路上。→ 加 `bindColumns` 兜底。
20. **`routeAudience` 推不出就逐条产 OWNER gap。** 全新项目里几乎每个对象、每条规则都推不出，首屏几十条"这块归谁管"，而现有 UI 一张卡一个下拉（`workbench.tsx:186-195`）。→ rollup 一条 + 批量指派入口。方向（拒绝硬编码兜底角色）保留。
21. **医疗诊疗作为唯一换域证明。** 与采购结构同构（单据+状态+审批链+具名角色+中文编号流程文档），只换名词，能证伪词表但证伪不了体裁假设与规模假设。→ 换 MES + 零售。

**三份共同的：**

22. **改 `preserveLifecycle` 的合并语义**（A 改"只保护人工态"、B 改"终态优先"）。都要重录 `ts/test/onto.questions.test.ts:595-614`，且都会让"重跑挖掘合法地重开一个问题"这条正确行为失效。→ 用 C 的绕过：逐条 `answerDomainQuestionOnce`，状态由 Decision 决定。
23. **用 `questions.ts:1195-1236` 的 `answerQuestion` 作为回填闭环入口。** 它在 `ts/src` 里零调用方，没有仓储 claim、没有幂等、没有 Revision。→ 走 `routes/questions.ts:673-880`。
24. **把 journal 重放当头号硬约束。** `runId` 由语料派生（`run.ts:319`）、只有 2 个会话有真实 `llm.call` 日志、无 golden 钉 extractor prompt 原文。省下的复杂度预算全部投进类型系统的一次性原地升级。
25. **把契约 A 的清算排在最后一步**（A 第 8 步、B 的 P5、C 的 Step 7）。那意味着新类型全部在无人看守下写完再回头证明守法。→ 执法机器（Step 1）先上，新类型（Step 3 起）后上。