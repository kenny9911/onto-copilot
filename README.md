# OntoCopilot

面向 AI FDE 工程师的本体建模副驾。把异构业务材料（Excel 梳理表、OpenAPI、Word 流程说明、DDL、扫描件、CSV）变成可被下游软件直接消费的 Ontology 模板。

- 架构文档：[`docs/OntoCopilot-Backend-Architecture.md`](docs/OntoCopilot-Backend-Architecture.md)
- 可交互 UI：[`ui/OntoCopilot.html`](ui/OntoCopilot.html)

代码在 `ts/`，Node ≥ 22（Node 26 已验证）。

```bash
cd ts && npm install
```

```bash
npm test          # 5886 项
npm run check     # tsc --noEmit
```

## 启动服务

```bash
./restart.sh                        # http://127.0.0.1:3594
```

`restart.sh` 会先**按端口**收掉旧进程（不是 `pkill node`，免得连累别的项目）、
重新构建前端、再启动；换端口用 `./restart.sh 8010`。只想起服务不重启的话，
`cd ts && npm start`。

前端由后端在 `/` 直接吐出 —— **不单开前端服务器**：多一个进程就多一份 CORS、
端口、部署配置要对齐，分开跑没有好处。但它**有构建步骤**：`ts/src/ui/` 打成一个
bundle 内联进 `ui/index.html`（`npm run build:ui`，`--check` 验有没有漂移），
改了 UI 源码不重新构建，页面上还是上一次的。API 文档在 `/docs`。

## 登录、账号与设置

默认是**单机开放**模式（零配置，行为和以前一样）。门禁是 **fail-closed** 的：
库里一旦有账号，就自动强制登录，无需再设开关。

```bash
# 1) 在宿主机上播种首个管理员（唯一的建号入口，没有公开的 bootstrap 路由）
ontocopilot useradd root --admin
# 2) 联网部署：从首次启动就锁死（未播种管理员前一切 /api 返回 401）
ONTOCOPILOT_AUTH=1 ONTOCOPILOT_COOKIE_SECURE=1 ontocopilot-server   # COOKIE_SECURE 仅在 HTTPS 后
```

登录后：管理员可在右上角 **⚙ 设置** 里改 LLM 网关（base_url / api_key 只写不回显 /
各难度档模型）、预算上限、查看环境变量（密钥已脱敏），并管理账号（增删、改角色、
重置密码）；普通用户只能用。**外观**（深/浅色主题、强调色、字号、密度、时区）与
**中/英语言**每个用户各自保存。相关环境变量见 `.env.example`
（`ONTOCOPILOT_AUTH` / `COOKIE_SECURE` / `SESSION_TTL_HOURS` / `CORS_ORIGINS`）。

## 命令行

入口是 `ts/src/cli_main.ts`：

```bash
cd ts && npx tsx src/cli_main.ts <命令>
```

**可用**：`audit`，以及账号类的 `useradd` / `passwd` / `role` / `users`
（播种首个管理员就靠它）。

**`doctor` / `parse` / `build` 还没接线**，跑起来会如实报"尚未迁移"并退 1。
它们依赖的模块其实都已就绪，只差把命令接上去 —— 在那之前，整条解析→模板的流程
走 Web UI。

`build` 与 `audit` 之间通常隔着几天（业务方在填表），所以模板规格随 xlsx 一起落盘，
审核时从盘上读回。

`.env` 见 `.env.example`。支持 Anthropic 原生（`AnthropicBackend`）与 OpenAI 兼容聚合网关
（`OpenAICompatBackend`）两种后端，接口相同。

---

## 代码结构

