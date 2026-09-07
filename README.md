# OntoCopilot

面向 AI FDE 工程师的本体建模副驾。把异构业务材料（Excel 梳理表、OpenAPI、Word 流程说明、DDL、BPMN、PPT、扫描件、CSV）变成可被下游软件直接消费的 Ontology 数据包。

**整个仓库是 TypeScript。** 早期的 Python 实现（`src/ontocopilot/`）已在 `59346fa` 整树删除，运行时不含任何 Python 依赖、不起 sidecar、不做进程桥接。磁盘上残留的 `src/ontocopilot/**/__pycache__/*.pyc`、`tests/__pycache__/`、`.venv/` 都是未入库的垃圾 —— 它们已经骗过一次审计，所以 `.gitignore` 里专门写了一段警告。真正的代码在 `ts/src/`：296 个 `.ts/.tsx`，228 个测试文件、7664 条用例。

源码里大量注释仍以 `移植自 xxx.py` 的形式引用那份已删除的 Python 原件。**那是移植出处，不是现存文件** —— 顺着它去找 `src/ontocopilot/onto/pipeline.py` 会一无所获，要看原件请用 `git show 6dd3115:src/ontocopilot/onto/pipeline.py`。

---

## 快速开始

没有根 `package.json`，所有 npm 脚本都在 `ts/` 下跑。Node ≥ 22（Node 26 已验证）。

```bash
cd ts && npm install
```

```bash
npm test          # vitest，7620 条
npm run check     # tsc --noEmit + 运行时定义目录校验
```

启动服务（前后端**是同一个进程**，TS 服务在 `/` 直接吐前端）：

```bash
./restart.sh            # 仓库根目录；端口取 .env 的 ONTOCOPILOT_PORT，没设时 3594
./restart.sh 3594       # 显式指定端口
./restart.sh status     # 只看状态，不动任何进程
```

`restart.sh` 值得用而不是 `npm start`：它**按端口收尸**而不是 `pkill node`（不会连你别的 Node 项目一起杀），只认**监听者**不误杀连着的客户端，等旧进程真的退干净才起新的（否则浏览器刷新看到的还是旧代码，一整轮验证等于在测几小时前的东西），并且启动前跑一次 `build:ui`（前端是构建产物，改了源码不重新构建页面上什么都不会变）。

⚠️ **端口取自 `.env`，而仓库里的 `.env` 写着 `ONTOCOPILOT_PORT=8765`** —— 那正是常驻 launchd 作业 `com.ontocopilot.dev.8765` 占着的口。不带参数跑 `./restart.sh` 会撞上它，脚本会**拦下来并告诉你怎么办**（那个作业是 keepalive 的：按端口 kill 掉会被立刻拉起，脚本随后「启动成功」，而你看到的还是它的旧 `dist`）。想自己起一台调试就显式给端口：`./restart.sh 3594`。

**没有 `/docs`。** 启动横幅里那行 `API http://host:port/docs` 是条死链 —— 那是 FastAPI 白送的自动文档，迁到 Hono 之后没人补，也没有 OpenAPI schema。

---

## 命令行

没有 `bin` 入口，`ontocopilot` 不是一个装得上的可执行文件。**从仓库根目录**跑（在 `ts/` 下跑会静默指向 `ts/workspace/ontocopilot.db` 而不是 `workspace/ontocopilot.db`）：

```bash
npx tsx ts/src/cli_main.ts <子命令>
```

`cli.ts` 是库，`cli_main.ts` 才是入口 —— 前者被测试 import，把自动执行写进去会导致一 import 就解析 argv、动数据库、退进程。

| 命令 | 状态 | 说明 |
|---|---|---|
| `doctor [--production]` | ✅ | 检查网关配置、三档模型连通性、异构评委路由、沙箱隔离等级、技能与 Agent 装载 |
| `parse <files…> [--dialect] [--json]` | ✅ | 只解析，看看读到了什么 |
| `audit <spec> <returned> [--target]` | ✅ | 审业务方回传的 xlsx |
| `useradd / passwd / role / users` | ✅ | 账号管理 |
| `build <files…>` | ❌ **未接线** | 见下 |

`audit` 的退出码是**三态**：0 达标 / 2 未达标 / 1 出错。别把 2 归到"错误" —— CI 里 `|| exit 1` 那种写法会把"需要再走一轮"和"程序崩了"混成一件事。`Ctrl-C` 退 130；argparse 层的用法错误走 stderr 并退 2，其余所有输出（含 `✗` 失败说明）走 stdout。

**`build` 为什么宁可红着。** 照旧实现直译一版很容易：解析 → 把语料截到 top-k → 一次大调用 → 对齐/冲突/澄清/模板。问题是那条路**在真实材料上已经失败过**：一份 326 切片的梳理表被截到 60 条，抽出 58 个对象、**0 属性 0 关系**。`onto/pipeline.ts` 就是为修它才存在的，而那条真流水线今天由 `serve.ts` 驱动，依赖 session/store/SSE 一整圈上下文。把它拆成脱离服务能跑的入口是一件正经工作，不是补一个函数体 —— 静默产出空模板比报错难查得多。要跑全流程请起服务。

---

## 代码结构

