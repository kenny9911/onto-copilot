# OntoCopilot 接入外部 Harness 的分析：DeepSeek Harness vs Pi

> 2026-08-14 · 基于两个项目的公开仓库与文档实查，非凭印象。
> 结论先行：**两个都不该拿来替换我们的内核；值得做的是「选择性借用 + 生态互通」。**
> 如果动机是「想用 DeepSeek 的模型」，那不需要接入任何东西——我们的网关本来就是
> OpenAI 兼容协议，配一个 DeepSeek endpoint 就能用。

---

## 1. 两个项目是什么（实查事实）

### 1.1 DeepSeek Harness（`dsh`）

| 事实 | 数据 |
|---|---|
| 仓库创建时间 | **2026-08-13（昨天）** |
| Star 数 | 136,358（一天，现象级发布） |
| 语言 / License | TypeScript / MIT |
| 状态 | **Developer Preview**，README 原话：*"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"* |
| 定位 | 通用 agent 平台：「Everything is a Plugin」，底座是 Cordis 插件框架 |

架构上它是一个**完整的 agent 运行时**：append-only 的 `SessionEvent` 日志、
带作用域的工具注册表（guarded execution pipeline）、agent loop、LLM adapter 接缝、
沙箱与审批策略、Web UI。所有部件都是插件，都可以从配置替换。
入口是 `npx @deepseek-ai/dsh web`（端口 3080），另有 headless 与 Python SDK
（JSON-RPC agent，用于 benchmark）。

### 1.2 Pi（pi.dev）

| 事实 | 数据 |
|---|---|
| 语言 / License | TypeScript / MIT（Earendil Inc.） |
| 定位 | **极简 coding agent harness**：小内核 + TypeScript 扩展 |
| 形态 | CLI（TUI / print / JSON / RPC）+ **SDK 可嵌入** |
| 模型 | Provider-agnostic，15+ 家（Anthropic / OpenAI / Google / Ollama / …），会话中途可切 |
| 特色 | 会话是**树**（任意历史节点分叉续跑）、skills 按需加载、auto-compaction |
| 刻意不做 | 内置 MCP、子 agent、plan mode——留给扩展生态 |

SDK 形态干净：

```ts
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({ name: "my_tool", parameters: …, execute: async … });
const { session } = await createAgentSession({
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
});
session.subscribe(ev => …);        // 事件流
await session.prompt("…");
```

---

## 2. 关键问题：它们能替我们做什么？

先摆清楚我们自己有什么。OntoCopilot 的内核（`ts/src/kernel/`）不是临时搭的脚手架，
是按 Harness Engineering 架构审计（`docs/Harness-Engineering-Architecture-Review-2026-08.md`）
的目标逐条建的，**5,865 个测试钉着**：

| 我们内核的能力 | dsh 有吗 | pi 有吗 |
|---|---|---|
| 外层 DAG + **计划冻结**（拓扑在读材料内容之前定死——这是提示注入的安全边界，不是优化） | ✗（自由 loop） | ✗（自由 loop） |
| **确定性重放**：effect 指纹（`canonicalJson` → sha256）+ journal 逐字节可比 + `DeterminismViolation` | ✗（有 session log，无指纹重放） | ✗（有会话树，无指纹重放） |
| Critic 面板 + Gate **阻断**闭环（评审不过就不放行，不是记条日志继续跑） | ✗ | ✗ |
| 记忆分层 AUTHORITATIVE / REFERENCE（人拍板的 vs 模型猜的，防跨会话记忆污染） | ✗ | ✗ |
| 预算三信号（网关欠费 S1 / 余额偏低 S2 / 本地上限 S3，**文案不许混**） | ✗ | ✗ |
| 工具最小权限（`code.exec` 只发给 analyze/compile，读材料的 extract 拿不到） | ✓（scoped registry，思路一致） | 部分（工具是全局的） |
| OIR / provenance / 冲突检测 / 问题挖掘 / 模板编译（**产品本体**） | ✗ | ✗ |

看出问题了：**两边都没有的，恰恰是我们最花力气建的**。DAG 冻结、指纹重放、
critic 阻断、记忆分层——这四样是 FDE 交付场景的可预测性来源（客户材料里一句
「忽略以上指令」不能改变执行拓扑；一次 Run 断了要能从 journal 精确恢复；
跑出来的东西要能审计到每一步）。换成任何一个外部 harness，这四样都要**在人家的
loop 里重新发明一遍**，而它们正是最难写对的部分——我们刚刚花了整个迁移来验证它们。

反过来，它们有而我们没有的：