```
ts/src/
  kernel/                 L1 Harness Kernel —— 领域无关，换领域可整体复用
    events.ts             事件模型（一切都是事件）
    journal.ts            事件日志 + 内容寻址 blob 存储
    recorder.ts           ★ 持久化执行：effect 记账、确定性重放、HITL 挂起
    memory/
      types.ts            MemoryItem / 生命周期 / token 估算
      short_term.ts       Scratchpad（节点作用域）+ WorkingSet（Run 作用域）+ 压缩
      long_term.ts        ★ 跨 Run 记忆：晋升闸门、冲突留档、闲置衰减
      evidence.ts         L2 证据检索（BM25 + camelCase 拆词 + 邻域扩展）
      context.ts          ★ 四层上下文装配 + 预算分配
      dialogue.ts         对话记忆
      project.ts          项目级记忆（跨会话）
    bus/
      blackboard.ts       ★ 共享事实层：append-only、冲突不覆盖
      bus.ts              ★ AgentBus：黑板 / 定向请求 / 广播，全部记账
    dag.ts                节点定义、fan-out 展开、拓扑校验、计划冻结
    scheduler.ts          流水线调度、崩溃恢复、降级广播
    loop.ts               Agent Loop 运行时（6 种模式）
    llm.ts                模型网关：难度路由、结构化输出、异构评委、成本记账
    catalog.ts            ★ 能力目录 + SmartGateway：按能力选型、失败切换、失败学习
    backends.ts           Anthropic 原生 + OpenAI 兼容网关两种后端
    config.ts             凭证从环境读，绝不落进源码
    critic.ts             Critic Panel + Gate
    budget.ts             多维预算 + 降级阶梯
    tools.ts              ★ 工具注册表 + MCP 安全闸（投毒扫描 / 指纹锁定 / 作用域）
    sandbox.ts            ★ 三档沙箱：子进程(开发) / gVisor / Firecracker
    skills.ts             ★ Skills：渐进披露的操作规程，带完成判据
    agents.ts             ★ 具名 Agent：角色 + 档位 + 工具作用域 + 技能 + 评审视角
    intent.ts             意图识别（聊天 / 工作分流）
    errors.ts / pyfmt.ts  Python 语义的错误类型与数字格式（golden 逐字节对齐用）
  onto/                   L2 领域层 —— 内核完全不知道它的存在
    oir.ts                ★ Ontology 中间表示（Assertion 强制携带溯源）
    shape.ts              ★ 段形状推断：列角色 → 这段能出什么 + 哪些规则就能定
    pipeline.ts           ★ 跑在 Harness 上的主 DAG：切段 → fan-out 抽取 → 合并
    suggest.ts            ★ 主动建议：规则推导，带依据/影响面/可执行动作
    conflict.ts           ★ 8 类冲突的检测与处置
    clarify.ts            ★ 澄清引擎（EIG 排序，选 top-3）
    align.ts              ★ 实体对齐：三路阻塞 → 结构+名称打分 → 连通分量 → 代表选举
    template.ts           ★ 模板编译器：xlsx + 隐藏锚点列 + 样式即语义 + 内嵌校验
    audit.ts              ★ 回传审核器：锚点对齐、单元格 diff、加权完成度、打回单
    flow*.ts              流程图：抽取 / 连线 / BPMN / 手绘草图
    parse/                ★ 真实解析器
      tabular.ts            xlsx/csv：表头探测、合并单元格还原、批注、元数据泄漏、列画像
      sql.ts                DDL：AST + 行内注释还原（口径全在注释里）
      api.ts                OpenAPI：写端点 → ActionType 草稿源；schemas → 对象候选
      text.ts               md：按标题分段、规则句打标、表格单独抽
      docx.ts + doc/        ★ docx 原生解析（自带 zip/xml 读取，不依赖外部库）
      vision.ts             ★ 扫描件/PDF：视觉模型 OCR，出文本块+表格+连线，带 bbox
  server/                 ★ Hono + SSE（routes/ 路由、glue/ 编排、pipeline/ 落盘与回放）
  store/                  ★ 持久层：SQLite（默认）/ Postgres 双驱动 + 迁移
  ui/                     ★ 前端源码（TS + React），构建后内联进 ui/index.html
  auth.ts / authgate.ts   登录与 fail-closed 门禁
  serve.ts                服务启动器（DEFAULT_PORT 在这里）
  main.ts                 进程入口：摆正 cwd → 调 serve
  cli.ts / cli_main.ts    命令行入口
ui/index.html             ★ 构建产物（由 ts/src/ui/ 打包内联，勿手改）
ui/index.template.html    模板：HTML/CSS 逐字节冻结，只留一行 bundle 标记
golden/                   ★ 跨实现的行为基线（原 Python 侧真跑出来的字节）
ts/test/                  5886 项
migrations/               数据库迁移
```

