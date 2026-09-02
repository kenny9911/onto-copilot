# Agent catalog

- `manifest.yaml` 固定 17 个 Agent 的加载顺序和公共提示词文件。
- `_base.md` 是所有 Agent 共用、会进入模型上下文的基础纪律。
- `NN-*.md` 的 frontmatter 保存 mode、tool scope、skills、critics、budget、owner、版本
  和输出 Schema 名；H1 是稳定 Agent 名，引用块是角色，`## System` 是专属提示词。
- `schemas/*.schema.json` 是结构化输出契约，一份 Schema 一个文件。

## Prompt contract

- 每个 Agent 文件只能有一个 `## System`；其内部小节必须使用 `###`。Loader 会拒绝
  额外 H2，避免维护者写出的规则被运行时静默截掉。
- `_base.md` 只放所有角色共同适用的权限、证据、注入防护、输出和停止纪律；角色特有
  的输入边界、工作顺序和 handoff 留在对应 Agent 文件。
- Prompt 只能要求当前 output Schema 与 runtime merge 能承载的结果。Enrich-only 节点
  不得被 Skill 或角色文案授权新增、删除、重排基线实体；不能承载的内容转现有缺口字段。
- 修改系统提示词或 Skill 后统一运行 `npm run update:catalog-golden`，再跑 catalog、
  kernel 和全量测试。

Agent Markdown 和 Schema 是运行时真相源，不是从 TypeScript 自动生成的镜像。修改后先跑
`npm run check:catalog`，再更新 golden 并跑全量测试。不要改变数字前缀或 manifest 顺序，
除非明确准备迁移注册顺序、checkpoint 和评测基线。

## FDE P0 专业角色

- `decision_integrator` 只消费已记录决策并产生 patch 提案，不写入 OIR。
- `requirements_engineer` 分离已确认、候选与未知需求，不批准方案。
- `solution_architect` 输出候选组件、Fit-Gap disposition 和集成契约，不声称已实现。
- `acceptance_test_engineer` 设计测试和追溯，readiness 只表示可交人工评审，不代表通过或签字。
