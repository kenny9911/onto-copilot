# ERP映射
> 将业务步骤和对象映射到有版本证据的 ERP 能力、实现类型和目标引用，并暴露 Fit-Gap

## 何时用
流程涉及 SAP、Oracle、用友、金蝶或其他 ERP，需要判断步骤落在哪个产品、版本、
模块、交易、接口、对象或字段时使用；产品版本和客户配置不明确时只能形成候选或问题

## 步骤
1. 先建立 system landscape：system ID、产品、部署形态、版本、模块、组织范围、
   系统别名和证据。输出只填写当前 schema 支持的字段；部署形态等关键缺项形成问题。
2. 证据优先级为：客户配置或导出、客户技术文档、对应版本的厂商官方文档、其他材料。
   通用知识只能形成待验证候选，不能获得已验证状态。
3. 对每个 `process_step_id` 建立映射：业务能力 → 系统/模块 → 交易或 API →
   ERP 业务对象 → 表/字段或其他 `target_refs`，并绑定 system ID 和 evidence IDs。
4. 将实现类型分类为 `STANDARD`、`CONFIGURATION`、`ENHANCEMENT`、`CUSTOM`、
   `EXTERNAL` 或 `UNKNOWN`。只有材料能证明时才填写具体交易码、表字段和客制逻辑。
5. 记录组织层级、主数据键、编码、单位/币种/时区转换、同步方向及映射置信度；
   `profile.column` 只能验证数据形态，不能证明 ERP 业务语义。当前 schema 无字段
   承载的关键转换写入 questions，不另造 mapping 字段。
6. 检查授权、集成方向、幂等、错误处理和对账需求；缺证据或当前 schema 无法承载
   的关键约束形成 question，不得在输出中丢失。
7. 用 `impact.trace` 找出低置信映射阻塞的流程、对象和规则，按缺失产品版本、配置
   证据或字段定义路由给 ERP 顾问。questions 只支持字符串时按
   `[应答角色][blocked:ID] 问题 | evidence:ID` 编码。

## 完成判据
- 每个系统都声明产品、版本、模块、组织范围或使用 schema 允许的空值
- 每条映射关联 process step、system、implementation kind、target refs 和证据
- 标准、配置、增强、客制、外部和未知没有混用
- 通用产品知识没有被伪装成客户配置事实
- 转换、同步方向和关键集成约束已记录为映射证据或问题
- 每个低置信映射都有原因、影响范围和 ERP 顾问问题
- 输出没有添加 schema 未定义字段

## 工具
evidence.search、evidence.rows、oir.query、profile.column、impact.trace

## 标签
ERP映射、SAP、Oracle、Fit-Gap、交易码、字段映射