`kernel/` 与 `onto/` 之间的边界是这套代码最重要的一条线：内核完全不知道什么是 ObjectType，领域层完全不知道什么是 DAG 调度。守住它，换领域只需重写 `onto/`。

---

## 记忆管理

**短期**（Run 之内）

| 层 | 容器 | 生命周期 | 装载策略 |
|---|---|---|---|
| L0 System | `ContextManager.system` | 常驻 | 全量（已压缩成规则表）；接真实模型时打缓存断点 |
| L1 Working | `WorkingSet` + `Scratchpad` | Run / 节点 | 全量；超预算先压 scratchpad |
| L2 Evidence | `EvidenceIndex` | 按需 | **检索式**：BM25 top-k + 邻域扩展 + token 预算截断 |
| L3 Reflection | `ContextManager.reflect()` | Run | 全量（体量小） |

两条硬纪律：

- **节点是上下文作用域边界。** 节点内部转 20 轮，下游只看到结构化产出 + 一份 digest。
- **压缩永不动 locator。** `Scratchpad` 用正则把出现过的 `文件!位置` pin 住，压缩后一条不少 —— locator 丢了溯源就断了，而溯源是这个产品的信任基础。

**长期**（跨 Run，项目作用域）

进长期库要过 `PromotionGate`，三选一：人确认过 / 扛过 N 轮 critic / 在 K 个不同 Run 里独立观察到。**没有 support 的一律拒**。

冲突不静默覆盖：同 key 不同内容 → 标 contested，两条都留，检索时一并给出。人的决策可以推翻机器推断，但旧值降级留档而非删除。

不用就衰减：连续 N 个 Run 没命中的条目降可信度，跌破地板淘汰。`MemoryKind.DECISION` 免疫 —— 人拍板的是业务事实，不是系统的猜测。

---

## Agent 间通信

只有三条合法通路，**没有自由对话**：

| 通路 | 用于 | 实现 |
|---|---|---|
| **DAG 边** | 绝大多数通信 | `WorkingSet`，沿依赖流动 |
| **黑板** | 很多节点都要、但不在直接路径上的事实 | `Blackboard`，append-only、带出处 |
| **定向请求 / 广播** | Critic 要求 Actor 举证；调度器广播降级 | `AgentBus.request()` / `.broadcast()` |

三者都写事件日志，所以协作链路可重放、可审计、可在 UI 上展开。

**为什么这么克制。** 自由对话在 demo 里好看，在生产上同时坏掉三件事：消息顺序不确定 → 重放失效；上下文无界增长 → 成本失控；事后无法回答"谁认定了这件事" → 交付物不可辩护。对 FDE 场景第三条是致命的。

**冲突是信号，不是噪声。** 两个 agent 对同一 key 写了不同的值，恰恰就是「计划金额」双口径的机器形态。黑板不做 last-write-wins，而是保留全部变体、标记争议，交给 Critic 和澄清引擎处理。静默覆盖会让系统丢掉它唯一一次发现矛盾的机会。

---

## 已实现 / 未实现

**已实现且有测试覆盖**