```
ts/src/
  kernel/                 L1 Harness 内核 —— 领域无关，换领域可整体复用
    events.ts             事件模型（27 种 EventKind）
    journal.ts            事件日志 + 内容寻址 blob 存储
    recorder.ts           ★ 持久化执行：effect 记账、确定性重放、HITL 挂起
    dag.ts                节点定义、fan-out 展开、拓扑校验、计划冻结
    scheduler.ts          流水线调度（并发 8）、崩溃恢复、降级广播
    loop.ts               Agent Loop 运行时（6 种模式）
    llm.ts                模型网关：难度路由、结构化输出、异构评委、成本记账
    catalog.ts            ★ 能力目录 + SmartGateway：按能力选型、失败切换、失败学习
    backends.ts           Anthropic 原生 + OpenAI 兼容网关
    budget.ts             四维预算（tokens/时长/工具调用/美元）+ 五级降级阶梯
    critic.ts             Critic Panel + Gate（6 种 Decision）
    tools.ts              工具注册表 + MCP 安全闸（投毒扫描 / 指纹锁定 / 作用域）
    sandbox.ts            ★ 子进程(开发) / gVisor / runc / kata-microVM
    skills.ts             Skills：渐进披露的操作规程
    agents.ts             具名 Agent：角色 + 档位 + 工具作用域 + 技能 + 评审视角
    otel.ts               事件流投影成 OTLP span 树（手写，不依赖 OTel SDK）
    memory/               四层记忆：types / short_term / evidence / long_term /
                          context / dialogue / project
    bus/                  黑板 + AgentBus（三条合法通路）
  onto/                   L2 领域层
    oir.ts                ★ Ontology 中间表示（Assertion 强制携带溯源）
    shape.ts              ★ 段形状推断：列取值分布 → 列角色 → 这段能产出什么
    pipeline.ts           ★ 跑在 Harness 上的主 DAG：切段 → fan-out 抽取 → 合并
    conflict.ts           8 类冲突的检测与处置（全确定性，零模型调用）
    clarify.ts            澄清引擎（EIG 排序，默认选 top-3）
    align.ts              实体对齐：阻塞 → 结构+名称打分 → 连通分量 → 代表选举
    suggest.ts            主动建议：规则推导，带依据/影响面/可执行动作
    template.ts           模板编译器：xlsx + 隐藏锚点列 + 样式即语义 + 内嵌校验
    audit.ts              回传审核器：锚点对齐、单元格 diff、加权完成度、打回单
    questions.ts          统一提问队列 / 回答台账 / 变更版本
    gaps.ts               缺口挖掘（四通道）→ 提问
    readiness.ts          六维就绪度评估
    triage.ts             问题分诊：哪些折叠成 lint，哪些必须单独决策
    canonical.ts          交付用的规范化数据包
    ontology_package.ts   Ontology Package v1（只读草稿视图）
    engagement.ts         ★ 冻结的 16 节点 FDE 交付工作流
    release_authority.ts  发布签字权限（复用 admin 角色，不另造一套）
    flow*.ts              ★ 业务流程图：抽取 / 编辑 / 链接本体 / 证据 / 演示
    diagram*.ts           mermaid + 手写自包含 SVG（ER 图、泳道图）
    export.ts             md / csv / xlsx / docx / pdf（xlsx 与 docx 手写 OOXML）
    parse/                ★ 九个解析器，见下
  document/               ★ 知识库（32 个文件）：版本化、ACL、BM25 检索、逐块引用
  server/                 ★ Hono 应用（67 个文件）
    routes/               18 个路由文件
    dialogue/             对话 + 63 个模型工具（另有 8 个 core 工具）
    pipeline/             DAG 构建、检查点、停止、分叉
    glue/                 21 个接缝文件（原 Python 那个 7051 行 server.py 的拆解）
  store/                  SQLite（默认）/ Postgres，36 张表，79 方法的 Repo 协议
  ui/                     ★ React 19 前端源码（65 个文件）
  cli.ts / serve.ts       命令行与服务装配
ts/catalog/               人工维护的运行时定义：18 技能 / 18 Agent / 71 工具 / 1 工作流
ts/test/                  228 个测试文件，7664 条用例
golden/                   85 份 golden fixture，钉住字节级行为（在仓库根，不在 ts/ 下）
migrations/               18 个 Postgres 迁移
ui/index.template.html    前端骨架（**这个是源码**）
ui/index.html             构建产物（**不要手改**）
```

`kernel/` 与 `onto/` 的边界是这套代码最重要的一条线：**内核完全不知道什么是 ObjectType**。守住它，换领域只需重写 `onto/`。

反过来那半句 —— 旧文档里写的"领域层完全不知道什么是 DAG 调度" —— **是假的**，而且一直是假的：`onto/pipeline.ts` 本来就是"跑在 Harness 上的主 DAG"，它和 `onto/engagement.ts`、`onto/engagement_runtime.ts` 都直接 import `kernel/dag.js`。这条边界是单向的，别把它写成双向。

---

## 记忆管理

**短期**（Run 之内）。`ContextManager` 按固定优先级装配 L0 → L3 → L1 → L2，证据拿走剩下的预算（有下限）。

| 层 | 容器 | 生命周期 | 装载策略 |
|---|---|---|---|
| L0 System | `ContextManager.system` | 常驻 | 全量（已压缩成规则表） |
| L1 Working | `WorkingSet` + `Scratchpad` | Run / 节点 | 全量；超预算先压 scratchpad |
| L2 Evidence | `EvidenceIndex` | 按需 | **检索式**：BM25 top-k + 邻域扩展 + token 预算截断 |
| L3 Reflection | `ContextManager.reflect()` | Run | 全量（体量小） |

溢出顺序：压 scratchpad → 裁上游长文本 → 削证据。**locator 永远不动** —— 压缩用正则把出现过的 `文件!位置` pin 住，一条不少。locator 丢了溯源就断了，而溯源是这个产品的信任基础。

L2 用 BM25 **而不是向量**，因为查询词是专有名词；`EvidenceIndex.search` 上留了 rerank 钩子，将来要加向量召回从那里进。

**长期**（跨 Run，项目作用域）。进长期库要过 `PromotionGate`，三选一：人确认过 / 扛过 N 轮 critic / 在 K 个不同 Run 里独立观察到。**没有 support 的一律拒**。

冲突不静默覆盖：同 key 不同内容 → 标 contested，两条都留，检索时一并给出。不用就衰减；`MemoryKind.DECISION` 免疫 —— 人拍板的是业务事实，不是系统的猜测。

