# Agent workflows

一条工作流一个 YAML，声明固定控制面；handler 的实现留在 `ts/src/`。

工作流会在进程启动时严格解析一次，修改后必须重启。用户材料、对话输入和模型输出都
不能指定配置路径，也不能新增节点或工具。`checkpoint_version` 在工作流顶层维护，加载器
会自动注入每个节点，避免漏改导致旧检查点被错误复用。

## FDE engagement v3

当前发现与方案设计链固定为：

```text
INTAKE -> PROCESS -> (ERP_MAP | RULES | DATA_OBJECTS) -> GAP -> INTERVIEW
       -> DECISION_PROPOSAL -> DECISION_APPLY -> REQUIREMENTS -> ARCHITECTURE
       -> TEST_PLAN -> CANONICALIZE -> REVIEW -> HUMAN_ACCEPTANCE -> EXPORT
```

- `DECISION_PROPOSAL` 只提出带目标和基准 revision 的变更建议。
- `DECISION_APPLY` 是确定性零写入校验节点；`VALIDATED_NOT_APPLIED` 不等于已生效。
- `REQUIREMENTS`、`ARCHITECTURE`、`TEST_PLAN` 分别形成可追溯需求、方案契约和验收设计。
- `HUMAN_ACCEPTANCE` 必须把精确候选包绑定到耐久 Decision Ledger；没有正式决定时暂停。
- `APPROVE` 才能进入 `RELEASED`；`REJECT` 是合法终态，但只能提交 `DRAFT`。
- fork 一个 Agent 节点时，该节点及所有传递后继必须失效；只允许重放未受影响的旧输出。

修改拓扑时必须同时更新 `checkpoint_version`、完整邻接断言、handler contract、golden 与
APPROVE/REJECT 两条真实暂停恢复测试。不得通过减少依赖、关闭 Gate 或让材料动态改图来
规避迁移成本。
