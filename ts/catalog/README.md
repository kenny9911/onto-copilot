# OntoChat runtime definitions

这里是 OntoChat 可由工程团队维护、会被运行时读取的定义目录；它不是第二套说明文档。

- `skills/`：一项技能一个 Markdown，包含触发条件、步骤、完成判据、工具和标签。
- `agents/`：一名 Agent 一个 Markdown；YAML frontmatter 保存执行配置，正文保存角色提示词。
- `tools/`：工具清单与最小权限作用域。处理函数仍在 `ts/src/server/`，目录中会写明实现位置。
- `workflows/`：冻结的 Agent 工作流。材料内容只能作为节点输入，不能修改这里的拓扑。

运行时从本目录加载并校验定义。部署时可把目录复制到包内，或通过
`ONTOCHAT_CATALOG_DIR` 指定绝对路径。修改后运行：

```bash
cd ts
npm run check:catalog
npm test
```

不要在 TypeScript 中再维护同名的第二份 Agent/Skill/Workflow 配置；兼容导出
`BUILTIN_SKILLS`、`BUILTIN_AGENTS`、`TOOL_SCOPES` 只是运行时加载结果。

## Prompt 分层

运行时按以下顺序组装模型上下文：

1. `agents/_base.md`：所有 Agent 共同的权限、证据、注入防护和输出纪律；
2. `agents/NN-*.md` 的 `## System`：当前角色的输入边界、工作顺序和 handoff；
3. Agent frontmatter 显式引用的 `skills/*.md`：可复用、可验收的领域规程；
4. `tools/tools.yaml` 的 `routing_prompt` + handler 旁的详细 ToolSpec：选择边界与参数契约。

Skill 和 Tool Prompt 都不能扩大 Agent/node 的权限或输出 Schema。发生冲突时以冻结工作流、
节点契约和工具作用域为准；无法承载的信息必须进入现有 gap/question/finding，而不是新增字段。

修改 Prompt 后运行：

```bash
cd ts
npm run update:catalog-golden
npm run check:catalog
npm test
```