---

## Agent 间通信

只有三条合法通路，**没有自由对话**：

| 通路 | 用于 | 实现 |
|---|---|---|
| **DAG 边** | 绝大多数通信 | `WorkingSet`，沿依赖流动（**不过总线**） |
| **黑板** | 很多节点都要、但不在直接路径上的事实 | `Blackboard`，append-only、带出处、冲突标 contested |
| **定向请求 / 广播** | Critic 要求 Actor 举证；调度器广播降级 | `AgentBus.request()` / `.broadcast()` |

三者都写事件日志，所以协作链路可重放、可审计、可在 UI 上展开。

**为什么这么克制。** 自由对话在 demo 里好看，在生产上同时坏掉三件事：消息顺序不确定 → 重放失效；上下文无界增长 → 成本失控；事后无法回答"谁认定了这件事" → 交付物不可辩护。对 FDE 场景第三条是致命的。

**冲突是信号，不是噪声。** 两个 agent 对同一 key 写了不同的值，恰恰就是「计划金额」双口径的机器形态。黑板不做 last-write-wins，而是保留全部变体、标记争议，交给 Critic 和澄清引擎处理。静默覆盖会让系统丢掉它唯一一次发现矛盾的机会。

---

## 持久化执行

`recorder.ts` 是两级的：整节点完成过就跳过（日志里有 `NODE_COMPLETED`），节点跑到一半崩了则重跑该节点、但**已完成的 effect 从日志读回**而不重新执行 —— 崩在第 47 轮就从 47 轮续，已经付过钱的模型调用不会付第二次。

effect 的键是 `(node_id, checkpoint_version, 节点内计数器)` 或调用方显式给的 key，**不是全局序号**：并行节点的全局顺序在两次运行之间不稳定，用全局序号会让重放直接失效。

几条踩出来的纪律：

* **权限敏感的 effect 用 `replay: "never"`** —— 审计事件照写，但结果绝不当授权凭证复用。否则 `document.search` 会把撤权之前的正文从日志里原样递回来。
* **跨尝试的指纹变化算 `EFFECT_SUPERSEDED`，不算 determinism violation**。2026-08-20 有过一次事故：网关 503 触发重试，而重试时提示词已合法演进，重放校验直接杀掉了一次 $4 的抽取。
* **计划冻结是安全边界**。`Dag.freeze()` 之后任何 add/expand 都抛 `FrozenPlanViolation`，`Scheduler` 拒收没冻结的 DAG。冻结发生在读任何材料**内容**之前，所以上传文档里的提示注入最多只能当节点输入，动不了拓扑、加不出出网能力。
* **fan-out 基数来自用户输入（上传了几个文件），不来自材料内容** —— 否则内容就能改变计划形状。
* **恢复对拓扑 fail-closed**：拓扑指纹和日志里的对不上就拒绝恢复。

---

## 材料解析

九个解析器，**注册顺序即优先级**（`.json` 归 OpenAPI 而不是兜底的文本解析器，靠的就是它排在前面）：

| 解析器 | 扩展名 | 说明 |
|---|---|---|
| Xlsx | `.xlsx .xlsm .xltx` | 表头探测（可返回"无表头"）、合并单元格还原、批注、列画像、元数据泄漏告警 |
| Csv | `.csv .tsv` | 编码猜测、大表采样 + 全量列画像 |
| Ddl | `.ddl .sql` | node-sql-parser AST + **三路行内注释还原**（口径全在注释里） |
| OpenApi | `.json .yaml .yml` | 写端点 → ActionType 草稿源；schemas → 对象候选 |
| Bpmn | `.bpmn` | 无损映射成流程图，优先级最高的流程来源 |
| Pptx | `.pptx .pptm .ppsx` | 形状 + 连接线 + 备注 |
| Docx | `.docx` | 标题面包屑分段（`H1 > H2 > H3`）、表格单独抽 |
| Vision | `.png .jpg .pdf` … | **真 OCR**，见下 |
| 兜底文本 | `.md .txt` … | 其余一律进这里，**不静默跳过** |

解析产出统一形状：带 locator 的 Chunk 流 + `structured` + 给人看的 `findings`。**每个 chunk 必须有 locator**，没有的不许进索引。

xlsx 解析是**手写的**（`node:zlib` 解 zip + 流式非 DOM 的 XML 扫描）；`exceljs` 只用来**写**。`ts/src/onto/parse/doc/` 里还有零依赖的 `xmlet.ts`（ElementTree 等价物）和 `ziplite.ts`。

**OCR 是真的，不是桩。** `VisionParser` 通过 `SmartGateway` 把页面图交给视觉模型，要求 `VISION` + `STRUCTURED` 双能力，输出 schema 强制三个数组：`blocks`（带归一化 bbox）、`tables`、**`relations`** —— ER 图里框与框之间的连线就是 LinkType，只出文字流等于什么都没读到，实测能读出 `1 : N` 这样的基数标注。

PDF 先走便宜路：读原生文本层，**每一页都有文字就零模型调用返回**；只有空白页才栅格化去 OCR。挑不出有视觉能力的模型时**不降级瞎猜**，而是报 `vision_failed` 并明说这份材料没进交付物。

---

## 抽取流水线

主 DAG 叫 `onto_extract`，`freezeBefore: "EXTRACT"`，声明期只有两个节点，展开后是每段一个 `EXTRACT.<segment>` 加一个 `MERGE`（依赖 `EXTRACT.*`，通配依赖即屏障）。

* **按 sheet / 章节切段，fan-out 成多个抽取节点**（`SEGMENT_CHUNKS = 45`）。每段上下文有界，段与段并行。
* **节点内是 agent loop，不是单次调用**（`plan_execute`，4 轮迭代，2 轮 critic，HIGH 档）。抽取节点能用 `evidence.search` 把切片捞回来、用 `profile.column` 查列画像，边看边抽。
* **Critic 拦住"看起来跑完了其实什么都没抽到"** —— 覆盖率视角把"有对象没属性"判成 HIGH，那正是之前静默失败的形态。
* **反思回灌**：critic 的意见进 L3，后续段不再犯同样的错。