- 持久化执行：effect 级记账、确定性重放、determinism violation 检测、HITL 挂起与恢复
- 四层记忆 + 压缩 + 长期晋升/衰减/冲突
- Agent 总线三通路
- DAG：fan-out、通配依赖即屏障、拓扑校验、计划冻结
- 调度：流水线并发、节点重试、崩溃恢复、预算降级广播
- Agent Loop 六模式 + Critic Panel + Gate
- 模型网关：难度路由、结构化输出重试、异构评委强制
- OIR + 8 类冲突检测 + 自动修 + 澄清 EIG 排序 + 决策回写
- 模板编译器：真 xlsx，隐藏锚点列、黄/灰/白样式、下拉校验、证据批注、冻结窗格
- 回传审核器：锚点对齐（抗打乱/插行/删行）、单元格级 diff、加权完成度、按责任人打回
- **真实 LLM 联调**：OpenAI 兼容网关，跨厂商评委（Claude 生成 → GPT 评审），真实成本记账

## 往返闭环的实测结果

`demo_live.py` 一次完整运行（Opus 4.8 抽取 + GPT-5.5 评审）：

| 环节 | 结果 |
|---|---|
| 抽取 | 3 份异构材料 → 4 对象 / 7 属性 / 2 关系 / 0 孤立，每条断言带 locator |
| 口径分歧 | 含税·年度累计 vs 不含税·单次，**被抓出来**（同名同类型，纯 schema 比对发现不了）|
| 评审 | 跨厂商评委（gpt-5.5 审 claude-opus-4.8 的产出）通过 3/3 检查项 |
| 澄清 | 4 条冲突 → 问 2 个、打回 2 个，无重复提问 |
| 模板 | 79 格，预填 67%，业务必填 17，按责任人分派 |
| 回传审核 | 完成度 47%，抓出 8 处敷衍（含 UNCHANGED_PREFILL）、1 处枚举越界 |
| 成本 | $0.19 / 次完整往返 |

## 工具、Skills、Agents

**工具按作用域授予，不是全局可用。** 抽取 agent 的动作空间里根本没有出网工具 ——
材料里写什么诱导都没用，这是间接提示注入的主要防线。内建工具里**没有任何网络能力**。

**MCP 安全闸三道防线**：静态扫描（投毒特征、隐藏字符、索取凭证）、指纹锁定
（描述变更即禁用，防 rug pull）、参数双向校验（未声明字段直接丢弃）。工具描述以
`<tool_description>` 数据块注入，不与系统指令混排。

**Skills 是带完成判据的操作规程，不是提示词模板。** 渐进披露：默认只有一句
description 常驻，模型判断相关时才载入正文。全量塞进去就退化成一个巨大的系统提示词。

**Agents 是配置不是代码。** 7 个内置角色（extractor / rule_miner / aligner /
conflict_hunter / clarifier / action_drafter / auditor），各自声明模型档位、工具作用域、
技能集、评审视角、循环模式。改行为是改配置，不是改控制流。

`rule_miner` 是散文段专用的角色，和 `extractor` **是两套 schema**。这不是分工洁癖：
业务规则既不是实体也不是字段，抽取 schema 里没有装它的字段，模型抽得再准也会在
组装时被静默丢掉 —— 一份 45 行的业务规则表因此整段消失过。**没地方放的东西，
等于没抽。**

## 段形状：不写死"表里必有字段"

真实材料的一个 workbook 里能同时出现三种完全不同的表：

| sheet | 一行 = | 有属性吗 |
|---|---|---|
| 业务对象实体梳理 | 一个实体（有编码列，无类型列） | **没有，零属性是正确答案** |
| 业务对象API梳理-行动 | 一个行动（多一列 url） | 没有 |
| 业务规则 | 一段散文 | 没有 |

用同一句"每行字段都要抽成 PropertyType"去套，后果是 critic 判"漏抽属性"、节点
反复重试、预算烧穿 —— 而三张表里本来一个属性都没有。

`onto/shape.py` 改成**从列的取值分布推断**（不认表名、不认关键字）：
每列判角色（标识符/名称/分组/端点/数据类型/必填/散文/枚举），再由列角色推出这段
能产出什么、其中哪些**规则就能定**。两个下游效果：

