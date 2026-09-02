# OntoChat Skills / Agents / Tools / Workflows 文件结构

## 结论

可维护定义统一放在 `ts/catalog/`，运行时代码放在 `ts/src/`。Catalog 是真相源，
TypeScript 中的 `BUILTIN_SKILLS`、`BUILTIN_AGENTS`、`TOOL_SCOPES` 是启动时加载结果，
不再维护第二份硬编码清单。

```text
ts/catalog/
├── catalog.yaml
├── skills/
│   ├── README.md
│   └── 01-*.md ... 12-*.md
├── agents/
│   ├── README.md
│   ├── manifest.yaml
│   ├── _base.md
│   ├── 01-*.md ... 13-*.md
│   └── schemas/
│       └── *.schema.json
├── tools/
│   ├── README.md
│   └── tools.yaml
└── workflows/
    ├── README.md
    └── fde-engagement.yaml
```

## 代码职责

| 位置 | 职责 |
|---|---|
| `ts/src/catalog/io.ts` | source / dist / 部署覆盖路径解析，YAML 与 Markdown frontmatter 读取 |
| `ts/src/kernel/skills.ts` | Skill Markdown 解析、渐进披露、兼容 API |
| `ts/src/kernel/agents.ts` | AgentSpec 类型、Agent Markdown/Schema 加载、兼容 API |
| `ts/src/catalog/tools.ts` | 工具治理目录、scope 查询、实际注册一致性校验 |
| `ts/src/workflows/loader.ts` | 严格解析固定工作流并构建冻结 DAG |
| `ts/src/onto/engagement.ts` | FDE 工作流兼容入口与不可取消的安全哨兵 |
| `ts/src/catalog/check.ts` | 跨目录引用、数量、实现路径和工作流装配检查 |

工具 handler 暂不从 `server/glue/tools.ts` 与 `server/dialogue/tools.ts` 搬走；catalog 管
权限、危险级、装配组和实现位置，handler 与其输入 Schema 仍就近维护，避免复制业务逻辑。

## 修改规范

### 新增 Skill

复制 `skills/README.md` 中的格式，创建数字前缀 Markdown；Agent 若使用它，在对应
Agent frontmatter 的 `skills` 中登记。Skill 引用的工具必须已存在于 `tools.yaml`。

### 新增 Agent

创建 Agent Markdown 和需要的 `schemas/*.schema.json`，再按期望顺序加入
`agents/manifest.yaml`。工具权限引用 `tool_scope`，不在 Agent 文件中逐项复制工具名。

### 新增 Tool

先在 `tools/tools.yaml` 登记 name、assembly、danger、access、availability 和实现路径，
再在所属 server 模块注册 handler。启动校验会比较代码实际 danger/scope 与 catalog；
不一致会直接失败，未知 core 工具默认拿不到任何 Agent scope。

### 修改工作流

只改 `workflows/*.yaml`。`checkpoint_version` 在顶层统一维护并自动注入每个节点。
FDE 的 INTAKE 前冻结、INTERVIEW 人工门、REVIEW 质量门和 EXPORT 交付门还有代码哨兵，
不能被一次普通 YAML 编辑取消。

## 验证与部署

```bash
cd ts
npm run check:catalog
npm test
npm run build
```

`npm run build` 会把 catalog 复制到 `ts/dist/catalog`。源码检出会自动找到
`ts/catalog`；独立部署可设置 `ONTOCHAT_CATALOG_DIR` 指向带 `catalog.yaml` 的目录。
Catalog 在进程启动时读取一次，修改后需要重启，不做请求级热加载。