DAG 跑完之后是一条**确定性尾巴** `finish()`：对齐 → 冲突检测 → 自动修 → 澄清排序 → 编译模板 → 建议 → 对齐缺口。

### 段形状：不写死"表里必有字段"

真实材料的一个 workbook 里能同时出现三种完全不同的表：一行一实体（无类型列）、一行一行动（多一列 url）、一行一段散文。用同一句"每行字段都要抽成 PropertyType"去套，后果是 critic 判"漏抽属性"、节点反复重试、预算烧穿 —— 而三张表里本来一个属性都没有。

`onto/shape.ts` 从**列的取值分布**推断（不认表名、不认关键字）：每列判 14 种角色之一，再由列角色推出这段能产出什么、其中哪些**规则就能定**。两个下游效果：critic 只对"这段应该有"的东西判缺失，假阳性消失；一行一实体这类映射完全确定的表**不进模型**，一行不丢，也不用为复述几百行付高档模型的钱。

样本不足 3 行时**拒绝下形状判断**。

### 冲突

8 类，全部由确定性代码检出（`conflict.ts` 里零 async、零网关引用）：

| 类别 | 处置 | 不可逆度 |
|---|---|---|
| `semantic_divergence` | 问人 | 1.0 |
| `duplicate` | 问人 | 0.8 |
| `missing_action` | 问人 | 0.7 |
| `type_mismatch` | 问人 | 0.6 |
| `orphan` | 提示 | 0.4 |
| `missing_required` | 打回模板 | 0.3 |
| `perfunctory` | 打回模板 | 0.3 |
| `naming_violation` | 自动修 | 0.2 |

其中 `duplicate` **有策略没检测器** —— 声明在册，但 `ts/src/` 里没有任何地方产出它；`perfunctory` 走不到常规流水线，只在回传审核那条路上产生。

### 反问 vs 建议

两者的区别不是语气，是**代价结构**。反问要停下来等人，问多了就是骚扰，所以 `thetaAsk` 卡得很紧（默认 0.35，最多问 3 个）；建议不阻塞任何事，可以给得多，但每条都必须能立刻执行。

`onto/suggest.ts` 全部由规则推导，每条带三样：依据（指回材料真实位置）、影响面（决定排序）、动作载荷（前端可直接执行）。六种 kind 里 `REVIEW` 声明了但从不产出，`NAMING` 与 `ASK_MATERIAL` **没有 apply 路径** —— 用户"采纳"它们不会改动 OIR。

最有价值的一条是 `ASK_MATERIAL`：**它把"抽漏了"和"材料里就没有"分开了**。判据是有没有行动 —— 接口都定义好了却没人写字段，说明字段表在另一份文件里，该去要材料而不是重试抽取。

### 模板与回传

`template.ts` 出真 xlsx（exceljs 经 `createRequire` 载入，因为它是 CJS，具名 ESM import 会在运行时抛 SyntaxError）：

* **隐藏锚点列** `_oir_rid` / `_oir_hash` 固定在第 1、2 列，数据从第 3 列起，冻结窗格 `C3`。
* **样式即语义**：黄底=业务必填、灰底=锁定、白底=已预填；冲突单元格加红边框 + 批注。
* 枚举列变成工作簿级数据校验（下拉）。

`audit.ts` 审回传：锚点对齐（抗打乱/插行/删行）→ 单元格级 diff → 损坏/缺失/枚举越界/命名/敷衍/分歧检查 → 自动修 → **加权完成度**（`答复` 权重 5.0，`definition` 4.0，依次递减）→ 按责任人出打回单。回填一律以 `Origin.USER` 写入。

---

## 流程图

材料里的业务流程被抽成一张 `FlowGraph`：节点（action/event/gateway/terminal/external）、边、泳道（stage）、可追踪的运行路径（workflow）。节点编码形如 `ACT-CP-DRAFT`。

它和本体是**双向链接**的：`FlowNode.objects` 存 OIR object rid，`FlowNode.endpoint` 存 API 路径。`coverageGaps()` 因此能报出两类真正值钱的缺口 —— **有流程步骤但背后没有接口**，和**有写接口但没有任何流程步骤用到**。

出图是两档：`toMermaid()` 出 `flowchart` 文本，`toSvg()` 出手写的自包含 SVG。**没有 mermaid-cli，没有无头浏览器** —— SVG→PNG 用 `@resvg/resvg-js`，PDF→PNG 用 `pdfjs-dist` + `@napi-rs/canvas`（`puppeteer-core` 只被 Live Browser 和 PDF 导出用）。线型编码证据强度：有材料出处的实线，推断出来的虚线。

七条策略 S1–S7 里，**今天真正有线上路径的只有 S1（BPMN 直读）、规则抽取、S6（接口列表反推）和 S7（通用参考草图）**。`flow_from_vision.ts`（图片流程图 OCR）、`flow_citation.ts`（三层引用校验）、`flow_merge.ts`（多策略合并）、`flow_strategy.ts` 都**只被测试引用，没有接进运行时**。

---

## 知识库

`ts/src/document/` 是版本化的项目/全局知识库：上传的文件解析成**不可变版本**，逐块可引用，按 ACL 控读，并作为证据钉进抽取流水线。