* critic 只对"这段应该有"的东西判缺失，假阳性消失；
* 一行一实体、一行一行动这类映射完全确定的表**不进模型** —— 一行不丢，也不用
  为复述 168 行付 Opus 的钱。规则层在实测材料上直接给出 167 个对象 + 112 个行动。

顺带修掉两个解析 bug：整行长散文被当成表头（返回 -1 表示"无表头"），以及只在每组
首行写一次的**稀疏分组列**被当成普通名称列（单看一列判不出来，得对照"别的列是满的"）。

## 反问 vs 建议

两者的区别不是语气，是**代价结构**。反问要停下来等人，问多了就是骚扰，所以
`theta_ask` 卡得很紧；建议不阻塞任何事，可以给得多，但每条都必须能立刻执行。

`onto/suggest.py` 全部由规则推导，每条带三样东西：依据（指回材料真实位置）、
影响面（决定排序）、动作载荷（前端可直接执行）。实测材料上给出的五条：

```
▸ [ASK_MATERIAL] 171 个对象没有任何字段，需要再要一份字段梳理表   影响 171 · 90%
▸ [NAMING]       存在 13 套命名前缀，建议先定命名规范再回传        影响 123 · 60%
▸ [ADD_LINK]     补 18 组「头—行」包含关系                        影响 36  · 85%
▸ [BIND_RULE]    17 条业务规则还没挂到对象上                       影响 17  · 95%
▸ [EXCLUDE]      17 个疑似临时/日志表，建议不进本体                影响 17  · 70%
```

第一条是这套设计的意义所在：**它把"抽漏了"和"材料里就没有"分开了**。判据是有没有
行动 —— 接口都定义好了却没人写字段，说明字段表在另一份文件里，该去要材料而不是
重试抽取。

## 智能网关：按能力路由

**路由的单位是能力，不是模型名。** 调用方说"我要能读图 + 要结构化输出"，
目录给出有序候选，网关逐个试。

硬编码模型名的写法会在换模型时**静默坏掉**：请求照发，只是 OCR 悄悄变成了
"模型看不见图、凭字段名瞎猜"，产物看起来正常但完全是编的。所以
`ModelCatalog.require()` 挑不出模型时**报错而不是降级**。

能力从三处合成：内置声明 → `/v1/models` 运行时发现 → **失败学习**。网关明确
回「No endpoints found that support image input」时（deepseek 就会这么回），
该能力从这个模型上抹掉，本进程内不再浪费一次往返。

当前网关（New-API / OpenRouter 协议）上：vision 7 个 · structured 10 个 ·
effort 3 个 · long_context 10 个 · cheap 6 个。

## OCR

扫描件走视觉模型，输出**结构化版式**而非文字流：文本块、表格、**实体框之间的
连线**，每项带归一化 bbox。ER 图里框与框之间的连线就是 LinkType，只出文字流
等于什么都没读到 —— 实测能读出 `1 : N` 这样的基数标注。

预览一律从构建时的缓存读，**不重新 OCR**：重跑既贵，又可能给出与抽取时不同的
文本，那样"点回原文"看到的就不是系统当初实际读到的东西。

## 沙箱

| 实现 | 隔离 | 用途 |
|---|---|---|
| `LocalSubprocessSandbox` | 进程 + 资源上限 | **仅开发**。无内核隔离 |
| `GVisorSandbox` | 用户态内核 | 生产默认 |
| `FirecrackerSandbox` | 独立内核 microVM | 未知来源二进制、扫描件 OCR |

`describe()` 会明说 `production_safe`，`doctor` 也会警告 —— 把开发用沙箱当生产用是灾难。
默认**不给**生产级隔离，必须显式要：反过来（找不到容器就悄悄降级）部署时没人会注意到。

**未实现**

- OCR / 扫描件解析（`page + bbox` 的 locator 结构已就位，缺识别引擎）
- FastAPI + SSE 接口层（内核的事件流已经是 SSE 就绪的形状）
- `AnthropicBackend`（原生协议）已写但未连线验证 —— 当前网关只支持 OpenAI 协议
