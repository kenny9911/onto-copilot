# Tool catalog

`tools.yaml` 是工具治理与授权的真相源；56 个工具的处理函数仍留在它们所属的
`server/glue` 或 `server/dialogue` 模块中，避免把业务代码和权限配置揉成一个巨型文件。

- `agent_scopes`：专业 Agent 的最小权限表，保持 `TOOL_SCOPES` 兼容导出。
- `access_profiles`：对话工具的复用授权组合。
- `tools`：名称、装配组、危险等级、授权、条件可用性、实现位置和
  `routing_prompt`。

`routing_prompt` 是给模型看的**短选择边界**：说明什么时候选本工具、最容易和哪个
工具混淆、什么时候明确不适用。详细能力、参数说明和动态运行时能力仍留在 handler
旁的 `ToolSpec` 中；生产装配会把两段组合起来。这样修改路由边界不必进入四千多行的
handler 文件，也不会把动态格式清单或 op schema 复制成第二份真相。

维护规则：

1. 每个工具必须有单行 `routing_prompt`，不超过 220 个字符。
2. 路由提示只讲选择与排除，不复述全部参数；参数属于 `ToolSpec.inputSchema`。
3. 有出网能力的工具要写清允许的数据级别；例如 `web.search` 只允许公开检索词，
   不得把客户材料、个人信息或凭证发出去。
4. 相邻工具要成对写边界，例如 `material.parse` / `build.start`、
   `memory.recall` / `revision.diff`、`question.answer` / `decision.record`。
5. 通用 `ToolRegistry` 不自动读取本目录；只有生产 registry 通过 managed registrar
   显式启用，测试夹具、MCP 工具和嵌入方不会被悄悄改写 prompt。

新增工具必须先登记，再注册；未登记工具不应进入生产动作空间。危险等级不能自动推导
授权，例如 `export.file`、`material.parse` 虽会写本地状态，但明确允许聊天模式使用。