* 两级：**项目级**与**全局级**（全局用保留哨兵 `__global__` 复用同一套表，引用前缀「总库 」）。
* 引用格式 `odoc.v2.<level>.<b64url(docId)>.<b64url(verId)>.<b64url(chunkId)>`，解码时校验往返。v1（无 level 段）仍然认，按项目库解。
* 同一份文件 SHA-256 重复上传直接返回既有版本，不产生第二份副本、不重新解析。
* ACL 四种作用域（project/document/version/chunk）、三种权限；**显式 deny 优先**；每次读都重校 ACL 版本号（CAS），撤权能让在途结果立即失效。
* 解析走**带租约的任务队列**（`parse` / `ocr` 两种，租约 60 分钟，CHECK 约束保证只有 running 才持有租约）。

### 界面与模型侧

界面在 `#knowledge` 全屏页（`ts/src/ui/react/knowledge-*.tsx`）：

* **收件区**是第一屏 —— 这一页在入库之前除了入库什么也做不了（`searchLayered` 只看
  document store，会话里传了没入库的文件根本不在索引里），所以入库是最大的那个按钮，
  上面写着确切份数。事办完它自己塌成一行。
* **对话栏**（页头「对话」）把消息流放回这一页旁边，边读材料边问。栏宽是 `36vw` 而不是
  定宽 px：消息流里表格的列宽上限写死 `34vw`，给定宽栏会溢出且没有退路。
* **两级**在页头一键互切。公共库的正文顶部有常驻层级条、检索命中按层分两组 ——
  把「行业通用参考」当成「这个客户的规定」是这个产品最不能出的错，不能只靠一枚 8px 徽章。

模型侧有 **13 个 document 工具**（`ts/src/server/dialogue/document_tools.ts`）：
`list / search / open / read / folders / history / recall_knowledge` 只读，
`attach / detach / promote / promote_batch / manage / remember` 要写。

* 写工具**每轮一张一次性能力票**：票由用户本轮**原话**签发（`explicitDocumentActions`
  全句匹配 + 参数逐字绑定），模型自己请不到票。
* **公共库没有写工具**，这是刻意的：它跨项目共享，让模型自动往里放，三个月后就是垃圾场。
  只能人在界面上点「设为通用知识」。
* `remember` 写进去的**永远是草稿**，人确认才算项目知识（`document/wiki.ts` 里
  「AI 没有能创建 confirmed 的 API」这条约束由类型和运行时双重保证）。
* 模型改完知识库会发 `document.changed`，界面出一张回执卡、列表自动刷新。

**检索是纯 BM25 的词法检索**（k1=1.2, b=0.75），中日韩按字符二元组切分。代码里那层 `HybridDocumentSearch` 有 RRF 融合骨架，但语义打分器 `registerDocumentSemanticScorer()` **在整个仓库里没有任何调用点** —— 所以线上恒为 `lexical_only`，融合退化成 BM25 顺序。**不要把这套描述成语义检索或混合检索。** 同样地，六种外部连接器（SharePoint/WebDAV/S3/Confluence/DataHub/OpenMetadata）代码写完了但**没接线**，运行时会抛 `SOURCE_UNAVAILABLE`。

---

## 交付：Ontology Package 与 FDE 工作流

产品的最终交付物是 `ontocopilot.ontology-package/1` —— 15 个内容集合（dataObjects / links / actions / events / processNodes / processEdges / workflows / rules / integrations / roles / systems / questions / gaps / evidence）加一个 validation 块，状态 `valid | valid_with_gaps | invalid`。

外面套着一条**冻结的 16 节点工作流** `fde_engagement_v3`：

```
INTAKE → PROCESS → ERP_MAP → RULES → DATA_OBJECTS → GAP → INTERVIEW
  → DECISION_PROPOSAL → DECISION_APPLY → REQUIREMENTS → ARCHITECTURE
  → TEST_PLAN → CANONICALIZE → REVIEW → HUMAN_ACCEPTANCE → EXPORT
```

`INTERVIEW` 与 `HUMAN_ACCEPTANCE` 是 **HITL 节点**（时限 7 天、零 token 预算）；`GAP`/`DECISION_APPLY`/`CANONICALIZE`/`EXPORT` 是**确定性节点**（零 token、零工具调用）；其余十个是 agent 节点。每个门都有可读的判据，例如 `REVIEW` 要求 `verdict == 'PASS' && blocker_count == 0 && high_findings == 0`。

**发布签字复用既有的 admin 角色**，不另造一套权限词汇（`release_authority.ts` 只导出两个东西）。正式验收要管理员权限，非管理员回答验收问题会拿到 403。

两个必须说清楚的现状：

* **`DECISION_APPLY` 不 apply 任何东西。** 它自己的类文档就写着"validation is not application"，门判据要求 `mutation_count == 0`。人的决策**不会自动改业务模型** —— 真正的 applier（带乐观并发）还不存在，人工验收的元数据里甚至专门带一条"尚有决策变更未生效"的警告。
* **有两套并行的数据包编译器且尚未收敛**：交付路径用 `canonical.buildPackage`，`ontology_package.compileOntologyPackageV1` 只服务只读草稿路由。源码注释明说"两者收敛是独立议题"。

---

## 存储

**默认 SQLite，零配置**：没有 `DATABASE_URL` 时在 `<workspace>/ontocopilot.db` 建库（`ONTOCOPILOT_WORKSPACE` 默认 `workspace`），驱动是 **Node 内置的 `node:sqlite`**（`DatabaseSync`，会在每次启动打一条 ExperimentalWarning），外面套 drizzle 的 sqlite-proxy。`better-sqlite3` 被明确拒绝，不是依赖。

Postgres 是**显式启用**的（`DATABASE_URL`），纯内存要 `ONTOCOPILOT_NO_DB=1`。

```bash
docker compose up -d      # postgres:17-alpine，宿主端口 5433（不抢 5432）
export DATABASE_URL=postgresql://onto:onto@localhost:5433/ontocopilot
```

36 张表定义在 `store/schema.ts`；SQLite 靠运行时 `CREATE TABLE` 建起来并盖 `PRAGMA user_version=18`，Postgres 走 `migrations/` 下 18 个编号迁移。**没有 down migration，回滚靠新的前进迁移。**