| 能力 | 谁有 | 对我们的价值 |
|---|---|---|
| 多 provider 模型适配矩阵（15+ 家开箱即用） | pi | **中**——我们走 OpenAI 兼容网关，主流模型已可用；但直连 Bedrock/Vertex 这类要自己写 |
| 会话树（任意历史点分叉续跑） | pi | **中**——「从上一个拍板点重新梳理」对 FDE 是真需求；但可以在我们自己的 journal 上实现，数据基础（append-only 事件）已经有 |
| 插件生态 / 配置化组装（Cordis profiles/bundles） | dsh | **低（现在）/ 观察（半年后）**——生态一天大，但 API 明说会破坏性变更 |
| Web UI 现成的 agent 观测界面 | dsh | 低——我们有自己的 React 前端，推理轨迹已可视化 |

---

## 3. 三种接入方式，逐个评估

### 方案 A：换内核（把 OntoCopilot 跑在 dsh 或 pi 的 loop 上）

**不建议，两个都不建议。**

- 丢掉计划冻结 + 指纹重放 + critic 阻断 + 记忆分层，再在对方的扩展点里重写一遍。
  重写的东西没有我们现在的 5,865 条测试和 68 份 golden 保护。
- dsh 发布**一天**、官方承诺破坏性变更——把产品内核押在上面，等于每次它升级
  我们都要跟着改。等它出 1.0 再评估不迟。
- pi 的 loop 是为**交互式写代码**优化的（文件工具、AGENTS.md、编辑循环），
  不是为「解析材料 → DAG 抽取 → 冲突检测 → 编译交付物」的流水线。
  硬套等于拿它当一个昂贵的 while 循环。

### 方案 B：选择性借用（保留内核，吸收它们的好东西）

**建议做，按优先级：**

1. **pi 的会话树交互**（借思路不借代码）：我们的 journal 本来就是 append-only
   事件流，天然支持「回到第 N 个事件分叉」。在对话侧加「从这个拍板点重新来」，
   数据层几乎零成本，UI 加一个树导航。这是对 FDE 最有感的一条。
2. **dsh 的事件分类学**（session / agent / capability 三域）：我们的 27 种
   `EventKind` 是平的，它的三域划分（「必须落盘的事实」vs「观测在飞的工作」vs
   「策略接缝」）值得对照自查一遍——成本是一次 review，不是一次重构。
3. **模型直连适配**：若将来要绕开网关直连各家（企业客户常要求），pi 的
   provider 矩阵是现成的参考实现（MIT，可以读它怎么处理各家的流式差异）。

### 方案 C：生态互通（把 OntoCopilot 做成它们的插件/扩展）

**建议做，成本低、纯增量：**

- **dsh 插件**：把「上传材料 → 出 OIR/问题清单/流程图」包成一个 dsh 工具插件
  （打 `dsh-plugin` topic）。dsh 一天 13 万 star，它的用户里就有我们的目标用户——
  这是分发渠道，不是技术依赖。内核不动，只加一层薄适配（调我们已有的 HTTP API）。
- **pi 扩展**：同理，`defineTool` 把 OntoCopilot 的 API 包成 pi 工具，
  让用 pi 的工程师在终端里就能调我们的梳理能力。

两条的共同点：**依赖方向是它们 → 我们的 HTTP API**，我们的内核零改动，
它们怎么破坏性变更都只影响那层几十行的适配器。

---

## 4. 一个容易混淆的点：想用 DeepSeek 的模型 ≠ 要接 DeepSeek Harness

`dsh` 是 agent 框架，**不绑定 DeepSeek 模型**；反过来，用 DeepSeek 的模型也不需要 `dsh`。
我们的后端是 OpenAI 兼容协议（`ts/src/kernel/backends.ts`），只要网关挂了
DeepSeek 的模型（或直接配 DeepSeek 官方 API 的 base_url + key），设置页里选上就能用，
一行代码不用改。

---

## 5. 结论与建议动作

| | 结论 |
|---|---|
| 换内核跑在 dsh 上 | **否**——发布一天的 developer preview，且我们要重写四样它没有的安全/可靠性机制 |
| 换内核跑在 pi 上 | **否**——coding agent 的 loop 与我们的 DAG 流水线形态不匹配 |
| 半年后重评 dsh | **是**——если它出 1.0、生态成型，届时评估的对象是「要不要发布 dsh 插件版」而不是「要不要换内核」 |

**近期动作（按序）：**

1. 【低成本高感知】对话侧加「从拍板点分叉」——借 pi 会话树的交互，落在我们自己的 journal 上。
2. 【一次 review】对照 dsh 的三域事件分类学自查我们的 `EventKind`。
3. 【分发】写一个 ~50 行的 dsh 插件 + 一个 pi 扩展，都只调我们的 HTTP API，
   打上 `dsh-plugin` topic 蹭它的发现机制。
4. 【零成本】如果只是想用 DeepSeek 模型：在设置页把网关指到挂了 DeepSeek 的
   endpoint 即可，今天就能用。

---

*事实来源：github.com/deepseek-ai/deepseek-harness（README、docs/architecture.md、
BENCHMARK.md，经 gh api 实查）；pi.dev（首页、/docs、/docs/latest/sdk）。
星数与日期为 2026-08-14 查询值。*
