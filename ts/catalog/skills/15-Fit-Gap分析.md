# Fit-Gap分析
> 将已识别需求与有证据的当前能力逐条对照，区分完全覆盖、部分覆盖、缺口和未知

## 何时用
已有需求或业务目标，需评估当前流程、Ontology、ERP 映射或系统能力是否覆盖时使用；
没有完整需求单元或产品版本证据时，不根据产品宣传材料宣布 Fit

## 步骤
1. 先把每项需求收紧为一个可验收单元，记录范围、主体、触发、预期结果、约束、
   优先级和证据。复合需求未拆分前不做单一 Fit-Gap 结论。
2. 用 `evidence.search` 与 `evidence.rows` 验证当前能力的真实行为、产品/版本、组织范围
   和客户配置；产品网站的通用能力只能作候选线索。
3. 用 `oir.query` 将需求对照到现有流程步骤、Action、Rule、DataObject、ERP mapping
   和系统 ID。没有稳定 ID 的宣传术语不得作为 capability ID。
4. 将覆盖结果分为 `FIT`、`PARTIAL_FIT`、`GAP` 或 `UNKNOWN`：FIT 需要端到端满足；
   PARTIAL_FIT 必须列出已覆盖与未覆盖部分；证据不足只能是 UNKNOWN，不是 GAP。
5. 用 `impact.trace` 识别缺口对流程、数据、控制、集成、运维和验收的影响；当前
   影响跟踪为空不证明无影响，还要检查是否因引用未建立。
6. 需求工程阶段只产生覆盖评估；方案阶段可提出 REUSE、CONFIGURE、ENHANCE、
   CUSTOM_BUILD、INTEGRATE、PROCESS_CHANGE、DEFER 或 UNKNOWN 的候选 disposition，
   但不宣称已批准或已实现。
7. 对 UNKNOWN、部分覆盖和高影响 GAP 形成最小问题集，写明所需配置证据、应答角色、
   回答格式和被阻塞 requirement/artifact ID。

## 完成判据
- 每条 Fit-Gap 只对应一个可验收需求单元
- FIT、PARTIAL_FIT、GAP 和 UNKNOWN 的判定依据没有混用
- 通用产品宣传没有被当成客户版本或配置事实
- PARTIAL_FIT 明确列出已覆盖与未覆盖部分
- 每个 GAP/UNKNOWN 都包含影响范围、证据状态和下一责任角色
- 方案 disposition 明确标记为候选，没有被表述为已批准或已实现

## 工具
evidence.search、evidence.rows、oir.query、impact.trace

## 标签
Fit-Gap、需求覆盖、能力评估、方案缺口、适配