**⚠️ 迁移没有 CLI。** `migrate.ts` 的 `upgrade()` 在 `ts/src/` 里零调用者，`package.json` 没有 `migrate` 脚本，`docker-compose.yml` 也没有 migrate 服务（尽管 `store/deps.ts` 的注释提到它）。**Postgres 部署目前没有仓库内置的迁移执行方式。**

`PgRepo` 同时服务 SQLite 和 Postgres；`MemoryRepo` 只在没有 engine 时用。两套实现意味着 Repo 新增方法要写两遍。

**租约与僵尸构建。** `build_lease` / `chat_lease` / `mutation_lease` 各有 owner / 心跳 / 过期（默认 TTL 30 秒，心跳 TTL/3）。构建方持 `${workerId}:${token}` 并循环续租，续租失败即中止本次 run；`reapExpiredBuildLease` 原子地删掉过期租约并把会话置为 failed。诊断"解析永远不完"时看的就是**心跳 vs 租约**这一对。

---

## 前端

React 19，**有构建步骤**。源码在 `ts/src/ui/`（65 个文件，含 `react/` 下 33 个），由 **esbuild** 打成一个 IIFE，替换掉 `ui/index.template.html` 里的 `//__OC_UI_BUNDLE__` 标记，产出单文件 `ui/index.html`（1.66 MB），服务端在 `GET /` 直接吐出来。**没有静态资源路由，浏览器零外部请求。**

```bash
npm run build:ui                        # ts/ 下
node tools/build-ui.mjs --check         # 只检查漂移，不写盘
```

* **`ui/index.template.html` 是源码**（HTML 骨架 + 全部 CSS + 标记），**`ui/index.html` 是产物，不要手改。**
* 改了 `ts/src/ui/` 不重新构建，浏览器上什么都不会变，而 `ts/test/ui.build.test.ts` 会红。
* `npm run build` 是 `tsc` + 把 `ts/catalog/` 复制进 `ts/dist/catalog/`，**不管前端**；`npm run dev` 只 watch 服务端，UI 没有 HMR。
* **发版到 `ts/dist` 用 `npm run build:deploy`**（= `build` + `build:ui`）。分开跑的坑有两个，都不会当场报错：只跑 `tsc` 不复制 catalog，服务起来之后**每一轮对话**都抛「工具未登记在 tools/tools.yaml」；不跑 `build:ui`，页面还是上一次构建的产物。`restart.sh` 走的是 `tsx` 读源码那条路，本身不经过 `dist`，所以它只跑 `build:ui`（不带 `--sync-dist`）。**前端产物默认不写进 `dist`** —— 只有 `build:deploy` 会写。否则跑一次开发模式的 `restart.sh`，就把常驻服务（跑的是 `dist`）的前端换成了当前源码的新 bundle，而它的后端 JS 还是旧的，前后端版本错配且没有任何日志。
* `ui/shell.baseline.json` 存骨架 CSS 与 body 的 sha256，样式改动要 `node ts/tools/verify-ui-shell.mjs --accept` 重新基线 —— 那份 diff 就是给评审看的记录。
* `build:ui` 用 esbuild 打包。它一度**没有写进 `package.json`**、只靠 vitest/vite 传递带进来 —— 去掉测试工具链前端就构建不了。现在它是显式的 devDependency（`esbuild` ^0.28.2）。

迁移是**混合态**而非纯 React：React 接管九个容器（quotaBar / setTabs / setBody / acctBody / identity / convs / knowledgePage / stream / pbody）加预览页签，其余仍是冻结 HTML + inline onclick，靠 `globals.ts` 把名字挂回 window。

`ui/OntoCopilot.html` 是初始提交以来没动过的**演示稿**，没有任何路由提供它 —— 别把它当界面。

---

## 服务与接口

Hono + `@hono/node-server`，`serve.ts` 的 `wireServer()` 一次性装配。默认监听 `127.0.0.1:3594`（`--host/--port` > `ONTOCOPILOT_HOST/PORT` > 内置默认；仓库里的 `.env` 设的是 8765）。

**全仓只有一个 SSE 端点**：`GET /api/sessions/:sid/stream`。它是**持久事件日志的投影**，不是第二条遥测通道 —— chat/kernel/run/artifact/question 等事件原样流出，`?since=<seq>` 续传，20 秒一个 keepalive 注释行。

> **已知形状**：`since=0` 会先发一行 `stream.reset` 再**无上限**重放整个会话历史，服务端没有游标窗口也没有丢弃策略。2026-08 那次页面冻死是**在浏览器侧**修的（16ms 渲染合帧 + 400ms 防抖的 `/state` 刷新 + 在途保护）。换一个客户端、或者旧客户端带 `since=0` 重连，仍然会一次性收到全量历史。

**鉴权是按数据 fail-closed 的**：`ONTOCOPILOT_AUTH` 为真、**或**库里已经有账号，就自动强制登录。Cookie `oc_auth`（HttpOnly、SameSite=lax，`ONTOCOPILOT_COOKIE_SECURE` 才加 Secure），服务端只存 token 的 sha256。免鉴权路径正好五条：`/`、`/api/health`、`/api/login`、`/api/register`、`/api/auth/status`。口令哈希是 scrypt（N=2¹⁴, r=8, p=1），与被删掉的 Python 实现逐字节一致，所以迁移前的账号照样能登录。

**建号有两条路，`ONTOCOPILOT_AUTH` 决定开几条：**

| | 自助注册 `POST /api/register` | CLI `useradd --admin` |
|---|---|---|
| **不设 AUTH**（本机默认） | 开着。零账号实例上**首个注册者自动成为管理员** | 可用 |
| **AUTH=1**（联网部署） | **403，整个关掉** | **唯一入口** |

**联网部署必须在建号前就把 `ONTOCOPILOT_AUTH=1` 设上。** "库里有账号就强制鉴权"这条 fail-closed 规则挡不住**零账号**的新实例 —— 那扇门在第一个访问者到达之前是敞开的，谁先访问谁当管理员。设上开关之后自助注册返回 403，抢注竞态才真正不存在。顺序反了（先建号再设开关）等于把窗口敞开过一段时间。

前端跟着服务端走：`/api/auth/status` 如实上报 `registration_open`，关着时登录框不再显示"去注册"。

运行期配置的优先级是 **DB `app_setting` > 环境变量 > 抛错**，绝不静默兜底。管理员在设置里改网关/预算，**下一次 run 就生效，不用重启**。设置入口在**会话侧栏左下角**的账号弹层里（不是右上角）。

---

## 工具、Skills、Agents

`npm run check:catalog` 会把这三样一起校验：**18 技能 / 18 Agent / 66 工具（8 核心 + 58 对话）/ 1 个 16 节点工作流**。

**工具按作用域授予，不是全局可用**（17 个作用域）。**内核自己不注册任何工具** —— `ToolRegistry` 和 `MCPGateway` 只是机制，真正的工具在 `server/glue/tools.ts` 组装。

**MCP 安全闸三道防线**：静态扫描（8 种投毒特征 + 隐藏字符 + 超长描述）、指纹锁定（描述变更即禁用，防 rug pull，`autoApproveFirst` 默认 false）、参数双向校验（未声明字段直接丢弃）。

> **⚠️ 旧文档说"内建工具里没有任何网络能力"，这条现在是假的。** `web.search` 与 `web.read` 是登记在册的内建工具。约束仍在：`web.read` 只接受本实例 `web.search` 之前发出过的 `source_id`，模型够不到任意 URL；Live Browser 与网页预览只由人从 UI 驱动。没有 `TAVILY_API_KEY` 时降级到 Bing RSS（结果明显变差，且全局作用域会被钉到英文/美国市场）。

**Skills 是带完成判据的操作规程，不是提示词模板。** 渐进披露：默认只有一句 description 常驻，模型判断相关时才载入正文 —— 全量塞进去就退化成一个巨大的系统提示词。

**Agents 是配置不是代码**（`ts/catalog/agents/`）：18 个角色各自声明模型档位、工具作用域、技能集、评审视角、循环模式。改行为是改配置，不是改控制流。

`rule_miner` 是散文段专用的角色，和 `extractor` **是两套 schema**。这不是分工洁癖：业务规则既不是实体也不是字段，抽取 schema 里没有装它的字段，模型抽得再准也会在组装时被静默丢掉 —— 一份 45 行的业务规则表因此整段消失过。**没地方放的东西，等于没抽。**

---

## 智能网关

**路由的单位是能力，不是模型名。** 调用方说"我要能读图 + 要结构化输出"，目录给出有序候选，网关逐个试。

硬编码模型名会在换模型时**静默坏掉**：请求照发，只是 OCR 悄悄变成了"模型看不见图、凭字段名瞎猜"，产物看起来正常但完全是编的。所以 `ModelCatalog.require()` 挑不出模型时**报错而不是降级**。

能力从三处合成：内置声明 → `/v1/models` 运行时发现 → **失败学习**（网关明确回「No endpoints found that support image input」时，该能力从这个模型上抹掉，本进程内不再浪费往返）。

难度四档（low/medium/high/critical）决定模型档位、最大迭代数（1/4/12/12）和 critic 轮数（0/1/2/3）。评委**跨厂商强制**：`judgeFor()` 按名字剔除与生成者同厂的评委。

预算四维 —— tokens / 时长 / 工具调用 / 美元 —— 触发五级降级：`NONE → NO_SELF_CONSISTENCY(<40%) → FEWER_CRITIC_ROUNDS(<25%) → RULES_ONLY(<15%) → HALT(<5%)`，每次降级发事件并在 `budget/degrade` 上广播。

---

## 沙箱

| 实现 | 隔离 | 用途 |
|---|---|---|
| `LocalSubprocessSandbox` | 子进程 + `node --permission` | **仅开发**。无内核隔离 |
| `GVisorSandbox`（runsc） | 用户态内核 | 生产默认 |
| `RuncSandbox` | 普通容器 | 中间档 |
| `FirecrackerSandbox`（kata-runtime） | 独立内核 microVM | 未知来源二进制 |

沙箱执行的是 **TypeScript/JavaScript**（预注入 arquero），不是 Python。本地档的断网是**用户态运行时补丁**（替换 `net.Socket.prototype.connect`、dgram、dns、fetch、WebSocket）—— 因为 Node 的权限模型根本没有网络维度，所以它诚实地报告自己 `production_safe: false`。

默认**不给**生产级隔离，必须显式要：反过来（找不到容器就悄悄降级）部署时没人会注意到。`code.exec` 在沙箱不可用时**整个从动作空间里摘掉**，而不是留一个会失败的工具。

---

## 可观测性

`kernel/otel.ts` 把内核事件流投影成 OTLP span 树，**手写，不依赖 OpenTelemetry SDK**。不配 endpoint 时 `bridgeFromEnv()` 返回 null，整条链路零开销关闭。

```bash
docker run -d -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

⚠️ 配了托管后端的 header 之后，span 会带着 runId、节点名、材料类型**离开这台机器**。这个产品处理的是客户材料，配之前先确认合规。

`ts/src/eval/` 是 EvalOps 评测台（`npm run eval -- --live`）：每次尝试都真起一个服务进程、在全新临时 workspace 上跑、走 HTTP 驱动，`pass^k` 要求 k 次全过。不加 `--live` 会打印"eval 打真网关、花真钱"并退 2。

---

## 已实现 / 未接线

**已实现且有测试覆盖**

- 持久化执行：effect 级记账、确定性重放、determinism violation 检测、HITL 挂起与恢复
- DAG：fan-out、通配依赖即屏障、拓扑校验、计划冻结、拓扑指纹 fail-closed 恢复
- 调度：并发、节点重试、崩溃恢复、四维预算与五级降级广播
- Agent Loop 六模式 + Critic Panel + Gate；`plan_execute` 另有 cohort 变体
- 四层记忆 + 压缩（locator 不动）+ 长期晋升/衰减/冲突
- Agent 总线三通路
- 模型网关：能力路由、难度分档、结构化输出重试、异构评委强制、失败学习
- 九个解析器，含**真 OCR**（视觉模型出 blocks/tables/relations + 归一化 bbox）与原生 docx/pptx/BPMN
- OIR + 8 类冲突（其中 duplicate 无检测器）+ 自动修 + 澄清 EIG 排序 + 决策回写
- 模板编译器：真 xlsx，隐藏锚点列、样式即语义、下拉校验、证据批注、冻结窗格
- 回传审核器：锚点对齐（抗打乱/插行/删行）、单元格级 diff、加权完成度、按责任人打回
- Hono + **SSE**（单端点，事件日志投影）+ 上百条 `/api/*` 路由
- 知识库：版本化、去重、ACL（CAS 失效）、BM25 检索、逐块引用、带租约的解析队列
- 流程图：抽取、编辑（20 种 op）、链本体、缺口→提问、mermaid + 自包含 SVG
- Ontology Package v1 + 16 节点冻结交付工作流 + 发布签字
- 账号：scrypt（与旧实现逐字节一致）、fail-closed 门禁、登录限流
- OTel 旁路、EvalOps 评测台、容器沙箱三档

**未接线 / 已知缺口**

- `ontocopilot build` 命令（真流水线只由服务端驱动）
- **Postgres 迁移没有执行入口**（`upgrade()` 零调用者，无 npm 脚本、无 compose 服务）
- 知识库的**语义/混合检索**（骨架在，打分器无注册点）；六种外部连接器（代码在，运行时抛 `SOURCE_UNAVAILABLE`）
- 流程图的 `flow_from_vision` / `flow_citation` / `flow_merge` / `flow_strategy`（只被测试引用）
- `DECISION_APPLY` 不写回业务模型（缺带乐观并发的 applier）
- `template_plan.ts`（AI 改模板，有实现有测试，无路由无工具）
- 两套数据包编译器尚未收敛
- `/docs`（启动横幅里是死链）、`registerBootReconciler`（生产无注册者）
- SSE 服务端无重放上限；Postgres 侧四处 `SELECT … FOR UPDATE` 仍缺
- DDL 方言从 sqlglot 的 32 种退到 node-sql-parser 的 14 种（**Oracle 缺失**，对中文 ERP 导出最疼）
- 旧版 Office（`.xls/.doc/.ppt`）不解析；OCR 无缓存无重试、图片不缩放
- 没有 linter / formatter / CI；质量闸只有手跑的 `npm run check` 与 `npm test`

---

## 环境变量

完整清单见 [`.env.example`](.env.example)（**它本身也不全**：`DATABASE_URL`、`ONTOCOPILOT_NO_DB`、上传上限、租约 TTL、`ANTHROPIC_API_KEY` 等都没写进去）。常用的几组：

| 组 | 变量 |
|---|---|
| 网关 | `CUSTOM_LLM_BASE_URL`、`CUSTOM_LLM_API_KEY`、`ANTHROPIC_API_KEY`、`ONTOCOPILOT_GATEWAY_CONCURRENCY` |
| 服务 | `ONTOCOPILOT_HOST`、`ONTOCOPILOT_PORT` |
| 鉴权 | `ONTOCOPILOT_AUTH`、`ONTOCOPILOT_COOKIE_SECURE`、`ONTOCOPILOT_SESSION_TTL_HOURS`、`ONTOCOPILOT_CORS_ORIGINS` |
| 存储 | `DATABASE_URL`、`ONTOCOPILOT_WORKSPACE`、`ONTOCOPILOT_NO_DB`、`DB_POOL_SIZE`、`DB_MAX_OVERFLOW` |
| 预算 | `ONTOCOPILOT_USD_CAP`、`ONTOCOPILOT_CHAT_USD_CAP`、`ONTOCOPILOT_RUN_WALLCLOCK_S`、`ONTOCOPILOT_RUN_TOOL_CALLS`、`ONTOCOPILOT_RUN_TOKENS`、`ONTOCOPILOT_MAX_SEGMENTS` |
| 上传 | `ONTOCOPILOT_MAX_UPLOAD_MB`、`ONTOCOPILOT_MAX_FILES`、`ONTOCOPILOT_MAX_SESSION_MB` |
| 检索/浏览器 | `TAVILY_API_KEY`、`ONTOCOPILOT_CHROME_PATH`、`ONTOCOPILOT_BROWSER_UPSTREAM_PROXY` |
| 沙箱/特性 | `ONTOCOPILOT_ENABLE_CODEACT`、`ONTOCOPILOT_SANDBOX_TMP`、`ONTOCOPILOT_PDF_ENGINE` |
| 遥测 | `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_SERVICE_NAME` |

设置页只读镜像其中 11 个（`DATABASE_URL` 的口令做脱敏）。

---

## 相关文档

- [`docs/OntoCopilot-Backend-Architecture.md`](docs/OntoCopilot-Backend-Architecture.md) —— 后端架构设计（2026-08-06，**早于 TS 迁移**，讲的是设计意图而非当前代码布局）
- [`docs/OntoDocument-产品与技术方案-2026-09-01.md`](docs/OntoDocument-产品与技术方案-2026-09-01.md) —— 知识库方案
- [`ts/catalog/README.md`](ts/catalog/README.md) —— 改技能/Agent/工具时的 golden 重生成流程
